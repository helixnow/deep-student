use super::*;
use crate::vfs::{
    database::setup_migrated_test_db,
    repos::{
        note_format_repo::{blocks, NoteFormatRepo, COLUMNS_CAPABILITY},
        note_history_restore::NoteHistorySelection,
        note_repo::VfsNoteRepo,
        note_revision_repo::NoteRevisionRepo,
        note_transfer_repo::{NoteTransferRepo, TransferBlocksRequest},
    },
    types::{VfsCreateNoteParams, VfsUpdateNoteParams},
};

const COLUMNS:&str=":::ds-columns{version=1 layout=cornell}\n\n:::column\n\n## Cues\n\nQuestion\n\n:::end-column\n\n:::column\n\n## Notes\n\nAnswer\n\n:::end-column\n\n:::end-ds-columns\n";
fn create(conn: &rusqlite::Connection, content: &str) -> crate::vfs::types::VfsNote {
    VfsNoteRepo::create_note_with_conn(
        conn,
        VfsCreateNoteParams {
            title: "Columns".into(),
            content: content.into(),
            tags: vec![],
        },
    )
    .unwrap()
}

#[test]
fn columns_are_one_root_node_and_fenced_escaped_quoted_examples_are_literals() {
    let parsed = roots(&format!("{COLUMNS}\n## Summary\n\nFull width\n")).unwrap();
    assert_eq!(parsed.len(), 3);
    assert!(parsed[0].columns);
    let stable = format!("<!-- ds:block-id=cols -->\n\n{COLUMNS}");
    let parsed = blocks(&stable).unwrap();
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].id, "cols");
    assert!(parsed[0].body.ends_with(":::end-ds-columns"));
    for literal in [
        format!("```md\n{COLUMNS}```\n"),
        "\\:::ds-columns{version=99 layout=equal}\n".into(),
        "> :::ds-columns{version=99 layout=equal}\n".into(),
    ] {
        assert!(roots(&literal).unwrap().iter().all(|r| !r.columns));
    }
    for malformed in [
        COLUMNS.replace("version=1", "version=99"),
        COLUMNS.replace(":::end-ds-columns\n", ""),
        COLUMNS.replace(
            ":::column\n\n## Notes",
            ":::ds-columns{version=1 layout=equal}\n\n## Notes",
        ),
        COLUMNS.replace(
            ":::end-ds-columns",
            ":::column\n\nthird\n\n:::end-column\n\n:::end-ds-columns",
        ),
    ] {
        assert!(roots(&malformed).is_err());
    }
}

#[test]
fn enabling_columns_is_lossless_pins_baseline_and_demands_capable_cas_saves() {
    let (_tmp, db) = setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let note = create(&conn, "Original\n");
    let initial = NoteRevisionRepo::list(&conn, &note.id, None, 1)
        .unwrap()
        .items[0]
        .version_id
        .clone();
    assert!(
        VfsNoteRepo::update_note_with_capabilities(
            &conn,
            &note.id,
            VfsUpdateNoteParams {
                content: Some(COLUMNS.into()),
                expected_updated_at: Some(note.updated_at.clone()),
                ..Default::default()
            },
            &[COLUMNS_CAPABILITY.into()]
        )
        .is_err(),
        "capability is not page opt-in"
    );
    let enabled = NoteFormatRepo::enable_columns(&conn, &note.id, &note.updated_at).unwrap();
    assert_ne!(enabled.updated_at, note.updated_at);
    assert_eq!(
        VfsNoteRepo::get_note_content_with_conn(&conn, &note.id)
            .unwrap()
            .unwrap(),
        "Original\n"
    );
    let format = NoteFormatRepo::get(&conn, &note.id).unwrap();
    assert_eq!(format.serializer_version, "markdown-v1+ds-columns-v1");
    assert_eq!(format.baseline_version_id, Some(initial.clone()));
    assert!(
        NoteRevisionRepo::get(&conn, &note.id, &initial)
            .unwrap()
            .summary
            .pinned
    );
    assert!(VfsNoteRepo::update_note_with_conn(
        &conn,
        &note.id,
        VfsUpdateNoteParams {
            content: Some("legacy clobber".into()),
            expected_updated_at: Some(enabled.updated_at.clone()),
            ..Default::default()
        }
    )
    .is_err());
    assert!(VfsNoteRepo::update_note_with_capabilities(
        &conn,
        &note.id,
        VfsUpdateNoteParams {
            content: Some(COLUMNS.into()),
            expected_updated_at: Some(note.updated_at),
            ..Default::default()
        },
        &[COLUMNS_CAPABILITY.into()]
    )
    .is_err());
    VfsNoteRepo::update_note_with_capabilities(
        &conn,
        &note.id,
        VfsUpdateNoteParams {
            content: Some(COLUMNS.into()),
            expected_updated_at: Some(enabled.updated_at),
            ..Default::default()
        },
        &[COLUMNS_CAPABILITY.into()],
    )
    .unwrap();
    assert_eq!(
        VfsNoteRepo::get_note_content_with_conn(&conn, &note.id)
            .unwrap()
            .unwrap(),
        COLUMNS
    );
}

#[test]
fn stable_columns_transfer_requires_both_page_optins_and_moves_entire_container_atomically() {
    let (_tmp, db) = setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let source = create(&conn, COLUMNS);
    let marked = format!("<!-- ds:block-id=cols -->\n{COLUMNS}");
    let source = NoteFormatRepo::migrate(&conn, &source.id, &source.updated_at, &marked).unwrap();
    assert_eq!(
        NoteFormatRepo::get(&conn, &source.id)
            .unwrap()
            .serializer_version,
        "blocks-v1+ds-columns-v1"
    );
    let target = create(&conn, "");
    let target = NoteFormatRepo::migrate(&conn, &target.id, &target.updated_at, "").unwrap();
    let mut request = TransferBlocksRequest {
        operation_id: "columns-move".into(),
        source_note_id: source.id.clone(),
        target_note_id: target.id.clone(),
        expected_source_updated_at: source.updated_at.clone(),
        expected_target_updated_at: target.updated_at.clone(),
        source_content: "".into(),
        target_content: marked.clone(),
        block_ids: vec!["cols".into()],
    };
    assert!(NoteTransferRepo::transfer(&conn, request.clone()).is_err());
    assert_eq!(
        VfsNoteRepo::get_note_content_with_conn(&conn, &source.id)
            .unwrap()
            .unwrap(),
        marked
    );
    let target = NoteFormatRepo::enable_columns(&conn, &target.id, &target.updated_at).unwrap();
    request.expected_target_updated_at = target.updated_at;
    let mut tampered = request.clone();
    tampered.target_content = tampered
        .target_content
        .replace("Answer", "Edited during move");
    assert!(NoteTransferRepo::transfer(&conn, tampered).is_err());
    let moved = NoteTransferRepo::transfer(&conn, request).unwrap();
    assert_eq!(
        VfsNoteRepo::get_note_content_with_conn(&conn, &source.id)
            .unwrap()
            .unwrap(),
        ""
    );
    assert_eq!(
        VfsNoteRepo::get_note_content_with_conn(&conn, &target.id)
            .unwrap()
            .unwrap(),
        marked
    );
    NoteTransferRepo::undo(
        &conn,
        "columns-move",
        &moved.source_updated_at,
        &moved.target_updated_at,
    )
    .unwrap();
    assert_eq!(
        VfsNoteRepo::get_note_content_with_conn(&conn, &source.id)
            .unwrap()
            .unwrap(),
        marked
    );
}

#[test]
fn history_selection_cannot_cut_column_containers_and_full_restore_preserves_capability() {
    let (_tmp, db) = setup_migrated_test_db();
    let conn = db.get_conn_safe().unwrap();
    let note = create(&conn, COLUMNS);
    let version = NoteRevisionRepo::list(&conn, &note.id, None, 1)
        .unwrap()
        .items[0]
        .version_id
        .clone();
    assert!(NoteRevisionRepo::restore_selection_copy(
        &conn,
        &note.id,
        &version,
        Some(&NoteHistorySelection {
            start_line: 5,
            end_line: 7
        })
    )
    .is_err());
    let copy = NoteRevisionRepo::restore_copy(&conn, &note.id, &version).unwrap();
    assert_eq!(
        VfsNoteRepo::get_note_content_with_conn(&conn, &copy.id)
            .unwrap()
            .unwrap(),
        COLUMNS
    );
    assert_eq!(
        NoteFormatRepo::get(&conn, &copy.id)
            .unwrap()
            .serializer_version,
        "markdown-v1+ds-columns-v1"
    );
}
