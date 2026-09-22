use super::*;
use crate::vfs::{database::setup_migrated_test_db, types::VfsCreateNoteParams};

fn create(conn: &Connection, content: &str) -> VfsNote {
    VfsNoteRepo::create_note_with_conn(
        conn,
        VfsCreateNoteParams {
            title: "History integration".into(),
            content: content.into(),
            tags: vec!["original".into()],
        },
    )
    .unwrap()
}
fn head(conn: &Connection, id: &str) -> NoteRevision {
    let page = NoteRevisionRepo::list(conn, id, None, 1).unwrap();
    NoteRevisionRepo::get(conn, id, &page.items[0].version_id).unwrap()
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

#[test]
fn current_restore_cas_preserves_live_and_source_and_restores_full_envelope() {
    let (_tmp, db) = setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let original = create(&conn, "# Before\n\nOriginal\n");
    let source = head(&conn, &original.id);
    let current = edit(
        &conn,
        &original,
        "Current ![](notes_assets/_global/current/a.png)",
    );
    let live = head(&conn, &current.id);
    let current = VfsNoteRepo::update_note_metadata_with_conn(
        &conn,
        &current.id,
        VfsNoteMetadataUpdate {
            props: Some(serde_json::json!({"a":"changed"})),
            ..Default::default()
        },
    )
    .unwrap();
    let stored = NoteRevisionRepo::current(&conn, &current.id).unwrap();
    assert_eq!(stored.updated_at, current.updated_at);
    assert_eq!(stored.title, current.title);
    assert!(stored.content_md.starts_with("Current"));
    assert!(NoteRevisionRepo::restore_current(
        &conn,
        &current.id,
        &source.summary.version_id,
        &original.updated_at,
        None
    )
    .is_err());
    assert!(
        !NoteRevisionRepo::get(&conn, &current.id, &source.summary.version_id)
            .unwrap()
            .summary
            .pinned
    );
    let restored = NoteRevisionRepo::restore_current(
        &conn,
        &current.id,
        &source.summary.version_id,
        &current.updated_at,
        None,
    )
    .unwrap();
    assert_ne!(restored.updated_at, current.updated_at);
    assert_eq!(restored.props, None);
    assert_eq!(
        NoteRevisionRepo::current(&conn, &current.id)
            .unwrap()
            .content_md,
        source.content_md
    );
    assert!(
        NoteRevisionRepo::get(&conn, &current.id, &source.summary.version_id)
            .unwrap()
            .summary
            .pinned
    );
    assert!(
        NoteRevisionRepo::list_filtered(&conn, &current.id, None, 100, true)
            .unwrap()
            .items
            .iter()
            .any(|r| r.version_id != source.summary.version_id)
    );
    assert_eq!(
        head(&conn, &current.id).summary.restored_from_version_id,
        Some(source.summary.version_id)
    );
    assert!(
        NoteRevisionRepo::asset_is_referenced(&conn, "notes_assets/_global/current/a.png").unwrap()
    );
    // The source/live immutable payloads are not rewritten with new provenance.
    assert_eq!(
        NoteRevisionRepo::get(&conn, &current.id, &live.summary.version_id)
            .unwrap()
            .summary
            .restored_from_version_id,
        None
    );
}

#[test]
fn selection_rejects_partial_code_list_and_markers_and_copies_complete_nodes() {
    let (_tmp, db) = setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let note = create(
        &conn,
        "# Heading\n\n```rust\nlet x = 1;\n```\n\n- one\n- two\n",
    );
    let version = head(&conn, &note.id);
    for (start, end) in [(4, 4), (7, 7)] {
        assert!(NoteRevisionRepo::restore_selection_copy(
            &conn,
            &note.id,
            &version.summary.version_id,
            Some(&NoteHistorySelection {
                start_line: start,
                end_line: end
            })
        )
        .is_err());
    }
    let copy = NoteRevisionRepo::restore_selection_copy(
        &conn,
        &note.id,
        &version.summary.version_id,
        Some(&NoteHistorySelection {
            start_line: 3,
            end_line: 5,
        }),
    )
    .unwrap();
    assert_eq!(
        NoteRevisionRepo::current(&conn, &copy.id)
            .unwrap()
            .content_md,
        "```rust\nlet x = 1;\n```"
    );
    assert_eq!(
        NoteRevisionRepo::current(&conn, &note.id)
            .unwrap()
            .content_md,
        version.content_md
    );
    let stable = create(&conn, "<!-- ds:block-id=a -->\n\nParagraph\n");
    let version = head(&conn, &stable.id);
    assert!(NoteRevisionRepo::selected_content(
        &version,
        Some(&NoteHistorySelection {
            start_line: 3,
            end_line: 3
        })
    )
    .is_err());
    assert_eq!(
        NoteRevisionRepo::selected_content(
            &version,
            Some(&NoteHistorySelection {
                start_line: 1,
                end_line: 3
            })
        )
        .unwrap(),
        "<!-- ds:block-id=a -->\n\nParagraph"
    );
}

#[test]
fn selected_restore_replaces_whole_current_body_and_failed_history_rolls_back_everything() {
    let (_tmp, db) = setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let note = create(&conn, "First\n\nSecond\n");
    let source = head(&conn, &note.id);
    let current = edit(&conn, &note, "Live");
    let result = NoteRevisionRepo::restore_current(
        &conn,
        &note.id,
        &source.summary.version_id,
        &current.updated_at,
        Some(&NoteHistorySelection {
            start_line: 3,
            end_line: 3,
        }),
    )
    .unwrap();
    assert_eq!(
        NoteRevisionRepo::current(&conn, &note.id)
            .unwrap()
            .content_md,
        "Second"
    );
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM note_document_revisions", [], |r| {
            r.get(0)
        })
        .unwrap();
    conn.execute_batch("CREATE TRIGGER fail_restore BEFORE INSERT ON note_document_revisions WHEN NEW.source='restore_current' BEGIN SELECT RAISE(ABORT,'restore failed'); END").unwrap();
    assert!(NoteRevisionRepo::restore_current(
        &conn,
        &note.id,
        &source.summary.version_id,
        &result.updated_at,
        None
    )
    .is_err());
    let actual = NoteRevisionRepo::current(&conn, &note.id).unwrap();
    assert_eq!(actual.content_md, "Second");
    assert_eq!(actual.updated_at, result.updated_at);
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM note_document_revisions", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        count
    );
}

#[test]
fn retention_is_persistent_deferred_and_controls_coalescing_and_budget() {
    let (_tmp, db) = setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    assert_eq!(
        NoteRevisionRepo::get_retention(&conn).unwrap(),
        NoteHistoryRetention {
            edit_bucket_seconds: 300,
            max_edit_versions: Some(100)
        }
    );
    let policy = NoteHistoryRetention {
        edit_bucket_seconds: 0,
        max_edit_versions: None,
    };
    NoteRevisionRepo::set_retention(&conn, policy.clone()).unwrap();
    let other = db.get_conn_safe().unwrap();
    assert_eq!(NoteRevisionRepo::get_retention(&other).unwrap(), policy);
    let mut note = create(&conn, "zero");
    for i in 1..5 {
        note = edit(&conn, &note, &format!("body {i}"));
    }
    assert_eq!(
        NoteRevisionRepo::list(&conn, &note.id, None, 100)
            .unwrap()
            .items
            .len(),
        5
    );
    let keep = head(&conn, &note.id).summary.version_id;
    NoteRevisionRepo::set_pinned(&conn, &note.id, &keep, true).unwrap();
    NoteRevisionRepo::set_retention(
        &conn,
        NoteHistoryRetention {
            edit_bucket_seconds: 0,
            max_edit_versions: Some(1),
        },
    )
    .unwrap();
    assert_eq!(
        NoteRevisionRepo::list(&conn, &note.id, None, 100)
            .unwrap()
            .items
            .len(),
        5,
        "policy update must not prune"
    );
    note = edit(&conn, &note, "next");
    assert_eq!(
        NoteRevisionRepo::list(&conn, &note.id, None, 100)
            .unwrap()
            .items
            .len(),
        3,
        "created + pin + latest ordinary edit"
    );
    NoteRevisionRepo::set_retention(
        &conn,
        NoteHistoryRetention {
            edit_bucket_seconds: 86400,
            max_edit_versions: None,
        },
    )
    .unwrap();
    note = edit(&conn, &note, "coalesced one");
    let first = head(&conn, &note.id).summary.version_id;
    note = edit(&conn, &note, "coalesced two");
    assert!(NoteRevisionRepo::get(&conn, &note.id, &first).is_err());
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM __change_log c WHERE c.table_name='note_document_revisions' AND COALESCE(c.sync_version,0)=0 AND NOT EXISTS(SELECT 1 FROM note_document_revisions r WHERE r.version_id=c.record_id)",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    assert!(
        NoteRevisionRepo::get(&conn, &note.id, &keep)
            .unwrap()
            .summary
            .pinned
    );
}

#[test]
fn v20260923_backfills_existing_versions_by_identity_and_logs_only_immutable_inserts() {
    let conn = Connection::open_in_memory().unwrap();
    // Historical V20260922 database shape; migration is exercised as an upgrade.
    conn.execute_batch("CREATE TABLE note_document_revisions(seq INTEGER PRIMARY KEY,version_id TEXT,note_id TEXT,pinned INTEGER);
        CREATE TABLE note_document_formats(note_id TEXT PRIMARY KEY,updated_at TEXT);
        CREATE TABLE __change_log(id INTEGER PRIMARY KEY,table_name TEXT,record_id TEXT,operation TEXT,sync_version INTEGER DEFAULT 0);
        INSERT INTO note_document_revisions VALUES(1,'nrev_old','note_a',0);
        INSERT INTO note_document_formats VALUES('note_a','old');").unwrap();
    let sql = include_str!("../../../migrations/vfs/V20260923__note_history_integration.sql");
    conn.execute_batch(sql).unwrap();
    conn.execute_batch(sql).unwrap();
    let pending: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __change_log WHERE record_id='nrev_old'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(pending, 1);
    conn.execute(
        "INSERT INTO note_document_revisions VALUES(2,'nrev_new','note_a',0)",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE note_document_revisions SET pinned=1 WHERE version_id='nrev_new'",
        [],
    )
    .unwrap();
    conn.execute(
        "DELETE FROM note_document_revisions WHERE version_id='nrev_new'",
        [],
    )
    .unwrap();
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM __change_log WHERE table_name='note_document_revisions' AND record_id='nrev_new' AND operation='INSERT'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM __change_log WHERE table_name='note_document_revisions' AND operation!='INSERT'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    conn.execute(
        "UPDATE note_document_formats SET updated_at='new' WHERE note_id='note_a'",
        [],
    )
    .unwrap();
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM __change_log WHERE table_name='note_document_formats' AND operation='UPDATE'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
}
