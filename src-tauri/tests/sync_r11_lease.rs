//! [R11-lease] 记录级 sync target 租约集成测试。
//!
//! 覆盖：
//! 1. 两设备同时看到空目录并写 contender 时仍只有一个赢家；
//! 2. 活跃租约返回稳定 `E_SYNC_LEASE_HELD` 与可操作指引；
//! 3. committed / 崩溃 pending 残锁在 TTL 后均可回收；
//! 4. LIST 截断时无法证明唯一性，必须 fail-closed；
//! 5. future remote format 在任何租约对象写入前拒绝，合法格式才进入租约状态机；
//! 6. zh/en `sync.errors.leaseHeld` 键形对齐。

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use deep_student_lib::cloud_storage::sync_lease::{
    acquire_sync_target_lease_with_ttl, SyncTargetLease, SYNC_LEASE_HELD_ERROR_CODE,
    SYNC_TARGET_LEASE_FORMAT_VERSION, SYNC_TARGET_LEASE_PREFIX,
};
use deep_student_lib::cloud_storage::{CloudStorage, FileInfo, ListOutcome};
use deep_student_lib::data_governance::sync::SyncManager;
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

    fn lease_keys(&self) -> Vec<String> {
        self.files
            .lock()
            .unwrap()
            .keys()
            .filter(|key| key.starts_with(SYNC_TARGET_LEASE_PREFIX))
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
) -> SyncTargetLease {
    SyncTargetLease {
        format_version: SYNC_TARGET_LEASE_FORMAT_VERSION,
        target: "data_governance".to_string(),
        holder_device_id: holder.to_string(),
        operation_id: operation_id.to_string(),
        created_at: created_at.to_rfc3339(),
        expires_at: expires_at.to_rfc3339(),
        activation_committed: committed,
    }
}

fn insert_lease(storage: &MemoryStorage, lease: &SyncTargetLease) -> String {
    let key = format!("{}/{}.json", SYNC_TARGET_LEASE_PREFIX, lease.operation_id);
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
        // 等待时，让后到方扫到已有 contender 后直接 E_SYNC_LEASE_HELD、永不 PUT，
        // 从而永久卡死 barrier。
        if prefix.starts_with(SYNC_TARGET_LEASE_PREFIX) {
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
        acquire_sync_target_lease_with_ttl(cloud(&storage), "device-a", ttl),
        acquire_sync_target_lease_with_ttl(cloud(&storage), "device-b", ttl),
    );

    assert_ne!(
        device_a.is_ok(),
        device_b.is_ok(),
        "双方同时看到空目录时也必须恰有一个租约赢家: A={device_a:?}, B={device_b:?}"
    );
    let loser_error = if let Err(error) = &device_a {
        error.to_string()
    } else {
        device_b.as_ref().unwrap_err().to_string()
    };
    assert!(
        loser_error.contains(SYNC_LEASE_HELD_ERROR_CODE),
        "败方必须返回稳定错误码: {loser_error}"
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
        storage.lease_keys().is_empty(),
        "赢家释放后不应残留 contender"
    );
}

#[tokio::test]
async fn live_lease_returns_stable_code_and_retry_guidance() {
    let storage = Arc::new(MemoryStorage::new());
    let holder =
        acquire_sync_target_lease_with_ttl(cloud(&storage), "device-a", Duration::from_secs(60))
            .await
            .unwrap();

    let error =
        acquire_sync_target_lease_with_ttl(cloud(&storage), "device-b", Duration::from_secs(60))
            .await
            .expect_err("活锁期间第二台设备必须被拒绝")
            .to_string();
    assert!(error.contains(SYNC_LEASE_HELD_ERROR_CODE), "{error}");
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

    let guard = acquire_sync_target_lease_with_ttl(
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
        acquire_sync_target_lease_with_ttl(cloud(&storage), "device-b", Duration::from_secs(60))
            .await
            .expect_err("pending 崩溃残锁在 TTL 内也必须 fail-closed");
    assert!(held.to_string().contains(SYNC_LEASE_HELD_ERROR_CODE));

    let expired_pending = lease_fixture(
        "crashed-mid-acquire",
        operation_id,
        Utc::now() - chrono::Duration::minutes(10),
        Utc::now() - chrono::Duration::seconds(1),
        false,
    );
    storage.insert_raw(&key, serde_json::to_vec(&expired_pending).unwrap());

    let recovered =
        acquire_sync_target_lease_with_ttl(cloud(&storage), "device-b", Duration::from_secs(60))
            .await
            .expect("pending 残锁过期后必须可自动恢复");
    recovered.release().await.unwrap();
}

#[tokio::test]
async fn truncated_lease_listing_fails_closed() {
    let storage = Arc::new(MemoryStorage::with_truncated_listing());
    let error =
        acquire_sync_target_lease_with_ttl(cloud(&storage), "device-a", Duration::from_secs(60))
            .await
            .expect_err("列表截断时不能证明没有竞争者")
            .to_string();
    assert!(
        error.contains("列表不完整") && error.contains("fail-closed"),
        "{error}"
    );
    assert!(storage.lease_keys().is_empty(), "截断时不得先写 contender");
}

#[tokio::test]
async fn remote_format_gate_rejects_future_version_before_lease_write() {
    let storage = Arc::new(MemoryStorage::new());
    storage.insert_raw(
        "data_governance/format.json",
        serde_json::to_vec(&serde_json::json!({
            "format_version": SyncManager::CURRENT_FORMAT_VERSION + 1,
            "min_client": SyncManager::CURRENT_FORMAT_VERSION + 1,
            "features": []
        }))
        .unwrap(),
    );
    let manager = SyncManager::new("device-a".to_string());
    let error = manager
        .validate_remote_format(storage.as_ref(), true)
        .await
        .expect_err("未来 remote format 必须拒绝")
        .to_string();
    assert!(error.contains("高于当前客户端"), "{error}");
    assert!(
        storage.lease_keys().is_empty(),
        "format 门槛失败必须保持零租约写入"
    );

    storage.insert_raw(
        "data_governance/format.json",
        serde_json::to_vec(&serde_json::json!({
            "format_version": SyncManager::CURRENT_FORMAT_VERSION,
            "min_client": SyncManager::MIN_COMPATIBLE_FORMAT_VERSION,
            "features": [],
            "checkpoint": null,
            "compatibility_lease": null
        }))
        .unwrap(),
    );
    manager
        .validate_remote_format(storage.as_ref(), false)
        .await
        .expect("合法 remote format 应通过");
    let guard =
        acquire_sync_target_lease_with_ttl(cloud(&storage), "device-a", Duration::from_secs(60))
            .await
            .expect("格式门槛通过后才能进入租约状态机");
    guard.release().await.unwrap();
}

#[test]
fn lease_held_locale_keys_are_aligned() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let zh: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("src/locales/zh-CN/sync.json")).unwrap())
            .unwrap();
    let en: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("src/locales/en-US/sync.json")).unwrap())
            .unwrap();
    for locale in [&zh, &en] {
        let message = locale["errors"]["leaseHeld"]
            .as_str()
            .expect("sync.errors.leaseHeld 必须存在");
        assert!(message.contains("retry") || message.contains("重试"));
    }
}
