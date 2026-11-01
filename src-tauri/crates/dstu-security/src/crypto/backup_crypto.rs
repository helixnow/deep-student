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

// =====================================================================================
// [R10-verifier] 密钥派生参数的应用级上限（KEY-ROTATION-R11 §6 / FINDINGS-R07 P2-2）
// =====================================================================================
//
// 密码校验子（`check_password_verifier`）与 DSBK 备份文件头（v1/v2 解密路径、
// `FileCipherSession`）携带的 Argon2id 参数都来自**不受信任的云端对象**：内容可能
// 损坏、被第三方工具改写或由不兼容版本写入。内存参数直接决定「这一次派生要吃多少
// 内存/多长时间」，因此必须在任何派生开始之前用应用级上限拦截，超限立即
// fail-closed（与未知 KDF 同路），不尝试分配内存。
//
// 取值依据（只许向上放宽，不许收紧——收紧会拒收自家旧备份）：
// - 本应用自身写出的默认参数自首个加密版本起一直是 64 MiB / t=3 / p=4
//   （`DEFAULT_M_COST` 等，从未改过）；
// - 上限取默认写入面的 16 倍内存（1 GiB）、约 5 倍迭代（16）、2 倍并行（8），
//   覆盖历史全部写入面并为未来调参留出充足余量，同时保证即使被拒也不会先吃掉
//   GiB 级内存或分钟级 CPU。

/// Argon2id 内存参数（KiB）应用级上限：1 GiB。
pub const KDF_MAX_M_COST_KIB: u32 = 1024 * 1024;
/// Argon2id 迭代次数应用级上限。
pub const KDF_MAX_T_COST: u32 = 16;
/// Argon2id 并行度应用级上限。
pub const KDF_MAX_P_COST: u32 = 8;

/// 超限时的用户级错误文案（不含内部参数值与实现细节）。
pub const KDF_PARAMS_REJECTED_MESSAGE: &str =
    "该云端数据携带的加密参数异常（数据可能已损坏、被外部工具改写，或由不兼容的版本写入），\
     已在开始计算前停止，以避免应用长时间无响应。请检查该云端目录的内容后重试，\
     或改用其他云端目录。";

/// 在**任何派生开始前**校验参数处于应用级上限内；超限立即 fail-closed。
///
/// 所有派生（校验子复算、DSBK v1/v2 解密、`FileCipherSession`）都必须经过
/// [`derive_key`]，而本检查是 `derive_key` 的第一步——两条路径共用同一组上限
/// 常量与同一段判断，不会只堵一半。
fn ensure_kdf_params_within_app_limits(m_cost: u32, t_cost: u32, p_cost: u32) -> Result<()> {
    if m_cost > KDF_MAX_M_COST_KIB || t_cost > KDF_MAX_T_COST || p_cost > KDF_MAX_P_COST {
        return Err(anyhow!("{KDF_PARAMS_REJECTED_MESSAGE}"));
    }
    Ok(())
}

// =====================================================================================
// [Wave2-R5-kdf] 新设口令 / 新写入面的平台相关 KDF 内存封顶
// =====================================================================================
//
// 上面的 `KDF_MAX_*` 是**解密与存量 verifier 复算**的全局上限（1 GiB），红线是
// 只许放宽、不许收紧——收紧会拒收自家旧备份/旧校验子。本节引入的是另一条
// **方向相反、作用面更窄**的封顶：只作用于「本机即将新产生的写入面」（新建
// 加密会话、新建密码校验子），目的是防止移动端（Android/iOS，物理内存与
// 前台内存预算远小于桌面）被高 m_cost 参数拖进 OOM/被系统杀进程。
//
// 语义边界（有意为之，勿混淆两组上限）：
// - 移动端新写入面封顶 256 MiB（这是**上限封顶**，不是默认值；默认写入参数
//   仍是 `DEFAULT_M_COST` = 64 MiB / t=3 / p=4，本轮未做任何改动）；
// - 桌面端新写入面维持与全局上限一致（1 GiB），即行为无变化，仅文档化；
// - **解密路径与存量 verifier 复算完全不经过本封顶**：容器头/校验子登记的
//   参数只要在全局 `KDF_MAX_*` 内就照常派生。桌面端写出的 512 MiB 备份在
//   移动端依旧可以解密（慢，但不能打不开）；
// - 全局常量 `KDF_MAX_M_COST_KIB` 等被 migration-lock/协议锁单测锁定
//   （`sync_r10_protocol_locks.rs` / `sync_r10_verifier.rs`），本节不改其值。

/// 移动端（Android/iOS）**新设口令 / 新加密写入面**的 Argon2id 内存封顶
/// （KiB）：256 MiB。上限封顶，不是默认值；解密/存量路径不使用本常量。
pub const KDF_NEW_PASSWORD_MAX_M_COST_KIB_MOBILE: u32 = 256 * 1024;

/// 新设口令（新建加密会话 / 新建密码校验子）允许的最大 Argon2id m_cost（KiB），
/// 按运行平台分支：
///
/// - Android / iOS：[`KDF_NEW_PASSWORD_MAX_M_COST_KIB_MOBILE`]（256 MiB 封顶）；
/// - 桌面（其余平台）：维持全局上限 [`KDF_MAX_M_COST_KIB`]（1 GiB），行为不变。
///
/// 返回值恒 `<= KDF_MAX_M_COST_KIB`：新写入面封顶只能比全局解密上限更严或
/// 相等，绝不放宽解密侧的既有判定。
pub fn kdf_max_m_cost_for_new_password() -> u32 {
    if cfg!(any(target_os = "android", target_os = "ios")) {
        KDF_NEW_PASSWORD_MAX_M_COST_KIB_MOBILE
    } else {
        KDF_MAX_M_COST_KIB
    }
}

/// 新写入面参数超出本平台封顶时的用户级错误文案。
///
/// 与 [`KDF_PARAMS_REJECTED_MESSAGE`]（解密/校验路径的「数据异常」文案）刻意
/// 区分：这里拒绝的是**本机主动发起的新加密参数**，责任在参数选择而非云端数据。
pub const KDF_NEW_PASSWORD_PARAMS_REJECTED_MESSAGE: &str =
    "所选加密强度参数超出本设备可安全承受的内存范围，已停止本次加密。\
     请使用默认加密参数（无需任何设置），或降低自定义参数后重试；\
     已有的加密数据不受影响，仍可正常解密。";

/// 校验**新写入面**（新建加密会话 / 新建校验子）的 KDF 参数：
/// 先过全局上限（超全局按「参数异常」拒绝），再过平台相关的新设封顶。
///
/// 解密与存量 verifier 复算**不得**调用本函数——它们只受
/// [`ensure_kdf_params_within_app_limits`]（经 [`derive_key`]）约束。
fn ensure_kdf_params_allowed_for_new_encryption(
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
) -> Result<()> {
    ensure_kdf_params_within_app_limits(m_cost, t_cost, p_cost)?;
    if m_cost > kdf_max_m_cost_for_new_password() {
        return Err(anyhow!("{KDF_NEW_PASSWORD_PARAMS_REJECTED_MESSAGE}"));
    }
    Ok(())
}

/// 流式（分块）加密容器版本。`encrypt_backup_file` 写出此版本；
/// `decrypt_backup_file` 同时兼容读取 v1（整文件单块）。
const BACKUP_CRYPTO_VERSION_STREAM: u8 = 2;
/// 流式分块的明文大小（1 MiB）；密文块 = 明文块 + 16 字节 GCM tag。
const STREAM_PLAINTEXT_CHUNK: usize = 1024 * 1024;
/// 解密时允许的最大分块（防御异常 chunk_size 头导致的巨量分配）。
const STREAM_MAX_PLAINTEXT_CHUNK: usize = 64 * 1024 * 1024;

// =====================================================================================
// [R12-repocheck-fix] DSBK 容器布局常量的跨模块 SSOT 导出（FINDINGS-R11 P1-1）
// =====================================================================================
//
// 云端仓库巡检（`cloud_storage::repo_check`）需要在**不解密**的前提下判断对象的
// DSBK 头是否可解。R11-check 曾在 repo_check 里手工复制布局常量，把 v2 头长抄成
// 48（真实 44）、把 chunk 字段从密文区 `[44..48)` 读取，导致约 98.4% 的健康加密
// 对象被误报「头不可解」。为杜绝再次复制错偏移，容器布局在此作为单一事实来源
// （SSOT）导出：写入路径（`encrypt_backup` / `encrypt_backup_file`）与这些常量
// 共用同一组字段宽度，布局漂移会先在本文件的 `dsbk_layout_constants_*` 单测里
// 对真实产物失败。只导出布局事实，不导出任何密钥派生/解密逻辑。

/// DSBK 容器魔数（`b"DSBK"`）。
pub const DSBK_MAGIC: &[u8; 4] = BACKUP_MAGIC;
/// DSBK v1（整文件单块）头长：magic4 + ver1 + params12 + salt16 + nonce12 = 45。
pub const DSBK_V1_HEADER_LEN: usize = HEADER_SIZE;
/// DSBK v2（分块流式）头长：magic4 + ver1 + params12 + salt16 + nonce_prefix7 + chunk4 = 44。
pub const DSBK_V2_HEADER_LEN: usize = 4 + 1 + 12 + 16 + 7 + 4;
/// v2 头中分块大小字段（u32 LE）的起始偏移：chunk 位于 `[40..44)`。
pub const DSBK_V2_CHUNK_OFFSET: usize = DSBK_V2_HEADER_LEN - 4;
/// AES-256-GCM 认证标签长度（每个密文块/整块尾部）。
pub const DSBK_GCM_TAG_LEN: usize = 16;
/// v2 头 chunk 字段的合法上限（与解密路径 [`STREAM_MAX_PLAINTEXT_CHUNK`] 同值）。
pub const DSBK_MAX_PLAINTEXT_CHUNK: u32 = STREAM_MAX_PLAINTEXT_CHUNK as u32;

fn derive_key(
    password: &str,
    salt: &[u8],
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
) -> Result<[u8; 32]> {
    use argon2::{Algorithm, Argon2, Params, Version};

    // [R10-verifier] 应用级上限先行：参数超限时在分配任何派生内存之前失败。
    ensure_kdf_params_within_app_limits(m_cost, t_cost, p_cost)?;

    let params = Params::new(m_cost, t_cost, p_cost, Some(32))
        .map_err(|e| anyhow!("Argon2 参数无效: {}", e))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let mut key = [0u8; 32];
    argon2
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| anyhow!("Argon2id 密钥派生失败: {}", e))?;
    Ok(key)
}

/// 用**已派生**的密钥加密为 DSBK v1 单块容器（[R07-file-e2ee] 密钥复用路径）。
///
/// 容器头写入的 salt/params 仍是派生该 key 时用的值，保证任意持有密码的
/// 对端都能独立重新派生并解密。
fn encrypt_backup_with_key(
    plaintext: &[u8],
    salt: &[u8; 16],
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
    key: &[u8; 32],
) -> Result<Vec<u8>> {
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);

    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|e| anyhow!("创建 AES cipher 失败: {}", e))?;
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| anyhow!("备份加密失败: {}", e))?;

    let mut output = Vec::with_capacity(HEADER_SIZE + ciphertext.len());
    output.extend_from_slice(BACKUP_MAGIC);
    output.push(BACKUP_CRYPTO_VERSION);
    output.extend_from_slice(&m_cost.to_le_bytes());
    output.extend_from_slice(&t_cost.to_le_bytes());
    output.extend_from_slice(&p_cost.to_le_bytes());
    output.extend_from_slice(salt);
    output.extend_from_slice(&nonce_bytes);
    output.extend_from_slice(&ciphertext);
    Ok(output)
}

/// Encrypt backup data with AES-256-GCM using an Argon2id-derived key.
///
/// Output format: `[DSBK][v1][argon2_params:12][salt:16][nonce:12][ciphertext+tag]`
pub fn encrypt_backup(plaintext: &[u8], password: &str) -> Result<Vec<u8>> {
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);

    let mut key = derive_key(
        password,
        &salt,
        DEFAULT_M_COST,
        DEFAULT_T_COST,
        DEFAULT_P_COST,
    )?;
    let result = encrypt_backup_with_key(
        plaintext,
        &salt,
        DEFAULT_M_COST,
        DEFAULT_T_COST,
        DEFAULT_P_COST,
        &key,
    );
    key.zeroize();
    result
}

/// 解析 DSBK v1 头并用 `key_for(salt, m, t, p)` 提供的密钥解密。
///
/// [R07-file-e2ee] 把密钥获取抽象出来，`decrypt_backup`（每次派生）与
/// [`FileCipherSession`]（跨对象缓存派生结果）共用同一解析/校验逻辑。
fn decrypt_backup_with_key_provider<F>(data: &[u8], key_for: F) -> Result<Vec<u8>>
where
    F: FnOnce(&[u8; 16], u32, u32, u32) -> Result<[u8; 32]>,
{
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
    let salt: [u8; 16] = data[off + 12..off + 28].try_into()?;
    let nonce_bytes = &data[off + 28..off + 40];
    let ciphertext = &data[off + 40..];

    let mut key = key_for(&salt, m_cost, t_cost, p_cost)?;

    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|e| anyhow!("创建 AES cipher 失败: {}", e))?;
    let nonce = Nonce::from_slice(nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| anyhow!("备份解密失败（密码错误或数据损坏）: {}", e));

    key.zeroize();
    plaintext
}

/// Decrypt an encrypted backup file produced by [`encrypt_backup`].
pub fn decrypt_backup(data: &[u8], password: &str) -> Result<Vec<u8>> {
    decrypt_backup_with_key_provider(data, |salt, m_cost, t_cost, p_cost| {
        derive_key(password, salt, m_cost, t_cost, p_cost)
    })
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
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);

    let mut key = derive_key(
        password,
        &salt,
        DEFAULT_M_COST,
        DEFAULT_T_COST,
        DEFAULT_P_COST,
    )?;
    let result = encrypt_backup_file_with_key(
        input,
        output,
        &salt,
        DEFAULT_M_COST,
        DEFAULT_T_COST,
        DEFAULT_P_COST,
        &key,
    );
    key.zeroize();
    result
}

/// 用**已派生**的密钥把 `input` 以 DSBK v2 分块流式格式加密到 `output`。
///
/// [R07-file-e2ee] [`encrypt_backup_file`]（每次派生）与 [`FileCipherSession`]
/// （会话内复用密钥）共用此实现。头部 salt/params 为派生 `key` 时所用的值。
fn encrypt_backup_file_with_key(
    input: &std::path::Path,
    output: &std::path::Path,
    salt: &[u8; 16],
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
    key: &[u8; 32],
) -> Result<()> {
    use std::io::Write;

    let mut nonce_prefix = [0u8; 7];
    OsRng.fill_bytes(&mut nonce_prefix);

    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|e| anyhow!("创建 AES cipher 失败: {}", e))?;

    let in_file = std::fs::File::open(input).map_err(|e| anyhow!("打开待加密文件失败: {}", e))?;
    let mut reader = std::io::BufReader::new(in_file);
    let out_file =
        std::fs::File::create(output).map_err(|e| anyhow!("创建加密输出文件失败: {}", e))?;
    let mut writer = std::io::BufWriter::new(out_file);

    let write_header = |writer: &mut std::io::BufWriter<std::fs::File>| -> Result<()> {
        writer.write_all(BACKUP_MAGIC)?;
        writer.write_all(&[BACKUP_CRYPTO_VERSION_STREAM])?;
        writer.write_all(&m_cost.to_le_bytes())?;
        writer.write_all(&t_cost.to_le_bytes())?;
        writer.write_all(&p_cost.to_le_bytes())?;
        writer.write_all(salt)?;
        writer.write_all(&nonce_prefix)?;
        writer.write_all(&(STREAM_PLAINTEXT_CHUNK as u32).to_le_bytes())?;
        Ok(())
    };
    write_header(&mut writer).map_err(|e| anyhow!("写入加密头部失败: {}", e))?;

    let mut counter: u32 = 0;
    let mut current = vec![0u8; STREAM_PLAINTEXT_CHUNK];
    let cur_len = fill_chunk(&mut reader, &mut current)?;
    current.truncate(cur_len);

    loop {
        let mut next = vec![0u8; STREAM_PLAINTEXT_CHUNK];
        let next_len = fill_chunk(&mut reader, &mut next)?;
        next.truncate(next_len);
        let is_final = next.is_empty();

        let nonce = stream_chunk_nonce(&nonce_prefix, counter, is_final);
        let ct = cipher
            .encrypt(Nonce::from_slice(&nonce), current.as_slice())
            .map_err(|e| anyhow!("分块加密失败: {}", e))?;
        writer
            .write_all(&ct)
            .map_err(|e| anyhow!("写入密文失败: {}", e))?;

        if is_final {
            break;
        }
        current = next;
        counter = counter
            .checked_add(1)
            .ok_or_else(|| anyhow!("分块计数溢出（文件过大）"))?;
    }

    writer
        .flush()
        .map_err(|e| anyhow!("刷新加密输出失败: {}", e))?;
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
    decrypt_backup_file_with_key_provider(input, output, |salt, m_cost, t_cost, p_cost| {
        derive_key(password, salt, m_cost, t_cost, p_cost)
    })
}

/// [`decrypt_backup_file`] 的密钥提供器版本（[R07-file-e2ee] 密钥复用路径）。
///
/// `key_for(salt, m, t, p)` 负责给出与容器头登记参数对应的密钥；同时兼容
/// DSBK v1（整文件单块）与 v2（分块流式）。
fn decrypt_backup_file_with_key_provider<F>(
    input: &std::path::Path,
    output: &std::path::Path,
    key_for: F,
) -> Result<()>
where
    F: FnOnce(&[u8; 16], u32, u32, u32) -> Result<[u8; 32]>,
{
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
        let plaintext = decrypt_backup_with_key_provider(&data, key_for)?;
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

    let mut key = key_for(&salt, m_cost, t_cost, p_cost)?;
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

// =====================================================================================
// [R5-prove-cost] DSBK v2 首块试解（只读加法 API，供上传前口令证明降本）
// =====================================================================================
//
// v2 分块容器的每个密文块都带独立 AES-256-GCM tag，且「是否最后一块」并入
// nonce（[`stream_chunk_nonce`] 的 final_flag）：只要知道对象总长，就能确定
// 首块的 nonce 与边界，用「头 + 首个密文块」在不下载其余分块、不解密全文、
// 不落任何明文的前提下证明口令与该对象一致——错口令在首块 tag 校验即失败
//（一次 Argon2 派生 + 一个分块的 AES-GCM，秒级）。
//
// v1 整文件单块容器只有一个覆盖全文的 tag，无法部分试解：调用方须回退
// 整文件下载 + 整文件解密路径（[`decrypt_backup_file`]，存量 v1 备份不受影响）。
//
// 本节只做加法：不改动任何既有加密/解密函数，不改默认 Argon2 参数
//（`DEFAULT_M_COST`/`DEFAULT_T_COST`/`DEFAULT_P_COST`），不收紧 KDF 应用级
// 上限——派生仍统一走 [`derive_key`]，超限参数在派生开始前照旧被拒。

/// 首块试解计划：调用方据此决定要读取多少前缀字节、走哪条路径。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FirstChunkPlan {
    /// v2 分块容器：读取对象前 `prefix_len` 字节（头 + 首个密文块）即可试解。
    StreamV2 {
        /// 覆盖「v2 头 + 首个密文块」所需的对象前缀总长（≤ 对象总长）。
        prefix_len: u64,
    },
    /// v1 整文件单块容器：无法部分试解，须整文件下载 + 整文件解密。
    LegacyV1WholeFile,
}

/// 首块试解的投机前缀长度：v2 头 + 默认 1 MiB 分块 + GCM tag（≈ 1 MiB + 60 B）。
///
/// 本应用写出的 v2 容器分块恒为 1 MiB（`STREAM_PLAINTEXT_CHUNK`，写入面从未
/// 改过），一次前缀读取即可覆盖首块；头部声明其他分块大小（外部工具写入）时，
/// 调用方按 [`plan_first_chunk_trial`] 给出的精确长度补读一次。
pub fn dsbk_first_chunk_speculative_prefix_len(object_len: u64) -> u64 {
    object_len.min((DSBK_V2_HEADER_LEN + STREAM_PLAINTEXT_CHUNK + DSBK_GCM_TAG_LEN) as u64)
}

/// 由对象头部字节与对象总长制定首块试解计划（只读布局解析，不派生、不解密）。
///
/// * `head` — 对象起始字节；v1 判定只需 5 字节，v2 计划需要 ≥ [`DSBK_V2_HEADER_LEN`]。
/// * `object_len` — 云端对象总长（来自 manifest / stat），用于把首块长度
///   钳到对象边界并拒绝「头声称的最小体积」都不满足的截断对象。
///
/// 返回 `Err` 的情形（全部 fail-closed，调用方不得当作口令错误以外的放行）：
/// 无 DSBK 魔数、未知版本、v2 头被截断、chunk 字段非法（0 或超过
/// [`DSBK_MAX_PLAINTEXT_CHUNK`]）、对象总长连一个 GCM tag 都装不下。
pub fn plan_first_chunk_trial(head: &[u8], object_len: u64) -> Result<FirstChunkPlan> {
    if head.len() < 5 {
        return Err(anyhow!("对象太短，读不到 DSBK 版本字节"));
    }
    if &head[0..4] != BACKUP_MAGIC {
        return Err(anyhow!("非加密备份文件（无 DSBK 标头）"));
    }
    match head[4] {
        BACKUP_CRYPTO_VERSION => Ok(FirstChunkPlan::LegacyV1WholeFile),
        BACKUP_CRYPTO_VERSION_STREAM => {
            if head.len() < DSBK_V2_HEADER_LEN {
                return Err(anyhow!(
                    "DSBK v2 头被截断：{} 字节 < {DSBK_V2_HEADER_LEN} 字节",
                    head.len()
                ));
            }
            let plaintext_chunk =
                u32::from_le_bytes(head[DSBK_V2_CHUNK_OFFSET..DSBK_V2_HEADER_LEN].try_into()?)
                    as u64;
            if plaintext_chunk == 0 || plaintext_chunk > DSBK_MAX_PLAINTEXT_CHUNK as u64 {
                return Err(anyhow!("加密分块大小非法: {plaintext_chunk}"));
            }
            let cipher_chunk = plaintext_chunk + DSBK_GCM_TAG_LEN as u64;
            let body_len = object_len
                .checked_sub(DSBK_V2_HEADER_LEN as u64)
                .filter(|len| *len >= DSBK_GCM_TAG_LEN as u64)
                .ok_or_else(|| {
                    anyhow!(
                        "加密备份缺少数据块（对象总长 {object_len} 字节，装不下 v2 头 + GCM tag）"
                    )
                })?;
            Ok(FirstChunkPlan::StreamV2 {
                prefix_len: DSBK_V2_HEADER_LEN as u64 + body_len.min(cipher_chunk),
            })
        }
        other => Err(anyhow!("不支持的加密版本: {other}")),
    }
}

/// 用「头 + 首个密文块」前缀对 DSBK v2 容器做首块试解（纯内存，不落任何明文）。
///
/// * `prefix` — 对象起始字节，长度须 ≥ [`plan_first_chunk_trial`] 给出的
///   `prefix_len`（多给不影响，只用前 `prefix_len` 字节）；
/// * `object_len` — 云端对象总长，用于判定首块是否 final 块（final 标记并入
///   nonce，判错即 tag 失败，防截断语义与整文件解密一致）。
///
/// 语义：
/// - `Ok(())` — 首块 AEAD tag 验证通过：口令正确且首块未损坏；
/// - `Err` — 口令错误 / 数据损坏 / KDF 参数超限（派生前拒绝）/ v1 容器
///   （须走整文件解密路径）/ 前缀不足。调用方一律 fail-closed。
///
/// 首块明文只在内存中短暂存在，验证后立即 zeroize，绝不写盘。
pub fn trial_decrypt_first_chunk(prefix: &[u8], object_len: u64, password: &str) -> Result<()> {
    let plan = plan_first_chunk_trial(prefix, object_len)?;
    let FirstChunkPlan::StreamV2 { prefix_len } = plan else {
        return Err(anyhow!(
            "DSBK v1 容器为整文件单块，无法首块试解，请走整文件解密路径"
        ));
    };
    if (prefix.len() as u64) < prefix_len {
        return Err(anyhow!(
            "对象前缀不足以覆盖首个密文块：需要 {prefix_len} 字节，实得 {} 字节",
            prefix.len()
        ));
    }

    // 头部布局与 decrypt_backup_file 的 v2 路径逐字段一致（SSOT 常量钳位）。
    let m_cost = u32::from_le_bytes(prefix[5..9].try_into()?);
    let t_cost = u32::from_le_bytes(prefix[9..13].try_into()?);
    let p_cost = u32::from_le_bytes(prefix[13..17].try_into()?);
    let salt: [u8; 16] = prefix[17..33].try_into()?;
    let nonce_prefix: [u8; 7] = prefix[33..40].try_into()?;
    let plaintext_chunk =
        u32::from_le_bytes(prefix[DSBK_V2_CHUNK_OFFSET..DSBK_V2_HEADER_LEN].try_into()?) as u64;
    let cipher_chunk = plaintext_chunk + DSBK_GCM_TAG_LEN as u64;

    // final 判定与流式解密一致：首块之后再无字节 → 首块即 final 块。
    let body_len = object_len - DSBK_V2_HEADER_LEN as u64;
    let is_final = body_len <= cipher_chunk;
    let first_block = &prefix[DSBK_V2_HEADER_LEN..prefix_len as usize];

    // KDF 应用级上限在 derive_key 第一步拦截（超限不分配派生内存，亚秒拒绝）。
    let mut key = derive_key(password, &salt, m_cost, t_cost, p_cost)?;
    let cipher = match Aes256Gcm::new_from_slice(&key) {
        Ok(cipher) => cipher,
        Err(e) => {
            key.zeroize();
            return Err(anyhow!("创建 AES cipher 失败: {e}"));
        }
    };
    let nonce = stream_chunk_nonce(&nonce_prefix, 0, is_final);
    let result = cipher.decrypt(Nonce::from_slice(&nonce), first_block);
    key.zeroize();
    match result {
        Ok(mut plaintext) => {
            plaintext.zeroize();
            Ok(())
        }
        Err(e) => Err(anyhow!("备份解密失败（密码错误或数据损坏）: {e}")),
    }
}

// =====================================================================================
// [R07-file-e2ee] 会话级文件加密器：一次 Argon2 派生，跨对象复用密钥
// =====================================================================================

/// 会话级 DSBK 加密器。
///
/// 云同步一轮会加解密大量小对象（清单、workspace db、VFS blob、资产），
/// 若每个对象都独立随机 salt + Argon2id 派生，单对象成本就是数百毫秒级、
/// 一轮同步随对象数线性放大。本会话改为：
///
/// - **加密**：会话创建时随机一个 salt 并派生一次密钥；本会话内所有对象共用
///   该 (salt, key)，每个对象仍使用独立随机 nonce（v1 单块为 12 字节随机
///   nonce，v2 流式为 7 字节随机前缀 + 计数器 + final 标记）。容器头照常写入
///   salt/params，对端无需任何会话状态即可解密。
/// - **解密**：按容器头登记的 (salt, params) 缓存派生结果——同一台对端设备
///   一轮同步产生的对象共用同一 salt，整轮只需一次 Argon2。
///
/// Nonce 安全性：同一密钥下 v1 对象各自 96-bit 随机 nonce，v2 对象各自
/// 56-bit 随机前缀（前缀碰撞才可能重复 nonce，n 个对象的碰撞概率约
/// n²/2⁵⁷）。会话生命周期为一轮同步，对象数远小于 2²⁰，风险可忽略；
/// 且每轮会话换新 salt → 新密钥，不跨会话累积。
///
/// Drop 时对密钥材料与密码做 zeroize。
pub struct FileCipherSession {
    password: String,
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
    salt: [u8; 16],
    key: [u8; 32],
    /// (salt, m, t, p) → 派生密钥缓存（解密对端对象时命中）
    derived: std::sync::Mutex<std::collections::HashMap<([u8; 16], u32, u32, u32), [u8; 32]>>,
}

impl FileCipherSession {
    /// 用默认 Argon2id 参数创建会话（一次派生）。
    pub fn new(password: &str) -> Result<Self> {
        Self::with_params(password, DEFAULT_M_COST, DEFAULT_T_COST, DEFAULT_P_COST)
    }

    /// 用自定义 Argon2id 参数创建会话。
    ///
    /// 生产路径请用 [`FileCipherSession::new`]（默认参数）；本构造器主要供
    /// 测试用低成本参数换取速度（容器头会如实登记参数，互操作不受影响）。
    ///
    /// [Wave2-R5-kdf] 会话密钥是**新写入面**（本会话加密出的对象都携带这组
    /// 参数），故 m_cost 受平台相关封顶 [`kdf_max_m_cost_for_new_password`]
    /// 约束；会话内**解密对端对象**的 [`Self::key_for`] 不经过本封顶，仍按
    /// 全局上限放行（桌面写出的高参数对象在移动端必须可解）。
    pub fn with_params(password: &str, m_cost: u32, t_cost: u32, p_cost: u32) -> Result<Self> {
        if password.is_empty() {
            return Err(anyhow!("加密密码不能为空"));
        }
        ensure_kdf_params_allowed_for_new_encryption(m_cost, t_cost, p_cost)?;
        let mut salt = [0u8; 16];
        OsRng.fill_bytes(&mut salt);
        let key = derive_key(password, &salt, m_cost, t_cost, p_cost)?;
        Ok(Self {
            password: password.to_string(),
            m_cost,
            t_cost,
            p_cost,
            salt,
            key,
            derived: std::sync::Mutex::new(std::collections::HashMap::new()),
        })
    }

    /// 取得与 (salt, params) 对应的密钥：会话自身 → 缓存 → 现场派生并缓存。
    fn key_for(&self, salt: &[u8; 16], m_cost: u32, t_cost: u32, p_cost: u32) -> Result<[u8; 32]> {
        if *salt == self.salt
            && m_cost == self.m_cost
            && t_cost == self.t_cost
            && p_cost == self.p_cost
        {
            return Ok(self.key);
        }
        let cache_key = (*salt, m_cost, t_cost, p_cost);
        {
            let cache = self
                .derived
                .lock()
                .map_err(|_| anyhow!("密钥缓存锁被毒化"))?;
            if let Some(key) = cache.get(&cache_key) {
                return Ok(*key);
            }
        }
        let key = derive_key(&self.password, salt, m_cost, t_cost, p_cost)?;
        self.derived
            .lock()
            .map_err(|_| anyhow!("密钥缓存锁被毒化"))?
            .insert(cache_key, key);
        Ok(key)
    }

    /// 加密内存 payload 为 DSBK v1 容器（复用会话密钥，无 Argon2 开销）。
    pub fn encrypt_bytes(&self, plaintext: &[u8]) -> Result<Vec<u8>> {
        encrypt_backup_with_key(
            plaintext,
            &self.salt,
            self.m_cost,
            self.t_cost,
            self.p_cost,
            &self.key,
        )
    }

    /// 解密 DSBK v1 容器（同 salt 的对象整轮只派生一次密钥）。
    pub fn decrypt_bytes(&self, data: &[u8]) -> Result<Vec<u8>> {
        decrypt_backup_with_key_provider(data, |salt, m, t, p| self.key_for(salt, m, t, p))
    }

    /// 把 `input` 文件加密到 `output`（DSBK v2 分块流式，复用会话密钥）。
    pub fn encrypt_file(&self, input: &std::path::Path, output: &std::path::Path) -> Result<()> {
        encrypt_backup_file_with_key(
            input,
            output,
            &self.salt,
            self.m_cost,
            self.t_cost,
            self.p_cost,
            &self.key,
        )
    }

    /// 解密 DSBK 文件（v1/v2 均可）到 `output`（按头部 salt 缓存派生密钥）。
    pub fn decrypt_file(&self, input: &std::path::Path, output: &std::path::Path) -> Result<()> {
        decrypt_backup_file_with_key_provider(input, output, |salt, m, t, p| {
            self.key_for(salt, m, t, p)
        })
    }
}

impl Drop for FileCipherSession {
    fn drop(&mut self) {
        self.password.zeroize();
        self.key.zeroize();
        if let Ok(mut cache) = self.derived.lock() {
            for (_, key) in cache.iter_mut() {
                key.zeroize();
            }
            cache.clear();
        }
    }
}

// =====================================================================================
// [R06-e2ee-verifier] 云端加密标记（.encryption-marker）的密码校验子
// =====================================================================================

/// 校验子摘要的域分隔前缀。
///
/// 保证摘要与任何 DSBK 备份文件的加密密钥不可互推：即使摘要存放在
/// （不受信任的）云端被读走，也无法据此解密任何备份，更无法反推密码。
const MARKER_VERIFIER_DOMAIN: &[u8] = b"deep-student.encryption-marker.verifier.v1";

/// 当前唯一支持的校验子 KDF 标识；遇到未知值调用方必须 fail-closed。
pub const PASSWORD_VERIFIER_KDF_ARGON2ID: &str = "argon2id";

/// 云端加密标记里的不可逆密码校验子。
///
/// `digest = SHA-256(domain || Argon2id(password, salt))`：
/// - 持有密码可复算摘要用于一致性比对；
/// - 由摘要不可行地反推密码（Argon2id 抗暴力破解）或任何备份加密密钥
///   （域分隔 + 校验子独立随机 salt，与各 DSBK 文件各自 salt 派生的密钥互不相同）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordVerifier {
    /// KDF 标识（当前固定 [`PASSWORD_VERIFIER_KDF_ARGON2ID`]）
    pub kdf: String,
    /// Argon2 内存参数（KiB）
    pub m_cost: u32,
    /// Argon2 迭代参数
    pub t_cost: u32,
    /// Argon2 并行度参数
    pub p_cost: u32,
    /// 随机 salt（hex）
    pub salt: String,
    /// 校验子摘要（hex，32 字节）
    pub digest: String,
}

fn verifier_digest(
    password: &str,
    salt: &[u8],
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
) -> Result<[u8; 32]> {
    use sha2::{Digest, Sha256};

    let mut key = derive_key(password, salt, m_cost, t_cost, p_cost)?;
    let mut hasher = Sha256::new();
    hasher.update(MARKER_VERIFIER_DOMAIN);
    hasher.update(key);
    key.zeroize();
    Ok(hasher.finalize().into())
}

/// 用默认 Argon2id 参数与新随机 salt 为 `password` 生成校验子。
///
/// [Wave2-R5-kdf] 新建校验子是**新写入面**，登记参数受平台相关封顶
/// [`kdf_max_m_cost_for_new_password`] 约束（默认参数 64 MiB 远低于任何平台
/// 封顶，此检查在此仅作为编译期锚点：未来有人把默认参数或本函数改成可携带
/// 自定义参数时，封顶自动生效）。**复算存量校验子**的
/// [`check_password_verifier`] 不经过本封顶，仍按全局上限放行。
pub fn create_password_verifier(password: &str) -> Result<PasswordVerifier> {
    ensure_kdf_params_allowed_for_new_encryption(DEFAULT_M_COST, DEFAULT_T_COST, DEFAULT_P_COST)?;
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let digest = verifier_digest(
        password,
        &salt,
        DEFAULT_M_COST,
        DEFAULT_T_COST,
        DEFAULT_P_COST,
    )?;
    Ok(PasswordVerifier {
        kdf: PASSWORD_VERIFIER_KDF_ARGON2ID.to_string(),
        m_cost: DEFAULT_M_COST,
        t_cost: DEFAULT_T_COST,
        p_cost: DEFAULT_P_COST,
        salt: hex::encode(salt),
        digest: hex::encode(digest),
    })
}

/// 校验 `password` 是否与 `verifier` 登记的密码一致。
///
/// 返回值语义：
/// - `Ok(true)`：一致；
/// - `Ok(false)`：密码确定不一致；
/// - `Err`：**无法校验**（未知 KDF、字段损坏等），调用方必须 fail-closed。
pub fn check_password_verifier(password: &str, verifier: &PasswordVerifier) -> Result<bool> {
    if verifier.kdf != PASSWORD_VERIFIER_KDF_ARGON2ID {
        return Err(anyhow!("未知的加密标记校验子 KDF: {}", verifier.kdf));
    }
    let salt = hex::decode(&verifier.salt).map_err(|e| anyhow!("校验子 salt 无法解析: {}", e))?;
    let expected =
        hex::decode(&verifier.digest).map_err(|e| anyhow!("校验子摘要无法解析: {}", e))?;
    if expected.len() != 32 {
        return Err(anyhow!("校验子摘要长度非法: {} 字节", expected.len()));
    }
    let actual = verifier_digest(
        password,
        &salt,
        verifier.m_cost,
        verifier.t_cost,
        verifier.p_cost,
    )?;
    // 常数时间比较（摘要本就可被云端读到，此处仅为防御性习惯）
    let mut diff = 0u8;
    for (a, b) in actual.iter().zip(expected.iter()) {
        diff |= a ^ b;
    }
    Ok(diff == 0)
}

// =====================================================================================
// [R10-verifier] 本机「该云端目录曾经加密」记忆
// =====================================================================================

/// 根指纹的域分隔前缀：本地文件里只落指纹哈希，不落明文 endpoint/用户名/路径。
const ENCRYPTED_ROOT_FINGERPRINT_DOMAIN: &[u8] = b"deep-student.encrypted-root-memory.v1";

/// 记忆文件格式版本。
const ENCRYPTED_ROOT_MEMORY_VERSION: u32 = 1;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedRootMemoryFile {
    version: u32,
    /// 根指纹（hex SHA-256）→ 首次观察到加密的时间（RFC3339，仅诊断用）
    roots: std::collections::BTreeMap<String, String>,
}

/// 本机持久化的「云端目录曾经加密」记忆。
///
/// 云端 `.encryption-marker` 是明文上传门禁的**第一道**防线，但它存放在
/// （不受信任的）云端：被人为/意外删除后，仅靠云端状态会默许后续明文上传，
/// 把本应加密的数据以明文混入同一恢复链。本存储在本机补第二道防线：
///
/// - 每当本机确认某云 root 处于加密状态（登记/校验标记成功、或读到标记），
///   就把该 root 的**指纹**记入本地文件（[`Self::remember`]，幂等）；
/// - 明文上传前若云端标记缺失、但本机记得该 root 曾加密，仍拒绝明文上传
///   （[`Self::was_encrypted`]，fail-closed）。
///
/// 语义边界（有意为之）：
/// - 记忆只影响**本机**的明文上传判定，不上传到云端、不影响其他设备，也不影响
///   带密码的加密上传（加密上传走校验子门禁，标记缺失时会用本机密码重新登记）；
/// - 记忆文件缺失 = 无记忆（全新安装/换机后由云端标记继续兜底）；
///   文件存在但无法解析 = 全部按「曾加密」处理（fail-closed，与云端标记
///   损坏按存在处理同一取向）。
pub struct EncryptedRootMemory {
    path: std::path::PathBuf,
}

impl EncryptedRootMemory {
    /// 以指定文件路径打开（不存在时首个 [`Self::remember`] 会创建）。
    pub fn at(path: impl Into<std::path::PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// 把云存储实例绑定提示（`CloudStorage::instance_binding_hint`，不含凭据）
    /// 折叠为域分隔的 SHA-256 指纹：本地文件不落任何明文远端信息。
    pub fn fingerprint(binding_hint: &str) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(ENCRYPTED_ROOT_FINGERPRINT_DOMAIN);
        hasher.update(binding_hint.as_bytes());
        hex::encode(hasher.finalize())
    }

    /// 读取记忆文件。`Ok(None)` = 文件不存在；`Err` = 存在但无法读取/解析。
    fn load(&self) -> Result<Option<EncryptedRootMemoryFile>> {
        let data = match std::fs::read(&self.path) {
            Ok(data) => data,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(anyhow!("读取本机加密目录记忆失败: {e}")),
        };
        let file: EncryptedRootMemoryFile = serde_json::from_slice(&data)
            .map_err(|e| anyhow!("本机加密目录记忆内容无法解析: {e}"))?;
        Ok(Some(file))
    }

    /// 幂等登记「该 root 曾经加密」。原子写入（临时文件 + rename）。
    ///
    /// 既有文件无法解析时以全新内容覆盖重建（记忆是第二道防线，重建期间
    /// 云端标记仍是第一道门禁；重建后本 root 的记忆立即恢复生效）。
    pub fn remember(&self, fingerprint: &str) -> Result<()> {
        let mut file = match self.load() {
            Ok(Some(file)) => file,
            Ok(None) | Err(_) => EncryptedRootMemoryFile {
                version: ENCRYPTED_ROOT_MEMORY_VERSION,
                roots: std::collections::BTreeMap::new(),
            },
        };
        if file.roots.contains_key(fingerprint) {
            return Ok(());
        }
        file.roots.insert(
            fingerprint.to_string(),
            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        );

        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| anyhow!("创建本机加密目录记忆目录失败: {e}"))?;
        }
        let data = serde_json::to_vec_pretty(&file)
            .map_err(|e| anyhow!("序列化本机加密目录记忆失败: {e}"))?;
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, &data).map_err(|e| anyhow!("写入本机加密目录记忆失败: {e}"))?;
        std::fs::rename(&tmp, &self.path).map_err(|e| anyhow!("保存本机加密目录记忆失败: {e}"))?;
        Ok(())
    }

    /// 本机是否记得该 root 曾经加密。
    ///
    /// 文件不存在 → `false`；文件存在但无法读取/解析 → `true`（fail-closed：
    /// 宁可多拦一次明文上传，也不能让损坏的本地记忆悄悄放行明文）。
    pub fn was_encrypted(&self, fingerprint: &str) -> bool {
        match self.load() {
            Ok(Some(file)) => file.roots.contains_key(fingerprint),
            Ok(None) => false,
            Err(_) => true,
        }
    }
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
    fn password_verifier_roundtrip_and_wrong_password() {
        let verifier = create_password_verifier("correct horse battery staple").unwrap();
        assert_eq!(verifier.kdf, PASSWORD_VERIFIER_KDF_ARGON2ID);
        assert_eq!(verifier.salt.len(), 32, "16 字节 salt 的 hex 应为 32 字符");
        assert_eq!(verifier.digest.len(), 64, "SHA-256 摘要 hex 应为 64 字符");

        assert!(check_password_verifier("correct horse battery staple", &verifier).unwrap());
        assert!(!check_password_verifier("wrong password", &verifier).unwrap());
    }

    #[test]
    fn password_verifier_digest_does_not_leak_key() {
        // 校验子摘要绝不能等于任何由同一密码派生的加密密钥
        //（域分隔保证：digest = SHA256(domain || key) != key）。
        let password = "pw-2026";
        let verifier = create_password_verifier(password).unwrap();
        let salt = hex::decode(&verifier.salt).unwrap();
        let key = derive_key(
            password,
            &salt,
            verifier.m_cost,
            verifier.t_cost,
            verifier.p_cost,
        )
        .unwrap();
        assert_ne!(hex::encode(key), verifier.digest);
    }

    #[test]
    fn password_verifier_unknown_kdf_fails_closed() {
        let mut verifier = create_password_verifier("pw").unwrap();
        verifier.kdf = "quantum-kdf-9000".to_string();
        assert!(
            check_password_verifier("pw", &verifier).is_err(),
            "未知 KDF 必须返回 Err（由调用方 fail-closed），不能误判为一致/不一致"
        );
    }

    #[test]
    fn password_verifier_corrupted_fields_fail_closed() {
        let good = create_password_verifier("pw").unwrap();

        let mut bad_salt = good.clone();
        bad_salt.salt = "not-hex!!".to_string();
        assert!(check_password_verifier("pw", &bad_salt).is_err());

        let mut bad_digest_len = good.clone();
        bad_digest_len.digest = "deadbeef".to_string();
        assert!(check_password_verifier("pw", &bad_digest_len).is_err());

        // 篡改摘要内容（长度合法）→ 判定为不一致，而不是 Err
        let mut tampered = good.clone();
        let mut digest_bytes = hex::decode(&tampered.digest).unwrap();
        digest_bytes[0] ^= 0xFF;
        tampered.digest = hex::encode(digest_bytes);
        assert!(!check_password_verifier("pw", &tampered).unwrap());
    }

    // ---------------- [R07-file-e2ee] FileCipherSession ----------------

    /// 测试用低成本 Argon2 参数（容器头如实登记，互操作不受影响）
    fn cheap_session(password: &str) -> FileCipherSession {
        FileCipherSession::with_params(password, 8, 1, 1).unwrap()
    }

    #[test]
    fn session_bytes_roundtrip_and_wrong_password() {
        let session = cheap_session("session-pw");
        let a = session.encrypt_bytes(b"payload-a").unwrap();
        let b = session.encrypt_bytes(b"payload-b").unwrap();
        assert!(is_encrypted_backup(&a));
        // 同会话共用 salt，但 nonce 必须各自随机 → 密文不同
        assert_eq!(&a[5..33], &b[5..33], "同会话 params+salt 应一致");
        assert_ne!(&a[33..45], &b[33..45], "nonce 必须每对象独立随机");

        assert_eq!(session.decrypt_bytes(&a).unwrap(), b"payload-a");
        assert_eq!(session.decrypt_bytes(&b).unwrap(), b"payload-b");

        let other = cheap_session("wrong-pw");
        assert!(other.decrypt_bytes(&a).is_err(), "错误密码必须解密失败");
    }

    #[test]
    fn session_file_roundtrip_across_sessions() {
        // 设备 A 的会话加密 → 设备 B 的会话（不同随机 salt）解密：
        // 走 key_for 的缓存派生路径，等价于跨设备同步下载。
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("in.bin");
        let enc = dir.path().join("enc.dsbk");
        let dec = dir.path().join("dec.bin");
        let plain: Vec<u8> = (0..70_000usize).map(|i| (i % 253) as u8).collect();
        std::fs::write(&input, &plain).unwrap();

        let a = cheap_session("shared-pw");
        a.encrypt_file(&input, &enc).unwrap();
        let head = std::fs::read(&enc).unwrap();
        assert!(is_encrypted_backup(&head));
        assert_eq!(head[4], BACKUP_CRYPTO_VERSION_STREAM);

        let b = cheap_session("shared-pw");
        b.decrypt_file(&enc, &dec).unwrap();
        assert_eq!(std::fs::read(&dec).unwrap(), plain);

        // 第二个来自 A 的对象命中 B 的密钥缓存（行为等价，重点是结果正确）
        let enc2 = dir.path().join("enc2.dsbk");
        let dec2 = dir.path().join("dec2.bin");
        a.encrypt_file(&input, &enc2).unwrap();
        b.decrypt_file(&enc2, &dec2).unwrap();
        assert_eq!(std::fs::read(&dec2).unwrap(), plain);

        let evil = cheap_session("wrong-pw");
        let dec3 = dir.path().join("dec3.bin");
        assert!(evil.decrypt_file(&enc, &dec3).is_err());
    }

    #[test]
    fn session_output_interoperates_with_password_api() {
        // 会话输出必须能被「每次派生」的密码 API 解密，反向亦然。
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("in.bin");
        std::fs::write(&input, b"interop payload").unwrap();

        let session = cheap_session("pw-interop");
        let enc = dir.path().join("enc.dsbk");
        session.encrypt_file(&input, &enc).unwrap();
        let dec = dir.path().join("dec.bin");
        decrypt_backup_file(&enc, &dec, "pw-interop").unwrap();
        assert_eq!(std::fs::read(&dec).unwrap(), b"interop payload");

        // 反向：密码 API（默认参数）加密的 v1 payload，会话可解密
        let v1 = encrypt_backup(b"legacy payload", "pw-interop").unwrap();
        assert_eq!(session.decrypt_bytes(&v1).unwrap(), b"legacy payload");
    }

    #[test]
    fn session_rejects_empty_password() {
        assert!(FileCipherSession::with_params("", 8, 1, 1).is_err());
    }

    // ---------------- [R10-verifier] KDF 参数应用级上限 ----------------

    #[test]
    fn kdf_limits_cover_default_write_surface() {
        // 上限必须显著高于自家默认写入面，否则会拒收自家旧备份。
        assert!(DEFAULT_M_COST <= KDF_MAX_M_COST_KIB);
        assert!(DEFAULT_T_COST <= KDF_MAX_T_COST);
        assert!(DEFAULT_P_COST <= KDF_MAX_P_COST);
        // 默认参数派生必须照常工作
        assert!(derive_key(
            "pw",
            &[7u8; 16],
            DEFAULT_M_COST,
            DEFAULT_T_COST,
            DEFAULT_P_COST
        )
        .is_ok());
    }

    #[test]
    fn kdf_oversized_params_rejected_before_derivation() {
        for (m, t, p, label) in [
            (KDF_MAX_M_COST_KIB + 1, 1u32, 1u32, "m_cost 超限"),
            (u32::MAX, 1, 1, "m_cost 极大"),
            (8, KDF_MAX_T_COST + 1, 1, "t_cost 超限"),
            (8, 1, KDF_MAX_P_COST + 1, "p_cost 超限"),
        ] {
            let start = std::time::Instant::now();
            let err =
                derive_key("pw", &[7u8; 16], m, t, p).expect_err(&format!("{label} 必须被拒绝"));
            assert!(
                start.elapsed() < std::time::Duration::from_millis(200),
                "{label} 必须在派生开始前拒绝（亚秒返回），实际耗时 {:?}",
                start.elapsed()
            );
            assert!(
                err.to_string().contains("加密参数异常"),
                "{label} 错误应为用户级文案: {err}"
            );
        }
    }

    #[test]
    fn verifier_oversized_params_fail_closed_as_err() {
        // 校验子路径：超限必须是 Err（无法校验，调用方 fail-closed），
        // 不能与 Ok(false)（密码不一致）混淆。
        let mut verifier = create_password_verifier("pw").unwrap();
        verifier.m_cost = u32::MAX;
        assert!(check_password_verifier("pw", &verifier).is_err());
    }

    #[test]
    fn dsbk_headers_with_oversized_params_rejected() {
        // v1 整块容器：改写头部 m_cost（offset 5..9，LE）为极大值
        let mut v1 = encrypt_backup(b"payload", "pw").unwrap();
        v1[5..9].copy_from_slice(&u32::MAX.to_le_bytes());
        let err = decrypt_backup(&v1, "pw").expect_err("超限 v1 头必须拒绝");
        assert!(err.to_string().contains("加密参数异常"));

        // v2 流式容器：同一头部布局
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("in.bin");
        let enc = dir.path().join("enc.dsbk");
        let dec = dir.path().join("dec.bin");
        std::fs::write(&input, vec![5u8; 4096]).unwrap();
        encrypt_backup_file(&input, &enc, "pw").unwrap();
        let mut bytes = std::fs::read(&enc).unwrap();
        bytes[5..9].copy_from_slice(&u32::MAX.to_le_bytes());
        std::fs::write(&enc, &bytes).unwrap();
        let err = decrypt_backup_file(&enc, &dec, "pw").expect_err("超限 v2 头必须拒绝");
        assert!(err.to_string().contains("加密参数异常"));
        assert!(!dec.exists(), "拒绝发生在创建输出文件之前");
    }

    // ---------------- [Wave2-R5-kdf] 新设口令平台封顶 ----------------

    #[test]
    fn new_password_cap_matches_platform_and_never_loosens_global_cap() {
        let cap = kdf_max_m_cost_for_new_password();
        if cfg!(any(target_os = "android", target_os = "ios")) {
            assert_eq!(
                cap, KDF_NEW_PASSWORD_MAX_M_COST_KIB_MOBILE,
                "移动端新写入面封顶必须是 256 MiB"
            );
        } else {
            assert_eq!(
                cap, KDF_MAX_M_COST_KIB,
                "桌面端新写入面维持全局上限（行为不变，仅文档化）"
            );
        }
        assert!(
            cap <= KDF_MAX_M_COST_KIB,
            "新写入面封顶只能比全局解密上限更严或相等，绝不放宽解密侧判定"
        );
    }

    #[test]
    fn new_password_cap_covers_default_write_surface_on_every_platform() {
        // 默认生产参数（64 MiB / t=3 / p=4）必须在最严的平台封顶（移动端
        // 256 MiB）之内，否则默认加密在移动端会被自家封顶拒绝。
        assert!(DEFAULT_M_COST <= KDF_NEW_PASSWORD_MAX_M_COST_KIB_MOBILE);
        assert!(DEFAULT_M_COST <= kdf_max_m_cost_for_new_password());
        // 封顶内参数照常可建新会话（低成本参数）与新校验子（默认参数）
        assert!(FileCipherSession::with_params("pw", 8, 1, 1).is_ok());
        assert!(create_password_verifier("pw").is_ok());
    }

    #[test]
    fn session_with_params_rejects_m_cost_above_new_password_cap() {
        // 超出本平台新写入面封顶一格：必须拒绝，且不产生任何派生开销。
        let over = kdf_max_m_cost_for_new_password() + 1;
        let start = std::time::Instant::now();
        let err = FileCipherSession::with_params("pw", over, 1, 1)
            .err()
            .expect("超封顶的新加密会话必须拒绝");
        assert!(
            start.elapsed() < std::time::Duration::from_millis(200),
            "封顶检查必须在派生开始前拒绝，实际耗时 {:?}",
            start.elapsed()
        );
        // 桌面上 over 已同时超全局上限（两组封顶相等），两种文案都可接受；
        // 关键是必须 Err 且为用户级文案之一。
        let text = err.to_string();
        assert!(
            text.contains("超出本设备可安全承受") || text.contains("加密参数异常"),
            "错误应为用户级文案: {text}"
        );
    }

    #[test]
    fn decrypt_and_legacy_verifier_paths_are_not_tightened_by_new_password_cap() {
        // 红线：解密/存量 verifier 复算仍按全局上限（1 GiB）放行。
        // 介于「移动端新设封顶」与「全局上限」之间的 m_cost 对解密预检必须
        // 依旧通过（真派生要吃数百 MiB 内存，这里只锁预检判定方向）。
        let legacy_m = KDF_NEW_PASSWORD_MAX_M_COST_KIB_MOBILE + 1;
        assert!(legacy_m <= KDF_MAX_M_COST_KIB, "测试前提：区间非空");
        assert!(
            ensure_kdf_params_within_app_limits(legacy_m, DEFAULT_T_COST, DEFAULT_P_COST).is_ok(),
            "解密/存量路径的预检不得引用新设封顶"
        );
        // 对照：同一参数在新写入面预检里，移动端必须拒绝、桌面维持放行。
        let new_write =
            ensure_kdf_params_allowed_for_new_encryption(legacy_m, DEFAULT_T_COST, DEFAULT_P_COST);
        if cfg!(any(target_os = "android", target_os = "ios")) {
            assert!(new_write.is_err(), "移动端新写入面必须拒绝 256 MiB 以上");
        } else {
            assert!(new_write.is_ok(), "桌面端新写入面行为不变");
        }
    }

    // ---------------- [R10-verifier] 本机加密目录记忆 ----------------

    #[test]
    fn encrypted_root_memory_roundtrip_and_isolation() {
        let dir = tempfile::tempdir().unwrap();
        let memory = EncryptedRootMemory::at(dir.path().join("nested").join("roots.json"));
        let fp_a = EncryptedRootMemory::fingerprint("webdav|endpoint=https://a|root=x");
        let fp_b = EncryptedRootMemory::fingerprint("webdav|endpoint=https://b|root=y");

        assert!(!memory.was_encrypted(&fp_a), "无记忆文件时不应误报");
        memory.remember(&fp_a).unwrap();
        memory.remember(&fp_a).unwrap(); // 幂等
        assert!(memory.was_encrypted(&fp_a));
        assert!(!memory.was_encrypted(&fp_b), "记忆必须按 root 指纹隔离");

        // 落盘内容不含明文远端信息
        let raw = std::fs::read_to_string(dir.path().join("nested").join("roots.json")).unwrap();
        assert!(!raw.contains("https://a"), "记忆文件不得落明文 endpoint");
        assert!(raw.contains(&fp_a));
    }

    #[test]
    fn encrypted_root_memory_corrupted_file_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("roots.json");
        std::fs::write(&path, b"not json {{{").unwrap();
        let memory = EncryptedRootMemory::at(&path);
        let fp = EncryptedRootMemory::fingerprint("any");
        assert!(
            memory.was_encrypted(&fp),
            "损坏的记忆文件必须按「曾加密」处理（fail-closed）"
        );
        // remember 可重建文件，重建后语义恢复正常
        memory.remember(&fp).unwrap();
        assert!(memory.was_encrypted(&fp));
        assert!(!memory.was_encrypted(&EncryptedRootMemory::fingerprint("other")));
    }

    // ---------------- [R12-repocheck-fix] DSBK 布局 SSOT 常量 ----------------

    #[test]
    fn dsbk_layout_constants_match_real_containers() {
        // 布局常量必须锚定真实加密产物：空明文的 v1 容器 = 头 + 单块 GCM tag，
        // v2 容器 = 头 + 一个（空 final 块的）GCM tag。任何写入路径的布局漂移
        // 都会先在这里失败，而不是等 repo_check 在线上误报。
        let v1 = encrypt_backup(b"", "layout-pin-pw").unwrap();
        assert_eq!(v1.len(), DSBK_V1_HEADER_LEN + DSBK_GCM_TAG_LEN);
        assert_eq!(&v1[..4], DSBK_MAGIC);
        assert_eq!(v1[4], BACKUP_CRYPTO_VERSION);

        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("empty.bin");
        let enc = dir.path().join("empty.dsbk");
        std::fs::write(&input, b"").unwrap();
        encrypt_backup_file(&input, &enc, "layout-pin-pw").unwrap();
        let v2 = std::fs::read(&enc).unwrap();
        assert_eq!(v2.len(), DSBK_V2_HEADER_LEN + DSBK_GCM_TAG_LEN);
        assert_eq!(&v2[..4], DSBK_MAGIC);
        assert_eq!(v2[4], BACKUP_CRYPTO_VERSION_STREAM);
        // chunk 字段在 [40..44)，写入值为流式明文分块大小（1 MiB）。
        let chunk = u32::from_le_bytes(
            v2[DSBK_V2_CHUNK_OFFSET..DSBK_V2_HEADER_LEN]
                .try_into()
                .unwrap(),
        );
        assert_eq!(chunk as usize, STREAM_PLAINTEXT_CHUNK);
        assert!(chunk <= DSBK_MAX_PLAINTEXT_CHUNK);
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

    // ---------------- [R5-prove-cost] DSBK v2 首块试解 ----------------

    /// 用低成本参数把 `plain_len` 字节的固定 pattern 明文加密为 v2 容器字节。
    fn cheap_v2_object(password: &str, plain_len: usize) -> Vec<u8> {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("in.bin");
        let enc = dir.path().join("enc.dsbk");
        let plain: Vec<u8> = (0..plain_len).map(|i| (i % 251) as u8).collect();
        std::fs::write(&input, &plain).unwrap();
        cheap_session(password).encrypt_file(&input, &enc).unwrap();
        std::fs::read(&enc).unwrap()
    }

    #[test]
    fn first_chunk_trial_proves_password_with_prefix_only() {
        // 多块对象（3 个分块）：只凭「头 + 首块」前缀即可证明口令，
        // 其余分块字节完全不需要在场。
        let object = cheap_v2_object("prove-pw", STREAM_PLAINTEXT_CHUNK * 2 + 123);
        let object_len = object.len() as u64;
        let FirstChunkPlan::StreamV2 { prefix_len } =
            plan_first_chunk_trial(&object, object_len).unwrap()
        else {
            panic!("v2 容器必须给出 StreamV2 计划");
        };
        assert_eq!(
            prefix_len,
            (DSBK_V2_HEADER_LEN + STREAM_PLAINTEXT_CHUNK + DSBK_GCM_TAG_LEN) as u64,
            "多块对象的首块前缀 = 头 + 满分块 + tag"
        );
        assert!(prefix_len < object_len, "前缀必须严格小于整包");

        // 只保留前缀，其余字节丢弃——试解仍必须通过。
        let prefix = &object[..prefix_len as usize];
        trial_decrypt_first_chunk(prefix, object_len, "prove-pw")
            .expect("正确口令的首块试解必须通过");
        assert!(
            trial_decrypt_first_chunk(prefix, object_len, "wrong-pw").is_err(),
            "错误口令必须在首块 tag 校验即失败"
        );
    }

    #[test]
    fn first_chunk_trial_final_flag_matches_object_size() {
        // final 标记并入 nonce：单块对象（首块即 final）与恰好一整块的对象
        // 都必须按对象总长正确判定，否则 tag 必然失败。
        for plain_len in [0usize, 100, STREAM_PLAINTEXT_CHUNK] {
            let object = cheap_v2_object("final-pw", plain_len);
            let object_len = object.len() as u64;
            let FirstChunkPlan::StreamV2 { prefix_len } =
                plan_first_chunk_trial(&object, object_len).unwrap()
            else {
                panic!("v2 容器必须给出 StreamV2 计划");
            };
            assert_eq!(
                prefix_len, object_len,
                "单块对象的首块前缀就是整个对象（plain_len={plain_len}）"
            );
            trial_decrypt_first_chunk(&object, object_len, "final-pw")
                .unwrap_or_else(|e| panic!("plain_len={plain_len} 首块试解应通过: {e}"));
        }
        // 多块对象的首块是非 final 块：谎报对象总长（假装单块）必须 tag 失败，
        // 不能把非 final 块当 final 解出来。
        let object = cheap_v2_object("final-pw", STREAM_PLAINTEXT_CHUNK + 1024);
        let FirstChunkPlan::StreamV2 { prefix_len } =
            plan_first_chunk_trial(&object, object.len() as u64).unwrap()
        else {
            panic!("v2 容器必须给出 StreamV2 计划");
        };
        assert!(
            trial_decrypt_first_chunk(&object[..prefix_len as usize], prefix_len, "final-pw")
                .is_err(),
            "把多块对象谎报成单块（final 判定翻转）必须失败"
        );
    }

    #[test]
    fn first_chunk_trial_tampered_first_block_fails() {
        let mut object = cheap_v2_object("tamper-pw", 4096);
        let object_len = object.len() as u64;
        object[DSBK_V2_HEADER_LEN + 1] ^= 0xFF;
        assert!(
            trial_decrypt_first_chunk(&object, object_len, "tamper-pw").is_err(),
            "首块密文被篡改必须 tag 失败"
        );
    }

    #[test]
    fn first_chunk_plan_v1_requires_whole_file() {
        // v1 单块容器：计划必须回退整文件路径，试解 API 必须拒绝（而不是误报口令错误以外的成功）。
        let v1 = encrypt_backup(b"legacy payload", "pw").unwrap();
        assert_eq!(
            plan_first_chunk_trial(&v1, v1.len() as u64).unwrap(),
            FirstChunkPlan::LegacyV1WholeFile
        );
        let err = trial_decrypt_first_chunk(&v1, v1.len() as u64, "pw")
            .expect_err("v1 容器不支持首块试解");
        assert!(
            err.to_string().contains("整文件"),
            "错误应指引整文件路径: {err}"
        );
        // 存量 v1 仍可整文件解密（回退路径的正确性由既有 API 保证）。
        assert_eq!(decrypt_backup(&v1, "pw").unwrap(), b"legacy payload");
    }

    #[test]
    fn first_chunk_plan_rejects_bad_headers() {
        // 非 DSBK
        assert!(plan_first_chunk_trial(b"PK\x03\x04zip!", 100).is_err());
        // 太短
        assert!(plan_first_chunk_trial(b"DSB", 100).is_err());
        // 未知版本
        let mut unknown = cheap_v2_object("pw", 128);
        unknown[4] = 9;
        assert!(plan_first_chunk_trial(&unknown, unknown.len() as u64).is_err());

        // chunk 字段非法：0 与超上限都必须在任何派生/解密之前拒绝
        let good = cheap_v2_object("pw", 128);
        for bad_chunk in [0u32, DSBK_MAX_PLAINTEXT_CHUNK + 1] {
            let mut bad = good.clone();
            bad[DSBK_V2_CHUNK_OFFSET..DSBK_V2_HEADER_LEN].copy_from_slice(&bad_chunk.to_le_bytes());
            let err =
                plan_first_chunk_trial(&bad, bad.len() as u64).expect_err("非法 chunk 必须拒绝");
            assert!(err.to_string().contains("分块大小非法"), "实际: {err}");
        }

        // 对象总长装不下「头 + 一个 tag」：截断对象
        let err = plan_first_chunk_trial(&good, (DSBK_V2_HEADER_LEN + DSBK_GCM_TAG_LEN - 1) as u64)
            .expect_err("装不下最小体积的对象必须拒绝");
        assert!(err.to_string().contains("缺少数据块"), "实际: {err}");
    }

    #[test]
    fn first_chunk_trial_truncated_prefix_rejected() {
        let object = cheap_v2_object("prefix-pw", 4096);
        let object_len = object.len() as u64;
        // 前缀差 1 字节：必须在解密前明确拒绝（fail-closed），不得越界或误判
        let err = trial_decrypt_first_chunk(&object[..object.len() - 1], object_len, "prefix-pw")
            .expect_err("前缀不足必须拒绝");
        assert!(err.to_string().contains("前缀不足"), "实际: {err}");
    }

    #[test]
    fn first_chunk_trial_oversized_kdf_params_rejected_fast() {
        // 头部 m_cost 改成极大值：必须在派生开始前拒绝（与整文件解密同一道闸）。
        let mut object = cheap_v2_object("kdf-pw", 4096);
        let object_len = object.len() as u64;
        object[5..9].copy_from_slice(&u32::MAX.to_le_bytes());
        let start = std::time::Instant::now();
        let err = trial_decrypt_first_chunk(&object, object_len, "kdf-pw")
            .expect_err("超限 KDF 参数必须拒绝");
        assert!(
            start.elapsed() < std::time::Duration::from_millis(200),
            "必须在派生开始前拒绝（亚秒返回），实际耗时 {:?}",
            start.elapsed()
        );
        assert!(err.to_string().contains("加密参数异常"), "实际: {err}");
    }

    #[test]
    fn speculative_prefix_len_covers_own_write_surface() {
        // 投机前缀必须覆盖本应用自己写出的一切 v2 对象的首块计划：
        // 大对象一次前缀读即可完成试解，小对象钳到对象总长。
        for plain_len in [
            0usize,
            100,
            STREAM_PLAINTEXT_CHUNK,
            STREAM_PLAINTEXT_CHUNK * 2 + 7,
        ] {
            let object = cheap_v2_object("spec-pw", plain_len);
            let object_len = object.len() as u64;
            let FirstChunkPlan::StreamV2 { prefix_len } =
                plan_first_chunk_trial(&object, object_len).unwrap()
            else {
                panic!("v2 容器必须给出 StreamV2 计划");
            };
            let speculative = dsbk_first_chunk_speculative_prefix_len(object_len);
            assert!(
                speculative >= prefix_len,
                "自家写入面（1 MiB 分块）必须一次投机前缀读覆盖：plain_len={plain_len}, \
                 speculative={speculative}, plan={prefix_len}"
            );
            assert!(speculative <= object_len, "投机前缀不得超过对象总长");
        }
        // 外部工具写出更大分块（>1 MiB）时投机前缀不够：由计划给出精确长度补读。
        let mut foreign = cheap_v2_object("spec-pw", 128);
        foreign[DSBK_V2_CHUNK_OFFSET..DSBK_V2_HEADER_LEN]
            .copy_from_slice(&(4u32 * 1024 * 1024).to_le_bytes());
        let pretended_len = (DSBK_V2_HEADER_LEN + 8 * 1024 * 1024) as u64;
        let FirstChunkPlan::StreamV2 { prefix_len } =
            plan_first_chunk_trial(&foreign, pretended_len).unwrap()
        else {
            panic!("v2 容器必须给出 StreamV2 计划");
        };
        assert!(
            prefix_len > dsbk_first_chunk_speculative_prefix_len(pretended_len),
            "非默认大分块必须触发按计划补读"
        );
    }
}
