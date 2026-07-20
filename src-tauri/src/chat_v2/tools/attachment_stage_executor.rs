//! 内置附件物化工具执行器
//!
//! 解决「二进制附件进不了 shell/脚本处理链路」的断裂点：
//! `attachment_read` 只能返回解析后的文本/base64，拿不到磁盘路径，
//! xlsx/zip/图片等二进制附件无法交给 local_shell_execute / workspace 文件工具处理。
//!
//! 执行两个内置工具：
//! - `builtin-attachment_stage` / `attachment_stage` - 把附件原始字节物化到
//!   当前会话 temp runtime root 的 `attachments/` 子目录，返回 `root_id + relative_path`。
//! - `builtin-attachment_extract` / `attachment_extract` - 把已物化的 zip 安全解压到
//!   temp root 的 `extracted/` 子目录（纯 Rust，移动端无 shell 时的解包途径）。
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
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use base64::Engine;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::repo::ChatV2Repo;
use crate::chat_v2::runtime_roots::{normalize_runtime_relative_path, temp_root};
use crate::chat_v2::task_objects::{
    ManagedLocator, ObjectCapabilities, ObjectProvenance, TaskObjectHandle, TaskObjectKind,
};
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::vfs::repos::attachment_repo::VfsAttachmentContentSource;
use crate::vfs::repos::VfsAttachmentRepo;

// ============================================================================
// 常量
// ============================================================================

/// temp root 内的物化子目录
const STAGE_SUBDIR: &str = "attachments";

/// temp root 内的受管解压子目录（attachment_extract 的输出根）
const EXTRACT_SUBDIR: &str = "extracted";

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
/// A single user turn is bounded independently from the UI attachment limit.
/// This also covers context refs assembled by plugins or restored drafts.
const MAX_AUTO_STAGE_ITEMS: usize = 64;
const MAX_ARCHIVE_ENTRIES: usize = 4_096;
const MAX_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_UNCOMPRESSED_BYTES: u64 = 256 * 1024 * 1024;
const MAX_ARCHIVE_COMPRESSION_RATIO: u64 = 200;
const MAX_ARCHIVE_MANIFEST_ENTRIES: usize = 200;

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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoStageContextAttachmentInput {
    pub resource_id: String,
    pub source_id: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoStagedContextAttachment {
    pub resource_id: String,
    pub source_id: String,
    pub root_id: String,
    pub relative_path: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub reused: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    pub object_handle: TaskObjectHandle,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoStageContextAttachmentFailure {
    pub resource_id: String,
    pub source_id: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoStageContextAttachmentsResult {
    pub expected_items: usize,
    pub observed_items: usize,
    pub coverage_complete: bool,
    pub truncated: bool,
    pub attachments: Vec<AutoStagedContextAttachment>,
    pub failures: Vec<AutoStageContextAttachmentFailure>,
}

fn archive_format(name: &str, mime_type: Option<&str>) -> Option<&'static str> {
    let lower_name = name.to_ascii_lowercase();
    let mime = mime_type.unwrap_or_default().trim().to_ascii_lowercase();
    if lower_name.ends_with(".zip")
        || matches!(
            mime.as_str(),
            "application/zip" | "application/x-zip-compressed"
        )
    {
        Some("zip")
    } else if lower_name.ends_with(".rar")
        || matches!(
            mime.as_str(),
            "application/vnd.rar" | "application/x-rar-compressed"
        )
    {
        Some("rar")
    } else if lower_name.ends_with(".7z") || mime == "application/x-7z-compressed" {
        Some("7z")
    } else {
        None
    }
}

fn validate_archive_signature(path: &Path, format: &str) -> Result<(), String> {
    let mut file = fs::File::open(path).map_err(|e| format!("Failed to open archive: {e}"))?;
    let mut header = [0u8; 8];
    let read = file
        .read(&mut header)
        .map_err(|e| format!("Failed to read archive signature: {e}"))?;
    let header = &header[..read];
    let valid = match format {
        "zip" => {
            header.starts_with(b"PK\x03\x04")
                || header.starts_with(b"PK\x05\x06")
                || header.starts_with(b"PK\x07\x08")
        }
        "rar" => {
            header.starts_with(b"Rar!\x1a\x07\x00") || header.starts_with(b"Rar!\x1a\x07\x01\x00")
        }
        "7z" => header.starts_with(b"\x37\x7a\xbc\xaf\x27\x1c"),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(format!(
            "Archive signature does not match declared {format} format"
        ))
    }
}

fn scan_zip_archive(path: &Path) -> Result<Value, String> {
    validate_archive_signature(path, "zip")?;
    let file = fs::File::open(path).map_err(|e| format!("Failed to open ZIP archive: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Invalid ZIP archive: {e}"))?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(format!(
            "Archive contains too many entries: {} exceeds {}",
            archive.len(),
            MAX_ARCHIVE_ENTRIES
        ));
    }

    let mut total_uncompressed = 0u64;
    let mut max_entry_uncompressed = 0u64;
    let mut entries = Vec::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|e| format!("Failed to inspect ZIP entry {index}: {e}"))?;
        let name = entry.name().to_string();
        if entry.enclosed_name().is_none() {
            return Err(format!("Archive entry has unsafe path: {name}"));
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(format!("Archive entry is a symbolic link: {name}"));
        }
        let uncompressed = entry.size();
        let compressed = entry.compressed_size();
        if uncompressed > MAX_ARCHIVE_ENTRY_UNCOMPRESSED_BYTES {
            return Err(format!(
                "Archive entry is too large after extraction: {name}"
            ));
        }
        if uncompressed > 0
            && (compressed == 0 || uncompressed / compressed.max(1) > MAX_ARCHIVE_COMPRESSION_RATIO)
        {
            return Err(format!(
                "Archive entry exceeds compression ratio limit: {name}"
            ));
        }
        total_uncompressed = total_uncompressed
            .checked_add(uncompressed)
            .ok_or_else(|| "Archive expanded size overflow".to_string())?;
        if total_uncompressed > MAX_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES {
            return Err("Archive total expanded size exceeds limit".to_string());
        }
        max_entry_uncompressed = max_entry_uncompressed.max(uncompressed);
        if entries.len() < MAX_ARCHIVE_MANIFEST_ENTRIES {
            entries.push(json!({
                "path": name,
                "directory": entry.is_dir(),
                "compressedSize": compressed,
                "uncompressedSize": uncompressed,
            }));
        }
    }

    Ok(json!({
        "format": "zip",
        "scanned": true,
        "safeToExtract": true,
        "entryCount": archive.len(),
        "totalUncompressedBytes": total_uncompressed,
        "maxEntryUncompressedBytes": max_entry_uncompressed,
        "entries": entries,
        "entriesTruncated": archive.len() > MAX_ARCHIVE_MANIFEST_ENTRIES,
        "limits": {
            "maxEntries": MAX_ARCHIVE_ENTRIES,
            "maxTotalUncompressedBytes": MAX_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES,
            "maxEntryUncompressedBytes": MAX_ARCHIVE_ENTRY_UNCOMPRESSED_BYTES,
            "maxCompressionRatio": MAX_ARCHIVE_COMPRESSION_RATIO,
        }
    }))
}

fn scan_archive_for_stage(
    path: &Path,
    name: &str,
    mime_type: Option<&str>,
) -> Result<Option<Value>, String> {
    let Some(format) = archive_format(name, mime_type) else {
        return Ok(None);
    };
    if format == "zip" {
        return scan_zip_archive(path).map(Some);
    }
    validate_archive_signature(path, format)?;
    Ok(Some(json!({
        "format": format,
        "scanned": false,
        "safeToExtract": false,
        "reason": "Entry-level scanning is unavailable for this archive format; no extraction was performed",
    })))
}

fn scan_staged_archive_or_cleanup(
    temp_root_path: &Path,
    staged: &StagedFile,
    name: &str,
    mime_type: Option<&str>,
) -> Result<Option<Value>, String> {
    let staged_path = temp_root_path.join(&staged.relative_path);
    match scan_archive_for_stage(&staged_path, name, mime_type) {
        Ok(manifest) => Ok(manifest),
        Err(error) => {
            if !staged.reused {
                let _ = fs::remove_file(&staged_path);
                if let Some(parent) = staged_path.parent() {
                    let mut index = load_stage_index(parent);
                    index.remove(&staged.sha256);
                    save_stage_index(parent, &index);
                }
            }
            Err(error)
        }
    }
}

// ============================================================================
// 纯函数：受管解压（attachment_extract）
// ============================================================================

/// 在 temp root 内解析一个已物化文件的安全绝对路径。
///
/// 校验与 skill_install 的 runtime_path 读取一致：
/// `normalize_runtime_relative_path` 拒绝绝对路径/`..`，canonicalize 后必须
/// 仍在 temp root 内，且必须是常规文件（拒绝 symlink/目录）。
///
/// `pub(crate)`：notes_import / session_import 等消费 staged 附件的执行器复用。
pub(crate) fn resolve_staged_file_in_temp_root(
    temp_root_path: &Path,
    relative_path: &str,
) -> Result<std::path::PathBuf, String> {
    let relative = normalize_runtime_relative_path(Some(relative_path))?;
    let root_canon = temp_root_path
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize temp root: {}", e))?;
    let target = temp_root_path.join(&relative);
    let meta = fs::symlink_metadata(&target)
        .map_err(|_| format!("Staged file not found: {}", relative_path))?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err("Staged path must be a regular file".to_string());
    }
    let target_canon = target
        .canonicalize()
        .map_err(|e| format!("Failed to resolve staged file path: {}", e))?;
    if !target_canon.starts_with(&root_canon) {
        return Err("Staged path escapes the session temp root".to_string());
    }
    Ok(target_canon)
}

/// 在 `extracted/` 下创建唯一目标目录（同名自动加 `_N` 序号后缀）。
fn create_unique_extract_dir(
    temp_root_path: &Path,
    requested_name: &str,
) -> Result<(std::path::PathBuf, String), String> {
    let base_name = sanitize_file_name(requested_name);
    let extract_base = temp_root_path.join(EXTRACT_SUBDIR);
    fs::create_dir_all(&extract_base)
        .map_err(|e| format!("Failed to create extract base dir: {}", e))?;
    let root_canon = temp_root_path
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize temp root: {}", e))?;
    let base_canon = extract_base
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize extract base dir: {}", e))?;
    if !base_canon.starts_with(&root_canon) {
        return Err("Extract directory escapes the temp root".to_string());
    }

    for attempt in 0..=MAX_SUFFIX_ATTEMPTS {
        let candidate = if attempt == 0 {
            base_name.clone()
        } else {
            format!("{}_{}", base_name, attempt)
        };
        let relative = format!("{}/{}", EXTRACT_SUBDIR, candidate);
        if normalize_runtime_relative_path(Some(&relative))
            .map(|p| p.components().count() != 2)
            .unwrap_or(true)
        {
            return Err("Sanitized extract dir name must resolve to a plain name".to_string());
        }
        let target = base_canon.join(&candidate);
        match fs::create_dir(&target) {
            Ok(()) => return Ok((target, relative)),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(format!("Failed to create extract dir: {}", err)),
        }
    }
    Err(format!(
        "Too many name conflicts in the extract directory for '{}'",
        base_name
    ))
}

/// 把 temp root 内已物化的 zip 解压到 `extracted/<name>/`。
///
/// 安全模型（与 `scan_zip_archive` 同级）：
/// - 解压前先做完整 scan（签名/条目数/zip-bomb 压缩比/总量/entry 路径穿越/symlink）；
/// - 写入阶段再次逐条校验 `enclosed_name`，并对每个条目和总量做有界拷贝，
///   防止 scan 与 extract 之间文件被替换（TOCTOU）；
/// - 所有输出都限定在 temp root 的 `extracted/` 子目录内。
fn extract_zip_into_temp_root(
    temp_root_path: &Path,
    zip_relative_path: &str,
    target_dir_name: Option<&str>,
) -> Result<Value, String> {
    let zip_path = resolve_staged_file_in_temp_root(temp_root_path, zip_relative_path)?;
    let file_name = zip_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("archive.zip");

    match archive_format(file_name, None) {
        Some("zip") | None => {}
        Some(other) => {
            return Err(format!(
                "EXTRACT_UNSUPPORTED_FORMAT: '{}' archives are not supported; only zip can be extracted. \
                 Ask the user to re-package as zip, or (desktop only) use local_shell_execute.",
                other
            ));
        }
    }

    // 有界预检：签名、条目数、压缩比、总解压量、路径穿越、symlink
    scan_zip_archive(&zip_path)?;

    let requested_dir = target_dir_name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| split_stem_ext(file_name).0);
    let (extract_dir, extract_relative) =
        create_unique_extract_dir(temp_root_path, &requested_dir)?;
    let extract_dir_canon = extract_dir
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize extract dir: {}", e))?;

    let result = (|| -> Result<Value, String> {
        let file =
            fs::File::open(&zip_path).map_err(|e| format!("Failed to open ZIP archive: {e}"))?;
        let mut archive =
            zip::ZipArchive::new(file).map_err(|e| format!("Invalid ZIP archive: {e}"))?;
        if archive.len() > MAX_ARCHIVE_ENTRIES {
            return Err(format!(
                "Archive contains too many entries: {} exceeds {}",
                archive.len(),
                MAX_ARCHIVE_ENTRIES
            ));
        }

        let mut total_written = 0u64;
        let mut file_count = 0usize;
        let mut dir_count = 0usize;
        let mut manifest = Vec::new();
        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|e| format!("Failed to read ZIP entry {index}: {e}"))?;
            let entry_name = entry.name().to_string();
            let enclosed = entry
                .enclosed_name()
                .ok_or_else(|| format!("Archive entry has unsafe path: {entry_name}"))?
                .to_path_buf();
            if entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
            {
                return Err(format!("Archive entry is a symbolic link: {entry_name}"));
            }

            let dest = extract_dir_canon.join(&enclosed);
            if entry.is_dir() {
                fs::create_dir_all(&dest)
                    .map_err(|e| format!("Failed to create dir '{entry_name}': {e}"))?;
                dir_count += 1;
                continue;
            }
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create parent dir for '{entry_name}': {e}"))?;
                let parent_canon = parent
                    .canonicalize()
                    .map_err(|e| format!("Failed to canonicalize entry parent dir: {e}"))?;
                if !parent_canon.starts_with(&extract_dir_canon) {
                    return Err(format!("Archive entry escapes extract dir: {entry_name}"));
                }
            }

            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&dest)
                .map_err(|e| format!("Failed to create extracted file '{entry_name}': {e}"))?;
            // 有界拷贝：scan 之后文件仍可能被替换，写入阶段独立限额
            let mut limited = (&mut entry).take(MAX_ARCHIVE_ENTRY_UNCOMPRESSED_BYTES + 1);
            let written = std::io::copy(&mut limited, &mut output)
                .map_err(|e| format!("Failed to extract '{entry_name}': {e}"))?;
            if written > MAX_ARCHIVE_ENTRY_UNCOMPRESSED_BYTES {
                return Err(format!(
                    "Archive entry is too large after extraction: {entry_name}"
                ));
            }
            total_written = total_written
                .checked_add(written)
                .ok_or("Archive expanded size overflow")?;
            if total_written > MAX_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES {
                return Err("Archive total expanded size exceeds limit".to_string());
            }

            file_count += 1;
            if manifest.len() < MAX_ARCHIVE_MANIFEST_ENTRIES {
                let relative_out = format!(
                    "{}/{}",
                    extract_relative,
                    enclosed
                        .components()
                        .map(|c| c.as_os_str().to_string_lossy())
                        .collect::<Vec<_>>()
                        .join("/")
                );
                manifest.push(json!({
                    "path": relative_out,
                    "sizeBytes": written,
                }));
            }
        }

        Ok(json!({
            "success": true,
            "format": "zip",
            "root_id": "temp",
            "extract_dir": extract_relative,
            "source": zip_relative_path,
            "fileCount": file_count,
            "directoryCount": dir_count,
            "totalUncompressedBytes": total_written,
            "files": manifest,
            "filesTruncated": file_count > MAX_ARCHIVE_MANIFEST_ENTRIES,
            "hint": "解压完成：可用 workspace_file_list / workspace_file_read（root_id=temp, path=extract_dir 下的相对路径）继续处理；此工具是移动端等无 shell 环境下的受管解包途径。",
        }))
    })();

    if result.is_err() {
        // 失败时清理半成品目录，避免残留部分解压内容
        let _ = fs::remove_dir_all(&extract_dir_canon);
    }
    result
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

    fn stage_context_attachment(
        app: &AppHandle,
        vfs_db: &crate::vfs::database::VfsDatabase,
        session_id: &str,
        input: &AutoStageContextAttachmentInput,
    ) -> Result<AutoStagedContextAttachment, String> {
        let resolved = Self::resolve_vfs_attachment(vfs_db, &input.source_id)?
            .ok_or_else(|| format!("Attachment source not found in VFS: {}", input.source_id))?;
        let requested_name = if input.display_name.trim().is_empty() {
            resolved.name.as_str()
        } else {
            input.display_name.trim()
        };
        let temp = temp_root(app, session_id, true)?;
        let staged = stage_payload_into_temp_root(&temp.path, requested_name, &resolved.payload)?;
        // Automatic staging never extracts archives, but validates supported archive
        // signatures/manifests with the same bounded checks as the agent tool.
        let _ = scan_staged_archive_or_cleanup(
            &temp.path,
            &staged,
            requested_name,
            resolved.mime_type.as_deref(),
        )?;

        let locator = ManagedLocator::new(temp.id.clone(), staged.relative_path.clone())?;
        let mut object_handle = TaskObjectHandle::new(
            format!("attachment:{}:{}", input.source_id, staged.sha256),
            TaskObjectKind::File,
            resolved.name,
            ObjectProvenance {
                source: "chat_context_ref".to_string(),
                source_uri: None,
                server: None,
                tool: Some("send_time_attachment_stage".to_string()),
                derived_from: vec![input.resource_id.clone(), input.source_id.clone()],
                observed_at: chrono::Utc::now().to_rfc3339(),
            },
        );
        object_handle.media_type = resolved.mime_type.clone();
        object_handle.size_bytes = Some(staged.size_bytes);
        object_handle.sha256 = Some(staged.sha256.clone());
        object_handle.locator = Some(locator);
        object_handle.capabilities = ObjectCapabilities {
            readable: true,
            materializable: true,
            writable: false,
            shareable: false,
            sendable: false,
            deletable: false,
        };
        object_handle.validate()?;

        Ok(AutoStagedContextAttachment {
            resource_id: input.resource_id.clone(),
            source_id: input.source_id.clone(),
            root_id: temp.id,
            relative_path: staged.relative_path,
            size_bytes: staged.size_bytes,
            sha256: staged.sha256,
            reused: staged.reused,
            media_type: resolved.mime_type,
            object_handle,
        })
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

        let (staged, temp_id, original_name, mime_type, archive_manifest) =
            tokio::task::spawn_blocking(move || {
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
                let archive_manifest = scan_staged_archive_or_cleanup(
                    &temp.path,
                    &staged,
                    requested_name,
                    mime_type.as_deref(),
                )?;
                Ok::<_, String>((staged, temp.id, name, mime_type, archive_manifest))
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

        let locator = ManagedLocator::new(temp_id.clone(), staged.relative_path.clone())?;
        let mut object_handle = TaskObjectHandle::new(
            format!("attachment:{}:{}", attachment_id, staged.sha256),
            TaskObjectKind::File,
            original_name.clone(),
            ObjectProvenance {
                source: "chat_attachment".to_string(),
                source_uri: None,
                server: None,
                tool: Some("attachment_stage".to_string()),
                derived_from: vec![attachment_id.clone()],
                observed_at: chrono::Utc::now().to_rfc3339(),
            },
        );
        object_handle.media_type = mime_type.clone();
        object_handle.size_bytes = Some(staged.size_bytes);
        object_handle.sha256 = Some(staged.sha256.clone());
        object_handle.locator = Some(locator);
        object_handle.capabilities = ObjectCapabilities {
            readable: true,
            materializable: true,
            writable: false,
            shareable: false,
            sendable: false,
            deletable: false,
        };
        object_handle.validate()?;

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
            "object_handle": object_handle,
        });
        if let Some(mime_type) = mime_type {
            output["mime_type"] = json!(mime_type);
        }
        if let Some(manifest) = archive_manifest {
            output["archive_manifest"] = manifest;
        }

        Ok(output)
    }

    /// 执行受管解压（attachment_extract）
    ///
    /// 入参为 attachment_stage 返回的 `root_id`（必须是 temp）+ `relative_path`。
    /// temp root 按会话隔离解析，天然完成会话归属校验。
    async fn execute_extract(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let root_id = call
            .arguments
            .get("root_id")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("temp");
        if !root_id.eq_ignore_ascii_case("temp") {
            return Err(format!(
                "attachment_extract only accepts root_id=temp (staged attachments), got '{}'",
                root_id
            ));
        }
        let relative_path = call
            .arguments
            .get("relative_path")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or("Missing 'relative_path' parameter (use the path returned by attachment_stage)")?
            .to_string();
        let target_dir = call
            .arguments
            .get("target_dir")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        let start_time = Instant::now();
        let app_handle = ctx.window_ref().app_handle().clone();
        let session_id = ctx.session_id.clone();

        let mut output = tokio::task::spawn_blocking(move || {
            let temp = temp_root(&app_handle, &session_id, true)?;
            extract_zip_into_temp_root(&temp.path, &relative_path, target_dir.as_deref())
        })
        .await
        .map_err(|e| format!("Attachment extraction task failed: {}", e))??;

        let duration = start_time.elapsed().as_millis() as u64;
        output["durationMs"] = json!(duration);
        Ok(output)
    }
}

/// Materialize binary user ContextRefs before the model turn begins.
///
/// The command is deliberately source-id based: the user message does not exist in
/// the backend yet, while the VFS attachment already does. Folder refs are never
/// accepted here, preventing an implicit recursive upload.
#[tauri::command]
pub async fn chat_v2_stage_context_attachments(
    app: AppHandle,
    vfs_db: State<'_, Arc<crate::vfs::database::VfsDatabase>>,
    session_id: String,
    items: Vec<AutoStageContextAttachmentInput>,
) -> Result<AutoStageContextAttachmentsResult, String> {
    if session_id.trim().is_empty() {
        return Err("sessionId is required for attachment materialization".to_string());
    }

    let expected_items = items.len();
    let truncated = expected_items > MAX_AUTO_STAGE_ITEMS;
    let bounded_items: Vec<_> = items.into_iter().take(MAX_AUTO_STAGE_ITEMS).collect();
    let observed_items = bounded_items.len();
    let vfs_db = Arc::clone(vfs_db.inner());
    tokio::task::spawn_blocking(move || {
        let mut attachments = Vec::with_capacity(observed_items);
        let mut failures = Vec::new();
        for input in bounded_items {
            match AttachmentStageExecutor::stage_context_attachment(
                &app,
                &vfs_db,
                &session_id,
                &input,
            ) {
                Ok(staged) => attachments.push(staged),
                Err(error) => failures.push(AutoStageContextAttachmentFailure {
                    resource_id: input.resource_id,
                    source_id: input.source_id,
                    error,
                }),
            }
        }

        Ok(AutoStageContextAttachmentsResult {
            expected_items,
            observed_items,
            coverage_complete: !truncated && observed_items == expected_items,
            truncated,
            attachments,
            failures,
        })
    })
    .await
    .map_err(|error| format!("Attachment materialization task failed: {error}"))?
}

impl Default for AttachmentStageExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for AttachmentStageExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        matches!(
            strip_tool_namespace(tool_name),
            "attachment_stage" | "attachment_extract"
        )
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

        let result = match strip_tool_namespace(&call.name) {
            "attachment_extract" => self.execute_extract(call, ctx).await,
            _ => self.execute_stage(call, ctx).await,
        };
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
        assert!(executor.can_handle("builtin-attachment_extract"));
        assert!(executor.can_handle("attachment_extract"));
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

    fn write_test_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let file = fs::File::create(path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, bytes) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
    }

    #[test]
    fn zip_scan_returns_bounded_safe_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("bundle.zip");
        write_test_zip(
            &path,
            &[("docs/readme.txt", b"hello"), ("data.csv", b"a,b")],
        );

        let manifest = scan_zip_archive(&path).unwrap();
        assert_eq!(manifest["format"], "zip");
        assert_eq!(manifest["scanned"], true);
        assert_eq!(manifest["safeToExtract"], true);
        assert_eq!(manifest["entryCount"], 2);
        assert_eq!(manifest["totalUncompressedBytes"], 8);
    }

    #[test]
    fn zip_scan_rejects_parent_traversal() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("unsafe.zip");
        write_test_zip(&path, &[("../outside.txt", b"escape")]);

        let error = scan_zip_archive(&path).unwrap_err();
        assert!(error.contains("unsafe path"), "{error}");
    }

    #[test]
    fn rar_and_7z_are_signature_checked_but_not_claimed_as_scanned() {
        let temp = tempfile::tempdir().unwrap();
        let rar = temp.path().join("bundle.rar");
        fs::write(&rar, b"Rar!\x1a\x07\x01\x00payload").unwrap();
        let manifest = scan_archive_for_stage(&rar, "bundle.rar", Some("application/vnd.rar"))
            .unwrap()
            .unwrap();
        assert_eq!(manifest["scanned"], false);
        assert_eq!(manifest["safeToExtract"], false);

        let fake = temp.path().join("fake.7z");
        fs::write(&fake, b"not-7z").unwrap();
        assert!(
            scan_archive_for_stage(&fake, "fake.7z", Some("application/x-7z-compressed")).is_err()
        );
    }

    #[test]
    fn rejected_new_archive_is_removed_with_its_index_entry() {
        let temp = tempfile::tempdir().unwrap();
        let staged = stage_bytes_into_temp_root(temp.path(), "fake.zip", b"not-a-zip").unwrap();
        let error = scan_staged_archive_or_cleanup(
            temp.path(),
            &staged,
            "fake.zip",
            Some("application/zip"),
        )
        .unwrap_err();
        assert!(error.contains("signature"));
        assert!(!temp.path().join(&staged.relative_path).exists());
        assert!(!load_stage_index(&temp.path().join(STAGE_SUBDIR)).contains_key(&staged.sha256));
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
    fn extract_zip_writes_files_under_extracted_subdir() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let staged =
            stage_bytes_into_temp_root(temp_dir.path(), "bundle.zip", b"placeholder").unwrap();
        // 覆盖为真实 zip 内容
        let zip_path = temp_dir.path().join(&staged.relative_path);
        write_test_zip(
            &zip_path,
            &[("docs/readme.txt", b"hello"), ("data.csv", b"a,b")],
        );

        let result =
            extract_zip_into_temp_root(temp_dir.path(), &staged.relative_path, None).unwrap();
        assert_eq!(result["success"], true);
        assert_eq!(result["fileCount"], 2);
        let extract_dir = result["extract_dir"].as_str().unwrap();
        assert!(extract_dir.starts_with("extracted/"));
        assert_eq!(
            fs::read(temp_dir.path().join(extract_dir).join("docs/readme.txt")).unwrap(),
            b"hello"
        );
        assert_eq!(
            fs::read(temp_dir.path().join(extract_dir).join("data.csv")).unwrap(),
            b"a,b"
        );
    }

    #[test]
    fn extract_rejects_traversal_and_cleans_up_partial_output() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let staged =
            stage_bytes_into_temp_root(temp_dir.path(), "unsafe.zip", b"placeholder").unwrap();
        let zip_path = temp_dir.path().join(&staged.relative_path);
        write_test_zip(&zip_path, &[("../outside.txt", b"escape")]);

        let error =
            extract_zip_into_temp_root(temp_dir.path(), &staged.relative_path, None).unwrap_err();
        assert!(error.contains("unsafe path"), "{error}");
        // 预检失败发生在建目录之前，temp root 外不得有任何写入
        assert!(!temp_dir.path().parent().unwrap().join("outside.txt").exists());
    }

    #[test]
    fn extract_rejects_non_zip_formats_with_structured_error() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let staged =
            stage_bytes_into_temp_root(temp_dir.path(), "bundle.rar", b"Rar!\x1a\x07\x01\x00x")
                .unwrap();
        let error =
            extract_zip_into_temp_root(temp_dir.path(), &staged.relative_path, None).unwrap_err();
        assert!(error.contains("EXTRACT_UNSUPPORTED_FORMAT"), "{error}");
    }

    #[test]
    fn extract_rejects_paths_outside_temp_root() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        assert!(resolve_staged_file_in_temp_root(temp_dir.path(), "../evil.zip").is_err());
        assert!(resolve_staged_file_in_temp_root(temp_dir.path(), "/abs/evil.zip").is_err());
    }

    #[test]
    fn extract_dir_names_get_numeric_suffix_on_conflict() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let (_, first) = create_unique_extract_dir(temp_dir.path(), "bundle").unwrap();
        let (_, second) = create_unique_extract_dir(temp_dir.path(), "bundle").unwrap();
        assert_eq!(first, "extracted/bundle");
        assert_eq!(second, "extracted/bundle_1");
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
