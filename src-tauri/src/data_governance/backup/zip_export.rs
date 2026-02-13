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

/// 记录并跳过迭代中的错误，避免静默丢弃
fn log_and_skip_err_walkdir(
    result: Result<walkdir::DirEntry, walkdir::Error>,
) -> Option<walkdir::DirEntry> {
    match result {
        Ok(v) => Some(v),
        Err(e) => {
            warn!("[ZipExport] Directory walk error (skipped): {}", e);
            None
        }
    }
}
use zip::write::FileOptions;
use zip::CompressionMethod;
use zip::ZipWriter;

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

    info!(
        "开始导出 ZIP: {:?} -> {:?}, 压缩级别: {}",
        backup_dir, zip_path, options.compression_level
    );

    // 创建 ZIP 文件
    let zip_file = File::create(&zip_path)?;
    let mut zip_writer = ZipWriter::new(zip_file);

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
    for entry in WalkDir::new(backup_dir)
        .into_iter()
        .filter_map(log_and_skip_err_walkdir)
    {
        let path = entry.path();
        let relative_path = path
            .strip_prefix(backup_dir)
            .map_err(|_| ZipExportError::ExportFailed("无法计算相对路径".to_string()))?;

        // 跳过空路径（根目录）
        if relative_path.as_os_str().is_empty() {
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

            let mut file = File::open(path)?;
            let metadata = file.metadata()?;
            let file_size = metadata.len();
            total_size += file_size;
            file_count += 1;

            // 计算校验和（如果需要）
            if options.include_checksums {
                let checksum = calculate_file_sha256(path)?;
                checksums.push((relative_path_str.clone(), checksum));
            }

            // 写入 ZIP（流式，避免大文件 read_to_end 导致内存峰值）
            zip_writer.start_file(&relative_path_str, file_options)?;
            std::io::copy(&mut file, &mut zip_writer)?;
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
    zip_writer.finish()?;

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
    for i in 0..archive.len() {
        let file = archive.by_index(i)?;
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

    // 确保目标目录存在
    std::fs::create_dir_all(target_dir)?;

    let mut file_count = 0;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        let outpath = target_dir.join(file.mangled_name());

        if file.is_dir() {
            std::fs::create_dir_all(&outpath)?;
        } else {
            if let Some(parent) = outpath.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut outfile = File::create(&outpath)?;
            std::io::copy(&mut file, &mut outfile)?;
            file_count += 1;
        }
    }

    // 验证 manifest.json 存在（缺失则视为无效备份）
    let manifest_path = target_dir.join("manifest.json");
    if !manifest_path.exists() {
        return Err(ZipExportError::ExportFailed(
            "备份目录中缺少 manifest.json 文件".to_string(),
        ));
    }

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

    // 确保目标目录存在
    std::fs::create_dir_all(target_dir)?;

    // 阶段 2: 解压文件（5% - 80%）
    let mut file_count = 0;
    let mut skipped_count: usize = 0;
    let extract_progress_range = 75.0; // 5% to 80%

    for i in 0..total_files {
        if cancel_check() {
            return Err(ZipExportError::Io(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "用户取消导入",
            )));
        }

        let mut file = archive.by_index(i)?;
        let outpath = target_dir.join(file.mangled_name());
        let file_name = file.mangled_name().to_string_lossy().to_string();

        // 计算当前进度（安全除法，避免除零）
        let current_progress = if total_files > 0 {
            5.0 + (i as f32 / total_files as f32) * extract_progress_range
        } else {
            5.0 + extract_progress_range // 没有文件时直接完成这部分进度
        };

        // 断点续传：跳过已存在且大小匹配的文件
        if skip_existing && !file.is_dir() && outpath.exists() {
            if let Ok(metadata) = std::fs::metadata(&outpath) {
                if metadata.len() == file.size() {
                    skipped_count += 1;
                    file_count += 1;
                    progress_callback(ZipImportProgress {
                        phase: ZipImportPhase::Extract,
                        progress: current_progress,
                        processed_files: i,
                        total_files,
                        current_file: Some(file_name.clone()),
                        message: format!("跳过已存在: {} ({}/{})", file_name, i + 1, total_files),
                    });
                    continue;
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
            std::fs::create_dir_all(&outpath)?;
        } else {
            if let Some(parent) = outpath.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut outfile = File::create(&outpath)?;
            std::io::copy(&mut file, &mut outfile)?;
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

    // 验证 manifest.json 存在
    let manifest_path = target_dir.join("manifest.json");
    if !manifest_path.exists() {
        return Err(ZipExportError::ExportFailed(
            "备份目录中缺少 manifest.json 文件".to_string(),
        ));
    }

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
    use tempfile::TempDir;

    fn create_test_backup_dir() -> TempDir {
        let dir = TempDir::new().unwrap();

        // 创建测试文件
        let backup_dir = dir.path();

        // 创建子目录
        std::fs::create_dir_all(backup_dir.join("databases")).unwrap();

        // 创建测试数据库文件
        std::fs::write(
            backup_dir.join("databases/vfs.db"),
            "test database content for vfs",
        )
        .unwrap();

        std::fs::write(
            backup_dir.join("databases/chat_v2.db"),
            "test database content for chat_v2",
        )
        .unwrap();

        // 创建清单文件
        std::fs::write(
            backup_dir.join("manifest.json"),
            r#"{"version": "1.0.0", "files": []}"#,
        )
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
        assert!(import_dir.path().join("databases/vfs.db").exists());

        // 清理
        std::fs::remove_file(&export_result.zip_path).ok();
    }
}
