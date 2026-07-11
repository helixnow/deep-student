//! 安全存储模块 - 跨平台凭据安全存储
//!
//! 功能：
//! - **所有平台统一使用 AES-256-GCM 加密的本地文件存储**
//! - 加密密钥基于持久化随机种子（.key_seed）派生（稳定、不依赖可变设备信息）
//! - 兼容旧版设备特征派生密钥，读取时自动迁移到新密钥
//! - 加密文件存储在 app_data_dir/.secure/ 目录
//!
//! 设计原则：
//! - 不依赖系统级加密（避免 macOS Keychain 弹窗、安卓 Keystore 兼容性问题）
//! - 所有平台实现统一，减少跨平台差异
//!
//! 云存储凭据专用 API：
//! - `save_cloud_credentials` / `get_cloud_credentials` / `delete_cloud_credentials`

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};
use tauri::Manager;
use tracing::{debug, info, warn};
use zeroize::{Zeroize, Zeroizing};

/// 服务名称常量
const SERVICE_NAME: &str = "deep-student";
/// 云存储凭据键前缀
const CLOUD_STORAGE_KEY: &str = "cloud_storage_credentials";

/// 安全存储错误类型
#[derive(Debug, thiserror::Error)]
pub enum SecureStoreError {
    #[error("Keychain不可用: {0}")]
    KeychainUnavailable(String),
    #[error("密钥不存在: {0}")]
    KeyNotFound(String),
    #[error("访问被拒绝: {0}")]
    AccessDenied(String),
    #[error("平台不支持: {0}")]
    PlatformUnsupported(String),
    #[error("序列化错误: {0}")]
    SerializationError(String),
    #[error("加密错误: {0}")]
    EncryptionError(String),
    #[error("其他错误: {0}")]
    Other(String),
}

/// 安全存储配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecureStoreConfig {
    pub enabled: bool,
    pub service_name: String,
    pub fallback_to_plaintext: bool,
    pub warn_on_fallback: bool,
}

impl Default for SecureStoreConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            service_name: SERVICE_NAME.to_string(),
            fallback_to_plaintext: false,
            warn_on_fallback: true,
        }
    }
}

/// 敏感键模式
/// 🔒 P0-21 安全修复: 添加 MCP 相关敏感键模式
const SENSITIVE_KEY_PATTERNS: &[&str] = &[
    "web_search.api_key.",
    "web_search.searxng.api_key",
    "api_configs",
    "mcp.transport.",
    "mcp.tools.",   // MCP 工具配置（含 apiKey）
    "mcp.servers.", // MCP 服务器配置（含凭据）
    "siliconflow.api_key",
    "cloud_storage",
    "apiKey",   // 通用 API Key 模式
    "api_key",  // 通用 api_key 模式
    "secret",   // 通用 secret 模式
    "password", // 通用 password 模式
    "token",    // 通用 token 模式
];

/// `.key_seed` 文件的 DPAPI 封装前缀
///
/// 安全修复（审阅 16-secrets-security-infra P1-1）：明文种子与密文同目录存放时，
/// 加密强度完全依赖 best-effort 的文件 ACL。Windows 下改用 DPAPI（用户级
/// `CryptProtectData`）封装种子后落盘：即使 `.secure` 目录整体泄露（备份、
/// 网盘同步、取证镜像），缺少当前 Windows 用户上下文也无法解封种子。
/// 文件格式：`DPAPI1:` + base64(DPAPI blob)。旧版明文种子在首次读取时平滑迁移。
const DPAPI_SEED_PREFIX: &str = "DPAPI1:";

/// 备份种子文件读取上限。正常明文种子为 64 字符，DPAPI 载荷通常也只有数百字节。
const MAX_BACKUP_SEED_FILE_BYTES: u64 = 64 * 1024;
const MAX_ENCRYPTED_SECRET_FILE_BYTES: u64 = 16 * 1024 * 1024;

static MASTER_SEED_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// DPAPI 附加熵（应用绑定，防止其他同用户进程用空熵直接解封）
///
/// 注意：这是编译期常量而非秘密——同机同用户的进程理论上仍可携带此熵调用
/// DPAPI 解封（DPAPI 的保护边界是"用户上下文"），但它阻断了通用 DPAPI
/// 扫描工具的无差别解封，并把跨用户/跨机器的离线解密彻底封死。
#[cfg(windows)]
const DPAPI_SEED_ENTROPY: &[u8] = b"deep-student.key_seed.dpapi.v1";

/// Windows DPAPI 最小 FFI 绑定（crypt32）
///
/// 项目的 `windows` crate 依赖未启用 `Win32_Security_Cryptography` feature，
/// 为避免改动构建配置，这里直接声明所需的两个 API。
#[cfg(windows)]
mod win_dpapi {
    use std::ffi::c_void;
    use std::ptr;

    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    /// 禁止 DPAPI 弹出任何 UI（保持与"避免 Keychain 弹窗"的设计原则一致）
    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x01;

    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(
            p_data_in: *const DataBlob,
            sz_data_descr: *const u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *mut c_void,
            p_prompt_struct: *mut c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
        fn CryptUnprotectData(
            p_data_in: *const DataBlob,
            pp_sz_data_descr: *mut *mut u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *mut c_void,
            p_prompt_struct: *mut c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(h_mem: *mut c_void) -> *mut c_void;
    }

    fn as_blob(data: &[u8]) -> DataBlob {
        DataBlob {
            cb_data: data.len() as u32,
            // DPAPI 不会写入输入 blob，仅签名要求可变指针
            pb_data: data.as_ptr() as *mut u8,
        }
    }

    /// 用当前 Windows 用户上下文加密数据；失败返回 None
    pub fn protect(data: &[u8], entropy: &[u8]) -> Option<Vec<u8>> {
        unsafe {
            let input = as_blob(data);
            let ent = as_blob(entropy);
            let mut out = DataBlob {
                cb_data: 0,
                pb_data: ptr::null_mut(),
            };
            let ok = CryptProtectData(
                &input,
                ptr::null(),
                &ent,
                ptr::null_mut(),
                ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            );
            if ok == 0 || out.pb_data.is_null() {
                return None;
            }
            let result = std::slice::from_raw_parts(out.pb_data, out.cb_data as usize).to_vec();
            LocalFree(out.pb_data as *mut c_void);
            Some(result)
        }
    }

    /// 解封 DPAPI blob；跨用户/跨机器（或熵不匹配）时返回 None
    pub fn unprotect(data: &[u8], entropy: &[u8]) -> Option<Vec<u8>> {
        unsafe {
            let input = as_blob(data);
            let ent = as_blob(entropy);
            let mut out = DataBlob {
                cb_data: 0,
                pb_data: ptr::null_mut(),
            };
            let ok = CryptUnprotectData(
                &input,
                ptr::null_mut(),
                &ent,
                ptr::null_mut(),
                ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            );
            if ok == 0 || out.pb_data.is_null() {
                return None;
            }
            let result = std::slice::from_raw_parts(out.pb_data, out.cb_data as usize).to_vec();
            LocalFree(out.pb_data as *mut c_void);
            Some(result)
        }
    }
}

/// 安全存储服务
pub struct SecureStore {
    config: SecureStoreConfig,
    #[allow(dead_code)]
    available: bool,
    /// 安全存储目录（优先使用传入的 app_data_dir，避免安卓端路径不稳定）
    secure_dir: Option<std::path::PathBuf>,
}

impl SecureStore {
    /// 创建新的安全存储实例
    pub fn new(config: SecureStoreConfig) -> Self {
        let available = Self::check_availability();
        if available {
            info!("✅ 安全存储已启用 (平台: {})", Self::platform_name());
        } else {
            warn!("⚠️ 安全存储不可用，将使用加密文件存储");
        }
        Self {
            config,
            available,
            secure_dir: None,
        }
    }

    /// 创建带有指定存储目录的安全存储实例（推荐用于移动端）
    pub fn new_with_dir(config: SecureStoreConfig, app_data_dir: std::path::PathBuf) -> Self {
        let available = Self::check_availability();
        let secure_dir = app_data_dir.join(".secure");
        if let Err(e) = std::fs::create_dir_all(&secure_dir) {
            warn!("创建安全存储目录失败: {}", e);
        }
        info!("✅ 安全存储已启用 (目录: {:?})", secure_dir);
        Self {
            config,
            available,
            secure_dir: Some(secure_dir),
        }
    }

    /// 获取平台名称
    fn platform_name() -> &'static str {
        // 所有平台统一使用加密文件存储，避免 Keychain 弹窗
        "Encrypted File Storage"
    }

    /// 检查安全存储可用性
    fn check_availability() -> bool {
        // 所有平台使用加密文件存储，始终可用
        true
    }

    /// 检查键是否为敏感键
    pub fn is_sensitive_key(key: &str) -> bool {
        // 兼容 Vendor/API Key 的通用存储格式："{vendor_id}.api_key"
        // 例如：builtin-deepseek.api_key / custom-xxx.api_key
        // 这类键不一定以 "api_key" 开头，但依旧属于敏感数据。
        // 使用 ends_with 收紧匹配范围，避免误伤其他设置键名。
        if key.ends_with(".api_key") || key.ends_with(".apiKey") {
            return true;
        }
        SENSITIVE_KEY_PATTERNS
            .iter()
            .any(|pattern| key.starts_with(pattern))
    }

    /// 保存敏感值（使用加密文件存储）
    pub fn save_secret(&self, key: &str, value: &str) -> Result<(), SecureStoreError> {
        self.save_encrypted_file(key, value)
    }

    /// 获取敏感值（使用加密文件存储）
    pub fn get_secret(&self, key: &str) -> Result<Option<String>, SecureStoreError> {
        self.get_encrypted_file(key)
    }

    /// 删除敏感值（使用加密文件存储）
    pub fn delete_secret(&self, key: &str) -> Result<(), SecureStoreError> {
        self.delete_encrypted_file(key)
    }

    // ==================== 加密文件存储（所有平台通用） ====================

    /// 收紧文件/目录权限（Unix: 文件 0600、目录 0700；其他平台为 no-op）。
    ///
    /// `.secure` 下存放加密凭据与密钥种子 `.key_seed`（种子等价于解密钥匙），
    /// 默认 umask 创建的 0644/0755 允许同机其他用户读取。
    pub(crate) fn restrict_permissions(path: &std::path::Path, is_dir: bool) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = if is_dir { 0o700 } else { 0o600 };
            if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)) {
                warn!("设置安全存储权限失败 {:?}: {}", path, e);
            }
        }
        #[cfg(windows)]
        {
            // F8: Windows 下收紧 ACL，等价于 Unix 0600/0700——移除继承的 ACE，仅保留
            // 当前用户 + SYSTEM + Administrators（用 well-known SID 避免本地化名称问题），
            // 阻止同机其他标准用户读取 `.secure` 下的凭据/密钥种子。
            // 完全 best-effort：任何失败仅告警、不影响读写（与 Unix 分支一致）。
            Self::restrict_to_owner_windows(path, is_dir);
        }
        #[cfg(all(not(unix), not(windows)))]
        {
            let _ = (path, is_dir);
        }
    }

    /// F8: 用 `icacls` 把路径收紧为「仅 owner + SYSTEM + Administrators」。best-effort。
    #[cfg(windows)]
    fn restrict_to_owner_windows(path: &std::path::Path, is_dir: bool) {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        let user = match std::env::var("USERNAME") {
            Ok(u) if !u.trim().is_empty() => match std::env::var("USERDOMAIN") {
                Ok(d) if !d.trim().is_empty() => format!("{}\\{}", d.trim(), u.trim()),
                _ => u.trim().to_string(),
            },
            _ => {
                warn!("跳过 ACL 收紧：无法解析当前用户(USERNAME) {:?}", path);
                return;
            }
        };
        // 目录需带 (OI)(CI) 让新建子项继承；文件不需要。
        let suffix = if is_dir { "(OI)(CI)(F)" } else { "(F)" };
        let grants = [
            format!("{}:{}", user, suffix),
            format!("*S-1-5-18:{}", suffix),     // SYSTEM
            format!("*S-1-5-32-544:{}", suffix), // Administrators
        ];
        let mut cmd = Command::new("icacls");
        cmd.arg(path).arg("/inheritance:r");
        for g in &grants {
            cmd.arg("/grant:r").arg(g);
        }
        match cmd.creation_flags(0x08000000).output() {
            Ok(out) if out.status.success() => {}
            Ok(out) => warn!(
                "icacls 收紧权限未成功 {:?}: {}",
                path,
                String::from_utf8_lossy(&out.stderr).trim()
            ),
            Err(e) => warn!("无法执行 icacls 收紧权限 {:?}: {}", path, e),
        }
    }

    /// 获取安全存储目录（优先使用实例的 secure_dir，回退到静态路径）
    fn get_secure_dir(&self) -> Result<std::path::PathBuf, SecureStoreError> {
        if let Some(ref dir) = self.secure_dir {
            // 使用传入的 app_data_dir（稳定路径）
            std::fs::create_dir_all(dir)
                .map_err(|e| SecureStoreError::Other(format!("创建安全目录失败: {}", e)))?;
            Self::restrict_permissions(dir, true);
            return Ok(dir.clone());
        }
        // 回退到静态路径（桌面端兼容）
        Self::get_secure_dir_fallback()
    }

    fn get_secure_dir_fallback() -> Result<std::path::PathBuf, SecureStoreError> {
        let candidate = dirs::data_local_dir()
            .map(|d| d.join("deep-student").join(".secure"))
            .unwrap_or_else(|| std::env::temp_dir().join("deep-student").join(".secure"));

        match std::fs::create_dir_all(&candidate) {
            Ok(()) => {
                Self::restrict_permissions(&candidate, true);
                Ok(candidate)
            }
            Err(primary_err) => {
                // 在沙箱/权限受限环境下回退到临时目录，避免直接失败
                let fallback = std::env::temp_dir().join("deep-student").join(".secure");
                std::fs::create_dir_all(&fallback).map_err(|fallback_err| {
                    SecureStoreError::Other(format!(
                        "创建安全目录失败: primary={}, fallback={}",
                        primary_err, fallback_err
                    ))
                })?;
                Self::restrict_permissions(&fallback, true);
                Ok(fallback)
            }
        }
    }

    /// 获取或创建主密钥种子（稳定存储在 .key_seed）
    ///
    /// Windows 下种子经 DPAPI 封装后落盘（见 `DPAPI_SEED_PREFIX` 注释）；
    /// 历史明文种子在首次读取时自动迁移为封装格式（迁移失败不影响读取）。
    /// 其余平台维持原有明文 + 权限收紧策略。
    fn get_or_create_master_seed(&self) -> Result<String, SecureStoreError> {
        let _guard = MASTER_SEED_LOCK
            .lock()
            .map_err(|_| SecureStoreError::Other("密钥种子锁已损坏".to_string()))?;
        let secure_dir = self.get_secure_dir()?;
        let seed_file = secure_dir.join(".key_seed");

        match std::fs::symlink_metadata(&seed_file) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(SecureStoreError::AccessDenied(
                        "密钥种子必须是普通文件，不能是目录或符号链接".to_string(),
                    ));
                }
                if metadata.len() > MAX_BACKUP_SEED_FILE_BYTES {
                    return Err(SecureStoreError::EncryptionError(format!(
                        "密钥种子文件异常过大: {} bytes",
                        metadata.len()
                    )));
                }
                let mut seed = Zeroizing::new(String::new());
                use std::io::Read;
                std::fs::File::open(&seed_file)
                    .map_err(|e| SecureStoreError::Other(format!("打开密钥种子失败: {}", e)))?
                    .take(MAX_BACKUP_SEED_FILE_BYTES + 1)
                    .read_to_string(&mut seed)
                    .map_err(|e| SecureStoreError::Other(format!("读取密钥种子失败: {}", e)))?;
                if seed.len() as u64 > MAX_BACKUP_SEED_FILE_BYTES {
                    return Err(SecureStoreError::EncryptionError(
                        "密钥种子读取大小超限".to_string(),
                    ));
                }
                let trimmed = seed.trim();
                if trimmed.is_empty() {
                    return Err(SecureStoreError::EncryptionError(
                        "密钥种子为空，拒绝生成新种子覆盖".to_string(),
                    ));
                }
                #[cfg(windows)]
                {
                    if let Some(encoded) = trimmed.strip_prefix(DPAPI_SEED_PREFIX) {
                        return Self::unwrap_dpapi_seed(encoded);
                    }
                    // 旧版明文种子：平滑迁移为 DPAPI 封装（失败仅告警，不影响使用）
                    let plain_seed = trimmed.to_string();
                    if let Err(e) = Self::write_seed_file(&seed_file, &plain_seed) {
                        warn!("迁移明文密钥种子到 DPAPI 封装失败（继续使用明文）: {}", e);
                    } else {
                        info!("已将明文密钥种子迁移为 DPAPI 封装存储");
                    }
                    return Ok(plain_seed);
                }
                #[cfg(not(windows))]
                {
                    return Ok(trimmed.to_string());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(SecureStoreError::Other(format!(
                    "检查密钥种子失败，拒绝覆盖: {}",
                    e
                )))
            }
        }

        use rand::{rngs::OsRng, RngCore};
        let mut seed_bytes = [0u8; 32];
        OsRng.fill_bytes(&mut seed_bytes);
        let seed = hex::encode(seed_bytes);
        seed_bytes.zeroize();
        Self::write_seed_file(&seed_file, &seed)?;
        Ok(seed)
    }

    fn atomic_write_secure_file(
        path: &std::path::Path,
        data: &[u8],
    ) -> Result<(), SecureStoreError> {
        let parent = path
            .parent()
            .ok_or_else(|| SecureStoreError::Other("安全存储路径缺少父目录".to_string()))?;
        std::fs::create_dir_all(parent)
            .map_err(|e| SecureStoreError::Other(format!("创建安全存储目录失败: {}", e)))?;
        let mut temp = tempfile::NamedTempFile::new_in(parent)
            .map_err(|e| SecureStoreError::Other(format!("创建安全存储临时文件失败: {}", e)))?;
        use std::io::Write;
        temp.write_all(data)
            .map_err(|e| SecureStoreError::Other(format!("写入安全存储临时文件失败: {}", e)))?;
        temp.as_file()
            .sync_all()
            .map_err(|e| SecureStoreError::Other(format!("同步安全存储临时文件失败: {}", e)))?;
        Self::restrict_permissions(temp.path(), false);
        temp.persist(path)
            .map_err(|e| SecureStoreError::Other(format!("提交安全存储文件失败: {}", e.error)))?;
        Self::restrict_permissions(path, false);
        Ok(())
    }

    /// 将种子写入 `.key_seed`：Windows 优先 DPAPI 封装，封装失败时回退明文
    /// （回退时保留权限收紧，并输出显著告警）；其余平台明文 + 权限收紧。
    fn write_seed_file(seed_file: &std::path::Path, seed: &str) -> Result<(), SecureStoreError> {
        #[cfg(windows)]
        {
            use base64::Engine;
            let wrapped = Zeroizing::new(
                win_dpapi::protect(seed.as_bytes(), DPAPI_SEED_ENTROPY).ok_or_else(|| {
                    SecureStoreError::EncryptionError(
                        "DPAPI 封装密钥种子失败，拒绝明文降级".to_string(),
                    )
                })?,
            );
            let encoded = Zeroizing::new(format!(
                "{}{}",
                DPAPI_SEED_PREFIX,
                base64::engine::general_purpose::STANDARD.encode(wrapped.as_slice())
            ));
            return Self::atomic_write_secure_file(seed_file, encoded.as_bytes());
        }
        #[cfg(not(windows))]
        {
            Self::atomic_write_secure_file(seed_file, seed.as_bytes())
        }
    }

    /// 验证备份中的 `.key_seed` 能否在当前平台安全恢复。
    ///
    /// 明文种子可跨平台复制；DPAPI 种子只允许在 Windows 上、且必须能由当前
    /// 用户/机器上下文成功解封。该检查不修改源文件或当前安全存储。
    pub(crate) fn validate_backup_seed_file(
        seed_file: &std::path::Path,
    ) -> Result<(), SecureStoreError> {
        let metadata = std::fs::symlink_metadata(seed_file)
            .map_err(|e| SecureStoreError::Other(format!("读取备份密钥种子元数据失败: {}", e)))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(SecureStoreError::AccessDenied(
                "备份密钥种子必须是普通文件，不能是目录或符号链接".to_string(),
            ));
        }
        if metadata.len() > MAX_BACKUP_SEED_FILE_BYTES {
            return Err(SecureStoreError::EncryptionError(format!(
                "备份密钥种子文件异常过大: {} bytes（上限 {} bytes）",
                metadata.len(),
                MAX_BACKUP_SEED_FILE_BYTES
            )));
        }

        use std::io::Read;
        let file = std::fs::File::open(seed_file)
            .map_err(|e| SecureStoreError::Other(format!("打开备份密钥种子失败: {}", e)))?;
        let opened_metadata = file
            .metadata()
            .map_err(|e| SecureStoreError::Other(format!("读取已打开种子元数据失败: {}", e)))?;
        if !opened_metadata.is_file() || opened_metadata.len() > MAX_BACKUP_SEED_FILE_BYTES {
            return Err(SecureStoreError::EncryptionError(
                "备份密钥种子在验证期间发生异常变化".to_string(),
            ));
        }
        let mut seed = String::new();
        let bytes_read = match file
            .take(MAX_BACKUP_SEED_FILE_BYTES + 1)
            .read_to_string(&mut seed)
        {
            Ok(bytes_read) => bytes_read,
            Err(e) => {
                seed.zeroize();
                return Err(SecureStoreError::Other(format!(
                    "读取备份密钥种子失败: {}",
                    e
                )));
            }
        };
        if bytes_read as u64 > MAX_BACKUP_SEED_FILE_BYTES {
            seed.zeroize();
            return Err(SecureStoreError::EncryptionError(
                "备份密钥种子在读取期间超过大小上限".to_string(),
            ));
        }
        if seed.trim().is_empty() {
            seed.zeroize();
            return Err(SecureStoreError::EncryptionError(
                "备份密钥种子为空".to_string(),
            ));
        }

        let encoded = seed
            .trim()
            .strip_prefix(DPAPI_SEED_PREFIX)
            .map(|value| Zeroizing::new(value.to_owned()));
        if let Some(encoded) = encoded {
            seed.zeroize();
            #[cfg(windows)]
            {
                let plain_seed = Zeroizing::new(Self::unwrap_dpapi_seed(&encoded)?);
                if plain_seed.trim().is_empty() {
                    return Err(SecureStoreError::EncryptionError(
                        "DPAPI 解封后的备份密钥种子为空".to_string(),
                    ));
                }
                return Ok(());
            }
            #[cfg(not(windows))]
            {
                let _ = encoded;
                return Err(SecureStoreError::PlatformUnsupported(
                    "DPAPI 密钥种子只能在可解封它的 Windows 用户/机器上恢复".to_string(),
                ));
            }
        }

        seed.zeroize();
        Ok(())
    }

    /// 解封 DPAPI 封装的种子（`DPAPI1:` 之后的 base64 载荷）
    #[cfg(windows)]
    fn unwrap_dpapi_seed(encoded: &str) -> Result<String, SecureStoreError> {
        use base64::Engine;
        let wrapped = Zeroizing::new(
            base64::engine::general_purpose::STANDARD
                .decode(encoded.trim())
                .map_err(|e| {
                    SecureStoreError::EncryptionError(format!("密钥种子 DPAPI 载荷解码失败: {}", e))
                })?,
        );
        let plain = Zeroizing::new(
            win_dpapi::unprotect(&wrapped, DPAPI_SEED_ENTROPY).ok_or_else(|| {
                SecureStoreError::EncryptionError(
                    "DPAPI 解封密钥种子失败：种子与当前 Windows 用户/机器绑定，跨设备复制的种子无法解密"
                        .to_string(),
                )
            })?,
        );
        let seed = std::str::from_utf8(&plain)
            .map_err(|e| SecureStoreError::Other(format!("密钥种子 UTF-8 解码失败: {}", e)))?;
        Ok(seed.trim().to_string())
    }

    fn derive_key(seed: &str, salt: &[u8]) -> [u8; 32] {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(seed.as_bytes());
        hasher.update(salt);
        let result = hasher.finalize();
        let mut key = [0u8; 32];
        key.copy_from_slice(&result);
        key
    }

    /// 当前版本密钥：基于稳定随机种子派生，避免设备信息变化导致凭据不可解密
    fn get_device_key(&self) -> Result<[u8; 32], SecureStoreError> {
        let mut seed = self.get_or_create_master_seed()?;
        let key = Self::derive_key(&seed, b"deep-student-secure-salt-v3");
        seed.zeroize();
        Ok(key)
    }

    /// 兼容旧版本（v2）密钥派生逻辑，用于无损迁移历史加密文件
    fn get_legacy_device_key(&self) -> [u8; 32] {
        use sha2::{Digest, Sha256};

        let mut device_info = String::new();

        if let Ok(android_id) = std::env::var("ANDROID_ID") {
            device_info.push_str(&android_id);
        }
        if let Some(home) = dirs::home_dir() {
            device_info.push_str(&home.to_string_lossy());
        }
        if let Some(data_dir) = dirs::data_local_dir() {
            device_info.push_str(&data_dir.to_string_lossy());
        }
        if let Ok(hostname) = hostname::get() {
            device_info.push_str(&hostname.to_string_lossy());
        }
        if let Ok(user) = std::env::var("USER").or_else(|_| std::env::var("USERNAME")) {
            device_info.push_str(&user);
        }

        if device_info.is_empty() {
            if let Ok(seed) = self.get_or_create_master_seed() {
                device_info = seed;
            }
        }

        let mut hasher = Sha256::new();
        hasher.update(device_info.as_bytes());
        hasher.update(b"deep-student-secure-salt-v2");
        device_info.zeroize();
        let result = hasher.finalize();
        let mut key = [0u8; 32];
        key.copy_from_slice(&result);
        key
    }

    fn encrypt_with_key(key: &[u8; 32], value: &str) -> Result<Vec<u8>, SecureStoreError> {
        use aes_gcm::aead::{Aead, KeyInit};
        use aes_gcm::{Aes256Gcm, Key, Nonce};
        use rand::{rngs::OsRng, RngCore};

        let encryption_key = Key::<Aes256Gcm>::from_slice(key);
        let cipher = Aes256Gcm::new(encryption_key);

        let mut nonce_bytes = [0u8; 12];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        let ciphertext = cipher
            .encrypt(nonce, value.as_bytes())
            .map_err(|e| SecureStoreError::EncryptionError(e.to_string()))?;

        let mut data = nonce_bytes.to_vec();
        data.extend(ciphertext);
        Ok(data)
    }

    fn decrypt_with_key(key: &[u8; 32], data: &[u8]) -> Result<String, SecureStoreError> {
        use aes_gcm::aead::{Aead, KeyInit};
        use aes_gcm::{Aes256Gcm, Key, Nonce};

        if data.len() < 12 {
            return Err(SecureStoreError::EncryptionError(
                "数据格式无效".to_string(),
            ));
        }

        let encryption_key = Key::<Aes256Gcm>::from_slice(key);
        let cipher = Aes256Gcm::new(encryption_key);

        let nonce = Nonce::from_slice(&data[..12]);
        let ciphertext = &data[12..];

        let plaintext = cipher
            .decrypt(nonce, ciphertext)
            .map_err(|e| SecureStoreError::EncryptionError(e.to_string()))?;

        String::from_utf8(plaintext)
            .map_err(|e| SecureStoreError::Other(format!("UTF-8 解码失败: {}", e)))
    }

    fn save_encrypted_file(&self, key: &str, value: &str) -> Result<(), SecureStoreError> {
        let secure_dir = self.get_secure_dir()?;
        let file_path = secure_dir.join(format!("{}.enc", key.replace(['/', '\\'], "_")));

        let mut device_key = self.get_device_key()?;
        let result = Self::encrypt_with_key(&device_key, value);
        device_key.zeroize();
        let data = Zeroizing::new(result?);

        Self::atomic_write_secure_file(&file_path, &data)?;

        debug!("✅ 凭据已加密存储: {}", key);
        Ok(())
    }

    fn get_encrypted_file(&self, key: &str) -> Result<Option<String>, SecureStoreError> {
        let secure_dir = self.get_secure_dir()?;
        let file_path = secure_dir.join(format!("{}.enc", key.replace(['/', '\\'], "_")));

        let metadata = match std::fs::symlink_metadata(&file_path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Ok(metadata) => metadata,
            Err(e) => {
                return Err(SecureStoreError::Other(format!(
                    "检查加密凭据文件失败: {}",
                    e
                )))
            }
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(SecureStoreError::AccessDenied(
                "加密凭据路径必须是普通文件，不能是目录或符号链接".to_string(),
            ));
        }
        if metadata.len() > MAX_ENCRYPTED_SECRET_FILE_BYTES {
            return Err(SecureStoreError::EncryptionError(format!(
                "加密凭据文件过大: {} bytes",
                metadata.len()
            )));
        }
        use std::io::Read;
        let mut data = Zeroizing::new(Vec::with_capacity(metadata.len() as usize));
        std::fs::File::open(&file_path)
            .map_err(|e| SecureStoreError::Other(format!("打开加密凭据文件失败: {}", e)))?
            .take(MAX_ENCRYPTED_SECRET_FILE_BYTES + 1)
            .read_to_end(&mut data)
            .map_err(|e| SecureStoreError::Other(format!("读取加密凭据文件失败: {}", e)))?;
        if data.len() as u64 > MAX_ENCRYPTED_SECRET_FILE_BYTES {
            return Err(SecureStoreError::EncryptionError(
                "加密凭据实际读取大小超限".to_string(),
            ));
        }

        let mut device_key = self.get_device_key()?;
        let result = Self::decrypt_with_key(&device_key, &data);
        device_key.zeroize();
        match result {
            Ok(plaintext) => Ok(Some(plaintext)),
            Err(primary_err) => {
                let mut legacy_key = self.get_legacy_device_key();
                let legacy_result = Self::decrypt_with_key(&legacy_key, &data);
                legacy_key.zeroize();
                match legacy_result {
                    Ok(legacy_plaintext) => {
                        warn!("检测到 legacy 加密格式，正在迁移到稳定主密钥: {}", key);
                        if let Err(e) = self.save_encrypted_file(key, &legacy_plaintext) {
                            warn!("迁移凭据到新密钥失败: {}", e);
                        }
                        Ok(Some(legacy_plaintext))
                    }
                    Err(_) => Err(primary_err),
                }
            }
        }
    }

    fn delete_encrypted_file(&self, key: &str) -> Result<(), SecureStoreError> {
        // Deletion must not create the directory or silently repair its permissions.
        // Doing so can turn an externally read-only credential store writable and
        // hide a failed clear operation from the caller.
        let secure_dir = if let Some(dir) = self.secure_dir.as_ref() {
            dir.clone()
        } else {
            dirs::data_local_dir()
                .map(|dir| dir.join("deep-student").join(".secure"))
                .unwrap_or_else(|| std::env::temp_dir().join("deep-student").join(".secure"))
        };
        let file_path = secure_dir.join(format!("{}.enc", key.replace(['/', '\\'], "_")));

        match std::fs::remove_file(&file_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(SecureStoreError::Other(format!("删除文件失败: {}", error)));
            }
        }
        debug!("✅ 凭据已删除: {}", key);
        Ok(())
    }

    /// 获取所有敏感键
    ///
    /// ★ F9：此前恒返回空集（注释停留在 keyring 时代）。迁移到文件存储后凭据以
    /// `{key.replace('/', "_")}.enc` 落在 secure_dir，恒空会让“清理所有凭据”类逻辑漏删。
    /// 改为扫描 secure_dir 下的 `*.enc` 文件名（不含扩展名）。注意：保存时 `/` 被替换为 `_`，
    /// 文件名无法无损还原原始 key；返回的是与 save/get/delete 同一替换规则下的消毒键名，
    /// 按此键名调用 delete 可正确命中（再替换为自身）。
    pub fn list_sensitive_keys(&self) -> Result<HashSet<String>, SecureStoreError> {
        let secure_dir = match self.get_secure_dir() {
            Ok(d) => d,
            Err(_) => return Ok(HashSet::new()),
        };
        let mut keys = HashSet::new();
        if let Ok(entries) = std::fs::read_dir(&secure_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("enc") {
                    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                        keys.insert(stem.to_string());
                    }
                }
            }
        }
        Ok(keys)
    }

    /// 检查安全存储可用性
    pub fn is_available(&self) -> bool {
        Self::check_availability()
    }

    /// 获取配置
    pub fn get_config(&self) -> &SecureStoreConfig {
        &self.config
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn stable_seed_is_persisted() {
        let dir = TempDir::new().expect("create tempdir");
        let store =
            SecureStore::new_with_dir(SecureStoreConfig::default(), dir.path().to_path_buf());

        let first = store.get_device_key().expect("first device key");
        let second = store.get_device_key().expect("second device key");

        assert_eq!(first, second);
    }

    #[test]
    fn plaintext_backup_seed_is_portable() {
        let dir = TempDir::new().expect("create tempdir");
        let seed_file = dir.path().join(".key_seed");
        std::fs::write(&seed_file, "aa".repeat(32)).expect("write seed");

        SecureStore::validate_backup_seed_file(&seed_file)
            .expect("plaintext backup seed should be portable");
    }

    #[test]
    fn oversized_backup_seed_is_rejected_before_reading() {
        let dir = TempDir::new().expect("create tempdir");
        let seed_file = dir.path().join(".key_seed");
        let file = std::fs::File::create(&seed_file).expect("create seed");
        file.set_len(MAX_BACKUP_SEED_FILE_BYTES + 1)
            .expect("extend seed");

        let error = SecureStore::validate_backup_seed_file(&seed_file)
            .expect_err("oversized backup seed must be rejected");
        assert!(matches!(error, SecureStoreError::EncryptionError(_)));
    }

    #[test]
    fn empty_existing_seed_fails_closed_without_replacement() {
        let dir = TempDir::new().expect("create tempdir");
        let store =
            SecureStore::new_with_dir(SecureStoreConfig::default(), dir.path().to_path_buf());
        let seed_file = dir.path().join(".secure/.key_seed");
        std::fs::write(&seed_file, b"").expect("write empty seed");

        let error = store
            .save_secret("empty-seed-test", "must-not-be-written")
            .expect_err("empty seed must not be silently replaced");

        assert!(matches!(error, SecureStoreError::EncryptionError(_)));
        assert_eq!(std::fs::read(&seed_file).unwrap(), b"");
        assert!(!dir.path().join(".secure/empty-seed-test.enc").exists());
    }

    #[test]
    fn oversized_encrypted_secret_is_rejected_before_allocation() {
        let dir = TempDir::new().expect("create tempdir");
        let store =
            SecureStore::new_with_dir(SecureStoreConfig::default(), dir.path().to_path_buf());
        let secret_file = dir.path().join(".secure/oversized.enc");
        let file = std::fs::File::create(&secret_file).expect("create oversized secret");
        file.set_len(MAX_ENCRYPTED_SECRET_FILE_BYTES + 1)
            .expect("extend oversized secret");

        let error = store
            .get_secret("oversized")
            .expect_err("oversized encrypted file must fail closed");
        assert!(matches!(error, SecureStoreError::EncryptionError(_)));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_backup_seed_is_rejected() {
        let dir = TempDir::new().expect("create tempdir");
        let external = TempDir::new().expect("create external tempdir");
        let target = external.path().join("seed");
        std::fs::write(&target, "aa".repeat(32)).expect("write external seed");
        let seed_file = dir.path().join(".key_seed");
        std::os::unix::fs::symlink(&target, &seed_file).expect("create seed symlink");

        let error = SecureStore::validate_backup_seed_file(&seed_file)
            .expect_err("symlinked seed must be rejected");
        assert!(matches!(error, SecureStoreError::AccessDenied(_)));
    }

    #[cfg(not(windows))]
    #[test]
    fn dpapi_wrapped_backup_seed_is_rejected_off_windows() {
        let dir = TempDir::new().expect("create tempdir");
        let seed_file = dir.path().join(".key_seed");
        std::fs::write(&seed_file, "DPAPI1:Zm9yZWlnbi1ibG9i").expect("write wrapped seed");

        let error = SecureStore::validate_backup_seed_file(&seed_file)
            .expect_err("DPAPI seed must not be treated as plaintext off Windows");
        assert!(matches!(error, SecureStoreError::PlatformUnsupported(_)));
    }

    /// Windows：明文 `.key_seed` 首次读取应平滑迁移为 DPAPI 封装且种子不变
    #[cfg(windows)]
    #[test]
    fn plaintext_seed_migrates_to_dpapi_wrapping() {
        let dir = TempDir::new().expect("create tempdir");
        let store =
            SecureStore::new_with_dir(SecureStoreConfig::default(), dir.path().to_path_buf());

        let secure_dir = store.get_secure_dir().expect("secure dir");
        let seed_file = secure_dir.join(".key_seed");
        let legacy_seed = "aa".repeat(32); // 模拟旧版 64 字符 hex 明文种子
        std::fs::write(&seed_file, &legacy_seed).expect("write plaintext seed");

        // 首次读取：返回原种子并触发迁移
        let seed = store.get_or_create_master_seed().expect("read seed");
        assert_eq!(seed, legacy_seed, "迁移不应改变种子内容");

        let on_disk = std::fs::read_to_string(&seed_file).expect("read seed file");
        assert!(
            on_disk.starts_with(DPAPI_SEED_PREFIX),
            "落盘内容应为 DPAPI 封装格式，实际: {}",
            &on_disk[..on_disk.len().min(16)]
        );
        assert!(
            !on_disk.contains(&legacy_seed),
            "落盘内容不应再包含明文种子"
        );
        SecureStore::validate_backup_seed_file(&seed_file)
            .expect("当前 Windows 上生成的 DPAPI 种子应可用于恢复");

        // 再次读取：走 DPAPI 解封路径，种子一致
        let seed_again = store.get_or_create_master_seed().expect("read seed again");
        assert_eq!(seed_again, legacy_seed, "DPAPI 解封后种子应一致");

        // 派生密钥稳定
        assert_eq!(
            store.get_device_key().expect("first device key"),
            store.get_device_key().expect("second device key")
        );
    }

    #[test]
    fn can_read_legacy_ciphertext_and_migrate() {
        let dir = TempDir::new().expect("create tempdir");
        let store =
            SecureStore::new_with_dir(SecureStoreConfig::default(), dir.path().to_path_buf());

        let secure_dir = store.get_secure_dir().expect("secure dir");
        let file_path = secure_dir.join("legacy_test.enc");

        let legacy_key = store.get_legacy_device_key();
        let encrypted =
            SecureStore::encrypt_with_key(&legacy_key, "legacy-value").expect("encrypt legacy");
        std::fs::write(&file_path, encrypted).expect("write legacy file");

        let value = store
            .get_encrypted_file("legacy_test")
            .expect("read legacy");
        assert_eq!(value.as_deref(), Some("legacy-value"));

        // 再次读取应直接使用当前密钥成功（已迁移）
        let value_after_migrate = store
            .get_encrypted_file("legacy_test")
            .expect("read migrated");
        assert_eq!(value_after_migrate.as_deref(), Some("legacy-value"));
    }
}

// ==================== 云存储凭据专用 API ====================

/// 云存储凭据（仅包含敏感信息）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudStorageCredentials {
    /// WebDAV 密码
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webdav_password: Option<String>,
    /// S3 Secret Access Key
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub s3_secret_access_key: Option<String>,
    /// [P0-4/O2] FTP 密码
    ///
    /// 此前结构体缺少该字段，前端 `ftpPassword` 经 serde 被静默丢弃，导致 FTP
    /// 密码永远进不了安全存储（只能裸存 localStorage）。补齐该字段打通链路。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ftp_password: Option<String>,
    /// 端到端加密密码（备份 ZIP 上传前用的）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encryption_password: Option<String>,
}

impl SecureStore {
    /// 保存云存储凭据
    pub fn save_cloud_credentials(
        &self,
        credentials: &CloudStorageCredentials,
    ) -> Result<(), SecureStoreError> {
        let json = serde_json::to_string(credentials)
            .map_err(|e| SecureStoreError::SerializationError(e.to_string()))?;
        self.save_secret(CLOUD_STORAGE_KEY, &json)
    }

    /// 获取云存储凭据
    pub fn get_cloud_credentials(
        &self,
    ) -> Result<Option<CloudStorageCredentials>, SecureStoreError> {
        match self.get_secret(CLOUD_STORAGE_KEY)? {
            Some(json) => {
                let credentials: CloudStorageCredentials = serde_json::from_str(&json)
                    .map_err(|e| SecureStoreError::SerializationError(e.to_string()))?;
                Ok(Some(credentials))
            }
            None => Ok(None),
        }
    }

    /// 删除云存储凭据
    pub fn delete_cloud_credentials(&self) -> Result<(), SecureStoreError> {
        self.delete_secret(CLOUD_STORAGE_KEY)
    }
}

// ==================== Tauri 命令 ====================

use crate::models::AppError;

/// 全局安全存储实例
fn get_secure_store(app: Option<&tauri::AppHandle>) -> SecureStore {
    let config = SecureStoreConfig::default();
    if let Some(app) = app {
        if let Ok(app_data_dir) = app.path().app_data_dir() {
            return SecureStore::new_with_dir(config, app_data_dir);
        }
    }
    SecureStore::new(config)
}

/// 保存云存储凭据到安全存储
#[tauri::command]
pub fn secure_save_cloud_credentials(
    app: tauri::AppHandle,
    credentials: CloudStorageCredentials,
) -> Result<(), AppError> {
    let store = get_secure_store(Some(&app));
    store
        .save_cloud_credentials(&credentials)
        .map_err(|e| AppError::internal(format!("保存凭据失败: {}", e)))
}

/// 获取云存储凭据
#[tauri::command]
pub fn secure_get_cloud_credentials(
    app: tauri::AppHandle,
) -> Result<Option<CloudStorageCredentials>, AppError> {
    let store = get_secure_store(Some(&app));
    store
        .get_cloud_credentials()
        .map_err(|e| AppError::internal(format!("获取凭据失败: {}", e)))
}

/// 删除云存储凭据
#[tauri::command]
pub fn secure_delete_cloud_credentials(app: tauri::AppHandle) -> Result<(), AppError> {
    let store = get_secure_store(Some(&app));
    store
        .delete_cloud_credentials()
        .map_err(|e| AppError::internal(format!("删除凭据失败: {}", e)))
}

/// 检查安全存储是否可用
#[tauri::command]
pub fn secure_store_is_available(app: tauri::AppHandle) -> bool {
    let store = get_secure_store(Some(&app));
    store.is_available()
}

// ==================== 凭据后端自取（hydrate） ====================

/// 用安全存储中的凭据补全 `CloudStorageConfig` 中留空的敏感字段。
///
/// [P0-3A] 前端的常规调用路径（同步、冲突检测、状态查询等）不再携带明文
/// 凭据——密码字段传空串，由各 Tauri 命令在入口处调用本函数从安全存储补全。
/// 这样明文凭据只在用户首次录入时经过一次 IPC，之后不再往返于前端。
///
/// 规则：
/// - 仅补全**空白**字段；调用方显式传入的非空值（如设置页"测试连接"时
///   用户刚输入的新密码）原样保留，优先级高于安全存储；
/// - `encryption_password`：安全存储中存有非空值即视为"已启用端到端加密"
///   并补全。用户在设置页清空加密密码时，保存流程会把它从安全存储删除，
///   因此不会出现"已关闭加密却被误补全"的情况。
pub fn hydrate_cloud_config(
    app: &tauri::AppHandle,
    config: &mut crate::cloud_storage::CloudStorageConfig,
) {
    let needs_webdav = config
        .webdav
        .as_ref()
        .is_some_and(|w| w.password.trim().is_empty());
    let needs_s3 = config
        .s3
        .as_ref()
        .is_some_and(|s| s.secret_access_key.trim().is_empty());
    let needs_ftp = config
        .ftp
        .as_ref()
        .is_some_and(|f| f.password.trim().is_empty());
    let needs_encryption = config
        .encryption_password
        .as_deref()
        .map(|p| p.trim().is_empty())
        .unwrap_or(true);

    if !(needs_webdav || needs_s3 || needs_ftp || needs_encryption) {
        return;
    }

    let store = get_secure_store(Some(app));
    let credentials = match store.get_cloud_credentials() {
        Ok(Some(c)) => c,
        Ok(None) => return,
        Err(e) => {
            warn!("读取云存储凭据失败（跳过补全）: {}", e);
            return;
        }
    };

    if needs_webdav {
        if let (Some(webdav), Some(password)) =
            (config.webdav.as_mut(), credentials.webdav_password.as_ref())
        {
            if !password.trim().is_empty() {
                webdav.password = password.clone();
            }
        }
    }
    if needs_s3 {
        if let (Some(s3), Some(secret)) = (
            config.s3.as_mut(),
            credentials.s3_secret_access_key.as_ref(),
        ) {
            if !secret.trim().is_empty() {
                s3.secret_access_key = secret.clone();
            }
        }
    }
    if needs_ftp {
        if let (Some(ftp), Some(password)) =
            (config.ftp.as_mut(), credentials.ftp_password.as_ref())
        {
            if !password.trim().is_empty() {
                ftp.password = password.clone();
            }
        }
    }
    if needs_encryption {
        if let Some(password) = credentials
            .encryption_password
            .as_ref()
            .filter(|p| !p.trim().is_empty())
        {
            config.encryption_password = Some(password.clone());
        }
    }
}
