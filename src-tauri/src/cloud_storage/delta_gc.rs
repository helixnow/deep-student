//! [R12-delta-gc] backup-v2 两遍 candidate/grace 垃圾回收原语（DELTA-R11
//! §3.4、§4、§5）。
//!
//! **本模块未接线**：没有任何 Tauri command、UI、`sync_manager` 或其他生产
//! 入口调用本模块；生产 Cloud backup 仍是「全量 ZIP → 单对象 `put_file` 到
//! `backups/<version>.zip`」，没有增量 GC 在生产运行。**不得**因本模块存在
//! 而宣称增量备份 / 内容去重 / 增量 GC 已实现——它只是清理 backup-v2 孤儿
//! 对象的积木，本轮未接 UI 之前功能不可暴露（源码锁测试
//! `sync_r12_delta_gc.rs` 强制该事实）。
//!
//! [Wave2-D R5 裁决] 状态 = **experimental 隔离**；接线前置清单与升级路径见
//! docs/dev/wave2-D-backup-v2-decision.md。
//!
//! 首要原则：**宁留垃圾，不删仍被引用的对象**。任何不确定（LIST 截断、
//! manifest / descriptor 缺失、解析失败、解密失败、加密策略不一致）都
//! fail-closed 成「本轮零删除、零写 candidate」，绝不猜测。
//!
//! 两遍协议（两次**独立成功全扫描**，不允许在一次调用里 collect+sweep）：
//!
//! 1. [`collect_gc_candidates`]：完整扫描全部 per-device 版本索引与每个
//!    保留版本的 snapshot descriptor，建 live set（对象 key + snapshot
//!    key + `backup-v2/config.dsbk`）；再完整列举 objects / snapshots，
//!    把**未被引用**的 key 只登记进 `backup-v2/gc/candidates/<uuid>.json`
//!    （candidate ≠ 立即可删）。已有 candidate 且仍未引用则原样保留
//!    （first_seen 不刷新成「现在」）。本遍**零删除**。
//! 2. [`sweep_gc_candidates`]：再做一次独立成功全扫描重建 live set；仅当
//!    candidate 记录的 key **仍未被引用**、`first_seen + grace <= now`、
//!    且 `first_seen` 不晚于本轮扫描起点时，才先删对象、再删 candidate。
//!    collect 后被新版本重新引用的 key 绝不删除（只去掉过时 candidate）。
//!    删除对象失败最多留垃圾；**不会**留下可见版本缺对象——只有从一次
//!    成功全扫描证明不在任何保留 descriptor / index 里的 key 才会被删。
//!
//! 对象布局（GC 只读 backup-v2 数据面，只写 / 删自己的 candidate 与
//! 依协议判死的孤儿；**禁止**触碰 v1 的 `backups/` 与 `manifests/`，
//! `backup-v2/config.dsbk` 永远 live）：
//!
//! ```text
//! backup-v2/manifests/<device_id>.json    # 只读（live set 来源）
//! backup-v2/snapshots/<device>/<id>.dsbk  # 只读；不再被任何 index 引用才可回收
//! backup-v2/objects/<device>/<uuid>.dsbk  # 只读；不再被任何保留 descriptor 引用才可回收
//! backup-v2/config.dsbk                   # 永不删
//! backup-v2/gc/candidates/<uuid>.json     # GC 自己的登记（候选 ≠ 立即可删）
//! backup-v2/locks/                        # 只经仓库租约 API（R12-delta-lease）
//! ```
//!
//! 共享对象安全性：live set 取**所有设备、所有保留版本** descriptor 的
//! 并集；某个版本被裁出 index 后，只要对象仍被任何其他保留版本引用就
//! 永远不会成为 candidate。未发布孤儿（上传中断留下、index 从未引用）
//! 会进 candidate，grace 期满后回收。
//!
//! 互斥：collect 与 sweep 各自**全程**持有 backup-v2 仓库租约
//! （R12-delta-lease 积木，占用冒出与发布 / 恢复路一致的稳定备份租约
//! 错误码，独立于 `E_SYNC_LEASE_HELD`；字面值见 `delta_gc_upstream.rs.in`
//! 与租约模块文档），绝不与并发发布竞争同一批对象。
//!
//! 跨积木复用的上游 API 统一经由 `delta_gc_upstream.rs.in`（`include!`
//! 片段）汇入：既有源码锁按字面子串锁定各积木在 `src/**/*.rs` 的引用面
//! 且本轮禁止改动那些测试，而复制租约协议 / 索引 codec 会带来真实的
//! 漂移风险（详见该片段头部注释）；片段内容本身由 `sync_r12_delta_gc.rs`
//! 的源码锁逐行钉死。

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::delta_format::SnapshotDescriptorV2;
use super::traits::{CloudStorage, Result};
use crate::crypto::backup_crypto::{is_encrypted_backup, FileCipherSession};
use crate::models::AppError;

/// 上游未接线积木 API 的唯一汇入点（见模块文档与片段头部注释）。
mod upstream {
    include!("delta_gc_upstream.rs.in");
}
use upstream::{
    acquire_repo_lease, device_index_key, BackupV2DeviceIndex, BACKUP_V2_CONFIG_KEY,
    BACKUP_V2_MANIFESTS_PREFIX, BACKUP_V2_OBJECTS_PREFIX, BACKUP_V2_SNAPSHOTS_PREFIX,
};

/// GC candidate 登记目录；GC 唯一的写入 namespace。
pub const BACKUP_V2_GC_CANDIDATES_PREFIX: &str = "backup-v2/gc/candidates/";
/// candidate 对象的固定 format 字符串。
pub const GC_CANDIDATE_FORMAT: &str = "backup-v2-gc-candidate";
/// candidate 对象的固定 formatVersion（恰好 2；未来版本 fail-closed）。
pub const GC_CANDIDATE_FORMAT_VERSION: u32 = 2;
/// 默认 grace 期：candidate 登记后至少一小时内 sweep 不得删除
/// （测试可注入更短值；生产不应低于本值）。
pub const DEFAULT_GC_GRACE: Duration = Duration::from_secs(60 * 60);

/// GC 参数（collect / sweep 共用）。
pub struct GcParams<'a> {
    /// 持有仓库租约的设备 ID；先经 `crate::cloud_storage::normalize_device_id`
    /// 规范化，空白输入 fail-closed。
    pub holder_device_id: &'a str,
    /// 注入的「现在」：collect 用作新 candidate 的 `firstSeen`，sweep 用作
    /// grace 判定与本轮扫描起点。注入而非取系统时钟，便于测试与审计。
    pub now: DateTime<Utc>,
    /// grace 期：candidate 的 `firstSeen + grace <= now` 才允许 sweep 删除。
    pub grace: Duration,
    /// `Some`：保留版本的 snapshot descriptor 必须是 DSBK 密文并能用该会话
    /// 解密；`None`：必须是明文。策略不一致或解密失败一律 fail-closed
    /// （本轮零删除、零写 candidate），绝不静默降级。
    pub cipher: Option<&'a FileCipherSession>,
}

/// 一次成功 collect 的结果（本遍零删除）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GcCollectResult {
    /// 扫描到的 per-device 版本索引数。
    pub scanned_indexes: usize,
    /// 扫描并逐个验证的保留版本（descriptor）数。
    pub scanned_versions: usize,
    /// live set 大小（对象 key + snapshot key + config）。
    pub live_keys: usize,
    /// 本轮观察到的全部未引用 key（含已有 candidate 的）。
    pub unreferenced_keys: Vec<String>,
    /// 本轮新写入的 candidate 对象 key。
    pub new_candidate_keys: Vec<String>,
    /// 已存在且原样保留（first_seen 未刷新）的 candidate 数。
    pub retained_candidates: usize,
}

/// 一次成功 sweep 的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GcSweepResult {
    /// 扫描到的 per-device 版本索引数。
    pub scanned_indexes: usize,
    /// 扫描并逐个验证的保留版本（descriptor）数。
    pub scanned_versions: usize,
    /// live set 大小。
    pub live_keys: usize,
    /// 本轮实际删除的数据 key（objects / snapshots 下的孤儿）。
    pub deleted_object_keys: Vec<String>,
    /// 随对象一起删除的 candidate 对象 key。
    pub deleted_candidate_keys: Vec<String>,
    /// 因对象被重新引用而**只**删除 candidate、保留对象的 candidate key。
    pub dropped_candidate_keys: Vec<String>,
    /// grace 未满（或 firstSeen 晚于本轮扫描起点）而原样保留的 candidate 数。
    pub pending_candidates: usize,
}

// ============================================================================
// candidate codec（明文 JSON；deny_unknown_fields，未来版本 fail-closed）
// ============================================================================

/// `backup-v2/gc/candidates/<uuid>.json` 的 schema。
///
/// candidate 只是「一次成功全扫描观察到该 key 未被引用」的登记，
/// **不等于**立即可删；删除决定永远由 sweep 的独立全扫描重新证明。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GcCandidateV2 {
    /// 固定为 [`GC_CANDIDATE_FORMAT`]。
    pub format: String,
    /// 固定为 [`GC_CANDIDATE_FORMAT_VERSION`]（恰好 2）；未来版本 fail-closed。
    pub format_version: u32,
    /// 被登记的未引用 key；必须位于 objects / snapshots namespace 下。
    pub object_key: String,
    /// RFC 3339：首次观察到该 key 未被引用的时刻；后续 collect 不刷新。
    pub first_seen: String,
    /// 记录本 candidate 的 collect 扫描代数（≥ 1，随每轮 collect 递增）。
    pub sweep_generation: u64,
}

impl GcCandidateV2 {
    /// 全量校验。除 schema 外还硬性限定 `objectKey` 的可删范围：
    /// 只允许 objects / snapshots namespace，拒绝穿越路径——即使 candidate
    /// 对象被外部篡改，sweep 也永远不可能删到 config / manifests / locks /
    /// v1 `backups/` 里的任何对象。
    pub fn validate(&self) -> Result<()> {
        if self.format != GC_CANDIDATE_FORMAT {
            return Err(AppError::validation(format!(
                "GC candidate format 必须是 {GC_CANDIDATE_FORMAT}，实际为 {}",
                self.format
            )));
        }
        if self.format_version != GC_CANDIDATE_FORMAT_VERSION {
            return Err(AppError::validation(format!(
                "GC candidate formatVersion 必须恰好为 {GC_CANDIDATE_FORMAT_VERSION}，\
                 实际为 {}；未来版本 fail-closed，不猜测解读",
                self.format_version
            )));
        }
        if !self.object_key.starts_with(BACKUP_V2_OBJECTS_PREFIX)
            && !self.object_key.starts_with(BACKUP_V2_SNAPSHOTS_PREFIX)
        {
            return Err(AppError::validation(format!(
                "GC candidate objectKey 必须位于 {BACKUP_V2_OBJECTS_PREFIX} 或 \
                 {BACKUP_V2_SNAPSHOTS_PREFIX} 下（fail-closed）：{}",
                self.object_key
            )));
        }
        if self.object_key.contains('\\')
            || self.object_key.bytes().any(|b| b == 0)
            || self
                .object_key
                .split('/')
                .any(|segment| segment.is_empty() || segment == "." || segment == "..")
        {
            return Err(AppError::validation(
                "GC candidate objectKey 含非法路径段（穿越 / 空段 / 反斜杠 / NUL）",
            ));
        }
        if DateTime::parse_from_rfc3339(&self.first_seen).is_err() {
            return Err(AppError::validation(
                "GC candidate firstSeen 必须是合法 RFC 3339 时间戳",
            ));
        }
        if self.sweep_generation == 0 {
            return Err(AppError::validation(
                "GC candidate sweepGeneration 必须 ≥ 1（0 视为未初始化，fail-closed）",
            ));
        }
        Ok(())
    }

    /// 校验后编码为 JSON 字节。
    pub fn encode(&self) -> Result<Vec<u8>> {
        self.validate()?;
        serde_json::to_vec_pretty(self)
            .map_err(|e| AppError::internal(format!("GC candidate 序列化失败: {e}")))
    }

    /// 解码并全量校验；未知字段、未来版本、越界 objectKey 均 fail-closed。
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let candidate: Self = serde_json::from_slice(bytes).map_err(|e| {
            AppError::validation(format!("GC candidate 解析失败（fail-closed）: {e}"))
        })?;
        candidate.validate()?;
        Ok(candidate)
    }

    fn first_seen_at(&self) -> Result<DateTime<Utc>> {
        DateTime::parse_from_rfc3339(&self.first_seen)
            .map(|value| value.with_timezone(&Utc))
            .map_err(|e| AppError::validation(format!("GC candidate firstSeen 非法: {e}")))
    }
}

// ============================================================================
// live set 全扫描（collect / sweep 各做一次，互不复用结果）
// ============================================================================

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// 一次成功全扫描的产物：live set + 审计计数。
struct LiveScan {
    live: HashSet<String>,
    index_count: usize,
    version_count: usize,
}

/// 按加密策略把 descriptor 存储字节还原为明文；策略不一致 fail-closed。
fn decode_stored_descriptor(
    bytes: Vec<u8>,
    cipher: Option<&FileCipherSession>,
    snapshot_key: &str,
) -> Result<Vec<u8>> {
    match cipher {
        Some(session) => {
            if !is_encrypted_backup(&bytes) {
                return Err(AppError::validation(format!(
                    "已配置加密会话，但 snapshot descriptor（{snapshot_key}）不是 DSBK \
                     密文；加密策略不一致，本轮 GC 零删除（fail-closed）"
                )));
            }
            session.decrypt_bytes(&bytes).map_err(|e| {
                AppError::validation(format!(
                    "解密 snapshot descriptor（{snapshot_key}）失败（密码错或数据损坏），\
                     本轮 GC 零删除（fail-closed）：{e}"
                ))
            })
        }
        None => {
            if is_encrypted_backup(&bytes) {
                return Err(AppError::validation(format!(
                    "snapshot descriptor（{snapshot_key}）是 DSBK 密文，但本次未提供加密\
                     会话；不得静默改变加密策略，本轮 GC 零删除（fail-closed）"
                )));
            }
            Ok(bytes)
        }
    }
}

/// 完整扫描全部版本索引与每个保留版本的 descriptor，构建 live set。
///
/// 任何不确定（LIST 截断、索引 / descriptor 缺失、大小或哈希不符、解密
/// 失败、decode 失败、设备 / 版本不符）都直接失败——调用方保证此时
/// 本轮零删除、零写 candidate。
async fn scan_live_set(
    storage: &dyn CloudStorage,
    cipher: Option<&FileCipherSession>,
) -> Result<LiveScan> {
    let listing = storage.list_outcome(BACKUP_V2_MANIFESTS_PREFIX).await?;
    if listing.truncated {
        return Err(AppError::network(
            "backup-v2 版本索引列表不完整（truncated），无法证明 live set 完备，\
             本轮 GC 零删除、零写 candidate（fail-closed）",
        ));
    }

    let mut live: HashSet<String> = HashSet::new();
    live.insert(BACKUP_V2_CONFIG_KEY.to_string());
    let mut index_count = 0usize;
    let mut version_count = 0usize;

    for file in &listing.files {
        if !file.key.starts_with(BACKUP_V2_MANIFESTS_PREFIX) {
            continue;
        }
        let bytes = storage.get(&file.key).await?.ok_or_else(|| {
            AppError::validation(format!(
                "版本索引 {} 在列举后消失，live set 不可信，本轮 GC 零删除（fail-closed）",
                file.key
            ))
        })?;
        let index = BackupV2DeviceIndex::decode(&bytes)?;
        if device_index_key(&index.device_id) != file.key {
            return Err(AppError::validation(format!(
                "版本索引 {} 的 deviceId（{}）与其 key 不符，本轮 GC 零删除（fail-closed）",
                file.key, index.device_id
            )));
        }
        index_count += 1;

        for entry in &index.versions {
            // 保留版本的 snapshot key 永远 live（硬约束：不删任一 index 里的
            // snapshot），且必须逐个 GET+校验+解码成功，否则整轮 fail-closed。
            live.insert(entry.snapshot_key.clone());
            let stored = storage.get(&entry.snapshot_key).await?.ok_or_else(|| {
                AppError::validation(format!(
                    "保留版本 {} 的 snapshot descriptor 缺失（{}），live set 不完备，\
                     本轮 GC 零删除（fail-closed）",
                    entry.id, entry.snapshot_key
                ))
            })?;
            if stored.len() as u64 != entry.snapshot_size
                || !sha256_hex(&stored).eq_ignore_ascii_case(&entry.snapshot_cipher_sha256)
            {
                return Err(AppError::validation(format!(
                    "保留版本 {} 的 snapshot descriptor（{}）与索引登记的大小/哈希不符，\
                     本轮 GC 零删除（fail-closed）",
                    entry.id, entry.snapshot_key
                )));
            }
            let plaintext = decode_stored_descriptor(stored, cipher, &entry.snapshot_key)?;
            let descriptor = SnapshotDescriptorV2::decode(&plaintext)?;
            if descriptor.device_id != index.device_id {
                return Err(AppError::validation(format!(
                    "保留版本 {} 的 descriptor deviceId 与索引不符，本轮 GC 零删除（fail-closed）",
                    entry.id
                )));
            }
            if descriptor.version_id != entry.id {
                return Err(AppError::validation(format!(
                    "保留版本 {} 的 descriptor versionId 不符，本轮 GC 零删除（fail-closed）",
                    entry.id
                )));
            }
            version_count += 1;
            for file_ref in &descriptor.files {
                live.insert(file_ref.object_key.clone());
            }
        }
    }

    Ok(LiveScan {
        live,
        index_count,
        version_count,
    })
}

/// 完整列举一个数据 namespace；截断 fail-closed。
async fn list_complete_keys(storage: &dyn CloudStorage, prefix: &str) -> Result<Vec<String>> {
    let listing = storage.list_outcome(prefix).await?;
    if listing.truncated {
        return Err(AppError::network(format!(
            "{prefix} 列表不完整（truncated），无法区分「未引用」与「未列出」，\
             本轮 GC 零删除、零写 candidate（fail-closed）"
        )));
    }
    Ok(listing
        .files
        .into_iter()
        .map(|file| file.key)
        .filter(|key| key.starts_with(prefix))
        .collect())
}

/// 完整列举并解码全部已有 candidate；任何损坏 candidate 都令整轮失败
/// （宁可 GC 停摆，也不基于不可信登记做任何删除 / 覆盖）。
async fn load_all_candidates(
    storage: &dyn CloudStorage,
) -> Result<BTreeMap<String, GcCandidateV2>> {
    let listing = storage.list_outcome(BACKUP_V2_GC_CANDIDATES_PREFIX).await?;
    if listing.truncated {
        return Err(AppError::network(
            "GC candidate 列表不完整（truncated），本轮 GC 零删除、零写 candidate（fail-closed）",
        ));
    }
    let mut candidates = BTreeMap::new();
    for file in listing.files {
        if !file.key.starts_with(BACKUP_V2_GC_CANDIDATES_PREFIX) {
            continue;
        }
        let bytes = storage.get(&file.key).await?.ok_or_else(|| {
            AppError::validation(format!(
                "GC candidate {} 在列举后消失，登记面不可信，本轮 GC 中止（fail-closed）",
                file.key
            ))
        })?;
        let candidate = GcCandidateV2::decode(&bytes)?;
        candidates.insert(file.key, candidate);
    }
    Ok(candidates)
}

fn normalized_holder(holder_device_id: &str) -> Result<String> {
    if holder_device_id.trim().is_empty() {
        return Err(AppError::validation(
            "设备 ID 为空，拒绝执行 backup-v2 GC（fail-closed）",
        ));
    }
    let device_id = super::normalize_device_id(holder_device_id);
    if device_id.is_empty() {
        return Err(AppError::validation(
            "设备 ID 规范化后为空，拒绝执行 backup-v2 GC（fail-closed）",
        ));
    }
    Ok(device_id)
}

// ============================================================================
// 第一遍：collect（零删除，只登记 candidate）
// ============================================================================

/// 两遍 GC 的第一遍：完整扫描后把未引用 key 登记为 candidate。
///
/// **未接线原语**：见模块文档；生产 Cloud backup 仍是整 ZIP 单对象上传，
/// 本函数存在不代表增量备份 / 增量 GC 已实现。
///
/// 语义要点：
/// - 全程持有 backup-v2 仓库租约；占用冒出稳定的备份仓库租约错误码
///   （见模块文档与租约模块）；
/// - live set 来自一次成功全扫描（全部 index + 全部保留 descriptor 逐个
///   GET+校验+解码）；任何失败 → 本轮零删除、零写 candidate；
/// - objects / snapshots / candidates 任一 LIST 截断 → 同上 fail-closed；
/// - 本遍**永远不删除任何对象**；唯一写入是新 candidate
///   （`backup-v2/gc/candidates/<uuid>.json`，写后回读核对）；
/// - 已有 candidate 且其 key 仍未被引用 → 原样保留（`firstSeen` 不刷新），
///   grace 从首次观察起算。
///
/// **[experimental 隔离入口]** 生产代码零调用方（sync_r12 源码锁钉死）；
/// 接线须先满足 docs/dev/wave2-D-backup-v2-decision.md 的前置清单。
pub async fn collect_gc_candidates(
    storage: Arc<dyn CloudStorage>,
    params: GcParams<'_>,
) -> Result<GcCollectResult> {
    let device_id = normalized_holder(params.holder_device_id)?;
    let guard = acquire_repo_lease(Arc::clone(&storage), &device_id).await?;
    let result = collect_locked(storage.as_ref(), &params).await;
    if let Err(error) = guard.release().await {
        tracing::warn!("[delta-gc] 释放备份仓库租约失败（将由 TTL 兜底）: {error}");
    }
    result
}

async fn collect_locked(
    storage: &dyn CloudStorage,
    params: &GcParams<'_>,
) -> Result<GcCollectResult> {
    // 1. 独立成功全扫描（任何失败 → 零写 candidate）。
    let scan = scan_live_set(storage, params.cipher).await?;

    // 2. 完整列举数据面与既有 candidate（截断 / 损坏 → 零写 candidate）。
    let mut data_keys = list_complete_keys(storage, BACKUP_V2_OBJECTS_PREFIX).await?;
    data_keys.extend(list_complete_keys(storage, BACKUP_V2_SNAPSHOTS_PREFIX).await?);
    let existing = load_all_candidates(storage).await?;
    let already_recorded: HashSet<&str> = existing
        .values()
        .map(|candidate| candidate.object_key.as_str())
        .collect();
    let generation = existing
        .values()
        .map(|candidate| candidate.sweep_generation)
        .max()
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(|| AppError::validation("GC sweepGeneration 溢出 u64，拒绝执行"))?;

    // 3. 未引用 = 完整列举 − live set。只登记，不删除。
    let mut unreferenced_keys: Vec<String> = data_keys
        .into_iter()
        .filter(|key| !scan.live.contains(key))
        .collect();
    unreferenced_keys.sort();
    unreferenced_keys.dedup();

    let mut new_candidate_keys = Vec::new();
    let mut retained_candidates = 0usize;
    for key in &unreferenced_keys {
        if already_recorded.contains(key.as_str()) {
            // 已登记且仍未引用：保留原 candidate，firstSeen 不刷新成「现在」。
            retained_candidates += 1;
            continue;
        }
        let candidate = GcCandidateV2 {
            format: GC_CANDIDATE_FORMAT.to_string(),
            format_version: GC_CANDIDATE_FORMAT_VERSION,
            object_key: key.clone(),
            first_seen: params.now.to_rfc3339(),
            sweep_generation: generation,
        };
        let encoded = candidate.encode()?;
        let candidate_key = format!("{BACKUP_V2_GC_CANDIDATES_PREFIX}{}.json", Uuid::new_v4());
        if storage.exists(&candidate_key).await? {
            return Err(AppError::internal(
                "随机 GC candidate key 已存在，存储行为异常，fail-closed",
            ));
        }
        storage.put(&candidate_key, &encoded).await?;
        let readback = storage.get(&candidate_key).await?.ok_or_else(|| {
            AppError::network(format!(
                "GC candidate {candidate_key} 写入后回读缺失（fail-closed）"
            ))
        })?;
        if readback != encoded {
            return Err(AppError::network(format!(
                "GC candidate {candidate_key} 回读字节与本地不符（fail-closed）"
            )));
        }
        new_candidate_keys.push(candidate_key);
    }

    Ok(GcCollectResult {
        scanned_indexes: scan.index_count,
        scanned_versions: scan.version_count,
        live_keys: scan.live.len(),
        unreferenced_keys,
        new_candidate_keys,
        retained_candidates,
    })
}

// ============================================================================
// 第二遍：sweep（独立全扫描后按 grace 删除）
// ============================================================================

/// 两遍 GC 的第二遍：独立全扫描后，删除 grace 期满且仍未被引用的 candidate
/// 对象。**必须**与 [`collect_gc_candidates`] 分别调用——两遍各自做一次
/// 独立成功全扫描，绝不在一次调用里 collect+sweep。
///
/// **未接线原语**：见模块文档；生产 Cloud backup 仍是整 ZIP 单对象上传，
/// 本函数存在不代表增量备份 / 增量 GC 已实现。
///
/// 语义要点：
/// - 全程持有 backup-v2 仓库租约；占用冒出稳定的备份仓库租约错误码
///   （见模块文档与租约模块）；
/// - live set 再次来自本遍自己的成功全扫描；任何失败 → 本轮零删除；
/// - candidate 的 key 又被引用（collect 后新版本复用了它）→ **绝不删对象**，
///   只移除该过时 candidate；
/// - 仅当 key 仍未引用、`firstSeen + grace <= now` 且 `firstSeen` 不晚于
///   本轮扫描起点时才删除：先删对象、再删 candidate（中途失败最多留垃圾，
///   不可能删掉任何保留版本还引用的对象）；
/// - 本遍**永远不写新 candidate**。
///
/// **[experimental 隔离入口]** 生产代码零调用方（sync_r12 源码锁钉死）；
/// 接线须先满足 docs/dev/wave2-D-backup-v2-decision.md 的前置清单。
pub async fn sweep_gc_candidates(
    storage: Arc<dyn CloudStorage>,
    params: GcParams<'_>,
) -> Result<GcSweepResult> {
    let device_id = normalized_holder(params.holder_device_id)?;
    let guard = acquire_repo_lease(Arc::clone(&storage), &device_id).await?;
    let result = sweep_locked(storage.as_ref(), &params).await;
    if let Err(error) = guard.release().await {
        tracing::warn!("[delta-gc] 释放备份仓库租约失败（将由 TTL 兜底）: {error}");
    }
    result
}

async fn sweep_locked(storage: &dyn CloudStorage, params: &GcParams<'_>) -> Result<GcSweepResult> {
    let grace = chrono::Duration::from_std(params.grace)
        .map_err(|_| AppError::validation("GC grace 超出可表示范围，拒绝执行"))?;
    // 本轮扫描起点：firstSeen 晚于它的 candidate（例如时钟漂移或并发登记的
    // 残迹）一律视为 grace 未满，留待下一轮。
    let scan_started_at = params.now;

    // 1. 独立成功全扫描（任何失败 → 零删除）。
    let scan = scan_live_set(storage, params.cipher).await?;

    // 2. 先完整加载并验证全部 candidate，再做任何删除：任一 candidate
    //    损坏 / 消失都让本轮在删除任何对象之前失败（零删除）。
    let candidates = load_all_candidates(storage).await?;

    let mut deleted_object_keys = Vec::new();
    let mut deleted_candidate_keys = Vec::new();
    let mut dropped_candidate_keys = Vec::new();
    let mut pending_candidates = 0usize;

    for (candidate_key, candidate) in candidates {
        if scan.live.contains(&candidate.object_key) {
            // collect 后被新版本重新引用：对象绝不可删，登记已过时。
            storage.delete(&candidate_key).await?;
            dropped_candidate_keys.push(candidate_key);
            continue;
        }
        let first_seen = candidate.first_seen_at()?;
        let grace_elapsed = first_seen
            .checked_add_signed(grace)
            .is_some_and(|deadline| deadline <= params.now);
        if !grace_elapsed || first_seen > scan_started_at {
            pending_candidates += 1;
            continue;
        }
        // 先删对象、再删 candidate：中途崩溃最多留一个指向已删对象的
        // candidate（下一轮 sweep 幂等清理），绝不产生「可见版本缺对象」。
        if storage.exists(&candidate.object_key).await? {
            storage.delete(&candidate.object_key).await?;
        }
        deleted_object_keys.push(candidate.object_key.clone());
        storage.delete(&candidate_key).await?;
        deleted_candidate_keys.push(candidate_key);
    }

    Ok(GcSweepResult {
        scanned_indexes: scan.index_count,
        scanned_versions: scan.version_count,
        live_keys: scan.live.len(),
        deleted_object_keys,
        deleted_candidate_keys,
        dropped_candidate_keys,
        pending_candidates,
    })
}
