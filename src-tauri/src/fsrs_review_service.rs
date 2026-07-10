//! FSRS 闪卡复习服务
//!
//! 调度状态与复习日志独立于 `anki_cards` 内容表。
//! 调度算法使用官方轻量 crate `rs-fsrs`（MIT，仅 scheduler，不含优化器）。

use chrono::{TimeZone, Utc};
use rusqlite::{params, OptionalExtension};
use rs_fsrs::{Card as RsFsrsCard, FSRS as RsFsrs, Rating as RsFsrsRating, State as RsFsrsState};
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
                    "SELECT 1 FROM anki_cards WHERE id = ?1 LIMIT 1",
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

            let existing: Option<String> = tx
                .query_row(
                    "SELECT id FROM fsrs_card_states WHERE anki_card_id = ?1",
                    params![card_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| AppError::database(format!("查询 fsrs_card_states 失败: {}", e)))?;

            if existing.is_some() {
                skipped += 1;
                if let Some(state) = Self::load_state_by_anki_card(&tx, card_id)? {
                    states.push(state);
                }
                continue;
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
                 LEFT JOIN anki_cards a ON a.id = s.anki_card_id
                 WHERE s.suspended = 0 AND s.due_ms <= ?1
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
        let rating = FsrsRating::from_u8(rating).ok_or_else(|| {
            AppError::validation(format!("rating must be 1..=4, got {}", rating))
        })?;

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

        tx.execute(
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
             WHERE id = ?12",
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

        tx.execute(
            "INSERT INTO fsrs_review_logs (
                id, card_state_id, anki_card_id, rating,
                state_before, state_after,
                stability_before, stability_after,
                difficulty_before, difficulty_after,
                scheduled_days, elapsed_days,
                due_before_ms, due_after_ms,
                review_ms, duration_ms, fsrs_params_version
             ) VALUES (
                ?1, ?2, ?3, ?4,
                ?5, ?6,
                ?7, ?8,
                ?9, ?10,
                ?11, ?12,
                ?13, ?14,
                ?15, ?16, ?17
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
        let day_start_ms = {
            let today = Utc::now().date_naive().and_hms_opt(0, 0, 0).unwrap();
            today.and_utc().timestamp_millis()
        };

        let conn = self
            .db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取数据库连接失败: {}", e)))?;

        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM fsrs_card_states", [], |r| r.get(0))
            .map_err(|e| AppError::database(e.to_string()))?;
        let due: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM fsrs_card_states WHERE suspended = 0 AND due_ms <= ?1",
                params![now_ms],
                |r| r.get(0),
            )
            .map_err(|e| AppError::database(e.to_string()))?;
        let new_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM fsrs_card_states WHERE state = 0 AND suspended = 0",
                [],
                |r| r.get(0),
            )
            .map_err(|e| AppError::database(e.to_string()))?;
        let learning: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM fsrs_card_states WHERE state = 1 AND suspended = 0",
                [],
                |r| r.get(0),
            )
            .map_err(|e| AppError::database(e.to_string()))?;
        let review: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM fsrs_card_states WHERE state = 2 AND suspended = 0",
                [],
                |r| r.get(0),
            )
            .map_err(|e| AppError::database(e.to_string()))?;
        let relearning: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM fsrs_card_states WHERE state = 3 AND suspended = 0",
                [],
                |r| r.get(0),
            )
            .map_err(|e| AppError::database(e.to_string()))?;
        let suspended: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM fsrs_card_states WHERE suspended = 1",
                [],
                |r| r.get(0),
            )
            .map_err(|e| AppError::database(e.to_string()))?;
        let reviews_today: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM fsrs_review_logs WHERE review_ms >= ?1",
                params![day_start_ms],
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

    fn load_state_by_id(
        conn: &rusqlite::Connection,
        id: &str,
    ) -> Result<Option<FsrsCardState>> {
        conn.query_row(
            "SELECT id, anki_card_id, deck_id, state, stability, difficulty,
                    elapsed_days, scheduled_days, reps, lapses, due_ms, last_review_ms,
                    suspended, fsrs_params_version, desired_retention, created_at, updated_at
             FROM fsrs_card_states WHERE id = ?1",
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
            "SELECT id, anki_card_id, deck_id, state, stability, difficulty,
                    elapsed_days, scheduled_days, reps, lapses, due_ms, last_review_ms,
                    suspended, fsrs_params_version, desired_retention, created_at, updated_at
             FROM fsrs_card_states WHERE anki_card_id = ?1",
            params![anki_card_id],
            Self::map_state_row,
        )
        .optional()
        .map_err(|e| AppError::database(format!("按 anki_card_id 加载失败: {}", e)))
    }
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
    let last_review = before
        .last_review_ms
        .map(ms_to_datetime)
        .unwrap_or(due);
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
}
