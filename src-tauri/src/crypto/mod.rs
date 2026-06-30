pub mod backup_crypto;
pub mod tests;

// =====================================================================================
// AES-GCM 加密服务实现
// =====================================================================================

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose, Engine as _};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use zeroize::Zeroize;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptedData {
    pub ciphertext: String,
    pub nonce: String,
    #[serde(default)]
    pub version: Option<u8>,
}

#[derive(Debug)]
pub struct CryptoService {
    key_path: PathBuf,
    master_key: [u8; 32],
}

impl Drop for CryptoService {
    fn drop(&mut self) {
        self.master_key.zeroize();
    }
}

impl CryptoService {
    /// 初始化加密服务：自动加载或生成主密钥
    pub fn new(path: &Path) -> Result<Self> {
        let key_path = path.join(".master_key");
        tracing::info!("🔐 [Crypto] 初始化加密服务，密钥路径: {:?}", key_path);
        let master_key = Self::load_or_create_master_key(&key_path)?;
        let fp = Sha256::digest(&master_key);
        let key_fingerprint = format!("{:02x}{:02x}{:02x}{:02x}", fp[0], fp[1], fp[2], fp[3]);
        tracing::info!("🔐 [Crypto] 主密钥指纹: {}...", key_fingerprint);
        Ok(Self {
            key_path,
            master_key,
        })
    }

    fn load_or_create_master_key(key_path: &Path) -> Result<[u8; 32]> {
        if key_path.exists() {
            tracing::info!("🔐 [Crypto] 加载已有主密钥: {:?}", key_path);
            let mut file = OpenOptions::new()
                .read(true)
                .open(key_path)
                .with_context(|| format!("无法打开主密钥文件: {:?}", key_path))?;
            let mut encoded = String::new();
            file.read_to_string(&mut encoded)?;
            let mut bytes = general_purpose::STANDARD
                .decode(encoded.trim())
                .map_err(|e| anyhow!("主密钥Base64解码失败: {}", e))?;
            encoded.zeroize();
            if bytes.len() != 32 {
                bytes.zeroize();
                return Err(anyhow!("主密钥长度无效，预期32字节，实际{}", bytes.len()));
            }
            let mut key = [0u8; 32];
            key.copy_from_slice(&bytes);
            bytes.zeroize();
            Ok(key)
        } else {
            tracing::warn!("🔐 [Crypto] 主密钥文件不存在，将创建新密钥: {:?}", key_path);
            Self::create_master_key(key_path)
        }
    }

    /// 生成并持久化一把全新的主密钥（覆盖已有文件）
    fn create_master_key(key_path: &Path) -> Result<[u8; 32]> {
        if let Some(parent) = key_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut key = [0u8; 32];
        OsRng.fill_bytes(&mut key);
        let mut encoded = general_purpose::STANDARD.encode(key);
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(key_path)
            .with_context(|| format!("无法创建主密钥文件: {:?}", key_path))?;
        file.write_all(encoded.as_bytes())?;
        encoded.zeroize();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = fs::Permissions::from_mode(0o600);
            fs::set_permissions(key_path, perms)?;
        }
        #[cfg(windows)]
        {
            // F8: best-effort 收紧 .master_key 的 ACL（owner+SYSTEM+Administrators，移除继承），
            // 等价于 Unix 0600。失败仅告警、不阻断密钥创建（文件已写入且 owner 可读）。
            Self::restrict_master_key_acl_windows(key_path);
        }
        tracing::info!("🔐 [Crypto] 新主密钥已创建");
        Ok(key)
    }

    /// F8: 用 `icacls` 把 `.master_key` 收紧为「仅 owner + SYSTEM + Administrators」。best-effort。
    #[cfg(windows)]
    fn restrict_master_key_acl_windows(key_path: &Path) {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        let user = match std::env::var("USERNAME") {
            Ok(u) if !u.trim().is_empty() => match std::env::var("USERDOMAIN") {
                Ok(d) if !d.trim().is_empty() => format!("{}\\{}", d.trim(), u.trim()),
                _ => u.trim().to_string(),
            },
            _ => {
                tracing::warn!("跳过 .master_key ACL 收紧：无法解析当前用户(USERNAME)");
                return;
            }
        };
        let grants = [
            format!("{}:(F)", user),
            "*S-1-5-18:(F)".to_string(),     // SYSTEM
            "*S-1-5-32-544:(F)".to_string(), // Administrators
        ];
        let mut cmd = Command::new("icacls");
        cmd.arg(key_path).arg("/inheritance:r");
        for g in &grants {
            cmd.arg("/grant:r").arg(g);
        }
        match cmd.creation_flags(0x08000000).output() {
            Ok(out) if out.status.success() => {}
            Ok(out) => tracing::warn!(
                "icacls 收紧 .master_key 权限未成功: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ),
            Err(e) => tracing::warn!("无法执行 icacls 收紧 .master_key 权限: {}", e),
        }
    }

    fn cipher(&self) -> Aes256Gcm {
        Aes256Gcm::new_from_slice(&self.master_key).expect("无效的AES主密钥")
    }

    fn generate_nonce() -> [u8; 12] {
        let mut bytes = [0u8; 12];
        OsRng.fill_bytes(&mut bytes);
        bytes
    }

    pub fn encrypt_api_key(&self, plaintext: &str) -> Result<EncryptedData> {
        if plaintext.is_empty() {
            return Ok(EncryptedData {
                ciphertext: String::new(),
                nonce: String::new(),
                version: Some(2),
            });
        }

        let cipher = self.cipher();
        let nonce_bytes = Self::generate_nonce();
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ciphertext = cipher
            .encrypt(nonce, plaintext.as_bytes())
            .map_err(|e| anyhow!("AES-GCM 加密失败: {}", e))?;

        Ok(EncryptedData {
            ciphertext: general_purpose::STANDARD.encode(ciphertext),
            nonce: general_purpose::STANDARD.encode(nonce_bytes),
            version: Some(2),
        })
    }

    pub fn decrypt_api_key(&self, data: &EncryptedData) -> Result<String> {
        if data.version == Some(2) {
            // 处理空密钥的特殊情况（encrypt_api_key 对空字符串返回空 nonce/ciphertext）
            if data.ciphertext.is_empty() && data.nonce.is_empty() {
                return Ok(String::new());
            }
            self.decrypt_modern(data)
        } else {
            // 回退到旧版（Base64编码）
            let decoded = general_purpose::STANDARD
                .decode(&data.ciphertext)
                .map_err(|e| anyhow!("Base64 解码旧版密钥失败: {}", e))?;
            let s = String::from_utf8(decoded)?;
            Ok(s)
        }
    }

    fn decrypt_modern(&self, data: &EncryptedData) -> Result<String> {
        let nonce_bytes = general_purpose::STANDARD
            .decode(&data.nonce)
            .map_err(|e| anyhow!("解码 nonce 失败: {}", e))?;
        if nonce_bytes.len() != 12 {
            return Err(anyhow!("nonce 长度无效，预期12字节"));
        }
        let ciphertext = general_purpose::STANDARD
            .decode(&data.ciphertext)
            .map_err(|e| anyhow!("解码密文失败: {}", e))?;
        let nonce = Nonce::from_slice(&nonce_bytes);
        let cipher = self.cipher();
        let plaintext = cipher
            .decrypt(nonce, ciphertext.as_ref())
            .map_err(|e| anyhow!("AES-GCM 解密失败: {}", e))?;
        Ok(String::from_utf8(plaintext)?)
    }

    pub fn is_encrypted_format(s: &str) -> bool {
        serde_json::from_str::<EncryptedData>(s).is_ok()
    }

    pub fn migrate_plaintext_key(&self, plaintext: &str) -> Result<String> {
        let encrypted = self.encrypt_api_key(plaintext)?;
        Ok(serde_json::to_string(&encrypted)?)
    }

    /// 轮换主密钥：在 `new_path` 目录下强制生成全新的 `.master_key` 并覆盖同名旧文件。
    ///
    /// # 安全语义（重要）
    ///
    /// 本方法**只换钥匙，不搬数据**：旧密钥加密的所有密文（如已存储的 API Key）
    /// 在轮换后将永久无法解密。调用方若需保留既有数据，必须自行实现
    /// "旧实例解密 → 新实例重加密" 的迁移流程后再丢弃旧实例。
    /// 若 `new_path` 与当前实例的密钥目录相同，旧密钥文件会被原地覆盖，
    /// 该操作不可逆。当前仅测试使用，生产接入前需先补数据重加密编排。
    pub fn rotate_master_key(&self, new_path: &Path) -> Result<Self> {
        // 修复两个问题：
        // 1. new_path 是目录，必须拼接 .master_key 文件名（旧实现直接把目录
        //    当文件打开，报 "Is a directory"）；
        // 2. 轮换必须强制生成新密钥并覆盖旧文件——load_or_create 在文件已存在时
        //    会原样加载旧密钥，"轮换"变成无操作。
        let key_path = new_path.join(".master_key");
        let master_key = Self::create_master_key(&key_path)?;
        Ok(Self {
            key_path,
            master_key,
        })
    }

    pub fn verify_key_integrity(&self) -> Result<bool> {
        let cipher = self.cipher();
        let nonce_bytes = Self::generate_nonce();
        let nonce = Nonce::from_slice(&nonce_bytes);
        let test = b"integrity-check";
        let encrypted = cipher
            .encrypt(nonce, test.as_ref())
            .map_err(|e| anyhow!("AES 自检加密失败: {}", e))?;
        let decrypted = cipher
            .decrypt(nonce, encrypted.as_ref())
            .map_err(|e| anyhow!("AES 自检解密失败: {}", e))?;
        Ok(decrypted == test)
    }

    /// 用于构建内置配置的静态密钥导出
    pub fn derive_static_key(seed: &str) -> [u8; 32] {
        let digest = Sha256::digest(seed.as_bytes());
        let mut key = [0u8; 32];
        key.copy_from_slice(&digest);
        key
    }
}
