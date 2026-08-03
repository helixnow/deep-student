//! 备份系统共享组件
//!
//! 提供所有备份模块共用的全局锁和工具函数
//! - 全局互斥锁: 确保所有备份/恢复操作串行执行
//! - SHA256计算: 用于文件完整性校验
//! - 安全防护: ZIP炸弹检测、符号链接防护

use chrono::{DateTime, Utc};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::RwLock;
use tokio::sync::OwnedSemaphorePermit;
use uuid::Uuid;

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
///
/// 使用 OwnedSemaphorePermit 可跨 .await 持有，满足 Tauri Future: Send 要求
pub static BACKUP_GLOBAL_LIMITER: LazyLock<Arc<tokio::sync::Semaphore>> =
    LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(1)));

/// 会改变数据治理状态的操作类型。
///
/// 该类型是 additive 的运行账本字段；旧前端不读取它也不影响现有命令。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DataGovernanceOperationKind {
    Backup,
    AutoBackup,
    Verify,
    ZipExport,
    ZipImport,
    Restore,
    Sync,
    DeletePropagation,
    Prune,
}

/// 当前持有全局数据治理操作租约的任务。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DataGovernanceOperationSnapshot {
    pub operation_id: String,
    pub kind: DataGovernanceOperationKind,
    pub started_at: DateTime<Utc>,
    pub process_id: u32,
}

static CURRENT_DATA_GOVERNANCE_OPERATION: LazyLock<
    RwLock<Option<DataGovernanceOperationSnapshot>>,
> = LazyLock::new(|| RwLock::new(None));

/// 全局数据治理操作的 RAII 租约。
///
/// 统一保存 operation id 和 holder 元数据，避免命令在已经发出“preparing”
/// 事件后才发现锁冲突。同进程由 semaphore 串行化，槽位外 advisory lock
/// 负责阻止两个进程同时写不同 active slot 或远端根。
pub struct DataGovernanceOperationGuard {
    operation_id: String,
    _process_lock: ProcessOperationLock,
    _permit: OwnedSemaphorePermit,
}

#[derive(Debug)]
struct ProcessOperationLock {
    file: File,
}

impl Drop for ProcessOperationLock {
    fn drop(&mut self) {
        if let Err(error) = self.file.unlock() {
            tracing::warn!(
                "[DataGovernance] 释放跨进程操作锁失败（进程退出仍会由 OS 回收）: {}",
                error
            );
        }
    }
}

impl DataGovernanceOperationGuard {
    /// 等待并取得全局操作租约。
    pub async fn acquire(
        kind: DataGovernanceOperationKind,
        operation_id: Option<String>,
    ) -> Result<Self> {
        let permit = BACKUP_GLOBAL_LIMITER
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| AppError::validation("数据治理操作协调器已关闭".to_string()))?;
        Self::from_permit(kind, operation_id, permit)
    }

    /// 立即尝试取得全局操作租约；被占用时返回明确的 blocked 错误。
    pub fn try_acquire(
        kind: DataGovernanceOperationKind,
        operation_id: Option<String>,
    ) -> Result<Self> {
        let permit = BACKUP_GLOBAL_LIMITER
            .clone()
            .try_acquire_owned()
            .map_err(|_| {
                let holder = current_data_governance_operation()
                    .map(|current| {
                        format!(
                            "（当前 {:?}，operation_id={}）",
                            current.kind, current.operation_id
                        )
                    })
                    .unwrap_or_default();
                AppError::validation(format!("已有数据治理操作正在运行{holder}"))
            })?;
        Self::from_permit(kind, operation_id, permit)
    }

    fn from_permit(
        kind: DataGovernanceOperationKind,
        operation_id: Option<String>,
        permit: OwnedSemaphorePermit,
    ) -> Result<Self> {
        let operation_id = operation_id
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let snapshot = DataGovernanceOperationSnapshot {
            operation_id: operation_id.clone(),
            kind,
            started_at: Utc::now(),
            process_id: std::process::id(),
        };
        let process_lock = acquire_process_operation_lock(&snapshot)?;
        *CURRENT_DATA_GOVERNANCE_OPERATION
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(snapshot);
        Ok(Self {
            operation_id,
            _process_lock: process_lock,
            _permit: permit,
        })
    }

    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }
}

impl Drop for DataGovernanceOperationGuard {
    fn drop(&mut self) {
        let mut current = CURRENT_DATA_GOVERNANCE_OPERATION
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if current
            .as_ref()
            .is_some_and(|snapshot| snapshot.operation_id == self.operation_id)
        {
            *current = None;
        }
    }
}

fn process_operation_lock_path() -> PathBuf {
    crate::data_space::get_data_space_manager()
        .map(|manager| {
            manager
                .base_dir()
                .join("recovery")
                .join(".data-governance-operation.lock")
        })
        .unwrap_or_else(|| std::env::temp_dir().join("deep-student-data-governance.lock"))
}

fn acquire_process_operation_lock(
    snapshot: &DataGovernanceOperationSnapshot,
) -> Result<ProcessOperationLock> {
    let path = process_operation_lock_path();
    acquire_process_operation_lock_at(&path, snapshot)
}

fn acquire_process_operation_lock_at(
    path: &Path,
    snapshot: &DataGovernanceOperationSnapshot,
) -> Result<ProcessOperationLock> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            AppError::file_system(format!(
                "创建数据治理跨进程锁目录失败 {:?}: {}",
                parent, error
            ))
        })?;
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(&path)
        .map_err(|error| {
            AppError::file_system(format!("打开数据治理跨进程锁失败 {:?}: {}", path, error))
        })?;

    if let Err(error) = file.try_lock_exclusive() {
        let mut holder = String::new();
        let _ = file.seek(SeekFrom::Start(0));
        let _ = file.read_to_string(&mut holder);
        let holder = holder.trim();
        let detail = if holder.is_empty() {
            String::new()
        } else {
            format!("（holder={}）", holder)
        };
        return Err(AppError::validation(format!(
            "另一个客户端进程正在执行数据治理操作{}: {}",
            detail, error
        )));
    }

    let encoded = serde_json::to_vec(snapshot)
        .map_err(|error| AppError::internal(format!("序列化数据治理操作账本失败: {}", error)))?;
    file.set_len(0).map_err(|error| {
        AppError::file_system(format!("清空数据治理操作锁账本失败 {:?}: {}", path, error))
    })?;
    file.seek(SeekFrom::Start(0)).map_err(|error| {
        AppError::file_system(format!("定位数据治理操作锁账本失败 {:?}: {}", path, error))
    })?;
    file.write_all(&encoded).map_err(|error| {
        AppError::file_system(format!("写入数据治理操作锁账本失败 {:?}: {}", path, error))
    })?;
    file.sync_data().map_err(|error| {
        AppError::file_system(format!("同步数据治理操作锁账本失败 {:?}: {}", path, error))
    })?;
    Ok(ProcessOperationLock { file })
}

/// 返回当前操作账本快照；状态查询不需要持有全局操作锁。
pub fn current_data_governance_operation() -> Option<DataGovernanceOperationSnapshot> {
    CURRENT_DATA_GOVERNANCE_OPERATION
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

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
// 备份产物敏感材料剥离
// ============================================================================

const BACKUP_CRYPTO_SECRET_PATHS: [&str; 4] = ["crypto", ".secure", ".master_key", ".key_seed"];

/// 判断备份根目录下的相对路径是否属于不应进入未加密 ZIP 的密钥材料。
///
/// 只匹配顶层条目及其后代，避免误伤资产目录中碰巧同名的普通文件。
pub(crate) fn is_crypto_secret_backup_relative_path(relative_path: &Path) -> bool {
    let Some(first_component) = relative_path.components().next() else {
        return false;
    };
    let std::path::Component::Normal(first_component) = first_component else {
        return false;
    };
    let first_component = first_component.to_string_lossy();
    BACKUP_CRYPTO_SECRET_PATHS
        .iter()
        .any(|name| first_component.eq_ignore_ascii_case(name))
}

/// 从备份目录中剥离加密密钥材料（审阅 15-backup-dataspace P1-1）。
///
/// `backup_crypto_keys` 会把明文主密钥 `.master_key` 与 `.secure/`
/// 目录（密钥种子 `.key_seed` + 加密凭据 `*.enc`）复制进备份目录的
/// `crypto/` 子目录；而备份 ZIP 导出没有任何加密，自动备份还可能写到
/// 网盘同步目录——拿到 ZIP 即同时获得密文与解密密钥。
///
/// 在把备份目录打包为**未加密 ZIP** 之前调用本函数，删除以下敏感条目：
/// - `crypto/` 子目录（整体）
/// - 备份根目录下可能存在的散落 `.master_key` / `.key_seed` / `.secure`
///
/// 取舍：剥离后该 ZIP 恢复到新设备时无法自动解密历史 API 凭据
/// （`restore_crypto_keys` 对缺失 `crypto/` 的备份按"旧版备份"跳过、
/// 不会报错），用户需重新输入 API Key——相比密钥随明文 ZIP 泄露，
/// 这是可接受的代价。
///
/// 返回删除的条目数。任何删除或删除后验证失败都会中止导出，避免在
/// 未加密 ZIP 中意外保留密钥材料。
pub fn strip_crypto_secrets_from_backup_dir(backup_dir: &Path) -> Result<usize> {
    strip_crypto_secrets_from_backup_dir_with(backup_dir, remove_sensitive_entry)
}

fn remove_sensitive_entry(path: &Path, metadata: &fs::Metadata) -> std::io::Result<()> {
    if metadata.file_type().is_symlink() {
        #[cfg(windows)]
        {
            if path.is_dir() {
                return fs::remove_dir(path);
            }
        }
        return fs::remove_file(path);
    }

    if metadata.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

fn strip_crypto_secrets_from_backup_dir_with<F>(backup_dir: &Path, mut remover: F) -> Result<usize>
where
    F: FnMut(&Path, &fs::Metadata) -> std::io::Result<()>,
{
    let backup_metadata = fs::symlink_metadata(backup_dir)
        .map_err(|e| AppError::file_system(format!("检查备份目录失败 {:?}: {}", backup_dir, e)))?;
    if backup_metadata.file_type().is_symlink() || !backup_metadata.is_dir() {
        return Err(AppError::file_system(format!(
            "备份目录必须是普通目录，不能是文件或符号链接: {:?}",
            backup_dir
        )));
    }

    let mut sensitive_paths = Vec::new();
    for entry in fs::read_dir(backup_dir).map_err(|e| {
        AppError::file_system(format!("扫描备份敏感条目失败 {:?}: {}", backup_dir, e))
    })? {
        let entry = entry.map_err(|e| {
            AppError::file_system(format!("读取备份敏感条目失败 {:?}: {}", backup_dir, e))
        })?;
        if is_crypto_secret_backup_relative_path(Path::new(&entry.file_name())) {
            sensitive_paths.push(entry.path());
        }
    }
    sensitive_paths.sort();
    let mut removed = 0usize;

    for path in &sensitive_paths {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                return Err(AppError::file_system(format!(
                    "检查备份敏感条目失败 {:?}: {}",
                    path, e
                )))
            }
        };

        remover(path, &metadata).map_err(|e| {
            AppError::file_system(format!("剥离备份敏感条目失败 {:?}: {}", path, e))
        })?;
        tracing::info!("[BackupCommon] 已从备份产物剥离敏感条目: {:?}", path);
        removed += 1;
    }

    for entry in fs::read_dir(backup_dir).map_err(|e| {
        AppError::file_system(format!("验证备份敏感条目失败 {:?}: {}", backup_dir, e))
    })? {
        let entry = entry.map_err(|e| {
            AppError::file_system(format!("读取备份验证条目失败 {:?}: {}", backup_dir, e))
        })?;
        if is_crypto_secret_backup_relative_path(Path::new(&entry.file_name())) {
            return Err(AppError::file_system(format!(
                "备份敏感条目删除后仍然存在: {:?}",
                entry.path()
            )));
        }
    }

    Ok(removed)
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
    use std::os::windows::process::CommandExt;
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
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
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
    let safety_margin = required_bytes
        .checked_add(4)
        .map(|value| value / 5)
        .ok_or_else(|| AppError::validation("磁盘空间预算溢出".to_string()))?;
    let required_with_margin = required_bytes
        .checked_add(safety_margin)
        .ok_or_else(|| AppError::validation("磁盘空间预算溢出".to_string()))?;

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

    for entry in entries {
        let entry =
            entry.map_err(|e| AppError::file_system(format!("读取目录项失败 {:?}: {}", src, e)))?;
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

#[derive(Serialize, Deserialize, Clone)]
pub struct ImportProgress {
    pub phase: String,
    pub progress: f32,
    pub message: String,
    pub current_file: Option<String>,
    pub total_files: usize,
    pub processed_files: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::{NamedTempFile, TempDir};

    #[test]
    fn process_operation_lock_blocks_a_second_holder() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("operation.lock");
        let first_snapshot = DataGovernanceOperationSnapshot {
            operation_id: "first".to_string(),
            kind: DataGovernanceOperationKind::Backup,
            started_at: Utc::now(),
            process_id: std::process::id(),
        };
        let second_snapshot = DataGovernanceOperationSnapshot {
            operation_id: "second".to_string(),
            kind: DataGovernanceOperationKind::Restore,
            started_at: Utc::now(),
            process_id: std::process::id(),
        };

        let first = acquire_process_operation_lock_at(&path, &first_snapshot).unwrap();
        let error = acquire_process_operation_lock_at(&path, &second_snapshot).unwrap_err();
        assert!(error.to_string().contains("另一个客户端进程"));
        assert!(error.to_string().contains("\"operation_id\":\"first\""));

        drop(first);
        acquire_process_operation_lock_at(&path, &second_snapshot).unwrap();
    }

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

    #[test]
    fn test_strip_crypto_secrets_removes_all_sensitive_entries() {
        let backup_dir = TempDir::new().unwrap();
        std::fs::create_dir_all(backup_dir.path().join("crypto/.secure")).unwrap();
        std::fs::create_dir_all(backup_dir.path().join(".secure")).unwrap();
        std::fs::write(backup_dir.path().join("crypto/.master_key"), b"secret").unwrap();
        std::fs::write(backup_dir.path().join(".secure/credential.enc"), b"secret").unwrap();
        std::fs::write(backup_dir.path().join(".master_key"), b"secret").unwrap();
        std::fs::write(backup_dir.path().join(".key_seed"), b"secret").unwrap();
        std::fs::write(backup_dir.path().join("manifest.json"), b"{}").unwrap();

        let removed = strip_crypto_secrets_from_backup_dir(backup_dir.path()).unwrap();

        assert_eq!(removed, 4);
        for name in ["crypto", ".secure", ".master_key", ".key_seed"] {
            assert!(
                std::fs::symlink_metadata(backup_dir.path().join(name)).is_err(),
                "sensitive entry should be absent: {name}"
            );
        }
        assert!(backup_dir.path().join("manifest.json").is_file());
    }

    #[test]
    fn test_strip_crypto_secrets_fails_closed_on_removal_error() {
        let backup_dir = TempDir::new().unwrap();
        std::fs::create_dir_all(backup_dir.path().join("crypto")).unwrap();

        let result =
            strip_crypto_secrets_from_backup_dir_with(backup_dir.path(), |_path, _metadata| {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "forced removal failure",
                ))
            });

        assert!(result.is_err());
        assert!(backup_dir.path().join("crypto").is_dir());
    }

    #[test]
    fn test_strip_crypto_secrets_fails_closed_when_entry_remains() {
        let backup_dir = TempDir::new().unwrap();
        std::fs::write(backup_dir.path().join(".master_key"), b"secret").unwrap();

        let result =
            strip_crypto_secrets_from_backup_dir_with(backup_dir.path(), |_path, _metadata| Ok(()));

        assert!(result.is_err());
        assert!(backup_dir.path().join(".master_key").is_file());
    }

    #[test]
    fn test_crypto_secret_relative_path_matching_is_component_scoped() {
        for path in [
            "crypto",
            "crypto/.secure/.key_seed",
            ".secure/credential.enc",
            ".master_key",
            ".key_seed",
        ] {
            assert!(is_crypto_secret_backup_relative_path(Path::new(path)));
        }
        for path in [
            "crypto-not-secret/file.bin",
            "assets/crypto/file.bin",
            "assets/.master_key",
        ] {
            assert!(!is_crypto_secret_backup_relative_path(Path::new(path)));
        }
    }

    #[test]
    fn test_strip_crypto_secrets_matches_ascii_case_variants() {
        let backup_dir = TempDir::new().unwrap();
        std::fs::create_dir_all(backup_dir.path().join("CRYPTO")).unwrap();
        std::fs::write(backup_dir.path().join("CRYPTO/key.bin"), b"secret").unwrap();

        let removed = strip_crypto_secrets_from_backup_dir(backup_dir.path()).unwrap();

        assert_eq!(removed, 1);
        assert!(std::fs::symlink_metadata(backup_dir.path().join("CRYPTO")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn test_strip_crypto_secrets_removes_symlink_without_touching_target() {
        let backup_dir = TempDir::new().unwrap();
        let target_dir = TempDir::new().unwrap();
        std::fs::write(target_dir.path().join("keep.txt"), b"keep").unwrap();
        std::os::unix::fs::symlink(target_dir.path(), backup_dir.path().join(".secure")).unwrap();

        let removed = strip_crypto_secrets_from_backup_dir(backup_dir.path()).unwrap();

        assert_eq!(removed, 1);
        assert!(
            std::fs::symlink_metadata(backup_dir.path().join(".secure")).is_err(),
            "the sensitive symlink itself must be removed"
        );
        assert!(target_dir.path().join("keep.txt").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn test_strip_crypto_secrets_rejects_symlinked_backup_root() {
        let parent = TempDir::new().unwrap();
        let target = TempDir::new().unwrap();
        std::fs::create_dir_all(target.path().join("crypto")).unwrap();
        let linked_root = parent.path().join("linked-backup");
        std::os::unix::fs::symlink(target.path(), &linked_root).unwrap();

        let result = strip_crypto_secrets_from_backup_dir(&linked_root);

        assert!(result.is_err());
        assert!(target.path().join("crypto").is_dir());
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
