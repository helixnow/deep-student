//! 媒体学习台账（实现见 `dstu_media::media::ledger`，这里按原路径重导出）。
//!
//! `media_checkpoints` / `media_chapters` / `media_study_ledger` 取 `State<'_, AppState>`
//! （`AppState` 定义在 app），以同名同签名的薄包装留在这里，实现体在 dstu-media 的
//! `*_with` 函数。

pub use dstu_media::media::ledger::*;

use tauri::State;

#[tauri::command]
pub async fn media_checkpoints(
    resource_id: String,
    state: State<'_, crate::commands::AppState>,
) -> Result<Vec<MediaCheckpoint>, String> {
    media_checkpoints_with(resource_id, state.vfs_db.clone()).await
}

#[tauri::command]
pub async fn media_chapters(
    resource_id: String,
    state: State<'_, crate::commands::AppState>,
) -> Result<Vec<MediaChapter>, String> {
    media_chapters_with(resource_id, state.vfs_db.clone()).await
}

#[tauri::command]
pub async fn media_study_ledger(
    resource_ids: Vec<String>,
    include_card_ids: Option<bool>,
    state: State<'_, crate::commands::AppState>,
) -> Result<Vec<MediaStudyLedger>, String> {
    let anki_db = state.anki_database.clone();
    let vfs_db = state.vfs_db.clone();
    media_study_ledger_with(resource_ids, include_card_ids, anki_db, vfs_db).await
}
