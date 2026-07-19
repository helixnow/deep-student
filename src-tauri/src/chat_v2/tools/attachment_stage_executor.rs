//! 内置附件物化工具执行器
//!
//! 解决「二进制附件进不了 shell/脚本处理链路」的断裂点：
//! `attachment_read` 只能返回解析后的文本/base64，拿不到磁盘路径，
//! xlsx/zip/图片等二进制附件无法交给 local_shell_execute / workspace 文件工具处理。
//!
//! 执行一个内置工具：
//! - `builtin-attachment_stage` / `attachment_stage` - 把附件原始字节物化到
//!   当前会话 temp runtime root 的 `attachments/` 子目录，返回 `root_id + relative_path`。
//!
//! ## 设计说明
//! - 附件定位与 `attachment_executor.rs` 的 `attachment_read` 保持一致：
//!   `message_id + attachment_id`，先查消息 legacy attachments（preview_url data URL），
//!   再回退 context_snapshot.user_refs → VFS files/resources/blobs。
//! - 原始字节获取复用 `VfsAttachmentRepo::get_content_with_conn`（inline resources.data /
//!   external blob / original_path 三级兜底），保证拿到的是未解析的二进制。
//! - 去重：`attachments/.staged_index.json` 旁置索引（sha256 → 文件名），
//!   同内容重复物化直接返回既有路径；同名不同内容自动加 `_N` 序号后缀。
//! - 路径安全与 `workspace_fs_executor.rs` 同级：文件名非法字符清洗、
//!   `normalize_runtime_relative_path` 拒绝绝对路径/`..`、写前 canonicalize 父目录并
//!   校验 starts_with temp root、拒绝写 symlink 目标。

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::time::Instant;

use async_trait::async_trait;
use base64::Engine;
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Manager;

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::repo::ChatV2Repo;
use crate::chat_v2::runtime_roots::{normalize_runtime_relative_path, temp_root};
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::vfs::repos::attachment_repo::VfsAttachmentContentSource;
use crate::vfs::repos::VfsAttachmentRepo;

// ============================================================================
// 常量
// ============================================================================

/// temp root 内的物化子目录
const STAGE_SUBDIR: &str = "attachments";

/// 旁置去重索引文件名（sha256 → 已物化文件名）
const STAGE_INDEX_FILE: &str = ".staged_index.json";

/// 单个附件物化大小上限（防呆）
const MAX_STAGE_BYTES: u64 = 256 * 1024 * 1024;

/// 去重索引只是加速缓存，必须限制其读取大小与条目数
const MAX_STAGE_INDEX_BYTES: u64 = 256 * 1024;
const MAX_STAGE_INDEX_ENTRIES: usize = 2_048;

const FILE_IO_BUFFER_BYTES: usize = 64 * 1024;

/// 同名冲突时最多尝试的序号后缀数
const MAX_SUFFIX_ATTEMPTS: u32 = 100;

/// 清洗后文件名的最大字符数（超长截断 stem、保留扩展名）
const MAX_FILE_NAME_CHARS: usize = 120;

// ============================================================================
// 物化结果
// ============================================================================

#[derive(Debug)]
struct StagedFile {
    /// 相对 temp root 的路径，统一正斜杠（形如 `attachments/<name>`）
    relative_path: String,
    size_bytes: u64,
    sha256: String,
    /// true 表示命中去重，直接复用既有文件
    reused: bool,
}

/// 附件原始数据来源：优先磁盘路径（blob/original），否则内存字节
enum AttachmentPayload {
    Disk { path: std::path::PathBuf },
    Bytes { data: Vec<u8> },
}

struct ResolvedAttachment {
    name: String,
    mime_type: Option<String>,
    payload: AttachmentPayload,
}

// ============================================================================
// 纯函数：文件名清洗 / 大小校验 / 物化写入
// ============================================================================

fn split_stem_ext(name: &str) -> (String, Option<String>) {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => {
            (stem.to_string(), Some(ext.to_string()))
        }
        _ => (name.to_string(), None),
    }
}

/// 清洗目标文件名：替换 Windows/Unix 非法字符与路径分隔符为 `_`，
/// 去掉首尾空白和点（防 `..` 与隐藏尾点），保留 Unicode 文件名（如中文）。
fn sanitize_file_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        return "attachment".to_string();
    }

    let mut name = trimmed.to_string();
    if name.chars().count() > MAX_FILE_NAME_CHARS {
        let (stem, ext) = split_stem_ext(&name);
        let ext_len = ext.as_ref().map(|e| e.chars().count() + 1).unwrap_or(0);
        let keep = MAX_FILE_NAME_CHARS.saturating_sub(ext_len).max(1);
        let stem_short: String = stem.chars().take(keep).collect();
        name = match ext {
            Some(e) => format!("{}.{}", stem_short, e),
            None => stem_short,
        };
    }
    name
}

fn check_stage_size(len: u64) -> Result<(), String> {
    if len > MAX_STAGE_BYTES {
        return Err(format!(
            "Attachment too large to stage: {} bytes exceeds the {} MB limit",
            len,
            MAX_STAGE_BYTES / (1024 * 1024)
        ));
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn is_plain_stage_file_name(name: &str) -> bool {
    !name.is_empty()
        && Path::new(name).components().count() == 1
        && sanitize_file_name(name) == name
        && name != STAGE_INDEX_FILE
}

fn load_stage_index(stage_dir: &Path) -> HashMap<String, String> {
    let path = stage_dir.join(STAGE_INDEX_FILE);
    let Ok(meta) = fs::symlink_metadata(&path) else {
        return HashMap::new();
    };
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > MAX_STAGE_INDEX_BYTES {
        return HashMap::new();
    }

    let Ok(mut file) = fs::File::open(&path) else {
        return HashMap::new();
    };
    let mut raw = String::new();
    if (&mut file)
        .take(MAX_STAGE_INDEX_BYTES.saturating_add(1))
        .read_to_string(&mut raw)
        .is_err()
        || raw.len() as u64 > MAX_STAGE_INDEX_BYTES
    {
        return HashMap::new();
    }

    let mut index: HashMap<String, String> = serde_json::from_str(&raw).unwrap_or_default();
    if index.len() > MAX_STAGE_INDEX_ENTRIES {
        return HashMap::new();
    }
    index.retain(|hash, name| hash.len() == 64 && is_plain_stage_file_name(name));
    index
}

/// 索引仅用于去重加速，写失败不影响本次物化结果
fn save_stage_index(stage_dir: &Path, index: &HashMap<String, String>) {
    if index.len() > MAX_STAGE_INDEX_ENTRIES {
        return;
    }
    let Ok(raw) = serde_json::to_string(index) else {
        return;
    };
    if raw.len() as u64 > MAX_STAGE_INDEX_BYTES {
        return;
    }

    let path = stage_dir.join(STAGE_INDEX_FILE);
    if fs::symlink_metadata(&path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
    {
        return;
    }
    let _ = fs::write(path, raw);
}

fn sha256_file_bounded(path: &Path, max_bytes: u64) -> Result<(String, u64), String> {
    let mut file = fs::File::open(path).map_err(|e| format!("Failed to open file: {}", e))?;
    let declared_size = file
        .metadata()
        .map_err(|e| format!("Failed to stat file: {}", e))?
        .len();
    check_stage_size(declared_size)?;

    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; FILE_IO_BUFFER_BYTES];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| format!("Failed to read file: {}", e))?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .ok_or("File size overflow while hashing")?;
        if total > max_bytes {
            return Err(format!(
                "Attachment grew beyond the {} MB limit while hashing",
                max_bytes / (1024 * 1024)
            ));
        }
        hasher.update(&buffer[..read]);
    }
    Ok((hex::encode(hasher.finalize()), total))
}

fn copy_file_bounded(
    source: &Path,
    target: &Path,
    expected_size: u64,
    expected_sha256: &str,
) -> Result<(), String> {
    let mut input = fs::File::open(source)
        .map_err(|e| format!("Failed to open staged attachment source: {}", e))?;
    check_stage_size(
        input
            .metadata()
            .map_err(|e| format!("Failed to stat staged attachment source: {}", e))?
            .len(),
    )?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|e| format!("Failed to create staged attachment: {}", e))?;

    let result = (|| {
        let mut hasher = Sha256::new();
        let mut total = 0u64;
        let mut buffer = [0u8; FILE_IO_BUFFER_BYTES];
        loop {
            let read = input
                .read(&mut buffer)
                .map_err(|e| format!("Failed to read staged attachment: {}", e))?;
            if read == 0 {
                break;
            }
            total = total
                .checked_add(read as u64)
                .ok_or("Attachment size overflow while copying")?;
            check_stage_size(total)?;
            output
                .write_all(&buffer[..read])
                .map_err(|e| format!("Failed to write staged attachment: {}", e))?;
            hasher.update(&buffer[..read]);
        }
        output
            .flush()
            .map_err(|e| format!("Failed to flush staged attachment: {}", e))?;
        let actual_sha256 = hex::encode(hasher.finalize());
        if total != expected_size || actual_sha256 != expected_sha256 {
            return Err("Attachment source changed while it was being staged".to_string());
        }
        Ok(())
    })();

    if result.is_err() {
        drop(output);
        let _ = fs::remove_file(target);
    }
    result
}

fn write_bytes_create_new(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|e| format!("Failed to create staged attachment: {}", e))?;
    output
        .write_all(bytes)
        .and_then(|_| output.flush())
        .map_err(|e| format!("Failed to write staged attachment: {}", e))
}

fn stage_relative_path(file_name: &str) -> String {
    format!("{}/{}", STAGE_SUBDIR, file_name)
}

fn stage_payload_into_temp_root(
    temp_root_path: &Path,
    requested_name: &str,
    payload: &AttachmentPayload,
) -> Result<StagedFile, String> {
    match payload {
        AttachmentPayload::Disk { path } => {
            stage_disk_into_temp_root(temp_root_path, requested_name, path)
        }
        AttachmentPayload::Bytes { data } => {
            stage_bytes_into_temp_root(temp_root_path, requested_name, data)
        }
    }
}

/// 从磁盘源文件复制到 temp root（优先于 base64 往返）
fn stage_disk_into_temp_root(
    temp_root_path: &Path,
    requested_name: &str,
    source: &Path,
) -> Result<StagedFile, String> {
    let (sha256, size) = sha256_file_bounded(source, MAX_STAGE_BYTES)?;

    let file_name = sanitize_file_name(requested_name);
    let relative = normalize_runtime_relative_path(Some(&stage_relative_path(&file_name)))?;
    if relative.components().count() != 2 {
        return Err("Sanitized file name must resolve to a plain file name".to_string());
    }

    let stage_dir = temp_root_path.join(STAGE_SUBDIR);
    fs::create_dir_all(&stage_dir).map_err(|e| format!("Failed to create stage dir: {}", e))?;
    let root_canon = temp_root_path
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize temp root: {}", e))?;
    let stage_dir_canon = stage_dir
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize stage dir: {}", e))?;
    if !stage_dir_canon.starts_with(&root_canon) {
        return Err("Stage directory escapes the temp root".to_string());
    }

    let mut index = load_stage_index(&stage_dir_canon);
    if let Some(existing_name) = index.get(&sha256).cloned() {
        let existing = stage_dir_canon.join(&existing_name);
        if let Ok(meta) = fs::symlink_metadata(&existing) {
            let hash_matches = meta.is_file()
                && !meta.file_type().is_symlink()
                && meta.len() == size
                && sha256_file_bounded(&existing, MAX_STAGE_BYTES)
                    .map(|(hash, actual_size)| hash == sha256 && actual_size == size)
                    .unwrap_or(false);
            if hash_matches {
                return Ok(StagedFile {
                    relative_path: stage_relative_path(&existing_name),
                    size_bytes: meta.len(),
                    sha256,
                    reused: true,
                });
            }
        }
        index.remove(&sha256);
    }

    let (stem, ext) = split_stem_ext(&file_name);
    let mut chosen: Option<String> = None;
    for attempt in 0..=MAX_SUFFIX_ATTEMPTS {
        let candidate = if attempt == 0 {
            file_name.clone()
        } else {
            match &ext {
                Some(e) => format!("{}_{}.{}", stem, attempt, e),
                None => format!("{}_{}", stem, attempt),
            }
        };
        let target = stage_dir_canon.join(&candidate);
        match fs::symlink_metadata(&target) {
            Err(_) => {
                chosen = Some(candidate);
                break;
            }
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    continue;
                }
                if meta.is_file() && meta.len() == size {
                    let same = sha256_file_bounded(&target, MAX_STAGE_BYTES)
                        .map(|(hash, actual_size)| hash == sha256 && actual_size == size)
                        .unwrap_or(false);
                    if same {
                        index.insert(sha256.clone(), candidate.clone());
                        save_stage_index(&stage_dir_canon, &index);
                        return Ok(StagedFile {
                            relative_path: stage_relative_path(&candidate),
                            size_bytes: meta.len(),
                            sha256,
                            reused: true,
                        });
                    }
                }
            }
        }
    }
    let chosen = chosen.ok_or_else(|| {
        format!(
            "Too many name conflicts in the staging directory for '{}'",
            file_name
        )
    })?;

    let target = stage_dir_canon.join(&chosen);
    let parent_canon = target
        .parent()
        .ok_or("Stage target has no parent directory")?
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize stage parent dir: {}", e))?;
    if !parent_canon.starts_with(&root_canon) {
        return Err("Stage target escapes the temp root".to_string());
    }

    copy_file_bounded(source, &target, size, &sha256)?;

    index.insert(sha256.clone(), chosen.clone());
    save_stage_index(&stage_dir_canon, &index);

    Ok(StagedFile {
        relative_path: stage_relative_path(&chosen),
        size_bytes: size,
        sha256,
        reused: false,
    })
}

/// 把附件原始字节写入 temp root 的 `attachments/` 子目录。
///
/// 安全校验（与 workspace_fs_executor 同级）：
/// - 文件名先经 `sanitize_file_name` 清洗，再经 `normalize_runtime_relative_path`
///   拒绝绝对路径与 `..`，并要求恰好是 `attachments/<单段文件名>`；
/// - 写前 canonicalize 目录并校验 starts_with temp root；
/// - 目标或候选名是 symlink 时拒绝写入（换序号后缀绕开）。
fn stage_bytes_into_temp_root(
    temp_root_path: &Path,
    requested_name: &str,
    bytes: &[u8],
) -> Result<StagedFile, String> {
    let size = u64::try_from(bytes.len()).map_err(|_| "Attachment size overflow".to_string())?;
    check_stage_size(size)?;

    let file_name = sanitize_file_name(requested_name);
    let relative = normalize_runtime_relative_path(Some(&stage_relative_path(&file_name)))?;
    if relative.components().count() != 2 {
        return Err("Sanitized file name must resolve to a plain file name".to_string());
    }

    let stage_dir = temp_root_path.join(STAGE_SUBDIR);
    fs::create_dir_all(&stage_dir).map_err(|e| format!("Failed to create stage dir: {}", e))?;
    let root_canon = temp_root_path
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize temp root: {}", e))?;
    let stage_dir_canon = stage_dir
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize stage dir: {}", e))?;
    if !stage_dir_canon.starts_with(&root_canon) {
        return Err("Stage directory escapes the temp root".to_string());
    }

    let sha256 = sha256_hex(bytes);

    // 去重：旁置索引命中且文件仍在、尺寸一致 → 直接复用既有路径
    let mut index = load_stage_index(&stage_dir_canon);
    if let Some(existing_name) = index.get(&sha256).cloned() {
        let existing = stage_dir_canon.join(&existing_name);
        if let Ok(meta) = fs::symlink_metadata(&existing) {
            let hash_matches = meta.is_file()
                && !meta.file_type().is_symlink()
                && meta.len() == size
                && sha256_file_bounded(&existing, MAX_STAGE_BYTES)
                    .map(|(hash, actual_size)| hash == sha256 && actual_size == size)
                    .unwrap_or(false);
            if hash_matches {
                return Ok(StagedFile {
                    relative_path: stage_relative_path(&existing_name),
                    size_bytes: meta.len(),
                    sha256,
                    reused: true,
                });
            }
        }
        // 索引指向的文件已失效，移除后按正常流程重新物化
        index.remove(&sha256);
    }

    // 同名冲突：内容相同复用，不同则加序号后缀
    let (stem, ext) = split_stem_ext(&file_name);
    let mut chosen: Option<String> = None;
    for attempt in 0..=MAX_SUFFIX_ATTEMPTS {
        let candidate = if attempt == 0 {
            file_name.clone()
        } else {
            match &ext {
                Some(e) => format!("{}_{}.{}", stem, attempt, e),
                None => format!("{}_{}", stem, attempt),
            }
        };
        let target = stage_dir_canon.join(&candidate);
        match fs::symlink_metadata(&target) {
            Err(_) => {
                chosen = Some(candidate);
                break;
            }
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    // 拒绝写 symlink 目标，换下一个序号
                    continue;
                }
                if meta.is_file() && meta.len() == size {
                    let same = sha256_file_bounded(&target, MAX_STAGE_BYTES)
                        .map(|(hash, actual_size)| hash == sha256 && actual_size == size)
                        .unwrap_or(false);
                    if same {
                        index.insert(sha256.clone(), candidate.clone());
                        save_stage_index(&stage_dir_canon, &index);
                        return Ok(StagedFile {
                            relative_path: stage_relative_path(&candidate),
                            size_bytes: meta.len(),
                            sha256,
                            reused: true,
                        });
                    }
                }
            }
        }
    }
    let chosen = chosen.ok_or_else(|| {
        format!(
            "Too many name conflicts in the staging directory for '{}'",
            file_name
        )
    })?;

    let target = stage_dir_canon.join(&chosen);
    // 写前最后校验：父目录 canonicalize 后必须仍在 temp root 内
    let parent_canon = target
        .parent()
        .ok_or("Stage target has no parent directory")?
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize stage parent dir: {}", e))?;
    if !parent_canon.starts_with(&root_canon) {
        return Err("Stage target escapes the temp root".to_string());
    }

    write_bytes_create_new(&target, bytes)?;

    index.insert(sha256.clone(), chosen.clone());
    save_stage_index(&stage_dir_canon, &index);

    Ok(StagedFile {
        relative_path: stage_relative_path(&chosen),
        size_bytes: size,
        sha256,
        reused: false,
    })
}

// ============================================================================
// 附件原始字节定位
// ============================================================================

/// 解码 data URL 或裸 base64 为原始字节
fn decode_base64_payload(input: &str) -> Result<Vec<u8>, String> {
    decode_base64_payload_with_limit(input, MAX_STAGE_BYTES)
}

fn decode_base64_payload_with_limit(input: &str, max_bytes: u64) -> Result<Vec<u8>, String> {
    let payload = if input.starts_with("data:") {
        input
            .split_once(',')
            .map(|(_, right)| right)
            .ok_or("Invalid data URL format")?
    } else {
        input
    };
    let payload = payload.trim();
    let encoded_len = u64::try_from(payload.len())
        .map_err(|_| "Base64 payload length does not fit this platform".to_string())?;
    let groups = encoded_len
        .checked_add(3)
        .ok_or("Base64 payload length overflow")?
        / 4;
    let padding = payload
        .as_bytes()
        .iter()
        .rev()
        .take_while(|byte| **byte == b'=')
        .take(2)
        .count() as u64;
    let decoded_upper_bound = groups
        .checked_mul(3)
        .and_then(|value| value.checked_sub(padding))
        .ok_or("Base64 decoded length overflow")?;
    if decoded_upper_bound > max_bytes {
        return Err(format!(
            "Attachment too large to stage: decoded base64 may exceed {} bytes",
            max_bytes
        ));
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| format!("Failed to decode base64 content: {}", e))?;
    let decoded_len =
        u64::try_from(bytes.len()).map_err(|_| "Decoded size overflow".to_string())?;
    if decoded_len > max_bytes {
        return Err(format!(
            "Attachment too large to stage: {} decoded bytes exceeds {} bytes",
            decoded_len, max_bytes
        ));
    }
    Ok(bytes)
}

// ============================================================================
// 内置附件物化工具执行器
// ============================================================================

/// 内置附件物化工具执行器
///
/// 处理 `builtin-attachment_stage` / `attachment_stage`：
/// 把附件原始字节物化到当前会话 temp root 的 `attachments/` 子目录。
pub struct AttachmentStageExecutor;

impl AttachmentStageExecutor {
    /// 创建新的附件物化工具执行器
    pub fn new() -> Self {
        Self
    }

    /// 优先定位 VFS blob 磁盘文件；拿不到磁盘路径时回退字节流。
    fn resolve_vfs_attachment(
        vfs_db: &crate::vfs::database::VfsDatabase,
        file_id: &str,
    ) -> Result<Option<ResolvedAttachment>, String> {
        let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;

        let Some(record) =
            VfsAttachmentRepo::get_by_id_with_conn(&conn, file_id).map_err(|e| e.to_string())?
        else {
            return Ok(None);
        };
        let name = if record.name.trim().is_empty() {
            file_id.to_string()
        } else {
            record.name.clone()
        };
        let mime_type = if record.mime_type.trim().is_empty() {
            None
        } else {
            Some(record.mime_type.clone())
        };

        if let Some(source) =
            VfsAttachmentRepo::get_content_source_with_conn(&conn, vfs_db.blobs_dir(), file_id)
                .map_err(|e| e.to_string())?
        {
            let payload = match source {
                VfsAttachmentContentSource::File(path) => {
                    let size = fs::metadata(&path)
                        .map_err(|e| format!("Failed to stat attachment source: {}", e))?
                        .len();
                    check_stage_size(size)?;
                    AttachmentPayload::Disk { path }
                }
                VfsAttachmentContentSource::Base64(base64_content) => AttachmentPayload::Bytes {
                    data: decode_base64_payload(&base64_content)?,
                },
            };
            return Ok(Some(ResolvedAttachment {
                name,
                mime_type,
                payload,
            }));
        }

        let content: Option<String> = conn
            .query_row(
                r#"
                SELECT COALESCE(r.content, '')
                FROM files f
                LEFT JOIN resources r ON f.resource_id = r.id
                WHERE f.id = ?1 AND f.deleted_at IS NULL
                "#,
                rusqlite::params![file_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        match content {
            Some(raw) if !raw.is_empty() => {
                let bytes = if raw.starts_with("data:") {
                    decode_base64_payload(&raw)?
                } else {
                    check_stage_size(u64::try_from(raw.len()).map_err(|_| {
                        "Attachment content length does not fit this platform".to_string()
                    })?)?;
                    raw.into_bytes()
                };
                Ok(Some(ResolvedAttachment {
                    name,
                    mime_type,
                    payload: AttachmentPayload::Bytes { data: bytes },
                }))
            }
            _ => Err(format!(
                "Attachment {} has no raw content available in VFS",
                file_id
            )),
        }
    }

    /// 定位附件并取原始数据（与 attachment_read 相同的 message_id + attachment_id 定位方式）
    fn resolve_attachment(
        main_db: &crate::database::Database,
        vfs_db: Option<&crate::vfs::database::VfsDatabase>,
        session_id: &str,
        message_id: &str,
        attachment_id: &str,
    ) -> Result<ResolvedAttachment, String> {
        let message = ChatV2Repo::get_message(main_db, message_id)
            .map_err(|e| format!("Failed to get message: {}", e))?
            .ok_or_else(|| format!("Message not found: {}", message_id))?;

        // 与 attachment_read 相同的会话隔离校验
        if message.session_id != session_id {
            return Err("Unauthorized: Cannot access attachments from other sessions".to_string());
        }

        if let Some(attachment) = message
            .attachments
            .as_ref()
            .and_then(|atts| atts.iter().find(|a| a.id == attachment_id))
        {
            let mime_type = if attachment.mime_type.trim().is_empty() {
                None
            } else {
                Some(attachment.mime_type.clone())
            };

            // 1) legacy 附件：preview_url data URL 里就是原始字节的 base64
            if let Some(preview_url) = &attachment.preview_url {
                if preview_url.starts_with("data:") {
                    let bytes = decode_base64_payload(preview_url)?;
                    return Ok(ResolvedAttachment {
                        name: attachment.name.clone(),
                        mime_type,
                        payload: AttachmentPayload::Bytes { data: bytes },
                    });
                }
            }
            // 2) 回退：附件 id 可能同时是 VFS files.id
            let vfs_db = vfs_db.ok_or("VFS database not available for attachment staging")?;
            if let Some(resolved) = Self::resolve_vfs_attachment(vfs_db, &attachment.id)? {
                let name = if attachment.name.trim().is_empty() {
                    resolved.name
                } else {
                    attachment.name.clone()
                };
                return Ok(ResolvedAttachment {
                    name,
                    mime_type: mime_type.or(resolved.mime_type),
                    payload: resolved.payload,
                });
            }
            return Err(format!(
                "Attachment {} has no raw content available (no data URL and not found in VFS)",
                attachment_id
            ));
        }

        // 统一引用模式兼容：context_snapshot.user_refs 中的 file_/tb_/att_
        let context_ref = message
            .meta
            .as_ref()
            .and_then(|meta| meta.context_snapshot.as_ref())
            .and_then(|snapshot| {
                snapshot
                    .user_refs
                    .iter()
                    .find(|r| r.resource_id == attachment_id)
            })
            .ok_or_else(|| {
                format!(
                    "Attachment not found: {} in message {}",
                    attachment_id, message_id
                )
            })?;

        if context_ref.resource_id.starts_with("fld_") {
            return Err("Folder context reference cannot be staged".to_string());
        }

        let vfs_db = vfs_db.ok_or("VFS database not available for attachment staging")?;
        if let Some(resolved) = Self::resolve_vfs_attachment(vfs_db, &context_ref.resource_id)? {
            let name = if resolved.name == context_ref.resource_id {
                context_ref
                    .display_name
                    .clone()
                    .unwrap_or_else(|| resolved.name.clone())
            } else {
                resolved.name
            };
            return Ok(ResolvedAttachment {
                name,
                mime_type: resolved.mime_type,
                payload: resolved.payload,
            });
        }
        Err(format!(
            "Resource not found in VFS: {}",
            context_ref.resource_id
        ))
    }

    /// 执行附件物化
    async fn execute_stage(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let message_id = call
            .arguments
            .get("message_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'message_id' parameter")?
            .to_string();
        let attachment_id = call
            .arguments
            .get("attachment_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'attachment_id' parameter")?
            .to_string();
        let filename_override = call
            .arguments
            .get("filename")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        log::debug!(
            "[AttachmentStageExecutor] attachment_stage: message_id={}, attachment_id={}, filename={:?}",
            message_id,
            attachment_id,
            filename_override
        );

        let start_time = Instant::now();
        let main_db = ctx.main_db.clone().ok_or("Main database not available")?;
        let vfs_db = ctx.vfs_db.clone();
        let app_handle = ctx.window_ref().app_handle().clone();
        let session_id = ctx.session_id.clone();
        let blocking_message_id = message_id.clone();
        let blocking_attachment_id = attachment_id.clone();

        let (staged, temp_id, original_name, mime_type) = tokio::task::spawn_blocking(move || {
            let resolved = Self::resolve_attachment(
                main_db.as_ref(),
                vfs_db.as_deref(),
                &session_id,
                &blocking_message_id,
                &blocking_attachment_id,
            )?;
            let ResolvedAttachment {
                name,
                mime_type,
                payload,
            } = resolved;
            let requested_name = filename_override.as_deref().unwrap_or(&name);
            let temp = temp_root(&app_handle, &session_id, true)?;
            let staged = stage_payload_into_temp_root(&temp.path, requested_name, &payload)?;
            Ok::<_, String>((staged, temp.id, name, mime_type))
        })
        .await
        .map_err(|e| format!("Attachment staging task failed: {}", e))??;

        let duration = start_time.elapsed().as_millis() as u64;
        let staged_status = if staged.reused {
            "already_staged"
        } else {
            "staged"
        };
        log::debug!(
            "[AttachmentStageExecutor] attachment_stage completed: path={}, size={}, status={}, {}ms",
            staged.relative_path,
            staged.size_bytes,
            staged_status,
            duration
        );

        let mut output = json!({
            "success": true,
            "root_id": temp_id,
            "relative_path": staged.relative_path,
            "size": staged.size_bytes,
            "sha256": staged.sha256,
            "original_name": original_name,
            "staged": staged_status,
            "attachment_id": attachment_id,
            "message_id": message_id,
            "hint": "物化完成：可用 workspace_file_read（root_id=temp, path=relative_path）或 local_shell_execute（root_id=temp, cwd 指向 attachments 目录）处理该文件；产物请写入 artifacts。",
            "durationMs": duration,
        });
        if let Some(mime_type) = mime_type {
            output["mime_type"] = json!(mime_type);
        }

        Ok(output)
    }
}

impl Default for AttachmentStageExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for AttachmentStageExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        strip_tool_namespace(tool_name) == "attachment_stage"
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start_time = Instant::now();

        log::debug!(
            "[AttachmentStageExecutor] Executing builtin tool: {}",
            call.name
        );

        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let result = self.execute_stage(call, ctx).await;
        let duration = start_time.elapsed().as_millis() as u64;

        match result {
            Ok(output) => {
                ctx.emit_tool_call_end(Some(json!({
                    "result": output,
                    "durationMs": duration,
                })));

                let result = ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration,
                );

                // SSOT: 后端立即保存工具块（防闪退）
                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[AttachmentStageExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
            Err(e) => {
                ctx.emit_tool_call_error(&e);

                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    e,
                    duration,
                );

                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[AttachmentStageExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
        }
    }

    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        // 写 temp root（会话隔离目录），低风险但非零
        ToolSensitivity::Medium
    }

    fn name(&self) -> &'static str {
        "AttachmentStageExecutor"
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_can_handle() {
        let executor = AttachmentStageExecutor::new();
        assert!(executor.can_handle("builtin-attachment_stage"));
        assert!(executor.can_handle("attachment_stage"));
        assert!(!executor.can_handle("builtin-attachment_read"));
        assert!(!executor.can_handle("builtin-attachment_list"));
    }

    #[test]
    fn test_sensitivity_level() {
        let executor = AttachmentStageExecutor::new();
        assert_eq!(
            executor.sensitivity_level("builtin-attachment_stage"),
            ToolSensitivity::Medium
        );
    }

    #[test]
    fn sanitizes_illegal_characters_and_separators() {
        assert_eq!(sanitize_file_name("report.xlsx"), "report.xlsx");
        assert_eq!(sanitize_file_name("a<b>:c\"d.txt"), "a_b__c_d.txt");
        assert_eq!(sanitize_file_name("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(sanitize_file_name("dir\\evil.zip"), "dir_evil.zip");
        // Unicode 文件名保留
        assert_eq!(sanitize_file_name("期末 复习.pdf"), "期末 复习.pdf");
    }

    #[test]
    fn sanitizes_empty_and_dot_only_names_to_fallback() {
        assert_eq!(sanitize_file_name(""), "attachment");
        assert_eq!(sanitize_file_name("   "), "attachment");
        assert_eq!(sanitize_file_name("..."), "attachment");
        assert_eq!(sanitize_file_name(".."), "attachment");
    }

    #[test]
    fn truncates_overlong_names_preserving_extension() {
        let long_stem: String = "很".repeat(300);
        let name = sanitize_file_name(&format!("{}.xlsx", long_stem));
        assert!(name.chars().count() <= MAX_FILE_NAME_CHARS);
        assert!(name.ends_with(".xlsx"));
    }

    #[test]
    fn rejects_oversized_payloads() {
        assert!(check_stage_size(MAX_STAGE_BYTES).is_ok());
        let err = check_stage_size(MAX_STAGE_BYTES + 1).unwrap_err();
        assert!(err.contains("256 MB"));
        assert!(check_stage_size(u64::MAX).is_err());
    }

    #[test]
    fn stages_bytes_under_attachments_subdir_with_forward_slashes() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let staged =
            stage_bytes_into_temp_root(temp_dir.path(), "data.xlsx", b"binary-bytes").unwrap();
        assert_eq!(staged.relative_path, "attachments/data.xlsx");
        assert_eq!(staged.size_bytes, 12);
        assert_eq!(staged.sha256, sha256_hex(b"binary-bytes"));
        assert!(!staged.reused);
        assert_eq!(
            fs::read(temp_dir.path().join("attachments").join("data.xlsx")).unwrap(),
            b"binary-bytes"
        );
    }

    #[test]
    fn dedupes_same_content_even_with_different_requested_name() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let first = stage_bytes_into_temp_root(temp_dir.path(), "a.zip", b"same content").unwrap();
        let second = stage_bytes_into_temp_root(temp_dir.path(), "b.zip", b"same content").unwrap();
        assert!(!first.reused);
        assert!(second.reused);
        assert_eq!(first.relative_path, second.relative_path);
        assert_eq!(first.sha256, second.sha256);
    }

    #[test]
    fn same_name_different_content_gets_numeric_suffix() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let first = stage_bytes_into_temp_root(temp_dir.path(), "notes.txt", b"v1").unwrap();
        let second = stage_bytes_into_temp_root(temp_dir.path(), "notes.txt", b"v2").unwrap();
        assert_eq!(first.relative_path, "attachments/notes.txt");
        assert_eq!(second.relative_path, "attachments/notes_1.txt");
        assert_eq!(
            fs::read(temp_dir.path().join("attachments").join("notes.txt")).unwrap(),
            b"v1"
        );
        assert_eq!(
            fs::read(temp_dir.path().join("attachments").join("notes_1.txt")).unwrap(),
            b"v2"
        );
    }

    #[test]
    fn same_name_same_content_reuses_existing_file_without_index() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let first = stage_bytes_into_temp_root(temp_dir.path(), "report.pdf", b"pdf!").unwrap();
        // 删掉旁置索引，验证按文件名+内容比对的兜底去重
        fs::remove_file(temp_dir.path().join("attachments").join(STAGE_INDEX_FILE)).unwrap();
        let second = stage_bytes_into_temp_root(temp_dir.path(), "report.pdf", b"pdf!").unwrap();
        assert!(second.reused);
        assert_eq!(first.relative_path, second.relative_path);
    }

    #[test]
    fn escape_attempts_stay_inside_temp_root() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let staged = stage_bytes_into_temp_root(temp_dir.path(), "../../escape.bin", b"x").unwrap();
        // 路径分隔符被清洗成 `_`，最终仍落在 attachments/ 内
        assert!(staged.relative_path.starts_with("attachments/"));
        let root_canon = temp_dir.path().canonicalize().unwrap();
        let target = root_canon.join(
            staged
                .relative_path
                .replace('/', std::path::MAIN_SEPARATOR_STR),
        );
        let target_canon = target.canonicalize().unwrap();
        assert!(target_canon.starts_with(&root_canon));
        assert!(!temp_dir
            .path()
            .parent()
            .unwrap()
            .join("escape.bin")
            .exists());
    }

    #[test]
    fn decodes_data_urls_and_plain_base64() {
        assert_eq!(
            decode_base64_payload("data:text/plain;base64,SGVsbG8=").unwrap(),
            b"Hello"
        );
        assert_eq!(decode_base64_payload("SGVsbG8=").unwrap(), b"Hello");
        assert!(decode_base64_payload("data:no-comma").is_err());
        assert!(decode_base64_payload("!!!not-base64!!!").is_err());
        let err = decode_base64_payload_with_limit("SGVsbG8=", 4).unwrap_err();
        assert!(err.contains("too large"));
    }

    #[test]
    fn stages_disk_file_via_copy() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let source_dir = tempfile::tempdir().expect("source");
        let source = source_dir.path().join("report.xlsx");
        fs::write(&source, b"xlsx-binary").expect("write source");

        let staged = stage_disk_into_temp_root(temp_dir.path(), "report.xlsx", &source).unwrap();
        assert_eq!(staged.relative_path, "attachments/report.xlsx");
        assert!(!staged.reused);
        assert_eq!(
            fs::read(temp_dir.path().join("attachments").join("report.xlsx")).unwrap(),
            b"xlsx-binary"
        );
    }

    #[test]
    fn rejects_oversized_sparse_disk_source_before_copying() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let source_dir = tempfile::tempdir().expect("source");
        let source = source_dir.path().join("oversized.bin");
        let file = fs::File::create(&source).expect("create sparse source");
        file.set_len(MAX_STAGE_BYTES + 1)
            .expect("set sparse source size");

        let err = stage_disk_into_temp_root(temp_dir.path(), "oversized.bin", &source)
            .expect_err("oversized disk source must be rejected");
        assert!(err.contains("256 MB"));
        assert!(!temp_dir
            .path()
            .join("attachments")
            .join("oversized.bin")
            .exists());
    }

    #[test]
    fn index_hit_revalidates_same_length_file_hash() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let first = stage_bytes_into_temp_root(temp_dir.path(), "report.bin", b"original").unwrap();
        let first_path = temp_dir.path().join(&first.relative_path);
        fs::write(&first_path, b"tampered").unwrap();

        let second =
            stage_bytes_into_temp_root(temp_dir.path(), "report.bin", b"original").unwrap();
        assert!(!second.reused);
        assert_eq!(second.relative_path, "attachments/report_1.bin");
        assert_eq!(
            fs::read(temp_dir.path().join(&second.relative_path)).unwrap(),
            b"original"
        );
    }

    #[test]
    fn stage_index_rejects_non_plain_file_names() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let stage_dir = temp_dir.path().join(STAGE_SUBDIR);
        fs::create_dir_all(&stage_dir).unwrap();
        let hash = "a".repeat(64);
        let malicious = HashMap::from([(hash, "../outside.bin".to_string())]);
        fs::write(
            stage_dir.join(STAGE_INDEX_FILE),
            serde_json::to_string(&malicious).unwrap(),
        )
        .unwrap();

        assert!(load_stage_index(&stage_dir).is_empty());
    }
}
