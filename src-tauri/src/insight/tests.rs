//! 阶段一验收测试：采集 → 确认 → 纠正（新 revision）→ 删除（墓碑传播）。

use super::service::InsightService;
use super::types::*;
use crate::vfs::database::setup_migrated_test_db;

fn sample_input() -> InsightDraftInput {
    InsightDraftInput {
        title: "导数结构识别 → 换元".to_string(),
        situation: "求 ∫ x(x²+1)³ dx".to_string(),
        stuck_point: "被积函数次数太高，展开不现实".to_string(),
        turning_point: "观察到 x 是 (x²+1) 导数的倍数".to_string(),
        rule: "识别被积函数中'一部分是另一部分导数'的结构 → 令其为 u".to_string(),
        validity_conditions: "复合函数内层导数与外因子成比例".to_string(),
        ownership: InsightOwnership::SelfReported,
        evidence: vec![InsightEvidenceInput {
            kind: EvidenceKind::ChatMessage,
            session_id: Some("sess_test".to_string()),
            message_id: Some("msg_1".to_string()),
            variant_id: None,
            block_id: None,
            text_start: Some(0),
            text_end: Some(12),
            speaker: Some("user".to_string()),
            resource_id: None,
            quote_snapshot: "我当时发现 x 恰好是 x²+1 的导数的一半".to_string(),
        }],
    }
}

#[test]
fn test_create_confirm_correct_delete_lifecycle() {
    let (_tmp, db) = setup_migrated_test_db();
    let svc = InsightService::new(std::sync::Arc::new(db));

    // 采集
    let card = svc.create_draft(sample_input()).expect("create draft");
    assert!(card.id.starts_with("ic_"));
    assert_eq!(card.ownership, InsightOwnership::SelfReported);
    assert_eq!(card.verification_state, VerificationState::Unverified);
    let rev1 = card.current_revision.expect("has revision");
    assert!(rev1.resource_id.is_some(), "正文快照应进 resources");
    assert!(rev1.turning_point.contains("导数"));

    // 证据可查
    let evidence = svc.list_evidence(&card.id).expect("list evidence");
    assert_eq!(evidence.len(), 1);
    assert_eq!(evidence[0].speaker.as_deref(), Some("user"));
    assert!(!evidence[0].quote_snapshot.is_empty());

    // 确认（附带编辑 → 新 revision）
    let confirmed = svc
        .confirm(
            &card.id,
            Some(InsightCorrectInput {
                title: None,
                situation: None,
                stuck_point: None,
                turning_point: None,
                rule: Some("识别反向链式结构 → 换元（无论外层是多项式还是三角函数）".to_string()),
                validity_conditions: None,
                edit_note: Some("确认时泛化规则".to_string()),
            }),
        )
        .expect("confirm");
    let rev2 = confirmed.current_revision.expect("has revision");
    assert_ne!(rev1.id, rev2.id, "编辑应产生新 revision");
    assert!(rev2.rule.contains("三角函数"));

    // 旧 revision 永远可查（可追溯）
    let revisions = svc.list_revisions(&card.id).expect("list revisions");
    assert_eq!(revisions.len(), 2);

    // 纠正再产生新 revision
    let corrected = svc
        .correct(
            &card.id,
            InsightCorrectInput {
                title: None,
                situation: None,
                stuck_point: None,
                turning_point: None,
                rule: None,
                validity_conditions: Some("内层导数与外因子成比例；三角函数外层同样适用".to_string()),
                edit_note: Some("补充边界".to_string()),
            },
        )
        .expect("correct");
    assert_eq!(
        svc.list_revisions(&card.id).expect("list").len(),
        3,
        "纠正应追加 revision"
    );
    assert!(corrected
        .current_revision
        .unwrap()
        .validity_conditions
        .contains("三角函数"));

    // 删除：墓碑传播，读路径不可见
    svc.delete(&card.id).expect("delete");
    assert!(svc.get_insight(&card.id).expect("get").is_none(), "删除后不可见");
    assert!(svc.list_insights(None, 100, 0).expect("list").is_empty());
}

#[test]
fn test_self_reported_without_user_evidence_downgraded() {
    let (_tmp, db) = setup_migrated_test_db();
    let svc = InsightService::new(std::sync::Arc::new(db));
    let mut input = sample_input();
    // AI 代笔：证据里 speaker 是 assistant
    input.evidence[0].speaker = Some("assistant".to_string());
    let card = svc.create_draft(input).expect("create");
    assert_eq!(
        card.ownership,
        InsightOwnership::Guided,
        "self_reported 但无用户发言证据必须降级"
    );
}

#[test]
fn test_validation_and_feedback() {
    let (_tmp, db) = setup_migrated_test_db();
    let svc = InsightService::new(std::sync::Arc::new(db));

    // 空标题拒绝
    let mut bad = sample_input();
    bad.title = "  ".to_string();
    assert!(svc.create_draft(bad).is_err());

    let card = svc.create_draft(sample_input()).expect("create");
    svc.record_feedback(&card.id, "useful", Some("sess_test")).expect("feedback");
    svc.record_feedback(&card.id, "not_applicable", None).expect("feedback2");
    assert!(svc.record_feedback(&card.id, "bogus", None).is_err());

    let after = svc.get_insight(&card.id).expect("get").expect("exists");
    assert_eq!(after.useful_count, 1);

    let events = svc.list_events(&card.id, 50).expect("events");
    // create(1) + useful(1) + not_applicable(1)
    assert_eq!(events.len(), 3);
    // 三本账分列：not_applicable 记质量账，useful 记收益账
    let na = events
        .iter()
        .find(|e| e.event_type == InsightEventType::FeedbackNotApplicable)
        .unwrap();
    assert_eq!(na.quality_signal, Some(0.0));
    assert_eq!(na.benefit_signal, None);
}

#[test]
fn test_relation_scope_required_for_contradict() {
    let (_tmp, db) = setup_migrated_test_db();
    let svc = InsightService::new(std::sync::Arc::new(db));
    let a = svc.create_draft(sample_input()).expect("a");
    let mut input_b = sample_input();
    input_b.title = "sqrt(x²) 的化简".to_string();
    let b = svc.create_draft(input_b).expect("b");

    // contradict 无 scope/evidence → 拒绝
    assert!(svc
        .add_relation(&a.id, &b.id, "contradict", None, None)
        .is_err());
    // 带 scope+evidence → 通过
    svc.add_relation(
        &a.id,
        &b.id,
        "contradict",
        Some("x<0 时"),
        Some("sqrt(x²)=|x| 而非 x"),
    )
    .expect("contradict with scope");

    let rels = svc.list_relations(&a.id).expect("relations");
    assert_eq!(rels.len(), 1);
    assert_eq!(rels[0].relation_type, RelationType::Contradict);
}

// ============================================================================
// 阶段二：召回 + 披露 + 幂等记账
// ============================================================================

#[test]
fn test_recall_fts_and_like_fallback() {
    let (_tmp, db) = setup_migrated_test_db();
    let db = std::sync::Arc::new(db);
    let svc = InsightService::new(db.clone());
    let card = svc.create_draft(sample_input()).expect("draft");
    svc.confirm(&card.id, None).expect("confirm");

    let recall = super::recall::InsightRecallService::new(db.clone());

    // FTS：>=3 字符中文短语命中（trigram 子串语义）
    let hits = recall.recall_fts("被积函数次数太高", 10).expect("fts");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].card.id, card.id);
    assert!(hits[0].confidence > 0.0);
    assert_eq!(hits[0].matched_via, "fts");

    // 无匹配 → 空（沉默分支由披露控制器记账）
    let none = recall.recall_fts("完全无关的量子引力", 10).expect("fts none");
    assert!(none.is_empty());

    // LIKE 回退：<3 字符查询
    let short = recall.recall_fts("换元", 10).expect("like fallback");
    assert_eq!(short.len(), 1, "短查询应走 LIKE 命中标题");
    assert_eq!(short[0].matched_via, "like");
}

#[test]
fn test_recall_skips_cold_and_deleted() {
    let (_tmp, db) = setup_migrated_test_db();
    let db = std::sync::Arc::new(db);
    let svc = InsightService::new(db.clone());
    let card = svc.create_draft(sample_input()).expect("draft");

    let recall = super::recall::InsightRecallService::new(db.clone());
    assert_eq!(recall.recall_fts("被积函数次数太高", 10).unwrap().len(), 1);

    // 删除（墓碑）后不再召回
    svc.delete(&card.id).expect("delete");
    assert!(recall.recall_fts("被积函数次数太高", 10).unwrap().is_empty());
}

#[test]
fn test_idempotent_event_and_mastery_write() {
    let (_tmp, db) = setup_migrated_test_db();
    let db = std::sync::Arc::new(db);
    let svc = InsightService::new(db.clone());
    let card = svc.create_draft(sample_input()).expect("draft");
    let conn = db.get_conn_safe().expect("conn");

    // 同一 (session, message, insight, type) 重复写入 → 只有一行
    for _ in 0..3 {
        super::recall::InsightRecallService::record_event_idempotent(
            &conn,
            Some("sess_1"),
            Some("msg_1"),
            Some(&card.id),
            InsightEventType::ShownExistence,
            DisclosureLevel::Existence,
            None,
        )
        .expect("idempotent event");
    }
    let events = svc.list_events(&card.id, 100).expect("events");
    let shown: Vec<_> = events
        .iter()
        .filter(|e| e.event_type == InsightEventType::ShownExistence)
        .collect();
    assert_eq!(shown.len(), 1, "重试/回放不得产生重复账本");

    // 沉默事件：insight_id 为 NULL 也可记账
    super::recall::InsightRecallService::record_event_idempotent(
        &conn,
        Some("sess_1"),
        Some("msg_2"),
        None,
        InsightEventType::SilenceNoMatch,
        DisclosureLevel::Hidden,
        None,
    )
    .expect("silence event");

    // mastery 证据：source='insight' 写入成功且幂等
    for _ in 0..2 {
        super::recall::InsightRecallService::record_recall_verdict_to_mastery(
            &conn, &card.id, "sess_1", true,
        )
        .expect("mastery write");
    }
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM mastery_events WHERE source = 'insight'",
            [],
            |r| r.get(0),
        )
        .expect("count");
    assert_eq!(count, 1, "mastery 幂等键去重");
}

// ============================================================================
// 阶段三：任务队列 + SRS 投影
// ============================================================================

fn setup_mistakes_db() -> (tempfile::TempDir, std::sync::Arc<crate::database::Database>) {
    use crate::data_governance::migration::{MigrationCoordinator, MISTAKES_MIGRATIONS};
    use crate::data_governance::schema_registry::DatabaseId;
    let temp_dir = tempfile::TempDir::new().expect("temp dir");
    let root = temp_dir.path().to_path_buf();
    let mut coordinator = MigrationCoordinator::new(root.clone()).with_audit_db(None);
    let report = coordinator
        .migrate_single(DatabaseId::Mistakes)
        .expect("migrate mistakes");
    assert_eq!(report.to_version, MISTAKES_MIGRATIONS.latest_version() as u32);
    let db = std::sync::Arc::new(
        crate::database::Database::new(&root.join("mistakes.db")).expect("open mistakes db"),
    );
    (temp_dir, db)
}

#[test]
fn test_job_queue_enqueue_dedupe_and_lease_recovery() {
    let (_tmp, db) = setup_migrated_test_db();
    let conn = db.get_conn_safe().expect("conn");

    // 幂等入队：同 dedupe_key 只排一次
    let first = super::jobs::enqueue_with_conn(&conn, "srs_projection", "srs:ic_x", "{}")
        .expect("enqueue");
    assert!(first.is_some());
    let dup = super::jobs::enqueue_with_conn(&conn, "srs_projection", "srs:ic_x", "{}")
        .expect("dup enqueue");
    assert!(dup.is_none(), "同键任务不得重复入队");

    // claim 后同键可再排（旧任务 running 不算"待处理"……不，running 也算；完成后再排）
    let claimed = super::jobs::claim_due_with_conn(&conn, "w1", 10).expect("claim");
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].1, "srs_projection");
    let still_dup = super::jobs::enqueue_with_conn(&conn, "srs_projection", "srs:ic_x", "{}")
        .expect("dup while running");
    assert!(still_dup.is_none(), "running 任务仍占住 dedupe 键");

    // 租约过期回收：把 leased_at 拨回过去模拟 worker 崩溃
    conn.execute(
        "UPDATE insight_jobs SET leased_at = datetime('now', '-1 hour') WHERE id = ?1",
        [&claimed[0].0],
    )
    .expect("age lease");
    let recovered = super::jobs::recover_stale_leases_with_conn(&conn).expect("recover");
    assert_eq!(recovered, 1);
    let reclaimed = super::jobs::claim_due_with_conn(&conn, "w2", 10).expect("reclaim");
    assert_eq!(reclaimed.len(), 1, "崩溃任务应被其他 worker 回收");

    // 完成 → 同键可再排新任务
    super::jobs::complete_with_conn(&conn, &reclaimed[0].0).expect("complete");
    let again = super::jobs::enqueue_with_conn(&conn, "srs_projection", "srs:ic_x", "{}")
        .expect("re-enqueue after done");
    assert!(again.is_some());

    // 失败退避：attempt 达到上限后转 error
    let job = again.unwrap();
    let c2 = super::jobs::claim_due_with_conn(&conn, "w1", 10).expect("claim2");
    assert_eq!(c2.len(), 1);
    for _ in 0..3 {
        super::jobs::fail_with_conn(&conn, &job, "boom").expect("fail");
        // 拉到到期时间使其可立即再 claim
        conn.execute(
            "UPDATE insight_jobs SET next_attempt_at = NULL WHERE id = ?1",
            [&job],
        )
        .expect("force due");
        let _ = super::jobs::claim_due_with_conn(&conn, "w1", 10).expect("re-claim");
    }
    let status: String = conn
        .query_row(
            "SELECT status FROM insight_jobs WHERE id = ?1",
            [&job],
            |r| r.get(0),
        )
        .expect("status");
    assert_eq!(status, "error", "超过 max_attempts 应转 error 不再重试");
}

#[test]
fn test_srs_projection_materialize_and_regenerate() {
    let (_tmp, db) = setup_migrated_test_db();
    let db = std::sync::Arc::new(db);
    let (_mtmp, mistakes) = setup_mistakes_db();
    let svc = InsightService::new(db.clone());

    let card = svc.create_draft(sample_input()).expect("draft");
    svc.confirm(&card.id, None).expect("confirm"); // confirm 钩子已入队 srs_projection

    let worker = super::jobs::InsightJobWorker::new(db.clone(), Some(mistakes.clone()));
    let processed = worker.run_once(10, &|| true).expect("run");
    assert_eq!(processed, 2, "confirm 入队 srs_projection + merge_proposal 两个任务");

    // 物化卡存在且带回链（注意：mconn 是用例级互斥锁守卫，用完立即 drop——
    // 持锁跨 run_once 会与 worker 内部的 get_conn_safe 死锁）
    {
        let mconn = mistakes.get_conn_safe().expect("mconn");
        let (front, back, st, sid): (String, String, String, String) = mconn
            .query_row(
                "SELECT front, back, source_type, source_id FROM anki_cards WHERE id = ?1",
                [format!("ac_insight_{}", card.id)],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .expect("projected card");
        assert!(front.contains("导数结构识别"));
        assert!(back.contains("导数"), "back={back}");
        assert_eq!(st, "inspiration");
        assert_eq!(sid, card.id);
    }

    // 源卡修订 → 重跑投影 → 内容原地更新（卡 id 不变，FSRS 状态保留）
    svc.correct(
        &card.id,
        InsightCorrectInput {
            title: None,
            situation: None,
            stuck_point: None,
            turning_point: None,
            rule: Some("修订后的规则：先看导数结构再换元".to_string()),
            validity_conditions: None,
            edit_note: Some("test".to_string()),
        },
    )
    .expect("correct");
    let processed2 = worker.run_once(10, &|| true).expect("run2");
    assert_eq!(processed2, 1, "correct 应重排投影任务");
    let back2: String = {
        let mconn = mistakes.get_conn_safe().expect("mconn");
        mconn
            .query_row(
                "SELECT back FROM anki_cards WHERE id = ?1",
                [format!("ac_insight_{}", card.id)],
                |r| r.get(0),
            )
            .expect("regenerated")
    };
    assert!(back2.contains("修订后的规则"), "投影应随修订重生成");

    // 源卡删除 → 投影墓碑传播
    svc.delete(&card.id).expect("delete");
    super::jobs::enqueue(
        &db,
        "srs_projection",
        &format!("srs:{}", card.id),
        &serde_json::json!({ "insight_id": card.id }).to_string(),
    )
    .expect("enqueue tombstone propagation");
    worker.run_once(10, &|| true).expect("run3");
    let deleted: Option<String> = {
        let mconn = mistakes.get_conn_safe().expect("mconn");
        mconn
            .query_row(
                "SELECT deleted_at FROM anki_cards WHERE id = ?1",
                [format!("ac_insight_{}", card.id)],
                |r| r.get(0),
            )
            .expect("tombstone")
    };
    assert!(deleted.is_some(), "源卡删除后投影卡应打墓碑");
}

// ============================================================================
// 阶段三：合并提案 / 原则卡合成 / 原则复审
// ============================================================================

fn make_card(svc: &InsightService, title: &str, rule: &str) -> super::types::InsightCard {
    let card = svc
        .create_draft(InsightDraftInput {
            title: title.to_string(),
            situation: "某题情境".to_string(),
            stuck_point: "某卡点".to_string(),
            turning_point: "某转折".to_string(),
            rule: rule.to_string(),
            validity_conditions: "某条件".to_string(),
            ownership: InsightOwnership::SelfReported,
            evidence: vec![InsightEvidenceInput {
                kind: EvidenceKind::Manual,
                session_id: None,
                message_id: None,
                variant_id: None,
                block_id: None,
                text_start: None,
                text_end: None,
                speaker: Some("user".to_string()),
                resource_id: None,
                quote_snapshot: "手动记录".to_string(),
            }],
        })
        .expect("draft");
    svc.confirm(&card.id, None).expect("confirm")
}

#[test]
fn test_merge_proposal_creates_deduped_todo() {
    let (_tmp, db) = setup_migrated_test_db();
    let db = std::sync::Arc::new(db);
    let svc = InsightService::new(db.clone());

    // 两张标题高度相似的卡（trigram 子串命中）
    let a = make_card(&svc, "导数结构识别换元法", "规则A：识别导数结构");
    let b = make_card(&svc, "导数结构识别换元法进阶", "规则B：识别导数结构");

    let worker = super::jobs::InsightJobWorker::new(db.clone(), None);
    let processed = worker.run_once(20, &|| true).expect("run");
    assert!(processed >= 2, "confirm 入队的 srs+merge 任务应被处理");

    // 合并提案待办存在且幂等（重跑不重复建）
    let conn = db.get_conn_safe().expect("conn");
    let count_todos = |c: &rusqlite::Connection| -> i64 {
        c.query_row(
            "SELECT COUNT(*) FROM todo_items
             WHERE status='pending' AND deleted_at IS NULL
               AND description LIKE '%insight-merge:%'",
            [],
            |r| r.get(0),
        )
        .expect("count")
    };
    let n1 = count_todos(&conn);
    assert!(n1 >= 1, "应生成合并提案待办（a={} b={}）", a.id, b.id);
    worker.run_once(20, &|| true).expect("run2");
    // 重跑后不得新增同 marker 待办（任务已 done 不再执行，但即使重放也幂等）
    assert_eq!(count_todos(&conn), n1);

    // 待办挂在"灵感演化"列表且带附件回链
    let list: String = conn
        .query_row(
            "SELECT t.title FROM todo_lists t
             JOIN todo_items i ON i.todo_list_id = t.id
             WHERE i.description LIKE '%insight-merge:%' LIMIT 1",
            [],
            |r| r.get(0),
        )
        .expect("list");
    assert_eq!(list, "灵感演化");
    let att: String = conn
        .query_row(
            "SELECT attachments_json FROM todo_items
             WHERE description LIKE '%insight-merge:%' LIMIT 1",
            [],
            |r| r.get(0),
        )
        .expect("attachments");
    assert!(att.contains("res_") || att.contains("\"r"), "附件应回链资源: {att}");
}

#[test]
fn test_principle_synthesis_requires_cases_and_counterexample() {
    let (_tmp, db) = setup_migrated_test_db();
    let db = std::sync::Arc::new(db);
    let svc = InsightService::new(db.clone());

    let a = make_card(&svc, "换元法案例一", "规则一");
    let b = make_card(&svc, "换元法案例二", "规则二");
    let c = make_card(&svc, "换元法反例卡", "规则三");

    // 只有 same_method、无反例 → 不合成
    svc.add_relation(&a.id, &b.id, "same_method", None, None).expect("rel ab");
    let worker = super::jobs::InsightJobWorker::new(db.clone(), None);
    worker.run_once(20, &|| true).expect("run1");
    let conn = db.get_conn_safe().expect("conn");
    let principle_todos = |c_: &rusqlite::Connection| -> i64 {
        c_.query_row(
            "SELECT COUNT(*) FROM todo_items
             WHERE status='pending' AND deleted_at IS NULL
               AND description LIKE '%insight-principle:%'",
            [],
            |r| r.get(0),
        )
        .expect("count")
    };
    assert_eq!(principle_todos(&conn), 0, "缺反例不得合成原则提案");

    // 补上反例边 → 合成
    svc.add_relation(&a.id, &c.id, "counterexample", None, None).expect("rel ac");
    worker.run_once(20, &|| true).expect("run2");
    assert_eq!(principle_todos(&conn), 1, "≥2 案例 + 1 反例 → 一条原则化提案");

    // 幂等：重跑不重复
    super::jobs::enqueue(
        &db,
        "principle_synthesis",
        &format!("principle:{}", a.id),
        &serde_json::json!({ "insight_id": a.id }).to_string(),
    )
    .expect("re-enqueue");
    worker.run_once(20, &|| true).expect("run3");
    assert_eq!(principle_todos(&conn), 1);
}

#[test]
fn test_principle_review_todo_on_source_correction() {
    let (_tmp, db) = setup_migrated_test_db();
    let db = std::sync::Arc::new(db);
    let svc = InsightService::new(db.clone());

    let case = make_card(&svc, "案例卡", "案例规则");
    let principle = make_card(&svc, "原则卡", "原则规则");
    // 原则卡以案例卡为证据（abstract_of：from=原则 → to=案例/证据方）
    svc.add_relation(&principle.id, &case.id, "abstract_of", None, None)
        .expect("abstract_of");

    // 源卡更正 → correct() 标记派生关系复审 + 入队 principle_review
    svc.correct(
        &case.id,
        InsightCorrectInput {
            title: None,
            situation: None,
            stuck_point: None,
            turning_point: None,
            rule: Some("更正后的案例规则".to_string()),
            validity_conditions: None,
            edit_note: None,
        },
    )
    .expect("correct");

    let worker = super::jobs::InsightJobWorker::new(db.clone(), None);
    worker.run_once(20, &|| true).expect("run");

    let conn = db.get_conn_safe().expect("conn");
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM todo_items
             WHERE status='pending' AND deleted_at IS NULL
               AND description LIKE '%insight-review:%'",
            [],
            |r| r.get(0),
        )
        .expect("count");
    assert_eq!(n, 1, "源卡更正应生成派生原则复审待办");
}

// ============================================================================
// 阶段四：自适应（效用校准 / 跨簇类比 / 内化降权）
// ============================================================================

#[test]
fn test_internalization_discount_bounds() {
    use super::disclosure::internalization_discount as d;
    assert_eq!(d(0, 0, 0), 1.0);
    assert_eq!(d(4, 10, 10), 1.0, "回忆次数不足不降权");
    assert_eq!(d(10, 10, 2), 1.0, "有用率低（内化存疑）不降权");
    let f5 = d(5, 10, 9);
    let f15 = d(15, 20, 18);
    assert!(f5 < 1.0 && f5 > f15, "降权随内化程度加深: {f5} vs {f15}");
    assert!(f15 >= 0.3, "降权有下限，永不永久消失");
}

#[test]
fn test_calibrate_policy_from_ledger() {
    let (_tmp, db) = setup_migrated_test_db();
    let conn = db.get_conn_safe().expect("conn");
    let default = super::disclosure::DisclosurePolicy::default();

    // 样本不足 → 不动
    let p = super::disclosure::calibrate_policy_from_ledger(&conn, default);
    assert!((p.min_confidence - default.min_confidence).abs() < 1e-9);

    // 注入高有用率账本（20 次展示 16 次有用）→ 阈值降低
    let svc = InsightService::new(std::sync::Arc::new(db));
    let card = svc.create_draft(sample_input()).expect("draft");
    for i in 0..20 {
        super::recall::InsightRecallService::record_event_idempotent(
            &conn,
            Some("sess_cal"),
            Some(&format!("msg_{i}")),
            Some(&card.id),
            InsightEventType::ShownExistence,
            DisclosureLevel::Existence,
            None,
        )
        .expect("shown");
    }
    for i in 0..16 {
        super::recall::InsightRecallService::record_event_idempotent(
            &conn,
            Some("sess_cal"),
            Some(&format!("fb_{i}")),
            Some(&card.id),
            InsightEventType::FeedbackUseful,
            DisclosureLevel::Hidden,
            None,
        )
        .expect("useful");
    }
    let p2 = super::disclosure::calibrate_policy_from_ledger(&conn, default);
    assert!(
        p2.min_confidence < default.min_confidence,
        "高有用率应降低阈值: {} vs {}",
        p2.min_confidence,
        default.min_confidence
    );
    assert!(p2.min_confidence >= 0.15, "校准有下界");
}

#[test]
fn test_cross_cluster_analogy_expansion() {
    let (_tmp, db) = setup_migrated_test_db();
    let db = std::sync::Arc::new(db);
    let svc = InsightService::new(db.clone());

    let direct = make_card(&svc, "导数结构识别换元", "识别导数结构换元");
    // 间接卡：内容与查询不直接匹配，但与直接命中卡有 same_method 边
    let mut indirect_input = sample_input();
    indirect_input.title = "分部积分选型".to_string();
    indirect_input.rule = "反对幂指三顺序选型".to_string();
    indirect_input.turning_point = "降次优先".to_string();
    indirect_input.situation = "乘积积分".to_string();
    indirect_input.stuck_point = "不知谁当 u".to_string();
    let indirect = svc.create_draft(indirect_input).expect("draft2");
    svc.confirm(&indirect.id, None).expect("confirm2");
    svc.add_relation(&direct.id, &indirect.id, "same_method", None, None)
        .expect("rel");

    let recall = super::recall::InsightRecallService::new(db.clone());
    let conn = db.get_conn_safe().expect("conn");
    let hits = recall.recall_fts("导数结构识别", 5).expect("fts");
    assert_eq!(hits.len(), 1, "间接卡不应被 FTS 直接命中");

    let expanded =
        super::recall::InsightRecallService::expand_via_relations_with_conn(&conn, &hits, 2)
            .expect("expand");
    assert_eq!(expanded.len(), 1, "same_method 邻居应作为间接候选");
    assert_eq!(expanded[0].card.id, indirect.id);
    assert_eq!(expanded[0].matched_via, "relation");
    assert!(
        expanded[0].confidence < hits[0].confidence,
        "间接候选置信应低于直接命中"
    );
}
