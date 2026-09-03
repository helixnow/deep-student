//! 云同步管理器
//!
//! 基于 ZIP 备份管线，提供云端版本管理、上传、下载功能

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::Path;
use uuid::Uuid;

use super::bad_object::{converge_bad_object, BadObjectOutcome};
use super::traits::{CloudStorage, Result};
use super::verified_publish::{verified_publish, PublishRecovery, PublishSpec};
use crate::models::AppError;

/// 云端 Manifest 文件名
const MANIFEST_FILE: &str = "manifest.json";
const MANIFEST_BACKUP_FILE: &str = "manifest.json.bak";
const MANIFESTS_DIR: &str = "manifests";
/// 备份文件目录
const BACKUPS_DIR: &str = "backups";
/// 默认保留版本数
const DEFAULT_MAX_VERSIONS: usize = 10;
/// [R12-neutral-names] 新备份对象名：22 位随机字母数字，不含时间、不含设备短 ID。
const NEUTRAL_VERSION_ID_LEN: usize = 22;
/// [R12-neutral-names] per-device manifest 文件名与新写入 `createdByDevice` 的短哈希长度。
const DEVICE_ID_SHORT_HASH_LEN: usize = 16;
/// 云端加密标记对象（相对云 root 的路径）。
///
/// 一旦某个云 root 出现过端到端加密（DSBK）备份，就写入此标记；此后未配置
/// `encryption_password` 的设备会被拒绝向同一 root 上传明文备份，避免同一
/// 恢复链上明文/密文混布。
const ENCRYPTION_MARKER_FILE: &str = ".encryption-marker";
/// [R06-e2ee-verifier] 携带密码校验子的加密标记版本。
/// `<= 1` 的旧标记没有校验子，允许一次性升级；`>= 2` 却缺校验子按损坏处理（fail-closed）。
const ENCRYPTION_MARKER_VERSION_WITH_VERIFIER: u32 = 2;

/// [R4-publish-wire] manifest 单对象内存预算（读回 / 发布共用，接
/// [`super::verified_publish`] 原语的 `max_bytes`）。
///
/// per-device manifest 上限 10_000 个版本（`validate_manifest`），每条几百字节，
/// 正常体积远小于 4MiB；超过预算按损坏 / 敌意对象处理，fail-closed，
/// 绝不把无界字节整体拉进内存再交给 JSON 解码。
pub(crate) const MANIFEST_OBJECT_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// [R4-publish-wire] tombstone 控制对象（per-device 清单 / 不可变事件）的内存预算。
///
/// tombstone 清单是有界 JSON 列表、事件对象是单条记录，4MiB 同样冗余充足。
/// tombstone 读写物理上在 `data_governance/sync/tombstone.rs`（本轮文件红线之外）：
/// 其 `put_tombstone_manifest_and_reread`（写侧）与 `download_*_tombstones` /
/// `decode_tombstone_file` 前的 `storage.get`（读侧）应接线到
/// [`super::verified_publish::verified_publish`] / [`bounded_get_object`]
/// 并使用本预算。
#[allow(dead_code)] // tombstone.rs 侧的接线在本文件红线之外，预算先就位。
pub(crate) const TOMBSTONE_OBJECT_MAX_BYTES: u64 = 4 * 1024 * 1024;

pub(crate) fn normalize_device_id(device_id: &str) -> String {
    let trimmed = device_id.trim();
    if !trimmed.is_empty()
        && trimmed.len() <= 128
        && !matches!(trimmed, "." | "..")
        && trimmed
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return trimmed.to_string();
    }

    let mut hasher = Sha256::new();
    hasher.update(trimmed.as_bytes());
    format!("device-{}", hex::encode(hasher.finalize()))
}

/// [R12-neutral-names] 设备 ID 短哈希（SHA256 hex 前缀）。
///
/// 用于 `manifests/<hash>.json` 与新写入的 `.encryption-marker.createdByDevice`。
/// 完整 device_id 仍写在 manifest 内容的 `deviceId` 字段；旧 `manifests/<device_id>.json`
/// 读取侧继续兼容。调用方应传入已经 [`normalize_device_id`] 过的值。
pub fn device_id_short_hash(device_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(device_id.as_bytes());
    hex::encode(hasher.finalize())
        .chars()
        .take(DEVICE_ID_SHORT_HASH_LEN)
        .collect()
}

/// [R4-publish-wire] bounded GET：控制对象（manifest / tombstone 清单 / 事件）的
/// 内存级读取闸——[`super::verified_publish`] 原语内部有界回读的读侧对应物
///（该模块未导出独立的 bounded GET，故读侧原语放在这里，pub(crate) 供
/// tombstone 等其它控制对象读路径接线）。
///
/// `get()` 是整体缓冲语义，预算分两道拦：读前按 `stat` 声明大小拒绝超预算对象
///（不把无界字节拉进内存），读后按实收字节再核一次（对象可能在 stat 与 get
/// 之间被并发替换，或后端无 stat 能力）。两道任一超限都 fail-closed 并带
/// key / 字节数供审计。传输层错误原样冒泡，不与预算违规混淆。
pub(crate) async fn bounded_get_object(
    storage: &dyn CloudStorage,
    key: &str,
    max_bytes: u64,
    object_kind: &str,
) -> Result<Option<Vec<u8>>> {
    if let Some(info) = storage.stat(key).await? {
        if info.size > max_bytes {
            return Err(AppError::validation(format!(
                "{object_kind} 对象 {key} 声明 {} 字节，超过 {max_bytes} 字节预算，已拒绝读取（fail-closed）",
                info.size
            )));
        }
    }
    match storage.get(key).await? {
        Some(data) => {
            if data.len() as u64 > max_bytes {
                return Err(AppError::validation(format!(
                    "{object_kind} 对象 {key} 实收 {} 字节，超过 {max_bytes} 字节预算，已拒绝读取（fail-closed）",
                    data.len()
                )));
            }
            Ok(Some(data))
        }
        None => Ok(None),
    }
}

/// [R12-neutral-names] 新备份版本 ID：纯随机，不编码时间或设备。
fn generate_neutral_version_id() -> String {
    let mut id = String::with_capacity(NEUTRAL_VERSION_ID_LEN);
    while id.len() < NEUTRAL_VERSION_ID_LEN {
        id.push_str(&Uuid::new_v4().simple().to_string());
    }
    id.truncate(NEUTRAL_VERSION_ID_LEN);
    id
}

/// 备份版本信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupVersion {
    /// 版本 ID。新上传为 22 位随机字母数字；历史版本可能仍是
    /// `YYYYMMDD-HHMMSS-毫秒-设备短ID-nonce`。下载/裁剪按 manifest `id` 查找，不解析文件名。
    pub id: String,
    /// 创建时间
    pub timestamp: DateTime<Utc>,
    /// 文件大小（字节）
    pub size: u64,
    /// SHA256 校验和
    pub checksum: String,
    /// 来源设备 ID
    pub device_id: String,
    /// 应用版本
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_version: Option<String>,
    /// 备注
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// 导入后能否整槽恢复。旧清单没有该字段，按未知处理。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_kind: Option<String>,
}

/// 云端 Manifest
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudManifest {
    /// Manifest 版本
    pub version: u32,
    /// 最新备份的版本 ID
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest: Option<String>,
    /// 所有备份版本列表（按时间倒序）
    pub versions: Vec<BackupVersion>,
    /// 最后更新时间
    pub updated_at: DateTime<Utc>,
}

impl Default for CloudManifest {
    fn default() -> Self {
        Self {
            version: 1,
            latest: None,
            versions: Vec::new(),
            updated_at: Utc::now(),
        }
    }
}

/// 云端加密标记
///
/// 该对象存在即表示对应云 root 出现过端到端加密备份：
/// - 明文上传判定只看「对象是否存在」（内容损坏时按存在处理，fail-closed）；
/// - [R06-e2ee-verifier] 加密上传前还要比对 `key_verifier` 中的不可逆密码
///   校验子，防止配错密码的设备向同一 root 写入另一套无法互解的密文。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptionMarker {
    /// 标记格式版本
    pub version: u32,
    /// 首次写入标记的设备 ID
    pub created_by_device: String,
    /// 首次写入时间
    pub created_at: DateTime<Utc>,
    /// [R06] 密码校验子（不可逆；旧标记无此字段）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_verifier: Option<crate::crypto::backup_crypto::PasswordVerifier>,
}

/// 云端加密标记的三态读取结果（内部使用）。
///
/// 与对外的 `read_encryption_marker` 不同，这里把「内容损坏」与「合法旧标记」
/// 区分开：密码校验路径对损坏标记必须 fail-closed，而不能把它当成可升级的旧标记。
enum EncryptionMarkerState {
    /// 云端不存在标记
    Absent,
    /// 标记存在且可解析
    Present(EncryptionMarker),
    /// 标记对象存在但内容无法解析
    Corrupted,
}

/// 同步状态
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    /// 是否已连接
    pub connected: bool,
    /// 云端版本数
    pub cloud_version_count: usize,
    /// 最新云端版本信息
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<BackupVersion>,
    /// 本地最后同步时间
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sync_time: Option<DateTime<Utc>>,
    /// 错误信息
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// [P11] 上次「本机加密目录记忆」持久化失败状态（`None` = 最近一次登记成功
    /// 或本进程内从未失败）。失败不阻断云操作，但第二道明文防线在本机降级，
    /// 必须暴露给设置页。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encryption_memory_persist_failure: Option<EncryptionMemoryPersistFailure>,
}

/// [P11] 「本机加密目录记忆」持久化失败的可查询状态。
///
/// 只携带稳定错误码与发生时间：文案由前端 i18n 渲染，不在后端堆用户可见英文长句。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptionMemoryPersistFailure {
    /// 稳定错误码（恒为 [`super::SYNC_E2EE_MEMORY_PERSIST_FAILED_CODE`]）
    pub code: String,
    /// 失败发生时间
    pub at: DateTime<Utc>,
}

/// [P11] 进程内最近一次 remember 失败（成功后清除）。记忆文件本身写不进磁盘时
/// 无法可靠地把失败状态也持久化到同一磁盘，故采用进程内状态：设置页每次查询
/// 同步状态都会读到本进程的最新登记结果。
static LAST_ENCRYPTION_MEMORY_PERSIST_FAILURE: std::sync::Mutex<
    Option<EncryptionMemoryPersistFailure>,
> = std::sync::Mutex::new(None);

fn record_encryption_memory_persist_failure() {
    if let Ok(mut slot) = LAST_ENCRYPTION_MEMORY_PERSIST_FAILURE.lock() {
        *slot = Some(EncryptionMemoryPersistFailure {
            code: super::SYNC_E2EE_MEMORY_PERSIST_FAILED_CODE.to_string(),
            at: Utc::now(),
        });
    }
}

fn clear_encryption_memory_persist_failure() {
    if let Ok(mut slot) = LAST_ENCRYPTION_MEMORY_PERSIST_FAILURE.lock() {
        *slot = None;
    }
}

/// [P11] 查询上次「本机加密目录记忆」持久化失败状态（`None` = 无失败）。
pub fn last_encryption_memory_persist_failure() -> Option<EncryptionMemoryPersistFailure> {
    LAST_ENCRYPTION_MEMORY_PERSIST_FAILURE
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
}

/// 上传结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadResult {
    /// 上传的版本信息
    pub version: BackupVersion,
    /// 是否删除了旧版本
    pub pruned_versions: Vec<String>,
}

/// 下载结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    /// 下载的版本信息
    pub version: BackupVersion,
    /// 本地保存路径
    pub local_path: String,
}

/// 云同步管理器
pub struct CloudSyncManager {
    storage: Box<dyn CloudStorage>,
    device_id: String,
    max_versions: usize,
    /// [R10-verifier] 本机「该云端目录曾经加密」记忆（第二道明文上传门禁）。
    /// `None` = 本机数据目录不可用（如未初始化的测试环境），退化为仅云端标记判定。
    encryption_memory: Option<crate::crypto::backup_crypto::EncryptedRootMemory>,
    /// [R4-e2ee-cas] 加密标记认领租约 TTL（生产用默认 60s；短 TTL 供协议测试）。
    e2ee_claim_lease_ttl: std::time::Duration,
    /// [R4-e2ee-cas] 上传前策略检查确认过的 `.encryption-marker` 原始字节。
    /// 发布 manifest 前复验云端标记仍逐字节一致（[`Self::ensure_marker_unchanged_before_publish`]），
    /// 拦截「认领竞态双方都短暂报成功」后的双发布与上传期间的标记篡改。
    /// `None` = 本实例尚未做过带标记的策略检查（明文路径 / 直调 upload 的旧
    /// 路径），复验跳过，保持现行为不收紧。
    publish_marker_expectation: std::sync::Mutex<Option<Vec<u8>>>,
}

/// [R10-verifier] 默认记忆文件：`<app_data_dir>/.cloud-encrypted-roots.json`
/// （与 `.device_id` 同根）。
fn default_encryption_root_memory() -> Option<crate::crypto::backup_crypto::EncryptedRootMemory> {
    crate::data_space::get_data_space_manager().map(|manager| {
        crate::crypto::backup_crypto::EncryptedRootMemory::at(
            manager.base_dir().join(".cloud-encrypted-roots.json"),
        )
    })
}

/// [R5-prove-cost] 首块快路径对单个备份版本的判定结果。
///
/// 快路径失败（口令错误 / 首块损坏 / 前缀读不完整）以 `Err` 直接返回，
/// **不会**再整包重试同一对象——v2 首块的 AEAD 结论已是该对象的终局。
enum FirstChunkProveOutcome {
    /// 已有终局结论：v2 首块试解通过，或（允许时）判定为历史明文 ZIP。
    Settled,
    /// v1 单块容器：单个 AEAD tag 覆盖全文，无法部分试解，须整文件回退路径。
    LegacyV1NeedsWholeFile,
}

impl CloudSyncManager {
    /// 创建云同步管理器
    pub fn new(storage: Box<dyn CloudStorage>, device_id: String) -> Self {
        Self {
            storage,
            device_id: normalize_device_id(&device_id),
            max_versions: DEFAULT_MAX_VERSIONS,
            encryption_memory: default_encryption_root_memory(),
            e2ee_claim_lease_ttl: super::e2ee_claim::DEFAULT_E2EE_CLAIM_LEASE_TTL,
            publish_marker_expectation: std::sync::Mutex::new(None),
        }
    }

    /// [R4-e2ee-cas] 覆盖认领租约 TTL（测试钩子；生产走 [`Self::new`] 默认值）。
    pub fn with_e2ee_claim_lease_ttl(mut self, ttl: std::time::Duration) -> Self {
        self.e2ee_claim_lease_ttl = ttl;
        self
    }

    /// 设置最大保留版本数
    pub fn with_max_versions(mut self, max: usize) -> Self {
        self.max_versions = max.max(1); // 至少保留 1 个版本
        self
    }

    /// [R10-verifier] 注入本机加密目录记忆存储（测试钩子；生产走 [`Self::new`] 默认路径）。
    pub fn with_encryption_root_memory(
        mut self,
        memory: crate::crypto::backup_crypto::EncryptedRootMemory,
    ) -> Self {
        self.encryption_memory = Some(memory);
        self
    }

    /// [R10-verifier] 本机登记「该云端目录曾经加密」（幂等，失败只警告不阻断：
    /// 记忆是第二道防线，云端标记仍是第一道门禁）。
    ///
    /// [P11] 失败/成功会同步更新进程内「上次 remember 失败」状态，经
    /// [`SyncStatus::encryption_memory_persist_failure`] 暴露到设置页；
    /// fail-closed：失败时记忆未写入，[`Self::encrypted_root_remembered_locally`]
    /// 仍从文件实读，不会假装已写入。
    fn remember_encrypted_root(&self) {
        if let Some(memory) = &self.encryption_memory {
            let fingerprint = crate::crypto::backup_crypto::EncryptedRootMemory::fingerprint(
                &self.storage.instance_binding_hint(),
            );
            match memory.remember(&fingerprint) {
                Ok(()) => clear_encryption_memory_persist_failure(),
                Err(error) => {
                    tracing::warn!("登记本机加密目录记忆失败（不阻断本次操作）: {error}");
                    record_encryption_memory_persist_failure();
                }
            }
        }
    }

    /// [R10-verifier] 本机是否记得该云端目录曾经加密。
    /// [R6 双门] `pub(crate)`：`cloud_sync_download` 防降级用作 marker 被删时的第二道门。
    pub(crate) fn encrypted_root_remembered_locally(&self) -> bool {
        self.encryption_memory.as_ref().is_some_and(|memory| {
            memory.was_encrypted(
                &crate::crypto::backup_crypto::EncryptedRootMemory::fingerprint(
                    &self.storage.instance_binding_hint(),
                ),
            )
        })
    }

    /// 获取设备 ID
    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    /// [R12-neutral-names] 新写入的 per-device manifest 文件名用短哈希，不再暴露完整 device_id。
    fn device_manifest_key(&self) -> String {
        format!(
            "{}/{}.json",
            MANIFESTS_DIR,
            device_id_short_hash(&self.device_id)
        )
    }

    /// 旧客户端写下的 `manifests/<device_id>.json`。读取时与新名合并，写入成功后删除。
    fn device_manifest_legacy_key(&self) -> String {
        format!("{}/{}.json", MANIFESTS_DIR, self.device_id)
    }

    /// 读取本设备清单：新短哈希名优先，并入旧 device_id 文件名，避免升级后从空清单再写造成双源分叉。
    async fn load_own_device_manifests(
        &self,
    ) -> Result<(Option<CloudManifest>, Option<CloudManifest>)> {
        let new_key = self.device_manifest_key();
        let legacy_key = self.device_manifest_legacy_key();
        let current = self.read_manifest_key(&new_key).await?;
        let legacy = if new_key == legacy_key {
            None
        } else {
            self.read_manifest_key(&legacy_key).await?
        };
        Ok((current, legacy))
    }

    fn merge_manifest(target: &mut CloudManifest, incoming: CloudManifest) {
        let mut by_id = std::collections::BTreeMap::new();
        for version in target.versions.drain(..).chain(incoming.versions) {
            by_id.insert(version.id.clone(), version);
        }
        target.versions = by_id.into_values().collect();
        target
            .versions
            .sort_by(|a, b| b.timestamp.cmp(&a.timestamp).then_with(|| b.id.cmp(&a.id)));
        target.latest = target.versions.first().map(|v| v.id.clone());
        if incoming.updated_at > target.updated_at {
            target.updated_at = incoming.updated_at;
        }
    }

    fn validate_version_id(id: &str) -> Result<()> {
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(AppError::validation(format!(
                "云端备份版本 ID 非法: {id:?}"
            )));
        }
        Ok(())
    }

    fn validate_manifest(key: &str, manifest: &CloudManifest) -> Result<()> {
        const MAX_MANIFEST_VERSIONS: usize = 10_000;
        if manifest.versions.len() > MAX_MANIFEST_VERSIONS {
            return Err(AppError::validation(format!(
                "manifest {key} 版本数量异常: {}",
                manifest.versions.len()
            )));
        }

        let mut seen = HashSet::with_capacity(manifest.versions.len());
        for version in &manifest.versions {
            Self::validate_version_id(&version.id)?;
            if !seen.insert(version.id.as_str()) {
                return Err(AppError::validation(format!(
                    "manifest {key} 包含重复版本 ID: {}",
                    version.id
                )));
            }
            if version.checksum.len() != 64
                || !version
                    .checksum
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(AppError::validation(format!(
                    "manifest {key} 的版本 {} 校验和非法",
                    version.id
                )));
            }
        }

        match manifest.latest.as_deref() {
            Some(latest) if !seen.contains(latest) => Err(AppError::validation(format!(
                "manifest {key} 的 latest 未指向有效版本: {latest}"
            ))),
            None if !manifest.versions.is_empty() => Err(AppError::validation(format!(
                "manifest {key} 含版本但缺少 latest"
            ))),
            _ => Ok(()),
        }
    }

    fn decode_manifest(key: &str, data: &[u8]) -> Result<CloudManifest> {
        let manifest: CloudManifest = serde_json::from_slice(data)
            .map_err(|e| AppError::internal(format!("manifest {key} 损坏: {e}")))?;
        Self::validate_manifest(key, &manifest)?;
        Ok(manifest)
    }

    /// 读取单个 manifest 对象（bounded GET）；正式对象损坏时走恢复协议。
    ///
    /// [R4-publish-wire][P5-①] [`verified_publish`]（KeepTmp）在「发布后回读失败」
    /// 时保留已校验的暂存对象（`{key}.tmp-<op>`，历史写法为 `{key}.<uuid>.tmp`）；
    /// 这里是对应的读侧恢复协议：正式对象字节可取但解码 / 校验失败时，改用
    /// 恢复点收敛或返回（见 [`Self::recover_manifest_from_tmp`]），绝不静默用
    /// 坏正式对象成功。传输层错误与超预算对象不触发恢复，原样冒泡（前者说明
    /// 我们并不知道对象坏没坏，后者按敌意对象 fail-closed）。
    async fn read_manifest_key(&self, key: &str) -> Result<Option<CloudManifest>> {
        let data = match bounded_get_object(
            self.storage.as_ref(),
            key,
            MANIFEST_OBJECT_MAX_BYTES,
            "manifest",
        )
        .await?
        {
            Some(data) => data,
            None => return Ok(None),
        };
        match Self::decode_manifest(key, &data) {
            Ok(manifest) => Ok(Some(manifest)),
            Err(corrupt_error) => self
                .recover_manifest_from_tmp(key, corrupt_error)
                .await
                .map(Some),
        }
    }

    /// [R4-publish-wire][P5-①] 坏正式 manifest 的恢复协议：接
    /// [`super::bad_object::converge_bad_object`] 原语。
    ///
    /// - 正式对象坏 + 存在**当场重新通过完整解码/校验**的 `{key}.<uuid>.tmp`
    ///   → 原语把坏字节隔离到 `.quarantine/`（附原因记录，可审计），再用
    ///   `.tmp` 内容收敛正式对象；随后本方法有界重读正式对象返回（自动收敛）。
    /// - 原语没找到 `.tmp` 后缀候选时，桥接 [`super::verified_publish`] 原语的
    ///   暂存键命名 `{key}.tmp-<op>`（两个原语的临时键命名不一致，读侧在此
    ///   兜住，见 [`Self::recover_from_publish_tmp_residue`]）。
    /// - 两条路都无可用恢复点 → 维持 fail-closed 错误（坏字节已隔离，可审计），
    ///   绝不静默用坏正式对象成功。
    async fn recover_manifest_from_tmp(
        &self,
        key: &str,
        corrupt_error: AppError,
    ) -> Result<CloudManifest> {
        let validate = |bytes: &[u8]| -> std::result::Result<(), String> {
            Self::decode_manifest(key, bytes)
                .map(|_| ())
                .map_err(|error| error.to_string())
        };
        match converge_bad_object(self.storage.as_ref(), &self.device_id, key, &validate).await {
            Ok(BadObjectOutcome::RecoveredFromTmp {
                tmp_key,
                quarantine,
                ..
            }) => {
                tracing::warn!(
                    "manifest {} 正式对象损坏（{}），已用已校验恢复点 {} 自动收敛（坏字节隔离记录: {:?}）",
                    key,
                    corrupt_error,
                    tmp_key,
                    quarantine.as_ref().map(|record| record.quarantined_key.clone())
                );
                self.reread_converged_manifest(key, corrupt_error).await
            }
            Ok(BadObjectOutcome::AlreadyHealthy) => {
                // 我们读到坏字节后、收敛前，正式对象已被并发修复：重读一次。
                self.reread_converged_manifest(key, corrupt_error).await
            }
            Ok(BadObjectOutcome::Absent) => {
                // 正式对象在读取与收敛之间消失且无恢复点：按原损坏错误 fail-closed，
                // 不把"读到过坏字节"洗成"对象不存在"。
                Err(corrupt_error)
            }
            Err(converge_error) => match self.recover_from_publish_tmp_residue(key).await {
                Some(manifest) => Ok(manifest),
                None => Err(converge_error),
            },
        }
    }

    /// 收敛后有界重读正式对象；重读仍失败则维持原损坏错误 fail-closed。
    async fn reread_converged_manifest(
        &self,
        key: &str,
        corrupt_error: AppError,
    ) -> Result<CloudManifest> {
        let data = match bounded_get_object(
            self.storage.as_ref(),
            key,
            MANIFEST_OBJECT_MAX_BYTES,
            "manifest",
        )
        .await
        {
            Ok(Some(data)) => data,
            Ok(None) | Err(_) => return Err(corrupt_error),
        };
        Self::decode_manifest(key, &data).map_err(|_| corrupt_error)
    }

    /// [R4-publish-wire] 命名桥：[`super::verified_publish`] 原语的暂存键是
    /// `{key}.tmp-<op>`（不以 `.tmp` 结尾），[`converge_bad_object`] 只认
    /// `{key}.<uuid>.tmp` 后缀候选，两者对不上。发布失败留下的 `.tmp-*`
    /// 恢复点由本方法兜住：有界读取 + 当场完整解码/校验，最新可信者胜出，
    /// 并尽力把恢复内容经 verified publish 收敛回正式 key（收敛失败只警告，
    /// 本次读取仍返回已校验的恢复内容）。全部候选不可用时返回 `None`，
    /// 由调用方维持 fail-closed 错误。
    async fn recover_from_publish_tmp_residue(&self, key: &str) -> Option<CloudManifest> {
        let candidates = match self.storage.list(&format!("{key}.tmp-")).await {
            Ok(files) => files,
            Err(error) => {
                tracing::warn!(
                    "枚举 manifest {} 的 .tmp-* 发布残留失败（维持 fail-closed）: {}",
                    key,
                    error
                );
                return None;
            }
        };
        for candidate in candidates {
            let data = match bounded_get_object(
                self.storage.as_ref(),
                &candidate.key,
                MANIFEST_OBJECT_MAX_BYTES,
                "manifest",
            )
            .await
            {
                Ok(Some(data)) => data,
                Ok(None) => continue,
                Err(error) => {
                    tracing::warn!(
                        "读取 manifest 恢复点 {} 失败，尝试下一个候选: {}",
                        candidate.key,
                        error
                    );
                    continue;
                }
            };
            let recovered = match Self::decode_manifest(&candidate.key, &data) {
                Ok(manifest) => manifest,
                Err(error) => {
                    tracing::warn!(
                        "manifest 恢复点 {} 未通过校验，跳过并保留（供审计）: {}",
                        candidate.key,
                        error
                    );
                    continue;
                }
            };
            tracing::warn!(
                "manifest {} 正式对象损坏，已改用 verified-publish 残留恢复点 {}（自动收敛中）",
                key,
                candidate.key
            );
            let spec = PublishSpec::unconditional(
                key,
                MANIFEST_OBJECT_MAX_BYTES,
                PublishRecovery::KeepTmp,
            );
            match verified_publish(self.storage.as_ref(), &spec, &data).await {
                Ok(()) => {
                    if let Err(error) = self.storage.delete(&candidate.key).await {
                        tracing::warn!(
                            "自动收敛成功后清理已消费恢复点 {} 失败（无害孤儿）: {}",
                            candidate.key,
                            error
                        );
                    }
                }
                Err(error) => {
                    tracing::warn!(
                        "manifest {} 自动收敛失败（本次读取仍用已校验恢复内容）: {}",
                        key,
                        error
                    );
                }
            }
            return Some(recovered);
        }
        None
    }

    /// 读取云端 Manifest（合并 per-device manifest，兼容旧 manifest.json）
    pub async fn get_manifest(&self) -> Result<CloudManifest> {
        let mut merged = CloudManifest::default();
        let mut found = false;

        let list = self
            .storage
            .list_outcome(&format!("{MANIFESTS_DIR}/"))
            .await?;
        if list.truncated {
            return Err(AppError::internal(
                "云端备份 manifest 列表被截断，无法安全合并版本列表".to_string(),
            ));
        }
        for file in list.files {
            if !file.key.ends_with(".json") {
                continue;
            }
            match self.read_manifest_key(&file.key).await? {
                Some(manifest) => {
                    Self::merge_manifest(&mut merged, manifest);
                    found = true;
                }
                None => {}
            }
        }

        match self.read_manifest_key(MANIFEST_FILE).await {
            Ok(Some(legacy)) => {
                Self::merge_manifest(&mut merged, legacy);
                found = true;
            }
            Ok(None) => {}
            Err(primary_error) => {
                tracing::warn!("主 manifest 解析失败，尝试备份: {primary_error}");
                let backup = self.read_manifest_key(MANIFEST_BACKUP_FILE).await?;
                let Some(backup) = backup else {
                    return Err(primary_error);
                };
                Self::merge_manifest(&mut merged, backup);
                found = true;
            }
        }

        if found {
            Ok(merged)
        } else {
            Ok(CloudManifest::default())
        }
    }

    async fn get_device_manifest(&self) -> Result<CloudManifest> {
        match self.load_own_device_manifests().await? {
            (Some(mut current), Some(legacy)) => {
                Self::merge_manifest(&mut current, legacy);
                Ok(current)
            }
            (Some(current), None) => Ok(current),
            (None, Some(legacy)) => Ok(legacy),
            (None, None) => Ok(CloudManifest::default()),
        }
    }

    /// 保存本设备 Manifest（per-device，避免多设备 RMW 覆盖）。
    /// 写入短哈希文件名后删除旧 `manifests/<device_id>.json`，完成一次性迁移。
    async fn save_manifest(&self, manifest: &CloudManifest) -> Result<()> {
        let new_key = self.device_manifest_key();
        self.save_manifest_at_key(&new_key, manifest).await?;
        let legacy_key = self.device_manifest_legacy_key();
        if legacy_key != new_key {
            match self.storage.stat(&legacy_key).await {
                Ok(Some(_)) => {
                    if let Err(error) = self.storage.delete(&legacy_key).await {
                        tracing::warn!(
                            "迁移设备 manifest 后删除旧对象 {} 失败（新清单已发布）: {}",
                            legacy_key,
                            error
                        );
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    tracing::warn!(
                        "迁移设备 manifest 时探测旧对象 {} 失败: {}",
                        legacy_key,
                        error
                    );
                }
            }
        }
        Ok(())
    }

    /// [R4-publish-wire] manifest 发布统一走 [`super::verified_publish`] 原语
    ///（预算 [`MANIFEST_OBJECT_MAX_BYTES`]）：PUT 暂存键 `{key}.tmp-<op>` →
    /// 有界回读逐字节比对 → PUT 正式键 → 再有界回读。
    ///
    /// 恢复策略取 [`PublishRecovery::KeepTmp`]：发布后回读失败**保留已校验的
    /// 暂存对象**作恢复点、坏正式对象留在原位——这样读侧
    /// [`Self::read_manifest_key`] 的恢复协议能发现坏对象并收敛，而不是让
    /// 正式键悄悄变缺失（IsolateBad 会把坏对象移走，读侧只会看到 None，
    /// 版本列表静默变空，不可取）。
    async fn save_manifest_at_key(&self, key: &str, manifest: &CloudManifest) -> Result<()> {
        Self::validate_manifest(key, manifest)?;
        let data = serde_json::to_vec_pretty(manifest)
            .map_err(|e| AppError::internal(format!("序列化 manifest 失败: {e}")))?;
        let spec =
            PublishSpec::unconditional(key, MANIFEST_OBJECT_MAX_BYTES, PublishRecovery::KeepTmp);
        verified_publish(self.storage.as_ref(), &spec, &data).await
    }

    /// [R4-bad-write] 坏写收敛恢复入口（本设备 manifest）。
    ///
    /// 消费 [`Self::save_manifest_at_key`] 发布失败留下的残局
    /// （`manifests/<short-hash>.json` 损坏 / 缺失，但存在已校验的
    /// `{key}.<uuid>.tmp`）：
    /// - 坏正式对象先隔离到 `.quarantine/` 并写原因记录（可审计）；
    /// - 存在能**当场重新通过校验**的 `.tmp` → 用其内容收敛正式对象；
    /// - 只有坏正式对象、无可用 `.tmp` → fail-closed 返回错误
    ///   （稳定码 [`super::bad_object::BAD_OBJECT_FAIL_CLOSED_CODE`]）。
    ///
    /// 只处理本设备 manifest 元数据对象；`backups/` 用户备份数据对象不在
    /// 本入口范围内，隔离逻辑本身也绝不自动删除用户备份数据（见
    /// [`super::bad_object`] 模块文档）。当前零生产接线：由下一轮编排
    /// （coordinator / 云端巡检）在读 manifest 失败后显式调用。
    pub async fn recover_device_manifest_bad_write(
        &self,
    ) -> Result<super::bad_object::BadObjectOutcome> {
        let key = self.device_manifest_key();
        let validate_key = key.clone();
        let validate = move |bytes: &[u8]| -> std::result::Result<(), String> {
            let manifest: CloudManifest = serde_json::from_slice(bytes)
                .map_err(|error| format!("manifest JSON 解析失败: {error}"))?;
            Self::validate_manifest(&validate_key, &manifest).map_err(|error| error.to_string())
        };
        super::bad_object::converge_bad_object(
            self.storage.as_ref(),
            &self.device_id,
            &key,
            &validate,
        )
        .await
    }

    /// 获取同步状态
    pub async fn get_status(&self) -> SyncStatus {
        match self.storage.check_connection().await {
            Ok(_) => match self.get_manifest().await {
                Ok(manifest) => {
                    let device_last_sync = match self.load_own_device_manifests().await {
                        Ok((Some(current), Some(legacy))) => {
                            Some(current.updated_at.max(legacy.updated_at))
                        }
                        Ok((Some(current), None)) => Some(current.updated_at),
                        Ok((None, Some(legacy))) => Some(legacy.updated_at),
                        Ok((None, None)) | Err(_) => None,
                    };
                    let latest = manifest
                        .latest
                        .as_ref()
                        .and_then(|id| manifest.versions.iter().find(|v| &v.id == id).cloned());
                    SyncStatus {
                        connected: true,
                        cloud_version_count: manifest.versions.len(),
                        latest_version: latest,
                        last_sync_time: device_last_sync,
                        error: None,
                        encryption_memory_persist_failure: last_encryption_memory_persist_failure(),
                    }
                }
                Err(e) => SyncStatus {
                    connected: true,
                    cloud_version_count: 0,
                    latest_version: None,
                    last_sync_time: None,
                    error: Some(format!("读取 manifest 失败: {e}")),
                    encryption_memory_persist_failure: last_encryption_memory_persist_failure(),
                },
            },
            Err(e) => SyncStatus {
                connected: false,
                cloud_version_count: 0,
                latest_version: None,
                last_sync_time: None,
                error: Some(e.to_string()),
                encryption_memory_persist_failure: last_encryption_memory_persist_failure(),
            },
        }
    }

    /// 列出云端所有版本
    pub async fn list_versions(&self) -> Result<Vec<BackupVersion>> {
        let manifest = self.get_manifest().await?;
        Ok(manifest.versions)
    }

    /// 读取云端加密标记的三态结果与原始字节（内部）。
    ///
    /// [R4-e2ee-cas] 有界读：先 `stat` 核大小，超过认领对象上限的标记不下载、
    /// 按损坏处理（fail-closed）。原始字节供认领协议与发布前复验做逐字节比对。
    async fn read_encryption_marker_state_with_raw(
        &self,
    ) -> Result<(EncryptionMarkerState, Option<Vec<u8>>)> {
        if let Some(info) = self.storage.stat(ENCRYPTION_MARKER_FILE).await? {
            if info.size > super::e2ee_claim::MAX_E2EE_CLAIM_OBJECT_BYTES {
                tracing::warn!(
                    "云端加密标记 {} 为 {} 字节，超过 {} 字节上限，拒绝下载并按损坏处理",
                    ENCRYPTION_MARKER_FILE,
                    info.size,
                    super::e2ee_claim::MAX_E2EE_CLAIM_OBJECT_BYTES
                );
                return Ok((EncryptionMarkerState::Corrupted, None));
            }
        }
        match self.storage.get(ENCRYPTION_MARKER_FILE).await? {
            Some(data) => match serde_json::from_slice::<EncryptionMarker>(&data) {
                Ok(marker) => Ok((EncryptionMarkerState::Present(marker), Some(data))),
                Err(error) => {
                    tracing::warn!(
                        "云端加密标记 {} 内容无法解析，按存在处理: {}",
                        ENCRYPTION_MARKER_FILE,
                        error
                    );
                    Ok((EncryptionMarkerState::Corrupted, Some(data)))
                }
            },
            None => Ok((EncryptionMarkerState::Absent, None)),
        }
    }

    /// 读取云端加密标记的三态结果（内部）。
    async fn read_encryption_marker_state(&self) -> Result<EncryptionMarkerState> {
        Ok(self.read_encryption_marker_state_with_raw().await?.0)
    }

    /// 读取云端加密标记。
    ///
    /// 标记对象存在但内容损坏时按「存在」处理（fail-closed）：宁可多拦一次
    /// 明文上传，也不能让被破坏的标记悄悄放行明文。
    pub async fn read_encryption_marker(&self) -> Result<Option<EncryptionMarker>> {
        Ok(match self.read_encryption_marker_state().await? {
            EncryptionMarkerState::Absent => None,
            EncryptionMarkerState::Present(marker) => Some(marker),
            EncryptionMarkerState::Corrupted => Some(EncryptionMarker {
                version: 0,
                created_by_device: "unknown".to_string(),
                created_at: Utc::now(),
                key_verifier: None,
            }),
        })
    }

    /// [R4-e2ee-cas] 记录上传前策略检查确认过的标记原始字节（发布前复验依据）。
    fn record_publish_marker_expectation(&self, raw: Vec<u8>) {
        if let Ok(mut slot) = self.publish_marker_expectation.lock() {
            *slot = Some(raw);
        }
    }

    /// [R4-e2ee-cas] 发布备份版本前复验云端加密标记与上传前策略检查时逐字节一致。
    ///
    /// 认领协议保证「至多一方认领成功」，但成功只覆盖到上传开始前；大对象
    /// 上传期间标记仍可能被并发升级 / 篡改。策略检查未记录期望（明文上传或
    /// 直调 upload 的旧路径）时不做复验，保持现行为不收紧。
    async fn ensure_marker_unchanged_before_publish(&self) -> Result<()> {
        let expected = match self.publish_marker_expectation.lock() {
            Ok(slot) => slot.clone(),
            Err(_) => None,
        };
        let Some(expected) = expected else {
            return Ok(());
        };
        let (_, current) = self.read_encryption_marker_state_with_raw().await?;
        if current.as_deref() == Some(expected.as_slice()) {
            return Ok(());
        }
        Err(AppError::conflict(super::sync_e2ee_error(
            super::e2ee_claim::SYNC_E2EE_CLAIM_CONFLICT_CODE,
            "发布备份前复验发现云端加密标记已与上传前校验时不一致（认领竞态或标记被并发\
             改动），已回滚本次上传、未发布任何版本。请重试上传以重新校验加密密码。",
        )))
    }

    /// [R4-e2ee-cas] 经认领协议登记 / 升级带密码校验子的 v2 标记。
    ///
    /// 校验子按认领协议**自己的 marker 快照**构造：v1 升级保留快照里的首次
    /// 写入者与时间（而不是调用方更早一次读取的值），消除快照与写入之间的
    /// TOCTOU。成功后记录已发布字节，供发布前复验。
    async fn claim_marker_with_password(
        &self,
        password: &str,
        expectation: super::e2ee_claim::ClaimExpectation,
    ) -> Result<EncryptionMarker> {
        let device = device_id_short_hash(&self.device_id);
        let device_for_build = device.clone();
        let password = password.to_string();
        let build = move |snapshot: Option<EncryptionMarker>| -> Result<Vec<u8>> {
            let verifier = crate::crypto::backup_crypto::create_password_verifier(&password)
                .map_err(|e| AppError::internal(format!("生成加密标记校验子失败: {e}")))?;
            let marker = match snapshot {
                // v1 升级：保留首次写入者与时间。
                Some(legacy) => EncryptionMarker {
                    version: ENCRYPTION_MARKER_VERSION_WITH_VERIFIER,
                    created_by_device: legacy.created_by_device,
                    created_at: legacy.created_at,
                    key_verifier: Some(verifier),
                },
                None => EncryptionMarker {
                    version: ENCRYPTION_MARKER_VERSION_WITH_VERIFIER,
                    created_by_device: device_for_build.clone(),
                    created_at: Utc::now(),
                    key_verifier: Some(verifier),
                },
            };
            serde_json::to_vec_pretty(&marker)
                .map_err(|e| AppError::internal(format!("序列化加密标记失败: {e}")))
        };
        let published = super::e2ee_claim::claim_encryption_marker(
            &*self.storage,
            ENCRYPTION_MARKER_FILE,
            &device,
            self.e2ee_claim_lease_ttl,
            expectation,
            build,
        )
        .await?;
        let marker: EncryptionMarker = serde_json::from_slice(&published)
            .map_err(|e| AppError::internal(format!("解析已发布的加密标记失败: {e}")))?;
        self.record_publish_marker_expectation(published);
        Ok(marker)
    }

    /// 幂等写入云端加密标记：已存在则保持原样（保留首次写入者与时间）。
    ///
    /// 仅供**拿不到加密密码原文**的调用方使用（如记录级同步的 bool 策略入口），
    /// 新建的标记不含密码校验子；ZIP 上传路径改走
    /// [`Self::verify_encryption_password_before_upload`]，无标记时会直接登记
    /// 带校验子的标记，旧标记则被一次性升级。
    ///
    /// [R4-e2ee-cas] 首次登记不再盲 PUT：经 `.encryption-marker.lease` 认领
    /// 协议写入，并发的另一台设备要么看见租约、要么看见已发布的标记而失败，
    /// 不会用无校验子的 v1 覆盖别人刚认领的 v2。
    pub async fn persist_encryption_marker(&self) -> Result<EncryptionMarker> {
        let (state, raw) = self.read_encryption_marker_state_with_raw().await?;
        match state {
            EncryptionMarkerState::Present(existing) => {
                if let Some(raw) = raw {
                    self.record_publish_marker_expectation(raw);
                }
                return Ok(existing);
            }
            // 损坏按存在处理（fail-closed），保持既有语义：不覆盖、不掩盖。
            EncryptionMarkerState::Corrupted => {
                if let Some(raw) = raw {
                    self.record_publish_marker_expectation(raw);
                }
                return Ok(EncryptionMarker {
                    version: 0,
                    created_by_device: "unknown".to_string(),
                    created_at: Utc::now(),
                    key_verifier: None,
                });
            }
            EncryptionMarkerState::Absent => {}
        }
        let device = device_id_short_hash(&self.device_id);
        let device_for_build = device.clone();
        let build = move |_snapshot: Option<EncryptionMarker>| -> Result<Vec<u8>> {
            let marker = EncryptionMarker {
                version: 1,
                created_by_device: device_for_build.clone(),
                created_at: Utc::now(),
                key_verifier: None,
            };
            serde_json::to_vec_pretty(&marker)
                .map_err(|e| AppError::internal(format!("序列化加密标记失败: {e}")))
        };
        let published = super::e2ee_claim::claim_encryption_marker(
            &*self.storage,
            ENCRYPTION_MARKER_FILE,
            &device,
            self.e2ee_claim_lease_ttl,
            super::e2ee_claim::ClaimExpectation::Absent,
            build,
        )
        .await?;
        let marker: EncryptionMarker = serde_json::from_slice(&published)
            .map_err(|e| AppError::internal(format!("解析已发布的加密标记失败: {e}")))?;
        self.record_publish_marker_expectation(published);
        Ok(marker)
    }

    /// [R06-e2ee-verifier] 加密上传前校验（或登记）云端加密标记的密码校验子。
    ///
    /// 语义（全部发生在写入任何 `backups/` 对象之前）：
    /// - 无标记：若已有旧版 DSBK 备份则先试解（历史明文 ZIP 可直接开始
    ///   E2EE），通过后才用本机密码登记 v2 校验子；
    /// - 有校验子：复算比对——不一致立即失败（错密码设备不得向同一 root
    ///   写入另一套无法互解的密文）；无法校验（未知 KDF / 字段损坏）fail-closed；
    /// - 旧标记（`version <= 1`，无校验子）：[R12-v1-trust] 先用本机密码
    ///   试解该 root 的既有备份（空仓则跳过），通过后才做**一次性升级**，
    ///   保留首次写入者与时间；升级后错密码设备即可被拦截；
    /// - `version >= 2` 却缺校验子、或标记内容损坏：按损坏处理，fail-closed。
    pub async fn verify_encryption_password_before_upload(
        &self,
        password: &str,
    ) -> Result<EncryptionMarker> {
        let (state, raw) = self.read_encryption_marker_state_with_raw().await?;
        let marker = match state {
            EncryptionMarkerState::Absent => {
                // v0.9.44 already supported DSBK cloud backups but did not write
                // `.encryption-marker`. Do not let the first upgraded client pin an
                // unverified (possibly mistyped) password into a v2 marker: if the
                // latest legacy backup is encrypted, prove the password first.
                // Plain ZIP backups are a legitimate pre-E2EE state and may start a
                // new encrypted chain with the user-selected password.
                //
                // [R4-e2ee-cas] 试解（[R5-prove-cost] 首块快路径秒级；v1 /
                // 无前缀读取后端仍整包下载 + 全量解密，可能长于租约 TTL）
                // 在取租约之前完成；随后的首次认领不再盲 PUT——认领协议保证
                // 并发的另一台设备要么看见我们的租约、要么看见已发布的标记
                // 而失败，空仓「prove 直接放行」的路径同样先过认领协议。
                self.prove_password_against_existing_backups(password, true)
                    .await?;
                return self
                    .claim_marker_with_password(
                        password,
                        super::e2ee_claim::ClaimExpectation::Absent,
                    )
                    .await;
            }
            EncryptionMarkerState::Corrupted => {
                return Err(AppError::configuration(super::sync_e2ee_error(
                    super::SYNC_E2EE_MARKER_CORRUPTED_CODE,
                    "云端加密标记（.encryption-marker）内容已损坏，无法确认加密密码与既有备份\
                     一致，已在上传前中止（fail-closed）。请人工检查该云端目录后重试。",
                )));
            }
            EncryptionMarkerState::Present(marker) => marker,
        };

        match &marker.key_verifier {
            Some(verifier) => {
                match crate::crypto::backup_crypto::check_password_verifier(password, verifier) {
                    Ok(true) => {
                        // [R4-e2ee-cas] 记录校验时的标记字节，发布前复验未变。
                        if let Some(raw) = raw {
                            self.record_publish_marker_expectation(raw);
                        }
                        Ok(marker)
                    }
                    Ok(false) => Err(AppError::configuration(super::sync_e2ee_error(
                        super::SYNC_E2EE_WRONG_PASSWORD_CODE,
                        "加密密码与该云端目录既有加密备份使用的密码不一致，已在上传前中止，\
                         未写入任何备份对象。请核对加密密码后重试，或改用新的云端目录。",
                    ))),
                    Err(error) => Err(AppError::configuration(super::sync_e2ee_error(
                        super::SYNC_E2EE_MARKER_CORRUPTED_CODE,
                        format!(
                            "无法校验云端加密标记的密码校验子（fail-closed，已在上传前中止）：{error}。\
                             该标记可能由更新版本的应用写入，请先升级本机应用。"
                        ),
                    ))),
                }
            }
            // 旧版标记（R06 之前）没有校验子：以当前密码一次性升级。
            // [R12-v1-trust] 升级前先用本机密码试解该 root 的既有备份：只有
            // 确实能解开既有密文的密码才有资格被固化进 v2 标记，成为此后所有
            // 设备的校验基准；试解不通过则保持 v1 标记原样。空仓（只有标记、
            // 没有任何备份）保持旧行为——第一台带密码上传的设备认领该 root。
            // 升级后配错密码的设备即可在上传前被拦截。
            //
            // [R4-e2ee-cas] 升级写入不再盲 PUT：经认领协议执行，协议内部会
            // 重读并逐字节比对 v1 快照（试解期间标记被并发升级 / 改动即失败），
            // 首次写入者与时间以协议自己的快照为准。
            None if marker.version <= 1 => {
                self.prove_password_against_existing_backups(password, false)
                    .await?;
                tracing::warn!(
                    "云端加密标记为旧版（无密码校验子），将经认领协议一次性升级到 v{}",
                    ENCRYPTION_MARKER_VERSION_WITH_VERIFIER
                );
                self.claim_marker_with_password(
                    password,
                    super::e2ee_claim::ClaimExpectation::LegacyV1,
                )
                .await
            }
            // version >= 2 却缺校验子：不是合法旧标记，视为被篡改/损坏，fail-closed。
            None => Err(AppError::configuration(super::sync_e2ee_error(
                super::SYNC_E2EE_MARKER_CORRUPTED_CODE,
                format!(
                    "云端加密标记版本为 {} 却缺少密码校验子，疑似损坏或被篡改，已在上传前中止\
                     （fail-closed）。请人工检查该云端目录后重试。",
                    marker.version
                ),
            ))),
        }
    }

    /// [R12-v1-trust][R5-prove-cost] 升级/登记加密标记前，用本机密码对该 root
    /// 的既有备份做试解密。
    ///
    /// v1 标记没有校验子，无法直接比对密码；但只要该 root 已有备份，「密码
    /// 与既有密文一致」就是可以当场验证的事实——通过后才允许把本机密码固化
    /// 进 v2 标记。任何一步失败（备份列表读不到、读取失败/半包、对象不是
    /// DSBK 密文、解密失败）都返回错误、保持标记原样（fail-closed），
    /// 持有正确密码的设备之后仍可完成升级。
    ///
    /// [R5-prove-cost] 成本模型（全部发生在写入任何 `backups/` 对象之前）：
    /// - **首块快路径**：DSBK v2 分块容器每块自带独立 AEAD tag，后端支持
    ///   前缀读取（`supports_prefix_read`）时只下载「头 + 首个密文块」
    ///   （≈ 1 MiB）在内存中试解首块——错密码在首块 tag 校验即失败（秒级，
    ///   不整包下载、不全量解密、明文不落盘）；
    /// - **整文件回退**：v1 单块容器（单 tag 覆盖全文，无法部分试解，存量
    ///   v1 备份仍必须可证明）或后端不支持前缀读取时，保持历史行为：整包
    ///   下载 + 完整试解到临时文件；
    /// - **次新版本回退**：最新备份试解失败（对象损坏 / 读不到 / 密码不符）
    ///   时，再对次新版本试一次（同样优先首块）；两者都失败才报错，且报错
    ///   沿用最新版本那次尝试的错误（错误码与文案与历史一致）。注意该回退
    ///   意味着「密码能解开该 root 的最新或次新备份」即视为证明——最新对象
    ///   被截断/损坏时不再把正确密码挡在门外。
    ///
    /// 空仓（没有任何备份）没有可试解的对象：保持旧行为，允许第一台带密码
    /// 上传的设备认领该 root。
    ///
    /// `allow_plaintext_zip` 只用于 marker 缺失的 v0.9.44 升级路径：历史明文
    /// ZIP 没有既有密码可证明，允许用户从此启用 E2EE（判别只需 4 字节魔数，
    /// 快路径下同样无需整包）；其他非 DSBK/非 ZIP 内容仍按损坏 fail-closed。
    /// v1 marker 声称仓库已经加密，因此不允许明文。
    async fn prove_password_against_existing_backups(
        &self,
        password: &str,
        allow_plaintext_zip: bool,
    ) -> Result<()> {
        let manifest = self.get_manifest().await.map_err(|error| {
            AppError::configuration(format!(
                "升级云端加密标记前需确认本机密码能解开既有备份，但读取云端备份列表失败：\
                 {error}。本次未改动加密标记，请稍后重试。"
            ))
        })?;

        let Some(newest) = manifest
            .latest
            .as_ref()
            .and_then(|id| manifest.versions.iter().find(|v| &v.id == id))
            .or_else(|| manifest.versions.first())
        else {
            return Ok(());
        };
        // [R5-prove-cost] 次新版本 = manifest（新在前）里第一个不同于最新版的条目。
        let second_newest = manifest.versions.iter().find(|v| v.id != newest.id);

        let primary_error = match self
            .prove_password_against_version(password, allow_plaintext_zip, newest)
            .await
        {
            Ok(()) => return Ok(()),
            Err(error) => error,
        };
        let Some(fallback) = second_newest else {
            return Err(primary_error);
        };
        tracing::warn!(
            "最新备份 {} 试解失败（{primary_error}），回退次新版本 {} 再试一块",
            newest.id,
            fallback.id
        );
        match self
            .prove_password_against_version(password, allow_plaintext_zip, fallback)
            .await
        {
            Ok(()) => {
                tracing::warn!(
                    "次新版本 {} 试解通过（最新备份 {} 可能已损坏或暂不可读），放行",
                    fallback.id,
                    newest.id
                );
                Ok(())
            }
            Err(fallback_error) => {
                tracing::warn!(
                    "次新版本 {} 回退试解同样失败: {fallback_error}",
                    fallback.id
                );
                // 报错沿用最新版本那次尝试：错误码与文案对用户保持稳定。
                Err(primary_error)
            }
        }
    }

    /// [R5-prove-cost] 对单个备份版本做一次口令试解：优先首块快路径，
    /// 仅 v1 单块容器或后端无前缀读取能力时走整文件回退。
    async fn prove_password_against_version(
        &self,
        password: &str,
        allow_plaintext_zip: bool,
        version: &BackupVersion,
    ) -> Result<()> {
        if self.storage.supports_prefix_read() {
            match self
                .try_prove_with_first_chunk(password, allow_plaintext_zip, version)
                .await?
            {
                FirstChunkProveOutcome::Settled => return Ok(()),
                // 仅 v1 需要整文件：v2 首块的失败已在上面以 Err 返回，
                // 绝不为错密码/损坏首块再整包下载同一对象。
                FirstChunkProveOutcome::LegacyV1NeedsWholeFile => {}
            }
        }
        self.prove_password_with_whole_file(password, allow_plaintext_zip, version)
            .await
    }

    /// [R5-prove-cost] 试解未通过（口令错误 / 对象非 DSBK / 首块或全文损坏）
    /// 的统一用户级错误：首块快路径与整文件回退共用，文案与历史逐字一致。
    fn prove_trial_failed_error(
        allow_plaintext_zip: bool,
        version_id: &str,
        error: impl std::fmt::Display,
    ) -> AppError {
        AppError::configuration(super::sync_e2ee_error(
            super::SYNC_E2EE_WRONG_PASSWORD_CODE,
            format!(
                "{}，用本机密码试解最新备份 {} 未通过：\
                 {error}。本次未改动加密标记，也未写入任何备份对象。请核对加密密码后重试；\
                 若确认密码无误，说明该备份由其他密码加密或已损坏，请人工检查该云端目录。",
                if allow_plaintext_zip {
                    "云端尚无加密标记但已有旧版加密备份，登记校验子前"
                } else {
                    "云端加密标记为旧版（无密码校验子），升级前"
                },
                version_id
            ),
        ))
    }

    /// [R5-prove-cost] 首块快路径：只读取「v2 头 + 首个密文块」前缀，在内存
    /// 中试解首块证明口令（明文不落盘）。
    ///
    /// 读取策略：先按投机长度（头 + 默认 1 MiB 分块 + tag，本应用写入面一次
    /// 覆盖）读一次前缀；头部声明了更大的非默认分块（外部工具写入）时，按
    /// [`crate::crypto::backup_crypto::plan_first_chunk_trial`] 给出的精确长度
    /// 补读一次。对象总长以 manifest 登记值为准——与真实对象不符（被并发
    /// 替换/截断）时首块 tag 校验必然失败，fail-closed。
    async fn try_prove_with_first_chunk(
        &self,
        password: &str,
        allow_plaintext_zip: bool,
        version: &BackupVersion,
    ) -> Result<FirstChunkProveOutcome> {
        use crate::crypto::backup_crypto;

        let remote_key = format!("{}/{}.zip", BACKUPS_DIR, version.id);
        let read_failure = |error: AppError| {
            AppError::configuration(format!(
                "升级云端加密标记前需确认本机密码能解开既有备份，但读取备份 {} 的首块失败：\
                 {error}。本次未改动加密标记，请稍后重试。",
                version.id
            ))
        };
        let missing_object = || {
            AppError::configuration(format!(
                "升级云端加密标记前需确认本机密码能解开既有备份，但备份对象 {} 在云端不存在。\
                 本次未改动加密标记，请稍后重试。",
                version.id
            ))
        };

        let speculative = backup_crypto::dsbk_first_chunk_speculative_prefix_len(version.size);
        let mut prefix = self
            .storage
            .get_prefix(&remote_key, speculative)
            .await
            .map_err(read_failure)?
            .ok_or_else(missing_object)?;

        // 明文 ZIP 判别只需 4 字节魔数（仅 marker 缺失的 v0.9.44 升级路径放行）。
        if allow_plaintext_zip {
            let head = &prefix[..prefix.len().min(4)];
            let is_plain_zip = matches!(
                head,
                [b'P', b'K', 3, 4] | [b'P', b'K', 5, 6] | [b'P', b'K', 7, 8]
            );
            if !backup_crypto::is_encrypted_backup(head) && is_plain_zip {
                return Ok(FirstChunkProveOutcome::Settled);
            }
        }

        let plan =
            backup_crypto::plan_first_chunk_trial(&prefix, version.size).map_err(|error| {
                Self::prove_trial_failed_error(allow_plaintext_zip, &version.id, error)
            })?;
        let prefix_len = match plan {
            backup_crypto::FirstChunkPlan::LegacyV1WholeFile => {
                return Ok(FirstChunkProveOutcome::LegacyV1NeedsWholeFile);
            }
            backup_crypto::FirstChunkPlan::StreamV2 { prefix_len } => prefix_len,
        };
        if (prefix.len() as u64) < prefix_len {
            // 非默认大分块（外部写入面）：按计划的精确长度补读一次。
            prefix = self
                .storage
                .get_prefix(&remote_key, prefix_len)
                .await
                .map_err(read_failure)?
                .ok_or_else(missing_object)?;
        }
        if (prefix.len() as u64) < prefix_len {
            return Err(read_failure(AppError::network(format!(
                "前缀读取不完整：需要 {prefix_len} 字节，实得 {} 字节\
                 （对象可能已被并发替换或截断）",
                prefix.len()
            ))));
        }

        // Argon2 派生 + 首块 AES-GCM 是 CPU 密集操作：spawn_blocking。
        // 首块明文只在内存中短暂存在（试解 API 内部 zeroize），不落盘。
        let password_owned = password.to_string();
        let object_len = version.size;
        let trial = tokio::task::spawn_blocking(move || {
            backup_crypto::trial_decrypt_first_chunk(&prefix, object_len, &password_owned)
        })
        .await
        .map_err(|e| AppError::internal(format!("试解密任务执行失败: {e}")))?;

        trial.map_err(|error| {
            Self::prove_trial_failed_error(allow_plaintext_zip, &version.id, error)
        })?;
        Ok(FirstChunkProveOutcome::Settled)
    }

    /// 整文件回退试解：整包下载 + 完整解密到临时文件（历史行为，逐字保留
    /// 错误文案）。存量 DSBK v1 与不支持前缀读取的后端走此路径。
    async fn prove_password_with_whole_file(
        &self,
        password: &str,
        allow_plaintext_zip: bool,
        version: &BackupVersion,
    ) -> Result<()> {
        let temp = tempfile::tempdir()
            .map_err(|e| AppError::file_system(format!("创建试解密临时目录失败: {e}")))?;
        let downloaded = self
            .download_with_progress(Some(&version.id), temp.path(), None)
            .await
            .map_err(|error| {
                AppError::configuration(format!(
                    "升级云端加密标记前需确认本机密码能解开既有备份，但下载最新备份 {} 失败：\
                     {error}。本次未改动加密标记，请稍后重试。",
                    version.id
                ))
            })?;

        // 完整试解到临时文件（spawn_blocking：Argon2 派生 + 全量解密是 CPU/IO
        // 密集操作）；输出只用于验证，随 TempDir 一并清理。
        let encrypted_path = std::path::PathBuf::from(&downloaded.local_path);
        if allow_plaintext_zip {
            use std::io::Read;
            let mut prefix = [0u8; 4];
            let mut file = std::fs::File::open(&encrypted_path).map_err(|error| {
                AppError::configuration(format!(
                    "登记云端加密标记前无法识别最新备份 {} 的格式：{error}。\
                     本次未改动加密标记，请稍后重试。",
                    version.id
                ))
            })?;
            let read = file.read(&mut prefix).map_err(|error| {
                AppError::configuration(format!(
                    "登记云端加密标记前无法读取最新备份 {} 的格式：{error}。\
                     本次未改动加密标记，请稍后重试。",
                    version.id
                ))
            })?;
            let prefix = &prefix[..read];
            let is_plain_zip = matches!(
                prefix,
                [b'P', b'K', 3, 4] | [b'P', b'K', 5, 6] | [b'P', b'K', 7, 8]
            );
            if !crate::crypto::backup_crypto::is_encrypted_backup(prefix) && is_plain_zip {
                return Ok(());
            }
        }
        let plaintext_path = temp.path().join(".trial-decrypt.tmp");
        let password_owned = password.to_string();
        let trial = tokio::task::spawn_blocking(move || {
            crate::crypto::backup_crypto::decrypt_backup_file(
                &encrypted_path,
                &plaintext_path,
                &password_owned,
            )
        })
        .await
        .map_err(|e| AppError::internal(format!("试解密任务执行失败: {e}")))?;

        trial.map_err(|error| {
            Self::prove_trial_failed_error(allow_plaintext_zip, &version.id, error)
        })?;

        Ok(())
    }

    /// 明文上传前置检查：该云 root 出现过加密备份（存在标记）时拒绝。
    ///
    /// [R10-verifier] 云端标记缺失时还要过本机记忆这道门：本机曾确认该目录
    /// 加密而云端标记现已消失（被删/丢失）的，同样拒绝明文上传（fail-closed），
    /// 不默许把明文混进曾经加密的恢复链。
    pub async fn ensure_plaintext_upload_allowed(&self) -> Result<()> {
        if self.read_encryption_marker().await?.is_some() {
            self.remember_encrypted_root();
            return Err(AppError::configuration(super::sync_e2ee_error(
                super::SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE,
                "该云端目录已存在端到端加密备份，为避免明文/密文混布，已拒绝未加密上传。\
                 请在云存储配置里填写相同的加密密码后重试。",
            )));
        }
        if self.encrypted_root_remembered_locally() {
            return Err(AppError::configuration(super::sync_e2ee_error(
                super::SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE,
                "本机记录显示该云端目录曾启用端到端加密，但云端的加密标记现已缺失（可能被删除）。\
                 为避免向同一目录混入未加密备份，已拒绝本次上传。请在云存储配置里填写原加密密码\
                 后重试；若确认要改用未加密备份，请换一个新的云端目录。",
            )));
        }
        Ok(())
    }

    /// 上传前的端到端加密一致性策略（bool 版，供拿不到密码原文的调用方使用）：
    /// - 本次上传加密：先幂等写入云端加密标记（失败则整个上传失败），
    ///   保证标记先于任何密文对象可见；
    /// - 本次上传明文：若该 root 已有加密标记则直接拒绝。
    ///
    /// 注意：本入口**不校验**密码一致性；能拿到密码原文的路径（如 ZIP 上传）
    /// 应改用 [`Self::enforce_encryption_policy_before_upload_with_password`]。
    pub async fn enforce_encryption_policy_before_upload(
        &self,
        encryption_enabled: bool,
    ) -> Result<()> {
        if encryption_enabled {
            self.persist_encryption_marker().await?;
            self.remember_encrypted_root();
            Ok(())
        } else {
            self.ensure_plaintext_upload_allowed().await
        }
    }

    /// [R06-e2ee-verifier] 上传前的端到端加密一致性策略（带密码校验）：
    /// - 有密码：校验 / 登记云端加密标记的不可逆密码校验子——配错密码的设备
    ///   在写入任何 `backups/` 对象之前即失败；
    /// - 无密码：若该 root 已有加密标记则直接拒绝明文上传。
    pub async fn enforce_encryption_policy_before_upload_with_password(
        &self,
        encryption_password: Option<&str>,
    ) -> Result<()> {
        match encryption_password {
            Some(password) => {
                self.verify_encryption_password_before_upload(password)
                    .await?;
                self.remember_encrypted_root();
                Ok(())
            }
            None => self.ensure_plaintext_upload_allowed().await,
        }
    }

    /// 上传备份文件（SOTA 流式上传）
    ///
    /// # Arguments
    /// * `zip_path` - 本地 ZIP 文件路径
    /// * `app_version` - 应用版本
    /// * `note` - 备注
    ///
    /// ## SOTA 特性
    /// - 流式读取：避免大文件占用过多内存
    /// - 进度反馈：实时上传进度
    /// - SHA256 校验：确保数据完整性
    pub async fn upload(
        &self,
        zip_path: &Path,
        app_version: Option<String>,
        note: Option<String>,
    ) -> Result<UploadResult> {
        self.upload_with_progress(zip_path, app_version, note, None, None)
            .await
    }

    /// 上传备份文件（带进度回调）
    ///
    /// # Arguments
    /// * `zip_path` - 本地 ZIP 文件路径
    /// * `app_version` - 应用版本
    /// * `note` - 备注
    /// * `recovery_kind` - 导入后能否整槽恢复（`disaster_recovery` / `partial_archive`）
    /// * `progress` - 进度回调 (uploaded_bytes, total_bytes)
    pub async fn upload_with_progress(
        &self,
        zip_path: &Path,
        app_version: Option<String>,
        note: Option<String>,
        recovery_kind: Option<String>,
        progress: Option<super::traits::UploadProgressCallback>,
    ) -> Result<UploadResult> {
        const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024 * 1024; // 提升到 10GB
        let metadata = std::fs::metadata(zip_path)
            .map_err(|e| AppError::internal(format!("读取文件元信息失败: {e}")))?;
        let file_size = metadata.len();

        if file_size > MAX_FILE_SIZE {
            return Err(AppError::validation(format!(
                "备份文件过大（{:.2} GB），最大支持 10 GB",
                file_size as f64 / 1024.0 / 1024.0 / 1024.0
            )));
        }

        tracing::info!(
            "开始上传备份文件: {} ({:.2} MB)",
            zip_path.display(),
            file_size as f64 / 1024.0 / 1024.0
        );

        // [R12-neutral-names] 版本 ID 纯随机，时间与设备只写在 manifest 字段。
        let now = Utc::now();
        let version_id = generate_neutral_version_id();
        Self::validate_version_id(&version_id)?;
        let remote_key = format!("{}/{}.zip", BACKUPS_DIR, version_id);

        // 使用流式上传（自动计算 SHA256）
        let checksum = self
            .storage
            .put_file(&remote_key, zip_path, progress)
            .await?;
        if checksum.len() != 64 || !checksum.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            let _ = self.storage.delete(&remote_key).await;
            return Err(AppError::internal(
                "云存储 provider 返回了非法 SHA256，已拒绝发布版本".to_string(),
            ));
        }
        // put_file 的 SHA256 来自本地文件。远端若静默短写，仍会带回本地哈希。
        // 发布清单前先 stat 核对大小；全量回读太贵，短包这一档必须在此拦下。
        match self.storage.stat(&remote_key).await? {
            Some(info) if info.size == file_size => {}
            Some(info) => {
                let _ = self.storage.delete(&remote_key).await;
                return Err(AppError::internal(format!(
                    "云端备份对象上传后大小不一致：本地 {file_size} 字节，远端 {} 字节，已停止并不得报成功",
                    info.size
                )));
            }
            None => {
                let _ = self.storage.delete(&remote_key).await;
                return Err(AppError::internal(
                    "云端备份对象上传后不存在，已停止并不得报成功".to_string(),
                ));
            }
        }

        tracing::info!(
            "上传完成: version={}, checksum={}",
            version_id,
            &checksum[..16]
        );

        // 创建版本信息
        let version = BackupVersion {
            id: version_id.clone(),
            timestamp: now,
            size: file_size,
            checksum,
            device_id: self.device_id.clone(),
            app_version,
            note,
            recovery_kind,
        };

        // 更新 Manifest
        let mut manifest = match self.get_device_manifest().await {
            Ok(manifest) => manifest,
            Err(error) => {
                if let Err(cleanup_error) = self.storage.delete(&remote_key).await {
                    tracing::warn!(
                        "读取设备 manifest 失败后清理未引用对象 {} 失败: {}",
                        remote_key,
                        cleanup_error
                    );
                }
                return Err(error);
            }
        };
        manifest.versions.insert(0, version.clone());
        manifest.latest = Some(version_id);
        manifest.updated_at = now;

        // 先发布不再引用旧对象的 manifest，再做对象 GC。反过来执行会在 manifest
        // 发布失败或进程崩溃时留下“可见但已不可下载”的恢复点。
        let pruned = self.prune_versions(&mut manifest);
        // [R4-e2ee-cas] 发布前复验加密标记与上传前策略检查时一致：认领竞态 /
        // 上传期间标记被并发改动的一方在此被拦下。新对象尚未被任何 manifest
        // 引用，直接回滚，不留可见的错链恢复点。
        if let Err(error) = self.ensure_marker_unchanged_before_publish().await {
            if let Err(cleanup_error) = self.storage.delete(&remote_key).await {
                tracing::warn!(
                    "加密标记复验失败后清理未引用对象 {} 失败: {}",
                    remote_key,
                    cleanup_error
                );
            }
            return Err(error);
        }
        if let Err(error) = self.save_manifest(&manifest).await {
            // 新对象尚未被任何已发布 manifest 引用，尽力回滚，避免长期孤儿。
            if let Err(cleanup_error) = self.storage.delete(&remote_key).await {
                tracing::warn!(
                    "manifest 发布失败后清理未引用对象 {} 失败: {}",
                    remote_key,
                    cleanup_error
                );
            }
            return Err(error);
        }
        for old in &pruned {
            let key = format!("{}/{}.zip", BACKUPS_DIR, old.id);
            if let Err(error) = self.storage.delete(&key).await {
                // manifest 已经安全发布；此时失败只会留下不可见孤儿，不会破坏恢复点。
                tracing::warn!("清理已裁剪云端对象 {} 失败: {}", old.id, error);
            }
        }

        Ok(UploadResult {
            version,
            pruned_versions: pruned.into_iter().map(|old| old.id).collect(),
        })
    }

    /// 下载备份文件（SOTA 流式下载）
    ///
    /// # Arguments
    /// * `version_id` - 版本 ID（None 表示下载最新版本）
    /// * `local_dir` - 本地保存目录
    ///
    /// ## SOTA 特性
    /// - 流式写入：避免大文件占用过多内存
    /// - SHA256 校验：确保数据完整性
    pub async fn download(
        &self,
        version_id: Option<&str>,
        local_dir: &Path,
    ) -> Result<DownloadResult> {
        self.download_with_progress(version_id, local_dir, None)
            .await
    }

    /// 下载备份文件（带进度回调）
    ///
    /// # Arguments
    /// * `version_id` - 版本 ID（None 表示下载最新版本）
    /// * `local_dir` - 本地保存目录
    /// * `progress` - 进度回调 (downloaded_bytes, total_bytes)
    pub async fn download_with_progress(
        &self,
        version_id: Option<&str>,
        local_dir: &Path,
        progress: Option<super::traits::DownloadProgressCallback>,
    ) -> Result<DownloadResult> {
        if let Some(version_id) = version_id {
            Self::validate_version_id(version_id)?;
        }
        let manifest = self.get_manifest().await?;

        // 确定要下载的版本
        let version = if let Some(id) = version_id {
            manifest.versions.iter().find(|v| v.id == id)
        } else {
            manifest
                .latest
                .as_ref()
                .and_then(|id| manifest.versions.iter().find(|v| &v.id == id))
        };

        let version = version
            .cloned()
            .ok_or_else(|| AppError::not_found("未找到指定版本"))?;
        Self::validate_version_id(&version.id)?;

        tracing::info!(
            "开始下载备份文件: version={}, size={:.2} MB",
            version.id,
            version.size as f64 / 1024.0 / 1024.0
        );

        // 确保目录存在
        std::fs::create_dir_all(local_dir)
            .map_err(|e| AppError::internal(format!("创建目录失败: {e}")))?;

        let local_path = local_dir.join(format!("{}.zip", version.id));
        let remote_key = format!("{}/{}.zip", BACKUPS_DIR, version.id);

        if self.storage.supports_resumable_download() {
            // [R09-restore-ops][P2-2] 断点续传下载：中断后保留 `.part` 断点文件，
            // 重试同一版本时从断点继续，多 GB 备份不再整包重下。
            // 完整性由完成后的整文件 SHA256 兜底（version.checksum 在上传时
            // 由流式哈希产生），断点错位/对象被改动都会在此被拒绝。
            let partial_path = Self::partial_download_path(local_dir, &version.id);
            let resume_from = match std::fs::symlink_metadata(&partial_path) {
                Ok(metadata)
                    if !metadata.file_type().is_symlink()
                        && metadata.is_file()
                        && metadata.len() > 0
                        && metadata.len() <= version.size =>
                {
                    tracing::info!(
                        "发现可续传断点: {:?}（{}/{} 字节）",
                        partial_path,
                        metadata.len(),
                        version.size
                    );
                    metadata.len()
                }
                Ok(_) => {
                    // 断点比云端对象还大 / 不是普通文件：断点无效，丢弃重下。
                    let _ = std::fs::remove_file(&partial_path);
                    0
                }
                Err(_) => 0,
            };

            // 失败时不清理断点文件：它正是下次续传的起点（与 ZIP 导入续传
            // 「失败不清理目标目录」同一模式）。
            self.storage
                .get_file_resumable(&remote_key, &partial_path, resume_from, progress)
                .await?;

            let actual_checksum = Self::hash_file_sha256(&partial_path).await?;
            if actual_checksum != version.checksum {
                // 断点文件与云端对象校验不符（断点损坏或对象被改动）：
                // 丢弃断点并明确失败，绝不把损坏文件交给恢复链。
                let _ = std::fs::remove_file(&partial_path);
                return Err(AppError::validation(format!(
                    "下载完成但 SHA256 校验失败（期望 {}，实际 {}）。断点文件已丢弃，请重试整包下载",
                    &version.checksum[..16.min(version.checksum.len())],
                    &actual_checksum[..16]
                )));
            }
            std::fs::rename(&partial_path, &local_path)
                .map_err(|e| AppError::file_system(format!("保存下载文件失败: {e}")))?;

            tracing::info!(
                "下载完成（断点续传路径, resume_from={}）: version={}, checksum={}",
                resume_from,
                version.id,
                &actual_checksum[..16]
            );
        } else {
            // 后端不支持断点续传：整文件下载（中断后只能整包重下，诚实且
            // 由 get_file 内部的 SHA256 校验兜底，绝不静默截断当成功）。
            let actual_checksum = self
                .storage
                .get_file(&remote_key, &local_path, Some(&version.checksum), progress)
                .await?;

            tracing::info!(
                "下载完成: version={}, checksum={}",
                version.id,
                &actual_checksum[..16]
            );
        }

        Ok(DownloadResult {
            version,
            local_path: local_path.to_string_lossy().to_string(),
        })
    }

    /// [R09-restore-ops][P2-2] 某个版本的断点下载文件路径。
    ///
    /// 以 `.` 开头、`.part` 结尾，与最终产物 `<id>.zip` 明确区分；版本 ID
    /// 已通过 `validate_version_id` 白名单校验，可安全拼入文件名。
    fn partial_download_path(local_dir: &Path, version_id: &str) -> std::path::PathBuf {
        local_dir.join(format!(".{version_id}.zip.part"))
    }

    /// 分块计算文件 SHA256（spawn_blocking，避免多 GB 文件哈希阻塞异步执行器）。
    async fn hash_file_sha256(path: &Path) -> Result<String> {
        let path = path.to_path_buf();
        tokio::task::spawn_blocking(move || -> Result<String> {
            use std::io::Read;
            let mut file = std::fs::File::open(&path)
                .map_err(|e| AppError::file_system(format!("打开下载文件做校验失败: {e}")))?;
            let mut hasher = Sha256::new();
            let mut buffer = vec![0u8; 1024 * 1024];
            loop {
                let read = file
                    .read(&mut buffer)
                    .map_err(|e| AppError::file_system(format!("读取下载文件做校验失败: {e}")))?;
                if read == 0 {
                    break;
                }
                hasher.update(&buffer[..read]);
            }
            Ok(format!("{:x}", hasher.finalize()))
        })
        .await
        .map_err(|e| AppError::internal(format!("SHA256 校验任务失败: {e}")))?
    }

    /// 删除指定版本
    pub async fn delete_version(&self, version_id: &str) -> Result<()> {
        Self::validate_version_id(version_id)?;
        let mut manifest = self.get_device_manifest().await?;

        // 检查是否存在
        let idx = manifest
            .versions
            .iter()
            .position(|v| v.id == version_id)
            .ok_or_else(|| AppError::not_found("版本不存在"))?;

        // 先发布逻辑删除，再做对象 GC。这样发布失败时恢复点仍完整可用；对象删除
        // 失败时最多留下不可见孤儿，不会让 manifest 引用一个不存在的文件。
        manifest.versions.remove(idx);
        if manifest.latest.as_deref() == Some(version_id) {
            manifest.latest = manifest.versions.first().map(|v| v.id.clone());
        }
        manifest.updated_at = Utc::now();
        self.save_manifest(&manifest).await?;

        let remote_key = format!("{}/{}.zip", BACKUPS_DIR, version_id);
        if let Err(error) = self.storage.delete(&remote_key).await {
            tracing::warn!(
                "版本 {} 已从 manifest 移除，但对象 GC 失败，将保留为不可见孤儿: {}",
                version_id,
                error
            );
        }
        Ok(())
    }

    /// 清理旧版本，保留最近 N 个
    fn prune_versions(&self, manifest: &mut CloudManifest) -> Vec<BackupVersion> {
        let mut pruned = Vec::new();

        while manifest.versions.len() > self.max_versions {
            if let Some(old) = manifest.versions.pop() {
                pruned.push(old);
            }
        }

        pruned
    }

    /// 计算 SHA256 校验和
    fn calculate_checksum(data: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(data);
        format!("{:x}", hasher.finalize())
    }
}

/// 主路径文件名：`<app_data_dir>/.device_id`（与数据槽 `slots/` 同根）
const DEVICE_ID_FILE_NAME: &str = ".device_id";
/// 历史遗留：data_governance 早期把设备 ID 写在 `<app_data_dir>/device_id`
const LEGACY_ROOT_DEVICE_ID_FILE_NAME: &str = "device_id";

/// 设备 ID 主路径：Tauri 应用数据目录（与数据槽同根）。
///
/// 数据空间管理器在启动早期初始化；若尚未初始化（如纯单元测试进程），
/// 返回 None，调用方必须显式处理"无法持久化"这一事实。
fn primary_device_id_path() -> Option<std::path::PathBuf> {
    crate::data_space::get_data_space_manager()
        .map(|manager| manager.base_dir().join(DEVICE_ID_FILE_NAME))
}

/// 旧候选路径（只读迁移来源，按历史优先级排列）。
///
/// 包含旧 app 根文件 `device_id` 与早期写入的全局目录副本。这些路径不再
/// 作为新 ID 的写入目标，仅用于一次性迁移与轮换后的副本同步。
fn legacy_device_id_paths() -> Vec<std::path::PathBuf> {
    let mut paths = Vec::new();
    if let Some(manager) = crate::data_space::get_data_space_manager() {
        paths.push(manager.base_dir().join(LEGACY_ROOT_DEVICE_ID_FILE_NAME));
    }
    for dir in [dirs::data_local_dir(), dirs::config_dir(), dirs::home_dir()]
        .into_iter()
        .flatten()
    {
        paths.push(dir.join("deep-student").join(DEVICE_ID_FILE_NAME));
    }
    paths
}

fn read_device_id_file(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(normalize_device_id(trimmed))
    }
}

/// 原子写入设备 ID（临时文件 + fsync + rename），避免半写文件产生残缺身份。
fn write_device_id_atomic(path: &Path, id: &str) -> std::io::Result<()> {
    use std::io::Write;

    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "device id path has no parent",
        )
    })?;
    std::fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(id.as_bytes())?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

fn device_hostname() -> String {
    std::env::var("COMPUTERNAME") // Windows
        .or_else(|_| std::env::var("HOSTNAME")) // Linux/Unix
        .or_else(|_| std::env::var("HOST")) // macOS
        .unwrap_or_else(|_| "device".to_string())
}

#[derive(Debug)]
struct DeviceIdResolution {
    id: String,
    /// id 是否落在磁盘上（读自主路径/旧路径，或新生成后成功写入主路径）。
    persisted: bool,
}

/// 解析（或生成）设备 ID 的核心逻辑，路径全部注入以便测试。
///
/// 顺序：主路径 → 旧路径（命中即一次性迁移到主路径）→ 生成新 ID 并只写主路径。
/// 生成后写入失败时如实返回 `persisted: false`，不假装成功。
fn resolve_or_create_device_id(
    primary: Option<&Path>,
    legacy: &[std::path::PathBuf],
) -> DeviceIdResolution {
    if let Some(primary) = primary {
        if let Some(id) = read_device_id_file(primary) {
            return DeviceIdResolution {
                id,
                persisted: true,
            };
        }
    }

    for path in legacy {
        let Some(id) = read_device_id_file(path) else {
            continue;
        };
        // 一次性迁移到主路径。迁移失败不阻塞返回：旧路径仍可读，
        // 下次调用会重试迁移，身份本身不受影响。
        if let Some(primary) = primary {
            match write_device_id_atomic(primary, &id) {
                Ok(()) => tracing::info!(
                    "设备 ID 已从旧路径 {} 迁移到主路径 {}",
                    path.display(),
                    primary.display()
                ),
                Err(error) => tracing::warn!(
                    "设备 ID 迁移到主路径 {} 失败（旧路径仍可用，稍后重试）: {}",
                    primary.display(),
                    error
                ),
            }
        }
        return DeviceIdResolution {
            id,
            persisted: true,
        };
    }

    // 生成新的设备 ID（结合主机名以保证一定程度的可读性），只写主路径。
    let short_uuid = &Uuid::new_v4().to_string()[..8];
    let new_id = normalize_device_id(&format!("{}-{}", device_hostname(), short_uuid));
    let persisted = match primary {
        Some(primary) => match write_device_id_atomic(primary, &new_id) {
            Ok(()) => {
                tracing::info!("新设备 ID 已保存到主路径: {}", primary.display());
                true
            }
            Err(error) => {
                tracing::error!(
                    "新设备 ID 写入主路径 {} 失败，无法持久化: {}",
                    primary.display(),
                    error
                );
                false
            }
        },
        None => {
            tracing::error!("应用数据目录尚未初始化，设备 ID 无法持久化");
            false
        }
    };
    DeviceIdResolution {
        id: new_id,
        persisted,
    }
}

/// 持久化失败时的进程级兜底身份。
///
/// 主路径不可写时不能"每次调用都生成新 ID 还假装成功"：那会让同一进程
/// 的上传以无数个一次性设备身份散落在云端。这里退化为进程内稳定的临时
/// 身份，并用 error 级日志显式暴露持久化失败。
static UNPERSISTED_DEVICE_ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// 获取或生成设备 ID
///
/// 优先级：
/// 1. 环境变量 DEVICE_ID
/// 2. 主路径 `<app_data_dir>/.device_id`（与数据槽同根）
/// 3. 旧路径一次性迁移：`<app_data_dir>/device_id`、
///    data_local_dir/config_dir/home_dir 下的 `deep-student/.device_id`
/// 4. 生成新 ID 并写入主路径；写入失败则退化为进程内稳定的临时 ID（记录 error 日志）
pub fn get_device_id() -> String {
    // 优先从环境变量获取
    if let Ok(id) = std::env::var("DEVICE_ID") {
        if !id.is_empty() {
            return normalize_device_id(&id);
        }
    }

    // 一旦进入过"持久化失败"状态，本进程内保持同一临时身份，避免身份漂移。
    if let Some(id) = UNPERSISTED_DEVICE_ID.get() {
        return id.clone();
    }

    let primary = primary_device_id_path();
    let resolution = resolve_or_create_device_id(primary.as_deref(), &legacy_device_id_paths());
    if resolution.persisted {
        resolution.id
    } else {
        UNPERSISTED_DEVICE_ID
            .get_or_init(|| {
                tracing::error!(
                    "设备 ID 持久化失败，本进程内使用临时设备 ID {}（重启后会变化，云端会出现新设备目录）",
                    resolution.id
                );
                resolution.id.clone()
            })
            .clone()
    }
}

/// 恢复备份后轮换设备 ID。
///
/// restore 会把本机数据回退到过去时间点；继续沿用旧 device_id 会触发
/// data_governance 的回声过滤，使旧身份在备份点之后上传过的变更永远不被本机重新消费。
/// 轮换后本机以“新设备”身份重新追赶旧设备目录。
pub fn generate_device_id_after_restore() -> String {
    let short_uuid = &Uuid::new_v4().to_string()[..8];
    normalize_device_id(&format!("{}-{}", device_hostname(), short_uuid))
}

/// 把新身份写到主路径与仍存在的旧副本，路径注入以便测试。
///
/// - 主路径写入失败 → 直接返回错误，不假装成功。
/// - 旧副本仅在文件已存在时更新（防止降级/旧代码读到已被轮换掉的旧身份），
///   主路径已写成功时旧副本失败只降级为 warn。
/// - 主路径不可用（数据目录未初始化）时，退化为写第一个可写的旧路径。
fn persist_device_id_to_paths(
    primary: Option<&Path>,
    legacy: &[std::path::PathBuf],
    new_id: &str,
) -> std::io::Result<()> {
    if new_id.trim().is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "new device id must not be empty",
        ));
    }

    let mut primary_written = false;
    if let Some(primary) = primary {
        write_device_id_atomic(primary, new_id)?;
        primary_written = true;
    }

    let mut wrote_any = primary_written;
    for path in legacy {
        if !path.exists() {
            continue;
        }
        match write_device_id_atomic(path, new_id) {
            Ok(()) => wrote_any = true,
            Err(error) => {
                if primary_written {
                    tracing::warn!(
                        "更新旧设备 ID 副本 {} 失败（主路径已更新，读取仍以主路径为准）: {}",
                        path.display(),
                        error
                    );
                } else {
                    return Err(error);
                }
            }
        }
    }

    if !wrote_any {
        for path in legacy {
            if write_device_id_atomic(path, new_id).is_ok() {
                wrote_any = true;
                break;
            }
        }
    }
    if !wrote_any {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no writable device id location",
        ));
    }
    Ok(())
}

/// Persist a pre-generated restore identity. Supplying the identity from the
/// restore journal makes retries idempotent after a crash or partial I/O error.
pub fn persist_device_id_after_restore(new_id: &str) -> std::io::Result<()> {
    let primary = primary_device_id_path();
    persist_device_id_to_paths(primary.as_deref(), &legacy_device_id_paths(), new_id)?;
    std::env::set_var("DEVICE_ID", new_id);
    Ok(())
}

pub fn rotate_device_id_after_restore() -> std::io::Result<(String, String)> {
    let old_id = get_device_id();
    let new_id = generate_device_id_after_restore();
    persist_device_id_after_restore(&new_id)?;
    tracing::info!("设备 ID 已在恢复后轮换: old={}, new={}", old_id, new_id);
    Ok((old_id, new_id))
}

#[cfg(test)]
mod device_id_tests {
    use super::*;
    use std::path::PathBuf;

    fn write(path: &Path, contents: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    #[test]
    fn primary_path_takes_precedence_over_legacy() {
        let temp = tempfile::tempdir().unwrap();
        let primary = temp.path().join(".device_id");
        let legacy = temp.path().join("legacy").join(".device_id");
        write(&primary, "primary-id");
        write(&legacy, "legacy-id");

        let resolution = resolve_or_create_device_id(Some(&primary), &[legacy]);
        assert_eq!(resolution.id, "primary-id");
        assert!(resolution.persisted);
    }

    #[test]
    fn legacy_id_is_migrated_to_primary_once() {
        let temp = tempfile::tempdir().unwrap();
        let primary = temp.path().join(".device_id");
        let legacy = temp.path().join("legacy").join(".device_id");
        write(&legacy, "old-device");

        let resolution = resolve_or_create_device_id(Some(&primary), &[legacy.clone()]);
        assert_eq!(resolution.id, "old-device");
        assert!(resolution.persisted);
        // 迁移后主路径持有同一身份；此后即使旧文件被改动也不再影响读取。
        assert_eq!(
            std::fs::read_to_string(&primary).unwrap().trim(),
            "old-device"
        );
        write(&legacy, "tampered");
        let second = resolve_or_create_device_id(Some(&primary), &[legacy]);
        assert_eq!(second.id, "old-device");
    }

    #[test]
    fn legacy_candidates_are_consulted_in_priority_order() {
        let temp = tempfile::tempdir().unwrap();
        let primary = temp.path().join(".device_id");
        let app_root_legacy = temp.path().join("device_id");
        let global_legacy = temp.path().join("deep-student").join(".device_id");
        write(&app_root_legacy, "app-root-id");
        write(&global_legacy, "global-id");

        let resolution =
            resolve_or_create_device_id(Some(&primary), &[app_root_legacy, global_legacy]);
        assert_eq!(resolution.id, "app-root-id");
    }

    #[test]
    fn generated_id_is_persisted_to_primary_and_stable_afterwards() {
        let temp = tempfile::tempdir().unwrap();
        let primary = temp.path().join(".device_id");

        let first = resolve_or_create_device_id(Some(&primary), &[]);
        assert!(first.persisted, "新生成的 ID 必须成功写入主路径");
        assert!(!first.id.is_empty());
        assert_eq!(std::fs::read_to_string(&primary).unwrap().trim(), first.id);

        let second = resolve_or_create_device_id(Some(&primary), &[]);
        assert_eq!(second.id, first.id, "再次解析必须读回同一身份");
    }

    #[test]
    fn persist_failure_is_reported_instead_of_faked() {
        let temp = tempfile::tempdir().unwrap();
        // 用一个普通文件占住"父目录"位置，使 create_dir_all 必然失败。
        let blocker = temp.path().join("blocker");
        std::fs::write(&blocker, "file").unwrap();
        let primary = blocker.join(".device_id");

        let resolution = resolve_or_create_device_id(Some(&primary), &[]);
        assert!(
            !resolution.persisted,
            "主路径不可写时必须如实报告未持久化，而不是假装成功"
        );

        // 主路径完全缺失（数据目录未初始化）同样不能宣称已持久化。
        let resolution = resolve_or_create_device_id(None, &[]);
        assert!(!resolution.persisted);
    }

    #[test]
    fn persist_writes_primary_and_refreshes_existing_legacy_copies() {
        let temp = tempfile::tempdir().unwrap();
        let primary = temp.path().join(".device_id");
        let stale_legacy = temp.path().join("device_id");
        let absent_legacy = temp.path().join("deep-student").join(".device_id");
        write(&stale_legacy, "old-identity");

        persist_device_id_to_paths(
            Some(&primary),
            &[stale_legacy.clone(), absent_legacy.clone()],
            "rotated-identity",
        )
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(&primary).unwrap().trim(),
            "rotated-identity"
        );
        // 已存在的旧副本必须同步更新，否则旧读取逻辑会复活轮换前的身份。
        assert_eq!(
            std::fs::read_to_string(&stale_legacy).unwrap().trim(),
            "rotated-identity"
        );
        // 不存在的旧路径不应被无谓创建。
        assert!(!absent_legacy.exists());
    }

    #[test]
    fn persist_fails_when_primary_is_unwritable() {
        let temp = tempfile::tempdir().unwrap();
        let blocker = temp.path().join("blocker");
        std::fs::write(&blocker, "file").unwrap();
        let primary = blocker.join(".device_id");
        let legacy: Vec<PathBuf> = vec![temp.path().join("device_id")];

        let error =
            persist_device_id_to_paths(Some(&primary), &legacy, "new-identity").unwrap_err();
        assert!(!legacy[0].exists(), "主路径失败时不应留下部分写入");
        let _ = error;
    }

    #[test]
    fn persist_falls_back_to_legacy_when_primary_unavailable() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("deep-student").join(".device_id");

        persist_device_id_to_paths(None, &[legacy.clone()], "fallback-identity").unwrap();
        assert_eq!(
            std::fs::read_to_string(&legacy).unwrap().trim(),
            "fallback-identity"
        );
    }

    #[test]
    fn persist_rejects_empty_identity() {
        let temp = tempfile::tempdir().unwrap();
        let primary = temp.path().join(".device_id");
        assert!(persist_device_id_to_paths(Some(&primary), &[], "  ").is_err());
    }

    #[test]
    fn read_device_id_file_normalizes_and_rejects_blank() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(".device_id");

        write(&path, "  spaced-id \n");
        assert_eq!(read_device_id_file(&path).unwrap(), "spaced-id");

        write(&path, "   \n");
        assert_eq!(read_device_id_file(&path), None);

        // 非法字符会被 normalize 成稳定哈希，而不是原样进入云端路径。
        write(&path, "../evil");
        let normalized = read_device_id_file(&path).unwrap();
        assert!(normalized.starts_with("device-"));
    }
}

#[cfg(test)]
mod tests {
    use super::super::traits::FileInfo;
    use super::*;
    use async_trait::async_trait;
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct MemoryStorage {
        files: Mutex<BTreeMap<String, (Vec<u8>, DateTime<Utc>)>>,
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
            self.files
                .lock()
                .unwrap()
                .insert(key.to_string(), (data.to_vec(), Utc::now()));
            Ok(())
        }

        async fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
            Ok(self
                .files
                .lock()
                .unwrap()
                .get(key)
                .map(|(data, _)| data.clone()))
        }

        async fn list(&self, prefix: &str) -> Result<Vec<FileInfo>> {
            let mut files: Vec<FileInfo> = self
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
                .collect();
            files.sort_by(|left, right| right.last_modified.cmp(&left.last_modified));
            Ok(files)
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

    fn manager_on(storage: &Arc<MemoryStorage>, device_id: &str) -> CloudSyncManager {
        CloudSyncManager::new(Box::new(Arc::clone(storage)), device_id.to_string())
    }

    // ================== [R5-prove-cost] prove 首块降本 ==================

    /// 计数存储：声明支持前缀读取，并记录 backups/ 对象的整包 `get` 与
    /// 每次 `get_prefix`——试解成本断言（首块路径不得整包下载）的观测点。
    struct PrefixReadStorage {
        inner: Arc<MemoryStorage>,
        prefix_reads: Mutex<Vec<(String, u64)>>,
        full_backup_gets: Mutex<Vec<String>>,
    }

    impl PrefixReadStorage {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                inner: Arc::new(MemoryStorage::default()),
                prefix_reads: Mutex::new(Vec::new()),
                full_backup_gets: Mutex::new(Vec::new()),
            })
        }

        fn reset_counters(&self) {
            self.prefix_reads.lock().unwrap().clear();
            self.full_backup_gets.lock().unwrap().clear();
        }

        fn prefix_reads_snapshot(&self) -> Vec<(String, u64)> {
            self.prefix_reads.lock().unwrap().clone()
        }

        fn prefix_read_count(&self) -> usize {
            self.prefix_reads.lock().unwrap().len()
        }

        fn full_backup_get_count(&self) -> usize {
            self.full_backup_gets.lock().unwrap().len()
        }

        fn object(&self, key: &str) -> Vec<u8> {
            self.inner
                .files
                .lock()
                .unwrap()
                .get(key)
                .map(|(data, _)| data.clone())
                .expect("对象应存在")
        }

        fn object_len(&self, key: &str) -> u64 {
            self.object(key).len() as u64
        }

        fn put_raw(&self, key: &str, data: Vec<u8>) {
            self.inner
                .files
                .lock()
                .unwrap()
                .insert(key.to_string(), (data, Utc::now()));
        }
    }

    #[async_trait]
    impl CloudStorage for Arc<PrefixReadStorage> {
        fn provider_name(&self) -> &'static str {
            "memory-prefix-read"
        }

        async fn check_connection(&self) -> Result<()> {
            Ok(())
        }

        async fn put(&self, key: &str, data: &[u8]) -> Result<()> {
            self.inner.put(key, data).await
        }

        async fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
            if key.starts_with(BACKUPS_DIR) {
                self.full_backup_gets.lock().unwrap().push(key.to_string());
            }
            self.inner.get(key).await
        }

        async fn list(&self, prefix: &str) -> Result<Vec<FileInfo>> {
            self.inner.list(prefix).await
        }

        async fn delete(&self, key: &str) -> Result<()> {
            self.inner.delete(key).await
        }

        async fn stat(&self, key: &str) -> Result<Option<FileInfo>> {
            self.inner.stat(key).await
        }

        fn supports_prefix_read(&self) -> bool {
            true
        }

        async fn get_prefix(&self, key: &str, prefix_len: u64) -> Result<Option<Vec<u8>>> {
            self.prefix_reads
                .lock()
                .unwrap()
                .push((key.to_string(), prefix_len));
            Ok(self.inner.files.lock().unwrap().get(key).map(|(data, _)| {
                let end = (prefix_len as usize).min(data.len());
                data[..end].to_vec()
            }))
        }
    }

    fn manager_on_prefix(storage: &Arc<PrefixReadStorage>, device_id: &str) -> CloudSyncManager {
        CloudSyncManager::new(Box::new(Arc::clone(storage)), device_id.to_string())
    }

    /// 用低成本 Argon2 参数（容器头如实登记，互操作不受影响）把 `payload`
    /// 加密成 DSBK v2 文件并走真实 upload 管线入云，返回版本 ID。
    async fn seed_v2_backup(
        storage: &Arc<PrefixReadStorage>,
        password: &str,
        payload: &[u8],
    ) -> String {
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("backup.zip");
        let sealed = dir.path().join("backup.zip.dsbk");
        std::fs::write(&plain, payload).unwrap();
        crate::crypto::backup_crypto::FileCipherSession::with_params(password, 8, 1, 1)
            .unwrap()
            .encrypt_file(&plain, &sealed)
            .unwrap();
        manager_on_prefix(storage, "device-seeder")
            .upload(&sealed, Some("1.0.0".into()), None)
            .await
            .expect("播种加密备份应成功")
            .version
            .id
    }

    /// [R5-prove-cost][要求 1/3] v2 备份 + 支持前缀读取的后端：v1 标记升级
    /// 只读「头 + 首块」，不整包下载、不产生任何 backups/ 整包 get。
    #[tokio::test]
    async fn prove_uses_first_chunk_without_full_download_for_v2() {
        let storage = PrefixReadStorage::new();
        manager_on_prefix(&storage, "device-legacy")
            .persist_encryption_marker()
            .await
            .unwrap();
        // 3 个分块（2 MiB + 123 B 明文）：首块前缀必须严格小于整包
        let version_id =
            seed_v2_backup(&storage, "team-pw-2026", &vec![7u8; 2 * 1024 * 1024 + 123]).await;
        storage.reset_counters();

        let manager = manager_on_prefix(&storage, "device-a");
        let upgraded = manager
            .verify_encryption_password_before_upload("team-pw-2026")
            .await
            .expect("首块试解应证明口令并完成一次性升级");
        assert_eq!(upgraded.version, ENCRYPTION_MARKER_VERSION_WITH_VERIFIER);
        assert!(upgraded.key_verifier.is_some());

        assert!(storage.prefix_read_count() >= 1, "必须走前缀读取");
        assert_eq!(
            storage.full_backup_get_count(),
            0,
            "首块路径不得整包下载 backups/ 对象"
        );
        let object_len = storage.object_len(&format!("{}/{}.zip", BACKUPS_DIR, version_id));
        for (key, len) in storage.prefix_reads_snapshot() {
            assert!(
                key.ends_with(&format!("{version_id}.zip")),
                "前缀读取目标: {key}"
            );
            assert!(
                len < object_len,
                "前缀读取必须严格小于整包（{len} < {object_len}）"
            );
        }
    }

    /// [R5-prove-cost][要求 3] 错密码在首块 tag 校验即失败：不整包下载、
    /// 不改动标记，错误码与文案与历史一致。
    #[tokio::test]
    async fn prove_wrong_password_fails_fast_on_first_chunk() {
        let storage = PrefixReadStorage::new();
        manager_on_prefix(&storage, "device-legacy")
            .persist_encryption_marker()
            .await
            .unwrap();
        let version_id =
            seed_v2_backup(&storage, "team-pw-2026", &vec![9u8; 2 * 1024 * 1024]).await;
        storage.reset_counters();

        let manager = manager_on_prefix(&storage, "device-mistaken");
        let error = manager
            .verify_encryption_password_before_upload("wrong-pw-2026")
            .await
            .expect_err("错密码必须被首块试解拦截")
            .to_string();
        assert!(
            error.contains(crate::cloud_storage::SYNC_E2EE_WRONG_PASSWORD_CODE),
            "必须带稳定错误码: {error}"
        );
        assert!(
            error.contains("试解") && error.contains("未通过") && error.contains(&version_id),
            "文案必须与历史一致（指出试解未通过与版本）: {error}"
        );
        assert_eq!(
            storage.full_backup_get_count(),
            0,
            "错密码不得触发整包下载（秒级失败，不等全量）"
        );
        let marker = manager.read_encryption_marker().await.unwrap().unwrap();
        assert_eq!(marker.version, 1, "试解失败必须保持 v1 标记原样");
        assert!(marker.key_verifier.is_none());
    }

    /// [R5-prove-cost][要求 2] 最新对象首块损坏：回退次新版本再试一块，
    /// 正确密码不被损坏对象挡在门外；两次尝试都只读前缀。
    #[tokio::test]
    async fn prove_falls_back_to_second_newest_when_latest_corrupt() {
        let storage = PrefixReadStorage::new();
        manager_on_prefix(&storage, "device-legacy")
            .persist_encryption_marker()
            .await
            .unwrap();
        let older = seed_v2_backup(&storage, "team-pw-2026", b"older intact backup").await;
        let newest = seed_v2_backup(&storage, "team-pw-2026", b"newest to corrupt").await;
        assert_ne!(older, newest);

        // 损坏最新对象的首块密文（保留可解析的 v2 头）：首块 tag 必然失败。
        let newest_key = format!("{}/{}.zip", BACKUPS_DIR, newest);
        let mut bytes = storage.object(&newest_key);
        bytes[crate::crypto::backup_crypto::DSBK_V2_HEADER_LEN + 1] ^= 0xFF;
        storage.put_raw(&newest_key, bytes);
        storage.reset_counters();

        let manager = manager_on_prefix(&storage, "device-a");
        let upgraded = manager
            .verify_encryption_password_before_upload("team-pw-2026")
            .await
            .expect("最新对象损坏时必须回退次新版本完成口令证明");
        assert_eq!(upgraded.version, ENCRYPTION_MARKER_VERSION_WITH_VERIFIER);
        assert!(
            storage.prefix_read_count() >= 2,
            "最新 + 次新各至少一次前缀读取"
        );
        assert_eq!(
            storage.full_backup_get_count(),
            0,
            "回退同样走首块，不整包下载"
        );
        let touched: Vec<String> = storage
            .prefix_reads_snapshot()
            .into_iter()
            .map(|(k, _)| k)
            .collect();
        assert!(
            touched.iter().any(|k| k.contains(&older)),
            "必须读到次新版本的前缀: {touched:?}"
        );
    }

    /// [R5-prove-cost][要求 4] 存量 DSBK v1 单块容器：无法部分试解，
    /// 必须仍可经整文件回退路径证明口令（先读前缀判定版本，再整包下载）。
    #[tokio::test]
    async fn prove_v1_container_still_proves_via_whole_file() {
        let storage = PrefixReadStorage::new();
        manager_on_prefix(&storage, "device-legacy")
            .persist_encryption_marker()
            .await
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let sealed = dir.path().join("legacy.dsbk");
        std::fs::write(
            &sealed,
            crate::crypto::backup_crypto::encrypt_backup(b"legacy v1 payload", "team-pw-2026")
                .unwrap(),
        )
        .unwrap();
        manager_on_prefix(&storage, "device-seeder")
            .upload(&sealed, Some("0.9.44".into()), None)
            .await
            .unwrap();
        storage.reset_counters();

        let manager = manager_on_prefix(&storage, "device-a");
        let upgraded = manager
            .verify_encryption_password_before_upload("team-pw-2026")
            .await
            .expect("v1 容器必须仍可经整文件回退证明口令");
        assert_eq!(upgraded.version, ENCRYPTION_MARKER_VERSION_WITH_VERIFIER);
        assert!(
            storage.prefix_read_count() >= 1,
            "先读前缀判定容器版本（v1 → 整文件回退）"
        );
        assert!(
            storage.full_backup_get_count() >= 1,
            "v1 回退必须整包下载（历史行为保持）"
        );
    }

    /// [R5-prove-cost] marker 缺失的 v0.9.44 明文 ZIP：4 字节魔数判别即可
    /// 放行启用 E2EE，不整包下载。
    #[tokio::test]
    async fn prove_plain_zip_detected_from_prefix_without_full_download() {
        let storage = PrefixReadStorage::new();
        let dir = tempfile::tempdir().unwrap();
        let plain_zip = dir.path().join("legacy.zip");
        std::fs::write(&plain_zip, b"PK\x03\x04legacy plaintext zip payload").unwrap();
        manager_on_prefix(&storage, "device-legacy")
            .upload(&plain_zip, Some("0.9.44".into()), None)
            .await
            .unwrap();
        storage.reset_counters();

        let manager = manager_on_prefix(&storage, "device-upgraded");
        let marker = manager
            .verify_encryption_password_before_upload("new-e2ee-pw")
            .await
            .expect("没有既有密码的明文 ZIP 不应阻断首次启用 E2EE");
        assert_eq!(marker.version, ENCRYPTION_MARKER_VERSION_WITH_VERIFIER);
        assert!(storage.prefix_read_count() >= 1, "判别走前缀读取");
        assert_eq!(
            storage.full_backup_get_count(),
            0,
            "明文判别只需前缀魔数，不整包下载"
        );
    }

    /// [R5-prove-cost] 外部工具写出的非默认大分块（4 MiB）v2 容器：投机前缀
    /// （≈1 MiB）不够首块，必须按计划精确补读一次；伪造首块试解失败时也
    /// 绝不整包下载（fail-closed 且成本有界）。
    #[tokio::test]
    async fn prove_non_default_chunk_triggers_precise_topup_read() {
        let storage = PrefixReadStorage::new();
        manager_on_prefix(&storage, "device-legacy")
            .persist_encryption_marker()
            .await
            .unwrap();

        // 手工构造：合法 v2 头（低成本 KDF 参数，派生秒级）+ 5 MiB 伪密文体。
        let mut object = Vec::new();
        object.extend_from_slice(b"DSBK");
        object.push(2);
        object.extend_from_slice(&8u32.to_le_bytes()); // m_cost
        object.extend_from_slice(&1u32.to_le_bytes()); // t_cost
        object.extend_from_slice(&1u32.to_le_bytes()); // p_cost
        object.extend_from_slice(&[0u8; 16]); // salt
        object.extend_from_slice(&[0u8; 7]); // nonce prefix
        object.extend_from_slice(&(4u32 * 1024 * 1024).to_le_bytes()); // chunk = 4 MiB
        object.extend_from_slice(&vec![0xA5u8; 5 * 1024 * 1024]); // 伪密文体
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("foreign.dsbk");
        std::fs::write(&path, &object).unwrap();
        manager_on_prefix(&storage, "device-seeder")
            .upload(&path, None, None)
            .await
            .unwrap();
        storage.reset_counters();

        let manager = manager_on_prefix(&storage, "device-a");
        let error = manager
            .verify_encryption_password_before_upload("any-pw")
            .await
            .expect_err("伪造首块必须试解失败（fail-closed）")
            .to_string();
        assert!(error.contains("未通过"), "错误应为试解未通过文案: {error}");
        assert!(
            storage.prefix_read_count() >= 2,
            "非默认分块必须触发按计划补读"
        );
        assert_eq!(storage.full_backup_get_count(), 0, "失败也不得整包下载");
    }

    #[tokio::test]
    async fn plaintext_upload_allowed_without_marker() {
        let storage = Arc::new(MemoryStorage::default());
        let manager = manager_on(&storage, "device-a");

        assert!(manager.read_encryption_marker().await.unwrap().is_none());
        manager
            .enforce_encryption_policy_before_upload(false)
            .await
            .expect("无标记时明文上传应放行");
    }

    #[tokio::test]
    async fn plaintext_upload_rejected_when_marker_present() {
        let storage = Arc::new(MemoryStorage::default());

        // 另一台设备曾经加密上传，在该 root 留下标记
        let other_device = manager_on(&storage, "device-a");
        other_device.persist_encryption_marker().await.unwrap();

        // 本机未配置 encryption_password：cloud_sync_upload 会先执行策略检查，
        // 检查失败即 upload 失败（不会有任何对象被写入 backups/）。
        let manager = manager_on(&storage, "device-b");
        let error = manager
            .enforce_encryption_policy_before_upload(false)
            .await
            .expect_err("有加密标记且无密码时必须拒绝明文上传");
        assert!(
            error
                .to_string()
                .contains(crate::cloud_storage::SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE),
            "明文上传拒绝必须带稳定 code: {error}"
        );
        assert!(
            error.to_string().contains("加密"),
            "错误应提示需要加密密码: {error}"
        );
        assert!(
            !storage
                .files
                .lock()
                .unwrap()
                .keys()
                .any(|key| key.starts_with(BACKUPS_DIR)),
            "被拒绝的明文上传不应产生任何备份对象"
        );
        // 标记本身保持不变
        let marker = manager.read_encryption_marker().await.unwrap().unwrap();
        assert_eq!(marker.created_by_device, device_id_short_hash("device-a"));
    }

    #[tokio::test]
    async fn encrypted_upload_succeeds_and_keeps_marker() {
        let storage = Arc::new(MemoryStorage::default());
        let manager = manager_on(&storage, "device-a");

        // 配置了密码：首次上传登记带校验子的 v2 标记后放行
        manager
            .enforce_encryption_policy_before_upload_with_password(Some("pw-2026"))
            .await
            .expect("有密码时上传前策略应放行");
        let first = manager.read_encryption_marker().await.unwrap().unwrap();
        assert_eq!(first.version, ENCRYPTION_MARKER_VERSION_WITH_VERIFIER);
        assert_eq!(first.created_by_device, device_id_short_hash("device-a"));
        assert!(
            first.key_verifier.is_some(),
            "新登记的标记必须携带密码校验子"
        );

        let dir = tempfile::tempdir().unwrap();
        let zip = dir.path().join("backup.dsbk");
        std::fs::write(&zip, b"DSBK pretend-encrypted payload").unwrap();
        let result = manager
            .upload(&zip, Some("1.0.0".into()), None)
            .await
            .expect("加密上传应成功");
        assert_eq!(result.version.device_id, "device-a");

        // 同密码再次加密上传：标记保持（不被覆盖，首次写入者信息与校验子不变）
        manager
            .enforce_encryption_policy_before_upload_with_password(Some("pw-2026"))
            .await
            .unwrap();
        let second = manager.read_encryption_marker().await.unwrap().unwrap();
        assert_eq!(second.created_at, first.created_at);
        assert_eq!(second.created_by_device, first.created_by_device);
        assert_eq!(second.key_verifier, first.key_verifier);
    }

    /// [R06] 核心场景：配错密码的设备必须在上传前失败，且不向 backups/ 写入任何对象。
    #[tokio::test]
    async fn wrong_password_upload_rejected_before_any_backup_write() {
        let storage = Arc::new(MemoryStorage::default());

        // 设备 A 用正确密码登记了带校验子的标记
        let device_a = manager_on(&storage, "device-a");
        device_a
            .enforce_encryption_policy_before_upload_with_password(Some("correct-pw"))
            .await
            .unwrap();
        let original = device_a.read_encryption_marker().await.unwrap().unwrap();

        // 设备 B 配了错误密码：cloud_sync_upload 会先执行本策略，失败即整个上传失败
        let device_b = manager_on(&storage, "device-b");
        let error = device_b
            .enforce_encryption_policy_before_upload_with_password(Some("wrong-pw"))
            .await
            .expect_err("错误密码必须在上传前被拦截");
        assert!(
            error.to_string().contains("不一致"),
            "错误信息应指出密码不一致: {error}"
        );

        // 不得向 backups/ 写入任何对象，标记也不得被改写
        assert!(
            !storage
                .files
                .lock()
                .unwrap()
                .keys()
                .any(|key| key.starts_with(BACKUPS_DIR)),
            "被拦截的错密码上传不应产生任何备份对象"
        );
        let after = device_b.read_encryption_marker().await.unwrap().unwrap();
        assert_eq!(after.created_by_device, original.created_by_device);
        assert_eq!(after.key_verifier, original.key_verifier);
    }

    /// [R06] 兼容性：旧版无校验子标记（version 1）被第一个带密码上传的设备
    /// 一次性升级；升级保留首次写入者与时间，升级后错密码设备即被拦截。
    #[tokio::test]
    async fn legacy_marker_without_verifier_is_upgraded_once() {
        let storage = Arc::new(MemoryStorage::default());

        // 旧版本应用留下的 v1 标记（无校验子）
        let legacy_writer = manager_on(&storage, "device-legacy");
        let legacy = legacy_writer.persist_encryption_marker().await.unwrap();
        assert_eq!(legacy.version, 1);
        assert!(legacy.key_verifier.is_none());

        // 升级后的应用带密码上传：一次性升级标记
        let device_a = manager_on(&storage, "device-a");
        let upgraded = device_a
            .verify_encryption_password_before_upload("team-pw")
            .await
            .expect("旧标记应被一次性升级而不是拒绝");
        assert_eq!(upgraded.version, ENCRYPTION_MARKER_VERSION_WITH_VERIFIER);
        assert_eq!(
            upgraded.created_by_device,
            device_id_short_hash("device-legacy"),
            "升级不得改写首次写入者"
        );
        assert_eq!(
            upgraded.created_at, legacy.created_at,
            "升级不得改写首次写入时间"
        );
        assert!(upgraded.key_verifier.is_some());

        // 升级后：同密码放行、错密码被拦
        device_a
            .verify_encryption_password_before_upload("team-pw")
            .await
            .expect("同密码应继续放行");
        let device_b = manager_on(&storage, "device-b");
        assert!(
            device_b
                .verify_encryption_password_before_upload("other-pw")
                .await
                .is_err(),
            "升级后错密码设备必须被拦截"
        );
    }

    fn marker_lease_key() -> String {
        format!(
            "{ENCRYPTION_MARKER_FILE}{}",
            crate::cloud_storage::e2ee_claim::ENCRYPTION_MARKER_LEASE_SUFFIX
        )
    }

    fn lease_bytes(device: &str, expires_in_secs: i64) -> Vec<u8> {
        let now = Utc::now();
        serde_json::to_vec_pretty(&crate::cloud_storage::e2ee_claim::EncryptionClaimLease {
            format_version: crate::cloud_storage::e2ee_claim::E2EE_CLAIM_LEASE_FORMAT_VERSION,
            device_id: device.to_string(),
            nonce: Uuid::new_v4().to_string(),
            created_at: now.to_rfc3339(),
            expires_at: (now + chrono::Duration::seconds(expires_in_secs)).to_rfc3339(),
        })
        .unwrap()
    }

    /// [R4-e2ee-cas] 要求 2（确定性半场）：空仓首次认领时，后到者必须看见
    /// 他人的活跃租约而失败，不得写入任何标记 / 备份对象。
    #[tokio::test]
    async fn first_claim_blocked_by_foreign_live_lease() {
        let storage = Arc::new(MemoryStorage::default());
        storage.files.lock().unwrap().insert(
            marker_lease_key(),
            (lease_bytes("device-other", 60), Utc::now()),
        );

        let manager = manager_on(&storage, "device-b");
        let error = manager
            .verify_encryption_password_before_upload("pw-b")
            .await
            .expect_err("他人租约在持时首次认领必须失败");
        assert!(
            error
                .to_string()
                .contains(crate::cloud_storage::e2ee_claim::SYNC_E2EE_CLAIM_CONFLICT_CODE),
            "认领冲突必须带稳定 code: {error}"
        );
        let files = storage.files.lock().unwrap();
        assert!(
            !files.contains_key(ENCRYPTION_MARKER_FILE),
            "被租约挡下的一方不得写入标记"
        );
        assert!(
            !files.keys().any(|key| key.starts_with(BACKUPS_DIR)),
            "被租约挡下的一方不得写入任何备份对象"
        );
    }

    /// [R4-e2ee-cas] 崩溃残留的过期租约必须可回收，认领继续（不会永久锁死）。
    #[tokio::test]
    async fn expired_foreign_lease_reclaimed_then_claim_succeeds() {
        let storage = Arc::new(MemoryStorage::default());
        storage.files.lock().unwrap().insert(
            marker_lease_key(),
            (lease_bytes("device-crashed", -5), Utc::now()),
        );

        let manager = manager_on(&storage, "device-b");
        let marker = manager
            .verify_encryption_password_before_upload("pw-b")
            .await
            .expect("过期租约必须可回收，认领继续");
        assert_eq!(marker.version, ENCRYPTION_MARKER_VERSION_WITH_VERIFIER);
        let files = storage.files.lock().unwrap();
        assert!(files.contains_key(ENCRYPTION_MARKER_FILE));
        assert!(
            !files.contains_key(&marker_lease_key()),
            "认领成功后租约必须被清理"
        );
    }

    /// [R4-e2ee-cas] 要求 3 的旁证：空仓 v1 升级（prove 直接放行的路径）同样
    /// 先过认领协议——他人租约在持时升级失败，v1 标记逐字节保持原样。
    #[tokio::test]
    async fn v1_upgrade_blocked_by_foreign_live_lease() {
        let storage = Arc::new(MemoryStorage::default());
        let legacy_writer = manager_on(&storage, "device-legacy");
        legacy_writer.persist_encryption_marker().await.unwrap();
        let v1_bytes = storage
            .files
            .lock()
            .unwrap()
            .get(ENCRYPTION_MARKER_FILE)
            .unwrap()
            .0
            .clone();

        storage.files.lock().unwrap().insert(
            marker_lease_key(),
            (lease_bytes("device-other", 60), Utc::now()),
        );

        let manager = manager_on(&storage, "device-b");
        let error = manager
            .verify_encryption_password_before_upload("pw-b")
            .await
            .expect_err("他人租约在持时 v1 升级必须失败");
        assert!(
            error
                .to_string()
                .contains(crate::cloud_storage::e2ee_claim::SYNC_E2EE_CLAIM_CONFLICT_CODE),
            "{error}"
        );
        assert_eq!(
            storage
                .files
                .lock()
                .unwrap()
                .get(ENCRYPTION_MARKER_FILE)
                .unwrap()
                .0,
            v1_bytes,
            "升级被拦下时 v1 标记必须逐字节保持原样"
        );
    }

    /// [R4-e2ee-cas] 发布前复验：上传前策略检查通过后、发布 manifest 前，
    /// 标记被并发改动（认领竞态的另一台赢家 / 篡改）必须回滚本次上传。
    #[tokio::test]
    async fn publish_recheck_rejects_marker_swapped_between_verify_and_publish() {
        let storage = Arc::new(MemoryStorage::default());
        let manager = manager_on(&storage, "device-a");
        manager
            .enforce_encryption_policy_before_upload_with_password(Some("pw-a"))
            .await
            .expect("首次认领应成功");

        // 模拟并发赢家在我们的上传窗口内改写了标记。
        storage.files.lock().unwrap().insert(
            ENCRYPTION_MARKER_FILE.to_string(),
            (
                b"{\"version\":2,\"createdByDevice\":\"other\"}".to_vec(),
                Utc::now(),
            ),
        );

        let dir = tempfile::tempdir().unwrap();
        let zip = dir.path().join("backup.dsbk");
        std::fs::write(&zip, b"DSBK pretend-encrypted payload").unwrap();
        let error = manager
            .upload(&zip, None, None)
            .await
            .expect_err("标记被并发改动后发布必须失败");
        assert!(
            error
                .to_string()
                .contains(crate::cloud_storage::e2ee_claim::SYNC_E2EE_CLAIM_CONFLICT_CODE),
            "发布前复验失败必须带稳定 code: {error}"
        );
        let files = storage.files.lock().unwrap();
        assert!(
            !files.keys().any(|key| key.starts_with(BACKUPS_DIR)),
            "复验失败必须回滚已上传的备份对象"
        );
        assert!(
            !files.keys().any(|key| key.starts_with(MANIFESTS_DIR)),
            "复验失败不得发布任何 manifest"
        );
    }

    /// [R4-e2ee-cas] 有界读：超限 marker 按损坏 fail-closed（加密、明文两路都拦），
    /// 且不下载对象本体。
    #[tokio::test]
    async fn oversized_marker_fails_closed_for_both_upload_paths() {
        let storage = Arc::new(MemoryStorage::default());
        let big = vec![
            b'x';
            (crate::cloud_storage::e2ee_claim::MAX_E2EE_CLAIM_OBJECT_BYTES + 1) as usize
        ];
        storage
            .files
            .lock()
            .unwrap()
            .insert(ENCRYPTION_MARKER_FILE.to_string(), (big, Utc::now()));

        let manager = manager_on(&storage, "device-a");
        let error = manager
            .verify_encryption_password_before_upload("pw")
            .await
            .expect_err("超限标记必须按损坏 fail-closed");
        assert!(
            error
                .to_string()
                .contains(crate::cloud_storage::SYNC_E2EE_MARKER_CORRUPTED_CODE),
            "{error}"
        );
        assert!(
            manager.ensure_plaintext_upload_allowed().await.is_err(),
            "超限标记同样必须拦下明文上传"
        );
    }

    /// 在每个存储操作前后让出调度点，让两台「设备」的认领步骤真实交错。
    struct YieldingStorage {
        inner: Arc<MemoryStorage>,
    }

    #[async_trait]
    impl CloudStorage for YieldingStorage {
        fn provider_name(&self) -> &'static str {
            "memory-yield"
        }

        async fn check_connection(&self) -> Result<()> {
            Ok(())
        }

        async fn put(&self, key: &str, data: &[u8]) -> Result<()> {
            tokio::task::yield_now().await;
            let result = CloudStorage::put(&self.inner, key, data).await;
            tokio::task::yield_now().await;
            result
        }

        async fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
            tokio::task::yield_now().await;
            let result = CloudStorage::get(&self.inner, key).await;
            tokio::task::yield_now().await;
            result
        }

        async fn list(&self, prefix: &str) -> Result<Vec<FileInfo>> {
            tokio::task::yield_now().await;
            let result = CloudStorage::list(&self.inner, prefix).await;
            tokio::task::yield_now().await;
            result
        }

        async fn delete(&self, key: &str) -> Result<()> {
            tokio::task::yield_now().await;
            let result = CloudStorage::delete(&self.inner, key).await;
            tokio::task::yield_now().await;
            result
        }

        async fn stat(&self, key: &str) -> Result<Option<FileInfo>> {
            tokio::task::yield_now().await;
            let result = CloudStorage::stat(&self.inner, key).await;
            tokio::task::yield_now().await;
            result
        }
    }

    /// [R4-e2ee-cas] 要求 2 / 5（真并发半场）：两台设备不同口令并发认领空仓，
    /// 任意调度交错下都**不得双成功**；若有赢家，云端校验子只绑定赢家口令。
    /// 双双失败允许（fail-closed，重试收敛）——此时若留下了标记，它也必须是
    /// 恰好绑定其中一个口令的完整认领对象（协议第 7 步失败不回滚 marker）。
    ///
    /// 确定性交错（B 停在写入前）的红灯用例见 `tests/e2ee_claim_race_tests.rs`。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_two_password_claims_never_both_succeed() {
        for round in 0..3 {
            let storage = Arc::new(MemoryStorage::default());
            let spawn_claim = |device: &str, password: &'static str| {
                let inner = Arc::clone(&storage);
                let device = device.to_string();
                tokio::spawn(async move {
                    let manager =
                        CloudSyncManager::new(Box::new(YieldingStorage { inner }), device);
                    manager
                        .verify_encryption_password_before_upload(password)
                        .await
                })
            };
            let task_a = spawn_claim("device-a", "pw-alpha-2026");
            let task_b = spawn_claim("device-b", "pw-beta-2026");
            let result_a = task_a.await.expect("device-a 任务不得 panic");
            let result_b = task_b.await.expect("device-b 任务不得 panic");

            assert!(
                !(result_a.is_ok() && result_b.is_ok()),
                "第 {round} 轮：两台不同口令设备的并发认领不得双成功: \
                 a={result_a:?}, b={result_b:?}"
            );

            let marker_raw = storage
                .files
                .lock()
                .unwrap()
                .get(ENCRYPTION_MARKER_FILE)
                .map(|(data, _)| data.clone());
            if result_a.is_ok() || result_b.is_ok() {
                let marker: EncryptionMarker =
                    serde_json::from_slice(marker_raw.as_deref().expect("有赢家时标记必须已发布"))
                        .expect("已发布标记必须可解析");
                let verifier = marker.key_verifier.as_ref().expect("认领标记必须带校验子");
                let winner_password = if result_a.is_ok() {
                    "pw-alpha-2026"
                } else {
                    "pw-beta-2026"
                };
                let loser_password = if result_a.is_ok() {
                    "pw-beta-2026"
                } else {
                    "pw-alpha-2026"
                };
                assert!(
                    crate::crypto::backup_crypto::check_password_verifier(
                        winner_password,
                        verifier
                    )
                    .unwrap(),
                    "第 {round} 轮：云端校验子必须绑定赢家口令"
                );
                assert!(
                    !crate::crypto::backup_crypto::check_password_verifier(
                        loser_password,
                        verifier
                    )
                    .unwrap(),
                    "第 {round} 轮：云端校验子不得同时放行输家口令"
                );
            } else if let Some(raw) = marker_raw {
                // 双双失败但留下了标记（第 7 步失败不回滚）：必须是完整认领，
                // 恰好绑定两个口令之一。
                let marker: EncryptionMarker =
                    serde_json::from_slice(&raw).expect("留下的标记必须可解析");
                let verifier = marker
                    .key_verifier
                    .as_ref()
                    .expect("留下的标记必须带校验子");
                let alpha = crate::crypto::backup_crypto::check_password_verifier(
                    "pw-alpha-2026",
                    verifier,
                )
                .unwrap();
                let beta =
                    crate::crypto::backup_crypto::check_password_verifier("pw-beta-2026", verifier)
                        .unwrap();
                assert!(
                    alpha ^ beta,
                    "第 {round} 轮：双失败留下的标记必须恰好绑定其中一个口令"
                );
            }
        }
    }

    /// [R06] 标记内容损坏时加密上传也 fail-closed（无法确认密码一致性）。
    #[tokio::test]
    async fn corrupted_marker_blocks_encrypted_upload() {
        let storage = Arc::new(MemoryStorage::default());
        storage.files.lock().unwrap().insert(
            ENCRYPTION_MARKER_FILE.to_string(),
            (b"not-json".to_vec(), Utc::now()),
        );

        let manager = manager_on(&storage, "device-a");
        let error = manager
            .enforce_encryption_policy_before_upload_with_password(Some("pw"))
            .await
            .expect_err("损坏标记必须拦截加密上传（fail-closed）");
        assert!(error.to_string().contains("损坏"), "{error}");

        // fail-closed 路径不得改写（掩盖）损坏的标记内容
        let raw = storage
            .files
            .lock()
            .unwrap()
            .get(ENCRYPTION_MARKER_FILE)
            .unwrap()
            .0
            .clone();
        assert_eq!(raw, b"not-json".to_vec());
    }

    struct CorruptEncryptionMarkerPut {
        inner: Arc<MemoryStorage>,
        persist: bool,
    }

    #[async_trait]
    impl CloudStorage for CorruptEncryptionMarkerPut {
        fn provider_name(&self) -> &'static str {
            "memory-corrupt-encryption-marker"
        }

        async fn check_connection(&self) -> Result<()> {
            Ok(())
        }

        async fn put(&self, key: &str, data: &[u8]) -> Result<()> {
            if key == ENCRYPTION_MARKER_FILE {
                if !self.persist {
                    return Ok(());
                }
                return CloudStorage::put(&self.inner, key, b"corrupted-encryption-marker").await;
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

    #[tokio::test]
    async fn persist_encryption_marker_fails_when_reread_mismatches() {
        let inner = Arc::new(MemoryStorage::default());
        let manager = CloudSyncManager::new(
            Box::new(CorruptEncryptionMarkerPut {
                inner: Arc::clone(&inner),
                persist: true,
            }),
            "device-marker-reread".to_string(),
        );
        let error = manager
            .persist_encryption_marker()
            .await
            .expect_err("加密标记回读不一致必须 fail-closed");
        assert!(
            error.to_string().contains("加密标记上传后回读不一致"),
            "拒绝原因必须指向标记回读，实际: {error}"
        );
        assert_eq!(
            inner
                .files
                .lock()
                .unwrap()
                .get(ENCRYPTION_MARKER_FILE)
                .map(|(data, _)| data.as_slice()),
            Some(b"corrupted-encryption-marker".as_slice()),
            "损坏的标记可保留供对照，但不得报成功"
        );
    }

    #[tokio::test]
    async fn persist_encryption_marker_fails_when_missing_after_put() {
        let inner = Arc::new(MemoryStorage::default());
        let manager = CloudSyncManager::new(
            Box::new(CorruptEncryptionMarkerPut {
                inner: Arc::clone(&inner),
                persist: false,
            }),
            "device-marker-missing".to_string(),
        );
        let error = manager
            .persist_encryption_marker()
            .await
            .expect_err("加密标记上传后缺失必须 fail-closed");
        assert!(
            error.to_string().contains("加密标记上传后对象不存在"),
            "拒绝原因必须指向标记缺失，实际: {error}"
        );
        assert!(
            inner
                .files
                .lock()
                .unwrap()
                .get(ENCRYPTION_MARKER_FILE)
                .is_none(),
            "假装成功却未落地的标记不得被当成已登记"
        );
    }

    /// [R06] 未知 KDF（可能来自更新版本应用）不能被当作旧标记升级覆盖，必须 fail-closed。
    #[tokio::test]
    async fn unknown_verifier_kdf_fails_closed() {
        let storage = Arc::new(MemoryStorage::default());
        let marker_json = serde_json::json!({
            "version": ENCRYPTION_MARKER_VERSION_WITH_VERIFIER,
            "createdByDevice": "device-future",
            "createdAt": Utc::now(),
            "keyVerifier": {
                "kdf": "quantum-kdf-9000",
                "mCost": 65536,
                "tCost": 3,
                "pCost": 4,
                "salt": "00112233445566778899aabbccddeeff",
                "digest": "00".repeat(32),
            }
        });
        storage.files.lock().unwrap().insert(
            ENCRYPTION_MARKER_FILE.to_string(),
            (serde_json::to_vec(&marker_json).unwrap(), Utc::now()),
        );

        let manager = manager_on(&storage, "device-a");
        let error = manager
            .verify_encryption_password_before_upload("pw")
            .await
            .expect_err("未知 KDF 必须 fail-closed");
        assert!(error.to_string().contains("无法校验"), "{error}");

        // 标记不得被覆盖（否则会破坏未来版本设备的校验依据）
        let after = manager.read_encryption_marker().await.unwrap().unwrap();
        assert_eq!(after.created_by_device, "device-future");
    }

    /// [R06] version >= 2 却缺校验子：不是合法旧标记，按损坏处理，不得走升级路径。
    #[tokio::test]
    async fn v2_marker_missing_verifier_fails_closed() {
        let storage = Arc::new(MemoryStorage::default());
        let marker_json = serde_json::json!({
            "version": ENCRYPTION_MARKER_VERSION_WITH_VERIFIER,
            "createdByDevice": "device-x",
            "createdAt": Utc::now(),
        });
        storage.files.lock().unwrap().insert(
            ENCRYPTION_MARKER_FILE.to_string(),
            (serde_json::to_vec(&marker_json).unwrap(), Utc::now()),
        );

        let manager = manager_on(&storage, "device-a");
        let error = manager
            .verify_encryption_password_before_upload("pw")
            .await
            .expect_err("v2 缺校验子必须 fail-closed 而不是被静默升级");
        assert!(
            error
                .to_string()
                .contains(crate::cloud_storage::SYNC_E2EE_MARKER_CORRUPTED_CODE),
            "v2 缺校验子必须带稳定 code: {error}"
        );
        assert!(error.to_string().contains("缺少密码校验子"), "{error}");
    }

    #[tokio::test]
    async fn corrupted_marker_still_blocks_plaintext_upload() {
        let storage = Arc::new(MemoryStorage::default());
        storage.files.lock().unwrap().insert(
            ENCRYPTION_MARKER_FILE.to_string(),
            (b"not-json".to_vec(), Utc::now()),
        );

        let manager = manager_on(&storage, "device-a");
        assert!(
            manager.ensure_plaintext_upload_allowed().await.is_err(),
            "标记损坏时必须 fail-closed，拒绝明文上传"
        );
    }

    #[test]
    fn old_backup_version_json_without_recovery_kind_still_deserializes() {
        let json = r#"{
            "id": "20260101-000000-000-abcd-1234abcd",
            "timestamp": "2026-01-01T00:00:00Z",
            "size": 12,
            "checksum": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "deviceId": "device-a"
        }"#;
        let version: BackupVersion =
            serde_json::from_str(json).expect("旧版本清单缺少 recoveryKind 必须仍能反序列化");
        assert!(version.recovery_kind.is_none());
        assert_eq!(version.device_id, "device-a");
    }

    #[test]
    fn mixed_manifest_keeps_old_unknown_and_new_recovery_kind() {
        let json = r#"{
            "version": 1,
            "latest": "new-id",
            "updatedAt": "2026-01-02T00:00:00Z",
            "versions": [
                {
                    "id": "new-id",
                    "timestamp": "2026-01-02T00:00:00Z",
                    "size": 2,
                    "checksum": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    "deviceId": "device-b",
                    "recoveryKind": "partial_archive"
                },
                {
                    "id": "old-id",
                    "timestamp": "2026-01-01T00:00:00Z",
                    "size": 1,
                    "checksum": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "deviceId": "device-a"
                }
            ]
        }"#;
        let manifest: CloudManifest =
            serde_json::from_str(json).expect("新旧版本混排的清单必须仍能反序列化");
        assert_eq!(
            manifest.versions[0].recovery_kind.as_deref(),
            Some("partial_archive")
        );
        assert!(manifest.versions[1].recovery_kind.is_none());
        let encoded = serde_json::to_string(&manifest).unwrap();
        assert!(encoded.contains("recoveryKind"));
        assert!(encoded.contains("partial_archive"));
    }

    #[tokio::test]
    async fn upload_persists_recovery_kind_for_list_and_status() {
        let storage = Arc::new(MemoryStorage::default());
        let manager = manager_on(&storage, "device-kind");
        let dir = tempfile::tempdir().unwrap();
        let zip = dir.path().join("backup.zip");
        std::fs::write(&zip, b"zip-bytes-for-recovery-kind").unwrap();

        let uploaded = manager
            .upload_with_progress(
                &zip,
                Some("1.2.3".into()),
                None,
                Some("partial_archive".into()),
                None,
            )
            .await
            .expect("带 recovery_kind 的上传应成功")
            .version;
        assert_eq!(uploaded.recovery_kind.as_deref(), Some("partial_archive"));

        let listed = manager.list_versions().await.expect("列出版本应成功");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].recovery_kind.as_deref(), Some("partial_archive"));

        let status = manager.get_status().await;
        assert_eq!(
            status
                .latest_version
                .as_ref()
                .and_then(|version| version.recovery_kind.as_deref()),
            Some("partial_archive")
        );
    }

    #[test]
    fn new_version_id_is_22_hex_and_not_a_timestamp() {
        let id = generate_neutral_version_id();
        assert_eq!(id.len(), NEUTRAL_VERSION_ID_LEN);
        assert!(
            id.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "中性版本 ID 必须是字母数字: {id}"
        );
        assert!(!id.contains('-'), "中性版本 ID 不得再带时间戳分段: {id}");
        let another = generate_neutral_version_id();
        assert_ne!(id, another, "连续生成的中性 ID 不得碰撞");
    }

    #[test]
    fn device_manifest_key_uses_short_hash_not_raw_device_id() {
        let storage = Arc::new(MemoryStorage::default());
        let manager = manager_on(&storage, "device-a");
        assert_eq!(
            manager.device_manifest_key(),
            format!("manifests/{}.json", device_id_short_hash("device-a"))
        );
        assert_eq!(
            manager.device_manifest_legacy_key(),
            "manifests/device-a.json"
        );
        assert_ne!(
            manager.device_manifest_key(),
            manager.device_manifest_legacy_key()
        );
    }

    struct CorruptFinalPutStorage {
        inner: Arc<MemoryStorage>,
    }

    #[async_trait]
    impl CloudStorage for CorruptFinalPutStorage {
        fn provider_name(&self) -> &'static str {
            "memory-corrupt-final"
        }

        async fn check_connection(&self) -> Result<()> {
            Ok(())
        }

        async fn put(&self, key: &str, data: &[u8]) -> Result<()> {
            // 只污染最终清单。ZIP 必须原样写入，否则上传后 size 闸会先拦下，
            // 测不到「发布后回读」这条路径。
            if key.ends_with(".json") {
                CloudStorage::put(&self.inner, key, b"corrupted-manifest").await
            } else {
                CloudStorage::put(&self.inner, key, data).await
            }
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

    struct TruncateZipPutStorage {
        inner: Arc<MemoryStorage>,
    }

    #[async_trait]
    impl CloudStorage for TruncateZipPutStorage {
        fn provider_name(&self) -> &'static str {
            "memory-truncate-zip"
        }

        async fn check_connection(&self) -> Result<()> {
            Ok(())
        }

        async fn put(&self, key: &str, data: &[u8]) -> Result<()> {
            if key.ends_with(".zip") && !data.is_empty() {
                CloudStorage::put(&self.inner, key, &data[..data.len() - 1]).await
            } else {
                CloudStorage::put(&self.inner, key, data).await
            }
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
    async fn upload_fails_when_remote_zip_size_mismatches() {
        let inner = Arc::new(MemoryStorage::default());
        let manager = CloudSyncManager::new(
            Box::new(TruncateZipPutStorage {
                inner: Arc::clone(&inner),
            }),
            "device-short-zip".to_string(),
        );
        let dir = tempfile::tempdir().unwrap();
        let zip = dir.path().join("backup.zip");
        std::fs::write(&zip, b"zip-bytes-should-not-shorten").unwrap();

        let error = manager
            .upload(&zip, Some("1.2.3".into()), None)
            .await
            .expect_err("远端短写必须 fail-closed");
        assert!(
            error.to_string().contains("云端备份对象上传后大小不一致"),
            "拒绝原因必须指向远端大小，实际: {error}"
        );
        assert!(
            !inner
                .files
                .lock()
                .unwrap()
                .keys()
                .any(|key| key.starts_with(BACKUPS_DIR)),
            "短包必须删除，不得进入版本清单"
        );
    }

    struct VanishZipPutStorage {
        inner: Arc<MemoryStorage>,
    }

    #[async_trait]
    impl CloudStorage for VanishZipPutStorage {
        fn provider_name(&self) -> &'static str {
            "memory-vanish-zip"
        }

        async fn check_connection(&self) -> Result<()> {
            Ok(())
        }

        async fn put(&self, key: &str, data: &[u8]) -> Result<()> {
            if key.ends_with(".zip") {
                return Ok(());
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

    #[tokio::test]
    async fn upload_fails_when_remote_zip_missing_after_put() {
        let inner = Arc::new(MemoryStorage::default());
        let manager = CloudSyncManager::new(
            Box::new(VanishZipPutStorage {
                inner: Arc::clone(&inner),
            }),
            "device-missing-zip".to_string(),
        );
        let dir = tempfile::tempdir().unwrap();
        let zip = dir.path().join("backup.zip");
        std::fs::write(&zip, b"zip-bytes-should-exist-remotely").unwrap();

        let error = manager
            .upload(&zip, Some("1.2.3".into()), None)
            .await
            .expect_err("上传后对象不存在必须 fail-closed");
        assert!(
            error.to_string().contains("云端备份对象上传后不存在"),
            "拒绝原因必须指向远端缺失，实际: {error}"
        );
        assert!(
            !inner
                .files
                .lock()
                .unwrap()
                .keys()
                .any(|key| key.starts_with(BACKUPS_DIR)),
            "假成功不得进入版本清单"
        );
    }

    #[tokio::test]
    async fn upload_fails_when_published_manifest_reread_mismatches() {
        let inner = Arc::new(MemoryStorage::default());
        let manager = CloudSyncManager::new(
            Box::new(CorruptFinalPutStorage {
                inner: Arc::clone(&inner),
            }),
            "device-corrupt".to_string(),
        );
        let dir = tempfile::tempdir().unwrap();
        let zip = dir.path().join("backup.zip");
        std::fs::write(&zip, b"zip-bytes-manifest-reread").unwrap();

        let error = manager
            .upload(&zip, Some("1.2.3".into()), None)
            .await
            .expect_err("最终清单回读不一致必须 fail-closed");
        assert!(
            error
                .to_string()
                .contains(super::super::verified_publish::VERIFIED_PUBLISH_MISMATCH_CODE),
            "拒绝原因必须携带 verified-publish 回读不一致稳定码，实际: {error}"
        );

        let files = inner.files.lock().unwrap();
        assert!(
            !files
                .keys()
                .any(|key| key.starts_with(BACKUPS_DIR) && key.ends_with(".zip")),
            "清单发布失败必须回滚未引用 ZIP，不得留下可见半包"
        );
        assert!(
            files.keys().any(|key| key.contains(".tmp-")),
            "已校验的暂存清单（KeepTmp）必须保留，供对照损坏的最终对象"
        );
    }

    #[tokio::test]
    async fn upload_without_recovery_kind_stays_unknown() {
        let storage = Arc::new(MemoryStorage::default());
        let manager = manager_on(&storage, "device-unknown");
        let dir = tempfile::tempdir().unwrap();
        let zip = dir.path().join("backup.zip");
        std::fs::write(&zip, b"zip-bytes-unknown-kind").unwrap();

        let uploaded = manager
            .upload(&zip, Some("1.2.3".into()), None)
            .await
            .expect("不带 recovery_kind 的上传应成功")
            .version;
        assert!(uploaded.recovery_kind.is_none());
        let listed = manager.list_versions().await.unwrap();
        assert!(listed[0].recovery_kind.is_none());
    }
}
