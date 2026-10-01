//! Relationships are identified by resource ID + typed locator, never title.
use super::{
    note_format_repo::{blocks, conflict, invalid},
    note_repo::VfsNoteRepo,
    note_revision_repo::NoteRevisionRepo,
    note_transfer_repo::{decode, json},
};
use crate::vfs::error::VfsResult;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum NoteLocator {
    Whole,
    Block(String),
    Page(u32),
    Card(String),
    Question(String),
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoteRelationType {
    Source,
    Card,
    Mistake,
}
impl NoteRelationType {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Source => "source",
            Self::Card => "card",
            Self::Mistake => "mistake",
        }
    }
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoteRelationPut {
    pub id: String,
    pub note_id: String,
    pub block_id: Option<String>,
    pub r#type: NoteRelationType,
    pub resource_id: String,
    pub locator: NoteLocator,
    pub expected_revision: Option<i64>,
}
#[derive(Debug, Serialize)]
pub struct NoteRelation {
    pub id: String,
    pub note_id: String,
    pub block_id: Option<String>,
    pub r#type: NoteRelationType,
    pub resource_id: String,
    pub locator: NoteLocator,
    pub revision: i64,
    pub invalidated_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub reference: NoteReferenceStatus,
}
#[derive(Debug, Serialize)]
pub struct NoteReferenceStatus {
    pub resource_exists: bool,
    pub locator_exists: bool,
}

pub struct NoteRelationRepo;
impl NoteRelationRepo {
    /// Includes both resources.deleted_at and the source entity's trash state.
    pub fn reference_status(
        conn: &Connection,
        anki: Option<&Connection>,
        resource_id: &str,
        locator: &NoteLocator,
    ) -> VfsResult<NoteReferenceStatus> {
        // Anki documents live in the dedicated Anki database, not resources.data.
        // For a card locator resource_id is the stable document_tasks.document_id.
        if let NoteLocator::Card(card_id) = locator {
            let anki = anki
                .ok_or_else(|| invalid("Anki database connection required for card references"))?;
            let resource_exists = anki.query_row("SELECT EXISTS(SELECT 1 FROM document_tasks WHERE document_id=?1 AND deleted_at IS NULL)", [resource_id], |r| r.get(0))?;
            let locator_exists = anki.query_row("SELECT EXISTS(SELECT 1 FROM anki_cards c JOIN document_tasks t ON t.id=c.task_id WHERE t.document_id=?1 AND c.id=?2 AND c.deleted_at IS NULL AND t.deleted_at IS NULL)", params![resource_id,card_id], |r| r.get(0))?;
            return Ok(NoteReferenceStatus {
                resource_exists,
                locator_exists,
            });
        }
        let resource: Option<(String, Option<String>)> = conn.query_row("SELECT type,data FROM resources r WHERE id=?1 AND deleted_at IS NULL
            AND NOT EXISTS(SELECT 1 FROM notes n WHERE n.resource_id=r.id AND n.deleted_at IS NOT NULL)
            AND NOT EXISTS(SELECT 1 FROM files f WHERE f.resource_id=r.id AND f.deleted_at IS NOT NULL)
            AND NOT EXISTS(SELECT 1 FROM exam_sheets e WHERE e.resource_id=r.id AND e.deleted_at IS NOT NULL)", [resource_id], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
        let Some((kind, data)) = resource else {
            return Ok(NoteReferenceStatus {
                resource_exists: false,
                locator_exists: false,
            });
        };
        let locator_exists = match locator {
            NoteLocator::Whole => true,
            NoteLocator::Block(id) => kind == "note" && blocks(data.as_deref().unwrap_or("")).map(|bs| bs.iter().any(|b| b.id == id)).unwrap_or(false),
            NoteLocator::Page(page) => *page > 0 && conn.query_row("SELECT EXISTS(SELECT 1 FROM files WHERE resource_id=?1 AND deleted_at IS NULL AND page_count>=?2)", params![resource_id,page], |r| r.get(0))?,
            NoteLocator::Question(id) => conn.query_row("SELECT EXISTS(SELECT 1 FROM questions q JOIN exam_sheets e ON e.id=q.exam_id WHERE e.resource_id=?1 AND e.deleted_at IS NULL AND q.id=?2 AND q.deleted_at IS NULL)", params![resource_id,id], |r| r.get(0))?,
            NoteLocator::Card(_) => unreachable!("card references handled by the Anki database above"),
        };
        Ok(NoteReferenceStatus {
            resource_exists: true,
            locator_exists,
        })
    }

    pub fn get(
        conn: &Connection,
        anki: Option<&Connection>,
        id: &str,
    ) -> VfsResult<Option<NoteRelation>> {
        let raw = conn.query_row("SELECT id,note_id,block_id,relation_type,resource_id,locator_json,revision,invalidated_at,created_at,updated_at FROM note_learning_relations WHERE id=?1", [id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?,r.get::<_,i64>(6)?,r.get::<_,Option<String>>(7)?,r.get::<_,String>(8)?,r.get::<_,String>(9)?))).optional()?;
        raw.map(|r| {
            let locator = decode(&r.5)?;
            let reference = Self::reference_status(conn, anki, &r.4, &locator)?;
            Ok(NoteRelation {
                id: r.0,
                note_id: r.1,
                block_id: r.2,
                r#type: decode(&json(&r.3)?)?,
                resource_id: r.4,
                locator,
                revision: r.6,
                invalidated_at: r.7,
                created_at: r.8,
                updated_at: r.9,
                reference,
            })
        })
        .transpose()
    }
    pub fn list(
        conn: &Connection,
        anki: Option<&Connection>,
        note_id: &str,
    ) -> VfsResult<Vec<NoteRelation>> {
        let mut stmt =
            conn.prepare("SELECT id FROM note_learning_relations WHERE note_id=?1 ORDER BY id")?;
        let ids = stmt
            .query_map([note_id], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut rows = Vec::new();
        for id in ids {
            if let Some(row) = Self::get(conn, anki, &id)? {
                rows.push(row);
            }
        }
        Ok(rows)
    }
    pub fn put(
        conn: &Connection,
        anki: Option<&Connection>,
        request: NoteRelationPut,
    ) -> VfsResult<NoteRelation> {
        NoteRevisionRepo::transaction(conn, || {
            if request.id.trim().is_empty() {
                return Err(invalid("Relation ID required"));
            }
            if matches!(request.r#type, NoteRelationType::Card)
                && !matches!(request.locator, NoteLocator::Card(_))
                || matches!(request.r#type, NoteRelationType::Mistake)
                    && !matches!(request.locator, NoteLocator::Question(_))
            {
                return Err(invalid(
                    "card/mistake relations require the corresponding typed locator",
                ));
            }
            let content = VfsNoteRepo::get_note_content_with_conn(conn, &request.note_id)?
                .ok_or_else(|| invalid("Owner note missing"))?;
            if let Some(id) = &request.block_id {
                if !blocks(&content)?.iter().any(|b| b.id == id) {
                    return Err(invalid("Owner block missing"));
                }
            }
            let status =
                Self::reference_status(conn, anki, &request.resource_id, &request.locator)?;
            if !status.resource_exists || !status.locator_exists {
                return Err(invalid("Referenced resource or locator missing"));
            }
            let changed = if let Some(revision) = request.expected_revision {
                conn.execute("UPDATE note_learning_relations SET block_id=?1,relation_type=?2,resource_id=?3,locator_json=?4,revision=revision+1,invalidated_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?5 AND note_id=?6 AND revision=?7", params![request.block_id,request.r#type.as_str(),request.resource_id,json(&request.locator)?,request.id,request.note_id,revision])?
            } else {
                conn.execute("INSERT INTO note_learning_relations(id,note_id,block_id,relation_type,resource_id,locator_json,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(id) DO NOTHING", params![request.id,request.note_id,request.block_id,request.r#type.as_str(),request.resource_id,json(&request.locator)?])?
            };
            if changed != 1 {
                return Err(conflict("notes.relation_conflict"));
            }
            Self::get(conn, anki, &request.id)?
                .ok_or_else(|| invalid("Relation missing after write"))
        })
    }
    pub fn delete(conn: &Connection, id: &str, expected_revision: i64) -> VfsResult<bool> {
        if conn.execute(
            "DELETE FROM note_learning_relations WHERE id=?1 AND revision=?2",
            params![id, expected_revision],
        )? != 1
        {
            return Err(conflict("notes.relation_conflict"));
        }
        Ok(true)
    }
    /// Explicit invalidation for callers deleting targets outside this VFS DB.
    pub fn invalidate_resource(conn: &Connection, resource_id: &str) -> VfsResult<usize> {
        Ok(conn.execute("UPDATE note_learning_relations SET invalidated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1 WHERE resource_id=?1 AND invalidated_at IS NULL", [resource_id])?)
    }
    pub(crate) fn invalidate_missing_blocks(conn: &Connection, note_id: &str) -> VfsResult<()> {
        let note = VfsNoteRepo::get_note_with_conn(conn, note_id)?
            .ok_or_else(|| invalid("Note missing"))?;
        let content = VfsNoteRepo::get_note_content_with_conn(conn, note_id)?.unwrap_or_default();
        let ids = blocks(&content)
            .unwrap_or_default()
            .into_iter()
            .map(|b| b.id.to_string())
            .collect::<std::collections::BTreeSet<_>>();
        let mut stmt = conn.prepare("SELECT id,block_id,locator_json,note_id,resource_id FROM note_learning_relations WHERE (note_id=?1 OR resource_id=?2) AND invalidated_at IS NULL")?;
        let rows = stmt
            .query_map(params![note_id, note.resource_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (id, block, raw, owner, resource) in rows {
            let locator: NoteLocator = decode(&raw)?;
            let missing_owner =
                owner == note_id && block.as_ref().is_some_and(|b| !ids.contains(b));
            let missing_target = resource == note.resource_id
                && matches!(locator, NoteLocator::Block(ref b) if !ids.contains(b));
            if missing_owner || missing_target {
                conn.execute("UPDATE note_learning_relations SET invalidated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1 WHERE id=?1", [id])?;
            }
        }
        Ok(())
    }
}
