//! [R12-delta-upload] backup-v2 快照发布原语（DELTA-R11 §3.2–§3.3、§5）。
//!
//! **本模块未接线**：没有任何 Tauri command、UI、`sync_manager` 或其他生产
//! 入口调用本模块；生产 Cloud backup 仍是「全量 ZIP → 单对象 `put_file` 到
//! `backups/<version>.zip`」。**不得**因本模块存在而宣称增量备份 / 内容去重 /
//! CDC 已实现——它只是「未变文件复用 / 增量传输」的积木，本轮未接 UI 之前
//! 功能不可暴露（源码锁测试 `sync_r12_delta_upload.rs` 强制该事实）。
//!
//! [Wave2-D R5 裁决] 状态 = **experimental 隔离**；接线前置清单与升级路径见
//! docs/dev/wave2-D-backup-v2-decision.md。
//!
//! 职责边界：
//!
//! - 输入是一个**已验证**的备份 staging 根目录（含合法 `manifest.json`）。
//!   清单与交叉核对复用 [`crate::data_governance::backup::delta_inventory`]，
//!   任何不一致 fail-closed；本模块**不**检查 `.encryption-marker`（那是
//!   integration / `sync_manager` 的职责）。
//! - descriptor / 仓库配置的格式与校验复用 [`super::delta_format`]：每个
//!   [`SnapshotDescriptorV2`] 都是自包含完整对象表，禁止 parent / patch。
//! - 互斥复用 [`super::backup_lease`]：整个发布窗口持有 backup-v2 仓库租约，
//!   占用冒出稳定错误码 `E_BACKUP_LEASE_HELD`（绝不复用 `E_SYNC_LEASE_HELD`）。
//!
//! 对象布局（只写 backup-v2 namespace，**禁止**触碰 v1 的 `backups/` 与
//! `manifests/<device>.json`）：
//!
//! ```text
//! backup-v2/objects/<device_id>/<uuid>.dsbk      # 不可变逻辑文件对象（随机 key）
//! backup-v2/snapshots/<device_id>/<version_id>.dsbk
//! backup-v2/manifests/<device_id>.json           # per-device 版本索引（唯一 commit point）
//! backup-v2/config.dsbk                          # 仓库配置（首次写入，已存在不覆盖）
//! backup-v2/locks/                               # 只通过 backup_lease API
//! ```
//!
//! 发布顺序（硬约束）：inventory → 读旧 index/descriptor（损坏 fail-closed，
//! 零对象写入）→ 上传新对象（全新随机 key，回读校验）→ PUT snapshot
//! descriptor（回读校验）→ **最后**追加进 per-device 版本索引。任一步失败都
//! 不写 index、不回滚：已上传对象留作不可见孤儿（GC 属于后续路，不在本模块）。
//!
//! 复用规则：只走 [`InventoryDiff::reuse_candidates`]（`manifest.json` 永远
//! always-changed）；只读**本设备**上一份 descriptor，跨设备的对象一律不引用；
//! 复用不做 HEAD/GET 存在性确认（那是 restore / repo_check 的职责）。
//!
//! E2EE：调用方传入 [`FileCipherSession`] 时，新对象与 descriptor 用该会话
//! 加密（一次 Argon2 派生，跨对象复用密钥；**禁止**逐对象 `encrypt_backup_file`
//! 式派生）。明文 index 只含 version 元数据与密文哈希，**不**泄露逻辑路径与
//! 明文哈希（那些只存在于加密后的 descriptor 内）。

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::Path;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::backup_lease::acquire_backup_repo_lease;
use super::delta_format::{
    BackupV2RepoConfig, SnapshotDescriptorV2, SnapshotFileRefV2, BACKUP_V2_FORMAT,
    DELTA_FORMAT_VERSION, MAX_IDENTIFIER_BYTES, SNAPSHOT_V2_FORMAT,
};
use super::traits::{CloudStorage, Result};
use crate::crypto::backup_crypto::{is_encrypted_backup, FileCipherSession};
use crate::data_governance::backup::delta_inventory::{
    build_inventory_cross_checked, diff, DeltaInventory, InventoryEntry,
};
use crate::data_governance::backup::BackupError;
use crate::models::AppError;

/// 不可变逻辑文件对象目录（按设备再分一级）。
pub const BACKUP_V2_OBJECTS_PREFIX: &str = "backup-v2/objects/";
/// snapshot descriptor 目录（按设备再分一级）。
pub const BACKUP_V2_SNAPSHOTS_PREFIX: &str = "backup-v2/snapshots/";
/// per-device 版本索引目录；索引 PUT 是发布的唯一可见 commit point。
pub const BACKUP_V2_MANIFESTS_PREFIX: &str = "backup-v2/manifests/";
/// 仓库配置对象；首次发布写入，已存在则不覆盖。
pub const BACKUP_V2_CONFIG_KEY: &str = "backup-v2/config.dsbk";
/// per-device 版本索引的固定 format 字符串。
pub const BACKUP_V2_INDEX_FORMAT: &str = "backup-v2-index";
/// 版本索引按时间只保留本设备最近 N 条（**不**删除被裁掉的 snapshot/object，
/// GC 属于后续路）。
pub const DEFAULT_BACKUP_V2_MAX_VERSIONS: usize = 10;

/// 随机对象 key 撞车（`exists == true`）时的最大换 key 次数；uuid v4 空间下
/// 连续撞满说明存储行为异常，fail-closed。
const MAX_OBJECT_KEY_ATTEMPTS: usize = 16;

/// 发布参数。
pub struct PublishParams<'a> {
    /// 设备 ID；先经 `crate::cloud_storage::normalize_device_id` 规范化，
    /// 空白输入 fail-closed。
    pub device_id: &'a str,
    /// 可选应用版本（进入明文 index 的 version 元数据）。
    pub app_version: Option<&'a str>,
    /// 可选备注（进入明文 index 的 version 元数据）。
    pub note: Option<&'a str>,
    /// `Some`：新对象与 snapshot descriptor 必须用该会话加密
    /// （`encrypt_file` / `encrypt_bytes`，一次派生跨对象复用）；
    /// `None`：明文同布局。复用失败绝不回退改加密策略。
    pub cipher: Option<&'a FileCipherSession>,
}

/// 一次成功发布的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishResult {
    /// 新版本 ID（与 descriptor、index 条目一致）。
    pub version_id: String,
    /// snapshot descriptor 的云端 key。
    pub snapshot_key: String,
    /// 本版逻辑总字节数（= 全部逻辑文件明文大小之和）。
    pub logical_size: u64,
    /// 本版新上传逻辑文件的明文字节数之和。
    pub newly_uploaded_size: u64,
    /// 复用旧对象的逻辑文件明文字节数之和。
    pub reused_size: u64,
    /// 复用旧对象的逻辑文件数。
    pub reused_file_count: usize,
    /// 新上传对象的逻辑文件数。
    pub uploaded_file_count: usize,
}

// ============================================================================
// per-device 版本索引（明文 JSON；只含 version 元数据与密文哈希，
// 不含逻辑路径 / 明文哈希 / 对象引用——那些只在加密后的 descriptor 内）
// ============================================================================

/// 版本索引中的一个条目。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupV2IndexEntry {
    /// 版本 ID。
    pub id: String,
    /// RFC 3339 创建时间。
    pub timestamp: String,
    /// 产生该版本的设备 ID（必须与索引本身的 deviceId 一致）。
    pub device_id: String,
    /// 可选应用版本。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_version: Option<String>,
    /// 可选备注。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// 固定为 `snapshot-v2`。
    pub format: String,
    /// snapshot descriptor 的云端 key。
    pub snapshot_key: String,
    /// descriptor 存储字节（密文或明文）的 SHA-256。
    pub snapshot_cipher_sha256: String,
    /// descriptor 存储字节数。
    pub snapshot_size: u64,
    /// 逻辑总字节数。
    pub logical_size: u64,
    /// 该版新上传的逻辑字节数。
    pub newly_uploaded_size: u64,
}

/// per-device 版本索引（`backup-v2/manifests/<device_id>.json`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupV2DeviceIndex {
    /// 固定为 [`BACKUP_V2_INDEX_FORMAT`]。
    pub format: String,
    /// 固定为 [`DELTA_FORMAT_VERSION`]（恰好 2）；未来版本 fail-closed。
    pub format_version: u32,
    /// 本索引所属设备 ID。
    pub device_id: String,
    /// 最新版本 ID；versions 非空时必须指向其中一条。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest: Option<String>,
    /// RFC 3339 最近更新时间。
    pub updated_at: String,
    /// 版本条目，按 timestamp 降序（最新在前）。
    pub versions: Vec<BackupV2IndexEntry>,
}

fn is_hex_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 索引内标识符规则，与 `delta_format` 的 identifier 语义一致：
/// 非空、有上限、无控制字符、无 `/` 与 `\`。
fn validate_index_identifier(field: &str, value: &str) -> Result<()> {
    if value.is_empty() {
        return Err(AppError::validation(format!("{field} 不能为空")));
    }
    if value.len() > MAX_IDENTIFIER_BYTES {
        return Err(AppError::validation(format!(
            "{field} 超过 {MAX_IDENTIFIER_BYTES} 字节上限"
        )));
    }
    if value
        .chars()
        .any(|c| c.is_control() || c == '/' || c == '\\')
    {
        return Err(AppError::validation(format!(
            "{field} 含控制字符或路径分隔符"
        )));
    }
    Ok(())
}

impl BackupV2IndexEntry {
    fn validate(&self) -> Result<()> {
        validate_index_identifier("versions[].id", &self.id)?;
        validate_index_identifier("versions[].deviceId", &self.device_id)?;
        if DateTime::parse_from_rfc3339(&self.timestamp).is_err() {
            return Err(AppError::validation(
                "versions[].timestamp 必须是合法 RFC 3339 时间戳",
            ));
        }
        if self.format != SNAPSHOT_V2_FORMAT {
            return Err(AppError::validation(format!(
                "versions[].format 必须是 {SNAPSHOT_V2_FORMAT}，实际为 {}",
                self.format
            )));
        }
        if !self.snapshot_key.starts_with(BACKUP_V2_SNAPSHOTS_PREFIX) {
            return Err(AppError::validation(format!(
                "versions[].snapshotKey 必须位于 {BACKUP_V2_SNAPSHOTS_PREFIX} 下"
            )));
        }
        if self.snapshot_key.contains('\\')
            || self.snapshot_key.bytes().any(|b| b == 0)
            || self
                .snapshot_key
                .split('/')
                .any(|segment| segment.is_empty() || segment == "." || segment == "..")
        {
            return Err(AppError::validation(
                "versions[].snapshotKey 含非法路径段（穿越 / 空段 / 反斜杠 / NUL）",
            ));
        }
        if !is_hex_sha256(&self.snapshot_cipher_sha256) {
            return Err(AppError::validation(
                "versions[].snapshotCipherSha256 必须是 64 位十六进制 SHA-256",
            ));
        }
        Ok(())
    }
}

impl BackupV2DeviceIndex {
    fn empty(device_id: &str, now: DateTime<Utc>) -> Self {
        Self {
            format: BACKUP_V2_INDEX_FORMAT.to_string(),
            format_version: DELTA_FORMAT_VERSION,
            device_id: device_id.to_string(),
            latest: None,
            updated_at: now.to_rfc3339(),
            versions: Vec::new(),
        }
    }

    /// 全量校验：format/version 精确匹配、标识符与时间合法、条目设备一致、
    /// 版本 ID 唯一、`latest` 与 versions 互相印证。
    pub fn validate(&self) -> Result<()> {
        if self.format != BACKUP_V2_INDEX_FORMAT {
            return Err(AppError::validation(format!(
                "备份索引 format 必须是 {BACKUP_V2_INDEX_FORMAT}，实际为 {}",
                self.format
            )));
        }
        if self.format_version != DELTA_FORMAT_VERSION {
            return Err(AppError::validation(format!(
                "备份索引 formatVersion 必须恰好为 {DELTA_FORMAT_VERSION}，实际为 {}；\
                 未来版本 fail-closed，不猜测解读",
                self.format_version
            )));
        }
        validate_index_identifier("deviceId", &self.device_id)?;
        if DateTime::parse_from_rfc3339(&self.updated_at).is_err() {
            return Err(AppError::validation("updatedAt 必须是合法 RFC 3339 时间戳"));
        }
        let mut seen = HashSet::with_capacity(self.versions.len());
        for entry in &self.versions {
            entry.validate()?;
            if entry.device_id != self.device_id {
                return Err(AppError::validation(format!(
                    "索引条目 {} 的 deviceId 与索引本身不符，fail-closed",
                    entry.id
                )));
            }
            if !seen.insert(entry.id.as_str()) {
                return Err(AppError::validation(format!(
                    "索引版本 ID 重复：{}（fail-closed）",
                    entry.id
                )));
            }
        }
        match (&self.latest, self.versions.is_empty()) {
            (None, true) => {}
            (None, false) => {
                return Err(AppError::validation("索引 versions 非空时 latest 不能为空"));
            }
            (Some(latest), _) => {
                if !self.versions.iter().any(|entry| &entry.id == latest) {
                    return Err(AppError::validation(format!(
                        "索引 latest={latest} 未指向任何 versions 条目，fail-closed"
                    )));
                }
            }
        }
        Ok(())
    }

    /// 校验后编码为 JSON 字节。
    pub fn encode(&self) -> Result<Vec<u8>> {
        self.validate()?;
        serde_json::to_vec_pretty(self)
            .map_err(|e| AppError::internal(format!("备份索引序列化失败: {e}")))
    }

    /// 解码并全量校验；未知字段、未来版本、任何结构异常均 fail-closed。
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let index: Self = serde_json::from_slice(bytes)
            .map_err(|e| AppError::validation(format!("备份索引解析失败（fail-closed）: {e}")))?;
        index.validate()?;
        Ok(index)
    }
}

/// 某设备版本索引的云端 key。
pub fn device_index_key(device_id: &str) -> String {
    format!("{BACKUP_V2_MANIFESTS_PREFIX}{device_id}.json")
}

// ============================================================================
// 发布主流程
// ============================================================================

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn sha256_file(path: &Path) -> Result<(String, u64)> {
    let file = std::fs::File::open(path)
        .map_err(|e| AppError::file_system(format!("打开待上传文件失败 {path:?}: {e}")))?;
    let mut reader = std::io::BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut total: u64 = 0;
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|e| AppError::file_system(format!("读取待上传文件失败 {path:?}: {e}")))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total += read as u64;
    }
    Ok((format!("{:x}", hasher.finalize()), total))
}

fn backup_error(context: &str, error: BackupError) -> AppError {
    AppError::validation(format!("{context}: {error}"))
}

fn cipher_error(context: &str, error: anyhow::Error) -> AppError {
    AppError::internal(format!("{context}: {error}"))
}

/// 版本 ID：`YYYYMMDD-HHMMSS-mmm-<deviceShort>-<nonce>`（同 `sync_manager` 的
/// 形态；通过 `delta_format` 的 identifier 规则，无 `/`、`\`、控制字符）。
fn generate_version_id(device_id: &str, now: DateTime<Utc>) -> String {
    let device_short: String = device_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(6)
        .collect();
    let nonce: String = Uuid::new_v4()
        .simple()
        .to_string()
        .chars()
        .take(8)
        .collect();
    format!(
        "{}-{}-{}",
        now.format("%Y%m%d-%H%M%S-%3f"),
        device_short,
        nonce
    )
}

/// 把上一份同设备 descriptor 的文件表转成 [`DeltaInventory`]，供 diff 使用。
fn inventory_from_descriptor(descriptor: &SnapshotDescriptorV2) -> DeltaInventory {
    let mut entries: Vec<InventoryEntry> = descriptor
        .files
        .iter()
        .map(|file| InventoryEntry {
            logical_path: file.logical_path.clone(),
            size: file.size,
            plaintext_sha256: file.plaintext_sha256.clone(),
        })
        .collect();
    entries.sort_by(|a, b| a.logical_path.as_bytes().cmp(b.logical_path.as_bytes()));
    DeltaInventory {
        entries,
        logical_size: descriptor.logical_size,
    }
}

/// 读取并验证本设备上一份 snapshot descriptor。
///
/// GET 缺失、大小/哈希不符、解密失败、decode/validate 失败、设备不符——
/// 一律 fail-closed（零新对象写入），绝不猜测复用。
async fn load_previous_descriptor(
    storage: &dyn CloudStorage,
    index: &BackupV2DeviceIndex,
    device_id: &str,
    cipher: Option<&FileCipherSession>,
) -> Result<SnapshotDescriptorV2> {
    let latest_id = index
        .latest
        .as_deref()
        .ok_or_else(|| AppError::validation("索引缺少 latest，fail-closed"))?;
    let entry = index
        .versions
        .iter()
        .find(|entry| entry.id == latest_id)
        .ok_or_else(|| AppError::validation("索引 latest 指向不存在的条目，fail-closed"))?;

    let bytes = storage.get(&entry.snapshot_key).await?.ok_or_else(|| {
        AppError::validation(format!(
            "上一份 snapshot descriptor 缺失（{}），fail-closed：拒绝发布，零新对象写入",
            entry.snapshot_key
        ))
    })?;
    if bytes.len() as u64 != entry.snapshot_size
        || !sha256_hex(&bytes).eq_ignore_ascii_case(&entry.snapshot_cipher_sha256)
    {
        return Err(AppError::validation(format!(
            "上一份 snapshot descriptor（{}）与索引登记的大小/哈希不符，\
             fail-closed：拒绝发布，零新对象写入",
            entry.snapshot_key
        )));
    }

    let plaintext = match cipher {
        Some(session) => {
            if !is_encrypted_backup(&bytes) {
                return Err(AppError::validation(
                    "已配置加密会话，但上一份 descriptor 不是 DSBK 密文；\
                     加密策略不一致，fail-closed",
                ));
            }
            session.decrypt_bytes(&bytes).map_err(|e| {
                AppError::validation(format!(
                    "解密上一份 snapshot descriptor 失败（密码错或数据损坏），\
                     fail-closed：{e}"
                ))
            })?
        }
        None => {
            if is_encrypted_backup(&bytes) {
                return Err(AppError::validation(
                    "上一份 descriptor 是 DSBK 密文，但本次未提供加密会话；\
                     不得静默改变加密策略，fail-closed",
                ));
            }
            bytes
        }
    };

    let descriptor = SnapshotDescriptorV2::decode(&plaintext)?;
    if descriptor.device_id != device_id {
        return Err(AppError::validation(
            "上一份 descriptor 的 deviceId 与本设备不符；跨设备对象一律不复用，fail-closed",
        ));
    }
    if descriptor.version_id != latest_id {
        return Err(AppError::validation(
            "上一份 descriptor 的 versionId 与索引 latest 不符，fail-closed",
        ));
    }
    Ok(descriptor)
}

/// 上传一个新逻辑文件对象到全新随机 key，并 GET 回读核对字节。
async fn upload_new_object(
    storage: &dyn CloudStorage,
    staging_root: &Path,
    entry: &InventoryEntry,
    device_id: &str,
    cipher: Option<&FileCipherSession>,
    scratch_dir: &Path,
) -> Result<SnapshotFileRefV2> {
    let source = staging_root.join(&entry.logical_path);

    // 加密到与 staging 同文件系统的临时文件；一次会话密钥跨对象复用，
    // 绝不逐对象 Argon2（encrypt_backup_file 属于 v1 整 ZIP 路径）。
    let mut _encrypted_temp: Option<tempfile::TempPath> = None;
    let upload_path: std::path::PathBuf = match cipher {
        Some(session) => {
            let temp = tempfile::Builder::new()
                .prefix(".delta-object-")
                .suffix(".dsbk")
                .tempfile_in(scratch_dir)
                .map_err(|e| AppError::file_system(format!("创建加密临时文件失败: {e}")))?
                .into_temp_path();
            session
                .encrypt_file(&source, &temp)
                .map_err(|e| cipher_error("加密备份对象失败", e))?;
            let path = temp.to_path_buf();
            _encrypted_temp = Some(temp);
            path
        }
        None => source.clone(),
    };

    let (object_cipher_sha256, object_size) = sha256_file(&upload_path)?;

    // 全新随机 key；已存在则换新 uuid，禁止覆盖任何已有对象（不可变仓库）。
    let mut object_key = None;
    for _ in 0..MAX_OBJECT_KEY_ATTEMPTS {
        let candidate = format!(
            "{BACKUP_V2_OBJECTS_PREFIX}{device_id}/{}.dsbk",
            Uuid::new_v4()
        );
        if !storage.exists(&candidate).await? {
            object_key = Some(candidate);
            break;
        }
    }
    let object_key = object_key.ok_or_else(|| {
        AppError::internal("连续生成的随机对象 key 均已存在，存储行为异常，fail-closed")
    })?;

    storage.put_file(&object_key, &upload_path, None).await?;

    // 上传后 GET 回读，核对字节级 SHA-256 与大小；失败即中止发布
    // （已上传对象留作不可见孤儿，index 不会引用它们）。
    let readback = storage.get(&object_key).await?.ok_or_else(|| {
        AppError::network(format!(
            "对象 {object_key} 上传后回读缺失，已中止发布（fail-closed）"
        ))
    })?;
    if readback.len() as u64 != object_size || sha256_hex(&readback) != object_cipher_sha256 {
        return Err(AppError::network(format!(
            "对象 {object_key} 回读字节与本地不符，已中止发布（fail-closed）"
        )));
    }

    Ok(SnapshotFileRefV2 {
        logical_path: entry.logical_path.clone(),
        size: entry.size,
        plaintext_sha256: entry.plaintext_sha256.clone(),
        object_key,
        object_cipher_sha256,
    })
}

/// 把一个已验证的备份 staging 发布为 backup-v2 快照版本。
///
/// **未接线原语**：见模块文档；生产 Cloud backup 仍是整 ZIP 单对象上传，
/// 本函数存在不代表增量备份已实现。
///
/// 语义要点：
/// - 整个发布窗口持有 backup-v2 仓库租约；占用冒出 `E_BACKUP_LEASE_HELD`；
/// - 复用只依据本设备上一份 descriptor 的
///   [`InventoryDiff::reuse_candidates`]（`manifest.json` 永远重新上传）；
/// - 旧 index / descriptor 解析、校验、解密失败一律 fail-closed，零新对象写入；
/// - 索引 PUT 是唯一可见 commit point；之前任何失败只留不可见孤儿，不回滚。
///
/// **[experimental 隔离入口]** 生产代码零调用方（sync_r12 源码锁钉死）；
/// 接线须先满足 docs/dev/wave2-D-backup-v2-decision.md 的前置清单。
pub async fn publish_verified_staging(
    storage: Arc<dyn CloudStorage>,
    staging_root: &Path,
    params: PublishParams<'_>,
) -> Result<PublishResult> {
    if params.device_id.trim().is_empty() {
        return Err(AppError::validation(
            "设备 ID 为空，拒绝发布 backup-v2 快照（fail-closed）",
        ));
    }
    let device_id = super::normalize_device_id(params.device_id);
    validate_index_identifier("deviceId", &device_id)?;

    // 整个 publish 窗口持有仓库租约。成功/失败都通过 Guard API 结束：
    // 正常路径显式 release（只删除本次 operation 的租约对象，绝不动别人的锁），
    // panic 等异常路径由 Guard Drop + TTL 兜底。
    let guard = acquire_backup_repo_lease(Arc::clone(&storage), &device_id).await?;
    let result = publish_locked(storage.as_ref(), staging_root, &params, &device_id).await;
    if let Err(error) = guard.release().await {
        tracing::warn!("[delta-upload] 释放备份仓库租约失败（将由 TTL 兜底）: {error}");
    }
    result
}

async fn publish_locked(
    storage: &dyn CloudStorage,
    staging_root: &Path,
    params: &PublishParams<'_>,
    device_id: &str,
) -> Result<PublishResult> {
    // 1. 当前 staging 的规范清单 + manifest 交叉核对（未验证 staging fail-closed）。
    let (inventory, _manifest) = build_inventory_cross_checked(staging_root)
        .map_err(|e| backup_error("staging 未通过验证，拒绝发布（fail-closed）", e))?;

    // 2. 读本设备版本索引与上一份 descriptor。
    //    - 索引不存在 → 首版，无复用；
    //    - 索引存在但解析/校验失败 → fail-closed，零对象写入；
    //    - 最新 descriptor GET/解密/decode 失败 → fail-closed，零新对象写入；
    //    - 只用本设备的上一份 descriptor，跨设备对象一律不读不复用。
    let index_key = device_index_key(device_id);
    let existing_index = match storage.get(&index_key).await? {
        None => None,
        Some(bytes) => {
            let index = BackupV2DeviceIndex::decode(&bytes)?;
            if index.device_id != device_id {
                return Err(AppError::validation(
                    "版本索引 deviceId 与本设备不符，fail-closed",
                ));
            }
            Some(index)
        }
    };
    let previous_descriptor = match &existing_index {
        Some(index) if !index.versions.is_empty() => {
            Some(load_previous_descriptor(storage, index, device_id, params.cipher).await?)
        }
        _ => None,
    };

    // 3. 复用计划：只走 reuse_candidates()（manifest.json 永远 always-changed）；
    //    复用条目直接复制旧 object_key + object_cipher_sha256，不做存在性确认。
    let mut reused_refs: Vec<SnapshotFileRefV2> = Vec::new();
    let mut upload_entries: Vec<&InventoryEntry> = Vec::new();
    match &previous_descriptor {
        Some(previous) => {
            let previous_inventory = inventory_from_descriptor(previous);
            let plan = diff(&previous_inventory, &inventory);
            let reusable_paths: HashSet<&str> = plan
                .reuse_candidates()
                .iter()
                .map(|entry| entry.logical_path.as_str())
                .collect();
            let previous_by_path: HashMap<&str, &SnapshotFileRefV2> = previous
                .files
                .iter()
                .map(|file| (file.logical_path.as_str(), file))
                .collect();
            for entry in &inventory.entries {
                if reusable_paths.contains(entry.logical_path.as_str()) {
                    let previous_ref = previous_by_path
                        .get(entry.logical_path.as_str())
                        .ok_or_else(|| {
                            AppError::internal(
                                "复用候选在上一份 descriptor 中缺失（内部不变量被破坏）",
                            )
                        })?;
                    reused_refs.push(SnapshotFileRefV2 {
                        logical_path: entry.logical_path.clone(),
                        size: entry.size,
                        plaintext_sha256: entry.plaintext_sha256.clone(),
                        object_key: previous_ref.object_key.clone(),
                        object_cipher_sha256: previous_ref.object_cipher_sha256.clone(),
                    });
                } else {
                    upload_entries.push(entry);
                }
            }
        }
        None => upload_entries.extend(inventory.entries.iter()),
    }

    // 4. 仓库首次写入 config（已存在则绝不覆盖）。
    if storage.get(BACKUP_V2_CONFIG_KEY).await?.is_none() {
        let config = BackupV2RepoConfig {
            format: BACKUP_V2_FORMAT.to_string(),
            format_version: DELTA_FORMAT_VERSION,
            id_key_epoch: 1,
        };
        let encoded = config.encode()?;
        let stored = match params.cipher {
            Some(session) => session
                .encrypt_bytes(&encoded)
                .map_err(|e| cipher_error("加密仓库配置失败", e))?,
            None => encoded,
        };
        storage.put(BACKUP_V2_CONFIG_KEY, &stored).await?;
    }

    // 5. 上传新对象（全新随机 key + 回读校验）。加密临时文件放在与 staging
    //    同文件系统的独立 scratch 目录，绝不污染 staging 本身。
    let scratch = tempfile::Builder::new()
        .prefix(".delta-upload-scratch-")
        .tempdir_in(staging_root.parent().unwrap_or(staging_root))
        .map_err(|e| AppError::file_system(format!("创建上传临时目录失败: {e}")))?;

    let mut uploaded_refs: Vec<SnapshotFileRefV2> = Vec::new();
    let mut newly_uploaded_size: u64 = 0;
    for entry in &upload_entries {
        let file_ref = upload_new_object(
            storage,
            staging_root,
            entry,
            device_id,
            params.cipher,
            scratch.path(),
        )
        .await?;
        newly_uploaded_size = newly_uploaded_size
            .checked_add(entry.size)
            .ok_or_else(|| AppError::validation("新上传字节数溢出 u64，拒绝发布"))?;
        uploaded_refs.push(file_ref);
    }
    let reused_size: u64 = {
        let mut sum: u64 = 0;
        for file_ref in &reused_refs {
            sum = sum
                .checked_add(file_ref.size)
                .ok_or_else(|| AppError::validation("复用字节数溢出 u64，拒绝发布"))?;
        }
        sum
    };

    // 6. 组自包含完整 descriptor（禁止 parent/patch，codec 层已 deny_unknown_fields）。
    let reused_file_count = reused_refs.len();
    let uploaded_file_count = uploaded_refs.len();
    let now = Utc::now();
    let version_id = generate_version_id(device_id, now);
    let mut files: Vec<SnapshotFileRefV2> = Vec::with_capacity(inventory.entries.len());
    files.extend(reused_refs);
    files.extend(uploaded_refs);
    files.sort_by(|a, b| a.logical_path.as_bytes().cmp(b.logical_path.as_bytes()));
    let descriptor = SnapshotDescriptorV2 {
        format: SNAPSHOT_V2_FORMAT.to_string(),
        format_version: DELTA_FORMAT_VERSION,
        version_id: version_id.clone(),
        device_id: device_id.to_string(),
        created_at: now.to_rfc3339(),
        files,
        logical_size: inventory.logical_size,
    };
    let encoded_descriptor = descriptor.encode()?;
    let stored_descriptor = match params.cipher {
        Some(session) => session
            .encrypt_bytes(&encoded_descriptor)
            .map_err(|e| cipher_error("加密 snapshot descriptor 失败", e))?,
        None => encoded_descriptor,
    };
    let snapshot_key = format!("{BACKUP_V2_SNAPSHOTS_PREFIX}{device_id}/{version_id}.dsbk");
    if storage.exists(&snapshot_key).await? {
        return Err(AppError::conflict(format!(
            "snapshot key 已存在（{snapshot_key}），拒绝覆盖不可变对象"
        )));
    }
    storage.put(&snapshot_key, &stored_descriptor).await?;

    // descriptor 回读验证：字节一致，且 decode/validate 后文件表与内存版一致。
    let readback = storage.get(&snapshot_key).await?.ok_or_else(|| {
        AppError::network("snapshot descriptor 上传后回读缺失，已中止发布（fail-closed）")
    })?;
    if readback != stored_descriptor {
        return Err(AppError::network(
            "snapshot descriptor 回读字节与本地不符，已中止发布（fail-closed）",
        ));
    }
    let readback_plain = match params.cipher {
        Some(session) => session
            .decrypt_bytes(&readback)
            .map_err(|e| cipher_error("回读 snapshot descriptor 解密失败", e))?,
        None => readback,
    };
    let readback_descriptor = SnapshotDescriptorV2::decode(&readback_plain)?;
    if readback_descriptor != descriptor {
        return Err(AppError::network(
            "回读的 snapshot descriptor 与本地不一致，已中止发布（fail-closed）",
        ));
    }

    // 7. 唯一 commit point：把新版本追加进本设备版本索引。之前任何失败都
    //    不写 index、不回滚（孤儿由后续 GC 路处理，不在本模块）。
    let snapshot_cipher_sha256 = sha256_hex(&stored_descriptor);
    let mut index = existing_index.unwrap_or_else(|| BackupV2DeviceIndex::empty(device_id, now));
    index.versions.insert(
        0,
        BackupV2IndexEntry {
            id: version_id.clone(),
            timestamp: now.to_rfc3339(),
            device_id: device_id.to_string(),
            app_version: params.app_version.map(str::to_string),
            note: params.note.map(str::to_string),
            format: SNAPSHOT_V2_FORMAT.to_string(),
            snapshot_key: snapshot_key.clone(),
            snapshot_cipher_sha256,
            snapshot_size: stored_descriptor.len() as u64,
            logical_size: inventory.logical_size,
            newly_uploaded_size,
        },
    );
    index.versions.sort_by(|a, b| {
        let a_ts = DateTime::parse_from_rfc3339(&a.timestamp).ok();
        let b_ts = DateTime::parse_from_rfc3339(&b.timestamp).ok();
        b_ts.cmp(&a_ts).then_with(|| b.id.cmp(&a.id))
    });
    // 只裁索引条目；被裁掉的 snapshot/object 保留在云端（GC 是下一路）。
    index.versions.truncate(DEFAULT_BACKUP_V2_MAX_VERSIONS);
    index.latest = Some(version_id.clone());
    index.updated_at = now.to_rfc3339();
    let index_bytes = index.encode()?;
    storage.put(&index_key, &index_bytes).await?;
    let index_readback = storage
        .get(&index_key)
        .await?
        .ok_or_else(|| AppError::network("版本索引写入后回读缺失，commit 状态不明，请重试"))?;
    if index_readback != index_bytes {
        return Err(AppError::network(
            "版本索引回读字节与本地不符，commit 状态不明，请重试",
        ));
    }

    Ok(PublishResult {
        version_id,
        snapshot_key,
        logical_size: inventory.logical_size,
        newly_uploaded_size,
        reused_size,
        reused_file_count,
        uploaded_file_count,
    })
}
