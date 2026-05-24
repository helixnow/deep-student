//! 更深层的集成测试
//!
//! 覆盖业界公认但前几轮测试未充分验证的难点：
//!
//! 1. **HLC 集成**：用 HLC 字符串做 updated_at 时同步行为
//! 2. **因果一致性**：同一端的两次连续写入在另一端必须按因果序应用
//! 3. **部分失败恢复**：多批次中某批失败，后续重试必须幂等
//! 4. **设备重启后状态恢复**：HLC 状态持久化 + 从最后一条记录反推
//! 5. **Jepsen 风格不变量**：随机化场景下全局不变量保持

use deep_student_lib::data_governance::sync::{
    compare_hlc_strings, ChangeOperation, Hlc, HlcClock, SyncChangeWithData, SyncManager,
};
use rusqlite::{params, Connection};
use serde_json::json;
use std::cmp::Ordering;

fn new_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE items (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '',
            counter INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
        );
        CREATE TABLE __change_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            operation TEXT NOT NULL,
            changed_at TEXT NOT NULL DEFAULT (datetime('now')),
            sync_version INTEGER DEFAULT 0
        );
        CREATE TRIGGER trg_ins AFTER INSERT ON items BEGIN
            INSERT INTO __change_log (table_name, record_id, operation, changed_at)
            VALUES ('items', NEW.id, 'INSERT', NEW.updated_at);
        END;
        CREATE TRIGGER trg_upd AFTER UPDATE ON items BEGIN
            INSERT INTO __change_log (table_name, record_id, operation, changed_at)
            VALUES ('items', NEW.id, 'UPDATE', NEW.updated_at);
        END;
        CREATE TABLE refinery_schema_history (version INTEGER PRIMARY KEY, applied_on TEXT);
        INSERT INTO refinery_schema_history VALUES (1, datetime('now'));
        "#,
    )
    .unwrap();
    conn
}

fn get_title(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row("SELECT title FROM items WHERE id = ?1", params![id], |r| {
        r.get(0)
    })
    .ok()
}

// ============================================================================
// HLC 集成：HLC 字符串作为 updated_at
// ============================================================================

/// **I.01** 用 HLC 字符串比较两个 UPSERT 的顺序
#[test]
fn hlc_string_lww_ordering() {
    assert_eq!(
        compare_hlc_strings("000000000001000-00000", "000000000002000-00000"),
        Ordering::Less
    );
    assert_eq!(
        compare_hlc_strings("000000000001000-00005", "000000000001000-00003"),
        Ordering::Greater
    );
    // 非 HLC 格式回退到字符串比较
    assert_eq!(compare_hlc_strings("garbage", "garbage"), Ordering::Equal);
}

/// **I.02** HLC 时钟在合法使用场景下能正确推进
#[test]
fn hlc_clock_progression_is_monotonic() {
    let clock = HlcClock::new();
    let mut last = Hlc::ZERO;
    for i in 0..100 {
        let h = clock.tick_with_now(1000 + i / 10).unwrap();
        assert!(h > last, "HLC 必须单调递增: last={:?}, new={:?}", last, h);
        last = h;
    }
}

/// **I.03** HLC 漂移保护：不允许接收"未来超过 60s"的远端 HLC
#[test]
fn hlc_rejects_far_future_remote() {
    let clock = HlcClock::new();
    let now = 1_700_000_000_000u64;
    // 远端声称的时间比本地 wall clock 晚 2 分钟（超出 60s 阈值）
    let malicious = Hlc::new(now + 120_000, 0);
    let r = clock.receive_with_now(malicious, now);
    assert!(r.is_err());
}

/// **I.04** 从最后一条记录反推 HLC 的启动恢复
#[test]
fn hlc_recovers_from_persisted_state() {
    // 模拟：应用重启，从 DB 里最大 updated_at 反推 HLC
    let last_seen = Hlc::new(1_700_000_000_500, 42);
    let clock = HlcClock::from_last(last_seen);

    // 新事件必须严格晚于 last_seen
    let now_close = 1_700_000_000_500u64; // 与 last_seen 同一毫秒
    let new = clock.tick_with_now(now_close).unwrap();
    assert!(new > last_seen);
    assert_eq!(new, Hlc::new(1_700_000_000_500, 43)); // counter 递增
}

// ============================================================================
// 因果一致性：一端的两次连续写入在另一端必须按序应用
// ============================================================================

/// **I.05** 因果保序：A 发出 x1, x2（x2 依赖 x1 的 HLC），B 收到后必须 x1 在 x2 之前应用
#[test]
fn causal_order_preserved_across_devices() {
    let a = HlcClock::new();
    let b = HlcClock::new();

    let now = 1_700_000_000_000u64;

    // A 写 x1
    let x1 = a.tick_with_now(now).unwrap();
    // A 写 x2（依赖 x1）
    let x2 = a.tick_with_now(now).unwrap(); // 同一 ms → counter 递增

    assert!(x1 < x2);

    // B 收 x1
    b.receive_with_now(x1, now + 10).unwrap();
    // B 收 x2
    b.receive_with_now(x2, now + 20).unwrap();

    // B 的 HLC 现在必须 >= x2
    assert!(b.peek() >= x2);

    // 关键：B 用 HLC 字符串排序两条 change 时，x1 必须在 x2 前
    let x1_str = x1.to_string();
    let x2_str = x2.to_string();
    assert_eq!(
        compare_hlc_strings(&x1_str, &x2_str),
        Ordering::Less,
        "HLC 字符串必须保持因果序"
    );
}

/// **I.06** 即使 B 先收到 x2 再收到 x1（乱序抵达），应用到 DB 时按 HLC 排序仍恢复因果
#[test]
fn out_of_order_delivery_rerordered_by_hlc() {
    let conn = new_db();

    let hlc_1 = Hlc::new(1_700_000_000_000, 0).to_string();
    let hlc_2 = Hlc::new(1_700_000_000_000, 1).to_string();
    let hlc_3 = Hlc::new(1_700_000_000_000, 2).to_string();

    // 写入 3 个 change，故意用乱序（c3, c1, c2）投递
    let c1 = SyncChangeWithData {
        table_name: "items".into(),
        record_id: "n1".into(),
        operation: ChangeOperation::Insert,
        data: Some(json!({
            "id": "n1", "title": "v1", "counter": 1,
            "updated_at": hlc_1.clone(),
            "deleted_at": serde_json::Value::Null,
        })),
        changed_at: hlc_1.clone(),
        change_log_id: None,
        database_name: Some("test".into()),
        suppress_change_log: Some(true),
    };
    let c2 = SyncChangeWithData {
        table_name: "items".into(),
        record_id: "n1".into(),
        operation: ChangeOperation::Update,
        data: Some(json!({
            "id": "n1", "title": "v2", "counter": 2,
            "updated_at": hlc_2.clone(),
            "deleted_at": serde_json::Value::Null,
        })),
        changed_at: hlc_2.clone(),
        change_log_id: None,
        database_name: Some("test".into()),
        suppress_change_log: Some(true),
    };
    let c3 = SyncChangeWithData {
        table_name: "items".into(),
        record_id: "n1".into(),
        operation: ChangeOperation::Update,
        data: Some(json!({
            "id": "n1", "title": "v3", "counter": 3,
            "updated_at": hlc_3.clone(),
            "deleted_at": serde_json::Value::Null,
        })),
        changed_at: hlc_3,
        change_log_id: None,
        database_name: Some("test".into()),
        suppress_change_log: Some(true),
    };

    // 模拟：下载端已按 HLC 排序后投递
    // （在真实系统里 download_changes 会先排序）
    let mut sorted = vec![c3.clone(), c1.clone(), c2.clone()];
    sorted.sort_by(|a, b| a.changed_at.cmp(&b.changed_at));
    SyncManager::apply_downloaded_changes(&conn, &sorted, None).unwrap();

    // 最终应是 v3
    assert_eq!(get_title(&conn, "n1").as_deref(), Some("v3"));
}

// ============================================================================
// 部分失败恢复
// ============================================================================

/// **I.07** 第一批失败，第二批重试必须幂等
#[test]
fn partial_failure_retry_is_idempotent() {
    let conn = new_db();

    let now = chrono::Utc::now().to_rfc3339();
    let c1 = SyncChangeWithData {
        table_name: "items".into(),
        record_id: "n1".into(),
        operation: ChangeOperation::Insert,
        data: Some(json!({
            "id": "n1", "title": "v1",
            "updated_at": now.clone(),
            "deleted_at": serde_json::Value::Null,
        })),
        changed_at: now.clone(),
        change_log_id: None,
        database_name: Some("test".into()),
        suppress_change_log: Some(true),
    };
    let bad = SyncChangeWithData {
        table_name: "nonexistent".into(),
        record_id: "x".into(),
        operation: ChangeOperation::Insert,
        data: Some(json!({"id": "x"})),
        changed_at: now.clone(),
        change_log_id: None,
        database_name: None,
        suppress_change_log: Some(true),
    };

    // 第一次尝试：含非法 → 全部回滚
    let r = SyncManager::apply_downloaded_changes(&conn, &[c1.clone(), bad], None);
    assert!(r.is_err());
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0);

    // 第二次重试：去掉非法条目
    SyncManager::apply_downloaded_changes(&conn, &[c1.clone()], None).unwrap();
    assert_eq!(get_title(&conn, "n1").as_deref(), Some("v1"));

    // 第三次再重试：幂等
    SyncManager::apply_downloaded_changes(&conn, &[c1], None).unwrap();
    let n2: i64 = conn
        .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n2, 1);
}

// ============================================================================
// Jepsen 风格不变量
// ============================================================================

/// **I.08** 不变量：任意变更序列后，`count(items) == DISTINCT record_id in INSERTs - DISTINCT record_id in physical DELETEs`
///
/// 对于软删除表，count 等于所有 INSERT record 的去重数（软删除的也算在 items 表里）
#[test]
fn invariant_insert_count_matches_items_count() {
    let conn = new_db();
    let now = chrono::Utc::now();

    let mut inserted = std::collections::HashSet::new();
    for i in 0..20 {
        let id = format!("n{}", i % 7); // 故意重复：id 会被 UPSERT
        inserted.insert(id.clone());

        let ts = (now - chrono::Duration::seconds(100 - i as i64)).to_rfc3339();
        let c = SyncChangeWithData {
            table_name: "items".into(),
            record_id: id.clone(),
            operation: if i % 3 == 0 {
                ChangeOperation::Insert
            } else {
                ChangeOperation::Update
            },
            data: Some(json!({
                "id": id,
                "title": format!("v{}", i),
                "updated_at": ts.clone(),
                "deleted_at": serde_json::Value::Null,
            })),
            changed_at: ts,
            change_log_id: None,
            database_name: Some("test".into()),
            suppress_change_log: Some(true),
        };
        SyncManager::apply_downloaded_changes(&conn, &[c], None).unwrap();
    }

    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, inserted.len() as i64);
}

/// **I.09** 不变量：应用 DELETE 后再 SELECT 时 deleted_at 必须非空
#[test]
fn invariant_delete_sets_tombstone() {
    let conn = new_db();
    let now = chrono::Utc::now();

    let ins_ts = (now - chrono::Duration::seconds(10)).to_rfc3339();
    let del_ts = (now - chrono::Duration::seconds(5)).to_rfc3339();

    SyncManager::apply_downloaded_changes(
        &conn,
        &[SyncChangeWithData {
            table_name: "items".into(),
            record_id: "n1".into(),
            operation: ChangeOperation::Insert,
            data: Some(json!({
                "id": "n1", "title": "t",
                "updated_at": ins_ts.clone(),
                "deleted_at": serde_json::Value::Null,
            })),
            changed_at: ins_ts,
            change_log_id: None,
            database_name: Some("test".into()),
            suppress_change_log: Some(true),
        }],
        None,
    )
    .unwrap();

    SyncManager::apply_downloaded_changes(
        &conn,
        &[SyncChangeWithData {
            table_name: "items".into(),
            record_id: "n1".into(),
            operation: ChangeOperation::Delete,
            data: None,
            changed_at: del_ts,
            change_log_id: None,
            database_name: Some("test".into()),
            suppress_change_log: Some(true),
        }],
        None,
    )
    .unwrap();

    let del: Option<String> = conn
        .query_row("SELECT deleted_at FROM items WHERE id='n1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(del.is_some());
}

/// **I.10** 不变量：应用 N 条变更后，__change_log.pending 条目数 == 本地用户直接写入数
///
/// 这确保回放产生的 change_log 全被正确抑制，不会污染下次 drain。
#[test]
fn invariant_replay_does_not_pollute_pending() {
    let conn = new_db();
    let now = chrono::Utc::now();

    // 本地用户操作（真实 INSERT，不经 sync）
    let user_ts = now.to_rfc3339();
    conn.execute(
        "INSERT INTO items (id, title, updated_at) VALUES ('user', 'user_edit', ?1)",
        params![user_ts],
    )
    .unwrap();

    let user_pending_before: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __change_log WHERE sync_version = 0",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(user_pending_before, 1, "用户本地写入产生 1 条 pending");

    // 现在云端推送几条完全独立的变更
    let ins_ts = (now - chrono::Duration::seconds(5)).to_rfc3339();
    let mut changes = Vec::new();
    for i in 0..5 {
        let id = format!("cloud_{}", i);
        changes.push(SyncChangeWithData {
            table_name: "items".into(),
            record_id: id.clone(),
            operation: ChangeOperation::Insert,
            data: Some(json!({
                "id": id,
                "title": "cloud",
                "updated_at": ins_ts.clone(),
                "deleted_at": serde_json::Value::Null,
            })),
            changed_at: ins_ts.clone(),
            change_log_id: None,
            database_name: Some("test".into()),
            suppress_change_log: Some(true),
        });
    }
    SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();

    let user_pending_after: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __change_log WHERE sync_version = 0",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        user_pending_after, 1,
        "回放 5 条不应增加 pending 数量（用户原有的 1 条保留）"
    );
}

/// **I.11** 不变量：已应用变更的 UPSERT 不会产生额外的 pending 条目
#[test]
fn invariant_self_applied_changes_have_no_echo() {
    let conn = new_db();
    let now = chrono::Utc::now();

    for i in 0..10 {
        let id = format!("k{}", i);
        let ts = (now - chrono::Duration::seconds(100 - i as i64)).to_rfc3339();
        SyncManager::apply_downloaded_changes(
            &conn,
            &[SyncChangeWithData {
                table_name: "items".into(),
                record_id: id.clone(),
                operation: ChangeOperation::Insert,
                data: Some(json!({
                    "id": id,
                    "title": format!("v{}", i),
                    "updated_at": ts.clone(),
                    "deleted_at": serde_json::Value::Null,
                })),
                changed_at: ts,
                change_log_id: None,
                database_name: Some("test".into()),
                suppress_change_log: Some(true),
            }],
            None,
        )
        .unwrap();
    }

    let pending: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __change_log WHERE sync_version = 0",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(pending, 0, "suppress_change_log=true 时应无 pending 条目");
}

// ============================================================================
// Conflict Resolver 边界
// ============================================================================

/// **I.12** 冲突记录的 data_json 字段必须能被完整反序列化回来
#[test]
fn conflict_record_data_is_roundtripped() {
    use deep_student_lib::data_governance::sync::ConflictPolicy;

    let conn = new_db();
    let now = chrono::Utc::now();
    let base_ts = (now - chrono::Duration::seconds(20)).to_rfc3339();
    let local_ts = (now - chrono::Duration::seconds(5)).to_rfc3339();
    let cloud_ts = (now - chrono::Duration::seconds(10)).to_rfc3339();

    conn.execute(
        "INSERT INTO items (id, title, counter, updated_at) VALUES ('n1', 'base', 0, ?1)",
        params![base_ts],
    )
    .unwrap();
    conn.execute(
        "UPDATE items SET title = 'local_complex', counter = 42, updated_at = ?1 WHERE id = 'n1'",
        params![local_ts],
    )
    .unwrap();

    let change = SyncChangeWithData {
        table_name: "items".into(),
        record_id: "n1".into(),
        operation: ChangeOperation::Update,
        data: Some(json!({
            "id": "n1",
            "title": "cloud_with_special_chars ∑ ≈ 中文",
            "counter": 999,
            "updated_at": cloud_ts.clone(),
            "deleted_at": serde_json::Value::Null,
        })),
        changed_at: cloud_ts,
        change_log_id: None,
        database_name: Some("test".into()),
        suppress_change_log: Some(true),
    };

    SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[change],
        None,
        ConflictPolicy::KeepLatest,
        Some("cloud"),
        Some("local"),
    )
    .unwrap();

    // 查出冲突表里的 cloud side 数据
    let cloud_json: String = conn
        .query_row(
            "SELECT data_json FROM __sync_conflicts WHERE record_id='n1' AND side='cloud'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let cloud_parsed: serde_json::Value = serde_json::from_str(&cloud_json).unwrap();
    assert_eq!(
        cloud_parsed["title"].as_str(),
        Some("cloud_with_special_chars ∑ ≈ 中文"),
        "冲突表存储的 JSON 必须完整保留 unicode"
    );
    assert_eq!(cloud_parsed["counter"].as_i64(), Some(999));
}

// ============================================================================
// 压力场景
// ============================================================================

/// **I.13** 单事务批次应用 1000 条变更
#[test]
fn large_batch_1000_records() {
    let conn = new_db();
    let now = chrono::Utc::now();

    let mut changes = Vec::with_capacity(1000);
    for i in 0..1000 {
        let id = format!("n{:04}", i);
        let ts = (now - chrono::Duration::seconds(2000 - i as i64)).to_rfc3339();
        changes.push(SyncChangeWithData {
            table_name: "items".into(),
            record_id: id.clone(),
            operation: ChangeOperation::Insert,
            data: Some(json!({
                "id": id,
                "title": format!("v{}", i),
                "updated_at": ts.clone(),
                "deleted_at": serde_json::Value::Null,
            })),
            changed_at: ts,
            change_log_id: None,
            database_name: Some("test".into()),
            suppress_change_log: Some(true),
        });
    }

    let r = SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();
    assert_eq!(r.success_count, 1000);
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1000);
}

/// **I.14** 压力：同一记录连续 500 次 UPSERT
#[test]
fn stress_same_record_many_updates() {
    let conn = new_db();
    let now = chrono::Utc::now();

    for i in 0..500 {
        let ts = (now - chrono::Duration::milliseconds(10000 - i as i64)).to_rfc3339();
        SyncManager::apply_downloaded_changes(
            &conn,
            &[SyncChangeWithData {
                table_name: "items".into(),
                record_id: "n1".into(),
                operation: if i == 0 {
                    ChangeOperation::Insert
                } else {
                    ChangeOperation::Update
                },
                data: Some(json!({
                    "id": "n1",
                    "title": format!("v{}", i),
                    "counter": i,
                    "updated_at": ts.clone(),
                    "deleted_at": serde_json::Value::Null,
                })),
                changed_at: ts,
                change_log_id: None,
                database_name: Some("test".into()),
                suppress_change_log: Some(true),
            }],
            None,
        )
        .unwrap();
    }

    let (title, counter): (String, i64) = conn
        .query_row(
            "SELECT title, counter FROM items WHERE id = 'n1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(title, "v499");
    assert_eq!(counter, 499);
}

/// **I.15** 原子性：一个批次里的 OK/FAIL 变更混合
#[test]
fn mixed_batch_atomicity() {
    let conn = new_db();
    let now = chrono::Utc::now();
    let ts = now.to_rfc3339();

    let ok_1 = SyncChangeWithData {
        table_name: "items".into(),
        record_id: "n1".into(),
        operation: ChangeOperation::Insert,
        data: Some(json!({
            "id": "n1", "title": "ok1",
            "updated_at": ts.clone(),
            "deleted_at": serde_json::Value::Null,
        })),
        changed_at: ts.clone(),
        change_log_id: None,
        database_name: Some("test".into()),
        suppress_change_log: Some(true),
    };
    let ok_2 = SyncChangeWithData {
        table_name: "items".into(),
        record_id: "n2".into(),
        operation: ChangeOperation::Insert,
        data: Some(json!({
            "id": "n2", "title": "ok2",
            "updated_at": ts.clone(),
            "deleted_at": serde_json::Value::Null,
        })),
        changed_at: ts.clone(),
        change_log_id: None,
        database_name: Some("test".into()),
        suppress_change_log: Some(true),
    };
    let bad = SyncChangeWithData {
        table_name: "nope_table".into(),
        record_id: "x".into(),
        operation: ChangeOperation::Insert,
        data: Some(json!({"id": "x"})),
        changed_at: ts,
        change_log_id: None,
        database_name: None,
        suppress_change_log: Some(true),
    };

    let r = SyncManager::apply_downloaded_changes(&conn, &[ok_1, bad, ok_2], None);
    assert!(r.is_err(), "含非法条目，整批失败");

    // ok_1 和 ok_2 都不应该落地（事务原子性）
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0);
}
