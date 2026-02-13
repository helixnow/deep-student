//! VFS 解引用模块
//!
//! 统一处理 VFS 数据文件的解引用逻辑，支持：
//! - 首次发送模式：返回 ContentBlock 用于 LLM 请求
//! - 历史加载模式：返回文本内容和图片 base64 分离的结构
//!
//! ## 支持的资源类型
//! - **Image**: 图片附件 → ContentBlock::Image
//! - **File**: 文档附件 → 解析为文本 ContentBlock::Text
//! - **Note**: 笔记 → XML 格式 ContentBlock::Text
//! - **Essay**: 作文 → XML 格式 ContentBlock::Text
//! - **Translation**: 翻译 → XML 格式 ContentBlock::Text
//! - **Textbook**: 教材 → 文件名提示 ContentBlock::Text
//! - **Exam**: 题目集识别 → 图文混合 Vec<ContentBlock>
//!
//! ## 使用场景
//! 1. `send_message.rs` - 重试/编辑重发时恢复 context_snapshot
//! 2. `pipeline.rs` - 历史消息加载时注入上下文
//!
//! ## 创建日期
//! 2025-12-10

use rusqlite::Connection;
use serde_json::Value;
use std::path::Path;

use crate::document_parser::DocumentParser;
use crate::vfs::ocr_utils::parse_ocr_pages_json;
use crate::vfs::repos::VfsFileRepo;
use crate::vfs::types::{
    ImageInjectMode, PdfInjectMode, PdfPreviewJson, ResourceInjectModes, VfsContextRefData,
    VfsResourceRef, VfsResourceType,
};

// ★ 使用已有的 ContentBlock 类型，避免重复定义
pub use super::resource_types::ContentBlock;

/// 解析后的资源内容
///
/// 用于历史消息加载场景，文本和图片分离
#[derive(Debug, Clone, Default)]
pub struct ResolvedContent {
    /// 文本内容列表（已格式化为 XML）
    pub text_contents: Vec<String>,
    /// 图片 base64 列表
    pub image_base64_list: Vec<String>,
}

impl ResolvedContent {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.text_contents.is_empty() && self.image_base64_list.is_empty()
    }

    /// 添加文本内容
    pub fn add_text(&mut self, text: String) {
        if !text.is_empty() {
            self.text_contents.push(text);
        }
    }

    /// 添加图片 base64
    pub fn add_image(&mut self, base64: String) {
        if !base64.is_empty() {
            self.image_base64_list.push(base64);
        }
    }

    /// 合并另一个 ResolvedContent
    pub fn merge(&mut self, other: ResolvedContent) {
        self.text_contents.extend(other.text_contents);
        self.image_base64_list.extend(other.image_base64_list);
    }

    /// 转换为格式化的文本内容（用于历史消息注入）
    pub fn to_formatted_text(&self, original_content: &str) -> String {
        if self.text_contents.is_empty() {
            return original_content.to_string();
        }
        format!(
            "{}\n\n---\n\n{}",
            self.text_contents.join("\n\n"),
            original_content
        )
    }
}

/// 解析后的题目集内容（支持图文混合）
#[derive(Debug, Clone, Default)]
pub struct ResolvedExamContent {
    /// 内容块列表（保持图文顺序）
    pub blocks: Vec<ContentBlock>,
}

// ============================================================================
// 核心解引用函数
// ============================================================================

/// 解析单个 VFS 引用，返回 ContentBlock 列表
///
/// 用于首次发送/重试/编辑重发场景
///
/// ## 参数
/// - `conn`: VFS 数据库连接
/// - `blobs_dir`: Blob 文件存储目录
/// - `vfs_ref`: VFS 资源引用
/// - `is_multimodal`: 是否为多模态模式（影响题目集识别的输出格式）
pub fn resolve_vfs_ref_to_blocks(
    conn: &Connection,
    blobs_dir: &Path,
    vfs_ref: &VfsResourceRef,
    is_multimodal: bool,
) -> Vec<ContentBlock> {
    match &vfs_ref.resource_type {
        VfsResourceType::Image => resolve_image(conn, blobs_dir, vfs_ref, is_multimodal),
        VfsResourceType::File => resolve_file(conn, blobs_dir, vfs_ref, is_multimodal),
        VfsResourceType::Note => resolve_note(conn, vfs_ref),
        VfsResourceType::Essay => resolve_essay(conn, vfs_ref),
        VfsResourceType::Translation => resolve_translation(conn, vfs_ref),
        VfsResourceType::Textbook => resolve_textbook(conn, blobs_dir, vfs_ref, is_multimodal),
        VfsResourceType::Exam => resolve_exam(conn, blobs_dir, vfs_ref, is_multimodal),
        VfsResourceType::Retrieval => {
            // ★ Retrieval 是 RAG 检索结果，重试时会重新检索
            // 返回占位文本提示用户这是历史检索结果
            log::debug!(
                "[VfsResolver] Retrieval type {} - returning placeholder",
                vfs_ref.source_id
            );
            vec![ContentBlock::Text {
                text: format!("[检索结果: {}]", vfs_ref.name),
            }]
        }
        VfsResourceType::MindMap => resolve_mindmap(conn, vfs_ref),
    }
}

/// 解析单个 VFS 引用，返回分离的文本和图片内容
///
/// 用于历史消息加载场景
///
/// ## 参数
/// - `conn`: VFS 数据库连接
/// - `blobs_dir`: Blob 文件存储目录
/// - `vfs_ref`: VFS 资源引用
/// - `is_multimodal`: 是否多模态模式（false 时追加 OCR 文本）
pub fn resolve_vfs_ref_to_content(
    conn: &Connection,
    blobs_dir: &Path,
    vfs_ref: &VfsResourceRef,
    is_multimodal: bool,
) -> ResolvedContent {
    let blocks = resolve_vfs_ref_to_blocks(conn, blobs_dir, vfs_ref, is_multimodal);
    blocks_to_content(blocks, &vfs_ref.name)
}

/// 解析 VfsContextRefData，返回 ContentBlock 列表
///
/// 用于首次发送/重试/编辑重发场景
pub fn resolve_context_ref_data_to_blocks(
    conn: &Connection,
    blobs_dir: &Path,
    ref_data: &VfsContextRefData,
    is_multimodal: bool,
) -> Vec<ContentBlock> {
    let mut all_blocks = Vec::new();
    for vfs_ref in &ref_data.refs {
        let blocks = resolve_vfs_ref_to_blocks(conn, blobs_dir, vfs_ref, is_multimodal);
        all_blocks.extend(blocks);
    }
    all_blocks
}

/// 解析 VfsContextRefData，返回分离的文本和图片内容
///
/// 用于历史消息加载场景
///
/// ## 参数
/// - `is_multimodal`: 是否多模态模式（false 时追加 OCR 文本）
pub fn resolve_context_ref_data_to_content(
    conn: &Connection,
    blobs_dir: &Path,
    ref_data: &VfsContextRefData,
    is_multimodal: bool,
) -> ResolvedContent {
    let mut result = ResolvedContent::new();
    for vfs_ref in &ref_data.refs {
        let content = resolve_vfs_ref_to_content(conn, blobs_dir, vfs_ref, is_multimodal);
        result.merge(content);
    }
    result
}

// ============================================================================
// 各资源类型的解析实现
// ============================================================================

/// 解析图片附件（支持用户选择的注入模式）
///
/// ## 注入模式支持
/// - inject_modes.image 包含 Image: 注入原始图片
/// - inject_modes.image 包含 Ocr: 注入 OCR 识别的文本
/// - 如果未指定注入模式或为空，默认返回 image + ocr（最大化）
///
/// ## 2026-02 修复
/// 用户选择即生效，不再在此处判断模型能力。
/// 后端在实际发送给 LLM 时会根据模型能力自动处理。
fn resolve_image(
    conn: &Connection,
    blobs_dir: &Path,
    vfs_ref: &VfsResourceRef,
    is_multimodal: bool,
) -> Vec<ContentBlock> {
    let image_modes = vfs_ref.inject_modes.as_ref().and_then(|m| m.image.as_ref());
    let (include_image, include_ocr, downgraded_non_multimodal) =
        resolve_image_mode_policy(image_modes, is_multimodal);

    log::debug!(
        "[VfsResolver] resolve_image {}: include_image={}, include_ocr={}",
        vfs_ref.source_id,
        include_image,
        include_ocr
    );

    let mut blocks = Vec::new();

    if downgraded_non_multimodal {
        blocks.push(ContentBlock::Text {
            text: "<system_note>模型不支持图片输入，已自动降级为 OCR 文本注入。</system_note>"
                .to_string(),
        });
    }

    // ★ 图片模式：注入图片（优先使用预处理的压缩版本）
    if include_image {
        // ★ P0 架构改造：检查是否有压缩版本，使用压缩版本时 media_type 是 JPEG
        use crate::vfs::repos::VfsBlobRepo;

        let file = VfsFileRepo::get_file_with_conn(conn, &vfs_ref.source_id)
            .ok()
            .flatten();
        let has_compressed = file
            .as_ref()
            .and_then(|f| {
                let compressed_hash = f.compressed_blob_hash.as_ref()?;
                let is_same_as_original = f
                    .blob_hash
                    .as_ref()
                    .map(|h| h == compressed_hash)
                    .unwrap_or(false);
                if is_same_as_original {
                    return Some(false);
                }
                match VfsBlobRepo::get_blob_path_with_conn(conn, blobs_dir, compressed_hash) {
                    Ok(Some(_)) => Some(true),
                    _ => Some(false),
                }
            })
            .unwrap_or(false);

        match VfsFileRepo::get_content_with_conn(conn, blobs_dir, &vfs_ref.source_id) {
            Ok(Some(base64_content)) => {
                // ★ P0 修复：如果使用了压缩版本，media_type 应该是 JPEG
                let media_type = if has_compressed {
                    "image/jpeg".to_string()
                } else {
                    infer_media_type_from_name(&vfs_ref.name)
                };
                log::debug!(
                    "[VfsResolver] Resolved image {}: {} chars, type={}, compressed={}",
                    vfs_ref.source_id,
                    base64_content.len(),
                    media_type,
                    has_compressed
                );
                blocks.push(ContentBlock::Image {
                    media_type,
                    base64: base64_content,
                });
            }
            Ok(None) => {
                log::warn!(
                    "[VfsResolver] Image content not found: {}",
                    vfs_ref.source_id
                );
            }
            Err(e) => {
                log::warn!(
                    "[VfsResolver] Failed to get image {}: {}",
                    vfs_ref.source_id,
                    e
                );
            }
        }
    }

    // ★ OCR 模式：注入 OCR 文本
    if include_ocr {
        if let Some(ocr_text) = get_image_ocr_text(conn, vfs_ref) {
            log::debug!(
                "[VfsResolver] Image {} OCR text appended: {} chars",
                vfs_ref.source_id,
                ocr_text.len()
            );
            blocks.push(ContentBlock::Text {
                text: format!(
                    "<image_ocr name=\"{}\">{}</image_ocr>",
                    escape_xml_attr(&vfs_ref.name),
                    escape_xml_content(&ocr_text)
                ),
            });
        } else {
            log::debug!(
                "[VfsResolver] Image {} has no OCR text available",
                vfs_ref.source_id
            );
        }
    }

    // 如果没有任何内容块，返回错误提示
    if blocks.is_empty() {
        log::warn!(
            "[VfsResolver] Image {} produced no content blocks (image={}, ocr={})",
            vfs_ref.source_id,
            include_image,
            include_ocr
        );
        return vec![ContentBlock::Text {
            text: format!("[图片加载失败: {}]", vfs_ref.name),
        }];
    }

    blocks
}

/// 获取图片的 OCR 文本
///
/// 从 resources.ocr_text 或附件关联的 resource 中获取 OCR 文本
fn get_image_ocr_text(conn: &Connection, vfs_ref: &VfsResourceRef) -> Option<String> {
    // 尝试从附件关联的 resource 获取 OCR 文本
    let sql = r#"
        SELECT r.ocr_text
        FROM files a
        JOIN resources r ON a.resource_id = r.id
        WHERE a.id = ?1 OR a.resource_id = ?1
        ORDER BY CASE WHEN a.id = ?1 THEN 0 ELSE 1 END
        LIMIT 1
    "#;

    match conn.query_row(sql, rusqlite::params![vfs_ref.source_id], |row| {
        row.get::<_, Option<String>>(0)
    }) {
        Ok(Some(text)) if !text.trim().is_empty() => Some(text),
        _ => None,
    }
}

fn resolve_image_mode_policy(
    image_modes: Option<&Vec<ImageInjectMode>>,
    is_multimodal: bool,
) -> (bool, bool, bool) {
    let (mut include_image, include_ocr) = match image_modes {
        Some(modes) if !modes.is_empty() => (
            modes.contains(&ImageInjectMode::Image),
            modes.contains(&ImageInjectMode::Ocr),
        ),
        // 默认最大化：图片 + OCR 同时注入
        _ => (true, true),
    };

    let downgraded_non_multimodal = !is_multimodal && include_image;
    if downgraded_non_multimodal {
        include_image = false;
    }
    (include_image, include_ocr, downgraded_non_multimodal)
}

fn resolve_pdf_mode_policy(
    pdf_modes: Option<&Vec<PdfInjectMode>>,
    is_multimodal: bool,
) -> (bool, bool, bool, bool) {
    let (include_text, include_ocr, mut include_image) = match pdf_modes {
        Some(modes) if !modes.is_empty() => (
            modes.contains(&PdfInjectMode::Text),
            modes.contains(&PdfInjectMode::Ocr),
            modes.contains(&PdfInjectMode::Image),
        ),
        // 默认最大化：text + ocr + image
        _ => (true, true, true),
    };

    let downgraded_non_multimodal = !is_multimodal && include_image;
    if downgraded_non_multimodal {
        include_image = false;
    }
    (
        include_text,
        include_ocr,
        include_image,
        downgraded_non_multimodal,
    )
}

/// 解析文档附件（支持双模式）
///
/// ## 双模式支持（迁移 015）
/// - 文本模式 (is_multimodal=false): 返回提取的文本
/// - 多模态模式 (is_multimodal=true): 如果是 PDF 且有预渲染图片，返回图片；否则返回文本
fn resolve_file(
    conn: &Connection,
    blobs_dir: &Path,
    vfs_ref: &VfsResourceRef,
    is_multimodal: bool,
) -> Vec<ContentBlock> {
    let is_pdf = vfs_ref.name.to_lowercase().ends_with(".pdf");

    // PDF 双模式处理
    if is_pdf {
        return resolve_pdf(conn, blobs_dir, vfs_ref, is_multimodal);
    }

    // 非 PDF 文件：优先使用存储的 extracted_text，回退到实时解析
    // 1. 尝试从 attachments.extracted_text 获取已存储的文本
    let stored_text: Option<String> = conn
        .query_row(
            "SELECT extracted_text FROM files WHERE id = ?1 OR resource_id = ?1 ORDER BY CASE WHEN id = ?1 THEN 0 ELSE 1 END LIMIT 1",
            rusqlite::params![vfs_ref.source_id],
            |row| row.get(0),
        )
        .ok()
        .flatten()
        .filter(|t: &String| !t.trim().is_empty());

    if let Some(text) = stored_text {
        log::debug!(
            "[VfsResolver] Using stored extracted_text for {}: {} chars",
            vfs_ref.source_id,
            text.len()
        );
        return vec![ContentBlock::Text {
            text: format!(
                "<file name=\"{}\">{}</file>",
                escape_xml_attr(&vfs_ref.name),
                escape_xml_content(&text)
            ),
        }];
    }

    // 2. 回退：实时解析（兼容旧数据）
    match VfsFileRepo::get_content_with_conn(conn, blobs_dir, &vfs_ref.source_id) {
        Ok(Some(base64_content)) => {
            let parser = DocumentParser::new();
            match parser.extract_text_from_base64(&vfs_ref.name, &base64_content) {
                Ok(text) => {
                    log::debug!(
                        "[VfsResolver] Parsed document {}: {} chars (fallback)",
                        vfs_ref.source_id,
                        text.len()
                    );
                    vec![ContentBlock::Text {
                        text: format!(
                            "<file name=\"{}\">{}</file>",
                            escape_xml_attr(&vfs_ref.name),
                            escape_xml_content(&text)
                        ),
                    }]
                }
                Err(e) => {
                    log::warn!(
                        "[VfsResolver] Failed to parse document {}: {}",
                        vfs_ref.source_id,
                        e
                    );
                    vec![ContentBlock::Text {
                        text: format!("[文档解析失败: {}]", vfs_ref.name),
                    }]
                }
            }
        }
        Ok(None) => {
            log::debug!("[VfsResolver] No content for file: {}", vfs_ref.source_id);
            vec![]
        }
        Err(e) => {
            log::warn!(
                "[VfsResolver] Failed to get file {}: {}",
                vfs_ref.source_id,
                e
            );
            vec![]
        }
    }
}

// ============================================================================
// PDF 引用与页码辅助函数
// ============================================================================

fn build_pdf_ref_tag(source_id: &str, page_number: usize) -> String {
    format!("[PDF@{}:{}]", source_id, page_number)
}

fn build_pdf_page_label(vfs_ref: &VfsResourceRef, page_number: usize) -> String {
    let ref_tag = build_pdf_ref_tag(&vfs_ref.source_id, page_number);
    format!(
        "{} {} 第{}页",
        ref_tag,
        escape_xml_content(&vfs_ref.name),
        page_number
    )
}

fn build_pdf_page_label_block(vfs_ref: &VfsResourceRef, page_number: usize) -> ContentBlock {
    let label = build_pdf_page_label(vfs_ref, page_number);
    ContentBlock::Text {
        text: format!(
            "<pdf_page name=\"{}\" source_id=\"{}\" page=\"{}\">{}</pdf_page>",
            escape_xml_attr(&vfs_ref.name),
            escape_xml_attr(&vfs_ref.source_id),
            page_number,
            label
        ),
    }
}

fn format_pdf_page_text(vfs_ref: &VfsResourceRef, page_number: usize, page_text: &str) -> String {
    let label = build_pdf_page_label(vfs_ref, page_number);
    format!(
        "<pdf_page name=\"{}\" source_id=\"{}\" page=\"{}\">{}\n{}</pdf_page>",
        escape_xml_attr(&vfs_ref.name),
        escape_xml_attr(&vfs_ref.source_id),
        page_number,
        label,
        escape_xml_content(page_text.trim())
    )
}

fn format_pdf_pages_text(vfs_ref: &VfsResourceRef, pages: &[Option<String>]) -> Option<String> {
    let mut result = String::new();
    for (index, page_text) in pages.iter().enumerate() {
        let Some(text) = page_text else { continue };
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !result.is_empty() {
            result.push_str("\n\n");
        }
        result.push_str(&format_pdf_page_text(vfs_ref, index + 1, trimmed));
    }
    if result.is_empty() {
        None
    } else {
        Some(result)
    }
}

fn split_pdf_text_by_page(text: &str) -> Vec<String> {
    let parts: Vec<String> = text
        .split('\u{0C}')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();
    if parts.is_empty() {
        vec![text.trim().to_string()]
    } else {
        parts
    }
}

fn format_pdf_text_with_page_markers(vfs_ref: &VfsResourceRef, text: &str) -> String {
    let pages = split_pdf_text_by_page(text);
    let mut result = String::new();
    for (index, page_text) in pages.iter().enumerate() {
        if page_text.trim().is_empty() {
            continue;
        }
        if !result.is_empty() {
            result.push_str("\n\n");
        }
        result.push_str(&format_pdf_page_text(vfs_ref, index + 1, page_text));
    }
    result
}

fn build_pdf_meta_block(vfs_ref: &VfsResourceRef, total_pages: Option<usize>) -> ContentBlock {
    let total_hint = total_pages
        .map(|count| format!(" total_pages=\"{}\"", count))
        .unwrap_or_default();
    let example_tag = build_pdf_ref_tag(&vfs_ref.source_id, 1);
    ContentBlock::Text {
        text: format!(
            "<pdf_meta name=\"{}\" source_id=\"{}\"{}>引用该 PDF 请使用格式：{}（示例：{}）。输出时必须包含页码。</pdf_meta>",
            escape_xml_attr(&vfs_ref.name),
            escape_xml_attr(&vfs_ref.source_id),
            total_hint,
            example_tag,
            example_tag
        ),
    }
}

/// PDF 解析（支持用户选择的注入模式）
///
/// ## 注入模式支持
/// - inject_modes.pdf 包含 Text: 注入解析提取的文本
/// - inject_modes.pdf 包含 Ocr: 注入 OCR 识别的文本（按页）
/// - inject_modes.pdf 包含 Image: 注入页面图片（需多模态模型支持）
/// - 如果未指定注入模式或为空，默认返回 text + ocr + image（最大化）
///
/// ## P0-32 修复（2026-01-07）
/// 多模态模式同时返回图片块和文本块，确保文本模型也能获取内容。
///
/// ## 2026-02 修复
/// 用户选择即生效，不再在此处判断模型能力。
/// 后端在实际发送给 LLM 时会根据模型能力自动处理。
fn resolve_pdf(
    conn: &Connection,
    blobs_dir: &Path,
    vfs_ref: &VfsResourceRef,
    is_multimodal: bool,
) -> Vec<ContentBlock> {
    let pdf_modes = vfs_ref.inject_modes.as_ref().and_then(|m| m.pdf.as_ref());
    let (include_text, include_ocr, include_image, downgraded_non_multimodal) =
        resolve_pdf_mode_policy(pdf_modes, is_multimodal);

    log::debug!(
        "[VfsResolver] resolve_pdf {}: include_text={}, include_ocr={}, include_image={}",
        vfs_ref.source_id,
        include_text,
        include_ocr,
        include_image
    );

    // 查询 files 表获取预渲染数据
    let sql = "SELECT preview_json, extracted_text, page_count, ocr_pages_json FROM files WHERE id = ?1 OR resource_id = ?1 ORDER BY CASE WHEN id = ?1 THEN 0 ELSE 1 END LIMIT 1";
    match conn.query_row(sql, rusqlite::params![vfs_ref.source_id], |row| {
        Ok((
            row.get::<_, Option<String>>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<i32>>(2)?,
            row.get::<_, Option<String>>(3)?,
        ))
    }) {
        Ok((preview_json, extracted_text, page_count, ocr_pages_json)) => {
            let parsed_preview = preview_json
                .as_ref()
                .and_then(|json| serde_json::from_str::<PdfPreviewJson>(json).ok());
            let total_pages = parsed_preview
                .as_ref()
                .map(|preview| preview.total_pages)
                .or_else(|| {
                    page_count.and_then(|count| {
                        if count > 0 {
                            Some(count as usize)
                        } else {
                            None
                        }
                    })
                });

            let mut blocks = Vec::new();
            let mut truncated = false;
            let mut content_added = false;

            // 元信息：PDF 引用格式与页码说明（所有模式都注入）
            blocks.push(build_pdf_meta_block(vfs_ref, total_pages));
            if downgraded_non_multimodal {
                blocks.push(ContentBlock::Text {
                    text: "<system_note>模型不支持图片输入，已自动移除 PDF 页面图片，保留 OCR 与文本内容。</system_note>".to_string(),
                });
            }

            // ★ 图片模式：注入页面图片（用户选择即使用）
            if include_image {
                if let Some(preview) = parsed_preview.as_ref() {
                    let (image_blocks, was_truncated) =
                        resolve_pdf_multimodal(conn, blobs_dir, preview, vfs_ref);
                    if !image_blocks.is_empty() {
                        blocks.extend(image_blocks);
                        truncated = was_truncated;
                        content_added = true;
                        log::debug!(
                            "[VfsResolver] PDF {} multimodal mode: {} image blocks{}",
                            vfs_ref.source_id,
                            blocks.len(),
                            if truncated { " (truncated)" } else { "" }
                        );
                    }
                } else {
                    log::debug!(
                        "[VfsResolver] PDF {} no preview_json, skipping image mode",
                        vfs_ref.source_id
                    );
                }
            }

            // ★ OCR 模式：注入页级 OCR 文本
            if include_ocr {
                if let Some(ocr_text) = ocr_pages_json
                    .as_ref()
                    .and_then(|json| get_pdf_ocr_pages_text_from_json(json, vfs_ref))
                {
                    log::debug!(
                        "[VfsResolver] PDF {} OCR pages text: {} chars",
                        vfs_ref.source_id,
                        ocr_text.len()
                    );
                    blocks.push(ContentBlock::Text {
                        text: format!(
                            "<pdf_ocr name=\"{}\">{}</pdf_ocr>",
                            escape_xml_attr(&vfs_ref.name),
                            ocr_text
                        ),
                    });
                    content_added = true;
                } else {
                    log::debug!(
                        "[VfsResolver] PDF {} has no OCR pages text available",
                        vfs_ref.source_id
                    );
                }
            }

            // ★ 文本模式：注入解析提取的文本
            if include_text {
                let text_blocks =
                    get_pdf_extracted_text_blocks(&extracted_text, conn, blobs_dir, vfs_ref);
                if !text_blocks.is_empty() {
                    blocks.extend(text_blocks);
                    content_added = true;
                    log::debug!(
                        "[VfsResolver] PDF {} extracted text blocks added",
                        vfs_ref.source_id
                    );
                }
            }

            // 添加截断提示
            if truncated {
                blocks.push(ContentBlock::Text {
                    text: format!(
                        "<system_note>注意：PDF「{}」内容较大，已截断为前 {} 页以节省预算。如需完整内容，请使用文本检索模式。</system_note>",
                        vfs_ref.name,
                        MULTIMODAL_BUDGET_MAX_PAGES
                    ),
                });
            }

            // 如果没有任何内容块，回退到默认文本提取
            if !content_added {
                log::warn!(
                    "[VfsResolver] PDF {} produced no content blocks, falling back to text extraction",
                    vfs_ref.source_id
                );
                let fallback_blocks =
                    get_pdf_text_blocks(&extracted_text, conn, blobs_dir, vfs_ref);
                if !fallback_blocks.is_empty() {
                    blocks.extend(fallback_blocks);
                    content_added = true;
                }
            }

            blocks
        }
        Err(e) => {
            log::debug!(
                "[VfsResolver] PDF attachment {} not found: {}",
                vfs_ref.source_id,
                e
            );
            // 回退到原有的文本提取逻辑
            resolve_pdf_fallback(conn, blobs_dir, vfs_ref)
        }
    }
}

/// 获取 PDF 提取的文本块（不含 OCR，仅 extracted_text）
fn get_pdf_extracted_text_blocks(
    extracted_text: &Option<String>,
    conn: &Connection,
    blobs_dir: &Path,
    vfs_ref: &VfsResourceRef,
) -> Vec<ContentBlock> {
    match extracted_text {
        Some(text) if !text.is_empty() => resolve_pdf_text_only(extracted_text.clone(), vfs_ref),
        _ => {
            // 旧数据兼容：使用 DocumentParser 实时解析
            log::debug!(
                "[VfsResolver] PDF {} no extracted_text, fallback to parser",
                vfs_ref.source_id
            );
            resolve_pdf_fallback(conn, blobs_dir, vfs_ref)
        }
    }
}

/// 获取 PDF 文本块（优先 OCR 页级文本，其次提取文本，最后实时解析）
///
/// ## 优先级
/// 1. ocr_pages_json - 页级 OCR 文本（多模态索引或 PDF 解析生成）
/// 2. extracted_text - PDF 整体提取文本
/// 3. DocumentParser 实时解析（旧数据兼容）
fn get_pdf_text_blocks(
    extracted_text: &Option<String>,
    conn: &Connection,
    blobs_dir: &Path,
    vfs_ref: &VfsResourceRef,
) -> Vec<ContentBlock> {
    // ★ 优先使用 ocr_pages_json（页级 OCR 文本）
    if let Some(ocr_text) = get_pdf_ocr_pages_text(conn, vfs_ref) {
        log::debug!(
            "[VfsResolver] PDF {} using ocr_pages_json: {} chars",
            vfs_ref.source_id,
            ocr_text.len()
        );
        return vec![ContentBlock::Text {
            text: format!(
                "<pdf_ocr name=\"{}\">{}</pdf_ocr>",
                escape_xml_attr(&vfs_ref.name),
                ocr_text
            ),
        }];
    }

    // 其次使用 extracted_text
    match extracted_text {
        Some(text) if !text.is_empty() => resolve_pdf_text_only(extracted_text.clone(), vfs_ref),
        _ => {
            // 旧数据兼容：使用 DocumentParser 实时解析
            log::debug!(
                "[VfsResolver] PDF {} no extracted_text, fallback to parser",
                vfs_ref.source_id
            );
            resolve_pdf_fallback(conn, blobs_dir, vfs_ref)
        }
    }
}

/// 从 ocr_pages_json 获取 PDF 的页级 OCR 文本（带页码引用格式）
fn get_pdf_ocr_pages_text_from_json(ocr_json: &str, vfs_ref: &VfsResourceRef) -> Option<String> {
    let pages = parse_ocr_pages_json(ocr_json);
    if pages.is_empty() {
        return None;
    }
    format_pdf_pages_text(vfs_ref, &pages)
}

/// 从 ocr_pages_json 获取 PDF 的页级 OCR 文本（带页码引用格式）
fn get_pdf_ocr_pages_text(conn: &Connection, vfs_ref: &VfsResourceRef) -> Option<String> {
    let sql = "SELECT ocr_pages_json FROM files WHERE id = ?1 OR resource_id = ?1 ORDER BY CASE WHEN id = ?1 THEN 0 ELSE 1 END LIMIT 1";

    let ocr_json: Option<String> = conn
        .query_row(sql, rusqlite::params![vfs_ref.source_id], |row| row.get(0))
        .ok()
        .flatten();

    let ocr_json = ocr_json?;
    if ocr_json.trim().is_empty() {
        return None;
    }

    get_pdf_ocr_pages_text_from_json(&ocr_json, vfs_ref)
}

/// 多模态上下文预算配置
///
/// ★ P1 新增：控制 PDF 多模态注入的体积，避免性能/成本事故
pub const MULTIMODAL_BUDGET_MAX_PAGES: usize = 100;
pub const MULTIMODAL_BUDGET_MAX_BYTES: usize = 50 * 1024 * 1024; // 50MB

/// PDF 多模态模式：从 blobs 获取预渲染图片（带体积预算）
///
/// ★ P1 修复：添加页数和字节数预算限制，避免大 PDF 打爆 token/内存
///
/// ## 返回值
/// - `(blocks, truncated)`: 图片块列表和是否被截断标记
/// - 当首页就超预算时，返回 `([], true)`，调用方应回退到文本模式
fn resolve_pdf_multimodal(
    conn: &Connection,
    blobs_dir: &Path,
    preview: &PdfPreviewJson,
    vfs_ref: &VfsResourceRef,
) -> (Vec<ContentBlock>, bool) {
    use crate::vfs::repos::VfsBlobRepo;
    use base64::Engine;

    let mut blocks = Vec::new();
    let mut total_bytes = 0usize;
    let mut truncated = false;

    // ★ P1 预算控制：最多处理 MULTIMODAL_BUDGET_MAX_PAGES 页
    for page in preview.pages.iter().take(MULTIMODAL_BUDGET_MAX_PAGES) {
        // 检查字节预算
        if total_bytes >= MULTIMODAL_BUDGET_MAX_BYTES {
            truncated = true;
            log::info!(
                "[VfsResolver] PDF {} truncated: byte budget {} exceeded at page {}",
                vfs_ref.source_id,
                MULTIMODAL_BUDGET_MAX_BYTES,
                blocks.len()
            );
            break;
        }

        // 从 blobs 获取图片（优先使用压缩版本，缺失时回退原图）
        let mut selected_content: Option<(Vec<u8>, bool)> = None;

        if let Some(compressed_hash) = page
            .compressed_blob_hash
            .as_ref()
            .filter(|h| *h != &page.blob_hash)
        {
            match VfsBlobRepo::get_blob_path_with_conn(conn, blobs_dir, compressed_hash) {
                Ok(Some(blob_path)) => match std::fs::read(&blob_path) {
                    Ok(content) => {
                        selected_content = Some((content, true));
                    }
                    Err(e) => {
                        log::warn!("[VfsResolver] Failed to read PDF compressed blob: {}", e);
                    }
                },
                Ok(None) => {
                    log::warn!(
                        "[VfsResolver] PDF compressed blob not found: {}",
                        compressed_hash
                    );
                }
                Err(e) => {
                    log::warn!(
                        "[VfsResolver] Failed to get PDF compressed blob path: {}",
                        e
                    );
                }
            }
        }

        if selected_content.is_none() {
            match VfsBlobRepo::get_blob_path_with_conn(conn, blobs_dir, &page.blob_hash) {
                Ok(Some(blob_path)) => match std::fs::read(&blob_path) {
                    Ok(content) => {
                        selected_content = Some((content, false));
                    }
                    Err(e) => {
                        log::warn!("[VfsResolver] Failed to read PDF blob: {}", e);
                    }
                },
                Ok(None) => {
                    log::warn!("[VfsResolver] PDF blob not found: {}", page.blob_hash);
                }
                Err(e) => {
                    log::warn!("[VfsResolver] Failed to get PDF blob path: {}", e);
                }
            }
        }

        if let Some((content, is_compressed)) = selected_content {
            let base64_content = base64::engine::general_purpose::STANDARD.encode(&content);
            let content_len = base64_content.len();

            // 检查单张图片是否会超预算
            if total_bytes + content_len > MULTIMODAL_BUDGET_MAX_BYTES {
                truncated = true;
                // ★ P1 优化：区分首页超预算和后续页超预算
                if blocks.is_empty() {
                    log::warn!(
                        "[VfsResolver] PDF {} first page exceeds budget ({} > {}MB), fallback to text mode",
                        vfs_ref.source_id, content_len, MULTIMODAL_BUDGET_MAX_BYTES / 1024 / 1024
                    );
                } else {
                    log::info!(
                        "[VfsResolver] PDF {} truncated at page {}: budget exceeded ({} + {} > {})",
                        vfs_ref.source_id,
                        page.page_index,
                        total_bytes,
                        content_len,
                        MULTIMODAL_BUDGET_MAX_BYTES
                    );
                }
                break;
            }

            total_bytes += content_len;
            let media_type = if is_compressed {
                "image/jpeg".to_string()
            } else {
                page.mime_type.clone()
            };
            blocks.push(build_pdf_page_label_block(vfs_ref, page.page_index + 1));
            blocks.push(ContentBlock::Image {
                media_type,
                base64: base64_content,
            });
        }
    }

    // 检查是否因页数限制截断
    if preview.pages.len() > MULTIMODAL_BUDGET_MAX_PAGES {
        truncated = true;
    }

    log::debug!(
        "[VfsResolver] Resolved PDF {} multimodal: {} pages, {} bytes, truncated={}",
        vfs_ref.source_id,
        blocks.len(),
        total_bytes,
        truncated
    );
    (blocks, truncated)
}

/// PDF 文本模式：返回提取的文本
fn resolve_pdf_text_only(
    extracted_text: Option<String>,
    vfs_ref: &VfsResourceRef,
) -> Vec<ContentBlock> {
    match extracted_text {
        Some(text) if !text.is_empty() => {
            log::debug!(
                "[VfsResolver] Resolved PDF {} text: {} chars",
                vfs_ref.source_id,
                text.len()
            );
            let formatted = format_pdf_text_with_page_markers(vfs_ref, &text);
            vec![ContentBlock::Text {
                text: format!(
                    "<pdf_text name=\"{}\">{}</pdf_text>",
                    escape_xml_attr(&vfs_ref.name),
                    formatted
                ),
            }]
        }
        _ => {
            log::debug!(
                "[VfsResolver] PDF {} has no extracted text",
                vfs_ref.source_id
            );
            vec![ContentBlock::Text {
                text: format_pdf_page_text(vfs_ref, 1, "[PDF 无文本内容]"),
            }]
        }
    }
}

/// PDF 回退逻辑：使用 DocumentParser 实时解析
fn resolve_pdf_fallback(
    conn: &Connection,
    blobs_dir: &Path,
    vfs_ref: &VfsResourceRef,
) -> Vec<ContentBlock> {
    match VfsFileRepo::get_content_with_conn(conn, blobs_dir, &vfs_ref.source_id) {
        Ok(Some(base64_content)) => {
            let parser = DocumentParser::new();
            match parser.extract_text_from_base64(&vfs_ref.name, &base64_content) {
                Ok(text) => {
                    log::debug!(
                        "[VfsResolver] Parsed PDF fallback {}: {} chars",
                        vfs_ref.source_id,
                        text.len()
                    );
                    let formatted = format_pdf_text_with_page_markers(vfs_ref, &text);
                    vec![ContentBlock::Text {
                        text: format!(
                            "<pdf_text name=\"{}\">{}</pdf_text>",
                            escape_xml_attr(&vfs_ref.name),
                            formatted
                        ),
                    }]
                }
                Err(e) => {
                    log::warn!(
                        "[VfsResolver] Failed to parse PDF {}: {}",
                        vfs_ref.source_id,
                        e
                    );
                    vec![ContentBlock::Text {
                        text: format_pdf_page_text(vfs_ref, 1, "[PDF 解析失败]"),
                    }]
                }
            }
        }
        Ok(None) => {
            log::debug!("[VfsResolver] No content for PDF: {}", vfs_ref.source_id);
            vec![]
        }
        Err(e) => {
            log::warn!(
                "[VfsResolver] Failed to get PDF {}: {}",
                vfs_ref.source_id,
                e
            );
            vec![]
        }
    }
}

/// 解析笔记
///
/// ★ 2025-12-26 修复：notes 表无 content 字段，需要 JOIN resources 表获取内容
fn resolve_note(conn: &Connection, vfs_ref: &VfsResourceRef) -> Vec<ContentBlock> {
    // ★ 正确的查询：content 存储在 resources.data 中，通过 resource_id 关联
    let sql = r#"
        SELECT r.data, n.title
        FROM notes n
        JOIN resources r ON n.resource_id = r.id
        WHERE n.id = ?1
    "#;
    match conn.query_row(sql, rusqlite::params![vfs_ref.source_id], |row| {
        let content: Option<String> = row.get(0)?;
        let title: Option<String> = row.get(1)?;
        Ok((content, title))
    }) {
        Ok((Some(content), title)) => {
            let title_str = title.unwrap_or_else(|| vfs_ref.name.clone());
            log::debug!(
                "[VfsResolver] Resolved note {}: {} chars",
                vfs_ref.source_id,
                content.len()
            );
            vec![ContentBlock::Text {
                text: format!(
                    "<note title=\"{}\">{}</note>",
                    escape_xml_attr(&title_str),
                    escape_xml_content(&content)
                ),
            }]
        }
        Ok((None, _)) => {
            log::debug!("[VfsResolver] Note has no content: {}", vfs_ref.source_id);
            vec![]
        }
        Err(e) => {
            log::debug!("[VfsResolver] Note not found {}: {}", vfs_ref.source_id, e);
            vec![]
        }
    }
}

/// 解析作文
///
/// ★ 2025-12-26 修复：essays 表无 content 字段，需要 JOIN resources 表获取内容
/// ★ 2026-02-09 修复：essay_session_ ID 需要查 essay_sessions 表并聚合所有轮次内容
fn resolve_essay(conn: &Connection, vfs_ref: &VfsResourceRef) -> Vec<ContentBlock> {
    // ★ 2026-02-09 修复：essay_session_ 是作文会话，需要聚合所有轮次
    if vfs_ref.source_id.starts_with("essay_session_") {
        return resolve_essay_session(conn, vfs_ref);
    }

    // 单个作文轮次：content 存储在 resources.data 中，通过 resource_id 关联
    let sql = r#"
        SELECT r.data, e.title
        FROM essays e
        JOIN resources r ON e.resource_id = r.id
        WHERE e.id = ?1
    "#;
    match conn.query_row(sql, rusqlite::params![vfs_ref.source_id], |row| {
        let content: Option<String> = row.get(0)?;
        let title: Option<String> = row.get(1)?;
        Ok((content, title))
    }) {
        Ok((Some(content), title)) => {
            let title_str = title.unwrap_or_else(|| vfs_ref.name.clone());
            log::debug!(
                "[VfsResolver] Resolved essay {}: {} chars",
                vfs_ref.source_id,
                content.len()
            );
            vec![ContentBlock::Text {
                text: format!(
                    "<essay title=\"{}\">{}</essay>",
                    escape_xml_attr(&title_str),
                    escape_xml_content(&content)
                ),
            }]
        }
        Ok((None, _)) => {
            log::debug!("[VfsResolver] Essay has no content: {}", vfs_ref.source_id);
            vec![]
        }
        Err(e) => {
            log::debug!("[VfsResolver] Essay not found {}: {}", vfs_ref.source_id, e);
            vec![]
        }
    }
}

/// ★ 2026-02-09 新增：解析作文会话（聚合所有轮次内容）
///
/// essay_sessions 表没有 resource_id，是聚合容器。
/// 需要查询会话信息 + 关联的所有 essays 轮次内容。
fn resolve_essay_session(conn: &Connection, vfs_ref: &VfsResourceRef) -> Vec<ContentBlock> {
    const MAX_CHARS: usize = 20000;
    const MAX_ROUNDS: usize = 10;

    // 1. 获取会话信息
    // ★ 2026-02-09 CR 修复：不使用 .ok() 吞掉错误，区分 NotFound 和真正的 SQL 错误
    let session_info = match conn.query_row(
        r#"
            SELECT COALESCE(title, ''), essay_type, total_rounds
            FROM essay_sessions
            WHERE id = ?1 AND deleted_at IS NULL
            "#,
        rusqlite::params![vfs_ref.source_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, i32>(2)?,
            ))
        },
    ) {
        Ok(info) => info,
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            log::debug!(
                "[VfsResolver] Essay session not found: {}",
                vfs_ref.source_id
            );
            return vec![];
        }
        Err(e) => {
            log::warn!(
                "[VfsResolver] Failed to query essay session {}: {}",
                vfs_ref.source_id,
                e
            );
            return vec![];
        }
    };

    let (title, essay_type, total_rounds) = session_info;

    // 2. 获取所有轮次内容
    let mut stmt = match conn.prepare(
        r#"
        SELECT e.round_number, r.data
        FROM essays e
        LEFT JOIN resources r ON e.resource_id = r.id
        WHERE e.session_id = ?1 AND e.deleted_at IS NULL
        ORDER BY e.round_number ASC, e.created_at ASC
        "#,
    ) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[VfsResolver] Failed to prepare essay rounds query: {}", e);
            return vec![];
        }
    };

    // ★ 2026-02-09 CR 修复：不使用 .ok() 吞掉 query_map 错误
    let rows: Vec<(i32, Option<String>)> = match stmt
        .query_map(rusqlite::params![vfs_ref.source_id], |row| {
            Ok((row.get(0)?, row.get::<_, Option<String>>(1)?))
        }) {
        Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
        Err(e) => {
            log::warn!(
                "[VfsResolver] Failed to query essay rounds for {}: {}",
                vfs_ref.source_id,
                e
            );
            vec![]
        }
    };

    // 3. 构建聚合内容
    let display_title = if title.is_empty() {
        vfs_ref.name.clone()
    } else {
        title
    };

    let mut parts: Vec<String> = Vec::new();
    let mut total_chars: usize = 0;
    let mut truncated = false;

    let header = format!(
        "# 作文会话: {}\n类型: {}, 总轮次: {}",
        display_title,
        essay_type.as_deref().unwrap_or("未知"),
        total_rounds
    );
    total_chars += header.chars().count();
    parts.push(header);

    let rounds_to_take = MAX_ROUNDS.min(rows.len());
    if rows.len() > rounds_to_take {
        truncated = true;
    }

    for (round_number, content) in rows.iter().take(rounds_to_take) {
        let round_header = format!("\n## 第 {} 轮", round_number);
        total_chars += round_header.chars().count();
        if total_chars >= MAX_CHARS {
            truncated = true;
            break;
        }
        parts.push(round_header);

        if let Some(c) = content {
            let remaining = MAX_CHARS.saturating_sub(total_chars);
            let char_count = c.chars().count();
            if char_count > remaining {
                let truncated_content: String = c.chars().take(remaining).collect();
                parts.push(truncated_content);
                truncated = true;
                break;
            }
            total_chars += char_count;
            parts.push(c.clone());
        }
    }

    if truncated {
        parts.push("\n\n[内容过长，已截断]".to_string());
    }

    let full_content = parts.join("\n");
    log::debug!(
        "[VfsResolver] Resolved essay session {}: {} rounds, {} chars",
        vfs_ref.source_id,
        rounds_to_take,
        full_content.len()
    );

    vec![ContentBlock::Text {
        text: format!(
            "<essay title=\"{}\">{}</essay>",
            escape_xml_attr(&display_title),
            escape_xml_content(&full_content)
        ),
    }]
}

/// 解析翻译
///
/// ★ 2025-12-26 修复：translations 表无 original_text/translated_text 字段
/// 内容存储在 resources.data 中，格式为 JSON: { "source": "...", "translated": "..." }
fn resolve_translation(conn: &Connection, vfs_ref: &VfsResourceRef) -> Vec<ContentBlock> {
    // ★ 正确的查询：content 存储在 resources.data 中，通过 resource_id 关联
    let sql = r#"
        SELECT r.data, t.title
        FROM translations t
        JOIN resources r ON t.resource_id = r.id
        WHERE t.id = ?1
    "#;
    match conn.query_row(sql, rusqlite::params![vfs_ref.source_id], |row| {
        let data: Option<String> = row.get(0)?;
        let title: Option<String> = row.get(1)?;
        Ok((data, title))
    }) {
        Ok((Some(data), title)) => {
            // ★ 解析 JSON 格式的翻译内容
            let title_str = title.unwrap_or_else(|| vfs_ref.name.clone());
            match serde_json::from_str::<serde_json::Value>(&data) {
                Ok(json) => {
                    let source = json.get("source").and_then(|v| v.as_str()).unwrap_or("");
                    let translated = json
                        .get("translated")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");

                    let mut content = String::new();
                    if !source.is_empty() {
                        content.push_str(&format!(
                            "<original>\n{}\n</original>\n",
                            escape_xml_content(source)
                        ));
                    }
                    if !translated.is_empty() {
                        content.push_str(&format!(
                            "<translated>\n{}\n</translated>",
                            escape_xml_content(translated)
                        ));
                    }

                    if content.is_empty() {
                        log::debug!(
                            "[VfsResolver] Translation has empty source/translated: {}",
                            vfs_ref.source_id
                        );
                        vec![]
                    } else {
                        log::debug!(
                            "[VfsResolver] Resolved translation {}: {} chars",
                            vfs_ref.source_id,
                            content.len()
                        );
                        vec![ContentBlock::Text {
                            text: format!(
                                "<translation title=\"{}\">\n{}\n</translation>",
                                escape_xml_attr(&title_str),
                                content
                            ),
                        }]
                    }
                }
                Err(e) => {
                    log::warn!(
                        "[VfsResolver] Failed to parse translation JSON {}: {}",
                        vfs_ref.source_id,
                        e
                    );
                    // 回退：直接使用原始数据
                    vec![ContentBlock::Text {
                        text: format!(
                            "<translation title=\"{}\">{}</translation>",
                            escape_xml_attr(&title_str),
                            escape_xml_content(&data)
                        ),
                    }]
                }
            }
        }
        Ok((None, _)) => {
            log::debug!(
                "[VfsResolver] Translation has no content: {}",
                vfs_ref.source_id
            );
            vec![]
        }
        Err(e) => {
            log::debug!(
                "[VfsResolver] Translation not found {}: {}",
                vfs_ref.source_id,
                e
            );
            vec![]
        }
    }
}

/// 解析知识导图
///
/// ★ 2026-01 实现：将 MindMapDocument JSON 转换为结构化文本
/// 格式：树形大纲文本，便于 LLM 理解
fn resolve_mindmap(conn: &Connection, vfs_ref: &VfsResourceRef) -> Vec<ContentBlock> {
    // 从 mindmaps 表获取 resource_id，再从 resources 表获取内容
    let sql = r#"
        SELECT r.data, m.title, m.description
        FROM mindmaps m
        JOIN resources r ON m.resource_id = r.id
        WHERE m.id = ?1 AND m.deleted_at IS NULL
    "#;
    match conn.query_row(sql, rusqlite::params![vfs_ref.source_id], |row| {
        let data: Option<String> = row.get(0)?;
        let title: Option<String> = row.get(1)?;
        let description: Option<String> = row.get(2)?;
        Ok((data, title, description))
    }) {
        Ok((Some(data), title, description)) => {
            let title_str = title.unwrap_or_else(|| vfs_ref.name.clone());

            // 尝试解析 MindMapDocument JSON 并转换为大纲文本
            let outline_text = match serde_json::from_str::<serde_json::Value>(&data) {
                Ok(json) => {
                    // 提取大纲文本
                    let mut outline = String::new();
                    if let Some(root) = json.get("root") {
                        extract_mindmap_outline(root, &mut outline);
                    }
                    if outline.is_empty() {
                        // 回退：直接使用原始 JSON
                        data.clone()
                    } else {
                        outline
                    }
                }
                Err(_) => {
                    // JSON 解析失败，直接使用原始内容
                    data.clone()
                }
            };

            // 构建 XML 格式
            let mut content = String::new();
            if let Some(desc) = description {
                if !desc.trim().is_empty() {
                    content.push_str(&format!(
                        "<description>{}</description>\n",
                        escape_xml_content(&desc)
                    ));
                }
            }
            content.push_str(&format!(
                "<outline>\n{}</outline>",
                escape_xml_content(&outline_text)
            ));

            log::debug!(
                "[VfsResolver] Resolved mindmap {}: {} chars",
                vfs_ref.source_id,
                content.len()
            );
            vec![ContentBlock::Text {
                text: format!(
                    "<mindmap title=\"{}\">\n{}\n</mindmap>",
                    escape_xml_attr(&title_str),
                    content
                ),
            }]
        }
        Ok((None, _, _)) => {
            log::debug!(
                "[VfsResolver] MindMap has no content: {}",
                vfs_ref.source_id
            );
            vec![]
        }
        Err(e) => {
            log::debug!(
                "[VfsResolver] MindMap not found {}: {}",
                vfs_ref.source_id,
                e
            );
            vec![ContentBlock::Text {
                text: format!("[知识导图未找到: {}]", vfs_ref.name),
            }]
        }
    }
}

/// 最大大纲深度限制
const MAX_MINDMAP_OUTLINE_DEPTH: usize = 100;
/// 最大大纲节点数量限制
const MAX_MINDMAP_OUTLINE_NODES: usize = 10000;

/// 提取知识导图节点的大纲文本（迭代 + 限制）
///
/// 将树形结构转换为缩进文本，便于 LLM 理解
fn extract_mindmap_outline(root: &serde_json::Value, output: &mut String) {
    let mut stack: Vec<(&serde_json::Value, usize)> = Vec::new();
    stack.push((root, 0));

    let mut visited = 0usize;
    let mut truncated = false;

    while let Some((node, depth)) = stack.pop() {
        if depth > MAX_MINDMAP_OUTLINE_DEPTH {
            truncated = true;
            continue;
        }

        visited += 1;
        if visited > MAX_MINDMAP_OUTLINE_NODES {
            truncated = true;
            break;
        }

        if let Some(text) = node.get("text").and_then(|t| t.as_str()) {
            for _ in 0..depth {
                output.push_str("  ");
            }
            if depth == 0 {
                output.push_str("# ");
            } else {
                output.push_str("- ");
            }
            output.push_str(text);
            output.push('\n');
        }

        if let Some(children) = node.get("children").and_then(|c| c.as_array()) {
            for child in children.iter().rev() {
                stack.push((child, depth + 1));
            }
        }
    }

    if truncated {
        output.push_str("[outline truncated]\n");
    }
}

/// 解析教材（支持双模式）
///
/// ★ P0-2 修复：支持注入 ocr_pages_json / extracted_text 实际内容
/// ★ P2 修复：支持多模态图片渲染（preview_json）
///
/// ## 2026-02 修复
/// 用户选择即生效，默认返回图片+文本后备。
/// 后端在实际发送给 LLM 时会根据模型能力自动处理。
///
/// ## 文本内容优先级
/// 1. ocr_pages_json - 页级 OCR 文本（多模态索引生成）
/// 2. extracted_text - 整体提取文本（上传时解析）
/// 3. 占位文本（回退）
fn resolve_textbook(
    conn: &Connection,
    blobs_dir: &Path,
    vfs_ref: &VfsResourceRef,
    is_multimodal: bool,
) -> Vec<ContentBlock> {
    let sql = "SELECT file_name, ocr_pages_json, extracted_text, preview_json FROM files WHERE id = ?1 OR resource_id = ?1 ORDER BY CASE WHEN id = ?1 THEN 0 ELSE 1 END LIMIT 1";
    match conn.query_row(sql, rusqlite::params![vfs_ref.source_id], |row| {
        Ok((
            row.get::<_, Option<String>>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
        ))
    }) {
        Ok((file_name, ocr_pages_json, extracted_text, preview_json)) => {
            let file_name = file_name.unwrap_or_else(|| vfs_ref.name.clone());
            let parsed_preview = preview_json
                .as_ref()
                .and_then(|json| serde_json::from_str::<PdfPreviewJson>(json).ok());
            let total_pages = parsed_preview.as_ref().map(|preview| preview.total_pages);
            let meta_block = build_pdf_meta_block(vfs_ref, total_pages);

            // 默认最大化：多模态模型返回图片+文本；文本模型自动降级为文本/OCR
            if is_multimodal {
                if let Some(preview) = parsed_preview.as_ref() {
                    let (mut blocks, truncated) =
                        resolve_textbook_multimodal(conn, blobs_dir, preview, vfs_ref);
                    if !blocks.is_empty() {
                        let mut result = Vec::new();
                        result.push(meta_block);
                        result.append(&mut blocks);

                        // 同时追加文本块作为后备（参考 resolve_pdf）
                        let text_blocks =
                            get_textbook_text_blocks(&ocr_pages_json, &extracted_text, vfs_ref);
                        if !text_blocks.is_empty() {
                            result.extend(text_blocks);
                        }

                        // ★ 2026-01 新增：截断时添加提示信息
                        if truncated {
                            result.push(ContentBlock::Text {
                            text: format!(
                                "<system_note>注意：教材「{}」内容较大，已截断为前 {} 页以节省预算。如需完整内容，请使用文本检索模式。</system_note>",
                                vfs_ref.name,
                                MULTIMODAL_BUDGET_MAX_PAGES
                            ),
                        });
                        }

                        log::debug!(
                            "[VfsResolver] Textbook {} multimodal: {} blocks{}",
                            vfs_ref.source_id,
                            result.len(),
                            if truncated { " (truncated)" } else { "" }
                        );
                        return result;
                    }
                }
            }
            if !is_multimodal && parsed_preview.is_some() {
                log::debug!(
                    "[VfsResolver] Textbook {} downgraded to text/OCR for non-multimodal model",
                    vfs_ref.source_id
                );
            } else {
                log::debug!(
                    "[VfsResolver] Textbook {} no preview, fallback to text",
                    vfs_ref.source_id
                );
            }

            // 文本模式
            let text_blocks = get_textbook_text_blocks(&ocr_pages_json, &extracted_text, vfs_ref);
            if !text_blocks.is_empty() {
                let mut result = Vec::new();
                result.push(meta_block);
                if !is_multimodal {
                    result.push(ContentBlock::Text {
                        text: "<system_note>模型不支持图片输入，教材已自动降级为 OCR/文本注入。</system_note>"
                            .to_string(),
                    });
                }
                result.extend(text_blocks);
                return result;
            }

            // ★ 回退：仅返回文件名提示
            log::debug!(
                "[VfsResolver] Textbook {} has no content, returning filename only: {}",
                vfs_ref.source_id,
                file_name
            );
            vec![
                meta_block,
                ContentBlock::Text {
                    text: format!(
                        "<textbook title=\"{}\">[PDF: {}，暂无文本内容]</textbook>",
                        escape_xml_attr(&vfs_ref.name),
                        escape_xml_content(&file_name)
                    ),
                },
            ]
        }
        Err(e) => {
            log::debug!(
                "[VfsResolver] Textbook not found {}: {}",
                vfs_ref.source_id,
                e
            );
            vec![ContentBlock::Text {
                text: format!("[教材未找到: {}]", vfs_ref.name),
            }]
        }
    }
}

/// 获取教材文本块（用于文本模式和多模态后备）
fn get_textbook_text_blocks(
    ocr_pages_json: &Option<String>,
    extracted_text: &Option<String>,
    vfs_ref: &VfsResourceRef,
) -> Vec<ContentBlock> {
    // ★ 优先使用 ocr_pages_json（页级 OCR 文本）
    if let Some(ref json_str) = ocr_pages_json {
        if !json_str.trim().is_empty() {
            let pages = parse_ocr_pages_json(json_str);
            if let Some(result) = format_pdf_pages_text(vfs_ref, &pages) {
                log::debug!(
                    "[VfsResolver] Textbook {} ocr_pages: {} chars",
                    vfs_ref.source_id,
                    result.len()
                );
                return vec![ContentBlock::Text {
                    text: format!(
                        "<textbook title=\"{}\">{}</textbook>",
                        escape_xml_attr(&vfs_ref.name),
                        result
                    ),
                }];
            }
        }
    }

    // ★ 其次使用 extracted_text
    if let Some(ref text) = extracted_text {
        if !text.trim().is_empty() {
            log::debug!(
                "[VfsResolver] Textbook {} extracted_text: {} chars",
                vfs_ref.source_id,
                text.len()
            );
            let formatted = format_pdf_text_with_page_markers(vfs_ref, text);
            return vec![ContentBlock::Text {
                text: format!(
                    "<textbook title=\"{}\">{}</textbook>",
                    escape_xml_attr(&vfs_ref.name),
                    formatted
                ),
            }];
        }
    }

    vec![]
}

/// 教材多模态模式：从 blobs 获取预渲染图片（参考 resolve_pdf_multimodal）
fn resolve_textbook_multimodal(
    conn: &Connection,
    blobs_dir: &Path,
    preview: &PdfPreviewJson,
    vfs_ref: &VfsResourceRef,
) -> (Vec<ContentBlock>, bool) {
    use crate::vfs::repos::VfsBlobRepo;
    use base64::Engine;

    let mut blocks = Vec::new();
    let mut total_bytes = 0usize;
    let mut truncated = false;

    // 使用与 PDF 相同的预算限制
    for page in preview.pages.iter().take(MULTIMODAL_BUDGET_MAX_PAGES) {
        if total_bytes >= MULTIMODAL_BUDGET_MAX_BYTES {
            truncated = true;
            log::info!(
                "[VfsResolver] Textbook {} truncated: byte budget exceeded at page {}",
                vfs_ref.source_id,
                blocks.len()
            );
            break;
        }

        let mut selected_content: Option<(Vec<u8>, bool)> = None;

        if let Some(compressed_hash) = page
            .compressed_blob_hash
            .as_ref()
            .filter(|h| *h != &page.blob_hash)
        {
            match VfsBlobRepo::get_blob_path_with_conn(conn, blobs_dir, compressed_hash) {
                Ok(Some(blob_path)) => match std::fs::read(&blob_path) {
                    Ok(content) => {
                        selected_content = Some((content, true));
                    }
                    Err(e) => {
                        log::warn!(
                            "[VfsResolver] Failed to read textbook compressed blob: {}",
                            e
                        );
                    }
                },
                Ok(None) => {
                    log::warn!(
                        "[VfsResolver] Textbook compressed blob not found: {}",
                        compressed_hash
                    );
                }
                Err(e) => {
                    log::warn!(
                        "[VfsResolver] Failed to get textbook compressed blob path: {}",
                        e
                    );
                }
            }
        }

        if selected_content.is_none() {
            match VfsBlobRepo::get_blob_path_with_conn(conn, blobs_dir, &page.blob_hash) {
                Ok(Some(blob_path)) => match std::fs::read(&blob_path) {
                    Ok(content) => {
                        selected_content = Some((content, false));
                    }
                    Err(e) => {
                        log::warn!("[VfsResolver] Failed to read textbook blob: {}", e);
                    }
                },
                Ok(None) => {
                    log::warn!("[VfsResolver] Textbook blob not found: {}", page.blob_hash);
                }
                Err(e) => {
                    log::warn!("[VfsResolver] Failed to get textbook blob path: {}", e);
                }
            }
        }

        if let Some((content, is_compressed)) = selected_content {
            let base64_content = base64::engine::general_purpose::STANDARD.encode(&content);
            let content_len = base64_content.len();

            if total_bytes + content_len > MULTIMODAL_BUDGET_MAX_BYTES {
                truncated = true;
                if blocks.is_empty() {
                    log::warn!(
                        "[VfsResolver] Textbook {} first page exceeds budget, fallback to text",
                        vfs_ref.source_id
                    );
                }
                break;
            }

            total_bytes += content_len;
            let media_type = if is_compressed {
                "image/jpeg".to_string()
            } else {
                page.mime_type.clone()
            };
            blocks.push(build_pdf_page_label_block(vfs_ref, page.page_index + 1));
            blocks.push(ContentBlock::Image {
                media_type,
                base64: base64_content,
            });
        }
    }

    if preview.pages.len() > MULTIMODAL_BUDGET_MAX_PAGES {
        truncated = true;
    }

    log::debug!(
        "[VfsResolver] Resolved textbook {} multimodal: {} pages, {} bytes, truncated={}",
        vfs_ref.source_id,
        blocks.len(),
        total_bytes,
        truncated
    );
    (blocks, truncated)
}

/// 解析题目集识别（支持图文混合）
///
/// ## 2026-02 修复
/// 用户选择即生效，默认返回图文混合内容。
/// 后端在实际发送给 LLM 时会根据模型能力自动处理。
fn resolve_exam(
    conn: &Connection,
    blobs_dir: &Path,
    vfs_ref: &VfsResourceRef,
    is_multimodal: bool,
) -> Vec<ContentBlock> {
    let sql = "SELECT preview_json FROM exam_sheets WHERE id = ?1";
    match conn.query_row(sql, rusqlite::params![vfs_ref.source_id], |row| {
        row.get::<_, Option<String>>(0)
    }) {
        Ok(Some(preview_json)) => {
            // 默认最大化：多模态模型图文全注入，文本模型自动降级去图片
            resolve_exam_multimodal(conn, blobs_dir, vfs_ref, &preview_json, is_multimodal)
        }
        Ok(None) => {
            log::debug!(
                "[VfsResolver] Exam has no preview_json: {}",
                vfs_ref.source_id
            );
            vec![]
        }
        Err(e) => {
            log::debug!("[VfsResolver] Exam not found {}: {}", vfs_ref.source_id, e);
            vec![ContentBlock::Text {
                text: format!("[题目集未找到: {}]", vfs_ref.name),
            }]
        }
    }
}

/// 解析题目集识别 - 多模态模式（图文混合）
fn resolve_exam_multimodal(
    conn: &Connection,
    blobs_dir: &Path,
    vfs_ref: &VfsResourceRef,
    preview_json: &str,
    include_images: bool,
) -> Vec<ContentBlock> {
    use crate::vfs::repos::VfsBlobRepo;
    use base64::Engine;

    let preview: serde_json::Value = match serde_json::from_str(preview_json) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[VfsResolver] Failed to parse exam preview_json: {}", e);
            return vec![ContentBlock::Text {
                text: format!("[题目集解析失败: {}]", vfs_ref.name),
            }];
        }
    };

    let mut blocks = Vec::new();
    if !include_images {
        blocks.push(ContentBlock::Text {
            text:
                "<system_note>模型不支持图片输入，题目集已自动降级为文本/OCR 注入。</system_note>"
                    .to_string(),
        });
    }

    // 遍历 pages
    if let Some(pages) = preview.get("pages").and_then(|p| p.as_array()) {
        for page in pages {
            // 获取页面图片
            if include_images {
                if let Some(blob_hash) = page.get("blobHash").and_then(|h| h.as_str()) {
                    // 从 blobs 获取图片文件路径，然后读取内容
                    match VfsBlobRepo::get_blob_path_with_conn(conn, blobs_dir, blob_hash) {
                        Ok(Some(blob_path)) => {
                            // 读取文件内容并编码为 base64
                            match std::fs::read(&blob_path) {
                                Ok(content) => {
                                    let base64_content =
                                        base64::engine::general_purpose::STANDARD.encode(&content);
                                    let mime_type = page
                                        .get("mimeType")
                                        .and_then(|m| m.as_str())
                                        .unwrap_or("image/png");
                                    blocks.push(ContentBlock::Image {
                                        media_type: mime_type.to_string(),
                                        base64: base64_content,
                                    });
                                }
                                Err(e) => {
                                    log::warn!(
                                        "[VfsResolver] Failed to read blob file {:?}: {}",
                                        blob_path,
                                        e
                                    );
                                }
                            }
                        }
                        Ok(None) => {
                            log::warn!("[VfsResolver] Blob not found for exam page: {}", blob_hash);
                        }
                        Err(e) => {
                            log::warn!(
                                "[VfsResolver] Failed to get blob path {}: {}",
                                blob_hash,
                                e
                            );
                        }
                    }
                }
            }

            // 获取该页的 OCR 文本
            if let Some(cards) = page.get("cards").and_then(|c| c.as_array()) {
                let mut page_text = String::new();
                for card in cards {
                    if let Some(label) = card.get("questionLabel").and_then(|l| l.as_str()) {
                        if let Some(ocr) = card.get("ocrText").and_then(|o| o.as_str()) {
                            page_text.push_str(&format!(
                                "<question label=\"{}\">{}</question>\n",
                                escape_xml_attr(label),
                                escape_xml_content(ocr)
                            ));
                        }
                    }
                }
                if !page_text.is_empty() {
                    blocks.push(ContentBlock::Text { text: page_text });
                }
            }
        }
    }

    if include_images {
        append_exam_manual_images(conn, blobs_dir, &vfs_ref.source_id, &mut blocks);
    }

    // 注入作答历史（answer_submissions，每题最近 5 条）
    let history_xml = build_exam_history_xml(conn, &vfs_ref.source_id);
    if !history_xml.is_empty() {
        blocks.push(ContentBlock::Text { text: history_xml });
    }

    log::debug!(
        "[VfsResolver] Resolved exam {} multimodal: {} blocks",
        vfs_ref.source_id,
        blocks.len()
    );
    blocks
}

fn append_exam_manual_images(
    conn: &Connection,
    blobs_dir: &Path,
    exam_id: &str,
    blocks: &mut Vec<ContentBlock>,
) {
    use crate::vfs::repos::VfsBlobRepo;
    use base64::Engine;
    use rusqlite::params;
    use std::collections::HashSet;

    const MAX_MANUAL_IMAGES: usize = 24;
    let sql = r#"
        SELECT COALESCE(question_label, ''), COALESCE(images_json, '[]')
        FROM questions
        WHERE exam_id = ?1
          AND deleted_at IS NULL
    "#;

    let mut stmt = match conn.prepare(sql) {
        Ok(v) => v,
        Err(e) => {
            log::debug!(
                "[VfsResolver] Skip exam manual images (prepare failed): exam_id={}, error={}",
                exam_id,
                e
            );
            return;
        }
    };
    let rows = match stmt.query_map(params![exam_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }) {
        Ok(v) => v,
        Err(e) => {
            log::debug!(
                "[VfsResolver] Skip exam manual images (query failed): exam_id={}, error={}",
                exam_id,
                e
            );
            return;
        }
    };

    let mut seen_hashes: HashSet<String> = HashSet::new();
    let mut injected = 0usize;
    for row in rows.flatten() {
        if injected >= MAX_MANUAL_IMAGES {
            blocks.push(ContentBlock::Text {
                text: "<system_note>题目手动图片较多，已按预算截断。</system_note>".to_string(),
            });
            break;
        }
        let (question_label, images_json) = row;
        let images_value: Value =
            serde_json::from_str(&images_json).unwrap_or_else(|_| Value::Array(vec![]));
        let Some(images) = images_value.as_array() else {
            continue;
        };

        for image in images {
            if injected >= MAX_MANUAL_IMAGES {
                break;
            }
            let (blob_hash, mime_type) = match resolve_question_image_blob(conn, image) {
                Some(v) => v,
                None => continue,
            };
            if !seen_hashes.insert(blob_hash.clone()) {
                continue;
            }
            let blob_path = match VfsBlobRepo::get_blob_path_with_conn(conn, blobs_dir, &blob_hash)
            {
                Ok(Some(path)) => path,
                _ => continue,
            };
            let Ok(content) = std::fs::read(&blob_path) else {
                continue;
            };

            blocks.push(ContentBlock::Text {
                text: format!(
                    "<question_image question=\"{}\">手动图片</question_image>",
                    escape_xml_attr(&question_label)
                ),
            });
            blocks.push(ContentBlock::Image {
                media_type: mime_type,
                base64: base64::engine::general_purpose::STANDARD.encode(&content),
            });
            injected += 1;
        }
    }

    if injected > 0 {
        log::debug!(
            "[VfsResolver] Injected {} manual question images for exam {}",
            injected,
            exam_id
        );
    }
}

fn resolve_question_image_blob(conn: &Connection, image_value: &Value) -> Option<(String, String)> {
    let obj = image_value.as_object()?;
    let mut blob_hash = obj
        .get("hash")
        .and_then(|v| v.as_str())
        .or_else(|| obj.get("blobHash").and_then(|v| v.as_str()))
        .or_else(|| obj.get("compressedBlobHash").and_then(|v| v.as_str()))
        .map(|s| s.to_string());
    let mime_type = obj
        .get("mime")
        .and_then(|v| v.as_str())
        .or_else(|| obj.get("mimeType").and_then(|v| v.as_str()))
        .unwrap_or("image/png")
        .to_string();

    if blob_hash.is_none() {
        if let Some(file_id) = obj
            .get("id")
            .and_then(|v| v.as_str())
            .or_else(|| obj.get("sourceId").and_then(|v| v.as_str()))
        {
            let sql = r#"
                SELECT COALESCE(compressed_blob_hash, blob_hash)
                FROM files
                WHERE id = ?1 OR resource_id = ?1
                LIMIT 1
            "#;
            blob_hash = conn
                .query_row(sql, rusqlite::params![file_id], |row| {
                    row.get::<_, Option<String>>(0)
                })
                .ok()
                .flatten();
        }
    }

    blob_hash.map(|h| (h, mime_type))
}

/// 解析题目集识别 - 文本模式（增强版：支持智能题目集字段）
fn resolve_exam_text_only(preview_json: &str, vfs_ref: &VfsResourceRef) -> Vec<ContentBlock> {
    let preview: serde_json::Value = match serde_json::from_str(preview_json) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[VfsResolver] Failed to parse exam preview_json: {}", e);
            return vec![ContentBlock::Text {
                text: format!("[题目集解析失败: {}]", vfs_ref.name),
            }];
        }
    };

    let mut questions_xml = String::new();
    let mut stats = QuestionBankStatsBuilder::default();

    if let Some(pages) = preview.get("pages").and_then(|p| p.as_array()) {
        for page in pages {
            if let Some(cards) = page.get("cards").and_then(|c| c.as_array()) {
                for card in cards {
                    stats.total += 1;

                    let label = card
                        .get("questionLabel")
                        .and_then(|l| l.as_str())
                        .unwrap_or("");
                    let ocr = card.get("ocrText").and_then(|o| o.as_str()).unwrap_or("");
                    let status = card.get("status").and_then(|s| s.as_str()).unwrap_or("new");
                    let difficulty = card.get("difficulty").and_then(|d| d.as_str());
                    let question_type = card.get("questionType").and_then(|t| t.as_str());
                    let answer = card.get("answer").and_then(|a| a.as_str());
                    let explanation = card.get("explanation").and_then(|e| e.as_str());
                    let user_note = card.get("userNote").and_then(|n| n.as_str());
                    let user_answer = card.get("userAnswer").and_then(|a| a.as_str());
                    let attempt_count = card
                        .get("attemptCount")
                        .and_then(|c| c.as_i64())
                        .unwrap_or(0);
                    let correct_count = card
                        .get("correctCount")
                        .and_then(|c| c.as_i64())
                        .unwrap_or(0);
                    let tags = card.get("tags").and_then(|t| t.as_array()).map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    });

                    match status {
                        "mastered" => stats.mastered += 1,
                        "review" => stats.review += 1,
                        "in_progress" => stats.in_progress += 1,
                        _ => stats.new += 1,
                    }

                    let mut attrs = vec![format!("label=\"{}\"", escape_xml_attr(label))];
                    attrs.push(format!("status=\"{}\"", escape_xml_attr(status)));
                    if let Some(d) = difficulty {
                        attrs.push(format!("difficulty=\"{}\"", escape_xml_attr(d)));
                    }
                    if let Some(t) = question_type {
                        attrs.push(format!("type=\"{}\"", escape_xml_attr(t)));
                    }
                    if attempt_count > 0 {
                        attrs.push(format!("attempts=\"{}\"", attempt_count));
                        attrs.push(format!("correct=\"{}\"", correct_count));
                    }

                    questions_xml.push_str(&format!("<question {}>\n", attrs.join(" ")));
                    questions_xml.push_str(&format!(
                        "  <content>{}</content>\n",
                        escape_xml_content(ocr)
                    ));

                    if let Some(t) = tags {
                        if !t.is_empty() {
                            questions_xml
                                .push_str(&format!("  <tags>{}</tags>\n", escape_xml_content(&t)));
                        }
                    }
                    if let Some(a) = answer {
                        questions_xml
                            .push_str(&format!("  <answer>{}</answer>\n", escape_xml_content(a)));
                    }
                    if let Some(e) = explanation {
                        questions_xml.push_str(&format!(
                            "  <explanation>{}</explanation>\n",
                            escape_xml_content(e)
                        ));
                    }
                    if let Some(ua) = user_answer {
                        questions_xml.push_str(&format!(
                            "  <user_answer>{}</user_answer>\n",
                            escape_xml_content(ua)
                        ));
                    }
                    if let Some(n) = user_note {
                        questions_xml.push_str(&format!(
                            "  <user_note>{}</user_note>\n",
                            escape_xml_content(n)
                        ));
                    }

                    questions_xml.push_str("</question>\n");
                }
            }
        }
    }

    if questions_xml.is_empty() {
        vec![]
    } else {
        let correct_rate = if stats.total > 0 && (stats.mastered + stats.review) > 0 {
            let attempted = stats.mastered + stats.review + stats.in_progress;
            if attempted > 0 {
                Some(format!("{:.2}", stats.mastered as f64 / attempted as f64))
            } else {
                None
            }
        } else {
            None
        };

        let mut stats_xml = format!(
            "<stats total=\"{}\" mastered=\"{}\" review=\"{}\" in_progress=\"{}\" new=\"{}\"",
            stats.total, stats.mastered, stats.review, stats.in_progress, stats.new
        );
        if let Some(rate) = correct_rate {
            stats_xml.push_str(&format!(" correct_rate=\"{}\"", rate));
        }
        stats_xml.push_str("/>");

        log::debug!(
            "[VfsResolver] Resolved exam {} text: {} questions",
            vfs_ref.source_id,
            stats.total
        );

        vec![ContentBlock::Text {
            text: format!(
                "<question_bank id=\"{}\" name=\"{}\">\n{}\n<questions>\n{}</questions>\n</question_bank>",
                escape_xml_attr(&vfs_ref.source_id),
                escape_xml_attr(&vfs_ref.name),
                stats_xml,
                questions_xml
            ),
        }]
    }
}

/// 构建作答历史 XML 补充块
///
/// 查询题目集下所有题目的最近 5 条作答记录，注入到上下文中。
/// ai_feedback 不注入（用户明确要求），仅注入 answer/correct/method/at。
fn build_exam_history_xml(conn: &Connection, exam_id: &str) -> String {
    // 查询该题目集下所有有作答记录的题目
    // 使用子查询限制每题最多 5 条最近作答，避免大题目集截断偏差
    let sql = r#"
        SELECT sub.question_id, sub.question_label, sub.user_answer, sub.is_correct, sub.grading_method, sub.submitted_at
        FROM (
            SELECT s.question_id, q.question_label, s.user_answer, s.is_correct, s.grading_method, s.submitted_at,
                   ROW_NUMBER() OVER (PARTITION BY s.question_id ORDER BY s.submitted_at DESC) AS rn
            FROM answer_submissions s
            INNER JOIN questions q ON q.id = s.question_id
            WHERE q.exam_id = ?1 AND q.deleted_at IS NULL
        ) sub
        WHERE sub.rn <= 5
        ORDER BY sub.question_id, sub.submitted_at DESC
    "#;

    let mut stmt = match conn.prepare(sql) {
        Ok(s) => s,
        Err(e) => {
            log::debug!(
                "[VfsResolver] answer_submissions 查询失败（旧版数据库可忽略）: {}",
                e
            );
            return String::new();
        }
    };

    let rows: Vec<(String, String, String, Option<i32>, String, String)> = stmt
        .query_map(rusqlite::params![exam_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                row.get::<_, String>(2)?,
                row.get::<_, Option<i32>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .ok()
        .map(|iter| iter.filter_map(|r| r.ok()).collect())
        .unwrap_or_default();

    if rows.is_empty() {
        return String::new();
    }

    // 按 question_id 分组，每题最多 5 条
    let mut xml = String::from("<answer_history>\n");
    let mut current_qid = String::new();
    let mut count_per_question = 0;

    for (qid, label, answer, is_correct, method, at) in &rows {
        if *qid != current_qid {
            if !current_qid.is_empty() {
                xml.push_str("  </question_attempts>\n");
            }
            current_qid = qid.clone();
            count_per_question = 0;
            xml.push_str(&format!(
                "  <question_attempts question_id=\"{}\" label=\"{}\">\n",
                escape_xml_attr(qid),
                escape_xml_attr(label),
            ));
        }

        if count_per_question >= 5 {
            continue;
        }
        count_per_question += 1;

        let correct_str = match is_correct {
            Some(1) => "yes",
            Some(0) => "no",
            _ => "pending",
        };

        xml.push_str(&format!(
            "    <attempt n=\"{}\" answer=\"{}\" correct=\"{}\" method=\"{}\" at=\"{}\"/>\n",
            count_per_question,
            escape_xml_attr(answer),
            correct_str,
            escape_xml_attr(method),
            escape_xml_attr(at),
        ));
    }

    if !current_qid.is_empty() {
        xml.push_str("  </question_attempts>\n");
    }
    xml.push_str("</answer_history>");

    xml
}

#[derive(Default)]
struct QuestionBankStatsBuilder {
    total: i32,
    mastered: i32,
    review: i32,
    in_progress: i32,
    new: i32,
}

// ============================================================================
// 辅助函数
// ============================================================================
// 辅助函数
// ============================================================================

/// 将 ContentBlock 列表转换为 ResolvedContent
fn blocks_to_content(blocks: Vec<ContentBlock>, name: &str) -> ResolvedContent {
    let mut result = ResolvedContent::new();
    for block in blocks {
        match block {
            ContentBlock::Text { text } => {
                // 包装为 injected_context 格式
                result.add_text(format!(
                    "<injected_context>\n[{}]\n{}\n</injected_context>",
                    name, text
                ));
            }
            ContentBlock::Image { base64, .. } => {
                result.add_image(base64);
            }
        }
    }
    result
}

/// 从文件名推断 MIME 类型
pub fn infer_media_type_from_name(name: &str) -> String {
    let lower = name.to_lowercase();
    if lower.ends_with(".png") {
        "image/png".to_string()
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg".to_string()
    } else if lower.ends_with(".gif") {
        "image/gif".to_string()
    } else if lower.ends_with(".webp") {
        "image/webp".to_string()
    } else if lower.ends_with(".svg") {
        "image/svg+xml".to_string()
    } else {
        "image/png".to_string() // 默认 PNG
    }
}

/// 转义 XML 属性值
pub fn escape_xml_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// 转义 XML 内容
pub fn escape_xml_content(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn test_escape_xml_attr() {
        assert_eq!(escape_xml_attr("hello"), "hello");
        assert_eq!(escape_xml_attr("a < b"), "a &lt; b");
        assert_eq!(escape_xml_attr("a & b"), "a &amp; b");
        assert_eq!(escape_xml_attr("\"quoted\""), "&quot;quoted&quot;");
    }

    #[test]
    fn test_escape_xml_content() {
        assert_eq!(escape_xml_content("hello"), "hello");
        assert_eq!(escape_xml_content("<tag>"), "&lt;tag&gt;");
        assert_eq!(escape_xml_content("a & b"), "a &amp; b");
    }

    #[test]
    fn test_infer_media_type() {
        assert_eq!(infer_media_type_from_name("test.png"), "image/png");
        assert_eq!(infer_media_type_from_name("test.JPG"), "image/jpeg");
        assert_eq!(infer_media_type_from_name("test.jpeg"), "image/jpeg");
        assert_eq!(infer_media_type_from_name("test.gif"), "image/gif");
        assert_eq!(infer_media_type_from_name("test.webp"), "image/webp");
        assert_eq!(infer_media_type_from_name("test.unknown"), "image/png");
    }

    #[test]
    fn test_resolved_content() {
        let mut content = ResolvedContent::new();
        assert!(content.is_empty());

        content.add_text("hello".to_string());
        assert!(!content.is_empty());
        assert_eq!(content.text_contents.len(), 1);

        content.add_image("base64data".to_string());
        assert_eq!(content.image_base64_list.len(), 1);

        let formatted = content.to_formatted_text("user input");
        assert!(formatted.contains("hello"));
        assert!(formatted.contains("user input"));
    }

    #[test]
    fn test_default_image_mode_is_maximized() {
        let (include_image, include_ocr, downgraded) = resolve_image_mode_policy(None, true);
        assert!(include_image);
        assert!(include_ocr);
        assert!(!downgraded);
    }

    #[test]
    fn test_default_pdf_mode_is_maximized_and_downgraded_for_text_model() {
        let (t, o, i, downgraded) = resolve_pdf_mode_policy(None, true);
        assert!(t && o && i);
        assert!(!downgraded);

        let (t2, o2, i2, downgraded2) = resolve_pdf_mode_policy(None, false);
        assert!(t2 && o2);
        assert!(!i2);
        assert!(downgraded2);
    }

    #[test]
    fn test_resolve_question_image_blob_from_hash_field() {
        let conn = Connection::open_in_memory().unwrap();
        let value = serde_json::json!({
            "hash": "blob_hash_1",
            "mime": "image/jpeg"
        });
        let (hash, mime) = resolve_question_image_blob(&conn, &value).unwrap();
        assert_eq!(hash, "blob_hash_1");
        assert_eq!(mime, "image/jpeg");
    }

    #[test]
    fn test_resolve_question_image_blob_from_file_id() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            r#"
            CREATE TABLE files (
                id TEXT PRIMARY KEY,
                resource_id TEXT,
                blob_hash TEXT,
                compressed_blob_hash TEXT
            )
            "#,
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO files (id, resource_id, blob_hash, compressed_blob_hash) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params!["file_manual_1", "res_manual_1", "blob_ori", "blob_cmp"],
        )
        .unwrap();

        let value = serde_json::json!({ "id": "file_manual_1" });
        let (hash, mime) = resolve_question_image_blob(&conn, &value).unwrap();
        assert_eq!(hash, "blob_cmp");
        assert_eq!(mime, "image/png");
    }
}
