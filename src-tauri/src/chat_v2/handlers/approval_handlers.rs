//! 工具审批 Tauri 命令处理器
//!
//! 提供工具审批相关的 Tauri 命令，供前端调用。
//!
//! ## 设计文档
//! 参考：`src/chat-v2/docs/29-ChatV2-Agent能力增强改造方案.md` 第 4.7 节

use serde_json::Value;
use std::sync::Arc;
use tauri::{State, Window};

use crate::chat_v2::approval_manager::{ApprovalManager, ApprovalResponse};
use crate::chat_v2::approval_scope;
use crate::chat_v2::events::{event_types, ChatV2EventEmitter};
// 🔧 P1-51: 引入数据库用于持久化审批选择
use crate::database::Database;

// ============================================================================
// Tauri 命令
// ============================================================================

// 🔧 M-081 修复（P2）：不再在本模块定义 approval_scope_setting_key，
// 统一调用 approval_scope::make_setting_key，避免多处定义漂移。

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
        // 🔧 M-081 修复（P2）：统一入口，v2 优先，未知工具 fallback v1
        let setting_key = approval_scope::make_setting_key(&tool_name, &args_value);
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

/// 🆕 R2-H2 修复：统一清空全部"记住的审批选择"
///
/// 同时清理两个存储层：
/// 1. `ApprovalManager.remembered` 内存 HashMap（当前进程）
/// 2. `settings` 表中所有 `tool_approval.scope.*` 持久化条目
///
/// 只清内存会让重启后死而复生；只清 DB 会让未重启进程继续"记得"旧批准
/// （R2-H2 就是后者 — 设置页只调 `delete_settings_by_prefix` 不碰内存）。
///
/// ## 返回
/// 被删除的 DB 条目数
#[tauri::command]
pub async fn chat_v2_clear_approval_history(
    approval_manager: State<'_, Arc<ApprovalManager>>,
    db: State<'_, Arc<Database>>,
) -> Result<usize, String> {
    // 1. 清内存
    approval_manager.clear_all_remembered();

    // 2. 清 DB —— 两种前缀都要清（v2 `tool_approval.scope.<ns>:<tool>.` 和
    //    v1 `tool_approval.scope.<tool>.` 共享同一个 "tool_approval.scope." 前缀）
    let deleted = db
        .delete_settings_by_prefix("tool_approval.scope.")
        .map_err(|e| {
            log::error!(
                "[ChatV2::approval] clear_approval_history: delete DB entries failed: {}",
                e
            );
            format!("{}", e)
        })?;

    log::info!(
        "[ChatV2::approval] clear_approval_history: removed {} DB entries + in-memory map",
        deleted
    );

    Ok(deleted)
}
