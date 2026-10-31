//! 题目集 AI 评判：业务体在 `dstu_qbank::qbank_grading`，这里按原路径重导出。
//!
//! 命令签名取 `State<'_, AppState>`（`AppState` 在 app），`#[tauri::command]` 薄包装因此
//! 留在 app：从 AppState 取出 `QbankState` 后调用 crate 中的同名业务体，行为不变。

use tauri::{State, Window};

pub use dstu_qbank::qbank_grading::*;

use crate::commands::AppState;
use crate::models::AppError;
use dstu_qbank::qbank_grading::types::{QbankGradingRequest, QbankGradingResponse};

/// 依赖 app `data_governance::sync` 的单测留在 app，模块路径保持 `qbank_grading::image_answer::tests`。
pub mod image_answer {
    pub use dstu_qbank::qbank_grading::image_answer::*;
    #[cfg(test)]
    mod tests;
}

/// 流式 AI 评判命令
#[tauri::command]
pub async fn qbank_ai_grade(
    request: QbankGradingRequest,
    window: Window,
    state: State<'_, AppState>,
) -> Result<Option<QbankGradingResponse>, AppError> {
    let state = crate::extensions::qbank_state(&state);
    dstu_qbank::qbank_grading::qbank_ai_grade(request, window, &state).await
}

/// 取消 AI 评判
#[tauri::command]
pub async fn qbank_cancel_grading(
    stream_event_name: String,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let state = crate::extensions::qbank_state(&state);
    dstu_qbank::qbank_grading::qbank_cancel_grading(stream_event_name, &state).await
}
