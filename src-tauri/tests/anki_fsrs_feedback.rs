//! FSRS 复习数据回流集成测试（Round 3 #5）
//!
//! 覆盖真实 SQLite 路径：迁移建库 → 入队卡片 → 制造 lapse →
//! `list_feedback_rows` 只读查询 → `build_feedback_injection` 编排（含空库降级）。

use std::sync::Arc;

use deep_student_lib::anki_fsrs_feedback::{
    build_feedback_injection, build_user_review_profile, FsrsFeedbackConfig,
};
use deep_student_lib::data_governance::migration::coordinator::MigrationCoordinator;
use deep_student_lib::data_governance::schema_registry::DatabaseId;
use deep_student_lib::database::Database;
use deep_student_lib::fsrs_review_service::FsrsReviewService;
use rusqlite::params;
use tempfile::TempDir;

fn setup_db() -> (TempDir, Arc<Database>) {
    let temp_dir = TempDir::new().expect("create temp dir");
    let root = temp_dir.path().to_path_buf();
    let mut coordinator = MigrationCoordinator::new(root.clone()).with_audit_db(None);
    coordinator
        .migrate_single(DatabaseId::Mistakes)
        .expect("migrate mistakes database");
    let db = Arc::new(Database::new(&root.join("mistakes.db")).expect("open mistakes db"));
    (temp_dir, db)
}

fn insert_card(db: &Database, task_id: &str, card_id: &str, front: &str, tags_json: &str) {
    let conn = db.get_conn_safe().expect("conn");
    conn.execute(
        "INSERT OR IGNORE INTO document_tasks (
            id, document_id, original_document_name, segment_index,
            content_segment, status, anki_generation_options_json
         ) VALUES (?1, 'doc-feedback', 'test.md', 0, 'segment', 'Completed', '{}')",
        params![task_id],
    )
    .expect("insert task");
    conn.execute(
        "INSERT INTO anki_cards (id, task_id, front, back, tags_json, source_type, source_id)
         VALUES (?1, ?2, ?3, 'back', ?4, 'document', 'doc-feedback')",
        params![card_id, task_id, front, tags_json],
    )
    .expect("insert card");
}

/// 入队后直接改写调度状态，模拟"复习过且多次遗忘"的卡。
fn make_lapsed(db: &Database, card_id: &str, lapses: i32, due_ms: i64) {
    let conn = db.get_conn_safe().expect("conn");
    let updated = conn
        .execute(
            "UPDATE fsrs_card_states
             SET lapses = ?1, reps = ?2, state = 2, stability = 3.0,
                 last_review_ms = 1000, due_ms = ?3
             WHERE anki_card_id = ?4",
            params![lapses, lapses + 2, due_ms, card_id],
        )
        .expect("update state");
    assert_eq!(updated, 1, "card state must exist for {card_id}");
}

#[test]
fn empty_library_degrades_to_no_injection() {
    let (_tmp, db) = setup_db();
    let cfg = FsrsFeedbackConfig::default();
    assert_eq!(build_feedback_injection(&db, "任意文档内容", &cfg), None);
    let profile = build_user_review_profile(&db, &cfg);
    assert!(profile.is_empty());
    assert_eq!(profile.total_cards, 0);
}

#[test]
fn list_feedback_rows_orders_by_lapses_and_respects_limit() {
    let (_tmp, db) = setup_db();
    insert_card(&db, "t1", "card-a", "牛顿第一定律的内容？", "[\"力学\"]");
    insert_card(&db, "t1", "card-b", "牛顿第二定律的表达式？", "[\"力学\"]");
    insert_card(&db, "t1", "card-c", "牛顿第三定律的内容？", "[\"力学\"]");
    let service = FsrsReviewService::new(db.clone());
    service
        .enqueue_cards(&[
            "card-a".to_string(),
            "card-b".to_string(),
            "card-c".to_string(),
        ])
        .expect("enqueue");
    make_lapsed(&db, "card-a", 2, 0);
    make_lapsed(&db, "card-b", 7, 0);
    make_lapsed(&db, "card-c", 4, 0);

    let rows = service.list_feedback_rows(100).expect("rows");
    assert_eq!(rows.len(), 3);
    let ids: Vec<&str> = rows.iter().map(|r| r.anki_card_id.as_str()).collect();
    assert_eq!(ids, vec!["card-b", "card-c", "card-a"], "按 lapses 降序");
    assert_eq!(rows[0].lapses, 7);
    assert_eq!(rows[0].tags, vec!["力学".to_string()]);
    assert!(rows[0].stability.is_some());

    // limit 生效
    let limited = service.list_feedback_rows(2).expect("limited rows");
    assert_eq!(limited.len(), 2);
    assert_eq!(limited[0].anki_card_id, "card-b");
}

#[test]
fn injection_contains_profile_and_interference_sections() {
    let (_tmp, db) = setup_db();
    insert_card(
        &db,
        "t1",
        "card-hi",
        "牛顿第二定律的表达式是什么？",
        "[\"力学\",\"牛顿定律\"]",
    );
    insert_card(
        &db,
        "t1",
        "card-hi2",
        "牛顿第二定律的适用条件？",
        "[\"力学\",\"牛顿定律\"]",
    );
    insert_card(&db, "t1", "card-far", "光合作用发生在哪里？", "[\"生物\"]");
    let service = FsrsReviewService::new(db.clone());
    service
        .enqueue_cards(&[
            "card-hi".to_string(),
            "card-hi2".to_string(),
            "card-far".to_string(),
        ])
        .expect("enqueue");
    make_lapsed(&db, "card-hi", 6, 0);
    make_lapsed(&db, "card-hi2", 4, 0);
    // card-far 保持 New（无 lapse）

    // 默认配置（0824 隐私收口）：只注入匿名聚合画像，
    // 不注入历史卡片原文（高遗忘卡示例 / 干扰预警），也不再声称「仅本地/不上传」。
    let cfg = FsrsFeedbackConfig::default();
    let injected = build_feedback_injection(&db, "本章系统讲解牛顿第二定律及其应用", &cfg)
        .expect("should inject");
    assert!(injected.contains("用户复习画像"), "{injected}");
    assert!(injected.contains("易混淆标签"));
    assert!(
        !injected.contains("数据仅本地"),
        "虚假承诺必须删除: {injected}"
    );
    assert!(!injected.contains("不上传"), "虚假承诺必须删除: {injected}");
    assert!(
        !injected.contains("同批次语义干扰预警"),
        "默认不得注入卡片原文: {injected}"
    );
    assert!(
        !injected.contains("牛顿第二定律的表达式是什么？"),
        "默认不得注入卡片原文: {injected}"
    );

    // 显式开启 include_card_excerpts 后才注入卡片摘要与干扰预警
    let opted_in = FsrsFeedbackConfig {
        include_card_excerpts: true,
        ..FsrsFeedbackConfig::default()
    };
    let full = build_feedback_injection(&db, "本章系统讲解牛顿第二定律及其应用", &opted_in)
        .expect("should inject");
    // 干扰 section：主题相近的高 lapse 卡入选，不相近的不入选
    assert!(full.contains("同批次语义干扰预警"));
    assert!(full.contains("牛顿第二定律的表达式是什么？"));
    assert!(!full.contains("光合作用"));
    // 不泄露答案内容（只注入 front 摘要）
    assert!(!full.contains("back"));
}

#[test]
fn unrelated_document_still_gets_profile_without_interference() {
    let (_tmp, db) = setup_db();
    insert_card(
        &db,
        "t1",
        "card-x",
        "细胞呼吸的三个阶段？",
        "[\"生物\",\"代谢\"]",
    );
    insert_card(
        &db,
        "t1",
        "card-y",
        "细胞呼吸的场所？",
        "[\"生物\",\"代谢\"]",
    );
    let service = FsrsReviewService::new(db.clone());
    service
        .enqueue_cards(&["card-x".to_string(), "card-y".to_string()])
        .expect("enqueue");
    make_lapsed(&db, "card-x", 5, 0);
    make_lapsed(&db, "card-y", 3, 0);

    // 显式开启摘要外送，验证的是「无关键词重叠」这一层过滤（而非隐私开关）。
    let cfg = FsrsFeedbackConfig {
        include_card_excerpts: true,
        ..FsrsFeedbackConfig::default()
    };
    let injected = build_feedback_injection(&db, "French Revolution timeline and causes", &cfg)
        .expect("profile still injected");
    assert!(injected.contains("用户复习画像"));
    assert!(
        !injected.contains("同批次语义干扰预警"),
        "无关键词重叠时不应有干扰 section: {injected}"
    );
}

#[test]
fn profile_reflects_due_and_lapse_aggregates() {
    let (_tmp, db) = setup_db();
    insert_card(&db, "t1", "card-1", "问题一？", "[\"标签甲\"]");
    insert_card(&db, "t1", "card-2", "问题二？", "[\"标签甲\"]");
    let service = FsrsReviewService::new(db.clone());
    service
        .enqueue_cards(&["card-1".to_string(), "card-2".to_string()])
        .expect("enqueue");
    // card-1 已到期且高 lapse；card-2 未来到期
    make_lapsed(&db, "card-1", 8, 0);
    make_lapsed(&db, "card-2", 2, i64::MAX / 2);

    let cfg = FsrsFeedbackConfig::default();
    let profile = build_user_review_profile(&db, &cfg);
    assert_eq!(profile.total_cards, 2);
    assert_eq!(profile.reviewed_cards, 2);
    assert_eq!(profile.due_cards, 1);
    assert!(profile.avg_retrievability.is_some());
    // 标签甲：2 卡 / 10 次遗忘 → 易混淆标签
    assert_eq!(profile.confusable_tags.len(), 1);
    assert_eq!(profile.confusable_tags[0].tag, "标签甲");
    assert_eq!(profile.confusable_tags[0].total_lapses, 10);
    // basic 模板聚合
    assert_eq!(profile.high_lapse_templates.len(), 1);
    assert_eq!(profile.high_lapse_templates[0].template_id, "basic");
    assert_eq!(profile.high_lapse_templates[0].due_cards, 1);
}
