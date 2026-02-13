//! 搜索辅助函数
//!
//! 包含资源搜索的辅助函数

use std::collections::HashSet;
use std::sync::Arc;

use rusqlite::params;
use serde_json::Value;

use crate::dstu::types::{DstuListOptions, DstuNode, DstuNodeType};
use crate::vfs::{
    VfsDatabase, VfsEssayRepo, VfsEssaySession, VfsExamRepo, VfsFile, VfsFolderRepo, VfsMindMap,
    VfsNoteRepo, VfsTextbook, VfsTextbookRepo, VfsTranslationRepo,
};

use super::{
    exam_to_dstu_node, file_to_dstu_node, mindmap_to_dstu_node, note_to_dstu_node,
    session_to_dstu_node, textbook_to_dstu_node, translation_to_dstu_node,
};

/// Log row-parse errors instead of silently discarding them.
fn log_and_skip_err<T>(result: Result<T, rusqlite::Error>) -> Option<T> {
    match result {
        Ok(v) => Some(v),
        Err(e) => {
            log::warn!("[search_helpers] Row parse error (skipped): {}", e);
            None
        }
    }
}

/// 转义 SQL LIKE 模式中的特殊字符
///
/// PATH-005修复: 防止SQL LIKE通配符注入
/// 转义 `%`、`_` 和 `\` 字符，防止用户输入被误解为通配符
///
/// # 示例
/// ```
/// assert_eq!(escape_like_pattern("test%value"), "test\\%value");
/// assert_eq!(escape_like_pattern("test_value"), "test\\_value");
/// ```
fn escape_like_pattern(input: &str) -> String {
    input
        .replace('\\', "\\\\") // 先转义反斜杠
        .replace('%', "\\%") // 转义百分号通配符
        .replace('_', "\\_") // 转义下划线通配符
}

fn build_snippet(text: &str, query: &str, max_len: usize) -> Option<String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower_text = text.to_lowercase();
    let lower_query = trimmed.to_lowercase();
    let byte_index = lower_text.find(&lower_query)?;
    let char_index = text[..byte_index].chars().count();
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return None;
    }
    let half = max_len / 2;
    let start = char_index.saturating_sub(half);
    let end = (start + max_len).min(chars.len());
    let mut snippet: String = chars[start..end].iter().collect();
    if start > 0 {
        snippet.insert(0, '…');
    }
    if end < chars.len() {
        snippet.push('…');
    }
    Some(snippet)
}

/// 搜索笔记
pub fn search_notes(
    vfs_db: &Arc<VfsDatabase>,
    query: &str,
    options: &DstuListOptions,
) -> Result<Vec<DstuNode>, String> {
    let required_tags: Vec<String> = options
        .tags
        .as_ref()
        .map(|tags| {
            tags.iter()
                .map(|t| t.trim().to_lowercase())
                .filter(|t| !t.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let has_tag_filter = !required_tags.is_empty();

    let limit = options.get_limit();
    let offset = options.get_offset();
    let mut results = Vec::new();

    // 无标签过滤时保持原有分页逻辑
    if !has_tag_filter {
        let notes = VfsNoteRepo::list_notes(vfs_db, Some(query), limit, offset)
            .map_err(|e| e.to_string())?;
        for note in notes {
            let mut node = note_to_dstu_node(&note);
            if let Ok(Some(content)) = VfsNoteRepo::get_note_content(vfs_db, &note.id) {
                if let Some(snippet) = build_snippet(&content, query, 160) {
                    let mut metadata = node.metadata.unwrap_or_else(|| serde_json::json!({}));
                    if let Some(map) = metadata.as_object_mut() {
                        map.insert("snippet".to_string(), Value::String(snippet));
                    }
                    node.metadata = Some(metadata);
                }
            }
            if let Some(ref types) = options.types {
                if !types.contains(&node.node_type) {
                    continue;
                }
            }
            results.push(node);
        }
        return Ok(results);
    }

    // 标签过滤时，确保分页发生在过滤之后
    let page_size = limit.max(50).min(200);
    let mut skipped = 0u32;
    let mut page_offset = 0u32;
    let mut rounds = 0u32;
    loop {
        let notes = VfsNoteRepo::list_notes(vfs_db, Some(query), page_size, page_offset)
            .map_err(|e| e.to_string())?;
        if notes.is_empty() {
            break;
        }

        for note in notes {
            let note_tags: std::collections::HashSet<String> =
                note.tags.iter().map(|t| t.trim().to_lowercase()).collect();
            if !required_tags.iter().all(|t| note_tags.contains(t)) {
                continue;
            }
            if skipped < offset {
                skipped += 1;
                continue;
            }

            let mut node = note_to_dstu_node(&note);
            if let Ok(Some(content)) = VfsNoteRepo::get_note_content(vfs_db, &note.id) {
                if let Some(snippet) = build_snippet(&content, query, 160) {
                    let mut metadata = node.metadata.unwrap_or_else(|| serde_json::json!({}));
                    if let Some(map) = metadata.as_object_mut() {
                        map.insert("snippet".to_string(), Value::String(snippet));
                    }
                    node.metadata = Some(metadata);
                }
            }
            if let Some(ref types) = options.types {
                if !types.contains(&node.node_type) {
                    continue;
                }
            }
            results.push(node);
            if results.len() >= limit as usize {
                break;
            }
        }

        if results.len() >= limit as usize {
            break;
        }
        page_offset = page_offset.saturating_add(page_size);
        rounds += 1;
        if rounds > 10_000 {
            log::warn!("[DSTU::search_helpers] search_notes aborted after too many pages");
            break;
        }
    }

    Ok(results)
}

/// 搜索题目集
pub fn search_exams(
    vfs_db: &Arc<VfsDatabase>,
    query: &str,
    options: &DstuListOptions,
) -> Result<Vec<DstuNode>, String> {
    let exams = VfsExamRepo::list_exam_sheets(
        vfs_db,
        Some(query),
        options.get_limit(),
        options.get_offset(),
    )
    .map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for exam in exams {
        let node = exam_to_dstu_node(&exam);
        if let Some(ref types) = options.types {
            if !types.contains(&node.node_type) {
                continue;
            }
        }
        results.push(node);
    }
    Ok(results)
}

/// 搜索翻译
pub fn search_translations(
    vfs_db: &Arc<VfsDatabase>,
    query: &str,
    options: &DstuListOptions,
) -> Result<Vec<DstuNode>, String> {
    let translations = VfsTranslationRepo::list_translations(
        vfs_db,
        Some(query),
        options.get_limit(),
        options.get_offset(),
    )
    .map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for translation in translations {
        let node = translation_to_dstu_node(&translation);
        if let Some(ref types) = options.types {
            if !types.contains(&node.node_type) {
                continue;
            }
        }
        results.push(node);
    }
    Ok(results)
}

/// 搜索教材（按 file_name 匹配，仅 PDF 类型）
pub fn search_textbooks(
    vfs_db: &Arc<VfsDatabase>,
    query: &str,
    options: &DstuListOptions,
) -> Result<Vec<DstuNode>, String> {
    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;
    // PATH-005修复: 转义LIKE通配符防止注入
    let escaped_query = escape_like_pattern(query);
    let search_pattern = format!("%{}%", escaped_query);
    let limit = options.get_limit();
    let offset = options.get_offset();

    let mut stmt = conn
        .prepare(
            r#"
        SELECT id, resource_id, blob_hash, sha256, file_name, original_path, size, page_count,
               tags_json, is_favorite, last_opened_at, last_page, bookmarks_json,
               cover_key, status, created_at, updated_at
        FROM files
        WHERE status = 'active'
          AND file_name LIKE ?1 ESCAPE '\'
          AND (mime_type LIKE '%pdf%' OR file_name LIKE '%.pdf')
        ORDER BY updated_at DESC
        LIMIT ?2 OFFSET ?3
        "#,
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![search_pattern, limit, offset], |row| {
            let tags_json: Option<String> = row.get(8)?;
            let bookmarks_json: Option<String> = row.get(12)?;

            Ok(VfsTextbook {
                id: row.get(0)?,
                resource_id: row.get(1)?,
                blob_hash: row.get(2)?,
                sha256: row.get(3)?,
                file_name: row.get(4)?,
                original_path: row.get(5)?,
                size: row.get(6)?,
                page_count: row.get(7)?,
                tags: tags_json
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default(),
                is_favorite: row.get::<_, i32>(9)? != 0,
                last_opened_at: row.get(10)?,
                last_page: row.get(11)?,
                bookmarks: bookmarks_json
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default(),
                cover_key: row.get(13)?,
                status: row.get(14)?,
                created_at: row.get(15)?,
                updated_at: row.get(16)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let textbooks: Vec<VfsTextbook> = rows.filter_map(log_and_skip_err).collect();

    let mut results = Vec::new();
    for textbook in textbooks {
        let node = textbook_to_dstu_node(&textbook);
        if let Some(ref types) = options.types {
            if !types.contains(&node.node_type) {
                continue;
            }
        }
        results.push(node);
    }
    Ok(results)
}

/// 搜索作文会话（按 title 匹配）
pub fn search_essays(
    vfs_db: &Arc<VfsDatabase>,
    query: &str,
    options: &DstuListOptions,
) -> Result<Vec<DstuNode>, String> {
    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;
    // PATH-005修复: 转义LIKE通配符防止注入
    let escaped_query = escape_like_pattern(query);
    let search_pattern = format!("%{}%", escaped_query);
    let limit = options.get_limit();
    let offset = options.get_offset();

    let mut stmt = conn
        .prepare(
            r#"
        SELECT id, title, essay_type, grade_level, custom_prompt,
               total_rounds, latest_score, is_favorite, created_at, updated_at, deleted_at
        FROM essay_sessions
        WHERE deleted_at IS NULL AND title LIKE ?1 ESCAPE '\'
        ORDER BY updated_at DESC
        LIMIT ?2 OFFSET ?3
        "#,
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![search_pattern, limit, offset], |row| {
            Ok(VfsEssaySession {
                id: row.get(0)?,
                title: row.get(1)?,
                essay_type: row.get(2)?,
                grade_level: row.get(3)?,
                custom_prompt: row.get(4)?,
                total_rounds: row.get(5)?,
                latest_score: row.get(6)?,
                is_favorite: row.get::<_, i32>(7)? != 0,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
                deleted_at: row.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let sessions: Vec<VfsEssaySession> = rows.filter_map(log_and_skip_err).collect();

    let mut results = Vec::new();
    for session in sessions {
        let node = session_to_dstu_node(&session);
        if let Some(ref types) = options.types {
            if !types.contains(&node.node_type) {
                continue;
            }
        }
        results.push(node);
    }
    Ok(results)
}

/// 搜索文件（按 file_name 匹配，排除 image 类型）
pub fn search_files(
    vfs_db: &Arc<VfsDatabase>,
    query: &str,
    options: &DstuListOptions,
) -> Result<Vec<DstuNode>, String> {
    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;
    // PATH-005修复: 转义LIKE通配符防止注入
    let escaped_query = escape_like_pattern(query);
    let search_pattern = format!("%{}%", escaped_query);
    let limit = options.get_limit();
    let offset = options.get_offset();

    let mut stmt = conn
        .prepare(
            r#"
        SELECT id, resource_id, blob_hash, sha256, file_name, original_path, size, page_count,
               "type", mime_type, tags_json, is_favorite, last_opened_at, last_page, bookmarks_json,
               cover_key, extracted_text, preview_json, ocr_pages_json, description,
               status, created_at, updated_at, deleted_at
        FROM files
        WHERE status = 'active'
          AND file_name LIKE ?1 ESCAPE '\'
          AND ("type" IS NULL OR "type" != 'image')
        ORDER BY updated_at DESC
        LIMIT ?2 OFFSET ?3
        "#,
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![search_pattern, limit, offset], |row| {
            let tags_json: Option<String> = row.get(10)?;
            let bookmarks_json: Option<String> = row.get(14)?;

            Ok(VfsFile {
                id: row.get(0)?,
                resource_id: row.get(1)?,
                blob_hash: row.get(2)?,
                sha256: row.get(3)?,
                file_name: row.get(4)?,
                original_path: row.get(5)?,
                size: row.get(6)?,
                page_count: row.get(7)?,
                file_type: row.get(8)?,
                mime_type: row.get(9)?,
                tags: tags_json
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default(),
                is_favorite: row.get::<_, i32>(11)? != 0,
                last_opened_at: row.get(12)?,
                last_page: row.get(13)?,
                bookmarks: bookmarks_json
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default(),
                cover_key: row.get(15)?,
                extracted_text: row.get(16)?,
                preview_json: row.get(17)?,
                ocr_pages_json: row.get(18)?,
                description: row.get(19)?,
                status: row.get(20)?,
                created_at: row.get(21)?,
                updated_at: row.get(22)?,
                deleted_at: row.get(23)?,
                // PDF 预处理流水线字段（搜索不需要，设为 None）
                processing_status: None,
                processing_progress: None,
                processing_error: None,
                processing_started_at: None,
                processing_completed_at: None,
                compressed_blob_hash: None,
            })
        })
        .map_err(|e| e.to_string())?;

    let files: Vec<VfsFile> = rows.filter_map(log_and_skip_err).collect();

    let mut results = Vec::new();
    for file in files {
        let node = file_to_dstu_node(&file);
        if let Some(ref types) = options.types {
            if !types.contains(&node.node_type) {
                continue;
            }
        }
        results.push(node);
    }
    Ok(results)
}

/// 搜索图片（按 file_name 匹配，仅 image 类型）
pub fn search_images(
    vfs_db: &Arc<VfsDatabase>,
    query: &str,
    options: &DstuListOptions,
) -> Result<Vec<DstuNode>, String> {
    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;
    // PATH-005修复: 转义LIKE通配符防止注入
    let escaped_query = escape_like_pattern(query);
    let search_pattern = format!("%{}%", escaped_query);
    let limit = options.get_limit();
    let offset = options.get_offset();

    let mut stmt = conn
        .prepare(
            r#"
        SELECT id, resource_id, blob_hash, sha256, file_name, original_path, size, page_count,
               "type", mime_type, tags_json, is_favorite, last_opened_at, last_page, bookmarks_json,
               cover_key, extracted_text, preview_json, ocr_pages_json, description,
               status, created_at, updated_at, deleted_at
        FROM files
        WHERE status = 'active'
          AND file_name LIKE ?1 ESCAPE '\'
          AND "type" = 'image'
        ORDER BY updated_at DESC
        LIMIT ?2 OFFSET ?3
        "#,
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![search_pattern, limit, offset], |row| {
            let tags_json: Option<String> = row.get(10)?;
            let bookmarks_json: Option<String> = row.get(14)?;

            Ok(VfsFile {
                id: row.get(0)?,
                resource_id: row.get(1)?,
                blob_hash: row.get(2)?,
                sha256: row.get(3)?,
                file_name: row.get(4)?,
                original_path: row.get(5)?,
                size: row.get(6)?,
                page_count: row.get(7)?,
                file_type: row.get(8)?,
                mime_type: row.get(9)?,
                tags: tags_json
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default(),
                is_favorite: row.get::<_, i32>(11)? != 0,
                last_opened_at: row.get(12)?,
                last_page: row.get(13)?,
                bookmarks: bookmarks_json
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default(),
                cover_key: row.get(15)?,
                extracted_text: row.get(16)?,
                preview_json: row.get(17)?,
                ocr_pages_json: row.get(18)?,
                description: row.get(19)?,
                status: row.get(20)?,
                created_at: row.get(21)?,
                updated_at: row.get(22)?,
                deleted_at: row.get(23)?,
                // PDF 预处理流水线字段（搜索结果中不需要）
                processing_status: None,
                processing_progress: None,
                processing_error: None,
                processing_started_at: None,
                processing_completed_at: None,
                compressed_blob_hash: None,
            })
        })
        .map_err(|e| e.to_string())?;

    let files: Vec<VfsFile> = rows.filter_map(log_and_skip_err).collect();

    let mut results = Vec::new();
    for file in files {
        let node = file_to_dstu_node(&file);
        if let Some(ref types) = options.types {
            if !types.contains(&node.node_type) {
                continue;
            }
        }
        results.push(node);
    }
    Ok(results)
}

/// 搜索知识导图（按 title 匹配）
pub fn search_mindmaps(
    vfs_db: &Arc<VfsDatabase>,
    query: &str,
    options: &DstuListOptions,
) -> Result<Vec<DstuNode>, String> {
    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;
    // PATH-005修复: 转义LIKE通配符防止注入
    let escaped_query = escape_like_pattern(query);
    let search_pattern = format!("%{}%", escaped_query);
    let limit = options.get_limit();
    let offset = options.get_offset();

    let mut stmt = conn.prepare(
        r#"
        SELECT id, resource_id, title, description, is_favorite, default_view, theme, settings, created_at, updated_at, deleted_at
        FROM mindmaps
        WHERE deleted_at IS NULL AND title LIKE ?1 ESCAPE '\'
        ORDER BY updated_at DESC
        LIMIT ?2 OFFSET ?3
        "#,
    ).map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![search_pattern, limit, offset], |row| {
            let settings_str: Option<String> = row.get(7)?;
            let settings: Option<Value> = settings_str.and_then(|s| serde_json::from_str(&s).ok());

            Ok(VfsMindMap {
                id: row.get(0)?,
                resource_id: row.get(1)?,
                title: row.get(2)?,
                description: row.get(3)?,
                is_favorite: row.get::<_, i32>(4)? != 0,
                default_view: row.get(5)?,
                theme: row.get(6)?,
                settings,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
                deleted_at: row.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mindmaps: Vec<VfsMindMap> = rows.filter_map(log_and_skip_err).collect();

    let mut results = Vec::new();
    for mindmap in mindmaps {
        let node = mindmap_to_dstu_node(&mindmap);
        if let Some(ref types) = options.types {
            if !types.contains(&node.node_type) {
                continue;
            }
        }
        results.push(node);
    }
    Ok(results)
}

/// 全类型搜索
pub fn search_all(
    vfs_db: &Arc<VfsDatabase>,
    query: &str,
    options: &DstuListOptions,
) -> Result<Vec<DstuNode>, String> {
    let mut results = Vec::new();

    // S-020: 如果指定了 folder_id，先获取文件夹内的资源 ID 集合，用于后续过滤
    let folder_item_ids: Option<HashSet<String>> = if let Some(ref folder_id) = options.folder_id {
        let items = VfsFolderRepo::list_items_by_folder(vfs_db, Some(folder_id))
            .map_err(|e| format!("list folder items: {}", e))?;
        Some(items.iter().map(|item| item.item_id.clone()).collect())
    } else {
        None
    };

    if let Some(type_filter) = options.get_type_filter() {
        let mut typed_results = match type_filter {
            DstuNodeType::Note => search_notes(vfs_db, query, options),
            DstuNodeType::Exam => search_exams(vfs_db, query, options),
            DstuNodeType::Translation => search_translations(vfs_db, query, options),
            DstuNodeType::Textbook => search_textbooks(vfs_db, query, options),
            DstuNodeType::Essay => search_essays(vfs_db, query, options),
            DstuNodeType::File => search_files(vfs_db, query, options),
            DstuNodeType::Image => search_images(vfs_db, query, options),
            DstuNodeType::MindMap => search_mindmaps(vfs_db, query, options),
            _ => Ok(Vec::new()),
        }?;

        // S-020: 按 folder_id 过滤
        if let Some(ref ids) = folder_item_ids {
            typed_results.retain(|node| ids.contains(&node.id));
        }

        return Ok(typed_results);
    }

    // 搜索笔记
    if let Ok(notes) = search_notes(vfs_db, query, options) {
        results.extend(notes);
    }

    // 搜索题目集
    if let Ok(exams) = search_exams(vfs_db, query, options) {
        results.extend(exams);
    }

    // 搜索翻译
    if let Ok(translations) = search_translations(vfs_db, query, options) {
        results.extend(translations);
    }

    // 搜索教材
    if let Ok(textbooks) = search_textbooks(vfs_db, query, options) {
        results.extend(textbooks);
    }

    // 搜索作文会话
    if let Ok(essays) = search_essays(vfs_db, query, options) {
        results.extend(essays);
    }

    // 搜索文件
    if let Ok(files) = search_files(vfs_db, query, options) {
        results.extend(files);
    }

    // 搜索图片
    if let Ok(images) = search_images(vfs_db, query, options) {
        results.extend(images);
    }

    // 搜索知识导图
    if let Ok(mindmaps) = search_mindmaps(vfs_db, query, options) {
        results.extend(mindmaps);
    }

    // S-020: 按 folder_id 过滤搜索结果
    if let Some(ref ids) = folder_item_ids {
        results.retain(|node| ids.contains(&node.id));
    }

    // 按更新时间排序
    results.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

    Ok(results)
}
