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
        let key_fingerprint = format!(
            "{:02x}{:02x}{:02x}{:02x}",
            fp[0], fp[1], fp[2], fp[3]
        );
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
            tracing::info!("🔐 [Crypto] 新主密钥已创建");
            Ok(key)
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

    pub fn rotate_master_key(&self, new_path: &Path) -> Result<Self> {
        let master_key = Self::load_or_create_master_key(new_path)?;
        Ok(Self {
            key_path: new_path.to_path_buf(),
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
