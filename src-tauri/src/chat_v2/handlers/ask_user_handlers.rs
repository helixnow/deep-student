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
/// - `selected_text`: 用户选择/输入的文本
/// - `selected_index`: 选项索引（0-2 为固定选项，-1 为自定义输入）
/// - `source`: 回答来源（"user_click" | "custom_input" | "timeout"）
#[tauri::command]
pub async fn chat_v2_ask_user_respond(
    tool_call_id: String,
    selected_text: String,
    selected_index: Option<i32>,
    source: String,
) -> Result<(), String> {
    log::info!(
        "[ChatV2::ask_user] Received response: tool_call_id={}, selected='{}', index={:?}, source='{}'",
        tool_call_id,
        selected_text,
        selected_index,
        source
    );

    let response = AskUserResponse {
        tool_call_id,
        selected_text,
        selected_index,
        source,
    };

    handle_ask_user_response(response);
    Ok(())
}
