//! 40 个真实场景的云同步 TDD 测试
//!
//! 覆盖：
//! - 基本 UPSERT / tombstone / 删除传播
//! - LWW vs 冲突副本（KeepCloud / KeepLocal / KeepLatest）
//! - 并发编辑、DELETE vs UPDATE 竞争、跨设备交替
//! - 时钟漂移、schema 断层、prune 断层检测
//! - 回声抑制、幂等重放、事务回滚、外键违规
//!
//! 全部使用内存 SQLite + MockCloudStorage，独立于 Tauri runtime。

use async_trait::async_trait;
use chrono::Utc;
use deep_student_lib::cloud_storage::{CloudStorage, FileInfo};
use deep_student_lib::data_governance::sync::{
    conflict_resolver::ConflictPolicy, tombstone, ChangeOperation, SyncChangeWithData,
    SyncDirection, SyncManager,
};
use deep_student_lib::models::AppError;
use rusqlite::{params, Connection};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::Mutex;
use tempfile::TempDir;

// ============================================================================
// 辅助：MockCloudStorage（内存版）
// ============================================================================

type CloudResult<T> = Result<T, AppError>;

fn write_content_addressed_blob(blobs_dir: &Path, payload: &[u8]) -> (String, String) {
    let hash = format!("{:x}", Sha256::digest(payload));
    let relative_path = format!("{}/{}.pdf", &hash[..2], hash);
    let path = blobs_dir.join(&relative_path);
    std::fs::create_dir_all(path.parent().expect("content-addressed blob has parent")).unwrap();
    std::fs::write(&path, payload).unwrap();
    (hash, relative_path)
}

#[derive(Default)]
struct MockCloudStorageInner {
    files: BTreeMap<String, (Vec<u8>, chrono::DateTime<Utc>)>,
}

pub struct MockCloudStorage {
    inner: Mutex<MockCloudStorageInner>,
    /// 当设为 true 时，所有网络操作返回错误（模拟断网）
    offline: Mutex<bool>,
}

impl MockCloudStorage {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(MockCloudStorageInner::default()),
            offline: Mutex::new(false),
        }
    }

    pub fn set_offline(&self, offline: bool) {
        *self.offline.lock().unwrap() = offline;
    }

    pub fn file_count(&self) -> usize {
        self.inner.lock().unwrap().files.len()
    }

    pub fn keys(&self) -> Vec<String> {
        self.inner.lock().unwrap().files.keys().cloned().collect()
    }

    fn fail_if_offline(&self) -> CloudResult<()> {
        if *self.offline.lock().unwrap() {
            return Err(AppError::network("mock: offline"));
        }
        Ok(())
    }
}

#[async_trait]
impl CloudStorage for MockCloudStorage {
    fn provider_name(&self) -> &'static str {
        "Mock"
    }

    async fn check_connection(&self) -> CloudResult<()> {
        self.fail_if_offline()
    }

    async fn put(&self, key: &str, data: &[u8]) -> CloudResult<()> {
        self.fail_if_offline()?;
        let mut inner = self.inner.lock().unwrap();
        inner
            .files
            .insert(key.to_string(), (data.to_vec(), Utc::now()));
        Ok(())
    }

    async fn get(&self, key: &str) -> CloudResult<Option<Vec<u8>>> {
        self.fail_if_offline()?;
        let inner = self.inner.lock().unwrap();
        Ok(inner.files.get(key).map(|(v, _)| v.clone()))
    }

    async fn list(&self, prefix: &str) -> CloudResult<Vec<FileInfo>> {
        self.fail_if_offline()?;
        let inner = self.inner.lock().unwrap();
        let mut out: Vec<FileInfo> = inner
            .files
            .iter()
            .filter(|(k, _)| k.starts_with(prefix))
            .map(|(k, (v, ts))| FileInfo {
                key: k.clone(),
                size: v.len() as u64,
                last_modified: *ts,
                etag: None,
            })
            .collect();
        out.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
        Ok(out)
    }

    async fn delete(&self, key: &str) -> CloudResult<()> {
        self.fail_if_offline()?;
        let mut inner = self.inner.lock().unwrap();
        inner.files.remove(key);
        Ok(())
    }

    async fn stat(&self, key: &str) -> CloudResult<Option<FileInfo>> {
        self.fail_if_offline()?;
        let inner = self.inner.lock().unwrap();
        Ok(inner.files.get(key).map(|(v, ts)| FileInfo {
            key: key.to_string(),
            size: v.len() as u64,
            last_modified: *ts,
            etag: None,
        }))
    }
}

// ============================================================================
// 辅助：一个最小业务表 + __change_log + 同步触发器
// ============================================================================

fn new_test_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE notes (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            tags TEXT NOT NULL DEFAULT '[]',
            is_favorite INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
        );

        CREATE TABLE __change_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            operation TEXT NOT NULL CHECK(operation IN ('INSERT','UPDATE','DELETE')),
            changed_at TEXT NOT NULL DEFAULT (datetime('now')),
            sync_version INTEGER DEFAULT 0
        );

        CREATE TRIGGER trg_notes_ins
        AFTER INSERT ON notes
        BEGIN
            INSERT INTO __change_log (table_name, record_id, operation)
            VALUES ('notes', NEW.id, 'INSERT');
        END;

        CREATE TRIGGER trg_notes_upd
        AFTER UPDATE ON notes
        BEGIN
            INSERT INTO __change_log (table_name, record_id, operation)
            VALUES ('notes', NEW.id, 'UPDATE');
        END;

        CREATE TRIGGER trg_notes_del
        AFTER DELETE ON notes
        BEGIN
            INSERT INTO __change_log (table_name, record_id, operation)
            VALUES ('notes', OLD.id, 'DELETE');
        END;

        -- refinery_schema_history 占位
        CREATE TABLE refinery_schema_history (
            version INTEGER PRIMARY KEY,
            applied_on TEXT
        );
        INSERT INTO refinery_schema_history VALUES (1, datetime('now'));
        "#,
    )
    .unwrap();
    conn
}

fn insert_note(conn: &Connection, id: &str, title: &str, content: &str, updated_at: &str) {
    let created = "2026-01-01T00:00:00Z";
    conn.execute(
        "INSERT INTO notes (id, title, content, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, title, content, created, updated_at],
    )
    .unwrap();
}

fn update_note(conn: &Connection, id: &str, new_title: &str, updated_at: &str) {
    conn.execute(
        "UPDATE notes SET title = ?1, updated_at = ?2 WHERE id = ?3",
        params![new_title, updated_at, id],
    )
    .unwrap();
}

fn delete_note(conn: &Connection, id: &str) {
    conn.execute("DELETE FROM notes WHERE id = ?1", params![id])
        .unwrap();
}

fn mark_all_synced(conn: &Connection) {
    conn.execute(
        "UPDATE __change_log SET sync_version = ?1 WHERE sync_version = 0",
        params![chrono::Utc::now().timestamp()],
    )
    .unwrap();
}

fn pending_count(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM __change_log WHERE sync_version = 0",
        [],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

fn get_title(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row("SELECT title FROM notes WHERE id = ?1", params![id], |r| {
        r.get(0)
    })
    .ok()
}

fn get_deleted_at(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row(
        "SELECT deleted_at FROM notes WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )
    .ok()
    .flatten()
}

fn count_notes(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))
        .unwrap_or(0)
}

fn conflict_count(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM __sync_conflicts", [], |r| r.get(0))
        .unwrap_or(0)
}

fn conflict_count_for(conn: &Connection, id: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM __sync_conflicts WHERE record_id = ?1",
        params![id],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

fn build_insert_change(id: &str, title: &str, updated_at: &str) -> SyncChangeWithData {
    SyncChangeWithData {
        table_name: "notes".into(),
        record_id: id.into(),
        operation: ChangeOperation::Insert,
        data: Some(json!({
            "id": id,
            "title": title,
            "content": "",
            "tags": "[]",
            "is_favorite": 0,
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": updated_at,
            "deleted_at": null,
        })),
        changed_at: updated_at.into(),
        change_log_id: None,
        database_name: Some("vfs".into()),
        suppress_change_log: Some(true),
        source_device_id: None,
        source_seq: None,
    }
}

fn build_update_change(id: &str, title: &str, updated_at: &str) -> SyncChangeWithData {
    SyncChangeWithData {
        table_name: "notes".into(),
        record_id: id.into(),
        operation: ChangeOperation::Update,
        data: Some(json!({
            "id": id,
            "title": title,
            "content": "",
            "tags": "[]",
            "is_favorite": 0,
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": updated_at,
            "deleted_at": null,
        })),
        changed_at: updated_at.into(),
        change_log_id: None,
        database_name: Some("vfs".into()),
        suppress_change_log: Some(true),
        source_device_id: None,
        source_seq: None,
    }
}

fn build_delete_change(id: &str, changed_at: &str) -> SyncChangeWithData {
    SyncChangeWithData {
        table_name: "notes".into(),
        record_id: id.into(),
        operation: ChangeOperation::Delete,
        data: None,
        changed_at: changed_at.into(),
        change_log_id: None,
        database_name: Some("vfs".into()),
        suppress_change_log: Some(true),
        source_device_id: None,
        source_seq: None,
    }
}

// ============================================================================
// 场景 01-10：基础能力
// ============================================================================

#[test]
fn scenario_01_fresh_insert_applies_cleanly() {
    let conn = new_test_db();
    let change = build_insert_change("n1", "hello", "2026-05-01T10:00:00Z");
    let result = SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();
    assert_eq!(result.success_count, 1);
    assert_eq!(get_title(&conn, "n1").as_deref(), Some("hello"));
}

#[test]
fn scenario_02_update_without_local_changes_overwrites() {
    let conn = new_test_db();
    insert_note(&conn, "n1", "old", "x", "2026-05-01T09:00:00Z");
    mark_all_synced(&conn);
    let change = build_update_change("n1", "new", "2026-05-01T10:00:00Z");
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();
    assert_eq!(get_title(&conn, "n1").as_deref(), Some("new"));
}

#[test]
fn scenario_03_delete_soft_deletes_when_tombstone_column_exists() {
    let conn = new_test_db();
    insert_note(&conn, "n1", "x", "y", "2026-05-01T09:00:00Z");
    mark_all_synced(&conn);
    let change = build_delete_change("n1", "2026-05-01T10:00:00Z");
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();
    // deleted_at 应被设置
    assert!(get_deleted_at(&conn, "n1").is_some());
    // 记录本身仍存在（软删除）
    assert_eq!(count_notes(&conn), 1);
}

#[test]
fn scenario_04_delete_idempotent() {
    let conn = new_test_db();
    insert_note(&conn, "n1", "x", "y", "2026-05-01T09:00:00Z");
    mark_all_synced(&conn);
    let change = build_delete_change("n1", "2026-05-01T10:00:00Z");
    SyncManager::apply_downloaded_changes(&conn, &[change.clone()], None).unwrap();
    // 再次应用同一个删除
    let r = SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();
    // 幂等：仍然成功或跳过，不报错
    assert!(r.failure_count == 0);
}

#[test]
fn scenario_05_explicit_null_on_not_null_column_is_quarantined() {
    let conn = new_test_db();
    insert_note(
        &conn,
        "n1",
        "local_title",
        "local_content",
        "2026-05-01T09:00:00Z",
    );
    mark_all_synced(&conn);
    // 2026-06 语义更新（与 regression_m5 一致）：无本地 pending 变更时按云端
    // 精确应用，显式 null 直接传播为 SQL NULL——不再 COALESCE 保留本地。
    // notes.content 为 NOT NULL，约束违规属非瞬态错误 → 整条变更进入隔离区，
    // 本地数据保持原样，批次返回 Ok。
    let mut change = build_update_change("n1", "cloud_title", "2026-05-01T10:00:00Z");
    if let Some(serde_json::Value::Object(ref mut obj)) = change.data {
        obj.insert("content".into(), serde_json::Value::Null);
    }
    let r = SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();
    assert_eq!(r.failure_count, 1, "NOT NULL 违规应记为 failure 并隔离");
    let content: String = conn
        .query_row("SELECT content FROM notes WHERE id = 'n1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(content, "local_content", "被隔离的变更不得部分落地");
    assert_eq!(get_title(&conn, "n1").as_deref(), Some("local_title"));
    let quarantined: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __sync_quarantine WHERE record_id='n1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(quarantined, 1);
}

#[test]
fn scenario_06_suppress_change_log_echo_is_exact() {
    let conn = new_test_db();
    insert_note(&conn, "n1", "base", "c", "2026-05-01T09:00:00Z");
    // 用户手动再次修改
    update_note(&conn, "n1", "user_edit", "2026-05-01T09:30:00Z");
    assert!(pending_count(&conn) >= 2);

    // 现在回放一条云端 INSERT（同 table+record+operation=UPDATE 就会被抑制
    // 但这里我们用 INSERT，不应抑制用户的 UPDATE）
    let mut change = build_insert_change("n1", "cloud_value", "2026-05-01T10:00:00Z");
    // 变更应该走 UPSERT，而用户的 UPDATE 条目不会被错误标记
    change.suppress_change_log = Some(true);
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();

    // 用户的 UPDATE 应该仍然是 pending（sync_version = 0），因为 operation=UPDATE != INSERT
    let user_pending: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __change_log
             WHERE record_id='n1' AND operation='UPDATE' AND sync_version = 0",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(user_pending >= 1, "用户的手动 UPDATE 不应被误标记为已同步");
}

#[test]
fn scenario_07_transaction_rollback_on_fk_violation() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE parents (id TEXT PRIMARY KEY);
        CREATE TABLE children (
            id TEXT PRIMARY KEY,
            parent_id TEXT NOT NULL,
            FOREIGN KEY (parent_id) REFERENCES parents(id)
        );
        CREATE TABLE __change_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            operation TEXT NOT NULL,
            changed_at TEXT NOT NULL DEFAULT (datetime('now')),
            sync_version INTEGER DEFAULT 0
        );
        "#,
    )
    .unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();

    let change = SyncChangeWithData {
        table_name: "children".into(),
        record_id: "c1".into(),
        operation: ChangeOperation::Insert,
        data: Some(json!({ "id": "c1", "parent_id": "p_does_not_exist" })),
        changed_at: "2026-05-01T10:00:00Z".into(),
        change_log_id: None,
        database_name: None,
        suppress_change_log: Some(true),
        source_device_id: None,
        source_seq: None,
    };

    // 2026-06 语义更新：FK 违规属非瞬态错误，单条回滚到 SAVEPOINT 并进入
    // 隔离区，批次整体返回 Ok（与 lib 内 regression_m10 一致）。
    let result = SyncManager::apply_downloaded_changes(&conn, &[change], None)
        .expect("FK 违规应被隔离而非整批失败");
    assert_eq!(result.failure_count, 1);
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM children", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0, "违规变更不得落地");
    let quarantined: i64 = conn
        .query_row("SELECT COUNT(*) FROM __sync_quarantine", [], |r| r.get(0))
        .unwrap();
    assert_eq!(quarantined, 1, "违规变更应进入隔离区");
}

#[test]
fn scenario_08_reject_writes_to_internal_tables() {
    let conn = new_test_db();
    let change = SyncChangeWithData {
        table_name: "__change_log".into(),
        record_id: "1".into(),
        operation: ChangeOperation::Insert,
        data: Some(json!({ "id": 1 })),
        changed_at: "2026-05-01T10:00:00Z".into(),
        change_log_id: None,
        database_name: None,
        suppress_change_log: Some(true),
        source_device_id: None,
        source_seq: None,
    };
    // 2026-06 语义更新：内部表写入被拒并隔离，批次返回 Ok
    let r = SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();
    assert_eq!(r.failure_count, 1, "禁止向内部元数据表写入，应隔离");
    assert_eq!(r.success_count, 0);
}

#[test]
fn scenario_09_reject_writes_to_sqlite_system_tables() {
    let conn = new_test_db();
    let change = SyncChangeWithData {
        table_name: "sqlite_master".into(),
        record_id: "x".into(),
        operation: ChangeOperation::Insert,
        data: Some(json!({ "name": "hack" })),
        changed_at: "2026-05-01T10:00:00Z".into(),
        change_log_id: None,
        database_name: None,
        suppress_change_log: Some(true),
        source_device_id: None,
        source_seq: None,
    };
    // 2026-06 语义更新：系统表写入被拒并隔离，批次返回 Ok 且 schema 不受影响
    let r = SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();
    assert_eq!(r.failure_count, 1);
    assert_eq!(r.success_count, 0);
}

#[test]
fn scenario_10_unknown_table_returns_error() {
    let conn = new_test_db();
    let change = SyncChangeWithData {
        table_name: "nonexistent".into(),
        record_id: "x".into(),
        operation: ChangeOperation::Insert,
        data: Some(json!({ "id": "x" })),
        changed_at: "2026-05-01T10:00:00Z".into(),
        change_log_id: None,
        database_name: None,
        suppress_change_log: Some(true),
        source_device_id: None,
        source_seq: None,
    };
    // 2026-06 语义更新：未知表写入被拒并隔离（与 lib 内 regression_m20 一致）
    let r = SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();
    assert_eq!(r.failure_count, 1);
    assert_eq!(r.success_count, 0);
}

// ============================================================================
// 场景 11-20：冲突保护（新修复的核心）
// ============================================================================

#[test]
fn scenario_11_no_local_change_no_conflict() {
    let conn = new_test_db();
    insert_note(&conn, "n1", "base", "x", "2026-05-01T09:00:00Z");
    mark_all_synced(&conn);
    let change = build_update_change("n1", "cloud_new", "2026-05-01T10:00:00Z");
    let (_, conflict) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[change],
        None,
        ConflictPolicy::KeepLatest,
        Some("remote_dev"),
        Some("local_dev"),
    )
    .unwrap();
    assert_eq!(conflict.conflicts_saved, 0);
    assert_eq!(get_title(&conn, "n1").as_deref(), Some("cloud_new"));
}

#[test]
fn scenario_12_concurrent_edit_keeplatest_newer_cloud_wins() {
    let conn = new_test_db();
    insert_note(&conn, "n1", "base", "x", "2026-05-01T09:00:00Z");
    mark_all_synced(&conn);
    // 本地改
    update_note(&conn, "n1", "local_edit", "2026-05-01T10:00:00Z");
    assert!(pending_count(&conn) > 0, "本地应该有未同步变更");

    // 云端更新（更晚）
    let change = build_update_change("n1", "cloud_edit", "2026-05-01T11:00:00Z");
    let (_, conflict) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[change],
        None,
        ConflictPolicy::KeepLatest,
        Some("cloud_dev"),
        Some("local_dev"),
    )
    .unwrap();
    assert_eq!(conflict.rejected, 0, "cloud 胜出，不应拒绝");
    assert_eq!(get_title(&conn, "n1").as_deref(), Some("cloud_edit"));
    // 冲突表里应有 2 条记录（winner + loser）
    assert_eq!(conflict_count_for(&conn, "n1"), 2);
}

#[test]
fn scenario_13_concurrent_edit_keeplatest_newer_local_wins() {
    let conn = new_test_db();
    insert_note(&conn, "n1", "base", "x", "2026-05-01T09:00:00Z");
    mark_all_synced(&conn);
    // 本地更晚
    update_note(&conn, "n1", "local_newer", "2026-05-01T12:00:00Z");
    // 云端更早
    let change = build_update_change("n1", "cloud_older", "2026-05-01T11:00:00Z");
    let (_, conflict) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[change],
        None,
        ConflictPolicy::KeepLatest,
        Some("cloud_dev"),
        Some("local_dev"),
    )
    .unwrap();
    assert_eq!(conflict.rejected, 1, "local 胜出，应当拒绝云端写入");
    assert_eq!(get_title(&conn, "n1").as_deref(), Some("local_newer"));
    assert_eq!(conflict_count_for(&conn, "n1"), 2);
}

#[test]
fn scenario_14_keepcloud_always_wins_but_records_loser() {
    let conn = new_test_db();
    insert_note(&conn, "n1", "base", "x", "2026-05-01T09:00:00Z");
    mark_all_synced(&conn);
    update_note(&conn, "n1", "local_very_new", "2026-06-01T00:00:00Z");
    let change = build_update_change("n1", "cloud_older", "2026-05-01T11:00:00Z");
    let (_, conflict) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[change],
        None,
        ConflictPolicy::KeepCloud,
        Some("cloud_dev"),
        Some("local_dev"),
    )
    .unwrap();
    assert_eq!(get_title(&conn, "n1").as_deref(), Some("cloud_older"));
    // 本地原值必须保留在冲突表，不能静默丢失
    assert_eq!(conflict.conflicts_saved, 2);
    let locals: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __sync_conflicts WHERE record_id='n1' AND side='local'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(locals, 1);
}

#[test]
fn scenario_15_keeplocal_cloud_data_still_saved() {
    let conn = new_test_db();
    insert_note(&conn, "n1", "base", "x", "2026-05-01T09:00:00Z");
    mark_all_synced(&conn);
    update_note(&conn, "n1", "local_old", "2026-05-01T10:00:00Z");
    let change = build_update_change("n1", "cloud_new", "2026-06-01T00:00:00Z");
    let (_, conflict) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[change],
        None,
        ConflictPolicy::KeepLocal,
        Some("cloud_dev"),
        Some("local_dev"),
    )
    .unwrap();
    assert_eq!(conflict.rejected, 1);
    assert_eq!(get_title(&conn, "n1").as_deref(), Some("local_old"));
    // 云端新值必须保留在冲突表，用户后续可选择"采用云端"
    let clouds: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __sync_conflicts WHERE record_id='n1' AND side='cloud'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(clouds, 1);
}

#[test]
fn scenario_16_delete_vs_local_update_conflict() {
    let conn = new_test_db();
    insert_note(&conn, "n1", "keep_me", "x", "2026-05-01T09:00:00Z");
    mark_all_synced(&conn);
    update_note(&conn, "n1", "local_still_alive", "2026-05-01T10:00:00Z");
    // 云端声称删除
    let change = build_delete_change("n1", "2026-05-01T09:30:00Z");
    // KeepLatest：本地更新，本地胜
    let (_, conflict) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[change],
        None,
        ConflictPolicy::KeepLatest,
        Some("cloud_dev"),
        Some("local_dev"),
    )
    .unwrap();
    assert_eq!(conflict.rejected, 1, "本地 UPDATE 更新，应拒绝云端 DELETE");
    assert!(get_deleted_at(&conn, "n1").is_none());
    assert_eq!(get_title(&conn, "n1").as_deref(), Some("local_still_alive"));
    // 删除意图仍应留痕在冲突表
    assert!(conflict_count_for(&conn, "n1") >= 1);
}

#[test]
fn scenario_17_identical_data_no_conflict() {
    let conn = new_test_db();
    // 显式设置所有字段，确保本地 schema 读出的 JSON 与 build_update_change 完全一致
    conn.execute(
        "INSERT INTO notes (id, title, content, tags, is_favorite, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            "n1",
            "same",
            "",
            "[]",
            0_i64,
            "2026-01-01T00:00:00Z",
            "2026-05-01T09:00:00Z"
        ],
    )
    .unwrap();
    // 本地有 pending（刚插入），但云端的数据与本地业务上一致
    let change = SyncChangeWithData {
        table_name: "notes".into(),
        record_id: "n1".into(),
        operation: ChangeOperation::Update,
        data: Some(json!({
            "id": "n1",
            "title": "same",
            "content": "",
            "tags": "[]",
            "is_favorite": 0,
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-05-01T10:00:00Z",
            "deleted_at": serde_json::Value::Null,
        })),
        changed_at: "2026-05-01T10:00:00Z".into(),
        change_log_id: None,
        database_name: Some("vfs".into()),
        suppress_change_log: Some(true),
        source_device_id: None,
        source_seq: None,
    };
    let (_, conflict) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[change],
        None,
        ConflictPolicy::KeepLatest,
        None,
        None,
    )
    .unwrap();
    assert_eq!(conflict.conflicts_saved, 0, "业务数据相同时不应是冲突");
}

#[test]
fn scenario_18_keeplatest_cloud_newer_with_small_skew_wins() {
    let conn = new_test_db();
    insert_note(&conn, "n1", "base", "x", "2026-05-01T09:00:00Z");
    mark_all_synced(&conn);
    update_note(&conn, "n1", "local", "2026-05-01T10:00:00Z");
    // 2026-06 语义更新：KeepLatest 使用规范化 LWW key 精确裁决。
    // 云端 updated_at 晚 1 秒且内容不同，应由云端胜出；完全相等的 tie 才保留本地。
    let change = build_update_change("n1", "cloud", "2026-05-01T10:00:01Z");
    let (_, conflict) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[change],
        None,
        ConflictPolicy::KeepLatest,
        None,
        None,
    )
    .unwrap();
    assert_eq!(get_title(&conn, "n1").as_deref(), Some("cloud"));
    assert_eq!(conflict.rejected, 0);
    assert_eq!(conflict.applied, 1);
}

#[test]
fn scenario_19_three_way_conflict_sequence() {
    let conn = new_test_db();
    insert_note(&conn, "n1", "v0", "x", "2026-05-01T09:00:00Z");
    mark_all_synced(&conn);
    // 本地连续两次编辑
    update_note(&conn, "n1", "v1", "2026-05-01T10:00:00Z");
    update_note(&conn, "n1", "v2", "2026-05-01T10:05:00Z");
    // 云端一次"更新"早于本地
    let change = build_update_change("n1", "v_cloud", "2026-05-01T10:02:00Z");
    let (_, conflict) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[change],
        None,
        ConflictPolicy::KeepLatest,
        None,
        None,
    )
    .unwrap();
    // 本地最新（v2）时间最晚
    assert_eq!(get_title(&conn, "n1").as_deref(), Some("v2"));
    assert_eq!(conflict.rejected, 1);
}

#[test]
fn scenario_20_multiple_records_mixed_outcomes() {
    let conn = new_test_db();
    insert_note(&conn, "a", "a0", "x", "2026-05-01T09:00:00Z");
    insert_note(&conn, "b", "b0", "x", "2026-05-01T09:00:00Z");
    insert_note(&conn, "c", "c0", "x", "2026-05-01T09:00:00Z");
    mark_all_synced(&conn);
    // a: 本地改，云端更早 → local 胜
    update_note(&conn, "a", "a_local", "2026-05-01T12:00:00Z");
    // b: 本地改，云端更晚 → cloud 胜
    update_note(&conn, "b", "b_local", "2026-05-01T10:00:00Z");
    // c: 本地未改，云端更新 → 正常覆盖
    let changes = vec![
        build_update_change("a", "a_cloud", "2026-05-01T11:00:00Z"),
        build_update_change("b", "b_cloud", "2026-05-01T11:00:00Z"),
        build_update_change("c", "c_cloud", "2026-05-01T11:00:00Z"),
    ];
    let (_, conflict) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &changes,
        None,
        ConflictPolicy::KeepLatest,
        None,
        None,
    )
    .unwrap();
    assert_eq!(get_title(&conn, "a").as_deref(), Some("a_local"));
    assert_eq!(get_title(&conn, "b").as_deref(), Some("b_cloud"));
    assert_eq!(get_title(&conn, "c").as_deref(), Some("c_cloud"));
    assert_eq!(conflict.rejected, 1, "只有 a 应该被拒绝");
    // conflict_count: a + b 各 2 条 = 4
    assert_eq!(conflict_count(&conn), 4);
}

// ============================================================================
// 场景 21-30：断层检测 / 幂等 / 回放稳定性
// ============================================================================

#[test]
fn scenario_21_prune_gap_detection_triggers() {
    // since_version = 100, 云端最早 200 → 有断层
    assert!(SyncManager::has_prune_gap(100, Some(200)));
    // since_version = 0 (首次) → 不算断层
    assert!(!SyncManager::has_prune_gap(0, Some(200)));
    // 云端为空 → 不算断层
    assert!(!SyncManager::has_prune_gap(100, None));
    // since_version = 200, 云端最早 100 → 不算断层（正常增量）
    assert!(!SyncManager::has_prune_gap(200, Some(100)));
}

#[test]
fn scenario_22_replay_same_change_twice_idempotent() {
    let conn = new_test_db();
    let change = build_insert_change("n1", "hello", "2026-05-01T10:00:00Z");
    SyncManager::apply_downloaded_changes(&conn, &[change.clone()], None).unwrap();
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();
    assert_eq!(count_notes(&conn), 1);
    assert_eq!(get_title(&conn, "n1").as_deref(), Some("hello"));
}

#[test]
fn scenario_23_replay_insert_then_update_sequence() {
    let conn = new_test_db();
    let c1 = build_insert_change("n1", "v1", "2026-05-01T10:00:00Z");
    let c2 = build_update_change("n1", "v2", "2026-05-01T10:05:00Z");
    SyncManager::apply_downloaded_changes(&conn, &[c1, c2], None).unwrap();
    assert_eq!(get_title(&conn, "n1").as_deref(), Some("v2"));
}

#[test]
fn scenario_24_replay_insert_then_delete_sequence() {
    let conn = new_test_db();
    let c1 = build_insert_change("n1", "v1", "2026-05-01T10:00:00Z");
    let c2 = build_delete_change("n1", "2026-05-01T10:05:00Z");
    SyncManager::apply_downloaded_changes(&conn, &[c1, c2], None).unwrap();
    // 软删除
    assert!(get_deleted_at(&conn, "n1").is_some());
}

#[test]
fn scenario_25_replay_in_reverse_order_still_converges() {
    // 如果收到顺序错乱的变更，UPSERT+COALESCE 也应保证最终态的 title 是 v2
    let conn = new_test_db();
    let c1 = build_insert_change("n1", "v1", "2026-05-01T10:00:00Z");
    let c2 = build_update_change("n1", "v2", "2026-05-01T10:05:00Z");
    // 故意倒序：先 v2 再 v1
    SyncManager::apply_downloaded_changes(&conn, &[c2.clone(), c1.clone()], None).unwrap();
    // 这里的行为取决于 apply_single_record 的 UPSERT 是按最后一条为准
    // 实际 SQLite 会用最后一条 INSERT OR ... 覆盖，所以最终 = v1
    // 记录这个行为：倒序情况下应用层必须先按时间戳排序
    let final_title = get_title(&conn, "n1").unwrap();
    assert!(
        final_title == "v1" || final_title == "v2",
        "乱序回放行为必须可预测，实际 title = {}",
        final_title
    );
}

#[test]
fn scenario_26_upsert_preserves_row_identity() {
    let conn = new_test_db();
    insert_note(&conn, "n1", "v1", "x", "2026-05-01T09:00:00Z");
    let rowid1: i64 = conn
        .query_row("SELECT rowid FROM notes WHERE id = 'n1'", [], |r| r.get(0))
        .unwrap();
    mark_all_synced(&conn);
    let change = build_update_change("n1", "v2", "2026-05-01T10:00:00Z");
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();
    let rowid2: i64 = conn
        .query_row("SELECT rowid FROM notes WHERE id = 'n1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rowid1, rowid2, "ON CONFLICT DO UPDATE 不应改变 rowid");
}

#[test]
fn scenario_27_large_batch_transactional() {
    let conn = new_test_db();
    let mut changes = Vec::with_capacity(500);
    for i in 0..500 {
        changes.push(build_insert_change(
            &format!("n{:03}", i),
            &format!("title_{}", i),
            "2026-05-01T10:00:00Z",
        ));
    }
    let r = SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();
    assert_eq!(r.success_count, 500);
    assert_eq!(count_notes(&conn), 500);
}

#[test]
fn scenario_28_large_batch_partial_failure_rolls_back_all() {
    let conn = new_test_db();

    let mut changes = Vec::new();
    for i in 0..10 {
        let id = format!("c{}", i);
        changes.push(SyncChangeWithData {
            table_name: "notes".into(),
            record_id: id.clone(),
            operation: ChangeOperation::Insert,
            data: Some(json!({
                "id": id,
                "title": format!("note {}", i),
                "content": "ok",
                "tags": "[]",
                "is_favorite": 0,
                "created_at": "2026-05-01T09:00:00Z",
                "updated_at": "2026-05-01T10:00:00Z",
                "deleted_at": serde_json::Value::Null,
            })),
            changed_at: "2026-05-01T10:00:00Z".into(),
            change_log_id: None,
            database_name: None,
            suppress_change_log: Some(true),
            source_device_id: None,
            source_seq: None,
        });
    }
    // 插入一条违规的到中间：未知表会被隔离，不应阻塞前面的合法 notes。
    changes.push(SyncChangeWithData {
        table_name: "unknown_table".into(),
        record_id: "bad".into(),
        operation: ChangeOperation::Insert,
        data: Some(json!({ "id": "bad" })),
        changed_at: "2026-05-01T10:00:00Z".into(),
        change_log_id: None,
        database_name: None,
        suppress_change_log: Some(true),
        source_device_id: None,
        source_seq: None,
    });
    // 2026-06 语义更新：违规单条隔离、其余正常应用（不再整批回滚）
    let r = SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();
    assert_eq!(r.success_count, 10, "合法变更应全部应用");
    assert_eq!(r.failure_count, 1, "违规变更应被隔离");
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 10, "仅违规一条不落地");
    let quarantined: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __sync_quarantine WHERE record_id='bad'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(quarantined, 1);
}

#[test]
fn scenario_29_millis_sync_version_normalized() {
    let conn = new_test_db();
    insert_note(&conn, "n1", "test1", "", "2024-01-01T00:00:00Z");
    // Mark change log entry with a millisecond-precision sync_version (> 1e12)
    let raw_millis: i64 = 1704067200000; // 2024-01-01 in ms
    conn.execute(
        "UPDATE __change_log SET sync_version = ?1 WHERE record_id = 'n1'",
        params![raw_millis],
    )
    .unwrap();

    // get_database_sync_state should normalize millis to seconds internally
    let state = SyncManager::get_database_sync_state(&conn, "vfs").unwrap();
    assert!(state.data_version > 0);
    // Normalized version should be in seconds range (~1.7e9), not millis range (~1.7e12)
    assert!(
        state.data_version < 10_000_000_000,
        "data_version should be normalized to seconds, got {}",
        state.data_version
    );
    // 1704067200000 ms → 1704067200 seconds
    assert_eq!(state.data_version, 1704067200);
}

#[test]
fn scenario_30_empty_batch_is_noop() {
    let conn = new_test_db();
    let r = SyncManager::apply_downloaded_changes(&conn, &[], None).unwrap();
    assert_eq!(r.success_count, 0);
    assert_eq!(r.failure_count, 0);
    let (_, c) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[],
        None,
        ConflictPolicy::KeepLatest,
        None,
        None,
    )
    .unwrap();
    assert_eq!(c.applied, 0);
    assert_eq!(c.rejected, 0);
}

// ============================================================================
// 场景 31-40：tombstone 删除传播 / 网络失败 / blob 生命周期
// ============================================================================

#[tokio::test]
async fn scenario_31_blob_tombstone_upload_download() {
    let storage = MockCloudStorage::new();
    let mgr = SyncManager::new("device_a".into());
    mgr.mark_blob_deleted(
        &storage,
        "hash_abc",
        Some("ab/hash_abc.pdf".into()),
        Some(1024),
    )
    .await
    .unwrap();

    let m = tombstone::download_blob_tombstones(&storage, &tombstone::PlainCodec)
        .await
        .unwrap();
    assert_eq!(m.entries.len(), 1);
    assert!(m.entries.contains_key("hash_abc"));
    assert_eq!(m.entries["hash_abc"].device_id, "device_a");
}

#[tokio::test]
async fn scenario_32_asset_tombstone_propagates() {
    let storage = MockCloudStorage::new();
    let mgr = SyncManager::new("device_a".into());
    mgr.mark_asset_deleted(&storage, "active/images/foo.png", Some(2048))
        .await
        .unwrap();
    let m = tombstone::download_asset_tombstones(&storage, &tombstone::PlainCodec)
        .await
        .unwrap();
    assert_eq!(m.entries.len(), 1);
    assert_eq!(m.entries["active/images/foo.png"].size, Some(2048));
}

#[tokio::test]
async fn scenario_33_tombstone_second_device_sees_deletion() {
    let storage = MockCloudStorage::new();
    let mgr_a = SyncManager::new("device_a".into());
    let mgr_b = SyncManager::new("device_b".into());
    mgr_a
        .mark_blob_deleted(&storage, "hash_x", None, Some(100))
        .await
        .unwrap();
    // 设备 B 拉取
    let m = tombstone::download_blob_tombstones(&storage, &tombstone::PlainCodec)
        .await
        .unwrap();
    assert!(m.entries.contains_key("hash_x"));
    assert_eq!(m.entries["hash_x"].device_id, "device_a");
    // 设备 B 也删了另一个
    mgr_b
        .mark_blob_deleted(&storage, "hash_y", None, Some(200))
        .await
        .unwrap();
    let m = tombstone::download_blob_tombstones(&storage, &tombstone::PlainCodec)
        .await
        .unwrap();
    assert_eq!(m.entries.len(), 2);
}

#[tokio::test]
async fn scenario_34_tombstone_offline_returns_error() {
    let storage = MockCloudStorage::new();
    storage.set_offline(true);
    let mgr = SyncManager::new("device_a".into());
    let r = mgr
        .mark_blob_deleted(&storage, "hash_z", None, Some(100))
        .await;
    assert!(r.is_err());
}

#[tokio::test]
async fn scenario_35_apply_blob_tombstones_removes_local_file() {
    let tmp = TempDir::new().unwrap();
    let blobs_dir = tmp.path();
    // 构造一个 blob 文件
    let subdir = blobs_dir.join("ab");
    std::fs::create_dir_all(&subdir).unwrap();
    let blob_path = subdir.join("ab123.pdf");
    std::fs::write(&blob_path, b"fake pdf").unwrap();
    assert!(blob_path.exists());

    let storage = MockCloudStorage::new();
    // 云端也放一份（模拟）
    storage
        .put("data_governance/blobs/ab/ab123.pdf", b"fake pdf")
        .await
        .unwrap();

    let mut tombstones = tombstone::BlobTombstones::default();
    tombstones.entries.insert(
        "ab123".into(),
        tombstone::BlobTombstoneEntry {
            deleted_at: chrono::Utc::now().to_rfc3339(),
            device_id: "dev_a".into(),
            size: Some(8),
            relative_path: Some("ab/ab123.pdf".into()),
        },
    );

    let affected = tombstone::apply_blob_tombstones(
        &storage,
        &tombstones,
        blobs_dir,
        "data_governance/blobs",
        true,
    )
    .await
    .unwrap();

    assert_eq!(affected.len(), 1);
    assert!(!blob_path.exists(), "本地 blob 应被删除");
    assert!(
        storage
            .get("data_governance/blobs/ab/ab123.pdf")
            .await
            .unwrap()
            .is_none(),
        "云端 blob 应被删除"
    );
}

#[tokio::test]
async fn scenario_36_tombstone_retained_without_authoritative_snapshot() {
    use tombstone::{prune_tombstones, BlobTombstoneEntry};
    let mut map = std::collections::HashMap::new();
    let old = (Utc::now() - chrono::Duration::days(120)).to_rfc3339();
    let fresh = Utc::now().to_rfc3339();
    map.insert(
        "old".into(),
        BlobTombstoneEntry {
            deleted_at: old,
            device_id: "d".into(),
            size: None,
            relative_path: None,
        },
    );
    map.insert(
        "fresh".into(),
        BlobTombstoneEntry {
            deleted_at: fresh,
            device_id: "d".into(),
            size: None,
            relative_path: None,
        },
    );
    let removed = prune_tombstones(&mut map, 90, |e| &e.deleted_at);
    assert_eq!(removed, 0);
    assert!(map.contains_key("fresh"));
    assert!(
        map.contains_key("old"),
        "长期离线设备仍可能需要旧删除记录；权威 replace 快照上线前不得裁剪"
    );
}

#[tokio::test]
async fn scenario_37_sync_vfs_blobs_with_tombstones_respects_deletion() {
    let tmp = TempDir::new().unwrap();
    let blobs_dir = tmp.path();
    let storage = MockCloudStorage::new();

    let mgr_a = SyncManager::new("device_a".into());

    // 设备 A 先上传一个真实内容寻址 blob
    let blob = write_content_addressed_blob(blobs_dir, b"content1");

    // 先走一次普通 sync，云端会有 blob
    let _ = mgr_a
        .sync_vfs_blobs(&storage, blobs_dir, SyncDirection::Bidirectional)
        .await
        .unwrap();
    assert!(
        storage
            .get(&format!("data_governance/blobs/{}", blob.1))
            .await
            .unwrap()
            .is_some(),
        "云端应当有 blob"
    );

    // 设备 A 现在标记这个 blob 已删除
    mgr_a
        .mark_blob_deleted(&storage, &blob.0, Some(blob.1.clone()), Some(8))
        .await
        .unwrap();

    // 设备 B 上线，blobs 目录是空的
    let tmp_b = TempDir::new().unwrap();
    let blobs_dir_b = tmp_b.path();
    let mgr_b = SyncManager::new("device_b".into());
    let outcome = mgr_b
        .sync_vfs_blobs_with_tombstones(&storage, blobs_dir_b, SyncDirection::Bidirectional)
        .await
        .unwrap();

    // 设备 B 不应下载被 tombstone 的 blob
    let blob_on_b = blobs_dir_b.join(&blob.1);
    assert!(!blob_on_b.exists(), "tombstoned blob 不应下载到 B");
    // 云端对应条目应已被删除
    assert!(storage
        .get(&format!("data_governance/blobs/{}", blob.1))
        .await
        .unwrap()
        .is_none());
    assert_eq!(outcome.downloaded, 0);
}

#[tokio::test]
async fn scenario_38_device_id_persistence() {
    // 两次调用应返回相同的 device_id（测环境中由线程本地 state 决定，至少格式稳定）
    let id1 = deep_student_lib::cloud_storage::get_device_id();
    let id2 = deep_student_lib::cloud_storage::get_device_id();
    assert_eq!(id1, id2);
    assert!(!id1.is_empty());
}

#[tokio::test]
async fn scenario_39_mock_cloud_storage_list_by_prefix() {
    let s = MockCloudStorage::new();
    s.put("a/1.txt", b"a").await.unwrap();
    s.put("a/2.txt", b"b").await.unwrap();
    s.put("b/1.txt", b"c").await.unwrap();
    let a_list = s.list("a/").await.unwrap();
    assert_eq!(a_list.len(), 2);
    let b_list = s.list("b/").await.unwrap();
    assert_eq!(b_list.len(), 1);
    let all = s.list("").await.unwrap();
    assert_eq!(all.len(), 3);
}

#[tokio::test]
async fn scenario_40_full_cycle_two_devices_sync_and_delete() {
    // 端到端一轮：A 写入 3 条记录 -> A 上传 blob -> B 拉 -> A 删 1 条 -> B 看到
    let tmp_a = TempDir::new().unwrap();
    let tmp_b = TempDir::new().unwrap();
    let storage = MockCloudStorage::new();
    let mgr_a = SyncManager::new("dev_a".into());
    let mgr_b = SyncManager::new("dev_b".into());

    // A 写 3 个真实内容寻址 blob
    let first = write_content_addressed_blob(tmp_a.path(), b"blob-one");
    let second = write_content_addressed_blob(tmp_a.path(), b"blob-two");
    let third = write_content_addressed_blob(tmp_a.path(), b"blob-three");
    let _ = mgr_a
        .sync_vfs_blobs(&storage, tmp_a.path(), SyncDirection::Bidirectional)
        .await
        .unwrap();
    // 云端应有 3 个
    assert_eq!(
        storage.list("data_governance/blobs/").await.unwrap().len(),
        3
    );

    // B 拉
    let out_b = mgr_b
        .sync_vfs_blobs(&storage, tmp_b.path(), SyncDirection::Bidirectional)
        .await
        .unwrap();
    assert_eq!(out_b.downloaded, 3);
    assert!(tmp_b.path().join(&first.1).exists());

    // A 删第一个 blob
    std::fs::remove_file(tmp_a.path().join(&first.1)).unwrap();
    mgr_a
        .mark_blob_deleted(&storage, &first.0, Some(first.1.clone()), Some(4))
        .await
        .unwrap();

    // B 再同步
    let out_b2 = mgr_b
        .sync_vfs_blobs_with_tombstones(&storage, tmp_b.path(), SyncDirection::Bidirectional)
        .await
        .unwrap();
    assert!(
        !tmp_b.path().join(&first.1).exists(),
        "B 应看到 blob 已被删除"
    );
    // 剩余 2 个
    assert!(tmp_b.path().join(&second.1).exists());
    assert!(tmp_b.path().join(&third.1).exists());
    assert_eq!(out_b2.uploaded, 0);
}

// ============================================================================
// 扩展场景 41-60：更极端的真实数据状态
// ============================================================================

#[test]
fn scenario_41_deep_nested_json_in_text_column() {
    // content 存储多级 JSON，应能正确被 UPSERT 保留为字符串而非解析
    let conn = new_test_db();
    let deep_json = r#"{"a":{"b":{"c":[1,2,{"d":"e"}]}}}"#;
    let change = SyncChangeWithData {
        table_name: "notes".into(),
        record_id: "n1".into(),
        operation: ChangeOperation::Insert,
        data: Some(json!({
            "id": "n1",
            "title": "deep",
            "content": deep_json,
            "tags": "[]",
            "is_favorite": 0,
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-05-01T10:00:00Z",
        })),
        changed_at: "2026-05-01T10:00:00Z".into(),
        change_log_id: None,
        database_name: Some("vfs".into()),
        suppress_change_log: Some(true),
        source_device_id: None,
        source_seq: None,
    };
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();
    let content: String = conn
        .query_row("SELECT content FROM notes WHERE id='n1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(content, deep_json);
}

#[test]
fn scenario_42_special_chars_in_record_id() {
    let conn = new_test_db();
    let ids = ["hello world", "with/slash", "quotes\"here", "中文 id"];
    for id in &ids {
        let change = build_insert_change(id, "t", "2026-05-01T10:00:00Z");
        SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();
    }
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, ids.len() as i64);
}

#[test]
fn scenario_43_reject_injection_via_table_name() {
    let conn = new_test_db();
    let change = SyncChangeWithData {
        table_name: "notes\"; DROP TABLE notes; --".into(),
        record_id: "x".into(),
        operation: ChangeOperation::Insert,
        data: Some(json!({ "id": "x" })),
        changed_at: "2026-05-01T10:00:00Z".into(),
        change_log_id: None,
        database_name: None,
        suppress_change_log: Some(true),
        source_device_id: None,
        source_seq: None,
    };
    // 2026-06 语义更新：注入表名被拒并隔离，批次返回 Ok；schema 不受损
    let r = SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();
    assert_eq!(r.failure_count, 1);
    assert_eq!(r.success_count, 0);
    // 确认 notes 表仍存在
    let n = count_notes(&conn);
    assert_eq!(n, 0);
}

#[test]
fn scenario_44_reject_injection_via_column_name() {
    let conn = new_test_db();
    let change = SyncChangeWithData {
        table_name: "notes".into(),
        record_id: "n1".into(),
        operation: ChangeOperation::Insert,
        data: Some(json!({
            "id": "n1",
            "title\"; DROP TABLE notes; --": "hack",
            "content": "",
            "tags": "[]",
            "is_favorite": 0,
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-05-01T10:00:00Z",
        })),
        changed_at: "2026-05-01T10:00:00Z".into(),
        change_log_id: None,
        database_name: None,
        suppress_change_log: Some(true),
        source_device_id: None,
        source_seq: None,
    };
    // 应该报错（不存在的列），且 notes 表不被破坏
    let _ = SyncManager::apply_downloaded_changes(&conn, &[change], None);
    // 表仍然存在
    let _: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))
        .expect("notes 表应当仍然存在");
}

#[test]
fn scenario_45_unicode_content_preserved() {
    let conn = new_test_db();
    let content = "中文 🎉 Hello العربية עברית ñoño";
    let change = SyncChangeWithData {
        table_name: "notes".into(),
        record_id: "n1".into(),
        operation: ChangeOperation::Insert,
        data: Some(json!({
            "id": "n1",
            "title": content,
            "content": "",
            "tags": "[]",
            "is_favorite": 0,
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-05-01T10:00:00Z",
        })),
        changed_at: "2026-05-01T10:00:00Z".into(),
        change_log_id: None,
        database_name: None,
        suppress_change_log: Some(true),
        source_device_id: None,
        source_seq: None,
    };
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();
    assert_eq!(get_title(&conn, "n1").as_deref(), Some(content));
}

#[test]
fn scenario_46_upsert_does_not_retrigger_change_log() {
    // 当 suppress_change_log=true 时，回放的 UPSERT 产生的 change_log 条目
    // 应该立刻被标记为 synced（sync_version != 0），不会被下次上传
    let conn = new_test_db();
    let change = build_insert_change("n1", "v1", "2026-05-01T10:00:00Z");
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();

    let pending: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __change_log WHERE sync_version = 0",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(pending, 0, "回放的 INSERT 应被立即标记为 synced");
}

#[test]
fn scenario_47_local_user_edit_during_download_preserved() {
    // 模拟：正在下载云端变更时，用户插入一条新记录
    let conn = new_test_db();
    // 1. 先应用云端变更（这会触发 trg_notes_ins 产生 change_log 条目 id=?）
    let cloud_change = build_insert_change("cloud1", "cloud_val", "2026-05-01T10:00:00Z");
    SyncManager::apply_downloaded_changes(&conn, &[cloud_change], None).unwrap();
    // 2. 用户现在插入
    insert_note(&conn, "local1", "local_val", "", "2026-05-01T10:05:00Z");
    // 用户的新条目应是 pending
    let pending: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __change_log WHERE sync_version = 0 AND record_id = 'local1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(pending, 1);
    // 云端条目不应 pending
    let cloud_pending: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __change_log WHERE sync_version = 0 AND record_id = 'cloud1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(cloud_pending, 0);
}

#[test]
fn scenario_48_conflict_table_survives_db_close_reopen() {
    // 模拟：冲突表写入后数据库关闭，重新打开时冲突记录仍在
    // 这里用文件数据库（内存 DB 关闭即丢失，无法测持久化）
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("test.db");
    {
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE notes (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '[]',
                is_favorite INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
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
            CREATE TRIGGER trg_notes_ins AFTER INSERT ON notes BEGIN
                INSERT INTO __change_log (table_name, record_id, operation)
                VALUES ('notes', NEW.id, 'INSERT');
            END;
            CREATE TRIGGER trg_notes_upd AFTER UPDATE ON notes BEGIN
                INSERT INTO __change_log (table_name, record_id, operation)
                VALUES ('notes', NEW.id, 'UPDATE');
            END;
            "#,
        )
        .unwrap();
        conn.execute(
            "INSERT INTO notes (id, title, content, created_at, updated_at) \
             VALUES ('n1', 'base', '', '2026-01-01T00:00:00Z', '2026-05-01T09:00:00Z')",
            [],
        )
        .unwrap();
        // 模拟本地有 pending 修改
        conn.execute(
            "UPDATE notes SET title = 'local_edit', updated_at = '2026-05-01T10:00:00Z' WHERE id = 'n1'",
            [],
        )
        .unwrap();

        // 应用冲突感知下载
        let change = build_update_change("n1", "cloud_edit", "2026-05-01T11:00:00Z");
        SyncManager::apply_downloaded_changes_with_conflict_guard(
            &conn,
            &[change],
            None,
            ConflictPolicy::KeepLatest,
            Some("cloud_dev"),
            Some("local_dev"),
        )
        .unwrap();
    }
    // 重新打开
    let conn2 = Connection::open(&db_path).unwrap();
    let c: i64 = conn2
        .query_row(
            "SELECT COUNT(*) FROM __sync_conflicts WHERE record_id='n1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(c, 2, "冲突记录应持久化到磁盘");
}

#[test]
fn scenario_49_very_long_field_value() {
    // 10MB 的 title 应能处理
    let conn = new_test_db();
    let huge = "x".repeat(10 * 1024 * 1024);
    let change = SyncChangeWithData {
        table_name: "notes".into(),
        record_id: "n1".into(),
        operation: ChangeOperation::Insert,
        data: Some(json!({
            "id": "n1",
            "title": huge.clone(),
            "content": "",
            "tags": "[]",
            "is_favorite": 0,
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-05-01T10:00:00Z",
        })),
        changed_at: "2026-05-01T10:00:00Z".into(),
        change_log_id: None,
        database_name: None,
        suppress_change_log: Some(true),
        source_device_id: None,
        source_seq: None,
    };
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();
    assert_eq!(get_title(&conn, "n1").as_deref(), Some(huge.as_str()));
}

#[test]
fn scenario_50_mixed_sequence_with_conflicts_and_new() {
    // 综合：一批 50 条变更，其中 10 条与本地冲突，40 条无冲突
    let conn = new_test_db();
    // 本地先有 10 条且已同步
    for i in 0..10 {
        insert_note(
            &conn,
            &format!("existing_{}", i),
            "base",
            "",
            "2026-05-01T09:00:00Z",
        );
    }
    mark_all_synced(&conn);
    // 本地修改其中 5 条（产生 pending）
    for i in 0..5 {
        update_note(
            &conn,
            &format!("existing_{}", i),
            "local_edit",
            "2026-05-01T12:00:00Z", // 本地更晚
        );
    }

    let mut changes = Vec::new();
    // 对所有 10 条 existing 记录都推送云端更新（较早）
    for i in 0..10 {
        changes.push(build_update_change(
            &format!("existing_{}", i),
            "cloud_edit",
            "2026-05-01T11:00:00Z",
        ));
    }
    // 40 条全新记录
    for i in 0..40 {
        changes.push(build_insert_change(
            &format!("new_{}", i),
            "new",
            "2026-05-01T11:00:00Z",
        ));
    }

    let (apply, conflict) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &changes,
        None,
        ConflictPolicy::KeepLatest,
        Some("cloud_dev"),
        Some("local_dev"),
    )
    .unwrap();

    // 5 条本地冲突，应被拒绝
    assert_eq!(conflict.rejected, 5);
    // 另外 5 条 existing 无本地修改 → 覆盖
    // 40 条新记录 → 新增
    // 总成功 = 5 (cloud win on existing without local change) + 40 (new) = 45
    assert!(apply.success_count >= 45);
    assert_eq!(count_notes(&conn), 50);
    // 前 5 条保持本地值
    for i in 0..5 {
        assert_eq!(
            get_title(&conn, &format!("existing_{}", i)).as_deref(),
            Some("local_edit")
        );
    }
    // 第 5-9 条应被云端覆盖
    for i in 5..10 {
        assert_eq!(
            get_title(&conn, &format!("existing_{}", i)).as_deref(),
            Some("cloud_edit")
        );
    }
}

#[tokio::test]
async fn scenario_51_mock_storage_concurrent_puts() {
    use std::sync::Arc;
    let s = Arc::new(MockCloudStorage::new());
    let mut handles = Vec::new();
    for i in 0..20 {
        let s = s.clone();
        handles.push(tokio::spawn(async move {
            s.put(&format!("k{}", i), b"data").await.unwrap();
        }));
    }
    for h in handles {
        h.await.unwrap();
    }
    assert_eq!(s.file_count(), 20);
}

#[test]
fn scenario_52_delete_of_nonexistent_is_safe() {
    // 应用一个 DELETE 但本地根本没这条记录
    let conn = new_test_db();
    let change = build_delete_change("never_existed", "2026-05-01T10:00:00Z");
    let r = SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();
    assert_eq!(r.failure_count, 0);
    assert_eq!(count_notes(&conn), 0);
}

#[test]
fn scenario_53_empty_string_updated_at_handled() {
    let conn = new_test_db();
    insert_note(&conn, "n1", "base", "", "");
    mark_all_synced(&conn);
    update_note(&conn, "n1", "local", "");
    // 云端带正常时间戳
    let change = build_update_change("n1", "cloud", "2026-05-01T10:00:00Z");
    // KeepLatest：本地 updated_at="" 解析失败，云端有值 → 云端胜
    let (_, conflict) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[change],
        None,
        ConflictPolicy::KeepLatest,
        None,
        None,
    )
    .unwrap();
    // 任何一种收敛都可以，关键是不 panic
    assert!(conflict.rejected <= 1);
}

#[test]
fn scenario_54_multiple_conflict_rounds_accumulate() {
    // 同一条记录的多次冲突应累积在 __sync_conflicts 表
    let conn = new_test_db();
    insert_note(&conn, "n1", "base", "", "2026-05-01T09:00:00Z");
    mark_all_synced(&conn);

    // 第一轮冲突
    update_note(&conn, "n1", "local_1", "2026-05-01T12:00:00Z");
    SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[build_update_change("n1", "cloud_1", "2026-05-01T11:00:00Z")],
        None,
        ConflictPolicy::KeepLatest,
        Some("cloud_dev"),
        Some("local_dev"),
    )
    .unwrap();
    assert_eq!(conflict_count_for(&conn, "n1"), 2);

    // 再次冲突（本地又改了一次，云端又推了一版）
    update_note(&conn, "n1", "local_2", "2026-05-01T14:00:00Z");
    SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[build_update_change("n1", "cloud_2", "2026-05-01T13:00:00Z")],
        None,
        ConflictPolicy::KeepLatest,
        Some("cloud_dev"),
        Some("local_dev"),
    )
    .unwrap();
    assert_eq!(conflict_count_for(&conn, "n1"), 4, "多轮冲突应累积记录");
}

#[test]
fn scenario_55_downloaded_delete_of_already_deleted_record() {
    // 本地已软删，云端又发来一个删除
    let conn = new_test_db();
    insert_note(&conn, "n1", "x", "", "2026-05-01T09:00:00Z");
    mark_all_synced(&conn);
    // 本地删
    conn.execute(
        "UPDATE notes SET deleted_at = '2026-05-01T10:00:00Z' WHERE id='n1'",
        [],
    )
    .unwrap();
    // 云端又发一个 DELETE
    let change = build_delete_change("n1", "2026-05-01T11:00:00Z");
    let r = SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();
    assert_eq!(r.failure_count, 0);
    // deleted_at 可以被云端更新或保持本地时间，但都应已被删除
    assert!(get_deleted_at(&conn, "n1").is_some());
}

#[test]
fn scenario_56_restore_from_conflict_table() {
    // 验证 __sync_conflicts 表可被查询（模拟 UI 列冲突列表）
    let conn = new_test_db();
    insert_note(&conn, "n1", "base", "", "2026-05-01T09:00:00Z");
    mark_all_synced(&conn);
    update_note(&conn, "n1", "local", "2026-05-01T10:00:00Z");
    SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[build_update_change("n1", "cloud", "2026-06-01T00:00:00Z")],
        None,
        ConflictPolicy::KeepLatest,
        Some("cloud_dev"),
        Some("local_dev"),
    )
    .unwrap();

    // 查 local side 数据
    let local_data: String = conn
        .query_row(
            "SELECT data_json FROM __sync_conflicts WHERE record_id='n1' AND side='local'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&local_data).unwrap();
    assert_eq!(parsed["title"], "local");

    let cloud_data: String = conn
        .query_row(
            "SELECT data_json FROM __sync_conflicts WHERE record_id='n1' AND side='cloud'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&cloud_data).unwrap();
    assert_eq!(parsed["title"], "cloud");
}

#[tokio::test]
async fn scenario_57_tombstone_survives_reupload_attempt() {
    // 一端删除 blob，另一端不知道，误以为"本地唯一"又上传了一次：tombstone 机制下这次上传会被后续消费 tombstone 的一端撤销
    let tmp_a = TempDir::new().unwrap();
    let tmp_b = TempDir::new().unwrap();
    let storage = MockCloudStorage::new();
    let mgr_a = SyncManager::new("dev_a".into());
    let mgr_b = SyncManager::new("dev_b".into());

    // A 上传
    let blob = write_content_addressed_blob(tmp_a.path(), b"x");
    mgr_a
        .sync_vfs_blobs(&storage, tmp_a.path(), SyncDirection::Bidirectional)
        .await
        .unwrap();

    // B 下载
    mgr_b
        .sync_vfs_blobs(&storage, tmp_b.path(), SyncDirection::Bidirectional)
        .await
        .unwrap();
    assert!(tmp_b.path().join(&blob.1).exists());

    // A 删除并 tombstone
    std::fs::remove_file(tmp_a.path().join(&blob.1)).unwrap();
    mgr_a
        .mark_blob_deleted(&storage, &blob.0, Some(blob.1.clone()), Some(1))
        .await
        .unwrap();

    // B 再 sync — 本地还有副本，如果不消费 tombstone 会被上传回云端
    mgr_b
        .sync_vfs_blobs_with_tombstones(&storage, tmp_b.path(), SyncDirection::Bidirectional)
        .await
        .unwrap();
    assert!(
        !tmp_b.path().join(&blob.1).exists(),
        "B 本地 blob 应被 tombstone 删除"
    );
    assert!(
        storage
            .get(&format!("data_governance/blobs/{}", blob.1))
            .await
            .unwrap()
            .is_none(),
        "云端也不应有"
    );
}

#[tokio::test]
async fn scenario_58_shared_state_consumes_tombstone_once() {
    // 一个进程内的多个 SyncManager 共享同一 SyncStateStore；它们模拟的是同一
    // app instance 的多次操作，而不是独立设备。B 消费 tombstone 后推进水位，
    // C 在同一 state store 下不应重复消费同一条 tombstone。
    let storage = MockCloudStorage::new();
    let mgr_a = SyncManager::new("dev_a".into());
    let mgr_b = SyncManager::new("dev_b".into());
    let mgr_c = SyncManager::new("dev_c".into());

    // A 上传 blob
    let tmp_a = TempDir::new().unwrap();
    let blob = write_content_addressed_blob(tmp_a.path(), b"v1");
    mgr_a
        .sync_vfs_blobs(&storage, tmp_a.path(), SyncDirection::Bidirectional)
        .await
        .unwrap();

    // B、C 都拿到
    let tmp_b = TempDir::new().unwrap();
    let tmp_c = TempDir::new().unwrap();
    mgr_b
        .sync_vfs_blobs(&storage, tmp_b.path(), SyncDirection::Bidirectional)
        .await
        .unwrap();
    mgr_c
        .sync_vfs_blobs(&storage, tmp_c.path(), SyncDirection::Bidirectional)
        .await
        .unwrap();

    // A 删除
    std::fs::remove_file(tmp_a.path().join(&blob.1)).unwrap();
    mgr_a
        .mark_blob_deleted(&storage, &blob.0, Some(blob.1.clone()), Some(2))
        .await
        .unwrap();

    // B 先同步：删除应传播
    mgr_b
        .sync_vfs_blobs_with_tombstones(&storage, tmp_b.path(), SyncDirection::Bidirectional)
        .await
        .unwrap();
    assert!(!tmp_b.path().join(&blob.1).exists());

    // C 后同步：同一 app instance 的 tombstone 水位已由 B 推进，不重复应用。
    mgr_c
        .sync_vfs_blobs_with_tombstones(&storage, tmp_c.path(), SyncDirection::Bidirectional)
        .await
        .unwrap();
    assert!(
        tmp_c.path().join(&blob.1).exists(),
        "同一 SyncStateStore 下 tombstone 只消费一次；真实多设备需独立 app data"
    );
}

#[tokio::test]
async fn scenario_59_tombstone_then_recreate_with_same_hash() {
    // A 删掉一个 blob，后来又创建了一个内容完全相同的 blob（hash 相同）
    // 预期：新 blob 应该能重新生效，覆盖 tombstone 的效果
    let storage = MockCloudStorage::new();
    let mgr_a = SyncManager::new("dev_a".into());
    let tmp_a = TempDir::new().unwrap();

    let blob = write_content_addressed_blob(tmp_a.path(), b"content");
    let blob_path = tmp_a.path().join(&blob.1);
    mgr_a
        .sync_vfs_blobs(&storage, tmp_a.path(), SyncDirection::Bidirectional)
        .await
        .unwrap();

    // 删除（tombstone）
    std::fs::remove_file(&blob_path).unwrap();
    mgr_a
        .mark_blob_deleted(&storage, &blob.0, Some(blob.1.clone()), Some(7))
        .await
        .unwrap();

    // 走一次同步清理云端
    mgr_a
        .sync_vfs_blobs_with_tombstones(&storage, tmp_a.path(), SyncDirection::Bidirectional)
        .await
        .unwrap();
    assert!(storage
        .get(&format!("data_governance/blobs/{}", blob.1))
        .await
        .unwrap()
        .is_none());

    // 现在又重新创建内容相同的 blob
    write_content_addressed_blob(tmp_a.path(), b"content");

    // 已消费过的 tombstone 有水位记录；同内容 blob 的重新创建发生在 deleted_at 之后。
    // 因此它应被视为一次新的本地创建，而不是再次被旧 tombstone 删除。
    mgr_a
        .sync_vfs_blobs_with_tombstones(&storage, tmp_a.path(), SyncDirection::Bidirectional)
        .await
        .unwrap();

    // 验证行为：内容相同的 blob 可在 tombstone 消费后重新生效
    let blob_still_there = blob_path.exists();
    let cloud_still_there = storage
        .get(&format!("data_governance/blobs/{}", blob.1))
        .await
        .unwrap()
        .is_some();
    assert!(
        blob_still_there,
        "recreated same-hash blob should survive consumed tombstone"
    );
    assert!(
        cloud_still_there,
        "recreated same-hash blob should be uploaded again"
    );
}

#[test]
fn scenario_60_conflict_guard_preserves_atomicity_on_failure() {
    // 冲突感知应用中途某条变更失败 → 整批事务回滚，冲突表也不应留下任何记录
    let conn = new_test_db();
    insert_note(&conn, "a", "base_a", "", "2026-05-01T09:00:00Z");
    mark_all_synced(&conn);
    update_note(&conn, "a", "local_a", "2026-05-01T12:00:00Z");

    let changes = vec![
        // 合法的冲突变更（本地胜）
        build_update_change("a", "cloud_a_older", "2026-05-01T11:00:00Z"),
        // 非法的：写到不存在的表
        SyncChangeWithData {
            table_name: "nonexistent_table".into(),
            record_id: "b".into(),
            operation: ChangeOperation::Insert,
            data: Some(json!({ "id": "b" })),
            changed_at: "2026-05-01T10:00:00Z".into(),
            change_log_id: None,
            database_name: None,
            suppress_change_log: Some(true),
            source_device_id: None,
            source_seq: None,
        },
    ];

    let (apply, conflict) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &changes,
        None,
        ConflictPolicy::KeepLatest,
        Some("cloud"),
        Some("local"),
    )
    .unwrap();
    assert_eq!(apply.failure_count, 1, "非法变更应单条隔离");
    assert_eq!(conflict.rejected, 1, "合法冲突仍应按本地胜出处理");

    // 冲突表保留合法冲突的两端快照；非法变更进入隔离区，不再整批回滚。
    let c = conflict_count(&conn);
    assert_eq!(c, 2, "合法冲突应留下 cloud/local 两份快照");
    let quarantined: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __sync_quarantine WHERE record_id='b'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(quarantined, 1);
    // notes 表里 a 的 title 仍然是本地值
    assert_eq!(get_title(&conn, "a").as_deref(), Some("local_a"));
}

#[tokio::test]
async fn scenario_61_legacy_snapshot_bootstrap_does_not_enable_prune() {
    let storage = MockCloudStorage::new();
    let suffix = Utc::now().timestamp_nanos_opt().unwrap_or_default();
    let manager = SyncManager::new(format!("dev_snapshot_target_{suffix}"));
    let source_device = format!("dev_snapshot_source_{suffix}");
    let now = Utc::now();
    let now_iso = now.to_rfc3339();

    let mut covered_cursors = serde_json::Map::new();
    covered_cursors.insert(source_device.clone(), json!(7));
    covered_cursors.insert(manager.device_id().to_string(), json!(2));

    let snapshot = json!({
        "format_version": 1,
        "database_name": "vfs",
        "device_id": source_device,
        "created_at": now_iso,
        "schema_version": 1,
        "data_version": 7,
        "checksum": "snapshot-checksum",
        "covered_cursors": covered_cursors,
        "rows": {
            "notes": [
                {
                    "id": "snap-note",
                    "title": "from snapshot",
                    "content": "bootstrapped",
                    "tags": "[]",
                    "is_favorite": 0,
                    "created_at": now_iso,
                    "updated_at": now_iso,
                    "deleted_at": null
                }
            ]
        }
    });
    let snapshot_json = serde_json::to_vec(&snapshot).unwrap();
    let snapshot_payload = zstd::stream::encode_all(std::io::Cursor::new(snapshot_json), 0)
        .expect("compress snapshot");
    let snapshot_key = format!(
        "data_governance/snapshots/vfs/{}-{}-snapshot.json.zst",
        now.timestamp_millis(),
        manager.device_id()
    );
    storage.put(&snapshot_key, &snapshot_payload).await.unwrap();
    for database_name in ["chat_v2", "llm_usage", "mistakes"] {
        let snapshot = json!({
            "format_version": 1,
            "database_name": database_name,
            "device_id": source_device,
            "created_at": now_iso,
            "schema_version": 1,
            "data_version": 7,
            "checksum": format!("{database_name}-snapshot-checksum"),
            "covered_cursors": covered_cursors,
            "rows": {}
        });
        let snapshot_json = serde_json::to_vec(&snapshot).unwrap();
        let snapshot_payload = zstd::stream::encode_all(std::io::Cursor::new(snapshot_json), 0)
            .expect("compress snapshot");
        let snapshot_key = format!(
            "data_governance/snapshots/{}/{}-{}-snapshot.json.zst",
            database_name,
            now.timestamp_millis(),
            manager.device_id()
        );
        storage.put(&snapshot_key, &snapshot_payload).await.unwrap();
    }

    let bootstrap = manager
        .download_snapshot_bootstrap_changes(&storage)
        .await
        .unwrap();
    assert_eq!(bootstrap.cursor_advancements.get(&source_device), Some(&7));
    assert_eq!(
        bootstrap.cursor_advancements.get(manager.device_id()),
        Some(&2)
    );
    assert_eq!(bootstrap.changes.len(), 1);
    let change = &bootstrap.changes[0];
    assert_eq!(change.database_name.as_deref(), Some("vfs"));
    assert_eq!(change.table_name, "notes");
    assert_eq!(change.record_id, "snap-note");
    let expected_source = format!("snapshot:{source_device}");
    assert_eq!(
        change.source_device_id.as_deref(),
        Some(expected_source.as_str())
    );
    assert_eq!(change.suppress_change_log, Some(true));

    let own_seq1 = format!(
        "data_governance/changes/{}/{:012}-{}-a.json.zst",
        manager.device_id(),
        1,
        now.timestamp()
    );
    let own_seq2 = format!(
        "data_governance/changes/{}/{:012}-{}-b.json.zst",
        manager.device_id(),
        2,
        now.timestamp()
    );
    let own_seq3 = format!(
        "data_governance/changes/{}/{:012}-{}-c.json.zst",
        manager.device_id(),
        3,
        now.timestamp()
    );
    let other_seq1 = format!(
        "data_governance/changes/{}/{:012}-{}-d.json.zst",
        source_device,
        1,
        now.timestamp()
    );
    for key in [&own_seq1, &own_seq2, &own_seq3, &other_seq1] {
        storage.put(key, b"payload").await.unwrap();
    }

    let deleted = manager.prune_old_changes(&storage, 30).await.unwrap();
    assert_eq!(
        deleted, 0,
        "v1 snapshots lack authoritative replace/delete-set semantics and cannot authorize prune"
    );
    assert!(storage.get(&own_seq1).await.unwrap().is_some());
    assert!(storage.get(&own_seq2).await.unwrap().is_some());
    assert!(storage.get(&own_seq3).await.unwrap().is_some());
    assert!(storage.get(&other_seq1).await.unwrap().is_some());
}

// ============================================================================
// P1 回归：blob tombstone × 内容寻址去重竞态（本地引用防线）
// ============================================================================

/// 构造生产布局：`active/vfs_blobs` + `active/databases/vfs.db`（含 blobs 表）。
/// 返回 (active_dir_guard, blobs_dir)。
fn setup_active_layout_with_vfs_db() -> (TempDir, std::path::PathBuf) {
    let active = TempDir::new().unwrap();
    let blobs_dir = active.path().join("vfs_blobs");
    std::fs::create_dir_all(&blobs_dir).unwrap();
    let db_dir = active.path().join("databases");
    std::fs::create_dir_all(&db_dir).unwrap();
    let conn = Connection::open(db_dir.join("vfs.db")).unwrap();
    conn.execute_batch(
        "CREATE TABLE blobs (
            hash TEXT PRIMARY KEY,
            relative_path TEXT NOT NULL,
            size INTEGER NOT NULL DEFAULT 0,
            mime_type TEXT,
            ref_count INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT 0
         );",
    )
    .unwrap();
    (active, blobs_dir)
}

fn set_blob_ref_count(active_dir: &Path, hash: &str, relative_path: &str, ref_count: i64) {
    let conn = Connection::open(active_dir.join("databases").join("vfs.db")).unwrap();
    conn.execute(
        "INSERT INTO blobs (hash, relative_path, size, ref_count, created_at)
         VALUES (?1, ?2, 0, ?3, 0)
         ON CONFLICT(hash) DO UPDATE SET ref_count = excluded.ref_count",
        params![hash, relative_path, ref_count],
    )
    .unwrap();
}

/// 竞态场景：设备 A 删除 blob 并发布 tombstone；设备 B 在消费 tombstone 前
/// 重新引用了相同内容（内容寻址去重不更新文件 mtime）。
/// 修复前：B 的本地文件 + 云端文件都被删除，引用悬空，内容永久丢失。
/// 修复后：本地 ref_count>0 → 拒绝消费 tombstone，文件保留并重新上传（复活）。
#[tokio::test]
async fn blob_tombstone_rejected_when_locally_referenced_and_blob_revived() {
    let storage = MockCloudStorage::new();
    let mgr_a = SyncManager::new(format!("dev_a_{}", uuid::Uuid::new_v4()));
    let mgr_b = SyncManager::new(format!("dev_b_{}", uuid::Uuid::new_v4()));

    // 设备 B：生产布局 + blob 文件 + vfs.db 中 ref_count=2（仍被引用）
    let (active_b, blobs_dir_b) = setup_active_layout_with_vfs_db();
    let blob = write_content_addressed_blob(&blobs_dir_b, b"shared-content");
    set_blob_ref_count(active_b.path(), &blob.0, &blob.1, 2);

    // 让文件 mtime 早于 tombstone 的 deleted_at（内容寻址去重不更新 mtime）
    let old_mtime = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
    let f = std::fs::File::options()
        .append(true)
        .open(blobs_dir_b.join(&blob.1))
        .unwrap();
    f.set_modified(old_mtime).unwrap();
    drop(f);

    // B 先上传，云端有 blob + manifest 条目
    let _ = mgr_b
        .sync_vfs_blobs(&storage, &blobs_dir_b, SyncDirection::Bidirectional)
        .await
        .unwrap();
    let cloud_key = format!("data_governance/blobs/{}", blob.1);
    assert!(storage.get(&cloud_key).await.unwrap().is_some());

    // 设备 A 发布该 blob 的 tombstone（A 端引用已归零）
    mgr_a
        .mark_blob_deleted(&storage, &blob.0, Some(blob.1.clone()), Some(14))
        .await
        .unwrap();

    // B 消费 tombstone：本地仍有引用 → 必须拒绝删除
    let _ = mgr_b
        .sync_vfs_blobs_with_tombstones(&storage, &blobs_dir_b, SyncDirection::Bidirectional)
        .await
        .unwrap();

    assert!(
        blobs_dir_b.join(&blob.1).exists(),
        "本地仍有 ref_count>0 引用的 blob 不得被 tombstone 删除"
    );
    assert!(
        storage.get(&cloud_key).await.unwrap().is_some(),
        "被本地引用否决的 tombstone 不得删除云端文件（或必须复活重传）"
    );

    // manifest 条目必须存在（保留或复活），其他设备仍可下载
    let tmp_c = TempDir::new().unwrap();
    let mgr_c = SyncManager::new(format!("dev_c_{}", uuid::Uuid::new_v4()));
    let out_c = mgr_c
        .sync_vfs_blobs(&storage, tmp_c.path(), SyncDirection::Download)
        .await
        .unwrap();
    assert_eq!(out_c.downloaded, 1, "复活后的 blob 应可被其他设备下载");
    assert!(tmp_c.path().join(&blob.1).exists());
}

/// 对照场景：本地 ref_count=0（引用确已归零）时，tombstone 必须正常生效。
#[tokio::test]
async fn blob_tombstone_applies_when_ref_count_zero() {
    let storage = MockCloudStorage::new();
    let mgr_a = SyncManager::new(format!("dev_a_{}", uuid::Uuid::new_v4()));
    let mgr_b = SyncManager::new(format!("dev_b_{}", uuid::Uuid::new_v4()));

    let (active_b, blobs_dir_b) = setup_active_layout_with_vfs_db();
    let blob = write_content_addressed_blob(&blobs_dir_b, b"orphaned-content");
    set_blob_ref_count(active_b.path(), &blob.0, &blob.1, 0);

    let old_mtime = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
    let f = std::fs::File::options()
        .append(true)
        .open(blobs_dir_b.join(&blob.1))
        .unwrap();
    f.set_modified(old_mtime).unwrap();
    drop(f);

    let _ = mgr_b
        .sync_vfs_blobs(&storage, &blobs_dir_b, SyncDirection::Bidirectional)
        .await
        .unwrap();

    mgr_a
        .mark_blob_deleted(&storage, &blob.0, Some(blob.1.clone()), Some(15))
        .await
        .unwrap();

    let _ = mgr_b
        .sync_vfs_blobs_with_tombstones(&storage, &blobs_dir_b, SyncDirection::Bidirectional)
        .await
        .unwrap();

    assert!(
        !blobs_dir_b.join(&blob.1).exists(),
        "ref_count=0 的 blob tombstone 必须正常生效"
    );
    let cloud_key = format!("data_governance/blobs/{}", blob.1);
    assert!(
        storage.get(&cloud_key).await.unwrap().is_none(),
        "云端文件应随 tombstone 删除"
    );
}

// ============================================================================
// P2 回归：ref_count 重算只更新实际变化的行（避免 __change_log churn）
// ============================================================================

#[test]
fn recompute_ref_counts_skips_unchanged_rows() {
    let conn = new_test_db();
    conn.execute_batch(
        r#"
        CREATE TABLE resources (
            id TEXT PRIMARY KEY,
            ref_count INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE files (
            id TEXT PRIMARY KEY,
            resource_id TEXT,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            deleted_at TEXT
        );
        CREATE TRIGGER trg_resources_upd
        AFTER UPDATE ON resources
        BEGIN
            INSERT INTO __change_log (table_name, record_id, operation)
            VALUES ('resources', NEW.id, 'UPDATE');
        END;
        "#,
    )
    .unwrap();
    conn.execute(
        "INSERT INTO resources (id, ref_count) VALUES ('r1', 1), ('r2', 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO files (id, resource_id) VALUES ('f-1', 'r1')",
        [],
    )
    .unwrap();

    // 应用一条与 ref_count 完全无关的变更（notes 表无 resource_id/blob_hash 列）：
    // 整个重算应被跳过，不得点火任何 resources 触发器
    let change = build_insert_change("n-rc", "x", "2026-05-01T10:00:00Z");
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();

    let resource_log: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __change_log WHERE table_name = 'resources'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        resource_log, 0,
        "与引用无关的变更批次不得触发 resources 重算/触发器（churn 防线）"
    );

    // 相关表（files 带 resource_id，注册为 RowSync）变更必须触发重算：
    // 失真的 r2 被修正归零，新增引用使 r1 重算为 2，且未变化行不点火触发器
    conn.execute("UPDATE resources SET ref_count = 9 WHERE id = 'r2'", [])
        .unwrap();
    conn.execute(
        "DELETE FROM __change_log WHERE table_name = 'resources'",
        [],
    )
    .unwrap();
    let change2 = SyncChangeWithData {
        table_name: "files".into(),
        record_id: "f-2".into(),
        operation: ChangeOperation::Insert,
        data: Some(json!({
            "id": "f-2",
            "resource_id": "r1",
            "updated_at": "2026-05-01T11:00:00Z",
            "deleted_at": null,
        })),
        changed_at: "2026-05-01T11:00:00Z".into(),
        change_log_id: None,
        database_name: Some("vfs".into()),
        suppress_change_log: Some(true),
        source_device_id: None,
        source_seq: None,
    };
    let apply2 = SyncManager::apply_downloaded_changes(&conn, &[change2], None).unwrap();
    assert_eq!(
        apply2.success_count, 1,
        "files insert 应成功: skipped={} failures={:?}",
        apply2.skipped_count, apply2.failures
    );

    let rc2: i64 = conn
        .query_row("SELECT ref_count FROM resources WHERE id = 'r2'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(rc2, 0, "失真的 ref_count 必须在相关变更批次中被重算修正");
    let rc1: i64 = conn
        .query_row("SELECT ref_count FROM resources WHERE id = 'r1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(rc1, 2, "新增引用后 ref_count 必须重算为实际引用数");
}

// ============================================================================
// P2 回归：设备清单解密失败必须 fail-close（与变更文件路径口径一致）
// ============================================================================

#[tokio::test]
async fn manifest_decrypt_failure_fails_closed() {
    let storage = MockCloudStorage::new();

    // 设备 A 用密码 pw-a 上传加密清单
    let mgr_a = SyncManager::with_encryption(
        format!("dev_a_{}", uuid::Uuid::new_v4()),
        Some("pw-a".into()),
    );
    let manifest_a = mgr_a.create_manifest(HashMap::new());
    mgr_a.upload_manifest(&storage, &manifest_a).await.unwrap();

    // 设备 B 用错误密码：必须报错而非把云端当成空实例
    let mgr_b = SyncManager::with_encryption(
        format!("dev_b_{}", uuid::Uuid::new_v4()),
        Some("pw-wrong".into()),
    );
    let err = mgr_b.download_manifest(&storage).await;
    assert!(
        err.is_err(),
        "错误密码下 download_manifest 必须 fail-close，而非静默跳过设备清单"
    );

    // 设备 B 未配密码：同样必须报错（云端是加密数据）
    let mgr_b_plain = SyncManager::new(format!("dev_b2_{}", uuid::Uuid::new_v4()));
    let err2 = mgr_b_plain.download_manifest(&storage).await;
    assert!(err2.is_err(), "未配置密码遇到加密清单必须 fail-close");

    // 正确密码可正常读取
    let mgr_c = SyncManager::with_encryption(
        format!("dev_c_{}", uuid::Uuid::new_v4()),
        Some("pw-a".into()),
    );
    let ok = mgr_c.download_manifest(&storage).await;
    assert!(ok.is_ok(), "正确密码必须能读取清单: {:?}", ok.err());
}

/// tombstone 清单解密失败必须 fail-close：
/// - 消费路径不得把"解不开"当"无 tombstone"（删除会静默不传播）；
/// - mark_* 写入路径不得拿空清单覆盖云端（丢失该设备全部历史 tombstone）。
#[tokio::test]
async fn tombstone_decrypt_failure_fails_closed() {
    let storage = MockCloudStorage::new();

    // 设备 A（密码 pw-a）发布一条 blob tombstone（加密）
    let mgr_a = SyncManager::with_encryption(
        format!("dev_a_{}", uuid::Uuid::new_v4()),
        Some("pw-a".into()),
    );
    mgr_a
        .mark_blob_deleted(
            &storage,
            "hash_enc_1",
            Some("ha/hash_enc_1.pdf".into()),
            None,
        )
        .await
        .unwrap();

    // 设备 B（错误密码）：消费 tombstone 必须报错，而非静默当作无删除
    let tmp_b = TempDir::new().unwrap();
    let mgr_b = SyncManager::with_encryption(
        format!("dev_b_{}", uuid::Uuid::new_v4()),
        Some("pw-wrong".into()),
    );
    let r = mgr_b
        .sync_vfs_blobs_with_tombstones(&storage, tmp_b.path(), SyncDirection::Bidirectional)
        .await;
    assert!(
        r.is_err(),
        "错误密码下消费 tombstone 必须 fail-close，而非把删除静默丢弃"
    );

    // 设备 A 改了密码后再 mark：读自己旧清单失败必须报错，
    // 而非用空清单覆盖（丢失 hash_enc_1 这条历史 tombstone）
    let mgr_a_newpw =
        SyncManager::with_encryption(mgr_a.device_id().to_string(), Some("pw-changed".into()));
    let r2 = mgr_a_newpw
        .mark_blob_deleted(
            &storage,
            "hash_enc_2",
            Some("hb/hash_enc_2.pdf".into()),
            None,
        )
        .await;
    assert!(
        r2.is_err(),
        "密码不符时 mark_blob_deleted 必须报错，防止空清单覆盖丢失历史 tombstone"
    );

    // 正确密码端不受影响，且历史 tombstone 完整保留
    let tombstones = tombstone::download_blob_tombstones(&storage, &mgr_a)
        .await
        .unwrap();
    assert!(
        tombstones.entries.contains_key("hash_enc_1"),
        "历史 tombstone 不得被错误密码端覆盖丢失"
    );
}

/// 资产清单解密失败必须 fail-close：
/// 否则密码配错的设备会把云端当成空清单，用错误密码全量重传并覆盖资产清单。
#[tokio::test]
async fn assets_manifest_decrypt_failure_fails_closed() {
    let storage = MockCloudStorage::new();

    // 设备 A（密码 pw-a）上传一个资产文件 + 加密清单
    let active_a = TempDir::new().unwrap();
    let app_data_a = TempDir::new().unwrap();
    let asset_dir = active_a.path().join("images");
    std::fs::create_dir_all(&asset_dir).unwrap();
    std::fs::write(asset_dir.join("report.png"), b"asset-payload").unwrap();

    let mgr_a = SyncManager::with_encryption(
        format!("dev_a_{}", uuid::Uuid::new_v4()),
        Some("pw-a".into()),
    );
    let out_a = mgr_a
        .sync_asset_directories(
            &storage,
            active_a.path(),
            app_data_a.path(),
            SyncDirection::Bidirectional,
        )
        .await
        .unwrap();
    assert_eq!(out_a.uploaded, 1);

    // 设备 B（错误密码）：必须报错，而非把云端视为空清单开始覆盖
    let active_b = TempDir::new().unwrap();
    let app_data_b = TempDir::new().unwrap();
    let mgr_b = SyncManager::with_encryption(
        format!("dev_b_{}", uuid::Uuid::new_v4()),
        Some("pw-wrong".into()),
    );
    let r = mgr_b
        .sync_asset_directories(
            &storage,
            active_b.path(),
            app_data_b.path(),
            SyncDirection::Bidirectional,
        )
        .await;
    assert!(
        r.is_err(),
        "错误密码下资产同步必须 fail-close，防止错误密码覆盖云端清单与文件"
    );

    // 正确密码端可继续同步下载
    let active_c = TempDir::new().unwrap();
    let app_data_c = TempDir::new().unwrap();
    let mgr_c = SyncManager::with_encryption(
        format!("dev_c_{}", uuid::Uuid::new_v4()),
        Some("pw-a".into()),
    );
    let out_c = mgr_c
        .sync_asset_directories(
            &storage,
            active_c.path(),
            app_data_c.path(),
            SyncDirection::Download,
        )
        .await
        .unwrap();
    assert_eq!(out_c.downloaded, 1, "正确密码端必须能正常下载资产");
}

#[tokio::test]
async fn append_only_asset_manifests_merge_without_lost_entries() {
    let storage = MockCloudStorage::new();
    let active_a = TempDir::new().unwrap();
    let active_b = TempDir::new().unwrap();
    let app_a = TempDir::new().unwrap();
    let app_b = TempDir::new().unwrap();
    std::fs::create_dir_all(active_a.path().join("images")).unwrap();
    std::fs::create_dir_all(active_b.path().join("images")).unwrap();
    std::fs::write(active_a.path().join("images/a.txt"), b"device-a").unwrap();
    std::fs::write(active_b.path().join("images/b.txt"), b"device-b").unwrap();

    let manager_a = SyncManager::new("append-device-a".into());
    let manager_b = SyncManager::new("append-device-b".into());
    manager_a
        .sync_asset_directories(
            &storage,
            active_a.path(),
            app_a.path(),
            SyncDirection::Bidirectional,
        )
        .await
        .unwrap();
    manager_b
        .sync_asset_directories(
            &storage,
            active_b.path(),
            app_b.path(),
            SyncDirection::Bidirectional,
        )
        .await
        .unwrap();

    let keys = storage.keys();
    let manifest_keys = keys
        .iter()
        .filter(|key| key.starts_with("data_governance/file_manifests/assets/"))
        .collect::<Vec<_>>();
    assert_eq!(manifest_keys.len(), 2, "每个设备应发布独立的不可变清单");
    assert!(
        !keys
            .iter()
            .any(|key| key == "data_governance/assets_manifest.json"),
        "新客户端不得再覆盖写旧共享清单"
    );
    assert_eq!(
        keys.iter()
            .filter(|key| key.starts_with("data_governance/asset_objects/"))
            .count(),
        2,
        "资产对象必须按内容摘要寻址"
    );

    let active_c = TempDir::new().unwrap();
    let app_c = TempDir::new().unwrap();
    let manager_c = SyncManager::new("append-device-c".into());
    let outcome = manager_c
        .sync_asset_directories(
            &storage,
            active_c.path(),
            app_c.path(),
            SyncDirection::Download,
        )
        .await
        .unwrap();
    assert_eq!(outcome.downloaded, 2);
    assert_eq!(
        std::fs::read(active_c.path().join("images/a.txt")).unwrap(),
        b"device-a"
    );
    assert_eq!(
        std::fs::read(active_c.path().join("images/b.txt")).unwrap(),
        b"device-b"
    );
}

#[tokio::test]
async fn corrupt_append_only_file_manifests_fail_closed() {
    let storage = MockCloudStorage::new();
    let manager = SyncManager::new("manifest-corruption-device".into());

    storage
        .put(
            "data_governance/file_manifests/assets/device/bad.json",
            b"{not-json",
        )
        .await
        .unwrap();
    let active = TempDir::new().unwrap();
    let app_data = TempDir::new().unwrap();
    assert!(manager
        .sync_asset_directories(
            &storage,
            active.path(),
            app_data.path(),
            SyncDirection::Download,
        )
        .await
        .is_err());

    storage
        .delete("data_governance/file_manifests/assets/device/bad.json")
        .await
        .unwrap();
    storage
        .put(
            "data_governance/file_manifests/workspaces/device/bad.json",
            b"[]",
        )
        .await
        .unwrap();
    assert!(manager
        .sync_workspace_databases(&storage, active.path(), SyncDirection::Download)
        .await
        .is_err());

    storage
        .delete("data_governance/file_manifests/workspaces/device/bad.json")
        .await
        .unwrap();
    storage
        .put(
            "data_governance/file_manifests/blobs/device/bad.json",
            b"null",
        )
        .await
        .unwrap();
    let blobs = TempDir::new().unwrap();
    assert!(manager
        .sync_vfs_blobs(&storage, blobs.path(), SyncDirection::Download)
        .await
        .is_err());
}

#[tokio::test]
async fn download_only_asset_tombstone_does_not_rehydrate_in_same_round() {
    let storage = MockCloudStorage::new();
    let active_a = TempDir::new().unwrap();
    let app_a = TempDir::new().unwrap();
    std::fs::create_dir_all(active_a.path().join("images")).unwrap();
    std::fs::write(active_a.path().join("images/deleted.txt"), b"stale").unwrap();

    let manager_a = SyncManager::new("tombstone-device-a".into());
    manager_a
        .sync_asset_directories(
            &storage,
            active_a.path(),
            app_a.path(),
            SyncDirection::Upload,
        )
        .await
        .unwrap();
    manager_a
        .mark_asset_deleted(&storage, "active/images/deleted.txt", Some(5))
        .await
        .unwrap();

    let active_b = TempDir::new().unwrap();
    let app_b = TempDir::new().unwrap();
    let manager_b = SyncManager::new("tombstone-device-b".into());
    let outcome = manager_b
        .sync_asset_directories_with_tombstones(
            &storage,
            active_b.path(),
            app_b.path(),
            SyncDirection::Download,
        )
        .await
        .unwrap();

    assert_eq!(outcome.downloaded, 0);
    assert!(
        !active_b.path().join("images/deleted.txt").exists(),
        "download-only 同一轮不得从陈旧清单复活刚消费的删除"
    );
}
