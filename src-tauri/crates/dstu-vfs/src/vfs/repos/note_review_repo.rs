//! One review operation owns one copy. Each CAS step has a durable retry receipt.
use super::{
    note_format_repo::{conflict, invalid, NoteFormatRepo},
    note_repo::VfsNoteRepo,
    note_revision_repo::NoteRevisionRepo,
    note_transfer_repo::{decode, json},
};
use crate::vfs::{
    error::VfsResult,
    types::{VfsCreateNoteParams, VfsUpdateNoteParams},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReviewSaveRequest {
    pub operation_id: String,
    pub source_note_id: String,
    pub markdown: String,
    pub expected_updated_at: Option<String>,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSaveResult {
    pub note_id: String,
    pub revision: i64,
    pub markdown: String,
    pub updated_at: String,
}

pub struct NoteReviewRepo;
impl NoteReviewRepo {
    pub fn save_as(conn: &Connection, request: ReviewSaveRequest) -> VfsResult<ReviewSaveResult> {
        if request.operation_id.trim().is_empty()
            || request.expected_updated_at.as_deref() == Some("")
        {
            return Err(invalid(
                "Review operation ID and a nonempty update token are required",
            ));
        }
        NoteRevisionRepo::transaction(conn, || {
            let step = request.expected_updated_at.as_deref().unwrap_or("");
            let receipt:Option<(String,String)>=conn.query_row("SELECT request_json,result_json FROM note_review_save_receipts WHERE operation_id=?1 AND expected_updated_at=?2",params![request.operation_id,step],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            if let Some((saved, result)) = receipt {
                if decode::<ReviewSaveRequest>(&saved)? != request {
                    return Err(conflict("notes.review_request_reused"));
                }
                return decode(&result);
            }
            let operation:Option<(String,String,i64)>=conn.query_row("SELECT source_note_id,note_id,revision FROM note_review_save_operations WHERE operation_id=?1",[&request.operation_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
            let (note, revision) = if let Some((source, note_id, revision)) = operation {
                if source != request.source_note_id {
                    return Err(conflict("notes.operation_id_reused"));
                }
                let expected = request
                    .expected_updated_at
                    .as_ref()
                    .ok_or_else(|| conflict("notes.review_conflict"))?;
                let note = VfsNoteRepo::update_note_with_capabilities(
                    conn,
                    &note_id,
                    VfsUpdateNoteParams {
                        content: Some(request.markdown.clone()),
                        expected_updated_at: Some(expected.clone()),
                        ..Default::default()
                    },
                    &request.capabilities,
                )?;
                conn.execute("UPDATE note_review_save_operations SET revision=revision+1 WHERE operation_id=?1",[&request.operation_id])?;
                (note, revision + 1)
            } else {
                if request.expected_updated_at.is_some() {
                    return Err(conflict("notes.review_conflict"));
                }
                let source = VfsNoteRepo::get_note_with_conn(conn, &request.source_note_id)?
                    .ok_or_else(|| invalid("Review source note missing"))?;
                let source_format = NoteFormatRepo::get(conn, &source.id)?;
                NoteFormatRepo::ensure_supported(&source_format)?;
                let detected = NoteFormatRepo::detect("new-review", &request.markdown)?;
                if NoteFormatRepo::required_capabilities(&detected)
                    .iter()
                    .any(|c| !request.capabilities.contains(c))
                {
                    return Err(invalid("Review result requires ds-columns-v1 capability"));
                }
                let base: String = source.title.chars().take(440).collect();
                let title = VfsNoteRepo::generate_unique_note_title_with_conn(
                    conn,
                    &format!("{base}（AI 审阅副本）"),
                    None,
                )?;
                let note = VfsNoteRepo::create_note_in_folder_uncommitted(
                    conn,
                    VfsCreateNoteParams {
                        title,
                        content: request.markdown.clone(),
                        tags: source.tags,
                    },
                    None,
                )?;
                conn.execute("INSERT INTO note_review_save_operations(operation_id,source_note_id,note_id,revision,created_at) VALUES(?1,?2,?3,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",params![request.operation_id,request.source_note_id,note.id])?;
                (note, 1)
            };
            let result = ReviewSaveResult {
                note_id: note.id,
                revision,
                markdown: request.markdown.clone(),
                updated_at: note.updated_at,
            };
            conn.execute("INSERT INTO note_review_save_receipts(operation_id,expected_updated_at,request_json,result_json) VALUES(?1,?2,?3,?4)",params![request.operation_id,step,json(&request)?,json(&result)?])?;
            Ok(result)
        })
    }
}

#[cfg(test)]
#[path = "note_review_tests.rs"]
mod tests;
