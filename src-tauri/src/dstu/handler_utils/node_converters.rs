//! VFS 类型到 DstuNode 的转换器
//!
//! 提供各种 VFS 类型到 DstuNode 的转换函数
//!
//! ## SSOT 文档
//!
//! ★ 文件格式定义请参考：docs/design/file-format-registry.md
//! `get_textbook_preview_type` 函数的扩展名到预览类型映射需与文档保持一致。
//! 修改格式支持时需同步更新文档和其他实现位置。

use tauri::{Emitter, Window};

use super::super::path_parser::build_simple_resource_path;
use super::super::types::{DstuNode, DstuNodeType, DstuWatchEvent};
use crate::unified_file_manager;
use crate::vfs::{
    VfsAttachment, VfsEssay, VfsEssaySession, VfsExamSheet, VfsFile, VfsMindMap, VfsNote,
    VfsTextbook, VfsTranslation,
};

// ============================================================================
// 辅助函数
// ============================================================================

/// ★ 移动端修复：当教材/文件的 file_name 是不透明 document ID 时，
/// 生成用户友好的显示名称（兼容旧数据）。
fn sanitize_textbook_display_name(file_name: &str, created_at: &str) -> String {
    let trimmed = file_name.trim();
    // 分离扩展名和主文件名
    let (base, ext) = match trimmed.rfind('.') {
        Some(dot_pos) if dot_pos > 0 && dot_pos < trimmed.len() - 1 => {
            (&trimmed[..dot_pos], Some(&trimmed[dot_pos..]))
        }
        _ => (trimmed, None),
    };

    if base == "文件" || unified_file_manager::is_opaque_document_id(base) {
        let ext_suffix = ext.unwrap_or("");
        let ts = parse_timestamp(created_at);
        let dt = chrono::DateTime::from_timestamp_millis(ts)
            .unwrap_or_else(chrono::Utc::now);
        format!("导入文档_{}{}", dt.format("%Y%m%d_%H%M%S"), ext_suffix)
    } else {
        file_name.to_string()
    }
}

/// 解析时间戳字符串为毫秒
pub fn parse_timestamp(s: &str) -> i64 {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return chrono::Utc::now().timestamp_millis();
    }

    // 1) RFC3339（主格式）
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(trimmed) {
        return dt.timestamp_millis();
    }

    // 2) SQLite datetime('now') 常见格式："YYYY-MM-DD HH:MM:SS"
    if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%d %H:%M:%S") {
        return chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(naive, chrono::Utc)
            .timestamp_millis();
    }

    // 3) SQLite 带毫秒格式："YYYY-MM-DD HH:MM:SS%.f"
    if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%d %H:%M:%S%.f") {
        return chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(naive, chrono::Utc)
            .timestamp_millis();
    }

    // 4) 纯数字 Unix 时间戳：秒(10位) / 毫秒(13位)
    if let Ok(raw) = trimmed.parse::<i64>() {
        let ms = if raw.abs() < 100_000_000_000 {
            raw.saturating_mul(1000)
        } else {
            raw
        };
        return ms;
    }

    let now = chrono::Utc::now().timestamp_millis();
    log::warn!(
        "[DSTU::node_converters] Failed to parse timestamp '{}', fallback to now: {}",
        s,
        now
    );
    now
}

/// 创建类型文件夹节点
pub fn create_type_folder(node_type: DstuNodeType) -> DstuNode {
    let type_segment = node_type.to_path_segment();
    let path = format!("/{}", type_segment);

    let name = match node_type {
        DstuNodeType::Note => "笔记",
        DstuNodeType::Textbook => "教材",
        DstuNodeType::Exam => "题目集",
        DstuNodeType::Translation => "翻译",
        DstuNodeType::Essay => "作文",
        DstuNodeType::Image => "图片",
        DstuNodeType::File => "文件",
        DstuNodeType::Folder => "文件夹",
        DstuNodeType::Retrieval => "检索结果",
        DstuNodeType::MindMap => "知识导图",
    };

    DstuNode::folder(format!("type_{}", type_segment), path, name)
}

/// 生成资源 ID
pub fn generate_resource_id(node_type: &DstuNodeType) -> String {
    let prefix = match node_type {
        DstuNodeType::Note => "note",
        DstuNodeType::Textbook => "tb",
        DstuNodeType::Exam => "exam",
        DstuNodeType::Translation => "tr",
        DstuNodeType::Essay => "essay",
        DstuNodeType::Image => "img",
        DstuNodeType::File => "file",
        DstuNodeType::Folder => "folder",
        DstuNodeType::Retrieval => "ret",
        DstuNodeType::MindMap => "mm",
    };
    format!("{}_{}", prefix, nanoid::nanoid!(10))
}

/// 发射 DSTU 监听事件
pub fn emit_watch_event(window: &Window, event: DstuWatchEvent) {
    let event_name = format!("dstu:change:{}", event.path);
    if let Err(e) = window.emit(&event_name, &event) {
        log::warn!(
            "[DSTU::handlers] Failed to emit event {}: {}",
            event_name,
            e
        );
    }

    // 同时发射通用事件
    if let Err(e) = window.emit("dstu:change", &event) {
        log::warn!("[DSTU::handlers] Failed to emit dstu:change event: {}", e);
    }
}

/// 将 item_type 字符串转换为 DstuNodeType
pub fn item_type_to_dstu_node_type(item_type: &str) -> Option<DstuNodeType> {
    match item_type {
        "note" => Some(DstuNodeType::Note),
        "textbook" => Some(DstuNodeType::Textbook),
        "exam" => Some(DstuNodeType::Exam),
        "translation" => Some(DstuNodeType::Translation),
        "essay" => Some(DstuNodeType::Essay),
        "image" => Some(DstuNodeType::Image),
        "file" => Some(DstuNodeType::File),
        "folder" => Some(DstuNodeType::Folder),
        "mindmap" => Some(DstuNodeType::MindMap),
        _ => None,
    }
}

// ============================================================================
// VFS 类型转换
// ============================================================================

/// 将 VfsNote 转换为 DstuNode
pub fn note_to_dstu_node(note: &VfsNote) -> DstuNode {
    let path = build_simple_resource_path(&note.id);

    let created_at = parse_timestamp(&note.created_at);
    let updated_at = parse_timestamp(&note.updated_at);

    DstuNode::resource(
        &note.id,
        &path,
        &note.title,
        DstuNodeType::Note,
        &note.resource_id,
    )
    .with_timestamps(created_at, updated_at)
    .with_metadata(serde_json::json!({
        "isFavorite": note.is_favorite,
        "tags": note.tags,
    }))
}

use crate::vfs::PreviewType;

/// 根据文件扩展名获取预览类型
///
/// ★ T09 重构：使用 PreviewType 枚举代替字符串，确保类型一致性
///
/// 支持的预览类型：
/// - Pdf: PDF 文档
/// - Docx: Word 文档 (docx)
/// - Xlsx: Excel 表格 (xlsx/xls/ods/xlsb)
/// - Pptx: PowerPoint 演示文稿 (pptx)
/// - Text: 纯文本/代码/结构化数据 (txt/md/html/htm/csv/json/xml/rtf/epub)
/// - None: 不支持预览
fn get_textbook_preview_type(file_name: &str) -> PreviewType {
    PreviewType::from_filename(file_name)
}

/// 将 VfsTextbook 转换为 DstuNode
pub fn textbook_to_dstu_node(textbook: &VfsTextbook) -> DstuNode {
    let path = build_simple_resource_path(&textbook.id);

    let created_at = parse_timestamp(&textbook.created_at);
    let updated_at = parse_timestamp(&textbook.updated_at);

    let resource_id = textbook
        .resource_id
        .clone()
        .unwrap_or_else(|| format!("res_{}", textbook.id));

    // ★ T09: 根据文件扩展名设置正确的预览类型（使用枚举）
    let preview_type = get_textbook_preview_type(&textbook.file_name);

    // ★ 移动端修复：当数据库中存储的 file_name 是不透明 document ID 时，
    // 生成用户友好的显示名称（兼容旧数据）
    let display_name = sanitize_textbook_display_name(&textbook.file_name, &textbook.created_at);

    DstuNode::resource(
        &textbook.id,
        &path,
        &display_name,
        DstuNodeType::Textbook,
        &resource_id,
    )
    .with_timestamps(created_at, updated_at)
    .with_size(textbook.size as u64)
    .with_preview_type(preview_type.to_string())
    .with_metadata(serde_json::json!({
        "filePath": textbook.original_path,
        "isFavorite": textbook.is_favorite,
    }))
}

/// 将 VfsTranslation 转换为 DstuNode
/// 🔧 P0-08 修复: 添加 sourceText 和 translatedText 到 metadata
pub fn translation_to_dstu_node(translation: &VfsTranslation) -> DstuNode {
    let path = build_simple_resource_path(&translation.id);

    let created_at = parse_timestamp(&translation.created_at);

    let updated_at = translation
        .updated_at
        .as_ref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(created_at);

    let name = translation
        .title
        .clone()
        .unwrap_or_else(|| translation.id.clone());

    DstuNode::resource(
        &translation.id,
        &path,
        &name,
        DstuNodeType::Translation,
        &translation.resource_id,
    )
    .with_timestamps(created_at, updated_at)
    .with_metadata(serde_json::json!({
        "srcLang": translation.src_lang,
        "tgtLang": translation.tgt_lang,
        "engine": translation.engine,
        "model": translation.model,
        "isFavorite": translation.is_favorite,
        "qualityRating": translation.quality_rating,
        "title": translation.title,
        // 🔧 P0-08 修复: 添加源文本和译文到 metadata
        "sourceText": translation.source_text,
        "translatedText": translation.translated_text,
    }))
}

/// 将 VfsExamSheet 转换为 DstuNode
pub fn exam_to_dstu_node(exam: &VfsExamSheet) -> DstuNode {
    let path = build_simple_resource_path(&exam.id);

    let created_at = parse_timestamp(&exam.created_at);
    let updated_at = parse_timestamp(&exam.updated_at);

    let resource_id = exam
        .resource_id
        .clone()
        .unwrap_or_else(|| format!("res_{}", exam.id));
    let name = exam.exam_name.clone().unwrap_or_else(|| exam.id.clone());

    DstuNode::resource(&exam.id, &path, &name, DstuNodeType::Exam, &resource_id)
        .with_timestamps(created_at, updated_at)
        .with_metadata(serde_json::json!({
            "status": exam.status,
            "tempId": exam.temp_id,
            "linkedMistakeIds": exam.linked_mistake_ids,
            "isFavorite": exam.is_favorite,
        }))
}

/// 将 VfsEssay 转换为 DstuNode
pub fn essay_to_dstu_node(essay: &VfsEssay) -> DstuNode {
    let path = build_simple_resource_path(&essay.id);

    let created_at = parse_timestamp(&essay.created_at);
    let updated_at = parse_timestamp(&essay.updated_at);

    let name = essay
        .title
        .clone()
        .unwrap_or_else(|| "未命名作文".to_string());

    DstuNode::resource(
        &essay.id,
        &path,
        &name,
        DstuNodeType::Essay,
        &essay.resource_id,
    )
    .with_timestamps(created_at, updated_at)
    .with_metadata(serde_json::json!({
        "essayType": essay.essay_type,
        "score": essay.score,
        "gradingResult": essay.grading_result,
        "isFavorite": essay.is_favorite,
    }))
}

/// 将 VfsEssaySession 转换为 DstuNode
pub fn session_to_dstu_node(session: &VfsEssaySession) -> DstuNode {
    let path = build_simple_resource_path(&session.id);

    let created_at = parse_timestamp(&session.created_at);
    let updated_at = parse_timestamp(&session.updated_at);

    DstuNode::resource(
        &session.id,
        &path,
        &session.title,
        DstuNodeType::Essay,
        &session.id,
    )
    .with_timestamps(created_at, updated_at)
    .with_metadata(serde_json::json!({
        "essayType": session.essay_type,
        "gradeLevel": session.grade_level,
        "totalRounds": session.total_rounds,
        "latestScore": session.latest_score,
        "isFavorite": session.is_favorite,
    }))
}

/// 将 VfsAttachment 转换为 DstuNode
pub fn attachment_to_dstu_node(attachment: &VfsAttachment) -> DstuNode {
    let path = build_simple_resource_path(&attachment.id);

    let created_at = parse_timestamp(&attachment.created_at);
    let updated_at = parse_timestamp(&attachment.updated_at);

    let node_type = if attachment.attachment_type == "image" {
        DstuNodeType::Image
    } else {
        DstuNodeType::File
    };

    DstuNode::resource(
        &attachment.id,
        &path,
        &attachment.name,
        node_type,
        &attachment.content_hash,
    )
    .with_timestamps(created_at, updated_at)
    .with_metadata(serde_json::json!({
        "mimeType": attachment.mime_type,
        "size": attachment.size,
        "contentHash": attachment.content_hash,
        "isFavorite": attachment.is_favorite,
    }))
}

/// 将 VfsMindMap 转换为 DstuNode
pub fn mindmap_to_dstu_node(mindmap: &VfsMindMap) -> DstuNode {
    let path = build_simple_resource_path(&mindmap.id);

    let created_at = parse_timestamp(&mindmap.created_at);
    let updated_at = parse_timestamp(&mindmap.updated_at);

    DstuNode::resource(
        &mindmap.id,
        &path,
        &mindmap.title,
        DstuNodeType::MindMap,
        &mindmap.resource_id,
    )
    .with_timestamps(created_at, updated_at)
    .with_metadata(serde_json::json!({
        "description": mindmap.description,
        "isFavorite": mindmap.is_favorite,
        "defaultView": mindmap.default_view,
        "theme": mindmap.theme,
    }))
}


pub fn file_to_dstu_node(file: &VfsFile) -> DstuNode {
    let path = build_simple_resource_path(&file.id);

    let created_at = parse_timestamp(&file.created_at);
    let updated_at = parse_timestamp(&file.updated_at);

    let is_pdf = file.mime_type.as_ref().map_or(false, |m| m.contains("pdf"))
        || file.file_name.to_lowercase().ends_with(".pdf");

    let node_type = if is_pdf {
        DstuNodeType::Textbook
    } else {
        match file.file_type.as_str() {
            "image" => DstuNodeType::Image,
            _ => DstuNodeType::File,
        }
    };

    // ★ T09: 使用 PreviewType 枚举
    let preview_type = get_textbook_preview_type(&file.file_name);

    // ★ 移动端修复：file_name 不透明 ID 兼容处理
    let display_name = sanitize_textbook_display_name(&file.file_name, &file.created_at);

    DstuNode::resource(&file.id, &path, &display_name, node_type, &file.sha256)
        .with_timestamps(created_at, updated_at)
        .with_size(file.size as u64)
        .with_preview_type(preview_type.to_string())
        .with_metadata(serde_json::json!({
            "filePath": file.original_path,
            "mimeType": file.mime_type,
            "size": file.size,
            "fileType": file.file_type,
            "sha256": file.sha256,
            "contentHash": file.sha256,
            "isFavorite": file.is_favorite,
            "pageCount": file.page_count,
        }))
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ------------------------------------------------------------------------
    // get_textbook_preview_type 测试
    // ------------------------------------------------------------------------

    #[test]
    fn test_get_textbook_preview_type_pdf() {
        // 小写
        assert_eq!(get_textbook_preview_type("document.pdf"), PreviewType::Pdf);
        // 大写
        assert_eq!(get_textbook_preview_type("DOCUMENT.PDF"), PreviewType::Pdf);
        // 混合
        assert_eq!(get_textbook_preview_type("Document.Pdf"), PreviewType::Pdf);
        // 路径中的 PDF
        assert_eq!(
            get_textbook_preview_type("path/to/file.pdf"),
            PreviewType::Pdf
        );
    }

    #[test]
    fn test_get_textbook_preview_type_office_word() {
        // Word 文档
        assert_eq!(get_textbook_preview_type("report.docx"), PreviewType::Docx);
        assert_eq!(get_textbook_preview_type("REPORT.DOCX"), PreviewType::Docx);
    }

    #[test]
    fn test_get_textbook_preview_type_office_excel() {
        // Excel 表格
        assert_eq!(get_textbook_preview_type("data.xlsx"), PreviewType::Xlsx);
        assert_eq!(get_textbook_preview_type("data.xls"), PreviewType::Xlsx);
        assert_eq!(get_textbook_preview_type("data.ods"), PreviewType::Xlsx);
        assert_eq!(get_textbook_preview_type("data.xlsb"), PreviewType::Xlsx);
        assert_eq!(get_textbook_preview_type("DATA.XLSX"), PreviewType::Xlsx);
    }

    #[test]
    fn test_get_textbook_preview_type_office_powerpoint() {
        // PowerPoint 演示文稿
        assert_eq!(get_textbook_preview_type("slides.pptx"), PreviewType::Pptx);
        assert_eq!(get_textbook_preview_type("SLIDES.PPTX"), PreviewType::Pptx);
    }

    #[test]
    fn test_get_textbook_preview_type_text_plain() {
        // 纯文本
        assert_eq!(get_textbook_preview_type("readme.txt"), PreviewType::Text);
        assert_eq!(get_textbook_preview_type("README.TXT"), PreviewType::Text);
        // Markdown
        assert_eq!(get_textbook_preview_type("readme.md"), PreviewType::Text);
        assert_eq!(get_textbook_preview_type("README.MD"), PreviewType::Text);
    }

    #[test]
    fn test_get_textbook_preview_type_text_html() {
        // HTML
        assert_eq!(get_textbook_preview_type("page.html"), PreviewType::Text);
        assert_eq!(get_textbook_preview_type("page.htm"), PreviewType::Text);
        assert_eq!(get_textbook_preview_type("PAGE.HTML"), PreviewType::Text);
    }

    #[test]
    fn test_get_textbook_preview_type_text_structured() {
        // 结构化数据
        assert_eq!(get_textbook_preview_type("data.csv"), PreviewType::Text);
        assert_eq!(get_textbook_preview_type("config.json"), PreviewType::Text);
        assert_eq!(get_textbook_preview_type("config.xml"), PreviewType::Text);
        assert_eq!(get_textbook_preview_type("DATA.CSV"), PreviewType::Text);
        assert_eq!(get_textbook_preview_type("CONFIG.JSON"), PreviewType::Text);
    }

    #[test]
    fn test_get_textbook_preview_type_text_ebook() {
        // 电子书和富文本
        assert_eq!(get_textbook_preview_type("book.epub"), PreviewType::Text);
        assert_eq!(get_textbook_preview_type("document.rtf"), PreviewType::Text);
        assert_eq!(get_textbook_preview_type("BOOK.EPUB"), PreviewType::Text);
    }

    #[test]
    fn test_get_textbook_preview_type_unknown() {
        // 未知扩展名
        assert_eq!(get_textbook_preview_type("file.unknown"), PreviewType::None);
        assert_eq!(get_textbook_preview_type("file.xyz"), PreviewType::None);
        // 无扩展名
        assert_eq!(get_textbook_preview_type("noextension"), PreviewType::None);
        // 空字符串
        assert_eq!(get_textbook_preview_type(""), PreviewType::None);
        // 只有点号
        assert_eq!(get_textbook_preview_type("."), PreviewType::None);
        assert_eq!(get_textbook_preview_type("file."), PreviewType::None);
    }

    #[test]
    fn test_get_textbook_preview_type_edge_cases() {
        // 多个扩展名，应取最后一个
        assert_eq!(get_textbook_preview_type("file.tar.gz"), PreviewType::None);
        assert_eq!(
            get_textbook_preview_type("file.backup.pdf"),
            PreviewType::Pdf
        );
        // 隐藏文件
        assert_eq!(get_textbook_preview_type(".gitignore"), PreviewType::None);
        // 特殊字符
        assert_eq!(get_textbook_preview_type("文档.pdf"), PreviewType::Pdf);
        assert_eq!(
            get_textbook_preview_type("file name with spaces.docx"),
            PreviewType::Docx
        );
    }

    // ------------------------------------------------------------------------
    // 其他辅助函数测试
    // ------------------------------------------------------------------------

    #[test]
    fn test_parse_timestamp_valid() {
        let ts = parse_timestamp("2024-01-15T10:30:00Z");
        assert!(ts > 0);
        // 2024-01-15T10:30:00Z 应该是一个合理的时间戳
        assert!(ts > 1700000000000); // 2023-11-14 之后
        assert!(ts < 2000000000000); // 2033-05-18 之前
    }

    #[test]
    fn test_parse_timestamp_invalid() {
        // 无效格式应返回当前时间
        let ts = parse_timestamp("invalid");
        assert!(ts > 0);
        // 应该接近当前时间
        let now = chrono::Utc::now().timestamp_millis();
        assert!((ts - now).abs() < 1000); // 1秒内
    }

    #[test]
    fn test_item_type_to_dstu_node_type() {
        assert_eq!(
            item_type_to_dstu_node_type("note"),
            Some(DstuNodeType::Note)
        );
        assert_eq!(
            item_type_to_dstu_node_type("textbook"),
            Some(DstuNodeType::Textbook)
        );
        assert_eq!(
            item_type_to_dstu_node_type("exam"),
            Some(DstuNodeType::Exam)
        );
        assert_eq!(
            item_type_to_dstu_node_type("translation"),
            Some(DstuNodeType::Translation)
        );
        assert_eq!(
            item_type_to_dstu_node_type("essay"),
            Some(DstuNodeType::Essay)
        );
        assert_eq!(
            item_type_to_dstu_node_type("image"),
            Some(DstuNodeType::Image)
        );
        assert_eq!(
            item_type_to_dstu_node_type("file"),
            Some(DstuNodeType::File)
        );
        assert_eq!(
            item_type_to_dstu_node_type("folder"),
            Some(DstuNodeType::Folder)
        );
        assert_eq!(
            item_type_to_dstu_node_type("mindmap"),
            Some(DstuNodeType::MindMap)
        );
        assert_eq!(item_type_to_dstu_node_type("unknown"), None);
        assert_eq!(item_type_to_dstu_node_type(""), None);
    }

    #[test]
    fn test_create_type_folder() {
        let node = create_type_folder(DstuNodeType::Note);
        assert_eq!(node.id, "type_notes");
        assert_eq!(node.path, "/notes");
        assert_eq!(node.name, "笔记");

        let node = create_type_folder(DstuNodeType::Textbook);
        assert_eq!(node.id, "type_textbooks");
        assert_eq!(node.path, "/textbooks");
        assert_eq!(node.name, "教材");

        let node = create_type_folder(DstuNodeType::MindMap);
        assert_eq!(node.id, "type_mindmaps");
        assert_eq!(node.path, "/mindmaps");
        assert_eq!(node.name, "知识导图");
    }

    #[test]
    fn test_generate_resource_id() {
        let id = generate_resource_id(&DstuNodeType::Note);
        assert!(id.starts_with("note_"));
        assert_eq!(id.len(), 15); // "note_" (5) + nanoid (10)

        let id = generate_resource_id(&DstuNodeType::Textbook);
        assert!(id.starts_with("tb_"));
        assert_eq!(id.len(), 13); // "tb_" (3) + nanoid (10)

        let id = generate_resource_id(&DstuNodeType::MindMap);
        assert!(id.starts_with("mm_"));
        assert_eq!(id.len(), 13); // "mm_" (3) + nanoid (10)

        // 确保每次生成的 ID 不同
        let id1 = generate_resource_id(&DstuNodeType::Note);
        let id2 = generate_resource_id(&DstuNodeType::Note);
        assert_ne!(id1, id2);
    }

    // ------------------------------------------------------------------------
    // sanitize_textbook_display_name 测试
    // ------------------------------------------------------------------------

    #[test]
    fn test_sanitize_keeps_normal_filenames() {
        assert_eq!(
            sanitize_textbook_display_name("线代笔记.pdf", "2025-01-15T10:30:00Z"),
            "线代笔记.pdf"
        );
        assert_eq!(
            sanitize_textbook_display_name("chapter1.docx", "2025-01-15T10:30:00Z"),
            "chapter1.docx"
        );
    }

    #[test]
    fn test_sanitize_replaces_pure_numeric_id() {
        let result = sanitize_textbook_display_name("446.pdf", "2025-01-15T10:30:00Z");
        assert!(result.starts_with("导入文档_"), "got: {}", result);
        assert!(result.ends_with(".pdf"), "got: {}", result);
    }

    #[test]
    fn test_sanitize_replaces_document_colon_id() {
        let result = sanitize_textbook_display_name("document:1000019790.pdf", "2025-06-01T00:00:00Z");
        assert!(result.starts_with("导入文档_"), "got: {}", result);
        assert!(result.ends_with(".pdf"), "got: {}", result);
    }

    #[test]
    fn test_sanitize_replaces_generic_placeholder() {
        let result = sanitize_textbook_display_name("文件.pdf", "2025-01-15T10:30:00Z");
        assert!(result.starts_with("导入文档_"), "got: {}", result);
        assert!(result.ends_with(".pdf"), "got: {}", result);
    }

    #[test]
    fn test_sanitize_handles_no_extension() {
        let result = sanitize_textbook_display_name("446", "2025-01-15T10:30:00Z");
        assert!(result.starts_with("导入文档_"), "got: {}", result);
        assert!(!result.contains('.'), "should have no extension, got: {}", result);
    }
}
