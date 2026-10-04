//! 学习时长（docs/dev/media-learning/README.md §3「学习时长」）
//!
//! 前端追踪器按「可见且在场」计时、按本地零点切分后，以「某天 + 秒数」批量上报；
//! 这里只做按日累加与区间查询。表 `study_time_daily`（迁移 V20261006）一天一行，
//! 属于设备本地计数（累加型计数器无法按行 LWW 合并，不参与行同步）。

use std::sync::Arc;

use chrono::{Duration, Local, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::models::AppError;
use crate::vfs::database::VfsDatabase;

/// 单次上报最多计入的秒数（前端每分钟落一次，留足补落余量）
pub const MAX_SECONDS_PER_ADD: i64 = 3_600;
/// 单日累计上限
pub const MAX_SECONDS_PER_DAY: i64 = 86_400;
/// 上报日期允许偏离「今天」的天数（跨零点补落 / 时区边界）
const DATE_TOLERANCE_DAYS: i64 = 2;
/// 区间查询最大跨度（天）
const MAX_RANGE_DAYS: i64 = 3_700;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyTimeDay {
    /// 本地日期 `YYYY-MM-DD`
    pub date: String,
    /// 当日累计秒数
    pub seconds: i64,
}

fn parse_date(field: &str, raw: &str) -> Result<NaiveDate, AppError> {
    NaiveDate::parse_from_str(raw.trim(), "%Y-%m-%d")
        .map_err(|_| AppError::validation(format!("{field} must be YYYY-MM-DD, got {raw:?}")))
}

/// 校验上报：秒数 1..=3600，日期在今天 ±2 天内
pub fn validate_add(seconds: i64, date: NaiveDate, today: NaiveDate) -> Result<(), AppError> {
    if !(1..=MAX_SECONDS_PER_ADD).contains(&seconds) {
        return Err(AppError::validation(format!(
            "seconds must be within 1..={MAX_SECONDS_PER_ADD}, got {seconds}"
        )));
    }
    if (date - today).num_days().abs() > DATE_TOLERANCE_DAYS {
        return Err(AppError::validation(format!(
            "date {date} is too far from today ({today})"
        )));
    }
    Ok(())
}

/// 按日累加（单日封顶 86400 秒），返回当日新累计
pub fn add_seconds(
    conn: &Connection,
    date: &str,
    seconds: i64,
    now_ms: i64,
) -> rusqlite::Result<StudyTimeDay> {
    conn.execute(
        "INSERT INTO study_time_daily (date, seconds, updated_at)
         VALUES (?1, MIN(?2, ?4), ?3)
         ON CONFLICT(date) DO UPDATE SET
             seconds = MIN(?4, study_time_daily.seconds + excluded.seconds),
             updated_at = excluded.updated_at",
        params![date, seconds.max(0), now_ms, MAX_SECONDS_PER_DAY],
    )?;
    let total: i64 = conn
        .query_row(
            "SELECT seconds FROM study_time_daily WHERE date = ?1",
            params![date],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(0);
    Ok(StudyTimeDay {
        date: date.to_string(),
        seconds: total,
    })
}

/// 区间 `[from, to]`（含两端）内有记录的日期，按日期升序
pub fn range(conn: &Connection, from: &str, to: &str) -> rusqlite::Result<Vec<StudyTimeDay>> {
    let mut stmt = conn.prepare(
        "SELECT date, seconds FROM study_time_daily
         WHERE date >= ?1 AND date <= ?2 AND seconds > 0
         ORDER BY date ASC",
    )?;
    let rows = stmt.query_map(params![from, to], |row| {
        Ok(StudyTimeDay {
            date: row.get(0)?,
            seconds: row.get(1)?,
        })
    })?;
    rows.collect()
}

/// 区间累计秒数（learning_overview 用）
pub fn total_seconds(conn: &Connection, from: &str, to: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COALESCE(SUM(seconds), 0) FROM study_time_daily WHERE date >= ?1 AND date <= ?2",
        params![from, to],
        |row| row.get(0),
    )
}

fn vfs_db(app: &AppHandle) -> Result<Arc<VfsDatabase>, AppError> {
    app.try_state::<Arc<VfsDatabase>>()
        .map(|state| state.inner().clone())
        .ok_or_else(|| AppError::database("VFS database is not initialized"))
}

/// 上报一段学习时长。`date` 缺省为后端本地今天（前端按本地零点切分后会显式传入）。
#[tauri::command]
pub async fn study_time_add(
    seconds: i64,
    date: Option<String>,
    app: AppHandle,
) -> Result<StudyTimeDay, AppError> {
    let today = Local::now().date_naive();
    let date = match date.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        Some(raw) => parse_date("date", raw)?,
        None => today,
    };
    validate_add(seconds, date, today)?;
    let db = vfs_db(&app)?;
    let date_key = date.format("%Y-%m-%d").to_string();
    tokio::task::spawn_blocking(move || {
        let conn = db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        add_seconds(
            &conn,
            &date_key,
            seconds,
            chrono::Utc::now().timestamp_millis(),
        )
        .map_err(|e| AppError::database(format!("study_time_add failed: {e}")))
    })
    .await
    .map_err(|e| AppError::internal(format!("study_time_add join error: {e}")))?
}

/// 查询 `[from, to]`（`YYYY-MM-DD`，含两端）的每日学习时长；无记录的日期不返回。
#[tauri::command]
pub async fn study_time_range(
    from: String,
    to: String,
    app: AppHandle,
) -> Result<Vec<StudyTimeDay>, AppError> {
    let from_date = parse_date("from", &from)?;
    let to_date = parse_date("to", &to)?;
    if to_date < from_date {
        return Err(AppError::validation("to must not be earlier than from"));
    }
    if to_date - from_date > Duration::days(MAX_RANGE_DAYS) {
        return Err(AppError::validation(format!(
            "range must not exceed {MAX_RANGE_DAYS} days"
        )));
    }
    let db = vfs_db(&app)?;
    let (from_key, to_key) = (
        from_date.format("%Y-%m-%d").to_string(),
        to_date.format("%Y-%m-%d").to_string(),
    );
    tokio::task::spawn_blocking(move || {
        let conn = db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        range(&conn, &from_key, &to_key)
            .map_err(|e| AppError::database(format!("study_time_range failed: {e}")))
    })
    .await
    .map_err(|e| AppError::internal(format!("study_time_range join error: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIGRATION_SQL: &str = include_str!("../../migrations/vfs/V20261006__study_time.sql");

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATION_SQL).unwrap();
        conn
    }

    fn d(raw: &str) -> NaiveDate {
        NaiveDate::parse_from_str(raw, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn migration_is_idempotent() {
        let conn = conn();
        conn.execute_batch(MIGRATION_SQL).unwrap();
    }

    #[test]
    fn add_accumulates_per_day_and_caps_at_one_day() {
        let conn = conn();
        assert_eq!(add_seconds(&conn, "2026-10-04", 30, 1).unwrap().seconds, 30);
        assert_eq!(add_seconds(&conn, "2026-10-04", 15, 2).unwrap().seconds, 45);
        assert_eq!(add_seconds(&conn, "2026-10-05", 10, 3).unwrap().seconds, 10);
        for _ in 0..30 {
            add_seconds(&conn, "2026-10-05", MAX_SECONDS_PER_ADD, 4).unwrap();
        }
        assert_eq!(
            add_seconds(&conn, "2026-10-05", 1, 5).unwrap().seconds,
            MAX_SECONDS_PER_DAY
        );
        let updated_at: i64 = conn
            .query_row(
                "SELECT updated_at FROM study_time_daily WHERE date='2026-10-04'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(updated_at, 2);
    }

    #[test]
    fn range_is_inclusive_sorted_and_skips_empty_days() {
        let conn = conn();
        add_seconds(&conn, "2026-10-03", 60, 1).unwrap();
        add_seconds(&conn, "2026-10-01", 120, 1).unwrap();
        add_seconds(&conn, "2026-09-30", 5, 1).unwrap();
        add_seconds(&conn, "2026-10-05", 7, 1).unwrap();
        let days = range(&conn, "2026-10-01", "2026-10-05").unwrap();
        assert_eq!(
            days,
            vec![
                StudyTimeDay {
                    date: "2026-10-01".into(),
                    seconds: 120
                },
                StudyTimeDay {
                    date: "2026-10-03".into(),
                    seconds: 60
                },
                StudyTimeDay {
                    date: "2026-10-05".into(),
                    seconds: 7
                },
            ]
        );
        assert_eq!(
            total_seconds(&conn, "2026-10-01", "2026-10-05").unwrap(),
            187
        );
        assert_eq!(total_seconds(&conn, "2027-01-01", "2027-01-02").unwrap(), 0);
    }

    #[test]
    fn validation_rejects_bad_seconds_and_far_dates() {
        let today = d("2026-10-04");
        assert!(validate_add(15, today, today).is_ok());
        assert!(validate_add(15, d("2026-10-03"), today).is_ok());
        assert!(validate_add(15, d("2026-10-06"), today).is_ok());
        assert!(validate_add(0, today, today).is_err());
        assert!(validate_add(-5, today, today).is_err());
        assert!(validate_add(MAX_SECONDS_PER_ADD + 1, today, today).is_err());
        assert!(validate_add(15, d("2026-09-01"), today).is_err());
        assert!(parse_date("date", "2026/10/04").is_err());
        assert!(parse_date("date", "2026-10-04").is_ok());
    }
}
