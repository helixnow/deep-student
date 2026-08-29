//! 安全存储模块 - 跨平台凭据安全存储
//!
//! 功能：
//! - **所有平台统一使用 AES-256-GCM 加密的本地文件存储**
//! - 加密密钥基于持久化随机种子（.key_seed）派生（稳定、不依赖可变设备信息）
//! - 兼容旧版设备特征派生密钥，读取时自动迁移到新密钥
//! - 加密文件存储在 app_data_dir/.secure/ 目录
//!
//! 根种子（.key_seed）的平台保护（TD-08，修订）：
//! - **Windows**：DPAPI（用户级 `CryptProtectData`）封装后落盘，无 UI
//! - **macOS/Linux**：平台密钥库（Keychain / Secret Service）为 **opt-in**，
//!   默认关闭——密钥库访问会触发系统授权弹窗（开发构建每次重编译签名变化，
//!   弹窗反复出现），且弹窗未处理时会同步阻塞所有凭据读写。只有用户在设置里
//!   显式开启（`.keystore_opt_in` 标记）后才迁入密钥库，磁盘只留
//!   `KEYSTORE1:<指纹>` 引用标记；关闭开关（默认态）时曾迁入的种子会自动
//!   回迁为权限收紧的本地种子文件
//! - **Android/iOS**：维持加密文件方案（keyring 依赖不参与移动端编译）
//! - 所有路径 fail-closed：密钥库不可达时**绝不**静默生成新种子覆盖旧密文
//!
//! 云存储凭据专用 API：
//! - `save_cloud_credentials` / `get_cloud_credentials` / `delete_cloud_credentials`
//! - staged generation 原子发布（R2）：`write_staged_cloud_credentials` /
//!   `commit_staged_cloud_credentials` / `abort_staged_cloud_credentials` /
//!   `cloud_credentials_active_generation` / `delete_cloud_credentials_transactional`

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
/// staged 槽（R2 原子发布）：独立 secret 记录，内容为
/// `StagedCloudCredentials`（目标 generation + 合并后的完整凭据）。
/// 写 staged 绝不触碰 active 记录（`CLOUD_STORAGE_KEY`）与 generation pointer。
const CLOUD_STORAGE_STAGED_KEY: &str = "cloud_storage_credentials_staged";
/// active generation pointer（R2）：十进制 u64 字符串。
/// **缺失 = 0**：老用户只有未版本化的 active 记录，语义即「generation 0 已 active」，
/// 读路径（`get_cloud_credentials` / hydrate）不感知该键，行为与历史版本完全一致。
const CLOUD_STORAGE_GENERATION_KEY: &str = "cloud_storage_credentials_generation";

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
    /// 云端 E2EE 密码短于最小 Unicode 码点数；不是密钥库故障。
    #[error("{0}")]
    CloudEncryptionPasswordTooShort(String),
    /// [Wave2-R5] 云端 E2EE **新设**密码命中弱口令黑名单或熵下限；不是密钥库
    /// 故障。只在新设入口触发——`encryption_password_is_preexisting = true`
    /// 的存量口令入口完全不经过弱口令检查（与短口令放行同一取向）。
    #[error("{0}")]
    CloudEncryptionPasswordTooWeak(String),
    /// staged generation 与调用方期望不一致（并发提交 / 过期句柄）。
    /// 不是 IO 故障：重读 active generation 后重新 stage 即可恢复。
    #[error("{0}")]
    CloudCredentialGenerationConflict(String),
}

impl SecureStoreError {
    /// IPC 稳定错误码；前端只按 code 分派，绝不匹配本地化 Display 文案。
    fn stable_code(&self) -> &'static str {
        match self {
            Self::KeychainUnavailable(_) | Self::PlatformUnsupported(_) => {
                "SECURE_STORE_UNAVAILABLE"
            }
            Self::KeyNotFound(_) => "SECURE_STORE_KEY_NOT_FOUND",
            Self::AccessDenied(_) => "SECURE_STORE_ACCESS_DENIED",
            Self::SerializationError(_) => "SECURE_STORE_DATA_INVALID",
            Self::EncryptionError(_) => "SECURE_STORE_CRYPTO_ERROR",
            Self::CloudEncryptionPasswordTooShort(_) => CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE,
            Self::CloudEncryptionPasswordTooWeak(_) => CLOUD_ENCRYPTION_PASSWORD_TOO_WEAK_CODE,
            Self::CloudCredentialGenerationConflict(_) => {
                CLOUD_CREDENTIALS_GENERATION_CONFLICT_CODE
            }
            Self::Other(_) => "SECURE_STORE_INTERNAL",
        }
    }

    fn to_command_error(&self, operation: &'static str) -> crate::error_details::CommandError {
        crate::error_details::CommandError::new(self.stable_code(), self.to_string()).with_data(
            serde_json::json!({
                "operation": operation,
                "retryable": matches!(
                    self,
                    Self::KeychainUnavailable(_)
                        | Self::AccessDenied(_)
                        | Self::PlatformUnsupported(_)
                ),
            }),
        )
    }
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
    "internal.oauth.", // 后端专用 OAuth 会话，严禁落入明文设置
    "web_search.api_key.",
    "web_search.searxng.api_key",
    "api_configs",
    "mcp.transport.",
    "mcp.tools.",   // MCP 工具配置（含 apiKey）
    "mcp.servers.", // MCP 服务器配置（含凭据）
    "siliconflow.api_key",
    "cloud_storage",
    "apiKey",                      // 通用 API Key 模式
    "api_key",                     // 通用 api_key 模式
    "secret",                      // 通用 secret 模式
    "password",                    // 通用 password 模式
    "token",                       // 通用 token 模式
    "plugin.ilinkbot.credentials", // iLink Bot 凭证
];

/// `.key_seed` 文件的 DPAPI 封装前缀
///
/// 安全修复（审阅 16-secrets-security-infra P1-1）：明文种子与密文同目录存放时，
/// 加密强度完全依赖 best-effort 的文件 ACL。Windows 下改用 DPAPI（用户级
/// `CryptProtectData`）封装种子后落盘：即使 `.secure` 目录整体泄露（备份、
/// 网盘同步、取证镜像），缺少当前 Windows 用户上下文也无法解封种子。
/// 文件格式：`DPAPI1:` + base64(DPAPI blob)。旧版明文种子在首次读取时平滑迁移。
const DPAPI_SEED_PREFIX: &str = "DPAPI1:";

/// `.key_seed` 已迁入平台密钥库（macOS Keychain / Linux Secret Service）时的
/// 引用标记前缀（TD-08）
///
/// 文件内容为 `KEYSTORE1:` + hex(SHA-256(domain || seed))。文件中不再含任何
/// 秘密材料，仅保留指纹用于定位并校验密钥库条目；备份/恢复管线
/// （data_governance/backup）对该标记文件的复制行为保持不变——跨机器恢复时
/// `validate_backup_seed_file` 会像 DPAPI 种子一样 fail-closed。
const KEYSTORE_SEED_PREFIX: &str = "KEYSTORE1:";

/// 受控降级开关：设为 1/true 后，新种子/明文种子不迁入平台密钥库，
/// 维持加密文件方案。适用于无桌面密钥环的 Linux headless 部署。
/// 注意：已迁入密钥库的种子（KEYSTORE1: 标记）不受此开关影响，仍需密钥库可达。
const KEY_SEED_FILE_ONLY_ENV: &str = "DEEP_STUDENT_KEY_SEED_FILE_ONLY";

/// 平台密钥库 opt-in 标记文件（位于 secure_dir 下）。
///
/// 存在即表示用户在设置中显式开启了「系统钥匙串保护」。默认不存在 = 关闭：
/// 种子保存在权限收紧（0600）的本地文件中，绝不触碰 Keychain / Secret
/// Service，也就不会出现系统授权弹窗。
const KEYSTORE_OPT_IN_MARKER: &str = ".keystore_opt_in";

/// 备份种子文件读取上限。正常明文种子为 64 字符，DPAPI 载荷通常也只有数百字节。
const MAX_BACKUP_SEED_FILE_BYTES: u64 = 64 * 1024;
const MAX_ENCRYPTED_SECRET_FILE_BYTES: u64 = 16 * 1024 * 1024;

static MASTER_SEED_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// 密钥库种子的进程内缓存（指纹 → 种子）。
///
/// keyring 的 `get_password()` 在 macOS 上可能触发系统授权弹窗并同步阻塞；
/// 缓存保证开启钥匙串保护时每进程对同一条目最多访问一次密钥库，
/// 后续凭据读写不再产生弹窗/IPC 开销。种子本就长期驻留在派生密钥的
/// 调用链内存中，缓存不扩大泄漏面。
static KEYSTORE_SEED_CACHE: LazyLock<Mutex<std::collections::HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

fn keystore_seed_cache_get(fingerprint: &str) -> Option<String> {
    KEYSTORE_SEED_CACHE
        .lock()
        .ok()
        .and_then(|cache| cache.get(fingerprint).cloned())
}

fn keystore_seed_cache_put(fingerprint: &str, seed: &str) {
    if let Ok(mut cache) = KEYSTORE_SEED_CACHE.lock() {
        cache.insert(fingerprint.to_string(), seed.to_string());
    }
}

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

// ==================== 平台密钥库（TD-08） ====================

/// 平台密钥库抽象（macOS Keychain / Linux Secret Service）。
///
/// 抽成 trait 是为了让「种子迁移决策」可以在任意平台上用 fake 实现做纯单测；
/// 生产实现见 `PlatformSeedKeystore`。
pub(crate) trait SeedKeystore {
    /// 后端名称（日志/可行动错误信息用）
    fn backend_name(&self) -> &'static str;
    /// 读取指纹对应的种子。`Ok(None)` = 条目不存在；`Err` = 密钥库不可用/拒绝访问。
    fn load(&self, fingerprint: &str) -> Result<Option<String>, String>;
    /// 写入（覆盖）指纹对应的种子条目。
    fn store(&self, fingerprint: &str, seed: &str) -> Result<(), String>;
}

/// 生产实现：经 `keyring` crate 访问 macOS Keychain / Linux Secret Service。
///
/// 条目定位：service = `deep-student`，account = `key_seed.<指纹>`。
/// 用指纹（而非固定名）作 account，保证多数据空间/多 secure 目录各自的种子
/// 互不覆盖，且迁移重试幂等（同种子恒定同条目）。
#[cfg(all(any(target_os = "macos", target_os = "linux"), not(test)))]
struct PlatformSeedKeystore;

#[cfg(all(any(target_os = "macos", target_os = "linux"), not(test)))]
impl SeedKeystore for PlatformSeedKeystore {
    fn backend_name(&self) -> &'static str {
        if cfg!(target_os = "macos") {
            "macOS Keychain"
        } else {
            "Secret Service"
        }
    }

    fn load(&self, fingerprint: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(SERVICE_NAME, &format!("key_seed.{fingerprint}"))
            .map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(seed) => Ok(Some(seed)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn store(&self, fingerprint: &str, seed: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE_NAME, &format!("key_seed.{fingerprint}"))
            .map_err(|e| e.to_string())?;
        entry.set_password(seed).map_err(|e| e.to_string())
    }
}

fn keystore_disabled_by_env() -> bool {
    std::env::var(KEY_SEED_FILE_ONLY_ENV)
        .map(|v| {
            let v = v.trim();
            !v.is_empty() && v != "0" && !v.eq_ignore_ascii_case("false")
        })
        .unwrap_or(false)
}

/// 用户是否在设置中显式开启了「系统钥匙串保护」（opt-in 标记文件存在）。
pub(crate) fn keystore_opted_in(secure_dir: &std::path::Path) -> bool {
    !keystore_disabled_by_env() && secure_dir.join(KEYSTORE_OPT_IN_MARKER).is_file()
}

/// 当前构建是否支持平台密钥库（macOS Keychain / Linux Secret Service）。
pub(crate) fn keystore_supported() -> bool {
    cfg!(all(
        any(target_os = "macos", target_os = "linux"),
        not(test)
    )) && !keystore_disabled_by_env()
}

/// 当前构建/配置下可用的平台密钥库。
///
/// - 桌面 macOS/Linux：返回真实实现；
/// - Windows（走 DPAPI）、Android/iOS：`None`；
/// - `DEEP_STUDENT_KEY_SEED_FILE_ONLY=1`：显式受控降级，`None`；
/// - `cfg(test)`：恒 `None`——单测绝不触碰真实钥匙串，密钥库路径一律用 fake 注入覆盖。
fn platform_seed_keystore() -> Option<Box<dyn SeedKeystore>> {
    if keystore_disabled_by_env() {
        return None;
    }
    #[cfg(all(any(target_os = "macos", target_os = "linux"), not(test)))]
    {
        Some(Box::new(PlatformSeedKeystore))
    }
    #[cfg(not(all(any(target_os = "macos", target_os = "linux"), not(test))))]
    {
        None
    }
}

/// `.key_seed` 文件内容的形态分类（纯函数，供决策逻辑单测）。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SeedFileContent<'a> {
    /// 明文种子（历史格式 / 受控降级格式）
    Plaintext(&'a str),
    /// Windows DPAPI 封装（`DPAPI1:` 之后的 base64 载荷）
    Dpapi(&'a str),
    /// 平台密钥库引用标记（`KEYSTORE1:` 之后的 sha256 指纹）
    KeystoreRef { fingerprint: &'a str },
}

pub(crate) fn classify_seed_content(
    trimmed: &str,
) -> Result<SeedFileContent<'_>, SecureStoreError> {
    if let Some(payload) = trimmed.strip_prefix(DPAPI_SEED_PREFIX) {
        return Ok(SeedFileContent::Dpapi(payload));
    }
    if let Some(reference) = trimmed.strip_prefix(KEYSTORE_SEED_PREFIX) {
        let fingerprint = reference.trim();
        if fingerprint.len() != 64 || !fingerprint.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(SecureStoreError::EncryptionError(
                "平台密钥库引用标记格式非法（期望 KEYSTORE1:<sha256 hex>），拒绝继续".to_string(),
            ));
        }
        return Ok(SeedFileContent::KeystoreRef { fingerprint });
    }
    Ok(SeedFileContent::Plaintext(trimmed)) // 空串已在调用方拦截
}

/// 种子指纹：SHA-256(domain || seed) 的 hex。用于密钥库条目定位与内容校验；
/// 由 32 字节随机种子哈希而来，不可逆推，可安全落盘。
pub(crate) fn seed_fingerprint(seed: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"deep-student.key_seed.fingerprint.v1");
    hasher.update(seed.as_bytes());
    hex::encode(hasher.finalize())
}

/// TD-08 核心决策：根据 `.key_seed` 的指纹标记从平台密钥库解析种子。
///
/// fail-closed 契约（有纯单测锁定）：
/// - 密钥库不可用 / 条目缺失 / 内容与指纹不匹配 → 一律返回错误，
///   **绝不生成新种子**（否则旧密文将永久不可解）；
/// - 错误信息面向可行动性：Linux headless 提示安装/解锁 Secret Service
///   或从备份恢复明文 `.key_seed`。
pub(crate) fn resolve_keystore_seed(
    keystore: Option<&dyn SeedKeystore>,
    fingerprint: &str,
) -> Result<String, SecureStoreError> {
    let fp_short = &fingerprint[..fingerprint.len().min(12)];
    let Some(keystore) = keystore else {
        return Err(SecureStoreError::PlatformUnsupported(format!(
            "密钥种子已迁入平台密钥库（指纹 {fp_short}…），当前平台/配置无法访问密钥库：\
             请回到原设备运行，或从备份恢复明文 .key_seed；\
             若设置了 {KEY_SEED_FILE_ONLY_ENV} 请先移除该环境变量"
        )));
    };
    match keystore.load(fingerprint) {
        Err(e) => Err(SecureStoreError::KeychainUnavailable(format!(
            "{} 不可用: {}。Linux 无桌面环境请先安装并解锁 Secret Service\
             （gnome-keyring/KWallet），或从备份恢复明文 .key_seed；\
             系统不会自动生成新密钥覆盖旧密文",
            keystore.backend_name(),
            e
        ))),
        Ok(None) => Err(SecureStoreError::KeyNotFound(format!(
            "{} 中找不到指纹 {fp_short}… 对应的密钥种子条目。\
             若曾清理过钥匙串/密钥环，请从备份恢复明文 .key_seed；\
             系统不会自动生成新密钥（fail-closed）",
            keystore.backend_name()
        ))),
        Ok(Some(stored)) => {
            let stored = Zeroizing::new(stored);
            let trimmed = stored.trim();
            if trimmed.is_empty() || seed_fingerprint(trimmed) != fingerprint {
                return Err(SecureStoreError::EncryptionError(format!(
                    "{} 返回的种子与 .key_seed 指纹不匹配，拒绝使用\
                     （fail-closed，防止用错误密钥改写旧密文）",
                    keystore.backend_name()
                )));
            }
            Ok(trimmed.to_string())
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

    /// 静态可用性检查（构造期粗判）：所有平台统一使用加密文件存储，
    /// 构造期恒可用；根种子能否真正解封由实例级 `is_available()` 精确判定。
    fn check_availability() -> bool {
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
    /// 平台策略（TD-08）：
    /// - Windows：种子经 DPAPI 封装后落盘（见 `DPAPI_SEED_PREFIX` 注释）；
    ///   历史明文种子首次读取时平滑迁移（迁移失败不影响读取）。
    /// - macOS/Linux：种子迁入平台密钥库（Keychain / Secret Service），磁盘只留
    ///   指纹标记；迁移遵循「写入→回读验证→替换文件」，任一步失败均保留原文件
    ///   但返回错误；只有显式设置 `DEEP_STUDENT_KEY_SEED_FILE_ONLY=1` 才继续使用文件种子；
    ///   已迁移的标记文件在密钥库不可达时 fail-closed（绝不静默生成新种子）。
    /// - 其余平台维持明文 + 权限收紧策略。
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
                match classify_seed_content(trimmed)? {
                    SeedFileContent::Dpapi(_payload) => {
                        #[cfg(windows)]
                        {
                            return Self::unwrap_dpapi_seed(_payload);
                        }
                        #[cfg(not(windows))]
                        {
                            // 此前非 Windows 平台会把 DPAPI 载荷当明文种子用，
                            // 静默派生出错误密钥；现改为 fail-closed。
                            return Err(SecureStoreError::PlatformUnsupported(
                                "检测到 DPAPI 封装的密钥种子，只能在原 Windows 用户/机器上解封；\
                                 拒绝把封装载荷当作种子使用（fail-closed，不会生成新密钥）"
                                    .to_string(),
                            ));
                        }
                    }
                    SeedFileContent::KeystoreRef { fingerprint } => {
                        // 进程内缓存命中则不再触碰密钥库（macOS 上每次
                        // get_password 都可能弹系统授权框并同步阻塞）。
                        let resolved = match keystore_seed_cache_get(fingerprint) {
                            Some(cached) => cached,
                            None => {
                                let keystore = platform_seed_keystore();
                                let resolved =
                                    resolve_keystore_seed(keystore.as_deref(), fingerprint)?;
                                keystore_seed_cache_put(fingerprint, &resolved);
                                resolved
                            }
                        };
                        // 默认（未 opt-in）不使用钥匙串：曾迁入的种子在此一次性
                        // 回迁为权限收紧的本地文件，之后不再产生任何弹窗。
                        // 回迁失败仅告警——种子已成功解析，下次读取会重试回迁。
                        if !keystore_opted_in(&secure_dir) {
                            match Self::write_seed_file(&seed_file, &resolved) {
                                Ok(()) => info!(
                                    "钥匙串保护未开启：已将密钥种子从平台密钥库回迁为本地种子文件"
                                ),
                                Err(e) => warn!("密钥种子回迁为本地文件失败（下次重试）: {}", e),
                            }
                        }
                        return Ok(resolved);
                    }
                    SeedFileContent::Plaintext(plain) => {
                        let plain_seed = plain.to_string();
                        #[cfg(windows)]
                        {
                            // 旧版明文种子：平滑迁移为 DPAPI 封装（失败仅告警，不影响使用）
                            if let Err(e) = Self::write_seed_file(&seed_file, &plain_seed) {
                                warn!("迁移明文密钥种子到 DPAPI 封装失败（继续使用明文）: {}", e);
                            } else {
                                info!("已将明文密钥种子迁移为 DPAPI 封装存储");
                            }
                        }
                        #[cfg(not(windows))]
                        {
                            // 仅在用户显式开启钥匙串保护时迁移：写入密钥库→回读
                            // 验证→替换文件；失败保留原文件并 fail-closed。
                            // 默认（未 opt-in）保持本地文件种子，不触碰密钥库。
                            if keystore_opted_in(&secure_dir) {
                                if let Some(keystore) = platform_seed_keystore() {
                                    if let Err(error) = Self::migrate_seed_to_keystore(
                                        keystore.as_ref(),
                                        &seed_file,
                                        &plain_seed,
                                    ) {
                                        return Err(SecureStoreError::KeychainUnavailable(format!(
                                            "迁移明文密钥种子到{}失败，已保留原文件但拒绝继续使用明文种子: {}。\
                                             请解锁平台密钥库后重试，或在设置中关闭系统钥匙串保护",
                                            keystore.backend_name(),
                                            error
                                        )));
                                    }
                                    keystore_seed_cache_put(
                                        &seed_fingerprint(&plain_seed),
                                        &plain_seed,
                                    );
                                    info!(
                                        "已将明文密钥种子一次性迁入{}（.key_seed 仅保留指纹标记）",
                                        keystore.backend_name()
                                    );
                                }
                            }
                        }
                        return Ok(plain_seed);
                    }
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
        #[cfg(not(windows))]
        {
            // 仅在用户显式开启钥匙串保护时，新种子才写入平台密钥库
            //（写入→回读验证→落指纹标记），失败 fail-closed。
            // 默认（未 opt-in）走本地文件种子，不触碰密钥库、不产生弹窗。
            if keystore_opted_in(&secure_dir) {
                if let Some(keystore) = platform_seed_keystore() {
                    Self::migrate_seed_to_keystore(keystore.as_ref(), &seed_file, &seed).map_err(
                        |error| {
                            SecureStoreError::KeychainUnavailable(format!(
                                "写入{}失败，拒绝自动降级为明文文件种子: {}。\
                                 请解锁平台密钥库后重试，或在设置中关闭系统钥匙串保护",
                                keystore.backend_name(),
                                error
                            ))
                        },
                    )?;
                    keystore_seed_cache_put(&seed_fingerprint(&seed), &seed);
                    info!(
                        "新密钥种子已写入{}（磁盘仅保留指纹标记）",
                        keystore.backend_name()
                    );
                    return Ok(seed);
                }
            }
        }
        Self::write_seed_file(&seed_file, &seed)?;
        Ok(seed)
    }

    /// TD-08：把种子写入平台密钥库并把 `.key_seed` 原子替换为指纹标记。
    ///
    /// 迁移契约（fake keystore 单测锁定）：
    /// 1. 先写密钥库，再**回读验证**内容一致；
    /// 2. 验证通过后才用指纹标记原子替换原文件（明文此时才消失）；
    /// 3. 任一步失败即返回 Err 且不动原文件——不会出现「明文已删但密钥库没写成」
    ///    或静默换新种子的中间态。
    #[cfg_attr(windows, allow(dead_code))]
    pub(crate) fn migrate_seed_to_keystore(
        keystore: &dyn SeedKeystore,
        seed_file: &std::path::Path,
        seed: &str,
    ) -> Result<(), SecureStoreError> {
        let fingerprint = seed_fingerprint(seed);
        keystore.store(&fingerprint, seed).map_err(|e| {
            SecureStoreError::KeychainUnavailable(format!(
                "{} 写入失败: {}",
                keystore.backend_name(),
                e
            ))
        })?;
        match keystore.load(&fingerprint) {
            Ok(Some(stored)) if stored.trim() == seed => {}
            Ok(_) => {
                return Err(SecureStoreError::EncryptionError(format!(
                    "{} 回读验证失败：读出内容与写入种子不一致，保留明文种子",
                    keystore.backend_name()
                )))
            }
            Err(e) => {
                return Err(SecureStoreError::KeychainUnavailable(format!(
                    "{} 回读验证失败: {}，保留明文种子",
                    keystore.backend_name(),
                    e
                )))
            }
        }
        let marker = format!("{}{}", KEYSTORE_SEED_PREFIX, fingerprint);
        Self::atomic_write_secure_file(seed_file, marker.as_bytes())
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

    /// 将种子写入 `.key_seed`：Windows 必须使用 DPAPI 封装，封装失败即
    /// fail-closed；其余平台仅在上层策略明确允许时写入权限收紧的种子文件。
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
    /// 用户/机器上下文成功解封；`KEYSTORE1:` 引用标记要求当前平台密钥库中
    /// 存在指纹匹配的条目（TD-08）。该检查不修改源文件或当前安全存储。
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

        // 平台密钥库引用标记：文件本身不含种子，只有当前平台密钥库中存在
        // 指纹匹配的条目时才可恢复（同机恢复 OK；跨机器与 DPAPI 一样 fail-closed）。
        let keystore_ref = seed
            .trim()
            .strip_prefix(KEYSTORE_SEED_PREFIX)
            .map(|value| value.trim().to_owned());
        if let Some(fingerprint) = keystore_ref {
            seed.zeroize();
            if fingerprint.len() != 64 || !fingerprint.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(SecureStoreError::EncryptionError(
                    "备份中的平台密钥库引用标记格式非法".to_string(),
                ));
            }
            let keystore = platform_seed_keystore();
            let _resolved =
                Zeroizing::new(resolve_keystore_seed(keystore.as_deref(), &fingerprint)?);
            return Ok(());
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
        if !self.config.enabled {
            return false;
        }
        // 加密文件本身可写不代表根种子可解封。必须实际解析/初始化设备密钥，
        // 否则 Keychain / Secret Service 不可达时该 API 会错误返回 true。
        match self.get_device_key() {
            Ok(mut key) => {
                key.zeroize();
                true
            }
            Err(error) => {
                warn!("安全存储可用性检查失败: {}", error);
                false
            }
        }
    }

    /// 获取配置
    pub fn get_config(&self) -> &SecureStoreConfig {
        &self.config
    }

    /// 查询「系统钥匙串保护」状态（不触碰密钥库，绝不产生弹窗）
    pub fn keystore_protection_status(&self) -> Result<KeystoreProtectionStatus, SecureStoreError> {
        let secure_dir = self.get_secure_dir()?;
        let seed_file = secure_dir.join(".key_seed");
        let seed_in_keystore = std::fs::read_to_string(&seed_file)
            .ok()
            .map(|content| {
                matches!(
                    classify_seed_content(content.trim()),
                    Ok(SeedFileContent::KeystoreRef { .. })
                )
            })
            .unwrap_or(false);
        Ok(KeystoreProtectionStatus {
            supported: keystore_supported(),
            enabled: keystore_opted_in(&secure_dir),
            seed_in_keystore,
        })
    }

    /// 开启/关闭「系统钥匙串保护」，并立即执行相应方向的种子迁移。
    ///
    /// - 开启：落 opt-in 标记后立刻把当前种子迁入平台密钥库（写入→回读验证→
    ///   替换文件）；迁移失败则回滚标记并返回错误，系统维持本地文件方案。
    /// - 关闭：移除标记后立刻把密钥库中的种子回迁为本地文件（此步可能触发
    ///   最后一次系统授权弹窗）；回迁失败则恢复标记并返回错误，避免出现
    ///   「开关已关但种子仍只在密钥库里」的 fail-closed 中间态。
    pub fn set_keystore_protection(&self, enabled: bool) -> Result<(), SecureStoreError> {
        let secure_dir = self.get_secure_dir()?;
        let marker = secure_dir.join(KEYSTORE_OPT_IN_MARKER);

        if enabled {
            if !keystore_supported() {
                return Err(SecureStoreError::PlatformUnsupported(
                    "当前平台/配置不支持系统钥匙串保护".to_string(),
                ));
            }
            Self::atomic_write_secure_file(&marker, b"1")?;
            if let Err(error) = self.get_or_create_master_seed().map(|mut s| s.zeroize()) {
                let _ = std::fs::remove_file(&marker);
                return Err(error);
            }
            return Ok(());
        }

        match std::fs::remove_file(&marker) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(SecureStoreError::Other(format!(
                    "移除钥匙串保护标记失败: {}",
                    e
                )))
            }
        }
        // 触发回迁：get_or_create_master_seed 在未 opt-in 状态下遇到
        // KEYSTORE1 标记会自动把种子写回本地文件。
        if let Err(error) = self.get_or_create_master_seed().map(|mut s| s.zeroize()) {
            let _ = Self::atomic_write_secure_file(&marker, b"1");
            return Err(error);
        }
        // 回迁是 best-effort（失败仅告警）；这里核实确实已落回本地文件。
        let seed_file = secure_dir.join(".key_seed");
        let still_marker = std::fs::read_to_string(&seed_file)
            .ok()
            .map(|content| content.trim().starts_with(KEYSTORE_SEED_PREFIX))
            .unwrap_or(false);
        if still_marker {
            let _ = Self::atomic_write_secure_file(&marker, b"1");
            return Err(SecureStoreError::Other(
                "密钥种子回迁为本地文件未完成，已保持钥匙串保护开启".to_string(),
            ));
        }
        Ok(())
    }
}

/// 「系统钥匙串保护」状态（设置页展示用）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeystoreProtectionStatus {
    /// 当前平台/构建是否支持（macOS/Linux 桌面端且未被环境变量禁用）
    pub supported: bool,
    /// 用户是否已开启（opt-in 标记存在）
    pub enabled: bool,
    /// 种子当前是否实际存放在平台密钥库中
    pub seed_in_keystore: bool,
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

    // ==================== TD-08：种子迁移决策单测（fake keystore，纯逻辑） ====================

    /// 可注入故障的内存密钥库：覆盖迁移决策的全部分支，不触碰真实钥匙串
    #[derive(Default)]
    struct FakeKeystore {
        entries: std::sync::Mutex<std::collections::HashMap<String, String>>,
        fail_store: bool,
        fail_load: bool,
        corrupt_readback: bool,
    }

    impl SeedKeystore for FakeKeystore {
        fn backend_name(&self) -> &'static str {
            "FakeKeystore"
        }
        fn load(&self, fingerprint: &str) -> Result<Option<String>, String> {
            if self.fail_load {
                return Err("keystore offline".to_string());
            }
            let entries = self.entries.lock().unwrap();
            let value = entries.get(fingerprint).cloned();
            if self.corrupt_readback {
                return Ok(value.map(|v| format!("{v}-corrupted")));
            }
            Ok(value)
        }
        fn store(&self, fingerprint: &str, seed: &str) -> Result<(), String> {
            if self.fail_store {
                return Err("keystore write denied".to_string());
            }
            self.entries
                .lock()
                .unwrap()
                .insert(fingerprint.to_string(), seed.to_string());
            Ok(())
        }
    }

    fn sample_seed() -> String {
        "ab".repeat(32)
    }

    #[test]
    fn classify_seed_content_variants() {
        let seed = sample_seed();
        assert_eq!(
            classify_seed_content(&seed).unwrap(),
            SeedFileContent::Plaintext(seed.as_str())
        );
        assert_eq!(
            classify_seed_content("DPAPI1:Zm9v").unwrap(),
            SeedFileContent::Dpapi("Zm9v")
        );
        let fp = seed_fingerprint(&seed);
        let marker = format!("KEYSTORE1:{fp}");
        assert_eq!(
            classify_seed_content(&marker).unwrap(),
            SeedFileContent::KeystoreRef { fingerprint: &fp }
        );
        // 非法指纹（长度/字符）必须整体拒绝，而不是当明文种子用
        let error = classify_seed_content("KEYSTORE1:not-a-fingerprint")
            .expect_err("malformed keystore ref must be rejected");
        assert!(matches!(error, SecureStoreError::EncryptionError(_)));
    }

    #[test]
    fn seed_fingerprint_is_stable_hex() {
        let fp1 = seed_fingerprint("seed-a");
        let fp2 = seed_fingerprint("seed-a");
        let fp3 = seed_fingerprint("seed-b");
        assert_eq!(fp1, fp2);
        assert_ne!(fp1, fp3);
        assert_eq!(fp1.len(), 64);
        assert!(fp1.bytes().all(|b| b.is_ascii_hexdigit()));
    }

    #[test]
    fn plaintext_seed_migrates_into_keystore_with_verified_marker() {
        let dir = TempDir::new().expect("create tempdir");
        let seed_file = dir.path().join(".key_seed");
        let seed = sample_seed();
        std::fs::write(&seed_file, &seed).expect("write plaintext seed");

        let keystore = FakeKeystore::default();
        SecureStore::migrate_seed_to_keystore(&keystore, &seed_file, &seed)
            .expect("migration should succeed");

        let on_disk = std::fs::read_to_string(&seed_file).expect("read marker");
        assert!(
            on_disk.starts_with(KEYSTORE_SEED_PREFIX),
            "落盘应为引用标记"
        );
        assert!(!on_disk.contains(&seed), "落盘内容不应再含明文种子");

        // 标记指纹可从密钥库解析回同一种子
        let SeedFileContent::KeystoreRef { fingerprint } =
            classify_seed_content(on_disk.trim()).unwrap()
        else {
            panic!("marker should classify as keystore ref");
        };
        let resolved = resolve_keystore_seed(Some(&keystore as &dyn SeedKeystore), fingerprint)
            .expect("resolve migrated seed");
        assert_eq!(resolved, seed);
    }

    #[test]
    fn migration_store_failure_keeps_plaintext_file() {
        let dir = TempDir::new().expect("create tempdir");
        let seed_file = dir.path().join(".key_seed");
        let seed = sample_seed();
        std::fs::write(&seed_file, &seed).expect("write plaintext seed");

        let keystore = FakeKeystore {
            fail_store: true,
            ..Default::default()
        };
        let error = SecureStore::migrate_seed_to_keystore(&keystore, &seed_file, &seed)
            .expect_err("store failure must abort migration");
        assert!(matches!(error, SecureStoreError::KeychainUnavailable(_)));
        assert_eq!(std::fs::read_to_string(&seed_file).unwrap(), seed);
    }

    #[test]
    fn migration_readback_mismatch_keeps_plaintext_file() {
        let dir = TempDir::new().expect("create tempdir");
        let seed_file = dir.path().join(".key_seed");
        let seed = sample_seed();
        std::fs::write(&seed_file, &seed).expect("write plaintext seed");

        let keystore = FakeKeystore {
            corrupt_readback: true,
            ..Default::default()
        };
        let error = SecureStore::migrate_seed_to_keystore(&keystore, &seed_file, &seed)
            .expect_err("readback mismatch must abort migration before deleting plaintext");
        assert!(matches!(error, SecureStoreError::EncryptionError(_)));
        assert_eq!(std::fs::read_to_string(&seed_file).unwrap(), seed);
    }

    #[test]
    fn keystore_ref_fails_closed_without_backend() {
        let fp = seed_fingerprint(&sample_seed());
        let error = resolve_keystore_seed(None, &fp)
            .expect_err("no backend must fail closed, never mint a new seed");
        assert!(matches!(error, SecureStoreError::PlatformUnsupported(_)));
    }

    #[test]
    fn keystore_ref_fails_closed_when_backend_unavailable() {
        let fp = seed_fingerprint(&sample_seed());
        let keystore = FakeKeystore {
            fail_load: true,
            ..Default::default()
        };
        let error = resolve_keystore_seed(Some(&keystore as &dyn SeedKeystore), &fp)
            .expect_err("unavailable backend must fail closed with actionable error");
        assert!(matches!(error, SecureStoreError::KeychainUnavailable(_)));
        // 可行动性：错误信息必须指向 Secret Service / 备份恢复路径
        assert!(error.to_string().contains("Secret Service"));
    }

    #[test]
    fn keystore_ref_fails_closed_when_entry_missing() {
        let fp = seed_fingerprint(&sample_seed());
        let keystore = FakeKeystore::default();
        let error = resolve_keystore_seed(Some(&keystore as &dyn SeedKeystore), &fp)
            .expect_err("missing entry must fail closed");
        assert!(matches!(error, SecureStoreError::KeyNotFound(_)));
    }

    #[test]
    fn keystore_ref_fingerprint_mismatch_fails_closed() {
        let seed = sample_seed();
        let fp = seed_fingerprint(&seed);
        let keystore = FakeKeystore::default();
        // 指纹条目下放了另一个种子（模拟条目被覆盖/篡改）
        keystore.store(&fp, "cc".repeat(32).as_str()).unwrap();
        let error = resolve_keystore_seed(Some(&keystore as &dyn SeedKeystore), &fp)
            .expect_err("mismatched seed must be rejected");
        assert!(matches!(error, SecureStoreError::EncryptionError(_)));
    }

    /// 端到端：`.key_seed` 为密钥库标记而（测试构建下）无真实密钥库时，
    /// 读写必须失败且标记文件保持原样——绝不静默生成新种子。
    #[test]
    fn keystore_marker_seed_file_never_replaced_by_new_seed() {
        let dir = TempDir::new().expect("create tempdir");
        let store =
            SecureStore::new_with_dir(SecureStoreConfig::default(), dir.path().to_path_buf());
        let seed_file = dir.path().join(".secure/.key_seed");
        let marker = format!(
            "{}{}",
            KEYSTORE_SEED_PREFIX,
            seed_fingerprint(&sample_seed())
        );
        std::fs::write(&seed_file, &marker).expect("write keystore marker");

        let error = store
            .save_secret("keystore-marker-test", "must-not-be-written")
            .expect_err("unreachable keystore must fail closed");
        assert!(matches!(error, SecureStoreError::PlatformUnsupported(_)));
        assert_eq!(std::fs::read_to_string(&seed_file).unwrap(), marker);
        assert!(!dir.path().join(".secure/keystore-marker-test.enc").exists());
    }

    #[test]
    fn keystore_marker_backup_seed_is_rejected_without_backend() {
        let dir = TempDir::new().expect("create tempdir");
        let seed_file = dir.path().join(".key_seed");
        let marker = format!(
            "{}{}",
            KEYSTORE_SEED_PREFIX,
            seed_fingerprint(&sample_seed())
        );
        std::fs::write(&seed_file, marker).expect("write keystore marker");

        let error = SecureStore::validate_backup_seed_file(&seed_file)
            .expect_err("keystore marker without reachable backend is not restorable");
        assert!(matches!(error, SecureStoreError::PlatformUnsupported(_)));
    }

    #[cfg(not(windows))]
    #[test]
    fn dpapi_seed_is_rejected_off_windows_when_reading() {
        let dir = TempDir::new().expect("create tempdir");
        let store =
            SecureStore::new_with_dir(SecureStoreConfig::default(), dir.path().to_path_buf());
        let seed_file = dir.path().join(".secure/.key_seed");
        std::fs::write(&seed_file, "DPAPI1:Zm9yZWlnbi1ibG9i").expect("write dpapi seed");

        // 此前会把 DPAPI 载荷当明文种子静默派生错误密钥；现必须 fail-closed
        let error = store
            .save_secret("dpapi-cross-platform", "value")
            .expect_err("DPAPI seed must fail closed off Windows");
        assert!(matches!(error, SecureStoreError::PlatformUnsupported(_)));
    }

    /// 默认（未 opt-in）：新种子必须落为本地明文文件，绝不带密钥库/DPAPI 标记，
    /// 也不得生成 opt-in 标记——这是「默认不弹钥匙串授权框」的行为锚点。
    #[test]
    fn new_seed_stays_in_local_file_by_default() {
        let dir = TempDir::new().expect("create tempdir");
        let store =
            SecureStore::new_with_dir(SecureStoreConfig::default(), dir.path().to_path_buf());

        store
            .save_secret("default-mode-test", "value")
            .expect("save");

        let seed_file = dir.path().join(".secure/.key_seed");
        let on_disk = std::fs::read_to_string(&seed_file).expect("seed file must exist");
        let trimmed = on_disk.trim();
        #[cfg(not(windows))]
        assert!(
            !trimmed.starts_with(KEYSTORE_SEED_PREFIX) && !trimmed.starts_with(DPAPI_SEED_PREFIX),
            "默认模式下种子应为本地明文文件"
        );
        assert!(
            !dir.path()
                .join(".secure")
                .join(KEYSTORE_OPT_IN_MARKER)
                .exists(),
            "默认模式不得自动生成 opt-in 标记"
        );

        let status = store.keystore_protection_status().expect("status");
        assert!(!status.enabled);
        assert!(!status.seed_in_keystore);
    }

    /// 测试构建下平台密钥库恒不可用：开启开关必须失败且不残留 opt-in 标记。
    #[test]
    fn enabling_keystore_protection_fails_closed_without_backend() {
        let dir = TempDir::new().expect("create tempdir");
        let store =
            SecureStore::new_with_dir(SecureStoreConfig::default(), dir.path().to_path_buf());

        let error = store
            .set_keystore_protection(true)
            .expect_err("no backend in test builds");
        assert!(matches!(error, SecureStoreError::PlatformUnsupported(_)));
        assert!(!dir
            .path()
            .join(".secure")
            .join(KEYSTORE_OPT_IN_MARKER)
            .exists());
    }

    /// 关闭开关在「本就未启用」时应为幂等 no-op。
    #[test]
    fn disabling_keystore_protection_is_idempotent() {
        let dir = TempDir::new().expect("create tempdir");
        let store =
            SecureStore::new_with_dir(SecureStoreConfig::default(), dir.path().to_path_buf());

        store.set_keystore_protection(false).expect("noop disable");
        store.set_keystore_protection(false).expect("still ok");
        let status = store.keystore_protection_status().expect("status");
        assert!(!status.enabled);
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
///
/// 注意：不派生 `Debug`——所有字段都是 secret，派生实现会把明文密码带进
/// 日志/错误链（`{:?}`、`unwrap`/`expect` panic 消息等）。下方手写的 `Debug`
/// 只输出字段是否存在（`Some("[REDACTED]")` / `None`），绝不输出明文。
#[derive(Clone, Default, Serialize, Deserialize)]
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

/// 与 ZIP 全保真导出 `MIN_ENCRYPTION_PASSWORD_CHARS` 对齐。
/// 短于此长度的密码不能导出加密全保真包，禁止写入安全存储冒充「已配置」。
pub const MIN_CLOUD_ENCRYPTION_PASSWORD_CHARS: usize = 8;
/// 短密码拒绝的稳定 IPC code。前端只按 code 分派，文案可改语言。
pub const CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE: &str = "E_CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT";
/// staged generation 冲突的稳定 IPC code（R2 原子发布）。与 IO 故障区分：
/// 调用方收到此 code 应重读 active generation 并重新 stage，而不是重试提交。
pub const CLOUD_CREDENTIALS_GENERATION_CONFLICT_CODE: &str =
    "E_CLOUD_CREDENTIALS_GENERATION_CONFLICT";

pub(crate) fn cloud_encryption_password_too_short(password: Option<&str>) -> bool {
    password
        .map(str::trim)
        .filter(|password| !password.is_empty())
        .is_some_and(|password| password.chars().count() < MIN_CLOUD_ENCRYPTION_PASSWORD_CHARS)
}

pub fn cloud_encryption_password_too_short_message() -> String {
    format!(
        "[{}] 云端端到端加密密码至少需要 {} 个字符（不能为空白）",
        CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE, MIN_CLOUD_ENCRYPTION_PASSWORD_CHARS
    )
}

// ==================== [Wave2-R5] 新设口令弱口令准入 ====================
//
// 与 8 字符长度门**同一路径、同一开关**：只作用于新设加密口令
// （`encryption_password_is_preexisting = false`）。存量口令入口（换机/重装
// 重输、legacy 迁移，preexisting = true）完全不经过本检查——密文已经存在，
// 按新设标准拒绝存量口令会把旧加密备份变成产品内打不开的黑盒。

/// [Wave2-R5] 弱口令拒绝的稳定 IPC code。前端只按 code 分派，文案可改语言。
pub const CLOUD_ENCRYPTION_PASSWORD_TOO_WEAK_CODE: &str = "E_CLOUD_ENCRYPTION_PASSWORD_TOO_WEAK";

/// 新设口令最少需要的**不同** Unicode 码点数（熵下限的粗粒度近似）。
///
/// 拦的是「aaaaaaaa」「abababab」「12121212」这类通过了 8 字符长度门、但
/// 字符集小到近乎零熵的口令。4 个不同字符是刻意保守的下限：正常人手选的
/// 任何口令都轻松通过，不会造成新设摩擦。
pub const MIN_CLOUD_ENCRYPTION_PASSWORD_DISTINCT_CHARS: usize = 4;

/// 极弱口令小黑名单（榜单常客级）。
///
/// 收录规则（刻意保持很小，不追求覆盖率）：
/// - 只收 8 字符及以上——更短的（如 "letmein"、"123456"）先被长度门拒绝，
///   收进来是死代码；
/// - 只收各大泄露口令榜（RockYou / NCSC / SecLists top 列表）常年霸榜、且
///   与本产品无关的通用弱口令；不收人名等误伤面大的词；
/// - 匹配前先 `trim` + Unicode 小写化，大小写变体（"Password123"）同样命中。
///
/// 这不是（也不可能是）完整的口令强度评估：目的只是把「攻击者第一批就会试」
/// 的口令挡在新设入口，其余强度判断留给前端提示与用户自己。
const CLOUD_ENCRYPTION_PASSWORD_BLACKLIST: &[&str] = &[
    "password",
    "password1",
    "password12",
    "password123",
    "passw0rd",
    "p@ssw0rd",
    "12345678",
    "123456789",
    "1234567890",
    "11111111",
    "00000000",
    "88888888",
    "66666666",
    "aa123456",
    "abc12345",
    "a1b2c3d4",
    "1q2w3e4r",
    "1qaz2wsx",
    "qwer1234",
    "qwertyui",
    "qwertyuiop",
    "asdfghjk",
    "asdfghjkl",
    "zxcvbnm123",
    "iloveyou",
    "sunshine",
    "princess",
    "football",
    "baseball",
    "superman",
    "internet",
    "computer",
];

/// 新设口令是否命中弱口令判定（黑名单或熵下限）。
///
/// 语义与 [`cloud_encryption_password_too_short`] 对齐：`None`、空串、纯空白
/// 都返回 `false`——合并语义里它们表示「保留现有值」，不是一次新设。
pub(crate) fn cloud_encryption_password_too_weak(password: Option<&str>) -> bool {
    let Some(password) = password.map(str::trim).filter(|value| !value.is_empty()) else {
        return false;
    };
    let lowered = password.to_lowercase();
    if CLOUD_ENCRYPTION_PASSWORD_BLACKLIST.contains(&lowered.as_str()) {
        return true;
    }
    let distinct_chars = password
        .chars()
        .collect::<std::collections::HashSet<char>>()
        .len();
    distinct_chars < MIN_CLOUD_ENCRYPTION_PASSWORD_DISTINCT_CHARS
}

pub fn cloud_encryption_password_too_weak_message() -> String {
    format!(
        "[{}] 云端端到端加密密码过于常见或过于单一（常见弱口令、或不同字符少于 {} 个），\
         请换一个更难猜的密码",
        CLOUD_ENCRYPTION_PASSWORD_TOO_WEAK_CODE, MIN_CLOUD_ENCRYPTION_PASSWORD_DISTINCT_CHARS
    )
}

/// **新设**加密口令的统一准入门：长度门在前（保持既有错误优先级），弱口令
/// 门在后。两个写入口（[`SecureStore::update_cloud_credentials_with_policy`]
/// 与 [`SecureStore::write_staged_cloud_credentials`]）在
/// `encryption_password_is_preexisting = false` 时都必须走本函数，保证
/// 「新设」的判定标准只有一份；preexisting = true 时调用方直接跳过本函数。
fn check_new_cloud_encryption_password(password: Option<&str>) -> Result<(), SecureStoreError> {
    if cloud_encryption_password_too_short(password) {
        return Err(SecureStoreError::CloudEncryptionPasswordTooShort(
            cloud_encryption_password_too_short_message(),
        ));
    }
    if cloud_encryption_password_too_weak(password) {
        return Err(SecureStoreError::CloudEncryptionPasswordTooWeak(
            cloud_encryption_password_too_weak_message(),
        ));
    }
    Ok(())
}

/// 手写 Debug：secret 字段一律脱敏为 `[REDACTED]`，仅保留 Some/None 的存在性
/// 信息（排障需要知道哪些凭据已配置，但绝不需要明文值）。
impl std::fmt::Debug for CloudStorageCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        fn redact(value: &Option<String>) -> Option<&'static str> {
            value.as_ref().map(|_| "[REDACTED]")
        }
        f.debug_struct("CloudStorageCredentials")
            .field("webdav_password", &redact(&self.webdav_password))
            .field("s3_secret_access_key", &redact(&self.s3_secret_access_key))
            .field("ftp_password", &redact(&self.ftp_password))
            .field("encryption_password", &redact(&self.encryption_password))
            .finish()
    }
}

/// Credential presence exposed to the WebView. Secret values never cross the
/// backend-to-frontend IPC boundary.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudStorageCredentialStatus {
    pub webdav_password_configured: bool,
    pub s3_secret_access_key_configured: bool,
    pub ftp_password_configured: bool,
    pub encryption_password_configured: bool,
}

impl CloudStorageCredentials {
    fn has_any_secret(&self) -> bool {
        self.webdav_password
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
            || self
                .s3_secret_access_key
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            || self
                .ftp_password
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            || self
                .encryption_password
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
    }

    fn status(&self) -> CloudStorageCredentialStatus {
        CloudStorageCredentialStatus {
            webdav_password_configured: self
                .webdav_password
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty()),
            s3_secret_access_key_configured: self
                .s3_secret_access_key
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty()),
            ftp_password_configured: self
                .ftp_password
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty()),
            encryption_password_configured: self
                .encryption_password
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty()),
        }
    }

    fn apply_nonempty_update(&mut self, update: &Self) {
        if update
            .webdav_password
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        {
            self.webdav_password.clone_from(&update.webdav_password);
        }
        if update
            .s3_secret_access_key
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        {
            self.s3_secret_access_key
                .clone_from(&update.s3_secret_access_key);
        }
        if update
            .ftp_password
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        {
            self.ftp_password.clone_from(&update.ftp_password);
        }
        if update
            .encryption_password
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        {
            self.encryption_password
                .clone_from(&update.encryption_password);
        }
    }
}

/// staged 槽落盘形状（R2 原子发布）。
///
/// `generation` 冗余存进记录本身而不是仅靠 `active+1` 推算：写 staged 与
/// commit 之间 active pointer 可能被并发提交推进，commit 必须能识别出
/// 「这份 staged 是针对旧基线合并的」并 fail-closed，而不是把过期合并结果
/// 发布出去。`credentials` 的 Debug 已脱敏（见 `CloudStorageCredentials`）。
#[derive(Debug, Serialize, Deserialize)]
struct StagedCloudCredentials {
    generation: u64,
    credentials: CloudStorageCredentials,
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

    /// Merge newly entered non-empty values into the backend secret SSOT.
    ///
    /// Settings never reads secret values back over IPC, so omitted fields mean
    /// "keep the existing backend value". Clearing the cloud configuration uses
    /// `delete_cloud_credentials` and removes the complete secret record.
    pub fn update_cloud_credentials(
        &self,
        update: &CloudStorageCredentials,
    ) -> Result<CloudStorageCredentialStatus, SecureStoreError> {
        self.update_cloud_credentials_with_policy(update, false)
    }

    /// `update_cloud_credentials`，带口令准入策略。
    ///
    /// 8 字符下限与 [Wave2-R5] 弱口令检查（黑名单 + 熵下限）只是**新设**加密
    /// 口令的准入规则。v0.9.44 对口令长度/强度没有任何限制，密文已经存在：
    /// 换机/重装后重输原口令、legacy localStorage→SSOT 迁移携带的存量口令，
    /// 如果按新设标准拒绝，用户的旧加密备份就变成产品内打不开的黑盒。
    /// `encryption_password_is_preexisting = true` 声明提交的是存量口令，
    /// 放行任意非空口令（短的、弱的都放行）；新设入口保持 fail-closed。
    pub fn update_cloud_credentials_with_policy(
        &self,
        update: &CloudStorageCredentials,
        encryption_password_is_preexisting: bool,
    ) -> Result<CloudStorageCredentialStatus, SecureStoreError> {
        if !encryption_password_is_preexisting {
            check_new_cloud_encryption_password(update.encryption_password.as_deref())?;
        }
        let mut credentials = self.get_cloud_credentials()?.unwrap_or_default();
        credentials.apply_nonempty_update(update);
        if credentials.has_any_secret() {
            self.save_cloud_credentials(&credentials)?;
        } else {
            self.delete_cloud_credentials()?;
        }
        Ok(credentials.status())
    }

    pub fn cloud_credential_status(
        &self,
    ) -> Result<CloudStorageCredentialStatus, SecureStoreError> {
        Ok(self
            .get_cloud_credentials()?
            .as_ref()
            .map(CloudStorageCredentials::status)
            .unwrap_or_default())
    }

    /// 显式停用端到端加密：仅删除加密密码，WebDAV/S3/FTP 传输凭据保持不变。
    ///
    /// `update_cloud_credentials` 的合并语义把空字段视为「保留现有值」（防止
    /// 空白表单误删凭据），因此停用加密必须走这个显式 API，而不是提交空密码。
    /// fail-closed：读取或写回失败时直接返回错误，绝不顺带清空其他凭据。
    pub fn clear_cloud_encryption_password(
        &self,
    ) -> Result<CloudStorageCredentialStatus, SecureStoreError> {
        let Some(mut credentials) = self.get_cloud_credentials()? else {
            return Ok(CloudStorageCredentialStatus::default());
        };
        credentials.encryption_password = None;
        if credentials.has_any_secret() {
            self.save_cloud_credentials(&credentials)?;
        } else {
            self.delete_cloud_credentials()?;
        }
        Ok(credentials.status())
    }

    /// 删除云存储凭据
    pub fn delete_cloud_credentials(&self) -> Result<(), SecureStoreError> {
        self.delete_secret(CLOUD_STORAGE_KEY)
    }

    // ==================== staged generation 原子发布（R2） ====================
    //
    // 记录布局：
    // - active：`CLOUD_STORAGE_KEY`（既有未版本化记录，所有读路径不变）
    // - staged：`CLOUD_STORAGE_STAGED_KEY`（`StagedCloudCredentials` JSON）
    // - pointer：`CLOUD_STORAGE_GENERATION_KEY`（十进制 u64；缺失 = 0 = legacy）
    //
    // commit 顺序（崩溃可恢复，绝不指向空凭据）：
    //   1. 写新 active（底层 `atomic_write_secure_file` 临时文件+rename）——失败则什么都没改
    //   2. 写 pointer = expected_generation ——失败则尽力写回旧 active（staged 保留，可重试）
    //   3. 删 staged ——此时 commit 已持久化；失败可用相同 expected_generation 重放收敛
    // 崩在 1↔2 之间：active=新内容、pointer=旧值、staged 仍在 → 重放 commit 幂等收敛。
    // 崩在 2↔3 之间：pointer 已推进 → 重放 commit 走「已提交，仅清理 staged」分支。

    /// 当前 active generation。缺 pointer 键 = 0：legacy 未版本化记录即 active。
    ///
    /// pointer 内容损坏（非十进制 u64）时 fail-closed 报 `SerializationError`，
    /// 而不是静默当 0——静默会让并发提交方把过期 staged 误判为 `active+1`。
    pub fn cloud_credentials_active_generation(&self) -> Result<u64, SecureStoreError> {
        match self.get_secret(CLOUD_STORAGE_GENERATION_KEY)? {
            None => Ok(0),
            Some(raw) => raw.trim().parse::<u64>().map_err(|e| {
                SecureStoreError::SerializationError(format!(
                    "云凭据 generation pointer 内容非法: {e}"
                ))
            }),
        }
    }

    /// 读 staged 槽记录；缺失返回 None，内容损坏 fail-closed 报错（commit 侧禁止
    /// 发布无法解析的合并结果；清除损坏记录走 `abort_staged_cloud_credentials`）。
    fn get_staged_cloud_credentials_record(
        &self,
    ) -> Result<Option<StagedCloudCredentials>, SecureStoreError> {
        match self.get_secret(CLOUD_STORAGE_STAGED_KEY)? {
            None => Ok(None),
            Some(json) => serde_json::from_str(&json).map(Some).map_err(|e| {
                SecureStoreError::SerializationError(format!("云凭据 staged 记录非法: {e}"))
            }),
        }
    }

    /// 把一次凭据更新写入 staged 槽，返回该 staged 所属的 generation（= 当前
    /// active generation + 1），供后续 `commit_staged_cloud_credentials` /
    /// `abort_staged_cloud_credentials` 作为 `expected_generation` 使用。
    ///
    /// - 合并语义与 `update_cloud_credentials` 相同（空/省略 = 保留），但保留的
    ///   基线是**当前 active** 的值：staged 记录里存的是合并后的完整凭据快照。
    /// - 口令准入（长度门 + [Wave2-R5] 弱口令门）与
    ///   `update_cloud_credentials_with_policy` 完全一致：
    ///   `encryption_password_is_preexisting = true` 放行存量短/弱口令，新设 fail-closed。
    /// - **不改 active 记录、不改 generation pointer**；重复调用覆盖旧 staged。
    pub fn write_staged_cloud_credentials(
        &self,
        update: &CloudStorageCredentials,
        encryption_password_is_preexisting: bool,
    ) -> Result<u64, SecureStoreError> {
        if !encryption_password_is_preexisting {
            check_new_cloud_encryption_password(update.encryption_password.as_deref())?;
        }
        let mut merged = self.get_cloud_credentials()?.unwrap_or_default();
        merged.apply_nonempty_update(update);
        let staged_generation = self
            .cloud_credentials_active_generation()?
            .checked_add(1)
            .ok_or_else(|| {
                SecureStoreError::Other("云凭据 generation 溢出（u64::MAX）".to_string())
            })?;
        let record = StagedCloudCredentials {
            generation: staged_generation,
            credentials: merged,
        };
        let json = serde_json::to_string(&record)
            .map_err(|e| SecureStoreError::SerializationError(e.to_string()))?;
        self.save_secret(CLOUD_STORAGE_STAGED_KEY, &json)?;
        Ok(staged_generation)
    }

    /// 把 staged 槽发布为 active：校验 staged 属于 `expected_generation`
    /// （且 = active generation + 1），然后按「写新 active → 推进 pointer →
    /// 删 staged」的顺序提交。任一步失败 fail-closed：pointer 未推进时 active
    /// 保持（或被回滚为）旧内容，staged 原样保留，可重放本函数收敛。
    ///
    /// 幂等重放：pointer 已经等于 `expected_generation`（上次提交崩在删 staged
    /// 之前/之后）时，仅清理残留 staged 并成功返回。
    pub fn commit_staged_cloud_credentials(
        &self,
        expected_generation: u64,
    ) -> Result<(), SecureStoreError> {
        let active_generation = self.cloud_credentials_active_generation()?;

        // 重放分支：本 generation 已提交（active + pointer 均已持久化），
        // 只剩 staged 清理。staged 缺失 = 完全提交，直接成功。
        if active_generation == expected_generation {
            return match self.get_staged_cloud_credentials_record()? {
                None => Ok(()),
                Some(record) if record.generation == expected_generation => {
                    self.delete_secret(CLOUD_STORAGE_STAGED_KEY)
                }
                Some(record) => Err(SecureStoreError::CloudCredentialGenerationConflict(
                    format!(
                        "[{}] staged generation {} 与已提交的 generation {} 不符，拒绝清理",
                        CLOUD_CREDENTIALS_GENERATION_CONFLICT_CODE,
                        record.generation,
                        expected_generation
                    ),
                )),
            };
        }

        let Some(staged) = self.get_staged_cloud_credentials_record()? else {
            return Err(SecureStoreError::KeyNotFound(format!(
                "云凭据 staged 记录不存在，无法提交 generation {expected_generation}"
            )));
        };
        if staged.generation != expected_generation
            || active_generation.checked_add(1) != Some(expected_generation)
        {
            return Err(SecureStoreError::CloudCredentialGenerationConflict(
                format!(
                    "[{}] 期望提交 generation {expected_generation}，但 active={active_generation}、staged={}；\
                     staged 基线已过期，请重读后重新 stage",
                    CLOUD_CREDENTIALS_GENERATION_CONFLICT_CODE, staged.generation
                ),
            ));
        }

        // pointer 写失败时用于回滚 active 的快照（明文 JSON，仅驻留本调用栈）。
        let previous_active = self.get_secret(CLOUD_STORAGE_KEY)?;

        // 步骤 1：写新 active。镜像 update_cloud_credentials 的语义：合并结果
        // 无任何 secret 时删除整条 active 记录而不是写空壳。失败 = 什么都没改。
        if staged.credentials.has_any_secret() {
            self.save_cloud_credentials(&staged.credentials)?;
        } else {
            self.delete_secret(CLOUD_STORAGE_KEY)?;
        }

        // 步骤 2：推进 pointer。失败则尽力写回旧 active（fail-closed：pointer
        // 未推进的世界里 active 必须仍是旧内容），staged 保留供重试。
        if let Err(error) = self.save_secret(
            CLOUD_STORAGE_GENERATION_KEY,
            &expected_generation.to_string(),
        ) {
            let restore = match previous_active.as_deref() {
                Some(json) => self.save_secret(CLOUD_STORAGE_KEY, json),
                None => self.delete_secret(CLOUD_STORAGE_KEY),
            };
            if let Err(restore_error) = restore {
                warn!(
                    "云凭据提交失败且回滚 active 也失败（staged 保留，可重放 commit 收敛）: \
                     pointer 错误={error}, 回滚错误={restore_error}"
                );
            }
            return Err(error);
        }

        // 步骤 3：删 staged。至此提交已持久化；删除失败如实报错，
        // 调用方用相同 expected_generation 重放本函数即可走清理分支收敛。
        self.delete_secret(CLOUD_STORAGE_STAGED_KEY)
    }

    /// 丢弃 staged 槽：generation 匹配则删除；staged 缺失视为成功（幂等）。
    /// generation 不匹配 fail-closed 报冲突——staged 可能属于另一次进行中的
    /// 更新，不许拿过期句柄误删。staged 内容损坏时允许删除（它永远无法通过
    /// commit 的解析校验，abort 是唯一的清障出口）。
    pub fn abort_staged_cloud_credentials(
        &self,
        expected_generation: u64,
    ) -> Result<(), SecureStoreError> {
        let Some(json) = self.get_secret(CLOUD_STORAGE_STAGED_KEY)? else {
            return Ok(());
        };
        match serde_json::from_str::<StagedCloudCredentials>(&json) {
            Ok(record) if record.generation == expected_generation => {
                self.delete_secret(CLOUD_STORAGE_STAGED_KEY)
            }
            Ok(record) => Err(SecureStoreError::CloudCredentialGenerationConflict(
                format!(
                    "[{}] staged generation {} 与期望 {} 不符，拒绝丢弃",
                    CLOUD_CREDENTIALS_GENERATION_CONFLICT_CODE,
                    record.generation,
                    expected_generation
                ),
            )),
            Err(parse_error) => {
                warn!("清除无法解析的云凭据 staged 记录: {parse_error}");
                self.delete_secret(CLOUD_STORAGE_STAGED_KEY)
            }
        }
    }

    /// 事务化全清：快照 active + staged + generation pointer 三条记录后逐一
    /// 删除；任一步失败则尽力写回快照并**如实上抛原始错误**（绝不静默成功）。
    ///
    /// 删除顺序 staged → active → pointer：崩溃残留的任何组合都安全——
    /// pointer 残留而 active 缺失时读路径返回「未配置」，staged 已先删不会被
    /// 后续 commit 复活。快照读取本身失败时直接报错，什么都不删。
    pub fn delete_cloud_credentials_transactional(&self) -> Result<(), SecureStoreError> {
        let snapshot_active = self.get_secret(CLOUD_STORAGE_KEY)?;
        let snapshot_staged = self.get_secret(CLOUD_STORAGE_STAGED_KEY)?;
        let snapshot_generation = self.get_secret(CLOUD_STORAGE_GENERATION_KEY)?;

        let result = self
            .delete_secret(CLOUD_STORAGE_STAGED_KEY)
            .and_then(|()| self.delete_secret(CLOUD_STORAGE_KEY))
            .and_then(|()| self.delete_secret(CLOUD_STORAGE_GENERATION_KEY));

        if let Err(error) = result {
            for (key, snapshot) in [
                (CLOUD_STORAGE_KEY, &snapshot_active),
                (CLOUD_STORAGE_STAGED_KEY, &snapshot_staged),
                (CLOUD_STORAGE_GENERATION_KEY, &snapshot_generation),
            ] {
                if let Some(value) = snapshot.as_deref() {
                    if let Err(restore_error) = self.save_secret(key, value) {
                        warn!("事务化删除失败后写回快照 {key} 也失败: {restore_error}");
                    }
                }
            }
            return Err(error);
        }
        Ok(())
    }
}

// ==================== Tauri 命令 ====================

use crate::error_details::CommandError;

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

/// 保存云存储凭据到安全存储。
///
/// `encryption_password_is_preexisting`：前端在「重输存量口令」入口（换机/
/// 重装恢复、legacy 云配置迁移）置 true，跳过新设口令的最小长度与
/// [Wave2-R5] 弱口令准入；缺省/false 保持新设口令 fail-closed。
#[tauri::command]
pub fn secure_save_cloud_credentials(
    app: tauri::AppHandle,
    credentials: CloudStorageCredentials,
    encryption_password_is_preexisting: Option<bool>,
) -> Result<CloudStorageCredentialStatus, CommandError> {
    let store = get_secure_store(Some(&app));
    store
        .update_cloud_credentials_with_policy(
            &credentials,
            encryption_password_is_preexisting.unwrap_or(false),
        )
        .map_err(|e| e.to_command_error("save_cloud_credentials"))
}

/// 获取云存储凭据存在状态；绝不向 WebView 返回 secret 值。
#[tauri::command]
pub fn secure_get_cloud_credentials(
    app: tauri::AppHandle,
) -> Result<CloudStorageCredentialStatus, CommandError> {
    let store = get_secure_store(Some(&app));
    store
        .cloud_credential_status()
        .map_err(|e| e.to_command_error("get_cloud_credentials"))
}

pub(crate) fn delete_cloud_credentials_for_app(
    app: &tauri::AppHandle,
) -> Result<(), SecureStoreError> {
    get_secure_store(Some(app)).delete_cloud_credentials()
}

/// 删除云存储凭据
#[tauri::command]
pub fn secure_delete_cloud_credentials(app: tauri::AppHandle) -> Result<(), CommandError> {
    delete_cloud_credentials_for_app(&app)
        .map_err(|e| e.to_command_error("delete_cloud_credentials"))
}

/// 显式停用端到端加密：仅从安全存储删除加密密码，传输凭据不受影响。
#[tauri::command]
pub fn secure_clear_cloud_encryption_password(
    app: tauri::AppHandle,
) -> Result<CloudStorageCredentialStatus, CommandError> {
    let store = get_secure_store(Some(&app));
    store
        .clear_cloud_encryption_password()
        .map_err(|e| e.to_command_error("clear_cloud_encryption_password"))
}

/// 检查安全存储是否可用
#[tauri::command]
pub fn secure_store_is_available(app: tauri::AppHandle) -> bool {
    let store = get_secure_store(Some(&app));
    store.is_available()
}

/// 查询「系统钥匙串保护」状态（只读文件系统，不触碰密钥库）
#[tauri::command]
pub fn secure_store_get_keystore_protection(
    app: tauri::AppHandle,
) -> Result<KeystoreProtectionStatus, CommandError> {
    let store = get_secure_store(Some(&app));
    store
        .keystore_protection_status()
        .map_err(|e| e.to_command_error("get_keystore_protection"))
}

/// 开启/关闭「系统钥匙串保护」并立即执行种子迁移。
/// 迁移涉及密钥库读写，可能阻塞在系统授权弹窗上，故用 async 让出主线程。
#[tauri::command]
pub async fn secure_store_set_keystore_protection(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<KeystoreProtectionStatus, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = get_secure_store(Some(&app));
        store
            .set_keystore_protection(enabled)
            .map_err(|e| e.to_command_error("set_keystore_protection"))?;
        store
            .keystore_protection_status()
            .map_err(|e| e.to_command_error("get_keystore_protection"))
    })
    .await
    .map_err(|e| CommandError::new("SECURE_STORE_INTERNAL", format!("任务执行失败: {}", e)))?
}

// ==================== 凭据后端自取（hydrate） ====================

/// 用安全存储中的凭据重建 `CloudStorageConfig` 的敏感字段。
///
/// [P0-3A] 前端的常规调用路径（同步、冲突检测、状态查询等）不再携带明文
/// 凭据——密码字段传空串，由各 Tauri 命令在入口处调用本函数从安全存储补全。
/// 这样明文凭据只在用户首次录入时经过一次 IPC，之后不再往返于前端。
///
/// 安全存储是 secret 的唯一事实源：即使调用方构造了非空 secret，也会先被
/// 丢弃，再用安全存储中的值覆盖。读取失败或尚未保存凭据时保留空值，使后续
/// `CloudStorageConfig::validate` fail-closed，而不是接受 IPC 注入的 secret。
fn apply_cloud_credentials(
    config: &mut crate::cloud_storage::CloudStorageConfig,
    credentials: Option<&CloudStorageCredentials>,
) {
    if let Some(webdav) = config.webdav.as_mut() {
        webdav.password = credentials
            .and_then(|value| value.webdav_password.as_deref())
            .filter(|password| !password.trim().is_empty())
            .unwrap_or_default()
            .to_string();
    }
    if let Some(s3) = config.s3.as_mut() {
        s3.secret_access_key = credentials
            .and_then(|value| value.s3_secret_access_key.as_deref())
            .filter(|secret| !secret.trim().is_empty())
            .unwrap_or_default()
            .to_string();
    }
    if let Some(ftp) = config.ftp.as_mut() {
        ftp.password = credentials
            .and_then(|value| value.ftp_password.as_deref())
            .filter(|password| !password.trim().is_empty())
            .unwrap_or_default()
            .to_string();
    }
    config.encryption_password = credentials
        .and_then(|value| value.encryption_password.as_ref())
        .filter(|p| !p.trim().is_empty())
        .cloned();
}

fn replace_with_persisted_cloud_config(
    config: &mut crate::cloud_storage::CloudStorageConfig,
    persisted: Option<crate::cloud_config_commands::SafeCloudStorageConfig>,
) {
    *config = persisted
        .map(crate::cloud_config_commands::SafeCloudStorageConfig::into_runtime_config)
        .unwrap_or_default();
}

pub(crate) fn hydrate_cloud_config_credentials(
    app: &tauri::AppHandle,
    config: &mut crate::cloud_storage::CloudStorageConfig,
) {
    let store = get_secure_store(Some(app));
    let credentials = match store.get_cloud_credentials() {
        Ok(credentials) => credentials,
        Err(error) => {
            warn!(
                "读取云存储凭据失败（清空 IPC secret 并 fail-closed）: {}",
                error
            );
            None
        }
    };
    apply_cloud_credentials(config, credentials.as_ref());
}

pub fn hydrate_cloud_config(
    app: &tauri::AppHandle,
    config: &mut crate::cloud_storage::CloudStorageConfig,
) {
    // Non-secret runtime metadata is never trusted from IPC. Rebuild it from
    // the active database SSOT so the backend record is the sole authority and
    // the non-serializable insecure-transport capability can only originate
    // from a validated persisted allow_insecure decision.
    let persisted = app
        .try_state::<crate::commands::AppState>()
        .and_then(|state| {
            match crate::cloud_config_commands::load_cloud_config_ssot(&state.database) {
                Ok(config) => Some(config),
                Err(crate::cloud_config_commands::CloudConfigSsotError::NotConfigured) => None,
                Err(error) => {
                    warn!(
                        "读取后端云配置 SSOT 失败（清空 IPC 配置并 fail-closed）: {}",
                        error
                    );
                    None
                }
            }
        });
    replace_with_persisted_cloud_config(config, persisted);
    hydrate_cloud_config_credentials(app, config);
}

#[cfg(test)]
mod cloud_hydration_tests {
    use super::*;
    use crate::cloud_config_commands::{SafeCloudStorageConfig, SafeWebDavConfig};
    use crate::cloud_storage::{
        CloudStorageConfig, FtpConfig, S3Config, StorageProvider, WebDavConfig,
    };
    use tempfile::TempDir;

    #[test]
    fn backend_hydration_fills_only_secret_fields() {
        let mut config = CloudStorageConfig {
            provider: StorageProvider::WebDav,
            webdav: Some(WebDavConfig {
                endpoint: "https://dav.example.test".to_string(),
                username: "student".to_string(),
                password: String::new(),
            }),
            s3: Some(S3Config {
                endpoint: "https://s3.example.test".to_string(),
                bucket: "coursework".to_string(),
                access_key_id: "public-id".to_string(),
                secret_access_key: String::new(),
                region: None,
                path_style: false,
            }),
            ftp: Some(FtpConfig {
                host: "ftp.example.test".to_string(),
                port: 21,
                username: "student".to_string(),
                password: String::new(),
                use_tls: true,
            }),
            root: Some("coursework".to_string()),
            encryption_password: None,
            insecure_transport_authorized: false,
        };
        let credentials = CloudStorageCredentials {
            webdav_password: Some("webdav-secret".to_string()),
            s3_secret_access_key: Some("s3-secret".to_string()),
            ftp_password: Some("ftp-secret".to_string()),
            encryption_password: Some("encryption-secret".to_string()),
        };

        apply_cloud_credentials(&mut config, Some(&credentials));

        assert_eq!(config.webdav.unwrap().password, "webdav-secret");
        assert_eq!(config.s3.unwrap().secret_access_key, "s3-secret");
        assert_eq!(config.ftp.unwrap().password, "ftp-secret");
        assert_eq!(
            config.encryption_password.as_deref(),
            Some("encryption-secret")
        );
        assert_eq!(config.root.as_deref(), Some("coursework"));
    }

    #[test]
    fn hydration_rejects_ipc_secret_in_favor_of_secure_store() {
        let mut config = CloudStorageConfig {
            provider: StorageProvider::WebDav,
            webdav: Some(WebDavConfig {
                endpoint: "https://dav.example.test".to_string(),
                username: "student".to_string(),
                password: "new-secret".to_string(),
            }),
            ..Default::default()
        };
        let credentials = CloudStorageCredentials {
            webdav_password: Some("stored-secret".to_string()),
            s3_secret_access_key: None,
            ftp_password: None,
            encryption_password: None,
        };

        apply_cloud_credentials(&mut config, Some(&credentials));

        assert_eq!(config.webdav.unwrap().password, "stored-secret");
    }

    #[test]
    fn hydration_clears_ipc_secrets_when_secure_store_is_empty() {
        let mut config = CloudStorageConfig {
            provider: StorageProvider::WebDav,
            webdav: Some(WebDavConfig {
                endpoint: "https://dav.example.test".to_string(),
                username: "student".to_string(),
                password: "ipc-secret".to_string(),
            }),
            encryption_password: Some("ipc-encryption-secret".to_string()),
            ..Default::default()
        };

        apply_cloud_credentials(&mut config, None);

        assert_eq!(config.webdav.unwrap().password, "");
        assert!(config.encryption_password.is_none());
    }

    #[test]
    fn persisted_nonsecret_config_replaces_the_complete_ipc_shape() {
        let mut config = CloudStorageConfig {
            provider: StorageProvider::WebDav,
            webdav: Some(WebDavConfig {
                endpoint: "http://attacker.example.test".to_string(),
                username: "attacker".to_string(),
                password: "ipc-secret".to_string(),
            }),
            root: Some("attacker-root".to_string()),
            ..Default::default()
        };
        let persisted = SafeCloudStorageConfig::Webdav {
            webdav: SafeWebDavConfig {
                endpoint: "https://persisted.example.test".to_string(),
                username: "persisted-user".to_string(),
            },
            root: Some("persisted-root".to_string()),
            allow_insecure: false,
        };

        replace_with_persisted_cloud_config(&mut config, Some(persisted));

        let webdav = config.webdav.as_ref().expect("persisted WebDAV config");
        assert_eq!(webdav.endpoint, "https://persisted.example.test");
        assert_eq!(webdav.username, "persisted-user");
        assert_eq!(webdav.password, "");
        assert_eq!(config.root.as_deref(), Some("persisted-root"));
        assert!(!config.insecure_transport_authorized);
    }

    #[test]
    fn missing_backend_ssot_discards_the_complete_ipc_shape() {
        let mut config = CloudStorageConfig {
            provider: StorageProvider::Ftp,
            ftp: Some(FtpConfig {
                host: "ftp.example.test".to_string(),
                port: 21,
                username: "attacker".to_string(),
                password: "ipc-secret".to_string(),
                use_tls: false,
            }),
            ..Default::default()
        };

        replace_with_persisted_cloud_config(&mut config, None);

        assert!(config.webdav.is_none());
        assert!(config.s3.is_none());
        assert!(config.ftp.is_none());
        assert!(!config.insecure_transport_authorized);
    }

    #[test]
    fn credential_status_never_serializes_secret_values() {
        let credentials = CloudStorageCredentials {
            webdav_password: Some("webdav-secret".to_string()),
            s3_secret_access_key: Some("s3-secret".to_string()),
            ftp_password: Some("ftp-secret".to_string()),
            encryption_password: Some("encryption-secret".to_string()),
        };

        let encoded = serde_json::to_string(&credentials.status()).expect("serialize status");
        assert_eq!(
            encoded,
            r#"{"webdavPasswordConfigured":true,"s3SecretAccessKeyConfigured":true,"ftpPasswordConfigured":true,"encryptionPasswordConfigured":true}"#
        );
        assert!(!encoded.contains("secret"));
    }

    #[test]
    fn debug_output_redacts_all_secret_values() {
        let credentials = CloudStorageCredentials {
            webdav_password: Some("webdav-secret".to_string()),
            s3_secret_access_key: Some("s3-secret".to_string()),
            ftp_password: Some("ftp-secret".to_string()),
            encryption_password: Some("encryption-secret".to_string()),
        };

        for rendered in [format!("{:?}", credentials), format!("{:#?}", credentials)] {
            for plaintext in [
                "webdav-secret",
                "s3-secret",
                "ftp-secret",
                "encryption-secret",
            ] {
                assert!(
                    !rendered.contains(plaintext),
                    "Debug 输出不得包含明文 {plaintext}: {rendered}"
                );
            }
            assert!(rendered.contains("[REDACTED]"));
            // 字段名保留，便于排障时定位
            assert!(rendered.contains("webdav_password"));
            assert!(rendered.contains("s3_secret_access_key"));
            assert!(rendered.contains("ftp_password"));
            assert!(rendered.contains("encryption_password"));
        }
    }

    #[test]
    fn debug_output_preserves_presence_information() {
        let credentials = CloudStorageCredentials {
            webdav_password: Some("webdav-secret".to_string()),
            ..Default::default()
        };

        let rendered = format!("{:?}", credentials);
        assert_eq!(
            rendered,
            "CloudStorageCredentials { \
             webdav_password: Some(\"[REDACTED]\"), \
             s3_secret_access_key: None, \
             ftp_password: None, \
             encryption_password: None }"
        );
    }

    #[test]
    fn credential_update_preserves_omitted_backend_secrets() {
        let mut credentials = CloudStorageCredentials {
            webdav_password: Some("stored-webdav".to_string()),
            encryption_password: Some("stored-encryption".to_string()),
            ..Default::default()
        };
        credentials.apply_nonempty_update(&CloudStorageCredentials {
            s3_secret_access_key: Some("new-s3".to_string()),
            webdav_password: Some(" ".to_string()),
            ..Default::default()
        });

        assert_eq!(
            credentials.webdav_password.as_deref(),
            Some("stored-webdav")
        );
        assert_eq!(
            credentials.encryption_password.as_deref(),
            Some("stored-encryption")
        );
        assert_eq!(credentials.s3_secret_access_key.as_deref(), Some("new-s3"));
    }

    #[test]
    fn short_encryption_password_is_rejected_and_does_not_mark_configured() {
        let dir = TempDir::new().expect("create tempdir");
        let store =
            SecureStore::new_with_dir(SecureStoreConfig::default(), dir.path().to_path_buf());

        let error = store
            .update_cloud_credentials(&CloudStorageCredentials {
                encryption_password: Some("short".to_string()),
                ..Default::default()
            })
            .expect_err("短于 8 字符的云端加密密码必须拒绝");
        assert!(
            matches!(error, SecureStoreError::CloudEncryptionPasswordTooShort(_)),
            "unexpected error: {error}"
        );
        assert_eq!(
            error.stable_code(),
            CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE
        );
        assert!(
            error
                .to_string()
                .contains(&MIN_CLOUD_ENCRYPTION_PASSWORD_CHARS.to_string()),
            "unexpected error: {error}"
        );
        assert!(store
            .get_cloud_credentials()
            .expect("read cloud credentials")
            .is_none());

        let status = store
            .update_cloud_credentials(&CloudStorageCredentials {
                encryption_password: Some("long-enough-password".to_string()),
                ..Default::default()
            })
            .expect("8+ 字符密码应写入");
        assert!(status.encryption_password_configured);
    }

    /// 升级兼容：v0.9.44 没有口令长度下限。换机/重装重输、legacy 迁移提交的
    /// 存量短口令必须放行，否则旧加密备份在产品内永远打不开。
    #[test]
    fn preexisting_short_encryption_password_is_accepted() {
        let dir = TempDir::new().expect("create tempdir");
        let store =
            SecureStore::new_with_dir(SecureStoreConfig::default(), dir.path().to_path_buf());

        let status = store
            .update_cloud_credentials_with_policy(
                &CloudStorageCredentials {
                    encryption_password: Some("short6".to_string()),
                    ..Default::default()
                },
                true,
            )
            .expect("存量短口令（v0.9.44 时代）必须放行");
        assert!(status.encryption_password_configured);

        let stored = store
            .get_cloud_credentials()
            .expect("read cloud credentials")
            .expect("credentials persisted");
        assert_eq!(stored.encryption_password.as_deref(), Some("short6"));
    }

    /// preexisting 只放行存量口令入口；默认（新设）入口仍 fail-closed。
    #[test]
    fn preexisting_policy_does_not_relax_the_default_entry() {
        let dir = TempDir::new().expect("create tempdir");
        let store =
            SecureStore::new_with_dir(SecureStoreConfig::default(), dir.path().to_path_buf());

        let error = store
            .update_cloud_credentials_with_policy(
                &CloudStorageCredentials {
                    encryption_password: Some("short6".to_string()),
                    ..Default::default()
                },
                false,
            )
            .expect_err("新设短口令必须继续拒绝");
        assert!(
            matches!(error, SecureStoreError::CloudEncryptionPasswordTooShort(_)),
            "unexpected error: {error}"
        );
    }

    // ---------------- [Wave2-R5] 新设口令弱口令门 ----------------

    #[test]
    fn weak_password_predicate_semantics() {
        // 黑名单：大小写变体与首尾空白都命中
        assert!(cloud_encryption_password_too_weak(Some("password123")));
        assert!(cloud_encryption_password_too_weak(Some("Password123")));
        assert!(cloud_encryption_password_too_weak(Some("  qwertyuiop  ")));
        assert!(cloud_encryption_password_too_weak(Some("12345678")));
        // 熵下限：通过 8 字符长度门但不同字符 < 4 的口令
        assert!(cloud_encryption_password_too_weak(Some("aaaaaaaa")));
        assert!(cloud_encryption_password_too_weak(Some("abababab")));
        assert!(cloud_encryption_password_too_weak(Some("12121212")));
        // 恰好 4 个不同字符：达到熵下限，放行
        assert!(!cloud_encryption_password_too_weak(Some("aabbccdd")));
        // 正常口令放行
        assert!(!cloud_encryption_password_too_weak(Some(
            "correct horse battery staple"
        )));
        assert!(!cloud_encryption_password_too_weak(Some(
            "long-enough-password"
        )));
        // None / 空 / 纯空白 = 「保留现有值」，不是新设，不判弱
        assert!(!cloud_encryption_password_too_weak(None));
        assert!(!cloud_encryption_password_too_weak(Some("")));
        assert!(!cloud_encryption_password_too_weak(Some("   ")));
    }

    #[test]
    fn new_password_gate_checks_length_before_weakness() {
        // 既短又弱（"1234567" 是 7 字符的低熵串）：长度门在前，错误优先级不变。
        let error = check_new_cloud_encryption_password(Some("1234567"))
            .expect_err("短口令必须先被长度门拒绝");
        assert!(
            matches!(error, SecureStoreError::CloudEncryptionPasswordTooShort(_)),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn new_weak_encryption_password_is_rejected_and_not_persisted() {
        let dir = TempDir::new().expect("create tempdir");
        let store =
            SecureStore::new_with_dir(SecureStoreConfig::default(), dir.path().to_path_buf());

        for weak in ["password123", "aaaaaaaa"] {
            let error = store
                .update_cloud_credentials(&CloudStorageCredentials {
                    encryption_password: Some(weak.to_string()),
                    ..Default::default()
                })
                .expect_err("新设弱口令必须拒绝");
            assert!(
                matches!(error, SecureStoreError::CloudEncryptionPasswordTooWeak(_)),
                "unexpected error: {error}"
            );
            assert_eq!(error.stable_code(), CLOUD_ENCRYPTION_PASSWORD_TOO_WEAK_CODE);
            assert!(
                store
                    .get_cloud_credentials()
                    .expect("read cloud credentials")
                    .is_none(),
                "被拒绝的弱口令不得留下任何持久化痕迹"
            );
        }

        // 正常强度口令照常写入
        let status = store
            .update_cloud_credentials(&CloudStorageCredentials {
                encryption_password: Some("correct horse battery staple".to_string()),
                ..Default::default()
            })
            .expect("正常口令应写入");
        assert!(status.encryption_password_configured);
    }

    /// 升级兼容红线：弱口令检查只影响新设。v0.9.44 时代用户完全可能用
    /// "password123" 加密过备份——换机/重装重输、legacy 迁移必须放行，
    /// 否则旧加密备份在产品内永远打不开。
    #[test]
    fn preexisting_weak_encryption_password_is_accepted() {
        let dir = TempDir::new().expect("create tempdir");
        let store =
            SecureStore::new_with_dir(SecureStoreConfig::default(), dir.path().to_path_buf());

        let status = store
            .update_cloud_credentials_with_policy(
                &CloudStorageCredentials {
                    encryption_password: Some("password123".to_string()),
                    ..Default::default()
                },
                true,
            )
            .expect("存量弱口令必须放行");
        assert!(status.encryption_password_configured);

        let stored = store
            .get_cloud_credentials()
            .expect("read cloud credentials")
            .expect("credentials persisted");
        assert_eq!(stored.encryption_password.as_deref(), Some("password123"));
    }

    #[test]
    fn clearing_encryption_password_keeps_transport_credentials() {
        let dir = TempDir::new().expect("create tempdir");
        let store =
            SecureStore::new_with_dir(SecureStoreConfig::default(), dir.path().to_path_buf());
        store
            .save_cloud_credentials(&CloudStorageCredentials {
                webdav_password: Some("webdav-secret".to_string()),
                encryption_password: Some("encryption-secret".to_string()),
                ..Default::default()
            })
            .expect("save cloud credentials");

        let status = store
            .clear_cloud_encryption_password()
            .expect("clear encryption password");

        assert!(!status.encryption_password_configured);
        assert!(status.webdav_password_configured);
        let remaining = store
            .get_cloud_credentials()
            .expect("read cloud credentials")
            .expect("transport credentials must survive");
        assert_eq!(remaining.webdav_password.as_deref(), Some("webdav-secret"));
        assert!(remaining.encryption_password.is_none());
    }

    #[test]
    fn clearing_the_only_secret_removes_the_record_entirely() {
        let dir = TempDir::new().expect("create tempdir");
        let store =
            SecureStore::new_with_dir(SecureStoreConfig::default(), dir.path().to_path_buf());
        store
            .save_cloud_credentials(&CloudStorageCredentials {
                encryption_password: Some("encryption-secret".to_string()),
                ..Default::default()
            })
            .expect("save cloud credentials");

        let status = store
            .clear_cloud_encryption_password()
            .expect("clear encryption password");

        assert_eq!(status, CloudStorageCredentialStatus::default());
        assert!(store
            .get_cloud_credentials()
            .expect("read cloud credentials")
            .is_none());
    }

    #[test]
    fn clearing_encryption_password_without_stored_credentials_is_a_noop() {
        let dir = TempDir::new().expect("create tempdir");
        let store =
            SecureStore::new_with_dir(SecureStoreConfig::default(), dir.path().to_path_buf());

        let status = store
            .clear_cloud_encryption_password()
            .expect("noop clear must succeed");

        assert_eq!(status, CloudStorageCredentialStatus::default());
    }

    #[test]
    fn successful_cloud_credential_clear_removes_the_secret_record() {
        let dir = TempDir::new().expect("create tempdir");
        let store =
            SecureStore::new_with_dir(SecureStoreConfig::default(), dir.path().to_path_buf());
        store
            .save_cloud_credentials(&CloudStorageCredentials {
                webdav_password: Some("secret".to_string()),
                ..Default::default()
            })
            .expect("save cloud credentials");

        store
            .delete_cloud_credentials()
            .expect("clear cloud credentials");

        assert!(store
            .get_cloud_credentials()
            .expect("read cloud credentials")
            .is_none());
        assert!(!dir
            .path()
            .join(".secure/cloud_storage_credentials.enc")
            .exists());
    }

    // ==================== staged generation 原子发布（R2） ====================

    fn store_in(dir: &TempDir) -> SecureStore {
        SecureStore::new_with_dir(SecureStoreConfig::default(), dir.path().to_path_buf())
    }

    /// 写 staged 不得触碰 active 记录与 generation pointer；staged 的合并基线
    /// 是当前 active（省略字段 = 保留 active 现值）。
    #[test]
    fn staged_write_leaves_active_record_and_generation_untouched() {
        let dir = TempDir::new().expect("create tempdir");
        let store = store_in(&dir);
        store
            .save_cloud_credentials(&CloudStorageCredentials {
                webdav_password: Some("active-webdav".to_string()),
                encryption_password: Some("active-encryption".to_string()),
                ..Default::default()
            })
            .expect("save active credentials");

        // legacy：缺 pointer 键 = generation 0（未版本化记录即 active）
        assert_eq!(
            store
                .cloud_credentials_active_generation()
                .expect("read active generation"),
            0
        );

        let staged_generation = store
            .write_staged_cloud_credentials(
                &CloudStorageCredentials {
                    webdav_password: Some("staged-webdav".to_string()),
                    ..Default::default()
                },
                false,
            )
            .expect("write staged credentials");
        assert_eq!(staged_generation, 1);

        // active 记录与 pointer 均未变
        let active = store
            .get_cloud_credentials()
            .expect("read active credentials")
            .expect("active record must survive staging");
        assert_eq!(active.webdav_password.as_deref(), Some("active-webdav"));
        assert_eq!(
            active.encryption_password.as_deref(),
            Some("active-encryption")
        );
        assert_eq!(
            store
                .cloud_credentials_active_generation()
                .expect("read active generation"),
            0
        );

        // staged 内容 = 以 active 为基线的合并结果（省略的加密口令被保留）
        let staged = store
            .get_staged_cloud_credentials_record()
            .expect("read staged record")
            .expect("staged record persisted");
        assert_eq!(staged.generation, 1);
        assert_eq!(
            staged.credentials.webdav_password.as_deref(),
            Some("staged-webdav")
        );
        assert_eq!(
            staged.credentials.encryption_password.as_deref(),
            Some("active-encryption")
        );
    }

    /// commit 后 generation +1，读路径（get）看到 staged 的合并结果，staged 槽清空。
    #[test]
    fn commit_advances_generation_and_publishes_staged_values() {
        let dir = TempDir::new().expect("create tempdir");
        let store = store_in(&dir);
        store
            .save_cloud_credentials(&CloudStorageCredentials {
                webdav_password: Some("active-webdav".to_string()),
                encryption_password: Some("active-encryption".to_string()),
                ..Default::default()
            })
            .expect("save active credentials");

        let staged_generation = store
            .write_staged_cloud_credentials(
                &CloudStorageCredentials {
                    webdav_password: Some("staged-webdav".to_string()),
                    ..Default::default()
                },
                false,
            )
            .expect("write staged credentials");

        store
            .commit_staged_cloud_credentials(staged_generation)
            .expect("commit staged credentials");

        assert_eq!(
            store
                .cloud_credentials_active_generation()
                .expect("read active generation"),
            1
        );
        let active = store
            .get_cloud_credentials()
            .expect("read active credentials")
            .expect("committed record present");
        assert_eq!(active.webdav_password.as_deref(), Some("staged-webdav"));
        assert_eq!(
            active.encryption_password.as_deref(),
            Some("active-encryption")
        );
        assert!(store
            .get_staged_cloud_credentials_record()
            .expect("read staged record")
            .is_none());

        // 幂等重放：pointer 已推进且 staged 已清空时再次 commit 直接成功
        store
            .commit_staged_cloud_credentials(staged_generation)
            .expect("replayed commit must be idempotent");
    }

    /// abort 只删 staged；active 与 pointer 不动；staged 缺失时幂等成功。
    #[test]
    fn abort_discards_staged_without_touching_active() {
        let dir = TempDir::new().expect("create tempdir");
        let store = store_in(&dir);
        store
            .save_cloud_credentials(&CloudStorageCredentials {
                webdav_password: Some("active-webdav".to_string()),
                ..Default::default()
            })
            .expect("save active credentials");

        let staged_generation = store
            .write_staged_cloud_credentials(
                &CloudStorageCredentials {
                    webdav_password: Some("staged-webdav".to_string()),
                    ..Default::default()
                },
                false,
            )
            .expect("write staged credentials");

        store
            .abort_staged_cloud_credentials(staged_generation)
            .expect("abort staged credentials");

        let active = store
            .get_cloud_credentials()
            .expect("read active credentials")
            .expect("active record must survive abort");
        assert_eq!(active.webdav_password.as_deref(), Some("active-webdav"));
        assert_eq!(
            store
                .cloud_credentials_active_generation()
                .expect("read active generation"),
            0
        );
        assert!(store
            .get_staged_cloud_credentials_record()
            .expect("read staged record")
            .is_none());

        // staged 缺失当成功（幂等）
        store
            .abort_staged_cloud_credentials(staged_generation)
            .expect("abort with missing staged must succeed");
    }

    /// staged 写入的短口令政策与 update_cloud_credentials_with_policy 完全一致：
    /// 新设短口令 fail-closed 拒绝且不留 staged 残留；preexisting 放行并可提交。
    #[test]
    fn staged_write_enforces_the_same_short_password_policy() {
        let dir = TempDir::new().expect("create tempdir");
        let store = store_in(&dir);

        let error = store
            .write_staged_cloud_credentials(
                &CloudStorageCredentials {
                    encryption_password: Some("short6".to_string()),
                    ..Default::default()
                },
                false,
            )
            .expect_err("新设短口令必须继续拒绝");
        assert!(
            matches!(error, SecureStoreError::CloudEncryptionPasswordTooShort(_)),
            "unexpected error: {error}"
        );
        assert_eq!(
            error.stable_code(),
            CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE
        );
        assert!(store
            .get_staged_cloud_credentials_record()
            .expect("read staged record")
            .is_none());

        // 存量口令（v0.9.44 时代）放行，且能走完 commit 全程
        let staged_generation = store
            .write_staged_cloud_credentials(
                &CloudStorageCredentials {
                    encryption_password: Some("short6".to_string()),
                    ..Default::default()
                },
                true,
            )
            .expect("存量短口令（v0.9.44 时代）必须放行");
        store
            .commit_staged_cloud_credentials(staged_generation)
            .expect("commit preexisting short password");
        let active = store
            .get_cloud_credentials()
            .expect("read active credentials")
            .expect("committed record present");
        assert_eq!(active.encryption_password.as_deref(), Some("short6"));
    }

    /// [Wave2-R5] staged 写入的弱口令政策与 update_cloud_credentials_with_policy
    /// 完全一致：新设弱口令 fail-closed 拒绝且不留 staged 残留；preexisting
    /// 放行并可走完 commit 全程。
    #[test]
    fn staged_write_enforces_the_same_weak_password_policy() {
        let dir = TempDir::new().expect("create tempdir");
        let store = store_in(&dir);

        let error = store
            .write_staged_cloud_credentials(
                &CloudStorageCredentials {
                    encryption_password: Some("password123".to_string()),
                    ..Default::default()
                },
                false,
            )
            .expect_err("新设弱口令必须拒绝");
        assert!(
            matches!(error, SecureStoreError::CloudEncryptionPasswordTooWeak(_)),
            "unexpected error: {error}"
        );
        assert_eq!(error.stable_code(), CLOUD_ENCRYPTION_PASSWORD_TOO_WEAK_CODE);
        assert!(store
            .get_staged_cloud_credentials_record()
            .expect("read staged record")
            .is_none());

        // 存量弱口令（v0.9.44 时代）放行，且能走完 commit 全程
        let staged_generation = store
            .write_staged_cloud_credentials(
                &CloudStorageCredentials {
                    encryption_password: Some("password123".to_string()),
                    ..Default::default()
                },
                true,
            )
            .expect("存量弱口令必须放行");
        store
            .commit_staged_cloud_credentials(staged_generation)
            .expect("commit preexisting weak password");
        let active = store
            .get_cloud_credentials()
            .expect("read active credentials")
            .expect("committed record present");
        assert_eq!(active.encryption_password.as_deref(), Some("password123"));
    }

    /// 过期 generation 句柄的 commit / abort 一律 fail-closed 冲突，active 不动。
    #[test]
    fn stale_generation_handles_fail_closed_without_touching_active() {
        let dir = TempDir::new().expect("create tempdir");
        let store = store_in(&dir);
        store
            .save_cloud_credentials(&CloudStorageCredentials {
                webdav_password: Some("active-webdav".to_string()),
                ..Default::default()
            })
            .expect("save active credentials");
        let staged_generation = store
            .write_staged_cloud_credentials(
                &CloudStorageCredentials {
                    webdav_password: Some("staged-webdav".to_string()),
                    ..Default::default()
                },
                false,
            )
            .expect("write staged credentials");

        for stale in [staged_generation + 1, staged_generation + 7] {
            let error = store
                .commit_staged_cloud_credentials(stale)
                .expect_err("过期 generation 的 commit 必须拒绝");
            assert!(
                matches!(
                    error,
                    SecureStoreError::CloudCredentialGenerationConflict(_)
                ),
                "unexpected error: {error}"
            );
            assert_eq!(
                error.stable_code(),
                CLOUD_CREDENTIALS_GENERATION_CONFLICT_CODE
            );
            let error = store
                .abort_staged_cloud_credentials(stale)
                .expect_err("过期 generation 的 abort 必须拒绝");
            assert!(
                matches!(
                    error,
                    SecureStoreError::CloudCredentialGenerationConflict(_)
                ),
                "unexpected error: {error}"
            );
        }

        // active / pointer / staged 全部原样
        let active = store
            .get_cloud_credentials()
            .expect("read active credentials")
            .expect("active record untouched");
        assert_eq!(active.webdav_password.as_deref(), Some("active-webdav"));
        assert_eq!(
            store
                .cloud_credentials_active_generation()
                .expect("read active generation"),
            0
        );
        assert!(store
            .get_staged_cloud_credentials_record()
            .expect("read staged record")
            .is_some());
    }

    /// 缺 staged 时 commit 报 KeyNotFound（而不是静默成功或推进 pointer）。
    #[test]
    fn commit_without_staged_record_fails_closed() {
        let dir = TempDir::new().expect("create tempdir");
        let store = store_in(&dir);

        let error = store
            .commit_staged_cloud_credentials(1)
            .expect_err("缺 staged 记录的 commit 必须拒绝");
        assert!(
            matches!(error, SecureStoreError::KeyNotFound(_)),
            "unexpected error: {error}"
        );
        assert_eq!(
            store
                .cloud_credentials_active_generation()
                .expect("read active generation"),
            0
        );
    }

    /// 事务化删除把 active + staged + pointer 三条记录一起清掉。
    #[test]
    fn transactional_delete_clears_active_staged_and_generation() {
        let dir = TempDir::new().expect("create tempdir");
        let store = store_in(&dir);
        store
            .save_cloud_credentials(&CloudStorageCredentials {
                webdav_password: Some("active-webdav".to_string()),
                ..Default::default()
            })
            .expect("save active credentials");
        let staged_generation = store
            .write_staged_cloud_credentials(
                &CloudStorageCredentials {
                    webdav_password: Some("next-webdav".to_string()),
                    ..Default::default()
                },
                false,
            )
            .expect("write staged credentials");
        store
            .commit_staged_cloud_credentials(staged_generation)
            .expect("commit staged credentials");
        // 再留一份未提交的 staged，验证三条记录全被清理
        store
            .write_staged_cloud_credentials(
                &CloudStorageCredentials {
                    webdav_password: Some("orphan-webdav".to_string()),
                    ..Default::default()
                },
                false,
            )
            .expect("write orphan staged credentials");

        store
            .delete_cloud_credentials_transactional()
            .expect("transactional delete");

        assert!(store
            .get_cloud_credentials()
            .expect("read active credentials")
            .is_none());
        assert!(store
            .get_staged_cloud_credentials_record()
            .expect("read staged record")
            .is_none());
        assert_eq!(
            store
                .cloud_credentials_active_generation()
                .expect("read active generation"),
            0
        );
        for file in [
            "cloud_storage_credentials.enc",
            "cloud_storage_credentials_staged.enc",
            "cloud_storage_credentials_generation.enc",
        ] {
            assert!(
                !dir.path().join(".secure").join(file).exists(),
                "{file} 必须被事务化删除清理"
            );
        }
    }
}
