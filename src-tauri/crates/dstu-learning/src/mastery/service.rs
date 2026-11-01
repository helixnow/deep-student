//! Mastery 服务：record_event / recompute_state / weak_concepts / 画像回流

use std::cell::Cell;
use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use tracing::{debug, info, warn};

use crate::models::AppError;
use crate::vfs::database::VfsDatabase;

// 画像回流经扩展点（画像归 memory，见 profile_sink 模块文档）；保留 `learner_profile::` 调用写法。
use super::profile_sink::{
    self as learner_profile, MasteryWeakPointEvidence, WEAK_POINT_SOURCE_MASTERY,
};
use super::types::{
    MasteryEvent, MasteryOutcome, MasteryOverviewSummary, MasteryPriorityReviewItem, MasterySource,
    MasteryState, MasteryWeakEvidence,
};

/// EMA 学习率 α：score ← score + α·w·(target − score)
const EMA_ALPHA: f64 = 0.30;
/// 薄弱阈值：score < 此值且 total ≥ MIN_TOTAL_FOR_WEAK → upsert weak_point
pub const WEAK_SCORE_THRESHOLD: f64 = 0.5;
pub const MIN_TOTAL_FOR_WEAK: i32 = 3;
/// 掌握恢复阈值：score > 此值 → 移除 source=mastery 的 weak_point
pub const RECOVER_SCORE_THRESHOLD: f64 = 0.75;
/// 同 item 短时间重复正确信号衰减窗口
const ANTI_FARM_WINDOW_SECS: i64 = 60;
/// 窗口内第 k 次（0-based）正确信号权重：DECAY^k（k=0 → 1.0）
const ANTI_FARM_DECAY: f64 = 0.25;
const ANTI_FARM_WEIGHT_FLOOR: f64 = 0.05;

thread_local! {
    /// 测试时钟覆盖（Unix 毫秒）；生产路径为 None → Utc::now()
    static NOW_OVERRIDE_MS: Cell<Option<i64>> = const { Cell::new(None) };
}

/// 测试专用：覆盖 mastery 事件时间戳（毫秒）。传 None 清除。
///
/// app 等下游 crate 的单测经 dev-dependency 打开 `test-util` feature 使用。
#[cfg(any(test, feature = "test-util"))]
pub fn set_now_override_ms(ms: Option<i64>) {
    NOW_OVERRIDE_MS.with(|c| c.set(ms));
}

fn now_utc() -> DateTime<Utc> {
    NOW_OVERRIDE_MS.with(|c| {
        if let Some(ms) = c.get() {
            DateTime::from_timestamp_millis(ms).unwrap_or_else(Utc::now)
        } else {
            Utc::now()
        }
    })
}

fn clamp01(v: f64) -> f64 {
    v.clamp(0.0, 1.0)
}

/// 解析事件目标信号：优先 `signal` 列；旧数据 NULL 时按 outcome 回退。
///
/// A-P0 legacy：`outcome=rating` 且无 signal → 0.35（当时仅 Hard 走 rating）。
fn resolve_event_target(outcome: &str, signal: Option<f64>) -> f64 {
    if let Some(s) = signal {
        return clamp01(s);
    }
    match outcome {
        "correct" => 1.0,
        "wrong" => 0.0,
        "rating" => 0.35, // A-P0 Hard 固定 target
        _ => 0.5,
    }
}

/// 从题目标签解析 concept_key（优先首个非空 tag）
pub fn concept_key_from_tags(tags: &[String], fallback_item_id: &str) -> Option<String> {
    for tag in tags {
        let t = tag.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    if fallback_item_id.trim().is_empty() {
        None
    } else {
        Some(format!("item:{}", fallback_item_id.trim()))
    }
}

pub struct MasteryService {
    vfs_db: Arc<VfsDatabase>,
}

impl MasteryService {
    pub fn new(vfs_db: Arc<VfsDatabase>) -> Self {
        Self { vfs_db }
    }

    pub fn vfs_db(&self) -> &Arc<VfsDatabase> {
        &self.vfs_db
    }

    /// 题库作答后写入事件并回流画像（失败由调用方 warn，不阻断答题）
    pub fn record_qbank_answer(
        &self,
        question_id: &str,
        tags: &[String],
        is_correct: bool,
    ) -> Result<MasteryState, AppError> {
        let concept = concept_key_from_tags(tags, question_id)
            .ok_or_else(|| AppError::validation("mastery concept_key unavailable for question"))?;
        let outcome = if is_correct {
            MasteryOutcome::Correct
        } else {
            MasteryOutcome::Wrong
        };
        let state = self.record_event(MasterySource::Qbank, &concept, question_id, &outcome)?;
        self.sync_learner_profile(&state)?;
        Ok(state)
    }

    /// Atomically append the qbank event and refresh its aggregate using the
    /// caller's existing VFS transaction. Profile reflux remains post-commit.
    ///
    /// 幂等键 `me_qbank_{submission_id}` 只保证"首判恰好一次"；换判（true↔false）
    /// 必须走 [`Self::record_qbank_verdict_correction_with_conn`]，否则
    /// ON CONFLICT DO NOTHING 会把信号锁死在首判。
    pub fn record_qbank_answer_with_conn(
        &self,
        conn: &Connection,
        submission_id: &str,
        question_id: &str,
        tags: &[String],
        is_correct: bool,
    ) -> Result<MasteryState, AppError> {
        let concept = concept_key_from_tags(tags, question_id)
            .ok_or_else(|| AppError::validation("mastery concept_key unavailable for question"))?;
        let outcome = if is_correct {
            MasteryOutcome::Correct
        } else {
            MasteryOutcome::Wrong
        };
        let event_id = format!("me_qbank_{}", submission_id.trim());
        self.record_event_with_conn(
            conn,
            Some(&event_id),
            MasterySource::Qbank,
            &concept,
            question_id,
            &outcome,
        )
    }

    /// FSRS 评分后写入事件（卡片需有可用 tags；无 tags 时跳过并打日志）。
    ///
    /// A-P1 映射（写入 `outcome=rating` + `signal`）：
    /// Again→0.0，Hard→0.3，Good→0.8，Easy→1.0。
    pub fn record_fsrs_rating(
        &self,
        anki_card_id: &str,
        tags: &[String],
        rating: u8,
    ) -> Result<Option<MasteryState>, AppError> {
        let Some(concept) = tags
            .iter()
            .map(|t| t.trim())
            .find(|t| !t.is_empty())
            .map(|t| t.to_string())
        else {
            // A-P0：无 tags/concept 则跳过 mastery emit
            debug!(
                "[Mastery] skip FSRS emit: card {} has no usable tags",
                anki_card_id
            );
            return Ok(None);
        };
        let outcome = match rating {
            1..=4 => MasteryOutcome::Rating(rating),
            _ => {
                warn!(
                    "[Mastery] skip FSRS emit: invalid rating {} for card {}",
                    rating, anki_card_id
                );
                return Ok(None);
            }
        };
        let state = self.record_event(MasterySource::Fsrs, &concept, anki_card_id, &outcome)?;
        self.sync_learner_profile(&state)?;
        Ok(Some(state))
    }

    /// Idempotent FSRS compensation keyed by the committed review-log id.
    pub fn record_fsrs_rating_for_log(
        &self,
        review_log_id: &str,
        anki_card_id: &str,
        tags: &[String],
        rating: u8,
    ) -> Result<Option<MasteryState>, AppError> {
        let Some(concept) = concept_key_from_tags(tags, "") else {
            return Ok(None);
        };
        let outcome = match rating {
            1..=4 => MasteryOutcome::Rating(rating),
            _ => return Err(AppError::validation("FSRS rating must be 1..=4")),
        };
        let event_id = format!("me_fsrs_{}", review_log_id.trim());
        let mut conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| AppError::database(e.to_string()))?;
        let state = self.record_event_with_conn(
            &tx,
            Some(&event_id),
            MasterySource::Fsrs,
            &concept,
            anki_card_id,
            &outcome,
        )?;
        tx.commit().map_err(|e| AppError::database(e.to_string()))?;
        if let Err(error) = self.sync_learner_profile(&state) {
            warn!(
                "[Mastery] FSRS event committed but profile reflux failed for log {}: {}",
                review_log_id, error
            );
        }
        Ok(Some(state))
    }

    /// Idempotently tombstone the event produced by an undone FSRS review.
    pub fn revert_fsrs_rating_for_log(
        &self,
        review_log_id: &str,
    ) -> Result<Option<MasteryState>, AppError> {
        let event_id = format!("me_fsrs_{}", review_log_id.trim());
        let mut conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| AppError::database(e.to_string()))?;
        let concept: Option<String> = tx
            .query_row(
                "SELECT concept_key FROM mastery_events WHERE id = ?1",
                params![event_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| AppError::database(e.to_string()))?;
        let Some(concept) = concept else {
            tx.commit().map_err(|e| AppError::database(e.to_string()))?;
            return Ok(None);
        };
        let now = now_utc().to_rfc3339();
        tx.execute(
            "UPDATE mastery_events
             SET deleted_at = COALESCE(deleted_at, ?2), updated_at = ?2,
                 local_version = COALESCE(local_version, 0) + CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END
             WHERE id = ?1",
            params![event_id, now],
        )
        .map_err(|e| AppError::database(e.to_string()))?;
        let state = Self::recompute_state_with_conn(&tx, &concept)?;
        tx.commit().map_err(|e| AppError::database(e.to_string()))?;
        self.sync_learner_profile(&state)?;
        Ok(Some(state))
    }

    /// 换判纠正（供 qbank 判分原语调用，append-only）：解决
    /// `me_qbank_{submission_id}` + ON CONFLICT DO NOTHING 把换判停在首判信号的问题。
    ///
    /// 语义（参照 [`Self::revert_fsrs_rating_for_log`] 的 tombstone 范式）：
    /// 1. 软删该 submission 事件链上仍存活的旧事件（首判 `me_qbank_{sid}` 与历史修订
    ///    `_r{n}`）——只推进 `deleted_at/updated_at/local_version` 同步元数据，
    ///    不 UPDATE 旧事件的 outcome/signal 等语义列；
    /// 2. 追加修订事件 `me_qbank_{sid}_r{n+1}`（weight=1 直写，纠正不吃 60s 防刷衰减）；
    /// 3. `recompute_state_with_conn` 按存活事件重算新旧 concept 聚合。
    ///
    /// 幂等：
    /// - 存活末端事件方向已与 `new_is_correct` 一致 → 不追加，仅重算返回；
    /// - 修订 id 冲突（同一纠正在事务重放）→ ON CONFLICT DO NOTHING 兜底；
    /// - 链上无任何事件（如 AI 判分路从未写首判）→ 退化为首判 record。
    ///
    /// question_bank 侧已接线：`apply_submission_verdict_in_tx` 的换判分路
    /// （`Some(old) != new`）统一调本函数，覆盖人工改判外壳与 AI 管线落库段；
    /// 自持事务版 [`Self::record_qbank_verdict_correction`]（补偿脚本用）
    /// 也经由此实现，故本函数保持 pub。
    pub fn record_qbank_verdict_correction_with_conn(
        &self,
        conn: &Connection,
        submission_id: &str,
        question_id: &str,
        tags: &[String],
        new_is_correct: bool,
    ) -> Result<MasteryState, AppError> {
        struct ChainEvent {
            revision: u32,
            id: String,
            concept_key: String,
            outcome: String,
            deleted: bool,
        }

        let submission_id = submission_id.trim();
        let question_id = question_id.trim();
        if submission_id.is_empty() || question_id.is_empty() {
            return Err(AppError::validation(
                "mastery correction requires non-empty submission_id and question_id",
            ));
        }
        let concept = concept_key_from_tags(tags, question_id)
            .ok_or_else(|| AppError::validation("mastery concept_key unavailable for question"))?;
        let outcome = if new_is_correct {
            MasteryOutcome::Correct
        } else {
            MasteryOutcome::Wrong
        };
        let base_id = format!("me_qbank_{submission_id}");
        let revision_prefix = format!("{base_id}_r");

        // 事件链（含 tombstone）：base + 合法 `_r{digits}` 修订。
        // 用 substr 前缀匹配而非 LIKE，避免 submission_id 中 `_`/`%` 被当作通配符。
        let mut chain: Vec<ChainEvent> = Vec::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT id, concept_key, outcome, deleted_at FROM mastery_events
                     WHERE id = ?1 OR substr(id, 1, length(?2)) = ?2",
                )
                .map_err(|e| AppError::database(e.to_string()))?;
            let rows = stmt
                .query_map(params![base_id, revision_prefix], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                })
                .map_err(|e| AppError::database(e.to_string()))?;
            for row in rows {
                let (id, concept_key, outcome_db, deleted_at) =
                    row.map_err(|e| AppError::database(e.to_string()))?;
                let revision = if id == base_id {
                    0
                } else if let Some(suffix) = id.strip_prefix(&revision_prefix) {
                    match suffix.parse::<u32>() {
                        Ok(n) if n >= 1 => n,
                        // 其它 submission 恰以 `{sid}_r` 开头 → 非本链，跳过
                        _ => continue,
                    }
                } else {
                    continue;
                };
                chain.push(ChainEvent {
                    revision,
                    id,
                    concept_key,
                    outcome: outcome_db,
                    deleted: deleted_at.is_some(),
                });
            }
        }

        // 链上无事件（如 AI 判分路从未写首判）→ 退化为首判 record（含防刷权重）
        if chain.is_empty() {
            return self.record_event_with_conn(
                conn,
                Some(&base_id),
                MasterySource::Qbank,
                &concept,
                question_id,
                &outcome,
            );
        }

        // 幂等：存活末端事件方向未变 → 不追加纠正事件
        let latest_live = chain
            .iter()
            .filter(|event| !event.deleted)
            .max_by_key(|event| event.revision);
        if let Some(live) = latest_live {
            if live.outcome == outcome.as_db_str() {
                return Self::recompute_state_with_conn(conn, &concept);
            }
        }

        let now = now_utc().to_rfc3339();
        // tombstone 仍存活的旧事件（照抄 revert_fsrs_rating_for_log 的同步安全写法）
        let mut stale_concepts: Vec<String> = Vec::new();
        for event in chain.iter().filter(|event| !event.deleted) {
            conn.execute(
                "UPDATE mastery_events
                 SET deleted_at = COALESCE(deleted_at, ?2), updated_at = ?2,
                     local_version = COALESCE(local_version, 0) + CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END
                 WHERE id = ?1",
                params![event.id, now],
            )
            .map_err(|e| AppError::database(e.to_string()))?;
            if event.concept_key != concept && !stale_concepts.contains(&event.concept_key) {
                stale_concepts.push(event.concept_key.clone());
            }
        }

        let next_revision = chain.iter().map(|event| event.revision).max().unwrap_or(0) + 1;
        let correction_id = format!("{revision_prefix}{next_revision}");
        let signal = clamp01(outcome.target_signal());
        // weight=1 直写：换判纠正不套 compute_event_weight_with_conn 的 60s 防刷衰减
        conn.execute(
            "INSERT INTO mastery_events
                (id, created_at, source, concept_key, item_id, outcome, weight, signal, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1.0, ?7, ?2)
             ON CONFLICT(id) DO NOTHING",
            params![
                correction_id,
                now,
                MasterySource::Qbank.as_str(),
                concept,
                question_id,
                outcome.as_db_str(),
                signal,
            ],
        )
        .map_err(|e| AppError::database(format!("insert mastery correction event: {e}")))?;

        // 旧事件可能挂在不同 concept（tags 漂移）：一并重算防止残留旧聚合
        for stale in &stale_concepts {
            Self::recompute_state_with_conn(conn, stale)?;
        }
        let state = Self::recompute_state_with_conn(conn, &concept)?;
        info!(
            "[Mastery] qbank verdict corrected submission={} -> {} ({}) concept={} score={:.3} total={}",
            submission_id,
            outcome.as_db_str(),
            correction_id,
            concept,
            state.score,
            state.total
        );
        Ok(state)
    }

    /// 自持事务版换判纠正：判分事务之外亦可直接调用（如补偿脚本）。
    /// 事务提交后回流画像；回流失败仅告警，不回滚已提交纠正
    /// （与 [`Self::record_fsrs_rating_for_log`] 同口径）。
    pub fn record_qbank_verdict_correction(
        &self,
        submission_id: &str,
        question_id: &str,
        tags: &[String],
        new_is_correct: bool,
    ) -> Result<MasteryState, AppError> {
        let mut conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| AppError::database(e.to_string()))?;
        let state = self.record_qbank_verdict_correction_with_conn(
            &tx,
            submission_id,
            question_id,
            tags,
            new_is_correct,
        )?;
        tx.commit().map_err(|e| AppError::database(e.to_string()))?;
        if let Err(error) = self.sync_learner_profile(&state) {
            warn!(
                "[Mastery] qbank correction committed but profile reflux failed for submission {}: {}",
                submission_id, error
            );
        }
        Ok(state)
    }

    /// 写入一条事件并重算该 concept 的聚合状态
    pub fn record_event(
        &self,
        source: MasterySource,
        concept_key: &str,
        item_id: &str,
        outcome: &MasteryOutcome,
    ) -> Result<MasteryState, AppError> {
        let concept_key = concept_key.trim();
        let item_id = item_id.trim();
        if concept_key.is_empty() || item_id.is_empty() {
            return Err(AppError::validation(
                "mastery concept_key and item_id must be non-empty",
            ));
        }

        let mut conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| AppError::database(e.to_string()))?;
        let state =
            self.record_event_with_conn(&tx, None, source, concept_key, item_id, outcome)?;
        tx.commit().map_err(|e| AppError::database(e.to_string()))?;
        Ok(state)
    }

    fn record_event_with_conn(
        &self,
        conn: &Connection,
        event_id: Option<&str>,
        source: MasterySource,
        concept_key: &str,
        item_id: &str,
        outcome: &MasteryOutcome,
    ) -> Result<MasteryState, AppError> {
        let concept_key = concept_key.trim();
        let item_id = item_id.trim();
        if concept_key.is_empty() || item_id.is_empty() {
            return Err(AppError::validation(
                "mastery concept_key and item_id must be non-empty",
            ));
        }
        let now = now_utc();
        let created_at = now.to_rfc3339();
        let weight =
            Self::compute_event_weight_with_conn(conn, concept_key, item_id, outcome, now)?;
        let signal = clamp01(outcome.target_signal());
        let id = event_id
            .map(str::to_string)
            .unwrap_or_else(|| format!("me_{}", nanoid::nanoid!(12)));
        let outcome_db = outcome.as_db_str();
        conn.execute(
            "INSERT INTO mastery_events
                (id, created_at, source, concept_key, item_id, outcome, weight, signal, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?2)
             ON CONFLICT(id) DO NOTHING",
            params![
                id,
                created_at,
                source.as_str(),
                concept_key,
                item_id,
                outcome_db,
                weight,
                signal,
            ],
        )
        .map_err(|e| AppError::database(format!("insert mastery_events: {e}")))?;
        let state = Self::recompute_state_with_conn(conn, concept_key)?;
        info!(
            "[Mastery] recorded {}/{} concept={} score={:.3} total={}",
            source.as_str(),
            outcome_db,
            concept_key,
            state.score,
            state.total
        );
        Ok(state)
    }

    /// 防刷分权重：同 item 在 ANTI_FARM_WINDOW 内的重复正确/正向信号指数衰减
    fn compute_event_weight_with_conn(
        conn: &Connection,
        concept_key: &str,
        item_id: &str,
        outcome: &MasteryOutcome,
        now: DateTime<Utc>,
    ) -> Result<f64, AppError> {
        if !outcome.is_positive() {
            return Ok(1.0);
        }
        let window_start = (now - Duration::seconds(ANTI_FARM_WINDOW_SECS)).to_rfc3339();
        // 正向信号：correct，或 rating/signal≥0.5（Good/Easy）；兼容无 signal 的旧 rating
        let prior: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM mastery_events
                 WHERE concept_key = ?1 AND item_id = ?2
                   AND deleted_at IS NULL
                   AND created_at >= ?3
                   AND weight > 0
                   AND (
                     outcome = 'correct'
                     OR (outcome = 'rating' AND COALESCE(signal, 0.35) >= 0.5)
                   )",
                params![concept_key, item_id, window_start],
                |row| row.get(0),
            )
            .unwrap_or(0);
        // 窗口内已有 k 次正向 → 本次为第 k 次衰减（0-based power）
        let weight = ANTI_FARM_DECAY
            .powi(prior as i32)
            .max(ANTI_FARM_WEIGHT_FLOOR);
        Ok(weight)
    }

    ///
    /// # Score 公式（可解释 EMA）
    ///
    /// 初始 `score = 0.5`。按事件时间序回放：
    /// ```text
    /// target = COALESCE(signal, legacy_fallback(outcome))
    ///          // A-P1 signal: Again=0, Hard≈0.3, Good≈0.8, Easy=1
    ///          // legacy NULL signal: correct→1, wrong→0, rating→0.35 (A-P0 Hard)
    /// score  ← score + α · weight · (target − score)
    ///        = (1 − α·w)·score + (α·w)·target     // α = 0.30
    /// ```
    /// `weight` 在写入时已含同 item 60s 内重复正向信号衰减（0.25^k，下限 0.05）。
    ///
    pub fn recompute_state(&self, concept_key: &str) -> Result<MasteryState, AppError> {
        let mut conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| AppError::database(e.to_string()))?;
        let state = Self::recompute_state_with_conn(&tx, concept_key)?;
        tx.commit().map_err(|e| AppError::database(e.to_string()))?;
        Ok(state)
    }

    fn recompute_state_with_conn(
        conn: &Connection,
        concept_key: &str,
    ) -> Result<MasteryState, AppError> {
        let mut stmt = conn
            .prepare(
                "SELECT outcome, weight, created_at, signal FROM mastery_events
                 WHERE concept_key = ?1
                   AND deleted_at IS NULL
                 ORDER BY created_at ASC, id ASC",
            )
            .map_err(|e| AppError::database(e.to_string()))?;

        let rows = stmt
            .query_map(params![concept_key], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<f64>>(3)?,
                ))
            })
            .map_err(|e| AppError::database(e.to_string()))?;

        let mut score = 0.5_f64;
        let mut streak: i32 = 0;
        let mut total: i32 = 0;
        let mut wrong_count: i32 = 0;
        let mut last_signal_at: Option<String> = None;

        for row in rows {
            let (outcome_str, weight, created_at, signal) =
                row.map_err(|e| AppError::database(e.to_string()))?;
            let target = resolve_event_target(&outcome_str, signal);
            let w = weight.clamp(0.0, 1.0);
            let alpha_w = (EMA_ALPHA * w).clamp(0.0, 1.0);
            score = clamp01(score + alpha_w * (target - score));
            total += 1;
            last_signal_at = Some(created_at);
            if target < 0.5 {
                wrong_count += 1;
                streak = 0;
            } else {
                streak = streak.saturating_add(1);
            }
        }

        conn.execute(
            "INSERT INTO mastery_states (concept_key, score, streak, total, wrong_count, last_signal_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(concept_key) DO UPDATE SET
               score = excluded.score,
               streak = excluded.streak,
               total = excluded.total,
               wrong_count = excluded.wrong_count,
               last_signal_at = excluded.last_signal_at",
            params![
                concept_key,
                score,
                streak,
                total,
                wrong_count,
                last_signal_at,
            ],
        )
        .map_err(|e| AppError::database(format!("upsert mastery_states: {e}")))?;

        Ok(MasteryState {
            concept_key: concept_key.to_string(),
            score,
            streak,
            total,
            wrong_count,
            last_signal_at,
        })
    }

    /// Rebuild all derived aggregates after cloud-sync applies source events.
    pub fn recompute_all_states_with_conn(conn: &Connection) -> Result<usize, AppError> {
        let concepts = {
            let mut stmt = conn
                .prepare(
                    "SELECT concept_key FROM mastery_states
                     UNION
                     SELECT concept_key FROM mastery_events
                     ORDER BY concept_key",
                )
                .map_err(|e| AppError::database(e.to_string()))?;
            let concepts = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| AppError::database(e.to_string()))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| AppError::database(e.to_string()))?;
            concepts
        };
        for concept in &concepts {
            Self::recompute_state_with_conn(conn, concept)?;
        }
        Ok(concepts.len())
    }

    /// Reconcile deterministic learner-profile weak points from all aggregates.
    /// Call only after releasing any raw VFS connection held by sync.
    pub fn sync_all_learner_profiles(&self) -> Result<usize, AppError> {
        let states = {
            let conn = self
                .vfs_db
                .get_conn_safe()
                .map_err(|e| AppError::database(e.to_string()))?;
            let mut stmt = conn
                .prepare(
                    "SELECT concept_key, score, streak, total, wrong_count, last_signal_at
                     FROM mastery_states ORDER BY concept_key",
                )
                .map_err(|e| AppError::database(e.to_string()))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(MasteryState {
                        concept_key: row.get(0)?,
                        score: row.get(1)?,
                        streak: row.get(2)?,
                        total: row.get(3)?,
                        wrong_count: row.get(4)?,
                        last_signal_at: row.get(5)?,
                    })
                })
                .map_err(|e| AppError::database(e.to_string()))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| AppError::database(e.to_string()))?
        };
        for state in &states {
            self.sync_learner_profile(state)?;
        }
        Ok(states.len())
    }

    pub fn get_state(&self, concept_key: &str) -> Result<Option<MasteryState>, AppError> {
        let conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        conn.query_row(
            "SELECT concept_key, score, streak, total, wrong_count, last_signal_at
             FROM mastery_states WHERE concept_key = ?1",
            params![concept_key],
            |row| {
                Ok(MasteryState {
                    concept_key: row.get(0)?,
                    score: row.get(1)?,
                    streak: row.get(2)?,
                    total: row.get(3)?,
                    wrong_count: row.get(4)?,
                    last_signal_at: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(|e| AppError::database(e.to_string()))
    }

    /// 薄弱概念：score < 阈值且 total ≥ 最小样本
    pub fn weak_concepts(&self, limit: usize) -> Result<Vec<MasteryState>, AppError> {
        let conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        let mut stmt = conn
            .prepare(
                "SELECT concept_key, score, streak, total, wrong_count, last_signal_at
                 FROM mastery_states
                 WHERE score < ?1 AND total >= ?2
                 ORDER BY score ASC, wrong_count DESC
                 LIMIT ?3",
            )
            .map_err(|e| AppError::database(e.to_string()))?;
        let rows = stmt
            .query_map(
                params![WEAK_SCORE_THRESHOLD, MIN_TOTAL_FOR_WEAK, limit as i64],
                |row| {
                    Ok(MasteryState {
                        concept_key: row.get(0)?,
                        score: row.get(1)?,
                        streak: row.get(2)?,
                        total: row.get(3)?,
                        wrong_count: row.get(4)?,
                        last_signal_at: row.get(5)?,
                    })
                },
            )
            .map_err(|e| AppError::database(e.to_string()))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| AppError::database(e.to_string()))?);
        }
        Ok(out)
    }

    pub fn overview_summary(
        &self,
        weakest_limit: usize,
    ) -> Result<MasteryOverviewSummary, AppError> {
        let conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        let (concept_count, weak_count, avg_score): (i64, i64, f64) = conn
            .query_row(
                "SELECT
                    COUNT(*),
                    COALESCE(SUM(CASE WHEN score < ?1 AND total >= ?2 THEN 1 ELSE 0 END), 0),
                    COALESCE(AVG(score), 0.0)
                 FROM mastery_states",
                params![WEAK_SCORE_THRESHOLD, MIN_TOTAL_FOR_WEAK],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|e| AppError::database(e.to_string()))?;
        let weakest = self.weak_concepts(weakest_limit)?;
        let today_priority_review = self.today_priority_review(weakest_limit.min(5))?;
        Ok(MasteryOverviewSummary {
            concept_count,
            weak_count,
            avg_score,
            weakest,
            today_priority_review,
        })
    }

    /// 掌握度驱动的今日优先复习摘要（薄弱概念按 score 升序）
    pub fn today_priority_review(
        &self,
        limit: usize,
    ) -> Result<Vec<MasteryPriorityReviewItem>, AppError> {
        let weak = self.weak_concepts(limit)?;
        Ok(weak
            .into_iter()
            .enumerate()
            .map(|(i, s)| MasteryPriorityReviewItem {
                concept_key: s.concept_key.clone(),
                score: s.score,
                total: s.total,
                wrong_count: s.wrong_count,
                priority: (i as u32) + 1,
                reason: format!(
                    "掌握度 {score:.0}%（样本 {total}，错 {wrong}）— 建议优先复习同概念闪卡",
                    score = s.score * 100.0,
                    total = s.total,
                    wrong = s.wrong_count
                ),
                due_card_count: None,
            })
            .collect())
    }

    /// 确定性回流 learner_profile（不经 LLM）
    pub fn sync_learner_profile(&self, state: &MasteryState) -> Result<(), AppError> {
        if state.score < WEAK_SCORE_THRESHOLD && state.total >= MIN_TOTAL_FOR_WEAK {
            let evidence = MasteryWeakEvidence {
                concept_key: state.concept_key.clone(),
                score: state.score,
                total: state.total,
                wrong_count: state.wrong_count,
                recent_wrong_summary: self.recent_wrong_summary(&state.concept_key, 3)?,
            };
            learner_profile::upsert_weak_point_from_mastery(
                &self.vfs_db,
                &state.concept_key,
                &MasteryWeakPointEvidence {
                    score: evidence.score,
                    total: evidence.total,
                    wrong_count: evidence.wrong_count,
                    recent_wrong_summary: evidence.recent_wrong_summary,
                },
            )
            .map_err(|e| AppError::database(e.to_string()))?;
            debug!(
                "[Mastery] upserted weak_point source={} concept={}",
                WEAK_POINT_SOURCE_MASTERY, state.concept_key
            );
        } else if state.total == 0 || state.score > RECOVER_SCORE_THRESHOLD {
            learner_profile::remove_weak_point_from_mastery(&self.vfs_db, &state.concept_key)
                .map_err(|e| AppError::database(e.to_string()))?;
            debug!(
                "[Mastery] removed/recovered weak_point concept={} score={:.3}",
                state.concept_key, state.score
            );
        }
        Ok(())
    }

    fn recent_wrong_summary(&self, concept_key: &str, limit: usize) -> Result<String, AppError> {
        let conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        let mut stmt = conn
            .prepare(
                "SELECT item_id, created_at FROM mastery_events
                 WHERE concept_key = ?1 AND outcome = 'wrong'
                   AND deleted_at IS NULL
                 ORDER BY created_at DESC LIMIT ?2",
            )
            .map_err(|e| AppError::database(e.to_string()))?;
        let rows = stmt
            .query_map(params![concept_key, limit as i64], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| AppError::database(e.to_string()))?;
        let mut parts = Vec::new();
        for row in rows {
            let (item_id, at) = row.map_err(|e| AppError::database(e.to_string()))?;
            parts.push(format!("{item_id}@{at}"));
        }
        if parts.is_empty() {
            Ok(format!("concept={concept_key}; recent wrongs: (none)"))
        } else {
            Ok(format!(
                "concept={concept_key}; recent wrongs: {}",
                parts.join(", ")
            ))
        }
    }

    pub fn list_events(
        &self,
        concept_key: &str,
        limit: usize,
    ) -> Result<Vec<MasteryEvent>, AppError> {
        let conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, created_at, source, concept_key, item_id, outcome, weight, signal
                 FROM mastery_events WHERE concept_key = ?1 AND deleted_at IS NULL
                 ORDER BY created_at DESC LIMIT ?2",
            )
            .map_err(|e| AppError::database(e.to_string()))?;
        let rows = stmt
            .query_map(params![concept_key, limit as i64], |row| {
                let source_str: String = row.get(2)?;
                Ok(MasteryEvent {
                    id: row.get(0)?,
                    created_at: row.get(1)?,
                    source: MasterySource::parse(&source_str).unwrap_or(MasterySource::Qbank),
                    concept_key: row.get(3)?,
                    item_id: row.get(4)?,
                    outcome: row.get(5)?,
                    weight: row.get(6)?,
                    signal: row.get(7)?,
                })
            })
            .map_err(|e| AppError::database(e.to_string()))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| AppError::database(e.to_string()))?);
        }
        Ok(out)
    }
}
