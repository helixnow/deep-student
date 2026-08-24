//! [R12-delta-gc] backup-v2 两遍 candidate/grace GC 原语集成测试（进程内假存储）。
//!
//! **本测试全绿不代表增量备份 / 增量 GC 已实现**：`delta_gc` 是未接线积木，
//! 生产 Cloud backup 仍是「全量 ZIP → 单对象 `put_file`」，没有任何命令 /
//! UI / `sync_manager` 路径调用 `collect_gc_candidates` / `sweep_gc_candidates`
//! （本文件的源码锁强制该事实）。
//!
//! 覆盖：
//! 1. 共享对象：index 裁掉旧版后，仍被新版引用的对象绝不回收；只被旧
//!    snapshot 引用的 descriptor / 对象按 grace 回收；
//! 2. 未发布孤儿：collect 登记 candidate（firstSeen 不刷新）；grace 未到
//!    sweep 不删；grace 过后 sweep 删除对象 + candidate；
//! 3. LIST 截断：collect 零 candidate、sweep 零删除（fail-closed）；
//! 4. 损坏 descriptor / 错密码：本轮零删除、零写 candidate；
//! 5. 租约被占：`E_BACKUP_LEASE_HELD`，零写入零删除；
//! 6. collect 后重新引用：sweep 不删对象，只去掉过时 candidate；
//! 7. 源码锁：生产 `sync_manager.rs` 仍整 ZIP 上传，`delta_gc` 零生产接线。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use deep_student_lib::cloud_storage::backup_lease::{
    BackupRepoLease, BACKUP_LEASE_HELD_ERROR_CODE, BACKUP_REPO_LEASE_FORMAT_VERSION,
    BACKUP_REPO_LEASE_PREFIX,
};
use deep_student_lib::cloud_storage::delta_format::SnapshotDescriptorV2;
use deep_student_lib::cloud_storage::delta_gc::{
    collect_gc_candidates, sweep_gc_candidates, GcCandidateV2, GcParams,
    BACKUP_V2_GC_CANDIDATES_PREFIX, DEFAULT_GC_GRACE, GC_CANDIDATE_FORMAT,
    GC_CANDIDATE_FORMAT_VERSION,
};
use deep_student_lib::cloud_storage::delta_upload::{
    device_index_key, publish_verified_staging, BackupV2DeviceIndex, PublishParams, PublishResult,
    BACKUP_V2_CONFIG_KEY, BACKUP_V2_MANIFESTS_PREFIX, BACKUP_V2_OBJECTS_PREFIX,
};
use deep_student_lib::cloud_storage::{CloudStorage, FileInfo, ListOutcome};
use deep_student_lib::crypto::backup_crypto::FileCipherSession;
use deep_student_lib::data_governance::backup::delta_inventory::MANIFEST_LOGICAL_PATH;
use deep_student_lib::data_governance::backup::{BackupFile, BackupManifest};
use deep_student_lib::models::AppError;
use sha2::{Digest, Sha256};

type CloudResult<T> = Result<T, AppError>;

const DB_PATH: &str = "study_law.db";
const ASSET_PATH: &str = "assets/images/图 01.png";
const CRYPTO_PATH: &str = "crypto/master.key";
const DATA_PATHS: [&str; 3] = [DB_PATH, ASSET_PATH, CRYPTO_PATH];

const GRACE: Duration = Duration::from_secs(60 * 60);

// ============================================================================
// 进程内假存储（BTreeMap；支持按前缀注入 LIST 截断）
// ============================================================================

struct MemoryStorage {
    files: Mutex<BTreeMap<String, (Vec<u8>, DateTime<Utc>)>>,
    truncate_prefixes: Mutex<Vec<String>>,
}

impl MemoryStorage {
    fn new() -> Self {
        Self {
            files: Mutex::new(BTreeMap::new()),
            truncate_prefixes: Mutex::new(Vec::new()),
        }
    }

    fn truncate_lists_under(&self, prefix: &str) {
        self.truncate_prefixes
            .lock()
            .unwrap()
            .push(prefix.to_string());
    }

    fn clear_truncations(&self) {
        self.truncate_prefixes.lock().unwrap().clear();
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

    /// 除 `backup-v2/locks/`（租约 contender 来去自由）以外的全部 key。
    fn data_keys(&self) -> Vec<String> {
        self.files
            .lock()
            .unwrap()
            .keys()
            .filter(|key| !key.starts_with(BACKUP_REPO_LEASE_PREFIX))
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
        let truncated = self
            .truncate_prefixes
            .lock()
            .unwrap()
            .iter()
            .any(|injected| injected == prefix);
        Ok(ListOutcome {
            files: self.list(prefix).await?,
            truncated,
        })
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
// 已验证 staging 构造与发布（对照 sync_r12_delta_upload.rs）
// ============================================================================

fn sha256_hex(path: &Path) -> String {
    format!(
        "{:x}",
        Sha256::digest(fs::read(path).expect("read file for hashing"))
    )
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

/// 造一个「两版共享对象」的仓库：v2 复用 v1 的三个数据对象，
/// 只有 manifest.json 与 snapshot descriptor 是 v2 独有。
async fn publish_two_versions(
    storage: &Arc<MemoryStorage>,
    dir: &Path,
    cipher: Option<&FileCipherSession>,
) -> (PublishResult, PublishResult) {
    let root = dir.join("staging");
    make_staging(&root, 3);
    let v1 = publish(storage, &root, "device-a", cipher)
        .await
        .expect("publish v1");
    let curr = dir.join("curr");
    copy_dir_recursive(&root, &curr);
    bump_manifest_volatile_fields(&curr);
    let v2 = publish(storage, &curr, "device-a", cipher)
        .await
        .expect("publish v2");
    assert_eq!(v2.reused_file_count, 3, "v2 must reuse the 3 data objects");
    (v1, v2)
}

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

/// 模拟 index 裁版：只保留 `keep_id`，latest 指向它（不动 snapshot/object）。
fn prune_index_to_single_version(storage: &MemoryStorage, device_id: &str, keep_id: &str) {
    let key = device_index_key(device_id);
    let mut index =
        BackupV2DeviceIndex::decode(&storage.get_raw(&key).expect("index bytes")).expect("decode");
    index.versions.retain(|entry| entry.id == keep_id);
    assert_eq!(index.versions.len(), 1, "kept version must exist");
    index.latest = Some(keep_id.to_string());
    storage.insert_raw(&key, index.encode().expect("encode pruned index"));
}

fn gc_params<'a>(
    now: DateTime<Utc>,
    grace: Duration,
    cipher: Option<&'a FileCipherSession>,
) -> GcParams<'a> {
    GcParams {
        holder_device_id: "gc-device",
        now,
        grace,
        cipher,
    }
}

fn candidate_bodies(storage: &MemoryStorage) -> Vec<GcCandidateV2> {
    storage
        .keys_with_prefix(BACKUP_V2_GC_CANDIDATES_PREFIX)
        .iter()
        .map(|key| GcCandidateV2::decode(&storage.get_raw(key).expect("candidate bytes")))
        .collect::<Result<Vec<_>, _>>()
        .expect("decode candidates")
}

fn cheap_session(password: &str) -> FileCipherSession {
    FileCipherSession::with_params(password, 8, 1, 1).expect("cipher session")
}

// ============================================================================
// 1. 共享对象：裁版后仍被引用的对象绝不回收；旧 snapshot 按 grace 回收
// ============================================================================

#[tokio::test]
async fn r12_gc_keeps_shared_objects_and_reclaims_pruned_snapshot_after_grace() {
    let dir = tempfile::tempdir().expect("tempdir");
    let storage = Arc::new(MemoryStorage::new());
    let (v1, v2) = publish_two_versions(&storage, dir.path(), None).await;

    // index 裁掉 v1（对象与 snapshot 都留在云端，正是 GC 的输入形态）。
    prune_index_to_single_version(&storage, "device-a", &v2.version_id);
    let v1_descriptor = fetch_descriptor(&storage, &v1.snapshot_key, None);
    let v2_descriptor = fetch_descriptor(&storage, &v2.snapshot_key, None);
    let shared_keys: Vec<&str> = v2_descriptor
        .files
        .iter()
        .filter(|file| {
            v1_descriptor
                .files
                .iter()
                .any(|old| old.object_key == file.object_key)
        })
        .map(|file| file.object_key.as_str())
        .collect();
    assert_eq!(shared_keys.len(), 3, "three data objects are shared");

    // collect：未引用 = v1 snapshot + v1 独有的 manifest.json 对象。
    let t0 = Utc::now();
    let collect = collect_gc_candidates(cloud(&storage), gc_params(t0, GRACE, None))
        .await
        .expect("collect");
    assert_eq!(collect.new_candidate_keys.len(), 2);
    assert_eq!(collect.retained_candidates, 0);
    assert!(collect.unreferenced_keys.contains(&v1.snapshot_key));
    for key in &shared_keys {
        assert!(
            !collect.unreferenced_keys.iter().any(|k| k == key),
            "shared object must never become a candidate: {key}"
        );
    }

    // sweep（grace 已过）：只删 v1 snapshot + v1 独有对象。
    let sweep = sweep_gc_candidates(
        cloud(&storage),
        gc_params(t0 + chrono::Duration::hours(2), GRACE, None),
    )
    .await
    .expect("sweep");
    assert_eq!(sweep.deleted_object_keys.len(), 2);
    assert!(sweep.deleted_object_keys.contains(&v1.snapshot_key));
    assert!(sweep.dropped_candidate_keys.is_empty());
    assert_eq!(sweep.pending_candidates, 0);

    // 共享对象、v2 snapshot、config、index 全部完好：可见版本绝不缺对象。
    for file in &v2_descriptor.files {
        assert!(
            storage.get_raw(&file.object_key).is_some(),
            "live object {} must survive GC",
            file.object_key
        );
    }
    assert!(storage.get_raw(&v2.snapshot_key).is_some());
    assert!(storage.get_raw(BACKUP_V2_CONFIG_KEY).is_some());
    assert!(storage.get_raw(&device_index_key("device-a")).is_some());
    assert!(
        storage.get_raw(&v1.snapshot_key).is_none(),
        "pruned snapshot reclaimed"
    );
    assert!(
        storage
            .keys_with_prefix(BACKUP_V2_GC_CANDIDATES_PREFIX)
            .is_empty(),
        "processed candidates are removed"
    );
}

// ============================================================================
// 2. 未发布孤儿：candidate → grace → 删除；firstSeen 不刷新
// ============================================================================

#[tokio::test]
async fn r12_gc_orphan_needs_grace_and_first_seen_is_not_refreshed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let storage = Arc::new(MemoryStorage::new());
    let root = dir.path().join("staging");
    make_staging(&root, 1);
    publish(&storage, &root, "device-a", None)
        .await
        .expect("v1");

    // 上传失败留下的未发布孤儿（index 从未引用）。
    let orphan_key =
        format!("{BACKUP_V2_OBJECTS_PREFIX}device-a/00000000-dead-4000-8000-000000000001.dsbk");
    storage.insert_raw(&orphan_key, b"orphan-bytes-from-failed-upload".to_vec());

    // collect：孤儿进 candidate（candidate ≠ 立即可删）。
    let t0 = Utc::now();
    let collect = collect_gc_candidates(cloud(&storage), gc_params(t0, GRACE, None))
        .await
        .expect("collect");
    assert_eq!(collect.new_candidate_keys.len(), 1);
    assert_eq!(collect.unreferenced_keys, vec![orphan_key.clone()]);
    let bodies = candidate_bodies(&storage);
    assert_eq!(bodies.len(), 1);
    assert_eq!(bodies[0].format, GC_CANDIDATE_FORMAT);
    assert_eq!(bodies[0].format_version, GC_CANDIDATE_FORMAT_VERSION);
    assert_eq!(bodies[0].object_key, orphan_key);
    assert_eq!(bodies[0].first_seen, t0.to_rfc3339());
    assert_eq!(bodies[0].sweep_generation, 1);

    // 再 collect（十分钟后）：不新增、不刷新 firstSeen。
    let recollect = collect_gc_candidates(
        cloud(&storage),
        gc_params(t0 + chrono::Duration::minutes(10), GRACE, None),
    )
    .await
    .expect("recollect");
    assert!(recollect.new_candidate_keys.is_empty());
    assert_eq!(recollect.retained_candidates, 1);
    let bodies = candidate_bodies(&storage);
    assert_eq!(
        bodies[0].first_seen,
        t0.to_rfc3339(),
        "firstSeen must not refresh"
    );

    // grace 未到：sweep 零删除。
    let early = sweep_gc_candidates(
        cloud(&storage),
        gc_params(t0 + chrono::Duration::minutes(30), GRACE, None),
    )
    .await
    .expect("early sweep");
    assert!(early.deleted_object_keys.is_empty());
    assert_eq!(early.pending_candidates, 1);
    assert!(storage.get_raw(&orphan_key).is_some());
    assert_eq!(
        storage
            .keys_with_prefix(BACKUP_V2_GC_CANDIDATES_PREFIX)
            .len(),
        1
    );

    // grace 已过：sweep 删除对象 + candidate。
    let late = sweep_gc_candidates(
        cloud(&storage),
        gc_params(t0 + chrono::Duration::hours(2), GRACE, None),
    )
    .await
    .expect("late sweep");
    assert_eq!(late.deleted_object_keys, vec![orphan_key.clone()]);
    assert_eq!(late.deleted_candidate_keys.len(), 1);
    assert!(storage.get_raw(&orphan_key).is_none());
    assert!(storage
        .keys_with_prefix(BACKUP_V2_GC_CANDIDATES_PREFIX)
        .is_empty());
}

// ============================================================================
// 3. LIST 截断：collect 零 candidate、sweep 零删除
// ============================================================================

#[tokio::test]
async fn r12_gc_truncated_listing_fails_closed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let storage = Arc::new(MemoryStorage::new());
    let root = dir.path().join("staging");
    make_staging(&root, 1);
    publish(&storage, &root, "device-a", None)
        .await
        .expect("v1");
    let orphan_key =
        format!("{BACKUP_V2_OBJECTS_PREFIX}device-a/00000000-dead-4000-8000-000000000002.dsbk");
    storage.insert_raw(&orphan_key, b"orphan".to_vec());
    let t0 = Utc::now();

    // 3a. manifests 截断：live set 不可信 → collect 零 candidate。
    storage.truncate_lists_under(BACKUP_V2_MANIFESTS_PREFIX);
    let error = collect_gc_candidates(cloud(&storage), gc_params(t0, GRACE, None))
        .await
        .expect_err("truncated manifests must fail collect");
    assert!(error.to_string().contains("fail-closed"), "{error}");
    assert!(storage
        .keys_with_prefix(BACKUP_V2_GC_CANDIDATES_PREFIX)
        .is_empty());

    // 3b. objects 截断：「未列出」不可与「未引用」混淆 → 同样零 candidate。
    storage.clear_truncations();
    storage.truncate_lists_under(BACKUP_V2_OBJECTS_PREFIX);
    let error = collect_gc_candidates(cloud(&storage), gc_params(t0, GRACE, None))
        .await
        .expect_err("truncated objects must fail collect");
    assert!(error.to_string().contains("fail-closed"), "{error}");
    assert!(storage
        .keys_with_prefix(BACKUP_V2_GC_CANDIDATES_PREFIX)
        .is_empty());

    // 正常 collect 一次，然后让 sweep 面对截断。
    storage.clear_truncations();
    collect_gc_candidates(cloud(&storage), gc_params(t0, GRACE, None))
        .await
        .expect("collect");
    let keys_before = storage.data_keys();

    // 3c. sweep 时 manifests 截断：零删除。
    storage.truncate_lists_under(BACKUP_V2_MANIFESTS_PREFIX);
    let error = sweep_gc_candidates(
        cloud(&storage),
        gc_params(t0 + chrono::Duration::hours(2), GRACE, None),
    )
    .await
    .expect_err("truncated manifests must fail sweep");
    assert!(error.to_string().contains("fail-closed"), "{error}");
    assert_eq!(storage.data_keys(), keys_before, "zero deletions");

    // 3d. sweep 时 candidates 截断：同样零删除。
    storage.clear_truncations();
    storage.truncate_lists_under(BACKUP_V2_GC_CANDIDATES_PREFIX);
    let error = sweep_gc_candidates(
        cloud(&storage),
        gc_params(t0 + chrono::Duration::hours(2), GRACE, None),
    )
    .await
    .expect_err("truncated candidates must fail sweep");
    assert!(error.to_string().contains("fail-closed"), "{error}");
    assert_eq!(storage.data_keys(), keys_before, "zero deletions");
}

// ============================================================================
// 4. 损坏 descriptor / 错密码：零删除、零写 candidate
// ============================================================================

#[tokio::test]
async fn r12_gc_corrupt_descriptor_means_zero_deletes_and_zero_candidates() {
    let dir = tempfile::tempdir().expect("tempdir");
    let storage = Arc::new(MemoryStorage::new());
    let root = dir.path().join("staging");
    make_staging(&root, 1);
    let v1 = publish(&storage, &root, "device-a", None)
        .await
        .expect("v1");
    let orphan_key =
        format!("{BACKUP_V2_OBJECTS_PREFIX}device-a/00000000-dead-4000-8000-000000000003.dsbk");
    storage.insert_raw(&orphan_key, b"orphan".to_vec());
    let t0 = Utc::now();
    collect_gc_candidates(cloud(&storage), gc_params(t0, GRACE, None))
        .await
        .expect("collect while repo is intact");
    let good_descriptor = storage.get_raw(&v1.snapshot_key).expect("descriptor bytes");
    let keys_before = storage.data_keys();

    // 损坏保留版本的 descriptor：collect 与 sweep 都必须整轮中止。
    storage.insert_raw(&v1.snapshot_key, b"garbage-descriptor-bytes".to_vec());
    let error = collect_gc_candidates(cloud(&storage), gc_params(t0, GRACE, None))
        .await
        .expect_err("corrupt descriptor must fail collect");
    assert!(error.to_string().contains("fail-closed"), "{error}");
    let error = sweep_gc_candidates(
        cloud(&storage),
        gc_params(t0 + chrono::Duration::hours(2), GRACE, None),
    )
    .await
    .expect_err("corrupt descriptor must fail sweep");
    assert!(error.to_string().contains("fail-closed"), "{error}");
    let mut after = storage.data_keys();
    let mut expected = keys_before.clone();
    after.sort();
    expected.sort();
    assert_eq!(after, expected, "zero deletions, zero new candidates");

    // 修复后 sweep 恢复工作。
    storage.insert_raw(&v1.snapshot_key, good_descriptor);
    let sweep = sweep_gc_candidates(
        cloud(&storage),
        gc_params(t0 + chrono::Duration::hours(2), GRACE, None),
    )
    .await
    .expect("sweep after repair");
    assert_eq!(sweep.deleted_object_keys, vec![orphan_key]);
}

#[tokio::test]
async fn r12_gc_wrong_password_or_policy_mismatch_means_zero_deletes() {
    let dir = tempfile::tempdir().expect("tempdir");
    let storage = Arc::new(MemoryStorage::new());
    let root = dir.path().join("staging");
    make_staging(&root, 1);
    let session_a = cheap_session("correct-password");
    publish(&storage, &root, "device-a", Some(&session_a))
        .await
        .expect("encrypted v1");
    let orphan_key =
        format!("{BACKUP_V2_OBJECTS_PREFIX}device-a/00000000-dead-4000-8000-000000000004.dsbk");
    storage.insert_raw(&orphan_key, b"orphan".to_vec());
    let t0 = Utc::now();
    collect_gc_candidates(cloud(&storage), gc_params(t0, GRACE, Some(&session_a)))
        .await
        .expect("collect with correct password");
    let keys_before = storage.data_keys();

    // 错密码：descriptor 解密失败 → 零删除。
    let session_b = cheap_session("wrong-password");
    let error = sweep_gc_candidates(
        cloud(&storage),
        gc_params(t0 + chrono::Duration::hours(2), GRACE, Some(&session_b)),
    )
    .await
    .expect_err("wrong password must fail sweep");
    assert!(error.to_string().contains("fail-closed"), "{error}");
    assert_eq!(storage.data_keys(), keys_before, "zero deletions");

    // 策略不一致（密文仓库 + 无会话）：同样 fail-closed。
    let error = sweep_gc_candidates(
        cloud(&storage),
        gc_params(t0 + chrono::Duration::hours(2), GRACE, None),
    )
    .await
    .expect_err("policy mismatch must fail sweep");
    assert!(error.to_string().contains("fail-closed"), "{error}");
    assert_eq!(storage.data_keys(), keys_before, "zero deletions");

    // 正确密码可正常回收孤儿。
    let sweep = sweep_gc_candidates(
        cloud(&storage),
        gc_params(t0 + chrono::Duration::hours(2), GRACE, Some(&session_a)),
    )
    .await
    .expect("sweep with correct password");
    assert_eq!(sweep.deleted_object_keys, vec![orphan_key]);
}

// ============================================================================
// 5. 租约被占：E_BACKUP_LEASE_HELD，零写入零删除
// ============================================================================

#[tokio::test]
async fn r12_gc_held_lease_blocks_both_passes_with_zero_writes() {
    let dir = tempfile::tempdir().expect("tempdir");
    let storage = Arc::new(MemoryStorage::new());
    let root = dir.path().join("staging");
    make_staging(&root, 1);
    publish(&storage, &root, "device-a", None)
        .await
        .expect("v1");
    let orphan_key =
        format!("{BACKUP_V2_OBJECTS_PREFIX}device-a/00000000-dead-4000-8000-000000000005.dsbk");
    storage.insert_raw(&orphan_key, b"orphan".to_vec());
    insert_active_lease(&storage, "other-device");
    let keys_before = storage.data_keys();
    let t0 = Utc::now();

    let error = collect_gc_candidates(cloud(&storage), gc_params(t0, GRACE, None))
        .await
        .expect_err("held lease must reject collect")
        .to_string();
    assert!(error.contains(BACKUP_LEASE_HELD_ERROR_CODE), "{error}");
    assert!(!error.contains("E_SYNC_LEASE_HELD"), "{error}");

    let error = sweep_gc_candidates(
        cloud(&storage),
        gc_params(t0 + chrono::Duration::hours(2), GRACE, None),
    )
    .await
    .expect_err("held lease must reject sweep")
    .to_string();
    assert!(error.contains(BACKUP_LEASE_HELD_ERROR_CODE), "{error}");

    assert_eq!(
        storage.data_keys(),
        keys_before,
        "zero writes, zero deletions"
    );
    assert!(storage
        .keys_with_prefix(BACKUP_V2_GC_CANDIDATES_PREFIX)
        .is_empty());
}

// ============================================================================
// 6. collect 后重新引用：sweep 不删对象，只去掉过时 candidate
// ============================================================================

#[tokio::test]
async fn r12_gc_rereferenced_candidate_is_dropped_without_deleting_object() {
    let dir = tempfile::tempdir().expect("tempdir");
    let storage = Arc::new(MemoryStorage::new());
    let (_v1, v2) = publish_two_versions(&storage, dir.path(), None).await;
    let index_key = device_index_key("device-a");
    let full_index = storage.get_raw(&index_key).expect("index with v1+v2");
    let v2_descriptor = fetch_descriptor(&storage, &v2.snapshot_key, None);

    // 先裁掉 v2 → v2 的 snapshot 与 v2 独有的 manifest 对象成为候选。
    let index = BackupV2DeviceIndex::decode(&full_index).expect("decode index");
    let v1_id = index
        .versions
        .iter()
        .map(|entry| entry.id.clone())
        .find(|id| *id != v2.version_id)
        .expect("v1 entry present");
    prune_index_to_single_version(&storage, "device-a", &v1_id);
    let t0 = Utc::now();
    let collect = collect_gc_candidates(cloud(&storage), gc_params(t0, GRACE, None))
        .await
        .expect("collect");
    assert_eq!(collect.new_candidate_keys.len(), 2);
    assert!(collect.unreferenced_keys.contains(&v2.snapshot_key));

    // collect 与 sweep 之间，v2 被重新发布/引用（恢复原 index）。
    storage.insert_raw(&index_key, full_index);

    // sweep（grace 已过）：绝不删被重新引用的对象，只移除过时 candidate。
    let sweep = sweep_gc_candidates(
        cloud(&storage),
        gc_params(t0 + chrono::Duration::hours(2), GRACE, None),
    )
    .await
    .expect("sweep");
    assert!(
        sweep.deleted_object_keys.is_empty(),
        "no object may be deleted"
    );
    assert_eq!(sweep.dropped_candidate_keys.len(), 2);
    assert!(storage.get_raw(&v2.snapshot_key).is_some());
    for file in &v2_descriptor.files {
        assert!(
            storage.get_raw(&file.object_key).is_some(),
            "re-referenced object {} must survive",
            file.object_key
        );
    }
    assert!(storage
        .keys_with_prefix(BACKUP_V2_GC_CANDIDATES_PREFIX)
        .is_empty());
}

// ============================================================================
// candidate schema：deny_unknown_fields / 越界 objectKey fail-closed
// ============================================================================

#[test]
fn r12_gc_candidate_codec_rejects_unknown_fields_and_out_of_scope_keys() {
    assert!(DEFAULT_GC_GRACE >= Duration::from_secs(60 * 60));

    let good = GcCandidateV2 {
        format: GC_CANDIDATE_FORMAT.to_string(),
        format_version: GC_CANDIDATE_FORMAT_VERSION,
        object_key: format!("{BACKUP_V2_OBJECTS_PREFIX}device-a/x.dsbk"),
        first_seen: Utc::now().to_rfc3339(),
        sweep_generation: 1,
    };
    let bytes = good.encode().expect("encode");
    assert_eq!(GcCandidateV2::decode(&bytes).expect("roundtrip"), good);

    // 未知字段 fail-closed。
    let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    value["surprise"] = serde_json::json!(true);
    assert!(GcCandidateV2::decode(&serde_json::to_vec(&value).unwrap()).is_err());

    // 未来版本 fail-closed。
    let future = GcCandidateV2 {
        format_version: 3,
        ..good.clone()
    };
    assert!(future.validate().is_err());

    // 可删范围之外的 key（config / v1 backups / manifests / 穿越）一律拒绝。
    for bad_key in [
        BACKUP_V2_CONFIG_KEY.to_string(),
        "backups/20250101-000000.zip".to_string(),
        format!("{BACKUP_V2_MANIFESTS_PREFIX}device-a.json"),
        format!("{BACKUP_V2_OBJECTS_PREFIX}device-a/../../config.dsbk"),
    ] {
        let bad = GcCandidateV2 {
            object_key: bad_key,
            ..good.clone()
        };
        assert!(bad.validate().is_err(), "must reject {:?}", bad.object_key);
    }
}

// ============================================================================
// 7. 源码锁：生产 Cloud backup 未接线（全绿不代表增量 GC 已实现）
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
fn r12_source_lock_delta_gc_has_zero_production_wiring() {
    // 生产 Cloud backup 仍是整 ZIP 单对象 put_file，零 backup-v2 GC 接线。
    let sync_manager = include_str!("../src/cloud_storage/sync_manager.rs");
    assert!(
        sync_manager.contains(r#"format!("{}/{}.zip", BACKUPS_DIR, version_id)"#),
        "sync_manager.rs no longer builds the whole-ZIP remote key; \
         if delta GC landed, replace this lock with real integration tests"
    );
    assert!(
        sync_manager.contains(".put_file(&remote_key, zip_path, progress)"),
        "sync_manager.rs no longer PUTs the whole ZIP as one object"
    );
    assert!(!sync_manager.contains("delta_gc"));
    assert!(!sync_manager.contains("collect_gc_candidates"));
    assert!(!sync_manager.contains("sweep_gc_candidates"));
    assert!(!sync_manager.contains("backup-v2/gc"));

    let src_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");

    // 生产代码（排除模块自身与 mod.rs 声明行）零 delta_gc 引用。
    let mut referencing_files = Vec::new();
    collect_files_mentioning(&src_root, "delta_gc", &mut referencing_files);
    assert_eq!(
        relative_names(&referencing_files, &src_root),
        vec![
            "cloud_storage/delta_gc.rs".to_string(),
            "cloud_storage/mod.rs".to_string(),
        ],
        "delta_gc must have zero production callers"
    );

    // cloud_storage/mod.rs 只允许声明行本身（无 pub use、无命令层导出）。
    let cloud_mod = include_str!("../src/cloud_storage/mod.rs");
    let wiring = cloud_mod
        .lines()
        .filter(|line| line.contains("delta_gc"))
        .filter(|line| {
            let trimmed = line.trim_start();
            !trimmed.starts_with("//") && *line != "pub mod delta_gc;"
        })
        .count();
    assert_eq!(
        wiring, 0,
        "cloud_storage/mod.rs may only declare the delta_gc module"
    );

    // 两个公开入口在生产代码中零调用方（只在模块自身出现）。
    for entry_point in ["collect_gc_candidates", "sweep_gc_candidates"] {
        let mut referencers = Vec::new();
        collect_files_mentioning(&src_root, entry_point, &mut referencers);
        assert_eq!(
            relative_names(&referencers, &src_root),
            vec!["cloud_storage/delta_gc.rs".to_string()],
            "{entry_point} must have zero production callers; this suite being \
             green does NOT mean incremental backup / GC is implemented"
        );
    }

    // 模块文档必须如实声明未接线状态与「宁留垃圾」原则。
    let module_src = include_str!("../src/cloud_storage/delta_gc.rs");
    assert!(
        module_src.contains("未接线"),
        "module docs must state it is unwired"
    );
    assert!(
        module_src.contains("宣称增量备份"),
        "module docs must forbid claiming incremental backup is implemented"
    );
    assert!(
        module_src.contains("宁留垃圾"),
        "module docs must state the leave-garbage-over-deleting-live principle"
    );
    assert!(!module_src.contains(".put_file("), "GC never uploads files");

    // 与既有兄弟源码锁保持一致：delta_gc.rs 本体不得出现这些字面子串
    // （它们的引用面由 sync_r12_delta_upload / sync_r12_backup_lease /
    // sync_r12_delta_restore / sync_r12_delta_inventory 按 *.rs 白名单锁定；
    // GC 的跨积木复用全部集中在 include! 片段里）。
    for needle in [
        "delta_upload",
        "publish_verified_staging",
        "backup_lease",
        "BACKUP_LEASE_HELD",
        "acquire_backup_repo_lease",
        "delta_inventory",
        "delta_restore",
        "restore_snapshot_to_staging",
    ] {
        assert!(
            !module_src.contains(needle),
            "delta_gc.rs must not mention {needle:?} directly; \
             upstream reuse lives only in delta_gc_upstream.rs.in"
        );
    }

    // include! 片段逐行钉死：只允许注释、空行与恰好这两组 re-export，
    // 防止片段本身沦为绕过各积木源码锁的生产接线通道。
    let fragment = include_str!("../src/cloud_storage/delta_gc_upstream.rs.in");
    let allowed_code_lines = [
        "pub(super) use crate::cloud_storage::backup_lease::acquire_backup_repo_lease as acquire_repo_lease;",
        "pub(super) use crate::cloud_storage::delta_upload::{",
        "    device_index_key, BackupV2DeviceIndex, BACKUP_V2_CONFIG_KEY, BACKUP_V2_MANIFESTS_PREFIX,",
        "    BACKUP_V2_OBJECTS_PREFIX, BACKUP_V2_SNAPSHOTS_PREFIX,",
        "};",
    ];
    let code_lines: Vec<&str> = fragment
        .lines()
        .filter(|line| !line.trim().is_empty() && !line.trim_start().starts_with("//"))
        .collect();
    assert_eq!(
        code_lines, allowed_code_lines,
        "delta_gc_upstream.rs.in may only re-export the lease + index/layout primitives"
    );

    // 全 src 只允许 delta_gc.rs 一处 include! 该片段。
    let mut fragment_referencers = Vec::new();
    collect_files_mentioning(
        &src_root,
        "delta_gc_upstream.rs.in",
        &mut fragment_referencers,
    );
    assert_eq!(
        relative_names(&fragment_referencers, &src_root),
        vec!["cloud_storage/delta_gc.rs".to_string()],
        "only delta_gc.rs may include the upstream re-export fragment"
    );
    assert_eq!(
        module_src
            .matches("include!(\"delta_gc_upstream.rs.in\")")
            .count(),
        1,
        "delta_gc.rs must include the fragment exactly once"
    );
}
