//! 工具审批 Tauri 命令处理器
//!
//! 提供工具审批相关的 Tauri 命令，供前端调用。
//!
//! ## 设计文档
//! 参考：`src/chat-v2/docs/29-ChatV2-Agent能力增强改造方案.md` 第 4.7 节

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tauri::{State, Window};

use crate::chat_v2::approval_manager::{ApprovalManager, ApprovalResponse};
use crate::chat_v2::events::{event_types, ChatV2EventEmitter};
// 🔧 P1-51: 引入数据库用于持久化审批选择
use crate::database::Database;

// ============================================================================
// Tauri 命令
// ============================================================================

fn approval_scope_setting_key(tool_name: &str, arguments: &Value) -> String {
    let serialized = serde_json::to_string(arguments).unwrap_or_else(|_| "null".to_string());
    let mut hasher = Sha256::new();
    hasher.update(serialized.as_bytes());
    let fingerprint = hex::encode(hasher.finalize());
    format!("tool_approval.scope.{}.{}", tool_name, fingerprint)
}

/// 响应工具审批请求
///
/// ## 参数
/// - `session_id`: 会话 ID（用于日志）
/// - `tool_call_id`: 工具调用 ID
/// - `tool_name`: 工具名称（用于"记住选择"功能）
/// - `approved`: 是否批准
/// - `reason`: 拒绝原因（可选）
/// - `remember`: 是否记住选择
///
/// ## 返回
/// - `Ok(())`: 响应发送成功
/// - `Err(String)`: 发送失败（如找不到对应的审批请求）
#[tauri::command]
pub async fn chat_v2_tool_approval_respond(
    approval_manager: State<'_, Arc<ApprovalManager>>,
    db: State<'_, Arc<Database>>,
    window: Window,
    session_id: String,
    tool_call_id: String,
    tool_name: String,
    approved: bool,
    reason: Option<String>,
    remember: bool,
    arguments: Option<Value>,
) -> Result<(), String> {
    log::info!(
        "[ChatV2::approval] Received approval response: session={}, tool_call_id={}, tool_name={}, approved={}, remember={}",
        session_id,
        tool_call_id,
        tool_name,
        approved,
        remember
    );

    let response = ApprovalResponse {
        session_id: session_id.clone(),
        tool_call_id: tool_call_id.clone(),
        tool_name: tool_name.clone(),
        approved,
        reason,
        remember,
    };

    // 发送响应到等待的 Pipeline
    // ★ respond 返回 bool，不是 Result
    let success = approval_manager.respond(response);
    if !success {
        log::warn!(
            "[ChatV2::approval] No waiting approval found for tool_call_id={}",
            tool_call_id
        );
        let approval_block_id = format!("approval_{}", tool_call_id);
        let emitter = ChatV2EventEmitter::new(window, session_id.clone());
        emitter.emit_error(
            event_types::TOOL_APPROVAL_REQUEST,
            &approval_block_id,
            "approval_expired",
            None,
        );
        return Err("approval_expired".to_string());
    }

    // 🔧 P1-51: 如果用户选择"记住选择"，持久化到数据库
    if remember {
        let args_value = arguments.unwrap_or(Value::Null);
        let setting_key = approval_scope_setting_key(&tool_name, &args_value);
        let setting_value = if approved { "allow" } else { "deny" };

        log::info!(
            "[ChatV2::approval] Persisting approval choice: {}={} (tool_call_id={})",
            setting_key,
            setting_value,
            tool_call_id
        );

        if let Err(e) = db.save_setting(&setting_key, setting_value) {
            log::error!(
                "[ChatV2::approval] Failed to persist approval choice for '{}': {}",
                tool_name,
                e
            );
        }
    }

    Ok(())
}

/// 取消工具审批请求
///
/// 当用户切换会话或关闭对话框时调用，清理未响应的审批请求。
///
/// ## 参数
/// - `tool_call_id`: 工具调用 ID
#[tauri::command]
pub async fn chat_v2_tool_approval_cancel(
    approval_manager: State<'_, Arc<ApprovalManager>>,
    tool_call_id: String,
) -> Result<(), String> {
    log::info!(
        "[ChatV2::approval] Cancelling approval request: tool_call_id={}",
        tool_call_id
    );

    approval_manager.cancel(&tool_call_id);
    Ok(())
}
