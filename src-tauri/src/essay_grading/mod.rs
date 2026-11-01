//! 作文批改前端命令（薄包装）。
//!
//! 管线、类型、自定义模式与命令逻辑在 `dstu_tutor::essay_grading`，这里按原路径
//! `crate::essay_grading::xxx` 重导出。命令需要 app 的 `AppState`，因此 `#[tauri::command]`
//! 留在 app：从 `AppState` 借用 `llm_manager` / `vfs_db` / `custom_mode_manager` 构造
//! `EssayGradingState`，再调用 crate 中的同名函数（命令名、参数名/顺序、返回类型不变）。

pub use dstu_tutor::essay_grading::*;

use dstu_tutor::essay_grading as logic;
use dstu_tutor::essay_grading::types::{GradingRequest, GradingResponse, GradingRoundResponse};
use tauri::{State, Window};

use crate::models::AppError;
use crate::vfs::types::{VfsEssaySession, VfsUpdateEssaySessionParams};

/// 从 `AppState` 借出作文批改命令所需的状态切片
fn grading_state(state: &crate::commands::AppState) -> EssayGradingState<'_> {
    EssayGradingState {
        llm_manager: &state.llm_manager,
        vfs_db: state.vfs_db.as_ref(),
        custom_mode_manager: state.custom_mode_manager.as_ref(),
    }
}

/// 流式批改命令
#[tauri::command]
pub async fn essay_grading_stream(
    request: GradingRequest,
    window: Window,
    state: State<'_, crate::commands::AppState>,
) -> Result<Option<GradingResponse>, AppError> {
    logic::essay_grading_stream(request, window, grading_state(&state)).await
}

/// 创建新会话
#[tauri::command]
pub async fn essay_grading_create_session(
    title: String,
    essay_type: String,
    grade_level: String,
    custom_prompt: Option<String>,
    state: State<'_, crate::commands::AppState>,
) -> Result<VfsEssaySession, AppError> {
    logic::essay_grading_create_session(
        title,
        essay_type,
        grade_level,
        custom_prompt,
        grading_state(&state),
    )
    .await
}

/// 获取会话详情
#[tauri::command]
pub async fn essay_grading_get_session(
    session_id: String,
    state: State<'_, crate::commands::AppState>,
) -> Result<Option<VfsEssaySession>, AppError> {
    logic::essay_grading_get_session(session_id, grading_state(&state)).await
}

/// 更新会话
///
/// ★ M-061 修复：接收 VfsUpdateEssaySessionParams（仅可变字段），
///   而非完整 VfsEssaySession，确保前后端参数契约一致。
#[tauri::command]
pub async fn essay_grading_update_session(
    session: VfsUpdateEssaySessionParams,
    state: State<'_, crate::commands::AppState>,
) -> Result<(), AppError> {
    logic::essay_grading_update_session(session, grading_state(&state)).await
}

/// 永久删除会话
///
/// ★ 2025-12-11: 统一命名规范，使用 purge 表示永久删除
#[tauri::command]
pub async fn essay_grading_delete_session(
    session_id: String,
    state: State<'_, crate::commands::AppState>,
) -> Result<usize, AppError> {
    logic::essay_grading_delete_session(session_id, grading_state(&state)).await
}

/// 获取会话列表（query 非空时先过滤、再分页）
#[tauri::command]
pub async fn essay_grading_list_sessions(
    offset: Option<u32>,
    limit: Option<u32>,
    query: Option<String>,
    state: State<'_, crate::commands::AppState>,
) -> Result<Vec<VfsEssaySession>, AppError> {
    logic::essay_grading_list_sessions(offset, limit, query, grading_state(&state)).await
}

/// 切换收藏状态
#[tauri::command]
pub async fn essay_grading_toggle_favorite(
    session_id: String,
    state: State<'_, crate::commands::AppState>,
) -> Result<bool, AppError> {
    logic::essay_grading_toggle_favorite(session_id, grading_state(&state)).await
}

/// 获取会话的所有轮次（含内容）
#[tauri::command]
pub async fn essay_grading_get_rounds(
    session_id: String,
    state: State<'_, crate::commands::AppState>,
) -> Result<Vec<GradingRoundResponse>, AppError> {
    logic::essay_grading_get_rounds(session_id, grading_state(&state)).await
}

/// 获取指定轮次（含内容）
#[tauri::command]
pub async fn essay_grading_get_round(
    session_id: String,
    round_number: i32,
    state: State<'_, crate::commands::AppState>,
) -> Result<Option<GradingRoundResponse>, AppError> {
    logic::essay_grading_get_round(session_id, round_number, grading_state(&state)).await
}

/// 获取最新轮次号
#[tauri::command]
pub async fn essay_grading_get_latest_round_number(
    session_id: String,
    state: State<'_, crate::commands::AppState>,
) -> Result<i32, AppError> {
    logic::essay_grading_get_latest_round_number(session_id, grading_state(&state)).await
}

/// 获取所有批阅模式（内置 + 自定义，自定义覆盖优先）
#[tauri::command]
pub async fn essay_grading_get_modes(
    state: State<'_, crate::commands::AppState>,
) -> Result<Vec<types::GradingMode>, AppError> {
    logic::essay_grading_get_modes(grading_state(&state)).await
}

/// 获取指定批阅模式（自定义覆盖优先）
#[tauri::command]
pub async fn essay_grading_get_mode(
    mode_id: String,
    state: State<'_, crate::commands::AppState>,
) -> Result<Option<types::GradingMode>, AppError> {
    logic::essay_grading_get_mode(mode_id, grading_state(&state)).await
}

// ============================================================================
// 自定义批阅模式 CRUD
// ============================================================================

/// 创建自定义批阅模式
#[tauri::command]
pub async fn essay_grading_create_custom_mode(
    input: custom_modes::CreateModeInput,
    state: State<'_, crate::commands::AppState>,
) -> Result<types::GradingMode, AppError> {
    logic::essay_grading_create_custom_mode(input, grading_state(&state)).await
}

/// 更新自定义批阅模式
#[tauri::command]
pub async fn essay_grading_update_custom_mode(
    input: custom_modes::UpdateModeInput,
    state: State<'_, crate::commands::AppState>,
) -> Result<types::GradingMode, AppError> {
    logic::essay_grading_update_custom_mode(input, grading_state(&state)).await
}

/// 删除自定义批阅模式
#[tauri::command]
pub async fn essay_grading_delete_custom_mode(
    mode_id: String,
    state: State<'_, crate::commands::AppState>,
) -> Result<(), AppError> {
    logic::essay_grading_delete_custom_mode(mode_id, grading_state(&state)).await
}

/// 获取所有自定义批阅模式
#[tauri::command]
pub async fn essay_grading_list_custom_modes(
    state: State<'_, crate::commands::AppState>,
) -> Result<Vec<types::GradingMode>, AppError> {
    logic::essay_grading_list_custom_modes(grading_state(&state)).await
}

/// 保存预置模式的自定义覆盖
#[tauri::command]
pub async fn essay_grading_save_builtin_override(
    input: custom_modes::SaveBuiltinOverrideInput,
    state: State<'_, crate::commands::AppState>,
) -> Result<types::GradingMode, AppError> {
    logic::essay_grading_save_builtin_override(input, grading_state(&state)).await
}

/// 重置预置模式为默认配置
#[tauri::command]
pub async fn essay_grading_reset_builtin_mode(
    builtin_id: String,
    state: State<'_, crate::commands::AppState>,
) -> Result<types::GradingMode, AppError> {
    logic::essay_grading_reset_builtin_mode(builtin_id, grading_state(&state)).await
}

/// 检查预置模式是否有自定义覆盖
#[tauri::command]
pub async fn essay_grading_has_builtin_override(
    builtin_id: String,
    state: State<'_, crate::commands::AppState>,
) -> Result<bool, AppError> {
    logic::essay_grading_has_builtin_override(builtin_id, grading_state(&state)).await
}

/// 获取可用于作文批改的模型列表（过滤逻辑见 `dstu_tutor::essay_grading::essay_grading_get_models`）
#[tauri::command]
pub async fn essay_grading_get_models(
    state: tauri::State<'_, crate::commands::AppState>,
) -> Result<Vec<ModelInfo>, AppError> {
    logic::essay_grading_get_models(grading_state(&state)).await
}
