//! FSRS 闪卡复习服务
//!
//! 调度状态与复习日志独立于 `anki_cards` 内容表。
//! 调度算法使用官方轻量 crate `rs-fsrs`（MIT，仅 scheduler，不含优化器）。

use chrono::{DateTime, Local, TimeZone, Utc};
use rs_fsrs::{Card as RsFsrsCard, Rating as RsFsrsRating, State as RsFsrsState, FSRS as RsFsrs};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tracing::{debug, info};

use crate::database::{AnkiLibraryScope, Database};
use crate::models::{AppError, AppErrorType};

type Result<T> = std::result::Result<T, AppError>;

/// 参数版本标记（rs-fsrs 1.2.x 默认权重）
pub const FSRS_PARAMS_VERSION: &str = "rs-fsrs-1.2";

/// 默认牌组 ID（与迁移 seed 一致）
pub const DEFAULT_DECK_ID: &str = "deck_default";

/// 默认目标保持率
pub const DEFAULT_DESIRED_RETENTION: f64 = 0.9;

const FSRS_ERROR_DIAGNOSTIC_CARD_NOT_REVIEWABLE: &str = "fsrs_diagnostic_card_not_reviewable";

fn diagnostic_card_not_reviewable_error(card_id: &str) -> AppError {
    AppError::with_details(
        AppErrorType::Validation,
        "Diagnostic error cards cannot be reviewed",
        serde_json::json!({
            "errorCode": FSRS_ERROR_DIAGNOSTIC_CARD_NOT_REVIEWABLE,
            "cardId": card_id,
        }),
    )
}

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_id: Option<String>,
    #[serde(default)]
    pub extra_fields: HashMap<String, String>,
    #[serde(default)]
    pub images: Vec<String>,
    #[serde(default)]
    pub is_error_card: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_content: Option<String>,
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

/// 撤销最后一次评分后的状态。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsrsUndoResult {
    pub state: FsrsCardState,
    pub changed: bool,
    pub undone_log_id: String,
}

/// 暂停状态切换结果。重复设置同一状态不会写库。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsrsSuspendResult {
    pub state: FsrsCardState,
    pub changed: bool,
}

/// Latest review metadata exposed to session-owned Agent tools.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FsrsAgentLatestReviewSnapshot {
    pub log_id: String,
    pub rating: u8,
    pub review_ms: i64,
    pub undoable: bool,
}

/// Minimal scheduling snapshot used by Agent reads and optimistic writes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FsrsAgentReviewStateSnapshot {
    pub anki_card_id: String,
    pub card_state_id: String,
    pub state: i32,
    pub suspended: bool,
    pub due_ms: i64,
    pub last_review_ms: Option<i64>,
    pub review_version: i64,
    #[serde(default)]
    pub latest_review: Option<FsrsAgentLatestReviewSnapshot>,
}

/// Structured result for session-owned Agent review mutations.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum FsrsAgentReviewMutationOutcome {
    Updated {
        state: FsrsAgentReviewStateSnapshot,
        changed: bool,
    },
    Conflict {
        current: FsrsAgentReviewStateSnapshot,
    },
    Blocked {
        reason: String,
        current: FsrsAgentReviewStateSnapshot,
    },
    NotFound,
}

/// 入队结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsrsEnqueueResult {
    pub enqueued: u32,
    pub skipped: u32,
    pub enqueued_state_ids: Vec<String>,
    pub states: Vec<FsrsCardState>,
    #[serde(default)]
    pub review_cards: Vec<FsrsEnqueuedCard>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FsrsLibraryEnqueueCard {
    pub card_id: String,
    pub expected_content_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FsrsLibraryContentVersionConflict {
    pub card_id: String,
    pub expected_version: String,
    pub current_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FsrsLibraryEnqueueOutcome {
    Enqueued(FsrsEnqueueResult),
    Conflict {
        conflicts: Vec<FsrsLibraryContentVersionConflict>,
    },
    NotFound {
        card_ids: Vec<String>,
    },
    Blocked {
        reason: String,
        card_ids: Vec<String>,
    },
}

/// Snapshot used by `fsrs://changed` after a successful enqueue.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FsrsEnqueuedCard {
    /// FSRS card-state ID (not the Anki content-card ID).
    pub id: String,
    pub anki_card_id: String,
    pub front: String,
    pub back: String,
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_id: Option<String>,
    #[serde(default)]
    pub extra_fields: HashMap<String, String>,
    #[serde(default)]
    pub images: Vec<String>,
    #[serde(default)]
    pub is_error_card: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_content: Option<String>,
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

#[derive(Debug, Clone)]
struct FsrsAgentStateRecord {
    state: FsrsCardState,
    review_version: i64,
}

#[derive(Debug, Clone)]
struct FsrsAgentReviewLogRecord {
    log_id: String,
    anki_card_id: String,
    rating: u8,
    review_ms: i64,
    state_before_json: Option<String>,
    updated_at: Option<String>,
}

enum FsrsEnqueueScope<'a> {
    Internal,
    Session {
        session_id: &'a str,
        expected_document_id: Option<&'a str>,
    },
    Library {
        expected_versions: &'a HashMap<String, String>,
    },
}

#[derive(Clone, Copy)]
enum FsrsAgentMutationScope<'a> {
    Session(&'a str),
    Library(AnkiLibraryScope),
}

/// Complete scheduling snapshot written before every rating. Sync metadata and
/// timestamps are deliberately excluded: undo restores scheduling data while
/// publishing a fresh row version.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct FsrsStateBeforeSnapshot {
    snapshot_version: u8,
    card_state_id: String,
    anki_card_id: String,
    deck_id: Option<String>,
    state: i32,
    stability: Option<f64>,
    difficulty: Option<f64>,
    elapsed_days: f64,
    scheduled_days: f64,
    reps: i32,
    lapses: i32,
    due_ms: i64,
    last_review_ms: Option<i64>,
    suspended: bool,
    fsrs_params_version: String,
    desired_retention: Option<f64>,
}

impl FsrsStateBeforeSnapshot {
    const VERSION: u8 = 1;

    fn from_state(state: &FsrsCardState) -> Self {
        Self {
            snapshot_version: Self::VERSION,
            card_state_id: state.id.clone(),
            anki_card_id: state.anki_card_id.clone(),
            deck_id: state.deck_id.clone(),
            state: state.state,
            stability: state.stability,
            difficulty: state.difficulty,
            elapsed_days: state.elapsed_days,
            scheduled_days: state.scheduled_days,
            reps: state.reps,
            lapses: state.lapses,
            due_ms: state.due_ms,
            last_review_ms: state.last_review_ms,
            suspended: state.suspended,
            fsrs_params_version: state.fsrs_params_version.clone(),
            desired_retention: state.desired_retention,
        }
    }

    fn validate_for(&self, state: &FsrsCardState) -> Result<()> {
        let finite_optional = |value: Option<f64>| value.map(f64::is_finite).unwrap_or(true);
        if self.snapshot_version != Self::VERSION
            || self.card_state_id != state.id
            || self.anki_card_id != state.anki_card_id
            || !(0..=3).contains(&self.state)
            || !finite_optional(self.stability)
            || !finite_optional(self.difficulty)
            || !self.elapsed_days.is_finite()
            || self.elapsed_days < 0.0
            || !self.scheduled_days.is_finite()
            || self.scheduled_days < 0.0
            || self.reps < 0
            || self.lapses < 0
            || self.fsrs_params_version.trim().is_empty()
            || !finite_optional(self.desired_retention)
        {
            return Err(AppError::validation(
                "review log contains an invalid FSRS state snapshot",
            ));
        }
        Ok(())
    }
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
        Self::expect_plain_enqueue(
            self.enqueue_cards_inner(anki_card_ids, FsrsEnqueueScope::Internal)?,
        )
    }

    /// Enqueues cards only while their complete source documents still belong
    /// to `session_id`. `expected_document_id` binds a document selector to the
    /// same document during the final write transaction.
    pub fn enqueue_cards_for_session(
        &self,
        anki_card_ids: &[String],
        session_id: &str,
        expected_document_id: Option<&str>,
    ) -> Result<FsrsEnqueueResult> {
        let normalized_ids = if expected_document_id.is_some() {
            // A document selector is not an explicit cardIds request. Its live
            // card set is resolved again inside the write transaction below.
            Vec::new()
        } else {
            if anki_card_ids.len() > 100 {
                return Err(AppError::validation(
                    "cardIds must contain at most 100 entries",
                ));
            }
            let mut seen = HashSet::new();
            let mut normalized_ids = Vec::with_capacity(anki_card_ids.len());
            for card_id in anki_card_ids {
                let card_id = card_id.trim().to_string();
                if card_id.is_empty() {
                    return Err(AppError::validation("cardIds must not contain empty IDs"));
                }
                if seen.insert(card_id.clone()) {
                    normalized_ids.push(card_id);
                }
            }
            normalized_ids
        };
        Self::expect_plain_enqueue(self.enqueue_cards_inner(
            &normalized_ids,
            FsrsEnqueueScope::Session {
                session_id,
                expected_document_id,
            },
        )?)
    }

    /// Enqueues a version-bound batch from the complete live library. Every
    /// content token is checked inside the same `IMMEDIATE` transaction as the
    /// FSRS inserts, so a stale or missing card leaves the entire batch intact.
    pub fn enqueue_cards_for_library(
        &self,
        _scope: AnkiLibraryScope,
        cards: &[FsrsLibraryEnqueueCard],
    ) -> Result<FsrsLibraryEnqueueOutcome> {
        if cards.is_empty() || cards.len() > 100 {
            return Err(AppError::validation(
                "cards must contain between 1 and 100 entries",
            ));
        }
        let mut expected_versions = HashMap::with_capacity(cards.len());
        let mut card_ids = Vec::with_capacity(cards.len());
        for card in cards {
            let card_id = card.card_id.trim().to_string();
            let expected_version = card.expected_content_version.trim().to_string();
            if card_id.is_empty() || expected_version.is_empty() {
                return Err(AppError::validation(
                    "cards must contain non-empty cardId and expectedVersion values",
                ));
            }
            if expected_versions
                .insert(card_id.clone(), expected_version)
                .is_some()
            {
                return Err(AppError::validation("cards must not contain duplicate IDs"));
            }
            card_ids.push(card_id);
        }
        self.enqueue_cards_inner(
            &card_ids,
            FsrsEnqueueScope::Library {
                expected_versions: &expected_versions,
            },
        )
    }

    fn expect_plain_enqueue(outcome: FsrsLibraryEnqueueOutcome) -> Result<FsrsEnqueueResult> {
        match outcome {
            FsrsLibraryEnqueueOutcome::Enqueued(result) => Ok(result),
            other => Err(AppError::database(format!(
                "unexpected scoped enqueue outcome: {:?}",
                other
            ))),
        }
    }

    fn enqueue_cards_inner(
        &self,
        anki_card_ids: &[String],
        scope: FsrsEnqueueScope<'_>,
    ) -> Result<FsrsLibraryEnqueueOutcome> {
        let expected_document_id = match &scope {
            FsrsEnqueueScope::Session {
                expected_document_id,
                ..
            } => *expected_document_id,
            _ => None,
        };
        if anki_card_ids.is_empty() && expected_document_id.is_none() {
            return Ok(FsrsLibraryEnqueueOutcome::Enqueued(FsrsEnqueueResult {
                enqueued: 0,
                skipped: 0,
                enqueued_state_ids: vec![],
                states: vec![],
                review_cards: vec![],
            }));
        }

        let now = Utc::now();
        let now_rfc = now.to_rfc3339();
        let now_ms = now.timestamp_millis();

        let mut conn = self
            .db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取数据库连接失败: {}", e)))?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| AppError::database(format!("开启事务失败: {}", e)))?;

        let document_card_ids = match &scope {
            FsrsEnqueueScope::Session {
                session_id,
                expected_document_id: Some(document_id),
            } => {
                if !Self::document_owned_by_session(&tx, document_id, session_id)? {
                    return Err(AppError::not_found(
                        "blocks.ankiCards.errors.statusNotFound",
                    ));
                }
                let mut stmt = tx
                    .prepare(
                        "SELECT ac.id
                         FROM anki_cards ac
                         INNER JOIN document_tasks dt ON dt.id = ac.task_id
                         WHERE dt.document_id = ?1
                           AND dt.source_session_id = ?2
                           AND dt.deleted_at IS NULL
                           AND ac.deleted_at IS NULL
                           AND COALESCE(ac.is_error_card, 0) = 0
                         ORDER BY dt.segment_index, ac.card_order_in_task, ac.created_at",
                    )
                    .map_err(|e| AppError::database(format!("准备文档卡片复验失败: {}", e)))?;
                let rows = stmt
                    .query_map(params![document_id, session_id], |row| {
                        row.get::<_, String>(0)
                    })
                    .map_err(|e| AppError::database(format!("查询文档 live cards 失败: {}", e)))?;
                let mut ids = Vec::new();
                for row in rows {
                    ids.push(
                        row.map_err(|e| AppError::database(format!("解析文档卡片失败: {}", e)))?,
                    );
                }
                ids
            }
            _ => Vec::new(),
        };
        let anki_card_ids = if expected_document_id.is_some() {
            document_card_ids.as_slice()
        } else {
            anki_card_ids
        };

        // Validate the complete selection before the first FSRS write. The
        // IMMEDIATE transaction prevents ownership changes between this check
        // and the inserts below, and any failure rolls back the whole batch.
        let mut validated_documents = HashSet::new();
        let mut library_missing = Vec::new();
        let mut library_diagnostic = Vec::new();
        let mut library_conflicts = Vec::new();
        for card_id in anki_card_ids {
            let card_id = card_id.trim();
            if card_id.is_empty() {
                return Err(AppError::validation("cardIds must not contain empty IDs"));
            }

            let selection: Option<(String, Option<String>, bool, String)> = tx
                .query_row(
                    "SELECT dt.document_id, dt.source_session_id,
                            COALESCE(ac.is_error_card, 0), ac.updated_at
                     FROM anki_cards ac
                     INNER JOIN document_tasks dt ON dt.id = ac.task_id
                     WHERE ac.id = ?1
                       AND ac.deleted_at IS NULL
                       AND dt.deleted_at IS NULL
                     LIMIT 1",
                    params![card_id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get::<_, i32>(2)? != 0,
                            row.get(3)?,
                        ))
                    },
                )
                .optional()
                .map_err(|e| AppError::database(format!("复验 Anki 卡片归属失败: {}", e)))?;
            let Some((document_id, owner_session_id, is_error_card, current_version)) = selection
            else {
                if matches!(&scope, FsrsEnqueueScope::Library { .. }) {
                    library_missing.push(card_id.to_string());
                    continue;
                }
                return Err(AppError::not_found(
                    "blocks.ankiCards.errors.statusNotFound",
                ));
            };
            match &scope {
                FsrsEnqueueScope::Session {
                    session_id,
                    expected_document_id,
                } => {
                    if owner_session_id.as_deref() != Some(*session_id)
                        || expected_document_id
                            .map(|expected| expected != document_id)
                            .unwrap_or(false)
                    {
                        return Err(AppError::not_found(
                            "blocks.ankiCards.errors.statusNotFound",
                        ));
                    }
                    if validated_documents.insert(document_id.clone())
                        && !Self::document_owned_by_session(&tx, &document_id, session_id)?
                    {
                        return Err(AppError::not_found(
                            "blocks.ankiCards.errors.statusNotFound",
                        ));
                    }
                }
                FsrsEnqueueScope::Library { expected_versions } => {
                    let expected_version = expected_versions
                        .get(card_id)
                        .expect("library enqueue normalized an exact version map");
                    if expected_version != &current_version {
                        library_conflicts.push(FsrsLibraryContentVersionConflict {
                            card_id: card_id.to_string(),
                            expected_version: expected_version.clone(),
                            current_version,
                        });
                    }
                }
                FsrsEnqueueScope::Internal => {}
            }
            if is_error_card {
                if matches!(&scope, FsrsEnqueueScope::Library { .. }) {
                    library_diagnostic.push(card_id.to_string());
                } else {
                    return Err(diagnostic_card_not_reviewable_error(card_id));
                }
            }
        }

        if !library_missing.is_empty() {
            return Ok(FsrsLibraryEnqueueOutcome::NotFound {
                card_ids: library_missing,
            });
        }
        if !library_diagnostic.is_empty() {
            return Ok(FsrsLibraryEnqueueOutcome::Blocked {
                reason: "diagnostic_card".to_string(),
                card_ids: library_diagnostic,
            });
        }
        if !library_conflicts.is_empty() {
            return Ok(FsrsLibraryEnqueueOutcome::Conflict {
                conflicts: library_conflicts,
            });
        }

        // 确保默认牌组存在
        tx.execute(
            "INSERT OR IGNORE INTO anki_decks (id, name, description, config_json, created_at, updated_at, local_version)
             VALUES (?1, 'Default', 'Default flashcard deck for FSRS reviews', '{\"desired_retention\":0.9}', ?2, ?2, 0)",
            params![DEFAULT_DECK_ID, now_rfc],
        )
        .map_err(|e| AppError::database(format!("确保默认牌组失败: {}", e)))?;

        let mut enqueued = 0u32;
        let mut skipped = 0u32;
        let mut enqueued_state_ids = Vec::new();
        let mut states = Vec::new();

        for card_id in anki_card_ids {
            if card_id.trim().is_empty() {
                skipped += 1;
                continue;
            }

            // 校验卡片存在（不修改 anki_cards）
            let exists: bool = tx
                .query_row(
                    "SELECT 1
                     FROM anki_cards ac
                     INNER JOIN document_tasks dt ON dt.id = ac.task_id
                     WHERE ac.id = ?1
                       AND ac.deleted_at IS NULL
                       AND dt.deleted_at IS NULL
                     LIMIT 1",
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
            enqueued_state_ids.push(id.clone());
            if let Some(state) = Self::load_state_by_id(&tx, &id)? {
                states.push(state);
            }
        }

        // Materialize content for the complete batch (new + skipped) before
        // commit. A missing/corrupt content row therefore rolls back FSRS writes
        // instead of leaving a committed state with an unusable review payload.
        let review_cards = Self::load_review_cards_for_states(&tx, &states)?;

        tx.commit()
            .map_err(|e| AppError::database(format!("提交入队事务失败: {}", e)))?;

        info!(
            "[FsrsReviewService] enqueue: enqueued={}, skipped={}",
            enqueued, skipped
        );

        Ok(FsrsLibraryEnqueueOutcome::Enqueued(FsrsEnqueueResult {
            enqueued,
            skipped,
            enqueued_state_ids,
            states,
            review_cards,
        }))
    }

    fn load_review_cards_for_states(
        conn: &rusqlite::Connection,
        states: &[FsrsCardState],
    ) -> Result<Vec<FsrsEnqueuedCard>> {
        let mut stmt = conn
            .prepare(
                "SELECT front, back, tags_json, text, template_id,
                        COALESCE(extra_fields_json, '{}'), COALESCE(images_json, '[]'),
                        COALESCE(is_error_card, 0), error_content
                 FROM anki_cards ac
                 INNER JOIN document_tasks dt ON dt.id = ac.task_id
                 WHERE ac.id = ?1
                   AND ac.deleted_at IS NULL
                   AND dt.deleted_at IS NULL
                 LIMIT 1",
            )
            .map_err(|error| AppError::database(format!("准备入队卡片正文查询失败: {}", error)))?;
        let mut review_cards = Vec::with_capacity(states.len());
        for state in states {
            let content: Option<(
                String,
                String,
                String,
                Option<String>,
                Option<String>,
                String,
                String,
                i32,
                Option<String>,
            )> = stmt
                .query_row(params![state.anki_card_id], |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                    ))
                })
                .optional()
                .map_err(|error| {
                    AppError::database(format!(
                        "读取入队卡片正文失败 ({}): {}",
                        state.anki_card_id, error
                    ))
                })?;
            let Some((
                front,
                back,
                tags_json,
                text,
                template_id,
                extra_fields_json,
                images_json,
                is_error_card,
                error_content,
            )) = content
            else {
                return Err(AppError::database(format!(
                    "入队卡片正文不存在: {}",
                    state.anki_card_id
                )));
            };
            let tags = serde_json::from_str::<Vec<String>>(&tags_json).map_err(|error| {
                AppError::database(format!(
                    "解析入队卡片标签失败 ({}): {}",
                    state.anki_card_id, error
                ))
            })?;
            let extra_fields = serde_json::from_str::<HashMap<String, String>>(&extra_fields_json)
                .map_err(|error| {
                    AppError::database(format!(
                        "解析入队卡片扩展字段失败 ({}): {}",
                        state.anki_card_id, error
                    ))
                })?;
            let images = serde_json::from_str::<Vec<String>>(&images_json).map_err(|error| {
                AppError::database(format!(
                    "解析入队卡片图片失败 ({}): {}",
                    state.anki_card_id, error
                ))
            })?;
            review_cards.push(FsrsEnqueuedCard {
                id: state.id.clone(),
                anki_card_id: state.anki_card_id.clone(),
                front,
                back,
                tags,
                text,
                template_id,
                extra_fields,
                images,
                is_error_card: is_error_card != 0,
                error_content,
            });
        }
        Ok(review_cards)
    }

    /// Selects event cards inserted by this call from the transaction snapshot.
    /// `states` and `review_cards` intentionally remain the complete batch.
    pub fn get_enqueued_cards(&self, result: &FsrsEnqueueResult) -> Result<Vec<FsrsEnqueuedCard>> {
        if result.enqueued_state_ids.is_empty() {
            return Ok(Vec::new());
        }

        let cards_by_state_id: HashMap<&str, &FsrsEnqueuedCard> = result
            .review_cards
            .iter()
            .map(|card| (card.id.as_str(), card))
            .collect();
        let mut newly_enqueued_cards = Vec::with_capacity(result.enqueued_state_ids.len());
        for state_id in &result.enqueued_state_ids {
            let card = cards_by_state_id
                .get(state_id.as_str())
                .copied()
                .ok_or_else(|| {
                    AppError::database(format!(
                        "enqueue result is missing newly inserted review card: {}",
                        state_id
                    ))
                })?;
            newly_enqueued_cards.push(card.clone());
        }
        Ok(newly_enqueued_cards)
    }

    /// Reads scheduling state only when every selected card is live and its
    /// complete source document belongs to `session_id`. Owned cards that have
    /// not entered FSRS yet are intentionally omitted from the result.
    pub fn get_review_states_for_session(
        &self,
        anki_card_ids: &[String],
        session_id: &str,
    ) -> Result<Vec<FsrsAgentReviewStateSnapshot>> {
        if session_id.trim().is_empty() {
            return Err(AppError::validation("sessionId is required"));
        }

        let mut seen = HashSet::new();
        let mut normalized_ids = Vec::with_capacity(anki_card_ids.len());
        for card_id in anki_card_ids {
            let card_id = card_id.trim().to_string();
            if card_id.is_empty() {
                return Err(AppError::validation(
                    "ankiCardIds must not contain empty IDs",
                ));
            }
            if seen.insert(card_id.clone()) {
                normalized_ids.push(card_id);
            }
        }
        if normalized_ids.is_empty() {
            return Ok(Vec::new());
        }

        let mut conn = self
            .db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取数据库连接失败: {}", e)))?;
        let tx = conn
            .transaction()
            .map_err(|e| AppError::database(format!("开启复习状态读取事务失败: {}", e)))?;
        let mut verified_documents = HashSet::new();
        let mut snapshots = Vec::with_capacity(normalized_ids.len());

        for card_id in normalized_ids {
            let Some((document_id, is_error_card)) = Self::load_agent_card_guard(&tx, &card_id)?
            else {
                return Err(AppError::not_found(format!(
                    "anki card not found: {}",
                    card_id
                )));
            };
            if !verified_documents.contains(&document_id) {
                if !Self::document_owned_by_session(&tx, &document_id, session_id)? {
                    return Err(AppError::not_found(format!(
                        "anki card not found: {}",
                        card_id
                    )));
                }
                verified_documents.insert(document_id);
            }

            if let Some(record) = Self::load_agent_state_record(&tx, &card_id)? {
                let (snapshot, _) = Self::load_agent_snapshot(&tx, &record, is_error_card)?;
                snapshots.push(snapshot);
            }
        }

        tx.commit()
            .map_err(|e| AppError::database(format!("提交复习状态读取事务失败: {}", e)))?;
        Ok(snapshots)
    }

    /// Reads review snapshots for live cards across the complete library in a
    /// single SQL query. Unenqueued cards are omitted; a missing/tombstoned card
    /// rejects the selection instead of being confused with an unenqueued one.
    pub fn get_review_states_for_library(
        &self,
        _scope: AnkiLibraryScope,
        anki_card_ids: &[String],
    ) -> Result<Vec<FsrsAgentReviewStateSnapshot>> {
        if anki_card_ids.len() > 100 {
            return Err(AppError::validation(
                "ankiCardIds must contain at most 100 entries",
            ));
        }
        let mut seen = HashSet::new();
        let mut normalized_ids = Vec::with_capacity(anki_card_ids.len());
        for card_id in anki_card_ids {
            let card_id = card_id.trim().to_string();
            if card_id.is_empty() {
                return Err(AppError::validation(
                    "ankiCardIds must not contain empty IDs",
                ));
            }
            if seen.insert(card_id.clone()) {
                normalized_ids.push(card_id);
            }
        }
        if normalized_ids.is_empty() {
            return Ok(Vec::new());
        }

        let placeholders = vec!["?"; normalized_ids.len()].join(",");
        let sql = format!(
            "SELECT
                s.id, s.anki_card_id, s.deck_id, s.state, s.stability, s.difficulty,
                s.elapsed_days, s.scheduled_days, s.reps, s.lapses, s.due_ms,
                s.last_review_ms, s.suspended, s.fsrs_params_version,
                s.desired_retention, s.created_at, s.updated_at,
                COALESCE(s.local_version, 0),
                ac.id, COALESCE(ac.is_error_card, 0),
                latest.id, latest.anki_card_id, latest.rating, latest.review_ms,
                latest.state_before_json, latest.updated_at
             FROM anki_cards ac
             INNER JOIN document_tasks dt ON dt.id = ac.task_id
             LEFT JOIN fsrs_card_states s
               ON s.anki_card_id = ac.id AND s.deleted_at IS NULL
             LEFT JOIN fsrs_review_logs latest
               ON latest.id = (
                   SELECT log.id
                   FROM fsrs_review_logs log
                   WHERE log.card_state_id = s.id
                     AND log.deleted_at IS NULL
                   ORDER BY log.review_ms DESC, log.created_at DESC, log.id DESC
                   LIMIT 1
               )
             WHERE ac.id IN ({})
               AND ac.deleted_at IS NULL
               AND dt.deleted_at IS NULL",
            placeholders
        );
        let conn = self
            .db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取数据库连接失败: {}", e)))?;
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| AppError::database(format!("准备 Library 复习状态查询失败: {}", e)))?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(normalized_ids.iter()), |row| {
                let card_id: String = row.get(18)?;
                let is_error_card = row.get::<_, i32>(19)? != 0;
                let state_id: Option<String> = row.get(0)?;
                let record = state_id
                    .map(|_| {
                        Ok::<FsrsAgentStateRecord, rusqlite::Error>(FsrsAgentStateRecord {
                            state: Self::map_state_row(row)?,
                            review_version: row.get(17)?,
                        })
                    })
                    .transpose()?;
                let latest_log_id: Option<String> = row.get(20)?;
                let latest = latest_log_id
                    .map(|log_id| {
                        Ok::<FsrsAgentReviewLogRecord, rusqlite::Error>(FsrsAgentReviewLogRecord {
                            log_id,
                            anki_card_id: row.get(21)?,
                            rating: row.get(22)?,
                            review_ms: row.get(23)?,
                            state_before_json: row.get(24)?,
                            updated_at: row.get(25)?,
                        })
                    })
                    .transpose()?;
                Ok((card_id, is_error_card, record, latest))
            })
            .map_err(|e| AppError::database(format!("查询 Library 复习状态失败: {}", e)))?;

        let mut loaded = HashMap::with_capacity(normalized_ids.len());
        for row in rows {
            let (card_id, is_error_card, record, latest) =
                row.map_err(|e| AppError::database(format!("解析 Library 复习状态失败: {}", e)))?;
            loaded.insert(card_id, (is_error_card, record, latest));
        }
        let mut snapshots = Vec::with_capacity(normalized_ids.len());
        for card_id in normalized_ids {
            let Some((is_error_card, record, latest)) = loaded.remove(&card_id) else {
                return Err(AppError::not_found(format!(
                    "anki card not found: {}",
                    card_id
                )));
            };
            if let Some(record) = record {
                snapshots.push(Self::build_agent_snapshot(
                    &record,
                    is_error_card,
                    latest.as_ref(),
                ));
            }
        }
        Ok(snapshots)
    }

    fn document_owned_by_session(
        conn: &rusqlite::Connection,
        document_id: &str,
        session_id: &str,
    ) -> Result<bool> {
        let (task_count, owned_task_count): (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*),
                        COALESCE(SUM(CASE WHEN source_session_id = ?2 THEN 1 ELSE 0 END), 0)
                 FROM document_tasks
                 WHERE document_id = ?1
                   AND deleted_at IS NULL",
                params![document_id, session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|e| AppError::database(format!("复验制卡文档归属失败: {}", e)))?;
        Ok(task_count > 0 && task_count == owned_task_count)
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
                        COALESCE(a.front, ''), COALESCE(a.back, ''), COALESCE(a.tags_json, '[]'),
                        a.text, a.template_id, COALESCE(a.extra_fields_json, '{}'),
                        COALESCE(a.images_json, '[]'), COALESCE(a.is_error_card, 0), a.error_content
                 FROM fsrs_card_states s
                 INNER JOIN anki_cards a ON a.id = s.anki_card_id
                 INNER JOIN document_tasks dt ON dt.id = a.task_id
                 WHERE s.deleted_at IS NULL
                   AND a.deleted_at IS NULL
                   AND dt.deleted_at IS NULL
                   AND COALESCE(a.is_error_card, 0) = 0
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
                let extra_fields_json: String = row.get(22)?;
                let extra_fields: HashMap<String, String> =
                    serde_json::from_str(&extra_fields_json).unwrap_or_default();
                let images_json: String = row.get(23)?;
                let images: Vec<String> = serde_json::from_str(&images_json).unwrap_or_default();
                Ok(FsrsDueCard {
                    state,
                    front,
                    back,
                    tags,
                    text: row.get(20)?,
                    template_id: row.get(21)?,
                    extra_fields,
                    images,
                    is_error_card: row.get::<_, i32>(24)? != 0,
                    error_content: row.get(25)?,
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
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| AppError::database(format!("开启事务失败: {}", e)))?;

        let (before, is_error_card) =
            Self::load_state_for_rate(&tx, card_state_id)?.ok_or_else(|| {
                AppError::not_found(format!("fsrs card state not found: {}", card_state_id))
            })?;

        if is_error_card {
            return Err(diagnostic_card_not_reviewable_error(&before.anki_card_id));
        }

        if before.suspended {
            return Err(AppError::validation("card is suspended"));
        }

        let state_before_json =
            serde_json::to_string(&FsrsStateBeforeSnapshot::from_state(&before))
                .map_err(|e| AppError::database(format!("序列化评分前状态失败: {}", e)))?;
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
                updated_at = ?11,
                local_version = COALESCE(local_version, 0) + 1
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
                created_at, updated_at, state_before_json
             ) VALUES (
                ?1, ?2, ?3, ?4,
                ?5, ?6,
                ?7, ?8,
                ?9, ?10,
                ?11, ?12,
                ?13, ?14,
                ?15, ?16, ?17,
                ?18, ?18, ?19
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
                state_before_json,
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

    /// Restores the complete state captured immediately before the caller's
    /// expected review log. The explicit log binding prevents a stale UI from
    /// undoing a newer rating performed in another window.
    pub fn undo_last_review(
        &self,
        expected_log_id: &str,
        card_state_id: &str,
    ) -> Result<FsrsUndoResult> {
        if expected_log_id.trim().is_empty() || card_state_id.trim().is_empty() {
            return Err(AppError::validation(
                "expectedLogId and cardStateId are required",
            ));
        }

        let now_rfc = Utc::now().to_rfc3339();
        let mut conn = self
            .db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取数据库连接失败: {}", e)))?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| AppError::database(format!("开启撤销事务失败: {}", e)))?;

        let current = Self::load_state_by_id(&tx, card_state_id)?.ok_or_else(|| {
            AppError::not_found(format!("fsrs card state not found: {}", card_state_id))
        })?;
        let log: Option<(String, String, i64, Option<String>, Option<String>)> = tx
            .query_row(
                "SELECT card_state_id, anki_card_id, review_ms, state_before_json, updated_at
                 FROM fsrs_review_logs
                 WHERE id = ?1 AND deleted_at IS NULL",
                params![expected_log_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| AppError::database(format!("加载待撤销复习日志失败: {}", e)))?;
        let Some((log_state_id, log_anki_card_id, review_ms, state_before_json, log_updated_at)) =
            log
        else {
            return Err(AppError::not_found(format!(
                "active fsrs review log not found: {}",
                expected_log_id
            )));
        };
        if log_state_id != card_state_id || log_anki_card_id != current.anki_card_id {
            return Err(AppError::conflict(
                "review log does not belong to the requested card state",
            ));
        }

        let latest_log_id: Option<String> = tx
            .query_row(
                "SELECT id
                 FROM fsrs_review_logs
                 WHERE card_state_id = ?1 AND deleted_at IS NULL
                 ORDER BY review_ms DESC, created_at DESC, id DESC
                 LIMIT 1",
                params![card_state_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| AppError::database(format!("校验最新复习日志失败: {}", e)))?;
        if latest_log_id.as_deref() != Some(expected_log_id)
            || current.last_review_ms != Some(review_ms)
            || log_updated_at.as_deref() != Some(current.updated_at.as_str())
        {
            return Err(AppError::conflict(
                "review log is stale and is no longer the latest rating",
            ));
        }

        let state_before_json = state_before_json.ok_or_else(|| {
            AppError::validation("review log predates complete FSRS undo snapshots")
        })?;
        let snapshot: FsrsStateBeforeSnapshot = serde_json::from_str(&state_before_json)
            .map_err(|_| AppError::validation("review log contains a damaged FSRS snapshot"))?;
        snapshot.validate_for(&current)?;
        let expected_state_updated_at = current.updated_at.clone();

        let restored = tx
            .execute(
                "UPDATE fsrs_card_states SET
                    deck_id = ?1,
                    state = ?2,
                    stability = ?3,
                    difficulty = ?4,
                    elapsed_days = ?5,
                    scheduled_days = ?6,
                    reps = ?7,
                    lapses = ?8,
                    due_ms = ?9,
                    last_review_ms = ?10,
                    suspended = ?11,
                    fsrs_params_version = ?12,
                    desired_retention = ?13,
                    updated_at = ?14,
                    local_version = COALESCE(local_version, 0) + 1
                 WHERE id = ?15
                   AND deleted_at IS NULL
                   AND last_review_ms = ?16
                   AND updated_at = ?17",
                params![
                    snapshot.deck_id,
                    snapshot.state,
                    snapshot.stability,
                    snapshot.difficulty,
                    snapshot.elapsed_days,
                    snapshot.scheduled_days,
                    snapshot.reps,
                    snapshot.lapses,
                    snapshot.due_ms,
                    snapshot.last_review_ms,
                    if snapshot.suspended { 1 } else { 0 },
                    snapshot.fsrs_params_version,
                    snapshot.desired_retention,
                    now_rfc,
                    card_state_id,
                    review_ms,
                    expected_state_updated_at,
                ],
            )
            .map_err(|e| AppError::database(format!("恢复 FSRS 卡片状态失败: {}", e)))?;
        if restored != 1 {
            return Err(AppError::conflict(
                "card state changed while undoing the latest rating",
            ));
        }

        let deleted = tx
            .execute(
                "UPDATE fsrs_review_logs
                 SET deleted_at = ?1,
                     updated_at = ?1,
                     local_version = COALESCE(local_version, 0) + 1
                 WHERE id = ?2
                   AND card_state_id = ?3
                   AND deleted_at IS NULL",
                params![now_rfc, expected_log_id, card_state_id],
            )
            .map_err(|e| AppError::database(format!("软删除已撤销复习日志失败: {}", e)))?;
        if deleted != 1 {
            return Err(AppError::conflict(
                "review log changed while undoing the latest rating",
            ));
        }

        let state = Self::load_state_by_id(&tx, card_state_id)?
            .ok_or_else(|| AppError::database("state missing after undo"))?;
        tx.commit()
            .map_err(|e| AppError::database(format!("提交撤销事务失败: {}", e)))?;

        Ok(FsrsUndoResult {
            state,
            changed: true,
            undone_log_id: expected_log_id.to_string(),
        })
    }

    /// Sets suspension by Anki content-card ID for one owning Agent session.
    /// The explicit FSRS row version is the only accepted concurrency token.
    pub fn set_suspended_for_session(
        &self,
        card_id: &str,
        session_id: &str,
        expected_review_version: i64,
        suspended: bool,
    ) -> Result<FsrsAgentReviewMutationOutcome> {
        if session_id.trim().is_empty() {
            return Err(AppError::validation("cardId and sessionId are required"));
        }
        self.set_suspended_for_agent_scope(
            card_id,
            FsrsAgentMutationScope::Session(session_id),
            expected_review_version,
            suspended,
        )
    }

    pub fn set_suspended_for_library(
        &self,
        scope: AnkiLibraryScope,
        card_id: &str,
        expected_review_version: i64,
        suspended: bool,
    ) -> Result<FsrsAgentReviewMutationOutcome> {
        self.set_suspended_for_agent_scope(
            card_id,
            FsrsAgentMutationScope::Library(scope),
            expected_review_version,
            suspended,
        )
    }

    fn set_suspended_for_agent_scope(
        &self,
        card_id: &str,
        scope: FsrsAgentMutationScope<'_>,
        expected_review_version: i64,
        suspended: bool,
    ) -> Result<FsrsAgentReviewMutationOutcome> {
        if card_id.trim().is_empty() || expected_review_version < 0 {
            return Err(AppError::validation(
                "cardId and a non-negative expectedReviewVersion are required",
            ));
        }

        let mut conn = self
            .db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取数据库连接失败: {}", e)))?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| AppError::database(format!("开启 Agent 暂停事务失败: {}", e)))?;
        let Some((is_error_card, record)) = Self::load_scoped_agent_state(&tx, card_id, scope)?
        else {
            return Ok(FsrsAgentReviewMutationOutcome::NotFound);
        };
        let (current, _) = Self::load_agent_snapshot(&tx, &record, is_error_card)?;

        if is_error_card {
            return Ok(FsrsAgentReviewMutationOutcome::Blocked {
                reason: "diagnostic_card".to_string(),
                current,
            });
        }
        if record.review_version != expected_review_version {
            return Ok(FsrsAgentReviewMutationOutcome::Conflict { current });
        }
        if record.state.suspended == suspended {
            tx.commit()
                .map_err(|e| AppError::database(format!("提交 Agent 暂停事务失败: {}", e)))?;
            return Ok(FsrsAgentReviewMutationOutcome::Updated {
                state: current,
                changed: false,
            });
        }

        let now = Utc::now();
        let mut now_rfc = now.to_rfc3339();
        if now_rfc == record.state.updated_at {
            now_rfc = (now + chrono::Duration::nanoseconds(1)).to_rfc3339();
        }
        let updated = tx
            .execute(
                "UPDATE fsrs_card_states
                 SET suspended = ?1,
                     updated_at = ?2,
                     local_version = COALESCE(local_version, 0) + 1
                 WHERE id = ?3
                   AND anki_card_id = ?4
                   AND COALESCE(local_version, 0) = ?5
                   AND suspended = ?6
                   AND deleted_at IS NULL
                   AND EXISTS (
                       SELECT 1
                       FROM anki_cards ac
                       INNER JOIN document_tasks dt ON dt.id = ac.task_id
                       WHERE ac.id = fsrs_card_states.anki_card_id
                         AND ac.deleted_at IS NULL
                         AND dt.deleted_at IS NULL
                   )",
                params![
                    if suspended { 1 } else { 0 },
                    now_rfc,
                    record.state.id,
                    card_id,
                    expected_review_version,
                    if record.state.suspended { 1 } else { 0 },
                ],
            )
            .map_err(|e| AppError::database(format!("更新 Agent 卡片暂停状态失败: {}", e)))?;
        if updated != 1 {
            let Some((diagnostic, latest_record)) =
                Self::load_scoped_agent_state(&tx, card_id, scope)?
            else {
                return Ok(FsrsAgentReviewMutationOutcome::NotFound);
            };
            let (current, _) = Self::load_agent_snapshot(&tx, &latest_record, diagnostic)?;
            return Ok(FsrsAgentReviewMutationOutcome::Conflict { current });
        }

        let updated_record = Self::load_agent_state_record(&tx, card_id)?
            .ok_or_else(|| AppError::database("state missing after Agent suspension update"))?;
        let (state, _) = Self::load_agent_snapshot(&tx, &updated_record, false)?;
        tx.commit()
            .map_err(|e| AppError::database(format!("提交 Agent 暂停事务失败: {}", e)))?;
        Ok(FsrsAgentReviewMutationOutcome::Updated {
            state,
            changed: true,
        })
    }

    /// Undoes the caller's expected latest review while the card is still
    /// owned by the same Agent session and the FSRS version remains current.
    pub fn undo_last_review_for_session(
        &self,
        card_id: &str,
        session_id: &str,
        expected_review_version: i64,
        expected_log_id: &str,
    ) -> Result<FsrsAgentReviewMutationOutcome> {
        if session_id.trim().is_empty() {
            return Err(AppError::validation(
                "cardId, sessionId, and expectedLogId are required",
            ));
        }
        self.undo_last_review_for_agent_scope(
            card_id,
            FsrsAgentMutationScope::Session(session_id),
            expected_review_version,
            expected_log_id,
        )
    }

    pub fn undo_last_review_for_library(
        &self,
        scope: AnkiLibraryScope,
        card_id: &str,
        expected_review_version: i64,
        expected_log_id: &str,
    ) -> Result<FsrsAgentReviewMutationOutcome> {
        self.undo_last_review_for_agent_scope(
            card_id,
            FsrsAgentMutationScope::Library(scope),
            expected_review_version,
            expected_log_id,
        )
    }

    fn undo_last_review_for_agent_scope(
        &self,
        card_id: &str,
        scope: FsrsAgentMutationScope<'_>,
        expected_review_version: i64,
        expected_log_id: &str,
    ) -> Result<FsrsAgentReviewMutationOutcome> {
        if card_id.trim().is_empty()
            || expected_review_version < 0
            || expected_log_id.trim().is_empty()
        {
            return Err(AppError::validation(
                "cardId, non-negative expectedReviewVersion, and expectedLogId are required",
            ));
        }

        let mut conn = self
            .db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取数据库连接失败: {}", e)))?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| AppError::database(format!("开启 Agent 撤销事务失败: {}", e)))?;
        let Some((is_error_card, record)) = Self::load_scoped_agent_state(&tx, card_id, scope)?
        else {
            return Ok(FsrsAgentReviewMutationOutcome::NotFound);
        };
        let (current, latest_review) = Self::load_agent_snapshot(&tx, &record, is_error_card)?;

        if is_error_card {
            return Ok(FsrsAgentReviewMutationOutcome::Blocked {
                reason: "diagnostic_card".to_string(),
                current,
            });
        }
        if record.review_version != expected_review_version {
            return Ok(FsrsAgentReviewMutationOutcome::Conflict { current });
        }
        let Some(latest_review) = latest_review else {
            return Ok(FsrsAgentReviewMutationOutcome::Conflict { current });
        };
        if latest_review.log_id != expected_log_id
            || latest_review.anki_card_id != card_id
            || record.state.last_review_ms != Some(latest_review.review_ms)
            || latest_review.updated_at.as_deref() != Some(record.state.updated_at.as_str())
        {
            return Ok(FsrsAgentReviewMutationOutcome::Conflict { current });
        }

        let Some(state_before_json) = latest_review.state_before_json.as_deref() else {
            return Ok(FsrsAgentReviewMutationOutcome::Blocked {
                reason: "undo_snapshot_unavailable".to_string(),
                current,
            });
        };
        let snapshot: FsrsStateBeforeSnapshot = match serde_json::from_str(state_before_json) {
            Ok(snapshot) => snapshot,
            Err(_) => {
                return Ok(FsrsAgentReviewMutationOutcome::Blocked {
                    reason: "undo_snapshot_damaged".to_string(),
                    current,
                });
            }
        };
        if snapshot.validate_for(&record.state).is_err() {
            return Ok(FsrsAgentReviewMutationOutcome::Blocked {
                reason: "undo_snapshot_invalid".to_string(),
                current,
            });
        }

        let now = Utc::now();
        let mut now_rfc = now.to_rfc3339();
        if now_rfc == record.state.updated_at {
            now_rfc = (now + chrono::Duration::nanoseconds(1)).to_rfc3339();
        }
        let restored = tx
            .execute(
                "UPDATE fsrs_card_states SET
                    deck_id = ?1,
                    state = ?2,
                    stability = ?3,
                    difficulty = ?4,
                    elapsed_days = ?5,
                    scheduled_days = ?6,
                    reps = ?7,
                    lapses = ?8,
                    due_ms = ?9,
                    last_review_ms = ?10,
                    suspended = ?11,
                    fsrs_params_version = ?12,
                    desired_retention = ?13,
                    updated_at = ?14,
                    local_version = COALESCE(local_version, 0) + 1
                 WHERE id = ?15
                   AND anki_card_id = ?16
                   AND COALESCE(local_version, 0) = ?17
                   AND last_review_ms = ?18
                   AND updated_at = ?19
                   AND deleted_at IS NULL
                   AND EXISTS (
                       SELECT 1
                       FROM anki_cards ac
                       INNER JOIN document_tasks dt ON dt.id = ac.task_id
                       WHERE ac.id = fsrs_card_states.anki_card_id
                         AND ac.deleted_at IS NULL
                         AND dt.deleted_at IS NULL
                   )",
                params![
                    snapshot.deck_id,
                    snapshot.state,
                    snapshot.stability,
                    snapshot.difficulty,
                    snapshot.elapsed_days,
                    snapshot.scheduled_days,
                    snapshot.reps,
                    snapshot.lapses,
                    snapshot.due_ms,
                    snapshot.last_review_ms,
                    if snapshot.suspended { 1 } else { 0 },
                    snapshot.fsrs_params_version,
                    snapshot.desired_retention,
                    now_rfc,
                    record.state.id,
                    card_id,
                    expected_review_version,
                    latest_review.review_ms,
                    record.state.updated_at,
                ],
            )
            .map_err(|e| AppError::database(format!("恢复 Agent FSRS 卡片状态失败: {}", e)))?;
        if restored != 1 {
            let Some((diagnostic, latest_record)) =
                Self::load_scoped_agent_state(&tx, card_id, scope)?
            else {
                return Ok(FsrsAgentReviewMutationOutcome::NotFound);
            };
            let (current, _) = Self::load_agent_snapshot(&tx, &latest_record, diagnostic)?;
            return Ok(FsrsAgentReviewMutationOutcome::Conflict { current });
        }

        let deleted = tx
            .execute(
                "UPDATE fsrs_review_logs
                 SET deleted_at = ?1,
                     updated_at = ?1,
                     local_version = COALESCE(local_version, 0) + 1
                 WHERE id = ?2
                   AND card_state_id = ?3
                   AND anki_card_id = ?4
                   AND updated_at = ?5
                   AND deleted_at IS NULL",
                params![
                    now_rfc,
                    expected_log_id,
                    record.state.id,
                    card_id,
                    record.state.updated_at,
                ],
            )
            .map_err(|e| AppError::database(format!("软删除 Agent 复习日志失败: {}", e)))?;
        if deleted != 1 {
            return Ok(FsrsAgentReviewMutationOutcome::Conflict { current });
        }

        let updated_record = Self::load_agent_state_record(&tx, card_id)?
            .ok_or_else(|| AppError::database("state missing after Agent undo"))?;
        let (state, _) = Self::load_agent_snapshot(&tx, &updated_record, false)?;
        tx.commit()
            .map_err(|e| AppError::database(format!("提交 Agent 撤销事务失败: {}", e)))?;
        Ok(FsrsAgentReviewMutationOutcome::Updated {
            state,
            changed: true,
        })
    }

    pub fn suspend_card(&self, card_state_id: &str) -> Result<FsrsSuspendResult> {
        self.set_suspended(card_state_id, true)
    }

    pub fn unsuspend_card(&self, card_state_id: &str) -> Result<FsrsSuspendResult> {
        self.set_suspended(card_state_id, false)
    }

    fn set_suspended(&self, card_state_id: &str, suspended: bool) -> Result<FsrsSuspendResult> {
        if card_state_id.trim().is_empty() {
            return Err(AppError::validation("cardStateId is required"));
        }

        let now_rfc = Utc::now().to_rfc3339();
        let mut conn = self
            .db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取数据库连接失败: {}", e)))?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| AppError::database(format!("开启暂停事务失败: {}", e)))?;
        let before = Self::load_state_by_id(&tx, card_state_id)?.ok_or_else(|| {
            AppError::not_found(format!("fsrs card state not found: {}", card_state_id))
        })?;
        if before.suspended == suspended {
            tx.commit()
                .map_err(|e| AppError::database(format!("提交暂停事务失败: {}", e)))?;
            return Ok(FsrsSuspendResult {
                state: before,
                changed: false,
            });
        }

        let updated = tx
            .execute(
                "UPDATE fsrs_card_states
                 SET suspended = ?1,
                     updated_at = ?2,
                     local_version = COALESCE(local_version, 0) + 1
                 WHERE id = ?3
                   AND deleted_at IS NULL
                   AND suspended = ?4",
                params![
                    if suspended { 1 } else { 0 },
                    now_rfc,
                    card_state_id,
                    if before.suspended { 1 } else { 0 },
                ],
            )
            .map_err(|e| AppError::database(format!("更新卡片暂停状态失败: {}", e)))?;
        if updated != 1 {
            return Err(AppError::conflict(
                "card state changed while updating suspension",
            ));
        }
        let state = Self::load_state_by_id(&tx, card_state_id)?
            .ok_or_else(|| AppError::database("state missing after suspension update"))?;
        tx.commit()
            .map_err(|e| AppError::database(format!("提交暂停事务失败: {}", e)))?;

        Ok(FsrsSuspendResult {
            state,
            changed: true,
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
                 INNER JOIN document_tasks dt ON dt.id = a.task_id
                 WHERE s.deleted_at IS NULL
                   AND a.deleted_at IS NULL
                   AND dt.deleted_at IS NULL
                   AND COALESCE(a.is_error_card, 0) = 0",
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
                 INNER JOIN document_tasks dt ON dt.id = a.task_id
                 WHERE l.deleted_at IS NULL
                   AND s.deleted_at IS NULL
                   AND a.deleted_at IS NULL
                   AND dt.deleted_at IS NULL
                   AND COALESCE(a.is_error_card, 0) = 0
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
             INNER JOIN document_tasks dt ON dt.id = a.task_id
             WHERE s.id = ?1
               AND s.deleted_at IS NULL
               AND a.deleted_at IS NULL
               AND dt.deleted_at IS NULL",
            params![id],
            Self::map_state_row,
        )
        .optional()
        .map_err(|e| AppError::database(format!("加载 card state 失败: {}", e)))
    }

    fn load_agent_card_guard(
        conn: &rusqlite::Connection,
        card_id: &str,
    ) -> Result<Option<(String, bool)>> {
        conn.query_row(
            "SELECT dt.document_id, COALESCE(ac.is_error_card, 0)
             FROM anki_cards ac
             INNER JOIN document_tasks dt ON dt.id = ac.task_id
             WHERE ac.id = ?1
               AND ac.deleted_at IS NULL
               AND dt.deleted_at IS NULL",
            params![card_id],
            |row| Ok((row.get(0)?, row.get::<_, i32>(1)? != 0)),
        )
        .optional()
        .map_err(|e| AppError::database(format!("加载 Agent 卡片归属失败: {}", e)))
    }

    fn load_agent_state_record(
        conn: &rusqlite::Connection,
        card_id: &str,
    ) -> Result<Option<FsrsAgentStateRecord>> {
        conn.query_row(
            "SELECT s.id, s.anki_card_id, s.deck_id, s.state, s.stability, s.difficulty,
                    s.elapsed_days, s.scheduled_days, s.reps, s.lapses, s.due_ms,
                    s.last_review_ms, s.suspended, s.fsrs_params_version,
                    s.desired_retention, s.created_at, s.updated_at,
                    COALESCE(s.local_version, 0)
             FROM fsrs_card_states s
             INNER JOIN anki_cards ac ON ac.id = s.anki_card_id
             INNER JOIN document_tasks dt ON dt.id = ac.task_id
             WHERE s.anki_card_id = ?1
               AND s.deleted_at IS NULL
               AND ac.deleted_at IS NULL
               AND dt.deleted_at IS NULL",
            params![card_id],
            |row| {
                Ok(FsrsAgentStateRecord {
                    state: Self::map_state_row(row)?,
                    review_version: row.get(17)?,
                })
            },
        )
        .optional()
        .map_err(|e| AppError::database(format!("加载 Agent FSRS 状态失败: {}", e)))
    }

    fn load_owned_agent_state(
        conn: &rusqlite::Connection,
        card_id: &str,
        session_id: &str,
    ) -> Result<Option<(bool, FsrsAgentStateRecord)>> {
        let Some((document_id, is_error_card)) = Self::load_agent_card_guard(conn, card_id)? else {
            return Ok(None);
        };
        if !Self::document_owned_by_session(conn, &document_id, session_id)? {
            return Ok(None);
        }
        let Some(record) = Self::load_agent_state_record(conn, card_id)? else {
            return Ok(None);
        };
        Ok(Some((is_error_card, record)))
    }

    fn load_scoped_agent_state(
        conn: &rusqlite::Connection,
        card_id: &str,
        scope: FsrsAgentMutationScope<'_>,
    ) -> Result<Option<(bool, FsrsAgentStateRecord)>> {
        match scope {
            FsrsAgentMutationScope::Session(session_id) => {
                Self::load_owned_agent_state(conn, card_id, session_id)
            }
            FsrsAgentMutationScope::Library(_) => {
                let Some((_document_id, is_error_card)) =
                    Self::load_agent_card_guard(conn, card_id)?
                else {
                    return Ok(None);
                };
                let Some(record) = Self::load_agent_state_record(conn, card_id)? else {
                    return Ok(None);
                };
                Ok(Some((is_error_card, record)))
            }
        }
    }

    fn load_latest_agent_review(
        conn: &rusqlite::Connection,
        card_state_id: &str,
    ) -> Result<Option<FsrsAgentReviewLogRecord>> {
        conn.query_row(
            "SELECT id, anki_card_id, rating, review_ms, state_before_json, updated_at
             FROM fsrs_review_logs
             WHERE card_state_id = ?1
               AND deleted_at IS NULL
             ORDER BY review_ms DESC, created_at DESC, id DESC
             LIMIT 1",
            params![card_state_id],
            |row| {
                Ok(FsrsAgentReviewLogRecord {
                    log_id: row.get(0)?,
                    anki_card_id: row.get(1)?,
                    rating: row.get(2)?,
                    review_ms: row.get(3)?,
                    state_before_json: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(|e| AppError::database(format!("加载 Agent 最新复习日志失败: {}", e)))
    }

    fn load_agent_snapshot(
        conn: &rusqlite::Connection,
        record: &FsrsAgentStateRecord,
        is_error_card: bool,
    ) -> Result<(
        FsrsAgentReviewStateSnapshot,
        Option<FsrsAgentReviewLogRecord>,
    )> {
        let latest = Self::load_latest_agent_review(conn, &record.state.id)?;
        Ok((
            Self::build_agent_snapshot(record, is_error_card, latest.as_ref()),
            latest,
        ))
    }

    fn build_agent_snapshot(
        record: &FsrsAgentStateRecord,
        is_error_card: bool,
        latest: Option<&FsrsAgentReviewLogRecord>,
    ) -> FsrsAgentReviewStateSnapshot {
        let latest_review = latest.map(|log| {
            let snapshot_is_valid = log
                .state_before_json
                .as_deref()
                .and_then(|value| serde_json::from_str::<FsrsStateBeforeSnapshot>(value).ok())
                .map(|snapshot| snapshot.validate_for(&record.state).is_ok())
                .unwrap_or(false);
            FsrsAgentLatestReviewSnapshot {
                log_id: log.log_id.clone(),
                rating: log.rating,
                review_ms: log.review_ms,
                undoable: !is_error_card
                    && log.anki_card_id == record.state.anki_card_id
                    && record.state.last_review_ms == Some(log.review_ms)
                    && log.updated_at.as_deref() == Some(record.state.updated_at.as_str())
                    && snapshot_is_valid,
            }
        });
        FsrsAgentReviewStateSnapshot {
            anki_card_id: record.state.anki_card_id.clone(),
            card_state_id: record.state.id.clone(),
            state: record.state.state,
            suspended: record.state.suspended,
            due_ms: record.state.due_ms,
            last_review_ms: record.state.last_review_ms,
            review_version: record.review_version,
            latest_review,
        }
    }

    /// Loads the scheduling state and current diagnostic flag from one live
    /// card/task snapshot. Callers must hold the write transaction that will
    /// apply the rating so the card cannot become diagnostic after this check.
    fn load_state_for_rate(
        conn: &rusqlite::Connection,
        id: &str,
    ) -> Result<Option<(FsrsCardState, bool)>> {
        conn.query_row(
            "SELECT s.id, s.anki_card_id, s.deck_id, s.state, s.stability, s.difficulty,
                    s.elapsed_days, s.scheduled_days, s.reps, s.lapses, s.due_ms, s.last_review_ms,
                    s.suspended, s.fsrs_params_version, s.desired_retention, s.created_at, s.updated_at,
                    COALESCE(a.is_error_card, 0)
             FROM fsrs_card_states s
             INNER JOIN anki_cards a ON a.id = s.anki_card_id
             INNER JOIN document_tasks dt ON dt.id = a.task_id
             WHERE s.id = ?1
               AND s.deleted_at IS NULL
               AND a.deleted_at IS NULL
               AND dt.deleted_at IS NULL",
            params![id],
            |row| {
                Ok((
                    Self::map_state_row(row)?,
                    row.get::<_, i32>(17)? != 0,
                ))
            },
        )
        .optional()
        .map_err(|e| AppError::database(format!("加载待评分 card state 失败: {}", e)))
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
             INNER JOIN document_tasks dt ON dt.id = a.task_id
             WHERE s.anki_card_id = ?1
               AND s.deleted_at IS NULL
               AND a.deleted_at IS NULL
               AND dt.deleted_at IS NULL",
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
    use crate::data_governance::migration::{MigrationCoordinator, MISTAKES_MIGRATIONS};
    use crate::data_governance::schema_registry::DatabaseId;
    use rusqlite::params;
    use serde_json::{json, Value};
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
        assert_eq!(
            first.to_version,
            MISTAKES_MIGRATIONS.latest_version() as u32
        );
        let second = coordinator
            .migrate_single(DatabaseId::Mistakes)
            .expect("repeat mistakes migration");
        assert_eq!(
            second.to_version,
            MISTAKES_MIGRATIONS.latest_version() as u32
        );
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

    fn insert_card_for_task(db: &Database, document_id: &str, task_id: &str, card_id: &str) {
        let conn = db.get_conn_safe().expect("open mistakes connection");
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
        .expect("insert additional Anki card");
    }

    fn set_task_owner(db: &Database, task_id: &str, session_id: &str) {
        let conn = db.get_conn_safe().expect("open mistakes connection");
        let updated = conn
            .execute(
                "UPDATE document_tasks SET source_session_id = ?1 WHERE id = ?2",
                params![session_id, task_id],
            )
            .expect("assign task owner");
        assert_eq!(updated, 1);
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

    fn expect_agent_updated(
        outcome: FsrsAgentReviewMutationOutcome,
        expected_changed: bool,
    ) -> FsrsAgentReviewStateSnapshot {
        match outcome {
            FsrsAgentReviewMutationOutcome::Updated { state, changed } => {
                assert_eq!(changed, expected_changed);
                state
            }
            other => panic!("expected Agent update outcome, got {other:?}"),
        }
    }

    #[test]
    fn session_enqueue_succeeds_then_skips_existing_state() {
        let (_temp_dir, db) = setup_migrated_fsrs_db();
        insert_task_and_card(&db, "doc-owned", "task-owned", "card-owned");
        set_task_owner(&db, "task-owned", "session-owner");
        let ids = vec!["card-owned".to_string()];
        let service = FsrsReviewService::new(db.clone());

        let first = service
            .enqueue_cards_for_session(
                &[ids[0].clone(), format!(" {} ", ids[0])],
                "session-owner",
                None,
            )
            .expect("enqueue owned card IDs");
        assert_eq!(first.enqueued, 1);
        assert_eq!(first.skipped, 0);
        assert_eq!(first.enqueued_state_ids, vec![first.states[0].id.clone()]);
        assert_eq!(first.states.len(), 1);
        assert_eq!(first.review_cards.len(), 1);
        assert_eq!(first.review_cards[0].id, first.states[0].id);
        assert_eq!(first.review_cards[0].anki_card_id, "card-owned");

        let repeated = service
            .enqueue_cards_for_session(&ids, "session-owner", None)
            .expect("skip existing state");
        assert_eq!(repeated.enqueued, 0);
        assert_eq!(repeated.skipped, 1);
        assert!(repeated.enqueued_state_ids.is_empty());
        assert_eq!(repeated.states.len(), 1);
        assert_eq!(repeated.review_cards.len(), 1);
        assert_eq!(repeated.review_cards[0].id, repeated.states[0].id);
        assert!(service
            .get_enqueued_cards(&repeated)
            .expect("filter skipped-only event cards")
            .is_empty());

        let stats = service.get_stats().expect("load stats");
        assert_eq!(stats.total, 1);
        assert_eq!(stats.due, 1);
        assert_eq!(stats.new_count, 1);
    }

    #[test]
    fn enqueue_result_and_event_cards_distinguish_new_from_skipped_states() {
        let (_temp_dir, db) = setup_migrated_fsrs_db();
        insert_task_and_card(&db, "doc-mixed", "task-mixed", "card-skipped");
        insert_card_for_task(&db, "doc-mixed", "task-mixed", "card-new");
        {
            let conn = db.get_conn_safe().expect("open mistakes connection");
            conn.execute(
                "UPDATE anki_cards
                 SET tags_json = '[\"new-tag\"]', text = 'new {{c1::text}}'
                 WHERE id = 'card-new'",
                [],
            )
            .expect("add event tag fixture");
            conn.execute(
                "UPDATE anki_cards
                 SET tags_json = '[\"skipped-tag\"]', text = 'skipped {{c1::text}}'
                 WHERE id = 'card-skipped'",
                [],
            )
            .expect("add skipped event fixture");
        }
        let service = FsrsReviewService::new(db.clone());
        let initial = service
            .enqueue_cards(&["card-skipped".to_string()])
            .expect("enqueue skipped fixture first");
        let skipped_state_id = initial.states[0].id.clone();

        let mixed = service
            .enqueue_cards(&["card-skipped".to_string(), "card-new".to_string()])
            .expect("enqueue mixed batch");
        assert_eq!(mixed.enqueued, 1);
        assert_eq!(mixed.skipped, 1);
        assert_eq!(mixed.states.len(), 2, "batch response keeps all states");
        assert_eq!(
            mixed.review_cards.len(),
            2,
            "review payload keeps new and skipped states"
        );
        assert_eq!(mixed.review_cards[0].id, skipped_state_id);
        assert_eq!(mixed.review_cards[0].anki_card_id, "card-skipped");
        assert_eq!(mixed.review_cards[0].front, "front-card-skipped");
        assert_eq!(mixed.review_cards[0].back, "back-card-skipped");
        assert_eq!(mixed.review_cards[0].tags, vec!["skipped-tag"]);
        assert_eq!(
            mixed.review_cards[0].text.as_deref(),
            Some("skipped {{c1::text}}")
        );
        assert_eq!(mixed.enqueued_state_ids.len(), 1);
        assert_ne!(mixed.enqueued_state_ids[0], skipped_state_id);
        assert_eq!(
            mixed
                .states
                .iter()
                .find(|state| state.id == mixed.enqueued_state_ids[0])
                .expect("new state remains in full batch response")
                .anki_card_id,
            "card-new"
        );

        let event_cards = service
            .get_enqueued_cards(&mixed)
            .expect("load newly enqueued event cards");
        assert_eq!(event_cards.len(), 1);
        assert_eq!(event_cards[0].id, mixed.enqueued_state_ids[0]);
        assert_eq!(event_cards[0].anki_card_id, "card-new");
        assert_eq!(event_cards[0].front, "front-card-new");
        assert_eq!(event_cards[0].back, "back-card-new");
        assert_eq!(event_cards[0].tags, vec!["new-tag"]);
        assert_eq!(event_cards[0].text.as_deref(), Some("new {{c1::text}}"));
        assert!(!event_cards[0].front.is_empty());
        assert!(!event_cards[0].back.is_empty());

        let serialized = serde_json::to_value(&mixed).expect("serialize enqueue result");
        assert_eq!(
            serialized["enqueuedStateIds"],
            json!(mixed.enqueued_state_ids)
        );
        assert_eq!(serialized["reviewCards"].as_array().map(Vec::len), Some(2));
        assert_eq!(serialized["reviewCards"][0]["ankiCardId"], "card-skipped");
        assert_eq!(serialized["reviewCards"][0]["front"], "front-card-skipped");
        assert_eq!(serialized["reviewCards"][1]["ankiCardId"], "card-new");
        assert_eq!(serialized["reviewCards"][1]["text"], "new {{c1::text}}");

        let skipped_only = service
            .enqueue_cards(&["card-skipped".to_string(), "card-new".to_string()])
            .expect("enqueue skipped-only batch");
        assert_eq!(skipped_only.enqueued, 0);
        assert_eq!(skipped_only.skipped, 2);
        assert_eq!(skipped_only.states.len(), 2);
        assert_eq!(skipped_only.review_cards.len(), 2);
        assert!(service
            .get_enqueued_cards(&skipped_only)
            .expect("skipped-only event filter")
            .is_empty());
        let skipped_serialized =
            serde_json::to_value(&skipped_only).expect("serialize skipped-only result");
        assert_eq!(
            skipped_serialized["reviewCards"].as_array().map(Vec::len),
            Some(2)
        );
        assert_eq!(
            skipped_serialized["reviewCards"][0]["front"],
            "front-card-skipped"
        );

        let legacy: FsrsEnqueueResult = serde_json::from_value(json!({
            "enqueued": 0,
            "skipped": 0,
            "enqueuedStateIds": [],
            "states": []
        }))
        .expect("deserialize result written before reviewCards existed");
        assert!(legacy.review_cards.is_empty());
    }

    #[test]
    fn enqueue_rolls_back_when_review_card_snapshot_is_invalid() {
        let (_temp_dir, db) = setup_migrated_fsrs_db();
        insert_task_and_card(
            &db,
            "doc-invalid-content",
            "task-invalid-content",
            "card-invalid",
        );
        {
            let conn = db.get_conn_safe().expect("open mistakes connection");
            conn.execute(
                "UPDATE anki_cards SET tags_json = 'not-json' WHERE id = 'card-invalid'",
                [],
            )
            .expect("corrupt tags fixture");
        }
        let service = FsrsReviewService::new(db.clone());

        let error = service
            .enqueue_cards(&["card-invalid".to_string()])
            .expect_err("snapshot failure rolls back enqueue");
        assert!(error.message.contains("解析入队卡片标签失败"));
        assert_eq!(
            service
                .get_stats()
                .expect("load stats after rollback")
                .total,
            0
        );
    }

    #[test]
    fn session_enqueue_rolls_back_mixed_owner_batch() {
        let (_temp_dir, db) = setup_migrated_fsrs_db();
        insert_task_and_card(&db, "doc-owner", "task-owner", "card-owner");
        set_task_owner(&db, "task-owner", "session-owner");
        insert_task_and_card(&db, "doc-foreign", "task-foreign", "card-foreign");
        set_task_owner(&db, "task-foreign", "session-foreign");
        let service = FsrsReviewService::new(db.clone());

        let error = service
            .enqueue_cards_for_session(
                &["card-owner".to_string(), "card-foreign".to_string()],
                "session-owner",
                None,
            )
            .expect_err("foreign card rejects the complete batch");
        assert_eq!(error.message, "blocks.ankiCards.errors.statusNotFound");
        assert_eq!(service.get_stats().expect("load stats").total, 0);
    }

    #[test]
    fn document_selector_reloads_more_than_one_hundred_live_cards() {
        let (_temp_dir, db) = setup_migrated_fsrs_db();
        insert_task_and_card(&db, "doc-large", "task-large", "card-large-0");
        set_task_owner(&db, "task-large", "session-owner");
        for index in 1..=100 {
            insert_card_for_task(
                &db,
                "doc-large",
                "task-large",
                &format!("card-large-{index}"),
            );
        }
        let service = FsrsReviewService::new(db.clone());
        let explicit_ids: Vec<String> = (0..=100)
            .map(|index| format!("card-large-{index}"))
            .collect();

        let explicit_error = service
            .enqueue_cards_for_session(&explicit_ids, "session-owner", None)
            .expect_err("explicit cardIds remain capped at 100");
        assert!(explicit_error.message.contains("at most 100"));

        let document_result = service
            .enqueue_cards_for_session(&[], "session-owner", Some("doc-large"))
            .expect("document selector reloads its complete live set");
        assert_eq!(document_result.enqueued, 101);
        assert_eq!(document_result.skipped, 0);
        assert_eq!(document_result.states.len(), 101);
        assert_eq!(service.get_stats().expect("load stats").total, 101);
    }

    #[test]
    fn document_selector_ignores_soft_deleted_cards_during_transaction_reload() {
        let (_temp_dir, db) = setup_migrated_fsrs_db();
        insert_task_and_card(&db, "doc-live", "task-live", "card-live");
        insert_card_for_task(&db, "doc-live", "task-live", "card-soft-deleted");
        set_task_owner(&db, "task-live", "session-owner");
        {
            let conn = db.get_conn_safe().expect("open mistakes connection");
            conn.execute(
                "UPDATE anki_cards SET deleted_at = ?1 WHERE id = ?2",
                params!["2026-07-13T00:00:00Z", "card-soft-deleted"],
            )
            .expect("soft delete fixture card");
        }
        let service = FsrsReviewService::new(db.clone());

        let result = service
            .enqueue_cards_for_session(
                &["card-soft-deleted".to_string()],
                "session-owner",
                Some("doc-live"),
            )
            .expect("document reload ignores stale pre-resolved soft delete");
        assert_eq!(result.enqueued, 1);
        assert_eq!(result.skipped, 0);
        assert_eq!(result.states.len(), 1);
        assert_eq!(result.states[0].anki_card_id, "card-live");
        assert_eq!(service.get_stats().expect("load stats").total, 1);
    }

    #[test]
    fn document_selector_excludes_diagnostic_cards() {
        let (_temp_dir, db) = setup_migrated_fsrs_db();
        insert_task_and_card(&db, "doc-diagnostic", "task-diagnostic", "card-reviewable");
        insert_card_for_task(&db, "doc-diagnostic", "task-diagnostic", "card-diagnostic");
        set_task_owner(&db, "task-diagnostic", "session-owner");
        {
            let conn = db.get_conn_safe().expect("open mistakes connection");
            conn.execute(
                "UPDATE anki_cards
                 SET is_error_card = 1, error_content = 'generation failed'
                 WHERE id = 'card-diagnostic'",
                [],
            )
            .expect("mark diagnostic card");
        }
        let service = FsrsReviewService::new(db.clone());

        let result = service
            .enqueue_cards_for_session(
                &["card-diagnostic".to_string()],
                "session-owner",
                Some("doc-diagnostic"),
            )
            .expect("document selector filters diagnostic cards");

        assert_eq!(result.enqueued, 1);
        assert_eq!(result.skipped, 0);
        assert_eq!(result.states.len(), 1);
        assert_eq!(result.states[0].anki_card_id, "card-reviewable");
        assert_no_fsrs_rows(&db, &["card-diagnostic"]);
    }

    #[test]
    fn explicit_card_ids_reject_diagnostic_card_atomically() {
        let (_temp_dir, db) = setup_migrated_fsrs_db();
        insert_task_and_card(
            &db,
            "doc-explicit-diagnostic",
            "task-explicit-diagnostic",
            "card-reviewable",
        );
        insert_card_for_task(
            &db,
            "doc-explicit-diagnostic",
            "task-explicit-diagnostic",
            "card-diagnostic",
        );
        set_task_owner(&db, "task-explicit-diagnostic", "session-owner");
        {
            let conn = db.get_conn_safe().expect("open mistakes connection");
            conn.execute(
                "UPDATE anki_cards
                 SET is_error_card = 1, error_content = 'generation failed'
                 WHERE id = 'card-diagnostic'",
                [],
            )
            .expect("mark diagnostic card");
        }
        let service = FsrsReviewService::new(db.clone());

        let error = service
            .enqueue_cards_for_session(
                &["card-reviewable".to_string(), "card-diagnostic".to_string()],
                "session-owner",
                None,
            )
            .expect_err("explicit diagnostic selection must be rejected");

        assert!(matches!(error.error_type, AppErrorType::Validation));
        assert_eq!(
            error
                .details
                .as_ref()
                .and_then(|details| details.get("errorCode"))
                .and_then(Value::as_str),
            Some(FSRS_ERROR_DIAGNOSTIC_CARD_NOT_REVIEWABLE),
        );
        assert_eq!(
            error
                .details
                .as_ref()
                .and_then(|details| details.get("cardId"))
                .and_then(Value::as_str),
            Some("card-diagnostic"),
        );
        assert_no_fsrs_rows(&db, &["card-reviewable", "card-diagnostic"]);
    }

    #[test]
    fn rate_rejects_card_that_became_diagnostic_without_mutating_state_or_logs() {
        let (_temp_dir, db) = setup_migrated_fsrs_db();
        const CARD_ID: &str = "card-stale-diagnostic";
        insert_task_and_card(
            &db,
            "doc-stale-diagnostic",
            "task-stale-diagnostic",
            CARD_ID,
        );
        let service = FsrsReviewService::new(db.clone());
        let enqueue = service
            .enqueue_cards(&[CARD_ID.to_string()])
            .expect("enqueue card before it becomes diagnostic");
        assert_eq!(enqueue.enqueued, 1);
        let state_id = enqueue.states[0].id.clone();

        {
            let conn = db.get_conn_safe().expect("open mistakes connection");
            let changed = conn
                .execute(
                    "UPDATE anki_cards
                     SET is_error_card = 1, error_content = 'late generation diagnostic'
                     WHERE id = ?1",
                    params![CARD_ID],
                )
                .expect("mark enqueued card as diagnostic");
            assert_eq!(changed, 1);
        }

        let state_and_log_fingerprint = || {
            let conn = db.get_conn_safe().expect("open mistakes connection");
            let state_json: String = conn
                .query_row(
                    "SELECT json_object(
                        'id', id,
                        'ankiCardId', anki_card_id,
                        'deckId', deck_id,
                        'state', state,
                        'stability', stability,
                        'difficulty', difficulty,
                        'elapsedDays', elapsed_days,
                        'scheduledDays', scheduled_days,
                        'reps', reps,
                        'lapses', lapses,
                        'dueMs', due_ms,
                        'lastReviewMs', last_review_ms,
                        'suspended', suspended,
                        'paramsVersion', fsrs_params_version,
                        'desiredRetention', desired_retention,
                        'createdAt', created_at,
                        'updatedAt', updated_at,
                        'deviceId', device_id,
                        'localVersion', local_version,
                        'deletedAt', deleted_at
                     )
                     FROM fsrs_card_states
                     WHERE id = ?1",
                    params![state_id.as_str()],
                    |row| row.get(0),
                )
                .expect("load complete FSRS state fingerprint");
            let log_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*)
                     FROM fsrs_review_logs
                     WHERE card_state_id = ?1 OR anki_card_id = ?2",
                    params![state_id.as_str(), CARD_ID],
                    |row| row.get(0),
                )
                .expect("count review logs for diagnostic fixture");
            (state_json, log_count)
        };
        let before = state_and_log_fingerprint();
        assert_eq!(before.1, 0);

        let error = service
            .rate(&state_id, 3, Some(125))
            .expect_err("stale state ID must not rate a card that became diagnostic");

        assert!(matches!(error.error_type, AppErrorType::Validation));
        assert_eq!(
            error
                .details
                .as_ref()
                .and_then(|details| details.get("errorCode"))
                .and_then(Value::as_str),
            Some(FSRS_ERROR_DIAGNOSTIC_CARD_NOT_REVIEWABLE),
        );
        assert_eq!(
            error
                .details
                .as_ref()
                .and_then(|details| details.get("cardId"))
                .and_then(Value::as_str),
            Some(CARD_ID),
        );
        assert_eq!(
            state_and_log_fingerprint(),
            before,
            "rejected rating must not change any state column or create a review log"
        );
    }

    #[test]
    fn due_and_stats_hide_card_that_became_diagnostic_after_enqueue() {
        let (_temp_dir, db) = setup_migrated_fsrs_db();
        insert_task_and_card(
            &db,
            "doc-due-diagnostic",
            "task-due-diagnostic",
            "card-due-diagnostic",
        );
        let service = FsrsReviewService::new(db.clone());
        let result = service
            .enqueue_cards(&["card-due-diagnostic".to_string()])
            .expect("enqueue reviewable card");
        assert_eq!(result.enqueued, 1);
        service
            .rate(&result.states[0].id, 3, Some(25))
            .expect("create today's review log");
        {
            let conn = db.get_conn_safe().expect("open mistakes connection");
            conn.execute(
                "UPDATE fsrs_card_states
                 SET state = 0, suspended = 0, due_ms = ?1
                 WHERE anki_card_id = 'card-due-diagnostic'",
                params![Utc::now().timestamp_millis() - 1],
            )
            .expect("make reviewed fixture due again");
        }
        assert_eq!(service.get_due(None).expect("load initial due").len(), 1);
        let initial_stats = service.get_stats().expect("load initial stats");
        assert_eq!(initial_stats.total, 1);
        assert_eq!(initial_stats.due, 1);
        assert_eq!(initial_stats.new_count, 1);
        assert_eq!(initial_stats.reviews_today, 1);
        {
            let conn = db.get_conn_safe().expect("open mistakes connection");
            conn.execute(
                "UPDATE anki_cards
                 SET is_error_card = 1, error_content = 'late diagnostic'
                 WHERE id = 'card-due-diagnostic'",
                [],
            )
            .expect("mark enqueued card as diagnostic");
        }

        assert!(service
            .get_due(None)
            .expect("diagnostic card is not due")
            .is_empty());
        let diagnostic_stats = service.get_stats().expect("load diagnostic stats");
        assert_eq!(diagnostic_stats.total, 0);
        assert_eq!(diagnostic_stats.due, 0);
        assert_eq!(diagnostic_stats.new_count, 0);
        assert_eq!(diagnostic_stats.learning, 0);
        assert_eq!(diagnostic_stats.review, 0);
        assert_eq!(diagnostic_stats.relearning, 0);
        assert_eq!(diagnostic_stats.suspended, 0);
        assert_eq!(diagnostic_stats.reviews_today, 0);

        {
            let conn = db.get_conn_safe().expect("open mistakes connection");
            conn.execute(
                "UPDATE fsrs_card_states
                 SET suspended = 1
                 WHERE anki_card_id = 'card-due-diagnostic'",
                [],
            )
            .expect("suspend hidden diagnostic fixture");
        }
        let suspended_stats = service
            .get_stats()
            .expect("load suspended diagnostic stats");
        assert_eq!(suspended_stats.total, 0);
        assert_eq!(suspended_stats.suspended, 0);
        assert_eq!(suspended_stats.reviews_today, 0);
    }

    #[test]
    fn soft_deleted_card_is_hidden_from_agent_crud_and_fsrs() {
        let (_temp_dir, db) = setup_migrated_fsrs_db();
        insert_task_and_card(
            &db,
            "doc-card-tombstone",
            "task-card-tombstone",
            "card-tombstone",
        );
        insert_card_for_task(
            &db,
            "doc-card-tombstone",
            "task-card-tombstone",
            "card-still-live",
        );
        set_task_owner(&db, "task-card-tombstone", "session-owner");
        let (mut tombstoned_card, _) = db
            .get_anki_card_for_session("card-tombstone", "session-owner")
            .expect("load card before tombstone")
            .expect("live card exists");
        let expected_version = tombstoned_card.updated_at.clone();
        let service = FsrsReviewService::new(db.clone());
        let initial = service
            .enqueue_cards_for_session(&["card-tombstone".to_string()], "session-owner", None)
            .expect("live card enqueues before tombstone");
        assert_eq!(initial.enqueued, 1);
        let state_id = initial.states[0].id.clone();
        assert_eq!(service.get_due(None).expect("load live due cards").len(), 1);
        assert_eq!(service.get_stats().expect("load live stats").total, 1);

        let tombstone = "2026-07-14T01:00:00Z";
        {
            let conn = db.get_conn_safe().expect("open mistakes connection");
            conn.execute(
                "UPDATE anki_cards
                 SET deleted_at = ?1, card_order_in_task = 99
                 WHERE id = 'card-tombstone'",
                params![tombstone],
            )
            .expect("soft delete card fixture");
        }

        assert_eq!(
            db.get_cards_for_task("task-card-tombstone")
                .expect("load task cards")
                .into_iter()
                .map(|card| card.id)
                .collect::<Vec<_>>(),
            vec!["card-still-live"]
        );
        assert_eq!(
            db.get_cards_for_document("doc-card-tombstone")
                .expect("load document cards")
                .into_iter()
                .map(|card| card.id)
                .collect::<Vec<_>>(),
            vec!["card-still-live"]
        );
        assert_eq!(
            db.get_cards_for_document_for_session("doc-card-tombstone", "session-owner")
                .expect("load owned document snapshot")
                .expect("live task remains owned")
                .into_iter()
                .map(|card| card.id)
                .collect::<Vec<_>>(),
            vec!["card-still-live"]
        );
        assert_eq!(
            db.get_cards_by_ids(&["card-tombstone".to_string(), "card-still-live".to_string()])
                .expect("load requested live cards")
                .into_iter()
                .map(|card| card.id)
                .collect::<Vec<_>>(),
            vec!["card-still-live"]
        );
        assert!(db
            .get_anki_card_with_document("card-tombstone")
            .expect("load tombstoned card")
            .is_none());
        assert!(db
            .get_anki_card_for_session("card-tombstone", "session-owner")
            .expect("load owned tombstoned card")
            .is_none());

        tombstoned_card.front = "must not overwrite tombstone".to_string();
        assert!(matches!(
            db.update_anki_card_if_version_for_session(
                &tombstoned_card,
                &expected_version,
                "session-owner",
            )
            .expect("CAS returns a not-found result"),
            crate::database::AnkiCardVersionUpdate::NotFound
        ));
        assert!(matches!(
            db.delete_anki_card_for_session(
                "card-tombstone",
                &expected_version,
                None,
                "session-owner",
            )
            .expect("delete rejects tombstone"),
            crate::database::AnkiCardVersionDelete::NotFound
        ));

        let enqueue_error = service
            .enqueue_cards_for_session(&["card-tombstone".to_string()], "session-owner", None)
            .expect_err("explicit tombstoned card cannot enqueue");
        assert_eq!(
            enqueue_error.message,
            "blocks.ankiCards.errors.statusNotFound"
        );
        assert!(service
            .get_due(None)
            .expect("load due after tombstone")
            .is_empty());
        assert_eq!(
            service
                .get_stats()
                .expect("load stats after tombstone")
                .total,
            0
        );
        assert!(service
            .rate(&state_id, 3, None)
            .expect_err("tombstoned card state cannot be rated")
            .message
            .contains("fsrs card state not found"));

        let added_at = Utc::now().to_rfc3339();
        let added = crate::models::AnkiCard {
            id: "card-added-after-tombstone".to_string(),
            task_id: String::new(),
            front: "new live front".to_string(),
            back: "new live back".to_string(),
            text: None,
            tags: Vec::new(),
            images: Vec::new(),
            is_error_card: false,
            error_content: None,
            created_at: added_at.clone(),
            updated_at: added_at,
            extra_fields: HashMap::new(),
            template_id: None,
        };
        let inserted = db
            .insert_anki_cards_for_document("doc-card-tombstone", "session-owner", vec![added])
            .expect("live document remains writable");
        assert_eq!(inserted.len(), 1);
        let (added_order, tombstone_count, state_count): (i64, i64, i64) = {
            let conn = db.get_conn_safe().expect("open mistakes connection");
            (
                conn.query_row(
                    "SELECT card_order_in_task FROM anki_cards WHERE id = ?1",
                    params!["card-added-after-tombstone"],
                    |row| row.get(0),
                )
                .expect("load appended card order"),
                conn.query_row(
                    "SELECT COUNT(*) FROM anki_cards WHERE id = ?1 AND deleted_at = ?2",
                    params!["card-tombstone", tombstone],
                    |row| row.get(0),
                )
                .expect("tombstone remains stored"),
                conn.query_row(
                    "SELECT COUNT(*) FROM fsrs_card_states WHERE id = ?1",
                    params![state_id],
                    |row| row.get(0),
                )
                .expect("tombstoned card state remains stored"),
            )
        };
        assert_eq!(added_order, 1, "append order ignores tombstoned cards");
        assert_eq!(tombstone_count, 1);
        assert_eq!(state_count, 1);
    }

    #[test]
    fn soft_deleted_document_task_is_hidden_and_cannot_be_recovered_or_mutated() {
        let (_temp_dir, db) = setup_migrated_fsrs_db();
        insert_task_and_card(
            &db,
            "doc-task-tombstone",
            "task-tombstone",
            "card-live-child",
        );
        set_task_owner(&db, "task-tombstone", "session-owner");
        let (mut child_card, _) = db
            .get_anki_card_for_session("card-live-child", "session-owner")
            .expect("load live child before parent tombstone")
            .expect("live child exists");
        let child_version = child_card.updated_at.clone();
        let service = FsrsReviewService::new(db.clone());
        let initial = service
            .enqueue_cards_for_session(&["card-live-child".to_string()], "session-owner", None)
            .expect("live parent task permits enqueue");
        assert_eq!(initial.enqueued, 1);
        let state_id = initial.states[0].id.clone();
        assert_eq!(service.get_due(None).expect("load live due cards").len(), 1);
        assert_eq!(service.get_stats().expect("load live stats").total, 1);
        service
            .rate(&state_id, 3, Some(25))
            .expect("live state remains writable");
        assert_eq!(
            service
                .get_stats()
                .expect("load live stats after review")
                .reviews_today,
            1
        );
        let (live_library, live_total) = db
            .list_anki_library_cards(None, None, None, 1, 20)
            .expect("load live library");
        assert_eq!(live_total, 1);
        assert_eq!(live_library[0].card.id, "card-live-child");

        let tombstone = "2026-07-14T02:00:00Z";
        let original_updated_at = "2000-01-01T00:00:00Z";
        {
            let conn = db.get_conn_safe().expect("open mistakes connection");
            conn.execute(
                "UPDATE document_tasks
                 SET status = 'Processing', updated_at = ?1, deleted_at = ?2
                 WHERE id = 'task-tombstone'",
                params![original_updated_at, tombstone],
            )
            .expect("soft delete task fixture");
        }

        assert!(db.get_document_task("task-tombstone").is_err());
        assert!(db
            .get_tasks_for_document("doc-task-tombstone")
            .expect("list live document tasks")
            .is_empty());
        assert!(db
            .get_recent_document_tasks(20)
            .expect("load recent live tasks")
            .is_empty());
        assert!(db
            .get_recent_anki_cards(20)
            .expect("load recent cards with live parents")
            .is_empty());

        let status_error = db
            .update_document_task_status(
                "task-tombstone",
                crate::models::TaskStatus::Failed,
                Some("must not update".to_string()),
            )
            .expect_err("status update rejects tombstone");
        assert!(status_error
            .to_string()
            .contains("document_task_not_found_or_deleted"));
        assert_eq!(
            db.recover_stuck_document_tasks_older_than_minutes(0)
                .expect("recovery ignores tombstone"),
            0
        );
        let (raw_status, raw_updated_at, raw_deleted_at): (String, String, Option<String>) = {
            let conn = db.get_conn_safe().expect("open mistakes connection");
            conn.query_row(
                "SELECT status, updated_at, deleted_at FROM document_tasks WHERE id = ?1",
                params!["task-tombstone"],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("load raw task tombstone")
        };
        assert_eq!(raw_status, "Processing");
        assert_eq!(raw_updated_at, original_updated_at);
        assert_eq!(raw_deleted_at.as_deref(), Some(tombstone));

        assert_eq!(
            db.get_document_session_source("doc-task-tombstone")
                .expect("load live session source"),
            None
        );
        assert!(!db
            .is_document_owned_by_session("doc-task-tombstone", "session-owner")
            .expect("export ownership check rejects tombstoned task"));
        assert!(db
            .get_cards_for_document("doc-task-tombstone")
            .expect("load document cards")
            .is_empty());
        assert!(db
            .get_cards_for_document_for_session("doc-task-tombstone", "session-owner")
            .expect("load owned document cards")
            .is_none());
        assert!(db
            .get_cards_for_task("task-tombstone")
            .expect("load cards for tombstoned task")
            .is_empty());
        assert!(db
            .get_cards_by_ids(&["card-live-child".to_string()])
            .expect("load child of tombstoned task")
            .is_empty());
        assert!(db
            .get_anki_card_with_document("card-live-child")
            .expect("load child card")
            .is_none());
        assert!(db
            .get_anki_card_for_session("card-live-child", "session-owner")
            .expect("load owned child card")
            .is_none());
        child_card.front = "must not update child of tombstoned task".to_string();
        assert!(matches!(
            db.update_anki_card_if_version_for_session(
                &child_card,
                &child_version,
                "session-owner",
            )
            .expect("CAS treats tombstoned parent as not found"),
            crate::database::AnkiCardVersionUpdate::NotFound
        ));
        assert!(matches!(
            db.delete_anki_card_for_session(
                "card-live-child",
                &child_version,
                None,
                "session-owner",
            )
            .expect("delete rejects child of tombstoned task"),
            crate::database::AnkiCardVersionDelete::NotFound
        ));

        let added_at = Utc::now().to_rfc3339();
        let rejected = crate::models::AnkiCard {
            id: "card-must-not-add".to_string(),
            task_id: String::new(),
            front: "must not add".to_string(),
            back: "must not add".to_string(),
            text: None,
            tags: Vec::new(),
            images: Vec::new(),
            is_error_card: false,
            error_content: None,
            created_at: added_at.clone(),
            updated_at: added_at,
            extra_fields: HashMap::new(),
            template_id: None,
        };
        assert!(db
            .insert_anki_cards_for_document("doc-task-tombstone", "session-owner", vec![rejected],)
            .expect_err("add rejects tombstoned document")
            .to_string()
            .contains("document_ownership_mismatch"));

        let explicit_error = service
            .enqueue_cards_for_session(&["card-live-child".to_string()], "session-owner", None)
            .expect_err("explicit child of tombstoned task cannot enqueue");
        assert_eq!(
            explicit_error.message,
            "blocks.ankiCards.errors.statusNotFound"
        );
        let document_error = service
            .enqueue_cards_for_session(&[], "session-owner", Some("doc-task-tombstone"))
            .expect_err("tombstoned document selector cannot enqueue");
        assert_eq!(
            document_error.message,
            "blocks.ankiCards.errors.statusNotFound"
        );
        assert!(service
            .get_due(None)
            .expect("load due after task tombstone")
            .is_empty());
        let stats = service
            .get_stats()
            .expect("load stats after task tombstone");
        assert_eq!(stats.total, 0);
        assert_eq!(stats.due, 0);
        assert_eq!(stats.reviews_today, 0);
        assert!(service
            .suspend_card(&state_id)
            .expect_err("task tombstone hides state from writes")
            .message
            .contains("fsrs card state not found"));
        let (library, total) = db
            .list_anki_library_cards(None, None, None, 1, 20)
            .expect("load library after task tombstone");
        assert_eq!(total, 0);
        assert!(library.is_empty());
        let raw_added: i64 = {
            let conn = db.get_conn_safe().expect("open mistakes connection");
            conn.query_row(
                "SELECT COUNT(*) FROM anki_cards WHERE id = 'card-must-not-add'",
                [],
                |row| row.get(0),
            )
            .expect("verify rejected add")
        };
        assert_eq!(raw_added, 0);
    }

    #[test]
    fn document_selector_rechecks_all_task_owners_before_writing() {
        let (_temp_dir, db) = setup_migrated_fsrs_db();
        insert_task_and_card(&db, "doc-race", "task-race-owner", "card-race-owner");
        set_task_owner(&db, "task-race-owner", "session-owner");

        // Simulate a selector resolved earlier, followed by an ownership change
        // before enqueue reaches its final write transaction.
        let previously_resolved_ids = vec!["card-race-owner".to_string()];
        insert_task_and_card(&db, "doc-race", "task-race-foreign", "card-race-foreign");
        set_task_owner(&db, "task-race-foreign", "session-foreign");
        let service = FsrsReviewService::new(db.clone());

        let error = service
            .enqueue_cards_for_session(&previously_resolved_ids, "session-owner", Some("doc-race"))
            .expect_err("mixed document must fail final ownership check");
        assert_eq!(error.message, "blocks.ankiCards.errors.statusNotFound");
        assert_eq!(service.get_stats().expect("load stats").total, 0);
    }

    #[test]
    fn stats_report_every_fsrs_bucket_and_reviews_today() {
        let (_temp_dir, db) = setup_migrated_fsrs_db();
        let card_ids: Vec<String> = (0..5).map(|index| format!("card-stats-{index}")).collect();
        for (index, card_id) in card_ids.iter().enumerate() {
            insert_task_and_card(
                &db,
                &format!("doc-stats-{index}"),
                &format!("task-stats-{index}"),
                card_id,
            );
        }
        let service = FsrsReviewService::new(db.clone());
        let enqueue = service
            .enqueue_cards(&card_ids)
            .expect("enqueue stats fixtures");
        service
            .rate(&enqueue.states[0].id, 3, Some(50))
            .expect("create today's review log");

        let now_ms = Utc::now().timestamp_millis();
        let conn = db.get_conn_safe().expect("open mistakes connection");
        for (index, (state, suspended, due_ms)) in [
            (FsrsState::New.as_i32(), 0, now_ms - 1),
            (FsrsState::Learning.as_i32(), 0, now_ms + MS_PER_DAY),
            (FsrsState::Review.as_i32(), 0, now_ms + MS_PER_DAY),
            (FsrsState::Relearning.as_i32(), 0, now_ms + MS_PER_DAY),
            (FsrsState::Review.as_i32(), 1, now_ms - 1),
        ]
        .into_iter()
        .enumerate()
        {
            conn.execute(
                "UPDATE fsrs_card_states
                 SET state = ?1, suspended = ?2, due_ms = ?3
                 WHERE anki_card_id = ?4",
                params![state, suspended, due_ms, &card_ids[index]],
            )
            .expect("set stats bucket");
        }
        drop(conn);

        let stats = service.get_stats().expect("load complete stats");
        assert_eq!(stats.total, 5);
        assert_eq!(stats.due, 1);
        assert_eq!(stats.new_count, 1);
        assert_eq!(stats.learning, 1);
        assert_eq!(stats.review, 1);
        assert_eq!(stats.relearning, 1);
        assert_eq!(stats.suspended, 1);
        assert_eq!(stats.reviews_today, 1);
    }

    fn assert_same_scheduling_state(actual: &FsrsCardState, expected: &FsrsCardState) {
        assert_eq!(actual.id, expected.id);
        assert_eq!(actual.anki_card_id, expected.anki_card_id);
        assert_eq!(actual.deck_id, expected.deck_id);
        assert_eq!(actual.state, expected.state);
        assert_eq!(actual.stability, expected.stability);
        assert_eq!(actual.difficulty, expected.difficulty);
        assert_eq!(actual.elapsed_days, expected.elapsed_days);
        assert_eq!(actual.scheduled_days, expected.scheduled_days);
        assert_eq!(actual.reps, expected.reps);
        assert_eq!(actual.lapses, expected.lapses);
        assert_eq!(actual.due_ms, expected.due_ms);
        assert_eq!(actual.last_review_ms, expected.last_review_ms);
        assert_eq!(actual.suspended, expected.suspended);
        assert_eq!(actual.fsrs_params_version, expected.fsrs_params_version);
        assert_eq!(actual.desired_retention, expected.desired_retention);
        assert_eq!(actual.created_at, expected.created_at);
    }

    fn undo_fingerprint(db: &Database, state_id: &str, log_id: &str) -> (Value, Value) {
        let conn = db.get_conn_safe().expect("open mistakes connection");
        let state = conn
            .query_row(
                "SELECT deck_id, state, stability, difficulty, elapsed_days, scheduled_days,
                        reps, lapses, due_ms, last_review_ms, suspended, fsrs_params_version,
                        desired_retention, updated_at, local_version, deleted_at
                 FROM fsrs_card_states WHERE id = ?1",
                params![state_id],
                |row| {
                    Ok(json!({
                        "deckId": row.get::<_, Option<String>>(0)?,
                        "state": row.get::<_, i32>(1)?,
                        "stability": row.get::<_, Option<f64>>(2)?,
                        "difficulty": row.get::<_, Option<f64>>(3)?,
                        "elapsedDays": row.get::<_, f64>(4)?,
                        "scheduledDays": row.get::<_, f64>(5)?,
                        "reps": row.get::<_, i32>(6)?,
                        "lapses": row.get::<_, i32>(7)?,
                        "dueMs": row.get::<_, i64>(8)?,
                        "lastReviewMs": row.get::<_, Option<i64>>(9)?,
                        "suspended": row.get::<_, i32>(10)?,
                        "params": row.get::<_, String>(11)?,
                        "retention": row.get::<_, Option<f64>>(12)?,
                        "updatedAt": row.get::<_, String>(13)?,
                        "localVersion": row.get::<_, Option<i64>>(14)?,
                        "deletedAt": row.get::<_, Option<String>>(15)?,
                    }))
                },
            )
            .expect("load state fingerprint");
        let log = conn
            .query_row(
                "SELECT card_state_id, anki_card_id, review_ms, state_before_json,
                        updated_at, local_version, deleted_at
                 FROM fsrs_review_logs WHERE id = ?1",
                params![log_id],
                |row| {
                    Ok(json!({
                        "cardStateId": row.get::<_, String>(0)?,
                        "ankiCardId": row.get::<_, String>(1)?,
                        "reviewMs": row.get::<_, i64>(2)?,
                        "snapshot": row.get::<_, Option<String>>(3)?,
                        "updatedAt": row.get::<_, Option<String>>(4)?,
                        "localVersion": row.get::<_, Option<i64>>(5)?,
                        "deletedAt": row.get::<_, Option<String>>(6)?,
                    }))
                },
            )
            .expect("load log fingerprint");
        (state, log)
    }

    #[test]
    fn undo_snapshot_migration_is_registered_and_idempotent() {
        let (_temp_dir, db) = setup_migrated_fsrs_db();
        let conn = db.get_conn_safe().expect("open mistakes connection");
        let columns: Vec<String> = conn
            .prepare("PRAGMA table_info(fsrs_review_logs)")
            .expect("prepare table info")
            .query_map([], |row| row.get(1))
            .expect("query table info")
            .collect::<rusqlite::Result<_>>()
            .expect("collect columns");
        assert!(columns.iter().any(|column| column == "state_before_json"));
        let index_exists: bool = conn
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM sqlite_master
                    WHERE type = 'index' AND name = 'idx_fsrs_logs_state_active'
                 )",
                [],
                |row| row.get(0),
            )
            .expect("query undo index");
        assert!(index_exists);
    }

    #[test]
    fn rate_captures_complete_snapshot_and_undo_restores_every_field() {
        let (_temp_dir, db) = setup_migrated_fsrs_db();
        insert_task_and_card(&db, "doc-undo", "task-undo", "card-undo");
        let service = FsrsReviewService::new(db.clone());
        let enqueue = service
            .enqueue_cards(&["card-undo".to_string()])
            .expect("enqueue undo fixture");
        let state_id = enqueue.states[0].id.clone();
        {
            let conn = db.get_conn_safe().expect("open mistakes connection");
            conn.execute(
                "UPDATE fsrs_card_states SET
                    deck_id = 'deck_default', state = 2, stability = 8.25,
                    difficulty = 4.75, elapsed_days = 6.0, scheduled_days = 7.0,
                    reps = 9, lapses = 2, due_ms = 1700000000000,
                    last_review_ms = 1699395200000, suspended = 0,
                    fsrs_params_version = 'legacy-fixture', desired_retention = 0.87,
                    updated_at = '2020-01-01T00:00:00Z', local_version = 7
                 WHERE id = ?1",
                params![state_id],
            )
            .expect("seed nontrivial scheduling state");
        }
        let before = {
            let conn = db.get_conn_safe().expect("open mistakes connection");
            FsrsReviewService::load_state_by_id(&conn, &state_id)
                .expect("load state")
                .expect("state exists")
        };
        assert_eq!(
            service
                .get_stats()
                .expect("stats before rate")
                .reviews_today,
            0
        );

        let rated = service
            .rate(&state_id, FsrsRating::Again.as_u8(), Some(321))
            .expect("rate fixture");
        let snapshot_json: String = db
            .get_conn_safe()
            .expect("open mistakes connection")
            .query_row(
                "SELECT state_before_json FROM fsrs_review_logs WHERE id = ?1",
                params![rated.log_id],
                |row| row.get(0),
            )
            .expect("load persisted snapshot");
        let snapshot: FsrsStateBeforeSnapshot =
            serde_json::from_str(&snapshot_json).expect("parse complete snapshot");
        assert_eq!(snapshot, FsrsStateBeforeSnapshot::from_state(&before));
        assert_eq!(
            service.get_stats().expect("stats after rate").reviews_today,
            1
        );

        let undone = service
            .undo_last_review(&rated.log_id, &state_id)
            .expect("undo latest rating");
        assert!(undone.changed);
        assert_eq!(undone.undone_log_id, rated.log_id);
        assert_same_scheduling_state(&undone.state, &before);
        assert_ne!(undone.state.updated_at, before.updated_at);
        assert_eq!(
            service.get_stats().expect("stats after undo").reviews_today,
            0
        );

        let conn = db.get_conn_safe().expect("open mistakes connection");
        let state_version: i64 = conn
            .query_row(
                "SELECT local_version FROM fsrs_card_states WHERE id = ?1",
                params![state_id],
                |row| row.get(0),
            )
            .expect("load state version");
        assert_eq!(state_version, 9, "rate and undo each publish a new version");
        let (deleted_at, updated_at, log_version): (Option<String>, Option<String>, i64) = conn
            .query_row(
                "SELECT deleted_at, updated_at, local_version
                 FROM fsrs_review_logs WHERE id = ?1",
                params![rated.log_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("load soft-deleted log");
        assert!(deleted_at.is_some());
        assert_eq!(updated_at, deleted_at);
        assert_eq!(log_version, 1);
    }

    #[test]
    fn consecutive_ratings_only_allow_the_latest_log_to_be_undone() {
        let (_temp_dir, db) = setup_migrated_fsrs_db();
        insert_task_and_card(&db, "doc-chain", "task-chain", "card-chain");
        let service = FsrsReviewService::new(db.clone());
        let state_id = service
            .enqueue_cards(&["card-chain".to_string()])
            .expect("enqueue chain fixture")
            .states[0]
            .id
            .clone();
        let first = service.rate(&state_id, 3, None).expect("first rating");
        let second = service.rate(&state_id, 2, None).expect("second rating");

        let before_stale_attempt = undo_fingerprint(&db, &state_id, &first.log_id);
        let error = service
            .undo_last_review(&first.log_id, &state_id)
            .expect_err("older active log must be stale");
        assert!(error.message.contains("stale"));
        assert_eq!(
            undo_fingerprint(&db, &state_id, &first.log_id),
            before_stale_attempt
        );

        let undone = service
            .undo_last_review(&second.log_id, &state_id)
            .expect("latest rating can be undone");
        assert_same_scheduling_state(&undone.state, &first.card_state);
        let conn = db.get_conn_safe().expect("open mistakes connection");
        let active_logs: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM fsrs_review_logs
                 WHERE card_state_id = ?1 AND deleted_at IS NULL",
                params![state_id],
                |row| row.get(0),
            )
            .expect("count active logs");
        assert_eq!(active_logs, 1);
    }

    #[test]
    fn undo_rejects_a_post_rating_suspension_without_overwriting_it() {
        let (_temp_dir, db) = setup_migrated_fsrs_db();
        insert_task_and_card(
            &db,
            "doc-undo-suspended",
            "task-undo-suspended",
            "card-undo-suspended",
        );
        let service = FsrsReviewService::new(db.clone());
        let state_id = service
            .enqueue_cards(&["card-undo-suspended".to_string()])
            .expect("enqueue suspension race fixture")
            .states[0]
            .id
            .clone();
        let rated = service
            .rate(&state_id, 3, None)
            .expect("rate before suspension");
        service
            .suspend_card(&state_id)
            .expect("suspend after rating");

        let before = undo_fingerprint(&db, &state_id, &rated.log_id);
        let error = service
            .undo_last_review(&rated.log_id, &state_id)
            .expect_err("later state mutation invalidates undo token");
        assert!(error.message.contains("stale"));
        assert_eq!(undo_fingerprint(&db, &state_id, &rated.log_id), before);
        assert!(service
            .get_due(None)
            .expect("load due after rejected undo")
            .is_empty());
    }

    #[test]
    fn undo_rejects_wrong_null_damaged_and_state_stale_inputs_without_writes() {
        let (_temp_dir, db) = setup_migrated_fsrs_db();
        insert_task_and_card(&db, "doc-reject-a", "task-reject-a", "card-reject-a");
        insert_task_and_card(&db, "doc-reject-b", "task-reject-b", "card-reject-b");
        let service = FsrsReviewService::new(db.clone());
        let states = service
            .enqueue_cards(&["card-reject-a".to_string(), "card-reject-b".to_string()])
            .expect("enqueue rejection fixtures")
            .states;
        let state_a = states
            .iter()
            .find(|state| state.anki_card_id == "card-reject-a")
            .expect("state a")
            .id
            .clone();
        let state_b = states
            .iter()
            .find(|state| state.anki_card_id == "card-reject-b")
            .expect("state b")
            .id
            .clone();
        let rated = service
            .rate(&state_a, 3, None)
            .expect("rate rejection fixture");

        let baseline = undo_fingerprint(&db, &state_a, &rated.log_id);
        service
            .undo_last_review(&rated.log_id, &state_b)
            .expect_err("wrong state binding is rejected");
        assert_eq!(undo_fingerprint(&db, &state_a, &rated.log_id), baseline);
        service
            .undo_last_review("missing-log", &state_a)
            .expect_err("unknown log is rejected");
        assert_eq!(undo_fingerprint(&db, &state_a, &rated.log_id), baseline);

        for damaged_snapshot in [None, Some("{"), Some("{}")] {
            {
                let conn = db.get_conn_safe().expect("open mistakes connection");
                conn.execute(
                    "UPDATE fsrs_review_logs SET state_before_json = ?1 WHERE id = ?2",
                    params![damaged_snapshot, rated.log_id],
                )
                .expect("set damaged snapshot fixture");
            }
            let before = undo_fingerprint(&db, &state_a, &rated.log_id);
            service
                .undo_last_review(&rated.log_id, &state_a)
                .expect_err("legacy or damaged snapshot is rejected");
            assert_eq!(undo_fingerprint(&db, &state_a, &rated.log_id), before);
        }

        {
            let valid_snapshot = serde_json::to_string(&FsrsStateBeforeSnapshot::from_state(
                states
                    .iter()
                    .find(|state| state.id == state_a)
                    .expect("original state a"),
            ))
            .expect("serialize valid fixture snapshot");
            let conn = db.get_conn_safe().expect("open mistakes connection");
            conn.execute(
                "UPDATE fsrs_review_logs SET state_before_json = ?1 WHERE id = ?2",
                params![valid_snapshot, rated.log_id],
            )
            .expect("restore valid snapshot");
            conn.execute(
                "UPDATE fsrs_card_states SET last_review_ms = last_review_ms - 1 WHERE id = ?1",
                params![state_a],
            )
            .expect("make state last_review stale");
        }
        let before = undo_fingerprint(&db, &state_a, &rated.log_id);
        service
            .undo_last_review(&rated.log_id, &state_a)
            .expect_err("state last_review mismatch is rejected");
        assert_eq!(undo_fingerprint(&db, &state_a, &rated.log_id), before);
    }

    #[test]
    fn suspend_and_unsuspend_are_atomic_idempotent_and_control_due_visibility() {
        let (_temp_dir, db) = setup_migrated_fsrs_db();
        insert_task_and_card(&db, "doc-suspend", "task-suspend", "card-suspend");
        let service = FsrsReviewService::new(db.clone());
        let initial = service
            .enqueue_cards(&["card-suspend".to_string()])
            .expect("enqueue suspension fixture")
            .states[0]
            .clone();
        assert_eq!(service.get_due(None).expect("initial due").len(), 1);

        let suspended = service.suspend_card(&initial.id).expect("suspend card");
        assert!(suspended.changed);
        assert!(suspended.state.suspended);
        assert_eq!(suspended.state.due_ms, initial.due_ms);
        assert!(service
            .get_due(None)
            .expect("due while suspended")
            .is_empty());
        assert!(service.rate(&initial.id, 3, None).is_err());
        let suspended_fingerprint = {
            let conn = db.get_conn_safe().expect("open mistakes connection");
            conn.query_row(
                "SELECT updated_at, local_version FROM fsrs_card_states WHERE id = ?1",
                params![initial.id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .expect("load suspended fingerprint")
        };
        let repeated = service.suspend_card(&initial.id).expect("repeat suspend");
        assert!(!repeated.changed);
        let repeated_fingerprint = {
            let conn = db.get_conn_safe().expect("open mistakes connection");
            conn.query_row(
                "SELECT updated_at, local_version FROM fsrs_card_states WHERE id = ?1",
                params![initial.id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .expect("load repeated fingerprint")
        };
        assert_eq!(repeated_fingerprint, suspended_fingerprint);
        let stats = service.get_stats().expect("suspended stats");
        assert_eq!(stats.suspended, 1);
        assert_eq!(stats.due, 0);

        let unsuspended = service.unsuspend_card(&initial.id).expect("unsuspend card");
        assert!(unsuspended.changed);
        assert!(!unsuspended.state.suspended);
        assert_eq!(unsuspended.state.due_ms, initial.due_ms);
        assert_eq!(service.get_due(None).expect("restored due").len(), 1);
        let repeated = service
            .unsuspend_card(&initial.id)
            .expect("repeat unsuspend");
        assert!(!repeated.changed);
        let local_version: i64 = db
            .get_conn_safe()
            .expect("open mistakes connection")
            .query_row(
                "SELECT local_version FROM fsrs_card_states WHERE id = ?1",
                params![initial.id],
                |row| row.get(0),
            )
            .expect("load final version");
        assert_eq!(
            local_version, 2,
            "only real state changes increment version"
        );
    }

    #[test]
    fn agent_review_state_batch_read_distinguishes_unenqueued_and_latest_review() {
        let (_temp_dir, db) = setup_migrated_fsrs_db();
        insert_task_and_card(&db, "doc-agent-read", "task-agent-read", "card-agent-a");
        insert_card_for_task(&db, "doc-agent-read", "task-agent-read", "card-agent-b");
        set_task_owner(&db, "task-agent-read", "session-owner");
        let service = FsrsReviewService::new(db.clone());

        assert!(service
            .get_review_states_for_session(
                &["card-agent-a".to_string(), "card-agent-b".to_string()],
                "session-owner",
            )
            .expect("read owned unenqueued cards")
            .is_empty());
        assert!(matches!(
            service
                .set_suspended_for_session("card-agent-a", "session-owner", 0, true)
                .expect("unenqueued mutation returns an outcome"),
            FsrsAgentReviewMutationOutcome::NotFound
        ));

        let enqueued = service
            .enqueue_cards_for_session(&["card-agent-a".to_string()], "session-owner", None)
            .expect("enqueue owned Agent card");
        let initial = service
            .get_review_states_for_session(
                &[
                    "card-agent-a".to_string(),
                    "card-agent-b".to_string(),
                    "card-agent-a".to_string(),
                ],
                "session-owner",
            )
            .expect("read mixed enrolled and unenrolled cards");
        assert_eq!(initial.len(), 1);
        assert_eq!(initial[0].anki_card_id, "card-agent-a");
        assert_eq!(initial[0].card_state_id, enqueued.states[0].id);
        assert_eq!(initial[0].review_version, 0);
        assert!(initial[0].latest_review.is_none());

        let rated = service
            .rate(
                &initial[0].card_state_id,
                FsrsRating::Good.as_u8(),
                Some(125),
            )
            .expect("rate Agent read fixture");
        let reviewed = service
            .get_review_states_for_session(&["card-agent-a".to_string()], "session-owner")
            .expect("read latest Agent review");
        assert_eq!(reviewed[0].review_version, 1);
        assert_eq!(
            reviewed[0].last_review_ms,
            Some(reviewed[0].latest_review.as_ref().unwrap().review_ms)
        );
        assert_eq!(
            reviewed[0].latest_review,
            Some(FsrsAgentLatestReviewSnapshot {
                log_id: rated.log_id,
                rating: FsrsRating::Good.as_u8(),
                review_ms: reviewed[0].last_review_ms.unwrap(),
                undoable: true,
            })
        );
    }

    #[test]
    fn agent_review_access_hides_mixed_owner_and_tombstoned_cards() {
        let (_temp_dir, db) = setup_migrated_fsrs_db();
        insert_task_and_card(
            &db,
            "doc-agent-guard",
            "task-agent-owner",
            "card-agent-owner",
        );
        insert_task_and_card(
            &db,
            "doc-agent-guard",
            "task-agent-foreign",
            "card-agent-foreign",
        );
        set_task_owner(&db, "task-agent-owner", "session-owner");
        set_task_owner(&db, "task-agent-foreign", "session-foreign");
        let service = FsrsReviewService::new(db.clone());
        service
            .enqueue_cards(&[
                "card-agent-owner".to_string(),
                "card-agent-foreign".to_string(),
            ])
            .expect("enqueue ownership fixtures without a session selector");

        let error = service
            .get_review_states_for_session(&["card-agent-owner".to_string()], "session-owner")
            .expect_err("mixed-owner document must be hidden");
        assert!(matches!(error.error_type, AppErrorType::NotFound));
        assert!(matches!(
            service
                .set_suspended_for_session("card-agent-owner", "session-owner", 0, true)
                .expect("mixed-owner mutation returns an outcome"),
            FsrsAgentReviewMutationOutcome::NotFound
        ));

        set_task_owner(&db, "task-agent-foreign", "session-owner");
        db.get_conn_safe()
            .expect("open mistakes connection")
            .execute(
                "UPDATE anki_cards SET deleted_at = '2026-07-14T00:00:00Z'
                 WHERE id = 'card-agent-owner'",
                [],
            )
            .expect("tombstone Agent card");
        let error = service
            .get_review_states_for_session(&["card-agent-owner".to_string()], "session-owner")
            .expect_err("tombstoned card must be hidden");
        assert!(matches!(error.error_type, AppErrorType::NotFound));
        assert!(matches!(
            service
                .undo_last_review_for_session(
                    "card-agent-owner",
                    "session-owner",
                    0,
                    "missing-log",
                )
                .expect("tombstoned mutation returns an outcome"),
            FsrsAgentReviewMutationOutcome::NotFound
        ));

        insert_task_and_card(
            &db,
            "doc-agent-task-tombstone",
            "task-agent-tombstone",
            "card-agent-task-tombstone",
        );
        set_task_owner(&db, "task-agent-tombstone", "session-owner");
        service
            .enqueue_cards_for_session(
                &["card-agent-task-tombstone".to_string()],
                "session-owner",
                None,
            )
            .expect("enqueue task tombstone fixture");
        db.get_conn_safe()
            .expect("open mistakes connection")
            .execute(
                "UPDATE document_tasks SET deleted_at = '2026-07-14T00:00:00Z'
                 WHERE id = 'task-agent-tombstone'",
                [],
            )
            .expect("tombstone Agent card task");
        let error = service
            .get_review_states_for_session(
                &["card-agent-task-tombstone".to_string()],
                "session-owner",
            )
            .expect_err("card under a tombstoned task must be hidden");
        assert!(matches!(error.error_type, AppErrorType::NotFound));
        assert!(matches!(
            service
                .set_suspended_for_session("card-agent-task-tombstone", "session-owner", 0, true,)
                .expect("task tombstone mutation returns an outcome"),
            FsrsAgentReviewMutationOutcome::NotFound
        ));
    }

    #[test]
    fn agent_suspension_is_versioned_idempotent_and_stale_safe() {
        let (_temp_dir, db) = setup_migrated_fsrs_db();
        insert_task_and_card(
            &db,
            "doc-agent-suspend",
            "task-agent-suspend",
            "card-agent-suspend",
        );
        set_task_owner(&db, "task-agent-suspend", "session-owner");
        let service = FsrsReviewService::new(db.clone());
        service
            .enqueue_cards_for_session(&["card-agent-suspend".to_string()], "session-owner", None)
            .expect("enqueue Agent suspension fixture");

        let unchanged = expect_agent_updated(
            service
                .set_suspended_for_session("card-agent-suspend", "session-owner", 0, false)
                .expect("idempotent initial unsuspend"),
            false,
        );
        assert_eq!(unchanged.review_version, 0);
        assert!(!unchanged.suspended);

        let suspended = expect_agent_updated(
            service
                .set_suspended_for_session("card-agent-suspend", "session-owner", 0, true)
                .expect("suspend Agent card"),
            true,
        );
        assert!(suspended.suspended);
        assert_eq!(suspended.review_version, 1);

        let repeated = expect_agent_updated(
            service
                .set_suspended_for_session("card-agent-suspend", "session-owner", 1, true)
                .expect("repeat Agent suspension"),
            false,
        );
        assert_eq!(repeated, suspended);

        let resumed = expect_agent_updated(
            service
                .set_suspended_for_session("card-agent-suspend", "session-owner", 1, false)
                .expect("resume Agent card"),
            true,
        );
        assert!(!resumed.suspended);
        assert_eq!(resumed.review_version, 2);

        let stale = service
            .set_suspended_for_session("card-agent-suspend", "session-owner", 1, true)
            .expect("stale Agent suspension returns an outcome");
        match stale {
            FsrsAgentReviewMutationOutcome::Conflict { current } => {
                assert_eq!(current, resumed);
            }
            other => panic!("expected stale suspension conflict, got {other:?}"),
        }
    }

    #[test]
    fn agent_undo_restores_snapshot_and_publishes_a_new_version() {
        let (_temp_dir, db) = setup_migrated_fsrs_db();
        insert_task_and_card(&db, "doc-agent-undo", "task-agent-undo", "card-agent-undo");
        set_task_owner(&db, "task-agent-undo", "session-owner");
        let service = FsrsReviewService::new(db.clone());
        let initial_state = service
            .enqueue_cards_for_session(&["card-agent-undo".to_string()], "session-owner", None)
            .expect("enqueue Agent undo fixture")
            .states[0]
            .clone();
        let rated = service
            .rate(&initial_state.id, FsrsRating::Easy.as_u8(), Some(500))
            .expect("rate Agent undo fixture");
        let current = service
            .get_review_states_for_session(&["card-agent-undo".to_string()], "session-owner")
            .expect("read Agent undo token")
            .remove(0);
        assert_eq!(current.review_version, 1);
        assert!(current.latest_review.as_ref().unwrap().undoable);

        let restored = expect_agent_updated(
            service
                .undo_last_review_for_session(
                    "card-agent-undo",
                    "session-owner",
                    current.review_version,
                    &rated.log_id,
                )
                .expect("undo Agent review"),
            true,
        );
        assert_eq!(restored.review_version, 2);
        assert_eq!(restored.state, initial_state.state);
        assert_eq!(restored.due_ms, initial_state.due_ms);
        assert_eq!(restored.last_review_ms, initial_state.last_review_ms);
        assert!(restored.latest_review.is_none());

        let conn = db.get_conn_safe().expect("open mistakes connection");
        let deleted_at: Option<String> = conn
            .query_row(
                "SELECT deleted_at FROM fsrs_review_logs WHERE id = ?1",
                params![rated.log_id],
                |row| row.get(0),
            )
            .expect("load undone Agent log");
        assert!(deleted_at.is_some());
        let actual = FsrsReviewService::load_state_by_id(&conn, &initial_state.id)
            .expect("load restored Agent state")
            .expect("restored Agent state exists");
        assert_same_scheduling_state(&actual, &initial_state);
    }

    #[test]
    fn agent_undo_conflicts_on_stale_tokens_and_blocks_invalid_snapshots() {
        let (_temp_dir, db) = setup_migrated_fsrs_db();
        insert_task_and_card(
            &db,
            "doc-agent-stale",
            "task-agent-stale",
            "card-agent-stale",
        );
        set_task_owner(&db, "task-agent-stale", "session-owner");
        let service = FsrsReviewService::new(db.clone());
        let state_id = service
            .enqueue_cards_for_session(&["card-agent-stale".to_string()], "session-owner", None)
            .expect("enqueue stale Agent fixture")
            .states[0]
            .id
            .clone();
        let first = service
            .rate(&state_id, 3, None)
            .expect("first Agent rating");
        let second = service
            .rate(&state_id, 2, None)
            .expect("second Agent rating");
        let current = service
            .get_review_states_for_session(&["card-agent-stale".to_string()], "session-owner")
            .expect("read current Agent review state")
            .remove(0);
        assert_eq!(current.review_version, 2);

        assert!(matches!(
            service
                .undo_last_review_for_session(
                    "card-agent-stale",
                    "session-owner",
                    1,
                    &second.log_id,
                )
                .expect("stale version returns an outcome"),
            FsrsAgentReviewMutationOutcome::Conflict { .. }
        ));
        assert!(matches!(
            service
                .undo_last_review_for_session(
                    "card-agent-stale",
                    "session-owner",
                    2,
                    &first.log_id,
                )
                .expect("stale log returns an outcome"),
            FsrsAgentReviewMutationOutcome::Conflict { .. }
        ));

        let before = undo_fingerprint(&db, &state_id, &second.log_id);
        {
            let conn = db.get_conn_safe().expect("open mistakes connection");
            let snapshot_json: String = conn
                .query_row(
                    "SELECT state_before_json FROM fsrs_review_logs WHERE id = ?1",
                    params![second.log_id],
                    |row| row.get(0),
                )
                .expect("load valid Agent undo snapshot");
            let mut snapshot: Value =
                serde_json::from_str(&snapshot_json).expect("parse valid Agent undo snapshot");
            snapshot["snapshotVersion"] = json!(99);
            conn.execute(
                "UPDATE fsrs_review_logs SET state_before_json = ?1 WHERE id = ?2",
                params![snapshot.to_string(), second.log_id],
            )
            .expect("invalidate Agent undo snapshot");
        }
        let damaged_before = undo_fingerprint(&db, &state_id, &second.log_id);
        let blocked = service
            .undo_last_review_for_session("card-agent-stale", "session-owner", 2, &second.log_id)
            .expect("damaged snapshot returns an outcome");
        match blocked {
            FsrsAgentReviewMutationOutcome::Blocked { reason, current } => {
                assert_eq!(reason, "undo_snapshot_invalid");
                assert_eq!(current.review_version, 2);
                assert!(!current.latest_review.unwrap().undoable);
            }
            other => panic!("expected invalid snapshot block, got {other:?}"),
        }
        assert_eq!(
            undo_fingerprint(&db, &state_id, &second.log_id),
            damaged_before
        );
        assert_ne!(
            damaged_before, before,
            "fixture must actually damage the log"
        );
    }

    #[test]
    fn agent_review_mutations_block_diagnostic_cards_without_writes() {
        let (_temp_dir, db) = setup_migrated_fsrs_db();
        insert_task_and_card(
            &db,
            "doc-agent-diagnostic",
            "task-agent-diagnostic",
            "card-agent-diagnostic",
        );
        set_task_owner(&db, "task-agent-diagnostic", "session-owner");
        let service = FsrsReviewService::new(db.clone());
        let state_id = service
            .enqueue_cards_for_session(
                &["card-agent-diagnostic".to_string()],
                "session-owner",
                None,
            )
            .expect("enqueue diagnostic Agent fixture")
            .states[0]
            .id
            .clone();
        let rated = service
            .rate(&state_id, 3, None)
            .expect("rate before card becomes diagnostic");
        db.get_conn_safe()
            .expect("open mistakes connection")
            .execute(
                "UPDATE anki_cards
                 SET is_error_card = 1, error_content = 'late diagnostic'
                 WHERE id = 'card-agent-diagnostic'",
                [],
            )
            .expect("mark Agent card diagnostic");
        let current = service
            .get_review_states_for_session(&["card-agent-diagnostic".to_string()], "session-owner")
            .expect("diagnostic state remains readable")
            .remove(0);
        assert!(!current.latest_review.as_ref().unwrap().undoable);
        let before = undo_fingerprint(&db, &state_id, &rated.log_id);

        for outcome in [
            service
                .set_suspended_for_session(
                    "card-agent-diagnostic",
                    "session-owner",
                    current.review_version,
                    true,
                )
                .expect("diagnostic suspension returns an outcome"),
            service
                .undo_last_review_for_session(
                    "card-agent-diagnostic",
                    "session-owner",
                    current.review_version,
                    &rated.log_id,
                )
                .expect("diagnostic undo returns an outcome"),
        ] {
            match outcome {
                FsrsAgentReviewMutationOutcome::Blocked { reason, current } => {
                    assert_eq!(reason, "diagnostic_card");
                    assert_eq!(current.review_version, 1);
                }
                other => panic!("expected diagnostic block, got {other:?}"),
            }
        }
        assert_eq!(undo_fingerprint(&db, &state_id, &rated.log_id), before);
    }

    #[test]
    fn due_and_enqueue_serialize_complete_template_metadata_with_legacy_defaults() {
        let (_temp_dir, db) = setup_migrated_fsrs_db();
        insert_task_and_card(&db, "doc-meta", "task-meta", "card-meta");
        {
            let conn = db.get_conn_safe().expect("open mistakes connection");
            conn.execute(
                "UPDATE anki_cards SET
                    text = 'Prompt {{c1::answer::hint}}',
                    tags_json = '[\"tag-a\"]',
                    template_id = 'design-redaction',
                    extra_fields_json = '{\"source\":\"book\"}',
                    images_json = '[\"image.png\"]',
                    is_error_card = 0,
                    error_content = NULL
                 WHERE id = 'card-meta'",
                [],
            )
            .expect("seed card metadata");
        }
        let service = FsrsReviewService::new(db.clone());
        let enqueue = service
            .enqueue_cards(&["card-meta".to_string()])
            .expect("enqueue metadata fixture");
        let enqueued = &enqueue.review_cards[0];
        assert_eq!(
            enqueued.text.as_deref(),
            Some("Prompt {{c1::answer::hint}}")
        );
        assert_eq!(enqueued.template_id.as_deref(), Some("design-redaction"));
        assert_eq!(
            enqueued.extra_fields.get("source").map(String::as_str),
            Some("book")
        );
        assert_eq!(enqueued.images, vec!["image.png"]);
        assert!(!enqueued.is_error_card);
        assert!(enqueued.error_content.is_none());

        let due = service.get_due(None).expect("load due metadata");
        assert_eq!(due.len(), 1);
        let due_json = serde_json::to_value(&due[0]).expect("serialize due card");
        assert_eq!(due_json["templateId"], "design-redaction");
        assert_eq!(due_json["extraFields"]["source"], "book");
        assert_eq!(due_json["images"], json!(["image.png"]));
        assert_eq!(due_json["isErrorCard"], false);
        assert!(due_json.get("errorContent").is_none());
        assert!(due_json.get("template_id").is_none());

        let enqueue_json = serde_json::to_value(enqueued).expect("serialize enqueued card");
        assert_eq!(enqueue_json["templateId"], "design-redaction");
        assert_eq!(enqueue_json["extraFields"]["source"], "book");
        assert_eq!(enqueue_json["isErrorCard"], false);

        let mut legacy_due_json = due_json;
        let legacy_due = legacy_due_json.as_object_mut().expect("due object");
        for key in [
            "text",
            "templateId",
            "extraFields",
            "images",
            "isErrorCard",
            "errorContent",
        ] {
            legacy_due.remove(key);
        }
        let legacy_due: FsrsDueCard =
            serde_json::from_value(legacy_due_json).expect("deserialize legacy due card");
        assert!(legacy_due.text.is_none());
        assert!(legacy_due.template_id.is_none());
        assert!(legacy_due.extra_fields.is_empty());
        assert!(legacy_due.images.is_empty());
        assert!(!legacy_due.is_error_card);
        assert!(legacy_due.error_content.is_none());
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

    #[test]
    fn chatanki_versioned_delete_cas_cleans_fsrs_without_cleanup_trigger_and_conflict_preserves_it()
    {
        let (_temp_dir, db) = setup_migrated_fsrs_db();
        db.get_conn_safe()
            .expect("open mistakes connection")
            .execute_batch(
                "DROP TRIGGER trg_fsrs_cleanup_before_anki_card_delete;
                 CREATE TRIGGER require_fsrs_cleanup_before_anki_card_delete
                 BEFORE DELETE ON anki_cards
                 WHEN EXISTS (
                     SELECT 1 FROM fsrs_review_logs WHERE anki_card_id = OLD.id
                 ) OR EXISTS (
                     SELECT 1 FROM fsrs_card_states WHERE anki_card_id = OLD.id
                 )
                 BEGIN
                     SELECT RAISE(ABORT, 'dependent FSRS rows must be deleted first');
                 END;",
            )
            .expect("replace FSRS cleanup trigger with ordering guard");

        insert_task_and_card(
            &db,
            "doc-delete-success",
            "task-delete-success",
            "card-delete-success",
        );
        set_task_owner(&db, "task-delete-success", "session-owner");
        let success_version = db
            .get_anki_card_with_document("card-delete-success")
            .expect("load success card")
            .expect("success card exists")
            .0
            .updated_at;
        enqueue_and_rate(&db, "card-delete-success");

        assert!(matches!(
            db.delete_anki_card_for_session(
                "card-delete-success",
                &success_version,
                Some(1),
                "session-owner",
            )
            .expect("versioned delete succeeds"),
            crate::database::AnkiCardVersionDelete::Deleted
        ));
        let remaining_cards: i64 = db
            .get_conn_safe()
            .expect("open mistakes connection")
            .query_row(
                "SELECT COUNT(*) FROM anki_cards WHERE id = ?1",
                params!["card-delete-success"],
                |row| row.get(0),
            )
            .expect("count deleted card");
        assert_eq!(remaining_cards, 0);
        assert_no_fsrs_rows(&db, &["card-delete-success"]);

        insert_task_and_card(
            &db,
            "doc-delete-conflict",
            "task-delete-conflict",
            "card-delete-conflict",
        );
        set_task_owner(&db, "task-delete-conflict", "session-owner");
        let stale_version = db
            .get_anki_card_with_document("card-delete-conflict")
            .expect("load conflict card")
            .expect("conflict card exists")
            .0
            .updated_at;
        let state_id = enqueue_and_rate(&db, "card-delete-conflict");
        let current_version = "2026-07-14T00:00:00Z";
        db.get_conn_safe()
            .expect("open mistakes connection")
            .execute(
                "UPDATE anki_cards SET updated_at = ?1 WHERE id = ?2",
                params![current_version, "card-delete-conflict"],
            )
            .expect("advance conflict card version");

        let conflict = db
            .delete_anki_card_for_session(
                "card-delete-conflict",
                &stale_version,
                Some(1),
                "session-owner",
            )
            .expect("versioned delete conflict");
        match conflict {
            crate::database::AnkiCardVersionDelete::Conflict(current) => {
                assert_eq!(current.updated_at, current_version);
            }
            other => panic!("expected version conflict, got {:?}", other),
        }
        let conn = db.get_conn_safe().expect("open mistakes connection");
        let remaining_cards: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM anki_cards WHERE id = ?1",
                params!["card-delete-conflict"],
                |row| row.get(0),
            )
            .expect("count conflict card");
        let remaining_states: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM fsrs_card_states
                 WHERE id = ?1 AND anki_card_id = ?2",
                params![&state_id, "card-delete-conflict"],
                |row| row.get(0),
            )
            .expect("count conflict state");
        let remaining_logs: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM fsrs_review_logs
                 WHERE card_state_id = ?1 AND anki_card_id = ?2",
                params![&state_id, "card-delete-conflict"],
                |row| row.get(0),
            )
            .expect("count conflict history");
        assert_eq!(remaining_cards, 1);
        assert_eq!(remaining_states, 1);
        assert_eq!(remaining_logs, 1);
    }

    fn remove_v20260711_history_and_objects(db: &Database) {
        let conn = db.get_conn_safe().expect("open mistakes connection");
        conn.execute_batch(
            "DELETE FROM refinery_schema_history WHERE version >= 20260711;

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
             DROP INDEX IF EXISTS idx_fsrs_review_logs_updated_not_deleted;
             DROP INDEX IF EXISTS idx_fsrs_logs_state_active;",
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
            ("index", "idx_fsrs_logs_state_active"),
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
                "SELECT COUNT(*) FROM refinery_schema_history
                 WHERE version IN (20260711, 20260712)",
                [],
                |row| row.get(0),
            )
            .expect("check restored migration history");
        assert_eq!(history, 2);
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
        assert_eq!(
            report.to_version,
            MISTAKES_MIGRATIONS.latest_version() as u32
        );
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
                "DELETE FROM refinery_schema_history WHERE version >= 20260711",
                [],
            )
            .expect("remove migration history for idempotent replay");
        }
        let repeated = coordinator
            .migrate_single(DatabaseId::Mistakes)
            .expect("repeat recovered migration tail");
        assert_eq!(
            repeated.to_version,
            MISTAKES_MIGRATIONS.latest_version() as u32
        );
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
        assert_eq!(
            report.to_version,
            MISTAKES_MIGRATIONS.latest_version() as u32
        );
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

    #[test]
    fn library_scope_handles_null_and_foreign_sources_while_session_scope_rejects_them() {
        let (_temp_dir, db) = setup_migrated_fsrs_db();
        insert_task_and_card(
            &db,
            "doc-library-null",
            "task-library-null",
            "card-library-null",
        );
        insert_task_and_card(
            &db,
            "doc-library-foreign",
            "task-library-foreign",
            "card-library-foreign",
        );
        set_task_owner(&db, "task-library-foreign", "session-foreign");
        let versions: HashMap<String, String> = {
            let conn = db.get_conn_safe().expect("open mistakes connection");
            let mut stmt = conn
                .prepare(
                    "SELECT id, updated_at FROM anki_cards
                     WHERE id IN ('card-library-null', 'card-library-foreign')",
                )
                .expect("prepare content versions");
            stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .expect("query content versions")
                .collect::<rusqlite::Result<HashMap<_, _>>>()
                .expect("collect content versions")
        };
        let scope = AnkiLibraryScope::agent();
        let service = FsrsReviewService::new(db.clone());
        let outcome = service
            .enqueue_cards_for_library(
                scope,
                &[
                    FsrsLibraryEnqueueCard {
                        card_id: "card-library-null".to_string(),
                        expected_content_version: versions["card-library-null"].clone(),
                    },
                    FsrsLibraryEnqueueCard {
                        card_id: "card-library-foreign".to_string(),
                        expected_content_version: versions["card-library-foreign"].clone(),
                    },
                ],
            )
            .expect("enqueue complete library selection");
        match outcome {
            FsrsLibraryEnqueueOutcome::Enqueued(result) => assert_eq!(result.enqueued, 2),
            other => panic!("expected library enqueue, got {other:?}"),
        }

        let snapshots = service
            .get_review_states_for_library(
                scope,
                &[
                    "card-library-null".to_string(),
                    "card-library-foreign".to_string(),
                ],
            )
            .expect("read cross-session library snapshots");
        assert_eq!(snapshots.len(), 2);
        for card_id in ["card-library-null", "card-library-foreign"] {
            let error = service
                .get_review_states_for_session(&[card_id.to_string()], "session-owner")
                .expect_err("session scope must not widen to library cards");
            assert!(matches!(error.error_type, AppErrorType::NotFound));
        }

        let suspended = expect_agent_updated(
            service
                .set_suspended_for_library(scope, "card-library-foreign", 0, true)
                .expect("suspend foreign-source library card"),
            true,
        );
        assert!(suspended.suspended);
        assert_eq!(suspended.review_version, 1);
        assert!(matches!(
            service
                .set_suspended_for_library(scope, "card-library-foreign", 0, false)
                .expect("stale library suspension returns an outcome"),
            FsrsAgentReviewMutationOutcome::Conflict { .. }
        ));

        let owners: (Option<String>, Option<String>) = db
            .get_conn_safe()
            .expect("open mistakes connection")
            .query_row(
                "SELECT
                    (SELECT source_session_id FROM document_tasks WHERE id = 'task-library-null'),
                    (SELECT source_session_id FROM document_tasks WHERE id = 'task-library-foreign')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("load immutable source owners");
        assert_eq!(owners.0, None);
        assert_eq!(owners.1.as_deref(), Some("session-foreign"));
    }

    #[test]
    fn library_enqueue_content_cas_is_all_or_nothing() {
        let (_temp_dir, db) = setup_migrated_fsrs_db();
        insert_task_and_card(
            &db,
            "doc-library-batch-a",
            "task-library-batch-a",
            "card-library-batch-a",
        );
        insert_task_and_card(
            &db,
            "doc-library-batch-b",
            "task-library-batch-b",
            "card-library-batch-b",
        );
        let current_a: String = db
            .get_conn_safe()
            .expect("open mistakes connection")
            .query_row(
                "SELECT updated_at FROM anki_cards WHERE id = 'card-library-batch-a'",
                [],
                |row| row.get(0),
            )
            .expect("load card A version");
        let scope = AnkiLibraryScope::agent();
        let service = FsrsReviewService::new(db.clone());
        let outcome = service
            .enqueue_cards_for_library(
                scope,
                &[
                    FsrsLibraryEnqueueCard {
                        card_id: "card-library-batch-a".to_string(),
                        expected_content_version: current_a,
                    },
                    FsrsLibraryEnqueueCard {
                        card_id: "card-library-batch-b".to_string(),
                        expected_content_version: "stale-version".to_string(),
                    },
                ],
            )
            .expect("stale batch returns a typed outcome");
        match outcome {
            FsrsLibraryEnqueueOutcome::Conflict { conflicts } => {
                assert_eq!(conflicts.len(), 1);
                assert_eq!(conflicts[0].card_id, "card-library-batch-b");
                assert_eq!(conflicts[0].expected_version, "stale-version");
            }
            other => panic!("expected content version conflict, got {other:?}"),
        }
        let state_count: i64 = db
            .get_conn_safe()
            .expect("open mistakes connection")
            .query_row(
                "SELECT COUNT(*) FROM fsrs_card_states
                 WHERE anki_card_id IN ('card-library-batch-a', 'card-library-batch-b')",
                [],
                |row| row.get(0),
            )
            .expect("count rolled-back batch states");
        assert_eq!(state_count, 0, "no prefix of a stale batch may enqueue");
    }

    #[test]
    fn library_undo_requires_both_current_review_version_and_latest_log() {
        let (_temp_dir, db) = setup_migrated_fsrs_db();
        insert_task_and_card(
            &db,
            "doc-library-undo",
            "task-library-undo",
            "card-library-undo",
        );
        let content_version: String = db
            .get_conn_safe()
            .expect("open mistakes connection")
            .query_row(
                "SELECT updated_at FROM anki_cards WHERE id = 'card-library-undo'",
                [],
                |row| row.get(0),
            )
            .expect("load undo content version");
        let scope = AnkiLibraryScope::agent();
        let service = FsrsReviewService::new(db.clone());
        let state_id = match service
            .enqueue_cards_for_library(
                scope,
                &[FsrsLibraryEnqueueCard {
                    card_id: "card-library-undo".to_string(),
                    expected_content_version: content_version,
                }],
            )
            .expect("enqueue library undo fixture")
        {
            FsrsLibraryEnqueueOutcome::Enqueued(result) => result.states[0].id.clone(),
            other => panic!("expected enqueue, got {other:?}"),
        };
        let first = service
            .rate(&state_id, FsrsRating::Good.as_u8(), Some(100))
            .expect("first rating");
        let second = service
            .rate(&state_id, FsrsRating::Hard.as_u8(), Some(100))
            .expect("second rating");
        let current = service
            .get_review_states_for_library(scope, &["card-library-undo".to_string()])
            .expect("read current undo tokens")
            .remove(0);
        assert_eq!(current.review_version, 2);
        assert_eq!(
            current
                .latest_review
                .as_ref()
                .map(|review| review.log_id.as_str()),
            Some(second.log_id.as_str())
        );

        assert!(matches!(
            service
                .undo_last_review_for_library(scope, "card-library-undo", 1, &second.log_id,)
                .expect("stale version returns a conflict"),
            FsrsAgentReviewMutationOutcome::Conflict { .. }
        ));
        assert!(matches!(
            service
                .undo_last_review_for_library(scope, "card-library-undo", 2, &first.log_id,)
                .expect("non-latest log returns a conflict"),
            FsrsAgentReviewMutationOutcome::Conflict { .. }
        ));
        let restored = expect_agent_updated(
            service
                .undo_last_review_for_library(scope, "card-library-undo", 2, &second.log_id)
                .expect("undo latest library rating"),
            true,
        );
        assert_eq!(restored.review_version, 3);
        assert_eq!(restored.last_review_ms, first.card_state.last_review_ms);
    }
}
