//! [R10-chaos] 明文/密文混布混沌：记录级变更链路在"云端同时存在明文与
//! DSBK 密文对象"时必须 fail-closed，绝不静默降级或半应用。
//!
//! 与既有覆盖的差异：`sync_provider_contract_tests` 锁定的是"另一台明文
//! 设备的历史遗留明文"；本文件锁定更恶劣的混沌/攻击面——**同一加密设备的
//! seq 流中途被塞进明文分片**（降级攻击或配置损坏的客户端重装后明文续写），
//! 以及无密码/错密码客户端撞上密文流的行为：
//!
//! 1. **流中降级 fail-closed**：加密设备目录内 seq2 是明文分片时，带密码的
//!    下载端必须整体报错（指认明文分片 key + 说明缺 DSBK 头），前面合法的
//!    seq1 也不得部分应用（无部分消费）；
//! 2. **无密码客户端停在密文分片**：错误指认具体加密对象并提示配置密码；
//! 3. **错密码客户端停在密文分片**：错误指认解密失败，本地库无任何写入；
//! 4. **明文注入不推进游标**：fail-closed 之后修复（移除明文分片），
//!    带密码端必须还能完整消费 seq1（安全点没有吞掉数据）。

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::Utc;
use deep_student_lib::cloud_storage::{device_id_short_hash, CloudStorage, FileInfo};
use deep_student_lib::data_governance::sync::{
    ChangeOperation, SyncChangeWithData, SyncChangesPayload, SyncManager,
};
use deep_student_lib::models::AppError;
use rusqlite::{params, Connection};
use serde_json::json;

type CloudResult<T> = Result<T, AppError>;

// ============================================================================
// 内存 CloudStorage（Clone 共享底层，测试可直接注入/篡改云端对象）
// ============================================================================

#[derive(Clone, Default)]
struct MemStorage {
    files: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
}

impl MemStorage {
    fn put_raw(&self, key: &str, data: Vec<u8>) {
        self.files.lock().unwrap().insert(key.to_string(), data);
    }

    fn remove(&self, key: &str) {
        self.files.lock().unwrap().remove(key);
    }

    fn keys_with_prefix(&self, prefix: &str) -> Vec<String> {
        self.files
            .lock()
            .unwrap()
            .keys()
            .filter(|key| key.starts_with(prefix))
            .cloned()
            .collect()
    }
}

#[async_trait]
impl CloudStorage for MemStorage {
    fn provider_name(&self) -> &'static str {
        "memory-r10-mixed-e2ee"
    }

    async fn check_connection(&self) -> CloudResult<()> {
        Ok(())
    }

    async fn put(&self, key: &str, data: &[u8]) -> CloudResult<()> {
        self.files
            .lock()
            .unwrap()
            .insert(key.to_string(), data.to_vec());
        Ok(())
    }

    async fn get(&self, key: &str) -> CloudResult<Option<Vec<u8>>> {
        Ok(self.files.lock().unwrap().get(key).cloned())
    }

    async fn list(&self, prefix: &str) -> CloudResult<Vec<FileInfo>> {
        Ok(self
            .files
            .lock()
            .unwrap()
            .iter()
            .filter(|(key, _)| key.starts_with(prefix))
            .map(|(key, value)| FileInfo {
                key: key.clone(),
                size: value.len() as u64,
                last_modified: Utc::now(),
                etag: None,
            })
            .collect())
    }

    async fn delete(&self, key: &str) -> CloudResult<()> {
        self.files.lock().unwrap().remove(key);
        Ok(())
    }

    async fn stat(&self, key: &str) -> CloudResult<Option<FileInfo>> {
        Ok(self.files.lock().unwrap().get(key).map(|value| FileInfo {
            key: key.to_string(),
            size: value.len() as u64,
            last_modified: Utc::now(),
            etag: None,
        }))
    }
}

// ============================================================================
// Fixture
// ============================================================================

const PASSWORD: &str = "r10-chaos-mixed-e2ee-password";

fn unique_device(prefix: &str) -> String {
    format!("{}-{}", prefix, uuid::Uuid::new_v4().simple())
}

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

fn insert_change(record_id: &str, content: &str, updated_at: &str) -> SyncChangeWithData {
    SyncChangeWithData {
        table_name: "items".to_string(),
        record_id: record_id.to_string(),
        operation: ChangeOperation::Insert,
        data: Some(json!({
            "id": record_id,
            "content": content,
            "updated_at": updated_at,
        })),
        changed_at: updated_at.to_string(),
        change_log_id: None,
        database_name: Some("vfs".to_string()),
        suppress_change_log: Some(true),
        source_device_id: None,
        source_seq: None,
    }
}

fn item_count(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
        .unwrap()
}

/// 手工构造一个**明文** v3 变更分片（无 DSBK 头），注入到指定设备的 seq 流。
/// 内容格式与引擎产物一致：zstd(compact JSON of SyncChangesPayload)。
fn plaintext_shard(
    device_id: &str,
    seq: u64,
    changes: Vec<SyncChangeWithData>,
) -> (String, Vec<u8>) {
    let key = format!(
        "data_governance/changes/{}/{:012}-{}-{}.json.zst",
        device_id_short_hash(device_id),
        seq,
        Utc::now().timestamp(),
        uuid::Uuid::new_v4()
    );
    let payload = SyncChangesPayload {
        total_count: changes.len(),
        changes,
        device_id: device_id.to_string(),
        format_version: 3,
        source_seq: seq,
        source_device_id: device_id.to_string(),
        operation_id: None,
    };
    let json = serde_json::to_vec(&payload).unwrap();
    let compressed = zstd::stream::encode_all(std::io::Cursor::new(json), 0).unwrap();
    (key, compressed)
}

/// 布置混沌现场：加密设备正常上传 seq1（密文），随后其 seq 流中被注入
/// 明文 seq2。返回 (storage, 加密设备 id, seq1 密文 key, seq2 明文 key)。
async fn seed_midstream_downgrade() -> (MemStorage, String, String, String) {
    let storage = MemStorage::default();
    let uploader_id = unique_device("r10-mixed-enc");
    let uploader = SyncManager::with_encryption(uploader_id.clone(), Some(PASSWORD.to_string()));

    uploader
        .upload_enriched_changes(
            &storage,
            &[insert_change(
                "mixed-legit",
                "encrypted-payload",
                "2026-07-10T12:00:00Z",
            )],
            None,
        )
        .await
        .expect("加密上传 seq1 应成功");

    let prefix = format!(
        "data_governance/changes/{}/",
        device_id_short_hash(&uploader_id)
    );
    let seq1_keys = storage.keys_with_prefix(&prefix);
    assert_eq!(seq1_keys.len(), 1, "应恰好有一个密文分片: {seq1_keys:?}");
    let seq1_key = seq1_keys[0].clone();
    let seq1_bytes = storage.get(&seq1_key).await.unwrap().unwrap();
    assert!(
        deep_student_lib::crypto::backup_crypto::is_encrypted_backup(&seq1_bytes),
        "seq1 分片必须是 DSBK 密文"
    );

    // 混沌注入：同一设备目录里出现明文 seq2（降级攻击 / 重装后明文续写）
    let (seq2_key, seq2_bytes) = plaintext_shard(
        &uploader_id,
        2,
        vec![insert_change(
            "mixed-injected",
            "plaintext-downgrade",
            "2026-07-10T12:30:00Z",
        )],
    );
    storage.put_raw(&seq2_key, seq2_bytes);

    (storage, uploader_id, seq1_key, seq2_key)
}

// ============================================================================
// 1. 流中降级：带密码端必须整体 fail-closed，seq1 不得部分应用
// ============================================================================

#[tokio::test]
async fn r10_chaos_midstream_plaintext_downgrade_fails_closed() {
    let (storage, _uploader_id, _seq1_key, seq2_key) = seed_midstream_downgrade().await;

    let target = SyncManager::with_encryption(
        unique_device("r10-mixed-target"),
        Some(PASSWORD.to_string()),
    );
    let error = target
        .download_changes(&storage, 0, None)
        .await
        .expect_err("加密流中的明文分片必须让下载整体 fail-closed");
    let message = error.to_string();
    assert!(
        message.contains(&seq2_key),
        "错误必须指认被注入的明文分片 {seq2_key}: {message}"
    );
    assert!(
        message.contains("DSBK"),
        "错误必须说明缺少 DSBK 加密头（防降级语义）: {message}"
    );

    // 下载失败即无可应用之物：本地库保持零写入
    let conn = new_db();
    assert_eq!(item_count(&conn), 0, "fail-closed 后不得有任何行落地");
}

// ============================================================================
// 2. 无密码客户端停在密文分片，错误指认对象并提示配置密码
// ============================================================================

#[tokio::test]
async fn r10_chaos_no_password_client_stops_at_encrypted_shard() {
    let (storage, _uploader_id, seq1_key, _seq2_key) = seed_midstream_downgrade().await;

    let plaintext_client = SyncManager::new(unique_device("r10-mixed-nopass"));
    let error = plaintext_client
        .download_changes(&storage, 0, None)
        .await
        .expect_err("无密码客户端必须停在第一个密文分片");
    let message = error.to_string();
    assert!(
        message.contains(&seq1_key),
        "错误必须指认密文分片 {seq1_key}: {message}"
    );
    assert!(
        message.contains("密码"),
        "错误必须可操作（提示配置密码）: {message}"
    );
}

// ============================================================================
// 3. 错密码客户端停在密文分片，解密失败不落地
// ============================================================================

#[tokio::test]
async fn r10_chaos_wrong_password_client_fails_closed_at_first_shard() {
    let (storage, _uploader_id, seq1_key, _seq2_key) = seed_midstream_downgrade().await;

    let wrong = SyncManager::with_encryption(
        unique_device("r10-mixed-wrongpass"),
        Some("totally-wrong-password".to_string()),
    );
    let error = wrong
        .download_changes(&storage, 0, None)
        .await
        .expect_err("错密码客户端必须在第一个密文分片 fail-closed");
    let message = error.to_string();
    assert!(
        message.contains(&seq1_key),
        "错误必须指认密文分片 {seq1_key}: {message}"
    );
    assert!(
        message.contains("解密") || message.contains("密码"),
        "错误必须说明解密失败: {message}"
    );
}

// ============================================================================
// 4. 修复明文注入后，seq1 仍可完整消费（安全点不吞数据、游标未被推进）
// ============================================================================

#[tokio::test]
async fn r10_chaos_removing_injected_plaintext_restores_full_consumption() {
    let (storage, _uploader_id, _seq1_key, seq2_key) = seed_midstream_downgrade().await;

    let target = SyncManager::with_encryption(
        unique_device("r10-mixed-recover"),
        Some(PASSWORD.to_string()),
    );

    // 第一次：fail-closed
    target
        .download_changes(&storage, 0, None)
        .await
        .expect_err("明文注入期间必须 fail-closed");

    // 运维修复：移除被注入的明文分片
    storage.remove(&seq2_key);

    // 第二次：seq1 必须完整可消费——安全点不得吞掉合法数据
    let downloaded = target
        .download_changes(&storage, 0, None)
        .await
        .expect("移除明文分片后下载应恢复");
    assert_eq!(
        downloaded.changes.len(),
        1,
        "seq1 的合法密文变更必须完整返回"
    );
    assert_eq!(downloaded.changes[0].record_id, "mixed-legit");

    let conn = new_db();
    let applied = SyncManager::apply_downloaded_changes(&conn, &downloaded.changes, None).unwrap();
    assert_eq!(applied.failure_count, 0);
    assert_eq!(item_count(&conn), 1);
    let content: String = conn
        .query_row(
            "SELECT content FROM items WHERE id='mixed-legit'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(content, "encrypted-payload");
}
