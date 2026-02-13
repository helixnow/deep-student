//! 内容读写辅助函数
//!
//! 包含资源内容获取和更新的辅助函数
//!
//! ## T03 统一 PDF 文本抽取策略 (2026-01-26)
//!
//! `get_content_by_type` 函数与 `vfs_resolve_resource_refs` 使用完全一致的策略：
//! 1. 优先使用 OCR 页级文本 (`ocr_pages_json`)
//! 2. 其次使用预提取文本 (`extracted_text`)
//! 3. 最后回退到 `DocumentParser` 实时解析
//! 4. 取大者策略：比较 OCR 和解析结果长度，使用较长的
//! 5. 都为空时返回降级提示 `[文档: xxx.pdf]`

use std::cell::Cell;
use std::sync::Arc;

use rusqlite::{params, OptionalExtension};
use serde_json::Value;

use crate::dstu::error::DstuError;
use crate::vfs::{
    extract_file_text_with_strategy, VfsDatabase, VfsEssayRepo, VfsExamRepo, VfsFileRepo,
    VfsMindMapRepo, VfsNoteRepo, VfsResourceRepo, VfsTranslationRepo,
};

/// HIGH-R004修复: 最大内容大小限制 - 1MB (与handlers.rs保持一致)
const MAX_CONTENT_SIZE: usize = 1 * 1024 * 1024; // 1MB
/// 作文会话内容上限（防止超长注入）
const MAX_ESSAY_SESSION_CHARS: usize = 20000;
/// 作文会话最多拼接轮次
const MAX_ESSAY_SESSION_ROUNDS: usize = 10;

fn resolve_file_id_for_read(conn: &rusqlite::Connection, raw_id: &str) -> Option<String> {
    // 1) 优先当作 files.id 读取（file_xxx / att_xxx）
    let direct_file_id: Option<String> = conn
        .query_row(
            "SELECT id FROM files WHERE id = ?1 LIMIT 1",
            params![raw_id],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten();
    if direct_file_id.is_some() {
        return direct_file_id;
    }

    // 2) raw_id 可能是 resources.id
    let by_resource_id: Option<String> = conn
        .query_row(
            "SELECT id FROM files WHERE resource_id = ?1 LIMIT 1",
            params![raw_id],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten();
    if by_resource_id.is_some() {
        return by_resource_id;
    }

    // 3) raw_id 可能是 resources.source_id（例如 tb_xxx）
    let mapped_resource_id: Option<String> = conn
        .query_row(
            "SELECT id FROM resources WHERE source_id = ?1 LIMIT 1",
            params![raw_id],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten();
    if let Some(resource_id) = mapped_resource_id {
        return conn
            .query_row(
                "SELECT id FROM files WHERE resource_id = ?1 LIMIT 1",
                params![resource_id],
                |row| row.get(0),
            )
            .optional()
            .ok()
            .flatten();
    }

    None
}

fn format_exam_preview_for_read(preview: &Value) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut page_count = 0usize;
    let mut card_count = 0usize;
    let mut with_ocr_count = 0usize;

    if let Some(pages) = preview.get("pages").and_then(|v| v.as_array()) {
        page_count = pages.len();
        for (page_idx, page) in pages.iter().enumerate() {
            let cards = page
                .get("cards")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            card_count += cards.len();
            lines.push(format!("## 第 {} 页（{} 题）", page_idx + 1, cards.len()));
            for card in cards {
                let label = card
                    .get("questionLabel")
                    .and_then(|v| v.as_str())
                    .unwrap_or("-");
                let ocr = card
                    .get("ocrText")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let status = card.get("status").and_then(|v| v.as_str()).unwrap_or("new");
                if !ocr.is_empty() {
                    with_ocr_count += 1;
                }
                let shown = if ocr.is_empty() {
                    "（无 OCR 文本）".to_string()
                } else {
                    let max_chars = 200usize;
                    let content: String = ocr.chars().take(max_chars).collect();
                    if ocr.chars().count() > max_chars {
                        format!("{}...", content)
                    } else {
                        content
                    }
                };
                lines.push(format!("- {} [{}] {}", label, status, shown));
            }
        }
    }

    if lines.is_empty() {
        return "[题目集内容为空]".to_string();
    }

    format!(
        "# 题目集结构化摘要\n统计：页数={}，题目数={}，含 OCR 题目={}\n\n{}",
        page_count,
        card_count,
        with_ocr_count,
        lines.join("\n")
    )
}

/// 根据资源类型获取内容
pub fn get_content_by_type(
    vfs_db: &Arc<VfsDatabase>,
    resource_type: &str,
    id: &str,
) -> Result<String, String> {
    match resource_type {
        "notes" | "note" => match VfsNoteRepo::get_note_content(vfs_db, id) {
            Ok(Some(content)) => {
                log::info!(
                    "[DSTU::content_helpers] get_content_by_type: SUCCESS - type=note, id={}",
                    id
                );
                Ok(content)
            }
            Ok(None) => {
                log::error!("[DSTU::content_helpers] get_content_by_type: content not found - type=note, id={}", id);
                Err(DstuError::not_found(id).to_string())
            }
            Err(e) => {
                log::error!("[DSTU::content_helpers] get_content_by_type: FAILED - type=note, id={}, error={}", id, e);
                Err(e.to_string())
            }
        },
        "textbooks" | "textbook" | "files" | "file" => {
            // ★ T02 修复：使用统一文本抽取函数（与 ref_handlers.rs 复用同一函数）
            // 策略：OCR → extracted_text → DocumentParser，取大者
            log::info!("[DSTU::content_helpers] get_content_by_type: unified text extraction for type={}, id={}", resource_type, id);

            // 获取数据库连接
            let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;
            let resolved_file_id =
                resolve_file_id_for_read(&conn, id).unwrap_or_else(|| id.to_string());

            // 获取文件名用于错误提示和解析
            let file_name = VfsFileRepo::get_file(vfs_db, &resolved_file_id)
                .ok()
                .flatten()
                .map(|f| f.file_name)
                .unwrap_or_else(|| "document.pdf".to_string());

            // 获取 base64 内容（用于 DocumentParser 回退）
            let base64_content = VfsFileRepo::get_content(vfs_db, &resolved_file_id)
                .ok()
                .flatten();

            // 使用统一文本抽取函数（与 ref_handlers.rs 完全一致）
            let text = extract_file_text_with_strategy(
                &conn,
                &resolved_file_id,
                &file_name,
                base64_content.as_deref(),
            );

            match text {
                Some(content) if !content.is_empty() => {
                    log::info!(
                        "[DSTU::content_helpers] get_content_by_type: SUCCESS - type={}, id={}, resolved_id={}, content_len={}",
                        resource_type, id, resolved_file_id, content.len()
                    );
                    Ok(content)
                }
                _ => {
                    // 无法获取文本时返回文件名提示（降级处理）
                    log::warn!(
                        "[DSTU::content_helpers] get_content_by_type: no text extracted for id={}, returning filename hint",
                        id
                    );
                    Ok(format!("[文档: {}]", file_name))
                }
            }
        }
        "translations" | "translation" => {
            match VfsTranslationRepo::get_translation_content(vfs_db, id) {
                Ok(Some(content)) => {
                    log::info!("[DSTU::content_helpers] get_content_by_type: SUCCESS - type=translation, id={}", id);
                    Ok(content)
                }
                Ok(None) => {
                    log::error!("[DSTU::content_helpers] get_content_by_type: content not found - type=translation, id={}", id);
                    Err(DstuError::not_found(id).to_string())
                }
                Err(e) => {
                    log::error!("[DSTU::content_helpers] get_content_by_type: FAILED - type=translation, id={}, error={}", id, e);
                    Err(e.to_string())
                }
            }
        }
        "exams" | "exam" => match VfsExamRepo::get_exam_sheet(vfs_db, id) {
            Ok(Some(exam)) => {
                log::info!(
                    "[DSTU::content_helpers] get_content_by_type: SUCCESS - type=exam, id={}",
                    id
                );
                Ok(format_exam_preview_for_read(&exam.preview_json))
            }
            Ok(None) => {
                log::error!(
                    "[DSTU::content_helpers] get_content_by_type: exam not found, id={}",
                    id
                );
                Err(DstuError::not_found(id).to_string())
            }
            Err(e) => {
                log::error!("[DSTU::content_helpers] get_content_by_type: FAILED - type=exam, id={}, error={}", id, e);
                Err(e.to_string())
            }
        },
        "essays" | "essay" => {
            // ★ 2026-01-26 修复：区分 essay_session_* 和 essay_* ID
            // essay_session_* 是作文会话，需要获取会话下所有轮次的内容汇总
            // essay_* 是单个作文轮次
            if id.starts_with("essay_session_") {
                // 作文会话：获取会话信息和所有轮次内容
                match VfsEssayRepo::get_session(vfs_db, id) {
                    Ok(Some(session)) => {
                        // 获取该会话下的所有作文轮次
                        match VfsEssayRepo::list_essays_by_session(vfs_db, id) {
                            Ok(essays) => {
                                let mut content_parts: Vec<String> = Vec::new();
                                let mut total_chars: usize = 0;
                                let truncated = Cell::new(false);
                                let mut push_with_limit = |part: String| {
                                    if total_chars >= MAX_ESSAY_SESSION_CHARS {
                                        truncated.set(true);
                                        return false;
                                    }
                                    let remaining = MAX_ESSAY_SESSION_CHARS - total_chars;
                                    let part_char_count = part.chars().count();
                                    if part_char_count > remaining {
                                        let truncated_part: String =
                                            part.chars().take(remaining).collect();
                                        if !truncated_part.is_empty() {
                                            content_parts.push(truncated_part);
                                        }
                                        total_chars = MAX_ESSAY_SESSION_CHARS;
                                        truncated.set(true);
                                        return false;
                                    }
                                    total_chars += part_char_count;
                                    content_parts.push(part);
                                    true
                                };
                                let title = if session.title.is_empty() {
                                    "未命名".to_string()
                                } else {
                                    session.title.clone()
                                };
                                push_with_limit(format!("# 作文会话: {}", title));
                                push_with_limit(format!(
                                    "类型: {}, 总轮次: {}",
                                    session.essay_type.as_deref().unwrap_or("未知"),
                                    session.total_rounds
                                ));

                                let max_rounds = MAX_ESSAY_SESSION_ROUNDS.min(essays.len());
                                if essays.len() > max_rounds {
                                    truncated.set(true);
                                }
                                for (i, essay) in essays.iter().take(max_rounds).enumerate() {
                                    if !push_with_limit(format!("\n## 第 {} 轮", i + 1)) {
                                        break;
                                    }
                                    if let Ok(Some(essay_content)) =
                                        VfsEssayRepo::get_essay_content(vfs_db, &essay.id)
                                    {
                                        if !push_with_limit(essay_content) {
                                            break;
                                        }
                                    }
                                }
                                if truncated.get() {
                                    push_with_limit("\n\n[内容过长，已截断]".to_string());
                                }

                                log::info!("[DSTU::content_helpers] get_content_by_type: SUCCESS - type=essay_session, id={}, rounds={}", id, essays.len());
                                Ok(content_parts.join("\n"))
                            }
                            Err(e) => {
                                log::error!("[DSTU::content_helpers] get_content_by_type: FAILED to list essays for session {}: {}", id, e);
                                Err(e.to_string())
                            }
                        }
                    }
                    Ok(None) => {
                        log::error!("[DSTU::content_helpers] get_content_by_type: session not found - id={}", id);
                        Err(DstuError::not_found(id).to_string())
                    }
                    Err(e) => {
                        log::error!("[DSTU::content_helpers] get_content_by_type: FAILED - type=essay_session, id={}, error={}", id, e);
                        Err(e.to_string())
                    }
                }
            } else {
                // 单个作文轮次
                match VfsEssayRepo::get_essay_content(vfs_db, id) {
                    Ok(Some(content)) => {
                        log::info!("[DSTU::content_helpers] get_content_by_type: SUCCESS - type=essay, id={}", id);
                        Ok(content)
                    }
                    Ok(None) => {
                        log::error!("[DSTU::content_helpers] get_content_by_type: content not found - type=essay, id={}", id);
                        Err(DstuError::not_found(id).to_string())
                    }
                    Err(e) => {
                        log::error!("[DSTU::content_helpers] get_content_by_type: FAILED - type=essay, id={}, error={}", id, e);
                        Err(e.to_string())
                    }
                }
            }
        }
        "images" | "image" => {
            // 图片读取优先返回 OCR 文本，兜底再返回 base64
            log::info!(
                "[DSTU::content_helpers] get_content_by_type: image type, id={}",
                id
            );
            let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;
            if let Some(ocr_text) =
                crate::vfs::ref_handlers::get_image_ocr_text_with_conn(&conn, id)
            {
                return Ok(format!("<image_ocr id=\"{}\">{}</image_ocr>", id, ocr_text));
            }
            match VfsFileRepo::get_content(vfs_db, id) {
                Ok(Some(base64_content)) => {
                    log::info!("[DSTU::content_helpers] get_content_by_type: SUCCESS - type=image, id={}, len={}", id, base64_content.len());
                    Ok(base64_content)
                }
                Ok(None) => {
                    log::error!(
                        "[DSTU::content_helpers] get_content_by_type: image not found, id={}",
                        id
                    );
                    Err(DstuError::not_found(id).to_string())
                }
                Err(e) => {
                    log::error!("[DSTU::content_helpers] get_content_by_type: FAILED - type=image, id={}, error={}", id, e);
                    Err(e.to_string())
                }
            }
        }
        "mindmaps" | "mindmap" => {
            // ★ 2026-01-26 新增：知识导图内容读取
            match VfsMindMapRepo::get_mindmap_content(vfs_db, id) {
                Ok(Some(content)) => {
                    log::info!("[DSTU::content_helpers] get_content_by_type: SUCCESS - type=mindmap, id={}", id);
                    Ok(content)
                }
                Ok(None) => {
                    log::error!("[DSTU::content_helpers] get_content_by_type: mindmap content not found, id={}", id);
                    Err(DstuError::not_found(id).to_string())
                }
                Err(e) => {
                    log::error!("[DSTU::content_helpers] get_content_by_type: FAILED - type=mindmap, id={}, error={}", id, e);
                    Err(e.to_string())
                }
            }
        }
        _ => Err(DstuError::invalid_node_type(resource_type).to_string()),
    }
}

/// 根据资源类型更新内容
pub fn update_content_by_type(
    vfs_db: &Arc<VfsDatabase>,
    resource_type: &str,
    id: &str,
    content: &str,
) -> Result<(), String> {
    // HIGH-R004修复: 在所有更新路径上强制执行内容大小限制
    let content_bytes = content.len();
    if content_bytes > MAX_CONTENT_SIZE {
        let error_msg = format!(
            "内容大小超出限制: {} 字节 ({:.2} MB) (最大允许: {} 字节 ({} MB))",
            content_bytes,
            content_bytes as f64 / (1024.0 * 1024.0),
            MAX_CONTENT_SIZE,
            MAX_CONTENT_SIZE / (1024 * 1024)
        );
        log::error!(
            "[DSTU::content_helpers] update_content_by_type: FAILED - type={}, id={}, {}",
            resource_type,
            id,
            error_msg
        );
        return Err(error_msg);
    }

    match resource_type {
        "notes" | "note" => {
            VfsNoteRepo::update_note(
                vfs_db,
                id,
                crate::vfs::VfsUpdateNoteParams {
                    content: Some(content.to_string()),
                    title: None,
                    tags: None,
                    expected_updated_at: None,
                },
            )
            .map_err(|e| e.to_string())?;
            log::info!("[DSTU::content_helpers] update_content_by_type: SUCCESS - type=note, id={}, content_size={}", id, content_bytes);
            Ok(())
        }
        "translations" | "translation" => {
            // ★ 2026-01-28 新增：翻译内容更新
            // 内容格式：JSON { "source": "...", "translated": "..." }
            update_translation_content(vfs_db, id, content)?;
            log::info!("[DSTU::content_helpers] update_content_by_type: SUCCESS - type=translation, id={}, content_size={}", id, content_bytes);
            Ok(())
        }
        "mindmaps" | "mindmap" => {
            // ★ 2026-01-28 新增：知识导图内容更新
            // 内容格式：MindMapDocument JSON
            update_mindmap_content(vfs_db, id, content)?;
            log::info!("[DSTU::content_helpers] update_content_by_type: SUCCESS - type=mindmap, id={}, content_size={}", id, content_bytes);
            Ok(())
        }
        "exams" | "exam" => {
            // ★ 2026-01-28 新增：题目集内容更新
            // 内容格式：preview_json
            update_exam_content(vfs_db, id, content)?;
            log::info!("[DSTU::content_helpers] update_content_by_type: SUCCESS - type=exam, id={}, content_size={}", id, content_bytes);
            Ok(())
        }
        "textbooks" | "textbook" => {
            // PDF 文件无法直接编辑
            Err(
                "Textbook content update not supported: PDF files cannot be directly edited"
                    .to_string(),
            )
        }
        "files" | "file" | "images" | "image" => {
            // 二进制文件无法直接编辑
            Err(format!(
                "{} content update not supported: binary files cannot be directly edited",
                resource_type
            ))
        }
        "essays" | "essay" => {
            // ★ 2026-01-28 新增：作文内容更新
            // - essay_session_* ID：更新会话元数据（title, is_favorite 等）
            // - essay_* ID：更新单个轮次的作文内容
            update_essay_content(vfs_db, id, content)?;
            log::info!("[DSTU::content_helpers] update_content_by_type: SUCCESS - type=essay, id={}, content_size={}", id, content_bytes);
            Ok(())
        }
        _ => Err(DstuError::invalid_node_type(resource_type).to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_format_exam_preview_for_read() {
        let preview = json!({
            "pages": [
                {
                    "cards": [
                        {"questionLabel": "1", "ocrText": "第一题内容", "status": "new"},
                        {"questionLabel": "2", "ocrText": "", "status": "review"}
                    ]
                }
            ]
        });

        let text = format_exam_preview_for_read(&preview);
        assert!(text.contains("题目集结构化摘要"));
        assert!(text.contains("页数=1"));
        assert!(text.contains("题目数=2"));
        assert!(text.contains("- 1 [new] 第一题内容"));
        assert!(text.contains("（无 OCR 文本）"));
    }
}

/// 更新翻译内容
///
/// 内容格式：JSON { "source": "...", "translated": "..." }
fn update_translation_content(
    vfs_db: &Arc<VfsDatabase>,
    translation_id: &str,
    content: &str,
) -> Result<(), String> {
    // 1. 解析内容 JSON
    let content_json: serde_json::Value = serde_json::from_str(content)
        .map_err(|e| format!("Invalid JSON content for translation: {}", e))?;

    // 验证内容格式
    let has_source = content_json.get("source").is_some();
    let has_translated = content_json.get("translated").is_some();

    if !has_source && !has_translated {
        return Err(
            "Translation content must contain at least 'source' or 'translated' field".to_string(),
        );
    }

    // 2. 获取翻译记录以找到 resource_id
    let translation = VfsTranslationRepo::get_translation(vfs_db, translation_id)
        .map_err(|e| format!("Failed to get translation: {}", e))?
        .ok_or_else(|| format!("Translation not found: {}", translation_id))?;

    // 3. 获取数据库连接
    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;

    // 4. 更新 resources.data（翻译内容存储在此）
    VfsResourceRepo::update_resource_data_with_conn(&conn, &translation.resource_id, content)
        .map_err(|e| format!("Failed to update translation content: {}", e))?;

    log::info!(
        "[DSTU::content_helpers] update_translation_content: updated translation {} (resource: {})",
        translation_id,
        translation.resource_id
    );

    Ok(())
}

/// 更新知识导图内容
///
/// 内容格式：MindMapDocument JSON
fn update_mindmap_content(
    vfs_db: &Arc<VfsDatabase>,
    mindmap_id: &str,
    content: &str,
) -> Result<(), String> {
    use crate::vfs::VfsUpdateMindMapParams;

    // 使用 VfsMindMapRepo::update_mindmap 更新内容（内部会校验结构与限制）
    let update_params = VfsUpdateMindMapParams {
        title: None,
        description: None,
        content: Some(content.to_string()),
        default_view: None,
        theme: None,
        settings: None,
        expected_updated_at: None,
        version_source: Some("manual".to_string()),
    };

    VfsMindMapRepo::update_mindmap(vfs_db, mindmap_id, update_params)
        .map_err(|e| format!("Failed to update mindmap content: {}", e))?;

    log::info!(
        "[DSTU::content_helpers] update_mindmap_content: updated mindmap {}",
        mindmap_id
    );

    Ok(())
}

/// 更新题目集内容
///
/// 内容格式：preview_json
fn update_exam_content(
    vfs_db: &Arc<VfsDatabase>,
    exam_id: &str,
    content: &str,
) -> Result<(), String> {
    // 1. 解析内容为 JSON
    let preview_json: serde_json::Value = serde_json::from_str(content)
        .map_err(|e| format!("Invalid JSON content for exam: {}", e))?;

    // 2. 使用 VfsExamRepo::update_preview_json 更新内容
    VfsExamRepo::update_preview_json(vfs_db, exam_id, preview_json)
        .map_err(|e| format!("Failed to update exam content: {}", e))?;

    log::info!(
        "[DSTU::content_helpers] update_exam_content: updated exam {}",
        exam_id
    );

    Ok(())
}

/// 更新作文内容
///
/// 支持两种 ID 类型：
/// - `essay_session_*`：更新会话元数据（title, is_favorite）
///   内容格式：JSON `{ "title": "...", "is_favorite": true/false }`
/// - `essay_*`：更新单个轮次的作文内容（直接更新 resources.data）
fn update_essay_content(vfs_db: &Arc<VfsDatabase>, id: &str, content: &str) -> Result<(), String> {
    if id.starts_with("essay_session_") {
        // 作文会话：更新元数据
        // 内容格式：JSON { "title": "...", "is_favorite": true/false, "essayType": "...", "gradeLevel": "...", "customPrompt": "..." }
        let content_json: serde_json::Value = serde_json::from_str(content)
            .map_err(|e| format!("Invalid JSON content for essay session: {}", e))?;

        let title = content_json.get("title").and_then(|v| v.as_str());
        let is_favorite = content_json.get("is_favorite").and_then(|v| v.as_bool());
        let essay_type = content_json.get("essayType").and_then(|v| v.as_str());
        let grade_level = content_json.get("gradeLevel").and_then(|v| v.as_str());
        let custom_prompt = content_json.get("customPrompt").and_then(|v| v.as_str());

        if title.is_none()
            && is_favorite.is_none()
            && essay_type.is_none()
            && grade_level.is_none()
            && custom_prompt.is_none()
        {
            return Err("Essay session update requires at least one field: title/is_favorite/essayType/gradeLevel/customPrompt".to_string());
        }

        VfsEssayRepo::update_session(
            vfs_db,
            id,
            title,
            is_favorite,
            essay_type,
            grade_level,
            custom_prompt,
        )
        .map_err(|e| format!("Failed to update essay session: {}", e))?;

        log::info!(
            "[DSTU::content_helpers] update_essay_content: updated essay session {} (title={:?}, is_favorite={:?}, essayType={:?}, gradeLevel={:?})",
            id, title, is_favorite, essay_type, grade_level
        );

        Ok(())
    } else {
        // 单个作文轮次：更新作文内容
        // 1. 获取作文记录以找到 resource_id
        let essay = VfsEssayRepo::get_essay(vfs_db, id)
            .map_err(|e| format!("Failed to get essay: {}", e))?
            .ok_or_else(|| format!("Essay not found: {}", id))?;

        // 2. 获取数据库连接
        let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;

        // 3. 更新 resources.data（作文内容存储在此）
        VfsResourceRepo::update_resource_data_with_conn(&conn, &essay.resource_id, content)
            .map_err(|e| format!("Failed to update essay content: {}", e))?;

        log::info!(
            "[DSTU::content_helpers] update_essay_content: updated essay {} (resource: {})",
            id,
            essay.resource_id
        );

        Ok(())
    }
}
