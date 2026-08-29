//! mastery 换判纠正（false→true）—— pub API 黑盒集成回归
//!
//! ⚠️ 执行门禁：本文件为 0824 Wave2-E 第 7 轮「mastery 纠正测试」产物，
//! **第 8 轮才统一执行**。本轮只写不跑（round discipline）。
//!
//! # 契约（本文件锁定的公开面）
//!
//! 首判走 `record_qbank_answer_with_conn`（幂等键 `me_qbank_{sid}` +
//! ON CONFLICT DO NOTHING，只保证"首判恰好一次"）；换判必须走纠正路
//! `MasteryService::record_qbank_verdict_correction`（pub 自持事务版，
//! 补偿脚本入口；内部即 `record_qbank_verdict_correction_with_conn`）：
//!
//! 1. tombstone 事件链上仍存活的旧信号（只推进 deleted_at/updated_at/
//!    local_version 同步元数据，append-only——旧事件 outcome/signal 语义列不 UPDATE）；
//! 2. 追加修订事件 `me_qbank_{sid}_r{n}`（weight=1 直写，不吃 60s 防刷衰减）；
//! 3. 按存活事件重算 concept 聚合 —— **重算结果跟随最新判定，不被首判锁死**。
//!
//! # 分数口径（EMA α=0.30，起点 0.5，无需时钟覆盖即确定）
//!
//! - 首判 wrong（负向信号恒 weight=1）：0.5 + 0.3·(0.0 − 0.5) = **0.35**
//! - false→true 纠正后仅存活 `_r1`(correct, weight=1)：
//!   0.5 + 0.3·(1.0 − 0.5) = **0.65**
//!
//! `set_now_override_ms` 是 `#[cfg(test)]` in-crate 专用，集成测试拿不到；
//! 本文件刻意只用与挂钟无关的确定性断言（负向信号与纠正事件都不经
//! 防刷衰减，`compute_event_weight_with_conn` 的 60s 窗口只衰减正向 record 路）。
//!
//! # 与既有测试的分工
//!
//! - in-crate 白盒 `mastery/service.rs::tests::qbank_verdict_correction_*`：
//!   带时钟覆盖的精确链走查（含 reflip `_r2`、退化首判）；
//! - `tests/qbank_verdict_three_paths.rs`：qbank 三路判分的计数/RowSync 黑盒；
//! - 本文件：跨 crate 锁定 **pub** `record_qbank_verdict_correction` 的
//!   false→true 重算契约（首判锁死破除）+ 与产品判分链写入的同库互操作。
//!
//! 夹具对照 `tests/qbank_verdict_three_paths.rs`：真实迁移建库
//! （MigrationCoordinator → DatabaseId::Vfs），不 mock 存储层。

use std::sync::Arc;

use deep_student_lib::data_governance::migration::coordinator::MigrationCoordinator;
use deep_student_lib::data_governance::schema_registry::DatabaseId;
use deep_student_lib::mastery::MasteryService;
use deep_student_lib::question_bank_service::QuestionBankService;
use deep_student_lib::vfs::repos::{
    CreateQuestionParams, Question, QuestionType, SourceType, VfsExamRepo, VfsQuestionRepo,
};
use deep_student_lib::vfs::types::VfsCreateExamSheetParams;
use deep_student_lib::vfs::VfsDatabase;
use rusqlite::TransactionBehavior;
use serde_json::json;
use tempfile::TempDir;

// ============================================================================
// 夹具：真实迁移建库（与 qbank_verdict_three_paths.rs 同款，不 mock 存储层）
// ============================================================================

fn create_vfs_db() -> (TempDir, Arc<VfsDatabase>) {
    let dir = TempDir::new().expect("create VFS temp directory");
    let mut coordinator = MigrationCoordinator::new(dir.path().to_path_buf()).with_audit_db(None);
    coordinator
        .migrate_single(DatabaseId::Vfs)
        .expect("apply production VFS migrations");
    let db = VfsDatabase::new(dir.path()).expect("open migrated VFS database");
    (dir, Arc::new(db))
}

/// mastery_events 单行终态：`(outcome, weight, deleted_at)`；None = 行不存在。
fn event_row(vfs: &Arc<VfsDatabase>, event_id: &str) -> Option<(String, f64, Option<String>)> {
    let conn = vfs.get_conn_safe().expect("vfs connection");
    conn.query_row(
        "SELECT outcome, weight, deleted_at FROM mastery_events WHERE id = ?1",
        rusqlite::params![event_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .ok()
}

/// 该 submission 事件链（base + `_r{n}` 修订）总行数，含 tombstone。
/// substr 前缀匹配与产品实现同口径（避免 `_`/`%` 被 LIKE 当通配符）。
fn chain_count(vfs: &Arc<VfsDatabase>, submission_id: &str) -> i64 {
    let base = format!("me_qbank_{submission_id}");
    let prefix = format!("{base}_r");
    let conn = vfs.get_conn_safe().expect("vfs connection");
    conn.query_row(
        "SELECT COUNT(*) FROM mastery_events
         WHERE id = ?1 OR substr(id, 1, length(?2)) = ?2",
        rusqlite::params![base, prefix],
        |row| row.get(0),
    )
    .expect("count mastery event chain")
}

// ============================================================================
// 主测：false→true 纠正重算，不被首判 + ON CONFLICT DO NOTHING 锁死
// ============================================================================

/// 首判 wrong 落链后：
/// 1. 复现锁死前提 —— record 路换向（同键 DO NOTHING）状态仍停在首判；
/// 2. pub `record_qbank_verdict_correction(…, true)` 后状态按纠正事件重算
///    （score 0.35→0.65、wrong_count 1→0、streak 1）；
/// 3. 表终态：首判事件被 tombstone 且语义列未改（outcome 仍 'wrong'），
///    修订 `_r1` 存活、outcome='correct'、weight=1（防刷旁路直写）。
#[test]
fn false_to_true_correction_recomputes_state_and_breaks_first_verdict_lock() {
    let (_tmp, vfs) = create_vfs_db();
    let mastery = MasteryService::new(Arc::clone(&vfs));
    let sid = "sub_it_corr_main";
    let qid = "q_it_corr_main";
    let tags = vec!["集成换判概念".to_string()];

    // 首判 wrong：与产品判分事务同款形态（IMMEDIATE 事务内 record 路写入）
    {
        let mut conn = vfs.get_conn_safe().expect("vfs connection");
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .expect("open immediate transaction");
        let first = mastery
            .record_qbank_answer_with_conn(&tx, sid, qid, &tags, false)
            .expect("record first verdict wrong");
        tx.commit().expect("commit first verdict");
        assert_eq!((first.total, first.wrong_count), (1, 1));
        assert!(
            (first.score - 0.35).abs() < 1e-9,
            "首判 wrong 后 score 应为 0.5 + 0.3·(0−0.5) = 0.35，got {}",
            first.score
        );
    }

    // 锁死前提复现：换向仍走 record 路 → me_qbank_{sid} 同键 DO NOTHING，
    // 状态被锁死在首判方向（这正是纠正路要解决的问题）。
    {
        let mut conn = vfs.get_conn_safe().expect("vfs connection");
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .expect("open immediate transaction");
        let locked = mastery
            .record_qbank_answer_with_conn(&tx, sid, qid, &tags, true)
            .expect("record-path flip attempt");
        tx.commit().expect("commit no-op flip");
        assert_eq!(
            locked.wrong_count, 1,
            "record 路换向必须仍停在首判（锁死复现）"
        );
        assert!((locked.score - 0.35).abs() < 1e-9);
        assert_eq!(chain_count(&vfs, sid), 1, "DO NOTHING 不得插入第二条事件");
    }

    // 被测公开面：pub 自持事务版换判纠正（补偿脚本入口）
    let corrected = mastery
        .record_qbank_verdict_correction(sid, qid, &tags, true)
        .expect("false→true correction");

    // 重算只回放存活事件（仅 _r1 correct, weight=1）：不被首判锁死
    assert!(
        (corrected.score - 0.65).abs() < 1e-9,
        "纠正后 score 应为 0.5 + 0.3·(1−0.5) = 0.65（仅回放纠正事件），got {}",
        corrected.score
    );
    assert_eq!(corrected.total, 1, "纠正是改判不是新作答，total 不得翻倍");
    assert_eq!(
        corrected.wrong_count, 0,
        "首判 wrong 信号必须被 tombstone 排除"
    );
    assert_eq!(corrected.streak, 1);

    // 表终态：append-only tombstone + 修订事件
    let (base_outcome, _, base_deleted) =
        event_row(&vfs, "me_qbank_sub_it_corr_main").expect("base event row exists");
    assert!(
        base_deleted.is_some(),
        "首判事件应被 tombstone（deleted_at 落值）"
    );
    assert_eq!(
        base_outcome, "wrong",
        "append-only：tombstone 只动同步元数据，旧事件 outcome 不得被 UPDATE"
    );
    let (rev_outcome, rev_weight, rev_deleted) =
        event_row(&vfs, "me_qbank_sub_it_corr_main_r1").expect("revision _r1 exists");
    assert_eq!(rev_outcome, "correct");
    assert!(rev_deleted.is_none(), "修订事件必须存活");
    assert!(
        (rev_weight - 1.0).abs() < 1e-9,
        "纠正事件应绕过 60s 防刷衰减直写 weight=1"
    );
    assert_eq!(chain_count(&vfs, sid), 2, "链上恰 base + _r1 两条");
}

// ============================================================================
// 幂等：纠正后同向重放不追加修订、不动聚合
// ============================================================================

/// 纠正落链后重复调用同向纠正（补偿脚本重跑场景）：
/// 存活末端已是 correct → 不追加 `_r2`，聚合保持 0.65。
#[test]
fn correction_same_direction_replay_is_idempotent() {
    let (_tmp, vfs) = create_vfs_db();
    let mastery = MasteryService::new(Arc::clone(&vfs));
    let sid = "sub_it_corr_replay";
    let qid = "q_it_corr_replay";
    let tags = vec!["纠正幂等概念".to_string()];

    {
        let mut conn = vfs.get_conn_safe().expect("vfs connection");
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .expect("open immediate transaction");
        mastery
            .record_qbank_answer_with_conn(&tx, sid, qid, &tags, false)
            .expect("record first verdict wrong");
        tx.commit().expect("commit first verdict");
    }

    let first_flip = mastery
        .record_qbank_verdict_correction(sid, qid, &tags, true)
        .expect("first correction");
    assert!((first_flip.score - 0.65).abs() < 1e-9);
    assert_eq!(chain_count(&vfs, sid), 2);

    let replay = mastery
        .record_qbank_verdict_correction(sid, qid, &tags, true)
        .expect("same-direction replay");
    assert!(
        (replay.score - 0.65).abs() < 1e-9,
        "同向重放不得改动聚合，got {}",
        replay.score
    );
    assert_eq!(replay.total, 1);
    assert_eq!(replay.wrong_count, 0);
    assert_eq!(chain_count(&vfs, sid), 2, "同向重放不得追加 _r2");
    assert!(
        event_row(&vfs, "me_qbank_sub_it_corr_replay_r1")
            .expect("_r1 exists")
            .2
            .is_none(),
        "同向重放不得 tombstone 既有修订"
    );
}

// ============================================================================
// 互操作：产品判分链写入的首判 + pub 补偿纠正 + 后续产品换判，三方同链协作
// ============================================================================

fn create_exam(vfs_db: &Arc<VfsDatabase>, temp_id: &str) -> String {
    VfsExamRepo::create_exam_sheet(
        vfs_db,
        VfsCreateExamSheetParams {
            exam_name: Some(format!("mastery correction {temp_id}")),
            temp_id: temp_id.to_string(),
            metadata_json: json!({"fixture": "mastery_qbank_correction"}),
            preview_json: json!({"session_id": temp_id, "pages": []}),
            status: "completed".to_string(),
            folder_id: None,
        },
    )
    .expect("create exam fixture through production repository")
    .id
}

/// 主观题（short_answer 恒需人工批改 → 首次提交 is_correct 为 NULL）
fn create_subjective_question(vfs_db: &Arc<VfsDatabase>, exam_id: &str, label: &str) -> Question {
    VfsQuestionRepo::create_question(
        vfs_db,
        &CreateQuestionParams {
            exam_id: exam_id.to_string(),
            card_id: Some(label.to_string()),
            question_label: Some(label.to_string()),
            content: format!("{label}: explain why the sky is blue"),
            options: None,
            answer: Some("Rayleigh scattering favors shorter wavelengths.".to_string()),
            explanation: None,
            question_type: Some(QuestionType::ShortAnswer),
            difficulty: None,
            tags: Some(vec!["physics".to_string()]),
            source_type: Some(SourceType::Manual),
            source_ref: Some("mastery_qbank_correction".to_string()),
            images: None,
            parent_id: None,
            structured_data: None,
        },
    )
    .expect("create subjective question fixture")
}

/// 真实产品链写首判（submit_answer 待判定 → regrade false 首判 wrong），
/// 再从事务外用 pub `record_qbank_verdict_correction` 补偿为 true：
/// - 纠正必须作用于产品写入的同一条 `me_qbank_{sid}` 链（tombstone + _r1）；
/// - 之后产品侧同向改判（regrade true）经原语纠正分路，识别存活末端已
///   correct → 幂等不追加 `_r2`（补偿与产品路互不重复计信号）。
#[test]
fn compensation_entry_interops_with_product_written_verdict_chain() {
    let (_tmp, vfs) = create_vfs_db();
    let qbank = QuestionBankService::new(Arc::clone(&vfs));
    let mastery = MasteryService::new(Arc::clone(&vfs));
    let exam_id = create_exam(&vfs, "corr-interop");
    let question = create_subjective_question(&vfs, &exam_id, "q-corr-interop");
    let tags = vec!["physics".to_string()];

    // 产品链：待判定提交 → 人工首判 wrong（原语首判分路写 me_qbank_{sid}）
    let pending = qbank
        .submit_answer(&question.id, "sky is blue because ocean", None, None)
        .expect("pending subjective submit");
    assert_eq!(pending.is_correct, None, "主观题首次提交应待判定");
    let sid = pending.submission_id.clone();

    qbank
        .regrade_submission(&question.id, &sid, false)
        .expect("first verdict wrong via product path");
    let base_id = format!("me_qbank_{sid}");
    let (base_outcome, _, base_deleted) =
        event_row(&vfs, &base_id).expect("产品首判必须写入 me_qbank_{sid} 事件");
    assert_eq!(base_outcome, "wrong");
    assert!(base_deleted.is_none());
    assert_eq!(chain_count(&vfs, &sid), 1);

    // 补偿入口：事务外直接纠正 false→true（作用于产品写入的同一条链）
    let corrected = mastery
        .record_qbank_verdict_correction(&sid, &question.id, &tags, true)
        .expect("out-of-band compensation correction");
    assert_eq!(
        corrected.concept_key, "physics",
        "concept 取题目首个非空 tag"
    );
    assert!(
        (corrected.score - 0.65).abs() < 1e-9,
        "补偿后 score 应按存活纠正事件重算为 0.65，got {}",
        corrected.score
    );
    assert_eq!(
        corrected.wrong_count, 0,
        "产品写入的首判 wrong 必须被 tombstone"
    );
    assert!(
        event_row(&vfs, &base_id).expect("base row").2.is_some(),
        "产品首判事件应被补偿纠正 tombstone"
    );
    let rev_id = format!("{base_id}_r1");
    let (rev_outcome, rev_weight, rev_deleted) =
        event_row(&vfs, &rev_id).expect("compensation revision _r1 exists");
    assert_eq!(rev_outcome, "correct");
    assert!(rev_deleted.is_none());
    assert!((rev_weight - 1.0).abs() < 1e-9);

    // 产品侧随后同向改判：原语换判分路（correction_with_conn）识别存活末端
    // 已 correct → 幂等不追加，链保持 base(tombstone) + _r1
    qbank
        .regrade_submission(&question.id, &sid, true)
        .expect("product regrade after compensation");
    assert_eq!(
        chain_count(&vfs, &sid),
        2,
        "补偿后产品同向改判不得追加 _r2（信号不重复计）"
    );
    assert!(
        event_row(&vfs, &rev_id).expect("_r1 row").2.is_none(),
        "产品同向改判不得 tombstone 补偿修订"
    );
}
