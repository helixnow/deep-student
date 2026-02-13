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
use tracing::{debug, info, warn};

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

    /// 获取安全存储目录（优先使用实例的 secure_dir，回退到静态路径）
    fn get_secure_dir(&self) -> Result<std::path::PathBuf, SecureStoreError> {
        if let Some(ref dir) = self.secure_dir {
            // 使用传入的 app_data_dir（稳定路径）
            std::fs::create_dir_all(dir)
                .map_err(|e| SecureStoreError::Other(format!("创建安全目录失败: {}", e)))?;
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
            Ok(()) => Ok(candidate),
            Err(primary_err) => {
                // 在沙箱/权限受限环境下回退到临时目录，避免直接失败
                let fallback = std::env::temp_dir().join("deep-student").join(".secure");
                std::fs::create_dir_all(&fallback).map_err(|fallback_err| {
                    SecureStoreError::Other(format!(
                        "创建安全目录失败: primary={}, fallback={}",
                        primary_err, fallback_err
                    ))
                })?;
                Ok(fallback)
            }
        }
    }

    /// 获取或创建主密钥种子（稳定存储在 .key_seed）
    fn get_or_create_master_seed(&self) -> Result<String, SecureStoreError> {
        let secure_dir = self.get_secure_dir()?;
        let seed_file = secure_dir.join(".key_seed");

        if let Ok(seed) = std::fs::read_to_string(&seed_file) {
            let trimmed = seed.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed.to_string());
            }
        }

        use rand::RngCore;
        let mut seed_bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut seed_bytes);
        let seed = hex::encode(seed_bytes);
        std::fs::write(&seed_file, &seed)
            .map_err(|e| SecureStoreError::Other(format!("写入密钥种子失败: {}", e)))?;
        Ok(seed)
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
    fn get_device_key(&self) -> [u8; 32] {
        match self.get_or_create_master_seed() {
            Ok(seed) => Self::derive_key(&seed, b"deep-student-secure-salt-v3"),
            Err(e) => {
                warn!("获取主密钥种子失败，降级到 legacy 密钥: {}", e);
                self.get_legacy_device_key()
            }
        }
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
        let result = hasher.finalize();
        let mut key = [0u8; 32];
        key.copy_from_slice(&result);
        key
    }

    fn encrypt_with_key(key: &[u8; 32], value: &str) -> Result<Vec<u8>, SecureStoreError> {
        use aes_gcm::aead::{Aead, KeyInit};
        use aes_gcm::{Aes256Gcm, Key, Nonce};
        use rand::RngCore;

        let encryption_key = Key::<Aes256Gcm>::from_slice(key);
        let cipher = Aes256Gcm::new(encryption_key);

        let mut nonce_bytes = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
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
        let file_path = secure_dir.join(format!("{}.enc", key.replace("/", "_")));

        let device_key = self.get_device_key();
        let data = Self::encrypt_with_key(&device_key, value)?;

        std::fs::write(&file_path, &data)
            .map_err(|e| SecureStoreError::Other(format!("写入文件失败: {}", e)))?;

        debug!("✅ 凭据已加密存储: {}", key);
        Ok(())
    }

    fn get_encrypted_file(&self, key: &str) -> Result<Option<String>, SecureStoreError> {
        let secure_dir = self.get_secure_dir()?;
        let file_path = secure_dir.join(format!("{}.enc", key.replace("/", "_")));

        if !file_path.exists() {
            return Ok(None);
        }

        let data = std::fs::read(&file_path)
            .map_err(|e| SecureStoreError::Other(format!("读取文件失败: {}", e)))?;

        let device_key = self.get_device_key();
        match Self::decrypt_with_key(&device_key, &data) {
            Ok(plaintext) => Ok(Some(plaintext)),
            Err(primary_err) => {
                // 兼容旧版本密钥：允许读旧数据并在成功后自动重加密到新密钥
                let legacy_key = self.get_legacy_device_key();
                match Self::decrypt_with_key(&legacy_key, &data) {
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
        let secure_dir = self.get_secure_dir()?;
        let file_path = secure_dir.join(format!("{}.enc", key.replace("/", "_")));

        if file_path.exists() {
            std::fs::remove_file(&file_path)
                .map_err(|e| SecureStoreError::Other(format!("删除文件失败: {}", e)))?;
        }
        debug!("✅ 凭据已删除: {}", key);
        Ok(())
    }

    /// 获取所有敏感键
    pub fn list_sensitive_keys(&self) -> Result<HashSet<String>, SecureStoreError> {
        // keyring 不支持列出所有键，返回空集合
        Ok(HashSet::new())
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

        let first = store.get_device_key();
        let second = store.get_device_key();

        assert_eq!(first, second);
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
fn get_secure_store() -> SecureStore {
    SecureStore::new(SecureStoreConfig::default())
}

/// 保存云存储凭据到安全存储
#[tauri::command]
pub fn secure_save_cloud_credentials(credentials: CloudStorageCredentials) -> Result<(), AppError> {
    let store = get_secure_store();
    store
        .save_cloud_credentials(&credentials)
        .map_err(|e| AppError::internal(format!("保存凭据失败: {}", e)))
}

/// 获取云存储凭据
#[tauri::command]
pub fn secure_get_cloud_credentials() -> Result<Option<CloudStorageCredentials>, AppError> {
    let store = get_secure_store();
    store
        .get_cloud_credentials()
        .map_err(|e| AppError::internal(format!("获取凭据失败: {}", e)))
}

/// 删除云存储凭据
#[tauri::command]
pub fn secure_delete_cloud_credentials() -> Result<(), AppError> {
    let store = get_secure_store();
    store
        .delete_cloud_credentials()
        .map_err(|e| AppError::internal(format!("删除凭据失败: {}", e)))
}

/// 检查安全存储是否可用
#[tauri::command]
pub fn secure_store_is_available() -> bool {
    let store = get_secure_store();
    store.is_available()
}
