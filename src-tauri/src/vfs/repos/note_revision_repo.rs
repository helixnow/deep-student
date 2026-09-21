//! Local full-document history. Call snapshot inside the note write transaction.
//! Ordinary edits retain one immutable snapshot per five-minute bucket, plus the
//! latest 100 buckets. Baselines, restores and explicitly pinned versions are never pruned.
//! Remote RowSync does not transport history; the next local write captures the
//! then-current remote document as a baseline before changing it.

use super::note_repo::{VfsNoteMetadataUpdate, VfsNoteRepo};
use crate::vfs::error::{VfsError, VfsResult};
use crate::vfs::types::{VfsCreateNoteParams, VfsNote};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::sync::LazyLock;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub struct NoteAssetRef {
    /// notes_asset (retained bytes), external_resource, or remote_url (reference only).
    pub kind: String,
    pub value: String,
}

// Generated asset keys have no whitespace. Also accept percent-encoded URLs,
// Windows separators, Markdown destinations, HTML src/srcset and CSS url().
static ASSET_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r#"notes_assets[/\\][^\s<>\"'()\[\]{},?#]+"#).unwrap()
});
static EXTERNAL_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r#"(?:https?://|pdfref://|file://)[^\s<>\"'()\[\]{}]+"#).unwrap()
});
static QUOTED_ASSET_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r#"[<\"']([^<>\"']*notes_assets[/\\][^<>\"']+)[>\"']"#).unwrap()
});

pub fn extract_asset_refs(content: &str) -> Vec<NoteAssetRef> {
    let mut refs = BTreeSet::new();
    for matched in ASSET_RE.find_iter(content) {
        refs.insert(NoteAssetRef {
            kind: "notes_asset".into(),
            value: urlencoding::decode(matched.as_str()).unwrap_or_else(|_| matched.as_str().into()).replace('\\', "/"),
        });
    }
    for cap in QUOTED_ASSET_RE.captures_iter(content) {
        let raw = &cap[1];
        if let Some(start) = raw.find("notes_assets") {
            let raw = &raw[start..];
            refs.insert(NoteAssetRef { kind: "notes_asset".into(),
                value: urlencoding::decode(raw).unwrap_or_else(|_| raw.into()).replace('\\', "/") });
        }
    }
    for matched in EXTERNAL_RE.find_iter(content) {
        let value = matched.as_str();
        // Display-only Tauri asset URLs are already represented by relative keys.
        if value.contains("notes_assets") {
            continue;
        }
        refs.insert(NoteAssetRef {
            kind: if value.starts_with("http") { "remote_url" } else { "external_resource" }.into(),
            value: value.into(),
        });
    }
    refs.into_iter().collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteRevisionSummary {
    pub version_id: String,
    pub note_id: String,
    pub parent_version_id: Option<String>,
    pub restored_from_version_id: Option<String>,
    pub title: String,
    pub source: String,
    pub created_at: String,
    pub pinned: bool,
    pub content_bytes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteRevision {
    #[serde(flatten)]
    pub summary: NoteRevisionSummary,
    pub content_md: String,
    pub tags: Vec<String>,
    pub props: Option<serde_json::Value>,
    pub asset_refs: Vec<NoteAssetRef>,
    pub content_format: String,
    pub format_version: i64,
    pub serializer_version: String,
}

#[derive(Debug, Serialize)]
pub struct NoteHistoryPage {
    pub items: Vec<NoteRevisionSummary>,
    pub next_cursor: Option<i64>,
}

pub struct NoteRevisionRepo;

impl NoteRevisionRepo {
    fn missing(version_id: &str) -> VfsError {
        VfsError::NotFound { resource_type: "Note revision (missing or pruned)".into(), id: version_id.into() }
    }

    /// Reusable nested transaction; metadata and history must commit together.
    pub(crate) fn transaction<T>(conn: &Connection, f: impl FnOnce() -> VfsResult<T>) -> VfsResult<T> {
        conn.execute_batch("SAVEPOINT note_history_write")?;
        match f() {
            Ok(value) => {
                conn.execute_batch("RELEASE note_history_write")?;
                Ok(value)
            }
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK TO note_history_write; RELEASE note_history_write");
                Err(error)
            }
        }
    }

    /// Capture actual stored state, not the caller's partial patch. Equality is
    /// structural (including props), never a serialized-map hash/string compare.
    pub(crate) fn snapshot(conn: &Connection, note_id: &str, source: &str) -> VfsResult<String> {
        let note = VfsNoteRepo::get_note_including_deleted_with_conn(conn, note_id)?
            .ok_or_else(|| Self::missing(note_id))?;
        let content: String = conn.query_row(
            "SELECT data FROM resources WHERE id = ?1", [&note.resource_id], |r| r.get(0),
        )?;
        let latest: Option<(String, i64)> = conn.query_row(
            "SELECT version_id, edit_bucket FROM note_document_revisions WHERE note_id = ?1 ORDER BY seq DESC LIMIT 1",
            [note_id], |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional()?;
        if let Some((id, _)) = &latest {
            let previous = Self::get(conn, note_id, id)?;
            if previous.content_md == content && previous.summary.title == note.title
                && previous.tags == note.tags && previous.props == note.props {
                return Ok(id.clone());
            }
        }
        let id = format!("nrev_{}", uuid::Uuid::new_v4().simple());
        let now = chrono::Utc::now();
        let bucket = now.timestamp() / 300;
        conn.execute(
            "INSERT INTO note_document_revisions
             (version_id, note_id, parent_version_id, title, content_md, tags_json, props_json,
              asset_refs_json, source, created_at, edit_bucket)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![id, note_id, latest.as_ref().map(|v| &v.0), note.title, content,
                serde_json::to_string(&note.tags).map_err(|e| VfsError::Serialization(e.to_string()))?,
                note.props.as_ref().map(serde_json::to_string).transpose().map_err(|e| VfsError::Serialization(e.to_string()))?,
                serde_json::to_string(&Self::document_asset_refs(&content, note.props.as_ref())).map_err(|e| VfsError::Serialization(e.to_string()))?,
                source, now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true), bucket],
        )?;
        if source == "edit" {
            // Replace retention of intermediate edits, never mutate their identity/body.
            if let Some((previous, previous_bucket)) = latest {
                if previous_bucket == bucket {
                    conn.execute("DELETE FROM note_document_revisions WHERE version_id = ?1 AND source = 'edit' AND pinned = 0", [previous])?;
                }
            }
            conn.execute(
                "DELETE FROM note_document_revisions WHERE note_id = ?1 AND source = 'edit' AND pinned = 0
                 AND seq NOT IN (SELECT seq FROM note_document_revisions WHERE note_id = ?1 AND source = 'edit' AND pinned = 0 ORDER BY seq DESC LIMIT 100)",
                [note_id],
            )?;
        }
        Ok(id)
    }

    pub fn list(conn: &Connection, note_id: &str, cursor: Option<i64>, limit: u32) -> VfsResult<NoteHistoryPage> {
        Self::list_filtered(conn, note_id, cursor, limit, false)
    }

    /// The retained-only view includes every local pin (including old preview
    /// pins and restore protection), even if it is beyond the first history page.
    pub fn list_filtered(
        conn: &Connection,
        note_id: &str,
        cursor: Option<i64>,
        limit: u32,
        pinned_only: bool,
    ) -> VfsResult<NoteHistoryPage> {
        let limit = limit.clamp(1, 100) as usize;
        let mut stmt = conn.prepare(
            "SELECT seq, version_id, note_id, parent_version_id, restored_from_version_id,
             title, source, created_at, pinned, length(CAST(content_md AS BLOB))
             FROM note_document_revisions WHERE note_id = ?1 AND (?2 IS NULL OR seq < ?2)
             AND (?4 = 0 OR pinned = 1)
             ORDER BY seq DESC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![note_id, cursor, limit + 1, pinned_only], |r| Ok((r.get::<_, i64>(0)?, Self::summary(r, 1)?)))?;
        let mut rows = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        let next_cursor = if rows.len() > limit { Some(rows[limit - 1].0) } else { None };
        rows.truncate(limit);
        Ok(NoteHistoryPage { items: rows.into_iter().map(|(_, v)| v).collect(), next_cursor })
    }

    fn summary(r: &rusqlite::Row, offset: usize) -> rusqlite::Result<NoteRevisionSummary> {
        Ok(NoteRevisionSummary {
            version_id: r.get(offset)?, note_id: r.get(offset + 1)?,
            parent_version_id: r.get(offset + 2)?, restored_from_version_id: r.get(offset + 3)?,
            title: r.get(offset + 4)?, source: r.get(offset + 5)?, created_at: r.get(offset + 6)?,
            pinned: r.get(offset + 7)?, content_bytes: r.get(offset + 8)?,
        })
    }

    pub fn get(conn: &Connection, note_id: &str, version_id: &str) -> VfsResult<NoteRevision> {
        let raw = conn.query_row(
            "SELECT version_id, note_id, parent_version_id, restored_from_version_id,
             title, source, created_at, pinned, length(CAST(content_md AS BLOB)),
             content_md, tags_json, props_json, asset_refs_json, content_format, format_version, serializer_version
             FROM note_document_revisions WHERE note_id = ?1 AND version_id = ?2",
            params![note_id, version_id], |r| Ok((Self::summary(r, 0)?, r.get::<_, String>(9)?,
                r.get::<_, String>(10)?, r.get::<_, Option<String>>(11)?, r.get::<_, String>(12)?,
                r.get::<_, String>(13)?, r.get::<_, i64>(14)?, r.get::<_, String>(15)?)),
        ).optional()?.ok_or_else(|| Self::missing(version_id))?;
        Ok(NoteRevision {
            summary: raw.0, content_md: raw.1,
            tags: serde_json::from_str(&raw.2).map_err(|e| VfsError::Serialization(e.to_string()))?,
            props: raw.3.map(|s| serde_json::from_str(&s)).transpose().map_err(|e| VfsError::Serialization(e.to_string()))?,
            asset_refs: serde_json::from_str(&raw.4).map_err(|e| VfsError::Serialization(e.to_string()))?,
            content_format: raw.5, format_version: raw.6, serializer_version: raw.7,
        })
    }

    /// Pins are local retention choices, not external block-reference leases.
    /// Explicit release changes retention only; it does not prune the version or
    /// drop its asset references. The next normal save may prune eligible edits.
    pub fn set_pinned(
        conn: &Connection,
        note_id: &str,
        version_id: &str,
        pinned: bool,
    ) -> VfsResult<NoteRevisionSummary> {
        Self::transaction(conn, || {
            let revision = Self::get(conn, note_id, version_id)?;
            conn.execute(
                "UPDATE note_document_revisions SET pinned = ?1 WHERE note_id = ?2 AND version_id = ?3",
                params![pinned, note_id, version_id],
            )?;
            Ok(NoteRevisionSummary { pinned, ..revision.summary })
        })
    }

    /// Used by restore, not by preview: lookup and protection of the exact
    /// immutable version happen inside the restore transaction. A pruned target
    /// fails explicitly; never restore the current document as a substitute.
    pub(crate) fn get_and_pin(conn: &Connection, note_id: &str, version_id: &str) -> VfsResult<NoteRevision> {
        Self::transaction(conn, || {
            let mut revision = Self::get(conn, note_id, version_id)?;
            conn.execute("UPDATE note_document_revisions SET pinned = 1 WHERE version_id = ?1", [version_id])?;
            revision.summary.pinned = true;
            Ok(revision)
        })
    }

    /// Original note (including unsaved editor input) is untouched. Current
    /// stored state and restore source are protected in the same transaction.
    pub fn restore_copy(conn: &Connection, note_id: &str, version_id: &str) -> VfsResult<VfsNote> {
        Self::transaction(conn, || {
            let revision = Self::get_and_pin(conn, note_id, version_id)?;
            let current_id = Self::snapshot(conn, note_id, "before_restore")?;
            conn.execute("UPDATE note_document_revisions SET pinned = 1 WHERE version_id = ?1", [&current_id])?;
            let base: String = revision.summary.title.chars().take(450).collect();
            let title = VfsNoteRepo::generate_unique_note_title_with_conn(conn, &format!("{}（历史副本）", base), None)?;
            let note = VfsNoteRepo::create_note_in_folder_uncommitted(conn, VfsCreateNoteParams {
                title, content: revision.content_md, tags: revision.tags,
            }, None)?;
            let note = if let Some(props) = revision.props {
                VfsNoteRepo::update_note_metadata_with_conn(conn, &note.id, VfsNoteMetadataUpdate { props: Some(props), ..Default::default() })?
            } else { note };
            // These rows have not left this transaction. Publish a single complete
            // restore envelope for the new copy, including its restored props.
            conn.execute("DELETE FROM note_document_revisions WHERE note_id = ?1", [&note.id])?;
            let id = Self::snapshot(conn, &note.id, "restore_copy")?;
            conn.execute("UPDATE note_document_revisions SET restored_from_version_id = ?1 WHERE version_id = ?2", params![version_id, id])?;
            Ok(note)
        })
    }

    /// One reference policy for orphan scans, explicit deletion, purge and journal recovery.
    fn document_asset_refs(content: &str, props: Option<&serde_json::Value>) -> Vec<NoteAssetRef> {
        let mut refs: BTreeSet<_> = extract_asset_refs(content).into_iter().collect();
        if let Some(props) = props.and_then(|p| p.as_object()) {
            for value in props.values().filter_map(|v| v.as_str()) {
                refs.extend(extract_asset_refs(value));
            }
        }
        refs.into_iter().collect()
    }

    pub fn retained_asset_paths(conn: &Connection) -> VfsResult<BTreeSet<String>> {
        let mut paths = BTreeSet::new();
        let mut stmt = conn.prepare("SELECT COALESCE(r.data, ''), n.props FROM notes n JOIN resources r ON r.id = n.resource_id")?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))? {
            let (content, props) = row?;
            let props: Option<serde_json::Value> = props.map(|s| serde_json::from_str(&s)).transpose().map_err(|e| VfsError::Serialization(e.to_string()))?;
            paths.extend(Self::document_asset_refs(&content, props.as_ref()).into_iter().filter(|r| r.kind == "notes_asset").map(|r| r.value));
        }
        let mut stmt = conn.prepare("SELECT asset_refs_json FROM note_document_revisions")?;
        for row in stmt.query_map([], |r| r.get::<_, String>(0))? {
            let refs: Vec<NoteAssetRef> = serde_json::from_str(&row?).map_err(|e| VfsError::Serialization(e.to_string()))?;
            paths.extend(refs.into_iter().filter(|r| r.kind == "notes_asset").map(|r| r.value));
        }
        Ok(paths)
    }

    pub fn asset_is_referenced(conn: &Connection, relative_path: &str) -> VfsResult<bool> {
        let path = relative_path.replace('\\', "/");
        let path = path.trim_start_matches("active/").trim_start_matches("./");
        if !path.starts_with("notes_assets/") { return Ok(false); }
        Ok(Self::retained_asset_paths(conn)?.contains(path))
    }
}

#[cfg(test)]
#[path = "note_revision_tests.rs"]
mod tests;
