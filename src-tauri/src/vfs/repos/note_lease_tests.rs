use super::*;
use crate::vfs::{
    database::setup_migrated_test_db,
    types::{VfsCreateNoteParams, VfsNote, VfsUpdateNoteParams},
};

fn create(conn: &Connection) -> VfsNote {
    VfsNoteRepo::create_note_with_conn(
        conn,
        VfsCreateNoteParams {
            title: "Lease test".into(),
            content: "Before".into(),
            tags: vec![],
        },
    )
    .unwrap()
}
fn register(conn: &Connection, note: &VfsNote, view: &str) -> String {
    NoteLeaseRepo::register(conn, &note.id, view, view, 100)
        .unwrap()
        .participant_id
}
fn begin(conn: &Connection, note: &VfsNote, owner: &str) -> NoteLeaseAuth {
    let lease = NoteLeaseRepo::begin(conn, owner, "a", "op", vec![note.id.clone()], 100).unwrap();
    NoteLeaseAuth {
        participant_id: owner.into(),
        token: lease.token,
    }
}
fn draft(note: &VfsNote, markdown: &str) -> FrozenDraft {
    FrozenDraft {
        markdown: markdown.into(),
        expected_updated_at: note.updated_at.clone(),
    }
}
fn edit(conn: &Connection, note: &VfsNote, markdown: &str) -> VfsResult<VfsNote> {
    VfsNoteRepo::update_note_with_conn(
        conn,
        &note.id,
        VfsUpdateNoteParams {
            content: Some(markdown.into()),
            expected_updated_at: Some(note.updated_at.clone()),
            ..Default::default()
        },
    )
}

#[test]
fn pending_fences_repo_raw_sql_and_other_connection_and_preserves_history() {
    let (_tmp, db) = setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let note = create(&conn);
    let owner = register(&conn, &note, "a");
    let auth = begin(&conn, &note, &owner);
    let other = db.get_conn_safe().unwrap();
    assert!(edit(&other, &note, "stale").is_err());
    assert!(other
        .execute(
            "UPDATE resources SET data='bypass' WHERE id=?1",
            [&note.resource_id]
        )
        .is_err());
    assert!(other
        .execute("UPDATE notes SET title='bypass' WHERE id=?1", [&note.id])
        .is_err());
    assert!(VfsNoteRepo::delete_note_with_conn(&other, &note.id).is_err());
    assert!(VfsNoteRepo::purge_note_with_conn(&other, &note.id).is_err());
    assert!(NoteLeaseRepo::flush(&conn, &auth, "a", &note.id, &[], 100).is_err());
    assert_eq!(
        NoteRevisionRepo::current(&other, &note.id)
            .unwrap()
            .content_md,
        "Before"
    );
    assert_eq!(
        NoteRevisionRepo::list(&other, &note.id, None, 100)
            .unwrap()
            .items
            .len(),
        1
    );
    NoteLeaseRepo::release(&conn, &auth, "a", true, 101).unwrap();
    assert!(
        NoteLeaseRepo::authorized(&conn, &auth, "a", 101, true, || edit(&conn, &note, "late"))
            .is_err()
    );
    edit(&other, &note, "normal").unwrap();
}

#[test]
fn unanimous_drafts_flush_once_commit_and_hold_until_all_refresh() {
    let (_tmp, db) = setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let note = create(&conn);
    let a = register(&conn, &note, "a");
    let b = register(&conn, &note, "b");
    let auth = begin(&conn, &note, &a);
    assert_eq!(
        NoteLeaseRepo::ack(&conn, &auth, "a", draft(&note, "Draft"), 100)
            .unwrap()
            .phase,
        "pending"
    );
    let peer = NoteLeaseAuth {
        participant_id: b,
        token: auth.token.clone(),
    };
    assert_eq!(
        NoteLeaseRepo::ack(&conn, &peer, "b", draft(&note, "Draft"), 100)
            .unwrap()
            .phase,
        "ready"
    );
    assert!(
        NoteLeaseRepo::authorized(&conn, &auth, "a", 100, true, || Ok(())).is_err(),
        "dirty drafts must flush first"
    );
    assert!(
        NoteLeaseRepo::flush(&conn, &peer, "b", &note.id, &[], 100).is_err(),
        "only owner writes"
    );
    let flushed = NoteLeaseRepo::flush(&conn, &auth, "a", &note.id, &[], 100).unwrap();
    let again = NoteLeaseRepo::flush(&conn, &auth, "a", &note.id, &[], 100).unwrap();
    assert_eq!(again.updated_at, flushed.updated_at);
    let live = VfsNoteRepo::get_note_with_conn(&conn, &note.id)
        .unwrap()
        .unwrap();
    let committed = NoteLeaseRepo::authorized(&conn, &auth, "a", 100, true, || {
        edit(&conn, &live, "Committed")
    })
    .unwrap();
    assert!(edit(&conn, &committed, "uncoordinated").is_err());
    assert!(NoteLeaseRepo::release(&conn, &auth, "a", false, 100).is_err());
    NoteLeaseRepo::finish(&conn, &auth, "a", 100).unwrap();
    assert!(NoteLeaseRepo::refresh_ack(&conn, &peer, "b", &note.updated_at, 100).is_err());
    NoteLeaseRepo::refresh_ack(&conn, &auth, "a", &committed.updated_at, 100).unwrap();
    NoteLeaseRepo::refresh_ack(&conn, &peer, "b", &committed.updated_at, 100).unwrap();
    NoteLeaseRepo::release(&conn, &auth, "a", false, 100).unwrap();
    edit(&conn, &committed, "After release").unwrap();
}

#[test]
fn late_registration_reopens_barrier_and_divergent_or_stale_ack_cannot_authorize() {
    let (_tmp, db) = setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let note = create(&conn);
    let a = register(&conn, &note, "a");
    let auth = begin(&conn, &note, &a);
    NoteLeaseRepo::ack(&conn, &auth, "a", draft(&note, "Draft"), 100).unwrap();
    let late = NoteLeaseRepo::register(&conn, &note.id, "b", "b", 101).unwrap();
    assert_eq!(late.active_lease.unwrap().phase, "pending");
    assert!(NoteLeaseRepo::flush(&conn, &auth, "a", &note.id, &[], 101).is_err());
    let peer = NoteLeaseAuth {
        participant_id: late.participant_id,
        token: auth.token.clone(),
    };
    assert!(NoteLeaseRepo::ack(&conn, &peer, "a", draft(&note, "Draft"), 101).is_err());
    assert!(NoteLeaseRepo::ack(&conn, &peer, "b", draft(&note, "Different"), 101).is_err());
    assert!(NoteLeaseRepo::ack(
        &conn,
        &peer,
        "b",
        FrozenDraft {
            markdown: "Draft".into(),
            expected_updated_at: "stale".into()
        },
        101
    )
    .is_err());
    assert!(NoteLeaseRepo::authorized(&conn, &auth, "a", 101, true, || Ok(())).is_err());
    assert_eq!(
        NoteRevisionRepo::current(&conn, &note.id)
            .unwrap()
            .content_md,
        "Before"
    );
}

#[test]
fn heartbeat_does_not_extend_pending_deadline_and_close_cancels_whole_lease() {
    let (_tmp, db) = setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let note = create(&conn);
    let a = register(&conn, &note, "a");
    let b = register(&conn, &note, "b");
    let auth = begin(&conn, &note, &a);
    NoteLeaseRepo::heartbeat(&conn, &a, "a", 125).unwrap();
    assert_eq!(
        NoteLeaseRepo::cleanup(&conn, 131, None, None)
            .unwrap()
            .len(),
        1
    );
    assert!(NoteLeaseRepo::status(&conn, &auth.token).unwrap().is_none());
    let auth = begin(&conn, &note, &a);
    assert_eq!(
        NoteLeaseRepo::cleanup(&conn, 101, Some("b"), None)
            .unwrap()
            .len(),
        1
    );
    assert!(NoteLeaseRepo::heartbeat(&conn, &b, "b", 101).is_err());
    assert!(NoteLeaseRepo::status(&conn, &auth.token).unwrap().is_none());
    let auth = begin(&conn, &note, &a);
    assert_eq!(
        NoteLeaseRepo::cleanup(&conn, 101, None, Some("a"))
            .unwrap()
            .len(),
        1
    );
    assert!(NoteLeaseRepo::status(&conn, &auth.token).unwrap().is_none());
}

#[test]
fn sorted_multi_note_acquisition_rolls_back_on_overlap_and_grants_rollback_on_failure() {
    let (_tmp, db) = setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let first = create(&conn);
    let second = create(&conn);
    let a = register(&conn, &first, "a");
    let b = register(&conn, &second, "b");
    let auth = begin(&conn, &first, &a);
    assert!(NoteLeaseRepo::begin(
        &conn,
        &b,
        "b",
        "other",
        vec![second.id.clone(), first.id.clone()],
        100
    )
    .is_err());
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM note_editor_lease_notes", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    NoteLeaseRepo::ack(&conn, &auth, "a", draft(&first, "Before"), 100).unwrap();
    assert!(
        NoteLeaseRepo::authorized(&conn, &auth, "a", 100, true, || edit(
            &conn,
            &second,
            "outside scope"
        ))
        .is_err()
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM note_editor_write_grants", [], |r| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        0
    );
    assert_eq!(
        NoteLeaseRepo::status(&conn, &auth.token)
            .unwrap()
            .unwrap()
            .phase,
        "ready"
    );
    assert_eq!(
        NoteRevisionRepo::current(&conn, &second.id)
            .unwrap()
            .content_md,
        "Before"
    );
}

#[test]
fn authorized_multi_step_writes_advance_the_frozen_baseline() {
    let (_tmp, db) = setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let note = create(&conn);
    let owner = register(&conn, &note, "a");
    let auth = begin(&conn, &note, &owner);
    NoteLeaseRepo::ack(&conn, &auth, "a", draft(&note, "Before"), 100).unwrap();
    let first = NoteLeaseRepo::authorized(&conn, &auth, "a", 100, true, || {
        edit(&conn, &note, "Step one")
    })
    .unwrap();
    let second = NoteLeaseRepo::authorized(&conn, &auth, "a", 100, true, || {
        edit(&conn, &first, "Step two")
    })
    .unwrap();
    assert_eq!(
        NoteRevisionRepo::current(&conn, &note.id)
            .unwrap()
            .content_md,
        "Step two"
    );
    NoteLeaseRepo::finish(&conn, &auth, "a", 100).unwrap();
    NoteLeaseRepo::refresh_ack(&conn, &auth, "a", &second.updated_at, 100).unwrap();
    NoteLeaseRepo::release(&conn, &auth, "a", false, 100).unwrap();
}

#[test]
fn relationship_logs_and_pin_backfill_use_row_sync_identity_and_replay_suppression() {
    use super::super::note_relation_repo::*;
    let (_tmp, db) = setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let note = create(&conn);
    NoteRelationRepo::put(
        &conn,
        None,
        NoteRelationPut {
            id: "rel".into(),
            note_id: note.id.clone(),
            block_id: None,
            r#type: NoteRelationType::Source,
            resource_id: note.resource_id.clone(),
            locator: NoteLocator::Whole,
            expected_revision: None,
        },
    )
    .unwrap();
    NoteRelationRepo::invalidate_resource(&conn, &note.resource_id).unwrap();
    let version = NoteRevisionRepo::list(&conn, &note.id, None, 1)
        .unwrap()
        .items
        .remove(0)
        .version_id;
    conn.execute("UPDATE __change_log SET sync_version=1", [])
        .unwrap();
    let max: i64 = conn
        .query_row("SELECT MAX(id) FROM __change_log", [], |r| r.get(0))
        .unwrap();
    NoteRevisionRepo::set_pinned(&conn, &note.id, &version, true).unwrap();
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM __change_log WHERE table_name='note_document_revisions' AND record_id=?1 AND operation='UPDATE' AND sync_version=0",[&version],|r|r.get::<_,i64>(0)).unwrap(),1);
    // Exact existing ChangeLog replay suppression: no new flag or global switch.
    conn.execute("UPDATE __change_log SET sync_version=1 WHERE id>?1 AND table_name='note_document_revisions' AND record_id=?2",params![max,version]).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM __change_log WHERE sync_version=0",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    let sql = include_str!("../../../migrations/vfs/V20260924__note_editor_leases.sql");
    conn.execute_batch(sql).unwrap();
    conn.execute_batch(sql).unwrap();
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM __change_log WHERE table_name='note_learning_relations' AND record_id='rel' AND sync_version=0",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM __change_log WHERE table_name='note_document_revisions' AND record_id=?1 AND sync_version=0",[&version],|r|r.get::<_,i64>(0)).unwrap(),1);
    NoteRelationRepo::delete(&conn, "rel", 2).unwrap();
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM __change_log WHERE table_name='note_learning_relations' AND record_id='rel' AND operation='DELETE'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
}
