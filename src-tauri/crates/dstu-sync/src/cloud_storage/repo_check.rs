//! 云端仓库巡检（restic `check` 档，只读不修）[R11-check]
//!
//! 遍历云端 manifest 引用的每个备份对象，核对：
//!
//! - **存在性**：manifest 引用的 `backups/<id>.zip` 是否真的存在；
//! - **SHA256**：对象内容哈希是否与 manifest 登记的校验和一致；
//! - **DSBK 头可解**：端到端加密仓库（存在 `.encryption-marker`）里的
//!   对象是否携带可解析的 DSBK 加密头（明文混布 / 头损坏都会被报出）；
//! - **孤儿对象**：`backups/` 下未被任何 manifest 引用的对象、
//!   `manifests/` 下的 `.tmp` 残留。
//!
//! ## 只读契约
//!
//! 巡检**绝不**写入、覆盖或删除任何云端对象——发现坏对象后怎么处理
//! 由用户根据报告自行决定（UI 附带处置指引）。
//!
//! ## 诚实性契约
//!
//! 任何云端列表被截断（[`super::traits::ListOutcome::truncated`]）或对象
//! 读取失败时，结论一律降级为 [`RepoCheckStatus::Incomplete`]，**绝不**
//! 在信息不完整的情况下给出「全绿」结论。此外，manifests 列表截断时
//! 孤儿检测会整体跳过——「未被（我们看到的那部分）manifest 引用」不足以
//! 断言对象是孤儿。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use super::sync_manager::CloudManifest;
use super::traits::{CloudStorage, Result};
use crate::crypto::backup_crypto::{
    DSBK_GCM_TAG_LEN, DSBK_MAGIC, DSBK_MAX_PLAINTEXT_CHUNK, DSBK_V1_HEADER_LEN,
    DSBK_V2_CHUNK_OFFSET, DSBK_V2_HEADER_LEN,
};
use crate::models::AppError;

/// 备份对象目录（与 `sync_manager.rs` 的布局常量一致；对象布局是跨版本
/// 稳定的存储格式，此处刻意复制而非引用，避免动 R11-lease 独占的文件）。
const BACKUPS_PREFIX: &str = "backups/";
/// per-device manifest 目录。
const MANIFESTS_PREFIX: &str = "manifests/";
/// 旧版单文件 manifest 及其备份（兼容读取）。
const LEGACY_MANIFEST_KEYS: [&str; 2] = ["manifest.json", "manifest.json.bak"];
/// 云端加密标记对象。
const ENCRYPTION_MARKER_KEY: &str = ".encryption-marker";

// DSBK 容器布局常量一律引用 `crypto::backup_crypto` 的 SSOT 导出（见上方
// use），**禁止在此复制字面量**——R11-check 曾把 v2 头长抄成 48（真实 44）、
// chunk 字段从密文区读取，造成加密仓库约 98.4% 误报「头不可解」
// （FINDINGS-R11 P1-1，R12-repocheck-fix 修复）。

/// DSBK v1 对象最小体积：头 + 单块 GCM tag。
const DSBK_V1_MIN_OBJECT_LEN: u64 = (DSBK_V1_HEADER_LEN + DSBK_GCM_TAG_LEN) as u64;
/// DSBK v2 对象最小体积：头 + 一个（空 final 块的）GCM tag。
const DSBK_V2_MIN_OBJECT_LEN: u64 = (DSBK_V2_HEADER_LEN + DSBK_GCM_TAG_LEN) as u64;
/// 读取对象头部做 DSBK 判定所需的探针长度（覆盖 v1/v2 头）。
const HEAD_PROBE_LEN: usize = 64;

/// 报告里最多保留的问题条目数；超出部分只计数不列明细
/// （`problems_truncated = true`，此时 status 必然已非全绿）。
const MAX_REPORTED_PROBLEMS: usize = 500;

/// 巡检发现的问题类别。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RepoCheckProblemKind {
    /// manifest 引用的对象在云端不存在
    MissingObject,
    /// 对象内容 SHA256 与 manifest 登记的校验和不符
    ChecksumMismatch,
    /// 对象带 DSBK 魔数但加密头无法解析（版本未知 / 参数非法 / 被截断）
    UndecodableDsbkHeader,
    /// 加密仓库（有加密标记）中发现无 DSBK 头的明文对象
    PlaintextInEncryptedRepo,
    /// 对象是 DSBK 密文但云端没有加密标记（标记疑似被删）
    EncryptedWithoutMarker,
    /// `backups/` 下未被任何 manifest 引用的对象
    OrphanObject,
    /// `manifests/` 下的临时文件残留（`.tmp`）
    TempLeftover,
    /// manifest 无法解析或含非法条目
    CorruptManifest,
    /// 同一版本 ID 在不同 manifest 中登记了互相矛盾的校验和
    ConflictingManifestEntry,
    /// 加密标记对象存在但内容无法解析（按加密仓库对待，fail-closed）
    CorruptEncryptionMarker,
    /// 对象读取失败（网络等原因）——巡检不完整，不能视为全绿
    ObjectReadFailed,
}

/// 巡检总体结论。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RepoCheckStatus {
    /// 全绿：所有引用对象核对通过、无孤儿、列表完整
    Ok,
    /// 发现问题（见 `problems`）
    ProblemsFound,
    /// 巡检不完整（列表截断或对象读取失败），**拒绝**给出全绿结论
    Incomplete,
}

/// 单条巡检问题。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoCheckProblem {
    pub kind: RepoCheckProblemKind,
    /// 相关云端对象 key（如 `backups/xxx.zip`）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_key: Option<String>,
    /// 相关备份版本 ID（manifest 引用问题时给出）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version_id: Option<String>,
    /// 面向排查的细节说明
    pub detail: String,
}

/// 巡检报告（只读产物，可直接经 IPC 序列化给前端）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoCheckReport {
    pub status: RepoCheckStatus,
    /// 任一云端列表被截断（此时 status 不可能为 Ok）
    pub listing_truncated: bool,
    /// 云端是否存在加密标记（决定 DSBK 头核查的期望）
    pub encryption_marker_present: bool,
    /// manifest 引用的版本总数（去重后）
    pub versions_referenced: usize,
    /// 实际完成完整校验（下载 + 哈希）的对象数
    pub objects_checked: usize,
    /// 完整校验累计的字节数
    pub bytes_verified: u64,
    /// 孤儿对象总数（含未列入 `problems` 的部分）
    pub orphan_objects: usize,
    /// 问题明细（最多 [`MAX_REPORTED_PROBLEMS`] 条）
    pub problems: Vec<RepoCheckProblem>,
    /// 问题明细是否被截断
    pub problems_truncated: bool,
    pub checked_at: DateTime<Utc>,
}

/// manifest 聚合出的单个版本的期望值。
#[derive(Default)]
struct ExpectedVersion {
    /// 各 manifest 登记的校验和（正常应恰好一个；>1 即条目冲突）
    checksums: BTreeSet<String>,
}

/// 版本 ID 白名单校验（与 `sync_manager::validate_version_id` 同规则）：
/// 非法 ID 不得拼入云端 key，也说明 manifest 本身有问题。
fn version_id_is_valid(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn checksum_is_valid(checksum: &str) -> bool {
    checksum.len() == 64 && checksum.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn short_hash(checksum: &str) -> &str {
    &checksum[..16.min(checksum.len())]
}

/// 解析 DSBK 头（不解密）。返回 `None` 表示头可解；`Some(原因)` 表示不可解。
///
/// `head` 为对象前若干字节（调用方保证已带 DSBK 魔数），`object_len` 为
/// 对象总长，用于判断「头声称的最小体积」是否被截断。
fn dsbk_header_error(head: &[u8], object_len: u64) -> Option<String> {
    if head.len() < 5 {
        return Some("对象太短，读不到 DSBK 版本字节".to_string());
    }
    let version = head[4];
    let parse_params = |head: &[u8]| -> Option<(u32, u32, u32)> {
        if head.len() < 17 {
            return None;
        }
        let m = u32::from_le_bytes(head[5..9].try_into().ok()?);
        let t = u32::from_le_bytes(head[9..13].try_into().ok()?);
        let p = u32::from_le_bytes(head[13..17].try_into().ok()?);
        Some((m, t, p))
    };
    match version {
        1 => {
            if object_len < DSBK_V1_MIN_OBJECT_LEN {
                return Some(format!(
                    "DSBK v1 对象被截断：{object_len} 字节 < 最小 {DSBK_V1_MIN_OBJECT_LEN} 字节"
                ));
            }
            let Some((m, t, p)) = parse_params(head) else {
                return Some("DSBK v1 头被截断，读不到 Argon2 参数".to_string());
            };
            if m == 0 || t == 0 || p == 0 {
                return Some(format!("DSBK v1 头 Argon2 参数非法: m={m}, t={t}, p={p}"));
            }
            None
        }
        2 => {
            if object_len < DSBK_V2_MIN_OBJECT_LEN {
                return Some(format!(
                    "DSBK v2 对象被截断：{object_len} 字节 < 最小 {DSBK_V2_MIN_OBJECT_LEN} 字节"
                ));
            }
            if head.len() < DSBK_V2_HEADER_LEN {
                return Some("DSBK v2 头被截断，读不到分块参数".to_string());
            }
            let Some((m, t, p)) = parse_params(head) else {
                return Some("DSBK v2 头被截断，读不到 Argon2 参数".to_string());
            };
            if m == 0 || t == 0 || p == 0 {
                return Some(format!("DSBK v2 头 Argon2 参数非法: m={m}, t={t}, p={p}"));
            }
            // chunk 字段位于头尾 `[40..44)`（SSOT 偏移，勿用字面量）。
            let chunk = u32::from_le_bytes(
                head[DSBK_V2_CHUNK_OFFSET..DSBK_V2_HEADER_LEN]
                    .try_into()
                    .expect("已校验长度"),
            );
            if chunk == 0 || chunk > DSBK_MAX_PLAINTEXT_CHUNK {
                return Some(format!("DSBK v2 头分块大小非法: {chunk}"));
            }
            None
        }
        other => Some(format!("未知 DSBK 版本: {other}")),
    }
}

/// 读取本地文件前 [`HEAD_PROBE_LEN`] 字节（可短读）。
fn read_head_probe(path: &Path) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut buf = [0u8; HEAD_PROBE_LEN];
    let mut filled = 0;
    while filled < buf.len() {
        let read = file.read(&mut buf[filled..])?;
        if read == 0 {
            break;
        }
        filled += read;
    }
    Ok(buf[..filled].to_vec())
}

/// 分块计算文件 SHA256（1MiB 缓冲，避免整文件入内存）。
fn hash_file_sha256(path: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// 巡检下载单个备份对象。
///
/// WebDAV / 桌面 S3 走共享续传编排 [`super::resume::get_file_with_optional_resume`]：
/// 同一次巡检内瞬时断线从已写入前缀继续。FTP 与未声明续传的假存储仍整包
/// `get_file`。**不带**期望 SHA256：差异由巡检自己分类，避免后端直接抛错
/// 掩盖 [`RepoCheckProblemKind::ChecksumMismatch`]。
async fn download_object_for_check(
    storage: &dyn CloudStorage,
    key: &str,
    dest: &Path,
) -> Result<()> {
    super::resume::get_file_with_optional_resume(storage, key, dest, None, None).await?;
    Ok(())
}

/// 巡检过程的可变累加器。
struct CheckContext {
    problems: Vec<RepoCheckProblem>,
    listing_truncated: bool,
    read_failed: bool,
    orphan_objects: usize,
    objects_checked: usize,
    bytes_verified: u64,
}

impl CheckContext {
    fn new() -> Self {
        Self {
            problems: Vec::new(),
            listing_truncated: false,
            read_failed: false,
            orphan_objects: 0,
            objects_checked: 0,
            bytes_verified: 0,
        }
    }

    fn push(
        &mut self,
        kind: RepoCheckProblemKind,
        object_key: Option<String>,
        version_id: Option<String>,
        detail: String,
    ) {
        if kind == RepoCheckProblemKind::ObjectReadFailed {
            self.read_failed = true;
        }
        self.problems.push(RepoCheckProblem {
            kind,
            object_key,
            version_id,
            detail,
        });
    }
}

/// 读取并解析一个 manifest key；解析失败登记 CorruptManifest，
/// 读取失败登记 ObjectReadFailed，两种情况都不中断整体巡检。
async fn collect_manifest(
    storage: &dyn CloudStorage,
    key: &str,
    expected: &mut BTreeMap<String, ExpectedVersion>,
    ctx: &mut CheckContext,
) {
    let data = match storage.get(key).await {
        Ok(Some(data)) => data,
        Ok(None) => return,
        Err(error) => {
            ctx.push(
                RepoCheckProblemKind::ObjectReadFailed,
                Some(key.to_string()),
                None,
                format!("读取 manifest 失败: {error}"),
            );
            return;
        }
    };
    let manifest: CloudManifest = match serde_json::from_slice(&data) {
        Ok(manifest) => manifest,
        Err(error) => {
            ctx.push(
                RepoCheckProblemKind::CorruptManifest,
                Some(key.to_string()),
                None,
                format!("manifest 无法解析: {error}"),
            );
            return;
        }
    };
    for version in manifest.versions {
        if !version_id_is_valid(&version.id) {
            ctx.push(
                RepoCheckProblemKind::CorruptManifest,
                Some(key.to_string()),
                None,
                format!("manifest 含非法版本 ID: {:?}", version.id),
            );
            continue;
        }
        let entry = expected.entry(version.id.clone()).or_default();
        if checksum_is_valid(&version.checksum) {
            entry.checksums.insert(version.checksum);
        } else {
            ctx.push(
                RepoCheckProblemKind::CorruptManifest,
                Some(key.to_string()),
                Some(version.id.clone()),
                format!(
                    "版本 {} 登记的校验和非法: {:?}",
                    version.id, version.checksum
                ),
            );
        }
    }
}

/// 执行一次只读云端仓库巡检。
///
/// 顶层失败（连接不可用 / 列表请求本身失败 / 本地临时目录不可用）返回
/// `Err`；对象级异常一律进入报告的 `problems`，不中断其余对象的核查。
pub async fn run_repo_check(storage: &dyn CloudStorage) -> Result<RepoCheckReport> {
    storage.check_connection().await?;

    let mut ctx = CheckContext::new();

    // ---- 1. 加密标记：决定 DSBK 头核查的期望 --------------------------------
    // 标记存在但内容损坏时按「加密仓库」对待（fail-closed，与上传策略一致），
    // 同时如实登记标记损坏问题。
    let encryption_marker_present = match storage.get(ENCRYPTION_MARKER_KEY).await? {
        Some(data) => {
            if serde_json::from_slice::<super::sync_manager::EncryptionMarker>(&data).is_err() {
                ctx.push(
                    RepoCheckProblemKind::CorruptEncryptionMarker,
                    Some(ENCRYPTION_MARKER_KEY.to_string()),
                    None,
                    "加密标记对象存在但内容无法解析（fail-closed，按加密仓库巡检）".to_string(),
                );
            }
            true
        }
        None => false,
    };

    // ---- 2. 聚合所有 manifest 引用 -----------------------------------------
    let manifests_list = storage.list_outcome(MANIFESTS_PREFIX).await?;
    let manifests_truncated = manifests_list.truncated;
    if manifests_truncated {
        ctx.listing_truncated = true;
    }

    let mut expected: BTreeMap<String, ExpectedVersion> = BTreeMap::new();
    for file in &manifests_list.files {
        if file.key.ends_with(".json") {
            collect_manifest(storage, &file.key, &mut expected, &mut ctx).await;
        } else {
            // save_manifest 的临时 key（`<key>.<uuid>.tmp`）在崩溃后可能残留。
            ctx.push(
                RepoCheckProblemKind::TempLeftover,
                Some(file.key.clone()),
                None,
                format!("manifests/ 下的非 manifest 残留对象（{} 字节）", file.size),
            );
        }
    }
    for key in LEGACY_MANIFEST_KEYS {
        collect_manifest(storage, key, &mut expected, &mut ctx).await;
    }

    for (id, version) in &expected {
        if version.checksums.len() > 1 {
            ctx.push(
                RepoCheckProblemKind::ConflictingManifestEntry,
                Some(format!("{BACKUPS_PREFIX}{id}.zip")),
                Some(id.clone()),
                format!(
                    "版本 {} 在不同 manifest 中登记了 {} 个互相矛盾的校验和",
                    id,
                    version.checksums.len()
                ),
            );
        }
    }

    // ---- 3. 孤儿检测 --------------------------------------------------------
    let backups_list = storage.list_outcome(BACKUPS_PREFIX).await?;
    if backups_list.truncated {
        ctx.listing_truncated = true;
    }
    let referenced_keys: BTreeSet<String> = expected
        .keys()
        .map(|id| format!("{BACKUPS_PREFIX}{id}.zip"))
        .collect();
    if manifests_truncated {
        // manifests 列表不完整时，「未被引用」可能只是「引用它的 manifest
        // 没被列出来」——此时跳过孤儿判定，宁可少报也不误报。
        tracing::warn!("[RepoCheck] manifests 列表被截断，本轮跳过孤儿对象判定");
    } else {
        for file in &backups_list.files {
            if !referenced_keys.contains(&file.key) {
                ctx.orphan_objects += 1;
                ctx.push(
                    RepoCheckProblemKind::OrphanObject,
                    Some(file.key.clone()),
                    None,
                    format!("未被任何 manifest 引用（{} 字节），仅占用空间", file.size),
                );
            }
        }
    }

    // ---- 4. 逐个核对引用对象：存在性 / SHA256 / DSBK 头 ----------------------
    let temp_dir = tempfile::tempdir()
        .map_err(|e| AppError::file_system(format!("创建巡检临时目录失败: {e}")))?;

    for (id, version) in &expected {
        let key = format!("{BACKUPS_PREFIX}{id}.zip");

        match storage.stat(&key).await {
            Ok(Some(_)) => {}
            Ok(None) => {
                ctx.push(
                    RepoCheckProblemKind::MissingObject,
                    Some(key),
                    Some(id.clone()),
                    "manifest 引用的备份对象在云端不存在，该版本已无法恢复".to_string(),
                );
                continue;
            }
            Err(error) => {
                ctx.push(
                    RepoCheckProblemKind::ObjectReadFailed,
                    Some(key),
                    Some(id.clone()),
                    format!("查询对象元信息失败: {error}"),
                );
                continue;
            }
        };

        // 每个对象先清掉上一轮残留：续传路径会追加写入，复用同一
        // `.partial` 会把 A 的前缀接到 B 上。不带期望校验和，差异由
        // 巡检自己分类，而不是让后端 get_file 直接抛错。
        let local_path = temp_dir.path().join("repo-check-object.partial");
        let _ = std::fs::remove_file(&local_path);
        let download = download_object_for_check(storage, &key, &local_path).await;
        let object_len = match download {
            Ok(_) => match std::fs::metadata(&local_path) {
                Ok(meta) => meta.len(),
                Err(error) => {
                    ctx.push(
                        RepoCheckProblemKind::ObjectReadFailed,
                        Some(key),
                        Some(id.clone()),
                        format!("读取已下载对象元信息失败: {error}"),
                    );
                    continue;
                }
            },
            Err(error) => {
                ctx.push(
                    RepoCheckProblemKind::ObjectReadFailed,
                    Some(key),
                    Some(id.clone()),
                    format!("下载对象做校验失败: {error}"),
                );
                continue;
            }
        };

        // SHA256：与 manifest 登记值（可能有多个冲突值）比对，匹配任意一个即通过。
        let actual_checksum = match hash_file_sha256(&local_path) {
            Ok(hash) => hash,
            Err(error) => {
                ctx.push(
                    RepoCheckProblemKind::ObjectReadFailed,
                    Some(key),
                    Some(id.clone()),
                    format!("计算对象 SHA256 失败: {error}"),
                );
                continue;
            }
        };
        ctx.objects_checked += 1;
        ctx.bytes_verified += object_len;
        if !version.checksums.is_empty() && !version.checksums.contains(&actual_checksum) {
            let expected_short = version
                .checksums
                .iter()
                .map(|c| short_hash(c))
                .collect::<Vec<_>>()
                .join(" / ");
            ctx.push(
                RepoCheckProblemKind::ChecksumMismatch,
                Some(key.clone()),
                Some(id.clone()),
                format!(
                    "SHA256 不匹配：manifest 登记 {expected_short}…，实际 {}…；对象已损坏或被改动",
                    short_hash(&actual_checksum)
                ),
            );
        }

        // DSBK 头核查。
        let head = match read_head_probe(&local_path) {
            Ok(head) => head,
            Err(error) => {
                ctx.push(
                    RepoCheckProblemKind::ObjectReadFailed,
                    Some(key),
                    Some(id.clone()),
                    format!("读取对象头部失败: {error}"),
                );
                continue;
            }
        };
        let has_dsbk_magic = head.len() >= 4 && &head[..4] == DSBK_MAGIC;
        if encryption_marker_present {
            if !has_dsbk_magic {
                ctx.push(
                    RepoCheckProblemKind::PlaintextInEncryptedRepo,
                    Some(key.clone()),
                    Some(id.clone()),
                    "加密仓库中发现无 DSBK 头的对象（明文或已损坏），\
                     配置了加密密码的设备将无法解密恢复它"
                        .to_string(),
                );
            } else if let Some(reason) = dsbk_header_error(&head, object_len) {
                ctx.push(
                    RepoCheckProblemKind::UndecodableDsbkHeader,
                    Some(key.clone()),
                    Some(id.clone()),
                    format!("DSBK 加密头不可解：{reason}"),
                );
            }
        } else if has_dsbk_magic {
            ctx.push(
                RepoCheckProblemKind::EncryptedWithoutMarker,
                Some(key.clone()),
                Some(id.clone()),
                "对象是 DSBK 密文但云端没有加密标记（标记疑似被删），\
                 明文上传拦截已失效"
                    .to_string(),
            );
            if let Some(reason) = dsbk_header_error(&head, object_len) {
                ctx.push(
                    RepoCheckProblemKind::UndecodableDsbkHeader,
                    Some(key.clone()),
                    Some(id.clone()),
                    format!("DSBK 加密头不可解：{reason}"),
                );
            }
        }

        let _ = std::fs::remove_file(&local_path);
    }

    // ---- 5. 结论：任何不完整都拒绝「全绿」 -----------------------------------
    let has_real_problems = ctx
        .problems
        .iter()
        .any(|p| p.kind != RepoCheckProblemKind::ObjectReadFailed);
    let incomplete = ctx.listing_truncated || ctx.read_failed;
    let status = if has_real_problems {
        RepoCheckStatus::ProblemsFound
    } else if incomplete {
        RepoCheckStatus::Incomplete
    } else {
        RepoCheckStatus::Ok
    };

    let problems_truncated = ctx.problems.len() > MAX_REPORTED_PROBLEMS;
    let mut problems = ctx.problems;
    problems.truncate(MAX_REPORTED_PROBLEMS);

    Ok(RepoCheckReport {
        status,
        listing_truncated: ctx.listing_truncated,
        encryption_marker_present,
        versions_referenced: expected.len(),
        objects_checked: ctx.objects_checked,
        bytes_verified: ctx.bytes_verified,
        orphan_objects: ctx.orphan_objects,
        problems,
        problems_truncated,
        checked_at: Utc::now(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_id_whitelist_matches_sync_manager_rules() {
        assert!(version_id_is_valid("20260824-063000-123-abc123-deadbeef"));
        assert!(!version_id_is_valid(""));
        assert!(!version_id_is_valid("../evil"));
        assert!(!version_id_is_valid("a b"));
    }

    #[test]
    fn dsbk_v2_header_roundtrip_is_decodable() {
        // [R12-repocheck-fix] fixture 以真实 `encrypt_backup_file` 产物为准，
        // 不再手写偏移（FINDINGS-R11 P1-1：手写假头曾掩盖 48/44 偏移错误）。
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("plain.bin");
        let enc = dir.path().join("cipher.dsbk");
        std::fs::write(&input, vec![0x5Au8; 4096]).unwrap();
        crate::crypto::backup_crypto::encrypt_backup_file(&input, &enc, "repo-check-pw").unwrap();
        let object = std::fs::read(&enc).unwrap();
        let head = &object[..HEAD_PROBE_LEN.min(object.len())];
        assert_eq!(dsbk_header_error(head, object.len() as u64), None);

        // 按 SSOT 布局手工构造的 44 字节头同样必须可解（钉死解析端偏移）。
        let mut head = Vec::new();
        head.extend_from_slice(b"DSBK");
        head.push(2);
        head.extend_from_slice(&65536u32.to_le_bytes());
        head.extend_from_slice(&3u32.to_le_bytes());
        head.extend_from_slice(&4u32.to_le_bytes());
        head.extend_from_slice(&[0u8; 16]); // salt
        head.extend_from_slice(&[0u8; 7]); // nonce prefix
        head.extend_from_slice(&(1024u32 * 1024).to_le_bytes());
        assert_eq!(head.len(), DSBK_V2_HEADER_LEN, "真实 v2 头长为 44 字节");
        assert_eq!(dsbk_header_error(&head, DSBK_V2_MIN_OBJECT_LEN + 100), None);
    }

    #[test]
    fn dsbk_v2_min_object_len_boundary_is_exact() {
        // FINDINGS-R11 §3.2 ③：v2 最小体积是 44 + 16 = 60。旧实现按 64 判定，
        // 60–63 字节的合法对象会被误报「截断」。
        let mut head = Vec::new();
        head.extend_from_slice(b"DSBK");
        head.push(2);
        head.extend_from_slice(&65536u32.to_le_bytes());
        head.extend_from_slice(&3u32.to_le_bytes());
        head.extend_from_slice(&4u32.to_le_bytes());
        head.extend_from_slice(&[0u8; 16]);
        head.extend_from_slice(&[0u8; 7]);
        head.extend_from_slice(&(1024u32 * 1024).to_le_bytes());
        assert_eq!(DSBK_V2_MIN_OBJECT_LEN, 60);
        for len in 60..=63u64 {
            assert_eq!(
                dsbk_header_error(&head, len),
                None,
                "{len} 字节不应误报截断"
            );
        }
        assert!(dsbk_header_error(&head, 59).is_some(), "59 字节必然被截断");
    }

    #[test]
    fn dsbk_header_rejects_unknown_version_and_bad_params() {
        let mut head = Vec::new();
        head.extend_from_slice(b"DSBK");
        head.push(9);
        assert!(dsbk_header_error(&head, 1000).is_some());

        let mut v2_bad_chunk = Vec::new();
        v2_bad_chunk.extend_from_slice(b"DSBK");
        v2_bad_chunk.push(2);
        v2_bad_chunk.extend_from_slice(&65536u32.to_le_bytes());
        v2_bad_chunk.extend_from_slice(&3u32.to_le_bytes());
        v2_bad_chunk.extend_from_slice(&4u32.to_le_bytes());
        v2_bad_chunk.extend_from_slice(&[0u8; 16]);
        v2_bad_chunk.extend_from_slice(&[0u8; 7]);
        v2_bad_chunk.extend_from_slice(&0u32.to_le_bytes()); // chunk = 0 非法
        assert!(dsbk_header_error(&v2_bad_chunk, 1000).is_some());
    }

    #[test]
    fn dsbk_header_rejects_truncated_object() {
        let mut head = Vec::new();
        head.extend_from_slice(b"DSBK");
        head.push(1);
        head.extend_from_slice(&65536u32.to_le_bytes());
        head.extend_from_slice(&3u32.to_le_bytes());
        head.extend_from_slice(&4u32.to_le_bytes());
        // 对象总长小于 v1 头 + GCM tag：必然被截断
        assert!(dsbk_header_error(&head, 10).is_some());
    }
}
