//! [R07-asset-e2ee] 文件级对象端到端加密回归测试
//!
//! 记录级 payload（变更记录 / 清单 / tombstone）自 P0-2 起走 DSBK 容器，
//! 但文件级对象——VFS blob 内容、workspace `.db` 传输快照、资产文件——
//! 曾经无视 `SyncManager::encryption_enabled()` 明文 `put_file` 直传。
//!
//! 本文件钉住 R07 的修复契约：
//!
//! 1. **加密上传**：配置密码后，三类文件级对象的云端字节必须是 DSBK 容器，
//!    且对象键 / 清单 hash 保持**明文内容哈希**（内容寻址与去重语义不变，
//!    包装层与明文 hash 可分离）；
//! 2. **透明解包**：同密码设备下载后得到原始明文，且按明文哈希回验；
//! 3. **fail-closed 下载**：云端对象是 DSBK 而本机无密码 → 明确失败，
//!    绝不把密文当明文落盘；密文损坏 / 密码不符 → 同样失败且不触碰目标路径；
//! 4. **历史明文防降级**：本机启用加密后，即使清单经 AEAD 认证且钉住明文
//!    哈希，缺少 `cipher_sha256` 的历史明文对象仍拒收；原文与替换内容都不落盘；
//! 5. **明文上传拒绝**：本机无密码但云端 root 已有 `.encryption-marker` →
//!    拒绝文件级明文上传（与 R04/R06 记录级政策一致）。

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::Utc;
use deep_student_lib::backup_common::calculate_file_hash;
use deep_student_lib::cloud_storage::{CloudStorage, FileInfo};
use deep_student_lib::crypto::backup_crypto::{encrypt_backup, is_encrypted_backup};
use deep_student_lib::data_governance::sync::{
    BlobEntry, BlobsManifest, SyncDirection, SyncManager,
};
use deep_student_lib::models::AppError;
use tempfile::TempDir;

type CloudResult<T> = Result<T, AppError>;

/// 内存云存储：可克隆句柄共享底层对象，便于模拟多设备连同一 root。
/// `put_file`/`get_file` 走 trait 默认实现（读写本地文件 + put/get 缓冲）。
#[derive(Clone, Default)]
struct MemoryCloudStorage {
    files: Arc<Mutex<BTreeMap<String, (Vec<u8>, chrono::DateTime<Utc>)>>>,
}

impl MemoryCloudStorage {
    fn raw(&self, key: &str) -> Option<Vec<u8>> {
        self.files
            .lock()
            .unwrap()
            .get(key)
            .map(|(data, _)| data.clone())
    }

    fn overwrite(&self, key: &str, data: Vec<u8>) {
        let mut files = self.files.lock().unwrap();
        assert!(
            files.contains_key(key),
            "overwrite 目标对象必须已存在: {key}"
        );
        files.insert(key.to_string(), (data, Utc::now()));
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
impl CloudStorage for MemoryCloudStorage {
    fn provider_name(&self) -> &'static str {
        "memory-r07"
    }

    async fn check_connection(&self) -> CloudResult<()> {
        Ok(())
    }

    async fn put(&self, key: &str, data: &[u8]) -> CloudResult<()> {
        self.files
            .lock()
            .unwrap()
            .insert(key.to_string(), (data.to_vec(), Utc::now()));
        Ok(())
    }

    async fn get(&self, key: &str) -> CloudResult<Option<Vec<u8>>> {
        Ok(self.raw(key))
    }

    async fn list(&self, prefix: &str) -> CloudResult<Vec<FileInfo>> {
        let mut files: Vec<FileInfo> = self
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
            .collect();
        files.sort_by(|left, right| right.last_modified.cmp(&left.last_modified));
        Ok(files)
    }

    async fn delete(&self, key: &str) -> CloudResult<()> {
        self.files.lock().unwrap().remove(key);
        Ok(())
    }

    async fn stat(&self, key: &str) -> CloudResult<Option<FileInfo>> {
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

const PASSWORD: &str = "r07-e2ee-password";

fn manager_with_password(device_id: &str) -> SyncManager {
    SyncManager::with_encryption(device_id.to_string(), Some(PASSWORD.to_string()))
}

fn manager_plaintext(device_id: &str) -> SyncManager {
    SyncManager::new(device_id.to_string())
}

/// 在 blobs 目录写入一个内容寻址 blob（文件名即明文 sha256），返回其哈希。
fn write_blob(blobs_dir: &Path, content: &[u8]) -> String {
    std::fs::create_dir_all(blobs_dir).unwrap();
    let staging = blobs_dir.join("staging.tmp");
    std::fs::write(&staging, content).unwrap();
    let hash = calculate_file_hash(&staging).unwrap();
    std::fs::rename(&staging, blobs_dir.join(&hash)).unwrap();
    hash
}

fn assert_no_temp_residue(dir: &Path) {
    if !dir.exists() {
        return;
    }
    for entry in std::fs::read_dir(dir).unwrap() {
        let name = entry.unwrap().file_name().to_string_lossy().to_string();
        assert!(
            !name.ends_with(".tmp"),
            "失败路径不得留下临时文件残渣: {name}"
        );
    }
}

// ============================================================================
// 1. VFS blob：加密上传 + 明文哈希内容寻址 + 同密码往返
// ============================================================================

#[tokio::test]
async fn r07_blob_upload_with_password_wraps_dsbk_and_roundtrips() {
    let storage = MemoryCloudStorage::default();
    let dir_a = TempDir::new().unwrap();
    let dir_b = TempDir::new().unwrap();
    let content = b"r07 attachment plaintext bytes".repeat(64);
    let hash = write_blob(dir_a.path(), &content);

    let device_a = manager_with_password("device-a");
    let outcome = device_a
        .sync_vfs_blobs(&storage, dir_a.path(), SyncDirection::Upload)
        .await
        .expect("加密 blob 上传应成功");
    assert_eq!(outcome.uploaded, 1);
    assert!(!outcome.has_failures(), "{outcome:?}");

    // 对象键仍是明文内容哈希（内容寻址不变），但云端字节必须是 DSBK 密文
    let object_key = format!("data_governance/blobs/{hash}");
    let cloud_bytes = storage
        .raw(&object_key)
        .expect("云端必须存在以明文哈希为键的对象");
    assert!(
        is_encrypted_backup(&cloud_bytes),
        "启用加密后文件级对象必须是 DSBK 容器"
    );
    assert_ne!(
        cloud_bytes, content,
        "云端字节不得等于明文（不能静默明文上传）"
    );

    // 同密码设备下载：透明解包为原始明文，且哈希回验通过
    let device_b = manager_with_password("device-b");
    let outcome = device_b
        .sync_vfs_blobs(&storage, dir_b.path(), SyncDirection::Download)
        .await
        .expect("同密码设备下载应成功");
    assert_eq!(outcome.downloaded, 1);
    assert!(!outcome.has_failures(), "{outcome:?}");
    let restored = std::fs::read(dir_b.path().join(&hash)).unwrap();
    assert_eq!(restored, content, "下载解包后必须还原为明文原文");
    assert_no_temp_residue(dir_b.path());
}

// ============================================================================
// 2. fail-closed：DSBK 对象 + 本机无密码 → 拒绝，密文绝不当明文落盘
// ============================================================================

#[tokio::test]
async fn r07_blob_download_of_encrypted_object_without_password_fails_closed() {
    let storage = MemoryCloudStorage::default();
    let dir_a = TempDir::new().unwrap();
    let dir_b = TempDir::new().unwrap();
    let content = b"plaintext that later becomes encrypted in cloud".to_vec();
    let hash = write_blob(dir_a.path(), &content);

    // 明文模式设备 A 上传（清单为明文，B 无密码可读）
    manager_plaintext("device-a")
        .sync_vfs_blobs(&storage, dir_a.path(), SyncDirection::Upload)
        .await
        .expect("明文上传（无标记 root）应成功");

    // 模拟另一台加密客户端把对象换成 DSBK 密文
    let object_key = format!("data_governance/blobs/{hash}");
    storage.overwrite(
        &object_key,
        encrypt_backup(&content, "someone-elses-pw").unwrap(),
    );

    let outcome = manager_plaintext("device-b")
        .sync_vfs_blobs(&storage, dir_b.path(), SyncDirection::Download)
        .await
        .expect("blob 同步整体返回 Ok，失败逐条记录");
    assert_eq!(
        outcome.download_failures,
        vec![hash.clone()],
        "无密码遇到 DSBK 对象必须记为下载失败"
    );
    assert!(
        !dir_b.path().join(&hash).exists(),
        "fail-closed：密文不得以任何形式落到目标路径"
    );
    assert_no_temp_residue(dir_b.path());
}

// ============================================================================
// 3. 密文损坏 / 密码不符 → 下载失败且不触碰目标路径
// ============================================================================

#[tokio::test]
async fn r07_blob_download_with_undecryptable_object_fails() {
    let storage = MemoryCloudStorage::default();
    let dir_a = TempDir::new().unwrap();
    let dir_b = TempDir::new().unwrap();
    let content = b"content pinned by encrypted manifest".to_vec();
    let hash = write_blob(dir_a.path(), &content);

    manager_with_password("device-a")
        .sync_vfs_blobs(&storage, dir_a.path(), SyncDirection::Upload)
        .await
        .expect("加密上传应成功");

    // 攻击者/故障方把对象换成另一把密码加密的 DSBK 密文
    let object_key = format!("data_governance/blobs/{hash}");
    storage.overwrite(
        &object_key,
        encrypt_backup(&content, "attacker-pw").unwrap(),
    );

    let outcome = manager_with_password("device-b")
        .sync_vfs_blobs(&storage, dir_b.path(), SyncDirection::Download)
        .await
        .expect("blob 同步整体返回 Ok，失败逐条记录");
    assert_eq!(outcome.download_failures, vec![hash.clone()]);
    assert!(!dir_b.path().join(&hash).exists());
    assert_no_temp_residue(dir_b.path());
}

// ============================================================================
// 4. 历史明文对象：启用加密的设备拒收，原文与替换内容都不得落盘
// ============================================================================

#[tokio::test]
async fn r07_legacy_plaintext_blob_and_substitution_are_rejected() {
    let storage = MemoryCloudStorage::default();
    let dir_a = TempDir::new().unwrap();
    let content = b"legacy object uploaded by a pre-R07 client".to_vec();
    let hash = write_blob(dir_a.path(), &content);
    let relative_path = format!("{}/{}.pdf", &hash[..2], hash);
    let object_key = format!("data_governance/blobs/{relative_path}");

    // 模拟 R07 之前旧客户端留下的明文对象，并用当前密码封装清单，确保拒收发生
    // 在文件级防降级门禁，而不是清单解码层。缺 cipher_sha256 是关键旧格式信号。
    storage.put(&object_key, &content).await.unwrap();
    let mut manifest = BlobsManifest::default();
    manifest.updated_at = Utc::now().to_rfc3339();
    manifest.entries.insert(
        hash.clone(),
        BlobEntry {
            relative_path: relative_path.clone(),
            size: content.len() as u64,
            updated_at: Utc::now().to_rfc3339(),
            cipher_sha256: None,
            cipher_size: None,
        },
    );
    let manifest = encrypt_backup(&serde_json::to_vec(&manifest).unwrap(), PASSWORD).unwrap();
    storage
        .put("data_governance/blobs_manifest.json", &manifest)
        .await
        .unwrap();

    let dir_b = TempDir::new().unwrap();
    let outcome = manager_with_password("device-b")
        .sync_vfs_blobs(&storage, dir_b.path(), SyncDirection::Download)
        .await
        .expect("blob 同步整体返回 Ok，明文遗留拒收逐条记录");
    assert_eq!(outcome.downloaded, 0);
    assert_eq!(outcome.download_failures, vec![hash.clone()]);
    assert!(
        !dir_b.path().join(&relative_path).exists(),
        "启用加密后，内容正确的历史明文也不得落盘"
    );
    assert_no_temp_residue(dir_b.path());

    // 替换攻击同样必须拒绝，且不得因对象仍为明文而绕过门禁。
    storage.overwrite(&object_key, b"tampered plaintext substitution".to_vec());
    let dir_c = TempDir::new().unwrap();
    let outcome = manager_with_password("device-c")
        .sync_vfs_blobs(&storage, dir_c.path(), SyncDirection::Download)
        .await
        .expect("blob 同步整体返回 Ok，失败逐条记录");
    assert_eq!(
        outcome.download_failures,
        vec![hash.clone()],
        "明文替换必须被文件级防降级门禁拦截"
    );
    assert_eq!(outcome.downloaded, 0);
    assert!(
        !dir_c.path().join(&relative_path).exists(),
        "替换后的明文对象不得落盘"
    );
    assert_no_temp_residue(dir_c.path());
}

// ============================================================================
// 5. 无密码 + 云端已有加密标记 → 三类文件级上传一律拒绝
// ============================================================================

#[tokio::test]
async fn r07_plaintext_file_uploads_rejected_when_marker_exists() {
    let storage = MemoryCloudStorage::default();
    storage
        .put(".encryption-marker", br#"{"version":2}"#)
        .await
        .unwrap();

    let active = TempDir::new().unwrap();
    // 准备三类本地文件：blob、资产、workspace 数据库
    let blobs_dir = active.path().join("vfs_blobs");
    write_blob(&blobs_dir, b"plaintext blob under marked root");
    let images = active.path().join("images");
    std::fs::create_dir_all(&images).unwrap();
    std::fs::write(images.join("pic.bin"), b"plaintext asset").unwrap();
    let workspaces = active.path().join("workspaces");
    std::fs::create_dir_all(&workspaces).unwrap();
    {
        let conn = rusqlite::Connection::open(workspaces.join("ws_marked.db")).unwrap();
        conn.execute_batch("CREATE TABLE t(x TEXT); INSERT INTO t VALUES('row');")
            .unwrap();
    }

    let manager = manager_plaintext("device-nopw");

    let blob_err = manager
        .sync_vfs_blobs(&storage, &blobs_dir, SyncDirection::Upload)
        .await
        .expect_err("有加密标记且无密码时必须拒绝 blob 明文上传")
        .to_string();
    assert!(blob_err.contains(".encryption-marker"), "{blob_err}");
    assert!(blob_err.contains("加密密码"), "{blob_err}");

    let asset_err = manager
        .sync_asset_directories(
            &storage,
            active.path(),
            active.path(),
            SyncDirection::Upload,
        )
        .await
        .expect_err("有加密标记且无密码时必须拒绝资产明文上传")
        .to_string();
    assert!(asset_err.contains(".encryption-marker"), "{asset_err}");

    let ws_err = manager
        .sync_workspace_databases(&storage, active.path(), SyncDirection::Upload)
        .await
        .expect_err("有加密标记且无密码时必须拒绝工作区数据库明文上传")
        .to_string();
    assert!(ws_err.contains(".encryption-marker"), "{ws_err}");

    // 三类文件级对象一个都不允许出现在云端
    for prefix in [
        "data_governance/blobs/",
        "data_governance/asset_objects/",
        "data_governance/assets/",
        "data_governance/workspaces/",
    ] {
        assert!(
            storage.keys_with_prefix(prefix).is_empty(),
            "拒绝后不得有任何 {prefix} 对象被上传: {:?}",
            storage.keys_with_prefix(prefix)
        );
    }
}

// ============================================================================
// 6. 资产目录：加密上传 + 同密码往返
// ============================================================================

#[tokio::test]
async fn r07_asset_directory_roundtrip_is_encrypted() {
    let storage = MemoryCloudStorage::default();
    let active_a = TempDir::new().unwrap();
    let active_b = TempDir::new().unwrap();
    let content = b"asset file plaintext r07".repeat(32);
    let images = active_a.path().join("images");
    std::fs::create_dir_all(&images).unwrap();
    let asset_path = images.join("pic.bin");
    std::fs::write(&asset_path, &content).unwrap();
    let sha256 = calculate_file_hash(&asset_path).unwrap();

    let outcome = manager_with_password("device-a")
        .sync_asset_directories(
            &storage,
            active_a.path(),
            active_a.path(),
            SyncDirection::Upload,
        )
        .await
        .expect("加密资产上传应成功");
    assert_eq!(outcome.uploaded, 1);
    assert!(!outcome.has_failures(), "{outcome:?}");

    // 对象键 = 明文 sha256；云端字节 = DSBK 密文
    let object_key = format!("data_governance/asset_objects/{sha256}");
    let cloud_bytes = storage
        .raw(&object_key)
        .expect("资产对象必须按明文哈希寻址");
    assert!(is_encrypted_backup(&cloud_bytes));
    assert_ne!(cloud_bytes, content);

    let outcome = manager_with_password("device-b")
        .sync_asset_directories(
            &storage,
            active_b.path(),
            active_b.path(),
            SyncDirection::Download,
        )
        .await
        .expect("同密码资产下载应成功");
    assert_eq!(outcome.downloaded, 1);
    assert!(!outcome.has_failures(), "{outcome:?}");
    assert_eq!(
        std::fs::read(active_b.path().join("images/pic.bin")).unwrap(),
        content
    );
}

// ============================================================================
// 7. workspace 数据库：加密上传 + 同密码往返（完整性检查通过、数据可读）
// ============================================================================

#[tokio::test]
async fn r07_workspace_database_roundtrip_is_encrypted() {
    let storage = MemoryCloudStorage::default();
    let active_a = TempDir::new().unwrap();
    let active_b = TempDir::new().unwrap();
    let workspaces_a = active_a.path().join("workspaces");
    std::fs::create_dir_all(&workspaces_a).unwrap();
    {
        let conn = rusqlite::Connection::open(workspaces_a.join("ws_r07.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE notes(body TEXT); INSERT INTO notes VALUES('r07-secret-row');",
        )
        .unwrap();
    }

    manager_with_password("device-a")
        .sync_workspace_databases(&storage, active_a.path(), SyncDirection::Upload)
        .await
        .expect("加密工作区数据库上传应成功");

    // 云端 ws 快照对象必须是 DSBK 密文，键内哈希为明文快照哈希
    let ws_keys = storage.keys_with_prefix("data_governance/workspaces/ws_r07/");
    assert_eq!(ws_keys.len(), 1, "应恰好上传一个快照对象: {ws_keys:?}");
    let cloud_bytes = storage.raw(&ws_keys[0]).unwrap();
    assert!(
        is_encrypted_backup(&cloud_bytes),
        "workspace 快照必须为 DSBK 容器"
    );
    assert_ne!(
        &cloud_bytes[0..15],
        b"SQLite format 3",
        "云端不得出现明文 SQLite 头"
    );

    manager_with_password("device-b")
        .sync_workspace_databases(&storage, active_b.path(), SyncDirection::Download)
        .await
        .expect("同密码工作区数据库下载应成功");
    let restored = active_b.path().join("workspaces/ws_r07.db");
    assert!(restored.exists(), "下载后本地必须还原 ws_r07.db");
    let conn = rusqlite::Connection::open(&restored).unwrap();
    let body: String = conn
        .query_row("SELECT body FROM notes", [], |row| row.get(0))
        .unwrap();
    assert_eq!(body, "r07-secret-row", "解包后的数据库必须完整可读");
}
