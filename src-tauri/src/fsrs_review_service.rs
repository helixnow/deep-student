//! FSRS 闪卡复习服务
//!
//! 调度状态与复习日志独立于 `anki_cards` 内容表。
//! 调度算法使用官方轻量 crate `rs-fsrs`（MIT，仅 scheduler，不含优化器）。

use chrono::{DateTime, Local, TimeZone, Utc};
use rs_fsrs::{Card as RsFsrsCard, Rating as RsFsrsRating, State as RsFsrsState, FSRS as RsFsrs};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tracing::{debug, info};

use crate::database::Database;
use crate::models::AppError;

type Result<T> = std::result::Result<T, AppError>;

/// 参数版本标记（rs-fsrs 1.2.x 默认权重）
pub const FSRS_PARAMS_VERSION: &str = "rs-fsrs-1.2";

/// 默认牌组 ID（与迁移 seed 一致）
pub const DEFAULT_DECK_ID: &str = "deck_default";

/// 默认目标保持率
pub const DEFAULT_DESIRED_RETENTION: f64 = 0.9;

/// FSRS 卡片状态（与 Anki/FSRS 约定对齐）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(i32)]
pub enum FsrsState {
    New = 0,
    Learning = 1,
    Review = 2,
    Relearning = 3,
}

impl FsrsState {
    pub fn from_i32(v: i32) -> Self {
        match v {
            1 => Self::Learning,
            2 => Self::Review,
            3 => Self::Relearning,
            _ => Self::New,
        }
    }

    pub fn as_i32(self) -> i32 {
        self as i32
    }
}

/// 评分 1=Again, 2=Hard, 3=Good, 4=Easy
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum FsrsRating {
    Again = 1,
    Hard = 2,
    Good = 3,
    Easy = 4,
}

impl FsrsRating {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            1 => Some(Self::Again),
            2 => Some(Self::Hard),
            3 => Some(Self::Good),
            4 => Some(Self::Easy),
            _ => None,
        }
    }

    pub fn as_u8(self) -> u8 {
        self as u8
    }
}

#[cfg(test)]
const MS_PER_MINUTE: i64 = 60_000;
#[cfg(test)]
const MS_PER_DAY: i64 = 86_400_000;

/// 持久化的卡片调度状态
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsrsCardState {
    pub id: String,
    pub anki_card_id: String,
    pub deck_id: Option<String>,
    pub state: i32,
    pub stability: Option<f64>,
    pub difficulty: Option<f64>,
    pub elapsed_days: f64,
    pub scheduled_days: f64,
    pub reps: i32,
    pub lapses: i32,
    pub due_ms: i64,
    pub last_review_ms: Option<i64>,
    pub suspended: bool,
    pub fsrs_params_version: String,
    pub desired_retention: Option<f64>,
    pub created_at: String,
    pub updated_at: String,
}

/// 到期队列项：调度状态 + anki_cards 正反面（供复习 UI）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsrsDueCard {
    #[serde(flatten)]
    pub state: FsrsCardState,
    pub front: String,
    pub back: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// 评分后返回
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsrsRateResult {
    pub card_state: FsrsCardState,
    pub log_id: String,
    pub scheduled_days: f64,
    pub due_ms: i64,
}

/// 入队结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsrsEnqueueResult {
    pub enqueued: u32,
    pub skipped: u32,
    pub states: Vec<FsrsCardState>,
}

/// 统计
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsrsStats {
    pub total: i64,
    pub due: i64,
    pub new_count: i64,
    pub learning: i64,
    pub review: i64,
    pub relearning: i64,
    pub suspended: i64,
    pub reviews_today: i64,
}

/// 单次调度计算结果（内存）
#[derive(Debug, Clone)]
struct ScheduleOutcome {
    state: FsrsState,
    stability: f64,
    difficulty: f64,
    scheduled_days: f64,
    elapsed_days: f64,
    due_ms: i64,
    reps: i32,
    lapses: i32,
}

/// FSRS 复习服务
pub struct FsrsReviewService {
    db: Arc<Database>,
}

impl FsrsReviewService {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    /// 将 anki 卡片入队到 FSRS（已存在则跳过）
    pub fn enqueue_cards(&self, anki_card_ids: &[String]) -> Result<FsrsEnqueueResult> {
        if anki_card_ids.is_empty() {
            return Ok(FsrsEnqueueResult {
                enqueued: 0,
                skipped: 0,
                states: vec![],
            });
        }

        let now = Utc::now();
        let now_rfc = now.to_rfc3339();
        let now_ms = now.timestamp_millis();

        let mut conn = self
            .db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取数据库连接失败: {}", e)))?;
        let tx = conn
            .transaction()
            .map_err(|e| AppError::database(format!("开启事务失败: {}", e)))?;

        // 确保默认牌组存在
        tx.execute(
            "INSERT OR IGNORE INTO anki_decks (id, name, description, config_json, created_at, updated_at, local_version)
             VALUES (?1, 'Default', 'Default flashcard deck for FSRS reviews', '{\"desired_retention\":0.9}', ?2, ?2, 0)",
            params![DEFAULT_DECK_ID, now_rfc],
        )
        .map_err(|e| AppError::database(format!("确保默认牌组失败: {}", e)))?;

        let mut enqueued = 0u32;
        let mut skipped = 0u32;
        let mut states = Vec::new();

        for card_id in anki_card_ids {
            if card_id.trim().is_empty() {
                skipped += 1;
                continue;
            }

            // 校验卡片存在（不修改 anki_cards）
            let exists: bool = tx
                .query_row(
                    "SELECT 1 FROM anki_cards WHERE id = ?1 AND deleted_at IS NULL LIMIT 1",
                    params![card_id],
                    |_| Ok(true),
                )
                .optional()
                .map_err(|e| AppError::database(format!("查询 anki_cards 失败: {}", e)))?
                .unwrap_or(false);

            if !exists {
                return Err(AppError::not_found(format!(
                    "anki card not found: {}",
                    card_id
                )));
            }

            let existing: Option<(String, Option<String>)> = tx
                .query_row(
                    "SELECT id, deleted_at FROM fsrs_card_states WHERE anki_card_id = ?1",
                    params![card_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|e| AppError::database(format!("查询 fsrs_card_states 失败: {}", e)))?;

            if let Some((state_id, deleted_at)) = existing {
                if deleted_at.is_none() {
                    skipped += 1;
                    if let Some(state) = Self::load_state_by_anki_card(&tx, card_id)? {
                        states.push(state);
                    }
                    continue;
                }

                // A remote DELETE is represented as a tombstone. If the parent
                // card is live again, enqueue starts a fresh scheduling history.
                tx.execute(
                    "DELETE FROM fsrs_review_logs WHERE card_state_id = ?1",
                    params![state_id],
                )
                .map_err(|e| AppError::database(format!("清理已删除复习日志失败: {}", e)))?;
                tx.execute(
                    "DELETE FROM fsrs_card_states WHERE id = ?1",
                    params![state_id],
                )
                .map_err(|e| AppError::database(format!("清理已删除卡片状态失败: {}", e)))?;
            }

            let id = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO fsrs_card_states (
                    id, anki_card_id, deck_id, state, stability, difficulty,
                    elapsed_days, scheduled_days, reps, lapses, due_ms, last_review_ms,
                    suspended, fsrs_params_version, desired_retention, created_at, updated_at
                 ) VALUES (
                    ?1, ?2, ?3, 0, NULL, NULL,
                    0, 0, 0, 0, ?4, NULL,
                    0, ?5, ?6, ?7, ?7
                 )",
                params![
                    id,
                    card_id,
                    DEFAULT_DECK_ID,
                    now_ms, // 新卡立即到期
                    FSRS_PARAMS_VERSION,
                    DEFAULT_DESIRED_RETENTION,
                    now_rfc,
                ],
            )
            .map_err(|e| AppError::database(format!("插入 fsrs_card_states 失败: {}", e)))?;

            enqueued += 1;
            if let Some(state) = Self::load_state_by_id(&tx, &id)? {
                states.push(state);
            }
        }

        tx.commit()
            .map_err(|e| AppError::database(format!("提交入队事务失败: {}", e)))?;

        info!(
            "[FsrsReviewService] enqueue: enqueued={}, skipped={}",
            enqueued, skipped
        );

        Ok(FsrsEnqueueResult {
            enqueued,
            skipped,
            states,
        })
    }

    /// 获取到期卡片（联表 anki_cards 取正反面）
    pub fn get_due(&self, limit: Option<u32>) -> Result<Vec<FsrsDueCard>> {
        let limit = limit.unwrap_or(50).min(500) as i64;
        let now_ms = Utc::now().timestamp_millis();
        let conn = self
            .db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取数据库连接失败: {}", e)))?;

        let mut stmt = conn
            .prepare(
                "SELECT s.id, s.anki_card_id, s.deck_id, s.state, s.stability, s.difficulty,
                        s.elapsed_days, s.scheduled_days, s.reps, s.lapses, s.due_ms, s.last_review_ms,
                        s.suspended, s.fsrs_params_version, s.desired_retention, s.created_at, s.updated_at,
                        COALESCE(a.front, ''), COALESCE(a.back, ''), COALESCE(a.tags_json, '[]')
                 FROM fsrs_card_states s
                 INNER JOIN anki_cards a ON a.id = s.anki_card_id
                 WHERE s.deleted_at IS NULL
                   AND a.deleted_at IS NULL
                   AND s.suspended = 0
                   AND s.due_ms <= ?1
                 ORDER BY s.due_ms ASC
                 LIMIT ?2",
            )
            .map_err(|e| AppError::database(format!("准备到期查询失败: {}", e)))?;

        let rows = stmt
            .query_map(params![now_ms, limit], |row| {
                let state = Self::map_state_row(row)?;
                let front: String = row.get(17)?;
                let back: String = row.get(18)?;
                let tags_json: String = row.get(19)?;
                let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
                Ok(FsrsDueCard {
                    state,
                    front,
                    back,
                    tags,
                })
            })
            .map_err(|e| AppError::database(format!("查询到期卡片失败: {}", e)))?;

        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| AppError::database(format!("解析到期行失败: {}", e)))?);
        }
        Ok(out)
    }

    /// 评分并写 state + log（同一事务）
    pub fn rate(
        &self,
        card_state_id: &str,
        rating: u8,
        duration_ms: Option<i64>,
    ) -> Result<FsrsRateResult> {
        let rating = FsrsRating::from_u8(rating)
            .ok_or_else(|| AppError::validation(format!("rating must be 1..=4, got {}", rating)))?;

        let now = Utc::now();
        let now_rfc = now.to_rfc3339();
        let now_ms = now.timestamp_millis();

        let mut conn = self
            .db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取数据库连接失败: {}", e)))?;
        let tx = conn
            .transaction()
            .map_err(|e| AppError::database(format!("开启事务失败: {}", e)))?;

        let before = Self::load_state_by_id(&tx, card_state_id)?.ok_or_else(|| {
            AppError::not_found(format!("fsrs card state not found: {}", card_state_id))
        })?;

        if before.suspended {
            return Err(AppError::validation("card is suspended"));
        }

        let outcome = schedule_review(&before, rating, now_ms);
        let log_id = uuid::Uuid::new_v4().to_string();

        let updated = tx
            .execute(
                "UPDATE fsrs_card_states SET
                state = ?1,
                stability = ?2,
                difficulty = ?3,
                elapsed_days = ?4,
                scheduled_days = ?5,
                reps = ?6,
                lapses = ?7,
                due_ms = ?8,
                last_review_ms = ?9,
                fsrs_params_version = ?10,
                updated_at = ?11
             WHERE id = ?12 AND deleted_at IS NULL",
                params![
                    outcome.state.as_i32(),
                    outcome.stability,
                    outcome.difficulty,
                    outcome.elapsed_days,
                    outcome.scheduled_days,
                    outcome.reps,
                    outcome.lapses,
                    outcome.due_ms,
                    now_ms,
                    FSRS_PARAMS_VERSION,
                    now_rfc,
                    card_state_id,
                ],
            )
            .map_err(|e| AppError::database(format!("更新 fsrs_card_states 失败: {}", e)))?;
        if updated != 1 {
            return Err(AppError::not_found(format!(
                "fsrs card state not found: {}",
                card_state_id
            )));
        }

        tx.execute(
            "INSERT INTO fsrs_review_logs (
                id, card_state_id, anki_card_id, rating,
                state_before, state_after,
                stability_before, stability_after,
                difficulty_before, difficulty_after,
                scheduled_days, elapsed_days,
                due_before_ms, due_after_ms,
                review_ms, duration_ms, fsrs_params_version,
                created_at, updated_at
             ) VALUES (
                ?1, ?2, ?3, ?4,
                ?5, ?6,
                ?7, ?8,
                ?9, ?10,
                ?11, ?12,
                ?13, ?14,
                ?15, ?16, ?17,
                ?18, ?18
             )",
            params![
                log_id,
                card_state_id,
                before.anki_card_id,
                rating.as_u8() as i32,
                before.state,
                outcome.state.as_i32(),
                before.stability,
                outcome.stability,
                before.difficulty,
                outcome.difficulty,
                outcome.scheduled_days,
                outcome.elapsed_days,
                before.due_ms,
                outcome.due_ms,
                now_ms,
                duration_ms,
                FSRS_PARAMS_VERSION,
                now_rfc,
            ],
        )
        .map_err(|e| AppError::database(format!("写入 fsrs_review_logs 失败: {}", e)))?;

        let card_state = Self::load_state_by_id(&tx, card_state_id)?
            .ok_or_else(|| AppError::database("state missing after update"))?;

        tx.commit()
            .map_err(|e| AppError::database(format!("提交评分事务失败: {}", e)))?;

        debug!(
            "[FsrsReviewService] rate: id={}, rating={:?}, due_ms={}, scheduled_days={}",
            card_state_id, rating, outcome.due_ms, outcome.scheduled_days
        );

        Ok(FsrsRateResult {
            card_state,
            log_id,
            scheduled_days: outcome.scheduled_days,
            due_ms: outcome.due_ms,
        })
    }

    /// 统计
    pub fn get_stats(&self) -> Result<FsrsStats> {
        let now_ms = Utc::now().timestamp_millis();
        let local_now = Local::now();
        let (day_start_ms, next_day_start_ms) = day_bounds_ms(&local_now).unwrap_or_else(|| {
            // Some time zones have a skipped/ambiguous midnight. Falling back to
            // UTC is preferable to panicking; ordinary DST transitions resolve
            // through `earliest()` in `day_bounds_ms`.
            day_bounds_ms(&Utc::now()).expect("UTC day boundaries are always valid")
        });

        let conn = self
            .db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取数据库连接失败: {}", e)))?;

        let (total, due, new_count, learning, review, relearning, suspended): (
            i64,
            i64,
            i64,
            i64,
            i64,
            i64,
            i64,
        ) = conn
            .query_row(
                "SELECT
                    COUNT(*),
                    COALESCE(SUM(CASE WHEN s.suspended = 0 AND s.due_ms <= ?1 THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN s.state = 0 AND s.suspended = 0 THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN s.state = 1 AND s.suspended = 0 THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN s.state = 2 AND s.suspended = 0 THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN s.state = 3 AND s.suspended = 0 THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN s.suspended = 1 THEN 1 ELSE 0 END), 0)
                 FROM fsrs_card_states s
                 INNER JOIN anki_cards a ON a.id = s.anki_card_id
                 WHERE s.deleted_at IS NULL AND a.deleted_at IS NULL",
                params![now_ms],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .map_err(|e| AppError::database(e.to_string()))?;
        let reviews_today: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM fsrs_review_logs l
                 INNER JOIN fsrs_card_states s ON s.id = l.card_state_id
                 INNER JOIN anki_cards a ON a.id = l.anki_card_id
                 WHERE l.deleted_at IS NULL
                   AND s.deleted_at IS NULL
                   AND a.deleted_at IS NULL
                   AND l.review_ms >= ?1
                   AND l.review_ms < ?2",
                params![day_start_ms, next_day_start_ms],
                |r| r.get(0),
            )
            .map_err(|e| AppError::database(e.to_string()))?;

        Ok(FsrsStats {
            total,
            due,
            new_count,
            learning,
            review,
            relearning,
            suspended,
            reviews_today,
        })
    }

    fn map_state_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<FsrsCardState> {
        Ok(FsrsCardState {
            id: row.get(0)?,
            anki_card_id: row.get(1)?,
            deck_id: row.get(2)?,
            state: row.get(3)?,
            stability: row.get(4)?,
            difficulty: row.get(5)?,
            elapsed_days: row.get(6)?,
            scheduled_days: row.get(7)?,
            reps: row.get(8)?,
            lapses: row.get(9)?,
            due_ms: row.get(10)?,
            last_review_ms: row.get(11)?,
            suspended: row.get::<_, i32>(12)? != 0,
            fsrs_params_version: row.get(13)?,
            desired_retention: row.get(14)?,
            created_at: row.get(15)?,
            updated_at: row.get(16)?,
        })
    }

    fn load_state_by_id(conn: &rusqlite::Connection, id: &str) -> Result<Option<FsrsCardState>> {
        conn.query_row(
            "SELECT s.id, s.anki_card_id, s.deck_id, s.state, s.stability, s.difficulty,
                    s.elapsed_days, s.scheduled_days, s.reps, s.lapses, s.due_ms, s.last_review_ms,
                    s.suspended, s.fsrs_params_version, s.desired_retention, s.created_at, s.updated_at
             FROM fsrs_card_states s
             INNER JOIN anki_cards a ON a.id = s.anki_card_id
             WHERE s.id = ?1 AND s.deleted_at IS NULL AND a.deleted_at IS NULL",
            params![id],
            Self::map_state_row,
        )
        .optional()
        .map_err(|e| AppError::database(format!("加载 card state 失败: {}", e)))
    }

    fn load_state_by_anki_card(
        conn: &rusqlite::Connection,
        anki_card_id: &str,
    ) -> Result<Option<FsrsCardState>> {
        conn.query_row(
            "SELECT s.id, s.anki_card_id, s.deck_id, s.state, s.stability, s.difficulty,
                    s.elapsed_days, s.scheduled_days, s.reps, s.lapses, s.due_ms, s.last_review_ms,
                    s.suspended, s.fsrs_params_version, s.desired_retention, s.created_at, s.updated_at
             FROM fsrs_card_states s
             INNER JOIN anki_cards a ON a.id = s.anki_card_id
             WHERE s.anki_card_id = ?1
               AND s.deleted_at IS NULL
               AND a.deleted_at IS NULL",
            params![anki_card_id],
            Self::map_state_row,
        )
        .optional()
        .map_err(|e| AppError::database(format!("按 anki_card_id 加载失败: {}", e)))
    }
}

fn day_bounds_ms<Tz>(now: &DateTime<Tz>) -> Option<(i64, i64)>
where
    Tz: TimeZone + Clone,
{
    let timezone = now.timezone();
    let today = now.date_naive();
    let tomorrow = today.succ_opt()?;
    let start = timezone
        .from_local_datetime(&today.and_hms_opt(0, 0, 0)?)
        .earliest()?;
    let next_start = timezone
        .from_local_datetime(&tomorrow.and_hms_opt(0, 0, 0)?)
        .earliest()?;
    Some((start.timestamp_millis(), next_start.timestamp_millis()))
}

fn ms_to_datetime(ms: i64) -> chrono::DateTime<Utc> {
    Utc.timestamp_millis_opt(ms)
        .single()
        .unwrap_or_else(|| Utc.timestamp_opt(0, 0).single().unwrap_or_else(Utc::now))
}

fn datetime_to_ms(dt: chrono::DateTime<Utc>) -> i64 {
    dt.timestamp_millis()
}

fn to_rs_state(state: FsrsState) -> RsFsrsState {
    match state {
        FsrsState::New => RsFsrsState::New,
        FsrsState::Learning => RsFsrsState::Learning,
        FsrsState::Review => RsFsrsState::Review,
        FsrsState::Relearning => RsFsrsState::Relearning,
    }
}

fn from_rs_state(state: RsFsrsState) -> FsrsState {
    match state {
        RsFsrsState::New => FsrsState::New,
        RsFsrsState::Learning => FsrsState::Learning,
        RsFsrsState::Review => FsrsState::Review,
        RsFsrsState::Relearning => FsrsState::Relearning,
    }
}

fn to_rs_rating(rating: FsrsRating) -> RsFsrsRating {
    match rating {
        FsrsRating::Again => RsFsrsRating::Again,
        FsrsRating::Hard => RsFsrsRating::Hard,
        FsrsRating::Good => RsFsrsRating::Good,
        FsrsRating::Easy => RsFsrsRating::Easy,
    }
}

fn to_rs_card(before: &FsrsCardState) -> RsFsrsCard {
    let due = ms_to_datetime(before.due_ms);
    let last_review = before.last_review_ms.map(ms_to_datetime).unwrap_or(due);
    RsFsrsCard {
        due,
        stability: before.stability.unwrap_or(0.0),
        difficulty: before.difficulty.unwrap_or(0.0),
        elapsed_days: before.elapsed_days.round() as i64,
        scheduled_days: before.scheduled_days.round() as i64,
        reps: before.reps,
        lapses: before.lapses,
        state: to_rs_state(FsrsState::from_i32(before.state)),
        last_review,
    }
}

/// 使用 `rs-fsrs` 官方调度器计算下一次复习
fn schedule_review(before: &FsrsCardState, rating: FsrsRating, now_ms: i64) -> ScheduleOutcome {
    let mut params = rs_fsrs::Parameters::default();
    if let Some(retention) = before.desired_retention {
        if retention > 0.0 && retention < 1.0 {
            params.request_retention = retention;
        }
    }
    // 复习结果需可复现，关闭 fuzz
    params.enable_fuzz = false;

    let fsrs = RsFsrs::new(params);
    let now = ms_to_datetime(now_ms);
    let info = fsrs.next(to_rs_card(before), now, to_rs_rating(rating));
    let card = info.card;

    ScheduleOutcome {
        state: from_rs_state(card.state),
        stability: card.stability,
        difficulty: card.difficulty,
        scheduled_days: card.scheduled_days as f64,
        elapsed_days: card.elapsed_days as f64,
        due_ms: datetime_to_ms(card.due),
        reps: card.reps,
        lapses: card.lapses,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data_governance::migration::MigrationCoordinator;
    use crate::data_governance::schema_registry::DatabaseId;
    use rusqlite::params;
    use tempfile::TempDir;

    fn blank_new_card() -> FsrsCardState {
        FsrsCardState {
            id: "s1".into(),
            anki_card_id: "c1".into(),
            deck_id: Some(DEFAULT_DECK_ID.into()),
            state: 0,
            stability: None,
            difficulty: None,
            elapsed_days: 0.0,
            scheduled_days: 0.0,
            reps: 0,
            lapses: 0,
            due_ms: 0,
            last_review_ms: None,
            suspended: false,
            fsrs_params_version: FSRS_PARAMS_VERSION.into(),
            desired_retention: Some(DEFAULT_DESIRED_RETENTION),
            created_at: "t".into(),
            updated_at: "t".into(),
        }
    }

    #[test]
    fn new_good_enters_learning_ten_minutes() {
        // rs-fsrs BasicScheduler: New + Good → Learning, due +10min
        let before = blank_new_card();
        let now = 1_700_000_000_000_i64;
        let out = schedule_review(&before, FsrsRating::Good, now);
        assert_eq!(out.state, FsrsState::Learning);
        assert_eq!(out.scheduled_days, 0.0);
        assert_eq!(out.due_ms, now + 10 * MS_PER_MINUTE);
        assert_eq!(out.reps, 1);
        assert!(out.stability > 0.0);
        assert!(out.difficulty > 0.0);
    }

    #[test]
    fn again_on_review_relearns_in_five_minutes() {
        // rs-fsrs: Review + Again → Relearning, due +5min, lapses++
        let now = 1_700_000_000_000_i64;
        let mut before = blank_new_card();
        before.state = FsrsState::Review.as_i32();
        before.stability = Some(5.0);
        before.difficulty = Some(5.0);
        before.scheduled_days = 5.0;
        before.due_ms = now;
        before.last_review_ms = Some(now - 5 * MS_PER_DAY);
        let out = schedule_review(&before, FsrsRating::Again, now);
        assert_eq!(out.state, FsrsState::Relearning);
        assert_eq!(out.lapses, 1);
        assert_eq!(out.due_ms, now + 5 * MS_PER_MINUTE);
        assert_eq!(out.scheduled_days, 0.0);
    }

    #[test]
    fn hard_and_easy_adjust_intervals() {
        let now = 1_700_000_000_000_i64;
        let mut before = blank_new_card();
        before.state = FsrsState::Review.as_i32();
        before.stability = Some(4.0);
        before.difficulty = Some(5.0);
        before.scheduled_days = 4.0;
        before.due_ms = now;
        before.last_review_ms = Some(now - 4 * MS_PER_DAY);

        let hard = schedule_review(&before, FsrsRating::Hard, now);
        assert_eq!(hard.state, FsrsState::Review);
        assert!(hard.scheduled_days >= 1.0);

        let easy = schedule_review(&before, FsrsRating::Easy, now);
        assert_eq!(easy.state, FsrsState::Review);
        assert!(easy.scheduled_days > hard.scheduled_days);
    }

    #[test]
    fn params_version_is_rs_fsrs() {
        assert!(FSRS_PARAMS_VERSION.starts_with("rs-fsrs-"));
    }

    #[test]
    fn review_day_bounds_follow_user_timezone() {
        let timezone = chrono::FixedOffset::east_opt(8 * 60 * 60).unwrap();
        let local_now = timezone
            .with_ymd_and_hms(2026, 7, 11, 1, 30, 0)
            .single()
            .unwrap();

        let (start, next_start) = day_bounds_ms(&local_now).unwrap();

        assert_eq!(start, 1_783_699_200_000); // 2026-07-10T16:00:00Z
        assert_eq!(next_start, 1_783_785_600_000); // 2026-07-11T16:00:00Z
    }

    fn setup_migrated_fsrs_db() -> (TempDir, Arc<Database>) {
        let temp_dir = TempDir::new().expect("create temporary app data directory");
        let root = temp_dir.path().to_path_buf();
        let mut coordinator = MigrationCoordinator::new(root.clone()).with_audit_db(None);

        let first = coordinator
            .migrate_single(DatabaseId::Mistakes)
            .expect("migrate mistakes database");
        assert_eq!(first.to_version, 20260711);
        let second = coordinator
            .migrate_single(DatabaseId::Mistakes)
            .expect("repeat mistakes migration");
        assert_eq!(second.to_version, 20260711);
        assert_eq!(
            second.applied_count, 0,
            "second migration must be idempotent"
        );

        let db = Arc::new(Database::new(&root.join("mistakes.db")).expect("open mistakes db"));
        (temp_dir, db)
    }

    fn insert_task_and_card(db: &Database, document_id: &str, task_id: &str, card_id: &str) {
        let conn = db.get_conn_safe().expect("open mistakes connection");
        conn.execute(
            "INSERT INTO document_tasks (
                id, document_id, original_document_name, segment_index,
                content_segment, status, anki_generation_options_json
             ) VALUES (?1, ?2, 'test.md', 0, 'segment', 'Completed', '{}')",
            params![task_id, document_id],
        )
        .expect("insert document task");
        conn.execute(
            "INSERT INTO anki_cards (
                id, task_id, front, back, source_type, source_id
             ) VALUES (?1, ?2, ?3, ?4, 'document', ?5)",
            params![
                card_id,
                task_id,
                format!("front-{card_id}"),
                format!("back-{card_id}"),
                document_id
            ],
        )
        .expect("insert Anki card");
    }

    fn enqueue_and_rate(db: &Arc<Database>, card_id: &str) -> String {
        let service = FsrsReviewService::new(db.clone());
        let result = service
            .enqueue_cards(&[card_id.to_string()])
            .expect("enqueue card");
        assert_eq!(result.enqueued, 1);
        let state_id = result.states[0].id.clone();
        assert_ne!(state_id, card_id, "state ID must differ from Anki card ID");
        service.rate(&state_id, 3, Some(250)).expect("rate card");
        state_id
    }

    fn assert_no_fsrs_rows(db: &Database, card_ids: &[&str]) {
        let conn = db.get_conn_safe().expect("open mistakes connection");
        for card_id in card_ids {
            let states: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM fsrs_card_states WHERE anki_card_id = ?1",
                    params![card_id],
                    |row| row.get(0),
                )
                .expect("count card states");
            let logs: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM fsrs_review_logs WHERE anki_card_id = ?1",
                    params![card_id],
                    |row| row.get(0),
                )
                .expect("count review logs");
            assert_eq!(states, 0, "state leaked for {card_id}");
            assert_eq!(logs, 0, "review log leaked for {card_id}");
        }
    }

    fn remove_v20260711_history_and_objects(db: &Database) {
        let conn = db.get_conn_safe().expect("open mistakes connection");
        conn.execute_batch(
            "DELETE FROM refinery_schema_history WHERE version = 20260711;

             DROP TRIGGER IF EXISTS trg__change_log_anki_decks_insert;
             DROP TRIGGER IF EXISTS trg__change_log_anki_decks_update;
             DROP TRIGGER IF EXISTS trg__change_log_anki_decks_delete;
             DROP TRIGGER IF EXISTS trg__change_log_fsrs_card_states_insert;
             DROP TRIGGER IF EXISTS trg__change_log_fsrs_card_states_update;
             DROP TRIGGER IF EXISTS trg__change_log_fsrs_card_states_delete;
             DROP TRIGGER IF EXISTS trg__change_log_fsrs_review_logs_insert;
             DROP TRIGGER IF EXISTS trg__change_log_fsrs_review_logs_update;
             DROP TRIGGER IF EXISTS trg__change_log_fsrs_review_logs_delete;
             DROP TRIGGER IF EXISTS trg_fsrs_cleanup_before_anki_card_delete;

             DROP INDEX IF EXISTS idx_anki_decks_local_version;
             DROP INDEX IF EXISTS idx_anki_decks_deleted_at;
             DROP INDEX IF EXISTS idx_anki_decks_device_id;
             DROP INDEX IF EXISTS idx_anki_decks_sync_updated_at;
             DROP INDEX IF EXISTS idx_anki_decks_device_version;
             DROP INDEX IF EXISTS idx_anki_decks_updated_not_deleted;
             DROP INDEX IF EXISTS idx_fsrs_card_states_local_version;
             DROP INDEX IF EXISTS idx_fsrs_card_states_deleted_at;
             DROP INDEX IF EXISTS idx_fsrs_card_states_device_id;
             DROP INDEX IF EXISTS idx_fsrs_card_states_sync_updated_at;
             DROP INDEX IF EXISTS idx_fsrs_card_states_device_version;
             DROP INDEX IF EXISTS idx_fsrs_card_states_updated_not_deleted;
             DROP INDEX IF EXISTS idx_fsrs_review_logs_local_version;
             DROP INDEX IF EXISTS idx_fsrs_review_logs_deleted_at;
             DROP INDEX IF EXISTS idx_fsrs_review_logs_device_id;
             DROP INDEX IF EXISTS idx_fsrs_review_logs_sync_updated_at;
             DROP INDEX IF EXISTS idx_fsrs_review_logs_device_version;
             DROP INDEX IF EXISTS idx_fsrs_review_logs_updated_not_deleted;",
        )
        .expect("remove V20260711 history and runtime objects");
    }

    fn assert_v20260711_objects_restored(db: &Database) {
        let conn = db.get_conn_safe().expect("open mistakes connection");
        let change_triggers: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'trigger'
                   AND name IN (
                       'trg__change_log_anki_decks_insert',
                       'trg__change_log_anki_decks_update',
                       'trg__change_log_anki_decks_delete',
                       'trg__change_log_fsrs_card_states_insert',
                       'trg__change_log_fsrs_card_states_update',
                       'trg__change_log_fsrs_card_states_delete',
                       'trg__change_log_fsrs_review_logs_insert',
                       'trg__change_log_fsrs_review_logs_update',
                       'trg__change_log_fsrs_review_logs_delete'
                   )",
                [],
                |row| row.get(0),
            )
            .expect("count change-log triggers");
        assert_eq!(change_triggers, 9);

        for (object_type, name) in [
            ("trigger", "trg_fsrs_cleanup_before_anki_card_delete"),
            ("index", "idx_anki_decks_device_version"),
            ("index", "idx_fsrs_card_states_device_version"),
            ("index", "idx_fsrs_review_logs_device_version"),
        ] {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = ?1 AND name = ?2",
                    params![object_type, name],
                    |row| row.get(0),
                )
                .expect("check restored schema object");
            assert_eq!(exists, 1, "missing restored {object_type} {name}");
        }

        let history: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM refinery_schema_history WHERE version = 20260711",
                [],
                |row| row.get(0),
            )
            .expect("check restored migration history");
        assert_eq!(history, 1);
    }

    #[test]
    fn migration_recovery_replays_tail_when_all_alter_columns_exist() {
        let (temp_dir, db) = setup_migrated_fsrs_db();
        remove_v20260711_history_and_objects(&db);
        insert_task_and_card(
            &db,
            "doc-recovery-all",
            "task-recovery-all",
            "card-recovery-all",
        );
        insert_task_and_card(
            &db,
            "doc-recovery-soft",
            "task-recovery-soft",
            "card-recovery-soft",
        );
        {
            let conn = db.get_conn_safe().expect("open mistakes connection");
            conn.execute(
                "INSERT INTO fsrs_card_states (
                    id, anki_card_id, state, due_ms, fsrs_params_version, created_at, updated_at
                 ) VALUES (
                    'state-recovery-all', 'card-recovery-all', 0, 0,
                    ?1, '2026-07-11T00:00:00Z', '2026-07-11T00:00:00Z'
                 )",
                params![FSRS_PARAMS_VERSION],
            )
            .expect("insert recovery card state");
            conn.execute(
                "INSERT INTO fsrs_review_logs (
                    id, card_state_id, anki_card_id, rating, state_before, state_after,
                    review_ms, fsrs_params_version, created_at, updated_at
                 ) VALUES (
                    'log-recovery-all', 'state-recovery-all', 'card-recovery-all',
                    3, 0, 1, 1783728000000, ?1, NULL, NULL
                 )",
                params![FSRS_PARAMS_VERSION],
            )
            .expect("insert log requiring timestamp backfill");
            conn.execute(
                "INSERT INTO fsrs_card_states (
                    id, anki_card_id, state, due_ms, fsrs_params_version, created_at, updated_at
                 ) VALUES (
                    'state-recovery-orphan', 'card-recovery-missing', 0, 0,
                    ?1, '2026-07-11T00:00:00Z', '2026-07-11T00:00:00Z'
                 )",
                params![FSRS_PARAMS_VERSION],
            )
            .expect("insert orphan card state");
            conn.execute(
                "INSERT INTO fsrs_review_logs (
                    id, card_state_id, anki_card_id, rating, state_before, state_after,
                    review_ms, fsrs_params_version
                 ) VALUES (
                    'log-recovery-orphan', 'state-recovery-orphan', 'card-recovery-missing',
                    3, 0, 1, 1783728000000, ?1
                 )",
                params![FSRS_PARAMS_VERSION],
            )
            .expect("insert orphan review log");
            conn.execute(
                "INSERT INTO fsrs_card_states (
                    id, anki_card_id, state, due_ms, fsrs_params_version, created_at, updated_at
                 ) VALUES (
                    'state-recovery-soft', 'card-recovery-soft', 0, 0,
                    ?1, '2026-07-11T00:00:00Z', '2026-07-11T00:00:00Z'
                 )",
                params![FSRS_PARAMS_VERSION],
            )
            .expect("insert state whose parent will be soft-deleted");
            conn.execute(
                "INSERT INTO fsrs_review_logs (
                    id, card_state_id, anki_card_id, rating, state_before, state_after,
                    review_ms, fsrs_params_version, created_at, updated_at
                 ) VALUES (
                    'log-recovery-soft', 'state-recovery-soft', 'card-recovery-soft',
                    3, 0, 1, 1783728000000, ?1,
                    '2026-07-11T00:00:00Z', '2026-07-11T00:00:00Z'
                 )",
                params![FSRS_PARAMS_VERSION],
            )
            .expect("insert log whose parent will be soft-deleted");
            conn.execute(
                "UPDATE anki_cards
                 SET deleted_at = '2026-07-11T00:00:00Z'
                 WHERE id = 'card-recovery-soft'",
                [],
            )
            .expect("soft-delete parent before migration recovery");
        }

        let mut coordinator =
            MigrationCoordinator::new(temp_dir.path().to_path_buf()).with_audit_db(None);
        let report = coordinator
            .migrate_single(DatabaseId::Mistakes)
            .expect("recover all-column migration state");
        assert_eq!(report.to_version, 20260711);
        assert_v20260711_objects_restored(&db);

        let conn = db.get_conn_safe().expect("open mistakes connection");
        let (created_at, updated_at): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT created_at, updated_at FROM fsrs_review_logs WHERE id = 'log-recovery-all'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("load backfilled log timestamps");
        assert!(created_at.is_some());
        assert!(updated_at.is_some());
        let orphan_rows: i64 = conn
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM fsrs_card_states WHERE id = 'state-recovery-orphan') +
                    (SELECT COUNT(*) FROM fsrs_review_logs WHERE id = 'log-recovery-orphan')",
                [],
                |row| row.get(0),
            )
            .expect("count recovered orphan rows");
        assert_eq!(orphan_rows, 0);

        let soft_deleted_parent_rows: i64 = conn
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM fsrs_card_states WHERE id = 'state-recovery-soft') +
                    (SELECT COUNT(*) FROM fsrs_review_logs WHERE id = 'log-recovery-soft')",
                [],
                |row| row.get(0),
            )
            .expect("count rows owned by a soft-deleted parent");
        assert_eq!(
            soft_deleted_parent_rows, 2,
            "soft deletion must be reversible and preserve scheduling history"
        );

        for (table_name, record_id) in [
            ("fsrs_card_states", "state-recovery-all"),
            ("fsrs_review_logs", "log-recovery-all"),
            ("fsrs_card_states", "state-recovery-soft"),
            ("fsrs_review_logs", "log-recovery-soft"),
        ] {
            let pending: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM __change_log
                     WHERE table_name = ?1 AND record_id = ?2 AND sync_version = 0",
                    params![table_name, record_id],
                    |row| row.get(0),
                )
                .expect("count migration backfill change");
            assert_eq!(pending, 1, "missing or duplicate backfill for {record_id}");
        }
        drop(conn);

        // Crash again after the tail completed but before history was durable.
        // Replaying with triggers already present must not create duplicate
        // pending changes for unchanged rows.
        {
            let conn = db.get_conn_safe().expect("open mistakes connection");
            conn.execute(
                "DELETE FROM refinery_schema_history WHERE version = 20260711",
                [],
            )
            .expect("remove migration history for idempotent replay");
        }
        let repeated = coordinator
            .migrate_single(DatabaseId::Mistakes)
            .expect("repeat recovered migration tail");
        assert_eq!(repeated.to_version, 20260711);
        let conn = db.get_conn_safe().expect("open mistakes connection");
        for (table_name, record_id) in [
            ("fsrs_card_states", "state-recovery-all"),
            ("fsrs_review_logs", "log-recovery-all"),
            ("fsrs_card_states", "state-recovery-soft"),
            ("fsrs_review_logs", "log-recovery-soft"),
        ] {
            let pending: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM __change_log
                     WHERE table_name = ?1 AND record_id = ?2 AND sync_version = 0",
                    params![table_name, record_id],
                    |row| row.get(0),
                )
                .expect("count repeated migration backfill change");
            assert_eq!(pending, 1, "replay duplicated change for {record_id}");
        }
    }

    #[test]
    fn migration_recovery_replays_tail_when_only_some_alter_columns_exist() {
        let (temp_dir, db) = setup_migrated_fsrs_db();
        remove_v20260711_history_and_objects(&db);
        {
            let conn = db.get_conn_safe().expect("open mistakes connection");
            conn.execute_batch("ALTER TABLE fsrs_review_logs DROP COLUMN deleted_at;")
                .expect("simulate partially applied V20260711");
        }

        let mut coordinator =
            MigrationCoordinator::new(temp_dir.path().to_path_buf()).with_audit_db(None);
        let report = coordinator
            .migrate_single(DatabaseId::Mistakes)
            .expect("recover partial-column migration state");
        assert_eq!(report.to_version, 20260711);
        assert_v20260711_objects_restored(&db);

        let conn = db.get_conn_safe().expect("open mistakes connection");
        let deleted_at_exists: bool = conn
            .prepare("PRAGMA table_info(fsrs_review_logs)")
            .expect("prepare table_info")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query table_info")
            .filter_map(std::result::Result::ok)
            .any(|column| column == "deleted_at");
        assert!(deleted_at_exists);
    }

    #[test]
    fn deletion_paths_and_tombstones_do_not_leave_schedulable_ghosts() {
        let (_temp_dir, db) = setup_migrated_fsrs_db();

        insert_task_and_card(&db, "doc-card", "task-card", "card-direct-api");
        enqueue_and_rate(&db, "card-direct-api");
        db.delete_anki_card("card-direct-api")
            .expect("delete one card");
        assert_no_fsrs_rows(&db, &["card-direct-api"]);

        insert_task_and_card(&db, "doc-task", "task-delete", "card-task-delete");
        enqueue_and_rate(&db, "card-task-delete");
        db.delete_document_task("task-delete")
            .expect("delete document task");
        assert_no_fsrs_rows(&db, &["card-task-delete"]);

        insert_task_and_card(&db, "doc-session", "task-session-a", "card-session-a");
        insert_task_and_card(&db, "doc-session", "task-session-b", "card-session-b");
        enqueue_and_rate(&db, "card-session-a");
        enqueue_and_rate(&db, "card-session-b");
        db.delete_document_session("doc-session")
            .expect("delete document session");
        assert_no_fsrs_rows(&db, &["card-session-a", "card-session-b"]);

        // The migration trigger also protects direct SQL and cascade-driven deletes.
        insert_task_and_card(&db, "doc-sql", "task-sql", "card-direct-sql");
        enqueue_and_rate(&db, "card-direct-sql");
        {
            let conn = db.get_conn_safe().expect("open mistakes connection");
            conn.execute(
                "DELETE FROM anki_cards WHERE id = ?1",
                params!["card-direct-sql"],
            )
            .expect("direct SQL card delete");
        }
        assert_no_fsrs_rows(&db, &["card-direct-sql"]);

        insert_task_and_card(&db, "doc-tombstone", "task-tombstone", "card-tombstone");
        let tombstoned_state = enqueue_and_rate(&db, "card-tombstone");
        {
            let conn = db.get_conn_safe().expect("open mistakes connection");
            conn.execute(
                "UPDATE anki_cards SET deleted_at = '2026-07-11T00:00:00Z' WHERE id = ?1",
                params!["card-tombstone"],
            )
            .expect("soft-delete Anki card");
        }

        let service = FsrsReviewService::new(db.clone());
        assert!(service
            .get_due(Some(50))
            .expect("load due cards")
            .is_empty());
        assert!(service.rate(&tombstoned_state, 3, None).is_err());
        let stats = service.get_stats().expect("load FSRS stats");
        assert_eq!(stats.total, 0);
        assert_eq!(stats.reviews_today, 0);

        {
            let conn = db.get_conn_safe().expect("open mistakes connection");
            conn.execute(
                "UPDATE anki_cards SET deleted_at = NULL WHERE id = ?1",
                params!["card-tombstone"],
            )
            .expect("restore soft-deleted Anki card");
            let history_rows: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM fsrs_review_logs WHERE card_state_id = ?1",
                    params![&tombstoned_state],
                    |row| row.get(0),
                )
                .expect("count preserved review history");
            assert_eq!(history_rows, 1);
        }
        let restored_stats = service.get_stats().expect("load restored FSRS stats");
        assert_eq!(restored_stats.total, 1);
        assert_eq!(restored_stats.reviews_today, 1);
        service
            .rate(&tombstoned_state, 3, None)
            .expect("restored state remains rateable");
    }
}
