use super::*;
use crate::vfs::{
    ink::{
        InkAuthor, InkBackground, InkBoardChunk, InkBoardObject, InkObject, InkObjectContent,
        InkPage, InkRuling, INK_BOARD_SCHEMA_VERSION, INK_MIME,
    },
    repos::{
        ink_board_repo::VfsInkBoardRepo, InkArtifactDraft, VfsBlobRepo, VfsFileRepo,
        VfsInkArtifactRepo, VfsInkRepo,
    },
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

fn migrated_db() -> (tempfile::TempDir, crate::vfs::database::VfsDatabase) {
    crate::vfs::database::setup_migrated_test_db()
}

fn count_for(conn: &Connection, hash: &str) -> i64 {
    conn.query_row(
        "SELECT ref_count FROM blobs WHERE hash = ?1",
        [hash],
        |row| row.get(0),
    )
    .unwrap()
}

fn blob_exists(conn: &Connection, blobs_dir: &std::path::Path, hash: &str) -> bool {
    VfsBlobRepo::get_blob_path_with_conn(conn, blobs_dir, hash)
        .unwrap()
        .is_some_and(|path| path.exists())
}

const PNG_1X1: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0,
    0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99, 0x3d, 0x1d, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

fn ink_artifact_draft(render_id: &str) -> InkArtifactDraft {
    InkArtifactDraft {
        artifact_id: render_id.to_owned(),
        render_id: render_id.to_owned(),
        document_id: "doc-ink-sync".to_owned(),
        page_id: "page-sync".to_owned(),
        revision: "revision-sync".to_owned(),
        source_hash: Some(
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_owned(),
        ),
        source_annotation_revision: Some("annotations-sync".to_owned()),
        conversion_revision: Some("conversion-sync".to_owned()),
        crop: None,
        width_px: 1,
        height_px: 1,
    }
}

fn create_test_artifact(
    conn: &Connection,
    blobs_dir: &std::path::Path,
    render_id: &str,
) -> crate::vfs::repos::InkArtifact {
    VfsInkArtifactRepo::store_png_with_conn(conn, blobs_dir, ink_artifact_draft(render_id), PNG_1X1)
        .unwrap()
}

fn artifact_sync_row(conn: &Connection, render_id: &str) -> Value {
    let mut statement = conn
        .prepare("SELECT * FROM ink_render_artifacts WHERE render_id = ?1")
        .unwrap();
    let columns = statement
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut rows = statement.query([render_id]).unwrap();
    let row = rows.next().unwrap().expect("artifact row exists");
    let mut data = serde_json::Map::new();
    for (index, column) in columns.iter().enumerate() {
        let value = match row.get_ref(index).unwrap() {
            rusqlite::types::ValueRef::Null => Value::Null,
            rusqlite::types::ValueRef::Integer(value) => json!(value),
            rusqlite::types::ValueRef::Real(value) => json!(value),
            rusqlite::types::ValueRef::Text(value) => json!(std::str::from_utf8(value).unwrap()),
            rusqlite::types::ValueRef::Blob(value) => json!({"blob_bytes": value.len()}),
        };
        data.insert(column.clone(), value);
    }
    Value::Object(data)
}

fn artifact_sync_change(
    render_id: &str,
    operation: ChangeOperation,
    data: Value,
) -> SyncChangeWithData {
    SyncChangeWithData {
        table_name: "ink_render_artifacts".to_owned(),
        record_id: render_id.to_owned(),
        operation,
        data: Some(data),
        changed_at: "2026-11-03T00:00:00Z".to_owned(),
        change_log_id: None,
        database_name: Some("vfs".to_owned()),
        suppress_change_log: Some(true),
        source_device_id: Some("device-artifact-cloud".to_owned()),
        source_seq: Some(1),
    }
}

fn file_row_json(conn: &Connection, document_id: &str) -> Value {
    let mut statement = conn.prepare("SELECT * FROM files WHERE id = ?1").unwrap();
    let columns = statement
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut rows = statement.query([document_id]).unwrap();
    let row = rows.next().unwrap().expect("ink files row exists");
    let mut data = serde_json::Map::new();
    for (index, column) in columns.iter().enumerate() {
        let value = match row.get_ref(index).unwrap() {
            rusqlite::types::ValueRef::Null => Value::Null,
            rusqlite::types::ValueRef::Integer(value) => json!(value),
            rusqlite::types::ValueRef::Real(value) => json!(value),
            rusqlite::types::ValueRef::Text(value) => json!(std::str::from_utf8(value).unwrap()),
            rusqlite::types::ValueRef::Blob(value) => json!({"blob_bytes": value.len()}),
        };
        data.insert(column.clone(), value);
    }
    Value::Object(data)
}

fn save_ink_row_snapshot(conn: &Connection, document_id: &str) {
    ConflictResolver::ensure_conflict_table(conn).unwrap();
    let snapshot = file_row_json(conn, document_id);
    conn.execute(
        "INSERT INTO __sync_conflicts(table_name, record_id, side, data_json) VALUES ('files', ?1, 'local', ?2)",
        params![document_id, serde_json::to_string(&snapshot).unwrap()],
    )
    .unwrap();
}

fn sync_change(record_id: &str, data: Value) -> SyncChangeWithData {
    SyncChangeWithData {
        table_name: "files".to_owned(),
        record_id: record_id.to_owned(),
        operation: ChangeOperation::Update,
        data: Some(data),
        changed_at: "2026-01-02T00:00:00Z".to_owned(),
        change_log_id: None,
        database_name: Some("vfs".to_owned()),
        suppress_change_log: Some(true),
        source_device_id: Some("device-ink-cloud".to_owned()),
        source_seq: Some(1),
    }
}

fn transfer_ink_closure(
    source_conn: &Connection,
    source_blobs: &std::path::Path,
    target_conn: &Connection,
    target_blobs: &std::path::Path,
    row: &Value,
) {
    let preview: Value = serde_json::from_str(row["preview_json"].as_str().unwrap()).unwrap();
    let mut hashes = vec![row["blob_hash"].as_str().unwrap().to_owned()];
    hashes.extend(
        preview["ink"]["blob_refs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_owned()),
    );
    hashes.sort();
    hashes.dedup();
    for hash in hashes {
        let path = VfsBlobRepo::get_blob_path_with_conn(source_conn, source_blobs, &hash)
            .unwrap()
            .expect("source blob row exists");
        let bytes = std::fs::read(path).unwrap();
        VfsBlobRepo::store_blob_with_conn(target_conn, target_blobs, &bytes, None, None).unwrap();
    }
}

#[test]
fn current_ink_manifest_and_page_refs_survive_recount_and_gc() {
    let (_temp_dir, db) = migrated_db();
    let conn = db.get_conn().unwrap();
    assert_eq!(
        super::ink::blob_directory(db.db_path()).unwrap(),
        db.blobs_dir()
    );
    let manifest = VfsInkRepo::create_blank_with_conn(
        &conn,
        db.blobs_dir(),
        "Sync lifecycle",
        InkRuling::Blank,
        640.0,
        480.0,
        "create-sync-lifecycle",
        None,
    )
    .unwrap();
    let page_hash = manifest.pages[0].page_blob_hash.clone();
    let manifest_hash: String = conn
        .query_row(
            "SELECT blob_hash FROM files WHERE id = ?1",
            [&manifest.document_id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(blob_exists(&conn, db.blobs_dir(), &manifest_hash));
    assert!(blob_exists(&conn, db.blobs_dir(), &page_hash));

    SyncManager::recompute_blob_ref_counts(&conn).unwrap();

    assert_eq!(
        count_for(&conn, &manifest_hash),
        1,
        "current manifest pointer is one owner"
    );
    assert_eq!(
        count_for(&conn, &page_hash),
        1,
        "current page dependency is one owner"
    );
    VfsBlobRepo::cleanup_unreferenced(&db).unwrap();
    assert!(
        blob_exists(&conn, db.blobs_dir(), &manifest_hash),
        "GC preserves the current manifest"
    );
    assert!(
        blob_exists(&conn, db.blobs_dir(), &page_hash),
        "GC preserves the current page body"
    );

    let generic_file = VfsBlobRepo::store_blob_with_conn(
        &conn,
        db.blobs_dir(),
        b"generic pdf file bytes",
        Some("application/pdf"),
        Some("pdf"),
    )
    .unwrap();
    let generic_page = VfsBlobRepo::store_blob_with_conn(
        &conn,
        db.blobs_dir(),
        b"generic rendered page bytes",
        Some("image/png"),
        Some("png"),
    )
    .unwrap();
    let generic = VfsFileRepo::create_file_with_conn(
        &conn,
        &generic_file.hash,
        "ordinary.pdf",
        generic_file.size as i64,
        "document",
        Some("application/pdf"),
        Some(&generic_file.hash),
        None,
    )
    .unwrap();
    conn.execute(
        "UPDATE files SET preview_json = ?1 WHERE id = ?2",
        params![
            json!({"pages": [{"blob_hash": generic_page.hash}]}).to_string(),
            generic.id
        ],
    )
    .unwrap();
    conn.execute(
        "UPDATE resources SET hash = 'generic-stale-mirror' WHERE id = ?1",
        [&generic.resource_id.unwrap()],
    )
    .unwrap();
    SyncManager::recompute_blob_ref_counts(&conn).unwrap();
    assert_eq!(
        count_for(&conn, &generic_file.hash),
        1,
        "generic files.blob_hash remains counted once"
    );
    assert_eq!(
        count_for(&conn, &generic_page.hash),
        1,
        "generic preview page reference remains counted"
    );
    let generic_mirror: String = conn
        .query_row(
            "SELECT hash FROM resources WHERE source_id = ?1",
            [&generic.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        generic_mirror, "generic-stale-mirror",
        "dsink mirror repair must not change generic resources.hash"
    );
}

#[test]
fn unresolved_ink_conflict_pins_old_manifest_page_and_background_until_resolved() {
    let (_temp_dir, db) = migrated_db();
    let conn = db.get_conn().unwrap();
    let created = VfsInkRepo::create_blank_with_conn(
        &conn,
        db.blobs_dir(),
        "Conflict pin",
        InkRuling::Blank,
        640.0,
        480.0,
        "create-conflict-pin",
        None,
    )
    .unwrap();
    let background = VfsBlobRepo::store_blob_with_conn(
        &conn,
        db.blobs_dir(),
        b"real background bytes for conflict pin",
        Some("image/png"),
        Some("png"),
    )
    .unwrap();

    // Build a real manifest blob whose page and background dependencies are both real blobs.
    let mut old_manifest = created.clone();
    old_manifest.pages[0].background = InkBackground::Image {
        blob_hash: background.hash.clone(),
    };
    let old_manifest_bytes = serde_json::to_vec(&old_manifest).unwrap();
    let old_manifest_blob = VfsBlobRepo::store_blob_with_conn(
        &conn,
        db.blobs_dir(),
        &old_manifest_bytes,
        Some(INK_MIME),
        Some("dsink"),
    )
    .unwrap();
    let mut blob_refs = vec![
        old_manifest.pages[0].page_blob_hash.clone(),
        background.hash.clone(),
    ];
    blob_refs.sort();
    blob_refs.dedup();
    let old_preview = json!({
        "ink": {
            "schema_version": 1,
            "document_id": old_manifest.document_id,
            "revision": old_manifest.revision,
            "manifest_blob_hash": old_manifest_blob.hash,
            "blob_refs": blob_refs,
        }
    })
    .to_string();
    conn.execute(
        "UPDATE files SET blob_hash = ?1, sha256 = ?1, size = ?2, preview_json = ?3 WHERE id = ?4",
        params![
            old_manifest_blob.hash,
            old_manifest_bytes.len() as i64,
            old_preview,
            old_manifest.document_id
        ],
    )
    .unwrap();
    conn.execute(
        "UPDATE resources SET hash = ?1 WHERE source_id = ?2 AND source_table = 'files'",
        params![old_manifest_blob.hash, old_manifest.document_id],
    )
    .unwrap();

    let old_manifest_hash = old_manifest_blob.hash;
    let old_page_hash = old_manifest.pages[0].page_blob_hash.clone();
    save_ink_row_snapshot(&conn, &old_manifest.document_id);
    let changed_page = InkPage {
        schema_version: 1,
        page_id: old_manifest.pages[0].page_id.clone(),
        objects: vec![InkObject {
            id: "conflict-current-stroke".to_owned(),
            author: crate::vfs::ink::InkAuthor::User,
            created_at: 1,
            content: InkObjectContent::Text {
                rect: crate::vfs::ink::InkRect {
                    x: 1.0,
                    y: 1.0,
                    width: 10.0,
                    height: 10.0,
                },
                text: "current page version".to_owned(),
                font_size: 12.0,
                color: "#000000".to_owned(),
            },
        }],
    };
    let current = VfsInkRepo::save_page_with_conn(
        &conn,
        db.blobs_dir(),
        &old_manifest.document_id,
        &old_manifest.revision,
        "advance-after-conflict-snapshot",
        &changed_page,
    )
    .unwrap();
    let current_manifest_hash: String = conn
        .query_row(
            "SELECT blob_hash FROM files WHERE id = ?1",
            [&current.document_id],
            |row| row.get(0),
        )
        .unwrap();
    let current_page_hash = current.pages[0].page_blob_hash.clone();
    assert_ne!(
        old_manifest_hash, current_manifest_hash,
        "save advances manifest blob pointer"
    );
    assert_ne!(
        old_page_hash, current_page_hash,
        "save writes a new page blob"
    );

    SyncManager::recompute_blob_ref_counts(&conn).unwrap();

    assert_eq!(
        count_for(&conn, &old_manifest_hash),
        1,
        "unresolved conflict snapshot pins old manifest"
    );
    assert_eq!(
        count_for(&conn, &old_page_hash),
        1,
        "unresolved conflict snapshot pins old page"
    );
    assert_eq!(
        count_for(&conn, &background.hash),
        2,
        "the current row and conflict snapshot each own the background"
    );
    assert_eq!(
        count_for(&conn, &current_manifest_hash),
        1,
        "current manifest remains referenced"
    );
    assert_eq!(
        count_for(&conn, &current_page_hash),
        1,
        "current page remains referenced"
    );
    VfsBlobRepo::cleanup_unreferenced(&db).unwrap();
    assert!(blob_exists(&conn, db.blobs_dir(), &old_manifest_hash));
    assert!(blob_exists(&conn, db.blobs_dir(), &old_page_hash));
    assert!(blob_exists(&conn, db.blobs_dir(), &background.hash));

    conn.execute(
        "UPDATE __sync_conflicts SET resolved_at = '2026-11-03T00:00:00Z' WHERE table_name = 'files' AND record_id = ?1 AND resolved_at IS NULL",
        [&current.document_id],
    )
    .unwrap();
    SyncManager::recompute_blob_ref_counts(&conn).unwrap();
    assert_eq!(
        count_for(&conn, &old_manifest_hash),
        0,
        "resolved snapshot releases old manifest pin"
    );
    assert_eq!(
        count_for(&conn, &old_page_hash),
        0,
        "resolved snapshot releases old page pin"
    );
    assert_eq!(
        count_for(&conn, &background.hash),
        1,
        "resolved snapshot releases only its background pin"
    );
    assert_eq!(count_for(&conn, &current_manifest_hash), 1);
    assert_eq!(count_for(&conn, &current_page_hash), 1);
}

#[test]
fn incoming_ink_pointer_tuple_requires_every_canonical_field() {
    let hash = "a".repeat(64);
    let preview = json!({
        "ink": {
            "schema_version": 1,
            "document_id": "ink-doc",
            "revision": "r1",
            "manifest_blob_hash": hash,
            "blob_refs": []
        }
    })
    .to_string();
    let complete = json!({
        "id": "ink-doc",
        "file_name": "Ink.dsink",
        "blob_hash": hash,
        "sha256": hash,
        "preview_json": preview,
        "mime_type": INK_MIME,
        "type": "document"
    });

    for field in [
        "id",
        "file_name",
        "blob_hash",
        "sha256",
        "preview_json",
        "mime_type",
        "type",
    ] {
        let mut partial = complete.clone();
        partial.as_object_mut().unwrap().remove(field);
        assert!(
            super::ink::validate_ink_change(&partial).is_err(),
            "missing {field} must reject the entire dsink canonical tuple"
        );
    }
    for field in [
        "schema_version",
        "document_id",
        "revision",
        "manifest_blob_hash",
        "blob_refs",
    ] {
        let mut partial = complete.clone();
        let preview: Value =
            serde_json::from_str(partial["preview_json"].as_str().unwrap()).unwrap();
        let mut preview = preview;
        preview["ink"].as_object_mut().unwrap().remove(field);
        partial["preview_json"] = Value::String(preview.to_string());
        assert!(
            super::ink::validate_ink_change(&partial).is_err(),
            "missing preview_json.ink.{field} must reject the canonical tuple"
        );
    }
    assert!(super::ink::validate_ink_change(&complete).is_ok());

    let mut uppercase_hash = complete.clone();
    uppercase_hash["blob_hash"] = json!("A".repeat(64));
    uppercase_hash["sha256"] = json!("A".repeat(64));
    let mut upper_preview: Value =
        serde_json::from_str(uppercase_hash["preview_json"].as_str().unwrap()).unwrap();
    upper_preview["ink"]["manifest_blob_hash"] = json!("A".repeat(64));
    uppercase_hash["preview_json"] = Value::String(upper_preview.to_string());
    assert!(
        super::ink::validate_ink_change(&uppercase_hash).is_err(),
        "canonical hashes are lowercase hex"
    );

    let mut ink_prefix = complete.clone();
    ink_prefix["id"] = json!("file_ink_document");
    ink_prefix["preview_json"] = json!(preview.replace("ink-doc", "file_ink_document"));
    assert!(super::ink::validate_ink_change(&ink_prefix).is_ok());

    let mut mismatched_hash = complete.clone();
    mismatched_hash["sha256"] = json!("b".repeat(64));
    assert!(super::ink::validate_ink_change(&mismatched_hash).is_err());
}

fn save_page_version(
    conn: &Connection,
    blobs_dir: &std::path::Path,
    manifest: &crate::vfs::ink::InkManifest,
    operation_id: &str,
    label: &str,
) -> crate::vfs::ink::InkManifest {
    let page = InkPage {
        schema_version: 1,
        page_id: manifest.pages[0].page_id.clone(),
        objects: vec![InkObject {
            id: format!("stroke-{label}"),
            author: crate::vfs::ink::InkAuthor::User,
            created_at: 1,
            content: InkObjectContent::Text {
                rect: crate::vfs::ink::InkRect {
                    x: 1.0,
                    y: 1.0,
                    width: 100.0,
                    height: 20.0,
                },
                text: label.to_owned(),
                font_size: 14.0,
                color: "#000000".to_owned(),
            },
        }],
    };
    VfsInkRepo::save_page_with_conn(
        conn,
        blobs_dir,
        &manifest.document_id,
        &manifest.revision,
        operation_id,
        &page,
    )
    .unwrap()
}

fn set_updated_at(conn: &Connection, document_id: &str, updated_at: &str) {
    conn.execute(
        "UPDATE files SET updated_at = ?1 WHERE id = ?2",
        params![updated_at, document_id],
    )
    .unwrap();
}

fn guard_trigger_count(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type = 'trigger' AND name LIKE 'trg_vfs_writer_guard_%'",
        [],
        |row| row.get(0),
    )
    .unwrap()
}

fn guard_marker_installed(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT COALESCE((SELECT guard_installed FROM __vfs_writer_guard WHERE id = 1), 0)",
        [],
        |row| row.get(0),
    )
    .unwrap()
}

fn copy_closure(
    source_conn: &Connection,
    source_blobs: &std::path::Path,
    target_conn: &Connection,
    target_blobs: &std::path::Path,
    row: &Value,
) {
    transfer_ink_closure(source_conn, source_blobs, target_conn, target_blobs, row);
}

fn resource_id_for(conn: &Connection, document_id: &str) -> String {
    conn.query_row(
        "SELECT resource_id FROM files WHERE id = ?1",
        [document_id],
        |row| row.get(0),
    )
    .unwrap()
}

fn incoming_row_for_target(
    source_conn: &Connection,
    source_blobs: &std::path::Path,
    source_manifest: &crate::vfs::ink::InkManifest,
    target_conn: &Connection,
    target_manifest: &crate::vfs::ink::InkManifest,
    updated_at: &str,
) -> Value {
    let mut row = file_row_json(source_conn, &source_manifest.document_id);
    row["resource_id"] = json!(resource_id_for(target_conn, &target_manifest.document_id));
    row["updated_at"] = json!(updated_at);
    let _ = source_blobs;
    row
}

fn board_chunk(chunk_id: &str, objects: Vec<InkBoardObject>) -> InkBoardChunk {
    InkBoardChunk {
        schema_version: INK_BOARD_SCHEMA_VERSION,
        chunk_id: chunk_id.to_owned(),
        objects,
    }
}

fn board_rect_object(
    id: &str,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    z_index: i64,
) -> InkBoardObject {
    InkBoardObject {
        id: id.to_owned(),
        author: InkAuthor::User,
        created_at: 0,
        z_index,
        content: InkObjectContent::Rect {
            rect: crate::vfs::ink::InkRect {
                x,
                y,
                width,
                height,
            },
            color: "#000000".to_owned(),
            width: 2.0,
        },
    }
}

#[test]
fn complete_incoming_ink_row_applies_and_repairs_resource_hash_mirror() {
    let (_source_tmp, source_db) = migrated_db();
    let (_target_tmp, target_db) = migrated_db();
    let source_conn = source_db.get_conn().unwrap();
    let target_conn = target_db.get_conn().unwrap();
    let operation_id = "paired-complete-apply";
    let source_created = VfsInkRepo::create_blank_with_conn(
        &source_conn,
        source_db.blobs_dir(),
        "Paired",
        InkRuling::Blank,
        640.0,
        480.0,
        operation_id,
        None,
    )
    .unwrap();
    let target_created = VfsInkRepo::create_blank_with_conn(
        &target_conn,
        target_db.blobs_dir(),
        "Paired",
        InkRuling::Blank,
        640.0,
        480.0,
        operation_id,
        None,
    )
    .unwrap();
    assert_eq!(source_created.document_id, target_created.document_id);
    let remote = save_page_version(
        &source_conn,
        source_db.blobs_dir(),
        &source_created,
        "source-edit",
        "remote complete version",
    );
    let row = incoming_row_for_target(
        &source_conn,
        source_db.blobs_dir(),
        &remote,
        &target_conn,
        &target_created,
        "2025-01-02T00:00:00Z",
    );
    copy_closure(
        &source_conn,
        source_db.blobs_dir(),
        &target_conn,
        target_db.blobs_dir(),
        &row,
    );
    set_updated_at(
        &target_conn,
        &target_created.document_id,
        "2024-01-02T00:00:00Z",
    );

    let result = SyncManager::apply_downloaded_changes(
        &target_conn,
        [sync_change(&target_created.document_id, row.clone())],
        None,
    )
    .unwrap();

    assert_eq!(result.success_count, 1);
    let (file_hash, sha256, resource_hash): (String, String, String) = target_conn.query_row(
        "SELECT f.blob_hash, f.sha256, r.hash FROM files f JOIN resources r ON r.id = f.resource_id WHERE f.id = ?1",
        [&target_created.document_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).unwrap();
    assert_eq!(file_hash, row["blob_hash"]);
    assert_eq!(sha256, file_hash);
    assert_eq!(
        resource_hash, file_hash,
        "resources.hash is reconciled from the applied canonical files row"
    );
    assert_eq!(
        VfsInkRepo::get_manifest_with_conn(
            &target_conn,
            target_db.blobs_dir(),
            &target_created.document_id
        )
        .unwrap()
        .revision,
        remote.revision
    );

    // Whitespace keeps the page JSON parseable, but the actual bytes exceed the public parser cap.
    // The production sync guard must use parse_page rather than raw serde + validate_page.
    let page = VfsInkRepo::get_page_with_conn(
        &source_conn,
        source_db.blobs_dir(),
        &remote.document_id,
        &remote.pages[0].page_id,
    )
    .unwrap();
    let mut oversized_page_bytes = serde_json::to_vec(&page).unwrap();
    oversized_page_bytes.resize(crate::vfs::ink::INK_PAGE_MAX_BYTES + 1, b' ');
    let oversized_page_blob = VfsBlobRepo::store_blob_with_conn(
        &source_conn,
        source_db.blobs_dir(),
        &oversized_page_bytes,
        Some("application/json"),
        Some("json"),
    )
    .unwrap();
    let mut oversized_manifest = remote.clone();
    oversized_manifest.pages[0].page_blob_hash = oversized_page_blob.hash.clone();
    let oversized_manifest_bytes = serde_json::to_vec(&oversized_manifest).unwrap();
    let oversized_manifest_blob = VfsBlobRepo::store_blob_with_conn(
        &source_conn,
        source_db.blobs_dir(),
        &oversized_manifest_bytes,
        Some(INK_MIME),
        Some("dsink"),
    )
    .unwrap();
    let refs = json!([oversized_page_blob.hash]);
    let preview = json!({"ink": {
        "schema_version": 1,
        "document_id": oversized_manifest.document_id,
        "revision": oversized_manifest.revision,
        "manifest_blob_hash": oversized_manifest_blob.hash,
        "blob_refs": refs,
    }})
    .to_string();
    source_conn.execute(
        "UPDATE files SET blob_hash = ?1, sha256 = ?1, size = ?2, preview_json = ?3, updated_at = '2025-01-03T00:00:00Z' WHERE id = ?4",
        params![oversized_manifest_blob.hash, oversized_manifest_bytes.len() as i64, preview, oversized_manifest.document_id],
    ).unwrap();
    source_conn
        .execute(
            "UPDATE resources SET hash = ?1 WHERE source_table = 'files' AND source_id = ?2",
            params![oversized_manifest_blob.hash, oversized_manifest.document_id],
        )
        .unwrap();
    let mut oversized_row = file_row_json(&source_conn, &remote.document_id);
    oversized_row["resource_id"] =
        json!(resource_id_for(&target_conn, &target_created.document_id));
    copy_closure(
        &source_conn,
        source_db.blobs_dir(),
        &target_conn,
        target_db.blobs_dir(),
        &oversized_row,
    );
    set_updated_at(
        &target_conn,
        &target_created.document_id,
        "2024-01-03T00:00:00Z",
    );
    let oversized_result = SyncManager::apply_downloaded_changes(
        &target_conn,
        [sync_change(&target_created.document_id, oversized_row)],
        None,
    )
    .unwrap();
    assert_eq!(
        oversized_result.failure_count, 1,
        "oversized page bytes must be quarantined"
    );
    let after_oversized_hash: String = target_conn
        .query_row(
            "SELECT blob_hash FROM files WHERE id = ?1",
            [&target_created.document_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        after_oversized_hash, file_hash,
        "oversized page cannot publish a new manifest pointer"
    );
}

#[test]
fn partial_existing_file_ink_update_is_quarantined_without_mutating_pointer_tuple() {
    let (_temp_dir, db) = migrated_db();
    let conn = db.get_conn().unwrap();
    let manifest = VfsInkRepo::create_blank_with_conn(
        &conn,
        db.blobs_dir(),
        "Partial guard",
        InkRuling::Blank,
        640.0,
        480.0,
        "partial-existing-ink",
        None,
    )
    .unwrap();
    let before: (String, String, String, String) = conn.query_row(
        "SELECT f.blob_hash, f.sha256, f.preview_json, f.file_name FROM files f WHERE f.id = ?1",
        [&manifest.document_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).unwrap();
    let mut partial = file_row_json(&conn, &manifest.document_id);
    partial.as_object_mut().unwrap().remove("mime_type");

    let result = SyncManager::apply_downloaded_changes(
        &conn,
        [sync_change(&manifest.document_id, partial)],
        None,
    )
    .unwrap();

    assert_eq!(
        result.failure_count, 1,
        "partial files update should enter quarantine"
    );
    let after: (String, String, String, String) = conn.query_row(
        "SELECT f.blob_hash, f.sha256, f.preview_json, f.file_name FROM files f WHERE f.id = ?1",
        [&manifest.document_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).unwrap();
    assert_eq!(
        after, before,
        "invalid partial tuple cannot mutate current canonical file state"
    );
    let quarantine_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __sync_quarantine WHERE table_name = 'files' AND record_id = ?1",
            [&manifest.document_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(quarantine_count, 1);

    // The stable generated ID also identifies Ink if legacy metadata has been damaged or omitted.
    let identity = file_row_json(&conn, &manifest.document_id);
    conn.execute(
        "UPDATE files SET file_name = 'renamed.pdf', mime_type = 'application/pdf', preview_json = NULL WHERE id = ?1",
        [&manifest.document_id],
    ).unwrap();
    let mut unmarked_partial = json!({"id": manifest.document_id});
    assert!(manifest.document_id.starts_with("file_ink_"));
    assert!(super::ink::validate_change(
        &conn,
        &sync_change(&manifest.document_id, unmarked_partial.clone())
    )
    .is_err());
    unmarked_partial["file_name"] = identity["file_name"].clone();
    conn.execute(
        "UPDATE files SET file_name = ?1, mime_type = ?2, preview_json = ?3 WHERE id = ?4",
        params![
            identity["file_name"].as_str().unwrap(),
            INK_MIME,
            identity["preview_json"].as_str().unwrap(),
            manifest.document_id
        ],
    )
    .unwrap();
}

#[test]
fn incoming_missing_ink_blob_is_quarantined_and_retries_after_transfer() {
    let (_source_tmp, source_db) = migrated_db();
    let (_target_tmp, target_db) = migrated_db();
    let source_conn = source_db.get_conn().unwrap();
    let target_conn = target_db.get_conn().unwrap();
    let operation_id = "paired-missing-blob-retry";
    let source_created = VfsInkRepo::create_blank_with_conn(
        &source_conn,
        source_db.blobs_dir(),
        "Retry",
        InkRuling::Blank,
        640.0,
        480.0,
        operation_id,
        None,
    )
    .unwrap();
    let target_created = VfsInkRepo::create_blank_with_conn(
        &target_conn,
        target_db.blobs_dir(),
        "Retry",
        InkRuling::Blank,
        640.0,
        480.0,
        operation_id,
        None,
    )
    .unwrap();
    let remote = save_page_version(
        &source_conn,
        source_db.blobs_dir(),
        &source_created,
        "remote-retry",
        "bytes arrive later",
    );
    let row = incoming_row_for_target(
        &source_conn,
        source_db.blobs_dir(),
        &remote,
        &target_conn,
        &target_created,
        "2025-02-02T00:00:00Z",
    );
    let old_hash: String = target_conn
        .query_row(
            "SELECT blob_hash FROM files WHERE id = ?1",
            [&target_created.document_id],
            |row| row.get(0),
        )
        .unwrap();
    set_updated_at(
        &target_conn,
        &target_created.document_id,
        "2024-02-02T00:00:00Z",
    );

    let exact_error = SyncManager::apply_downloaded_changes_force_exact(
        &target_conn,
        &[sync_change(&target_created.document_id, row.clone())],
        None,
    )
    .expect_err("force-exact must return a retryable error rather than publish a pointer with missing bytes");
    assert!(exact_error.to_string().contains("dsink"));
    let after_force_exact: String = target_conn
        .query_row(
            "SELECT blob_hash FROM files WHERE id = ?1",
            [&target_created.document_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        after_force_exact, old_hash,
        "force-exact failure leaves the old pointer intact"
    );

    let result = SyncManager::apply_downloaded_changes(
        &target_conn,
        [sync_change(&target_created.document_id, row.clone())],
        None,
    )
    .unwrap();

    assert_eq!(
        result.failure_count, 1,
        "missing remote manifest/page bytes must not publish a pointer"
    );
    let current_hash: String = target_conn
        .query_row(
            "SELECT blob_hash FROM files WHERE id = ?1",
            [&target_created.document_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(current_hash, old_hash);
    let quarantine_id: i64 = target_conn
        .query_row(
            "SELECT id FROM __sync_quarantine WHERE table_name = 'files' AND record_id = ?1",
            [&target_created.document_id],
            |row| row.get(0),
        )
        .unwrap();

    copy_closure(
        &source_conn,
        source_db.blobs_dir(),
        &target_conn,
        target_db.blobs_dir(),
        &row,
    );
    assert!(SyncManager::retry_quarantined_change(&target_conn, quarantine_id, None).unwrap());
    let retried_hash: String = target_conn
        .query_row(
            "SELECT blob_hash FROM files WHERE id = ?1",
            [&target_created.document_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(retried_hash, row["blob_hash"]);
    let remaining: i64 = target_conn
        .query_row(
            "SELECT COUNT(*) FROM __sync_quarantine WHERE id = ?1",
            [quarantine_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(remaining, 0);
}

#[test]
fn board_v2_missing_chunk_quarantines_whole_manifest_and_applies_after_transfer() {
    let (_source_tmp, source_db) = migrated_db();
    let (_target_tmp, target_db) = migrated_db();
    let source_conn = source_db.get_conn().unwrap();
    let target_conn = target_db.get_conn().unwrap();
    let operation_id = "paired-board-chunk-closure";
    let source_created = VfsInkBoardRepo::create_blank_with_conn(
        &source_conn,
        source_db.blobs_dir(),
        "Board chunk closure",
        InkRuling::Blank,
        operation_id,
        None,
    )
    .unwrap();
    let target_created = VfsInkBoardRepo::create_blank_with_conn(
        &target_conn,
        target_db.blobs_dir(),
        "Board chunk closure",
        InkRuling::Blank,
        operation_id,
        None,
    )
    .unwrap();
    let document_id = source_created.document_id.clone();
    assert_eq!(document_id, target_created.document_id);

    let remote = VfsInkBoardRepo::save_chunks_with_conn(
        &source_conn,
        source_db.blobs_dir(),
        &document_id,
        &source_created.revision,
        "board-remote-chunk-save",
        &[
            board_chunk(
                "chunk-a",
                vec![board_rect_object(
                    "board-chunk-a",
                    10.0,
                    20.0,
                    40.0,
                    30.0,
                    0,
                )],
            ),
            board_chunk(
                "chunk-b",
                vec![board_rect_object(
                    "board-chunk-b",
                    500.0,
                    600.0,
                    20.0,
                    10.0,
                    1,
                )],
            ),
        ],
        &[],
    )
    .unwrap();
    assert_eq!(remote.chunks.len(), 2);

    let row = incoming_row_for_target(
        &source_conn,
        source_db.blobs_dir(),
        &remote,
        &target_conn,
        &target_created,
        "2025-04-02T00:00:00Z",
    );
    set_updated_at(&target_conn, &document_id, "2024-04-02T00:00:00Z");
    let old_row = file_row_json(&target_conn, &document_id);

    let manifest_hash = row["blob_hash"].as_str().unwrap().to_owned();
    let chunk_hashes = remote
        .chunks
        .iter()
        .map(|chunk| chunk.blob_hash.clone())
        .collect::<Vec<_>>();
    let present_hash = chunk_hashes[0].clone();
    let missing_hash = chunk_hashes[1].clone();
    for hash in [manifest_hash.as_str(), present_hash.as_str()] {
        let path = VfsBlobRepo::get_blob_path_with_conn(&source_conn, source_db.blobs_dir(), hash)
            .unwrap()
            .expect("source board blob exists");
        let bytes = std::fs::read(path).unwrap();
        VfsBlobRepo::store_blob_with_conn(&target_conn, target_db.blobs_dir(), &bytes, None, None)
            .unwrap();
    }
    assert!(blob_exists(
        &target_conn,
        target_db.blobs_dir(),
        &manifest_hash
    ));
    assert!(blob_exists(
        &target_conn,
        target_db.blobs_dir(),
        &present_hash
    ));
    assert!(!blob_exists(
        &target_conn,
        target_db.blobs_dir(),
        &missing_hash
    ));

    let exact_error = SyncManager::apply_downloaded_changes_force_exact(
        &target_conn,
        &[sync_change(&document_id, row.clone())],
        None,
    )
    .expect_err(
        "force-exact must not publish a board manifest while one referenced chunk is missing",
    );
    assert!(
        exact_error.to_string().contains("dsink"),
        "the missing chunk is reported as a dsink closure failure: {exact_error}"
    );
    assert_eq!(
        file_row_json(&target_conn, &document_id),
        old_row,
        "force-exact leaves the old board row, manifest hash and preview refs intact"
    );

    let result = SyncManager::apply_downloaded_changes(
        &target_conn,
        [sync_change(&document_id, row.clone())],
        None,
    )
    .unwrap();
    assert_eq!(
        result.failure_count, 1,
        "one missing chunk isolates the entire board manifest"
    );
    assert_eq!(
        file_row_json(&target_conn, &document_id),
        old_row,
        "quarantine leaves the old board row, manifest hash and preview refs intact"
    );
    let quarantine_id: i64 = target_conn
        .query_row(
            "SELECT id FROM __sync_quarantine WHERE table_name = 'files' AND record_id = ?1",
            [&document_id],
            |row| row.get(0),
        )
        .unwrap();

    let path =
        VfsBlobRepo::get_blob_path_with_conn(&source_conn, source_db.blobs_dir(), &missing_hash)
            .unwrap()
            .expect("source chunk bytes exist");
    let bytes = std::fs::read(path).unwrap();
    VfsBlobRepo::store_blob_with_conn(&target_conn, target_db.blobs_dir(), &bytes, None, None)
        .unwrap();
    assert!(SyncManager::retry_quarantined_change(&target_conn, quarantine_id, None).unwrap());

    let applied = file_row_json(&target_conn, &document_id);
    assert_eq!(applied["blob_hash"], row["blob_hash"]);
    assert_eq!(applied["preview_json"], row["preview_json"]);
    let chunks = VfsInkBoardRepo::get_chunks_with_conn(
        &target_conn,
        target_db.blobs_dir(),
        &document_id,
        &["chunk-a".to_owned(), "chunk-b".to_owned()],
    )
    .unwrap();
    assert_eq!(chunks.len(), 2);
    assert_eq!(chunks[0].objects[0].id, "board-chunk-a");
    assert_eq!(chunks[1].objects[0].id, "board-chunk-b");
}

#[test]
fn incoming_first_board_installs_writer_guard_and_capabilityless_writer_fails_closed() {
    let (_source_tmp, source_db) = migrated_db();
    let (_target_tmp, target_db) = migrated_db();
    let source_conn = source_db.get_conn().unwrap();
    let target_conn = target_db.get_conn().unwrap();
    // A valid v1 incoming on a target without any board must not install the
    // guard and must leave the database writable.
    let v1_operation_id = "paired-board-first-guard-v1";
    let v1_source = VfsInkRepo::create_blank_with_conn(
        &source_conn,
        source_db.blobs_dir(),
        "V1 before board",
        InkRuling::Blank,
        640.0,
        480.0,
        v1_operation_id,
        None,
    )
    .unwrap();
    let v1_target = VfsInkRepo::create_blank_with_conn(
        &target_conn,
        target_db.blobs_dir(),
        "V1 before board",
        InkRuling::Blank,
        640.0,
        480.0,
        v1_operation_id,
        None,
    )
    .unwrap();
    assert_eq!(v1_source.document_id, v1_target.document_id);
    set_updated_at(&target_conn, &v1_target.document_id, "2024-05-01T00:00:00Z");
    let v1_row = incoming_row_for_target(
        &source_conn,
        source_db.blobs_dir(),
        &v1_source,
        &target_conn,
        &v1_target,
        "2025-05-01T00:00:00Z",
    );
    copy_closure(
        &source_conn,
        source_db.blobs_dir(),
        &target_conn,
        target_db.blobs_dir(),
        &v1_row,
    );
    let v1_result = SyncManager::apply_downloaded_changes(
        &target_conn,
        [sync_change(&v1_target.document_id, v1_row)],
        None,
    )
    .unwrap();
    assert_eq!(v1_result.failure_count, 0);
    assert_eq!(v1_result.success_count, 1);
    assert_eq!(
        guard_trigger_count(&target_conn),
        0,
        "a v1 incoming must not install board guard triggers"
    );
    assert_eq!(
        guard_marker_installed(&target_conn),
        0,
        "a v1 incoming must not install the guard marker"
    );
    // The v1 document stays writable because no board exists.
    set_updated_at(&target_conn, &v1_target.document_id, "2024-05-02T00:00:00Z");

    let source_created = VfsInkBoardRepo::create_blank_with_conn(
        &source_conn,
        source_db.blobs_dir(),
        "Board first guard",
        InkRuling::Blank,
        "paired-board-first-guard",
        None,
    )
    .unwrap();
    let document_id = source_created.document_id.clone();
    assert_eq!(
        target_conn
            .query_row(
                "SELECT COUNT(*) FROM files WHERE id = ?1",
                [&document_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0,
        "the target has never held this board identity"
    );

    let remote = VfsInkBoardRepo::save_chunks_with_conn(
        &source_conn,
        source_db.blobs_dir(),
        &document_id,
        &source_created.revision,
        "board-first-guard-save",
        &[
            board_chunk(
                "chunk-a",
                vec![board_rect_object(
                    "board-guard-a",
                    10.0,
                    20.0,
                    40.0,
                    30.0,
                    0,
                )],
            ),
            board_chunk(
                "chunk-b",
                vec![board_rect_object(
                    "board-guard-b",
                    500.0,
                    600.0,
                    20.0,
                    10.0,
                    1,
                )],
            ),
        ],
        &[],
    )
    .unwrap();

    let mut row = file_row_json(&source_conn, &document_id);
    // Copy the real source resource mirror for this canonical board identity so
    // the target has the same resource hash as the published manifest. The
    // target still has no files row (and no board/guard) for this identity.
    let source_resource_id = row["resource_id"].as_str().unwrap().to_owned();
    let (resource_type, source_id, source_table, storage_mode, data) = source_conn
        .query_row(
            "SELECT type, source_id, source_table, storage_mode, data
             FROM resources WHERE id = ?1",
            [&source_resource_id],
            |resource| {
                Ok((
                    resource.get::<_, String>(0)?,
                    resource.get::<_, Option<String>>(1)?,
                    resource.get::<_, Option<String>>(2)?,
                    resource.get::<_, String>(3)?,
                    resource.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .unwrap();
    target_conn
        .execute(
            "INSERT INTO resources (
                 id, hash, type, source_id, source_table, storage_mode, data,
                 ref_count, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0, 0)",
            params![
                source_resource_id,
                row["blob_hash"].as_str().unwrap(),
                resource_type,
                source_id,
                source_table,
                storage_mode,
                data,
            ],
        )
        .unwrap();
    row["resource_id"] = json!(source_resource_id);
    row["updated_at"] = json!("2025-06-02T00:00:00Z");

    let manifest_hash = row["blob_hash"].as_str().unwrap().to_owned();
    let chunk_hashes = remote
        .chunks
        .iter()
        .map(|chunk| chunk.blob_hash.clone())
        .collect::<Vec<_>>();
    let missing_hash = chunk_hashes[1].clone();
    for hash in [manifest_hash.as_str(), chunk_hashes[0].as_str()] {
        let path = VfsBlobRepo::get_blob_path_with_conn(&source_conn, source_db.blobs_dir(), hash)
            .unwrap()
            .expect("source board blob exists");
        let bytes = std::fs::read(path).unwrap();
        VfsBlobRepo::store_blob_with_conn(&target_conn, target_db.blobs_dir(), &bytes, None, None)
            .unwrap();
    }
    assert!(!blob_exists(
        &target_conn,
        target_db.blobs_dir(),
        &missing_hash
    ));

    // Before completion: a failed board incoming must neither publish the v2
    // pointer nor install the writer guard.
    let failed = SyncManager::apply_downloaded_changes(
        &target_conn,
        [sync_change(&document_id, row.clone())],
        None,
    )
    .unwrap();
    assert_eq!(failed.failure_count, 1);
    assert_eq!(
        target_conn
            .query_row(
                "SELECT COUNT(*) FROM files WHERE id = ?1",
                [&document_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0,
        "a failed board incoming must not publish the board"
    );
    assert_eq!(
        guard_trigger_count(&target_conn),
        0,
        "a failed board incoming must not install guard triggers"
    );
    assert_eq!(
        guard_marker_installed(&target_conn),
        0,
        "a failed board incoming must not install the guard marker"
    );

    let quarantine_id: i64 = target_conn
        .query_row(
            "SELECT id FROM __sync_quarantine WHERE table_name = 'files' AND record_id = ?1",
            [&document_id],
            |row| row.get(0),
        )
        .unwrap();
    let path =
        VfsBlobRepo::get_blob_path_with_conn(&source_conn, source_db.blobs_dir(), &missing_hash)
            .unwrap()
            .expect("source chunk bytes exist");
    let bytes = std::fs::read(path).unwrap();
    VfsBlobRepo::store_blob_with_conn(&target_conn, target_db.blobs_dir(), &bytes, None, None)
        .unwrap();
    assert!(SyncManager::retry_quarantined_change(&target_conn, quarantine_id, None).unwrap());

    // Canonical schema 2 plus its chunks are published exactly as before.
    let applied = file_row_json(&target_conn, &document_id);
    assert_eq!(applied["blob_hash"], row["blob_hash"]);
    assert_eq!(applied["preview_json"], row["preview_json"]);
    let applied_preview: Value =
        serde_json::from_str(applied["preview_json"].as_str().unwrap()).unwrap();
    assert_eq!(applied_preview["ink"]["schema_version"], json!(2));
    let chunks = VfsInkBoardRepo::get_chunks_with_conn(
        &target_conn,
        target_db.blobs_dir(),
        &document_id,
        &["chunk-a".to_owned(), "chunk-b".to_owned()],
    )
    .unwrap();
    assert_eq!(chunks.len(), 2);
    assert_eq!(chunks[0].objects[0].id, "board-guard-a");
    assert_eq!(chunks[1].objects[0].id, "board-guard-b");

    // Expected RED: the incoming board path currently never enables the writer
    // guard, so the first successful board publish leaves the database writable
    // by capability-less connections.
    assert_eq!(
        guard_trigger_count(&target_conn),
        9,
        "the first board incoming must install all nine guard triggers"
    );
    assert_eq!(
        guard_marker_installed(&target_conn),
        1,
        "the first board incoming must mark the guard installed"
    );

    // A second raw connection with no capability keeps read access but cannot
    // mutate the board-owned tables.
    let old = Connection::open(target_db.db_path()).unwrap();
    let file_name: String = old
        .query_row(
            "SELECT file_name FROM files WHERE id = ?1",
            [&document_id],
            |row| row.get(0),
        )
        .expect("capability-less connection can read files");
    assert_eq!(file_name, "Board first guard.dsink");
    let _: i64 = old
        .query_row(
            "SELECT ref_count FROM blobs WHERE hash = ?1",
            [manifest_hash.as_str()],
            |row| row.get(0),
        )
        .expect("capability-less connection can read blobs");
    assert!(
        old.execute(
            "UPDATE files SET file_name = 'old-writer.dsink' WHERE id = ?1",
            [&document_id],
        )
        .is_err(),
        "capability-less connection must not update files"
    );
    assert!(
        old.execute("DELETE FROM files WHERE id = ?1", [&document_id])
            .is_err(),
        "capability-less connection must not delete files"
    );
    assert!(
        old.execute(
            "UPDATE blobs SET ref_count = 0 WHERE hash = ?1",
            [manifest_hash.as_str()],
        )
        .is_err(),
        "capability-less connection must not update blobs"
    );
    assert!(
        old.execute(
            "DELETE FROM blobs WHERE hash = ?1",
            [manifest_hash.as_str()]
        )
        .is_err(),
        "capability-less connection must not delete blobs"
    );
}

#[test]
fn board_v2_copy_rename_and_source_purge_keep_new_chunk_identity_and_refcounts() {
    let (_temp_dir, db) = migrated_db();
    let conn = db.get_conn().unwrap();
    let created = VfsInkBoardRepo::create_blank_with_conn(
        &conn,
        db.blobs_dir(),
        "Board copy lifecycle",
        InkRuling::Blank,
        "board-copy-lifecycle-create",
        None,
    )
    .unwrap();
    let saved = VfsInkBoardRepo::save_chunks_with_conn(
        &conn,
        db.blobs_dir(),
        &created.document_id,
        &created.revision,
        "board-copy-lifecycle-save",
        &[
            board_chunk(
                "chunk-a",
                vec![board_rect_object("board-copy-a", 10.0, 20.0, 40.0, 30.0, 0)],
            ),
            board_chunk(
                "chunk-b",
                vec![board_rect_object(
                    "board-copy-b",
                    300.0,
                    400.0,
                    10.0,
                    10.0,
                    1,
                )],
            ),
        ],
        &[],
    )
    .unwrap();
    assert_eq!(saved.chunks.len(), 2);

    let renamed = VfsInkRepo::rename_with_conn(
        &conn,
        db.blobs_dir(),
        &saved.document_id,
        &saved.revision,
        "board-copy-lifecycle-rename",
        "Board copy renamed",
    )
    .unwrap();
    assert_eq!(
        renamed.chunks, saved.chunks,
        "rename keeps every chunk reference unchanged"
    );
    let source_manifest_hash: String = conn
        .query_row(
            "SELECT blob_hash FROM files WHERE id = ?1",
            [&renamed.document_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count_for(&conn, &source_manifest_hash), 1);
    let source_chunk_hashes = renamed
        .chunks
        .iter()
        .map(|chunk| chunk.blob_hash.clone())
        .collect::<Vec<_>>();
    for hash in &source_chunk_hashes {
        assert_eq!(
            count_for(&conn, hash),
            1,
            "rename keeps each source chunk referenced exactly once"
        );
    }

    let copy = VfsInkRepo::copy_with_conn(
        &conn,
        db.blobs_dir(),
        &renamed.document_id,
        "Board copy renamed copy",
        "board-copy-lifecycle-copy",
        None,
    )
    .expect("copying a v2 board must publish a new board identity with its chunks");
    assert_ne!(copy.document_id, renamed.document_id);
    assert!(copy.document_id.starts_with("file_ink_copy_"));
    assert_eq!(copy.schema_version, INK_BOARD_SCHEMA_VERSION);
    assert_eq!(copy.chunks.len(), 2);

    let mut copy_chunk_ids = Vec::with_capacity(copy.chunks.len());
    for chunk_ref in &copy.chunks {
        assert!(
            !renamed
                .chunks
                .iter()
                .any(|source| source.chunk_id == chunk_ref.chunk_id),
            "copied board chunks receive fresh chunk identities"
        );
        assert!(blob_exists(&conn, db.blobs_dir(), &chunk_ref.blob_hash));
        copy_chunk_ids.push(chunk_ref.chunk_id.clone());
    }
    let copied_chunks = VfsInkBoardRepo::get_chunks_with_conn(
        &conn,
        db.blobs_dir(),
        &copy.document_id,
        &copy_chunk_ids,
    )
    .unwrap();
    assert_eq!(copied_chunks.len(), 2);
    for chunk in &copied_chunks {
        assert_eq!(
            chunk.objects.len(),
            1,
            "the copied chunks keep the source board content"
        );
        assert!(
            matches!(&chunk.objects[0].content, InkObjectContent::Rect { .. }),
            "the copied chunks keep the source object kind"
        );
    }
    let copy_manifest_hash: String = conn
        .query_row(
            "SELECT blob_hash FROM files WHERE id = ?1",
            [&copy.document_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count_for(&conn, &copy_manifest_hash), 1);

    VfsFileRepo::purge_file_with_conn(&conn, db.blobs_dir(), &renamed.document_id).unwrap();
    assert!(VfsFileRepo::get_file_with_conn(&conn, &renamed.document_id)
        .unwrap()
        .is_none());
    assert!(VfsFileRepo::get_file_with_conn(&conn, &copy.document_id)
        .unwrap()
        .is_some());

    let copy_chunk_hashes = copy
        .chunks
        .iter()
        .map(|chunk| chunk.blob_hash.clone())
        .collect::<Vec<_>>();
    let purged_chunks = VfsInkBoardRepo::get_chunks_with_conn(
        &conn,
        db.blobs_dir(),
        &copy.document_id,
        &copy_chunk_ids,
    )
    .unwrap();
    assert_eq!(
        purged_chunks.len(),
        2,
        "purging the source keeps both copied chunks readable"
    );
    for hash in std::iter::once(&copy_manifest_hash).chain(copy_chunk_hashes.iter()) {
        assert!(
            blob_exists(&conn, db.blobs_dir(), hash),
            "the copy keeps its blob after the source is purged"
        );
        assert_eq!(
            count_for(&conn, hash),
            1,
            "the copy keeps exactly one reference after the source is purged"
        );
    }
}

#[test]
fn lww_cloud_loser_keeps_manifest_and_dependency_blobs_pinned() {
    let (_source_tmp, source_db) = migrated_db();
    let (_target_tmp, target_db) = migrated_db();
    let source_conn = source_db.get_conn().unwrap();
    let target_conn = target_db.get_conn().unwrap();
    let operation_id = "paired-lww-conflict";
    let source_created = VfsInkRepo::create_blank_with_conn(
        &source_conn,
        source_db.blobs_dir(),
        "LWW conflict",
        InkRuling::Blank,
        640.0,
        480.0,
        operation_id,
        None,
    )
    .unwrap();
    let target_created = VfsInkRepo::create_blank_with_conn(
        &target_conn,
        target_db.blobs_dir(),
        "LWW conflict",
        InkRuling::Blank,
        640.0,
        480.0,
        operation_id,
        None,
    )
    .unwrap();
    let cloud_manifest = save_page_version(
        &source_conn,
        source_db.blobs_dir(),
        &source_created,
        "cloud-loser",
        "older cloud version",
    );
    let local_manifest = save_page_version(
        &target_conn,
        target_db.blobs_dir(),
        &target_created,
        "local-winner",
        "newer local version",
    );
    let mut cloud_row = incoming_row_for_target(
        &source_conn,
        source_db.blobs_dir(),
        &cloud_manifest,
        &target_conn,
        &local_manifest,
        "2026-10-01T00:00:00Z",
    );
    set_updated_at(
        &target_conn,
        &target_created.document_id,
        "2026-11-02T00:00:00Z",
    );
    cloud_row["updated_at"] = json!("2026-10-01T00:00:00Z");
    copy_closure(
        &source_conn,
        source_db.blobs_dir(),
        &target_conn,
        target_db.blobs_dir(),
        &cloud_row,
    );
    conn_insert_pending_files_update(&target_conn, &target_created.document_id);

    let (applied, conflict) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &target_conn,
        &[sync_change(&target_created.document_id, cloud_row.clone())],
        None,
        ConflictPolicy::KeepLatest,
        Some("cloud-device"),
        Some("local-device"),
    )
    .unwrap();

    assert_eq!(
        applied.success_count, 0,
        "the newer local files tuple remains canonical"
    );
    assert_eq!(conflict.rejected, 1, "the older cloud tuple loses LWW");
    let (cloud_manifest_hash, cloud_page_hash) = (
        cloud_row["blob_hash"].as_str().unwrap().to_owned(),
        cloud_manifest.pages[0].page_blob_hash.clone(),
    );
    SyncManager::recompute_blob_ref_counts(&target_conn).unwrap();
    assert_eq!(
        count_for(&target_conn, &cloud_manifest_hash),
        1,
        "cloud-loser manifest is conflict-pinned"
    );
    assert_eq!(
        count_for(&target_conn, &cloud_page_hash),
        1,
        "cloud-loser page dependency is conflict-pinned"
    );
}

#[test]
fn ink_render_artifacts_are_row_sync_by_render_id_and_never_field_merged() {
    let entry = super::classification::sync_classification_registry()
        .into_iter()
        .find(|entry| entry.database == "vfs" && entry.table_name == "ink_render_artifacts")
        .expect("immutable artifact provenance must be registered for VFS sync");
    assert_eq!(entry.category, super::classification::SyncCategory::RowSync);
    assert_eq!(entry.primary_key, "render_id");
    assert_eq!(
        entry.conflict_policy,
        super::classification::ConflictPolicyClass::NoConflict
    );
    assert!(entry.business_unique_keys.is_empty());
    assert!(entry.has_json_blobs);
    assert!(
        super::field_merge::field_merge_columns_for_table("ink_render_artifacts").is_empty(),
        "global render provenance cannot be field-merged"
    );
}

#[test]
fn artifact_pin_survives_visible_file_purge_and_sync_recount_gc() {
    let (_temp_dir, db) = migrated_db();
    let conn = db.get_conn().unwrap();
    let artifact = create_test_artifact(&conn, db.blobs_dir(), "sync-artifact-purge");
    let second_artifact =
        create_test_artifact(&conn, db.blobs_dir(), "sync-artifact-purge-second-render");
    assert_eq!(
        artifact.blob_hash, second_artifact.blob_hash,
        "distinct renders can share the same immutable PNG bytes"
    );
    assert_eq!(
        count_for(&conn, &artifact.blob_hash),
        3,
        "one visible file and two artifact rows hold three refs"
    );

    VfsFileRepo::purge_file_with_conn(&conn, db.blobs_dir(), &artifact.file_id).unwrap();
    assert!(blob_exists(&conn, db.blobs_dir(), &artifact.blob_hash));
    assert_eq!(
        count_for(&conn, &artifact.blob_hash),
        2,
        "purging the visible PNG leaves both immutable artifact pins"
    );

    SyncManager::recompute_blob_ref_counts(&conn).unwrap();

    assert_eq!(
        count_for(&conn, &artifact.blob_hash),
        2,
        "sync recount preserves one pin per artifact row"
    );
    VfsBlobRepo::cleanup_unreferenced(&db).unwrap();
    assert!(
        blob_exists(&conn, db.blobs_dir(), &artifact.blob_hash),
        "GC preserves artifact PNG bytes after file purge"
    );
    let (loaded, bytes) =
        VfsInkArtifactRepo::load_with_conn(&conn, db.blobs_dir(), &artifact.render_id).unwrap();
    assert_eq!(
        loaded, artifact,
        "global provenance remains readable without its visible file row"
    );
    assert_eq!(bytes, PNG_1X1);
}

#[test]
fn validated_artifact_insert_accepts_verified_png_and_recounts_one_artifact_pin() {
    let (_source_tmp, source_db) = migrated_db();
    let (_target_tmp, target_db) = migrated_db();
    let source_conn = source_db.get_conn().unwrap();
    let target_conn = target_db.get_conn().unwrap();
    let artifact = create_test_artifact(
        &source_conn,
        source_db.blobs_dir(),
        "sync-artifact-remote-insert",
    );
    let row = artifact_sync_row(&source_conn, &artifact.render_id);

    let missing = SyncManager::apply_downloaded_changes(
        &target_conn,
        [artifact_sync_change(
            &artifact.render_id,
            ChangeOperation::Insert,
            row.clone(),
        )],
        None,
    )
    .unwrap();
    assert_eq!(
        missing.failure_count, 1,
        "a provenance row cannot publish before its PNG bytes arrive"
    );
    let quarantined: i64 = target_conn
        .query_row(
            "SELECT COUNT(*) FROM __sync_quarantine WHERE table_name='ink_render_artifacts' AND record_id=?1",
            [&artifact.render_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(quarantined, 1);
    assert_eq!(
        target_conn
            .query_row("SELECT COUNT(*) FROM ink_render_artifacts", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
        0
    );

    let source_path = VfsBlobRepo::get_blob_path_with_conn(
        &source_conn,
        source_db.blobs_dir(),
        &artifact.blob_hash,
    )
    .unwrap()
    .unwrap();
    let png = std::fs::read(source_path).unwrap();
    let transferred = VfsBlobRepo::store_blob_with_conn(
        &target_conn,
        target_db.blobs_dir(),
        &png,
        Some("image/png"),
        Some("png"),
    )
    .unwrap();
    assert_eq!(transferred.hash, artifact.blob_hash);
    let quarantine_id: i64 = target_conn.query_row(
        "SELECT id FROM __sync_quarantine WHERE table_name='ink_render_artifacts' AND record_id=?1",
        [&artifact.render_id],
        |row| row.get(0),
    ).unwrap();
    assert!(SyncManager::retry_quarantined_change(&target_conn, quarantine_id, None).unwrap());

    assert_eq!(artifact_sync_row(&target_conn, &artifact.render_id), row);
    SyncManager::recompute_blob_ref_counts(&target_conn).unwrap();
    assert_eq!(
        count_for(&target_conn, &artifact.blob_hash),
        1,
        "artifact row is the sole owner without its image file row"
    );
    let (loaded, loaded_png) = VfsInkArtifactRepo::load_with_conn(
        &target_conn,
        target_db.blobs_dir(),
        &artifact.render_id,
    )
    .unwrap();
    assert_eq!(loaded, artifact);
    assert_eq!(loaded_png, PNG_1X1);
}

#[test]
fn changed_artifact_sync_upsert_is_quarantined_and_cannot_replace_provenance_or_pin() {
    let (_temp_dir, db) = migrated_db();
    let conn = db.get_conn().unwrap();
    let artifact = create_test_artifact(&conn, db.blobs_dir(), "sync-artifact-mutation");
    let before = artifact_sync_row(&conn, &artifact.render_id);
    let mut changed = before.clone();
    let mut metadata: Value =
        serde_json::from_str(changed["metadata_json"].as_str().unwrap()).unwrap();
    metadata["revision"] = json!("forged-revision");
    changed["metadata_json"] = Value::String(metadata.to_string());

    let result = SyncManager::apply_downloaded_changes(
        &conn,
        [artifact_sync_change(
            &artifact.render_id,
            ChangeOperation::Update,
            changed,
        )],
        None,
    )
    .unwrap();

    assert_eq!(result.success_count, 0);
    assert_eq!(
        result.failure_count, 1,
        "immutable provenance mutation must be quarantined"
    );
    assert_eq!(
        artifact_sync_row(&conn, &artifact.render_id),
        before,
        "original trusted render remains unchanged"
    );
    assert_eq!(
        count_for(&conn, &artifact.blob_hash),
        2,
        "quarantined mutation preserves visible-file and artifact pins"
    );
    let quarantined: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __sync_quarantine WHERE table_name = 'ink_render_artifacts' AND record_id = ?1",
            [&artifact.render_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(quarantined, 1);
}

fn conn_insert_pending_files_update(conn: &Connection, document_id: &str) {
    conn.execute(
        "INSERT INTO __change_log(table_name, record_id, operation, sync_version) VALUES ('files', ?1, 'UPDATE', 0)",
        [document_id],
    ).unwrap();
}
