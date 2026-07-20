//! Agent 技能生命周期管理工具执行器
//!
//! - `skill_set_enabled`（Medium）：启用/停用技能。启用状态存前端 localStorage
//!   （skillEnableStorage），Rust 无法直接写入，因此经 skill-lifecycle 前端桥
//!   （listen → emit，复刻 mcp-bridge 模式）委托前端 `setSkillDisabled` 落地并回执。
//! - `skill_remove`（High，必审批，never-remember）：删除 `~/.deep-student/skills/`
//!   下的技能包目录（复用 `skills::skill_delete` 的路径校验+删除逻辑），并清理
//!   provenance（settings 表 `skill.provenance.<id>`）与后端信任记录
//!   （`chat_v2.skill_trust.<id>`）。builtin 技能不可删除。
//! - `skill_trust_request`（inspect Low / grant High，必审批，never-remember）：
//!   inspect 对已安装技能包做一次现扫（整包 SHA-256 + 风险/prompt injection 信号），
//!   grant 在用户审批后按现有正门逻辑授予**绑定指纹**的信任（经前端桥调用
//!   `setSkillTrustOverride` → `chat_v2_set_skill_trust`，后端重算整包哈希并绑定
//!   canonical path / 文件系统身份）。绝不绕过指纹绑定。
//!
//! 这三个工具与 `skill_install` / `skill_workshop_*` 同为技能治理正门；
//! shell 侧门由 `skills::command_mentions_skills_directory` deny 规则继续封死。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use async_trait::async_trait;
use serde_json::{json, Value};
use tauri::{Emitter, Listener};
use tokio::sync::oneshot;
use tokio::time::{timeout, Duration};

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::skill_workshop_executor::SkillWorkshopExecutor;
use super::strip_tool_namespace;
use crate::chat_v2::runtime_roots::SKILL_TRUST_KEY_PREFIX;
use crate::chat_v2::skills::{
    assess_skill_package_risk, expand_path, is_portable_skill_path_component, validate_skill_path,
    DEFAULT_AGENT_SKILLS_BASE,
};
use crate::chat_v2::types::{ToolCall, ToolResultInfo};

pub mod tool_names {
    pub const SKILL_SET_ENABLED: &str = "skill_set_enabled";
    pub const SKILL_REMOVE: &str = "skill_remove";
    pub const SKILL_TRUST_REQUEST: &str = "skill_trust_request";
}

/// 桥请求事件名（与前端 skillLifecycleBridge.ts 冻结常量对齐）
const BRIDGE_REQUEST_EVENT: &str = "skill-lifecycle-bridge-request";
/// 桥响应事件前缀 → `skill-lifecycle-bridge-response:{correlationId}`
const BRIDGE_RESPONSE_PREFIX: &str = "skill-lifecycle-bridge-response:";
/// 桥调用超时：均为轻量前端状态操作（registry 查询 / localStorage 写 / 单次 invoke）
const BRIDGE_TIMEOUT_MS: u64 = 10_000;

/// 与 skill_install / skill_workshop 相同的 provenance settings 键前缀。
const PROVENANCE_SETTINGS_PREFIX: &str = "skill.provenance.";

/// 前端 registry 对某技能的描述回执（桥 `describe` 命令）。
#[derive(Debug, Clone, Default)]
struct SkillDescription {
    found: bool,
    is_builtin: bool,
    disabled: bool,
    trust_status: Option<String>,
    package_root: Option<String>,
    name: Option<String>,
}

impl SkillDescription {
    fn from_value(value: &Value) -> Self {
        Self {
            found: value.get("found").and_then(Value::as_bool).unwrap_or(false),
            is_builtin: value
                .get("isBuiltin")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            disabled: value
                .get("disabled")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            trust_status: value
                .get("trustStatus")
                .and_then(Value::as_str)
                .map(str::to_string),
            package_root: value
                .get("packageRoot")
                .and_then(Value::as_str)
                .map(str::to_string),
            name: value
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string),
        }
    }
}

pub struct SkillLifecycleExecutor;

impl Default for SkillLifecycleExecutor {
    fn default() -> Self {
        Self::new()
    }
}

impl SkillLifecycleExecutor {
    pub fn new() -> Self {
        Self
    }

    fn strip_namespace(tool_name: &str) -> &str {
        strip_tool_namespace(tool_name)
    }

    /// 与 skill_workshop 相同的技能 ID 约束（字母数字、连字符、下划线 + 可移植目录名）。
    fn validate_skill_id(skill_id: &str) -> Result<String, String> {
        let trimmed = skill_id.trim();
        if trimmed.is_empty() {
            return Err("skill_id must not be empty".to_string());
        }
        if !trimmed
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
            || !is_portable_skill_path_component(trimmed)
        {
            return Err(
                "skill_id must be a portable directory name containing only letters, numbers, hyphens, and underscores"
                    .to_string(),
            );
        }
        Ok(trimmed.to_string())
    }

    fn required_skill_id(args: &Value) -> Result<String, String> {
        let skill_id = args
            .get("skill_id")
            .or_else(|| args.get("skillId"))
            .and_then(|v| v.as_str())
            .ok_or("skill_id is required")?;
        Self::validate_skill_id(skill_id)
    }

    fn normalize_sha256(raw: &str, field: &str) -> Result<String, String> {
        let normalized = raw.trim().to_ascii_lowercase();
        if normalized.len() != 64 || !normalized.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(format!(
                "{} must be a 64-character SHA-256 hex digest",
                field
            ));
        }
        Ok(normalized)
    }

    fn risk_rank(level: &str) -> u8 {
        match level.to_ascii_lowercase().as_str() {
            "high" => 3,
            "medium" => 2,
            _ => 1,
        }
    }

    // ------------------------------------------------------------------
    // skill-lifecycle 前端桥（复刻 mcp-bridge：先 listen 后 emit + RAII unlisten）
    // ------------------------------------------------------------------

    /// 调用前端 skillLifecycleBridge：`command` ∈ describe / set_enabled /
    /// trust_grant / trust_revoke。成功返回响应中的 `data`。
    async fn bridge_call(
        ctx: &ExecutionContext,
        command: &str,
        args: Value,
    ) -> Result<Value, String> {
        let window = ctx.window_ref().clone();
        let corr = uuid::Uuid::new_v4().to_string();
        let response_event = format!("{}{}", BRIDGE_RESPONSE_PREFIX, corr);

        let (tx, rx) = oneshot::channel::<Value>();
        let tx_arc = Arc::new(Mutex::new(Some(tx)));
        let tx_for_listener = tx_arc.clone();
        let expected_corr = corr.clone();
        let listener_id = window.listen(response_event, move |event| {
            if let Ok(val) = serde_json::from_str::<Value>(event.payload()) {
                // correlationId 必须回显匹配，防串扰
                if val.get("correlationId").and_then(Value::as_str) != Some(expected_corr.as_str())
                {
                    return;
                }
                if let Ok(mut guard) = tx_for_listener.lock() {
                    if let Some(sender) = guard.take() {
                        let _ = sender.send(val);
                    }
                }
            }
        });

        // RAII：外层超时/取消 drop 本 future 时也确保注销监听器
        struct ListenerGuard {
            window: tauri::Window,
            id: tauri::EventId,
        }
        impl Drop for ListenerGuard {
            fn drop(&mut self) {
                self.window.unlisten(self.id);
            }
        }
        let _listener_guard = ListenerGuard {
            window: window.clone(),
            id: listener_id,
        };

        let payload = json!({
            "correlationId": corr,
            "command": command,
            "args": args,
            "sessionId": ctx.session_id,
        });
        window
            .emit(BRIDGE_REQUEST_EVENT, payload)
            .map_err(|e| format!("Skill lifecycle bridge emit failed: {}", e))?;

        let response = match timeout(Duration::from_millis(BRIDGE_TIMEOUT_MS), rx).await {
            Err(_) => {
                return Err(format!(
                    "Skill lifecycle bridge timed out after {}ms (command={}). The frontend bridge may not be ready.",
                    BRIDGE_TIMEOUT_MS, command
                ))
            }
            Ok(Err(_)) => return Err("Skill lifecycle bridge channel closed".to_string()),
            Ok(Ok(val)) => val,
        };

        let ok = response
            .get("ok")
            .and_then(Value::as_bool)
            .ok_or("Skill lifecycle bridge protocol error: missing ok field")?;
        if !ok {
            let error = response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown frontend bridge error");
            return Err(format!("Skill lifecycle bridge rejected: {}", error));
        }
        response
            .get("data")
            .cloned()
            .ok_or("Skill lifecycle bridge protocol error: ok=true requires data".to_string())
    }

    async fn describe_skill(
        ctx: &ExecutionContext,
        skill_id: &str,
    ) -> Result<SkillDescription, String> {
        let data = Self::bridge_call(ctx, "describe", json!({ "skillId": skill_id })).await?;
        Ok(SkillDescription::from_value(&data))
    }

    // ------------------------------------------------------------------
    // skill_set_enabled
    // ------------------------------------------------------------------

    async fn execute_set_enabled(
        &self,
        args: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let skill_id = Self::required_skill_id(args)?;
        let enabled = args
            .get("enabled")
            .and_then(Value::as_bool)
            .ok_or("enabled is required (true = 启用, false = 停用)")?;

        let description = Self::describe_skill(ctx, &skill_id).await?;
        if !description.found {
            return Err(format!(
                "Skill '{}' is not registered. Use self_inspect (section=skills) to list available skills.",
                skill_id
            ));
        }

        // builtin 技能允许停用（保留定义，仅退出 schema 收集/自动激活）
        let data = Self::bridge_call(
            ctx,
            "set_enabled",
            json!({ "skillId": skill_id, "enabled": enabled }),
        )
        .await?;

        let previous_disabled = data
            .get("previousDisabled")
            .and_then(Value::as_bool)
            .unwrap_or(description.disabled);

        Ok(json!({
            "skill_id": skill_id,
            "enabled": enabled,
            "previous_enabled": !previous_disabled,
            "is_builtin": description.is_builtin,
            "message": if enabled {
                "Skill enabled. It will participate in schema collection and activation from the next turn."
            } else {
                "Skill disabled. Already-loaded session copies are unaffected this turn; from the next turn it is excluded from schema collection, auto-activation, and manual selection. Files and definition are kept (use skill_remove to delete)."
            },
        }))
    }

    // ------------------------------------------------------------------
    // skill_remove
    // ------------------------------------------------------------------

    /// 目标技能包目录：仅允许 `~/.deep-student/skills/<skill_id>`。
    /// builtin（无磁盘目录）与外部兼容目录（.claude/skills 等）不可经本工具删除。
    fn agent_skill_dir(skill_id: &str) -> Result<PathBuf, String> {
        let dir = expand_path(DEFAULT_AGENT_SKILLS_BASE).join(skill_id);
        validate_skill_path(&dir).map_err(|e| e.to_string())?;
        Ok(dir)
    }

    async fn execute_remove(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let skill_id = Self::required_skill_id(args)?;

        // 先问前端 registry：builtin 必须给出明确错误而不是「目录不存在」
        // （桥不可用时降级为纯磁盘判定，删除本身不依赖前端）
        let description = Self::describe_skill(ctx, &skill_id).await.ok();
        if let Some(desc) = &description {
            if desc.found && desc.is_builtin {
                return Err(format!(
                    "Skill '{}' is builtin and cannot be removed. Use skill_set_enabled to disable it, or restore defaults in Skills management.",
                    skill_id
                ));
            }
        }

        let dir = Self::agent_skill_dir(&skill_id)?;
        if !dir.exists() {
            return Err(format!(
                "Skill package '{}' was not found under {}. Only packages in that directory can be removed by the agent; builtin skills can only be disabled, and skills in external directories must be managed in Skills management.",
                skill_id, DEFAULT_AGENT_SKILLS_BASE
            ));
        }

        // 复用 skills.rs 的 skill_delete 内部逻辑
        // （路径白名单校验 + SKILL.md 存在性检查 + 递归删除）
        crate::chat_v2::skills::skill_delete_impl(dir.to_string_lossy().to_string())
            .await
            .map_err(String::from)?;

        // 清理 provenance 与后端信任记录（settings 表）；删除失败只降级为警告，
        // 残留的信任记录会因 canonical path 失效而 fail-closed，不构成安全缺口。
        let mut cleanup_warnings: Vec<String> = Vec::new();
        if let Some(db) = ctx.main_db.as_ref() {
            let provenance_key = format!("{}{}", PROVENANCE_SETTINGS_PREFIX, skill_id);
            if let Err(e) = db.delete_setting(&provenance_key) {
                cleanup_warnings.push(format!("failed to delete provenance record: {}", e));
            }
            let trust_key = format!("{}{}", SKILL_TRUST_KEY_PREFIX, skill_id);
            if let Err(e) = db.delete_setting(&trust_key) {
                cleanup_warnings.push(format!("failed to delete trust record: {}", e));
            }
        } else {
            cleanup_warnings
                .push("main_db unavailable; provenance/trust records were not cleaned".to_string());
        }

        // 前端 localStorage 侧的 trust/enable 覆盖清理与 registry 刷新由
        // toolCall.ts 在收到本工具成功结果后处理（事件驱动，见前端接线）。
        let mut output = json!({
            "removed": true,
            "skill_id": skill_id,
            "path": format!("{}/{}", DEFAULT_AGENT_SKILLS_BASE, skill_id),
            "provenance_cleared": cleanup_warnings.is_empty(),
            "trust_record_cleared": cleanup_warnings.is_empty(),
            "message": "Skill package removed. The skills registry will refresh automatically; this cannot be undone.",
        });
        if !cleanup_warnings.is_empty() {
            output["cleanup_warnings"] = json!(cleanup_warnings);
        }
        Ok(output)
    }

    // ------------------------------------------------------------------
    // skill_trust_request
    // ------------------------------------------------------------------

    /// 解析并校验待信任技能包根目录（必须落在允许的技能目录白名单内）。
    fn trusted_package_root(description: &SkillDescription, skill_id: &str) -> Result<PathBuf, String> {
        let package_root = description
            .package_root
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                format!(
                    "Skill '{}' has no local package root to trust (builtin or virtual skills do not need trust).",
                    skill_id
                )
            })?;
        if package_root.starts_with("builtin://") {
            return Err(format!(
                "Skill '{}' is builtin and is always trusted; no trust request is needed.",
                skill_id
            ));
        }
        let expanded = expand_path(package_root);
        validate_skill_path(&expanded).map_err(|e| e.to_string())?;
        Ok(expanded)
    }

    /// 对已安装技能包做一次现扫：整包 SHA-256 + 启发式风险信号
    /// （复用 skill_install / skill_workshop 的同一套 `assess_skill_package_risk`，
    /// 其中包含 prompt injection 模式扫描）。
    fn scan_installed_package(root: &Path) -> Result<(String, String, Vec<String>), String> {
        let files = SkillWorkshopExecutor::read_package_directory(root)?;
        let package_sha256 = SkillWorkshopExecutor::package_sha256(&files);
        let (risk_level, risk_signals) = assess_skill_package_risk(&files);
        Ok((package_sha256, risk_level, risk_signals))
    }

    async fn execute_trust_inspect(
        &self,
        args: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let skill_id = Self::required_skill_id(args)?;
        let description = Self::describe_skill(ctx, &skill_id).await?;
        if !description.found {
            return Err(format!("Skill '{}' is not registered.", skill_id));
        }
        if description.is_builtin {
            return Err(format!(
                "Skill '{}' is builtin and is always trusted; no trust request is needed.",
                skill_id
            ));
        }
        let root = Self::trusted_package_root(&description, &skill_id)?;
        let (package_sha256, risk_level, risk_signals) = Self::scan_installed_package(&root)?;

        Ok(json!({
            "action": "inspect",
            "skill_id": skill_id,
            "skill_name": description.name,
            "trust_status": description.trust_status,
            "package_root": root.to_string_lossy(),
            "package_sha256": package_sha256,
            "risk_level": risk_level,
            "risk_signals": risk_signals,
            "next_step": "Explain the reason and risk summary to the user, then call skill_trust_request with action=grant, the same skill_id, reason, expected_package_sha256 set to package_sha256, and declared_risk_level set to risk_level from this result. Grant requires user approval and cannot be remembered.",
        }))
    }

    async fn execute_trust_grant(
        &self,
        args: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let skill_id = Self::required_skill_id(args)?;
        let reason = args
            .get("reason")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or("reason is required for grant (shown to the user on the approval card)")?;
        let expected_package_sha256 = args
            .get("expected_package_sha256")
            .or_else(|| args.get("expectedPackageSha256"))
            .and_then(Value::as_str)
            .ok_or("expected_package_sha256 is required (use package_sha256 from action=inspect)")?;
        let expected_package_sha256 =
            Self::normalize_sha256(expected_package_sha256, "expected_package_sha256")?;
        let declared_risk = args
            .get("declared_risk_level")
            .or_else(|| args.get("declaredRiskLevel"))
            .and_then(Value::as_str)
            .unwrap_or("low")
            .to_ascii_lowercase();
        if !matches!(declared_risk.as_str(), "low" | "medium" | "high") {
            return Err("declared_risk_level must be low, medium, or high".to_string());
        }

        let description = Self::describe_skill(ctx, &skill_id).await?;
        if !description.found {
            return Err(format!("Skill '{}' is not registered.", skill_id));
        }
        if description.is_builtin {
            return Err(format!(
                "Skill '{}' is builtin and is always trusted; no trust request is needed.",
                skill_id
            ));
        }
        let root = Self::trusted_package_root(&description, &skill_id)?;

        // 审批后现扫复核（TOCTOU fail-closed）：包内容与用户看到的指纹必须一致
        let (current_sha256, risk_level, risk_signals) = Self::scan_installed_package(&root)?;
        if current_sha256 != expected_package_sha256 {
            return Err(format!(
                "Skill package changed since inspection: expected {}, got {}. Run skill_trust_request with action=inspect again and show the user the new fingerprint.",
                expected_package_sha256, current_sha256
            ));
        }
        if Self::risk_rank(&risk_level) > Self::risk_rank(&declared_risk) {
            return Err(format!(
                "Detected risk_level '{}' is higher than declared_risk_level '{}'. Run action=inspect again and update declared_risk_level before granting.",
                risk_level, declared_risk
            ));
        }

        // 正门授予：前端 setSkillTrustOverride → chat_v2_set_skill_trust。
        // 后端重算整包 SHA-256 并绑定 canonical path + 文件系统身份，
        // 前端同步记录 UI 侧内容指纹（FNV-1a）——两层指纹绑定均不可绕过。
        let grant = Self::bridge_call(ctx, "trust_grant", json!({ "skillId": skill_id })).await?;
        let granted_sha256 = grant
            .get("packageSha256")
            .and_then(Value::as_str)
            .map(str::to_string);

        // 授予瞬间包被替换（极窄竞态窗口）：立即撤销并失败，不留下错绑信任
        if let Some(granted) = granted_sha256.as_deref() {
            if granted != expected_package_sha256 {
                let revoke =
                    Self::bridge_call(ctx, "trust_revoke", json!({ "skillId": skill_id })).await;
                return Err(format!(
                    "Trust binding mismatch: backend bound package {}, but the approved fingerprint is {}. The grant was revoked ({}). Inspect again before retrying.",
                    granted,
                    expected_package_sha256,
                    match revoke {
                        Ok(_) => "revoked".to_string(),
                        Err(e) => format!("revoke also failed: {}", e),
                    }
                ));
            }
        }

        Ok(json!({
            "action": "grant",
            "granted": true,
            "skill_id": skill_id,
            "reason": reason,
            "package_root": root.to_string_lossy(),
            "package_sha256": expected_package_sha256,
            "risk_level": risk_level,
            "risk_signals": risk_signals,
            "message": "Trust granted, bound to the current package fingerprint. Any change to the package (SKILL.md, scripts, references, assets) invalidates the trust automatically and requires a new grant.",
        }))
    }

    async fn execute_trust_request(
        &self,
        args: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let action = args
            .get("action")
            .and_then(Value::as_str)
            .ok_or("action is required (inspect | grant)")?;
        match action {
            "inspect" => self.execute_trust_inspect(args, ctx).await,
            "grant" => self.execute_trust_grant(args, ctx).await,
            other => Err(format!(
                "Unsupported action '{}'. Allowed: inspect, grant",
                other
            )),
        }
    }
}

#[async_trait]
impl ToolExecutor for SkillLifecycleExecutor {
    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start_time = Instant::now();
        let short = Self::strip_namespace(&call.name);

        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let result = match short {
            tool_names::SKILL_SET_ENABLED => self.execute_set_enabled(&call.arguments, ctx).await,
            tool_names::SKILL_REMOVE => self.execute_remove(&call.arguments, ctx).await,
            tool_names::SKILL_TRUST_REQUEST => self.execute_trust_request(&call.arguments, ctx).await,
            other => Err(format!("Unsupported skill lifecycle tool: {}", other)),
        };

        let duration = start_time.elapsed().as_millis() as u64;

        match result {
            Ok(output) => {
                ctx.emit_tool_call_end(Some(json!({
                    "result": output,
                    "durationMs": duration,
                })));

                let result = ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration,
                );

                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[SkillLifecycleExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
            Err(error_msg) => {
                ctx.emit_tool_call_error(&error_msg);

                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    duration,
                );

                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[SkillLifecycleExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
        }
    }

    fn can_handle(&self, tool_name: &str) -> bool {
        matches!(
            Self::strip_namespace(tool_name),
            tool_names::SKILL_SET_ENABLED
                | tool_names::SKILL_REMOVE
                | tool_names::SKILL_TRUST_REQUEST
        )
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        match Self::strip_namespace(tool_name) {
            // 删除与信任授予是权限升级/破坏性操作：High + never-remember
            // （见 approval_scope::PRIVILEGE_ESCALATION_TOOLS）
            tool_names::SKILL_REMOVE | tool_names::SKILL_TRUST_REQUEST => ToolSensitivity::High,
            tool_names::SKILL_SET_ENABLED => ToolSensitivity::Medium,
            _ => ToolSensitivity::Low,
        }
    }

    /// `skill_trust_request` 的 `inspect` 是只读现扫（不改任何状态），按 Low 放行；
    /// 缺失/未知 action 一律维持 High（fail-closed）。
    fn sensitivity_level_for_call(&self, tool_name: &str, arguments: &Value) -> ToolSensitivity {
        if Self::strip_namespace(tool_name) == tool_names::SKILL_TRUST_REQUEST
            && arguments.get("action").and_then(Value::as_str) == Some("inspect")
        {
            return ToolSensitivity::Low;
        }
        self.sensitivity_level(tool_name)
    }

    fn name(&self) -> &'static str {
        "SkillLifecycleExecutor"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_skill_id_rejects_invalid_chars() {
        assert!(SkillLifecycleExecutor::validate_skill_id("good-skill_1").is_ok());
        assert!(SkillLifecycleExecutor::validate_skill_id("../evil").is_err());
        assert!(SkillLifecycleExecutor::validate_skill_id("a/b").is_err());
        assert!(SkillLifecycleExecutor::validate_skill_id("").is_err());
        assert!(SkillLifecycleExecutor::validate_skill_id("  ").is_err());
    }

    #[test]
    fn sensitivity_mapping_matches_governance_contract() {
        let executor = SkillLifecycleExecutor::new();
        assert_eq!(
            executor.sensitivity_level("builtin-skill_set_enabled"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.sensitivity_level("builtin-skill_remove"),
            ToolSensitivity::High
        );
        assert_eq!(
            executor.sensitivity_level("builtin-skill_trust_request"),
            ToolSensitivity::High
        );
    }

    #[test]
    fn trust_request_inspect_is_low_but_grant_and_unknown_stay_high() {
        let executor = SkillLifecycleExecutor::new();
        assert_eq!(
            executor.sensitivity_level_for_call(
                "builtin-skill_trust_request",
                &json!({ "action": "inspect", "skill_id": "x" }),
            ),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level_for_call(
                "builtin-skill_trust_request",
                &json!({ "action": "grant", "skill_id": "x" }),
            ),
            ToolSensitivity::High
        );
        // action 缺失/未知：fail-closed 维持 High
        assert_eq!(
            executor.sensitivity_level_for_call("builtin-skill_trust_request", &json!({})),
            ToolSensitivity::High
        );
    }

    #[test]
    fn normalize_sha256_rejects_invalid() {
        assert!(SkillLifecycleExecutor::normalize_sha256("abc", "expected").is_err());
        assert!(SkillLifecycleExecutor::normalize_sha256(
            "0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef",
            "expected",
        )
        .is_ok());
    }

    #[test]
    fn can_handle_covers_all_three_tools_with_prefixes() {
        let executor = SkillLifecycleExecutor::new();
        for name in [
            "skill_set_enabled",
            "builtin-skill_set_enabled",
            "skill_remove",
            "builtin-skill_remove",
            "skill_trust_request",
            "builtin-skill_trust_request",
        ] {
            assert!(executor.can_handle(name), "{name}");
        }
        assert!(!executor.can_handle("skill_install"));
        assert!(!executor.can_handle("skill_workshop_apply"));
    }
}
