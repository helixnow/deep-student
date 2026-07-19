//! Mastery 服务：record_event / recompute_state / weak_concepts / 画像回流

use std::cell::Cell;
use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use tracing::{debug, info, warn};

use crate::memory::learner_profile::{self, MasteryWeakPointEvidence, WEAK_POINT_SOURCE_MASTERY};
use crate::models::AppError;
use crate::vfs::database::VfsDatabase;

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
#[cfg(test)]
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
    pub(crate) fn recompute_all_states_with_conn(conn: &Connection) -> Result<usize, AppError> {
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
    pub(crate) fn sync_all_learner_profiles(&self) -> Result<usize, AppError> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data_governance::migration::MigrationCoordinator;
    use crate::data_governance::schema_registry::DatabaseId;
    use crate::database::Database;
    use crate::fsrs_review_service::FsrsReviewService;
    use crate::mastery::bias::{apply_mastery_due_bias, mastery_due_bias_delta_ms, MAX_ADVANCE_MS};
    use crate::memory::learner_profile::load_profile_from_db;
    use crate::question_bank_service::QuestionBankService;
    use crate::vfs::repos::{CreateQuestionParams, QuestionType, VfsQuestionRepo};
    use rusqlite::params;

    const MS_PER_DAY: i64 = 86_400_000;

    fn setup() -> (tempfile::TempDir, Arc<VfsDatabase>, MasteryService) {
        let (temp_dir, db) = crate::vfs::database::setup_migrated_test_db();
        let vfs_db = Arc::new(db);
        let svc = MasteryService::new(vfs_db.clone());
        (temp_dir, vfs_db, svc)
    }

    fn setup_mistakes_db() -> (tempfile::TempDir, Arc<Database>) {
        let temp_dir = tempfile::TempDir::new().expect("fsrs temp");
        let root = temp_dir.path().to_path_buf();
        let mut coordinator = MigrationCoordinator::new(root.clone()).with_audit_db(None);
        coordinator
            .migrate_single(DatabaseId::Mistakes)
            .expect("migrate mistakes");
        let db = Arc::new(Database::new(&root.join("mistakes.db")).expect("open mistakes"));
        (temp_dir, db)
    }

    fn seed_question(vfs_db: &VfsDatabase, tag: &str) -> String {
        seed_question_labeled(vfs_db, tag, "Q1", "1+1=?", "2")
    }

    fn seed_question_labeled(
        vfs_db: &VfsDatabase,
        tag: &str,
        label: &str,
        content: &str,
        answer: &str,
    ) -> String {
        let exam_id = format!("exam_{}", nanoid::nanoid!(6));
        let conn = vfs_db.get_conn_safe().expect("conn");
        conn.execute(
            "INSERT INTO exam_sheets (
                id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at
             ) VALUES (?1, 'mastery e2e', 'completed', ?2, '{}', '{}', ?3, ?3)",
            params![exam_id, format!("temp_{exam_id}"), "2020-01-01T00:00:00Z"],
        )
        .expect("exam");
        drop(conn);
        let q = VfsQuestionRepo::create_question(
            vfs_db,
            &CreateQuestionParams {
                exam_id,
                card_id: None,
                question_label: Some(label.into()),
                content: content.into(),
                options: None,
                answer: Some(answer.into()),
                explanation: None,
                question_type: Some(QuestionType::FillBlank),
                difficulty: None,
                tags: Some(vec![tag.to_string()]),
                source_type: None,
                source_ref: None,
                images: None,
                parent_id: None,
            },
        )
        .expect("create question");
        q.id
    }

    fn enqueue_review_state(db: &Arc<Database>, card_id: &str) -> String {
        let service = FsrsReviewService::new(db.clone());
        let enq = service
            .enqueue_cards(&[card_id.to_string()])
            .expect("enqueue");
        let state_id = enq.states[0].id.clone();
        let seed_now = Utc::now().timestamp_millis();
        {
            let conn = db.get_conn_safe().expect("conn");
            conn.execute(
                "UPDATE fsrs_card_states SET
                    state = 2, stability = 10.0, difficulty = 5.0,
                    scheduled_days = 10.0, reps = 5, lapses = 0,
                    due_ms = ?1, last_review_ms = ?2, suspended = 0
                 WHERE id = ?3",
                params![seed_now, seed_now - 10 * MS_PER_DAY, state_id],
            )
            .expect("seed review state");
        }
        state_id
    }

    /// C5-1/2：submit_answer 连错 → mastery_states/weak_point → FSRS due 提前；
    /// 连对恢复 → weak_point 移除 → due 不再异常提前。
    #[test]
    fn e2e_submit_wrong_thrice_lowers_score_and_upserts_weak_point_then_recovers() {
        let (_tmp, vfs_db, _) = setup();
        let (_tmp_fsrs, fsrs_db) = setup_mistakes_db();
        let concept = "二次函数";
        let qid = seed_question(&vfs_db, concept);
        let qbank = QuestionBankService::new(vfs_db.clone());

        // Seed same-concept FSRS review card (mistakes.db)
        {
            let conn = fsrs_db.get_conn_safe().expect("conn");
            conn.execute(
                "INSERT INTO document_tasks (
                    id, document_id, original_document_name, segment_index,
                    content_segment, status, anki_generation_options_json
                 ) VALUES ('task_e2e', 'doc_e2e', 't.md', 0, 'seg', 'Completed', '{}')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO anki_cards (
                    id, task_id, front, back, source_type, source_id, tags_json
                 ) VALUES ('card_e2e_lo', 'task_e2e', 'f', 'b', 'document', 'doc_e2e', ?1)",
                params![serde_json::to_string(&vec![concept]).unwrap()],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO anki_cards (
                    id, task_id, front, back, source_type, source_id, tags_json
                 ) VALUES ('card_e2e_hi', 'task_e2e', 'f2', 'b2', 'document', 'doc_e2e', ?1)",
                params![serde_json::to_string(&vec![concept]).unwrap()],
            )
            .unwrap();
        }
        let state_lo = enqueue_review_state(&fsrs_db, "card_e2e_lo");
        let state_hi = enqueue_review_state(&fsrs_db, "card_e2e_hi");
        let fsrs = FsrsReviewService::new(fsrs_db.clone());

        let mut t0 = Utc::now().timestamp_millis();
        set_now_override_ms(Some(t0));

        for i in 0..3 {
            t0 += 120_000; // 2 min apart — 避免防刷影响错误信号
            set_now_override_ms(Some(t0));
            let r = qbank
                .submit_answer(&qid, "wrong", Some(false), Some(&format!("w{i}")))
                .expect("submit wrong");
            assert_eq!(r.is_correct, Some(false));
        }

        // 终态表：mastery_events / mastery_states
        {
            let conn = vfs_db.get_conn_safe().unwrap();
            let event_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM mastery_events
                     WHERE concept_key = ?1 AND outcome = 'wrong' AND source = 'qbank'",
                    params![concept],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(event_count, 3);
            let (score, total, wrong_count): (f64, i32, i32) = conn
                .query_row(
                    "SELECT score, total, wrong_count FROM mastery_states WHERE concept_key = ?1",
                    params![concept],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
            assert!(
                score < WEAK_SCORE_THRESHOLD,
                "mastery_states.score should be < {WEAK_SCORE_THRESHOLD}, got {score}"
            );
            assert!(total >= MIN_TOTAL_FOR_WEAK);
            assert!(wrong_count >= 3);
        }

        let mastery = MasteryService::new(vfs_db.clone());
        let state = mastery
            .get_state(concept)
            .expect("get state")
            .expect("state exists");
        // 3× wrong EMA：0.5 → 0.35 → 0.245 → 0.1715
        assert!(
            (state.score - 0.1715).abs() < 1e-9,
            "expected deterministic EMA after 3 wrongs ≈0.1715, got {}",
            state.score
        );

        let profile = load_profile_from_db(&vfs_db)
            .expect("load profile")
            .expect("profile should exist after reflux");
        let wp = profile
            .weak_points
            .iter()
            .find(|w| w.knowledge_point == concept)
            .expect("weak_point for 二次函数");
        assert_eq!(wp.source.as_deref(), Some(WEAK_POINT_SOURCE_MASTERY));
        assert!(
            wp.error_pattern.contains(concept) || wp.error_pattern.contains("wrong"),
            "evidence should mention concept/errors: {}",
            wp.error_pattern
        );

        // FSRS due：用真实 mastery_states.score 偏置同 concept 卡片
        let low_score = state.score;
        // 先无偏置对照，再低掌握偏置（两卡同 Review seed）
        let baseline = fsrs
            .rate_with_mastery_bias(&state_hi, 3, Some(10), None, None)
            .expect("baseline rate");
        let rate_lo = fsrs
            .rate_with_mastery_bias(&state_lo, 3, Some(10), Some(low_score), None)
            .expect("rate low mastery");
        let now_ms = Utc::now().timestamp_millis();
        let fsrs_interval = baseline.due_ms.saturating_sub(now_ms);
        assert!(
            fsrs_interval >= 60 * 60 * 1000,
            "need biasable review interval, got {fsrs_interval}"
        );
        let expected_delta = mastery_due_bias_delta_ms(low_score, fsrs_interval);
        assert!(
            expected_delta < 0,
            "formula must advance low mastery; delta={expected_delta}"
        );
        assert!(
            expected_delta.abs() <= MAX_ADVANCE_MS,
            "formula advance must respect 3-day cap"
        );
        let advance = baseline.due_ms.saturating_sub(rate_lo.due_ms);
        assert!(
            advance > 60_000,
            "same-concept FSRS due must advance >1min under low mastery; \
             baseline={} biased={} advance={}",
            baseline.due_ms,
            rate_lo.due_ms,
            advance
        );
        assert!(
            advance <= MAX_ADVANCE_MS + 5_000,
            "persisted advance {advance} must respect 3-day cap {MAX_ADVANCE_MS}"
        );
        // 可断言量：与公式 |delta| 接近（允许评分时钟漂移 ≤30s）
        assert!(
            (advance as i64 - expected_delta.abs()).abs() < 30_000,
            "advance {advance} should ≈ |formula delta| {} (score={low_score}, interval={fsrs_interval})",
            expected_delta.abs()
        );
        // 终态表：fsrs_card_states.due_ms 已写入偏置值
        {
            let conn = fsrs_db.get_conn_safe().unwrap();
            let due_persisted: i64 = conn
                .query_row(
                    "SELECT due_ms FROM fsrs_card_states WHERE id = ?1",
                    params![state_lo],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(due_persisted, rate_lo.due_ms);
        }

        // 连续答对恢复
        for i in 0..8 {
            t0 += 90_000;
            set_now_override_ms(Some(t0));
            let r = qbank
                .submit_answer(&qid, "2", Some(true), Some(&format!("c{i}")))
                .expect("submit correct");
            assert_eq!(r.is_correct, Some(true));
        }
        set_now_override_ms(None);

        let state_after = mastery
            .get_state(concept)
            .expect("get state")
            .expect("state");
        assert!(
            state_after.score > RECOVER_SCORE_THRESHOLD,
            "score should recover above {}, got {}",
            RECOVER_SCORE_THRESHOLD,
            state_after.score
        );

        let profile_after = load_profile_from_db(&vfs_db)
            .expect("load")
            .unwrap_or_default();
        assert!(
            !profile_after
                .weak_points
                .iter()
                .any(|w| w.knowledge_point == concept
                    && w.source.as_deref() == Some(WEAK_POINT_SOURCE_MASTERY)),
            "mastery weak_point should be removed after recovery; left={:?}",
            profile_after
                .weak_points
                .iter()
                .map(|w| (&w.knowledge_point, &w.source))
                .collect::<Vec<_>>()
        );

        // 恢复后：同 score 偏置不应再「异常提前」（高分 → due ≥ 无偏置）
        let high_score = state_after.score;
        let synthetic_now = 1_700_000_000_000_i64;
        let synthetic_fsrs_due = synthetic_now + 10 * MS_PER_DAY;
        let recovered_due = apply_mastery_due_bias(high_score, synthetic_now, synthetic_fsrs_due);
        assert!(
            recovered_due >= synthetic_fsrs_due,
            "recovered mastery must not abnormally advance due: score={high_score} due={recovered_due} fsrs={synthetic_fsrs_due}"
        );
    }

    /// C5-3：同题 1 分钟内连对 5 次，score 增幅显著小于 5 道独立题。
    #[test]
    fn anti_farm_same_item_rapid_corrects_gain_less_than_independent() {
        let (_tmp, vfs_db, _) = setup();
        let qbank = QuestionBankService::new(vfs_db.clone());
        let mastery = MasteryService::new(vfs_db.clone());

        let concept_ind = "牛顿定律_ind";
        let concept_farm = "牛顿定律_farm";
        let mut ind_ids = Vec::new();
        for i in 0..5 {
            ind_ids.push(seed_question_labeled(
                &vfs_db,
                concept_ind,
                &format!("Qi{i}"),
                &format!("q{i}?"),
                "ok",
            ));
        }
        let farm_qid = seed_question_labeled(&vfs_db, concept_farm, "Qf", "farm?", "ok");

        let t_base = Utc::now().timestamp_millis();
        set_now_override_ms(Some(t_base));
        for (i, qid) in ind_ids.iter().enumerate() {
            set_now_override_ms(Some(t_base + i as i64 * 1_000));
            qbank
                .submit_answer(qid, "ok", Some(true), Some(&format!("ind{i}")))
                .expect("independent correct");
        }
        let score_independent = mastery.get_state(concept_ind).unwrap().unwrap().score;
        let gain_independent = score_independent - 0.5;

        set_now_override_ms(Some(t_base + 1_000_000));
        for i in 0..5 {
            set_now_override_ms(Some(t_base + 1_000_000 + i * 5_000)); // 5s apart, same 60s window
            qbank
                .submit_answer(&farm_qid, "ok", Some(true), Some(&format!("farm{i}")))
                .expect("farm correct");
        }
        set_now_override_ms(None);
        let score_farm = mastery.get_state(concept_farm).unwrap().unwrap().score;
        let gain_farm = score_farm - 0.5;

        assert!(
            gain_farm < gain_independent * 0.55,
            "farmed gain ({gain_farm:.4}) should be significantly < independent ({gain_independent:.4})"
        );

        // 终态：mastery_events.weight 首条=1，后续衰减
        let events = mastery.list_events(concept_farm, 10).unwrap();
        let weights: Vec<f64> = events.iter().map(|e| e.weight).collect();
        assert!(weights.iter().copied().any(|w| w < 0.3));
        assert!(weights.iter().copied().any(|w| (w - 1.0).abs() < 1e-9));

        let conn = vfs_db.get_conn_safe().unwrap();
        let min_w: f64 = conn
            .query_row(
                "SELECT MIN(weight) FROM mastery_events WHERE concept_key = ?1",
                params![concept_farm],
                |row| row.get(0),
            )
            .unwrap();
        assert!(min_w <= 0.05 + 1e-9 || min_w < 0.3);
    }

    /// C5-4：Again/Hard/Good/Easy → mastery_events.signal = 0/0.3/0.8/1.0
    #[test]
    fn fsrs_rating_signals_are_differentiated() {
        let (_tmp, vfs, svc) = setup();
        let t0 = Utc::now().timestamp_millis();
        set_now_override_ms(Some(t0));

        for (i, rating) in [1u8, 2, 3, 4].into_iter().enumerate() {
            set_now_override_ms(Some(t0 + (i as i64 + 1) * 120_000));
            svc.record_fsrs_rating(&format!("card_sig_{rating}"), &["微积分".into()], rating)
                .expect("record")
                .expect("state");
        }
        set_now_override_ms(None);

        // 终态表：mastery_events.signal 精确落值
        let conn = vfs.get_conn_safe().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT signal FROM mastery_events
                 WHERE concept_key = '微积分' AND outcome = 'rating'
                 ORDER BY signal ASC",
            )
            .unwrap();
        let signals: Vec<f64> = stmt
            .query_map([], |row| row.get::<_, f64>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(signals.len(), 4);
        assert!(
            (signals[0] - 0.0).abs() < 1e-9
                && (signals[1] - 0.3).abs() < 1e-9
                && (signals[2] - 0.8).abs() < 1e-9
                && (signals[3] - 1.0).abs() < 1e-9,
            "expected Again/Hard/Good/Easy signals 0/0.3/0.8/1.0, got {signals:?}"
        );

        // Hard < Good < Easy 对 score 的拉动应可区分
        let mut scores = Vec::new();
        for (label, rating) in [("h", 2u8), ("g", 3u8), ("e", 4u8)] {
            let concept = format!("sig_{label}");
            set_now_override_ms(Some(t0 + 1_000_000));
            let st = svc
                .record_fsrs_rating(&format!("c_{label}"), &[concept.clone()], rating)
                .unwrap()
                .unwrap();
            scores.push(st.score);
        }
        set_now_override_ms(None);
        assert!(
            scores[0] < scores[1] && scores[1] < scores[2],
            "Hard score < Good < Easy, got {scores:?}"
        );
    }

    #[test]
    fn fsrs_review_log_compensation_is_idempotent() {
        let (_tmp, vfs, svc) = setup();
        for _ in 0..2 {
            svc.record_fsrs_rating_for_log("log_exactly_once", "card_once", &["概率论".into()], 3)
                .unwrap();
        }
        let conn = vfs.get_conn_safe().unwrap();
        let event_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM mastery_events WHERE id = 'me_fsrs_log_exactly_once'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(event_count, 1);
        let total: i32 = conn
            .query_row(
                "SELECT total FROM mastery_states WHERE concept_key = '概率论'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(total, 1);
        drop(conn);

        let reverted = svc
            .revert_fsrs_rating_for_log("log_exactly_once")
            .unwrap()
            .unwrap();
        assert_eq!(reverted.total, 0);
        let conn = vfs.get_conn_safe().unwrap();
        let deleted_at: Option<String> = conn
            .query_row(
                "SELECT deleted_at FROM mastery_events WHERE id = 'me_fsrs_log_exactly_once'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(deleted_at.is_some());
    }

    #[test]
    fn remote_tombstones_rebuild_zero_state_and_remove_weak_point() {
        let (_tmp, vfs, svc) = setup();
        let concept = "remote-tombstone-concept";
        for index in 0..3 {
            svc.record_qbank_answer(
                &format!("remote-question-{index}"),
                &[concept.to_string()],
                false,
            )
            .unwrap();
        }
        let profile = load_profile_from_db(&vfs).unwrap().unwrap();
        assert!(profile
            .weak_points
            .iter()
            .any(|point| point.knowledge_point == concept));

        {
            let conn = vfs.get_conn_safe().unwrap();
            conn.execute(
                "UPDATE mastery_events
                 SET deleted_at = '2026-07-19T00:00:00Z',
                     updated_at = '2026-07-19T00:00:00Z'
                 WHERE concept_key = ?1",
                params![concept],
            )
            .unwrap();
            MasteryService::recompute_all_states_with_conn(&conn).unwrap();
        }
        svc.sync_all_learner_profiles().unwrap();

        let state = svc.get_state(concept).unwrap().unwrap();
        assert_eq!(state.total, 0);
        assert_eq!(state.wrong_count, 0);
        let profile = load_profile_from_db(&vfs).unwrap().unwrap();
        assert!(!profile
            .weak_points
            .iter()
            .any(|point| point.knowledge_point == concept));
    }

    /// C5-4：旧 NULL signal 的 rating 行回退 target=0.35
    #[test]
    fn legacy_null_signal_rating_falls_back_to_0_35() {
        let (_tmp, vfs, svc) = setup();
        let conn = vfs.get_conn_safe().unwrap();
        conn.execute(
            "INSERT INTO mastery_events
                (id, created_at, source, concept_key, item_id, outcome, weight, signal)
             VALUES ('me_legacy', '2020-01-01T00:00:00Z', 'fsrs', 'legacy_c', 'c1', 'rating', 1.0, NULL)",
            [],
        )
        .unwrap();
        let null_signal: Option<f64> = conn
            .query_row(
                "SELECT signal FROM mastery_events WHERE id = 'me_legacy'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(null_signal.is_none(), "fixture must be NULL signal");
        drop(conn);
        let state = svc.recompute_state("legacy_c").unwrap();
        // score0=0.5, target=0.35, α=0.3 → 0.5 + 0.3*(0.35-0.5) = 0.455
        assert!(
            (state.score - 0.455).abs() < 1e-9,
            "legacy rating NULL signal should use 0.35 target, got {}",
            state.score
        );
        let persisted = svc.get_state("legacy_c").unwrap().unwrap();
        assert!((persisted.score - 0.455).abs() < 1e-9);
    }

    /// C5-5：极低掌握度提前 ≤ 3 天；真实 sqlite score 驱动
    #[test]
    fn mastery_due_bias_low_high_and_cap_on_real_sqlite_scores() {
        let (_tmp, _vfs, svc) = setup();
        let t0 = Utc::now().timestamp_millis();
        // Drive low mastery via repeated wrongs
        for i in 0..5 {
            set_now_override_ms(Some(t0 + i * 120_000));
            svc.record_event(
                MasterySource::Qbank,
                "偏置弱",
                &format!("w{i}"),
                &MasteryOutcome::Wrong,
            )
            .unwrap();
        }
        // Drive high mastery via repeated corrects (spaced)
        for i in 0..8 {
            set_now_override_ms(Some(t0 + 1_000_000 + i * 90_000));
            svc.record_event(
                MasterySource::Qbank,
                "偏置强",
                &format!("c{i}"),
                &MasteryOutcome::Correct,
            )
            .unwrap();
        }
        set_now_override_ms(None);

        let low = svc.get_state("偏置弱").unwrap().unwrap();
        let high = svc.get_state("偏置强").unwrap().unwrap();
        assert!(low.score < 0.5, "low score={}", low.score);
        assert!(high.score > 0.5, "high score={}", high.score);

        let now = 1_700_000_000_000_i64;
        let interval = 10 * MS_PER_DAY;
        let fsrs_due = now + interval;

        let low_due = apply_mastery_due_bias(low.score, now, fsrs_due);
        let high_due = apply_mastery_due_bias(high.score, now, fsrs_due);
        assert!(
            low_due < fsrs_due,
            "low mastery must advance due: {low_due} vs {fsrs_due}"
        );
        let expected_delta = mastery_due_bias_delta_ms(low.score, interval);
        assert_eq!(low_due, fsrs_due + expected_delta);
        assert!(
            high_due >= fsrs_due,
            "high mastery must not advance: {high_due} vs {fsrs_due}"
        );

        // Cap: score=0 + 100d interval → 绝对提前恰好 3 天，而非 40d
        let capped = mastery_due_bias_delta_ms(0.0, 100 * MS_PER_DAY);
        assert_eq!(capped, -MAX_ADVANCE_MS);
        let capped_due = apply_mastery_due_bias(0.0, now, now + 100 * MS_PER_DAY);
        assert_eq!(capped_due, now + 100 * MS_PER_DAY - MAX_ADVANCE_MS);
        // 极低真实 score 同样受 cap
        let low_capped = mastery_due_bias_delta_ms(low.score, 100 * MS_PER_DAY);
        assert!(low_capped.abs() <= MAX_ADVANCE_MS);
    }

    #[test]
    fn overview_includes_today_priority_review() {
        let (_tmp, _vfs, svc) = setup();
        let t0 = Utc::now().timestamp_millis();
        for i in 0..3 {
            set_now_override_ms(Some(t0 + i * 120_000));
            svc.record_event(
                MasterySource::Qbank,
                "优先复习概念",
                &format!("p{i}"),
                &MasteryOutcome::Wrong,
            )
            .unwrap();
        }
        set_now_override_ms(None);
        let summary = svc.overview_summary(5).unwrap();
        assert!(summary.weak_count >= 1);
        assert!(
            !summary.today_priority_review.is_empty(),
            "expected today_priority_review block"
        );
        assert_eq!(summary.today_priority_review[0].concept_key, "优先复习概念");
        assert_eq!(summary.today_priority_review[0].priority, 1);
    }
}
