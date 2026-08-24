//! [R12-delta-lease] backup-v2 / GC 独立仓库租约集成测试（内存假存储）。
//!
//! 注意：本轮**只**落地租约互斥原语本身；增量备份尚未接线到命令/UI。
//! `delta_upload` 积木可持有 backup-v2 租约；`sync_manager` / 记录级入口
//! 仍不得引用本模块（见源码锁测试）。
//!
//! 覆盖：
//! 1. 两设备同时看到空目录并写 contender 时仍只有一个赢家；
//! 2. 活跃租约返回稳定 `E_BACKUP_LEASE_HELD`（不复用 `E_SYNC_LEASE_HELD`）；
//! 3. 过期 committed 陈旧锁可回收；
//! 4. 崩溃留下的 pending 残锁在 TTL 内 fail-closed、过期后自动恢复；
//! 5. LIST 截断时无法证明唯一性，必须 fail-closed（零持锁、零写入）；
//! 6. 源码锁：记录级同步入口仍只用 sync_lease / `E_SYNC_LEASE_HELD`；
//!    除未接线的 `delta_upload` 外 backup_lease 零生产接线，namespace
//!    与 sync-target 完全隔离。

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use deep_student_lib::cloud_storage::backup_lease::{
    acquire_backup_repo_lease_with_ttl, BackupRepoLease, BACKUP_LEASE_HELD_ERROR_CODE,
    BACKUP_REPO_LEASE_FORMAT_VERSION, BACKUP_REPO_LEASE_PREFIX, DEFAULT_BACKUP_LEASE_TTL,
};
use deep_student_lib::cloud_storage::sync_lease::{
    SYNC_LEASE_HELD_ERROR_CODE, SYNC_TARGET_LEASE_PREFIX,
};
use deep_student_lib::cloud_storage::{CloudStorage, FileInfo, ListOutcome};
use deep_student_lib::models::AppError;

type CloudResult<T> = Result<T, AppError>;

struct MemoryStorage {
    files: Mutex<BTreeMap<String, (Vec<u8>, DateTime<Utc>)>>,
    pending_put_barrier: Option<Arc<tokio::sync::Barrier>>,
    truncate_listing: bool,
}

impl MemoryStorage {
    fn new() -> Self {
        Self {
            files: Mutex::new(BTreeMap::new()),
            pending_put_barrier: None,
            truncate_listing: false,
        }
    }

    fn with_pending_barrier(parties: usize) -> Self {
        Self {
            files: Mutex::new(BTreeMap::new()),
            pending_put_barrier: Some(Arc::new(tokio::sync::Barrier::new(parties))),
            truncate_listing: false,
        }
    }

    fn with_truncated_listing() -> Self {
        Self {
            files: Mutex::new(BTreeMap::new()),
            pending_put_barrier: None,
            truncate_listing: true,
        }
    }

    fn insert_raw(&self, key: &str, bytes: Vec<u8>) {
        self.files
            .lock()
            .unwrap()
            .insert(key.to_string(), (bytes, Utc::now()));
    }

    fn backup_lease_keys(&self) -> Vec<String> {
        self.files
            .lock()
            .unwrap()
            .keys()
            .filter(|key| key.starts_with(BACKUP_REPO_LEASE_PREFIX))
            .cloned()
            .collect()
    }

    fn keys_outside_backup_namespace(&self) -> Vec<String> {
        self.files
            .lock()
            .unwrap()
            .keys()
            .filter(|key| !key.starts_with(BACKUP_REPO_LEASE_PREFIX))
            .cloned()
            .collect()
    }
}

fn cloud(storage: &Arc<MemoryStorage>) -> Arc<dyn CloudStorage> {
    storage.clone()
}

fn lease_fixture(
    holder: &str,
    operation_id: &str,
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    committed: bool,
) -> BackupRepoLease {
    BackupRepoLease {
        format_version: BACKUP_REPO_LEASE_FORMAT_VERSION,
        target: "backup-v2".to_string(),
        holder_device_id: holder.to_string(),
        operation_id: operation_id.to_string(),
        created_at: created_at.to_rfc3339(),
        expires_at: expires_at.to_rfc3339(),
        activation_committed: committed,
    }
}

fn insert_lease(storage: &MemoryStorage, lease: &BackupRepoLease) -> String {
    let key = format!("{}{}.json", BACKUP_REPO_LEASE_PREFIX, lease.operation_id);
    storage.insert_raw(&key, serde_json::to_vec_pretty(lease).unwrap());
    key
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
        Ok(self
            .files
            .lock()
            .unwrap()
            .get(key)
            .map(|(bytes, _)| bytes.clone()))
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
        // 把栅栏放在「初次空 LIST」而不是 pending PUT：后者会在先写入的一方
        // 等待时，让后到方扫到已有 contender 后直接 E_BACKUP_LEASE_HELD、
        // 永不 PUT，从而永久卡死 barrier。
        if prefix.starts_with(BACKUP_REPO_LEASE_PREFIX) {
            let empty = self
                .files
                .lock()
                .unwrap()
                .keys()
                .all(|key| !key.starts_with(prefix));
            if empty {
                if let Some(barrier) = &self.pending_put_barrier {
                    barrier.wait().await;
                }
            }
        }
        Ok(ListOutcome {
            files: self.list(prefix).await?,
            truncated: self.truncate_listing,
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

#[tokio::test]
async fn concurrent_devices_elect_exactly_one_committed_holder() {
    let storage = Arc::new(MemoryStorage::with_pending_barrier(2));
    let ttl = Duration::from_secs(60);
    let (device_a, device_b) = tokio::join!(
        acquire_backup_repo_lease_with_ttl(cloud(&storage), "device-a", ttl),
        acquire_backup_repo_lease_with_ttl(cloud(&storage), "device-b", ttl),
    );

    assert_ne!(
        device_a.is_ok(),
        device_b.is_ok(),
        "双方同时看到空目录时也必须恰有一个备份租约赢家: A={device_a:?}, B={device_b:?}"
    );
    let loser_error = if let Err(error) = &device_a {
        error.to_string()
    } else {
        device_b.as_ref().unwrap_err().to_string()
    };
    assert!(
        loser_error.contains(BACKUP_LEASE_HELD_ERROR_CODE),
        "败方必须返回稳定错误码: {loser_error}"
    );
    assert!(
        !loser_error.contains(SYNC_LEASE_HELD_ERROR_CODE),
        "备份租约不得复用记录级同步错误码: {loser_error}"
    );

    // namespace 隔离：整个选主过程只写 backup-v2/locks/，绝不触碰 sync-target。
    assert!(
        storage.keys_outside_backup_namespace().is_empty(),
        "备份租约不得在 backup-v2/locks/ 之外写任何对象: {:?}",
        storage.keys_outside_backup_namespace()
    );

    if let Ok(guard) = device_a {
        assert!(guard.lease().activation_committed);
        guard.release().await.unwrap();
    }
    if let Ok(guard) = device_b {
        assert!(guard.lease().activation_committed);
        guard.release().await.unwrap();
    }
    assert!(
        storage.backup_lease_keys().is_empty(),
        "赢家释放后不应残留 contender"
    );
}

#[tokio::test]
async fn live_lease_returns_stable_backup_code_and_retry_guidance() {
    let storage = Arc::new(MemoryStorage::new());
    let holder =
        acquire_backup_repo_lease_with_ttl(cloud(&storage), "device-a", Duration::from_secs(60))
            .await
            .unwrap();

    let error =
        acquire_backup_repo_lease_with_ttl(cloud(&storage), "device-b", Duration::from_secs(60))
            .await
            .expect_err("活锁期间第二台设备必须被拒绝")
            .to_string();
    assert!(error.contains(BACKUP_LEASE_HELD_ERROR_CODE), "{error}");
    assert!(!error.contains(SYNC_LEASE_HELD_ERROR_CODE), "{error}");
    assert!(error.contains("等待") && error.contains("重试"), "{error}");

    holder.release().await.unwrap();
}

#[tokio::test]
async fn expired_committed_lease_is_reclaimed_before_acquire() {
    let storage = Arc::new(MemoryStorage::new());
    let stale = lease_fixture(
        "crashed-device",
        "10000000-0000-4000-8000-000000000001",
        Utc::now() - chrono::Duration::minutes(20),
        Utc::now() - chrono::Duration::minutes(10),
        true,
    );
    let stale_key = insert_lease(&storage, &stale);

    let guard = acquire_backup_repo_lease_with_ttl(
        cloud(&storage),
        "recovery-device",
        Duration::from_secs(60),
    )
    .await
    .expect("已过期 committed 租约应先回收再放行");
    assert!(!storage.files.lock().unwrap().contains_key(&stale_key));
    guard.release().await.unwrap();
}

#[tokio::test]
async fn crash_pending_residue_blocks_until_ttl_then_recovers() {
    let storage = Arc::new(MemoryStorage::new());
    let operation_id = "20000000-0000-4000-8000-000000000002";
    let live_pending = lease_fixture(
        "crashed-mid-acquire",
        operation_id,
        Utc::now(),
        Utc::now() + chrono::Duration::minutes(5),
        false,
    );
    let key = insert_lease(&storage, &live_pending);

    let held =
        acquire_backup_repo_lease_with_ttl(cloud(&storage), "device-b", Duration::from_secs(60))
            .await
            .expect_err("pending 崩溃残锁在 TTL 内也必须 fail-closed");
    assert!(held.to_string().contains(BACKUP_LEASE_HELD_ERROR_CODE));

    let expired_pending = lease_fixture(
        "crashed-mid-acquire",
        operation_id,
        Utc::now() - chrono::Duration::minutes(10),
        Utc::now() - chrono::Duration::seconds(1),
        false,
    );
    storage.insert_raw(&key, serde_json::to_vec(&expired_pending).unwrap());

    let recovered =
        acquire_backup_repo_lease_with_ttl(cloud(&storage), "device-b", Duration::from_secs(60))
            .await
            .expect("pending 残锁过期后必须可自动恢复");
    recovered.release().await.unwrap();
}

#[tokio::test]
async fn truncated_lease_listing_fails_closed_with_zero_locks() {
    let storage = Arc::new(MemoryStorage::with_truncated_listing());
    let error =
        acquire_backup_repo_lease_with_ttl(cloud(&storage), "device-a", Duration::from_secs(60))
            .await
            .expect_err("列表截断时不能证明没有竞争者")
            .to_string();
    assert!(
        error.contains("列表不完整") && error.contains("fail-closed"),
        "{error}"
    );
    assert!(
        storage.backup_lease_keys().is_empty(),
        "截断时不得先写 contender（零持锁）"
    );
    assert!(
        storage.files.lock().unwrap().is_empty(),
        "截断 fail-closed 必须零写入"
    );
}

#[test]
fn default_ttl_is_ten_minutes_and_namespaces_are_isolated() {
    assert_eq!(DEFAULT_BACKUP_LEASE_TTL, Duration::from_secs(10 * 60));
    assert!(BACKUP_REPO_LEASE_PREFIX.starts_with("backup-v2/locks/"));
    assert!(!BACKUP_REPO_LEASE_PREFIX.starts_with(SYNC_TARGET_LEASE_PREFIX));
    assert!(!SYNC_TARGET_LEASE_PREFIX.starts_with(BACKUP_REPO_LEASE_PREFIX));
    assert_ne!(BACKUP_LEASE_HELD_ERROR_CODE, SYNC_LEASE_HELD_ERROR_CODE);
}

/// 源码锁：backup_lease 必须保持零生产接线；记录级同步入口继续只用 sync_lease。
#[test]
fn source_lock_backup_lease_has_zero_production_wiring() {
    let src_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");

    fn rust_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                rust_files(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                out.push(path);
            }
        }
    }
    let mut files = Vec::new();
    rust_files(&src_root, &mut files);
    assert!(
        files.len() > 50,
        "生产源码遍历异常，仅找到 {} 个文件",
        files.len()
    );

    let mut backup_lease_referencers = Vec::new();
    for path in &files {
        let relative = path.strip_prefix(&src_root).unwrap().to_string_lossy();
        let content = std::fs::read_to_string(path).unwrap();

        if relative == "cloud_storage/backup_lease.rs" {
            // 只锁生产段：单元测试里允许出现 sync-target 字面量做「不得落入」断言。
            let production = content.split("#[cfg(test)]").next().unwrap_or(&content);
            assert!(production.contains("\"backup-v2/locks/\""), "{relative}");
            assert!(production.contains("E_BACKUP_LEASE_HELD"), "{relative}");
            assert!(
                !production.contains("\"data_governance/locks/sync-target\""),
                "backup_lease 不得写入 sync-target namespace: {relative}"
            );
            continue;
        }
        if relative == "cloud_storage/delta_upload.rs" {
            // 未接线的 upload 积木持有 backup-v2 租约；仍禁止引用 sync-target。
            assert!(
                content.contains("acquire_backup_repo_lease"),
                "delta_upload 必须在发布窗口持有 backup-v2 租约"
            );
            assert!(
                !content.contains("\"data_governance/locks/sync-target\""),
                "delta_upload 不得写入 sync-target namespace"
            );
            continue;
        }
        if relative == "cloud_storage/mod.rs" {
            // 唯一允许的生产引用点：模块声明本身。
            assert!(content.contains("pub mod backup_lease;"), "{relative}");
            let wiring = content
                .lines()
                .filter(|line| line.contains("backup_lease"))
                .filter(|line| {
                    !line.trim_start().starts_with("//") && !line.contains("pub mod backup_lease;")
                })
                .count();
            assert_eq!(
                wiring, 0,
                "cloud_storage/mod.rs 只允许声明 backup_lease 模块"
            );
            continue;
        }

        if content.contains("backup_lease")
            || content.contains("BACKUP_LEASE_HELD")
            || content.contains("acquire_backup_repo_lease")
        {
            backup_lease_referencers.push(relative.to_string());
        }
    }
    assert!(
        backup_lease_referencers.is_empty(),
        "backup_lease 必须零生产接线（增量备份尚未实现），却被引用于: {backup_lease_referencers:?}"
    );

    // 记录级同步入口仍然只使用 sync_lease / E_SYNC_LEASE_HELD。
    let commands_sync =
        std::fs::read_to_string(src_root.join("data_governance/commands_sync.rs")).unwrap();
    assert!(
        commands_sync.contains("sync_lease::acquire_sync_target_lease"),
        "记录级同步入口必须继续使用 sync_lease"
    );
    assert!(
        !commands_sync.contains("backup_lease"),
        "记录级同步入口不得引用 backup_lease"
    );
    let sync_lease_src =
        std::fs::read_to_string(src_root.join("cloud_storage/sync_lease.rs")).unwrap();
    assert!(
        sync_lease_src.contains("\"E_SYNC_LEASE_HELD\"")
            && sync_lease_src.contains("\"data_governance/locks/sync-target\""),
        "sync_lease 的错误码与 namespace 不得被本轮改动"
    );
}
