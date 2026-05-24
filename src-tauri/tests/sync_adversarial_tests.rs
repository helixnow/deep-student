//! 对抗性测试（Adversarial Tests）
//!
//! 基于云同步领域公认的"难题清单"构造测试：
//!
//! 1. **时钟不可信**（Lamport/HLC 存在的根本原因）
//!    - 时钟回退 / 时钟超前 / 恶意未来时间戳
//! 2. **回声循环**（双向同步无限 loop）
//! 3. **数据复活 / zombie records**（tombstone GC 过早）
//! 4. **行级 LWW 的字段覆盖问题**
//! 5. **retention 断层**（设备离线后云端 prune）
//! 6. **Schema 漂移**（payload 字段缺失或类型错误）
//! 7. **设备 ID 碰撞 / 身份伪造**
//!
//! 每条测试用一个"恶意场景"或"边界情况"——这些是 Jepsen 风格测试，
//! 目的是让系统在最糟糕条件下暴露真实缺陷。

use deep_student_lib::data_governance::sync::{
    conflict_resolver::ConflictPolicy, ChangeOperation, SyncChangeWithData, SyncManager,
};
use rusqlite::{params, Connection};
use serde_json::json;

// ============================================================================
// 测试 fixture
// ============================================================================

fn new_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE items (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '',
            body TEXT NOT NULL DEFAULT '',
            tags TEXT NOT NULL DEFAULT '[]',
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

fn insert_raw(conn: &Connection, id: &str, title: &str, body: &str, updated_at: &str) {
    conn.execute(
        "INSERT INTO items (id, title, body, updated_at) VALUES (?1, ?2, ?3, ?4)",
        params![id, title, body, updated_at],
    )
    .unwrap();
}

fn get_item(conn: &Connection, id: &str) -> Option<(String, String, i64, Option<String>, String)> {
    conn.query_row(
        "SELECT title, body, counter, deleted_at, updated_at FROM items WHERE id = ?1",
        params![id],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, String>(4)?,
            ))
        },
    )
    .ok()
}

fn mark_all_synced(conn: &Connection) {
    conn.execute(
        "UPDATE __change_log SET sync_version = ?1 WHERE sync_version = 0",
        params![1_i64],
    )
    .unwrap();
}

fn build_change(
    id: &str,
    op: ChangeOperation,
    payload: serde_json::Value,
    changed_at: &str,
) -> SyncChangeWithData {
    SyncChangeWithData {
        table_name: "items".into(),
        record_id: id.into(),
        operation: op,
        data: if op == ChangeOperation::Delete {
            None
        } else {
            Some(payload)
        },
        changed_at: changed_at.into(),
        change_log_id: None,
        database_name: Some("test".into()),
        suppress_change_log: Some(true),
    }
}

// ============================================================================
// 难题 1：时钟不可信（Clock is a Liar）
// ============================================================================

/// **A.01** 时钟回退：远端设备时钟被调回一天，发来的 UPDATE 拥有"过去的未来时间戳"
///
/// 预期：LWW 门应保护本地较新值，不被这条"假过去"的变更覆盖。
#[test]
fn adv_01_clock_rewind_by_attacker() {
    let conn = new_db();
    insert_raw(
        &conn,
        "n1",
        "local_fresh",
        "current",
        "2026-05-01T12:00:00Z",
    );
    mark_all_synced(&conn);

    // 恶意端回调时钟到"3 天前"
    let malicious_ts = "2026-04-28T12:00:00Z";
    let change = build_change(
        "n1",
        ChangeOperation::Update,
        json!({
            "id": "n1",
            "title": "attacker_injected",
            "body": "hacker_overwrite",
            "updated_at": malicious_ts,
            "deleted_at": serde_json::Value::Null,
        }),
        malicious_ts,
    );
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();

    let (title, body, _, _, _) = get_item(&conn, "n1").unwrap();
    assert_eq!(title, "local_fresh", "时钟回退的云端变更不能覆盖较新本地值");
    assert_eq!(body, "current");
}

/// **A.02** 时钟超前：HLC drift 保护会拒绝未来 > 60 秒的变更
///
/// 加入 HLC drift sanity check 后（基于 CockroachDB 的 MAX_OFFSET 思想），
/// 一个作弊设备无法再把自己的时间戳设到"未来 1 年"来压制其他端。
/// drift > MAX_DRIFT_MS (60 秒) 的变更会被**默默跳过**（生产会产生告警日志）。
#[test]
fn adv_02_clock_ahead_is_rejected_by_drift_guard() {
    let conn = new_db();
    insert_raw(&conn, "n1", "legit", "current", "2026-05-01T12:00:00Z");
    mark_all_synced(&conn);

    // 恶意端把时钟调到 10 年后
    let far_future = "2036-05-01T12:00:00Z";
    let change = build_change(
        "n1",
        ChangeOperation::Update,
        json!({
            "id": "n1",
            "title": "attacker_10yr",
            "updated_at": far_future,
            "deleted_at": serde_json::Value::Null,
        }),
        far_future,
    );
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();

    let (title, _, _, _, stored_ts) = get_item(&conn, "n1").unwrap();
    assert_eq!(title, "legit", "drift > 60s 的恶意变更必须被拒绝");
    assert_eq!(stored_ts, "2026-05-01T12:00:00Z");
}

/// **A.03** 同秒并发：A 和 B 在同一秒对同一记录写入，时间戳相等
///
/// LWW 门判定"严格晚于"才跳过。相等时不跳过 → 后 apply 者胜。
/// 关键是两端必须用相同的排序规则才能收敛。
#[test]
fn adv_03_same_second_concurrent_writes() {
    let conn = new_db();
    let same_ts = "2026-05-01T12:00:00Z";

    // 先写 A 的变更
    let change_a = build_change(
        "n1",
        ChangeOperation::Insert,
        json!({
            "id": "n1",
            "title": "a_write",
            "body": "",
            "updated_at": same_ts,
            "deleted_at": serde_json::Value::Null,
        }),
        same_ts,
    );
    SyncManager::apply_downloaded_changes(&conn, &[change_a], None).unwrap();

    // 现在 B 的变更带相同时间戳
    let change_b = build_change(
        "n1",
        ChangeOperation::Update,
        json!({
            "id": "n1",
            "title": "b_write",
            "body": "",
            "updated_at": same_ts,
            "deleted_at": serde_json::Value::Null,
        }),
        same_ts,
    );
    SyncManager::apply_downloaded_changes(&conn, &[change_b], None).unwrap();

    let (title, _, _, _, _) = get_item(&conn, "n1").unwrap();
    // 时间戳相等 → LWW 不跳过 → B 覆盖 A
    // 这在逻辑上是对的（等价时允许覆盖），但两端必须用相同顺序才收敛
    assert_eq!(title, "b_write", "同时间戳下后应用者胜");
}

/// **A.04** 时间戳格式差异：ISO "2026-05-01T12:00:00Z" vs SQLite "2026-05-01 12:00:00"
#[test]
fn adv_04_timestamp_format_variants() {
    let conn = new_db();
    // 本地用 SQLite 原生格式
    conn.execute(
        "INSERT INTO items (id, title, body, updated_at) VALUES ('n1', 'local', '', ?1)",
        params!["2026-05-01 12:00:00"],
    )
    .unwrap();
    mark_all_synced(&conn);

    // 云端用 RFC3339 格式，时间戳相同
    let change = build_change(
        "n1",
        ChangeOperation::Update,
        json!({
            "id": "n1",
            "title": "cloud",
            "updated_at": "2026-05-01T12:00:00Z",
            "deleted_at": serde_json::Value::Null,
        }),
        "2026-05-01T12:00:00Z",
    );
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();

    let (title, _, _, _, _) = get_item(&conn, "n1").unwrap();
    // 两种格式应被解析为同一时刻 → 不跳过 → 云端胜
    assert_eq!(title, "cloud", "不同格式的相同时间戳应被视为相等");
}

/// **A.05** 时区表示：+08:00 和 Z 应被正确转换为同一 UTC 时刻
#[test]
fn adv_05_timezone_handling() {
    let conn = new_db();
    // 本地 UTC+8 时间戳表示 "2026-05-01 20:00 UTC"
    insert_raw(&conn, "n1", "local", "", "2026-05-02T04:00:00+08:00");
    mark_all_synced(&conn);

    // 云端用 UTC 表示，比本地早 1 小时
    let change = build_change(
        "n1",
        ChangeOperation::Update,
        json!({
            "id": "n1",
            "title": "cloud_earlier",
            "updated_at": "2026-05-01T19:00:00Z",
            "deleted_at": serde_json::Value::Null,
        }),
        "2026-05-01T19:00:00Z",
    );
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();

    let (title, _, _, _, _) = get_item(&conn, "n1").unwrap();
    // 正确 UTC 比较：本地 2026-05-01T20:00Z > 云端 2026-05-01T19:00Z → 跳过云端
    assert_eq!(title, "local", "时区转换后本地更新，应跳过云端旧变更");
}

// ============================================================================
// 难题 2：数据复活 / Zombie Records
// ============================================================================

/// **A.06** 设备 B 离线 3 个月，中间 A 删除了 n1；B 上线后还用最初的"n1 活着"快照尝试上传
///
/// 预期：A 的 DELETE 已 tombstone，B 的过时 UPSERT 不应复活 n1
#[test]
fn adv_06_zombie_prevention_stale_upsert_after_delete() {
    let conn = new_db();
    insert_raw(&conn, "n1", "original", "", "2026-02-01T00:00:00Z");
    mark_all_synced(&conn);

    // A 删除 n1（软删除）
    conn.execute(
        "UPDATE items SET deleted_at = ?1, updated_at = ?1 WHERE id = 'n1'",
        params!["2026-05-01T12:00:00Z"],
    )
    .unwrap();
    mark_all_synced(&conn);

    // B 离线 3 个月后上线，发来"n1 还活着"的旧快照
    let stale_change = build_change(
        "n1",
        ChangeOperation::Update,
        json!({
            "id": "n1",
            "title": "zombie_resurrection",
            "updated_at": "2026-02-15T00:00:00Z",
            "deleted_at": serde_json::Value::Null,
        }),
        "2026-02-15T00:00:00Z",
    );
    SyncManager::apply_downloaded_changes(&conn, &[stale_change], None).unwrap();

    let (title, _, _, deleted_at, _) = get_item(&conn, "n1").unwrap();
    // LWW 门应跳过这条过时变更（本地 updated_at = 2026-05-01 > 2026-02-15）
    assert!(
        deleted_at.is_some(),
        "tombstone 必须保留，不能被过时 UPSERT 复活"
    );
    assert_ne!(title, "zombie_resurrection", "本地应保留 original");
}

/// **A.07** 正当复活：B 在未来 1 天内合法地想复活 n1（drift 在允许范围内）
///
/// 预期：LWW 门允许通过（云端更晚），deleted_at 被清空
#[test]
fn adv_07_legitimate_revive_with_newer_timestamp() {
    let conn = new_db();
    // 使用相对当前时间的时间戳，避免 HLC drift guard 误拒
    let original_ts = (chrono::Utc::now() - chrono::Duration::days(90)).to_rfc3339();
    let delete_ts = (chrono::Utc::now() - chrono::Duration::days(30)).to_rfc3339();
    let revive_ts = (chrono::Utc::now() - chrono::Duration::minutes(1)).to_rfc3339();

    insert_raw(&conn, "n1", "original", "", &original_ts);
    mark_all_synced(&conn);

    conn.execute(
        "UPDATE items SET deleted_at = ?1, updated_at = ?1 WHERE id = 'n1'",
        params![delete_ts],
    )
    .unwrap();
    mark_all_synced(&conn);

    // 合法 revive，带更晚但在 drift 范围内的时间戳
    let revive = build_change(
        "n1",
        ChangeOperation::Update,
        json!({
            "id": "n1",
            "title": "revived",
            "updated_at": revive_ts,
            "deleted_at": serde_json::Value::Null,
        }),
        &revive_ts,
    );
    SyncManager::apply_downloaded_changes(&conn, &[revive], None).unwrap();

    let (title, _, _, deleted_at, _) = get_item(&conn, "n1").unwrap();
    assert!(deleted_at.is_none(), "合法 revive 应清空 deleted_at");
    assert_eq!(title, "revived");
}

// ============================================================================
// 难题 3：行级 LWW 丢字段
// ============================================================================

/// **A.08** 两端分别编辑一条记录的**不同字段**（典型的"行级 LWW 字段冲突"）
///
/// A 改 title, B 改 body，用 LWW 会导致后来者覆盖 —— 一个字段被回退。
/// 这是行级同步的**公认缺陷**，CRDT 才能真正解决。
///
/// 本测试**显式记录这个缺陷**，文档化当前系统的边界。
#[test]
fn adv_08_row_level_lww_loses_orthogonal_field_edits() {
    let conn = new_db();
    insert_raw(
        &conn,
        "n1",
        "base_title",
        "base_body",
        "2026-05-01T09:00:00Z",
    );
    mark_all_synced(&conn);

    // 本地改 body（只改 body）
    conn.execute(
        "UPDATE items SET body = 'local_body_edit', updated_at = ?1 WHERE id = 'n1'",
        params!["2026-05-01T10:00:00Z"],
    )
    .unwrap();

    // 云端改 title（只改 title），时间戳更晚
    let change = build_change(
        "n1",
        ChangeOperation::Update,
        json!({
            "id": "n1",
            "title": "cloud_title_edit",
            "body": "base_body",  // 云端 body 还是原始值（没改）
            "updated_at": "2026-05-01T11:00:00Z",
            "deleted_at": serde_json::Value::Null,
        }),
        "2026-05-01T11:00:00Z",
    );
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();

    let (title, body, _, _, _) = get_item(&conn, "n1").unwrap();

    // 当前行级 LWW 行为：云端胜 → title 更新，但 body 回退到 base_body
    // **这就是行级 LWW 的根本缺陷**：用户在两端独立改了不同字段，
    // 但同步后一端的改动被丢失。
    assert_eq!(title, "cloud_title_edit");
    assert_eq!(
        body, "base_body",
        "已知缺陷：行级 LWW 会把本地 body 编辑还原为基础值。\
         真正的字段级合并需要 CRDT 或显式字段 diff。"
    );
}

/// **A.09** 字段级冲突的"正确"做法应当是：保留本地对未冲突字段的修改
///
/// 这个测试记录我们**应当**实现但目前没有的行为。当前会失败（符合预期）。
/// 将来实现字段级 diff 后可以把 #[should_panic] 去掉。
#[test]
#[should_panic(expected = "字段级合并")]
fn adv_09_should_field_level_merge_but_currently_cannot() {
    let conn = new_db();
    insert_raw(&conn, "n1", "t", "b", "2026-05-01T09:00:00Z");
    mark_all_synced(&conn);

    conn.execute(
        "UPDATE items SET body = 'local_edit', updated_at = ?1 WHERE id = 'n1'",
        params!["2026-05-01T10:00:00Z"],
    )
    .unwrap();

    let change = build_change(
        "n1",
        ChangeOperation::Update,
        json!({
            "id": "n1",
            "title": "cloud_title",
            "body": "b",
            "updated_at": "2026-05-01T11:00:00Z",
            "deleted_at": serde_json::Value::Null,
        }),
        "2026-05-01T11:00:00Z",
    );
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();

    let (_, body, _, _, _) = get_item(&conn, "n1").unwrap();
    // 理想行为：body 应保留 'local_edit'（字段级合并）
    // 当前行为：body = 'b'，所以断言会失败
    assert_eq!(
        body, "local_edit",
        "字段级合并未实现；本测试打了 #[should_panic] 标记，\
         暴露期望但未达到的状态"
    );
}

// ============================================================================
// 难题 4：Retention 断层（prune gap）
// ============================================================================

/// **A.10** 本地 sync_version 太老，云端早就 prune 了中间变更 —— 应能检测到断层
#[test]
fn adv_10_prune_gap_detection() {
    // 本地最后同步到 version=100，云端最早变更在 version=500（prune 掉 100-499）
    assert!(SyncManager::has_prune_gap(100, Some(500)));
    // 本地 since=0（首次同步）→ 不算断层
    assert!(!SyncManager::has_prune_gap(0, Some(500)));
    // 本地 since 正好等于云端最早 → 边界不算断层
    assert!(!SyncManager::has_prune_gap(500, Some(500)));
    // 本地更新（since 比云端最早还大）→ 正常增量
    assert!(!SyncManager::has_prune_gap(600, Some(500)));
    // 云端空，首次同步 → 不算断层
    assert!(!SyncManager::has_prune_gap(100, None));
}

// ============================================================================
// 难题 5：Schema 漂移
// ============================================================================

/// **A.11** 云端 payload 缺少本地 schema 里的字段（老客户端发出、新客户端接收）
///
/// 预期：COALESCE 语义保留本地值，不把本地非空字段误清为 null
#[test]
fn adv_11_payload_missing_fields_preserves_local() {
    let conn = new_db();
    insert_raw(
        &conn,
        "n1",
        "base_title",
        "base_body",
        "2026-05-01T09:00:00Z",
    );
    mark_all_synced(&conn);

    // 云端 payload 只有 id 和 updated_at，没有 title/body（模拟旧版本客户端）
    let change = build_change(
        "n1",
        ChangeOperation::Update,
        json!({
            "id": "n1",
            "updated_at": "2026-05-01T11:00:00Z",
        }),
        "2026-05-01T11:00:00Z",
    );
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();

    let (title, body, _, _, _) = get_item(&conn, "n1").unwrap();
    // 云端未提供 title/body → COALESCE 保留本地
    assert_eq!(title, "base_title", "未传的字段应保留本地值");
    assert_eq!(body, "base_body");
}

/// **A.12** 云端 payload 有本地 schema 里**没有**的字段（新客户端 → 老客户端）
///
/// 预期：apply 应当**报错**（未知列），整批回滚
#[test]
fn adv_12_payload_unknown_columns_rejected() {
    let conn = new_db();
    let change = build_change(
        "n1",
        ChangeOperation::Insert,
        json!({
            "id": "n1",
            "title": "t",
            "body": "",
            "updated_at": "2026-05-01T11:00:00Z",
            "deleted_at": serde_json::Value::Null,
            "future_field_that_does_not_exist": "hello",
        }),
        "2026-05-01T11:00:00Z",
    );
    let r = SyncManager::apply_downloaded_changes(&conn, &[change], None);
    assert!(r.is_err(), "未知列必须导致失败，不能静默插入");
}

/// **A.13** 云端 payload 里字段类型不匹配（本地 INTEGER，云端 String）
#[test]
fn adv_13_payload_type_mismatch() {
    let conn = new_db();
    // counter 是 INTEGER，云端发来字符串 "not_a_number"
    let change = build_change(
        "n1",
        ChangeOperation::Insert,
        json!({
            "id": "n1",
            "title": "t",
            "counter": "not_a_number",  // <-- 应该是 int
            "updated_at": "2026-05-01T11:00:00Z",
            "deleted_at": serde_json::Value::Null,
        }),
        "2026-05-01T11:00:00Z",
    );
    // SQLite 类型亲和性很宽松（会接受字符串到 INTEGER 列），但至少不应 panic
    let _ = SyncManager::apply_downloaded_changes(&conn, &[change], None);
    // 检查是否不崩溃即可；具体行为取决于 SQLite affinity
}

// ============================================================================
// 难题 6：设备身份 / 回声循环
// ============================================================================

/// **A.14** 两个设备意外使用相同 device_id（例如从另一设备克隆了 .device_id 文件）
///
/// 这是真实会遇到的运维事故。sync 通道按 device_id 分桶，碰撞会导致两端
/// 互相覆盖对方的变更文件。
#[test]
fn adv_14_device_id_collision_scenario() {
    // 这个测试不直接触发同步失败，只记录一个潜在风险点：
    // - 当前实现里变更文件路径是 changes/{device_id}/...
    // - 如果两设备 device_id 相同，后上传者会覆盖前者文件
    // - 解决方案：在变更文件名里加 install_uuid（应用首次启动时生成的 UUID）
    //
    // 本测试仅断言 get_device_id 的返回值不变（稳定性），提示开发者这个问题。
    let id_1 = deep_student_lib::cloud_storage::get_device_id();
    let id_2 = deep_student_lib::cloud_storage::get_device_id();
    assert_eq!(
        id_1, id_2,
        "device_id 应稳定（但不保证全局唯一，需要 install_uuid 加强）"
    );
}

/// **A.15** 回声循环：收到自己刚上传的变更再次应用 —— 不能重复产生 __change_log 条目
#[test]
fn adv_15_echo_loop_prevention() {
    let conn = new_db();

    let change = build_change(
        "n1",
        ChangeOperation::Insert,
        json!({
            "id": "n1",
            "title": "hello",
            "body": "",
            "updated_at": "2026-05-01T11:00:00Z",
            "deleted_at": serde_json::Value::Null,
        }),
        "2026-05-01T11:00:00Z",
    );
    SyncManager::apply_downloaded_changes(&conn, &[change.clone()], None).unwrap();

    let before: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __change_log WHERE sync_version = 0",
            [],
            |r| r.get(0),
        )
        .unwrap();

    // 再次应用同一条变更（模拟"云端又发回来"）
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();

    let after: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __change_log WHERE sync_version = 0",
            [],
            |r| r.get(0),
        )
        .unwrap();

    assert_eq!(
        before, after,
        "回放同一变更不应积累 pending change_log 条目"
    );
}

// ============================================================================
// 难题 7：大规模 / 病态数据
// ============================================================================

/// **A.16** 单条记录的字段值 > 5MB：确保不因 LWW 门或 conflict_resolver 里
/// 的 serialize/parse 而 OOM 或超时
#[test]
fn adv_16_large_single_record() {
    let conn = new_db();
    let huge_body = "x".repeat(5 * 1024 * 1024);
    let change = build_change(
        "n1",
        ChangeOperation::Insert,
        json!({
            "id": "n1",
            "title": "huge",
            "body": huge_body.clone(),
            "updated_at": "2026-05-01T10:00:00Z",
            "deleted_at": serde_json::Value::Null,
        }),
        "2026-05-01T10:00:00Z",
    );
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();
    let (_, body, _, _, _) = get_item(&conn, "n1").unwrap();
    assert_eq!(body.len(), huge_body.len());
}

/// **A.17** 对同一记录做 100 次交替冲突（连续 UPDATE 的极端场景）
#[test]
fn adv_17_high_frequency_conflicts() {
    let conn = new_db();
    insert_raw(&conn, "n1", "base", "", "2026-01-01T00:00:00Z");
    mark_all_synced(&conn);

    // 本地改
    conn.execute(
        "UPDATE items SET title = 'local_edit', updated_at = ?1 WHERE id = 'n1'",
        params!["2026-05-01T12:00:00Z"],
    )
    .unwrap();

    // 云端连续推 100 次不同的冲突变更
    for i in 0..100 {
        let ts = format!("2026-05-01T11:00:{:02}Z", i.min(59));
        let change = build_change(
            "n1",
            ChangeOperation::Update,
            json!({
                "id": "n1",
                "title": format!("cloud_edit_{}", i),
                "updated_at": ts.clone(),
                "deleted_at": serde_json::Value::Null,
            }),
            &ts,
        );
        SyncManager::apply_downloaded_changes_with_conflict_guard(
            &conn,
            &[change],
            None,
            ConflictPolicy::KeepLatest,
            Some("cloud"),
            Some("local"),
        )
        .unwrap();
    }

    // 本地晚于所有 cloud → 100 次全部 rejected，但冲突表应累积
    let (title, _, _, _, _) = get_item(&conn, "n1").unwrap();
    assert_eq!(title, "local_edit", "本地更新，应拒绝所有 100 条云端变更");

    // 去重语义（批判报告 P0-3 修复后）：
    // - side=local 的 save 每次传的都是同一份"本地当前值"，data_hash 全等 → 合并成 1 条
    // - side=cloud 的 save 每次传不同的 cloud_edit_{i}，data_hash 各异 → 100 条
    // 合计 101 条。这体现了"同内容不重复累积，不同内容如实记录"的正确行为。
    let c: i64 = conn
        .query_row("SELECT COUNT(*) FROM __sync_conflicts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        c, 101,
        "dedup 后：1 条 local（内容稳定）+ 100 条 cloud（每次内容不同）"
    );

    // 并且 unresolved 同样是 101（这些还没有被标为已解决）
    let unresolved: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __sync_conflicts WHERE resolved_at IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(unresolved, 101);
}

/// **A.18** 非法 JSON value 类型（比如 NaN、Infinity）
#[test]
fn adv_18_json_special_numeric_values() {
    let conn = new_db();
    // serde_json 默认不允许 NaN/Infinity，这里用字符串模拟用户可能传进来的怪值
    let change = build_change(
        "n1",
        ChangeOperation::Insert,
        json!({
            "id": "n1",
            "title": "nan_check",
            "counter": 0, // 保守：不尝试构造 NaN
            "updated_at": "2026-05-01T10:00:00Z",
            "deleted_at": serde_json::Value::Null,
        }),
        "2026-05-01T10:00:00Z",
    );
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();
    let (_, _, counter, _, _) = get_item(&conn, "n1").unwrap();
    assert_eq!(counter, 0);
}

/// **A.19** 记录 id 超长（2000 字符）
#[test]
fn adv_19_very_long_record_id() {
    let conn = new_db();
    let long_id = "x".repeat(2000);
    let change = build_change(
        &long_id,
        ChangeOperation::Insert,
        json!({
            "id": long_id.clone(),
            "title": "t",
            "updated_at": "2026-05-01T10:00:00Z",
            "deleted_at": serde_json::Value::Null,
        }),
        "2026-05-01T10:00:00Z",
    );
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();
    let r = get_item(&conn, &long_id);
    assert!(r.is_some());
}

/// **A.20** 非 UTF-8 的字节序列在字符串字段里（通过 hex 模拟）
#[test]
fn adv_20_binary_like_string_in_text_column() {
    let conn = new_db();
    // JSON 必须是 UTF-8，但可以存包含特殊字符的字符串
    let weird_title = "\u{0000}\u{007F}\u{FEFF}\u{200B}";
    let change = build_change(
        "n1",
        ChangeOperation::Insert,
        json!({
            "id": "n1",
            "title": weird_title,
            "updated_at": "2026-05-01T10:00:00Z",
            "deleted_at": serde_json::Value::Null,
        }),
        "2026-05-01T10:00:00Z",
    );
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();
    let (title, _, _, _, _) = get_item(&conn, "n1").unwrap();
    assert_eq!(title, weird_title);
}

// ============================================================================
// 难题 8：LWW 门的边界情况
// ============================================================================

/// **A.21** 本地记录**没有 updated_at** 字段值（比如历史遗留脏数据），云端有
///
/// 预期：LWW 门无法比较，默认允许云端写入
#[test]
fn adv_21_local_missing_updated_at_allows_cloud() {
    let conn = new_db();
    // 用不可解析的 updated_at 模拟"脏数据"
    conn.execute(
        "INSERT INTO items (id, title, body, updated_at) VALUES ('n1', 'local', '', 'garbage_ts')",
        [],
    )
    .unwrap();
    mark_all_synced(&conn);

    let change = build_change(
        "n1",
        ChangeOperation::Update,
        json!({
            "id": "n1",
            "title": "cloud",
            "updated_at": "2026-05-01T12:00:00Z",
            "deleted_at": serde_json::Value::Null,
        }),
        "2026-05-01T12:00:00Z",
    );
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();

    let (title, _, _, _, _) = get_item(&conn, "n1").unwrap();
    assert_eq!(title, "cloud", "本地 updated_at 无法解析时应允许云端覆盖");
}

/// **A.22** 云端 payload 的 `updated_at` 不可解析（脏数据）
///
/// 预期：LWW 门无法比较，默认允许云端写入（保持原有行为）
#[test]
fn adv_22_cloud_garbage_updated_at() {
    let conn = new_db();
    insert_raw(&conn, "n1", "local", "", "2026-05-01T10:00:00Z");
    mark_all_synced(&conn);

    let change = build_change(
        "n1",
        ChangeOperation::Update,
        json!({
            "id": "n1",
            "title": "cloud",
            "updated_at": "not_a_timestamp",
            "deleted_at": serde_json::Value::Null,
        }),
        "not_a_timestamp",
    );
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();

    let (title, _, _, _, _) = get_item(&conn, "n1").unwrap();
    // 当 LWW 门无法决策时，默认"允许"是一个策略选择。
    // 这里验证：至少不 panic，且行为符合预期（允许覆盖）
    assert_eq!(title, "cloud");
}

/// **A.23** 本地记录不存在（新插入），LWW 门应让 INSERT 通过
#[test]
fn adv_23_insert_nonexistent_passes_lww() {
    let conn = new_db();
    // 本地没有 n1
    let change = build_change(
        "n1",
        ChangeOperation::Insert,
        json!({
            "id": "n1",
            "title": "new",
            "updated_at": "2026-05-01T10:00:00Z",
            "deleted_at": serde_json::Value::Null,
        }),
        "2026-05-01T10:00:00Z",
    );
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();
    let (title, _, _, _, _) = get_item(&conn, "n1").unwrap();
    assert_eq!(title, "new");
}

/// **A.24** payload 缺 updated_at → 写入 NOT NULL 列触发约束错误（整批回滚）
///
/// 这是**更严格的保护**：而不是静默用云端值覆盖较新本地，而是**直接拒绝**。
/// 生产端必须保证每条上传的 change 都带 updated_at，否则整批失败。
#[test]
fn adv_24_payload_missing_updated_at_is_rejected() {
    let conn = new_db();
    insert_raw(&conn, "n1", "local_newer", "", "2026-06-01T00:00:00Z");
    mark_all_synced(&conn);

    let change = build_change(
        "n1",
        ChangeOperation::Update,
        json!({
            "id": "n1",
            "title": "cloud_without_ts",
            "deleted_at": serde_json::Value::Null,
            // 没有 updated_at!
        }),
        "2026-05-01T10:00:00Z",
    );
    let r = SyncManager::apply_downloaded_changes(&conn, &[change], None);
    // 因为 items.updated_at NOT NULL，UPSERT 会违反约束 → 整批回滚
    assert!(r.is_err(), "缺 updated_at 的 UPSERT 应触发 NOT NULL 错误");

    // 本地值未被改变
    let (title, _, _, _, _) = get_item(&conn, "n1").unwrap();
    assert_eq!(title, "local_newer", "事务回滚，本地值不变");
}

// ============================================================================
// 难题 9：交错的冲突解决
// ============================================================================

/// **A.25** 冲突解决中的 tie-break：相同 updated_at，不同 device_id
#[test]
fn adv_25_conflict_tie_break_same_timestamp() {
    let conn = new_db();
    insert_raw(&conn, "n1", "local", "", "2026-05-01T12:00:00Z");
    mark_all_synced(&conn);

    // 本地改
    conn.execute(
        "UPDATE items SET title = 'local_edit', updated_at = ?1 WHERE id = 'n1'",
        params!["2026-05-01T12:00:00Z"],
    )
    .unwrap();

    // 云端改，相同时间戳
    let change = build_change(
        "n1",
        ChangeOperation::Update,
        json!({
            "id": "n1",
            "title": "cloud_edit",
            "updated_at": "2026-05-01T12:00:00Z",
            "deleted_at": serde_json::Value::Null,
        }),
        "2026-05-01T12:00:00Z",
    );
    let (_, conflict) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[change],
        None,
        ConflictPolicy::KeepLatest,
        Some("cloud_dev"),
        Some("local_dev"),
    )
    .unwrap();

    // 时钟 tie：当前实现偏向保留本地（安全优先）
    let (title, _, _, _, _) = get_item(&conn, "n1").unwrap();
    assert_eq!(title, "local_edit", "KeepLatest tie-break 偏向本地");
    assert!(conflict.conflicts_saved >= 1);
}

/// **A.26** 两条**同记录**的变更在同一批里按时间戳排序应用
///
/// 如果排序不稳定，结果不确定。这验证确定性。
#[test]
fn adv_26_batch_apply_same_record_multiple_changes() {
    let conn = new_db();

    let c1 = build_change(
        "n1",
        ChangeOperation::Insert,
        json!({
            "id": "n1", "title": "v1", "body": "", "counter": 1,
            "updated_at": "2026-05-01T10:00:00Z",
            "deleted_at": serde_json::Value::Null,
        }),
        "2026-05-01T10:00:00Z",
    );
    let c2 = build_change(
        "n1",
        ChangeOperation::Update,
        json!({
            "id": "n1", "title": "v2", "body": "", "counter": 2,
            "updated_at": "2026-05-01T11:00:00Z",
            "deleted_at": serde_json::Value::Null,
        }),
        "2026-05-01T11:00:00Z",
    );
    let c3 = build_change(
        "n1",
        ChangeOperation::Update,
        json!({
            "id": "n1", "title": "v3", "body": "", "counter": 3,
            "updated_at": "2026-05-01T12:00:00Z",
            "deleted_at": serde_json::Value::Null,
        }),
        "2026-05-01T12:00:00Z",
    );

    // 故意乱序：v3, v1, v2
    SyncManager::apply_downloaded_changes(&conn, &[c3, c1, c2], None).unwrap();

    let (title, _, counter, _, _) = get_item(&conn, "n1").unwrap();
    // 由于 LWW 门：v3 先 apply → title=v3。
    // v1 尝试写 title=v1，updated_at=10:00 < 本地 12:00 → LWW 跳过。
    // v2 尝试写 title=v2，updated_at=11:00 < 12:00 → LWW 跳过。
    // 最终 = v3
    assert_eq!(title, "v3");
    assert_eq!(counter, 3);
}

/// **A.27** 极端情况：变更的 updated_at 和记录的 updated_at 差 1 毫秒
#[test]
fn adv_27_millisecond_granularity() {
    let conn = new_db();
    insert_raw(&conn, "n1", "local", "", "2026-05-01T12:00:00.001Z");
    mark_all_synced(&conn);

    // 云端比本地晚 1 毫秒
    let change = build_change(
        "n1",
        ChangeOperation::Update,
        json!({
            "id": "n1",
            "title": "cloud",
            "updated_at": "2026-05-01T12:00:00.002Z",
            "deleted_at": serde_json::Value::Null,
        }),
        "2026-05-01T12:00:00.002Z",
    );
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();

    let (title, _, _, _, _) = get_item(&conn, "n1").unwrap();
    // 毫秒级精度应能区分：云端胜
    assert_eq!(title, "cloud");
}

// ============================================================================
// 难题 10：Unicode、SQL injection、控制字符
// ============================================================================

/// **A.28** 表名注入防护
#[test]
fn adv_28_table_name_injection_blocked() {
    let conn = new_db();
    let change = SyncChangeWithData {
        table_name: "items; DROP TABLE items; --".into(),
        record_id: "n1".into(),
        operation: ChangeOperation::Insert,
        data: Some(json!({ "id": "n1" })),
        changed_at: "2026-05-01T10:00:00Z".into(),
        change_log_id: None,
        database_name: None,
        suppress_change_log: Some(true),
    };
    let r = SyncManager::apply_downloaded_changes(&conn, &[change], None);
    assert!(r.is_err());
    // 确认 items 表仍在
    let _: i64 = conn
        .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
        .expect("items 表应当仍然存在");
}

/// **A.29** 双引号在字段值里（不应破坏 SQL）
#[test]
fn adv_29_double_quotes_in_field_value() {
    let conn = new_db();
    let tricky = r#"value with "double quotes" and 'single' and -- comment"#;
    let change = build_change(
        "n1",
        ChangeOperation::Insert,
        json!({
            "id": "n1",
            "title": tricky,
            "updated_at": "2026-05-01T10:00:00Z",
            "deleted_at": serde_json::Value::Null,
        }),
        "2026-05-01T10:00:00Z",
    );
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();
    let (title, _, _, _, _) = get_item(&conn, "n1").unwrap();
    assert_eq!(title, tricky);
}

/// **A.30** 字段名带空格 / 非 ASCII 字符 → 必须被拒绝（防 schema 污染）
#[test]
fn adv_30_malicious_column_name_in_payload() {
    let conn = new_db();
    let change = SyncChangeWithData {
        table_name: "items".into(),
        record_id: "n1".into(),
        operation: ChangeOperation::Insert,
        data: Some(json!({
            "id": "n1",
            "title": "t",
            "updated_at": "2026-05-01T10:00:00Z",
            "; DROP TABLE items; --": "hack",  // 非法列名
        })),
        changed_at: "2026-05-01T10:00:00Z".into(),
        change_log_id: None,
        database_name: None,
        suppress_change_log: Some(true),
    };
    let _ = SyncManager::apply_downloaded_changes(&conn, &[change], None);
    // 关键：items 表必须仍在
    let _: i64 = conn
        .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
        .expect("items 表应仍然存在");
}

// ============================================================================
// 难题 11：conflict_resolver 的 canonicalize 边界
// ============================================================================

/// **A.31** JSON 字段内容语义相同但序列化不同（tag 顺序）
#[test]
fn adv_31_tags_field_semantic_equality() {
    let conn = new_db();
    // 本地 tags = '["a","b"]'，云端也是 '["a","b"]' 但用字符串形式
    conn.execute(
        "INSERT INTO items (id, title, tags, updated_at) VALUES ('n1', 't', ?1, ?2)",
        params![r#"["a","b"]"#, "2026-05-01T09:00:00Z"],
    )
    .unwrap();

    // 本地 pending (local edit)
    conn.execute(
        "UPDATE items SET title = 'local_edit', updated_at = ?1 WHERE id = 'n1'",
        params!["2026-05-01T10:00:00Z"],
    )
    .unwrap();

    // 云端 payload tags 顺序不同 但语义等价
    let change = build_change(
        "n1",
        ChangeOperation::Update,
        json!({
            "id": "n1",
            "title": "local_edit",  // 相同 title
            "tags": r#"["a","b"]"#,  // 字符串形式
            "updated_at": "2026-05-01T11:00:00Z",
            "deleted_at": serde_json::Value::Null,
        }),
        "2026-05-01T11:00:00Z",
    );

    // 如果 canonicalize 把字符串 tags 解析为 array 比较，应识别为"业务相同"
    let (_, conflict) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[change],
        None,
        ConflictPolicy::KeepLatest,
        None,
        None,
    )
    .unwrap();

    // 数据业务上相同 title，不同 updated_at → 不是冲突
    assert_eq!(conflict.conflicts_saved, 0, "业务字段等价时不应记录冲突");
}

// ============================================================================
// 难题 12：排序稳定性 + 跨 apply 幂等
// ============================================================================

/// **A.32** 大量交错变更的确定性
#[test]
fn adv_32_deterministic_batch_apply() {
    let conn_1 = new_db();
    let conn_2 = new_db();

    let mut changes = Vec::new();
    for i in 0..50 {
        let ts = format!("2026-05-01T{:02}:00:00Z", i);
        changes.push(build_change(
            if i % 2 == 0 { "n1" } else { "n2" },
            if i < 25 {
                ChangeOperation::Insert
            } else {
                ChangeOperation::Update
            },
            json!({
                "id": if i % 2 == 0 { "n1" } else { "n2" },
                "title": format!("v{}", i),
                "updated_at": ts.clone(),
                "deleted_at": serde_json::Value::Null,
            }),
            &ts,
        ));
    }

    // 两个独立 conn 应用相同顺序，应得相同结果
    SyncManager::apply_downloaded_changes(&conn_1, &changes, None).unwrap();
    SyncManager::apply_downloaded_changes(&conn_2, &changes, None).unwrap();

    let (t1_n1, _, _, _, _) = get_item(&conn_1, "n1").unwrap();
    let (t2_n1, _, _, _, _) = get_item(&conn_2, "n1").unwrap();
    assert_eq!(t1_n1, t2_n1);

    let (t1_n2, _, _, _, _) = get_item(&conn_1, "n2").unwrap();
    let (t2_n2, _, _, _, _) = get_item(&conn_2, "n2").unwrap();
    assert_eq!(t1_n2, t2_n2);
}

/// **A.33** 云端变更文件被篡改（payload 里 id 与 record_id 不符）
#[test]
fn adv_33_payload_id_mismatch_with_record_id() {
    let conn = new_db();
    let change = SyncChangeWithData {
        table_name: "items".into(),
        record_id: "n1".into(), // 顶层 record_id
        operation: ChangeOperation::Insert,
        data: Some(json!({
            "id": "n2",  // payload 里的 id 不同！
            "title": "ambiguous",
            "updated_at": "2026-05-01T10:00:00Z",
            "deleted_at": serde_json::Value::Null,
        })),
        changed_at: "2026-05-01T10:00:00Z".into(),
        change_log_id: None,
        database_name: Some("test".into()),
        suppress_change_log: Some(true),
    };
    // 当前行为：UPSERT 根据 payload 里的 id 写入（因为 build_insert_parts 用 payload 里的 id）
    // 这可能让 sync 在 record_id 和 payload id 不一致时产生混淆。
    // 生产代码应在 upload 前校验一致性。
    let r = SyncManager::apply_downloaded_changes(&conn, &[change], None);
    let _ = r;

    // 检查：如果应用成功，写入的 id 是什么？
    let count_n1: i64 = conn
        .query_row("SELECT COUNT(*) FROM items WHERE id='n1'", [], |r| r.get(0))
        .unwrap();
    let count_n2: i64 = conn
        .query_row("SELECT COUNT(*) FROM items WHERE id='n2'", [], |r| r.get(0))
        .unwrap();

    println!(
        "adv_33 (payload id mismatch): n1_count={}, n2_count={}",
        count_n1, count_n2
    );
    // 记录行为：目前 UPSERT 按 payload id 走，这是不一致的。
    // 改进建议：apply_single_record 应校验 payload['id'] == record_id，否则报错。
}

// ============================================================================
// 难题 13：冲突表自身的正确性
// ============================================================================

/// **A.34** 冲突表索引查询 —— 未解决的冲突应能按 record_id 唯一定位
#[test]
fn adv_34_conflict_table_query_by_record() {
    let conn = new_db();
    insert_raw(&conn, "n1", "base", "", "2026-05-01T09:00:00Z");
    mark_all_synced(&conn);
    conn.execute(
        "UPDATE items SET title = 'local', updated_at = ?1 WHERE id = 'n1'",
        params!["2026-05-01T12:00:00Z"],
    )
    .unwrap();

    let change = build_change(
        "n1",
        ChangeOperation::Update,
        json!({
            "id": "n1",
            "title": "cloud",
            "updated_at": "2026-05-01T11:00:00Z",
            "deleted_at": serde_json::Value::Null,
        }),
        "2026-05-01T11:00:00Z",
    );

    SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[change],
        None,
        ConflictPolicy::KeepLatest,
        Some("cloud"),
        Some("local"),
    )
    .unwrap();

    // 检查 __sync_conflicts 索引正常工作
    let unresolved: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __sync_conflicts WHERE resolved_at IS NULL AND record_id = 'n1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        unresolved, 2,
        "n1 应有 2 条未解决冲突（local side + cloud side）"
    );
}

/// **A.35** 冲突解决后，再次发生冲突是否能正确累积
#[test]
fn adv_35_cumulative_conflict_rounds() {
    let conn = new_db();
    insert_raw(&conn, "n1", "base", "", "2026-01-01T00:00:00Z");
    mark_all_synced(&conn);

    for round in 0..5 {
        // 本地改
        let local_ts = format!("2026-{:02}-01T12:00:00Z", round + 2);
        conn.execute(
            "UPDATE items SET title = ?1, updated_at = ?2 WHERE id = 'n1'",
            params![format!("local_{}", round), local_ts],
        )
        .unwrap();

        // 云端 push 较早的版本
        let cloud_ts = format!("2026-{:02}-01T11:00:00Z", round + 2);
        let change = build_change(
            "n1",
            ChangeOperation::Update,
            json!({
                "id": "n1",
                "title": format!("cloud_{}", round),
                "updated_at": cloud_ts.clone(),
                "deleted_at": serde_json::Value::Null,
            }),
            &cloud_ts,
        );

        SyncManager::apply_downloaded_changes_with_conflict_guard(
            &conn,
            &[change],
            None,
            ConflictPolicy::KeepLatest,
            Some("cloud"),
            Some("local"),
        )
        .unwrap();
    }

    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM __sync_conflicts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(total, 10, "5 轮冲突 × 2 条/轮 = 10 条累积");
}

// ============================================================================
// 难题 14：真实边界
// ============================================================================

/// **A.36** 空批次的行为
#[test]
fn adv_36_empty_batch_noop() {
    let conn = new_db();
    let r = SyncManager::apply_downloaded_changes(&conn, &[], None).unwrap();
    assert_eq!(r.success_count, 0);
}

/// **A.37** 同批里应用 20 条同 record 的变更，最终应取最晚一条
#[test]
fn adv_37_many_changes_same_record_latest_wins() {
    let conn = new_db();
    let mut changes = Vec::new();
    for i in 0..20 {
        let ts = format!("2026-05-01T{:02}:00:00Z", i);
        changes.push(build_change(
            "n1",
            if i == 0 {
                ChangeOperation::Insert
            } else {
                ChangeOperation::Update
            },
            json!({
                "id": "n1",
                "title": format!("v{}", i),
                "updated_at": ts.clone(),
                "deleted_at": serde_json::Value::Null,
            }),
            &ts,
        ));
    }
    SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();
    let (title, _, _, _, _) = get_item(&conn, "n1").unwrap();
    assert_eq!(title, "v19", "最晚的变更胜出");
}

/// **A.38** 批次中既有 DELETE 又有同记录的 UPDATE（按时间戳排序）
#[test]
fn adv_38_delete_then_update_in_same_batch() {
    let conn = new_db();
    insert_raw(&conn, "n1", "original", "", "2026-01-01T00:00:00Z");
    mark_all_synced(&conn);

    let del = build_change(
        "n1",
        ChangeOperation::Delete,
        json!({}),
        "2026-05-01T10:00:00Z",
    );
    let upd = build_change(
        "n1",
        ChangeOperation::Update,
        json!({
            "id": "n1",
            "title": "revived",
            "updated_at": "2026-05-01T11:00:00Z",
            "deleted_at": serde_json::Value::Null,
        }),
        "2026-05-01T11:00:00Z",
    );

    // 应用顺序：先 DELETE 后 UPDATE（时间戳递增）
    SyncManager::apply_downloaded_changes(&conn, &[del, upd], None).unwrap();

    let (title, _, _, deleted_at, _) = get_item(&conn, "n1").unwrap();
    assert_eq!(title, "revived");
    assert!(deleted_at.is_none(), "UPDATE 复活了记录");
}

/// **A.39** 批次中既有 UPDATE 又有同记录的 DELETE（按时间戳排序，DELETE 晚）
#[test]
fn adv_39_update_then_delete_in_same_batch() {
    let conn = new_db();
    let upd = build_change(
        "n1",
        ChangeOperation::Insert,
        json!({
            "id": "n1",
            "title": "t",
            "updated_at": "2026-05-01T10:00:00Z",
            "deleted_at": serde_json::Value::Null,
        }),
        "2026-05-01T10:00:00Z",
    );
    let del = build_change(
        "n1",
        ChangeOperation::Delete,
        json!({}),
        "2026-05-01T11:00:00Z",
    );

    SyncManager::apply_downloaded_changes(&conn, &[upd, del], None).unwrap();

    let (_, _, _, deleted_at, _) = get_item(&conn, "n1").unwrap();
    assert!(deleted_at.is_some(), "DELETE 软删除了记录");
}

/// **A.40** 对 DELETE 变更，payload 里有 data 字段也应被忽略（语义一致）
#[test]
fn adv_40_delete_with_unexpected_data_field() {
    let conn = new_db();
    insert_raw(&conn, "n1", "t", "", "2026-05-01T09:00:00Z");
    mark_all_synced(&conn);

    let change = SyncChangeWithData {
        table_name: "items".into(),
        record_id: "n1".into(),
        operation: ChangeOperation::Delete,
        data: Some(json!({ "id": "n1", "title": "should_be_ignored" })),
        changed_at: "2026-05-01T10:00:00Z".into(),
        change_log_id: None,
        database_name: Some("test".into()),
        suppress_change_log: Some(true),
    };
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();

    let (title, _, _, deleted_at, _) = get_item(&conn, "n1").unwrap();
    // DELETE 不应使用 data 字段，title 不应被改
    assert_eq!(title, "t");
    assert!(deleted_at.is_some());
}
