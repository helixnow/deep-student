//! `fsrs_review_service` 的跨域单测（原 `fsrs_review_service.rs` 的 `mod tests` 中的一项，测试函数名不变）。
//!
//! 实现已下沉到 dstu-anki；本测试要用题库（QuestionBankService）与 VFS 掌握度，
//! 题库仍在 app，所以留在 app，测试路径仍为 `fsrs_review_service::tests::*`。
//! 拆分前经 `use super::*` 取得的父模块私有项在下面显式给出：
//! `MS_PER_DAY` 同值常量；`schedule_review` 经 dstu-anki 的 `test-util` feature
//! （`schedule_review_due_ms`）取未偏置的 FSRS due；mistakes 库夹具与插卡 helper
//! 与 dstu-anki 内 `fsrs_review_service::tests` 的同名 helper 相同。

use super::*;
use crate::data_governance::migration::{MigrationCoordinator, MISTAKES_MIGRATIONS};
use crate::data_governance::schema_registry::DatabaseId;
use crate::database::Database;
use crate::models::AppError;
use chrono::Utc;
use rusqlite::params;
use std::sync::Arc;
use tempfile::TempDir;

const MS_PER_DAY: i64 = 86_400_000;

/// `schedule_review` 结果中本测试用到的部分。
struct ScheduledDue {
    due_ms: i64,
}

fn schedule_review(
    before: &FsrsCardState,
    rating: FsrsRating,
    now_ms: i64,
    config: &FsrsSchedulerConfig,
) -> std::result::Result<ScheduledDue, AppError> {
    schedule_review_due_ms(before, rating, now_ms, config).map(|due_ms| ScheduledDue { due_ms })
}

/// C5：VFS mastery_states.score（连错后）驱动 FSRS due 提前；极低分受 3 天上限。
#[test]
fn e2e_vfs_mastery_score_biases_due_and_respects_three_day_cap() {
    use crate::mastery::service::{set_now_override_ms, MasteryService};
    use crate::mastery::{
        apply_mastery_due_bias, mastery_due_bias_delta_ms, MasteryOutcome, MasterySource,
        MAX_ADVANCE_MS,
    };
    use crate::question_bank_service::QuestionBankService;
    use crate::vfs::repos::{CreateQuestionParams, QuestionType, VfsQuestionRepo};

    let (_vfs_tmp, vfs_raw) = crate::vfs::database::setup_migrated_test_db();
    let vfs_db = Arc::new(vfs_raw);
    let concept = "fsrs_闭环偏置";
    let qid = {
        let exam_id = "exam_fsrs_e2e";
        let conn = vfs_db.get_conn_safe().unwrap();
        conn.execute(
            "INSERT INTO exam_sheets (
                id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at
             ) VALUES (?1, 'e2e', 'completed', 't1', '{}', '{}', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')",
            params![exam_id],
        )
        .unwrap();
        drop(conn);
        VfsQuestionRepo::create_question(
            &vfs_db,
            &CreateQuestionParams {
                exam_id: exam_id.into(),
                card_id: None,
                question_label: Some("Q".into()),
                content: "x?".into(),
                options: None,
                answer: Some("1".into()),
                explanation: None,
                question_type: Some(QuestionType::FillBlank),
                difficulty: None,
                tags: Some(vec![concept.into()]),
                source_type: None,
                source_ref: None,
                images: None,
                parent_id: None,
                structured_data: None,
            },
        )
        .unwrap()
        .id
    };
    let qbank = QuestionBankService::new(vfs_db.clone());
    let mut t0 = Utc::now().timestamp_millis();
    set_now_override_ms(Some(t0));
    for i in 0..3 {
        t0 += 120_000;
        set_now_override_ms(Some(t0));
        qbank
            .submit_answer(&qid, "bad", Some(false), Some(&format!("fw{i}")))
            .unwrap();
    }
    set_now_override_ms(None);

    let mastery = MasteryService::new(vfs_db.clone());
    let score = mastery.get_state(concept).unwrap().unwrap().score;
    assert!(score < 0.5, "expected weak score, got {score}");

    let (_fsrs_tmp, db) = setup_migrated_fsrs_db();
    insert_task_and_card(&db, "doc-c5", "task-c5", "card-c5-a");
    insert_card_for_task(&db, "doc-c5", "task-c5", "card-c5-b");
    insert_card_for_task(&db, "doc-c5", "task-c5", "card-c5-cap");
    // tag cards with same concept
    {
        let conn = db.get_conn_safe().unwrap();
        let tags = serde_json::to_string(&vec![concept]).unwrap();
        for id in ["card-c5-a", "card-c5-b", "card-c5-cap"] {
            conn.execute(
                "UPDATE anki_cards SET tags_json = ?1 WHERE id = ?2",
                params![tags, id],
            )
            .unwrap();
        }
    }
    let service = FsrsReviewService::new(db.clone());
    // 两张不同卡的 fuzz 因子不同；本用例比较「同一 FSRS 间隔」上的偏置，关闭 fuzz
    service
        .update_scheduler_config(&FsrsSchedulerConfigUpdate {
            enable_fuzz: Some(false),
            ..FsrsSchedulerConfigUpdate::default()
        })
        .unwrap();
    let seed_review = |card_id: &str, stability: f64, scheduled_days: f64| -> String {
        let enq = service.enqueue_cards(&[card_id.to_string()]).unwrap();
        let sid = enq.states[0].id.clone();
        let seed_now = Utc::now().timestamp_millis();
        let conn = db.get_conn_safe().unwrap();
        conn.execute(
            "UPDATE fsrs_card_states SET
                state = 2, stability = ?1, difficulty = 5.0,
                scheduled_days = ?2, reps = 5, lapses = 0,
                due_ms = ?3, last_review_ms = ?4, suspended = 0
             WHERE id = ?5",
            params![
                stability,
                scheduled_days,
                seed_now,
                seed_now - (scheduled_days as i64) * MS_PER_DAY,
                sid
            ],
        )
        .unwrap();
        sid
    };
    let sid_base = seed_review("card-c5-a", 10.0, 10.0);
    let sid_bias = seed_review("card-c5-b", 10.0, 10.0);
    let sid_cap = seed_review("card-c5-cap", 200.0, 100.0);

    let baseline = service
        .rate_with_mastery_bias(&sid_base, 3, Some(10), None, None)
        .unwrap();
    let biased = service
        .rate_with_mastery_bias(&sid_bias, 3, Some(10), Some(score), None)
        .unwrap();
    let now_ms = Utc::now().timestamp_millis();
    let interval = baseline.due_ms.saturating_sub(now_ms);
    let expected_delta = mastery_due_bias_delta_ms(score, interval);
    let advance = baseline.due_ms.saturating_sub(biased.due_ms);
    assert!(
        advance > 60_000,
        "VFS low mastery must advance due; advance={advance}"
    );
    assert!(
        (advance as i64 - expected_delta.abs()).abs() < 30_000,
        "advance {advance} ≈ |delta| {}",
        expected_delta.abs()
    );

    // Cap: huge interval + score=0 → advance ≤ 3 days on persisted due
    let before_cap = service.get_card_state(&sid_cap).unwrap().unwrap();
    let rate_now = Utc::now().timestamp_millis();
    let fsrs_cap = schedule_review(
        &before_cap,
        FsrsRating::Good,
        rate_now,
        &service.get_scheduler_config().unwrap(),
    )
    .expect("schedule");
    let capped = service
        .rate_with_mastery_bias(&sid_cap, 3, Some(10), Some(0.0), None)
        .unwrap();
    let cap_advance = fsrs_cap.due_ms.saturating_sub(capped.due_ms);
    assert!(
        cap_advance > 0 && cap_advance <= MAX_ADVANCE_MS + 5_000,
        "cap advance {cap_advance} must be in (0, 3d]; fsrs={} biased={}",
        fsrs_cap.due_ms,
        capped.due_ms
    );
    assert_eq!(
        mastery_due_bias_delta_ms(0.0, 100 * MS_PER_DAY),
        -MAX_ADVANCE_MS
    );
    // 再压低真实 score 后，100d 间隔仍不超过 3 天上限
    mastery
        .record_event(
            MasterySource::Qbank,
            concept,
            "extra",
            &MasteryOutcome::Wrong,
        )
        .unwrap();
    let ultra_low = mastery.get_state(concept).unwrap().unwrap().score;
    let formula_due = apply_mastery_due_bias(ultra_low, rate_now, rate_now + 100 * MS_PER_DAY);
    let formula_advance = (rate_now + 100 * MS_PER_DAY) - formula_due;
    assert!(
        formula_advance > 0 && formula_advance <= MAX_ADVANCE_MS,
        "ultra-low score={ultra_low} advance {formula_advance} must be ≤ 3d"
    );
}

fn setup_migrated_fsrs_db() -> (TempDir, Arc<Database>) {
    let temp_dir = TempDir::new().expect("create temporary app data directory");
    let root = temp_dir.path().to_path_buf();
    let mut coordinator = MigrationCoordinator::new(root.clone()).with_audit_db(None);

    let first = coordinator
        .migrate_single(DatabaseId::Mistakes)
        .expect("migrate mistakes database");
    assert_eq!(
        first.to_version,
        MISTAKES_MIGRATIONS.latest_version() as u32
    );
    let second = coordinator
        .migrate_single(DatabaseId::Mistakes)
        .expect("repeat mistakes migration");
    assert_eq!(
        second.to_version,
        MISTAKES_MIGRATIONS.latest_version() as u32
    );
    assert_eq!(
        second.applied_count, 0,
        "second migration must be idempotent"
    );

    let db = Arc::new(Database::new(&root.join("mistakes.db")).expect("open mistakes db"));
    (temp_dir, db)
}

fn insert_task_and_card(db: &Database, document_id: &str, task_id: &str, card_id: &str) {
    let conn = db.get_conn_safe().expect("open mistakes connection");
    conn.execute(
        "INSERT INTO document_tasks (
            id, document_id, original_document_name, segment_index,
            content_segment, status, anki_generation_options_json
         ) VALUES (?1, ?2, 'test.md', 0, 'segment', 'Completed', '{}')",
        params![task_id, document_id],
    )
    .expect("insert document task");
    conn.execute(
        "INSERT INTO anki_cards (
            id, task_id, front, back, source_type, source_id
         ) VALUES (?1, ?2, ?3, ?4, 'document', ?5)",
        params![
            card_id,
            task_id,
            format!("front-{card_id}"),
            format!("back-{card_id}"),
            document_id
        ],
    )
    .expect("insert Anki card");
}

fn insert_card_for_task(db: &Database, document_id: &str, task_id: &str, card_id: &str) {
    let conn = db.get_conn_safe().expect("open mistakes connection");
    conn.execute(
        "INSERT INTO anki_cards (
            id, task_id, front, back, source_type, source_id
         ) VALUES (?1, ?2, ?3, ?4, 'document', ?5)",
        params![
            card_id,
            task_id,
            format!("front-{card_id}"),
            format!("back-{card_id}"),
            document_id
        ],
    )
    .expect("insert additional Anki card");
}
