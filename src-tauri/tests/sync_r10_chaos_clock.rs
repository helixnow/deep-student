//! [R10-chaos] 时钟混沌：慢钟 / 时钟回拨 / 快钟 场景下的 LWW 门与 tombstone
//! 时间戳校验，从外部 crate 视角（公开 API）钉死以下不变量：
//!
//! 1. **慢钟 UPDATE 输 LWW 不静默丢**：时钟落后设备的写入输给更新的本地行后，
//!    败方 payload 必须落 `__sync_conflicts`（side='cloud'），重复投递被去重；
//! 2. **同设备时钟回拨不得自我覆盖**：设备先以 T2 写入 v1，随后时钟回拨到 T1
//!    再写 v2 —— 较旧时间戳的 v2 不得覆盖 v1（不允许"回拨复活旧状态"）；
//! 3. **快钟（远超前时间戳）写入进隔离区**：超出 60s 漂移窗口的云端变更
//!    fail-closed 落 `__sync_quarantine`（可见、可重放），本地行原样保留，
//!    重复投递 attempts 递增不重复建行；
//! 4. **回拨 DELETE 输 LWW + tombstone 时间戳校验**：慢钟删除意图以 Null payload
//!    落冲突表；文件级 tombstone 的时间戳校验拒绝不可解析值（硬错误）与
//!    远超前值（ClockDriftSuspected），正常过去时间戳放行。
//!
//! 相邻覆盖（不重复）：R05 已锁定慢钟 DELETE 落冲突表与不可解析 changed_at
//! 进隔离区；本文件补的是 UPDATE 败方、同设备回拨、快钟隔离与 tombstone
//! 校验子的组合面。

use deep_student_lib::data_governance::sync::{
    conflict_resolver::ConflictPolicy, tombstone::validate_tombstone_timestamp, ChangeOperation,
    SyncChangeWithData, SyncError, SyncManager,
};
use rusqlite::{params, Connection};
use serde_json::json;

// ============================================================================
// Fixture：items 业务表 + __change_log（无触发器，测试自行控制 pending 状态）
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

fn upsert_change(
    record_id: &str,
    content: &str,
    updated_at: &str,
    source_device_id: &str,
    source_seq: u64,
) -> SyncChangeWithData {
    SyncChangeWithData {
        table_name: "items".to_string(),
        record_id: record_id.to_string(),
        operation: ChangeOperation::Update,
        data: Some(json!({
            "id": record_id,
            "content": content,
            "updated_at": updated_at,
        })),
        changed_at: updated_at.to_string(),
        change_log_id: None,
        database_name: Some("vfs".to_string()),
        suppress_change_log: Some(true),
        source_device_id: Some(source_device_id.to_string()),
        source_seq: Some(source_seq),
    }
}

fn delete_change(
    record_id: &str,
    changed_at: &str,
    source_device_id: &str,
    source_seq: u64,
) -> SyncChangeWithData {
    SyncChangeWithData {
        table_name: "items".to_string(),
        record_id: record_id.to_string(),
        operation: ChangeOperation::Delete,
        data: None,
        changed_at: changed_at.to_string(),
        change_log_id: None,
        database_name: Some("vfs".to_string()),
        suppress_change_log: Some(true),
        source_device_id: Some(source_device_id.to_string()),
        source_seq: Some(source_seq),
    }
}

fn apply_guarded(
    conn: &Connection,
    changes: &[SyncChangeWithData],
    cloud_device: &str,
) -> (
    deep_student_lib::data_governance::sync::ApplyChangesResult,
    deep_student_lib::data_governance::sync::conflict_resolver::ConflictAwareApplyResult,
) {
    SyncManager::apply_downloaded_changes_with_conflict_guard(
        conn,
        changes,
        None,
        ConflictPolicy::KeepLatest,
        Some(cloud_device),
        Some("device-local"),
    )
    .unwrap()
}

fn row(conn: &Connection, id: &str) -> Option<(String, String)> {
    conn.query_row(
        "SELECT content, updated_at FROM items WHERE id=?1",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .ok()
}

fn conflict_rows(conn: &Connection, record_id: &str) -> Vec<(String, String, Option<String>)> {
    let mut stmt = conn
        .prepare(
            "SELECT side, data_json, losing_device_id FROM __sync_conflicts
             WHERE table_name='items' AND record_id=?1 ORDER BY id",
        )
        .unwrap();
    let rows = stmt
        .query_map(params![record_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    rows
}

// ============================================================================
// 1. 慢钟 UPDATE 输 LWW → 败方 payload 落冲突表且去重
// ============================================================================

#[test]
fn r10_chaos_slow_clock_update_loses_lww_and_lands_in_conflicts() {
    let conn = new_db();
    insert_record(&conn, "rec-slow", "newer-local", "2026-07-10T13:00:00Z");

    // 慢钟设备：payload updated_at 早于本地 → 输 LWW
    let stale = upsert_change(
        "rec-slow",
        "slow-clock-overwrite",
        "2026-07-10T12:00:00Z",
        "device-slow",
        1,
    );

    // 混沌语义：网络重试导致同一变更被投递三次
    for round in 0..3 {
        let (result, _) = apply_guarded(&conn, &[stale.clone()], "device-slow");
        assert_eq!(
            result.success_count, 0,
            "round {round}: 较旧 UPDATE 不得生效"
        );
        assert_eq!(result.failure_count, 0, "round {round}: LWW 拒绝不是失败");
        assert_eq!(
            result.skipped_count, 1,
            "round {round}: 较旧 UPDATE 应被跳过"
        );
    }

    assert_eq!(
        row(&conn, "rec-slow"),
        Some((
            "newer-local".to_string(),
            "2026-07-10T13:00:00Z".to_string()
        )),
        "本地更新的行必须原样保留"
    );

    let conflicts = conflict_rows(&conn, "rec-slow");
    assert_eq!(
        conflicts.len(),
        1,
        "败方 UPDATE 应入冲突表且三次重复投递被去重: {conflicts:?}"
    );
    let (side, data_json, losing_device) = &conflicts[0];
    assert_eq!(side, "cloud", "败方是云端写入");
    assert!(
        data_json.contains("slow-clock-overwrite"),
        "败方 payload 必须完整可见供手动采纳: {data_json}"
    );
    assert_eq!(losing_device.as_deref(), Some("device-slow"));
}

// ============================================================================
// 2. 同设备时钟回拨：较旧时间戳不得覆盖已应用的较新状态
// ============================================================================

#[test]
fn r10_chaos_clock_rollback_same_device_cannot_overwrite_newer_state() {
    let conn = new_db();

    // 第一批：设备时钟正常，写入 v1@13:00 —— 正常应用
    let v1 = upsert_change(
        "rec-rollback",
        "v1-before-rollback",
        "2026-07-10T13:00:00Z",
        "device-rollback",
        1,
    );
    let (result, _) = apply_guarded(&conn, &[v1], "device-rollback");
    assert_eq!(result.success_count, 1, "正常时间戳的首次写入应成功");

    // 第二批：同一设备时钟被回拨一小时，又写了 v2@12:00
    let v2 = upsert_change(
        "rec-rollback",
        "v2-after-rollback",
        "2026-07-10T12:00:00Z",
        "device-rollback",
        2,
    );
    let (result, _) = apply_guarded(&conn, &[v2], "device-rollback");
    assert_eq!(
        result.success_count, 0,
        "时钟回拨后的旧时间戳写入不得覆盖较新状态"
    );
    assert_eq!(result.skipped_count, 1, "回拨写入应被 LWW 门跳过");

    assert_eq!(
        row(&conn, "rec-rollback"),
        Some((
            "v1-before-rollback".to_string(),
            "2026-07-10T13:00:00Z".to_string()
        )),
        "回拨不得复活旧状态：v1 必须保留"
    );

    // 回拨写入的意图不丢：落冲突表供手动采纳
    let conflicts = conflict_rows(&conn, "rec-rollback");
    assert_eq!(conflicts.len(), 1, "回拨败方应入冲突表: {conflicts:?}");
    assert!(
        conflicts[0].1.contains("v2-after-rollback"),
        "回拨败方 payload 可见: {}",
        conflicts[0].1
    );
}

// ============================================================================
// 3. 快钟：远超前时间戳的云端变更 fail-closed 进隔离区
// ============================================================================

#[test]
fn r10_chaos_fast_clock_far_future_update_quarantined_not_applied() {
    let conn = new_db();
    insert_record(&conn, "rec-fast", "must-survive", "2026-07-10T13:00:00Z");

    // 快钟设备：时间戳在本地 wall clock 未来 2 小时（远超 60s 漂移窗口）
    let far_future = (chrono::Utc::now() + chrono::Duration::hours(2))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let fast = upsert_change("rec-fast", "from-the-future", &far_future, "device-fast", 1);

    for round in 0..2 {
        let (result, _) = apply_guarded(&conn, &[fast.clone()], "device-fast");
        assert_eq!(
            result.success_count, 0,
            "round {round}: 远超前时间戳的变更不得应用"
        );
        assert_eq!(
            result.failure_count, 1,
            "round {round}: 疑似漂移必须 fail-closed 而非静默跳过"
        );
    }

    assert_eq!(
        row(&conn, "rec-fast"),
        Some((
            "must-survive".to_string(),
            "2026-07-10T13:00:00Z".to_string()
        )),
        "本地行不得被未来时间戳覆盖"
    );

    // 隔离区可见、可重放：同一变更重复投递去重且 attempts 递增
    let (count, error, attempts): (i64, String, i64) = conn
        .query_row(
            "SELECT COUNT(*), error, attempts FROM __sync_quarantine
             WHERE table_name='items' AND record_id='rec-fast'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(count, 1, "重复投递的漂移变更应在隔离区去重");
    assert!(
        error.to_lowercase().contains("drift"),
        "隔离原因应指明时钟漂移: {error}"
    );
    assert_eq!(attempts, 2, "重复投递应递增 attempts 而非重复建行");
}

// ============================================================================
// 4. 回拨 DELETE 输 LWW + tombstone 时间戳校验（garbage / 远超前 / 正常）
// ============================================================================

#[test]
fn r10_chaos_rollback_delete_loses_lww_and_tombstone_timestamp_validation() {
    let conn = new_db();
    insert_record(&conn, "rec-del", "survives-delete", "2026-07-10T13:00:00Z");

    // 回拨设备发出的删除意图：changed_at 早于本地行 → 输 LWW，行保留
    let stale_delete = delete_change("rec-del", "2026-07-10T12:30:00Z", "device-del-rollback", 1);
    let (result, _) = apply_guarded(&conn, &[stale_delete], "device-del-rollback");
    assert_eq!(result.success_count, 0, "回拨 DELETE 不得生效");
    assert_eq!(result.skipped_count, 1);
    assert!(
        row(&conn, "rec-del").is_some(),
        "本地较新行不得被回拨 DELETE 硬删"
    );
    let conflicts = conflict_rows(&conn, "rec-del");
    assert_eq!(conflicts.len(), 1, "删除意图不得静默丢弃: {conflicts:?}");
    assert_eq!(conflicts[0].1, "null", "DELETE 败方以 Null payload 表示");

    // 文件级 tombstone 时间戳校验子：
    // (a) 不可解析 → 硬错误（fail-closed，绝不进 LWW 比较）
    let garbage = validate_tombstone_timestamp("definitely-not-a-timestamp", "blob")
        .expect_err("不可解析的 tombstone 时间戳必须拒绝");
    assert!(
        garbage.to_string().contains("时间戳无效"),
        "错误应指明时间戳无效: {garbage}"
    );

    // (b) 远超前（快钟）→ ClockDriftSuspected（调用方跳过且不推进水位）
    let far_future = (chrono::Utc::now() + chrono::Duration::hours(3)).to_rfc3339();
    let drift = validate_tombstone_timestamp(&far_future, "blob")
        .expect_err("远超前的 tombstone 时间戳必须拒绝");
    assert!(
        matches!(drift, SyncError::ClockDriftSuspected { .. }),
        "超前 tombstone 应报 ClockDriftSuspected: {drift}"
    );

    // (c) 正常过去时间戳 → 放行（删除意图不因校验误伤）
    validate_tombstone_timestamp("2026-07-10T12:00:00Z", "blob")
        .expect("正常过去时间戳的 tombstone 必须放行");

    // (d) 60s 窗口内的轻微超前 → 放行（正常时钟抖动不误伤）
    let slight_future = (chrono::Utc::now() + chrono::Duration::seconds(30)).to_rfc3339();
    validate_tombstone_timestamp(&slight_future, "blob")
        .expect("漂移窗口内的轻微超前 tombstone 必须放行");
}
