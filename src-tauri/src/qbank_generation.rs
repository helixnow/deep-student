//! 题目集 AI 出题：业务体在 `dstu_qbank::qbank_generation`，这里按原路径重导出。
//!
//! 命令签名取 `State<'_, AppState>`（`AppState` 在 app），`#[tauri::command]` 薄包装因此
//! 留在 app：从 AppState 取出 `QbankState` 后调用 crate 中的同名业务体，行为不变。

use tauri::{AppHandle, State};

pub use dstu_qbank::qbank_generation::*;

use crate::commands::AppState;
use crate::models::AppError;
use dstu_qbank::qbank_generation::task_repo::GenerationTaskView;
use dstu_qbank::qbank_generation::types::QbankGenerationRequest;

/// 提交 AI 出题任务（立即返回任务视图，后台执行）
#[tauri::command]
pub async fn qbank_ai_generate_questions(
    request: QbankGenerationRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<GenerationTaskView, AppError> {
    let state = crate::extensions::qbank_state(&state);
    dstu_qbank::qbank_generation::qbank_ai_generate_questions(request, app, &state).await
}

/// 查询单个任务（轮询兜底 + 重开面板恢复用）
#[tauri::command]
pub async fn qbank_get_generation_task(
    task_id: String,
    state: State<'_, AppState>,
) -> Result<Option<GenerationTaskView>, AppError> {
    let state = crate::extensions::qbank_state(&state);
    dstu_qbank::qbank_generation::qbank_get_generation_task(task_id, &state).await
}

/// 列出题目集的任务（按创建时间倒序）
#[tauri::command]
pub async fn qbank_list_generation_tasks(
    exam_id: String,
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<GenerationTaskView>, AppError> {
    let state = crate::extensions::qbank_state(&state);
    dstu_qbank::qbank_generation::qbank_list_generation_tasks(exam_id, limit, &state).await
}

/// 取消任务（向 LLM 流发取消信号，后台任务收尾后发 cancelled 事件）
#[tauri::command]
pub async fn qbank_cancel_generation_task(
    task_id: String,
    state: State<'_, AppState>,
) -> Result<Option<GenerationTaskView>, AppError> {
    let state = crate::extensions::qbank_state(&state);
    dstu_qbank::qbank_generation::qbank_cancel_generation_task(task_id, &state).await
}
