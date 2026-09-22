//! Stable block format v1: root-level HTML markers, one per top-level Markdown node.
use super::note_structure::roots;
use super::{note_repo::VfsNoteRepo, note_revision_repo::NoteRevisionRepo};
use crate::vfs::{
    error::{VfsError, VfsResult},
    types::{VfsNote, VfsUpdateNoteParams},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const COLUMNS_CAPABILITY: &str = "ds-columns-v1";

pub(crate) fn invalid(reason: impl Into<String>) -> VfsError {
    VfsError::InvalidArgument {
        param: "note_document".into(),
        reason: reason.into(),
    }
}
pub(crate) fn conflict(key: &str) -> VfsError {
    VfsError::Conflict {
        key: key.into(),
        message: "Stored revision changed; reload before retrying".into(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NoteFormat {
    pub note_id: String,
    pub content_format: String,
    pub format_version: i64,
    pub serializer_version: String,
    pub baseline_version_id: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct StableBlock<'a> {
    pub id: &'a str,
    pub body: &'a str,
}

pub(crate) fn marker(text: &str) -> Option<&str> {
    let id = text
        .trim_end_matches(['\n', '\r'])
        .strip_prefix("<!-- ds:block-id=")?
        .strip_suffix(" -->")?;
    if !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        Some(id)
    } else {
        None
    }
}

pub(crate) fn blocks(content: &str) -> VfsResult<Vec<StableBlock<'_>>> {
    let ranges = roots(content)?;
    let mut ids = BTreeSet::new();
    let mut result = Vec::new();
    let mut pending = None;
    let mut covered = 0;
    for root in ranges {
        let range = root.range;
        // Parser can omit reference definitions: those cannot silently disappear
        // during transfer or migration and are rejected by this v1 envelope.
        if !content[covered..range.start].trim().is_empty() {
            return Err(invalid("Unmarked Markdown content"));
        }
        let text = &content[range.clone()];
        if let Some(id) = marker(text) {
            if pending.is_some() || !ids.insert(id) {
                return Err(invalid("Duplicate or consecutive block marker"));
            }
            pending = Some(id);
        } else {
            let id = pending
                .take()
                .ok_or_else(|| invalid("Every root Markdown node requires a block marker"))?;
            // Exact root body; whitespace separating nodes is not document text.
            result.push(StableBlock {
                id,
                body: text.trim_end_matches(['\n', '\r']),
            });
        }
        covered = range.end;
    }
    if pending.is_some() || !content[covered..].trim().is_empty() {
        return Err(invalid("Incomplete block document"));
    }
    Ok(result)
}

pub struct NoteFormatRepo;
impl NoteFormatRepo {
    pub fn get(conn: &Connection, note_id: &str) -> VfsResult<NoteFormat> {
        let stored = conn.query_row("SELECT content_format, format_version, serializer_version, baseline_version_id FROM note_document_formats WHERE note_id=?1", [note_id], |r| Ok(NoteFormat {
            note_id: note_id.into(), content_format: r.get(0)?, format_version: r.get(1)?, serializer_version: r.get(2)?, baseline_version_id: r.get(3)?,
        })).optional()?;
        if let Some(stored) = stored {
            return Ok(stored);
        }
        // History/restore-copy also reads trashed legacy pages lacking a format row.
        let content: String = conn
            .query_row(
                "SELECT r.data FROM notes n JOIN resources r ON r.id=n.resource_id WHERE n.id=?1",
                [note_id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| invalid("Note not found"))?;
        Self::detect(note_id, &content)
    }

    pub(crate) fn detect(note_id: &str, content: &str) -> VfsResult<NoteFormat> {
        // Reserve root ds: headers for versioned envelopes. Old writers must
        // never strip unknown schema headers in an imported/synced document.
        let ranges = roots(content)?;
        if ranges.iter().any(|r| {
            content[r.range.clone()]
                .trim_start()
                .starts_with("<!-- ds:")
                && marker(&content[r.range.clone()]).is_none()
        }) {
            return Err(invalid(
                "Unsupported note schema/marker; open with a compatible editor",
            ));
        }
        let stable = ranges
            .iter()
            .any(|r| marker(&content[r.range.clone()]).is_some());
        let columns = ranges.iter().any(|r| r.columns);
        if stable {
            blocks(content)?;
        }
        Ok(NoteFormat {
            note_id: note_id.into(),
            content_format: if stable {
                "markdown-blocks"
            } else {
                "markdown-legacy"
            }
            .into(),
            format_version: 1,
            serializer_version: Self::serializer(stable, columns),
            baseline_version_id: None,
        })
    }

    pub(crate) fn insert(conn: &Connection, format: &NoteFormat) -> VfsResult<()> {
        conn.execute("INSERT INTO note_document_formats(note_id,content_format,format_version,serializer_version,baseline_version_id,updated_at) VALUES(?1,?2,?3,?4,?5,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(note_id) DO UPDATE SET content_format=excluded.content_format,format_version=excluded.format_version,serializer_version=excluded.serializer_version,baseline_version_id=excluded.baseline_version_id,updated_at=excluded.updated_at",
            params![format.note_id, format.content_format, format.format_version, format.serializer_version, format.baseline_version_id])?;
        Ok(())
    }

    pub(crate) fn ensure_supported(format: &NoteFormat) -> VfsResult<()> {
        if format.format_version != 1
            || !matches!(
                format.content_format.as_str(),
                "markdown-legacy" | "markdown-blocks"
            )
            || ![
                Self::serializer(format.content_format == "markdown-blocks", false),
                Self::serializer(format.content_format == "markdown-blocks", true),
            ]
            .contains(&format.serializer_version)
        {
            return Err(invalid("Unsupported future note format; write refused"));
        }
        Ok(())
    }

    pub(crate) fn validate_write(conn: &Connection, id: &str, content: &str) -> VfsResult<()> {
        Self::validate_write_capabilities(conn, id, content, &[])
    }

    pub(crate) fn serializer(stable: bool, columns: bool) -> String {
        format!(
            "{}{}",
            if stable { "blocks-v1" } else { "markdown-v1" },
            if columns { "+ds-columns-v1" } else { "" }
        )
    }

    pub fn required_capabilities(format: &NoteFormat) -> Vec<String> {
        if format.serializer_version.ends_with("+ds-columns-v1") {
            vec![COLUMNS_CAPABILITY.into()]
        } else {
            vec![]
        }
    }

    pub(crate) fn validate_write_capabilities(
        conn: &Connection,
        id: &str,
        content: &str,
        capabilities: &[String],
    ) -> VfsResult<()> {
        let format = Self::get(conn, id)?;
        Self::ensure_supported(&format)?;
        // Check stored body too: a sync/import may have changed the envelope.
        let old = VfsNoteRepo::get_note_content_with_conn(conn, id)?
            .ok_or_else(|| invalid("Note missing"))?;
        let old_detected = Self::detect(id, &old)?;
        let proposed = Self::detect(id, content)?;
        let enabled = !Self::required_capabilities(&format).is_empty();
        if enabled && !capabilities.iter().any(|c| c == COLUMNS_CAPABILITY) {
            return Err(invalid(
                "This page requires the ds-columns-v1 writer capability",
            ));
        }
        if !enabled
            && (!Self::required_capabilities(&proposed).is_empty()
                || !Self::required_capabilities(&old_detected).is_empty())
        {
            return Err(invalid(
                "Enable ds-columns-v1 explicitly with notes_enable_columns before saving",
            ));
        }
        if format.content_format == "markdown-blocks" {
            blocks(content)?;
        } else if proposed.content_format == "markdown-blocks" {
            return Err(invalid(
                "Use notes_migrate_blocks to upgrade this page explicitly",
            ));
        }
        Ok(())
    }

    /// Frontend supplies its marked serialization, but removing only root marker
    /// lines must reproduce the stored legacy Markdown byte-for-byte.
    pub fn migrate(
        conn: &Connection,
        id: &str,
        expected: &str,
        content: &str,
    ) -> VfsResult<VfsNote> {
        NoteRevisionRepo::transaction(conn, || {
            let current = VfsNoteRepo::get_note_with_conn(conn, id)?
                .ok_or_else(|| invalid("Note missing"))?;
            if current.updated_at != expected {
                return Err(conflict("notes.conflict"));
            }
            let format = Self::get(conn, id)?;
            Self::ensure_supported(&format)?;
            if format.content_format != "markdown-legacy" {
                return Err(invalid("Page already uses stable blocks"));
            }
            blocks(content)?;
            let mut stripped = String::new();
            let mut cursor = 0;
            for root in roots(content)? {
                let range = root.range;
                if marker(&content[range.clone()]).is_some() {
                    stripped.push_str(&content[cursor..range.start]);
                    cursor = range.end;
                }
            }
            stripped.push_str(&content[cursor..]);
            let old = VfsNoteRepo::get_note_content_with_conn(conn, id)?
                .ok_or_else(|| invalid("Note missing"))?;
            if stripped != old {
                return Err(invalid(
                    "Migration may only insert root block markers, not change content",
                ));
            }
            let baseline = NoteRevisionRepo::snapshot(conn, id, "format_baseline")?;
            // The dedicated baseline reference is protected independently of UI pins.
            VfsNoteRepo::update_note_with_format(
                conn,
                id,
                VfsUpdateNoteParams {
                    content: Some(content.into()),
                    expected_updated_at: Some(expected.into()),
                    ..Default::default()
                },
                Some(NoteFormat {
                    content_format: "markdown-blocks".into(),
                    serializer_version: Self::serializer(
                        true,
                        !Self::required_capabilities(&format).is_empty(),
                    ),
                    baseline_version_id: Some(baseline),
                    ..format
                }),
            )
        })
    }

    /// Capability-only opt-in: no reserialization and no body change. Advancing
    /// the note OCC token makes pre-upgrade editor snapshots stale.
    pub fn enable_columns(conn: &Connection, id: &str, expected: &str) -> VfsResult<VfsNote> {
        NoteRevisionRepo::transaction(conn, || {
            let current = VfsNoteRepo::get_note_with_conn(conn, id)?
                .ok_or_else(|| invalid("Note missing"))?;
            if current.updated_at != expected {
                return Err(conflict("notes.conflict"));
            }
            let mut format = Self::get(conn, id)?;
            Self::ensure_supported(&format)?;
            let content = VfsNoteRepo::get_note_content_with_conn(conn, id)?
                .ok_or_else(|| invalid("Note missing"))?;
            Self::detect(id, &content)?;
            if !Self::required_capabilities(&format).is_empty() {
                return Ok(current);
            }
            let baseline = NoteRevisionRepo::snapshot(conn, id, "format_baseline")?;
            NoteRevisionRepo::set_pinned(conn, id, &baseline, true)?;
            if format.baseline_version_id.is_none() {
                format.baseline_version_id = Some(baseline);
            }
            format.serializer_version =
                Self::serializer(format.content_format == "markdown-blocks", true);
            VfsNoteRepo::update_note_with_format(
                conn,
                id,
                VfsUpdateNoteParams {
                    content: Some(content),
                    expected_updated_at: Some(expected.into()),
                    ..Default::default()
                },
                Some(format),
            )
        })
    }
}
