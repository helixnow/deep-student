//! 番茄钟记录 Repo
//!
//! 提供 pomodoro_records 表的 CRUD 操作。

use log::{info, warn};
use rusqlite::{params, OptionalExtension};

use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};
use crate::vfs::types::{
    CreatePomodoroRecordParams, PomodoroDailyStat, PomodoroRecord, PomodoroTodayStats,
};

const VALID_POMODORO_TYPES: &[&str] = &["work", "short_break", "long_break"];
const VALID_POMODORO_STATUSES: &[&str] = &["completed", "interrupted"];

fn log_and_skip_err<T>(r: Result<T, rusqlite::Error>) -> Option<T> {
    match r {
        Ok(v) => Some(v),
        Err(e) => {
            warn!("[VFS::PomodoroRepo] Row parse error: {}", e);
            None
        }
    }
}

fn validate_record_params(params: &CreatePomodoroRecordParams) -> VfsResult<()> {
    if !VALID_POMODORO_TYPES.contains(&params.r#type.as_str()) {
        return Err(VfsError::InvalidArgument {
            param: "type".to_string(),
            reason: format!(
                "Unsupported pomodoro type '{}'; expected one of {:?}",
                params.r#type, VALID_POMODORO_TYPES
            ),
        });
    }
    if !VALID_POMODORO_STATUSES.contains(&params.status.as_str()) {
        return Err(VfsError::InvalidArgument {
            param: "status".to_string(),
            reason: format!(
                "Unsupported pomodoro status '{}'; expected one of {:?}",
                params.status, VALID_POMODORO_STATUSES
            ),
        });
    }
    if params.duration < 0 {
        return Err(VfsError::InvalidArgument {
            param: "duration".to_string(),
            reason: "duration must be >= 0".to_string(),
        });
    }
    if params.actual_duration < 0 {
        return Err(VfsError::InvalidArgument {
            param: "actual_duration".to_string(),
            reason: "actual_duration must be >= 0".to_string(),
        });
    }
    Ok(())
}

/// 番茄钟记录 Repo
pub struct VfsPomodoroRepo;

impl VfsPomodoroRepo {
    /// 创建番茄钟记录
    ///
    /// 时间戳统一使用 UTC + `Z` 后缀（与 todo_repo 一致），保证
    /// `todo_items.updated_at` 参与云同步 LWW 比较时基准一致。
    pub fn create_record(
        db: &VfsDatabase,
        params: CreatePomodoroRecordParams,
    ) -> VfsResult<PomodoroRecord> {
        validate_record_params(&params)?;

        let conn = db.get_conn_safe()?;
        let record_id = PomodoroRecord::generate_id();
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        conn.execute("SAVEPOINT pomodoro_create", [])?;

        let result = (|| -> VfsResult<()> {
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
            Ok(())
        })();

        match result {
            Ok(_) => {
                conn.execute("RELEASE SAVEPOINT pomodoro_create", [])?;
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK TO SAVEPOINT pomodoro_create", []);
                let _ = conn.execute("RELEASE SAVEPOINT pomodoro_create", []);
                return Err(e);
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

    /// 本地"今天 00:00"对应的 UTC 时间戳字符串（与 created_at 同格式，可直接字符串比较）
    fn local_day_start_utc() -> String {
        use chrono::TimeZone;
        chrono::Local::now()
            .date_naive()
            .and_hms_opt(0, 0, 0)
            .and_then(|naive| chrono::Local.from_local_datetime(&naive).single())
            .map(|dt| {
                dt.with_timezone(&chrono::Utc)
                    .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                    .to_string()
            })
            .unwrap_or_else(|| {
                chrono::Utc::now()
                    .format("%Y-%m-%dT00:00:00.000Z")
                    .to_string()
            })
    }

    /// 获取今日统计
    pub fn get_today_stats(db: &VfsDatabase) -> VfsResult<PomodoroTodayStats> {
        let conn = db.get_conn_safe()?;
        let today_start = Self::local_day_start_utc();

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

    /// 近 N 天（含今天）的按日聚合统计，按本地日期分桶。
    ///
    /// 仅统计 work 类型：completed 计入完成数；focus_seconds 累加
    /// completed 与 interrupted 的 actual_duration（真实专注时间）。
    /// 返回完整日期序列（无记录的天补零），升序排列。
    pub fn get_daily_stats(db: &VfsDatabase, days: u32) -> VfsResult<Vec<PomodoroDailyStat>> {
        use chrono::{DateTime, Duration, TimeZone, Utc};

        let days = days.clamp(1, 366) as i64;
        let today = chrono::Local::now().date_naive();
        let range_start_local = today - Duration::days(days - 1);
        // 本地起始日 00:00 对应的 UTC 时间戳（与 created_at 同格式，可直接字符串比较）
        let range_start_utc = range_start_local
            .and_hms_opt(0, 0, 0)
            .and_then(|naive| chrono::Local.from_local_datetime(&naive).single())
            .map(|dt| {
                dt.with_timezone(&Utc)
                    .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                    .to_string()
            })
            .unwrap_or_else(|| Utc::now().format("%Y-%m-%dT00:00:00.000Z").to_string());

        let conn = db.get_conn_safe()?;
        let mut stmt = conn.prepare(
            r#"
            SELECT created_at, status, actual_duration
            FROM pomodoro_records
            WHERE type = 'work' AND created_at >= ?1
            "#,
        )?;
        let rows: Vec<(String, String, i64)> = stmt
            .query_map(params![range_start_utc], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?
            .filter_map(log_and_skip_err)
            .collect();

        // 预填完整日期序列（无记录天补零，前端热力图/趋势不必再补洞）
        let mut buckets: Vec<PomodoroDailyStat> = (0..days)
            .map(|i| PomodoroDailyStat {
                date: (range_start_local + Duration::days(i))
                    .format("%Y-%m-%d")
                    .to_string(),
                completed_count: 0,
                focus_seconds: 0,
                interrupted_count: 0,
            })
            .collect();

        for (created_at, status, actual_duration) in rows {
            // UTC 时间戳 → 本地日期分桶
            let local_date = DateTime::parse_from_rfc3339(&created_at)
                .map(|dt| dt.with_timezone(&chrono::Local).date_naive())
                .unwrap_or(today);
            let idx = (local_date - range_start_local).num_days();
            if idx < 0 || idx >= days {
                continue;
            }
            let bucket = &mut buckets[idx as usize];
            match status.as_str() {
                "completed" => {
                    bucket.completed_count += 1;
                    bucket.focus_seconds += actual_duration.max(0);
                }
                "interrupted" => {
                    bucket.interrupted_count += 1;
                    bucket.focus_seconds += actual_duration.max(0);
                }
                _ => {}
            }
        }

        Ok(buckets)
    }

    /// 列出今日的所有番茄钟记录
    pub fn list_today_records(db: &VfsDatabase) -> VfsResult<Vec<PomodoroRecord>> {
        let conn = db.get_conn_safe()?;
        let today_start = Self::local_day_start_utc();

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
