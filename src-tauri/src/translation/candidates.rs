//! 多候选翻译前端命令（薄包装；逻辑见 `dstu_tutor::translation::candidates`）。

pub use dstu_tutor::translation::candidates::*;

use dstu_tutor::translation::candidates as logic;
use dstu_tutor::translation::types::{TranslationCandidatesResponse, TranslationRequest};
use tauri::{State, Window};

use super::translation_state;
use crate::commands::AppState;
use crate::models::AppError;

/// 命令：多候选翻译（并发流式）
///
/// # 参数
/// - `request`: 与 `translate_text_stream` 相同的请求结构（复用术语表/风格/领域字段）
/// - `num_candidates`: 候选数（默认 2，范围 1~3）
///
/// # 返回
/// 全部候选（含失败候选）；同时通过事件流实时回传增量。
#[tauri::command]
pub async fn translate_text_candidates(
    request: TranslationRequest,
    num_candidates: Option<u32>,
    window: Window,
    state: State<'_, AppState>,
) -> Result<TranslationCandidatesResponse, AppError> {
    logic::translate_text_candidates(request, num_candidates, window, translation_state(&state))
        .await
}

/// 命令：取消一次多候选翻译（对该 session 的全部候选广播取消信号）
#[tauri::command]
pub async fn cancel_translation_candidates(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<bool, AppError> {
    logic::cancel_translation_candidates(session_id, translation_state(&state)).await
}
