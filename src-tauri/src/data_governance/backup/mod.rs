//! # Backup 模块
//!
//! 原子性备份/恢复系统。
//!
//! ## 设计原则
//!
//! 1. **原子性**：使用 SQLite Backup API，确保数据一致性
//! 2. **可验证**：每个文件都有 SHA256 校验和
//! 3. **可回滚**：恢复前自动备份当前数据，失败时可回滚
//! 4. **资产支持**：支持备份图片、文档、音视频等资产文件
//!
//! 增量备份（`backup_type=incremental`）创建入口已下线：旧实现只导出
//! `__change_log` 元信息、无行 payload，恢复路径亦拒绝。历史增量包仍会
//! 以 `IncrementalRestoreNotSupported` 诚实拒绝，不会静默转全量。
//!
//! ## SQLite Backup API
//!
//! 使用 `sqlite3_backup_*` API 而非文件复制，确保 WAL 模式下的一致性：
//!
//! ```rust
//! // 备份前强制 checkpoint
//! conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
//!
//! // 使用 Backup API
//! let backup = rusqlite::backup::Backup::new(src, &mut dst)?;
//! backup.run_to_completion(5, Duration::from_millis(100), None)?;
//! ```
//!
//! ## 组件
//!
//! - `manager`: 备份管理器
//! - `assets`: 资产文件备份

pub mod assets;

pub mod zip_export;

use rusqlite::backup::Backup;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tracing::{debug, error, info, warn};
use uuid::Uuid;
use walkdir::WalkDir;

/// 增量备份创建已下线时的统一错误文案（命令层与 BackupManager 共用）
pub const INCREMENTAL_BACKUP_REMOVED_MESSAGE: &str =
    "Incremental backup has been removed; use full backup or cloud sync";

/// 历史增量包恢复拒绝文案（list 识别为 legacy / restore 诚实拒绝）
pub const INCREMENTAL_RESTORE_NOT_SUPPORTED_MESSAGE: &str =
    "Legacy incremental backup cannot be restored; use a full backup or cloud sync";

#[cfg(feature = "data_governance")]
use crate::data_governance::schema_registry::DatabaseId;

pub use zip_export::{export_backup_to_zip, ZipExportError, ZipExportOptions, ZipExportResult};

// 重新导出资产模块的公共类型
pub use assets::{
    AssetBackupConfig, AssetBackupError, AssetBackupResult, AssetType, AssetTypeStats,
    AssetVerifyError, BackedUpAsset,
};

/// 备份清单版本
const MANIFEST_VERSION: &str = "3.0.0";

/// 当前应用支持的最大 manifest 主版本号
/// 用于 restore() 版本兼容性检查：拒绝来自未来主版本的备份
const MANIFEST_MAX_SUPPORTED_MAJOR: u64 = 3;

/// 清单文件名
const MANIFEST_FILENAME: &str = "manifest.json";

/// 预恢复备份目录名
const PRE_RESTORE_DIR: &str = ".pre_restore";

/// 不可信备份清单的资源上限。
const MAX_MANIFEST_BYTES: u64 = 64 * 1024 * 1024;
const MAX_MANIFEST_FILES: usize = 100_000;
const MAX_MANIFEST_PATH_BYTES: usize = 4096;
const MAX_MANIFEST_TOTAL_FILE_BYTES: u64 = 20 * 1024 * 1024 * 1024;
const MAX_BACKUP_MASTER_KEY_BYTES: u64 = 4096;
const MAX_BACKUP_SECURE_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_BACKUP_SECURE_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_BACKUP_SECURE_FILES: usize = 4096;

fn validate_safe_relative_path(path: &Path) -> Result<(), BackupError> {
    use std::path::Component;

    if path.as_os_str().is_empty() || path.as_os_str().len() > MAX_MANIFEST_PATH_BYTES {
        return Err(BackupError::Manifest(
            "备份清单包含空路径或超长路径".to_string(),
        ));
    }

    for component in path.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err(BackupError::Manifest(format!(
                "备份清单包含不安全路径: {}",
                path.display()
            )));
        }
    }
    Ok(())
}

fn resolve_existing_backup_file(
    backup_dir: &Path,
    relative: &Path,
) -> Result<PathBuf, BackupError> {
    validate_safe_relative_path(relative)?;

    let root_metadata = fs::symlink_metadata(backup_dir).map_err(|e| {
        BackupError::Manifest(format!(
            "无法检查备份根目录 {}: {}",
            backup_dir.display(),
            e
        ))
    })?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err(BackupError::Manifest(format!(
            "备份根路径必须是普通目录: {}",
            backup_dir.display()
        )));
    }

    let mut resolved = backup_dir.to_path_buf();
    let component_count = relative.components().count();
    for (index, component) in relative.components().enumerate() {
        resolved.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&resolved).map_err(|e| {
            BackupError::Manifest(format!("无法检查备份路径 {}: {}", resolved.display(), e))
        })?;
        if metadata.file_type().is_symlink() {
            return Err(BackupError::Manifest(format!(
                "备份路径不允许包含符号链接: {}",
                relative.display()
            )));
        }
        let is_last = index + 1 == component_count;
        if (!is_last && !metadata.is_dir()) || (is_last && !metadata.is_file()) {
            return Err(BackupError::Manifest(format!(
                "备份清单路径不是普通文件: {}",
                relative.display()
            )));
        }
    }

    Ok(resolved)
}

fn prepare_backup_restore_destination(
    target_dir: &Path,
    relative: &Path,
) -> Result<PathBuf, BackupError> {
    validate_safe_relative_path(relative)?;
    let root_metadata = fs::symlink_metadata(target_dir).map_err(|e| {
        BackupError::RestoreFailed(format!(
            "无法检查恢复目标目录 {}: {}",
            target_dir.display(),
            e
        ))
    })?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err(BackupError::RestoreFailed(format!(
            "恢复目标必须是普通目录: {}",
            target_dir.display()
        )));
    }

    let mut destination = target_dir.to_path_buf();
    let component_count = relative.components().count();
    for (index, component) in relative.components().enumerate() {
        destination.push(component.as_os_str());
        let is_last = index + 1 == component_count;
        match fs::symlink_metadata(&destination) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(BackupError::RestoreFailed(format!(
                    "恢复目标路径不允许包含符号链接: {}",
                    relative.display()
                )))
            }
            Ok(metadata) if !is_last && !metadata.is_dir() => {
                return Err(BackupError::RestoreFailed(format!(
                    "恢复目标父路径不是目录: {}",
                    destination.display()
                )))
            }
            Ok(metadata) if is_last && !metadata.is_file() => {
                return Err(BackupError::RestoreFailed(format!(
                    "恢复目标不是普通文件: {}",
                    destination.display()
                )))
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && !is_last => {
                fs::create_dir(&destination)?;
                let metadata = fs::symlink_metadata(&destination)?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(BackupError::RestoreFailed(format!(
                        "创建恢复目标目录后校验失败: {}",
                        destination.display()
                    )));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && is_last => {}
            Err(e) => return Err(BackupError::Io(e)),
        }
    }
    Ok(destination)
}

fn copy_crypto_file_to_staging(
    source: &Path,
    destination: &Path,
    max_bytes: u64,
) -> Result<u64, BackupError> {
    let metadata = fs::symlink_metadata(source).map_err(|e| {
        BackupError::RestoreFailed(format!("无法检查备份密钥文件 {}: {}", source.display(), e))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(BackupError::RestoreFailed(format!(
            "备份密钥条目必须是普通文件: {}",
            source.display()
        )));
    }
    if metadata.len() > max_bytes {
        return Err(BackupError::RestoreFailed(format!(
            "备份密钥文件过大: {} ({} bytes)",
            source.display(),
            metadata.len()
        )));
    }

    let source_file = File::open(source)?;
    let opened_metadata = source_file.metadata()?;
    if !opened_metadata.is_file()
        || opened_metadata.len() > max_bytes
        || opened_metadata.len() != metadata.len()
    {
        return Err(BackupError::RestoreFailed(format!(
            "备份密钥文件在暂存期间发生异常变化: {}",
            source.display()
        )));
    }
    let mut limited = source_file.take(max_bytes.saturating_add(1));
    let mut destination_file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)?;
    let copied = std::io::copy(&mut limited, &mut destination_file)?;
    if copied > max_bytes {
        drop(destination_file);
        let _ = fs::remove_file(destination);
        return Err(BackupError::RestoreFailed(format!(
            "备份密钥文件实际读取大小超限: {}",
            source.display()
        )));
    }
    if copied != opened_metadata.len() {
        drop(destination_file);
        let _ = fs::remove_file(destination);
        return Err(BackupError::RestoreFailed(format!(
            "备份密钥文件实际读取大小变化: {} expected={}, actual={}",
            source.display(),
            opened_metadata.len(),
            copied
        )));
    }
    destination_file.sync_all()?;
    let destination_size = destination_file.metadata()?.len();
    if destination_size != copied {
        drop(destination_file);
        let _ = fs::remove_file(destination);
        return Err(BackupError::RestoreFailed(format!(
            "备份密钥暂存大小不一致: {} expected={}, actual={}",
            destination.display(),
            copied,
            destination_size
        )));
    }
    crate::secure_store::SecureStore::restrict_permissions(destination, false);
    Ok(copied)
}

fn validate_staged_master_key(path: &Path) -> Result<(), BackupError> {
    use base64::Engine;
    use zeroize::Zeroizing;

    let mut encoded = Zeroizing::new(String::new());
    File::open(path)?
        .take(MAX_BACKUP_MASTER_KEY_BYTES + 1)
        .read_to_string(&mut encoded)?;
    if encoded.len() as u64 > MAX_BACKUP_MASTER_KEY_BYTES {
        return Err(BackupError::RestoreFailed(
            "备份主密钥内容超过大小上限".to_string(),
        ));
    }
    let decoded = Zeroizing::new(
        base64::engine::general_purpose::STANDARD
            .decode(encoded.trim())
            .map_err(|e| BackupError::RestoreFailed(format!("备份主密钥 Base64 无效: {}", e)))?,
    );
    if decoded.len() != 32 {
        return Err(BackupError::RestoreFailed(format!(
            "备份主密钥长度无效: expected=32, actual={}",
            decoded.len()
        )));
    }
    Ok(())
}

fn remove_crypto_path(path: &Path) -> std::io::Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    if metadata.file_type().is_symlink() {
        #[cfg(windows)]
        if path.is_dir() {
            return fs::remove_dir(path);
        }
        return fs::remove_file(path);
    }
    if metadata.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

/// 生成安全且高概率唯一的备份 ID（目录名）
///
/// 约束：
/// - 仅包含 `[0-9A-Za-z]`、`_`，满足后端 `validate_backup_id` 的允许字符集
/// - 带时间戳前缀，便于排序与排查
fn generate_backup_id_at(now: chrono::DateTime<chrono::Utc>, suffix: Option<&str>) -> String {
    let timestamp = now.format("%Y%m%d_%H%M%S").to_string();
    let millis = now.timestamp_subsec_millis();
    let rand8 = &Uuid::new_v4().simple().to_string()[..8];

    match suffix {
        Some(s) if !s.trim().is_empty() => {
            format!("{}_{}_{:03}_{}", timestamp, rand8, millis, s.trim())
        }
        _ => format!("{}_{}_{:03}", timestamp, rand8, millis),
    }
}

fn generate_backup_id(suffix: Option<&str>) -> String {
    generate_backup_id_at(chrono::Utc::now(), suffix)
}

fn parse_manifest_major(version: &str) -> Result<u64, BackupError> {
    let components = version.split('.').collect::<Vec<_>>();
    if components.len() != 3
        || components
            .iter()
            .any(|component| component.is_empty() || !component.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err(BackupError::Manifest(format!(
            "备份清单版本格式无效: {}",
            version
        )));
    }
    let major = components[0]
        .parse::<u64>()
        .map_err(|_| BackupError::Manifest(format!("备份清单主版本无效: {}", version)))?;
    if !(1..=MANIFEST_MAX_SUPPORTED_MAJOR).contains(&major) {
        return Err(BackupError::VersionIncompatible(format!(
            "不支持的备份清单版本: {}",
            version
        )));
    }
    Ok(major)
}

/// Whether a package can replace an entire data slot.
///
/// Missing values deserialize as `LegacyCandidate` so historical manifests can
/// never silently acquire full-snapshot semantics after an application update.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotKind {
    Full,
    PartialOverlay,
    #[serde(alias = "legacy_unknown")]
    LegacyCandidate,
}

fn legacy_snapshot_kind() -> SnapshotKind {
    SnapshotKind::LegacyCandidate
}

impl SnapshotKind {
    /// Source-compatibility alias for command/UI code that has not yet adopted
    /// the v3 `LegacyCandidate` terminology.
    #[allow(non_upper_case_globals)]
    pub const LegacyUnknown: Self = Self::LegacyCandidate;
}

/// How encryption material is represented by this package.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupKeyPolicy {
    IncludedLocal,
    ExcludedPortable,
    NotPresent,
    LegacyUnknown,
}

fn legacy_key_policy() -> BackupKeyPolicy {
    BackupKeyPolicy::LegacyUnknown
}

/// Evidence state for one persistent domain in a manifest v3 coverage ledger.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoverageStatus {
    Complete,
    Empty,
    Absent,
    Failed,
    Excluded,
}

/// Restored executable content is data only until a separate trust decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreTrustPolicy {
    Data,
    Explicit,
    UntrustedExecutable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreScope {
    ActiveDataSpace,
    ApplicationData,
    UserHome,
}

/// Central registry entry for a persistent user-data domain.
#[derive(Debug, Clone, Serialize)]
pub struct PersistentDomainSpec {
    pub id: String,
    pub archive_root: String,
    pub restore_target: String,
    pub presence_required: bool,
    pub executable: bool,
    pub optional: bool,
    pub encrypted: bool,
    pub restore_scope: RestoreScope,
    pub restore_trust: RestoreTrustPolicy,
}

/// Central persistent-domain registry used by backup creation and validation.
///
/// `optional` means the domain may legitimately be absent. It does not mean an
/// existing domain may be skipped while still claiming a full snapshot.
pub fn persistent_domain_registry() -> Vec<PersistentDomainSpec> {
    let mut domains = DatabaseId::all_ordered()
        .into_iter()
        .map(|database| PersistentDomainSpec {
            id: format!("database:{}", database.as_str()),
            archive_root: format!("{}.db", database.as_str()),
            restore_target: match database {
                DatabaseId::Vfs => "databases/vfs.db".to_string(),
                DatabaseId::ChatV2 => "chat_v2.db".to_string(),
                DatabaseId::Mistakes => "mistakes.db".to_string(),
                DatabaseId::LlmUsage => "llm_usage.db".to_string(),
            },
            presence_required: true,
            executable: false,
            optional: false,
            encrypted: false,
            restore_scope: RestoreScope::ActiveDataSpace,
            restore_trust: RestoreTrustPolicy::Data,
        })
        .collect::<Vec<_>>();
    domains.push(PersistentDomainSpec {
        id: "workspaces-root".to_string(),
        archive_root: "workspaces".to_string(),
        restore_target: "workspaces".to_string(),
        presence_required: false,
        executable: false,
        optional: true,
        encrypted: false,
        restore_scope: RestoreScope::ActiveDataSpace,
        restore_trust: RestoreTrustPolicy::Data,
    });
    domains.extend(AssetType::all().into_iter().map(|asset_type| {
        let root = asset_type.relative_path();
        PersistentDomainSpec {
            id: format!("asset-root:{}", root),
            archive_root: format!("assets/{}", root),
            restore_target: root.to_string(),
            presence_required: false,
            executable: false,
            optional: true,
            encrypted: false,
            restore_scope: RestoreScope::ActiveDataSpace,
            restore_trust: RestoreTrustPolicy::Data,
        }
    }));
    domains.extend([
        PersistentDomainSpec {
            id: "crypto".to_string(),
            archive_root: "crypto".to_string(),
            restore_target: ".".to_string(),
            presence_required: false,
            executable: false,
            optional: true,
            encrypted: true,
            restore_scope: RestoreScope::ApplicationData,
            restore_trust: RestoreTrustPolicy::Explicit,
        },
        PersistentDomainSpec {
            id: "audit".to_string(),
            archive_root: "databases/audit.db".to_string(),
            restore_target: "databases/audit.db".to_string(),
            presence_required: false,
            executable: false,
            optional: true,
            encrypted: false,
            restore_scope: RestoreScope::ApplicationData,
            restore_trust: RestoreTrustPolicy::Explicit,
        },
        PersistentDomainSpec {
            id: "webview-settings".to_string(),
            archive_root: "persistent/webview_settings.json".to_string(),
            restore_target: "webview_settings.json".to_string(),
            presence_required: false,
            executable: false,
            optional: true,
            encrypted: false,
            restore_scope: RestoreScope::ActiveDataSpace,
            restore_trust: RestoreTrustPolicy::Data,
        },
        PersistentDomainSpec {
            id: "custom-grading-modes".to_string(),
            archive_root: "persistent/custom_grading_modes.json".to_string(),
            restore_target: "custom_grading_modes.json".to_string(),
            presence_required: false,
            executable: false,
            optional: true,
            encrypted: false,
            restore_scope: RestoreScope::ActiveDataSpace,
            restore_trust: RestoreTrustPolicy::Data,
        },
        PersistentDomainSpec {
            id: "agents".to_string(),
            archive_root: "assets/workspaces/agents".to_string(),
            restore_target: "workspaces/agents".to_string(),
            presence_required: false,
            executable: true,
            optional: true,
            encrypted: false,
            restore_scope: RestoreScope::ActiveDataSpace,
            restore_trust: RestoreTrustPolicy::UntrustedExecutable,
        },
        PersistentDomainSpec {
            id: "user-skills".to_string(),
            archive_root: "persistent/user_skills".to_string(),
            restore_target: "~/.deep-student/skills".to_string(),
            presence_required: false,
            executable: true,
            optional: true,
            // Executable user packages stay in the encrypted/export-isolated
            // domain and are never emitted into an unencrypted portable ZIP.
            encrypted: true,
            restore_scope: RestoreScope::UserHome,
            restore_trust: RestoreTrustPolicy::UntrustedExecutable,
        },
    ]);
    domains
}

fn path_is_at_or_below(path: &str, root: &str) -> bool {
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn domain_owns_archive_path(spec: &PersistentDomainSpec, path: &str) -> bool {
    path_is_at_or_below(path, &spec.archive_root)
        || spec
            .id
            .strip_prefix("asset-root:")
            .is_some_and(|root| path_is_at_or_below(path, root))
        || (spec.id == "agents" && path_is_at_or_below(path, "workspaces/agents"))
}

fn archive_path_requires_explicit_trust(path: &str) -> bool {
    persistent_domain_registry().into_iter().any(|spec| {
        spec.restore_trust == RestoreTrustPolicy::UntrustedExecutable
            && domain_owns_archive_path(&spec, path)
    })
}

fn asset_requires_explicit_trust(asset: &assets::BackedUpAsset) -> bool {
    persistent_domain_registry().into_iter().any(|spec| {
        spec.restore_trust == RestoreTrustPolicy::UntrustedExecutable
            && (domain_owns_archive_path(&spec, &asset.relative_path)
                || path_is_at_or_below(&asset.original_path, &spec.restore_target))
    })
}

/// One domain's evidence. `paths` always names hashed files in `files` or
/// `assets.files`; empty/absent/excluded states therefore carry no paths.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainCoverage {
    pub status: CoverageStatus,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub file_count: usize,
    #[serde(default)]
    pub total_size: u64,
    pub executable: bool,
    pub optional: bool,
    pub encrypted: bool,
    pub restore_target: String,
    pub restore_scope: RestoreScope,
    pub restore_trust: RestoreTrustPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoverageLedger {
    pub version: u32,
    pub domains: BTreeMap<String, DomainCoverage>,
}

impl CoverageLedger {
    fn new_excluded() -> Self {
        let domains = persistent_domain_registry()
            .into_iter()
            .map(|spec| {
                (
                    spec.id,
                    DomainCoverage {
                        status: CoverageStatus::Excluded,
                        paths: Vec::new(),
                        file_count: 0,
                        total_size: 0,
                        executable: spec.executable,
                        optional: spec.optional,
                        encrypted: spec.encrypted,
                        restore_target: spec.restore_target,
                        restore_scope: spec.restore_scope,
                        restore_trust: spec.restore_trust,
                        detail: None,
                    },
                )
            })
            .collect();
        Self {
            version: 1,
            domains,
        }
    }
}

/// 备份清单
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupManifest {
    /// 清单版本
    pub version: String,
    /// 应用版本
    pub app_version: String,
    /// 创建时间
    pub created_at: String,
    /// 平台
    pub platform: String,
    /// 各数据库的 schema 版本
    pub schema_versions: HashMap<String, u32>,
    /// 文件列表（数据库文件）
    pub files: Vec<BackupFile>,
    /// 是否增量备份
    pub is_incremental: bool,
    /// 增量备份的基础版本（如果是增量）
    pub incremental_base: Option<String>,
    /// 备份 ID（唯一标识符）
    #[serde(default)]
    pub backup_id: String,
    /// 资产备份结果（可选）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assets: Option<assets::AssetBackupResult>,
    /// Slot replacement semantics. Legacy manifests default to fail-closed.
    #[serde(default = "legacy_snapshot_kind")]
    pub snapshot_kind: SnapshotKind,
    /// One immutable generation shared by every component in this package.
    #[serde(default)]
    pub snapshot_epoch: String,
    /// Components whose coverage is required before slot replacement.
    #[serde(default)]
    pub required_components: Vec<String>,
    /// Components actually scanned/captured, including empty asset roots.
    #[serde(default)]
    pub included_components: Vec<String>,
    /// Explicit encryption-material portability contract.
    #[serde(default = "legacy_key_policy")]
    pub key_policy: BackupKeyPolicy,
    /// Manifest v3 evidence ledger. Historical v1/v2 manifests deserialize
    /// without it and are normalized to `LegacyCandidate`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coverage: Option<CoverageLedger>,
}

impl BackupManifest {
    /// 创建新的备份清单
    pub fn new(app_version: &str) -> Self {
        let now = chrono::Utc::now();
        Self {
            version: MANIFEST_VERSION.to_string(),
            app_version: app_version.to_string(),
            created_at: now.to_rfc3339(),
            platform: std::env::consts::OS.to_string(),
            schema_versions: HashMap::new(),
            files: Vec::new(),
            is_incremental: false,
            incremental_base: None,
            backup_id: generate_backup_id_at(now, None),
            assets: None,
            snapshot_kind: SnapshotKind::PartialOverlay,
            snapshot_epoch: Uuid::new_v4().to_string(),
            required_components: Vec::new(),
            included_components: Vec::new(),
            key_policy: BackupKeyPolicy::NotPresent,
            coverage: Some(CoverageLedger::new_excluded()),
        }
    }

    /// 添加文件到清单
    pub fn add_file(&mut self, file: BackupFile) {
        self.files.push(file);
    }

    /// 设置 schema 版本
    pub fn set_schema_version(&mut self, db_name: &str, version: u32) {
        self.schema_versions.insert(db_name.to_string(), version);
    }

    fn component_for_file(file: &BackupFile) -> Option<String> {
        if let Some(database_id) = &file.database_id {
            return Some(format!("database:{}", database_id));
        }
        if let Some(name) = file.path.strip_prefix("workspaces/") {
            return Some(format!("workspace:{}", name));
        }
        if let Some(rest) = file.path.strip_prefix("assets/") {
            return rest
                .split('/')
                .next()
                .filter(|root| !root.is_empty())
                .map(|root| format!("asset-root:{}", root));
        }
        if let Some(root) = file.path.split('/').next() {
            if AssetType::all()
                .into_iter()
                .any(|asset_type| asset_type.relative_path() == root)
            {
                return Some(format!("asset-root:{}", root));
            }
        }
        None
    }

    fn refresh_included_components(&mut self) {
        let mut components = self
            .files
            .iter()
            .filter_map(Self::component_for_file)
            .collect::<HashSet<_>>();
        if let Some(asset_result) = &self.assets {
            for asset in &asset_result.files {
                components.insert(format!("asset-root:{}", asset.asset_type.relative_path()));
            }
        }
        if let Some(coverage) = &self.coverage {
            components.extend(coverage.domains.iter().filter_map(|(id, evidence)| {
                matches!(
                    evidence.status,
                    CoverageStatus::Complete | CoverageStatus::Empty | CoverageStatus::Absent
                )
                .then(|| id.clone())
            }));
        }
        let mut components = components.into_iter().collect::<Vec<_>>();
        components.sort();
        self.included_components = components;
    }

    fn full_required_components() -> Vec<String> {
        let mut required = persistent_domain_registry()
            .into_iter()
            .map(|domain| domain.id)
            .collect::<Vec<_>>();
        required.sort();
        required
    }

    fn manifested_path_sizes(&self) -> Result<HashMap<String, u64>, BackupError> {
        let mut paths = HashMap::new();
        for file in &self.files {
            if paths.insert(file.path.clone(), file.size).is_some() {
                return Err(BackupError::Manifest(format!(
                    "备份清单包含重复路径: {}",
                    file.path
                )));
            }
        }
        if let Some(assets) = &self.assets {
            for asset in &assets.files {
                if asset.is_directory {
                    continue;
                }
                if paths
                    .insert(asset.relative_path.clone(), asset.size)
                    .is_some()
                {
                    return Err(BackupError::Manifest(format!(
                        "备份清单包含重复路径: {}",
                        asset.relative_path
                    )));
                }
            }
        }
        Ok(paths)
    }

    fn record_coverage(
        &mut self,
        domain_id: &str,
        status: CoverageStatus,
        mut paths: Vec<String>,
        detail: Option<String>,
    ) -> Result<(), BackupError> {
        paths.sort();
        paths.dedup();
        let manifested = self.manifested_path_sizes()?;
        let mut total_size = 0u64;
        for path in &paths {
            let size = manifested.get(path).ok_or_else(|| {
                BackupError::Manifest(format!(
                    "覆盖证据引用了未纳入清单的文件: domain={}, path={}",
                    domain_id, path
                ))
            })?;
            total_size = total_size
                .checked_add(*size)
                .ok_or_else(|| BackupError::Manifest("覆盖证据总大小溢出".to_string()))?;
        }
        let spec = persistent_domain_registry()
            .into_iter()
            .find(|domain| domain.id == domain_id)
            .ok_or_else(|| BackupError::Manifest(format!("未知持久域: {}", domain_id)))?;
        if matches!(
            status,
            CoverageStatus::Empty | CoverageStatus::Absent | CoverageStatus::Excluded
        ) && !paths.is_empty()
        {
            return Err(BackupError::Manifest(format!(
                "覆盖状态 {:?} 不得携带文件: {}",
                status, domain_id
            )));
        }
        if status == CoverageStatus::Complete && paths.is_empty() {
            return Err(BackupError::Manifest(format!(
                "complete 覆盖状态缺少文件证据: {}",
                domain_id
            )));
        }
        let coverage = self
            .coverage
            .as_mut()
            .ok_or_else(|| BackupError::Manifest("manifest v3 缺少 coverage ledger".to_string()))?;
        coverage.domains.insert(
            domain_id.to_string(),
            DomainCoverage {
                status,
                file_count: paths.len(),
                paths,
                total_size,
                executable: spec.executable,
                optional: spec.optional,
                encrypted: spec.encrypted,
                restore_target: spec.restore_target,
                restore_scope: spec.restore_scope,
                restore_trust: spec.restore_trust,
                detail,
            },
        );
        self.refresh_included_components();
        Ok(())
    }

    fn validate_coverage_ledger(&self, require_full: bool) -> Result<(), BackupError> {
        let coverage = self
            .coverage
            .as_ref()
            .ok_or_else(|| BackupError::Manifest("manifest v3 缺少 coverage ledger".to_string()))?;
        if coverage.version != 1 {
            return Err(BackupError::Manifest(format!(
                "不支持的 coverage ledger 版本: {}",
                coverage.version
            )));
        }
        let manifested = self.manifested_path_sizes()?;
        let registry = persistent_domain_registry();
        let registry_ids = registry
            .iter()
            .map(|spec| spec.id.clone())
            .collect::<HashSet<_>>();
        if coverage.domains.len() != registry_ids.len()
            || coverage
                .domains
                .keys()
                .any(|domain| !registry_ids.contains(domain))
        {
            return Err(BackupError::Manifest(
                "覆盖账本域集合与持久域注册表不一致".to_string(),
            ));
        }
        let mut covered_paths = HashSet::new();
        for spec in registry {
            let evidence = coverage
                .domains
                .get(&spec.id)
                .ok_or_else(|| BackupError::Manifest(format!("覆盖账本缺少持久域: {}", spec.id)))?;
            if evidence.executable != spec.executable
                || evidence.optional != spec.optional
                || evidence.encrypted != spec.encrypted
                || evidence.restore_target != spec.restore_target
                || evidence.restore_scope != spec.restore_scope
                || evidence.restore_trust != spec.restore_trust
            {
                return Err(BackupError::Manifest(format!(
                    "持久域安全元数据与注册表不一致: {}",
                    spec.id
                )));
            }
            if require_full
                && matches!(
                    evidence.status,
                    CoverageStatus::Failed | CoverageStatus::Excluded
                )
            {
                return Err(BackupError::Manifest(format!(
                    "完整快照持久域未覆盖: {} ({:?})",
                    spec.id, evidence.status
                )));
            }
            if require_full && spec.presence_required && evidence.status != CoverageStatus::Complete
            {
                return Err(BackupError::Manifest(format!(
                    "必需持久域缺少完整文件证据: {} ({:?})",
                    spec.id, evidence.status
                )));
            }
            let paths_allowed = matches!(
                evidence.status,
                CoverageStatus::Complete | CoverageStatus::Failed
            );
            if (!paths_allowed && !evidence.paths.is_empty())
                || (evidence.status == CoverageStatus::Complete && evidence.paths.is_empty())
                || evidence.file_count != evidence.paths.len()
            {
                return Err(BackupError::Manifest(format!(
                    "持久域覆盖计数与状态不一致: {}",
                    spec.id
                )));
            }
            let mut total_size = 0u64;
            let mut unique = HashSet::new();
            for path in &evidence.paths {
                if !domain_owns_archive_path(&spec, path) {
                    return Err(BackupError::Manifest(format!(
                        "持久域覆盖路径越界: {} / {}",
                        spec.id, path
                    )));
                }
                if !unique.insert(path) {
                    return Err(BackupError::Manifest(format!(
                        "持久域覆盖包含重复路径: {} / {}",
                        spec.id, path
                    )));
                }
                covered_paths.insert(path.as_str());
                total_size = total_size
                    .checked_add(*manifested.get(path).ok_or_else(|| {
                        BackupError::Manifest(format!(
                            "持久域覆盖引用未声明文件: {} / {}",
                            spec.id, path
                        ))
                    })?)
                    .ok_or_else(|| BackupError::Manifest("覆盖总大小溢出".to_string()))?;
            }
            if total_size != evidence.total_size {
                return Err(BackupError::Manifest(format!(
                    "持久域覆盖大小不一致: {} expected={}, actual={}",
                    spec.id, evidence.total_size, total_size
                )));
            }
        }
        if require_full {
            if let Some(path) = manifested
                .keys()
                .find(|path| !covered_paths.contains(path.as_str()))
            {
                return Err(BackupError::Manifest(format!(
                    "完整快照包含未归属持久域的文件: {}",
                    path
                )));
            }
        }
        Ok(())
    }

    fn mark_full(&mut self) -> Result<(), BackupError> {
        // Full is a conclusion derived from evidence. This method never creates
        // empty-root labels or otherwise repairs missing coverage.
        self.validate_coverage_ledger(true)?;
        self.snapshot_kind = SnapshotKind::Full;
        self.required_components = Self::full_required_components();
        self.refresh_included_components();
        Ok(())
    }

    fn mark_partial(&mut self) {
        self.snapshot_kind = SnapshotKind::PartialOverlay;
        self.required_components.clear();
        self.refresh_included_components();
    }

    /// Validate the stronger contract required before replacing an inactive
    /// slot. General inspection/export may still use partial or legacy packages.
    pub fn validate_for_slot_restore(&self) -> Result<(), BackupError> {
        self.validate_untrusted()?;
        let major = parse_manifest_major(&self.version)?;
        if major < 3 || self.coverage.is_none() {
            return Err(BackupError::RestoreFailed(
                "旧版备份缺少可证明空域的 coverage ledger，仅可作为 LegacyCandidate 检查"
                    .to_string(),
            ));
        }
        if self.is_incremental {
            return Err(BackupError::IncrementalRestoreNotSupported(
                INCREMENTAL_RESTORE_NOT_SUPPORTED_MESSAGE.to_string(),
            ));
        }
        if self.snapshot_kind != SnapshotKind::Full {
            return Err(BackupError::RestoreFailed(format!(
                "备份不是可替换数据槽的完整快照: {:?}",
                self.snapshot_kind
            )));
        }
        if self.snapshot_epoch.trim().is_empty() {
            return Err(BackupError::Manifest(
                "完整快照缺少 snapshot_epoch".to_string(),
            ));
        }
        if self.key_policy == BackupKeyPolicy::LegacyUnknown {
            return Err(BackupError::Manifest(
                "完整快照缺少明确的 key_policy".to_string(),
            ));
        }
        self.validate_coverage_ledger(true)?;
        let crypto_status = self
            .coverage
            .as_ref()
            .and_then(|ledger| ledger.domains.get("crypto"))
            .map(|entry| entry.status)
            .ok_or_else(|| BackupError::Manifest("覆盖账本缺少 crypto 域".to_string()))?;
        match self.key_policy {
            BackupKeyPolicy::IncludedLocal if crypto_status != CoverageStatus::Complete => {
                return Err(BackupError::Manifest(
                    "key_policy=included_local 但 crypto 域没有完整文件证据".to_string(),
                ));
            }
            BackupKeyPolicy::NotPresent
                if !matches!(
                    crypto_status,
                    CoverageStatus::Absent | CoverageStatus::Empty
                ) =>
            {
                return Err(BackupError::Manifest(
                    "key_policy=not_present 与 crypto 覆盖状态不一致".to_string(),
                ));
            }
            BackupKeyPolicy::ExcludedPortable | BackupKeyPolicy::LegacyUnknown => {
                return Err(BackupError::Manifest(
                    "可替换数据槽的完整快照不得排除或隐式声明密钥策略".to_string(),
                ));
            }
            _ => {}
        }

        let mut paths = HashSet::new();
        let mut database_ids = HashSet::new();
        for file in &self.files {
            if !paths.insert(file.path.clone()) {
                return Err(BackupError::Manifest(format!(
                    "备份清单包含重复路径: {}",
                    file.path
                )));
            }
            if file.sha256.len() != 64 || !file.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(BackupError::Manifest(format!(
                    "备份文件 SHA-256 格式无效: {}",
                    file.path
                )));
            }
            if let Some(database_id) = &file.database_id {
                let known = DatabaseId::all_ordered()
                    .into_iter()
                    .any(|id| id.as_str() == database_id);
                if !known {
                    return Err(BackupError::Manifest(format!(
                        "备份包含未知数据库 ID: {}",
                        database_id
                    )));
                }
                let canonical = format!("{}.db", database_id);
                if file.path != canonical {
                    return Err(BackupError::Manifest(format!(
                        "数据库 {} 必须绑定规范路径 {}，实际为 {}",
                        database_id, canonical, file.path
                    )));
                }
                if !database_ids.insert(database_id.clone()) {
                    return Err(BackupError::Manifest(format!(
                        "数据库 ID 重复: {}",
                        database_id
                    )));
                }
            } else if file.path.starts_with("crypto/") || file.path.starts_with("persistent/") {
                // Explicit persistent-domain restore plans own these files.
            } else if file.path.ends_with(".db") {
                if file.path == "databases/audit.db" {
                    // Auxiliary DB: restored through the explicit audit plan,
                    // never through the active-slot core DB loop.
                } else {
                    let Some(name) = file.path.strip_prefix("workspaces/") else {
                        return Err(BackupError::Manifest(format!(
                            "未分类数据库文件禁止恢复: {}",
                            file.path
                        )));
                    };
                    if name.contains('/') || !name.starts_with("ws_") || !name.ends_with(".db") {
                        return Err(BackupError::Manifest(format!(
                            "工作区数据库路径无效: {}",
                            file.path
                        )));
                    }
                }
            } else {
                let root = file.path.split('/').next().unwrap_or_default();
                let known_asset_root = AssetType::all()
                    .into_iter()
                    .any(|asset_type| asset_type.relative_path() == root)
                    || matches!(root, "lance" | "assets" | "crypto" | "persistent");
                if !known_asset_root {
                    return Err(BackupError::Manifest(format!(
                        "完整快照包含未分类文件: {}",
                        file.path
                    )));
                }
            }
        }
        for id in DatabaseId::all_ordered() {
            if !database_ids.contains(id.as_str()) {
                return Err(BackupError::Manifest(format!(
                    "完整快照缺少核心数据库: {}",
                    id.as_str()
                )));
            }
        }

        if let Some(asset_result) = &self.assets {
            let mut sources = HashSet::new();
            let mut destinations = HashSet::new();
            for asset in &asset_result.files {
                let root = asset.asset_type.relative_path();
                let expected_source_prefix = format!("assets/{}/", root);
                let expected_destination_prefix = format!("{}/", root);
                if !asset.relative_path.starts_with(&expected_source_prefix)
                    || !asset
                        .original_path
                        .starts_with(&expected_destination_prefix)
                {
                    return Err(BackupError::Manifest(format!(
                        "资产路径未绑定到声明类型 {:?}: source={}, destination={}",
                        asset.asset_type, asset.relative_path, asset.original_path
                    )));
                }
                if asset.asset_type == AssetType::Workspaces
                    && (asset.original_path.ends_with(".db")
                        || asset.original_path.ends_with("-wal")
                        || asset.original_path.ends_with("-shm"))
                {
                    return Err(BackupError::Manifest(format!(
                        "工作区 SQLite 文件只能通过一致性快照恢复: {}",
                        asset.original_path
                    )));
                }
                if !sources.insert(asset.relative_path.clone())
                    || !destinations.insert(asset.original_path.clone())
                {
                    return Err(BackupError::Manifest(format!(
                        "资产清单包含重复源或目标路径: {}",
                        asset.original_path
                    )));
                }
                if !asset.is_directory
                    && (asset.checksum.as_ref().is_none_or(|checksum| {
                        checksum.len() != 64 || !checksum.bytes().all(|b| b.is_ascii_hexdigit())
                    }))
                {
                    return Err(BackupError::Manifest(format!(
                        "完整快照资产缺少有效 SHA-256: {}",
                        asset.relative_path
                    )));
                }
            }
        }
        let manifest_major = parse_manifest_major(&self.version)?;
        if manifest_major >= 3 {
            self.validate_coverage_ledger(self.snapshot_kind == SnapshotKind::Full)?;
        }
        Ok(())
    }

    fn validate_untrusted(&self) -> Result<(), BackupError> {
        let manifest_major = parse_manifest_major(&self.version)?;
        if manifest_major >= 3 && self.coverage.is_none() {
            return Err(BackupError::Manifest(
                "manifest v3 缺少 coverage ledger，不能降级为 legacy".to_string(),
            ));
        }
        if self.backup_id.is_empty()
            || self.backup_id.len() > 128
            || self.backup_id.starts_with('.')
            || self.backup_id.contains("..")
            || !self
                .backup_id
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
        {
            return Err(BackupError::Manifest(
                "备份清单包含非法 backup_id".to_string(),
            ));
        }
        if self.files.len() > MAX_MANIFEST_FILES {
            return Err(BackupError::Manifest(format!(
                "备份清单文件数超限: {} > {}",
                self.files.len(),
                MAX_MANIFEST_FILES
            )));
        }

        let mut total_size = 0u64;
        for file in &self.files {
            validate_safe_relative_path(Path::new(&file.path))?;
            total_size = total_size
                .checked_add(file.size)
                .ok_or_else(|| BackupError::Manifest("备份清单文件总大小溢出".to_string()))?;
            if total_size > MAX_MANIFEST_TOTAL_FILE_BYTES {
                return Err(BackupError::Manifest(format!(
                    "备份清单文件总大小超限: {} bytes",
                    total_size
                )));
            }
        }
        if let Some(assets) = &self.assets {
            if assets.files.len() > MAX_MANIFEST_FILES {
                return Err(BackupError::Manifest(format!(
                    "备份清单资产数超限: {} > {}",
                    assets.files.len(),
                    MAX_MANIFEST_FILES
                )));
            }
            for asset in &assets.files {
                validate_safe_relative_path(Path::new(&asset.relative_path))?;
                validate_safe_relative_path(Path::new(&asset.original_path))?;
                total_size = total_size
                    .checked_add(asset.size)
                    .ok_or_else(|| BackupError::Manifest("备份清单资产总大小溢出".to_string()))?;
                if total_size > MAX_MANIFEST_TOTAL_FILE_BYTES {
                    return Err(BackupError::Manifest(format!(
                        "备份清单文件与资产总大小超限: {} bytes",
                        total_size
                    )));
                }
            }
        }
        if manifest_major >= 3 {
            self.validate_coverage_ledger(self.snapshot_kind == SnapshotKind::Full)?;
        }
        Ok(())
    }

    /// Fail-closed validation gate for historical v1/v2 packages.
    ///
    /// Passing this gate only makes a package eligible for an explicit
    /// migration/inspection path. It does not infer empty or absent domains and
    /// therefore never grants `Full` slot-replacement semantics.
    pub(crate) fn validate_legacy_candidate_for_upgrade(&self) -> Result<(), BackupError> {
        self.validate_untrusted()?;
        let major = parse_manifest_major(&self.version)?;
        if !matches!(major, 1 | 2)
            || self.snapshot_kind != SnapshotKind::LegacyCandidate
            || self.coverage.is_some()
            || self.key_policy != BackupKeyPolicy::LegacyUnknown
        {
            return Err(BackupError::Manifest(
                "仅规范化后的 v1/v2 LegacyCandidate 可进入升级验证".to_string(),
            ));
        }
        if self.is_incremental {
            return Err(BackupError::IncrementalRestoreNotSupported(
                INCREMENTAL_RESTORE_NOT_SUPPORTED_MESSAGE.to_string(),
            ));
        }

        // Detect duplicate paths across both historical file lists before any
        // archive entry is trusted.
        self.manifested_path_sizes()?;

        let known_databases = DatabaseId::all_ordered();
        let mut database_ids = HashSet::new();
        for file in &self.files {
            if file.sha256.len() != 64 || !file.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(BackupError::Manifest(format!(
                    "旧版备份文件缺少有效 SHA-256: {}",
                    file.path
                )));
            }
            if let Some(database_id) = &file.database_id {
                if !known_databases
                    .iter()
                    .any(|known| known.as_str() == database_id)
                    || file.path != format!("{}.db", database_id)
                    || !database_ids.insert(database_id.clone())
                {
                    return Err(BackupError::Manifest(format!(
                        "旧版核心数据库声明无效或重复: {} / {}",
                        database_id, file.path
                    )));
                }
                continue;
            }

            let path = file.path.as_str();
            let known_asset_path = AssetType::all().into_iter().any(|asset_type| {
                let root = asset_type.relative_path();
                path.strip_prefix(root)
                    .is_some_and(|suffix| suffix.starts_with('/'))
                    || path
                        .strip_prefix(&format!("assets/{}", root))
                        .is_some_and(|suffix| suffix.starts_with('/'))
            });
            let known_workspace_database = path.strip_prefix("workspaces/").is_some_and(|name| {
                !name.contains('/') && name.starts_with("ws_") && name.ends_with(".db")
            });
            let known_crypto = path == "crypto/.master_key"
                || path == "crypto/.secure/.key_seed"
                || path.strip_prefix("crypto/.secure/").is_some_and(|name| {
                    !name.contains('/')
                        && Path::new(name)
                            .extension()
                            .is_some_and(|extension| extension.eq_ignore_ascii_case("enc"))
                });
            let known_persistent = matches!(
                path,
                "persistent/webview_settings.json" | "persistent/custom_grading_modes.json"
            ) || path.starts_with("persistent/user_skills/");
            let known_auxiliary = path == "databases/audit.db"
                || known_crypto
                || known_persistent
                || path.starts_with("lance/")
                || path.starts_with("databases/lance/");
            if !known_asset_path && !known_workspace_database && !known_auxiliary {
                return Err(BackupError::Manifest(format!(
                    "旧版备份包含未分类文件: {}",
                    path
                )));
            }
        }
        for database in known_databases {
            if !database_ids.contains(database.as_str()) {
                return Err(BackupError::Manifest(format!(
                    "旧版备份缺少核心数据库: {}",
                    database.as_str()
                )));
            }
        }

        if let Some(asset_result) = &self.assets {
            let mut total_size = 0u64;
            let mut file_count = 0usize;
            for asset in &asset_result.files {
                if asset.is_directory {
                    continue;
                }
                let root = asset.asset_type.relative_path();
                if !asset
                    .relative_path
                    .starts_with(&format!("assets/{}/", root))
                    || !asset.original_path.starts_with(&format!("{}/", root))
                {
                    return Err(BackupError::Manifest(format!(
                        "旧版资产路径与类型不一致: {}",
                        asset.relative_path
                    )));
                }
                let checksum = asset.checksum.as_ref().ok_or_else(|| {
                    BackupError::Manifest(format!(
                        "旧版资产缺少 SHA-256，不能升级: {}",
                        asset.relative_path
                    ))
                })?;
                if checksum.len() != 64 || !checksum.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                    return Err(BackupError::Manifest(format!(
                        "旧版资产 SHA-256 无效: {}",
                        asset.relative_path
                    )));
                }
                total_size = total_size
                    .checked_add(asset.size)
                    .ok_or_else(|| BackupError::Manifest("旧版资产总大小溢出".to_string()))?;
                file_count = file_count
                    .checked_add(1)
                    .ok_or_else(|| BackupError::Manifest("旧版资产计数溢出".to_string()))?;
            }
            if file_count != asset_result.total_files || total_size != asset_result.total_size {
                return Err(BackupError::Manifest(
                    "旧版资产统计与逐文件证据不一致".to_string(),
                ));
            }
        }
        Ok(())
    }

    /// Convert a strictly validated historical package into a v3 overlay.
    ///
    /// Historical manifests cannot prove that an unlisted domain was empty or
    /// absent. The migration therefore records known singleton files as
    /// complete, marks multi-file roots with declared files as failed
    /// (evidence exists but completeness is unprovable), and leaves every
    /// unrepresented domain excluded. It can never produce `Full`.
    pub(crate) fn upgrade_legacy_candidate_to_v3_overlay(&mut self) -> Result<(), BackupError> {
        self.validate_legacy_candidate_for_upgrade()?;
        self.coverage = Some(CoverageLedger::new_excluded());

        for database in DatabaseId::all_ordered() {
            let path = format!("{}.db", database.as_str());
            self.record_coverage(
                &format!("database:{}", database.as_str()),
                CoverageStatus::Complete,
                vec![path],
                Some("strictly validated legacy database evidence".to_string()),
            )?;
        }

        let manifested = self.manifested_path_sizes()?;
        for spec in persistent_domain_registry()
            .into_iter()
            .filter(|spec| !spec.id.starts_with("database:"))
        {
            let mut paths = manifested
                .keys()
                .filter(|path| {
                    *path == &spec.archive_root
                        || path
                            .strip_prefix(&spec.archive_root)
                            .is_some_and(|suffix| suffix.starts_with('/'))
                        || spec.id.strip_prefix("asset-root:").is_some_and(|root| {
                            *path == root
                                || path
                                    .strip_prefix(root)
                                    .is_some_and(|suffix| suffix.starts_with('/'))
                        })
                        || (spec.id == "agents"
                            && path
                                .strip_prefix("workspaces/agents")
                                .is_some_and(|suffix| suffix.starts_with('/')))
                })
                .cloned()
                .collect::<Vec<_>>();
            paths.sort();
            if paths.is_empty() {
                continue;
            }
            let singleton_domain = matches!(
                spec.id.as_str(),
                "audit" | "webview-settings" | "custom-grading-modes"
            );
            self.record_coverage(
                &spec.id,
                if singleton_domain && paths.len() == 1 {
                    CoverageStatus::Complete
                } else {
                    CoverageStatus::Failed
                },
                paths,
                Some(if singleton_domain {
                    "strictly validated legacy singleton evidence".to_string()
                } else {
                    "legacy package contains files but cannot prove complete root coverage"
                        .to_string()
                }),
            )?;
        }

        self.version = MANIFEST_VERSION.to_string();
        if self.snapshot_epoch.trim().is_empty() {
            self.snapshot_epoch = Uuid::new_v4().to_string();
        }
        self.mark_partial();
        self.validate_untrusted()
    }

    /// 保存清单到文件（原子写入）
    ///
    /// 使用"临时文件 + 原子重命名"模式，确保写入过程中断时不会丢失数据。
    /// 1. 先写入临时文件 (.json.tmp)
    /// 2. 同步到磁盘
    /// 3. 原子重命名为目标文件
    pub fn save_to_file(&self, path: &Path) -> Result<(), BackupError> {
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| BackupError::Manifest(format!("序列化清单失败: {}", e)))?;

        // 1. 写入临时文件
        let temp_path = path.with_extension("json.tmp");
        let mut file = File::create(&temp_path)?;
        file.write_all(json.as_bytes())?;

        // 2. 同步到磁盘，确保数据完全写入
        file.sync_all()?;

        // 3. 原子重命名（在同一文件系统上是原子操作）
        fs::rename(&temp_path, path).map_err(|e| {
            // 重命名失败时尝试清理临时文件
            let _ = fs::remove_file(&temp_path);
            BackupError::Io(e)
        })?;

        Ok(())
    }

    /// 从文件加载清单
    pub fn load_from_file(path: &Path) -> Result<Self, BackupError> {
        let metadata = fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(BackupError::Manifest(
                "清单必须是普通文件，不能是目录或符号链接".to_string(),
            ));
        }
        if metadata.len() > MAX_MANIFEST_BYTES {
            return Err(BackupError::Manifest(format!(
                "清单文件过大: {} > {} bytes",
                metadata.len(),
                MAX_MANIFEST_BYTES
            )));
        }

        let mut content = String::new();
        File::open(path)?
            .take(MAX_MANIFEST_BYTES + 1)
            .read_to_string(&mut content)?;
        if content.len() as u64 > MAX_MANIFEST_BYTES {
            return Err(BackupError::Manifest("清单文件读取超限".to_string()));
        }
        let mut manifest: Self = serde_json::from_str(&content)
            .map_err(|e| BackupError::Manifest(format!("解析清单失败: {}", e)))?;
        let major = parse_manifest_major(&manifest.version)?;
        if matches!(major, 1 | 2) {
            manifest.snapshot_kind = SnapshotKind::LegacyCandidate;
            manifest.coverage = None;
            manifest.key_policy = BackupKeyPolicy::LegacyUnknown;
            manifest.required_components.clear();
        } else if manifest.coverage.is_none() {
            return Err(BackupError::Manifest(
                "manifest v3 缺少 coverage ledger，拒绝按旧版候选加载".to_string(),
            ));
        }
        manifest.validate_untrusted()?;
        if manifest.snapshot_kind == SnapshotKind::Full {
            manifest.validate_for_slot_restore()?;
        }
        Ok(manifest)
    }

    /// Explicit restore metadata for auxiliary/persistent domains. Restore
    /// orchestration can consume this without guessing archive paths.
    pub fn domain_restore_plan(&self, domain_id: &str) -> Option<DomainRestorePlan> {
        let spec = persistent_domain_registry()
            .into_iter()
            .find(|domain| domain.id == domain_id)?;
        let coverage = self.coverage.as_ref()?.domains.get(domain_id)?;
        let files = coverage
            .paths
            .iter()
            .filter_map(|path| {
                if let Some(file) = self.files.iter().find(|file| &file.path == path) {
                    return Some(DomainRestoreFile {
                        path: path.clone(),
                        size: file.size,
                        sha256: Some(file.sha256.clone()),
                    });
                }
                self.assets.as_ref().and_then(|assets| {
                    assets
                        .files
                        .iter()
                        .find(|asset| &asset.relative_path == path && !asset.is_directory)
                        .map(|asset| DomainRestoreFile {
                            path: path.clone(),
                            size: asset.size,
                            sha256: asset.checksum.clone(),
                        })
                })
            })
            .collect();
        Some(DomainRestorePlan {
            domain_id: domain_id.to_string(),
            status: coverage.status,
            archive_paths: coverage.paths.clone(),
            files,
            file_count: coverage.file_count,
            total_size: coverage.total_size,
            restore_target: spec.restore_target,
            restore_scope: spec.restore_scope,
            executable: spec.executable,
            optional: spec.optional,
            encrypted: spec.encrypted,
            restore_trust: spec.restore_trust,
        })
    }

    pub fn audit_restore_plan(&self) -> Option<DomainRestorePlan> {
        self.domain_restore_plan("audit")
    }

    pub fn crypto_restore_plan(&self) -> Option<DomainRestorePlan> {
        self.domain_restore_plan("crypto")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainRestorePlan {
    pub domain_id: String,
    pub status: CoverageStatus,
    pub archive_paths: Vec<String>,
    pub files: Vec<DomainRestoreFile>,
    pub file_count: usize,
    pub total_size: u64,
    pub restore_target: String,
    pub restore_scope: RestoreScope,
    pub executable: bool,
    pub optional: bool,
    pub encrypted: bool,
    pub restore_trust: RestoreTrustPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainRestoreFile {
    pub path: String,
    pub size: u64,
    pub sha256: Option<String>,
}

/// 备份文件信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupFile {
    /// 相对路径
    pub path: String,
    /// 文件大小
    pub size: u64,
    /// SHA256 校验和
    pub sha256: String,
    /// 数据库标识（可选）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_id: Option<String>,
}

/// 备份配置
pub struct BackupConfig {
    /// 应用数据目录
    pub app_data_dir: PathBuf,
    /// 应用版本
    pub app_version: String,
    /// 备份进度回调（可选）
    pub progress_callback: Option<Box<dyn Fn(BackupProgress) + Send + Sync>>,
}

impl std::fmt::Debug for BackupConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BackupConfig")
            .field("app_data_dir", &self.app_data_dir)
            .field("app_version", &self.app_version)
            .field(
                "progress_callback",
                &self.progress_callback.as_ref().map(|_| "<callback>"),
            )
            .finish()
    }
}

/// 备份进度信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupProgress {
    /// 当前阶段
    pub stage: BackupStage,
    /// 当前数据库
    pub current_database: Option<String>,
    /// 已完成的数据库数量
    pub completed_databases: usize,
    /// 总数据库数量
    pub total_databases: usize,
    /// 阶段进度 (0.0 - 1.0)
    pub stage_progress: f64,
}

/// 备份阶段
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum BackupStage {
    /// 准备中
    Preparing,
    /// 执行 WAL checkpoint
    Checkpoint,
    /// 复制数据库
    CopyingDatabase,
    /// 计算校验和
    ComputingChecksum,
    /// 生成清单
    GeneratingManifest,
    /// 完成
    Completed,
}

/// 备份错误
#[derive(Debug, thiserror::Error)]
pub enum BackupError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Database error: {0}")]
    Database(String),

    #[error("Checksum mismatch: expected {expected}, got {actual}")]
    ChecksumMismatch { expected: String, actual: String },

    #[error("Manifest error: {0}")]
    Manifest(String),

    #[error("Restore failed: {0}")]
    RestoreFailed(String),

    #[error("File not found: {0}")]
    FileNotFound(String),

    #[error("Integrity check failed: {0}")]
    IntegrityCheckFailed(String),

    #[error("Backup directory error: {0}")]
    BackupDirectory(String),

    #[error("Version incompatible: {0}")]
    VersionIncompatible(String),

    #[error("Incremental restore not supported: {0}")]
    IncrementalRestoreNotSupported(String),

    /// 增量备份创建入口已下线（空壳实现，无行 payload）
    #[error("{0}")]
    IncrementalBackupRemoved(String),

    #[error("Not implemented: {0}")]
    NotImplemented(String),
}

impl From<rusqlite::Error> for BackupError {
    fn from(err: rusqlite::Error) -> Self {
        BackupError::Database(err.to_string())
    }
}

/// 备份验证结果
///
/// 包含数据库和资产文件的验证结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupVerifyResult {
    /// 是否全部有效
    pub is_valid: bool,
    /// 数据库验证错误
    pub database_errors: Vec<String>,
    /// 资产验证错误
    pub asset_errors: Vec<AssetVerifyError>,
}

impl BackupVerifyResult {
    /// 创建一个表示全部有效的结果
    pub fn valid() -> Self {
        Self {
            is_valid: true,
            database_errors: Vec::new(),
            asset_errors: Vec::new(),
        }
    }

    /// 获取错误总数
    pub fn total_errors(&self) -> usize {
        self.database_errors.len() + self.asset_errors.len()
    }
}

// ============================================================================
// 分层备份 (Tiered Backup) 类型定义
// ============================================================================

/// 备份层级
///
/// 定义数据的重要性和可重建性，用于分层备份策略：
/// - Core: 最核心的用户数据，必须备份
/// - Important: 重要数据，建议备份
/// - Rebuildable: 可重建的数据（如向量索引），可选备份
/// - LargeAssets: 大型资产文件，按需备份
///
/// ## 2026-02 更新说明
///
/// 根据数据库使用情况调研，层级内容已更新：
/// - Core (P0): chat_v2.db, vfs.db, mistakes.db（核心用户数据）
/// - Important (P1): llm_usage.db + notes_assets/（LLM 使用记录、笔记资产）
/// - Rebuildable (P2): lance/（向量索引，可重建）
/// - LargeAssets (P3): images/, documents/, videos/（大型资产文件）
///
/// ## mistakes.db 特别说明
///
/// `mistakes.db` 是应用的**主数据库**（历史命名来源于错题功能）：
/// - **仍需备份**：包含 anki_cards、settings、review_analyses 等活跃表
/// - **部分废弃**：只有 `mistakes` 表和 `chat_messages` 表的错题业务功能已废弃
///
/// ## 已废弃的独立数据库（不再纳入备份层级）
/// - notes.db：正在迁移到 VFS
/// - anki.db：制卡数据，通过 VFS 上下文访问
/// - research.db, template_ai.db, essay_grading.db, canvas_boards.db：均已废弃
/// - textbooks.db, resources.db, main.db：已迁移到 VFS
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupTier {
    #[serde(alias = "core_config_chat")]
    Core,
    #[serde(alias = "vfs_full")]
    Important,
    Rebuildable,
    #[serde(alias = "large_files")]
    LargeAssets,
}

impl BackupTier {
    /// 获取此层级包含的数据库
    ///
    /// ## 2026-02 更新说明
    ///
    /// `Mistakes` 数据库（mistakes.db）仍需备份，原因：
    /// - 这是应用的**主数据库**（历史命名来源于错题功能）
    /// - 包含活跃表：review_analyses、anki_cards、settings、document_tasks 等
    /// - 只有 `mistakes` 表和 `chat_messages` 表的错题业务功能已废弃
    pub fn databases(&self) -> Vec<DatabaseId> {
        match self {
            BackupTier::Core => vec![
                DatabaseId::ChatV2,
                DatabaseId::Vfs,
                DatabaseId::Mistakes, // 主数据库，包含 anki_cards、settings 等活跃表
            ],
            BackupTier::Important => vec![
                DatabaseId::LlmUsage,
                // LLM 使用统计数据库，记录所有 LLM 调用的 token 使用
            ],
            BackupTier::Rebuildable => vec![
                // Lance 向量索引不是 SQLite 数据库，通过 asset_directories() 处理
            ],
            BackupTier::LargeAssets => vec![
                // 大型资产文件，不是数据库，通过 asset_directories() 处理
            ],
        }
    }

    /// 获取此层级包含的资产目录
    pub fn asset_directories(&self) -> Vec<&'static str> {
        match self {
            BackupTier::Core => vec![],
            BackupTier::Important => vec![
                "notes_assets",
                "vfs_blobs",
                "subjects",
                "textbooks",
                "workspaces",
                "pdf_ocr_sessions",
            ],
            BackupTier::Rebuildable => vec!["databases/lance/vfs"],
            BackupTier::LargeAssets => {
                vec!["images", "documents", "audio", "videos", "assets"]
            }
        }
    }

    /// 获取层级的优先级（数字越小优先级越高）
    pub fn priority(&self) -> u8 {
        match self {
            BackupTier::Core => 0,
            BackupTier::Important => 1,
            BackupTier::Rebuildable => 2,
            BackupTier::LargeAssets => 3,
        }
    }

    /// 返回所有层级（按优先级排序）
    pub fn all_ordered() -> Vec<BackupTier> {
        vec![
            BackupTier::Core,
            BackupTier::Important,
            BackupTier::Rebuildable,
            BackupTier::LargeAssets,
        ]
    }
}

/// 分层备份资产配置
///
/// 专用于分层备份的简化资产配置。
/// 与 `assets::AssetBackupConfig` 不同，这个配置更简单，
/// 主要用于 `backup_tiered` 方法。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TieredAssetConfig {
    /// 最大单个文件大小（字节）
    /// 超过此大小的文件将被跳过
    #[serde(default = "default_tiered_max_file_size")]
    pub max_file_size: u64,
    /// 包含的文件扩展名（空表示全部）
    #[serde(default)]
    pub include_extensions: Vec<String>,
    /// 排除的文件扩展名
    #[serde(default)]
    pub exclude_extensions: Vec<String>,
    /// 是否包含隐藏文件
    #[serde(default)]
    pub include_hidden: bool,
    /// 是否跟随符号链接
    #[serde(default)]
    pub follow_symlinks: bool,
    /// 筛选的资产类型（空表示全部类型）
    /// 前端可选择只备份特定类型的资产（如仅图片、仅文档等）
    #[serde(default)]
    pub asset_types: Vec<AssetType>,
}

fn default_tiered_max_file_size() -> u64 {
    100 * 1024 * 1024 // 100MB
}

impl Default for TieredAssetConfig {
    fn default() -> Self {
        Self {
            max_file_size: default_tiered_max_file_size(),
            include_extensions: vec![],
            exclude_extensions: vec!["tmp".to_string(), "temp".to_string(), "cache".to_string()],
            include_hidden: false,
            follow_symlinks: false,
            asset_types: vec![],
        }
    }
}

/// 备份选择配置
///
/// 允许用户自定义要备份的内容：
/// - 按层级选择
/// - 显式包含/排除特定数据库
/// - 配置资产备份选项
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupSelection {
    /// 要备份的层级（空表示全量）
    #[serde(default)]
    pub tiers: Vec<BackupTier>,
    /// 显式包含的数据库（覆盖层级设置）
    #[serde(default)]
    pub include_databases: Vec<String>,
    /// 显式排除的数据库
    #[serde(default)]
    pub exclude_databases: Vec<String>,
    /// 是否包含资产文件
    #[serde(default = "default_include_assets")]
    pub include_assets: bool,
    /// 资产配置（可选）
    #[serde(default)]
    pub asset_config: Option<TieredAssetConfig>,
}

fn default_include_assets() -> bool {
    false
}

impl Default for BackupSelection {
    fn default() -> Self {
        Self::full()
    }
}

impl BackupSelection {
    /// 精简备份（仅核心数据库）
    pub fn slim() -> Self {
        Self {
            tiers: vec![BackupTier::Core],
            include_databases: vec![],
            exclude_databases: vec![],
            include_assets: false,
            asset_config: None,
        }
    }

    /// 最小备份（核心 + 重要）
    pub fn minimal() -> Self {
        Self {
            tiers: vec![BackupTier::Core, BackupTier::Important],
            include_databases: vec![],
            exclude_databases: vec![],
            include_assets: false,
            asset_config: None,
        }
    }

    /// 完整备份（所有数据库和资产）
    pub fn full() -> Self {
        Self {
            tiers: BackupTier::all_ordered(),
            include_databases: vec![],
            exclude_databases: vec![],
            include_assets: true,
            asset_config: Some(TieredAssetConfig::default()),
        }
    }

    /// 仅数据库备份（不含资产）
    pub fn databases_only() -> Self {
        Self {
            tiers: vec![BackupTier::Core, BackupTier::Important],
            include_databases: vec![],
            exclude_databases: vec![],
            include_assets: false,
            asset_config: None,
        }
    }

    /// 检查数据库是否应该被备份
    pub fn should_backup_database(&self, db_id: &DatabaseId) -> bool {
        let db_name = db_id.as_str().to_string();

        // 显式排除优先
        if self.exclude_databases.contains(&db_name) {
            return false;
        }

        // 显式包含
        if self.include_databases.contains(&db_name) {
            return true;
        }

        // 按层级判断
        for tier in &self.tiers {
            if tier.databases().contains(db_id) {
                return true;
            }
        }

        // 如果没有指定层级，默认备份所有核心数据库
        if self.tiers.is_empty() {
            return BackupTier::Core.databases().contains(db_id);
        }

        false
    }

    /// 获取需要备份的资产目录
    pub fn get_asset_directories(&self) -> Vec<&'static str> {
        if !self.include_assets {
            return vec![];
        }

        let mut dirs: HashSet<&'static str> = HashSet::new();
        for tier in &self.tiers {
            for dir in tier.asset_directories() {
                dirs.insert(dir);
            }
        }
        dirs.into_iter().collect()
    }
}

/// 分层备份结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TieredBackupResult {
    /// 备份清单
    pub manifest: BackupManifest,
    /// 备份的层级
    pub backed_up_tiers: Vec<BackupTier>,
    /// 各层级的文件数量
    pub tier_file_counts: HashMap<String, usize>,
    /// 各层级的大小（字节）
    pub tier_sizes: HashMap<String, u64>,
    /// 跳过的文件（超过大小限制等）
    pub skipped_files: Vec<SkippedFile>,
    /// 总耗时（毫秒）
    pub duration_ms: u64,
}

/// 跳过的文件信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkippedFile {
    /// 文件路径
    pub path: String,
    /// 跳过原因
    pub reason: String,
}

/// 变更日志表 SQL（历史增量备份 / 云同步共用元数据）
pub const CHANGE_LOG_TABLE_SQL: &str = r#"
    CREATE TABLE IF NOT EXISTS __change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK(operation IN ('INSERT', 'UPDATE', 'DELETE')),
        changed_at TEXT NOT NULL DEFAULT (datetime('now')),
        sync_version INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_change_log_sync_version ON __change_log(sync_version);
    CREATE INDEX IF NOT EXISTS idx_change_log_changed_at ON __change_log(changed_at);
"#;

/// 备份管理器
///
/// 负责执行数据库的完整备份、恢复和验证操作（增量创建已下线）。
/// 使用 SQLite Backup API 确保备份的原子性和一致性。
pub struct BackupManager {
    /// 备份目录
    backup_dir: PathBuf,
    /// 应用数据目录
    app_data_dir: PathBuf,
    /// 应用版本
    app_version: String,
    /// 可选的进度回调：(当前数据库索引, 数据库总数, 数据库名称, 已复制页数, 总页数)
    progress_callback: Option<Box<dyn Fn(usize, usize, &str, i32, i32) + Send + Sync>>,
}

impl BackupManager {
    /// 创建新的备份管理器
    pub fn new(backup_dir: PathBuf) -> Self {
        Self {
            backup_dir,
            app_data_dir: PathBuf::new(),
            app_version: String::from("unknown"),
            progress_callback: None,
        }
    }

    /// 使用完整配置创建备份管理器
    pub fn with_config(backup_dir: PathBuf, config: BackupConfig) -> Self {
        Self {
            backup_dir,
            app_data_dir: config.app_data_dir,
            app_version: config.app_version,
            progress_callback: None,
        }
    }

    /// 设置进度回调：(当前数据库索引, 数据库总数, 数据库名称, 已复制页数, 总页数)
    pub fn set_progress_callback<F>(&mut self, callback: F)
    where
        F: Fn(usize, usize, &str, i32, i32) + Send + Sync + 'static,
    {
        self.progress_callback = Some(Box::new(callback));
    }

    /// 设置应用数据目录
    pub fn set_app_data_dir(&mut self, dir: PathBuf) {
        self.app_data_dir = dir;
    }

    /// 设置应用版本
    pub fn set_app_version(&mut self, version: String) {
        self.app_version = version;
    }

    /// 获取备份目录
    pub fn backup_dir(&self) -> &Path {
        &self.backup_dir
    }

    fn sqlite_table_columns(
        conn: &Connection,
        table_name: &str,
    ) -> Result<HashSet<String>, BackupError> {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            [table_name],
            |row| row.get(0),
        )?;
        if !exists {
            return Ok(HashSet::new());
        }

        let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table_name))?;
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<HashSet<_>, _>>()?;
        Ok(columns)
    }

    fn reset_rebuildable_vfs_index(target_dir: &Path) -> Result<(), BackupError> {
        let lance_dir = target_dir.join("databases").join("lance").join("vfs");
        if lance_dir.exists() {
            fs::remove_dir_all(&lance_dir).map_err(|error| {
                BackupError::RestoreFailed(format!(
                    "无法清理恢复目标中的陈旧 Lance 索引 {}: {}",
                    lance_dir.display(),
                    error
                ))
            })?;
        }

        let db_path = target_dir.join("databases").join("vfs.db");
        if !db_path.exists() {
            return Ok(());
        }
        let conn = Connection::open(&db_path)?;
        let segment_columns = Self::sqlite_table_columns(&conn, "vfs_index_segments")?;
        let unit_columns = Self::sqlite_table_columns(&conn, "vfs_index_units")?;
        let dim_columns = Self::sqlite_table_columns(&conn, "vfs_embedding_dims")?;
        let profile_columns = Self::sqlite_table_columns(&conn, "vfs_index_profiles")?;
        let resource_columns = Self::sqlite_table_columns(&conn, "resources")?;
        let file_columns = Self::sqlite_table_columns(&conn, "files")?;
        let exam_columns = Self::sqlite_table_columns(&conn, "exam_sheets")?;
        let orphan_columns = Self::sqlite_table_columns(&conn, "__lance_orphan_queue")?;
        let tx = conn.unchecked_transaction()?;
        if !segment_columns.is_empty() {
            tx.execute("DELETE FROM vfs_index_segments", [])?;
        }

        let mut unit_resets: Vec<String> = Vec::new();
        if unit_columns.contains("text_state") {
            unit_resets.push(if unit_columns.contains("text_required") {
                "text_state = CASE WHEN text_required = 1 THEN 'pending' ELSE 'disabled' END"
                    .to_string()
            } else {
                "text_state = 'pending'".to_string()
            });
        }
        for (column, value) in [
            ("text_error", "NULL"),
            ("text_indexed_at", "NULL"),
            ("text_chunk_count", "0"),
            ("text_embedding_dim", "NULL"),
            ("text_profile_id", "NULL"),
            ("text_generation", "0"),
        ] {
            if unit_columns.contains(column) {
                unit_resets.push(format!("{} = {}", column, value));
            }
        }
        if unit_columns.contains("mm_state") {
            unit_resets.push(if unit_columns.contains("mm_required") {
                "mm_state = CASE WHEN mm_required = 1 THEN 'pending' ELSE 'disabled' END"
                    .to_string()
            } else {
                "mm_state = 'disabled'".to_string()
            });
        }
        for (column, value) in [
            ("mm_error", "NULL"),
            ("mm_indexed_at", "NULL"),
            ("mm_embedding_dim", "NULL"),
            ("mm_profile_id", "NULL"),
            ("mm_generation", "0"),
        ] {
            if unit_columns.contains(column) {
                unit_resets.push(format!("{} = {}", column, value));
            }
        }
        if !unit_resets.is_empty() {
            tx.execute(
                &format!("UPDATE vfs_index_units SET {}", unit_resets.join(", ")),
                [],
            )?;
        }

        let mut dim_resets: Vec<String> = Vec::new();
        if dim_columns.contains("record_count") {
            dim_resets.push("record_count = 0".to_string());
        }
        if dim_columns.contains("last_used_at") && dim_columns.contains("created_at") {
            dim_resets.push("last_used_at = created_at".to_string());
        }
        if dim_columns.contains("active_generation") {
            dim_resets.push("active_generation = 0".to_string());
        }
        if dim_columns.contains("ann_metric") {
            dim_resets.push("ann_metric = 'exact'".to_string());
        }
        if dim_columns.contains("ann_index_version") {
            dim_resets.push("ann_index_version = 0".to_string());
        }
        if !dim_resets.is_empty() {
            tx.execute(
                &format!("UPDATE vfs_embedding_dims SET {}", dim_resets.join(", ")),
                [],
            )?;
        }
        let mut profile_resets: Vec<String> = Vec::new();
        if profile_columns.contains("active_generation") {
            profile_resets.push("active_generation = 0".to_string());
        }
        if profile_columns.contains("ann_metric") {
            profile_resets.push("ann_metric = 'exact'".to_string());
        }
        if profile_columns.contains("ann_index_version") {
            profile_resets.push("ann_index_version = 0".to_string());
        }
        if profile_columns.contains("state") {
            if dim_columns.contains("active_profile_id") {
                profile_resets.push(
                    "state = CASE
                        WHEN id IN (SELECT active_profile_id FROM vfs_embedding_dims
                                    WHERE active_profile_id IS NOT NULL)
                        THEN 'active' ELSE 'retired' END"
                        .to_string(),
                );
            } else {
                profile_resets.push("state = 'retired'".to_string());
            }
        }
        if !profile_resets.is_empty() {
            tx.execute(
                &format!(
                    "UPDATE vfs_index_profiles SET {}",
                    profile_resets.join(", ")
                ),
                [],
            )?;
        }

        let mut resource_resets: Vec<String> = Vec::new();
        if resource_columns.contains("index_state") {
            resource_resets.push(
                "index_state = CASE WHEN index_state = 'disabled' THEN 'disabled' ELSE 'pending' END"
                    .to_string(),
            );
        }
        for (column, value) in [
            ("index_hash", "NULL"),
            ("index_error", "NULL"),
            ("indexed_at", "NULL"),
            ("index_retry_count", "0"),
            ("index_next_retry_at", "0"),
            ("index_generation", "0"),
        ] {
            if resource_columns.contains(column) {
                resource_resets.push(format!("{} = {}", column, value));
            }
        }
        if resource_columns.contains("mm_index_state") {
            resource_resets.push(
                "mm_index_state = CASE
                    WHEN mm_index_state IS NULL THEN NULL
                    WHEN mm_index_state = 'disabled' THEN 'disabled'
                    ELSE 'pending' END"
                    .to_string(),
            );
        }
        for (column, value) in [
            ("mm_index_error", "NULL"),
            ("mm_indexed_at", "NULL"),
            ("mm_embedding_dim", "NULL"),
            ("mm_indexing_mode", "NULL"),
            ("mm_indexed_pages_json", "NULL"),
            ("mm_index_retry_count", "0"),
            ("mm_index_next_retry_at", "0"),
            ("mm_index_generation", "0"),
        ] {
            if resource_columns.contains(column) {
                resource_resets.push(format!("{} = {}", column, value));
            }
        }
        if !resource_resets.is_empty() {
            tx.execute(
                &format!("UPDATE resources SET {}", resource_resets.join(", ")),
                [],
            )?;
        }

        for (table_name, columns) in [("files", &file_columns), ("exam_sheets", &exam_columns)] {
            let mut resets: Vec<String> = Vec::new();
            if columns.contains("mm_index_state") {
                resets.push(
                    "mm_index_state = CASE
                        WHEN mm_index_state IS NULL THEN NULL
                        WHEN mm_index_state = 'disabled' THEN 'disabled'
                        ELSE 'pending' END"
                        .to_string(),
                );
            }
            for column in [
                "mm_index_error",
                "mm_indexed_pages_json",
                "mm_embedding_dim",
                "mm_indexing_mode",
                "mm_indexed_at",
            ] {
                if columns.contains(column) {
                    resets.push(format!("{} = NULL", column));
                }
            }
            if !resets.is_empty() {
                tx.execute(
                    &format!("UPDATE {} SET {}", table_name, resets.join(", ")),
                    [],
                )?;
            }
        }
        if !orphan_columns.is_empty() {
            tx.execute("DELETE FROM __lance_orphan_queue", [])?;
        }
        tx.commit()?;
        info!(
            "[Restore] VFS 派生向量索引未随备份完整恢复，已重置账本并等待本机重建: {}",
            db_path.display()
        );
        Ok(())
    }

    fn has_complete_vfs_lance_component(manifest: &BackupManifest, restore_assets: bool) -> bool {
        const LANCE_COMPONENT: &str = "rebuildable-root:databases/lance/vfs";
        restore_assets
            && manifest
                .included_components
                .iter()
                .any(|component| component == LANCE_COMPONENT)
    }

    pub(crate) fn prepare_vfs_index_restore(
        manifest: &BackupManifest,
        target_dir: &Path,
        restore_assets: bool,
    ) -> Result<(), BackupError> {
        let has_complete_lance = Self::has_complete_vfs_lance_component(manifest, restore_assets);

        let lance_dir = target_dir.join("databases").join("lance").join("vfs");
        if lance_dir.exists() {
            fs::remove_dir_all(&lance_dir)?;
        }
        if has_complete_lance {
            fs::create_dir_all(&lance_dir)?;
            Ok(())
        } else {
            Self::reset_rebuildable_vfs_index(target_dir)
        }
    }

    pub(crate) fn finalize_vfs_index_restore(
        manifest: &BackupManifest,
        target_dir: &Path,
        restore_assets: bool,
    ) -> Result<(), BackupError> {
        if Self::has_complete_vfs_lance_component(manifest, restore_assets) {
            return Ok(());
        }

        // Generic manifest restoration may have copied files from a legacy or
        // partial Lance component after the pre-restore reset. Remove those
        // files again so the reset SQLite manifest cannot expose stale rows.
        Self::reset_rebuildable_vfs_index(target_dir)
    }

    /// 创建一个新的、不会与现有备份冲突的备份子目录
    ///
    /// 关键保证：
    /// - `backup_id` **必须** 与目录名一致（否则删除/验证/恢复会失效）
    /// - 使用 `create_dir` 而不是 `create_dir_all`，避免“目录已存在但继续写入”导致的覆盖风险
    fn create_unique_backup_subdir(
        &self,
        suffix: Option<&str>,
    ) -> Result<(String, PathBuf), BackupError> {
        // 确保根目录存在
        if !self.backup_dir.exists() {
            fs::create_dir_all(&self.backup_dir)?;
        }

        for _ in 0..10 {
            let backup_id = generate_backup_id(suffix);
            let backup_subdir = self.backup_dir.join(&backup_id);

            match fs::create_dir(&backup_subdir) {
                Ok(()) => return Ok((backup_id, backup_subdir)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(BackupError::Io(e)),
            }
        }

        Err(BackupError::BackupDirectory(
            "无法生成唯一备份目录（多次尝试均冲突）".to_string(),
        ))
    }

    /// 获取数据库文件路径
    ///
    /// `app_data_dir` may be either the Tauri data root or an already-resolved
    /// active slot; both command call patterns resolve to the same database.
    pub(crate) fn get_database_path(&self, id: &DatabaseId) -> PathBuf {
        let active_dir = if self
            .app_data_dir
            .parent()
            .and_then(|path| path.file_name())
            .is_some_and(|name| name == std::ffi::OsStr::new("slots"))
        {
            self.app_data_dir.clone()
        } else {
            crate::data_space::get_data_space_manager()
                .map(|mgr| mgr.active_dir())
                .unwrap_or_else(|| self.app_data_dir.join("slots").join("slotA"))
        };

        Self::resolve_database_path_in_dir(&active_dir, id)
    }

    /// 在指定目录下解析数据库文件路径（不依赖 active slot）
    ///
    /// 用于恢复到非活跃插槽等场景。
    pub(crate) fn resolve_database_path_in_dir(base_dir: &Path, id: &DatabaseId) -> PathBuf {
        match id {
            // VFS 数据库在 databases 子目录
            DatabaseId::Vfs => base_dir.join("databases").join("vfs.db"),
            // ChatV2 数据库直接在空间根目录
            DatabaseId::ChatV2 => base_dir.join("chat_v2.db"),
            // Mistakes 数据库直接在空间根目录
            DatabaseId::Mistakes => base_dir.join("mistakes.db"),
            // LLM Usage 数据库直接在空间根目录
            DatabaseId::LlmUsage => base_dir.join("llm_usage.db"),
        }
    }

    /// 获取备份中的数据库文件路径
    pub(crate) fn get_backup_database_path(&self, backup_dir: &Path, id: &DatabaseId) -> PathBuf {
        backup_dir.join(format!("{}.db", id.as_str()))
    }

    fn active_data_dir_for_backup(&self) -> PathBuf {
        if self
            .app_data_dir
            .parent()
            .and_then(|path| path.file_name())
            .is_some_and(|name| name == std::ffi::OsStr::new("slots"))
        {
            self.app_data_dir.clone()
        } else {
            crate::data_space::get_data_space_manager()
                .map(|manager| manager.active_dir())
                .unwrap_or_else(|| self.app_data_dir.join("slots").join("slotA"))
        }
    }

    /// Resolve application-root data when a command caller passed an active
    /// slot (`.../slots/slotA`) into `set_app_data_dir`.
    ///
    /// Slot databases/assets are resolved separately through
    /// `active_data_dir_for_backup`; crypto material and audit.db are rooted at
    /// the application data directory and must not silently disappear merely
    /// because the caller supplied the slot path.
    fn application_data_root(&self) -> PathBuf {
        let Some(slots_dir) = self.app_data_dir.parent() else {
            return self.app_data_dir.clone();
        };
        if slots_dir
            .file_name()
            .is_some_and(|name| name == std::ffi::OsStr::new("slots"))
        {
            return slots_dir
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| self.app_data_dir.clone());
        }
        self.app_data_dir.clone()
    }

    fn publish_verified_manifest(
        &self,
        manifest: &BackupManifest,
        backup_subdir: &Path,
    ) -> Result<(), BackupError> {
        manifest.validate_untrusted()?;
        if manifest.snapshot_kind == SnapshotKind::Full {
            manifest.validate_for_slot_restore()?;
        } else {
            manifest.validate_coverage_ledger(false)?;
        }

        let manifest_path = backup_subdir.join(MANIFEST_FILENAME);
        manifest.save_to_file(&manifest_path)?;
        if let Err(error) = self.verify_internal(manifest, backup_subdir) {
            // A directory is discoverable as a backup only once its manifest
            // exists. Remove it on failed self-verification so a partial or
            // corrupt package cannot be published.
            let _ = fs::remove_file(&manifest_path);
            return Err(error);
        }
        Ok(())
    }

    fn backup_file_metadata(
        backup_subdir: &Path,
        relative_path: &str,
    ) -> Result<BackupFile, BackupError> {
        let path = resolve_existing_backup_file(backup_subdir, Path::new(relative_path))?;
        let size = fs::metadata(&path)?.len();
        Ok(BackupFile {
            path: relative_path.replace('\\', "/"),
            size,
            sha256: calculate_file_sha256_exact(&path, size)?,
            database_id: None,
        })
    }

    fn collect_backup_files_under(
        backup_subdir: &Path,
        relative_root: &str,
    ) -> Result<Vec<BackupFile>, BackupError> {
        let root = backup_subdir.join(relative_root);
        match fs::symlink_metadata(&root) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(BackupError::Manifest(format!(
                    "备份域根必须是普通目录: {}",
                    relative_root
                )))
            }
            Ok(_) => {}
            Err(error) => return Err(BackupError::Io(error)),
        }
        let mut files = Vec::new();
        for entry in WalkDir::new(&root).follow_links(false) {
            let entry = entry.map_err(|error| {
                BackupError::BackupDirectory(format!(
                    "遍历备份域 {} 失败: {}",
                    relative_root, error
                ))
            })?;
            if entry.depth() == 0 || entry.file_type().is_dir() {
                continue;
            }
            if entry.file_type().is_symlink() || !entry.file_type().is_file() {
                return Err(BackupError::BackupDirectory(format!(
                    "备份域包含非常规文件: {}",
                    entry.path().display()
                )));
            }
            let relative = entry
                .path()
                .strip_prefix(backup_subdir)
                .map_err(|_| BackupError::Manifest("无法计算备份域相对路径".to_string()))?
                .to_string_lossy()
                .replace('\\', "/");
            files.push(Self::backup_file_metadata(backup_subdir, &relative)?);
        }
        files.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(files)
    }

    fn copy_persistent_file(
        source: &Path,
        backup_subdir: &Path,
        archive_path: &str,
    ) -> Result<Option<BackupFile>, BackupError> {
        let metadata = match fs::symlink_metadata(source) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Ok(metadata) => metadata,
            Err(error) => return Err(BackupError::Io(error)),
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(BackupError::BackupDirectory(format!(
                "持久文件必须是普通文件: {}",
                source.display()
            )));
        }
        let destination = backup_subdir.join(archive_path);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        let copied = fs::copy(source, &destination)?;
        if copied != metadata.len() || fs::metadata(&destination)?.len() != metadata.len() {
            return Err(BackupError::BackupDirectory(format!(
                "复制持久文件大小不一致: {}",
                source.display()
            )));
        }
        Ok(Some(Self::backup_file_metadata(
            backup_subdir,
            archive_path,
        )?))
    }

    fn copy_persistent_directory(
        source: &Path,
        backup_subdir: &Path,
        archive_root: &str,
    ) -> Result<Option<Vec<BackupFile>>, BackupError> {
        let metadata = match fs::symlink_metadata(source) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Ok(metadata) => metadata,
            Err(error) => return Err(BackupError::Io(error)),
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(BackupError::BackupDirectory(format!(
                "持久域必须是普通目录: {}",
                source.display()
            )));
        }
        let destination_root = backup_subdir.join(archive_root);
        fs::create_dir_all(&destination_root)?;
        let mut files = Vec::new();
        for entry in WalkDir::new(source).follow_links(false) {
            let entry = entry.map_err(|error| {
                BackupError::BackupDirectory(format!(
                    "遍历持久域 {} 失败: {}",
                    source.display(),
                    error
                ))
            })?;
            if entry.depth() == 0 {
                continue;
            }
            if entry.file_type().is_symlink() {
                return Err(BackupError::BackupDirectory(format!(
                    "持久域不允许符号链接: {}",
                    entry.path().display()
                )));
            }
            let relative = entry
                .path()
                .strip_prefix(source)
                .map_err(|_| BackupError::BackupDirectory("无法计算持久域相对路径".to_string()))?;
            let destination = destination_root.join(relative);
            if entry.file_type().is_dir() {
                fs::create_dir_all(&destination)?;
                continue;
            }
            if !entry.file_type().is_file() {
                return Err(BackupError::BackupDirectory(format!(
                    "持久域包含非常规文件: {}",
                    entry.path().display()
                )));
            }
            let entry_metadata = entry.metadata().map_err(|error| {
                BackupError::BackupDirectory(format!(
                    "读取持久域文件元数据失败 {}: {}",
                    entry.path().display(),
                    error
                ))
            })?;
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent)?;
            }
            let copied = fs::copy(entry.path(), &destination)?;
            if copied != entry_metadata.len()
                || fs::metadata(&destination)?.len() != entry_metadata.len()
            {
                return Err(BackupError::BackupDirectory(format!(
                    "复制持久域文件大小不一致: {}",
                    entry.path().display()
                )));
            }
            let archive_path = destination
                .strip_prefix(backup_subdir)
                .map_err(|_| BackupError::Manifest("无法计算持久域归档路径".to_string()))?
                .to_string_lossy()
                .replace('\\', "/");
            files.push(Self::backup_file_metadata(backup_subdir, &archive_path)?);
        }
        files.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(Some(files))
    }

    fn backup_standalone_persistent_domains(
        &self,
        backup_subdir: &Path,
        manifest: &mut BackupManifest,
    ) -> Result<(), BackupError> {
        let persistent_dir = self.active_data_dir_for_backup();
        for (domain_id, source_name, archive_path) in [
            (
                "webview-settings",
                "webview_settings.json",
                "persistent/webview_settings.json",
            ),
            (
                "custom-grading-modes",
                "custom_grading_modes.json",
                "persistent/custom_grading_modes.json",
            ),
        ] {
            match Self::copy_persistent_file(
                &persistent_dir.join(source_name),
                backup_subdir,
                archive_path,
            )? {
                Some(file) => {
                    let path = file.path.clone();
                    manifest.add_file(file);
                    manifest.record_coverage(
                        domain_id,
                        CoverageStatus::Complete,
                        vec![path],
                        None,
                    )?;
                }
                None => {
                    manifest.record_coverage(domain_id, CoverageStatus::Absent, Vec::new(), None)?
                }
            }
        }

        #[cfg(test)]
        let user_skills = self.app_data_dir.join(".deep-student").join("skills");
        #[cfg(not(test))]
        let user_skills = dirs::home_dir()
            .map(|home| home.join(".deep-student").join("skills"))
            .unwrap_or_else(|| self.app_data_dir.join(".deep-student").join("skills"));
        match Self::copy_persistent_directory(
            &user_skills,
            backup_subdir,
            "persistent/user_skills",
        )? {
            None => {
                manifest.record_coverage("user-skills", CoverageStatus::Absent, Vec::new(), None)?
            }
            Some(files) if files.is_empty() => {
                manifest.record_coverage("user-skills", CoverageStatus::Empty, Vec::new(), None)?
            }
            Some(files) => {
                let paths = files.iter().map(|file| file.path.clone()).collect();
                manifest.files.extend(files);
                manifest.record_coverage(
                    "user-skills",
                    CoverageStatus::Complete,
                    paths,
                    Some(
                        "restored packages remain untrusted until explicit package re-validation"
                            .to_string(),
                    ),
                )?;
            }
        }
        Ok(())
    }

    /// 执行完整备份
    ///
    /// ## 执行步骤
    ///
    /// 1. 创建带时间戳的备份目录
    /// 2. 对每个数据库执行 WAL checkpoint
    /// 3. 使用 SQLite Backup API 复制数据库
    /// 4. 计算每个文件的 SHA256 校验和
    /// 5. 生成并保存清单文件
    ///
    /// ## 返回
    ///
    /// 成功时返回包含所有备份文件信息的 `BackupManifest`
    pub fn backup_full(&self) -> Result<BackupManifest, BackupError> {
        info!("开始执行完整备份");

        // 步骤 1–3.6（建目录/清单/全部数据库/加密密钥/审计库/工作区库）与 backup_with_assets
        // 完全一致，抽到 backup_core 复用（F3）。
        let (manifest, backup_subdir) = self.backup_core()?;

        // 4. 仅在清单、哈希、数据库和加密材料全部自检通过后发布。
        self.publish_verified_manifest(&manifest, &backup_subdir)?;

        info!("备份完成，共 {} 个文件", manifest.files.len());

        Ok(manifest)
    }

    /// 执行包含资产的完整备份
    ///
    /// ## 执行步骤
    ///
    /// 1. 执行数据库备份
    /// 2. 根据配置备份资产文件
    /// 3. 生成包含资产信息的清单
    ///
    /// ## 参数
    ///
    /// - `asset_config`: 资产备份配置（None 表示使用默认配置）
    ///
    /// ## 返回
    ///
    /// 成功时返回包含所有备份文件信息的 `BackupManifest`
    pub fn backup_with_assets(
        &self,
        asset_config: Option<assets::AssetBackupConfig>,
    ) -> Result<BackupManifest, BackupError> {
        info!("开始执行包含资产的完整备份");

        // 步骤 1–3.6 与 backup_full 完全一致，复用 backup_core（F3）。
        let (mut manifest, backup_subdir) = self.backup_core()?;

        // 4. 备份资产文件
        let config = asset_config.unwrap_or_default();
        if !config.asset_types.is_empty() {
            info!("开始备份资产文件: {:?} 种类型", config.asset_types.len());

            // 使用活动数据空间目录扫描资产（与运行时 FileManager 绑定的位置一致）
            let active_asset_dir = self.active_data_dir_for_backup();
            match assets::backup_assets(&active_asset_dir, &backup_subdir, &config) {
                Ok(asset_result) => {
                    info!(
                        "资产备份完成: {} 个文件, {} 字节",
                        asset_result.total_files, asset_result.total_size
                    );
                    manifest.assets = Some(asset_result);
                }
                Err(e) => {
                    error!("资产备份失败: {}", e);
                    return Err(BackupError::RestoreFailed(format!(
                        "资产备份失败，已中止本次备份: {}",
                        e
                    )));
                }
            }
        }

        let active_asset_dir = self.active_data_dir_for_backup();
        let selected_asset_roots = config
            .asset_types
            .iter()
            .map(AssetType::relative_path)
            .collect::<HashSet<_>>();
        let asset_result = manifest.assets.clone();
        for asset_type in AssetType::all() {
            let root = asset_type.relative_path();
            let domain_id = format!("asset-root:{}", root);
            if !selected_asset_roots.contains(root) {
                manifest.record_coverage(
                    &domain_id,
                    CoverageStatus::Excluded,
                    Vec::new(),
                    Some("asset type was not selected".to_string()),
                )?;
                continue;
            }
            let paths = asset_result
                .as_ref()
                .into_iter()
                .flat_map(|result| result.files.iter())
                .filter(|asset| asset.asset_type == asset_type && !asset.is_directory)
                .map(|asset| asset.relative_path.clone())
                .collect::<Vec<_>>();
            let checksum_complete = config.compute_checksum
                && asset_result.as_ref().is_some_and(|result| {
                    result
                        .files
                        .iter()
                        .filter(|asset| asset.asset_type == asset_type && !asset.is_directory)
                        .all(|asset| {
                            asset.checksum.as_ref().is_some_and(|checksum| {
                                checksum.len() == 64
                                    && checksum.bytes().all(|byte| byte.is_ascii_hexdigit())
                            })
                        })
                });
            let domain_incomplete = asset_result
                .as_ref()
                .is_some_and(|result| result.incomplete_asset_types.contains(&asset_type));
            let status = if domain_incomplete || !checksum_complete {
                CoverageStatus::Failed
            } else if !paths.is_empty() {
                CoverageStatus::Complete
            } else {
                match fs::symlink_metadata(active_asset_dir.join(root)) {
                    Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                        CoverageStatus::Empty
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        CoverageStatus::Absent
                    }
                    Ok(_) => CoverageStatus::Failed,
                    Err(error) => {
                        return Err(BackupError::BackupDirectory(format!(
                            "无法检查资产域 {}: {}",
                            root, error
                        )))
                    }
                }
            };
            manifest.record_coverage(
                &domain_id,
                status,
                paths,
                (status == CoverageStatus::Failed)
                    .then(|| "asset filtering or checksum evidence was incomplete".to_string()),
            )?;
        }

        let agents_source = active_asset_dir.join("workspaces").join("agents");
        if selected_asset_roots.contains("workspaces") {
            let agent_paths = asset_result
                .as_ref()
                .into_iter()
                .flat_map(|result| result.files.iter())
                .filter(|asset| {
                    !asset.is_directory && asset.original_path.starts_with("workspaces/agents/")
                })
                .map(|asset| asset.relative_path.clone())
                .collect::<Vec<_>>();
            let workspaces_status = manifest
                .coverage
                .as_ref()
                .and_then(|ledger| ledger.domains.get("asset-root:workspaces"))
                .map(|entry| entry.status)
                .unwrap_or(CoverageStatus::Failed);
            let status = if workspaces_status == CoverageStatus::Failed {
                CoverageStatus::Failed
            } else if !agent_paths.is_empty() {
                CoverageStatus::Complete
            } else {
                match fs::symlink_metadata(&agents_source) {
                    Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                        CoverageStatus::Empty
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        CoverageStatus::Absent
                    }
                    Ok(_) => CoverageStatus::Failed,
                    Err(error) => return Err(BackupError::Io(error)),
                }
            };
            manifest.record_coverage(
                "agents",
                status,
                agent_paths,
                Some(
                    "restored agent definitions remain untrusted until explicit review".to_string(),
                ),
            )?;
        } else {
            manifest.record_coverage(
                "agents",
                CoverageStatus::Excluded,
                Vec::new(),
                Some("workspaces assets were not selected".to_string()),
            )?;
        }

        if manifest.mark_full().is_err() {
            manifest.mark_partial();
        }

        // 5. 仅在清单及全部文件自检通过后发布。
        self.publish_verified_manifest(&manifest, &backup_subdir)?;

        let asset_files = manifest.assets.as_ref().map(|a| a.total_files).unwrap_or(0);
        info!(
            "备份完成: {} 个数据库文件, {} 个资产文件",
            manifest.files.len(),
            asset_files
        );

        Ok(manifest)
    }

    /// F3：backup_full 与 backup_with_assets 的公共前半段（步骤 1–3.6）。
    ///
    /// 建备份目录 → 建清单 → 备份全部核心数据库 → 加密密钥 → 审计库 → 工作区库。
    /// 返回 `(manifest, backup_subdir)`，调用方据此继续追加资产或直接保存清单。
    /// 行为与原内联实现逐字一致（仅抽取，不改语义）。
    fn backup_core(&self) -> Result<(BackupManifest, std::path::PathBuf), BackupError> {
        // 1. 创建备份目录
        let (backup_id, backup_subdir) = self.create_unique_backup_subdir(None)?;

        info!("备份目录: {:?}", backup_subdir);

        // 2. 创建清单
        let mut manifest = BackupManifest::new(&self.app_version);
        manifest.backup_id = backup_id;

        // 3. 备份所有数据库
        let all_dbs = DatabaseId::all_ordered();
        let total = all_dbs.len();
        for (idx, db_id) in all_dbs.into_iter().enumerate() {
            let db_path = self.get_database_path(&db_id);

            // `exists()` 会把权限/IO 错误折叠成 false；核心域必须区分
            // absent、非常规条目与真实读取错误。
            match fs::symlink_metadata(&db_path) {
                Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_file() => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Err(BackupError::FileNotFound(format!(
                        "完整备份缺少核心数据库 {}: {}",
                        db_id.as_str(),
                        db_path.display()
                    )))
                }
                Ok(_) => {
                    return Err(BackupError::BackupDirectory(format!(
                        "核心数据库必须是普通文件 {}: {}",
                        db_id.as_str(),
                        db_path.display()
                    )))
                }
                Err(error) => return Err(BackupError::Io(error)),
            }

            // 发送进度回调
            if let Some(ref cb) = self.progress_callback {
                cb(idx, total, db_id.as_str(), 0, 0);
            }

            info!("备份数据库: {:?} -> {:?}", db_id, db_path);

            // 备份单个数据库
            let backup_file =
                self.backup_single_database(&db_id, &db_path, &backup_subdir, idx, total)?;
            let backup_path = backup_file.path.clone();
            manifest.add_file(backup_file);
            manifest.record_coverage(
                &format!("database:{}", db_id.as_str()),
                CoverageStatus::Complete,
                vec![backup_path],
                None,
            )?;

            // 获取 schema 版本
            let version = self.get_schema_version(&db_path)?;
            manifest.set_schema_version(db_id.as_str(), version);
        }

        // 3.5 备份加密密钥（跨设备恢复支持）
        let crypto_count = self.backup_crypto_keys(&backup_subdir)?;
        manifest.key_policy = if crypto_count > 0 {
            info!("加密密钥备份完成: {} 个文件", crypto_count);
            BackupKeyPolicy::IncludedLocal
        } else {
            BackupKeyPolicy::NotPresent
        };
        let crypto_files = Self::collect_backup_files_under(&backup_subdir, "crypto")?;
        if crypto_files.is_empty() {
            let status = match fs::symlink_metadata(backup_subdir.join("crypto")) {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                    CoverageStatus::Empty
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    CoverageStatus::Absent
                }
                Ok(_) => {
                    return Err(BackupError::BackupDirectory(
                        "crypto 归档根不是普通目录".to_string(),
                    ))
                }
                Err(error) => return Err(BackupError::Io(error)),
            };
            manifest.record_coverage("crypto", status, Vec::new(), None)?;
        } else {
            let paths = crypto_files.iter().map(|file| file.path.clone()).collect();
            manifest.files.extend(crypto_files);
            manifest.record_coverage("crypto", CoverageStatus::Complete, paths, None)?;
        }

        // 3.5b 审计库是受清单保护的辅助数据库；存在时任何复制或完整性
        // 错误都会阻止完整备份发布。
        if self.backup_audit_db(&backup_subdir)? {
            let audit_file = Self::backup_file_metadata(&backup_subdir, "databases/audit.db")?;
            let path = audit_file.path.clone();
            manifest.add_file(audit_file);
            manifest.record_coverage("audit", CoverageStatus::Complete, vec![path], None)?;
            info!("审计数据库备份完成");
        } else {
            manifest.record_coverage("audit", CoverageStatus::Absent, Vec::new(), None)?;
            debug!("审计数据库不存在，记录 absent");
        }

        // 3.6 备份工作区数据库（ws_*.db）
        let active_dir_for_ws = self.active_data_dir_for_backup();
        let workspace_files =
            self.backup_workspace_databases(&active_dir_for_ws, &backup_subdir)?;
        if !workspace_files.is_empty() {
            info!("工作区数据库备份完成: {} 个", workspace_files.len());
        }
        let workspace_paths = workspace_files
            .iter()
            .map(|file| file.path.clone())
            .collect::<Vec<_>>();
        manifest.files.extend(workspace_files);
        let workspaces_root = active_dir_for_ws.join("workspaces");
        let workspace_status = if !workspace_paths.is_empty() {
            CoverageStatus::Complete
        } else {
            match fs::symlink_metadata(&workspaces_root) {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                    CoverageStatus::Empty
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    CoverageStatus::Absent
                }
                Ok(_) => {
                    return Err(BackupError::BackupDirectory(format!(
                        "工作区数据库根不是普通目录: {}",
                        workspaces_root.display()
                    )))
                }
                Err(error) => return Err(BackupError::Io(error)),
            }
        };
        manifest.record_coverage("workspaces-root", workspace_status, workspace_paths, None)?;
        self.backup_standalone_persistent_domains(&backup_subdir, &mut manifest)?;
        manifest.mark_partial();

        Ok((manifest, backup_subdir))
    }

    /// 备份加密密钥文件到备份目录
    ///
    /// 包含 `.master_key`（CryptoService 主密钥）和 `.secure/` 目录（SecureStore 密钥种子 + 加密凭据）。
    /// 这些文件在跨设备恢复时必须一并还原，否则 API 密钥将无法解密。
    pub fn backup_crypto_keys(&self, backup_subdir: &Path) -> Result<usize, BackupError> {
        let app_data_root = self.application_data_root();
        let master_key_path = app_data_root.join(".master_key");
        let secure_dir = app_data_root.join(".secure");

        let has_master_key = match fs::symlink_metadata(&master_key_path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                return Err(BackupError::RestoreFailed(
                    "应用主密钥路径不是普通文件，拒绝跟随符号链接备份".to_string(),
                ))
            }
            Ok(_) => true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => return Err(BackupError::Io(e)),
        };
        let has_secure_dir = match fs::symlink_metadata(&secure_dir) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(BackupError::RestoreFailed(
                    "应用安全存储路径不是普通目录，拒绝跟随符号链接备份".to_string(),
                ))
            }
            Ok(_) => true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => return Err(BackupError::Io(e)),
        };

        // 无加密文件时跳过，避免创建空目录
        if !has_master_key && !has_secure_dir {
            return Ok(0);
        }

        let crypto_dest = backup_subdir.join("crypto");
        fs::create_dir_all(&crypto_dest)?;

        let mut count = 0;

        // 1. 备份 .master_key
        if has_master_key {
            let dest = crypto_dest.join(".master_key");
            copy_crypto_file_to_staging(&master_key_path, &dest, MAX_BACKUP_MASTER_KEY_BYTES)
                .map_err(|e| BackupError::RestoreFailed(format!("备份 .master_key 失败: {}", e)))?;
            validate_staged_master_key(&dest)?;
            count += 1;
            info!("[Backup] 已备份 .master_key");
        }

        // 2. 备份 .secure/ 目录（.key_seed + *.enc）
        if has_secure_dir {
            let secure_dest = crypto_dest.join(".secure");
            fs::create_dir_all(&secure_dest)?;

            let mut secure_count = 0usize;
            let mut secure_total = 0u64;
            for entry in fs::read_dir(&secure_dir)? {
                let entry = entry?;
                let path = entry.path();
                let file_type = entry.file_type()?;
                if file_type.is_symlink() {
                    return Err(BackupError::RestoreFailed(format!(
                        "安全存储包含符号链接，拒绝备份: {}",
                        path.display()
                    )));
                }
                if file_type.is_file() {
                    let file_name = path.file_name().ok_or_else(|| {
                        BackupError::BackupDirectory(format!(
                            "安全存储文件缺少名称: {}",
                            path.display()
                        ))
                    })?;
                    // OAuth refresh tokens are device-local sessions, not portable user data.
                    // Restoring them on another machine can race token rotation and invalidate
                    // both installations, so never include this encrypted entry in backups.
                    if file_name == "internal.oauth.openai_codex.session.enc" {
                        info!("[Backup] 已跳过设备本地 Codex OAuth 会话");
                        continue;
                    }
                    let is_seed = file_name == std::ffi::OsStr::new(".key_seed");
                    let is_encrypted = Path::new(file_name)
                        .extension()
                        .is_some_and(|extension| extension.eq_ignore_ascii_case("enc"));
                    if !is_seed && !is_encrypted {
                        return Err(BackupError::BackupDirectory(format!(
                            "安全存储包含未识别文件，拒绝声明完整 crypto 覆盖: {}",
                            path.display()
                        )));
                    }
                    secure_count = secure_count.saturating_add(1);
                    if secure_count > MAX_BACKUP_SECURE_FILES {
                        return Err(BackupError::BackupDirectory(format!(
                            "安全存储文件数超限: {}",
                            secure_count
                        )));
                    }
                    let dest = secure_dest.join(file_name);
                    let copied =
                        copy_crypto_file_to_staging(&path, &dest, MAX_BACKUP_SECURE_FILE_BYTES)
                            .map_err(|e| {
                                BackupError::RestoreFailed(format!(
                                    "备份 .secure/{} 失败: {}",
                                    file_name.to_string_lossy(),
                                    e
                                ))
                            })?;
                    secure_total = secure_total.checked_add(copied).ok_or_else(|| {
                        BackupError::BackupDirectory("安全存储总大小溢出".to_string())
                    })?;
                    if secure_total > MAX_BACKUP_SECURE_TOTAL_BYTES {
                        return Err(BackupError::BackupDirectory(format!(
                            "安全存储总大小超限: {} bytes",
                            secure_total
                        )));
                    }
                } else {
                    return Err(BackupError::RestoreFailed(format!(
                        "安全存储包含非常规条目，拒绝备份: {}",
                        path.display()
                    )));
                }
            }
            count += secure_count;
            info!("[Backup] 已备份 .secure/ 目录: {} 个文件", secure_count);
        }

        Ok(count)
    }

    fn verify_crypto_material(
        manifest: &BackupManifest,
        backup_subdir: &Path,
    ) -> Result<(), BackupError> {
        if manifest.key_policy != BackupKeyPolicy::IncludedLocal {
            return Ok(());
        }
        let coverage = manifest
            .coverage
            .as_ref()
            .and_then(|ledger| ledger.domains.get("crypto"))
            .ok_or_else(|| {
                BackupError::Manifest("密钥策略声明 included_local 但缺少 crypto 覆盖".to_string())
            })?;
        if coverage.status != CoverageStatus::Complete {
            return Err(BackupError::Manifest(
                "密钥策略声明 included_local 但 crypto 域不完整".to_string(),
            ));
        }

        for relative in &coverage.paths {
            let allowed = relative == "crypto/.master_key"
                || relative == "crypto/.secure/.key_seed"
                || (relative.starts_with("crypto/.secure/")
                    && Path::new(relative)
                        .extension()
                        .is_some_and(|extension| extension.eq_ignore_ascii_case("enc")));
            if !allowed {
                return Err(BackupError::Manifest(format!(
                    "crypto 域包含未识别文件: {}",
                    relative
                )));
            }
        }

        let master = backup_subdir.join("crypto/.master_key");
        if coverage
            .paths
            .iter()
            .any(|path| path == "crypto/.master_key")
        {
            validate_staged_master_key(&master)
                .map_err(|error| BackupError::Manifest(format!("主密钥验证失败: {}", error)))?;
        }

        let has_seed = coverage
            .paths
            .iter()
            .any(|path| path == "crypto/.secure/.key_seed");
        let encrypted_paths = coverage
            .paths
            .iter()
            .filter(|path| {
                path.starts_with("crypto/.secure/")
                    && Path::new(path)
                        .extension()
                        .is_some_and(|extension| extension.eq_ignore_ascii_case("enc"))
            })
            .cloned()
            .collect::<Vec<_>>();
        if has_seed {
            let seed = backup_subdir.join("crypto/.secure/.key_seed");
            crate::secure_store::SecureStore::validate_backup_seed_file(&seed).map_err(
                |error| BackupError::Manifest(format!("安全存储种子不可用于恢复: {}", error)),
            )?;
        }
        if encrypted_paths.is_empty() {
            return Ok(());
        }
        if !has_seed {
            return Err(BackupError::Manifest(
                "crypto 域包含加密凭据但缺少 .key_seed".to_string(),
            ));
        }
        let seed = backup_subdir.join("crypto/.secure/.key_seed");

        // Validate every encrypted credential in an isolated copy. SecureStore
        // may migrate seed representation; it must never mutate the backup that
        // was just hashed.
        let sandbox = tempfile::TempDir::new()?;
        let sandbox_secure = sandbox.path().join(".secure");
        fs::create_dir_all(&sandbox_secure)?;
        fs::copy(&seed, sandbox_secure.join(".key_seed"))?;
        for relative in &encrypted_paths {
            let source = resolve_existing_backup_file(backup_subdir, Path::new(relative))?;
            let file_name = source.file_name().ok_or_else(|| {
                BackupError::Manifest(format!("加密凭据路径缺少文件名: {}", relative))
            })?;
            fs::copy(&source, sandbox_secure.join(file_name))?;
        }
        let store = crate::secure_store::SecureStore::new_with_dir(
            crate::secure_store::SecureStoreConfig::default(),
            sandbox.path().to_path_buf(),
        );
        for relative in encrypted_paths {
            let key = Path::new(&relative)
                .file_stem()
                .and_then(|value| value.to_str())
                .ok_or_else(|| {
                    BackupError::Manifest(format!("加密凭据文件名不是有效 UTF-8: {}", relative))
                })?;
            match store.get_secret(key) {
                Ok(Some(_)) => {}
                Ok(None) => {
                    return Err(BackupError::Manifest(format!(
                        "加密凭据验证时消失: {}",
                        relative
                    )))
                }
                Err(error) => {
                    return Err(BackupError::Manifest(format!(
                        "加密凭据无法实际解密 {}: {}",
                        relative, error
                    )))
                }
            }
        }
        Ok(())
    }

    pub fn restore_crypto_keys_from_manifest(
        &self,
        manifest: &BackupManifest,
        backup_subdir: &Path,
    ) -> Result<usize, BackupError> {
        let plan = manifest
            .crypto_restore_plan()
            .ok_or_else(|| BackupError::Manifest("备份缺少 crypto restore plan".to_string()))?;
        let actual_files = Self::collect_backup_files_under(backup_subdir, "crypto")?;
        if matches!(plan.status, CoverageStatus::Absent | CoverageStatus::Empty) {
            if actual_files.is_empty() {
                return Ok(0);
            }
            return Err(BackupError::Manifest(
                "crypto restore plan 声明无文件，但归档包含加密材料".to_string(),
            ));
        }
        if plan.status != CoverageStatus::Complete
            || manifest.key_policy != BackupKeyPolicy::IncludedLocal
            || plan.files.len() != actual_files.len()
        {
            return Err(BackupError::Manifest(
                "crypto restore plan 不可执行或文件集合不完整".to_string(),
            ));
        }
        for actual in &actual_files {
            let declared = plan
                .files
                .iter()
                .find(|file| file.path == actual.path)
                .ok_or_else(|| {
                    BackupError::Manifest(format!("crypto 归档包含未声明文件: {}", actual.path))
                })?;
            if declared.size != actual.size
                || declared.sha256.as_deref() != Some(actual.sha256.as_str())
            {
                return Err(BackupError::Manifest(format!(
                    "crypto restore plan 元数据不匹配: {}",
                    actual.path
                )));
            }
        }
        Self::verify_crypto_material(manifest, backup_subdir)?;
        self.restore_crypto_keys(backup_subdir)
    }

    /// 从备份目录恢复加密密钥文件到应用数据目录
    ///
    /// 恢复 `.master_key` 和 `.secure/` 目录，使跨设备恢复后 API 密钥可正常解密。
    /// 仅在备份中包含 crypto/ 子目录时执行。
    pub fn restore_crypto_keys(&self, backup_subdir: &Path) -> Result<usize, BackupError> {
        let backup_metadata = fs::symlink_metadata(backup_subdir).map_err(|e| {
            BackupError::RestoreFailed(format!("无法检查备份目录，目标密钥保持不变: {}", e))
        })?;
        if backup_metadata.file_type().is_symlink() || !backup_metadata.is_dir() {
            return Err(BackupError::RestoreFailed(
                "备份目录必须是普通目录，目标密钥保持不变".to_string(),
            ));
        }

        let crypto_src = backup_subdir.join("crypto");
        match fs::symlink_metadata(&crypto_src) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_dir() => {}
            Ok(_) => {
                return Err(BackupError::RestoreFailed(
                    "备份加密密钥路径必须是普通目录，目标密钥保持不变".to_string(),
                ))
            }
            Err(e) => {
                return Err(BackupError::RestoreFailed(format!(
                    "无法检查备份加密密钥目录，目标密钥保持不变: {}",
                    e
                )))
            }
        }

        fs::create_dir_all(&self.app_data_dir)?;
        let staging = tempfile::Builder::new()
            .prefix("crypto-restore-staging-")
            .tempdir_in(&self.app_data_dir)
            .map_err(|e| BackupError::RestoreFailed(format!("创建密钥暂存目录失败: {}", e)))?;
        let staged_crypto = staging.path().join("crypto");
        fs::create_dir(&staged_crypto)?;
        crate::secure_store::SecureStore::restrict_permissions(&staged_crypto, true);

        let source_master = crypto_src.join(".master_key");
        let staged_master = staged_crypto.join(".master_key");
        let has_master = match fs::symlink_metadata(&source_master) {
            Ok(_) => {
                copy_crypto_file_to_staging(
                    &source_master,
                    &staged_master,
                    MAX_BACKUP_MASTER_KEY_BYTES,
                )?;
                validate_staged_master_key(&staged_master).map_err(|e| {
                    BackupError::RestoreFailed(format!("备份主密钥无效，目标密钥保持不变: {}", e))
                })?;
                true
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => {
                return Err(BackupError::RestoreFailed(format!(
                    "无法检查备份主密钥，目标密钥保持不变: {}",
                    e
                )))
            }
        };

        let source_secure = crypto_src.join(".secure");
        let staged_secure = staged_crypto.join(".secure");
        let mut secure_file_count = 0usize;
        let mut secure_total_bytes = 0u64;
        let mut has_seed = false;
        let mut encrypted_file_count = 0usize;
        let has_secure = match fs::symlink_metadata(&source_secure) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(BackupError::RestoreFailed(
                    "备份安全存储路径必须是普通目录，目标密钥保持不变".to_string(),
                ))
            }
            Ok(_) => {
                fs::create_dir(&staged_secure)?;
                crate::secure_store::SecureStore::restrict_permissions(&staged_secure, true);
                for entry in fs::read_dir(&source_secure).map_err(|e| {
                    BackupError::RestoreFailed(format!(
                        "无法读取备份安全存储目录，目标密钥保持不变: {}",
                        e
                    ))
                })? {
                    let entry = entry.map_err(|e| {
                        BackupError::RestoreFailed(format!(
                            "无法读取备份安全存储条目，目标密钥保持不变: {}",
                            e
                        ))
                    })?;
                    let file_type = entry.file_type()?;
                    if file_type.is_symlink() || !file_type.is_file() {
                        return Err(BackupError::RestoreFailed(format!(
                            "备份安全存储条目必须是普通文件，目标密钥保持不变: {}",
                            entry.path().display()
                        )));
                    }
                    secure_file_count = secure_file_count.saturating_add(1);
                    if secure_file_count > MAX_BACKUP_SECURE_FILES {
                        return Err(BackupError::RestoreFailed(format!(
                            "备份安全存储文件数超限，目标密钥保持不变: {}",
                            secure_file_count
                        )));
                    }
                    let file_name = entry.file_name();
                    let staged_file = staged_secure.join(&file_name);
                    let copied = copy_crypto_file_to_staging(
                        &entry.path(),
                        &staged_file,
                        MAX_BACKUP_SECURE_FILE_BYTES,
                    )?;
                    secure_total_bytes =
                        secure_total_bytes.checked_add(copied).ok_or_else(|| {
                            BackupError::RestoreFailed(
                                "备份安全存储总大小溢出，目标密钥保持不变".to_string(),
                            )
                        })?;
                    if secure_total_bytes > MAX_BACKUP_SECURE_TOTAL_BYTES {
                        return Err(BackupError::RestoreFailed(format!(
                            "备份安全存储总大小超限，目标密钥保持不变: {} bytes",
                            secure_total_bytes
                        )));
                    }
                    if file_name == std::ffi::OsStr::new(".key_seed") {
                        has_seed = true;
                    } else if staged_file
                        .extension()
                        .map(|extension| extension.eq_ignore_ascii_case("enc"))
                        .unwrap_or(false)
                    {
                        encrypted_file_count = encrypted_file_count.saturating_add(1);
                        if copied < 28 {
                            return Err(BackupError::RestoreFailed(format!(
                                "备份加密凭据格式过短，目标密钥保持不变: {}",
                                staged_file.display()
                            )));
                        }
                    }
                }
                true
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => {
                return Err(BackupError::RestoreFailed(format!(
                    "无法检查备份安全存储目录，目标密钥保持不变: {}",
                    e
                )))
            }
        };

        if encrypted_file_count > 0 && !has_seed {
            return Err(BackupError::RestoreFailed(
                "备份含加密凭据但缺少 .key_seed，拒绝与现有密钥混合，目标密钥保持不变".to_string(),
            ));
        }
        if has_seed {
            crate::secure_store::SecureStore::validate_backup_seed_file(
                &staged_secure.join(".key_seed"),
            )
            .map_err(|e| {
                BackupError::RestoreFailed(format!(
                    "备份密钥种子与当前环境不兼容，目标密钥保持不变: {}",
                    e
                ))
            })?;
        }
        if !has_master && !has_secure {
            return Ok(0);
        }

        let pre_restore_root = self.backup_dir.join(PRE_RESTORE_DIR);
        if backup_subdir != pre_restore_root {
            let snapshot_crypto = pre_restore_root.join("crypto");
            remove_crypto_path(&snapshot_crypto).map_err(|e| {
                BackupError::RestoreFailed(format!("清理旧密钥快照失败，目标密钥保持不变: {}", e))
            })?;
            if let Err(e) = self.backup_crypto_keys(&pre_restore_root) {
                let _ = remove_crypto_path(&snapshot_crypto);
                return Err(BackupError::RestoreFailed(format!(
                    "当前密钥快照失败，已中止恢复且目标密钥保持不变: {}",
                    e
                )));
            }
        }

        let app_data_root = self.application_data_root();
        let rollback = tempfile::Builder::new()
            .prefix("crypto-restore-rollback-")
            .tempdir_in(&app_data_root)
            .map_err(|e| BackupError::RestoreFailed(format!("创建密钥回滚目录失败: {}", e)))?;
        let target_master = app_data_root.join(".master_key");
        let target_secure = app_data_root.join(".secure");
        let rollback_master = rollback.path().join(".master_key");
        let rollback_secure = rollback.path().join(".secure");
        let mut moved_master = false;
        let mut moved_secure = false;
        let mut installed_master = false;
        let mut installed_secure = false;

        let commit_result: Result<(), BackupError> = (|| {
            if has_master && fs::symlink_metadata(&target_master).is_ok() {
                fs::rename(&target_master, &rollback_master)?;
                moved_master = true;
            }
            if has_secure && fs::symlink_metadata(&target_secure).is_ok() {
                fs::rename(&target_secure, &rollback_secure)?;
                moved_secure = true;
            }
            if has_master {
                fs::rename(&staged_master, &target_master)?;
                installed_master = true;
            }
            if has_secure {
                fs::rename(&staged_secure, &target_secure)?;
                installed_secure = true;
            }
            Ok(())
        })();

        if let Err(commit_error) = commit_result {
            let mut rollback_errors = Vec::new();
            if installed_master {
                if let Err(e) = remove_crypto_path(&target_master) {
                    rollback_errors.push(format!("删除新主密钥失败: {}", e));
                }
            }
            if installed_secure {
                if let Err(e) = remove_crypto_path(&target_secure) {
                    rollback_errors.push(format!("删除新安全目录失败: {}", e));
                }
            }
            if moved_master {
                if let Err(e) = fs::rename(&rollback_master, &target_master) {
                    rollback_errors.push(format!("恢复旧主密钥失败: {}", e));
                }
            }
            if moved_secure {
                if let Err(e) = fs::rename(&rollback_secure, &target_secure) {
                    rollback_errors.push(format!("恢复旧安全目录失败: {}", e));
                }
            }
            return Err(BackupError::RestoreFailed(if rollback_errors.is_empty() {
                format!("密钥原子提交失败，已恢复原目标: {}", commit_error)
            } else {
                format!(
                    "密钥原子提交失败且回滚不完整: {}; {}",
                    commit_error,
                    rollback_errors.join("; ")
                )
            }));
        }

        if has_master {
            crate::secure_store::SecureStore::restrict_permissions(&target_master, false);
        }
        if has_secure {
            crate::secure_store::SecureStore::restrict_permissions(&target_secure, true);
            for entry in fs::read_dir(&target_secure)? {
                let entry = entry?;
                if entry.file_type()?.is_file() {
                    crate::secure_store::SecureStore::restrict_permissions(&entry.path(), false);
                }
            }
        }

        let restored = usize::from(has_master) + secure_file_count;
        info!("[Restore] 加密密钥原子恢复完成: {} 个文件", restored);
        Ok(restored)
    }

    /// 备份审计数据库到备份目录
    ///
    /// audit.db 作为受清单保护的辅助文件备份。
    /// 使用 SQLite Backup API 确保 WAL 模式下的一致性。
    pub fn backup_audit_db(&self, backup_subdir: &Path) -> Result<bool, BackupError> {
        let audit_src = self
            .application_data_root()
            .join("databases")
            .join("audit.db");
        match fs::symlink_metadata(&audit_src) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                return Err(BackupError::BackupDirectory(format!(
                    "审计数据库必须是普通文件: {}",
                    audit_src.display()
                )))
            }
            Ok(_) => {}
            Err(error) => return Err(BackupError::Io(error)),
        }

        let audit_dest_dir = backup_subdir.join("databases");
        fs::create_dir_all(&audit_dest_dir)?;
        let audit_dest = audit_dest_dir.join("audit.db");

        let src_conn = Connection::open(&audit_src)?;
        src_conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;

        let mut dst_conn = Connection::open(&audit_dest)?;
        {
            let backup = Backup::new(&src_conn, &mut dst_conn)?;
            backup.run_to_completion(50, Duration::from_millis(50), None)?;
        }
        dst_conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
        drop(dst_conn);
        drop(src_conn);
        self.verify_database_integrity(&audit_dest)?;

        info!(
            "[Backup] 已备份 audit.db: {} -> {}",
            audit_src.display(),
            audit_dest.display()
        );
        Ok(true)
    }

    /// 从备份目录恢复审计数据库
    ///
    /// audit.db 恢复失败不阻断主流程（审计日志丢失可接受）。
    pub fn restore_audit_db(&self, backup_subdir: &Path) -> Result<bool, BackupError> {
        let audit_src = backup_subdir.join("databases").join("audit.db");
        if !audit_src.exists() {
            return Ok(false);
        }
        self.verify_database_integrity(&audit_src)?;

        let audit_dest = self
            .application_data_root()
            .join("databases")
            .join("audit.db");
        if let Some(parent) = audit_dest.parent() {
            fs::create_dir_all(parent)?;
        }

        let src_conn = Connection::open(&audit_src)?;
        let mut dst_conn = Connection::open(&audit_dest)?;
        let backup = Backup::new(&src_conn, &mut dst_conn)?;
        backup.run_to_completion(50, Duration::from_millis(50), None)?;

        info!(
            "[Restore] 已恢复 audit.db: {} -> {}",
            audit_src.display(),
            audit_dest.display()
        );
        Ok(true)
    }

    /// Manifest-aware audit restore entry point for slot orchestration.
    pub fn restore_audit_db_from_manifest(
        &self,
        manifest: &BackupManifest,
        backup_subdir: &Path,
    ) -> Result<bool, BackupError> {
        let Some(plan) = manifest.audit_restore_plan() else {
            return Err(BackupError::Manifest(
                "备份缺少 audit restore plan".to_string(),
            ));
        };
        match plan.status {
            CoverageStatus::Absent | CoverageStatus::Empty => return Ok(false),
            CoverageStatus::Complete
                if plan.archive_paths == ["databases/audit.db".to_string()]
                    && plan.files.len() == 1 => {}
            status => {
                return Err(BackupError::Manifest(format!(
                    "audit restore plan 不可执行: {:?}",
                    status
                )))
            }
        }
        let file = &plan.files[0];
        let expected_hash = file
            .sha256
            .as_ref()
            .ok_or_else(|| BackupError::Manifest("audit restore plan 缺少 SHA-256".to_string()))?;
        let source = resolve_existing_backup_file(backup_subdir, Path::new(&file.path))?;
        let actual_size = fs::metadata(&source)?.len();
        let actual_hash = calculate_file_sha256_exact(&source, file.size)?;
        if actual_size != file.size || !actual_hash.eq_ignore_ascii_case(expected_hash) {
            return Err(BackupError::Manifest(
                "audit restore plan 的文件大小或 SHA-256 不匹配".to_string(),
            ));
        }
        self.restore_audit_db(backup_subdir)
    }

    /// 恢复包含资产的备份
    ///
    /// ## 参数
    ///
    /// - `manifest`: 备份清单
    /// - `restore_assets`: 是否恢复资产文件
    ///
    /// ## 返回
    ///
    /// 成功时返回恢复的资产数量
    pub fn restore_with_assets(
        &self,
        manifest: &BackupManifest,
        restore_assets: bool,
    ) -> Result<usize, BackupError> {
        info!(
            "开始恢复备份（含资产）: {}, restore_assets={}",
            manifest.backup_id, restore_assets
        );

        // 0. 版本兼容性检查（与 restore() 保持一致）
        self.check_manifest_compatibility(manifest)?;
        manifest.validate_for_slot_restore()?;

        // 1. 获取备份目录
        let backup_subdir = self.backup_dir.join(&manifest.backup_id);
        if !backup_subdir.exists() {
            return Err(BackupError::FileNotFound(format!(
                "备份目录不存在: {:?}",
                backup_subdir
            )));
        }

        // 2. 验证备份完整性
        self.verify_internal(manifest, &backup_subdir)?;

        // 3. 创建预恢复备份
        let pre_restore_dir = self.backup_dir.join(PRE_RESTORE_DIR);
        self.create_pre_restore_backup(&pre_restore_dir)?;

        // 4. 恢复每个数据库
        let mut restore_errors: Vec<String> = Vec::new();

        for backup_file in &manifest.files {
            // 只恢复数据库文件
            if !backup_file.path.ends_with(".db") {
                continue;
            }

            let Some(db_id_str) = backup_file.database_id.as_ref() else {
                // Workspace and audit databases have explicit auxiliary restore
                // paths and must not enter the core DatabaseId loop.
                continue;
            };

            let db_id = match db_id_str.as_str() {
                "vfs" => DatabaseId::Vfs,
                "chat_v2" => DatabaseId::ChatV2,
                "mistakes" => DatabaseId::Mistakes,
                "llm_usage" => DatabaseId::LlmUsage,
                _ => {
                    // 理论上 check_manifest_compatibility 已经拦截；这里做最后一道防线。
                    let msg = format!("备份中包含未知的数据库 ID: {}", db_id_str);
                    error!("{}", msg);
                    restore_errors.push(msg);
                    continue;
                }
            };

            match self.restore_single_database(&db_id, &backup_subdir) {
                Ok(()) => {
                    info!("恢复数据库成功: {:?}", db_id);
                }
                Err(e) => {
                    error!("恢复数据库失败: {:?}, 错误: {}", db_id, e);
                    restore_errors.push(format!("{:?}: {}", db_id, e));
                }
            }
        }

        // 4.5 恢复加密密钥（跨设备恢复支持）
        match self.restore_crypto_keys_from_manifest(manifest, &backup_subdir) {
            Ok(count) => {
                if count > 0 {
                    info!("加密密钥恢复完成: {} 个文件", count);
                }
            }
            Err(e) => {
                error!("加密密钥恢复失败: {}", e);
                restore_errors.push(format!("加密密钥恢复: {}", e));
            }
        }

        // 4.6 恢复审计数据库（操作追溯，失败不阻断）
        match self.restore_audit_db_from_manifest(manifest, &backup_subdir) {
            Ok(true) => info!("审计数据库恢复完成"),
            Ok(false) => debug!("备份中无审计数据库，跳过"),
            Err(e) => warn!("审计数据库恢复失败（非致命）: {}", e),
        }

        // 4.7 恢复工作区数据库（ws_*.db）
        let active_dir_for_ws = self.active_data_dir_for_backup();
        match self.restore_workspace_manifest_files_to_dir(
            manifest,
            &backup_subdir,
            &active_dir_for_ws,
        ) {
            Ok(count) => {
                if count > 0 {
                    info!("工作区数据库恢复完成: {} 个", count);
                }
            }
            Err(e) => {
                error!("工作区数据库恢复失败: {}", e);
                restore_errors.push(format!("工作区数据库恢复: {}", e));
            }
        }

        if let Err(error) =
            Self::prepare_vfs_index_restore(manifest, &active_dir_for_ws, restore_assets)
        {
            error!("恢复后处理 VFS 派生索引失败: {}", error);
            restore_errors.push(format!("VFS 派生索引恢复契约: {}", error));
        }

        // 5. 恢复资产文件（如果需要）
        let mut restored_assets = 0;
        if restore_assets {
            let active_restore_dir = crate::data_space::get_data_space_manager()
                .map(|mgr| mgr.active_dir())
                .unwrap_or_else(|| self.app_data_dir.join("slots").join("slotA"));

            // 恢复 manifest.files 中的可重建文件（如 lance/），避免仅恢复 DB 导致向量目录缺失。
            match self.restore_non_database_manifest_files(
                manifest,
                &backup_subdir,
                &active_restore_dir,
            ) {
                Ok(count) => {
                    if count > 0 {
                        info!("非数据库文件恢复完成: {} 个", count);
                    }
                }
                Err(e) => {
                    error!("非数据库文件恢复失败: {}", e);
                    restore_errors.push(format!("非数据库文件恢复: {}", e));
                }
            }

            if let Some(asset_result) = &manifest.assets {
                info!("开始恢复资产文件: {} 个", asset_result.total_files);
                let auto_restorable = asset_result
                    .files
                    .iter()
                    .filter(|asset| !asset_requires_explicit_trust(asset))
                    .cloned()
                    .collect::<Vec<_>>();
                match assets::restore_assets(&backup_subdir, &active_restore_dir, &auto_restorable)
                {
                    Ok(count) => {
                        restored_assets = count;
                        info!("资产恢复完成: {} 个文件", count);
                    }
                    Err(e) => {
                        error!("资产恢复失败: {}", e);
                        restore_errors.push(format!("资产恢复: {}", e));
                    }
                }
            }
        }

        if let Err(error) =
            Self::finalize_vfs_index_restore(manifest, &active_dir_for_ws, restore_assets)
        {
            error!("恢复后校验 VFS 派生索引失败: {}", error);
            restore_errors.push(format!("VFS 派生索引最终校验: {}", error));
        }

        // 6. 检查是否有错误
        if !restore_errors.is_empty() {
            error!("恢复失败，尝试自动回滚到预恢复备份: {:?}", pre_restore_dir);
            let rollback_result = self.rollback_from_pre_restore(&pre_restore_dir);
            return Err(match rollback_result {
                Ok(()) => BackupError::RestoreFailed(format!(
                    "部分恢复失败并已自动回滚: {:?}",
                    restore_errors
                )),
                Err(rollback_err) => BackupError::RestoreFailed(format!(
                    "部分恢复失败且自动回滚失败: {:?}; 回滚错误: {}",
                    restore_errors, rollback_err
                )),
            });
        }

        info!(
            "恢复完成: 数据库文件={}, 资产文件={}，预恢复备份保留在: {:?}",
            manifest.files.len(),
            restored_assets,
            pre_restore_dir
        );

        Ok(restored_assets)
    }

    /// 恢复备份到指定目标目录（用于恢复到非活跃插槽，零文件冲突）
    ///
    /// 与 `restore_with_assets` 的区别：
    /// - 数据库和资产写入 `target_dir` 而非 `active_dir`
    /// - 不创建预恢复备份（目标是空的非活跃插槽，无需回滚）
    /// - 不需要维护模式（不涉及正在使用的文件）
    ///
    /// ## 返回
    ///
    /// 成功时返回恢复的资产数量
    pub fn restore_with_assets_to_dir(
        &self,
        manifest: &BackupManifest,
        restore_assets: bool,
        target_dir: &Path,
    ) -> Result<usize, BackupError> {
        info!(
            "开始恢复备份到目标目录: {}, backup_id={}, restore_assets={}",
            target_dir.display(),
            manifest.backup_id,
            restore_assets
        );

        // 0. 版本兼容性检查
        self.check_manifest_compatibility(manifest)?;
        manifest.validate_for_slot_restore()?;

        // 1. 获取备份目录
        let backup_subdir = self.backup_dir.join(&manifest.backup_id);
        if !backup_subdir.exists() {
            return Err(BackupError::FileNotFound(format!(
                "备份目录不存在: {:?}",
                backup_subdir
            )));
        }

        // 2. 验证备份完整性
        self.verify_internal(manifest, &backup_subdir)?;

        // 3. 确保目标目录存在
        fs::create_dir_all(target_dir)?;

        // 4. 恢复每个数据库到目标目录
        let mut restore_errors: Vec<String> = Vec::new();

        for backup_file in &manifest.files {
            if !backup_file.path.ends_with(".db") {
                continue;
            }

            let Some(db_id_str) = backup_file.database_id.as_ref() else {
                continue;
            };

            let db_id = match db_id_str.as_str() {
                "vfs" => DatabaseId::Vfs,
                "chat_v2" => DatabaseId::ChatV2,
                "mistakes" => DatabaseId::Mistakes,
                "llm_usage" => DatabaseId::LlmUsage,
                _ => {
                    let msg = format!("备份中包含未知的数据库 ID: {}", db_id_str);
                    error!("{}", msg);
                    restore_errors.push(msg);
                    continue;
                }
            };

            match self.restore_single_database_to_dir(&db_id, &backup_subdir, target_dir) {
                Ok(()) => {
                    info!("恢复数据库成功: {:?} -> {}", db_id, target_dir.display());
                }
                Err(e) => {
                    error!("恢复数据库失败: {:?}, 错误: {}", db_id, e);
                    restore_errors.push(format!("{:?}: {}", db_id, e));
                }
            }
        }

        // 4.7 恢复工作区数据库到目标目录（ws_*.db）
        match self.restore_workspace_manifest_files_to_dir(manifest, &backup_subdir, target_dir) {
            Ok(count) => {
                if count > 0 {
                    info!("工作区数据库恢复完成: {} 个", count);
                }
            }
            Err(e) => {
                error!("工作区数据库恢复失败: {}", e);
                restore_errors.push(format!("工作区数据库恢复: {}", e));
            }
        }

        if let Err(error) = Self::prepare_vfs_index_restore(manifest, target_dir, restore_assets) {
            error!("恢复后处理 VFS 派生索引失败: {}", error);
            restore_errors.push(format!("VFS 派生索引恢复契约: {}", error));
        }

        // 5. 恢复资产文件到目标目录
        let mut restored_assets = 0;
        if restore_assets {
            match self.restore_non_database_manifest_files(manifest, &backup_subdir, target_dir) {
                Ok(count) => {
                    if count > 0 {
                        info!("非数据库文件恢复到目标目录完成: {} 个", count);
                    }
                }
                Err(e) => {
                    error!("非数据库文件恢复到目标目录失败: {}", e);
                    restore_errors.push(format!("非数据库文件恢复: {}", e));
                }
            }

            if let Some(asset_result) = &manifest.assets {
                info!(
                    "开始恢复资产文件到目标目录: {} 个",
                    asset_result.total_files
                );
                let auto_restorable = asset_result
                    .files
                    .iter()
                    .filter(|asset| !asset_requires_explicit_trust(asset))
                    .cloned()
                    .collect::<Vec<_>>();
                match assets::restore_assets(&backup_subdir, target_dir, &auto_restorable) {
                    Ok(count) => {
                        restored_assets = count;
                        info!("资产恢复完成: {} 个文件", count);
                    }
                    Err(e) => {
                        error!("资产恢复失败: {}", e);
                        restore_errors.push(format!("资产恢复: {}", e));
                    }
                }
            }
        }

        if let Err(error) = Self::finalize_vfs_index_restore(manifest, target_dir, restore_assets) {
            error!("恢复后校验 VFS 派生索引失败: {}", error);
            restore_errors.push(format!("VFS 派生索引最终校验: {}", error));
        }

        // 6. 检查是否有错误（非活跃插槽恢复失败不回滚，直接报错）
        if !restore_errors.is_empty() {
            return Err(BackupError::RestoreFailed(format!(
                "恢复到目标目录失败: {:?}",
                restore_errors
            )));
        }

        info!(
            "恢复到目标目录完成: 数据库={}, 资产={}, 目标={}",
            manifest
                .files
                .iter()
                .filter(|f| f.path.ends_with(".db"))
                .count(),
            restored_assets,
            target_dir.display()
        );

        Ok(restored_assets)
    }

    /// 验证包含资产的备份
    ///
    /// ## 参数
    ///
    /// - `manifest`: 备份清单
    ///
    /// ## 返回
    ///
    /// 验证结果，包含数据库和资产的验证错误
    pub fn verify_with_assets(
        &self,
        manifest: &BackupManifest,
    ) -> Result<BackupVerifyResult, BackupError> {
        let backup_subdir = self.backup_dir.join(&manifest.backup_id);
        if !backup_subdir.exists() {
            return Err(BackupError::FileNotFound(format!(
                "备份目录不存在: {:?}",
                backup_subdir
            )));
        }

        // 验证数据库文件
        let db_result = self.verify_internal(manifest, &backup_subdir);
        let db_errors = match db_result {
            Ok(()) => Vec::new(),
            Err(e) => vec![e.to_string()],
        };

        // 验证资产文件
        let asset_errors = if let Some(asset_result) = &manifest.assets {
            match assets::verify_assets(&backup_subdir, &asset_result.files) {
                Ok(errors) => errors,
                Err(e) => {
                    vec![assets::AssetVerifyError {
                        path: "assets".to_string(),
                        error_type: "verify_failed".to_string(),
                        message: e.to_string(),
                    }]
                }
            }
        } else {
            Vec::new()
        };

        Ok(BackupVerifyResult {
            is_valid: db_errors.is_empty() && asset_errors.is_empty(),
            database_errors: db_errors,
            asset_errors,
        })
    }

    /// 备份单个数据库
    ///
    /// 使用 SQLite Backup API 进行原子性备份。
    ///
    /// ## 竞态保护（Issue #10）
    ///
    /// checkpoint 和 Backup API 之间存在竞态窗口：
    /// 如果在 checkpoint 完成后、Backup 开始前有新写入，WAL 中的数据可能
    /// 未被 checkpoint 合并到主文件。虽然 Backup API 本身会拷贝 WAL 中的
    /// 未合并数据，但 TRUNCATE checkpoint 可能已清空 WAL。
    ///
    /// 解决方案：使用 BEGIN IMMEDIATE 获取写锁，阻止 checkpoint-Backup
    /// 窗口期间的并发写入，确保备份的一致性。
    fn backup_single_database(
        &self,
        db_id: &DatabaseId,
        source_path: &Path,
        backup_dir: &Path,
        db_idx: usize,
        total_dbs: usize,
    ) -> Result<BackupFile, BackupError> {
        // 1. 打开源数据库
        let src_conn = Connection::open(source_path)?;

        // 2. 执行 WAL checkpoint，确保所有数据写入主数据库文件
        //
        // ## 竞态说明（Issue #10）
        //
        // checkpoint 和 Backup API 之间理论上存在竞态窗口（新写入可能在 checkpoint 后进入 WAL）。
        // 但 SQLite Backup API 会自动处理：
        // - run_to_completion 分批拷贝页面，如果源页面在拷贝过程中被修改，
        //   Backup API 会重新拷贝受影响的页面
        // - 这保证了备份是某一时刻的一致性快照
        //
        // 因此不需要额外的事务锁定（BEGIN IMMEDIATE 会阻塞 checkpoint 导致死锁）。
        debug!("执行 WAL checkpoint: {:?}", db_id);
        src_conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;

        // 3. 创建目标文件路径
        let dest_path = self.get_backup_database_path(backup_dir, db_id);

        // 4. 打开目标数据库
        let mut dest_conn = Connection::open(&dest_path)?;

        // 5. 使用 Backup API 复制数据库（手动 step 循环，支持页面级进度）
        debug!("使用 Backup API 复制: {:?} -> {:?}", source_path, dest_path);
        {
            let backup = Backup::new(&src_conn, &mut dest_conn)?;

            // 手动分批复制，每次 100 页，间隔 50ms
            // 每批复制后通过回调报告页面级进度
            use rusqlite::backup::StepResult;

            // 与恢复路径一致：Busy/Locked 设置重试上限，避免源库持续被锁时备份无限挂起
            const RETRY_SLEEP_MS: u64 = 50;
            const MAX_BUSY_RETRIES: u32 = 1200; // 约 60 秒无进展则放弃

            let mut busy_retries: u32 = 0;

            loop {
                let step_result = backup.step(100)?;

                // 报告页面级进度
                if let Some(ref cb) = self.progress_callback {
                    let p = backup.progress();
                    let copied = p.pagecount - p.remaining;
                    cb(db_idx, total_dbs, db_id.as_str(), copied, p.pagecount);
                }

                match step_result {
                    StepResult::Done => break,
                    StepResult::More => {
                        busy_retries = 0;
                        std::thread::sleep(Duration::from_millis(RETRY_SLEEP_MS));
                    }
                    StepResult::Busy | StepResult::Locked => {
                        busy_retries = busy_retries.saturating_add(1);
                        if busy_retries.is_multiple_of(200) {
                            let p = backup.progress();
                            warn!(
                                "[Backup] 备份数据库等待锁释放: db={:?}, retry={}/{}, remaining_pages={}/{}",
                                db_id, busy_retries, MAX_BUSY_RETRIES, p.remaining, p.pagecount
                            );
                        }
                        if busy_retries >= MAX_BUSY_RETRIES {
                            return Err(BackupError::Database(format!(
                                "备份数据库超时：源数据库持续被锁定（db={:?}, source={}）",
                                db_id,
                                source_path.display()
                            )));
                        }
                        std::thread::sleep(Duration::from_millis(RETRY_SLEEP_MS));
                    }
                    _ => {
                        std::thread::sleep(Duration::from_millis(RETRY_SLEEP_MS));
                    }
                }
            }
        }

        // 6. 确保目标数据库完全写入
        dest_conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;

        // 8. 关闭连接
        drop(dest_conn);
        drop(src_conn);

        // 8. 计算校验和
        let sha256 = calculate_file_sha256(&dest_path)?;
        let size = fs::metadata(&dest_path)?.len();

        debug!(
            "数据库备份完成: {:?}, size={}, sha256={}",
            db_id, size, sha256
        );

        Ok(BackupFile {
            path: format!("{}.db", db_id.as_str()),
            size,
            sha256,
            database_id: Some(db_id.as_str().to_string()),
        })
    }

    /// 获取数据库的 schema 版本
    fn get_schema_version(&self, db_path: &Path) -> Result<u32, BackupError> {
        let conn = Connection::open(db_path)?;

        // 检查 refinery_schema_history 表是否存在
        let table_exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='refinery_schema_history')",
            [],
            |row| row.get(0),
        )?;

        if !table_exists {
            return Ok(0);
        }

        // 获取最大版本号
        let version: Option<i32> = conn.query_row(
            "SELECT MAX(version) FROM refinery_schema_history",
            [],
            |row| row.get(0),
        )?;

        Ok(version.unwrap_or(0) as u32)
    }

    /// 增量备份创建入口（已下线）
    ///
    /// 旧实现仅导出 `__change_log` 元信息、无行 payload，且恢复路径拒绝增量包。
    /// 为避免产生不可恢复的空壳备份，此方法始终返回
    /// [`BackupError::IncrementalBackupRemoved`]。
    pub fn backup_incremental(&self, _base_version: &str) -> Result<BackupManifest, BackupError> {
        Err(BackupError::IncrementalBackupRemoved(
            INCREMENTAL_BACKUP_REMOVED_MESSAGE.to_string(),
        ))
    }

    /// 验证备份清单的版本兼容性
    ///
    /// ## 检查项
    ///
    /// 1. manifest 格式版本不超过当前应用支持的主版本
    /// 2. 增量备份不允许直接 restore（需要先合并）
    /// 3. schema 版本不超过当前应用已知的最新版本（防止未来版本数据覆盖）
    ///
    /// ## 错误
    ///
    /// - `BackupError::VersionIncompatible` - 版本不兼容，附带可操作的错误提示
    /// - `BackupError::IncrementalRestoreNotSupported` - 增量备份不支持直接恢复
    pub(crate) fn check_manifest_compatibility(
        &self,
        manifest: &BackupManifest,
    ) -> Result<(), BackupError> {
        // 1. 检查 manifest 格式版本
        let _manifest_major = parse_manifest_major(&manifest.version)?;

        // 2. 增量备份不支持直接恢复
        if manifest.is_incremental {
            return Err(BackupError::IncrementalRestoreNotSupported(
                INCREMENTAL_RESTORE_NOT_SUPPORTED_MESSAGE.to_string(),
            ));
        }

        // 3. 检查 schema 版本兼容性（防止用未来版本的备份覆盖当前数据）
        #[cfg(feature = "data_governance")]
        {
            use crate::data_governance::migration::ALL_MIGRATION_SETS;
            use std::collections::HashSet;

            // fail-close：拒绝包含未知数据库的备份（避免“恢复成功但数据缺失”）
            //
            // 过去的实现会把未知数据库当作 max_known_version=0，
            // 进而跳过版本上限检查，并在 restore() 中静默跳过未知数据库文件。
            let known_db_ids: HashSet<&str> = DatabaseId::all_ordered()
                .into_iter()
                .map(|id| id.as_str())
                .collect();

            // 基于 schema_versions 的未知数据库检测
            for db_name in manifest.schema_versions.keys() {
                if !known_db_ids.contains(db_name.as_str()) {
                    return Err(BackupError::VersionIncompatible(format!(
                        "备份中包含当前应用未知的数据库 \"{}\"。为避免数据丢失，当前版本不会忽略该数据库。请升级应用到与备份兼容的版本后重试恢复。",
                        db_name
                    )));
                }
            }

            // 基于 files.database_id 的未知数据库检测
            for backup_file in &manifest.files {
                if !backup_file.path.ends_with(".db") {
                    continue;
                }
                let Some(db_id_str) = backup_file.database_id.as_deref() else {
                    continue;
                };
                if !known_db_ids.contains(db_id_str) {
                    return Err(BackupError::VersionIncompatible(format!(
                        "备份中包含当前应用未知的数据库 \"{}\"（文件: {}）。请升级应用到与备份兼容的版本后重试恢复。",
                        db_id_str, backup_file.path
                    )));
                }
            }

            for (db_name, &backup_schema_version) in &manifest.schema_versions {
                // 上面已检查 db_name 一定是已知数据库；这里若仍找不到则视为不一致并 fail-close。
                let max_known_version = ALL_MIGRATION_SETS
                    .iter()
                    .find(|set| set.database_name == db_name)
                    .ok_or_else(|| {
                        BackupError::VersionIncompatible(format!(
                            "备份中包含当前应用未知的数据库 \"{}\"。请升级应用到与备份兼容的版本后重试恢复。",
                            db_name
                        ))
                    })?
                    .latest_version() as u32;

                if backup_schema_version > max_known_version {
                    return Err(BackupError::VersionIncompatible(format!(
                        "备份中数据库 {} 的 schema 版本 (v{}) 高于当前应用支持的最新版本 (v{})。\
                         请升级应用到与备份兼容的版本后重试。",
                        db_name, backup_schema_version, max_known_version
                    )));
                }
            }
        }

        info!(
            "备份版本兼容性检查通过: manifest={}, schema_versions={:?}",
            manifest.version, manifest.schema_versions
        );

        Ok(())
    }

    /// 恢复备份
    ///
    /// ## 执行步骤
    ///
    /// 1. 验证清单版本兼容性
    /// 2. 验证清单和所有文件的校验和
    /// 3. 创建预恢复备份（用于回滚）
    /// 4. 使用 SQLite Backup API 恢复每个数据库
    /// 5. 验证恢复结果
    ///
    /// ## 安全机制
    ///
    /// - 恢复前检查备份版本，拒绝不兼容的未来版本
    /// - 恢复前自动备份当前数据到 `.pre_restore` 目录
    /// - 恢复失败时可通过预恢复备份回滚
    pub fn restore(&self, manifest: &BackupManifest) -> Result<(), BackupError> {
        info!("开始恢复备份: {}", manifest.backup_id);

        // 1. 版本兼容性检查
        if manifest.snapshot_kind == SnapshotKind::LegacyCandidate {
            manifest.validate_legacy_candidate_for_upgrade()?;
        }
        self.check_manifest_compatibility(manifest)?;

        // 2. 获取备份目录
        let backup_subdir = self.backup_dir.join(&manifest.backup_id);
        if !backup_subdir.exists() {
            return Err(BackupError::FileNotFound(format!(
                "备份目录不存在: {:?}",
                backup_subdir
            )));
        }

        // 3. 验证备份完整性
        self.verify_internal(manifest, &backup_subdir)?;

        // 3. 创建预恢复备份
        let pre_restore_dir = self.backup_dir.join(PRE_RESTORE_DIR);
        self.create_pre_restore_backup(&pre_restore_dir)?;

        // 4. 恢复每个数据库
        let mut restore_errors: Vec<String> = Vec::new();

        for backup_file in &manifest.files {
            // 只恢复数据库文件
            if !backup_file.path.ends_with(".db") {
                continue;
            }

            let Some(db_id_str) = backup_file.database_id.as_ref() else {
                continue;
            };

            let db_id = match db_id_str.as_str() {
                "vfs" => DatabaseId::Vfs,
                "chat_v2" => DatabaseId::ChatV2,
                "mistakes" => DatabaseId::Mistakes,
                "llm_usage" => DatabaseId::LlmUsage,
                _ => {
                    let msg = format!("备份中包含未知的数据库 ID: {}", db_id_str);
                    error!("{}", msg);
                    restore_errors.push(msg);
                    continue;
                }
            };

            match self.restore_single_database(&db_id, &backup_subdir) {
                Ok(()) => {
                    info!("恢复数据库成功: {:?}", db_id);
                }
                Err(e) => {
                    error!("恢复数据库失败: {:?}, 错误: {}", db_id, e);
                    restore_errors.push(format!("{:?}: {}", db_id, e));
                }
            }
        }

        // 4.5 恢复加密密钥（跨设备恢复支持）
        match self.restore_crypto_keys(&backup_subdir) {
            Ok(count) => {
                if count > 0 {
                    info!("加密密钥恢复完成: {} 个文件", count);
                }
            }
            Err(e) => {
                warn!("加密密钥恢复失败（API 密钥可能需要重新配置）: {}", e);
            }
        }

        // 4.6 恢复审计数据库（操作追溯，失败不阻断）
        match self.restore_audit_db(&backup_subdir) {
            Ok(true) => info!("审计数据库恢复完成"),
            Ok(false) => debug!("备份中无审计数据库，跳过"),
            Err(e) => warn!("审计数据库恢复失败（非致命）: {}", e),
        }

        // 4.7 恢复工作区数据库（ws_*.db）
        let active_dir_for_ws = crate::data_space::get_data_space_manager()
            .map(|mgr| mgr.active_dir())
            .unwrap_or_else(|| self.app_data_dir.join("slots").join("slotA"));
        match self.restore_workspace_databases(&backup_subdir, &active_dir_for_ws) {
            Ok(count) => {
                if count > 0 {
                    info!("工作区数据库恢复完成: {} 个", count);
                }
            }
            Err(e) => {
                warn!("工作区数据库恢复失败（非致命）: {}", e);
            }
        }

        // This legacy entry point never restores non-database assets. Treat the
        // Lance component as absent even when the manifest came from an asset
        // backup, otherwise the restored SQLite manifest could expose rows from
        // the target device's pre-restore Lance directory.
        if let Err(error) = Self::prepare_vfs_index_restore(manifest, &active_dir_for_ws, false) {
            error!("恢复后处理 VFS 派生索引失败: {}", error);
            restore_errors.push(format!("VFS 派生索引恢复契约: {}", error));
        }
        if let Err(error) = Self::finalize_vfs_index_restore(manifest, &active_dir_for_ws, false) {
            error!("恢复后校验 VFS 派生索引失败: {}", error);
            restore_errors.push(format!("VFS 派生索引最终校验: {}", error));
        }

        // 5. 检查是否有错误
        if !restore_errors.is_empty() {
            error!("恢复失败，尝试自动回滚到预恢复备份: {:?}", pre_restore_dir);
            let rollback_result = self.rollback_from_pre_restore(&pre_restore_dir);
            return Err(match rollback_result {
                Ok(()) => BackupError::RestoreFailed(format!(
                    "部分数据库恢复失败并已自动回滚: {:?}",
                    restore_errors
                )),
                Err(rollback_err) => BackupError::RestoreFailed(format!(
                    "部分数据库恢复失败且自动回滚失败: {:?}; 回滚错误: {}",
                    restore_errors, rollback_err
                )),
            });
        }

        // 6. 清理预恢复备份（可选，保留以防万一）
        info!("恢复完成，预恢复备份保留在: {:?}", pre_restore_dir);

        Ok(())
    }

    pub(crate) fn rollback_from_pre_restore(
        &self,
        pre_restore_dir: &Path,
    ) -> Result<(), BackupError> {
        if !pre_restore_dir.exists() {
            return Err(BackupError::FileNotFound(format!(
                "预恢复备份不存在: {:?}",
                pre_restore_dir
            )));
        }

        for db_id in DatabaseId::all_ordered() {
            let backup_path = self.get_backup_database_path(pre_restore_dir, &db_id);
            if backup_path.exists() {
                self.restore_single_database(&db_id, pre_restore_dir)?;
            }
        }

        // 回滚工作区数据库
        let active_dir = crate::data_space::get_data_space_manager()
            .map(|mgr| mgr.active_dir())
            .unwrap_or_else(|| self.app_data_dir.join("slots").join("slotA"));
        if let Err(e) = self.restore_workspace_databases(pre_restore_dir, &active_dir) {
            warn!("工作区数据库回滚失败（非致命）: {}", e);
        }

        // 回滚加密密钥（restore_crypto_keys 覆盖前的快照，若存在）
        if pre_restore_dir.join("crypto").exists() {
            match self.restore_crypto_keys(pre_restore_dir) {
                Ok(n) if n > 0 => info!("加密密钥已回滚: {} 个文件", n),
                Ok(_) => {}
                Err(e) => warn!("加密密钥回滚失败（API 密钥可能需重新配置）: {}", e),
            }
        }

        Ok(())
    }

    /// 创建预恢复备份
    pub(crate) fn create_pre_restore_backup(
        &self,
        pre_restore_dir: &Path,
    ) -> Result<(), BackupError> {
        // 清理旧的预恢复备份
        if pre_restore_dir.exists() {
            fs::remove_dir_all(pre_restore_dir)?;
        }
        fs::create_dir_all(pre_restore_dir)?;

        info!("创建预恢复备份: {:?}", pre_restore_dir);

        // 备份所有存在的数据库
        let all_dbs = DatabaseId::all_ordered();
        let total_dbs = all_dbs.len();
        for (idx, db_id) in all_dbs.into_iter().enumerate() {
            let db_path = self.get_database_path(&db_id);

            if db_path.exists() {
                self.backup_single_database(&db_id, &db_path, pre_restore_dir, idx, total_dbs)?;
            }
        }

        // 备份工作区数据库（用于恢复失败时回滚）
        let active_dir = crate::data_space::get_data_space_manager()
            .map(|mgr| mgr.active_dir())
            .unwrap_or_else(|| self.app_data_dir.join("slots").join("slotA"));
        if let Err(e) = self.backup_workspace_databases(&active_dir, pre_restore_dir) {
            warn!("预恢复备份中工作区数据库备份失败（非致命）: {}", e);
        }

        Ok(())
    }

    /// 恢复单个数据库（写入活跃插槽，旧接口保留兼容）
    pub(crate) fn restore_single_database(
        &self,
        db_id: &DatabaseId,
        backup_dir: &Path,
    ) -> Result<(), BackupError> {
        let target_path = self.get_database_path(db_id);
        self.restore_single_database_to_path(db_id, backup_dir, &target_path)
    }

    /// 恢复单个数据库到指定目标目录（用于恢复到非活跃插槽）
    pub(crate) fn restore_single_database_to_dir(
        &self,
        db_id: &DatabaseId,
        backup_dir: &Path,
        target_dir: &Path,
    ) -> Result<(), BackupError> {
        let target_path = Self::resolve_database_path_in_dir(target_dir, db_id);
        self.restore_single_database_to_path(db_id, backup_dir, &target_path)
    }

    /// 恢复单个数据库到指定路径（内部实现）
    fn restore_single_database_to_path(
        &self,
        db_id: &DatabaseId,
        backup_dir: &Path,
        target_path: &Path,
    ) -> Result<(), BackupError> {
        let backup_path = self.get_backup_database_path(backup_dir, db_id);

        if !backup_path.exists() {
            return Err(BackupError::FileNotFound(format!(
                "备份文件不存在: {:?}",
                backup_path
            )));
        }

        // 确保目标目录存在
        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent)?;
        }

        // 如果目标数据库存在，先关闭 WAL
        if target_path.exists() {
            let existing_conn = Connection::open(target_path)?;
            existing_conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
            drop(existing_conn);

            // 删除 WAL 和 SHM 文件
            let wal_path = target_path.with_extension("db-wal");
            let shm_path = target_path.with_extension("db-shm");
            if wal_path.exists() {
                fs::remove_file(&wal_path)?;
            }
            if shm_path.exists() {
                fs::remove_file(&shm_path)?;
            }
        }

        // 使用 Backup API 恢复
        let src_conn = Connection::open(&backup_path)?;
        let mut dest_conn = Connection::open(target_path)?;

        // 显式设置 busy_timeout，避免 Windows 文件锁场景下无界等待
        src_conn.pragma_update(None, "busy_timeout", 5000i64)?;
        dest_conn.pragma_update(None, "busy_timeout", 5000i64)?;

        debug!("恢复数据库: {:?} -> {:?}", backup_path, target_path);

        {
            let backup = Backup::new(&src_conn, &mut dest_conn)?;
            use rusqlite::backup::StepResult;

            // P0 修复：避免 Busy/Locked 时无限阻塞（Windows 下会表现为恢复进度长期卡住）
            const STEP_PAGES: i32 = 100;
            const RETRY_SLEEP_MS: u64 = 100;
            const MAX_BUSY_RETRIES: u32 = 600; // 约 60 秒

            let mut busy_retries: u32 = 0;

            loop {
                let step_result = backup.step(STEP_PAGES)?;
                match step_result {
                    StepResult::Done => break,
                    StepResult::More => {
                        // 复制有进展，重置 Busy/Locked 计数
                        busy_retries = 0;
                    }
                    StepResult::Busy | StepResult::Locked => {
                        busy_retries = busy_retries.saturating_add(1);
                        if busy_retries.is_multiple_of(50) {
                            let p = backup.progress();
                            warn!(
                                "[data_governance] 恢复数据库等待锁释放: db={:?}, retry={}/{}, remaining_pages={}/{}",
                                db_id,
                                busy_retries,
                                MAX_BUSY_RETRIES,
                                p.remaining,
                                p.pagecount
                            );
                        }

                        if busy_retries >= MAX_BUSY_RETRIES {
                            return Err(BackupError::RestoreFailed(format!(
                                "恢复数据库超时：目标数据库持续被锁定（db={:?}, target={}）",
                                db_id,
                                target_path.display()
                            )));
                        }

                        std::thread::sleep(Duration::from_millis(RETRY_SLEEP_MS));
                    }
                    _ => {
                        std::thread::sleep(Duration::from_millis(RETRY_SLEEP_MS));
                    }
                }
            }
        }

        // 执行完整性检查
        let integrity_result: String =
            dest_conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;

        if integrity_result != "ok" {
            return Err(BackupError::IntegrityCheckFailed(format!(
                "恢复后完整性检查失败: {}",
                integrity_result
            )));
        }

        debug!("数据库恢复并验证成功: {:?}", db_id);

        Ok(())
    }

    /// 验证备份完整性
    ///
    /// ## 检查项目
    ///
    /// 1. 所有清单中的文件都存在
    /// 2. 每个文件的 SHA256 校验和正确
    /// 3. 每个数据库通过 `PRAGMA integrity_check`
    pub fn verify(&self, manifest: &BackupManifest) -> Result<(), BackupError> {
        let backup_subdir = self.backup_dir.join(&manifest.backup_id);
        if !backup_subdir.exists() {
            return Err(BackupError::FileNotFound(format!(
                "备份目录不存在: {:?}",
                backup_subdir
            )));
        }

        self.verify_internal(manifest, &backup_subdir)
    }

    /// 内部验证方法
    pub(crate) fn verify_internal(
        &self,
        manifest: &BackupManifest,
        backup_dir: &Path,
    ) -> Result<(), BackupError> {
        info!("验证备份: {}", manifest.backup_id);

        manifest.validate_untrusted()?;

        let mut errors: Vec<String> = Vec::new();

        for backup_file in &manifest.files {
            let file_path =
                match resolve_existing_backup_file(backup_dir, Path::new(&backup_file.path)) {
                    Ok(path) => path,
                    Err(e) => {
                        errors.push(e.to_string());
                        continue;
                    }
                };

            let actual_size = match fs::metadata(&file_path) {
                Ok(metadata) => metadata.len(),
                Err(e) => {
                    errors.push(format!("读取文件大小失败 {}: {}", backup_file.path, e));
                    continue;
                }
            };
            if actual_size != backup_file.size {
                errors.push(format!(
                    "文件大小不匹配 {}: expected={}, actual={}",
                    backup_file.path, backup_file.size, actual_size
                ));
                continue;
            }

            // 2. 验证校验和
            let actual_sha256 = match calculate_file_sha256_exact(&file_path, backup_file.size) {
                Ok(hash) => hash,
                Err(e) => {
                    errors.push(format!("计算校验和失败 {}: {}", backup_file.path, e));
                    continue;
                }
            };

            if actual_sha256 != backup_file.sha256 {
                errors.push(format!(
                    "校验和不匹配 {}: expected={}, actual={}",
                    backup_file.path, backup_file.sha256, actual_sha256
                ));
                continue;
            }

            // 3. 仅验证受治理的 SQLite 文件；技能包等持久域内允许有
            // 任意扩展名为 .db 的普通数据文件。
            let is_workspace_database =
                backup_file
                    .path
                    .strip_prefix("workspaces/")
                    .is_some_and(|name| {
                        !name.contains('/') && name.starts_with("ws_") && name.ends_with(".db")
                    });
            let is_governed_database = backup_file.database_id.is_some()
                || backup_file.path == "databases/audit.db"
                || is_workspace_database;
            if is_governed_database {
                match self.verify_database_integrity(&file_path) {
                    Ok(()) => {
                        debug!("文件验证通过: {}", backup_file.path);
                    }
                    Err(e) => {
                        errors.push(format!("数据库完整性检查失败 {}: {}", backup_file.path, e));
                    }
                }
            } else {
                debug!("文件验证通过: {}", backup_file.path);
            }
        }

        if let Some(asset_result) = &manifest.assets {
            match assets::verify_assets(backup_dir, &asset_result.files) {
                Ok(asset_errors) => {
                    errors.extend(asset_errors.into_iter().map(|error| {
                        format!("资产完整性检查失败 {}: {}", error.path, error.message)
                    }));
                }
                Err(error) => errors.push(format!("资产验证无法完成: {}", error)),
            }
        }

        if let Err(error) = Self::verify_crypto_material(manifest, backup_dir) {
            errors.push(format!("加密材料验证失败: {}", error));
        }

        // 验证清单文件
        let manifest_path = backup_dir.join(MANIFEST_FILENAME);
        if !manifest_path.exists() {
            errors.push("清单文件不存在".to_string());
        }

        if errors.is_empty() {
            info!("备份验证通过: {} 个文件", manifest.files.len());
            Ok(())
        } else {
            let error_count = errors.len();
            Err(BackupError::Manifest(format!(
                "备份验证失败（{} 个错误）。备份可能已损坏，请使用其他备份或重新创建备份。\n详情:\n{}",
                error_count,
                errors.join("\n")
            )))
        }
    }

    /// 验证数据库文件完整性
    fn verify_database_integrity(&self, db_path: &Path) -> Result<(), BackupError> {
        let conn = Connection::open(db_path)?;

        // 执行完整性检查
        let result: String = conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;

        if result == "ok" {
            Ok(())
        } else {
            Err(BackupError::IntegrityCheckFailed(result))
        }
    }

    // =========================================================================
    // 工作区数据库备份/恢复（ws_*.db，位于 active_dir/workspaces/）
    // =========================================================================

    /// 使用 SQLite Backup API 备份任意路径的数据库（不依赖 DatabaseId）
    fn backup_db_at_path(src_path: &Path, dest_path: &Path) -> Result<(), BackupError> {
        let src_conn = Connection::open(src_path)?;
        src_conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;

        let mut dest_conn = Connection::open(dest_path)?;
        {
            let backup = Backup::new(&src_conn, &mut dest_conn)?;
            use rusqlite::backup::StepResult;
            // 与恢复路径一致：Busy/Locked 设置重试上限，避免无限挂起
            let mut busy_retries: u32 = 0;
            loop {
                match backup.step(100)? {
                    StepResult::Done => break,
                    StepResult::More => {
                        busy_retries = 0;
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    StepResult::Busy | StepResult::Locked => {
                        busy_retries = busy_retries.saturating_add(1);
                        if busy_retries >= 1200 {
                            return Err(BackupError::Database(format!(
                                "备份数据库超时：源数据库持续被锁定（source={}）",
                                src_path.display()
                            )));
                        }
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    _ => std::thread::sleep(Duration::from_millis(50)),
                }
            }
        }
        dest_conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
        drop(dest_conn);
        drop(src_conn);
        Ok(())
    }

    /// 使用 SQLite Backup API 恢复任意路径的数据库（不依赖 DatabaseId）
    fn restore_db_at_path(src_path: &Path, dest_path: &Path) -> Result<(), BackupError> {
        if !src_path.exists() {
            return Err(BackupError::FileNotFound(format!(
                "备份文件不存在: {:?}",
                src_path
            )));
        }
        if let Some(parent) = dest_path.parent() {
            fs::create_dir_all(parent)?;
        }
        // 目标存在时先关闭 WAL
        if dest_path.exists() {
            let conn = Connection::open(dest_path)?;
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
            drop(conn);
            let wal = dest_path.with_extension("db-wal");
            let shm = dest_path.with_extension("db-shm");
            if wal.exists() {
                let _ = fs::remove_file(&wal);
            }
            if shm.exists() {
                let _ = fs::remove_file(&shm);
            }
        }
        let src_conn = Connection::open(src_path)?;
        let mut dest_conn = Connection::open(dest_path)?;
        src_conn.pragma_update(None, "busy_timeout", 5000i64)?;
        dest_conn.pragma_update(None, "busy_timeout", 5000i64)?;
        {
            let backup = Backup::new(&src_conn, &mut dest_conn)?;
            use rusqlite::backup::StepResult;
            let mut busy_retries: u32 = 0;
            loop {
                match backup.step(100)? {
                    StepResult::Done => break,
                    StepResult::More => {
                        busy_retries = 0;
                    }
                    StepResult::Busy | StepResult::Locked => {
                        busy_retries += 1;
                        if busy_retries >= 600 {
                            return Err(BackupError::RestoreFailed(format!(
                                "恢复工作区数据库超时: {:?}",
                                dest_path
                            )));
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    _ => std::thread::sleep(Duration::from_millis(50)),
                }
            }
        }
        dest_conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
        drop(dest_conn);
        drop(src_conn);
        Ok(())
    }

    /// 备份工作区数据库（ws_*.db → backup_dir/workspaces/ws_*.db）
    ///
    /// 使用 SQLite Backup API，对每个打开中的 WAL 模式数据库都是安全的。
    /// 任一目录、条目、元数据或 SQLite 备份错误都会中止当前备份，
    /// 避免把不完整的工作区集合标记为 complete。
    fn backup_workspace_databases(
        &self,
        active_dir: &Path,
        backup_dir: &Path,
    ) -> Result<Vec<BackupFile>, BackupError> {
        let src_dir = active_dir.join("workspaces");
        match fs::symlink_metadata(&src_dir) {
            Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_dir() => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Ok(_) => {
                return Err(BackupError::BackupDirectory(format!(
                    "工作区数据库根必须是普通目录: {}",
                    src_dir.display()
                )))
            }
            Err(error) => return Err(BackupError::Io(error)),
        }
        let dest_dir = backup_dir.join("workspaces");
        fs::create_dir_all(&dest_dir)?;

        let mut files = Vec::new();
        for entry in fs::read_dir(&src_dir)? {
            let entry = entry?;
            let src = entry.path();
            let name = src.file_name().unwrap_or_default().to_string_lossy();
            if !name.starts_with("ws_") || !name.ends_with(".db") {
                continue;
            }
            let metadata = fs::symlink_metadata(&src)?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(BackupError::Manifest(format!(
                    "工作区数据库必须是普通文件: {}",
                    src.display()
                )));
            }
            let dest = dest_dir.join(&*name);
            Self::backup_db_at_path(&src, &dest).map_err(|e| {
                BackupError::RestoreFailed(format!("工作区数据库备份失败 {}: {}", src.display(), e))
            })?;
            let size = fs::metadata(&dest)?.len();
            let sha256 = calculate_file_sha256(&dest)?;
            files.push(BackupFile {
                path: format!("workspaces/{}", name),
                size,
                sha256,
                database_id: None,
            });
            debug!("备份工作区数据库: {:?} -> {:?}", src, dest);
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        if !files.is_empty() {
            info!("工作区数据库备份完成: {} 个", files.len());
        }
        Ok(files)
    }

    /// 恢复工作区数据库（backup_dir/workspaces/ws_*.db → target_dir/workspaces/ws_*.db）
    ///
    /// 恢复失败记录警告但不阻断主流程。
    fn restore_workspace_databases(
        &self,
        backup_dir: &Path,
        target_dir: &Path,
    ) -> Result<usize, BackupError> {
        let src_dir = backup_dir.join("workspaces");
        if !src_dir.exists() {
            return Ok(0);
        }
        let dest_dir = target_dir.join("workspaces");
        fs::create_dir_all(&dest_dir)?;

        let mut count = 0usize;
        for entry in fs::read_dir(&src_dir)? {
            let entry = entry?;
            let src = entry.path();
            let name = src.file_name().unwrap_or_default().to_string_lossy();
            if !name.starts_with("ws_") || !name.ends_with(".db") {
                continue;
            }
            let dest = dest_dir.join(&*name);
            match Self::restore_db_at_path(&src, &dest) {
                Ok(()) => {
                    count += 1;
                    debug!("恢复工作区数据库: {:?} -> {:?}", src, dest);
                }
                Err(e) => {
                    warn!("恢复工作区数据库失败（跳过）: {:?}: {}", src, e);
                }
            }
        }
        if count > 0 {
            info!("工作区数据库恢复完成: {} 个", count);
        }
        Ok(count)
    }

    /// Restore exactly the workspace snapshots declared by the manifest.
    /// Unlisted files in the package are never made visible in the candidate slot.
    pub(crate) fn restore_workspace_manifest_files_to_dir(
        &self,
        manifest: &BackupManifest,
        backup_dir: &Path,
        target_dir: &Path,
    ) -> Result<usize, BackupError> {
        let workspace_target = target_dir.join("workspaces");
        fs::create_dir_all(&workspace_target)?;
        let mut restored = 0usize;
        for file in &manifest.files {
            if file.database_id.is_some() || !file.path.starts_with("workspaces/") {
                continue;
            }
            let relative = Path::new(&file.path);
            let source = resolve_existing_backup_file(backup_dir, relative)?;
            let name = relative.file_name().ok_or_else(|| {
                BackupError::Manifest(format!("工作区数据库路径无文件名: {}", file.path))
            })?;
            let destination =
                prepare_backup_restore_destination(&workspace_target, Path::new(name))?;
            Self::restore_db_at_path(&source, &destination)?;
            let restored_size = fs::metadata(&destination)?.len();
            if restored_size != file.size {
                return Err(BackupError::RestoreFailed(format!(
                    "工作区数据库恢复后大小不匹配 {}: expected={}, actual={}",
                    file.path, file.size, restored_size
                )));
            }
            restored += 1;
        }
        Ok(restored)
    }

    /// 恢复 manifest.files 中的非数据库文件（如 lance/ 可重建索引文件）
    pub(crate) fn restore_non_database_manifest_files(
        &self,
        manifest: &BackupManifest,
        backup_dir: &Path,
        target_dir: &Path,
    ) -> Result<usize, BackupError> {
        let mut restored = 0usize;

        for backup_file in &manifest.files {
            if backup_file.path.ends_with(".db") {
                continue;
            }
            if archive_path_requires_explicit_trust(&backup_file.path) {
                // Executable domains are restored only after an explicit UI
                // trust decision via their DomainRestorePlan.
                continue;
            }

            let rel = Path::new(&backup_file.path);
            if matches!(
                rel.components().next(),
                Some(std::path::Component::Normal(root))
                    if root == std::ffi::OsStr::new("crypto")
                        || root == std::ffi::OsStr::new("persistent")
            ) {
                // Explicit restore plans own these domains. Executable user
                // skills in particular must never be auto-trusted here.
                continue;
            }
            let src = resolve_existing_backup_file(backup_dir, rel)?;
            let dest = prepare_backup_restore_destination(target_dir, rel)?;
            fs::copy(&src, &dest)?;
            let restored_size = fs::metadata(&dest)?.len();
            if restored_size != backup_file.size {
                return Err(BackupError::RestoreFailed(format!(
                    "文件恢复后大小不匹配 {}: expected={}, actual={}",
                    backup_file.path, backup_file.size, restored_size
                )));
            }
            restored += 1;
        }

        Ok(restored)
    }

    /// 列出所有备份
    pub fn list_backups(&self) -> Result<Vec<BackupManifest>, BackupError> {
        let mut backups = Vec::new();

        if !self.backup_dir.exists() {
            return Ok(backups);
        }

        for entry in fs::read_dir(&self.backup_dir)? {
            let entry = entry?;
            let path = entry.path();

            if path.is_dir() {
                let manifest_path = path.join(MANIFEST_FILENAME);
                if manifest_path.exists() {
                    match BackupManifest::load_from_file(&manifest_path) {
                        Ok(mut manifest) => {
                            // 关键约束：backup_id 必须与目录名一致，否则删除/验证/恢复会失效。
                            // 为兼容历史数据（曾出现增量备份目录名与 manifest.backup_id 不一致的问题），这里强制以目录名为准。
                            if let Some(dir_name) =
                                path.file_name().map(|n| n.to_string_lossy().to_string())
                            {
                                if manifest.backup_id != dir_name {
                                    warn!(
                                        "备份清单 backup_id 与目录名不一致，将以目录名为准: manifest.backup_id={}, dir={}",
                                        manifest.backup_id, dir_name
                                    );
                                    manifest.backup_id = dir_name;
                                }
                            }
                            backups.push(manifest);
                        }
                        Err(e) => {
                            warn!("无法加载备份清单 {:?}: {}", manifest_path, e);
                        }
                    }
                }
            }
        }

        // 按创建时间排序（最新的在前）
        backups.sort_by(|a, b| b.created_at.cmp(&a.created_at));

        Ok(backups)
    }

    /// 删除指定的备份
    pub fn delete_backup(&self, backup_id: &str) -> Result<(), BackupError> {
        let backup_dir = self.backup_dir.join(backup_id);

        if !backup_dir.exists() {
            return Err(BackupError::FileNotFound(format!(
                "备份不存在: {}",
                backup_id
            )));
        }

        fs::remove_dir_all(&backup_dir)?;
        info!("已删除备份: {}", backup_id);

        Ok(())
    }

    /// 清理旧备份，保留指定数量
    pub fn cleanup_old_backups(&self, keep_count: usize) -> Result<Vec<String>, BackupError> {
        let mut backups = self.list_backups()?;
        let mut deleted = Vec::new();

        // Partial/legacy exports use separate retention semantics and must not
        // evict verified full recovery points.
        backups.retain(|b| !b.is_incremental && b.snapshot_kind == SnapshotKind::Full);

        if backups.len() <= keep_count {
            return Ok(deleted);
        }

        // 删除超出数量的旧备份
        for backup in backups.iter().skip(keep_count) {
            match self.delete_backup(&backup.backup_id) {
                Ok(()) => deleted.push(backup.backup_id.clone()),
                Err(e) => {
                    warn!("删除旧备份失败 {}: {}", backup.backup_id, e);
                }
            }
        }

        info!("清理旧备份完成，删除 {} 个", deleted.len());

        Ok(deleted)
    }

    // ========================================================================
    // 分层备份 (Tiered Backup) 方法
    // ========================================================================

    /// 分层备份
    ///
    /// 根据 `BackupSelection` 配置执行分层备份，支持：
    /// - 按层级选择要备份的数据
    /// - 显式包含/排除特定数据库
    /// - 可选备份资产文件
    ///
    /// ## 参数
    ///
    /// * `selection` - 备份选择配置
    ///
    /// ## 返回
    ///
    /// `TieredBackupResult` 包含备份清单和统计信息
    pub fn backup_tiered(
        &self,
        selection: &BackupSelection,
    ) -> Result<TieredBackupResult, BackupError> {
        let start = std::time::Instant::now();
        info!("开始执行分层备份，层级: {:?}", selection.tiers);

        // 1. 创建备份目录
        let (backup_id, backup_subdir) = self.create_unique_backup_subdir(Some("tiered"))?;

        info!("分层备份目录: {:?}", backup_subdir);

        // 2. 创建清单
        let mut manifest = BackupManifest::new(&self.app_version);
        manifest.backup_id = backup_id;

        // 3. 统计信息
        let mut tier_file_counts: HashMap<String, usize> = HashMap::new();
        let mut tier_sizes: HashMap<String, u64> = HashMap::new();
        let mut skipped_files: Vec<SkippedFile> = Vec::new();
        let mut backed_up_tiers: Vec<BackupTier> = Vec::new();

        // 4. 备份数据库
        let all_dbs = DatabaseId::all_ordered();
        let selected_dbs: Vec<_> = all_dbs
            .into_iter()
            .filter(|db_id| selection.should_backup_database(db_id))
            .collect();
        let total_selected = selected_dbs.len();

        for (idx, db_id) in selected_dbs.into_iter().enumerate() {
            let db_path = self.get_database_path(&db_id);

            match fs::symlink_metadata(&db_path) {
                Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_file() => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Err(BackupError::FileNotFound(format!(
                        "已选择的数据库不存在 {}: {}",
                        db_id.as_str(),
                        db_path.display()
                    )))
                }
                Ok(_) => {
                    return Err(BackupError::BackupDirectory(format!(
                        "已选择的数据库不是普通文件 {}: {}",
                        db_id.as_str(),
                        db_path.display()
                    )))
                }
                Err(error) => return Err(BackupError::Io(error)),
            }

            // 发送进度回调
            if let Some(ref cb) = self.progress_callback {
                cb(idx, total_selected, db_id.as_str(), 0, 0);
            }

            info!("备份数据库: {:?} -> {:?}", db_id, db_path);

            // 备份单个数据库
            let backup_file =
                self.backup_single_database(&db_id, &db_path, &backup_subdir, idx, total_selected)?;

            // 确定此数据库属于哪个层级
            let tier = self.get_database_tier(&db_id);
            let tier_name = format!("{:?}", tier);

            *tier_file_counts.entry(tier_name.clone()).or_insert(0) += 1;
            *tier_sizes.entry(tier_name).or_insert(0) += backup_file.size;

            let backup_path = backup_file.path.clone();
            manifest.add_file(backup_file);
            manifest.record_coverage(
                &format!("database:{}", db_id.as_str()),
                CoverageStatus::Complete,
                vec![backup_path],
                None,
            )?;

            // 获取 schema 版本
            let version = self.get_schema_version(&db_path)?;
            manifest.set_schema_version(db_id.as_str(), version);
        }

        let crypto_count = self.backup_crypto_keys(&backup_subdir)?;
        manifest.key_policy = if crypto_count > 0 {
            BackupKeyPolicy::IncludedLocal
        } else {
            BackupKeyPolicy::NotPresent
        };
        let crypto_files = Self::collect_backup_files_under(&backup_subdir, "crypto")?;
        if crypto_files.is_empty() {
            let status = match fs::symlink_metadata(backup_subdir.join("crypto")) {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                    CoverageStatus::Empty
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    CoverageStatus::Absent
                }
                Ok(_) => {
                    return Err(BackupError::BackupDirectory(
                        "crypto 归档根不是普通目录".to_string(),
                    ))
                }
                Err(error) => return Err(BackupError::Io(error)),
            };
            manifest.record_coverage("crypto", status, Vec::new(), None)?;
        } else {
            let paths = crypto_files.iter().map(|file| file.path.clone()).collect();
            manifest.files.extend(crypto_files);
            manifest.record_coverage("crypto", CoverageStatus::Complete, paths, None)?;
        }
        if self.backup_audit_db(&backup_subdir)? {
            let audit_file = Self::backup_file_metadata(&backup_subdir, "databases/audit.db")?;
            let path = audit_file.path.clone();
            manifest.add_file(audit_file);
            manifest.record_coverage("audit", CoverageStatus::Complete, vec![path], None)?;
        } else {
            manifest.record_coverage("audit", CoverageStatus::Absent, Vec::new(), None)?;
        }

        // 4.5 备份工作区数据库（ws_*.db）
        let active_dir_for_ws = self.active_data_dir_for_backup();
        let workspace_files =
            self.backup_workspace_databases(&active_dir_for_ws, &backup_subdir)?;
        if !workspace_files.is_empty() {
            info!("工作区数据库备份完成: {} 个", workspace_files.len());
        }
        let workspace_paths = workspace_files
            .iter()
            .map(|file| file.path.clone())
            .collect::<Vec<_>>();
        manifest.files.extend(workspace_files);
        let workspace_root = active_dir_for_ws.join("workspaces");
        let workspace_status = if !workspace_paths.is_empty() {
            CoverageStatus::Complete
        } else {
            match fs::symlink_metadata(&workspace_root) {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                    CoverageStatus::Empty
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    CoverageStatus::Absent
                }
                Ok(_) => {
                    return Err(BackupError::BackupDirectory(format!(
                        "工作区数据库根不是普通目录: {}",
                        workspace_root.display()
                    )))
                }
                Err(error) => return Err(BackupError::Io(error)),
            }
        };
        manifest.record_coverage("workspaces-root", workspace_status, workspace_paths, None)?;
        self.backup_standalone_persistent_domains(&backup_subdir, &mut manifest)?;

        // 5. 备份资产文件（如果启用）
        let active_asset_base = self.active_data_dir_for_backup();
        let mut attempted_asset_roots = HashSet::new();
        let mut failed_asset_roots = HashSet::new();
        if selection.include_assets {
            let asset_config = selection.asset_config.clone().unwrap_or_default();
            let asset_dirs = selection.get_asset_directories();

            // 如果指定了 asset_types，只备份匹配的目录；否则按 tier 全部备份
            let allowed_dirs: std::collections::HashSet<&str> =
                if !asset_config.asset_types.is_empty() {
                    asset_config
                        .asset_types
                        .iter()
                        .map(|t| t.relative_path())
                        .collect()
                } else {
                    asset_dirs.iter().copied().collect()
                };

            for dir_name in asset_dirs {
                // 跳过不在 asset_types 筛选列表中的目录
                if !allowed_dirs.contains(dir_name) {
                    debug!("资产目录 {} 不在 asset_types 筛选列表中，跳过", dir_name);
                    continue;
                }

                if AssetType::all()
                    .into_iter()
                    .any(|asset_type| asset_type.relative_path() == dir_name)
                {
                    attempted_asset_roots.insert(dir_name.to_string());
                }

                let asset_dir = active_asset_base.join(dir_name);
                match fs::symlink_metadata(&asset_dir) {
                    Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_dir() => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        debug!("资产目录不存在，跳过: {:?}", asset_dir);
                        continue;
                    }
                    Ok(_) => {
                        return Err(BackupError::BackupDirectory(format!(
                            "资产域根必须是普通目录: {}",
                            asset_dir.display()
                        )))
                    }
                    Err(error) => return Err(BackupError::Io(error)),
                }

                info!("备份资产目录: {:?}", asset_dir);

                let (files, skipped) = self.backup_asset_directory(
                    &asset_dir,
                    dir_name,
                    &backup_subdir,
                    &asset_config,
                )?;
                if !skipped.is_empty() {
                    failed_asset_roots.insert(dir_name.to_string());
                }

                if dir_name == "databases/lance/vfs" && skipped.is_empty() {
                    manifest
                        .included_components
                        .push("rebuildable-root:databases/lance/vfs".to_string());
                }

                for file in files {
                    let tier_name = "LargeAssets".to_string();
                    *tier_file_counts.entry(tier_name.clone()).or_insert(0) += 1;
                    *tier_sizes.entry(tier_name).or_insert(0) += file.size;
                    manifest.add_file(file);
                }

                skipped_files.extend(skipped);
            }
        }

        for asset_type in AssetType::all() {
            let root = asset_type.relative_path();
            let domain_id = format!("asset-root:{}", root);
            if !attempted_asset_roots.contains(root) {
                manifest.record_coverage(
                    &domain_id,
                    CoverageStatus::Excluded,
                    Vec::new(),
                    Some("tiered selection did not include this asset root".to_string()),
                )?;
                continue;
            }
            let prefix = format!("{}/", root);
            let paths = manifest
                .files
                .iter()
                .filter(|file| file.path.starts_with(&prefix))
                .map(|file| file.path.clone())
                .collect::<Vec<_>>();
            let status = if failed_asset_roots.contains(root) {
                CoverageStatus::Failed
            } else if !paths.is_empty() {
                CoverageStatus::Complete
            } else {
                match fs::symlink_metadata(active_asset_base.join(root)) {
                    Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                        CoverageStatus::Empty
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        CoverageStatus::Absent
                    }
                    Ok(_) => CoverageStatus::Failed,
                    Err(error) => return Err(BackupError::Io(error)),
                }
            };
            manifest.record_coverage(
                &domain_id,
                status,
                paths,
                (status == CoverageStatus::Failed)
                    .then(|| "tiered asset policy skipped one or more files".to_string()),
            )?;
        }
        if attempted_asset_roots.contains("workspaces") {
            let agent_paths = manifest
                .files
                .iter()
                .filter(|file| file.path.starts_with("workspaces/agents/"))
                .map(|file| file.path.clone())
                .collect::<Vec<_>>();
            let status = if failed_asset_roots.contains("workspaces") {
                CoverageStatus::Failed
            } else if !agent_paths.is_empty() {
                CoverageStatus::Complete
            } else {
                let agents_root = active_asset_base.join("workspaces/agents");
                match fs::symlink_metadata(&agents_root) {
                    Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                        CoverageStatus::Empty
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        CoverageStatus::Absent
                    }
                    Ok(_) => CoverageStatus::Failed,
                    Err(error) => return Err(BackupError::Io(error)),
                }
            };
            manifest.record_coverage(
                "agents",
                status,
                agent_paths,
                Some("restored agents remain untrusted until explicit review".to_string()),
            )?;
        } else {
            manifest.record_coverage(
                "agents",
                CoverageStatus::Excluded,
                Vec::new(),
                Some("workspaces assets were not selected".to_string()),
            )?;
        }

        // 6. 记录备份的层级
        for tier in BackupTier::all_ordered() {
            let tier_name = format!("{:?}", tier);
            if tier_file_counts.contains_key(&tier_name) {
                backed_up_tiers.push(tier);
            }
        }

        if manifest.mark_full().is_err() {
            manifest.mark_partial();
        }

        // 7. 仅在清单及已选域自检通过后发布。
        self.publish_verified_manifest(&manifest, &backup_subdir)?;

        let duration_ms = start.elapsed().as_millis() as u64;

        info!(
            "分层备份完成，共 {} 个文件，耗时 {}ms",
            manifest.files.len(),
            duration_ms
        );

        Ok(TieredBackupResult {
            manifest,
            backed_up_tiers,
            tier_file_counts,
            tier_sizes,
            skipped_files,
            duration_ms,
        })
    }

    /// 获取数据库所属的层级
    fn get_database_tier(&self, db_id: &DatabaseId) -> BackupTier {
        for tier in BackupTier::all_ordered() {
            if tier.databases().contains(db_id) {
                return tier;
            }
        }
        // 默认为 Important 层级
        BackupTier::Important
    }

    /// 备份资产目录
    ///
    /// 遍历目录并备份符合条件的文件
    fn backup_asset_directory(
        &self,
        source_dir: &Path,
        dir_name: &str,
        backup_dir: &Path,
        config: &TieredAssetConfig,
    ) -> Result<(Vec<BackupFile>, Vec<SkippedFile>), BackupError> {
        let mut files = Vec::new();
        let mut skipped = Vec::new();

        // 创建目标目录
        let target_dir = backup_dir.join(dir_name);
        fs::create_dir_all(&target_dir)?;

        // 遍历源目录
        let walker = WalkDir::new(source_dir)
            // Backup archives never follow links, even when an old tiered
            // option requested it. Following links can escape the declared
            // persistent domain and cannot support Full evidence.
            .follow_links(false)
            .into_iter();

        for entry in walker {
            let entry = entry
                .map_err(|e| BackupError::BackupDirectory(format!("遍历资产目录失败: {}", e)))?;

            let path = entry.path();
            let relative_path = path
                .strip_prefix(source_dir)
                .map_err(|_| BackupError::BackupDirectory("无法计算相对路径".to_string()))?;
            if entry.depth() == 0 {
                continue;
            }
            if !config.include_hidden
                && relative_path.components().any(|component| {
                    matches!(
                        component,
                        std::path::Component::Normal(name)
                            if name.to_string_lossy().starts_with('.')
                    )
                })
            {
                if entry.file_type().is_file() || entry.file_type().is_symlink() {
                    skipped.push(SkippedFile {
                        path: relative_path.to_string_lossy().to_string(),
                        reason: "隐藏资产未包含".to_string(),
                    });
                }
                continue;
            }
            if entry.file_type().is_symlink() {
                skipped.push(SkippedFile {
                    path: relative_path.to_string_lossy().to_string(),
                    reason: "符号链接资产未包含".to_string(),
                });
                continue;
            }
            if entry.file_type().is_dir() {
                continue;
            }
            if !entry.file_type().is_file() {
                return Err(BackupError::BackupDirectory(format!(
                    "资产目录包含非常规条目: {}",
                    path.display()
                )));
            }

            // Workspace SQLite databases are captured above with SQLite's
            // Backup API. Raw db/WAL/SHM copies would create a torn second copy.
            if dir_name == "workspaces" {
                let name = path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("");
                if name.ends_with(".db") || name.ends_with("-wal") || name.ends_with("-shm") {
                    continue;
                }
            }

            // 检查文件扩展名
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                let ext_lower = ext.to_lowercase();

                // 排除的扩展名
                if config
                    .exclude_extensions
                    .iter()
                    .any(|e| e.to_lowercase() == ext_lower)
                {
                    skipped.push(SkippedFile {
                        path: relative_path.to_string_lossy().to_string(),
                        reason: format!("排除的扩展名: {}", ext),
                    });
                    continue;
                }

                // 包含的扩展名（如果指定了的话）
                if !config.include_extensions.is_empty()
                    && !config
                        .include_extensions
                        .iter()
                        .any(|e| e.to_lowercase() == ext_lower)
                {
                    skipped.push(SkippedFile {
                        path: relative_path.to_string_lossy().to_string(),
                        reason: format!("不在包含列表中: {}", ext),
                    });
                    continue;
                }
            }

            // 检查文件大小
            let metadata = fs::symlink_metadata(path)?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(BackupError::BackupDirectory(format!(
                    "资产条目在读取元数据期间变为非常规文件: {}",
                    path.display()
                )));
            }
            if metadata.len() > config.max_file_size {
                skipped.push(SkippedFile {
                    path: relative_path.to_string_lossy().to_string(),
                    reason: format!(
                        "文件过大: {} bytes > {} bytes",
                        metadata.len(),
                        config.max_file_size
                    ),
                });
                continue;
            }

            // 复制文件
            let target_path = target_dir.join(relative_path);
            if let Some(parent) = target_path.parent() {
                fs::create_dir_all(parent)?;
            }
            let copied = fs::copy(path, &target_path)?;
            if copied != metadata.len() || fs::metadata(&target_path)?.len() != metadata.len() {
                return Err(BackupError::BackupDirectory(format!(
                    "资产复制后大小不一致: {}",
                    path.display()
                )));
            }

            // Hash both sides so a same-length source mutation cannot silently
            // turn a tiered asset copy into complete evidence.
            let sha256 = calculate_file_sha256_exact(&target_path, metadata.len())?;
            let source_sha256 = calculate_file_sha256_exact(path, metadata.len())?;
            if source_sha256 != sha256 {
                return Err(BackupError::BackupDirectory(format!(
                    "资产复制前后内容不一致: {}",
                    path.display()
                )));
            }

            files.push(BackupFile {
                path: format!("{}/{}", dir_name, relative_path.to_string_lossy()),
                size: metadata.len(),
                sha256,
                database_id: None,
            });
        }

        debug!(
            "资产目录 {} 备份完成：{} 个文件，{} 个跳过",
            dir_name,
            files.len(),
            skipped.len()
        );

        Ok((files, skipped))
    }
}

/// 计算文件的 SHA256 校验和
pub(crate) fn calculate_file_sha256(path: &Path) -> Result<String, BackupError> {
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

fn calculate_file_sha256_exact(path: &Path, expected_size: u64) -> Result<String, BackupError> {
    let file = File::open(path)?;
    let mut reader = BufReader::new(file).take(expected_size.saturating_add(1));
    let mut hasher = Sha256::new();
    let mut bytes_hashed = 0u64;
    let mut buffer = [0u8; 8192];

    loop {
        let bytes_read = reader.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }
        bytes_hashed = bytes_hashed.saturating_add(bytes_read as u64);
        if bytes_hashed > expected_size {
            return Err(BackupError::Manifest(format!(
                "文件在校验期间增长: {}",
                path.display()
            )));
        }
        hasher.update(&buffer[..bytes_read]);
    }
    if bytes_hashed != expected_size {
        return Err(BackupError::Manifest(format!(
            "文件在校验期间大小发生变化: expected={}, actual={}",
            expected_size, bytes_hashed
        )));
    }

    Ok(hex::encode(hasher.finalize()))
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup_test_env() -> (BackupManager, TempDir, TempDir) {
        let backup_dir = TempDir::new().unwrap();
        let app_data_dir = TempDir::new().unwrap();

        let mut manager = BackupManager::new(backup_dir.path().to_path_buf());
        manager.set_app_data_dir(app_data_dir.path().to_path_buf());
        manager.set_app_version("1.0.0".to_string());

        let active_dir = app_data_dir.path().join("slots").join("slotA");
        for database_id in DatabaseId::all_ordered() {
            let path = BackupManager::resolve_database_path_in_dir(&active_dir, &database_id);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            Connection::open(path).unwrap();
        }

        (manager, backup_dir, app_data_dir)
    }

    fn create_test_database(path: &Path) -> rusqlite::Result<()> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "CREATE TABLE test_table (id INTEGER PRIMARY KEY, name TEXT);
             INSERT INTO test_table (name) VALUES ('test1'), ('test2');",
        )?;
        Ok(())
    }

    /// S0: 创建增量备份必须立即失败，且不得写入任何备份产物
    #[test]
    fn backup_incremental_create_returns_removed_error() {
        let (manager, backup_dir, _app_data) = setup_test_env();
        // 即使提供一个“存在的”基础备份目录，也不应创建增量包
        let base_id = "20260101_000000";
        fs::create_dir_all(backup_dir.path().join(base_id)).unwrap();

        let before: Vec<_> = fs::read_dir(backup_dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name())
            .collect();

        let err = manager
            .backup_incremental(base_id)
            .expect_err("incremental create must fail");

        match &err {
            BackupError::IncrementalBackupRemoved(msg) => {
                assert!(
                    msg.contains("Incremental backup has been removed"),
                    "error must state incremental create was removed, got: {}",
                    msg
                );
                assert!(
                    msg.contains("full backup") || msg.contains("cloud sync"),
                    "error must point users to full backup or cloud sync, got: {}",
                    msg
                );
            }
            other => panic!("expected IncrementalBackupRemoved, got: {}", other),
        }

        let after: Vec<_> = fs::read_dir(backup_dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name())
            .collect();
        assert_eq!(
            before, after,
            "incremental create must not write any backup artifacts"
        );
    }

    /// S0: 旧版增量 manifest 恢复必须诚实拒绝（不得静默成功/转全量）
    #[test]
    fn restore_rejects_legacy_incremental_manifest() {
        let backup_dir = TempDir::new().unwrap();
        let app_data_dir = TempDir::new().unwrap();
        let mut manager = BackupManager::new(backup_dir.path().to_path_buf());
        manager.set_app_data_dir(app_data_dir.path().to_path_buf());
        manager.set_app_version("1.0.0".to_string());

        let mut manifest = BackupManifest::new("1.0.0");
        manifest.backup_id = "incr_legacy".to_string();
        manifest.is_incremental = true;
        manifest.incremental_base = Some("20260101_000000".to_string());
        manifest.add_file(BackupFile {
            path: "vfs_changes.json".to_string(),
            size: 0,
            sha256: String::new(),
            database_id: Some("vfs".to_string()),
        });

        let sub = backup_dir.path().join("incr_legacy");
        fs::create_dir_all(&sub).unwrap();
        let payload = br#"[{"id":1,"table_name":"resources","record_id":"r1","operation":"INSERT","changed_at":"2026-01-01T00:00:00Z","sync_version":0}]"#;
        fs::write(sub.join("vfs_changes.json"), payload).unwrap();
        let real_sha = calculate_file_sha256(&sub.join("vfs_changes.json")).unwrap();
        manifest.files[0].sha256 = real_sha;
        manifest.files[0].size = payload.len() as u64;
        manifest.save_to_file(&sub.join(MANIFEST_FILENAME)).unwrap();

        let result = manager.restore(&manifest);
        assert!(
            result.is_err(),
            "legacy incremental restore must be rejected"
        );
        let err = result.unwrap_err();
        match &err {
            BackupError::IncrementalRestoreNotSupported(msg) => {
                assert_eq!(
                    msg.as_str(),
                    INCREMENTAL_RESTORE_NOT_SUPPORTED_MESSAGE,
                    "restore error must use the shared English ban message, got: {}",
                    msg
                );
            }
            other => panic!(
                "expected IncrementalRestoreNotSupported (honest reject), got: {}",
                other
            ),
        }
    }

    /// 行为级：真实临时目录构造历史 incremental 包 → list 识别为 legacy，restore 被拒
    #[test]
    fn legacy_incremental_listed_as_incremental_and_restore_rejected() {
        let backup_dir = TempDir::new().unwrap();
        let app_data_dir = TempDir::new().unwrap();
        let mut manager = BackupManager::new(backup_dir.path().to_path_buf());
        manager.set_app_data_dir(app_data_dir.path().to_path_buf());
        manager.set_app_version("1.0.0".to_string());

        // 旁路：一个可识别的 full 快照，确保 list 不会误滤 incremental
        let mut full = BackupManifest::new("1.0.0");
        full.version = "2.0.0".to_string();
        full.coverage = None;
        full.backup_id = "20260701_full".to_string();
        full.is_incremental = false;
        full.snapshot_kind = SnapshotKind::Full;
        let full_dir = backup_dir.path().join("20260701_full");
        fs::create_dir_all(&full_dir).unwrap();
        full.save_to_file(&full_dir.join(MANIFEST_FILENAME))
            .unwrap();

        let mut incr = BackupManifest::new("1.0.0");
        incr.version = "2.0.0".to_string();
        incr.coverage = None;
        incr.backup_id = "20260702_incremental".to_string();
        incr.is_incremental = true;
        incr.incremental_base = Some("20260701_full".to_string());
        incr.add_file(BackupFile {
            path: "vfs_changes.json".to_string(),
            size: 0,
            sha256: String::new(),
            database_id: Some("vfs".to_string()),
        });
        let incr_dir = backup_dir.path().join("20260702_incremental");
        fs::create_dir_all(&incr_dir).unwrap();
        let payload = br#"[{"id":1,"table_name":"resources","record_id":"r1","operation":"INSERT","changed_at":"2026-07-02T00:00:00Z","sync_version":0}]"#;
        fs::write(incr_dir.join("vfs_changes.json"), payload).unwrap();
        let real_sha = calculate_file_sha256(&incr_dir.join("vfs_changes.json")).unwrap();
        incr.files[0].sha256 = real_sha;
        incr.files[0].size = payload.len() as u64;
        incr.save_to_file(&incr_dir.join(MANIFEST_FILENAME))
            .unwrap();

        let listed = manager
            .list_backups()
            .expect("list_backups must succeed on real temp dirs");
        assert!(
            listed.len() >= 2,
            "list must include both full and incremental packages, got {}",
            listed.len()
        );
        let listed_incr = listed
            .iter()
            .find(|m| m.backup_id == "20260702_incremental")
            .expect("historical incremental package must appear in backup list");
        assert!(
            listed_incr.is_incremental,
            "list must mark historical package as incremental (legacy)"
        );
        assert_eq!(
            listed_incr.incremental_base.as_deref(),
            Some("20260701_full")
        );

        // 与命令层 list 映射一致：is_incremental → backup_type "incremental"
        let command_layer_type = if listed_incr.is_incremental {
            "incremental"
        } else {
            "full"
        };
        assert_eq!(command_layer_type, "incremental");

        let restore_err = manager
            .restore(listed_incr)
            .expect_err("restore of listed incremental must be rejected");
        match restore_err {
            BackupError::IncrementalRestoreNotSupported(msg) => {
                assert_eq!(msg.as_str(), INCREMENTAL_RESTORE_NOT_SUPPORTED_MESSAGE);
            }
            other => panic!("expected IncrementalRestoreNotSupported, got: {}", other),
        }
    }

    #[test]
    fn backup_crypto_keys_excludes_codex_oauth_session() {
        let (manager, _backup_dir, app_data_dir) = setup_test_env();
        let secure_dir = app_data_dir.path().join(".secure");
        fs::create_dir_all(&secure_dir).unwrap();
        fs::write(secure_dir.join(".key_seed"), b"seed").unwrap();
        fs::write(
            secure_dir.join("internal.oauth.openai_codex.session.enc"),
            b"device-local-refresh-token",
        )
        .unwrap();
        fs::write(secure_dir.join("regular.api_key.enc"), b"portable-secret").unwrap();

        let backup_subdir = app_data_dir.path().join("backup-output");
        fs::create_dir_all(&backup_subdir).unwrap();
        let count = manager.backup_crypto_keys(&backup_subdir).unwrap();
        let backed_up_secure = backup_subdir.join("crypto").join(".secure");

        assert_eq!(count, 2);
        assert!(backed_up_secure.join(".key_seed").is_file());
        assert!(backed_up_secure.join("regular.api_key.enc").is_file());
        assert!(!backed_up_secure
            .join("internal.oauth.openai_codex.session.enc")
            .exists());
    }

    #[test]
    fn root_crypto_and_audit_are_found_when_manager_receives_active_slot() {
        let backup_root = TempDir::new().unwrap();
        let app_data_root = TempDir::new().unwrap();
        let active_slot = app_data_root.path().join("slots").join("slotA");
        fs::create_dir_all(&active_slot).unwrap();

        let secure_dir = app_data_root.path().join(".secure");
        fs::create_dir_all(&secure_dir).unwrap();
        fs::write(secure_dir.join(".key_seed"), b"seed").unwrap();
        let audit_path = app_data_root.path().join("databases").join("audit.db");
        fs::create_dir_all(audit_path.parent().unwrap()).unwrap();
        Connection::open(&audit_path)
            .unwrap()
            .execute_batch("CREATE TABLE audit_probe (id INTEGER PRIMARY KEY);")
            .unwrap();

        let mut manager = BackupManager::new(backup_root.path().to_path_buf());
        manager.set_app_data_dir(active_slot);
        assert_eq!(manager.application_data_root(), app_data_root.path());
        let output = backup_root.path().join("output");
        fs::create_dir_all(&output).unwrap();

        assert_eq!(manager.backup_crypto_keys(&output).unwrap(), 1);
        assert!(manager.backup_audit_db(&output).unwrap());
        assert!(output.join("crypto/.secure/.key_seed").is_file());
        assert!(output.join("databases/audit.db").is_file());
    }

    #[test]
    fn test_new_manager() {
        let dir = TempDir::new().unwrap();
        let manager = BackupManager::new(dir.path().to_path_buf());
        assert_eq!(manager.backup_dir(), dir.path());
    }

    #[test]
    fn test_verify_rejects_manifest_file_path_traversal_before_reading() {
        let (manager, _backup_root, _app_data) = setup_test_env();
        let parent = TempDir::new().unwrap();
        let backup_dir = parent.path().join("backup");
        fs::create_dir(&backup_dir).unwrap();
        let outside = parent.path().join("outside-manifest-probe");
        fs::write(&outside, b"outside").unwrap();
        let mut manifest = BackupManifest::new("1.0.0");
        manifest.files.push(BackupFile {
            path: "../outside-manifest-probe".to_string(),
            size: 7,
            sha256: calculate_file_sha256(&outside).unwrap(),
            database_id: None,
        });

        let error = manager
            .verify_internal(&manifest, &backup_dir)
            .expect_err("parent traversal must be rejected before hash/open");

        assert!(matches!(error, BackupError::Manifest(_)));
    }

    #[cfg(unix)]
    #[test]
    fn test_verify_rejects_symlinked_manifest_file() {
        let (manager, _backup_root, _app_data) = setup_test_env();
        let backup_dir = TempDir::new().unwrap();
        let external = TempDir::new().unwrap();
        fs::write(external.path().join("outside.bin"), b"outside").unwrap();
        std::os::unix::fs::symlink(
            external.path().join("outside.bin"),
            backup_dir.path().join("linked.bin"),
        )
        .unwrap();
        let mut manifest = BackupManifest::new("1.0.0");
        manifest.files.push(BackupFile {
            path: "linked.bin".to_string(),
            size: 7,
            sha256: calculate_file_sha256(&external.path().join("outside.bin")).unwrap(),
            database_id: None,
        });

        let error = manager
            .verify_internal(&manifest, backup_dir.path())
            .expect_err("symlinked manifest file must be rejected");

        assert!(format!("{error}").contains("符号链接"));
    }

    #[test]
    fn test_manifest_loader_rejects_oversized_file_before_allocation() {
        let dir = TempDir::new().unwrap();
        let manifest_path = dir.path().join("manifest.json");
        let file = File::create(&manifest_path).unwrap();
        file.set_len(MAX_MANIFEST_BYTES + 1).unwrap();

        let error = BackupManifest::load_from_file(&manifest_path)
            .expect_err("oversized manifest must fail before parsing");

        assert!(matches!(error, BackupError::Manifest(_)));
    }

    #[test]
    fn test_list_backups_overrides_manifest_backup_id_with_dir_name() {
        let backup_dir = TempDir::new().unwrap();

        // 历史问题复现：目录名与 manifest.backup_id 不一致
        let backup_dir_name = "20260207_120000_incr";
        let backup_subdir = backup_dir.path().join(backup_dir_name);
        std::fs::create_dir_all(&backup_subdir).unwrap();

        let mut manifest = BackupManifest::new("1.0.0-test");
        manifest.backup_id = "WRONG_ID".to_string();
        manifest
            .save_to_file(&backup_subdir.join(MANIFEST_FILENAME))
            .unwrap();

        let manager = BackupManager::new(backup_dir.path().to_path_buf());
        let backups = manager.list_backups().unwrap();

        assert_eq!(backups.len(), 1);
        assert_eq!(backups[0].backup_id, backup_dir_name);
    }

    #[test]
    fn test_manifest_serialization() {
        let mut manifest = BackupManifest::new("1.0.0");
        manifest.add_file(BackupFile {
            path: "test.db".to_string(),
            size: 1024,
            sha256: "abc123".to_string(),
            database_id: Some("test".to_string()),
        });
        manifest.set_schema_version("test", 1);

        let json = serde_json::to_string(&manifest).unwrap();
        let loaded: BackupManifest = serde_json::from_str(&json).unwrap();

        assert_eq!(loaded.version, manifest.version);
        assert_eq!(loaded.files.len(), 1);
        assert_eq!(loaded.schema_versions.get("test"), Some(&1));
    }

    #[test]
    fn incomplete_vfs_lance_restore_removes_partial_files_and_resets_local_manifest() {
        let (target, db) = crate::vfs::database::setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        conn.execute(
            "INSERT INTO resources
             (id, hash, type, storage_mode, data, ref_count, created_at, updated_at)
             VALUES ('res_restore_index', 'hash_restore_index', 'note', 'inline', 'text', 0, 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE resources SET
                index_state = 'indexed', index_hash = 'old-hash', index_error = 'old-error',
                indexed_at = 10, index_retry_count = 9, index_next_retry_at = 99,
                index_generation = 7, mm_index_state = NULL, mm_index_error = 'old-mm-error',
                mm_index_retry_count = 8, mm_index_next_retry_at = 88,
                mm_embedding_dim = 64, mm_indexing_mode = 'old-mode',
                mm_indexed_at = 11, mm_index_generation = 6
             WHERE id = 'res_restore_index'",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO vfs_index_units
             (id, resource_id, unit_index, text_required, text_state, text_error,
              text_indexed_at, text_chunk_count, text_embedding_dim,
              mm_required, mm_state, mm_error, mm_indexed_at, mm_embedding_dim,
              created_at, updated_at, text_profile_id, text_generation,
              mm_profile_id, mm_generation)
             VALUES ('unit_restore_index', 'res_restore_index', 0, 1, 'indexed', 'old-text',
                     10, 1, 64, 0, 'disabled', 'old-mm', 11, 64, 1, 1,
                     'profile_text_old', 7, 'profile_mm_old', 6)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO vfs_index_segments
             (id, unit_id, segment_index, modality, embedding_dim, lance_row_id,
              created_at, updated_at, index_profile_id, generation)
             VALUES ('segment_restore_index', 'unit_restore_index', 0, 'text', 64,
                     'row_restore_index', 1, 1, 'profile_text_old', 7)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO __lance_orphan_queue (lance_row_id, resource_id)
             VALUES ('orphan_restore_index', 'res_restore_index')",
            [],
        )
        .unwrap();
        let profile = crate::vfs::repos::embedding_dim_repo::register_with_model(
            &conn,
            128,
            "text",
            Some("cfg_restore_profile"),
            Some("model_restore_profile"),
        )
        .unwrap();
        let restored_profile_id = profile.active_profile_id.unwrap();
        conn.execute(
            "UPDATE vfs_embedding_dims SET record_count = 9, active_generation = 4,
                    ann_metric = 'cosine', ann_index_version = 1
             WHERE dimension = 128 AND modality = 'text'",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE vfs_index_profiles SET state = 'queryable', active_generation = 4,
                    ann_metric = 'cosine', ann_index_version = 1
             WHERE id = ?1",
            [&restored_profile_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO files
             (id, sha256, file_name, size, created_at, updated_at,
              mm_index_state, mm_index_error, mm_indexed_pages_json)
             VALUES ('file_restore_index', 'sha_restore_index', 'restore.pdf', 1, '1', '1',
                     'indexed', 'old-file-error', '[{\"page\":1}]')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO exam_sheets
             (id, status, temp_id, metadata_json, preview_json, created_at, updated_at,
              mm_index_state, mm_index_error, mm_indexed_pages_json,
              mm_embedding_dim, mm_indexing_mode, mm_indexed_at)
             VALUES ('exam_restore_index', 'completed', 'temp_restore', '{}', '{}', '1', '1',
                     'indexed', 'old-exam-error', '[{\"page\":1}]', 128, 'old-mode', 12)",
            [],
        )
        .unwrap();
        drop(conn);

        let lance_dir = target
            .path()
            .join("databases/lance/vfs/partial_table.lance");
        fs::create_dir_all(&lance_dir).unwrap();
        fs::write(lance_dir.join("partial.bin"), b"partial").unwrap();

        let manifest = BackupManifest::new("1.0.0");
        BackupManager::finalize_vfs_index_restore(&manifest, target.path(), true).unwrap();

        assert!(!target.path().join("databases/lance/vfs").exists());
        let conn = db.get_conn_safe().unwrap();
        let resource: (
            String,
            Option<String>,
            i32,
            i64,
            i64,
            Option<String>,
            Option<String>,
            Option<i32>,
            Option<String>,
            i32,
            i64,
            i64,
        ) = conn
            .query_row(
                "SELECT index_state, index_hash, index_retry_count, index_next_retry_at,
                        index_generation, mm_index_state, mm_index_error, mm_embedding_dim,
                        mm_indexing_mode, mm_index_retry_count, mm_index_next_retry_at,
                        mm_index_generation
                 FROM resources WHERE id = 'res_restore_index'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                        row.get(9)?,
                        row.get(10)?,
                        row.get(11)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(resource.0, "pending");
        assert_eq!(resource.1, None);
        assert_eq!((resource.2, resource.3, resource.4), (0, 0, 0));
        assert_eq!(resource.5, None, "non-MM resources must stay non-MM");
        assert_eq!(resource.6, None);
        assert_eq!(resource.7, None);
        assert_eq!(resource.8, None);
        assert_eq!((resource.9, resource.10, resource.11), (0, 0, 0));

        let unit: (String, Option<String>, i64, String, Option<String>, i64) = conn
            .query_row(
                "SELECT text_state, text_profile_id, text_generation,
                        mm_state, mm_profile_id, mm_generation
                 FROM vfs_index_units WHERE id = 'unit_restore_index'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            unit,
            (
                "pending".to_string(),
                None,
                0,
                "disabled".to_string(),
                None,
                0
            )
        );
        let segment_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM vfs_index_segments", [], |row| {
                row.get(0)
            })
            .unwrap();
        let orphan_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM __lance_orphan_queue", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!((segment_count, orphan_count), (0, 0));
        let dim_state: (i64, i64, String, i32) = conn
            .query_row(
                "SELECT record_count, active_generation, ann_metric, ann_index_version
                 FROM vfs_embedding_dims WHERE dimension = 128 AND modality = 'text'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(dim_state, (0, 0, "exact".to_string(), 0));
        let profile_state: (String, i64, String, i32) = conn
            .query_row(
                "SELECT state, active_generation, ann_metric, ann_index_version
                 FROM vfs_index_profiles WHERE id = ?1",
                [&restored_profile_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            profile_state,
            ("active".to_string(), 0, "exact".to_string(), 0)
        );
        let file_mm: (Option<String>, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT mm_index_state, mm_index_error, mm_indexed_pages_json
                 FROM files WHERE id = 'file_restore_index'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(file_mm, (Some("pending".to_string()), None, None));
        let exam_mm: (
            Option<String>,
            Option<String>,
            Option<String>,
            Option<i32>,
            Option<String>,
            Option<i64>,
        ) = conn
            .query_row(
                "SELECT mm_index_state, mm_index_error, mm_indexed_pages_json,
                        mm_embedding_dim, mm_indexing_mode, mm_indexed_at
                 FROM exam_sheets WHERE id = 'exam_restore_index'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            exam_mm,
            (Some("pending".to_string()), None, None, None, None, None)
        );
    }

    #[test]
    fn vfs_lance_restore_contract_handles_legacy_schema_and_preserves_complete_component() {
        let legacy = TempDir::new().unwrap();
        let db_dir = legacy.path().join("databases");
        fs::create_dir_all(&db_dir).unwrap();
        let conn = Connection::open(db_dir.join("vfs.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE legacy_payload (id INTEGER PRIMARY KEY, value TEXT);
             INSERT INTO legacy_payload (value) VALUES ('kept');",
        )
        .unwrap();
        drop(conn);
        let partial = db_dir.join("lance/vfs/partial.lance");
        fs::create_dir_all(&partial).unwrap();
        fs::write(partial.join("partial.bin"), b"partial").unwrap();
        BackupManager::finalize_vfs_index_restore(
            &BackupManifest::new("legacy"),
            legacy.path(),
            true,
        )
        .unwrap();
        assert!(!db_dir.join("lance/vfs").exists());
        let conn = Connection::open(db_dir.join("vfs.db")).unwrap();
        let kept: String = conn
            .query_row("SELECT value FROM legacy_payload", [], |row| row.get(0))
            .unwrap();
        assert_eq!(kept, "kept");

        let complete = TempDir::new().unwrap();
        let complete_lance = complete.path().join("databases/lance/vfs/table.lance");
        fs::create_dir_all(&complete_lance).unwrap();
        fs::write(complete_lance.join("data.bin"), b"complete").unwrap();
        let mut manifest = BackupManifest::new("complete");
        manifest
            .included_components
            .push("rebuildable-root:databases/lance/vfs".to_string());
        BackupManager::finalize_vfs_index_restore(&manifest, complete.path(), true).unwrap();
        assert!(complete_lance.join("data.bin").exists());
    }

    #[test]
    fn test_backup_and_restore_single_database() {
        let (manager, backup_dir, app_data_dir) = setup_test_env();

        // 创建测试数据库目录（模拟活动数据空间 slots/slotA）
        let active_dir = app_data_dir.path().join("slots").join("slotA");
        let db_dir = active_dir.join("databases");
        fs::create_dir_all(&db_dir).unwrap();

        // 创建 VFS 测试数据库
        let vfs_db_path = db_dir.join("vfs.db");
        create_test_database(&vfs_db_path).unwrap();

        // 执行备份
        let manifest = manager.backup_full().unwrap();

        assert!(!manifest.files.is_empty());
        assert!(manifest.files.iter().any(|f| f.path == "vfs.db"));

        // 验证备份
        manager.verify(&manifest).unwrap();

        // 删除原始数据库
        fs::remove_file(&vfs_db_path).unwrap();
        let stale_lance = active_dir.join("databases/lance/vfs/stale_table.lance");
        fs::create_dir_all(&stale_lance).unwrap();
        fs::write(stale_lance.join("stale.bin"), b"stale").unwrap();

        // 恢复
        manager.restore(&manifest).unwrap();

        // 验证恢复后的数据库
        assert!(vfs_db_path.exists());
        assert!(
            !active_dir.join("databases/lance/vfs").exists(),
            "database-only restore must not retain a different manifest's Lance rows"
        );
        let conn = Connection::open(&vfs_db_path).unwrap();
        let count: i32 = conn
            .query_row("SELECT COUNT(*) FROM test_table", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }

    #[cfg(feature = "data_governance")]
    #[test]
    fn test_current_chat_v2_schema_self_backup_and_restore() {
        let (manager, _backup_dir, app_data_dir) = setup_test_env();
        let active_dir = app_data_dir.path().join("slots").join("slotA");
        fs::create_dir_all(&active_dir).unwrap();

        let chat_db_path = active_dir.join("chat_v2.db");
        let conn = Connection::open(&chat_db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE refinery_schema_history (
                 version INTEGER PRIMARY KEY,
                 name TEXT,
                 applied_on TEXT,
                 checksum TEXT
             );
             CREATE TABLE current_schema_probe (
                 id INTEGER PRIMARY KEY,
                 value TEXT NOT NULL
             );
             INSERT INTO current_schema_probe (value) VALUES ('before-backup');",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO refinery_schema_history (version, name, applied_on, checksum)
             VALUES (?1, 'resources_type_check_rebuild', '2026-05-28T00:00:00Z', 'test')",
            [crate::chat_v2::database::CURRENT_SCHEMA_VERSION as i64],
        )
        .unwrap();
        drop(conn);

        let manifest = manager.backup_full().unwrap();
        assert_eq!(
            manifest.schema_versions.get("chat_v2"),
            Some(&crate::chat_v2::database::CURRENT_SCHEMA_VERSION)
        );
        manager
            .check_manifest_compatibility(&manifest)
            .expect("the current app must accept its own ChatV2 backup");

        let conn = Connection::open(&chat_db_path).unwrap();
        conn.execute(
            "UPDATE current_schema_probe SET value = 'after-backup' WHERE id = 1",
            [],
        )
        .unwrap();
        drop(conn);

        manager.restore(&manifest).unwrap();

        let conn = Connection::open(&chat_db_path).unwrap();
        let restored: String = conn
            .query_row(
                "SELECT value FROM current_schema_probe WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(restored, "before-backup");
    }

    #[test]
    fn test_restore_crypto_keys_rejects_incompatible_dpapi_seed_before_overwrite() {
        let (manager, backup_dir, app_data_dir) = setup_test_env();
        let backup_subdir = backup_dir.path().join("foreign_dpapi_backup");
        let backup_secure_dir = backup_subdir.join("crypto").join(".secure");
        fs::create_dir_all(&backup_secure_dir).unwrap();
        fs::write(
            backup_secure_dir.join(".key_seed"),
            "DPAPI1:Zm9yZWlnbi1kcGFwaS1ibG9i",
        )
        .unwrap();
        fs::write(backup_secure_dir.join("credential.enc"), vec![7u8; 28]).unwrap();
        fs::write(
            backup_subdir.join("crypto").join(".master_key"),
            b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        )
        .unwrap();

        let target_secure_dir = app_data_dir.path().join(".secure");
        fs::create_dir_all(&target_secure_dir).unwrap();
        fs::write(target_secure_dir.join(".key_seed"), b"existing-seed").unwrap();
        fs::write(app_data_dir.path().join(".master_key"), b"existing-master").unwrap();

        let error = manager
            .restore_crypto_keys(&backup_subdir)
            .expect_err("foreign DPAPI seed must be rejected");
        assert!(format!("{error}").contains("目标密钥保持不变"));
        assert_eq!(
            fs::read(target_secure_dir.join(".key_seed")).unwrap(),
            b"existing-seed"
        );
        assert_eq!(
            fs::read(app_data_dir.path().join(".master_key")).unwrap(),
            b"existing-master"
        );
        assert!(!backup_dir.path().join(PRE_RESTORE_DIR).exists());
    }

    #[cfg(unix)]
    #[test]
    fn test_restore_crypto_keys_rejects_symlinked_secure_dir_before_overwrite() {
        let (manager, backup_dir, app_data_dir) = setup_test_env();
        let backup_subdir = backup_dir.path().join("symlinked_crypto_backup");
        fs::create_dir_all(backup_subdir.join("crypto")).unwrap();
        fs::write(
            backup_subdir.join("crypto").join(".master_key"),
            b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        )
        .unwrap();

        let external_secure = TempDir::new().unwrap();
        fs::write(external_secure.path().join(".key_seed"), "aa".repeat(32)).unwrap();
        std::os::unix::fs::symlink(
            external_secure.path(),
            backup_subdir.join("crypto").join(".secure"),
        )
        .unwrap();

        let target_secure_dir = app_data_dir.path().join(".secure");
        fs::create_dir_all(&target_secure_dir).unwrap();
        fs::write(target_secure_dir.join(".key_seed"), b"existing-seed").unwrap();
        fs::write(app_data_dir.path().join(".master_key"), b"existing-master").unwrap();

        let error = manager
            .restore_crypto_keys(&backup_subdir)
            .expect_err("symlinked secure directory must be rejected");
        assert!(format!("{error}").contains("目标密钥保持不变"));
        assert_eq!(
            fs::read(target_secure_dir.join(".key_seed")).unwrap(),
            b"existing-seed"
        );
        assert_eq!(
            fs::read(app_data_dir.path().join(".master_key")).unwrap(),
            b"existing-master"
        );
        assert!(!backup_dir.path().join(PRE_RESTORE_DIR).exists());
    }

    #[test]
    fn test_restore_crypto_keys_rejects_encrypted_files_without_seed_before_overwrite() {
        let (manager, backup_dir, app_data_dir) = setup_test_env();
        let backup_subdir = backup_dir.path().join("missing_seed_backup");
        let backup_secure_dir = backup_subdir.join("crypto/.secure");
        fs::create_dir_all(&backup_secure_dir).unwrap();
        fs::write(backup_secure_dir.join("credential.enc"), vec![3u8; 28]).unwrap();

        let target_secure = app_data_dir.path().join(".secure");
        fs::create_dir_all(&target_secure).unwrap();
        fs::write(target_secure.join(".key_seed"), b"existing-seed").unwrap();
        fs::write(target_secure.join("existing.enc"), b"existing-credential").unwrap();

        let error = manager
            .restore_crypto_keys(&backup_subdir)
            .expect_err("encrypted files without their seed must be rejected");
        assert!(format!("{error}").contains("缺少 .key_seed"));
        assert_eq!(
            fs::read(target_secure.join(".key_seed")).unwrap(),
            b"existing-seed"
        );
        assert_eq!(
            fs::read(target_secure.join("existing.enc")).unwrap(),
            b"existing-credential"
        );
        assert!(!backup_dir.path().join(PRE_RESTORE_DIR).exists());
    }

    #[test]
    fn test_restore_crypto_keys_replaces_secure_directory_without_mixing_old_credentials() {
        let (manager, _backup_dir, app_data_dir) = setup_test_env();
        let backup_subdir = manager.backup_dir().join("seed_only_backup");
        let backup_secure_dir = backup_subdir.join("crypto/.secure");
        fs::create_dir_all(&backup_secure_dir).unwrap();
        let new_seed = "aa".repeat(32);
        fs::write(backup_secure_dir.join(".key_seed"), &new_seed).unwrap();

        let target_secure = app_data_dir.path().join(".secure");
        fs::create_dir_all(&target_secure).unwrap();
        fs::write(target_secure.join(".key_seed"), b"old-seed").unwrap();
        fs::write(target_secure.join("old.enc"), b"old-credential").unwrap();

        let restored = manager.restore_crypto_keys(&backup_subdir).unwrap();

        assert_eq!(restored, 1);
        assert_eq!(
            fs::read_to_string(target_secure.join(".key_seed")).unwrap(),
            new_seed
        );
        assert!(!target_secure.join("old.enc").exists());
    }

    #[test]
    fn test_restore_crypto_keys_aborts_when_snapshot_cannot_be_created() {
        let (manager, backup_dir, app_data_dir) = setup_test_env();
        let backup_subdir = backup_dir.path().join("snapshot_failure_backup");
        let backup_secure_dir = backup_subdir.join("crypto/.secure");
        fs::create_dir_all(&backup_secure_dir).unwrap();
        fs::write(backup_secure_dir.join(".key_seed"), "aa".repeat(32)).unwrap();

        let target_secure = app_data_dir.path().join(".secure");
        fs::create_dir_all(&target_secure).unwrap();
        fs::write(target_secure.join(".key_seed"), b"existing-seed").unwrap();
        fs::write(backup_dir.path().join(PRE_RESTORE_DIR), b"not-a-directory").unwrap();

        let error = manager
            .restore_crypto_keys(&backup_subdir)
            .expect_err("snapshot failure must abort before commit");
        assert!(format!("{error}").contains("目标密钥保持不变"));
        assert_eq!(
            fs::read(target_secure.join(".key_seed")).unwrap(),
            b"existing-seed"
        );
    }

    #[test]
    fn test_verify_checksum_mismatch() {
        let (manager, backup_dir, app_data_dir) = setup_test_env();

        // 创建测试数据库（模拟活动数据空间 slots/slotA）
        let active_dir = app_data_dir.path().join("slots").join("slotA");
        let db_dir = active_dir.join("databases");
        fs::create_dir_all(&db_dir).unwrap();
        let vfs_db_path = db_dir.join("vfs.db");
        create_test_database(&vfs_db_path).unwrap();

        // 执行备份
        let manifest = manager.backup_full().unwrap();

        // 修改备份文件
        let backup_subdir = backup_dir.path().join(&manifest.backup_id);
        let backup_file = backup_subdir.join("vfs.db");
        fs::write(&backup_file, "corrupted").unwrap();

        // 验证应该失败
        let result = manager.verify(&manifest);
        assert!(result.is_err());
    }

    #[test]
    fn test_list_and_cleanup_backups() {
        let (manager, _backup_dir, app_data_dir) = setup_test_env();

        // 创建测试数据库（模拟活动数据空间 slots/slotA）
        let active_dir = app_data_dir.path().join("slots").join("slotA");
        let db_dir = active_dir.join("databases");
        fs::create_dir_all(&db_dir).unwrap();
        let vfs_db_path = db_dir.join("vfs.db");
        create_test_database(&vfs_db_path).unwrap();

        // 创建多个备份（增加间隔确保时间戳不同）
        for _ in 0..3 {
            let manifest = manager.backup_with_assets(None).unwrap();
            assert_eq!(manifest.snapshot_kind, SnapshotKind::Full);
            std::thread::sleep(std::time::Duration::from_millis(1100)); // 确保时间戳不同
        }

        // 列出备份
        let backups = manager.list_backups().unwrap();
        assert!(
            backups.len() >= 2,
            "Expected at least 2 backups, got {}",
            backups.len()
        );

        // 清理旧备份，保留 1 个
        let backup_count_before = backups.len();
        let deleted = manager.cleanup_old_backups(1).unwrap();
        assert!(
            deleted.len() >= backup_count_before.saturating_sub(1),
            "Should delete backups beyond keep_count"
        );

        // 验证剩余备份数量
        let remaining = manager.list_backups().unwrap();
        assert!(
            remaining.len() <= 1,
            "Should have at most 1 backup remaining"
        );
    }

    #[test]
    fn test_calculate_file_sha256() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("test.txt");
        fs::write(&file_path, "hello world").unwrap();

        let hash = calculate_file_sha256(&file_path).unwrap();

        // SHA256 of "hello world"
        assert_eq!(
            hash,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }

    #[test]
    fn test_backup_full_rejects_missing_core_database() {
        let (manager, _backup_dir, app_data_dir) = setup_test_env();
        let active_dir = app_data_dir.path().join("slots").join("slotA");
        let missing = BackupManager::resolve_database_path_in_dir(&active_dir, &DatabaseId::Vfs);
        fs::remove_file(missing).unwrap();

        let error = manager
            .backup_full()
            .expect_err("完整备份缺少任一核心数据库时必须失败");

        assert!(matches!(error, BackupError::FileNotFound(_)));
        assert!(format!("{error}").contains("vfs"));
    }

    #[test]
    fn test_manifest_save_and_load() {
        let dir = TempDir::new().unwrap();
        let manifest_path = dir.path().join("manifest.json");

        let mut manifest = BackupManifest::new("2.0.0");
        manifest.set_schema_version("vfs", 3);
        manifest.add_file(BackupFile {
            path: "vfs.db".to_string(),
            size: 2048,
            sha256: "def456".to_string(),
            database_id: Some("vfs".to_string()),
        });

        // 保存
        manifest.save_to_file(&manifest_path).unwrap();

        // 加载
        let loaded = BackupManifest::load_from_file(&manifest_path).unwrap();

        assert_eq!(loaded.app_version, "2.0.0");
        assert_eq!(loaded.schema_versions.get("vfs"), Some(&3));
        assert_eq!(loaded.files.len(), 1);
    }

    #[test]
    fn legacy_v1_v2_manifests_load_as_candidates_without_coverage() {
        for version in ["1.0.0", "2.0.0"] {
            let dir = TempDir::new().unwrap();
            let path = dir.path().join("manifest.json");
            fs::write(
                &path,
                serde_json::json!({
                    "version": version,
                    "app_version": "legacy",
                    "created_at": "2026-01-01T00:00:00Z",
                    "platform": "test",
                    "schema_versions": {},
                    "files": [],
                    "is_incremental": false,
                    "incremental_base": null,
                    "backup_id": format!("legacy_{}", version.replace('.', "_")),
                    "snapshot_kind": "full",
                    "snapshot_epoch": "legacy-epoch",
                    "required_components": [],
                    "included_components": [],
                    "key_policy": "not_present"
                })
                .to_string(),
            )
            .unwrap();

            let manifest = BackupManifest::load_from_file(&path).unwrap();
            assert_eq!(manifest.snapshot_kind, SnapshotKind::LegacyCandidate);
            assert!(manifest.coverage.is_none());
            assert!(manifest.validate_for_slot_restore().is_err());
        }
    }

    #[test]
    fn manifest_v3_without_coverage_is_rejected_instead_of_downgraded() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("manifest.json");
        fs::write(
            &path,
            serde_json::json!({
                "version": "3.0.0",
                "app_version": "test",
                "created_at": "2026-01-01T00:00:00Z",
                "platform": "test",
                "schema_versions": {},
                "files": [],
                "is_incremental": false,
                "incremental_base": null,
                "backup_id": "v3_without_coverage",
                "snapshot_kind": "full",
                "snapshot_epoch": "epoch",
                "required_components": [],
                "included_components": [],
                "key_policy": "not_present"
            })
            .to_string(),
        )
        .unwrap();

        let error = BackupManifest::load_from_file(&path)
            .expect_err("v3 without coverage must fail closed");
        assert!(format!("{error}").contains("coverage"));
    }

    #[test]
    fn empty_legacy_candidate_cannot_pass_upgrade_gate() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("manifest.json");
        fs::write(
            &path,
            serde_json::json!({
                "version": "2.0.0",
                "app_version": "legacy",
                "created_at": "2026-01-01T00:00:00Z",
                "platform": "test",
                "schema_versions": {},
                "files": [],
                "is_incremental": false,
                "incremental_base": null,
                "backup_id": "empty_legacy",
                "snapshot_kind": "full",
                "snapshot_epoch": "legacy",
                "required_components": [],
                "included_components": [],
                "key_policy": "not_present"
            })
            .to_string(),
        )
        .unwrap();
        let manifest = BackupManifest::load_from_file(&path).unwrap();

        assert!(manifest.validate_legacy_candidate_for_upgrade().is_err());
        assert_eq!(manifest.snapshot_kind, SnapshotKind::LegacyCandidate);
    }

    #[test]
    fn legacy_upgrade_rejects_unclassified_persistent_files() {
        let mut manifest = BackupManifest::new("legacy");
        manifest.version = "2.0.0".to_string();
        manifest.snapshot_kind = SnapshotKind::LegacyCandidate;
        manifest.coverage = None;
        manifest.key_policy = BackupKeyPolicy::LegacyUnknown;
        for database in DatabaseId::all_ordered() {
            manifest.add_file(BackupFile {
                path: format!("{}.db", database.as_str()),
                size: 1,
                sha256: "a".repeat(64),
                database_id: Some(database.as_str().to_string()),
            });
        }
        manifest.add_file(BackupFile {
            path: "persistent/unregistered.bin".to_string(),
            size: 1,
            sha256: "b".repeat(64),
            database_id: None,
        });

        let error = manifest
            .validate_legacy_candidate_for_upgrade()
            .expect_err("legacy upgrade must reject unregistered persistent paths");
        assert!(format!("{error}").contains("未分类"));
    }

    #[test]
    fn persistent_registry_marks_user_skills_untrusted_executable() {
        let skills = persistent_domain_registry()
            .into_iter()
            .find(|domain| domain.id == "user-skills")
            .unwrap();
        assert!(skills.executable);
        assert!(skills.optional);
        assert!(skills.encrypted);
        assert_eq!(skills.restore_scope, RestoreScope::UserHome);
        assert_eq!(
            skills.restore_trust,
            RestoreTrustPolicy::UntrustedExecutable
        );
    }

    #[test]
    fn executable_agent_assets_require_explicit_restore_trust() {
        let agent = assets::BackedUpAsset {
            asset_type: AssetType::Workspaces,
            relative_path: "assets/workspaces/agents/reviewer.md".to_string(),
            original_path: "workspaces/agents/reviewer.md".to_string(),
            size: 1,
            checksum: Some("a".repeat(64)),
            modified_at: None,
            is_directory: false,
        };
        let ordinary = assets::BackedUpAsset {
            relative_path: "assets/workspaces/notes/readme.md".to_string(),
            original_path: "workspaces/notes/readme.md".to_string(),
            ..agent.clone()
        };
        assert!(asset_requires_explicit_trust(&agent));
        assert!(!asset_requires_explicit_trust(&ordinary));
    }

    #[test]
    fn active_data_space_settings_are_manifested_with_restore_scope() {
        let (manager, _backup_dir, app_data_dir) = setup_test_env();
        let active_dir = app_data_dir.path().join("slots").join("slotA");
        fs::write(
            active_dir.join("webview_settings.json"),
            br#"{"theme":"dark"}"#,
        )
        .unwrap();
        fs::write(
            active_dir.join("custom_grading_modes.json"),
            br#"{"modes":[]}"#,
        )
        .unwrap();

        let manifest = manager.backup_with_assets(None).unwrap();
        for domain in ["webview-settings", "custom-grading-modes"] {
            let plan = manifest.domain_restore_plan(domain).unwrap();
            assert_eq!(plan.status, CoverageStatus::Complete);
            assert_eq!(plan.restore_scope, RestoreScope::ActiveDataSpace);
            assert_eq!(plan.files.len(), 1);
            assert!(plan.files[0]
                .sha256
                .as_ref()
                .is_some_and(|hash| hash.len() == 64));
        }
    }

    #[test]
    fn full_label_is_not_synthesized_without_coverage_evidence() {
        let mut manifest = BackupManifest::new("test");
        assert!(manifest.mark_full().is_err());
        assert_eq!(manifest.snapshot_kind, SnapshotKind::PartialOverlay);
        assert!(manifest
            .coverage
            .as_ref()
            .unwrap()
            .domains
            .values()
            .all(|domain| domain.status == CoverageStatus::Excluded));
    }

    #[test]
    fn crypto_tamper_fails_even_if_manifest_hash_is_rewritten() {
        let (manager, _backup_dir, app_data_dir) = setup_test_env();
        let store = crate::secure_store::SecureStore::new_with_dir(
            crate::secure_store::SecureStoreConfig::default(),
            app_data_dir.path().to_path_buf(),
        );
        store
            .save_secret("backup-integrity-sentinel", "sentinel-value")
            .unwrap();

        let mut manifest = manager.backup_with_assets(None).unwrap();
        let crypto_plan = manifest.crypto_restore_plan().unwrap();
        assert!(crypto_plan.encrypted);
        assert_eq!(crypto_plan.restore_scope, RestoreScope::ApplicationData);
        assert!(crypto_plan
            .files
            .iter()
            .all(|file| file.sha256.as_ref().is_some_and(|hash| hash.len() == 64)));
        let backup_subdir = manager.backup_dir().join(&manifest.backup_id);
        let relative = "crypto/.secure/backup-integrity-sentinel.enc";
        let encrypted = backup_subdir.join(relative);
        let mut bytes = fs::read(&encrypted).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0x80;
        fs::write(&encrypted, bytes).unwrap();
        let rewritten_hash = calculate_file_sha256(&encrypted).unwrap();
        manifest
            .files
            .iter_mut()
            .find(|file| file.path == relative)
            .unwrap()
            .sha256 = rewritten_hash;

        let error = manager
            .verify(&manifest)
            .expect_err("AEAD tamper must fail actual decryption");
        assert!(format!("{error}").contains("无法实际解密"));
    }

    #[test]
    fn corrupted_audit_database_fails_integrity_after_hash_rewrite() {
        let (manager, _backup_dir, app_data_dir) = setup_test_env();
        let audit_path = app_data_dir.path().join("databases/audit.db");
        fs::create_dir_all(audit_path.parent().unwrap()).unwrap();
        let connection = Connection::open(&audit_path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE audit_probe (id INTEGER PRIMARY KEY, value TEXT);
                 INSERT INTO audit_probe(value) VALUES ('valid');",
            )
            .unwrap();
        drop(connection);

        let mut manifest = manager.backup_with_assets(None).unwrap();
        let audit_plan = manifest.audit_restore_plan().unwrap();
        assert_eq!(audit_plan.files.len(), 1);
        assert_eq!(audit_plan.file_count, 1);
        assert_eq!(audit_plan.restore_scope, RestoreScope::ApplicationData);
        assert_eq!(audit_plan.files[0].path, "databases/audit.db");
        assert_eq!(audit_plan.files[0].sha256.as_ref().unwrap().len(), 64);
        let backup_subdir = manager.backup_dir().join(&manifest.backup_id);
        let archived_audit = backup_subdir.join("databases/audit.db");
        let size = fs::metadata(&archived_audit).unwrap().len() as usize;
        fs::write(&archived_audit, vec![0u8; size]).unwrap();
        let rewritten_hash = calculate_file_sha256(&archived_audit).unwrap();
        manifest
            .files
            .iter_mut()
            .find(|file| file.path == "databases/audit.db")
            .unwrap()
            .sha256 = rewritten_hash;

        let error = manager
            .verify(&manifest)
            .expect_err("audit SQLite corruption must fail integrity_check");
        assert!(format!("{error}").contains("databases/audit.db"));
    }

    // ========================================================================
    // 恢复操作集成测试
    // ========================================================================

    /// 测试 1: 正常恢复流程
    ///
    /// 创建备份 → 修改数据（增删改） → 恢复 → 验证数据恢复到备份时状态
    #[test]
    fn test_restore_reverts_data_to_backup_state() {
        let (manager, _backup_dir, app_data_dir) = setup_test_env();

        // 创建测试数据库（模拟活动数据空间 slots/slotA）
        let active_dir = app_data_dir.path().join("slots").join("slotA");
        let db_dir = active_dir.join("databases");
        fs::create_dir_all(&db_dir).unwrap();

        let vfs_db_path = db_dir.join("vfs.db");
        let conn = Connection::open(&vfs_db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE test_table (id INTEGER PRIMARY KEY, name TEXT);
             INSERT INTO test_table (name) VALUES ('original_row1'), ('original_row2');",
        )
        .unwrap();
        drop(conn);

        // 创建备份
        let manifest = manager.backup_full().unwrap();

        // 修改数据：删除一行、添加一行、更新一行
        let conn = Connection::open(&vfs_db_path).unwrap();
        conn.execute("DELETE FROM test_table WHERE name = 'original_row1'", [])
            .unwrap();
        conn.execute("INSERT INTO test_table (name) VALUES ('new_row3')", [])
            .unwrap();
        conn.execute(
            "UPDATE test_table SET name = 'modified_row2' WHERE name = 'original_row2'",
            [],
        )
        .unwrap();

        // 确认数据已被修改
        let count: i32 = conn
            .query_row("SELECT COUNT(*) FROM test_table", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2); // 'modified_row2' + 'new_row3'
        let has_new: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM test_table WHERE name = 'new_row3')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            has_new,
            "Precondition: new_row3 should exist before restore"
        );
        drop(conn);

        // 执行恢复
        manager.restore(&manifest).unwrap();

        // 验证数据恢复到备份时状态
        let conn = Connection::open(&vfs_db_path).unwrap();
        let count: i32 = conn
            .query_row("SELECT COUNT(*) FROM test_table", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2, "Should have exactly 2 rows as in original backup");

        let mut stmt = conn
            .prepare("SELECT name FROM test_table ORDER BY name")
            .unwrap();
        let names: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        assert_eq!(
            names,
            vec!["original_row1", "original_row2"],
            "Data should revert to backup state"
        );

        // new_row3 不应存在
        let has_new: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM test_table WHERE name = 'new_row3')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            !has_new,
            "new_row3 should not exist after restore to backup state"
        );

        // modified_row2 应恢复为 original_row2
        let has_original: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM test_table WHERE name = 'original_row2')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            has_original,
            "original_row2 should be restored (not modified_row2)"
        );
    }

    /// 测试 2: 恢复后完整性检查
    ///
    /// 创建带索引和外键的复杂数据库 → 备份 → 恢复 → PRAGMA integrity_check 通过
    #[test]
    fn test_restore_integrity_check_passes_on_restored_db() {
        let (manager, _backup_dir, app_data_dir) = setup_test_env();

        let active_dir = app_data_dir.path().join("slots").join("slotA");
        let db_dir = active_dir.join("databases");
        fs::create_dir_all(&db_dir).unwrap();

        // 创建一个包含索引和外键引用的复杂数据库
        let vfs_db_path = db_dir.join("vfs.db");
        let conn = Connection::open(&vfs_db_path).unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE items (
                 id INTEGER PRIMARY KEY,
                 value TEXT NOT NULL,
                 created_at INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE tags (
                 id INTEGER PRIMARY KEY,
                 item_id INTEGER NOT NULL REFERENCES items(id),
                 tag TEXT NOT NULL
             );
             CREATE INDEX idx_tags_item ON tags(item_id);
             CREATE INDEX idx_items_value ON items(value);
             INSERT INTO items (id, value, created_at) VALUES (1, 'item_alpha', 1000);
             INSERT INTO items (id, value, created_at) VALUES (2, 'item_beta', 2000);
             INSERT INTO items (id, value, created_at) VALUES (3, 'item_gamma', 3000);
             INSERT INTO tags (item_id, tag) VALUES (1, 'rust');
             INSERT INTO tags (item_id, tag) VALUES (1, 'systems');
             INSERT INTO tags (item_id, tag) VALUES (2, 'python');
             INSERT INTO tags (item_id, tag) VALUES (3, 'sql');",
        )
        .unwrap();
        drop(conn);

        // 备份
        let manifest = manager.backup_full().unwrap();

        // 删除原始数据库
        fs::remove_file(&vfs_db_path).unwrap();
        // 删除 WAL/SHM 文件（如果存在）
        let _ = fs::remove_file(vfs_db_path.with_extension("db-wal"));
        let _ = fs::remove_file(vfs_db_path.with_extension("db-shm"));

        // 恢复
        manager.restore(&manifest).unwrap();

        // 显式验证完整性
        let conn = Connection::open(&vfs_db_path).unwrap();

        let integrity: String = conn
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            integrity, "ok",
            "PRAGMA integrity_check should pass after restore"
        );

        // 验证索引仍然存在
        let idx_count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            idx_count, 2,
            "Both user-created indexes should exist after restore"
        );

        // 验证数据完整性
        let item_count: i32 = conn
            .query_row("SELECT COUNT(*) FROM items", [], |row| row.get(0))
            .unwrap();
        assert_eq!(item_count, 3, "All 3 items should be restored");

        let tag_count: i32 = conn
            .query_row("SELECT COUNT(*) FROM tags", [], |row| row.get(0))
            .unwrap();
        assert_eq!(tag_count, 4, "All 4 tags should be restored");

        // 验证外键关系完整（PRAGMA foreign_key_check 返回空 = 无违规）
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        let mut fk_stmt = conn.prepare("PRAGMA foreign_key_check").unwrap();
        let fk_violations: Vec<String> = fk_stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        assert!(
            fk_violations.is_empty(),
            "No foreign key violations should exist after restore, got: {:?}",
            fk_violations
        );
    }

    /// 测试 3: 恢复损坏备份
    ///
    /// 创建有效备份 → 损坏 .db 文件（保持 SHA256 正确）→ 验证恢复被拒绝
    #[test]
    fn test_restore_rejects_corrupted_backup_db() {
        let (manager, backup_dir, app_data_dir) = setup_test_env();

        let active_dir = app_data_dir.path().join("slots").join("slotA");
        let db_dir = active_dir.join("databases");
        fs::create_dir_all(&db_dir).unwrap();

        let vfs_db_path = db_dir.join("vfs.db");
        create_test_database(&vfs_db_path).unwrap();

        // 创建有效备份
        let mut manifest = manager.backup_full().unwrap();

        // 损坏备份中的 .db 文件：保留 SQLite 头部但翻转内部数据页
        let backup_subdir = backup_dir.path().join(&manifest.backup_id);
        let backup_db = backup_subdir.join("vfs.db");
        let mut data = fs::read(&backup_db).unwrap();

        // 保留前 100 字节（SQLite 头部），损坏后面的数据页
        if data.len() > 200 {
            for byte in data[100..200].iter_mut() {
                *byte = 0xFF;
            }
        }
        fs::write(&backup_db, &data).unwrap();

        // 更新 manifest 中的 SHA256，使校验和匹配损坏后的文件
        // 这样可以测试 integrity_check 阶段是否能发现损坏
        let corrupted_sha = calculate_file_sha256(&backup_db).unwrap();
        let corrupted_size = fs::metadata(&backup_db).unwrap().len();
        for file in &mut manifest.files {
            if file.path == "vfs.db" {
                file.sha256 = corrupted_sha.clone();
                file.size = corrupted_size;
            }
        }
        // 重新保存 manifest
        manifest
            .save_to_file(&backup_subdir.join(MANIFEST_FILENAME))
            .unwrap();

        // 恢复应失败（verify_internal 的 integrity_check 阶段会检测到损坏）
        let result = manager.restore(&manifest);
        assert!(
            result.is_err(),
            "Restore should reject backup with corrupted .db file"
        );

        let err_msg = format!("{}", result.unwrap_err());
        assert!(
            err_msg.contains("integrity")
                || err_msg.contains("not a database")
                || err_msg.contains("完整性")
                || err_msg.contains("验证失败")
                || err_msg.contains("损坏"),
            "Error should mention integrity/corruption issue, got: {}",
            err_msg
        );
    }

    /// 测试 4: 恢复时写入失败的优雅处理（模拟磁盘空间不足）
    ///
    /// 通过设置目标目录只读来模拟无法写入的场景（Unix only）。
    /// 验证恢复操作不会 panic，而是返回可操作的错误信息。
    #[cfg(unix)]
    #[test]
    fn test_restore_handles_write_failure_gracefully() {
        use std::os::unix::fs::PermissionsExt;

        let (manager, backup_dir, app_data_dir) = setup_test_env();

        let active_dir = app_data_dir.path().join("slots").join("slotA");
        let db_dir = active_dir.join("databases");
        fs::create_dir_all(&db_dir).unwrap();

        let vfs_db_path = db_dir.join("vfs.db");
        create_test_database(&vfs_db_path).unwrap();

        // 创建有效备份
        let manifest = manager.backup_full().unwrap();

        // 将备份根目录设为只读，阻止创建 .pre_restore 目录
        // 这模拟了磁盘空间不足或权限问题导致无法创建预恢复备份
        let perms_original = fs::metadata(backup_dir.path()).unwrap().permissions();
        let mut perms_readonly = perms_original.clone();
        perms_readonly.set_mode(0o555);
        fs::set_permissions(backup_dir.path(), perms_readonly).unwrap();

        // 尝试恢复
        let result = manager.restore(&manifest);

        // 恢复原始权限（确保 TempDir 清理不会失败）
        let mut perms_restore = fs::metadata(backup_dir.path()).unwrap().permissions();
        perms_restore.set_mode(0o755);
        fs::set_permissions(backup_dir.path(), perms_restore).unwrap();

        // 验证：不应 panic，应返回明确的 IO 错误
        assert!(
            result.is_err(),
            "Restore should fail when pre_restore backup directory cannot be created"
        );

        let err_msg = format!("{}", result.unwrap_err());
        assert!(
            err_msg.contains("IO")
                || err_msg.contains("Permission")
                || err_msg.contains("denied")
                || err_msg.contains("permission")
                || err_msg.contains("read-only"),
            "Error should indicate IO/permission failure, got: {}",
            err_msg
        );
    }

    /// 测试 5: 恢复后 schema 版本验证
    ///
    /// 创建包含 refinery_schema_history 的数据库 → 备份 → 恢复 →
    /// 验证恢复后的 schema 版本与备份清单中记录的一致
    #[test]
    fn test_restore_schema_version_matches_backup_metadata() {
        let (manager, _backup_dir, app_data_dir) = setup_test_env();

        let active_dir = app_data_dir.path().join("slots").join("slotA");
        let db_dir = active_dir.join("databases");
        fs::create_dir_all(&db_dir).unwrap();

        // 创建包含 schema 版本记录的 VFS 数据库
        let vfs_db_path = db_dir.join("vfs.db");
        let conn = Connection::open(&vfs_db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE test_table (id INTEGER PRIMARY KEY, name TEXT);
             INSERT INTO test_table (name) VALUES ('versioned_data');
             CREATE TABLE refinery_schema_history (
                 version INTEGER PRIMARY KEY,
                 name TEXT,
                 applied_on TEXT,
                 checksum TEXT
             );
             INSERT INTO refinery_schema_history (version, name, applied_on, checksum)
             VALUES (20260130, 'init', '2026-01-30T00:00:00Z', 'abc123');
             INSERT INTO refinery_schema_history (version, name, applied_on, checksum)
             VALUES (20260201, 'add_indexes', '2026-02-01T00:00:00Z', 'def456');
             INSERT INTO refinery_schema_history (version, name, applied_on, checksum)
             VALUES (20260207, 'add_sync_support', '2026-02-07T00:00:00Z', 'ghi789');",
        )
        .unwrap();
        drop(conn);

        // 执行备份
        let manifest = manager.backup_full().unwrap();

        // 验证 manifest 中正确记录了 schema 版本
        let recorded_version = manifest.schema_versions.get("vfs");
        assert_eq!(
            recorded_version,
            Some(&20260207),
            "Manifest should record the latest schema version (MAX of refinery_schema_history)"
        );

        // 删除原数据库
        fs::remove_file(&vfs_db_path).unwrap();
        let _ = fs::remove_file(vfs_db_path.with_extension("db-wal"));
        let _ = fs::remove_file(vfs_db_path.with_extension("db-shm"));

        // 恢复
        manager.restore(&manifest).unwrap();

        // 验证恢复后的 schema 版本与备份清单一致
        let conn = Connection::open(&vfs_db_path).unwrap();

        let restored_version: i32 = conn
            .query_row(
                "SELECT MAX(version) FROM refinery_schema_history",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(
            restored_version as u32,
            *recorded_version.unwrap(),
            "Restored schema version should match backup metadata"
        );

        // 验证所有历史记录都完整保留
        let history_count: i32 = conn
            .query_row("SELECT COUNT(*) FROM refinery_schema_history", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            history_count, 3,
            "All 3 schema history records should be preserved after restore"
        );

        // 验证数据也一并恢复
        let data: String = conn
            .query_row("SELECT name FROM test_table", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            data, "versioned_data",
            "User data should be restored alongside schema history"
        );
    }

    /// 测试 6: pre_restore 备份创建和回滚机制
    ///
    /// Phase 1: 创建 v1 数据 → 备份
    /// Phase 2: 修改为 v2 数据
    /// Phase 3: 恢复 v1 备份
    /// Phase 4: 验证 pre_restore 备份包含 v2 数据
    /// Phase 5: 通过 rollback 恢复 v2 数据 → 验证回滚成功
    #[test]
    fn test_pre_restore_backup_and_rollback_mechanism() {
        let (manager, backup_dir, app_data_dir) = setup_test_env();

        let active_dir = app_data_dir.path().join("slots").join("slotA");
        let db_dir = active_dir.join("databases");
        fs::create_dir_all(&db_dir).unwrap();

        // Phase 1: 创建 v1 数据并备份
        let vfs_db_path = db_dir.join("vfs.db");
        let conn = Connection::open(&vfs_db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE test_table (id INTEGER PRIMARY KEY, name TEXT);
             INSERT INTO test_table (name) VALUES ('v1_alpha');
             INSERT INTO test_table (name) VALUES ('v1_beta');",
        )
        .unwrap();
        drop(conn);

        let v1_manifest = manager.backup_full().unwrap();

        // Phase 2: 修改为 v2 数据
        let conn = Connection::open(&vfs_db_path).unwrap();
        conn.execute(
            "UPDATE test_table SET name = 'v2_alpha' WHERE name = 'v1_alpha'",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO test_table (name) VALUES ('v2_gamma')", [])
            .unwrap();
        conn.execute("DELETE FROM test_table WHERE name = 'v1_beta'", [])
            .unwrap();
        // v2 状态: ['v2_alpha', 'v2_gamma']
        let v2_count: i32 = conn
            .query_row("SELECT COUNT(*) FROM test_table", [], |row| row.get(0))
            .unwrap();
        assert_eq!(v2_count, 2, "Precondition: v2 should have 2 rows");
        drop(conn);

        // Phase 3: 恢复到 v1
        manager.restore(&v1_manifest).unwrap();

        // Phase 4: 验证 pre_restore 备份已创建且包含 v2 数据
        let pre_restore_dir = backup_dir.path().join(PRE_RESTORE_DIR);
        assert!(
            pre_restore_dir.exists(),
            "Pre-restore backup directory should be created during restore"
        );

        let pre_restore_vfs = pre_restore_dir.join("vfs.db");
        assert!(
            pre_restore_vfs.exists(),
            "Pre-restore VFS backup should exist"
        );

        // 验证 pre_restore 备份的内容是 v2 数据（恢复前的状态）
        let pre_conn = Connection::open(&pre_restore_vfs).unwrap();
        let pre_count: i32 = pre_conn
            .query_row("SELECT COUNT(*) FROM test_table", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            pre_count, 2,
            "Pre-restore backup should contain 2 rows (v2 state)"
        );

        let has_v2_alpha: bool = pre_conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM test_table WHERE name = 'v2_alpha')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(has_v2_alpha, "Pre-restore backup should contain v2_alpha");
        let has_v2_gamma: bool = pre_conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM test_table WHERE name = 'v2_gamma')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(has_v2_gamma, "Pre-restore backup should contain v2_gamma");
        drop(pre_conn);

        // 验证主数据库已恢复到 v1
        let conn = Connection::open(&vfs_db_path).unwrap();
        let restored_count: i32 = conn
            .query_row("SELECT COUNT(*) FROM test_table", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            restored_count, 2,
            "Main database should have 2 rows (v1 state)"
        );
        let has_v1_alpha: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM test_table WHERE name = 'v1_alpha')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(has_v1_alpha, "Main database should contain v1_alpha");
        drop(conn);

        // Phase 5: 测试回滚 — 从 pre_restore 备份恢复 v2 数据
        manager.rollback_from_pre_restore(&pre_restore_dir).unwrap();

        // 验证回滚后数据库恢复到 v2 状态
        let conn = Connection::open(&vfs_db_path).unwrap();
        let after_rollback_count: i32 = conn
            .query_row("SELECT COUNT(*) FROM test_table", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            after_rollback_count, 2,
            "After rollback, should have 2 rows (v2 state)"
        );

        let has_v2_after: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM test_table WHERE name = 'v2_alpha')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(has_v2_after, "After rollback, v2_alpha should be restored");

        let has_v1_after: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM test_table WHERE name = 'v1_alpha')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            !has_v1_after,
            "After rollback, v1_alpha should NOT exist (v2 state has v2_alpha)"
        );

        // 完整性检查
        let integrity: String = conn
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            integrity, "ok",
            "Database should pass integrity check after rollback"
        );
    }
}
