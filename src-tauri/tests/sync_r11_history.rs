//! [R11-history] 记录级时点恢复（最小版）回归测试
//!
//! ## 覆盖的契约
//!
//! 1. **执行前自动快照**：库级策略覆盖（`apply_downloaded_changes_with_conflict_guard`
//!    中 Cloud 胜方覆盖/删除本地行）与冲突面板解决命令执行前，受影响记录的
//!    当前状态被快照进本地表 `__sync_record_history`（不上云——`__` 前缀表
//!    不在变更采集范围内）。
//! 2. **单批回退**：`history::rollback_batch` 把批内记录恢复到快照时的状态；
//!    同一批只能回退一次；回退前自动创建 `rollback_undo` 撤销点批次。
//! 3. **回退不得被 change_log/回声过滤再覆盖**（本轮核心）：
//!    - 回退以 `suppress_change_log=false` 写回 → 触发器产生的 change_log
//!      条目保持 `sync_version=0`（待上传），其他设备能看到回退；
//!    - 回退把 `updated_at` 刷新为回退时刻 → 旧的云端胜方值在后续下载重放
//!      （普通 LWW 路径与 conflict guard KeepLatest 路径）中都输掉 LWW 门，
//!      不会把回退结果又覆盖回去；
//!    - 重放旧云端变更时的回声抑制（suppress=true 只标记本次回放**新产生**
//!      的 change_log 条目）不得吞掉回退留下的待上传条目。
//! 4. **保留策略**：每库最多 `DEFAULT_MAX_BATCHES` 个批次，新批次落地时
//!    最旧批次被整批清理；`prune_batches_to_cap` 可显式收紧。
//! 5. **端到端**：真实 `#[tauri::command]` 链路——resolve 命令快照
//!    （reason=conflict_resolve）→ 新增的批次列表命令可见 → 新增的回退命令
//!    恢复业务行。
//!
//! 端到端用例沿用 `sync_r06_delete_resolve_tests.rs` 的无窗口 tauri App 先例。

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use deep_student_lib::data_governance::commands_sync::{
    data_governance_list_sync_snapshot_batches, data_governance_resolve_record_conflict,
    data_governance_rollback_sync_snapshot_batch,
};
use deep_student_lib::data_governance::sync::{
    conflict_resolver::ConflictPolicy, history, ChangeOperation, SyncChangeWithData, SyncManager,
};
use rusqlite::{params, Connection};

// ============================================================================
// Fixture
// ============================================================================

/// 业务表 + __change_log + 与生产同形的 INSERT/UPDATE/DELETE 触发器。
/// 触发器是"回退必须留下待上传变更"断言的前提。幂等。
fn ensure_schema(conn: &Connection) {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS items (
            id TEXT PRIMARY KEY,
            content TEXT,
            updated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS __change_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            operation TEXT NOT NULL CHECK(operation IN ('INSERT', 'UPDATE', 'DELETE')),
            changed_at TEXT NOT NULL DEFAULT (datetime('now')),
            sync_version INTEGER DEFAULT 0
        );
        CREATE TRIGGER IF NOT EXISTS trg_items_insert
        AFTER INSERT ON items
        BEGIN
            INSERT INTO __change_log(table_name, record_id, operation)
            VALUES('items', NEW.id, 'INSERT');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_items_update
        AFTER UPDATE ON items
        BEGIN
            INSERT INTO __change_log(table_name, record_id, operation)
            VALUES('items', NEW.id, 'UPDATE');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_items_delete
        AFTER DELETE ON items
        BEGIN
            INSERT INTO __change_log(table_name, record_id, operation)
            VALUES('items', OLD.id, 'DELETE');
        END;
        "#,
    )
    .unwrap();
}

/// 制造"本地有未同步修改"的行：插入基线 → 标记已同步 → 本地再编辑
/// （触发器留下 sync_version=0 的 UPDATE 条目，resolve_one 据此判冲突）。
fn seed_locally_edited_row(conn: &Connection, record_id: &str, content: &str, updated_at: &str) {
    conn.execute(
        "INSERT INTO items(id, content, updated_at) VALUES(?1, 'base', ?2)",
        params![record_id, updated_at],
    )
    .unwrap();
    conn.execute(
        "UPDATE __change_log SET sync_version = 1 WHERE sync_version = 0",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE items SET content = ?2 WHERE id = ?1",
        params![record_id, content],
    )
    .unwrap();
}

fn cloud_update_change(record_id: &str, content: &str, ts: &str) -> SyncChangeWithData {
    SyncChangeWithData {
        table_name: "items".to_string(),
        record_id: record_id.to_string(),
        operation: ChangeOperation::Update,
        data: Some(serde_json::json!({
            "id": record_id,
            "content": content,
            "updated_at": ts,
        })),
        changed_at: ts.to_string(),
        change_log_id: None,
        database_name: Some("vfs".to_string()),
        suppress_change_log: Some(true),
        source_device_id: Some("device-cloud".to_string()),
        source_seq: Some(1),
    }
}

fn cloud_delete_change(record_id: &str, ts: &str) -> SyncChangeWithData {
    SyncChangeWithData {
        table_name: "items".to_string(),
        record_id: record_id.to_string(),
        operation: ChangeOperation::Delete,
        data: None,
        changed_at: ts.to_string(),
        change_log_id: None,
        database_name: Some("vfs".to_string()),
        suppress_change_log: Some(true),
        source_device_id: Some("device-cloud".to_string()),
        source_seq: Some(2),
    }
}

fn record_content(conn: &Connection, record_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT content FROM items WHERE id=?1",
        params![record_id],
        |row| row.get(0),
    )
    .ok()
}

fn record_updated_at(conn: &Connection, record_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT updated_at FROM items WHERE id=?1",
        params![record_id],
        |row| row.get(0),
    )
    .ok()
}

/// 该记录当前待上传（sync_version=0）的 change_log 条目数
fn pending_change_log_rows(conn: &Connection, record_id: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM __change_log
         WHERE table_name='items' AND record_id=?1 AND sync_version=0",
        params![record_id],
        |row| row.get(0),
    )
    .unwrap()
}

/// 快照表中的 (batch_id, reason, existed, data_json) 列表（按 id 升序）。
/// 表不存在（从未发生过需要快照的覆盖）时返回空。
fn snapshot_rows(
    conn: &Connection,
    record_id: &str,
) -> Vec<(String, String, bool, Option<String>)> {
    let table_exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='__sync_record_history')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    if !table_exists {
        return Vec::new();
    }
    let mut stmt = conn
        .prepare(
            "SELECT batch_id, reason, existed, data_json FROM __sync_record_history
             WHERE table_name='items' AND record_id=?1 ORDER BY id ASC",
        )
        .unwrap();
    let rows = stmt
        .query_map(params![record_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)? != 0,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .unwrap();
    rows.map(Result::unwrap).collect()
}

/// 库级策略覆盖：KeepCloud 覆盖一条本地已编辑的行，返回自动快照批次 id
fn overwrite_with_policy(conn: &Connection, record_id: &str) -> String {
    seed_locally_edited_row(conn, record_id, "local-edit", "2026-07-10T13:00:00Z");
    let (result, _) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        conn,
        &[cloud_update_change(
            record_id,
            "cloud-wins",
            "2026-07-10T14:00:00Z",
        )],
        None,
        ConflictPolicy::KeepCloud,
        Some("device-cloud"),
        Some("device-local"),
    )
    .unwrap();
    assert_eq!(result.success_count, 1, "KeepCloud 策略下云端值必须写入");
    assert_eq!(
        record_content(conn, record_id).as_deref(),
        Some("cloud-wins"),
        "前提：本地行已被云端胜方覆盖"
    );
    let snaps = snapshot_rows(conn, record_id);
    assert_eq!(snaps.len(), 1, "覆盖前应恰好留下一条快照，实际 {snaps:?}");
    snaps[0].0.clone()
}

// ============================================================================
// 1. 执行前自动快照（库级策略覆盖路径）
// ============================================================================

/// 库级策略覆盖（Cloud 胜）执行前，本地行的覆盖前状态必须进快照表。
#[test]
fn r11_policy_override_snapshots_local_row_before_overwrite() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_schema(&conn);
    overwrite_with_policy(&conn, "rec-snap");

    let snaps = snapshot_rows(&conn, "rec-snap");
    let (_, reason, existed, data_json) = &snaps[0];
    assert_eq!(reason, history::REASON_POLICY_OVERRIDE);
    assert!(*existed, "快照时记录存在");
    let data: serde_json::Value = serde_json::from_str(data_json.as_deref().unwrap()).unwrap();
    assert_eq!(
        data.get("content").and_then(|v| v.as_str()),
        Some("local-edit"),
        "快照必须是覆盖前的本地值，而不是云端胜方值"
    );
}

/// Local 胜（KeepLocal）时本地行未被改动，不产生快照——快照只对
/// "本地状态将被破坏"的覆盖负责，避免噪音批次污染撤销入口。
#[test]
fn r11_local_win_does_not_snapshot() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_schema(&conn);
    seed_locally_edited_row(&conn, "rec-localwin", "local-edit", "2026-07-10T13:00:00Z");
    let (_, conflict_result) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[cloud_update_change(
            "rec-localwin",
            "cloud-loses",
            "2026-07-10T14:00:00Z",
        )],
        None,
        ConflictPolicy::KeepLocal,
        Some("device-cloud"),
        Some("device-local"),
    )
    .unwrap();
    assert!(conflict_result.conflicts_saved > 0, "前提：确实命中了冲突");
    assert!(
        snapshot_rows(&conn, "rec-localwin").is_empty(),
        "Local 胜时本地行原样保留，不得产生快照批次"
    );
}

/// 同一批次内同一记录只保留第一次快照（覆盖前的原始状态）。
#[test]
fn r11_snapshot_dedup_within_batch_keeps_first_state() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_schema(&conn);
    let batch = history::new_batch_id();
    let first = serde_json::json!({"id": "rec-dedup", "content": "first"});
    let second = serde_json::json!({"id": "rec-dedup", "content": "second"});
    assert!(history::snapshot_record_with_data(
        &conn,
        &batch,
        history::REASON_POLICY_OVERRIDE,
        "items",
        "rec-dedup",
        Some(&first)
    )
    .unwrap());
    assert!(!history::snapshot_record_with_data(
        &conn,
        &batch,
        history::REASON_POLICY_OVERRIDE,
        "items",
        "rec-dedup",
        Some(&second)
    )
    .unwrap());
    let snaps = snapshot_rows(&conn, "rec-dedup");
    assert_eq!(snaps.len(), 1);
    assert!(
        snaps[0].3.as_deref().unwrap().contains("first"),
        "重复快照必须保留第一次（覆盖前）的状态"
    );
}

// ============================================================================
// 2. 单批回退 + 3. 回退不被 change_log/回声过滤再覆盖
// ============================================================================

/// 回退恢复记录、刷新 updated_at、留下待上传的 change_log 条目，
/// 并把批次标记为已回退（重复回退被拒）。
#[test]
fn r11_rollback_restores_record_and_leaves_pending_upload() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_schema(&conn);
    let batch = overwrite_with_policy(&conn, "rec-rollback");
    // 清空历史 pending，让断言只看回退产生的条目
    conn.execute(
        "UPDATE __change_log SET sync_version = 1 WHERE sync_version = 0",
        [],
    )
    .unwrap();

    let outcome = history::rollback_batch(&conn, &batch, None, Some("vfs")).unwrap();
    assert_eq!(outcome.restored, 1);
    assert_eq!(outcome.deleted, 0);

    assert_eq!(
        record_content(&conn, "rec-rollback").as_deref(),
        Some("local-edit"),
        "回退必须把记录恢复到快照时的本地值"
    );
    let updated_at = record_updated_at(&conn, "rec-rollback").unwrap();
    assert!(
        updated_at.as_str() > "2026-07-10T14:00:00Z",
        "回退必须刷新 updated_at 到回退时刻（否则旧云端值会在 LWW 门再次胜出），实际 {updated_at}"
    );
    assert!(
        pending_change_log_rows(&conn, "rec-rollback") > 0,
        "回退必须留下 sync_version=0 的待上传变更，其他设备才能看到回退结果"
    );

    // 批次已标记回退，重复回退被拒
    let rolled_back_at: Option<String> = conn
        .query_row(
            "SELECT MAX(rolled_back_at) FROM __sync_record_history WHERE batch_id = ?1",
            params![&batch],
            |row| row.get(0),
        )
        .unwrap();
    assert!(rolled_back_at.is_some(), "批次必须被标记为已回退");
    assert!(
        history::rollback_batch(&conn, &batch, None, Some("vfs")).is_err(),
        "同一批次不得重复回退"
    );

    // 回退前自动创建了撤销点批次（内容 = 回退前的云端胜方值）
    let undo_rows: Vec<_> = snapshot_rows(&conn, "rec-rollback")
        .into_iter()
        .filter(|(b, reason, _, _)| {
            b == &outcome.undo_batch_id && reason == history::REASON_ROLLBACK_UNDO
        })
        .collect();
    assert_eq!(undo_rows.len(), 1, "回退前必须创建 rollback_undo 撤销点");
    assert!(
        undo_rows[0].3.as_deref().unwrap().contains("cloud-wins"),
        "撤销点内容应是回退前的当前值（云端胜方）"
    );
}

/// 【本轮核心】回退之后，旧的云端胜方值在两条下载重放路径上都不得
/// 把回退结果覆盖回去；回声抑制也不得吞掉回退留下的待上传条目。
#[test]
fn r11_rollback_not_reoverwritten_by_lww_replay_or_echo_suppression() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_schema(&conn);
    let batch = overwrite_with_policy(&conn, "rec-replay");
    conn.execute(
        "UPDATE __change_log SET sync_version = 1 WHERE sync_version = 0",
        [],
    )
    .unwrap();
    history::rollback_batch(&conn, &batch, None, Some("vfs")).unwrap();
    let pending_before = pending_change_log_rows(&conn, "rec-replay");
    assert!(pending_before > 0, "前提：回退留下了待上传条目");

    // 路径一：普通下载重放（suppress=true 的回声路径 + LWW 门）
    let replay = cloud_update_change("rec-replay", "cloud-wins", "2026-07-10T14:00:00Z");
    let result = SyncManager::apply_downloaded_changes(&conn, &[replay.clone()], None).unwrap();
    assert_eq!(
        result.success_count, 0,
        "旧云端值重放必须输掉 LWW 门（updated_at 已被回退刷新），不得再次覆盖"
    );
    assert_eq!(
        record_content(&conn, "rec-replay").as_deref(),
        Some("local-edit"),
        "回退结果必须在普通重放后幸存"
    );
    assert_eq!(
        pending_change_log_rows(&conn, "rec-replay"),
        pending_before,
        "回声抑制只能标记本次回放新产生的条目，不得吞掉回退留下的待上传条目"
    );

    // 路径二：conflict guard 的 KeepLatest 重放——回退后的本地行更新，Local 必须胜
    let (guard_result, _) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[replay],
        None,
        ConflictPolicy::KeepLatest,
        Some("device-cloud"),
        Some("device-local"),
    )
    .unwrap();
    assert_eq!(
        guard_result.success_count, 0,
        "KeepLatest 下旧云端值不得胜出"
    );
    assert_eq!(
        record_content(&conn, "rec-replay").as_deref(),
        Some("local-edit"),
        "回退结果必须在 KeepLatest 重放后幸存"
    );
}

/// 同步入口允许远端时钟在 60 秒漂移窗内超前。回退版本必须严格晚于刚应用的
/// 合法未来云端胜方，不能只取本机 now；同时覆盖 UPSERT 重放与硬 DELETE
/// 版本账本两条路径。
#[test]
fn r11_rollback_beats_accepted_future_skewed_cloud_winner() {
    let cloud_ts = (chrono::Utc::now() + chrono::Duration::seconds(30))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    // UPSERT：回退后重放原云端胜方，必须被 LWW 门拒绝。
    let upsert_conn = Connection::open_in_memory().unwrap();
    ensure_schema(&upsert_conn);
    seed_locally_edited_row(
        &upsert_conn,
        "rec-future-upsert",
        "local-edit",
        "2026-07-10T13:00:00Z",
    );
    let (apply_result, _) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &upsert_conn,
        &[cloud_update_change(
            "rec-future-upsert",
            "future-cloud",
            &cloud_ts,
        )],
        None,
        ConflictPolicy::KeepCloud,
        Some("device-cloud"),
        Some("device-local"),
    )
    .unwrap();
    assert_eq!(apply_result.success_count, 1);
    let upsert_batch = snapshot_rows(&upsert_conn, "rec-future-upsert")[0]
        .0
        .clone();
    upsert_conn
        .execute(
            "UPDATE __change_log SET sync_version = 1 WHERE sync_version = 0",
            [],
        )
        .unwrap();

    history::rollback_batch(&upsert_conn, &upsert_batch, None, Some("vfs")).unwrap();
    let rollback_ts = record_updated_at(&upsert_conn, "rec-future-upsert").unwrap();
    assert!(
        chrono::DateTime::parse_from_rfc3339(&rollback_ts).unwrap()
            > chrono::DateTime::parse_from_rfc3339(&cloud_ts).unwrap(),
        "回退 updated_at 必须严格晚于允许漂移窗内的云端胜方"
    );
    let replay = SyncManager::apply_downloaded_changes(
        &upsert_conn,
        &[cloud_update_change(
            "rec-future-upsert",
            "future-cloud",
            &cloud_ts,
        )],
        None,
    )
    .unwrap();
    assert_eq!(replay.success_count, 0, "未来云端旧胜方不得再次覆盖回退");
    assert_eq!(
        record_content(&upsert_conn, "rec-future-upsert").as_deref(),
        Some("local-edit")
    );
    assert!(
        pending_change_log_rows(&upsert_conn, "rec-future-upsert") > 0,
        "未来时钟场景的回退同样必须留下待上传 change_log"
    );

    // hard DELETE：回退 UPSERT 必须胜过 __sync_delete_versions 中的未来删除版本。
    let delete_conn = Connection::open_in_memory().unwrap();
    ensure_schema(&delete_conn);
    seed_locally_edited_row(
        &delete_conn,
        "rec-future-delete",
        "local-edit",
        "2026-07-10T13:00:00Z",
    );
    let (delete_result, _) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &delete_conn,
        &[cloud_delete_change("rec-future-delete", &cloud_ts)],
        None,
        ConflictPolicy::KeepCloud,
        Some("device-cloud"),
        Some("device-local"),
    )
    .unwrap();
    assert_eq!(delete_result.success_count, 1);
    assert!(record_content(&delete_conn, "rec-future-delete").is_none());
    let delete_batch = snapshot_rows(&delete_conn, "rec-future-delete")[0]
        .0
        .clone();

    let outcome = history::rollback_batch(&delete_conn, &delete_batch, None, Some("vfs")).unwrap();
    assert_eq!(outcome.restored, 1);
    assert_eq!(
        record_content(&delete_conn, "rec-future-delete").as_deref(),
        Some("local-edit"),
        "回退复活不得被未来 DELETE 版本账本拦截"
    );
    let delete_replay = SyncManager::apply_downloaded_changes(
        &delete_conn,
        &[cloud_delete_change("rec-future-delete", &cloud_ts)],
        None,
    )
    .unwrap();
    assert_eq!(
        delete_replay.success_count, 0,
        "旧未来 DELETE 重放必须输给回退版本"
    );
    assert_eq!(
        record_content(&delete_conn, "rec-future-delete").as_deref(),
        Some("local-edit")
    );
}

/// 云端 DELETE 胜（KeepCloud）删除本地行前留快照；回退令行复活；
/// 再回退撤销点批次（existed=0）把行删掉——完整还原链闭环。
#[test]
fn r11_delete_overwrite_rollback_resurrects_then_undo_deletes_again() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_schema(&conn);
    seed_locally_edited_row(&conn, "rec-del", "local-edit", "2026-07-10T13:00:00Z");
    let (result, _) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[cloud_delete_change("rec-del", "2026-07-10T14:00:00Z")],
        None,
        ConflictPolicy::KeepCloud,
        Some("device-cloud"),
        Some("device-local"),
    )
    .unwrap();
    assert_eq!(result.success_count, 1, "KeepCloud 下云端 DELETE 必须生效");
    assert!(
        record_content(&conn, "rec-del").is_none(),
        "前提：本地行已被删除"
    );

    let snaps = snapshot_rows(&conn, "rec-del");
    assert_eq!(snaps.len(), 1, "DELETE 覆盖前也必须留快照");
    assert!(snaps[0].2, "快照时记录仍存在（existed=1）");

    let outcome = history::rollback_batch(&conn, &snaps[0].0, None, Some("vfs")).unwrap();
    assert_eq!(outcome.restored, 1);
    assert_eq!(
        record_content(&conn, "rec-del").as_deref(),
        Some("local-edit"),
        "回退必须令被删除的行复活"
    );

    // 撤销点批次记录的是"回退前行不存在"（existed=0）；回退它 = 再次删除
    let undo_outcome =
        history::rollback_batch(&conn, &outcome.undo_batch_id, None, Some("vfs")).unwrap();
    assert_eq!(undo_outcome.deleted, 1);
    assert!(
        record_content(&conn, "rec-del").is_none(),
        "回退撤销点批次后行应回到不存在状态"
    );
}

// ============================================================================
// 4. 保留策略
// ============================================================================

/// 新批次落地时自动裁剪到 DEFAULT_MAX_BATCHES；显式 prune 可进一步收紧。
#[test]
fn r11_retention_caps_batches_and_prunes_oldest() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_schema(&conn);

    let total = history::DEFAULT_MAX_BATCHES + 5;
    let mut batch_ids = Vec::new();
    for i in 0..total {
        let batch = format!("batch-{:04}", i);
        history::snapshot_record_with_data(
            &conn,
            &batch,
            history::REASON_POLICY_OVERRIDE,
            "items",
            &format!("rec-{i}"),
            Some(&serde_json::json!({"id": format!("rec-{i}"), "content": "x"})),
        )
        .unwrap();
        batch_ids.push(batch);
    }

    let distinct_batches: i64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT batch_id) FROM __sync_record_history",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        distinct_batches as usize,
        history::DEFAULT_MAX_BATCHES,
        "批次数必须被保留策略钳制在上限"
    );

    let oldest_survives: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __sync_record_history WHERE batch_id = ?1",
            params![&batch_ids[0]],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(oldest_survives, 0, "最旧的批次必须被清理");
    let newest_survives: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __sync_record_history WHERE batch_id = ?1",
            params![batch_ids.last().unwrap()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(newest_survives, 1, "最新的批次必须幸存");

    // 显式收紧到 3 个批次
    history::prune_batches_to_cap(&conn, 3).unwrap();
    let after: i64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT batch_id) FROM __sync_record_history",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(after, 3);
}

// ============================================================================
// 5. 端到端：resolve 命令快照 → 列表命令可见 → 回退命令恢复
// ============================================================================

/// 进程级共享测试环境（同 sync_r06_delete_resolve_tests 先例）
fn active_data_dir() -> &'static PathBuf {
    static ACTIVE_DIR: OnceLock<PathBuf> = OnceLock::new();
    ACTIVE_DIR.get_or_init(|| {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base =
            std::env::temp_dir().join(format!("ds-r11-history-{}-{nonce}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        deep_student_lib::data_space::init_data_space_manager(base)
            .expect("初始化测试 DataSpaceManager 失败");
        deep_student_lib::data_space::get_data_space_manager()
            .expect("DataSpaceManager 刚初始化即应可用")
            .active_dir()
    })
}

fn open_active_vfs_db() -> Connection {
    let db_path = active_data_dir().join("databases").join("vfs.db");
    std::fs::create_dir_all(db_path.parent().unwrap()).unwrap();
    let conn = Connection::open(&db_path).unwrap();
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    ensure_schema(&conn);
    conn
}

fn build_headless_app() -> tauri::App {
    let builder = tauri::Builder::default();
    #[cfg(any(target_os = "linux", windows))]
    let builder = builder.any_thread();
    builder
        .build(tauri::generate_context!())
        .expect("构建无窗口 tauri App 失败")
}

fn command_serial_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 冲突面板解决命令（keep_cloud，会覆盖本地行）执行前自动快照
/// （reason=conflict_resolve）；新命令能列出批次并按批回退恢复本地值。
#[test]
fn r11_resolve_command_snapshots_and_new_commands_browse_and_rollback() {
    let _serial = command_serial_lock();
    let record_id = "r11-e2e-rec";
    let expected_ids = {
        let conn = open_active_vfs_db();
        // KeepLocal 策略制造双侧冲突：本地行保留、local+cloud 两行入冲突表
        seed_locally_edited_row(&conn, record_id, "local-edit", "2026-07-10T13:00:00Z");
        let (_, conflict_result) = SyncManager::apply_downloaded_changes_with_conflict_guard(
            &conn,
            &[cloud_update_change(
                record_id,
                "cloud-candidate",
                "2026-07-10T14:00:00Z",
            )],
            None,
            ConflictPolicy::KeepLocal,
            Some("device-cloud"),
            Some("device-local"),
        )
        .unwrap();
        assert!(conflict_result.conflicts_saved >= 2, "前提：双侧冲突已入表");
        let mut stmt = conn
            .prepare(
                "SELECT id FROM __sync_conflicts
                 WHERE table_name='items' AND record_id=?1 AND resolved_at IS NULL
                 ORDER BY id ASC",
            )
            .unwrap();
        let ids: Vec<i64> = stmt
            .query_map(params![record_id], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert!(!ids.is_empty());
        ids
    };

    let app = build_headless_app();
    let handle = app.handle().clone();

    // 冲突面板「采用云端」= 覆盖本地行的危险操作，执行前必须自动快照
    tauri::async_runtime::block_on(data_governance_resolve_record_conflict(
        handle.clone(),
        "vfs".to_string(),
        "items".to_string(),
        record_id.to_string(),
        "keep_cloud".to_string(),
        None,
        expected_ids,
    ))
    .expect("keep_cloud 解决应成功");

    {
        let conn = open_active_vfs_db();
        assert_eq!(
            record_content(&conn, record_id).as_deref(),
            Some("cloud-candidate"),
            "前提：本地行已被云端候选覆盖"
        );
    }

    // 新命令一：快照批次列表必须包含 conflict_resolve 批次
    let batches = tauri::async_runtime::block_on(data_governance_list_sync_snapshot_batches(
        handle.clone(),
        None,
    ))
    .expect("列出快照批次不应失败");
    let resolve_batch = batches
        .iter()
        .find(|b| b.database_name == "vfs" && b.reason == history::REASON_CONFLICT_RESOLVE)
        .expect("必须存在 conflict_resolve 快照批次");
    assert!(resolve_batch.record_count >= 1);
    assert!(resolve_batch.rolled_back_at.is_none());

    // 新命令二：单批回退恢复覆盖前的本地值
    let outcome = tauri::async_runtime::block_on(data_governance_rollback_sync_snapshot_batch(
        handle,
        "vfs".to_string(),
        resolve_batch.batch_id.clone(),
    ))
    .expect("回退命令应成功");
    assert_eq!(outcome.restored, 1);
    assert!(!outcome.undo_batch_id.is_empty());

    let conn = open_active_vfs_db();
    assert_eq!(
        record_content(&conn, record_id).as_deref(),
        Some("local-edit"),
        "回退命令必须恢复覆盖前的本地值"
    );
    assert!(
        pending_change_log_rows(&conn, record_id) > 0,
        "回退结果必须进入待上传变更"
    );
}
