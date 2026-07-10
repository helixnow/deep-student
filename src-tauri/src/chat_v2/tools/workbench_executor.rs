//! Workbench / OS 模式 Agent 工具执行器（ACR R1-02 / R2-01）
//!
//! 让 chat agent 通过桥层操控学习桌面窗口：列举、打开、发指令、关闭、查状态。
//! 工具短名（strip 后）：`workbench_list_windows` / `workbench_open_app` /
//! `workbench_app_command` / `workbench_close_window` / `workbench_query_state`。
//!
//! LLM 可见名带 `builtin-` 前缀；schema 由前端 skill `workbench-tools`（R1-08）注入。
//! 数据修改仍走领域工具；本组只负责看见 / 导航 / 窗口指令。
//!
//! R2-01：闸门 off 时 list/query 只读允许、写/导航拒绝（`WORKBENCH_DISABLED`）；
//! 桥业务错误码透传；取消 → `CANCELLED` 不重试。
//!
//! 设计文档：`docs/dev/acr/DESIGN.md` §2/§3/§6；错误码：`docs/dev/acr/ERRORS.md`；
//! 规范：`docs/dev/acr/STANDARDS.md` §3。

use std::time::Instant;

use async_trait::async_trait;
use serde_json::{json, Map, Value};
use tauri::Manager;

use super::executor::{ExecutionContext, ToolConcurrency, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use super::workbench_bridge::{self, is_bridge_cancelled};
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::commands::AppState;
use crate::feature_flags::FeatureFlagManager;

// ============================================================================
// 常量
// ============================================================================

pub mod tool_names {
    pub const LIST_WINDOWS: &str = "workbench_list_windows";
    pub const OPEN_APP: &str = "workbench_open_app";
    pub const APP_COMMAND: &str = "workbench_app_command";
    pub const CLOSE_WINDOW: &str = "workbench_close_window";
    pub const QUERY_STATE: &str = "workbench_query_state";
}

const FLAG_WORKBENCH_AGENT: &str = "tools.workbench_agent";
const SETTING_WORKBENCH_AGENT_CONTROL: &str = "desktop.workbenchAgentControl";

/// list_windows / query_state 桥超时
const TIMEOUT_QUERY_MS: u64 = 5_000;
/// open_app / app_command / close_window 桥超时
const TIMEOUT_MUTATE_MS: u64 = 15_000;

const HINT_UNAVAILABLE: &str =
    "桌面模式未开启或未就绪，导航类操作不可用；数据修改请改用对应领域工具";
const HINT_DISABLED: &str =
    "将设置「AI 助手操控」改为后台或跟随即可；数据修改也可改用领域工具";
const HINT_FLAG_OFF: &str = "请开启 feature flag tools.workbench_agent；数据修改请改用领域工具";
const HINT_CANCELLED: &str = "用户已取消；请根据 partial 回执的 done/undone 继续，勿原样重试";

// ============================================================================
// 双闸（R2-01 / R2-08 定稿，见 docs/dev/acr/ERRORS.md）
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GateMode {
    /// feature flag 关：硬闸，全部工具拒绝（含 list/query）
    FlagOff,
    /// 设置 off 或缺省：只读 list/query 允许，写/导航拒绝
    Off,
    /// background / follow：全开
    Enabled,
}

/// 解析双闸。flag 关 → FlagOff；设置 off → Off；否则 Enabled。
async fn resolve_workbench_gates(ctx: &ExecutionContext) -> Result<GateMode, String> {
    let state = ctx.window.try_state::<AppState>().ok_or_else(|| {
        structured_error(
            "WORKBENCH_UNAVAILABLE",
            "AppState 不可用",
            HINT_UNAVAILABLE,
            false,
        )
    })?;

    let app_version = env!("CARGO_PKG_VERSION").to_string();
    let manager = FeatureFlagManager::new(app_version)
        .load_from_database(&state.database)
        .await
        .map_err(|e| structured_error("WORKBENCH_UNAVAILABLE", &e, HINT_UNAVAILABLE, false))?;
    if !manager.is_feature_enabled(FLAG_WORKBENCH_AGENT) {
        return Ok(GateMode::FlagOff);
    }

    let agent_setting = state
        .database
        .get_setting(SETTING_WORKBENCH_AGENT_CONTROL)
        .map_err(|e| {
            structured_error(
                "WORKBENCH_UNAVAILABLE",
                &format!("读取设置失败: {e}"),
                HINT_UNAVAILABLE,
                false,
            )
        })?
        // 未写入设置时默认 follow（开箱可用）
        .unwrap_or_else(|| "follow".to_string());

    if is_workbench_agent_enabled(&agent_setting) {
        Ok(GateMode::Enabled)
    } else {
        Ok(GateMode::Off)
    }
}

/// 领域写工具在尝试 ACR 前端委托前也必须经过同一双闸。
///
/// `false` 表示仍可执行领域工具，但只能走后端数据面；不得发送 `probe/apply_ops`。
pub(crate) async fn is_workbench_agent_delegation_enabled(
    ctx: &ExecutionContext,
) -> Result<bool, String> {
    Ok(matches!(
        resolve_workbench_gates(ctx).await?,
        GateMode::Enabled
    ))
}

/// `off` / 未知 → 关；空（未设置）/ `background` / `follow` → 开（空=产品默认 follow）。
fn is_workbench_agent_enabled(raw: &str) -> bool {
    let s = raw.trim().to_ascii_lowercase();
    if s.is_empty() {
        return true;
    }
    matches!(s.as_str(), "background" | "follow")
}

/// 只读工具：闸门 Off 时仍允许（R2-08 定稿）
fn is_readonly_workbench_tool(stripped: &str) -> bool {
    matches!(stripped, tool_names::LIST_WINDOWS | tool_names::QUERY_STATE)
}

fn structured_error(code: &str, message: &str, hint: &str, retryable: bool) -> String {
    json!({
        "code": code,
        "message": message,
        "hint": hint,
        "retryable": retryable,
    })
    .to_string()
}

fn workbench_unavailable(message: &str) -> String {
    structured_error("WORKBENCH_UNAVAILABLE", message, HINT_UNAVAILABLE, false)
}

fn workbench_disabled(message: &str) -> String {
    structured_error("WORKBENCH_DISABLED", message, HINT_DISABLED, false)
}

fn workbench_flag_disabled(message: &str) -> String {
    structured_error("WORKBENCH_DISABLED", message, HINT_FLAG_OFF, false)
}

fn workbench_cancelled(message: &str) -> String {
    structured_error("CANCELLED", message, HINT_CANCELLED, false)
}

/// 将桥层 `ok:false` 的 error 字符串映射为结构化码。
/// 已知码原样透传；未知 → WORKBENCH_UNAVAILABLE。
fn map_bridge_error(raw: &str) -> String {
    let code = extract_error_code(raw).unwrap_or("WORKBENCH_UNAVAILABLE");
    let hint = match code {
        "WORKBENCH_DISABLED" => HINT_DISABLED,
        "CANCELLED" => HINT_CANCELLED,
        "WINDOW_BUSY" => "目标窗口正被其他 Agent run 占用；请等待或换窗",
        "STRICT_MODE" => "番茄钟严格模式拒绝该操作",
        "TODO_CONFLICT" | "QBANK_CONFLICT" => "版本冲突；请重新读取后再写",
        _ => HINT_UNAVAILABLE,
    };
    let retryable = matches!(code, "WINDOW_BUSY");
    structured_error(code, raw, hint, retryable)
}

fn extract_error_code(raw: &str) -> Option<&'static str> {
    const KNOWN: &[&str] = &[
        "WORKBENCH_DISABLED",
        "WORKBENCH_UNAVAILABLE",
        "WINDOW_BUSY",
        "WINDOW_NOT_FOUND",
        "DRIVER_NOT_FOUND",
        "STRICT_MODE",
        "ANCHOR_NOT_FOUND",
        "TODO_CONFLICT",
        "QBANK_CONFLICT",
        "CANCELLED",
    ];
    for code in KNOWN {
        if raw.contains(code) {
            return Some(*code);
        }
    }
    None
}

// ============================================================================
// 参数整形（LLM snake_case → 桥 camelCase，对齐 DESIGN §2.3）
// ============================================================================

/// 将工具入参整形为桥命令载荷。
///
/// LLM / skill 侧优先 snake_case（STANDARDS §3：`window_id` 等）；
/// 桥协议冻结为 camelCase（`windowId` / `typeId` / `instanceKey`）。
/// 已是 camelCase 的字段原样保留；两者并存时 camelCase 优先。
fn normalize_bridge_args(args: &Value) -> Value {
    let Some(obj) = args.as_object() else {
        return args.clone();
    };

    let mut out = Map::new();
    for (k, v) in obj {
        out.insert(k.clone(), v.clone());
    }

    promote_alias(&mut out, "type_id", "typeId");
    promote_alias(&mut out, "instance_key", "instanceKey");
    promote_alias(&mut out, "window_id", "windowId");
    promote_alias(&mut out, "resource_id", "resourceId");

    Value::Object(out)
}

/// 若目标 camelCase 键缺失且存在 snake_case 别名，则提升并移除别名。
fn promote_alias(obj: &mut Map<String, Value>, snake: &str, camel: &str) {
    if obj.contains_key(camel) {
        obj.remove(snake);
        return;
    }
    if let Some(v) = obj.remove(snake) {
        obj.insert(camel.to_string(), v);
    }
}

fn bridge_command_and_timeout(stripped: &str) -> Option<(&'static str, u64)> {
    match stripped {
        tool_names::LIST_WINDOWS => Some(("list_windows", TIMEOUT_QUERY_MS)),
        tool_names::OPEN_APP => Some(("open_app", TIMEOUT_MUTATE_MS)),
        tool_names::APP_COMMAND => Some(("app_command", TIMEOUT_MUTATE_MS)),
        tool_names::CLOSE_WINDOW => Some(("close_window", TIMEOUT_MUTATE_MS)),
        tool_names::QUERY_STATE => Some(("query_state", TIMEOUT_QUERY_MS)),
        _ => None,
    }
}

fn is_workbench_tool(stripped: &str) -> bool {
    bridge_command_and_timeout(stripped).is_some()
}

// ============================================================================
// WorkbenchToolExecutor
// ============================================================================

pub struct WorkbenchToolExecutor;

impl WorkbenchToolExecutor {
    pub fn new() -> Self {
        Self
    }

    async fn dispatch(
        &self,
        stripped: &str,
        args: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let gate = resolve_workbench_gates(ctx).await?;

        // R2-08：flag 硬闸全拒；setting off 时只读允许、写/导航 → WORKBENCH_DISABLED
        match gate {
            GateMode::FlagOff => {
                return Err(workbench_flag_disabled(
                    "Agent 桌面硬闸未开启（tools.workbench_agent）",
                ));
            }
            GateMode::Off if !is_readonly_workbench_tool(stripped) => {
                return Err(workbench_disabled(&format!(
                    "Agent 桌面操控未开启（desktop.workbenchAgentControl=off），拒绝 {stripped}"
                )));
            }
            GateMode::Off | GateMode::Enabled => {}
        }

        let (command, timeout_ms) = bridge_command_and_timeout(stripped)
            .ok_or_else(|| workbench_unavailable(&format!("未知的 workbench 工具: {stripped}")))?;

        let bridge_args = normalize_bridge_args(args);

        log::debug!(
            "[WorkbenchToolExecutor] bridge command={command} timeout_ms={timeout_ms} run_id={}",
            ctx.run_id()
        );

        match workbench_bridge::acr_bridge_call(ctx, command, bridge_args, timeout_ms).await {
            Err(e) if is_bridge_cancelled(&e) => Err(workbench_cancelled(&e)),
            Err(e) => Err(workbench_unavailable(&e)),
            Ok(resp) => {
                if !resp.ok {
                    let msg = resp.error.unwrap_or_else(|| "桥层返回失败".to_string());
                    Err(map_bridge_error(&msg))
                } else {
                    // 业务失败也在 data.status 中（DESIGN §2.1），原样交给 LLM
                    Ok(resp.data.unwrap_or_else(|| json!({})))
                }
            }
        }
    }
}

impl Default for WorkbenchToolExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for WorkbenchToolExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        is_workbench_tool(strip_tool_namespace(tool_name))
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start = Instant::now();
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let tool_name = strip_tool_namespace(&call.name);
        log::debug!(
            "[WorkbenchToolExecutor] Executing {} (full={}, run_id={})",
            tool_name,
            call.name,
            ctx.run_id()
        );

        let result = self.dispatch(tool_name, &call.arguments, ctx).await;
        let duration_ms = start.elapsed().as_millis() as u64;

        match result {
            Ok(output) => {
                ctx.emit_tool_call_end(Some(json!({
                    "result": output,
                    "durationMs": duration_ms,
                })));

                let tool_result = ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration_ms,
                );

                if let Err(e) = ctx.save_tool_block(&tool_result) {
                    log::warn!("[WorkbenchToolExecutor] Failed to save tool block: {e}");
                }

                Ok(tool_result)
            }
            Err(error) => {
                ctx.emit_tool_call_error(&error);

                let tool_result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error,
                    duration_ms,
                );

                if let Err(e) = ctx.save_tool_block(&tool_result) {
                    log::warn!("[WorkbenchToolExecutor] Failed to save tool block: {e}");
                }

                Ok(tool_result)
            }
        }
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        match strip_tool_namespace(tool_name) {
            tool_names::CLOSE_WINDOW => ToolSensitivity::High,
            tool_names::APP_COMMAND => ToolSensitivity::Medium,
            _ => ToolSensitivity::Low,
        }
    }

    fn concurrency_class(&self, _tool_name: &str) -> ToolConcurrency {
        // 共享桌面舞台；禁止并行以免租约/焦点冲突
        ToolConcurrency::Serial
    }

    fn name(&self) -> &'static str {
        "WorkbenchToolExecutor"
    }
}

// ============================================================================
// 单测（写好即可，禁止运行）
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn can_handle_workbench_tools() {
        let ex = WorkbenchToolExecutor::new();
        assert!(ex.can_handle("builtin-workbench_list_windows"));
        assert!(ex.can_handle("workbench_list_windows"));
        assert!(ex.can_handle("builtin-workbench_open_app"));
        assert!(ex.can_handle("workbench_open_app"));
        assert!(ex.can_handle("builtin-workbench_app_command"));
        assert!(ex.can_handle("workbench_app_command"));
        assert!(ex.can_handle("builtin-workbench_close_window"));
        assert!(ex.can_handle("workbench_close_window"));
        assert!(ex.can_handle("builtin-workbench_query_state"));
        assert!(ex.can_handle("workbench_query_state"));
        assert!(!ex.can_handle("builtin-web_fetch"));
        assert!(!ex.can_handle("user_todo_list_lists"));
        assert!(!ex.can_handle("browser_open"));
    }

    #[test]
    fn sensitivity_matrix() {
        let ex = WorkbenchToolExecutor::new();
        assert_eq!(
            ex.sensitivity_level("builtin-workbench_close_window"),
            ToolSensitivity::High
        );
        assert_eq!(
            ex.sensitivity_level("workbench_app_command"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            ex.sensitivity_level("builtin-workbench_list_windows"),
            ToolSensitivity::Low
        );
        assert_eq!(
            ex.sensitivity_level("workbench_open_app"),
            ToolSensitivity::Low
        );
        assert_eq!(
            ex.sensitivity_level("workbench_query_state"),
            ToolSensitivity::Low
        );
    }

    #[test]
    fn normalize_promotes_snake_case() {
        let raw = json!({
            "type_id": "note",
            "instance_key": "res-1",
            "window_id": "win-9",
            "action": "focusNode",
        });
        let normalized = normalize_bridge_args(&raw);
        assert_eq!(normalized["typeId"], "note");
        assert_eq!(normalized["instanceKey"], "res-1");
        assert_eq!(normalized["windowId"], "win-9");
        assert_eq!(normalized["action"], "focusNode");
        assert!(normalized.get("type_id").is_none());
        assert!(normalized.get("instance_key").is_none());
        assert!(normalized.get("window_id").is_none());
    }

    #[test]
    fn normalize_keeps_camel_case_priority() {
        let raw = json!({
            "typeId": "todo",
            "type_id": "note",
            "focus": true,
        });
        let normalized = normalize_bridge_args(&raw);
        assert_eq!(normalized["typeId"], "todo");
        assert!(normalized.get("type_id").is_none());
        assert_eq!(normalized["focus"], true);
    }

    #[test]
    fn gate_setting_parser() {
        assert!(is_workbench_agent_enabled("")); // 未设置 = 默认开
        assert!(!is_workbench_agent_enabled("off"));
        assert!(!is_workbench_agent_enabled("OFF"));
        assert!(!is_workbench_agent_enabled("true"));
        assert!(is_workbench_agent_enabled("background"));
        assert!(is_workbench_agent_enabled("Follow"));
    }

    #[test]
    fn readonly_tools_under_off_gate() {
        assert!(is_readonly_workbench_tool(tool_names::LIST_WINDOWS));
        assert!(is_readonly_workbench_tool(tool_names::QUERY_STATE));
        assert!(!is_readonly_workbench_tool(tool_names::OPEN_APP));
        assert!(!is_readonly_workbench_tool(tool_names::APP_COMMAND));
        assert!(!is_readonly_workbench_tool(tool_names::CLOSE_WINDOW));
    }

    #[test]
    fn map_bridge_error_preserves_known_codes() {
        let s = map_bridge_error("WORKBENCH_DISABLED: 桌面模式未开启");
        assert!(s.contains("WORKBENCH_DISABLED"));
        assert!(s.contains("\"retryable\":false"));
        let busy = map_bridge_error("WINDOW_BUSY");
        assert!(busy.contains("WINDOW_BUSY"));
        assert!(busy.contains("\"retryable\":true"));
    }
}
