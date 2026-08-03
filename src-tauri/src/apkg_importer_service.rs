use crate::database::Database;
use crate::models::{AppError, AppErrorType};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Cursor, Read, Seek, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tempfile::NamedTempFile;
use tracing::warn;
use uuid::Uuid;
use zip::ZipArchive;

pub const APKG_ERROR_INVALID_INPUT: &str = "apkg_invalid_input";
pub const APKG_ERROR_NOT_FOUND: &str = "apkg_not_found";
pub const APKG_ERROR_NOT_FILE: &str = "apkg_not_file";
pub const APKG_ERROR_IO: &str = "apkg_io";
pub const APKG_ERROR_INVALID_ARCHIVE: &str = "apkg_invalid_archive";
pub const APKG_ERROR_LIMIT_EXCEEDED: &str = "apkg_limit_exceeded";
pub const APKG_ERROR_COLLECTION_MISSING: &str = "apkg_collection_missing";
pub const APKG_ERROR_COLLECTION_INVALID: &str = "apkg_collection_invalid";
pub const APKG_ERROR_DATABASE: &str = "apkg_database";
/// 历史错误码：现代 anki21b 包已支持直接导入，保留常量仅为兼容旧前端的错误映射。
pub const APKG_ERROR_MODERN_SCHEMA: &str = "apkg_modern_schema_unsupported";
pub const APKG_ERROR_COLPKG: &str = "colpkg_unsupported";

/// 导入时注入的 Anki 调度信息元数据键。
/// 与 apkg_exporter_service 的回写读取（card_sched_restore）严格一致。
pub const ANKI_SCHED_METADATA_KEYS: [&str; 7] = [
    "AnkiSchedType",
    "AnkiQueue",
    "AnkiDue",
    "AnkiIvl",
    "AnkiFactor",
    "AnkiReps",
    "AnkiLapses",
];

pub const MAX_APKG_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_ZIP_ENTRIES: usize = 10_000;
const MAX_ENTRY_BYTES: u64 = 256 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_COLLECTION_BYTES: usize = 256 * 1024 * 1024;
const MAX_MEDIA_MANIFEST_BYTES: usize = 8 * 1024 * 1024;
const MAX_MODELS_JSON_BYTES: usize = 32 * 1024 * 1024;
const MAX_DECKS_JSON_BYTES: usize = 16 * 1024 * 1024;
const MAX_CARDS: usize = 250_000;
const MAX_FIELDS_PER_MODEL: usize = 512;
const MAX_FIELD_VALUE_BYTES: usize = 16 * 1024 * 1024;
const MAX_RAW_TAG_BYTES: usize = 1024 * 1024;
const MAX_TAGS_PER_CARD: usize = 4096;
const MAX_TAG_BYTES: usize = 4096;
const MAX_TEMPLATE_ID_BYTES: usize = 4096;
const MAX_MATERIALIZED_CARD_BYTES: usize = 256 * 1024 * 1024;
const SQLITE_PROGRESS_OP_INTERVAL: i32 = 10_000;
const SQLITE_MAX_PROGRESS_CALLBACKS: usize = 10_000;
const SQLITE_QUERY_DEADLINE: Duration = Duration::from_secs(15);
const MAX_ZSTD_WINDOW_LOG: u32 = 27;

const SQLITE_HEADER: &[u8] = b"SQLite format 3\0";
const ZSTD_MAGIC: &[u8] = &[0x28, 0xb5, 0x2f, 0xfd];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApkgImportResult {
    pub document_id: String,
    pub imported_cards: usize,
    pub imported_templates: usize,
    pub media_skipped: usize,
    /// 成功落盘到应用媒体目录的媒体文件数。
    /// 未配置媒体目录时恒为 0（此时所有声明媒体计入 media_skipped）。
    #[serde(default)]
    pub media_imported: usize,
    /// 结构化导入告警（媒体/模板导入的非致命问题）。
    /// 空列表不序列化，保持旧前端契约整洁。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    #[serde(skip)]
    pub card_ids: Vec<String>,
}

pub struct ApkgImporterService {
    db: Arc<Database>,
    /// 媒体落盘目录（None = 保持旧行为：不导入媒体，仅统计 media_skipped）
    media_dir: Option<PathBuf>,
}

impl ApkgImporterService {
    pub fn new(db: Arc<Database>) -> Self {
        Self {
            db,
            media_dir: None,
        }
    }

    /// 启用媒体导入：包内媒体按清单文件名解出到 `media_dir`，
    /// 并把引用了这些媒体的卡片 images 指向落盘后的绝对路径。
    pub fn with_media_dir(mut self, media_dir: PathBuf) -> Self {
        self.media_dir = Some(media_dir);
        self
    }

    pub fn import_path(
        &self,
        path: &Path,
        session_id: Option<&str>,
    ) -> Result<ApkgImportResult, AppError> {
        if path.as_os_str().is_empty() {
            return Err(validation_error(
                APKG_ERROR_INVALID_INPUT,
                "APKG path must not be empty",
            ));
        }
        if is_colpkg_source_name(&path.to_string_lossy()) {
            return Err(colpkg_unsupported_error());
        }

        let metadata = match std::fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(app_error(
                    AppErrorType::NotFound,
                    APKG_ERROR_NOT_FOUND,
                    format!("APKG file was not found: {}", path.display()),
                ));
            }
            Err(error) => {
                return Err(file_error(format!(
                    "Failed to inspect APKG file {}: {error}",
                    path.display()
                )));
            }
        };
        if !metadata.is_file() {
            return Err(validation_error(
                APKG_ERROR_NOT_FILE,
                format!("APKG path is not a regular file: {}", path.display()),
            ));
        }
        if metadata.len() == 0 {
            return Err(validation_error(
                APKG_ERROR_INVALID_INPUT,
                "APKG file is empty",
            ));
        }
        if metadata.len() > MAX_APKG_ARCHIVE_BYTES {
            return Err(limit_error(format!(
                "APKG file is larger than the {} byte limit",
                MAX_APKG_ARCHIVE_BYTES
            )));
        }

        let file = File::open(path).map_err(|error| {
            file_error(format!(
                "Failed to open APKG file {}: {error}",
                path.display()
            ))
        })?;
        let source_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("imported.apkg");
        self.import_reader(file, source_name, session_id, ImportLimits::default())
    }

    pub fn import_bytes(
        &self,
        bytes: &[u8],
        source_name: Option<&str>,
        session_id: Option<&str>,
    ) -> Result<ApkgImportResult, AppError> {
        if bytes.is_empty() {
            return Err(validation_error(
                APKG_ERROR_INVALID_INPUT,
                "APKG data must not be empty",
            ));
        }
        if bytes.len() as u64 > MAX_APKG_ARCHIVE_BYTES {
            return Err(limit_error(format!(
                "APKG data is larger than the {} byte limit",
                MAX_APKG_ARCHIVE_BYTES
            )));
        }
        if source_name.is_some_and(is_colpkg_source_name) {
            return Err(colpkg_unsupported_error());
        }
        self.import_reader(
            Cursor::new(bytes),
            source_name.unwrap_or("imported.apkg"),
            session_id,
            ImportLimits::default(),
        )
    }

    fn import_reader<R: Read + Seek>(
        &self,
        reader: R,
        source_name: &str,
        session_id: Option<&str>,
        limits: ImportLimits,
    ) -> Result<ApkgImportResult, AppError> {
        let parsed = parse_archive(reader, limits, self.media_dir.as_deref())?;
        persist_package(&self.db, parsed, source_name, session_id)
    }
}

#[derive(Clone, Copy)]
struct ImportLimits {
    max_entries: usize,
    max_entry_bytes: u64,
    max_total_uncompressed_bytes: u64,
    max_collection_bytes: usize,
    max_materialized_card_bytes: usize,
}

impl Default for ImportLimits {
    fn default() -> Self {
        Self {
            max_entries: MAX_ZIP_ENTRIES,
            max_entry_bytes: MAX_ENTRY_BYTES,
            max_total_uncompressed_bytes: MAX_TOTAL_UNCOMPRESSED_BYTES,
            max_collection_bytes: MAX_COLLECTION_BYTES,
            max_materialized_card_bytes: MAX_MATERIALIZED_CARD_BYTES,
        }
    }
}

struct ParsedPackage {
    cards: Vec<ParsedCard>,
    deck_names: Vec<String>,
    media_skipped: usize,
    media_imported: usize,
    /// deepStudentTemplateId → 可重建的模板定义（供本地缺失时导入）
    template_candidates: Vec<TemplateImportCandidate>,
    warnings: Vec<String>,
}

struct ParsedCard {
    front: String,
    back: String,
    text: Option<String>,
    tags: Vec<String>,
    /// 已落盘媒体的绝对路径（未启用媒体导入时为空）
    images: Vec<String>,
    extra_fields: HashMap<String, String>,
    template_id: Option<String>,
}

/// 从 APKG 模型元数据重建 Deep Student 模板所需的最小信息。
/// 仅对携带 deepStudentTemplateId 的模型生成（外部模型不臆造模板身份）。
struct TemplateImportCandidate {
    template_id: String,
    name: String,
    note_type: String,
    fields: Vec<String>,
    front_template: String,
    back_template: String,
    css_style: String,
}

#[derive(Debug, Deserialize)]
struct RawModel {
    #[serde(default)]
    name: String,
    #[serde(default, rename = "type")]
    model_type: i64,
    #[serde(default, rename = "flds")]
    fields: Vec<RawModelField>,
    #[serde(default, rename = "tmpls")]
    templates: Vec<RawModelTemplate>,
    #[serde(default)]
    css: String,
    #[serde(default, rename = "deepStudentTemplateId")]
    template_id: Option<String>,
    #[serde(default, rename = "deepStudentCollapseClozeOrds")]
    collapse_cloze_ords: bool,
}

#[derive(Debug, Deserialize)]
struct RawModelField {
    name: String,
    #[serde(default)]
    ord: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
struct RawModelTemplate {
    #[serde(default)]
    qfmt: String,
    #[serde(default)]
    afmt: String,
}

struct ModelDefinition {
    name: String,
    model_type: i64,
    fields_by_ord: HashMap<usize, String>,
    field_slot_count: usize,
    template_id: Option<String>,
    collapse_cloze_ords: bool,
}

fn parse_archive<R: Read + Seek>(
    reader: R,
    limits: ImportLimits,
    media_dir: Option<&Path>,
) -> Result<ParsedPackage, AppError> {
    let mut archive = ZipArchive::new(reader).map_err(|error| {
        validation_error(
            APKG_ERROR_INVALID_ARCHIVE,
            format!("Invalid APKG zip archive: {error}"),
        )
    })?;
    if archive.is_empty() {
        return Err(validation_error(
            APKG_ERROR_INVALID_ARCHIVE,
            "APKG archive is empty",
        ));
    }
    if archive.len() > limits.max_entries {
        return Err(limit_error(format!(
            "APKG archive contains more than {} entries",
            limits.max_entries
        )));
    }

    let mut collection_anki21 = None;
    let mut collection_anki2 = None;
    let mut collection_anki21b = None;
    let mut media_manifest = None;
    let mut numeric_media = HashSet::new();
    let mut total_uncompressed = 0u64;

    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|error| {
            validation_error(
                APKG_ERROR_INVALID_ARCHIVE,
                format!("Failed to inspect APKG entry {index}: {error}"),
            )
        })?;
        let name = entry.name().to_string();
        if !is_safe_zip_entry_name(&name) {
            return Err(validation_error(
                APKG_ERROR_INVALID_ARCHIVE,
                format!("APKG contains an unsafe zip entry path: {name}"),
            ));
        }
        if entry.size() > limits.max_entry_bytes {
            return Err(limit_error(format!(
                "APKG entry {name} exceeds the {} byte limit",
                limits.max_entry_bytes
            )));
        }
        total_uncompressed = total_uncompressed
            .checked_add(entry.size())
            .ok_or_else(|| limit_error("APKG uncompressed size overflow"))?;
        if total_uncompressed > limits.max_total_uncompressed_bytes {
            return Err(limit_error(format!(
                "APKG uncompressed content exceeds the {} byte limit",
                limits.max_total_uncompressed_bytes
            )));
        }
        drop(entry);

        match name.as_str() {
            "collection.anki21" => set_unique_entry(&mut collection_anki21, index, &name)?,
            "collection.anki2" => set_unique_entry(&mut collection_anki2, index, &name)?,
            "collection.anki21b" => set_unique_entry(&mut collection_anki21b, index, &name)?,
            "media" => set_unique_entry(&mut media_manifest, index, &name)?,
            _ if is_numeric_media_name(&name) && !numeric_media.insert(name.clone()) => {
                return Err(validation_error(
                    APKG_ERROR_INVALID_ARCHIVE,
                    format!("APKG contains duplicate media entry {name}"),
                ));
            }
            _ => {}
        }
    }

    // 集合优先级：legacy anki21 → 现代 anki21b → anki2。
    // 现代包（collection.anki21b，zstd + 新 schema）中的 collection.anki2 只是
    // “请升级 Anki”占位库，因此 anki21b 必须先于 anki2 被选中；
    // 同时携带 legacy anki21 时仍优先走成熟的 legacy 路径。
    let (collection_index, modern_package) = if let Some(index) = collection_anki21 {
        (index, false)
    } else if let Some(index) = collection_anki21b {
        (index, true)
    } else if let Some(index) = collection_anki2 {
        (index, false)
    } else {
        return Err(validation_error(
            APKG_ERROR_COLLECTION_MISSING,
            "APKG does not contain collection.anki21, collection.anki21b or collection.anki2",
        ));
    };
    let encoded_collection = read_zip_entry_bounded(
        &mut archive,
        collection_index,
        limits.max_collection_bytes,
        "collection database",
    )?;
    let collection_bytes = decode_collection(encoded_collection, limits.max_collection_bytes)?;

    let mut declared_media = HashSet::new();
    let mut manifest_entries: HashMap<String, String> = HashMap::new();
    let mut media_warnings: Vec<String> = Vec::new();
    if let Some(index) = media_manifest {
        let manifest = read_zip_entry_bounded(
            &mut archive,
            index,
            MAX_MEDIA_MANIFEST_BYTES,
            "media manifest",
        )?;
        if modern_package {
            // 现代包媒体清单是 zstd + protobuf（MediaEntries）；
            // 解析失败降级为“无媒体导入”，不阻断卡片导入。
            match parse_modern_media_manifest(&manifest) {
                Ok(values) => manifest_entries = values,
                Err(reason) => {
                    media_warnings.push(format!(
                        "现代 APKG 媒体清单解析失败，本次导入跳过全部媒体: {reason}"
                    ));
                }
            }
        } else {
            let values: HashMap<String, String> =
                serde_json::from_slice(&manifest).map_err(|error| {
                    validation_error(
                        APKG_ERROR_INVALID_ARCHIVE,
                        format!("APKG media manifest is invalid JSON: {error}"),
                    )
                })?;
            manifest_entries = values;
        }
        for key in manifest_entries.keys() {
            if !is_numeric_media_name(key) {
                return Err(validation_error(
                    APKG_ERROR_INVALID_ARCHIVE,
                    format!("APKG media manifest contains an invalid key: {key}"),
                ));
            }
            declared_media.insert(key.clone());
        }
    }
    declared_media.extend(numeric_media);

    // 媒体导入：仅当调用方提供媒体目录时进行；
    // 未提供时保持旧行为（全部计入 media_skipped）。
    let media_paths = if let Some(dir) = media_dir {
        extract_declared_media(
            &mut archive,
            &manifest_entries,
            dir,
            &limits,
            &mut media_warnings,
            modern_package,
        )
    } else {
        HashMap::new()
    };
    let media_imported = media_paths.len();
    let media_skipped = declared_media.len().saturating_sub(media_imported);

    let mut collection_file = NamedTempFile::new().map_err(|error| {
        file_error(format!(
            "Failed to create temporary APKG collection file: {error}"
        ))
    })?;
    collection_file
        .write_all(&collection_bytes)
        .map_err(|error| {
            file_error(format!(
                "Failed to write temporary APKG collection file: {error}"
            ))
        })?;
    collection_file.flush().map_err(|error| {
        file_error(format!(
            "Failed to flush temporary APKG collection file: {error}"
        ))
    })?;

    let mut package = parse_collection_database(
        collection_file.path(),
        limits.max_materialized_card_bytes,
        &media_paths,
        modern_package,
    )?;
    package.media_skipped = media_skipped;
    package.media_imported = media_imported;
    package.warnings.extend(media_warnings);
    Ok(package)
}

/// 媒体文件名安全化：仅保留最后一个 path segment，拒绝空名/点名/超长名。
fn sanitize_media_filename(raw: &str) -> Option<String> {
    let name = Path::new(raw.trim()).file_name()?.to_str()?;
    if name.is_empty() || name == "." || name == ".." || name.len() > 255 {
        return None;
    }
    if name.chars().any(|ch| ch.is_control()) {
        return None;
    }
    Some(name.to_string())
}

/// 把媒体清单声明且包内存在的媒体流式解出到 `media_dir`。
/// 返回「清单文件名 → 落盘绝对路径」映射；所有非致命问题写入 `warnings`。
/// `modern_package` 为 true（anki21b 包）时媒体条目本身通常是 zstd 帧，需先解压。
fn extract_declared_media<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    manifest_entries: &HashMap<String, String>,
    media_dir: &Path,
    limits: &ImportLimits,
    warnings: &mut Vec<String>,
    modern_package: bool,
) -> HashMap<String, String> {
    let mut media_paths: HashMap<String, String> = HashMap::new();
    if manifest_entries.is_empty() {
        return media_paths;
    }
    if let Err(error) = std::fs::create_dir_all(media_dir) {
        warnings.push(format!(
            "创建媒体目录失败，本次导入跳过全部媒体 ({}): {}",
            media_dir.display(),
            error
        ));
        return media_paths;
    }

    for (key, raw_name) in manifest_entries {
        let Some(file_name) = sanitize_media_filename(raw_name) else {
            warnings.push(format!("媒体清单文件名不安全，已跳过: {raw_name}"));
            continue;
        };
        let target = media_dir.join(&file_name);
        if target.exists() {
            // Anki 媒体按文件名寻址：同名文件视为同一媒体，直接复用
            media_paths.insert(raw_name.clone(), target.to_string_lossy().to_string());
            continue;
        }
        let mut entry = match archive.by_name(key) {
            Ok(entry) => entry,
            Err(_) => {
                warnings.push(format!(
                    "媒体清单声明的条目在包内缺失，已跳过: {key} ({file_name})"
                ));
                continue;
            }
        };
        let mut output = match File::create(&target) {
            Ok(file) => file,
            Err(error) => {
                warnings.push(format!("创建媒体文件失败，已跳过 {file_name}: {error}"));
                continue;
            }
        };
        // 解压炸弹防护：实际解压量超过单条目上限时中止并删除半成品
        let copy_result = if modern_package {
            copy_possibly_zstd_media(&mut entry, &mut output, limits.max_entry_bytes)
        } else {
            let mut limited = entry.by_ref().take(limits.max_entry_bytes + 1);
            std::io::copy(&mut limited, &mut output).map_err(|error| error.to_string())
        };
        match copy_result {
            Ok(written) if written > limits.max_entry_bytes => {
                drop(output);
                let _ = std::fs::remove_file(&target);
                warnings.push(format!(
                    "媒体文件解压后超过 {} 字节上限，已跳过: {file_name}",
                    limits.max_entry_bytes
                ));
            }
            Ok(_) => {
                media_paths.insert(raw_name.clone(), target.to_string_lossy().to_string());
            }
            Err(error) => {
                drop(output);
                let _ = std::fs::remove_file(&target);
                warnings.push(format!("解压媒体文件失败，已跳过 {file_name}: {error}"));
            }
        }
    }
    media_paths
}

/// 现代 APKG 的媒体条目通常是 zstd 帧：探测 magic 后解压写入；
/// 非 zstd 数据（防御性兼容）原样拷贝。返回写入的字节数（用于解压炸弹判定）。
fn copy_possibly_zstd_media<R: Read>(
    entry: &mut R,
    output: &mut File,
    max_bytes: u64,
) -> Result<u64, String> {
    let mut header = [0u8; 4];
    let mut header_len = 0usize;
    while header_len < header.len() {
        match entry.read(&mut header[header_len..]) {
            Ok(0) => break,
            Ok(read) => header_len += read,
            Err(error) => return Err(error.to_string()),
        }
    }
    let source = Cursor::new(header[..header_len].to_vec()).chain(entry);
    if header[..header_len] == *ZSTD_MAGIC {
        let mut decoder =
            zstd::stream::read::Decoder::new(source).map_err(|error| error.to_string())?;
        decoder
            .window_log_max(MAX_ZSTD_WINDOW_LOG)
            .map_err(|error| error.to_string())?;
        let mut limited = decoder.take(max_bytes + 1);
        std::io::copy(&mut limited, output).map_err(|error| error.to_string())
    } else {
        let mut limited = source.take(max_bytes + 1);
        std::io::copy(&mut limited, output).map_err(|error| error.to_string())
    }
}

// ============================================================================
// 现代 APKG（anki21b）：最小 protobuf 解码
// ============================================================================

/// 读取 protobuf varint（最多 10 字节）。
fn read_protobuf_varint(bytes: &[u8], pos: &mut usize) -> Result<u64, String> {
    let mut value = 0u64;
    let mut shift = 0u32;
    loop {
        let byte = *bytes
            .get(*pos)
            .ok_or_else(|| "protobuf varint is truncated".to_string())?;
        *pos += 1;
        if shift >= 64 {
            return Err("protobuf varint overflows 64 bits".to_string());
        }
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
        shift += 7;
    }
}

fn read_protobuf_length_delimited<'a>(
    bytes: &'a [u8],
    pos: &mut usize,
) -> Result<&'a [u8], String> {
    let length = read_protobuf_varint(bytes, pos)? as usize;
    let end = pos
        .checked_add(length)
        .ok_or_else(|| "protobuf field length overflow".to_string())?;
    if end > bytes.len() {
        return Err("protobuf length-delimited field is truncated".to_string());
    }
    let slice = &bytes[*pos..end];
    *pos = end;
    Ok(slice)
}

fn skip_protobuf_value(bytes: &[u8], pos: &mut usize, wire_type: u64) -> Result<(), String> {
    match wire_type {
        0 => {
            read_protobuf_varint(bytes, pos)?;
        }
        1 | 5 => {
            let width = if wire_type == 1 { 8 } else { 4 };
            let end = pos
                .checked_add(width)
                .filter(|end| *end <= bytes.len())
                .ok_or_else(|| "protobuf fixed-width field is truncated".to_string())?;
            *pos = end;
        }
        2 => {
            read_protobuf_length_delimited(bytes, pos)?;
        }
        other => return Err(format!("unsupported protobuf wire type {other}")),
    }
    Ok(())
}

/// 解析现代 APKG 媒体清单（zstd 压缩的 protobuf `MediaEntries`）：
/// `MediaEntries { repeated MediaEntry entries = 1; }`
/// `MediaEntry { string name = 1; … }`
/// 仅提取 name，按出现顺序映射到 zip 内数字媒体条目 "0","1",…。
fn parse_modern_media_manifest(bytes: &[u8]) -> Result<HashMap<String, String>, String> {
    let decoded = if bytes.starts_with(ZSTD_MAGIC) {
        let mut decoder = zstd::stream::read::Decoder::new(Cursor::new(bytes))
            .map_err(|error| format!("初始化 zstd 解压失败: {error}"))?;
        decoder
            .window_log_max(MAX_ZSTD_WINDOW_LOG)
            .map_err(|error| format!("限制 zstd 窗口失败: {error}"))?;
        let mut out = Vec::new();
        decoder
            .take(MAX_MEDIA_MANIFEST_BYTES as u64 + 1)
            .read_to_end(&mut out)
            .map_err(|error| format!("zstd 解压失败: {error}"))?;
        if out.len() > MAX_MEDIA_MANIFEST_BYTES {
            return Err(format!(
                "解压后的媒体清单超过 {MAX_MEDIA_MANIFEST_BYTES} 字节上限"
            ));
        }
        out
    } else {
        bytes.to_vec()
    };

    let names = parse_media_entries_protobuf(&decoded)?;
    Ok(names
        .into_iter()
        .enumerate()
        .map(|(index, name)| (index.to_string(), name))
        .collect())
}

fn parse_media_entries_protobuf(bytes: &[u8]) -> Result<Vec<String>, String> {
    let mut names = Vec::new();
    let mut pos = 0usize;
    while pos < bytes.len() {
        let tag = read_protobuf_varint(bytes, &mut pos)?;
        let (field, wire_type) = (tag >> 3, tag & 7);
        if field == 1 && wire_type == 2 {
            let entry = read_protobuf_length_delimited(bytes, &mut pos)?;
            names.push(parse_media_entry_name(entry)?);
            if names.len() > MAX_ZIP_ENTRIES {
                return Err(format!("媒体清单条目数超过 {MAX_ZIP_ENTRIES} 上限"));
            }
        } else {
            skip_protobuf_value(bytes, &mut pos, wire_type)?;
        }
    }
    Ok(names)
}

fn parse_media_entry_name(bytes: &[u8]) -> Result<String, String> {
    let mut pos = 0usize;
    let mut name = None;
    while pos < bytes.len() {
        let tag = read_protobuf_varint(bytes, &mut pos)?;
        let (field, wire_type) = (tag >> 3, tag & 7);
        if field == 1 && wire_type == 2 {
            let raw = read_protobuf_length_delimited(bytes, &mut pos)?;
            let value =
                std::str::from_utf8(raw).map_err(|_| "媒体条目文件名不是合法 UTF-8".to_string())?;
            name = Some(value.to_string());
        } else {
            skip_protobuf_value(bytes, &mut pos, wire_type)?;
        }
    }
    name.ok_or_else(|| "媒体条目缺少文件名".to_string())
}

/// 现代 schema `notetypes.config`（protobuf NotetypeConfig）：field 1 = kind
/// （0 = normal，1 = cloze，proto3 零值不序列化）。解析失败保守回退 normal。
fn parse_notetype_kind(config: &[u8]) -> i64 {
    let mut pos = 0usize;
    while pos < config.len() {
        let Ok(tag) = read_protobuf_varint(config, &mut pos) else {
            return 0;
        };
        let (field, wire_type) = (tag >> 3, tag & 7);
        if field == 1 && wire_type == 0 {
            return match read_protobuf_varint(config, &mut pos) {
                Ok(1) => 1,
                _ => 0,
            };
        }
        if skip_protobuf_value(config, &mut pos, wire_type).is_err() {
            return 0;
        }
    }
    0
}

fn set_unique_entry(slot: &mut Option<usize>, index: usize, name: &str) -> Result<(), AppError> {
    if slot.replace(index).is_some() {
        return Err(validation_error(
            APKG_ERROR_INVALID_ARCHIVE,
            format!("APKG contains duplicate {name} entries"),
        ));
    }
    Ok(())
}

fn is_safe_zip_entry_name(name: &str) -> bool {
    if name.is_empty() || name.starts_with('/') || name.starts_with('\\') || name.contains('\\') {
        return false;
    }
    Path::new(name)
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
}

fn is_numeric_media_name(name: &str) -> bool {
    !name.is_empty() && name.bytes().all(|byte| byte.is_ascii_digit())
}

/// `.colpkg` 是整库集合包（含配置/复习日志/全部牌组），结构与按牌组导出的 apkg 不同，
/// 暂不支持解析；在入口处按扩展名给出结构化指引错误。
fn is_colpkg_source_name(name: &str) -> bool {
    Path::new(name.trim())
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("colpkg"))
}

fn colpkg_unsupported_error() -> AppError {
    validation_error(
        APKG_ERROR_COLPKG,
        "暂不支持导入 .colpkg 集合包。请在 Anki 中使用「文件 → 导出 → 牌组（.apkg）」按牌组导出后再导入。",
    )
}

fn read_zip_entry_bounded<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    index: usize,
    limit: usize,
    label: &str,
) -> Result<Vec<u8>, AppError> {
    let mut entry = archive.by_index(index).map_err(|error| {
        validation_error(
            APKG_ERROR_INVALID_ARCHIVE,
            format!("Failed to open APKG {label}: {error}"),
        )
    })?;
    if entry.size() > limit as u64 {
        return Err(limit_error(format!(
            "APKG {label} exceeds the {limit} byte limit"
        )));
    }
    let mut bytes = Vec::with_capacity((entry.size() as usize).min(limit));
    entry
        .by_ref()
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            validation_error(
                APKG_ERROR_INVALID_ARCHIVE,
                format!("Failed to decompress APKG {label}: {error}"),
            )
        })?;
    if bytes.len() > limit {
        return Err(limit_error(format!(
            "APKG {label} exceeds the {limit} byte limit"
        )));
    }
    Ok(bytes)
}

fn decode_collection(bytes: Vec<u8>, limit: usize) -> Result<Vec<u8>, AppError> {
    if bytes.starts_with(SQLITE_HEADER) {
        return Ok(bytes);
    }
    if !bytes.starts_with(ZSTD_MAGIC) {
        return Err(validation_error(
            APKG_ERROR_COLLECTION_INVALID,
            "APKG collection is neither SQLite nor supported zstd-compressed SQLite",
        ));
    }

    let mut decoder = zstd::stream::read::Decoder::new(Cursor::new(bytes)).map_err(|error| {
        validation_error(
            APKG_ERROR_COLLECTION_INVALID,
            format!("Failed to initialize APKG collection decompression: {error}"),
        )
    })?;
    decoder
        .window_log_max(MAX_ZSTD_WINDOW_LOG)
        .map_err(|error| {
            validation_error(
                APKG_ERROR_COLLECTION_INVALID,
                format!("Failed to limit APKG collection zstd window: {error}"),
            )
        })?;
    let mut decoded = Vec::new();
    decoder
        .take(limit as u64 + 1)
        .read_to_end(&mut decoded)
        .map_err(|error| {
            validation_error(
                APKG_ERROR_COLLECTION_INVALID,
                format!("Failed to decompress APKG collection: {error}"),
            )
        })?;
    if decoded.len() > limit {
        return Err(limit_error(format!(
            "Decompressed APKG collection exceeds the {limit} byte limit"
        )));
    }
    if !decoded.starts_with(SQLITE_HEADER) {
        return Err(validation_error(
            APKG_ERROR_COLLECTION_INVALID,
            "Decompressed APKG collection is not a SQLite database",
        ));
    }
    Ok(decoded)
}

/// 同一 note 的待落地卡片行（按 `ORDER BY c.nid` 保证组内相邻）。
struct PendingNoteGroup {
    model_id: i64,
    note_id: i64,
    raw_tags: String,
    raw_fields: String,
    rows: Vec<PendingCardRow>,
}

struct PendingCardRow {
    card_id: i64,
    card_ord: i64,
    deck_id: i64,
    sched: Option<CardSchedState>,
}

/// Anki cards 表的调度信息快照（SM-2 语义）。
#[derive(Clone, Copy)]
struct CardSchedState {
    card_type: i64,
    queue: i64,
    due: i64,
    ivl: i64,
    factor: i64,
    reps: i64,
    lapses: i64,
}

impl CardSchedState {
    /// 是否携带真实复习进度：全新卡不注入元数据，保持 extra_fields 干净。
    fn has_review_progress(&self) -> bool {
        self.card_type != 0 || self.reps > 0 || self.ivl > 0 || self.lapses > 0 || self.queue < 0
    }
}

fn parse_collection_database(
    path: &Path,
    max_materialized_card_bytes: usize,
    media_paths: &HashMap<String, String>,
    modern_schema: bool,
) -> Result<ParsedPackage, AppError> {
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(path, flags).map_err(|error| {
        validation_error(
            APKG_ERROR_COLLECTION_INVALID,
            format!("Failed to open APKG collection as read-only SQLite: {error}"),
        )
    })?;
    install_collection_progress_handler(&conn);
    conn.pragma_update(None, "query_only", "ON")
        .map_err(collection_sql_error)?;
    conn.pragma_update(None, "trusted_schema", "OFF")
        .map_err(collection_sql_error)?;
    conn.pragma_update(None, "temp_store", "MEMORY")
        .map_err(collection_sql_error)?;

    let mut warnings: Vec<String> = Vec::new();
    let (models, template_candidates, deck_names) = if modern_schema {
        validate_modern_collection_schema(&conn)?;
        let models = load_modern_models(&conn, &mut warnings)?;
        let deck_names = load_modern_deck_names(&conn)?;
        // 现代 notetypes.config 不携带 deepStudentTemplateId（本应用只写 legacy 包），
        // 不臆造模板身份 → 无模板导入候选。
        (models, Vec::new(), deck_names)
    } else {
        validate_collection_schema(&conn)?;
        let (models_json, decks_json): (String, String) = conn
            .query_row("SELECT models, decks FROM col LIMIT 1", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .map_err(collection_sql_error)?;
        if models_json.len() > MAX_MODELS_JSON_BYTES || decks_json.len() > MAX_DECKS_JSON_BYTES {
            return Err(limit_error("APKG model or deck metadata is too large"));
        }
        let (models, template_candidates) = parse_models(&models_json)?;
        let deck_names = parse_deck_names(&decks_json)?;
        (models, template_candidates, deck_names)
    };

    let card_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM cards", [], |row| row.get(0))
        .map_err(collection_sql_error)?;
    if card_count <= 0 {
        return Err(validation_error(
            APKG_ERROR_COLLECTION_INVALID,
            "APKG collection contains no cards",
        ));
    }
    if card_count as usize > MAX_CARDS {
        return Err(limit_error(format!(
            "APKG collection contains more than {MAX_CARDS} cards"
        )));
    }

    // 调度列（type/queue/due/ivl/factor/reps/lapses）在真实 Anki 包中始终存在；
    // 缺失时（如极简合成包）静默退化为不读取调度信息。
    let has_sched_columns = cards_table_has_sched_columns(&conn)?;
    let sched_select = if has_sched_columns {
        ", c.type, c.queue, c.due, c.ivl, c.factor, c.reps, c.lapses"
    } else {
        ""
    };
    // 按 note 分组读取（组内相邻），便于 reversed 卡去重与 Cloze 折叠。
    let sql = format!(
        "SELECT c.id, c.nid, c.did, c.ord, n.mid, n.tags, n.flds{sched_select}
         FROM cards c
         JOIN notes n ON n.id = c.nid
         ORDER BY c.nid, c.ord, c.id"
    );
    let mut stmt = conn.prepare(&sql).map_err(collection_sql_error)?;
    let mut rows = stmt.query([]).map_err(collection_sql_error)?;
    let mut cards = Vec::with_capacity(card_count as usize);
    let mut materialized_bytes = 0usize;
    let mut joined_card_rows = 0usize;
    let mut sched_metadata_cards = 0usize;
    let mut current_group: Option<PendingNoteGroup> = None;
    while let Some(row) = rows.next().map_err(collection_sql_error)? {
        joined_card_rows = joined_card_rows
            .checked_add(1)
            .ok_or_else(|| limit_error("APKG joined card-row count overflow"))?;
        let card_id: i64 = row.get(0).map_err(collection_sql_error)?;
        let note_id: i64 = row.get(1).map_err(collection_sql_error)?;
        let deck_id: i64 = row.get(2).map_err(collection_sql_error)?;
        let card_ord: i64 = row.get(3).map_err(collection_sql_error)?;
        let model_id: i64 = row.get(4).map_err(collection_sql_error)?;
        let model = models.get(&model_id).ok_or_else(|| {
            validation_error(
                APKG_ERROR_COLLECTION_INVALID,
                format!("APKG card references missing model {model_id}"),
            )
        })?;

        let same_group = current_group
            .as_ref()
            .is_some_and(|group| group.model_id == model_id && group.note_id == note_id);
        // Deep Student Cloze 折叠：同 note 其余 card 行直接跳过
        //（与旧行为一致，不计材料化预算）。
        if same_group && model.collapse_cloze_ords {
            continue;
        }
        if !same_group {
            if let Some(group) = current_group.take() {
                flush_note_group(
                    &models,
                    group,
                    media_paths,
                    &mut cards,
                    &mut warnings,
                    &mut sched_metadata_cards,
                )?;
            }
            let raw_tags: String = row.get(5).map_err(collection_sql_error)?;
            let raw_fields: String = row.get(6).map_err(collection_sql_error)?;
            current_group = Some(PendingNoteGroup {
                model_id,
                note_id,
                raw_tags,
                raw_fields,
                rows: Vec::new(),
            });
        }
        let sched = if has_sched_columns {
            Some(CardSchedState {
                card_type: row.get(7).map_err(collection_sql_error)?,
                queue: row.get(8).map_err(collection_sql_error)?,
                due: row.get(9).map_err(collection_sql_error)?,
                ivl: row.get(10).map_err(collection_sql_error)?,
                factor: row.get(11).map_err(collection_sql_error)?,
                reps: row.get(12).map_err(collection_sql_error)?,
                lapses: row.get(13).map_err(collection_sql_error)?,
            })
        } else {
            None
        };
        let group = current_group
            .as_mut()
            .expect("current note group initialized above");
        // 预算估算逐行进行（与旧行为一致，保守计费；去重跳过的行也已计入）。
        let estimated_bytes =
            validate_and_estimate_card(model, &group.raw_tags, &group.raw_fields)?;
        materialized_bytes = materialized_bytes
            .checked_add(estimated_bytes)
            .ok_or_else(|| limit_error("APKG materialized card size overflow"))?;
        if materialized_bytes > max_materialized_card_bytes {
            return Err(limit_error(format!(
                "APKG materialized card data exceeds the {max_materialized_card_bytes} byte limit"
            )));
        }
        group.rows.push(PendingCardRow {
            card_id,
            card_ord,
            deck_id,
            sched,
        });
    }
    if let Some(group) = current_group.take() {
        flush_note_group(
            &models,
            group,
            media_paths,
            &mut cards,
            &mut warnings,
            &mut sched_metadata_cards,
        )?;
    }
    if joined_card_rows != card_count as usize {
        return Err(validation_error(
            APKG_ERROR_COLLECTION_INVALID,
            format!(
                "APKG has {card_count} card rows but only {} rows reference valid notes",
                joined_card_rows
            ),
        ));
    }
    if sched_metadata_cards > 0 {
        warnings.push(format!(
            "已将 {sched_metadata_cards} 张卡片的 Anki 复习进度保存为卡片元数据（AnkiSchedType/AnkiIvl/AnkiReps 等），再导出 APKG 时会回写调度信息"
        ));
    }

    Ok(ParsedPackage {
        cards,
        deck_names,
        media_skipped: 0,
        media_imported: 0,
        template_candidates,
        warnings,
    })
}

/// 落地一个 note 分组：
/// - 单行 / Cloze（外部多挖空）/ Deep Student 模板卡：逐行导入（既有行为）；
/// - 外部非 Cloze 模型（无 deepStudentTemplateId）多行时：
///   两张卡且 ord=0/1 → 视为 “Basic (and reversed card)”，第二张交换正反面；
///   其他组合 → 按 note 去重保留最小 ord 并写入 warning。
fn flush_note_group(
    models: &HashMap<i64, ModelDefinition>,
    group: PendingNoteGroup,
    media_paths: &HashMap<String, String>,
    cards: &mut Vec<ParsedCard>,
    warnings: &mut Vec<String>,
    sched_metadata_cards: &mut usize,
) -> Result<(), AppError> {
    let model = models.get(&group.model_id).ok_or_else(|| {
        validation_error(
            APKG_ERROR_COLLECTION_INVALID,
            format!("APKG card references missing model {}", group.model_id),
        )
    })?;
    let mut rows = group.rows;
    if rows.is_empty() {
        return Ok(());
    }

    let mut push_card = |row: &PendingCardRow, swap_front_back: bool| -> Result<(), AppError> {
        let mut card = map_card(
            model,
            &group.raw_tags,
            &group.raw_fields,
            group.note_id,
            row.card_id,
            row.card_ord,
            row.deck_id,
            group.model_id,
            media_paths,
        )?;
        if swap_front_back {
            std::mem::swap(&mut card.front, &mut card.back);
        }
        if let Some(sched) = row.sched.filter(|sched| sched.has_review_progress()) {
            // 键名与 ANKI_SCHED_METADATA_KEYS / 导出端 card_sched_restore 保持一致
            for (key, value) in [
                ("AnkiSchedType", sched.card_type),
                ("AnkiQueue", sched.queue),
                ("AnkiDue", sched.due),
                ("AnkiIvl", sched.ivl),
                ("AnkiFactor", sched.factor),
                ("AnkiReps", sched.reps),
                ("AnkiLapses", sched.lapses),
            ] {
                card.extra_fields.insert(key.to_string(), value.to_string());
            }
            *sched_metadata_cards += 1;
        }
        cards.push(card);
        Ok(())
    };

    let external_non_cloze =
        model.template_id.is_none() && model.model_type != 1 && !model.collapse_cloze_ords;
    if rows.len() == 1 || !external_non_cloze {
        for row in &rows {
            push_card(row, false)?;
        }
        return Ok(());
    }

    rows.sort_by_key(|row| (row.card_ord, row.card_id));
    if rows.len() == 2 && rows[0].card_ord == 0 && rows[1].card_ord == 1 {
        push_card(&rows[0], false)?;
        push_card(&rows[1], true)?;
        return Ok(());
    }

    push_card(&rows[0], false)?;
    warnings.push(format!(
        "外部多模板笔记 {} 含 {} 张卡片，已按笔记去重保留 ord={}（其余卡片跳过，避免重复卡）",
        group.note_id,
        rows.len(),
        rows[0].card_ord
    ));
    Ok(())
}

fn cards_table_has_sched_columns(conn: &Connection) -> Result<bool, AppError> {
    let mut stmt = conn
        .prepare("SELECT name FROM pragma_table_info('cards')")
        .map_err(collection_sql_error)?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(collection_sql_error)?;
    let mut columns = HashSet::new();
    for row in rows {
        columns.insert(row.map_err(collection_sql_error)?);
    }
    Ok(["type", "queue", "due", "ivl", "factor", "reps", "lapses"]
        .iter()
        .all(|column| columns.contains(*column)))
}

fn install_collection_progress_handler(conn: &Connection) {
    let started = Instant::now();
    let mut callbacks = 0usize;
    let _ = conn.progress_handler(
        SQLITE_PROGRESS_OP_INTERVAL,
        Some(move || {
            callbacks = callbacks.saturating_add(1);
            callbacks > SQLITE_MAX_PROGRESS_CALLBACKS || started.elapsed() > SQLITE_QUERY_DEADLINE
        }),
    );
}

fn validate_collection_schema(conn: &Connection) -> Result<(), AppError> {
    for table in ["col", "notes", "cards"] {
        let object_type: Option<String> = conn
            .query_row(
                "SELECT type FROM sqlite_master WHERE name = ?1 LIMIT 1",
                params![table],
                |row| row.get(0),
            )
            .optional()
            .map_err(collection_sql_error)?;
        if object_type.as_deref() != Some("table") {
            return Err(validation_error(
                APKG_ERROR_COLLECTION_INVALID,
                format!("APKG collection object {table} must be a real table"),
            ));
        }
    }

    validate_table_columns(conn, "col", &["models", "decks"], &[])?;
    validate_table_columns(conn, "notes", &["id", "mid", "tags", "flds"], &["id"])?;
    validate_table_columns(conn, "cards", &["id", "nid", "did", "ord"], &["id"])?;
    Ok(())
}

fn validate_table_columns(
    conn: &Connection,
    table: &str,
    required: &[&str],
    required_primary_keys: &[&str],
) -> Result<(), AppError> {
    let mut stmt = conn
        .prepare("SELECT name, pk FROM pragma_table_info(?1)")
        .map_err(collection_sql_error)?;
    let rows = stmt
        .query_map(params![table], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(collection_sql_error)?;
    let mut columns = HashMap::new();
    for row in rows {
        let (name, primary_key_order) = row.map_err(collection_sql_error)?;
        columns.insert(name, primary_key_order);
    }
    for column in required {
        if !columns.contains_key(*column) {
            return Err(validation_error(
                APKG_ERROR_COLLECTION_INVALID,
                format!("APKG collection table {table} is missing required column {column}"),
            ));
        }
    }
    for column in required_primary_keys {
        if columns.get(*column).copied().unwrap_or_default() <= 0 {
            return Err(validation_error(
                APKG_ERROR_COLLECTION_INVALID,
                format!("APKG collection column {table}.{column} must be a primary key"),
            ));
        }
    }
    Ok(())
}

/// 现代 schema（anki21b）：notetypes/fields/decks 为独立表，col.models/decks 不再可用。
fn validate_modern_collection_schema(conn: &Connection) -> Result<(), AppError> {
    for table in ["notes", "cards", "notetypes", "decks", "fields"] {
        let object_type: Option<String> = conn
            .query_row(
                "SELECT type FROM sqlite_master WHERE name = ?1 LIMIT 1",
                params![table],
                |row| row.get(0),
            )
            .optional()
            .map_err(collection_sql_error)?;
        if object_type.as_deref() != Some("table") {
            return Err(validation_error(
                APKG_ERROR_COLLECTION_INVALID,
                format!("APKG collection object {table} must be a real table"),
            ));
        }
    }

    validate_table_columns(conn, "notes", &["id", "mid", "tags", "flds"], &["id"])?;
    validate_table_columns(conn, "cards", &["id", "nid", "did", "ord"], &["id"])?;
    validate_table_columns(conn, "notetypes", &["id", "name", "config"], &["id"])?;
    validate_table_columns(conn, "decks", &["id", "name"], &["id"])?;
    validate_table_columns(conn, "fields", &["ntid", "ord", "name"], &[])?;
    Ok(())
}

/// 从现代 schema 的 notetypes + fields 表重建 ModelDefinition。
/// 模型类型（normal/cloze）取自 notetypes.config 的 protobuf kind 字段。
fn load_modern_models(
    conn: &Connection,
    warnings: &mut Vec<String>,
) -> Result<HashMap<i64, ModelDefinition>, AppError> {
    let mut fields_by_notetype: HashMap<i64, Vec<(i64, String)>> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT ntid, ord, name FROM fields ORDER BY ntid, ord")
            .map_err(collection_sql_error)?;
        let mut rows = stmt.query([]).map_err(collection_sql_error)?;
        while let Some(row) = rows.next().map_err(collection_sql_error)? {
            let notetype_id: i64 = row.get(0).map_err(collection_sql_error)?;
            let ord: i64 = row.get(1).map_err(collection_sql_error)?;
            let name: String = row.get(2).map_err(collection_sql_error)?;
            let entry = fields_by_notetype.entry(notetype_id).or_default();
            if entry.len() >= MAX_FIELDS_PER_MODEL {
                return Err(validation_error(
                    APKG_ERROR_COLLECTION_INVALID,
                    format!("APKG notetype {notetype_id} has too many fields"),
                ));
            }
            entry.push((ord, name));
        }
    }

    let mut models = HashMap::new();
    let mut stmt = conn
        .prepare("SELECT id, name, config FROM notetypes")
        .map_err(collection_sql_error)?;
    let mut rows = stmt.query([]).map_err(collection_sql_error)?;
    while let Some(row) = rows.next().map_err(collection_sql_error)? {
        let model_id: i64 = row.get(0).map_err(collection_sql_error)?;
        let name: String = row.get(1).map_err(collection_sql_error)?;
        let config: Vec<u8> = row.get(2).map_err(collection_sql_error)?;
        let model_type = parse_notetype_kind(&config);

        let mut ordered_fields = fields_by_notetype.remove(&model_id).unwrap_or_default();
        ordered_fields.retain(|(ord, field_name)| {
            *ord >= 0 && (*ord as usize) < MAX_FIELDS_PER_MODEL && !field_name.trim().is_empty()
        });
        ordered_fields.sort_by(|a, b| a.0.cmp(&b.0));
        ordered_fields.dedup_by_key(|(ord, _)| *ord);

        let (field_slot_count, fields_by_ord) = if ordered_fields.is_empty() {
            // 字段表缺失/异常：退化为按位置映射（Front/Back 取前两个字段值），
            // 上限放宽到 MAX_FIELDS_PER_MODEL 以免材料化校验误杀。
            warnings.push(format!(
                "APKG 笔记类型 {name}（{model_id}）缺少字段定义，已按字段位置导入"
            ));
            (MAX_FIELDS_PER_MODEL, HashMap::new())
        } else {
            let slot_count = ordered_fields
                .last()
                .map_or(0, |(ord, _)| *ord as usize + 1);
            (
                slot_count,
                ordered_fields
                    .into_iter()
                    .map(|(ord, field_name)| (ord as usize, field_name))
                    .collect(),
            )
        };

        models.insert(
            model_id,
            ModelDefinition {
                name,
                model_type,
                fields_by_ord,
                field_slot_count,
                // 现代包不携带 Deep Student 模板身份，不臆造 template_id
                template_id: None,
                collapse_cloze_ords: false,
            },
        );
    }
    if models.is_empty() {
        return Err(validation_error(
            APKG_ERROR_COLLECTION_INVALID,
            "APKG collection contains no notetypes",
        ));
    }
    Ok(models)
}

/// 现代 schema decks.name 用 U+001F 分隔层级，转为 Anki 惯用的 `::` 展示形式。
fn load_modern_deck_names(conn: &Connection) -> Result<Vec<String>, AppError> {
    let mut stmt = conn
        .prepare("SELECT name FROM decks")
        .map_err(collection_sql_error)?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(collection_sql_error)?;
    let mut names = Vec::new();
    for row in rows {
        let name = row.map_err(collection_sql_error)?;
        let display = name.replace('\u{1f}', "::");
        if !display.trim().is_empty() {
            names.push(display);
        }
    }
    names.sort();
    names.dedup();
    Ok(names)
}

fn parse_models(
    raw: &str,
) -> Result<(HashMap<i64, ModelDefinition>, Vec<TemplateImportCandidate>), AppError> {
    let values: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(raw).map_err(|error| {
            validation_error(
                APKG_ERROR_COLLECTION_INVALID,
                format!("APKG models metadata is invalid JSON: {error}"),
            )
        })?;
    if values.is_empty() {
        return Err(validation_error(
            APKG_ERROR_COLLECTION_INVALID,
            "APKG models metadata is empty",
        ));
    }

    let mut models = HashMap::with_capacity(values.len());
    let mut template_candidates: Vec<TemplateImportCandidate> = Vec::new();
    let mut seen_template_ids: HashSet<String> = HashSet::new();
    for (key, value) in values {
        let model_id = key
            .parse::<i64>()
            .ok()
            .or_else(|| value.get("id").and_then(serde_json::Value::as_i64))
            .or_else(|| {
                value
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .and_then(|id| id.parse::<i64>().ok())
            })
            .ok_or_else(|| {
                validation_error(
                    APKG_ERROR_COLLECTION_INVALID,
                    format!("APKG model has an invalid id: {key}"),
                )
            })?;
        let raw_model: RawModel = serde_json::from_value(value).map_err(|error| {
            validation_error(
                APKG_ERROR_COLLECTION_INVALID,
                format!("APKG model {model_id} is invalid: {error}"),
            )
        })?;
        if raw_model.fields.is_empty() || raw_model.fields.len() > MAX_FIELDS_PER_MODEL {
            return Err(validation_error(
                APKG_ERROR_COLLECTION_INVALID,
                format!(
                    "APKG model {} has an invalid field count: {}",
                    raw_model.name,
                    raw_model.fields.len()
                ),
            ));
        }
        let template_id = raw_model
            .template_id
            .map(|template_id| template_id.trim().to_string())
            .filter(|template_id| !template_id.is_empty());
        if template_id
            .as_ref()
            .is_some_and(|template_id| template_id.len() > MAX_TEMPLATE_ID_BYTES)
        {
            return Err(limit_error(format!(
                "APKG model {} template ID exceeds the {MAX_TEMPLATE_ID_BYTES} byte limit",
                raw_model.name
            )));
        }
        let collapse_cloze_ords =
            raw_model.model_type == 1 && (raw_model.collapse_cloze_ords || template_id.is_some());
        let mut ordered_fields = raw_model
            .fields
            .into_iter()
            .enumerate()
            .map(|(index, field)| {
                let ord = field.ord.unwrap_or(index as i64);
                (ord, index, field.name)
            })
            .collect::<Vec<_>>();
        if ordered_fields.iter().any(|(ord, _, name)| {
            *ord < 0 || *ord as usize >= MAX_FIELDS_PER_MODEL || name.trim().is_empty()
        }) {
            return Err(validation_error(
                APKG_ERROR_COLLECTION_INVALID,
                format!(
                    "APKG model {} has an invalid field definition",
                    raw_model.name
                ),
            ));
        }
        ordered_fields.sort_by_key(|(ord, index, _)| (*ord, *index));
        let mut seen_ord = HashSet::new();
        if ordered_fields
            .iter()
            .any(|(ord, _, _)| !seen_ord.insert(*ord))
        {
            return Err(validation_error(
                APKG_ERROR_COLLECTION_INVALID,
                format!(
                    "APKG model {} has duplicate field ord values",
                    raw_model.name
                ),
            ));
        }

        // 模板导入候选：仅对携带 Deep Student 模板身份的模型重建模板定义。
        // 外部模型没有可信身份，不臆造 template_id（与卡片映射策略一致）。
        if let Some(candidate_id) = template_id.as_deref() {
            if seen_template_ids.insert(candidate_id.to_string()) {
                let first_template = raw_model.templates.first();
                template_candidates.push(TemplateImportCandidate {
                    template_id: candidate_id.to_string(),
                    name: raw_model.name.clone(),
                    note_type: if raw_model.model_type == 1 {
                        "Cloze".to_string()
                    } else {
                        "Basic".to_string()
                    },
                    fields: ordered_fields
                        .iter()
                        .map(|(_, _, name)| name.clone())
                        .collect(),
                    front_template: first_template
                        .map(|template| template.qfmt.clone())
                        .unwrap_or_default(),
                    back_template: first_template
                        .map(|template| template.afmt.clone())
                        .unwrap_or_default(),
                    css_style: raw_model.css.clone(),
                });
            }
        }

        models.insert(
            model_id,
            ModelDefinition {
                name: raw_model.name,
                model_type: raw_model.model_type,
                template_id,
                collapse_cloze_ords,
                field_slot_count: ordered_fields
                    .last()
                    .map_or(0, |(ord, _, _)| *ord as usize + 1),
                fields_by_ord: ordered_fields
                    .into_iter()
                    .map(|(ord, _, name)| (ord as usize, name))
                    .collect(),
            },
        );
    }
    Ok((models, template_candidates))
}

fn validate_and_estimate_card(
    model: &ModelDefinition,
    raw_tags: &str,
    raw_fields: &str,
) -> Result<usize, AppError> {
    if raw_tags.len() > MAX_RAW_TAG_BYTES {
        return Err(limit_error(format!(
            "APKG tags exceed the {MAX_RAW_TAG_BYTES} byte limit"
        )));
    }

    let mut tag_count = 0usize;
    for tag in raw_tags.split_whitespace() {
        tag_count = tag_count
            .checked_add(1)
            .ok_or_else(|| limit_error("APKG tag count overflow"))?;
        if tag_count > MAX_TAGS_PER_CARD {
            return Err(limit_error(format!(
                "APKG card contains more than {MAX_TAGS_PER_CARD} tags"
            )));
        }
        if tag.len() > MAX_TAG_BYTES {
            return Err(limit_error(format!(
                "APKG tag exceeds the {MAX_TAG_BYTES} byte limit"
            )));
        }
    }

    let mut field_count = 0usize;
    let mut first_field_len = 0usize;
    let mut named_text_len = None;
    let mut extra_key_bytes = 0usize;
    let mut extra_count = 0usize;
    for (index, value) in raw_fields.split('\u{1f}').enumerate() {
        field_count = field_count
            .checked_add(1)
            .ok_or_else(|| limit_error("APKG field count overflow"))?;
        if field_count > MAX_FIELDS_PER_MODEL || field_count > model.field_slot_count {
            return Err(limit_error(format!(
                "APKG note has {field_count} fields but model {} allows at most {}",
                model.name, model.field_slot_count
            )));
        }
        if value.len() > MAX_FIELD_VALUE_BYTES {
            return Err(limit_error(format!(
                "APKG field value exceeds the {MAX_FIELD_VALUE_BYTES} byte limit"
            )));
        }
        if index == 0 {
            first_field_len = value.len();
        }
        let field_name = model.fields_by_ord.get(&index);
        if field_name.is_some_and(|name| name.eq_ignore_ascii_case("Text")) {
            named_text_len = Some(value.len());
        }
        if !field_name.is_some_and(|name| is_core_card_field(model.model_type, name)) {
            extra_count = extra_count
                .checked_add(1)
                .ok_or_else(|| limit_error("APKG extra-field count overflow"))?;
            let key_bytes = field_name.map_or(24, |name| name.len().saturating_add(16));
            extra_key_bytes = extra_key_bytes
                .checked_add(key_bytes)
                .ok_or_else(|| limit_error("APKG field-key size overflow"))?;
        }
    }

    let extra_count = extra_count.saturating_add(6);
    let mut estimate = 1024usize;
    for component in [
        raw_fields.len(),
        raw_tags.len(),
        if model.model_type == 1 {
            named_text_len.unwrap_or(first_field_len)
        } else {
            0
        },
        model.name.len(),
        model.template_id.as_ref().map_or(0, String::len),
        extra_key_bytes,
        field_count.saturating_mul(64),
        tag_count.saturating_mul(64),
        extra_count.saturating_mul(128),
    ] {
        estimate = estimate
            .checked_add(component)
            .ok_or_else(|| limit_error("APKG materialized card size overflow"))?;
    }
    Ok(estimate)
}

fn parse_deck_names(raw: &str) -> Result<Vec<String>, AppError> {
    let values: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(raw).map_err(|error| {
            validation_error(
                APKG_ERROR_COLLECTION_INVALID,
                format!("APKG decks metadata is invalid JSON: {error}"),
            )
        })?;
    let mut names = values
        .values()
        .filter_map(|value| value.get("name").and_then(serde_json::Value::as_str))
        .filter(|name| !name.trim().is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    Ok(names)
}

/// 从字段 HTML/文本中提取媒体引用文件名：`src="..."`、`src='...'` 与 `[sound:...]`。
fn extract_media_filenames(text: &str) -> Vec<String> {
    let mut names = Vec::new();
    let bytes = text.as_bytes();

    let mut search_from = 0usize;
    while let Some(relative) = text[search_from..].find("src=") {
        let quote_index = search_from + relative + 4;
        let Some(&quote) = bytes.get(quote_index) else {
            break;
        };
        if quote == b'"' || quote == b'\'' {
            let value_start = quote_index + 1;
            if let Some(relative_end) = text[value_start..].find(quote as char) {
                let value = &text[value_start..value_start + relative_end];
                if !value.is_empty() {
                    names.push(value.to_string());
                }
                search_from = value_start + relative_end + 1;
                continue;
            }
        }
        search_from = quote_index;
    }

    let mut search_from = 0usize;
    while let Some(relative) = text[search_from..].find("[sound:") {
        let value_start = search_from + relative + "[sound:".len();
        let Some(relative_end) = text[value_start..].find(']') else {
            break;
        };
        let value = &text[value_start..value_start + relative_end];
        if !value.is_empty() {
            names.push(value.to_string());
        }
        search_from = value_start + relative_end + 1;
    }

    names
}

/// 收集卡片字段引用且已成功落盘的媒体绝对路径（去重、保持首次出现顺序）。
fn collect_card_media_paths(
    field_values: &[&str],
    media_paths: &HashMap<String, String>,
) -> Vec<String> {
    if media_paths.is_empty() {
        return Vec::new();
    }
    let mut images = Vec::new();
    let mut seen = HashSet::new();
    for value in field_values {
        for name in extract_media_filenames(value) {
            if let Some(path) = media_paths.get(&name) {
                if seen.insert(path.clone()) {
                    images.push(path.clone());
                }
            }
        }
    }
    images
}

#[allow(clippy::too_many_arguments)]
fn map_card(
    model: &ModelDefinition,
    raw_tags: &str,
    raw_fields: &str,
    note_id: i64,
    card_id: i64,
    card_ord: i64,
    deck_id: i64,
    model_id: i64,
    media_paths: &HashMap<String, String>,
) -> Result<ParsedCard, AppError> {
    let values = raw_fields.split('\u{1f}').collect::<Vec<_>>();
    if let Some(value) = values
        .iter()
        .find(|value| value.len() > MAX_FIELD_VALUE_BYTES)
    {
        return Err(limit_error(format!(
            "APKG field value exceeds the {} byte limit ({} bytes)",
            MAX_FIELD_VALUE_BYTES,
            value.len()
        )));
    }
    let named_value = |name: &str| {
        (0..values.len()).find_map(|index| {
            model
                .fields_by_ord
                .get(&index)
                .filter(|field_name| field_name.eq_ignore_ascii_case(name))
                .map(|_| values[index])
        })
    };
    let front = named_value("Front")
        .or_else(|| values.first().copied())
        .unwrap_or_default()
        .to_string();
    let back = named_value("Back")
        .or_else(|| values.get(1).copied())
        .unwrap_or_default()
        .to_string();
    let text = (model.model_type == 1).then(|| {
        named_value("Text")
            .or_else(|| values.first().copied())
            .unwrap_or_default()
            .to_string()
    });
    let mut extra_fields = HashMap::new();
    for (index, value) in values.iter().enumerate() {
        let base_name = model
            .fields_by_ord
            .get(&index)
            .cloned()
            .unwrap_or_else(|| format!("Field{}", index + 1));
        if is_core_card_field(model.model_type, &base_name) {
            continue;
        }
        let mut name = base_name.clone();
        let mut suffix = 2usize;
        while extra_fields.contains_key(&name) {
            name = format!("{base_name} ({suffix})");
            suffix += 1;
        }
        extra_fields.insert(name, (*value).to_string());
    }
    for (key, value) in [
        ("AnkiNoteId", note_id.to_string()),
        ("AnkiCardId", card_id.to_string()),
        ("AnkiCardOrd", card_ord.to_string()),
        ("AnkiDeckId", deck_id.to_string()),
        ("AnkiModelId", model_id.to_string()),
        ("AnkiModelName", model.name.clone()),
    ] {
        extra_fields.insert(key.to_string(), value);
    }
    let tags = raw_tags
        .split_whitespace()
        .filter(|tag| !tag.is_empty())
        .map(str::to_string)
        .collect();
    let images = collect_card_media_paths(&values, media_paths);
    Ok(ParsedCard {
        front,
        back,
        text,
        tags,
        images,
        extra_fields,
        template_id: model.template_id.clone(),
    })
}

fn is_core_card_field(model_type: i64, name: &str) -> bool {
    name.eq_ignore_ascii_case("Front")
        || name.eq_ignore_ascii_case("Back")
        || (model_type == 1 && name.eq_ignore_ascii_case("Text"))
}

fn persist_package(
    db: &Arc<Database>,
    package: ParsedPackage,
    source_name: &str,
    session_id: Option<&str>,
) -> Result<ApkgImportResult, AppError> {
    let document_id = format!("apkg-{}", Uuid::new_v4());
    let task_id = format!("apkg-task-{}", Uuid::new_v4());
    let now = chrono::Utc::now().to_rfc3339();
    let display_name = safe_source_name(source_name);
    let options = json!({
        "deck_name": package.deck_names.first().cloned().unwrap_or_else(|| "Imported APKG".to_string()),
        "note_type": "Imported",
        "enable_images": false,
        "max_cards_per_mistake": package.cards.len(),
        "segment_overlap_size": 0,
        "source_type": "apkg_import",
        "imported_decks": package.deck_names,
    })
    .to_string();
    let imported_cards = package.cards.len();
    let media_skipped = package.media_skipped;
    let media_imported = package.media_imported;
    let template_candidates = package.template_candidates;
    let mut warnings = package.warnings;
    let mut card_ids = Vec::with_capacity(imported_cards);

    let mut conn = db.get_conn_safe().map_err(|error| {
        database_error(format!(
            "Failed to acquire the target database connection: {error}"
        ))
    })?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| {
            database_error(format!("Failed to start APKG import transaction: {error}"))
        })?;
    tx.execute(
        "INSERT INTO document_tasks (
            id, document_id, original_document_name, segment_index, content_segment,
            status, created_at, updated_at, error_message, anki_generation_options_json,
            source_session_id
         ) VALUES (?1, ?2, ?3, 0, ?4, 'Completed', ?5, ?5, NULL, ?6, ?7)",
        params![
            task_id,
            document_id,
            display_name,
            "Imported from a local APKG package",
            now,
            options,
            session_id
        ],
    )
    .map_err(|error| database_error(format!("Failed to create APKG document task: {error}")))?;

    for (index, card) in package.cards.into_iter().enumerate() {
        let card_id = Uuid::new_v4().to_string();
        let tags_json = serde_json::to_string(&card.tags).map_err(|error| {
            database_error(format!("Failed to serialize imported APKG tags: {error}"))
        })?;
        let images_json = serde_json::to_string(&card.images).map_err(|error| {
            database_error(format!("Failed to serialize imported APKG images: {error}"))
        })?;
        let extra_fields_json = serde_json::to_string(&card.extra_fields).map_err(|error| {
            database_error(format!("Failed to serialize imported APKG fields: {error}"))
        })?;
        tx.execute(
            "INSERT INTO anki_cards (
                id, task_id, front, back, text, tags_json, images_json,
                is_error_card, error_content, card_order_in_task, created_at, updated_at,
                extra_fields_json, template_id, source_type, source_id
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, NULL, ?8, ?9, ?9, ?10,
                       ?11, 'apkg_import', ?12)",
            params![
                card_id,
                task_id,
                card.front,
                card.back,
                card.text,
                tags_json,
                images_json,
                index as i64,
                now,
                extra_fields_json,
                card.template_id,
                document_id,
            ],
        )
        .map_err(|error| {
            database_error(format!(
                "Failed to insert APKG card {} of {}: {error}",
                index + 1,
                imported_cards
            ))
        })?;
        card_ids.push(card_id);
    }
    tx.commit().map_err(|error| {
        database_error(format!("Failed to commit APKG import transaction: {error}"))
    })?;

    // 模板映射导入（卡片事务成功后执行，失败不回滚卡片、只产生结构化告警）：
    // 仅补建本地缺失、且包内携带 deepStudentTemplateId 的模板。
    let imported_templates = import_template_candidates(db, &template_candidates, &mut warnings);

    Ok(ApkgImportResult {
        document_id,
        imported_cards,
        imported_templates,
        media_skipped,
        media_imported,
        warnings,
        card_ids,
    })
}

/// 补建本地缺失的 Deep Student 模板；返回成功创建数。
/// 名称冲突（custom_anki_templates.name UNIQUE）等失败降级为告警。
fn import_template_candidates(
    db: &Arc<Database>,
    candidates: &[TemplateImportCandidate],
    warnings: &mut Vec<String>,
) -> usize {
    let mut imported = 0usize;
    for candidate in candidates {
        match db.get_custom_template_by_id(&candidate.template_id) {
            Ok(Some(_)) => continue, // 本地已有同 id 模板：以本地为准，不覆盖
            Ok(None) => {}
            Err(error) => {
                warnings.push(format!(
                    "查询本地模板失败，跳过模板导入 {}: {error}",
                    candidate.template_id
                ));
                continue;
            }
        }
        if candidate.front_template.trim().is_empty()
            || candidate.back_template.trim().is_empty()
            || candidate.fields.is_empty()
        {
            warnings.push(format!(
                "APKG 模型缺少可用的模板正反面/字段定义，跳过模板导入: {}",
                candidate.template_id
            ));
            continue;
        }
        let request = crate::models::CreateTemplateRequest {
            name: candidate.name.clone(),
            description: "Imported from an APKG package".to_string(),
            author: None,
            version: Some("1.0.0".to_string()),
            preview_front: String::new(),
            preview_back: String::new(),
            note_type: candidate.note_type.clone(),
            fields: candidate.fields.clone(),
            generation_prompt: String::new(),
            front_template: candidate.front_template.clone(),
            back_template: candidate.back_template.clone(),
            css_style: candidate.css_style.clone(),
            field_extraction_rules: HashMap::new(),
            preview_data_json: None,
            is_active: Some(true),
            is_built_in: Some(false),
        };
        match db.create_custom_template_with_id(&candidate.template_id, &request) {
            Ok(_) => imported += 1,
            Err(error) => {
                warn!(
                    "APKG 模板导入失败 {} ({}): {}",
                    candidate.template_id, candidate.name, error
                );
                warnings.push(format!(
                    "模板导入失败（可能与现有模板重名）{}: {error}",
                    candidate.template_id
                ));
            }
        }
    }
    imported
}

fn safe_source_name(source_name: &str) -> String {
    let name = Path::new(source_name)
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("imported.apkg");
    name.chars().take(255).collect()
}

fn collection_sql_error(error: rusqlite::Error) -> AppError {
    if matches!(
        &error,
        rusqlite::Error::SqliteFailure(inner, _)
            if inner.code == rusqlite::ErrorCode::OperationInterrupted
    ) {
        return limit_error("APKG collection query exceeded its CPU or elapsed-time budget");
    }
    validation_error(
        APKG_ERROR_COLLECTION_INVALID,
        format!("Invalid or unsupported APKG collection schema: {error}"),
    )
}

fn app_error(error_type: AppErrorType, code: &'static str, message: impl Into<String>) -> AppError {
    AppError::with_details(error_type, message, json!({ "errorCode": code }))
}

fn validation_error(code: &'static str, message: impl Into<String>) -> AppError {
    app_error(AppErrorType::Validation, code, message)
}

fn file_error(message: impl Into<String>) -> AppError {
    app_error(AppErrorType::FileSystem, APKG_ERROR_IO, message)
}

fn limit_error(message: impl Into<String>) -> AppError {
    validation_error(APKG_ERROR_LIMIT_EXCEEDED, message)
}

fn database_error(message: impl Into<String>) -> AppError {
    app_error(AppErrorType::Database, APKG_ERROR_DATABASE, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::{
        AnkiRetemplateBatchResult, AnkiRetemplateSelector, AnkiRetemplateTarget,
    };
    use crate::fsrs_review_service::FsrsReviewService;
    use crate::models::AnkiCard;
    use rusqlite::params;
    use std::io::Write;
    use tempfile::{tempdir, TempDir};
    use zip::write::FileOptions;
    use zip::ZipWriter;

    fn setup_migrated_db() -> (Arc<Database>, TempDir) {
        use crate::data_governance::migration::coordinator::MigrationCoordinator;
        use crate::data_governance::schema_registry::DatabaseId;

        let dir = tempdir().expect("tempdir");
        let mut coordinator =
            MigrationCoordinator::new(dir.path().to_path_buf()).with_audit_db(None);
        coordinator
            .migrate_single(DatabaseId::Mistakes)
            .expect("mistakes migrations");
        let db = Arc::new(Database::new(&dir.path().join("mistakes.db")).expect("database"));
        (db, dir)
    }

    fn setup_unmigrated_db() -> (Arc<Database>, TempDir) {
        let dir = tempdir().expect("tempdir");
        let db = Arc::new(Database::new(&dir.path().join("empty.db")).expect("database"));
        (db, dir)
    }

    fn model_json(model_type: i64, fields: &[(&str, i64)]) -> serde_json::Value {
        json!({
            "name": if model_type == 1 { "Cloze" } else { "Basic" },
            "type": model_type,
            "flds": fields
                .iter()
                .map(|(name, ord)| json!({ "name": name, "ord": ord }))
                .collect::<Vec<_>>()
        })
    }

    #[test]
    fn basic_text_field_remains_an_extra_field_but_cloze_text_is_core_only() {
        let basic_model = ModelDefinition {
            name: "Basic with Text".to_string(),
            model_type: 0,
            fields_by_ord: HashMap::from([
                (0, "Front".to_string()),
                (1, "Text".to_string()),
                (2, "Back".to_string()),
            ]),
            field_slot_count: 3,
            template_id: Some("basic-text".to_string()),
            collapse_cloze_ords: false,
        };
        let basic = map_card(
            &basic_model,
            "",
            "question\u{1f}supplementary text\u{1f}answer",
            1,
            10,
            0,
            1,
            100,
            &HashMap::new(),
        )
        .expect("map Basic note with custom Text field");
        assert_eq!(basic.front, "question");
        assert_eq!(basic.back, "answer");
        assert_eq!(basic.text, None);
        assert_eq!(
            basic.extra_fields.get("Text").map(String::as_str),
            Some("supplementary text")
        );

        let cloze_model = ModelDefinition {
            name: "Cloze".to_string(),
            model_type: 1,
            fields_by_ord: HashMap::from([(0, "Text".to_string()), (1, "Extra".to_string())]),
            field_slot_count: 2,
            template_id: Some("cloze-text".to_string()),
            collapse_cloze_ords: true,
        };
        let cloze = map_card(
            &cloze_model,
            "",
            "A {{c1::cloze}} note\u{1f}context",
            2,
            20,
            0,
            1,
            200,
            &HashMap::new(),
        )
        .expect("map Cloze Text field");
        assert_eq!(cloze.text.as_deref(), Some("A {{c1::cloze}} note"));
        assert!(!cloze.extra_fields.contains_key("Text"));
        assert_eq!(
            cloze.extra_fields.get("Extra").map(String::as_str),
            Some("context")
        );
    }

    fn custom_template(
        id: &str,
        note_type: &str,
        fields: &[&str],
    ) -> crate::models::CustomAnkiTemplate {
        let now = chrono::Utc::now();
        let is_cloze = note_type.eq_ignore_ascii_case("Cloze");
        crate::models::CustomAnkiTemplate {
            id: id.to_string(),
            name: format!("Round-trip {id}"),
            description: "APKG round-trip fixture".to_string(),
            author: Some("Deep Student".to_string()),
            version: "1.0.0".to_string(),
            preview_front: String::new(),
            preview_back: String::new(),
            note_type: note_type.to_string(),
            fields: fields.iter().map(|field| (*field).to_string()).collect(),
            generation_prompt: String::new(),
            front_template: if is_cloze {
                "{{cloze:Text}}".to_string()
            } else {
                "{{Question}}".to_string()
            },
            back_template: if is_cloze {
                "{{cloze:Text}}<br>{{Extra}}".to_string()
            } else {
                "{{Question}}<br>{{Extra}}".to_string()
            },
            css_style: ".card { font-family: sans-serif; }".to_string(),
            field_extraction_rules: HashMap::new(),
            created_at: now,
            updated_at: now,
            is_active: true,
            is_built_in: true,
            preview_data_json: None,
        }
    }

    fn make_collection(
        models: serde_json::Value,
        notes: &[(i64, i64, &str, &str)],
        cards: &[(i64, i64, i64)],
    ) -> Vec<u8> {
        let file = NamedTempFile::new().expect("collection tempfile");
        let conn = Connection::open(file.path()).expect("collection sqlite");
        conn.execute_batch(
            "PRAGMA journal_mode = DELETE;
             CREATE TABLE col (models TEXT NOT NULL, decks TEXT NOT NULL);
             CREATE TABLE notes (
                 id INTEGER PRIMARY KEY, mid INTEGER NOT NULL, tags TEXT NOT NULL, flds TEXT NOT NULL
             );
             CREATE TABLE cards (
                 id INTEGER PRIMARY KEY, nid INTEGER NOT NULL, did INTEGER NOT NULL, ord INTEGER NOT NULL
             );",
        )
        .expect("collection schema");
        conn.execute(
            "INSERT INTO col (models, decks) VALUES (?1, ?2)",
            params![
                models.to_string(),
                json!({ "1": { "name": "Imported" } }).to_string()
            ],
        )
        .expect("collection col");
        for (id, mid, tags, fields) in notes {
            conn.execute(
                "INSERT INTO notes (id, mid, tags, flds) VALUES (?1, ?2, ?3, ?4)",
                params![id, mid, tags, fields],
            )
            .expect("collection note");
        }
        for (id, nid, ord) in cards {
            conn.execute(
                "INSERT INTO cards (id, nid, did, ord) VALUES (?1, ?2, 1, ?3)",
                params![id, nid, ord],
            )
            .expect("collection card");
        }
        conn.close().expect("close collection sqlite");
        std::fs::read(file.path()).expect("read collection sqlite")
    }

    fn make_view_backed_collection() -> Vec<u8> {
        let file = NamedTempFile::new().expect("collection tempfile");
        let conn = Connection::open(file.path()).expect("collection sqlite");
        let models = json!({ "100": model_json(0, &[("Front", 0), ("Back", 1)]) });
        conn.execute_batch(
            "PRAGMA journal_mode = DELETE;
             CREATE TABLE col (models TEXT NOT NULL, decks TEXT NOT NULL);
             CREATE TABLE notes (
                 id INTEGER PRIMARY KEY, mid INTEGER NOT NULL, tags TEXT NOT NULL, flds TEXT NOT NULL
             );
             CREATE TABLE card_rows (
                 id INTEGER PRIMARY KEY, nid INTEGER NOT NULL, did INTEGER NOT NULL, ord INTEGER NOT NULL
             );
             CREATE VIEW cards AS SELECT id, nid, did, ord FROM card_rows;",
        )
        .expect("view-backed schema");
        conn.execute(
            "INSERT INTO col (models, decks) VALUES (?1, '{}')",
            params![models.to_string()],
        )
        .expect("collection col");
        conn.execute(
            "INSERT INTO notes (id, mid, tags, flds) VALUES (1, 100, '', ?1)",
            params!["front\u{1f}back"],
        )
        .expect("collection note");
        conn.execute(
            "INSERT INTO card_rows (id, nid, did, ord) VALUES (10, 1, 1, 0)",
            [],
        )
        .expect("collection card");
        conn.close().expect("close collection sqlite");
        std::fs::read(file.path()).expect("read collection sqlite")
    }

    fn make_basic_collection(front: &str) -> Vec<u8> {
        make_collection(
            json!({ "100": model_json(0, &[("Front", 0), ("Back", 1)]) }),
            &[(1, 100, "", &format!("{front}\u{1f}back"))],
            &[(10, 1, 0)],
        )
    }

    fn make_mixed_collection() -> Vec<u8> {
        make_collection(
            json!({
                "100": model_json(0, &[("ExtraField", 2), ("bAcK", 1), ("fRoNt", 0)]),
                "200": model_json(1, &[("tExT", 0), ("Extra", 1), ("Source", 2)])
            }),
            &[
                (
                    1,
                    100,
                    "tag-one tag-two",
                    "basic front\u{1f}basic back\u{1f}detail",
                ),
                (
                    2,
                    200,
                    "cloze-tag",
                    "A {{c1::cloze}} note\u{1f}context\u{1f}book",
                ),
            ],
            &[(10, 1, 0), (11, 1, 1), (12, 2, 0)],
        )
    }

    fn make_apkg(entries: Vec<(&str, Vec<u8>)>) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut writer = ZipWriter::new(cursor);
        for (name, bytes) in entries {
            writer
                .start_file(name, FileOptions::default())
                .expect("start zip entry");
            writer.write_all(&bytes).expect("write zip entry");
        }
        writer.finish().expect("finish zip").into_inner()
    }

    fn error_code(error: &AppError) -> Option<&str> {
        error
            .details
            .as_ref()
            .and_then(|details| details.get("errorCode"))
            .and_then(serde_json::Value::as_str)
    }

    fn card(front: &str, back: &str, tags: Vec<&str>) -> AnkiCard {
        let now = chrono::Utc::now().to_rfc3339();
        AnkiCard {
            front: front.to_string(),
            back: back.to_string(),
            text: None,
            tags: tags.into_iter().map(str::to_string).collect(),
            images: Vec::new(),
            id: Uuid::new_v4().to_string(),
            task_id: String::new(),
            is_error_card: false,
            error_content: None,
            created_at: now.clone(),
            updated_at: now,
            extra_fields: HashMap::new(),
            template_id: None,
        }
    }

    #[tokio::test]
    async fn exporter_round_trip_preserves_basic_cards_without_media() {
        let (db, _dir) = setup_migrated_db();
        let output_dir = tempdir().expect("output tempdir");
        let output = output_dir.path().join("roundtrip.apkg");
        crate::apkg_exporter_service::export_multi_template_apkg(
            vec![
                card("front one", "back one", vec!["alpha", "beta"]),
                card("front two", "back two", vec!["gamma"]),
            ],
            "Roundtrip".to_string(),
            output.clone(),
            HashMap::new(),
        )
        .await
        .expect("export APKG");

        let result = ApkgImporterService::new(db.clone())
            .import_path(&output, Some("roundtrip-session"))
            .expect("import APKG");
        assert_eq!(result.imported_cards, 2);
        assert_eq!(result.imported_templates, 0);
        assert_eq!(result.media_skipped, 0);
        assert_eq!(result.card_ids.len(), 2);
        assert!(db
            .is_document_owned_by_session(&result.document_id, "roundtrip-session")
            .expect("ownership"));
        let imported = db
            .get_cards_for_document(&result.document_id)
            .expect("imported cards");
        assert_eq!(imported.len(), 2);
        assert_eq!(imported[0].front, "front one");
        assert_eq!(imported[0].back, "back one");
        assert_eq!(imported[0].tags, vec!["alpha", "beta"]);
        assert_eq!(imported[1].front, "front two");
        assert_eq!(imported[1].back, "back two");
        assert_eq!(imported[1].tags, vec!["gamma"]);
        assert!(imported.iter().all(|card| card.template_id.is_none()));
    }

    #[tokio::test]
    async fn single_template_cloze_round_trip_materializes_one_internal_card_per_note() {
        let (db, _dir) = setup_migrated_db();
        let output_dir = tempdir().expect("output tempdir");
        let output = output_dir.path().join("single-cloze-roundtrip.apkg");
        let template = custom_template("design-single-cloze", "Cloze", &["Text", "Extra"]);
        let template_config = Some((
            template.name.clone(),
            template.fields.clone(),
            template.front_template.clone(),
            template.back_template.clone(),
            template.css_style.clone(),
        ));
        let mut cloze = card("cloze front", "cloze extra", vec!["cloze-tag"]);
        cloze.template_id = Some(template.id.clone());
        cloze.text = Some(
            "{{c1::Mass}} resists {{c2::acceleration}} according to {{c3::Newton's second law}}."
                .to_string(),
        );

        crate::apkg_exporter_service::export_cards_to_apkg_with_full_template(
            vec![cloze],
            "Single Cloze round trip".to_string(),
            "Cloze".to_string(),
            output.clone(),
            template_config,
            Some(template),
        )
        .await
        .expect("export single-template Cloze APKG");

        let result = ApkgImporterService::new(db.clone())
            .import_path(&output, Some("single-cloze-import"))
            .expect("import single-template Cloze APKG");
        assert_eq!(result.imported_cards, 1);
        assert_eq!(result.card_ids.len(), 1);
        let imported = db
            .get_cards_for_document(&result.document_id)
            .expect("load imported Cloze note");
        assert_eq!(imported.len(), 1);
        assert_eq!(
            imported[0].template_id.as_deref(),
            Some("design-single-cloze")
        );
        assert_eq!(
            imported[0].text.as_deref(),
            Some(
                "{{c1::Mass}} resists {{c2::acceleration}} according to {{c3::Newton's second law}}."
            )
        );
        assert_eq!(
            imported[0]
                .extra_fields
                .get("AnkiCardOrd")
                .map(String::as_str),
            Some("0")
        );
    }

    #[tokio::test]
    async fn multi_template_export_import_round_trip_preserves_fields_and_template_ids() {
        let basic_template = custom_template(
            "design-lab",
            "Basic",
            &[
                "Subject",
                "Question",
                "optiona",
                "optionb",
                "optionc",
                "optiond",
                "optione",
                "correct",
                "explanation",
            ],
        );
        let redaction_template =
            custom_template("design-redaction", "Cloze", &["Header", "Text", "Extra"]);
        let glass_template =
            custom_template("design-glass", "Cloze", &["Subject", "Text", "Extra"]);
        let templates = HashMap::from([
            (basic_template.id.clone(), basic_template),
            (redaction_template.id.clone(), redaction_template),
            (glass_template.id.clone(), glass_template),
        ]);

        let mut basic = card("basic front", "basic back", vec!["basic-tag"]);
        basic.template_id = Some("design-lab".to_string());
        basic.extra_fields = HashMap::from([
            ("Subject".to_string(), "Physics".to_string()),
            ("Question".to_string(), "What is inertia?".to_string()),
            (
                "optiona".to_string(),
                "Resistance to acceleration".to_string(),
            ),
            ("optionb".to_string(), "A unit of energy".to_string()),
            ("optionc".to_string(), "A type of force".to_string()),
            ("optiond".to_string(), "A reference frame".to_string()),
            ("correct".to_string(), "A".to_string()),
            ("explanation".to_string(), "Newton's first law".to_string()),
        ]);

        let mut cloze = card("cloze front", "cloze back", vec!["cloze-tag"]);
        cloze.template_id = Some("design-redaction".to_string());
        cloze.text = Some(
            "{{c1::Mass}} resists {{c2::acceleration}} under {{c3::Newton's second law}}."
                .to_string(),
        );
        cloze.extra_fields = HashMap::from([
            ("Header".to_string(), "CLASSIFIED / MECHANICS".to_string()),
            ("Extra".to_string(), "Inertial mass".to_string()),
        ]);

        let mut glass = card("glass front", "glass back", vec!["glass-tag"]);
        glass.template_id = Some("design-glass".to_string());
        glass.text = Some("Energy is {{c1::conserved}} in a closed system.".to_string());
        glass.extra_fields = HashMap::from([
            ("Subject".to_string(), "Thermodynamics".to_string()),
            ("Extra".to_string(), "First law".to_string()),
        ]);

        let output_dir = tempdir().expect("output tempdir");
        let first_output = output_dir.path().join("multi-template.apkg");
        crate::apkg_exporter_service::export_multi_template_apkg(
            vec![basic, cloze, glass],
            "Multi-template round trip".to_string(),
            first_output.clone(),
            templates.clone(),
        )
        .await
        .expect("export mixed-template APKG");

        let (first_db, _first_dir) = setup_migrated_db();
        let first_result = ApkgImporterService::new(first_db.clone())
            .import_path(&first_output, Some("first-import"))
            .expect("import mixed-template APKG");
        assert_eq!(first_result.imported_cards, 3);
        // 携带 deepStudentTemplateId 的模型在本地缺失时会被补建为自定义模板
        assert_eq!(first_result.imported_templates, 3);
        for template_id in ["design-lab", "design-redaction", "design-glass"] {
            assert!(
                first_db
                    .get_custom_template_by_id(template_id)
                    .expect("query imported template")
                    .is_some(),
                "template {template_id} must be recreated locally"
            );
        }
        let first_cards = first_db
            .get_cards_for_document(&first_result.document_id)
            .expect("load first imported cards");
        assert_round_trip_cards(&first_cards);

        let second_output = output_dir.path().join("multi-template-reexport.apkg");
        crate::apkg_exporter_service::export_multi_template_apkg(
            first_cards,
            "Direct re-export".to_string(),
            second_output.clone(),
            templates,
        )
        .await
        .expect("re-export imported cards without retemplate");

        let (second_db, _second_dir) = setup_migrated_db();
        let second_result = ApkgImporterService::new(second_db.clone())
            .import_path(&second_output, Some("second-import"))
            .expect("import directly re-exported APKG");
        assert_eq!(second_result.imported_cards, 3);
        // 第二个全新库同样缺这 3 个模板，再次补建
        assert_eq!(second_result.imported_templates, 3);
        let second_cards = second_db
            .get_cards_for_document(&second_result.document_id)
            .expect("load second imported cards");
        assert_round_trip_cards(&second_cards);
    }

    fn assert_round_trip_cards(cards: &[AnkiCard]) {
        assert_eq!(
            cards.len(),
            3,
            "one internal card must survive per exported note"
        );
        let basic = cards
            .iter()
            .find(|card| card.template_id.as_deref() == Some("design-lab"))
            .expect("Basic template identity");
        assert_eq!(basic.front, "basic front");
        assert_eq!(basic.back, "basic back");
        assert_eq!(
            basic.extra_fields.get("Subject").map(String::as_str),
            Some("Physics")
        );
        assert_eq!(
            basic.extra_fields.get("Question").map(String::as_str),
            Some("What is inertia?")
        );
        assert_eq!(
            basic.extra_fields.get("explanation").map(String::as_str),
            Some("Newton's first law")
        );

        let cloze = cards
            .iter()
            .find(|card| card.template_id.as_deref() == Some("design-redaction"))
            .expect("Cloze template identity");
        assert_eq!(cloze.front, "cloze front");
        assert_eq!(cloze.back, "cloze back");
        assert_eq!(
            cloze.text.as_deref(),
            Some("{{c1::Mass}} resists {{c2::acceleration}} under {{c3::Newton's second law}}.")
        );
        for marker in [
            "{{c1::Mass}}",
            "{{c2::acceleration}}",
            "{{c3::Newton's second law}}",
        ] {
            assert!(cloze
                .text
                .as_deref()
                .is_some_and(|text| text.contains(marker)));
        }
        assert_eq!(
            cloze.extra_fields.get("Header").map(String::as_str),
            Some("CLASSIFIED / MECHANICS")
        );
        assert_eq!(
            cloze.extra_fields.get("Extra").map(String::as_str),
            Some("Inertial mass")
        );

        let glass = cards
            .iter()
            .find(|card| card.template_id.as_deref() == Some("design-glass"))
            .expect("second Cloze template identity");
        assert_eq!(glass.front, "glass front");
        assert_eq!(glass.back, "glass back");
        assert_eq!(
            glass.text.as_deref(),
            Some("Energy is {{c1::conserved}} in a closed system.")
        );
        assert!(glass
            .text
            .as_deref()
            .is_some_and(|text| text.contains("{{c1::conserved}}")));
        assert_eq!(
            glass.extra_fields.get("Subject").map(String::as_str),
            Some("Thermodynamics")
        );
        assert_eq!(
            glass.extra_fields.get("Extra").map(String::as_str),
            Some("First law")
        );
    }

    #[test]
    fn imports_basic_cloze_and_every_card_row_with_session_ownership() {
        let (db, _dir) = setup_migrated_db();
        let apkg = make_apkg(vec![
            ("collection.anki2", make_mixed_collection()),
            ("media", br#"{"0":"picture.png","1":"sound.mp3"}"#.to_vec()),
            ("0", b"ignored media".to_vec()),
        ]);
        let result = ApkgImporterService::new(db.clone())
            .import_bytes(&apkg, Some("mixed.apkg"), Some("owner-session"))
            .expect("import mixed APKG");

        assert_eq!(result.imported_cards, 3);
        assert_eq!(result.card_ids.len(), 3);
        assert_eq!(result.card_ids.iter().collect::<HashSet<_>>().len(), 3);
        assert_eq!(result.imported_templates, 0);
        assert_eq!(result.media_skipped, 2);
        assert!(db
            .is_document_owned_by_session(&result.document_id, "owner-session")
            .expect("owner check"));
        assert!(!db
            .is_document_owned_by_session(&result.document_id, "other-session")
            .expect("other owner check"));

        let imported = db
            .get_cards_for_document(&result.document_id)
            .expect("imported cards");
        assert_eq!(imported.len(), 3, "each Anki cards row must survive");
        assert!(
            imported.iter().all(|card| card.template_id.is_none()),
            "external models without Deep Student metadata must not invent template IDs"
        );
        assert_eq!(imported[0].front, "basic front");
        assert_eq!(imported[0].back, "basic back");
        assert_eq!(imported[0].tags, vec!["tag-one", "tag-two"]);
        assert_eq!(
            imported[0].extra_fields.get("ExtraField"),
            Some(&"detail".to_string())
        );
        // 外部模型同 note 两张卡（ord 0/1）按 reversed 模式导入：第二张交换正反面
        assert_eq!(imported[1].front, imported[0].back);
        assert_eq!(imported[1].back, imported[0].front);
        assert_ne!(
            imported[0].extra_fields.get("AnkiCardId"),
            imported[1].extra_fields.get("AnkiCardId")
        );
        assert_eq!(
            imported[0].extra_fields.get("AnkiCardOrd"),
            Some(&"0".to_string())
        );
        assert_eq!(
            imported[1].extra_fields.get("AnkiCardOrd"),
            Some(&"1".to_string())
        );
        assert_eq!(
            imported[0].extra_fields.get("AnkiNoteId"),
            imported[1].extra_fields.get("AnkiNoteId")
        );
        assert_eq!(imported[2].text.as_deref(), Some("A {{c1::cloze}} note"));
        assert_eq!(imported[2].back, "context");
        assert_eq!(
            imported[2].extra_fields.get("Source"),
            Some(&"book".to_string())
        );

        let conn = db.get_conn_safe().expect("target connection");
        let provenance_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM anki_cards
                 WHERE source_type = 'apkg_import' AND source_id = ?1",
                params![result.document_id],
                |row| row.get(0),
            )
            .expect("provenance count");
        assert_eq!(provenance_count, 3);
    }

    #[test]
    fn external_cloze_note_without_deep_student_metadata_keeps_each_card_row() {
        let (db, _dir) = setup_migrated_db();
        let collection = make_collection(
            json!({
                "200": model_json(1, &[("Text", 0), ("Extra", 1)])
            }),
            &[(
                2,
                200,
                "external-cloze",
                "{{c1::one}} {{c2::two}} {{c3::three}}\u{1f}context",
            )],
            &[(20, 2, 0), (21, 2, 1), (22, 2, 2)],
        );
        let apkg = make_apkg(vec![("collection.anki2", collection)]);
        let result = ApkgImporterService::new(db.clone())
            .import_bytes(
                &apkg,
                Some("external-multi-ord.apkg"),
                Some("external-session"),
            )
            .expect("import external multi-ord Cloze APKG");

        assert_eq!(result.imported_cards, 3);
        let imported = db
            .get_cards_for_document(&result.document_id)
            .expect("load external Cloze cards");
        assert_eq!(imported.len(), 3);
        assert!(imported.iter().all(|card| card.template_id.is_none()));
        assert!(imported
            .iter()
            .all(|card| { card.text.as_deref() == Some("{{c1::one}} {{c2::two}} {{c3::three}}") }));
        let mut ords = imported
            .iter()
            .filter_map(|card| card.extra_fields.get("AnkiCardOrd"))
            .cloned()
            .collect::<Vec<_>>();
        ords.sort();
        assert_eq!(ords, vec!["0", "1", "2"]);
    }

    #[test]
    fn anki21_is_preferred_and_zstd_collection_is_supported() {
        let (db, _dir) = setup_migrated_db();
        let preferred = make_basic_collection("preferred anki21");
        let compressed = zstd::stream::encode_all(Cursor::new(preferred), 1).expect("zstd");
        let apkg = make_apkg(vec![
            ("collection.anki2", make_basic_collection("fallback anki2")),
            ("collection.anki21", compressed),
            ("media", b"{}".to_vec()),
        ]);
        let result = ApkgImporterService::new(db.clone())
            .import_bytes(&apkg, Some("modern.apkg"), None)
            .expect("import preferred collection");
        let cards = db
            .get_cards_for_document(&result.document_id)
            .expect("imported cards");
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].front, "preferred anki21");
        assert!(db
            .get_document_session_source(&result.document_id)
            .expect("session source")
            .is_none());
    }

    /// 构造现代 schema（anki21b）集合库：notetypes/fields/decks 为独立表，
    /// cards 携带调度列，notetype config 用最小 protobuf（kind 字段）。
    fn make_modern_collection(
        notetypes: &[(i64, &str, i64, &[&str])],
        notes: &[(i64, i64, &str, &str)],
        cards: &[(i64, i64, i64, [i64; 7])],
    ) -> Vec<u8> {
        let file = NamedTempFile::new().expect("collection tempfile");
        let conn = Connection::open(file.path()).expect("collection sqlite");
        conn.execute_batch(
            "PRAGMA journal_mode = DELETE;
             CREATE TABLE notes (
                 id INTEGER PRIMARY KEY, mid INTEGER NOT NULL, tags TEXT NOT NULL, flds TEXT NOT NULL
             );
             CREATE TABLE cards (
                 id INTEGER PRIMARY KEY, nid INTEGER NOT NULL, did INTEGER NOT NULL, ord INTEGER NOT NULL,
                 type INTEGER NOT NULL DEFAULT 0, queue INTEGER NOT NULL DEFAULT 0,
                 due INTEGER NOT NULL DEFAULT 0, ivl INTEGER NOT NULL DEFAULT 0,
                 factor INTEGER NOT NULL DEFAULT 0, reps INTEGER NOT NULL DEFAULT 0,
                 lapses INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE notetypes (id INTEGER PRIMARY KEY, name TEXT NOT NULL, config BLOB NOT NULL);
             CREATE TABLE decks (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
             CREATE TABLE fields (
                 ntid INTEGER NOT NULL, ord INTEGER NOT NULL, name TEXT NOT NULL,
                 PRIMARY KEY (ntid, ord)
             );",
        )
        .expect("modern schema");
        conn.execute(
            "INSERT INTO decks (id, name) VALUES (1, ?1)",
            params!["Parent\u{1f}Child"],
        )
        .expect("modern deck");
        for (id, name, kind, fields) in notetypes {
            let config: Vec<u8> = if *kind == 1 {
                vec![0x08, 0x01]
            } else {
                Vec::new()
            };
            conn.execute(
                "INSERT INTO notetypes (id, name, config) VALUES (?1, ?2, ?3)",
                params![id, name, config],
            )
            .expect("modern notetype");
            for (ord, field_name) in fields.iter().enumerate() {
                conn.execute(
                    "INSERT INTO fields (ntid, ord, name) VALUES (?1, ?2, ?3)",
                    params![id, ord as i64, field_name],
                )
                .expect("modern field");
            }
        }
        for (id, mid, tags, fields) in notes {
            conn.execute(
                "INSERT INTO notes (id, mid, tags, flds) VALUES (?1, ?2, ?3, ?4)",
                params![id, mid, tags, fields],
            )
            .expect("modern note");
        }
        for (id, nid, ord, sched) in cards {
            conn.execute(
                "INSERT INTO cards (id, nid, did, ord, type, queue, due, ivl, factor, reps, lapses)
                 VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    id, nid, ord, sched[0], sched[1], sched[2], sched[3], sched[4], sched[5],
                    sched[6]
                ],
            )
            .expect("modern card");
        }
        conn.close().expect("close modern collection sqlite");
        std::fs::read(file.path()).expect("read modern collection sqlite")
    }

    /// 手工编码 protobuf MediaEntries（每条 entry 含 name=field1 + size=field2）。
    fn encode_media_entries(names: &[&str]) -> Vec<u8> {
        let mut out = Vec::new();
        for name in names {
            let name_bytes = name.as_bytes();
            let mut entry = Vec::new();
            entry.push(0x0a); // MediaEntry.name (field 1, wire 2)
            entry.push(name_bytes.len() as u8);
            entry.extend_from_slice(name_bytes);
            entry.push(0x10); // MediaEntry.size (field 2, varint) — 应被解码器跳过
            entry.push(0x05);
            out.push(0x0a); // MediaEntries.entries (field 1, wire 2)
            out.push(entry.len() as u8);
            out.extend_from_slice(&entry);
        }
        out
    }

    #[test]
    fn modern_anki21b_package_imports_cards_media_and_schedule() {
        let (db, _dir) = setup_migrated_db();
        let media_dir = tempdir().expect("media dir");
        let collection = make_modern_collection(
            &[
                (100, "Basic", 0, &["Front", "Back"][..]),
                (200, "Cloze", 1, &["Text", "Extra"][..]),
            ],
            &[
                (
                    1,
                    100,
                    " geo ",
                    "capital of France? <img src=\"map.png\">\u{1f}Paris",
                ),
                (2, 200, "", "A {{c1::cloze}} note\u{1f}extra"),
            ],
            &[
                (10, 1, 0, [2, 2, 5, 12, 2500, 7, 1]),
                (20, 2, 0, [0, 0, 0, 0, 0, 0, 0]),
            ],
        );
        let compressed =
            zstd::stream::encode_all(Cursor::new(collection), 1).expect("zstd collection");
        let manifest = zstd::stream::encode_all(Cursor::new(encode_media_entries(&["map.png"])), 1)
            .expect("zstd manifest");
        let media_blob =
            zstd::stream::encode_all(Cursor::new(b"png-bytes".to_vec()), 1).expect("zstd media");
        let apkg = make_apkg(vec![
            (
                "collection.anki2",
                make_basic_collection("please upgrade placeholder"),
            ),
            ("collection.anki21b", compressed),
            ("media", manifest),
            ("0", media_blob),
        ]);

        let result = ApkgImporterService::new(db.clone())
            .with_media_dir(media_dir.path().to_path_buf())
            .import_bytes(&apkg, Some("modern.apkg"), Some("modern-session"))
            .expect("import modern anki21b package");

        assert_eq!(result.imported_cards, 2);
        assert_eq!(result.media_imported, 1);
        assert_eq!(result.media_skipped, 0);
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("复习进度")));
        let extracted = media_dir.path().join("map.png");
        assert_eq!(
            std::fs::read(&extracted).expect("extracted media"),
            b"png-bytes",
            "现代包媒体条目必须先做 zstd 解压再落盘"
        );

        let imported = db
            .get_cards_for_document(&result.document_id)
            .expect("imported cards");
        assert_eq!(imported.len(), 2);
        assert!(imported.iter().all(|card| card.template_id.is_none()));
        let basic = imported
            .iter()
            .find(|card| card.text.is_none())
            .expect("Basic card");
        assert_eq!(basic.front, "capital of France? <img src=\"map.png\">");
        assert_eq!(basic.back, "Paris");
        assert_eq!(basic.tags, vec!["geo"]);
        assert_eq!(
            basic.extra_fields.get("AnkiIvl").map(String::as_str),
            Some("12")
        );
        assert_eq!(
            basic.extra_fields.get("AnkiReps").map(String::as_str),
            Some("7")
        );
        assert_eq!(
            basic.extra_fields.get("AnkiSchedType").map(String::as_str),
            Some("2")
        );
        assert_eq!(basic.images, vec![extracted.to_string_lossy().to_string()]);
        let cloze = imported
            .iter()
            .find(|card| card.text.is_some())
            .expect("Cloze card");
        assert_eq!(cloze.text.as_deref(), Some("A {{c1::cloze}} note"));
        assert!(
            !cloze.extra_fields.contains_key("AnkiIvl"),
            "全新卡不注入调度元数据"
        );
    }

    #[test]
    fn modern_media_manifest_failure_degrades_to_no_media_import() {
        let (db, _dir) = setup_migrated_db();
        let media_dir = tempdir().expect("media dir");
        let collection = make_modern_collection(
            &[(100, "Basic", 0, &["Front", "Back"][..])],
            &[(1, 100, "", "front\u{1f}back")],
            &[(10, 1, 0, [0, 0, 0, 0, 0, 0, 0])],
        );
        let compressed =
            zstd::stream::encode_all(Cursor::new(collection), 1).expect("zstd collection");
        let apkg = make_apkg(vec![
            ("collection.anki21b", compressed),
            // 非法 protobuf：wire type 5 但数据被截断
            ("media", b"\x05\x05\x05".to_vec()),
            ("0", b"orphan".to_vec()),
        ]);
        let result = ApkgImporterService::new(db)
            .with_media_dir(media_dir.path().to_path_buf())
            .import_bytes(&apkg, Some("modern-bad-media.apkg"), None)
            .expect("media manifest failure must not block card import");
        assert_eq!(result.imported_cards, 1);
        assert_eq!(result.media_imported, 0);
        assert_eq!(result.media_skipped, 1);
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("媒体清单解析失败")));
    }

    #[test]
    fn modern_media_manifest_protobuf_parses_names_in_order() {
        let encoded = encode_media_entries(&["a.png", "b.mp3"]);
        let manifest = parse_modern_media_manifest(&encoded).expect("parse raw protobuf manifest");
        assert_eq!(manifest.get("0").map(String::as_str), Some("a.png"));
        assert_eq!(manifest.get("1").map(String::as_str), Some("b.mp3"));

        let compressed = zstd::stream::encode_all(Cursor::new(encoded), 1).expect("zstd manifest");
        let manifest = parse_modern_media_manifest(&compressed).expect("parse zstd manifest");
        assert_eq!(manifest.len(), 2);

        assert!(parse_modern_media_manifest(b"\x0a\x02\x10").is_err());
    }

    #[test]
    fn notetype_kind_parsing_defaults_to_normal_on_unknown_data() {
        assert_eq!(parse_notetype_kind(&[]), 0);
        assert_eq!(parse_notetype_kind(&[0x08, 0x01]), 1);
        assert_eq!(parse_notetype_kind(&[0x08, 0x00]), 0);
        // 前置未知字段（field 2, string）不影响 kind 解析
        assert_eq!(
            parse_notetype_kind(&[0x12, 0x03, b'a', b'b', b'c', 0x08, 0x01]),
            1
        );
        // 畸形数据保守回退 normal
        assert_eq!(parse_notetype_kind(&[0xff]), 0);
    }

    #[test]
    fn external_multi_template_note_is_deduplicated_with_warning() {
        let (db, _dir) = setup_migrated_db();
        let collection = make_collection(
            json!({ "100": model_json(0, &[("Front", 0), ("Back", 1)]) }),
            &[(1, 100, "", "front\u{1f}back")],
            &[(10, 1, 0), (11, 1, 1), (12, 1, 2)],
        );
        let apkg = make_apkg(vec![("collection.anki2", collection)]);
        let result = ApkgImporterService::new(db.clone())
            .import_bytes(&apkg, Some("multi-template.apkg"), None)
            .expect("import external multi-template note");
        assert_eq!(result.imported_cards, 1);
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("去重")));
        let imported = db
            .get_cards_for_document(&result.document_id)
            .expect("imported cards");
        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].front, "front");
        assert_eq!(imported[0].back, "back");
        assert_eq!(
            imported[0]
                .extra_fields
                .get("AnkiCardOrd")
                .map(String::as_str),
            Some("0")
        );
    }

    #[test]
    fn colpkg_source_is_rejected_with_export_guidance() {
        let (db, _dir) = setup_unmigrated_db();
        let apkg = make_apkg(vec![("collection.anki2", make_basic_collection("front"))]);
        let error = ApkgImporterService::new(db)
            .import_bytes(&apkg, Some("collection.colpkg"), None)
            .expect_err("colpkg must be rejected with guidance");
        assert_eq!(error_code(&error), Some(APKG_ERROR_COLPKG));
        assert!(error.message.contains("apkg"));
    }

    #[test]
    fn anki21b_alongside_legacy_anki21_still_imports_legacy_data() {
        let (db, _dir) = setup_migrated_db();
        let apkg = make_apkg(vec![
            (
                "collection.anki2",
                make_basic_collection("placeholder anki2"),
            ),
            ("collection.anki21", make_basic_collection("legacy anki21")),
            ("collection.anki21b", b"\x28\xb5\x2f\xfdmodern".to_vec()),
        ]);
        let result = ApkgImporterService::new(db.clone())
            .import_bytes(&apkg, Some("modern-plus-legacy.apkg"), None)
            .expect("legacy anki21 must remain importable next to anki21b");
        let cards = db
            .get_cards_for_document(&result.document_id)
            .expect("imported cards");
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].front, "legacy anki21");
    }

    #[test]
    fn rejects_zstd_collection_with_oversized_window() {
        let mut encoder = zstd::stream::write::Encoder::new(Vec::new(), 1).expect("zstd encoder");
        encoder.window_log(29).expect("512 MiB window");
        encoder
            .include_contentsize(false)
            .expect("omit content size");
        encoder
            .write_all(SQLITE_HEADER)
            .expect("write tiny zstd frame");
        let encoded = encoder.finish().expect("finish zstd frame");

        let error = decode_collection(encoded, MAX_COLLECTION_BYTES)
            .expect_err("512 MiB frame window must exceed the explicit decoder limit");
        assert_eq!(error_code(&error), Some(APKG_ERROR_COLLECTION_INVALID));
        assert!(error.message.contains("decompress"));
    }

    #[test]
    fn rejects_traversal_oversize_and_missing_collection_without_persistence() {
        let (db, _dir) = setup_unmigrated_db();
        let service = ApkgImporterService::new(db.clone());
        let collection = make_basic_collection("front");

        let traversal = make_apkg(vec![
            ("collection.anki2", collection.clone()),
            ("../escape", b"no".to_vec()),
        ]);
        let error = service
            .import_bytes(&traversal, Some("traversal.apkg"), None)
            .expect_err("traversal must fail");
        assert_eq!(error_code(&error), Some(APKG_ERROR_INVALID_ARCHIVE));

        let missing = make_apkg(vec![("media", b"{}".to_vec())]);
        let error = service
            .import_bytes(&missing, Some("missing.apkg"), None)
            .expect_err("missing collection must fail");
        assert_eq!(error_code(&error), Some(APKG_ERROR_COLLECTION_MISSING));

        let oversized = make_apkg(vec![("collection.anki2", collection)]);
        let error = service
            .import_reader(
                Cursor::new(oversized),
                "oversized.apkg",
                None,
                ImportLimits {
                    max_entries: 10,
                    max_entry_bytes: 32,
                    max_total_uncompressed_bytes: 64,
                    max_collection_bytes: 32,
                    max_materialized_card_bytes: MAX_MATERIALIZED_CARD_BYTES,
                },
            )
            .expect_err("oversized collection must fail");
        assert_eq!(error_code(&error), Some(APKG_ERROR_LIMIT_EXCEEDED));
    }

    #[test]
    fn rejects_view_backed_collection_schema() {
        let (db, _dir) = setup_unmigrated_db();
        let apkg = make_apkg(vec![("collection.anki2", make_view_backed_collection())]);
        let error = ApkgImporterService::new(db)
            .import_bytes(&apkg, Some("view-backed.apkg"), None)
            .expect_err("cards view must be rejected before querying it");
        assert_eq!(error_code(&error), Some(APKG_ERROR_COLLECTION_INVALID));
        assert!(error.message.contains("must be a real table"));
    }

    #[test]
    fn rejects_field_delimiter_and_tag_bombs() {
        let (db, _dir) = setup_unmigrated_db();
        let service = ApkgImporterService::new(db);
        let models = json!({ "100": model_json(0, &[("Front", 0), ("Back", 1)]) });

        let delimiter_bomb = "x\u{1f}".repeat(MAX_FIELDS_PER_MODEL + 1);
        let collection = make_collection(
            models.clone(),
            &[(1, 100, "", &delimiter_bomb)],
            &[(10, 1, 0)],
        );
        let apkg = make_apkg(vec![("collection.anki2", collection)]);
        let error = service
            .import_bytes(&apkg, Some("delimiter-bomb.apkg"), None)
            .expect_err("field delimiter bomb must fail before field allocation");
        assert_eq!(error_code(&error), Some(APKG_ERROR_LIMIT_EXCEEDED));

        let tag_bomb = std::iter::repeat("tag")
            .take(MAX_TAGS_PER_CARD + 1)
            .collect::<Vec<_>>()
            .join(" ");
        let collection = make_collection(
            models,
            &[(1, 100, &tag_bomb, "front\u{1f}back")],
            &[(10, 1, 0)],
        );
        let apkg = make_apkg(vec![("collection.anki2", collection)]);
        let error = service
            .import_bytes(&apkg, Some("tag-bomb.apkg"), None)
            .expect_err("tag bomb must fail before tag allocation");
        assert_eq!(error_code(&error), Some(APKG_ERROR_LIMIT_EXCEEDED));
    }

    #[test]
    fn repeated_card_rows_hit_materialized_budget() {
        let (db, _dir) = setup_unmigrated_db();
        let repeated_cards = (0..16)
            .map(|index| (10 + index, 1, index))
            .collect::<Vec<_>>();
        let collection = make_collection(
            json!({ "100": model_json(0, &[("Front", 0), ("Back", 1)]) }),
            &[(1, 100, "tag", "repeated front\u{1f}repeated back")],
            &repeated_cards,
        );
        let apkg = make_apkg(vec![("collection.anki2", collection)]);
        let error = ApkgImporterService::new(db)
            .import_reader(
                Cursor::new(apkg),
                "materialized-bomb.apkg",
                None,
                ImportLimits {
                    max_entries: MAX_ZIP_ENTRIES,
                    max_entry_bytes: MAX_ENTRY_BYTES,
                    max_total_uncompressed_bytes: MAX_TOTAL_UNCOMPRESSED_BYTES,
                    max_collection_bytes: MAX_COLLECTION_BYTES,
                    max_materialized_card_bytes: 8 * 1024,
                },
            )
            .expect_err("repeated note materialization must respect the retained-memory budget");
        assert_eq!(error_code(&error), Some(APKG_ERROR_LIMIT_EXCEEDED));
        assert!(error.message.contains("materialized card data"));
    }

    #[test]
    fn target_failure_rolls_back_document_and_all_cards() {
        let (db, _dir) = setup_migrated_db();
        {
            let conn = db.get_conn_safe().expect("target connection");
            conn.execute_batch(
                "CREATE TRIGGER fail_second_apkg_card
                 BEFORE INSERT ON anki_cards
                 WHEN NEW.source_type = 'apkg_import' AND NEW.card_order_in_task = 1
                 BEGIN
                     SELECT RAISE(ABORT, 'injected APKG failure');
                 END;",
            )
            .expect("failure trigger");
        }
        let apkg = make_apkg(vec![("collection.anki2", make_mixed_collection())]);
        let error = ApkgImporterService::new(db.clone())
            .import_bytes(&apkg, Some("rollback.apkg"), Some("owner"))
            .expect_err("injected target failure");
        assert!(matches!(&error.error_type, AppErrorType::Database));
        assert_eq!(error_code(&error), Some(APKG_ERROR_DATABASE));

        let conn = db.get_conn_safe().expect("target connection");
        let tasks: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM document_tasks WHERE original_document_name = 'rollback.apkg'",
                [],
                |row| row.get(0),
            )
            .expect("task count");
        let cards: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM anki_cards WHERE source_type = 'apkg_import'",
                [],
                |row| row.get(0),
            )
            .expect("card count");
        assert_eq!(tasks, 0);
        assert_eq!(cards, 0);
    }

    #[test]
    fn migration_keeps_generated_dedup_while_allowing_apkg_card_identity() {
        let (db, _dir) = setup_migrated_db();
        let conn = db.get_conn_safe().expect("target connection");
        conn.execute(
            "INSERT INTO document_tasks (
                id, document_id, original_document_name, segment_index, content_segment,
                status, anki_generation_options_json
             ) VALUES ('task', 'doc', 'doc', 0, '', 'Completed', '{}')",
            [],
        )
        .expect("task");
        let insert = |id: &str, source_type: &str| {
            conn.execute(
                "INSERT INTO anki_cards (
                    id, task_id, front, back, tags_json, images_json, is_error_card,
                    card_order_in_task, extra_fields_json, source_type, source_id
                 ) VALUES (?1, 'task', 'same front', 'same back', '[]', '[]', 0, 0, '{}', ?2, 'doc')",
                params![id, source_type],
            )
        };
        insert("generated-1", "document").expect("first generated card");
        assert!(
            insert("generated-2", "document").is_err(),
            "ordinary generated duplicate must remain rejected"
        );
        insert("apkg-1", "apkg_import").expect("first APKG card");
        insert("apkg-2", "apkg_import").expect("second APKG card");
    }

    #[test]
    fn result_serialization_does_not_expose_internal_card_ids() {
        let result = ApkgImportResult {
            document_id: "doc".to_string(),
            imported_cards: 1,
            imported_templates: 0,
            media_skipped: 0,
            media_imported: 0,
            warnings: vec![],
            card_ids: vec!["card".to_string()],
        };
        let value = serde_json::to_value(result).expect("serialize result");
        assert_eq!(value["documentId"], "doc");
        assert_eq!(value["mediaImported"], 0);
        assert!(value.get("cardIds").is_none());
        // 空 warnings 不序列化，保持旧前端契约整洁
        assert!(value.get("warnings").is_none());
    }

    #[test]
    fn result_deserialization_defaults_new_optional_fields() {
        let json =
            r#"{"documentId":"doc","importedCards":2,"importedTemplates":0,"mediaSkipped":1}"#;
        let parsed: ApkgImportResult = serde_json::from_str(json).expect("compat deserialize");
        assert_eq!(parsed.media_imported, 0);
        assert!(parsed.warnings.is_empty());
    }

    #[test]
    fn media_filename_sanitization_rejects_traversal_and_control_names() {
        assert_eq!(
            sanitize_media_filename("picture.png").as_deref(),
            Some("picture.png")
        );
        assert_eq!(
            sanitize_media_filename("nested/dir/photo.jpg").as_deref(),
            Some("photo.jpg")
        );
        assert_eq!(sanitize_media_filename(""), None);
        assert_eq!(sanitize_media_filename(".."), None);
        assert_eq!(sanitize_media_filename("bad\u{0}name.png"), None);
        assert_eq!(sanitize_media_filename(&"x".repeat(256)), None);
    }

    #[test]
    fn media_reference_extraction_handles_img_and_sound_tags() {
        let html = r#"<img src="one.png"> text <img src='two.jpg'/> [sound:clip.mp3] src= broken"#;
        let names = extract_media_filenames(html);
        assert_eq!(names, vec!["one.png", "two.jpg", "clip.mp3"]);
    }

    #[test]
    fn media_import_extracts_declared_files_and_links_referencing_cards() {
        let (db, _dir) = setup_migrated_db();
        let media_dir = tempdir().expect("media dir");
        let collection = make_collection(
            json!({ "100": model_json(0, &[("Front", 0), ("Back", 1)]) }),
            &[(
                1,
                100,
                "",
                "front with <img src=\"picture.png\">\u{1f}plain back",
            )],
            &[(10, 1, 0)],
        );
        let apkg = make_apkg(vec![
            ("collection.anki2", collection),
            (
                "media",
                br#"{"0":"picture.png","1":"missing-entry.mp3"}"#.to_vec(),
            ),
            ("0", b"png-bytes".to_vec()),
        ]);

        let result = ApkgImporterService::new(db.clone())
            .with_media_dir(media_dir.path().to_path_buf())
            .import_bytes(&apkg, Some("media.apkg"), Some("media-session"))
            .expect("import APKG with media");

        // 声明 2 个媒体：1 个成功落盘，1 个包内缺失 → skipped
        assert_eq!(result.media_imported, 1);
        assert_eq!(result.media_skipped, 1);
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("missing-entry.mp3")));
        let extracted = media_dir.path().join("picture.png");
        assert!(extracted.exists());
        assert_eq!(
            std::fs::read(&extracted).expect("read extracted media"),
            b"png-bytes"
        );

        // 引用该媒体的卡片 images 指向落盘绝对路径
        let imported = db
            .get_cards_for_document(&result.document_id)
            .expect("imported cards");
        assert_eq!(imported.len(), 1);
        assert_eq!(
            imported[0].images,
            vec![extracted.to_string_lossy().to_string()]
        );
    }

    #[test]
    fn media_import_without_media_dir_keeps_legacy_skip_semantics() {
        let (db, _dir) = setup_migrated_db();
        let apkg = make_apkg(vec![
            ("collection.anki2", make_basic_collection("front")),
            ("media", br#"{"0":"picture.png"}"#.to_vec()),
            ("0", b"png-bytes".to_vec()),
        ]);
        let result = ApkgImporterService::new(db)
            .import_bytes(&apkg, Some("legacy.apkg"), None)
            .expect("import without media dir");
        assert_eq!(result.media_imported, 0);
        assert_eq!(result.media_skipped, 1);
    }

    #[test]
    fn deep_student_template_metadata_recreates_missing_local_template() {
        let (db, _dir) = setup_migrated_db();
        let models = json!({
            "300": {
                "name": "Imported Design",
                "type": 0,
                "css": ".card { color: teal; }",
                "tmpls": [{"name": "Card 1", "qfmt": "{{Question}}", "afmt": "{{Question}}<hr>{{Answer}}"}],
                "flds": [{"name": "Question", "ord": 0}, {"name": "Answer", "ord": 1}],
                "deepStudentTemplateId": "design-imported"
            }
        });
        let collection = make_collection(models, &[(1, 300, "", "q\u{1f}a")], &[(10, 1, 0)]);
        let apkg = make_apkg(vec![("collection.anki2", collection)]);

        let result = ApkgImporterService::new(db.clone())
            .import_bytes(&apkg, Some("template.apkg"), None)
            .expect("import APKG carrying template metadata");
        assert_eq!(result.imported_templates, 1);

        let template = db
            .get_custom_template_by_id("design-imported")
            .expect("query template")
            .expect("template recreated");
        assert_eq!(template.name, "Imported Design");
        assert_eq!(template.note_type, "Basic");
        assert_eq!(template.fields, vec!["Question", "Answer"]);
        assert_eq!(template.front_template, "{{Question}}");
        assert_eq!(template.css_style, ".card { color: teal; }");

        // 幂等：再次导入同一包不会重复创建
        let second = ApkgImporterService::new(db)
            .import_bytes(&apkg, Some("template.apkg"), None)
            .expect("re-import same APKG");
        assert_eq!(second.imported_templates, 0);
    }

    #[tokio::test]
    #[ignore = "set DEEP_STUDENT_EXTERNAL_APKG to run the real-package smoke test"]
    async fn external_apkg_env_smoke() {
        const SESSION_ID: &str = "external-smoke";
        const REIMPORT_SESSION_ID: &str = "external-smoke-reimport";

        let path = std::env::var("DEEP_STUDENT_EXTERNAL_APKG")
            .expect("DEEP_STUDENT_EXTERNAL_APKG must point to a real APKG file");
        let (db, _dir) = setup_migrated_db();
        let result = ApkgImporterService::new(db.clone())
            .import_path(Path::new(&path), Some(SESSION_ID))
            .expect("import external APKG");
        assert!(result.imported_cards > 0);
        assert_eq!(result.card_ids.len(), result.imported_cards);
        assert!(db
            .is_document_owned_by_session(&result.document_id, SESSION_ID)
            .expect("ownership"));

        // Agent read path: the complete document remains session-owned and exposes real IDs.
        let imported = db
            .get_cards_for_document_for_session(&result.document_id, SESSION_ID)
            .expect("read imported cards for owning Agent session")
            .expect("imported document belongs to Agent session");
        assert_eq!(imported.len(), result.imported_cards);
        assert!(
            imported.iter().all(|card| card.template_id.is_none()),
            "the external fixture must not carry Deep Student template identity"
        );
        let basic_ids = imported
            .iter()
            .filter(|card| card.text.is_none())
            .map(|card| card.id.clone())
            .collect::<Vec<_>>();
        let cloze_ids = imported
            .iter()
            .filter(|card| card.text.is_some())
            .map(|card| card.id.clone())
            .collect::<Vec<_>>();
        assert!(
            !basic_ids.is_empty(),
            "external package should contain Basic cards"
        );
        assert!(
            !cloze_ids.is_empty(),
            "external package should contain Cloze cards"
        );
        assert_eq!(basic_ids.len() + cloze_ids.len(), result.imported_cards);
        assert!(
            result.imported_cards <= 500,
            "external smoke fixture must contain at most 500 cards so due browsing is exhaustive"
        );

        // Library read path: every page is reachable and carries APKG provenance.
        let page_size = 20u32;
        let expected_total = result.imported_cards as u64;
        let page_count =
            ((expected_total + u64::from(page_size) - 1) / u64::from(page_size)) as u32;
        let mut browsed_ids = HashSet::new();
        for page in 1..=page_count {
            let (items, total) = db
                .list_anki_library_cards(None, None, None, page, page_size)
                .expect("browse imported cards through library pagination");
            assert_eq!(total, expected_total);
            assert!(items.len() <= page_size as usize);
            for item in items {
                assert_eq!(item.source_type.as_deref(), Some("apkg_import"));
                assert_eq!(item.source_id.as_deref(), Some(result.document_id.as_str()));
                assert!(!item.enqueued);
                assert!(
                    browsed_ids.insert(item.card.id),
                    "library page repeated a card ID"
                );
            }
        }
        assert_eq!(browsed_ids.len(), result.imported_cards);

        // Review path: enqueue the owned document, browse due content, and rate both note types.
        let fsrs = FsrsReviewService::new(db.clone());
        let enqueued = fsrs
            .enqueue_cards_for_session(&[], SESSION_ID, Some(&result.document_id))
            .expect("enqueue imported document for review");
        assert_eq!(enqueued.enqueued as usize, result.imported_cards);
        assert_eq!(enqueued.skipped, 0);
        assert_eq!(enqueued.states.len(), result.imported_cards);
        assert_eq!(enqueued.review_cards.len(), result.imported_cards);
        let basic_review = enqueued
            .review_cards
            .iter()
            .find(|card| card.text.is_none())
            .expect("Basic review card")
            .clone();
        let cloze_review = enqueued
            .review_cards
            .iter()
            .find(|card| card.text.is_some())
            .expect("Cloze review card")
            .clone();

        let due = fsrs
            .get_due(Some(result.imported_cards as u32))
            .expect("browse imported cards in due queue");
        assert_eq!(due.len(), result.imported_cards);
        assert!(due.iter().any(|card| card.text.is_none()));
        assert!(due.iter().any(|card| card.text.is_some()));
        assert!(due.iter().any(|card| card.state.id == basic_review.id));
        assert!(due.iter().any(|card| card.state.id == cloze_review.id));

        let basic_rating = fsrs
            .rate(&basic_review.id, 3, Some(750), None)
            .expect("rate imported Basic card");
        let cloze_rating = fsrs
            .rate(&cloze_review.id, 3, Some(900), None)
            .expect("rate imported Cloze card");
        assert!(!basic_rating.log_id.is_empty());
        assert!(!cloze_rating.log_id.is_empty());
        assert_ne!(basic_rating.log_id, cloze_rating.log_id);
        assert_eq!(
            basic_rating.card_state.anki_card_id,
            basic_review.anki_card_id
        );
        assert_eq!(
            cloze_rating.card_state.anki_card_id,
            cloze_review.anki_card_id
        );
        assert_eq!(basic_rating.card_state.reps, 1);
        assert_eq!(cloze_rating.card_state.reps, 1);
        let stats = fsrs
            .get_stats()
            .expect("review stats after external ratings");
        assert_eq!(stats.total as usize, result.imported_cards);
        assert_eq!(stats.reviews_today, 2);

        // Retemplate through the same optimistic-lock repository used by ChatAnki.
        let expected_versions = imported
            .iter()
            .map(|card| (card.id.clone(), card.updated_at.clone()))
            .collect::<HashMap<_, _>>();
        let mut basic_template =
            custom_template("external-smoke-basic", "Basic", &["Front", "Back"]);
        basic_template.front_template = "{{Front}}".to_string();
        basic_template.back_template = "{{FrontSide}}<hr id=\"answer\">{{Back}}".to_string();
        let cloze_template = custom_template("external-smoke-cloze", "Cloze", &["Text", "Extra"]);
        let basic_template_id = basic_template.id.clone();
        let cloze_template_id = cloze_template.id.clone();
        let basic_target = AnkiRetemplateTarget {
            template_id: basic_template_id.clone(),
            note_type: "Basic".to_string(),
            fields: basic_template.fields.clone(),
            required_fields: HashSet::from(["Front".to_string(), "Back".to_string()]),
        };
        let cloze_target = AnkiRetemplateTarget {
            template_id: cloze_template_id.clone(),
            note_type: "Cloze".to_string(),
            fields: cloze_template.fields.clone(),
            required_fields: HashSet::from(["Text".to_string()]),
        };
        let cloze_versions = cloze_ids
            .iter()
            .map(|card_id| {
                (
                    card_id.clone(),
                    expected_versions
                        .get(card_id)
                        .expect("Cloze card version")
                        .clone(),
                )
            })
            .collect::<HashMap<_, _>>();
        let cloze_retemplate = db
            .retemplate_anki_cards_for_session(
                &AnkiRetemplateSelector::Cards(cloze_ids.clone()),
                &cloze_target,
                &cloze_versions,
                SESSION_ID,
                std::slice::from_ref(&result.document_id),
            )
            .expect("retemplate external Cloze cards");
        let cloze_updates = match cloze_retemplate {
            AnkiRetemplateBatchResult::Updated {
                target_note_type,
                updates,
            } => {
                assert_eq!(target_note_type, "Cloze");
                updates
            }
            AnkiRetemplateBatchResult::InvalidCloze { card_ids } => panic!(
                "external fixture contains Cloze-model cards without valid {{cN::answer}} markup: {card_ids:?}"
            ),
            other => panic!("unexpected Cloze retemplate result: {other:?}"),
        };
        assert_eq!(cloze_updates.len(), cloze_ids.len());
        assert!(cloze_updates.iter().all(|update| {
            update.card.template_id.as_deref() == Some(cloze_template_id.as_str())
                && update.card.text == update.source.text
        }));

        let basic_versions = basic_ids
            .iter()
            .map(|card_id| {
                (
                    card_id.clone(),
                    expected_versions
                        .get(card_id)
                        .expect("Basic card version")
                        .clone(),
                )
            })
            .collect::<HashMap<_, _>>();
        let basic_retemplate = db
            .retemplate_anki_cards_for_session(
                &AnkiRetemplateSelector::Cards(basic_ids.clone()),
                &basic_target,
                &basic_versions,
                SESSION_ID,
                std::slice::from_ref(&result.document_id),
            )
            .expect("retemplate external Basic cards");
        let basic_updates = match basic_retemplate {
            AnkiRetemplateBatchResult::Updated {
                target_note_type,
                updates,
            } => {
                assert_eq!(target_note_type, "Basic");
                updates
            }
            other => panic!("unexpected Basic retemplate result: {other:?}"),
        };
        assert_eq!(basic_updates.len(), basic_ids.len());
        assert!(basic_updates.iter().all(|update| {
            update.card.template_id.as_deref() == Some(basic_template_id.as_str())
                && update.card.front == update.source.front
                && update.card.back == update.source.back
        }));

        let retemplated = db
            .get_cards_for_document_for_session(&result.document_id, SESSION_ID)
            .expect("read retemplated external cards")
            .expect("retemplated document belongs to Agent session");
        assert_eq!(retemplated.len(), result.imported_cards);
        assert_eq!(
            retemplated
                .iter()
                .filter(|card| card.template_id.as_deref() == Some(basic_template_id.as_str()))
                .count(),
            basic_ids.len()
        );
        assert_eq!(
            retemplated
                .iter()
                .filter(|card| card.template_id.as_deref() == Some(cloze_template_id.as_str()))
                .count(),
            cloze_ids.len()
        );

        // Existing FSRS states are reused, while their review payload sees the new templates.
        let resynced = fsrs
            .enqueue_cards_for_session(&[], SESSION_ID, Some(&result.document_id))
            .expect("resync retemplated cards with existing review states");
        assert_eq!(resynced.enqueued, 0);
        assert_eq!(resynced.skipped as usize, result.imported_cards);
        assert_eq!(resynced.review_cards.len(), result.imported_cards);
        assert_eq!(
            resynced
                .review_cards
                .iter()
                .filter(|card| card.template_id.as_deref() == Some(basic_template_id.as_str()))
                .count(),
            basic_ids.len()
        );
        assert_eq!(
            resynced
                .review_cards
                .iter()
                .filter(|card| card.template_id.as_deref() == Some(cloze_template_id.as_str()))
                .count(),
            cloze_ids.len()
        );

        let mut expected_basic_content = retemplated
            .iter()
            .filter(|card| card.template_id.as_deref() == Some(basic_template_id.as_str()))
            .map(|card| {
                (
                    card.front.trim().to_string(),
                    card.back.trim().to_string(),
                    card.tags.clone(),
                )
            })
            .collect::<Vec<_>>();
        expected_basic_content.sort();
        let mut expected_cloze_content = retemplated
            .iter()
            .filter(|card| card.template_id.as_deref() == Some(cloze_template_id.as_str()))
            .map(|card| {
                (
                    card.text.as_deref().unwrap_or_default().trim().to_string(),
                    card.tags.clone(),
                )
            })
            .collect::<Vec<_>>();
        expected_cloze_content.sort();

        // Re-export and import into another fresh database to verify durable identity/content.
        let output_dir = tempdir().expect("external re-export tempdir");
        let output_path = output_dir.path().join("external-reexport.apkg");
        crate::apkg_exporter_service::export_multi_template_apkg(
            retemplated,
            "External APKG smoke re-export".to_string(),
            output_path.clone(),
            HashMap::from([
                (basic_template_id.clone(), basic_template),
                (cloze_template_id.clone(), cloze_template),
            ]),
        )
        .await
        .expect("re-export transformed external APKG");
        assert!(
            std::fs::metadata(&output_path)
                .expect("re-exported APKG metadata")
                .len()
                > 0
        );

        let (reimport_db, _reimport_dir) = setup_migrated_db();
        let reimport_result = ApkgImporterService::new(reimport_db.clone())
            .import_path(&output_path, Some(REIMPORT_SESSION_ID))
            .expect("re-import transformed external APKG");
        assert_eq!(reimport_result.imported_cards, result.imported_cards);
        let reimported = reimport_db
            .get_cards_for_document_for_session(&reimport_result.document_id, REIMPORT_SESSION_ID)
            .expect("read re-imported external cards")
            .expect("re-imported document belongs to Agent session");
        assert_eq!(reimported.len(), result.imported_cards);
        assert_eq!(
            reimported
                .iter()
                .filter(|card| card.template_id.as_deref() == Some(basic_template_id.as_str()))
                .count(),
            basic_ids.len()
        );
        assert_eq!(
            reimported
                .iter()
                .filter(|card| card.template_id.as_deref() == Some(cloze_template_id.as_str()))
                .count(),
            cloze_ids.len()
        );

        let mut actual_basic_content = reimported
            .iter()
            .filter(|card| card.template_id.as_deref() == Some(basic_template_id.as_str()))
            .map(|card| {
                (
                    card.front.trim().to_string(),
                    card.back.trim().to_string(),
                    card.tags.clone(),
                )
            })
            .collect::<Vec<_>>();
        actual_basic_content.sort();
        let mut actual_cloze_content = reimported
            .iter()
            .filter(|card| card.template_id.as_deref() == Some(cloze_template_id.as_str()))
            .map(|card| {
                (
                    card.text.as_deref().unwrap_or_default().trim().to_string(),
                    card.tags.clone(),
                )
            })
            .collect::<Vec<_>>();
        actual_cloze_content.sort();
        assert_eq!(actual_basic_content, expected_basic_content);
        assert_eq!(actual_cloze_content, expected_cloze_content);
    }
}
