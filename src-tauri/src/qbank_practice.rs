//! 练习草稿 / 试卷 / 提交：业务体在 `dstu_qbank::qbank_practice`，这里按原路径重导出。
//!
//! 命令签名取 `State<'_, AppState>`（`AppState` 在 app），`#[tauri::command]` 薄包装因此
//! 留在 app：从 AppState 取出 `QbankState` 后调用 crate 中的同名业务体，行为不变。
//! `export` / `export_bridge` 子模块的命令不取 AppState，随 crate 搬走、经下面的重导出解析。

use tauri::State;

pub use dstu_qbank::qbank_practice::*;

use crate::commands::AppState;
use crate::models::AppError;
use crate::question_bank_service::GeneratedPaper;
use dstu_qbank::qbank_practice as practice;

#[tauri::command]
pub fn qbank_create_practice(
    request: CreatePracticeRequest,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<PracticeDraft, AppError> {
    practice::qbank_create_practice(request, app, &crate::extensions::qbank_state(&state))
}

#[tauri::command]
pub fn qbank_save_practice(
    request: SavePracticeRequest,
    state: State<'_, AppState>,
) -> Result<PracticeDraft, AppError> {
    practice::qbank_save_practice(request, &crate::extensions::qbank_state(&state))
}

#[tauri::command]
pub fn qbank_get_practice(
    id: String,
    submitted: bool,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, AppError> {
    practice::qbank_get_practice(id, submitted, &crate::extensions::qbank_state(&state))
}

#[tauri::command]
pub fn qbank_list_practices(
    scope_id: String,
    submitted: bool,
    offset: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<PracticeSummary>, AppError> {
    let state = crate::extensions::qbank_state(&state);
    practice::qbank_list_practices(scope_id, submitted, offset, &state)
}

#[tauri::command]
pub fn qbank_submit_practice(
    id: String,
    revision: i64,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<PracticeAttempt, AppError> {
    practice::qbank_submit_practice(id, revision, app, &crate::extensions::qbank_state(&state))
}

#[tauri::command]
pub fn qbank_delete_practice(
    id: String,
    submitted: bool,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    practice::qbank_delete_practice(id, submitted, &crate::extensions::qbank_state(&state))
}

#[tauri::command]
pub fn qbank_list_papers(
    exam_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<GeneratedPaper>, AppError> {
    practice::qbank_list_papers(exam_id, &crate::extensions::qbank_state(&state))
}

#[tauri::command]
pub fn qbank_get_paper(id: String, state: State<'_, AppState>) -> Result<GeneratedPaper, AppError> {
    practice::qbank_get_paper(id, &crate::extensions::qbank_state(&state))
}

#[tauri::command]
pub fn qbank_update_paper(
    id: String,
    title: Option<String>,
    deleted: bool,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let state = crate::extensions::qbank_state(&state);
    practice::qbank_update_paper(id, title, deleted, &state)
}

#[tauri::command]
pub fn qbank_resume_practice_grading(app: tauri::AppHandle, state: State<'_, AppState>) {
    practice::qbank_resume_practice_grading(app, &crate::extensions::qbank_state(&state))
}

#[tauri::command]
pub fn qbank_retry_practice_grading(
    id: String,
    question_id: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<PracticeAttempt, AppError> {
    let state = crate::extensions::qbank_state(&state);
    practice::qbank_retry_practice_grading(id, question_id, app, &state)
}

#[tauri::command]
pub fn qbank_grade_practice_manually(
    id: String,
    question_id: String,
    correct: bool,
    state: State<'_, AppState>,
) -> Result<PracticeAttempt, AppError> {
    let state = crate::extensions::qbank_state(&state);
    practice::qbank_grade_practice_manually(id, question_id, correct, &state)
}
