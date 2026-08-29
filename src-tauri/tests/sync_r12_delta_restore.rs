//! [R12-delta-restore] backup-v2 快照恢复原语集成测试（进程内假存储）。
//!
//! **本测试全绿不代表增量备份已实现**：`delta_restore` 是未接线积木，生产
//! Cloud restore 仍是「整 ZIP 单对象下载 → 现有导入 / A/B 槽」，没有任何
//! 命令 / UI / `sync_manager` 路径调用 `restore_snapshot_to_staging`
//! （本文件的源码锁强制该事实）。
//!
//! 覆盖：
//! 1. 明文往返：publish → restore，逐文件字节一致，清单交叉核对通过；
//! 2. 复用对象往返：第二版复用旧对象，restore 最新版仍正确物化；
//! 3. E2EE 往返：同会话成功；错密码 fail-closed 且 dest 为空；
//! 4. 缺对象：restore 失败，dest 无部分文件，错误可定位对象；
//! 5. 同大小换包：传输层哈希拦下，dest 为空；
//! 6. 损坏 descriptor / 损坏 index：fail-closed，dest 为空；
//! 7. 租约被占：`E_BACKUP_LEASE_HELD`，dest 为空且存储零新写入；
//! 8. 兼容 ZIP：验证通过后才写；任何失败不留半成品 ZIP；
//! 9. 源码锁：生产 `sync_manager.rs` 仍整 ZIP 路径，`delta_restore` 零生产接线。

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
use deep_student_lib::cloud_storage::delta_format::SnapshotDescriptorV2;
use deep_student_lib::cloud_storage::delta_restore::{
    restore_snapshot_to_staging, RestoreParams, RestoreResult,
};
use deep_student_lib::cloud_storage::delta_upload::{
    device_index_key, publish_verified_staging, PublishParams, PublishResult,
};
use deep_student_lib::cloud_storage::{CloudStorage, FileInfo, ListOutcome};
use deep_student_lib::crypto::backup_crypto::FileCipherSession;
use deep_student_lib::data_governance::backup::delta_inventory::{
    build_inventory_cross_checked, MANIFEST_LOGICAL_PATH,
};
use deep_student_lib::data_governance::backup::{BackupFile, BackupManifest};
use deep_student_lib::models::AppError;
use sha2::{Digest, Sha256};

type CloudResult<T> = Result<T, AppError>;

const DB_PATH: &str = "study_law.db";
const ASSET_PATH: &str = "assets/images/图 01.png";
const CRYPTO_PATH: &str = "crypto/master.key";
const DATA_PATHS: [&str; 3] = [DB_PATH, ASSET_PATH, CRYPTO_PATH];

// ============================================================================
// 进程内假存储（BTreeMap；与 sync_r12_delta_upload.rs 同类）
// ============================================================================

struct MemoryStorage {
    files: Mutex<BTreeMap<String, (Vec<u8>, DateTime<Utc>)>>,
}

impl MemoryStorage {
    fn new() -> Self {
        Self {
            files: Mutex::new(BTreeMap::new()),
        }
    }

    fn insert_raw(&self, key: &str, bytes: Vec<u8>) {
        self.files
            .lock()
            .unwrap()
            .insert(key.to_string(), (bytes, Utc::now()));
    }

    fn remove_raw(&self, key: &str) {
        self.files.lock().unwrap().remove(key);
    }

    fn get_raw(&self, key: &str) -> Option<Vec<u8>> {
        self.files
            .lock()
            .unwrap()
            .get(key)
            .map(|(bytes, _)| bytes.clone())
    }

    /// 全库快照（key → bytes），用于断言「存储零新写入」。
    fn dump(&self) -> BTreeMap<String, Vec<u8>> {
        self.files
            .lock()
            .unwrap()
            .iter()
            .map(|(key, (bytes, _))| (key.clone(), bytes.clone()))
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
// 已验证 staging 构造（对照 sync_r12_delta_upload.rs）
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

async fn restore(
    storage: &Arc<MemoryStorage>,
    dest: &Path,
    device_id: &str,
    version_id: Option<&str>,
    cipher: Option<&FileCipherSession>,
    write_compatible_zip: Option<&Path>,
) -> Result<RestoreResult, AppError> {
    restore_snapshot_to_staging(
        cloud(storage),
        dest,
        RestoreParams {
            device_id,
            version_id,
            cipher,
            write_compatible_zip,
        },
    )
    .await
}

/// 递归收集目录内全部文件的（相对 POSIX 路径 → 字节）。
fn collect_files(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for entry in fs::read_dir(dir).expect("read dir") {
            let entry = entry.expect("dir entry");
            let path = entry.path();
            if entry.file_type().expect("file type").is_dir() {
                walk(root, &path, out);
            } else {
                let relative = path
                    .strip_prefix(root)
                    .expect("under root")
                    .to_string_lossy()
                    .replace('\\', "/");
                out.insert(relative, fs::read(&path).expect("read file"));
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

/// dest 失败不变量：目录不存在，或存在但为空。
fn assert_dest_empty(dest: &Path) {
    match fs::read_dir(dest) {
        Ok(mut entries) => assert!(
            entries.next().is_none(),
            "dest must stay empty on failure: {}",
            dest.display()
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => panic!("cannot inspect dest {}: {error}", dest.display()),
    }
}

fn assert_roundtrip(source_root: &Path, dest: &Path) {
    let expected = collect_files(source_root);
    let actual = collect_files(dest);
    assert_eq!(
        expected.keys().collect::<Vec<_>>(),
        actual.keys().collect::<Vec<_>>(),
        "restored staging must contain exactly the source logical files"
    );
    for (path, bytes) in &expected {
        assert_eq!(
            actual.get(path).expect("restored file"),
            bytes,
            "restored bytes must match source for {path}"
        );
    }
    assert!(expected.contains_key(MANIFEST_LOGICAL_PATH));
    build_inventory_cross_checked(dest).expect("restored staging passes cross-checked inventory");
}

fn object_key_for(storage: &MemoryStorage, snapshot_key: &str, logical_path: &str) -> String {
    let bytes = storage.get_raw(snapshot_key).expect("descriptor stored");
    let descriptor = SnapshotDescriptorV2::decode(&bytes).expect("decode plaintext descriptor");
    descriptor
        .files
        .iter()
        .find(|file| file.logical_path == logical_path)
        .unwrap_or_else(|| panic!("descriptor missing {logical_path}"))
        .object_key
        .clone()
}

fn insert_active_lease(storage: &MemoryStorage, holder: &str) {
    let now = Utc::now();
    let lease = BackupRepoLease {
        format_version: BACKUP_REPO_LEASE_FORMAT_VERSION,
        target: "backup-v2".to_string(),
        holder_device_id: holder.to_string(),
        operation_id: "40000000-0000-4000-8000-000000000004".to_string(),
        created_at: now.to_rfc3339(),
        expires_at: (now + chrono::Duration::minutes(5)).to_rfc3339(),
        activation_committed: true,
    };
    let key = format!("{}{}.json", BACKUP_REPO_LEASE_PREFIX, lease.operation_id);
    storage.insert_raw(&key, serde_json::to_vec_pretty(&lease).unwrap());
}

// ============================================================================
// 1. 明文往返
// ============================================================================

#[tokio::test]
async fn r12_plaintext_roundtrip_restores_every_logical_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("staging");
    make_staging(&root, 1);

    let storage = Arc::new(MemoryStorage::new());
    let published = publish(&storage, &root, "device-a", None)
        .await
        .expect("publish");

    let dest = dir.path().join("restored");
    let result = restore(&storage, &dest, "device-a", None, None, None)
        .await
        .expect("restore latest");

    assert_eq!(result.version_id, published.version_id);
    assert_eq!(result.snapshot_key, published.snapshot_key);
    assert_eq!(result.logical_size, published.logical_size);
    assert_eq!(result.file_count, 4, "3 data files + manifest.json");
    assert_eq!(result.zip_path, None);
    assert_roundtrip(&root, &dest);

    // 显式 version_id 与 latest 等价。
    let dest_explicit = dir.path().join("restored-explicit");
    let explicit = restore(
        &storage,
        &dest_explicit,
        "device-a",
        Some(published.version_id.as_str()),
        None,
        None,
    )
    .await
    .expect("restore explicit version");
    assert_eq!(explicit.version_id, published.version_id);
    assert_roundtrip(&root, &dest_explicit);

    // 恢复是云端只读操作：除（已释放的）租约外，存储内容与发布后一致。
    let keys: Vec<String> = storage.dump().keys().cloned().collect();
    assert!(keys.iter().all(|key| !key.starts_with("backups/")));
    assert!(keys.iter().all(|key| !key.starts_with("manifests/")));
}

#[tokio::test]
async fn r12_blank_device_id_or_unknown_version_fails_closed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("staging");
    make_staging(&root, 1);
    let storage = Arc::new(MemoryStorage::new());
    publish(&storage, &root, "device-a", None)
        .await
        .expect("publish");

    let dest = dir.path().join("restored-blank");
    let error = restore(&storage, &dest, "   ", None, None, None)
        .await
        .expect_err("blank device id must fail closed");
    assert!(error.to_string().contains("设备 ID"), "{error}");
    assert_dest_empty(&dest);

    let dest = dir.path().join("restored-unknown");
    let error = restore(
        &storage,
        &dest,
        "device-a",
        Some("no-such-version"),
        None,
        None,
    )
    .await
    .expect_err("unknown version must fail closed");
    assert!(error.to_string().contains("no-such-version"), "{error}");
    assert_dest_empty(&dest);

    // 未发布过的设备：索引缺失 fail-closed。
    let dest = dir.path().join("restored-nodevice");
    let error = restore(&storage, &dest, "device-x", None, None, None)
        .await
        .expect_err("missing index must fail closed");
    assert!(error.to_string().contains("索引"), "{error}");
    assert_dest_empty(&dest);
}

// ============================================================================
// 2. 复用对象往返
// ============================================================================

#[tokio::test]
async fn r12_reused_object_version_restores_correctly() {
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
    assert_eq!(v2.reused_file_count, 3, "v2 reuses all data objects");

    // 最新版（复用对象为主）完整往返。
    let dest_latest = dir.path().join("restored-latest");
    let latest = restore(&storage, &dest_latest, "device-a", None, None, None)
        .await
        .expect("restore latest");
    assert_eq!(latest.version_id, v2.version_id);
    assert_roundtrip(&curr_root, &dest_latest);

    // 旧版本仍可按 version_id 恢复（descriptor 自包含，无 parent 链）。
    let dest_v1 = dir.path().join("restored-v1");
    let old = restore(
        &storage,
        &dest_v1,
        "device-a",
        Some(v1.version_id.as_str()),
        None,
        None,
    )
    .await
    .expect("restore v1");
    assert_eq!(old.version_id, v1.version_id);
    assert_roundtrip(&prev_root, &dest_v1);

    // 改一个文件后的第三版：复用 + 新对象混合仍正确物化。
    let third_root = dir.path().join("third");
    copy_dir_recursive(&curr_root, &third_root);
    fs::remove_file(third_root.join(DB_PATH)).expect("drop copied db");
    write_sqlite(&third_root, DB_PATH, 2);
    write_manifest(&third_root, &DATA_PATHS);
    let v3 = publish(&storage, &third_root, "device-a", None)
        .await
        .expect("v3 publish");
    assert_eq!(v3.reused_file_count, 2);
    let dest_v3 = dir.path().join("restored-v3");
    restore(&storage, &dest_v3, "device-a", None, None, None)
        .await
        .expect("restore v3");
    assert_roundtrip(&third_root, &dest_v3);
}

// ============================================================================
// 3. E2EE 往返 + 错密码 fail-closed
// ============================================================================

#[tokio::test]
async fn r12_e2ee_roundtrip_and_wrong_password_fails_closed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("staging");
    make_staging(&root, 1);

    let session = FileCipherSession::with_params("test-password", 8, 1, 1).expect("session");
    let storage = Arc::new(MemoryStorage::new());
    let published = publish(&storage, &root, "device-a", Some(&session))
        .await
        .expect("encrypted publish");

    // 同会话恢复成功且逐字节一致。
    let dest = dir.path().join("restored");
    let result = restore(&storage, &dest, "device-a", None, Some(&session), None)
        .await
        .expect("encrypted restore");
    assert_eq!(result.version_id, published.version_id);
    assert_roundtrip(&root, &dest);

    // 错密码：AEAD 解密失败，fail-closed 且 dest 为空。
    let wrong = FileCipherSession::with_params("wrong-password", 8, 1, 1).expect("session");
    let dest_wrong = dir.path().join("restored-wrong");
    let error = restore(&storage, &dest_wrong, "device-a", None, Some(&wrong), None)
        .await
        .expect_err("wrong password must fail closed");
    assert!(error.to_string().contains("fail-closed"), "{error}");
    assert_dest_empty(&dest_wrong);

    // 加密仓库 + 未提供会话：策略不一致 fail-closed，不得静默降级。
    let dest_plain = dir.path().join("restored-plain");
    let error = restore(&storage, &dest_plain, "device-a", None, None, None)
        .await
        .expect_err("missing cipher on encrypted repo must fail closed");
    assert!(error.to_string().contains("加密"), "{error}");
    assert_dest_empty(&dest_plain);
}

#[tokio::test]
async fn r12_cipher_on_plaintext_repo_fails_closed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("staging");
    make_staging(&root, 1);

    let storage = Arc::new(MemoryStorage::new());
    publish(&storage, &root, "device-a", None)
        .await
        .expect("plaintext publish");

    let session = FileCipherSession::with_params("test-password", 8, 1, 1).expect("session");
    let dest = dir.path().join("restored");
    let error = restore(&storage, &dest, "device-a", None, Some(&session), None)
        .await
        .expect_err("cipher on plaintext repo must fail closed");
    assert!(error.to_string().contains("不一致"), "{error}");
    assert_dest_empty(&dest);
}

// ============================================================================
// 4. 缺对象
// ============================================================================

#[tokio::test]
async fn r12_missing_object_fails_closed_with_empty_dest() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("staging");
    make_staging(&root, 1);

    let storage = Arc::new(MemoryStorage::new());
    let published = publish(&storage, &root, "device-a", None)
        .await
        .expect("publish");

    let missing_key = object_key_for(&storage, &published.snapshot_key, ASSET_PATH);
    storage.remove_raw(&missing_key);

    let dest = dir.path().join("restored");
    let error = restore(&storage, &dest, "device-a", None, None, None)
        .await
        .expect_err("missing object must fail the whole restore")
        .to_string();
    // 错误必须可定位：version_id + object_key + logical_path。
    assert!(error.contains(&published.version_id), "{error}");
    assert!(error.contains(&missing_key), "{error}");
    assert!(error.contains(ASSET_PATH), "{error}");
    assert_dest_empty(&dest);
}

// ============================================================================
// 5. 同大小换包：传输层哈希拦下
// ============================================================================

#[tokio::test]
async fn r12_same_size_swapped_object_fails_closed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("staging");
    make_staging(&root, 1);

    let storage = Arc::new(MemoryStorage::new());
    let published = publish(&storage, &root, "device-a", None)
        .await
        .expect("publish");

    let swapped_key = object_key_for(&storage, &published.snapshot_key, DB_PATH);
    let original = storage.get_raw(&swapped_key).expect("object bytes");
    let mut swapped = original.clone();
    for byte in &mut swapped {
        *byte ^= 0x5A;
    }
    assert_eq!(swapped.len(), original.len());
    assert_ne!(swapped, original);
    storage.insert_raw(&swapped_key, swapped);

    let dest = dir.path().join("restored");
    let error = restore(&storage, &dest, "device-a", None, None, None)
        .await
        .expect_err("same-size swapped object must be caught at the transport layer")
        .to_string();
    assert!(error.contains(&swapped_key), "{error}");
    assert!(error.contains("SHA-256"), "{error}");
    assert!(error.contains(&published.version_id), "{error}");
    assert_dest_empty(&dest);
}

// ============================================================================
// 6. 损坏 descriptor / 损坏 index
// ============================================================================

#[tokio::test]
async fn r12_corrupted_descriptor_or_index_fails_closed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("staging");
    make_staging(&root, 1);

    let storage = Arc::new(MemoryStorage::new());
    let published = publish(&storage, &root, "device-a", None)
        .await
        .expect("publish");
    let index_key = device_index_key("device-a");
    let good_index = storage.get_raw(&index_key).expect("index bytes");
    let good_descriptor = storage
        .get_raw(&published.snapshot_key)
        .expect("descriptor bytes");

    // 6a. 损坏 index：解析失败 fail-closed。
    storage.insert_raw(&index_key, b"{ definitely not a valid index".to_vec());
    let dest = dir.path().join("restored-badindex");
    let error = restore(&storage, &dest, "device-a", None, None, None)
        .await
        .expect_err("corrupted index must fail closed");
    assert!(error.to_string().contains("fail-closed"), "{error}");
    assert_dest_empty(&dest);

    // 6b. index 恢复、损坏 descriptor：大小/哈希核对拦下。
    storage.insert_raw(&index_key, good_index);
    storage.insert_raw(
        &published.snapshot_key,
        b"garbage-descriptor-bytes".to_vec(),
    );
    let dest = dir.path().join("restored-baddesc");
    let error = restore(&storage, &dest, "device-a", None, None, None)
        .await
        .expect_err("corrupted descriptor must fail closed");
    assert!(error.to_string().contains("fail-closed"), "{error}");
    assert_dest_empty(&dest);

    // 修复后可正常恢复。
    storage.insert_raw(&published.snapshot_key, good_descriptor);
    let dest = dir.path().join("restored-repaired");
    restore(&storage, &dest, "device-a", None, None, None)
        .await
        .expect("restore succeeds after repair");
    assert_roundtrip(&root, &dest);
}

// ============================================================================
// 7. 租约被占：E_BACKUP_LEASE_HELD，dest 为空且存储零新写入
// ============================================================================

#[tokio::test]
async fn r12_held_lease_blocks_restore_with_zero_storage_writes() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("staging");
    make_staging(&root, 1);

    let storage = Arc::new(MemoryStorage::new());
    publish(&storage, &root, "device-a", None)
        .await
        .expect("publish");
    insert_active_lease(&storage, "other-device");
    let before = storage.dump();

    let dest = dir.path().join("restored");
    let error = restore(&storage, &dest, "device-a", None, None, None)
        .await
        .expect_err("held lease must reject the restore")
        .to_string();
    assert!(error.contains(BACKUP_LEASE_HELD_ERROR_CODE), "{error}");
    assert!(!error.contains("E_SYNC_LEASE_HELD"), "{error}");

    // 零副作用：dest 为空，存储内容（含租约对象）逐字节不变。
    assert_dest_empty(&dest);
    assert_eq!(
        storage.dump(),
        before,
        "zero storage writes while lease is held"
    );
}

// ============================================================================
// 8. 兼容 ZIP
// ============================================================================

#[tokio::test]
async fn r12_compatible_zip_written_only_after_verification() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("staging");
    make_staging(&root, 1);

    let storage = Arc::new(MemoryStorage::new());
    publish(&storage, &root, "device-a", None)
        .await
        .expect("publish");

    let dest = dir.path().join("restored");
    let zip_target = dir.path().join("compatible.zip");
    let result = restore(&storage, &dest, "device-a", None, None, Some(&zip_target))
        .await
        .expect("restore with compatible zip");
    assert_eq!(result.zip_path.as_deref(), Some(zip_target.as_path()));
    assert_roundtrip(&root, &dest);

    // ZIP 含 manifest.json 与全部数据文件，字节与 staging 一致。
    let file = fs::File::open(&zip_target).expect("open zip");
    let mut archive = zip::ZipArchive::new(file).expect("valid zip");
    let names: Vec<String> = archive.file_names().map(str::to_string).collect();
    assert!(names.iter().any(|name| name == MANIFEST_LOGICAL_PATH));
    for path in DATA_PATHS {
        assert!(names.iter().any(|name| name == path), "zip missing {path}");
    }
    for path in DATA_PATHS.iter().chain([&MANIFEST_LOGICAL_PATH]) {
        let mut entry = archive.by_name(path).expect("zip entry");
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut entry, &mut bytes).expect("read entry");
        assert_eq!(
            bytes,
            fs::read(root.join(path)).expect("staging bytes"),
            "zip entry bytes must match staging for {path}"
        );
    }
}

#[tokio::test]
async fn r12_compatible_zip_failure_leaves_no_partial_zip() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("staging");
    make_staging(&root, 1);

    let storage = Arc::new(MemoryStorage::new());
    let published = publish(&storage, &root, "device-a", None)
        .await
        .expect("publish");

    // 8a. 中途失败（缺对象）：整个恢复失败，ZIP 目标不存在。
    let missing_key = object_key_for(&storage, &published.snapshot_key, DB_PATH);
    let original_object = storage.get_raw(&missing_key).expect("object bytes");
    storage.remove_raw(&missing_key);
    let dest = dir.path().join("restored-midfail");
    let zip_target = dir.path().join("midfail.zip");
    restore(&storage, &dest, "device-a", None, None, Some(&zip_target))
        .await
        .expect_err("missing object must fail the restore");
    assert!(
        !zip_target.exists(),
        "no partial ZIP on mid-restore failure"
    );
    assert_dest_empty(&dest);
    storage.insert_raw(&missing_key, original_object);

    // 8b. ZIP 目标已存在：fail-closed，原文件逐字节不变。
    let dest = dir.path().join("restored-clobber");
    let existing = dir.path().join("existing.zip");
    fs::write(&existing, b"pre-existing bytes").expect("write existing");
    let error = restore(&storage, &dest, "device-a", None, None, Some(&existing))
        .await
        .expect_err("existing zip target must fail closed");
    assert!(error.to_string().contains("已存在"), "{error}");
    assert_eq!(
        fs::read(&existing).expect("read existing"),
        b"pre-existing bytes"
    );
    assert_dest_empty(&dest);

    // 8c. ZIP 目标父目录不存在：提前 fail-closed，零半成品。
    let dest = dir.path().join("restored-noparent");
    let bad_target = dir.path().join("no-such-dir").join("out.zip");
    restore(&storage, &dest, "device-a", None, None, Some(&bad_target))
        .await
        .expect_err("unwritable zip target must fail closed");
    assert!(!bad_target.exists());
    assert_dest_empty(&dest);

    // 临时 ZIP 不残留在目标目录。
    for entry in fs::read_dir(dir.path()).expect("read dir") {
        let name = entry
            .expect("entry")
            .file_name()
            .to_string_lossy()
            .to_string();
        assert!(
            !name.starts_with(".delta-restore-zip-"),
            "temp zip must not survive: {name}"
        );
    }
}

// ============================================================================
// 9. 源码锁：生产 Cloud restore 未接线（全绿不代表增量备份已实现）
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

fn relative_names(paths: &[PathBuf], src_root: &Path) -> Vec<String> {
    let mut names: Vec<String> = paths
        .iter()
        .map(|p| {
            p.strip_prefix(src_root)
                .expect("under src")
                .to_string_lossy()
                .replace('\\', "/")
        })
        .collect();
    names.sort();
    names
}

#[test]
fn r12_source_lock_delta_restore_has_zero_production_wiring() {
    // 生产 Cloud backup/restore 仍是整 ZIP 单对象路径，零 backup-v2 恢复接线。
    let sync_manager = include_str!("../src/cloud_storage/sync_manager.rs");
    assert!(
        sync_manager.contains(r#"format!("{}/{}.zip", BACKUPS_DIR, version_id)"#),
        "sync_manager.rs no longer builds the whole-ZIP remote key; \
         if delta restore landed, replace this lock with real integration tests"
    );
    assert!(
        sync_manager.contains(".put_file(&remote_key, zip_path, progress)"),
        "sync_manager.rs no longer PUTs the whole ZIP as one object"
    );
    assert!(!sync_manager.contains("delta_restore"));
    assert!(!sync_manager.contains("restore_snapshot_to_staging"));
    assert!(!sync_manager.contains("publish_verified_staging"));
    assert!(!sync_manager.contains("backup-v2/objects"));
    assert!(!sync_manager.contains("backup-v2/snapshots"));

    let src_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");

    // 生产代码（排除模块自身与 mod.rs 声明行）零 delta_restore 引用。
    let mut referencing_files = Vec::new();
    collect_files_mentioning(&src_root, "delta_restore", &mut referencing_files);
    assert_eq!(
        relative_names(&referencing_files, &src_root),
        vec![
            "cloud_storage/delta_restore.rs".to_string(),
            "cloud_storage/mod.rs".to_string(),
        ],
        "delta_restore must have zero production callers"
    );

    // cloud_storage/mod.rs 只允许声明行本身（无 pub use、无命令层导出）。
    let cloud_mod = include_str!("../src/cloud_storage/mod.rs");
    let wiring = cloud_mod
        .lines()
        .filter(|line| line.contains("delta_restore"))
        .filter(|line| {
            let trimmed = line.trim_start();
            !trimmed.starts_with("//") && *line != "pub mod delta_restore;"
        })
        .count();
    assert_eq!(
        wiring, 0,
        "cloud_storage/mod.rs may only declare the delta_restore module"
    );

    // restore_snapshot_to_staging 在生产代码中零调用方（只在模块自身出现）。
    let mut restore_referencers = Vec::new();
    collect_files_mentioning(
        &src_root,
        "restore_snapshot_to_staging",
        &mut restore_referencers,
    );
    assert_eq!(
        relative_names(&restore_referencers, &src_root),
        vec!["cloud_storage/delta_restore.rs".to_string()],
        "restore_snapshot_to_staging must have zero production callers; \
         this suite being green does NOT mean incremental backup is implemented"
    );

    // 模块本身：云端只读（除租约），零 A/B 槽 / 用户数据目录写入。
    let module_src = include_str!("../src/cloud_storage/delta_restore.rs");
    assert!(
        module_src.contains("未接线"),
        "module docs must state it is unwired"
    );
    assert!(
        module_src.contains("宣称增量备份"),
        "module docs must forbid claiming incremental backup is implemented"
    );
    assert!(
        !module_src.contains("storage.put"),
        "restore never writes cloud objects"
    );
    assert!(
        !module_src.contains(".put_file("),
        "restore never uploads files"
    );
    assert!(
        !module_src.contains("storage.delete"),
        "restore never deletes cloud objects"
    );
    assert!(
        !module_src.contains("ds_data"),
        "restore never touches user data dirs"
    );
    assert!(
        !module_src.contains("data_space"),
        "restore never touches A/B slots"
    );
    assert!(
        !module_src.contains("zip_export"),
        "compatible ZIP is built with the zip crate; zip_export.rs stays untouched"
    );

    // 与既有兄弟源码锁保持一致：delta_restore.rs 本体不得出现这些字面子串
    // （它们的引用面由 sync_r12_delta_upload / sync_r12_backup_lease /
    // sync_r12_delta_inventory 按 *.rs 白名单锁定；restore 的跨积木复用
    // 全部集中在 include! 片段里）。
    for needle in [
        "delta_upload",
        "publish_verified_staging",
        "backup_lease",
        "BACKUP_LEASE_HELD",
        "acquire_backup_repo_lease",
        "delta_inventory",
    ] {
        assert!(
            !module_src.contains(needle),
            "delta_restore.rs must not mention {needle:?} directly; \
             upstream reuse lives only in delta_restore_upstream.rs.in"
        );
    }

    // include! 片段逐行钉死：只允许注释、空行与恰好这三组 re-export，
    // 防止片段本身沦为绕过各积木源码锁的生产接线通道。
    let fragment = include_str!("../src/cloud_storage/delta_restore_upstream.rs.in");
    let allowed_code_lines = [
        "pub(super) use crate::cloud_storage::backup_lease::acquire_backup_repo_lease as acquire_repo_lease;",
        "pub(super) use crate::cloud_storage::delta_upload::{",
        "    device_index_key, BackupV2DeviceIndex, BackupV2IndexEntry,",
        "};",
        "pub(super) use crate::data_governance::backup::delta_inventory::build_inventory_cross_checked;",
    ];
    let code_lines: Vec<&str> = fragment
        .lines()
        .filter(|line| !line.trim().is_empty() && !line.trim_start().starts_with("//"))
        .collect();
    assert_eq!(
        code_lines, allowed_code_lines,
        "delta_restore_upstream.rs.in may only re-export the three upstream primitives"
    );

    // 全 src 只允许 delta_restore.rs 一处 include! 该片段。
    let mut fragment_referencers = Vec::new();
    collect_files_mentioning(
        &src_root,
        "delta_restore_upstream.rs.in",
        &mut fragment_referencers,
    );
    assert_eq!(
        relative_names(&fragment_referencers, &src_root),
        vec!["cloud_storage/delta_restore.rs".to_string()],
        "only delta_restore.rs may include the upstream re-export fragment"
    );
    assert_eq!(
        module_src
            .matches("include!(\"delta_restore_upstream.rs.in\")")
            .count(),
        1,
        "delta_restore.rs must include the fragment exactly once"
    );
}
