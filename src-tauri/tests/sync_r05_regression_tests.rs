//! [R05-tests] 回归集成测试：从库公开 API（不经 Tauri runtime）覆盖三条
//! 近期加固的同步保护路径，防止后续重构悄悄退化：
//!
//! 1. **慢钟败方 DELETE 落冲突表**：输掉 LWW 门的 DELETE（慢钟设备的删除意图）
//!    不得被静默丢弃，必须以 Null payload 落 `__sync_conflicts`（side='cloud'），
//!    且重复投递被 (table, record, side, data_hash) 部分唯一索引去重。
//! 2. **不可解析 changed_at 的 DELETE 进隔离区**：漂移检查与 LWW 门都无法运行时
//!    fail-closed —— 本地行保留、变更落 `__sync_quarantine`（可见、可重放/手动处理），
//!    绝不无条件硬删。
//! 3. **记录级上传的 E2EE 一致性策略**：云端 root 已有 `.encryption-marker`
//!    （记录级/ZIP 共用同一标记）而本机未配置加密密码时，明文记录级上传必须被拒绝，
//!    避免同一恢复链上明文/密文混布。
//!
//! 这些行为在 `data_governance::sync::mod` 内已有单元测试；本文件把它们提升到
//! 集成测试层（外部 crate 视角），保证公开 API 表面同样兑现这些不变量。

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::Utc;
use deep_student_lib::cloud_storage::{CloudStorage, CloudSyncManager, FileInfo};
use deep_student_lib::data_governance::sync::{
    conflict_resolver::ConflictPolicy, ChangeOperation, SyncChangeWithData, SyncManager,
};
use deep_student_lib::models::AppError;
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

fn record_count(conn: &Connection, id: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM items WHERE id=?1",
        params![id],
        |row| row.get(0),
    )
    .unwrap()
}

// ============================================================================
// 1. 慢钟败方 DELETE 落冲突表
// ============================================================================

/// 本地无 pending 修改（LWW 门路径）：慢钟设备的 DELETE 输给更新的本地行后，
/// 删除意图必须以 Null payload 落 `__sync_conflicts`（side='cloud'），
/// 重复投递去重，且不能物理删除本地行。
#[test]
fn r05_slow_clock_delete_losing_lww_lands_in_sync_conflicts() {
    let conn = new_db();
    insert_record(&conn, "rec-1", "newer-local", "2026-07-10T13:00:00Z");

    // 慢钟设备：changed_at 早于本地 updated_at → 输掉 LWW
    let stale_delete = delete_change("rec-1", "2026-07-10T12:00:00Z", "device-slow", 1);

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
        assert_eq!(
            result.success_count, 0,
            "round {round}: 较旧 DELETE 不得生效"
        );
        assert_eq!(result.failure_count, 0, "round {round}: LWW 拒绝不是失败");
        assert_eq!(
            result.skipped_count, 1,
            "round {round}: 较旧 DELETE 应被 LWW 拒绝"
        );
    }

    assert_eq!(record_count(&conn, "rec-1"), 1, "更新的本地行必须保留");
    let content: String = conn
        .query_row("SELECT content FROM items WHERE id='rec-1'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(content, "newer-local", "本地内容不得被慢钟 DELETE 影响");

    let (count, side, data_json, losing_device, resolved_at): (
        i64,
        String,
        String,
        Option<String>,
        Option<String>,
    ) = conn
        .query_row(
            "SELECT COUNT(*), side, data_json, losing_device_id, resolved_at
             FROM __sync_conflicts
             WHERE table_name='items' AND record_id='rec-1'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(count, 1, "败方 DELETE 应入冲突表且重复投递被去重");
    assert_eq!(side, "cloud", "败方是云端删除意图");
    assert_eq!(data_json, "null", "DELETE 败方以 Null payload 表示");
    assert_eq!(losing_device.as_deref(), Some("device-slow"));
    assert!(resolved_at.is_none(), "新冲突应处于未解决状态，供 UI 处理");
}

/// 本地有 pending 修改（resolve_one 冲突路径）：KeepLatest 下慢钟 DELETE 输给
/// 更新的本地行，胜方（local 快照）与败方（cloud Null）都要入冲突表，本地行保留。
#[test]
fn r05_slow_clock_delete_with_local_pending_change_records_both_sides() {
    let conn = new_db();
    insert_record(&conn, "rec-2", "local-pending-edit", "2026-07-10T13:00:00Z");
    // 手工登记一条未同步的本地变更，触发 resolve_one 的冲突检测前提
    conn.execute(
        "INSERT INTO __change_log(table_name, record_id, operation, changed_at, sync_version)
         VALUES('items', 'rec-2', 'UPDATE', '2026-07-10T13:00:00Z', 0)",
        [],
    )
    .unwrap();

    let stale_delete = delete_change("rec-2", "2026-07-10T12:00:00Z", "device-slow", 2);
    let (result, conflict) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[stale_delete],
        None,
        ConflictPolicy::KeepLatest,
        Some("device-slow"),
        Some("device-local"),
    )
    .unwrap();

    assert_eq!(result.success_count, 0, "本地胜出时云端 DELETE 不得应用");
    assert_eq!(conflict.rejected, 1, "冲突路径应记录一次拒绝");
    assert_eq!(conflict.conflicts_saved, 2, "胜败双方快照都应入冲突表");
    assert_eq!(record_count(&conn, "rec-2"), 1, "本地行保留");

    let cloud_null: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __sync_conflicts
             WHERE table_name='items' AND record_id='rec-2'
               AND side='cloud' AND data_json='null'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(cloud_null, 1, "败方云端 DELETE 以 Null payload 入表");

    let local_snapshot: String = conn
        .query_row(
            "SELECT data_json FROM __sync_conflicts
             WHERE table_name='items' AND record_id='rec-2' AND side='local'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        local_snapshot.contains("local-pending-edit"),
        "胜方本地快照应完整可见: {local_snapshot}"
    );
}

// ============================================================================
// 2. 不可解析 changed_at 的 DELETE 进隔离区
// ============================================================================

/// changed_at 无法按 HLC / RFC3339 / SQLite datetime / 毫秒数解析时，
/// 漂移检查与 LWW 门都无法运行：必须 fail-closed 落 `__sync_quarantine`，
/// 本地行原样保留；同一变更重复投递时隔离条目去重且 attempts 递增。
#[test]
fn r05_delete_with_unparseable_changed_at_goes_to_quarantine() {
    let conn = new_db();
    insert_record(&conn, "rec-3", "must-survive", "2026-07-10T13:00:00Z");

    let bad_delete = delete_change("rec-3", "not-a-timestamp", "device-bad-clock", 3);

    let (result, _) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[bad_delete.clone()],
        None,
        ConflictPolicy::KeepLatest,
        Some("device-bad-clock"),
        Some("device-local"),
    )
    .unwrap();
    assert_eq!(result.success_count, 0);
    assert_eq!(
        result.failure_count, 1,
        "changed_at 不可解析的 DELETE 必须 fail-closed 而非静默应用/跳过"
    );

    assert_eq!(
        record_count(&conn, "rec-3"),
        1,
        "本地行不得被不可解析时间戳的 DELETE 硬删"
    );

    let (count, operation, error, payload_json, attempts_first): (
        i64,
        String,
        String,
        Option<String>,
        i64,
    ) = conn
        .query_row(
            "SELECT COUNT(*), operation, error, payload_json, attempts
             FROM __sync_quarantine
             WHERE table_name='items' AND record_id='rec-3'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        count, 1,
        "fail-closed 的 DELETE 必须落隔离区（可见、可处理）"
    );
    assert_eq!(operation, "DELETE");
    assert!(
        error.contains("changed_at"),
        "隔离原因应指出 changed_at 不可解析: {error}"
    );
    let payload = payload_json.expect("隔离条目必须保留完整 payload 供重放/手动处理");
    assert!(
        payload.contains("not-a-timestamp"),
        "payload 应含原始 changed_at: {payload}"
    );

    // 同一变更重复投递：隔离条目去重（UNIQUE 五元组），attempts 递增
    let (result, _) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[bad_delete],
        None,
        ConflictPolicy::KeepLatest,
        Some("device-bad-clock"),
        Some("device-local"),
    )
    .unwrap();
    assert_eq!(result.failure_count, 1, "重复投递依旧 fail-closed");

    let (count_after, attempts_after): (i64, i64) = conn
        .query_row(
            "SELECT COUNT(*), attempts FROM __sync_quarantine
             WHERE table_name='items' AND record_id='rec-3'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(count_after, 1, "重复投递不得产生第二条隔离记录");
    assert_eq!(
        attempts_after,
        attempts_first + 1,
        "重复投递应递增 attempts 而非新增条目"
    );
    assert_eq!(record_count(&conn, "rec-3"), 1, "本地行仍然保留");
}

// ============================================================================
// 3. 记录级上传：云端有加密标记而本机无密码 → 拒绝
// ============================================================================

/// 内存云存储：与生产 `CloudStorage` trait 完全同形，可克隆句柄共享底层对象，
/// 便于模拟"设备 A 写入加密标记后设备 B 连同一 root"。
#[derive(Clone, Default)]
struct MemoryCloudStorage {
    files: Arc<Mutex<BTreeMap<String, (Vec<u8>, chrono::DateTime<Utc>)>>>,
}

#[async_trait]
impl CloudStorage for MemoryCloudStorage {
    fn provider_name(&self) -> &'static str {
        "memory-r05"
    }

    async fn check_connection(&self) -> Result<(), AppError> {
        Ok(())
    }

    async fn put(&self, key: &str, data: &[u8]) -> Result<(), AppError> {
        self.files
            .lock()
            .unwrap()
            .insert(key.to_string(), (data.to_vec(), Utc::now()));
        Ok(())
    }

    async fn get(&self, key: &str) -> Result<Option<Vec<u8>>, AppError> {
        Ok(self
            .files
            .lock()
            .unwrap()
            .get(key)
            .map(|(data, _)| data.clone()))
    }

    async fn list(&self, prefix: &str) -> Result<Vec<FileInfo>, AppError> {
        Ok(self
            .files
            .lock()
            .unwrap()
            .iter()
            .filter(|(key, _)| key.starts_with(prefix))
            .map(|(key, (data, modified))| FileInfo {
                key: key.clone(),
                size: data.len() as u64,
                last_modified: *modified,
                etag: None,
            })
            .collect())
    }

    async fn delete(&self, key: &str) -> Result<(), AppError> {
        self.files.lock().unwrap().remove(key);
        Ok(())
    }

    async fn stat(&self, key: &str) -> Result<Option<FileInfo>, AppError> {
        Ok(self
            .files
            .lock()
            .unwrap()
            .get(key)
            .map(|(data, modified)| FileInfo {
                key: key.to_string(),
                size: data.len() as u64,
                last_modified: *modified,
                etag: None,
            }))
    }
}

fn manager_on(storage: &MemoryCloudStorage, device_id: &str) -> CloudSyncManager {
    CloudSyncManager::new(Box::new(storage.clone()), device_id.to_string())
}

/// 记录级上传前的一致性策略（`enforce_record_upload_encryption_policy` 委托的
/// `CloudSyncManager::enforce_encryption_policy_before_upload`）：
/// 设备 A 以加密模式上传后云端留下 `.encryption-marker`；设备 B 未配置密码时
/// 对同一 root 的明文记录级上传必须被拒绝，且标记原样保留（不被破坏/覆盖）。
#[tokio::test]
async fn r05_record_upload_with_marker_but_no_password_is_rejected() {
    let storage = MemoryCloudStorage::default();

    // 设备 A：配置了加密密码 → 策略幂等写入加密标记后放行
    let device_a = manager_on(&storage, "device-a");
    device_a
        .enforce_encryption_policy_before_upload(true)
        .await
        .expect("有密码的记录级上传应放行并写入加密标记");
    let marker = device_a
        .read_encryption_marker()
        .await
        .unwrap()
        .expect("加密上传后云端必须可见 .encryption-marker");
    assert_eq!(
        marker.created_by_device,
        deep_student_lib::cloud_storage::device_id_short_hash("device-a")
    );

    // 设备 B：同一 root、未配置密码 → 明文记录级上传必须被拒绝
    let device_b = manager_on(&storage, "device-b");
    let error = device_b
        .enforce_encryption_policy_before_upload(false)
        .await
        .expect_err("云端有加密标记且本机无密码时必须拒绝明文记录级上传");
    let message = error.to_string();
    assert!(
        message.contains("已存在端到端加密备份"),
        "错误应说明拒绝原因（root 已有加密备份）: {message}"
    );
    assert!(
        message.contains("加密密码"),
        "错误应引导用户补配加密密码: {message}"
    );

    // 被拒绝的尝试不得破坏或覆盖既有标记
    let marker_after = device_b
        .read_encryption_marker()
        .await
        .unwrap()
        .expect("拒绝路径不得删除加密标记");
    assert_eq!(
        marker_after.created_by_device,
        deep_student_lib::cloud_storage::device_id_short_hash("device-a"),
        "标记归属不得被无密码设备改写"
    );
}

/// 对照组：云端没有加密标记时，未配置密码的明文记录级上传应放行
/// （策略只防"曾出现过加密备份的 root 混入明文"，不阻止纯明文实例）。
#[tokio::test]
async fn r05_record_upload_without_marker_and_no_password_is_allowed() {
    let storage = MemoryCloudStorage::default();
    let manager = manager_on(&storage, "device-plain");
    manager
        .enforce_encryption_policy_before_upload(false)
        .await
        .expect("无标记 + 无密码的明文上传应放行");
    assert!(
        manager.read_encryption_marker().await.unwrap().is_none(),
        "明文路径不得凭空写入加密标记"
    );
}

/// 标记内容损坏（非 JSON）时按"存在"处理（fail-closed）：
/// 无密码设备仍被拒绝，宁可多拦一次也不放行明文。
#[tokio::test]
async fn r05_corrupted_marker_still_blocks_plaintext_record_upload() {
    let storage = MemoryCloudStorage::default();
    storage
        .put(".encryption-marker", b"definitely-not-json")
        .await
        .unwrap();

    let manager = manager_on(&storage, "device-b");
    let error = manager
        .enforce_encryption_policy_before_upload(false)
        .await
        .expect_err("损坏的加密标记必须按存在处理并拒绝明文上传");
    assert!(
        error.to_string().contains("加密"),
        "错误应提示加密相关原因: {error}"
    );
}

// ============================================================================
// 对照组：正常路径不受上述保护影响
// ============================================================================

/// 慢钟败方 DELETE 与正常快钟 DELETE 的对照：更新的 DELETE 正常生效且不落冲突表。
#[test]
fn r05_fresh_delete_still_applies_without_conflict_rows() {
    let conn = new_db();
    insert_record(&conn, "rec-4", "old-local", "2026-07-10T10:00:00Z");

    let fresh_delete = delete_change("rec-4", "2026-07-10T12:00:00Z", "device-fast", 4);
    let (result, conflict) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[fresh_delete],
        None,
        ConflictPolicy::KeepLatest,
        Some("device-fast"),
        Some("device-local"),
    )
    .unwrap();

    assert_eq!(result.success_count, 1, "较新的 DELETE 应正常生效");
    assert_eq!(record_count(&conn, "rec-4"), 0, "记录应被删除");
    assert!(conflict.is_clean(), "非冲突路径不应产生冲突记录");

    let conflict_rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __sync_conflicts WHERE record_id='rec-4'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    assert_eq!(conflict_rows, 0, "胜方 DELETE 不应留下冲突记录");
}
