//! `review_plan_service` 的单测。
//!
//! 服务本体已搬到 dstu-qbank；测试库用 app 的 `data_governance` 迁移协调器建库，
//! 因此测试留在 app。模块路径保持 `review_plan_service::tests::…`（见 lib.rs 里的同名重导出模块）。

use super::*;
use crate::data_governance::migration::coordinator::MigrationCoordinator;
use crate::data_governance::schema_registry::DatabaseId;
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::exam_repo::VfsExamRepo;
use crate::vfs::repos::question_repo::{CreateQuestionParams, VfsQuestionRepo};
use crate::vfs::types::VfsCreateExamSheetParams;
use serde_json::json;
use std::sync::Arc;
use tempfile::TempDir;

fn setup_test_db() -> (TempDir, Arc<VfsDatabase>) {
    let temp_dir = TempDir::new().expect("Failed to create temp dir");
    let mut coordinator =
        MigrationCoordinator::new(temp_dir.path().to_path_buf()).with_audit_db(None);
    coordinator
        .migrate_single(DatabaseId::Vfs)
        .expect("Failed to migrate VFS database");
    let db = Arc::new(VfsDatabase::new(temp_dir.path()).expect("Failed to create database"));
    (temp_dir, db)
}

#[test]
fn test_create_review_plan_rejects_exam_question_mismatch() {
    let (_temp_dir, vfs_db) = setup_test_db();
    let service = ReviewPlanService::new(vfs_db.clone());

    let exam_a = VfsExamRepo::create_exam_sheet(
        &vfs_db,
        VfsCreateExamSheetParams {
            exam_name: Some("Exam A".to_string()),
            temp_id: "tmp_exam_a".to_string(),
            metadata_json: json!({}),
            preview_json: json!({ "pages": [] }),
            status: "completed".to_string(),
            folder_id: None,
        },
    )
    .expect("create exam A");

    let exam_b = VfsExamRepo::create_exam_sheet(
        &vfs_db,
        VfsCreateExamSheetParams {
            exam_name: Some("Exam B".to_string()),
            temp_id: "tmp_exam_b".to_string(),
            metadata_json: json!({}),
            preview_json: json!({ "pages": [] }),
            status: "completed".to_string(),
            folder_id: None,
        },
    )
    .expect("create exam B");

    let question = VfsQuestionRepo::create_question(
        &vfs_db,
        &CreateQuestionParams {
            exam_id: exam_a.id.clone(),
            card_id: Some("card_1".to_string()),
            question_label: Some("1".to_string()),
            content: "2 + 2 = ?".to_string(),
            options: None,
            answer: Some("4".to_string()),
            explanation: Some("basic math".to_string()),
            question_type: None,
            difficulty: None,
            tags: None,
            source_type: None,
            source_ref: None,
            images: None,
            parent_id: None,
            structured_data: None,
        },
    )
    .expect("create question");

    let err = service
        .create_review_plan(&question.id, &exam_b.id)
        .expect_err("mismatch exam_id should fail");

    let msg = err.to_string();
    assert!(
        msg.contains("belongs to exam_id"),
        "unexpected error: {}",
        msg
    );
}

#[test]
fn review_writes_mastery_once_and_practice_advance_does_not_double_count() {
    let (_temp_dir, vfs_db) = setup_test_db();
    let service = ReviewPlanService::new(vfs_db.clone());
    let exam = VfsExamRepo::create_exam_sheet(
        &vfs_db,
        VfsCreateExamSheetParams {
            exam_name: Some("Exam".to_string()),
            temp_id: "tmp_exam_mastery".to_string(),
            metadata_json: json!({}),
            preview_json: json!({ "pages": [] }),
            status: "completed".to_string(),
            folder_id: None,
        },
    )
    .expect("create exam");
    let question = VfsQuestionRepo::create_question(
        &vfs_db,
        &CreateQuestionParams {
            exam_id: exam.id.clone(),
            card_id: None,
            question_label: Some("1".to_string()),
            content: "导数定义".to_string(),
            options: None,
            answer: Some("极限".to_string()),
            explanation: None,
            question_type: None,
            difficulty: None,
            tags: Some(vec!["导数".to_string()]),
            source_type: None,
            source_ref: None,
            images: None,
            parent_id: None,
            structured_data: None,
        },
    )
    .expect("create question");
    let plan = service
        .get_or_create_plan(&question.id, &exam.id)
        .expect("plan");
    let count_events = || -> i64 {
        vfs_db
            .get_conn_safe()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM mastery_events WHERE deleted_at IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap()
    };
    assert_eq!(count_events(), 0);
    service
        .process_review(&plan.id, 4, None, None)
        .expect("review");
    assert_eq!(count_events(), 1, "SM-2 review must feed mastery");
    let before = service.get_plan_by_question(&question.id).unwrap().unwrap();
    service.advance_from_practice(&plan.id).expect("advance");
    let after = service.get_plan_by_question(&question.id).unwrap().unwrap();
    assert_eq!(
        count_events(),
        1,
        "practice advance must not double count mastery"
    );
    assert_eq!(after.total_reviews, before.total_reviews + 1);
}
