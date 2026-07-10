//! runtime_root_request 工具执行器
//!
//! High 敏感度：agent 请求用户授权只读 authorized runtime root。
//! critical 目录在 agent 发起路径下直接拒绝（比 Settings 手动更严）；broad 目录允许但带警示。

use std::time::Instant;

use async_trait::async_trait;
use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::Manager;

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::runtime_roots::{
    assess_authorized_root_risk, assess_authorized_root_risk_canonical,
    authorize_runtime_root_path, canonicalize_authorized_dir, strip_windows_verbatim_prefix,
    AuthorizedRootRisk, RUNTIME_ROOT_PROVENANCE_PREFIX,
};
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::commands::AppState;

pub mod tool_names {
    pub const RUNTIME_ROOT_REQUEST: &str = "runtime_root_request";
}

const HINT: &str = "已授权只读；可用 workspace_file_list/read 或 local_shell_execute(root_id=...) 访问；可在 Settings > 工具权限 撤销";

const CRITICAL_REJECTION: &str =
    "该目录范围过大，agent 不代理授权，请用户到 Settings > 工具权限 手动添加";

const BROAD_WARNING: &str = "该目录属于 Desktop/Downloads/Documents 等较宽个人目录，授权后 agent 可只读访问其下全部文件；请确认用途后再批准";

#[derive(Debug, Serialize)]
struct RuntimeRootProvenance {
    purpose: String,
    session_id: String,
    granted_at: String,
    risk: String,
}

pub struct RuntimeRootRequestExecutor;

impl RuntimeRootRequestExecutor {
    pub fn new() -> Self {
        Self
    }

    fn strip_namespace(tool_name: &str) -> &str {
        strip_tool_namespace(tool_name)
    }

    fn parse_args(args: &Value) -> Result<(&str, &str), String> {
        let path = args
            .get("path")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or("path is required (absolute directory path; shown on the approval card)")?;
        let purpose = args
            .get("purpose")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or("purpose is required (one sentence explaining why this directory is needed)")?;
        Ok((path, purpose))
    }

    fn build_success_payload(
        root_id: &str,
        path: &str,
        risk: AuthorizedRootRisk,
        purpose: &str,
        newly_granted: bool,
    ) -> Value {
        let mut payload = json!({
            "root_id": root_id,
            "path": path,
            "risk": risk.as_str(),
            "purpose": purpose,
            "newly_granted": newly_granted,
            "hint": HINT,
        });
        if risk == AuthorizedRootRisk::Broad {
            payload["risk_warning"] = json!(BROAD_WARNING);
        }
        payload
    }

    fn write_provenance(
        database: &crate::database::Database,
        root_id: &str,
        purpose: &str,
        session_id: &str,
        risk: AuthorizedRootRisk,
    ) -> Result<(), String> {
        let provenance = RuntimeRootProvenance {
            purpose: purpose.to_string(),
            session_id: session_id.to_string(),
            granted_at: Utc::now().to_rfc3339(),
            risk: risk.as_str().to_string(),
        };
        let json_text = serde_json::to_string(&provenance)
            .map_err(|e| format!("Failed to serialize runtime root provenance: {}", e))?;
        let key = format!("{}{}", RUNTIME_ROOT_PROVENANCE_PREFIX, root_id);
        database
            .save_setting(&key, &json_text)
            .map_err(|e| format!("Failed to persist runtime root provenance: {}", e))
    }

    fn execute_request(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let (raw_path, purpose) = Self::parse_args(args)?;

        // 🔒 P1（05 号报告 P1-1）：先对原始字符串做一次评估（快速拒绝显式 critical 写法），
        // 再 canonicalize 并对**真实目标路径**复评。`..`、`\\?\` 前缀、8.3 短名等写法
        // 只有在 canonical 路径上评估才不可绕过。
        if assess_authorized_root_risk(raw_path) == AuthorizedRootRisk::Critical {
            return Err(CRITICAL_REJECTION.to_string());
        }
        let canonical = canonicalize_authorized_dir(raw_path).map_err(|error| {
            format!(
                "Failed to authorize directory '{}': {}. Ask the user to confirm the path exists and is a directory.",
                raw_path, error
            )
        })?;
        let canonical_display = strip_windows_verbatim_prefix(&canonical);
        let risk = assess_authorized_root_risk_canonical(&canonical);
        if risk == AuthorizedRootRisk::Critical {
            return Err(CRITICAL_REJECTION.to_string());
        }

        let state = ctx.window.state::<AppState>();
        let outcome = authorize_runtime_root_path(&state.database, &canonical_display, None)
            .map_err(|error| {
                format!(
                    "Failed to authorize directory '{}': {}. Ask the user to confirm the path exists and is a directory.",
                    canonical_display, error
                )
            })?;

        if outcome.newly_granted {
            Self::write_provenance(
                &state.database,
                &outcome.root_id,
                purpose,
                &ctx.session_id,
                risk,
            )?;
        }

        // 成功 payload 展示 canonical 路径（剥 `\\?\` 前缀），而非模型提供的原始写法
        Ok(Self::build_success_payload(
            &outcome.root_id,
            &strip_windows_verbatim_prefix(&outcome.path),
            risk,
            purpose,
            outcome.newly_granted,
        ))
    }
}

impl Default for RuntimeRootRequestExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for RuntimeRootRequestExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        Self::strip_namespace(tool_name) == tool_names::RUNTIME_ROOT_REQUEST
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start = Instant::now();
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let result = self.execute_request(&call.arguments, ctx);
        let duration_ms = start.elapsed().as_millis() as u64;

        match result {
            Ok(output) => {
                ctx.emit_tool_call_end(Some(json!({
                    "result": output,
                    "durationMs": duration_ms,
                })));
                let result = ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration_ms,
                );
                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!(
                        "[RuntimeRootRequestExecutor] Failed to save tool block: {}",
                        e
                    );
                }
                Ok(result)
            }
            Err(error) => {
                ctx.emit_tool_call_error(&error);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error,
                    duration_ms,
                );
                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!(
                        "[RuntimeRootRequestExecutor] Failed to save tool block: {}",
                        e
                    );
                }
                Ok(result)
            }
        }
    }

    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        ToolSensitivity::High
    }

    fn name(&self) -> &'static str {
        "RuntimeRootRequestExecutor"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_expected_tool_names() {
        let executor = RuntimeRootRequestExecutor::new();
        assert!(executor.can_handle("runtime_root_request"));
        assert!(executor.can_handle("builtin-runtime_root_request"));
        assert!(!executor.can_handle("runtime_root_request_extra"));
    }

    #[test]
    fn sensitivity_is_high() {
        let executor = RuntimeRootRequestExecutor::new();
        assert_eq!(
            executor.sensitivity_level("builtin-runtime_root_request"),
            ToolSensitivity::High
        );
    }

    #[test]
    fn critical_paths_are_rejected_by_agent_policy() {
        let risk = assess_authorized_root_risk(r"C:\Users\foo");
        assert_eq!(risk, AuthorizedRootRisk::Critical);
        assert!(CRITICAL_REJECTION.contains("agent 不代理授权"));
    }

    #[test]
    fn parse_args_requires_path_and_purpose() {
        assert!(RuntimeRootRequestExecutor::parse_args(&json!({})).is_err());
        assert!(RuntimeRootRequestExecutor::parse_args(&json!({"path": "C:\\tmp"})).is_err());
        assert!(
            RuntimeRootRequestExecutor::parse_args(&json!({"purpose": "test"})).is_err()
        );
    }

    #[test]
    fn broad_payload_includes_warning() {
        let payload = RuntimeRootRequestExecutor::build_success_payload(
            "authorized_abc",
            r"C:\Users\foo\Downloads",
            AuthorizedRootRisk::Broad,
            "list exam files",
            true,
        );
        assert_eq!(payload.get("risk").and_then(Value::as_str), Some("broad"));
        assert!(payload.get("risk_warning").is_some());
    }
}
