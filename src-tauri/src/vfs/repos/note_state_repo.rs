//! Per-entry CAS state, shared by all WebViews on the same VFS database.
use super::{
    note_format_repo::{conflict, invalid},
    note_repo::VfsNoteRepo,
    note_revision_repo::NoteRevisionRepo,
    note_transfer_repo::{decode, json},
};
use crate::vfs::error::VfsResult;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoteStateType {
    Review,
    Draft,
}
impl NoteStateType {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Review => "review",
            Self::Draft => "draft",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoteStateKey {
    pub note_id: String,
    pub r#type: NoteStateType,
    pub key: String,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoteStateList {
    pub note_id: String,
    pub r#type: NoteStateType,
    #[serde(default)]
    pub include_deleted: bool,
}
#[derive(Debug, Deserialize)]
pub struct NoteStatePut {
    #[serde(flatten)]
    pub entry: NoteStateKey,
    /// null = create only. Existing entries (including tombstones) require their revision.
    pub expected_revision: Option<i64>,
    pub value: serde_json::Value,
}
#[derive(Debug, Deserialize)]
pub struct NoteStateDelete {
    #[serde(flatten)]
    pub entry: NoteStateKey,
    pub expected_revision: i64,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct NoteState {
    pub note_id: String,
    pub r#type: NoteStateType,
    pub key: String,
    pub value: serde_json::Value,
    pub revision: i64,
    pub deleted: bool,
    pub updated_at: String,
}

pub struct NoteStateRepo;
impl NoteStateRepo {
    fn validate(conn: &Connection, entry: &NoteStateKey) -> VfsResult<()> {
        if entry.key.is_empty() || entry.key.len() > 512 {
            return Err(invalid("State key must contain 1..512 bytes"));
        }
        if VfsNoteRepo::get_note_with_conn(conn, &entry.note_id)?.is_none() {
            return Err(invalid("Note missing or deleted"));
        }
        Ok(())
    }
    /// Tombstones are returned so a reopened WebView can obtain the next CAS token.
    pub fn get(conn: &Connection, entry: &NoteStateKey) -> VfsResult<Option<NoteState>> {
        Self::validate(conn, entry)?;
        let raw: Option<(String, i64, bool, String)> = conn.query_row("SELECT value_json,revision,deleted,updated_at FROM note_state WHERE note_id=?1 AND state_type=?2 AND state_key=?3", params![entry.note_id, entry.r#type.as_str(), entry.key], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        raw.map(|(value, revision, deleted, updated_at)| {
            Ok(NoteState {
                note_id: entry.note_id.clone(),
                r#type: entry.r#type.clone(),
                key: entry.key.clone(),
                value: decode(&value)?,
                revision,
                deleted,
                updated_at,
            })
        })
        .transpose()
    }
    pub fn list(conn: &Connection, request: &NoteStateList) -> VfsResult<Vec<NoteState>> {
        Self::validate(
            conn,
            &NoteStateKey {
                note_id: request.note_id.clone(),
                r#type: request.r#type.clone(),
                key: "list".into(),
            },
        )?;
        let mut stmt = conn.prepare("SELECT state_key,value_json,revision,deleted,updated_at FROM note_state WHERE note_id=?1 AND state_type=?2 AND (?3 OR deleted=0) ORDER BY state_key")?;
        let rows = stmt.query_map(
            params![
                request.note_id,
                request.r#type.as_str(),
                request.include_deleted
            ],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, bool>(3)?,
                    r.get::<_, String>(4)?,
                ))
            },
        )?;
        rows.map(|row| {
            let (key, value, revision, deleted, updated_at) = row?;
            Ok(NoteState {
                note_id: request.note_id.clone(),
                r#type: request.r#type.clone(),
                key,
                value: decode(&value)?,
                revision,
                deleted,
                updated_at,
            })
        })
        .collect()
    }
    pub fn put(conn: &Connection, request: NoteStatePut) -> VfsResult<NoteState> {
        Self::write(
            conn,
            request.entry,
            request.expected_revision,
            request.value,
            false,
        )
    }
    pub fn delete(conn: &Connection, request: NoteStateDelete) -> VfsResult<NoteState> {
        Self::write(
            conn,
            request.entry,
            Some(request.expected_revision),
            serde_json::Value::Null,
            true,
        )
    }
    fn write(
        conn: &Connection,
        entry: NoteStateKey,
        expected: Option<i64>,
        value: serde_json::Value,
        deleted: bool,
    ) -> VfsResult<NoteState> {
        NoteRevisionRepo::transaction(conn, || {
            Self::validate(conn, &entry)?;
            let changed = if let Some(expected) = expected {
                conn.execute("UPDATE note_state SET value_json=?1,revision=revision+1,deleted=?2,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE note_id=?3 AND state_type=?4 AND state_key=?5 AND revision=?6",
                    params![json(&value)?, deleted, entry.note_id, entry.r#type.as_str(), entry.key, expected])?
            } else {
                conn.execute("INSERT INTO note_state(note_id,state_type,state_key,value_json,revision,deleted,updated_at) VALUES(?1,?2,?3,?4,1,0,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(note_id,state_type,state_key) DO NOTHING", params![entry.note_id, entry.r#type.as_str(), entry.key, json(&value)?])?
            };
            if changed != 1 {
                return Err(conflict("notes.state_conflict"));
            }
            Self::get(conn, &entry)?.ok_or_else(|| invalid("State missing after write"))
        })
    }
}
