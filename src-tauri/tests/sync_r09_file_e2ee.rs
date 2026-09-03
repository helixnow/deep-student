//! [R09-e2ee] 文件级端到端加密（DSBK）闭环的集成回归测试。
//!
//! R07 把 DSBK 加密从 payload 扩展到了文件级对象（workspace `.db` 快照、
//! VFS blob、资产文件），R06 给云端加密标记（`.encryption-marker`）加上了
//! 密码校验子。这些行为在 `data_governance::sync::mod` 与
//! `cloud_storage::sync_manager` 内已有单元测试；本文件从**外部 crate 视角**
//! （公开 API 表面）钉死以下不变量，防止后续重构悄悄退化：
//!
//! 1. **错密码解密不覆盖本地文件**：无论 fail-closed 发生在清单解码层还是
//!    对象解密层，本地既有文件必须保持字节级不变；
//! 2. **篡改密文拒收**：密文哈希（`cipher_sha256`）校验先于解密失败，
//!    被篡改对象不落地、有本地旧版时旧版保留；
//! 3. **明文遗留对象在本端启用加密时拒收**（防降级），错误信息可操作；
//! 4. **清单合并密文优先**：密文条目永不被时间戳更新的明文遗留条目盖掉；
//! 5. **对象 key 仍是明文内容哈希**（内容寻址去重保留），对象本体是 DSBK 密文；
//! 6. **无密码遇加密对象 fail-closed**：清单层与对象层都不得静默跳过；
//! 7. **旧 v1 加密标记可读并一次性升级**：升级保留首写者/首写时间，升级后
//!    错密码设备被拦截；损坏标记 fail-closed 且不被改写。
//!
//! 全部使用内存 CloudStorage，独立于 Tauri runtime 与 docker。

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::Utc;
use deep_student_lib::cloud_storage::{
    device_id_short_hash, CloudStorage, CloudSyncManager, FileInfo,
};
use deep_student_lib::crypto::backup_crypto;
use deep_student_lib::data_governance::sync::{
    BlobEntry, BlobsManifest, SyncDirection, SyncManager, WorkspaceEntry, WorkspacesManifest,
};
use deep_student_lib::models::AppError;
use sha2::{Digest, Sha256};
use tempfile::TempDir;

// ============================================================================
// 内存 CloudStorage（Clone 共享同一底层状态，可同时喂给 SyncManager 与
// CloudSyncManager，并在测试中直接窥视/篡改云端对象）
// ============================================================================

type CloudResult<T> = Result<T, AppError>;

#[derive(Clone, Default)]
struct MemStorage {
    files: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
}

impl MemStorage {
    fn new() -> Self {
        Self::default()
    }

    fn object(&self, key: &str) -> Option<Vec<u8>> {
        self.files.lock().unwrap().get(key).cloned()
    }

    fn put_raw(&self, key: &str, data: Vec<u8>) {
        self.files.lock().unwrap().insert(key.to_string(), data);
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
        "memory-r09-e2ee"
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
// 云端 key 常量（镜像 SyncManager 内部私有常量；若引擎改布局这些测试会失败，
// 提醒同时评估旧数据迁移路径）
// ============================================================================

const WORKSPACES_MANIFEST_KEY: &str = "data_governance/workspaces_manifest.json";
const WORKSPACES_MANIFESTS_PREFIX: &str = "data_governance/file_manifests/workspaces";
const WORKSPACES_CLOUD_PREFIX: &str = "data_governance/workspaces";
const BLOBS_MANIFEST_KEY: &str = "data_governance/blobs_manifest.json";
const BLOBS_MANIFESTS_PREFIX: &str = "data_governance/file_manifests/blobs";
const BLOBS_CLOUD_PREFIX: &str = "data_governance/blobs";
const ASSET_OBJECTS_PREFIX: &str = "data_governance/asset_objects";
const ENCRYPTION_MARKER_KEY: &str = ".encryption-marker";

// ============================================================================
// Fixture 辅助
// ============================================================================

fn sha256_hex(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

fn unique_device(prefix: &str) -> String {
    format!("{}-{}", prefix, uuid::Uuid::new_v4().simple())
}

fn encrypted_manager(prefix: &str, password: &str) -> SyncManager {
    SyncManager::with_encryption(unique_device(prefix), Some(password.to_string()))
}

/// 在 `active_dir/workspaces/` 下创建一个真实 SQLite 工作区库并写入一行数据。
fn create_workspace_db(active_dir: &Path, ws_id: &str, content: &str) {
    let dir = active_dir.join("workspaces");
    std::fs::create_dir_all(&dir).unwrap();
    let conn = rusqlite::Connection::open(dir.join(format!("{}.db", ws_id))).unwrap();
    conn.execute_batch("CREATE TABLE notes (id TEXT PRIMARY KEY, content TEXT)")
        .unwrap();
    conn.execute(
        "INSERT INTO notes (id, content) VALUES ('n1', ?1)",
        rusqlite::params![content],
    )
    .unwrap();
}

fn workspace_db_path(active_dir: &Path, ws_id: &str) -> std::path::PathBuf {
    active_dir.join("workspaces").join(format!("{}.db", ws_id))
}

/// 写一个内容寻址 blob（`<h[..2]>/<hash>.pdf`），返回 (hash, relative_path)。
fn write_blob(blobs_dir: &Path, payload: &[u8]) -> (String, String) {
    let hash = sha256_hex(payload);
    let relative = format!("{}/{}.pdf", &hash[..2], hash);
    let path = blobs_dir.join(&relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, payload).unwrap();
    (hash, relative)
}

/// 用 `password` 把任意可序列化清单加密成 DSBK v1 容器（等价于引擎的
/// `encode_payload`），供测试直接向云端播种“对端已发布”的清单。
fn seal_manifest<T: serde::Serialize>(manifest: &T, password: &str) -> Vec<u8> {
    let json = serde_json::to_vec(manifest).unwrap();
    backup_crypto::encrypt_backup(&json, password).unwrap()
}

/// 把 `plain` 内容加密成 DSBK v2 分块流式对象（等价于引擎文件级上传产物），
/// 返回 (密文字节, cipher_sha256)。
fn seal_file_object(plain: &[u8], password: &str) -> (Vec<u8>, String) {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("plain.bin");
    let output = dir.path().join("cipher.dsbk");
    std::fs::write(&input, plain).unwrap();
    backup_crypto::encrypt_backup_file(&input, &output, password).unwrap();
    let bytes = std::fs::read(&output).unwrap();
    let hash = sha256_hex(&bytes);
    (bytes, hash)
}

fn append_only_manifest_key(prefix: &str, device: &str) -> String {
    format!(
        "{}/{}/{}-{}.json",
        prefix,
        device,
        Utc::now().timestamp_millis(),
        uuid::Uuid::new_v4()
    )
}

fn workspace_entry(
    plain_sha: &str,
    plain_size: u64,
    updated_at: String,
    object_key: String,
    cipher: Option<(String, u64)>,
) -> WorkspaceEntry {
    let (cipher_sha256, cipher_size) = match cipher {
        Some((hash, size)) => (Some(hash), Some(size)),
        None => (None, None),
    };
    WorkspaceEntry {
        sha256: plain_sha.to_string(),
        size: plain_size,
        updated_at,
        source_sha256: Some(plain_sha.to_string()),
        device_id: Some("device-seed".to_string()),
        object_key: Some(object_key),
        base_sha256: None,
        revision: 1,
        cipher_sha256,
        cipher_size,
    }
}

// ============================================================================
// 1. 错密码：对象层解密失败不得覆盖本地文件
// ============================================================================

/// 清单可读（用本机密码加密播种）但对象是另一套密码的 DSBK 密文——模拟
/// “同一 root 上历史遗留了另一密码写入的对象”这一最恶劣的错密码形态。
/// 解密必须失败，且本地既有工作区库保持字节级不变、不留明文半成品。
#[tokio::test]
async fn r09_wrong_password_object_decrypt_never_overwrites_local_workspace() {
    let storage = MemStorage::new();
    let local_dir = TempDir::new().unwrap();
    let ws_id = "ws_r09_wrongpw";

    // 本机（密码 pw-b）已有本地工作区库
    create_workspace_db(local_dir.path(), ws_id, "precious local note");
    let local_db = workspace_db_path(local_dir.path(), ws_id);
    let local_before = std::fs::read(&local_db).unwrap();

    // 云端对象：用另一套密码 pw-a 加密的“更新”版本
    let foreign_plain = b"foreign snapshot bytes (not a real db, decrypt fails first)";
    let (cipher_bytes, cipher_sha) = seal_file_object(foreign_plain, "pw-a-2026");
    let plain_sha = sha256_hex(foreign_plain);
    let object_key = format!("{}/{}/{}.db", WORKSPACES_CLOUD_PREFIX, ws_id, plain_sha);
    storage.put_raw(&object_key, cipher_bytes.clone());

    // 清单用本机密码 pw-b 加密播种（清单层可读，对象层才 fail）；
    // updated_at 放到未来，确保 LWW 判定云端获胜、必然走下载路径。
    let mut manifest = WorkspacesManifest::default();
    manifest.updated_at = Utc::now().to_rfc3339();
    manifest.entries.insert(
        ws_id.to_string(),
        workspace_entry(
            &plain_sha,
            foreign_plain.len() as u64,
            (Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
            object_key.clone(),
            Some((cipher_sha, cipher_bytes.len() as u64)),
        ),
    );
    storage.put_raw(
        WORKSPACES_MANIFEST_KEY,
        seal_manifest(&manifest, "pw-b-2026"),
    );

    let manager = encrypted_manager("device-wrongpw", "pw-b-2026");
    let error = manager
        .sync_workspace_databases(&storage, local_dir.path(), SyncDirection::Download)
        .await
        .expect_err("错密码对象解密必须 fail-closed")
        .to_string();
    assert!(
        error.contains("解密") && error.contains("密码不一致或数据损坏"),
        "错误应指出解密失败与可能原因: {error}"
    );

    // 本地文件必须保持字节级不变
    assert_eq!(
        std::fs::read(&local_db).unwrap(),
        local_before,
        "错密码解密失败不得覆盖本地工作区库"
    );
    // 不得留下解密临时文件半成品（`.dsbk-pt-*.tmp` 在失败路径应被自动清理）
    let leftovers: Vec<String> = std::fs::read_dir(local_dir.path().join("workspaces"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
        .filter(|name| name.contains(".tmp"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "失败路径不得残留临时文件: {leftovers:?}"
    );
    // 云端对象不得被改写
    assert_eq!(storage.object(&object_key).unwrap(), cipher_bytes);
}

/// 更常见的错密码形态：连清单都解不开（对端全部用 pw-a 发布）。
/// 必须在清单层 fail-closed，本地文件同样不动。
#[tokio::test]
async fn r09_wrong_password_fails_closed_at_encrypted_manifest() {
    let storage = MemStorage::new();

    // 设备 A（pw-a）真实上传一个工作区库
    let dir_a = TempDir::new().unwrap();
    create_workspace_db(dir_a.path(), "ws_r09_gate", "note from device a");
    let manager_a = encrypted_manager("device-a", "pw-a-2026");
    manager_a
        .sync_workspace_databases(&storage, dir_a.path(), SyncDirection::Upload)
        .await
        .unwrap();

    // 设备 B（pw-b）本地有自己的数据
    let dir_b = TempDir::new().unwrap();
    create_workspace_db(dir_b.path(), "ws_r09_gate", "local only note");
    let local_db = workspace_db_path(dir_b.path(), "ws_r09_gate");
    let local_before = std::fs::read(&local_db).unwrap();

    let manager_b = encrypted_manager("device-b", "pw-b-2026");
    let error = manager_b
        .sync_workspace_databases(&storage, dir_b.path(), SyncDirection::Download)
        .await
        .expect_err("错密码必须在清单解码层 fail-closed")
        .to_string();
    assert!(
        error.contains("密码错误或数据损坏"),
        "错误应指出密码/数据问题: {error}"
    );
    assert_eq!(
        std::fs::read(&local_db).unwrap(),
        local_before,
        "清单层 fail-closed 同样不得触碰本地文件"
    );
}

// ============================================================================
// 2. 篡改密文拒收
// ============================================================================

/// blob 密文被篡改：密文哈希校验失败 → 下载失败且不落地。
#[tokio::test]
async fn r09_tampered_blob_ciphertext_rejected_without_partial_file() {
    let storage = MemStorage::new();
    let password = "shared-pw-2026";

    // 设备 A 真实上传一个加密 blob
    let dir_a = TempDir::new().unwrap();
    let blobs_a = dir_a.path().join("vfs_blobs");
    std::fs::create_dir_all(&blobs_a).unwrap();
    let payload = b"attachment bytes to protect".to_vec();
    let (hash, relative) = write_blob(&blobs_a, &payload);
    let manager_a = encrypted_manager("device-a", password);
    let outcome = manager_a
        .sync_vfs_blobs(&storage, &blobs_a, SyncDirection::Upload)
        .await
        .unwrap();
    assert_eq!(outcome.uploaded, 1);

    // 篡改云端密文（翻转最后一个字节）
    let object_key = format!("{}/{}", BLOBS_CLOUD_PREFIX, relative);
    let mut tampered = storage.object(&object_key).unwrap();
    assert!(backup_crypto::is_encrypted_backup(&tampered));
    let last = tampered.len() - 1;
    tampered[last] ^= 0xFF;
    storage.put_raw(&object_key, tampered);

    // 同密码设备 B 下载：必须失败且不落地
    let dir_b = TempDir::new().unwrap();
    let blobs_b = dir_b.path().join("vfs_blobs");
    std::fs::create_dir_all(&blobs_b).unwrap();
    let manager_b = encrypted_manager("device-b", password);
    let outcome = manager_b
        .sync_vfs_blobs(&storage, &blobs_b, SyncDirection::Download)
        .await
        .unwrap();
    assert_eq!(
        outcome.download_failures,
        vec![hash.clone()],
        "被篡改密文必须记为下载失败"
    );
    assert_eq!(outcome.downloaded, 0);
    assert!(
        !blobs_b.join(&relative).exists(),
        "被篡改对象不得以任何形式落地"
    );
}

/// workspace 密文被篡改：本地旧版必须原样保留。
#[tokio::test]
async fn r09_tampered_workspace_ciphertext_keeps_stale_local_intact() {
    let storage = MemStorage::new();
    let password = "shared-pw-2026";
    let ws_id = "ws_r09_tamper";

    // 设备 B 先有一份较旧的本地版本（先创建，保证 mtime 早于 A 的上传）
    let dir_b = TempDir::new().unwrap();
    create_workspace_db(dir_b.path(), ws_id, "stale but healthy local");
    let local_db = workspace_db_path(dir_b.path(), ws_id);
    let local_before = std::fs::read(&local_db).unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(1200)).await;

    // 设备 A 上传较新版本
    let dir_a = TempDir::new().unwrap();
    create_workspace_db(dir_a.path(), ws_id, "newer note from device a");
    let manager_a = encrypted_manager("device-a", password);
    manager_a
        .sync_workspace_databases(&storage, dir_a.path(), SyncDirection::Upload)
        .await
        .unwrap();

    // 篡改云端 workspace 密文对象
    let object_keys = storage.keys_with_prefix(WORKSPACES_CLOUD_PREFIX);
    assert_eq!(object_keys.len(), 1, "应恰好有一个工作区对象");
    let mut tampered = storage.object(&object_keys[0]).unwrap();
    let mid = tampered.len() / 2;
    tampered[mid] ^= 0xFF;
    storage.put_raw(&object_keys[0], tampered);

    // 设备 B 下载：密文哈希校验失败 → 部分失败错误，本地旧版原样保留
    let manager_b = encrypted_manager("device-b", password);
    let error = manager_b
        .sync_workspace_databases(&storage, dir_b.path(), SyncDirection::Download)
        .await
        .expect_err("被篡改密文必须导致下载失败")
        .to_string();
    assert!(
        error.contains("校验和不匹配") || error.contains("解密"),
        "错误应指出校验/解密失败: {error}"
    );
    assert_eq!(
        std::fs::read(&local_db).unwrap(),
        local_before,
        "被篡改对象不得覆盖本地旧版"
    );
}

// ============================================================================
// 3. 明文遗留对象在 encryption_enabled 时拒收
// ============================================================================

/// 明文遗留 blob（清单条目缺 cipher_sha256）：启用加密的设备必须拒收。
#[tokio::test]
async fn r09_legacy_plaintext_blob_rejected_when_encryption_enabled() {
    let storage = MemStorage::new();
    let password = "shared-pw-2026";

    // 播种：明文对象 + （用本机密码加密的）含明文条目的清单
    let legacy_payload = b"legacy plaintext attachment".to_vec();
    let legacy_hash = sha256_hex(&legacy_payload);
    let legacy_relative = format!("{}/{}.pdf", &legacy_hash[..2], legacy_hash);
    storage.put_raw(
        &format!("{}/{}", BLOBS_CLOUD_PREFIX, legacy_relative),
        legacy_payload.clone(),
    );
    let mut manifest = BlobsManifest::default();
    manifest.updated_at = Utc::now().to_rfc3339();
    manifest.entries.insert(
        legacy_hash.clone(),
        BlobEntry {
            relative_path: legacy_relative.clone(),
            size: legacy_payload.len() as u64,
            updated_at: Utc::now().to_rfc3339(),
            cipher_sha256: None,
            cipher_size: None,
        },
    );
    storage.put_raw(BLOBS_MANIFEST_KEY, seal_manifest(&manifest, password));

    let dir = TempDir::new().unwrap();
    let blobs_dir = dir.path().join("vfs_blobs");
    std::fs::create_dir_all(&blobs_dir).unwrap();
    let manager = encrypted_manager("device-strict", password);
    let outcome = manager
        .sync_vfs_blobs(&storage, &blobs_dir, SyncDirection::Download)
        .await
        .unwrap();
    assert_eq!(
        outcome.download_failures,
        vec![legacy_hash],
        "明文遗留 blob 必须被拒收"
    );
    assert!(
        !blobs_dir.join(&legacy_relative).exists(),
        "被拒收的明文对象不得落地"
    );
}

/// 明文遗留 workspace 条目：拒收错误必须可操作（指出缺 cipher_sha256、
/// 明确拒绝行为、给出迁移指引）。前端人话映射依赖这些片段。
#[tokio::test]
async fn r09_legacy_plaintext_workspace_rejected_with_actionable_error() {
    let storage = MemStorage::new();
    let password = "shared-pw-2026";
    let ws_id = "ws_r09_legacy";

    let legacy_plain = b"legacy plaintext workspace snapshot".to_vec();
    let plain_sha = sha256_hex(&legacy_plain);
    let object_key = format!("{}/{}/{}.db", WORKSPACES_CLOUD_PREFIX, ws_id, plain_sha);
    storage.put_raw(&object_key, legacy_plain.clone());

    let mut manifest = WorkspacesManifest::default();
    manifest.updated_at = Utc::now().to_rfc3339();
    manifest.entries.insert(
        ws_id.to_string(),
        workspace_entry(
            &plain_sha,
            legacy_plain.len() as u64,
            Utc::now().to_rfc3339(),
            object_key,
            None,
        ),
    );
    storage.put_raw(WORKSPACES_MANIFEST_KEY, seal_manifest(&manifest, password));

    let dir = TempDir::new().unwrap();
    let manager = encrypted_manager("device-strict", password);
    let error = manager
        .sync_workspace_databases(&storage, dir.path(), SyncDirection::Download)
        .await
        .expect_err("明文遗留 workspace 必须被拒收")
        .to_string();
    assert!(
        error.contains("cipher_sha256"),
        "错误应指出缺少密文哈希: {error}"
    );
    assert!(error.contains("拒绝下载"), "错误应明确拒收行为: {error}");
    assert!(
        error.contains("加密密码") && error.contains("上传同步"),
        "错误应给出可操作迁移指引: {error}"
    );
    assert!(
        !workspace_db_path(dir.path(), ws_id).exists(),
        "被拒收的明文对象不得落地"
    );
}

// ============================================================================
// 4. 清单合并：密文条目优先，不被更新时间戳的明文条目降级
// ============================================================================

#[tokio::test]
async fn r09_manifest_merge_prefers_ciphertext_entry_over_newer_plaintext() {
    let storage = MemStorage::new();
    let password = "shared-pw-2026";

    // 同一 blob：云端对象已是 DSBK 密文
    let payload = b"content that was migrated to ciphertext".to_vec();
    let hash = sha256_hex(&payload);
    let relative = format!("{}/{}.pdf", &hash[..2], hash);
    let (cipher_bytes, cipher_sha) = seal_file_object(&payload, password);
    storage.put_raw(
        &format!("{}/{}", BLOBS_CLOUD_PREFIX, relative),
        cipher_bytes.clone(),
    );

    // 清单 1（legacy 单文件 key）：密文条目，时间戳**较旧**
    let mut cipher_manifest = BlobsManifest::default();
    cipher_manifest.updated_at = "2026-01-01T00:00:00Z".to_string();
    cipher_manifest.entries.insert(
        hash.clone(),
        BlobEntry {
            relative_path: relative.clone(),
            size: payload.len() as u64,
            updated_at: "2026-01-01T00:00:00Z".to_string(),
            cipher_sha256: Some(cipher_sha),
            cipher_size: Some(cipher_bytes.len() as u64),
        },
    );
    storage.put_raw(
        BLOBS_MANIFEST_KEY,
        seal_manifest(&cipher_manifest, password),
    );

    // 清单 2（append-only per-device key）：同一 hash 的明文遗留条目，
    // 时间戳**更新**——若合并按 LWW 而不是密文优先，这条会盖掉密文条目。
    let mut plain_manifest = BlobsManifest::default();
    plain_manifest.updated_at = Utc::now().to_rfc3339();
    plain_manifest.entries.insert(
        hash.clone(),
        BlobEntry {
            relative_path: relative.clone(),
            size: payload.len() as u64,
            updated_at: Utc::now().to_rfc3339(),
            cipher_sha256: None,
            cipher_size: None,
        },
    );
    storage.put_raw(
        &append_only_manifest_key(BLOBS_MANIFESTS_PREFIX, "device-legacy"),
        seal_manifest(&plain_manifest, password),
    );

    // 下载端：合并后必须选中密文条目 → 正常解密落地（选中明文条目会被拒收）
    let dir = TempDir::new().unwrap();
    let blobs_dir = dir.path().join("vfs_blobs");
    std::fs::create_dir_all(&blobs_dir).unwrap();
    let manager = encrypted_manager("device-reader", password);
    let outcome = manager
        .sync_vfs_blobs(&storage, &blobs_dir, SyncDirection::Download)
        .await
        .unwrap();
    assert_eq!(
        outcome.downloaded, 1,
        "密文优先合并下应正常解密下载: failures={:?}",
        outcome.download_failures
    );
    assert!(!outcome.has_failures());
    assert_eq!(
        std::fs::read(blobs_dir.join(&relative)).unwrap(),
        payload,
        "解密后内容必须与明文一致"
    );
}

// ============================================================================
// 5. 对象 key 仍是明文内容哈希（内容寻址去重），对象本体是 DSBK 密文
// ============================================================================

#[tokio::test]
async fn r09_object_keys_remain_plaintext_content_addressed() {
    let storage = MemStorage::new();
    let password = "shared-pw-2026";
    let active = TempDir::new().unwrap();

    // blob
    let blobs_dir = active.path().join("vfs_blobs");
    std::fs::create_dir_all(&blobs_dir).unwrap();
    let blob_payload = b"blob payload keyed by plaintext hash".to_vec();
    let (blob_hash, blob_relative) = write_blob(&blobs_dir, &blob_payload);
    // asset
    std::fs::create_dir_all(active.path().join("images")).unwrap();
    std::fs::write(active.path().join("images/pic.png"), b"png bytes here").unwrap();
    let asset_sha = sha256_hex(b"png bytes here");
    // workspace
    create_workspace_db(active.path(), "ws_r09_keys", "keyed workspace");

    let manager = encrypted_manager("device-a", password);
    let blob_outcome = manager
        .sync_vfs_blobs(&storage, &blobs_dir, SyncDirection::Upload)
        .await
        .unwrap();
    assert_eq!(blob_outcome.uploaded, 1);
    let asset_outcome = manager
        .sync_asset_directories(
            &storage,
            active.path(),
            active.path(),
            SyncDirection::Upload,
        )
        .await
        .unwrap();
    assert_eq!(asset_outcome.uploaded, 1);
    manager
        .sync_workspace_databases(&storage, active.path(), SyncDirection::Upload)
        .await
        .unwrap();

    // blob：key = 明文 hash 路径；对象 = DSBK 密文；不含明文字节
    let blob_key = format!("{}/{}", BLOBS_CLOUD_PREFIX, blob_relative);
    let blob_object = storage
        .object(&blob_key)
        .expect("blob 对象 key 必须保持明文哈希路径");
    assert!(blob_key.contains(&blob_hash));
    assert!(backup_crypto::is_encrypted_backup(&blob_object));
    assert_ne!(sha256_hex(&blob_object), blob_hash, "密文哈希 != 明文哈希");

    // asset：key = ASSET_OBJECTS_PREFIX/<明文 sha>；对象 = DSBK 密文
    let asset_key = format!("{}/{}", ASSET_OBJECTS_PREFIX, asset_sha);
    let asset_object = storage
        .object(&asset_key)
        .expect("资产对象 key 必须保持明文哈希");
    assert!(backup_crypto::is_encrypted_backup(&asset_object));

    // workspace：对象 key 含明文快照哈希；带外解密清单验证密文哈希登记正确
    let ws_keys = storage.keys_with_prefix(WORKSPACES_CLOUD_PREFIX);
    assert_eq!(ws_keys.len(), 1);
    let ws_object = storage.object(&ws_keys[0]).unwrap();
    assert!(backup_crypto::is_encrypted_backup(&ws_object));

    let manifest_keys = storage.keys_with_prefix(WORKSPACES_MANIFESTS_PREFIX);
    assert!(!manifest_keys.is_empty(), "应已发布 append-only 工作区清单");
    let manifest_bytes = storage.object(&manifest_keys[0]).unwrap();
    assert!(
        backup_crypto::is_encrypted_backup(&manifest_bytes),
        "清单本体也必须是 DSBK 密文"
    );
    let manifest_json = backup_crypto::decrypt_backup(&manifest_bytes, password).unwrap();
    let manifest: WorkspacesManifest = serde_json::from_slice(&manifest_json).unwrap();
    let entry = manifest.entries.get("ws_r09_keys").unwrap();
    assert!(
        ws_keys[0].contains(&entry.sha256),
        "workspace 对象 key 应包含明文快照哈希: key={} sha256={}",
        ws_keys[0],
        entry.sha256
    );
    assert_eq!(
        entry.cipher_sha256.as_deref(),
        Some(sha256_hex(&ws_object).as_str()),
        "清单登记的密文哈希必须与云端对象一致"
    );
    assert_ne!(
        entry.cipher_sha256.as_deref(),
        Some(entry.sha256.as_str()),
        "密文哈希与明文哈希必须不同"
    );
}

// ============================================================================
// 6. 无密码遇加密对象 fail-closed
// ============================================================================

/// 清单层：对端全加密发布，无密码设备读清单必须报错（不能当空清单）。
#[tokio::test]
async fn r09_missing_password_fails_closed_at_encrypted_manifest() {
    let storage = MemStorage::new();
    let dir_a = TempDir::new().unwrap();
    let blobs_a = dir_a.path().join("vfs_blobs");
    std::fs::create_dir_all(&blobs_a).unwrap();
    write_blob(&blobs_a, b"encrypted-only content");

    let manager_a = encrypted_manager("device-a", "pw-a-2026");
    manager_a
        .sync_vfs_blobs(&storage, &blobs_a, SyncDirection::Upload)
        .await
        .unwrap();

    let dir_c = TempDir::new().unwrap();
    let blobs_c = dir_c.path().join("vfs_blobs");
    std::fs::create_dir_all(&blobs_c).unwrap();
    let manager_c = SyncManager::new(unique_device("device-nopw"));
    let error = manager_c
        .sync_vfs_blobs(&storage, &blobs_c, SyncDirection::Download)
        .await
        .expect_err("无密码读加密清单必须 fail-closed")
        .to_string();
    assert!(
        error.contains("未配置加密密码"),
        "错误应提示需要配置密码: {error}"
    );
    assert!(
        std::fs::read_dir(&blobs_c).unwrap().next().is_none(),
        "fail-closed 不得落地任何文件"
    );
}

/// 对象层：清单是明文可读（遗留形态）但条目登记了 cipher_sha256，
/// 无密码设备必须在对象下载处失败，不得把密文字节当明文落地。
#[tokio::test]
async fn r09_missing_password_fails_closed_at_encrypted_object() {
    let storage = MemStorage::new();

    let payload = b"object encrypted by some other device".to_vec();
    let hash = sha256_hex(&payload);
    let relative = format!("{}/{}.pdf", &hash[..2], hash);
    let (cipher_bytes, cipher_sha) = seal_file_object(&payload, "pw-a-2026");
    storage.put_raw(
        &format!("{}/{}", BLOBS_CLOUD_PREFIX, relative),
        cipher_bytes.clone(),
    );

    // 明文清单（无 DSBK 头）：未启用加密的一端可以读
    let mut manifest = BlobsManifest::default();
    manifest.updated_at = Utc::now().to_rfc3339();
    manifest.entries.insert(
        hash.clone(),
        BlobEntry {
            relative_path: relative.clone(),
            size: payload.len() as u64,
            updated_at: Utc::now().to_rfc3339(),
            cipher_sha256: Some(cipher_sha),
            cipher_size: Some(cipher_bytes.len() as u64),
        },
    );
    storage.put_raw(BLOBS_MANIFEST_KEY, serde_json::to_vec(&manifest).unwrap());

    let dir = TempDir::new().unwrap();
    let blobs_dir = dir.path().join("vfs_blobs");
    std::fs::create_dir_all(&blobs_dir).unwrap();
    let manager = SyncManager::new(unique_device("device-nopw"));
    let outcome = manager
        .sync_vfs_blobs(&storage, &blobs_dir, SyncDirection::Download)
        .await
        .unwrap();
    assert_eq!(
        outcome.download_failures,
        vec![hash],
        "无密码遇加密对象必须记为下载失败"
    );
    assert!(
        !blobs_dir.join(&relative).exists(),
        "密文字节不得被当作明文落地"
    );
}

// ============================================================================
// 7. 旧 v1 加密标记：可读、一次性升级、升级后拦截错密码；损坏 fail-closed
// ============================================================================

#[tokio::test]
async fn r09_legacy_v1_marker_readable_upgraded_once_and_locks_wrong_password() {
    let storage = MemStorage::new();

    // 旧版本应用留下的 v1 标记（无校验子）——通过 bool 版策略入口铸造
    let legacy_writer = CloudSyncManager::new(
        Box::new(storage.clone()),
        "device-legacy-writer".to_string(),
    );
    let legacy = legacy_writer.persist_encryption_marker().await.unwrap();
    assert_eq!(legacy.version, 1);
    assert!(legacy.key_verifier.is_none());

    // v1 标记必须仍然可读（serde 向后兼容）
    let raw_v1: serde_json::Value =
        serde_json::from_slice(&storage.object(ENCRYPTION_MARKER_KEY).unwrap()).unwrap();
    assert_eq!(raw_v1["version"], 1);
    assert!(
        raw_v1.get("keyVerifier").is_none(),
        "v1 标记不应有校验子字段"
    );
    let read_back = legacy_writer.read_encryption_marker().await.unwrap();
    assert_eq!(read_back.unwrap().version, 1, "v1 标记必须可读");

    // 升级后的应用带密码上传：一次性升级到 v2，保留首写者与首写时间
    let upgrader = CloudSyncManager::new(Box::new(storage.clone()), "device-upgrader".to_string());
    upgrader
        .enforce_encryption_policy_before_upload_with_password(Some("team-pw-2026"))
        .await
        .expect("旧 v1 标记应被一次性升级而不是拒绝");
    let upgraded = upgrader.read_encryption_marker().await.unwrap().unwrap();
    assert_eq!(upgraded.version, 2);
    assert_eq!(
        upgraded.created_by_device,
        device_id_short_hash("device-legacy-writer"),
        "升级不得改写首次写入者"
    );
    assert_eq!(
        upgraded.created_at, legacy.created_at,
        "升级不得改写首次写入时间"
    );
    assert!(upgraded.key_verifier.is_some(), "升级后必须携带密码校验子");

    // 同密码继续放行；错密码设备被拦截且标记不被改写
    upgrader
        .enforce_encryption_policy_before_upload_with_password(Some("team-pw-2026"))
        .await
        .expect("同密码应继续放行");
    let wrong = CloudSyncManager::new(Box::new(storage.clone()), "device-wrong".to_string());
    let error = wrong
        .enforce_encryption_policy_before_upload_with_password(Some("other-pw"))
        .await
        .expect_err("升级后错密码设备必须被拦截")
        .to_string();
    assert!(error.contains("不一致"), "错误应指出密码不一致: {error}");
    let after = wrong.read_encryption_marker().await.unwrap().unwrap();
    assert_eq!(after.key_verifier, upgraded.key_verifier, "标记不得被改写");

    // 无密码设备的明文上传同样被标记拦截
    let plaintext = CloudSyncManager::new(Box::new(storage.clone()), "device-plain".to_string());
    assert!(
        plaintext
            .enforce_encryption_policy_before_upload_with_password(None)
            .await
            .is_err(),
        "存在加密标记时必须拒绝明文上传"
    );
}

/// 标记损坏：加密与明文上传都必须 fail-closed，且损坏内容不得被静默改写
///（保留现场供人工检查——用户指南 16 的解锁流程依赖这一点）。
#[tokio::test]
async fn r09_corrupted_marker_fails_closed_and_is_preserved() {
    let storage = MemStorage::new();
    storage.put_raw(ENCRYPTION_MARKER_KEY, b"not-json{{".to_vec());

    let manager = CloudSyncManager::new(Box::new(storage.clone()), "device-a".to_string());
    let error = manager
        .enforce_encryption_policy_before_upload_with_password(Some("pw"))
        .await
        .expect_err("损坏标记必须拦截加密上传（fail-closed）")
        .to_string();
    assert!(error.contains("损坏"), "错误应指出标记损坏: {error}");
    assert!(
        error.contains("人工检查"),
        "错误应给出人工检查指引: {error}"
    );

    assert!(
        manager
            .enforce_encryption_policy_before_upload_with_password(None)
            .await
            .is_err(),
        "损坏标记按存在处理，明文上传同样被拒"
    );

    assert_eq!(
        storage.object(ENCRYPTION_MARKER_KEY).unwrap(),
        b"not-json{{".to_vec(),
        "fail-closed 路径不得改写（掩盖）损坏的标记内容"
    );
}
