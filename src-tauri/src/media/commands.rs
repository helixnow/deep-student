//! 媒体转写 Tauri 命令（实现见 `dstu_media::media::commands`，这里按原路径重导出）。
//!
//! `media_transcribe_estimate` / `media_transcribe_start` 取 `State<'_, AppState>`
//! （`AppState` 定义在 app），以同名同签名的薄包装留在这里，实现体在 dstu-media 的
//! `*_with` 函数。

pub use dstu_media::media::commands::*;

use std::sync::Arc;

use tauri::State;

use crate::commands::AppState;
use crate::vfs::database::VfsDatabase;
use crate::vfs::pdf_processing_service::PdfProcessingService;

type CmdResult<T> = Result<T, String>;

#[tauri::command]
pub async fn media_transcribe_estimate(
    resource_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    state: State<'_, AppState>,
) -> CmdResult<TranscribeEstimate> {
    media_transcribe_estimate_with(resource_id, vfs_db, &state.llm_manager, &state.database).await
}

#[tauri::command]
pub async fn media_transcribe_start(
    resource_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    pdf_processing_service: State<'_, Arc<PdfProcessingService>>,
    state: State<'_, AppState>,
) -> CmdResult<TranscriptStatusView> {
    media_transcribe_start_with(
        resource_id,
        vfs_db,
        pdf_processing_service,
        &state.llm_manager,
        &state.database,
    )
    .await
}
