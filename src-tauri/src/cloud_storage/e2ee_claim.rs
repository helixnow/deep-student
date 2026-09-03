//! [R4-e2ee-cas] `.encryption-marker` 认领协议：首次认领 / v1→v2 升级的跨设备互斥。
//!
//! ## 问题
//!
//! [`CloudStorage`] 是 dumb-storage 语义：没有 conditional PUT / If-None-Match /
//! generation CAS（见 `verified_publish.rs` / `sync_lease.rs` 开头的说明）。
//! 「读 marker → 盲 PUT marker」在两台设备并发首次认领（或并发 v1 升级）同一
//! 云 root 时是经典 lost-update：双方都回读到自己刚写入的字节、双双报成功，
//! 后写者静默覆盖先写者的密码校验子，先写者从此被"自己认领成功"的密码锁在
//! 门外，且没有任何一步告诉过它认领已被覆盖。
//!
//! ## 方案
//!
//! 1. **能力探测**：后端显式声明支持条件写（[`CloudStorage::supports_conditional_put`]，
//!    默认 `false`——多数现网 WebDAV/FTP 网关会**静默忽略**条件头、把条件写当
//!    无条件覆盖执行，这无法在运行时可靠探测，只能由后端实现经真实服务器验证
//!    后显式声明）时，首次认领用 [`CloudStorage::put_if_absent`] 原子创建；
//!    v1→v2 升级是"内容替换"，需要 If-Match 级 CAS，能力探测暂不覆盖，统一走
//!    租约方案。
//! 2. **默认（租约对象方案）**：固定键 `.encryption-marker.lease` 的单键租约
//!    （内容 `{device_id, nonce, created_at, expires_at}`，TTL 默认 60s）加
//!    双寄存器交叉确认，结构上等价于 Lamport fast-mutex 的 x/y 寄存器协议
//!    （lease = x，marker = y）：
//!
//!    ```text
//!    1. 有界读 marker，必须与期望一致（Absent / 同一 v1）      —— 快照
//!    2. 有界读 lease：活跃他人租约 → 失败；过期 → 内容比对后回收
//!    3. PUT 本设备 lease                                        —— 写 x
//!    4. GET lease 必须逐字节是自己                              —— 读 x
//!    5. GET marker 必须与第 1 步快照逐字节一致                  —— 读 y（Lamport「y 为空」检查）
//!    6. PUT marker；GET 回读必须逐字节一致                      —— 写 y
//!    7. GET lease 必须仍逐字节是自己                            —— 读 x（Lamport「x 仍是我」检查）
//!    8. 尽力删除本设备 lease（内容比对后删除；失败由 TTL 兜底）
//!    ```
//!
//!    互斥论证（假设对象存储对单 key 的读写可线性化）：若 A、B 都成功，不妨设
//!    A 的 lease 写入（第 3 步）在 B 之前。A 第 7 步读到自己的 lease，说明 B 的
//!    第 3 步发生在 A 第 7 步之后；而 B 的第 5 步（marker 复核）在 B 的第 3 步
//!    之后、即在 A 第 6 步（marker 已发布且无人删除）之后，必然读到 A 的 marker
//!    而与 B 的快照不符 → B 失败，矛盾。∎ 两边同时失败是允许的（fail-closed，
//!    可重试）；**至多一方成功**。
//!
//!    第 7 步失败时**不回滚已写入的 marker**：此时留下的 marker 是携带真实
//!    校验子（或合法 v1 内容）的完整认领对象，删除它反而会重新打开明文上传 /
//!    换口令窗口。本设备按失败返回；重试会按已有 marker 走校验子验证（自己的
//!    密码自然通过）。
//! 3. **发布前复验**：认领 / 校验成功只覆盖到「上传开始前」。大对象上传期间
//!    marker 仍可能被并发改动，`CloudSyncManager` 在发布 manifest 之前用认领 /
//!    校验时记下的原始字节再复验一次
//!    （`CloudSyncManager::ensure_marker_unchanged_before_publish`），不一致即
//!    回滚已上传对象、拒绝发布。这把「双方都短暂拿到认领成功」的残余窗口
//!    （只可能出现在协议之外的盲写者身上）也挡在 `backups/` 发布之前。

use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::traits::{CloudStorage, Result};
use super::EncryptionMarker;
use crate::models::AppError;

/// 认领租约键后缀：租约对象为 `<marker_key>.lease`（即 `.encryption-marker.lease`）。
pub const ENCRYPTION_MARKER_LEASE_SUFFIX: &str = ".lease";
/// 认领租约默认 TTL。认领本身只有几个小对象往返（试解密等重操作都在取租约
/// 之前完成），60s 足够；崩溃残留最迟 60s 后可被其他设备回收。
pub const DEFAULT_E2EE_CLAIM_LEASE_TTL: Duration = Duration::from_secs(60);
/// 认领租约格式版本。
pub const E2EE_CLAIM_LEASE_FORMAT_VERSION: u32 = 1;
/// 认领冲突（他人租约在持 / 标记已被并发创建或改动）的稳定错误码。
pub const SYNC_E2EE_CLAIM_CONFLICT_CODE: &str = "E_SYNC_E2EE_CLAIM_CONFLICT";
/// marker / lease 的有界读上限：两者都是几百字节的 JSON，超过该上限的对象
/// 一律拒绝下载并按损坏 / 冲突处理（fail-closed），防止畸形对象放大内存。
pub const MAX_E2EE_CLAIM_OBJECT_BYTES: u64 = 64 * 1024;

/// 认领租约内容。字段保持明文：其他设备必须在不知道 E2EE 密码时也能判断
/// 占用 / 过期；不包含 endpoint、凭据等敏感信息，设备 ID 用短哈希。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct EncryptionClaimLease {
    pub format_version: u32,
    /// 认领设备（短哈希，不泄露完整 device_id）。
    pub device_id: String,
    /// 本次认领的随机 nonce：同一设备的两次重试也互不混淆。
    pub nonce: String,
    pub created_at: String,
    pub expires_at: String,
}

impl EncryptionClaimLease {
    fn new(device_id_short: &str, ttl: Duration, now: DateTime<Utc>) -> Result<Self> {
        if device_id_short.trim().is_empty() {
            return Err(AppError::validation("E2EE 认领租约缺少设备 ID"));
        }
        let ttl = chrono::Duration::from_std(ttl)
            .map_err(|_| AppError::validation("E2EE 认领租约 TTL 超出可表示范围"))?;
        if ttl <= chrono::Duration::zero() {
            return Err(AppError::validation("E2EE 认领租约 TTL 必须大于零"));
        }
        Ok(Self {
            format_version: E2EE_CLAIM_LEASE_FORMAT_VERSION,
            device_id: device_id_short.trim().to_string(),
            nonce: uuid::Uuid::new_v4().to_string(),
            created_at: now.to_rfc3339(),
            expires_at: (now + ttl).to_rfc3339(),
        })
    }

    fn expires_at_utc(&self) -> Option<DateTime<Utc>> {
        DateTime::parse_from_rfc3339(&self.expires_at)
            .ok()
            .map(|value| value.with_timezone(&Utc))
    }

    fn structurally_valid(&self) -> bool {
        self.format_version == E2EE_CLAIM_LEASE_FORMAT_VERSION
            && !self.device_id.trim().is_empty()
            && uuid::Uuid::parse_str(&self.nonce).is_ok()
            && DateTime::parse_from_rfc3339(&self.created_at).is_ok()
            && self.expires_at_utc().is_some()
    }
}

/// 认领前对 marker 的期望状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimExpectation {
    /// 首次认领：marker 必须不存在。
    Absent,
    /// v1→v2 一次性升级：marker 必须仍是无校验子的旧版（`version <= 1`）。
    LegacyV1,
}

/// 第 1 步读到的 marker 快照。
enum MarkerSnapshot {
    Absent,
    LegacyV1 {
        raw: Vec<u8>,
        parsed: EncryptionMarker,
    },
}

fn claim_conflict(message: impl std::fmt::Display) -> AppError {
    AppError::conflict(super::sync_e2ee_error(
        SYNC_E2EE_CLAIM_CONFLICT_CODE,
        message,
    ))
}

fn ensure_claim_payload_bounded(what: &str, len: usize) -> Result<()> {
    if len as u64 > MAX_E2EE_CLAIM_OBJECT_BYTES {
        return Err(AppError::internal(format!(
            "{what}为 {len} 字节，超过 {MAX_E2EE_CLAIM_OBJECT_BYTES} 字节上限，已拒绝写入"
        )));
    }
    Ok(())
}

/// 有界读：先 `stat` 核大小（超限拒绝下载、fail-closed，带稳定冲突码），
/// 再 [`CloudStorage::get_bounded`]（`stat` 与 `get` 之间对象可被并发替换，
/// 换成超限对象时由传输层预算闸中途断流，以 `get_bounded` 结果为准）。
async fn read_bounded(storage: &dyn CloudStorage, key: &str) -> Result<Option<Vec<u8>>> {
    if let Some(info) = storage.stat(key).await? {
        if info.size > MAX_E2EE_CLAIM_OBJECT_BYTES {
            return Err(claim_conflict(format!(
                "认领对象 {key} 为 {} 字节，超过 {MAX_E2EE_CLAIM_OBJECT_BYTES} 字节上限，\
                 已拒绝下载（fail-closed）。请人工检查该云端目录。",
                info.size
            )));
        }
    }
    let Some(bytes) = storage
        .get_bounded(key, MAX_E2EE_CLAIM_OBJECT_BYTES)
        .await?
    else {
        return Ok(None);
    };
    if bytes.len() as u64 > MAX_E2EE_CLAIM_OBJECT_BYTES {
        return Err(claim_conflict(format!(
            "认领对象 {key} 实收 {} 字节，超过 {MAX_E2EE_CLAIM_OBJECT_BYTES} 字节上限，\
             已拒绝（fail-closed）。请人工检查该云端目录。",
            bytes.len()
        )));
    }
    Ok(Some(bytes))
}

/// 内容比对后删除：只有对象仍与刚读取的字节一致才删，缩窄与并发写入者的竞争窗。
async fn delete_if_unchanged(
    storage: &dyn CloudStorage,
    key: &str,
    expected: &[u8],
) -> Result<bool> {
    // [R4-get-budget] 合法认领对象恒 ≤ 上限；当前对象超限说明已被畸形对象
    // 覆盖（必然不是我们的），预算错误让调用方 fail-closed。
    let current = storage
        .get_bounded(key, MAX_E2EE_CLAIM_OBJECT_BYTES)
        .await?;
    if current.as_deref() != Some(expected) {
        return Ok(false);
    }
    storage.delete(key).await?;
    Ok(true)
}

/// 第 1 步：有界读 marker，必须与期望一致，返回快照。
async fn read_marker_snapshot(
    storage: &dyn CloudStorage,
    marker_key: &str,
    expectation: ClaimExpectation,
) -> Result<MarkerSnapshot> {
    match (read_bounded(storage, marker_key).await?, expectation) {
        (None, ClaimExpectation::Absent) => Ok(MarkerSnapshot::Absent),
        (None, ClaimExpectation::LegacyV1) => Err(claim_conflict(
            "升级旧版加密标记时发现标记已消失（可能被并发删除或改动），已中止本次升级；\
             请重试上传以重新读取云端状态。",
        )),
        (Some(_), ClaimExpectation::Absent) => Err(claim_conflict(
            "云端加密标记已被其他设备创建，本次首次认领中止；请重试上传，\
             将按已有标记校验加密密码。",
        )),
        (Some(raw), ClaimExpectation::LegacyV1) => {
            let parsed: EncryptionMarker = serde_json::from_slice(&raw).map_err(|error| {
                claim_conflict(format!(
                    "升级前复核云端加密标记失败：内容无法解析（{error}），fail-closed。\
                     请人工检查该云端目录。"
                ))
            })?;
            if parsed.version > 1 || parsed.key_verifier.is_some() {
                return Err(claim_conflict(
                    "云端加密标记已不再是可升级的 v1 旧标记（可能已被其他设备升级），\
                     本次升级中止；请重试上传，将按已有标记校验加密密码。",
                ));
            }
            Ok(MarkerSnapshot::LegacyV1 { raw, parsed })
        }
    }
}

/// 第 2 步：租约门。活跃他人租约 fail-closed；过期租约内容比对后回收。
///
/// 损坏 / 超限租约没有可信 `expires_at`，退化为 `stat().last_modified + ttl`：
/// 窗口内按活跃租约 fail-closed，窗口外允许回收，避免永久锁死认领。
async fn ensure_no_live_lease(
    storage: &dyn CloudStorage,
    lease_key: &str,
    ttl: Duration,
    now: DateTime<Utc>,
) -> Result<()> {
    let ttl_fallback = chrono::Duration::from_std(ttl)
        .map_err(|_| AppError::validation("E2EE 认领租约 TTL 超出可表示范围"))?;
    let info = storage.stat(lease_key).await?;
    if let Some(info) = &info {
        if info.size > MAX_E2EE_CLAIM_OBJECT_BYTES {
            // 超限租约无法读回内容比对：TTL 回退窗口内 fail-closed，窗口外
            // 无条件回收（此处的删除竞争窗仅存在于「畸形超限对象」这一异常态）。
            let fallback = info.last_modified + ttl_fallback;
            if fallback > now {
                return Err(claim_conflict(format!(
                    "云端存在无法解读的加密标记认领租约（{} 字节，超过上限），\
                     按活跃处理至 {}；请稍后重试。",
                    info.size,
                    fallback.to_rfc3339()
                )));
            }
            storage.delete(lease_key).await?;
            return Ok(());
        }
    }
    // [R4-get-budget] stat 预检之后仍走硬预算入口：stat 与 get 之间租约可能
    // 被并发换成超限对象，届时中途断流、按错误 fail-closed。
    let Some(bytes) = storage
        .get_bounded(lease_key, MAX_E2EE_CLAIM_OBJECT_BYTES)
        .await?
    else {
        return Ok(());
    };
    let parsed = serde_json::from_slice::<EncryptionClaimLease>(&bytes)
        .ok()
        .filter(EncryptionClaimLease::structurally_valid);
    let expires_at = parsed
        .as_ref()
        .and_then(EncryptionClaimLease::expires_at_utc)
        .or_else(|| info.map(|info| info.last_modified + ttl_fallback))
        .unwrap_or_else(|| now + ttl_fallback);
    if expires_at > now {
        let holder = parsed
            .as_ref()
            .map(|lease| lease.device_id.as_str())
            .unwrap_or("未知设备（租约内容损坏）");
        return Err(claim_conflict(format!(
            "云端加密标记正被其他设备认领：{holder}（租约预计 {} 到期）。\
             请等待其完成或租约过期后重试；不要手工删除云端认领文件。",
            expires_at.to_rfc3339()
        )));
    }
    let _ = delete_if_unchanged(storage, lease_key, &bytes).await?;
    Ok(())
}

/// PUT marker 后逐字节回读确认。错误文案与旧 `write_encryption_marker` 保持
/// 一致（fail-closed 语义与既有测试都钉在这两句上）。
async fn publish_marker_verified(
    storage: &dyn CloudStorage,
    marker_key: &str,
    data: &[u8],
) -> Result<()> {
    storage.put(marker_key, data).await?;
    match storage
        .get_bounded(marker_key, MAX_E2EE_CLAIM_OBJECT_BYTES)
        .await?
    {
        Some(ref read_back) if read_back.as_slice() == data => Ok(()),
        Some(_) => Err(AppError::internal(
            "加密标记上传后回读不一致，已停止并不得报成功".to_string(),
        )),
        None => Err(AppError::internal(
            "加密标记上传后对象不存在，已停止并不得报成功".to_string(),
        )),
    }
}

/// 经认领协议发布（首次创建或 v1→v2 升级）云端加密标记，返回已发布的字节。
///
/// `build_marker` 收到协议**自己第 1 步快照**里解析出的 v1 标记（首次认领为
/// `None`），据此构造新标记字节——升级时保留首次写入者与时间必须以该快照为准，
/// 避免调用方更早一次读取与实际写入之间的 TOCTOU。
///
/// 任何冲突都返回带 [`SYNC_E2EE_CLAIM_CONFLICT_CODE`] 的错误；两台设备并发
/// 认领时至多一方成功（互斥论证见模块注释），双双失败允许（重试收敛）。
pub async fn claim_encryption_marker<F>(
    storage: &dyn CloudStorage,
    marker_key: &str,
    device_id_short: &str,
    ttl: Duration,
    expectation: ClaimExpectation,
    build_marker: F,
) -> Result<Vec<u8>>
where
    F: Fn(Option<EncryptionMarker>) -> Result<Vec<u8>>,
{
    let lease_key = format!("{marker_key}{ENCRYPTION_MARKER_LEASE_SUFFIX}");
    let now = Utc::now();

    // 第 1 步：有界读 marker，必须与期望一致（快照）。
    let snapshot = read_marker_snapshot(storage, marker_key, expectation).await?;

    // 能力探测：支持条件写的后端用「不存在才创建」原子完成首次认领；
    // 默认 false（多数现网不支持 / 不可信），走下方租约方案。
    if matches!(expectation, ClaimExpectation::Absent) && storage.supports_conditional_put() {
        let data = build_marker(None)?;
        ensure_claim_payload_bounded("待发布的加密标记", data.len())?;
        if !storage.put_if_absent(marker_key, &data).await? {
            return Err(claim_conflict(
                "云端加密标记已被其他设备并发创建（条件写冲突），本次认领中止；\
                 请重试上传，将按已有标记校验加密密码。",
            ));
        }
        // 条件创建成功也要回读：半包 / 网关改写与无条件 PUT 同样存在。
        match storage
            .get_bounded(marker_key, MAX_E2EE_CLAIM_OBJECT_BYTES)
            .await?
        {
            Some(ref read_back) if read_back == &data => {}
            Some(_) => {
                return Err(AppError::internal(
                    "加密标记上传后回读不一致，已停止并不得报成功".to_string(),
                ));
            }
            None => {
                return Err(AppError::internal(
                    "加密标记上传后对象不存在，已停止并不得报成功".to_string(),
                ));
            }
        }
        return Ok(data);
    }

    // 第 2 步：租约门。
    ensure_no_live_lease(storage, &lease_key, ttl, now).await?;

    // 第 3 步：写本设备租约（写 x）。
    let lease = EncryptionClaimLease::new(device_id_short, ttl, now)?;
    let lease_bytes = serde_json::to_vec_pretty(&lease)
        .map_err(|error| AppError::internal(format!("序列化认领租约失败: {error}")))?;
    ensure_claim_payload_bounded("认领租约", lease_bytes.len())?;
    storage.put(&lease_key, &lease_bytes).await?;

    // 第 4 步：回读租约必须逐字节是自己（读 x）。
    match storage
        .get_bounded(&lease_key, MAX_E2EE_CLAIM_OBJECT_BYTES)
        .await?
    {
        Some(ref current) if current == &lease_bytes => {}
        _ => {
            // 租约已是他人的（或消失），不做删除，直接失败。
            return Err(claim_conflict(
                "加密标记认领租约被其他设备并发抢占，本次认领中止；请稍后重试。",
            ));
        }
    }

    // 第 5 步：再读 marker，必须与第 1 步快照逐字节一致（读 y，Lamport「y 为空」检查）。
    let marker_recheck = match read_bounded(storage, marker_key).await {
        Ok(current) => current,
        Err(error) => {
            let _ = delete_if_unchanged(storage, &lease_key, &lease_bytes).await;
            return Err(error);
        }
    };
    let marker_unchanged = match (&snapshot, &marker_recheck) {
        (MarkerSnapshot::Absent, None) => true,
        (MarkerSnapshot::LegacyV1 { raw, .. }, Some(current)) => current == raw,
        _ => false,
    };
    if !marker_unchanged {
        let _ = delete_if_unchanged(storage, &lease_key, &lease_bytes).await;
        return Err(claim_conflict(
            "持有认领租约后复核发现云端加密标记已被并发改动，本次认领中止；\
             请重试上传以重新读取云端状态。",
        ));
    }

    // 第 6 步：写 marker 并逐字节回读（写 y）。
    let snapshot_parsed = match snapshot {
        MarkerSnapshot::Absent => None,
        MarkerSnapshot::LegacyV1 { parsed, .. } => Some(parsed),
    };
    let data = match build_marker(snapshot_parsed) {
        Ok(data) => data,
        Err(error) => {
            let _ = delete_if_unchanged(storage, &lease_key, &lease_bytes).await;
            return Err(error);
        }
    };
    if let Err(error) = ensure_claim_payload_bounded("待发布的加密标记", data.len()) {
        let _ = delete_if_unchanged(storage, &lease_key, &lease_bytes).await;
        return Err(error);
    }
    if let Err(error) = publish_marker_verified(storage, marker_key, &data).await {
        // 半包 / 回读不一致：损坏对象保留供对照（与旧行为一致），只清理本设备租约。
        let _ = delete_if_unchanged(storage, &lease_key, &lease_bytes).await;
        return Err(error);
    }

    // 第 7 步：租约必须仍逐字节是自己（读 x，Lamport「x 仍是我」检查）。
    // 失败时不回滚 marker：留下的是携带真实校验子的完整认领（见模块注释），
    // 本设备按失败返回，重试会按已有标记走校验子验证。
    match storage
        .get_bounded(&lease_key, MAX_E2EE_CLAIM_OBJECT_BYTES)
        .await?
    {
        Some(ref current) if current == &lease_bytes => {}
        _ => {
            return Err(claim_conflict(
                "认领期间租约被其他设备并发抢占，无法确认互斥，本次认领按失败处理；\
                 请重试上传，将按云端当前标记校验加密密码。",
            ));
        }
    }

    // 第 8 步：尽力释放本设备租约；删不掉由 TTL 兜底。
    match delete_if_unchanged(storage, &lease_key, &lease_bytes).await {
        Ok(_) => {}
        Err(error) => {
            tracing::warn!(
                "[e2ee-claim] 释放加密标记认领租约失败（将由 TTL 在 {}s 内回收）: {}",
                ttl.as_secs(),
                error
            );
        }
    }
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::super::traits::FileInfo;
    use super::*;
    use async_trait::async_trait;
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};

    const MARKER_KEY: &str = ".encryption-marker";

    #[derive(Default)]
    struct MemoryStorage {
        files: Mutex<BTreeMap<String, (Vec<u8>, DateTime<Utc>)>>,
        put_log: Mutex<Vec<String>>,
    }

    impl MemoryStorage {
        fn bytes(&self, key: &str) -> Option<Vec<u8>> {
            self.files
                .lock()
                .unwrap()
                .get(key)
                .map(|(data, _)| data.clone())
        }

        fn insert_backdated(&self, key: &str, data: &[u8], modified: DateTime<Utc>) {
            self.files
                .lock()
                .unwrap()
                .insert(key.to_string(), (data.to_vec(), modified));
        }

        fn put_keys(&self) -> Vec<String> {
            self.put_log.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl CloudStorage for Arc<MemoryStorage> {
        fn provider_name(&self) -> &'static str {
            "memory"
        }

        async fn check_connection(&self) -> Result<()> {
            Ok(())
        }

        async fn put(&self, key: &str, data: &[u8]) -> Result<()> {
            self.put_log.lock().unwrap().push(key.to_string());
            self.files
                .lock()
                .unwrap()
                .insert(key.to_string(), (data.to_vec(), Utc::now()));
            Ok(())
        }

        async fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
            Ok(self.bytes(key))
        }

        async fn list(&self, prefix: &str) -> Result<Vec<FileInfo>> {
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

        async fn delete(&self, key: &str) -> Result<()> {
            self.files.lock().unwrap().remove(key);
            Ok(())
        }

        async fn stat(&self, key: &str) -> Result<Option<FileInfo>> {
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

    fn lease_key() -> String {
        format!("{MARKER_KEY}{ENCRYPTION_MARKER_LEASE_SUFFIX}")
    }

    fn build_fixed(payload: &'static [u8]) -> impl Fn(Option<EncryptionMarker>) -> Result<Vec<u8>> {
        move |_snapshot| Ok(payload.to_vec())
    }

    fn lease_json(device: &str, expires_in_secs: i64) -> Vec<u8> {
        let now = Utc::now();
        serde_json::to_vec_pretty(&EncryptionClaimLease {
            format_version: E2EE_CLAIM_LEASE_FORMAT_VERSION,
            device_id: device.to_string(),
            nonce: uuid::Uuid::new_v4().to_string(),
            created_at: now.to_rfc3339(),
            expires_at: (now + chrono::Duration::seconds(expires_in_secs)).to_rfc3339(),
        })
        .unwrap()
    }

    fn v1_marker_bytes(device: &str) -> Vec<u8> {
        serde_json::to_vec_pretty(&EncryptionMarker {
            version: 1,
            created_by_device: device.to_string(),
            created_at: Utc::now(),
            key_verifier: None,
        })
        .unwrap()
    }

    #[tokio::test]
    async fn first_claim_writes_lease_then_marker_and_cleans_lease() {
        let storage = Arc::new(MemoryStorage::default());
        let published = claim_encryption_marker(
            &storage,
            MARKER_KEY,
            "device-a",
            DEFAULT_E2EE_CLAIM_LEASE_TTL,
            ClaimExpectation::Absent,
            build_fixed(b"marker-A"),
        )
        .await
        .expect("空仓首次认领必须成功");
        assert_eq!(published, b"marker-A");
        assert_eq!(storage.bytes(MARKER_KEY).as_deref(), Some(&b"marker-A"[..]));
        assert!(
            storage.bytes(&lease_key()).is_none(),
            "认领成功后租约必须被清理"
        );
        let puts = storage.put_keys();
        let lease_pos = puts.iter().position(|k| k == &lease_key());
        let marker_pos = puts.iter().position(|k| k == MARKER_KEY);
        assert!(
            lease_pos.is_some() && marker_pos.is_some() && lease_pos < marker_pos,
            "必须先写租约再写标记（盲 PUT 已被移除），实际写入顺序: {puts:?}"
        );
    }

    #[tokio::test]
    async fn claim_fails_when_marker_already_exists() {
        let storage = Arc::new(MemoryStorage::default());
        CloudStorage::put(&storage, MARKER_KEY, b"marker-A")
            .await
            .unwrap();
        let error = claim_encryption_marker(
            &storage,
            MARKER_KEY,
            "device-b",
            DEFAULT_E2EE_CLAIM_LEASE_TTL,
            ClaimExpectation::Absent,
            build_fixed(b"marker-B"),
        )
        .await
        .expect_err("标记已存在时首次认领必须失败");
        assert!(
            error.to_string().contains(SYNC_E2EE_CLAIM_CONFLICT_CODE),
            "认领冲突必须带稳定 code: {error}"
        );
        assert_eq!(
            storage.bytes(MARKER_KEY).as_deref(),
            Some(&b"marker-A"[..]),
            "已有标记不得被覆盖"
        );
    }

    #[tokio::test]
    async fn live_foreign_lease_blocks_claim_and_never_writes_marker() {
        let storage = Arc::new(MemoryStorage::default());
        CloudStorage::put(&storage, &lease_key(), &lease_json("device-x", 60))
            .await
            .unwrap();
        let error = claim_encryption_marker(
            &storage,
            MARKER_KEY,
            "device-b",
            DEFAULT_E2EE_CLAIM_LEASE_TTL,
            ClaimExpectation::Absent,
            build_fixed(b"marker-B"),
        )
        .await
        .expect_err("他人活跃租约在持时认领必须失败");
        let message = error.to_string();
        assert!(message.contains(SYNC_E2EE_CLAIM_CONFLICT_CODE), "{message}");
        assert!(message.contains("device-x"), "错误应指明持有者: {message}");
        assert!(
            storage.bytes(MARKER_KEY).is_none(),
            "被租约挡下的认领不得写入任何标记"
        );
    }

    #[tokio::test]
    async fn expired_foreign_lease_is_reclaimed() {
        let storage = Arc::new(MemoryStorage::default());
        CloudStorage::put(&storage, &lease_key(), &lease_json("device-x", -5))
            .await
            .unwrap();
        claim_encryption_marker(
            &storage,
            MARKER_KEY,
            "device-b",
            DEFAULT_E2EE_CLAIM_LEASE_TTL,
            ClaimExpectation::Absent,
            build_fixed(b"marker-B"),
        )
        .await
        .expect("过期租约必须可被回收，认领继续");
        assert_eq!(storage.bytes(MARKER_KEY).as_deref(), Some(&b"marker-B"[..]));
        assert!(storage.bytes(&lease_key()).is_none());
    }

    #[tokio::test]
    async fn corrupted_fresh_lease_fails_closed_and_stale_one_is_reclaimed() {
        let storage = Arc::new(MemoryStorage::default());

        // 新鲜的损坏租约：TTL 回退窗口内 fail-closed。
        CloudStorage::put(&storage, &lease_key(), b"not-json")
            .await
            .unwrap();
        let error = claim_encryption_marker(
            &storage,
            MARKER_KEY,
            "device-b",
            DEFAULT_E2EE_CLAIM_LEASE_TTL,
            ClaimExpectation::Absent,
            build_fixed(b"marker-B"),
        )
        .await
        .expect_err("新鲜的损坏租约必须 fail-closed");
        assert!(error.to_string().contains(SYNC_E2EE_CLAIM_CONFLICT_CODE));

        // 同一损坏租约超过 TTL 回退窗口后可回收。
        storage.insert_backdated(
            &lease_key(),
            b"not-json",
            Utc::now() - chrono::Duration::seconds(120),
        );
        claim_encryption_marker(
            &storage,
            MARKER_KEY,
            "device-b",
            Duration::from_secs(60),
            ClaimExpectation::Absent,
            build_fixed(b"marker-B"),
        )
        .await
        .expect("过期的损坏租约必须可回收（否则认领被永久锁死）");
        assert_eq!(storage.bytes(MARKER_KEY).as_deref(), Some(&b"marker-B"[..]));
    }

    #[tokio::test]
    async fn legacy_v1_upgrade_hands_snapshot_to_builder_and_rejects_v2() {
        let storage = Arc::new(MemoryStorage::default());
        CloudStorage::put(&storage, MARKER_KEY, &v1_marker_bytes("device-legacy"))
            .await
            .unwrap();

        let published = claim_encryption_marker(
            &storage,
            MARKER_KEY,
            "device-a",
            DEFAULT_E2EE_CLAIM_LEASE_TTL,
            ClaimExpectation::LegacyV1,
            |snapshot| {
                let legacy = snapshot.expect("升级臂必须拿到 v1 快照");
                assert_eq!(legacy.created_by_device, "device-legacy");
                Ok(format!("upgraded-by-{}", legacy.created_by_device).into_bytes())
            },
        )
        .await
        .expect("v1 升级认领必须成功");
        assert_eq!(published, b"upgraded-by-device-legacy");

        // 已升级（不再是 v1）后再次走升级臂必须冲突。
        let v2 = serde_json::to_vec_pretty(&EncryptionMarker {
            version: 2,
            created_by_device: "device-legacy".to_string(),
            created_at: Utc::now(),
            key_verifier: None,
        })
        .unwrap();
        CloudStorage::put(&storage, MARKER_KEY, &v2).await.unwrap();
        let error = claim_encryption_marker(
            &storage,
            MARKER_KEY,
            "device-b",
            DEFAULT_E2EE_CLAIM_LEASE_TTL,
            ClaimExpectation::LegacyV1,
            build_fixed(b"marker-B"),
        )
        .await
        .expect_err("非 v1 标记不得再被升级臂覆盖");
        assert!(error.to_string().contains(SYNC_E2EE_CLAIM_CONFLICT_CODE));
        assert_eq!(storage.bytes(MARKER_KEY), Some(v2), "已升级标记不得被覆盖");
    }

    /// 第 4 步（回读租约不是自己）：模拟另一设备在我们 PUT 租约后立即覆盖。
    struct ForeignLeaseAfterPut {
        inner: Arc<MemoryStorage>,
        foreign: Vec<u8>,
    }

    #[async_trait]
    impl CloudStorage for ForeignLeaseAfterPut {
        fn provider_name(&self) -> &'static str {
            "memory-foreign-lease"
        }

        async fn check_connection(&self) -> Result<()> {
            Ok(())
        }

        async fn put(&self, key: &str, data: &[u8]) -> Result<()> {
            CloudStorage::put(&self.inner, key, data).await?;
            if key.ends_with(ENCRYPTION_MARKER_LEASE_SUFFIX) {
                // 我们的租约刚落地就被并发认领者覆盖。
                CloudStorage::put(&self.inner, key, &self.foreign).await?;
            }
            Ok(())
        }

        async fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
            CloudStorage::get(&self.inner, key).await
        }

        async fn list(&self, prefix: &str) -> Result<Vec<FileInfo>> {
            CloudStorage::list(&self.inner, prefix).await
        }

        async fn delete(&self, key: &str) -> Result<()> {
            CloudStorage::delete(&self.inner, key).await
        }

        async fn stat(&self, key: &str) -> Result<Option<FileInfo>> {
            CloudStorage::stat(&self.inner, key).await
        }
    }

    #[tokio::test]
    async fn lease_overwritten_before_readback_aborts_without_marker_write() {
        let inner = Arc::new(MemoryStorage::default());
        let storage = ForeignLeaseAfterPut {
            inner: Arc::clone(&inner),
            foreign: lease_json("device-x", 60),
        };
        let error = claim_encryption_marker(
            &storage,
            MARKER_KEY,
            "device-a",
            DEFAULT_E2EE_CLAIM_LEASE_TTL,
            ClaimExpectation::Absent,
            build_fixed(b"marker-A"),
        )
        .await
        .expect_err("租约回读不是自己时必须失败");
        assert!(error.to_string().contains(SYNC_E2EE_CLAIM_CONFLICT_CODE));
        assert!(
            inner.bytes(MARKER_KEY).is_none(),
            "租约被抢占的一方不得写入标记"
        );
    }

    /// 第 7 步（发布后租约被抢占）：标记已写入但认领必须按失败返回，
    /// 且不回滚 marker（留下的是完整认领对象）。
    struct StealLeaseOnMarkerPut {
        inner: Arc<MemoryStorage>,
        foreign: Vec<u8>,
    }

    #[async_trait]
    impl CloudStorage for StealLeaseOnMarkerPut {
        fn provider_name(&self) -> &'static str {
            "memory-steal-lease"
        }

        async fn check_connection(&self) -> Result<()> {
            Ok(())
        }

        async fn put(&self, key: &str, data: &[u8]) -> Result<()> {
            CloudStorage::put(&self.inner, key, data).await?;
            if key == MARKER_KEY {
                // 并发认领者恰在我们写 marker 的同时写入了它的租约。
                CloudStorage::put(
                    &self.inner,
                    &format!("{MARKER_KEY}{ENCRYPTION_MARKER_LEASE_SUFFIX}"),
                    &self.foreign,
                )
                .await?;
            }
            Ok(())
        }

        async fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
            CloudStorage::get(&self.inner, key).await
        }

        async fn list(&self, prefix: &str) -> Result<Vec<FileInfo>> {
            CloudStorage::list(&self.inner, prefix).await
        }

        async fn delete(&self, key: &str) -> Result<()> {
            CloudStorage::delete(&self.inner, key).await
        }

        async fn stat(&self, key: &str) -> Result<Option<FileInfo>> {
            CloudStorage::stat(&self.inner, key).await
        }
    }

    #[tokio::test]
    async fn lease_stolen_after_marker_write_reports_failure_without_rollback() {
        let inner = Arc::new(MemoryStorage::default());
        let storage = StealLeaseOnMarkerPut {
            inner: Arc::clone(&inner),
            foreign: lease_json("device-x", 60),
        };
        let error = claim_encryption_marker(
            &storage,
            MARKER_KEY,
            "device-a",
            DEFAULT_E2EE_CLAIM_LEASE_TTL,
            ClaimExpectation::Absent,
            build_fixed(b"marker-A"),
        )
        .await
        .expect_err("发布后租约被抢占必须按失败返回（无法确认互斥）");
        assert!(error.to_string().contains(SYNC_E2EE_CLAIM_CONFLICT_CODE));
        assert_eq!(
            inner.bytes(MARKER_KEY).as_deref(),
            Some(&b"marker-A"[..]),
            "已写入的完整认领对象不得回滚（删除会重新打开明文/换口令窗口）"
        );
    }

    /// 声明支持条件写的后端：首次认领直接原子创建，不再使用租约。
    struct ConditionalPutStorage {
        inner: Arc<MemoryStorage>,
    }

    #[async_trait]
    impl CloudStorage for ConditionalPutStorage {
        fn provider_name(&self) -> &'static str {
            "memory-conditional"
        }

        async fn check_connection(&self) -> Result<()> {
            Ok(())
        }

        fn supports_conditional_put(&self) -> bool {
            true
        }

        async fn put_if_absent(&self, key: &str, data: &[u8]) -> Result<bool> {
            let mut files = self.inner.files.lock().unwrap();
            if files.contains_key(key) {
                return Ok(false);
            }
            files.insert(key.to_string(), (data.to_vec(), Utc::now()));
            Ok(true)
        }

        async fn put(&self, key: &str, data: &[u8]) -> Result<()> {
            CloudStorage::put(&self.inner, key, data).await
        }

        async fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
            CloudStorage::get(&self.inner, key).await
        }

        async fn list(&self, prefix: &str) -> Result<Vec<FileInfo>> {
            CloudStorage::list(&self.inner, prefix).await
        }

        async fn delete(&self, key: &str) -> Result<()> {
            CloudStorage::delete(&self.inner, key).await
        }

        async fn stat(&self, key: &str) -> Result<Option<FileInfo>> {
            CloudStorage::stat(&self.inner, key).await
        }
    }

    #[tokio::test]
    async fn conditional_put_backend_claims_without_lease_and_second_claim_conflicts() {
        let inner = Arc::new(MemoryStorage::default());
        let storage = ConditionalPutStorage {
            inner: Arc::clone(&inner),
        };
        claim_encryption_marker(
            &storage,
            MARKER_KEY,
            "device-a",
            DEFAULT_E2EE_CLAIM_LEASE_TTL,
            ClaimExpectation::Absent,
            build_fixed(b"marker-A"),
        )
        .await
        .expect("条件写后端首次认领必须成功");
        assert!(
            !inner.put_keys().iter().any(|k| k == &lease_key()),
            "条件写路径不得使用租约对象"
        );
        assert_eq!(inner.bytes(MARKER_KEY).as_deref(), Some(&b"marker-A"[..]));

        let error = claim_encryption_marker(
            &storage,
            MARKER_KEY,
            "device-b",
            DEFAULT_E2EE_CLAIM_LEASE_TTL,
            ClaimExpectation::Absent,
            build_fixed(b"marker-B"),
        )
        .await
        .expect_err("第二个条件写认领必须冲突");
        assert!(error.to_string().contains(SYNC_E2EE_CLAIM_CONFLICT_CODE));
        assert_eq!(
            inner.bytes(MARKER_KEY).as_deref(),
            Some(&b"marker-A"[..]),
            "冲突方不得覆盖已有标记"
        );
    }

    #[tokio::test]
    async fn oversized_lease_object_fails_closed_within_ttl_window() {
        let storage = Arc::new(MemoryStorage::default());
        let big = vec![b'x'; (MAX_E2EE_CLAIM_OBJECT_BYTES + 1) as usize];
        CloudStorage::put(&storage, &lease_key(), &big)
            .await
            .unwrap();
        let error = claim_encryption_marker(
            &storage,
            MARKER_KEY,
            "device-a",
            DEFAULT_E2EE_CLAIM_LEASE_TTL,
            ClaimExpectation::Absent,
            build_fixed(b"marker-A"),
        )
        .await
        .expect_err("新鲜的超限租约必须 fail-closed");
        assert!(error.to_string().contains(SYNC_E2EE_CLAIM_CONFLICT_CODE));
        assert!(storage.bytes(MARKER_KEY).is_none());
    }

    // ========================================================================
    // [0824-W2-R7] 两设备认领全排列
    //
    //   初始 marker ∈ { 空仓, 已有 v2 标记, 可升级 v1 }        （3）
    // × 初始 lease  ∈ { 无, 他人未过期, 他人已过期 }            （3）
    // × 设备 A 期望 ∈ { Absent（首次认领）, LegacyV1（升级） }  （2）
    // × 设备 B 期望 ∈ { Absent, LegacyV1 }                      （2）
    //
    // 共 36 个排列。设备 A 完整跑完认领协议后设备 B 再跑（顺序两设备——
    // 协议内每一步的交错互斥已由上方 ForeignLeaseAfterPut / StealLeaseOnMarkerPut
    // 与下方 RivalClaimsBeforeOurLeasePut 分别钉死，这里钉「任意初始状态组合」
    // 下的端到端语义）。每个排列断言：
    //
    //   1. 每台设备的成败与协议语义 oracle 完全一致（期望匹配当前 marker
    //      形态、且无活跃他人租约 ⇔ 成功）；
    //   2. **至多一个成功**；
    //   3. marker 写入次数 == 成功次数（失败方零写入，杜绝盲 PUT 回归）；
    //   4. 云端标记终态逐字节等于 oracle 推演值——已有 v2 标记在任何排列下
    //      都不被覆盖或降级，赢家的标记不被输家改动；
    //   5. 租约终态：有人成功 → 租约必须被清理干净；无人成功 → 初始租约
    //      逐字节原样保留（活跃他人租约不得被删，过期租约只有越过第 1 步
    //      期望校验的设备才允许回收）。
    // ========================================================================

    use std::sync::atomic::{AtomicBool, Ordering};

    #[derive(Clone, Copy, Debug)]
    enum MarkerCase {
        /// 空仓：无任何标记。
        Empty,
        /// 已有 v2 标记（他人已认领完成）。
        ExistingV2,
        /// 可升级的 v1 旧标记（无校验子）。
        LegacyV1,
    }

    #[derive(Clone, Copy, Debug)]
    enum LeaseCase {
        /// 无租约。
        NoLease,
        /// 他人租约未过期（活跃）。
        LiveForeign,
        /// 他人租约已过期（可回收）。
        ExpiredForeign,
    }

    /// 合法 v2 标记字节（认领成功后写入的形态；`version > 1`，升级臂必须拒绝）。
    fn v2_marker_bytes(device: &str) -> Vec<u8> {
        serde_json::to_vec_pretty(&EncryptionMarker {
            version: 2,
            created_by_device: device.to_string(),
            created_at: Utc::now(),
            key_verifier: None,
        })
        .unwrap()
    }

    #[tokio::test]
    async fn two_device_claim_full_permutation_at_most_one_succeeds() {
        /// oracle 用的 marker 当前形态（成功认领后恒为 v2）。
        #[derive(Clone, Copy, Debug, PartialEq)]
        enum MarkerNow {
            Empty,
            V1,
            V2,
        }
        fn expectation_matches(exp: ClaimExpectation, marker: MarkerNow) -> bool {
            matches!(
                (exp, marker),
                (ClaimExpectation::Absent, MarkerNow::Empty)
                    | (ClaimExpectation::LegacyV1, MarkerNow::V1)
            )
        }

        let marker_cases = [
            MarkerCase::Empty,
            MarkerCase::ExistingV2,
            MarkerCase::LegacyV1,
        ];
        let lease_cases = [
            LeaseCase::NoLease,
            LeaseCase::LiveForeign,
            LeaseCase::ExpiredForeign,
        ];
        let expectations = [ClaimExpectation::Absent, ClaimExpectation::LegacyV1];

        for marker_case in marker_cases {
            for lease_case in lease_cases {
                for exp_a in expectations {
                    for exp_b in expectations {
                        let ctx = format!(
                            "[marker={marker_case:?} lease={lease_case:?} A={exp_a:?} B={exp_b:?}]"
                        );
                        let storage = Arc::new(MemoryStorage::default());

                        // ---- 初始云端状态 ----
                        let initial_marker = match marker_case {
                            MarkerCase::Empty => None,
                            MarkerCase::ExistingV2 => Some(v2_marker_bytes("device-owner")),
                            MarkerCase::LegacyV1 => Some(v1_marker_bytes("device-legacy")),
                        };
                        if let Some(bytes) = &initial_marker {
                            CloudStorage::put(&storage, MARKER_KEY, bytes)
                                .await
                                .unwrap();
                        }
                        let initial_lease = match lease_case {
                            LeaseCase::NoLease => None,
                            LeaseCase::LiveForeign => Some(lease_json("device-x", 3600)),
                            LeaseCase::ExpiredForeign => Some(lease_json("device-x", -5)),
                        };
                        if let Some(bytes) = &initial_lease {
                            CloudStorage::put(&storage, &lease_key(), bytes)
                                .await
                                .unwrap();
                        }
                        // 初始铺设不计入被测协议的写入统计。
                        storage.put_log.lock().unwrap().clear();

                        // ---- 顺序跑两台设备，与 oracle 同步推演 ----
                        let mut marker_now = match marker_case {
                            MarkerCase::Empty => MarkerNow::Empty,
                            MarkerCase::ExistingV2 => MarkerNow::V2,
                            MarkerCase::LegacyV1 => MarkerNow::V1,
                        };
                        let mut lease_live = matches!(lease_case, LeaseCase::LiveForeign);
                        let mut successes = 0usize;
                        let mut expected_final_marker = initial_marker.clone();

                        for (device, exp) in [("device-a", exp_a), ("device-b", exp_b)] {
                            let payload = v2_marker_bytes(device);
                            // 协议语义 oracle：第 1 步期望校验先于第 2 步租约门，
                            // 期望不匹配 → 失败且不触碰租约；匹配但他人活跃租约
                            // 在持 → 失败；否则成功（过期租约被回收）。
                            let should_succeed =
                                expectation_matches(exp, marker_now) && !lease_live;
                            let payload_for_build = payload.clone();
                            let result = claim_encryption_marker(
                                &storage,
                                MARKER_KEY,
                                device,
                                DEFAULT_E2EE_CLAIM_LEASE_TTL,
                                exp,
                                move |_snapshot| Ok(payload_for_build.clone()),
                            )
                            .await;
                            match (result, should_succeed) {
                                (Ok(published), true) => {
                                    assert_eq!(
                                        published, payload,
                                        "{ctx} {device} 返回的已发布字节必须是自己的 payload"
                                    );
                                    successes += 1;
                                    marker_now = MarkerNow::V2;
                                    lease_live = false;
                                    expected_final_marker = Some(payload);
                                }
                                (Err(error), false) => {
                                    assert!(
                                        error.to_string().contains(SYNC_E2EE_CLAIM_CONFLICT_CODE),
                                        "{ctx} {device} 的失败必须带稳定冲突码: {error}"
                                    );
                                }
                                (Ok(_), false) => panic!(
                                    "{ctx} {device} 按协议语义必须失败（期望不匹配当前标记\
                                     或他人活跃租约在持），却返回了成功——两设备互斥被打破"
                                ),
                                (Err(error), true) => panic!(
                                    "{ctx} {device} 按协议语义必须成功（期望匹配且无活跃\
                                     他人租约），实际失败: {error}"
                                ),
                            }
                        }

                        // ---- 全排列共同不变式 ----
                        assert!(
                            successes <= 1,
                            "{ctx} 两设备认领至多一个成功，实际 {successes} 个"
                        );
                        let marker_put_count = storage
                            .put_keys()
                            .iter()
                            .filter(|key| key.as_str() == MARKER_KEY)
                            .count();
                        assert_eq!(
                            marker_put_count, successes,
                            "{ctx} marker 写入次数必须等于成功次数（失败方零写入，\
                             不得存在盲 PUT）"
                        );
                        assert_eq!(
                            storage.bytes(MARKER_KEY),
                            expected_final_marker,
                            "{ctx} 云端标记终态必须逐字节等于协议语义推演值：已有标记\
                             不得被覆盖或降级，赢家的标记不得被输家改动"
                        );
                        let expected_final_lease = if successes > 0 {
                            // 赢家清理自己的租约；过期他人租约在其成功路径上被回收。
                            None
                        } else {
                            // 无人越过第 1/2 步：初始租约（含活跃他人租约）必须
                            // 逐字节原样保留，不得被失败方删除或改动。
                            initial_lease.clone()
                        };
                        assert_eq!(
                            storage.bytes(&lease_key()),
                            expected_final_lease,
                            "{ctx} 租约终态错误：成功后必须清理干净，无人成功时\
                             初始租约必须原样保留"
                        );
                    }
                }
            }
        }
    }

    // ========================================================================
    // [0824-W2-R7] 第 5 步深交错排列：本设备读完 marker（第 1 步）、过完
    // 租约门（第 2 步）、**正要写自己的租约**（第 3 步）时，对手设备完整
    // 跑完认领协议（含清理租约）。本设备随后写租约、第 4 步回读到自己，
    // 但第 5 步 marker 复核必然与快照不符 → 必须失败：恰好一个成功。
    // ========================================================================

    /// 首次 lease PUT 前先让对手在共享底层存储上完整跑一遍认领协议。
    struct RivalClaimsBeforeOurLeasePut {
        inner: Arc<MemoryStorage>,
        rival_expectation: ClaimExpectation,
        rival_payload: Vec<u8>,
        triggered: AtomicBool,
    }

    #[async_trait]
    impl CloudStorage for RivalClaimsBeforeOurLeasePut {
        fn provider_name(&self) -> &'static str {
            "memory-rival-full-claim"
        }

        async fn check_connection(&self) -> Result<()> {
            Ok(())
        }

        async fn put(&self, key: &str, data: &[u8]) -> Result<()> {
            if key.ends_with(ENCRYPTION_MARKER_LEASE_SUFFIX)
                && !self.triggered.swap(true, Ordering::SeqCst)
            {
                // 对手直接作用在共享底层存储上（不经本包装层），
                // 等价于另一台设备的完整认领在本设备第 2→3 步之间插入。
                let payload = self.rival_payload.clone();
                claim_encryption_marker(
                    &self.inner,
                    MARKER_KEY,
                    "device-rival",
                    DEFAULT_E2EE_CLAIM_LEASE_TTL,
                    self.rival_expectation,
                    move |_snapshot| Ok(payload.clone()),
                )
                .await
                .expect("交错窗口内对手的认领没有争抢，必须成功");
            }
            CloudStorage::put(&self.inner, key, data).await
        }

        async fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
            CloudStorage::get(&self.inner, key).await
        }

        async fn list(&self, prefix: &str) -> Result<Vec<FileInfo>> {
            CloudStorage::list(&self.inner, prefix).await
        }

        async fn delete(&self, key: &str) -> Result<()> {
            CloudStorage::delete(&self.inner, key).await
        }

        async fn stat(&self, key: &str) -> Result<Option<FileInfo>> {
            CloudStorage::stat(&self.inner, key).await
        }
    }

    /// 排列：{空仓首次认领, v1 升级} ×（初始租约 ∈ {无, 他人过期租约}）= 4。
    /// 他人**活跃**租约不在此列——那会在第 2 步就把本设备挡下、走不到本
    /// 交错窗口（该排列已由全排列矩阵与 live_foreign_lease_* 测试钉死）。
    #[tokio::test]
    async fn interleaved_rival_full_claim_in_lease_window_exactly_one_wins() {
        let marker_arms: [(Option<Vec<u8>>, ClaimExpectation, &str); 2] = [
            (None, ClaimExpectation::Absent, "空仓首次认领"),
            (
                Some(v1_marker_bytes("device-legacy")),
                ClaimExpectation::LegacyV1,
                "v1 升级",
            ),
        ];
        for (initial_marker, exp, arm_name) in marker_arms {
            for initial_lease in [None, Some(lease_json("device-x", -5))] {
                let ctx = format!(
                    "[{arm_name} lease={}]",
                    if initial_lease.is_some() {
                        "他人过期租约"
                    } else {
                        "无"
                    }
                );
                let inner = Arc::new(MemoryStorage::default());
                if let Some(bytes) = &initial_marker {
                    CloudStorage::put(&inner, MARKER_KEY, bytes).await.unwrap();
                }
                if let Some(bytes) = &initial_lease {
                    CloudStorage::put(&inner, &lease_key(), bytes)
                        .await
                        .unwrap();
                }
                let rival_payload = v2_marker_bytes("device-rival");
                let storage = RivalClaimsBeforeOurLeasePut {
                    inner: Arc::clone(&inner),
                    rival_expectation: exp,
                    rival_payload: rival_payload.clone(),
                    triggered: AtomicBool::new(false),
                };

                let error = claim_encryption_marker(
                    &storage,
                    MARKER_KEY,
                    "device-ours",
                    DEFAULT_E2EE_CLAIM_LEASE_TTL,
                    exp,
                    build_fixed(b"marker-ours"),
                )
                .await
                .expect_err(&format!(
                    "{ctx} 对手已在本设备租约窗口内完整认领，本设备必须在第 5 步复核失败"
                ));
                assert!(
                    error.to_string().contains(SYNC_E2EE_CLAIM_CONFLICT_CODE),
                    "{ctx} 交错落败必须带稳定冲突码: {error}"
                );
                assert!(
                    storage.triggered.load(Ordering::SeqCst),
                    "{ctx} 交错必须实际发生（本设备必须走到写租约一步）"
                );
                assert_eq!(
                    inner.bytes(MARKER_KEY).as_deref(),
                    Some(rival_payload.as_slice()),
                    "{ctx} 恰好一个成功：云端标记必须是对手的认领结果，\
                     不得被本设备覆盖"
                );
                assert!(
                    inner.bytes(&lease_key()).is_none(),
                    "{ctx} 第 5 步失败后本设备必须清理自己的租约（对手租约已随其\
                     成功路径释放），云端不得残留任何租约"
                );
            }
        }
    }
}
