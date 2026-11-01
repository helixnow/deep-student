//! 聊天弹窗翻译前端命令（薄包装；逻辑见 `dstu_tutor::translation::chat_popover`）。

pub use dstu_tutor::translation::chat_popover::*;

use dstu_tutor::translation::chat_popover as logic;
use tauri::{State, Window};

use super::translation_state;
use crate::commands::AppState;
use crate::models::AppError;

/// 命令：流式短语对照翻译（NDJSON 输出）
///
/// 前端事件订阅：`chat_translation_${request_id}`
/// 取消：调用通用命令 `cancel_stream` 传入相同事件名
#[tauri::command]
pub async fn stream_chat_translation_aligned(
    request: ChatTranslationRequest,
    window: Window,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    logic::stream_chat_translation_aligned(request, window, translation_state(&state)).await
}

/// 命令：流式纯译文翻译（单栏渐进显示）
#[tauri::command]
pub async fn stream_chat_translation_plain(
    request: ChatTranslationRequest,
    window: Window,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    logic::stream_chat_translation_plain(request, window, translation_state(&state)).await
}
