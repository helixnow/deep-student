//! 翻译前端命令（薄包装）。
//!
//! 管线、事件、类型与命令逻辑在 `dstu_tutor::translation`，这里按原路径
//! `crate::translation::xxx` 重导出。命令需要 app 的 `AppState`，因此 `#[tauri::command]`
//! 留在 app：从 `AppState` 借用 `llm_manager` / `database` / `vfs_db` 构造 `TranslationState`，
//! 再调用 crate 中的同名函数（命令名、参数名/顺序、返回类型、事件名不变）。
//! `candidates` / `chat_popover` 同样是 app 侧薄包装模块，重导出 crate 中的同名模块。

pub use dstu_tutor::translation::*;

pub mod candidates;
pub mod chat_popover;

use dstu_tutor::translation as logic;
use dstu_tutor::translation::types::{TranslationRequest, TranslationResponse};
use tauri::{State, Window};

use crate::models::AppError;

/// 从 `AppState` 借出翻译命令所需的状态切片
pub(crate) fn translation_state(state: &crate::commands::AppState) -> TranslationState<'_> {
    TranslationState {
        llm_manager: &state.llm_manager,
        database: &state.database,
        vfs_db: state.vfs_db.as_ref(),
    }
}

/// 流式翻译命令
///
/// # 参数
/// - `request`: 翻译请求（包含源文本、语言对、提示词等）
/// - `window`: Tauri 窗口句柄（用于发送 SSE 事件）
/// - `state`: 应用状态（访问 LLMManager、Database 等）
#[tauri::command]
pub async fn translate_text_stream(
    request: TranslationRequest,
    window: Window,
    state: State<'_, crate::commands::AppState>,
) -> Result<Option<TranslationResponse>, AppError> {
    logic::translate_text_stream(request, window, translation_state(&state)).await
}
