//! ZIP 格式备份导出
//!
//! 将备份目录导出为 ZIP 压缩包，便于分享和存储。
//!
//! ## 功能
//!
//! - 支持可配置的压缩级别（0-9）
//! - 自动生成校验和文件
//! - 记录压缩统计信息
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
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use tracing::{debug, info, warn};
use walkdir::WalkDir;
use zip::write::FileOptions;
use zip::CompressionMethod;
use zip::ZipWriter;

use super::{assets, BackupKeyPolicy, BackupManager, BackupManifest};

pub(crate) fn is_portable_excluded_relative_path(relative_path: &Path) -> bool {
    crate::backup_common::is_crypto_secret_backup_relative_path(relative_path)
        || relative_path
            .to_string_lossy()
            .replace('\\', "/")
            .eq_ignore_ascii_case("databases/audit.db")
}

/// Produce a manifest for an unencrypted portable archive without mutating the
/// local backup. Local encryption material and the auxiliary audit database are
/// intentionally excluded from portable ZIP files.
pub(crate) fn portable_manifest_bytes(backup_dir: &Path) -> Result<Vec<u8>, ZipExportError> {
    let manifest_path = backup_dir.join("manifest.json");
    let mut manifest = BackupManifest::load_from_file(&manifest_path)
        .map_err(|error| ZipExportError::ExportFailed(error.to_string()))?;
    manifest.key_policy = BackupKeyPolicy::ExcludedPortable;
    manifest
        .files
        .retain(|file| !is_portable_excluded_relative_path(Path::new(&file.path)));
    if let Some(asset_result) = &mut manifest.assets {
        asset_result.files.retain(|asset| {
            !is_portable_excluded_relative_path(Path::new(&asset.relative_path))
                && !is_portable_excluded_relative_path(Path::new(&asset.original_path))
        });
        asset_result.total_files = asset_result.files.len();
        asset_result.total_size = asset_result.files.iter().map(|asset| asset.size).sum();
    }
    serde_json::to_vec_pretty(&manifest)
        .map_err(|error| ZipExportError::ExportFailed(format!("序列化便携清单失败: {}", error)))
}

fn validate_imported_backup_dir(target_dir: &Path) -> Result<(), ZipExportError> {
    let manifest_path = target_dir.join("manifest.json");
    let manifest = BackupManifest::load_from_file(&manifest_path)
        .map_err(|error| ZipExportError::ExportFailed(error.to_string()))?;
    if manifest.key_policy != BackupKeyPolicy::ExcludedPortable {
        return Err(ZipExportError::ExportFailed(
            "未加密 ZIP 必须声明 key_policy=excluded_portable".to_string(),
        ));
    }
    manifest
        .validate_for_slot_restore()
        .map_err(|error| ZipExportError::ExportFailed(error.to_string()))?;

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
    }
    Ok(())
}

/// ZIP 导出选项
#[derive(Debug, Clone, Serialize, Deserialize)]
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

/// ZIP 导入安全阈值（防止 zip bomb）
const MAX_IMPORT_FILES: usize = 100_000;
const MAX_IMPORT_UNCOMPRESSED_BYTES: u64 = 20 * 1024 * 1024 * 1024; // 20 GiB
const MAX_IMPORT_COMPRESSION_RATIO: f64 = 200.0;

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
    if output_path.exists() {
        let canonical_output = std::fs::canonicalize(output_path)?;
        if canonical_output.starts_with(&canonical_source) {
            return Err(ZipExportError::ExportFailed(format!(
                "ZIP 输出路径不能指向备份源目录内: {}",
                output_path.display()
            )));
        }
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
) -> Result<u64, ZipExportError> {
    let parent = destination
        .parent()
        .ok_or_else(|| ZipExportError::ExportFailed("ZIP 解压目标缺少父目录".to_string()))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    let copied = copy_with_actual_size_budget(
        reader,
        temp.as_file_mut(),
        total_written,
        MAX_IMPORT_UNCOMPRESSED_BYTES,
    )?;
    temp.as_file().sync_all()?;
    temp.persist(destination)
        .map_err(|e| ZipExportError::Io(e.error))?;
    Ok(copied)
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
    let start = std::time::Instant::now();

    // 验证备份目录
    if !backup_dir.exists() {
        return Err(ZipExportError::BackupNotFound(
            backup_dir.to_string_lossy().to_string(),
        ));
    }

    // 验证压缩级别
    if options.compression_level > 9 {
        return Err(ZipExportError::InvalidCompressionLevel(
            options.compression_level,
        ));
    }

    let portable_manifest = portable_manifest_bytes(backup_dir)?;

    let backup_metadata = std::fs::symlink_metadata(backup_dir)?;
    if backup_metadata.file_type().is_symlink() || !backup_metadata.is_dir() {
        return Err(ZipExportError::ExportFailed(
            "备份路径必须是普通目录，不能是文件或符号链接".to_string(),
        ));
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
                .map_or(false, |path| !is_portable_excluded_relative_path(path))
    }) {
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

        if entry.file_type().is_dir() {
            // 添加目录
            debug!("添加目录: {}", relative_path_str);
            zip_writer.add_directory(&relative_path_str, file_options)?;
        } else if entry.file_type().is_file() {
            // 添加文件
            debug!("添加文件: {}", relative_path_str);

            let is_manifest = relative_path_str == "manifest.json";
            let file_size = if is_manifest {
                portable_manifest.len() as u64
            } else {
                std::fs::metadata(path)?.len()
            };
            total_size += file_size;
            file_count += 1;

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
                std::io::copy(&mut file, &mut zip_writer)?;
            }
        }
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
    }

    // 完成 ZIP 文件
    let finished_file = zip_writer.finish()?;
    finished_file.sync_all()?;
    drop(finished_file);
    temp_output
        .persist(&zip_path)
        .map_err(|e| ZipExportError::Io(e.error))?;

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

fn validate_import_archive(archive: &mut zip::ZipArchive<File>) -> Result<(), ZipExportError> {
    if archive.len() > MAX_IMPORT_FILES {
        return Err(ZipExportError::ExportFailed(format!(
            "ZIP 文件数量超限: {} > {}",
            archive.len(),
            MAX_IMPORT_FILES
        )));
    }

    let mut total_uncompressed: u64 = 0;
    let mut paths = std::collections::HashSet::new();
    for i in 0..archive.len() {
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
        if !paths.insert(normalized.clone()) {
            return Err(ZipExportError::ExportFailed(format!(
                "ZIP 包含重复路径: {}",
                normalized
            )));
        }
        let file_size = file.size();
        let compressed_size = file.compressed_size();
        total_uncompressed = total_uncompressed.saturating_add(file_size);

        if total_uncompressed > MAX_IMPORT_UNCOMPRESSED_BYTES {
            return Err(ZipExportError::ExportFailed(format!(
                "ZIP 解压总量超限: {} bytes",
                total_uncompressed
            )));
        }

        if compressed_size > 0 {
            let ratio = file_size as f64 / compressed_size as f64;
            if ratio > MAX_IMPORT_COMPRESSION_RATIO {
                return Err(ZipExportError::ExportFailed(format!(
                    "ZIP 压缩比异常: {:.1} > {:.1}",
                    ratio, MAX_IMPORT_COMPRESSION_RATIO
                )));
            }
        }
    }

    Ok(())
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
    info!("开始从 ZIP 导入备份: {:?} -> {:?}", zip_path, target_dir);

    let zip_file = File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(zip_file)?;
    validate_import_archive(&mut archive)?;

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
            extract_zip_file_atomically(&mut file, &outpath, &mut actual_uncompressed)?;
            file_count += 1;
        }
    }

    validate_imported_backup_dir(target_dir)?;

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
///
/// ## 返回
///
/// 成功时返回解压的文件数量（包含已跳过的文件）
pub fn import_backup_from_zip_with_progress<F, C>(
    zip_path: &Path,
    target_dir: &Path,
    progress_callback: F,
    cancel_check: C,
) -> Result<usize, ZipExportError>
where
    F: FnMut(ZipImportProgress),
    C: Fn() -> bool,
{
    import_backup_from_zip_impl(zip_path, target_dir, progress_callback, cancel_check, false)
}

/// 从 ZIP 文件导入备份（断点续传模式）
///
/// 当 `skip_existing` 为 true 时，跳过目标目录中已存在且大小匹配的文件，
/// 实现中断后的断点续传。
///
/// ## 参数
///
/// * `zip_path` - ZIP 文件路径
/// * `target_dir` - 解压目标目录
/// * `progress_callback` - 进度回调函数
/// * `cancel_check` - 取消检查函数，返回 true 时中止导入
/// * `skip_existing` - 是否跳过已存在且大小匹配的文件（断点续传）
///
/// ## 返回
///
/// 成功时返回解压的文件数量（包含已跳过的文件）
pub fn import_backup_from_zip_resumable<F, C>(
    zip_path: &Path,
    target_dir: &Path,
    progress_callback: F,
    cancel_check: C,
) -> Result<usize, ZipExportError>
where
    F: FnMut(ZipImportProgress),
    C: Fn() -> bool,
{
    import_backup_from_zip_impl(zip_path, target_dir, progress_callback, cancel_check, true)
}

/// ZIP 导入的内部实现
fn import_backup_from_zip_impl<F, C>(
    zip_path: &Path,
    target_dir: &Path,
    mut progress_callback: F,
    cancel_check: C,
    skip_existing: bool,
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
        if skip_existing && !file.is_dir() && outpath.exists() {
            let is_db_file = file_name.to_ascii_lowercase().ends_with(".db");
            if !is_db_file {
                if let Ok(metadata) = std::fs::symlink_metadata(&outpath) {
                    if metadata.len() == file.size() {
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
            extract_zip_file_atomically(&mut file, &outpath, &mut actual_uncompressed)?;
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

    validate_imported_backup_dir(target_dir)?;

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
    use crate::data_governance::backup::{AssetType, BackupFile};
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
        }

        // Empty roots are still an explicit part of a full snapshot's coverage.
        manifest
            .included_components
            .push("workspaces-root".to_string());
        manifest.included_components.extend(
            AssetType::all()
                .into_iter()
                .map(|asset_type| format!("asset-root:{}", asset_type.relative_path())),
        );
        manifest.mark_full();
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

        // 导入到新目录
        let import_dir = TempDir::new().unwrap();
        let file_count =
            import_backup_from_zip(&export_result.zip_path, import_dir.path()).unwrap();

        assert!(file_count > 0);
        assert!(import_dir.path().join("manifest.json").exists());
        assert!(import_dir.path().join("vfs.db").exists());

        // 清理
        std::fs::remove_file(&export_result.zip_path).ok();
    }
}
