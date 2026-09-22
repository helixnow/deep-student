//! Full current snapshots, safe history selection, transactional restores and policy.
use super::{
    note_format_repo::{blocks, conflict, invalid, marker, NoteFormat, NoteFormatRepo},
    note_repo::{VfsNoteMetadataUpdate, VfsNoteRepo},
    note_revision_repo::{NoteRevision, NoteRevisionRepo},
    note_structure::roots,
};
use crate::vfs::{
    error::VfsResult,
    types::{VfsNote, VfsUpdateNoteParams},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
pub struct NoteHistoryCurrent {
    pub content_md: String,
    pub updated_at: String,
    pub title: String,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoteHistorySelection {
    pub start_line: usize,
    pub end_line: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct NoteHistoryRetention {
    pub edit_bucket_seconds: i64,
    pub max_edit_versions: Option<i64>,
}

impl NoteRevisionRepo {
    pub fn current(conn: &Connection, note_id: &str) -> VfsResult<NoteHistoryCurrent> {
        conn.query_row("SELECT r.data,n.updated_at,n.title FROM notes n JOIN resources r ON r.id=n.resource_id WHERE n.id=?1 AND n.deleted_at IS NULL",[note_id],|r| Ok(NoteHistoryCurrent { content_md:r.get(0)?,updated_at:r.get(1)?,title:r.get(2)? }))
            .optional()?.ok_or_else(|| invalid("Current note missing or deleted"))
    }

    pub fn get_retention(conn: &Connection) -> VfsResult<NoteHistoryRetention> {
        Ok(conn.query_row(
            "SELECT edit_bucket_seconds,max_edit_versions FROM note_history_retention WHERE id=1",
            [],
            |r| {
                Ok(NoteHistoryRetention {
                    edit_bucket_seconds: r.get(0)?,
                    max_edit_versions: r.get(1)?,
                })
            },
        )?)
    }

    pub fn set_retention(
        conn: &Connection,
        mut policy: NoteHistoryRetention,
    ) -> VfsResult<NoteHistoryRetention> {
        if policy.max_edit_versions == Some(0) {
            policy.max_edit_versions = None;
        }
        if !(0..=86400).contains(&policy.edit_bucket_seconds)
            || policy
                .max_edit_versions
                .is_some_and(|v| !(1..=100000).contains(&v))
        {
            return Err(invalid(
                "Retention interval must be 0..86400; version budget must be null or 1..100000",
            ));
        }
        // Only change policy; the next edit enforces its budget.
        conn.execute("UPDATE note_history_retention SET edit_bucket_seconds=?1,max_edit_versions=?2,updated_at=?3 WHERE id=1",params![policy.edit_bucket_seconds,policy.max_edit_versions,chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos,true)])?;
        Ok(policy)
    }

    pub(crate) fn revision_format(revision: &NoteRevision, note_id: &str) -> NoteFormat {
        NoteFormat {
            note_id: note_id.into(),
            content_format: revision.content_format.clone(),
            format_version: revision.format_version,
            serializer_version: revision.serializer_version.clone(),
            baseline_version_id: None,
        }
    }

    pub(crate) fn selected_content(
        revision: &NoteRevision,
        selection: Option<&NoteHistorySelection>,
    ) -> VfsResult<String> {
        let format = Self::revision_format(revision, &revision.summary.note_id);
        NoteFormatRepo::ensure_supported(&format)?;
        let detected = NoteFormatRepo::detect(&format.note_id, &revision.content_md)?;
        if detected.content_format != format.content_format
            && !revision.content_md.trim().is_empty()
        {
            return Err(invalid("History body does not match its format envelope"));
        }
        if format.content_format == "markdown-blocks" {
            blocks(&revision.content_md)?;
        }
        if !NoteFormatRepo::required_capabilities(&detected).is_empty()
            && NoteFormatRepo::required_capabilities(&format).is_empty()
        {
            return Err(invalid("History format lacks required columns capability"));
        }
        let Some(selection) = selection else {
            return Ok(revision.content_md.clone());
        };
        let content = &revision.content_md;
        let mut starts = vec![0];
        starts.extend(content.match_indices('\n').map(|(at, _)| at + 1));
        if selection.start_line == 0
            || selection.end_line < selection.start_line
            || selection.end_line > starts.len()
        {
            return Err(invalid("History line selection is out of range"));
        }
        let start = starts[selection.start_line - 1];
        let end = starts
            .get(selection.end_line)
            .map(|next| next - 1)
            .unwrap_or(content.len());
        if start == 0 && end == content.len() {
            return Ok(content.clone());
        }
        let mut spans = Vec::new();
        let mut pending_marker = None;
        let mut covered = 0;
        for root in roots(content)? {
            if !content[covered..root.range.start].trim().is_empty() {
                return Err(invalid(
                    "Select the full document when it contains reference definitions",
                ));
            }
            covered = root.range.end;
            let raw = &content[root.range.clone()];
            if marker(raw).is_some() {
                pending_marker = Some(root.range.start);
                continue;
            }
            let effective_end = root.range.start + raw.trim_end_matches(['\n', '\r']).len();
            spans.push(pending_marker.take().unwrap_or(root.range.start)..effective_end);
        }
        if pending_marker.is_some() || !content[covered..].trim().is_empty() {
            return Err(invalid("Incomplete history structure"));
        }
        if spans
            .iter()
            .any(|r| (start > r.start && start < r.end) || (end > r.start && end < r.end))
        {
            return Err(invalid(
                "Select complete root blocks; the range cuts a Markdown or columns structure",
            ));
        }
        let selected = &content[start..end];
        NoteFormatRepo::detect(&format.note_id, selected)?;
        if format.content_format == "markdown-blocks" {
            blocks(selected)?;
        }
        Ok(selected.into())
    }

    pub fn restore_current(
        conn: &Connection,
        note_id: &str,
        version_id: &str,
        expected: &str,
        selection: Option<&NoteHistorySelection>,
    ) -> VfsResult<VfsNote> {
        Self::transaction(conn, || {
            let live = Self::current(conn, note_id)?;
            if live.updated_at != expected {
                return Err(conflict("notes.conflict"));
            }
            let current_format = NoteFormatRepo::get(conn, note_id)?;
            NoteFormatRepo::ensure_supported(&current_format)?;
            NoteFormatRepo::detect(note_id, &live.content_md)?;
            let revision = Self::get_and_pin(conn, note_id, version_id)?;
            let content = Self::selected_content(&revision, selection)?;
            let before = Self::snapshot(conn, note_id, "before_restore")?;
            Self::set_pinned(conn, note_id, &before, true)?;
            let before_seq:i64 = conn.query_row("SELECT MAX(seq) FROM note_document_revisions WHERE note_id=?1",[note_id],|r|r.get(0))?;
            let mut format = Self::revision_format(&revision, note_id);
            format.baseline_version_id = current_format.baseline_version_id;
            let note = VfsNoteRepo::update_note_with_format(
                conn,
                note_id,
                VfsUpdateNoteParams {
                    content: Some(content),
                    title: Some(revision.summary.title),
                    tags: Some(revision.tags),
                    expected_updated_at: Some(expected.into()),
                },
                Some(format),
            )?;
            let note = VfsNoteRepo::update_note_metadata_with_conn(
                conn,
                note_id,
                VfsNoteMetadataUpdate {
                    props: Some(revision.props.unwrap_or_else(|| serde_json::json!({}))),
                    expected_updated_at: Some(note.updated_at),
                    ..Default::default()
                },
            )?;
            // Force a new provenance envelope; never mutate an already synced ID.
            // Intermediate body/metadata snapshots have never left this transaction.
            conn.execute("DELETE FROM note_document_revisions WHERE note_id=?1 AND seq>?2",params![note_id,before_seq])?;
            Self::discard_unpublished_history_logs(conn)?;
            Self::snapshot_restored(conn, note_id, "restore_current", Some(version_id))?;
            Ok(note)
        })
    }
}

#[cfg(test)]
#[path = "note_history_integration_tests.rs"]
mod tests;
