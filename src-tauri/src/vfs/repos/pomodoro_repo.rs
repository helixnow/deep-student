//! 番茄钟记录 Repo
//!
//! 提供 pomodoro_records 表的 CRUD 操作。

use log::{error, info, warn};
use rusqlite::{params, OptionalExtension};

use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};
use crate::vfs::types::{
    CreatePomodoroRecordParams, PomodoroDailyStat, PomodoroHourlyStat, PomodoroRecord,
    PomodoroStreakStats, PomodoroTodayStats, PomodoroTodoStat,
};

const VALID_POMODORO_TYPES: &[&str] = &["work", "short_break", "long_break"];
const VALID_POMODORO_STATUSES: &[&str] = &["completed", "interrupted"];

/// 统计标量查询失败时回退默认值（0），保持今日统计命令可用。
///
/// 契约限制：`pomodoro_today_stats` 返回纯数值结构，无法在不破坏
/// 现有前端契约的前提下携带"部分失败"信号，故此处以 error 级日志
/// （含查询名上下文 + 底层错误）作为唯一可观测通道，方便事后从
/// 日志定位 schema 漂移 / 数据损坏问题。
fn stat_or_warn<T: Default>(ctx: &str, r: Result<T, rusqlite::Error>) -> T {
    match r {
        Ok(v) => v,
        Err(e) => {
            error!(
                "[VFS::PomodoroRepo] Stats scalar query '{}' failed, returning default(0); \
                 result may under-report and mask DB corruption or schema drift: {}",
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

// ============================================================================
// 统计聚合返回类型（2026-07-20 新增命令契约，camelCase 序列化；
// 详见 .parallel-notes/backend.md）
// ============================================================================

/// 番茄钟周聚合桶（周一为一周起点；`week_start` 为该周周一的本地日期）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PomodoroWeeklyStat {
    /// 本地日期（YYYY-MM-DD，该周周一）
    pub week_start: String,
    /// 该周完成的工作番茄数
    pub completed_count: usize,
    /// 该周专注时长（秒，completed + interrupted 的 actual_duration）
    pub focus_seconds: i64,
    /// 该周中断次数
    pub interrupted_count: usize,
    /// 该周内有专注活动（完成数或专注秒数 > 0）的天数
    pub active_days: usize,
}

/// 番茄钟统计总览（`pomodoro_stats_overview` 命令返回，一次查询拿全）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PomodoroStatsOverview {
    pub today: PomodoroTodayStats,
    pub streak: PomodoroStreakStats,
    /// 近 N 天按日聚合（升序，无数据天补零，与 pomodoro_daily_stats 同口径）
    pub daily: Vec<PomodoroDailyStat>,
    /// 由 daily 按周（周一起点）汇总，升序；首尾周可能不满 7 天
    pub weekly: Vec<PomodoroWeeklyStat>,
}

/// 某任务专注历史的单日桶（仅返回有记录的天，升序）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PomodoroFocusDay {
    /// 本地日期（YYYY-MM-DD）
    pub date: String,
    pub focus_seconds: i64,
    pub completed_count: i64,
    pub interrupted_count: i64,
}

/// 某任务的专注历史聚合（`pomodoro_todo_focus_summary` 命令返回）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PomodoroTodoFocusSummary {
    pub todo_item_id: String,
    /// 任务标题（软删任务仍返回；任务行已物理删除时为 None）
    pub todo_title: Option<String>,
    /// 累计专注时长（秒，work 类型 completed + interrupted 的 actual_duration）
    pub total_focus_seconds: i64,
    /// 累计完成工作番茄数
    pub completed_count: i64,
    /// 累计中断次数
    pub interrupted_count: i64,
    /// 最早一次专注的 start_time（无记录为 None）
    pub first_focus_at: Option<String>,
    /// 最近一次专注的 start_time
    pub last_focus_at: Option<String>,
    /// 按本地日聚合的专注历史（仅有记录的天，升序）
    pub daily: Vec<PomodoroFocusDay>,
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

            // TD-02：completed_pomodoros 是 pomodoro_records 事实表的派生缓存。
            // 本地路径不再做 +1 增量（增量在双设备同步下无法收敛），而是在
            // 同一 SAVEPOINT 内按事实表口径重算，保证原子且幂等。
            if let Some(ref item_id) = params.todo_item_id {
                if params.status == "completed" && params.r#type == "work" {
                    Self::recount_completed_pomodoros_cache(&conn, item_id, &now)?;
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
    /// - 若该记录是已完成的 work 番茄且关联了任务，按事实表重算对应
    ///   `todo_items.completed_pomodoros` 派生缓存（TD-02，与 create_record 对称；
    ///   重算天然不会为负、也不会被旧值复活）
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

            // 回退联动：与 create_record 对称——按事实表重算派生缓存
            // （软删行已退出计数口径，天然不会为负，也不会被旧值复活）
            if let Some(ref item_id) = todo_item_id {
                if status == "completed" && r#type == "work" {
                    Self::recount_completed_pomodoros_cache(&conn, item_id, &now)?;
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

    /// 按事实表重算某任务的 `completed_pomodoros` 派生缓存（TD-02）。
    ///
    /// `todo_items.completed_pomodoros` **仅是派生缓存**，事实来源是
    /// `pomodoro_records`；口径 = 未软删 + `type='work'` + `status='completed'`
    /// 的记录数（与 data_governance::sync::pomodoro_counts 的同步侧重算一致）。
    ///
    /// - 幂等：同一状态多次执行结果相同；值未变化时不写行（`IS NOT` guard），
    ///   避免无谓的 `updated_at` / `local_version` / change_log 噪声
    /// - 在调用方的 SAVEPOINT 内执行，与记录写入保持原子
    /// - 只更新未软删的 todo（与旧联动行为一致）；软删 todo 的缓存由
    ///   同步侧重算兜底
    fn recount_completed_pomodoros_cache(
        conn: &rusqlite::Connection,
        todo_item_id: &str,
        now: &str,
    ) -> VfsResult<()> {
        conn.execute(
            r#"
            UPDATE todo_items
            SET completed_pomodoros = (
                    SELECT COUNT(*) FROM pomodoro_records
                    WHERE todo_item_id = todo_items.id
                      AND deleted_at IS NULL
                      AND type = 'work'
                      AND status = 'completed'
                ),
                updated_at = ?1,
                local_version = COALESCE(local_version, 0) + 1
            WHERE id = ?2
              AND deleted_at IS NULL
              AND completed_pomodoros IS NOT (
                    SELECT COUNT(*) FROM pomodoro_records
                    WHERE todo_item_id = todo_items.id
                      AND deleted_at IS NULL
                      AND type = 'work'
                      AND status = 'completed'
                )
            "#,
            params![now, todo_item_id],
        )?;
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

    /// 本地"今天 00:00"对应的 UTC 时间戳字符串（与 created_at 同格式，可直接字符串比较）。
    ///
    /// DST 歧义/缺口时刻统一由 `local_date_start_utc` 兜底，
    /// 保证 today_stats / list_today / daily_stats 三个入口日界口径一致。
    fn local_day_start_utc() -> VfsResult<String> {
        Self::local_date_start_utc(chrono::Local::now().date_naive())
    }

    /// 获取今日统计
    ///
    /// `total_focus_seconds` 与 `get_daily_stats` 的 `focus_seconds` 口径一致：
    /// 累加 completed + interrupted 的 `actual_duration`（中断会话的实际专注
    /// 也是专注）；严格口径（仅 completed）通过 `completed_focus_seconds` 提供。
    pub fn get_today_stats(db: &VfsDatabase) -> VfsResult<PomodoroTodayStats> {
        let conn = db.get_conn_safe()?;
        let today_start = Self::local_day_start_utc()?;

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
                SELECT COALESCE(SUM(MAX(actual_duration, 0)), 0) FROM pomodoro_records
                WHERE type = 'work' AND status IN ('completed', 'interrupted')
                  AND created_at >= ?1 AND deleted_at IS NULL
                "#,
                params![today_start],
                |row| row.get(0),
            ),
        );

        let completed_focus_seconds: i64 = stat_or_warn(
            "today_completed_focus_seconds",
            conn.query_row(
                r#"
                SELECT COALESCE(SUM(MAX(actual_duration, 0)), 0) FROM pomodoro_records
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
            completed_focus_seconds,
        })
    }

    /// 近 N 天（含今天）的按日聚合统计，按本地日期分桶。
    ///
    /// 仅统计 work 类型：completed 计入完成数；focus_seconds 累加
    /// completed 与 interrupted 的 actual_duration（真实专注时间）。
    /// 返回完整日期序列（无记录的天补零），升序排列。
    pub fn get_daily_stats(db: &VfsDatabase, days: u32) -> VfsResult<Vec<PomodoroDailyStat>> {
        use chrono::{DateTime, Duration};

        let days = days.clamp(1, 366) as i64;
        let today = chrono::Local::now().date_naive();
        let range_start_local = today - Duration::days(days - 1);
        // 本地起始日 00:00 对应的 UTC 时间戳（与 created_at 同格式，可直接字符串比较），
        // DST 歧义/缺口由 local_date_start_utc 统一兜底
        let range_start_utc = Self::local_date_start_utc(range_start_local)?;

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
        let today_start = Self::local_day_start_utc()?;

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
    /// 所有按本地日分桶的入口（today_stats / list_today / daily_stats /
    /// list_range / hourly_stats / stats_by_todo）统一走此函数，DST 边界处理：
    /// - 歧义（秋季回拨，本地 00:00 出现两次）：取 earliest，当日覆盖重复时段
    /// - 缺口（春季前拨恰好跨过本地午夜，如部分南美/中东时区）：向后逐小时
    ///   探测当日第一个有效本地时刻作为日界，而不是错误地退回 UTC 午夜
    fn local_date_start_utc(date: chrono::NaiveDate) -> VfsResult<String> {
        use chrono::{Duration, LocalResult, TimeZone};

        let invalid = || VfsError::InvalidArgument {
            param: "date".to_string(),
            reason: format!("Cannot resolve local midnight for date '{}'", date),
        };

        let naive = date.and_hms_opt(0, 0, 0).ok_or_else(invalid)?;
        let local_dt = match chrono::Local.from_local_datetime(&naive) {
            LocalResult::Single(dt) => dt,
            LocalResult::Ambiguous(earliest, _) => earliest,
            LocalResult::None => (1..=3)
                .find_map(|h| {
                    naive
                        .checked_add_signed(Duration::hours(h))
                        .and_then(|probe| chrono::Local.from_local_datetime(&probe).earliest())
                })
                .ok_or_else(invalid)?,
        };
        Ok(local_dt
            .with_timezone(&chrono::Utc)
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string())
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

    /// 连续专注天数统计（按本地日聚合 completed work 记录）。
    ///
    /// - `current_streak_days`：以今天为锚点向前数连续「有 ≥1 个完成番茄」的
    ///   天数；今天还没有记录时以昨天为锚点（当天尚未打卡不打断连续）
    /// - `longest_streak_days`：历史最长连续天数
    /// - 分桶时间戳与 `get_daily_stats` 一致，使用 `created_at` 转本地日
    pub fn get_streak_stats(db: &VfsDatabase) -> VfsResult<PomodoroStreakStats> {
        use chrono::DateTime;
        use std::collections::BTreeSet;

        let conn = db.get_conn_safe()?;
        let mut stmt = conn.prepare(
            r#"
            SELECT created_at FROM pomodoro_records
            WHERE type = 'work' AND status = 'completed' AND deleted_at IS NULL
            "#,
        )?;
        let timestamps: Vec<String> = stmt
            .query_map([], |row| row.get(0))?
            .filter_map(log_and_skip_err)
            .collect();

        let mut active_days: BTreeSet<chrono::NaiveDate> = BTreeSet::new();
        for created_at in timestamps {
            match DateTime::parse_from_rfc3339(&created_at) {
                Ok(dt) => {
                    active_days.insert(dt.with_timezone(&chrono::Local).date_naive());
                }
                Err(e) => {
                    warn!(
                        "[VFS::PomodoroRepo] Skipping record with non-RFC3339 created_at '{}' in streak stats: {}",
                        created_at, e
                    );
                }
            }
        }

        // 最长连续：BTreeSet 已升序，扫一遍统计相邻天的最长游程
        let mut longest_streak_days: i64 = 0;
        let mut run: i64 = 0;
        let mut prev: Option<chrono::NaiveDate> = None;
        for day in &active_days {
            run = match prev {
                Some(p) if (*day - p).num_days() == 1 => run + 1,
                _ => 1,
            };
            longest_streak_days = longest_streak_days.max(run);
            prev = Some(*day);
        }

        // 当前连续：锚点取今天（有记录）或昨天（今天尚无记录），向前回溯
        let today = chrono::Local::now().date_naive();
        let anchor = if active_days.contains(&today) {
            Some(today)
        } else {
            today.pred_opt().filter(|d| active_days.contains(d))
        };
        let mut current_streak_days: i64 = 0;
        let mut cursor = anchor;
        while let Some(day) = cursor {
            if !active_days.contains(&day) {
                break;
            }
            current_streak_days += 1;
            cursor = day.pred_opt();
        }

        Ok(PomodoroStreakStats {
            current_streak_days,
            longest_streak_days,
        })
    }

    /// 近 N 天（含今天）work 记录按「本地小时」分桶的聚合，看一天中何时专注。
    ///
    /// - 分桶依据 `start_time`（会话开始时刻）转本地小时，0-23 全量补零
    /// - `completed_count` 仅计 completed；`focus_seconds` 累加
    ///   completed + interrupted 的 actual_duration（与 daily/today 口径一致）
    /// - 时间窗口按 `created_at >= 本地起始日 00:00`（走 created_at 索引，
    ///   与 get_daily_stats 的窗口口径一致）
    pub fn get_hourly_stats(db: &VfsDatabase, days: u32) -> VfsResult<Vec<PomodoroHourlyStat>> {
        use chrono::{DateTime, Duration, Timelike};

        let days = days.clamp(1, 366) as i64;
        let today = chrono::Local::now().date_naive();
        let range_start_utc = Self::local_date_start_utc(today - Duration::days(days - 1))?;

        let conn = db.get_conn_safe()?;
        let mut stmt = conn.prepare(
            r#"
            SELECT start_time, status, actual_duration
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

        let mut buckets: Vec<PomodoroHourlyStat> = (0u8..24)
            .map(|hour| PomodoroHourlyStat {
                hour,
                completed_count: 0,
                focus_seconds: 0,
            })
            .collect();

        for (start_time, status, actual_duration) in rows {
            let hour = match DateTime::parse_from_rfc3339(&start_time) {
                // Timelike::hour() 恒为 0-23，直接下标安全
                Ok(dt) => dt.with_timezone(&chrono::Local).hour() as usize,
                Err(e) => {
                    warn!(
                        "[VFS::PomodoroRepo] Skipping record with non-RFC3339 start_time '{}' in hourly stats: {}",
                        start_time, e
                    );
                    continue;
                }
            };
            let bucket = &mut buckets[hour];
            match status.as_str() {
                "completed" => {
                    bucket.completed_count += 1;
                    bucket.focus_seconds += actual_duration.max(0);
                }
                "interrupted" => {
                    bucket.focus_seconds += actual_duration.max(0);
                }
                _ => {}
            }
        }

        Ok(buckets)
    }

    /// 按任务聚合的番茄统计（专注时长排行，JOIN todo_items 取标题）。
    ///
    /// - 日期参数 `YYYY-MM-DD` 按本地日闭区间解释（与 list_range 口径一致），
    ///   任一侧缺省则该侧不限
    /// - LEFT JOIN 不过滤 todo_items.deleted_at：软删任务标题仍返回；
    ///   任务行已物理删除（ON DELETE SET NULL 前的历史数据）时标题为 None
    /// - 仅统计关联了任务的 work 记录，按 focus_seconds DESC 排序
    pub fn get_stats_by_todo(
        db: &VfsDatabase,
        start_date: Option<&str>,
        end_date: Option<&str>,
        limit: u32,
    ) -> VfsResult<Vec<PomodoroTodoStat>> {
        use chrono::{Duration, NaiveDate};

        let parse_date = |param: &str, value: &str| -> VfsResult<NaiveDate> {
            NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|e| VfsError::InvalidArgument {
                param: param.to_string(),
                reason: format!("Expected YYYY-MM-DD, got '{}': {}", value, e),
            })
        };
        let start = start_date
            .map(|s| parse_date("start_date", s))
            .transpose()?;
        let end = end_date.map(|s| parse_date("end_date", s)).transpose()?;
        if let (Some(s), Some(e)) = (start, end) {
            if s > e {
                return Err(VfsError::InvalidArgument {
                    param: "start_date".to_string(),
                    reason: format!("start_date '{}' must be <= end_date '{}'", s, e),
                });
            }
        }

        // 缺省侧使用哨兵边界（ISO 时间戳字符串序下恒真），保持 SQL 静态三参数
        let range_start_utc = match start {
            Some(d) => Self::local_date_start_utc(d)?,
            None => "0000-01-01T00:00:00.000Z".to_string(),
        };
        let range_end_utc = match end {
            // 闭区间：上界取 end 次日本地 00:00（半开上界）
            Some(d) => Self::local_date_start_utc(d + Duration::days(1))?,
            None => "9999-12-31T23:59:59.999Z".to_string(),
        };
        let limit = limit.max(1) as i64;

        let conn = db.get_conn_safe()?;
        let mut stmt = conn.prepare(
            r#"
            SELECT p.todo_item_id,
                   t.title,
                   SUM(CASE WHEN p.status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
                   COALESCE(SUM(MAX(p.actual_duration, 0)), 0) AS focus_seconds
            FROM pomodoro_records p
            LEFT JOIN todo_items t ON t.id = p.todo_item_id
            WHERE p.type = 'work'
              AND p.status IN ('completed', 'interrupted')
              AND p.todo_item_id IS NOT NULL
              AND p.deleted_at IS NULL
              AND p.created_at >= ?1 AND p.created_at < ?2
            GROUP BY p.todo_item_id
            ORDER BY focus_seconds DESC, completed_count DESC, p.todo_item_id ASC
            LIMIT ?3
            "#,
        )?;
        let rows = stmt.query_map(params![range_start_utc, range_end_utc, limit], |row| {
            Ok(PomodoroTodoStat {
                todo_item_id: row.get(0)?,
                todo_title: row.get(1)?,
                completed_count: row.get(2)?,
                focus_seconds: row.get(3)?,
            })
        })?;
        Ok(rows.filter_map(log_and_skip_err).collect())
    }

    /// 统计总览：今日 + streak + 近 N 天按日/按周聚合，一次调用拿全
    /// （2026-07-20 新增；weekly 由 daily 派生，四块口径彼此一致）。
    pub fn get_stats_overview(db: &VfsDatabase, days: u32) -> VfsResult<PomodoroStatsOverview> {
        let daily = Self::get_daily_stats(db, days)?;
        let weekly = Self::weekly_from_daily(&daily);
        Ok(PomodoroStatsOverview {
            today: Self::get_today_stats(db)?,
            streak: Self::get_streak_stats(db)?,
            daily,
            weekly,
        })
    }

    /// 把按日聚合汇总成按周聚合（周一为一周起点）。
    /// `daily` 升序输入 → 输出按周升序；范围边缘的周可能不满 7 天。
    fn weekly_from_daily(daily: &[PomodoroDailyStat]) -> Vec<PomodoroWeeklyStat> {
        use chrono::{Datelike, Days, NaiveDate};
        use std::collections::BTreeMap;

        let mut weeks: Vec<PomodoroWeeklyStat> = Vec::new();
        let mut index_by_start: BTreeMap<NaiveDate, usize> = BTreeMap::new();
        for day in daily {
            let date = match NaiveDate::parse_from_str(&day.date, "%Y-%m-%d") {
                Ok(d) => d,
                Err(e) => {
                    warn!(
                        "[VFS::PomodoroRepo] Skipping malformed daily bucket date '{}' in weekly stats: {}",
                        day.date, e
                    );
                    continue;
                }
            };
            let offset = date.weekday().num_days_from_monday() as u64;
            let week_start = date.checked_sub_days(Days::new(offset)).unwrap_or(date);
            let idx = *index_by_start.entry(week_start).or_insert_with(|| {
                weeks.push(PomodoroWeeklyStat {
                    week_start: week_start.format("%Y-%m-%d").to_string(),
                    completed_count: 0,
                    focus_seconds: 0,
                    interrupted_count: 0,
                    active_days: 0,
                });
                weeks.len() - 1
            });
            let week = &mut weeks[idx];
            week.completed_count += day.completed_count;
            week.focus_seconds += day.focus_seconds;
            week.interrupted_count += day.interrupted_count;
            if day.completed_count > 0 || day.focus_seconds > 0 {
                week.active_days += 1;
            }
        }
        weeks
    }

    /// 某任务的专注历史聚合（2026-07-20 新增）。
    ///
    /// - 仅统计 work 类型记录；总量口径与 get_stats_by_todo 一致
    ///   （focus = completed + interrupted 的 actual_duration）
    /// - 任务不存在（含从未存在）时不报错：todo_title 为 None、各计数为 0，
    ///   便于前端对历史悬挂引用做降级展示
    /// - daily 按 created_at 转本地日分桶（与 get_daily_stats 口径一致），
    ///   仅返回有记录的天
    pub fn get_todo_focus_summary(
        db: &VfsDatabase,
        todo_item_id: &str,
    ) -> VfsResult<PomodoroTodoFocusSummary> {
        use chrono::DateTime;
        use std::collections::BTreeMap;

        let conn = db.get_conn_safe()?;

        // 软删任务标题仍返回（与 get_stats_by_todo 的 LEFT JOIN 行为一致）
        let todo_title: Option<String> = conn
            .query_row(
                "SELECT title FROM todo_items WHERE id = ?1",
                params![todo_item_id],
                |row| row.get(0),
            )
            .optional()?;

        let (
            total_focus_seconds,
            completed_count,
            interrupted_count,
            first_focus_at,
            last_focus_at,
        ): (i64, i64, i64, Option<String>, Option<String>) = conn.query_row(
            r#"
            SELECT COALESCE(SUM(MAX(actual_duration, 0)), 0),
                   COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN status = 'interrupted' THEN 1 ELSE 0 END), 0),
                   MIN(start_time),
                   MAX(start_time)
            FROM pomodoro_records
            WHERE todo_item_id = ?1 AND type = 'work'
              AND status IN ('completed', 'interrupted')
              AND deleted_at IS NULL
            "#,
            params![todo_item_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )?;

        let mut stmt = conn.prepare(
            r#"
            SELECT created_at, status, actual_duration
            FROM pomodoro_records
            WHERE todo_item_id = ?1 AND type = 'work'
              AND status IN ('completed', 'interrupted')
              AND deleted_at IS NULL
            "#,
        )?;
        let rows: Vec<(String, String, i64)> = stmt
            .query_map(params![todo_item_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?
            .filter_map(log_and_skip_err)
            .collect();

        // (focus_seconds, completed, interrupted) 按本地日聚合，BTreeMap 保证升序
        let mut buckets: BTreeMap<chrono::NaiveDate, (i64, i64, i64)> = BTreeMap::new();
        for (created_at, status, actual_duration) in rows {
            let local_date = match DateTime::parse_from_rfc3339(&created_at) {
                Ok(dt) => dt.with_timezone(&chrono::Local).date_naive(),
                Err(e) => {
                    warn!(
                        "[VFS::PomodoroRepo] Skipping record with non-RFC3339 created_at '{}' in focus summary: {}",
                        created_at, e
                    );
                    continue;
                }
            };
            let entry = buckets.entry(local_date).or_insert((0, 0, 0));
            entry.0 += actual_duration.max(0);
            match status.as_str() {
                "completed" => entry.1 += 1,
                "interrupted" => entry.2 += 1,
                _ => {}
            }
        }
        let daily: Vec<PomodoroFocusDay> = buckets
            .into_iter()
            .map(|(date, (focus, completed, interrupted))| PomodoroFocusDay {
                date: date.format("%Y-%m-%d").to_string(),
                focus_seconds: focus,
                completed_count: completed,
                interrupted_count: interrupted,
            })
            .collect();

        Ok(PomodoroTodoFocusSummary {
            todo_item_id: todo_item_id.to_string(),
            todo_title,
            total_focus_seconds,
            completed_count,
            interrupted_count,
            first_focus_at,
            last_focus_at,
            daily,
        })
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

        assert_eq!(
            record.updated_at.as_deref(),
            Some(record.created_at.as_str())
        );
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
    fn td02_create_and_delete_recount_tracks_fact_table() {
        // TD-02：completed_pomodoros 是派生缓存，本地 create/delete 走事实表重算
        let (_tmp, db) = setup_test_db();
        let item = create_item(&db);

        let r1 = VfsPomodoroRepo::create_record(
            &db,
            record_params(Some(item.id.clone()), "work", "completed"),
        )
        .unwrap();
        let r2 = VfsPomodoroRepo::create_record(
            &db,
            record_params(Some(item.id.clone()), "work", "completed"),
        )
        .unwrap();
        assert_eq!(completed_pomodoros(&db, &item.id), 2);

        VfsPomodoroRepo::delete_record(&db, &r1.id).unwrap();
        assert_eq!(completed_pomodoros(&db, &item.id), 1);
        VfsPomodoroRepo::delete_record(&db, &r2.id).unwrap();
        assert_eq!(completed_pomodoros(&db, &item.id), 0);
    }

    #[test]
    fn td02_create_record_recount_heals_drifted_cache() {
        // 历史漂移（旧 ±1 债务遗留的错误缓存值）在下一次重算时被归正，
        // 而不是在错误基数上继续 ±1
        let (_tmp, db) = setup_test_db();
        let item = create_item(&db);

        VfsPomodoroRepo::create_record(
            &db,
            record_params(Some(item.id.clone()), "work", "completed"),
        )
        .unwrap();
        assert_eq!(completed_pomodoros(&db, &item.id), 1);

        // 人为制造虚高漂移
        {
            let conn = db.get_conn_safe().unwrap();
            conn.execute(
                "UPDATE todo_items SET completed_pomodoros = 99 WHERE id = ?1",
                params![item.id],
            )
            .unwrap();
        }

        VfsPomodoroRepo::create_record(
            &db,
            record_params(Some(item.id.clone()), "work", "completed"),
        )
        .unwrap();
        assert_eq!(
            completed_pomodoros(&db, &item.id),
            2,
            "重算必须以 pomodoro_records 事实表为准，而不是 99+1"
        );
    }

    #[test]
    fn td02_recount_is_idempotent_and_skips_noop_writes() {
        let (_tmp, db) = setup_test_db();
        let item = create_item(&db);
        VfsPomodoroRepo::create_record(
            &db,
            record_params(Some(item.id.clone()), "work", "completed"),
        )
        .unwrap();

        let conn = db.get_conn_safe().unwrap();
        let version_before: i64 = conn
            .query_row(
                "SELECT COALESCE(local_version, 0) FROM todo_items WHERE id = ?1",
                params![item.id],
                |row| row.get(0),
            )
            .unwrap();

        // 值未变化时重算是纯 no-op：不 bump local_version / updated_at
        VfsPomodoroRepo::recount_completed_pomodoros_cache(
            &conn,
            &item.id,
            "2026-07-19T09:00:00.000Z",
        )
        .unwrap();
        VfsPomodoroRepo::recount_completed_pomodoros_cache(
            &conn,
            &item.id,
            "2026-07-19T09:00:01.000Z",
        )
        .unwrap();

        let (count, version_after): (i32, i64) = conn
            .query_row(
                "SELECT COALESCE(completed_pomodoros, -1), COALESCE(local_version, 0)
                 FROM todo_items WHERE id = ?1",
                params![item.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(
            version_after, version_before,
            "幂等重算不得产生 local_version 噪声"
        );
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
