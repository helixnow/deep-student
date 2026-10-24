//! OCC-safe question-group / shared-material administration.
//!
//! This module is the write boundary for administrative group edits that happen
//! after authoring has committed:
//!
//! - member add/reorder/remove (`update_group`)
//! - split a group into per-question solo groups (`ungroup`)
//! - delete a group while preserving or deleting its members (`delete_group`)
//! - delete only materials that no live group still references
//!   (`delete_unused_materials`)
//!
//! Every mutation is a single `IMMEDIATE` SQLite transaction with explicit
//! optimistic versions. Canonical preview, question-bank statistics and the
//! resource text index are refreshed from the same transaction so readers never
//! observe a half-migrated structure.
//!
//! Material preservation rule: a child removed from a group that owns shared
//! material is never left with an unsolvable dangling dependency. When material
//! exists, the removed child is moved into a new solo group whose
//! `qbank_group_materials` rows attach the current material context (the
//! canonical `QuestionMaterial` entities). Material content is never copied into
//! the question body or duplicated into new material rows, and existing
//! `answer_submissions.question_snapshot_json` / `material_snapshot_json` rows
//! are left untouched.

use crate::models::AppError;
use crate::qbank_authoring_service::refresh_canonical_preview_with_conn;
use crate::qbank_document::QuestionMaterial;
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::VfsQuestionRepo;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

#[cfg(test)]
#[path = "qbank_management/tests.rs"]
mod tests;

fn storage(error: impl std::fmt::Display) -> AppError {
    AppError::database(error.to_string())
}

fn conflict(message: &str) -> AppError {
    // Keep the same wire-level marker as the authoring service so IPC/chat
    // clients can recognize a stale optimistic version.
    AppError::validation(format!("CONFLICT: {message}"))
}

fn validation(message: &str) -> AppError {
    AppError::validation(message)
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", nanoid::nanoid!(16))
}

/// Canonical administrative view of one exam's material/group structure.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionBankStructure {
    pub exam_id: String,
    pub materials: Vec<QuestionMaterial>,
    pub groups: Vec<QuestionGroupView>,
}

/// One group as exposed to IPC/chat tools.
///
/// `version` is `qbank_groups.local_version`; callers must send it back as
/// `expected_version` for any mutation. `material_ids` and `question_ids` are
/// ordered projections of the authoritative association rows.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionGroupView {
    pub id: String,
    pub exam_id: String,
    pub label: String,
    pub position: i64,
    pub version: i64,
    #[serde(default)]
    pub material_ids: Vec<String>,
    #[serde(default)]
    pub question_ids: Vec<String>,
}

/// Result of `update_group`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupUpdateResult {
    pub exam_id: String,
    pub group: QuestionGroupView,
    /// Children that left the group during this call.
    pub removed_question_ids: Vec<String>,
    /// Solo groups created to preserve material dependencies for removed
    /// children. Empty when no removal was requested or those children had no
    /// shared material.
    pub solo_group_ids: Vec<String>,
}

/// How `delete_group` treats the group's children.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeleteGroupMode {
    /// Keep every child. Children with shared material move to solo groups;
    /// children without material become ordinary standalone questions.
    Ungroup,
    /// Soft-delete every child question. Submissions and edit history remain.
    DeleteMembers,
}

/// Result of `delete_group` / `ungroup`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupDeleteResult {
    pub exam_id: String,
    pub group_id: String,
    pub mode: DeleteGroupMode,
    pub deleted_question_ids: Vec<String>,
    /// Children kept as standalone questions (no material dependency).
    pub ungrouped_question_ids: Vec<String>,
    /// Solo groups created to preserve material dependencies.
    pub solo_group_ids: Vec<String>,
    /// Live material rows that were referenced by the deleted group.
    pub material_ids: Vec<String>,
}

/// One material plus the version the caller saw in `list_structure`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MaterialVersionExpectation {
    pub material_id: String,
    pub expected_version: i64,
}

/// Result of `delete_unused_materials`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MaterialDeletionResult {
    pub exam_id: String,
    pub deleted_material_ids: Vec<String>,
}

/// Administrative service for committed groups and shared materials.
///
/// The service is stateless apart from the VFS handle and is safe to construct
/// per IPC command or per chat-tool call.
pub struct QuestionBankManagementService {
    db: Arc<VfsDatabase>,
}

impl QuestionBankManagementService {
    pub fn new(db: Arc<VfsDatabase>) -> Self {
        Self { db }
    }

    /// List the canonical material/group structure with OCC versions.
    pub fn list_structure(&self, exam_id: &str) -> Result<QuestionBankStructure, AppError> {
        let conn = self.db.get_conn_safe().map_err(storage)?;
        ensure_exam_active(&conn, exam_id)?;

        let materials = {
            let mut stmt = conn
                .prepare(
                    "SELECT id,content,images_json,source_refs_json,local_version \
                     FROM qbank_materials WHERE exam_id=?1 AND deleted_at IS NULL \
                     ORDER BY created_at,id",
                )
                .map_err(storage)?;
            let rows = stmt
                .query_map([exam_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                })
                .map_err(storage)?;
            rows.map(|row| {
                let (id, content, images, refs, version) = row.map_err(storage)?;
                Ok(QuestionMaterial {
                    id,
                    content,
                    images: serde_json::from_str(&images).map_err(storage)?,
                    source_refs: serde_json::from_str(&refs).map_err(storage)?,
                    version,
                })
            })
            .collect::<Result<Vec<_>, AppError>>()?
        };

        let mut groups = {
            let mut stmt = conn
                .prepare(
                    "SELECT id,label,position,local_version FROM qbank_groups \
                     WHERE exam_id=?1 AND deleted_at IS NULL ORDER BY position,id",
                )
                .map_err(storage)?;
            let rows = stmt
                .query_map([exam_id], |row| {
                    Ok(QuestionGroupView {
                        id: row.get(0)?,
                        exam_id: exam_id.to_string(),
                        label: row.get(1)?,
                        position: row.get(2)?,
                        version: row.get(3)?,
                        material_ids: Vec::new(),
                        question_ids: Vec::new(),
                    })
                })
                .map_err(storage)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(storage)?
        };

        let mut material_ids_by_group: HashMap<String, Vec<String>> = HashMap::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT gm.group_id,gm.material_id FROM qbank_group_materials gm \
                     JOIN qbank_groups g ON g.id=gm.group_id AND g.deleted_at IS NULL \
                     JOIN qbank_materials m ON m.id=gm.material_id AND m.deleted_at IS NULL \
                     WHERE gm.exam_id=?1 AND gm.deleted_at IS NULL \
                     ORDER BY gm.group_id,gm.position,gm.id",
                )
                .map_err(storage)?;
            let rows = stmt
                .query_map([exam_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(storage)?;
            for row in rows {
                let (group_id, material_id) = row.map_err(storage)?;
                material_ids_by_group
                    .entry(group_id)
                    .or_default()
                    .push(material_id);
            }
        }

        let mut question_ids_by_group: HashMap<String, Vec<String>> = HashMap::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT group_id,id FROM questions \
                     WHERE exam_id=?1 AND deleted_at IS NULL AND group_id IS NOT NULL \
                     ORDER BY group_id, \
                       CASE WHEN group_position IS NULL THEN 1 ELSE 0 END, \
                       group_position,created_at,id",
                )
                .map_err(storage)?;
            let rows = stmt
                .query_map([exam_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(storage)?;
            for row in rows {
                let (group_id, question_id) = row.map_err(storage)?;
                question_ids_by_group
                    .entry(group_id)
                    .or_default()
                    .push(question_id);
            }
        }

        for group in &mut groups {
            group.material_ids = material_ids_by_group.remove(&group.id).unwrap_or_default();
            group.question_ids = question_ids_by_group.remove(&group.id).unwrap_or_default();
        }

        Ok(QuestionBankStructure {
            exam_id: exam_id.to_string(),
            materials,
            groups,
        })
    }

    /// Replace a group's label, ordered members and ordered material set.
    ///
    /// `question_ids` is the complete final member list. A question that was in
    /// the group but is absent from the list is removed; a live ungrouped
    /// question may be added; a question owned by another group is rejected.
    /// Removed children with shared material are moved to solo groups that
    /// attach the canonical material context so they remain solvable.
    pub fn update_group(
        &self,
        group_id: &str,
        label: &str,
        question_ids: &[String],
        material_ids: &[String],
        expected_version: i64,
    ) -> Result<GroupUpdateResult, AppError> {
        if question_ids.is_empty() || has_duplicates(question_ids) {
            return Err(validation("题组成员为空或重复"));
        }
        if has_duplicates(material_ids) {
            return Err(validation("题组材料关联重复"));
        }

        let mut conn = self.db.get_conn_safe().map_err(storage)?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(storage)?;

        let (exam_id, current_label, _current_position, current_version) =
            read_group_header(&tx, group_id)?;
        ensure_exam_active(&tx, &exam_id)?;
        if current_version != expected_version {
            return Err(conflict("题组版本已变化，请重新载入"));
        }

        let current_members = load_group_question_ids(&tx, group_id)?;
        let current_member_set: HashSet<&str> =
            current_members.iter().map(String::as_str).collect();
        let final_member_set: HashSet<&str> = question_ids.iter().map(String::as_str).collect();
        let current_material_ids = load_group_material_ids(&tx, group_id)?;

        for question_id in question_ids {
            let current_group: Option<Option<String>> = tx
                .query_row(
                    "SELECT group_id FROM questions \
                     WHERE id=?1 AND exam_id=?2 AND deleted_at IS NULL",
                    params![question_id, exam_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .map_err(storage)?;
            let Some(current_group) = current_group else {
                return Err(validation("子题不存在、已删除或不属于目标题目集"));
            };
            if let Some(owner) = current_group {
                if owner != group_id {
                    return Err(validation("子题已属于其他题组，请先从原题组移出"));
                }
            }
        }

        for material_id in material_ids {
            ensure_material_active(&tx, &exam_id, material_id)?;
        }

        let removed: Vec<String> = current_members
            .iter()
            .filter(|id| !final_member_set.contains(id.as_str()))
            .cloned()
            .collect();
        let stamp = now();

        // Capture the group's current material context before association rows
        // change. Every removed child gets its own solo group that attaches the
        // same canonical material entities; content is never appended to
        // questions and material rows are never duplicated.
        let preserved_material_ids: &[String] = if removed.is_empty() {
            &[]
        } else {
            &current_material_ids
        };

        let mut next_position = next_group_position(&tx, &exam_id)?;
        let mut solo_group_ids = Vec::new();
        for removed_id in &removed {
            if preserved_material_ids.is_empty() {
                tx.execute(
                    "UPDATE questions SET group_id=NULL,group_position=NULL \
                     WHERE id=?1 AND exam_id=?2 AND deleted_at IS NULL AND group_id=?3",
                    params![removed_id, exam_id, group_id],
                )
                .map_err(storage)?;
                record_membership_change(
                    &tx,
                    removed_id,
                    Some(group_id),
                    None,
                    "group_member_removed",
                )?;
            } else {
                let solo_id = create_solo_group(
                    &tx,
                    &exam_id,
                    &current_label,
                    next_position,
                    removed_id,
                    group_id,
                    preserved_material_ids,
                    &stamp,
                )?;
                next_position += 1;
                solo_group_ids.push(solo_id);
            }
        }

        let changed = tx
            .execute(
                "UPDATE qbank_groups SET label=?1,local_version=local_version+1,updated_at=?2 \
                 WHERE id=?3 AND local_version=?4 AND deleted_at IS NULL",
                params![label, stamp, group_id, expected_version],
            )
            .map_err(storage)?;
        if changed != 1 {
            return Err(conflict("题组版本已变化，请重新载入"));
        }

        for (position, question_id) in question_ids.iter().enumerate() {
            let affected = tx
                .execute(
                    "UPDATE questions SET group_id=?1,group_position=?2 \
                     WHERE id=?3 AND exam_id=?4 AND deleted_at IS NULL \
                       AND (group_id IS NULL OR group_id=?1)",
                    params![group_id, position as i64, question_id, exam_id],
                )
                .map_err(storage)?;
            if affected != 1 {
                return Err(validation("子题不存在、跨题库或已属于另一题组"));
            }
            if !current_member_set.contains(question_id.as_str()) {
                record_membership_change(
                    &tx,
                    question_id,
                    None,
                    Some(group_id),
                    "group_member_added",
                )?;
            }
        }

        tx.execute(
            "UPDATE qbank_group_materials \
             SET deleted_at=?1,updated_at=?1,local_version=local_version+1 \
             WHERE group_id=?2 AND deleted_at IS NULL",
            params![stamp, group_id],
        )
        .map_err(storage)?;
        for (position, material_id) in material_ids.iter().enumerate() {
            tx.execute(
                "INSERT INTO qbank_group_materials \
                   (id,exam_id,group_id,material_id,position,created_at,updated_at) \
                 VALUES(?1,?2,?3,?4,?5,?6,?6) \
                 ON CONFLICT(group_id,material_id) DO UPDATE SET \
                   position=excluded.position,deleted_at=NULL,updated_at=excluded.updated_at, \
                   deletion_batch=NULL, \
                   local_version=qbank_group_materials.local_version+1",
                params![
                    new_id("qgm"),
                    exam_id,
                    group_id,
                    material_id,
                    position as i64,
                    stamp
                ],
            )
            .map_err(storage)?;
        }

        let group = read_group_view(&tx, &exam_id, group_id)?;
        finalize_exam_read_models(&tx, &exam_id)?;
        tx.commit().map_err(storage)?;

        Ok(GroupUpdateResult {
            exam_id: exam_id.clone(),
            group,
            removed_question_ids: removed,
            solo_group_ids,
        })
    }

    /// Split a group into per-question solo groups without deleting any child.
    pub fn ungroup(
        &self,
        group_id: &str,
        expected_version: i64,
    ) -> Result<GroupDeleteResult, AppError> {
        self.delete_group(group_id, DeleteGroupMode::Ungroup, expected_version)
    }

    /// Delete a group according to `mode` with optimistic concurrency.
    pub fn delete_group(
        &self,
        group_id: &str,
        mode: DeleteGroupMode,
        expected_version: i64,
    ) -> Result<GroupDeleteResult, AppError> {
        let mut conn = self.db.get_conn_safe().map_err(storage)?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(storage)?;

        let (exam_id, current_label, _current_position, current_version) =
            read_group_header(&tx, group_id)?;
        ensure_exam_active(&tx, &exam_id)?;
        if current_version != expected_version {
            return Err(conflict("题组版本已变化，请重新载入"));
        }

        let members = load_group_question_ids(&tx, group_id)?;
        let material_ids = load_group_material_ids(&tx, group_id)?;
        let stamp = now();
        let batch = new_id("qdel");
        let mut deleted_question_ids = Vec::new();
        let mut ungrouped_question_ids = Vec::new();
        let mut solo_group_ids = Vec::new();

        match mode {
            DeleteGroupMode::Ungroup => {
                let mut next_position = next_group_position(&tx, &exam_id)?;
                for question_id in &members {
                    if material_ids.is_empty() {
                        tx.execute(
                            "UPDATE questions SET group_id=NULL,group_position=NULL \
                             WHERE id=?1 AND exam_id=?2 AND deleted_at IS NULL AND group_id=?3",
                            params![question_id, exam_id, group_id],
                        )
                        .map_err(storage)?;
                        record_membership_change(
                            &tx,
                            question_id,
                            Some(group_id),
                            None,
                            "group_ungrouped",
                        )?;
                        ungrouped_question_ids.push(question_id.clone());
                    } else {
                        let solo_id = create_solo_group(
                            &tx,
                            &exam_id,
                            &current_label,
                            next_position,
                            question_id,
                            group_id,
                            &material_ids,
                            &stamp,
                        )?;
                        next_position += 1;
                        solo_group_ids.push(solo_id);
                    }
                }
            }
            DeleteGroupMode::DeleteMembers => {
                reject_external_variant_dependencies(&tx, group_id, &members)?;
                for question_id in &members {
                    let affected = tx
                        .execute(
                            "UPDATE questions \
                             SET deleted_at=?1,updated_at=?1,group_id=NULL,group_position=NULL \
                             WHERE id=?2 AND exam_id=?3 AND deleted_at IS NULL",
                            params![stamp, question_id, exam_id],
                        )
                        .map_err(storage)?;
                    if affected != 1 {
                        return Err(validation("题组成员在操作期间已变化，请重新载入"));
                    }
                    record_membership_change(
                        &tx,
                        question_id,
                        Some(group_id),
                        None,
                        "group_deleted_with_members",
                    )?;
                    VfsQuestionRepo::record_history_with_conn(
                        &tx,
                        question_id,
                        "deleted_at",
                        None,
                        Some(stamp.as_str()),
                        "system",
                        Some("group_deleted_with_members"),
                    )
                    .map_err(storage)?;
                    deleted_question_ids.push(question_id.clone());
                }
            }
        }

        tx.execute(
            "UPDATE qbank_group_materials \
             SET deleted_at=?1,updated_at=?1,local_version=local_version+1,deletion_batch=?2 \
             WHERE group_id=?3 AND deleted_at IS NULL",
            params![stamp, batch, group_id],
        )
        .map_err(storage)?;
        let changed = tx
            .execute(
                "UPDATE qbank_groups \
                 SET deleted_at=?1,updated_at=?1,local_version=local_version+1,deletion_batch=?2 \
                 WHERE id=?3 AND local_version=?4 AND deleted_at IS NULL",
                params![stamp, batch, group_id, expected_version],
            )
            .map_err(storage)?;
        if changed != 1 {
            return Err(conflict("题组版本已变化，请重新载入"));
        }

        finalize_exam_read_models(&tx, &exam_id)?;
        tx.commit().map_err(storage)?;

        Ok(GroupDeleteResult {
            exam_id,
            group_id: group_id.to_string(),
            mode,
            deleted_question_ids,
            ungrouped_question_ids,
            solo_group_ids,
            material_ids,
        })
    }

    /// Soft-delete the listed materials only when every material is still
    /// unreferenced and still matches the caller's version. One stale or
    /// referenced item conflicts the whole batch.
    pub fn delete_unused_materials(
        &self,
        exam_id: &str,
        expected: &[MaterialVersionExpectation],
    ) -> Result<MaterialDeletionResult, AppError> {
        let mut seen = HashSet::new();
        for item in expected {
            if !seen.insert(item.material_id.as_str()) {
                return Err(validation("待删除材料重复"));
            }
        }

        let mut conn = self.db.get_conn_safe().map_err(storage)?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(storage)?;
        ensure_exam_active(&tx, exam_id)?;
        if expected.is_empty() {
            return Ok(MaterialDeletionResult {
                exam_id: exam_id.to_string(),
                deleted_material_ids: Vec::new(),
            });
        }

        for item in expected {
            let row: Option<(i64, Option<String>)> = tx
                .query_row(
                    "SELECT local_version,deleted_at FROM qbank_materials \
                     WHERE id=?1 AND exam_id=?2",
                    params![item.material_id, exam_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(storage)?;
            let Some((version, deleted_at)) = row else {
                return Err(AppError::not_found("材料不存在或不属于目标题目集"));
            };
            if deleted_at.is_some() {
                return Err(conflict("材料已被删除或版本已变化"));
            }
            if version != item.expected_version {
                return Err(conflict("材料版本已变化，请重新载入"));
            }
            let referenced: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM qbank_group_materials gm \
                     JOIN qbank_groups g ON g.id=gm.group_id AND g.deleted_at IS NULL \
                     WHERE gm.material_id=?1 AND gm.exam_id=?2 AND gm.deleted_at IS NULL)",
                    params![item.material_id, exam_id],
                    |row| row.get(0),
                )
                .map_err(storage)?;
            if referenced {
                return Err(validation("材料仍被题组引用，请先解除依赖"));
            }
        }

        let stamp = now();
        let batch = new_id("qdel");
        let mut deleted_material_ids = Vec::new();
        for item in expected {
            let changed = tx
                .execute(
                    "UPDATE qbank_materials \
                     SET deleted_at=?1,updated_at=?1,local_version=local_version+1,deletion_batch=?2 \
                     WHERE id=?3 AND exam_id=?4 AND local_version=?5 AND deleted_at IS NULL",
                    params![
                        stamp,
                        batch,
                        item.material_id,
                        exam_id,
                        item.expected_version
                    ],
                )
                .map_err(storage)?;
            if changed != 1 {
                return Err(conflict("材料版本已变化，请重新载入"));
            }
            deleted_material_ids.push(item.material_id.clone());
        }

        finalize_exam_read_models(&tx, exam_id)?;
        tx.commit().map_err(storage)?;

        Ok(MaterialDeletionResult {
            exam_id: exam_id.to_string(),
            deleted_material_ids,
        })
    }
}

fn read_group_view(
    conn: &Connection,
    exam_id: &str,
    group_id: &str,
) -> Result<QuestionGroupView, AppError> {
    let (id, group_exam, label, position, version) = conn
        .query_row(
            "SELECT id,exam_id,label,position,local_version FROM qbank_groups \
             WHERE id=?1 AND exam_id=?2 AND deleted_at IS NULL",
            params![group_id, exam_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()
        .map_err(storage)?
        .ok_or_else(|| AppError::not_found("题组不存在或已删除"))?;
    Ok(QuestionGroupView {
        id,
        exam_id: group_exam,
        label,
        position,
        version,
        material_ids: load_group_material_ids(conn, group_id)?,
        question_ids: load_group_question_ids(conn, group_id)?,
    })
}

fn ensure_exam_active(conn: &Connection, exam_id: &str) -> Result<(), AppError> {
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM exam_sheets WHERE id=?1 AND deleted_at IS NULL)",
            [exam_id],
            |row| row.get(0),
        )
        .map_err(storage)?;
    if !exists {
        return Err(AppError::not_found("目标题目集不存在或已删除"));
    }
    Ok(())
}

fn ensure_material_active(
    conn: &Connection,
    exam_id: &str,
    material_id: &str,
) -> Result<(), AppError> {
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM qbank_materials \
             WHERE id=?1 AND exam_id=?2 AND deleted_at IS NULL)",
            params![material_id, exam_id],
            |row| row.get(0),
        )
        .map_err(storage)?;
    if !exists {
        return Err(validation("材料不存在、已删除或不属于目标题目集"));
    }
    Ok(())
}

fn read_group_header(
    conn: &Connection,
    group_id: &str,
) -> Result<(String, String, i64, i64), AppError> {
    conn.query_row(
        "SELECT exam_id,label,position,local_version FROM qbank_groups \
         WHERE id=?1 AND deleted_at IS NULL",
        [group_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        },
    )
    .optional()
    .map_err(storage)?
    .ok_or_else(|| AppError::not_found("题组不存在或已删除"))
}

fn load_group_question_ids(conn: &Connection, group_id: &str) -> Result<Vec<String>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT id FROM questions WHERE group_id=?1 AND deleted_at IS NULL \
             ORDER BY CASE WHEN group_position IS NULL THEN 1 ELSE 0 END, \
               group_position,created_at,id",
        )
        .map_err(storage)?;
    let rows = stmt
        .query_map([group_id], |row| row.get::<_, String>(0))
        .map_err(storage)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(storage)
}

fn load_group_material_ids(conn: &Connection, group_id: &str) -> Result<Vec<String>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT gm.material_id FROM qbank_group_materials gm \
             JOIN qbank_materials m ON m.id=gm.material_id AND m.deleted_at IS NULL \
             WHERE gm.group_id=?1 AND gm.deleted_at IS NULL \
             ORDER BY gm.position,gm.id",
        )
        .map_err(storage)?;
    let rows = stmt
        .query_map([group_id], |row| row.get::<_, String>(0))
        .map_err(storage)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(storage)
}

fn next_group_position(conn: &Connection, exam_id: &str) -> Result<i64, AppError> {
    let max: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(position),-1) FROM qbank_groups \
             WHERE exam_id=?1 AND deleted_at IS NULL",
            [exam_id],
            |row| row.get(0),
        )
        .map_err(storage)?;
    Ok(max + 1)
}

fn solo_label(source_label: &str) -> String {
    let trimmed = source_label.trim();
    if trimmed.is_empty() {
        "独立题".to_string()
    } else {
        format!("{trimmed} · 独立题")
    }
}

fn create_solo_group(
    conn: &Connection,
    exam_id: &str,
    source_label: &str,
    position: i64,
    question_id: &str,
    old_group_id: &str,
    material_ids: &[String],
    stamp: &str,
) -> Result<String, AppError> {
    let solo_id = new_id("qgroup");
    conn.execute(
        "INSERT INTO qbank_groups(id,exam_id,label,position,created_at,updated_at) \
         VALUES(?1,?2,?3,?4,?5,?5)",
        params![solo_id, exam_id, solo_label(source_label), position, stamp],
    )
    .map_err(storage)?;
    for (position, material_id) in material_ids.iter().enumerate() {
        conn.execute(
            "INSERT INTO qbank_group_materials \
               (id,exam_id,group_id,material_id,position,created_at,updated_at) \
             VALUES(?1,?2,?3,?4,?5,?6,?6)",
            params![
                new_id("qgm"),
                exam_id,
                solo_id,
                material_id,
                position as i64,
                stamp
            ],
        )
        .map_err(storage)?;
    }
    let affected = conn
        .execute(
            "UPDATE questions SET group_id=?1,group_position=0 \
             WHERE id=?2 AND exam_id=?3 AND deleted_at IS NULL AND group_id=?4",
            params![solo_id, question_id, exam_id, old_group_id],
        )
        .map_err(storage)?;
    if affected != 1 {
        return Err(validation("子题在操作期间已变化，请重新载入"));
    }
    record_membership_change(
        conn,
        question_id,
        Some(old_group_id),
        Some(solo_id.as_str()),
        "group_member_preserved_in_solo",
    )?;
    Ok(solo_id)
}

fn reject_external_variant_dependencies(
    conn: &Connection,
    group_id: &str,
    members: &[String],
) -> Result<(), AppError> {
    let member_set: HashSet<&str> = members.iter().map(String::as_str).collect();
    for member in members {
        let mut stmt = conn
            .prepare(
                "SELECT id FROM questions \
                 WHERE parent_id=?1 AND deleted_at IS NULL AND group_id IS NOT ?2",
            )
            .map_err(storage)?;
        let rows = stmt
            .query_map(params![member, group_id], |row| row.get::<_, String>(0))
            .map_err(storage)?;
        for row in rows {
            let child = row.map_err(storage)?;
            if !member_set.contains(child.as_str()) {
                return Err(validation(
                    "题组成员仍是其他活动变式题的父题，请先处理变式依赖",
                ));
            }
        }
    }
    Ok(())
}

fn record_membership_change(
    conn: &Connection,
    question_id: &str,
    old_group: Option<&str>,
    new_group: Option<&str>,
    reason: &str,
) -> Result<(), AppError> {
    VfsQuestionRepo::record_history_with_conn(
        conn,
        question_id,
        "group_id",
        old_group,
        new_group,
        "system",
        Some(reason),
    )
    .map_err(storage)?;
    Ok(())
}

fn finalize_exam_read_models(conn: &Connection, exam_id: &str) -> Result<(), AppError> {
    refresh_canonical_preview_with_conn(conn, exam_id)?;
    VfsQuestionRepo::refresh_stats_with_conn(conn, exam_id).map_err(storage)?;
    VfsQuestionRepo::invalidate_exam_content_index_with_conn(conn, exam_id).map_err(storage)?;
    Ok(())
}

fn has_duplicates(values: &[String]) -> bool {
    let mut seen = HashSet::with_capacity(values.len());
    values.iter().any(|value| !seen.insert(value.as_str()))
}
