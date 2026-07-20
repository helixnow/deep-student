//! 番茄钟 Tauri 命令处理器（新增命令）
//!
//! 既有番茄钟命令（pomodoro_create_record 等）位于 `todo_handlers.rs`；
//! 本文件承载后续新增的番茄钟命令，避免与 todo 命令混编。
//! 所有命令以 `pomodoro_` 前缀命名。

use std::sync::Arc;

use tauri::{AppHandle, Manager, State};

use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::pomodoro_repo::{PomodoroStatsOverview, PomodoroTodoFocusSummary};
use crate::vfs::repos::VfsPomodoroRepo;
use crate::vfs::types::{
    PomodoroHourlyStat, PomodoroRecord, PomodoroStreakStats, PomodoroTodoStat,
};

/// 软删除番茄钟记录
///
/// 若该记录为 work+completed 且关联了任务，会同步回退
/// `todo_items.completed_pomodoros`（与创建时的自增联动对称）。
#[tauri::command]
pub fn pomodoro_delete_record(app: AppHandle, record_id: String) -> Result<(), String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    // 删除前读出关联任务：work+completed 记录删除会回退
    // todo_items.completed_pomodoros，需要向 todo 视图广播刷新
    let linked_item = VfsPomodoroRepo::get_record(&vfs_db, &record_id)
        .ok()
        .flatten()
        .filter(|r| r.r#type == "work" && r.status == "completed")
        .and_then(|r| r.todo_item_id);
    VfsPomodoroRepo::delete_record(&vfs_db, &record_id).map_err(|e| e.to_string())?;
    if let Some(item_id) = linked_item {
        crate::vfs::todo_handlers::emit_todo_changed(
            &app,
            "update",
            std::slice::from_ref(&item_id),
        );
    }
    Ok(())
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

/// 连续专注天数统计（按本地日聚合 completed work 记录）
///
/// 返回 `{ currentStreakDays, longestStreakDays }`；今天尚无记录时
/// current 从昨天起算（当天未打卡不打断连续）。
#[tauri::command]
pub fn pomodoro_streak(app: AppHandle) -> Result<PomodoroStreakStats, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsPomodoroRepo::get_streak_stats(&vfs_db).map_err(|e| e.to_string())
}

/// 近 N 天（默认 30，clamp 1-366）按本地小时分桶的专注统计
///
/// 返回 24 个桶（hour 0-23 全量补零），按 `start_time` 本地小时归桶。
#[tauri::command]
pub fn pomodoro_hourly_stats(
    app: AppHandle,
    days: Option<u32>,
) -> Result<Vec<PomodoroHourlyStat>, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsPomodoroRepo::get_hourly_stats(&vfs_db, days.unwrap_or(30)).map_err(|e| e.to_string())
}

/// 按任务聚合的番茄统计（专注时长排行）
///
/// 日期参数 `YYYY-MM-DD` 按本地日闭区间解释，缺省侧不限；
/// limit 默认 20。软删任务标题仍返回。
#[tauri::command]
pub fn pomodoro_stats_by_todo(
    app: AppHandle,
    start_date: Option<String>,
    end_date: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<PomodoroTodoStat>, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsPomodoroRepo::get_stats_by_todo(
        &vfs_db,
        start_date.as_deref(),
        end_date.as_deref(),
        limit.unwrap_or(20),
    )
    .map_err(|e| e.to_string())
}

/// 统计总览：今日 + streak + 近 N 天按日/按周聚合（默认 30，clamp 1-366）。
///
/// 一次调用替代 pomodoro_today_stats + pomodoro_streak + pomodoro_daily_stats
/// 三连发；weekly 由 daily 派生（周一为一周起点），口径一致。
#[tauri::command]
pub fn pomodoro_stats_overview(
    app: AppHandle,
    days: Option<u32>,
) -> Result<PomodoroStatsOverview, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsPomodoroRepo::get_stats_overview(&vfs_db, days.unwrap_or(30)).map_err(|e| e.to_string())
}

/// 某任务的专注历史聚合：累计专注/完成/中断 + 首末次时间 + 按日明细。
///
/// 任务不存在时不报错（todoTitle=null、计数为 0），便于历史悬挂引用降级展示。
#[tauri::command]
pub fn pomodoro_todo_focus_summary(
    app: AppHandle,
    todo_item_id: String,
) -> Result<PomodoroTodoFocusSummary, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsPomodoroRepo::get_todo_focus_summary(&vfs_db, &todo_item_id).map_err(|e| e.to_string())
}
