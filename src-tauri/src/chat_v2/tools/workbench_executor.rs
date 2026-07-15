//! Workbench / OS 模式 Agent 工具执行器（ACR R1-02 / R2-01）
//!
//! 让 chat agent 通过桥层发现、观察、操控并验证学习桌面子应用。
//! ACR 2.0 主工具：`workbench_get_capabilities` / `workbench_observe` /
//! `workbench_act` / `workbench_wait_for` / `workbench_undo`；旧五工具继续兼容。
//!
//! LLM 可见名带 `builtin-` 前缀；schema 由前端 skill `workbench-tools`（R1-08）注入。
//! 笔记/导图/待办等领域内容修改仍走领域工具；本组负责窗口与 manifest 语义操作。
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
use super::workbench_bridge::{self, is_bridge_cancelled, is_bridge_result_unknown};
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::commands::AppState;
use crate::feature_flags::FeatureFlagManager;

// ============================================================================
// 常量
// ============================================================================

pub mod tool_names {
    pub const GET_CAPABILITIES: &str = "workbench_get_capabilities";
    pub const OBSERVE: &str = "workbench_observe";
    pub const ACT: &str = "workbench_act";
    pub const ACT_HIGH: &str = "workbench_act_high";
    pub const WAIT_FOR: &str = "workbench_wait_for";
    pub const UNDO: &str = "workbench_undo";
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
/// wait_for 自身最多等待 30s，桥层额外留 5s 收尾。
const TIMEOUT_WAIT_MS: u64 = 35_000;

const HINT_UNAVAILABLE: &str =
    "桌面模式未开启或未就绪，导航类操作不可用；数据修改请改用对应领域工具";
const HINT_DISABLED: &str = "将设置「AI 助手操控」改为后台或跟随即可；数据修改也可改用领域工具";
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
    matches!(
        stripped,
        tool_names::GET_CAPABILITIES
            | tool_names::OBSERVE
            | tool_names::WAIT_FOR
            | tool_names::LIST_WINDOWS
            | tool_names::QUERY_STATE
    )
}

/// setting=off 时 `act` 仍需到达前端，才能依据实时 manifest 对整批 capability
/// 做动态只读判定。StageManager 只允许全部 mutates=false 的批次，任何写动作 fail-closed。
fn can_dispatch_under_off_gate(stripped: &str) -> bool {
    is_readonly_workbench_tool(stripped)
        || matches!(stripped, tool_names::ACT | tool_names::ACT_HIGH)
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

fn workbench_result_unknown(message: &str) -> String {
    json!({
        "code": "RESULT_UNKNOWN",
        "message": message,
        "hint": "桥请求已提交但未收到权威终态；先重新 observe/读取目标，禁止原样重试",
        "retryable": false,
        "resultUnknown": true,
    })
    .to_string()
}

/// 将桥层 `ok:false` 的 error 字符串映射为结构化码。
/// 已知码原样透传；未知 → WORKBENCH_UNAVAILABLE。
fn map_bridge_error(raw: &str) -> String {
    let parsed = serde_json::from_str::<Value>(raw).ok();
    let code = parsed
        .as_ref()
        .and_then(|value| value.get("code"))
        .and_then(Value::as_str)
        .and_then(extract_error_code)
        .or_else(|| extract_error_code(raw))
        .unwrap_or("WORKBENCH_UNAVAILABLE");
    let default_hint = match code {
        "WORKBENCH_DISABLED" => HINT_DISABLED,
        "CANCELLED" => HINT_CANCELLED,
        "RESULT_UNKNOWN" => "桥请求已提交但终态未知；请先重新 observe/读取目标，禁止原样重试",
        "BRIDGE_AUTH_FAILED" | "BRIDGE_PROTOCOL_ERROR" => {
            "桥回执身份或结构不可采信；写请求先重新读取目标，禁止原样重试"
        }
        "WINDOW_BUSY" => "目标窗口正被其他 Agent run 占用；请等待或换窗",
        "STALE_TARGET_WINDOW" | "WINDOW_TARGET_MISMATCH" => {
            "目标窗口已关闭、切换资源或身份不匹配；请重新 probe/observe 并使用精确 windowId"
        }
        "STALE_OBSERVATION" => {
            "目标状态已变化；请重新 observe 并根据最新 revision 规划，勿原样重试"
        }
        "APP_AGENT_UNAVAILABLE" | "APP_NOT_REGISTERED" => {
            "目标应用未注册 Agent 能力；请重新 get_capabilities 或改用领域工具"
        }
        "OBSERVE_FAILED" => "无法观察目标应用；请确认窗口就绪后重新 observe",
        "CAPABILITY_NOT_FOUND" | "ACTION_UNAVAILABLE" => {
            "能力不存在或当前不可用；请重新 get_capabilities 与 observe"
        }
        "INVALID_AGENT_REF" | "TARGET_REF_MISMATCH" => {
            "实体引用无效、已过期或与参数不一致；请重新 observe 并使用最新 ref"
        }
        "INVALID_ACTION_ARGS" => "动作参数不符合 capability inputSchema；请重新 get_capabilities",
        "CONDITION_NOT_MET" | "POSTCONDITION_FAILED" => {
            "动作已执行但后置条件未满足；请查看最新 observation 再决定下一步"
        }
        "INVALID_CONDITION" => "条件格式无效；请使用工具 schema 支持的结构化 condition",
        "FOCUS_REQUIRED" => "该能力要求目标窗口获得焦点；请使用跟随模式或先聚焦窗口",
        "ACTION_FAILED" => "应用拒绝或未能完成动作；请查看回执与最新 observation",
        "RISK_APPROVAL_REQUIRED" => {
            "manifest 能力风险超过本工具的可信审批上限；高风险动作必须改用 workbench_act_high"
        }
        "UNDO_NOT_FOUND" => "撤销 token 不存在、已消费或已过期；不要重复调用",
        "UNDO_IN_PROGRESS" => "同一 token 正在撤销；等待原撤销终态，不要并发重放 inverse",
        "UNDO_CONFLICT" => "撤销前状态已变化；重新 observe，由用户决定冲突处理",
        "UNDO_PARTIAL" => "inverse 仅部分完成；根据回执剩余进度重新观察，勿从头重放",
        "STRICT_MODE" => "番茄钟严格模式拒绝该操作",
        "NOTE_OCC_REQUIRED" => {
            "先读取笔记 updated_at，再携带 expected_updated_at 提交；不得无条件覆写"
        }
        "NOTE_CONFLICT" | "TODO_CONFLICT" | "QBANK_CONFLICT" => {
            "版本冲突；请重新读取后基于最新版本规划"
        }
        "NOTE_WRITE_FAILED" => "笔记持久化未确认；请重新读取目标后再决定下一步",
        "DUPLICATE_RUN_ID" | "DUPLICATE_CORRELATION_ID" | "RUN_ID_REUSE" => {
            "事务身份已被使用；等待原事务终态，不要覆盖或复用身份"
        }
        _ => HINT_UNAVAILABLE,
    };
    let message = parsed
        .as_ref()
        .and_then(|value| value.get("message"))
        .and_then(Value::as_str)
        .filter(|message| !message.trim().is_empty())
        .unwrap_or(raw);
    let hint = parsed
        .as_ref()
        .and_then(|value| value.get("hint"))
        .and_then(Value::as_str)
        .filter(|hint| !hint.trim().is_empty())
        .unwrap_or(default_hint);
    let retryable = parsed
        .as_ref()
        .and_then(|value| value.get("retryable"))
        .and_then(Value::as_bool)
        .unwrap_or(matches!(code, "WINDOW_BUSY" | "UNDO_IN_PROGRESS"));
    if code == "RESULT_UNKNOWN" {
        return workbench_result_unknown(message);
    }
    structured_error(code, message, hint, retryable)
}

fn extract_error_code(raw: &str) -> Option<&'static str> {
    const KNOWN: &[&str] = &[
        "WORKBENCH_DISABLED",
        "WORKBENCH_UNAVAILABLE",
        "BRIDGE_AUTH_FAILED",
        "BRIDGE_PROTOCOL_ERROR",
        "WINDOW_BUSY",
        "WINDOW_NOT_FOUND",
        "STALE_TARGET_WINDOW",
        "WINDOW_TARGET_MISMATCH",
        "DRIVER_NOT_FOUND",
        "APP_AGENT_UNAVAILABLE",
        "APP_NOT_REGISTERED",
        "OBSERVE_FAILED",
        "STALE_OBSERVATION",
        "CAPABILITY_NOT_FOUND",
        "ACTION_UNAVAILABLE",
        "INVALID_AGENT_REF",
        "TARGET_REF_MISMATCH",
        "INVALID_ACTION_ARGS",
        "CONDITION_NOT_MET",
        "POSTCONDITION_FAILED",
        "INVALID_CONDITION",
        "FOCUS_REQUIRED",
        "ACTION_FAILED",
        "RISK_APPROVAL_REQUIRED",
        "UNDO_NOT_FOUND",
        "UNDO_IN_PROGRESS",
        "UNDO_CONFLICT",
        "UNDO_PARTIAL",
        "INVALID_ARGS",
        "STRICT_MODE",
        "ANCHOR_NOT_FOUND",
        "TODO_CONFLICT",
        "QBANK_CONFLICT",
        "NOTE_OCC_REQUIRED",
        "NOTE_CONFLICT",
        "NOTE_WRITE_FAILED",
        "DUPLICATE_RUN_ID",
        "DUPLICATE_CORRELATION_ID",
        "RUN_ID_REUSE",
        "CANCELLED",
        "RESULT_UNKNOWN",
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
    promote_alias(&mut out, "observation_revision", "observationRevision");
    promote_alias(&mut out, "stop_on_failure", "stopOnFailure");
    promote_alias(&mut out, "timeout_ms", "timeoutMs");
    promote_alias(&mut out, "interval_ms", "intervalMs");
    promote_alias(&mut out, "undo_token", "undoToken");

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

/// 审批风险上限由 Rust 根据已审批的工具名覆盖注入，绝不信任模型参数。
fn inject_approval_risk_ceiling(args: Value, ceiling: &'static str) -> Value {
    let mut object = args.as_object().cloned().unwrap_or_default();
    object.insert(
        "approvalRiskCeiling".to_string(),
        Value::String(ceiling.to_string()),
    );
    Value::Object(object)
}

/// 只有已通过对应工具级审批的路径才能获得风险上限；模型参数始终被覆盖。
fn trusted_approval_risk_ceiling(stripped: &str) -> Option<&'static str> {
    match stripped {
        tool_names::ACT => Some("medium"),
        tool_names::ACT_HIGH | tool_names::UNDO => Some("high"),
        _ => None,
    }
}

/// 旧 app_command 没有按 manifest risk 分工具审批。已知 high 动作必须 fail-closed，
/// 迫使调用方重新 observe 后使用 workbench_act_high，避免 Medium 兼容接口旁路。
fn is_legacy_high_risk_command(args: &Value) -> bool {
    let Some(object) = args.as_object() else {
        return false;
    };
    matches!(
        (
            object.get("typeId").and_then(Value::as_str),
            object.get("action").and_then(Value::as_str),
        ),
        (Some("pomodoro"), Some("stop")) | (Some("sandbox"), Some("setMode"))
    )
}

fn bridge_command_and_timeout(stripped: &str) -> Option<(&'static str, u64)> {
    match stripped {
        tool_names::GET_CAPABILITIES => Some(("get_capabilities", TIMEOUT_QUERY_MS)),
        tool_names::OBSERVE => Some(("observe", TIMEOUT_QUERY_MS)),
        tool_names::ACT => Some(("act", TIMEOUT_MUTATE_MS)),
        tool_names::ACT_HIGH => Some(("act", TIMEOUT_MUTATE_MS)),
        tool_names::WAIT_FOR => Some(("wait_for", TIMEOUT_WAIT_MS)),
        tool_names::UNDO => Some(("revert_run", TIMEOUT_MUTATE_MS)),
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
            GateMode::Off if !can_dispatch_under_off_gate(stripped) => {
                return Err(workbench_disabled(&format!(
                    "Agent 桌面操控未开启（desktop.workbenchAgentControl=off），拒绝 {stripped}"
                )));
            }
            GateMode::Off | GateMode::Enabled => {}
        }

        let (command, timeout_ms) = bridge_command_and_timeout(stripped)
            .ok_or_else(|| workbench_unavailable(&format!("未知的 workbench 工具: {stripped}")))?;

        let normalized_args = normalize_bridge_args(args);
        if stripped == tool_names::APP_COMMAND && is_legacy_high_risk_command(&normalized_args) {
            return Err(structured_error(
                "RISK_APPROVAL_REQUIRED",
                "manifest high 风险动作不能通过兼容 app_command 执行",
                "请先 workbench_observe，再用 workbench_act_high 对本次动作精确审批",
                false,
            ));
        }
        let bridge_args = match trusted_approval_risk_ceiling(stripped) {
            Some(ceiling) => inject_approval_risk_ceiling(normalized_args, ceiling),
            None => normalized_args,
        };

        log::debug!(
            "[WorkbenchToolExecutor] bridge command={command} timeout_ms={timeout_ms} run_id={}",
            ctx.run_id()
        );

        match workbench_bridge::acr_bridge_call(ctx, command, bridge_args, timeout_ms).await {
            Err(e) if is_bridge_cancelled(&e) => Err(workbench_cancelled(&e)),
            Err(e) if is_bridge_result_unknown(&e) => Err(workbench_result_unknown(&e)),
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
            tool_names::ACT_HIGH => ToolSensitivity::High,
            // undo 的 inverse 风险无法从工具名得知；在审批框架支持参数级分级前
            // 必须整体 High，防止 Medium 路径重放 sandbox.setMode 等 High inverse。
            tool_names::UNDO => ToolSensitivity::High,
            // 审批接口只接收工具名：普通 act 的可信上限为 Medium；manifest high
            // 必须使用独立 High 工具，Rust 再覆盖注入 approvalRiskCeiling。
            // open_app payload 可以触发浏览器导航，不能继续作为 Low 导航旁路。
            tool_names::ACT | tool_names::APP_COMMAND | tool_names::OPEN_APP => {
                ToolSensitivity::Medium
            }
            _ => ToolSensitivity::Low,
        }
    }

    fn manages_cancellation(&self, _tool_name: &str) -> bool {
        true
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
        assert!(ex.can_handle("builtin-workbench_get_capabilities"));
        assert!(ex.can_handle("workbench_get_capabilities"));
        assert!(ex.can_handle("builtin-workbench_observe"));
        assert!(ex.can_handle("workbench_observe"));
        assert!(ex.can_handle("builtin-workbench_act"));
        assert!(ex.can_handle("workbench_act"));
        assert!(ex.can_handle("builtin-workbench_act_high"));
        assert!(ex.can_handle("workbench_act_high"));
        assert!(ex.can_handle("builtin-workbench_wait_for"));
        assert!(ex.can_handle("workbench_wait_for"));
        assert!(ex.can_handle("builtin-workbench_undo"));
        assert!(ex.can_handle("workbench_undo"));
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
            ToolSensitivity::Medium
        );
        assert_eq!(
            ex.sensitivity_level("workbench_query_state"),
            ToolSensitivity::Low
        );
        assert_eq!(
            ex.sensitivity_level("workbench_get_capabilities"),
            ToolSensitivity::Low
        );
        assert_eq!(
            ex.sensitivity_level("workbench_observe"),
            ToolSensitivity::Low
        );
        assert_eq!(
            ex.sensitivity_level("workbench_act"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            ex.sensitivity_level("workbench_act_high"),
            ToolSensitivity::High
        );
        assert_eq!(
            ex.sensitivity_level("workbench_wait_for"),
            ToolSensitivity::Low
        );
        assert_eq!(
            ex.sensitivity_level("workbench_undo"),
            ToolSensitivity::High
        );
        assert!(ex.manages_cancellation("workbench_act"));
    }

    #[test]
    fn normalize_promotes_snake_case() {
        let raw = json!({
            "type_id": "note",
            "instance_key": "res-1",
            "window_id": "win-9",
            "observation_revision": "rev-4",
            "stop_on_failure": true,
            "timeout_ms": 1200,
            "interval_ms": 80,
            "undo_token": "acr-undo:token-1",
            "action": "focusNode",
        });
        let normalized = normalize_bridge_args(&raw);
        assert_eq!(normalized["typeId"], "note");
        assert_eq!(normalized["instanceKey"], "res-1");
        assert_eq!(normalized["windowId"], "win-9");
        assert_eq!(normalized["observationRevision"], "rev-4");
        assert_eq!(normalized["stopOnFailure"], true);
        assert_eq!(normalized["timeoutMs"], 1200);
        assert_eq!(normalized["intervalMs"], 80);
        assert_eq!(normalized["undoToken"], "acr-undo:token-1");
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
    fn risk_ceiling_is_overwritten_by_trusted_tool_path() {
        let model_args = json!({
            "observationRevision": "rev-1",
            "actions": [{"name": "stop"}],
            "approvalRiskCeiling": "high",
        });
        let regular = inject_approval_risk_ceiling(normalize_bridge_args(&model_args), "medium");
        assert_eq!(regular["approvalRiskCeiling"], "medium");

        let model_args = json!({
            "observationRevision": "rev-1",
            "actions": [{"name": "stop"}],
            "approvalRiskCeiling": "read",
        });
        let elevated = inject_approval_risk_ceiling(normalize_bridge_args(&model_args), "high");
        assert_eq!(elevated["approvalRiskCeiling"], "high");

        assert_eq!(
            trusted_approval_risk_ceiling(tool_names::ACT),
            Some("medium")
        );
        assert_eq!(
            trusted_approval_risk_ceiling(tool_names::ACT_HIGH),
            Some("high")
        );
        assert_eq!(
            trusted_approval_risk_ceiling(tool_names::UNDO),
            Some("high")
        );
        assert_eq!(trusted_approval_risk_ceiling(tool_names::OPEN_APP), None);
    }

    #[test]
    fn legacy_high_risk_action_cannot_bypass_act_high() {
        assert!(is_legacy_high_risk_command(&json!({
            "typeId": "pomodoro",
            "action": "stop",
        })));
        assert!(!is_legacy_high_risk_command(&json!({
            "typeId": "pomodoro",
            "action": "pause",
        })));
        assert!(is_legacy_high_risk_command(&json!({
            "typeId": "sandbox",
            "action": "setMode",
        })));
        assert!(!is_legacy_high_risk_command(&json!({
            "typeId": "exam",
            "action": "nextQuestion",
        })));
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
        assert!(is_readonly_workbench_tool(tool_names::GET_CAPABILITIES));
        assert!(is_readonly_workbench_tool(tool_names::OBSERVE));
        assert!(is_readonly_workbench_tool(tool_names::WAIT_FOR));
        assert!(is_readonly_workbench_tool(tool_names::LIST_WINDOWS));
        assert!(is_readonly_workbench_tool(tool_names::QUERY_STATE));
        assert!(!is_readonly_workbench_tool(tool_names::ACT));
        assert!(!is_readonly_workbench_tool(tool_names::ACT_HIGH));
        assert!(!is_readonly_workbench_tool(tool_names::UNDO));
        assert!(!is_readonly_workbench_tool(tool_names::OPEN_APP));
        assert!(!is_readonly_workbench_tool(tool_names::APP_COMMAND));
        assert!(!is_readonly_workbench_tool(tool_names::CLOSE_WINDOW));

        // act 的写性由前端实时 manifest 对整批动作判定；Rust 仅允许它穿过 off 前置闸门。
        assert!(can_dispatch_under_off_gate(tool_names::ACT));
        assert!(can_dispatch_under_off_gate(tool_names::ACT_HIGH));
        assert!(can_dispatch_under_off_gate(tool_names::OBSERVE));
        assert!(!can_dispatch_under_off_gate(tool_names::UNDO));
        assert!(!can_dispatch_under_off_gate(tool_names::APP_COMMAND));
    }

    #[test]
    fn map_bridge_error_preserves_known_codes() {
        let s = map_bridge_error("WORKBENCH_DISABLED: 桌面模式未开启");
        assert!(s.contains("WORKBENCH_DISABLED"));
        assert!(s.contains("\"retryable\":false"));
        let busy = map_bridge_error("WINDOW_BUSY");
        assert!(busy.contains("WINDOW_BUSY"));
        assert!(busy.contains("\"retryable\":true"));
        let stale = map_bridge_error("STALE_OBSERVATION: expected rev-1");
        assert!(stale.contains("STALE_OBSERVATION"));
        assert!(stale.contains("重新 observe"));
        let risk = map_bridge_error("RISK_APPROVAL_REQUIRED: sandbox.setMode");
        assert!(risk.contains("RISK_APPROVAL_REQUIRED"));
        assert!(risk.contains("workbench_act_high"));
        let unknown = workbench_result_unknown("RESULT_UNKNOWN: cancel drain expired");
        assert!(unknown.contains("RESULT_UNKNOWN"));
        assert!(unknown.contains("\"retryable\":false"));
        assert!(unknown.contains("\"resultUnknown\":true"));

        let exact_window = map_bridge_error(
            &json!({
                "code": "STALE_TARGET_WINDOW",
                "message": "window changed",
                "hint": "probe again",
                "retryable": false,
            })
            .to_string(),
        );
        let exact_window: Value = serde_json::from_str(&exact_window).expect("structured error");
        assert_eq!(exact_window["code"], "STALE_TARGET_WINDOW");
        assert_eq!(exact_window["message"], "window changed");
        assert_eq!(exact_window["hint"], "probe again");
        assert_eq!(exact_window["retryable"], false);

        let undo_progress = map_bridge_error(
            &json!({
                "code": "UNDO_IN_PROGRESS",
                "message": "already reverting",
                "retryable": true,
            })
            .to_string(),
        );
        let undo_progress: Value =
            serde_json::from_str(&undo_progress).expect("structured undo error");
        assert_eq!(undo_progress["code"], "UNDO_IN_PROGRESS");
        assert_eq!(undo_progress["retryable"], true);
    }
}
