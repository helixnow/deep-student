use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use anyhow::{anyhow, Result};
use rand::{rngs::OsRng, RngCore};
use zeroize::Zeroize;

const BACKUP_MAGIC: &[u8; 4] = b"DSBK";
const BACKUP_CRYPTO_VERSION: u8 = 1;

const HEADER_SIZE: usize = 4 + 1 + 12 + 16 + 12; // magic + version + argon2_params + salt + nonce

const DEFAULT_M_COST: u32 = 65536; // 64 MB
const DEFAULT_T_COST: u32 = 3;
const DEFAULT_P_COST: u32 = 4;

fn derive_key(
    password: &str,
    salt: &[u8],
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
) -> Result<[u8; 32]> {
    use argon2::{Algorithm, Argon2, Params, Version};

    let params = Params::new(m_cost, t_cost, p_cost, Some(32))
        .map_err(|e| anyhow!("Argon2 参数无效: {}", e))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let mut key = [0u8; 32];
    argon2
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| anyhow!("Argon2id 密钥派生失败: {}", e))?;
    Ok(key)
}

/// Encrypt backup data with AES-256-GCM using an Argon2id-derived key.
///
/// Output format: `[DSBK][v1][argon2_params:12][salt:16][nonce:12][ciphertext+tag]`
pub fn encrypt_backup(plaintext: &[u8], password: &str) -> Result<Vec<u8>> {
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);

    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);

    let mut key = derive_key(password, &salt, DEFAULT_M_COST, DEFAULT_T_COST, DEFAULT_P_COST)?;

    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| anyhow!("创建 AES cipher 失败: {}", e))?;
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| anyhow!("备份加密失败: {}", e))?;

    key.zeroize();

    let mut output = Vec::with_capacity(HEADER_SIZE + ciphertext.len());
    output.extend_from_slice(BACKUP_MAGIC);
    output.push(BACKUP_CRYPTO_VERSION);
    output.extend_from_slice(&DEFAULT_M_COST.to_le_bytes());
    output.extend_from_slice(&DEFAULT_T_COST.to_le_bytes());
    output.extend_from_slice(&DEFAULT_P_COST.to_le_bytes());
    output.extend_from_slice(&salt);
    output.extend_from_slice(&nonce_bytes);
    output.extend_from_slice(&ciphertext);
    Ok(output)
}

/// Decrypt an encrypted backup file produced by [`encrypt_backup`].
pub fn decrypt_backup(data: &[u8], password: &str) -> Result<Vec<u8>> {
    if data.len() < HEADER_SIZE {
        return Err(anyhow!("加密备份数据太短"));
    }
    if &data[0..4] != BACKUP_MAGIC {
        return Err(anyhow!("非加密备份文件（无 DSBK 标头）"));
    }
    let version = data[4];
    if version != BACKUP_CRYPTO_VERSION {
        return Err(anyhow!("不支持的加密版本: {}", version));
    }

    let off = 5;
    let m_cost = u32::from_le_bytes(data[off..off + 4].try_into()?);
    let t_cost = u32::from_le_bytes(data[off + 4..off + 8].try_into()?);
    let p_cost = u32::from_le_bytes(data[off + 8..off + 12].try_into()?);
    let salt = &data[off + 12..off + 28];
    let nonce_bytes = &data[off + 28..off + 40];
    let ciphertext = &data[off + 40..];

    let mut key = derive_key(password, salt, m_cost, t_cost, p_cost)?;

    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| anyhow!("创建 AES cipher 失败: {}", e))?;
    let nonce = Nonce::from_slice(nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| anyhow!("备份解密失败（密码错误或数据损坏）: {}", e))?;

    key.zeroize();
    Ok(plaintext)
}

/// Returns `true` if `data` starts with the encrypted backup magic bytes.
pub fn is_encrypted_backup(data: &[u8]) -> bool {
    data.len() >= 4 && &data[0..4] == BACKUP_MAGIC
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_encrypt_decrypt() {
        let plaintext = b"hello backup world! 123 456";
        let password = "test-password-2026";

        let encrypted = encrypt_backup(plaintext, password).unwrap();
        assert!(is_encrypted_backup(&encrypted));
        assert_ne!(&encrypted[HEADER_SIZE..], plaintext);

        let decrypted = decrypt_backup(&encrypted, password).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn wrong_password_fails() {
        let encrypted = encrypt_backup(b"secret data", "correct").unwrap();
        let result = decrypt_backup(&encrypted, "wrong");
        assert!(result.is_err());
    }

    #[test]
    fn tampered_data_fails() {
        let mut encrypted = encrypt_backup(b"data", "pw").unwrap();
        let last = encrypted.len() - 1;
        encrypted[last] ^= 0xFF;
        assert!(decrypt_backup(&encrypted, "pw").is_err());
    }

    #[test]
    fn non_encrypted_file_detected() {
        assert!(!is_encrypted_backup(b"PK\x03\x04some zip data"));
        assert!(!is_encrypted_backup(b""));
    }
}
