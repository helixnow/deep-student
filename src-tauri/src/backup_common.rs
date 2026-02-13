//! 备份系统共享组件
//!
//! 提供所有备份模块共用的全局锁和工具函数
//! - 全局互斥锁: 确保所有备份/恢复操作串行执行
//! - SHA256计算: 用于文件完整性校验
//! - 安全防护: ZIP炸弹检测、符号链接防护

use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::Path;
use std::sync::Arc;
use std::sync::LazyLock;

use crate::models::AppError;
type Result<T> = std::result::Result<T, AppError>;

/// 记录并跳过迭代中的错误，避免 `.flatten()` 静默丢弃
///
/// 适用于 `read_dir` / `WalkDir` 等迭代场景，统一替代各模块中
/// 重复定义的 `log_and_skip_err` 辅助函数。
pub fn log_and_skip_entry_err<T, E: std::fmt::Display>(
    result: std::result::Result<T, E>,
) -> Option<T> {
    match result {
        Ok(v) => Some(v),
        Err(e) => {
            tracing::warn!("[BackupCommon] Directory entry read error (skipped): {}", e);
            None
        }
    }
}

// ============================================================================
// 安全常量 - 防止 ZIP 炸弹和资源耗尽攻击
// ============================================================================

/// 最大允许解压总大小: 10GB
pub const MAX_UNCOMPRESSED_SIZE: u64 = 10 * 1024 * 1024 * 1024;

/// 最大允许单文件大小: 2GB
pub const MAX_SINGLE_FILE_SIZE: u64 = 2 * 1024 * 1024 * 1024;

/// 最大允许压缩比 (解压后大小 / 压缩大小)
/// 正常备份压缩比通常在 2-10 之间，超过 100 可能是 ZIP 炸弹
pub const MAX_COMPRESSION_RATIO: u64 = 100;

/// 最大允许文件数量
pub const MAX_FILE_COUNT: usize = 500_000;

/// 极端压缩比阈值 — 超过此值视为 ZIP 炸弹并拒绝解压
///
/// 正常备份压缩比通常在 2-20 之间；超过 `MAX_COMPRESSION_RATIO` (100)
/// 时记录警告，超过此阈值 (1000) 则直接报错。
pub const EXTREME_COMPRESSION_RATIO: u64 = 1000;

/// 重试次数常量
pub const RESILIENT_RETRY_COUNT: u32 = 5;

/// 重试延迟(毫秒)
pub const RESILIENT_RETRY_DELAY_MS: u64 = 150;

/// 全局备份互斥锁 - 确保所有备份/恢复操作串行执行
///
/// 此锁由以下模块共享:
/// - backup.rs (传统ZIP备份)
///
/// 使用 OwnedSemaphorePermit 可跨 .await 持有，满足 Tauri Future: Send 要求
pub static BACKUP_GLOBAL_LIMITER: LazyLock<Arc<tokio::sync::Semaphore>> =
    LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(1)));

/// 计算文件的SHA256哈希值
///
/// 使用8KB缓冲区分块读取，适合处理大文件而不会占用过多内存
///
/// # Arguments
/// * `path` - 要计算哈希的文件路径
///
/// # Returns
/// * `Ok(String)` - 十六进制格式的SHA256哈希值
/// * `Err(AppError)` - 文件打开或读取失败
///
/// # Example
/// ```rust
/// let hash = calculate_file_hash(Path::new("/path/to/file"))?;
/// println!("SHA256: {}", hash);
/// ```
pub fn calculate_file_hash(path: &Path) -> Result<String> {
    let file = File::open(path)
        .map_err(|e| AppError::file_system(format!("打开文件计算哈希失败 {:?}: {}", path, e)))?;

    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192]; // 8KB 缓冲区

    loop {
        let bytes_read = reader
            .read(&mut buffer)
            .map_err(|e| AppError::file_system(format!("读取文件失败 {:?}: {}", path, e)))?;

        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

/// 计算字节数组的SHA256哈希值
///
/// 用于在内存中计算数据的哈希，无需写入临时文件
///
/// # Arguments
/// * `data` - 要计算哈希的字节数组
///
/// # Returns
/// 十六进制格式的SHA256哈希值
pub fn calculate_bytes_hash(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

// ============================================================================
// ZIP 炸弹检测
// ============================================================================

/// ZIP 安全验证结果
#[derive(Debug)]
pub struct ZipSecurityCheck {
    pub total_uncompressed_size: u64,
    pub total_compressed_size: u64,
    pub file_count: usize,
    pub compression_ratio: f64,
    pub largest_file_size: u64,
    pub largest_file_name: String,
}

impl ZipSecurityCheck {
    /// 验证 ZIP 文件是否安全
    pub fn validate(&self) -> Result<()> {
        // 检查总解压大小
        if self.total_uncompressed_size > MAX_UNCOMPRESSED_SIZE {
            return Err(AppError::validation(format!(
                "ZIP 文件解压后大小 ({:.2} GB) 超过最大限制 ({:.2} GB)，可能是 ZIP 炸弹",
                self.total_uncompressed_size as f64 / 1024.0 / 1024.0 / 1024.0,
                MAX_UNCOMPRESSED_SIZE as f64 / 1024.0 / 1024.0 / 1024.0
            )));
        }

        // 检查单文件大小
        if self.largest_file_size > MAX_SINGLE_FILE_SIZE {
            return Err(AppError::validation(format!(
                "ZIP 中文件 '{}' 大小 ({:.2} GB) 超过单文件限制 ({:.2} GB)",
                self.largest_file_name,
                self.largest_file_size as f64 / 1024.0 / 1024.0 / 1024.0,
                MAX_SINGLE_FILE_SIZE as f64 / 1024.0 / 1024.0 / 1024.0
            )));
        }

        // P1 安全修复: 恢复压缩比检查，使用更宽松的阈值
        // 正常备份压缩比通常在 2-20 之间
        // 超过 MAX_COMPRESSION_RATIO (100) 可能是 ZIP 炸弹
        // 但考虑到某些重复数据可能有较高压缩比，我们只对极高压缩比发出错误
        if self.compression_ratio > EXTREME_COMPRESSION_RATIO as f64 {
            return Err(AppError::validation(format!(
                "ZIP 炸弹检测：压缩比 {:.1} 超过极限阈值 {}，这极可能是恶意文件",
                self.compression_ratio, EXTREME_COMPRESSION_RATIO
            )));
        } else if self.compression_ratio > MAX_COMPRESSION_RATIO as f64 {
            // 对于较高但不极端的压缩比，记录警告但允许继续
            tracing::warn!(
                "ZIP 压缩比较高 ({:.1} > {})，可能是正常的重复数据，也可能是潜在威胁",
                self.compression_ratio,
                MAX_COMPRESSION_RATIO
            );
        }

        // 检查文件数量
        if self.file_count > MAX_FILE_COUNT {
            return Err(AppError::validation(format!(
                "ZIP 文件包含 {} 个文件，超过最大限制 {}",
                self.file_count, MAX_FILE_COUNT
            )));
        }

        Ok(())
    }
}

/// 对 ZIP 文件进行安全检查
///
/// 在解压前检测 ZIP 炸弹和其他恶意 ZIP 文件
pub fn check_zip_security(zip_path: &Path) -> Result<ZipSecurityCheck> {
    let file = File::open(zip_path)
        .map_err(|e| AppError::file_system(format!("打开 ZIP 文件失败: {}", e)))?;

    let compressed_size = file.metadata().map(|m| m.len()).unwrap_or(0);

    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| AppError::file_system(format!("解析 ZIP 文件失败: {}", e)))?;

    let file_count = archive.len();
    let mut total_uncompressed = 0u64;
    let mut largest_size = 0u64;
    let mut largest_name = String::new();

    for i in 0..file_count {
        let file = archive
            .by_index(i)
            .map_err(|e| AppError::file_system(format!("读取 ZIP 条目失败: {}", e)))?;

        let size = file.size();
        total_uncompressed += size;

        if size > largest_size {
            largest_size = size;
            largest_name = file.name().to_string();
        }
    }

    let compression_ratio = if compressed_size > 0 {
        total_uncompressed as f64 / compressed_size as f64
    } else {
        0.0
    };

    Ok(ZipSecurityCheck {
        total_uncompressed_size: total_uncompressed,
        total_compressed_size: compressed_size,
        file_count,
        compression_ratio,
        largest_file_size: largest_size,
        largest_file_name: largest_name,
    })
}

// ============================================================================
// 符号链接检测
// ============================================================================

/// 检查路径是否为符号链接
///
/// 使用 symlink_metadata 而非 metadata，避免跟随符号链接。
///
/// **安全优先**：当权限不足无法读取元数据时，返回 `true`（视为符号链接），
/// 以防止在无法确认安全性的情况下处理潜在的恶意路径。
pub fn is_symlink(path: &Path) -> bool {
    match fs::symlink_metadata(path) {
        Ok(meta) => meta.file_type().is_symlink(),
        Err(e) => {
            tracing::warn!(
                "[BackupCommon] 无法读取路径元数据 {:?}: {}。安全优先：视为符号链接并跳过。",
                path,
                e
            );
            true
        }
    }
}

/// 检查路径是否安全（非符号链接）
///
/// 返回 Ok(()) 如果路径安全，Err 如果是符号链接
pub fn check_path_not_symlink(path: &Path) -> Result<()> {
    if is_symlink(path) {
        return Err(AppError::validation(format!(
            "安全检查失败: 路径 {:?} 是符号链接，已跳过以防止符号链接攻击",
            path
        )));
    }
    Ok(())
}

// ============================================================================
// 磁盘空间检查
// ============================================================================

/// 获取指定路径所在磁盘的可用空间（字节）
///
/// 优先使用系统 API（Unix: statvfs, Windows: GetDiskFreeSpaceExW），
/// 避免解析 `df` / `wmic` 命令输出在非英文 locale 或特殊文件系统下失败。
/// 如果系统 API 失败，则回退到命令行解析方式。
pub fn get_available_disk_space(path: &Path) -> Result<u64> {
    // 确保路径存在
    let check_path = if path.exists() {
        path.to_path_buf()
    } else if let Some(parent) = path.parent() {
        if parent.exists() {
            parent.to_path_buf()
        } else {
            // 回退到根目录
            #[cfg(unix)]
            {
                std::path::PathBuf::from("/")
            }
            #[cfg(windows)]
            {
                std::path::PathBuf::from("C:\\")
            }
        }
    } else {
        #[cfg(unix)]
        {
            std::path::PathBuf::from("/")
        }
        #[cfg(windows)]
        {
            std::path::PathBuf::from("C:\\")
        }
    };

    // ---- 主路径：系统 API ----

    #[cfg(unix)]
    {
        match get_disk_space_statvfs(&check_path) {
            Ok(bytes) => return Ok(bytes),
            Err(e) => {
                tracing::warn!("[BackupCommon] statvfs 调用失败，回退到 df 命令解析: {}", e);
            }
        }
    }

    #[cfg(windows)]
    {
        match get_disk_space_win32(&check_path) {
            Ok(bytes) => return Ok(bytes),
            Err(e) => {
                tracing::warn!(
                    "[BackupCommon] GetDiskFreeSpaceExW 调用失败，回退到命令行解析: {}",
                    e
                );
            }
        }
    }

    // ---- 回退路径：命令行解析（保持向后兼容） ----

    #[cfg(unix)]
    {
        if let Some(bytes) = get_disk_space_df_fallback(&check_path) {
            return Ok(bytes);
        }
    }

    #[cfg(windows)]
    {
        if let Some(bytes) = get_disk_space_wmic_fallback(&check_path) {
            return Ok(bytes);
        }
    }

    // ---- 最终：无法获取时的安全处理 ----
    //
    // P0 安全修复: 无法获取磁盘空间时的处理策略
    //
    // 默认行为: 返回错误，拒绝操作（安全优先）
    // 可通过环境变量 BACKUP_ALLOW_UNKNOWN_DISK_SPACE=1 启用回退模式
    //
    // 安全考量:
    // - 返回虚假的大空间值可能导致操作失败后数据不一致
    // - 用户应该先解决磁盘空间检查失败的问题（如权限、文件系统类型）
    let allow_fallback = std::env::var("BACKUP_ALLOW_UNKNOWN_DISK_SPACE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    if allow_fallback {
        tracing::warn!(
            "无法获取磁盘可用空间，使用保守估计值 1GB（已通过环境变量启用回退模式）。\
             如果操作失败，请确保磁盘有足够空间后重试。"
        );
        Ok(1024 * 1024 * 1024) // 1GB - 保守回退值
    } else {
        tracing::error!(
            "无法获取磁盘可用空间，为确保数据安全，操作已中止。\
             请检查文件系统权限或设置 BACKUP_ALLOW_UNKNOWN_DISK_SPACE=1 环境变量以启用回退模式。"
        );
        Err(AppError::validation(
            "无法获取磁盘可用空间。请检查文件系统权限，或设置 BACKUP_ALLOW_UNKNOWN_DISK_SPACE=1 环境变量以使用保守估计值。".to_string()
        ))
    }
}

// ============================================================================
// 平台原生磁盘空间查询
// ============================================================================

/// Unix: 使用 libc::statvfs 系统调用获取磁盘可用空间
///
/// 直接调用 POSIX statvfs，不依赖外部命令，不受 locale 影响。
/// f_bavail * f_frsize = 非特权用户可用的字节数。
#[cfg(unix)]
fn get_disk_space_statvfs(path: &Path) -> Result<u64> {
    use std::ffi::CString;

    let path_str = path
        .to_str()
        .ok_or_else(|| AppError::validation("路径包含无效 UTF-8 字符".to_string()))?;

    let c_path = CString::new(path_str)
        .map_err(|e| AppError::validation(format!("路径包含空字节，无法传递给 statvfs: {}", e)))?;

    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    let ret = unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) };

    if ret == 0 {
        // f_bavail: 非特权进程可用的块数
        // f_frsize: 基本文件系统块大小（fragment size）
        let available = stat.f_bavail as u64 * stat.f_frsize as u64;
        tracing::debug!(
            "[BackupCommon] statvfs 成功: path={}, available={} bytes ({:.2} GB)",
            path_str,
            available,
            available as f64 / 1024.0 / 1024.0 / 1024.0
        );
        Ok(available)
    } else {
        let errno = std::io::Error::last_os_error();
        Err(AppError::file_system(format!(
            "statvfs 调用失败 (path={:?}): {}",
            path, errno
        )))
    }
}

/// Windows: 使用 GetDiskFreeSpaceExW 获取磁盘可用空间
///
/// 直接调用 Win32 API，不依赖已废弃的 wmic 命令。
#[cfg(windows)]
fn get_disk_space_win32(path: &Path) -> Result<u64> {
    use std::os::windows::ffi::OsStrExt;

    // 将路径转换为以 null 结尾的宽字符串
    let wide_path: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let mut free_bytes_available: u64 = 0;
    let mut total_bytes: u64 = 0;
    let mut total_free_bytes: u64 = 0;

    // FFI 声明
    extern "system" {
        fn GetDiskFreeSpaceExW(
            lpDirectoryName: *const u16,
            lpFreeBytesAvailableToCaller: *mut u64,
            lpTotalNumberOfBytes: *mut u64,
            lpTotalNumberOfFreeBytes: *mut u64,
        ) -> i32;
    }

    let ret = unsafe {
        GetDiskFreeSpaceExW(
            wide_path.as_ptr(),
            &mut free_bytes_available,
            &mut total_bytes,
            &mut total_free_bytes,
        )
    };

    if ret != 0 {
        tracing::debug!(
            "[BackupCommon] GetDiskFreeSpaceExW 成功: path={:?}, available={} bytes ({:.2} GB)",
            path,
            free_bytes_available,
            free_bytes_available as f64 / 1024.0 / 1024.0 / 1024.0
        );
        Ok(free_bytes_available)
    } else {
        let errno = std::io::Error::last_os_error();
        Err(AppError::file_system(format!(
            "GetDiskFreeSpaceExW 调用失败 (path={:?}): {}",
            path, errno
        )))
    }
}

// ============================================================================
// 命令行回退（保持向后兼容）
// ============================================================================

/// Unix 回退: 解析 `df -k` 命令输出获取可用空间
///
/// 注意：此方式在非英文 locale 下可能列标题不同，但数据列顺序通常不变。
/// 仅在 statvfs 失败时使用。
#[cfg(unix)]
fn get_disk_space_df_fallback(path: &Path) -> Option<u64> {
    use std::process::Command;

    let output = Command::new("df")
        .args(["-k", &path.to_string_lossy()])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    // 解析 df 输出的第二行第四列（Available）
    let line = stdout.lines().nth(1)?;
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() >= 4 {
        if let Ok(available_kb) = parts[3].parse::<u64>() {
            tracing::debug!("[BackupCommon] df 回退成功: available={} KB", available_kb);
            return Some(available_kb * 1024);
        }
    }
    None
}

/// Windows 回退: 解析 `wmic` 命令输出获取可用空间
///
/// 注意：wmic 已在 Windows 11 中废弃，仅作为最后手段。
/// 仅在 GetDiskFreeSpaceExW 失败时使用。
#[cfg(windows)]
fn get_disk_space_wmic_fallback(path: &Path) -> Option<u64> {
    use std::process::Command;

    let drive = path
        .components()
        .next()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .unwrap_or_else(|| "C:".to_string());

    let output = Command::new("wmic")
        .args([
            "logicaldisk",
            "where",
            &format!("DeviceID='{}'", drive),
            "get",
            "FreeSpace",
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if let Ok(free_bytes) = line.trim().parse::<u64>() {
            tracing::debug!(
                "[BackupCommon] wmic 回退成功: available={} bytes",
                free_bytes
            );
            return Some(free_bytes);
        }
    }
    None
}

/// 检查是否有足够的磁盘空间
///
/// 需要额外 20% 安全余量
pub fn check_disk_space(path: &Path, required_bytes: u64) -> Result<()> {
    let available = get_available_disk_space(path)?;
    let required_with_margin = (required_bytes as f64 * 1.2) as u64; // 20% 安全余量

    if available < required_with_margin {
        return Err(AppError::validation(format!(
            "磁盘空间不足: 需要 {:.2} GB，可用 {:.2} GB",
            required_with_margin as f64 / 1024.0 / 1024.0 / 1024.0,
            available as f64 / 1024.0 / 1024.0 / 1024.0
        )));
    }

    Ok(())
}

// ============================================================================
// 安全目录复制 - 防止符号链接攻击
// ============================================================================

/// 安全递归复制目录，跳过所有符号链接
///
/// 与 fs_extra::dir::copy 不同，此函数会在每个文件/目录级别检查符号链接，
/// 防止目录遍历攻击。
///
/// # Arguments
/// * `src` - 源目录路径
/// * `dst` - 目标目录路径（将在此目录下创建 src 的最后一级目录名）
///
/// # Returns
/// * `Ok(u64)` - 复制的总字节数
/// * `Err(AppError)` - 复制过程中的错误
pub fn copy_directory_safe(src: &Path, dst: &Path) -> Result<u64> {
    // 跳过符号链接
    if is_symlink(src) {
        tracing::warn!("跳过符号链接目录 (安全防护): {:?}", src);
        return Ok(0);
    }

    // 获取源目录名
    let dir_name = src
        .file_name()
        .ok_or_else(|| AppError::file_system("无法获取目录名".to_string()))?;
    let target_dir = dst.join(dir_name);

    // 创建目标目录
    fs::create_dir_all(&target_dir)
        .map_err(|e| AppError::file_system(format!("创建目录失败 {:?}: {}", target_dir, e)))?;

    copy_directory_recursive_safe(src, &target_dir)
}

/// 递归复制目录内容（内部函数）
fn copy_directory_recursive_safe(src: &Path, dst: &Path) -> Result<u64> {
    let mut total_bytes: u64 = 0;

    let entries = fs::read_dir(src)
        .map_err(|e| AppError::file_system(format!("读取目录失败 {:?}: {}", src, e)))?;

    for entry in entries.filter_map(log_and_skip_entry_err) {
        let path = entry.path();
        let file_name = entry.file_name();
        let dest_path = dst.join(&file_name);

        // 关键安全检查：跳过符号链接
        if is_symlink(&path) {
            tracing::warn!("跳过符号链接 (安全防护): {:?}", path);
            continue;
        }

        if path.is_dir() {
            // 递归复制子目录
            fs::create_dir_all(&dest_path).map_err(|e| {
                AppError::file_system(format!("创建目录失败 {:?}: {}", dest_path, e))
            })?;
            total_bytes += copy_directory_recursive_safe(&path, &dest_path)?;
        } else if path.is_file() {
            // 复制文件
            let bytes = fs::copy(&path, &dest_path)
                .map_err(|e| AppError::file_system(format!("复制文件失败 {:?}: {}", path, e)))?;
            total_bytes += bytes;
        }
    }

    Ok(total_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::{NamedTempFile, TempDir};

    // ================================================================
    // calculate_file_hash 测试
    // ================================================================

    #[test]
    fn test_calculate_file_hash_known_content() {
        let mut temp_file = NamedTempFile::new().unwrap();
        temp_file.write_all(b"hello world").unwrap();
        temp_file.flush().unwrap();

        let hash = calculate_file_hash(temp_file.path()).unwrap();
        // SHA256 of "hello world"
        assert_eq!(
            hash,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }

    #[test]
    fn test_calculate_file_hash_empty_file() {
        let temp_file = NamedTempFile::new().unwrap();
        // 文件刚创建，内容为空
        let hash = calculate_file_hash(temp_file.path()).unwrap();
        // SHA256 of empty string
        assert_eq!(
            hash,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn test_calculate_file_hash_nonexistent_file() {
        let result = calculate_file_hash(Path::new("/tmp/__nonexistent_file_for_test_12345__"));
        assert!(result.is_err(), "不存在的文件应该返回错误");
    }

    #[test]
    fn test_calculate_bytes_hash() {
        let hash = calculate_bytes_hash(b"hello world");
        assert_eq!(
            hash,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }

    // ================================================================
    // check_zip_security 测试
    // ================================================================

    #[test]
    fn test_check_zip_security_normal_zip() {
        // 创建一个正常的 ZIP 文件
        let temp_file = NamedTempFile::new().unwrap();
        {
            let mut zip_writer = zip::ZipWriter::new(&temp_file);
            let options = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            zip_writer.start_file("test.txt", options).unwrap();
            zip_writer.write_all(b"hello zip content").unwrap();
            zip_writer.finish().unwrap();
        }

        let check = check_zip_security(temp_file.path()).unwrap();
        // 正常 ZIP 应该通过安全验证
        assert!(check.validate().is_ok());
        assert_eq!(check.file_count, 1);
        assert!(check.total_uncompressed_size > 0);
    }

    #[test]
    fn test_check_zip_security_rejects_oversized_file() {
        // 直接构造一个 ZipSecurityCheck 模拟超大文件场景
        let check = ZipSecurityCheck {
            total_uncompressed_size: MAX_UNCOMPRESSED_SIZE + 1,
            total_compressed_size: 1024,
            file_count: 1,
            compression_ratio: (MAX_UNCOMPRESSED_SIZE + 1) as f64 / 1024.0,
            largest_file_size: MAX_UNCOMPRESSED_SIZE + 1,
            largest_file_name: "bomb.bin".to_string(),
        };

        let result = check.validate();
        assert!(result.is_err(), "超大解压体积应该被拒绝");
    }

    #[test]
    fn test_check_zip_security_rejects_extreme_ratio() {
        // 模拟极端压缩比（ZIP 炸弹特征）
        let check = ZipSecurityCheck {
            total_uncompressed_size: 100_000_000, // 100 MB 解压
            total_compressed_size: 100,           // 100 bytes 压缩
            file_count: 1,
            compression_ratio: 1_000_000.0, // 极端压缩比
            largest_file_size: 100_000_000,
            largest_file_name: "bomb.bin".to_string(),
        };

        let result = check.validate();
        assert!(result.is_err(), "极端压缩比应该被拒绝");
    }

    #[test]
    fn test_check_zip_security_rejects_too_many_files() {
        let check = ZipSecurityCheck {
            total_uncompressed_size: 1024,
            total_compressed_size: 512,
            file_count: MAX_FILE_COUNT + 1,
            compression_ratio: 2.0,
            largest_file_size: 1024,
            largest_file_name: "file.txt".to_string(),
        };

        let result = check.validate();
        assert!(result.is_err(), "超过最大文件数量应该被拒绝");
    }

    // ================================================================
    // is_symlink 测试
    // ================================================================

    #[test]
    fn test_is_symlink_regular_file() {
        let temp_file = NamedTempFile::new().unwrap();
        assert!(
            !is_symlink(temp_file.path()),
            "普通文件不应被识别为符号链接"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_is_symlink_actual_symlink() {
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("target.txt");
        std::fs::write(&target, b"target content").unwrap();

        let link = dir.path().join("link.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        assert!(is_symlink(&link), "符号链接应被正确识别");
        assert!(!is_symlink(&target), "目标文件不应被识别为符号链接");
    }

    // ================================================================
    // get_available_disk_space 测试
    // ================================================================

    #[test]
    fn test_get_available_disk_space_current_dir() {
        let result = get_available_disk_space(Path::new("."));
        assert!(result.is_ok(), "当前目录应该能获取磁盘空间");
        let space = result.unwrap();
        assert!(space > 0, "磁盘可用空间应该为正数，实际值: {}", space);
    }

    // ================================================================
    // log_and_skip_entry_err 测试
    // ================================================================

    #[test]
    fn test_log_and_skip_entry_err_ok_value() {
        let result: std::result::Result<i32, String> = Ok(42);
        let opt = log_and_skip_entry_err(result);
        assert_eq!(opt, Some(42), "Ok 值应该被正常传递");
    }

    #[test]
    fn test_log_and_skip_entry_err_err_value() {
        let result: std::result::Result<i32, String> = Err("some error".to_string());
        let opt = log_and_skip_entry_err(result);
        assert_eq!(opt, None, "Err 值应该返回 None");
    }

    // ================================================================
    // copy_directory_safe 测试
    // ================================================================

    #[test]
    fn test_copy_directory_safe_basic() {
        let src_dir = TempDir::new().unwrap();
        let dst_dir = TempDir::new().unwrap();

        // 在源目录中创建文件
        let src_file = src_dir.path().join("hello.txt");
        std::fs::write(&src_file, b"hello copy").unwrap();

        // 创建子目录和文件
        let sub_dir = src_dir.path().join("subdir");
        std::fs::create_dir(&sub_dir).unwrap();
        std::fs::write(sub_dir.join("nested.txt"), b"nested content").unwrap();

        let bytes = copy_directory_safe(src_dir.path(), dst_dir.path()).unwrap();
        assert!(bytes > 0, "应该复制了一些字节");

        // 验证目标文件存在
        let dir_name = src_dir.path().file_name().unwrap();
        let copied_file = dst_dir.path().join(dir_name).join("hello.txt");
        assert!(copied_file.exists(), "复制的文件应该存在");

        let nested = dst_dir
            .path()
            .join(dir_name)
            .join("subdir")
            .join("nested.txt");
        assert!(nested.exists(), "嵌套文件应该存在");
    }

    #[cfg(unix)]
    #[test]
    fn test_copy_directory_safe_skips_symlinks() {
        let src_dir = TempDir::new().unwrap();
        let dst_dir = TempDir::new().unwrap();

        // 创建普通文件
        std::fs::write(src_dir.path().join("normal.txt"), b"normal").unwrap();

        // 创建符号链接
        let target = src_dir.path().join("normal.txt");
        let link = src_dir.path().join("link.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let bytes = copy_directory_safe(src_dir.path(), dst_dir.path()).unwrap();
        assert!(bytes > 0);

        let dir_name = src_dir.path().file_name().unwrap();
        let normal_dst = dst_dir.path().join(dir_name).join("normal.txt");
        let link_dst = dst_dir.path().join(dir_name).join("link.txt");

        assert!(normal_dst.exists(), "普通文件应该被复制");
        assert!(!link_dst.exists(), "符号链接应该被跳过");
    }

    // ================================================================
    // check_path_not_symlink 测试
    // ================================================================

    #[test]
    fn test_check_path_not_symlink_regular_file() {
        let temp_file = NamedTempFile::new().unwrap();
        assert!(
            check_path_not_symlink(temp_file.path()).is_ok(),
            "普通文件应该通过安全检查"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_check_path_not_symlink_rejects_symlink() {
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("target.txt");
        std::fs::write(&target, b"content").unwrap();

        let link = dir.path().join("link.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        assert!(check_path_not_symlink(&link).is_err(), "符号链接应该被拒绝");
    }
}
