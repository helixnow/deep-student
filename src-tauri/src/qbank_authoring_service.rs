//! Canonical draft/commit boundary shared by import, chat and generation.
#[cfg(test)]
#[path = "qbank_authoring_service/tests.rs"]
mod tests;
use crate::models::AppError;
use crate::qbank_document::*;
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::{
    CreateQuestionParams, Difficulty, QuestionImage, QuestionType, SourceType, VfsExamRepo,
    VfsQuestionRepo,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionAuthoringDraft {
    pub job_id: String,
    pub exam_id: String,
    pub document: QuestionDocument,
    pub status: String,
    pub version: i64,
    pub metadata: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionDraftSummary {
    pub job_id: String,
    pub exam_id: String,
    pub status: String,
    pub version: i64,
    pub question_count: usize,
    pub created_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AuthoringCommitReceipt {
    pub committed: bool,
    pub exam_id: String,
    pub question_ids: Vec<String>,
    pub material_ids: Vec<String>,
    pub group_ids: Vec<String>,
    pub imported_count: usize,
    pub total_questions: usize,
    pub partial: bool,
    pub needs_review: bool,
    pub coverage: Vec<Value>,
    pub unmatched_answers: Vec<Value>,
}
pub struct QuestionAuthoringService {
    db: Arc<VfsDatabase>,
}
fn storage(error: impl std::fmt::Display) -> AppError {
    AppError::database(error.to_string())
}
fn conflict(message: &str) -> AppError {
    AppError::validation(format!("CONFLICT: {message}"))
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
fn id(prefix: &str) -> String {
    format!("{prefix}_{}", nanoid::nanoid!(16))
}

impl QuestionAuthoringService {
    pub fn new(db: Arc<VfsDatabase>) -> Self {
        Self { db }
    }
    pub fn save_draft(
        &self,
        exam_id: &str,
        document: &QuestionDocument,
        metadata: &Value,
    ) -> Result<String, AppError> {
        let conn = self.db.get_conn_safe().map_err(storage)?;
        Self::save_draft_with_conn(&conn, exam_id, document, metadata)
    }
    pub fn save_draft_with_conn(
        conn: &Connection,
        exam_id: &str,
        document: &QuestionDocument,
        metadata: &Value,
    ) -> Result<String, AppError> {
        document.validate()?;
        if !conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM exam_sheets WHERE id=?1 AND deleted_at IS NULL)",
                [exam_id],
                |r| r.get::<_, bool>(0),
            )
            .map_err(storage)?
        {
            return Err(AppError::not_found("目标题目集不存在"));
        }
        let key = metadata["idempotency_key"].as_str();
        if let Some(key) = key {
            if let Some((job,existing))=conn.query_row("SELECT id,document_json FROM qbank_import_jobs WHERE exam_id=?1 AND idempotency_key=?2",params![exam_id,key],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional().map_err(storage)? {
                if serde_json::from_str::<Value>(&existing).ok()!=serde_json::to_value(document).ok() {return Err(conflict("相同幂等键对应不同内容"));} return Ok(job);
            }
        }
        let job = id("qjob");
        let stamp = now();
        let partial = metadata["complete_document"] == false;
        conn.execute("INSERT INTO qbank_import_jobs(id,exam_id,status,document_json,metadata_json,idempotency_key,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?7)",params![job,exam_id,if partial{"partial"}else if document.needs_review(){"needs_review"}else{"ready"},serde_json::to_string(document).map_err(storage)?,metadata.to_string(),key,stamp]).map_err(storage)?;
        Ok(job)
    }
    pub fn get_draft(&self, job_id: &str) -> Result<QuestionAuthoringDraft, AppError> {
        let conn = self.db.get_conn_safe().map_err(storage)?;
        read_draft(&conn, job_id)
    }
    pub fn get_draft_with_conn(
        conn: &Connection,
        job_id: &str,
    ) -> Result<QuestionAuthoringDraft, AppError> {
        read_draft(conn, job_id)
    }
    pub fn list_drafts(&self, exam_id: &str) -> Result<Vec<QuestionDraftSummary>, AppError> {
        let conn = self.db.get_conn_safe().map_err(storage)?;
        let mut statement = conn.prepare("SELECT j.id,j.status,j.version,json_array_length(j.document_json,'$.questions'),j.created_at FROM qbank_import_jobs j JOIN exam_sheets e ON e.id=j.exam_id WHERE j.exam_id=?1 AND e.deleted_at IS NULL AND j.status IN ('ready','needs_review','partial') ORDER BY j.created_at DESC,j.id").map_err(storage)?;
        let rows = statement
            .query_map([exam_id], |row| {
                Ok(QuestionDraftSummary {
                    job_id: row.get(0)?,
                    exam_id: exam_id.to_string(),
                    status: row.get(1)?,
                    version: row.get(2)?,
                    question_count: row.get::<_, i64>(3)? as usize,
                    created_at: row.get(4)?,
                })
            })
            .map_err(storage)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage)?;
        Ok(rows)
    }
    pub fn update_draft_review(
        &self,
        job_id: &str,
        expected_version: i64,
        coverage: Option<Vec<Value>>,
        issues: Option<Vec<Value>>,
        unmatched_answers: Option<Vec<Value>>,
    ) -> Result<QuestionAuthoringDraft, AppError> {
        let mut conn = self.db.get_conn_safe().map_err(storage)?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(storage)?;
        let mut draft = read_draft(&tx, job_id)?;
        if draft.version != expected_version
            || !matches!(draft.status.as_str(), "ready" | "needs_review" | "partial")
        {
            return Err(conflict("草稿已提交或版本变化，请重新读取"));
        }
        if let Some(coverage) = coverage {
            for entry in &coverage {
                if entry["source_id"]
                    .as_str()
                    .is_none_or(|id| id.trim().is_empty())
                    || !matches!(
                        entry["status"].as_str(),
                        Some("processed" | "uncertain" | "unprocessed")
                    )
                    || !(entry["page"].is_null() || entry["page"].as_u64().is_some_and(|n| n > 0))
                {
                    return Err(AppError::validation(
                        "coverage 必须为真实 {source_id,page,status} 列表",
                    ));
                }
            }
            // Dedicated extraction has a known source inventory; review cannot
            // silently erase its required coverage or invent processed pages.
            if let Some(expected) = draft
                .metadata
                .get("expected_coverage")
                .and_then(Value::as_array)
            {
                for page in expected {
                    if !coverage
                        .iter()
                        .any(|c| c["source_id"] == page["source_id"] && c["page"] == page["page"])
                    {
                        return Err(AppError::validation("复核不能删除来源覆盖范围"));
                    }
                }
            }
            draft.document.coverage = coverage;
        }
        if let Some(issues) = issues {
            draft.document.issues = issues;
        }
        if let Some(answers) = unmatched_answers {
            draft.document.unmatched_answers = answers;
        }
        draft.document.validate()?;
        let status = if draft.metadata["complete_document"] == false {
            "partial"
        } else if draft.document.needs_review() {
            "needs_review"
        } else {
            "ready"
        };
        tx.execute("UPDATE qbank_import_jobs SET document_json=?1,status=?2,version=version+1,updated_at=?3 WHERE id=?4 AND version=?5",params![json!(draft.document).to_string(),status,now(),job_id,expected_version]).map_err(storage)?;
        let updated = read_draft(&tx, job_id)?;
        tx.commit().map_err(storage)?;
        Ok(updated)
    }
    pub fn submit_document(
        &self,
        exam_id: &str,
        document: &QuestionDocument,
        idempotency_key: &str,
    ) -> Result<AuthoringCommitReceipt, AppError> {
        let job = self.save_draft(
            exam_id,
            document,
            &json!({"idempotency_key":idempotency_key}),
        )?;
        let draft = self.get_draft(&job)?;
        if draft.document.needs_review() || draft.status == "partial" {
            return Err(AppError::validation(
                "草稿存在待复核事项，请用户明确选择后提交",
            ));
        }
        self.commit_draft(
            &job,
            &draft
                .document
                .questions
                .iter()
                .map(|q| q.local_id.clone())
                .collect::<Vec<_>>(),
            draft.version,
        )
    }
    pub fn commit_draft(
        &self,
        job_id: &str,
        selected_local_ids: &[String],
        expected_version: i64,
    ) -> Result<AuthoringCommitReceipt, AppError> {
        let mut conn = self.db.get_conn_safe().map_err(storage)?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(storage)?;
        let receipt =
            Self::commit_draft_with_conn(&tx, job_id, selected_local_ids, expected_version)?;
        tx.commit().map_err(storage)?;
        Ok(receipt)
    }
    /// Caller owns the surrounding transaction, including rollback on failure.
    pub fn commit_draft_with_conn(
        tx: &Connection,
        job_id: &str,
        selected_local_ids: &[String],
        expected_version: i64,
    ) -> Result<AuthoringCommitReceipt, AppError> {
        if tx.is_autocommit() {
            return Err(AppError::validation("题目提交必须处于事务中"));
        }
        let draft = read_draft(&tx, job_id)?;
        let selected: HashSet<_> = selected_local_ids.iter().cloned().collect();
        if selected.is_empty() || selected.len() != selected_local_ids.len() {
            return Err(AppError::validation("请选择不重复的有效题目"));
        }
        let mut sorted = selected_local_ids.to_vec();
        sorted.sort();
        let selection = json!(sorted).to_string();
        if draft.status == "committed" {
            let (old, receipt): (String, String) = tx
                .query_row(
                    "SELECT selected_json,receipt_json FROM qbank_import_jobs WHERE id=?1",
                    [job_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(storage)?;
            if old != selection {
                return Err(conflict("该草稿已按其他选择提交，请刷新题目集"));
            }
            return serde_json::from_str(&receipt).map_err(storage);
        }
        if draft.version != expected_version {
            return Err(conflict("草稿版本已变化，请重新载入"));
        }
        if !matches!(draft.status.as_str(), "ready" | "needs_review" | "partial") {
            return Err(AppError::validation("该草稿不可提交"));
        }
        draft.document.validate()?;
        if selected
            .iter()
            .any(|id| !draft.document.questions.iter().any(|q| &q.local_id == id))
        {
            return Err(AppError::validation("所选题目不属于当前草稿"));
        }
        if !tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM exam_sheets WHERE id=?1 AND deleted_at IS NULL)",
                [&draft.exam_id],
                |r| r.get::<_, bool>(0),
            )
            .map_err(storage)?
        {
            return Err(AppError::not_found("目标题目集已删除"));
        }
        let stamp = now();
        let mut sources = HashMap::<String, String>::new();
        for source in draft.metadata["sources"].as_array().into_iter().flatten() {
            let local = source["source_id"]
                .as_str()
                .ok_or_else(|| AppError::validation("来源缺少source_id"))?;
            let key = source["content_hash"]
                .as_str()
                .or(source["blob_hash"].as_str())
                .ok_or_else(|| AppError::validation("来源缺少稳定内容哈希"))?;
            let key = format!("{}:{}", key, source["anchor"].as_str().unwrap_or(""));
            let sid = tx
                .query_row(
                    "SELECT id FROM qbank_sources WHERE exam_id=?1 AND source_key=?2",
                    params![draft.exam_id, key],
                    |r| r.get::<_, String>(0),
                )
                .optional()
                .map_err(storage)?
                .unwrap_or_else(|| id("qsource"));
            let mut descriptor = source.clone();
            descriptor["pages"] = Value::Array(
                draft.metadata["pages"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|p| p["source_id"] == local)
                    .cloned()
                    .collect(),
            );
            let previous: Option<String> = tx
                .query_row(
                    "SELECT descriptor_json FROM qbank_sources WHERE id=?1",
                    [&sid],
                    |row| row.get(0),
                )
                .optional()
                .map_err(storage)?;
            if let Some(previous) = previous {
                let mut previous: Value = serde_json::from_str(&previous).map_err(storage)?;
                let mut pages = previous["pages"].as_array().cloned().unwrap_or_default();
                for page in descriptor["pages"].as_array().into_iter().flatten() {
                    if let Some(old) = pages.iter().find(|old| old["page"] == page["page"]) {
                        if old["blob_hash"] != page["blob_hash"] {
                            return Err(conflict("同一来源版本的页面证据已变化，请重新复核"));
                        }
                    } else {
                        pages.push(page.clone());
                    }
                }
                pages.sort_by_key(|page| page["page"].as_u64().unwrap_or(0));
                previous["pages"] = json!(pages);
                tx.execute("UPDATE qbank_sources SET descriptor_json=?1,updated_at=?2,local_version=local_version+1 WHERE id=?3",params![previous.to_string(),stamp,sid]).map_err(storage)?;
            } else {
                tx.execute("INSERT INTO qbank_sources(id,exam_id,source_key,descriptor_json,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)",params![sid,draft.exam_id,key,descriptor.to_string(),stamp]).map_err(storage)?;
            }
            sources.insert(local.to_string(), sid);
        }
        let mut receipt = AuthoringCommitReceipt {
            committed: true,
            exam_id: draft.exam_id.clone(),
            partial: selected.len() != draft.document.questions.len()
                || draft.metadata["complete_document"] == false,
            needs_review: draft.document.needs_review()
                || draft.metadata["complete_document"] == false,
            coverage: draft.document.coverage.clone(),
            unmatched_answers: draft.document.unmatched_answers.clone(),
            ..Default::default()
        };
        let selected_questions: Vec<_> = draft
            .document
            .questions
            .iter()
            .filter(|q| selected.contains(&q.local_id))
            .collect();
        // A source slot identifies the original location, not the possibly
        // edited question content. Reparse cannot overwrite user edits/history.
        let mut existing = HashMap::new();
        for q in &selected_questions {
            let key = if draft.document.mode == "extract" {
                source_slot(q, &sources)?
            } else {
                None
            };
            if let Some(key) = key.as_deref() {
                if let Some((question_id,deleted,provenance))=tx.query_row("SELECT id,deleted_at,provenance_json FROM questions WHERE exam_id=?1 AND source_key=?2",params![draft.exam_id,key],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,Option<String>>(2)?))).optional().map_err(storage)? {
                    if deleted.is_some() {return Err(conflict("该来源题目曾被删除，请明确恢复而非重复导入"));}
                    let old:Value=provenance.and_then(|p|serde_json::from_str(&p).ok()).unwrap_or(Value::Null);
                    if old["imported_content"]!=q.content {return Err(conflict("同源重新解析内容变化，需复核映射，未覆盖已有题目"));}
                    existing.insert(q.local_id.clone(),question_id);
                }
            }
        }
        if !existing.is_empty() && existing.len() != selected_questions.len() {
            return Err(conflict(
                "同源范围同时含已有与新拆分题目，请先复核，未自动混合导入",
            ));
        }
        if existing.len() == selected_questions.len() {
            receipt.question_ids = selected_questions
                .iter()
                .filter_map(|q| existing.get(&q.local_id).cloned())
                .collect();
        } else {
            let needed_groups: HashSet<_> = selected_questions
                .iter()
                .filter_map(|q| q.group_id.as_deref())
                .collect();
            let needed_materials: HashSet<_> = draft
                .document
                .groups
                .iter()
                .filter(|g| needed_groups.contains(g.local_id.as_str()))
                .flat_map(|g| g.material_ids.iter().map(String::as_str))
                .collect();
            let mut material_ids = HashMap::new();
            let mut group_ids = HashMap::new();
            for material in draft
                .document
                .materials
                .iter()
                .filter(|m| needed_materials.contains(m.local_id.as_str()))
            {
                verify_images(&tx, &material.images)?;
                let mid = id("qmat");
                let refs = remap_refs(&material.source_refs, &sources)?;
                tx.execute("INSERT INTO qbank_materials(id,exam_id,content,images_json,source_refs_json,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?6)",params![mid,draft.exam_id,material.content,json!(material.images).to_string(),json!(refs).to_string(),stamp]).map_err(storage)?;
                receipt.material_ids.push(mid.clone());
                material_ids.insert(material.local_id.clone(), mid);
            }
            for (position, group) in draft
                .document
                .groups
                .iter()
                .filter(|g| needed_groups.contains(g.local_id.as_str()))
                .enumerate()
            {
                let gid = id("qgroup");
                tx.execute("INSERT INTO qbank_groups(id,exam_id,label,position,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)",params![gid,draft.exam_id,group.label,position as i64,stamp]).map_err(storage)?;
                for (order, local) in group.material_ids.iter().enumerate() {
                    tx.execute("INSERT INTO qbank_group_materials(id,exam_id,group_id,material_id,position,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?6)",params![id("qgm"),draft.exam_id,gid,material_ids[local],order as i64,stamp]).map_err(storage)?;
                }
                group_ids.insert(group.local_id.clone(), gid.clone());
                receipt.group_ids.push(gid);
            }
            let mut new_question_ids = HashMap::new();
            let mut deferred_parents = Vec::new();
            for q in selected_questions {
                verify_images(&tx, &q.images)?;
                if let Some(parent) = &q.parent_id {
                    if !tx.query_row("SELECT EXISTS(SELECT 1 FROM questions WHERE id=?1 AND exam_id=?2 AND deleted_at IS NULL)",params![parent,draft.exam_id],|r|r.get::<_,bool>(0)).map_err(storage)? {return Err(AppError::validation("变式父题不属于目标题目集"));}
                }
                let refs = remap_refs(&q.source_refs, &sources)?;
                let answer_refs = remap_refs(&q.answer_source_refs, &sources)?;
                let source_ref = if sources.is_empty() {
                    q.source_ref.clone()
                } else {
                    Some(json!({"source_refs":refs,"answer_source_refs":answer_refs}).to_string())
                };
                let mut content = q.content.clone();
                if let Some(smiles) = &q.smiles {
                    content.push_str(&format!("\n\n```smiles\n{smiles}\n```"));
                    if let Some(caption) = &q.smiles_caption {
                        content.push_str(&format!("\n{caption}"));
                    }
                }
                let params = CreateQuestionParams {
                    exam_id: draft.exam_id.clone(),
                    card_id: None,
                    question_label: q.original_label.clone(),
                    content,
                    options: q.options.clone(),
                    answer: q.answer.clone(),
                    explanation: q.explanation.clone(),
                    structured_data: q.structured_data.clone(),
                    question_type: Some(QuestionType::from_str(&q.question_type)),
                    difficulty: q.difficulty.as_deref().map(Difficulty::from_str),
                    tags: Some(q.tags.clone()),
                    source_type: Some(if draft.document.mode == "generate" {
                        SourceType::AiGenerated
                    } else {
                        SourceType::Imported
                    }),
                    source_ref,
                    images: Some(q.images.clone()),
                    parent_id: q.parent_id.clone(),
                };
                let question =
                    VfsQuestionRepo::create_question_with_conn(&tx, &params).map_err(storage)?;
                let group = q.group_id.as_ref().map(|local| group_ids[local].clone());
                let position = q
                    .group_id
                    .as_ref()
                    .and_then(|id| draft.document.groups.iter().find(|g| &g.local_id == id))
                    .and_then(|g| g.question_ids.iter().position(|id| id == &q.local_id))
                    .map(|n| n as i64);
                let slot = if draft.document.mode == "extract" {
                    source_slot(q, &sources)?
                } else {
                    None
                };
                tx.execute("UPDATE questions SET card_id=id,group_id=?1,group_position=?2,source_key=?3,provenance_json=?4,answer_origin=?5 WHERE id=?6",params![group,position,slot,json!({"source_refs":refs,"answer_source_refs":answer_refs,"section_path":q.section_path,"original_label":q.original_label,"imported_content":q.content}).to_string(),q.answer_origin,question.id]).map_err(storage)?;
                new_question_ids.insert(q.local_id.clone(), question.id.clone());
                if let Some(parent) = &q.parent_local_id {
                    deferred_parents.push((question.id.clone(), parent.clone()));
                }
                receipt.question_ids.push(question.id);
                receipt.imported_count += 1;
            }
            for (question, parent) in deferred_parents {
                let parent = new_question_ids.get(&parent).ok_or_else(|| {
                    AppError::validation("所选变式题依赖未选择的父题，请一并选择父题")
                })?;
                tx.execute(
                    "UPDATE questions SET parent_id=?1 WHERE id=?2",
                    params![parent, question],
                )
                .map_err(storage)?;
            }
        }
        receipt.total_questions = tx
            .query_row(
                "SELECT count(*) FROM questions WHERE exam_id=?1 AND deleted_at IS NULL",
                [&draft.exam_id],
                |r| r.get::<_, i64>(0),
            )
            .map_err(storage)? as usize;
        VfsQuestionRepo::refresh_stats_with_conn(&tx, &draft.exam_id).map_err(storage)?;
        refresh_canonical_preview_with_conn(&tx, &draft.exam_id)?;
        tx.execute("UPDATE exam_sheets SET metadata_json=json_set(COALESCE(metadata_json,'{}'),'$.question_document_version',2),status='completed',import_state_json=NULL WHERE id=?1",[&draft.exam_id]).map_err(storage)?;
        let changed=tx.execute("UPDATE qbank_import_jobs SET status='committed',version=version+1,receipt_json=?1,selected_json=?2,updated_at=?3 WHERE id=?4 AND version=?5",params![json!(receipt).to_string(),selection,stamp,job_id,expected_version]).map_err(storage)?;
        if changed != 1 {
            return Err(conflict("草稿已被其他操作修改"));
        }
        Ok(receipt)
    }
    pub fn update_material(
        &self,
        material_id: &str,
        content: &str,
        expected_version: i64,
    ) -> Result<QuestionMaterial, AppError> {
        if content.trim().is_empty() {
            return Err(AppError::validation("材料内容不能为空"));
        }
        let conn = self.db.get_conn_safe().map_err(storage)?;
        let tx = conn.unchecked_transaction().map_err(storage)?;
        let changed=tx.execute("UPDATE qbank_materials SET content=?1,local_version=local_version+1,updated_at=?2 WHERE id=?3 AND local_version=?4 AND deleted_at IS NULL",params![content,now(),material_id,expected_version]).map_err(storage)?;
        if changed != 1 {
            return Err(conflict("材料版本已变化或材料不存在"));
        }
        let material = read_material(&tx, material_id)?;
        tx.execute("UPDATE resources SET index_state='pending' WHERE id IN (SELECT e.resource_id FROM exam_sheets e JOIN qbank_materials m ON m.exam_id=e.id WHERE m.id=?1)",[material_id]).map_err(storage)?;
        tx.commit().map_err(storage)?;
        Ok(material)
    }
    pub fn delete_material(&self, id: &str, expected_version: i64) -> Result<(), AppError> {
        let mut pooled = self.db.get_conn_safe().map_err(storage)?;
        let conn = pooled
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(storage)?;
        if conn.query_row("SELECT EXISTS(SELECT 1 FROM qbank_group_materials l JOIN qbank_groups g ON g.id=l.group_id WHERE l.material_id=?1 AND l.deleted_at IS NULL AND g.deleted_at IS NULL)",[id],|r|r.get::<_,bool>(0)).map_err(storage)? {return Err(AppError::validation("材料仍被题组引用，请先替换或解除依赖"));}
        let changed=conn.execute("UPDATE qbank_materials SET deleted_at=?1,updated_at=?1,local_version=local_version+1 WHERE id=?2 AND local_version=?3 AND deleted_at IS NULL",params![now(),id,expected_version]).map_err(storage)?;
        if changed != 1 {
            return Err(conflict("材料版本已变化"));
        }
        conn.commit().map_err(storage)?;
        Ok(())
    }

    pub fn update_group(
        &self,
        group_id: &str,
        label: &str,
        question_ids: &[String],
        material_ids: &[String],
        expected_version: i64,
    ) -> Result<Value, AppError> {
        if question_ids.is_empty()
            || question_ids.iter().collect::<HashSet<_>>().len() != question_ids.len()
            || material_ids.iter().collect::<HashSet<_>>().len() != material_ids.len()
        {
            return Err(AppError::validation("题组成员为空或关联重复"));
        }
        let mut conn = self.db.get_conn_safe().map_err(storage)?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(storage)?;
        let exam: String = tx
            .query_row(
                "SELECT exam_id FROM qbank_groups WHERE id=?1 AND deleted_at IS NULL",
                [group_id],
                |r| r.get(0),
            )
            .map_err(storage)?;
        let changed=tx.execute("UPDATE qbank_groups SET label=?1,local_version=local_version+1,updated_at=?2 WHERE id=?3 AND local_version=?4 AND deleted_at IS NULL",params![label,now(),group_id,expected_version]).map_err(storage)?;
        if changed != 1 {
            return Err(conflict("题组版本已变化"));
        }
        let old: Vec<String> = {
            let mut stmt = tx
                .prepare("SELECT id FROM questions WHERE group_id=?1 AND deleted_at IS NULL")
                .map_err(storage)?;
            let rows = stmt
                .query_map([group_id], |r| r.get::<_, String>(0))
                .map_err(storage)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(storage)?;
            rows
        };
        // Removing a child while it still depends on shared conditions would
        // silently create an unsolvable independent question. Require an
        // explicit separate content operation before removing such a member.
        if old.iter().any(|id| !question_ids.contains(id)) {
            return Err(AppError::validation(
                "移出子题前请显式处理其共享材料依赖；当前操作未修改任何内容",
            ));
        }
        for (position, id) in question_ids.iter().enumerate() {
            let affected=tx.execute("UPDATE questions SET group_id=?1,group_position=?2,updated_at=?3 WHERE id=?4 AND exam_id=?5 AND deleted_at IS NULL AND (group_id IS NULL OR group_id=?1)",params![group_id,position as i64,now(),id,exam]).map_err(storage)?;
            if affected != 1 {
                return Err(AppError::validation("子题不存在、跨题库或已属于另一题组"));
            }
        }
        let stamp = now();
        tx.execute("UPDATE qbank_group_materials SET deleted_at=?1,updated_at=?1,local_version=local_version+1 WHERE group_id=?2 AND deleted_at IS NULL",params![stamp,group_id]).map_err(storage)?;
        for (position, material) in material_ids.iter().enumerate() {
            if !tx.query_row("SELECT EXISTS(SELECT 1 FROM qbank_materials WHERE id=?1 AND exam_id=?2 AND deleted_at IS NULL)",params![material,exam],|r|r.get::<_,bool>(0)).map_err(storage)? {return Err(AppError::validation("材料不存在或不属于目标题目集"));}
            tx.execute("INSERT INTO qbank_group_materials(id,exam_id,group_id,material_id,position,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?6) ON CONFLICT(group_id,material_id) DO UPDATE SET position=excluded.position,deleted_at=NULL,updated_at=excluded.updated_at,local_version=qbank_group_materials.local_version+1",params![id("qgm"),exam,group_id,material,position as i64,stamp]).map_err(storage)?;
        }
        refresh_canonical_preview_with_conn(&tx, &exam)?;
        tx.commit().map_err(storage)?;
        Ok(
            json!({"group_id":group_id,"exam_id":exam,"label":label,"question_ids":question_ids,"material_ids":material_ids,"version":expected_version+1}),
        )
    }
}
fn read_draft(conn: &Connection, job_id: &str) -> Result<QuestionAuthoringDraft, AppError> {
    let row=conn.query_row("SELECT exam_id,status,version,document_json,metadata_json FROM qbank_import_jobs WHERE id=?1",[job_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?))).optional().map_err(storage)?.ok_or_else(||AppError::not_found("未找到题目草稿"))?;
    Ok(QuestionAuthoringDraft {
        job_id: job_id.into(),
        exam_id: row.0,
        status: row.1,
        version: row.2,
        document: serde_json::from_str(&row.3).map_err(storage)?,
        metadata: serde_json::from_str(&row.4).map_err(storage)?,
    })
}
pub fn read_material(conn: &Connection, id: &str) -> Result<QuestionMaterial, AppError> {
    let (content,images,refs,version):(String,String,String,i64)=conn.query_row("SELECT content,images_json,source_refs_json,local_version FROM qbank_materials WHERE id=?1 AND deleted_at IS NULL",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(storage)?;
    Ok(QuestionMaterial {
        id: id.into(),
        content,
        images: serde_json::from_str(&images).map_err(storage)?,
        source_refs: serde_json::from_str(&refs).map_err(storage)?,
        version,
    })
}
fn remap_refs(
    refs: &[SourceRef],
    sources: &HashMap<String, String>,
) -> Result<Vec<SourceRef>, AppError> {
    refs.iter()
        .map(|r| {
            Ok(SourceRef {
                source_id: if sources.is_empty() {
                    r.source_id.clone()
                } else {
                    sources
                        .get(&r.source_id)
                        .cloned()
                        .ok_or_else(|| AppError::validation("来源引用不在当前完整证据清单中"))?
                },
                ..r.clone()
            })
        })
        .collect()
}
fn source_slot(
    q: &DraftQuestion,
    sources: &HashMap<String, String>,
) -> Result<Option<String>, AppError> {
    if q.answer_origin.as_deref() == Some("generated") {
        return Ok(None);
    }
    if sources.is_empty() || q.source_refs.is_empty() {
        return Ok(None);
    }
    let refs = remap_refs(&q.source_refs, sources)?;
    let source_ids: Vec<_> = refs.iter().map(|r| (&r.source_id, r.page)).collect();
    if q.original_label
        .as_deref()
        .is_none_or(|label| label.trim().is_empty())
    {
        return Err(AppError::validation(
            "来源题目缺少原题号，无法建立稳定重解析身份，请复核",
        ));
    }
    Ok(Some(hex::encode(Sha256::digest(
        json!([source_ids, q.section_path, q.original_label])
            .to_string()
            .as_bytes(),
    ))))
}
fn verify_images(conn: &Connection, images: &[QuestionImage]) -> Result<(), AppError> {
    for image in images {
        let valid=conn.query_row("SELECT EXISTS(SELECT 1 FROM files f JOIN blobs b ON b.hash=f.blob_hash WHERE f.id=?1 AND f.blob_hash=?2 AND f.deleted_at IS NULL)",params![image.id,image.hash],|r|r.get::<_,bool>(0)).map_err(storage)?;
        if !valid {
            return Err(AppError::validation(format!(
                "题目/材料图片不可用: {}",
                image.name
            )));
        }
    }
    Ok(())
}

pub fn refresh_canonical_preview_with_conn(
    conn: &Connection,
    exam_id: &str,
) -> Result<(), AppError> {
    let text: Option<String> = conn
        .query_row(
            "SELECT preview_json FROM exam_sheets WHERE id=?1",
            [exam_id],
            |r| r.get(0),
        )
        .map_err(storage)?;
    let mut preview: Value = text
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(json!({"pages":[]}));
    if !preview["pages"].is_array() {
        preview["pages"] = json!([]);
    }
    for page in preview["pages"].as_array_mut().unwrap() {
        page["cards"] = json!([]);
    }
    let mut source_pages = HashMap::new();
    let mut descriptors=conn.prepare("SELECT id,descriptor_json FROM qbank_sources WHERE exam_id=?1 AND deleted_at IS NULL ORDER BY created_at,id").map_err(storage)?;
    for row in descriptors
        .query_map([exam_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(storage)?
    {
        let (source, descriptor) = row.map_err(storage)?;
        let descriptor: Value = serde_json::from_str(&descriptor).map_err(storage)?;
        for page in descriptor["pages"].as_array().into_iter().flatten() {
            let hash = page["blob_hash"]
                .as_str()
                .ok_or_else(|| AppError::validation("来源页面缺少blob_hash"))?;
            let existing = preview["pages"]
                .as_array()
                .unwrap()
                .iter()
                .position(|p| p["blob_hash"] == hash);
            let index = match existing {
                Some(index) => index,
                None => {
                    let index = preview["pages"].as_array().unwrap().len();
                    preview["pages"].as_array_mut().unwrap().push(json!({"page_index":index,"blob_hash":hash,"width":page["width"],"height":page["height"],"cards":[],"ocr_completed":true,"parse_completed":true}));
                    index
                }
            };
            source_pages.insert((source.clone(), page["page"].as_u64().unwrap_or(1)), index);
        }
    }
    drop(descriptors);
    if preview["pages"].as_array().unwrap().is_empty() {
        preview["pages"] = json!([{"page_index":0,"cards":[]}]);
    }
    let mut stmt=conn.prepare("SELECT COALESCE(card_id,id),question_label,content,question_type,answer,explanation,options_json,structured_data,images_json,provenance_json,group_id FROM questions WHERE exam_id=?1 AND deleted_at IS NULL ORDER BY created_at,rowid").map_err(storage)?;
    let rows = stmt
        .query_map([exam_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, Option<String>>(7)?,
                r.get::<_, String>(8)?,
                r.get::<_, Option<String>>(9)?,
                r.get::<_, Option<String>>(10)?,
            ))
        })
        .map_err(storage)?;
    for row in rows {
        let (
            id,
            label,
            content,
            kind,
            answer,
            explanation,
            options,
            structured,
            images,
            provenance,
            group,
        ) = row.map_err(storage)?;
        let refs: Value = provenance
            .and_then(|p| serde_json::from_str(&p).ok())
            .unwrap_or(Value::Null);
        let reference = &refs["source_refs"][0];
        let page = source_pages
            .get(&(
                reference["source_id"].as_str().unwrap_or("").to_string(),
                reference["page"].as_u64().unwrap_or(1),
            ))
            .copied()
            .unwrap_or(0);
        let page = page.min(preview["pages"].as_array().unwrap().len() - 1);
        preview["pages"][page]["cards"].as_array_mut().unwrap().push(json!({"card_id":id,"question_label":label.unwrap_or_default(),"ocr_text":content,"question_type":kind,"answer":answer,"explanation":explanation,"options":options.and_then(|s|serde_json::from_str::<Value>(&s).ok()),"structured_data":structured.and_then(|s|serde_json::from_str::<Value>(&s).ok()),"images":serde_json::from_str::<Value>(&images).unwrap_or(json!([])),"group_id":group,"page_index":page}));
    }
    drop(stmt);
    VfsExamRepo::update_preview_json_with_conn(conn, exam_id, preview).map_err(storage)
}
