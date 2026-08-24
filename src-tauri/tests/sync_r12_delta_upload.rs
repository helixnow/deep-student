//! [R12-delta-upload] backup-v2 快照发布原语集成测试（进程内假存储）。
//!
//! **本测试全绿不代表增量备份已实现**：`delta_upload` 是未接线积木，生产
//! Cloud backup 仍是「全量 ZIP → 单对象 `put_file`」，没有任何命令 / UI /
//! `sync_manager` 路径调用 `publish_verified_staging`（本文件的源码锁强制
//! 该事实）。
//!
//! 覆盖：
//! 1. 首版：所有逻辑文件（含 `manifest.json`）各上传一个新对象；
//! 2. 同设备零数据变化：只重传 volatile 的 `manifest.json`，其余对象逐字节复用；
//! 3. 同设备单文件变化：只有该文件 + `manifest.json` 换新对象；
//! 4. 跨设备不复用：字节相同也必须上传自己的对象；
//! 5. commit 顺序：index / descriptor PUT 失败只留孤儿，index 无新版本；
//! 6. 租约被占：`E_BACKUP_LEASE_HELD` 且 objects 零写入；
//! 7. 损坏 index / 损坏上一 descriptor：fail-closed，零新对象；
//! 8. E2EE：对象与 descriptor 都是 DSBK，一次会话多对象，明文哈希不进明文面；
//! 9. 源码锁：生产 `sync_manager.rs` 仍整 ZIP 上传，`delta_upload` 零生产接线。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use deep_student_lib::cloud_storage::backup_lease::{
    BackupRepoLease, BACKUP_LEASE_HELD_ERROR_CODE, BACKUP_REPO_LEASE_FORMAT_VERSION,
    BACKUP_REPO_LEASE_PREFIX,
};
use deep_student_lib::cloud_storage::delta_format::{BackupV2RepoConfig, SnapshotDescriptorV2};
use deep_student_lib::cloud_storage::delta_upload::{
    device_index_key, publish_verified_staging, BackupV2DeviceIndex, PublishParams, PublishResult,
    BACKUP_V2_CONFIG_KEY, BACKUP_V2_MANIFESTS_PREFIX, BACKUP_V2_OBJECTS_PREFIX,
    BACKUP_V2_SNAPSHOTS_PREFIX, DEFAULT_BACKUP_V2_MAX_VERSIONS,
};
use deep_student_lib::cloud_storage::{CloudStorage, FileInfo, ListOutcome};
use deep_student_lib::crypto::backup_crypto::{is_encrypted_backup, FileCipherSession};
use deep_student_lib::data_governance::backup::delta_inventory::MANIFEST_LOGICAL_PATH;
use deep_student_lib::data_governance::backup::{BackupFile, BackupManifest};
use deep_student_lib::models::AppError;
use sha2::{Digest, Sha256};

type CloudResult<T> = Result<T, AppError>;

const DB_PATH: &str = "study_law.db";
const ASSET_PATH: &str = "assets/images/图 01.png";
const CRYPTO_PATH: &str = "crypto/master.key";
const DATA_PATHS: [&str; 3] = [DB_PATH, ASSET_PATH, CRYPTO_PATH];

// ============================================================================
// 进程内假存储（BTreeMap；支持按 key 前缀注入 PUT 失败）
// ============================================================================

struct MemoryStorage {
    files: Mutex<BTreeMap<String, (Vec<u8>, DateTime<Utc>)>>,
    fail_put_prefixes: Mutex<Vec<String>>,
}

impl MemoryStorage {
    fn new() -> Self {
        Self {
            files: Mutex::new(BTreeMap::new()),
            fail_put_prefixes: Mutex::new(Vec::new()),
        }
    }

    fn fail_puts_under(&self, prefix: &str) {
        self.fail_put_prefixes
            .lock()
            .unwrap()
            .push(prefix.to_string());
    }

    fn insert_raw(&self, key: &str, bytes: Vec<u8>) {
        self.files
            .lock()
            .unwrap()
            .insert(key.to_string(), (bytes, Utc::now()));
    }

    fn get_raw(&self, key: &str) -> Option<Vec<u8>> {
        self.files
            .lock()
            .unwrap()
            .get(key)
            .map(|(bytes, _)| bytes.clone())
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
impl CloudStorage for MemoryStorage {
    fn provider_name(&self) -> &'static str {
        "memory"
    }

    async fn check_connection(&self) -> CloudResult<()> {
        Ok(())
    }

    async fn put(&self, key: &str, data: &[u8]) -> CloudResult<()> {
        let failing = self
            .fail_put_prefixes
            .lock()
            .unwrap()
            .iter()
            .any(|prefix| key.starts_with(prefix.as_str()));
        if failing {
            return Err(AppError::network(format!("injected PUT failure: {key}")));
        }
        self.files
            .lock()
            .unwrap()
            .insert(key.to_string(), (data.to_vec(), Utc::now()));
        Ok(())
    }

    async fn get(&self, key: &str) -> CloudResult<Option<Vec<u8>>> {
        Ok(self.get_raw(key))
    }

    async fn list(&self, prefix: &str) -> CloudResult<Vec<FileInfo>> {
        let files = self
            .files
            .lock()
            .unwrap()
            .iter()
            .filter(|(key, _)| key.starts_with(prefix))
            .map(|(key, (bytes, modified))| FileInfo {
                key: key.clone(),
                size: bytes.len() as u64,
                last_modified: *modified,
                etag: None,
            })
            .collect();
        Ok(files)
    }

    async fn list_outcome(&self, prefix: &str) -> CloudResult<ListOutcome> {
        Ok(ListOutcome::complete(self.list(prefix).await?))
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
            .map(|(bytes, modified)| FileInfo {
                key: key.to_string(),
                size: bytes.len() as u64,
                last_modified: *modified,
                etag: None,
            }))
    }
}

fn cloud(storage: &Arc<MemoryStorage>) -> Arc<dyn CloudStorage> {
    storage.clone()
}

// ============================================================================
// 已验证 staging 构造（对照 sync_r12_delta_inventory.rs）
// ============================================================================

fn sha256_hex_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn sha256_hex(path: &Path) -> String {
    sha256_hex_bytes(&fs::read(path).expect("read file for hashing"))
}

fn write_file(root: &Path, relative: &str, bytes: &[u8]) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create parent dirs");
    }
    fs::write(&path, bytes).expect("write staging file");
}

fn write_sqlite(root: &Path, relative: &str, rows: u32) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create parent dirs");
    }
    let conn = rusqlite::Connection::open(&path).expect("open sqlite");
    conn.execute_batch("CREATE TABLE progress (id INTEGER PRIMARY KEY, note TEXT NOT NULL);")
        .expect("create table");
    for i in 0..rows {
        conn.execute(
            "INSERT INTO progress (id, note) VALUES (?1, ?2)",
            rusqlite::params![i64::from(i) + 1, format!("note-{i}")],
        )
        .expect("insert row");
    }
    conn.close().expect("close sqlite");
}

fn write_manifest(root: &Path, data_files: &[&str]) {
    let mut manifest = BackupManifest::new("1.2.3");
    for relative in data_files {
        let path = root.join(relative);
        manifest.add_file(BackupFile {
            path: (*relative).to_string(),
            size: fs::metadata(&path).expect("stat staged file").len(),
            sha256: sha256_hex(&path),
            database_id: None,
        });
    }
    manifest
        .save_to_file(&root.join(MANIFEST_LOGICAL_PATH))
        .expect("save manifest");
}

/// SQLite + 资产 + crypto 文件各一，外加 manifest.json 的最小已验证 staging。
fn make_staging(root: &Path, db_rows: u32) {
    fs::create_dir_all(root).expect("mkdir staging");
    write_sqlite(root, DB_PATH, db_rows);
    write_file(root, ASSET_PATH, b"png-bytes-not-really-a-png");
    write_file(root, CRYPTO_PATH, b"fake-master-key-material");
    write_manifest(root, &DATA_PATHS);
}

fn copy_dir_recursive(src: &Path, dst: &Path) {
    fs::create_dir_all(dst).expect("create copy target");
    for entry in fs::read_dir(src).expect("read src dir") {
        let entry = entry.expect("dir entry");
        let target = dst.join(entry.file_name());
        if entry.file_type().expect("file type").is_dir() {
            copy_dir_recursive(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), &target).expect("copy file");
        }
    }
}

/// 只改 manifest.json 的 volatile 字段，模拟「数据零变化、再出一版」。
fn bump_manifest_volatile_fields(root: &Path) {
    let path = root.join(MANIFEST_LOGICAL_PATH);
    let mut value: serde_json::Value =
        serde_json::from_slice(&fs::read(&path).expect("read manifest")).expect("parse manifest");
    value["created_at"] = serde_json::json!("2027-01-01T00:00:00+00:00");
    value["backup_id"] = serde_json::json!("zerochange-second-run-0001");
    value["snapshot_epoch"] = serde_json::json!("00000000-0000-4000-8000-00000000feed");
    fs::write(
        &path,
        serde_json::to_string_pretty(&value).expect("serialize"),
    )
    .expect("write manifest");
}

async fn publish(
    storage: &Arc<MemoryStorage>,
    root: &Path,
    device_id: &str,
    cipher: Option<&FileCipherSession>,
) -> Result<PublishResult, AppError> {
    publish_verified_staging(
        cloud(storage),
        root,
        PublishParams {
            device_id,
            app_version: Some("1.2.3"),
            note: None,
            cipher,
        },
    )
    .await
}

/// 从存储解出某版本的 descriptor（cipher None → 明文 decode）。
fn fetch_descriptor(
    storage: &MemoryStorage,
    snapshot_key: &str,
    cipher: Option<&FileCipherSession>,
) -> SnapshotDescriptorV2 {
    let bytes = storage.get_raw(snapshot_key).expect("snapshot stored");
    let plain = match cipher {
        Some(session) => session.decrypt_bytes(&bytes).expect("decrypt descriptor"),
        None => bytes,
    };
    SnapshotDescriptorV2::decode(&plain).expect("decode descriptor")
}

fn fetch_index(storage: &MemoryStorage, device_id: &str) -> BackupV2DeviceIndex {
    let bytes = storage
        .get_raw(&device_index_key(device_id))
        .expect("index stored");
    BackupV2DeviceIndex::decode(&bytes).expect("decode index")
}

fn object_key_of<'a>(descriptor: &'a SnapshotDescriptorV2, path: &str) -> &'a str {
    descriptor
        .files
        .iter()
        .find(|file| file.logical_path == path)
        .unwrap_or_else(|| panic!("descriptor missing {path}"))
        .object_key
        .as_str()
}

fn insert_active_lease(storage: &MemoryStorage, holder: &str) {
    let now = Utc::now();
    let lease = BackupRepoLease {
        format_version: BACKUP_REPO_LEASE_FORMAT_VERSION,
        target: "backup-v2".to_string(),
        holder_device_id: holder.to_string(),
        operation_id: "30000000-0000-4000-8000-000000000003".to_string(),
        created_at: now.to_rfc3339(),
        expires_at: (now + chrono::Duration::minutes(5)).to_rfc3339(),
        activation_committed: true,
    };
    let key = format!("{}{}.json", BACKUP_REPO_LEASE_PREFIX, lease.operation_id);
    storage.insert_raw(&key, serde_json::to_vec_pretty(&lease).unwrap());
}

// ============================================================================
// 1. 首版：全部逻辑文件各上传一个新对象
// ============================================================================

#[tokio::test]
async fn r12_first_version_uploads_every_logical_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("staging");
    make_staging(&root, 1);

    let storage = Arc::new(MemoryStorage::new());
    let result = publish(&storage, &root, "device-a", None)
        .await
        .expect("first publish succeeds");

    // 首版无复用：新上传 == 逻辑总量，4 个逻辑文件（含 manifest.json）。
    assert_eq!(result.uploaded_file_count, 4);
    assert_eq!(result.reused_file_count, 0);
    assert_eq!(result.reused_size, 0);
    assert_eq!(result.newly_uploaded_size, result.logical_size);
    assert!(result.logical_size > 0);

    let object_keys = storage.keys_with_prefix(BACKUP_V2_OBJECTS_PREFIX);
    assert_eq!(
        object_keys.len(),
        4,
        "one immutable object per logical file"
    );
    for key in &object_keys {
        assert!(key.starts_with("backup-v2/objects/device-a/"), "{key}");
        assert!(key.ends_with(".dsbk"), "{key}");
    }

    // descriptor 自包含完整文件表；明文模式下对象字节 == staging 明文字节。
    let descriptor = fetch_descriptor(&storage, &result.snapshot_key, None);
    assert_eq!(descriptor.version_id, result.version_id);
    assert_eq!(descriptor.files.len(), 4);
    assert_eq!(descriptor.logical_size, result.logical_size);
    for file in &descriptor.files {
        let staged = fs::read(root.join(&file.logical_path)).expect("read staged file");
        let stored = storage.get_raw(&file.object_key).expect("object stored");
        assert_eq!(
            stored, staged,
            "plaintext mode stores staging bytes verbatim"
        );
        assert_eq!(file.plaintext_sha256, sha256_hex_bytes(&staged));
        assert_eq!(file.object_cipher_sha256, sha256_hex_bytes(&stored));
    }

    // index：唯一 commit point，一条版本记录。
    let index = fetch_index(&storage, "device-a");
    assert_eq!(index.versions.len(), 1);
    assert_eq!(index.latest.as_deref(), Some(result.version_id.as_str()));
    assert_eq!(index.versions[0].snapshot_key, result.snapshot_key);
    assert_eq!(index.versions[0].logical_size, result.logical_size);
    assert_eq!(index.versions[0].newly_uploaded_size, result.logical_size);

    // 仓库配置首次写入且可解码；v1 namespace 零写入。
    let config_bytes = storage
        .get_raw(BACKUP_V2_CONFIG_KEY)
        .expect("config written");
    let config = BackupV2RepoConfig::decode(&config_bytes).expect("decode config");
    assert!(config.id_key_epoch >= 1);
    assert!(storage.keys_with_prefix("backups/").is_empty());
    assert!(storage.keys_with_prefix("manifests/").is_empty());

    assert_eq!(DEFAULT_BACKUP_V2_MAX_VERSIONS, 10);
}

#[tokio::test]
async fn r12_blank_device_id_fails_closed_with_zero_writes() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("staging");
    make_staging(&root, 1);

    let storage = Arc::new(MemoryStorage::new());
    let error = publish(&storage, &root, "   ", None)
        .await
        .expect_err("blank device id must fail closed");
    assert!(error.to_string().contains("设备 ID"), "{error}");
    assert!(storage.files.lock().unwrap().is_empty(), "zero writes");
}

// ============================================================================
// 2. 同设备零数据变化：只重传 volatile 的 manifest.json
// ============================================================================

#[tokio::test]
async fn r12_zero_change_second_version_reuses_all_data_objects() {
    let dir = tempfile::tempdir().expect("tempdir");
    let prev_root = dir.path().join("prev");
    let curr_root = dir.path().join("curr");
    make_staging(&prev_root, 1);
    copy_dir_recursive(&prev_root, &curr_root);
    bump_manifest_volatile_fields(&curr_root);

    let storage = Arc::new(MemoryStorage::new());
    let v1 = publish(&storage, &prev_root, "device-a", None)
        .await
        .expect("v1 publish");
    let v2 = publish(&storage, &curr_root, "device-a", None)
        .await
        .expect("v2 publish");

    // 只有 always-changed 的 manifest.json 需要新对象。
    assert_eq!(
        v2.uploaded_file_count, 1,
        "only manifest.json is re-uploaded"
    );
    assert_eq!(v2.reused_file_count, 3);
    assert!(v2.reused_size > 0);
    assert_eq!(v2.reused_size + v2.newly_uploaded_size, v2.logical_size);

    let d1 = fetch_descriptor(&storage, &v1.snapshot_key, None);
    let d2 = fetch_descriptor(&storage, &v2.snapshot_key, None);

    // 数据对象的 object_key 逐字节相同（真复用，不是重新上传同内容）。
    for path in DATA_PATHS {
        assert_eq!(
            object_key_of(&d1, path),
            object_key_of(&d2, path),
            "{path} must reuse the previous immutable object"
        );
    }
    // manifest.json 即使字节层面只差 volatile 字段也必须换新对象。
    assert_ne!(
        object_key_of(&d1, MANIFEST_LOGICAL_PATH),
        object_key_of(&d2, MANIFEST_LOGICAL_PATH)
    );

    // 新 descriptor 是自包含完整文件表，不是 patch；schema 禁止 parent 字段。
    assert_eq!(d2.files.len(), 4);
    let raw = storage.get_raw(&v2.snapshot_key).expect("descriptor bytes");
    let raw_text = String::from_utf8(raw).expect("plaintext descriptor is JSON");
    assert!(!raw_text.contains("\"parent\""), "no parent/patch chain");

    // 对象总数 = 首版 4 + 第二版仅 manifest 1。
    assert_eq!(storage.keys_with_prefix(BACKUP_V2_OBJECTS_PREFIX).len(), 5);
    let index = fetch_index(&storage, "device-a");
    assert_eq!(index.versions.len(), 2);
    assert_eq!(index.latest.as_deref(), Some(v2.version_id.as_str()));
}

// ============================================================================
// 3. 同设备改一个文件：只有该文件 + manifest.json 换新对象
// ============================================================================

#[tokio::test]
async fn r12_single_file_change_uploads_only_that_file_and_manifest() {
    let dir = tempfile::tempdir().expect("tempdir");
    let prev_root = dir.path().join("prev");
    let curr_root = dir.path().join("curr");
    make_staging(&prev_root, 1);
    copy_dir_recursive(&prev_root, &curr_root);
    fs::remove_file(curr_root.join(DB_PATH)).expect("drop copied db");
    write_sqlite(&curr_root, DB_PATH, 2);
    write_manifest(&curr_root, &DATA_PATHS);

    let storage = Arc::new(MemoryStorage::new());
    let v1 = publish(&storage, &prev_root, "device-a", None)
        .await
        .expect("v1 publish");
    let v2 = publish(&storage, &curr_root, "device-a", None)
        .await
        .expect("v2 publish");

    assert_eq!(v2.uploaded_file_count, 2, "changed db + manifest.json only");
    assert_eq!(v2.reused_file_count, 2);

    let d1 = fetch_descriptor(&storage, &v1.snapshot_key, None);
    let d2 = fetch_descriptor(&storage, &v2.snapshot_key, None);
    assert_ne!(object_key_of(&d1, DB_PATH), object_key_of(&d2, DB_PATH));
    assert_ne!(
        object_key_of(&d1, MANIFEST_LOGICAL_PATH),
        object_key_of(&d2, MANIFEST_LOGICAL_PATH)
    );
    assert_eq!(
        object_key_of(&d1, ASSET_PATH),
        object_key_of(&d2, ASSET_PATH)
    );
    assert_eq!(
        object_key_of(&d1, CRYPTO_PATH),
        object_key_of(&d2, CRYPTO_PATH)
    );
}

// ============================================================================
// 4. 跨设备不复用：device B 必须上传自己的对象
// ============================================================================

#[tokio::test]
async fn r12_cross_device_never_reuses_other_devices_objects() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("staging");
    make_staging(&root, 1);

    let storage = Arc::new(MemoryStorage::new());
    let a = publish(&storage, &root, "device-a", None)
        .await
        .expect("device A publish");
    let b = publish(&storage, &root, "device-b", None)
        .await
        .expect("device B publish");

    // 同一 staging 字节相同，B 仍然全量上传，零复用。
    assert_eq!(b.uploaded_file_count, 4);
    assert_eq!(b.reused_file_count, 0);
    assert_eq!(b.newly_uploaded_size, b.logical_size);

    let da = fetch_descriptor(&storage, &a.snapshot_key, None);
    let db = fetch_descriptor(&storage, &b.snapshot_key, None);
    let a_keys: Vec<&str> = da.files.iter().map(|f| f.object_key.as_str()).collect();
    for file in &db.files {
        assert!(
            file.object_key.starts_with("backup-v2/objects/device-b/"),
            "B's objects live under B's namespace: {}",
            file.object_key
        );
        assert!(
            !a_keys.contains(&file.object_key.as_str()),
            "B must never reference A's object {}",
            file.object_key
        );
    }
    assert_eq!(storage.keys_with_prefix(BACKUP_V2_OBJECTS_PREFIX).len(), 8);
}

// ============================================================================
// 5. commit 顺序：index / descriptor PUT 失败只留孤儿
// ============================================================================

#[tokio::test]
async fn r12_index_put_failure_leaves_orphans_but_no_new_version() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("staging");
    make_staging(&root, 1);

    let storage = Arc::new(MemoryStorage::new());
    storage.fail_puts_under(BACKUP_V2_MANIFESTS_PREFIX);

    let error = publish(&storage, &root, "device-a", None)
        .await
        .expect_err("index PUT failure must fail the publish");
    assert!(
        error.to_string().contains("injected PUT failure"),
        "{error}"
    );

    // objects + descriptor 已写入（孤儿），index 不存在 → 版本不可见。
    assert_eq!(storage.keys_with_prefix(BACKUP_V2_OBJECTS_PREFIX).len(), 4);
    assert_eq!(
        storage.keys_with_prefix(BACKUP_V2_SNAPSHOTS_PREFIX).len(),
        1
    );
    assert!(
        storage.get_raw(&device_index_key("device-a")).is_none(),
        "commit point never happened"
    );
}

#[tokio::test]
async fn r12_descriptor_put_failure_leaves_objects_but_no_new_version() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("staging");
    make_staging(&root, 1);

    let storage = Arc::new(MemoryStorage::new());
    storage.fail_puts_under(BACKUP_V2_SNAPSHOTS_PREFIX);

    let error = publish(&storage, &root, "device-a", None)
        .await
        .expect_err("descriptor PUT failure must fail the publish");
    assert!(
        error.to_string().contains("injected PUT failure"),
        "{error}"
    );

    assert_eq!(storage.keys_with_prefix(BACKUP_V2_OBJECTS_PREFIX).len(), 4);
    assert!(storage
        .keys_with_prefix(BACKUP_V2_SNAPSHOTS_PREFIX)
        .is_empty());
    assert!(storage.get_raw(&device_index_key("device-a")).is_none());
}

// ============================================================================
// 6. 租约被占：E_BACKUP_LEASE_HELD 且 objects 零写入
// ============================================================================

#[tokio::test]
async fn r12_held_lease_blocks_publish_with_zero_object_writes() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("staging");
    make_staging(&root, 1);

    let storage = Arc::new(MemoryStorage::new());
    insert_active_lease(&storage, "other-device");

    let error = publish(&storage, &root, "device-a", None)
        .await
        .expect_err("held lease must reject the publish")
        .to_string();
    assert!(error.contains(BACKUP_LEASE_HELD_ERROR_CODE), "{error}");
    assert!(!error.contains("E_SYNC_LEASE_HELD"), "{error}");

    assert!(storage
        .keys_with_prefix(BACKUP_V2_OBJECTS_PREFIX)
        .is_empty());
    assert!(storage
        .keys_with_prefix(BACKUP_V2_SNAPSHOTS_PREFIX)
        .is_empty());
    assert!(storage
        .keys_with_prefix(BACKUP_V2_MANIFESTS_PREFIX)
        .is_empty());
}

// ============================================================================
// 7. 损坏 index / 损坏上一 descriptor：fail-closed，零新对象
// ============================================================================

#[tokio::test]
async fn r12_corrupted_index_or_descriptor_fails_closed_without_new_objects() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("staging");
    make_staging(&root, 1);

    let storage = Arc::new(MemoryStorage::new());
    let v1 = publish(&storage, &root, "device-a", None)
        .await
        .expect("v1 publish");
    let index_key = device_index_key("device-a");
    let good_index = storage.get_raw(&index_key).expect("index bytes");
    let good_descriptor = storage.get_raw(&v1.snapshot_key).expect("descriptor bytes");
    let objects_before = storage.keys_with_prefix(BACKUP_V2_OBJECTS_PREFIX).len();

    // 7a. 损坏 index：解析失败必须 fail-closed，零对象写入。
    storage.insert_raw(&index_key, b"{ definitely not a valid index".to_vec());
    let error = publish(&storage, &root, "device-a", None)
        .await
        .expect_err("corrupted index must fail closed");
    assert!(error.to_string().contains("fail-closed"), "{error}");
    assert_eq!(
        storage.keys_with_prefix(BACKUP_V2_OBJECTS_PREFIX).len(),
        objects_before,
        "zero new objects on corrupted index"
    );

    // 7b. index 恢复、损坏最新 descriptor：同样 fail-closed。
    storage.insert_raw(&index_key, good_index);
    storage.insert_raw(&v1.snapshot_key, b"garbage-descriptor-bytes".to_vec());
    let error = publish(&storage, &root, "device-a", None)
        .await
        .expect_err("corrupted previous descriptor must fail closed");
    assert!(error.to_string().contains("fail-closed"), "{error}");
    assert_eq!(
        storage.keys_with_prefix(BACKUP_V2_OBJECTS_PREFIX).len(),
        objects_before,
        "zero new objects on corrupted descriptor"
    );

    // 恢复 descriptor 后可正常继续发布（零变化 → 只传 manifest）。
    storage.insert_raw(&v1.snapshot_key, good_descriptor);
    let curr_root = dir.path().join("curr");
    copy_dir_recursive(&root, &curr_root);
    bump_manifest_volatile_fields(&curr_root);
    let v2 = publish(&storage, &curr_root, "device-a", None)
        .await
        .expect("publish resumes after repair");
    assert_eq!(v2.uploaded_file_count, 1);
}

// ============================================================================
// 8. E2EE：一次会话加密多个对象；明文哈希不进明文面
// ============================================================================

#[tokio::test]
async fn r12_e2ee_encrypts_objects_and_descriptor_with_one_session() {
    let dir = tempfile::tempdir().expect("tempdir");
    let prev_root = dir.path().join("prev");
    let curr_root = dir.path().join("curr");
    make_staging(&prev_root, 1);
    copy_dir_recursive(&prev_root, &curr_root);
    bump_manifest_volatile_fields(&curr_root);

    // 低成本 Argon2 参数只为测试提速；一次派生跨对象复用密钥。
    let session = FileCipherSession::with_params("test-password", 8, 1, 1).expect("session");

    let storage = Arc::new(MemoryStorage::new());
    let v1 = publish(&storage, &prev_root, "device-a", Some(&session))
        .await
        .expect("encrypted v1 publish");

    // 新对象、snapshot descriptor、仓库配置全部是 DSBK 密文。
    for key in storage.keys_with_prefix(BACKUP_V2_OBJECTS_PREFIX) {
        let bytes = storage.get_raw(&key).expect("object bytes");
        assert!(is_encrypted_backup(&bytes), "object {key} must be DSBK");
    }
    let snapshot_bytes = storage.get_raw(&v1.snapshot_key).expect("descriptor bytes");
    assert!(
        is_encrypted_backup(&snapshot_bytes),
        "descriptor must be DSBK"
    );
    let config_bytes = storage.get_raw(BACKUP_V2_CONFIG_KEY).expect("config bytes");
    assert!(is_encrypted_backup(&config_bytes), "config must be DSBK");

    // 明文哈希与逻辑路径绝不出现在 object key 或明文 index 里。
    let db_plain_sha = sha256_hex(&prev_root.join(DB_PATH));
    let index_bytes = storage
        .get_raw(&device_index_key("device-a"))
        .expect("index bytes");
    let index_text = String::from_utf8(index_bytes).expect("index is plaintext JSON");
    assert!(
        !index_text.contains(&db_plain_sha),
        "no plaintext hash in index"
    );
    assert!(!index_text.contains(DB_PATH), "no logical path in index");
    assert!(!index_text.contains("assets/"), "no logical path in index");
    for key in storage.keys_with_prefix(BACKUP_V2_OBJECTS_PREFIX) {
        assert!(
            !key.contains(&db_plain_sha),
            "content-addressed keys are forbidden"
        );
    }

    // descriptor 用同一会话可解密，文件表完整。
    let descriptor = fetch_descriptor(&storage, &v1.snapshot_key, Some(&session));
    assert_eq!(descriptor.files.len(), 4);
    for file in &descriptor.files {
        let stored = storage.get_raw(&file.object_key).expect("object stored");
        assert!(is_encrypted_backup(&stored));
        assert_eq!(file.object_cipher_sha256, sha256_hex_bytes(&stored));
        // 密文哈希必须区别于明文哈希（对象体确实被加密）。
        assert_ne!(file.object_cipher_sha256, file.plaintext_sha256);
    }

    // 零变化第二版：加密模式同样只重传 manifest.json，数据对象逐字节复用。
    let v2 = publish(&storage, &curr_root, "device-a", Some(&session))
        .await
        .expect("encrypted v2 publish");
    assert_eq!(v2.uploaded_file_count, 1);
    assert_eq!(v2.reused_file_count, 3);
    let d2 = fetch_descriptor(&storage, &v2.snapshot_key, Some(&session));
    for path in DATA_PATHS {
        assert_eq!(object_key_of(&descriptor, path), object_key_of(&d2, path));
    }
}

// ============================================================================
// 9. 源码锁：生产 Cloud backup 未接线（全绿不代表增量备份已实现）
// ============================================================================

fn collect_files_mentioning(root: &Path, needle: &str, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(root).expect("read src dir") {
        let entry = entry.expect("dir entry");
        let path = entry.path();
        if entry.file_type().expect("file type").is_dir() {
            collect_files_mentioning(&path, needle, out);
        } else if path.extension().is_some_and(|ext| ext == "rs")
            && fs::read_to_string(&path)
                .expect("read source file")
                .contains(needle)
        {
            out.push(path);
        }
    }
}

#[test]
fn r12_source_lock_delta_upload_has_zero_production_wiring() {
    // 生产 Cloud backup 仍是整 ZIP 单对象 put_file，零 backup-v2 引用。
    let sync_manager = include_str!("../src/cloud_storage/sync_manager.rs");
    assert!(
        sync_manager.contains(r#"format!("{}/{}.zip", BACKUPS_DIR, version_id)"#),
        "sync_manager.rs no longer builds the whole-ZIP remote key; \
         if delta upload landed, replace this lock with real integration tests"
    );
    assert!(
        sync_manager.contains(".put_file(&remote_key, zip_path, progress)"),
        "sync_manager.rs no longer PUTs the whole ZIP as one object"
    );
    assert!(!sync_manager.contains("delta_upload"));
    assert!(!sync_manager.contains("backup-v2/objects"));
    assert!(!sync_manager.contains("backup-v2/snapshots"));
    assert!(!sync_manager.contains("publish_verified_staging"));

    let src_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");

    // 生产代码（排除模块自身与 mod.rs 声明行）零 delta_upload 引用。
    let mut referencing_files = Vec::new();
    collect_files_mentioning(&src_root, "delta_upload", &mut referencing_files);
    referencing_files.sort();
    let names: Vec<String> = referencing_files
        .iter()
        .map(|p| {
            p.strip_prefix(&src_root)
                .expect("under src")
                .to_string_lossy()
                .replace('\\', "/")
        })
        .collect();
    assert_eq!(
        names,
        vec![
            "cloud_storage/delta_upload.rs".to_string(),
            "cloud_storage/mod.rs".to_string(),
        ],
        "delta_upload must have zero production callers"
    );

    // cloud_storage/mod.rs 只允许声明行本身（无 pub use、无命令层导出）。
    let cloud_mod = include_str!("../src/cloud_storage/mod.rs");
    let wiring = cloud_mod
        .lines()
        .filter(|line| line.contains("delta_upload"))
        .filter(|line| {
            let trimmed = line.trim_start();
            !trimmed.starts_with("//") && *line != "pub mod delta_upload;"
        })
        .count();
    assert_eq!(
        wiring, 0,
        "cloud_storage/mod.rs may only declare the delta_upload module"
    );

    // publish_verified_staging 在生产代码中零调用方（只在模块自身出现）。
    let mut publish_referencers = Vec::new();
    collect_files_mentioning(
        &src_root,
        "publish_verified_staging",
        &mut publish_referencers,
    );
    let publish_names: Vec<String> = publish_referencers
        .iter()
        .map(|p| {
            p.strip_prefix(&src_root)
                .expect("under src")
                .to_string_lossy()
                .replace('\\', "/")
        })
        .collect();
    assert_eq!(
        publish_names,
        vec!["cloud_storage/delta_upload.rs".to_string()],
        "publish_verified_staging must have zero production callers; \
         this suite being green does NOT mean incremental backup is implemented"
    );

    // 模块文档必须如实声明未接线状态。
    let module_src = include_str!("../src/cloud_storage/delta_upload.rs");
    assert!(
        module_src.contains("未接线"),
        "module docs must state it is unwired"
    );
    assert!(
        module_src.contains("不得**因本模块存在而宣称增量备份"),
        "module docs must forbid claiming incremental backup is implemented"
    );
}
