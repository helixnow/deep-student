//! [R12-neutral-names][KEY-ROTATION-R11 T2] 云端整包对象名与设备清单文件名收敛。
//!
//! 新上传不再把备份时间或设备短 ID 编进 `backups/<id>.zip`；per-device
//! manifest 改写 `manifests/<device_id 短哈希>.json`；新写入的
//! `.encryption-marker.createdByDevice` 同样只登记短哈希。
//!
//! 下载 / 裁剪 / 删除仍按 manifest 的 `id` 查找，不解析文件名。因此：
//! - 旧时间戳对象名与 `manifests/<device_id>.json` 继续可读；
//! - 旧客户端只要按清单里的 id 取对象，也能拉到新的中性名备份。
//!
//! 本文件覆盖 KEY-ROTATION-R11 §5.3 阶段一的兼容性四象限，全部走内存
//! CloudStorage，独立于 Tauri runtime 与 docker。

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::{TimeZone, Utc};
use deep_student_lib::cloud_storage::{
    device_id_short_hash, CloudStorage, CloudSyncManager, EncryptionMarker, FileInfo,
};
use deep_student_lib::models::AppError;
use sha2::{Digest, Sha256};
use tempfile::TempDir;

const ENCRYPTION_MARKER_KEY: &str = ".encryption-marker";
const LEGACY_VERSION_ID: &str = "20260115-120000-123-device-abcd1234";

type CloudResult<T> = Result<T, AppError>;

#[derive(Clone, Default)]
struct MemStorage {
    files: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
}

impl MemStorage {
    fn new() -> Self {
        Self::default()
    }

    fn put_raw(&self, key: &str, data: Vec<u8>) {
        self.files.lock().unwrap().insert(key.to_string(), data);
    }

    fn object(&self, key: &str) -> Option<Vec<u8>> {
        self.files.lock().unwrap().get(key).cloned()
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
        "memory-r12-neutral-names"
    }

    async fn check_connection(&self) -> CloudResult<()> {
        Ok(())
    }

    async fn put(&self, key: &str, data: &[u8]) -> CloudResult<()> {
        self.put_raw(key, data.to_vec());
        Ok(())
    }

    async fn get(&self, key: &str) -> CloudResult<Option<Vec<u8>>> {
        Ok(self.object(key))
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
        Ok(self.object(key).map(|value| FileInfo {
            key: key.to_string(),
            size: value.len() as u64,
            last_modified: Utc::now(),
            etag: None,
        }))
    }
}

fn manager_on(storage: &MemStorage, device_id: &str) -> CloudSyncManager {
    CloudSyncManager::new(Box::new(storage.clone()), device_id.to_string())
}

fn sha256_hex(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

fn hashed_manifest_key(device_id: &str) -> String {
    format!("manifests/{}.json", device_id_short_hash(device_id))
}

fn seed_legacy_backup(storage: &MemStorage, device_id: &str, version_id: &str, payload: &[u8]) {
    let timestamp = Utc.with_ymd_and_hms(2026, 1, 15, 12, 0, 0).unwrap();
    storage.put_raw(&format!("backups/{version_id}.zip"), payload.to_vec());
    let manifest = serde_json::json!({
        "version": 1,
        "latest": version_id,
        "updatedAt": timestamp,
        "versions": [{
            "id": version_id,
            "timestamp": timestamp,
            "size": payload.len(),
            "checksum": sha256_hex(payload),
            "deviceId": device_id
        }]
    });
    storage.put_raw(
        &format!("manifests/{device_id}.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    );
}

async fn upload_zip(manager: &CloudSyncManager, payload: &[u8]) -> String {
    let dir = TempDir::new().unwrap();
    let zip = dir.path().join("backup.zip");
    std::fs::write(&zip, payload).unwrap();
    manager
        .upload(&zip, Some("1.2.3".into()), None)
        .await
        .expect("上传应成功")
        .version
        .id
}

fn assert_neutral_version_id(id: &str) {
    assert_eq!(id.len(), 22, "新版本 ID 必须是 22 位: {id}");
    assert!(
        id.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "新版本 ID 必须是字母数字: {id}"
    );
    assert!(!id.contains('-'), "新版本 ID 不得再带时间戳分段: {id}");
    assert!(!id.contains("device"), "新版本 ID 不得编码设备片段: {id}");
}

// ============================================================================
// 1. 新上传对象名不含时间 / 设备
// ============================================================================

#[tokio::test]
async fn new_upload_object_name_contains_no_time_or_device() {
    let storage = MemStorage::new();
    let manager = manager_on(&storage, "device-a");
    let version_id = upload_zip(&manager, b"neutral-zip-bytes").await;

    assert_neutral_version_id(&version_id);
    assert_eq!(
        manager.list_versions().await.unwrap()[0].device_id,
        "device-a",
        "manifest 内容仍保留完整 device_id"
    );

    let backup_keys = storage.keys_with_prefix("backups/");
    assert_eq!(backup_keys, vec![format!("backups/{version_id}.zip")]);
    assert!(
        storage.object(&hashed_manifest_key("device-a")).is_some(),
        "新清单必须写到短哈希文件名"
    );
    assert!(
        storage.object("manifests/device-a.json").is_none(),
        "新上传不得再写暴露 device_id 的清单文件名"
    );
}

// ============================================================================
// 2. 新客户端读旧对象（象限：新读旧）
// ============================================================================

#[tokio::test]
async fn new_client_downloads_legacy_timestamp_object() {
    let storage = MemStorage::new();
    seed_legacy_backup(&storage, "device-a", LEGACY_VERSION_ID, b"legacy-zip");

    let manager = manager_on(&storage, "device-a");
    let listed = manager.list_versions().await.expect("旧清单必须仍可合并");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, LEGACY_VERSION_ID);

    let dir = TempDir::new().unwrap();
    let downloaded = manager
        .download(Some(LEGACY_VERSION_ID), dir.path())
        .await
        .expect("新客户端必须能按 manifest id 下载旧时间戳对象");
    assert_eq!(downloaded.version.id, LEGACY_VERSION_ID);
    let bytes = std::fs::read(&downloaded.local_path).unwrap();
    assert_eq!(bytes, b"legacy-zip");
}

// ============================================================================
// 3. 旧客户端读新对象（象限：旧读新）——只按清单 id 取 backups/<id>.zip
// ============================================================================

#[tokio::test]
async fn legacy_style_reader_can_fetch_new_object_by_manifest_id() {
    let storage = MemStorage::new();
    let writer = manager_on(&storage, "device-a");
    let version_id = upload_zip(&writer, b"new-neutral-zip").await;

    let listed = writer.list_versions().await.unwrap();
    assert_eq!(listed[0].id, version_id);

    let object = storage
        .object(&format!("backups/{version_id}.zip"))
        .expect("旧客户端只要知道 id 就能拼出对象 key");
    assert_eq!(object, b"new-neutral-zip");

    let reader = manager_on(&storage, "device-old-reader");
    let dir = TempDir::new().unwrap();
    let downloaded = reader
        .download(Some(&version_id), dir.path())
        .await
        .expect("另一台设备按清单 id 下载中性名对象必须成功");
    assert_eq!(
        std::fs::read(&downloaded.local_path).unwrap(),
        b"new-neutral-zip"
    );
}

// ============================================================================
// 4. 新旧混布：上传 / 下载 / 裁剪 / 删除
// ============================================================================

#[tokio::test]
async fn mixed_directory_upload_download_prune_and_delete() {
    let storage = MemStorage::new();
    seed_legacy_backup(&storage, "device-a", LEGACY_VERSION_ID, b"keep-or-drop");

    let manager = manager_on(&storage, "device-a").with_max_versions(10);
    let new_id = upload_zip(&manager, b"newer-neutral").await;
    assert_neutral_version_id(&new_id);

    let listed = manager.list_versions().await.unwrap();
    let ids: Vec<&str> = listed.iter().map(|version| version.id.as_str()).collect();
    assert!(ids.contains(&LEGACY_VERSION_ID), "混布目录必须仍看见旧版本");
    assert!(ids.contains(&new_id.as_str()), "混布目录必须看见新版本");

    let dir = TempDir::new().unwrap();
    let old = manager
        .download(Some(LEGACY_VERSION_ID), dir.path())
        .await
        .unwrap();
    let new = manager.download(Some(&new_id), dir.path()).await.unwrap();
    assert_eq!(std::fs::read(&old.local_path).unwrap(), b"keep-or-drop");
    assert_eq!(std::fs::read(&new.local_path).unwrap(), b"newer-neutral");

    manager
        .delete_version(LEGACY_VERSION_ID)
        .await
        .expect("本设备必须能删除已迁入短哈希清单的旧版本");
    let after_delete = manager.list_versions().await.unwrap();
    assert_eq!(after_delete.len(), 1);
    assert_eq!(after_delete[0].id, new_id);
    assert!(
        storage
            .object(&format!("backups/{LEGACY_VERSION_ID}.zip"))
            .is_none(),
        "删除后旧对象应被 GC"
    );

    let pruner = manager_on(&storage, "device-a").with_max_versions(1);
    seed_legacy_backup(&storage, "device-a", LEGACY_VERSION_ID, b"prune-me");
    let kept = upload_zip(&pruner, b"surviving-neutral").await;
    let remaining: Vec<String> = pruner
        .list_versions()
        .await
        .unwrap()
        .into_iter()
        .map(|version| version.id)
        .collect();
    assert_eq!(remaining, vec![kept.clone()]);
    assert!(
        storage
            .object(&format!("backups/{LEGACY_VERSION_ID}.zip"))
            .is_none(),
        "超过保留数时旧时间戳对象应被裁剪"
    );
    assert!(storage.object(&format!("backups/{kept}.zip")).is_some());
}

// ============================================================================
// 5. 旧清单文件名在本设备下次写入时迁到短哈希名
// ============================================================================

#[tokio::test]
async fn legacy_device_manifest_migrates_on_save() {
    let storage = MemStorage::new();
    seed_legacy_backup(&storage, "device-a", LEGACY_VERSION_ID, b"migrate-me");

    let manager = manager_on(&storage, "device-a");
    let status = manager.get_status().await;
    assert!(
        status.last_sync_time.is_some(),
        "仅有旧清单文件名时状态卡仍应读到本设备上次同步时间"
    );

    let new_id = upload_zip(&manager, b"after-migrate").await;
    assert!(
        storage.object("manifests/device-a.json").is_none(),
        "写入新清单后必须删除暴露 device_id 的旧文件名"
    );
    let migrated = storage
        .object(&hashed_manifest_key("device-a"))
        .expect("迁移后清单必须在短哈希文件名下");
    let parsed: serde_json::Value = serde_json::from_slice(&migrated).unwrap();
    let ids: Vec<&str> = parsed["versions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|version| version["id"].as_str().unwrap())
        .collect();
    assert!(ids.contains(&LEGACY_VERSION_ID));
    assert!(ids.contains(&new_id.as_str()));
}

// ============================================================================
// 6. 新标记 createdByDevice 为短哈希；旧全文值升级时原样保留
// ============================================================================

#[tokio::test]
async fn new_marker_created_by_device_is_short_hash() {
    let storage = MemStorage::new();
    let manager = manager_on(&storage, "device-a");
    let marker = manager.persist_encryption_marker().await.unwrap();
    assert_eq!(marker.created_by_device, device_id_short_hash("device-a"));
    assert_ne!(marker.created_by_device, "device-a");
}

#[tokio::test]
async fn upgrade_preserves_raw_legacy_created_by_device() {
    let storage = MemStorage::new();
    let created_at = Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
    let legacy = EncryptionMarker {
        version: 1,
        created_by_device: "device-legacy-writer".to_string(),
        created_at,
        key_verifier: None,
    };
    storage.put_raw(
        ENCRYPTION_MARKER_KEY,
        serde_json::to_vec_pretty(&legacy).unwrap(),
    );

    let manager = manager_on(&storage, "device-a");
    let upgraded = manager
        .verify_encryption_password_before_upload("team-pw-2026")
        .await
        .expect("空仓旧标记仍允许第一台带密码设备升级");
    assert_eq!(upgraded.created_by_device, "device-legacy-writer");
    assert_eq!(upgraded.created_at, created_at);
}
