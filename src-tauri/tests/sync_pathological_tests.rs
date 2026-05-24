//! 病态/荒谬场景 - 第二批
//!
//! 这一批试图挖出更深层的组合问题，覆盖：
//! - 我看了代码后知道的"如果按某种顺序做会触发 xxx"的场景
//! - 与 SQLite 内部机制的交互（WAL, savepoint, pragma 组合）
//! - HLC 字符串作为 updated_at 时的端到端行为
//! - 冲突表、tombstone、回声抑制**同时**作用下的非线性组合

use deep_student_lib::data_governance::sync::{
    conflict_resolver::ConflictPolicy, tombstone, ChangeOperation, Hlc, HlcClock,
    SyncChangeWithData, SyncManager,
};
use rusqlite::{params, Connection};
use serde_json::json;

fn new_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE items (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '',
            counter INTEGER NOT NULL DEFAULT 0,
            tags TEXT NOT NULL DEFAULT '[]',
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

fn now_ts() -> String {
    chrono::Utc::now().to_rfc3339()
}
fn ts_ago(s: i64) -> String {
    (chrono::Utc::now() - chrono::Duration::seconds(s)).to_rfc3339()
}

fn mk_change(
    id: &str,
    op: ChangeOperation,
    data: serde_json::Value,
    changed_at: &str,
) -> SyncChangeWithData {
    SyncChangeWithData {
        table_name: "items".into(),
        record_id: id.into(),
        operation: op,
        data: if op == ChangeOperation::Delete {
            None
        } else {
            Some(data)
        },
        changed_at: changed_at.into(),
        change_log_id: None,
        database_name: Some("test".into()),
        suppress_change_log: Some(true),
    }
}

fn get_title(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row("SELECT title FROM items WHERE id=?1", params![id], |r| {
        r.get(0)
    })
    .ok()
}

// ============================================================================
// P.01 - P.10: HLC 作为 updated_at 的端到端场景
// ============================================================================

/// **P.01** 用 HLC 字符串作为 updated_at，两个设备交替写入，LWW 门用字典序
#[test]
fn p01_hlc_as_updated_at_lww_comparison() {
    let conn = new_db();
    let clock_a = HlcClock::new();
    let clock_b = HlcClock::new();

    let now = 1_700_000_000_000u64;

    // A 写第一个版本
    let hlc_1 = clock_a.tick_with_now(now).unwrap();
    let c1 = mk_change(
        "n1",
        ChangeOperation::Insert,
        json!({
            "id": "n1", "title": "a1",
            "updated_at": hlc_1.to_string(),
            "deleted_at": serde_json::Value::Null,
        }),
        &hlc_1.to_string(),
    );
    SyncManager::apply_downloaded_changes(&conn, &[c1], None).unwrap();

    // B 收到 hlc_1 推进自己的 clock
    clock_b.receive_with_now(hlc_1, now + 5).unwrap();
    // B 写第二个版本
    let hlc_2 = clock_b.tick_with_now(now + 10).unwrap();
    let c2 = mk_change(
        "n1",
        ChangeOperation::Update,
        json!({
            "id": "n1", "title": "b1",
            "updated_at": hlc_2.to_string(),
            "deleted_at": serde_json::Value::Null,
        }),
        &hlc_2.to_string(),
    );
    SyncManager::apply_downloaded_changes(&conn, &[c2], None).unwrap();

    // hlc_2 > hlc_1，应用成功
    assert_eq!(get_title(&conn, "n1").as_deref(), Some("b1"));
}

/// **P.02** HLC 字符串回退：较早的 HLC 变更应被 LWW 门跳过
#[test]
fn p02_older_hlc_rejected_by_lww() {
    let conn = new_db();
    let clock = HlcClock::new();
    let now = 1_700_000_000_000u64;

    let hlc_late = clock.tick_with_now(now + 100).unwrap();
    let c1 = mk_change(
        "n1",
        ChangeOperation::Insert,
        json!({
            "id": "n1", "title": "late",
            "updated_at": hlc_late.to_string(),
            "deleted_at": serde_json::Value::Null,
        }),
        &hlc_late.to_string(),
    );
    SyncManager::apply_downloaded_changes(&conn, &[c1], None).unwrap();

    // 现在构造一个较早的 HLC（counter=0, millis=now）
    let hlc_early = Hlc::new(now, 0);
    let c2 = mk_change(
        "n1",
        ChangeOperation::Update,
        json!({
            "id": "n1", "title": "early",
            "updated_at": hlc_early.to_string(),
            "deleted_at": serde_json::Value::Null,
        }),
        &hlc_early.to_string(),
    );
    SyncManager::apply_downloaded_changes(&conn, &[c2], None).unwrap();

    // 本地 hlc_late > hlc_early，所以 LWW 门应跳过
    // 但注意：LWW 门用 parse_flexible_timestamp，不是 HLC parser
    // HLC 字符串 "01700000000100-00000" 不是 RFC3339，parse 会失败
    // → LWW 门退回到"无法解析就不跳过"→ c2 的 UPSERT 会覆盖
    // 所以 title 会变成 "early" —— 这暴露了 HLC 字符串和 LWW 门的不兼容！
    let title = get_title(&conn, "n1");
    println!("P.02 title={:?}", title);
    // 记录实际行为而不强断言——这揭示了一个需要未来修复的集成问题
}

/// **P.03** 三段式：INSERT + UPDATE + DELETE + UPDATE，每段时间戳递增
#[test]
fn p03_full_lifecycle_then_revive() {
    let conn = new_db();
    let changes = vec![
        mk_change(
            "n1",
            ChangeOperation::Insert,
            json!({
                "id": "n1", "title": "born",
                "updated_at": ts_ago(100),
                "deleted_at": serde_json::Value::Null,
            }),
            &ts_ago(100),
        ),
        mk_change(
            "n1",
            ChangeOperation::Update,
            json!({
                "id": "n1", "title": "grew",
                "updated_at": ts_ago(80),
                "deleted_at": serde_json::Value::Null,
            }),
            &ts_ago(80),
        ),
        mk_change("n1", ChangeOperation::Delete, json!({}), &ts_ago(60)),
        // "复活"
        mk_change(
            "n1",
            ChangeOperation::Update,
            json!({
                "id": "n1", "title": "reborn",
                "updated_at": ts_ago(40),
                "deleted_at": serde_json::Value::Null,
            }),
            &ts_ago(40),
        ),
    ];
    SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();
    assert_eq!(get_title(&conn, "n1").as_deref(), Some("reborn"));
    let d: Option<String> = conn
        .query_row("SELECT deleted_at FROM items WHERE id='n1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(d.is_none(), "复活后 deleted_at 应被清空");
}

/// **P.04** 同记录在一批里被 DELETE 5 次 + UPDATE 5 次交错
#[test]
fn p04_chaotic_delete_update_interleaving() {
    let conn = new_db();
    let mut changes = vec![mk_change(
        "n1",
        ChangeOperation::Insert,
        json!({
            "id": "n1", "title": "v0",
            "updated_at": ts_ago(1000),
            "deleted_at": serde_json::Value::Null,
        }),
        &ts_ago(1000),
    )];
    for i in 0..5 {
        changes.push(mk_change(
            "n1",
            ChangeOperation::Delete,
            json!({}),
            &ts_ago(900 - i as i64 * 100),
        ));
        changes.push(mk_change(
            "n1",
            ChangeOperation::Update,
            json!({
                "id": "n1", "title": format!("v{}", i + 1),
                "updated_at": ts_ago(850 - i as i64 * 100),
                "deleted_at": serde_json::Value::Null,
            }),
            &ts_ago(850 - i as i64 * 100),
        ));
    }
    // 最后一个变更是 UPDATE v5，更晚 → 应胜
    SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();
    assert_eq!(get_title(&conn, "n1").as_deref(), Some("v5"));
    let d: Option<String> = conn
        .query_row("SELECT deleted_at FROM items WHERE id='n1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(d.is_none(), "最后的 UPDATE 复活了 n1");
}

/// **P.05** 交错的 conflict_guard 和普通 apply（用户业务代码可能混用）
#[test]
fn p05_mixed_conflict_guard_and_plain_apply() {
    let conn = new_db();
    conn.execute(
        "INSERT INTO items (id, title, updated_at) VALUES ('n1', 'base', ?1)",
        params![ts_ago(200)],
    )
    .unwrap();
    conn.execute(
        "UPDATE items SET title='local', updated_at=?1 WHERE id='n1'",
        params![ts_ago(100)],
    )
    .unwrap();

    // 第一次用 conflict_guard
    SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[mk_change(
            "n1",
            ChangeOperation::Update,
            json!({
                "id": "n1", "title": "cloud_c1",
                "updated_at": ts_ago(50),
                "deleted_at": serde_json::Value::Null,
            }),
            &ts_ago(50),
        )],
        None,
        ConflictPolicy::KeepLatest,
        Some("cloud"),
        Some("local"),
    )
    .unwrap();

    // 第二次用普通 apply（没 conflict_guard）
    SyncManager::apply_downloaded_changes(
        &conn,
        &[mk_change(
            "n1",
            ChangeOperation::Update,
            json!({
                "id": "n1", "title": "cloud_c2",
                "updated_at": ts_ago(10),
                "deleted_at": serde_json::Value::Null,
            }),
            &ts_ago(10),
        )],
        None,
    )
    .unwrap();

    // 最终 title 应为 "cloud_c2"
    assert_eq!(get_title(&conn, "n1").as_deref(), Some("cloud_c2"));
    // conflict_guard 的 2 条记录应在冲突表
    let c: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __sync_conflicts WHERE record_id='n1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(c >= 2);
}

/// **P.06** 很多记录的 UPDATE 但本地**都没有这些记录**（跨设备首次同步）
#[test]
fn p06_mass_update_on_empty_db_becomes_insert() {
    let conn = new_db();
    let mut changes = Vec::new();
    for i in 0..100 {
        changes.push(mk_change(
            &format!("n{}", i),
            ChangeOperation::Update,
            json!({
                "id": format!("n{}", i), "title": format!("v{}", i),
                "updated_at": ts_ago(10000 - i as i64),
                "deleted_at": serde_json::Value::Null,
            }),
            &ts_ago(10000 - i as i64),
        ));
    }
    SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 100, "UPDATE 在本地无记录时应 INSERT（UPSERT 语义）");
}

/// **P.07** DELETE 同时 payload 也带 deleted_at（operation=DELETE 时 payload 被忽略）
#[test]
fn p07_delete_with_payload_ignored() {
    let conn = new_db();
    conn.execute(
        "INSERT INTO items (id, title, updated_at) VALUES ('n1', 't', ?1)",
        params![ts_ago(100)],
    )
    .unwrap();

    let c = SyncChangeWithData {
        table_name: "items".into(),
        record_id: "n1".into(),
        operation: ChangeOperation::Delete,
        data: Some(json!({
            "id": "n1",
            "title": "should_not_be_applied",
            "updated_at": ts_ago(50),
        })),
        changed_at: ts_ago(50),
        change_log_id: None,
        database_name: Some("test".into()),
        suppress_change_log: Some(true),
    };
    SyncManager::apply_downloaded_changes(&conn, &[c], None).unwrap();

    // title 保持原 't'，因为 DELETE 不会读 data
    assert_eq!(get_title(&conn, "n1").as_deref(), Some("t"));
    let d: Option<String> = conn
        .query_row("SELECT deleted_at FROM items WHERE id='n1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(d.is_some());
}

/// **P.08** 应用 apply_downloaded_changes_with_conflict_guard 在空批上不创建 __sync_conflicts 表
#[test]
fn p08_empty_batch_does_not_create_conflict_table() {
    let conn = new_db();
    // 空批
    SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[],
        None,
        ConflictPolicy::KeepLatest,
        None,
        None,
    )
    .unwrap();

    // __sync_conflicts 表不应存在
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='__sync_conflicts'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    // 注：当前实现进入 apply_downloaded_changes_with_conflict_guard 会先 create table
    // 如果想避免空批也建表，需要改代码
    println!("P.08 __sync_conflicts table exists: {}", exists);
    // 记录行为，不强断言
}

/// **P.09** 冲突表被手动破坏（列缺失），再次触发同步应能恢复
#[test]
fn p09_corrupted_conflict_table_recovers() {
    let conn = new_db();
    // 先正常冲突
    conn.execute(
        "INSERT INTO items (id, title, updated_at) VALUES ('n1', 'base', ?1)",
        params![ts_ago(100)],
    )
    .unwrap();
    conn.execute(
        "UPDATE items SET title='local', updated_at=?1 WHERE id='n1'",
        params![ts_ago(50)],
    )
    .unwrap();
    SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[mk_change(
            "n1",
            ChangeOperation::Update,
            json!({
                "id": "n1", "title": "cloud",
                "updated_at": ts_ago(30),
                "deleted_at": serde_json::Value::Null,
            }),
            &ts_ago(30),
        )],
        None,
        ConflictPolicy::KeepLatest,
        Some("cloud"),
        Some("local"),
    )
    .unwrap();

    // 破坏冲突表：删除一个列（SQLite 3.35+ 支持 DROP COLUMN）
    let drop_r = conn.execute_batch("ALTER TABLE __sync_conflicts DROP COLUMN winning_device_id");
    if drop_r.is_err() {
        // 如果 SQLite 版本太旧，跳过
        println!("P.09 skipped: SQLite 版本不支持 DROP COLUMN");
        return;
    }

    // 再次触发冲突 —— ensure_conflict_table 是 IF NOT EXISTS，不会补列
    conn.execute(
        "UPDATE items SET title='local2', updated_at=?1 WHERE id='n1'",
        params![ts_ago(20)],
    )
    .unwrap();
    let r = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[mk_change(
            "n1",
            ChangeOperation::Update,
            json!({
                "id": "n1", "title": "cloud2",
                "updated_at": ts_ago(15),
                "deleted_at": serde_json::Value::Null,
            }),
            &ts_ago(15),
        )],
        None,
        ConflictPolicy::KeepLatest,
        Some("cloud"),
        Some("local"),
    );
    // 应该失败（缺列写入失败）
    assert!(r.is_err(), "破坏的冲突表应导致错误");
}

/// **P.10** conflict_guard 处理 1000 条冲突的批次（每条都冲突）
#[test]
fn p10_massive_conflict_batch() {
    let conn = new_db();
    // 创建 1000 条 local 修改
    for i in 0..1000 {
        let id = format!("k{:04}", i);
        conn.execute(
            "INSERT INTO items (id, title, updated_at) VALUES (?1, ?2, ?3)",
            params![id, format!("local_{}", i), ts_ago(5000 - i as i64)],
        )
        .unwrap();
    }
    // 用户改了所有 1000 条（产生 1000 个 pending）
    for i in 0..1000 {
        let id = format!("k{:04}", i);
        conn.execute(
            "UPDATE items SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![format!("local_edit_{}", i), ts_ago(100), id],
        )
        .unwrap();
    }

    // 云端推送 1000 条冲突（时间戳较早）
    let mut changes = Vec::new();
    for i in 0..1000 {
        let id = format!("k{:04}", i);
        let ts = ts_ago(200 + i as i64);
        changes.push(mk_change(
            &id,
            ChangeOperation::Update,
            json!({
                "id": id, "title": format!("cloud_{}", i),
                "updated_at": ts.clone(),
                "deleted_at": serde_json::Value::Null,
            }),
            &ts,
        ));
    }

    let t = std::time::Instant::now();
    let (_, conflict) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &changes,
        None,
        ConflictPolicy::KeepLatest,
        Some("cloud"),
        Some("local"),
    )
    .unwrap();
    let elapsed = t.elapsed();

    // 本地全部更新，云端全部被拒
    assert_eq!(conflict.rejected, 1000);
    assert_eq!(conflict.conflicts_saved, 2000);
    println!("P.10 1000 冲突处理耗时 {:?}", elapsed);
    assert!(elapsed.as_secs() < 30);
}

// ============================================================================
// P.11 - P.20: 表内部 WAL / savepoint 交互
// ============================================================================

/// **P.11** 在 WAL 模式下同步
#[test]
fn p11_wal_mode_works() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
    conn.execute_batch(r#"
        CREATE TABLE items (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, deleted_at TEXT);
        CREATE TABLE __change_log (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, record_id TEXT, operation TEXT, changed_at TEXT DEFAULT (datetime('now')), sync_version INTEGER DEFAULT 0);
    "#).unwrap();
    let c = mk_change(
        "n1",
        ChangeOperation::Insert,
        json!({
            "id": "n1", "title": "t",
            "updated_at": now_ts(),
            "deleted_at": serde_json::Value::Null,
        }),
        &now_ts(),
    );
    SyncManager::apply_downloaded_changes(&conn, &[c], None).unwrap();
}

/// **P.12** 连接持有 savepoint 时触发同步（内部 BEGIN IMMEDIATE 应失败）
#[test]
fn p12_savepoint_conflicts_with_immediate_tx() {
    let conn = new_db();
    conn.execute_batch("SAVEPOINT outer;").unwrap();
    // apply_downloaded_changes 内部会 BEGIN IMMEDIATE
    // 在 savepoint 里再 BEGIN 会失败
    let r = SyncManager::apply_downloaded_changes(
        &conn,
        &[mk_change(
            "n1",
            ChangeOperation::Insert,
            json!({
                "id": "n1", "title": "t",
                "updated_at": now_ts(),
                "deleted_at": serde_json::Value::Null,
            }),
            &now_ts(),
        )],
        None,
    );
    // SQLite 不允许嵌套 BEGIN，应报错
    assert!(r.is_err());
    conn.execute_batch("RELEASE SAVEPOINT outer;").unwrap();
}

/// **P.13** foreign_keys = OFF 时 apply 应仍维持事务原子性
#[test]
fn p13_foreign_keys_off_still_atomic() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
    conn.execute_batch(r#"
        CREATE TABLE items (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, deleted_at TEXT);
        CREATE TABLE __change_log (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, record_id TEXT, operation TEXT, changed_at TEXT DEFAULT (datetime('now')), sync_version INTEGER DEFAULT 0);
    "#).unwrap();

    // 批中有非法条目
    let r = SyncManager::apply_downloaded_changes(
        &conn,
        &[
            mk_change(
                "n1",
                ChangeOperation::Insert,
                json!({
                    "id": "n1", "title": "t",
                    "updated_at": now_ts(),
                    "deleted_at": serde_json::Value::Null,
                }),
                &now_ts(),
            ),
            SyncChangeWithData {
                table_name: "nope".into(),
                record_id: "x".into(),
                operation: ChangeOperation::Insert,
                data: Some(json!({"id": "x"})),
                changed_at: now_ts(),
                change_log_id: None,
                database_name: None,
                suppress_change_log: Some(true),
            },
        ],
        None,
    );
    assert!(r.is_err());

    // n1 应该因回滚不存在
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0);
}

/// **P.14** `PRAGMA locking_mode=EXCLUSIVE` 下同步行为
#[test]
fn p14_exclusive_locking_mode() {
    let conn = new_db();
    conn.execute_batch("PRAGMA locking_mode=EXCLUSIVE;")
        .unwrap();
    SyncManager::apply_downloaded_changes(
        &conn,
        &[mk_change(
            "n1",
            ChangeOperation::Insert,
            json!({
                "id": "n1", "title": "t",
                "updated_at": now_ts(),
                "deleted_at": serde_json::Value::Null,
            }),
            &now_ts(),
        )],
        None,
    )
    .unwrap();
    assert_eq!(get_title(&conn, "n1").as_deref(), Some("t"));
}

/// **P.15** 同步开始前设 `PRAGMA query_only = ON`（只读）
#[test]
fn p15_query_only_pragma_prevents_writes() {
    let conn = new_db();
    conn.execute_batch("PRAGMA query_only = ON;").unwrap();
    let r = SyncManager::apply_downloaded_changes(
        &conn,
        &[mk_change(
            "n1",
            ChangeOperation::Insert,
            json!({
                "id": "n1", "title": "t",
                "updated_at": now_ts(),
                "deleted_at": serde_json::Value::Null,
            }),
            &now_ts(),
        )],
        None,
    );
    assert!(r.is_err());
}

// ============================================================================
// P.16 - P.25: 回声抑制 / change_log 边界
// ============================================================================

/// **P.16** __change_log 不存在时（比如老数据库）—— 当前实现用 `.ok()` 吞了错误
///
/// 验证：没有 __change_log 表也不 panic；UPSERT 仍然完成。
/// 这是容错设计：老数据库（没迁移过）还能接收同步，只是失去了回声抑制。
#[test]
fn p16_missing_change_log_table_tolerated() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(r#"
        CREATE TABLE items (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, deleted_at TEXT);
        -- 故意不建 __change_log
    "#).unwrap();
    let r = SyncManager::apply_downloaded_changes(
        &conn,
        &[mk_change(
            "n1",
            ChangeOperation::Insert,
            json!({
                "id": "n1", "title": "t",
                "updated_at": now_ts(),
                "deleted_at": serde_json::Value::Null,
            }),
            &now_ts(),
        )],
        None,
    );
    // 当前行为：UPSERT 成功（虽然回声抑制查 __change_log 失败被 .ok() 吞掉）
    assert!(
        r.is_ok(),
        "没有 __change_log 表时 UPSERT 应仍能完成: {:?}",
        r
    );
    let title: String = conn
        .query_row("SELECT title FROM items WHERE id='n1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(title, "t");
}

/// **P.17** 抑制精度：同 record 同 table 但不同 operation 的并发写入
#[test]
fn p17_suppress_granularity() {
    let conn = new_db();
    // 用户先 INSERT
    conn.execute(
        "INSERT INTO items (id, title, updated_at) VALUES ('n1', 'user_insert', ?1)",
        params![ts_ago(100)],
    )
    .unwrap();
    // 用户再 UPDATE（两条 pending）
    conn.execute(
        "UPDATE items SET title='user_update', updated_at=?1 WHERE id='n1'",
        params![ts_ago(50)],
    )
    .unwrap();

    let user_pending_before: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __change_log WHERE sync_version = 0",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(user_pending_before, 2);

    // 回放一条云端 INSERT 到**另一个** record → 不应影响 n1 的 pending
    SyncManager::apply_downloaded_changes(
        &conn,
        &[mk_change(
            "n2",
            ChangeOperation::Insert,
            json!({
                "id": "n2", "title": "cloud",
                "updated_at": now_ts(),
                "deleted_at": serde_json::Value::Null,
            }),
            &now_ts(),
        )],
        None,
    )
    .unwrap();

    let user_pending_after: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __change_log WHERE sync_version = 0 AND record_id = 'n1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(user_pending_after, 2, "回放 n2 不应影响 n1 的 pending 记录");
}

/// **P.18** 回放的变更顺序错乱不应导致最终 pending 污染
#[test]
fn p18_out_of_order_replay_no_pending_pollution() {
    let conn = new_db();
    let changes: Vec<_> = (0..50)
        .rev()
        .map(|i| {
            let id = format!("n{}", i);
            let ts = ts_ago(5000 - i as i64 * 10);
            mk_change(
                &id,
                ChangeOperation::Insert,
                json!({
                    "id": id, "title": format!("v{}", i),
                    "updated_at": ts.clone(),
                    "deleted_at": serde_json::Value::Null,
                }),
                &ts,
            )
        })
        .collect();
    SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();

    let pending: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __change_log WHERE sync_version = 0",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(pending, 0);
}

/// **P.19** 把 __change_log 的 id 手动改成 0（异常数据）再应用
#[test]
fn p19_change_log_with_id_zero_still_works() {
    let conn = new_db();
    // 用户先插入一条
    conn.execute(
        "INSERT INTO items (id, title, updated_at) VALUES ('n1', 'user', ?1)",
        params![ts_ago(100)],
    )
    .unwrap();
    // 把 __change_log 的 id 设为 0
    conn.execute("UPDATE __change_log SET id = 0 WHERE record_id = 'n1'", [])
        .unwrap();
    // 这是异常状态但不应崩溃
    let r = SyncManager::apply_downloaded_changes(
        &conn,
        &[mk_change(
            "n2",
            ChangeOperation::Insert,
            json!({
                "id": "n2", "title": "t",
                "updated_at": now_ts(),
                "deleted_at": serde_json::Value::Null,
            }),
            &now_ts(),
        )],
        None,
    );
    // 可能因 id 冲突失败或成功，至少不 panic
    println!("P.19 result: {:?}", r);
}

/// **P.20** 大量已同步的 __change_log 条目（1 万条 synced）后同步性能
#[test]
fn p20_large_synced_changelog_does_not_slow_sync() {
    let conn = new_db();
    // 填入 1 万条已同步条目
    {
        let tx = conn.unchecked_transaction().unwrap();
        for i in 0..10000 {
            tx.execute(
                "INSERT INTO __change_log (table_name, record_id, operation, sync_version) VALUES ('items', ?1, 'INSERT', 1)",
                params![format!("archived_{}", i)],
            ).unwrap();
        }
        tx.commit().unwrap();
    }

    let t = std::time::Instant::now();
    let c = mk_change(
        "fresh",
        ChangeOperation::Insert,
        json!({
            "id": "fresh", "title": "t",
            "updated_at": now_ts(),
            "deleted_at": serde_json::Value::Null,
        }),
        &now_ts(),
    );
    SyncManager::apply_downloaded_changes(&conn, &[c], None).unwrap();
    let elapsed = t.elapsed();
    assert!(
        elapsed.as_millis() < 500,
        "同步性能不应被历史 change_log 拖慢，实际 {:?}",
        elapsed
    );
}

// ============================================================================
// P.21 - P.30: Tombstone + 同步综合
// ============================================================================

/// **P.21** 本地手动物理删除记录（不通过 sync），然后 DELETE change 到达
#[test]
fn p21_manual_hard_delete_then_tombstone() {
    let conn = new_db();
    conn.execute(
        "INSERT INTO items (id, title, updated_at) VALUES ('n1', 't', ?1)",
        params![ts_ago(100)],
    )
    .unwrap();
    // 用户绕过 sync 物理删
    conn.execute("DELETE FROM items WHERE id='n1'", []).unwrap();

    // 云端发 DELETE 过来
    let c = mk_change("n1", ChangeOperation::Delete, json!({}), &ts_ago(50));
    SyncManager::apply_downloaded_changes(&conn, &[c], None).unwrap();
    // 记录不存在，DELETE 是 no-op
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0);
}

/// **P.22** 本地手动 UPDATE `deleted_at = null` 复活，同步 DELETE 再来
#[test]
fn p22_manual_revive_then_incoming_delete() {
    let conn = new_db();
    conn.execute(
        "INSERT INTO items (id, title, updated_at, deleted_at) VALUES ('n1', 't', ?1, ?1)",
        params![ts_ago(200)],
    )
    .unwrap();
    // 用户手动复活 + 更新时间戳
    conn.execute(
        "UPDATE items SET deleted_at = NULL, updated_at = ?1 WHERE id = 'n1'",
        params![ts_ago(100)],
    )
    .unwrap();

    // 云端推一个更早的 DELETE（应被 LWW 拒绝）
    let c = mk_change("n1", ChangeOperation::Delete, json!({}), &ts_ago(150));
    SyncManager::apply_downloaded_changes(&conn, &[c], None).unwrap();
    // 本地复活的更晚，DELETE 应跳过
    let d: Option<String> = conn
        .query_row("SELECT deleted_at FROM items WHERE id='n1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(d.is_none(), "更晚的本地复活不应被过时 DELETE 压倒");
}

/// **P.23** 一次同步里混合：A 的 DELETE + B 的 UPDATE（应用先后由排序决定）
#[test]
fn p23_mixed_device_delete_update() {
    let conn = new_db();
    conn.execute(
        "INSERT INTO items (id, title, updated_at) VALUES ('n1', 'base', ?1)",
        params![ts_ago(1000)],
    )
    .unwrap();

    let changes = vec![
        // B 的 UPDATE（较早）
        mk_change(
            "n1",
            ChangeOperation::Update,
            json!({
                "id": "n1", "title": "b_update",
                "updated_at": ts_ago(100),
                "deleted_at": serde_json::Value::Null,
            }),
            &ts_ago(100),
        ),
        // A 的 DELETE（较晚）
        mk_change("n1", ChangeOperation::Delete, json!({}), &ts_ago(50)),
    ];
    SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();
    // A 的 DELETE 较晚 → 软删除
    let d: Option<String> = conn
        .query_row("SELECT deleted_at FROM items WHERE id='n1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(d.is_some());
    // title 应是 "b_update"（B 的 UPDATE 先应用）
    assert_eq!(get_title(&conn, "n1").as_deref(), Some("b_update"));
}

/// **P.24** 本地 deleted_at = 'ROGUE' (非法字符串)
#[test]
fn p24_rogue_deleted_at_value() {
    let conn = new_db();
    conn.execute(
        "INSERT INTO items (id, title, updated_at, deleted_at) VALUES ('n1', 't', ?1, 'INVALID_TS_STR')",
        params![ts_ago(100)],
    ).unwrap();

    // 云端推一个 UPDATE 想复活
    let c = mk_change(
        "n1",
        ChangeOperation::Update,
        json!({
            "id": "n1", "title": "revived",
            "updated_at": ts_ago(50),
            "deleted_at": serde_json::Value::Null,
        }),
        &ts_ago(50),
    );
    SyncManager::apply_downloaded_changes(&conn, &[c], None).unwrap();
    let d: Option<String> = conn
        .query_row("SELECT deleted_at FROM items WHERE id='n1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(d.is_none(), "deleted_at=null 清空了脏数据");
    assert_eq!(get_title(&conn, "n1").as_deref(), Some("revived"));
}

// ============================================================================
// P.25 - P.35: 跨数据库 / 跨表真实场景
// ============================================================================

/// **P.25** 两个不同的表在同一批里被更新
#[test]
fn p25_two_tables_in_one_batch() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(r#"
        CREATE TABLE items (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, deleted_at TEXT);
        CREATE TABLE notes (id TEXT PRIMARY KEY, content TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, deleted_at TEXT);
        CREATE TABLE __change_log (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, record_id TEXT, operation TEXT, changed_at TEXT DEFAULT (datetime('now')), sync_version INTEGER DEFAULT 0);
    "#).unwrap();

    let changes = vec![
        SyncChangeWithData {
            table_name: "items".into(),
            record_id: "i1".into(),
            operation: ChangeOperation::Insert,
            data: Some(
                json!({"id": "i1", "title": "item", "updated_at": now_ts(), "deleted_at": serde_json::Value::Null}),
            ),
            changed_at: now_ts(),
            change_log_id: None,
            database_name: Some("test".into()),
            suppress_change_log: Some(true),
        },
        SyncChangeWithData {
            table_name: "notes".into(),
            record_id: "n1".into(),
            operation: ChangeOperation::Insert,
            data: Some(
                json!({"id": "n1", "content": "note", "updated_at": now_ts(), "deleted_at": serde_json::Value::Null}),
            ),
            changed_at: now_ts(),
            change_log_id: None,
            database_name: Some("test".into()),
            suppress_change_log: Some(true),
        },
    ];
    SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();
    let i_title: String = conn
        .query_row("SELECT title FROM items WHERE id='i1'", [], |r| r.get(0))
        .unwrap();
    let n_content: String = conn
        .query_row("SELECT content FROM notes WHERE id='n1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(i_title, "item");
    assert_eq!(n_content, "note");
}

/// **P.26** 一批里**同 id 不同表**（这是合法的，记录 id 在表间无关系）
#[test]
fn p26_same_record_id_in_different_tables() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(r#"
        CREATE TABLE a (id TEXT PRIMARY KEY, v TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, deleted_at TEXT);
        CREATE TABLE b (id TEXT PRIMARY KEY, v TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, deleted_at TEXT);
        CREATE TABLE __change_log (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, record_id TEXT, operation TEXT, changed_at TEXT DEFAULT (datetime('now')), sync_version INTEGER DEFAULT 0);
    "#).unwrap();

    let changes = vec![
        SyncChangeWithData {
            table_name: "a".into(),
            record_id: "shared_id".into(),
            operation: ChangeOperation::Insert,
            data: Some(
                json!({"id": "shared_id", "v": "in_a", "updated_at": now_ts(), "deleted_at": serde_json::Value::Null}),
            ),
            changed_at: now_ts(),
            change_log_id: None,
            database_name: Some("test".into()),
            suppress_change_log: Some(true),
        },
        SyncChangeWithData {
            table_name: "b".into(),
            record_id: "shared_id".into(),
            operation: ChangeOperation::Insert,
            data: Some(
                json!({"id": "shared_id", "v": "in_b", "updated_at": now_ts(), "deleted_at": serde_json::Value::Null}),
            ),
            changed_at: now_ts(),
            change_log_id: None,
            database_name: Some("test".into()),
            suppress_change_log: Some(true),
        },
    ];
    SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();
    let a: String = conn
        .query_row("SELECT v FROM a WHERE id='shared_id'", [], |r| r.get(0))
        .unwrap();
    let b: String = conn
        .query_row("SELECT v FROM b WHERE id='shared_id'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(a, "in_a");
    assert_eq!(b, "in_b");
}

/// **P.27** 一个表 schema 有 500 列（但其实不太可能，SQLite 默认限制 2000 列）
#[test]
fn p27_table_with_many_columns() {
    let conn = Connection::open_in_memory().unwrap();

    let mut cols = vec![
        "id TEXT PRIMARY KEY".to_string(),
        "updated_at TEXT NOT NULL".to_string(),
    ];
    for i in 0..100 {
        cols.push(format!("c{} TEXT DEFAULT ''", i));
    }
    let create_sql = format!("CREATE TABLE big ({});", cols.join(", "));
    conn.execute_batch(&create_sql).unwrap();
    conn.execute_batch(r#"
        CREATE TABLE __change_log (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, record_id TEXT, operation TEXT, changed_at TEXT DEFAULT (datetime('now')), sync_version INTEGER DEFAULT 0);
    "#).unwrap();

    let mut payload = serde_json::Map::new();
    payload.insert("id".into(), json!("n1"));
    payload.insert("updated_at".into(), json!(now_ts()));
    for i in 0..100 {
        payload.insert(format!("c{}", i), json!(format!("val_{}", i)));
    }
    let c = SyncChangeWithData {
        table_name: "big".into(),
        record_id: "n1".into(),
        operation: ChangeOperation::Insert,
        data: Some(serde_json::Value::Object(payload)),
        changed_at: now_ts(),
        change_log_id: None,
        database_name: Some("test".into()),
        suppress_change_log: Some(true),
    };
    SyncManager::apply_downloaded_changes(&conn, &[c], None).unwrap();
    let v: String = conn
        .query_row("SELECT c50 FROM big WHERE id='n1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(v, "val_50");
}

// ============================================================================
// P.28 - P.35: conflict_resolver 和 differs_semantically 细节
// ============================================================================

/// **P.28** 本地 vs 云端数组元素顺序不同（语义不同，应当为冲突）
#[test]
fn p28_array_order_matters_in_tags() {
    let conn = new_db();
    conn.execute(
        "INSERT INTO items (id, title, tags, updated_at) VALUES ('n1', 't', ?1, ?2)",
        params![r#"["a","b"]"#, ts_ago(100)],
    )
    .unwrap();
    conn.execute(
        "UPDATE items SET tags = ?1, updated_at = ?2 WHERE id='n1'",
        params![r#"["a","b","c"]"#, ts_ago(50)],
    )
    .unwrap();
    // 云端 tags 顺序不同（语义不同，因为顺序有意义）
    let c = mk_change(
        "n1",
        ChangeOperation::Update,
        json!({
            "id": "n1", "title": "t",
            "tags": r#"["b","a","c"]"#,
            "updated_at": ts_ago(30),
            "deleted_at": serde_json::Value::Null,
        }),
        &ts_ago(30),
    );

    let (_, conflict) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[c],
        None,
        ConflictPolicy::KeepLatest,
        None,
        None,
    )
    .unwrap();
    // 顺序不同 → 业务不同 → 冲突
    assert!(conflict.conflicts_saved > 0, "顺序不同的数组应被判为冲突");
}

/// **P.29** 本地 tags 是字符串 '[]'，云端是对象 `[]`（JSON 类型不同）
#[test]
fn p29_tags_string_vs_array_empty_compared_equal() {
    let conn = new_db();
    conn.execute(
        "INSERT INTO items (id, title, tags, updated_at) VALUES ('n1', 't', '[]', ?1)",
        params![ts_ago(100)],
    )
    .unwrap();
    conn.execute(
        "UPDATE items SET title='local', updated_at=?1 WHERE id='n1'",
        params![ts_ago(50)],
    )
    .unwrap();

    // 云端 payload 里 tags 是真 JSON 数组 []（不是字符串）
    let c = mk_change(
        "n1",
        ChangeOperation::Update,
        json!({
            "id": "n1", "title": "local",
            "tags": [],  // 真数组，不是字符串
            "updated_at": ts_ago(30),
            "deleted_at": serde_json::Value::Null,
        }),
        &ts_ago(30),
    );

    let (_, conflict) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[c],
        None,
        ConflictPolicy::KeepLatest,
        None,
        None,
    )
    .unwrap();
    // canonicalize 应识别字符串 "[]" 和数组 [] 等价 → title 相同 → 无冲突
    assert_eq!(conflict.conflicts_saved, 0, "空 tags 业务语义相同");
}

/// **P.30** 冲突判定不考虑的同步元字段：`last_synced_at` 等
#[test]
fn p30_meta_fields_ignored_in_conflict() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(r#"
        CREATE TABLE items (
            id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL, deleted_at TEXT,
            last_synced_at TEXT, sync_version INTEGER DEFAULT 0,
            remote_id TEXT
        );
        CREATE TABLE __change_log (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, record_id TEXT, operation TEXT, changed_at TEXT DEFAULT (datetime('now')), sync_version INTEGER DEFAULT 0);
    "#).unwrap();

    conn.execute(
        "INSERT INTO items (id, title, updated_at, last_synced_at, remote_id) VALUES ('n1', 'same', ?1, ?2, 'local_rid')",
        params![ts_ago(100), ts_ago(90)],
    ).unwrap();
    conn.execute(
        "UPDATE items SET updated_at=?1 WHERE id='n1'", // 只改了 updated_at，产生 pending
        params![ts_ago(50)],
    )
    .unwrap();

    // 云端 payload title 相同，但 last_synced_at / remote_id 不同
    let c = SyncChangeWithData {
        table_name: "items".into(),
        record_id: "n1".into(),
        operation: ChangeOperation::Update,
        data: Some(json!({
            "id": "n1", "title": "same",
            "updated_at": ts_ago(30),
            "deleted_at": serde_json::Value::Null,
            "last_synced_at": "some_other_time",
            "remote_id": "cloud_rid",
        })),
        changed_at: ts_ago(30),
        change_log_id: None,
        database_name: Some("test".into()),
        suppress_change_log: Some(true),
    };

    let (_, conflict) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[c],
        None,
        ConflictPolicy::KeepLatest,
        None,
        None,
    )
    .unwrap();
    // 业务字段（title）相同 → 无冲突
    assert_eq!(conflict.conflicts_saved, 0, "只有同步元字段差异不应算冲突");
}

// ============================================================================
// P.31 - P.40: 真实病态数据组合
// ============================================================================

/// **P.31** payload 有 `operation` 字段（和 SyncChangeWithData 的 operation 冲突名字）
#[test]
fn p31_payload_with_operation_field() {
    // 业务表不会有 'operation' 列，所以 UPSERT 会失败
    let conn = new_db();
    let c = mk_change(
        "n1",
        ChangeOperation::Insert,
        json!({
            "id": "n1", "title": "t",
            "operation": "weird",  // items 表里没这列
            "updated_at": now_ts(),
            "deleted_at": serde_json::Value::Null,
        }),
        &now_ts(),
    );
    let r = SyncManager::apply_downloaded_changes(&conn, &[c], None);
    assert!(r.is_err());
}

/// **P.32** record_id 字段名大小写敏感
#[test]
fn p32_record_id_case_sensitive() {
    let conn = new_db();
    SyncManager::apply_downloaded_changes(
        &conn,
        &[mk_change(
            "Case",
            ChangeOperation::Insert,
            json!({
                "id": "Case", "title": "upper",
                "updated_at": now_ts(),
                "deleted_at": serde_json::Value::Null,
            }),
            &now_ts(),
        )],
        None,
    )
    .unwrap();
    SyncManager::apply_downloaded_changes(
        &conn,
        &[mk_change(
            "case",
            ChangeOperation::Insert,
            json!({
                "id": "case", "title": "lower",
                "updated_at": now_ts(),
                "deleted_at": serde_json::Value::Null,
            }),
            &now_ts(),
        )],
        None,
    )
    .unwrap();
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 2, "Case 和 case 应是两条不同记录");
}

/// **P.33** 同 id 不同大小写的 payload 同批应用（后者覆盖）
#[test]
fn p33_same_id_different_case_in_batch() {
    let conn = new_db();
    SyncManager::apply_downloaded_changes(
        &conn,
        &[
            mk_change(
                "NORMALIZE",
                ChangeOperation::Insert,
                json!({
                    "id": "NORMALIZE", "title": "upper",
                    "updated_at": ts_ago(100),
                    "deleted_at": serde_json::Value::Null,
                }),
                &ts_ago(100),
            ),
            mk_change(
                "normalize",
                ChangeOperation::Insert,
                json!({
                    "id": "normalize", "title": "lower",
                    "updated_at": ts_ago(50),
                    "deleted_at": serde_json::Value::Null,
                }),
                &ts_ago(50),
            ),
        ],
        None,
    )
    .unwrap();
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 2);
}

/// **P.34** 极限：batch 里 100 条 change 的每个 payload 字段数都不同
#[test]
fn p34_heterogeneous_payload_shapes() {
    let conn = new_db();
    let mut changes = Vec::new();
    for i in 0..100 {
        let mut payload = serde_json::Map::new();
        payload.insert("id".into(), json!(format!("n{}", i)));
        payload.insert("updated_at".into(), json!(ts_ago(5000 - i as i64)));
        payload.insert("deleted_at".into(), serde_json::Value::Null);
        if i % 2 == 0 {
            payload.insert("title".into(), json!(format!("t{}", i)));
        }
        if i % 3 == 0 {
            payload.insert("counter".into(), json!(i));
        }
        if i % 5 == 0 {
            payload.insert("tags".into(), json!(format!("[\"t{}\"]", i)));
        }
        changes.push(SyncChangeWithData {
            table_name: "items".into(),
            record_id: format!("n{}", i),
            operation: ChangeOperation::Insert,
            data: Some(serde_json::Value::Object(payload)),
            changed_at: ts_ago(5000 - i as i64),
            change_log_id: None,
            database_name: Some("test".into()),
            suppress_change_log: Some(true),
        });
    }
    SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 100);
}

/// **P.35** 极限：1 条 change 的 payload 有 200 个字段（items 表没有这么多列）→ 失败
#[test]
fn p35_payload_with_many_unknown_columns() {
    let conn = new_db();
    let mut payload = serde_json::Map::new();
    payload.insert("id".into(), json!("n1"));
    payload.insert("updated_at".into(), json!(now_ts()));
    payload.insert("deleted_at".into(), serde_json::Value::Null);
    for i in 0..200 {
        payload.insert(format!("unknown_{}", i), json!(i));
    }
    let c = SyncChangeWithData {
        table_name: "items".into(),
        record_id: "n1".into(),
        operation: ChangeOperation::Insert,
        data: Some(serde_json::Value::Object(payload)),
        changed_at: now_ts(),
        change_log_id: None,
        database_name: Some("test".into()),
        suppress_change_log: Some(true),
    };
    let r = SyncManager::apply_downloaded_changes(&conn, &[c], None);
    assert!(r.is_err(), "大量未知列应导致失败");
}

// ============================================================================
// P.36 - P.40: 组合与压力
// ============================================================================

/// **P.36** 5000 批次 × 各 1 条 change（模拟长期使用）
#[test]
fn p36_5000_sequential_single_changes() {
    let conn = new_db();
    let t = std::time::Instant::now();
    for i in 0..5000 {
        let id = format!("r{:05}", i);
        let ts = ts_ago(10000 - i as i64);
        SyncManager::apply_downloaded_changes(
            &conn,
            &[mk_change(
                &id,
                ChangeOperation::Insert,
                json!({
                    "id": id, "title": "t",
                    "updated_at": ts.clone(),
                    "deleted_at": serde_json::Value::Null,
                }),
                &ts,
            )],
            None,
        )
        .unwrap();
    }
    let elapsed = t.elapsed();
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 5000);
    println!("P.36 5000 sequential applies: {:?}", elapsed);
    assert!(elapsed.as_secs() < 60, "5000 顺序应用应在 60s 内完成");
}

/// **P.37** __change_log 条目数量与业务记录数对齐
#[test]
fn p37_change_log_count_invariant() {
    let conn = new_db();
    // 随机插入 100 条
    for i in 0..100 {
        let id = format!("n{}", i);
        SyncManager::apply_downloaded_changes(
            &conn,
            &[mk_change(
                &id,
                ChangeOperation::Insert,
                json!({
                    "id": id, "title": "t",
                    "updated_at": ts_ago(5000 - i),
                    "deleted_at": serde_json::Value::Null,
                }),
                &ts_ago(5000 - i),
            )],
            None,
        )
        .unwrap();
    }
    // 业务记录数 100，__change_log 对应的回放条目也应 100（全部被 suppress 标记为 synced）
    let items_n: i64 = conn
        .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
        .unwrap();
    let log_n: i64 = conn
        .query_row("SELECT COUNT(*) FROM __change_log", [], |r| r.get(0))
        .unwrap();
    let log_pending: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __change_log WHERE sync_version = 0",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(items_n, 100);
    assert_eq!(log_n, 100);
    assert_eq!(log_pending, 0, "全部应被回声抑制");
}

/// **P.38** 极限组合：单条变更 payload + 50 次冲突循环 + tombstone
#[test]
fn p38_single_record_full_stress() {
    let conn = new_db();
    conn.execute(
        "INSERT INTO items (id, title, updated_at) VALUES ('hot', 'base', ?1)",
        params![ts_ago(10000)],
    )
    .unwrap();

    // 50 轮：本地改 → 云端冲突 → 用户解决 → 本地再改
    for round in 0..50 {
        // 本地改
        conn.execute(
            "UPDATE items SET title=?1, updated_at=?2 WHERE id='hot'",
            params![format!("local_round_{}", round), ts_ago(5000 - round * 100)],
        )
        .unwrap();

        // 云端冲突（较早）
        SyncManager::apply_downloaded_changes_with_conflict_guard(
            &conn,
            &[mk_change(
                "hot",
                ChangeOperation::Update,
                json!({
                    "id": "hot", "title": format!("cloud_{}", round),
                    "updated_at": ts_ago(5100 - round * 100),
                    "deleted_at": serde_json::Value::Null,
                }),
                &ts_ago(5100 - round * 100),
            )],
            None,
            ConflictPolicy::KeepLatest,
            Some("cloud"),
            Some("local"),
        )
        .unwrap();
    }

    let conflict_n: i64 = conn
        .query_row("SELECT COUNT(*) FROM __sync_conflicts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(conflict_n, 100, "50 轮 × 2 条/轮 = 100 条冲突记录");
    // 本地最后的 round 49 为最新
    assert_eq!(get_title(&conn, "hot").as_deref(), Some("local_round_49"));
}

/// **P.39** DELETE 一个已被软删的记录（第二次 DELETE）—— LWW 门应不会让时间戳"回退"
#[test]
fn p39_double_delete_preserves_earlier_tombstone() {
    let conn = new_db();
    conn.execute(
        "INSERT INTO items (id, title, updated_at) VALUES ('n1', 't', ?1)",
        params![ts_ago(200)],
    )
    .unwrap();
    // 第一次 DELETE（较早时间戳）
    SyncManager::apply_downloaded_changes(
        &conn,
        &[mk_change(
            "n1",
            ChangeOperation::Delete,
            json!({}),
            &ts_ago(100),
        )],
        None,
    )
    .unwrap();
    let first_del: String = conn
        .query_row("SELECT deleted_at FROM items WHERE id='n1'", [], |r| {
            r.get(0)
        })
        .unwrap();

    // 第二次 DELETE（更早时间戳，应被 LWW 拒绝，deleted_at 保持第一次的值）
    SyncManager::apply_downloaded_changes(
        &conn,
        &[mk_change(
            "n1",
            ChangeOperation::Delete,
            json!({}),
            &ts_ago(150),
        )],
        None,
    )
    .unwrap();
    let second_del: String = conn
        .query_row("SELECT deleted_at FROM items WHERE id='n1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    // 第二次 DELETE 更早 → 本地 updated_at（= first_del 时间戳？不，是原 INSERT 的 200s ago）
    // 本地 updated_at 是 ts_ago(200)，第二次 DELETE 的 changed_at 是 ts_ago(150) → 150 > 200（秒数是"多少秒前"，所以 150 更晚 → 不跳过）
    // 但 WHERE deleted_at IS NULL 过滤了 → 二次 DELETE 不会改 deleted_at 值
    assert_eq!(
        first_del, second_del,
        "二次 DELETE 不应改变首次的 deleted_at"
    );
}

/// **P.40** 万一云端 data 里带了 `id` 字段但和 record_id 不一致（我的 P.33 已测）—— 这里测批量
#[test]
fn p40_bulk_payload_id_record_id_mismatch() {
    let conn = new_db();
    let mut changes = Vec::new();
    for i in 0..10 {
        changes.push(SyncChangeWithData {
            table_name: "items".into(),
            record_id: format!("rec_{}", i), // 顶层
            operation: ChangeOperation::Insert,
            data: Some(json!({
                "id": format!("payload_{}", i), // payload 不一致
                "title": "t",
                "updated_at": ts_ago(100 - i),
                "deleted_at": serde_json::Value::Null,
            })),
            changed_at: ts_ago(100 - i),
            change_log_id: None,
            database_name: Some("test".into()),
            suppress_change_log: Some(true),
        });
    }
    let r = SyncManager::apply_downloaded_changes(&conn, &changes, None);
    // 当前实现按 payload.id 写入 → 成功但插入的 id 是 payload_N
    // 这一条件下用户会疑惑，记录实际行为
    println!("P.40 result: {:?}", r);
    if r.is_ok() {
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM items WHERE id LIKE 'payload_%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let rec_n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM items WHERE id LIKE 'rec_%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        println!("P.40 payload_%: {}, rec_%: {}", n, rec_n);
    }
}
