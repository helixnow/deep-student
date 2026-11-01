//! `question_bank_service` 中依赖 app 的单测。
//!
//! 服务本体已搬到 dstu-qbank；画像薄弱点回流（mastery::profile_sink）的 memory 实现由
//! app 的 extensions 组合根注入，读取画像也要用 app 的 `memory::learner_profile`，
//! 因此该测试留在 app。模块路径保持 `question_bank_service::tests::…`（见 lib.rs 里的同名重导出模块）。

use super::*;
use crate::mastery::service::{set_now_override_ms, MIN_TOTAL_FOR_WEAK, WEAK_SCORE_THRESHOLD};
use crate::memory::learner_profile::{load_profile_from_db, WEAK_POINT_SOURCE_MASTERY};
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::{CreateQuestionParams, QuestionType, VfsQuestionRepo};
use chrono::Utc;
use rusqlite::params;
use std::sync::Arc;

fn setup_qbank() -> (tempfile::TempDir, Arc<VfsDatabase>, QuestionBankService) {
    let (temp_dir, db) = crate::vfs::database::setup_migrated_test_db();
    let vfs_db = Arc::new(db);
    let svc = QuestionBankService::new(vfs_db.clone());
    (temp_dir, vfs_db, svc)
}

fn seed_tagged_question(vfs_db: &VfsDatabase, tag: &str, label: &str) -> String {
    let exam_id = format!("exam_{}", nanoid::nanoid!(6));
    let conn = vfs_db.get_conn_safe().expect("conn");
    conn.execute(
        "INSERT INTO exam_sheets (
            id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at
         ) VALUES (?1, 'qbank mastery e2e', 'completed', ?2, '{}', '{}', ?3, ?3)",
        params![exam_id, format!("temp_{exam_id}"), "2020-01-01T00:00:00Z"],
    )
    .expect("exam");
    drop(conn);
    VfsQuestionRepo::create_question(
        vfs_db,
        &CreateQuestionParams {
            exam_id,
            card_id: None,
            question_label: Some(label.into()),
            content: format!("{label}?"),
            options: None,
            answer: Some("2".into()),
            explanation: None,
            structured_data: None,
            question_type: Some(QuestionType::FillBlank),
            difficulty: None,
            tags: Some(vec![tag.to_string()]),
            source_type: None,
            source_ref: None,
            images: None,
            parent_id: None,
        },
    )
    .expect("create question")
    .id
}

/// C5：submit_answer 连错 3 次 → mastery_events/states + learner_profile.weak_points
#[test]
fn submit_answer_wrong_thrice_writes_mastery_and_weak_point() {
    // 画像薄弱点回流经 mastery::profile_sink，由 extensions 注入 memory 实现（拆分后为回调解耦）。
    crate::extensions::register_extensions();
    let (_tmp, vfs_db, qbank) = setup_qbank();
    let concept = "qbank_闭环概念";
    let qid = seed_tagged_question(&vfs_db, concept, "Q1");
    let mut t0 = Utc::now().timestamp_millis();
    set_now_override_ms(Some(t0));
    for i in 0..3 {
        t0 += 120_000;
        set_now_override_ms(Some(t0));
        let r = qbank
            .submit_answer(&qid, "x", Some(false), Some(&format!("qw{i}")))
            .expect("submit");
        assert_eq!(r.is_correct, Some(false));
    }
    set_now_override_ms(None);

    let conn = vfs_db.get_conn_safe().unwrap();
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM mastery_events
             WHERE concept_key = ?1 AND source = 'qbank' AND outcome = 'wrong'",
            params![concept],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(n, 3);
    let (score, total): (f64, i32) = conn
        .query_row(
            "SELECT score, total FROM mastery_states WHERE concept_key = ?1",
            params![concept],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert!(score < WEAK_SCORE_THRESHOLD);
    assert!(total >= MIN_TOTAL_FOR_WEAK);

    let profile = load_profile_from_db(&vfs_db).unwrap().expect("profile");
    assert!(profile.weak_points.iter().any(|w| {
        w.knowledge_point == concept && w.source.as_deref() == Some(WEAK_POINT_SOURCE_MASTERY)
    }));
}
