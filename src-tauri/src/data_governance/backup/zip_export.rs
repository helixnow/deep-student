//! ZIP 格式备份导出
//!
//! 将备份目录导出为 ZIP 压缩包，便于分享和存储。
//!
//! ## 功能
//!
//! - 支持可配置的压缩级别（0-9）
//! - 自动生成校验和文件
//! - 记录压缩统计信息
//! - 进度回调与协作式取消（[`export_backup_to_zip_with_progress`]）：
//!   输出先写同目录临时文件、自检通过后才原子发布，取消不会留下半成品 ZIP
//! - 两种便携模式：
//!   - **未加密便携 ZIP**（默认）：剥离本地密钥材料、审计库与导出隔离域，
//!     清单改写为 `key_policy=excluded_portable` + `PartialOverlay`。
//!     导入后只能作为部分归档检查/导出，**不能整槽恢复**。
//!   - **加密全保真 ZIP**（提供 `encryption_password`）：敏感数据连同原始
//!     manifest 一起密封进 `portable_secrets.dsbk`（Argon2id 派生密钥 +
//!     AES-256-GCM 分块加密）。导入时提供同一密码即可解封回原始
//!     `IncludedLocal` 完整快照，`validate_for_slot_restore` 通过后可整槽恢复，
//!     打通跨设备（云盘/ZIP）换机闭环。
//!
//! ## 使用示例
//!
//! ```rust,ignore
//! use crate::data_governance::backup::zip_export::{export_backup_to_zip, ZipExportOptions};
//!
//! let options = ZipExportOptions::default();
//! let result = export_backup_to_zip(backup_dir, &options)?;
//! println!("ZIP 文件: {:?}, 压缩率: {:.1}%", result.zip_path, result.compression_ratio() * 100.0);
//! ```

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use tracing::{debug, info, warn};
use walkdir::WalkDir;
use zip::write::FileOptions;
use zip::CompressionMethod;
use zip::ZipWriter;

use super::{assets, BackupFile, BackupKeyPolicy, BackupManager, BackupManifest};

/// 加密全保真便携 ZIP 中密封敏感数据的载荷条目名。
///
/// 载荷是一个内层 ZIP（原始 manifest.json + 全部便携排除文件），
/// 经 `crate::crypto::backup_crypto`（Argon2id + AES-256-GCM 分块）加密。
pub const ENCRYPTED_SECRETS_ENTRY: &str = "portable_secrets.dsbk";

/// 加密全保真 ZIP 缺少导入密码时的稳定错误码。
pub const SEALED_BACKUP_PASSWORD_REQUIRED_CODE: &str = "E_BACKUP_SEALED_PASSWORD_REQUIRED";

/// 加密全保真 ZIP 无法解密时的稳定错误码。
///
/// AEAD 无法区分错误密码与被篡改/损坏的密文，因此错误码必须诚实覆盖两者。
pub const SEALED_BACKUP_DECRYPT_FAILED_CODE: &str = "E_BACKUP_SEALED_DECRYPT_FAILED";

/// 备份密码最小长度（字符数）。弱口令会让加密全保真导出形同虚设。
const MIN_ENCRYPTION_PASSWORD_CHARS: usize = 8;

pub(crate) fn is_portable_excluded_relative_path(relative_path: &Path) -> bool {
    if crate::backup_common::is_crypto_secret_backup_relative_path(relative_path) {
        return true;
    }
    let normalized = relative_path
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    if normalized == "databases/audit.db" {
        return true;
    }
    super::persistent_domain_registry()
        .into_iter()
        .filter(|domain| domain.encrypted)
        .any(|domain| {
            let root = domain.archive_root.to_ascii_lowercase();
            normalized == root
                || normalized
                    .strip_prefix(&root)
                    .is_some_and(|suffix| suffix.starts_with('/'))
        })
}

/// Produce a manifest for an unencrypted portable archive without mutating the
/// local backup. Local encryption material and the auxiliary audit database are
/// intentionally excluded from portable ZIP files.
pub(crate) fn portable_manifest_bytes(backup_dir: &Path) -> Result<Vec<u8>, ZipExportError> {
    portable_manifest_bytes_with(
        backup_dir,
        BackupKeyPolicy::ExcludedPortable,
        "excluded from unencrypted portable archive",
        None,
    )
}

/// 构造便携归档外层清单：剥离便携排除文件、把相关域标记为 Excluded，
/// 并按调用方指定的 `key_policy` / 排除说明改写。
///
/// `sealed_payload` 为加密全保真导出提供的密封载荷条目
/// （`portable_secrets.dsbk` 的大小与密文 SHA-256），会追加进文件清单。
fn portable_manifest_bytes_with(
    backup_dir: &Path,
    key_policy: BackupKeyPolicy,
    exclusion_detail: &str,
    sealed_payload: Option<&BackupFile>,
) -> Result<Vec<u8>, ZipExportError> {
    let manifest_path = backup_dir.join("manifest.json");
    let mut manifest = BackupManifest::load_from_file(&manifest_path)
        .map_err(|error| ZipExportError::ExportFailed(error.to_string()))?;
    if manifest.snapshot_kind == super::SnapshotKind::LegacyCandidate {
        manifest
            .upgrade_legacy_candidate_to_v3_overlay()
            .map_err(|error| {
                ZipExportError::ExportFailed(format!("旧版备份未通过升级前严格验证: {}", error))
            })?;
    }
    manifest.key_policy = key_policy;
    manifest
        .files
        .retain(|file| !is_portable_excluded_relative_path(Path::new(&file.path)));
    if let Some(payload) = sealed_payload {
        manifest.files.push(payload.clone());
    }
    if let Some(coverage) = &mut manifest.coverage {
        let excluded_domains = super::persistent_domain_registry()
            .into_iter()
            .filter(|domain| domain.encrypted || domain.id == "audit")
            .map(|domain| domain.id)
            .collect::<Vec<_>>();
        for domain_id in excluded_domains {
            if let Some(domain) = coverage.domains.get_mut(&domain_id) {
                domain.status = super::CoverageStatus::Excluded;
                domain.paths.clear();
                domain.file_count = 0;
                domain.total_size = 0;
                domain.detail = Some(exclusion_detail.to_string());
            }
        }
    }
    if let Some(asset_result) = &mut manifest.assets {
        asset_result.files.retain(|asset| {
            !is_portable_excluded_relative_path(Path::new(&asset.relative_path))
                && !is_portable_excluded_relative_path(Path::new(&asset.original_path))
        });
        asset_result.total_files = asset_result.files.len();
        asset_result.total_size = asset_result.files.iter().map(|asset| asset.size).sum();
    }
    // A portable archive's outer manifest never carries slot-replacement
    // semantics on its own: the unencrypted variant excludes local crypto and
    // audit material outright, and the encrypted variant keeps them sealed
    // until the importer unseals the original manifest with the password.
    manifest.mark_partial();
    manifest
        .validate_untrusted()
        .map_err(|error| ZipExportError::ExportFailed(error.to_string()))?;
    if manifest.coverage.is_some() {
        manifest
            .validate_coverage_ledger(false)
            .map_err(|error| ZipExportError::ExportFailed(error.to_string()))?;
    }
    serde_json::to_vec_pretty(&manifest)
        .map_err(|error| ZipExportError::ExportFailed(format!("序列化便携清单失败: {}", error)))
}

/// 校验加密全保真导出所用的备份密码。
fn validate_encryption_password(password: &str) -> Result<(), ZipExportError> {
    if password.trim().is_empty() || password.chars().count() < MIN_ENCRYPTION_PASSWORD_CHARS {
        return Err(ZipExportError::ExportFailed(format!(
            "[{}] 备份密码至少需要 {} 个字符（不能为空白）",
            crate::secure_store::CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE,
            MIN_ENCRYPTION_PASSWORD_CHARS
        )));
    }
    Ok(())
}

/// 加密全保真导出的密封载荷（`portable_secrets.dsbk`）。
struct SealedSecretsPayload {
    /// 加密载荷临时文件（写入外层 ZIP 后即丢弃）。
    payload_file: tempfile::NamedTempFile,
    /// 载荷清单条目（密文大小 + 密文 SHA-256）。
    manifest_entry: BackupFile,
}

/// 构建加密全保真导出的密封载荷：把原始 manifest.json 与全部便携排除文件
/// 打进一个内层 ZIP，再用备份密码（Argon2id → AES-256-GCM 分块）加密。
///
/// `cancel_check` 在敏感数据扫描与内层 ZIP 逐文件写入之间轮询；
/// 最后的 `encrypt_backup_file` 调用（Argon2id 派生 + AEAD 分块加密）
/// 一旦开始便运行到完成，期间置位的取消令牌在下一个检查点生效。
fn build_sealed_secrets_payload(
    backup_dir: &Path,
    password: &str,
    cancel_check: &dyn Fn() -> bool,
) -> Result<SealedSecretsPayload, ZipExportError> {
    validate_encryption_password(password)?;
    if cancel_check() {
        return Err(export_cancelled());
    }

    let manifest_path = backup_dir.join("manifest.json");
    let original_manifest = BackupManifest::load_from_file(&manifest_path)
        .map_err(|error| ZipExportError::ExportFailed(error.to_string()))?;
    if original_manifest.snapshot_kind == super::SnapshotKind::LegacyCandidate {
        return Err(ZipExportError::ExportFailed(
            "旧版备份缺少 coverage ledger，不支持加密全保真导出；请先在本机创建一次新版完整备份"
                .to_string(),
        ));
    }
    let original_manifest_bytes = std::fs::read(&manifest_path)?;

    // 收集全部便携排除文件（crypto/ 密钥、审计库、导出隔离域等）。
    let mut sealed_files: Vec<(PathBuf, String)> = Vec::new();
    let mut sealed_bytes: u64 = 0;
    for entry in WalkDir::new(backup_dir) {
        if cancel_check() {
            return Err(export_cancelled());
        }
        let entry = entry.map_err(|error| {
            ZipExportError::ExportFailed(format!("扫描敏感数据失败: {}", error))
        })?;
        if entry.depth() == 0 || entry.file_type().is_dir() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(backup_dir)
            .map_err(|_| ZipExportError::ExportFailed("无法计算敏感文件相对路径".to_string()))?;
        if !is_portable_excluded_relative_path(relative) {
            continue;
        }
        if entry.file_type().is_symlink() || !entry.file_type().is_file() {
            return Err(ZipExportError::ExportFailed(format!(
                "敏感数据包含非常规文件，拒绝密封: {}",
                entry.path().display()
            )));
        }
        let normalized = relative.to_string_lossy().replace('\\', "/");
        sealed_bytes = sealed_bytes
            .checked_add(entry.metadata().map(|m| m.len()).unwrap_or(0))
            .ok_or_else(|| ZipExportError::ExportFailed("敏感数据总大小溢出".to_string()))?;
        sealed_files.push((entry.path().to_path_buf(), normalized));
        if sealed_files.len() > ARCHIVE_POLICY.max_files {
            return Err(ZipExportError::ExportFailed(
                "敏感数据文件数量超出归档策略上限".to_string(),
            ));
        }
    }
    if sealed_bytes > ARCHIVE_POLICY.max_uncompressed_bytes {
        return Err(ZipExportError::ExportFailed(
            "敏感数据总大小超出归档策略上限".to_string(),
        ));
    }

    // 内层 ZIP：原始 manifest + 敏感文件（相对路径保持不变）。
    let inner_zip = tempfile::NamedTempFile::new()?;
    let mut inner_writer = ZipWriter::new(inner_zip.reopen()?);
    let inner_options = FileOptions::default().compression_method(CompressionMethod::Deflated);
    inner_writer.start_file("manifest.json", inner_options)?;
    inner_writer.write_all(&original_manifest_bytes)?;
    for (path, normalized) in &sealed_files {
        if cancel_check() {
            return Err(export_cancelled());
        }
        inner_writer.start_file(normalized, inner_options)?;
        let mut file = File::open(path)?;
        std::io::copy(&mut file, &mut inner_writer)?;
    }
    let finished = inner_writer.finish()?;
    finished.sync_all()?;
    drop(finished);

    // 加密内层 ZIP → 密封载荷。该调用是唯一不可中断的窗口：Argon2id
    // 派生与 AES-256-GCM 分块加密一旦开始便运行到完成。
    if cancel_check() {
        return Err(export_cancelled());
    }
    let payload_file = tempfile::NamedTempFile::new()?;
    crate::crypto::backup_crypto::encrypt_backup_file(
        inner_zip.path(),
        payload_file.path(),
        password,
    )
    .map_err(|error| ZipExportError::ExportFailed(format!("加密敏感数据失败: {}", error)))?;

    let payload_size = std::fs::metadata(payload_file.path())?.len();
    let payload_sha256 = calculate_file_sha256(payload_file.path())?;
    info!(
        "已密封 {} 个敏感文件（{} 字节明文）为加密载荷（{} 字节密文）",
        sealed_files.len() + 1,
        sealed_bytes,
        payload_size
    );

    Ok(SealedSecretsPayload {
        payload_file,
        manifest_entry: BackupFile {
            path: ENCRYPTED_SECRETS_ENTRY.to_string(),
            size: payload_size,
            sha256: payload_sha256,
            database_id: None,
        },
    })
}

fn validate_imported_backup_dir(target_dir: &Path, unsealed: bool) -> Result<(), ZipExportError> {
    let manifest_path = target_dir.join("manifest.json");
    let manifest = BackupManifest::load_from_file(&manifest_path)
        .map_err(|error| ZipExportError::ExportFailed(error.to_string()))?;
    let legacy_portable = manifest.snapshot_kind == super::SnapshotKind::LegacyCandidate
        && manifest.key_policy == BackupKeyPolicy::LegacyUnknown;
    if legacy_portable {
        manifest
            .validate_legacy_candidate_for_upgrade()
            .map_err(|error| {
                ZipExportError::ExportFailed(format!("旧版 ZIP 未通过升级前严格验证: {}", error))
            })?;
    }
    // 成功解封的加密全保真 ZIP 会还原原始清单（included_local / not_present），
    // 其中的敏感文件已在解封时落盘并将由 verify_internal 逐一校验。
    let unsealed_full_fidelity = unsealed
        && matches!(
            manifest.key_policy,
            BackupKeyPolicy::IncludedLocal | BackupKeyPolicy::NotPresent
        );
    if manifest.key_policy != BackupKeyPolicy::ExcludedPortable
        && !legacy_portable
        && !unsealed_full_fidelity
    {
        return Err(ZipExportError::ExportFailed(if unsealed {
            format!(
                "解封后的清单密钥策略无效: {:?}（密封载荷必须还原 included_local / not_present 清单）",
                manifest.key_policy
            )
        } else {
            "未加密 ZIP 必须声明 key_policy=excluded_portable".to_string()
        }));
    }
    if manifest.snapshot_kind == super::SnapshotKind::Full {
        manifest
            .validate_for_slot_restore()
            .map_err(|error| ZipExportError::ExportFailed(error.to_string()))?;
    }

    let manager = BackupManager::new(
        target_dir
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf(),
    );
    manager
        .verify_internal(&manifest, target_dir)
        .map_err(|error| ZipExportError::ExportFailed(error.to_string()))?;
    if let Some(asset_result) = &manifest.assets {
        let errors = assets::verify_assets(target_dir, &asset_result.files)
            .map_err(|error| ZipExportError::ExportFailed(error.to_string()))?;
        if !errors.is_empty() {
            return Err(ZipExportError::ExportFailed(format!(
                "ZIP 资产校验失败: {}",
                errors
                    .iter()
                    .map(|error| format!("{}: {}", error.path, error.message))
                    .collect::<Vec<_>>()
                    .join("; ")
            )));
        }
    }

    let mut allowed_files = std::collections::HashSet::from([
        "manifest.json".to_string(),
        "checksums.sha256".to_string(),
    ]);
    allowed_files.extend(manifest.files.iter().map(|file| file.path.clone()));
    if let Some(asset_result) = &manifest.assets {
        allowed_files.extend(
            asset_result
                .files
                .iter()
                .filter(|asset| !asset.is_directory)
                .map(|asset| asset.relative_path.clone()),
        );
    }
    let mut actual_files = std::collections::HashSet::new();
    for entry in WalkDir::new(target_dir) {
        let entry = entry.map_err(|error| {
            ZipExportError::ExportFailed(format!("遍历导入目录失败: {}", error))
        })?;
        if entry.depth() == 0 || entry.file_type().is_dir() {
            continue;
        }
        if entry.file_type().is_symlink() || !entry.file_type().is_file() {
            return Err(ZipExportError::ExportFailed(format!(
                "ZIP 解压结果包含非常规文件: {}",
                entry.path().display()
            )));
        }
        let relative = entry
            .path()
            .strip_prefix(target_dir)
            .map_err(|_| ZipExportError::ExportFailed("无法计算导入文件相对路径".to_string()))?
            .to_string_lossy()
            .replace('\\', "/");
        if !allowed_files.contains(&relative) {
            return Err(ZipExportError::ExportFailed(format!(
                "ZIP 包含清单未声明的文件: {}",
                relative
            )));
        }
        if relative != "checksums.sha256" {
            actual_files.insert(relative);
        }
    }

    let checksums_path = target_dir.join("checksums.sha256");
    match std::fs::symlink_metadata(&checksums_path) {
        Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_file() => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Ok(_) => {
            return Err(ZipExportError::ExportFailed(
                "校验和条目必须是普通文件".to_string(),
            ))
        }
        Err(error) => return Err(ZipExportError::Io(error)),
    }
    {
        let file = File::open(&checksums_path)?;
        let mut declared = std::collections::HashSet::new();
        for (index, line) in BufReader::new(file).lines().enumerate() {
            if index >= ARCHIVE_POLICY.max_files {
                return Err(ZipExportError::ExportFailed(
                    "校验和文件条目数超限".to_string(),
                ));
            }
            let line = line?;
            let (expected, path) = line.split_once("  ").ok_or_else(|| {
                ZipExportError::ExportFailed(format!("校验和文件格式无效: line {}", index + 1))
            })?;
            if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(ZipExportError::ExportFailed(format!(
                    "校验和格式无效: line {}",
                    index + 1
                )));
            }
            if !actual_files.contains(path) || !declared.insert(path.to_string()) {
                return Err(ZipExportError::ExportFailed(format!(
                    "校验和路径缺失或重复: {}",
                    path
                )));
            }
            let actual = calculate_file_sha256(&target_dir.join(path))?;
            if !actual.eq_ignore_ascii_case(expected) {
                return Err(ZipExportError::ExportFailed(format!(
                    "ZIP 校验和不匹配: {}",
                    path
                )));
            }
        }
        if declared != actual_files {
            return Err(ZipExportError::ExportFailed(
                "校验和文件未覆盖 ZIP 中的全部文件".to_string(),
            ));
        }
    }
    Ok(())
}

/// ZIP 导出选项
#[derive(Clone, Serialize, Deserialize)]
pub struct ZipExportOptions {
    /// 压缩级别 (0-9)
    /// - 0: 不压缩（存储模式）
    /// - 1-3: 快速压缩
    /// - 4-6: 平衡（默认 6）
    /// - 7-9: 最大压缩
    #[serde(default = "default_compression_level")]
    pub compression_level: u32,
    /// 输出路径（可选，默认自动生成）
    #[serde(default)]
    pub output_path: Option<PathBuf>,
    /// 是否包含校验和文件
    #[serde(default = "default_include_checksums")]
    pub include_checksums: bool,
    /// 是否在导出成功后删除原始备份目录
    #[serde(default)]
    pub delete_source_on_success: bool,
    /// 备份密码（可选）：提供后执行「加密全保真导出」。
    ///
    /// 敏感数据（crypto/ 密钥、审计库、导出隔离域）连同原始 manifest 一起密封
    /// 进 `portable_secrets.dsbk`（Argon2id + AES-256-GCM）。导入时提供同一
    /// 密码即可解封为可整槽恢复的完整快照。永不序列化，避免密码落盘/入日志。
    #[serde(default, skip_serializing)]
    pub encryption_password: Option<String>,
}

impl std::fmt::Debug for ZipExportOptions {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ZipExportOptions")
            .field("compression_level", &self.compression_level)
            .field("output_path", &self.output_path)
            .field("include_checksums", &self.include_checksums)
            .field("delete_source_on_success", &self.delete_source_on_success)
            .field(
                "encryption_password",
                &self.encryption_password.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

fn default_compression_level() -> u32 {
    6
}

fn default_include_checksums() -> bool {
    true
}

impl Default for ZipExportOptions {
    fn default() -> Self {
        Self {
            compression_level: default_compression_level(),
            output_path: None,
            include_checksums: default_include_checksums(),
            delete_source_on_success: false,
            encryption_password: None,
        }
    }
}

impl ZipExportOptions {
    /// 快速压缩配置
    pub fn fast() -> Self {
        Self {
            compression_level: 1,
            ..Default::default()
        }
    }

    /// 最大压缩配置
    pub fn max_compression() -> Self {
        Self {
            compression_level: 9,
            ..Default::default()
        }
    }

    /// 存储模式（不压缩）
    pub fn store_only() -> Self {
        Self {
            compression_level: 0,
            ..Default::default()
        }
    }
}

/// ZIP 导出结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZipExportResult {
    /// ZIP 文件路径
    pub zip_path: PathBuf,
    /// 原始总大小（字节）
    pub total_size: u64,
    /// 压缩后大小（字节）
    pub compressed_size: u64,
    /// 文件数量
    pub file_count: usize,
    /// 压缩耗时（毫秒）
    pub duration_ms: u64,
    /// ZIP 文件的 SHA256 校验和
    pub zip_checksum: String,
}

impl ZipExportResult {
    /// 计算压缩率
    pub fn compression_ratio(&self) -> f64 {
        if self.total_size == 0 {
            return 0.0;
        }
        1.0 - (self.compressed_size as f64 / self.total_size as f64)
    }

    /// 格式化的压缩率
    pub fn compression_ratio_percent(&self) -> String {
        format!("{:.1}%", self.compression_ratio() * 100.0)
    }
}

/// ZIP 导出错误
#[derive(Debug, thiserror::Error)]
pub enum ZipExportError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("ZIP error: {0}")]
    Zip(#[from] zip::result::ZipError),

    #[error("Backup directory not found: {0}")]
    BackupNotFound(String),

    #[error("Invalid compression level: {0} (must be 0-9)")]
    InvalidCompressionLevel(u32),

    #[error("Export failed: {0}")]
    ExportFailed(String),
}

/// Shared limits for both ZIP production and consumption.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ArchivePolicy {
    pub max_files: usize,
    pub max_uncompressed_bytes: u64,
    pub max_compression_ratio: f64,
}

pub(crate) const ARCHIVE_POLICY: ArchivePolicy = ArchivePolicy {
    max_files: 100_000,
    max_uncompressed_bytes: 20 * 1024 * 1024 * 1024,
    max_compression_ratio: 200.0,
};

#[derive(Debug, Clone, Copy)]
pub(crate) struct ArchiveStats {
    pub entries: usize,
    pub uncompressed_bytes: u64,
    pub compressed_bytes: u64,
}

impl ArchivePolicy {
    fn validate_counts(&self, entries: usize, uncompressed: u64) -> Result<(), ZipExportError> {
        if entries > self.max_files {
            return Err(ZipExportError::ExportFailed(format!(
                "ZIP 文件数量超限: {} > {}",
                entries, self.max_files
            )));
        }
        if uncompressed > self.max_uncompressed_bytes {
            return Err(ZipExportError::ExportFailed(format!(
                "ZIP 解压总量超限: {} > {} bytes",
                uncompressed, self.max_uncompressed_bytes
            )));
        }
        Ok(())
    }
}

pub(crate) fn ensure_zip_output_outside_source(
    source_dir: &Path,
    output_path: &Path,
) -> Result<(), ZipExportError> {
    let canonical_source = std::fs::canonicalize(source_dir)?;
    let output_parent = output_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let canonical_parent = std::fs::canonicalize(output_parent)?;
    let file_name = output_path
        .file_name()
        .ok_or_else(|| ZipExportError::ExportFailed("ZIP 输出路径缺少文件名".to_string()))?;
    let resolved_output = canonical_parent.join(file_name);

    if resolved_output.starts_with(&canonical_source) {
        return Err(ZipExportError::ExportFailed(format!(
            "ZIP 输出路径不能位于备份源目录内: {}",
            output_path.display()
        )));
    }
    match std::fs::symlink_metadata(output_path) {
        Ok(_) => {
            let canonical_output = std::fs::canonicalize(output_path)?;
            if canonical_output.starts_with(&canonical_source) {
                return Err(ZipExportError::ExportFailed(format!(
                    "ZIP 输出路径不能指向备份源目录内: {}",
                    output_path.display()
                )));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(ZipExportError::Io(error)),
    }
    Ok(())
}

fn validate_import_target_root(target_dir: &Path) -> Result<(), ZipExportError> {
    std::fs::create_dir_all(target_dir)?;
    let metadata = std::fs::symlink_metadata(target_dir)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(ZipExportError::ExportFailed(format!(
            "ZIP 解压目标必须是普通目录: {}",
            target_dir.display()
        )));
    }
    Ok(())
}

fn prepare_import_destination(
    target_dir: &Path,
    relative_path: &Path,
    is_directory: bool,
) -> Result<PathBuf, ZipExportError> {
    use std::path::Component;

    if relative_path.as_os_str().is_empty()
        || relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(ZipExportError::ExportFailed(format!(
            "ZIP 包含不安全路径: {}",
            relative_path.display()
        )));
    }

    let mut destination = target_dir.to_path_buf();
    let component_count = relative_path.components().count();
    for (index, component) in relative_path.components().enumerate() {
        destination.push(component.as_os_str());
        let is_last = index + 1 == component_count;
        match std::fs::symlink_metadata(&destination) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(ZipExportError::ExportFailed(format!(
                    "ZIP 解压目标路径不允许包含符号链接: {}",
                    relative_path.display()
                )))
            }
            Ok(metadata) if !is_last && !metadata.is_dir() => {
                return Err(ZipExportError::ExportFailed(format!(
                    "ZIP 解压目标父路径不是目录: {}",
                    destination.display()
                )))
            }
            Ok(metadata) if is_last && is_directory && !metadata.is_dir() => {
                return Err(ZipExportError::ExportFailed(format!(
                    "ZIP 目录条目与现有文件冲突: {}",
                    destination.display()
                )))
            }
            Ok(metadata) if is_last && !is_directory && !metadata.is_file() => {
                return Err(ZipExportError::ExportFailed(format!(
                    "ZIP 文件条目与现有目录冲突: {}",
                    destination.display()
                )))
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && (!is_last || is_directory) => {
                std::fs::create_dir(&destination)?;
                let metadata = std::fs::symlink_metadata(&destination)?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(ZipExportError::ExportFailed(format!(
                        "ZIP 解压目录创建后校验失败: {}",
                        destination.display()
                    )));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && is_last => {}
            Err(e) => return Err(ZipExportError::Io(e)),
        }
    }
    Ok(destination)
}

fn copy_with_actual_size_budget<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    total_written: &mut u64,
    max_total: u64,
) -> Result<u64, ZipExportError> {
    let remaining = max_total.saturating_sub(*total_written);
    let mut limited = reader.take(remaining.saturating_add(1));
    let copied = std::io::copy(&mut limited, writer)?;
    if copied > remaining {
        return Err(ZipExportError::ExportFailed(format!(
            "ZIP 实际解压总量超限: > {} bytes",
            max_total
        )));
    }
    *total_written = (*total_written).saturating_add(copied);
    Ok(copied)
}

fn extract_zip_file_atomically<R: Read>(
    reader: &mut R,
    destination: &Path,
    total_written: &mut u64,
    expected_size: u64,
) -> Result<u64, ZipExportError> {
    let parent = destination
        .parent()
        .ok_or_else(|| ZipExportError::ExportFailed("ZIP 解压目标缺少父目录".to_string()))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    let copied = copy_with_actual_size_budget(
        reader,
        temp.as_file_mut(),
        total_written,
        ARCHIVE_POLICY.max_uncompressed_bytes,
    )?;
    if copied != expected_size {
        return Err(ZipExportError::ExportFailed(format!(
            "ZIP 条目实际大小与中央目录不一致: {} expected={}, actual={}",
            destination.display(),
            expected_size,
            copied
        )));
    }
    temp.as_file().sync_all()?;
    temp.persist(destination)
        .map_err(|e| ZipExportError::Io(e.error))?;
    Ok(copied)
}

pub(crate) fn preflight_export_source(
    backup_dir: &Path,
    portable_manifest_len: u64,
    include_checksums: bool,
) -> Result<ArchiveStats, ZipExportError> {
    let mut entries = 0usize;
    let mut uncompressed_bytes = 0u64;
    let mut checksum_line_bytes = 0u64;
    let mut file_paths = std::collections::HashSet::new();
    for entry in WalkDir::new(backup_dir).into_iter().filter_entry(|entry| {
        entry.depth() == 0
            || entry
                .path()
                .strip_prefix(backup_dir)
                .is_ok_and(|path| !is_portable_excluded_relative_path(path))
    }) {
        let entry = entry.map_err(|error| {
            ZipExportError::ExportFailed(format!("遍历备份目录失败: {}", error))
        })?;
        if entry.depth() == 0 {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(backup_dir)
            .map_err(|_| ZipExportError::ExportFailed("无法计算导出相对路径".to_string()))?;
        if is_portable_excluded_relative_path(relative)
            || relative
                .to_string_lossy()
                .replace('\\', "/")
                .eq_ignore_ascii_case("checksums.sha256")
        {
            continue;
        }
        if entry.file_type().is_symlink()
            || (!entry.file_type().is_file() && !entry.file_type().is_dir())
        {
            return Err(ZipExportError::ExportFailed(format!(
                "备份目录包含非常规文件: {}",
                entry.path().display()
            )));
        }
        let normalized = relative.to_string_lossy().replace('\\', "/");
        if !file_paths.insert(normalized.clone()) {
            return Err(ZipExportError::ExportFailed(format!(
                "导出源包含重复路径: {}",
                normalized
            )));
        }
        entries = entries.saturating_add(1);
        if entry.file_type().is_file() {
            let size = if normalized == "manifest.json" {
                portable_manifest_len
            } else {
                entry
                    .metadata()
                    .map_err(|error| {
                        ZipExportError::ExportFailed(format!(
                            "读取导出文件元数据失败 {}: {}",
                            entry.path().display(),
                            error
                        ))
                    })?
                    .len()
            };
            uncompressed_bytes = uncompressed_bytes
                .checked_add(size)
                .ok_or_else(|| ZipExportError::ExportFailed("导出文件总大小溢出".to_string()))?;
            if include_checksums {
                checksum_line_bytes = checksum_line_bytes
                    .checked_add(64 + 2 + normalized.len() as u64 + 1)
                    .ok_or_else(|| {
                        ZipExportError::ExportFailed("校验和文件大小溢出".to_string())
                    })?;
            }
        }
    }
    if include_checksums && checksum_line_bytes > 0 {
        entries = entries.saturating_add(1);
        // Generated content has no trailing newline.
        uncompressed_bytes = uncompressed_bytes
            .checked_add(checksum_line_bytes.saturating_sub(1))
            .ok_or_else(|| ZipExportError::ExportFailed("导出文件总大小溢出".to_string()))?;
    }
    ARCHIVE_POLICY.validate_counts(entries, uncompressed_bytes)?;
    Ok(ArchiveStats {
        entries,
        uncompressed_bytes,
        compressed_bytes: 0,
    })
}

/// ZIP 导出进度信息
#[derive(Debug, Clone)]
pub struct ZipExportProgress {
    /// 当前阶段
    pub phase: ZipExportPhase,
    /// 当前进度（0.0 - 100.0）
    pub progress: f32,
    /// 已处理的条目数（文件 + 目录 + 生成条目）
    pub processed_files: usize,
    /// 总条目数
    pub total_files: usize,
    /// 当前处理的文件名
    pub current_file: Option<String>,
    /// 消息
    pub message: String,
}

/// ZIP 导出阶段
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ZipExportPhase {
    /// 密封敏感数据（仅加密全保真导出）
    Seal,
    /// 生成便携清单并预检导出源
    Scan,
    /// 压缩写入
    Compress,
    /// 自检、原子发布与校验和
    Finalize,
    /// 完成
    Completed,
}

/// 导出被取消时返回的错误。
///
/// 与导入取消保持同一形态（`ErrorKind::Interrupted` + 「用户取消」前缀），
/// 命令层据此把任务标记为 cancelled 而不是 failed。
fn export_cancelled() -> ZipExportError {
    ZipExportError::Io(std::io::Error::new(
        std::io::ErrorKind::Interrupted,
        "用户取消导出",
    ))
}

/// 将备份目录导出为 ZIP
///
/// ## 参数
///
/// * `backup_dir` - 备份目录路径
/// * `options` - 导出选项
///
/// ## 返回
///
/// 成功时返回 `ZipExportResult`，包含 ZIP 文件信息
///
/// ## 错误
///
/// - 目录不存在
/// - 压缩级别无效
/// - IO 错误
pub fn export_backup_to_zip(
    backup_dir: &Path,
    options: &ZipExportOptions,
) -> Result<ZipExportResult, ZipExportError> {
    export_backup_to_zip_with_progress(backup_dir, options, |_| {}, || false)
}

/// 将备份目录导出为 ZIP（带进度回调与协作式取消）
///
/// 未加密便携与加密全保真两种导出共用本入口：密封敏感数据、便携清单
/// 改写、导入安全策略预检、逐文件压缩、自检与原子发布全部在此完成，
/// 调用方不再需要手写第二套逐文件实现。
///
/// ## 参数
///
/// * `backup_dir` - 备份目录路径
/// * `options` - 导出选项
/// * `progress_callback` - 进度回调函数
/// * `cancel_check` - 取消检查函数，返回 true 时中止导出
///
/// ## 取消语义
///
/// - 取消令牌在以下检查点轮询：密封敏感数据的扫描/逐文件循环、外层
///   压缩的逐条目循环、自检之后与原子发布之前。
/// - 输出始终先写入目标同目录的临时文件、自检通过后才原子持久化，
///   因此取消（或任何失败）不会留下半成品 ZIP，也不会破坏已有目标文件。
/// - 唯一不可中断的窗口是加密分支的密封载荷加密调用（Argon2id 派生 +
///   AES-256-GCM 分块加密一旦开始便运行到完成）；在该窗口内置位的
///   取消令牌于下一个检查点生效。
/// - 取消返回 `ZipExportError::Io`（`ErrorKind::Interrupted`，消息为
///   「用户取消导出」）。
pub fn export_backup_to_zip_with_progress<F, C>(
    backup_dir: &Path,
    options: &ZipExportOptions,
    mut progress_callback: F,
    cancel_check: C,
) -> Result<ZipExportResult, ZipExportError>
where
    F: FnMut(ZipExportProgress),
    C: Fn() -> bool,
{
    let start = std::time::Instant::now();

    // 验证备份目录；不要用 `exists()` 吞掉权限和元数据错误。
    match std::fs::symlink_metadata(backup_dir) {
        Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_dir() => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(ZipExportError::BackupNotFound(
                backup_dir.to_string_lossy().to_string(),
            ))
        }
        Ok(_) => {
            return Err(ZipExportError::ExportFailed(
                "备份路径必须是普通目录，不能是文件或符号链接".to_string(),
            ))
        }
        Err(error) => return Err(ZipExportError::Io(error)),
    }

    // 验证压缩级别
    if options.compression_level > 9 {
        return Err(ZipExportError::InvalidCompressionLevel(
            options.compression_level,
        ));
    }

    if cancel_check() {
        return Err(export_cancelled());
    }

    // 加密全保真导出：先密封敏感数据（含原始 manifest），外层清单声明
    // key_policy=included_encrypted 并携带载荷条目。
    let sealed_payload = match options.encryption_password.as_deref() {
        Some(password) => {
            progress_callback(ZipExportProgress {
                phase: ZipExportPhase::Seal,
                progress: 2.0,
                processed_files: 0,
                total_files: 0,
                current_file: None,
                message: "正在密封敏感数据为加密载荷...".to_string(),
            });
            Some(build_sealed_secrets_payload(
                backup_dir,
                password,
                &cancel_check,
            )?)
        }
        None => None,
    };

    progress_callback(ZipExportProgress {
        phase: ZipExportPhase::Scan,
        progress: 5.0,
        processed_files: 0,
        total_files: 0,
        current_file: None,
        message: "正在生成便携清单并预检导出源...".to_string(),
    });

    let portable_manifest = match &sealed_payload {
        Some(sealed) => portable_manifest_bytes_with(
            backup_dir,
            BackupKeyPolicy::IncludedEncrypted,
            "sealed into password-encrypted portable payload",
            Some(&sealed.manifest_entry),
        )?,
        None => portable_manifest_bytes(backup_dir)?,
    };
    let stats = preflight_export_source(
        backup_dir,
        portable_manifest.len() as u64,
        options.include_checksums,
    )?;
    if let Some(sealed) = &sealed_payload {
        let entries = stats.entries.saturating_add(1);
        let uncompressed = stats
            .uncompressed_bytes
            .checked_add(sealed.manifest_entry.size)
            .ok_or_else(|| ZipExportError::ExportFailed("导出文件总大小溢出".to_string()))?;
        ARCHIVE_POLICY.validate_counts(entries, uncompressed)?;
    }

    // 进度分母：preflight 统计的条目（含目录与生成的 checksums.sha256）
    // 加上可选的密封载荷条目。
    let total_entries = stats
        .entries
        .saturating_add(usize::from(sealed_payload.is_some()));
    let mut processed_entries: usize = 0;
    // 压缩阶段占 10% - 90%。
    let compress_progress = |processed: usize| -> f32 {
        10.0 + (processed as f32 / total_entries.max(1) as f32) * 80.0
    };

    progress_callback(ZipExportProgress {
        phase: ZipExportPhase::Scan,
        progress: 10.0,
        processed_files: 0,
        total_files: total_entries,
        current_file: None,
        message: format!(
            "导出预检完成: {} 个条目, {} 字节",
            total_entries, stats.uncompressed_bytes
        ),
    });

    if cancel_check() {
        return Err(export_cancelled());
    }

    // 确定输出路径
    let zip_path = match &options.output_path {
        Some(path) => path.clone(),
        None => {
            // 自动生成：与备份目录同级，名称为备份目录名 + .zip
            let parent = backup_dir.parent().unwrap_or(Path::new("."));
            let dir_name = backup_dir
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "backup".to_string());
            parent.join(format!("{}.zip", dir_name))
        }
    };
    ensure_zip_output_outside_source(backup_dir, &zip_path)?;

    info!(
        "开始导出 ZIP: {:?} -> {:?}, 压缩级别: {}",
        backup_dir, zip_path, options.compression_level
    );

    // 在目标同目录写临时文件，完成并同步后再原子持久化，避免失败留下半包。
    let output_parent = zip_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let temp_output = tempfile::NamedTempFile::new_in(output_parent)?;
    let mut zip_writer = ZipWriter::new(temp_output.reopen()?);

    // 配置压缩选项
    let compression_method = if options.compression_level == 0 {
        CompressionMethod::Stored
    } else {
        CompressionMethod::Deflated
    };

    let file_options = FileOptions::default().compression_method(compression_method);

    // 统计信息
    let mut total_size: u64 = 0;
    let mut file_count: usize = 0;
    let mut checksums: Vec<(String, String)> = Vec::new();

    // 遍历备份目录
    for entry in WalkDir::new(backup_dir).into_iter().filter_entry(|entry| {
        entry.depth() == 0
            || entry
                .path()
                .strip_prefix(backup_dir)
                .is_ok_and(|path| !is_portable_excluded_relative_path(path))
    }) {
        // 协作式取消：临时输出文件随 drop 自动删除，不留半成品。
        if cancel_check() {
            return Err(export_cancelled());
        }
        let entry = entry.map_err(|error| {
            ZipExportError::ExportFailed(format!("遍历备份目录失败: {}", error))
        })?;
        let path = entry.path();
        let relative_path = path
            .strip_prefix(backup_dir)
            .map_err(|_| ZipExportError::ExportFailed("无法计算相对路径".to_string()))?;

        // 跳过空路径（根目录）
        if relative_path.as_os_str().is_empty() {
            continue;
        }

        if is_portable_excluded_relative_path(relative_path) {
            continue;
        }

        let relative_path_str = relative_path.to_string_lossy().replace('\\', "/");
        if relative_path_str.eq_ignore_ascii_case("checksums.sha256") {
            continue;
        }

        if entry.file_type().is_symlink() {
            return Err(ZipExportError::ExportFailed(format!(
                "导出期间发现符号链接: {}",
                path.display()
            )));
        } else if entry.file_type().is_dir() {
            // 添加目录
            debug!("添加目录: {}", relative_path_str);
            zip_writer.add_directory(&relative_path_str, file_options)?;
            processed_entries = processed_entries.saturating_add(1);
        } else if entry.file_type().is_file() {
            // 添加文件
            debug!("添加文件: {}", relative_path_str);

            let is_manifest = relative_path_str == "manifest.json";
            let file_size = if is_manifest {
                portable_manifest.len() as u64
            } else {
                let metadata = std::fs::symlink_metadata(path)?;
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(ZipExportError::ExportFailed(format!(
                        "导出文件在读取前变为非常规条目: {}",
                        path.display()
                    )));
                }
                metadata.len()
            };
            total_size = total_size
                .checked_add(file_size)
                .ok_or_else(|| ZipExportError::ExportFailed("导出总大小溢出".to_string()))?;
            file_count = file_count
                .checked_add(1)
                .ok_or_else(|| ZipExportError::ExportFailed("导出文件计数溢出".to_string()))?;

            // 计算校验和（如果需要）
            if options.include_checksums {
                let checksum = if is_manifest {
                    crate::backup_common::calculate_bytes_hash(&portable_manifest)
                } else {
                    calculate_file_sha256(path)?
                };
                checksums.push((relative_path_str.clone(), checksum));
            }

            // 写入 ZIP（流式，避免大文件 read_to_end 导致内存峰值）
            zip_writer.start_file(&relative_path_str, file_options)?;
            if is_manifest {
                zip_writer.write_all(&portable_manifest)?;
            } else {
                let mut file = File::open(path)?;
                let opened = file.metadata()?;
                if !opened.is_file() || opened.len() != file_size {
                    return Err(ZipExportError::ExportFailed(format!(
                        "导出文件在打开期间发生变化: {}",
                        path.display()
                    )));
                }
                let copied = std::io::copy(&mut file, &mut zip_writer)?;
                if copied != file_size {
                    return Err(ZipExportError::ExportFailed(format!(
                        "导出文件读取大小变化: {} expected={}, actual={}",
                        path.display(),
                        file_size,
                        copied
                    )));
                }
            }
            processed_entries = processed_entries.saturating_add(1);
            progress_callback(ZipExportProgress {
                phase: ZipExportPhase::Compress,
                progress: compress_progress(processed_entries),
                processed_files: processed_entries,
                total_files: total_entries,
                current_file: Some(relative_path_str.clone()),
                message: format!(
                    "正在压缩: {} ({}/{})",
                    relative_path_str, processed_entries, total_entries
                ),
            });
        } else {
            return Err(ZipExportError::ExportFailed(format!(
                "导出期间发现非常规条目: {}",
                path.display()
            )));
        }
    }

    // 写入密封敏感数据载荷（密文不可再压缩，使用存储模式）。
    if let Some(sealed) = &sealed_payload {
        if cancel_check() {
            return Err(export_cancelled());
        }
        let stored_options = FileOptions::default().compression_method(CompressionMethod::Stored);
        zip_writer.start_file(ENCRYPTED_SECRETS_ENTRY, stored_options)?;
        let mut payload = File::open(sealed.payload_file.path())?;
        let copied = std::io::copy(&mut payload, &mut zip_writer)?;
        if copied != sealed.manifest_entry.size {
            return Err(ZipExportError::ExportFailed(format!(
                "密封载荷写入大小不一致: expected={}, actual={}",
                sealed.manifest_entry.size, copied
            )));
        }
        total_size = total_size
            .checked_add(sealed.manifest_entry.size)
            .ok_or_else(|| ZipExportError::ExportFailed("导出总大小溢出".to_string()))?;
        file_count = file_count
            .checked_add(1)
            .ok_or_else(|| ZipExportError::ExportFailed("导出文件计数溢出".to_string()))?;
        if options.include_checksums {
            checksums.push((
                ENCRYPTED_SECRETS_ENTRY.to_string(),
                sealed.manifest_entry.sha256.clone(),
            ));
        }
        processed_entries = processed_entries.saturating_add(1);
        progress_callback(ZipExportProgress {
            phase: ZipExportPhase::Compress,
            progress: compress_progress(processed_entries),
            processed_files: processed_entries,
            total_files: total_entries,
            current_file: Some(ENCRYPTED_SECRETS_ENTRY.to_string()),
            message: "已写入加密敏感数据载荷".to_string(),
        });
    }

    // 如果需要，添加校验和文件
    if options.include_checksums && !checksums.is_empty() {
        let checksums_content = checksums
            .iter()
            .map(|(path, hash)| format!("{}  {}", hash, path))
            .collect::<Vec<_>>()
            .join("\n");

        zip_writer.start_file("checksums.sha256", file_options)?;
        zip_writer.write_all(checksums_content.as_bytes())?;
        file_count += 1;
        processed_entries = processed_entries.saturating_add(1);
    }

    if cancel_check() {
        return Err(export_cancelled());
    }

    progress_callback(ZipExportProgress {
        phase: ZipExportPhase::Finalize,
        progress: 90.0,
        processed_files: processed_entries,
        total_files: total_entries,
        current_file: None,
        message: "正在自检并发布 ZIP 文件...".to_string(),
    });

    // 完成 ZIP 文件
    let finished_file = zip_writer.finish()?;
    finished_file.sync_all()?;
    drop(finished_file);
    validate_archive_path(temp_output.path())?;

    // 原子发布前的最后一个取消检查点：临时文件随 drop 自动删除，
    // 已有目标 ZIP（如存在）保持原样。
    if cancel_check() {
        return Err(export_cancelled());
    }
    temp_output
        .persist(&zip_path)
        .map_err(|e| ZipExportError::Io(e.error))?;

    progress_callback(ZipExportProgress {
        phase: ZipExportPhase::Finalize,
        progress: 95.0,
        processed_files: processed_entries,
        total_files: total_entries,
        current_file: None,
        message: "正在计算 ZIP 校验和...".to_string(),
    });

    // 获取压缩后的大小
    let compressed_size = std::fs::metadata(&zip_path)?.len();

    // 计算 ZIP 文件的校验和
    let zip_checksum = calculate_file_sha256(&zip_path)?;

    let duration_ms = start.elapsed().as_millis() as u64;

    info!(
        "ZIP 导出完成: {} 个文件, 原始大小: {} bytes, 压缩后: {} bytes, 压缩率: {:.1}%, 耗时: {}ms",
        file_count,
        total_size,
        compressed_size,
        (1.0 - compressed_size as f64 / total_size.max(1) as f64) * 100.0,
        duration_ms
    );

    // 如果配置了删除源目录
    if options.delete_source_on_success {
        info!("删除原始备份目录: {:?}", backup_dir);
        if let Err(e) = std::fs::remove_dir_all(backup_dir) {
            warn!("删除原始备份目录失败: {}", e);
        }
    }

    progress_callback(ZipExportProgress {
        phase: ZipExportPhase::Completed,
        progress: 100.0,
        processed_files: processed_entries,
        total_files: total_entries,
        current_file: None,
        message: format!("ZIP 导出完成，共 {} 个文件", file_count),
    });

    Ok(ZipExportResult {
        zip_path,
        total_size,
        compressed_size,
        file_count,
        duration_ms,
        zip_checksum,
    })
}

/// 计算文件的 SHA256 校验和
fn calculate_file_sha256(path: &Path) -> Result<String, ZipExportError> {
    let file = File::open(path)?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();

    let mut buffer = [0u8; 8192];
    loop {
        let bytes_read = reader.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }

    let result = hasher.finalize();
    Ok(hex::encode(result))
}

fn validate_import_archive(
    archive: &mut zip::ZipArchive<File>,
) -> Result<ArchiveStats, ZipExportError> {
    let archive_len = archive.len();
    ARCHIVE_POLICY.validate_counts(archive_len, 0)?;

    let mut total_uncompressed: u64 = 0;
    let mut total_compressed: u64 = 0;
    let mut paths = std::collections::HashSet::new();
    for i in 0..archive_len {
        let file = archive.by_index(i)?;
        let Some(enclosed_name) = file.enclosed_name() else {
            return Err(ZipExportError::ExportFailed(format!(
                "ZIP 包含越界或空路径: {}",
                file.name()
            )));
        };
        if enclosed_name.as_os_str().is_empty() {
            return Err(ZipExportError::ExportFailed(format!(
                "ZIP 包含越界或空路径: {}",
                file.name()
            )));
        }
        if is_portable_excluded_relative_path(enclosed_name) {
            return Err(ZipExportError::ExportFailed(format!(
                "未加密 ZIP 禁止包含密钥或本地审计材料: {}",
                file.name()
            )));
        }
        let normalized = enclosed_name.to_string_lossy().replace('\\', "/");
        if normalized.contains('\r') || normalized.contains('\n') {
            return Err(ZipExportError::ExportFailed(format!(
                "ZIP 路径包含换行符: {:?}",
                normalized
            )));
        }
        if !paths.insert(normalized.clone()) {
            return Err(ZipExportError::ExportFailed(format!(
                "ZIP 包含重复路径: {}",
                normalized
            )));
        }
        let file_size = file.size();
        let compressed_size = file.compressed_size();
        total_uncompressed = total_uncompressed.saturating_add(file_size);
        total_compressed = total_compressed.saturating_add(compressed_size);

        ARCHIVE_POLICY.validate_counts(archive_len, total_uncompressed)?;

        if file_size > 0 && compressed_size == 0 {
            return Err(ZipExportError::ExportFailed(format!(
                "ZIP 非空条目压缩大小为零: {}",
                normalized
            )));
        }
        if compressed_size > 0 {
            let ratio = file_size as f64 / compressed_size as f64;
            if ratio > ARCHIVE_POLICY.max_compression_ratio {
                return Err(ZipExportError::ExportFailed(format!(
                    "ZIP 压缩比异常: {:.1} > {:.1}",
                    ratio, ARCHIVE_POLICY.max_compression_ratio
                )));
            }
        }
    }

    if total_uncompressed > 0 && total_compressed == 0 {
        return Err(ZipExportError::ExportFailed(
            "ZIP 总压缩大小异常为零".to_string(),
        ));
    }
    if total_compressed > 0 {
        let ratio = total_uncompressed as f64 / total_compressed as f64;
        if ratio > ARCHIVE_POLICY.max_compression_ratio {
            return Err(ZipExportError::ExportFailed(format!(
                "ZIP 总压缩比异常: {:.1} > {:.1}",
                ratio, ARCHIVE_POLICY.max_compression_ratio
            )));
        }
    }
    Ok(ArchiveStats {
        entries: archive_len,
        uncompressed_bytes: total_uncompressed,
        compressed_bytes: total_compressed,
    })
}

pub(crate) fn validate_archive_path(path: &Path) -> Result<ArchiveStats, ZipExportError> {
    let file = File::open(path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    validate_import_archive(&mut archive)
}

/// 校验密封载荷解密后的内层 ZIP：条目只允许是原始 manifest.json 或
/// 便携排除路径（crypto/、审计库、导出隔离域），并复用外层归档的
/// 数量/大小/压缩比策略。
fn validate_secrets_archive(archive: &mut zip::ZipArchive<File>) -> Result<(), ZipExportError> {
    let archive_len = archive.len();
    ARCHIVE_POLICY.validate_counts(archive_len, 0)?;

    let mut total_uncompressed: u64 = 0;
    let mut paths = std::collections::HashSet::new();
    let mut has_manifest = false;
    for i in 0..archive_len {
        let file = archive.by_index(i)?;
        let Some(enclosed_name) = file.enclosed_name() else {
            return Err(ZipExportError::ExportFailed(format!(
                "密封载荷包含越界或空路径: {}",
                file.name()
            )));
        };
        if enclosed_name.as_os_str().is_empty() {
            return Err(ZipExportError::ExportFailed(format!(
                "密封载荷包含越界或空路径: {}",
                file.name()
            )));
        }
        let normalized = enclosed_name.to_string_lossy().replace('\\', "/");
        if normalized.contains('\r') || normalized.contains('\n') {
            return Err(ZipExportError::ExportFailed(format!(
                "密封载荷路径包含换行符: {:?}",
                normalized
            )));
        }
        if !paths.insert(normalized.clone()) {
            return Err(ZipExportError::ExportFailed(format!(
                "密封载荷包含重复路径: {}",
                normalized
            )));
        }
        if file.is_dir() {
            return Err(ZipExportError::ExportFailed(format!(
                "密封载荷不允许包含目录条目: {}",
                normalized
            )));
        }
        if normalized == "manifest.json" {
            has_manifest = true;
        } else if !is_portable_excluded_relative_path(enclosed_name) {
            return Err(ZipExportError::ExportFailed(format!(
                "密封载荷只允许包含敏感数据与原始清单，发现越权条目: {}",
                normalized
            )));
        }
        total_uncompressed = total_uncompressed.saturating_add(file.size());
        ARCHIVE_POLICY.validate_counts(archive_len, total_uncompressed)?;
        if file.compressed_size() > 0 {
            let ratio = file.size() as f64 / file.compressed_size() as f64;
            if ratio > ARCHIVE_POLICY.max_compression_ratio {
                return Err(ZipExportError::ExportFailed(format!(
                    "密封载荷压缩比异常: {:.1} > {:.1}",
                    ratio, ARCHIVE_POLICY.max_compression_ratio
                )));
            }
        }
    }
    if !has_manifest {
        return Err(ZipExportError::ExportFailed(
            "密封载荷缺少原始 manifest.json，无法解封为完整备份".to_string(),
        ));
    }
    Ok(())
}

/// 把解密后的内层 ZIP 条目（原始 manifest + 敏感明文）落盘到目标目录。
///
/// 无论成功与否，`written` 都记录了已完整写入的明文文件，供调用方在
/// 中途失败时清理半成品，避免敏感明文残留在半解封的目录里。
fn extract_sealed_entries(
    inner: &mut zip::ZipArchive<File>,
    target_dir: &Path,
    written: &mut Vec<PathBuf>,
) -> Result<(), ZipExportError> {
    let mut total_written = 0u64;
    for i in 0..inner.len() {
        let mut file = inner.by_index(i)?;
        let relative_path = file.enclosed_name().ok_or_else(|| {
            ZipExportError::ExportFailed(format!("密封载荷包含越界路径: {}", file.name()))
        })?;
        let outpath = prepare_import_destination(target_dir, relative_path, false)?;
        let expected_size = file.size();
        extract_zip_file_atomically(&mut file, &outpath, &mut total_written, expected_size)?;
        written.push(outpath);
    }
    Ok(())
}

/// 解封加密全保真 ZIP 的敏感数据载荷。
///
/// 在外层条目解压完成后调用：
/// - 清单声明 `key_policy=included_encrypted` 时必须提供备份密码；解密
///   `portable_secrets.dsbk`，把原始 manifest.json 与敏感文件安全落盘，
///   删除载荷与过期的 checksums.sha256（后续由 verify_internal 按原始
///   清单逐文件校验）。
/// - 未加密 ZIP 提供了密码、或声明与载荷不一致时，返回可操作错误。
///
/// 返回是否执行了解封（用于放行 `included_local` 清单的最终验证）。
fn unseal_encrypted_secrets(
    target_dir: &Path,
    password: Option<&str>,
) -> Result<bool, ZipExportError> {
    let manifest = BackupManifest::load_from_file(&target_dir.join("manifest.json"))
        .map_err(|error| ZipExportError::ExportFailed(error.to_string()))?;
    let declared_encrypted = manifest.key_policy == BackupKeyPolicy::IncludedEncrypted;

    let payload_path = target_dir.join(ENCRYPTED_SECRETS_ENTRY);
    let payload_present = match std::fs::symlink_metadata(&payload_path) {
        Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_file() => true,
        Ok(_) => {
            return Err(ZipExportError::ExportFailed(
                "密封载荷必须是普通文件".to_string(),
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(ZipExportError::Io(error)),
    };

    match (declared_encrypted, payload_present) {
        (false, false) => {
            if password.is_some() {
                return Err(ZipExportError::ExportFailed(
                    "该 ZIP 不是加密全保真备份，无需提供备份密码；请去掉密码后重试导入".to_string(),
                ));
            }
            Ok(false)
        }
        (true, false) => Err(ZipExportError::ExportFailed(format!(
            "清单声明为加密全保真备份，但缺少密封载荷 {}",
            ENCRYPTED_SECRETS_ENTRY
        ))),
        (false, true) => Err(ZipExportError::ExportFailed(format!(
            "ZIP 携带密封载荷 {} 但清单未声明 key_policy=included_encrypted",
            ENCRYPTED_SECRETS_ENTRY
        ))),
        (true, true) => {
            let Some(password) = password else {
                return Err(ZipExportError::ExportFailed(format!(
                    "[{}] 这是加密全保真备份 ZIP：请提供导出时设置的备份密码后重试导入",
                    SEALED_BACKUP_PASSWORD_REQUIRED_CODE
                )));
            };
            let inner_plain = tempfile::NamedTempFile::new()?;
            crate::crypto::backup_crypto::decrypt_backup_file(
                &payload_path,
                inner_plain.path(),
                password,
            )
            .map_err(|error| {
                ZipExportError::ExportFailed(format!(
                    "[{}] 解封加密备份失败（备份密码错误或载荷损坏）: {}",
                    SEALED_BACKUP_DECRYPT_FAILED_CODE, error
                ))
            })?;

            let inner_file = File::open(inner_plain.path())?;
            let mut inner = zip::ZipArchive::new(inner_file).map_err(|error| {
                ZipExportError::ExportFailed(format!("密封载荷不是有效 ZIP: {}", error))
            })?;
            validate_secrets_archive(&mut inner)?;

            let mut unsealed_paths: Vec<PathBuf> = Vec::new();
            if let Err(error) = extract_sealed_entries(&mut inner, target_dir, &mut unsealed_paths)
            {
                // 解封中断会留下部分敏感明文（含可能已覆盖外层清单的
                // manifest.json）：立即清理这些半成品。外层归档条目保持
                // 原样，携带密码即可再次续传/导入。
                let mut removed = 0usize;
                for path in &unsealed_paths {
                    match std::fs::remove_file(path) {
                        Ok(()) => removed += 1,
                        Err(cleanup_error)
                            if cleanup_error.kind() == std::io::ErrorKind::NotFound =>
                        {
                            removed += 1;
                        }
                        Err(cleanup_error) => warn!(
                            "清理半成品解封文件失败 {}: {}",
                            path.display(),
                            cleanup_error
                        ),
                    }
                }
                return Err(ZipExportError::ExportFailed(format!(
                    "解封敏感数据中断（已清理 {}/{} 个半成品明文文件）: {}",
                    removed,
                    unsealed_paths.len(),
                    error
                )));
            }

            // 载荷与外层校验和均已过期：敏感文件此后由原始清单
            // （verify_internal + validate_for_slot_restore）负责校验。
            std::fs::remove_file(&payload_path)?;
            match std::fs::remove_file(target_dir.join("checksums.sha256")) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(ZipExportError::Io(error)),
            }

            let unsealed = BackupManifest::load_from_file(&target_dir.join("manifest.json"))
                .map_err(|error| {
                    ZipExportError::ExportFailed(format!("解封后的原始清单无法解析: {}", error))
                })?;
            if unsealed.key_policy == BackupKeyPolicy::IncludedEncrypted {
                return Err(ZipExportError::ExportFailed(
                    "密封载荷未还原原始清单（key_policy 仍为 included_encrypted）".to_string(),
                ));
            }
            info!("加密全保真备份解封完成: {:?}", target_dir);
            Ok(true)
        }
    }
}

/// 外层 ZIP 是否携带密封载荷 `portable_secrets.dsbk`。
///
/// 只看条目名，不解密、不解压。导入路径用它决定要不要套用已存云端密码：
/// 便携包没有该条目，套用已存密码会被解封层拒绝。
pub fn zip_contains_encrypted_secrets(zip_path: &Path) -> Result<bool, ZipExportError> {
    let file = File::open(zip_path)?;
    let archive = zip::ZipArchive::new(file)?;
    let contains_sealed_secrets = archive
        .file_names()
        .any(|name| name == ENCRYPTED_SECRETS_ENTRY);
    Ok(contains_sealed_secrets)
}

/// [R09-restore-ops][P3] 加密全保真 ZIP 的备份密码预检：在解压任何条目之前
/// 尽早失败。
///
/// 外层归档携带密封载荷（`portable_secrets.dsbk`）而调用方未提供备份密码时，
/// 后续解封阶段必然失败——没有理由先做一次全量解压再报错（非续传路径失败
/// 后还会整目录清理，白白浪费一次全量 IO）。此预检只看归档条目名，不改动
/// 目标目录；密码错误仍由解封时的 AEAD 校验判定，声明与载荷不一致等
/// 形态错误仍由 [`unseal_encrypted_secrets`] 精确报告。
fn precheck_sealed_payload_password<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    password: Option<&str>,
    resumable: bool,
) -> Result<(), ZipExportError> {
    super::portable_precheck::precheck_explicit_import_password(archive, password, resumable)?; // [0824-W2R5] 显式密码 fail-fast：便携+密码（两种模式）/ 非续传密封+错密码试解密；缺密码方向仍由下方既有分支负责
    if password.is_some()
        || !archive
            .file_names()
            .any(|name| name == ENCRYPTED_SECRETS_ENTRY)
    {
        return Ok(());
    }
    // 文案与既有报错保持一致：续传路径沿用 R05 的「重新恢复任务」指引，
    // 非续传路径沿用解封阶段的措辞（既有调用方/测试按该文案断言）。
    let message = if resumable {
        "这是加密全保真备份 ZIP：断点续传必须携带导出时设置的备份密码。请提供备份密码后重新恢复导入任务"
    } else {
        "这是加密全保真备份 ZIP：请提供导出时设置的备份密码后重试导入"
    };
    Err(ZipExportError::ExportFailed(format!(
        "[{}] {}",
        SEALED_BACKUP_PASSWORD_REQUIRED_CODE, message
    )))
}

/// 从 ZIP 文件导入备份
///
/// 将 ZIP 文件解压到指定目录
///
/// ## 参数
///
/// * `zip_path` - ZIP 文件路径
/// * `target_dir` - 解压目标目录
///
/// ## 返回
///
/// 成功时返回解压的文件数量
pub fn import_backup_from_zip(zip_path: &Path, target_dir: &Path) -> Result<usize, ZipExportError> {
    import_backup_from_zip_with_password(zip_path, target_dir, None)
}

/// 从 ZIP 文件导入备份（支持加密全保真 ZIP 的备份密码）
///
/// * 未加密便携 ZIP：`password` 必须为 `None`；
/// * 加密全保真 ZIP：必须提供导出时设置的备份密码，导入过程会解封
///   敏感数据并还原可整槽恢复的原始清单。
pub fn import_backup_from_zip_with_password(
    zip_path: &Path,
    target_dir: &Path,
    password: Option<&str>,
) -> Result<usize, ZipExportError> {
    info!("开始从 ZIP 导入备份: {:?} -> {:?}", zip_path, target_dir);

    let zip_file = File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(zip_file)?;
    validate_import_archive(&mut archive)?;
    precheck_sealed_payload_password(&mut archive, password, false)?;

    validate_import_target_root(target_dir)?;

    let mut file_count = 0;
    let mut actual_uncompressed = 0u64;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        let relative_path = file.enclosed_name().ok_or_else(|| {
            ZipExportError::ExportFailed(format!("ZIP 包含越界路径: {}", file.name()))
        })?;
        let outpath = prepare_import_destination(target_dir, relative_path, file.is_dir())?;

        if file.is_dir() {
            continue;
        } else {
            let expected_size = file.size();
            extract_zip_file_atomically(
                &mut file,
                &outpath,
                &mut actual_uncompressed,
                expected_size,
            )?;
            file_count += 1;
        }
    }

    let unsealed = unseal_encrypted_secrets(target_dir, password)?;
    validate_imported_backup_dir(target_dir, unsealed)?;

    info!("ZIP 导入完成: {} 个文件", file_count);

    Ok(file_count)
}

/// ZIP 导入进度信息
#[derive(Debug, Clone)]
pub struct ZipImportProgress {
    /// 当前阶段
    pub phase: ZipImportPhase,
    /// 当前进度（0.0 - 100.0）
    pub progress: f32,
    /// 已处理的文件数
    pub processed_files: usize,
    /// 总文件数
    pub total_files: usize,
    /// 当前处理的文件名
    pub current_file: Option<String>,
    /// 消息
    pub message: String,
}

/// ZIP 导入阶段
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ZipImportPhase {
    /// 扫描 ZIP 文件
    Scan,
    /// 解压文件
    Extract,
    /// 验证文件
    Verify,
    /// 完成
    Completed,
}

/// 从 ZIP 文件导入备份（带进度回调和断点续传支持）
///
/// ## 参数
///
/// * `zip_path` - ZIP 文件路径
/// * `target_dir` - 解压目标目录
/// * `progress_callback` - 进度回调函数
/// * `cancel_check` - 取消检查函数，返回 true 时中止导入
/// * `password` - 备份密码（加密全保真 ZIP 必须提供，未加密 ZIP 传 `None`）
///
/// ## 返回
///
/// 成功时返回解压的文件数量（包含已跳过的文件）
pub fn import_backup_from_zip_with_progress<F, C>(
    zip_path: &Path,
    target_dir: &Path,
    progress_callback: F,
    cancel_check: C,
    password: Option<&str>,
) -> Result<usize, ZipExportError>
where
    F: FnMut(ZipImportProgress),
    C: Fn() -> bool,
{
    import_backup_from_zip_impl(
        zip_path,
        target_dir,
        progress_callback,
        cancel_check,
        false,
        password,
    )
}

/// 从 ZIP 文件导入备份（断点续传模式）
///
/// 跳过目标目录中已存在且大小匹配的文件，实现中断后的断点续传。
///
/// ## 参数
///
/// * `zip_path` - ZIP 文件路径
/// * `target_dir` - 解压目标目录
/// * `progress_callback` - 进度回调函数
/// * `cancel_check` - 取消检查函数，返回 true 时中止导入
/// * `password` - 备份密码：加密全保真 ZIP 的续传必须携带导出时设置的
///   备份密码。缺失时会在改动目标目录之前明确失败（目标保持原样，
///   携带密码即可再次续传）；未加密 ZIP 传 `None`。
///
/// ## 返回
///
/// 成功时返回解压的文件数量（包含已跳过的文件）
pub fn import_backup_from_zip_resumable<F, C>(
    zip_path: &Path,
    target_dir: &Path,
    progress_callback: F,
    cancel_check: C,
    password: Option<&str>,
) -> Result<usize, ZipExportError>
where
    F: FnMut(ZipImportProgress),
    C: Fn() -> bool,
{
    import_backup_from_zip_impl(
        zip_path,
        target_dir,
        progress_callback,
        cancel_check,
        true,
        password,
    )
}

/// ZIP 导入的内部实现
fn import_backup_from_zip_impl<F, C>(
    zip_path: &Path,
    target_dir: &Path,
    mut progress_callback: F,
    cancel_check: C,
    skip_existing: bool,
    password: Option<&str>,
) -> Result<usize, ZipExportError>
where
    F: FnMut(ZipImportProgress),
    C: Fn() -> bool,
{
    info!(
        "开始从 ZIP 导入备份（带进度, skip_existing={}）: {:?} -> {:?}",
        skip_existing, zip_path, target_dir
    );

    // 阶段 1: 扫描 ZIP 文件
    progress_callback(ZipImportProgress {
        phase: ZipImportPhase::Scan,
        progress: 0.0,
        processed_files: 0,
        total_files: 0,
        current_file: None,
        message: "正在验证 ZIP 文件...".to_string(),
    });

    if cancel_check() {
        return Err(ZipExportError::Io(std::io::Error::new(
            std::io::ErrorKind::Interrupted,
            "用户取消导入",
        )));
    }

    let zip_file = File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(zip_file)?;
    validate_import_archive(&mut archive)?;

    // 加密全保真 ZIP 的备份密码前置检查（续传与非续传共用）：
    // - 续传（R05）：在改动目标目录之前就明确失败——半解压的目标保持原样，
    //   携带密码重新恢复任务即可继续续传，不会留下新的半成品；
    // - 非续传（R09，P3）：避免全量解压后才在解封阶段报错、随后整目录清理，
    //   白白浪费一次全量 IO。
    precheck_sealed_payload_password(&mut archive, password, skip_existing)?;

    let total_files = archive.len();

    progress_callback(ZipImportProgress {
        phase: ZipImportPhase::Scan,
        progress: 5.0,
        processed_files: 0,
        total_files,
        current_file: None,
        message: format!("ZIP 文件验证完成，共 {} 个文件", total_files),
    });

    if cancel_check() {
        return Err(ZipExportError::Io(std::io::Error::new(
            std::io::ErrorKind::Interrupted,
            "用户取消导入",
        )));
    }

    validate_import_target_root(target_dir)?;

    // 阶段 2: 解压文件（5% - 80%）
    let mut file_count = 0;
    let mut skipped_count: usize = 0;
    let mut actual_uncompressed = 0u64;
    let extract_progress_range = 75.0; // 5% to 80%

    for i in 0..total_files {
        if cancel_check() {
            return Err(ZipExportError::Io(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "用户取消导入",
            )));
        }

        let mut file = archive.by_index(i)?;
        let relative_path = file.enclosed_name().ok_or_else(|| {
            ZipExportError::ExportFailed(format!("ZIP 包含越界路径: {}", file.name()))
        })?;
        let file_name = relative_path.to_string_lossy().to_string();
        let outpath = prepare_import_destination(target_dir, relative_path, file.is_dir())?;

        // 计算当前进度（安全除法，避免除零）
        let current_progress = if total_files > 0 {
            5.0 + (i as f32 / total_files as f32) * extract_progress_range
        } else {
            5.0 + extract_progress_range // 没有文件时直接完成这部分进度
        };

        // 断点续传：跳过已存在且大小匹配的文件（但数据库文件不能跳过，因为大小可能相同但内容不同）
        // [P11] manifest.json（任意层级、大小写不敏感）同样不可跳过：它是恢复链的
        // 元数据 SSOT，重新导出后大小可能不变而内容已变，跳过会让旧清单冒充新快照。
        if skip_existing && !file.is_dir() {
            let is_db_file = file_name.to_ascii_lowercase().ends_with(".db");
            let is_manifest = relative_path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case("manifest.json"));
            if !is_db_file && !is_manifest {
                match std::fs::symlink_metadata(&outpath) {
                    Ok(metadata)
                        if !metadata.file_type().is_symlink()
                            && metadata.is_file()
                            && metadata.len() == file.size() =>
                    {
                        skipped_count += 1;
                        file_count += 1;
                        progress_callback(ZipImportProgress {
                            phase: ZipImportPhase::Extract,
                            progress: current_progress,
                            processed_files: i,
                            total_files,
                            current_file: Some(file_name.clone()),
                            message: format!(
                                "跳过已存在: {} ({}/{})",
                                file_name,
                                i + 1,
                                total_files
                            ),
                        });
                        continue;
                    }
                    Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                        return Err(ZipExportError::ExportFailed(format!(
                            "断点续传目标不是普通文件: {}",
                            outpath.display()
                        )));
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(ZipExportError::Io(error)),
                }
            }
        }

        progress_callback(ZipImportProgress {
            phase: ZipImportPhase::Extract,
            progress: current_progress,
            processed_files: i,
            total_files,
            current_file: Some(file_name.clone()),
            message: format!("正在解压: {} ({}/{})", file_name, i + 1, total_files),
        });

        if file.is_dir() {
            continue;
        } else {
            let expected_size = file.size();
            extract_zip_file_atomically(
                &mut file,
                &outpath,
                &mut actual_uncompressed,
                expected_size,
            )?;
            file_count += 1;
        }
    }

    if skipped_count > 0 {
        info!(
            "断点续传：跳过 {} 个已存在文件，新解压 {} 个文件",
            skipped_count,
            file_count - skipped_count
        );
    }

    // 阶段 3: 验证文件（80% - 90%）
    progress_callback(ZipImportProgress {
        phase: ZipImportPhase::Verify,
        progress: 80.0,
        processed_files: file_count,
        total_files,
        current_file: None,
        message: "正在验证解压的文件...".to_string(),
    });

    if cancel_check() {
        return Err(ZipExportError::Io(std::io::Error::new(
            std::io::ErrorKind::Interrupted,
            "用户取消导入",
        )));
    }

    let unsealed = unseal_encrypted_secrets(target_dir, password)?;
    if unsealed {
        progress_callback(ZipImportProgress {
            phase: ZipImportPhase::Verify,
            progress: 84.0,
            processed_files: file_count,
            total_files,
            current_file: None,
            message: "已解封加密敏感数据，正在按原始清单验证...".to_string(),
        });
    }
    validate_imported_backup_dir(target_dir, unsealed)?;

    progress_callback(ZipImportProgress {
        phase: ZipImportPhase::Verify,
        progress: 90.0,
        processed_files: file_count,
        total_files,
        current_file: None,
        message: "文件验证完成".to_string(),
    });

    // 阶段 4: 完成（90% - 100%）
    progress_callback(ZipImportProgress {
        phase: ZipImportPhase::Completed,
        progress: 100.0,
        processed_files: file_count,
        total_files,
        current_file: None,
        message: format!("ZIP 导入完成，共解压 {} 个文件", file_count),
    });

    info!("ZIP 导入完成（带进度）: {} 个文件", file_count);

    Ok(file_count)
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data_governance::backup::{
        persistent_domain_registry, BackupFile, CoverageStatus, SnapshotKind,
    };
    use rusqlite::Connection;
    use tempfile::TempDir;

    fn create_test_backup_dir() -> TempDir {
        let dir = TempDir::new().unwrap();
        let backup_dir = dir.path();

        let mut manifest = BackupManifest::new("1.0.0-test");
        for database_id in ["vfs", "chat_v2", "mistakes", "llm_usage"] {
            let path = backup_dir.join(format!("{}.db", database_id));
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE test_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
                     INSERT INTO test_data(value) VALUES ('portable-backup-test');",
                )
                .unwrap();
            drop(connection);

            manifest.add_file(BackupFile {
                path: format!("{}.db", database_id),
                size: std::fs::metadata(&path).unwrap().len(),
                sha256: crate::backup_common::calculate_file_hash(&path).unwrap(),
                database_id: Some(database_id.to_string()),
            });
            manifest
                .record_coverage(
                    &format!("database:{}", database_id),
                    CoverageStatus::Complete,
                    vec![format!("{}.db", database_id)],
                    None,
                )
                .unwrap();
        }

        // Empty/absent domains are explicit evidence in manifest v3.
        for domain in persistent_domain_registry()
            .into_iter()
            .filter(|domain| !domain.id.starts_with("database:"))
        {
            manifest
                .record_coverage(&domain.id, CoverageStatus::Absent, Vec::new(), None)
                .unwrap();
        }
        manifest.mark_full().unwrap();
        manifest
            .save_to_file(&backup_dir.join("manifest.json"))
            .unwrap();

        dir
    }

    #[test]
    fn test_export_default_options() {
        let backup_dir = create_test_backup_dir();
        let options = ZipExportOptions::default();

        let result = export_backup_to_zip(backup_dir.path(), &options).unwrap();

        assert!(result.zip_path.exists());
        assert!(result.file_count > 0);
        assert!(result.total_size > 0);
        assert!(!result.zip_checksum.is_empty());

        // 清理
        std::fs::remove_file(&result.zip_path).ok();
    }

    #[test]
    fn test_export_with_custom_output_path() {
        let backup_dir = create_test_backup_dir();
        let output_dir = TempDir::new().unwrap();
        let output_path = output_dir.path().join("custom_backup.zip");

        let options = ZipExportOptions {
            output_path: Some(output_path.clone()),
            ..Default::default()
        };

        let result = export_backup_to_zip(backup_dir.path(), &options).unwrap();

        assert_eq!(result.zip_path, output_path);
        assert!(output_path.exists());
    }

    #[test]
    fn test_export_excludes_crypto_secrets() {
        let backup_dir = create_test_backup_dir();
        std::fs::create_dir_all(backup_dir.path().join("crypto/.secure")).unwrap();
        std::fs::create_dir_all(backup_dir.path().join(".secure")).unwrap();
        std::fs::create_dir_all(backup_dir.path().join("Crypto")).unwrap();
        std::fs::create_dir_all(backup_dir.path().join(".SECURE")).unwrap();
        std::fs::write(backup_dir.path().join("crypto/.secure/.key_seed"), b"seed").unwrap();
        std::fs::write(backup_dir.path().join("crypto/.master_key"), b"master").unwrap();
        std::fs::write(
            backup_dir.path().join(".secure/credential.enc"),
            b"credential",
        )
        .unwrap();
        std::fs::write(backup_dir.path().join(".master_key"), b"master").unwrap();
        std::fs::write(backup_dir.path().join(".key_seed"), b"seed").unwrap();
        std::fs::write(backup_dir.path().join("Crypto/upper.key"), b"secret").unwrap();
        std::fs::write(backup_dir.path().join(".SECURE/upper.enc"), b"secret").unwrap();

        let output_dir = TempDir::new().unwrap();
        let output_path = output_dir.path().join("sanitized.zip");
        export_backup_to_zip(
            backup_dir.path(),
            &ZipExportOptions {
                output_path: Some(output_path.clone()),
                ..Default::default()
            },
        )
        .unwrap();

        let file = File::open(output_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|index| archive.by_index(index).unwrap().name().to_string())
            .collect();
        assert!(names.iter().all(|name| {
            name != ".master_key"
                && name != ".key_seed"
                && !name.to_ascii_lowercase().starts_with("crypto/")
                && !name.to_ascii_lowercase().starts_with(".secure/")
        }));
        assert!(names.iter().any(|name| name == "manifest.json"));
        assert!(backup_dir.path().join("crypto/.secure/.key_seed").is_file());
        assert!(backup_dir.path().join("crypto/.master_key").is_file());
        assert!(backup_dir.path().join(".secure/credential.enc").is_file());
        assert!(backup_dir.path().join(".master_key").is_file());
        assert!(backup_dir.path().join(".key_seed").is_file());
        assert!(backup_dir.path().join("Crypto/upper.key").is_file());
        assert!(backup_dir.path().join(".SECURE/upper.enc").is_file());
    }

    #[test]
    fn test_unencrypted_export_excludes_user_skills() {
        let backup_dir = create_test_backup_dir();
        let skill_path = backup_dir
            .path()
            .join("persistent/user_skills/demo/SKILL.md");
        std::fs::create_dir_all(skill_path.parent().unwrap()).unwrap();
        std::fs::write(&skill_path, b"executable user skill").unwrap();

        let output_dir = TempDir::new().unwrap();
        let output_path = output_dir.path().join("without-skills.zip");
        export_backup_to_zip(
            backup_dir.path(),
            &ZipExportOptions {
                output_path: Some(output_path.clone()),
                ..Default::default()
            },
        )
        .unwrap();

        let file = File::open(output_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let names = (0..archive.len())
            .map(|index| archive.by_index(index).unwrap().name().to_string())
            .collect::<Vec<_>>();
        assert!(names
            .iter()
            .all(|name| !name.starts_with("persistent/user_skills/")));
        assert!(
            skill_path.is_file(),
            "portable export must not mutate source"
        );
    }

    #[test]
    fn test_export_excludes_encrypted_user_skills_domain() {
        let backup_dir = create_test_backup_dir();
        let skill_path = backup_dir
            .path()
            .join("persistent/user_skills/example/SKILL.md");
        std::fs::create_dir_all(skill_path.parent().unwrap()).unwrap();
        std::fs::write(&skill_path, b"# executable user skill").unwrap();

        let manifest_path = backup_dir.path().join("manifest.json");
        let mut manifest = BackupManifest::load_from_file(&manifest_path).unwrap();
        let relative = "persistent/user_skills/example/SKILL.md";
        manifest.add_file(BackupFile {
            path: relative.to_string(),
            size: std::fs::metadata(&skill_path).unwrap().len(),
            sha256: crate::backup_common::calculate_file_hash(&skill_path).unwrap(),
            database_id: None,
        });
        manifest
            .record_coverage(
                "user-skills",
                CoverageStatus::Complete,
                vec![relative.to_string()],
                Some("untrusted executable package".to_string()),
            )
            .unwrap();
        manifest.mark_full().unwrap();
        manifest.save_to_file(&manifest_path).unwrap();

        let output_dir = TempDir::new().unwrap();
        let output = output_dir.path().join("portable.zip");
        let result = export_backup_to_zip(
            backup_dir.path(),
            &ZipExportOptions {
                output_path: Some(output),
                ..Default::default()
            },
        )
        .unwrap();
        let file = File::open(&result.zip_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let names = (0..archive.len())
            .map(|index| archive.by_index(index).unwrap().name().to_string())
            .collect::<Vec<_>>();
        assert!(names
            .iter()
            .all(|name| !name.starts_with("persistent/user_skills/")));

        let imported = TempDir::new().unwrap();
        import_backup_from_zip(&result.zip_path, imported.path()).unwrap();
        let portable =
            BackupManifest::load_from_file(&imported.path().join("manifest.json")).unwrap();
        assert_eq!(
            portable
                .coverage
                .unwrap()
                .domains
                .get("user-skills")
                .unwrap()
                .status,
            CoverageStatus::Excluded
        );
    }

    #[test]
    fn test_export_rejects_output_inside_source_without_overwriting_it() {
        let backup_dir = create_test_backup_dir();
        let output_path = backup_dir.path().join("existing.zip");
        std::fs::write(&output_path, b"existing-output").unwrap();

        let result = export_backup_to_zip(
            backup_dir.path(),
            &ZipExportOptions {
                output_path: Some(output_path.clone()),
                ..Default::default()
            },
        );

        assert!(matches!(result, Err(ZipExportError::ExportFailed(_))));
        assert_eq!(std::fs::read(output_path).unwrap(), b"existing-output");
    }

    #[test]
    fn test_actual_copy_budget_rejects_more_bytes_than_declared_budget() {
        let mut reader = std::io::Cursor::new(vec![1u8; 11]);
        let mut output = Vec::new();
        let mut total = 0u64;

        let result = copy_with_actual_size_budget(&mut reader, &mut output, &mut total, 10);

        assert!(matches!(result, Err(ZipExportError::ExportFailed(_))));
        assert_eq!(total, 0);
    }

    #[cfg(unix)]
    #[test]
    fn test_import_rejects_symlinked_destination_parent() {
        let archive_dir = TempDir::new().unwrap();
        let archive_path = archive_dir.path().join("symlink-target.zip");
        let archive_file = File::create(&archive_path).unwrap();
        let mut writer = ZipWriter::new(archive_file);
        let options = FileOptions::default().compression_method(CompressionMethod::Stored);
        writer.start_file("manifest.json", options).unwrap();
        writer.write_all(b"{}").unwrap();
        writer.start_file("linked/payload.bin", options).unwrap();
        writer.write_all(b"payload").unwrap();
        writer.finish().unwrap();

        let target = TempDir::new().unwrap();
        let external = TempDir::new().unwrap();
        std::os::unix::fs::symlink(external.path(), target.path().join("linked")).unwrap();

        let result = import_backup_from_zip(&archive_path, target.path());

        assert!(matches!(result, Err(ZipExportError::ExportFailed(_))));
        assert!(!external.path().join("payload.bin").exists());
    }

    #[test]
    fn test_export_store_only() {
        let backup_dir = create_test_backup_dir();
        let options = ZipExportOptions::store_only();

        let result = export_backup_to_zip(backup_dir.path(), &options).unwrap();

        // 存储模式下，压缩后大小应该接近或大于原始大小
        // （因为 ZIP 头部开销）
        assert!(result.compressed_size >= result.total_size * 9 / 10);

        // 清理
        std::fs::remove_file(&result.zip_path).ok();
    }

    #[test]
    fn test_compression_ratio() {
        let result = ZipExportResult {
            zip_path: PathBuf::from("test.zip"),
            total_size: 1000,
            compressed_size: 600,
            file_count: 5,
            duration_ms: 100,
            zip_checksum: "test".to_string(),
        };

        assert!((result.compression_ratio() - 0.4).abs() < 0.001);
        assert_eq!(result.compression_ratio_percent(), "40.0%");
    }

    #[test]
    fn test_export_nonexistent_dir() {
        let options = ZipExportOptions::default();
        let result = export_backup_to_zip(Path::new("/nonexistent/path"), &options);

        assert!(result.is_err());
        assert!(matches!(result, Err(ZipExportError::BackupNotFound(_))));
    }

    #[test]
    fn test_invalid_compression_level() {
        let backup_dir = create_test_backup_dir();
        let options = ZipExportOptions {
            compression_level: 15, // 无效级别
            ..Default::default()
        };

        let result = export_backup_to_zip(backup_dir.path(), &options);

        assert!(result.is_err());
        assert!(matches!(
            result,
            Err(ZipExportError::InvalidCompressionLevel(15))
        ));
    }

    #[test]
    fn test_import_from_zip() {
        // 先创建一个 ZIP 文件
        let backup_dir = create_test_backup_dir();
        let options = ZipExportOptions::default();
        let export_result = export_backup_to_zip(backup_dir.path(), &options).unwrap();
        let stats = validate_archive_path(&export_result.zip_path).unwrap();

        // 导入到新目录
        let import_dir = TempDir::new().unwrap();
        let file_count =
            import_backup_from_zip(&export_result.zip_path, import_dir.path()).unwrap();

        assert!(file_count > 0);
        assert_eq!(file_count, stats.entries);
        assert!(import_dir.path().join("manifest.json").exists());
        assert!(import_dir.path().join("vfs.db").exists());
        assert!(import_dir.path().join("checksums.sha256").exists());
        let imported_manifest =
            BackupManifest::load_from_file(&import_dir.path().join("manifest.json")).unwrap();
        assert_eq!(
            imported_manifest.snapshot_kind,
            SnapshotKind::PartialOverlay
        );
        assert_eq!(
            imported_manifest.key_policy,
            BackupKeyPolicy::ExcludedPortable
        );
        assert!(
            imported_manifest.validate_for_slot_restore().is_err(),
            "v0.9.44-compatible portable ZIPs may import for inspection but must never replace a slot"
        );
        assert_eq!(
            imported_manifest
                .coverage
                .as_ref()
                .unwrap()
                .domains
                .get("crypto")
                .unwrap()
                .status,
            CoverageStatus::Excluded
        );
        assert_eq!(
            imported_manifest
                .coverage
                .as_ref()
                .unwrap()
                .domains
                .get("user-skills")
                .unwrap()
                .status,
            CoverageStatus::Excluded
        );

        // 清理
        std::fs::remove_file(&export_result.zip_path).ok();
    }

    // ================= 断点续传（resume）路径 =================

    const TEST_BACKUP_PASSWORD: &str = "portable-secret-1";

    /// 导出加密全保真测试 ZIP，返回 (输出目录守卫, ZIP 路径)。
    fn export_encrypted_test_zip(backup_dir: &Path) -> (TempDir, PathBuf) {
        let output_dir = TempDir::new().unwrap();
        let output_path = output_dir.path().join("encrypted.zip");
        export_backup_to_zip(
            backup_dir,
            &ZipExportOptions {
                output_path: Some(output_path.clone()),
                encryption_password: Some(TEST_BACKUP_PASSWORD.to_string()),
                ..Default::default()
            },
        )
        .unwrap();
        (output_dir, output_path)
    }

    #[test]
    fn test_resumable_import_unencrypted_zip_succeeds_without_password() {
        let backup_dir = create_test_backup_dir();
        let output_dir = TempDir::new().unwrap();
        let output_path = output_dir.path().join("plain.zip");
        export_backup_to_zip(
            backup_dir.path(),
            &ZipExportOptions {
                output_path: Some(output_path.clone()),
                ..Default::default()
            },
        )
        .unwrap();

        let import_dir = TempDir::new().unwrap();
        let target = import_dir.path().join("restored");
        let file_count =
            import_backup_from_zip_resumable(&output_path, &target, |_| {}, || false, None)
                .unwrap();

        assert!(file_count > 0);
        assert!(target.join("manifest.json").is_file());
    }

    /// [P11] 续传 skip 白名单不得覆盖 manifest.json：同大小不同内容的旧清单
    /// 必须被归档内容重新覆盖，否则旧清单会冒充新快照进入恢复链。
    #[test]
    fn test_resumable_import_never_skips_manifest_json() {
        let backup_dir = create_test_backup_dir();
        let output_dir = TempDir::new().unwrap();
        let output_path = output_dir.path().join("plain.zip");
        export_backup_to_zip(
            backup_dir.path(),
            &ZipExportOptions {
                output_path: Some(output_path.clone()),
                ..Default::default()
            },
        )
        .unwrap();

        let import_dir = TempDir::new().unwrap();
        let target = import_dir.path().join("restored");
        import_backup_from_zip_resumable(&output_path, &target, |_| {}, || false, None).unwrap();

        // 篡改已落盘的 manifest.json：保持字节数不变但内容不同，
        // 命中「已存在且大小匹配」的 skip 条件。
        let manifest_path = target.join("manifest.json");
        let original = std::fs::read(&manifest_path).unwrap();
        let tampered = vec![b'x'; original.len()];
        assert_ne!(original, tampered);
        std::fs::write(&manifest_path, &tampered).unwrap();

        let mut skipped: Vec<String> = Vec::new();
        import_backup_from_zip_resumable(
            &output_path,
            &target,
            |progress| {
                if progress.message.contains("跳过已存在") {
                    if let Some(file) = progress.current_file.clone() {
                        skipped.push(file);
                    }
                }
            },
            || false,
            None,
        )
        .unwrap();

        assert!(
            skipped
                .iter()
                .all(|name| !name.to_ascii_lowercase().ends_with("manifest.json")),
            "manifest.json must never be skipped by resume: {:?}",
            skipped
        );
        let restored = std::fs::read(&manifest_path).unwrap();
        assert_eq!(
            restored, original,
            "manifest.json must be re-extracted from the archive, not skipped"
        );
    }

    #[test]
    fn test_resumable_import_unencrypted_zip_rejects_password() {
        let backup_dir = create_test_backup_dir();
        let output_dir = TempDir::new().unwrap();
        let output_path = output_dir.path().join("plain.zip");
        export_backup_to_zip(
            backup_dir.path(),
            &ZipExportOptions {
                output_path: Some(output_path.clone()),
                ..Default::default()
            },
        )
        .unwrap();

        let import_dir = TempDir::new().unwrap();
        let target = import_dir.path().join("restored");
        let error = import_backup_from_zip_resumable(
            &output_path,
            &target,
            |_| {},
            || false,
            Some(TEST_BACKUP_PASSWORD),
        )
        .unwrap_err();

        assert!(
            error.to_string().contains("不是加密全保真备份"),
            "unexpected error: {}",
            error
        );
    }

    #[test]
    fn test_resumable_import_encrypted_zip_requires_password_before_touching_target() {
        let backup_dir = create_test_backup_dir();
        let (_zip_guard, zip_path) = export_encrypted_test_zip(backup_dir.path());

        let import_dir = TempDir::new().unwrap();
        let target = import_dir.path().join("restored");
        let error = import_backup_from_zip_resumable(&zip_path, &target, |_| {}, || false, None)
            .unwrap_err();

        assert!(
            error.to_string().contains("备份密码"),
            "unexpected error: {}",
            error
        );
        assert!(
            error
                .to_string()
                .contains(SEALED_BACKUP_PASSWORD_REQUIRED_CODE),
            "missing-password refusal must carry a stable code: {}",
            error
        );
        // 前置检查必须发生在改动目标目录之前：不能留下半成品目录。
        assert!(
            !target.exists(),
            "missing-password resume must not create the target dir"
        );
    }

    #[test]
    fn test_resumable_import_encrypted_zip_with_password_restores_full_snapshot() {
        let backup_dir = create_test_backup_dir();
        let (_zip_guard, zip_path) = export_encrypted_test_zip(backup_dir.path());
        let stats = validate_archive_path(&zip_path).unwrap();

        let import_dir = TempDir::new().unwrap();
        let target = import_dir.path().join("restored");
        let file_count = import_backup_from_zip_resumable(
            &zip_path,
            &target,
            |_| {},
            || false,
            Some(TEST_BACKUP_PASSWORD),
        )
        .unwrap();

        assert_eq!(file_count, stats.entries);
        // 解封后：原始清单还原，载荷与过期外层校验和被移除。
        assert!(!target.join(ENCRYPTED_SECRETS_ENTRY).exists());
        assert!(!target.join("checksums.sha256").exists());
        let manifest = BackupManifest::load_from_file(&target.join("manifest.json")).unwrap();
        assert_eq!(manifest.snapshot_kind, SnapshotKind::Full);
        assert_eq!(manifest.key_policy, BackupKeyPolicy::NotPresent);
        manifest.validate_for_slot_restore().unwrap();
    }

    #[test]
    fn test_resumable_import_encrypted_zip_wrong_password_then_retry_with_correct() {
        let backup_dir = create_test_backup_dir();
        let (_zip_guard, zip_path) = export_encrypted_test_zip(backup_dir.path());

        let import_dir = TempDir::new().unwrap();
        let target = import_dir.path().join("restored");
        let error = import_backup_from_zip_resumable(
            &zip_path,
            &target,
            |_| {},
            || false,
            Some("definitely-wrong-password"),
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("解封加密备份失败"),
            "unexpected error: {}",
            error
        );
        assert!(
            error
                .to_string()
                .contains(SEALED_BACKUP_DECRYPT_FAILED_CODE),
            "decrypt refusal must carry a stable code: {}",
            error
        );
        // 解密失败不会落任何敏感明文；外层条目保持原样，目标仍可续传。
        assert!(target.join(ENCRYPTED_SECRETS_ENTRY).is_file());

        // 携带正确密码再次续传：跳过已存在的外层文件并完成解封。
        let mut saw_skip = false;
        let file_count = import_backup_from_zip_resumable(
            &zip_path,
            &target,
            |progress| {
                if progress.message.contains("跳过已存在") {
                    saw_skip = true;
                }
            },
            || false,
            Some(TEST_BACKUP_PASSWORD),
        )
        .unwrap();

        assert!(file_count > 0);
        assert!(saw_skip, "retry must resume by skipping existing files");
        assert!(!target.join(ENCRYPTED_SECRETS_ENTRY).exists());
        let manifest = BackupManifest::load_from_file(&target.join("manifest.json")).unwrap();
        manifest.validate_for_slot_restore().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn test_resumable_import_unseal_failure_cleans_partial_plaintext() {
        let backup_dir = create_test_backup_dir();
        // 让密封载荷携带真实敏感文件（crypto/.master_key）。
        std::fs::create_dir_all(backup_dir.path().join("crypto")).unwrap();
        std::fs::write(backup_dir.path().join("crypto/.master_key"), b"master").unwrap();
        let (_zip_guard, zip_path) = export_encrypted_test_zip(backup_dir.path());

        // 在目标目录预埋 crypto -> 外部目录 的符号链接：外层解压不受影响
        // （外层不含 crypto 路径），但解封敏感文件时会被安全检查拒绝，
        // 此时原始 manifest.json 已经解封落盘——必须被当作半成品清理掉。
        let import_dir = TempDir::new().unwrap();
        let target = import_dir.path().join("restored");
        std::fs::create_dir_all(&target).unwrap();
        let external = TempDir::new().unwrap();
        std::os::unix::fs::symlink(external.path(), target.join("crypto")).unwrap();

        let error = import_backup_from_zip_resumable(
            &zip_path,
            &target,
            |_| {},
            || false,
            Some(TEST_BACKUP_PASSWORD),
        )
        .unwrap_err();

        assert!(
            error.to_string().contains("解封敏感数据中断"),
            "unexpected error: {}",
            error
        );
        assert!(
            error.to_string().contains("已清理"),
            "error must report partial-plaintext cleanup: {}",
            error
        );
        // 敏感明文不得写入符号链接指向的外部目录。
        assert!(!external.path().join(".master_key").exists());
        // 已解封的原始 manifest.json 属于半成品，必须被清理。
        assert!(!target.join("manifest.json").exists());
        // 外层加密载荷保持原样：修复目标目录后仍可携带密码继续续传。
        assert!(target.join(ENCRYPTED_SECRETS_ENTRY).is_file());
    }

    // ============ [R09-restore-ops][P3] 非续传导入无密码早失败 ============

    #[test]
    fn test_non_resumable_import_encrypted_zip_fails_early_without_password() {
        let backup_dir = create_test_backup_dir();
        let (_zip_guard, zip_path) = export_encrypted_test_zip(backup_dir.path());

        let import_dir = TempDir::new().unwrap();
        let target = import_dir.path().join("restored");
        let error = import_backup_from_zip(&zip_path, &target).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("请提供导出时设置的备份密码后重试导入"),
            "unexpected error: {}",
            error
        );
        assert!(
            error
                .to_string()
                .contains(SEALED_BACKUP_PASSWORD_REQUIRED_CODE),
            "missing-password refusal must carry a stable code: {}",
            error
        );
        // 早失败必须发生在解压任何条目之前：目标目录不得被创建/写入
        // （旧行为是全量解压后才在解封阶段报错，再由调用方整目录清理）。
        assert!(
            !target.exists(),
            "missing-password non-resumable import must fail before touching the target dir"
        );
    }

    #[test]
    fn test_non_resumable_progress_import_encrypted_zip_fails_early_without_password() {
        let backup_dir = create_test_backup_dir();
        let (_zip_guard, zip_path) = export_encrypted_test_zip(backup_dir.path());

        let import_dir = TempDir::new().unwrap();
        let target = import_dir.path().join("restored");
        let mut saw_extract_phase = false;
        let error = import_backup_from_zip_with_progress(
            &zip_path,
            &target,
            |progress| {
                if progress.phase == ZipImportPhase::Extract {
                    saw_extract_phase = true;
                }
            },
            || false,
            None,
        )
        .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("请提供导出时设置的备份密码后重试导入"),
            "unexpected error: {}",
            error
        );
        assert!(
            error
                .to_string()
                .contains(SEALED_BACKUP_PASSWORD_REQUIRED_CODE),
            "missing-password refusal must carry a stable code: {}",
            error
        );
        assert!(
            !saw_extract_phase,
            "precheck must fire before any Extract-phase work"
        );
        assert!(!target.exists());
    }

    #[test]
    fn test_non_resumable_import_encrypted_zip_with_password_still_succeeds() {
        let backup_dir = create_test_backup_dir();
        let (_zip_guard, zip_path) = export_encrypted_test_zip(backup_dir.path());

        let import_dir = TempDir::new().unwrap();
        let target = import_dir.path().join("restored");
        let file_count =
            import_backup_from_zip_with_password(&zip_path, &target, Some(TEST_BACKUP_PASSWORD))
                .unwrap();

        assert!(file_count > 0);
        let manifest = BackupManifest::load_from_file(&target.join("manifest.json")).unwrap();
        manifest.validate_for_slot_restore().unwrap();
    }

    // ================= 导出进度回调与取消 =================

    /// 取消令牌在压缩进行到中途置位时，导出必须停止：返回 Interrupted
    /// 「用户取消导出」，且不留下任何输出 ZIP（半成品临时文件随 drop 删除）。
    #[test]
    fn test_export_cancel_token_set_midway_stops_export() {
        let backup_dir = create_test_backup_dir();
        let output_dir = TempDir::new().unwrap();
        let output_path = output_dir.path().join("cancelled.zip");

        // 进度回调观察到第一个压缩条目后置位取消令牌，模拟用户中途取消。
        let cancelled = std::cell::Cell::new(false);
        let saw_compress = std::cell::Cell::new(false);
        let error = export_backup_to_zip_with_progress(
            backup_dir.path(),
            &ZipExportOptions {
                output_path: Some(output_path.clone()),
                ..Default::default()
            },
            |progress| {
                if progress.phase == ZipExportPhase::Compress {
                    saw_compress.set(true);
                    cancelled.set(true);
                }
            },
            || cancelled.get(),
        )
        .unwrap_err();

        assert!(
            saw_compress.get(),
            "test must cancel mid-way, after compression has started"
        );
        assert!(
            matches!(
                &error,
                ZipExportError::Io(io_error)
                    if io_error.kind() == std::io::ErrorKind::Interrupted
            ),
            "cancellation must surface as Interrupted: {}",
            error
        );
        assert!(
            error.to_string().contains("用户取消导出"),
            "cancellation error must keep the 用户取消 prefix contract: {}",
            error
        );
        assert!(
            !output_path.exists(),
            "cancelled export must not leave a partial ZIP behind"
        );
    }

    /// 加密全保真导出的压缩期同样可取消（密封载荷加密调用本身不可中断，
    /// 但外层逐条目压缩必须响应取消令牌），且不落任何输出。
    #[test]
    fn test_export_encrypted_cancel_token_set_midway_stops_export() {
        let backup_dir = create_test_backup_dir();
        let output_dir = TempDir::new().unwrap();
        let output_path = output_dir.path().join("cancelled-encrypted.zip");

        let cancelled = std::cell::Cell::new(false);
        let error = export_backup_to_zip_with_progress(
            backup_dir.path(),
            &ZipExportOptions {
                output_path: Some(output_path.clone()),
                encryption_password: Some(TEST_BACKUP_PASSWORD.to_string()),
                ..Default::default()
            },
            |progress| {
                if progress.phase == ZipExportPhase::Compress {
                    cancelled.set(true);
                }
            },
            || cancelled.get(),
        )
        .unwrap_err();

        assert!(
            error.to_string().contains("用户取消导出"),
            "unexpected error: {}",
            error
        );
        assert!(!output_path.exists());
    }

    /// 未取消时，进度回调必须覆盖 Scan → Compress → Finalize → Completed，
    /// 且最终 processed == total、进度单调不减。
    #[test]
    fn test_export_progress_reports_all_phases_monotonically() {
        let backup_dir = create_test_backup_dir();
        let output_dir = TempDir::new().unwrap();
        let output_path = output_dir.path().join("progress.zip");

        let mut phases: Vec<ZipExportPhase> = Vec::new();
        let mut last_progress = 0.0f32;
        let mut monotonic = true;
        let mut final_counts = (0usize, 0usize);
        let result = export_backup_to_zip_with_progress(
            backup_dir.path(),
            &ZipExportOptions {
                output_path: Some(output_path.clone()),
                ..Default::default()
            },
            |progress| {
                if progress.progress < last_progress {
                    monotonic = false;
                }
                last_progress = progress.progress;
                phases.push(progress.phase);
                final_counts = (progress.processed_files, progress.total_files);
            },
            || false,
        )
        .unwrap();

        assert!(monotonic, "progress must be monotonically non-decreasing");
        for phase in [
            ZipExportPhase::Scan,
            ZipExportPhase::Compress,
            ZipExportPhase::Finalize,
            ZipExportPhase::Completed,
        ] {
            assert!(
                phases.contains(&phase),
                "missing export phase {:?} in {:?}",
                phase,
                phases
            );
        }
        assert_eq!(
            final_counts.0, final_counts.1,
            "all entries must be accounted for at completion"
        );
        assert!(output_path.exists());
        assert!(result.file_count > 0);
    }

    #[test]
    fn zip_contains_encrypted_secrets_distinguishes_portable_and_sealed() {
        let backup_dir = create_test_backup_dir();
        let portable = TempDir::new().unwrap();
        let portable_zip = portable.path().join("portable.zip");
        export_backup_to_zip(
            backup_dir.path(),
            &ZipExportOptions {
                output_path: Some(portable_zip.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!zip_contains_encrypted_secrets(&portable_zip).unwrap());

        let (_zip_guard, sealed_zip) = export_encrypted_test_zip(backup_dir.path());
        assert!(zip_contains_encrypted_secrets(&sealed_zip).unwrap());
    }

    // ================= 导入进度回调与取消（G4） =================
    //
    // 导入实现（import_backup_from_zip_impl）共有 4 处 cancel_check：
    //   C1 Scan 起点（打开归档之前）
    //   C2 Scan 验证完成后（validate_import_target_root 之前）
    //   C3 Extract 逐条目循环顶部（每个条目解压之前）
    //   C4 Verify 起点（unseal_encrypted_secrets / 清单校验之前）
    // 命令层（commands_zip.rs）用 `to_string().contains("用户取消")` 把取消
    // 判定为 cancelled 终态而非 failed，以下测试固定这一契约。

    /// 断言取消错误契约：Io(Interrupted) + 「用户取消导入」字样，
    /// 保证命令层能把它判定为 cancelled 而不是 failed。
    fn assert_import_cancelled(error: &ZipExportError) {
        assert!(
            matches!(
                error,
                ZipExportError::Io(io_error)
                    if io_error.kind() == std::io::ErrorKind::Interrupted
            ),
            "import cancellation must surface as Io(Interrupted): {}",
            error
        );
        assert!(
            error.to_string().contains("用户取消导入"),
            "cancellation error must keep the 用户取消 marker (cancelled ≠ failed): {}",
            error
        );
    }

    /// 导出未加密便携测试 ZIP，返回 (输出目录守卫, ZIP 路径)。
    fn export_plain_test_zip(backup_dir: &Path) -> (TempDir, PathBuf) {
        let output_dir = TempDir::new().unwrap();
        let output_path = output_dir.path().join("plain.zip");
        export_backup_to_zip(
            backup_dir,
            &ZipExportOptions {
                output_path: Some(output_path.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        (output_dir, output_path)
    }

    /// 读取归档全部非目录条目：条目名 → 未压缩大小（半成品检测的对照表）。
    fn zip_entry_sizes(zip_path: &Path) -> std::collections::HashMap<String, u64> {
        let mut archive = zip::ZipArchive::new(File::open(zip_path).unwrap()).unwrap();
        (0..archive.len())
            .filter_map(|index| {
                let entry = archive.by_index(index).unwrap();
                if entry.is_dir() {
                    None
                } else {
                    Some((entry.name().to_string(), entry.size()))
                }
            })
            .collect()
    }

    /// 枚举目标目录下的普通文件：归档相对路径 → 实际字节数。
    fn extracted_files(target: &Path) -> std::collections::HashMap<String, u64> {
        if !target.exists() {
            return std::collections::HashMap::new();
        }
        WalkDir::new(target)
            .into_iter()
            .map(|entry| entry.unwrap())
            .filter(|entry| entry.file_type().is_file())
            .map(|entry| {
                let relative = entry
                    .path()
                    .strip_prefix(target)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                (relative, entry.metadata().unwrap().len())
            })
            .collect()
    }

    /// C1：取消令牌在导入启动时已置位——第一处 cancel_check 在打开归档、
    /// 校验目标目录之前就必须停止，目标目录零副作用（连目录都不创建）。
    #[test]
    fn test_import_cancelled_before_scan_leaves_target_untouched() {
        let backup_dir = create_test_backup_dir();
        let (_zip_guard, zip_path) = export_plain_test_zip(backup_dir.path());

        let import_dir = TempDir::new().unwrap();
        let target = import_dir.path().join("restored");

        let mut phases: Vec<ZipImportPhase> = Vec::new();
        let error = import_backup_from_zip_with_progress(
            &zip_path,
            &target,
            |progress| phases.push(progress.phase),
            || true,
            None,
        )
        .unwrap_err();

        assert_import_cancelled(&error);
        assert_eq!(
            phases,
            vec![ZipImportPhase::Scan],
            "pre-cancelled import must stop right after the first Scan callback"
        );
        assert!(
            !target.exists(),
            "pre-cancelled import must not create the target directory"
        );
    }

    /// C2：Scan 验证完成（total_files 已知）后置位取消——第二处
    /// cancel_check 在 validate_import_target_root 之前中止，
    /// 不进入 Extract 阶段，目标目录仍未被创建。
    #[test]
    fn test_import_cancelled_after_scan_validation_extracts_nothing() {
        let backup_dir = create_test_backup_dir();
        let (_zip_guard, zip_path) = export_plain_test_zip(backup_dir.path());

        let import_dir = TempDir::new().unwrap();
        let target = import_dir.path().join("restored");

        let cancel = std::cell::Cell::new(false);
        let saw_extract = std::cell::Cell::new(false);
        let error = import_backup_from_zip_with_progress(
            &zip_path,
            &target,
            |progress| {
                if progress.phase == ZipImportPhase::Extract {
                    saw_extract.set(true);
                }
                // 第二次 Scan 回调（验证完成）才带 total_files > 0：
                // 在这里置位可精确命中第二处 cancel_check。
                if progress.phase == ZipImportPhase::Scan && progress.total_files > 0 {
                    cancel.set(true);
                }
            },
            || cancel.get(),
            None,
        )
        .unwrap_err();

        assert_import_cancelled(&error);
        assert!(
            !saw_extract.get(),
            "cancel after scan validation must never reach the Extract phase"
        );
        assert!(
            !target.exists(),
            "cancel before target validation must not create the target directory"
        );
    }

    /// C3（G4 核心）：Extract 中途取消不留半成品。已落盘的条目必须是
    /// 完整文件（NamedTempFile + 原子 rename 保证要么全有要么全无），
    /// 目录里不得残留 `.tmp*` 临时文件，且错误标记为取消而非失败。
    #[test]
    fn test_import_cancel_midway_extract_leaves_no_partial_files() {
        let backup_dir = create_test_backup_dir();
        let (_zip_guard, zip_path) = export_plain_test_zip(backup_dir.path());
        let entry_sizes = zip_entry_sizes(&zip_path);
        assert!(
            entry_sizes.len() >= 2,
            "test zip must contain multiple entries for a mid-way cancel"
        );

        let import_dir = TempDir::new().unwrap();
        let target = import_dir.path().join("restored");

        // 观察到第一个 Extract 回调后置位取消：第 1 个条目完整落盘，
        // 循环顶部的 cancel_check 会在解压第 2 个条目之前中止。
        let cancel = std::cell::Cell::new(false);
        let error = import_backup_from_zip_with_progress(
            &zip_path,
            &target,
            |progress| {
                if progress.phase == ZipImportPhase::Extract {
                    cancel.set(true);
                }
            },
            || cancel.get(),
            None,
        )
        .unwrap_err();

        assert_import_cancelled(&error);

        let files = extracted_files(&target);
        assert!(
            !files.is_empty(),
            "cancel must land mid-extract, after at least one entry was written"
        );
        assert!(
            files.len() < entry_sizes.len(),
            "cancel must land mid-extract, before all entries were written"
        );
        for (relative, actual_size) in &files {
            let file_name = relative.rsplit('/').next().unwrap();
            assert!(
                !file_name.starts_with(".tmp"),
                "cancelled import must not leave NamedTempFile leftovers: {}",
                relative
            );
            let expected_size = entry_sizes
                .get(relative)
                .unwrap_or_else(|| panic!("unexpected file in target after cancel: {}", relative));
            assert_eq!(
                actual_size, expected_size,
                "every landed file must be byte-complete, never truncated: {}",
                relative
            );
        }
    }

    /// C4：Verify 起点取消（解封敏感数据之前）。加密全保真导入在
    /// Extract 全部完成后、unseal 之前响应取消：密封载荷
    /// portable_secrets.dsbk 保持原样未消费，错误是「用户取消」，
    /// 不得混入任何密码/解密类稳定失败码（cancelled ≠ failed）。
    #[test]
    fn test_import_encrypted_cancelled_before_verify_keeps_sealed_payload() {
        let backup_dir = create_test_backup_dir();
        let (_zip_guard, zip_path) = export_encrypted_test_zip(backup_dir.path());

        let import_dir = TempDir::new().unwrap();
        let target = import_dir.path().join("restored");

        let cancel = std::cell::Cell::new(false);
        let error = import_backup_from_zip_with_progress(
            &zip_path,
            &target,
            |progress| {
                if progress.phase == ZipImportPhase::Verify {
                    cancel.set(true);
                }
            },
            || cancel.get(),
            Some(TEST_BACKUP_PASSWORD),
        )
        .unwrap_err();

        assert_import_cancelled(&error);
        let message = error.to_string();
        assert!(
            !message.contains(SEALED_BACKUP_PASSWORD_REQUIRED_CODE),
            "cancellation must not carry the password-required failure code: {}",
            message
        );
        assert!(
            !message.contains(SEALED_BACKUP_DECRYPT_FAILED_CODE),
            "cancellation must not carry the decrypt-failed failure code: {}",
            message
        );
        assert!(
            target.join(ENCRYPTED_SECRETS_ENTRY).is_file(),
            "cancel before Verify must leave the sealed payload unconsumed for retry"
        );
    }

    /// G4 闭环：Extract 中途取消不留半成品 ⇒ 携同一参数用续传模式重试
    /// 即可完整完成——最终条目数与归档一致、逐文件字节数吻合、
    /// 清单可正常加载。
    #[test]
    fn test_import_cancel_midway_then_resumable_retry_completes() {
        let backup_dir = create_test_backup_dir();
        let (_zip_guard, zip_path) = export_plain_test_zip(backup_dir.path());
        let entry_sizes = zip_entry_sizes(&zip_path);

        let import_dir = TempDir::new().unwrap();
        let target = import_dir.path().join("restored");

        // 第一遍：Extract 中途取消。
        let cancel = std::cell::Cell::new(false);
        let error = import_backup_from_zip_resumable(
            &zip_path,
            &target,
            |progress| {
                if progress.phase == ZipImportPhase::Extract {
                    cancel.set(true);
                }
            },
            || cancel.get(),
            None,
        )
        .unwrap_err();
        assert_import_cancelled(&error);
        assert!(
            !extracted_files(&target).is_empty(),
            "first pass must land at least one entry before cancelling"
        );

        // 第二遍：同参数、不再取消，续传补齐剩余条目。
        let file_count =
            import_backup_from_zip_resumable(&zip_path, &target, |_| {}, || false, None).unwrap();

        assert_eq!(
            file_count,
            entry_sizes.len(),
            "retry must account for every archive entry (extracted + skipped)"
        );
        assert_eq!(
            extracted_files(&target),
            entry_sizes,
            "retry must leave the target byte-complete against the archive"
        );
        BackupManifest::load_from_file(&target.join("manifest.json")).unwrap();
    }
}
