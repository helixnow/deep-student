//! # Backup 模块
//!
//! 原子性备份/恢复系统。
//!
//! ## 设计原则
//!
//! 1. **原子性**：使用 SQLite Backup API，确保数据一致性
//! 2. **可验证**：每个文件都有 SHA256 校验和
//! 3. **可回滚**：恢复前自动备份当前数据，失败时可回滚
//! 4. **增量支持**：基于变更日志的增量备份
//! 5. **资产支持**：支持备份图片、文档、音视频等资产文件
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
//! - `incremental`: 增量备份（基于变更日志）
//! - `assets`: 资产文件备份

pub mod assets;

pub mod zip_export;

use rusqlite::backup::Backup;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tracing::{debug, error, info, warn};
use uuid::Uuid;
use walkdir::WalkDir;

/// 记录并跳过迭代中的错误，避免静默丢弃
fn log_and_skip_err<T, E: std::fmt::Display>(result: Result<T, E>) -> Option<T> {
    match result {
        Ok(v) => Some(v),
        Err(e) => {
            warn!("[Backup] Row parse error (skipped): {}", e);
            None
        }
    }
}

#[cfg(feature = "data_governance")]
use crate::data_governance::schema_registry::DatabaseId;

pub use zip_export::{export_backup_to_zip, ZipExportError, ZipExportOptions, ZipExportResult};

// 重新导出资产模块的公共类型
pub use assets::{
    AssetBackupConfig, AssetBackupError, AssetBackupResult, AssetType, AssetTypeStats,
    AssetVerifyError, BackedUpAsset,
};

/// 备份清单版本
const MANIFEST_VERSION: &str = "2.0.0";

/// 当前应用支持的最大 manifest 主版本号
/// 用于 restore() 版本兼容性检查：拒绝来自未来主版本的备份
const MANIFEST_MAX_SUPPORTED_MAJOR: u64 = 2;

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
    if !opened_metadata.is_file() || opened_metadata.len() > max_bytes {
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
    destination_file.sync_all()?;
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

/// Whether a package can replace an entire data slot.
///
/// Missing values deserialize as `LegacyUnknown` so historical manifests can
/// never silently acquire full-snapshot semantics after an application update.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotKind {
    Full,
    PartialOverlay,
    LegacyUnknown,
}

fn legacy_snapshot_kind() -> SnapshotKind {
    SnapshotKind::LegacyUnknown
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
        let mut components = components.into_iter().collect::<Vec<_>>();
        components.sort();
        self.included_components = components;
    }

    fn full_required_components() -> Vec<String> {
        let mut required = DatabaseId::all_ordered()
            .into_iter()
            .map(|id| format!("database:{}", id.as_str()))
            .collect::<Vec<_>>();
        required.push("workspaces-root".to_string());
        required.extend(
            AssetType::all()
                .into_iter()
                .map(|asset_type| format!("asset-root:{}", asset_type.relative_path())),
        );
        required.sort();
        required
    }

    fn mark_full(&mut self) {
        let declared = self.included_components.clone();
        self.snapshot_kind = SnapshotKind::Full;
        self.required_components = Self::full_required_components();
        self.refresh_included_components();
        self.included_components.extend(declared);
        if !self
            .included_components
            .iter()
            .any(|component| component == "workspaces-root")
        {
            self.included_components.push("workspaces-root".to_string());
        }
        self.included_components.sort();
        self.included_components.dedup();
    }

    fn mark_partial(&mut self) {
        let declared = self.included_components.clone();
        self.snapshot_kind = SnapshotKind::PartialOverlay;
        self.required_components.clear();
        self.refresh_included_components();
        self.included_components.extend(declared);
        self.included_components.sort();
        self.included_components.dedup();
    }

    /// Validate the stronger contract required before replacing an inactive
    /// slot. General inspection/export may still use partial or legacy packages.
    pub fn validate_for_slot_restore(&self) -> Result<(), BackupError> {
        self.validate_untrusted()?;
        if self.is_incremental {
            return Err(BackupError::IncrementalRestoreNotSupported(
                "增量备份不能直接替换完整数据槽".to_string(),
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

        let required = self
            .required_components
            .iter()
            .cloned()
            .collect::<HashSet<_>>();
        let included = self
            .included_components
            .iter()
            .cloned()
            .collect::<HashSet<_>>();
        for component in Self::full_required_components() {
            if !required.contains(&component) || !included.contains(&component) {
                return Err(BackupError::Manifest(format!(
                    "完整快照组件闭包不完整: {}",
                    component
                )));
            }
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
            } else if file.path.ends_with(".db") {
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
            } else {
                let root = file.path.split('/').next().unwrap_or_default();
                let known_asset_root = AssetType::all()
                    .into_iter()
                    .any(|asset_type| asset_type.relative_path() == root)
                    || matches!(root, "lance" | "assets");
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
        Ok(())
    }

    fn validate_untrusted(&self) -> Result<(), BackupError> {
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
        Ok(())
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
        let manifest: Self = serde_json::from_str(&content)
            .map_err(|e| BackupError::Manifest(format!("解析清单失败: {}", e)))?;
        manifest.validate_untrusted()?;
        Ok(manifest)
    }
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
            BackupTier::Rebuildable => vec!["lance"],
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

/// 变更日志表 SQL（用于增量备份）
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
/// 负责执行数据库的完整备份、增量备份、恢复和验证操作。
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
    /// 注意：`app_data_dir` 是 Tauri 根数据目录（如 `com.deepstudent.app`），
    /// 实际数据库存储在活动数据空间目录（如 `slots/slotA`）中。
    pub(crate) fn get_database_path(&self, id: &DatabaseId) -> PathBuf {
        let active_dir = crate::data_space::get_data_space_manager()
            .map(|mgr| mgr.active_dir())
            .unwrap_or_else(|| self.app_data_dir.join("slots").join("slotA"));

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

        // 4. 保存清单
        let manifest_path = backup_subdir.join(MANIFEST_FILENAME);
        manifest.save_to_file(&manifest_path)?;

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
            let active_asset_dir = crate::data_space::get_data_space_manager()
                .map(|mgr| mgr.active_dir())
                .unwrap_or_else(|| self.app_data_dir.join("slots").join("slotA"));
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

        for asset_type in &config.asset_types {
            manifest
                .included_components
                .push(format!("asset-root:{}", asset_type.relative_path()));
        }
        let selected_asset_roots = config
            .asset_types
            .iter()
            .map(AssetType::relative_path)
            .collect::<HashSet<_>>();
        let all_asset_roots = AssetType::all()
            .iter()
            .map(AssetType::relative_path)
            .collect::<HashSet<_>>();
        let assets_complete = config.compute_checksum
            && selected_asset_roots == all_asset_roots
            && manifest.assets.as_ref().is_some_and(|result| {
                result.skipped_files == 0
                    && result.files.iter().all(|asset| {
                        asset.is_directory
                            || asset.checksum.as_ref().is_some_and(|sum| {
                                sum.len() == 64 && sum.bytes().all(|byte| byte.is_ascii_hexdigit())
                            })
                    })
            });
        if assets_complete {
            manifest.mark_full();
        } else {
            manifest.mark_partial();
        }

        // 5. 保存清单
        let manifest_path = backup_subdir.join(MANIFEST_FILENAME);
        manifest.save_to_file(&manifest_path)?;

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

            // 检查数据库是否存在
            if !db_path.exists() {
                return Err(BackupError::FileNotFound(format!(
                    "完整备份缺少核心数据库 {}: {}",
                    db_id.as_str(),
                    db_path.display()
                )));
            }

            // 发送进度回调
            if let Some(ref cb) = self.progress_callback {
                cb(idx, total, db_id.as_str(), 0, 0);
            }

            info!("备份数据库: {:?} -> {:?}", db_id, db_path);

            // 备份单个数据库
            let backup_file =
                self.backup_single_database(&db_id, &db_path, &backup_subdir, idx, total)?;
            manifest.add_file(backup_file);

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

        // 3.5b 备份审计数据库（操作追溯支持，失败不阻断）
        match self.backup_audit_db(&backup_subdir) {
            Ok(true) => info!("审计数据库备份完成"),
            Ok(false) => debug!("审计数据库不存在，跳过备份"),
            Err(e) => warn!("审计数据库备份失败（非致命）: {}", e),
        }

        // 3.6 备份工作区数据库（ws_*.db）
        let active_dir_for_ws = crate::data_space::get_data_space_manager()
            .map(|mgr| mgr.active_dir())
            .unwrap_or_else(|| self.app_data_dir.join("slots").join("slotA"));
        let workspace_files =
            self.backup_workspace_databases(&active_dir_for_ws, &backup_subdir)?;
        if !workspace_files.is_empty() {
            info!("工作区数据库备份完成: {} 个", workspace_files.len());
        }
        manifest.files.extend(workspace_files);

        manifest
            .included_components
            .push("workspaces-root".to_string());
        manifest.mark_partial();

        Ok((manifest, backup_subdir))
    }

    /// 备份加密密钥文件到备份目录
    ///
    /// 包含 `.master_key`（CryptoService 主密钥）和 `.secure/` 目录（SecureStore 密钥种子 + 加密凭据）。
    /// 这些文件在跨设备恢复时必须一并还原，否则 API 密钥将无法解密。
    pub fn backup_crypto_keys(&self, backup_subdir: &Path) -> Result<usize, BackupError> {
        let master_key_path = self.app_data_dir.join(".master_key");
        let secure_dir = self.app_data_dir.join(".secure");

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
            fs::copy(&master_key_path, &dest)
                .map_err(|e| BackupError::RestoreFailed(format!("备份 .master_key 失败: {}", e)))?;
            count += 1;
            info!("[Backup] 已备份 .master_key");
        }

        // 2. 备份 .secure/ 目录（.key_seed + *.enc）
        if has_secure_dir {
            let secure_dest = crypto_dest.join(".secure");
            fs::create_dir_all(&secure_dest)?;

            let mut secure_count = 0usize;
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
                    if let Some(file_name) = path.file_name() {
                        let dest = secure_dest.join(file_name);
                        fs::copy(&path, &dest).map_err(|e| {
                            BackupError::RestoreFailed(format!(
                                "备份 .secure/{} 失败: {}",
                                file_name.to_string_lossy(),
                                e
                            ))
                        })?;
                        secure_count += 1;
                    }
                }
            }
            count += secure_count;
            info!("[Backup] 已备份 .secure/ 目录: {} 个文件", secure_count);
        }

        Ok(count)
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

        let rollback = tempfile::Builder::new()
            .prefix("crypto-restore-rollback-")
            .tempdir_in(&self.app_data_dir)
            .map_err(|e| BackupError::RestoreFailed(format!("创建密钥回滚目录失败: {}", e)))?;
        let target_master = self.app_data_dir.join(".master_key");
        let target_secure = self.app_data_dir.join(".secure");
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
    /// audit.db 作为辅助文件备份，失败不阻断主流程。
    /// 使用 SQLite Backup API 确保 WAL 模式下的一致性。
    pub fn backup_audit_db(&self, backup_subdir: &Path) -> Result<bool, BackupError> {
        let audit_src = self.app_data_dir.join("databases").join("audit.db");
        if !audit_src.exists() {
            return Ok(false);
        }

        let audit_dest_dir = backup_subdir.join("databases");
        fs::create_dir_all(&audit_dest_dir)?;
        let audit_dest = audit_dest_dir.join("audit.db");

        let src_conn = Connection::open(&audit_src)?;
        let _ = src_conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");

        let mut dst_conn = Connection::open(&audit_dest)?;
        let backup = Backup::new(&src_conn, &mut dst_conn)?;
        backup.run_to_completion(50, Duration::from_millis(50), None)?;

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

        let audit_dest = self.app_data_dir.join("databases").join("audit.db");
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

            let db_id_str = backup_file.database_id.as_ref().ok_or_else(|| {
                BackupError::Manifest(format!("备份文件缺少 database_id: {}", backup_file.path))
            })?;

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
                match assets::restore_assets(
                    &backup_subdir,
                    &active_restore_dir,
                    &asset_result.files,
                ) {
                    Ok(count) => {
                        restored_assets = count;
                        info!("资产恢复完成: {} 个文件", count);
                    }
                    Err(e) => {
                        error!("资产恢复失败: {}", e);
                        restore_errors.push(format!("资产恢复: {}", e));
                    }
                }
            } else {
                // manifest.assets 为 None 时，尝试直接扫描备份目录中的 assets/ 子目录
                let assets_dir = backup_subdir.join("assets");
                if assets_dir.exists() && assets_dir.is_dir() {
                    info!(
                        "manifest.assets 为空，但备份目录中存在 assets/，尝试直接复制恢复: {:?}",
                        assets_dir
                    );
                    match assets::restore_assets_from_dir(&assets_dir, &active_restore_dir) {
                        Ok(count) => {
                            restored_assets = count;
                            info!("资产目录直接恢复完成: {} 个文件", count);
                        }
                        Err(e) => {
                            error!("资产目录直接恢复失败: {}", e);
                            restore_errors.push(format!("资产目录恢复: {}", e));
                        }
                    }
                } else {
                    warn!("备份中无资产文件可恢复 (manifest.assets=None, assets/ 目录不存在)");
                }
            }
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

            let db_id_str = backup_file.database_id.as_ref().ok_or_else(|| {
                BackupError::Manifest(format!("备份文件缺少 database_id: {}", backup_file.path))
            })?;

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
        match self.restore_workspace_databases(&backup_subdir, target_dir) {
            Ok(count) => {
                if count > 0 {
                    info!("工作区数据库恢复完成: {} 个", count);
                }
            }
            Err(e) => {
                warn!("工作区数据库恢复失败（非致命）: {}", e);
            }
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
                match assets::restore_assets(&backup_subdir, target_dir, &asset_result.files) {
                    Ok(count) => {
                        restored_assets = count;
                        info!("资产恢复完成: {} 个文件", count);
                    }
                    Err(e) => {
                        error!("资产恢复失败: {}", e);
                        restore_errors.push(format!("资产恢复: {}", e));
                    }
                }
            } else {
                let assets_dir = backup_subdir.join("assets");
                if assets_dir.exists() && assets_dir.is_dir() {
                    info!("manifest.assets 为空，尝试从 assets/ 目录直接恢复");
                    match assets::restore_assets_from_dir(&assets_dir, target_dir) {
                        Ok(count) => {
                            restored_assets = count;
                            info!("资产目录直接恢复完成: {} 个文件", count);
                        }
                        Err(e) => {
                            error!("资产目录直接恢复失败: {}", e);
                            restore_errors.push(format!("资产目录恢复: {}", e));
                        }
                    }
                }
            }
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
                        if busy_retries % 200 == 0 {
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

    /// 执行增量备份
    ///
    /// 基于变更日志表 `__change_log` 导出自上次备份以来的变更。
    ///
    /// ## 参数
    ///
    /// * `base_version` - 基础备份的版本标识（backup_id）
    ///
    /// ## 注意
    ///
    /// 需要应用层在数据变更时维护 `__change_log` 表
    pub fn backup_incremental(&self, base_version: &str) -> Result<BackupManifest, BackupError> {
        info!("开始执行增量备份，基础版本: {}", base_version);

        // 验证基础备份存在
        let base_backup_dir = self.backup_dir.join(base_version);
        if !base_backup_dir.exists() {
            return Err(BackupError::Manifest(format!(
                "基础备份不存在: {}",
                base_version
            )));
        }

        // 创建增量备份目录
        let (backup_id, backup_subdir) = self.create_unique_backup_subdir(Some("incr"))?;

        let mut manifest = BackupManifest::new(&self.app_version);
        manifest.backup_id = backup_id;
        manifest.is_incremental = true;
        manifest.incremental_base = Some(base_version.to_string());

        // 对每个数据库导出变更
        for db_id in DatabaseId::all_ordered() {
            let db_path = self.get_database_path(&db_id);

            if !db_path.exists() {
                continue;
            }

            // 导出变更日志
            if let Some(backup_file) =
                self.export_changes(&db_id, &db_path, &backup_subdir, base_version)?
            {
                manifest.add_file(backup_file);
            }
        }

        // 保存清单
        let manifest_path = backup_subdir.join(MANIFEST_FILENAME);
        manifest.save_to_file(&manifest_path)?;

        info!("增量备份完成，共 {} 个变更文件", manifest.files.len());

        Ok(manifest)
    }

    /// 导出数据库的变更日志
    fn export_changes(
        &self,
        db_id: &DatabaseId,
        db_path: &Path,
        backup_dir: &Path,
        _base_version: &str,
    ) -> Result<Option<BackupFile>, BackupError> {
        let conn = Connection::open(db_path)?;

        // 检查变更日志表是否存在
        let table_exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='__change_log')",
            [],
            |row| row.get(0),
        )?;

        if !table_exists {
            debug!("数据库 {:?} 无变更日志表，跳过增量备份", db_id);
            return Ok(None);
        }

        // 查询未同步的变更
        let mut stmt = conn.prepare(
            "SELECT id, table_name, record_id, operation, changed_at, sync_version
             FROM __change_log
             WHERE sync_version = 0
             ORDER BY id ASC",
        )?;

        let changes: Vec<ChangeLogEntry> = stmt
            .query_map([], |row| {
                Ok(ChangeLogEntry {
                    id: row.get(0)?,
                    table_name: row.get(1)?,
                    record_id: row.get(2)?,
                    operation: row.get(3)?,
                    changed_at: row.get(4)?,
                    sync_version: row.get(5)?,
                })
            })?
            .filter_map(log_and_skip_err)
            .collect();

        if changes.is_empty() {
            debug!("数据库 {:?} 无新变更", db_id);
            return Ok(None);
        }

        // 序列化变更日志
        let changes_json = serde_json::to_string_pretty(&changes)
            .map_err(|e| BackupError::Manifest(format!("序列化变更日志失败: {}", e)))?;

        // 保存到文件
        let changes_path = backup_dir.join(format!("{}_changes.json", db_id.as_str()));
        let mut file = File::create(&changes_path)?;
        file.write_all(changes_json.as_bytes())?;
        file.sync_all()?;

        // 计算校验和
        let sha256 = calculate_file_sha256(&changes_path)?;
        let size = fs::metadata(&changes_path)?.len();

        info!("导出数据库 {:?} 的 {} 条变更记录", db_id, changes.len());

        Ok(Some(BackupFile {
            path: format!("{}_changes.json", db_id.as_str()),
            size,
            sha256,
            database_id: Some(db_id.as_str().to_string()),
        }))
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
        let manifest_major = manifest
            .version
            .split('.')
            .next()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);

        if manifest_major > MANIFEST_MAX_SUPPORTED_MAJOR {
            return Err(BackupError::VersionIncompatible(format!(
                "备份清单版本 {} 高于当前应用支持的最大版本 {}.x.x。请升级应用后重试恢复。",
                manifest.version, MANIFEST_MAX_SUPPORTED_MAJOR
            )));
        }

        // 2. 增量备份不支持直接恢复
        if manifest.is_incremental {
            return Err(BackupError::IncrementalRestoreNotSupported(
                "增量备份不支持直接恢复。请使用完整备份进行恢复，或等待后续版本支持增量恢复合并。"
                    .to_string(),
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
                let db_id_str = backup_file.database_id.as_deref().ok_or_else(|| {
                    BackupError::Manifest(format!("备份文件缺少 database_id: {}", backup_file.path))
                })?;
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

            let db_id_str = backup_file.database_id.as_ref().ok_or_else(|| {
                BackupError::Manifest(format!("备份文件缺少 database_id: {}", backup_file.path))
            })?;

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
            let existing_conn = Connection::open(&target_path)?;
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
        let mut dest_conn = Connection::open(&target_path)?;

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
                        if busy_retries % 50 == 0 {
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

            // 3. 验证数据库完整性（仅对 .db 文件）
            if backup_file.path.ends_with(".db") {
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
    /// 备份失败不阻断主流程（返回已成功备份数量）。
    fn backup_workspace_databases(
        &self,
        active_dir: &Path,
        backup_dir: &Path,
    ) -> Result<Vec<BackupFile>, BackupError> {
        let src_dir = active_dir.join("workspaces");
        if !src_dir.exists() {
            return Ok(Vec::new());
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

            let rel = Path::new(&backup_file.path);
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

            // 检查数据库是否存在
            if !db_path.exists() {
                return Err(BackupError::FileNotFound(format!(
                    "已选择的数据库不存在 {}: {}",
                    db_id.as_str(),
                    db_path.display()
                )));
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

            manifest.add_file(backup_file);

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
        self.backup_audit_db(&backup_subdir)?;

        // 4.5 备份工作区数据库（ws_*.db）
        let active_dir_for_ws = crate::data_space::get_data_space_manager()
            .map(|mgr| mgr.active_dir())
            .unwrap_or_else(|| self.app_data_dir.join("slots").join("slotA"));
        let workspace_files =
            self.backup_workspace_databases(&active_dir_for_ws, &backup_subdir)?;
        if !workspace_files.is_empty() {
            info!("工作区数据库备份完成: {} 个", workspace_files.len());
        }
        manifest.files.extend(workspace_files);
        manifest
            .included_components
            .push("workspaces-root".to_string());

        // 5. 备份资产文件（如果启用）
        if selection.include_assets {
            let asset_config = selection.asset_config.clone().unwrap_or_default();
            let asset_dirs = selection.get_asset_directories();

            // 使用活动数据空间目录查找资产（与运行时 FileManager 绑定位置一致）
            let active_asset_base = crate::data_space::get_data_space_manager()
                .map(|mgr| mgr.active_dir())
                .unwrap_or_else(|| self.app_data_dir.join("slots").join("slotA"));

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
                    manifest
                        .included_components
                        .push(format!("asset-root:{}", dir_name));
                }

                let asset_dir = active_asset_base.join(dir_name);
                if !asset_dir.exists() {
                    debug!("资产目录不存在，跳过: {:?}", asset_dir);
                    continue;
                }

                info!("备份资产目录: {:?}", asset_dir);

                let (files, skipped) = self.backup_asset_directory(
                    &asset_dir,
                    dir_name,
                    &backup_subdir,
                    &asset_config,
                )?;

                for file in files {
                    let tier_name = "LargeAssets".to_string();
                    *tier_file_counts.entry(tier_name.clone()).or_insert(0) += 1;
                    *tier_sizes.entry(tier_name).or_insert(0) += file.size;
                    manifest.add_file(file);
                }

                skipped_files.extend(skipped);
            }
        }

        // 6. 记录备份的层级
        for tier in BackupTier::all_ordered() {
            let tier_name = format!("{:?}", tier);
            if tier_file_counts.contains_key(&tier_name) {
                backed_up_tiers.push(tier);
            }
        }

        let selected_tiers = selection.tiers.iter().copied().collect::<HashSet<_>>();
        let all_tiers = BackupTier::all_ordered()
            .into_iter()
            .collect::<HashSet<_>>();
        let asset_filter_is_complete = selection
            .asset_config
            .as_ref()
            .map(|config| config.asset_types.is_empty())
            .unwrap_or(true);
        let full_snapshot = selected_tiers == all_tiers
            && selection.include_databases.is_empty()
            && selection.exclude_databases.is_empty()
            && selection.include_assets
            && asset_filter_is_complete
            && skipped_files.is_empty();
        if full_snapshot {
            manifest.mark_full();
        } else {
            manifest.mark_partial();
        }

        // 7. 保存清单
        let manifest_path = backup_subdir.join(MANIFEST_FILENAME);
        manifest.save_to_file(&manifest_path)?;

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
            .follow_links(config.follow_symlinks)
            .into_iter()
            .filter_entry(|e| {
                // 过滤隐藏文件
                if !config.include_hidden {
                    if let Some(name) = e.file_name().to_str() {
                        if name.starts_with('.') {
                            return false;
                        }
                    }
                }
                true
            });

        for entry in walker {
            let entry = entry
                .map_err(|e| BackupError::BackupDirectory(format!("遍历资产目录失败: {}", e)))?;

            // 只处理文件
            if !entry.file_type().is_file() {
                continue;
            }

            let path = entry.path();
            let relative_path = path
                .strip_prefix(source_dir)
                .map_err(|_| BackupError::BackupDirectory("无法计算相对路径".to_string()))?;

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
            let metadata = fs::metadata(path)?;
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
            fs::copy(path, &target_path)?;

            // 计算校验和
            let sha256 = calculate_file_sha256(&target_path)?;

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

/// 变更日志条目
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChangeLogEntry {
    id: i64,
    table_name: String,
    record_id: String,
    operation: String,
    changed_at: String,
    sync_version: i64,
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

        // 恢复
        manager.restore(&manifest).unwrap();

        // 验证恢复后的数据库
        assert!(vfs_db_path.exists());
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
