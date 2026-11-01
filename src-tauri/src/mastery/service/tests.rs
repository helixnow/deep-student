//! `mastery::service` 的单测（原 `mastery/service.rs` 的 `mod tests`，测试函数名不变）。
//!
//! 实现已下沉到 dstu-learning；这些测试要用题库（QuestionBankService）、FSRS
//! （FsrsReviewService / mistakes.db 迁移）与学习者画像（memory），都在 app 侧，
//! 所以留在 app，测试路径仍为 `mastery::service::tests::*`。拆分前经 `use super::*`
//! 取得的父模块私有导入在下面显式列出；画像回流走 `mastery::profile_sink`，断言画像
//! 的测试先调用 `register_extensions()` 注入 memory 的实现。

use super::*;
use crate::data_governance::migration::MigrationCoordinator;
use crate::data_governance::schema_registry::DatabaseId;
use crate::database::Database;
use crate::fsrs_review_service::{FsrsReviewService, FsrsSchedulerConfigUpdate};
use crate::mastery::bias::{apply_mastery_due_bias, mastery_due_bias_delta_ms, MAX_ADVANCE_MS};
use crate::mastery::profile_sink::WEAK_POINT_SOURCE_MASTERY;
use crate::mastery::types::{MasteryOutcome, MasterySource};
use crate::memory::learner_profile::load_profile_from_db;
use crate::question_bank_service::QuestionBankService;
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::{CreateQuestionParams, QuestionType, VfsQuestionRepo};
use chrono::Utc;
use rusqlite::{params, TransactionBehavior};
use std::sync::Arc;

const MS_PER_DAY: i64 = 86_400_000;

fn setup() -> (tempfile::TempDir, Arc<VfsDatabase>, MasteryService) {
    let (temp_dir, db) = crate::vfs::database::setup_migrated_test_db();
    let vfs_db = Arc::new(db);
    let svc = MasteryService::new(vfs_db.clone());
    (temp_dir, vfs_db, svc)
}

fn setup_mistakes_db() -> (tempfile::TempDir, Arc<Database>) {
    let temp_dir = tempfile::TempDir::new().expect("fsrs temp");
    let root = temp_dir.path().to_path_buf();
    let mut coordinator = MigrationCoordinator::new(root.clone()).with_audit_db(None);
    coordinator
        .migrate_single(DatabaseId::Mistakes)
        .expect("migrate mistakes");
    let db = Arc::new(Database::new(&root.join("mistakes.db")).expect("open mistakes"));
    (temp_dir, db)
}

fn seed_question(vfs_db: &VfsDatabase, tag: &str) -> String {
    seed_question_labeled(vfs_db, tag, "Q1", "1+1=?", "2")
}

fn seed_question_labeled(
    vfs_db: &VfsDatabase,
    tag: &str,
    label: &str,
    content: &str,
    answer: &str,
) -> String {
    let exam_id = format!("exam_{}", nanoid::nanoid!(6));
    let conn = vfs_db.get_conn_safe().expect("conn");
    conn.execute(
        "INSERT INTO exam_sheets (
                id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at
             ) VALUES (?1, 'mastery e2e', 'completed', ?2, '{}', '{}', ?3, ?3)",
        params![exam_id, format!("temp_{exam_id}"), "2020-01-01T00:00:00Z"],
    )
    .expect("exam");
    drop(conn);
    let q = VfsQuestionRepo::create_question(
        vfs_db,
        &CreateQuestionParams {
            exam_id,
            card_id: None,
            question_label: Some(label.into()),
            content: content.into(),
            options: None,
            answer: Some(answer.into()),
            explanation: None,
            question_type: Some(QuestionType::FillBlank),
            difficulty: None,
            tags: Some(vec![tag.to_string()]),
            source_type: None,
            source_ref: None,
            images: None,
            parent_id: None,
            structured_data: None,
        },
    )
    .expect("create question");
    q.id
}

fn enqueue_review_state(db: &Arc<Database>, card_id: &str) -> String {
    let service = FsrsReviewService::new(db.clone());
    let enq = service
        .enqueue_cards(&[card_id.to_string()])
        .expect("enqueue");
    let state_id = enq.states[0].id.clone();
    let seed_now = Utc::now().timestamp_millis();
    {
        let conn = db.get_conn_safe().expect("conn");
        conn.execute(
            "UPDATE fsrs_card_states SET
                    state = 2, stability = 10.0, difficulty = 5.0,
                    scheduled_days = 10.0, reps = 5, lapses = 0,
                    due_ms = ?1, last_review_ms = ?2, suspended = 0
                 WHERE id = ?3",
            params![seed_now, seed_now - 10 * MS_PER_DAY, state_id],
        )
        .expect("seed review state");
    }
    state_id
}

/// C5-1/2：submit_answer 连错 → mastery_states/weak_point → FSRS due 提前；
/// 连对恢复 → weak_point 移除 → due 不再异常提前。
#[test]
fn e2e_submit_wrong_thrice_lowers_score_and_upserts_weak_point_then_recovers() {
    // 画像薄弱点回流经 mastery::profile_sink，由 extensions 注入 memory 实现（拆分后为回调解耦）。
    crate::extensions::register_extensions();
    let (_tmp, vfs_db, _) = setup();
    let (_tmp_fsrs, fsrs_db) = setup_mistakes_db();
    let concept = "二次函数";
    let qid = seed_question(&vfs_db, concept);
    let qbank = QuestionBankService::new(vfs_db.clone());

    // Seed same-concept FSRS review card (mistakes.db)
    {
        let conn = fsrs_db.get_conn_safe().expect("conn");
        conn.execute(
            "INSERT INTO document_tasks (
                    id, document_id, original_document_name, segment_index,
                    content_segment, status, anki_generation_options_json
                 ) VALUES ('task_e2e', 'doc_e2e', 't.md', 0, 'seg', 'Completed', '{}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO anki_cards (
                    id, task_id, front, back, source_type, source_id, tags_json
                 ) VALUES ('card_e2e_lo', 'task_e2e', 'f', 'b', 'document', 'doc_e2e', ?1)",
            params![serde_json::to_string(&vec![concept]).unwrap()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO anki_cards (
                    id, task_id, front, back, source_type, source_id, tags_json
                 ) VALUES ('card_e2e_hi', 'task_e2e', 'f2', 'b2', 'document', 'doc_e2e', ?1)",
            params![serde_json::to_string(&vec![concept]).unwrap()],
        )
        .unwrap();
    }
    let state_lo = enqueue_review_state(&fsrs_db, "card_e2e_lo");
    let state_hi = enqueue_review_state(&fsrs_db, "card_e2e_hi");
    let fsrs = FsrsReviewService::new(fsrs_db.clone());
    // 两张不同卡的 fuzz 因子不同；本用例比较同一 FSRS 间隔上的偏置，关闭 fuzz
    fsrs.update_scheduler_config(&FsrsSchedulerConfigUpdate {
        enable_fuzz: Some(false),
        ..FsrsSchedulerConfigUpdate::default()
    })
    .expect("disable fuzz");

    let mut t0 = Utc::now().timestamp_millis();
    set_now_override_ms(Some(t0));

    for i in 0..3 {
        t0 += 120_000; // 2 min apart — 避免防刷影响错误信号
        set_now_override_ms(Some(t0));
        let r = qbank
            .submit_answer(&qid, "wrong", Some(false), Some(&format!("w{i}")))
            .expect("submit wrong");
        assert_eq!(r.is_correct, Some(false));
    }

    // 终态表：mastery_events / mastery_states
    {
        let conn = vfs_db.get_conn_safe().unwrap();
        let event_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM mastery_events
                     WHERE concept_key = ?1 AND outcome = 'wrong' AND source = 'qbank'",
                params![concept],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(event_count, 3);
        let (score, total, wrong_count): (f64, i32, i32) = conn
            .query_row(
                "SELECT score, total, wrong_count FROM mastery_states WHERE concept_key = ?1",
                params![concept],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert!(
            score < WEAK_SCORE_THRESHOLD,
            "mastery_states.score should be < {WEAK_SCORE_THRESHOLD}, got {score}"
        );
        assert!(total >= MIN_TOTAL_FOR_WEAK);
        assert!(wrong_count >= 3);
    }

    let mastery = MasteryService::new(vfs_db.clone());
    let state = mastery
        .get_state(concept)
        .expect("get state")
        .expect("state exists");
    // 3× wrong EMA：0.5 → 0.35 → 0.245 → 0.1715
    assert!(
        (state.score - 0.1715).abs() < 1e-9,
        "expected deterministic EMA after 3 wrongs ≈0.1715, got {}",
        state.score
    );

    let profile = load_profile_from_db(&vfs_db)
        .expect("load profile")
        .expect("profile should exist after reflux");
    let wp = profile
        .weak_points
        .iter()
        .find(|w| w.knowledge_point == concept)
        .expect("weak_point for 二次函数");
    assert_eq!(wp.source.as_deref(), Some(WEAK_POINT_SOURCE_MASTERY));
    assert!(
        wp.error_pattern.contains(concept) || wp.error_pattern.contains("wrong"),
        "evidence should mention concept/errors: {}",
        wp.error_pattern
    );

    // FSRS due：用真实 mastery_states.score 偏置同 concept 卡片
    let low_score = state.score;
    // 先无偏置对照，再低掌握偏置（两卡同 Review seed）
    let baseline = fsrs
        .rate_with_mastery_bias(&state_hi, 3, Some(10), None, None)
        .expect("baseline rate");
    let rate_lo = fsrs
        .rate_with_mastery_bias(&state_lo, 3, Some(10), Some(low_score), None)
        .expect("rate low mastery");
    let now_ms = Utc::now().timestamp_millis();
    let fsrs_interval = baseline.due_ms.saturating_sub(now_ms);
    assert!(
        fsrs_interval >= 60 * 60 * 1000,
        "need biasable review interval, got {fsrs_interval}"
    );
    let expected_delta = mastery_due_bias_delta_ms(low_score, fsrs_interval);
    assert!(
        expected_delta < 0,
        "formula must advance low mastery; delta={expected_delta}"
    );
    assert!(
        expected_delta.abs() <= MAX_ADVANCE_MS,
        "formula advance must respect 3-day cap"
    );
    let advance = baseline.due_ms.saturating_sub(rate_lo.due_ms);
    assert!(
        advance > 60_000,
        "same-concept FSRS due must advance >1min under low mastery; \
             baseline={} biased={} advance={}",
        baseline.due_ms,
        rate_lo.due_ms,
        advance
    );
    assert!(
        advance <= MAX_ADVANCE_MS + 5_000,
        "persisted advance {advance} must respect 3-day cap {MAX_ADVANCE_MS}"
    );
    // 可断言量：与公式 |delta| 接近（允许评分时钟漂移 ≤30s）
    assert!(
        (advance as i64 - expected_delta.abs()).abs() < 30_000,
        "advance {advance} should ≈ |formula delta| {} (score={low_score}, interval={fsrs_interval})",
        expected_delta.abs()
    );
    // 终态表：fsrs_card_states.due_ms 已写入偏置值
    {
        let conn = fsrs_db.get_conn_safe().unwrap();
        let due_persisted: i64 = conn
            .query_row(
                "SELECT due_ms FROM fsrs_card_states WHERE id = ?1",
                params![state_lo],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(due_persisted, rate_lo.due_ms);
    }

    // 连续答对恢复
    for i in 0..8 {
        t0 += 90_000;
        set_now_override_ms(Some(t0));
        let r = qbank
            .submit_answer(&qid, "2", Some(true), Some(&format!("c{i}")))
            .expect("submit correct");
        assert_eq!(r.is_correct, Some(true));
    }
    set_now_override_ms(None);

    let state_after = mastery
        .get_state(concept)
        .expect("get state")
        .expect("state");
    assert!(
        state_after.score > RECOVER_SCORE_THRESHOLD,
        "score should recover above {}, got {}",
        RECOVER_SCORE_THRESHOLD,
        state_after.score
    );

    let profile_after = load_profile_from_db(&vfs_db)
        .expect("load")
        .unwrap_or_default();
    assert!(
        !profile_after
            .weak_points
            .iter()
            .any(|w| w.knowledge_point == concept
                && w.source.as_deref() == Some(WEAK_POINT_SOURCE_MASTERY)),
        "mastery weak_point should be removed after recovery; left={:?}",
        profile_after
            .weak_points
            .iter()
            .map(|w| (&w.knowledge_point, &w.source))
            .collect::<Vec<_>>()
    );

    // 恢复后：同 score 偏置不应再「异常提前」（高分 → due ≥ 无偏置）
    let high_score = state_after.score;
    let synthetic_now = 1_700_000_000_000_i64;
    let synthetic_fsrs_due = synthetic_now + 10 * MS_PER_DAY;
    let recovered_due = apply_mastery_due_bias(high_score, synthetic_now, synthetic_fsrs_due);
    assert!(
        recovered_due >= synthetic_fsrs_due,
        "recovered mastery must not abnormally advance due: score={high_score} due={recovered_due} fsrs={synthetic_fsrs_due}"
    );
}

/// C5-3：同题 1 分钟内连对 5 次，score 增幅显著小于 5 道独立题。
#[test]
fn anti_farm_same_item_rapid_corrects_gain_less_than_independent() {
    let (_tmp, vfs_db, _) = setup();
    let qbank = QuestionBankService::new(vfs_db.clone());
    let mastery = MasteryService::new(vfs_db.clone());

    let concept_ind = "牛顿定律_ind";
    let concept_farm = "牛顿定律_farm";
    let mut ind_ids = Vec::new();
    for i in 0..5 {
        ind_ids.push(seed_question_labeled(
            &vfs_db,
            concept_ind,
            &format!("Qi{i}"),
            &format!("q{i}?"),
            "ok",
        ));
    }
    let farm_qid = seed_question_labeled(&vfs_db, concept_farm, "Qf", "farm?", "ok");

    let t_base = Utc::now().timestamp_millis();
    set_now_override_ms(Some(t_base));
    for (i, qid) in ind_ids.iter().enumerate() {
        set_now_override_ms(Some(t_base + i as i64 * 1_000));
        qbank
            .submit_answer(qid, "ok", Some(true), Some(&format!("ind{i}")))
            .expect("independent correct");
    }
    let score_independent = mastery.get_state(concept_ind).unwrap().unwrap().score;
    let gain_independent = score_independent - 0.5;

    set_now_override_ms(Some(t_base + 1_000_000));
    for i in 0..5 {
        set_now_override_ms(Some(t_base + 1_000_000 + i * 5_000)); // 5s apart, same 60s window
        qbank
            .submit_answer(&farm_qid, "ok", Some(true), Some(&format!("farm{i}")))
            .expect("farm correct");
    }
    set_now_override_ms(None);
    let score_farm = mastery.get_state(concept_farm).unwrap().unwrap().score;
    let gain_farm = score_farm - 0.5;

    assert!(
        gain_farm < gain_independent * 0.55,
        "farmed gain ({gain_farm:.4}) should be significantly < independent ({gain_independent:.4})"
    );

    // 终态：mastery_events.weight 首条=1，后续衰减
    let events = mastery.list_events(concept_farm, 10).unwrap();
    let weights: Vec<f64> = events.iter().map(|e| e.weight).collect();
    assert!(weights.iter().copied().any(|w| w < 0.3));
    assert!(weights.iter().copied().any(|w| (w - 1.0).abs() < 1e-9));

    let conn = vfs_db.get_conn_safe().unwrap();
    let min_w: f64 = conn
        .query_row(
            "SELECT MIN(weight) FROM mastery_events WHERE concept_key = ?1",
            params![concept_farm],
            |row| row.get(0),
        )
        .unwrap();
    assert!(min_w <= 0.05 + 1e-9 || min_w < 0.3);
}

/// C5-4：Again/Hard/Good/Easy → mastery_events.signal = 0/0.3/0.8/1.0
#[test]
fn fsrs_rating_signals_are_differentiated() {
    let (_tmp, vfs, svc) = setup();
    let t0 = Utc::now().timestamp_millis();
    set_now_override_ms(Some(t0));

    for (i, rating) in [1u8, 2, 3, 4].into_iter().enumerate() {
        set_now_override_ms(Some(t0 + (i as i64 + 1) * 120_000));
        svc.record_fsrs_rating(&format!("card_sig_{rating}"), &["微积分".into()], rating)
            .expect("record")
            .expect("state");
    }
    set_now_override_ms(None);

    // 终态表：mastery_events.signal 精确落值
    let conn = vfs.get_conn_safe().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT signal FROM mastery_events
                 WHERE concept_key = '微积分' AND outcome = 'rating'
                 ORDER BY signal ASC",
        )
        .unwrap();
    let signals: Vec<f64> = stmt
        .query_map([], |row| row.get::<_, f64>(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert_eq!(signals.len(), 4);
    assert!(
        (signals[0] - 0.0).abs() < 1e-9
            && (signals[1] - 0.3).abs() < 1e-9
            && (signals[2] - 0.8).abs() < 1e-9
            && (signals[3] - 1.0).abs() < 1e-9,
        "expected Again/Hard/Good/Easy signals 0/0.3/0.8/1.0, got {signals:?}"
    );

    // Hard < Good < Easy 对 score 的拉动应可区分
    let mut scores = Vec::new();
    for (label, rating) in [("h", 2u8), ("g", 3u8), ("e", 4u8)] {
        let concept = format!("sig_{label}");
        set_now_override_ms(Some(t0 + 1_000_000));
        let st = svc
            .record_fsrs_rating(&format!("c_{label}"), &[concept.clone()], rating)
            .unwrap()
            .unwrap();
        scores.push(st.score);
    }
    set_now_override_ms(None);
    assert!(
        scores[0] < scores[1] && scores[1] < scores[2],
        "Hard score < Good < Easy, got {scores:?}"
    );
}

#[test]
fn fsrs_review_log_compensation_is_idempotent() {
    let (_tmp, vfs, svc) = setup();
    for _ in 0..2 {
        svc.record_fsrs_rating_for_log("log_exactly_once", "card_once", &["概率论".into()], 3)
            .unwrap();
    }
    let conn = vfs.get_conn_safe().unwrap();
    let event_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM mastery_events WHERE id = 'me_fsrs_log_exactly_once'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(event_count, 1);
    let total: i32 = conn
        .query_row(
            "SELECT total FROM mastery_states WHERE concept_key = '概率论'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(total, 1);
    drop(conn);

    let reverted = svc
        .revert_fsrs_rating_for_log("log_exactly_once")
        .unwrap()
        .unwrap();
    assert_eq!(reverted.total, 0);
    let conn = vfs.get_conn_safe().unwrap();
    let deleted_at: Option<String> = conn
        .query_row(
            "SELECT deleted_at FROM mastery_events WHERE id = 'me_fsrs_log_exactly_once'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(deleted_at.is_some());
}

/// R4-03：false→true 换判后状态按纠正事件重算，不被
/// `me_qbank_{sid}` + ON CONFLICT DO NOTHING 锁死在首判信号。
#[test]
fn qbank_verdict_correction_false_to_true_recomputes_state() {
    let (_tmp, vfs, svc) = setup();
    let concept = "换判概念";
    let sid = "sub_corr_1";
    let qid = "q_corr_1";
    let t0 = Utc::now().timestamp_millis();

    // 首判 wrong（模拟 submit_answer 主链的同事务写入）
    set_now_override_ms(Some(t0));
    {
        let mut conn = vfs.get_conn_safe().unwrap();
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        svc.record_qbank_answer_with_conn(&tx, sid, qid, &[concept.to_string()], false)
            .unwrap();
        tx.commit().unwrap();
    }

    // 现状复现：换向仍走 record 路 → 同键 DO NOTHING，状态锁死首判
    set_now_override_ms(Some(t0 + 30_000));
    {
        let mut conn = vfs.get_conn_safe().unwrap();
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let locked = svc
            .record_qbank_answer_with_conn(&tx, sid, qid, &[concept.to_string()], true)
            .unwrap();
        tx.commit().unwrap();
        assert_eq!(
            locked.wrong_count, 1,
            "record 路换向应仍停在首判（锁死复现）"
        );
        assert!((locked.score - 0.35).abs() < 1e-9);
    }

    // 换判纠正：tombstone 首判 + 追加 _r1 + 按存活事件重算
    set_now_override_ms(Some(t0 + 60_000));
    let corrected = svc
        .record_qbank_verdict_correction(sid, qid, &[concept.to_string()], true)
        .unwrap();
    set_now_override_ms(None);

    // 仅存活 _r1(correct, weight=1)：0.5 + 0.3·(1.0 − 0.5) = 0.65
    assert!(
        (corrected.score - 0.65).abs() < 1e-9,
        "corrected score should replay only the correction event, got {}",
        corrected.score
    );
    assert_eq!(corrected.total, 1);
    assert_eq!(corrected.wrong_count, 0);
    assert_eq!(corrected.streak, 1);

    let conn = vfs.get_conn_safe().unwrap();
    let (old_deleted, old_outcome): (Option<String>, String) = conn
        .query_row(
            "SELECT deleted_at, outcome FROM mastery_events WHERE id = 'me_qbank_sub_corr_1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert!(old_deleted.is_some(), "首判事件应被 tombstone");
    assert_eq!(
        old_outcome, "wrong",
        "append-only：旧事件语义列不得被 UPDATE"
    );
    let (rev_outcome, rev_weight, rev_deleted): (String, f64, Option<String>) = conn
        .query_row(
            "SELECT outcome, weight, deleted_at FROM mastery_events
                 WHERE id = 'me_qbank_sub_corr_1_r1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(rev_outcome, "correct");
    assert!(
        (rev_weight - 1.0).abs() < 1e-9,
        "纠正事件应绕过 60s 防刷衰减直写 weight=1"
    );
    assert!(rev_deleted.is_none());
}

/// R4-03：纠正幂等（同向重放不追加）、来回换判追加 _r2、
/// 链上无首判时退化为首判 record（AI 路未接线场景）。
#[test]
fn qbank_verdict_correction_is_idempotent_and_supports_reflip() {
    let (_tmp, vfs, svc) = setup();
    let concept = "换判幂等";
    let sid = "sub_corr_2";
    let qid = "q_corr_2";
    let t0 = Utc::now().timestamp_millis();
    let chain_count = |conn: &rusqlite::Connection| -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM mastery_events
                 WHERE id = 'me_qbank_sub_corr_2'
                    OR substr(id, 1, length('me_qbank_sub_corr_2_r')) = 'me_qbank_sub_corr_2_r'",
            [],
            |row| row.get(0),
        )
        .unwrap()
    };

    // 链上无事件 → 退化为首判 record
    set_now_override_ms(Some(t0));
    let first = svc
        .record_qbank_verdict_correction(sid, qid, &[concept.to_string()], false)
        .unwrap();
    assert_eq!(first.wrong_count, 1);
    {
        let conn = vfs.get_conn_safe().unwrap();
        assert_eq!(chain_count(&conn), 1, "退化首判应只写 base 事件");
    }

    // 同向重放 → 不追加纠正事件
    set_now_override_ms(Some(t0 + 30_000));
    let replay = svc
        .record_qbank_verdict_correction(sid, qid, &[concept.to_string()], false)
        .unwrap();
    assert_eq!(replay.total, 1);
    {
        let conn = vfs.get_conn_safe().unwrap();
        assert_eq!(chain_count(&conn), 1, "同向重放不得追加纠正事件");
    }

    // false→true → _r1
    set_now_override_ms(Some(t0 + 60_000));
    let flip1 = svc
        .record_qbank_verdict_correction(sid, qid, &[concept.to_string()], true)
        .unwrap();
    assert!((flip1.score - 0.65).abs() < 1e-9);
    assert_eq!(flip1.wrong_count, 0);

    // true→false → 追加 _r2，_r1 被 tombstone
    set_now_override_ms(Some(t0 + 90_000));
    let flip2 = svc
        .record_qbank_verdict_correction(sid, qid, &[concept.to_string()], false)
        .unwrap();
    set_now_override_ms(None);
    assert!((flip2.score - 0.35).abs() < 1e-9);
    assert_eq!(flip2.total, 1);
    assert_eq!(flip2.wrong_count, 1);

    let conn = vfs.get_conn_safe().unwrap();
    let live_ids: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT id FROM mastery_events
                     WHERE concept_key = ?1 AND deleted_at IS NULL ORDER BY id",
            )
            .unwrap();
        stmt.query_map(params![concept], |row| row.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    };
    assert_eq!(live_ids, vec!["me_qbank_sub_corr_2_r2".to_string()]);
    assert_eq!(chain_count(&conn), 3, "base + _r1 + _r2");
}

#[test]
fn remote_tombstones_rebuild_zero_state_and_remove_weak_point() {
    // 画像薄弱点回流经 mastery::profile_sink，由 extensions 注入 memory 实现（拆分后为回调解耦）。
    crate::extensions::register_extensions();
    let (_tmp, vfs, svc) = setup();
    let concept = "remote-tombstone-concept";
    for index in 0..3 {
        svc.record_qbank_answer(
            &format!("remote-question-{index}"),
            &[concept.to_string()],
            false,
        )
        .unwrap();
    }
    let profile = load_profile_from_db(&vfs).unwrap().unwrap();
    assert!(profile
        .weak_points
        .iter()
        .any(|point| point.knowledge_point == concept));

    {
        let conn = vfs.get_conn_safe().unwrap();
        conn.execute(
            "UPDATE mastery_events
                 SET deleted_at = '2026-07-19T00:00:00Z',
                     updated_at = '2026-07-19T00:00:00Z'
                 WHERE concept_key = ?1",
            params![concept],
        )
        .unwrap();
        MasteryService::recompute_all_states_with_conn(&conn).unwrap();
    }
    svc.sync_all_learner_profiles().unwrap();

    let state = svc.get_state(concept).unwrap().unwrap();
    assert_eq!(state.total, 0);
    assert_eq!(state.wrong_count, 0);
    let profile = load_profile_from_db(&vfs).unwrap().unwrap();
    assert!(!profile
        .weak_points
        .iter()
        .any(|point| point.knowledge_point == concept));
}

/// C5-4：旧 NULL signal 的 rating 行回退 target=0.35
#[test]
fn legacy_null_signal_rating_falls_back_to_0_35() {
    let (_tmp, vfs, svc) = setup();
    let conn = vfs.get_conn_safe().unwrap();
    conn.execute(
        "INSERT INTO mastery_events
                (id, created_at, source, concept_key, item_id, outcome, weight, signal)
             VALUES ('me_legacy', '2020-01-01T00:00:00Z', 'fsrs', 'legacy_c', 'c1', 'rating', 1.0, NULL)",
        [],
    )
    .unwrap();
    let null_signal: Option<f64> = conn
        .query_row(
            "SELECT signal FROM mastery_events WHERE id = 'me_legacy'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(null_signal.is_none(), "fixture must be NULL signal");
    drop(conn);
    let state = svc.recompute_state("legacy_c").unwrap();
    // score0=0.5, target=0.35, α=0.3 → 0.5 + 0.3*(0.35-0.5) = 0.455
    assert!(
        (state.score - 0.455).abs() < 1e-9,
        "legacy rating NULL signal should use 0.35 target, got {}",
        state.score
    );
    let persisted = svc.get_state("legacy_c").unwrap().unwrap();
    assert!((persisted.score - 0.455).abs() < 1e-9);
}

/// C5-5：极低掌握度提前 ≤ 3 天；真实 sqlite score 驱动
#[test]
fn mastery_due_bias_low_high_and_cap_on_real_sqlite_scores() {
    let (_tmp, _vfs, svc) = setup();
    let t0 = Utc::now().timestamp_millis();
    // Drive low mastery via repeated wrongs
    for i in 0..5 {
        set_now_override_ms(Some(t0 + i * 120_000));
        svc.record_event(
            MasterySource::Qbank,
            "偏置弱",
            &format!("w{i}"),
            &MasteryOutcome::Wrong,
        )
        .unwrap();
    }
    // Drive high mastery via repeated corrects (spaced)
    for i in 0..8 {
        set_now_override_ms(Some(t0 + 1_000_000 + i * 90_000));
        svc.record_event(
            MasterySource::Qbank,
            "偏置强",
            &format!("c{i}"),
            &MasteryOutcome::Correct,
        )
        .unwrap();
    }
    set_now_override_ms(None);

    let low = svc.get_state("偏置弱").unwrap().unwrap();
    let high = svc.get_state("偏置强").unwrap().unwrap();
    assert!(low.score < 0.5, "low score={}", low.score);
    assert!(high.score > 0.5, "high score={}", high.score);

    let now = 1_700_000_000_000_i64;
    let interval = 10 * MS_PER_DAY;
    let fsrs_due = now + interval;

    let low_due = apply_mastery_due_bias(low.score, now, fsrs_due);
    let high_due = apply_mastery_due_bias(high.score, now, fsrs_due);
    assert!(
        low_due < fsrs_due,
        "low mastery must advance due: {low_due} vs {fsrs_due}"
    );
    let expected_delta = mastery_due_bias_delta_ms(low.score, interval);
    assert_eq!(low_due, fsrs_due + expected_delta);
    assert!(
        high_due >= fsrs_due,
        "high mastery must not advance: {high_due} vs {fsrs_due}"
    );

    // Cap: score=0 + 100d interval → 绝对提前恰好 3 天，而非 40d
    let capped = mastery_due_bias_delta_ms(0.0, 100 * MS_PER_DAY);
    assert_eq!(capped, -MAX_ADVANCE_MS);
    let capped_due = apply_mastery_due_bias(0.0, now, now + 100 * MS_PER_DAY);
    assert_eq!(capped_due, now + 100 * MS_PER_DAY - MAX_ADVANCE_MS);
    // 极低真实 score 同样受 cap
    let low_capped = mastery_due_bias_delta_ms(low.score, 100 * MS_PER_DAY);
    assert!(low_capped.abs() <= MAX_ADVANCE_MS);
}

#[test]
fn overview_includes_today_priority_review() {
    let (_tmp, _vfs, svc) = setup();
    let t0 = Utc::now().timestamp_millis();
    for i in 0..3 {
        set_now_override_ms(Some(t0 + i * 120_000));
        svc.record_event(
            MasterySource::Qbank,
            "优先复习概念",
            &format!("p{i}"),
            &MasteryOutcome::Wrong,
        )
        .unwrap();
    }
    set_now_override_ms(None);
    let summary = svc.overview_summary(5).unwrap();
    assert!(summary.weak_count >= 1);
    assert!(
        !summary.today_priority_review.is_empty(),
        "expected today_priority_review block"
    );
    assert_eq!(summary.today_priority_review[0].concept_key, "优先复习概念");
    assert_eq!(summary.today_priority_review[0].priority, 1);
}
