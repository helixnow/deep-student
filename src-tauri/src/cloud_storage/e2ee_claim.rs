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
        CloudStorage::put(&storage, &lease_key(), &big).await.unwrap();
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
}
