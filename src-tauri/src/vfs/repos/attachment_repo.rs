//! VFS 附件 Repo
//!
//! 管理图片和文档附件的存储。支持两种存储模式：
//! - 小文件（<1MB）：内容存储在 resources.data（inline 模式）
//! - 大文件（>=1MB）：内容存储在 blobs 表（external 模式）
//!
//! 基于 content_hash 实现去重：相同内容只存储一次。
//!
//! ## 核心方法
//! - `upload`: 上传附件（自动去重）
//! - `get_by_id`: 根据 ID 获取附件
//! - `get_by_hash`: 根据内容哈希获取附件
//! - `get_content`: 获取附件内容
//!
//! ## 并发安全
//!
//! 附件上传使用 `INSERT OR IGNORE` 模式，基于数据库的 UNIQUE(content_hash) 约束
//! 实现并发安全的去重机制，避免竞态条件导致的重复插入错误。详见 `upload_with_conn` 方法注释。
//!
//! ## SSOT 文档
//!
//! ★ 文件格式定义请参考：docs/design/file-format-registry.md
//! `infer_extension` 函数的 MIME 类型到扩展名映射需与前端保持一致。
//! 修改格式支持时需同步更新文档和其他实现位置。

use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::path::Path;
use tracing::{debug, error, info, warn};

use crate::document_parser::DocumentParser;
use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};
use crate::vfs::ocr_utils::parse_ocr_pages_json;
use crate::vfs::repos::{VfsBlobRepo, VfsFolderRepo, VfsResourceRepo};
use crate::vfs::types::VfsFolderItem;
use crate::vfs::types::{
    PdfPreviewJson, VfsAttachment, VfsResourceMetadata, VfsResourceType, VfsUploadAttachmentParams,
    VfsUploadAttachmentResult,
};

fn is_probably_base64(input: &str) -> bool {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.starts_with("data:") {
        return true;
    }
    let cleaned: String = trimmed.chars().filter(|c| !c.is_whitespace()).collect();
    if cleaned.len() % 4 == 1 {
        return false;
    }
    cleaned
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '=')
}

fn looks_like_path(input: &str) -> bool {
    let trimmed = input.trim();
    if trimmed.starts_with("file://") {
        return true;
    }
    if trimmed.starts_with('/') || trimmed.starts_with('\\') {
        return true;
    }
    let bytes = trimmed.as_bytes();
    if bytes.len() >= 3 {
        let first = bytes[0];
        let second = bytes[1];
        let third = bytes[2];
        if second == b':' && (third == b'\\' || third == b'/') && first.is_ascii_alphabetic() {
            return true;
        }
    }
    false
}

fn normalize_extension(name: &str) -> Option<String> {
    let ext = name.rsplit('.').next()?.trim().to_lowercase();
    if ext.is_empty() || ext.len() >= 10 {
        return None;
    }
    Some(ext)
}

/// 小文件阈值（1MB）
/// 小于此大小的文件使用 inline 模式存储在 resources.data
/// 大于等于此大小的文件使用 external 模式存储在 blobs
const INLINE_SIZE_THRESHOLD: usize = 1024 * 1024;

/// 附件上传大小上限
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_FILE_BYTES: usize = 50 * 1024 * 1024;

/// 允许的扩展名（用于服务端类型校验）
const SUPPORTED_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "heic", "heif", // images
    "pdf", "docx", "xlsx", "xls", "xlsb", "ods", "pptx", // office
    "txt", "md", "csv", "json", "xml", "html", "htm", // text
    "epub", "rtf", // ebook/rtf
    "mp3", "wav", "ogg", "m4a", "flac", "aac", "wma", "opus", // audio
    "mp4", "webm", "mov", "avi", "mkv", "m4v", "wmv", "flv", // video
];

/// 允许的 MIME 类型（用于服务端类型校验）
const SUPPORTED_MIME_TYPES: &[&str] = &[
    // images
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/gif",
    "image/bmp",
    "image/webp",
    "image/svg+xml",
    "image/heic",
    "image/heif",
    // pdf
    "application/pdf",
    // office
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    // text
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
    "application/xml",
    "text/xml",
    "text/html",
    // ebook/rtf
    "application/epub+zip",
    "application/rtf",
    "text/rtf",
    // audio
    "audio/mpeg",
    "audio/wav",
    "audio/x-wav",
    "audio/ogg",
    "audio/mp4",
    "audio/x-m4a",
    "audio/flac",
    "audio/aac",
    "audio/x-ms-wma",
    "audio/opus",
    // video
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "video/x-msvideo",
    "video/x-matroska",
    "video/x-m4v",
    "video/x-ms-wmv",
    "video/x-flv",
];

/// VFS 附件 Repo
pub struct VfsAttachmentRepo;

impl VfsAttachmentRepo {
    pub(crate) fn max_upload_size_bytes(mime_type: &str) -> usize {
        if mime_type.trim().to_lowercase().starts_with("image/") {
            MAX_IMAGE_BYTES
        } else {
            MAX_FILE_BYTES
        }
    }

    pub(crate) fn is_supported_upload_type(name: &str, mime_type: &str) -> bool {
        let normalized_mime = mime_type.trim().to_lowercase();
        if normalized_mime.is_empty() {
            return false;
        }
        if SUPPORTED_MIME_TYPES.contains(&normalized_mime.as_str()) {
            return true;
        }
        normalize_extension(name)
            .map(|ext| SUPPORTED_EXTENSIONS.contains(&ext.as_str()))
            .unwrap_or(false)
    }

    fn validate_upload_type(name: &str, mime_type: &str) -> VfsResult<()> {
        if name.trim().is_empty() {
            return Err(VfsError::InvalidArgument {
                param: "name".to_string(),
                reason: "File name is required".to_string(),
            });
        }
        if !Self::is_supported_upload_type(name, mime_type) {
            return Err(VfsError::InvalidArgument {
                param: "mime_type".to_string(),
                reason: format!(
                    "Unsupported mime type or file extension: {} ({})",
                    mime_type, name
                ),
            });
        }
        Ok(())
    }

    fn validate_upload_size(mime_type: &str, size: usize) -> VfsResult<()> {
        let max_size = Self::max_upload_size_bytes(mime_type);
        if size > max_size {
            let max_mb = max_size / (1024 * 1024);
            let actual_mb = size as f64 / (1024.0 * 1024.0);
            return Err(VfsError::InvalidArgument {
                param: "base64_content".to_string(),
                reason: format!("File too large: max {}MB, got {:.2}MB", max_mb, actual_mb),
            });
        }
        Ok(())
    }

    fn validate_attachment_type(explicit: Option<&str>, mime_type: &str) -> VfsResult<()> {
        if let Some(value) = explicit {
            if value != "image" && value != "file" {
                return Err(VfsError::InvalidArgument {
                    param: "attachment_type".to_string(),
                    reason: format!("Invalid attachment_type: {}", value),
                });
            }
            let is_image = mime_type.trim().to_lowercase().starts_with("image/");
            if value == "image" && !is_image {
                return Err(VfsError::InvalidArgument {
                    param: "attachment_type".to_string(),
                    reason: format!("attachment_type=image but mime_type={}", mime_type),
                });
            }
            if value == "file" && is_image {
                return Err(VfsError::InvalidArgument {
                    param: "attachment_type".to_string(),
                    reason: format!("attachment_type=file but mime_type={}", mime_type),
                });
            }
        }
        Ok(())
    }

    fn is_safe_original_path(blobs_dir: &Path, path: &str) -> bool {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            return false;
        }
        let path_obj = std::path::Path::new(trimmed);

        // 尝试 canonicalize 完整路径（文件存在时）
        if let Ok(canonical_path) = path_obj.canonicalize() {
            if let Ok(canonical_blobs_dir) = blobs_dir.canonicalize() {
                if canonical_path.starts_with(&canonical_blobs_dir) {
                    return true;
                }
                if let Some(slot_root) = canonical_blobs_dir.parent() {
                    let textbooks_dir = slot_root.join("textbooks");
                    if canonical_path.starts_with(&textbooks_dir) {
                        return true;
                    }
                }
            }
        }

        // 文件可能尚不存在（如恢复后资产还未就位），改用父目录判断
        if let Some(parent) = path_obj.parent() {
            if let Ok(canonical_parent) = parent.canonicalize() {
                if let Ok(canonical_blobs_dir) = blobs_dir.canonicalize() {
                    if canonical_parent.starts_with(&canonical_blobs_dir) {
                        return true;
                    }
                    if let Some(slot_root) = canonical_blobs_dir.parent() {
                        let textbooks_dir = slot_root.join("textbooks");
                        if canonical_parent.starts_with(&textbooks_dir) {
                            return true;
                        }
                        // 允许 slot 目录下的所有子目录（images/, documents/ 等）
                        if canonical_parent.starts_with(slot_root) {
                            return true;
                        }
                    }
                }
            }
        }

        false
    }

    // ========================================================================
    // 上传附件
    // ========================================================================

    /// 上传附件（使用现有连接）
    ///
    /// ## 并发安全设计
    ///
    /// 该方法通过数据库的 UNIQUE 约束和 INSERT OR IGNORE 语法实现并发安全：
    ///
    /// 1. **问题场景**：
    ///    - 线程 A 和 B 同时上传相同内容的文件
    ///    - 两者都计算出相同的 content_hash
    ///    - 两者都检查到 hash 不存在
    ///    - 两者都尝试创建附件记录
    ///    - 违反 UNIQUE(content_hash) 约束，导致错误
    ///
    /// 2. **修复方案**：
    ///    - 先存储文件内容（resource 或 blob）
    ///    - 使用 `INSERT OR IGNORE INTO files` 尝试插入
    ///    - 如果 content_hash 已存在，插入被忽略（affected_rows = 0）
    ///    - 再次查询获取现有附件
    ///    - 整个操作依赖数据库的 UNIQUE 约束保证原子性
    ///
    /// 3. **关键点**：
    ///    - `UNIQUE INDEX idx_attachments_hash_unique ON attachments(content_hash)` 确保同一 hash 只能存在一份
    ///    - `INSERT OR IGNORE` 在冲突时不会抛出错误
    ///    - 即使多线程并发插入相同 hash，也只有一个会成功
    ///
    // TODO(transaction): upload_with_conn 包含多步操作（store_inline/store_external → INSERT files
    // → UPDATE resources → save_ocr_text → UPDATE ocr_pages_json），其中 store_external 涉及
    // 文件系统写入（VfsBlobRepo::store_blob_with_conn），无法被 DB SAVEPOINT 回滚。
    // 当前设计依赖 INSERT OR IGNORE 处理并发竞态，orphan resource/blob 因去重设计影响可控。
    // 若要加强保护：可对 INSERT files 之后的多个 UPDATE 操作用 SAVEPOINT 包裹，
    // 确保 backfill（resource_id、source_id、ocr_text、ocr_pages_json）要么全部成功要么全部回滚。
    // 当前这些 backfill 失败已用 warn! 日志记录并继续执行，风险较低。
    pub fn upload_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        params: VfsUploadAttachmentParams,
    ) -> VfsResult<VfsUploadAttachmentResult> {
        // 1. 解码 Base64
        let data = Self::decode_base64(&params.base64_content)?;
        let size = data.len() as i64;

        // 1.5 基础校验：类型 + 大小 + attachment_type 一致性
        Self::validate_upload_type(&params.name, &params.mime_type)?;
        Self::validate_upload_size(&params.mime_type, data.len())?;
        Self::validate_attachment_type(params.attachment_type.as_deref(), &params.mime_type)?;

        // 2. 计算内容哈希
        let content_hash = Self::compute_hash(&data);
        debug!(
            "[VFS::AttachmentRepo] Computed hash: {} for file: {} ({} bytes)",
            content_hash, params.name, size
        );

        // 3. 确定附件类型
        let attachment_type = params
            .attachment_type
            .clone()
            .unwrap_or_else(|| Self::infer_type_from_mime(&params.mime_type));

        // 3.5 检查是否已存在相同 hash 的附件
        // ★ P0 修复：区分未删除和已删除附件的处理逻辑
        if let Some(mut existing) = Self::get_by_hash_with_conn(conn, &content_hash)? {
            if existing.deleted_at.is_none() {
                // 未删除的附件，直接复用
                // ★ P0 修复：查询并返回已有的处理状态，让前端正确显示进度

                // ★ 2026-02-14 修复：修复因 pdfium 曾经故障导致的缓存坏数据
                // 如果是 PDF 且 page_count=0（或 None）且无 extracted_text，说明之前提取失败
                // 重新运行 render_pdf_preview 修复数据
                let is_existing_pdf = existing.mime_type == "application/pdf"
                    || existing.name.to_lowercase().ends_with(".pdf");
                let needs_repair = is_existing_pdf
                    && existing.page_count.unwrap_or(0) == 0
                    && existing
                        .extracted_text
                        .as_ref()
                        .map(|t| t.trim().is_empty())
                        .unwrap_or(true);

                if needs_repair {
                    use super::pdf_preview::{render_pdf_preview, PdfPreviewConfig};
                    info!(
                        "[VFS::AttachmentRepo] Repairing stale PDF data for {}: page_count=0, re-extracting",
                        existing.id
                    );
                    if let Ok(result) =
                        render_pdf_preview(conn, blobs_dir, &data, &PdfPreviewConfig::default())
                    {
                        let preview_str = result
                            .preview_json
                            .as_ref()
                            .and_then(|p| serde_json::to_string(p).ok());
                        let extracted = result.extracted_text.clone();
                        let pc = result.page_count as i32;

                        let has_text = extracted
                            .as_ref()
                            .map(|t| !t.trim().is_empty())
                            .unwrap_or(false);
                        let mut modes = vec![];
                        if has_text {
                            modes.push("text".to_string());
                        }
                        let progress = serde_json::json!({
                            "stage": "page_rendering",
                            "percent": 25.0,
                            "readyModes": modes
                        });

                        if let Err(e) = conn.execute(
                            r#"UPDATE files SET
                                preview_json = ?1, extracted_text = ?2, page_count = ?3,
                                processing_status = 'page_rendering',
                                processing_progress = ?4
                            WHERE id = ?5"#,
                            params![
                                preview_str,
                                extracted,
                                pc,
                                progress.to_string(),
                                existing.id
                            ],
                        ) {
                            warn!(
                                "[VFS::AttachmentRepo] Failed to repair PDF {}: {}",
                                existing.id, e
                            );
                        } else {
                            info!(
                                "[VFS::AttachmentRepo] Repaired PDF {}: pages={}, text_len={}",
                                existing.id,
                                pc,
                                extracted.as_ref().map(|t| t.len()).unwrap_or(0)
                            );
                            // 更新返回的 existing 对象
                            existing.preview_json = preview_str;
                            existing.extracted_text = extracted;
                            existing.page_count = Some(pc);
                        }
                    }
                }

                let (processing_status, processing_progress, ready_modes) =
                    Self::get_processing_status_with_conn(conn, &existing.id)?;

                info!(
                    "[VFS::AttachmentRepo] Attachment already exists (active): {} -> {}, status={:?}, ready_modes={:?}",
                    content_hash, existing.id, processing_status, ready_modes
                );
                return Ok(VfsUploadAttachmentResult {
                    source_id: existing.id.clone(),
                    resource_hash: existing.content_hash.clone(),
                    is_new: false,
                    attachment: existing,
                    processing_status,
                    processing_percent: processing_progress.map(|p| p as f32),
                    ready_modes,
                });
            } else {
                // 已删除的附件，自动恢复并更新名称
                info!(
                    "[VFS::AttachmentRepo] Restoring deleted attachment: {} (new name: {})",
                    existing.id, params.name
                );
                Self::restore_and_rename_with_conn(conn, &existing.id, &params.name)?;

                // 重新查询获取更新后的记录
                let restored = Self::get_by_id_with_conn(conn, &existing.id)?.ok_or_else(|| {
                    VfsError::Other(format!(
                        "Restored attachment {} not found after restore",
                        existing.id
                    ))
                })?;

                return Ok(VfsUploadAttachmentResult {
                    source_id: restored.id.clone(),
                    resource_hash: restored.content_hash.clone(),
                    is_new: false, // 语义上是"恢复"而非"新建"
                    attachment: restored,
                    processing_status: None,
                    processing_percent: None,
                    ready_modes: None,
                });
            }
        }

        // 4. 根据大小选择存储模式
        //    注意：即使后续插入附件记录失败（因为 hash 冲突），
        //    这些 resource/blob 也会保留，不会造成问题（它们本身也是去重的）
        let (resource_id, blob_hash) = if data.len() < INLINE_SIZE_THRESHOLD {
            // 小文件：inline 模式
            Self::store_inline(conn, &data, &params, &content_hash, &attachment_type)?
        } else {
            // 大文件：external 模式
            Self::store_external(conn, blobs_dir, &data, &params)?
        };

        // 4.5 PDF 预渲染（迁移 015）
        //     如果是 PDF 文件，触发预渲染逻辑
        let is_pdf =
            params.mime_type == "application/pdf" || params.name.to_lowercase().ends_with(".pdf");

        let (preview_json, extracted_text, page_count): (
            Option<String>,
            Option<String>,
            Option<i32>,
        ) = if is_pdf {
            use super::pdf_preview::{render_pdf_preview, PdfPreviewConfig};

            info!(
                "[VFS::AttachmentRepo] PDF detected, triggering preview render: {}",
                params.name
            );

            match render_pdf_preview(conn, blobs_dir, &data, &PdfPreviewConfig::default()) {
                Ok(result) => {
                    // ★ P1-52 修复：preview_json 现在是 Option，渲染失败时为 None
                    let preview_str = result
                        .preview_json
                        .as_ref()
                        .and_then(|p| serde_json::to_string(p).ok());
                    info!(
                            "[VFS::AttachmentRepo] PDF preview rendered: {} pages, text_len={}, has_preview={}",
                            result.page_count,
                            result.extracted_text.as_ref().map(|t| t.len()).unwrap_or(0),
                            preview_str.is_some()
                        );
                    (
                        preview_str,
                        result.extracted_text,
                        Some(result.page_count as i32),
                    )
                }
                Err(e) => {
                    warn!(
                        "[VFS::AttachmentRepo] PDF preview failed, storing without preview: {}",
                        e
                    );
                    (None, None, None)
                }
            }
        } else {
            // 非 PDF 文件：尝试解析文本内容（docx/xlsx/pptx/epub/rtf/txt/md/html 等）
            let extension = std::path::Path::new(&params.name)
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|s| s.to_lowercase());

            // 支持的文档格式（纯 Rust 解析，跨平台兼容）
            let supported_extensions = [
                "docx", "xlsx", "xls", "xlsb", "ods",  // Office 文档
                "pptx", // PowerPoint（pptx-to-md）
                "epub", // 电子书（epub crate）
                "rtf",  // 富文本（rtf-parser）
                "txt", "md", "html", "htm",  // 文本格式
                "csv",  // CSV 表格（csv crate）
                "json", // JSON 数据（serde_json）
                "xml",  // XML 数据（quick-xml）
            ];

            if let Some(ref ext) = extension {
                if supported_extensions.contains(&ext.as_str()) {
                    let parser = DocumentParser::new();
                    match parser.extract_text_from_bytes(&params.name, data.clone()) {
                        Ok(text) => {
                            if !text.trim().is_empty() {
                                info!(
                                    "[VFS::AttachmentRepo] Extracted text from {}: {} chars",
                                    params.name,
                                    text.len()
                                );
                                (None, Some(text), None)
                            } else {
                                debug!(
                                    "[VFS::AttachmentRepo] No text extracted from {}",
                                    params.name
                                );
                                (None, None, None)
                            }
                        }
                        Err(e) => {
                            warn!(
                                "[VFS::AttachmentRepo] Failed to extract text from {}: {}",
                                params.name, e
                            );
                            (None, None, None)
                        }
                    }
                } else {
                    (None, None, None)
                }
            } else {
                (None, None, None)
            }
        };

        // 5. 使用 INSERT OR IGNORE 创建附件记录（处理并发竞态条件）
        //
        //    如果 content_hash 已存在（由其他线程创建），插入会被忽略，不会报错
        let attachment_id = VfsAttachment::generate_id();
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let now_ms = chrono::Utc::now().timestamp_millis();

        // ★ PDF 预处理流水线状态（迁移 V20260204）
        // 由于已经调用了 render_pdf_preview()，Stage 1（文本提取）和 Stage 2（页面渲染）已完成
        // 设置 processing_status 为 'page_rendering'，后续 pipeline 从 Stage 3（OCR）开始
        let (processing_status, processing_progress, processing_started_at): (
            Option<&str>,
            Option<String>,
            Option<i64>,
        ) = if is_pdf {
            let has_text = extracted_text
                .as_ref()
                .map(|t| !t.trim().is_empty())
                .unwrap_or(false);
            let has_preview = preview_json.is_some();

            // 构建 ready_modes
            let mut ready_modes = vec![];
            if has_text {
                ready_modes.push("text".to_string());
            }

            let progress = serde_json::json!({
                "stage": "page_rendering",
                "percent": 25.0,
                "readyModes": ready_modes
            });

            (
                Some("page_rendering"),
                Some(progress.to_string()),
                Some(now_ms),
            )
        } else {
            (None, None, None)
        };

        // ★ 2026-01-26 修复：必须同时提供 sha256 和 file_name
        // 原 textbooks 表有 `sha256 TEXT NOT NULL UNIQUE` 和 `file_name TEXT NOT NULL` 约束
        // 迁移 032 将 textbooks 重命名为 files，保留了这些约束
        // 如果不提供这些字段，INSERT OR IGNORE 会因 NOT NULL 约束而被忽略
        let affected_rows = conn.execute(
            r#"
            INSERT OR IGNORE INTO files (
                id, resource_id, blob_hash, type, name, mime_type, size,
                content_hash, sha256, file_name, created_at, updated_at,
                preview_json, extracted_text, page_count,
                processing_status, processing_progress, processing_started_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
            "#,
            params![
                attachment_id,
                resource_id,
                blob_hash,
                attachment_type,
                params.name,
                params.mime_type,
                size,
                content_hash,
                content_hash, // sha256 = content_hash（保持兼容）
                params.name,  // file_name = name（保持兼容）
                now,
                now,
                preview_json,
                extracted_text,
                page_count,
                processing_status,
                processing_progress,
                processing_started_at,
            ],
        )?;

        if blob_hash.is_some() && resource_id.is_some() {
            if let Err(e) = conn.execute(
                "UPDATE files SET resource_id = COALESCE(resource_id, ?1) WHERE id = ?2",
                params![resource_id.as_deref(), attachment_id],
            ) {
                warn!(
                    "[VFS::AttachmentRepo] Failed to backfill resource_id for attachment {}: {}",
                    attachment_id, e
                );
            }
        }

        // ★ P1 修复: 回写 resources.source_id = attachment_id
        // 这样 vfs_get_all_index_status 才能正确关联附件的多模态/OCR 状态
        if let Some(ref res_id) = resource_id {
            if let Err(e) = conn.execute(
                "UPDATE resources SET source_id = ?1, source_table = 'files' WHERE id = ?2 AND source_id IS NULL",
                params![attachment_id, res_id],
            ) {
                warn!(
                    "[VFS::AttachmentRepo] Failed to backfill source_id for resource {}: {}",
                    res_id, e
                );
            }
        }

        if let (Some(ref resource_id), Some(ref text)) =
            (resource_id.as_ref(), extracted_text.as_ref())
        {
            if !text.trim().is_empty() {
                if let Err(e) = VfsResourceRepo::save_ocr_text_with_conn(conn, resource_id, text) {
                    warn!(
                        "[VFS::AttachmentRepo] Failed to persist OCR text for resource {}: {}",
                        resource_id, e
                    );
                }
            }
        }

        // ★ 优化：PDF 可解析文本按页拆分写入 ocr_pages_json
        // 这样非多模态模式下也能使用页级 OCR 文本
        let ocr_pages_json: Option<String> = if is_pdf {
            if let Some(ref text) = extracted_text {
                if !text.trim().is_empty() {
                    let effective_page_count = page_count.unwrap_or(0).max(1) as usize;
                    let pages = split_text_to_pages(text, effective_page_count);
                    match serde_json::to_string(&pages) {
                        Ok(json) => {
                            info!(
                                "[VFS::AttachmentRepo] PDF text split into {} pages for ocr_pages_json",
                                effective_page_count
                            );
                            Some(json)
                        }
                        Err(e) => {
                            warn!(
                                "[VFS::AttachmentRepo] Failed to serialize ocr_pages_json: {}",
                                e
                            );
                            None
                        }
                    }
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };

        // 6. 判断是新建还是复用
        if affected_rows > 0 {
            // ★ 写入 ocr_pages_json（在附件记录创建后）
            if let Some(ref ocr_json) = ocr_pages_json {
                if let Err(e) = conn.execute(
                    "UPDATE files SET ocr_pages_json = ?1 WHERE id = ?2",
                    params![ocr_json, attachment_id],
                ) {
                    warn!(
                        "[VFS::AttachmentRepo] Failed to write ocr_pages_json for {}: {}",
                        attachment_id, e
                    );
                }
            }
            // 插入成功，说明是新附件
            info!(
                "[VFS::AttachmentRepo] Uploaded new attachment: {} ({} bytes, mode: {})",
                attachment_id,
                size,
                if blob_hash.is_some() {
                    "external"
                } else {
                    "inline"
                }
            );

            let attachment = VfsAttachment {
                id: attachment_id.clone(),
                resource_id,
                blob_hash,
                attachment_type: attachment_type.to_string(),
                name: params.name.clone(),
                mime_type: params.mime_type.clone(),
                size,
                content_hash: content_hash.clone(),
                is_favorite: false,
                created_at: now.clone(),
                updated_at: now,
                // PDF 预渲染字段（迁移 015）
                preview_json,
                extracted_text,
                page_count,
                // 🔧 P0-12 修复：新上传的附件未删除
                deleted_at: None,
            };

            Ok(VfsUploadAttachmentResult {
                source_id: attachment_id,
                resource_hash: content_hash,
                is_new: true,
                attachment,
                processing_status: None,
                processing_percent: None,
                ready_modes: None,
            })
        } else {
            // 插入被忽略，说明 content_hash 已存在（可能由其他线程创建）
            // 查询现有附件并返回
            debug!(
                "[VFS::AttachmentRepo] Hash collision detected, querying existing attachment for hash: {}",
                content_hash
            );

            let existing = Self::get_by_hash_with_conn(conn, &content_hash)?.ok_or_else(|| {
                VfsError::NotFound {
                    resource_type: "Attachment".to_string(),
                    id: format!(
                        "content_hash={} (race condition edge case: should exist but not found)",
                        content_hash
                    ),
                }
            })?;

            // ★ 如果复用附件但缺少 ocr_pages_json，补写页级 OCR
            if let Some(ref ocr_json) = ocr_pages_json {
                let existing_ocr: Option<String> = conn
                    .query_row(
                        "SELECT ocr_pages_json FROM files WHERE id = ?1",
                        params![existing.id],
                        |row| row.get(0),
                    )
                    .optional()?
                    .flatten();
                if existing_ocr.is_none() {
                    if let Err(e) = conn.execute(
                        "UPDATE files SET ocr_pages_json = ?1 WHERE id = ?2",
                        params![ocr_json, existing.id],
                    ) {
                        warn!(
                            "[VFS::AttachmentRepo] Failed to backfill ocr_pages_json for {}: {}",
                            existing.id, e
                        );
                    }
                }
            }

            info!(
                "[VFS::AttachmentRepo] Attachment already exists: {} -> {}",
                content_hash, existing.id
            );

            Ok(VfsUploadAttachmentResult {
                source_id: existing.id.clone(),
                resource_hash: existing.content_hash.clone(),
                is_new: false,
                attachment: existing,
                processing_status: None,
                processing_percent: None,
                ready_modes: None,
            })
        }
    }

    pub fn upload_with_folder(
        db: &VfsDatabase,
        params: VfsUploadAttachmentParams,
        folder_id: Option<&str>,
    ) -> VfsResult<VfsUploadAttachmentResult> {
        let conn = db.get_conn_safe()?;
        Self::upload_with_folder_conn(&conn, db.blobs_dir(), params, folder_id)
    }

    /// ★ 2026-02-08 修复：使用 SAVEPOINT 事务保护，确保 upload + add_to_folder 两步操作的原子性。
    /// 防止 upload 成功但 add_to_folder 失败导致附件缺少文件夹映射（孤儿附件）。
    pub fn upload_with_folder_conn(
        conn: &Connection,
        blobs_dir: &Path,
        params: VfsUploadAttachmentParams,
        folder_id: Option<&str>,
    ) -> VfsResult<VfsUploadAttachmentResult> {
        // ★ SAVEPOINT 事务保护：包裹 upload + folder_item 两步操作
        conn.execute("SAVEPOINT upload_with_folder", [])
            .map_err(|e| {
                error!(
                    "[VFS::AttachmentRepo] Failed to create savepoint for upload_with_folder: {}",
                    e
                );
                VfsError::Database(format!("Failed to create savepoint: {}", e))
            })?;

        let result = (|| -> VfsResult<VfsUploadAttachmentResult> {
            let result = Self::upload_with_conn(conn, blobs_dir, params)?;

            let item_type = if result.attachment.attachment_type == "image" {
                "image"
            } else {
                "file"
            };

            let existing_item = VfsFolderRepo::get_folder_item_by_item_id_with_conn(
                conn,
                item_type,
                &result.source_id,
            )?;

            if existing_item.is_none() {
                let folder_item = VfsFolderItem::new(
                    folder_id.map(|s| s.to_string()),
                    item_type.to_string(),
                    result.source_id.clone(),
                );

                VfsFolderRepo::add_item_to_folder_with_conn(conn, &folder_item)?;

                info!(
                    "[VFS::AttachmentRepo] Created folder_item for attachment: {} -> folder {:?}",
                    result.source_id, folder_id
                );
            } else {
                debug!(
                    "[VFS::AttachmentRepo] folder_item already exists for attachment: {}",
                    result.source_id
                );
            }

            Ok(result)
        })();

        match result {
            Ok(res) => {
                conn.execute("RELEASE upload_with_folder", [])
                    .map_err(|e| {
                        error!(
                            "[VFS::AttachmentRepo] Failed to release savepoint upload_with_folder: {}",
                            e
                        );
                        VfsError::Database(format!("Failed to release savepoint: {}", e))
                    })?;
                Ok(res)
            }
            Err(e) => {
                // 回滚到 savepoint，忽略回滚本身的错误
                let _ = conn.execute("ROLLBACK TO upload_with_folder", []);
                // 释放 savepoint（即使回滚后也需要释放，否则 savepoint 会残留）
                let _ = conn.execute("RELEASE upload_with_folder", []);
                Err(e)
            }
        }
    }

    fn store_inline(
        conn: &Connection,
        data: &[u8],
        params: &VfsUploadAttachmentParams,
        content_hash: &str,
        attachment_type: &str,
    ) -> VfsResult<(Option<String>, Option<String>)> {
        // 将二进制数据编码为 Base64 存储
        let base64_data = STANDARD.encode(data);

        let resource_type = if attachment_type == "image" {
            VfsResourceType::Image
        } else {
            VfsResourceType::File
        };

        let metadata = VfsResourceMetadata {
            name: Some(params.name.clone()),
            mime_type: Some(params.mime_type.clone()),
            size: Some(data.len() as u64),
            ..Default::default()
        };

        let result = VfsResourceRepo::create_or_reuse_with_conn(
            conn,
            resource_type,
            &base64_data,
            None, // source_id（稍后更新）
            None, // source_table
            Some(&metadata),
        )?;

        debug!(
            "[VFS::AttachmentRepo] Stored inline: resource_id={}, hash={}",
            result.resource_id, content_hash
        );

        Ok((Some(result.resource_id), None))
    }

    /// 存储大文件（external 模式）
    fn store_external(
        conn: &Connection,
        blobs_dir: &Path,
        data: &[u8],
        params: &VfsUploadAttachmentParams,
    ) -> VfsResult<(Option<String>, Option<String>)> {
        // 推断文件扩展名
        let extension = Self::infer_extension(&params.mime_type, &params.name);

        let blob = VfsBlobRepo::store_blob_with_conn(
            conn,
            blobs_dir,
            data,
            Some(&params.mime_type),
            extension.as_deref(),
        )?;

        let resource_type = if params.attachment_type.as_deref().unwrap_or("file") == "image" {
            VfsResourceType::Image
        } else {
            VfsResourceType::File
        };

        let metadata = VfsResourceMetadata {
            name: Some(params.name.clone()),
            mime_type: Some(params.mime_type.clone()),
            size: Some(data.len() as u64),
            ..Default::default()
        };

        let resource_result = VfsResourceRepo::create_or_reuse_external_with_conn(
            conn,
            resource_type,
            &blob.hash,
            &blob.hash,
            None,
            None,
            Some(&metadata),
        )?;

        debug!(
            "[VFS::AttachmentRepo] Stored external: blob_hash={}",
            blob.hash
        );

        Ok((Some(resource_result.resource_id), Some(blob.hash)))
    }

    // ========================================================================
    // 查询附件
    // ========================================================================

    /// 获取附件的处理状态
    ///
    /// # 返回
    /// - (processing_status, processing_percent, ready_modes)
    ///
    /// # 说明
    /// 用于复用附件时返回已有的处理状态，让前端正确显示进度
    pub fn get_processing_status_with_conn(
        conn: &Connection,
        attachment_id: &str,
    ) -> VfsResult<(Option<String>, Option<f64>, Option<Vec<String>>)> {
        let result: Result<(Option<String>, Option<String>), _> = conn.query_row(
            "SELECT processing_status, processing_progress FROM files WHERE id = ?1",
            params![attachment_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        );

        match result {
            Ok((status, progress_json)) => {
                // 解析 processing_progress JSON 获取 percent 和 ready_modes
                let (percent, ready_modes) = if let Some(ref json_str) = progress_json {
                    if let Ok(progress) = serde_json::from_str::<serde_json::Value>(json_str) {
                        let percent = progress.get("percent").and_then(|v| v.as_f64());
                        let ready_modes = progress
                            .get("readyModes")
                            .or_else(|| progress.get("ready_modes"))
                            .and_then(|v| v.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                    .collect::<Vec<_>>()
                            });
                        (percent, ready_modes)
                    } else {
                        (None, None)
                    }
                } else {
                    (None, None)
                };

                Ok((status, percent, ready_modes))
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok((None, None, None)),
            Err(e) => {
                warn!(
                    "[VFS::AttachmentRepo] Failed to get processing status for {}: {}",
                    attachment_id, e
                );
                Ok((None, None, None))
            }
        }
    }

    /// 根据 ID 获取附件
    pub fn get_by_id(db: &VfsDatabase, id: &str) -> VfsResult<Option<VfsAttachment>> {
        let conn = db.get_conn_safe()?;
        Self::get_by_id_with_conn(&conn, id)
    }

    /// 根据 ID 获取附件（使用现有连接）
    pub fn get_by_id_with_conn(conn: &Connection, id: &str) -> VfsResult<Option<VfsAttachment>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, resource_id, blob_hash, type, name, mime_type, size,
                   content_hash, is_favorite, created_at, updated_at,
                   preview_json, extracted_text, page_count, deleted_at
            FROM files
            WHERE id = ?1
            "#,
        )?;

        let attachment = stmt
            .query_row(params![id], Self::row_to_attachment)
            .optional()?;

        Ok(attachment)
    }

    /// 列出附件
    ///
    /// # 参数
    /// - `db`: 数据库实例
    /// - `type_filter`: 可选的类型过滤（"image" 或 "file"）
    /// - `limit`: 最大返回数量
    /// - `offset`: 偏移量
    pub fn list(
        db: &VfsDatabase,
        type_filter: Option<&str>,
        limit: i64,
        offset: i64,
    ) -> VfsResult<Vec<VfsAttachment>> {
        let conn = db.get_conn_safe()?;
        Self::list_with_conn(&conn, type_filter, limit, offset)
    }

    /// 列出附件（使用现有连接）
    /// 🔧 P0-12 修复：排除已软删除的附件
    pub fn list_with_conn(
        conn: &Connection,
        type_filter: Option<&str>,
        limit: i64,
        offset: i64,
    ) -> VfsResult<Vec<VfsAttachment>> {
        let (sql, params): (&str, Vec<Box<dyn rusqlite::ToSql>>) = if let Some(t) = type_filter {
            (
                r#"
                SELECT id, resource_id, blob_hash, type, name, mime_type, size,
                       content_hash, is_favorite, created_at, updated_at,
                       preview_json, extracted_text, page_count, deleted_at
                FROM files
                WHERE type = ?1 AND deleted_at IS NULL
                ORDER BY updated_at DESC
                LIMIT ?2 OFFSET ?3
                "#,
                vec![
                    Box::new(t.to_string()) as Box<dyn rusqlite::ToSql>,
                    Box::new(limit),
                    Box::new(offset),
                ],
            )
        } else {
            (
                r#"
                SELECT id, resource_id, blob_hash, type, name, mime_type, size,
                       content_hash, is_favorite, created_at, updated_at,
                       preview_json, extracted_text, page_count, deleted_at
                FROM files
                WHERE deleted_at IS NULL
                ORDER BY updated_at DESC
                LIMIT ?1 OFFSET ?2
                "#,
                vec![
                    Box::new(limit) as Box<dyn rusqlite::ToSql>,
                    Box::new(offset),
                ],
            )
        };

        let mut stmt = conn.prepare(sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();

        let attachments = stmt
            .query_map(params_refs.as_slice(), Self::row_to_attachment)?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(attachments)
    }

    /// 根据内容哈希获取附件
    pub fn get_by_hash(db: &VfsDatabase, content_hash: &str) -> VfsResult<Option<VfsAttachment>> {
        let conn = db.get_conn_safe()?;
        Self::get_by_hash_with_conn(&conn, content_hash)
    }

    /// 根据内容哈希获取附件（使用现有连接）
    ///
    /// ★ P0 修复：优先返回未删除的记录
    /// 使用 ORDER BY deleted_at IS NULL DESC 确保未删除记录优先
    pub fn get_by_hash_with_conn(
        conn: &Connection,
        content_hash: &str,
    ) -> VfsResult<Option<VfsAttachment>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, resource_id, blob_hash, type, name, mime_type, size,
                   content_hash, is_favorite, created_at, updated_at,
                   preview_json, extracted_text, page_count, deleted_at
            FROM files
            WHERE content_hash = ?1
            ORDER BY deleted_at IS NULL DESC
            LIMIT 1
            "#,
        )?;

        let attachment = stmt
            .query_row(params![content_hash], Self::row_to_attachment)
            .optional()?;

        Ok(attachment)
    }

    // ========================================================================
    // 获取内容
    // ========================================================================

    /// 获取附件内容（Base64 编码）
    pub fn get_content(db: &VfsDatabase, id: &str) -> VfsResult<Option<String>> {
        let conn = db.get_conn_safe()?;
        Self::get_content_with_conn(&conn, db.blobs_dir(), id)
    }

    /// 获取附件内容（使用现有连接）
    ///
    /// ★ 2026-01-25 修复：支持从 original_path 读取文件内容
    /// ★ 2026-02-08 收紧：仅允许读取 VFS blobs 目录内的安全路径
    pub fn get_content_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        id: &str,
    ) -> VfsResult<Option<String>> {
        let attachment = match Self::get_by_id_with_conn(conn, id)? {
            Some(a) => a,
            None => return Ok(None),
        };

        if let Some(resource_id) = &attachment.resource_id {
            // Inline 模式：从 resources.data 获取
            // ★ 2026-01-30 修复：显式指定 Option<String> 类型，确保正确处理 NULL 值
            let data: Option<String> = conn
                .query_row(
                    "SELECT data FROM resources WHERE id = ?1",
                    params![resource_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten();

            // ★ 2026-01-25 修复：检查 resources.data 是否是有效的文件内容
            // textbooks 迁移的文件，resources.data 可能存储的是文件路径而非 base64 内容
            let should_fallback = match &data {
                Some(d) => {
                    let trimmed = d.trim();
                    if trimmed.is_empty() {
                        warn!(
                            "[VFS::AttachmentRepo] resources.data is empty for {}: resource_id={}",
                            id, resource_id
                        );
                        true
                    } else if is_probably_base64(trimmed) {
                        false
                    } else if looks_like_path(trimmed) {
                        warn!(
                            "[VFS::AttachmentRepo] resources.data looks like path for {}: resource_id={}, len={}",
                            id, resource_id, trimmed.len()
                        );
                        true
                    } else {
                        // ★ 2026-02-06 修复：resources.data 既不是有效 base64 也不是路径
                        // 可能是迁移残留的文本内容或损坏数据，应回退到 original_path / blob_hash
                        warn!(
                            "[VFS::AttachmentRepo] resources.data is not valid base64 for {}: resource_id={}, len={}, first_chars={:?}",
                            id, resource_id, trimmed.len(),
                            trimmed.chars().take(80).collect::<String>()
                        );
                        true
                    }
                }
                None => {
                    warn!(
                        "[VFS::AttachmentRepo] resources.data is NULL for {}: resource_id={}",
                        id, resource_id
                    );
                    true
                }
            };

            if should_fallback {
                // ★ 回退1：尝试从 original_path 读取实际文件内容
                let original_path: Option<String> = conn
                    .query_row(
                        "SELECT original_path FROM files WHERE id = ?1",
                        params![id],
                        |row| row.get(0),
                    )
                    .optional()?
                    .flatten();

                if let Some(path) = original_path {
                    if Self::is_safe_original_path(blobs_dir, &path) {
                        let path_obj = std::path::Path::new(&path);
                        if path_obj.exists() {
                            match std::fs::read(path_obj) {
                                Ok(file_data) => {
                                    info!(
                                        "[VFS::AttachmentRepo] Fallback to original_path for {}: {}, file_size={}",
                                        id, path, file_data.len()
                                    );
                                    return Ok(Some(STANDARD.encode(file_data)));
                                }
                                Err(e) => {
                                    warn!(
                                        "[VFS::AttachmentRepo] Failed to read original_path: {} - {}",
                                        path, e
                                    );
                                }
                            }
                        } else {
                            warn!(
                                "[VFS::AttachmentRepo] original_path not exists for {}: {}",
                                id, path
                            );
                        }
                    } else {
                        warn!(
                            "[VFS::AttachmentRepo] Blocked unsafe original_path for {}: {}",
                            id, path
                        );
                    }
                }

                // ★ 2026-01-30 修复：回退2：尝试从 blob_hash 读取
                // external 模式的附件同时有 resource_id 和 blob_hash，
                // 当 resources.data 为 NULL 时，应该继续尝试 blob_hash
                if let Some(blob_hash) = &attachment.blob_hash {
                    info!(
                        "[VFS::AttachmentRepo] Fallback to blob_hash for {}: {}",
                        id, blob_hash
                    );
                    if let Some(blob_path) =
                        VfsBlobRepo::get_blob_path_with_conn(conn, blobs_dir, blob_hash)?
                    {
                        let blob_data = std::fs::read(&blob_path).map_err(|e| {
                            VfsError::Io(format!("Failed to read blob file: {}", e))
                        })?;
                        return Ok(Some(STANDARD.encode(blob_data)));
                    } else {
                        warn!(
                            "[VFS::AttachmentRepo] Blob not found for attachment {}: {}",
                            id, blob_hash
                        );
                    }
                }
            }

            Ok(data)
        } else if let Some(blob_hash) = &attachment.blob_hash {
            // External 模式：从 blobs 读取文件
            if let Some(blob_path) =
                VfsBlobRepo::get_blob_path_with_conn(conn, blobs_dir, blob_hash)?
            {
                let data = std::fs::read(&blob_path)
                    .map_err(|e| VfsError::Io(format!("Failed to read blob file: {}", e)))?;
                Ok(Some(STANDARD.encode(data)))
            } else {
                warn!(
                    "[VFS::AttachmentRepo] Blob not found for attachment {}: {}",
                    id, blob_hash
                );
                Ok(None)
            }
        } else {
            // ★ 回退：尝试从 original_path 读取文件（支持 textbooks 迁移的文件）
            let original_path: Option<String> = conn
                .query_row(
                    "SELECT original_path FROM files WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .optional()?
                .flatten();

            if let Some(path) = original_path {
                if Self::is_safe_original_path(blobs_dir, &path) {
                    let path_obj = std::path::Path::new(&path);
                    if path_obj.exists() {
                        match std::fs::read(path_obj) {
                            Ok(data) => {
                                debug!(
                                    "[VFS::AttachmentRepo] Read content from original_path for {}: {}",
                                    id, path
                                );
                                return Ok(Some(STANDARD.encode(data)));
                            }
                            Err(e) => {
                                warn!(
                                    "[VFS::AttachmentRepo] Failed to read original_path for {}: {} - {}",
                                    id, path, e
                                );
                            }
                        }
                    } else {
                        warn!(
                            "[VFS::AttachmentRepo] original_path not found for {}: {}",
                            id, path
                        );
                    }
                } else {
                    warn!(
                        "[VFS::AttachmentRepo] Blocked unsafe original_path for {}: {}",
                        id, path
                    );
                }
            }

            warn!(
                "[VFS::AttachmentRepo] Attachment {} has no resource_id, blob_hash, or valid original_path",
                id
            );
            Ok(None)
        }
    }

    // ========================================================================
    // 收藏管理
    // ========================================================================

    /// 收藏/取消收藏附件
    pub fn set_favorite(db: &VfsDatabase, attachment_id: &str, favorite: bool) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::set_favorite_with_conn(&conn, attachment_id, favorite)
    }

    /// 收藏/取消收藏附件（使用现有连接）
    pub fn set_favorite_with_conn(
        conn: &Connection,
        attachment_id: &str,
        favorite: bool,
    ) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        let updated = conn.execute(
            "UPDATE files SET is_favorite = ?1, updated_at = ?2 WHERE id = ?3",
            params![favorite as i32, now, attachment_id],
        )?;

        if updated == 0 {
            return Err(VfsError::NotFound {
                resource_type: "attachment".to_string(),
                id: attachment_id.to_string(),
            });
        }

        info!(
            "[VFS::AttachmentRepo] Set attachment {} favorite: {}",
            attachment_id, favorite
        );
        Ok(())
    }

    // ========================================================================
    // 永久删除附件
    // ========================================================================

    /// 永久删除附件（硬删除）
    ///
    /// ★ 2025-12-11: 统一命名规范，purge = 永久删除
    /// 注意：附件没有软删除机制（无 deleted_at 字段），直接从数据库中删除。
    /// 关联的 resource 记录也会被删除（如果存在）。
    ///
    /// ## 参数
    /// - `db`: VFS 数据库实例
    /// - `id`: 附件 ID
    pub fn purge_attachment(db: &VfsDatabase, id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::purge_attachment_with_conn(&conn, db.blobs_dir(), id)
    }

    /// 永久删除附件（使用现有连接）
    ///
    /// ★ 2025-12-11: 统一命名规范，purge = 永久删除
    /// 永久删除附件（带事务保护）
    ///
    /// 使用事务确保所有删除操作的原子性，防止数据不一致
    pub fn purge_attachment_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        id: &str,
    ) -> VfsResult<()> {
        info!("[VFS::AttachmentRepo] Purging attachment: {}", id);

        // 先获取附件信息，确认存在（在事务外检查，减少事务持有时间）
        let attachment = match Self::get_by_id_with_conn(conn, id)? {
            Some(a) => {
                debug!(
                    "[VFS::AttachmentRepo] Found attachment in attachments table: id={}, name={}, type={}",
                    a.id, a.name, a.attachment_type
                );
                a
            }
            None => {
                // ★ 附件在 attachments 表中不存在，但可能在 folder_items 中有记录
                // 尝试删除 folder_items 中的记录（兼容旧数据）
                warn!(
                    "[VFS::AttachmentRepo] Attachment not found in attachments table: {}, trying folder_items cleanup",
                    id
                );
                let fi_deleted =
                    conn.execute("DELETE FROM folder_items WHERE item_id = ?1", params![id])?;
                if fi_deleted > 0 {
                    info!(
                        "[VFS::AttachmentRepo] Deleted {} orphan folder_items for: {}",
                        fi_deleted, id
                    );
                    return Ok(());
                }
                return Err(VfsError::NotFound {
                    resource_type: "attachment".to_string(),
                    id: id.to_string(),
                });
            }
        };

        // 保存 resource_id 以便稍后删除
        let resource_id_to_delete = attachment.resource_id.clone();

        // ★ 使用事务包装所有删除操作，确保原子性
        conn.execute("BEGIN IMMEDIATE", []).map_err(|e| {
            error!(
                "[VFS::AttachmentRepo] Failed to begin transaction for purge: {}",
                e
            );
            VfsError::Database(format!("Failed to begin transaction: {}", e))
        })?;

        // 定义回滚宏（将rusqlite::Error转换为VfsError）
        macro_rules! rollback_on_error {
            ($result:expr, $msg:expr) => {
                match $result {
                    Ok(v) => v,
                    Err(e) => {
                        error!("[VFS::AttachmentRepo] {}: {}", $msg, e);
                        let _ = conn.execute("ROLLBACK", []);
                        return Err(VfsError::Database(format!("{}: {}", $msg, e)));
                    }
                }
            };
        }

        // ★ 删除 folder_items 中的关联记录（必须先删除，否则前端仍会显示）
        let fi_deleted = rollback_on_error!(
            conn.execute("DELETE FROM folder_items WHERE item_id = ?1", params![id]),
            "Failed to delete folder_items"
        );
        info!(
            "[VFS::AttachmentRepo] Deleted {} folder_items for attachment: {}",
            fi_deleted, id
        );

        // ★ P0修复：减少 blob 引用计数（附件的 blob_hash + PDF 预渲染页面的 blob_hash）
        // 必须在删除附件记录之前处理，因为需要读取 attachment 信息

        // 1. 处理附件自身的 blob_hash（大文件外部存储）
        if let Some(ref blob_hash) = attachment.blob_hash {
            match VfsBlobRepo::decrement_ref_with_conn(conn, blobs_dir, blob_hash) {
                Ok(new_count) => {
                    info!(
                        "[VFS::AttachmentRepo] Decremented blob ref for attachment: {} -> {}",
                        blob_hash, new_count
                    );
                }
                Err(e) => {
                    // blob 不存在时仅警告，不阻止删除
                    warn!(
                        "[VFS::AttachmentRepo] Failed to decrement blob ref {}: {}",
                        blob_hash, e
                    );
                }
            }
        }

        // 2. 处理 PDF 预渲染页面的 blob_hash
        if let Some(ref preview_json_str) = attachment.preview_json {
            if let Ok(preview) = serde_json::from_str::<PdfPreviewJson>(preview_json_str) {
                for page in &preview.pages {
                    match VfsBlobRepo::decrement_ref_with_conn(conn, blobs_dir, &page.blob_hash) {
                        Ok(new_count) => {
                            debug!(
                                "[VFS::AttachmentRepo] Decremented PDF page blob ref: page={}, hash={} -> {}",
                                page.page_index, page.blob_hash, new_count
                            );
                        }
                        Err(e) => {
                            // 页面 blob 不存在时仅警告
                            warn!(
                                "[VFS::AttachmentRepo] Failed to decrement PDF page blob {}: {}",
                                page.blob_hash, e
                            );
                        }
                    }
                }
                info!(
                    "[VFS::AttachmentRepo] Processed {} PDF preview page blobs for attachment: {}",
                    preview.pages.len(),
                    id
                );
            }
        }

        // ★ 删除附件记录（必须在删除 resources 之前，因为 attachments 有外键引用 resources）
        info!(
            "[VFS::AttachmentRepo] Executing DELETE FROM files WHERE id = {}",
            id
        );
        let deleted = rollback_on_error!(
            conn.execute("DELETE FROM files WHERE id = ?1", params![id]),
            "Failed to delete attachment"
        );

        if deleted == 0 {
            // ★ 如果没有删除任何记录，回滚并返回错误
            error!(
                "[VFS::AttachmentRepo] CRITICAL: Attachment record disappeared during deletion: {}",
                id
            );
            let _ = conn.execute("ROLLBACK", []);
            return Err(VfsError::Other(format!(
                "Attachment record disappeared during deletion: {}. This may indicate a race condition.",
                id
            )));
        }

        info!(
            "[VFS::AttachmentRepo] Successfully deleted attachment record: {} (deleted {} record(s))",
            id, deleted
        );

        // ★ 最后删除关联的 resource（attachments 外键引用已解除）
        if let Some(resource_id) = resource_id_to_delete {
            info!(
                "[VFS::AttachmentRepo] Deleting associated resource: {}",
                resource_id
            );
            let res_deleted = rollback_on_error!(
                conn.execute("DELETE FROM resources WHERE id = ?1", params![&resource_id]),
                "Failed to delete resource"
            );
            info!(
                "[VFS::AttachmentRepo] Deleted {} resources for attachment: {}",
                res_deleted, id
            );
        }

        // ★ 提交事务
        conn.execute("COMMIT", []).map_err(|e| {
            error!(
                "[VFS::AttachmentRepo] Failed to commit purge transaction: {}",
                e
            );
            let _ = conn.execute("ROLLBACK", []);
            VfsError::Database(format!("Failed to commit transaction: {}", e))
        })?;

        info!(
            "[VFS::AttachmentRepo] Successfully completed attachment deletion: {}",
            id
        );

        // ★ P0修复：blob 引用计数已在上方处理，decrement_ref_with_conn 会在引用计数为 0 时自动清理文件

        Ok(())
    }

    // ========================================================================
    // 辅助方法
    // ========================================================================

    /// 解码 Base64 内容
    fn decode_base64(input: &str) -> VfsResult<Vec<u8>> {
        // 处理 Data URL 格式
        let base64_str = if input.starts_with("data:") {
            input
                .split(',')
                .nth(1)
                .ok_or_else(|| VfsError::InvalidArgument {
                    param: "base64".to_string(),
                    reason: "Invalid data URL format".to_string(),
                })?
        } else {
            input
        };

        STANDARD
            .decode(base64_str)
            .map_err(|e| VfsError::InvalidArgument {
                param: "base64".to_string(),
                reason: format!("Invalid base64: {}", e),
            })
    }

    /// 计算 SHA-256 哈希
    fn compute_hash(data: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(data);
        hex::encode(hasher.finalize())
    }

    /// 根据 MIME 类型推断附件类型
    fn infer_type_from_mime(mime_type: &str) -> String {
        if mime_type.starts_with("image/") {
            "image".to_string()
        } else {
            "file".to_string()
        }
    }

    /// 推断文件扩展名
    ///
    /// 与前端 src/components/shared/UnifiedDragDropZone.tsx 的 EXTENSION_TO_MIME 保持一致
    fn infer_extension(mime_type: &str, name: &str) -> Option<String> {
        // 首先尝试从文件名获取
        if let Some(ext) = name.rsplit('.').next() {
            if !ext.is_empty() && ext.len() < 10 {
                return Some(ext.to_lowercase());
            }
        }

        // 根据 MIME 类型推断（与前端 EXTENSION_TO_MIME 映射表保持一致）
        match mime_type {
            // 图片格式
            "image/png" => Some("png".to_string()),
            "image/jpeg" => Some("jpg".to_string()),
            "image/gif" => Some("gif".to_string()),
            "image/bmp" => Some("bmp".to_string()),
            "image/webp" => Some("webp".to_string()),
            "image/svg+xml" => Some("svg".to_string()),
            "image/heic" => Some("heic".to_string()),
            "image/heif" => Some("heif".to_string()),

            // PDF
            "application/pdf" => Some("pdf".to_string()),

            // Office 文档
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => {
                Some("docx".to_string())
            }
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => {
                Some("xlsx".to_string())
            }
            "application/vnd.ms-excel" => Some("xls".to_string()),
            "application/vnd.ms-excel.sheet.binary.macroEnabled.12" => Some("xlsb".to_string()),
            "application/vnd.oasis.opendocument.spreadsheet" => Some("ods".to_string()),
            "application/vnd.openxmlformats-officedocument.presentationml.presentation" => {
                Some("pptx".to_string())
            }

            // 文本格式
            "text/plain" => Some("txt".to_string()),
            "text/markdown" => Some("md".to_string()),
            "text/csv" => Some("csv".to_string()),
            "application/json" => Some("json".to_string()),
            "application/xml" | "text/xml" => Some("xml".to_string()),
            "text/html" => Some("html".to_string()),

            // 电子书与富文本
            "application/epub+zip" => Some("epub".to_string()),
            "application/rtf" | "text/rtf" => Some("rtf".to_string()),

            // 音频格式
            "audio/mpeg" => Some("mp3".to_string()),
            "audio/wav" | "audio/x-wav" => Some("wav".to_string()),
            "audio/ogg" => Some("ogg".to_string()),
            "audio/mp4" | "audio/x-m4a" => Some("m4a".to_string()),
            "audio/flac" => Some("flac".to_string()),
            "audio/aac" => Some("aac".to_string()),
            "audio/x-ms-wma" => Some("wma".to_string()),
            "audio/opus" => Some("opus".to_string()),

            // 视频格式
            "video/mp4" => Some("mp4".to_string()),
            "video/webm" => Some("webm".to_string()),
            "video/quicktime" => Some("mov".to_string()),
            "video/x-msvideo" => Some("avi".to_string()),
            "video/x-matroska" => Some("mkv".to_string()),
            "video/x-m4v" => Some("m4v".to_string()),
            "video/x-ms-wmv" => Some("wmv".to_string()),
            "video/x-flv" => Some("flv".to_string()),

            _ => None,
        }
    }

    /// 从行数据构建 VfsAttachment
    ///
    /// ★ 2026-01-25 修复：处理 mime_type 等字段为 NULL 的情况
    /// 原 textbooks 表迁移过来的文件 mime_type 可能为 NULL
    fn row_to_attachment(row: &rusqlite::Row) -> rusqlite::Result<VfsAttachment> {
        Ok(VfsAttachment {
            id: row.get(0)?,
            resource_id: row.get(1)?,
            blob_hash: row.get(2)?,
            attachment_type: row
                .get::<_, Option<String>>(3)?
                .unwrap_or_else(|| "file".to_string()),
            name: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
            mime_type: row
                .get::<_, Option<String>>(5)?
                .unwrap_or_else(|| "application/octet-stream".to_string()),
            size: row.get::<_, Option<i64>>(6)?.unwrap_or(0),
            content_hash: row.get::<_, Option<String>>(7)?.unwrap_or_default(),
            is_favorite: row.get::<_, Option<i32>>(8)?.unwrap_or(0) != 0,
            created_at: row.get::<_, Option<String>>(9)?.unwrap_or_default(),
            updated_at: row.get::<_, Option<String>>(10)?.unwrap_or_default(),
            // PDF 预渲染字段（迁移 015）
            preview_json: row.get(11)?,
            extracted_text: row.get(12)?,
            page_count: row.get(13)?,
            // 🔧 P0-12 修复：软删除字段（迁移 016）
            deleted_at: row.get(14)?,
        })
    }

    // ========================================================================
    // 🔧 P0-12 修复：软删除/恢复附件
    // ========================================================================

    /// 软删除附件（可恢复）
    ///
    /// 将 deleted_at 设置为当前时间，附件不再在正常列表中显示，但可以恢复。
    pub fn delete_attachment(db: &VfsDatabase, id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::delete_attachment_with_conn(&conn, id)
    }

    /// 软删除附件（使用现有连接）
    pub fn delete_attachment_with_conn(conn: &Connection, id: &str) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        let updated = conn.execute(
            "UPDATE files SET status = 'deleted', deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL AND status = 'active'",
            params![now, id],
        )?;

        if updated == 0 {
            // 可能已删除或不存在
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM files WHERE id = ?1)",
                params![id],
                |row| row.get(0),
            )?;

            if !exists {
                return Err(VfsError::NotFound {
                    resource_type: "attachment".to_string(),
                    id: id.to_string(),
                });
            }
            // 已软删除，静默返回成功
        }

        info!("[VFS::AttachmentRepo] Soft deleted attachment: {}", id);
        Ok(())
    }

    /// 恢复软删除的附件
    pub fn restore_attachment(db: &VfsDatabase, id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::restore_attachment_with_conn(&conn, id)
    }

    /// 恢复软删除的附件（使用现有连接）
    pub fn restore_attachment_with_conn(conn: &Connection, id: &str) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        let updated = conn.execute(
            "UPDATE files SET deleted_at = NULL, status = 'active', updated_at = ?1 WHERE id = ?2 AND deleted_at IS NOT NULL",
            params![now, id],
        )?;

        if updated == 0 {
            // 可能未删除或不存在
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM files WHERE id = ?1)",
                params![id],
                |row| row.get(0),
            )?;

            if !exists {
                return Err(VfsError::NotFound {
                    resource_type: "attachment".to_string(),
                    id: id.to_string(),
                });
            }
            // 未在回收站中，静默返回成功
        }

        info!("[VFS::AttachmentRepo] Restored attachment: {}", id);
        Ok(())
    }

    /// 恢复并重命名附件（用于上传时自动恢复已删除的附件）
    ///
    /// ★ P0 修复：当上传内容与已删除附件哈希相同时，自动恢复并更新名称
    /// ★ P0 修复（审计）：updated == 0 时返回错误而非静默成功，避免并发竞态导致数据不一致
    fn restore_and_rename_with_conn(conn: &Connection, id: &str, new_name: &str) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        let updated = conn.execute(
            "UPDATE files SET deleted_at = NULL, status = 'active', name = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NOT NULL",
            params![new_name, now, id],
        )?;

        if updated == 0 {
            // ★ P0 修复：并发竞态检测 - 可能另一个线程已经恢复了该附件
            // 检查附件是否存在（可能已被其他线程恢复）
            let exists_and_active: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM files WHERE id = ?1 AND deleted_at IS NULL)",
                    params![id],
                    |row| row.get(0),
                )
                .unwrap_or(false);

            if exists_and_active {
                // 附件已被其他线程恢复，这是可接受的并发情况
                info!(
                    "[VFS::AttachmentRepo] Attachment {} already restored by another thread (concurrent restore)",
                    id
                );
                // 仍需更新名称（如果需要的话可以选择性更新）
                let _ = conn.execute(
                    "UPDATE files SET name = ?1, updated_at = ?2 WHERE id = ?3",
                    params![new_name, now, id],
                );
            } else {
                // 附件不存在或仍在回收站但 UPDATE 失败 - 这是异常情况
                error!(
                    "[VFS::AttachmentRepo] restore_and_rename failed: attachment {} not found or still deleted",
                    id
                );
                return Err(VfsError::Other(format!(
                    "Failed to restore attachment {}: concurrent modification or not found",
                    id
                )));
            }
        } else {
            info!(
                "[VFS::AttachmentRepo] Restored and renamed attachment: {} -> {}",
                id, new_name
            );
        }

        Ok(())
    }

    /// 列出已删除的附件（回收站）
    pub fn list_deleted_attachments(
        db: &VfsDatabase,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsAttachment>> {
        let conn = db.get_conn_safe()?;
        Self::list_deleted_attachments_with_conn(&conn, limit, offset)
    }

    /// 列出已删除的附件（使用现有连接）
    pub fn list_deleted_attachments_with_conn(
        conn: &Connection,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsAttachment>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, resource_id, blob_hash, type, name, mime_type, size,
                   content_hash, is_favorite, created_at, updated_at,
                   preview_json, extracted_text, page_count, deleted_at
            FROM files
            WHERE deleted_at IS NOT NULL
            ORDER BY deleted_at DESC
            LIMIT ?1 OFFSET ?2
            "#,
        )?;

        let attachments = stmt
            .query_map(params![limit, offset], Self::row_to_attachment)?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(attachments)
    }

    /// 永久删除所有已软删除的附件
    pub fn purge_deleted_attachments(db: &VfsDatabase) -> VfsResult<usize> {
        let conn = db.get_conn_safe()?;
        let blobs_dir = db.blobs_dir();

        // 先获取所有已删除附件的 ID
        let deleted = Self::list_deleted_attachments_with_conn(&conn, 1000, 0)?;
        let count = deleted.len();

        // 逐个永久删除
        for attachment in deleted {
            if let Err(e) = Self::purge_attachment_with_conn(&conn, blobs_dir, &attachment.id) {
                warn!(
                    "[VFS::AttachmentRepo] Failed to purge attachment {}: {}",
                    attachment.id, e
                );
            }
        }

        info!("[VFS::AttachmentRepo] Purged {} deleted attachments", count);
        Ok(count)
    }

    // ========================================================================
    // 页级 OCR 存储
    // ========================================================================

    /// 保存附件的页级 OCR 文本
    ///
    /// ## 参数
    /// - `attachment_id`: 附件 ID
    /// - `ocr_pages`: 按页索引的 OCR 文本数组，null 表示该页未 OCR 或失败
    pub fn save_ocr_pages(
        db: &VfsDatabase,
        attachment_id: &str,
        ocr_pages: &[Option<String>],
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::save_ocr_pages_with_conn(&conn, attachment_id, ocr_pages)
    }

    pub fn save_ocr_pages_with_conn(
        conn: &Connection,
        attachment_id: &str,
        ocr_pages: &[Option<String>],
    ) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let ocr_json =
            serde_json::to_string(ocr_pages).map_err(|e| VfsError::Serialization(e.to_string()))?;

        let updated = conn.execute(
            "UPDATE files SET ocr_pages_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![ocr_json, now, attachment_id],
        )?;

        if updated == 0 {
            return Err(VfsError::NotFound {
                resource_type: "attachment".to_string(),
                id: attachment_id.to_string(),
            });
        }

        debug!(
            "[VFS::AttachmentRepo] Saved {} OCR pages for attachment {}",
            ocr_pages.len(),
            attachment_id
        );
        Ok(())
    }

    /// 保存单页 OCR 文本
    pub fn save_page_ocr(
        db: &VfsDatabase,
        attachment_id: &str,
        page_index: usize,
        ocr_text: &str,
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::save_page_ocr_with_conn(&conn, attachment_id, page_index, ocr_text)
    }

    pub fn save_page_ocr_with_conn(
        conn: &Connection,
        attachment_id: &str,
        page_index: usize,
        ocr_text: &str,
    ) -> VfsResult<()> {
        // 获取现有 OCR 页面数组
        let existing: Option<String> = conn
            .query_row(
                "SELECT ocr_pages_json FROM files WHERE id = ?1",
                params![attachment_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();

        let mut pages: Vec<Option<String>> = existing
            .as_deref()
            .map(parse_ocr_pages_json)
            .unwrap_or_default();

        // 扩展数组以容纳新页
        while pages.len() <= page_index {
            pages.push(None);
        }
        pages[page_index] = Some(ocr_text.to_string());

        Self::save_ocr_pages_with_conn(conn, attachment_id, &pages)
    }

    /// 获取附件的页级 OCR 文本
    pub fn get_ocr_pages(db: &VfsDatabase, attachment_id: &str) -> VfsResult<Vec<Option<String>>> {
        let conn = db.get_conn_safe()?;
        Self::get_ocr_pages_with_conn(&conn, attachment_id)
    }

    pub fn get_ocr_pages_with_conn(
        conn: &Connection,
        attachment_id: &str,
    ) -> VfsResult<Vec<Option<String>>> {
        let ocr_json: Option<String> = conn
            .query_row(
                "SELECT ocr_pages_json FROM files WHERE id = ?1",
                params![attachment_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();

        let pages: Vec<Option<String>> = ocr_json
            .as_deref()
            .map(parse_ocr_pages_json)
            .unwrap_or_default();

        Ok(pages)
    }

    /// 获取单页 OCR 文本
    pub fn get_page_ocr(
        db: &VfsDatabase,
        attachment_id: &str,
        page_index: usize,
    ) -> VfsResult<Option<String>> {
        let conn = db.get_conn_safe()?;
        Self::get_page_ocr_with_conn(&conn, attachment_id, page_index)
    }

    pub fn get_page_ocr_with_conn(
        conn: &Connection,
        attachment_id: &str,
        page_index: usize,
    ) -> VfsResult<Option<String>> {
        let pages = Self::get_ocr_pages_with_conn(conn, attachment_id)?;
        Ok(pages.get(page_index).cloned().flatten())
    }

    // ========================================================================
    // 多模态索引状态管理（已废弃 - 使用 vfs_index_units 替代）
    // ========================================================================

    /// 获取附件的多模态索引状态
    ///
    /// ⚠️ 已废弃：请使用 `VfsIndexService::get_resource_units` 替代
    #[deprecated(
        since = "2026.1",
        note = "使用 VfsIndexService::get_resource_units 替代"
    )]
    pub fn get_mm_index_state(db: &VfsDatabase, attachment_id: &str) -> VfsResult<Option<String>> {
        let conn = db.get_conn_safe()?;
        Self::get_mm_index_state_with_conn(&conn, attachment_id)
    }

    /// ⚠️ 已废弃
    #[deprecated(
        since = "2026.1",
        note = "使用 VfsIndexService::get_resource_units 替代"
    )]
    #[allow(deprecated)]
    pub fn get_mm_index_state_with_conn(
        conn: &Connection,
        attachment_id: &str,
    ) -> VfsResult<Option<String>> {
        let state: Option<String> = conn
            .query_row(
                "SELECT mm_index_state FROM files WHERE id = ?1",
                params![attachment_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        Ok(state)
    }

    /// 设置附件的多模态索引状态
    ///
    /// ⚠️ 已废弃：请使用 `VfsIndexService` 替代
    #[deprecated(since = "2026.1", note = "使用 VfsIndexService 替代")]
    pub fn set_mm_index_state(
        db: &VfsDatabase,
        attachment_id: &str,
        state: &str,
        error: Option<&str>,
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::set_mm_index_state_with_conn(&conn, attachment_id, state, error)
    }

    /// ⚠️ 已废弃
    #[deprecated(since = "2026.1", note = "使用 VfsIndexService 替代")]
    #[allow(deprecated)]
    pub fn set_mm_index_state_with_conn(
        conn: &Connection,
        attachment_id: &str,
        state: &str,
        error: Option<&str>,
    ) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        let updated = conn.execute(
            "UPDATE files SET mm_index_state = ?1, mm_index_error = ?2, updated_at = ?3 WHERE id = ?4",
            params![state, error, now, attachment_id],
        )?;

        if updated == 0 {
            return Err(VfsError::NotFound {
                resource_type: "attachment".to_string(),
                id: attachment_id.to_string(),
            });
        }

        debug!(
            "[VFS::AttachmentRepo] Set mm_index_state for {}: {}",
            attachment_id, state
        );
        Ok(())
    }

    /// 保存附件的多模态索引页面状态
    ///
    /// ⚠️ 已废弃：请使用 `VfsIndexService::sync_resource_units` 替代
    #[deprecated(
        since = "2026.1",
        note = "使用 VfsIndexService::sync_resource_units 替代"
    )]
    pub fn save_mm_indexed_pages(
        db: &VfsDatabase,
        attachment_id: &str,
        indexed_pages_json: &str,
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::save_mm_indexed_pages_with_conn(&conn, attachment_id, indexed_pages_json)
    }

    /// ⚠️ 已废弃
    #[deprecated(
        since = "2026.1",
        note = "使用 VfsIndexService::sync_resource_units 替代"
    )]
    #[allow(deprecated)]
    pub fn save_mm_indexed_pages_with_conn(
        conn: &Connection,
        attachment_id: &str,
        indexed_pages_json: &str,
    ) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        conn.execute(
            "UPDATE files SET mm_indexed_pages_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![indexed_pages_json, now, attachment_id],
        )?;

        Ok(())
    }
}

// ============================================================================
// 辅助函数
// ============================================================================

/// 将文本按页数拆分（按行均分策略）
///
/// ## 参数
/// - `text`: 要拆分的文本
/// - `page_count`: 目标页数
///
/// ## 返回
/// Vec<Option<String>>，每个元素对应一页的文本，空页为 None
fn split_text_to_pages(text: &str, page_count: usize) -> Vec<Option<String>> {
    if page_count == 0 {
        return vec![];
    }

    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() {
        // 文本为空，返回全 None
        return vec![None; page_count];
    }

    let lines_per_page = (lines.len() as f64 / page_count as f64).ceil() as usize;
    let lines_per_page = lines_per_page.max(1);

    let mut pages: Vec<Option<String>> = Vec::with_capacity(page_count);

    for i in 0..page_count {
        let start = i * lines_per_page;
        if start >= lines.len() {
            // 超出行数，剩余页为 None
            pages.push(None);
        } else {
            let end = (start + lines_per_page).min(lines.len());
            let page_text = lines[start..end].join("\n");
            if page_text.trim().is_empty() {
                pages.push(None);
            } else {
                pages.push(Some(page_text));
            }
        }
    }

    pages
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decode_base64_plain() {
        let input = "SGVsbG8gV29ybGQ="; // "Hello World"
        let result = VfsAttachmentRepo::decode_base64(input).unwrap();
        assert_eq!(result, b"Hello World");
    }

    #[test]
    fn test_decode_base64_data_url() {
        let input = "data:text/plain;base64,SGVsbG8gV29ybGQ=";
        let result = VfsAttachmentRepo::decode_base64(input).unwrap();
        assert_eq!(result, b"Hello World");
    }

    #[test]
    fn test_compute_hash() {
        let hash = VfsAttachmentRepo::compute_hash(b"test");
        assert_eq!(hash.len(), 64); // SHA-256 = 64 hex chars
    }

    #[test]
    fn test_infer_type_from_mime() {
        assert_eq!(
            VfsAttachmentRepo::infer_type_from_mime("image/png"),
            "image"
        );
        assert_eq!(
            VfsAttachmentRepo::infer_type_from_mime("image/jpeg"),
            "image"
        );
        assert_eq!(
            VfsAttachmentRepo::infer_type_from_mime("application/pdf"),
            "file"
        );
        assert_eq!(
            VfsAttachmentRepo::infer_type_from_mime("text/plain"),
            "file"
        );
    }

    #[test]
    fn test_infer_extension() {
        assert_eq!(
            VfsAttachmentRepo::infer_extension("image/png", "test.png"),
            Some("png".to_string())
        );
        assert_eq!(
            VfsAttachmentRepo::infer_extension("image/jpeg", "photo"),
            Some("jpg".to_string())
        );
        assert_eq!(
            VfsAttachmentRepo::infer_extension("application/pdf", "document.pdf"),
            Some("pdf".to_string())
        );
    }

    #[test]
    fn test_is_safe_original_path_allows_textbooks_dir() {
        let uniq = format!(
            "vfs_attachment_repo_test_{}_{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        let slot_root = std::env::temp_dir().join(&uniq);
        let blobs_dir = slot_root.join("blobs");
        let textbooks_dir = slot_root.join("textbooks");
        std::fs::create_dir_all(&blobs_dir).unwrap();
        std::fs::create_dir_all(&textbooks_dir).unwrap();
        let file_path = textbooks_dir.join("test.docx");
        std::fs::write(&file_path, b"docx-bytes").unwrap();

        let safe = VfsAttachmentRepo::is_safe_original_path(
            &blobs_dir,
            file_path.to_string_lossy().as_ref(),
        );
        assert!(safe);

        std::fs::remove_dir_all(slot_root).ok();
    }

    #[test]
    fn test_is_safe_original_path_rejects_external_path() {
        let uniq = format!(
            "vfs_attachment_repo_test_{}_{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        let slot_root = std::env::temp_dir().join(&uniq);
        let blobs_dir = slot_root.join("blobs");
        std::fs::create_dir_all(&blobs_dir).unwrap();

        let external_root = std::env::temp_dir().join(format!("{}_external", uniq));
        std::fs::create_dir_all(&external_root).unwrap();
        let external_file = external_root.join("outside.docx");
        std::fs::write(&external_file, b"outside").unwrap();

        let safe = VfsAttachmentRepo::is_safe_original_path(
            &blobs_dir,
            external_file.to_string_lossy().as_ref(),
        );
        assert!(!safe);

        std::fs::remove_dir_all(slot_root).ok();
        std::fs::remove_dir_all(external_root).ok();
    }
}
