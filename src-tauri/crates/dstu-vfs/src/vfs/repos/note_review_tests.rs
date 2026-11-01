use super::*;
use crate::vfs::database::setup_migrated_test_db;

#[test]
fn save_as_create_and_update_retries_never_duplicate_or_clobber_a_newer_edit() {
    let (_tmp, db) = setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let source = VfsNoteRepo::create_note_with_conn(
        &conn,
        VfsCreateNoteParams {
            title: "Source".into(),
            content: "original".into(),
            tags: vec![],
        },
    )
    .unwrap();
    let mut request = ReviewSaveRequest {
        operation_id: "review-op".into(),
        source_note_id: source.id.clone(),
        markdown: "first result".into(),
        expected_updated_at: None,
        capabilities: vec![],
    };
    let first = NoteReviewRepo::save_as(&conn, request.clone()).unwrap();
    assert_eq!(
        NoteReviewRepo::save_as(&conn, request.clone()).unwrap(),
        first
    );
    let create_request = request.clone();
    request.markdown = "second result".into();
    assert!(
        NoteReviewRepo::save_as(&conn, request.clone()).is_err(),
        "same creation step cannot change its payload"
    );
    request.expected_updated_at = Some(first.updated_at.clone());
    let second = NoteReviewRepo::save_as(&conn, request.clone()).unwrap();
    assert_eq!(second.note_id, first.note_id);
    assert_eq!(second.revision, 2);
    assert_eq!(
        NoteReviewRepo::save_as(&conn, request.clone()).unwrap(),
        second
    );
    assert_eq!(
        NoteReviewRepo::save_as(&conn, create_request).unwrap(),
        first,
        "lost first response returns first receipt even after later CAS steps"
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    VfsNoteRepo::update_note_with_conn(
        &conn,
        &second.note_id,
        VfsUpdateNoteParams {
            content: Some("other WebView edit".into()),
            expected_updated_at: Some(second.updated_at.clone()),
            ..Default::default()
        },
    )
    .unwrap();
    request.markdown = "stale candidate".into();
    request.expected_updated_at = Some(second.updated_at);
    assert!(NoteReviewRepo::save_as(&conn, request).is_err());
    assert_eq!(
        VfsNoteRepo::get_note_content_with_conn(&conn, &first.note_id)
            .unwrap()
            .unwrap(),
        "other WebView edit"
    );
    assert_eq!(
        VfsNoteRepo::get_note_content_with_conn(&conn, &source.id)
            .unwrap()
            .unwrap(),
        "original"
    );
}

#[test]
fn save_as_receipt_failure_rolls_back_copy_folder_history_and_identity() {
    let (_tmp, db) = setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let source = VfsNoteRepo::create_note_with_conn(
        &conn,
        VfsCreateNoteParams {
            title: "Source".into(),
            content: "original".into(),
            tags: vec![],
        },
    )
    .unwrap();
    let request = ReviewSaveRequest {
        operation_id: "failed-review".into(),
        source_note_id: source.id,
        markdown: "copy".into(),
        expected_updated_at: None,
        capabilities: vec![],
    };
    conn.execute_batch("CREATE TRIGGER fail_review_receipt BEFORE INSERT ON note_review_save_receipts BEGIN SELECT RAISE(ABORT,'receipt failed'); END").unwrap();
    assert!(NoteReviewRepo::save_as(&conn, request.clone()).is_err());
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM note_review_save_operations",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM folder_items", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    conn.execute_batch("DROP TRIGGER fail_review_receipt")
        .unwrap();
    assert!(NoteReviewRepo::save_as(&conn, request).is_ok());
}
