//! 用户提问 Tauri 命令处理器
//!
//! 提供用户提问相关的 Tauri 命令，供前端 askUserBlock 组件调用。
//! 桥接前端 `invoke()` 到后端 `AskUserExecutor` 的 oneshot channel。
//!
//! ## 设计参考
//! - `approval_handlers.rs`: Tauri command 桥接审批响应模式

use crate::chat_v2::tools::ask_user_executor::{handle_ask_user_response, AskUserResponse};

// ============================================================================
// Tauri 命令
// ============================================================================

/// 响应用户提问
///
/// 前端用户选择选项或输入自定义回答后调用此命令，
/// 将回答发送给等待的 AskUserExecutor。
///
/// ## 参数
/// - `tool_call_id`: 工具调用 ID（用于匹配等待的 channel）
/// - `selected_texts`: 用户选择的文本列表（支持多选）
/// - `selected_indices`: 选项索引列表
/// - `custom_text`: 用户自定义输入文本（可选）
/// - `source`: 回答来源（"user_click" | "custom_input" | "mixed" | "timeout" | "channel_closed"）
#[tauri::command]
pub async fn chat_v2_ask_user_respond(
    tool_call_id: String,
    selected_texts: Vec<String>,
    selected_indices: Vec<i32>,
    custom_text: Option<String>,
    source: String,
) -> Result<(), String> {
    log::info!(
        "[ChatV2::ask_user] Received response: tool_call_id={}, selected={:?}, indices={:?}, custom_text={:?}, source='{}'",
        tool_call_id,
        selected_texts,
        selected_indices,
        custom_text,
        source
    );

    let response = AskUserResponse {
        tool_call_id,
        selected_texts,
        selected_indices,
        custom_text,
        source,
    };

    handle_ask_user_response(response);
    Ok(())
}
