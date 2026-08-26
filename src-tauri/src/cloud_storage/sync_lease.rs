//! 记录级同步的云端目标租约（R11-lease）。
//!
//! [`CloudStorage`] 只提供 dumb-storage 语义，没有 conditional PUT / compare-and-swap。
//! 因此租约不能安全地反复覆盖一个固定 key：两个设备都可能写入、回读自己的值，
//! 随后同时认为自己持锁。本模块采用 Joplin 风格的**独立 contender 对象**：
//!
//! 1. 清理 TTL 已过期的 contender，并在已有活跃 contender 时立即拒绝；
//! 2. 写入本次操作的 pending contender（`activation_committed = false`）；
//! 3. 完整列举 contender，以 `(created_at, operation_id)` 选出唯一赢家；
//! 4. 赢家把自己的对象推进到 committed，再完整列举一次确认所有权。
//!
//! 这复用了恢复换槽租约的两阶段字段形态（目标 / 操作 ID / `created_at` /
//! `activation_committed`），并增加 `expires_at`。正常退出会按 operation ID
//! 核对后删除；进程崩溃留下的 pending/committed 对象都会在 TTL 后回收。

use std::cmp::Ordering;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::traits::{CloudStorage, Result};
use crate::models::AppError;

/// 云端租约对象目录。每次操作使用独立 key，禁止改成单一覆盖文件。
pub const SYNC_TARGET_LEASE_PREFIX: &str = "data_governance/locks/sync-target";
/// 自动同步识别“租约被占”的稳定错误码。
pub const SYNC_LEASE_HELD_ERROR_CODE: &str = "E_SYNC_LEASE_HELD";
/// 默认 TTL：长同步由后台心跳续租；崩溃后最迟十分钟可自动恢复。
pub const DEFAULT_SYNC_LEASE_TTL: Duration = Duration::from_secs(10 * 60);
/// 租约格式版本。
pub const SYNC_TARGET_LEASE_FORMAT_VERSION: u32 = 1;
const SYNC_TARGET: &str = "data_governance";
const MIN_HEARTBEAT_INTERVAL: Duration = Duration::from_millis(250);

/// 云端同步目标租约。
///
/// 字段保持明文，因为其他设备必须在不知道 E2EE 密码时也能判断占用/过期；
/// 不包含 endpoint、凭据、记录内容等敏感信息。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SyncTargetLease {
    pub format_version: u32,
    pub target: String,
    pub holder_device_id: String,
    pub operation_id: String,
    pub created_at: String,
    pub expires_at: String,
    #[serde(default)]
    pub activation_committed: bool,
}

impl SyncTargetLease {
    fn new(holder_device_id: &str, ttl: Duration, now: DateTime<Utc>) -> Result<Self> {
        if holder_device_id.trim().is_empty() {
            return Err(AppError::validation("同步租约缺少设备 ID"));
        }
        let ttl = chrono::Duration::from_std(ttl)
            .map_err(|_| AppError::validation("同步租约 TTL 超出可表示范围"))?;
        if ttl <= chrono::Duration::zero() {
            return Err(AppError::validation("同步租约 TTL 必须大于零"));
        }
        Ok(Self {
            format_version: SYNC_TARGET_LEASE_FORMAT_VERSION,
            target: SYNC_TARGET.to_string(),
            holder_device_id: holder_device_id.trim().to_string(),
            operation_id: uuid::Uuid::new_v4().to_string(),
            created_at: now.to_rfc3339(),
            expires_at: (now + ttl).to_rfc3339(),
            activation_committed: false,
        })
    }

    fn key(&self) -> String {
        format!("{}/{}.json", SYNC_TARGET_LEASE_PREFIX, self.operation_id)
    }

    fn created_at(&self) -> Option<DateTime<Utc>> {
        DateTime::parse_from_rfc3339(&self.created_at)
            .ok()
            .map(|value| value.with_timezone(&Utc))
    }

    fn expires_at(&self) -> Option<DateTime<Utc>> {
        DateTime::parse_from_rfc3339(&self.expires_at)
            .ok()
            .map(|value| value.with_timezone(&Utc))
    }

    fn structurally_valid(&self) -> bool {
        self.format_version == SYNC_TARGET_LEASE_FORMAT_VERSION
            && self.target == SYNC_TARGET
            && !self.holder_device_id.trim().is_empty()
            && uuid::Uuid::parse_str(&self.operation_id).is_ok()
            && self.created_at().is_some()
            && self.expires_at().is_some()
    }
}

#[derive(Debug)]
struct ActiveLease {
    key: String,
    lease: Option<SyncTargetLease>,
    fallback_expires_at: DateTime<Utc>,
}

impl ActiveLease {
    fn holder_label(&self) -> &str {
        self.lease
            .as_ref()
            .map(|lease| lease.holder_device_id.as_str())
            .unwrap_or("未知设备（租约内容损坏）")
    }

    fn expires_label(&self) -> String {
        self.lease
            .as_ref()
            .and_then(SyncTargetLease::expires_at)
            .unwrap_or(self.fallback_expires_at)
            .to_rfc3339()
    }
}

fn lease_held_error(active: &ActiveLease) -> AppError {
    AppError::conflict(format!(
        "[{SYNC_LEASE_HELD_ERROR_CODE}] 同步目标租约被其他设备持有：{}（预计 {} 到期）。\
         请等待另一台设备完成同步，或等待租约过期后重试；不要手工覆盖云端同步文件。",
        active.holder_label(),
        active.expires_label()
    ))
}

fn compare_contenders(left: &ActiveLease, right: &ActiveLease) -> Ordering {
    match (&left.lease, &right.lease) {
        (Some(left), Some(right)) => left
            .created_at()
            .cmp(&right.created_at())
            .then_with(|| left.operation_id.cmp(&right.operation_id)),
        // 新鲜但损坏的租约必须 fail-closed，不能让合法 contender 绕过它。
        (None, Some(_)) => Ordering::Less,
        (Some(_), None) => Ordering::Greater,
        (None, None) => left.key.cmp(&right.key),
    }
}

async fn put_verified(
    storage: &dyn CloudStorage,
    key: &str,
    lease: &SyncTargetLease,
) -> Result<()> {
    let encoded = serde_json::to_vec_pretty(lease)
        .map_err(|error| AppError::internal(format!("序列化同步租约失败: {error}")))?;
    storage
        .put(key, &encoded)
        .await
        .map_err(|error| AppError::network(format!("写入同步租约失败: {error}")))?;
    let verified = storage
        .get(key)
        .await
        .map_err(|error| AppError::network(format!("回验同步租约失败: {error}")))?
        .ok_or_else(|| AppError::network("同步租约写入后不可见，已拒绝开始同步"))?;
    let verified: SyncTargetLease = serde_json::from_slice(&verified)
        .map_err(|error| AppError::network(format!("回验同步租约内容失败: {error}")))?;
    if verified != *lease {
        return Err(AppError::conflict(format!(
            "[{SYNC_LEASE_HELD_ERROR_CODE}] 同步租约在写入期间被其他客户端改动，\
             已拒绝开始同步；请稍后重试。"
        )));
    }
    Ok(())
}

async fn delete_if_unchanged(
    storage: &dyn CloudStorage,
    key: &str,
    expected: &[u8],
) -> Result<bool> {
    let current = storage
        .get(key)
        .await
        .map_err(|error| AppError::network(format!("回收同步租约前复核失败: {error}")))?;
    if current.as_deref() != Some(expected) {
        return Ok(false);
    }
    storage
        .delete(key)
        .await
        .map_err(|error| AppError::network(format!("回收过期同步租约失败: {error}")))?;
    Ok(true)
}

/// 列举活跃租约，并回收已过期对象。
///
/// 损坏对象没有可信 `expires_at`，退化为 provider 的 `last_modified + ttl`；
/// 在此窗口内按活跃租约 fail-closed，窗口外允许回收，避免永久锁死 sync target。
async fn scan_active_leases(
    storage: &dyn CloudStorage,
    ttl: Duration,
    now: DateTime<Utc>,
) -> Result<Vec<ActiveLease>> {
    let listing = storage
        .list_outcome(SYNC_TARGET_LEASE_PREFIX)
        .await
        .map_err(|error| AppError::network(format!("列举同步租约失败: {error}")))?;
    if listing.truncated {
        return Err(AppError::network(
            "同步租约列表不完整，无法证明当前没有其他持有者，已拒绝开始同步（fail-closed）",
        ));
    }

    let fallback_ttl = chrono::Duration::from_std(ttl)
        .map_err(|_| AppError::validation("同步租约 TTL 超出可表示范围"))?;
    let mut active = Vec::new();
    for file in listing.files {
        if !file.key.starts_with(SYNC_TARGET_LEASE_PREFIX) || !file.key.ends_with(".json") {
            continue;
        }
        let Some(bytes) = storage.get(&file.key).await.map_err(|error| {
            AppError::network(format!("读取同步租约失败 {}: {error}", file.key))
        })?
        else {
            // 列举与读取之间由持有者正常释放。
            continue;
        };
        let parsed = serde_json::from_slice::<SyncTargetLease>(&bytes)
            .ok()
            .filter(SyncTargetLease::structurally_valid);
        let fallback_expires_at = file.last_modified + fallback_ttl;
        let expires_at = parsed
            .as_ref()
            .and_then(SyncTargetLease::expires_at)
            .unwrap_or(fallback_expires_at);
        if expires_at <= now {
            // 缩窄与心跳续租的竞争窗：只有对象内容仍与刚读取的一致才删除。
            if delete_if_unchanged(storage, &file.key, &bytes).await? {
                continue;
            }
            // 读取与删除之间内容已变：典型为持有者的心跳续租恰好落地（或本地
            // 时钟偏慢）。无法证明对方已放弃，按活跃租约 fail-closed 参与选主。
        }
        active.push(ActiveLease {
            key: file.key,
            lease: parsed,
            fallback_expires_at,
        });
    }
    active.sort_by(compare_contenders);
    Ok(active)
}

async fn release_owned_candidate(
    storage: &dyn CloudStorage,
    key: &str,
    operation_id: &str,
) -> Result<bool> {
    let Some(bytes) = storage
        .get(key)
        .await
        .map_err(|error| AppError::network(format!("释放同步租约前读取失败: {error}")))?
    else {
        return Ok(false);
    };
    let lease: SyncTargetLease = serde_json::from_slice(&bytes)
        .map_err(|error| AppError::network(format!("释放同步租约前解析失败: {error}")))?;
    if lease.operation_id != operation_id {
        return Err(AppError::conflict(
            "同步租约所有权已变化，拒绝删除不属于本次操作的租约",
        ));
    }
    storage
        .delete(key)
        .await
        .map_err(|error| AppError::network(format!("释放同步租约失败: {error}")))?;
    Ok(true)
}

async fn renew_owned_candidate(
    storage: &dyn CloudStorage,
    key: &str,
    operation_id: &str,
    ttl: Duration,
) -> Result<()> {
    let Some(bytes) = storage
        .get(key)
        .await
        .map_err(|error| AppError::network(format!("续租前读取同步租约失败: {error}")))?
    else {
        return Err(AppError::conflict("同步租约在操作完成前消失"));
    };
    let mut lease: SyncTargetLease = serde_json::from_slice(&bytes)
        .map_err(|error| AppError::conflict(format!("同步租约在持有期间损坏: {error}")))?;
    if lease.operation_id != operation_id || !lease.activation_committed {
        return Err(AppError::conflict("同步租约所有权在持有期间变化"));
    }
    let ttl = chrono::Duration::from_std(ttl)
        .map_err(|_| AppError::validation("同步租约 TTL 超出可表示范围"))?;
    lease.expires_at = (Utc::now() + ttl).to_rfc3339();
    put_verified(storage, key, &lease).await
}

/// 已提交的同步租约守卫。
///
/// 显式 [`Self::release`] 会等待删除完成；异常 `?`/提前返回时 `Drop` 会停止心跳
/// 并在当前 Tokio runtime 中尽力异步删除。进程崩溃时由 TTL 兜底。
pub struct SyncTargetLeaseGuard {
    storage: Arc<dyn CloudStorage>,
    lease: SyncTargetLease,
    key: String,
    cancel: CancellationToken,
    heartbeat: Option<JoinHandle<()>>,
    released: bool,
}

impl std::fmt::Debug for SyncTargetLeaseGuard {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SyncTargetLeaseGuard")
            .field("lease", &self.lease)
            .field("key", &self.key)
            .field("released", &self.released)
            .finish()
    }
}

impl SyncTargetLeaseGuard {
    pub fn lease(&self) -> &SyncTargetLease {
        &self.lease
    }

    /// 显式释放；仅删除 operation ID 与本守卫一致的对象。
    pub async fn release(mut self) -> Result<()> {
        self.cancel.cancel();
        if let Some(heartbeat) = self.heartbeat.take() {
            heartbeat.abort();
            let _ = heartbeat.await;
        }
        release_owned_candidate(self.storage.as_ref(), &self.key, &self.lease.operation_id).await?;
        self.released = true;
        Ok(())
    }
}

impl Drop for SyncTargetLeaseGuard {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        self.cancel.cancel();
        if let Some(heartbeat) = self.heartbeat.take() {
            heartbeat.abort();
        }
        let storage = Arc::clone(&self.storage);
        let key = self.key.clone();
        let operation_id = self.lease.operation_id.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                if let Err(error) =
                    release_owned_candidate(storage.as_ref(), &key, &operation_id).await
                {
                    tracing::warn!(
                        "[sync-lease] 异常退出后释放租约失败，将等待 TTL 回收: {}",
                        error
                    );
                }
            });
        }
    }
}

/// 使用默认 TTL 获取同步目标租约。
pub async fn acquire_sync_target_lease(
    storage: Arc<dyn CloudStorage>,
    holder_device_id: &str,
) -> Result<SyncTargetLeaseGuard> {
    acquire_sync_target_lease_with_ttl(storage, holder_device_id, DEFAULT_SYNC_LEASE_TTL).await
}

/// 使用指定 TTL 获取同步目标租约（生产通常使用默认值；短 TTL 供协议测试）。
pub async fn acquire_sync_target_lease_with_ttl(
    storage: Arc<dyn CloudStorage>,
    holder_device_id: &str,
    ttl: Duration,
) -> Result<SyncTargetLeaseGuard> {
    let now = Utc::now();
    let mut active = scan_active_leases(storage.as_ref(), ttl, now).await?;
    if let Some(existing) = active.first() {
        return Err(lease_held_error(existing));
    }

    let mut lease = SyncTargetLease::new(holder_device_id, ttl, now)?;
    let key = lease.key();
    put_verified(storage.as_ref(), &key, &lease).await?;

    // 并发设备可能都在初次扫描时看见空目录；写入各自 contender 后统一选主。
    active = scan_active_leases(storage.as_ref(), ttl, Utc::now()).await?;
    let Some(winner) = active.first() else {
        return Err(AppError::network(
            "同步租约 contender 写入后不可见，已拒绝开始同步",
        ));
    };
    let winner_is_self = winner
        .lease
        .as_ref()
        .is_some_and(|candidate| candidate.operation_id == lease.operation_id);
    if !winner_is_self {
        let held = lease_held_error(winner);
        let _ = release_owned_candidate(storage.as_ref(), &key, &lease.operation_id).await;
        return Err(held);
    }

    // 两阶段提交：只有确定性赢家能把 pending 推进到 committed。
    lease.activation_committed = true;
    put_verified(storage.as_ref(), &key, &lease).await?;
    active = scan_active_leases(storage.as_ref(), ttl, Utc::now()).await?;
    let committed_is_self = active.first().is_some_and(|winner| {
        winner.lease.as_ref().is_some_and(|candidate| {
            candidate.operation_id == lease.operation_id && candidate.activation_committed
        })
    });
    if !committed_is_self {
        let held = active.first().map(lease_held_error).unwrap_or_else(|| {
            AppError::conflict(format!(
                "[{SYNC_LEASE_HELD_ERROR_CODE}] 同步租约提交后所有权无法确认，请稍后重试。"
            ))
        });
        let _ = release_owned_candidate(storage.as_ref(), &key, &lease.operation_id).await;
        return Err(held);
    }

    let cancel = CancellationToken::new();
    let heartbeat_cancel = cancel.clone();
    let heartbeat_storage = Arc::clone(&storage);
    let heartbeat_key = key.clone();
    let heartbeat_operation_id = lease.operation_id.clone();
    let heartbeat_interval = (ttl / 3).max(MIN_HEARTBEAT_INTERVAL);
    let heartbeat = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = heartbeat_cancel.cancelled() => break,
                _ = tokio::time::sleep(heartbeat_interval) => {
                    if let Err(error) = renew_owned_candidate(
                        heartbeat_storage.as_ref(),
                        &heartbeat_key,
                        &heartbeat_operation_id,
                        ttl,
                    ).await {
                        tracing::error!(
                            "[sync-lease] 心跳续租失败；本轮后续远端写入应尽快结束: {}",
                            error
                        );
                        break;
                    }
                }
            }
        }
    });

    Ok(SyncTargetLeaseGuard {
        storage,
        lease,
        key,
        cancel,
        heartbeat: Some(heartbeat),
        released: false,
    })
}
