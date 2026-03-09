//! 番茄钟记录 Repo
//!
//! 提供 pomodoro_records 表的 CRUD 操作。

use log::{info, warn};
use rusqlite::{params, Connection, OptionalExtension};

use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};
use crate::vfs::types::{CreatePomodoroRecordParams, PomodoroRecord, PomodoroTodayStats};

fn log_and_skip_err<T>(r: Result<T, rusqlite::Error>) -> Option<T> {
    match r {
        Ok(v) => Some(v),
        Err(e) => {
            warn!("[VFS::PomodoroRepo] Row parse error: {}", e);
            None
        }
    }
}

/// 番茄钟记录 Repo
pub struct VfsPomodoroRepo;

impl VfsPomodoroRepo {
    /// 创建番茄钟记录
    pub fn create_record(
        db: &VfsDatabase,
        params: CreatePomodoroRecordParams,
    ) -> VfsResult<PomodoroRecord> {
        let conn = db.get_conn_safe()?;
        let record_id = PomodoroRecord::generate_id();
        let now = chrono::Local::now()
            .format("%Y-%m-%dT%H:%M:%S%.3f")
            .to_string();

        conn.execute(
            r#"
            INSERT INTO pomodoro_records (id, todo_item_id, start_time, end_time, duration, actual_duration, type, status, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            "#,
            params![
                record_id,
                params.todo_item_id,
                params.start_time,
                params.end_time,
                params.duration,
                params.actual_duration,
                params.r#type,
                params.status,
                now,
            ],
        )?;

        // 如果关联了任务且为已完成的 work 类型，自动递增 todo_items.completed_pomodoros
        if let Some(ref item_id) = params.todo_item_id {
            if params.status == "completed" && params.r#type == "work" {
                conn.execute(
                    r#"
                    UPDATE todo_items
                    SET completed_pomodoros = COALESCE(completed_pomodoros, 0) + 1,
                        updated_at = ?1
                    WHERE id = ?2 AND deleted_at IS NULL
                    "#,
                    params![now, item_id],
                )?;
            }
        }

        info!("[VFS::PomodoroRepo] Created pomodoro record: {}", record_id);

        Ok(PomodoroRecord {
            id: record_id,
            todo_item_id: params.todo_item_id,
            start_time: params.start_time,
            end_time: params.end_time,
            duration: params.duration,
            actual_duration: params.actual_duration,
            r#type: params.r#type,
            status: params.status,
            created_at: now,
        })
    }

    /// 获取单条记录
    pub fn get_record(db: &VfsDatabase, record_id: &str) -> VfsResult<Option<PomodoroRecord>> {
        let conn = db.get_conn_safe()?;
        let result = conn
            .query_row(
                r#"
                SELECT id, todo_item_id, start_time, end_time, duration, actual_duration, type, status, created_at
                FROM pomodoro_records
                WHERE id = ?1
                "#,
                params![record_id],
                Self::row_to_record,
            )
            .optional()?;
        Ok(result)
    }

    /// 列出某个任务关联的番茄钟记录
    pub fn list_by_todo_item(
        db: &VfsDatabase,
        todo_item_id: &str,
    ) -> VfsResult<Vec<PomodoroRecord>> {
        let conn = db.get_conn_safe()?;
        let mut stmt = conn.prepare(
            r#"
            SELECT id, todo_item_id, start_time, end_time, duration, actual_duration, type, status, created_at
            FROM pomodoro_records
            WHERE todo_item_id = ?1
            ORDER BY created_at DESC
            "#,
        )?;
        let rows = stmt.query_map(params![todo_item_id], Self::row_to_record)?;
        Ok(rows.filter_map(log_and_skip_err).collect())
    }

    /// 获取今日统计
    pub fn get_today_stats(db: &VfsDatabase) -> VfsResult<PomodoroTodayStats> {
        let conn = db.get_conn_safe()?;
        let today_start = chrono::Local::now()
            .format("%Y-%m-%dT00:00:00")
            .to_string();

        let completed_count: usize = conn
            .query_row(
                r#"
                SELECT COUNT(*) FROM pomodoro_records
                WHERE type = 'work' AND status = 'completed' AND created_at >= ?1
                "#,
                params![today_start],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let total_focus_seconds: i64 = conn
            .query_row(
                r#"
                SELECT COALESCE(SUM(actual_duration), 0) FROM pomodoro_records
                WHERE type = 'work' AND status = 'completed' AND created_at >= ?1
                "#,
                params![today_start],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let interrupted_count: usize = conn
            .query_row(
                r#"
                SELECT COUNT(*) FROM pomodoro_records
                WHERE type = 'work' AND status = 'interrupted' AND created_at >= ?1
                "#,
                params![today_start],
                |row| row.get(0),
            )
            .unwrap_or(0);

        Ok(PomodoroTodayStats {
            completed_count,
            total_focus_seconds,
            interrupted_count,
        })
    }

    /// 列出今日的所有番茄钟记录
    pub fn list_today_records(db: &VfsDatabase) -> VfsResult<Vec<PomodoroRecord>> {
        let conn = db.get_conn_safe()?;
        let today_start = chrono::Local::now()
            .format("%Y-%m-%dT00:00:00")
            .to_string();

        let mut stmt = conn.prepare(
            r#"
            SELECT id, todo_item_id, start_time, end_time, duration, actual_duration, type, status, created_at
            FROM pomodoro_records
            WHERE created_at >= ?1
            ORDER BY created_at DESC
            "#,
        )?;
        let rows = stmt.query_map(params![today_start], Self::row_to_record)?;
        Ok(rows.filter_map(log_and_skip_err).collect())
    }

    fn row_to_record(row: &rusqlite::Row) -> rusqlite::Result<PomodoroRecord> {
        Ok(PomodoroRecord {
            id: row.get(0)?,
            todo_item_id: row.get(1)?,
            start_time: row.get(2)?,
            end_time: row.get(3)?,
            duration: row.get(4)?,
            actual_duration: row.get(5)?,
            r#type: row.get(6)?,
            status: row.get(7)?,
            created_at: row.get(8)?,
        })
    }
}
