//! qbank 判分三路（自动判分 A / AI 判分 B / 人工改判 C）计数等价 —— 集成回归
//!
//! ⚠️ 执行门禁：本文件为 0824 Wave2-E 第 4 轮「测试源码」产物（第 7 轮扩展，
//! 见 docs/dev/wave2-E-r7-04-verdict-tests.md），**第 8 轮才统一执行**。
//! 第 4 轮只写不跑（与后端 verdict 原语、前端 daily 回写修复并行落地，
//! 本文件是这批修复的黑盒验收网）。
//!
//! # 三路计数等价意图（契约表，文档化）
//!
//! 三条判分路径最终都必须落到同一份差值口径（R4 起由
//! `QuestionBankService::apply_submission_verdict_in_tx` 原语统一承载；
//! 该原语是 pub(crate)，其白盒表格测试在 question_bank_service.rs 的
//! `mod tests::apply_submission_verdict_counts_and_rowsync`。本文件只走 pub API，
//! 从 `submit_answer` / `regrade_submission` / `get_daily_practice` 三个公开入口
//! 黑盒验证同一契约）：
//!
//! | 判定转移        | correct_count | question.status           | 新增 submission |
//! |-----------------|---------------|---------------------------|-----------------|
//! | NULL → true     | +1            | in_progress / mastered    | 否（原地改写）  |
//! | NULL → false    | 0             | review                    | 否              |
//! | false → true    | +1            | in_progress / mastered    | 否              |
//! | true → false    | -1（MAX(0,·)）| review                    | 否              |
//! | 同向（幂等）    | 0（零写入）   | 不变                      | 否              |
//!
//! 附加不变量：改判永不递增 attempt_count；改写必须推进 answer_submissions 的
//! RowSync 列（updated_at / local_version），幂等路径不得推进。
//!
//! # 各路覆盖方式
//!
//! - **A 路（自动判分 / 带 override 的提交）**：`submit_answer` 的待判定去重分支
//!   （同答案 + is_correct IS NULL → 并入改判），以及"已判定后再带 override 重复
//!   提交 = 真实新作答"的边界——本文件直接测。
//! - **C 路（人工改判）**：`regrade_submission` 全转移表——本文件直接测。
//! - **B 路（AI 判分管线）**：`run_qbank_grading` 需要 tauri Window
//!   （QbankGradingEmitter 强依赖）+ mockito SSE，且默认 harness 测试无法建
//!   tauri App（须在 Cargo.toml 注册 harness=false 目标，属产品文件，本轮禁改）。
//!   R7 复核维持该结论（QbankGradingEmitter 仍无 trait 抽象、`::new` 仅收
//!   具体 `tauri::Window`），故 B 路在本文件内仍不可直接驱动。
//!   B 路首判已由 `tests/qbank_executor_e2e.rs` 覆盖（verdict correct → +1、
//!   grading_method='ai'）；B 路已于 R4 接入上述原语（pipeline.rs 的
//!   persist_grading_result，见 wave2-E-r4-02），其换判等价（false→true /
//!   true→false / mastery 事件）由 pipeline 侧 in-crate 白盒单测锁定。
//!   **等价意图以本表格文档化；第 8 轮若 e2e 有扩展，应对齐本表格。**
//!   R7 起本文件另以「B 路落库终态种子」逼近覆盖 B→C 交接
//!   （见 `ai_decided_verdict_manual_flip_converges_to_manual_method`）：
//!   因 B/C 共用原语，两路对 submission 行的写入仅 grading_method 字面量不同，
//!   单列覆写后的库面状态与真实 B 路判分终态一致。B 路各行为的
//!   auto（自动测试位置）/ manual（人工验证步骤）转移表见
//!   docs/dev/wave2-E-r7-04-verdict-tests.md §2。
//!
//! # grading_method 转移表（R7 补充，文档化 + 本文件锁定）
//!
//! submission 行 grading_method 的起点由 submit_answer 的插入分支决定，
//! 其后仅被原语按调用路改写；同向幂等在原语入口短路、**不改写** grading_method：
//!
//! | 事件                                  | grading_method 转移      | 锁定位置 |
//! |---------------------------------------|--------------------------|----------|
//! | 客观题提交（自动判分）                | (插入) → `auto`          | 本文件 `grading_method_origin_matrix_matches_documented_table` |
//! | 主观题提交（待判定，等 AI/人工）      | (插入) → `ai`            | 同上 |
//! | 带 override 的新作答提交              | (插入) → `manual`        | 同上 |
//! | A 路待判定去重 / C 路改判（换判生效） | 任意 → `manual`          | 本文件多例 + in-crate 白盒 |
//! | B 路 AI persist（判定生效）           | 任意 → `ai`              | qbank_executor_e2e（首判）+ pipeline 白盒（换判）|
//! | 同向幂等重放（任一路）                | 不变（零写入）           | 本文件 `idempotent_regrade_of_auto_verdict_preserves_grading_method_and_rowsync` |
//!
//! 同时覆盖（任务面）：
//! - 改判回写：SubmitAnswerResult.daily_progress 权威快照与 get_daily_practice 同口径；
//! - 旧卡兼容：无 answer_submissions 行的存量题按 last_attempt_at 兜底进入 daily；
//!   旧载荷缺 daily_progress 字段仍可反序列化（serde default）。

use std::sync::Arc;

use deep_student_lib::data_governance::migration::coordinator::MigrationCoordinator;
use deep_student_lib::data_governance::schema_registry::DatabaseId;
use deep_student_lib::question_bank_service::{QuestionBankService, SubmitAnswerResult};
use deep_student_lib::vfs::repos::{
    CreateQuestionParams, Question, QuestionStatus, QuestionType, SourceType, VfsExamRepo,
    VfsQuestionRepo,
};
use deep_student_lib::vfs::types::VfsCreateExamSheetParams;
use deep_student_lib::vfs::VfsDatabase;
use serde_json::json;
use tempfile::TempDir;

// ============================================================================
// 夹具：真实迁移建库 + 生产仓储写入（不 mock 任何存储层）
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

fn create_exam(vfs_db: &Arc<VfsDatabase>, temp_id: &str) -> String {
    VfsExamRepo::create_exam_sheet(
        vfs_db,
        VfsCreateExamSheetParams {
            exam_name: Some(format!("verdict-three-paths {temp_id}")),
            temp_id: temp_id.to_string(),
            metadata_json: json!({"fixture": "qbank_verdict_three_paths"}),
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
            source_ref: Some("qbank_verdict_three_paths".to_string()),
            images: None,
            parent_id: None,
            structured_data: None,
        },
    )
    .expect("create subjective question fixture")
}

/// 客观题（single_choice → submit_answer 自动判分，grading_method='auto'；
/// 判分只比对 answer 选项键，无需 options 数据）
fn create_choice_question(vfs_db: &Arc<VfsDatabase>, exam_id: &str, label: &str) -> Question {
    VfsQuestionRepo::create_question(
        vfs_db,
        &CreateQuestionParams {
            exam_id: exam_id.to_string(),
            card_id: Some(label.to_string()),
            question_label: Some(label.to_string()),
            content: format!("{label}: pick the correct option"),
            options: None,
            answer: Some("A".to_string()),
            explanation: None,
            question_type: Some(QuestionType::SingleChoice),
            difficulty: None,
            tags: Some(vec!["physics".to_string()]),
            source_type: Some(SourceType::Manual),
            source_ref: Some("qbank_verdict_three_paths".to_string()),
            images: None,
            parent_id: None,
            structured_data: None,
        },
    )
    .expect("create single-choice question fixture")
}

fn reload_question(vfs_db: &Arc<VfsDatabase>, question_id: &str) -> Question {
    VfsQuestionRepo::get_question(vfs_db, question_id)
        .expect("read question")
        .expect("question exists")
}

fn submission_count(vfs_db: &Arc<VfsDatabase>, question_id: &str) -> usize {
    VfsQuestionRepo::get_submissions(vfs_db, question_id, 50)
        .expect("read submission history")
        .len()
}

/// answer_submissions 的 RowSync 列（updated_at, local_version）。
/// 列由 V20260523 迁移建立；这里只读校验，属旁证查询而非私有 API。
fn submission_rowsync(vfs_db: &Arc<VfsDatabase>, submission_id: &str) -> (Option<String>, i64) {
    let conn = vfs_db.get_conn_safe().expect("vfs connection");
    conn.query_row(
        "SELECT updated_at, COALESCE(local_version, 0) FROM answer_submissions WHERE id = ?1",
        rusqlite::params![submission_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .expect("read submission rowsync columns")
}

// ============================================================================
// C 路：人工改判全转移表（pub API：regrade_submission）
// ============================================================================

/// 契约表逐行走查：NULL→false→true→true(幂等)→false，全程
/// attempt_count 恒 1、submission 恒 1 条、correct_count 永不为负。
#[test]
fn manual_regrade_walks_full_transition_table_without_new_attempts() {
    let (_tmp, vfs_db) = create_vfs_db();
    let service = QuestionBankService::new(Arc::clone(&vfs_db));
    let exam_id = create_exam(&vfs_db, "regrade-table");
    let question = create_subjective_question(&vfs_db, &exam_id, "q-table");

    let first = service
        .submit_answer(&question.id, "blue light scatters more", None, None)
        .expect("subjective submit");
    assert_eq!(first.is_correct, None, "主观题首次提交应待判定");
    assert!(first.needs_manual_grading);
    let submission_id = first.submission_id.clone();

    let q = reload_question(&vfs_db, &question.id);
    assert_eq!((q.attempt_count, q.correct_count), (1, 0));

    // NULL → false：delta 0，状态 review
    let r = service
        .regrade_submission(&question.id, &submission_id, false)
        .expect("regrade NULL→false");
    assert_eq!(r.is_correct, Some(false));
    assert!(!r.needs_manual_grading);
    let q = reload_question(&vfs_db, &question.id);
    assert_eq!(q.correct_count, 0, "NULL→false 不得改动 correct_count");
    assert_eq!(q.status, QuestionStatus::Review);
    assert_eq!(q.is_correct, Some(false));

    // false → true：+1，状态离开 review
    service
        .regrade_submission(&question.id, &submission_id, true)
        .expect("regrade false→true");
    let q = reload_question(&vfs_db, &question.id);
    assert_eq!(q.correct_count, 1, "false→true 必须 +1");
    assert_eq!(q.status, QuestionStatus::InProgress);
    assert_eq!(q.is_correct, Some(true));

    // true → true：同向幂等，零变化
    service
        .regrade_submission(&question.id, &submission_id, true)
        .expect("idempotent regrade");
    let q = reload_question(&vfs_db, &question.id);
    assert_eq!(q.correct_count, 1, "同向改判必须零写入");
    assert_eq!(q.status, QuestionStatus::InProgress);

    // true → false：-1，MAX(0,·) 防负，状态回 review
    service
        .regrade_submission(&question.id, &submission_id, false)
        .expect("regrade true→false");
    let q = reload_question(&vfs_db, &question.id);
    assert_eq!(q.correct_count, 0, "true→false 必须 -1 且不为负");
    assert_eq!(q.status, QuestionStatus::Review);

    // 全程不变量：不新插 submission、不涨 attempt_count、grading_method 收敛 manual
    assert_eq!(q.attempt_count, 1, "改判永不递增 attempt_count");
    let submissions = VfsQuestionRepo::get_submissions(&vfs_db, &question.id, 50)
        .expect("read submission history");
    assert_eq!(submissions.len(), 1, "改判永不新插作答记录");
    assert_eq!(submissions[0].id, submission_id);
    assert_eq!(submissions[0].is_correct, Some(false));
    assert_eq!(submissions[0].grading_method, "manual");
}

// ============================================================================
// A 路：submit_answer 的待判定去重分支与真实重复作答边界
// ============================================================================

/// 待判定提交 + 同答案带 override 重提 = 并入改判：不双计 attempt，不插第二条。
#[test]
fn pending_override_resubmit_merges_into_regrade_without_double_count() {
    let (_tmp, vfs_db) = create_vfs_db();
    let service = QuestionBankService::new(Arc::clone(&vfs_db));
    let exam_id = create_exam(&vfs_db, "override-merge");
    let question = create_subjective_question(&vfs_db, &exam_id, "q-merge");

    let pending = service
        .submit_answer(&question.id, "same answer text", None, None)
        .expect("pending submit");
    assert_eq!(pending.is_correct, None);

    // 前端"我答对了"路径：同一份答案 + override 重提
    let merged = service
        .submit_answer(&question.id, "same answer text", Some(true), None)
        .expect("override resubmit");
    assert_eq!(merged.is_correct, Some(true));
    assert_eq!(
        merged.submission_id, pending.submission_id,
        "待判定去重必须原地改判同一条 submission"
    );

    let q = reload_question(&vfs_db, &question.id);
    assert_eq!(q.attempt_count, 1, "去重分支不得双计 attempt_count");
    assert_eq!(q.correct_count, 1, "NULL→true 计数 +1（与 C 路等价）");
    assert_eq!(submission_count(&vfs_db, &question.id), 1);
    let submissions =
        VfsQuestionRepo::get_submissions(&vfs_db, &question.id, 1).expect("read merged submission");
    assert_eq!(submissions[0].grading_method, "manual");
}

/// 边界意图：已判定后再带 override 重复提交是**真实新作答**（Agent 批量练习
/// 场景），不得被启发式误并——attempt/submission 都要 +1。
#[test]
fn decided_override_resubmit_remains_a_real_second_attempt() {
    let (_tmp, vfs_db) = create_vfs_db();
    let service = QuestionBankService::new(Arc::clone(&vfs_db));
    let exam_id = create_exam(&vfs_db, "override-boundary");
    let question = create_subjective_question(&vfs_db, &exam_id, "q-boundary");

    service
        .submit_answer(&question.id, "boundary answer", None, None)
        .expect("pending submit");
    service
        .submit_answer(&question.id, "boundary answer", Some(true), None)
        .expect("first override merges");

    // 最近一次提交已判定（Some(true)）→ 再带 override 同答案重提 = 新作答
    let second = service
        .submit_answer(&question.id, "boundary answer", Some(true), None)
        .expect("decided override resubmit");
    assert_eq!(second.is_correct, Some(true));

    let q = reload_question(&vfs_db, &question.id);
    assert_eq!(q.attempt_count, 2, "已判定后的重复提交必须计新 attempt");
    assert_eq!(q.correct_count, 2);
    assert_eq!(q.status, QuestionStatus::Mastered, "两次答对 → mastered");
    assert_eq!(submission_count(&vfs_db, &question.id), 2);
}

// ============================================================================
// RowSync：改判必须推进 answer_submissions 的 updated_at / local_version
// ============================================================================

/// 黑盒确认 pub 入口（regrade_submission）路由到 R4 原语的 RowSync 语义：
/// 改写推进 local_version 与 updated_at；同向幂等不推进。
/// （逐次 +1 的白盒断言在 in-crate 单测，这里只锁公开入口的相对推进。）
#[test]
fn pub_regrade_entrypoint_advances_submission_rowsync_columns() {
    let (_tmp, vfs_db) = create_vfs_db();
    let service = QuestionBankService::new(Arc::clone(&vfs_db));
    let exam_id = create_exam(&vfs_db, "rowsync");
    let question = create_subjective_question(&vfs_db, &exam_id, "q-rowsync");

    let pending = service
        .submit_answer(&question.id, "rowsync answer", None, None)
        .expect("pending submit");
    let submission_id = pending.submission_id.clone();

    service
        .regrade_submission(&question.id, &submission_id, true)
        .expect("regrade NULL→true");
    let (updated_at_1, version_1) = submission_rowsync(&vfs_db, &submission_id);
    assert!(
        updated_at_1.is_some(),
        "改判后 updated_at 必须落值（行级 LWW 依赖它判新旧）"
    );
    assert!(version_1 >= 1, "改判后 local_version 必须 >= 1");

    service
        .regrade_submission(&question.id, &submission_id, false)
        .expect("regrade true→false");
    let (updated_at_2, version_2) = submission_rowsync(&vfs_db, &submission_id);
    assert!(updated_at_2.is_some());
    assert_eq!(version_2, version_1 + 1, "换判必须推进 local_version");

    service
        .regrade_submission(&question.id, &submission_id, false)
        .expect("idempotent regrade");
    let (updated_at_3, version_3) = submission_rowsync(&vfs_db, &submission_id);
    assert_eq!(version_3, version_2, "同向幂等路径不得推进 local_version");
    assert_eq!(
        updated_at_3, updated_at_2,
        "同向幂等路径不得推进 updated_at"
    );
}

// ============================================================================
// 改判回写：daily_progress 权威快照（提交/改判响应 ↔ get_daily_practice 同口径）
// ============================================================================

/// SubmitAnswerResult.daily_progress 必须与 get_daily_practice 的
/// completed/correct 同口径：按题去重 + 当天最终判定（改判原地改写同一条
/// submission，当日"任一次答对"随之翻转）。
#[test]
fn daily_progress_write_back_matches_get_daily_practice() {
    let (_tmp, vfs_db) = create_vfs_db();
    let service = QuestionBankService::new(Arc::clone(&vfs_db));
    let exam_id = create_exam(&vfs_db, "daily-writeback");
    let q1 = create_subjective_question(&vfs_db, &exam_id, "q-daily-1");
    let _q2 = create_subjective_question(&vfs_db, &exam_id, "q-daily-2");
    let _q3 = create_subjective_question(&vfs_db, &exam_id, "q-daily-3");

    // 首答判错：completed 1 / correct 0
    let wrong = service
        .submit_answer(&q1.id, "first take", Some(false), None)
        .expect("submit wrong");
    let dp = wrong
        .daily_progress
        .expect("submit_answer 必须回带当日权威进度快照");
    assert_eq!(dp.exam_id, exam_id);
    assert_eq!(dp.completed_count, 1);
    assert_eq!(dp.correct_count, 0);
    assert!(dp.answered_question_ids.contains(&q1.id));

    // 改判为对：completed 不变、correct 回补（同一 submission 原地翻转）
    let regraded = service
        .regrade_submission(&q1.id, &wrong.submission_id, true)
        .expect("regrade wrong→correct");
    let dp = regraded
        .daily_progress
        .expect("regrade_submission 必须回带当日权威进度快照");
    assert_eq!(dp.completed_count, 1, "改判不改变当日已答题数");
    assert_eq!(dp.correct_count, 1, "改判为对必须回补当日 correct");

    // 与 get_daily_practice 的权威口径逐字段对齐
    let daily = service
        .get_daily_practice(&exam_id, 3)
        .expect("get_daily_practice");
    assert_eq!(daily.completed_count, 1);
    assert_eq!(daily.correct_count, 1);
    assert!(!daily.is_completed);

    // 再改判回错：correct 回收（当日唯一一次作答的最终判定为错）
    let back = service
        .regrade_submission(&q1.id, &wrong.submission_id, false)
        .expect("regrade correct→wrong");
    let dp = back.daily_progress.expect("daily progress snapshot");
    assert_eq!(dp.completed_count, 1);
    assert_eq!(
        dp.correct_count, 0,
        "唯一提交被改判为错后当日 correct 应回收"
    );

    let daily = service
        .get_daily_practice(&exam_id, 3)
        .expect("get_daily_practice after regrade");
    assert_eq!(daily.correct_count, 0);
}

// ============================================================================
// 旧卡兼容：无 submission 行的存量题 + 旧载荷缺 daily_progress 字段
// ============================================================================

/// 存量旧卡（answer_submissions 无任何行，只有题目行上的 last_attempt_at /
/// is_correct 旧字段）必须按兜底分支计入当日进度，且与新路径作答合并去重。
#[test]
fn legacy_question_without_submission_rows_still_counts_into_daily() {
    let (_tmp, vfs_db) = create_vfs_db();
    let service = QuestionBankService::new(Arc::clone(&vfs_db));
    let exam_id = create_exam(&vfs_db, "legacy-daily");
    let legacy = create_subjective_question(&vfs_db, &exam_id, "q-legacy");
    let fresh = create_subjective_question(&vfs_db, &exam_id, "q-fresh");

    // 模拟旧版本数据形态：题目行有作答痕迹，但没有任何 submission 行
    // （V20260523 之前的历史库、或迁移前导入的数据）。
    {
        let conn = vfs_db.get_conn_safe().expect("vfs connection");
        let now = chrono::Utc::now().to_rfc3339();
        let updated = conn
            .execute(
                "UPDATE questions SET \
                     user_answer = 'legacy answer', \
                     is_correct = 1, \
                     attempt_count = 1, \
                     correct_count = 1, \
                     status = 'in_progress', \
                     last_attempt_at = ?1 \
                 WHERE id = ?2",
                rusqlite::params![now, legacy.id],
            )
            .expect("seed legacy answered question");
        assert_eq!(updated, 1);
    }
    assert_eq!(
        submission_count(&vfs_db, &legacy.id),
        0,
        "前置：旧卡不得有 submission 行"
    );

    // 兜底分支：仅凭 last_attempt_at 计入当日 completed/correct
    let daily = service
        .get_daily_practice(&exam_id, 2)
        .expect("daily with legacy question");
    assert_eq!(
        daily.completed_count, 1,
        "旧卡必须按 last_attempt_at 兜底计入"
    );
    assert_eq!(
        daily.correct_count, 1,
        "旧卡的 is_correct=1 计入当日 correct"
    );

    // 新路径作答另一题：快照要把旧卡与新提交合并（按题去重）
    let submitted = service
        .submit_answer(&fresh.id, "fresh take", Some(true), None)
        .expect("submit fresh question");
    let dp = submitted.daily_progress.expect("daily progress snapshot");
    assert_eq!(dp.completed_count, 2, "旧卡兜底 + 新提交合并计数");
    assert_eq!(dp.correct_count, 2);
    assert!(dp.answered_question_ids.contains(&legacy.id));
    assert!(dp.answered_question_ids.contains(&fresh.id));
}

/// 旧载荷兼容：缺 daily_progress 键的 SubmitAnswerResult JSON（旧版本序列化产物 /
/// 旧对端）必须仍可反序列化，字段回退 None（守护 #[serde(default)] 不被移除）。
#[test]
fn submit_answer_result_without_daily_progress_field_still_deserializes() {
    let (_tmp, vfs_db) = create_vfs_db();
    let service = QuestionBankService::new(Arc::clone(&vfs_db));
    let exam_id = create_exam(&vfs_db, "serde-compat");
    let question = create_subjective_question(&vfs_db, &exam_id, "q-serde");

    let result = service
        .submit_answer(&question.id, "serde take", Some(true), None)
        .expect("submit for serde fixture");

    let mut payload = serde_json::to_value(&result).expect("serialize SubmitAnswerResult");
    let map = payload
        .as_object_mut()
        .expect("result serializes to object");
    map.remove("daily_progress");

    let revived: SubmitAnswerResult =
        serde_json::from_value(payload).expect("旧载荷（无 daily_progress 键）必须能反序列化");
    assert!(
        revived.daily_progress.is_none(),
        "缺失字段应回退 None 而非报错"
    );
    assert_eq!(revived.submission_id, result.submission_id);
    assert_eq!(revived.is_correct, Some(true));
}

// ============================================================================
// R7 扩展：grading_method 起点矩阵（auto / ai / manual 三起点，见头部转移表）
// ============================================================================

/// 插入时 grading_method 起点矩阵：客观题自动判分 → 'auto'、主观题待判定 →
/// 'ai'（占位等待 AI/人工）、带 override 的新作答 → 'manual'。
/// 这是头部「grading_method 转移表」的起点行，防止插入分支的字面量被改动
/// 后三路收敛断言失去参照系。
#[test]
fn grading_method_origin_matrix_matches_documented_table() {
    let (_tmp, vfs_db) = create_vfs_db();
    let service = QuestionBankService::new(Arc::clone(&vfs_db));
    let exam_id = create_exam(&vfs_db, "method-origins");

    // 客观题自动判分 → 'auto'（判定即时落定，绝不出现 NULL）
    let choice = create_choice_question(&vfs_db, &exam_id, "q-origin-auto");
    let auto = service
        .submit_answer(&choice.id, "A", None, None)
        .expect("auto-graded submit");
    assert_eq!(auto.is_correct, Some(true), "客观题应即时自动判定");
    assert!(!auto.needs_manual_grading);

    // 主观题待判定 → 'ai'
    let subjective = create_subjective_question(&vfs_db, &exam_id, "q-origin-ai");
    let pending = service
        .submit_answer(&subjective.id, "pending take", None, None)
        .expect("pending submit");
    assert_eq!(pending.is_correct, None);

    // 带 override 的新作答（无既有待判定提交可并）→ 'manual'
    let overridden = create_subjective_question(&vfs_db, &exam_id, "q-origin-manual");
    let manual = service
        .submit_answer(&overridden.id, "override take", Some(true), None)
        .expect("override submit");
    assert_eq!(manual.is_correct, Some(true));

    let method_of = |question_id: &str| {
        VfsQuestionRepo::get_submissions(&vfs_db, question_id, 1)
            .expect("read submission")
            .remove(0)
            .grading_method
    };
    assert_eq!(method_of(&choice.id), "auto", "客观题自动判分起点应为 auto");
    assert_eq!(method_of(&subjective.id), "ai", "主观题待判定起点应为 ai");
    assert_eq!(
        method_of(&overridden.id),
        "manual",
        "override 新作答起点应为 manual"
    );
}

// ============================================================================
// R7 扩展：A 路自动判分（'auto' 起点）经 C 路改判的计数等价 + method 转移
// ============================================================================

/// 自动判分（'auto'）的客观题走 C 路改判，必须与主观题走查同一契约表：
/// false→true +1 / true→false -1、attempt 恒 1、submission 恒 1 条；
/// 且换判生效时 grading_method 从 'auto' 收敛为 'manual'。
#[test]
fn auto_graded_choice_regrade_transfers_method_and_counts() {
    let (_tmp, vfs_db) = create_vfs_db();
    let service = QuestionBankService::new(Arc::clone(&vfs_db));
    let exam_id = create_exam(&vfs_db, "auto-regrade");
    let question = create_choice_question(&vfs_db, &exam_id, "q-auto");

    // 自动判错（正确答案 A，用户答 B）：即时 Some(false)，无待判定中间态
    let wrong = service
        .submit_answer(&question.id, "B", None, None)
        .expect("auto-graded wrong submit");
    assert_eq!(wrong.is_correct, Some(false));
    let q = reload_question(&vfs_db, &question.id);
    assert_eq!((q.attempt_count, q.correct_count), (1, 0));
    assert_eq!(q.status, QuestionStatus::Review);

    // false → true（用户申诉判分错误）：+1、离开 review、method auto→manual
    service
        .regrade_submission(&question.id, &wrong.submission_id, true)
        .expect("regrade auto false→true");
    let q = reload_question(&vfs_db, &question.id);
    assert_eq!(q.correct_count, 1, "auto 起点的 false→true 也必须 +1");
    assert_eq!(q.status, QuestionStatus::InProgress);
    let submissions =
        VfsQuestionRepo::get_submissions(&vfs_db, &question.id, 50).expect("read submissions");
    assert_eq!(submissions.len(), 1, "改判不新插作答记录");
    assert_eq!(
        submissions[0].grading_method, "manual",
        "换判生效必须收敛 manual"
    );

    // true → false（再次换回）：-1、回 review、attempt 全程恒 1
    service
        .regrade_submission(&question.id, &wrong.submission_id, false)
        .expect("regrade auto true→false");
    let q = reload_question(&vfs_db, &question.id);
    assert_eq!(q.correct_count, 0, "true→false 必须 -1 且不为负");
    assert_eq!(q.status, QuestionStatus::Review);
    assert_eq!(q.attempt_count, 1, "改判永不递增 attempt_count");
    assert_eq!(submission_count(&vfs_db, &question.id), 1);
}

/// 同向幂等重放不得改写 grading_method（'auto' 保持 'auto'）、不得推进
/// RowSync：幂等短路发生在原语入口，任何列都不应被触碰。守护"确认判分"
/// 类 UI 重放不会把自动判分静默洗成人工判分。
#[test]
fn idempotent_regrade_of_auto_verdict_preserves_grading_method_and_rowsync() {
    let (_tmp, vfs_db) = create_vfs_db();
    let service = QuestionBankService::new(Arc::clone(&vfs_db));
    let exam_id = create_exam(&vfs_db, "auto-idempotent");
    let question = create_choice_question(&vfs_db, &exam_id, "q-auto-idem");

    let auto = service
        .submit_answer(&question.id, "A", None, None)
        .expect("auto-graded correct submit");
    assert_eq!(auto.is_correct, Some(true));
    let baseline_rowsync = submission_rowsync(&vfs_db, &auto.submission_id);

    // 同向改判（true → true）：零写入短路
    service
        .regrade_submission(&question.id, &auto.submission_id, true)
        .expect("idempotent regrade of auto verdict");

    let submissions =
        VfsQuestionRepo::get_submissions(&vfs_db, &question.id, 1).expect("read submission");
    assert_eq!(
        submissions[0].grading_method, "auto",
        "同向幂等不得把 auto 洗成 manual"
    );
    assert_eq!(
        submission_rowsync(&vfs_db, &auto.submission_id),
        baseline_rowsync,
        "同向幂等不得推进 RowSync 列"
    );
    let q = reload_question(&vfs_db, &question.id);
    assert_eq!((q.attempt_count, q.correct_count), (1, 1));
    assert_eq!(q.status, QuestionStatus::InProgress);
}

// ============================================================================
// R7 扩展：B→C 交接（AI 已判定的 submission 被人工换判）
// ============================================================================

/// B 路判定后的人工换判（"AI 判我对，但我其实错了"）必须与 C 路换判同契约：
/// true→false -1、状态回 review、grading_method 'ai' 收敛 'manual'、
/// 不新插记录、RowSync 推进。
///
/// B 路本体在本文件不可驱动（QbankGradingEmitter 强依赖 tauri Window，
/// 注册 harness=false 目标须改 Cargo.toml——产品文件，本轮禁改；详见
/// wave2-E-r7-04 §1）。此处以**落库终态种子**逼近：先经 pub API 走
/// NULL→true 改判（原语完成全部题目侧写入），再单列覆写 grading_method
/// 为 'ai'。因 B/C 共用 apply_submission_verdict_in_tx，两路对该行的写入
/// 仅 grading_method 字面量不同，故种子后的库面状态与真实 B 路
/// NULL→true 判分终态一致（旁证种子模式与 legacy 测试同源）。
#[test]
fn ai_decided_verdict_manual_flip_converges_to_manual_method() {
    let (_tmp, vfs_db) = create_vfs_db();
    let service = QuestionBankService::new(Arc::clone(&vfs_db));
    let exam_id = create_exam(&vfs_db, "ai-handoff");
    let question = create_subjective_question(&vfs_db, &exam_id, "q-ai-handoff");

    let pending = service
        .submit_answer(&question.id, "ai graded answer", None, None)
        .expect("pending submit");
    service
        .regrade_submission(&question.id, &pending.submission_id, true)
        .expect("decide NULL→true through the shared primitive");

    // 种子：把判定来源改写为 AI（等价于 B 路 persist 的落库终态，见 doc 注释）
    {
        let conn = vfs_db.get_conn_safe().expect("vfs connection");
        let updated = conn
            .execute(
                "UPDATE answer_submissions SET grading_method = 'ai' WHERE id = ?1",
                rusqlite::params![pending.submission_id],
            )
            .expect("seed ai grading_method");
        assert_eq!(updated, 1);
    }
    let (_, version_before) = submission_rowsync(&vfs_db, &pending.submission_id);

    // C 路换判：用户不认可 AI 的"对"，改为"错"
    let flipped = service
        .regrade_submission(&question.id, &pending.submission_id, false)
        .expect("manual flip of ai verdict");
    assert_eq!(flipped.is_correct, Some(false));

    let q = reload_question(&vfs_db, &question.id);
    assert_eq!(q.correct_count, 0, "ai 起点的 true→false 也必须 -1");
    assert_eq!(q.status, QuestionStatus::Review);
    assert_eq!(q.attempt_count, 1, "换判不递增 attempt_count");
    let submissions =
        VfsQuestionRepo::get_submissions(&vfs_db, &question.id, 50).expect("read submissions");
    assert_eq!(submissions.len(), 1, "换判不新插作答记录");
    assert_eq!(
        submissions[0].grading_method, "manual",
        "人工换判必须把 ai 收敛为 manual"
    );
    let (updated_at_after, version_after) = submission_rowsync(&vfs_db, &pending.submission_id);
    assert!(updated_at_after.is_some());
    assert_eq!(
        version_after,
        version_before + 1,
        "换判必须推进 local_version"
    );
}

// ============================================================================
// R7 扩展：MAX(0,·) 防负钳制（计数漂移的存量库）
// ============================================================================

/// correct_count 与 submission 判定失配的存量库（旧版本双计 bug 残留 / 外部
/// 导入）上做 true→false 换判，-1 必须被 MAX(0,·) 钳在 0，不得下穿为负。
/// 纯 pub 流程走不到该分支（判"对"必然先 +1），故用漂移种子构造前置。
#[test]
fn true_to_false_regrade_clamps_correct_count_at_zero() {
    let (_tmp, vfs_db) = create_vfs_db();
    let service = QuestionBankService::new(Arc::clone(&vfs_db));
    let exam_id = create_exam(&vfs_db, "clamp");
    let question = create_subjective_question(&vfs_db, &exam_id, "q-clamp");

    let pending = service
        .submit_answer(&question.id, "clamp answer", None, None)
        .expect("pending submit");
    service
        .regrade_submission(&question.id, &pending.submission_id, true)
        .expect("regrade NULL→true");
    let q = reload_question(&vfs_db, &question.id);
    assert_eq!(q.correct_count, 1, "前置：正常路径先 +1");

    // 漂移种子：题目级计数被外因清零，submission 仍是 Some(true)
    {
        let conn = vfs_db.get_conn_safe().expect("vfs connection");
        let updated = conn
            .execute(
                "UPDATE questions SET correct_count = 0 WHERE id = ?1",
                rusqlite::params![question.id],
            )
            .expect("seed drifted correct_count");
        assert_eq!(updated, 1);
    }

    let flipped = service
        .regrade_submission(&question.id, &pending.submission_id, false)
        .expect("regrade true→false on drifted counts");
    assert_eq!(flipped.is_correct, Some(false));
    let q = reload_question(&vfs_db, &question.id);
    assert_eq!(q.correct_count, 0, "MAX(0,·) 必须把 -1 钳在 0，不得为负");
    assert_eq!(q.status, QuestionStatus::Review);
}

// ============================================================================
// R7 扩展：C 路守卫（只许改判最近一次提交）的黑盒面
// ============================================================================

/// pub 入口守卫：改判过期提交 / 不存在的提交 / 零作答题目都必须报错，
/// 且失败路径不得留下任何计数副作用（守卫在事务内先于原语执行）。
/// in-crate 白盒已测守卫本身；这里锁 pub API 面的错误口径 + 无副作用。
#[test]
fn regrade_guard_rejects_stale_or_unknown_submission_without_side_effects() {
    let (_tmp, vfs_db) = create_vfs_db();
    let service = QuestionBankService::new(Arc::clone(&vfs_db));
    let exam_id = create_exam(&vfs_db, "guard");
    let question = create_choice_question(&vfs_db, &exam_id, "q-guard");

    // 两次真实作答：第一条提交沉淀为历史（stale）
    let first = service
        .submit_answer(&question.id, "A", None, None)
        .expect("first attempt");
    let second = service
        .submit_answer(&question.id, "B", None, None)
        .expect("second attempt");
    assert_ne!(first.submission_id, second.submission_id);
    let q_before = reload_question(&vfs_db, &question.id);
    assert_eq!((q_before.attempt_count, q_before.correct_count), (2, 1));

    // stale 提交：拒绝改判
    let stale = service
        .regrade_submission(&question.id, &first.submission_id, false)
        .expect_err("stale submission must be rejected");
    assert!(
        stale.message.contains("最近一次提交"),
        "错误信息应指向最近提交守卫，实际: {}",
        stale.message
    );

    // 不存在的 submission id：同一守卫拒绝
    service
        .regrade_submission(&question.id, "sub-does-not-exist", true)
        .expect_err("unknown submission must be rejected");

    // 零作答题目：无记录可改判
    let untouched = create_choice_question(&vfs_db, &exam_id, "q-guard-empty");
    let empty = service
        .regrade_submission(&untouched.id, "whatever", true)
        .expect_err("question without submissions must be rejected");
    assert!(
        empty.message.contains("没有作答记录"),
        "错误信息应说明无作答记录，实际: {}",
        empty.message
    );

    // 失败路径零副作用：计数、判定、方法、条数全部保持原样
    let q_after = reload_question(&vfs_db, &question.id);
    assert_eq!(
        (q_after.attempt_count, q_after.correct_count),
        (q_before.attempt_count, q_before.correct_count),
        "被拒绝的改判不得留下计数副作用"
    );
    let submissions =
        VfsQuestionRepo::get_submissions(&vfs_db, &question.id, 50).expect("read submissions");
    assert_eq!(submissions.len(), 2);
    // get_submissions 按时间倒序：[0]=最近(B, 错), [1]=历史(A, 对)
    assert_eq!(submissions[1].id, first.submission_id);
    assert_eq!(
        submissions[1].is_correct,
        Some(true),
        "stale 提交判定不得被改动"
    );
    assert_eq!(submissions[1].grading_method, "auto");
    assert_eq!(submissions[0].is_correct, Some(false));
}
