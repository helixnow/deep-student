//! Atomic, idempotent cross-page block moves and exact OCC-protected undo.
use super::{
    note_format_repo::{blocks, conflict, invalid, NoteFormatRepo},
    note_repo::VfsNoteRepo,
    note_revision_repo::{extract_asset_refs, NoteRevisionRepo},
};
use crate::vfs::{
    error::{VfsError, VfsResult},
    types::VfsUpdateNoteParams,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TransferBlocksRequest {
    pub operation_id: String,
    pub source_note_id: String,
    pub target_note_id: String,
    pub expected_source_updated_at: String,
    pub expected_target_updated_at: String,
    pub source_content: String,
    pub target_content: String,
    pub block_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TransferResult {
    pub operation_id: String,
    pub source_note_id: String,
    pub target_note_id: String,
    pub source_updated_at: String,
    pub target_updated_at: String,
    pub source_version_id: String,
    pub target_version_id: String,
    pub undone: bool,
}

pub(crate) fn json<T: Serialize>(value: &T) -> VfsResult<String> {
    serde_json::to_string(value).map_err(|e| VfsError::Serialization(e.to_string()))
}
pub(crate) fn decode<T: serde::de::DeserializeOwned>(value: &str) -> VfsResult<T> {
    serde_json::from_str(value).map_err(|e| VfsError::Serialization(e.to_string()))
}

fn validate_move(source: &str, target: &str, request: &TransferBlocksRequest) -> VfsResult<()> {
    let before_source = blocks(source)?;
    let before_target = blocks(target)?;
    let after_source = blocks(&request.source_content)?;
    let after_target = blocks(&request.target_content)?;
    let ids: BTreeSet<_> = request.block_ids.iter().map(String::as_str).collect();
    if ids.is_empty() || ids.len() != request.block_ids.len() {
        return Err(invalid("block_ids must be nonempty and unique"));
    }
    let selected: Vec<_> = before_source
        .iter()
        .filter(|b| ids.contains(b.id))
        .collect();
    if selected.len() != ids.len() || before_target.iter().any(|b| ids.contains(b.id)) {
        return Err(invalid(
            "Selected block missing in source or already present in target",
        ));
    }
    // Reject ambiguous IDs even when the colliding block was not selected.
    if before_source
        .iter()
        .any(|s| before_target.iter().any(|t| s.id == t.id))
    {
        return Err(invalid("Source and target block IDs collide"));
    }
    let remaining: Vec<_> = before_source
        .iter()
        .filter(|b| !ids.contains(b.id))
        .collect();
    let original_target: Vec<_> = after_target
        .iter()
        .filter(|b| !ids.contains(b.id))
        .collect();
    let moved: Vec<_> = after_target.iter().filter(|b| ids.contains(b.id)).collect();
    if remaining != after_source.iter().collect::<Vec<_>>()
        || original_target != before_target.iter().collect::<Vec<_>>()
        || moved != selected
    {
        return Err(invalid(
            "Transfer must preserve every block body, identity and relative order",
        ));
    }
    Ok(())
}

pub struct NoteTransferRepo;
impl NoteTransferRepo {
    fn write_pair(
        conn: &Connection,
        request: &TransferBlocksRequest,
        source: &str,
        target: &str,
        source_expected: &str,
        target_expected: &str,
        undone: bool,
    ) -> VfsResult<TransferResult> {
        // Before/after versions survive the ordinary edit coalescing policy.
        for id in [&request.source_note_id, &request.target_note_id] {
            let version = NoteRevisionRepo::snapshot(conn, id, "transfer_before")?;
            conn.execute("UPDATE note_document_revisions SET pinned=1 WHERE version_id=?1", [version])?;
        }
        // This backend splice preserves complete root containers and therefore
        // is itself a capable writer; page opt-in is still checked by the repo.
        let capabilities = vec![super::note_format_repo::COLUMNS_CAPABILITY.into()];
        let s = VfsNoteRepo::update_note_with_capabilities(
            conn,
            &request.source_note_id,
            VfsUpdateNoteParams {
                content: Some(source.into()),
                expected_updated_at: Some(source_expected.into()),
                ..Default::default()
            },
            &capabilities,
        )?;
        let t = VfsNoteRepo::update_note_with_capabilities(
            conn,
            &request.target_note_id,
            VfsUpdateNoteParams {
                content: Some(target.into()),
                expected_updated_at: Some(target_expected.into()),
                ..Default::default()
            },
            &capabilities,
        )?;
        let sv = NoteRevisionRepo::snapshot(conn, &s.id, "transfer")?;
        let tv = NoteRevisionRepo::snapshot(conn, &t.id, "transfer")?;
        for version in [&sv, &tv] {
            conn.execute("UPDATE note_document_revisions SET pinned=1 WHERE version_id=?1", [version])?;
        }
        Ok(TransferResult {
            operation_id: request.operation_id.clone(),
            source_note_id: s.id,
            target_note_id: t.id,
            source_updated_at: s.updated_at,
            target_updated_at: t.updated_at,
            source_version_id: sv,
            target_version_id: tv,
            undone,
        })
    }

    pub fn transfer(
        conn: &Connection,
        request: TransferBlocksRequest,
    ) -> VfsResult<TransferResult> {
        if request.operation_id.trim().is_empty()
            || request.source_note_id == request.target_note_id
            || request.expected_source_updated_at.is_empty()
            || request.expected_target_updated_at.is_empty()
        {
            return Err(invalid(
                "Operation ID, distinct pages and both OCC tokens are required",
            ));
        }
        NoteRevisionRepo::transaction(conn, || {
            let receipt: Option<(String, String, Option<String>)> = conn.query_row("SELECT request_json,result_json,undo_result_json FROM note_transfer_operations WHERE operation_id=?1", [&request.operation_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional()?;
            if let Some((stored, result, undo)) = receipt {
                if decode::<TransferBlocksRequest>(&stored)? != request {
                    return Err(conflict("notes.operation_id_reused"));
                }
                return decode(undo.as_deref().unwrap_or(&result));
            }
            for (id, expected) in [
                (&request.source_note_id, &request.expected_source_updated_at),
                (&request.target_note_id, &request.expected_target_updated_at),
            ] {
                let note = VfsNoteRepo::get_note_with_conn(conn, id)?
                    .ok_or_else(|| invalid("Transfer page missing or deleted"))?;
                if note.updated_at != *expected {
                    return Err(conflict("notes.conflict"));
                }
            }
            for id in [&request.source_note_id, &request.target_note_id] {
                let format = NoteFormatRepo::get(conn, id)?;
                NoteFormatRepo::ensure_supported(&format)?;
                if format.content_format != "markdown-blocks" {
                    return Err(invalid("Migrate both pages to stable blocks first"));
                }
            }
            let source = VfsNoteRepo::get_note_content_with_conn(conn, &request.source_note_id)?
                .ok_or_else(|| invalid("Source missing"))?;
            let target = VfsNoteRepo::get_note_content_with_conn(conn, &request.target_note_id)?
                .ok_or_else(|| invalid("Target missing"))?;
            validate_move(&source, &target, &request)?;
            let result = Self::write_pair(
                conn,
                &request,
                &request.source_content,
                &request.target_content,
                &request.expected_source_updated_at,
                &request.expected_target_updated_at,
                false,
            )?;
            let refs: BTreeSet<_> = extract_asset_refs(&source)
                .into_iter()
                .chain(extract_asset_refs(&target))
                .collect();
            conn.execute("INSERT INTO note_transfer_operations(operation_id,source_note_id,target_note_id,request_json,source_before,target_before,asset_refs_json,result_json,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                params![request.operation_id, request.source_note_id, request.target_note_id, json(&request)?, source, target, json(&refs)?, json(&result)?])?;
            Ok(result)
        })
    }

    pub fn undo(
        conn: &Connection,
        operation_id: &str,
        expected_source: &str,
        expected_target: &str,
    ) -> VfsResult<TransferResult> {
        NoteRevisionRepo::transaction(conn, || {
            let (raw, source, target, result, undo): (String, String, String, String, Option<String>) = conn.query_row("SELECT request_json,source_before,target_before,result_json,undo_result_json FROM note_transfer_operations WHERE operation_id=?1", [operation_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?.ok_or_else(|| invalid("Transfer operation missing"))?;
            let applied: TransferResult = decode(&result)?;
            // Undo restores the exact pair only if neither page has changed since
            // the move. A fresh token cannot authorize clobbering later edits.
            if expected_source != applied.source_updated_at
                || expected_target != applied.target_updated_at
            {
                return Err(conflict("notes.undo_conflict"));
            }
            if let Some(undo) = undo {
                return decode(&undo);
            }
            let request: TransferBlocksRequest = decode(&raw)?;
            let result = Self::write_pair(
                conn,
                &request,
                &source,
                &target,
                expected_source,
                expected_target,
                true,
            )?;
            conn.execute(
                "UPDATE note_transfer_operations SET undo_result_json=?1 WHERE operation_id=?2",
                params![json(&result)?, operation_id],
            )?;
            Ok(result)
        })
    }
}

#[cfg(test)]
#[path = "note_storage_tests.rs"]
mod tests;
