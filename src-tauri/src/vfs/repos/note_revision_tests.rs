use super::*;
use crate::vfs::types::VfsUpdateNoteParams;

fn create(conn: &Connection, content: &str) -> VfsNote {
    VfsNoteRepo::create_note_with_conn(
        conn,
        VfsCreateNoteParams {
            title: "历史测试".into(),
            content: content.into(),
            tags: vec!["tag".into()],
        },
    )
    .unwrap()
}

fn edit(conn: &Connection, note: &VfsNote, content: &str) -> VfsNote {
    VfsNoteRepo::update_note_with_conn(
        conn,
        &note.id,
        VfsUpdateNoteParams {
            content: Some(content.into()),
            expected_updated_at: Some(note.updated_at.clone()),
            ..Default::default()
        },
    )
    .unwrap()
}

fn latest(conn: &Connection, note: &VfsNote) -> NoteRevision {
    let page = NoteRevisionRepo::list(conn, &note.id, None, 1).unwrap();
    NoteRevisionRepo::get(conn, &note.id, &page.items[0].version_id).unwrap()
}

#[test]
fn full_body_survives_resource_cleanup_and_copy_preserves_metadata() {
    let (_tmp, db) = crate::vfs::database::setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let original = "# 完整\r\n\r\n![图](notes_assets/_global/old/image.png)\n\n未加载后缀\n\n";
    let note = create(&conn, original);
    let note = VfsNoteRepo::update_note_metadata_with_conn(
        &conn,
        &note.id,
        VfsNoteMetadataUpdate {
            props: Some(serde_json::json!({"课程": "数学", "done": false})),
            ..Default::default()
        },
    )
    .unwrap();
    let saved = latest(&conn, &note);
    let original_resource = note.resource_id.clone();
    let changed = edit(&conn, &note, "new");
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM resources WHERE id = ?1",
            [original_resource],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    let history = NoteRevisionRepo::get(&conn, &note.id, &saved.summary.version_id).unwrap();
    assert_eq!(history.content_md, original);
    assert!(
        NoteRevisionRepo::asset_is_referenced(&conn, "notes_assets/_global/old/image.png").unwrap()
    );
    let copy = NoteRevisionRepo::restore_copy(&conn, &note.id, &saved.summary.version_id).unwrap();
    assert_ne!(copy.id, note.id);
    assert_eq!(copy.tags, note.tags);
    assert_eq!(copy.props, note.props);
    assert!(copy.title.starts_with(&note.title));
    assert_eq!(
        VfsNoteRepo::get_note_content_with_conn(&conn, &copy.id)
            .unwrap()
            .unwrap(),
        original
    );
    assert_eq!(
        VfsNoteRepo::get_note_with_conn(&conn, &note.id)
            .unwrap()
            .unwrap()
            .updated_at,
        changed.updated_at
    );
    let restored = latest(&conn, &copy);
    assert_eq!(
        restored.summary.restored_from_version_id.as_deref(),
        Some(saved.summary.version_id.as_str())
    );
    assert_eq!(restored.summary.source, "restore_copy");
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM folder_items WHERE item_id = ?1 AND deleted_at IS NULL",
            [&copy.id],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    assert!(VfsNoteRepo::purge_note_with_conn(&conn, &note.id).is_err());
}

#[test]
fn noop_structural_props_empty_body_and_a_b_a_have_correct_identity() {
    let (_tmp, db) = crate::vfs::database::setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let note = create(&conn, "A");
    let a1 = latest(&conn, &note);
    let note = edit(&conn, &note, "A");
    assert_eq!(
        latest(&conn, &note).summary.version_id,
        a1.summary.version_id
    );
    let note = edit(&conn, &note, "B");
    let b = latest(&conn, &note);
    NoteRevisionRepo::get_and_pin(&conn, &note.id, &b.summary.version_id).unwrap();
    let note = edit(&conn, &note, "A");
    assert_ne!(
        latest(&conn, &note).summary.version_id,
        a1.summary.version_id
    );
    assert_eq!(
        NoteRevisionRepo::get(&conn, &note.id, &b.summary.version_id)
            .unwrap()
            .content_md,
        "B"
    );
    let note = edit(&conn, &note, "");
    assert_eq!(latest(&conn, &note).content_md, "");
    let props = serde_json::from_str(r#"{"a":1,"b":false}"#).unwrap();
    let note = VfsNoteRepo::set_note_props_with_conn(&conn, &note.id, props).unwrap();
    let id = latest(&conn, &note).summary.version_id;
    let reordered = serde_json::from_str(r#"{"b":false,"a":1}"#).unwrap();
    VfsNoteRepo::set_note_props_with_conn(&conn, &note.id, reordered).unwrap();
    assert_eq!(latest(&conn, &note).summary.version_id, id);
}

#[test]
fn occ_and_history_failure_roll_back_body_metadata_and_resources() {
    let (_tmp, db) = crate::vfs::database::setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let old = create(&conn, "old");
    let current = edit(&conn, &old, "current");
    let version = latest(&conn, &current).summary.version_id;
    let failed = VfsNoteRepo::update_note_with_conn(
        &conn,
        &old.id,
        VfsUpdateNoteParams {
            content: Some("stale".into()),
            expected_updated_at: Some(old.updated_at),
            ..Default::default()
        },
    );
    assert!(matches!(failed, Err(VfsError::Conflict { .. })));
    conn.execute_batch("CREATE TRIGGER fail_history BEFORE INSERT ON note_document_revisions BEGIN SELECT RAISE(ABORT, 'injected'); END;").unwrap();
    assert!(VfsNoteRepo::update_note_with_conn(
        &conn,
        &current.id,
        VfsUpdateNoteParams {
            content: Some("failed".into()),
            ..Default::default()
        }
    )
    .is_err());
    assert!(VfsNoteRepo::update_note_metadata_with_conn(
        &conn,
        &current.id,
        VfsNoteMetadataUpdate {
            title: Some("failed title".into()),
            props: Some(serde_json::json!({"a": 2})),
            ..Default::default()
        }
    )
    .is_err());
    let actual = VfsNoteRepo::get_note_with_conn(&conn, &current.id)
        .unwrap()
        .unwrap();
    assert_eq!(actual.updated_at, current.updated_at);
    assert_eq!(actual.title, current.title);
    assert_eq!(actual.resource_id, current.resource_id);
    assert_eq!(latest(&conn, &current).summary.version_id, version);
    assert_eq!(
        VfsNoteRepo::get_note_content_with_conn(&conn, &current.id)
            .unwrap()
            .unwrap(),
        "current"
    );
}

#[test]
fn legacy_baseline_is_captured_before_first_write_and_pagination_is_stable() {
    let (_tmp, db) = crate::vfs::database::setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let note = create(&conn, "legacy");
    conn.execute(
        "DELETE FROM note_document_revisions WHERE note_id = ?1",
        [&note.id],
    )
    .unwrap();
    let note = edit(&conn, &note, "updated");
    let first = NoteRevisionRepo::list(&conn, &note.id, None, 1).unwrap();
    assert_eq!(first.items[0].source, "edit");
    let second = NoteRevisionRepo::list(&conn, &note.id, first.next_cursor, 1).unwrap();
    assert_eq!(second.items[0].source, "baseline");
    assert_eq!(
        NoteRevisionRepo::get(&conn, &note.id, &second.items[0].version_id)
            .unwrap()
            .content_md,
        "legacy"
    );
    assert!(second.next_cursor.is_none());
    let other = create(&conn, "other");
    assert!(NoteRevisionRepo::restore_copy(&conn, &other.id, &first.items[0].version_id).is_err());
}

#[test]
fn edits_coalesce_without_mutation_and_budget_preserves_pins() {
    let (_tmp, db) = crate::vfs::database::setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let mut note = create(&conn, "0");
    note = edit(&conn, &note, "1");
    let first = latest(&conn, &note);
    // Pin the observed version; it must survive both same-bucket and budget pruning.
    NoteRevisionRepo::get_and_pin(&conn, &note.id, &first.summary.version_id).unwrap();
    for i in 2..107 {
        // Simulate crossing five-minute boundaries without sleeping.
        conn.execute(
            "UPDATE note_document_revisions SET edit_bucket = -1 WHERE note_id = ?1",
            [&note.id],
        )
        .unwrap();
        note = edit(&conn, &note, &i.to_string());
    }
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM note_document_revisions WHERE note_id = ?1 AND source = 'edit' AND pinned = 0", [&note.id], |r| r.get(0)).unwrap();
    assert_eq!(count, 100);
    assert_eq!(
        NoteRevisionRepo::get(&conn, &note.id, &first.summary.version_id)
            .unwrap()
            .content_md,
        "1"
    );
    note = edit(&conn, &note, "next");
    assert_eq!(latest(&conn, &note).content_md, "next");
    let count_after: i64 = conn.query_row("SELECT COUNT(*) FROM note_document_revisions WHERE note_id = ?1 AND source = 'edit' AND pinned = 0", [&note.id], |r| r.get(0)).unwrap();
    assert_eq!(count_after, 100);
}

#[test]
fn history_trash_and_shared_asset_references_guard_journal_deletion() {
    use crate::data_governance::file_deletion_queue::{
        finish_asset_deletion_with_conn, prepare_asset_deletion_with_conn,
    };
    let (tmp, db) = crate::vfs::database::setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let path = "notes_assets/_global/original/image.png";
    std::fs::create_dir_all(tmp.path().join("notes_assets/_global/original")).unwrap();
    std::fs::write(tmp.path().join(path), b"image bytes").unwrap();
    let key = format!("active/{}", path);
    let prepared =
        prepare_asset_deletion_with_conn(&conn, tmp.path(), &key, std::path::Path::new(path))
            .unwrap();
    let quarantine = tmp
        .path()
        .join(format!("{}.deleting-{}", path, prepared.operation_id));
    std::fs::rename(tmp.path().join(path), quarantine).unwrap();
    let note = create(&conn, &format!("![img]({})", path));
    // A prepared intent from before a restore/save is cancelled during recovery.
    finish_asset_deletion_with_conn(&conn, tmp.path(), &prepared).unwrap();
    assert!(tmp.path().join(path).exists());
    let note = edit(&conn, &note, "removed image");
    assert!(
        prepare_asset_deletion_with_conn(&conn, tmp.path(), &key, std::path::Path::new(path))
            .is_err()
    );
    VfsNoteRepo::delete_note_with_conn(&conn, &note.id).unwrap();
    assert!(NoteRevisionRepo::asset_is_referenced(&conn, path).unwrap());
    let shared = create(&conn, &format!("![shared]({})", path));
    VfsNoteRepo::purge_note_with_conn(&conn, &note.id).unwrap();
    assert!(NoteRevisionRepo::asset_is_referenced(&conn, path).unwrap());
    VfsNoteRepo::purge_note_with_conn(&conn, &shared.id).unwrap();
    assert!(!NoteRevisionRepo::asset_is_referenced(&conn, path).unwrap());
    let prepared =
        prepare_asset_deletion_with_conn(&conn, tmp.path(), &key, std::path::Path::new(path))
            .unwrap();
    finish_asset_deletion_with_conn(&conn, tmp.path(), &prepared).unwrap();
    assert!(!tmp.path().join(path).exists());
}

#[test]
fn full_sqlite_backup_restores_history_and_local_classification() {
    let (tmp, db) = crate::vfs::database::setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let note = create(&conn, "persist across reopen\n\n");
    let revision = latest(&conn, &note);
    let backup = tmp.path().join("history-backup.db");
    // Same SQLite Backup API used by data_governance::backup (whole database).
    let mut destination = Connection::open(&backup).unwrap();
    rusqlite::backup::Backup::new(&conn, &mut destination)
        .unwrap()
        .run_to_completion(100, std::time::Duration::from_millis(0), None)
        .unwrap();
    drop(destination);
    let restored = Connection::open(&backup).unwrap();
    assert_eq!(
        NoteRevisionRepo::get(&restored, &note.id, &revision.summary.version_id)
            .unwrap()
            .content_md,
        "persist across reopen\n\n"
    );
}

#[test]
fn asset_manifest_distinguishes_owned_and_external_references() {
    let refs = extract_asset_refs(
        r#"![x](notes_assets/_global/n/a%20b.png) <img src="notes_assets/_global/n/a b.png"> [pdf](pdfref://file_123?page=4) [web](https://example.test/x)"#,
    );
    assert!(refs
        .iter()
        .any(|r| r.kind == "notes_asset" && r.value == "notes_assets/_global/n/a b.png"));
    assert!(refs
        .iter()
        .any(|r| r.kind == "external_resource" && r.value == "pdfref://file_123?page=4"));
    assert!(refs.iter().any(|r| r.kind == "remote_url"));
}

#[test]
fn zip_overwrite_captures_body_and_writes_fresh_assets_without_overwriting_history_bytes() {
    use crate::notes_exporter::{ImportConflictStrategy, ImportOptions, NotesImporter};
    use std::io::Write;
    use std::sync::Arc;
    let (tmp, db) = crate::vfs::database::setup_migrated_test_db();
    let db = Arc::new(db);
    let conn = db.get_conn_safe().unwrap();
    let original_path = "notes_assets/_global/original/image.png";
    let note = create(&conn, &format!("![original]({})", original_path));
    let saved = latest(&conn, &note);
    std::fs::create_dir_all(tmp.path().join("notes_assets/_global/original")).unwrap();
    std::fs::write(tmp.path().join(original_path), b"original image").unwrap();
    let archive_path = tmp.path().join("import.zip");
    {
        let file = std::fs::File::create(&archive_path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file("markdown/imported.md", zip::write::FileOptions::default())
            .unwrap();
        write!(
            archive,
            "---\nid: {}\ntitle: Imported\n---\n\n![imported]({})",
            note.id, original_path
        )
        .unwrap();
        archive
            .start_file(
                "assets/_global/original/image.png",
                zip::write::FileOptions::default(),
            )
            .unwrap();
        archive.write_all(b"imported image").unwrap();
        archive.finish().unwrap();
    }
    let main_db =
        Arc::new(crate::database::Database::new(&tmp.path().join("mistakes.db")).unwrap());
    let files = Arc::new(crate::file_manager::FileManager::new(tmp.path().to_path_buf()).unwrap());
    let result = NotesImporter::new_with_vfs(main_db, files, Some(db.clone()))
        .import_with_options(
            archive_path,
            ImportOptions {
                conflict_strategy: ImportConflictStrategy::Overwrite,
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(result.overwritten_count, 1);
    assert_eq!(
        std::fs::read(tmp.path().join(original_path)).unwrap(),
        b"original image"
    );
    assert_eq!(
        NoteRevisionRepo::get(&conn, &note.id, &saved.summary.version_id)
            .unwrap()
            .content_md,
        saved.content_md
    );
    let imported = latest(&conn, &note);
    let asset = imported
        .asset_refs
        .iter()
        .find(|r| r.kind == "notes_asset")
        .unwrap();
    assert_ne!(asset.value, original_path);
    assert_eq!(
        std::fs::read(tmp.path().join(&asset.value)).unwrap(),
        b"imported image"
    );
}

#[test]
fn preview_is_read_only_and_a_pruned_restore_target_never_falls_back() {
    let (_tmp, db) = crate::vfs::database::setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let note = create(&conn, "initial");
    let note = edit(&conn, &note, "previewed edit");
    let preview = latest(&conn, &note);
    assert!(!preview.summary.pinned);
    assert!(
        NoteRevisionRepo::list_filtered(&conn, &note.id, None, 30, true)
            .unwrap()
            .items
            .is_empty()
    );
    // Model a normal retention cleanup after preview, before restore/pin.
    conn.execute(
        "DELETE FROM note_document_revisions WHERE version_id = ?1",
        [&preview.summary.version_id],
    )
    .unwrap();
    assert!(NoteRevisionRepo::restore_copy(&conn, &note.id, &preview.summary.version_id).is_err());
    assert!(
        NoteRevisionRepo::set_pinned(&conn, &note.id, &preview.summary.version_id, true).is_err()
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        VfsNoteRepo::get_note_content_with_conn(&conn, &note.id)
            .unwrap()
            .unwrap(),
        "previewed edit"
    );
    // A read alone must never prevent the user's later permanent deletion.
    VfsNoteRepo::purge_note_with_conn(&conn, &note.id).unwrap();
}

#[test]
fn explicit_release_preserves_body_assets_and_restore_protection_until_user_releases_it() {
    let (_tmp, db) = crate::vfs::database::setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let path = "notes_assets/_global/original/retained.png";
    let note = create(&conn, &format!("![image]({})", path));
    let target = latest(&conn, &note);
    // Includes legacy preview pins: the old boolean is managed without schema rewriting.
    NoteRevisionRepo::get_and_pin(&conn, &note.id, &target.summary.version_id).unwrap();
    let note = edit(&conn, &note, "current body");
    let current = latest(&conn, &note);
    let released =
        NoteRevisionRepo::set_pinned(&conn, &note.id, &target.summary.version_id, false).unwrap();
    assert!(!released.pinned);
    assert_eq!(
        NoteRevisionRepo::get(&conn, &note.id, &target.summary.version_id)
            .unwrap()
            .content_md,
        target.content_md
    );
    assert!(NoteRevisionRepo::asset_is_referenced(&conn, path).unwrap());
    let copy = NoteRevisionRepo::restore_copy(&conn, &note.id, &target.summary.version_id).unwrap();
    assert!(
        NoteRevisionRepo::get(&conn, &note.id, &target.summary.version_id)
            .unwrap()
            .summary
            .pinned
    );
    assert!(
        NoteRevisionRepo::get(&conn, &note.id, &current.summary.version_id)
            .unwrap()
            .summary
            .pinned
    );
    NoteRevisionRepo::set_pinned(&conn, &note.id, &target.summary.version_id, false).unwrap();
    assert!(VfsNoteRepo::purge_note_with_conn(&conn, &note.id).is_err());
    // Retention can also be managed from trash. Releasing the remaining pin
    // permits purge, but the copy's independent history still protects its image.
    VfsNoteRepo::delete_note_with_conn(&conn, &note.id).unwrap();
    NoteRevisionRepo::set_pinned(&conn, &note.id, &current.summary.version_id, false).unwrap();
    assert!(
        NoteRevisionRepo::list_filtered(&conn, &note.id, None, 30, true)
            .unwrap()
            .items
            .is_empty()
    );
    VfsNoteRepo::purge_note_with_conn(&conn, &note.id).unwrap();
    assert_eq!(
        VfsNoteRepo::get_note_content_with_conn(&conn, &copy.id)
            .unwrap()
            .unwrap(),
        target.content_md
    );
    assert!(NoteRevisionRepo::asset_is_referenced(&conn, path).unwrap());
}

#[test]
fn retained_filter_finds_older_pins_and_release_is_scoped_to_the_note() {
    let (_tmp, db) = crate::vfs::database::setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let mut note = create(&conn, "first");
    let first = latest(&conn, &note);
    NoteRevisionRepo::set_pinned(&conn, &note.id, &first.summary.version_id, true).unwrap();
    note = edit(&conn, &note, "second");
    let second = latest(&conn, &note);
    NoteRevisionRepo::set_pinned(&conn, &note.id, &second.summary.version_id, true).unwrap();
    for index in 0..35 {
        note = VfsNoteRepo::update_note_metadata_with_conn(
            &conn,
            &note.id,
            VfsNoteMetadataUpdate {
                title: Some(format!("title {}", index)),
                ..Default::default()
            },
        )
        .unwrap();
    }
    assert!(NoteRevisionRepo::list(&conn, &note.id, None, 30)
        .unwrap()
        .items
        .iter()
        .all(|item| !item.pinned));
    let page = NoteRevisionRepo::list_filtered(&conn, &note.id, None, 1, true).unwrap();
    assert_eq!(page.items[0].version_id, second.summary.version_id);
    let page = NoteRevisionRepo::list_filtered(&conn, &note.id, page.next_cursor, 1, true).unwrap();
    assert_eq!(page.items[0].version_id, first.summary.version_id);
    assert!(page.next_cursor.is_none());
    let other = create(&conn, "other");
    assert!(
        NoteRevisionRepo::set_pinned(&conn, &other.id, &first.summary.version_id, false).is_err()
    );
    assert!(
        NoteRevisionRepo::get(&conn, &note.id, &first.summary.version_id)
            .unwrap()
            .summary
            .pinned
    );
}
