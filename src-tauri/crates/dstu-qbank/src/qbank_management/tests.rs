use super::*;
use crate::qbank_authoring_service::QuestionAuthoringService;
use crate::qbank_document::{DraftQuestion, QuestionDocument};
use crate::vfs::repos::{VfsExamRepo, VfsQuestionRepo};
use crate::vfs::types::VfsCreateExamSheetParams;
use serde_json::json;
use std::sync::Arc;

struct Fixture {
    _temp: tempfile::TempDir,
    db: Arc<VfsDatabase>,
    exam_id: String,
    group_id: String,
    material_id: String,
    q1: String,
    q2: String,
}

fn group_document() -> QuestionDocument {
    serde_json::from_value(json!({
        "schema_version": 2,
        "mode": "extract",
        "materials": [{"local_id": "m1", "content": "A shared passage that must stay out of question text"}],
        "groups": [{"local_id": "g1", "label": "Reading", "material_ids": ["m1"], "question_ids": ["q1", "q2"]}],
        "questions": [
            {"local_id": "q1", "group_id": "g1", "content": "First question", "question_type": "short_answer"},
            {"local_id": "q2", "group_id": "g1", "content": "Second question", "question_type": "short_answer"}
        ]
    }))
    .unwrap()
}

fn setup() -> Fixture {
    let (temp, db) = crate::vfs::database::setup_migrated_test_db();
    let db = Arc::new(db);
    let exam = VfsExamRepo::create_exam_sheet(
        &db,
        VfsCreateExamSheetParams {
            exam_name: Some("management".into()),
            temp_id: new_id("tmp"),
            metadata_json: json!({}),
            preview_json: json!({"pages": []}),
            status: "empty".into(),
            folder_id: None,
        },
    )
    .unwrap();
    let service = QuestionAuthoringService::new(db.clone());
    let receipt = service
        .submit_document(&exam.id, &group_document(), "management-seed")
        .unwrap();
    assert_eq!(receipt.question_ids.len(), 2);
    Fixture {
        _temp: temp,
        db,
        exam_id: exam.id,
        group_id: receipt.group_ids[0].clone(),
        material_id: receipt.material_ids[0].clone(),
        q1: receipt.question_ids[0].clone(),
        q2: receipt.question_ids[1].clone(),
    }
}

fn add_standalone(fixture: &Fixture, local_id: &str, key: &str) -> String {
    let document = QuestionDocument {
        questions: vec![DraftQuestion {
            local_id: local_id.into(),
            content: format!("{local_id} standalone content"),
            question_type: "short_answer".into(),
            ..Default::default()
        }],
        ..Default::default()
    };
    QuestionAuthoringService::new(fixture.db.clone())
        .submit_document(&fixture.exam_id, &document, key)
        .unwrap()
        .question_ids[0]
        .clone()
}

fn preview_card_count(db: &VfsDatabase, exam_id: &str) -> usize {
    VfsExamRepo::get_exam_sheet(db, exam_id)
        .unwrap()
        .unwrap()
        .preview_json["pages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|page| page["cards"].as_array().unwrap().len())
        .sum()
}

fn resource_index_state(db: &VfsDatabase, exam_id: &str) -> String {
    let conn = db.get_conn_safe().unwrap();
    conn.query_row(
        "SELECT r.index_state FROM resources r JOIN exam_sheets e ON e.resource_id=r.id \
         WHERE e.id=?1",
        [exam_id],
        |row| row.get(0),
    )
    .unwrap()
}

#[test]
fn list_structure_exposes_versions_and_canonical_member_order() {
    let fixture = setup();
    let service = QuestionBankManagementService::new(fixture.db.clone());

    let structure = service.list_structure(&fixture.exam_id).unwrap();
    assert_eq!(structure.exam_id, fixture.exam_id);
    assert_eq!(structure.materials.len(), 1);
    assert_eq!(structure.materials[0].id, fixture.material_id);
    assert_eq!(structure.materials[0].version, 1);
    assert_eq!(structure.groups.len(), 1);
    let group = &structure.groups[0];
    assert_eq!(group.id, fixture.group_id);
    assert_eq!(group.exam_id, fixture.exam_id);
    assert_eq!(group.label, "Reading");
    assert_eq!(group.version, 1);
    assert_eq!(group.material_ids, vec![fixture.material_id.clone()]);
    assert_eq!(
        group.question_ids,
        vec![fixture.q1.clone(), fixture.q2.clone()]
    );
    // The exact shape consumed by IPC/chat; versions are optimistic tokens.
    let value = serde_json::to_value(&structure).unwrap();
    assert!(value["groups"][0].get("version").is_some());
    assert!(value["groups"][0].get("question_ids").is_some());
    assert!(value["groups"][0].get("material_ids").is_some());
}

#[test]
fn update_group_reorders_adds_and_removes_with_solo_material_context_and_occ() {
    let fixture = setup();
    let q3 = add_standalone(&fixture, "q3", "management-q3");
    let service = QuestionBankManagementService::new(fixture.db.clone());

    let result = service
        .update_group(
            &fixture.group_id,
            "Updated reading",
            &[fixture.q2.clone(), q3.clone()],
            &[fixture.material_id.clone()],
            1,
        )
        .unwrap();
    assert_eq!(result.group.version, 2);
    assert_eq!(result.group.label, "Updated reading");
    assert_eq!(
        result.group.question_ids,
        vec![fixture.q2.clone(), q3.clone()]
    );
    assert_eq!(result.removed_question_ids, vec![fixture.q1.clone()]);
    assert_eq!(result.solo_group_ids.len(), 1);

    let structure = service.list_structure(&fixture.exam_id).unwrap();
    assert_eq!(structure.groups.len(), 2);
    let updated = structure
        .groups
        .iter()
        .find(|group| group.id == fixture.group_id)
        .unwrap();
    assert_eq!(updated.version, 2);
    assert_eq!(updated.position, 0);
    let solo = structure
        .groups
        .iter()
        .find(|group| group.id == result.solo_group_ids[0])
        .unwrap();
    assert_eq!(solo.question_ids, vec![fixture.q1.clone()]);
    assert!(solo.label.contains("独立题"));
    assert_eq!(solo.material_ids, vec![fixture.material_id.clone()]);
    assert_eq!(solo.version, 1);

    // The solo group attaches the canonical material context, never q text.
    let frozen = structure
        .materials
        .iter()
        .find(|material| material.id == solo.material_ids[0])
        .unwrap();
    assert_eq!(
        frozen.content,
        "A shared passage that must stay out of question text"
    );
    let q1 = VfsQuestionRepo::get_question(&fixture.db, &fixture.q1)
        .unwrap()
        .unwrap();
    assert_eq!(q1.group_id.as_deref(), Some(solo.id.as_str()));
    assert!(!q1.content.contains("shared passage"));

    let order: Vec<(String, i64)> = {
        let conn = fixture.db.get_conn_safe().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id,group_position FROM questions \
                 WHERE group_id=?1 AND deleted_at IS NULL ORDER BY group_position",
            )
            .unwrap();
        stmt.query_map([&fixture.group_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
    };
    assert_eq!(order, vec![(fixture.q2.clone(), 0), (q3.clone(), 1)]);

    let history = VfsQuestionRepo::get_history(&fixture.db, &fixture.q1, Some(20)).unwrap();
    assert!(history.iter().any(|entry| {
        entry.field_name == "group_id"
            && entry.old_value.as_deref() == Some(fixture.group_id.as_str())
            && entry.new_value.as_deref() == Some(solo.id.as_str())
            && entry.operator == "system"
    }));

    // Stale OCC must change nothing.
    let before = service.list_structure(&fixture.exam_id).unwrap();
    let stale = service.update_group(
        &fixture.group_id,
        "stale",
        &[fixture.q2.clone(), q3.clone()],
        &[],
        1,
    );
    assert!(stale.is_err());
    let after = service.list_structure(&fixture.exam_id).unwrap();
    assert_eq!(after.groups.len(), before.groups.len());
    assert_eq!(
        after
            .groups
            .iter()
            .find(|group| group.id == fixture.group_id)
            .unwrap()
            .version,
        2
    );
}

#[test]
fn ungroup_and_delete_members_preserve_submission_snapshots_history_stats_and_preview() {
    let fixture = setup();
    VfsQuestionRepo::insert_submission(
        &fixture.db,
        &fixture.q1,
        "initial answer",
        Some(true),
        "manual",
        None,
    )
    .unwrap();
    VfsQuestionRepo::record_history(
        &fixture.db,
        &fixture.q1,
        "content",
        Some("old text"),
        Some("First question"),
        "user",
        Some("manual edit"),
    )
    .unwrap();
    let before_snapshot = {
        let conn = fixture.db.get_conn_safe().unwrap();
        let submissions =
            VfsQuestionRepo::get_submissions_with_snapshots_with_conn(&conn, &fixture.q1, 10)
                .unwrap();
        submissions[0].1.material_snapshot_json.clone().unwrap()
    };
    {
        let conn = fixture.db.get_conn_safe().unwrap();
        conn.execute(
            "UPDATE resources SET index_state='indexed',indexed_at=1 \
             WHERE id=(SELECT resource_id FROM exam_sheets WHERE id=?1)",
            [&fixture.exam_id],
        )
        .unwrap();
    }

    let service = QuestionBankManagementService::new(fixture.db.clone());
    let result = service.ungroup(&fixture.group_id, 1).unwrap();
    assert_eq!(result.mode, DeleteGroupMode::Ungroup);
    assert!(result.deleted_question_ids.is_empty());
    assert!(result.ungrouped_question_ids.is_empty());
    assert_eq!(result.solo_group_ids.len(), 2);
    assert_eq!(
        VfsQuestionRepo::count_questions(&fixture.db, &fixture.exam_id).unwrap(),
        2
    );

    let structure = service.list_structure(&fixture.exam_id).unwrap();
    assert!(structure
        .groups
        .iter()
        .all(|group| group.id != fixture.group_id));
    assert_eq!(structure.groups.len(), 2);
    assert!(structure
        .groups
        .iter()
        .all(|group| group.material_ids.len() == 1 && group.question_ids.len() == 1));
    // Solo groups attach the existing material entity; no duplicate content.
    assert_eq!(structure.materials.len(), 1);

    let after_snapshot = {
        let conn = fixture.db.get_conn_safe().unwrap();
        let submissions =
            VfsQuestionRepo::get_submissions_with_snapshots_with_conn(&conn, &fixture.q1, 10)
                .unwrap();
        submissions[0].1.material_snapshot_json.clone().unwrap()
    };
    assert_eq!(
        before_snapshot, after_snapshot,
        "submission material snapshots must not be rewritten"
    );
    let history = VfsQuestionRepo::get_history(&fixture.db, &fixture.q1, Some(20)).unwrap();
    assert!(history.iter().any(|entry| entry.field_name == "content"));

    let stats = VfsQuestionRepo::get_stats(&fixture.db, &fixture.exam_id)
        .unwrap()
        .unwrap();
    assert_eq!(stats.total_count, 2);
    assert_eq!(preview_card_count(&fixture.db, &fixture.exam_id), 2);
    assert_eq!(
        resource_index_state(&fixture.db, &fixture.exam_id),
        "pending"
    );

    // Deleting previously-ungrouped members keeps answer/edit history readable.
    let solo_q1 = structure
        .groups
        .iter()
        .find(|group| group.question_ids == vec![fixture.q1.clone()])
        .unwrap()
        .clone();
    let deleted = service
        .delete_group(&solo_q1.id, DeleteGroupMode::DeleteMembers, solo_q1.version)
        .unwrap();
    assert_eq!(deleted.deleted_question_ids, vec![fixture.q1.clone()]);
    assert!(VfsQuestionRepo::get_question(&fixture.db, &fixture.q1)
        .unwrap()
        .is_none());
    assert_eq!(
        VfsQuestionRepo::count_questions(&fixture.db, &fixture.exam_id).unwrap(),
        1
    );
    assert_eq!(preview_card_count(&fixture.db, &fixture.exam_id), 1);
    let stats = VfsQuestionRepo::get_stats(&fixture.db, &fixture.exam_id)
        .unwrap()
        .unwrap();
    assert_eq!(stats.total_count, 1);
    let submissions = {
        let conn = fixture.db.get_conn_safe().unwrap();
        VfsQuestionRepo::get_submissions_with_snapshots_with_conn(&conn, &fixture.q1, 10).unwrap()
    };
    assert_eq!(submissions.len(), 1);
    assert_eq!(
        submissions[0].1.material_snapshot_json.as_deref(),
        Some(after_snapshot.as_str())
    );
    let history = VfsQuestionRepo::get_history(&fixture.db, &fixture.q1, Some(20)).unwrap();
    assert!(history.iter().any(|entry| entry.field_name == "content"));
    assert!(history.iter().any(|entry| entry.field_name == "deleted_at"));
}

#[test]
fn delete_group_delete_members_rejects_variant_dependency_and_rolls_back() {
    let fixture = setup();
    let q3 = add_standalone(&fixture, "q3", "management-variant");
    {
        let conn = fixture.db.get_conn_safe().unwrap();
        conn.execute(
            "UPDATE questions SET parent_id=?1 WHERE id=?2",
            params![fixture.q1, q3],
        )
        .unwrap();
    }
    let service = QuestionBankManagementService::new(fixture.db.clone());

    let error = service
        .delete_group(&fixture.group_id, DeleteGroupMode::DeleteMembers, 1)
        .unwrap_err();
    assert!(error.message.contains("变式"));
    assert!(VfsQuestionRepo::get_question(&fixture.db, &fixture.q1)
        .unwrap()
        .is_some());
    assert!(VfsQuestionRepo::get_question(&fixture.db, &fixture.q2)
        .unwrap()
        .is_some());
    let group = service
        .list_structure(&fixture.exam_id)
        .unwrap()
        .groups
        .into_iter()
        .find(|group| group.id == fixture.group_id)
        .unwrap();
    assert_eq!(group.version, 1);
    assert_eq!(
        VfsQuestionRepo::count_questions(&fixture.db, &fixture.exam_id).unwrap(),
        3
    );

    {
        let conn = fixture.db.get_conn_safe().unwrap();
        conn.execute(
            "UPDATE questions SET parent_id=NULL WHERE id=?1",
            params![q3],
        )
        .unwrap();
    }
    let result = service
        .delete_group(&fixture.group_id, DeleteGroupMode::DeleteMembers, 1)
        .unwrap();
    assert_eq!(result.deleted_question_ids.len(), 2);
    assert_eq!(
        VfsQuestionRepo::count_questions(&fixture.db, &fixture.exam_id).unwrap(),
        1
    );
    assert!(service
        .list_structure(&fixture.exam_id)
        .unwrap()
        .groups
        .iter()
        .all(|group| group.id != fixture.group_id));
}

#[test]
fn delete_unused_materials_is_reference_safe_occ_and_atomic() {
    let fixture = setup();
    let unused_id = "qmat_unused_test".to_string();
    {
        let conn = fixture.db.get_conn_safe().unwrap();
        let stamp = now();
        conn.execute(
            "INSERT INTO qbank_materials \
               (id,exam_id,content,images_json,source_refs_json,created_at,updated_at) \
             VALUES(?1,?2,'unused material','[]','[]',?3,?3)",
            params![unused_id, fixture.exam_id, stamp],
        )
        .unwrap();
        conn.execute(
            "UPDATE resources SET index_state='indexed',indexed_at=1 \
             WHERE id=(SELECT resource_id FROM exam_sheets WHERE id=?1)",
            [&fixture.exam_id],
        )
        .unwrap();
    }
    let service = QuestionBankManagementService::new(fixture.db.clone());

    // One referenced or stale member conflicts the whole batch.
    let referenced_batch = service.delete_unused_materials(
        &fixture.exam_id,
        &[
            MaterialVersionExpectation {
                material_id: unused_id.clone(),
                expected_version: 1,
            },
            MaterialVersionExpectation {
                material_id: fixture.material_id.clone(),
                expected_version: 1,
            },
        ],
    );
    assert!(referenced_batch.is_err());
    assert_eq!(
        VfsQuestionRepo::count_questions(&fixture.db, &fixture.exam_id).unwrap(),
        2
    );
    let material_count: i64 = fixture
        .db
        .get_conn_safe()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM qbank_materials WHERE exam_id=?1 AND deleted_at IS NULL",
            [&fixture.exam_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(material_count, 2);

    let stale = service.delete_unused_materials(
        &fixture.exam_id,
        &[MaterialVersionExpectation {
            material_id: unused_id.clone(),
            expected_version: 7,
        }],
    );
    assert!(stale.is_err());
    let still_live: bool = fixture
        .db
        .get_conn_safe()
        .unwrap()
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM qbank_materials WHERE id=?1 AND deleted_at IS NULL)",
            [&unused_id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(still_live);

    let deleted = service
        .delete_unused_materials(
            &fixture.exam_id,
            &[MaterialVersionExpectation {
                material_id: unused_id.clone(),
                expected_version: 1,
            }],
        )
        .unwrap();
    assert_eq!(deleted.deleted_material_ids, vec![unused_id.clone()]);
    let conn = fixture.db.get_conn_safe().unwrap();
    let (version, deleted_at, batch): (i64, Option<String>, Option<String>) = conn
        .query_row(
            "SELECT local_version,deleted_at,deletion_batch FROM qbank_materials WHERE id=?1",
            [&unused_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(version, 2);
    assert!(deleted_at.is_some());
    assert!(batch.is_some());
    drop(conn);

    // Referenced live material remains protected.
    assert!(service
        .delete_unused_materials(
            &fixture.exam_id,
            &[MaterialVersionExpectation {
                material_id: fixture.material_id.clone(),
                expected_version: 1,
            }],
        )
        .is_err());
    assert_eq!(
        resource_index_state(&fixture.db, &fixture.exam_id),
        "pending"
    );
}
