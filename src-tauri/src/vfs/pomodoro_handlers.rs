//! 番茄钟 Tauri 命令处理器（新增命令）
//!
//! 既有番茄钟命令（pomodoro_create_record 等）位于 `todo_handlers.rs`；
//! 本文件承载后续新增的番茄钟命令，避免与 todo 命令混编。
//! 所有命令以 `pomodoro_` 前缀命名。

use std::sync::Arc;

use tauri::{AppHandle, Manager, State};

use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::VfsPomodoroRepo;
use crate::vfs::types::PomodoroRecord;

/// 软删除番茄钟记录
///
/// 若该记录为 work+completed 且关联了任务，会同步回退
/// `todo_items.completed_pomodoros`（与创建时的自增联动对称）。
#[tauri::command]
pub fn pomodoro_delete_record(app: AppHandle, record_id: String) -> Result<(), String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsPomodoroRepo::delete_record(&vfs_db, &record_id).map_err(|e| e.to_string())
}

/// 按本地日历日闭区间列出番茄钟记录（YYYY-MM-DD，按 created_at DESC）
#[tauri::command]
pub fn pomodoro_list_range(
    app: AppHandle,
    start_date: String,
    end_date: String,
) -> Result<Vec<PomodoroRecord>, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsPomodoroRepo::list_range(&vfs_db, &start_date, &end_date).map_err(|e| e.to_string())
}
