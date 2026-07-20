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
//! - P0（高优先级）：images, notes_assets, documents, vfs_blobs, subjects, workspaces, textbooks, pdf_ocr_sessions
//! - P1（低优先级）：audio, videos

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Component;
use std::path::Path;
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
    /// PDF/OCR 原始文件与处理中间资产
    PdfOcrSessions,
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
                last_error = Some(format!("复制资产失败: {:?} -> {:?}: {}", src, dest, e));
            }
        }

        // 清理可能写入了一半的目标文件，避免下次重试命中脏文件
        let _ = fs::remove_file(dest);

        if attempt + 1 < MAX_RETRIES {
            std::thread::sleep(Duration::from_millis(RETRY_SLEEP_MS));
        }
    }

    Err(AssetBackupError::RestoreFailed(
        last_error.unwrap_or_else(|| "复制资产失败（未知错误）".to_string()),
    ))
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
            AssetType::PdfOcrSessions => "pdf_ocr_sessions",
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
            AssetType::PdfOcrSessions => "PDF/OCR 会话文件",
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
            | AssetType::Textbooks
            | AssetType::PdfOcrSessions => 0,
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
            AssetType::PdfOcrSessions,
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
            AssetType::PdfOcrSessions,
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
            "pdf_ocr_sessions" => Some(AssetType::PdfOcrSessions),
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

fn safe_join_under_root(
    root: &Path,
    unsafe_relative_path: &str,
) -> Result<std::path::PathBuf, AssetBackupError> {
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

fn safe_existing_file_under_root(
    root: &Path,
    unsafe_relative_path: &str,
) -> Result<std::path::PathBuf, AssetBackupError> {
    let joined = safe_join_under_root(root, unsafe_relative_path)?;
    let root_metadata = fs::symlink_metadata(root)?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err(AssetBackupError::InvalidConfig(format!(
            "资产根路径必须是普通目录: {}",
            root.display()
        )));
    }

    let normalized = AssetType::sanitize_relative_path(unsafe_relative_path)?;
    let relative = Path::new(&normalized);
    let component_count = relative.components().count();
    let mut current = root.to_path_buf();
    for (index, component) in relative.components().enumerate() {
        let Component::Normal(component) = component else {
            return Err(AssetBackupError::InvalidConfig(format!(
                "不安全的资产路径: {}",
                unsafe_relative_path
            )));
        };
        current.push(component);
        let metadata = fs::symlink_metadata(&current)?;
        if metadata.file_type().is_symlink() {
            return Err(AssetBackupError::InvalidConfig(format!(
                "资产路径不允许包含符号链接: {}",
                unsafe_relative_path
            )));
        }
        let is_last = index + 1 == component_count;
        if (!is_last && !metadata.is_dir()) || (is_last && !metadata.is_file()) {
            return Err(AssetBackupError::InvalidConfig(format!(
                "资产路径不是普通文件: {}",
                unsafe_relative_path
            )));
        }
    }
    debug_assert_eq!(joined, current);
    Ok(current)
}

fn prepare_asset_destination_under_root(
    root: &Path,
    unsafe_relative_path: &str,
) -> Result<std::path::PathBuf, AssetBackupError> {
    fs::create_dir_all(root)?;
    let root_metadata = fs::symlink_metadata(root)?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err(AssetBackupError::InvalidConfig(format!(
            "资产恢复根路径必须是普通目录: {}",
            root.display()
        )));
    }

    let normalized = AssetType::sanitize_relative_path(unsafe_relative_path)?;
    let relative = Path::new(&normalized);
    let component_count = relative.components().count();
    let mut current = root.to_path_buf();
    for (index, component) in relative.components().enumerate() {
        let Component::Normal(component) = component else {
            return Err(AssetBackupError::InvalidConfig(format!(
                "不安全的资产目标路径: {}",
                unsafe_relative_path
            )));
        };
        current.push(component);
        let is_last = index + 1 == component_count;
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(AssetBackupError::InvalidConfig(format!(
                    "资产恢复目标不允许包含符号链接: {}",
                    unsafe_relative_path
                )))
            }
            Ok(metadata) if !is_last && !metadata.is_dir() => {
                return Err(AssetBackupError::InvalidConfig(format!(
                    "资产恢复目标父路径不是目录: {}",
                    current.display()
                )))
            }
            Ok(metadata) if is_last && !metadata.is_file() => {
                return Err(AssetBackupError::InvalidConfig(format!(
                    "资产恢复目标不是普通文件: {}",
                    current.display()
                )))
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && !is_last => {
                fs::create_dir(&current)?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && is_last => {}
            Err(e) => return Err(AssetBackupError::Io(e)),
        }
    }
    Ok(current)
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
    /// 因策略过滤或非常规条目而未能完整覆盖的资产域。
    ///
    /// `skipped_files` 是全局计数，不能作为每个持久域的 coverage 证据；
    /// 此字段让 manifest v3 只把真正受影响的资产域标为 failed。
    #[serde(default)]
    pub incomplete_asset_types: Vec<AssetType>,
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

fn calculate_file_checksum_exact(
    path: &Path,
    expected_size: u64,
) -> Result<String, AssetBackupError> {
    let file = File::open(path)?;
    let mut reader = BufReader::new(file).take(expected_size.saturating_add(1));
    let mut hasher = Sha256::new();
    let mut total_read = 0u64;
    let mut buffer = [0u8; 8192];
    loop {
        let bytes_read = reader.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }
        total_read = total_read.saturating_add(bytes_read as u64);
        if total_read > expected_size {
            return Err(AssetBackupError::ChecksumError(
                "资产文件在校验期间增长".to_string(),
            ));
        }
        hasher.update(&buffer[..bytes_read]);
    }
    if total_read != expected_size {
        return Err(AssetBackupError::ChecksumError(format!(
            "资产文件在校验期间大小变化: expected={}, actual={}",
            expected_size, total_read
        )));
    }
    Ok(hex::encode(hasher.finalize()))
}

/// 获取文件修改时间。元数据读取失败必须向上传播，完整备份不能静默丢文件。
fn get_file_modified_time(metadata: &fs::Metadata) -> Result<Option<String>, AssetBackupError> {
    match metadata.modified() {
        Ok(time) => Ok(Some(
            chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339(),
        )),
        Err(error) if error.kind() == std::io::ErrorKind::Unsupported => Ok(None),
        Err(error) => Err(AssetBackupError::Io(error)),
    }
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

    // 创建并验证目标目录。`exists()` 会吞掉权限错误，也会允许跟随目录符号链接。
    match fs::symlink_metadata(dest_dir) {
        Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_dir() => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(dest_dir).map_err(|e| {
                AssetBackupError::DestinationCreationFailed(format!("{:?}: {}", dest_dir, e))
            })?;
        }
        Ok(_) => {
            return Err(AssetBackupError::DestinationCreationFailed(format!(
                "{:?}: 目标必须是普通目录",
                dest_dir
            )))
        }
        Err(error) => return Err(AssetBackupError::Io(error)),
    }

    let mut result = AssetBackupResult {
        files: Vec::new(),
        total_files: 0,
        total_size: 0,
        skipped_files: 0,
        skip_reasons: HashMap::new(),
        incomplete_asset_types: Vec::new(),
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

        // 不使用 `exists()`：它会把权限/IO 错误折叠成 false，导致完整备份
        // 静默漏掉整个资产域。
        match fs::symlink_metadata(&src_path) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => {
                return Err(AssetBackupError::InvalidConfig(format!(
                    "资产根不是普通目录: {}",
                    src_path.display()
                )))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                debug!("资产目录不存在，跳过: {:?} ({:?})", asset_type, src_path);
                continue;
            }
            Err(error) => return Err(AssetBackupError::Io(error)),
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
    let entries = fs::read_dir(current_dir).map_err(|error| {
        AssetBackupError::Io(std::io::Error::new(
            error.kind(),
            format!("无法读取资产目录 {}: {}", current_dir.display(), error),
        ))
    })?;

    for entry in entries {
        let entry = entry.map_err(|error| {
            AssetBackupError::Io(std::io::Error::new(
                error.kind(),
                format!("读取资产目录项失败 {}: {}", current_dir.display(), error),
            ))
        })?;

        let path = entry.path();
        let link_metadata = fs::symlink_metadata(&path).map_err(|error| {
            AssetBackupError::Io(std::io::Error::new(
                error.kind(),
                format!("读取资产条目元数据失败 {}: {}", path.display(), error),
            ))
        })?;

        // 检查是否为符号链接。检查本身失败不得当作“不是链接”继续。
        if link_metadata.file_type().is_symlink() {
            if config.skip_symlinks {
                debug!("跳过符号链接: {:?}", path);
                result.skipped_files += 1;
                if !result.incomplete_asset_types.contains(&asset_type) {
                    result.incomplete_asset_types.push(asset_type);
                }
                *result
                    .skip_reasons
                    .entry("symlink".to_string())
                    .or_insert(0) += 1;
                continue;
            }
            return Err(AssetBackupError::InvalidConfig(format!(
                "资产备份不允许跟随符号链接: {}",
                path.display()
            )));
        }

        let metadata = entry.metadata().map_err(|error| {
            AssetBackupError::Io(std::io::Error::new(
                error.kind(),
                format!("读取资产文件元数据失败 {}: {}", path.display(), error),
            ))
        })?;

        if metadata.is_dir() {
            // 递归处理子目录
            let relative_path = path.strip_prefix(src_base).map_err(|_| {
                AssetBackupError::InvalidConfig(format!(
                    "资产目录越出声明根路径: {}",
                    path.display()
                ))
            })?;
            let dest_subdir = dest_base.join(relative_path);
            fs::create_dir_all(&dest_subdir)?;

            backup_directory_recursive(&path, dest_base, src_base, asset_type, config, result)?;
        } else if metadata.is_file() {
            // 工作区 SQLite 数据库由 SQLite Backup API 单独生成一致性快照；
            // 这里不能再原始复制 db/WAL/SHM。
            if asset_type == AssetType::Workspaces {
                let name = path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("");
                if name.ends_with(".db") || name.ends_with("-wal") || name.ends_with("-shm") {
                    continue;
                }
            }

            // 处理文件
            if let Err(skip_reason) = should_backup_file(&path, &metadata, config) {
                result.skipped_files += 1;
                if !result.incomplete_asset_types.contains(&asset_type) {
                    result.incomplete_asset_types.push(asset_type);
                }
                *result.skip_reasons.entry(skip_reason).or_insert(0) += 1;
                continue;
            }

            // 检查总大小限制
            let file_size = metadata.len();
            let next_total_size = result.total_size.checked_add(file_size).ok_or_else(|| {
                AssetBackupError::InvalidConfig("资产备份总大小计数溢出".to_string())
            })?;
            if next_total_size > config.max_total_size {
                warn!(
                    "达到总大小限制，停止备份: current={}, limit={}",
                    result.total_size, config.max_total_size
                );
                return Err(AssetBackupError::TotalSizeLimitExceeded {
                    current: next_total_size,
                    limit: config.max_total_size,
                });
            }

            // 计算相对路径
            let relative_path = path.strip_prefix(src_base).map_err(|_| {
                AssetBackupError::InvalidConfig(format!(
                    "资产文件越出声明根路径: {}",
                    path.display()
                ))
            })?;
            let dest_path = dest_base.join(relative_path);

            // 确保目标目录存在
            if let Some(parent) = dest_path.parent() {
                fs::create_dir_all(parent)?;
            }

            // 复制文件
            let copied = fs::copy(&path, &dest_path).map_err(|e| AssetBackupError::CopyFailed {
                src_path: path.to_string_lossy().to_string(),
                dest_path: dest_path.to_string_lossy().to_string(),
                message: e.to_string(),
            })?;
            if copied != file_size {
                return Err(AssetBackupError::CopyFailed {
                    src_path: path.to_string_lossy().to_string(),
                    dest_path: dest_path.to_string_lossy().to_string(),
                    message: format!(
                        "复制字节数不匹配: expected={}, actual={}",
                        file_size, copied
                    ),
                });
            }
            let copied_size = fs::metadata(&dest_path)?.len();
            if copied_size != file_size {
                return Err(AssetBackupError::CopyFailed {
                    src_path: path.to_string_lossy().to_string(),
                    dest_path: dest_path.to_string_lossy().to_string(),
                    message: format!(
                        "目标文件大小不匹配: expected={}, actual={}",
                        file_size, copied_size
                    ),
                });
            }

            // 计算校验和（如果需要）
            let checksum = if config.compute_checksum {
                let destination_checksum = calculate_file_checksum_exact(&dest_path, file_size)?;
                let source_checksum = calculate_file_checksum_exact(&path, file_size)?;
                if source_checksum != destination_checksum {
                    return Err(AssetBackupError::ChecksumError(format!(
                        "资产复制前后内容不一致: {}",
                        path.display()
                    )));
                }
                Some(destination_checksum)
            } else {
                None
            };

            // 获取修改时间
            let modified_at = get_file_modified_time(&metadata)?;

            // 记录备份的文件
            let relative_str = relative_path.to_string_lossy().replace('\\', "/");
            let original_path = format!("{}/{}", asset_type.relative_path(), relative_str);
            let backup_relative_path =
                format!("assets/{}/{}", asset_type.relative_path(), relative_str);

            result.files.push(BackedUpAsset {
                asset_type,
                relative_path: backup_relative_path,
                original_path,
                size: file_size,
                checksum,
                modified_at,
                is_directory: false,
            });

            result.total_size = next_total_size;

            // 更新资产类型统计
            let stats = result
                .by_asset_type
                .entry(asset_type.as_str().to_string())
                .or_default();
            stats.file_count = stats
                .file_count
                .checked_add(1)
                .ok_or_else(|| AssetBackupError::InvalidConfig("资产文件计数溢出".to_string()))?;
            stats.total_size = stats.total_size.checked_add(file_size).ok_or_else(|| {
                AssetBackupError::InvalidConfig("资产类型大小计数溢出".to_string())
            })?;
        } else {
            return Err(AssetBackupError::InvalidConfig(format!(
                "资产条目不是普通文件或目录: {}",
                path.display()
            )));
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
        let src_path = safe_existing_file_under_root(backup_dir, &asset.relative_path)?;
        let dest_path = prepare_asset_destination_under_root(app_data_dir, &asset.original_path)?;

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

    let root_metadata = fs::symlink_metadata(assets_dir)?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err(AssetBackupError::InvalidConfig(format!(
            "资产恢复根必须是普通目录: {}",
            assets_dir.display()
        )));
    }

    // 遍历 assets/ 下的每个资产类型子目录（如 textbooks/, vfs_blobs/ 等）
    for entry in fs::read_dir(assets_dir)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(AssetBackupError::InvalidConfig(format!(
                "资产恢复根包含非目录条目: {}",
                path.display()
            )));
        }

        let asset_type_name = path
            .file_name()
            .ok_or_else(|| {
                AssetBackupError::InvalidConfig(format!("资产恢复目录缺少名称: {}", path.display()))
            })?
            .to_string_lossy()
            .to_string();

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
    let mut count: usize = 0;
    fs::create_dir_all(dest)?;

    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let file_name = src_path
            .file_name()
            .ok_or_else(|| {
                AssetBackupError::InvalidConfig(format!(
                    "资产恢复条目缺少名称: {}",
                    src_path.display()
                ))
            })?
            .to_owned();
        let dest_path = dest.join(&file_name);
        let metadata = fs::symlink_metadata(&src_path)?;

        if metadata.file_type().is_symlink() {
            return Err(AssetBackupError::InvalidConfig(format!(
                "资产恢复源不允许符号链接: {}",
                src_path.display()
            )));
        } else if metadata.is_dir() {
            count += copy_dir_recursive(&src_path, &dest_path)?;
        } else if metadata.is_file() {
            if let Some(parent) = dest_path.parent() {
                fs::create_dir_all(parent)?;
            }
            copy_file_with_retry(&src_path, &dest_path)?;
            count += 1;
        } else {
            return Err(AssetBackupError::InvalidConfig(format!(
                "资产恢复源包含非常规条目: {}",
                src_path.display()
            )));
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
        let src_path = match safe_existing_file_under_root(backup_dir, &asset.relative_path) {
            Ok(p) => p,
            Err(_) => {
                return Err(AssetBackupError::InvalidConfig(
                    "资产源路径非法".to_string(),
                ))
            }
        };
        let dest_path =
            match prepare_asset_destination_under_root(app_data_dir, &asset.original_path) {
                Ok(p) => p,
                Err(_) => {
                    return Err(AssetBackupError::InvalidConfig(
                        "资产目标路径非法".to_string(),
                    ))
                }
            };

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

    let root_metadata = fs::symlink_metadata(assets_dir)?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err(AssetBackupError::InvalidConfig(format!(
            "资产恢复根必须是普通目录: {}",
            assets_dir.display()
        )));
    }

    // 先统计总文件数；扫描错误必须阻止恢复，不能用错误的进度掩盖漏文件。
    let total = count_files_recursive(assets_dir)?;

    let mut restored_count = 0;

    for entry in fs::read_dir(assets_dir)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(AssetBackupError::InvalidConfig(format!(
                "资产恢复根包含非目录条目: {}",
                path.display()
            )));
        }

        let asset_type_name = path
            .file_name()
            .ok_or_else(|| {
                AssetBackupError::InvalidConfig(format!("资产恢复目录缺少名称: {}", path.display()))
            })?
            .to_string_lossy()
            .to_string();

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
pub fn count_files_recursive(dir: &Path) -> Result<usize, AssetBackupError> {
    let root_metadata = fs::symlink_metadata(dir)?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err(AssetBackupError::InvalidConfig(format!(
            "资产扫描根必须是普通目录: {}",
            dir.display()
        )));
    }
    let mut count: usize = 0;
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            return Err(AssetBackupError::InvalidConfig(format!(
                "资产扫描不允许符号链接: {}",
                path.display()
            )));
        } else if metadata.is_dir() {
            count = count
                .checked_add(count_files_recursive(&path)?)
                .ok_or_else(|| AssetBackupError::InvalidConfig("资产文件计数溢出".to_string()))?;
        } else if metadata.is_file() {
            count = count
                .checked_add(1)
                .ok_or_else(|| AssetBackupError::InvalidConfig("资产文件计数溢出".to_string()))?;
        } else {
            return Err(AssetBackupError::InvalidConfig(format!(
                "资产扫描包含非常规条目: {}",
                path.display()
            )));
        }
    }
    Ok(count)
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
        let file_name = src_path
            .file_name()
            .ok_or_else(|| {
                AssetBackupError::InvalidConfig(format!(
                    "资产恢复条目缺少名称: {}",
                    src_path.display()
                ))
            })?
            .to_owned();
        let dest_path = dest.join(&file_name);
        let metadata = fs::symlink_metadata(&src_path)?;

        if metadata.file_type().is_symlink() {
            return Err(AssetBackupError::InvalidConfig(format!(
                "资产恢复源不允许符号链接: {}",
                src_path.display()
            )));
        } else if metadata.is_dir() {
            count += copy_dir_recursive_with_progress(
                &src_path,
                &dest_path,
                restored_count,
                total,
                on_progress,
            )?;
        } else if metadata.is_file() {
            if let Some(parent) = dest_path.parent() {
                fs::create_dir_all(parent)?;
            }
            copy_file_with_retry(&src_path, &dest_path)?;
            count += 1;
            *restored_count += 1;
            if !on_progress(*restored_count, total) {
                return Err(AssetBackupError::Cancelled);
            }
        } else {
            return Err(AssetBackupError::InvalidConfig(format!(
                "资产恢复源包含非常规条目: {}",
                src_path.display()
            )));
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

        let file_path = match safe_existing_file_under_root(backup_dir, &asset.relative_path) {
            Ok(path) => path,
            Err(e) => {
                errors.push(AssetVerifyError {
                    path: asset.relative_path.clone(),
                    error_type: "unsafe_path".to_string(),
                    message: e.to_string(),
                });
                continue;
            }
        };

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
            match calculate_file_checksum_exact(&file_path, asset.size) {
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
        match fs::symlink_metadata(&dir_path) {
            Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_dir() => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Ok(_) => {
                return Err(AssetBackupError::InvalidConfig(format!(
                    "资产扫描根不是普通目录: {}",
                    dir_path.display()
                )))
            }
            Err(error) => return Err(AssetBackupError::Io(error)),
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
            let metadata = fs::symlink_metadata(&path)?;

            if metadata.file_type().is_symlink() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("资产扫描不允许符号链接: {}", path.display()),
                ));
            } else if metadata.is_dir() {
                scan_recursive(&path, stats)?;
            } else if metadata.is_file() {
                stats.file_count += 1;
                stats.total_size += metadata.len();
            } else {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("资产扫描包含非常规条目: {}", path.display()),
                ));
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
    use std::io::Write;
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
        assert_eq!(
            AssetType::PdfOcrSessions.relative_path(),
            "pdf_ocr_sessions"
        );
        assert_eq!(AssetType::PdfOcrSessions.priority(), 0);

        let all = AssetType::all();
        assert_eq!(all.len(), 10);

        let p0 = AssetType::p0_assets();
        assert_eq!(p0.len(), 8);

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
        assert_eq!(config.asset_types.len(), 10);
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
        let pdf_ocr_dir = app_data_dir.path().join("pdf_ocr_sessions");
        create_test_file(&pdf_ocr_dir, "session-1/original.pdf", b"fake pdf data");

        // 执行备份
        let config = AssetBackupConfig {
            asset_types: vec![AssetType::Images, AssetType::PdfOcrSessions],
            ..Default::default()
        };

        let result = backup_assets(app_data_dir.path(), backup_dir.path(), &config).unwrap();

        assert_eq!(result.total_files, 3);
        assert!(result.total_size > 0);
        assert_eq!(result.skipped_files, 0);

        // 验证备份
        let verify_errors = verify_assets(backup_dir.path(), &result.files).unwrap();
        assert!(verify_errors.is_empty());

        // 删除原文件
        fs::remove_dir_all(&images_dir).unwrap();
        fs::remove_dir_all(&pdf_ocr_dir).unwrap();

        // 恢复
        let restored =
            restore_assets(backup_dir.path(), app_data_dir.path(), &result.files).unwrap();
        assert_eq!(restored, 3);

        // 验证恢复后的文件
        assert!(images_dir.join("test.png").exists());
        assert!(images_dir.join("subdir/nested.jpg").exists());
        assert!(pdf_ocr_dir.join("session-1/original.pdf").exists());
    }

    #[test]
    fn test_verify_assets_rejects_relative_path_traversal() {
        let parent = TempDir::new().unwrap();
        let backup_dir = parent.path().join("backup");
        fs::create_dir_all(&backup_dir).unwrap();
        fs::write(parent.path().join("outside.bin"), b"outside").unwrap();
        let assets = vec![BackedUpAsset {
            asset_type: AssetType::Documents,
            relative_path: "../outside.bin".to_string(),
            original_path: "documents/outside.bin".to_string(),
            size: 7,
            checksum: None,
            modified_at: None,
            is_directory: false,
        }];

        let errors = verify_assets(&backup_dir, &assets).unwrap();

        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].error_type, "unsafe_path");
    }

    #[cfg(unix)]
    #[test]
    fn test_verify_assets_rejects_symlinked_source() {
        let backup_dir = TempDir::new().unwrap();
        let external = TempDir::new().unwrap();
        fs::create_dir_all(backup_dir.path().join("assets/documents")).unwrap();
        fs::write(external.path().join("outside.bin"), b"outside").unwrap();
        std::os::unix::fs::symlink(
            external.path().join("outside.bin"),
            backup_dir.path().join("assets/documents/link.bin"),
        )
        .unwrap();
        let assets = vec![BackedUpAsset {
            asset_type: AssetType::Documents,
            relative_path: "assets/documents/link.bin".to_string(),
            original_path: "documents/link.bin".to_string(),
            size: 7,
            checksum: None,
            modified_at: None,
            is_directory: false,
        }];

        let errors = verify_assets(backup_dir.path(), &assets).unwrap();

        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].error_type, "unsafe_path");
    }

    #[cfg(unix)]
    #[test]
    fn test_restore_assets_rejects_symlinked_destination_parent() {
        let backup_dir = TempDir::new().unwrap();
        let app_data_dir = TempDir::new().unwrap();
        let external = TempDir::new().unwrap();
        create_test_file(backup_dir.path(), "assets/documents/file.bin", b"payload");
        std::os::unix::fs::symlink(external.path(), app_data_dir.path().join("documents")).unwrap();
        let assets = vec![BackedUpAsset {
            asset_type: AssetType::Documents,
            relative_path: "assets/documents/file.bin".to_string(),
            original_path: "documents/file.bin".to_string(),
            size: 7,
            checksum: None,
            modified_at: None,
            is_directory: false,
        }];

        let result = restore_assets(backup_dir.path(), app_data_dir.path(), &assets);

        assert!(matches!(result, Err(AssetBackupError::InvalidConfig(_))));
        assert!(!external.path().join("file.bin").exists());
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
        assert_eq!(result.incomplete_asset_types, vec![AssetType::Documents]);
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
        assert_eq!(result.incomplete_asset_types, vec![AssetType::Images]);
    }

    #[cfg(unix)]
    #[test]
    fn test_unreadable_asset_metadata_aborts_backup() {
        let app_data_dir = TempDir::new().unwrap();
        let backup_dir = TempDir::new().unwrap();
        let documents = app_data_dir.path().join("documents");
        fs::create_dir_all(&documents).unwrap();
        // A self-referential link produces ELOOP when metadata follows it. This
        // is deterministic even when tests run as root, unlike chmod-based tests.
        std::os::unix::fs::symlink("loop", documents.join("loop")).unwrap();

        let result = backup_assets(
            app_data_dir.path(),
            backup_dir.path(),
            &AssetBackupConfig {
                asset_types: vec![AssetType::Documents],
                skip_symlinks: false,
                ..Default::default()
            },
        );

        assert!(matches!(
            result,
            Err(AssetBackupError::Io(_) | AssetBackupError::InvalidConfig(_))
        ));
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

        create_test_file(
            backup_dir.path(),
            "assets/images/test.png",
            b"fake png data",
        );

        let result = restore_assets_from_dir_with_progress(
            &backup_dir.path().join("assets"),
            app_data_dir.path(),
            |_restored, _total| false,
        );

        assert!(matches!(result, Err(AssetBackupError::Cancelled)));
    }
}
