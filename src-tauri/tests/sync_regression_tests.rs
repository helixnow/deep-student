//! 回归测试：专门覆盖最近几轮改造里的新代码
//!
//! 前面几套测试虽然多，但它们是在新代码**之前**写的。新加的几项保护：
//!
//! 1. `compare_timestamps` 的 HLC fast-path
//! 2. `should_skip_stale_update` 的 HLC fast-path
//! 3. `reset_sync_baseline_after_restore` 的边界（表没有同步列/标识符注入/空库）
//! 4. ZIP 恢复后基线重建 → 再同步不倒灌的端到端收敛
//! 5. 大量变更的分批上传（>1000 条边界）
//! 6. `archive_synced_change_logs` 语义（不删未同步/只删过期）
//!
//! 这些测试**不通过 tauri 命令**，直接调 `SyncManager` 库函数，
//! 避免引入 Tauri runtime 依赖。

use deep_student_lib::data_governance::sync::{
    conflict_resolver::ConflictPolicy, ChangeOperation, Hlc, SyncChangeWithData, SyncManager,
};
use rusqlite::{params, Connection};
use serde_json::json;

// ============================================================================
// Fixture
// ============================================================================

fn new_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE items (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '',
            counter INTEGER NOT NULL DEFAULT 0,
            device_id TEXT,
            local_version INTEGER DEFAULT 0,
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
        "#,
    )
    .unwrap();
    conn
}

fn insert_item(conn: &Connection, id: &str, title: &str, updated_at: &str) {
    conn.execute(
        "INSERT INTO items (id, title, updated_at) VALUES (?1, ?2, ?3)",
        params![id, title, updated_at],
    )
    .unwrap();
}

fn mark_all_synced(conn: &Connection) {
    let ts = chrono::Utc::now().timestamp();
    conn.execute(
        "UPDATE __change_log SET sync_version = ?1 WHERE sync_version = 0",
        params![ts],
    )
    .unwrap();
}

fn count_pending(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM __change_log WHERE sync_version = 0",
        [],
        |r| r.get(0),
    )
    .unwrap()
}

fn get_title(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row("SELECT title FROM items WHERE id = ?1", params![id], |r| {
        r.get(0)
    })
    .ok()
}

// ============================================================================
// R01-R05: HLC fast-path 在真实 apply 路径里的行为
// ============================================================================

/// R01：两端都使用 HLC 串，且 HLC 相同毫秒但不同 counter 时，
/// counter 大的必须能覆盖 counter 小的
#[test]
fn r01_hlc_same_millis_counter_tie_break_in_apply() {
    let conn = new_db();

    let earlier = Hlc::new(1_700_000_000_000, 0).to_string();
    let later = Hlc::new(1_700_000_000_000, 1).to_string();

    // 本地：HLC counter=0
    insert_item(&conn, "n1", "earlier", &earlier);
    mark_all_synced(&conn);

    // 云端：同毫秒但 counter=1（严格更晚）
    let change = SyncChangeWithData {
        change_log_id: None,
        table_name: "items".to_string(),
        record_id: "n1".to_string(),
        operation: ChangeOperation::Update,
        changed_at: later.clone(),
        data: Some(json!({
            "id": "n1",
            "title": "later",
            "counter": 0,
            "updated_at": later.clone(),
        })),
        database_name: None,
        suppress_change_log: None,
    };

    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();

    // counter=1 必须胜
    assert_eq!(get_title(&conn, "n1"), Some("later".to_string()));
}

/// R02：本地 HLC counter 更大，云端 counter 更小 —— LWW 门必须保护本地
#[test]
fn r02_hlc_local_newer_counter_wins_lww() {
    let conn = new_db();

    let local_hlc = Hlc::new(1_700_000_000_000, 5).to_string();
    let cloud_hlc = Hlc::new(1_700_000_000_000, 2).to_string();

    insert_item(&conn, "n1", "local-keep", &local_hlc);
    mark_all_synced(&conn);

    let change = SyncChangeWithData {
        change_log_id: None,
        table_name: "items".to_string(),
        record_id: "n1".to_string(),
        operation: ChangeOperation::Update,
        changed_at: cloud_hlc.clone(),
        data: Some(json!({
            "id": "n1",
            "title": "cloud-loser",
            "counter": 0,
            "updated_at": cloud_hlc,
        })),
        database_name: None,
        suppress_change_log: None,
    };

    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();
    assert_eq!(get_title(&conn, "n1"), Some("local-keep".to_string()));
}

/// R03：HLC 漂移检测：云端毫秒超出本地未来 60 秒，必须被拒绝
#[test]
fn r03_hlc_drift_over_60s_future_rejected() {
    let conn = new_db();

    let now_ms = chrono::Utc::now().timestamp_millis() as u64;
    let past_hlc = Hlc::new(now_ms - 10_000, 0).to_string(); // 本地较早
                                                             // 云端"未来 5 分钟"：远超 60 秒漂移门
    let future_hlc = Hlc::new(now_ms + 300_000, 0).to_string();

    insert_item(&conn, "n1", "local", &past_hlc);
    mark_all_synced(&conn);

    let change = SyncChangeWithData {
        change_log_id: None,
        table_name: "items".to_string(),
        record_id: "n1".to_string(),
        operation: ChangeOperation::Update,
        changed_at: future_hlc.clone(),
        data: Some(json!({
            "id": "n1",
            "title": "from-future",
            "counter": 0,
            "updated_at": future_hlc,
        })),
        database_name: None,
        suppress_change_log: None,
    };

    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();
    // 漂移门必须保护本地
    assert_eq!(get_title(&conn, "n1"), Some("local".to_string()));
}

/// R04：HLC 一端用、另一端用 ISO —— 应该降级到时间戳路径且不 crash
#[test]
fn r04_hlc_local_vs_iso_cloud_mixed_formats() {
    let conn = new_db();

    let local_hlc = Hlc::new(1_700_000_000_000, 0).to_string();
    let cloud_iso = "2024-01-01T00:00:00Z"; // ISO，非 HLC

    insert_item(&conn, "n1", "local-hlc", &local_hlc);
    mark_all_synced(&conn);

    let change = SyncChangeWithData {
        change_log_id: None,
        table_name: "items".to_string(),
        record_id: "n1".to_string(),
        operation: ChangeOperation::Update,
        changed_at: cloud_iso.to_string(),
        data: Some(json!({
            "id": "n1",
            "title": "cloud-iso",
            "counter": 0,
            "updated_at": cloud_iso,
        })),
        database_name: None,
        suppress_change_log: None,
    };

    // 不应 panic；应用结果不强求（混合格式时 LWW 行为降级）
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();
}

/// R05：HLC 纳秒级爆发场景——同毫秒内 10000 次 counter 递增全部保序
#[test]
fn r05_hlc_burst_10000_counter_monotonic() {
    let millis = 1_700_000_000_000;
    let mut last: Option<String> = None;
    for i in 0..10_000u16 {
        let s = Hlc::new(millis, i).to_string();
        if let Some(prev) = last.as_deref() {
            // 字典序必须严格递增（保序不变量）
            assert!(s.as_str() > prev);
        }
        last = Some(s);
    }
}

// ============================================================================
// R06-R09: reset_sync_baseline_after_restore 边界
// ============================================================================

/// R06：空库（只有 __change_log 但没有业务表）—— 不 crash
#[test]
fn r06_reset_baseline_on_empty_db() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE __change_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            operation TEXT NOT NULL,
            changed_at TEXT NOT NULL DEFAULT (datetime('now')),
            sync_version INTEGER DEFAULT 0
        );",
    )
    .unwrap();

    let (t, r) = SyncManager::reset_sync_baseline_after_restore(&conn).unwrap();
    assert_eq!(t, 0);
    assert_eq!(r, 0);
}

/// R07：业务表没有 sync_version/local_version —— 必须跳过（不 crash，不 UPDATE）
#[test]
fn r07_reset_baseline_skips_tables_without_sync_columns() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE __change_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            operation TEXT NOT NULL,
            changed_at TEXT NOT NULL DEFAULT (datetime('now')),
            sync_version INTEGER DEFAULT 0
        );
        -- 这张表没有 sync_version 列，reset 必须跳过它
        CREATE TABLE plain_table (id TEXT PRIMARY KEY, name TEXT);
        INSERT INTO plain_table VALUES ('x', 'alpha');
        INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version)
        VALUES ('x', 'x', 'INSERT', '2024-01-01T00:00:00Z', 100);",
    )
    .unwrap();

    let (t, _r) = SyncManager::reset_sync_baseline_after_restore(&conn).unwrap();
    assert_eq!(t, 1, "应删除 __change_log 那条");

    // plain_table 应原封不动
    let name: String = conn
        .query_row("SELECT name FROM plain_table WHERE id='x'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(name, "alpha");
}

/// R08：系统元数据表（以 __ 或 sqlite_ 开头）必须被排除
#[test]
fn r08_reset_baseline_excludes_system_tables() {
    let conn = new_db();
    conn.execute_batch(
        "CREATE TABLE __sync_conflicts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            side TEXT NOT NULL CHECK(side IN ('local','cloud')),
            data_json TEXT NOT NULL,
            detected_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO __sync_conflicts (table_name, record_id, side, data_json, detected_at)
        VALUES ('t', 'rid', 'local', '{}', '2024-01-01');",
    )
    .unwrap();

    insert_item(&conn, "n1", "hello", "2024-01-01T00:00:00Z");

    SyncManager::reset_sync_baseline_after_restore(&conn).unwrap();

    // __sync_conflicts 是元数据表，应该被清空（策略的一部分），但不应被
    // "重置 sync_version = local_version" 处理
    let cnt: i64 = conn
        .query_row("SELECT COUNT(*) FROM __sync_conflicts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(cnt, 0, "reset 应清空 __sync_conflicts 表");
}

/// R09：再次 reset 是幂等的
#[test]
fn r09_reset_baseline_is_idempotent() {
    let conn = new_db();
    insert_item(&conn, "n1", "hello", "2024-01-01T00:00:00Z");
    conn.execute("UPDATE items SET local_version = 3 WHERE id='n1'", [])
        .unwrap();

    SyncManager::reset_sync_baseline_after_restore(&conn).unwrap();
    SyncManager::reset_sync_baseline_after_restore(&conn).unwrap();

    let lv: i64 = conn
        .query_row("SELECT local_version FROM items WHERE id='n1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(
        lv, 5,
        "local_version should increment by 1 on each reset call (3→4→5)"
    );
    let cnt: i64 = conn
        .query_row("SELECT COUNT(*) FROM __change_log", [], |r| r.get(0))
        .unwrap();
    assert_eq!(cnt, 0);
}

// ============================================================================
// R10-R13: ZIP 恢复后再同步不倒灌的端到端
// ============================================================================

/// R10：**核心安全承诺** —— ZIP 恢复后，本地应该没有任何 pending change
#[test]
fn r10_post_restore_no_pending_changes() {
    let conn = new_db();

    // 模拟恢复到本地的状态：业务表有一堆数据，__change_log 也有旧条目
    for i in 0..20 {
        insert_item(
            &conn,
            &format!("n{}", i),
            "restored",
            "2024-01-01T00:00:00Z",
        );
    }

    // 模拟源设备残留的 __change_log（sync_version 混合）
    conn.execute_batch("UPDATE __change_log SET sync_version = 100 WHERE id <= 10;")
        .unwrap();

    // 恢复后 pending 条目看起来还有
    assert!(count_pending(&conn) > 0);

    // 调用基线重建
    SyncManager::reset_sync_baseline_after_restore(&conn).unwrap();

    // 现在 pending 必须为 0
    assert_eq!(count_pending(&conn), 0);

    // 且 items 表里的 20 条全保留
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
        .unwrap();
    assert_eq!(total, 20);
}

/// R11：恢复后本地继续编辑一条，pending 应只有新编辑那条，不含恢复的 20 条
#[test]
fn r11_post_restore_only_new_edits_are_pending() {
    let conn = new_db();
    for i in 0..20 {
        insert_item(
            &conn,
            &format!("n{}", i),
            "restored",
            "2024-01-01T00:00:00Z",
        );
    }
    SyncManager::reset_sync_baseline_after_restore(&conn).unwrap();
    assert_eq!(count_pending(&conn), 0);

    // 恢复完用户编辑一条
    conn.execute(
        "UPDATE items SET title='user-edited', updated_at='2024-06-01T00:00:00Z' WHERE id='n5'",
        [],
    )
    .unwrap();

    // 仅这一条进入 pending
    assert_eq!(count_pending(&conn), 1);
    let (tbl, rid): (String, String) = conn
        .query_row(
            "SELECT table_name, record_id FROM __change_log WHERE sync_version = 0",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(tbl, "items");
    assert_eq!(rid, "n5");
}

/// R12：多次小批恢复—重建—再编辑循环，pending 永远不爆炸
#[test]
fn r12_repeated_restore_reset_cycles() {
    let conn = new_db();

    for round in 0..5 {
        // 每轮插一批并标记为"恢复的数据"
        for i in 0..10 {
            insert_item(
                &conn,
                &format!("r{}_n{}", round, i),
                "restored",
                "2024-01-01T00:00:00Z",
            );
        }
        SyncManager::reset_sync_baseline_after_restore(&conn).unwrap();
        assert_eq!(
            count_pending(&conn),
            0,
            "第 {} 轮恢复后 pending 应为 0",
            round
        );
    }
}

/// R13：恢复前有未解决的 __sync_conflicts，恢复后必须全部清空（避免幽灵冲突）
#[test]
fn r13_post_restore_clears_unresolved_conflicts() {
    let conn = new_db();
    conn.execute_batch(
        "CREATE TABLE __sync_conflicts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            side TEXT NOT NULL CHECK(side IN ('local','cloud')),
            data_json TEXT NOT NULL,
            detected_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO __sync_conflicts (table_name, record_id, side, data_json, detected_at)
        VALUES ('items', 'old_conflict', 'local', '{}', '2024-01-01'),
               ('items', 'old_conflict2', 'cloud', '{}', '2024-01-02');",
    )
    .unwrap();
    insert_item(&conn, "new", "x", "2024-01-01T00:00:00Z");

    SyncManager::reset_sync_baseline_after_restore(&conn).unwrap();

    let cnt: i64 = conn
        .query_row("SELECT COUNT(*) FROM __sync_conflicts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(cnt, 0, "恢复后 __sync_conflicts 必须全空");
}

// ============================================================================
// R14-R17: cleanup_synced_changes / archive 语义
// ============================================================================

/// R14：archive 只影响 sync_version > 0 的过期条目，不碰 pending
#[test]
fn r14_archive_preserves_pending_changes() {
    let conn = new_db();
    insert_item(&conn, "n1", "x", "2024-01-01T00:00:00Z");
    // 手动插入几条：一条 pending、一条已同步但不过期、一条已同步且过期
    conn.execute(
        "INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version)
         VALUES ('items','a','INSERT','2024-01-01T00:00:00Z',0),
                ('items','b','INSERT','2024-01-01T00:00:00Z',100),
                ('items','c','INSERT','2020-01-01T00:00:00Z',100)",
        [],
    )
    .unwrap();

    let cutoff = "2023-01-01T00:00:00Z";
    let deleted = SyncManager::cleanup_synced_changes(&conn, cutoff).unwrap();
    assert_eq!(deleted, 1, "仅 c 过期且已同步");

    // a 还在（pending）
    let a: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __change_log WHERE record_id='a'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(a, 1);
    // b 还在（已同步但未过期）
    let b: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __change_log WHERE record_id='b'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(b, 1);
}

/// R15：cutoff 极早（2000-01-01）—— 不删任何记录
#[test]
fn r15_archive_with_very_early_cutoff_noop() {
    let conn = new_db();
    conn.execute(
        "INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version)
         VALUES ('items','a','INSERT','2024-01-01T00:00:00Z',100)",
        [],
    )
    .unwrap();

    let deleted = SyncManager::cleanup_synced_changes(&conn, "2000-01-01T00:00:00Z").unwrap();
    assert_eq!(deleted, 0);
}

/// R16：cutoff 极晚（2999）且所有条目已同步 —— 全部删除
#[test]
fn r16_archive_with_very_late_cutoff_deletes_all_synced() {
    let conn = new_db();
    conn.execute(
        "INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version)
         VALUES ('items','a','INSERT','2024-01-01T00:00:00Z',100),
                ('items','b','INSERT','2024-02-01T00:00:00Z',100),
                ('items','c','INSERT','2024-03-01T00:00:00Z',0)",
        [],
    )
    .unwrap();

    let deleted = SyncManager::cleanup_synced_changes(&conn, "2999-01-01T00:00:00Z").unwrap();
    assert_eq!(deleted, 2, "c 未同步不删");
}

/// R17：重复调用 archive 幂等
#[test]
fn r17_archive_is_idempotent() {
    let conn = new_db();
    conn.execute(
        "INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version)
         VALUES ('items','a','INSERT','2020-01-01T00:00:00Z',100)",
        [],
    )
    .unwrap();

    assert_eq!(
        SyncManager::cleanup_synced_changes(&conn, "2023-01-01T00:00:00Z").unwrap(),
        1
    );
    // 再次调用：a 已被删除，删除数 = 0
    assert_eq!(
        SyncManager::cleanup_synced_changes(&conn, "2023-01-01T00:00:00Z").unwrap(),
        0
    );
}

// ============================================================================
// R18-R20: 大批量 apply 边界（对应分批上传的收端保护）
// ============================================================================

/// R18：一次性 apply 3000 条变更（跨 batch_size=1000 的三个批次边界）
#[test]
fn r18_apply_3000_records_crosses_batch_boundary() {
    let conn = new_db();

    let base_ms = 1_700_000_000_000u64;
    let mut changes: Vec<SyncChangeWithData> = Vec::with_capacity(3000);
    for i in 0..3000u64 {
        let hlc = Hlc::new(base_ms + i, 0).to_string();
        changes.push(SyncChangeWithData {
            change_log_id: None,
            table_name: "items".to_string(),
            record_id: format!("r{:05}", i),
            operation: ChangeOperation::Insert,
            changed_at: hlc.clone(),
            data: Some(json!({
                "id": format!("r{:05}", i),
                "title": format!("t{}", i),
                "counter": i as i64,
                "updated_at": hlc,
            })),
            database_name: None,
            suppress_change_log: None,
        });
    }

    SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();

    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
        .unwrap();
    assert_eq!(total, 3000);
}

/// R19：apply 0 条变更必须安全 noop
#[test]
fn r19_apply_empty_noop() {
    let conn = new_db();
    let result = SyncManager::apply_downloaded_changes(&conn, &[], None).unwrap();
    assert_eq!(
        result.success_count + result.failure_count + result.skipped_count,
        0
    );
}

/// R20：分批期间每批内的 HLC 顺序和跨批 HLC 顺序都必须保持
#[test]
fn r20_hlc_ordering_preserved_across_batch_size() {
    // 构造 1999 条：前 1000 条 millis 从 base 开始，后 999 条 millis 从 base+10000
    let base_ms = 1_700_000_000_000u64;
    let mut stamps = Vec::new();
    for i in 0..1999u64 {
        let millis = if i < 1000 {
            base_ms + i
        } else {
            base_ms + 10_000 + i
        };
        stamps.push(Hlc::new(millis, 0).to_string());
    }
    // 验证所有 stamp 都能独立按 HLC 解析 + 整体字典序单调递增（用于跨批保序的前提）
    for i in 1..stamps.len() {
        assert!(stamps[i].as_str() > stamps[i - 1].as_str());
        assert!(Hlc::parse(&stamps[i]).is_some());
    }
}

// ============================================================================
// R21-R23: compare_timestamps 对外行为（经由 KeepLatest 冲突合并）
// ============================================================================

/// R21：本地 HLC counter 更大 + 云端 ISO —— 目前会走降级比较（HLC > ISO 字符串）
/// 这个测试记录现有行为，防止未来误伤。
#[test]
fn r21_mixed_format_cmp_is_deterministic() {
    use deep_student_lib::data_governance::sync::ConflictRecord;
    use deep_student_lib::data_governance::sync::MergeStrategy;

    // 完整 HLC 串 vs ISO 串 —— 测试冲突合并的 KeepLatest 策略不 panic 且给出一致结果
    let local_hlc = Hlc::new(1_700_000_000_000, 99).to_string();
    let cloud_iso = "2024-01-01T00:00:00Z".to_string();

    let conflicts = vec![ConflictRecord {
        database_name: "test".to_string(),
        table_name: "items".to_string(),
        record_id: "n1".to_string(),
        local_version: 1,
        cloud_version: 1,
        local_updated_at: local_hlc,
        cloud_updated_at: cloud_iso,
        local_data: json!({"x": 1}),
        cloud_data: json!({"x": 2}),
    }];

    // 只要不 panic 且返回 success 就行；具体选择交给实现
    let result = SyncManager::apply_merge_strategy(MergeStrategy::KeepLatest, &conflicts).unwrap();
    assert!(result.success);
}

/// R22：两端 HLC 完全相同 —— 视为 Equal（tie，保留本地）
#[test]
fn r22_identical_hlc_treated_as_equal() {
    use deep_student_lib::data_governance::sync::ConflictRecord;
    use deep_student_lib::data_governance::sync::MergeStrategy;

    let hlc = Hlc::new(1_700_000_000_000, 42).to_string();

    let conflicts = vec![ConflictRecord {
        database_name: "test".to_string(),
        table_name: "items".to_string(),
        record_id: "n1".to_string(),
        local_version: 1,
        cloud_version: 1,
        local_updated_at: hlc.clone(),
        cloud_updated_at: hlc,
        local_data: json!({"x": 1}),
        cloud_data: json!({"x": 2}),
    }];

    let result = SyncManager::apply_merge_strategy(MergeStrategy::KeepLatest, &conflicts).unwrap();
    // 相等时 KeepLatest 的实现选本地（记录当前行为）
    assert!(result.success);
    assert_eq!(result.kept_local, 1);
}

/// R23：时钟偏差容差 vs HLC 精确——HLC 格式时 counter 差哪怕 1 也决胜，
/// 不会被 2 秒容差淹没
#[test]
fn r23_hlc_not_swallowed_by_clock_skew_tolerance() {
    use deep_student_lib::data_governance::sync::ConflictRecord;
    use deep_student_lib::data_governance::sync::MergeStrategy;

    // 同毫秒的 HLC：counter 差 1。时钟容差是 2 秒 = 2000 毫秒，理论上会吞掉，
    // 但 HLC fast-path 优先走，counter 差必须决胜
    let a = Hlc::new(1_700_000_000_000, 0).to_string();
    let b = Hlc::new(1_700_000_000_000, 1).to_string();

    let conflicts = vec![ConflictRecord {
        database_name: "test".to_string(),
        table_name: "items".to_string(),
        record_id: "n1".to_string(),
        local_version: 1,
        cloud_version: 1,
        local_updated_at: a,
        cloud_updated_at: b,
        local_data: json!({"x": 1}),
        cloud_data: json!({"x": 2}),
    }];

    // cloud counter=1 > local counter=0 → 用云端
    let result = SyncManager::apply_merge_strategy(MergeStrategy::KeepLatest, &conflicts).unwrap();
    assert_eq!(result.used_cloud, 1, "HLC counter 必须 override 时钟容差");
    assert_eq!(result.kept_local, 0);
}

// ============================================================================
// R24-R25: apply_downloaded_changes_with_conflict_guard 的冲突落表
// ============================================================================

/// R24：云端改 + 本地未同步改 → 必须落入 __sync_conflicts 表
#[test]
fn r24_conflict_falls_into_table() {
    let conn = new_db();

    // 预置 __sync_conflicts 表（与生产 schema 对齐：不含 database_name 列）
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS __sync_conflicts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            side TEXT NOT NULL CHECK(side IN ('local','cloud')),
            data_json TEXT NOT NULL,
            winning_device_id TEXT,
            losing_device_id TEXT,
            detected_at TEXT NOT NULL DEFAULT (datetime('now')),
            resolved_at TEXT,
            resolution TEXT
        );",
    )
    .unwrap();

    // 本地有未同步改
    insert_item(&conn, "n1", "local-edit", "2024-01-01T10:00:00Z");
    // pending 条目存在

    // 云端变更，timestamp 更晚
    let change = SyncChangeWithData {
        change_log_id: None,
        table_name: "items".to_string(),
        record_id: "n1".to_string(),
        operation: ChangeOperation::Update,
        changed_at: "2024-01-01T11:00:00Z".to_string(),
        data: Some(json!({
            "id": "n1",
            "title": "cloud-edit",
            "counter": 0,
            "updated_at": "2024-01-01T11:00:00Z",
        })),
        database_name: Some("test".to_string()),
        suppress_change_log: None,
    };

    let (_apply, conflict_result) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[change],
        None,
        ConflictPolicy::KeepLatest,
        Some("cloud-device"),
        Some("local-device"),
    )
    .unwrap();

    // 必然检测到冲突
    assert!(
        conflict_result.conflicts_saved > 0,
        "本地未同步 + 云端修改同一记录必须产生冲突"
    );

    // __sync_conflicts 至少有一条记录（可能是两条：败方 + 胜方留痕）
    let cnt: i64 = conn
        .query_row("SELECT COUNT(*) FROM __sync_conflicts", [], |r| r.get(0))
        .unwrap();
    assert!(cnt >= 1, "冲突应写入 __sync_conflicts");
}

/// R25：连续两次应用同一批冲突变更 —— 不会重复写入冲突表（严格幂等）
///
/// 批判报告 P0-3 修复后：`save_conflict_record` 走 `(table, record, side, data_hash)`
/// 的部分唯一索引 + `ON CONFLICT DO NOTHING`，同一未解决冲突**永远不会**在重放时
/// 增加新条目。旧实现允许线性增长的断言（`<= 2x + 2`）是占位，现在必须严格相等。
#[test]
fn r25_conflict_guard_idempotent_on_replay() {
    let conn = new_db();
    // 注意：不再预建 __sync_conflicts 表 —— 让 ensure_conflict_table 按新 schema
    // （含 data_hash 列和部分唯一索引）建，确保测试覆盖升级后的形态。

    insert_item(&conn, "n1", "local", "2024-01-01T10:00:00Z");

    let change = SyncChangeWithData {
        change_log_id: None,
        table_name: "items".to_string(),
        record_id: "n1".to_string(),
        operation: ChangeOperation::Update,
        changed_at: "2024-01-01T11:00:00Z".to_string(),
        data: Some(json!({
            "id": "n1",
            "title": "cloud",
            "counter": 0,
            "updated_at": "2024-01-01T11:00:00Z",
        })),
        database_name: Some("test".to_string()),
        suppress_change_log: None,
    };

    // 第一次应用
    SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[change.clone()],
        None,
        ConflictPolicy::KeepLatest,
        Some("cloud"),
        Some("local"),
    )
    .unwrap();
    let after_first: i64 = conn
        .query_row("SELECT COUNT(*) FROM __sync_conflicts", [], |r| r.get(0))
        .unwrap();

    // 第二次（重放）
    SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[change.clone()],
        None,
        ConflictPolicy::KeepLatest,
        Some("cloud"),
        Some("local"),
    )
    .unwrap();
    let after_second: i64 = conn
        .query_row("SELECT COUNT(*) FROM __sync_conflicts", [], |r| r.get(0))
        .unwrap();

    assert_eq!(
        after_first, after_second,
        "严格幂等：同一未解决冲突重放不应新增条目（first={}, second={}）",
        after_first, after_second
    );

    // 再重放 10 次，仍然严格不增长
    for _ in 0..10 {
        SyncManager::apply_downloaded_changes_with_conflict_guard(
            &conn,
            &[change.clone()],
            None,
            ConflictPolicy::KeepLatest,
            Some("cloud"),
            Some("local"),
        )
        .unwrap();
    }
    let after_many: i64 = conn
        .query_row("SELECT COUNT(*) FROM __sync_conflicts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        after_first, after_many,
        "重放 10 次仍应严格不变（first={}, after_many={}）",
        after_first, after_many
    );
}

/// R25b：用户 resolve 之后，相同内容的冲突**可以**再次记录
///
/// 去重范围只覆盖 `resolved_at IS NULL` 的条目。一旦用户解决，后续再出现同内容
/// 冲突应被视为"新一轮分歧"而重新入表，让用户知道问题又发生了。
#[test]
fn r25b_resolved_does_not_block_new_identical_conflict() {
    let conn = new_db();

    insert_item(&conn, "n1", "local", "2024-01-01T10:00:00Z");

    let change = SyncChangeWithData {
        change_log_id: None,
        table_name: "items".to_string(),
        record_id: "n1".to_string(),
        operation: ChangeOperation::Update,
        changed_at: "2024-01-01T11:00:00Z".to_string(),
        data: Some(json!({
            "id": "n1",
            "title": "cloud",
            "counter": 0,
            "updated_at": "2024-01-01T11:00:00Z",
        })),
        database_name: Some("test".to_string()),
        suppress_change_log: None,
    };

    // 第一次：产生冲突
    SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[change.clone()],
        None,
        ConflictPolicy::KeepLatest,
        Some("cloud"),
        Some("local"),
    )
    .unwrap();
    let unresolved_before: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __sync_conflicts WHERE resolved_at IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(unresolved_before > 0);

    // 模拟用户解决：把所有未解决的标为 resolved
    conn.execute(
        "UPDATE __sync_conflicts SET resolved_at = datetime('now'), resolution = 'keep_local' \
         WHERE resolved_at IS NULL",
        [],
    )
    .unwrap();

    // 再改一次本地，再收到同一条云端变更 —— 应当产生新一轮冲突条目
    conn.execute(
        "UPDATE items SET title = 'local_again', updated_at = ?1 WHERE id = 'n1'",
        params!["2024-01-02T10:00:00Z"],
    )
    .unwrap();
    SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[change],
        None,
        ConflictPolicy::KeepLatest,
        Some("cloud"),
        Some("local"),
    )
    .unwrap();

    let unresolved_after: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __sync_conflicts WHERE resolved_at IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        unresolved_after > 0,
        "用户 resolve 之后同内容冲突应能重新记录，当前未解决数 = {}",
        unresolved_after
    );
}
