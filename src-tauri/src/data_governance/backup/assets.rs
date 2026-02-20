//! 资产文件备份模块
//!
//! 支持备份用户的图片、文档、音视频等资产文件。
//!
//! ## 设计原则
//!
//! 1. **分类备份**：按资产类型（图片、文档、音视频等）分别备份
//! 2. **安全过滤**：跳过敏感文件和符号链接
//! 3. **大小限制**：支持单文件和总大小限制
//! 4. **校验和支持**：可选计算 SHA256 校验和
//!
//! ## 资产优先级
//!
//! - P0（高优先级）：images, notes_assets, documents, vfs_blobs, subjects, workspaces, textbooks
//! - P1（低优先级）：audio, videos

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Component;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tracing::{debug, info, warn};

/// 资产类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetType {
    /// 图片资产
    Images,
    /// 笔记附件资产
    NotesAssets,
    /// 文档资产
    Documents,
    /// VFS Blob 存储
    VfsBlobs,
    /// 学科资产
    Subjects,
    /// 工作空间资产
    Workspaces,
    /// 音频资产
    Audio,
    /// 视频资产
    Videos,
    /// 教材资产
    Textbooks,
}

/// 复制文件（带重试与大小校验）
///
/// 处理跨平台常见瞬态错误（Windows 文件占用、Android I/O 抖动、macOS 临时锁）
/// 并在复制后校验源/目标大小一致，避免静默写入不完整。
fn copy_file_with_retry(src: &Path, dest: &Path) -> Result<(), AssetBackupError> {
    const MAX_RETRIES: u32 = 5;
    const RETRY_SLEEP_MS: u64 = 80;

    let mut last_error: Option<String> = None;

    for attempt in 0..MAX_RETRIES {
        match fs::copy(src, dest) {
            Ok(_) => {
                let src_size = fs::metadata(src).map(|m| m.len());
                let dest_size = fs::metadata(dest).map(|m| m.len());

                match (src_size, dest_size) {
                    (Ok(src_size), Ok(dest_size)) => {
                        if src_size == dest_size {
                            return Ok(());
                        }

                        last_error = Some(format!(
                            "复制后大小不一致: {:?} -> {:?}, expected={}, actual={}",
                            src, dest, src_size, dest_size
                        ));
                    }
                    (Err(e), _) => {
                        last_error = Some(format!(
                            "复制后读取源文件元数据失败: {:?}, error={}",
                            src, e
                        ));
                    }
                    (_, Err(e)) => {
                        last_error = Some(format!(
                            "复制后读取目标文件元数据失败: {:?}, error={}",
                            dest, e
                        ));
                    }
                }
            }
            Err(e) => {
                last_error = Some(format!(
                    "复制资产失败: {:?} -> {:?}: {}",
                    src, dest, e
                ));
            }
        }

        // 清理可能写入了一半的目标文件，避免下次重试命中脏文件
        let _ = fs::remove_file(dest);

        if attempt + 1 < MAX_RETRIES {
            std::thread::sleep(Duration::from_millis(RETRY_SLEEP_MS));
        }
    }

    Err(AssetBackupError::RestoreFailed(last_error.unwrap_or_else(
        || "复制资产失败（未知错误）".to_string(),
    )))
}

impl AssetType {
    /// 获取资产目录相对路径
    pub fn relative_path(&self) -> &'static str {
        match self {
            AssetType::Images => "images",
            AssetType::NotesAssets => "notes_assets",
            AssetType::Documents => "documents",
            AssetType::VfsBlobs => "vfs_blobs",
            AssetType::Subjects => "subjects",
            AssetType::Workspaces => "workspaces",
            AssetType::Audio => "audio",
            AssetType::Videos => "videos",
            AssetType::Textbooks => "textbooks",
        }
    }

    /// 获取资产类型的显示名称
    pub fn display_name(&self) -> &'static str {
        match self {
            AssetType::Images => "图片",
            AssetType::NotesAssets => "笔记附件",
            AssetType::Documents => "文档",
            AssetType::VfsBlobs => "VFS 存储",
            AssetType::Subjects => "学科资源",
            AssetType::Workspaces => "工作空间",
            AssetType::Audio => "音频",
            AssetType::Videos => "视频",
            AssetType::Textbooks => "教材",
        }
    }

    /// 获取优先级（P0 最高）
    ///
    /// - P0：核心数据资产，必须备份
    /// - P1：大文件资产，可选备份
    pub fn priority(&self) -> u8 {
        match self {
            AssetType::Images
            | AssetType::NotesAssets
            | AssetType::Documents
            | AssetType::VfsBlobs
            | AssetType::Subjects
            | AssetType::Workspaces
            | AssetType::Textbooks => 0,
            AssetType::Audio | AssetType::Videos => 1,
        }
    }

    /// 获取所有资产类型
    pub fn all() -> Vec<AssetType> {
        vec![
            AssetType::Images,
            AssetType::NotesAssets,
            AssetType::Documents,
            AssetType::VfsBlobs,
            AssetType::Subjects,
            AssetType::Workspaces,
            AssetType::Audio,
            AssetType::Videos,
            AssetType::Textbooks,
        ]
    }

    /// 获取 P0 优先级的资产类型
    pub fn p0_assets() -> Vec<AssetType> {
        vec![
            AssetType::Images,
            AssetType::NotesAssets,
            AssetType::Documents,
            AssetType::VfsBlobs,
            AssetType::Subjects,
            AssetType::Workspaces,
            AssetType::Textbooks,
        ]
    }

    /// 获取 P1 优先级的资产类型（大文件）
    pub fn p1_assets() -> Vec<AssetType> {
        vec![AssetType::Audio, AssetType::Videos]
    }

    /// 从字符串解析资产类型
    pub fn from_str(s: &str) -> Option<AssetType> {
        match s {
            "images" => Some(AssetType::Images),
            "notes_assets" => Some(AssetType::NotesAssets),
            "documents" => Some(AssetType::Documents),
            "vfs_blobs" => Some(AssetType::VfsBlobs),
            "subjects" => Some(AssetType::Subjects),
            "workspaces" => Some(AssetType::Workspaces),
            "audio" => Some(AssetType::Audio),
            "videos" => Some(AssetType::Videos),
            "textbooks" => Some(AssetType::Textbooks),
            _ => None,
        }
    }

    /// 转换为稳定字符串 ID（用于统计与前端展示）
    pub fn as_str(&self) -> &'static str {
        self.relative_path()
    }

    /// 安全地过滤和规范化相对路径
    /// 1. 将所有反斜杠 `\` 替换为正斜杠 `/`
    /// 2. 拒绝绝对路径（如 `/etc/passwd`）和带有 `..` 的目录穿越路径
    pub fn sanitize_relative_path(path_str: &str) -> Result<String, AssetBackupError> {
        let normalized = path_str.trim().replace('\\', "/");
        // 拒绝空路径、Unix 绝对路径、UNC 路径、Windows 盘符绝对路径
        let has_drive_prefix = normalized.len() >= 3
            && normalized.as_bytes()[1] == b':'
            && normalized.as_bytes()[2] == b'/'
            && normalized.as_bytes()[0].is_ascii_alphabetic();
        if normalized.is_empty()
            || normalized.starts_with('/')
            || normalized.starts_with("//")
            || has_drive_prefix
            || normalized.contains("../")
            || normalized == ".."
        {
            return Err(AssetBackupError::InvalidConfig(format!(
                "不安全的路径（绝对路径或目录穿越）: {}",
                path_str
            )));
        }
        Ok(normalized)
    }
}

fn safe_join_under_root(root: &Path, unsafe_relative_path: &str) -> Result<std::path::PathBuf, AssetBackupError> {
    let normalized = AssetType::sanitize_relative_path(unsafe_relative_path)?;
    let mut clean = std::path::PathBuf::new();

    for component in Path::new(&normalized).components() {
        match component {
            Component::Normal(seg) => clean.push(seg),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(AssetBackupError::InvalidConfig(format!(
                    "不安全的路径组件: {}",
                    unsafe_relative_path
                )));
            }
        }
    }

    Ok(root.join(clean))
}

/// 资产备份配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetBackupConfig {
    /// 要备份的资产类型
    pub asset_types: Vec<AssetType>,
    /// 是否计算校验和
    pub compute_checksum: bool,
    /// 单文件最大大小（字节），超过此大小的文件将被跳过
    pub max_file_size: u64,
    /// 总大小限制（字节），达到后停止备份
    pub max_total_size: u64,
    /// 跳过符号链接
    pub skip_symlinks: bool,
    /// 跳过敏感文件
    pub skip_sensitive_files: bool,
    /// 是否保留目录结构
    pub preserve_directory_structure: bool,
    /// 文件扩展名过滤（空表示不过滤）
    #[serde(default)]
    pub allowed_extensions: Vec<String>,
    /// 排除的文件扩展名
    #[serde(default)]
    pub excluded_extensions: Vec<String>,
}

impl Default for AssetBackupConfig {
    fn default() -> Self {
        Self {
            asset_types: AssetType::all(),
            compute_checksum: true,
            max_file_size: 500 * 1024 * 1024,        // 500MB
            max_total_size: 10 * 1024 * 1024 * 1024, // 10GB
            skip_symlinks: true,
            skip_sensitive_files: true,
            preserve_directory_structure: true,
            allowed_extensions: Vec::new(),
            excluded_extensions: Vec::new(),
        }
    }
}

impl AssetBackupConfig {
    /// 创建仅备份 P0 资产的配置
    pub fn p0_only() -> Self {
        Self {
            asset_types: AssetType::p0_assets(),
            ..Default::default()
        }
    }

    /// 创建包含大文件的配置
    pub fn with_large_files() -> Self {
        Self {
            asset_types: AssetType::all(),
            max_file_size: 2 * 1024 * 1024 * 1024,   // 2GB
            max_total_size: 50 * 1024 * 1024 * 1024, // 50GB
            ..Default::default()
        }
    }

    /// 创建快速备份配置（不计算校验和）
    pub fn fast() -> Self {
        Self {
            compute_checksum: false,
            ..Default::default()
        }
    }
}

/// 资产文件备份结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetBackupResult {
    /// 备份的文件列表
    pub files: Vec<BackedUpAsset>,
    /// 总文件数
    pub total_files: usize,
    /// 总大小（字节）
    pub total_size: u64,
    /// 跳过的文件数
    pub skipped_files: usize,
    /// 跳过原因统计
    pub skip_reasons: HashMap<String, usize>,
    /// 按资产类型统计
    pub by_asset_type: HashMap<String, AssetTypeStats>,
    /// 备份开始时间
    pub started_at: String,
    /// 备份完成时间
    pub completed_at: String,
}

/// 资产类型统计
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AssetTypeStats {
    /// 文件数量
    pub file_count: usize,
    /// 总大小（字节）
    pub total_size: u64,
}

/// 备份的资产文件
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackedUpAsset {
    /// 资产类型
    pub asset_type: AssetType,
    /// 相对路径（相对于备份目录）
    pub relative_path: String,
    /// 原始路径（相对于应用数据目录）
    pub original_path: String,
    /// 文件大小
    pub size: u64,
    /// SHA256 校验和（可选）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checksum: Option<String>,
    /// 修改时间
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<String>,
    /// 是否是目录
    #[serde(default)]
    pub is_directory: bool,
}

/// 资产备份错误
#[derive(Debug, thiserror::Error)]
pub enum AssetBackupError {
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),

    #[error("源目录不存在: {0}")]
    SourceNotFound(String),

    #[error("目标目录创建失败: {0}")]
    DestinationCreationFailed(String),

    #[error("文件复制失败: {src_path} -> {dest_path}, 错误: {message}")]
    CopyFailed {
        src_path: String,
        dest_path: String,
        message: String,
    },

    #[error("超出总大小限制: 当前 {current} 字节，限制 {limit} 字节")]
    TotalSizeLimitExceeded { current: u64, limit: u64 },

    #[error("校验和计算失败: {0}")]
    ChecksumError(String),

    #[error("配置无效: {0}")]
    InvalidConfig(String),

    #[error("资产恢复失败: {0}")]
    RestoreFailed(String),

    #[error("用户取消恢复（资产阶段）")]
    Cancelled,
}

impl AssetBackupError {
    pub fn is_cancelled(&self) -> bool {
        matches!(self, Self::Cancelled)
    }
}

// ============================================================================
// 敏感文件检测
// ============================================================================

/// 敏感文件模式列表
const SENSITIVE_PATTERNS: &[&str] = &[
    ".env",
    "credentials",
    ".pem",
    ".key",
    ".p12",
    ".pfx",
    "secret",
    "password",
    "token",
    ".htpasswd",
    ".ssh",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    ".aws",
    ".npmrc",
    ".pypirc",
    "auth.json",
    "secrets.json",
    "config.json", // 可能包含敏感信息
];

/// 检查是否为敏感文件
///
/// 通过文件名和路径中的模式匹配来检测敏感文件。
pub fn is_sensitive_file(path: &Path) -> bool {
    // 获取文件名
    let file_name = match path.file_name() {
        Some(name) => name.to_string_lossy().to_lowercase(),
        None => return false,
    };

    // 检查文件名是否匹配敏感模式
    for pattern in SENSITIVE_PATTERNS {
        if file_name.contains(pattern) {
            return true;
        }
    }

    // 检查路径中是否包含敏感目录
    let path_str = path.to_string_lossy().to_lowercase();
    if path_str.contains("/.ssh/")
        || path_str.contains("\\.ssh\\")
        || path_str.contains("/secrets/")
        || path_str.contains("\\secrets\\")
        || path_str.contains("/credentials/")
        || path_str.contains("\\credentials\\")
    {
        return true;
    }

    false
}

// ============================================================================
// 文件校验和计算
// ============================================================================

/// 计算文件的 SHA256 校验和
fn calculate_file_checksum(path: &Path) -> Result<String, AssetBackupError> {
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

/// 获取文件修改时间
fn get_file_modified_time(path: &Path) -> Option<String> {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339())
}

// ============================================================================
// 资产备份核心功能
// ============================================================================

/// 执行资产备份
///
/// ## 参数
///
/// - `app_data_dir`: 应用数据目录
/// - `dest_dir`: 备份目标目录
/// - `config`: 备份配置
///
/// ## 返回
///
/// 备份结果，包含备份的文件列表和统计信息
pub fn backup_assets(
    app_data_dir: &Path,
    dest_dir: &Path,
    config: &AssetBackupConfig,
) -> Result<AssetBackupResult, AssetBackupError> {
    info!(
        "开始资产备份: src={:?}, dest={:?}, types={:?}",
        app_data_dir,
        dest_dir,
        config.asset_types.len()
    );

    let started_at = chrono::Utc::now().to_rfc3339();

    // 验证配置
    if config.asset_types.is_empty() {
        return Err(AssetBackupError::InvalidConfig(
            "asset_types 不能为空".to_string(),
        ));
    }

    // 创建目标目录
    if !dest_dir.exists() {
        fs::create_dir_all(dest_dir).map_err(|e| {
            AssetBackupError::DestinationCreationFailed(format!("{:?}: {}", dest_dir, e))
        })?;
    }

    let mut result = AssetBackupResult {
        files: Vec::new(),
        total_files: 0,
        total_size: 0,
        skipped_files: 0,
        skip_reasons: HashMap::new(),
        by_asset_type: HashMap::new(),
        started_at,
        completed_at: String::new(),
    };

    // 按优先级排序资产类型
    let mut sorted_types = config.asset_types.clone();
    sorted_types.sort_by_key(|t| t.priority());

    // 备份每种资产类型
    for asset_type in &sorted_types {
        let src_path = app_data_dir.join(asset_type.relative_path());

        // 检查源目录是否存在
        if !src_path.exists() {
            debug!("资产目录不存在，跳过: {:?} ({:?})", asset_type, src_path);
            continue;
        }

        // 创建资产类型的目标目录
        let asset_dest_dir = if config.preserve_directory_structure {
            dest_dir.join("assets").join(asset_type.relative_path())
        } else {
            dest_dir.join("assets")
        };
        fs::create_dir_all(&asset_dest_dir)?;

        // 备份该类型的所有文件
        backup_asset_directory(&src_path, &asset_dest_dir, *asset_type, config, &mut result)?;
    }

    result.completed_at = chrono::Utc::now().to_rfc3339();
    result.total_files = result.files.len();

    info!(
        "资产备份完成: files={}, size={}, skipped={}",
        result.total_files, result.total_size, result.skipped_files
    );

    Ok(result)
}

/// 备份单个资产目录
fn backup_asset_directory(
    src_dir: &Path,
    dest_dir: &Path,
    asset_type: AssetType,
    config: &AssetBackupConfig,
    result: &mut AssetBackupResult,
) -> Result<(), AssetBackupError> {
    debug!("备份资产目录: {:?} -> {:?}", src_dir, dest_dir);

    // 递归遍历目录
    backup_directory_recursive(src_dir, dest_dir, src_dir, asset_type, config, result)
}

/// 递归备份目录
fn backup_directory_recursive(
    current_dir: &Path,
    dest_base: &Path,
    src_base: &Path,
    asset_type: AssetType,
    config: &AssetBackupConfig,
    result: &mut AssetBackupResult,
) -> Result<(), AssetBackupError> {
    let entries = match fs::read_dir(current_dir) {
        Ok(entries) => entries,
        Err(e) => {
            warn!("无法读取目录 {:?}: {}", current_dir, e);
            return Ok(());
        }
    };

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                warn!("读取目录项失败: {}", e);
                continue;
            }
        };

        let path = entry.path();
        let metadata = match fs::metadata(&path) {
            Ok(m) => m,
            Err(e) => {
                warn!("获取文件元数据失败 {:?}: {}", path, e);
                result.skipped_files += 1;
                *result
                    .skip_reasons
                    .entry("metadata_error".to_string())
                    .or_insert(0) += 1;
                continue;
            }
        };

        // 检查是否为符号链接
        if config.skip_symlinks
            && fs::symlink_metadata(&path)
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false)
        {
            debug!("跳过符号链接: {:?}", path);
            result.skipped_files += 1;
            *result
                .skip_reasons
                .entry("symlink".to_string())
                .or_insert(0) += 1;
            continue;
        }

        if metadata.is_dir() {
            // 递归处理子目录
            let relative_path = path.strip_prefix(src_base).unwrap_or(&path);
            let dest_subdir = dest_base.join(relative_path);
            fs::create_dir_all(&dest_subdir)?;

            backup_directory_recursive(&path, dest_base, src_base, asset_type, config, result)?;
        } else if metadata.is_file() {
            // 处理文件
            if let Err(skip_reason) = should_backup_file(&path, &metadata, config) {
                result.skipped_files += 1;
                *result.skip_reasons.entry(skip_reason).or_insert(0) += 1;
                continue;
            }

            // 检查总大小限制
            let file_size = metadata.len();
            if result.total_size + file_size > config.max_total_size {
                warn!(
                    "达到总大小限制，停止备份: current={}, limit={}",
                    result.total_size, config.max_total_size
                );
                return Err(AssetBackupError::TotalSizeLimitExceeded {
                    current: result.total_size + file_size,
                    limit: config.max_total_size,
                });
            }

            // 计算相对路径
            let relative_path = path.strip_prefix(src_base).unwrap_or(&path);
            let dest_path = dest_base.join(relative_path);

            // 确保目标目录存在
            if let Some(parent) = dest_path.parent() {
                fs::create_dir_all(parent)?;
            }

            // 复制文件
            fs::copy(&path, &dest_path).map_err(|e| AssetBackupError::CopyFailed {
                src_path: path.to_string_lossy().to_string(),
                dest_path: dest_path.to_string_lossy().to_string(),
                message: e.to_string(),
            })?;

            // 计算校验和（如果需要）
            let checksum = if config.compute_checksum {
                match calculate_file_checksum(&dest_path) {
                    Ok(hash) => Some(hash),
                    Err(e) => {
                        warn!("计算校验和失败 {:?}: {}", dest_path, e);
                        None
                    }
                }
            } else {
                None
            };

            // 获取修改时间
            let modified_at = get_file_modified_time(&path);

            // 记录备份的文件
            let relative_str = relative_path.to_string_lossy().replace('\\', "/");
            let original_path = format!(
                "{}/{}",
                asset_type.relative_path(),
                relative_str
            );
            let backup_relative_path = format!(
                "assets/{}/{}",
                asset_type.relative_path(),
                relative_str
            );

            result.files.push(BackedUpAsset {
                asset_type,
                relative_path: backup_relative_path,
                original_path,
                size: file_size,
                checksum,
                modified_at,
                is_directory: false,
            });

            result.total_size += file_size;

            // 更新资产类型统计
            let stats = result
                .by_asset_type
                .entry(asset_type.as_str().to_string())
                .or_default();
            stats.file_count += 1;
            stats.total_size += file_size;
        }
    }

    Ok(())
}

/// 检查文件是否应该备份
///
/// 返回 Ok(()) 表示应该备份，Err(reason) 表示应该跳过
fn should_backup_file(
    path: &Path,
    metadata: &fs::Metadata,
    config: &AssetBackupConfig,
) -> Result<(), String> {
    // 检查文件大小
    if metadata.len() > config.max_file_size {
        return Err("file_too_large".to_string());
    }

    // 检查敏感文件
    if config.skip_sensitive_files && is_sensitive_file(path) {
        return Err("sensitive_file".to_string());
    }

    // 检查文件扩展名
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    // 如果设置了允许的扩展名列表，检查是否在列表中
    if !config.allowed_extensions.is_empty() {
        let allowed = config
            .allowed_extensions
            .iter()
            .any(|e| e.to_lowercase() == extension);
        if !allowed {
            return Err("extension_not_allowed".to_string());
        }
    }

    // 检查是否在排除列表中
    if config
        .excluded_extensions
        .iter()
        .any(|e| e.to_lowercase() == extension)
    {
        return Err("extension_excluded".to_string());
    }

    Ok(())
}

/// 恢复资产文件
///
/// ## 参数
///
/// - `backup_dir`: 备份目录
/// - `app_data_dir`: 应用数据目录
/// - `assets`: 要恢复的资产列表
///
/// ## 返回
///
/// 恢复的文件数量
pub fn restore_assets(
    backup_dir: &Path,
    app_data_dir: &Path,
    assets: &[BackedUpAsset],
) -> Result<usize, AssetBackupError> {
    info!(
        "开始恢复资产: backup_dir={:?}, app_data_dir={:?}, count={}",
        backup_dir,
        app_data_dir,
        assets.len()
    );

    let mut restored_count = 0;

    for asset in assets {
        if asset.is_directory {
            continue;
        }

        // 防御 Zip Slip 和跨平台路径问题
        let src_path = safe_join_under_root(backup_dir, &asset.relative_path)?;
        let dest_path = safe_join_under_root(app_data_dir, &asset.original_path)?;

        // 安全校验完成后再创建目录，避免越权目录被提前创建
        if let Some(parent) = dest_path.parent() {
            fs::create_dir_all(parent)?;
        }

        // 复制文件（失败即终止，避免“恢复成功但资源缺失”）
        copy_file_with_retry(&src_path, &dest_path)?;
        restored_count += 1;
        debug!("恢复文件: {:?} -> {:?}", src_path, dest_path);
    }

    info!("资产恢复完成: restored={}", restored_count);

    Ok(restored_count)
}

/// 从备份的 assets/ 目录直接恢复资产文件（不依赖 manifest.assets 列表）
///
/// 当 manifest.assets 为 None 但备份目录中存在 assets/ 子目录时使用此方法。
/// 按照资产类型子目录（textbooks/, vfs_blobs/, images/ 等）递归复制所有文件。
pub fn restore_assets_from_dir(
    assets_dir: &Path,
    app_data_dir: &Path,
) -> Result<usize, AssetBackupError> {
    info!(
        "开始从目录直接恢复资产: assets_dir={:?}, app_data_dir={:?}",
        assets_dir, app_data_dir
    );

    let mut restored_count = 0;

    // 遍历 assets/ 下的每个资产类型子目录（如 textbooks/, vfs_blobs/ 等）
    for entry in fs::read_dir(assets_dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let asset_type_name = match path.file_name() {
            Some(name) => name.to_string_lossy().to_string(),
            None => continue,
        };

        // 递归复制该资产类型目录下的所有文件
        let dest_base = app_data_dir.join(&asset_type_name);
        let count = copy_dir_recursive(&path, &dest_base)?;
        info!("资产类型 {} 恢复: {} 个文件", asset_type_name, count);
        restored_count += count;
    }

    info!("资产目录直接恢复完成: restored={}", restored_count);
    Ok(restored_count)
}

/// 递归复制目录
fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<usize, AssetBackupError> {
    let mut count = 0;
    fs::create_dir_all(dest)?;

    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let file_name = match src_path.file_name() {
            Some(name) => name.to_owned(),
            None => continue,
        };
        let dest_path = dest.join(&file_name);

        if src_path.is_dir() {
            count += copy_dir_recursive(&src_path, &dest_path)?;
        } else {
            if let Some(parent) = dest_path.parent() {
                fs::create_dir_all(parent)?;
            }
            copy_file_with_retry(&src_path, &dest_path)?;
            count += 1;
        }
    }

    Ok(count)
}

/// 带进度回调的资产恢复（基于 manifest.assets 列表）
///
/// `on_progress` 回调参数: (已恢复数, 总数)
pub fn restore_assets_with_progress<F>(
    backup_dir: &Path,
    app_data_dir: &Path,
    assets: &[BackedUpAsset],
    on_progress: F,
) -> Result<usize, AssetBackupError>
where
    F: Fn(usize, usize) -> bool,
{
    info!(
        "开始恢复资产(带进度): backup_dir={:?}, app_data_dir={:?}, count={}",
        backup_dir,
        app_data_dir,
        assets.len()
    );

    let total = assets.iter().filter(|a| !a.is_directory).count();
    let mut restored_count = 0;

    for asset in assets {
        if asset.is_directory {
            continue;
        }

        // 防御 Zip Slip 和跨平台路径问题
        let src_path = match safe_join_under_root(backup_dir, &asset.relative_path) {
            Ok(p) => p,
            Err(_) => return Err(AssetBackupError::InvalidConfig("资产源路径非法".to_string())),
        };
        let dest_path = match safe_join_under_root(app_data_dir, &asset.original_path) {
            Ok(p) => p,
            Err(_) => return Err(AssetBackupError::InvalidConfig("资产目标路径非法".to_string())),
        };

        if let Some(parent) = dest_path.parent() {
            fs::create_dir_all(parent)?;
        }

        copy_file_with_retry(&src_path, &dest_path)?;
        restored_count += 1;
        if !on_progress(restored_count, total) {
            return Err(AssetBackupError::Cancelled);
        }
    }

    info!("资产恢复完成(带进度): restored={}", restored_count);
    Ok(restored_count)
}

/// 带进度回调的目录直接资产恢复
///
/// `on_progress` 回调参数: (已恢复数, 总数)
pub fn restore_assets_from_dir_with_progress<F>(
    assets_dir: &Path,
    app_data_dir: &Path,
    on_progress: F,
) -> Result<usize, AssetBackupError>
where
    F: Fn(usize, usize) -> bool,
{
    info!(
        "开始从目录直接恢复资产(带进度): assets_dir={:?}, app_data_dir={:?}",
        assets_dir, app_data_dir
    );

    // 先统计总文件数
    let total = count_files_recursive(assets_dir);

    let mut restored_count = 0;

    for entry in fs::read_dir(assets_dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let asset_type_name = match path.file_name() {
            Some(name) => name.to_string_lossy().to_string(),
            None => continue,
        };

        let dest_base = app_data_dir.join(&asset_type_name);
        let count = copy_dir_recursive_with_progress(
            &path,
            &dest_base,
            &mut restored_count,
            total,
            &on_progress,
        )?;
        info!("资产类型 {} 恢复: {} 个文件", asset_type_name, count);
    }

    info!("资产目录直接恢复完成(带进度): restored={}", restored_count);
    Ok(restored_count)
}

/// 递归统计目录中的文件数量
pub fn count_files_recursive(dir: &Path) -> usize {
    let mut count = 0;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                count += count_files_recursive(&path);
            } else if path.is_file() {
                count += 1;
            }
        }
    }
    count
}

/// 递归复制目录（带进度回调）
fn copy_dir_recursive_with_progress<F>(
    src: &Path,
    dest: &Path,
    restored_count: &mut usize,
    total: usize,
    on_progress: &F,
) -> Result<usize, AssetBackupError>
where
    F: Fn(usize, usize) -> bool,
{
    let mut count = 0;
    fs::create_dir_all(dest)?;

    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let file_name = match src_path.file_name() {
            Some(name) => name.to_owned(),
            None => continue,
        };
        let dest_path = dest.join(&file_name);

        if src_path.is_dir() {
            count += copy_dir_recursive_with_progress(
                &src_path,
                &dest_path,
                restored_count,
                total,
                on_progress,
            )?;
        } else {
            if let Some(parent) = dest_path.parent() {
                fs::create_dir_all(parent)?;
            }
            copy_file_with_retry(&src_path, &dest_path)?;
            count += 1;
            *restored_count += 1;
            if !on_progress(*restored_count, total) {
                return Err(AssetBackupError::Cancelled);
            }
        }
    }

    Ok(count)
}

/// 验证备份的资产文件
///
/// ## 参数
///
/// - `backup_dir`: 备份目录
/// - `assets`: 要验证的资产列表
///
/// ## 返回
///
/// 验证失败的文件列表
pub fn verify_assets(
    backup_dir: &Path,
    assets: &[BackedUpAsset],
) -> Result<Vec<AssetVerifyError>, AssetBackupError> {
    info!(
        "开始验证资产: backup_dir={:?}, count={}",
        backup_dir,
        assets.len()
    );

    let mut errors = Vec::new();

    for asset in assets {
        if asset.is_directory {
            continue;
        }

        let file_path = backup_dir.join(&asset.relative_path);

        // 检查文件存在
        if !file_path.exists() {
            errors.push(AssetVerifyError {
                path: asset.relative_path.clone(),
                error_type: "file_not_found".to_string(),
                message: format!("文件不存在: {:?}", file_path),
            });
            continue;
        }

        // 检查文件大小
        let metadata = fs::metadata(&file_path)?;
        if metadata.len() != asset.size {
            errors.push(AssetVerifyError {
                path: asset.relative_path.clone(),
                error_type: "size_mismatch".to_string(),
                message: format!(
                    "文件大小不匹配: expected={}, actual={}",
                    asset.size,
                    metadata.len()
                ),
            });
            continue;
        }

        // 检查校验和（如果有）
        if let Some(expected_checksum) = &asset.checksum {
            match calculate_file_checksum(&file_path) {
                Ok(actual_checksum) => {
                    if &actual_checksum != expected_checksum {
                        errors.push(AssetVerifyError {
                            path: asset.relative_path.clone(),
                            error_type: "checksum_mismatch".to_string(),
                            message: format!(
                                "校验和不匹配: expected={}, actual={}",
                                expected_checksum, actual_checksum
                            ),
                        });
                    }
                }
                Err(e) => {
                    errors.push(AssetVerifyError {
                        path: asset.relative_path.clone(),
                        error_type: "checksum_error".to_string(),
                        message: format!("计算校验和失败: {}", e),
                    });
                }
            }
        }
    }

    info!(
        "资产验证完成: total={}, errors={}",
        assets.len(),
        errors.len()
    );

    Ok(errors)
}

/// 资产验证错误
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetVerifyError {
    /// 文件路径
    pub path: String,
    /// 错误类型
    pub error_type: String,
    /// 错误信息
    pub message: String,
}

/// 扫描资产目录，获取资产统计信息
///
/// ## 参数
///
/// - `app_data_dir`: 应用数据目录
/// - `asset_types`: 要扫描的资产类型（空表示全部）
///
/// ## 返回
///
/// 各资产类型的统计信息
pub fn scan_assets(
    app_data_dir: &Path,
    asset_types: &[AssetType],
) -> Result<HashMap<String, AssetTypeStats>, AssetBackupError> {
    let types = if asset_types.is_empty() {
        AssetType::all()
    } else {
        asset_types.to_vec()
    };

    let mut stats = HashMap::new();

    for asset_type in types {
        let dir_path = app_data_dir.join(asset_type.relative_path());
        if !dir_path.exists() {
            continue;
        }

        let type_stats = scan_directory_stats(&dir_path)?;
        stats.insert(asset_type.as_str().to_string(), type_stats);
    }

    Ok(stats)
}

/// 扫描目录统计信息
fn scan_directory_stats(dir: &Path) -> Result<AssetTypeStats, AssetBackupError> {
    let mut stats = AssetTypeStats::default();

    fn scan_recursive(dir: &Path, stats: &mut AssetTypeStats) -> std::io::Result<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            let metadata = entry.metadata()?;

            if metadata.is_dir() {
                scan_recursive(&path, stats)?;
            } else if metadata.is_file() {
                stats.file_count += 1;
                stats.total_size += metadata.len();
            }
        }
        Ok(())
    }

    scan_recursive(dir, &mut stats)?;

    Ok(stats)
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_test_file(dir: &Path, name: &str, content: &[u8]) {
        let path = dir.join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut file = File::create(path).unwrap();
        file.write_all(content).unwrap();
    }

    #[test]
    fn test_asset_type_properties() {
        assert_eq!(AssetType::Images.relative_path(), "images");
        assert_eq!(AssetType::Images.priority(), 0);
        assert_eq!(AssetType::Videos.priority(), 1);

        let all = AssetType::all();
        assert_eq!(all.len(), 9);

        let p0 = AssetType::p0_assets();
        assert_eq!(p0.len(), 7);

        let p1 = AssetType::p1_assets();
        assert_eq!(p1.len(), 2);
    }

    #[test]
    fn test_is_sensitive_file() {
        assert!(is_sensitive_file(Path::new("/path/to/.env")));
        assert!(is_sensitive_file(Path::new("/path/to/credentials.json")));
        assert!(is_sensitive_file(Path::new("/path/to/private.key")));
        assert!(is_sensitive_file(Path::new("/path/to/password.txt")));

        assert!(!is_sensitive_file(Path::new("/path/to/image.png")));
        assert!(!is_sensitive_file(Path::new("/path/to/document.pdf")));
    }

    #[test]
    fn test_backup_config_defaults() {
        let config = AssetBackupConfig::default();
        assert_eq!(config.asset_types.len(), 9);
        assert!(config.compute_checksum);
        assert!(config.skip_symlinks);
        assert!(config.skip_sensitive_files);
    }

    #[test]
    fn test_backup_and_restore_assets() {
        let app_data_dir = TempDir::new().unwrap();
        let backup_dir = TempDir::new().unwrap();

        // 创建测试文件
        let images_dir = app_data_dir.path().join("images");
        fs::create_dir_all(&images_dir).unwrap();
        create_test_file(&images_dir, "test.png", b"fake png data");
        create_test_file(&images_dir, "subdir/nested.jpg", b"fake jpg data");

        // 执行备份
        let config = AssetBackupConfig {
            asset_types: vec![AssetType::Images],
            ..Default::default()
        };

        let result = backup_assets(app_data_dir.path(), backup_dir.path(), &config).unwrap();

        assert_eq!(result.total_files, 2);
        assert!(result.total_size > 0);
        assert_eq!(result.skipped_files, 0);

        // 验证备份
        let verify_errors = verify_assets(backup_dir.path(), &result.files).unwrap();
        assert!(verify_errors.is_empty());

        // 删除原文件
        fs::remove_dir_all(&images_dir).unwrap();

        // 恢复
        let restored =
            restore_assets(backup_dir.path(), app_data_dir.path(), &result.files).unwrap();
        assert_eq!(restored, 2);

        // 验证恢复后的文件
        assert!(images_dir.join("test.png").exists());
        assert!(images_dir.join("subdir/nested.jpg").exists());
    }

    #[test]
    fn test_skip_sensitive_files() {
        let app_data_dir = TempDir::new().unwrap();
        let backup_dir = TempDir::new().unwrap();

        // 创建测试文件（包括敏感文件）
        let docs_dir = app_data_dir.path().join("documents");
        fs::create_dir_all(&docs_dir).unwrap();
        create_test_file(&docs_dir, "normal.txt", b"normal content");
        create_test_file(&docs_dir, ".env", b"secret content");
        create_test_file(&docs_dir, "credentials.json", b"secret credentials");

        let config = AssetBackupConfig {
            asset_types: vec![AssetType::Documents],
            skip_sensitive_files: true,
            ..Default::default()
        };

        let result = backup_assets(app_data_dir.path(), backup_dir.path(), &config).unwrap();

        assert_eq!(result.total_files, 1);
        assert_eq!(result.skipped_files, 2);
        assert!(result.skip_reasons.contains_key("sensitive_file"));
    }

    #[test]
    fn test_file_size_limit() {
        let app_data_dir = TempDir::new().unwrap();
        let backup_dir = TempDir::new().unwrap();

        // 创建测试文件
        let images_dir = app_data_dir.path().join("images");
        fs::create_dir_all(&images_dir).unwrap();
        create_test_file(&images_dir, "small.png", &[0u8; 100]);
        create_test_file(&images_dir, "large.png", &[0u8; 1000]);

        let config = AssetBackupConfig {
            asset_types: vec![AssetType::Images],
            max_file_size: 500, // 500 字节限制
            ..Default::default()
        };

        let result = backup_assets(app_data_dir.path(), backup_dir.path(), &config).unwrap();

        assert_eq!(result.total_files, 1);
        assert_eq!(result.skipped_files, 1);
        assert!(result.skip_reasons.contains_key("file_too_large"));
    }

    #[test]
    fn test_scan_assets() {
        let app_data_dir = TempDir::new().unwrap();

        // 创建测试文件
        let images_dir = app_data_dir.path().join("images");
        fs::create_dir_all(&images_dir).unwrap();
        create_test_file(&images_dir, "a.png", &[0u8; 100]);
        create_test_file(&images_dir, "b.png", &[0u8; 200]);

        let stats = scan_assets(app_data_dir.path(), &[AssetType::Images]).unwrap();

        let images_stats = stats.get("images").unwrap();
        assert_eq!(images_stats.file_count, 2);
        assert_eq!(images_stats.total_size, 300);
    }

    #[test]
    fn test_restore_assets_with_progress_can_cancel() {
        let backup_dir = TempDir::new().unwrap();
        let app_data_dir = TempDir::new().unwrap();

        create_test_file(
            backup_dir.path(),
            "assets/images/test.png",
            b"fake png data",
        );

        let assets = vec![BackedUpAsset {
            asset_type: AssetType::Images,
            relative_path: "assets/images/test.png".to_string(),
            original_path: "images/test.png".to_string(),
            size: 13,
            checksum: None,
            modified_at: None,
            is_directory: false,
        }];

        let result = restore_assets_with_progress(
            backup_dir.path(),
            app_data_dir.path(),
            &assets,
            |_restored, _total| false,
        );

        assert!(matches!(result, Err(AssetBackupError::Cancelled)));
    }

    #[test]
    fn test_restore_assets_from_dir_with_progress_can_cancel() {
        let backup_dir = TempDir::new().unwrap();
        let app_data_dir = TempDir::new().unwrap();

        create_test_file(backup_dir.path(), "assets/images/test.png", b"fake png data");

        let result = restore_assets_from_dir_with_progress(
            &backup_dir.path().join("assets"),
            app_data_dir.path(),
            |_restored, _total| false,
        );

        assert!(matches!(result, Err(AssetBackupError::Cancelled)));
    }
}
