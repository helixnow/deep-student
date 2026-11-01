use super::*;
use crate::vfs::{
    repos::{note_format_repo::NoteFormatRepo, note_relation_repo::*, note_state_repo::*},
    types::{VfsCreateNoteParams, VfsNote},
};

fn block(id: &str, body: &str) -> String {
    format!("<!-- ds:block-id={id} -->\n\n{body}\n")
}
fn create(conn: &Connection, content: &str) -> VfsNote {
    VfsNoteRepo::create_note_with_conn(
        conn,
        VfsCreateNoteParams {
            title: "Storage test".into(),
            content: content.into(),
            tags: vec![],
        },
    )
    .unwrap()
}
fn request(
    source: &VfsNote,
    target: &VfsNote,
    source_content: String,
    target_content: String,
) -> TransferBlocksRequest {
    TransferBlocksRequest {
        operation_id: "move-1".into(),
        source_note_id: source.id.clone(),
        target_note_id: target.id.clone(),
        expected_source_updated_at: source.updated_at.clone(),
        expected_target_updated_at: target.updated_at.clone(),
        source_content,
        target_content,
        block_ids: vec!["a".into()],
    }
}
fn body(conn: &Connection, note: &VfsNote) -> String {
    VfsNoteRepo::get_note_content_with_conn(conn, &note.id)
        .unwrap()
        .unwrap()
}

#[test]
fn stable_parser_rejects_partial_duplicate_and_nested_markers() {
    assert_eq!(blocks(&block("a", "# Heading")).unwrap().len(), 1);
    assert_eq!(
        blocks(&block("a", "```md\n<!-- ds:block-id=fake -->\n```"))
            .unwrap()
            .len(),
        1
    );
    assert!(blocks("```\n<!-- ds:block-id=a -->\n```\n").is_err());
    assert!(blocks("> <!-- ds:block-id=a -->\n> body\n").is_err());
    assert!(blocks(&format!("{}\nunmarked", block("a", "# Heading"))).is_err());
    assert!(blocks(&format!("{}\n{}", block("a", "one"), block("a", "two"))).is_err());
    assert!(blocks("<!-- ds:block-id=a -->\n").is_err());
    assert!(blocks(&block("a", "[ref]: https://example.com")).is_err());
}

#[test]
fn transfer_is_idempotent_and_undo_restores_exact_bytes_and_assets() {
    let (_tmp, db) = crate::vfs::database::setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let moved = block("a", "![image](notes_assets/_global/source/image.png)");
    let remain = block("b", "# Remain");
    let target_before = block("c", "Target");
    let source_before = format!("{moved}\n{remain}");
    let source = create(&conn, &source_before);
    let target = create(&conn, &target_before);
    let req = request(
        &source,
        &target,
        remain,
        format!("{target_before}\n{moved}"),
    );
    let receipt = NoteTransferRepo::transfer(&conn, req.clone()).unwrap();
    assert_eq!(body(&conn, &source), req.source_content);
    assert_eq!(body(&conn, &target), req.target_content);
    assert_eq!(
        NoteTransferRepo::transfer(&conn, req.clone()).unwrap(),
        receipt
    );
    let mut reused = req.clone();
    reused.block_ids = vec!["b".into()];
    assert!(NoteTransferRepo::transfer(&conn, reused).is_err());
    assert!(
        NoteRevisionRepo::asset_is_referenced(&conn, "notes_assets/_global/source/image.png")
            .unwrap()
    );
    let undone = NoteTransferRepo::undo(
        &conn,
        &req.operation_id,
        &receipt.source_updated_at,
        &receipt.target_updated_at,
    )
    .unwrap();
    assert!(undone.undone);
    assert_eq!(body(&conn, &source), source_before);
    assert_eq!(body(&conn, &target), target_before);
    assert_eq!(
        NoteTransferRepo::undo(
            &conn,
            &req.operation_id,
            &receipt.source_updated_at,
            &receipt.target_updated_at
        )
        .unwrap(),
        undone
    );
    assert_eq!(NoteTransferRepo::transfer(&conn, req).unwrap(), undone);
}

#[test]
fn transfer_rejects_body_tampering_and_target_occ_rolls_back_source() {
    let (_tmp, db) = crate::vfs::database::setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let a = block("a", "Original");
    let b = block("b", "Retained");
    let c = block("c", "Target");
    let source = create(&conn, &format!("{a}\n{b}"));
    let target = create(&conn, &c);
    let mut req = request(&source, &target, b.clone(), format!("{c}\n{a}"));
    req.target_content = req.target_content.replace("Original", "Tampered");
    assert!(NoteTransferRepo::transfer(&conn, req.clone()).is_err());
    req.target_content = format!("{c}\n{a}");
    req.source_content = b.replace("Retained", "Hidden edit");
    assert!(NoteTransferRepo::transfer(&conn, req.clone()).is_err());
    req.source_content = b;
    req.expected_target_updated_at = "stale".into();
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM note_document_revisions", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(NoteTransferRepo::transfer(&conn, req).is_err());
    assert_eq!(
        VfsNoteRepo::get_note_with_conn(&conn, &source.id)
            .unwrap()
            .unwrap()
            .updated_at,
        source.updated_at
    );
    assert_eq!(
        body(&conn, &source),
        format!("{a}\n{}", block("b", "Retained"))
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM note_document_revisions", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        count
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM note_transfer_operations", [], |r| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        0
    );
}

#[test]
fn receipt_failure_rolls_back_both_pages_history_and_resource_cleanup() {
    let (_tmp, db) = crate::vfs::database::setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let a = block("a", "Image ![](notes_assets/_global/a/x.png)");
    let c = block("c", "Target");
    let source = create(&conn, &a);
    let target = create(&conn, &c);
    conn.execute_batch("CREATE TRIGGER fail_receipt BEFORE INSERT ON note_transfer_operations BEGIN SELECT RAISE(ABORT,'injected'); END").unwrap();
    assert!(NoteTransferRepo::transfer(
        &conn,
        request(&source, &target, String::new(), format!("{c}\n{a}"))
    )
    .is_err());
    for note in [&source, &target] {
        let current = VfsNoteRepo::get_note_with_conn(&conn, &note.id)
            .unwrap()
            .unwrap();
        assert_eq!(current.resource_id, note.resource_id);
        assert_eq!(current.updated_at, note.updated_at);
    }
    assert_eq!(body(&conn, &source), a);
    assert_eq!(body(&conn, &target), c);
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM note_document_revisions", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
}

#[test]
fn undo_never_clobbers_a_later_edit_even_with_fresh_caller_tokens() {
    let (_tmp, db) = crate::vfs::database::setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let a = block("a", "Source");
    let c = block("c", "Target");
    let source = create(&conn, &a);
    let target = create(&conn, &c);
    let receipt = NoteTransferRepo::transfer(
        &conn,
        request(&source, &target, String::new(), format!("{c}\n{a}")),
    )
    .unwrap();
    let edited = VfsNoteRepo::update_note_with_conn(
        &conn,
        &target.id,
        VfsUpdateNoteParams {
            content: Some(block("c", "Later edit")),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(NoteTransferRepo::undo(
        &conn,
        "move-1",
        &receipt.source_updated_at,
        &receipt.target_updated_at
    )
    .is_err());
    assert!(NoteTransferRepo::undo(
        &conn,
        "move-1",
        &receipt.source_updated_at,
        &edited.updated_at
    )
    .is_err());
    assert_eq!(body(&conn, &source), "");
    assert_eq!(body(&conn, &target), block("c", "Later edit"));
}

#[test]
fn migration_is_explicit_lossless_and_baseline_is_retained() {
    let (_tmp, db) = crate::vfs::database::setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let note = create(&conn, "# Heading\n\nBody\n");
    let marked = "<!-- ds:block-id=a -->\n# Heading\n\n<!-- ds:block-id=b -->\nBody\n";
    assert!(VfsNoteRepo::update_note_with_conn(
        &conn,
        &note.id,
        VfsUpdateNoteParams {
            content: Some(marked.into()),
            ..Default::default()
        }
    )
    .is_err());
    assert!(NoteFormatRepo::migrate(
        &conn,
        &note.id,
        &note.updated_at,
        &marked.replace("Body", "Changed")
    )
    .is_err());
    let migrated = NoteFormatRepo::migrate(&conn, &note.id, &note.updated_at, marked).unwrap();
    let format = NoteFormatRepo::get(&conn, &note.id).unwrap();
    assert_eq!(format.content_format, "markdown-blocks");
    assert_eq!(
        NoteRevisionRepo::get(
            &conn,
            &note.id,
            format.baseline_version_id.as_ref().unwrap()
        )
        .unwrap()
        .content_md,
        "# Heading\n\nBody\n"
    );
    assert!(VfsNoteRepo::update_note_with_conn(
        &conn,
        &note.id,
        VfsUpdateNoteParams {
            content: Some("marker stripped".into()),
            ..Default::default()
        }
    )
    .is_err());
    conn.execute(
        "UPDATE note_document_formats SET format_version=99 WHERE note_id=?1",
        [&note.id],
    )
    .unwrap();
    assert!(VfsNoteRepo::update_note_with_conn(
        &conn,
        &note.id,
        VfsUpdateNoteParams {
            content: Some(marked.into()),
            ..Default::default()
        }
    )
    .is_err());
    assert_eq!(
        VfsNoteRepo::get_note_with_conn(&conn, &note.id)
            .unwrap()
            .unwrap()
            .updated_at,
        migrated.updated_at
    );
}

#[test]
fn per_entry_cas_and_tombstone_prevent_lost_reviews_and_aba() {
    let (_tmp, db) = crate::vfs::database::setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let note = create(&conn, "");
    let key = NoteStateKey {
        note_id: note.id.clone(),
        r#type: NoteStateType::Review,
        key: "review-a".into(),
    };
    let put = |expected| NoteStatePut {
        entry: key.clone(),
        expected_revision: expected,
        value: serde_json::json!({"candidate":"hello"}),
    };
    let created = NoteStateRepo::put(&conn, put(None)).unwrap();
    assert_eq!(created.revision, 1);
    let second = db.get_conn_safe().unwrap();
    assert_eq!(
        NoteStateRepo::get(&second, &key).unwrap().unwrap().revision,
        1
    );
    assert!(NoteStateRepo::put(&second, put(None)).is_err());
    let updated = NoteStateRepo::put(&second, put(Some(1))).unwrap();
    assert_eq!(updated.revision, 2);
    assert!(NoteStateRepo::put(&conn, put(Some(1))).is_err());
    let deleted = NoteStateRepo::delete(
        &conn,
        NoteStateDelete {
            entry: key.clone(),
            expected_revision: 2,
        },
    )
    .unwrap();
    assert_eq!(deleted.revision, 3);
    assert!(deleted.deleted);
    assert!(NoteStateRepo::put(&second, put(None)).is_err());
    assert!(NoteStateRepo::put(&second, put(Some(1))).is_err());
    assert_eq!(
        NoteStateRepo::put(&second, put(Some(3))).unwrap().revision,
        4
    );
    let mut other = key.clone();
    other.key = "review-b".into();
    NoteStateRepo::put(
        &conn,
        NoteStatePut {
            entry: other,
            expected_revision: None,
            value: serde_json::json!("independent"),
        },
    )
    .unwrap();
    assert_eq!(
        NoteStateRepo::list(
            &conn,
            &NoteStateList {
                note_id: note.id,
                r#type: NoteStateType::Review,
                include_deleted: false
            }
        )
        .unwrap()
        .len(),
        2
    );
}

#[test]
fn relationships_follow_note_resource_replacement_and_invalidate_deleted_blocks() {
    let (_tmp, db) = crate::vfs::database::setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let owner = create(&conn, "");
    let target = create(&conn, &block("a", "Target"));
    let created = NoteRelationRepo::put(
        &conn,
        None,
        NoteRelationPut {
            id: "relation-a".into(),
            note_id: owner.id.clone(),
            block_id: None,
            r#type: NoteRelationType::Source,
            resource_id: target.resource_id.clone(),
            locator: NoteLocator::Block("a".into()),
            expected_revision: None,
        },
    )
    .unwrap();
    assert!(created.reference.locator_exists);
    let updated = VfsNoteRepo::update_note_with_conn(
        &conn,
        &target.id,
        VfsUpdateNoteParams {
            content: Some(block("a", "Changed")),
            ..Default::default()
        },
    )
    .unwrap();
    let relation = NoteRelationRepo::get(&conn, None, "relation-a")
        .unwrap()
        .unwrap();
    assert_eq!(relation.resource_id, updated.resource_id);
    assert!(relation.invalidated_at.is_none());
    assert!(relation.reference.locator_exists);
    assert!(NoteRelationRepo::delete(&conn, "relation-a", created.revision).is_err());
    VfsNoteRepo::update_note_with_conn(
        &conn,
        &target.id,
        VfsUpdateNoteParams {
            content: Some(String::new()),
            ..Default::default()
        },
    )
    .unwrap();
    let invalid = NoteRelationRepo::get(&conn, None, "relation-a")
        .unwrap()
        .unwrap();
    assert!(invalid.invalidated_at.is_some());
    assert!(!invalid.reference.locator_exists);
    assert!(NoteRelationRepo::delete(&conn, "relation-a", invalid.revision).unwrap());
}

#[test]
fn contract_serializes_type_and_deserializes_flat_state_requests() {
    let input = serde_json::json!({"note_id":"note_a","type":"review","key":"review_a","expected_revision":null,"value":{"text":"draft"}});
    let parsed: NoteStatePut = serde_json::from_value(input).unwrap();
    assert!(matches!(parsed.entry.r#type, NoteStateType::Review));
    assert_eq!(
        serde_json::to_value(NoteLocator::Page(12)).unwrap(),
        serde_json::json!({"type":"page","value":12})
    );
    assert!(serde_json::from_value::<NoteStateKey>(
        serde_json::json!({"note_id":"a","type":"future","key":"x"})
    )
    .is_err());
}

#[test]
fn anki_reference_uses_real_card_and_document_rows_and_observes_deletion() {
    let (_tmp, db) = crate::vfs::database::setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let anki = Connection::open_in_memory().unwrap();
    anki.execute_batch(
        "CREATE TABLE document_tasks(id TEXT PRIMARY KEY,document_id TEXT,deleted_at TEXT);
        CREATE TABLE anki_cards(id TEXT PRIMARY KEY,task_id TEXT,deleted_at TEXT);
        INSERT INTO document_tasks VALUES('task-a','document-a',NULL);
        INSERT INTO anki_cards VALUES('card-a','task-a',NULL);",
    )
    .unwrap();
    let owner = create(&conn, "");
    let request = NoteRelationPut {
        id: "anki-relation".into(),
        note_id: owner.id,
        block_id: None,
        r#type: NoteRelationType::Card,
        resource_id: "document-a".into(),
        locator: NoteLocator::Card("card-a".into()),
        expected_revision: None,
    };
    assert!(
        NoteRelationRepo::put(&conn, Some(&anki), request)
            .unwrap()
            .reference
            .locator_exists
    );
    assert!(
        !NoteRelationRepo::reference_status(
            &conn,
            Some(&anki),
            "document-b",
            &NoteLocator::Card("card-a".into())
        )
        .unwrap()
        .locator_exists
    );
    anki.execute(
        "UPDATE anki_cards SET deleted_at='deleted' WHERE id='card-a'",
        [],
    )
    .unwrap();
    let status = NoteRelationRepo::get(&conn, Some(&anki), "anki-relation")
        .unwrap()
        .unwrap()
        .reference;
    assert!(status.resource_exists);
    assert!(!status.locator_exists);
    assert_eq!(
        NoteRelationRepo::invalidate_resource(&conn, "document-a").unwrap(),
        1
    );
    assert!(NoteRelationRepo::get(&conn, Some(&anki), "anki-relation")
        .unwrap()
        .unwrap()
        .invalidated_at
        .is_some());
}

#[test]
fn future_body_header_is_not_overwritten_even_when_format_metadata_is_legacy() {
    let (_tmp, db) = crate::vfs::database::setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let note = create(&conn, "old");
    // Simulate a future writer/sync which preserves its raw envelope.
    conn.execute(
        "UPDATE resources SET data='<!-- ds:note-schema=99 -->\nfuture document' WHERE id=?1",
        [&note.resource_id],
    )
    .unwrap();
    assert!(VfsNoteRepo::update_note_with_conn(
        &conn,
        &note.id,
        VfsUpdateNoteParams {
            content: Some("old client autosave".into()),
            ..Default::default()
        }
    )
    .is_err());
    assert!(body(&conn, &note).contains("ds:note-schema=99"));
}

#[test]
fn second_page_history_failure_rolls_back_source_and_all_retention_changes() {
    let (_tmp, db) = crate::vfs::database::setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let a = block("a", "Move me");
    let c = block("c", "Target");
    let source = create(&conn, &a);
    let target = create(&conn, &c);
    conn.execute_batch(&format!("CREATE TRIGGER fail_target_history BEFORE INSERT ON note_document_revisions WHEN NEW.note_id='{}' BEGIN SELECT RAISE(ABORT,'target history failed'); END",target.id)).unwrap();
    assert!(NoteTransferRepo::transfer(
        &conn,
        request(&source, &target, String::new(), format!("{c}\n{a}"))
    )
    .is_err());
    assert_eq!(body(&conn, &source), a);
    assert_eq!(body(&conn, &target), c);
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM note_document_revisions", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM note_transfer_operations", [], |r| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        0
    );
}
