//! [R11-names2] 资产文件名可逆映射集成回归。
//!
//! 覆盖：rclone 风格非法字符编码、编码幂等扫描、大小写冲突、NFC/NFD 独立
//! 往返、Windows 保留名与尾点/空格、R09 `_` key 双查找与内容更新迁移、
//! 新旧 key 共存，以及段长/总长/恶意 key 的 fail-closed。

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::Utc;
use deep_student_lib::cloud_storage::{CloudStorage, FileInfo};
use deep_student_lib::data_governance::sync::{
    asset_filenames, AssetDirsManifest, AssetFileEntry, AssetSyncOutcome, SyncDirection,
    SyncManager, FILENAME_CONFLICT_MARKER,
};
use deep_student_lib::models::AppError;
use sha2::{Digest, Sha256};
use tempfile::TempDir;

#[derive(Clone, Default)]
struct MemoryCloudStorage {
    files: Arc<Mutex<BTreeMap<String, (Vec<u8>, chrono::DateTime<Utc>)>>>,
}

impl MemoryCloudStorage {
    fn keys(&self) -> Vec<String> {
        self.files.lock().unwrap().keys().cloned().collect()
    }

    fn raw(&self, key: &str) -> Option<Vec<u8>> {
        self.files
            .lock()
            .unwrap()
            .get(key)
            .map(|(data, _)| data.clone())
    }

    fn put_raw(&self, key: &str, data: Vec<u8>) {
        self.files
            .lock()
            .unwrap()
            .insert(key.to_string(), (data, Utc::now()));
    }
}

#[async_trait]
impl CloudStorage for MemoryCloudStorage {
    fn provider_name(&self) -> &'static str {
        "memory-r11-names2"
    }

    async fn check_connection(&self) -> Result<(), AppError> {
        Ok(())
    }

    async fn put(&self, key: &str, data: &[u8]) -> Result<(), AppError> {
        self.put_raw(key, data.to_vec());
        Ok(())
    }

    async fn get(&self, key: &str) -> Result<Option<Vec<u8>>, AppError> {
        Ok(self.raw(key))
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

fn write_asset(active_dir: &TempDir, relative: &str, content: &[u8]) {
    let path = active_dir.path().join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}

fn unique_device(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4())
}

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

async fn sync(
    manager: &SyncManager,
    storage: &MemoryCloudStorage,
    active: &TempDir,
    app_data: &TempDir,
    direction: SyncDirection,
) -> Result<AssetSyncOutcome, deep_student_lib::data_governance::sync::SyncError> {
    manager
        .sync_asset_directories(storage, active.path(), app_data.path(), direction)
        .await
}

fn all_manifests(storage: &MemoryCloudStorage) -> Vec<AssetDirsManifest> {
    storage
        .keys()
        .into_iter()
        .filter(|key| {
            key.starts_with("data_governance/file_manifests/assets/") && key.ends_with(".json")
        })
        .map(|key| serde_json::from_slice(&storage.raw(&key).unwrap()).unwrap())
        .collect()
}

fn all_manifest_keys(storage: &MemoryCloudStorage) -> BTreeSet<String> {
    all_manifests(storage)
        .into_iter()
        .flat_map(|manifest| manifest.entries.into_keys())
        .collect()
}

fn seed_manifest(storage: &MemoryCloudStorage, device: &str, entries: &[(&str, &[u8], &str)]) {
    let mut manifest = AssetDirsManifest::default();
    for (key, content, updated_at) in entries {
        let sha = sha256_hex(content);
        let object_key = format!("data_governance/asset_objects/{sha}");
        storage.put_raw(&object_key, content.to_vec());
        manifest.entries.insert(
            (*key).to_string(),
            AssetFileEntry {
                sha256: sha,
                size: content.len() as u64,
                updated_at: (*updated_at).to_string(),
                object_key: Some(object_key),
                base_sha256: None,
                revision: 1,
                device_id: Some(device.to_string()),
                cipher_sha256: None,
                cipher_size: None,
            },
        );
        manifest.updated_at = manifest.updated_at.max((*updated_at).to_string());
    }
    storage.put_raw(
        &format!("data_governance/file_manifests/assets/{device}/1-seed.json"),
        serde_json::to_vec(&manifest).unwrap(),
    );
}

fn encoded_active_key(relative: &str) -> String {
    let mut segments = relative.split('/');
    let top = segments.next().unwrap();
    let rest: Vec<&str> = segments.collect();
    asset_filenames::encode_asset_key_segments("active", top, &rest).unwrap()
}

fn conflict_count(outcome: &AssetSyncOutcome) -> usize {
    outcome
        .upload_failures
        .iter()
        .chain(&outcome.download_failures)
        .filter(|message| message.contains(FILENAME_CONFLICT_MARKER))
        .count()
}

#[cfg(unix)]
#[tokio::test]
async fn r11_reversible_names_upload_download_and_rescan_without_pingpong() {
    let storage = MemoryCloudStorage::default();
    let active_a = TempDir::new().unwrap();
    let app_a = TempDir::new().unwrap();
    let cases = [
        "images/co:lon.png",
        "images/qu?st*ion.png",
        "images/quo\"te<less>|.png",
        "images/back\\slash.png",
        "images/tab\tname.png",
        "documents/CON.txt",
        "documents/report.",
        "documents/draft ",
        // 原本就含替代字符，必须与 `co:lon.png` 保持不同。
        "images/co：lon.png",
    ];
    for relative in cases {
        write_asset(&active_a, relative, relative.as_bytes());
    }

    let manager_a = SyncManager::new(unique_device("names-a"));
    let first = sync(
        &manager_a,
        &storage,
        &active_a,
        &app_a,
        SyncDirection::Bidirectional,
    )
    .await
    .unwrap();
    assert_eq!(first.uploaded, cases.len());
    assert!(!first.has_failures(), "{:?}", first.failure_summary());

    let keys = all_manifest_keys(&storage);
    for relative in cases {
        let key = encoded_active_key(relative);
        assert!(keys.contains(&key), "{relative:?} 缺少可逆 key: {keys:?}");
        let encoded_name = key.rsplit('/').next().unwrap();
        let raw_name = relative.rsplit('/').next().unwrap();
        assert_eq!(
            asset_filenames::decode_segment(encoded_name).unwrap(),
            raw_name
        );
        assert!(!encoded_name.ends_with('.') && !encoded_name.ends_with(' '));
        assert!(!encoded_name.chars().any(char::is_control));
    }
    assert_ne!(
        encoded_active_key("images/co:lon.png"),
        encoded_active_key("images/co：lon.png")
    );

    let active_b = TempDir::new().unwrap();
    let app_b = TempDir::new().unwrap();
    let manager_b = SyncManager::new(unique_device("names-b"));
    let downloaded = sync(
        &manager_b,
        &storage,
        &active_b,
        &app_b,
        SyncDirection::Download,
    )
    .await
    .unwrap();
    assert_eq!(downloaded.downloaded, cases.len());
    for relative in cases {
        let key = encoded_active_key(relative);
        let safe_relative = key.strip_prefix("active/").unwrap();
        assert_eq!(
            std::fs::read(active_b.path().join(safe_relative)).unwrap(),
            relative.as_bytes()
        );
    }

    let settled = sync(
        &manager_b,
        &storage,
        &active_b,
        &app_b,
        SyncDirection::Bidirectional,
    )
    .await
    .unwrap();
    assert_eq!((settled.uploaded, settled.downloaded), (0, 0));
    assert!(!settled.has_failures(), "{:?}", settled.failure_summary());
}

#[tokio::test]
async fn r11_case_only_names_keep_one_and_report() {
    let storage = MemoryCloudStorage::default();
    let active = TempDir::new().unwrap();
    let app = TempDir::new().unwrap();
    write_asset(&active, "images/Logo.png", b"upper");
    write_asset(&active, "images/logo.png", b"lower");

    let outcome = sync(
        &SyncManager::new(unique_device("case")),
        &storage,
        &active,
        &app,
        SyncDirection::Bidirectional,
    )
    .await
    .unwrap();
    assert_eq!(outcome.uploaded, 1);
    assert_eq!(conflict_count(&outcome), 1);
    assert_eq!(
        all_manifest_keys(&storage),
        BTreeSet::from(["active/images/Logo.png".to_string()])
    );
}

#[cfg(unix)]
#[tokio::test]
async fn r11_nfc_and_nfd_are_distinct_reversible_nfc_safe_keys() {
    use unicode_normalization::UnicodeNormalization;

    let storage = MemoryCloudStorage::default();
    let active = TempDir::new().unwrap();
    let app = TempDir::new().unwrap();
    let nfc = "images/caf\u{e9}.png";
    let nfd = "images/cafe\u{301}.png";
    write_asset(&active, nfc, b"nfc");
    write_asset(&active, nfd, b"nfd");

    let outcome = sync(
        &SyncManager::new(unique_device("unicode")),
        &storage,
        &active,
        &app,
        SyncDirection::Bidirectional,
    )
    .await
    .unwrap();
    assert_eq!(outcome.uploaded, 2);
    assert!(!outcome.has_failures(), "{outcome:?}");

    let nfc_key = encoded_active_key(nfc);
    let nfd_key = encoded_active_key(nfd);
    assert_ne!(nfc_key, nfd_key);
    for (key, expected) in [(&nfc_key, "caf\u{e9}.png"), (&nfd_key, "cafe\u{301}.png")] {
        assert_eq!(key.nfc().collect::<String>(), *key);
        assert_eq!(
            asset_filenames::decode_segment(key.rsplit('/').next().unwrap()).unwrap(),
            expected
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn r11_legacy_underscore_key_dual_lookup_then_migrates_on_content_change() {
    let storage = MemoryCloudStorage::default();
    let old_key = "active/images/pic_1.png";
    seed_manifest(
        &storage,
        "legacy",
        &[(old_key, b"legacy-content", "2020-01-01T00:00:00Z")],
    );

    let active = TempDir::new().unwrap();
    let app = TempDir::new().unwrap();
    write_asset(&active, "images/pic:1.png", b"legacy-content");
    let manager = SyncManager::new(unique_device("migration"));

    let unchanged = sync(
        &manager,
        &storage,
        &active,
        &app,
        SyncDirection::Bidirectional,
    )
    .await
    .unwrap();
    assert_eq!((unchanged.uploaded, unchanged.downloaded), (0, 0));
    assert!(
        !active.path().join("images/pic_1.png").exists(),
        "双 key 查找命中原名后不得旁落一个旧 `_` 副本"
    );

    write_asset(&active, "images/pic:1.png", b"updated-content");
    let migrated = sync(
        &manager,
        &storage,
        &active,
        &app,
        SyncDirection::Bidirectional,
    )
    .await
    .unwrap();
    assert_eq!(migrated.uploaded, 1);
    assert!(!migrated.has_failures(), "{migrated:?}");

    let new_key = encoded_active_key("images/pic:1.png");
    let migration_manifest = all_manifests(&storage)
        .into_iter()
        .find(|manifest| manifest.entries.contains_key(&new_key))
        .expect("内容更新后必须发布可逆 key 清单");
    assert!(!migration_manifest.entries.contains_key(old_key));
    assert_eq!(
        migration_manifest.entries[&new_key].sha256,
        sha256_hex(b"updated-content")
    );
}

#[tokio::test]
async fn r11_new_reversible_and_legacy_underscore_keys_can_coexist() {
    let storage = MemoryCloudStorage::default();
    let new_key = encoded_active_key("images/pic:1.png");
    let old_key = "active/images/pic_1.png";
    seed_manifest(
        &storage,
        "coexist",
        &[
            (old_key, b"legacy-underscore", "2020-01-01T00:00:00Z"),
            (&new_key, b"new-reversible", "2020-01-02T00:00:00Z"),
        ],
    );

    let active = TempDir::new().unwrap();
    let app = TempDir::new().unwrap();
    let outcome = sync(
        &SyncManager::new(unique_device("coexist-download")),
        &storage,
        &active,
        &app,
        SyncDirection::Download,
    )
    .await
    .unwrap();
    assert_eq!(outcome.downloaded, 2);
    assert!(!outcome.has_failures(), "{outcome:?}");
    assert_eq!(
        std::fs::read(active.path().join("images/pic_1.png")).unwrap(),
        b"legacy-underscore"
    );
    assert_eq!(
        std::fs::read(active.path().join(new_key.strip_prefix("active/").unwrap())).unwrap(),
        b"new-reversible"
    );
}

#[tokio::test]
async fn r11_overlong_local_path_fails_before_any_cloud_write() {
    let storage = MemoryCloudStorage::default();
    let active = TempDir::new().unwrap();
    let app = TempDir::new().unwrap();
    let name = format!("images/{}", "a".repeat(230));
    write_asset(&active, &name, b"too-long-total-key");

    let error = sync(
        &SyncManager::new(unique_device("overlong")),
        &storage,
        &active,
        &app,
        SyncDirection::Upload,
    )
    .await
    .expect_err("超出资产 key 总长必须 fail-closed");
    assert!(error.to_string().contains("超长"), "{error}");
    assert!(
        storage.keys().is_empty(),
        "扫描阶段失败前不得产生 manifest 或对象写入"
    );
}

#[tokio::test]
async fn r11_malformed_or_overlong_cloud_key_fails_closed_without_local_write() {
    for key in [
        "active/images/../escape.txt".to_string(),
        format!("active/images/{}", "x".repeat(300)),
        "active/images/\u{201b}ehzz".to_string(),
    ] {
        let storage = MemoryCloudStorage::default();
        seed_manifest(
            &storage,
            "bad-key",
            &[(&key, b"must-not-land", "2020-01-01T00:00:00Z")],
        );
        let active = TempDir::new().unwrap();
        let app = TempDir::new().unwrap();
        let error = sync(
            &SyncManager::new(unique_device("reject")),
            &storage,
            &active,
            &app,
            SyncDirection::Download,
        )
        .await
        .expect_err("非法 key 必须终止同步");
        assert!(
            error.to_string().contains("拒绝非法、损坏或超长资产键"),
            "{key:?}: {error}"
        );
        assert_eq!(std::fs::read_dir(active.path()).unwrap().count(), 0);
    }
}
