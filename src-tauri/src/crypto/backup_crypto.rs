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

/// 流式（分块）加密容器版本。`encrypt_backup_file` 写出此版本；
/// `decrypt_backup_file` 同时兼容读取 v1（整文件单块）。
const BACKUP_CRYPTO_VERSION_STREAM: u8 = 2;
/// 流式分块的明文大小（1 MiB）；密文块 = 明文块 + 16 字节 GCM tag。
const STREAM_PLAINTEXT_CHUNK: usize = 1024 * 1024;
/// 解密时允许的最大分块（防御异常 chunk_size 头导致的巨量分配）。
const STREAM_MAX_PLAINTEXT_CHUNK: usize = 64 * 1024 * 1024;

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

    let mut key = derive_key(
        password,
        &salt,
        DEFAULT_M_COST,
        DEFAULT_T_COST,
        DEFAULT_P_COST,
    )?;

    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|e| anyhow!("创建 AES cipher 失败: {}", e))?;
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

    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|e| anyhow!("创建 AES cipher 失败: {}", e))?;
    let nonce = Nonce::from_slice(nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| anyhow!("备份解密失败（密码错误或数据损坏）: {}", e))?;

    key.zeroize();
    Ok(plaintext)
}

/// 构造分块 nonce：`nonce_prefix(7) || counter_be(4) || final_flag(1)`。
///
/// `final_flag` 把「是否最后一块」并入 nonce，使任何对分块的截断、删尾或重排
/// 都会导致 AEAD tag 校验失败（防截断攻击）。
fn stream_chunk_nonce(prefix: &[u8; 7], counter: u32, is_final: bool) -> [u8; 12] {
    let mut nonce = [0u8; 12];
    nonce[..7].copy_from_slice(prefix);
    nonce[7..11].copy_from_slice(&counter.to_be_bytes());
    nonce[11] = u8::from(is_final);
    nonce
}

/// 从 `reader` 尽量填满 `buf`，直到填满或读到 EOF；返回实际读取字节数。
/// 短读（返回值 < buf.len()）即表示已到 EOF。
fn fill_chunk<R: std::io::Read>(reader: &mut R, buf: &mut [u8]) -> Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        let n = reader
            .read(&mut buf[filled..])
            .map_err(|e| anyhow!("读取数据失败: {}", e))?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
}

/// 以 DSBK2 分块流式格式把 `input` 文件加密到 `output` 文件。
///
/// 与 [`encrypt_backup`]（整文件入内存）不同，本函数内存占用恒定（约几个分块），
/// 适合多 GB 备份。容器格式：
/// `[DSBK][v2][m_cost:4][t_cost:4][p_cost:4][salt:16][nonce_prefix:7][chunk:4]`
/// 之后是若干分块密文，每块 = `AES-256-GCM(key, nonce_i, plaintext_chunk_i)`，
/// `nonce_i = nonce_prefix || counter_be(4) || final_flag(1)`。
pub fn encrypt_backup_file(
    input: &std::path::Path,
    output: &std::path::Path,
    password: &str,
) -> Result<()> {
    use std::io::Write;

    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let mut nonce_prefix = [0u8; 7];
    OsRng.fill_bytes(&mut nonce_prefix);

    let mut key = derive_key(
        password,
        &salt,
        DEFAULT_M_COST,
        DEFAULT_T_COST,
        DEFAULT_P_COST,
    )?;
    let cipher = match Aes256Gcm::new_from_slice(&key) {
        Ok(c) => c,
        Err(e) => {
            key.zeroize();
            return Err(anyhow!("创建 AES cipher 失败: {}", e));
        }
    };

    let in_file = std::fs::File::open(input).map_err(|e| anyhow!("打开待加密文件失败: {}", e))?;
    let mut reader = std::io::BufReader::new(in_file);
    let out_file =
        std::fs::File::create(output).map_err(|e| anyhow!("创建加密输出文件失败: {}", e))?;
    let mut writer = std::io::BufWriter::new(out_file);

    let write_header = |writer: &mut std::io::BufWriter<std::fs::File>| -> Result<()> {
        writer.write_all(BACKUP_MAGIC)?;
        writer.write_all(&[BACKUP_CRYPTO_VERSION_STREAM])?;
        writer.write_all(&DEFAULT_M_COST.to_le_bytes())?;
        writer.write_all(&DEFAULT_T_COST.to_le_bytes())?;
        writer.write_all(&DEFAULT_P_COST.to_le_bytes())?;
        writer.write_all(&salt)?;
        writer.write_all(&nonce_prefix)?;
        writer.write_all(&(STREAM_PLAINTEXT_CHUNK as u32).to_le_bytes())?;
        Ok(())
    };
    if let Err(e) = write_header(&mut writer) {
        key.zeroize();
        return Err(anyhow!("写入加密头部失败: {}", e));
    }

    let mut counter: u32 = 0;
    let mut current = vec![0u8; STREAM_PLAINTEXT_CHUNK];
    let cur_len = match fill_chunk(&mut reader, &mut current) {
        Ok(n) => n,
        Err(e) => {
            key.zeroize();
            return Err(e);
        }
    };
    current.truncate(cur_len);

    loop {
        let mut next = vec![0u8; STREAM_PLAINTEXT_CHUNK];
        let next_len = match fill_chunk(&mut reader, &mut next) {
            Ok(n) => n,
            Err(e) => {
                key.zeroize();
                return Err(e);
            }
        };
        next.truncate(next_len);
        let is_final = next.is_empty();

        let nonce = stream_chunk_nonce(&nonce_prefix, counter, is_final);
        let ct = match cipher.encrypt(Nonce::from_slice(&nonce), current.as_slice()) {
            Ok(ct) => ct,
            Err(e) => {
                key.zeroize();
                return Err(anyhow!("分块加密失败: {}", e));
            }
        };
        if let Err(e) = writer.write_all(&ct) {
            key.zeroize();
            return Err(anyhow!("写入密文失败: {}", e));
        }

        if is_final {
            break;
        }
        current = next;
        counter = match counter.checked_add(1) {
            Some(c) => c,
            None => {
                key.zeroize();
                return Err(anyhow!("分块计数溢出（文件过大）"));
            }
        };
    }

    let flush_res = writer.flush();
    key.zeroize();
    flush_res.map_err(|e| anyhow!("刷新加密输出失败: {}", e))?;
    Ok(())
}

/// 解密 [`encrypt_backup_file`] 产生的 DSBK2 文件到 `output`，内存占用恒定。
///
/// 兼容旧的 DSBK v1（整文件单块）：检测到 v1 时回退为整体读入解密（仅旧备份会走到）。
pub fn decrypt_backup_file(
    input: &std::path::Path,
    output: &std::path::Path,
    password: &str,
) -> Result<()> {
    use std::io::{Read, Write};

    let in_file = std::fs::File::open(input).map_err(|e| anyhow!("打开加密文件失败: {}", e))?;
    let mut reader = std::io::BufReader::new(in_file);

    let mut head = [0u8; 5];
    reader
        .read_exact(&mut head)
        .map_err(|e| anyhow!("读取加密头失败: {}", e))?;
    if &head[0..4] != BACKUP_MAGIC {
        return Err(anyhow!("非加密备份文件（无 DSBK 标头）"));
    }
    let version = head[4];

    // 旧 DSBK v1（整文件单块）：仅旧备份会命中，整体读入解密即可。
    if version == BACKUP_CRYPTO_VERSION {
        let data = std::fs::read(input).map_err(|e| anyhow!("读取加密备份失败: {}", e))?;
        let plaintext = decrypt_backup(&data, password)?;
        let mut writer = std::io::BufWriter::new(
            std::fs::File::create(output).map_err(|e| anyhow!("创建解密输出失败: {}", e))?,
        );
        writer
            .write_all(&plaintext)
            .map_err(|e| anyhow!("写入解密输出失败: {}", e))?;
        writer
            .flush()
            .map_err(|e| anyhow!("刷新解密输出失败: {}", e))?;
        return Ok(());
    }

    if version != BACKUP_CRYPTO_VERSION_STREAM {
        return Err(anyhow!("不支持的加密版本: {}", version));
    }

    let mut params = [0u8; 12];
    reader
        .read_exact(&mut params)
        .map_err(|e| anyhow!("读取加密参数失败: {}", e))?;
    let m_cost = u32::from_le_bytes(params[0..4].try_into()?);
    let t_cost = u32::from_le_bytes(params[4..8].try_into()?);
    let p_cost = u32::from_le_bytes(params[8..12].try_into()?);
    let mut salt = [0u8; 16];
    reader
        .read_exact(&mut salt)
        .map_err(|e| anyhow!("读取 salt 失败: {}", e))?;
    let mut nonce_prefix = [0u8; 7];
    reader
        .read_exact(&mut nonce_prefix)
        .map_err(|e| anyhow!("读取 nonce 前缀失败: {}", e))?;
    let mut chunk_size_buf = [0u8; 4];
    reader
        .read_exact(&mut chunk_size_buf)
        .map_err(|e| anyhow!("读取分块大小失败: {}", e))?;
    let plaintext_chunk = u32::from_le_bytes(chunk_size_buf) as usize;
    if plaintext_chunk == 0 || plaintext_chunk > STREAM_MAX_PLAINTEXT_CHUNK {
        return Err(anyhow!("加密分块大小非法: {}", plaintext_chunk));
    }
    let cipher_chunk = plaintext_chunk + 16; // + GCM tag

    let mut key = derive_key(password, &salt, m_cost, t_cost, p_cost)?;
    let cipher = match Aes256Gcm::new_from_slice(&key) {
        Ok(c) => c,
        Err(e) => {
            key.zeroize();
            return Err(anyhow!("创建 AES cipher 失败: {}", e));
        }
    };

    let out_file = match std::fs::File::create(output) {
        Ok(f) => f,
        Err(e) => {
            key.zeroize();
            return Err(anyhow!("创建解密输出失败: {}", e));
        }
    };
    let mut writer = std::io::BufWriter::new(out_file);

    let mut counter: u32 = 0;
    let mut current = vec![0u8; cipher_chunk];
    let cur_len = match fill_chunk(&mut reader, &mut current) {
        Ok(n) => n,
        Err(e) => {
            key.zeroize();
            return Err(e);
        }
    };
    if cur_len == 0 {
        key.zeroize();
        return Err(anyhow!("加密备份缺少数据块"));
    }
    current.truncate(cur_len);

    loop {
        let mut next = vec![0u8; cipher_chunk];
        let next_len = match fill_chunk(&mut reader, &mut next) {
            Ok(n) => n,
            Err(e) => {
                key.zeroize();
                return Err(e);
            }
        };
        next.truncate(next_len);
        let is_final = next.is_empty();

        let nonce = stream_chunk_nonce(&nonce_prefix, counter, is_final);
        let pt = match cipher.decrypt(Nonce::from_slice(&nonce), current.as_slice()) {
            Ok(pt) => pt,
            Err(e) => {
                key.zeroize();
                return Err(anyhow!("备份解密失败（密码错误或数据损坏）: {}", e));
            }
        };
        if let Err(e) = writer.write_all(&pt) {
            key.zeroize();
            return Err(anyhow!("写入解密输出失败: {}", e));
        }

        if is_final {
            break;
        }
        current = next;
        counter = match counter.checked_add(1) {
            Some(c) => c,
            None => {
                key.zeroize();
                return Err(anyhow!("分块计数溢出"));
            }
        };
    }

    let flush_res = writer.flush();
    key.zeroize();
    flush_res.map_err(|e| anyhow!("刷新解密输出失败: {}", e))?;
    Ok(())
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

    #[test]
    fn stream_roundtrip_various_sizes() {
        let dir = tempfile::tempdir().unwrap();
        let password = "stream-pw-2026";
        for size in [
            0usize,
            100,
            STREAM_PLAINTEXT_CHUNK,
            STREAM_PLAINTEXT_CHUNK + 1,
            STREAM_PLAINTEXT_CHUNK * 2 + 123,
        ] {
            let plain: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
            let input = dir.path().join(format!("in-{size}.bin"));
            let enc = dir.path().join(format!("enc-{size}.bin"));
            let dec = dir.path().join(format!("dec-{size}.bin"));
            std::fs::write(&input, &plain).unwrap();
            encrypt_backup_file(&input, &enc, password).unwrap();
            let head = std::fs::read(&enc).unwrap();
            assert!(is_encrypted_backup(&head));
            assert_eq!(head[4], BACKUP_CRYPTO_VERSION_STREAM);
            decrypt_backup_file(&enc, &dec, password).unwrap();
            assert_eq!(std::fs::read(&dec).unwrap(), plain, "size={size}");
        }
    }

    #[test]
    fn stream_wrong_password_fails() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("in.bin");
        let enc = dir.path().join("enc.bin");
        let dec = dir.path().join("dec.bin");
        std::fs::write(&input, vec![7u8; 4096]).unwrap();
        encrypt_backup_file(&input, &enc, "correct").unwrap();
        assert!(decrypt_backup_file(&enc, &dec, "wrong").is_err());
    }

    #[test]
    fn stream_truncation_is_detected() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("in.bin");
        let enc = dir.path().join("enc.bin");
        let dec = dir.path().join("dec.bin");
        // 两个分块：删掉 final 块后，前一非 final 块被当成 final 解密 → nonce 不符 → tag 失败
        std::fs::write(&input, vec![3u8; STREAM_PLAINTEXT_CHUNK + 1024]).unwrap();
        encrypt_backup_file(&input, &enc, "pw").unwrap();
        let mut bytes = std::fs::read(&enc).unwrap();
        bytes.truncate(bytes.len() - (1024 + 16));
        std::fs::write(&enc, &bytes).unwrap();
        assert!(decrypt_backup_file(&enc, &dec, "pw").is_err());
    }

    #[test]
    fn stream_decrypts_legacy_v1_file() {
        let dir = tempfile::tempdir().unwrap();
        let enc = dir.path().join("legacy.dsbk");
        let dec = dir.path().join("legacy.out");
        let plain = b"legacy v1 backup payload";
        let v1 = encrypt_backup(plain, "pw").unwrap();
        std::fs::write(&enc, &v1).unwrap();
        decrypt_backup_file(&enc, &dec, "pw").unwrap();
        assert_eq!(std::fs::read(&dec).unwrap(), plain.as_slice());
    }
}
