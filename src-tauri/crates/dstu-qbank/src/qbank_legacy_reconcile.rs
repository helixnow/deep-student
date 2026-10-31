//! Historical preview-only migration audit and explicit reconciliation.
//!
//! This module is deliberately additive:
//! - `audit_legacy_cards` is read-only and never mutates an exam.
//! - `migrate_legacy_cards` only converts cards the caller explicitly selected.
//!   It goes through `QuestionAuthoringService` draft/commit, then attaches the
//!   original preview card id to the *new* question id. Existing formal
//!   questions, ids and answer history are never rewritten.
//! - `reparse_report` compares a persisted authoring draft to canonical source
//!   slots (`questions.source_key`) only. It never guesses a match from labels,
//!   content similarity or page position.
//! - `resolve_reparse` applies an explicit keep / import-as-new / replace
//!   decision. Replacement is OCC protected and preserves the canonical id.
//!
//! Original preview pages and cards are treated as immutable evidence. After a
//! commit (which projects preview cards from formal questions) the original
//! page/card snapshot is merged back, so page images, paths and legacy cards are
//! never wiped. A canonical marker with zero live canonical questions suppresses
//! every preview card; deleted rows are never recreated from the snapshot.

use crate::models::AppError;
use crate::qbank_authoring_service::QuestionAuthoringService;
use crate::qbank_document::{DraftQuestion, QuestionDocument, SourceRef};
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::{QuestionImage, QuestionOption, VfsExamRepo, VfsQuestionRepo};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

fn storage(error: impl std::fmt::Display) -> AppError {
    AppError::database(error.to_string())
}

fn conflict(message: &str) -> AppError {
    AppError::conflict(message)
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn hash_value(value: &Value) -> String {
    let bytes = serde_json::to_vec(value).unwrap_or_else(|_| b"null".to_vec());
    hex::encode(Sha256::digest(bytes))
}

const QUESTION_TYPES: &[&str] = &[
    "single_choice",
    "multiple_choice",
    "indefinite_choice",
    "fill_blank",
    "short_answer",
    "essay",
    "calculation",
    "proof",
    "true_false",
    "matching",
    "ordering",
    "numeric",
    "other",
];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LegacyAuditPage {
    pub page_index: i64,
    pub blob_hash: Option<String>,
    pub original_image_path: String,
    pub width: Option<u64>,
    pub height: Option<u64>,
    pub card_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LegacyAuditCard {
    pub card_id: Option<String>,
    pub page_index: i64,
    pub card_index: i64,
    pub question_label: Option<String>,
    pub preview_text: String,
    /// matched | unmatched | ambiguous | deleted | invalid | suppressed_canonical
    pub status: String,
    pub formal_question_id: Option<String>,
    pub candidate_question_ids: Vec<String>,
    pub deleted_question_ids: Vec<String>,
    pub migratable: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LegacyMigrationAudit {
    pub exam_id: String,
    pub canonical_marker: bool,
    pub canonical_question_count: usize,
    /// Stable source snapshot (pages + preview identities). Does not change when
    /// migration projects formal content into preview cards.
    pub source_version: String,
    /// OCC version of the full mapping report. `migrate_legacy_cards` requires
    /// this value (except for an idempotent replay of an already-applied
    /// selection).
    pub audit_version: String,
    pub pages: Vec<LegacyAuditPage>,
    pub cards: Vec<LegacyAuditCard>,
    pub migratable_card_ids: Vec<String>,
    pub matched_count: usize,
    pub unmatched_count: usize,
    pub ambiguous_count: usize,
    pub deleted_count: usize,
    pub invalid_count: usize,
    pub suppressed_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LegacyMigrationReceipt {
    pub exam_id: String,
    pub committed: bool,
    pub idempotent: bool,
    pub job_id: Option<String>,
    pub migrated_card_ids: Vec<String>,
    pub question_ids: Vec<String>,
    pub imported_count: usize,
    pub audit_version_before: String,
    pub audit_version_after: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ReparseFieldChange {
    pub field: String,
    pub before: Value,
    pub after: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ReparseItem {
    pub local_id: String,
    pub source_key: Option<String>,
    /// unchanged | changed | new | unmapped | deleted | ambiguous
    pub status: String,
    pub canonical_question_id: Option<String>,
    pub canonical_revision: Option<String>,
    pub candidate_question_ids: Vec<String>,
    pub changes: Vec<ReparseFieldChange>,
    pub allowed_actions: Vec<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ReparseCanonicalOnlyItem {
    pub question_id: String,
    pub source_key: String,
    pub canonical_revision: String,
    pub question_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ReparseReport {
    pub exam_id: String,
    pub job_id: String,
    pub job_version: i64,
    pub report_version: String,
    pub canonical_marker: bool,
    pub canonical_question_count: usize,
    pub items: Vec<ReparseItem>,
    pub canonical_only: Vec<ReparseCanonicalOnlyItem>,
    pub changed_count: usize,
    pub new_count: usize,
    pub deleted_count: usize,
    pub ambiguous_count: usize,
    #[serde(default)]
    pub resolved: bool,
    #[serde(default)]
    pub resolution: Option<ReparseResolveReceipt>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReparseDecision {
    pub local_id: String,
    /// keep_existing | import_as_new | replace_existing
    pub action: String,
    /// Required for replace_existing; must equal the report item's
    /// `canonical_revision`.
    pub expected_revision: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ReparseAppliedItem {
    pub local_id: String,
    pub action: String,
    pub question_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ReparseResolveReceipt {
    pub exam_id: String,
    pub job_id: String,
    pub applied: Vec<ReparseAppliedItem>,
    pub imported_question_ids: Vec<String>,
    pub replaced_question_ids: Vec<String>,
    pub kept_local_ids: Vec<String>,
}

#[derive(Debug, Clone)]
struct PreviewPage {
    page_index: i64,
    blob_hash: Option<String>,
    original_image_path: String,
    width: Option<u64>,
    height: Option<u64>,
    cards: Vec<PreviewCard>,
}

#[derive(Debug, Clone)]
struct PreviewCard {
    card_id: Option<String>,
    page_index: i64,
    card_index: i64,
    question_label: Option<String>,
    text: String,
    raw: Value,
}

#[derive(Debug, Clone)]
struct FormalRow {
    id: String,
    card_id: Option<String>,
    deleted: bool,
    updated_at: String,
    source_key: Option<String>,
}

#[derive(Debug, Clone)]
struct CanonicalRow {
    id: String,
    card_id: Option<String>,
    question_label: Option<String>,
    content: String,
    options: Option<Vec<QuestionOption>>,
    answer: Option<String>,
    explanation: Option<String>,
    structured_data: Option<Value>,
    question_type: String,
    difficulty: Option<String>,
    tags: Vec<String>,
    images: Vec<QuestionImage>,
    source_key: Option<String>,
    deleted: bool,
    updated_at: String,
    group_id: Option<String>,
    parent_id: Option<String>,
    provenance_json: Option<String>,
}

pub struct LegacyReconcileService {
    db: Arc<VfsDatabase>,
}

impl LegacyReconcileService {
    pub fn new(db: Arc<VfsDatabase>) -> Self {
        Self { db }
    }

    /// Read-only audit of preview-only legacy cards.
    pub fn audit_legacy_cards(&self, exam_id: &str) -> Result<LegacyMigrationAudit, AppError> {
        let conn = self.db.get_conn_safe().map_err(storage)?;
        self.audit_with_conn(&conn, exam_id)
    }

    /// Explicitly migrate a subset of preview-only cards.
    ///
    /// `expected_version` is the audit version returned by `audit_legacy_cards`.
    /// A replay of an already-applied selection is idempotent even with the
    /// original version; any other stale version is rejected before mutating.
    pub fn migrate_legacy_cards(
        &self,
        exam_id: &str,
        selected_card_ids: &[String],
        expected_version: &str,
    ) -> Result<LegacyMigrationReceipt, AppError> {
        if selected_card_ids.is_empty() {
            return Err(AppError::validation("请选择要迁移的历史题目卡片"));
        }
        let unique: HashSet<&String> = selected_card_ids.iter().collect();
        if unique.len() != selected_card_ids.len() {
            return Err(AppError::validation("迁移选择包含重复的卡片 ID"));
        }
        if selected_card_ids.iter().any(|id| id.trim().is_empty()) {
            return Err(AppError::validation("卡片 ID 不能为空"));
        }

        let mut pooled = self.db.get_conn_safe().map_err(storage)?;
        let conn = pooled
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(storage)?;
        let audit = self.audit_with_conn(&conn, exam_id)?;

        // Idempotent replay: every selected card already points at exactly one
        // live question carrying our migration marker. No writes at all.
        if let Some(receipt) =
            self.idempotent_receipt(&conn, exam_id, selected_card_ids, &audit.audit_version)?
        {
            return Ok(receipt);
        }

        if audit.audit_version != expected_version {
            return Err(conflict(
                "历史导入审计已变化，请重新载入后再选择迁移（未修改任何内容）",
            ));
        }

        let by_id: HashMap<&str, &LegacyAuditCard> = audit
            .cards
            .iter()
            .filter_map(|card| card.card_id.as_deref().map(|id| (id, card)))
            .collect();
        let mut selected_cards = Vec::with_capacity(selected_card_ids.len());
        for id in selected_card_ids {
            let item = by_id
                .get(id.as_str())
                .ok_or_else(|| AppError::validation(format!("审计结果中不存在卡片: {id}")))?;
            if !item.migratable || item.status != "unmatched" {
                return Err(AppError::validation(format!(
                    "卡片 {id} 当前不可迁移（状态 {}）：{}",
                    item.status,
                    item.reason.as_deref().unwrap_or("需要用户重新复核")
                )));
            }
            selected_cards.push(*item);
        }

        let preview = self.preview_pages(&conn, exam_id)?;
        let page_map: HashMap<(i64, i64), &PreviewPage> = preview
            .iter()
            .flat_map(|page| {
                page.cards
                    .iter()
                    .map(move |card| ((page.page_index, card.card_index), page))
            })
            .collect();
        let card_map: HashMap<(i64, i64), &PreviewCard> = preview
            .iter()
            .flat_map(|page| {
                page.cards
                    .iter()
                    .map(move |card| ((page.page_index, card.card_index), card))
            })
            .collect();

        let original_preview = self.raw_preview(&conn, exam_id)?;
        let mut document = QuestionDocument {
            schema_version: 2,
            mode: "extract".into(),
            ..Default::default()
        };
        let mut local_ids = Vec::with_capacity(selected_cards.len());
        let mut legacy_snapshots = Vec::with_capacity(selected_cards.len());
        for item in &selected_cards {
            let card_id = item
                .card_id
                .as_deref()
                .ok_or_else(|| AppError::validation("卡片缺少稳定 ID，无法迁移"))?;
            let key = (item.page_index, item.card_index);
            let card = card_map.get(&key).ok_or_else(|| {
                AppError::validation(format!("卡片 {card_id} 的预览内容已变化，请重新载入"))
            })?;
            let page = page_map.get(&key).ok_or_else(|| {
                AppError::validation(format!("卡片 {card_id} 所在页面已变化，请重新载入"))
            })?;
            let draft = preview_card_to_draft(&conn, card, page)?;
            local_ids.push(draft.local_id.clone());
            legacy_snapshots.push(json!({
                "card_id": card_id,
                "page_index": card.page_index,
                "card_index": card.card_index,
                "question_label": card.question_label,
                "page_blob_hash": page.blob_hash,
                "page_original_image_path": page.original_image_path,
                "page_width": page.width,
                "page_height": page.height,
                "card": card.raw,
            }));
            document.questions.push(draft);
        }
        // Validation happens before any DB write (save_draft validates too).
        document
            .validate()
            .map_err(|e| AppError::validation(format!("所选历史卡片无法迁移: {}", e.message)))?;

        let selection_hash = hash_value(&json!(selected_card_ids));
        let metadata = json!({
            "idempotency_key": format!(
                "legacy-migrate:{}:{}",
                exam_id, selection_hash
            ),
            "legacy_migration": {
                "exam_id": exam_id,
                "card_ids": selected_card_ids,
                "audit_version": expected_version,
            }
        });
        let job =
            QuestionAuthoringService::save_draft_with_conn(&conn, exam_id, &document, &metadata)?;
        let draft = QuestionAuthoringService::get_draft_with_conn(&conn, &job)?;
        let receipt = QuestionAuthoringService::commit_draft_with_conn(
            &conn,
            &job,
            &local_ids,
            draft.version,
        )?;
        if !receipt.committed || receipt.question_ids.len() != local_ids.len() {
            return Err(AppError::database(
                "历史卡片迁移未返回完整题目映射，未继续写入卡片身份",
            ));
        }

        let stamp = now();
        let tx = &conn;
        for ((card_id, local_snapshot), question_id) in selected_card_ids
            .iter()
            .zip(legacy_snapshots.iter())
            .zip(receipt.question_ids.iter())
        {
            let changed = tx
                .execute(
                    "UPDATE questions SET card_id=?1, updated_at=?2 WHERE id=?3 AND exam_id=?4 AND deleted_at IS NULL",
                    params![card_id, stamp, question_id, exam_id],
                )
                .map_err(storage)?;
            if changed != 1 {
                return Err(conflict("新迁移题目已被其他操作修改，未写入卡片身份"));
            }
            let marker = json!({
                "legacy_migration": {
                    "exam_id": exam_id,
                    "card_id": card_id,
                    "audit_version": expected_version,
                    "migrated_at": stamp,
                },
                "legacy_preview": local_snapshot,
            });
            let changed = tx
                .execute(
                    "UPDATE questions SET provenance_json=json_patch(COALESCE(provenance_json,'{}'), json(?1)) WHERE id=?2",
                    params![marker.to_string(), question_id],
                )
                .map_err(storage)?;
            if changed != 1 {
                return Err(conflict("新迁移题目来源写入失败"));
            }
        }
        // Merge the projected preview with the original evidence. This restores
        // every unselected legacy card and every original page image/path.
        crate::qbank_authoring_service::refresh_canonical_preview_with_conn(&tx, exam_id)
            .map_err(storage)?;
        let projected = self.raw_preview(&tx, exam_id)?;
        let merged = merge_preview_union(&original_preview, &projected);
        VfsExamRepo::update_preview_json_with_conn(&tx, exam_id, merged).map_err(storage)?;
        VfsQuestionRepo::refresh_stats_with_conn(&tx, exam_id).map_err(storage)?;
        let after = self.audit_with_conn(&conn, exam_id).ok();
        conn.commit().map_err(storage)?;
        Ok(LegacyMigrationReceipt {
            exam_id: exam_id.to_string(),
            committed: true,
            idempotent: false,
            job_id: Some(job),
            migrated_card_ids: selected_card_ids.to_vec(),
            question_ids: receipt.question_ids,
            imported_count: receipt.imported_count,
            audit_version_before: expected_version.to_string(),
            audit_version_after: after.map(|a| a.audit_version),
        })
    }

    /// Compare the persisted authoring draft to canonical source slots.
    pub fn reparse_report(
        &self,
        exam_id: &str,
        job_id: Option<&str>,
    ) -> Result<ReparseReport, AppError> {
        let conn = self.db.get_conn_safe().map_err(storage)?;
        self.reparse_report_with_conn(&conn, exam_id, job_id)
    }

    /// Apply one terminal decision set atomically. Omitted items are kept.
    /// Exact retries return the persisted receipt without reapplying any write;
    /// changing a resolved decision set requires a new authoring draft.
    pub fn resolve_reparse(
        &self,
        exam_id: &str,
        job_id: &str,
        decisions: &[ReparseDecision],
        expected_report_version: &str,
    ) -> Result<ReparseResolveReceipt, AppError> {
        let mut conn = self.db.get_conn_safe().map_err(storage)?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(storage)?;
        VfsExamRepo::get_exam_sheet_with_conn(&tx, exam_id)
            .map_err(storage)?
            .ok_or_else(|| AppError::not_found("目标题目集不存在"))?;
        let draft = QuestionAuthoringService::get_draft_with_conn(&tx, job_id)?;
        if draft.exam_id != exam_id {
            return Err(AppError::validation("草稿不属于目标题目集"));
        }
        draft.document.validate()?;
        let normalized = normalize_reparse_decisions(&draft.document, decisions)?;
        if let Some(saved) = draft.metadata.get("reparse_resolution") {
            let previous: Vec<ReparseDecision> =
                serde_json::from_value(saved["decisions"].clone()).map_err(storage)?;
            if previous != normalized {
                return Err(conflict(
                    "该草稿已完成复核，不能改变已确认的选择；请创建新草稿",
                ));
            }
            return serde_json::from_value(saved["receipt"].clone()).map_err(storage);
        }
        if !matches!(
            draft.status.as_str(),
            "ready" | "needs_review" | "partial" | "committed"
        ) {
            return Err(conflict("该草稿已取消或不可复核，请重新载入"));
        }
        let report = self.reparse_report_with_conn(&tx, exam_id, Some(job_id))?;
        if report.report_version != expected_report_version {
            return Err(conflict(
                "重解析报告已变化，请重新载入后再确认操作（未修改任何内容）",
            ));
        }
        let items: HashMap<&str, &ReparseItem> = report
            .items
            .iter()
            .map(|item| (item.local_id.as_str(), item))
            .collect();
        let by_local: HashMap<&str, &DraftQuestion> = draft
            .document
            .questions
            .iter()
            .map(|q| (q.local_id.as_str(), q))
            .collect();
        let mut replacement_targets = HashSet::new();
        let mut import_slots = HashSet::new();
        // Validate the complete decision set before the first mutation. Runtime
        // DB failures still roll everything back through the outer transaction.
        for decision in &normalized {
            let item = items.get(decision.local_id.as_str()).ok_or_else(|| {
                AppError::validation(format!("草稿题目不存在: {}", decision.local_id))
            })?;
            if !item.allowed_actions.iter().any(|a| a == &decision.action) {
                return Err(AppError::validation(format!(
                    "题目 {} 不允许操作 {}（状态 {}）",
                    decision.local_id, decision.action, item.status
                )));
            }
            let question = by_local[decision.local_id.as_str()];
            if decision.action == "import_as_new" && !supports_standalone_import(question) {
                return Err(AppError::validation("题组/变式题不能单独导入为新题"));
            }
            if decision.action == "import_as_new" && item.status == "new" {
                if let Some(slot) = item.source_key.as_deref() {
                    if !import_slots.insert(slot) {
                        return Err(AppError::validation(
                            "多个草稿题目使用同一新增来源槽，不能猜测身份",
                        ));
                    }
                }
            }
            if decision.action != "keep_existing" {
                validate_reparse_question(&tx, question)?;
            }
            if decision.action == "replace_existing" {
                let expected = decision
                    .expected_revision
                    .as_deref()
                    .ok_or_else(|| AppError::validation("替换操作必须携带 expected_revision"))?;
                if item.canonical_revision.as_deref() != Some(expected) {
                    return Err(conflict("题目版本已变化，请重新载入后再替换"));
                }
                let target = item
                    .canonical_question_id
                    .as_deref()
                    .ok_or_else(|| AppError::validation("该草稿项没有可替换的正式题目"))?;
                if !replacement_targets.insert(target) {
                    return Err(AppError::validation(
                        "同一正式题目不能在一次复核中被重复替换",
                    ));
                }
            }
        }
        let original_preview = self.raw_preview(&tx, exam_id)?;
        let import_state: Option<String> = tx
            .query_row(
                "SELECT import_state_json FROM exam_sheets WHERE id=?1",
                [exam_id],
                |row| row.get(0),
            )
            .map_err(storage)?;
        let mut receipt = ReparseResolveReceipt {
            exam_id: exam_id.to_string(),
            job_id: job_id.to_string(),
            ..Default::default()
        };
        for decision in &normalized {
            let item = items[decision.local_id.as_str()];
            let question = by_local
                .get(decision.local_id.as_str())
                .ok_or_else(|| AppError::validation("草稿题目内容缺失"))?;
            match decision.action.as_str() {
                "keep_existing" => {
                    receipt.kept_local_ids.push(decision.local_id.clone());
                    receipt.applied.push(ReparseAppliedItem {
                        local_id: decision.local_id.clone(),
                        action: decision.action.clone(),
                        question_id: item.canonical_question_id.clone(),
                    });
                }
                "import_as_new" => {
                    let keep_slot = item.status == "new" && item.source_key.is_some();
                    let id = self.import_reparse_question_with_conn(
                        &tx,
                        exam_id,
                        job_id,
                        &report.report_version,
                        question,
                        keep_slot,
                        &draft.metadata,
                    )?;
                    receipt.imported_question_ids.push(id.clone());
                    receipt.applied.push(ReparseAppliedItem {
                        local_id: decision.local_id.clone(),
                        action: decision.action.clone(),
                        question_id: Some(id),
                    });
                }
                "replace_existing" => {
                    let question_id = item
                        .canonical_question_id
                        .as_deref()
                        .ok_or_else(|| AppError::validation("该草稿项没有可替换的正式题目"))?;
                    let expected = decision.expected_revision.as_deref().ok_or_else(|| {
                        AppError::validation("替换操作必须携带 expected_revision")
                    })?;
                    self.replace_canonical_question_with_conn(
                        &tx,
                        exam_id,
                        question_id,
                        expected,
                        question,
                        job_id,
                    )?;
                    receipt.replaced_question_ids.push(question_id.to_string());
                    receipt.applied.push(ReparseAppliedItem {
                        local_id: decision.local_id.clone(),
                        action: decision.action.clone(),
                        question_id: Some(question_id.to_string()),
                    });
                }
                other => {
                    return Err(AppError::validation(format!("未知操作: {other}")));
                }
            }
        }
        if !receipt.imported_question_ids.is_empty() || !receipt.replaced_question_ids.is_empty() {
            crate::qbank_authoring_service::refresh_canonical_preview_with_conn(&tx, exam_id)?;
            let projected = self.raw_preview(&tx, exam_id)?;
            VfsExamRepo::update_preview_json_with_conn(
                &tx,
                exam_id,
                merge_preview_union(&original_preview, &projected),
            )
            .map_err(storage)?;
            VfsQuestionRepo::invalidate_exam_content_index_with_conn(&tx, exam_id)
                .map_err(storage)?;
            VfsQuestionRepo::refresh_stats_with_conn(&tx, exam_id).map_err(storage)?;
        }
        let resolution = json!({
            "report_version": expected_report_version,
            "decisions": normalized,
            "receipt": receipt,
            "resolved_at": now(),
        });
        // Preserve an existing normal commit's receipt/selection. Pending jobs
        // are retired so normal authoring commit cannot import them afterwards.
        let changed = tx.execute(
            "UPDATE qbank_import_jobs SET metadata_json=json_set(metadata_json,'$.reparse_resolution',json(?1)), status=CASE WHEN status='committed' THEN status ELSE 'cancelled' END, version=version+1, updated_at=?2 WHERE id=?3 AND exam_id=?4 AND version=?5 AND json_extract(metadata_json,'$.reparse_resolution') IS NULL",
            params![resolution.to_string(), now(), job_id, exam_id, draft.version],
        ).map_err(storage)?;
        if changed != 1 {
            return Err(conflict("草稿已被其他操作修改，未应用任何复核选择"));
        }
        let retained_state = import_state.filter(|raw| {
            serde_json::from_str::<Value>(raw)
                .ok()
                .is_none_or(|state| state["job_id"].as_str() != Some(job_id))
        });
        tx.execute(
            "UPDATE exam_sheets SET import_state_json=?1 WHERE id=?2",
            params![retained_state, exam_id],
        )
        .map_err(storage)?;
        tx.commit().map_err(storage)?;
        Ok(receipt)
    }

    fn audit_with_conn(
        &self,
        conn: &Connection,
        exam_id: &str,
    ) -> Result<LegacyMigrationAudit, AppError> {
        let exam = VfsExamRepo::get_exam_sheet_with_conn(conn, exam_id)
            .map_err(storage)?
            .ok_or_else(|| AppError::not_found("目标题目集不存在"))?;
        let canonical_marker = exam
            .metadata_json
            .get("question_document_version")
            .and_then(Value::as_i64)
            == Some(2);
        let pages = self.preview_pages(conn, exam_id)?;
        let rows = load_formal_rows(conn, exam_id)?;
        let live_count = rows.iter().filter(|r| !r.deleted).count();

        let mut by_card: HashMap<&str, Vec<&FormalRow>> = HashMap::new();
        let mut by_id: HashMap<&str, &FormalRow> = HashMap::new();
        for row in &rows {
            by_id.insert(row.id.as_str(), row);
            if let Some(card_id) = row.card_id.as_deref() {
                by_card.entry(card_id).or_default().push(row);
            }
        }

        let mut identity_counts: HashMap<String, usize> = HashMap::new();
        for page in &pages {
            for card in &page.cards {
                if let Some(id) = card.card_id.as_deref() {
                    *identity_counts.entry(id.to_string()).or_default() += 1;
                }
            }
        }

        let mut cards = Vec::new();
        let mut migratable = Vec::new();
        let mut matched_count = 0;
        let mut unmatched_count = 0;
        let mut ambiguous_count = 0;
        let mut deleted_count = 0;
        let mut invalid_count = 0;
        let mut suppressed_count = 0;
        for page in &pages {
            for card in &page.cards {
                let mut item = LegacyAuditCard {
                    card_id: card.card_id.clone(),
                    page_index: card.page_index,
                    card_index: card.card_index,
                    question_label: card.question_label.clone(),
                    preview_text: card.text.clone(),
                    ..Default::default()
                };
                let Some(card_id) = card.card_id.as_deref() else {
                    item.status = "invalid".into();
                    item.reason = Some("卡片缺少 card_id/id，无法建立稳定身份".into());
                    invalid_count += 1;
                    cards.push(item);
                    continue;
                };
                if identity_counts.get(card_id).copied().unwrap_or(0) > 1 {
                    item.status = "invalid".into();
                    item.reason = Some("预览中存在重复 card_id，不能猜测迁移对象".into());
                    invalid_count += 1;
                    cards.push(item);
                    continue;
                }
                let mut candidates: Vec<&FormalRow> = Vec::new();
                let mut seen_ids = HashSet::new();
                for row in by_card.get(card_id).into_iter().flatten() {
                    if seen_ids.insert(row.id.as_str()) {
                        candidates.push(row);
                    }
                }
                if let Some(row) = by_id.get(card_id) {
                    if seen_ids.insert(row.id.as_str()) {
                        candidates.push(row);
                    }
                }
                let live: Vec<&FormalRow> =
                    candidates.iter().copied().filter(|r| !r.deleted).collect();
                let deleted: Vec<&FormalRow> =
                    candidates.iter().copied().filter(|r| r.deleted).collect();
                item.candidate_question_ids = live.iter().map(|r| r.id.clone()).collect();
                item.deleted_question_ids = deleted.iter().map(|r| r.id.clone()).collect();

                if canonical_marker && live_count == 0 {
                    // The canonical marker says preview cards are projections.
                    // With no live canonical question the whole projection was
                    // deleted; never recreate it from the snapshot.
                    item.status = "suppressed_canonical".into();
                    item.reason = Some(
                        "题目集已有规范化标记且正式题目全部删除；不会从历史预览快照重建".into(),
                    );
                    suppressed_count += 1;
                } else if live.len() == 1 {
                    item.status = "matched".into();
                    item.formal_question_id = Some(live[0].id.clone());
                    matched_count += 1;
                } else if live.len() > 1 {
                    item.status = "ambiguous".into();
                    item.reason = Some("同一 card_id/id 命中多个正式题目，未做语义猜测".into());
                    ambiguous_count += 1;
                } else if !deleted.is_empty() {
                    item.status = "deleted".into();
                    item.reason = Some("对应正式题目已删除；如需恢复必须显式恢复原题".into());
                    deleted_count += 1;
                } else if card.text.trim().is_empty() {
                    item.status = "invalid".into();
                    item.reason = Some("卡片题干预览为空，不能生成正式题目".into());
                    invalid_count += 1;
                } else {
                    item.status = "unmatched".into();
                    item.migratable = true;
                    migratable.push(card_id.to_string());
                    unmatched_count += 1;
                }
                cards.push(item);
            }
        }

        let source_snapshot = json!(pages
            .iter()
            .map(|page| json!({
                "page_index": page.page_index,
                "blob_hash": page.blob_hash,
                "original_image_path": page.original_image_path,
                "width": page.width,
                "height": page.height,
                "cards": page.cards.iter().map(|card| json!({
                    "card_id": card.card_id,
                    "page_index": card.page_index,
                    "card_index": card.card_index,
                    "question_label": card.question_label,
                })).collect::<Vec<_>>(),
            }))
            .collect::<Vec<_>>());
        let source_version = hash_value(&source_snapshot);
        let mut formal_snapshot: Vec<_> = rows.iter().collect();
        formal_snapshot.sort_by(|a, b| a.id.cmp(&b.id));
        let audit_version = hash_value(&json!({
            "source_version": source_version,
            "canonical_marker": canonical_marker,
            "formal": formal_snapshot.iter().map(|row| json!({
                "id": row.id,
                "card_id": row.card_id,
                "deleted": row.deleted,
                "updated_at": row.updated_at,
                "source_key": row.source_key,
            })).collect::<Vec<_>>(),
            "mapping": cards.iter().map(|card| json!({
                "card_id": card.card_id,
                "status": card.status,
                "formal_question_id": card.formal_question_id,
                "candidates": card.candidate_question_ids,
                "deleted": card.deleted_question_ids,
            })).collect::<Vec<_>>(),
        }));

        Ok(LegacyMigrationAudit {
            exam_id: exam_id.to_string(),
            canonical_marker,
            canonical_question_count: live_count,
            source_version,
            audit_version,
            pages: pages
                .iter()
                .map(|page| LegacyAuditPage {
                    page_index: page.page_index,
                    blob_hash: page.blob_hash.clone(),
                    original_image_path: page.original_image_path.clone(),
                    width: page.width,
                    height: page.height,
                    card_count: page.cards.len(),
                })
                .collect(),
            cards,
            migratable_card_ids: migratable,
            matched_count,
            unmatched_count,
            ambiguous_count,
            deleted_count,
            invalid_count,
            suppressed_count,
        })
    }

    fn preview_pages(
        &self,
        conn: &Connection,
        exam_id: &str,
    ) -> Result<Vec<PreviewPage>, AppError> {
        let preview = self.raw_preview(conn, exam_id)?;
        let mut pages = Vec::new();
        for (page_index, page) in preview["pages"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
        {
            let index = page["page_index"].as_i64().unwrap_or(page_index as i64);
            let mut cards = Vec::new();
            for (card_index, card) in page["cards"].as_array().into_iter().flatten().enumerate() {
                let card_id = preview_card_identity(card);
                let text = preview_card_text(card);
                let label = card["question_label"]
                    .as_str()
                    .or_else(|| card["questionLabel"].as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(ToOwned::to_owned);
                cards.push(PreviewCard {
                    card_id,
                    page_index: index,
                    card_index: card_index as i64,
                    question_label: label,
                    text,
                    raw: card.clone(),
                });
            }
            pages.push(PreviewPage {
                page_index: index,
                blob_hash: page["blob_hash"]
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(ToOwned::to_owned),
                original_image_path: page["original_image_path"]
                    .as_str()
                    .unwrap_or("")
                    .to_string(),
                width: page["width"].as_u64(),
                height: page["height"].as_u64(),
                cards,
            });
        }
        Ok(pages)
    }

    fn raw_preview(&self, conn: &Connection, exam_id: &str) -> Result<Value, AppError> {
        let text: Option<String> = conn
            .query_row(
                "SELECT preview_json FROM exam_sheets WHERE id=?1 AND deleted_at IS NULL",
                [exam_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage)?
            .ok_or_else(|| AppError::not_found("目标题目集不存在"))?;
        Ok(text
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_else(|| json!({"pages": []})))
    }

    fn idempotent_receipt(
        &self,
        conn: &Connection,
        exam_id: &str,
        selected_card_ids: &[String],
        current_audit_version: &str,
    ) -> Result<Option<LegacyMigrationReceipt>, AppError> {
        // A deleted migrated question must not be recreated; surface it as a
        // conflict instead of reporting a successful replay.
        for card_id in selected_card_ids {
            let deleted: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM questions WHERE exam_id=?1 AND deleted_at IS NOT NULL AND json_extract(provenance_json,'$.legacy_migration.card_id')=?2)",
                    params![exam_id, card_id],
                    |row| row.get(0),
                )
                .map_err(storage)?;
            if deleted {
                return Err(conflict(
                    "该历史卡片迁移出的正式题目已被删除；不会从预览快照重建，请显式恢复原题",
                ));
            }
        }
        let mut question_ids = Vec::with_capacity(selected_card_ids.len());
        for card_id in selected_card_ids {
            let mut stmt = conn
                .prepare(
                    "SELECT id FROM questions WHERE exam_id=?1 AND deleted_at IS NULL AND (card_id=?2 OR id=?2) AND json_extract(provenance_json,'$.legacy_migration.card_id')=?2 ORDER BY id",
                )
                .map_err(storage)?;
            let ids: Vec<String> = stmt
                .query_map(params![exam_id, card_id], |row| row.get(0))
                .map_err(storage)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(storage)?;
            if ids.len() != 1 {
                return Ok(None);
            }
            question_ids.push(ids[0].clone());
        }
        Ok(Some(LegacyMigrationReceipt {
            exam_id: exam_id.to_string(),
            committed: true,
            idempotent: true,
            job_id: None,
            migrated_card_ids: selected_card_ids.to_vec(),
            question_ids,
            imported_count: 0,
            audit_version_before: current_audit_version.to_string(),
            audit_version_after: Some(current_audit_version.to_string()),
        }))
    }

    fn reparse_report_with_conn(
        &self,
        conn: &Connection,
        exam_id: &str,
        job_id: Option<&str>,
    ) -> Result<ReparseReport, AppError> {
        let exam = VfsExamRepo::get_exam_sheet_with_conn(conn, exam_id)
            .map_err(storage)?
            .ok_or_else(|| AppError::not_found("目标题目集不存在"))?;
        let canonical_marker = exam
            .metadata_json
            .get("question_document_version")
            .and_then(Value::as_i64)
            == Some(2);
        let job_id = match job_id {
            Some(id) => id.to_string(),
            None => conn
                .query_row(
                    "SELECT id FROM qbank_import_jobs WHERE exam_id=?1 AND (status IN ('ready','needs_review','partial','committed') OR json_type(metadata_json,'$.reparse_resolution')='object') AND json_type(metadata_json,'$.reparse_import') IS NULL ORDER BY updated_at DESC, id DESC LIMIT 1",
                    [exam_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(storage)?
                .ok_or_else(|| AppError::not_found("当前题目集没有可复核的导入草稿"))?,
        };
        let draft = QuestionAuthoringService::get_draft_with_conn(conn, &job_id)?;
        if draft.exam_id != exam_id {
            return Err(AppError::validation("草稿不属于目标题目集"));
        }
        let resolution = draft
            .metadata
            .get("reparse_resolution")
            .map(|saved| serde_json::from_value::<ReparseResolveReceipt>(saved["receipt"].clone()))
            .transpose()
            .map_err(storage)?;
        let resolved = resolution.is_some();
        let rows = load_canonical_rows(conn, exam_id)?;
        let live_count = rows.iter().filter(|r| !r.deleted).count();
        let mut by_source: HashMap<&str, Vec<&CanonicalRow>> = HashMap::new();
        for row in &rows {
            if let Some(key) = row.source_key.as_deref() {
                by_source.entry(key).or_default().push(row);
            }
        }
        let mut matched_keys = HashSet::new();
        let mut items = Vec::with_capacity(draft.document.questions.len());
        let mut changed_count = 0;
        let mut new_count = 0;
        let mut deleted_count = 0;
        let mut ambiguous_count = 0;
        for question in &draft.document.questions {
            let (slot, slot_reason) = draft_source_slot(conn, exam_id, &draft.metadata, question)?;
            let mut item = ReparseItem {
                local_id: question.local_id.clone(),
                source_key: slot.clone(),
                ..Default::default()
            };
            let Some(slot) = slot else {
                if canonical_marker && live_count == 0 {
                    item.status = "deleted".into();
                    item.reason =
                        Some("规范化题目集已无正式题目；不会从无来源槽草稿重建题目".into());
                    item.allowed_actions = vec!["keep_existing".into()];
                    deleted_count += 1;
                } else {
                    item.status = "unmapped".into();
                    item.reason = slot_reason
                        .or_else(|| Some("草稿缺少稳定来源槽，不能与正式题目建立身份映射".into()));
                    item.allowed_actions = vec!["keep_existing".into(), "import_as_new".into()];
                }
                restrict_reparse_actions(&mut item, question, resolved);
                items.push(item);
                continue;
            };
            let candidates = by_source.get(slot.as_str()).cloned().unwrap_or_default();
            let live: Vec<&CanonicalRow> =
                candidates.iter().copied().filter(|r| !r.deleted).collect();
            let deleted: Vec<&CanonicalRow> =
                candidates.iter().copied().filter(|r| r.deleted).collect();
            item.candidate_question_ids = candidates.iter().map(|r| r.id.clone()).collect();
            if canonical_marker && live_count == 0 && live.is_empty() {
                item.status = "deleted".into();
                item.reason =
                    Some("规范化题目集已无正式题目；不会从草稿/预览重建已删除的题目".into());
                item.allowed_actions = vec!["keep_existing".into()];
                deleted_count += 1;
            } else if live.len() > 1 {
                item.status = "ambiguous".into();
                item.reason = Some("多个正式题目共享同一来源槽，未做覆盖猜测".into());
                item.allowed_actions = vec!["keep_existing".into()];
                ambiguous_count += 1;
            } else if let Some(row) = live.first() {
                matched_keys.insert(slot);
                item.canonical_question_id = Some(row.id.clone());
                item.canonical_revision = Some(canonical_revision(row));
                let changes = diff_question(question, row);
                if changes.is_empty() {
                    item.status = "unchanged".into();
                    item.allowed_actions = vec!["keep_existing".into()];
                } else {
                    item.status = "changed".into();
                    item.changes = changes;
                    item.allowed_actions = vec![
                        "keep_existing".into(),
                        "import_as_new".into(),
                        "replace_existing".into(),
                    ];
                    changed_count += 1;
                }
            } else if !deleted.is_empty() {
                item.status = "deleted".into();
                item.canonical_question_id = deleted[0].id.clone().into();
                item.reason = Some("对应正式题目已删除；如需恢复必须显式恢复原题".into());
                item.allowed_actions = vec!["keep_existing".into()];
                deleted_count += 1;
            } else {
                item.status = "new".into();
                item.allowed_actions = vec!["keep_existing".into(), "import_as_new".into()];
                new_count += 1;
            }
            restrict_reparse_actions(&mut item, question, resolved);
            items.push(item);
        }
        let mut canonical_only = Vec::new();
        for row in &rows {
            if row.deleted {
                continue;
            }
            if let Some(key) = row.source_key.as_deref() {
                if !matched_keys.contains(key) {
                    canonical_only.push(ReparseCanonicalOnlyItem {
                        question_id: row.id.clone(),
                        source_key: key.to_string(),
                        canonical_revision: canonical_revision(row),
                        question_label: row.question_label.clone(),
                    });
                }
            }
        }
        canonical_only.sort_by(|a, b| a.question_id.cmp(&b.question_id));
        let report_version = hash_value(&json!({
            "exam_id": exam_id,
            "job_id": job_id,
            "job_version": draft.version,
            "document": draft.document,
            "metadata": draft.metadata,
            "canonical_marker": canonical_marker,
            "canonical_question_count": live_count,
            "items": items.iter().map(|item| json!({
                "local_id": item.local_id,
                "source_key": item.source_key,
                "status": item.status,
                "canonical_question_id": item.canonical_question_id,
                "canonical_revision": item.canonical_revision,
                "candidates": item.candidate_question_ids,
            })).collect::<Vec<_>>(),
            "canonical_only": canonical_only.iter().map(|item| json!({
                "question_id": item.question_id,
                "source_key": item.source_key,
                "canonical_revision": item.canonical_revision,
            })).collect::<Vec<_>>(),
        }));
        Ok(ReparseReport {
            exam_id: exam_id.to_string(),
            job_id,
            job_version: draft.version,
            report_version,
            canonical_marker,
            canonical_question_count: live_count,
            items,
            canonical_only,
            changed_count,
            new_count,
            deleted_count,
            ambiguous_count,
            resolved,
            resolution,
        })
    }

    fn import_reparse_question_with_conn(
        &self,
        conn: &Connection,
        exam_id: &str,
        job_id: &str,
        report_version: &str,
        question: &DraftQuestion,
        keep_slot: bool,
        metadata: &Value,
    ) -> Result<String, AppError> {
        if !supports_standalone_import(question) {
            return Err(AppError::validation("题组/变式题不能单独导入为新题"));
        }
        let mut draft_question = question.clone();
        draft_question.group_id = None;
        draft_question.parent_id = None;
        draft_question.parent_local_id = None;
        if !keep_slot {
            draft_question.source_refs.clear();
            draft_question.answer_source_refs.clear();
        }
        let document = QuestionDocument {
            schema_version: 2,
            mode: "extract".into(),
            questions: vec![draft_question],
            ..Default::default()
        };
        document
            .validate()
            .map_err(|e| AppError::validation(format!("导入为新题失败: {}", e.message)))?;
        let mut meta = json!({
            "idempotency_key": format!(
                "reparse-import:{}:{}:{}:{}",
                exam_id, job_id, question.local_id, report_version
            ),
            "reparse_import": {
                "exam_id": exam_id,
                "job_id": job_id,
                "local_id": question.local_id,
                "keep_source_slot": keep_slot,
            }
        });
        if keep_slot {
            if let Some(sources) = metadata.get("sources") {
                meta["sources"] = sources.clone();
            }
            if let Some(pages) = metadata.get("pages") {
                meta["pages"] = pages.clone();
            }
        }
        let job = QuestionAuthoringService::save_draft_with_conn(conn, exam_id, &document, &meta)?;
        let draft = QuestionAuthoringService::get_draft_with_conn(conn, &job)?;
        let receipt = QuestionAuthoringService::commit_draft_with_conn(
            conn,
            &job,
            std::slice::from_ref(&document.questions[0].local_id),
            draft.version,
        )?;
        if !receipt.committed || receipt.imported_count != 1 || receipt.question_ids.len() != 1 {
            return Err(conflict("来源槽已被占用，未导入新题，也未复用既有题目身份"));
        }
        let id = receipt
            .question_ids
            .first()
            .cloned()
            .ok_or_else(|| AppError::database("新题导入未返回题目 ID"))?;
        let marker = json!({
            "reparse": {
                "job_id": job_id,
                "local_id": question.local_id,
                "applied_at": now(),
                "action": "import_as_new",
                "draft_source_refs": question.source_refs,
                "draft_answer_source_refs": question.answer_source_refs,
            }
        });
        conn.execute(
            "UPDATE questions SET provenance_json=json_patch(COALESCE(provenance_json,'{}'), json(?1)) WHERE id=?2",
            params![marker.to_string(), id],
        )
        .map_err(storage)?;
        Ok(id)
    }

    fn replace_canonical_question_with_conn(
        &self,
        conn: &Connection,
        exam_id: &str,
        question_id: &str,
        expected_revision: &str,
        question: &DraftQuestion,
        job_id: &str,
    ) -> Result<(), AppError> {
        let current = load_canonical_row(conn, exam_id, question_id)?
            .ok_or_else(|| AppError::not_found("待替换的正式题目不存在"))?;
        if current.deleted {
            return Err(conflict(
                "待替换的正式题目已删除；请显式恢复原题而不是重建身份",
            ));
        }
        if canonical_revision(&current) != expected_revision {
            return Err(conflict("题目版本已变化，请重新载入后再替换"));
        }
        validate_reparse_question(conn, question)?;

        let content = expected_content(question);
        let options_json = question
            .options
            .as_ref()
            .map(|options| serde_json::to_string(options))
            .transpose()
            .map_err(storage)?;
        let tags_json = serde_json::to_string(&question.tags).map_err(storage)?;
        let structured_json = question
            .structured_data
            .as_ref()
            .filter(|v| !v.is_null())
            .map(|v| v.to_string());
        let images_json = if question.images.is_empty() {
            None
        } else {
            Some(serde_json::to_string(&question.images).map_err(storage)?)
        };
        let stamp = now();
        let marker = json!({
            "reparse": {
                "job_id": job_id,
                "local_id": question.local_id,
                "applied_at": stamp,
                "action": "replace_existing",
                "previous_revision": expected_revision,
            }
        });
        let changed = conn
            .execute(
                "UPDATE questions SET content=?1, options_json=?2, answer=?3, explanation=?4, question_type=?5, difficulty=?6, tags=?7, structured_data=?8, images_json=COALESCE(?9,images_json), updated_at=?10, sync_status=CASE WHEN sync_status='synced' THEN 'modified' ELSE sync_status END, provenance_json=json_patch(COALESCE(provenance_json,'{}'), json(?11)) WHERE id=?12 AND exam_id=?13 AND deleted_at IS NULL AND updated_at=?14",
                params![
                    content,
                    options_json,
                    question.answer,
                    question.explanation,
                    question.question_type,
                    question.difficulty,
                    tags_json,
                    structured_json,
                    images_json,
                    stamp,
                    marker.to_string(),
                    question_id,
                    exam_id,
                    current.updated_at,
                ],
            )
            .map_err(storage)?;
        if changed != 1 {
            return Err(conflict("题目已被其他操作修改，未覆盖任何历史内容"));
        }
        Ok(())
    }
}

fn supports_standalone_import(question: &DraftQuestion) -> bool {
    question.group_id.is_none()
        && question.parent_local_id.is_none()
        && question.parent_id.is_none()
}

fn restrict_reparse_actions(item: &mut ReparseItem, question: &DraftQuestion, resolved: bool) {
    if resolved {
        item.allowed_actions.clear();
        item.reason = Some("该草稿已完成复核；原决策重试只返回已保存结果，不会再次导入".into());
    } else if !supports_standalone_import(question) {
        item.allowed_actions
            .retain(|action| action != "import_as_new");
    }
}

fn normalize_reparse_decisions(
    document: &QuestionDocument,
    decisions: &[ReparseDecision],
) -> Result<Vec<ReparseDecision>, AppError> {
    let mut normalized: std::collections::BTreeMap<String, ReparseDecision> = document
        .questions
        .iter()
        .map(|question| {
            (
                question.local_id.clone(),
                ReparseDecision {
                    local_id: question.local_id.clone(),
                    action: "keep_existing".into(),
                    expected_revision: None,
                },
            )
        })
        .collect();
    let mut seen = HashSet::new();
    for decision in decisions {
        if !seen.insert(decision.local_id.as_str()) {
            return Err(AppError::validation("同一草稿题目不能重复决策"));
        }
        let item = normalized.get_mut(&decision.local_id).ok_or_else(|| {
            AppError::validation(format!("草稿题目不存在: {}", decision.local_id))
        })?;
        if !matches!(
            decision.action.as_str(),
            "keep_existing" | "import_as_new" | "replace_existing"
        ) {
            return Err(AppError::validation(format!(
                "未知操作: {}",
                decision.action
            )));
        }
        if decision.action == "replace_existing"
            && decision
                .expected_revision
                .as_deref()
                .is_none_or(str::is_empty)
        {
            return Err(AppError::validation("替换操作必须携带 expected_revision"));
        }
        *item = ReparseDecision {
            local_id: decision.local_id.clone(),
            action: decision.action.clone(),
            expected_revision: if decision.action == "replace_existing" {
                decision.expected_revision.clone()
            } else {
                None
            },
        };
    }
    Ok(normalized.into_values().collect())
}

fn validate_reparse_question(conn: &Connection, question: &DraftQuestion) -> Result<(), AppError> {
    let mut standalone = question.clone();
    standalone.group_id = None;
    standalone.parent_id = None;
    standalone.parent_local_id = None;
    QuestionDocument {
        schema_version: 2,
        mode: "extract".into(),
        questions: vec![standalone],
        ..Default::default()
    }
    .validate()
    .map_err(|e| AppError::validation(format!("复核内容无效: {}", e.message)))?;
    for image in &question.images {
        let valid: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM files f JOIN blobs b ON b.hash=f.blob_hash WHERE f.id=?1 AND f.blob_hash=?2 AND f.deleted_at IS NULL)",
            params![image.id, image.hash],
            |row| row.get(0),
        ).map_err(storage)?;
        if !valid {
            return Err(AppError::validation(format!(
                "复核题目图片不可用: {}",
                image.name
            )));
        }
    }
    Ok(())
}

fn preview_card_identity(card: &Value) -> Option<String> {
    let card_id = card["card_id"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let id = card["id"].as_str().map(str::trim).filter(|s| !s.is_empty());
    match (card_id, id) {
        (Some(a), Some(b)) if a != b => None,
        (Some(a), _) => Some(a.to_string()),
        (None, Some(b)) => Some(b.to_string()),
        _ => None,
    }
}

fn preview_card_text(card: &Value) -> String {
    for key in ["ocr_text", "content", "text"] {
        if let Some(text) = card[key].as_str() {
            return text.to_string();
        }
    }
    String::new()
}

fn load_formal_rows(conn: &Connection, exam_id: &str) -> Result<Vec<FormalRow>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT id,card_id,deleted_at,updated_at,source_key FROM questions WHERE exam_id=?1",
        )
        .map_err(storage)?;
    let rows = stmt
        .query_map([exam_id], |row| {
            Ok(FormalRow {
                id: row.get(0)?,
                card_id: row.get(1)?,
                deleted: row.get::<_, Option<String>>(2)?.is_some(),
                updated_at: row.get(3)?,
                source_key: row.get(4)?,
            })
        })
        .map_err(storage)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage)?;
    Ok(rows)
}

fn load_canonical_rows(conn: &Connection, exam_id: &str) -> Result<Vec<CanonicalRow>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT id,card_id,question_label,content,options_json,answer,explanation,structured_data,question_type,difficulty,tags,images_json,source_key,deleted_at,updated_at,group_id,parent_id,provenance_json FROM questions WHERE exam_id=?1",
        )
        .map_err(storage)?;
    let rows = stmt
        .query_map([exam_id], |row| {
            let parse_json = |index: usize| -> Result<Option<Value>, rusqlite::Error> {
                Ok(row
                    .get::<_, Option<String>>(index)?
                    .and_then(|text| serde_json::from_str(&text).ok()))
            };
            Ok(CanonicalRow {
                id: row.get(0)?,
                card_id: row.get(1)?,
                question_label: row.get(2)?,
                content: row.get(3)?,
                options: row
                    .get::<_, Option<String>>(4)?
                    .and_then(|text| serde_json::from_str(&text).ok()),
                answer: row.get(5)?,
                explanation: row.get(6)?,
                structured_data: parse_json(7)?,
                question_type: row.get(8)?,
                difficulty: row.get(9)?,
                tags: row
                    .get::<_, Option<String>>(10)?
                    .and_then(|text| serde_json::from_str(&text).ok())
                    .unwrap_or_default(),
                images: row
                    .get::<_, Option<String>>(11)?
                    .and_then(|text| serde_json::from_str(&text).ok())
                    .unwrap_or_default(),
                source_key: row.get(12)?,
                deleted: row.get::<_, Option<String>>(13)?.is_some(),
                updated_at: row.get(14)?,
                group_id: row.get(15)?,
                parent_id: row.get(16)?,
                provenance_json: row.get(17)?,
            })
        })
        .map_err(storage)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage)?;
    Ok(rows)
}

fn load_canonical_row(
    conn: &Connection,
    exam_id: &str,
    question_id: &str,
) -> Result<Option<CanonicalRow>, AppError> {
    Ok(load_canonical_rows(conn, exam_id)?
        .into_iter()
        .find(|row| row.id == question_id))
}

fn canonical_revision(row: &CanonicalRow) -> String {
    hash_value(&json!({
        "id": row.id,
        "card_id": row.card_id,
        "source_key": row.source_key,
        "group_id": row.group_id,
        "parent_id": row.parent_id,
        "provenance_json": row.provenance_json,
        "content": row.content,
        "options": row.options,
        "answer": row.answer,
        "explanation": row.explanation,
        "structured_data": row.structured_data,
        "question_type": row.question_type,
        "difficulty": row.difficulty,
        "tags": row.tags,
        "images": row.images,
        "updated_at": row.updated_at,
    }))
}

fn expected_content(question: &DraftQuestion) -> String {
    let mut content = question.content.clone();
    if let Some(smiles) = &question.smiles {
        content.push_str(&format!("\n\n```smiles\n{smiles}\n```"));
        if let Some(caption) = &question.smiles_caption {
            content.push_str(&format!("\n{caption}"));
        }
    }
    content
}

fn diff_question(question: &DraftQuestion, row: &CanonicalRow) -> Vec<ReparseFieldChange> {
    let mut changes = Vec::new();
    let mut push = |field: &str, before: Value, after: Value| {
        if before != after {
            changes.push(ReparseFieldChange {
                field: field.to_string(),
                before,
                after,
            });
        }
    };
    push(
        "content",
        json!(row.content),
        json!(expected_content(question)),
    );
    push(
        "options",
        serde_json::to_value(&row.options).unwrap_or(Value::Null),
        serde_json::to_value(&question.options).unwrap_or(Value::Null),
    );
    push("answer", json!(row.answer), json!(question.answer));
    push(
        "explanation",
        json!(row.explanation),
        json!(question.explanation),
    );
    push(
        "structured_data",
        row.structured_data.clone().unwrap_or(Value::Null),
        question.structured_data.clone().unwrap_or(Value::Null),
    );
    push(
        "question_type",
        json!(row.question_type),
        json!(question.question_type),
    );
    push(
        "difficulty",
        json!(row.difficulty),
        json!(question.difficulty),
    );
    push("tags", json!(row.tags), json!(question.tags));
    changes
}

fn draft_source_slot(
    conn: &Connection,
    exam_id: &str,
    metadata: &Value,
    question: &DraftQuestion,
) -> Result<(Option<String>, Option<String>), AppError> {
    if question.answer_origin.as_deref() == Some("generated") {
        return Ok((
            None,
            Some("草稿题目答案由模型生成，没有可复核来源槽".into()),
        ));
    }
    let sources = metadata["sources"].as_array().cloned().unwrap_or_default();
    if sources.is_empty() || question.source_refs.is_empty() {
        return Ok((None, None));
    }
    if question
        .original_label
        .as_deref()
        .is_none_or(|label| label.trim().is_empty())
    {
        return Ok((None, Some("草稿题目缺少原题号，无法建立稳定来源槽".into())));
    }
    let mut mapping = HashMap::new();
    for source in &sources {
        let Some(local) = source["source_id"].as_str() else {
            continue;
        };
        let Some(key) = source["content_hash"]
            .as_str()
            .or_else(|| source["blob_hash"].as_str())
        else {
            continue;
        };
        let key = format!("{}:{}", key, source["anchor"].as_str().unwrap_or(""));
        if let Some(id) = conn
            .query_row(
                "SELECT id FROM qbank_sources WHERE exam_id=?1 AND source_key=?2 AND deleted_at IS NULL",
                params![exam_id, key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(storage)?
        {
            mapping.insert(local.to_string(), id);
        }
    }
    let mut source_ids = Vec::with_capacity(question.source_refs.len());
    for reference in &question.source_refs {
        let Some(id) = mapping.get(&reference.source_id) else {
            return Ok((
                None,
                Some("草稿来源尚未持久化，无法与正式来源槽比较".into()),
            ));
        };
        source_ids.push((id.clone(), reference.page));
    }
    let slot = hex::encode(Sha256::digest(
        json!([source_ids, question.section_path, question.original_label])
            .to_string()
            .as_bytes(),
    ));
    Ok((Some(slot), None))
}

fn preview_card_to_draft(
    conn: &Connection,
    card: &PreviewCard,
    page: &PreviewPage,
) -> Result<DraftQuestion, AppError> {
    let text = card.text.trim();
    if text.is_empty() {
        return Err(AppError::validation(format!(
            "卡片 {} 的题干为空，不能迁移",
            card.card_id.as_deref().unwrap_or("<unknown>")
        )));
    }
    let raw_type = card.raw["question_type"]
        .as_str()
        .map(str::trim)
        .unwrap_or("other");
    let question_type = if QUESTION_TYPES.contains(&raw_type) {
        raw_type.to_string()
    } else {
        "other".to_string()
    };
    let options = parse_options(&card.raw["options"]);
    let difficulty = card.raw["difficulty"]
        .as_str()
        .map(str::trim)
        .filter(|d| matches!(*d, "easy" | "medium" | "hard" | "very_hard"))
        .map(ToOwned::to_owned);
    let tags = card.raw["tags"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    let structured_data = card.raw["structured_data"]
        .as_object()
        .map(|_| card.raw["structured_data"].clone());
    let section_path = card.raw["section_path"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    let images = usable_images(conn, &card.raw["images"])?;
    let local_id = format!("legacy:{}", card.card_id.as_deref().unwrap_or("card"));
    Ok(DraftQuestion {
        local_id,
        group_id: None,
        original_label: card.question_label.clone(),
        section_path,
        content: text.to_string(),
        question_type,
        options,
        answer: card.raw["answer"].as_str().map(ToOwned::to_owned),
        explanation: card.raw["explanation"].as_str().map(ToOwned::to_owned),
        structured_data,
        difficulty,
        tags,
        source_refs: Vec::new(),
        answer_source_refs: Vec::new(),
        figures: Vec::new(),
        images,
        answer_origin: None,
        smiles: None,
        smiles_caption: None,
        parent_id: None,
        parent_local_id: None,
        source_ref: None,
    })
}

fn parse_options(value: &Value) -> Option<Vec<QuestionOption>> {
    let array = value.as_array()?;
    if array.is_empty() {
        return None;
    }
    array
        .iter()
        .map(|option| {
            Some(QuestionOption {
                key: option["key"].as_str()?.to_string(),
                content: option["content"].as_str()?.to_string(),
            })
        })
        .collect()
}

fn usable_images(conn: &Connection, value: &Value) -> Result<Vec<QuestionImage>, AppError> {
    let mut images = Vec::new();
    for raw in value.as_array().into_iter().flatten() {
        let Ok(image) = serde_json::from_value::<QuestionImage>(raw.clone()) else {
            continue;
        };
        let valid: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM files f JOIN blobs b ON b.hash=f.blob_hash WHERE f.id=?1 AND f.blob_hash=?2 AND f.deleted_at IS NULL)",
                params![image.id, image.hash],
                |row| row.get(0),
            )
            .map_err(storage)?;
        if valid {
            images.push(image);
        }
    }
    Ok(images)
}

fn merge_preview_union(original: &Value, projected: &Value) -> Value {
    let mut merged = original.clone();
    if !merged["pages"].is_array() {
        merged["pages"] = json!([]);
    }
    for page in merged["pages"].as_array_mut().unwrap() {
        if !page["cards"].is_array() {
            page["cards"] = json!([]);
        }
    }
    let mut known_cards: HashSet<String> = merged["pages"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|page| page["cards"].as_array().into_iter().flatten())
        .filter_map(|card| card["card_id"].as_str())
        .map(ToOwned::to_owned)
        .collect();
    for projected_page in projected["pages"].as_array().into_iter().flatten() {
        let blob = projected_page["blob_hash"].as_str();
        let page_index = projected_page["page_index"].as_i64().unwrap_or(0);
        let target = merged["pages"].as_array().unwrap().iter().position(|page| {
            blob.is_some_and(|hash| page["blob_hash"].as_str() == Some(hash))
                || page["page_index"].as_i64() == Some(page_index)
        });
        let target = match target {
            Some(index) => index,
            None => {
                merged["pages"]
                    .as_array_mut()
                    .unwrap()
                    .push(projected_page.clone());
                merged["pages"].as_array().unwrap().len() - 1
            }
        };
        if !merged["pages"][target]["cards"].is_array() {
            merged["pages"][target]["cards"] = json!([]);
        }
        for card in projected_page["cards"].as_array().into_iter().flatten() {
            if let Some(card_id) = card["card_id"].as_str() {
                if !known_cards.insert(card_id.to_string()) {
                    continue;
                }
            }
            merged["pages"][target]["cards"]
                .as_array_mut()
                .unwrap()
                .push(card.clone());
        }
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vfs::repos::{CreateQuestionParams, QuestionType, SourceType};
    use crate::vfs::types::VfsCreateExamSheetParams;
    use tempfile::TempDir;

    fn setup(preview: Value, metadata: Value) -> (TempDir, Arc<VfsDatabase>, String) {
        let (temp, db) = crate::vfs::database::setup_migrated_test_db();
        let db = Arc::new(db);
        let exam = VfsExamRepo::create_exam_sheet(
            &db,
            VfsCreateExamSheetParams {
                exam_name: Some("legacy audit".into()),
                temp_id: "tmp_legacy".into(),
                metadata_json: metadata,
                preview_json: preview,
                status: "completed".into(),
                folder_id: None,
            },
        )
        .unwrap();
        (temp, db, exam.id)
    }

    fn preview_with(cards: Vec<Value>) -> Value {
        json!({
            "pages": [{
                "page_index": 0,
                "blob_hash": "page-blob-1",
                "original_image_path": "/tmp/original-page-1.png",
                "width": 1000,
                "height": 1400,
                "cards": cards,
            }]
        })
    }

    fn card(card_id: &str, text: &str, extra: Value) -> Value {
        let mut value = json!({
            "card_id": card_id,
            "question_label": card_id,
            "ocr_text": text,
            "question_type": "short_answer",
        });
        if let (Some(target), Some(extra)) = (value.as_object_mut(), extra.as_object()) {
            for (key, item) in extra {
                target.insert(key.clone(), item.clone());
            }
        }
        value
    }

    fn question_params(exam_id: &str, card_id: &str, content: &str) -> CreateQuestionParams {
        CreateQuestionParams {
            exam_id: exam_id.to_string(),
            card_id: Some(card_id.to_string()),
            question_label: Some(card_id.to_string()),
            content: content.to_string(),
            options: None,
            answer: None,
            explanation: None,
            structured_data: None,
            question_type: Some(QuestionType::ShortAnswer),
            difficulty: None,
            tags: None,
            source_type: Some(SourceType::Imported),
            source_ref: None,
            images: None,
            parent_id: None,
        }
    }

    fn set_canonical_marker(db: &VfsDatabase, exam_id: &str) {
        let conn = db.get_conn_safe().unwrap();
        conn.execute(
            "UPDATE exam_sheets SET metadata_json=json_set(COALESCE(metadata_json,'{}'),'$.question_document_version',2) WHERE id=?1",
            [exam_id],
        )
        .unwrap();
    }

    fn error_message(error: AppError) -> String {
        format!("{:?}: {}", error.error_type, error.message)
    }

    #[test]
    fn all_deleted_canonical_marker_never_recreates_preview_cards() {
        let preview = preview_with(vec![card("c1", "legacy question", json!({}))]);
        let (_temp, db, exam) = setup(preview, json!({}));
        let created =
            VfsQuestionRepo::create_question(&db, &question_params(&exam, "c1", "formal question"))
                .unwrap();
        VfsQuestionRepo::delete_question(&db, &created.id).unwrap();
        set_canonical_marker(&db, &exam);

        let service = LegacyReconcileService::new(db.clone());
        let audit = service.audit_legacy_cards(&exam).unwrap();
        assert!(audit.canonical_marker);
        assert_eq!(audit.canonical_question_count, 0);
        assert!(audit.migratable_card_ids.is_empty());
        assert_eq!(audit.cards.len(), 1);
        assert_eq!(audit.cards[0].status, "suppressed_canonical");
        assert_eq!(
            audit.cards[0].deleted_question_ids,
            vec![created.id.clone()]
        );
        // Original page image evidence is still reported.
        assert_eq!(audit.pages[0].blob_hash.as_deref(), Some("page-blob-1"));
        assert_eq!(
            audit.pages[0].original_image_path,
            "/tmp/original-page-1.png"
        );

        let error = service
            .migrate_legacy_cards(&exam, &["c1".into()], &audit.audit_version)
            .unwrap_err();
        assert!(error_message(error).contains("不可迁移"));
        assert_eq!(VfsQuestionRepo::count_questions(&db, &exam).unwrap(), 0);
        let conn = db.get_conn_safe().unwrap();
        let deleted: i64 = conn
            .query_row(
                "SELECT count(*) FROM questions WHERE id=?1 AND deleted_at IS NOT NULL",
                [&created.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(deleted, 1, "deleted row must remain deleted, not recreated");
    }

    #[test]
    fn more_than_one_hundred_cards_are_all_reported_without_truncation() {
        let cards = (0..150)
            .map(|index| {
                card(
                    &format!("card-{index}"),
                    &format!("legacy question {index}"),
                    json!({}),
                )
            })
            .collect();
        let (_temp, db, exam) = setup(preview_with(cards), json!({}));
        let audit = LegacyReconcileService::new(db)
            .audit_legacy_cards(&exam)
            .unwrap();
        assert_eq!(audit.cards.len(), 150);
        assert_eq!(audit.migratable_card_ids.len(), 150);
        assert_eq!(audit.unmatched_count, 150);
        assert_eq!(audit.pages[0].card_count, 150);
    }

    #[test]
    fn mapping_uses_card_id_or_id_never_label_or_content() {
        let preview = preview_with(vec![card(
            "legacy-c1",
            "same question text",
            json!({"question_label": "Q1"}),
        )]);
        let (_temp, db, exam) = setup(preview, json!({}));
        VfsQuestionRepo::create_question(
            &db,
            &CreateQuestionParams {
                question_label: Some("Q1".into()),
                content: "same question text".into(),
                ..question_params(&exam, "different-card", "same question text")
            },
        )
        .unwrap();
        let audit = LegacyReconcileService::new(db)
            .audit_legacy_cards(&exam)
            .unwrap();
        assert_eq!(audit.cards[0].status, "unmatched");
        assert!(audit.cards[0].formal_question_id.is_none());
        assert_eq!(audit.migratable_card_ids, vec!["legacy-c1".to_string()]);
    }

    #[test]
    fn stale_audit_version_is_rejected_before_any_question_is_created() {
        let preview = preview_with(vec![
            card("c1", "legacy one", json!({})),
            card("c2", "legacy two", json!({})),
        ]);
        let (_temp, db, exam) = setup(preview, json!({}));
        let service = LegacyReconcileService::new(db.clone());
        let stale = service.audit_legacy_cards(&exam).unwrap();
        VfsQuestionRepo::create_question(&db, &question_params(&exam, "c2", "formal two")).unwrap();

        let error = service
            .migrate_legacy_cards(&exam, &["c1".into()], &stale.audit_version)
            .unwrap_err();
        assert!(error_message(error).contains("审计已变化"));
        assert_eq!(VfsQuestionRepo::count_questions(&db, &exam).unwrap(), 1);
    }

    #[test]
    fn selected_migration_is_idempotent_and_preserves_page_assets() {
        let preview = preview_with(vec![
            card("c1", "legacy one", json!({})),
            card("c2", "legacy two", json!({})),
        ]);
        let (_temp, db, exam) = setup(preview, json!({}));
        let service = LegacyReconcileService::new(db.clone());
        let audit = service.audit_legacy_cards(&exam).unwrap();
        let first = service
            .migrate_legacy_cards(&exam, &["c1".into()], &audit.audit_version)
            .unwrap();
        assert!(first.committed);
        assert!(!first.idempotent);
        assert_eq!(first.question_ids.len(), 1);
        assert_eq!(VfsQuestionRepo::count_questions(&db, &exam).unwrap(), 1);

        let second = service
            .migrate_legacy_cards(&exam, &["c1".into()], &audit.audit_version)
            .unwrap();
        assert!(second.idempotent);
        assert_eq!(second.question_ids, first.question_ids);
        assert_eq!(VfsQuestionRepo::count_questions(&db, &exam).unwrap(), 1);

        let sheet = VfsExamRepo::get_exam_sheet(&db, &exam).unwrap().unwrap();
        let page = &sheet.preview_json["pages"][0];
        assert_eq!(page["blob_hash"], "page-blob-1");
        assert_eq!(page["original_image_path"], "/tmp/original-page-1.png");
        assert_eq!(page["cards"].as_array().unwrap().len(), 2);
        let card_ids: HashSet<_> = page["cards"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|card| card["card_id"].as_str())
            .collect();
        assert!(card_ids.contains("c1"));
        assert!(card_ids.contains("c2"));

        let conn = db.get_conn_safe().unwrap();
        let marker: Option<String> = conn
            .query_row(
                "SELECT json_extract(provenance_json,'$.legacy_migration.card_id') FROM questions WHERE id=?1",
                [&first.question_ids[0]],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(marker.as_deref(), Some("c1"));
        let card_id: Option<String> = conn
            .query_row(
                "SELECT card_id FROM questions WHERE id=?1",
                [&first.question_ids[0]],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(card_id.as_deref(), Some("c1"));
    }

    #[test]
    fn commit_failure_rolls_back_every_question_and_keeps_preview_evidence() {
        let preview = preview_with(vec![
            card("c1", "rollback-first", json!({})),
            card("c2", "rollback-second", json!({})),
        ]);
        let (_temp, db, exam) = setup(preview, json!({}));
        let conn = db.get_conn_safe().unwrap();
        conn.execute_batch(
            "CREATE TRIGGER fail_second BEFORE INSERT ON questions
             WHEN NEW.content='rollback-second'
             BEGIN SELECT RAISE(ABORT,'rollback test'); END;",
        )
        .unwrap();
        drop(conn);

        let service = LegacyReconcileService::new(db.clone());
        let audit = service.audit_legacy_cards(&exam).unwrap();
        let error = service
            .migrate_legacy_cards(&exam, &["c1".into(), "c2".into()], &audit.audit_version)
            .unwrap_err();
        assert!(error.message.contains("rollback test") || error.message.contains("约束"));
        assert_eq!(VfsQuestionRepo::count_questions(&db, &exam).unwrap(), 0);
        let sheet = VfsExamRepo::get_exam_sheet(&db, &exam).unwrap().unwrap();
        assert_eq!(
            sheet.preview_json["pages"][0]["cards"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            sheet.preview_json["pages"][0]["original_image_path"],
            "/tmp/original-page-1.png"
        );
    }

    fn reparse_fixture() -> (TempDir, Arc<VfsDatabase>, String, String, String) {
        let (_temp, db, exam) = setup(json!({"pages": []}), json!({}));
        let service = QuestionAuthoringService::new(db.clone());
        let document: QuestionDocument = serde_json::from_value(json!({
            "schema_version": 2,
            "mode": "extract",
            "questions": [{
                "local_id": "q1",
                "original_label": "1",
                "content": "draft content",
                "question_type": "short_answer",
                "source_refs": [{
                    "source_id": "src1",
                    "page": 1,
                    "bbox": [0.1, 0.1, 0.9, 0.9]
                }]
            }]
        }))
        .unwrap();
        let metadata = json!({
            "sources": [{
                "source_id": "src1",
                "blob_hash": "source-blob-1",
                "pages": []
            }],
            "pages": [{
                "source_id": "src1",
                "page": 1,
                "blob_hash": "source-blob-1",
                "width": 1000,
                "height": 1400
            }]
        });
        let job = service.save_draft(&exam, &document, &metadata).unwrap();
        let draft = service.get_draft(&job).unwrap();
        let receipt = service
            .commit_draft(&job, &["q1".into()], draft.version)
            .unwrap();
        (_temp, db, exam, job, receipt.question_ids[0].clone())
    }

    fn pending_reparse_fixture(
        grouped_second: bool,
    ) -> (TempDir, Arc<VfsDatabase>, String, String, Vec<String>) {
        let (temp, db, exam, seed_job, first_id) = reparse_fixture();
        let authoring = QuestionAuthoringService::new(db.clone());
        let seed = authoring.get_draft(&seed_job).unwrap();
        let mut second = seed.document.questions[0].clone();
        second.local_id = "q2".into();
        second.original_label = Some("2".into());
        second.content = "draft two".into();
        let second_job = authoring
            .save_draft(
                &exam,
                &QuestionDocument {
                    questions: vec![second.clone()],
                    ..Default::default()
                },
                &seed.metadata,
            )
            .unwrap();
        let second_receipt = authoring
            .commit_draft(&second_job, &["q2".into()], 1)
            .unwrap();
        let second_id = second_receipt.question_ids[0].clone();
        let mut document = seed.document;
        if grouped_second {
            second.group_id = Some("g1".into());
            document.groups.push(crate::qbank_document::DraftGroup {
                local_id: "g1".into(),
                label: "group".into(),
                material_ids: vec![],
                question_ids: vec!["q2".into()],
            });
        }
        document.questions.push(second);
        let pending = authoring
            .save_draft(&exam, &document, &seed.metadata)
            .unwrap();
        let conn = db.get_conn_safe().unwrap();
        conn.execute(
            "UPDATE questions SET content='edited one',updated_at='2030-01-01' WHERE id=?1",
            [&first_id],
        )
        .unwrap();
        conn.execute(
            "UPDATE questions SET content='edited two',updated_at='2030-01-02' WHERE id=?1",
            [&second_id],
        )
        .unwrap();
        conn.execute(
            "UPDATE exam_sheets SET import_state_json=?1 WHERE id=?2",
            params![
                json!({"schema_version":2,"job_id":pending}).to_string(),
                exam
            ],
        )
        .unwrap();
        drop(conn);
        (temp, db, exam, pending, vec![first_id, second_id])
    }

    fn reconcile_snapshot(db: &VfsDatabase, exam: &str) -> Value {
        let conn = db.get_conn_safe().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id,content,updated_at,provenance_json,card_id,source_key FROM questions WHERE exam_id=?1 ORDER BY id",
        ).unwrap();
        let questions = stmt
            .query_map([exam], |r| {
                Ok(json!([
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<String>>(5)?
                ]))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let mut stmt = conn.prepare(
            "SELECT id,status,version,document_json,metadata_json,receipt_json,selected_json FROM qbank_import_jobs WHERE exam_id=?1 ORDER BY id",
        ).unwrap();
        let jobs = stmt
            .query_map([exam], |r| {
                Ok(json!([
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, Option<String>>(6)?
                ]))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let sheet: Value = conn.query_row(
            "SELECT preview_json,metadata_json,import_state_json,updated_at FROM exam_sheets WHERE id=?1", [exam],
            |r| Ok(json!([r.get::<_,Option<String>>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,String>(3)?])),
        ).unwrap();
        json!({"questions":questions,"jobs":jobs,"sheet":sheet})
    }

    fn reparse_decision(report: &ReparseReport, local_id: &str, action: &str) -> ReparseDecision {
        ReparseDecision {
            local_id: local_id.into(),
            action: action.into(),
            expected_revision: if action == "replace_existing" {
                report
                    .items
                    .iter()
                    .find(|item| item.local_id == local_id)
                    .unwrap()
                    .canonical_revision
                    .clone()
            } else {
                None
            },
        }
    }

    #[test]
    fn reparse_late_import_failure_rolls_back_earlier_replacement() {
        let (_temp, db, exam, job, _) = pending_reparse_fixture(false);
        let conn = db.get_conn_safe().unwrap();
        conn.execute_batch("CREATE TRIGGER fail_reparse_import BEFORE INSERT ON questions WHEN NEW.content='draft two' BEGIN SELECT RAISE(ABORT,'late reparse import'); END;").unwrap();
        drop(conn);
        let service = LegacyReconcileService::new(db.clone());
        let report = service.reparse_report(&exam, Some(&job)).unwrap();
        let before = reconcile_snapshot(&db, &exam);
        let error = service
            .resolve_reparse(
                &exam,
                &job,
                &[
                    reparse_decision(&report, "q1", "replace_existing"),
                    reparse_decision(&report, "q2", "import_as_new"),
                ],
                &report.report_version,
            )
            .unwrap_err();
        assert!(error.message.contains("late reparse import"));
        assert_eq!(reconcile_snapshot(&db, &exam), before);
    }

    #[test]
    fn reparse_late_occ_failure_rolls_back_earlier_import() {
        let (_temp, db, exam, job, ids) = pending_reparse_fixture(false);
        let conn = db.get_conn_safe().unwrap();
        conn.execute_batch(&format!(
            "CREATE TRIGGER change_later_question AFTER INSERT ON questions WHEN NEW.content='draft content' BEGIN UPDATE questions SET content='raced',updated_at='2040-01-01' WHERE id='{}'; END;", ids[1]
        )).unwrap();
        drop(conn);
        let service = LegacyReconcileService::new(db.clone());
        let report = service.reparse_report(&exam, Some(&job)).unwrap();
        let before = reconcile_snapshot(&db, &exam);
        let error = service
            .resolve_reparse(
                &exam,
                &job,
                &[
                    reparse_decision(&report, "q1", "import_as_new"),
                    reparse_decision(&report, "q2", "replace_existing"),
                ],
                &report.report_version,
            )
            .unwrap_err();
        assert!(error.message.contains("版本已变化"));
        assert_eq!(reconcile_snapshot(&db, &exam), before);
    }

    #[test]
    fn reparse_receipt_failure_rolls_back_questions_and_child_drafts() {
        let (_temp, db, exam, job, _) = pending_reparse_fixture(false);
        let conn = db.get_conn_safe().unwrap();
        conn.execute_batch("CREATE TRIGGER fail_reparse_receipt BEFORE UPDATE ON qbank_import_jobs WHEN json_type(NEW.metadata_json,'$.reparse_resolution')='object' BEGIN SELECT RAISE(ABORT,'receipt write failed'); END;").unwrap();
        drop(conn);
        let service = LegacyReconcileService::new(db.clone());
        let report = service.reparse_report(&exam, Some(&job)).unwrap();
        let before = reconcile_snapshot(&db, &exam);
        let error = service
            .resolve_reparse(
                &exam,
                &job,
                &[
                    reparse_decision(&report, "q1", "import_as_new"),
                    reparse_decision(&report, "q2", "replace_existing"),
                ],
                &report.report_version,
            )
            .unwrap_err();
        assert!(error.message.contains("receipt write failed"));
        assert_eq!(reconcile_snapshot(&db, &exam), before);
    }

    #[test]
    fn reparse_does_not_offer_group_import_and_prevalidates_all_decisions() {
        let (_temp, db, exam, job, _) = pending_reparse_fixture(true);
        let service = LegacyReconcileService::new(db.clone());
        let report = service.reparse_report(&exam, Some(&job)).unwrap();
        let second = report
            .items
            .iter()
            .find(|item| item.local_id == "q2")
            .unwrap();
        assert!(!second
            .allowed_actions
            .iter()
            .any(|action| action == "import_as_new"));
        let before = reconcile_snapshot(&db, &exam);
        assert!(service
            .resolve_reparse(
                &exam,
                &job,
                &[
                    reparse_decision(&report, "q1", "replace_existing"),
                    reparse_decision(&report, "q2", "import_as_new"),
                ],
                &report.report_version
            )
            .is_err());
        assert_eq!(reconcile_snapshot(&db, &exam), before);
    }

    #[test]
    fn reparse_keep_is_terminal_and_normalized_retry_survives_fresh_reports() {
        let (_temp, db, exam, job, ids) = pending_reparse_fixture(false);
        let service = LegacyReconcileService::new(db.clone());
        let report = service.reparse_report(&exam, Some(&job)).unwrap();
        let receipt = service
            .resolve_reparse(&exam, &job, &[], &report.report_version)
            .unwrap();
        assert_eq!(
            receipt.kept_local_ids,
            vec!["q1".to_string(), "q2".to_string()]
        );
        let authoring = QuestionAuthoringService::new(db.clone());
        let saved = authoring.get_draft(&job).unwrap();
        assert_eq!(saved.status, "cancelled");
        assert_eq!(saved.version, report.job_version + 1);
        assert!(saved.metadata.get("reparse_resolution").is_some());
        assert!(!authoring
            .list_drafts(&exam)
            .unwrap()
            .iter()
            .any(|draft| draft.job_id == job));
        assert!(authoring
            .commit_draft(&job, &["q1".into()], saved.version)
            .is_err());
        let conn = db.get_conn_safe().unwrap();
        conn.execute(
            "UPDATE questions SET content='later user edit' WHERE id=?1",
            [&ids[0]],
        )
        .unwrap();
        drop(conn);
        let fresh = service.reparse_report(&exam, Some(&job)).unwrap();
        let before = reconcile_snapshot(&db, &exam);
        let retry = service
            .resolve_reparse(
                &exam,
                &job,
                &[
                    reparse_decision(&fresh, "q2", "keep_existing"),
                    reparse_decision(&fresh, "q1", "keep_existing"),
                ],
                &fresh.report_version,
            )
            .unwrap();
        assert_eq!(
            serde_json::to_value(retry).unwrap(),
            serde_json::to_value(receipt).unwrap()
        );
        assert_eq!(reconcile_snapshot(&db, &exam), before);
        assert!(service
            .resolve_reparse(
                &exam,
                &job,
                &[reparse_decision(&fresh, "q1", "import_as_new"),],
                &fresh.report_version
            )
            .is_err());
        assert_eq!(reconcile_snapshot(&db, &exam), before);
    }

    #[test]
    fn mixed_reparse_resolution_rejects_stale_report_and_persists_retry_receipt() {
        let (_temp, db, exam, job, ids) = pending_reparse_fixture(false);
        let service = LegacyReconcileService::new(db.clone());
        let stale = service.reparse_report(&exam, Some(&job)).unwrap();
        let conn = db.get_conn_safe().unwrap();
        conn.execute(
            "UPDATE questions SET content='new user edit',updated_at='2031-01-01' WHERE id=?1",
            [&ids[1]],
        )
        .unwrap();
        drop(conn);
        let before = reconcile_snapshot(&db, &exam);
        let error = service
            .resolve_reparse(
                &exam,
                &job,
                &[
                    reparse_decision(&stale, "q1", "import_as_new"),
                    reparse_decision(&stale, "q2", "replace_existing"),
                ],
                &stale.report_version,
            )
            .unwrap_err();
        assert!(error.message.contains("报告已变化"));
        assert_eq!(reconcile_snapshot(&db, &exam), before);

        let report = service.reparse_report(&exam, Some(&job)).unwrap();
        let decisions = vec![
            reparse_decision(&report, "q1", "import_as_new"),
            reparse_decision(&report, "q2", "replace_existing"),
        ];
        let receipt = service
            .resolve_reparse(&exam, &job, &decisions, &report.report_version)
            .unwrap();
        assert_eq!(receipt.imported_question_ids.len(), 1);
        assert_eq!(receipt.replaced_question_ids, vec![ids[1].clone()]);
        let conn = db.get_conn_safe().unwrap();
        let content: String = conn
            .query_row(
                "SELECT content FROM questions WHERE id=?1",
                [&ids[1]],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(content, "draft two");
        let slot: Option<String> = conn
            .query_row(
                "SELECT source_key FROM questions WHERE id=?1",
                [&receipt.imported_question_ids[0]],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            slot.is_none(),
            "import-as-new must not steal the existing source slot"
        );
        let checkpoint: Option<String> = conn
            .query_row(
                "SELECT import_state_json FROM exam_sheets WHERE id=?1",
                [&exam],
                |row| row.get(0),
            )
            .unwrap();
        assert!(checkpoint.is_none());
        drop(conn);
        assert_eq!(VfsQuestionRepo::count_questions(&db, &exam).unwrap(), 3);
        let authoring = QuestionAuthoringService::new(db.clone());
        assert_eq!(authoring.get_draft(&job).unwrap().status, "cancelled");
        assert!(!authoring
            .list_drafts(&exam)
            .unwrap()
            .iter()
            .any(|draft| draft.job_id == job));
        let resumed = LegacyReconcileService::new(db.clone());
        let fresh = resumed.reparse_report(&exam, None).unwrap();
        assert_eq!(fresh.job_id, job);
        assert!(fresh.resolved);
        let before_retry = reconcile_snapshot(&db, &exam);
        let mut reverse = decisions;
        reverse.reverse();
        let retry = resumed
            .resolve_reparse(&exam, &job, &reverse, &fresh.report_version)
            .unwrap();
        assert_eq!(
            serde_json::to_value(retry).unwrap(),
            serde_json::to_value(receipt).unwrap()
        );
        assert_eq!(reconcile_snapshot(&db, &exam), before_retry);
    }

    #[test]
    fn reparse_replacement_preserves_identity_history_and_is_idempotent() {
        let (_temp, db, exam, job, question_id) = reparse_fixture();
        let conn = db.get_conn_safe().unwrap();
        let card_id_before: Option<String> = conn
            .query_row(
                "SELECT card_id FROM questions WHERE id=?1",
                [&question_id],
                |row| row.get(0),
            )
            .unwrap();
        conn.execute(
            "UPDATE questions SET content='edited canonical', updated_at='2030-01-01T00:00:00Z' WHERE id=?1",
            [&question_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO answer_submissions(id,question_id,user_answer,grading_method,submitted_at) VALUES('sub-1',?1,'old answer','auto','2029-12-31T00:00:00Z')",
            [&question_id],
        )
        .unwrap();
        drop(conn);

        let service = LegacyReconcileService::new(db.clone());
        let report = service.reparse_report(&exam, Some(&job)).unwrap();
        assert_eq!(report.items.len(), 1);
        assert_eq!(report.items[0].status, "changed");
        assert_eq!(
            report.items[0].canonical_question_id.as_deref(),
            Some(question_id.as_str())
        );
        assert!(report.items[0]
            .changes
            .iter()
            .any(|change| change.field == "content"));
        let revision = report.items[0].canonical_revision.clone().unwrap();

        let decision = ReparseDecision {
            local_id: "q1".into(),
            action: "replace_existing".into(),
            expected_revision: Some(revision),
        };
        let replaced = service
            .resolve_reparse(
                &exam,
                &job,
                std::slice::from_ref(&decision),
                &report.report_version,
            )
            .unwrap();
        assert_eq!(replaced.replaced_question_ids, vec![question_id.clone()]);
        let conn = db.get_conn_safe().unwrap();
        let (content, card_id_after): (String, Option<String>) = conn
            .query_row(
                "SELECT content,card_id FROM questions WHERE id=?1",
                [&question_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(content, "draft content");
        assert_eq!(card_id_after, card_id_before);
        let submissions: i64 = conn
            .query_row(
                "SELECT count(*) FROM answer_submissions WHERE question_id=?1",
                [&question_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(submissions, 1, "replacement must preserve answer history");
        drop(conn);
        assert_eq!(VfsQuestionRepo::count_questions(&db, &exam).unwrap(), 1);

        let before_retry = service.reparse_report(&exam, Some(&job)).unwrap();
        assert!(before_retry.resolved);
        assert!(before_retry.items[0].allowed_actions.is_empty());
        let retry = service
            .resolve_reparse(
                &exam,
                &job,
                std::slice::from_ref(&decision),
                &report.report_version,
            )
            .unwrap();
        assert_eq!(
            serde_json::to_value(retry).unwrap(),
            serde_json::to_value(&replaced).unwrap()
        );
        // A resolved job cannot be changed to a different decision, even using
        // the current report version.
        let error = service
            .resolve_reparse(
                &exam,
                &job,
                &[ReparseDecision {
                    local_id: "q1".into(),
                    action: "keep_existing".into(),
                    expected_revision: None,
                }],
                &before_retry.report_version,
            )
            .unwrap_err();
        assert!(error_message(error).contains("已完成复核"));
    }

    #[test]
    fn reparse_import_as_new_keeps_existing_question_and_identity() {
        let (_temp, db, exam, job, question_id) = reparse_fixture();
        let conn = db.get_conn_safe().unwrap();
        conn.execute(
            "UPDATE questions SET content='edited canonical', updated_at='2030-02-02T00:00:00Z' WHERE id=?1",
            [&question_id],
        )
        .unwrap();
        drop(conn);
        let service = LegacyReconcileService::new(db.clone());
        let report = service.reparse_report(&exam, Some(&job)).unwrap();
        let resolved = service
            .resolve_reparse(
                &exam,
                &job,
                &[ReparseDecision {
                    local_id: "q1".into(),
                    action: "import_as_new".into(),
                    expected_revision: None,
                }],
                &report.report_version,
            )
            .unwrap();
        assert_eq!(resolved.imported_question_ids.len(), 1);
        assert_ne!(resolved.imported_question_ids[0], question_id);
        assert_eq!(VfsQuestionRepo::count_questions(&db, &exam).unwrap(), 2);
        let conn = db.get_conn_safe().unwrap();
        let content: String = conn
            .query_row(
                "SELECT content FROM questions WHERE id=?1",
                [&question_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(content, "edited canonical");
        let original_receipt: String = conn
            .query_row(
                "SELECT receipt_json FROM qbank_import_jobs WHERE id=?1",
                [&job],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!original_receipt.contains(&resolved.imported_question_ids[0]));
        drop(conn);
        let after = service.reparse_report(&exam, Some(&job)).unwrap();
        assert!(after.resolved);
        let retry = service
            .resolve_reparse(
                &exam,
                &job,
                &[ReparseDecision {
                    local_id: "q1".into(),
                    action: "import_as_new".into(),
                    expected_revision: None,
                }],
                &after.report_version,
            )
            .unwrap();
        assert_eq!(retry.imported_question_ids, resolved.imported_question_ids);
        assert_eq!(VfsQuestionRepo::count_questions(&db, &exam).unwrap(), 2);
        assert_eq!(service.reparse_report(&exam, None).unwrap().job_id, job);
    }

    #[test]
    fn reparse_deleted_canonical_never_offers_recreation() {
        let (_temp, db, exam, job, question_id) = reparse_fixture();
        VfsQuestionRepo::delete_question(&db, &question_id).unwrap();
        let service = LegacyReconcileService::new(db.clone());
        let report = service.reparse_report(&exam, Some(&job)).unwrap();
        assert_eq!(report.canonical_question_count, 0);
        assert_eq!(report.items[0].status, "deleted");
        assert_eq!(
            report.items[0].allowed_actions,
            vec!["keep_existing".to_string()]
        );
        let error = service
            .resolve_reparse(
                &exam,
                &job,
                &[ReparseDecision {
                    local_id: "q1".into(),
                    action: "import_as_new".into(),
                    expected_revision: None,
                }],
                &report.report_version,
            )
            .unwrap_err();
        assert!(error_message(error).contains("不允许操作"));
        assert_eq!(VfsQuestionRepo::count_questions(&db, &exam).unwrap(), 0);
    }
}
