//! Note history transport: immutable version identities, local retention, and
//! snapshots of both sides of a remote document replacement.
use super::{ChangeOperation, SyncChangeWithData, SyncError, SyncManager};
use crate::vfs::repos::{note_format_repo::{NoteFormat, NoteFormatRepo}, note_revision_repo::NoteRevisionRepo};
use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;
use std::collections::HashSet;

fn error(e: impl std::fmt::Display) -> SyncError { SyncError::Database(e.to_string()) }

pub(super) fn include_note_dependencies(conn: &Connection, changes: &mut Vec<SyncChangeWithData>) -> Result<(), SyncError> {
    if !SyncManager::table_has_column(conn, "note_document_revisions", "version_id") { return Ok(()); }
    let mut seen: HashSet<_> = changes.iter().map(|c| (c.table_name.clone(), c.record_id.clone())).collect();
    let notes: Vec<_> = changes.iter().filter(|c| c.table_name == "notes" && c.operation != ChangeOperation::Delete && c.data.is_some()).cloned().collect();
    for note in notes {
        for (table, key) in [("note_document_formats", "note_id"), ("note_document_revisions", "version_id"), ("note_learning_relations", "id")] {
            if !SyncManager::table_has_column(conn, table, key) { continue; }
            let order = if table == "note_document_revisions" { "seq" } else { "note_id" };
            let mut stmt = conn.prepare(&format!("SELECT {key} FROM {table} WHERE note_id=?1 ORDER BY {order}")).map_err(error)?;
            let ids = stmt.query_map([&note.record_id], |r| r.get::<_, String>(0)).map_err(error)?;
            for id in ids {
                let id = id.map_err(error)?;
                if !seen.insert((table.into(), id.clone())) { continue; }
                let data = SyncManager::get_record_data(conn, table, &id, key)?;
                // Same source change-log cursor: these are dependencies of the
                // note envelope and share its delivery/acknowledgement boundary.
                changes.push(SyncChangeWithData { table_name: table.into(), record_id: id, operation: ChangeOperation::Insert, data, ..note.clone() });
            }
        }
    }
    Ok(())
}

pub(super) fn prepare_relation(conn: &Connection, id: &str, obj: &mut serde_json::Map<String, Value>) -> Result<(), SyncError> {
    use crate::vfs::repos::note_relation_repo::NoteLocator;
    let locator: NoteLocator = serde_json::from_str(obj.get("locator_json").and_then(Value::as_str)
        .ok_or_else(|| error("Relation locator missing"))?).map_err(error)?;
    let kind = obj.get("relation_type").and_then(Value::as_str).ok_or_else(|| error("Relation type missing"))?;
    if !matches!(kind, "source" | "card" | "mistake")
        || (kind == "card" && !matches!(locator, NoteLocator::Card(_)))
        || (kind == "mistake" && !matches!(locator, NoteLocator::Question(_))) {
        return Err(error("Relation type/locator mismatch"));
    }
    // No target FK: resources may arrive in another batch; card document/card
    // IDs belong to Anki, not VFS. The repo's live reference_status determines
    // usability without rewriting the sender's intent or inventing a resource.
    let current: Option<i64> = conn.query_row("SELECT revision FROM note_learning_relations WHERE id=?1", [id], |r| r.get(0)).optional().map_err(error)?;
    let revision = current.unwrap_or(0).checked_add(1).ok_or_else(|| error("Relation revision exhausted"))?;
    obj.insert("revision".into(), Value::from(revision));
    Ok(())
}

pub(super) fn retarget_note_relations(conn: &Connection, note_id: &str, previous: &str) -> Result<(), SyncError> {
    if !SyncManager::table_has_column(conn, "note_learning_relations", "revision") { return Ok(()); }
    let (resource, updated): (String, String) = conn.query_row("SELECT resource_id,updated_at FROM notes WHERE id=?1", [note_id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(error)?;
    if resource != previous {
        conn.execute("UPDATE note_learning_relations SET resource_id=?1,revision=revision+1,updated_at=MAX(updated_at,?2)
            WHERE resource_id=?3 AND json_extract(locator_json,'$.type')!='card'", rusqlite::params![resource, updated, previous]).map_err(error)?;
    }
    let active: bool = conn.query_row("SELECT deleted_at IS NULL FROM notes WHERE id=?1", [note_id], |r| r.get(0)).map_err(error)?;
    if active { crate::vfs::repos::note_relation_repo::NoteRelationRepo::invalidate_missing_blocks(conn, note_id).map_err(error)?; }
    Ok(())
}

pub(super) fn apply_revision(conn: &Connection, id: &str, data: &Value) -> Result<(), SyncError> {
    let mut obj = data.as_object().ok_or_else(|| error("Invalid history object"))?.clone();
    if obj.get("version_id").and_then(Value::as_str) != Some(id) { return Err(error("History version identity mismatch")); }
    let incoming_pin = match obj.get("pinned") {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Bool(true)) => true,
        Some(Value::Number(n)) if n.as_i64() == Some(0) => false,
        Some(Value::Number(n)) if n.as_i64() == Some(1) => true,
        _ => return Err(error("Invalid history pin")),
    };
    for key in ["seq", "pinned", "edit_bucket", super::SYNC_FIELD_DELTAS_KEY] { obj.remove(key); }
    for key in ["note_id", "title", "content_md", "tags_json", "asset_refs_json", "source", "created_at", "content_format", "serializer_version"] {
        if obj.get(key).and_then(Value::as_str).is_none() { return Err(error(format!("History field missing: {key}"))); }
    }
    let format = NoteFormat {
        note_id: obj["note_id"].as_str().unwrap().into(), content_format: obj["content_format"].as_str().unwrap().into(),
        format_version: obj.get("format_version").and_then(Value::as_i64).ok_or_else(|| error("History format version missing"))?,
        serializer_version: obj["serializer_version"].as_str().unwrap().into(), baseline_version_id: None,
    };
    NoteFormatRepo::ensure_supported(&format).map_err(error)?;
    let detected = NoteFormatRepo::detect(&format.note_id, obj["content_md"].as_str().unwrap()).map_err(error)?;
    if detected.content_format != format.content_format { return Err(error("History format/body mismatch")); }
    if !NoteFormatRepo::required_capabilities(&detected).is_empty() && NoteFormatRepo::required_capabilities(&format).is_empty() {
        return Err(error("History envelope lacks required columns capability"));
    }
    // Validate JSON now, so a malformed row cannot poison read/restore or asset GC.
    serde_json::from_str::<Vec<String>>(obj["tags_json"].as_str().unwrap()).map_err(error)?;
    serde_json::from_str::<Vec<crate::vfs::repos::note_revision_repo::NoteAssetRef>>(obj["asset_refs_json"].as_str().unwrap()).map_err(error)?;
    if let Some(s) = obj.get("props_json").and_then(Value::as_str) { serde_json::from_str::<Value>(s).map_err(error)?; }
    if let Some(local) = SyncManager::get_record_data(conn, "note_document_revisions", id, "version_id")? {
        let local = local.as_object().ok_or_else(|| error("Invalid local history"))?;
        for (key, value) in &obj {
            let equal = if key.ends_with("_json") {
                let parsed = |v: &Value| -> Result<Value, SyncError> {
                    match v.as_str() { Some(s) => serde_json::from_str(s).map_err(error), None => Ok(v.clone()) }
                };
                parsed(local.get(key).unwrap_or(&Value::Null))? == parsed(value)?
            } else { local.get(key).unwrap_or(&Value::Null) == value };
            if !equal { return Err(error(format!("Immutable history conflict: {id} ({key})"))); }
        }
        if incoming_pin {
            conn.execute("UPDATE note_document_revisions SET pinned=1 WHERE version_id=?1 AND pinned=0", [id]).map_err(error)?;
        }
        return Ok(());
    }
    obj.insert("edit_bucket".into(), Value::from(0));
    obj.insert("pinned".into(), Value::from(incoming_pin));
    let (columns, placeholders, values) = SyncManager::build_insert_parts(&obj)?;
    let params: Vec<&dyn rusqlite::ToSql> = values.iter().map(|v| v.as_ref()).collect();
    conn.execute(&format!("INSERT INTO note_document_revisions ({columns}) VALUES ({placeholders})"), params.as_slice()).map_err(error)?;
    Ok(())
}

pub(super) fn affected_notes(conn: &Connection, table: &str, id: &str) -> Result<Vec<String>, SyncError> {
    if !SyncManager::table_has_column(conn, "note_document_revisions", "version_id") { return Ok(Vec::new()); }
    let sql = match table {
        "notes" => "SELECT id FROM notes WHERE id=?1",
        "resources" => "SELECT id FROM notes WHERE resource_id=?1",
        _ => return Ok(Vec::new()),
    };
    let mut stmt = conn.prepare(sql).map_err(error)?;
    let rows = stmt.query_map([id], |r| r.get::<_, String>(0)).map_err(error)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(error)
}

pub(super) fn snapshot_notes(conn: &Connection, ids: &[String], source: &str) -> Result<(), SyncError> {
    for id in ids {
        if source == "remote_sync" {
            let content: String = conn.query_row("SELECT r.data FROM notes n JOIN resources r ON r.id=n.resource_id WHERE n.id=?1", [id], |r| r.get(0)).map_err(error)?;
            let mut format = NoteFormatRepo::detect(id, &content).map_err(error)?;
            let old = NoteFormatRepo::get(conn, id).map_err(error)?;
            // Enabling a writer capability persists when the last container is
            // removed. An inferred body snapshot must not silently disable it.
            if !NoteFormatRepo::required_capabilities(&old).is_empty() && NoteFormatRepo::required_capabilities(&format).is_empty() {
                format.serializer_version = NoteFormatRepo::serializer(format.content_format == "markdown-blocks", true);
            }
            if old.content_format != format.content_format || old.format_version != format.format_version || old.serializer_version != format.serializer_version {
                format.baseline_version_id = old.baseline_version_id;
                NoteFormatRepo::insert(conn, &format).map_err(error)?;
                // This is inferred metadata, not a local edit. Let the explicit
                // remote envelope supply its timestamp and baseline reference.
                conn.execute("UPDATE note_document_formats SET updated_at='' WHERE note_id=?1", [id]).map_err(error)?;
            }
        }
        let version = NoteRevisionRepo::snapshot(conn, id, source).map_err(error)?;
        if source == "before_sync" { NoteRevisionRepo::set_pinned(conn, id, &version, true).map_err(error)?; }
    }
    Ok(())
}

pub(super) fn validate_batch_formats(changes: &[SyncChangeWithData]) -> Result<(), SyncError> {
    // Validate the envelope before resources/notes can be applied. Rejecting the
    // format row only after the body was written would bypass the version gate.
    for change in changes.iter().filter(|c| c.table_name == "note_document_formats" && c.operation != ChangeOperation::Delete) {
        let format: NoteFormat = serde_json::from_value(change.data.clone().ok_or_else(|| error("Missing note format envelope"))?).map_err(error)?;
        NoteFormatRepo::ensure_supported(&format).map_err(error)?;
        if format.note_id != change.record_id { return Err(error("Note format identity mismatch")); }
        let resource_id = changes.iter().find(|c| c.table_name == "notes" && c.record_id == format.note_id)
            .and_then(|c| c.data.as_ref()).and_then(|d| d.get("resource_id")).and_then(Value::as_str);
        if let Some(body) = resource_id.and_then(|id| changes.iter().find(|c| c.table_name == "resources" && c.record_id == id))
            .and_then(|c| c.data.as_ref()).and_then(|d| d.get("data")).and_then(Value::as_str) {
            let detected = NoteFormatRepo::detect(&format.note_id, body).map_err(error)?;
            if detected.content_format != format.content_format
                || (!NoteFormatRepo::required_capabilities(&detected).is_empty() && NoteFormatRepo::required_capabilities(&format).is_empty()) {
                return Err(error("Note format/body capability mismatch"));
            }
        }
    }
    Ok(())
}

pub(super) fn validate_incoming(conn: &Connection, table: &str, id: &str, data: &Value) -> Result<(), SyncError> {
    if !SyncManager::table_has_column(conn, "note_document_revisions", "version_id") { return Ok(()); }
    if table == "note_document_formats" {
        let format: NoteFormat = serde_json::from_value(data.clone()).map_err(error)?;
        NoteFormatRepo::ensure_supported(&format).map_err(error)?;
    }
    if table == "resources" && (data.get("type").and_then(Value::as_str) == Some("note") || !affected_notes(conn, table, id)?.is_empty()) {
        if let Some(body) = data.get("data").and_then(Value::as_str) { NoteFormatRepo::detect(id, body).map_err(error)?; }
    }
    for note in affected_notes(conn, table, id)? {
        let format = NoteFormatRepo::get(conn, &note).map_err(error)?;
        NoteFormatRepo::ensure_supported(&format).map_err(error)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vfs::{database::setup_migrated_test_db, VfsNoteRepo, VfsCreateNoteParams, VfsUpdateNoteParams};

    fn payloads(conn: &Connection) -> Vec<SyncChangeWithData> {
        let pending = SyncManager::get_pending_changes(conn, None, None).unwrap();
        let entries: Vec<_> = pending.entries.into_iter().filter(|e| matches!(e.table_name.as_str(), "notes" | "resources")).collect();
        let mut changes = SyncManager::enrich_changes_with_data(conn, &entries, None).unwrap();
        for change in &mut changes { change.suppress_change_log = Some(true); change.database_name = Some("vfs".into()); }
        changes.reverse(); // Receive out of order; production ordering must fix it.
        changes
    }

    #[test]
    fn direct_remote_resource_update_keeps_both_full_document_snapshots() {
        let (_source_dir, source) = setup_migrated_test_db();
        let (_target_dir, target) = setup_migrated_test_db();
        let note = VfsNoteRepo::create_note(&source, VfsCreateNoteParams { title: "Resource fixture".into(), content: "original full document\n\nsuffix".into(), tags: vec![] }).unwrap();
        let source_conn = source.get_conn_safe().unwrap();
        let target_conn = target.get_conn_safe().unwrap();
        let changes = payloads(&source_conn);
        assert_eq!(SyncManager::apply_downloaded_changes(&target_conn, &changes, None).unwrap().failure_count, 0);
        let mut resource = changes.into_iter().find(|c| c.table_name == "resources" && c.record_id == note.resource_id).unwrap();
        resource.data.as_mut().unwrap()["data"] = Value::from("remote full document\n\nremote suffix");
        resource.data.as_mut().unwrap()["updated_at"] = Value::from(chrono::Utc::now().timestamp_millis());
        resource.operation = ChangeOperation::Update;
        let result = SyncManager::apply_downloaded_changes(&target_conn, &[resource], None).unwrap();
        assert_eq!(result.failure_count, 0, "{result:?}");
        assert_eq!(VfsNoteRepo::get_note_content_with_conn(&target_conn, &note.id).unwrap().unwrap(), "remote full document\n\nremote suffix");
        let versions = NoteRevisionRepo::list(&target_conn, &note.id, None, 100).unwrap();
        let snapshots: Vec<_> = versions.items.iter().map(|v| NoteRevisionRepo::get(&target_conn, &note.id, &v.version_id).unwrap()).collect();
        assert!(snapshots.iter().any(|v| v.content_md == "original full document\n\nsuffix" && v.summary.pinned));
        assert!(snapshots.iter().any(|v| v.content_md == "remote full document\n\nremote suffix"));
    }

    #[test]
    fn relation_sync_rebuilds_local_cas_and_replay_does_not_increment_it() {
        let (_source_dir, source) = setup_migrated_test_db();
        let (_target_dir, target) = setup_migrated_test_db();
        let note = VfsNoteRepo::create_note(&source, VfsCreateNoteParams { title: "Relation fixture".into(), content: "body".into(), tags: vec![] }).unwrap();
        let source_conn = source.get_conn_safe().unwrap();
        let target_conn = target.get_conn_safe().unwrap();
        source_conn.execute("INSERT INTO note_learning_relations(id,note_id,relation_type,resource_id,locator_json,revision,created_at,updated_at) VALUES('relation',?1,'source','missing-target','{\"type\":\"whole\"}',77,?2,?2)", rusqlite::params![note.id,note.updated_at]).unwrap();
        let changes = payloads(&source_conn);
        let mut relation = changes.iter().find(|c| c.table_name == "note_learning_relations").unwrap().clone();
        assert!(relation.data.as_ref().unwrap().get("revision").is_none());
        let result = SyncManager::apply_downloaded_changes(&target_conn, &changes, None).unwrap();
        assert_eq!(result.failure_count, 0, "{result:?}");
        let revision = || target_conn.query_row("SELECT revision FROM note_learning_relations WHERE id='relation'", [], |r| r.get::<_, i64>(0)).unwrap();
        assert_eq!(revision(), 1);
        SyncManager::apply_downloaded_changes(&target_conn, &[relation.clone()], None).unwrap();
        assert_eq!(revision(), 1);
        assert_eq!(target_conn.query_row("SELECT count(*) FROM resources WHERE id='missing-target'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        relation.data.as_mut().unwrap()["resource_id"] = Value::from(note.resource_id.clone());
        relation.data.as_mut().unwrap()["updated_at"] = Value::from(chrono::Utc::now().to_rfc3339());
        let result = SyncManager::apply_downloaded_changes(&target_conn, &[relation.clone()], None).unwrap();
        assert_eq!(result.failure_count, 0, "{result:?}"); assert_eq!(revision(), 2);
        SyncManager::apply_downloaded_changes(&target_conn, &[relation], None).unwrap();
        assert_eq!(revision(), 2);
        let row = crate::vfs::repos::note_relation_repo::NoteRelationRepo::get(&target_conn, None, "relation").unwrap().unwrap();
        assert!(row.reference.resource_exists && row.reference.locator_exists);
    }

    #[test]
    fn remote_pin_is_retained_after_unpinned_replay_and_prune() {
        let (_dir, db) = setup_migrated_test_db();
        let note = VfsNoteRepo::create_note(&db, VfsCreateNoteParams { title: "Pin fixture".into(), content: "body".into(), tags: vec![] }).unwrap();
        let conn = db.get_conn_safe().unwrap();
        let original = payloads(&conn).into_iter().find(|c| c.table_name == "note_document_revisions").unwrap();
        NoteRevisionRepo::set_pinned(&conn, &note.id, &original.record_id, false).unwrap();
        let mut pinned = original.clone(); pinned.data.as_mut().unwrap()["pinned"] = Value::from(1);
        assert_eq!(SyncManager::apply_downloaded_changes(&conn, &[pinned], None).unwrap().failure_count, 0);
        let mut unpinned = original.clone(); unpinned.data.as_mut().unwrap()["pinned"] = Value::from(0);
        assert_eq!(SyncManager::apply_downloaded_changes(&conn, &[unpinned], None).unwrap().failure_count, 0);
        let mut prune = original.clone(); prune.operation = ChangeOperation::Delete; prune.data = None;
        SyncManager::apply_downloaded_changes(&conn, &[prune], None).unwrap();
        assert!(NoteRevisionRepo::get(&conn, &note.id, &original.record_id).unwrap().summary.pinned);
    }

    #[test]
    fn row_sync_transmits_history_dependencies_and_preserves_remote_before_after() {
        let (_source_dir, source) = setup_migrated_test_db();
        let (_target_dir, target) = setup_migrated_test_db();
        let note = VfsNoteRepo::create_note(&source, VfsCreateNoteParams { title: "Sync fixture".into(), content: "before".into(), tags: vec![] }).unwrap();
        let source_conn = source.get_conn_safe().unwrap();
        let target_conn = target.get_conn_safe().unwrap();
        let changes = payloads(&source_conn);
        let mut future_batch = changes.clone();
        future_batch.iter_mut().find(|c| c.table_name == "note_document_formats").unwrap().data.as_mut().unwrap()["format_version"] = Value::from(999);
        assert!(SyncManager::apply_downloaded_changes(&target_conn, &future_batch, None).is_err());
        assert_eq!(target_conn.query_row("SELECT count(*) FROM notes", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        let mut future_capability = changes.clone();
        future_capability.iter_mut().find(|c| c.table_name == "note_document_formats").unwrap().data.as_mut().unwrap()["serializer_version"] = Value::from("markdown-v1+ds-columns-v999");
        assert!(SyncManager::apply_downloaded_changes(&target_conn, &future_capability, None).is_err());
        assert_eq!(target_conn.query_row("SELECT count(*) FROM resources", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        let history = changes.iter().find(|c| c.table_name == "note_document_revisions").unwrap();
        assert!(history.data.as_ref().unwrap().get("seq").is_none());
        assert!(history.data.as_ref().unwrap().get("pinned").is_some());
        let result = SyncManager::apply_downloaded_changes(&target_conn, &changes, None).unwrap();
        assert_eq!(result.failure_count, 0, "{result:?}");
        assert!(NoteRevisionRepo::get(&target_conn, &note.id, &history.record_id).is_ok());
        VfsNoteRepo::update_note_with_conn(&source_conn, &note.id, VfsUpdateNoteParams { content: Some("after".into()), ..Default::default() }).unwrap();
        let result = SyncManager::apply_downloaded_changes(&target_conn, payloads(&source_conn), None).unwrap();
        assert_eq!(result.failure_count, 0, "{result:?}");
        assert_eq!(VfsNoteRepo::get_note_content_with_conn(&target_conn, &note.id).unwrap().unwrap(), "after");
        let states: Vec<(String, bool)> = target_conn.prepare("SELECT content_md,pinned FROM note_document_revisions WHERE note_id=?1").unwrap()
            .query_map([&note.id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().collect::<rusqlite::Result<_>>().unwrap();
        assert!(states.iter().any(|(body, pinned)| body == "before" && *pinned));
        assert!(states.iter().any(|(body, _)| body == "after"));
        let restored = NoteRevisionRepo::restore_copy(&target_conn, &note.id, &history.record_id).unwrap();
        assert_eq!(VfsNoteRepo::get_note_content_with_conn(&target_conn, &restored.id).unwrap().unwrap(), "before");
    }

    #[test]
    fn immutable_history_conflict_is_quarantined_and_valid_retry_preserves_local_pins() {
        let (_dir, db) = setup_migrated_test_db();
        let note = VfsNoteRepo::create_note(&db, VfsCreateNoteParams { title: "Fixture".into(), content: "original".into(), tags: vec![] }).unwrap();
        let conn = db.get_conn_safe().unwrap();
        let changes = payloads(&conn);
        let mut history = changes.into_iter().find(|c| c.table_name == "note_document_revisions").unwrap();
        let original = history.clone();
        NoteRevisionRepo::set_pinned(&conn, &note.id, &history.record_id, true).unwrap();
        history.data.as_mut().unwrap()["content_md"] = Value::from("tampered");
        let result = SyncManager::apply_downloaded_changes(&conn, &[history], None).unwrap();
        assert_eq!(result.failure_count, 1);
        let saved = NoteRevisionRepo::get(&conn, &note.id, &original.record_id).unwrap();
        assert_eq!(saved.content_md, "original"); assert!(saved.summary.pinned);
        let result = SyncManager::apply_downloaded_changes(&conn, &[original.clone()], None).unwrap();
        assert_eq!(result.failure_count, 0);
        let mut deletion = original.clone(); deletion.operation = ChangeOperation::Delete; deletion.data = None;
        SyncManager::apply_downloaded_changes(&conn, &[deletion], None).unwrap();
        assert!(NoteRevisionRepo::get(&conn, &note.id, &original.record_id).unwrap().summary.pinned);
        let mut future = original; future.record_id = "future-version".into();
        let data = future.data.as_mut().unwrap(); data["version_id"] = Value::from("future-version"); data["format_version"] = Value::from(999);
        assert_eq!(SyncManager::apply_downloaded_changes(&conn, &[future], None).unwrap().failure_count, 1);
        assert!(NoteRevisionRepo::get(&conn, &note.id, "future-version").is_err());
    }
}
