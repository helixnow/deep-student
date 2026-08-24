//! [R06-del-resolve] 回归集成测试：败方 DELETE/UPSERT 冲突的可裁决性。
//!
//! 问题背景：输掉 LWW 的 DELETE（以及 UPSERT SkipStale）此前只把败方 payload
//! 落 `__sync_conflicts` 的 cloud 侧，而 resolve 命令按 local+cloud 双侧裁决、
//! 缺 local side 直接报错——这类冲突永远无法采纳，未解决徽章永久占位。
//!
//! 修复分两层，本文件对应覆盖：
//! 1. **落表补齐**：两条 LWW 败方路径写 cloud 侧的同时补齐胜方本地快照
//!    （side='local'），新冲突天然双侧可裁决；
//! 2. **resolve 单侧兼容**：对存量单侧冲突（老库数据），resolve 核心
//!    （`resolve_record_conflict_on_conn`）以当前业务行充当 local 快照回退，
//!    keep_local / keep_cloud / merged 均可正常完成并标记 resolved。

use deep_student_lib::data_governance::commands_sync::resolve_record_conflict_on_conn;
use deep_student_lib::data_governance::sync::{
    conflict_resolver::{ConflictPolicy, ConflictRecordToSave, ConflictResolver, ConflictSide},
    ChangeOperation, SyncChangeWithData, SyncManager,
};
use rusqlite::{params, Connection};

// ============================================================================
// Fixture：业务表 + __change_log（无触发器 —— 测试自行控制 pending 状态）
// ============================================================================

fn new_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE items (
            id TEXT PRIMARY KEY,
            content TEXT,
            updated_at TEXT
        );
        CREATE TABLE __change_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            operation TEXT NOT NULL CHECK(operation IN ('INSERT', 'UPDATE', 'DELETE')),
            changed_at TEXT NOT NULL DEFAULT (datetime('now')),
            sync_version INTEGER DEFAULT 0
        );
        "#,
    )
    .unwrap();
    conn
}

fn insert_record(conn: &Connection, id: &str, content: &str, updated_at: &str) {
    conn.execute(
        "INSERT INTO items(id, content, updated_at) VALUES(?1, ?2, ?3)",
        params![id, content, updated_at],
    )
    .unwrap();
}

fn change(
    record_id: &str,
    operation: ChangeOperation,
    data: Option<serde_json::Value>,
    changed_at: &str,
    source_device_id: &str,
    source_seq: u64,
) -> SyncChangeWithData {
    SyncChangeWithData {
        table_name: "items".to_string(),
        record_id: record_id.to_string(),
        operation,
        data,
        changed_at: changed_at.to_string(),
        change_log_id: None,
        database_name: Some("vfs".to_string()),
        suppress_change_log: Some(true),
        source_device_id: Some(source_device_id.to_string()),
        source_seq: Some(source_seq),
    }
}

fn record_count(conn: &Connection, id: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM items WHERE id=?1",
        params![id],
        |row| row.get(0),
    )
    .unwrap()
}

fn record_content(conn: &Connection, id: &str) -> String {
    conn.query_row(
        "SELECT content FROM items WHERE id=?1",
        params![id],
        |row| row.get(0),
    )
    .unwrap()
}

fn unresolved_conflict_ids(conn: &Connection, record_id: &str) -> Vec<i64> {
    let mut stmt = conn
        .prepare(
            "SELECT id FROM __sync_conflicts
             WHERE table_name='items' AND record_id=?1 AND resolved_at IS NULL
             ORDER BY id ASC",
        )
        .unwrap();
    stmt.query_map(params![record_id], |row| row.get(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect()
}

fn unresolved_side_rows(conn: &Connection, record_id: &str, side: &str) -> Vec<String> {
    let mut stmt = conn
        .prepare(
            "SELECT data_json FROM __sync_conflicts
             WHERE table_name='items' AND record_id=?1 AND side=?2 AND resolved_at IS NULL
             ORDER BY id ASC",
        )
        .unwrap();
    stmt.query_map(params![record_id, side], |row| row.get(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect()
}

fn resolved_count(conn: &Connection, record_id: &str, resolution: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM __sync_conflicts
         WHERE table_name='items' AND record_id=?1
           AND resolved_at IS NOT NULL AND resolution=?2",
        params![record_id, resolution],
        |row| row.get(0),
    )
    .unwrap()
}

// ============================================================================
// 1. 落表补齐：新产生的 LWW 败方冲突双侧入表、直接可裁决
// ============================================================================

/// 慢钟败方 DELETE：冲突表必须同时含 cloud（Null payload）与 local（胜方快照）
/// 两侧；随后 keep_cloud 采纳删除意图应能完成裁决并真正删除本地行。
#[test]
fn r06_stale_delete_conflict_records_both_sides_and_keep_cloud_resolves() {
    let conn = new_db();
    insert_record(&conn, "rec-1", "newer-local", "2026-07-10T13:00:00Z");

    let stale_delete = change(
        "rec-1",
        ChangeOperation::Delete,
        None,
        "2026-07-10T12:00:00Z", // 早于本地 updated_at → 输掉 LWW
        "device-slow",
        1,
    );
    for round in 0..2 {
        let (result, _) = SyncManager::apply_downloaded_changes_with_conflict_guard(
            &conn,
            &[stale_delete.clone()],
            None,
            ConflictPolicy::KeepLatest,
            Some("device-slow"),
            Some("device-local"),
        )
        .unwrap();
        assert_eq!(result.skipped_count, 1, "round {round}: 较旧 DELETE 应被 LWW 拒绝");
    }

    let clouds = unresolved_side_rows(&conn, "rec-1", "cloud");
    assert_eq!(clouds, vec!["null".to_string()], "cloud 侧为 Null payload 且去重");
    let locals = unresolved_side_rows(&conn, "rec-1", "local");
    assert_eq!(locals.len(), 1, "local 侧胜方快照必须补齐且去重");
    assert!(locals[0].contains("newer-local"), "本地快照可见: {}", locals[0]);

    // 双侧齐备 → resolve 采纳云端删除意图
    let ids = unresolved_conflict_ids(&conn, "rec-1");
    resolve_record_conflict_on_conn(&conn, "vfs", "items", "rec-1", "keep_cloud", None, ids)
        .expect("双侧冲突 keep_cloud 裁决应成功");

    assert_eq!(record_count(&conn, "rec-1"), 0, "采纳云端后本地行应被删除");
    assert!(unresolved_conflict_ids(&conn, "rec-1").is_empty(), "冲突应全部标记 resolved");
    assert_eq!(resolved_count(&conn, "rec-1", "keep_cloud"), 2);
}

/// 慢钟败方 UPSERT（SkipStale）：冲突表必须同时含 cloud（败方 payload）与
/// local（胜方快照）两侧。
#[test]
fn r06_stale_upsert_conflict_records_both_sides() {
    let conn = new_db();
    insert_record(&conn, "rec-2", "newer-local", "2026-07-10T13:00:00Z");

    let stale_upsert = change(
        "rec-2",
        ChangeOperation::Update,
        Some(serde_json::json!({
            "id": "rec-2",
            "content": "slow-clock-write",
            "updated_at": "2026-07-10T12:00:00Z"
        })),
        "2026-07-10T12:00:00Z",
        "device-slow",
        2,
    );
    for _ in 0..2 {
        let (result, _) = SyncManager::apply_downloaded_changes_with_conflict_guard(
            &conn,
            &[stale_upsert.clone()],
            None,
            ConflictPolicy::KeepLatest,
            Some("device-slow"),
            Some("device-local"),
        )
        .unwrap();
        assert_eq!(result.skipped_count, 1);
    }
    assert_eq!(record_content(&conn, "rec-2"), "newer-local");

    let clouds = unresolved_side_rows(&conn, "rec-2", "cloud");
    assert_eq!(clouds.len(), 1, "cloud 侧败方 payload 去重后一行");
    assert!(clouds[0].contains("slow-clock-write"));
    let locals = unresolved_side_rows(&conn, "rec-2", "local");
    assert_eq!(locals.len(), 1, "local 侧胜方快照必须补齐且去重");
    assert!(locals[0].contains("newer-local"));

    // 采纳败方云端写入也应可完成
    let ids = unresolved_conflict_ids(&conn, "rec-2");
    resolve_record_conflict_on_conn(&conn, "vfs", "items", "rec-2", "keep_cloud", None, ids)
        .expect("双侧冲突 keep_cloud 裁决应成功");
    assert_eq!(record_content(&conn, "rec-2"), "slow-clock-write");
    assert!(unresolved_conflict_ids(&conn, "rec-2").is_empty());
}

// ============================================================================
// 2. resolve 单侧兼容：存量 cloud 单侧冲突（老库数据）可裁决
// ============================================================================

/// 存量单侧 DELETE 冲突（只有 side='cloud' 的 Null payload）：keep_local 应以
/// 当前业务行充当 local 快照完成裁决，本地行保留、冲突标记 resolved。
#[test]
fn r06_legacy_cloud_only_delete_conflict_keep_local_resolves() {
    let conn = new_db();
    insert_record(&conn, "rec-3", "survivor", "2026-07-10T13:00:00Z");

    // 模拟老版本落表：只有 cloud 单侧
    let inserted = ConflictResolver::save_conflict_record(
        &conn,
        ConflictRecordToSave {
            table_name: "items",
            record_id: "rec-3",
            side: ConflictSide::Cloud,
            data: &serde_json::Value::Null,
            winning_device_id: None,
            losing_device_id: Some("device-slow"),
        },
    )
    .unwrap();
    assert!(inserted);

    let ids = unresolved_conflict_ids(&conn, "rec-3");
    assert_eq!(ids.len(), 1, "前置条件：单侧冲突只有一行");

    resolve_record_conflict_on_conn(&conn, "vfs", "items", "rec-3", "keep_local", None, ids)
        .expect("单侧冲突 keep_local 不得再报“找不到 local side 数据”");

    assert_eq!(record_count(&conn, "rec-3"), 1, "保留本地后行仍存在");
    assert_eq!(record_content(&conn, "rec-3"), "survivor");
    assert!(unresolved_conflict_ids(&conn, "rec-3").is_empty(), "冲突应标记 resolved");
    assert_eq!(resolved_count(&conn, "rec-3", "keep_local"), 1);
}

/// 存量单侧 DELETE 冲突：keep_cloud 采纳删除意图（Null payload → DELETE），
/// 本地行删除、冲突标记 resolved。
#[test]
fn r06_legacy_cloud_only_delete_conflict_keep_cloud_resolves() {
    let conn = new_db();
    insert_record(&conn, "rec-4", "doomed", "2026-07-10T13:00:00Z");

    ConflictResolver::save_conflict_record(
        &conn,
        ConflictRecordToSave {
            table_name: "items",
            record_id: "rec-4",
            side: ConflictSide::Cloud,
            data: &serde_json::Value::Null,
            winning_device_id: None,
            losing_device_id: Some("device-slow"),
        },
    )
    .unwrap();

    let ids = unresolved_conflict_ids(&conn, "rec-4");
    resolve_record_conflict_on_conn(&conn, "vfs", "items", "rec-4", "keep_cloud", None, ids)
        .expect("单侧冲突 keep_cloud 裁决应成功");

    assert_eq!(record_count(&conn, "rec-4"), 0, "采纳云端删除意图后行应删除");
    assert!(unresolved_conflict_ids(&conn, "rec-4").is_empty());
    assert_eq!(resolved_count(&conn, "rec-4", "keep_cloud"), 1);
}

/// 存量单侧 UPSERT 冲突（只有 side='cloud' 的完整 payload）：keep_cloud 应把
/// 败方 payload 写回业务表并标记 resolved。
#[test]
fn r06_legacy_cloud_only_upsert_conflict_keep_cloud_resolves() {
    let conn = new_db();
    insert_record(&conn, "rec-5", "newer-local", "2026-07-10T13:00:00Z");

    let payload = serde_json::json!({
        "id": "rec-5",
        "content": "slow-clock-write",
        "updated_at": "2026-07-10T12:00:00Z"
    });
    ConflictResolver::save_conflict_record(
        &conn,
        ConflictRecordToSave {
            table_name: "items",
            record_id: "rec-5",
            side: ConflictSide::Cloud,
            data: &payload,
            winning_device_id: None,
            losing_device_id: Some("device-slow"),
        },
    )
    .unwrap();

    let ids = unresolved_conflict_ids(&conn, "rec-5");
    resolve_record_conflict_on_conn(&conn, "vfs", "items", "rec-5", "keep_cloud", None, ids)
        .expect("单侧冲突 keep_cloud 裁决应成功");

    assert_eq!(record_content(&conn, "rec-5"), "slow-clock-write");
    assert!(unresolved_conflict_ids(&conn, "rec-5").is_empty());
    assert_eq!(resolved_count(&conn, "rec-5", "keep_cloud"), 1);
}

/// 防御边界：本地行在（单侧）冲突生成后又被用户改动 → keep_cloud 仍应
/// 被"本地已再次变化"守卫拒绝，不得用旧冲突覆盖新编辑。
///
/// 单侧兼容的 local 回退用的是"当前业务行"，因此守卫改由 cloud 侧不匹配触发：
/// 这里通过预置与当前行不同的 local 快照行来模拟"冲突后再次编辑"。
#[test]
fn r06_resolve_still_rejects_when_local_changed_after_conflict() {
    let conn = new_db();
    insert_record(&conn, "rec-6", "original", "2026-07-10T13:00:00Z");

    // 双侧落表（正常新路径）：local 快照 = original
    ConflictResolver::save_conflict_record(
        &conn,
        ConflictRecordToSave {
            table_name: "items",
            record_id: "rec-6",
            side: ConflictSide::Cloud,
            data: &serde_json::json!({
                "id": "rec-6",
                "content": "cloud-value",
                "updated_at": "2026-07-10T12:00:00Z"
            }),
            winning_device_id: None,
            losing_device_id: Some("device-slow"),
        },
    )
    .unwrap();
    ConflictResolver::save_conflict_record(
        &conn,
        ConflictRecordToSave {
            table_name: "items",
            record_id: "rec-6",
            side: ConflictSide::Local,
            data: &serde_json::json!({
                "id": "rec-6",
                "content": "original",
                "updated_at": "2026-07-10T13:00:00Z"
            }),
            winning_device_id: None,
            losing_device_id: Some("device-slow"),
        },
    )
    .unwrap();

    // 冲突生成后用户又改了本地行
    conn.execute(
        "UPDATE items SET content='edited-after-conflict', updated_at='2026-07-10T14:00:00Z'
         WHERE id='rec-6'",
        [],
    )
    .unwrap();

    let ids = unresolved_conflict_ids(&conn, "rec-6");
    let err = resolve_record_conflict_on_conn(
        &conn,
        "vfs",
        "items",
        "rec-6",
        "keep_cloud",
        None,
        ids.clone(),
    )
    .expect_err("本地已再次变化时 keep_cloud 必须被拒绝");
    assert!(
        err.contains("已再次变化"),
        "错误应说明本地记录已变化: {err}"
    );
    assert_eq!(record_content(&conn, "rec-6"), "edited-after-conflict");
    assert_eq!(
        unresolved_conflict_ids(&conn, "rec-6"),
        ids,
        "被拒绝的裁决不得动冲突行"
    );
}
