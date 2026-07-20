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

/// 统计标量查询失败时记 warn 后回退默认值（0），避免静默吞错。
fn stat_or_warn<T: Default>(ctx: &str, r: Result<T, rusqlite::Error>) -> T {
    match r {
        Ok(v) => v,
        Err(e) => {
            warn!(
                "[VFS::PomodoroRepo] Stats query '{}' failed, falling back to 0: {}",
                ctx, e
            );
            T::default()
        }
    }
}

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
    /// `updated_at` 与 `created_at` 同值写入，pomodoro_records 参与
    /// 云同步 LWW 比较，缺失 updated_at 会导致增量同步漏推该行。
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
                INSERT INTO pomodoro_records (id, todo_item_id, start_time, end_time, duration, actual_duration, type, status, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
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
            created_at: now.clone(),
            updated_at: Some(now),
            deleted_at: None,
        })
    }

    /// 软删除番茄钟记录
    ///
    /// - `deleted_at` 置为 UTC 时间戳，并同步推进 `updated_at` / `local_version`
    ///   （pomodoro_records 走 LWW，同步端以 updated_at 判定删除事件先后）
    /// - 若该记录是已完成的 work 番茄且关联了任务，回退对应
    ///   `todo_items.completed_pomodoros`（与 create_record 的自增联动对称），
    ///   使用 saturating 语义避免出现负数
    /// - SAVEPOINT 保证两步原子
    pub fn delete_record(db: &VfsDatabase, record_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        conn.execute("SAVEPOINT pomodoro_delete", [])?;

        let result = (|| -> VfsResult<()> {
            // 先读出待删记录（仅未删行），用于判断是否需要回退 completed_pomodoros
            let target: Option<(Option<String>, String, String)> = conn
                .query_row(
                    r#"
                    SELECT todo_item_id, type, status
                    FROM pomodoro_records
                    WHERE id = ?1 AND deleted_at IS NULL
                    "#,
                    params![record_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;

            let (todo_item_id, r#type, status) = match target {
                Some(v) => v,
                None => {
                    return Err(VfsError::NotFound {
                        resource_type: "PomodoroRecord".to_string(),
                        id: record_id.to_string(),
                    });
                }
            };

            conn.execute(
                r#"
                UPDATE pomodoro_records
                SET deleted_at = ?1,
                    updated_at = ?1,
                    local_version = COALESCE(local_version, 0) + 1
                WHERE id = ?2 AND deleted_at IS NULL
                "#,
                params![now, record_id],
            )?;

            // 回退联动：与 create_record 的 work+completed 自增对称
            if let Some(ref item_id) = todo_item_id {
                if status == "completed" && r#type == "work" {
                    conn.execute(
                        r#"
                        UPDATE todo_items
                        SET completed_pomodoros = MAX(COALESCE(completed_pomodoros, 0) - 1, 0),
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
                conn.execute("RELEASE SAVEPOINT pomodoro_delete", [])?;
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK TO SAVEPOINT pomodoro_delete", []);
                let _ = conn.execute("RELEASE SAVEPOINT pomodoro_delete", []);
                return Err(e);
            }
        }

        info!("[VFS::PomodoroRepo] Deleted pomodoro record: {}", record_id);
        Ok(())
    }

    /// 获取单条记录（排除已软删）
    pub fn get_record(db: &VfsDatabase, record_id: &str) -> VfsResult<Option<PomodoroRecord>> {
        let conn = db.get_conn_safe()?;
        let result = conn
            .query_row(
                r#"
                SELECT id, todo_item_id, start_time, end_time, duration, actual_duration, type, status, created_at, updated_at, deleted_at
                FROM pomodoro_records
                WHERE id = ?1 AND deleted_at IS NULL
                "#,
                params![record_id],
                Self::row_to_record,
            )
            .optional()?;
        Ok(result)
    }

    /// 列出某个任务关联的番茄钟记录（排除已软删）
    pub fn list_by_todo_item(
        db: &VfsDatabase,
        todo_item_id: &str,
    ) -> VfsResult<Vec<PomodoroRecord>> {
        let conn = db.get_conn_safe()?;
        let mut stmt = conn.prepare(
            r#"
            SELECT id, todo_item_id, start_time, end_time, duration, actual_duration, type, status, created_at, updated_at, deleted_at
            FROM pomodoro_records
            WHERE todo_item_id = ?1 AND deleted_at IS NULL
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

        let completed_count: usize = stat_or_warn(
            "today_completed_count",
            conn.query_row(
                r#"
                SELECT COUNT(*) FROM pomodoro_records
                WHERE type = 'work' AND status = 'completed' AND created_at >= ?1
                  AND deleted_at IS NULL
                "#,
                params![today_start],
                |row| row.get(0),
            ),
        );

        let total_focus_seconds: i64 = stat_or_warn(
            "today_total_focus_seconds",
            conn.query_row(
                r#"
                SELECT COALESCE(SUM(actual_duration), 0) FROM pomodoro_records
                WHERE type = 'work' AND status = 'completed' AND created_at >= ?1
                  AND deleted_at IS NULL
                "#,
                params![today_start],
                |row| row.get(0),
            ),
        );

        let interrupted_count: usize = stat_or_warn(
            "today_interrupted_count",
            conn.query_row(
                r#"
                SELECT COUNT(*) FROM pomodoro_records
                WHERE type = 'work' AND status = 'interrupted' AND created_at >= ?1
                  AND deleted_at IS NULL
                "#,
                params![today_start],
                |row| row.get(0),
            ),
        );

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
            WHERE type = 'work' AND created_at >= ?1 AND deleted_at IS NULL
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
            // UTC 时间戳 → 本地日期分桶；无法解析的脏数据跳过，
            // 不能落到 today 桶（会污染今日统计）
            let local_date = match DateTime::parse_from_rfc3339(&created_at) {
                Ok(dt) => dt.with_timezone(&chrono::Local).date_naive(),
                Err(e) => {
                    warn!(
                        "[VFS::PomodoroRepo] Skipping record with non-RFC3339 created_at '{}' in daily stats: {}",
                        created_at, e
                    );
                    continue;
                }
            };
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

    /// 列出今日的所有番茄钟记录（排除已软删）
    pub fn list_today_records(db: &VfsDatabase) -> VfsResult<Vec<PomodoroRecord>> {
        let conn = db.get_conn_safe()?;
        let today_start = Self::local_day_start_utc();

        let mut stmt = conn.prepare(
            r#"
            SELECT id, todo_item_id, start_time, end_time, duration, actual_duration, type, status, created_at, updated_at, deleted_at
            FROM pomodoro_records
            WHERE created_at >= ?1 AND deleted_at IS NULL
            ORDER BY created_at DESC
            "#,
        )?;
        let rows = stmt.query_map(params![today_start], Self::row_to_record)?;
        Ok(rows.filter_map(log_and_skip_err).collect())
    }

    /// 本地日历日（YYYY-MM-DD）00:00 对应的 UTC 时间戳字符串。
    ///
    /// 与 `local_day_start_utc` / `get_daily_stats` 的本地日界口径一致。
    fn local_date_start_utc(date: chrono::NaiveDate) -> VfsResult<String> {
        use chrono::TimeZone;
        date.and_hms_opt(0, 0, 0)
            .and_then(|naive| chrono::Local.from_local_datetime(&naive).single())
            .map(|dt| {
                dt.with_timezone(&chrono::Utc)
                    .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                    .to_string()
            })
            .ok_or_else(|| VfsError::InvalidArgument {
                param: "date".to_string(),
                reason: format!("Cannot resolve local midnight for date '{}'", date),
            })
    }

    /// 按本地日历日闭区间 [start_date, end_date] 列出番茄钟记录。
    ///
    /// - 日期格式 `YYYY-MM-DD`，按本地时区解释（与 get_daily_stats 分桶口径一致）
    /// - 闭区间：查询范围为 `[start 当日 00:00, end 次日 00:00)`
    /// - 排除已软删，按 created_at DESC 排序
    pub fn list_range(
        db: &VfsDatabase,
        start_date: &str,
        end_date: &str,
    ) -> VfsResult<Vec<PomodoroRecord>> {
        use chrono::{Duration, NaiveDate};

        let start = NaiveDate::parse_from_str(start_date, "%Y-%m-%d").map_err(|e| {
            VfsError::InvalidArgument {
                param: "start_date".to_string(),
                reason: format!("Expected YYYY-MM-DD, got '{}': {}", start_date, e),
            }
        })?;
        let end = NaiveDate::parse_from_str(end_date, "%Y-%m-%d").map_err(|e| {
            VfsError::InvalidArgument {
                param: "end_date".to_string(),
                reason: format!("Expected YYYY-MM-DD, got '{}': {}", end_date, e),
            }
        })?;
        if start > end {
            return Err(VfsError::InvalidArgument {
                param: "start_date".to_string(),
                reason: format!(
                    "start_date '{}' must be <= end_date '{}'",
                    start_date, end_date
                ),
            });
        }

        let range_start_utc = Self::local_date_start_utc(start)?;
        // 闭区间：上界取 end 次日的本地 00:00（半开上界）
        let range_end_utc = Self::local_date_start_utc(end + Duration::days(1))?;

        let conn = db.get_conn_safe()?;
        let mut stmt = conn.prepare(
            r#"
            SELECT id, todo_item_id, start_time, end_time, duration, actual_duration, type, status, created_at, updated_at, deleted_at
            FROM pomodoro_records
            WHERE created_at >= ?1 AND created_at < ?2 AND deleted_at IS NULL
            ORDER BY created_at DESC
            "#,
        )?;
        let rows = stmt.query_map(params![range_start_utc, range_end_utc], Self::row_to_record)?;
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
            updated_at: row.get(9)?,
            deleted_at: row.get(10)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vfs::repos::VfsTodoRepo;
    use crate::vfs::types::{VfsCreateTodoItemParams, VfsCreateTodoListParams, VfsTodoItem};
    use tempfile::TempDir;

    fn setup_test_db() -> (TempDir, VfsDatabase) {
        crate::vfs::database::setup_migrated_test_db()
    }

    fn create_item(db: &VfsDatabase) -> VfsTodoItem {
        let list = VfsTodoRepo::create_todo_list(
            db,
            VfsCreateTodoListParams {
                title: "pomodoro test list".to_string(),
                description: None,
                icon: None,
                color: None,
                is_default: false,
            },
        )
        .expect("create todo list");
        VfsTodoRepo::create_todo_item(
            db,
            VfsCreateTodoItemParams {
                todo_list_id: list.id,
                title: "pomodoro test item".to_string(),
                description: None,
                priority: "none".to_string(),
                due_date: None,
                due_time: None,
                reminder: None,
                tags: None,
                parent_id: None,
                attachments: None,
                repeat_json: None,
            },
        )
        .expect("create todo item")
    }

    fn record_params(
        todo_item_id: Option<String>,
        r#type: &str,
        status: &str,
    ) -> CreatePomodoroRecordParams {
        CreatePomodoroRecordParams {
            todo_item_id,
            start_time: "2026-07-19T01:00:00.000Z".to_string(),
            end_time: Some("2026-07-19T01:25:00.000Z".to_string()),
            duration: 1500,
            actual_duration: 1500,
            r#type: r#type.to_string(),
            status: status.to_string(),
        }
    }

    fn completed_pomodoros(db: &VfsDatabase, item_id: &str) -> i32 {
        let conn = db.get_conn_safe().unwrap();
        conn.query_row(
            "SELECT COALESCE(completed_pomodoros, 0) FROM todo_items WHERE id = ?1",
            params![item_id],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    fn create_record_writes_updated_at_equal_to_created_at() {
        let (_tmp, db) = setup_test_db();
        let record =
            VfsPomodoroRepo::create_record(&db, record_params(None, "work", "completed")).unwrap();

        assert_eq!(record.updated_at.as_deref(), Some(record.created_at.as_str()));
        assert!(record.created_at.ends_with('Z'));

        let (updated_at, deleted_at): (Option<String>, Option<String>) = {
            let conn = db.get_conn_safe().unwrap();
            conn.query_row(
                "SELECT updated_at, deleted_at FROM pomodoro_records WHERE id = ?1",
                params![record.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
        };
        assert_eq!(updated_at.as_deref(), Some(record.created_at.as_str()));
        assert!(deleted_at.is_none());
    }

    #[test]
    fn delete_record_soft_deletes_and_rolls_back_completed_pomodoros() {
        let (_tmp, db) = setup_test_db();
        let item = create_item(&db);

        let record = VfsPomodoroRepo::create_record(
            &db,
            record_params(Some(item.id.clone()), "work", "completed"),
        )
        .unwrap();
        assert_eq!(completed_pomodoros(&db, &item.id), 1);

        VfsPomodoroRepo::delete_record(&db, &record.id).unwrap();

        // 软删后各读路径不可见，但物理行仍在
        assert!(VfsPomodoroRepo::get_record(&db, &record.id)
            .unwrap()
            .is_none());
        assert!(VfsPomodoroRepo::list_by_todo_item(&db, &item.id)
            .unwrap()
            .is_empty());
        assert!(VfsPomodoroRepo::list_today_records(&db).unwrap().is_empty());
        let stats = VfsPomodoroRepo::get_today_stats(&db).unwrap();
        assert_eq!(stats.completed_count, 0);

        let (deleted_at, local_version): (Option<String>, i64) = {
            let conn = db.get_conn_safe().unwrap();
            conn.query_row(
                "SELECT deleted_at, COALESCE(local_version, 0) FROM pomodoro_records WHERE id = ?1",
                params![record.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
        };
        assert!(deleted_at.is_some());
        assert!(local_version >= 1);

        // work+completed 联动回退
        assert_eq!(completed_pomodoros(&db, &item.id), 0);

        // 二次删除返回 NotFound
        assert!(matches!(
            VfsPomodoroRepo::delete_record(&db, &record.id),
            Err(VfsError::NotFound { .. })
        ));
    }

    #[test]
    fn delete_record_does_not_touch_counter_for_break_or_interrupted() {
        let (_tmp, db) = setup_test_db();
        let item = create_item(&db);

        let interrupted = VfsPomodoroRepo::create_record(
            &db,
            record_params(Some(item.id.clone()), "work", "interrupted"),
        )
        .unwrap();
        let short_break = VfsPomodoroRepo::create_record(
            &db,
            record_params(Some(item.id.clone()), "short_break", "completed"),
        )
        .unwrap();
        assert_eq!(completed_pomodoros(&db, &item.id), 0);

        VfsPomodoroRepo::delete_record(&db, &interrupted.id).unwrap();
        VfsPomodoroRepo::delete_record(&db, &short_break.id).unwrap();
        assert_eq!(completed_pomodoros(&db, &item.id), 0);
    }

    #[test]
    fn delete_record_counter_never_goes_negative() {
        let (_tmp, db) = setup_test_db();
        let item = create_item(&db);

        let record = VfsPomodoroRepo::create_record(
            &db,
            record_params(Some(item.id.clone()), "work", "completed"),
        )
        .unwrap();
        // 人为把计数清零，模拟历史数据不一致
        {
            let conn = db.get_conn_safe().unwrap();
            conn.execute(
                "UPDATE todo_items SET completed_pomodoros = 0 WHERE id = ?1",
                params![item.id],
            )
            .unwrap();
        }

        VfsPomodoroRepo::delete_record(&db, &record.id).unwrap();
        assert_eq!(completed_pomodoros(&db, &item.id), 0);
    }

    #[test]
    fn list_range_filters_by_local_day_and_excludes_deleted() {
        let (_tmp, db) = setup_test_db();

        let kept =
            VfsPomodoroRepo::create_record(&db, record_params(None, "work", "completed")).unwrap();
        let deleted =
            VfsPomodoroRepo::create_record(&db, record_params(None, "work", "completed")).unwrap();
        VfsPomodoroRepo::delete_record(&db, &deleted.id).unwrap();

        let today = chrono::Local::now().date_naive();
        let start = (today - chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string();
        let end = today.format("%Y-%m-%d").to_string();

        let records = VfsPomodoroRepo::list_range(&db, &start, &end).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].id, kept.id);

        // 完全落在过去的区间应为空
        let far_past = VfsPomodoroRepo::list_range(&db, "2000-01-01", "2000-01-02").unwrap();
        assert!(far_past.is_empty());
    }

    #[test]
    fn list_range_rejects_bad_input() {
        let (_tmp, db) = setup_test_db();

        assert!(matches!(
            VfsPomodoroRepo::list_range(&db, "2026/07/19", "2026-07-19"),
            Err(VfsError::InvalidArgument { .. })
        ));
        assert!(matches!(
            VfsPomodoroRepo::list_range(&db, "2026-07-20", "2026-07-19"),
            Err(VfsError::InvalidArgument { .. })
        ));
    }
}
