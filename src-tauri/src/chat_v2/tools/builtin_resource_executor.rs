//! 内置学习资源工具执行器
//!
//! 执行三个内置学习资源工具：
//! - `builtin-resource_list` - 列出学习资源
//! - `builtin-resource_read` - 读取资源内容
//! - `builtin-resource_search` - 搜索资源
//!
//! ## 设计说明
//! 该执行器通过 VfsDatabase 直接访问 DSTU 数据层，
//! 为 LLM 提供主动读取用户学习资源的能力。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use rusqlite::OptionalExtension;
use serde_json::{json, Value};

use super::arg_utils::get_json_array_arg;
use super::executor::{ExecutionContext, ToolConcurrency, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use super::workbench_bridge::{
    acr_bridge_call, apply_ops_timeout_ms, is_bridge_cancelled, is_valid_apply_receipt,
    uncertain_apply_receipt, PROBE_TIMEOUT_MS,
};
use super::workbench_executor::is_workbench_agent_delegation_enabled;
use crate::chat_v2::events::event_types;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::dstu::handler_utils::{
    emit_watch_event, essay_to_dstu_node, exam_to_dstu_node, file_to_dstu_node,
    get_content_by_type, get_content_by_type_paged, get_file_total_pages, mindmap_to_dstu_node,
    note_to_dstu_node, search_all, session_to_dstu_node, textbook_to_dstu_node,
    translation_to_dstu_node,
};
use crate::dstu::types::{DstuListOptions, DstuNode, DstuNodeType, DstuWatchEvent};
use crate::utils::text::safe_truncate_chars;
use crate::vfs::repos::embedding_repo::VfsIndexStateRepo;
use crate::vfs::{
    VfsBlobRepo, VfsCreateMindMapParams, VfsDatabase, VfsEssayRepo, VfsExamRepo, VfsFileRepo,
    VfsMindMapRepo, VfsNoteRepo, VfsResourceRepo, VfsTextbookRepo, VfsTranslationRepo,
    VfsUpdateMindMapParams,
};

// ============================================================================
// 常量
// ============================================================================

/// 默认列表数量
const DEFAULT_LIST_LIMIT: u32 = 20;
/// ★ L-028: 列表查询最大数量限制（后端 clamp，防止前端传入过大值）
const MAX_LIST_LIMIT: u64 = 100;
/// 默认搜索数量
const DEFAULT_SEARCH_TOP_K: u32 = 10;
/// ★ L-028: 搜索查询最大数量限制（后端 clamp）
const MAX_SEARCH_TOP_K: u64 = 50;

/// ★ D15 修复：resource_read 单次返回内容的硬上限（字符数）。
/// 超过该上限将截断并在结果中附带 truncationNotice，引导 LLM 按页读取。
const MAX_READ_CONTENT_CHARS: usize = 40_000;

// ============================================================================
// 内置学习资源工具执行器
// ============================================================================

/// 内置学习资源工具执行器
///
/// 处理以 `builtin-` 开头的学习资源工具：
/// - `builtin-resource_list` - 列出学习资源
/// - `builtin-resource_read` - 读取资源内容
/// - `builtin-resource_search` - 搜索资源
pub struct BuiltinResourceExecutor;

struct ResolvedReadTarget {
    requested_id: String,
    read_id: String,
    resource_type: &'static str,
    resolved_by: &'static str,
}

#[derive(Debug, Clone, Default)]
struct ReadAvailability {
    has_extracted_text: bool,
    has_ocr_pages: bool,
    has_preview_images: bool,
    has_image_ocr: bool,
    has_structured_content: bool,
}

#[derive(Debug, Clone, Default)]
struct DegradationInfo {
    level: &'static str,
    reason_codes: Vec<String>,
    message: String,
}

#[derive(Debug, Clone)]
struct MindMapNodeSnapshot {
    id: String,
    text: String,
    parent_id: Option<String>,
    path: String,
    signature: String,
}

/// mindmap_import 导入统计：节点计数 + 被丢弃能力项如实上报（不静默）
#[derive(Debug, Default)]
struct MindMapImportStats {
    node_count: usize,
    dropped_images: usize,
    dropped_summaries: usize,
    dropped_boundaries: usize,
    dropped_hyperlinks: usize,
}

impl BuiltinResourceExecutor {
    /// 创建新的内置学习资源工具执行器
    pub fn new() -> Self {
        Self
    }

    /// 将资源类型字符串转换为 DstuNodeType
    fn parse_resource_type(type_str: &str) -> Option<DstuNodeType> {
        match type_str {
            "note" | "notes" => Some(DstuNodeType::Note),
            "textbook" | "textbooks" => Some(DstuNodeType::Textbook),
            "exam" | "exams" => Some(DstuNodeType::Exam),
            "essay" | "essays" => Some(DstuNodeType::Essay),
            "translation" | "translations" => Some(DstuNodeType::Translation),
            "image" | "images" => Some(DstuNodeType::Image),
            "file" | "files" => Some(DstuNodeType::File),
            "mindmap" | "mindmaps" => Some(DstuNodeType::MindMap),
            _ => None,
        }
    }

    /// 从资源 ID 推断资源类型
    fn infer_type_from_id(resource_id: &str) -> Option<&'static str> {
        if resource_id.starts_with("note_") {
            Some("notes")
        } else if resource_id.starts_with("file_")
            || resource_id.starts_with("tb_")
            || resource_id.starts_with("att_")
        {
            Some("files")
        } else if resource_id.starts_with("exam_") {
            Some("exams")
        } else if resource_id.starts_with("essay_session_")
            || resource_id.starts_with("essay_")
            || resource_id.starts_with("es_")
        {
            Some("essays")
        } else if resource_id.starts_with("tr_") {
            Some("translations")
        } else if resource_id.starts_with("mm_") {
            Some("mindmaps")
        } else {
            None
        }
    }

    fn is_supported_read_id(id: &str) -> bool {
        if id.is_empty()
            || id.chars().any(char::is_whitespace)
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return false;
        }
        Self::infer_type_from_id(id).is_some() || id.starts_with("res_")
    }

    fn sanitize_read_resource_id(raw: &str) -> String {
        let trimmed = raw
            .trim()
            .trim_matches(|c| c == '"' || c == '\'' || c == '`');
        if Self::is_supported_read_id(trimmed) {
            return trimmed.to_string();
        }

        const PREFIXES: [&str; 10] = [
            "note_",
            "tb_",
            "file_",
            "att_",
            "exam_",
            "essay_session_",
            "essay_",
            "es_",
            "tr_",
            "mm_",
        ];
        const RES_PREFIX: &str = "res_";

        for token in trimmed.split_whitespace() {
            let candidate =
                token.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '-');
            if Self::is_supported_read_id(candidate) {
                return candidate.to_string();
            }
        }

        let normalized: String = trimmed
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                    c
                } else {
                    ' '
                }
            })
            .collect();

        for token in normalized.split_whitespace() {
            if Self::is_supported_read_id(token) {
                return token.to_string();
            }
        }

        for prefix in PREFIXES.iter().chain(std::iter::once(&RES_PREFIX)) {
            if let Some(start) = trimmed.find(prefix) {
                let suffix: String = trimmed[start..]
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
                    .collect();
                if Self::is_supported_read_id(&suffix) {
                    return suffix;
                }
            }
        }

        trimmed.to_string()
    }

    fn pick_resource_read_id(arguments: &Value) -> Option<(String, &'static str)> {
        let candidates = [
            ("resource_id", "resource_id"),
            ("readResourceId", "readResourceId"),
            ("read_resource_id", "read_resource_id"),
            ("sourceId", "sourceId"),
            ("source_id", "source_id"),
            ("resourceId", "resourceId"),
        ];

        for (key, source) in candidates {
            if let Some(value) = arguments.get(key).and_then(|v| v.as_str()) {
                let sanitized = Self::sanitize_read_resource_id(value);
                if !sanitized.trim().is_empty() {
                    return Some((sanitized, source));
                }
            }
        }

        None
    }

    fn collect_read_availability(
        resource_type: &str,
        content: &str,
        metadata: Option<&Value>,
    ) -> ReadAvailability {
        let mut availability = ReadAvailability::default();
        if let Some(meta) = metadata {
            availability.has_extracted_text = meta
                .get("hasExtractedText")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            availability.has_ocr_pages = meta
                .get("hasOcrPages")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            availability.has_preview_images = meta
                .get("hasPreviewImages")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
                || meta
                    .get("previewImages")
                    .and_then(|v| v.as_array())
                    .map(|v| !v.is_empty())
                    .unwrap_or(false);
            availability.has_image_ocr = meta
                .get("hasImageOcr")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            availability.has_structured_content = meta
                .get("hasStructuredContent")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
        }

        if resource_type == "exams" {
            availability.has_structured_content =
                availability.has_structured_content || content.contains("<question");
        }
        if resource_type == "mindmaps" {
            availability.has_structured_content =
                availability.has_structured_content || content.contains("\"root\"");
        }
        if resource_type == "files" {
            availability.has_extracted_text =
                availability.has_extracted_text || content.contains("--- 第 ");
            availability.has_ocr_pages = availability.has_ocr_pages || content.contains("--- 第 ");
        }
        if resource_type == "images" {
            availability.has_image_ocr =
                availability.has_image_ocr || content.contains("<image_ocr");
        }

        availability
    }

    fn build_degradation_info(
        resource_type: &str,
        content: &str,
        availability: &ReadAvailability,
        metadata_error: Option<&String>,
    ) -> DegradationInfo {
        let mut reason_codes: Vec<String> = Vec::new();
        let mut level = "none";

        if content.trim().is_empty() {
            level = "fallback";
            reason_codes.push("empty_content".to_string());
        }

        if content.starts_with("[文档:") {
            level = "fallback";
            reason_codes.push("filename_placeholder".to_string());
        }

        if resource_type == "files" && !availability.has_ocr_pages {
            reason_codes.push("missing_ocr_pages".to_string());
            if level == "none" {
                level = "partial";
            }
        }

        if resource_type == "files" && !availability.has_extracted_text {
            reason_codes.push("missing_extracted_text".to_string());
            if level == "none" {
                level = "partial";
            }
        }

        if resource_type == "exams" && !availability.has_structured_content {
            reason_codes.push("missing_structured_exam_content".to_string());
            if level == "none" {
                level = "partial";
            }
        }

        if resource_type == "images" && !availability.has_image_ocr {
            reason_codes.push("missing_image_ocr".to_string());
            if level == "none" {
                level = "partial";
            }
        }

        if metadata_error.is_some() {
            reason_codes.push("metadata_error".to_string());
            if level == "none" {
                level = "partial";
            }
        }

        let message = match level {
            "none" => "内容完整可用。".to_string(),
            "partial" => "已返回部分能力（部分字段缺失或降级）。".to_string(),
            _ => "已触发兜底退化，返回了可用的最小内容。".to_string(),
        };

        DegradationInfo {
            level,
            reason_codes,
            message,
        }
    }

    fn infer_content_type_from_resource(
        resource: &crate::vfs::types::VfsResource,
    ) -> Option<&'static str> {
        match resource.resource_type {
            crate::vfs::types::VfsResourceType::Note => Some("notes"),
            crate::vfs::types::VfsResourceType::Textbook
            | crate::vfs::types::VfsResourceType::Image
            | crate::vfs::types::VfsResourceType::File => Some("files"),
            crate::vfs::types::VfsResourceType::Exam => Some("exams"),
            crate::vfs::types::VfsResourceType::Essay => Some("essays"),
            crate::vfs::types::VfsResourceType::Translation => Some("translations"),
            crate::vfs::types::VfsResourceType::MindMap => Some("mindmaps"),
            crate::vfs::types::VfsResourceType::Retrieval => None,
        }
    }

    fn resolve_source_id_by_resource_id(
        vfs_db: &Arc<VfsDatabase>,
        resource_type: &str,
        resource_id: &str,
    ) -> Option<String> {
        let conn = vfs_db.get_conn_safe().ok()?;
        let sql = match resource_type {
            "notes" => "SELECT id FROM notes WHERE resource_id = ?1 LIMIT 1",
            "files" => "SELECT id FROM files WHERE resource_id = ?1 LIMIT 1",
            "exams" => "SELECT id FROM exam_sheets WHERE resource_id = ?1 LIMIT 1",
            "essays" => {
                "SELECT id FROM essays WHERE resource_id = ?1 ORDER BY updated_at DESC LIMIT 1"
            }
            "translations" => "SELECT id FROM translations WHERE resource_id = ?1 LIMIT 1",
            "mindmaps" => "SELECT id FROM mindmaps WHERE resource_id = ?1 LIMIT 1",
            _ => return None,
        };

        conn.query_row(sql, rusqlite::params![resource_id], |row| {
            row.get::<_, String>(0)
        })
        .optional()
        .ok()
        .flatten()
    }

    fn resolve_read_target(
        vfs_db: &Arc<VfsDatabase>,
        raw_resource_id: &str,
    ) -> Result<ResolvedReadTarget, String> {
        let requested_id = Self::sanitize_read_resource_id(raw_resource_id);

        if let Some(resource_type) = Self::infer_type_from_id(&requested_id) {
            return Ok(ResolvedReadTarget {
                requested_id: requested_id.clone(),
                read_id: requested_id,
                resource_type,
                resolved_by: "direct",
            });
        }

        if !requested_id.starts_with("res_") {
            return Err(format!(
                "Cannot infer resource type from ID: {}. 请传入 note_/tb_/file_/exam_/essay_/tr_/mm_ 或 res_ 开头的资源 ID。",
                requested_id
            ));
        }

        let resource = VfsResourceRepo::get_resource(vfs_db, &requested_id)
            .map_err(|e| format!("Failed to resolve resource '{}': {}", requested_id, e))?
            .ok_or_else(|| {
                format!(
                    "Resource '{}' not found. 请先调用 unified_search/resource_list 获取最新 ID。",
                    requested_id
                )
            })?;

        if let Some(source_id) = resource.source_id.as_deref() {
            if let Some(resource_type) = Self::infer_type_from_id(source_id) {
                return Ok(ResolvedReadTarget {
                    requested_id,
                    read_id: source_id.to_string(),
                    resource_type,
                    resolved_by: "resource.source_id",
                });
            }
        }

        let resource_type = Self::infer_content_type_from_resource(&resource).ok_or_else(|| {
            format!(
                "Resource '{}' type '{}' does not support builtin-resource_read.",
                resource.id, resource.resource_type
            )
        })?;

        if let Some(source_id) =
            Self::resolve_source_id_by_resource_id(vfs_db, resource_type, &resource.id)
        {
            if let Some(inferred_type) = Self::infer_type_from_id(&source_id) {
                return Ok(ResolvedReadTarget {
                    requested_id,
                    read_id: source_id,
                    resource_type: inferred_type,
                    resolved_by: "resource_id_lookup",
                });
            }
        }

        Err(format!(
            "Resource '{}' exists, but cannot map it to a readable source ID. 请尝试 resource_list/resource_search 重新定位具体资源。",
            resource.id
        ))
    }

    fn extract_page_preview_images(vfs_db: &Arc<VfsDatabase>, preview: &Value) -> Vec<Value> {
        let mut images = Vec::new();
        let pages = preview.get("pages").and_then(|v| v.as_array());
        let Some(pages) = pages else {
            return images;
        };

        for (idx, page) in pages.iter().enumerate() {
            let page_index = page
                .get("pageIndex")
                .and_then(|v| v.as_u64())
                .or_else(|| page.get("page_index").and_then(|v| v.as_u64()))
                .unwrap_or(idx as u64);
            let preferred_hash = page
                .get("compressedBlobHash")
                .and_then(|v| v.as_str())
                .or_else(|| page.get("compressed_blob_hash").and_then(|v| v.as_str()))
                .or_else(|| page.get("blobHash").and_then(|v| v.as_str()))
                .or_else(|| page.get("blob_hash").and_then(|v| v.as_str()));
            let Some(blob_hash) = preferred_hash else {
                continue;
            };

            let image_path = VfsBlobRepo::get_blob_path(vfs_db, blob_hash)
                .ok()
                .flatten()
                .map(|p| p.to_string_lossy().to_string());

            images.push(json!({
                "pageIndex": page_index,
                "blobHash": blob_hash,
                "imagePath": image_path,
            }));
        }

        images
    }

    fn extract_page_preview_images_from_str(
        vfs_db: &Arc<VfsDatabase>,
        preview_json: Option<&str>,
    ) -> Vec<Value> {
        let Some(raw) = preview_json else {
            return Vec::new();
        };
        if raw.trim().is_empty() {
            return Vec::new();
        }
        let parsed: Value = match serde_json::from_str(raw) {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        };
        Self::extract_page_preview_images(vfs_db, &parsed)
    }

    /// ★ M-062: essay 类型在 resource_list（Low 敏感度）中需要脱敏的字段
    ///
    /// 这些字段包含评分/批改结果，属于敏感学习数据，
    /// 不应在无需审批的 Low 敏感度列表操作中暴露给 LLM。
    const ESSAY_SENSITIVE_METADATA_FIELDS: &'static [&'static str] = &[
        "score",
        "gradingResult",
        "grading_result",
        "latestScore",
        "latest_score",
        "gradeLevel",
        "grade_level",
    ];

    /// ★ M-062: 从 essay 类型节点的 metadata 中移除敏感字段
    ///
    /// resource_list 是 Low 敏感度操作（不需要用户审批），
    /// 但 essay 的 metadata 可能包含 score、gradingResult 等评分数据。
    /// 作为纵深防御，在返回前移除这些字段，防止评分数据泄露给 LLM。
    fn sanitize_essay_nodes_for_list(results: &mut [DstuNode]) {
        for node in results.iter_mut() {
            if matches!(node.node_type, DstuNodeType::Essay) {
                if let Some(ref mut metadata) = node.metadata {
                    if let Some(obj) = metadata.as_object_mut() {
                        let mut removed = Vec::new();
                        for &field in Self::ESSAY_SENSITIVE_METADATA_FIELDS {
                            if obj.remove(field).is_some() {
                                removed.push(field);
                            }
                        }
                        if !removed.is_empty() {
                            log::debug!(
                                "[BuiltinResourceExecutor] M-062: sanitized essay node {}, removed fields: {:?}",
                                node.id,
                                removed
                            );
                        }
                    }
                }
            }
        }
    }

    /// 执行资源列表
    async fn execute_list(&self, call: &ToolCall, ctx: &ExecutionContext) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;

        // 解析参数
        let type_filter = call
            .arguments
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("all");
        let folder_id = call
            .arguments
            .get("folder_id")
            .and_then(|v| v.as_str())
            .map(String::from);
        let search = call
            .arguments
            .get("search")
            .and_then(|v| v.as_str())
            .map(String::from);
        // ★ L-028: 后端 clamp，防止 LLM/前端传入过大或非法值
        let limit = call
            .arguments
            .get("limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_LIST_LIMIT as u64)
            .clamp(1, MAX_LIST_LIMIT) as u32;
        let favorites_only = call
            .arguments
            .get("favorites_only")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        log::debug!(
            "[BuiltinResourceExecutor] resource_list: type={}, folder_id={:?}, search={:?}, limit={}, favorites_only={}",
            type_filter, folder_id, search, limit, favorites_only
        );

        let start_time = Instant::now();

        // 构建列表选项
        let options = DstuListOptions {
            folder_id: folder_id.or_else(|| Some("root".to_string())),
            types: if type_filter == "all" {
                None
            } else {
                Self::parse_resource_type(type_filter).map(|t| vec![t])
            },
            is_favorite: if favorites_only { Some(true) } else { None },
            limit: Some(limit),
            offset: None,
            sort_by: Some("updatedAt".to_string()),
            sort_order: Some("desc".to_string()),
            search: search.clone(),
            ..Default::default()
        };

        // 根据是否有搜索关键词决定执行方式
        let (mut results, partial_errors) = if let Some(ref query) = search {
            // 有搜索关键词，使用搜索函数
            (search_all(vfs_db, query, &options)?, vec![])
        } else {
            // 无搜索关键词，按类型列出
            self.list_by_type(vfs_db, type_filter, &options)?
        };

        // ★ M-062: 脱敏 - resource_list 是 Low 敏感度，移除 essay 节点中的评分数据
        Self::sanitize_essay_nodes_for_list(&mut results);

        let duration = start_time.elapsed().as_millis() as u64;

        // 转换为简化的输出格式
        let items: Vec<Value> = results
            .iter()
            .map(|node| {
                json!({
                    "id": node.id,
                    "name": node.name,
                    "type": format!("{:?}", node.node_type).to_lowercase(),
                    "path": node.path,
                    "updatedAt": node.updated_at,
                    "size": node.size,
                    "isFavorite": node.metadata.as_ref()
                        .and_then(|m| m.get("isFavorite"))
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                })
            })
            .collect();

        log::debug!(
            "[BuiltinResourceExecutor] resource_list completed: {} items, {} partial_errors in {}ms",
            items.len(),
            partial_errors.len(),
            duration
        );

        let mut response = json!({
            "success": true,
            "items": items,
            "count": items.len(),
            "durationMs": duration,
        });

        // ★ 2026-02-09: 如果有子查询错误，在返回中标记部分成功
        if !partial_errors.is_empty() {
            response["partial_errors"] = json!(partial_errors);
            response["partial_success"] = json!(true);
        }

        Ok(response)
    }

    /// 按类型列出资源
    ///
    /// ★ 2026-01-26 修复：正确应用 is_favorite 和 folder_id 筛选
    /// ★ 2026-02-09 修复：all 分支收集子查询错误而非静默吞掉，返回 (results, partial_errors)
    fn list_by_type(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        type_filter: &str,
        options: &DstuListOptions,
    ) -> Result<(Vec<DstuNode>, Vec<String>), String> {
        let limit = options.limit.unwrap_or(DEFAULT_LIST_LIMIT);
        let offset = options.offset.unwrap_or(0);
        let favorites_only = options.is_favorite.unwrap_or(false);
        let folder_id = options.folder_id.as_deref();

        // 如果指定了 folder_id 且不是 "root"，使用 folder_items 查询
        let use_folder_filter = folder_id.map(|id| id != "root").unwrap_or(false);

        let (mut results, partial_errors) = match type_filter {
            "note" | "notes" => {
                let nodes = if use_folder_filter {
                    let notes = VfsNoteRepo::list_notes_by_folder(vfs_db, folder_id, limit, offset)
                        .map_err(|e| e.to_string())?;
                    notes.into_iter().map(|n| note_to_dstu_node(&n)).collect()
                } else {
                    let notes = VfsNoteRepo::list_notes(vfs_db, None, limit, offset)
                        .map_err(|e| e.to_string())?;
                    notes.into_iter().map(|n| note_to_dstu_node(&n)).collect()
                };
                (nodes, vec![])
            }
            "textbook" | "textbooks" => {
                let nodes = if use_folder_filter {
                    let textbooks =
                        VfsTextbookRepo::list_textbooks_by_folder(vfs_db, folder_id, limit, offset)
                            .map_err(|e| e.to_string())?;
                    textbooks
                        .into_iter()
                        .map(|t| textbook_to_dstu_node(&t))
                        .collect()
                } else {
                    let textbooks = VfsTextbookRepo::list_textbooks(vfs_db, limit, offset)
                        .map_err(|e| e.to_string())?;
                    textbooks
                        .into_iter()
                        .map(|t| textbook_to_dstu_node(&t))
                        .collect()
                };
                (nodes, vec![])
            }
            "exam" | "exams" => {
                let nodes = if use_folder_filter {
                    let exams =
                        VfsExamRepo::list_exam_sheets_by_folder(vfs_db, folder_id, limit, offset)
                            .map_err(|e| e.to_string())?;
                    exams.into_iter().map(|e| exam_to_dstu_node(&e)).collect()
                } else {
                    let exams = VfsExamRepo::list_exam_sheets(vfs_db, None, limit, offset)
                        .map_err(|e| e.to_string())?;
                    exams.into_iter().map(|e| exam_to_dstu_node(&e)).collect()
                };
                (nodes, vec![])
            }
            "essay" | "essays" => {
                let nodes = if use_folder_filter {
                    let essays =
                        VfsEssayRepo::list_essays_by_folder(vfs_db, folder_id, limit, offset)
                            .map_err(|e| e.to_string())?;
                    essays.into_iter().map(|e| essay_to_dstu_node(&e)).collect()
                } else {
                    let sessions = VfsEssayRepo::list_sessions(vfs_db, limit, offset)
                        .map_err(|e| e.to_string())?;
                    sessions
                        .into_iter()
                        .map(|s| session_to_dstu_node(&s))
                        .collect()
                };
                (nodes, vec![])
            }
            "translation" | "translations" => {
                let nodes = if use_folder_filter {
                    let translations = VfsTranslationRepo::list_translations_by_folder(
                        vfs_db, folder_id, limit, offset,
                    )
                    .map_err(|e| e.to_string())?;
                    translations
                        .into_iter()
                        .map(|t| translation_to_dstu_node(&t))
                        .collect()
                } else {
                    let translations =
                        VfsTranslationRepo::list_translations(vfs_db, None, limit, offset)
                            .map_err(|e| e.to_string())?;
                    translations
                        .into_iter()
                        .map(|t| translation_to_dstu_node(&t))
                        .collect()
                };
                (nodes, vec![])
            }
            "file" | "files" => {
                let nodes = if use_folder_filter {
                    let files = VfsFileRepo::list_files_by_folder(vfs_db, folder_id, limit, offset)
                        .map_err(|e| e.to_string())?;
                    files.into_iter().map(|f| file_to_dstu_node(&f)).collect()
                } else {
                    let files = VfsFileRepo::list_files_by_type(vfs_db, "document", limit, offset)
                        .map_err(|e| e.to_string())?;
                    files.into_iter().map(|f| file_to_dstu_node(&f)).collect()
                };
                (nodes, vec![])
            }
            "image" | "images" => {
                let nodes = if use_folder_filter {
                    let files = VfsFileRepo::list_files_by_folder(vfs_db, folder_id, limit, offset)
                        .map_err(|e| e.to_string())?;
                    files
                        .into_iter()
                        .filter(|f| f.file_type == "image")
                        .map(|f| file_to_dstu_node(&f))
                        .collect()
                } else {
                    let images = VfsFileRepo::list_files_by_type(vfs_db, "image", limit, offset)
                        .map_err(|e| e.to_string())?;
                    images.into_iter().map(|f| file_to_dstu_node(&f)).collect()
                };
                (nodes, vec![])
            }
            "mindmap" | "mindmaps" => {
                let nodes = if use_folder_filter {
                    let mindmaps =
                        VfsMindMapRepo::list_mindmaps_by_folder(vfs_db, folder_id, limit, offset)
                            .map_err(|e| e.to_string())?;
                    mindmaps
                        .into_iter()
                        .map(|m| mindmap_to_dstu_node(&m))
                        .collect()
                } else {
                    let mindmaps =
                        VfsMindMapRepo::list_mindmaps(vfs_db).map_err(|e| e.to_string())?;
                    mindmaps
                        .into_iter()
                        .take(limit as usize)
                        .map(|m| mindmap_to_dstu_node(&m))
                        .collect()
                };
                (nodes, vec![])
            }
            "all" => {
                // 列出所有类型（合并结果）
                // ★ 2026-02-09 修复：收集子查询错误而非静默吞掉
                let mut all_results: Vec<DstuNode> = Vec::new();
                let mut errors: Vec<String> = Vec::new();
                let per_type_limit = (limit / 8).max(5);

                if use_folder_filter {
                    match VfsNoteRepo::list_notes_by_folder(vfs_db, folder_id, per_type_limit, 0) {
                        Ok(notes) => {
                            all_results.extend(notes.into_iter().map(|n| note_to_dstu_node(&n)));
                        }
                        Err(e) => {
                            log::warn!("[BuiltinResourceExecutor] all: notes query failed: {}", e);
                            errors.push(format!("notes: {}", e));
                        }
                    }
                    match VfsTextbookRepo::list_textbooks_by_folder(
                        vfs_db,
                        folder_id,
                        per_type_limit,
                        0,
                    ) {
                        Ok(textbooks) => {
                            all_results
                                .extend(textbooks.into_iter().map(|t| textbook_to_dstu_node(&t)));
                        }
                        Err(e) => {
                            log::warn!(
                                "[BuiltinResourceExecutor] all: textbooks query failed: {}",
                                e
                            );
                            errors.push(format!("textbooks: {}", e));
                        }
                    }
                    match VfsExamRepo::list_exam_sheets_by_folder(
                        vfs_db,
                        folder_id,
                        per_type_limit,
                        0,
                    ) {
                        Ok(exams) => {
                            all_results.extend(exams.into_iter().map(|e| exam_to_dstu_node(&e)));
                        }
                        Err(e) => {
                            log::warn!("[BuiltinResourceExecutor] all: exams query failed: {}", e);
                            errors.push(format!("exams: {}", e));
                        }
                    }
                    match VfsEssayRepo::list_essays_by_folder(vfs_db, folder_id, per_type_limit, 0)
                    {
                        Ok(essays) => {
                            all_results.extend(essays.into_iter().map(|e| essay_to_dstu_node(&e)));
                        }
                        Err(e) => {
                            log::warn!("[BuiltinResourceExecutor] all: essays query failed: {}", e);
                            errors.push(format!("essays: {}", e));
                        }
                    }
                    match VfsTranslationRepo::list_translations_by_folder(
                        vfs_db,
                        folder_id,
                        per_type_limit,
                        0,
                    ) {
                        Ok(translations) => {
                            all_results.extend(
                                translations
                                    .into_iter()
                                    .map(|t| translation_to_dstu_node(&t)),
                            );
                        }
                        Err(e) => {
                            log::warn!(
                                "[BuiltinResourceExecutor] all: translations query failed: {}",
                                e
                            );
                            errors.push(format!("translations: {}", e));
                        }
                    }
                    match VfsFileRepo::list_files_by_folder(vfs_db, folder_id, per_type_limit, 0) {
                        Ok(files) => {
                            all_results.extend(
                                files
                                    .into_iter()
                                    .filter(|f| f.file_type != "image")
                                    .map(|f| file_to_dstu_node(&f)),
                            );
                        }
                        Err(e) => {
                            log::warn!("[BuiltinResourceExecutor] all: files query failed: {}", e);
                            errors.push(format!("files: {}", e));
                        }
                    }
                    match VfsFileRepo::list_files_by_folder(vfs_db, folder_id, per_type_limit, 0) {
                        Ok(images) => {
                            all_results.extend(
                                images
                                    .into_iter()
                                    .filter(|f| f.file_type == "image")
                                    .map(|f| file_to_dstu_node(&f)),
                            );
                        }
                        Err(e) => {
                            log::warn!("[BuiltinResourceExecutor] all: images query failed: {}", e);
                            errors.push(format!("images: {}", e));
                        }
                    }
                    match VfsMindMapRepo::list_mindmaps_by_folder(
                        vfs_db,
                        folder_id,
                        per_type_limit,
                        0,
                    ) {
                        Ok(mindmaps) => {
                            all_results
                                .extend(mindmaps.into_iter().map(|m| mindmap_to_dstu_node(&m)));
                        }
                        Err(e) => {
                            log::warn!(
                                "[BuiltinResourceExecutor] all: mindmaps query failed: {}",
                                e
                            );
                            errors.push(format!("mindmaps: {}", e));
                        }
                    }
                } else {
                    match VfsNoteRepo::list_notes(vfs_db, None, per_type_limit, 0) {
                        Ok(notes) => {
                            all_results.extend(notes.into_iter().map(|n| note_to_dstu_node(&n)));
                        }
                        Err(e) => {
                            log::warn!("[BuiltinResourceExecutor] all: notes query failed: {}", e);
                            errors.push(format!("notes: {}", e));
                        }
                    }
                    match VfsTextbookRepo::list_textbooks(vfs_db, per_type_limit, 0) {
                        Ok(textbooks) => {
                            all_results
                                .extend(textbooks.into_iter().map(|t| textbook_to_dstu_node(&t)));
                        }
                        Err(e) => {
                            log::warn!(
                                "[BuiltinResourceExecutor] all: textbooks query failed: {}",
                                e
                            );
                            errors.push(format!("textbooks: {}", e));
                        }
                    }
                    match VfsExamRepo::list_exam_sheets(vfs_db, None, per_type_limit, 0) {
                        Ok(exams) => {
                            all_results.extend(exams.into_iter().map(|e| exam_to_dstu_node(&e)));
                        }
                        Err(e) => {
                            log::warn!("[BuiltinResourceExecutor] all: exams query failed: {}", e);
                            errors.push(format!("exams: {}", e));
                        }
                    }
                    match VfsEssayRepo::list_sessions(vfs_db, per_type_limit, 0) {
                        Ok(sessions) => {
                            all_results
                                .extend(sessions.into_iter().map(|s| session_to_dstu_node(&s)));
                        }
                        Err(e) => {
                            log::warn!(
                                "[BuiltinResourceExecutor] all: essays/sessions query failed: {}",
                                e
                            );
                            errors.push(format!("essays: {}", e));
                        }
                    }
                    match VfsTranslationRepo::list_translations(vfs_db, None, per_type_limit, 0) {
                        Ok(translations) => {
                            all_results.extend(
                                translations
                                    .into_iter()
                                    .map(|t| translation_to_dstu_node(&t)),
                            );
                        }
                        Err(e) => {
                            log::warn!(
                                "[BuiltinResourceExecutor] all: translations query failed: {}",
                                e
                            );
                            errors.push(format!("translations: {}", e));
                        }
                    }
                    match VfsFileRepo::list_files_by_type(vfs_db, "document", per_type_limit, 0) {
                        Ok(files) => {
                            all_results.extend(files.into_iter().map(|f| file_to_dstu_node(&f)));
                        }
                        Err(e) => {
                            log::warn!("[BuiltinResourceExecutor] all: files query failed: {}", e);
                            errors.push(format!("files: {}", e));
                        }
                    }
                    match VfsFileRepo::list_files_by_type(vfs_db, "image", per_type_limit, 0) {
                        Ok(images) => {
                            all_results.extend(images.into_iter().map(|f| file_to_dstu_node(&f)));
                        }
                        Err(e) => {
                            log::warn!("[BuiltinResourceExecutor] all: images query failed: {}", e);
                            errors.push(format!("images: {}", e));
                        }
                    }
                    match VfsMindMapRepo::list_mindmaps(vfs_db) {
                        Ok(mindmaps) => {
                            all_results.extend(
                                mindmaps
                                    .into_iter()
                                    .take(per_type_limit as usize)
                                    .map(|m| mindmap_to_dstu_node(&m)),
                            );
                        }
                        Err(e) => {
                            log::warn!(
                                "[BuiltinResourceExecutor] all: mindmaps query failed: {}",
                                e
                            );
                            errors.push(format!("mindmaps: {}", e));
                        }
                    }
                }

                // 按更新时间排序
                all_results.sort_by_key(|b| std::cmp::Reverse(b.updated_at));
                all_results.truncate(limit as usize);
                (all_results, errors)
            }
            _ => {
                return Err(format!("不支持的资源类型: '{}', 有效类型: note, textbook, exam, essay, translation, image, file, mindmap, all", type_filter));
            }
        };

        // ★ 应用收藏筛选（后置过滤，因为部分 Repo 方法不支持收藏筛选）
        if favorites_only {
            results.retain(|node| {
                node.metadata
                    .as_ref()
                    .and_then(|m| m.get("isFavorite"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
            });
            log::debug!(
                "[BuiltinResourceExecutor] Filtered to {} favorites",
                results.len()
            );
        }

        Ok((results, partial_errors))
    }

    /// 执行资源读取
    async fn execute_read(&self, call: &ToolCall, ctx: &ExecutionContext) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;

        // 解析参数
        let (raw_resource_id, id_arg_source) = Self::pick_resource_read_id(&call.arguments)
            .ok_or("Missing resource identifier. 请传入 resource_id/readResourceId/sourceId/resourceId，并可先调用 resource_list 或 unified_search 获取可用 ID。")?;
        let resolved = Self::resolve_read_target(vfs_db, &raw_resource_id)?;
        let include_metadata = call
            .arguments
            .get("include_metadata")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        log::debug!(
            "[BuiltinResourceExecutor] resource_read: requested_id={}, resolved_id={}, type={}, include_metadata={}",
            resolved.requested_id,
            resolved.read_id,
            resolved.resource_type,
            include_metadata,
        );

        let start_time = Instant::now();

        // ★ L-020 修复：获取资源元数据，区分 "未找到" 与 "查询出错"，不再静默吞掉错误
        let (metadata, metadata_error) = if include_metadata {
            match self.get_resource_metadata(vfs_db, resolved.resource_type, &resolved.read_id) {
                Ok(meta) => (meta, None),
                Err(e) => {
                    log::warn!(
                        "[BuiltinResourceExecutor] get metadata failed for {}: {}",
                        resolved.read_id,
                        e
                    );
                    (None, Some(e))
                }
            }
        } else {
            (None, None)
        };

        // ★ 按页读取参数（可选，仅对 textbook/file 类型有效）
        let page_start = call
            .arguments
            .get("page_start")
            .and_then(|v| v.as_u64())
            .map(|v| v.max(1) as usize);
        let page_end = call
            .arguments
            .get("page_end")
            .and_then(|v| v.as_u64())
            .map(|v| v.max(1) as usize);

        // 获取资源内容（按页或全量）
        let (content, paged_total_pages) = if let Some(ps) = page_start {
            let pe = page_end.unwrap_or(ps); // 未指定 page_end 则只读单页
            let pe = pe.max(ps); // 确保 page_end >= page_start
            log::debug!(
                "[BuiltinResourceExecutor] resource_read paged: pages={}-{}, type={}",
                ps,
                pe,
                resolved.resource_type
            );
            get_content_by_type_paged(vfs_db, resolved.resource_type, &resolved.read_id, ps, pe)?
        } else {
            let content = get_content_by_type(vfs_db, resolved.resource_type, &resolved.read_id)?;
            // 即使没有指定页码，也尝试获取总页数（用于告知 LLM 可以按页读取）
            let total = get_file_total_pages(vfs_db, resolved.resource_type, &resolved.read_id)
                .unwrap_or(0);
            (content, total)
        };

        // ★ D15 修复：出口硬上限——无论按页还是全量读取，content 超过上限即截断，
        // 防止超大文档（无页结构的笔记/大文本文件等）一次性撑爆 LLM 上下文。
        let original_char_count = content.chars().count();
        let (content, content_truncated) = if original_char_count > MAX_READ_CONTENT_CHARS {
            log::info!(
                "[BuiltinResourceExecutor] resource_read content truncated: {} -> {} chars (resource={})",
                original_char_count,
                MAX_READ_CONTENT_CHARS,
                resolved.read_id
            );
            (safe_truncate_chars(&content, MAX_READ_CONTENT_CHARS), true)
        } else {
            (content, false)
        };

        let availability =
            Self::collect_read_availability(resolved.resource_type, &content, metadata.as_ref());
        let degradation = Self::build_degradation_info(
            resolved.resource_type,
            &content,
            &availability,
            metadata_error.as_ref(),
        );
        let preview_images = metadata
            .as_ref()
            .and_then(|m| m.get("previewImages"))
            .cloned()
            .unwrap_or_else(|| json!([]));

        let duration = start_time.elapsed().as_millis() as u64;

        log::debug!(
            "[BuiltinResourceExecutor] resource_read completed: requested_id={}, resolved_id={}, content_len={}, total_pages={}, {}ms",
            resolved.requested_id,
            resolved.read_id,
            content.len(),
            paged_total_pages,
            duration
        );

        let mut result = json!({
            "success": true,
            "resourceId": resolved.requested_id,
            "resolvedResourceId": resolved.read_id,
            "resolvedBy": resolved.resolved_by,
            "resolvedFromArg": id_arg_source,
            "type": resolved.resource_type,
            "content": content,
            "contentLength": content.len(),
            "contentTruncated": content_truncated,
            "availability": {
                "hasExtractedText": availability.has_extracted_text,
                "hasOcrPages": availability.has_ocr_pages,
                "hasPreviewImages": availability.has_preview_images,
                "hasImageOcr": availability.has_image_ocr,
                "hasStructuredContent": availability.has_structured_content,
            },
            "previewImages": preview_images,
            "degradation": {
                "level": degradation.level,
                "reasonCodes": degradation.reason_codes,
                "message": degradation.message,
            },
            "durationMs": duration,
        });

        // ★ D15 修复：明确告知 LLM 内容已被截断及应对方式
        if content_truncated {
            let paging_hint = if paged_total_pages > 0 {
                format!(
                    "请缩小 page_start/page_end 范围分批读取（共 {} 页）。",
                    paged_total_pages
                )
            } else {
                "该资源没有分页结构，已返回开头部分内容。".to_string()
            };
            result["truncationNotice"] = json!(format!(
                "内容过长已截断：原始 {} 字符，仅返回前 {} 字符。{}",
                original_char_count, MAX_READ_CONTENT_CHARS, paging_hint
            ));
        }

        // ★ 按页读取信息：让 LLM 知道总页数和当前读取的范围
        if paged_total_pages > 0 {
            result["totalPages"] = json!(paged_total_pages);
            if let Some(ps) = page_start {
                let pe = page_end.unwrap_or(ps).max(ps).min(paged_total_pages);
                result["pageStart"] = json!(ps);
                result["pageEnd"] = json!(pe);
                result["hint"] = json!(format!(
                    "当前返回第 {}-{} 页（共 {} 页）。可通过 page_start/page_end 参数读取其他页。",
                    ps, pe, paged_total_pages
                ));
            } else {
                result["hint"] = json!(format!(
                    "本文档共 {} 页。可通过 page_start/page_end 参数按页读取，避免一次加载全部内容。",
                    paged_total_pages
                ));
            }
        }

        if let Some(ref meta) = metadata {
            result["metadata"] = meta.clone();
        }
        // ★ L-020 修复：元数据获取失败时，在返回 JSON 中包含具体错误信息
        if let Some(ref err) = metadata_error {
            result["metadata_error"] = json!(format!(
                "Failed to retrieve metadata for '{}': {}. The content is still available.",
                resolved.read_id, err
            ));
        } else if metadata.is_none() && include_metadata {
            result["metadata_error"] =
                json!("Metadata not found for this resource. The content is still available.");
        }

        Ok(result)
    }

    /// 获取资源元数据
    ///
    /// ★ 2026-02-09 L-020 修复：区分 Err / Ok(None) 并记录日志，不再静默吞掉错误
    ///
    /// 返回值语义：
    /// - `Ok(Some(value))` — 成功获取到元数据
    /// - `Ok(None)` — 资源不存在（合法的"未找到"）
    /// - `Err(msg)` — 数据库查询出错（不应被静默吞掉）
    fn get_resource_metadata(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        resource_type: &str,
        resource_id: &str,
    ) -> Result<Option<Value>, String> {
        match resource_type {
            "notes" => match VfsNoteRepo::get_note(vfs_db, resource_id) {
                Ok(Some(note)) => Ok(Some(json!({
                    "title": note.title,
                    "tags": note.tags,
                    "createdAt": note.created_at,
                    "updatedAt": note.updated_at,
                }))),
                Ok(None) => {
                    log::debug!(
                        "[BuiltinResource] get metadata: note not found for {}",
                        resource_id
                    );
                    Ok(None)
                }
                Err(e) => {
                    let msg = format!("note query error: {}", e);
                    log::warn!(
                        "[BuiltinResource] get metadata failed for {}: {}",
                        resource_id,
                        msg
                    );
                    Err(msg)
                }
            },
            "textbooks" => match VfsTextbookRepo::get_textbook(vfs_db, resource_id) {
                Ok(Some(tb)) => Ok(Some(json!({
                    "title": tb.file_name,
                    "pageCount": tb.page_count,
                    "lastPage": tb.last_page,
                    "createdAt": tb.created_at,
                    "updatedAt": tb.updated_at,
                }))),
                Ok(None) => {
                    log::debug!(
                        "[BuiltinResource] get metadata: textbook not found for {}",
                        resource_id
                    );
                    Ok(None)
                }
                Err(e) => {
                    let msg = format!("textbook query error: {}", e);
                    log::warn!(
                        "[BuiltinResource] get metadata failed for {}: {}",
                        resource_id,
                        msg
                    );
                    Err(msg)
                }
            },
            "exams" => match VfsExamRepo::get_exam_sheet(vfs_db, resource_id) {
                Ok(Some(exam)) => {
                    let preview_images =
                        Self::extract_page_preview_images(vfs_db, &exam.preview_json);
                    Ok(Some(json!({
                        "title": exam.exam_name,
                        "status": exam.status,
                        "createdAt": exam.created_at,
                        "updatedAt": exam.updated_at,
                        "hasPreviewImages": !preview_images.is_empty(),
                        "previewImages": preview_images,
                    })))
                }
                Ok(None) => {
                    log::debug!(
                        "[BuiltinResource] get metadata: exam not found for {}",
                        resource_id
                    );
                    Ok(None)
                }
                Err(e) => {
                    let msg = format!("exam query error: {}", e);
                    log::warn!(
                        "[BuiltinResource] get metadata failed for {}: {}",
                        resource_id,
                        msg
                    );
                    Err(msg)
                }
            },
            "essays" => match VfsEssayRepo::get_session(vfs_db, resource_id) {
                Ok(Some(session)) => Ok(Some(json!({
                    "title": session.title,
                    "essayType": session.essay_type,
                    "totalRounds": session.total_rounds,
                    "createdAt": session.created_at,
                    "updatedAt": session.updated_at,
                }))),
                Ok(None) => {
                    log::debug!(
                        "[BuiltinResource] get metadata: essay session not found for {}",
                        resource_id
                    );
                    Ok(None)
                }
                Err(e) => {
                    let msg = format!("essay session query error: {}", e);
                    log::warn!(
                        "[BuiltinResource] get metadata failed for {}: {}",
                        resource_id,
                        msg
                    );
                    Err(msg)
                }
            },
            "translations" => match VfsTranslationRepo::get_translation(vfs_db, resource_id) {
                Ok(Some(tr)) => Ok(Some(json!({
                    "title": tr.title,
                    "srcLang": tr.src_lang,
                    "tgtLang": tr.tgt_lang,
                    "createdAt": tr.created_at,
                    "updatedAt": tr.updated_at,
                }))),
                Ok(None) => {
                    log::debug!(
                        "[BuiltinResource] get metadata: translation not found for {}",
                        resource_id
                    );
                    Ok(None)
                }
                Err(e) => {
                    let msg = format!("translation query error: {}", e);
                    log::warn!(
                        "[BuiltinResource] get metadata failed for {}: {}",
                        resource_id,
                        msg
                    );
                    Err(msg)
                }
            },
            "files" => {
                // ★ 修复：补全 files 类型的元数据获取
                // 教材 (tb_*) 通过 infer_type_from_id 映射为 "files"，需要特殊处理
                if resource_id.starts_with("tb_") {
                    match VfsTextbookRepo::get_textbook(vfs_db, resource_id) {
                        Ok(Some(tb)) => Ok(Some(json!({
                            "title": tb.file_name,
                            "pageCount": tb.page_count,
                            "lastPage": tb.last_page,
                            "createdAt": tb.created_at,
                            "updatedAt": tb.updated_at,
                        }))),
                        Ok(None) => {
                            log::debug!(
                                "[BuiltinResource] get metadata: textbook not found for {}",
                                resource_id
                            );
                            Ok(None)
                        }
                        Err(e) => {
                            let msg = format!("textbook query error: {}", e);
                            log::warn!(
                                "[BuiltinResource] get metadata failed for {}: {}",
                                resource_id,
                                msg
                            );
                            Err(msg)
                        }
                    }
                } else {
                    match VfsFileRepo::get_file(vfs_db, resource_id) {
                        Ok(Some(f)) => {
                            let preview_images = Self::extract_page_preview_images_from_str(
                                vfs_db,
                                f.preview_json.as_deref(),
                            );
                            Ok(Some(json!({
                                "fileName": f.file_name,
                                "fileType": f.file_type,
                                "mimeType": f.mime_type,
                                "size": f.size,
                                "pageCount": f.page_count,
                                "createdAt": f.created_at,
                                "updatedAt": f.updated_at,
                                "hasExtractedText": f.extracted_text.as_ref().map(|t| !t.trim().is_empty()).unwrap_or(false),
                                "hasOcrPages": f.ocr_pages_json.as_ref().map(|t| !t.trim().is_empty()).unwrap_or(false),
                                "hasPreviewImages": !preview_images.is_empty(),
                                "previewImages": preview_images,
                            })))
                        }
                        Ok(None) => {
                            log::debug!(
                                "[BuiltinResource] get metadata: file not found for {}",
                                resource_id
                            );
                            Ok(None)
                        }
                        Err(e) => {
                            let msg = format!("file query error: {}", e);
                            log::warn!(
                                "[BuiltinResource] get metadata failed for {}: {}",
                                resource_id,
                                msg
                            );
                            Err(msg)
                        }
                    }
                }
            }
            "mindmaps" => match VfsMindMapRepo::get_mindmap(vfs_db, resource_id) {
                Ok(Some(mm)) => Ok(Some(json!({
                    "title": mm.title,
                    "description": mm.description,
                    "defaultView": mm.default_view,
                    "theme": mm.theme,
                    "isFavorite": mm.is_favorite,
                    "createdAt": mm.created_at,
                    "updatedAt": mm.updated_at,
                }))),
                Ok(None) => {
                    log::debug!(
                        "[BuiltinResource] get metadata: mindmap not found for {}",
                        resource_id
                    );
                    Ok(None)
                }
                Err(e) => {
                    let msg = format!("mindmap query error: {}", e);
                    log::warn!(
                        "[BuiltinResource] get metadata failed for {}: {}",
                        resource_id,
                        msg
                    );
                    Err(msg)
                }
            },
            _ => {
                log::warn!(
                    "[BuiltinResource] get metadata: unsupported resource type '{}' for {}",
                    resource_type,
                    resource_id
                );
                Ok(None)
            }
        }
    }

    /// 执行资源搜索
    async fn execute_search(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;

        // 解析参数
        let query = call.arguments.get("query").and_then(|v| v.as_str()).ok_or(
            "Missing 'query' parameter. 请提供搜索关键词，例如 resource_search(query=\"关键词\")。",
        )?;
        let types: Option<Vec<String>> = call
            .arguments
            .get("types")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            });
        let folder_id = call
            .arguments
            .get("folder_id")
            .and_then(|v| v.as_str())
            .map(String::from);
        // ★ L-028: 后端 clamp，防止 LLM/前端传入过大或非法值
        let top_k = call
            .arguments
            .get("top_k")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_SEARCH_TOP_K as u64)
            .clamp(1, MAX_SEARCH_TOP_K) as u32;

        log::debug!(
            "[BuiltinResourceExecutor] resource_search: query={}, types={:?}, folder_id={:?}, top_k={}",
            query, types, folder_id, top_k
        );

        let start_time = Instant::now();

        // 构建搜索选项
        let options = DstuListOptions {
            folder_id,
            types: types.as_ref().and_then(|ts| {
                let parsed: Vec<DstuNodeType> = ts
                    .iter()
                    .filter_map(|t| Self::parse_resource_type(t))
                    .collect();
                if parsed.is_empty() {
                    None
                } else {
                    Some(parsed)
                }
            }),
            limit: Some(top_k),
            offset: None,
            sort_by: Some("updatedAt".to_string()),
            sort_order: Some("desc".to_string()),
            search: Some(query.to_string()),
            ..Default::default()
        };

        // 执行搜索
        let results = search_all(vfs_db, query, &options)?;

        let duration = start_time.elapsed().as_millis() as u64;

        // 转换为输出格式，包含匹配片段
        let items: Vec<Value> = results
            .iter()
            .map(|node| {
                // 尝试获取内容片段
                let snippet = self.get_search_snippet(vfs_db, &node.id, query);
                let node_type = format!("{:?}", node.node_type).to_lowercase();
                let chatanki_compatible = matches!(
                    node_type.as_str(),
                    "file" | "image" | "textbook"
                );

                json!({
                    "id": node.id,
                    "name": node.name,
                    "type": node_type,
                    "path": node.path,
                    "updatedAt": node.updated_at,
                    "snippet": snippet,
                    "chatankiCompatible": chatanki_compatible,
                    "chatankiTargetId": if chatanki_compatible { Some(node.id.clone()) } else { None },
                })
            })
            .collect();

        log::debug!(
            "[BuiltinResourceExecutor] resource_search completed: {} results in {}ms",
            items.len(),
            duration
        );

        Ok(json!({
            "success": true,
            "query": query,
            "items": items,
            "count": items.len(),
            "durationMs": duration,
        }))
    }

    /// 获取搜索结果的内容片段
    ///
    /// ★ 2026-02 修复：使用字符偏移而非字节偏移，修正中文内容 snippet 提取位置错误
    fn get_search_snippet(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        resource_id: &str,
        query: &str,
    ) -> Option<String> {
        let (resource_type, read_id) = if let Some(t) = Self::infer_type_from_id(resource_id) {
            (t, resource_id.to_string())
        } else if resource_id.starts_with("res_") {
            match Self::resolve_read_target(vfs_db, resource_id) {
                Ok(target) => (target.resource_type, target.read_id),
                Err(err) => {
                    log::debug!(
                        "[BuiltinResourceExecutor] resource_search snippet skipped: id={} reason={}",
                        resource_id,
                        err
                    );
                    return None;
                }
            }
        } else {
            log::debug!(
                "[BuiltinResourceExecutor] resource_search snippet skipped: unsupported id={}",
                resource_id
            );
            return None;
        };

        let content = match get_content_by_type(vfs_db, resource_type, &read_id) {
            Ok(v) => v,
            Err(err) => {
                log::debug!(
                    "[BuiltinResourceExecutor] resource_search snippet read failed: id={}, resolved_id={}, error={}",
                    resource_id,
                    read_id,
                    err
                );
                return None;
            }
        };

        // 在内容中查找匹配位置（使用字符偏移）
        let query_lower = query.to_lowercase();
        let content_lower = content.to_lowercase();

        if let Some(byte_pos) = content_lower.find(&query_lower) {
            // 将字节偏移转换为字符偏移
            let char_pos = content_lower[..byte_pos].chars().count();
            let query_char_len = query_lower.chars().count();
            let total_chars = content.chars().count();

            // 提取匹配位置周围的片段（前后各 100 字符）
            let start = char_pos.saturating_sub(100);
            let end = (char_pos + query_char_len + 100).min(total_chars);

            // 按字符边界截取
            let snippet: String = content.chars().skip(start).take(end - start).collect();

            let prefix = if start > 0 { "..." } else { "" };
            let suffix = if end < total_chars { "..." } else { "" };

            Some(format!("{}{}{}", prefix, snippet.trim(), suffix))
        } else {
            // 无匹配，返回开头片段
            let total_chars = content.chars().count();
            let snippet: String = content.chars().take(200).collect();
            if total_chars > 200 {
                Some(format!("{}...", snippet.trim()))
            } else {
                Some(snippet)
            }
        }
    }

    /// 执行文件夹列表
    ///
    /// 解决 P4 断裂点：LLM 无法浏览文件夹结构
    async fn execute_folder_list(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;

        // 解析参数
        let parent_id = call
            .arguments
            .get("parent_id")
            .and_then(|v| v.as_str())
            .map(|s| {
                if s == "root" || s.is_empty() {
                    None
                } else {
                    Some(s.to_string())
                }
            })
            .unwrap_or(None);
        let include_count = call
            .arguments
            .get("include_count")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let recursive = call
            .arguments
            .get("recursive")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        log::debug!(
            "[BuiltinResourceExecutor] folder_list: parent_id={:?}, include_count={}, recursive={}",
            parent_id,
            include_count,
            recursive
        );

        let start_time = Instant::now();

        // 使用 VfsFolderRepo 获取文件夹列表
        use crate::vfs::VfsFolderRepo;

        let folders = if recursive {
            // 递归获取所有子文件夹
            self.get_folders_recursive(vfs_db, parent_id.as_deref(), include_count)?
        } else {
            // 只获取直接子文件夹
            let folder_list = VfsFolderRepo::list_folders_by_parent(vfs_db, parent_id.as_deref())
                .map_err(|e| format!("Failed to list folders: {}", e))?;

            folder_list
                .into_iter()
                .map(|folder| {
                    let mut item = json!({
                        "id": folder.id,
                        "name": folder.title,
                        "parent_id": folder.parent_id,
                        "created_at": folder.created_at,
                        "updated_at": folder.updated_at,
                    });

                    if include_count {
                        // 获取文件夹内资源数量
                        let count = self.count_resources_in_folder(vfs_db, &folder.id);
                        item["resource_count"] = json!(count);
                    }

                    item
                })
                .collect::<Vec<Value>>()
        };

        let duration = start_time.elapsed().as_millis() as u64;

        log::debug!(
            "[BuiltinResourceExecutor] folder_list completed: {} folders in {}ms",
            folders.len(),
            duration
        );

        Ok(json!({
            "success": true,
            "parent_id": parent_id.unwrap_or_else(|| "root".to_string()),
            "folders": folders,
            "count": folders.len(),
            "recursive": recursive,
            "durationMs": duration,
        }))
    }

    /// 最大文件夹递归深度限制，防止循环引用导致栈溢出
    const MAX_FOLDER_DEPTH: usize = 50;

    /// 递归获取文件夹及其子文件夹
    ///
    /// ★ P0 修复：添加深度限制参数，防止数据库循环引用导致无限递归
    fn get_folders_recursive(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        parent_id: Option<&str>,
        include_count: bool,
    ) -> Result<Vec<Value>, String> {
        self.get_folders_recursive_with_depth(vfs_db, parent_id, include_count, 0)
    }

    /// 带深度限制的递归获取文件夹
    fn get_folders_recursive_with_depth(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        parent_id: Option<&str>,
        include_count: bool,
        depth: usize,
    ) -> Result<Vec<Value>, String> {
        // 深度限制检查
        if depth > Self::MAX_FOLDER_DEPTH {
            log::warn!(
                "[BuiltinResourceExecutor] Folder depth exceeds limit ({}), stopping recursion",
                Self::MAX_FOLDER_DEPTH
            );
            return Ok(Vec::new());
        }

        use crate::vfs::VfsFolderRepo;

        let folders = VfsFolderRepo::list_folders_by_parent(vfs_db, parent_id)
            .map_err(|e| format!("Failed to list folders: {}", e))?;

        let mut result = Vec::new();

        for folder in folders {
            let mut item = json!({
                "id": folder.id,
                "name": folder.title,
                "parent_id": folder.parent_id,
                "created_at": folder.created_at,
                "updated_at": folder.updated_at,
            });

            if include_count {
                let count = self.count_resources_in_folder(vfs_db, &folder.id);
                item["resource_count"] = json!(count);
            }

            // 递归获取子文件夹（带深度限制）
            let children = self.get_folders_recursive_with_depth(
                vfs_db,
                Some(&folder.id),
                include_count,
                depth + 1,
            )?;
            if !children.is_empty() {
                item["children"] = json!(children);
            }

            result.push(item);
        }

        Ok(result)
    }

    /// 统计文件夹内资源数量
    fn count_resources_in_folder(&self, vfs_db: &Arc<VfsDatabase>, folder_id: &str) -> u32 {
        use crate::vfs::VfsFolderRepo;

        // 使用 VfsFolderRepo::list_items_by_folder 获取文件夹内的所有项目
        match VfsFolderRepo::list_items_by_folder(vfs_db, Some(folder_id)) {
            Ok(items) => items.len() as u32,
            Err(e) => {
                log::warn!(
                    "[BuiltinResourceExecutor] Failed to count items in folder {}: {}",
                    folder_id,
                    e
                );
                0
            }
        }
    }

    // ========================================================================
    // 知识导图创建/编辑
    // ========================================================================

    /// 最大思维导图节点深度限制，防止栈溢出
    const MAX_MINDMAP_DEPTH: usize = 100;

    /// 修复 LLM 生成的思维导图节点数据
    ///
    /// LLM 可能使用 name/label/title 等字段名而不是 text，
    /// 此函数将这些字段映射到正确的 text 字段
    ///
    /// ★ P0 修复：添加深度限制参数，防止恶意或错误的深嵌套数据导致栈溢出
    fn fix_mindmap_node(node: &mut Value) {
        Self::fix_mindmap_node_with_depth(node, 0);
    }

    /// 带深度限制的节点修复
    fn fix_mindmap_node_with_depth(node: &mut Value, depth: usize) {
        // 深度限制检查
        if depth > Self::MAX_MINDMAP_DEPTH {
            log::warn!(
                "[BuiltinResourceExecutor] Mindmap node depth exceeds limit ({}), truncating",
                Self::MAX_MINDMAP_DEPTH
            );
            return;
        }

        if let Some(obj) = node.as_object_mut() {
            // 如果没有 text 字段，尝试从 name/label/title/value 获取
            if !obj.contains_key("text")
                || obj
                    .get("text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .is_empty()
            {
                let text_value = obj
                    .get("name")
                    .or_else(|| obj.get("label"))
                    .or_else(|| obj.get("title"))
                    .or_else(|| obj.get("value"))
                    .or_else(|| obj.get("content"))
                    .cloned()
                    .unwrap_or(Value::String("未命名".to_string()));
                obj.insert("text".to_string(), text_value);
            }

            // 确保有 children 数组
            if !obj.contains_key("children") {
                obj.insert("children".to_string(), json!([]));
            }

            // 递归处理子节点（带深度限制）
            if let Some(children) = obj.get_mut("children") {
                if let Some(arr) = children.as_array_mut() {
                    for child in arr.iter_mut() {
                        Self::fix_mindmap_node_with_depth(child, depth + 1);
                    }
                }
            }
        }
    }

    /// 修复整个思维导图文档
    fn fix_mindmap_content(content_str: &str) -> String {
        match serde_json::from_str::<Value>(content_str) {
            Ok(mut doc) => {
                // 修复 root 节点
                if let Some(root) = doc.get_mut("root") {
                    Self::fix_mindmap_node(root);
                }

                // 确保有 version 字段
                if doc.get("version").is_none() {
                    if let Some(obj) = doc.as_object_mut() {
                        obj.insert("version".to_string(), json!("1.0"));
                    }
                }

                // 确保有 meta 字段
                if doc.get("meta").is_none() {
                    if let Some(obj) = doc.as_object_mut() {
                        obj.insert("meta".to_string(), json!({"createdAt": ""}));
                    }
                }

                // ★ P3：校验/归一化文档级关联线（associations）
                Self::sanitize_mindmap_associations(&mut doc);

                doc.to_string()
            }
            Err(e) => {
                log::warn!(
                    "[BuiltinResourceExecutor] Failed to parse mindmap content for fixing: {}",
                    e
                );
                content_str.to_string()
            }
        }
    }

    /// 递归收集树中全部节点 ID（带深度限制，供关联线端点校验）
    fn collect_mindmap_node_ids(
        node: &Value,
        depth: usize,
        output: &mut std::collections::HashSet<String>,
    ) {
        if depth > Self::MAX_MINDMAP_DEPTH {
            return;
        }
        if let Some(id) = node.get("id").and_then(|v| v.as_str()) {
            if !id.trim().is_empty() {
                output.insert(id.to_string());
            }
        }
        if let Some(children) = node.get("children").and_then(|v| v.as_array()) {
            for child in children {
                Self::collect_mindmap_node_ids(child, depth + 1, output);
            }
        }
    }

    /// ★ P3：校验/归一化文档级关联线（associations）
    ///
    /// - 仅保留 source/target 均为树中存在节点且非自指的连线；
    /// - 缺失/重复 id 自动补全（assoc_ 前缀），保留 label/style；
    /// - 非数组或过滤后为空时移除该字段。
    fn sanitize_mindmap_associations(doc: &mut Value) {
        let node_ids: std::collections::HashSet<String> = match doc.get("root") {
            Some(root) => {
                let mut ids = std::collections::HashSet::new();
                Self::collect_mindmap_node_ids(root, 0, &mut ids);
                ids
            }
            None => return,
        };

        let Some(obj) = doc.as_object_mut() else {
            return;
        };
        // 先取出所有权再校验，避免借用冲突；末尾按结果决定是否写回
        let Some(assoc_value) = obj.remove("associations") else {
            return;
        };
        let items: Vec<Value> = match assoc_value {
            Value::Array(items) => items,
            _ => {
                log::warn!(
                    "[BuiltinResourceExecutor] mindmap associations is not an array; dropping field"
                );
                return;
            }
        };

        let mut cleaned: Vec<Value> = Vec::new();
        let mut used_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut generated: usize = 0;
        for item in &items {
            let source = item
                .get("source")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let target = item
                .get("target")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let (Some(source), Some(target)) = (source, target) else {
                continue;
            };
            if source == target || !node_ids.contains(source) || !node_ids.contains(target) {
                continue;
            }

            let mut id = item
                .get("id")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_default();
            while id.is_empty() || used_ids.contains(&id) {
                generated += 1;
                id = format!("assoc_g{}", generated);
            }
            used_ids.insert(id.clone());

            let mut assoc = json!({
                "id": id,
                "source": source,
                "target": target,
            });
            if let Some(label) = item
                .get("label")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                assoc["label"] = json!(label);
            }
            if let Some(style) = item.get("style").filter(|v| v.is_object()) {
                assoc["style"] = style.clone();
            }
            cleaned.push(assoc);
        }

        if !cleaned.is_empty() {
            obj.insert("associations".to_string(), Value::Array(cleaned));
        }
    }

    /// 执行知识导图创建
    ///
    /// ★ 2026-01-26 新增：让 LLM 具备创建知识导图的能力
    /// ★ 2026-01-31 修复：修正 LLM 使用错误字段名的问题
    async fn execute_mindmap_create(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;

        // 解析参数
        let title = call
            .arguments
            .get("title")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| "Missing required parameter 'title'. 请提供思维导图标题。".to_string())?
            .to_string();
        let description = call
            .arguments
            .get("description")
            .and_then(|v| v.as_str())
            .map(String::from);
        // 🔧 修复：LLM 可能把 content 作为 JSON 对象或字符串发送
        let raw_content = call
            .arguments
            .get("content")
            .map(|v| {
                if let Some(s) = v.as_str() {
                    // 情况1: LLM 发送的是 JSON 字符串
                    s.to_string()
                } else {
                    // 情况2: LLM 发送的是 JSON 对象，需要序列化为字符串
                    v.to_string()
                }
            })
            .unwrap_or_else(|| {
                r#"{"version":"1.0","root":{"id":"root","text":"根节点","children":[]},"meta":{"createdAt":""}}"#.to_string()
            });

        // 🔧 修复：将 LLM 可能使用的错误字段名（name/label/title）映射到 text
        let content = Self::fix_mindmap_content(&raw_content);

        let folder_id = call
            .arguments
            .get("folder_id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty() && *s != "root"); // "root" 归一化为 None（根目录 folder_id 实际是 NULL）
        let default_view = call
            .arguments
            .get("default_view")
            .and_then(|v| v.as_str())
            .unwrap_or("mindmap")
            .to_string();
        let theme = call
            .arguments
            .get("theme")
            .and_then(|v| v.as_str())
            .map(String::from);

        log::info!(
            "[BuiltinResourceExecutor] mindmap_create: title={}, folder_id={:?}, raw_len={}, fixed_len={}",
            title, folder_id, raw_content.len(), content.len()
        );
        let raw_preview = if raw_content.chars().count() > 500 {
            format!("{}...", safe_truncate_chars(&raw_content, 500))
        } else {
            raw_content.clone()
        };
        let fixed_preview = if content.chars().count() > 500 {
            format!("{}...", safe_truncate_chars(&content, 500))
        } else {
            content.clone()
        };
        log::debug!(
            "[BuiltinResourceExecutor] mindmap_create raw content: {}",
            raw_preview
        );
        log::debug!(
            "[BuiltinResourceExecutor] mindmap_create fixed content: {}",
            fixed_preview
        );

        let start_time = Instant::now();

        // 创建参数
        let params = VfsCreateMindMapParams {
            title: title.clone(),
            description,
            content,
            default_view,
            theme,
        };

        // 创建知识导图
        let mindmap = VfsMindMapRepo::create_mindmap_in_folder(vfs_db, params, folder_id)
            .map_err(|e| format!("Failed to create mindmap: {}", e))?;

        let duration = start_time.elapsed().as_millis() as u64;

        log::info!(
            "[BuiltinResourceExecutor] mindmap_create completed: id={} in {}ms",
            mindmap.id,
            duration
        );

        // ★ 2026-02 修复：发射 DSTU watch 事件，通知 Learning Hub 自动刷新列表
        // 使用 mindmap_to_dstu_node 确保 path 格式和 timestamps 与 DSTU handler 完全一致
        {
            let node = mindmap_to_dstu_node(&mindmap);
            emit_watch_event(
                ctx.window_ref(),
                DstuWatchEvent::created(&node.path, node.clone()),
            );
        }

        // ★ 2026-02-13：为初始内容创建版本快照，返回 versionId 供 LLM 在引用中使用
        // 这样 [思维导图:mv_xxx:标题] 是不可变引用，不会因后续编辑而变化
        let version_id = match VfsMindMapRepo::get_mindmap_content(vfs_db, &mindmap.id) {
            Ok(Some(initial_content)) => {
                match VfsMindMapRepo::create_version(
                    vfs_db,
                    &mindmap.id,
                    &initial_content,
                    &mindmap.title,
                    None,
                    Some("chat_create"),
                ) {
                    Ok(version) => Some(version.version_id),
                    Err(e) => {
                        log::warn!(
                            "[BuiltinResourceExecutor] Failed to create initial version for mindmap {}: {}",
                            mindmap.id, e
                        );
                        None
                    }
                }
            }
            _ => None,
        };

        let mut result = json!({
            "success": true,
            "mindmap": {
                "id": mindmap.id,
                "title": mindmap.title,
                "description": mindmap.description,
                "defaultView": mindmap.default_view,
                "theme": mindmap.theme,
                "createdAt": mindmap.created_at,
                "updatedAt": mindmap.updated_at,
            },
            "durationMs": duration,
        });

        if let Some(ref vid) = version_id {
            result["versionId"] = json!(vid);
            // ★ 2026-02-13：提供完整的引用文本，LLM 直接复制使用
            // 使用 mv_xxx 版本 ID 确保引用指向不可变快照
            result["citation"] = json!(format!("[思维导图:{}:{}]", vid, title));
            result["hint"] =
                json!("请在回复中使用上方 citation 字段的引用文本，让用户可以点击查看导图。");
        }

        Ok(result)
    }

    fn parse_mindmap_document(content: &str) -> Result<Value, String> {
        let doc: Value = serde_json::from_str(content)
            .map_err(|e| format!("Invalid mindmap JSON content: {}", e))?;
        if doc.get("root").is_none() {
            return Err("Mindmap document missing required `root` field".to_string());
        }
        Ok(doc)
    }

    fn collect_mindmap_nodes(
        node: &Value,
        parent_id: Option<&str>,
        path: &str,
        output: &mut HashMap<String, MindMapNodeSnapshot>,
    ) {
        let node_text = node
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("未命名节点")
            .to_string();
        let raw_id = node
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("path:{}", path));

        let mut node_id = raw_id.clone();
        if output.contains_key(&node_id) {
            let mut idx = 2;
            while output.contains_key(&format!("{}#{}", raw_id, idx)) {
                idx += 1;
            }
            node_id = format!("{}#{}", raw_id, idx);
        }

        let signature = json!({
            "text": node.get("text"),
            "note": node.get("note"),
            "collapsed": node.get("collapsed"),
            "completed": node.get("completed"),
            "style": node.get("style"),
            "blankedRanges": node.get("blankedRanges"),
            "refs": node.get("refs"),
        })
        .to_string();

        output.insert(
            node_id.clone(),
            MindMapNodeSnapshot {
                id: node_id.clone(),
                text: node_text.clone(),
                parent_id: parent_id.map(|s| s.to_string()),
                path: path.to_string(),
                signature,
            },
        );

        if let Some(children) = node.get("children").and_then(|v| v.as_array()) {
            for child in children {
                let child_text = child
                    .get("text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未命名节点");
                let child_path = format!("{}/{}", path, child_text);
                Self::collect_mindmap_nodes(child, Some(node_id.as_str()), &child_path, output);
            }
        }
    }

    /// 执行知识导图更新
    ///
    /// ★ 2026-01-26 新增：让 LLM 具备编辑知识导图的能力
    /// ★ 2026-01-31 修复：修正 LLM 使用错误字段名的问题
    async fn execute_mindmap_update(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;

        // 解析参数
        let mindmap_id = call
            .arguments
            .get("mindmap_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'mindmap_id' parameter. 请先调用 resource_list(type=\"mindmap\") 获取可用的知识导图 ID。")?;
        let title = call
            .arguments
            .get("title")
            .and_then(|v| v.as_str())
            .map(String::from);
        let description = call
            .arguments
            .get("description")
            .and_then(|v| v.as_str())
            .map(String::from);
        // 🔧 修复：LLM 可能把 content 作为 JSON 对象或字符串发送
        let content = call.arguments.get("content").map(|v| {
            let raw = if let Some(s) = v.as_str() {
                s.to_string()
            } else {
                v.to_string()
            };
            // 应用字段名修复
            Self::fix_mindmap_content(&raw)
        });
        let default_view = call
            .arguments
            .get("default_view")
            .and_then(|v| v.as_str())
            .map(String::from);
        let theme = call
            .arguments
            .get("theme")
            .and_then(|v| v.as_str())
            .map(String::from);
        let settings = call.arguments.get("settings").cloned();

        log::info!(
            "[BuiltinResourceExecutor] mindmap_update: id={}, title={:?}",
            mindmap_id,
            title
        );

        let start_time = Instant::now();

        // ★ 2026-02 修复：获取当前 updated_at 用于乐观并发控制，防止覆盖前端用户正在编辑的内容
        // ★ 2026-02 二次修复：传播 DB 错误而非静默吞掉（.ok() 会导致 OCC 保护被跳过）
        let expected_updated_at = match VfsMindMapRepo::get_mindmap(vfs_db, mindmap_id) {
            Ok(Some(m)) => Some(m.updated_at),
            Ok(None) => {
                return Err(format!(
                    "Mindmap not found: {}. 请先调用 resource_list(type=\"mindmap\") 确认导图存在。",
                    mindmap_id
                ));
            }
            Err(e) => {
                log::error!(
                    "[BuiltinResourceExecutor] OCC pre-check failed for mindmap {}: {}",
                    mindmap_id,
                    e
                );
                return Err(format!("无法验证导图状态，请重试: {}", e));
            }
        };

        // 更新参数
        let params = VfsUpdateMindMapParams {
            title,
            description,
            content,
            default_view,
            theme,
            settings,
            expected_updated_at,
            version_source: Some("chat_update".to_string()),
        };

        // ★ 2026-07（B4 双快照消除）：snapshot_after=true——repo 在同一事务内
        // 为更新后的最终内容创建 chat_update 版本并随返回值带回，citation 的
        // mv_* 直接复用该版本；不再在更新成功后额外 create_version（旧实现会
        // 产生「更新前旧内容 + 更新后新内容」两条 chat 永久快照）。
        // 版本写入失败 fail-closed：更新整体回滚并报错（B3）。
        let (mindmap, after_version) =
            VfsMindMapRepo::update_mindmap_returning_version(vfs_db, mindmap_id, params, true)
                .map_err(|e| format!("Failed to update mindmap: {}", e))?;

        let duration = start_time.elapsed().as_millis() as u64;

        log::info!(
            "[BuiltinResourceExecutor] mindmap_update completed: id={} in {}ms",
            mindmap.id,
            duration
        );

        // ★ 2026-02 修复：发射 DSTU watch 事件，通知 Learning Hub 自动刷新列表
        // 使用 mindmap_to_dstu_node 确保 path 格式和 timestamps 与 DSTU handler 完全一致
        {
            let node = mindmap_to_dstu_node(&mindmap);
            emit_watch_event(
                ctx.window_ref(),
                DstuWatchEvent::updated(&node.path, node.clone()),
            );
        }

        let mut result = json!({
            "success": true,
            "mindmap": {
                "id": mindmap.id,
                "title": mindmap.title,
                "description": mindmap.description,
                "defaultView": mindmap.default_view,
                "theme": mindmap.theme,
                "createdAt": mindmap.created_at,
                "updatedAt": mindmap.updated_at,
            },
            "durationMs": duration,
        });

        // ★ 2026-02-13 / 2026-07 改造：versionId 复用更新事务内产生的版本快照，
        // [思维导图:mv_xxx:标题] 是不可变引用，指向本次更新后的具体内容
        if let Some(version) = after_version {
            result["versionId"] = json!(version.version_id);
            result["citation"] = json!(format!(
                "[思维导图:{}:{}]",
                version.version_id, mindmap.title
            ));
            result["hint"] = json!(
                "请在回复中使用上方 citation 字段的引用文本，让用户可以点击查看更新后的导图。"
            );
        }

        Ok(result)
    }

    /// 执行知识导图删除
    ///
    /// ★ 2026-01-31 新增：让 LLM 具备删除知识导图的能力
    /// ★ 2026-01-31 修复：删除后清理 LanceDB 索引和索引状态
    async fn execute_mindmap_delete(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;

        // 解析参数（优先 mindmap_id，兼容旧参数名 resource_id）
        let mindmap_id = call
            .arguments
            .get("mindmap_id")
            .or_else(|| call.arguments.get("resource_id"))
            .and_then(|v| v.as_str())
            .ok_or("Missing 'mindmap_id' parameter. 请先调用 resource_list(type=\"mindmap\") 获取可用的知识导图 ID。")?;

        log::info!(
            "[BuiltinResourceExecutor] mindmap_delete: mindmap_id={}",
            mindmap_id
        );

        let start_time = Instant::now();

        // 获取 mindmap 以取得 resource_id（用于索引清理）
        let mindmap = VfsMindMapRepo::get_mindmap(vfs_db, mindmap_id)
            .map_err(|e| format!("Failed to get mindmap: {}", e))?
            .ok_or_else(|| format!("Mindmap not found: {}", mindmap_id))?;
        let resource_id = &mindmap.resource_id;

        // 软删除知识导图
        VfsMindMapRepo::delete_mindmap(vfs_db, mindmap_id)
            .map_err(|e| format!("Failed to delete mindmap: {}", e))?;

        // 仅当资源不再被其他导图引用时，才清理索引
        // ★ M-082 修复：收集索引清理错误，在返回 JSON 中添加 warning
        let mut index_warnings: Vec<String> = Vec::new();
        let remaining = VfsMindMapRepo::count_active_mindmaps_by_resource_id(vfs_db, resource_id)
            .map_err(|e| format!("Failed to count mindmap references: {}", e))?;
        if remaining == 0 {
            if let Some(ref lance_store) = ctx.vfs_lance_store {
                if let Err(e) = lance_store.delete_by_resource("text", resource_id).await {
                    log::warn!(
                        "[BuiltinResourceExecutor] Failed to delete lance index for mindmap {}: {}",
                        resource_id,
                        e
                    );
                    index_warnings.push(format!("搜索索引清理失败: {}", e));
                }
            }

            // 标记索引状态为禁用
            if let Err(e) =
                VfsIndexStateRepo::mark_disabled_with_reason(vfs_db, resource_id, "mindmap deleted")
            {
                log::warn!(
                    "[BuiltinResourceExecutor] Failed to mark index disabled for mindmap {}: {}",
                    resource_id,
                    e
                );
                index_warnings.push(format!("索引状态标记失败: {}", e));
            }
        }

        let duration = start_time.elapsed().as_millis() as u64;

        log::info!(
            "[BuiltinResourceExecutor] mindmap_delete completed: id={} in {}ms",
            mindmap_id,
            duration
        );

        // ★ 2026-02 修复：发射 DSTU watch 事件，通知 Learning Hub 自动刷新列表
        {
            let path = format!("/mindmaps/{}", mindmap_id);
            emit_watch_event(ctx.window_ref(), DstuWatchEvent::deleted(&path));
        }

        let mut result = json!({
            "success": true,
            "deletedId": mindmap_id,
            "durationMs": duration,
        });

        // ★ M-082: 如果索引清理失败，在返回中标注 warning，让用户/LLM 知晓
        if !index_warnings.is_empty() {
            result["warning"] = json!(format!(
                "导图已删除，但部分清理未完成: {}",
                index_warnings.join("; ")
            ));
        }

        Ok(result)
    }

    // ========================================================================
    // 知识导图文件导入 — execute_mindmap_import + 解析辅助方法
    // ========================================================================

    /// 导入文件大小上限（32MB，与前端 MAX_XMIND_CONTENT_BYTES 对齐）
    const MAX_MINDMAP_IMPORT_BYTES: u64 = 32 * 1024 * 1024;
    /// 导入节点数上限（与前端 MAX_IMPORT_NODES 对齐）
    const MAX_MINDMAP_IMPORT_NODES: usize = 10_000;

    /// 深度/节点数守卫（每转换一个节点调用一次）
    fn mindmap_import_claim_node(
        stats: &mut MindMapImportStats,
        depth: usize,
    ) -> Result<(), String> {
        if depth > Self::MAX_MINDMAP_DEPTH {
            return Err(format!(
                "导入内容层级过深，超过最大限制（{} 层）",
                Self::MAX_MINDMAP_DEPTH
            ));
        }
        stats.node_count += 1;
        if stats.node_count > Self::MAX_MINDMAP_IMPORT_NODES {
            return Err(format!(
                "导入节点数超过最大限制（{}）",
                Self::MAX_MINDMAP_IMPORT_NODES
            ));
        }
        Ok(())
    }

    /// 顺序分配节点 ID（root 固定为 "root"，其余 n1, n2, ...）
    fn mindmap_import_alloc_id(counter: &mut usize, force_root: bool) -> String {
        if force_root {
            return "root".to_string();
        }
        *counter += 1;
        format!("n{}", *counter)
    }

    /// 去除 HTML 标签（XMind html 备注降级为纯文本用；轻量状态机，不引入新依赖）
    fn strip_html_tags(input: &str) -> String {
        let mut out = String::with_capacity(input.len());
        let mut in_tag = false;
        for ch in input.chars() {
            match ch {
                '<' => in_tag = true,
                '>' => in_tag = false,
                c if !in_tag => out.push(c),
                _ => {}
            }
        }
        out.trim().to_string()
    }

    /// 将附件 ID（file_/att_/res_）解析为 VfsFile；返回 (file, 会话归属校验候选 ID 列表)
    fn resolve_mindmap_import_file(
        vfs_db: &Arc<VfsDatabase>,
        raw_id: &str,
    ) -> Result<(crate::vfs::types::VfsFile, Vec<String>), String> {
        let trimmed = raw_id.trim();
        let source_id: String = if trimmed.starts_with("file_") || trimmed.starts_with("att_") {
            trimmed.to_string()
        } else if trimmed.starts_with("res_") {
            let resource = VfsResourceRepo::get_resource(vfs_db, trimmed)
                .map_err(|e| format!("Failed to resolve resource '{}': {}", trimmed, e))?
                .ok_or_else(|| format!("Resource not found: {}", trimmed))?;
            match resource.source_id.as_deref() {
                Some(sid) if sid.starts_with("file_") || sid.starts_with("att_") => {
                    sid.to_string()
                }
                _ => Self::resolve_source_id_by_resource_id(vfs_db, "files", trimmed)
                    .ok_or_else(|| {
                        format!(
                            "Resource '{}' does not resolve to a file_/att_ attachment",
                            trimmed
                        )
                    })?,
            }
        } else {
            return Err(format!(
                "Unsupported resource id '{}': mindmap_import 仅支持 file_/att_ 附件或映射到文件的 res_ 资源",
                trimmed
            ));
        };

        let file = VfsFileRepo::get_file(vfs_db, &source_id)
            .map_err(|e| format!("Failed to query import file '{}': {}", source_id, e))?
            .ok_or_else(|| format!("Import file not found: {}", trimmed))?;

        let mut candidate_ids: Vec<String> = vec![trimmed.to_string()];
        if !candidate_ids.iter().any(|id| id == &file.id) {
            candidate_ids.push(file.id.clone());
        }
        if let Some(resource_id) = file.resource_id.as_deref() {
            if !resource_id.is_empty() && !candidate_ids.iter().any(|id| id == resource_id) {
                candidate_ids.push(resource_id.to_string());
            }
        }
        Ok((file, candidate_ids))
    }

    /// 会话归属校验：附件必须出现在当前会话的上下文快照中（对齐 chatanki_import_apkg 范式）
    fn verify_mindmap_import_resource_in_session(
        chat_db: &crate::chat_v2::database::ChatV2Database,
        session_id: &str,
        candidate_ids: &[String],
    ) -> Result<bool, String> {
        let conn = chat_db
            .get_conn_safe()
            .map_err(|e| format!("Failed to open chat database: {}", e))?;
        let messages = crate::chat_v2::repo::ChatV2Repo::get_session_messages_with_conn(
            &conn, session_id,
        )
        .map_err(|e| format!("Failed to load session messages: {}", e))?;

        for msg in messages.iter().rev() {
            let Some(meta) = &msg.meta else { continue };
            let Some(snapshot) = &meta.context_snapshot else {
                continue;
            };
            for context_ref in &snapshot.user_refs {
                if candidate_ids.iter().any(|id| id == &context_ref.resource_id) {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    /// 带大小上限地读取文件字节
    fn read_mindmap_import_path_bounded(path: &std::path::Path) -> Result<Vec<u8>, String> {
        let metadata = std::fs::metadata(path)
            .map_err(|e| format!("Failed to read import file metadata: {}", e))?;
        if metadata.len() > Self::MAX_MINDMAP_IMPORT_BYTES {
            return Err(format!(
                "导入文件超过大小上限（{} MB）",
                Self::MAX_MINDMAP_IMPORT_BYTES / (1024 * 1024)
            ));
        }
        std::fs::read(path).map_err(|e| format!("Failed to read import file: {}", e))
    }

    /// 读取附件字节：VFS blob（blob_hash → sha256）优先，回退原始导入路径
    fn load_mindmap_import_bytes(
        vfs_db: &Arc<VfsDatabase>,
        file: &crate::vfs::types::VfsFile,
    ) -> Result<Vec<u8>, String> {
        if let Some(blob_hash) = file.blob_hash.as_deref() {
            if let Some(blob_path) = VfsBlobRepo::get_blob_path(vfs_db, blob_hash)
                .map_err(|e| format!("Failed to resolve import blob '{}': {}", file.id, e))?
            {
                return Self::read_mindmap_import_path_bounded(&blob_path);
            }
        }

        if !file.sha256.trim().is_empty() {
            if let Some(blob_path) = VfsBlobRepo::get_blob_path(vfs_db, &file.sha256)
                .map_err(|e| format!("Failed to resolve import blob '{}': {}", file.id, e))?
            {
                return Self::read_mindmap_import_path_bounded(&blob_path);
            }
        }

        if let Some(original_path) = file.original_path.as_deref() {
            if !crate::unified_file_manager::is_virtual_uri(original_path) {
                let path = std::path::Path::new(original_path);
                let has_parent_traversal = path
                    .components()
                    .any(|component| matches!(component, std::path::Component::ParentDir));
                if !has_parent_traversal && path.is_file() {
                    return Self::read_mindmap_import_path_bounded(path);
                }
            }
        }

        Err(format!(
            "Import file '{}' has no readable VFS blob or original path",
            file.id
        ))
    }

    /// 按扩展名 + 内容嗅探识别导入格式
    fn detect_mindmap_import_format(file_name: &str, bytes: &[u8]) -> &'static str {
        let extension = file_name
            .rsplit_once('.')
            .map(|(_, ext)| ext.to_ascii_lowercase())
            .unwrap_or_default();
        match extension.as_str() {
            "xmind" => return "xmind",
            "mmap" => return "mmap",
            "opml" => return "opml",
            "mm" => return "freemind",
            "md" | "markdown" => return "markdown",
            "txt" => return "text",
            "json" => return "json",
            _ => {}
        }

        // zip 魔数 PK\x03\x04：可能是 xmind 或 mmap，交给调用方按顺序尝试
        if bytes.len() >= 4 && bytes[0..4] == [0x50, 0x4b, 0x03, 0x04] {
            return "zip";
        }
        let head_len = bytes.len().min(2048);
        let head = String::from_utf8_lossy(&bytes[..head_len]);
        let trimmed = head.trim_start();
        if trimmed.starts_with('{') {
            return "json";
        }
        if trimmed.starts_with('<') {
            let lower = trimmed.to_ascii_lowercase();
            if lower.contains("<opml") {
                return "opml";
            }
            if lower.contains("<map") {
                return "freemind";
            }
            return "opml";
        }
        "markdown"
    }

    /// zip 包内按名读取文本条目（带解压大小上限）；条目不存在返回 Ok(None)
    fn read_mindmap_zip_entry(
        archive: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>,
        entry_name: &str,
    ) -> Result<Option<String>, String> {
        use std::io::Read;
        let mut entry = match archive.by_name(entry_name) {
            Ok(entry) => entry,
            Err(zip::result::ZipError::FileNotFound) => return Ok(None),
            Err(e) => return Err(format!("Failed to read zip entry '{}': {}", entry_name, e)),
        };
        if entry.size() > Self::MAX_MINDMAP_IMPORT_BYTES {
            return Err(format!(
                "zip 条目 '{}' 超过解压大小上限（{} MB）",
                entry_name,
                Self::MAX_MINDMAP_IMPORT_BYTES / (1024 * 1024)
            ));
        }
        let mut buffer: Vec<u8> = Vec::new();
        (&mut entry)
            .take(Self::MAX_MINDMAP_IMPORT_BYTES + 1)
            .read_to_end(&mut buffer)
            .map_err(|e| format!("Failed to decompress zip entry '{}': {}", entry_name, e))?;
        if buffer.len() as u64 > Self::MAX_MINDMAP_IMPORT_BYTES {
            return Err(format!(
                "zip 条目 '{}' 超过解压大小上限（{} MB）",
                entry_name,
                Self::MAX_MINDMAP_IMPORT_BYTES / (1024 * 1024)
            ));
        }
        Ok(Some(String::from_utf8_lossy(&buffer).into_owned()))
    }

    /// 把原始关联线端点（源文件内部 topic id）重映射为导入后的节点 id；
    /// 端点缺失/自指的连线丢弃。
    fn remap_import_associations(
        raw_links: &[(String, String, Option<String>)],
        id_map: &HashMap<String, String>,
        assoc_counter: &mut usize,
    ) -> Vec<Value> {
        let mut associations: Vec<Value> = Vec::new();
        for (end1, end2, label) in raw_links {
            let source = id_map.get(end1);
            let target = id_map.get(end2);
            let (Some(source), Some(target)) = (source, target) else {
                continue;
            };
            if source == target {
                continue;
            }
            *assoc_counter += 1;
            let mut assoc = json!({
                "id": format!("assoc_{}", assoc_counter),
                "source": source,
                "target": target,
            });
            if let Some(label) = label {
                let label = label.trim();
                if !label.is_empty() {
                    assoc["label"] = json!(label);
                }
            }
            associations.push(assoc);
        }
        associations
    }

    // ------------------------------------------------------------------
    // Markdown / 纯文本缩进大纲解析
    // ------------------------------------------------------------------

    /// 解析 Markdown 列表 / 纯缩进大纲为节点森林后合成根节点。
    /// 支持：`#` 标题层级、`- * +` 无序列表、`1. / 1)` 有序列表、
    /// GFM 任务项 `[ ]`/`[x]`、无项目符号的纯缩进大纲（2 空格或 Tab 一级）。
    fn parse_outline_text_to_mindmap(
        text: &str,
        fallback_title: &str,
        stats: &mut MindMapImportStats,
    ) -> Result<Value, String> {
        fn attach_outline_node(
            stack: &mut Vec<(usize, Value)>,
            top_level: &mut Vec<Value>,
            node: Value,
        ) {
            if let Some((_, parent)) = stack.last_mut() {
                if let Some(children) =
                    parent.get_mut("children").and_then(|c| c.as_array_mut())
                {
                    children.push(node);
                }
            } else {
                top_level.push(node);
            }
        }

        let mut counter: usize = 0;
        let mut items: Vec<(usize, Value)> = Vec::new();
        // 最近一个标题的深度（`#`=0）；标题之后的列表项挂在标题下
        let mut heading_base: Option<usize> = None;

        for raw_line in text.lines() {
            if raw_line.trim().is_empty() {
                continue;
            }

            // 计算缩进宽度：Tab 记 2 空格
            let mut indent_width: usize = 0;
            for ch in raw_line.chars() {
                match ch {
                    ' ' => indent_width += 1,
                    '\t' => indent_width += 2,
                    _ => break,
                }
            }
            let content = raw_line.trim_start();

            // 标题行：# ~ ######
            let hash_count = content.chars().take_while(|c| *c == '#').count();
            if (1..=6).contains(&hash_count)
                && content.chars().nth(hash_count).is_some_and(|c| c == ' ')
            {
                let depth = hash_count - 1;
                let text_value = content[hash_count..].trim();
                Self::mindmap_import_claim_node(stats, depth)?;
                items.push((depth, json!({
                    "id": Self::mindmap_import_alloc_id(&mut counter, false),
                    "text": if text_value.is_empty() { "未命名主题" } else { text_value },
                    "children": [],
                })));
                heading_base = Some(depth);
                continue;
            }

            // 列表项前缀：- * + • ‣ ◦ 或 1. / 1)
            let mut rest = content;
            let mut is_list_item = false;
            for bullet in ["- ", "* ", "+ ", "• ", "‣ ", "◦ "] {
                if let Some(stripped) = rest.strip_prefix(bullet) {
                    rest = stripped;
                    is_list_item = true;
                    break;
                }
            }
            if !is_list_item {
                let digit_len = rest.chars().take_while(|c| c.is_ascii_digit()).count();
                if digit_len > 0 {
                    let after_digits = &rest[digit_len..];
                    if let Some(stripped) = after_digits
                        .strip_prefix(". ")
                        .or_else(|| after_digits.strip_prefix(") "))
                    {
                        rest = stripped;
                        is_list_item = true;
                    }
                }
            }

            // GFM 任务项
            let mut completed: Option<bool> = None;
            if is_list_item {
                if let Some(stripped) = rest.strip_prefix("[ ] ") {
                    completed = Some(false);
                    rest = stripped;
                } else if let Some(stripped) = rest
                    .strip_prefix("[x] ")
                    .or_else(|| rest.strip_prefix("[X] "))
                {
                    completed = Some(true);
                    rest = stripped;
                }
            }

            let text_value = rest.trim();
            if text_value.is_empty() {
                continue;
            }

            // 深度 = 标题基准 + 缩进层级（2 空格一级）
            let indent_level = indent_width / 2;
            let depth = match heading_base {
                Some(base) => base + 1 + indent_level,
                None => indent_level,
            };
            Self::mindmap_import_claim_node(stats, depth)?;
            let mut node = json!({
                "id": Self::mindmap_import_alloc_id(&mut counter, false),
                "text": text_value,
                "children": [],
            });
            if let Some(completed) = completed {
                node["completed"] = json!(completed);
            }
            items.push((depth, node));
        }

        if items.is_empty() {
            return Err("导入内容为空：没有解析到任何大纲条目".to_string());
        }

        // 栈式装配：depth 小于等于栈顶时出栈挂接
        let mut top_level: Vec<Value> = Vec::new();
        let mut stack: Vec<(usize, Value)> = Vec::new();
        for (depth, node) in items {
            while stack.last().map(|(d, _)| *d >= depth).unwrap_or(false) {
                let (_, done) = match stack.pop() {
                    Some(entry) => entry,
                    None => break,
                };
                attach_outline_node(&mut stack, &mut top_level, done);
            }
            stack.push((depth, node));
        }
        while let Some((_, done)) = stack.pop() {
            attach_outline_node(&mut stack, &mut top_level, done);
        }

        if top_level.len() == 1 {
            let mut root = top_level.remove(0);
            root["id"] = json!("root");
            Ok(root)
        } else {
            Self::mindmap_import_claim_node(stats, 0)?;
            Ok(json!({
                "id": "root",
                "text": fallback_title,
                "children": top_level,
            }))
        }
    }

    // ------------------------------------------------------------------
    // OPML 解析
    // ------------------------------------------------------------------

    fn opml_outline_to_value(
        node: roxmltree::Node<'_, '_>,
        depth: usize,
        stats: &mut MindMapImportStats,
        counter: &mut usize,
    ) -> Result<Value, String> {
        Self::mindmap_import_claim_node(stats, depth)?;
        let text = node
            .attribute("text")
            .or_else(|| node.attribute("title"))
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("未命名主题");
        let note = node
            .attribute("_note")
            .or_else(|| node.attribute("note"))
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let completed = match node.attribute("_complete") {
            Some("true") => Some(true),
            Some("false") => Some(false),
            _ => match node.attribute("_status") {
                Some("checked") => Some(true),
                Some("unchecked") => Some(false),
                _ => None,
            },
        };

        let mut children: Vec<Value> = Vec::new();
        for child in node.children() {
            if child.is_element() && child.tag_name().name().eq_ignore_ascii_case("outline") {
                children.push(Self::opml_outline_to_value(child, depth + 1, stats, counter)?);
            }
        }

        let mut value = json!({
            "id": Self::mindmap_import_alloc_id(counter, false),
            "text": text,
            "children": children,
        });
        if let Some(note) = note {
            value["note"] = json!(note);
        }
        if let Some(completed) = completed {
            value["completed"] = json!(completed);
        }
        Ok(value)
    }

    fn parse_opml_to_mindmap(
        text: &str,
        fallback_title: &str,
        stats: &mut MindMapImportStats,
    ) -> Result<Value, String> {
        let doc = roxmltree::Document::parse(text)
            .map_err(|e| format!("OPML 解析失败: {}", e))?;
        let body = doc
            .descendants()
            .find(|n| n.is_element() && n.tag_name().name().eq_ignore_ascii_case("body"))
            .ok_or_else(|| "无效的 OPML：缺少 body 元素".to_string())?;
        let outlines: Vec<roxmltree::Node<'_, '_>> = body
            .children()
            .filter(|n| n.is_element() && n.tag_name().name().eq_ignore_ascii_case("outline"))
            .collect();
        if outlines.is_empty() {
            return Err("无效的 OPML：没有 outline 元素".to_string());
        }

        let mut counter: usize = 0;
        if outlines.len() == 1 {
            let mut root = Self::opml_outline_to_value(outlines[0], 0, stats, &mut counter)?;
            root["id"] = json!("root");
            return Ok(root);
        }

        Self::mindmap_import_claim_node(stats, 0)?;
        let mut children: Vec<Value> = Vec::new();
        for outline in outlines {
            children.push(Self::opml_outline_to_value(outline, 1, stats, &mut counter)?);
        }
        let title = doc
            .descendants()
            .find(|n| n.is_element() && n.tag_name().name().eq_ignore_ascii_case("title"))
            .and_then(|n| n.text())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(fallback_title);
        Ok(json!({
            "id": "root",
            "text": title,
            "children": children,
        }))
    }

    // ------------------------------------------------------------------
    // FreeMind / Freeplane (.mm) 解析
    // ------------------------------------------------------------------

    /// 提取 FreeMind richcontent 文本；NODE 折叠为单行，NOTE 保留行结构
    fn freemind_richcontent_text(
        node: roxmltree::Node<'_, '_>,
        content_type: &str,
    ) -> Option<String> {
        let rich = node.children().find(|child| {
            child.is_element()
                && child.tag_name().name().eq_ignore_ascii_case("richcontent")
                && child
                    .attribute("TYPE")
                    .or_else(|| child.attribute("type"))
                    .map(|t| t.eq_ignore_ascii_case(content_type))
                    .unwrap_or(false)
        })?;
        // 只收集文本节点，避免元素节点 text() 与其文本子节点重复计入
        let raw: String = rich
            .descendants()
            .filter(|d| d.is_text())
            .filter_map(|d| d.text())
            .collect::<Vec<&str>>()
            .join(" ");
        if content_type.eq_ignore_ascii_case("NODE") {
            let collapsed = raw.split_whitespace().collect::<Vec<&str>>().join(" ");
            if collapsed.is_empty() {
                None
            } else {
                Some(collapsed)
            }
        } else {
            let lines: Vec<&str> = raw
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .collect();
            if lines.is_empty() {
                None
            } else {
                Some(lines.join("\n"))
            }
        }
    }

    fn freemind_node_to_value(
        node: roxmltree::Node<'_, '_>,
        depth: usize,
        stats: &mut MindMapImportStats,
        counter: &mut usize,
        id_map: &mut HashMap<String, String>,
        raw_links: &mut Vec<(String, String, Option<String>)>,
        force_root: bool,
    ) -> Result<Value, String> {
        Self::mindmap_import_claim_node(stats, depth)?;
        let assigned_id = Self::mindmap_import_alloc_id(counter, force_root);
        let attr_text = node
            .attribute("TEXT")
            .or_else(|| node.attribute("text"))
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let text = attr_text
            .map(str::to_string)
            .or_else(|| Self::freemind_richcontent_text(node, "NODE"))
            .unwrap_or_else(|| "未命名主题".to_string());
        let note = Self::freemind_richcontent_text(node, "NOTE");

        // 源 ID → 实际节点 ID；无源 ID 时登记自映射，供 arrowlink 端点重映射
        let original_id = node
            .attribute("ID")
            .or_else(|| node.attribute("id"))
            .map(str::to_string)
            .unwrap_or_else(|| assigned_id.clone());
        id_map
            .entry(original_id.clone())
            .or_insert_with(|| assigned_id.clone());

        // 完成态图标：button_ok → 已完成，button_cancel → 未完成任务
        let mut completed: Option<bool> = None;
        for icon in node.children().filter(|child| {
            child.is_element() && child.tag_name().name().eq_ignore_ascii_case("icon")
        }) {
            match icon.attribute("BUILTIN") {
                Some("button_ok") => {
                    completed = Some(true);
                    break;
                }
                Some("button_cancel") => completed = Some(false),
                _ => {}
            }
        }

        // <arrowlink DESTINATION="…"/>：自由连线 → 关联线
        for arrow in node.children().filter(|child| {
            child.is_element() && child.tag_name().name().eq_ignore_ascii_case("arrowlink")
        }) {
            if let Some(destination) = arrow
                .attribute("DESTINATION")
                .or_else(|| arrow.attribute("destination"))
            {
                raw_links.push((
                    original_id.clone(),
                    destination.to_string(),
                    arrow.attribute("MIDDLE_LABEL").map(str::to_string),
                ));
            }
        }

        let mut children: Vec<Value> = Vec::new();
        for child in node.children() {
            if child.is_element() && child.tag_name().name().eq_ignore_ascii_case("node") {
                children.push(Self::freemind_node_to_value(
                    child, depth + 1, stats, counter, id_map, raw_links, false,
                )?);
            }
        }

        let mut value = json!({
            "id": assigned_id,
            "text": text,
            "children": children,
        });
        if let Some(note) = note {
            value["note"] = json!(note);
        }
        if let Some(completed) = completed {
            value["completed"] = json!(completed);
        }
        Ok(value)
    }

    fn parse_freemind_to_mindmap(
        text: &str,
        fallback_title: &str,
        stats: &mut MindMapImportStats,
    ) -> Result<(Value, Vec<Value>), String> {
        let doc = roxmltree::Document::parse(text)
            .map_err(|e| format!("FreeMind XML 解析失败: {}", e))?;
        let map_element = doc.root_element();
        if !map_element.tag_name().name().eq_ignore_ascii_case("map") {
            return Err("无效的 FreeMind 文件：缺少 map 根元素".to_string());
        }
        let root_nodes: Vec<roxmltree::Node<'_, '_>> = map_element
            .children()
            .filter(|n| n.is_element() && n.tag_name().name().eq_ignore_ascii_case("node"))
            .collect();
        if root_nodes.is_empty() {
            return Err("无效的 FreeMind 文件：没有 node 元素".to_string());
        }

        let mut counter: usize = 0;
        let mut id_map: HashMap<String, String> = HashMap::new();
        let mut raw_links: Vec<(String, String, Option<String>)> = Vec::new();

        let root = if root_nodes.len() == 1 {
            Self::freemind_node_to_value(
                root_nodes[0], 0, stats, &mut counter, &mut id_map, &mut raw_links, true,
            )?
        } else {
            Self::mindmap_import_claim_node(stats, 0)?;
            let mut children: Vec<Value> = Vec::new();
            for node in root_nodes {
                children.push(Self::freemind_node_to_value(
                    node, 1, stats, &mut counter, &mut id_map, &mut raw_links, false,
                )?);
            }
            json!({
                "id": "root",
                "text": fallback_title,
                "children": children,
            })
        };

        let mut assoc_counter: usize = 0;
        let associations =
            Self::remap_import_associations(&raw_links, &id_map, &mut assoc_counter);
        Ok((root, associations))
    }

    // ------------------------------------------------------------------
    // XMind (.xmind zip：Zen content.json 优先，回退 XMind 8 content.xml)
    // ------------------------------------------------------------------

    fn xmind_json_topic_to_value(
        topic: &Value,
        depth: usize,
        stats: &mut MindMapImportStats,
        counter: &mut usize,
        id_map: &mut HashMap<String, String>,
        force_root: bool,
    ) -> Result<Value, String> {
        Self::mindmap_import_claim_node(stats, depth)?;
        let assigned_id = Self::mindmap_import_alloc_id(counter, force_root);
        if let Some(original_id) = topic.get("id").and_then(|v| v.as_str()) {
            id_map
                .entry(original_id.to_string())
                .or_insert_with(|| assigned_id.clone());
        }

        // 丢弃项计数（图片/概要/外框/超链接在本应用模型中不支持）
        if topic.get("image").is_some() {
            stats.dropped_images += 1;
        }
        if topic
            .get("href")
            .and_then(|v| v.as_str())
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
        {
            stats.dropped_hyperlinks += 1;
        }
        if let Some(summaries) = topic.get("summaries").and_then(|v| v.as_array()) {
            stats.dropped_summaries += summaries.len();
        } else if let Some(summary_topics) = topic
            .get("children")
            .and_then(|c| c.get("summary"))
            .and_then(|v| v.as_array())
        {
            stats.dropped_summaries += summary_topics.len();
        }
        if let Some(boundaries) = topic.get("boundaries").and_then(|v| v.as_array()) {
            stats.dropped_boundaries += boundaries.len();
        }

        let text = topic
            .get("title")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("未命名主题");

        let note = topic
            .get("notes")
            .and_then(|notes| {
                notes
                    .get("plain")
                    .and_then(|p| p.get("content"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .or_else(|| {
                        notes
                            .get("html")
                            .and_then(|h| h.get("content"))
                            .and_then(|v| v.as_str())
                            .map(Self::strip_html_tags)
                            .filter(|s| !s.is_empty())
                    })
            });

        // 任务 marker：task-done → 已完成；其余 task-* → 未完成任务
        let mut completed: Option<bool> = None;
        if let Some(markers) = topic.get("markers").and_then(|v| v.as_array()) {
            for marker in markers {
                if let Some(marker_id) = marker.get("markerId").and_then(|v| v.as_str()) {
                    if marker_id.starts_with("task-") {
                        completed = Some(marker_id == "task-done");
                        break;
                    }
                }
            }
        }

        let mut children: Vec<Value> = Vec::new();
        if let Some(attached) = topic
            .get("children")
            .and_then(|c| c.get("attached"))
            .and_then(|v| v.as_array())
        {
            for child in attached {
                children.push(Self::xmind_json_topic_to_value(
                    child, depth + 1, stats, counter, id_map, false,
                )?);
            }
        }

        let mut value = json!({
            "id": assigned_id,
            "text": text,
            "children": children,
        });
        if let Some(note) = note {
            value["note"] = json!(note);
        }
        if let Some(completed) = completed {
            value["completed"] = json!(completed);
        }
        Ok(value)
    }

    fn xmind_xml_child_elements<'a, 'input>(
        node: roxmltree::Node<'a, 'input>,
        local_name: &str,
    ) -> Vec<roxmltree::Node<'a, 'input>> {
        node.children()
            .filter(|child| {
                child.is_element() && child.tag_name().name().eq_ignore_ascii_case(local_name)
            })
            .collect()
    }

    fn xmind_xml_topic_to_value(
        topic: roxmltree::Node<'_, '_>,
        depth: usize,
        stats: &mut MindMapImportStats,
        counter: &mut usize,
        id_map: &mut HashMap<String, String>,
        force_root: bool,
    ) -> Result<Value, String> {
        Self::mindmap_import_claim_node(stats, depth)?;
        let assigned_id = Self::mindmap_import_alloc_id(counter, force_root);
        if let Some(original_id) = topic.attribute("id") {
            id_map
                .entry(original_id.to_string())
                .or_insert_with(|| assigned_id.clone());
        }

        // 丢弃项计数：<xhtml:img>（localName=img）、boundaries、summaries、xlink:href
        stats.dropped_images += Self::xmind_xml_child_elements(topic, "img").len();
        for container in Self::xmind_xml_child_elements(topic, "summaries") {
            stats.dropped_summaries +=
                Self::xmind_xml_child_elements(container, "summary").len();
        }
        for container in Self::xmind_xml_child_elements(topic, "boundaries") {
            stats.dropped_boundaries +=
                Self::xmind_xml_child_elements(container, "boundary").len();
        }
        if topic.attributes().any(|attr| attr.name() == "href") {
            stats.dropped_hyperlinks += 1;
        }

        let text = Self::xmind_xml_child_elements(topic, "title")
            .first()
            .and_then(|n| n.text())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("未命名主题");

        let note = Self::xmind_xml_child_elements(topic, "notes")
            .first()
            .and_then(|notes| {
                notes
                    .descendants()
                    .find(|n| n.is_element() && n.tag_name().name().eq_ignore_ascii_case("plain"))
                    .and_then(|n| {
                        // 只收集文本节点，避免元素与其文本子节点重复计入
                        let raw: String = n
                            .descendants()
                            .filter(|d| d.is_text())
                            .filter_map(|d| d.text())
                            .collect::<Vec<&str>>()
                            .join("");
                        let trimmed = raw.trim().to_string();
                        if trimmed.is_empty() {
                            None
                        } else {
                            Some(trimmed)
                        }
                    })
            });

        // marker-refs → 任务完成态
        let mut completed: Option<bool> = None;
        for refs_container in Self::xmind_xml_child_elements(topic, "marker-refs") {
            for marker_ref in Self::xmind_xml_child_elements(refs_container, "marker-ref") {
                if let Some(marker_id) = marker_ref.attribute("marker-id") {
                    if marker_id.starts_with("task-") {
                        completed = Some(marker_id == "task-done");
                        break;
                    }
                }
            }
        }

        let mut children: Vec<Value> = Vec::new();
        for children_container in Self::xmind_xml_child_elements(topic, "children") {
            for topics_group in Self::xmind_xml_child_elements(children_container, "topics") {
                let group_type = topics_group.attribute("type").unwrap_or("attached");
                if group_type != "attached" {
                    continue;
                }
                for child_topic in Self::xmind_xml_child_elements(topics_group, "topic") {
                    children.push(Self::xmind_xml_topic_to_value(
                        child_topic, depth + 1, stats, counter, id_map, false,
                    )?);
                }
            }
        }

        let mut value = json!({
            "id": assigned_id,
            "text": text,
            "children": children,
        });
        if let Some(note) = note {
            value["note"] = json!(note);
        }
        if let Some(completed) = completed {
            value["completed"] = json!(completed);
        }
        Ok(value)
    }

    fn parse_xmind_to_mindmap(
        bytes: &[u8],
        fallback_title: &str,
        stats: &mut MindMapImportStats,
    ) -> Result<(Value, Vec<Value>), String> {
        let cursor = std::io::Cursor::new(bytes);
        let mut archive = zip::ZipArchive::new(cursor)
            .map_err(|e| format!("无效的 XMind 文件（zip 解包失败）: {}", e))?;

        // XMind Zen：content.json
        if let Some(content_json) = Self::read_mindmap_zip_entry(&mut archive, "content.json")? {
            let raw: Value = serde_json::from_str(&content_json)
                .map_err(|e| format!("无效的 XMind content.json: {}", e))?;
            let sheet_values: Vec<Value> = match raw {
                Value::Array(items) => items,
                other => vec![other],
            };
            let sheets: Vec<&Value> = sheet_values
                .iter()
                .filter(|sheet| sheet.get("rootTopic").map(|t| t.is_object()).unwrap_or(false))
                .collect();
            if sheets.is_empty() {
                return Err("无效的 XMind：缺少根主题".to_string());
            }

            let mut counter: usize = 0;
            let mut id_map: HashMap<String, String> = HashMap::new();
            // sheet 级关联线（拓扑转换完成后统一按 id_map 重映射）
            let raw_links: Vec<(String, String, Option<String>)> = sheets
                .iter()
                .flat_map(|sheet| {
                    sheet
                        .get("relationships")
                        .and_then(|v| v.as_array())
                        .map(|rels| {
                            rels.iter()
                                .filter_map(|rel| {
                                    let end1 = rel.get("end1Id").and_then(|v| v.as_str())?;
                                    let end2 = rel.get("end2Id").and_then(|v| v.as_str())?;
                                    Some((
                                        end1.to_string(),
                                        end2.to_string(),
                                        rel.get("title")
                                            .and_then(|v| v.as_str())
                                            .map(str::to_string),
                                    ))
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default()
                })
                .collect();

            let root = if sheets.len() == 1 {
                let root_topic = sheets[0]
                    .get("rootTopic")
                    .ok_or_else(|| "无效的 XMind：缺少根主题".to_string())?;
                Self::xmind_json_topic_to_value(
                    root_topic, 0, stats, &mut counter, &mut id_map, true,
                )?
            } else {
                Self::mindmap_import_claim_node(stats, 0)?;
                let mut children: Vec<Value> = Vec::new();
                for sheet in &sheets {
                    let root_topic = sheet
                        .get("rootTopic")
                        .ok_or_else(|| "无效的 XMind：缺少根主题".to_string())?;
                    children.push(Self::xmind_json_topic_to_value(
                        root_topic, 1, stats, &mut counter, &mut id_map, false,
                    )?);
                }
                json!({
                    "id": "root",
                    "text": fallback_title,
                    "note": format!("合并自 {} 个 XMind 画布", sheets.len()),
                    "children": children,
                })
            };

            let mut assoc_counter: usize = 0;
            let associations =
                Self::remap_import_associations(&raw_links, &id_map, &mut assoc_counter);
            return Ok((root, associations));
        }

        // XMind 8：content.xml
        if let Some(content_xml) = Self::read_mindmap_zip_entry(&mut archive, "content.xml")? {
            let doc = roxmltree::Document::parse(&content_xml)
                .map_err(|e| format!("无效的 XMind content.xml: {}", e))?;
            let sheet_elements: Vec<roxmltree::Node<'_, '_>> = doc
                .descendants()
                .filter(|n| n.is_element() && n.tag_name().name().eq_ignore_ascii_case("sheet"))
                .collect();
            let root_topics: Vec<roxmltree::Node<'_, '_>> = sheet_elements
                .iter()
                .filter_map(|sheet| {
                    Self::xmind_xml_child_elements(*sheet, "topic").first().copied()
                })
                .collect();
            if root_topics.is_empty() {
                return Err("无效的 XMind：缺少根主题".to_string());
            }

            let mut counter: usize = 0;
            let mut id_map: HashMap<String, String> = HashMap::new();
            let raw_links: Vec<(String, String, Option<String>)> = sheet_elements
                .iter()
                .flat_map(|sheet| Self::xmind_xml_child_elements(*sheet, "relationships"))
                .flat_map(|container| Self::xmind_xml_child_elements(container, "relationship"))
                .filter_map(|rel| {
                    let end1 = rel.attribute("end1")?;
                    let end2 = rel.attribute("end2")?;
                    let label = Self::xmind_xml_child_elements(rel, "title")
                        .first()
                        .and_then(|n| n.text())
                        .map(str::to_string);
                    Some((end1.to_string(), end2.to_string(), label))
                })
                .collect();

            let root = if root_topics.len() == 1 {
                Self::xmind_xml_topic_to_value(
                    root_topics[0], 0, stats, &mut counter, &mut id_map, true,
                )?
            } else {
                Self::mindmap_import_claim_node(stats, 0)?;
                let mut children: Vec<Value> = Vec::new();
                for topic in &root_topics {
                    children.push(Self::xmind_xml_topic_to_value(
                        *topic, 1, stats, &mut counter, &mut id_map, false,
                    )?);
                }
                json!({
                    "id": "root",
                    "text": fallback_title,
                    "note": format!("合并自 {} 个 XMind 画布", root_topics.len()),
                    "children": children,
                })
            };

            let mut assoc_counter: usize = 0;
            let associations =
                Self::remap_import_associations(&raw_links, &id_map, &mut assoc_counter);
            return Ok((root, associations));
        }

        Err("无效的 XMind 文件：缺少 content.json 或 content.xml".to_string())
    }

    // ------------------------------------------------------------------
    // MindManager (.mmap zip：Document.xml，OneTopic/SubTopics 结构)
    // ------------------------------------------------------------------

    fn mmap_topic_to_value(
        topic: roxmltree::Node<'_, '_>,
        depth: usize,
        stats: &mut MindMapImportStats,
        counter: &mut usize,
        force_root: bool,
    ) -> Result<Value, String> {
        Self::mindmap_import_claim_node(stats, depth)?;
        let text = Self::xmind_xml_child_elements(topic, "Text")
            .first()
            .and_then(|text_el| text_el.attribute("PlainText"))
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("未命名主题");

        let mut children: Vec<Value> = Vec::new();
        for sub_topics in Self::xmind_xml_child_elements(topic, "SubTopics") {
            for child_topic in Self::xmind_xml_child_elements(sub_topics, "Topic") {
                children.push(Self::mmap_topic_to_value(
                    child_topic, depth + 1, stats, counter, false,
                )?);
            }
        }

        Ok(json!({
            "id": Self::mindmap_import_alloc_id(counter, force_root),
            "text": text,
            "children": children,
        }))
    }

    fn parse_mmap_to_mindmap(
        bytes: &[u8],
        stats: &mut MindMapImportStats,
    ) -> Result<Value, String> {
        let cursor = std::io::Cursor::new(bytes);
        let mut archive = zip::ZipArchive::new(cursor)
            .map_err(|e| format!("无效的 MindManager 文件（zip 解包失败）: {}", e))?;
        let document_xml = Self::read_mindmap_zip_entry(&mut archive, "Document.xml")?
            .ok_or_else(|| "无效的 MindManager 文件：缺少 Document.xml".to_string())?;
        let doc = roxmltree::Document::parse(&document_xml)
            .map_err(|e| format!("无效的 MindManager Document.xml: {}", e))?;
        let one_topic = doc
            .descendants()
            .find(|n| n.is_element() && n.tag_name().name().eq_ignore_ascii_case("OneTopic"))
            .ok_or_else(|| "无效的 MindManager 文件：缺少 OneTopic 元素".to_string())?;
        let root_topic = Self::xmind_xml_child_elements(one_topic, "Topic")
            .first()
            .copied()
            .ok_or_else(|| "无效的 MindManager 文件：OneTopic 下缺少 Topic".to_string())?;

        let mut counter: usize = 0;
        Self::mmap_topic_to_value(root_topic, 0, stats, &mut counter, true)
    }

    /// 执行知识导图文件导入
    ///
    /// ★ 2026-07 新增：把当前会话上传的思维导图附件（xmind/opml/mm/mmap/md/txt/json）
    /// 解析为 MindMapDocument 后复用 mindmap_create 的落库路径。
    /// 附件寻址范式对齐 chatanki_import_apkg：会话归属校验 → 读 VFS blob 字节。
    async fn execute_mindmap_import(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;

        let raw_resource_id = call
            .arguments
            .get("resourceId")
            .or_else(|| call.arguments.get("resource_id"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or(
                "Missing required parameter 'resourceId'. 请传入当前会话上传的思维导图附件资源 ID（file_/att_/res_）。",
            )?;
        let custom_title = call
            .arguments
            .get("title")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from);
        let folder_id = call
            .arguments
            .get("targetFolderId")
            .or_else(|| call.arguments.get("folder_id"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty() && *s != "root");

        let start_time = Instant::now();

        // 1. 附件寻址：file_/att_/res_ → VfsFile
        let (file, candidate_ids) = Self::resolve_mindmap_import_file(vfs_db, raw_resource_id)?;

        // 2. 会话归属校验（fail-closed：chat 数据库不可用时拒绝导入）
        let chat_db = ctx
            .chat_v2_db
            .as_ref()
            .ok_or("Chat database not available for import resource ownership check")?;
        let owned = Self::verify_mindmap_import_resource_in_session(
            chat_db,
            &ctx.session_id,
            &candidate_ids,
        )?;
        if !owned {
            return Err(format!(
                "Resource '{}' is not available in the current chat session. 只能导入当前会话上下文中的附件。",
                raw_resource_id
            ));
        }

        // 3. 读取字节（VFS blob 优先，回退原始路径；32MB 上限）
        let bytes = Self::load_mindmap_import_bytes(vfs_db, &file)?;

        // 4. 识别格式并解析为节点树 + 关联线
        let fallback_title = file
            .file_name
            .rsplit_once('.')
            .map(|(stem, _)| stem)
            .filter(|stem| !stem.trim().is_empty())
            .unwrap_or(&file.file_name)
            .to_string();
        let detected = Self::detect_mindmap_import_format(&file.file_name, &bytes);
        let mut stats = MindMapImportStats::default();

        let (root, associations, resolved_format): (Value, Vec<Value>, &'static str) =
            match detected {
                "xmind" => {
                    let (root, assoc) =
                        Self::parse_xmind_to_mindmap(&bytes, &fallback_title, &mut stats)?;
                    (root, assoc, "xmind")
                }
                "mmap" => {
                    let root = Self::parse_mmap_to_mindmap(&bytes, &mut stats)?;
                    (root, Vec::new(), "mmap")
                }
                "zip" => {
                    // 无扩展名 zip：先按 XMind 解析，失败再按 MindManager 解析
                    match Self::parse_xmind_to_mindmap(&bytes, &fallback_title, &mut stats) {
                        Ok((root, assoc)) => (root, assoc, "xmind"),
                        Err(xmind_error) => {
                            stats = MindMapImportStats::default();
                            let root =
                                Self::parse_mmap_to_mindmap(&bytes, &mut stats).map_err(
                                    |mmap_error| {
                                        format!(
                                            "无法识别的 zip 导图文件。XMind 解析: {}；MindManager 解析: {}",
                                            xmind_error, mmap_error
                                        )
                                    },
                                )?;
                            (root, Vec::new(), "mmap")
                        }
                    }
                }
                "opml" => {
                    let text = String::from_utf8_lossy(&bytes).into_owned();
                    let root =
                        Self::parse_opml_to_mindmap(&text, &fallback_title, &mut stats)?;
                    (root, Vec::new(), "opml")
                }
                "freemind" => {
                    let text = String::from_utf8_lossy(&bytes).into_owned();
                    let (root, assoc) =
                        Self::parse_freemind_to_mindmap(&text, &fallback_title, &mut stats)?;
                    (root, assoc, "freemind")
                }
                "json" => {
                    let text = String::from_utf8_lossy(&bytes).into_owned();
                    let parsed: Value = serde_json::from_str(&text)
                        .map_err(|e| format!("无效的导图 JSON: {}", e))?;
                    let root = parsed
                        .get("root")
                        .cloned()
                        .ok_or_else(|| "无效的导图 JSON：缺少 root 字段".to_string())?;
                    // 深度/节点数守卫 + 缺失 id 补全
                    let mut root = root;
                    let mut counter: usize = 0;
                    Self::validate_and_fill_json_import_node(
                        &mut root, 0, &mut stats, &mut counter,
                    )?;
                    let associations = parsed
                        .get("associations")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default();
                    (root, associations, "json")
                }
                // "markdown" | "text"
                _ => {
                    let text = String::from_utf8_lossy(&bytes).into_owned();
                    let root =
                        Self::parse_outline_text_to_mindmap(&text, &fallback_title, &mut stats)?;
                    (
                        root,
                        Vec::new(),
                        if detected == "text" { "text" } else { "markdown" },
                    )
                }
            };

        // 5. 组装 MindMapDocument 并复用 create 修复/校验路径
        //    （fix_mindmap_content 会归一化字段并过滤非法关联线）
        let title = custom_title.unwrap_or_else(|| {
            root.get("text")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| fallback_title.clone())
        });
        let mut doc = json!({
            "version": "1.0",
            "root": root,
            "meta": { "createdAt": chrono::Utc::now().to_rfc3339() },
        });
        if !associations.is_empty() {
            doc["associations"] = json!(associations);
        }
        let content = Self::fix_mindmap_content(&doc.to_string());
        // 关联线经 fix 过滤后重新计数（如实上报）
        let association_count = serde_json::from_str::<Value>(&content)
            .ok()
            .and_then(|v| {
                v.get("associations")
                    .and_then(|a| a.as_array())
                    .map(|a| a.len())
            })
            .unwrap_or(0);

        log::info!(
            "[BuiltinResourceExecutor] mindmap_import: resource={}, format={}, nodes={}, associations={}",
            raw_resource_id,
            resolved_format,
            stats.node_count,
            association_count
        );

        // 6. 复用 mindmap_create 的落库路径
        let params = VfsCreateMindMapParams {
            title: title.clone(),
            description: None,
            content,
            default_view: "mindmap".to_string(),
            theme: None,
        };
        let mindmap = VfsMindMapRepo::create_mindmap_in_folder(vfs_db, params, folder_id)
            .map_err(|e| format!("Failed to create mindmap from import: {}", e))?;

        // 发射 DSTU watch 事件，通知 Learning Hub 自动刷新列表
        {
            let node = mindmap_to_dstu_node(&mindmap);
            emit_watch_event(
                ctx.window_ref(),
                DstuWatchEvent::created(&node.path, node.clone()),
            );
        }

        // 初始版本快照 → versionId 供 LLM 引用（与 mindmap_create 一致）
        let version_id = match VfsMindMapRepo::get_mindmap_content(vfs_db, &mindmap.id) {
            Ok(Some(initial_content)) => {
                match VfsMindMapRepo::create_version(
                    vfs_db,
                    &mindmap.id,
                    &initial_content,
                    &mindmap.title,
                    None,
                    Some("chat_create"),
                ) {
                    Ok(version) => Some(version.version_id),
                    Err(e) => {
                        log::warn!(
                            "[BuiltinResourceExecutor] Failed to create initial version for imported mindmap {}: {}",
                            mindmap.id, e
                        );
                        None
                    }
                }
            }
            _ => None,
        };

        let duration = start_time.elapsed().as_millis() as u64;

        log::info!(
            "[BuiltinResourceExecutor] mindmap_import completed: id={} in {}ms",
            mindmap.id,
            duration
        );

        let mut result = json!({
            "success": true,
            "mindmap": {
                "id": mindmap.id,
                "title": mindmap.title,
                "description": mindmap.description,
                "defaultView": mindmap.default_view,
                "theme": mindmap.theme,
                "createdAt": mindmap.created_at,
                "updatedAt": mindmap.updated_at,
            },
            "importStats": {
                "format": resolved_format,
                "sourceFileName": file.file_name,
                "nodeCount": stats.node_count,
                "associationCount": association_count,
                "droppedImages": stats.dropped_images,
                "droppedSummaries": stats.dropped_summaries,
                "droppedBoundaries": stats.dropped_boundaries,
                "droppedHyperlinks": stats.dropped_hyperlinks,
            },
            "notice": "样式/主题/图片等信息不导入；请根据 importStats 如实向用户汇报被忽略的内容。",
            "durationMs": duration,
        });

        if let Some(ref vid) = version_id {
            result["versionId"] = json!(vid);
            result["citation"] = json!(format!("[思维导图:{}:{}]", vid, title));
            result["hint"] =
                json!("请在回复中使用上方 citation 字段的引用文本，让用户可以点击查看导图。");
        }

        Ok(result)
    }

    /// JSON 导入：递归校验深度/节点数并补全缺失的节点 id
    fn validate_and_fill_json_import_node(
        node: &mut Value,
        depth: usize,
        stats: &mut MindMapImportStats,
        counter: &mut usize,
    ) -> Result<(), String> {
        Self::mindmap_import_claim_node(stats, depth)?;
        let obj = node
            .as_object_mut()
            .ok_or_else(|| "无效的导图 JSON：节点必须是对象".to_string())?;
        let has_valid_id = obj
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        if !has_valid_id {
            let assigned = if depth == 0 {
                "root".to_string()
            } else {
                Self::mindmap_import_alloc_id(counter, false)
            };
            obj.insert("id".to_string(), json!(assigned));
        }
        if let Some(children) = obj.get_mut("children").and_then(|v| v.as_array_mut()) {
            for child in children.iter_mut() {
                Self::validate_and_fill_json_import_node(child, depth + 1, stats, counter)?;
            }
        }
        Ok(())
    }

    // ========================================================================
    // 细粒度节点编辑 — execute_mindmap_edit_nodes + 辅助方法
    // ========================================================================

    /// 执行细粒度节点编辑
    ///
    /// 支持批量操作：update_node / add_node / delete_node / move_node
    /// 无需传入完整 JSON，比 mindmap_update 更高效。
    ///
    /// ACR R1-05：开窗且 probe∈{clean,dirty,hot} 时委托前端 apply_ops 实时演出；
    /// closed/frozen/disabled 或桥错误回落既有 OCC 后端路径。
    /// 设计文档：`docs/dev/acr/DESIGN.md` §1.1 / §5.1
    async fn execute_mindmap_edit_nodes(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;

        // 1. 解析参数
        let mindmap_id = call
            .arguments
            .get("mindmap_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'mindmap_id' parameter")?;

        let operations = get_json_array_arg(&call.arguments, "operations")
            .ok_or("Missing or invalid 'operations' parameter (expected array)")?;

        // ★ P3：可选顶层 associations —— 整体替换文档级关联线（[] 清除；不传保持现状）
        let associations_arg: Option<Vec<Value>> = match call.arguments.get("associations") {
            None | Some(Value::Null) => None,
            Some(Value::Array(items)) => Some(items.clone()),
            Some(_) => {
                return Err(
                    "Invalid 'associations' parameter: expected an array of {source, target, label?} objects"
                        .to_string(),
                );
            }
        };

        if operations.is_empty() && associations_arg.is_none() {
            return Ok(json!({
                "success": true,
                "appliedCount": 0,
                "totalOperations": 0,
            }));
        }

        log::info!(
            "[BuiltinResourceExecutor] mindmap_edit_nodes: id={}, ops={}, associations={:?}",
            mindmap_id,
            operations.len(),
            associations_arg.as_ref().map(|a| a.len())
        );

        // ★ ACR R1-05：probe → 可委托则 apply_ops；否则回落后端。
        // 携带 associations 时前端 apply_ops 协议不含该操作，直接走后端路径。
        if associations_arg.is_none() {
            if let Some(frontend_result) =
                Self::try_mindmap_edit_via_acr(ctx, mindmap_id, &operations).await
            {
                return frontend_result;
            }
        }

        let start_time = Instant::now();

        // 2. 获取当前导图元数据 + 内容
        let mindmap = VfsMindMapRepo::get_mindmap(vfs_db, mindmap_id)
            .map_err(|e| format!("Failed to get mindmap: {}", e))?
            .ok_or_else(|| {
                format!(
                    "Mindmap not found: {}. 请先调用 resource_list(type=\"mindmap\") 确认导图存在。",
                    mindmap_id
                )
            })?;

        let expected_updated_at = Some(mindmap.updated_at.clone());

        let content_str = VfsMindMapRepo::get_mindmap_content(vfs_db, mindmap_id)
            .map_err(|e| format!("Failed to get mindmap content: {}", e))?
            .ok_or_else(|| format!("Mindmap content is empty: {}", mindmap_id))?;

        let mut doc: Value = serde_json::from_str(&content_str)
            .map_err(|e| format!("Failed to parse mindmap content JSON: {}", e))?;

        // 3. 遍历 operations 执行操作
        let total = operations.len();
        let mut applied = 0usize;
        let mut errors: Vec<String> = Vec::new();

        for (i, op) in operations.iter().enumerate() {
            let op_type = op.get("type").and_then(|v| v.as_str()).unwrap_or("");

            let result = match op_type {
                "update_node" => Self::op_update_node(&mut doc, op),
                "add_node" => Self::op_add_node(&mut doc, op),
                "delete_node" => Self::op_delete_node(&mut doc, op),
                "move_node" => Self::op_move_node(&mut doc, op),
                _ => Err(format!("Unknown operation type: '{}'", op_type)),
            };

            match result {
                Ok(()) => applied += 1,
                Err(e) => {
                    let msg = format!("op[{}] {} failed: {}", i, op_type, e);
                    log::warn!("[BuiltinResourceExecutor] mindmap_edit_nodes: {}", msg);
                    errors.push(msg);
                }
            }
        }

        // 3.5 ★ P3：应用顶层 associations（整体替换 + 端点存在性校验）
        let mut associations_updated = false;
        if let Some(new_associations) = associations_arg {
            if let Some(obj) = doc.as_object_mut() {
                obj.insert(
                    "associations".to_string(),
                    Value::Array(new_associations),
                );
                // 复用统一校验：过滤端点不存在/自指的连线，补全缺失 id
                Self::sanitize_mindmap_associations(&mut doc);
                associations_updated = true;
            } else {
                errors.push("associations failed: mindmap document is not an object".to_string());
            }
        }

        // 4. 保存修改后的内容（乐观并发控制）
        if applied > 0 || associations_updated {
            let new_content = doc.to_string();

            let params = VfsUpdateMindMapParams {
                title: None,
                description: None,
                content: Some(new_content),
                default_view: None,
                theme: None,
                settings: None,
                expected_updated_at,
                version_source: Some("chat_edit_nodes".to_string()),
            };

            let updated_mindmap = VfsMindMapRepo::update_mindmap(vfs_db, mindmap_id, params)
                .map_err(|e| format!("Failed to save mindmap after edit: {}", e))?;

            // 5. 发射 DSTU watch 事件通知前端刷新
            {
                let node = mindmap_to_dstu_node(&updated_mindmap);
                emit_watch_event(
                    ctx.window_ref(),
                    DstuWatchEvent::updated(&node.path, node.clone()),
                );
            }
        }

        let duration = start_time.elapsed().as_millis() as u64;

        log::info!(
            "[BuiltinResourceExecutor] mindmap_edit_nodes completed: id={}, applied={}/{} in {}ms",
            mindmap_id,
            applied,
            total,
            duration
        );

        let mut result = json!({
            "success": errors.is_empty(),
            "appliedCount": applied,
            "totalOperations": total,
            "associationsUpdated": associations_updated,
            "durationMs": duration,
            // ACR R1-05：回落平面说明（STANDARDS §4 降级不可静默；对齐 R1-03）
            "mode": "backend",
            "plane": "backend",
            "delegated": false,
            "message": "导图未打开/桌面未就绪，已直接写入后端（OCC + 版本快照）",
        });

        if !errors.is_empty() {
            result["errors"] = json!(errors);
        }

        // ★ 2026-02-13：为编辑后的新内容创建版本快照，返回 versionId 供 LLM 在引用中使用
        if applied > 0 || associations_updated {
            if let Ok(Some(new_content)) = VfsMindMapRepo::get_mindmap_content(vfs_db, mindmap_id) {
                // 获取当前标题
                let title = VfsMindMapRepo::get_mindmap(vfs_db, mindmap_id)
                    .ok()
                    .flatten()
                    .map(|m| m.title)
                    .unwrap_or_else(|| "思维导图".to_string());

                match VfsMindMapRepo::create_version(
                    vfs_db,
                    mindmap_id,
                    &new_content,
                    &title,
                    None,
                    Some("chat_edit_nodes"),
                ) {
                    Ok(version) => {
                        result["versionId"] = json!(version.version_id);
                        result["citation"] =
                            json!(format!("[思维导图:{}:{}]", version.version_id, title));
                        result["hint"] = json!("请在回复中使用上方 citation 字段的引用文本，让用户可以点击查看编辑后的导图。");
                    }
                    Err(e) => {
                        log::warn!(
                            "[BuiltinResourceExecutor] Failed to create post-edit version for mindmap {}: {}",
                            mindmap_id, e
                        );
                    }
                }
            }
        }

        Ok(result)
    }

    /// ACR R1-05：probe 后尝试前端委托；返回 `Some` 表示已处理（含失败回执），
    /// `None` 表示应回落既有后端 OCC 路径。
    async fn try_mindmap_edit_via_acr(
        ctx: &ExecutionContext,
        mindmap_id: &str,
        operations: &[Value],
    ) -> Option<Result<Value, String>> {
        match is_workbench_agent_delegation_enabled(ctx).await {
            Ok(true) => {}
            Ok(false) => {
                log::debug!(
                    "[BuiltinResourceExecutor] mindmap ACR dual gate disabled; use backend data plane"
                );
                return None;
            }
            Err(error) => {
                log::warn!(
                    "[BuiltinResourceExecutor] mindmap ACR dual gate unavailable; fail closed to backend: {}",
                    error
                );
                return None;
            }
        }

        let probe_args = json!({
            "target": {
                "typeId": "mindmap",
                "resourceId": mindmap_id,
            }
        });

        let probe_resp = match acr_bridge_call(ctx, "probe", probe_args, PROBE_TIMEOUT_MS).await {
            Ok(resp) => resp,
            Err(e) if is_bridge_cancelled(&e) => {
                // R2-01：取消禁止回落后端双写
                return Some(Ok(json!({
                    "status": "cancelled",
                    "mode": "frontend",
                    "applied": 0,
                    "totalOps": operations.len(),
                    "entityIds": [mindmap_id],
                    "done": [],
                    "undone": operations.iter().map(|_| "cancelled before probe").collect::<Vec<_>>(),
                    "message": "用户取消；未写入。请根据 done/undone 继续，勿原样重试。",
                    "plane": "frontend",
                    "delegated": true,
                })));
            }
            Err(e) => {
                log::info!(
                    "[BuiltinResourceExecutor] mindmap ACR probe bridge error, fallback backend: {}",
                    e
                );
                return None;
            }
        };

        if !probe_resp.ok {
            log::info!(
                "[BuiltinResourceExecutor] mindmap ACR probe not ok, fallback backend: {:?}",
                probe_resp.error
            );
            return None;
        }

        let state = probe_resp
            .data
            .as_ref()
            .and_then(|d| d.get("state"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let probe_window_id = probe_resp
            .data
            .as_ref()
            .and_then(|data| data.get("windowId"))
            .and_then(|value| value.as_str())
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string);

        match state {
            "clean" | "dirty" | "hot" => {}
            "closed" | "frozen" | "disabled" | "" => {
                log::info!(
                    "[BuiltinResourceExecutor] mindmap ACR probe state='{}', fallback backend",
                    state
                );
                return None;
            }
            other => {
                log::info!(
                    "[BuiltinResourceExecutor] mindmap ACR probe unknown state='{}', fallback backend",
                    other
                );
                return None;
            }
        }
        let Some(probe_window_id) = probe_window_id else {
            log::warn!(
                "[BuiltinResourceExecutor] mindmap probe eligible but missing exact windowId"
            );
            return Some(Err(json!({
                "code": "BRIDGE_PROTOCOL_ERROR",
                "message": "mindmap probe 未返回精确 windowId",
                "hint": "重新 probe；不得对同资源的其他窗口粗粒度委托",
                "retryable": false,
            })
            .to_string()));
        };

        if ctx.is_cancelled() {
            return Some(Ok(json!({
                "status": "cancelled",
                "mode": "frontend",
                "applied": 0,
                "totalOps": operations.len(),
                "entityIds": [mindmap_id],
                "done": [],
                "undone": operations.iter().map(|_| "cancelled before apply_ops submission").collect::<Vec<_>>(),
                "message": "用户在提交写入前取消；未改动导图，不可自动重试。",
                "retryable": false,
                "plane": "frontend",
                "delegated": true,
            })));
        }

        let ops: Vec<Value> = operations
            .iter()
            .map(Self::mindmap_operation_to_agent_op)
            .collect();
        let destructive = ops.iter().any(|op| {
            op.get("destructive")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        });

        let apply_args = json!({
            "target": {
                "typeId": "mindmap",
                "resourceId": mindmap_id,
                "windowId": probe_window_id,
            },
            "ops": ops,
            "pacing": "normal",
            "destructive": destructive,
        });

        // R2-01：DESIGN §6 — 30s + N×pacing，clamp ≤120s（取代固定 60s）
        let apply_timeout = apply_ops_timeout_ms(ops.len(), Some("normal"));
        let apply_resp = match acr_bridge_call(ctx, "apply_ops", apply_args, apply_timeout).await {
            Ok(resp) => resp,
            // apply_ops 已提交后不能伪造 applied=0；取消先由桥层有界
            // drain 权威终态，无回执时与其他桥故障一样返回 resultUnknown。
            Err(e) => {
                log::warn!(
                    "[BuiltinResourceExecutor] mindmap ACR apply_ops bridge error; no backend fallback: {}",
                    e
                );
                let labels = ops
                    .iter()
                    .map(|op| {
                        op.get("label")
                            .and_then(|value| value.as_str())
                            .unwrap_or("op")
                            .to_string()
                    })
                    .collect();
                return Some(Ok(uncertain_apply_receipt(
                    vec![mindmap_id.to_string()],
                    labels,
                    &e,
                )));
            }
        };

        if !apply_resp.ok {
            let error = apply_resp
                .error
                .unwrap_or_else(|| "ACR apply_ops returned ok=false".to_string());
            log::warn!(
                "[BuiltinResourceExecutor] mindmap ACR apply_ops not ok; no backend fallback: {}",
                error
            );
            if serde_json::from_str::<Value>(&error)
                .ok()
                .and_then(|value| value.get("code").cloned())
                .is_some()
            {
                return Some(Err(error));
            }
            let labels = ops
                .iter()
                .map(|op| {
                    op.get("label")
                        .and_then(|value| value.as_str())
                        .unwrap_or("op")
                        .to_string()
                })
                .collect();
            return Some(Ok(uncertain_apply_receipt(
                vec![mindmap_id.to_string()],
                labels,
                &error,
            )));
        }

        let receipt_labels = || {
            ops.iter()
                .map(|op| {
                    op.get("label")
                        .and_then(|value| value.as_str())
                        .unwrap_or("op")
                        .to_string()
                })
                .collect::<Vec<_>>()
        };
        let Some(mut receipt) = apply_resp.data else {
            return Some(Ok(uncertain_apply_receipt(
                vec![mindmap_id.to_string()],
                receipt_labels(),
                "ACR apply_ops returned no receipt",
            )));
        };
        if !is_valid_apply_receipt(&receipt) {
            return Some(Ok(uncertain_apply_receipt(
                vec![mindmap_id.to_string()],
                receipt_labels(),
                "ACR apply_ops returned malformed receipt",
            )));
        }

        if let Some(obj) = receipt.as_object_mut() {
            // ACR R2-02：suggestion 模式勿改写成 frontend/成功落盘语义
            let mode = obj
                .get("mode")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let suggestion_pending = obj
                .get("suggestionPending")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
                || mode == "suggestion";

            if suggestion_pending {
                obj.insert("mode".to_string(), json!("suggestion"));
                obj.insert("plane".to_string(), json!("suggestion"));
                obj.insert("delegated".to_string(), json!(true));
                // 未改文档：success 仍 true（工具协议完成），LLM 看 suggestionPending
                obj.insert("success".to_string(), json!(true));
                let msg = obj
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if msg.is_empty() {
                    obj.insert(
                        "message".to_string(),
                        json!(
                            "存在未保存编辑，已提交建议（未改文档）；请等待用户空闲或改走后端路径"
                        ),
                    );
                }
            } else {
                obj.entry("mode".to_string())
                    .or_insert_with(|| json!("frontend"));
                let msg = obj
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if msg.is_empty() {
                    obj.insert(
                        "message".to_string(),
                        json!("已在前端导图窗口实时应用并自动保存（debounceSave + OCC）"),
                    );
                } else if !msg.contains("自动保存") && !msg.contains("实时") {
                    obj.insert(
                        "message".to_string(),
                        json!(format!("{}（前端实时应用 + 自动保存）", msg)),
                    );
                }
                obj.insert("success".to_string(), json!(true));
                obj.insert("delegated".to_string(), json!(true));
                obj.insert("plane".to_string(), json!("frontend"));
            }
        }

        log::info!(
            "[BuiltinResourceExecutor] mindmap_edit_nodes delegated to frontend: id={}, ops={}",
            mindmap_id,
            operations.len()
        );

        Some(Ok(receipt))
    }

    /// 将 mindmap_edit_nodes 的单条 operation 转为冻结 AgentOp（DESIGN §2.3）
    fn mindmap_operation_to_agent_op(op: &Value) -> Value {
        let kind = op
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        let destructive = matches!(kind.as_str(), "delete_node" | "move_node");
        let label = Self::mindmap_op_label(op, &kind);

        // anchor：定位信息原样放入（node_id / parent_id / new_parent_id）
        let mut anchor = serde_json::Map::new();
        for key in ["node_id", "parent_id", "new_parent_id"] {
            if let Some(v) = op.get(key) {
                if !v.is_null() {
                    anchor.insert(key.to_string(), v.clone());
                }
            }
        }

        // payload：patch / data / index 等变更内容
        let mut payload = serde_json::Map::new();
        for key in ["patch", "data", "index"] {
            if let Some(v) = op.get(key) {
                if !v.is_null() {
                    payload.insert(key.to_string(), v.clone());
                }
            }
        }

        json!({
            "kind": kind,
            "anchor": if anchor.is_empty() { Value::Null } else { Value::Object(anchor) },
            "payload": Value::Object(payload),
            "destructive": destructive,
            "label": label,
        })
    }

    /// 生成中文步骤名（progress / done 列表用）
    fn mindmap_op_label(op: &Value, kind: &str) -> String {
        match kind {
            "add_node" => {
                let text = op
                    .get("data")
                    .and_then(|d| d.get("text"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("新节点");
                let short = safe_truncate_chars(text, 24);
                format!("添加节点「{}」", short)
            }
            "update_node" => {
                let id = op.get("node_id").and_then(|v| v.as_str()).unwrap_or("?");
                if let Some(text) = op
                    .get("patch")
                    .and_then(|p| p.get("text"))
                    .and_then(|v| v.as_str())
                {
                    let short = safe_truncate_chars(text, 24);
                    format!("更新节点「{}」", short)
                } else {
                    format!("更新节点 {}", id)
                }
            }
            "delete_node" => {
                let id = op.get("node_id").and_then(|v| v.as_str()).unwrap_or("?");
                format!("删除节点 {}", id)
            }
            "move_node" => {
                let id = op.get("node_id").and_then(|v| v.as_str()).unwrap_or("?");
                let parent = op
                    .get("new_parent_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("?");
                format!("移动节点 {} → {}", id, parent)
            }
            other => format!("导图操作 {}", other),
        }
    }

    /// 列出思维导图版本
    ///
    /// 用于让 LLM 在回复中引用不同版本的导图（`mv_*`），前端可渲染版本快照。
    async fn execute_mindmap_versions(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;

        let mindmap_id = call
            .arguments
            .get("mindmap_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'mindmap_id' parameter")?;

        // 限制返回数量，避免上下文膨胀
        let limit = call
            .arguments
            .get("limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_LIST_LIMIT as u64)
            .clamp(1, MAX_LIST_LIMIT) as usize;

        let versions = VfsMindMapRepo::get_versions(vfs_db, mindmap_id)
            .map_err(|e| format!("Failed to list mindmap versions: {}", e))?;

        let items: Vec<Value> = versions
            .iter()
            .take(limit)
            .map(|v| {
                let citation_title = format!("{}（{}）", v.title, v.created_at);
                json!({
                    "versionId": v.version_id,
                    "mindmapId": v.mindmap_id,
                    "title": v.title,
                    "label": v.label,
                    "source": v.source,
                    "createdAt": v.created_at,
                    "citation": format!("[思维导图:{}:{}]", v.version_id, citation_title),
                })
            })
            .collect();

        Ok(json!({
            "success": true,
            "mindmapId": mindmap_id,
            "count": items.len(),
            "versions": items,
        }))
    }

    /// 对比思维导图两个版本（或历史版本与当前版本）
    ///
    /// 用于提供结构化 diff 结果给 LLM，总结节点增删改移动。
    async fn execute_mindmap_diff_versions(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;

        let mindmap_id = call
            .arguments
            .get("mindmap_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'mindmap_id' parameter")?;

        if !mindmap_id.starts_with("mm_") {
            return Err(format!("Invalid mindmap_id: {}", mindmap_id));
        }

        let detail_limit = call
            .arguments
            .get("detail_limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(20)
            .clamp(1, 100) as usize;

        let from_version_id = call
            .arguments
            .get("from_version_id")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty());

        let to_version_id = call
            .arguments
            .get("to_version_id")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .unwrap_or("current");

        let versions = VfsMindMapRepo::get_versions(vfs_db, mindmap_id)
            .map_err(|e| format!("Failed to list mindmap versions: {}", e))?;

        let from_version = if let Some(version_id) = from_version_id {
            versions
                .iter()
                .find(|v| v.version_id == version_id)
                .cloned()
                .ok_or_else(|| format!("from_version_id not found: {}", version_id))?
        } else {
            versions.first().cloned().ok_or_else(|| {
                format!(
                    "No historical version found for {}. 请先进行一次更新再执行 diff。",
                    mindmap_id
                )
            })?
        };

        if from_version.mindmap_id != mindmap_id {
            return Err(format!(
                "Version {} does not belong to mindmap {}",
                from_version.version_id, mindmap_id
            ));
        }

        let from_content = VfsMindMapRepo::get_version_content(vfs_db, &from_version.version_id)
            .map_err(|e| format!("Failed to read from version content: {}", e))?
            .ok_or_else(|| format!("Version content not found: {}", from_version.version_id))?;
        let from_doc = Self::parse_mindmap_document(&from_content)?;

        let (to_ref, to_content) = if to_version_id.eq_ignore_ascii_case("current") {
            let current = VfsMindMapRepo::get_mindmap(vfs_db, mindmap_id)
                .map_err(|e| format!("Failed to read current mindmap metadata: {}", e))?
                .ok_or_else(|| format!("Mindmap not found: {}", mindmap_id))?;
            let current_content = VfsMindMapRepo::get_mindmap_content(vfs_db, mindmap_id)
                .map_err(|e| format!("Failed to read current mindmap content: {}", e))?
                .ok_or_else(|| format!("Current mindmap content not found: {}", mindmap_id))?;
            (
                json!({
                    "type": "current",
                    "mindmapId": mindmap_id,
                    "title": current.title,
                    "citation": format!("[思维导图:{}:{}]", mindmap_id, current.title),
                }),
                current_content,
            )
        } else if to_version_id.starts_with("mv_") {
            let to_version = VfsMindMapRepo::get_version(vfs_db, to_version_id)
                .map_err(|e| format!("Failed to read target version metadata: {}", e))?
                .ok_or_else(|| format!("to_version_id not found: {}", to_version_id))?;
            if to_version.mindmap_id != mindmap_id {
                return Err(format!(
                    "Version {} does not belong to mindmap {}",
                    to_version.version_id, mindmap_id
                ));
            }

            let to_version_content = VfsMindMapRepo::get_version_content(vfs_db, to_version_id)
                .map_err(|e| format!("Failed to read target version content: {}", e))?
                .ok_or_else(|| format!("Version content not found: {}", to_version_id))?;
            (
                json!({
                    "type": "version",
                    "versionId": to_version.version_id,
                    "mindmapId": to_version.mindmap_id,
                    "title": to_version.title,
                    "createdAt": to_version.created_at,
                    "citation": format!("[思维导图:{}:{}（{}）]", to_version.version_id, to_version.title, to_version.created_at),
                }),
                to_version_content,
            )
        } else {
            return Err(format!(
                "Invalid to_version_id: {}. Use mv_* or current.",
                to_version_id
            ));
        };

        let to_doc = Self::parse_mindmap_document(&to_content)?;

        let mut from_nodes = HashMap::new();
        let mut to_nodes = HashMap::new();
        Self::collect_mindmap_nodes(
            from_doc
                .get("root")
                .ok_or("from document missing root node")?,
            None,
            "root",
            &mut from_nodes,
        );
        Self::collect_mindmap_nodes(
            to_doc.get("root").ok_or("to document missing root node")?,
            None,
            "root",
            &mut to_nodes,
        );

        let mut added = Vec::new();
        let mut removed = Vec::new();
        let mut modified = Vec::new();
        let mut moved = Vec::new();

        for (id, to_node) in &to_nodes {
            match from_nodes.get(id) {
                None => added.push(to_node.clone()),
                Some(from_node) => {
                    if from_node.signature != to_node.signature {
                        modified.push(json!({
                            "id": id,
                            "before": { "text": from_node.text, "path": from_node.path },
                            "after": { "text": to_node.text, "path": to_node.path },
                        }));
                    }
                    if from_node.parent_id != to_node.parent_id {
                        moved.push(json!({
                            "id": id,
                            "text": to_node.text,
                            "beforeParentId": from_node.parent_id,
                            "afterParentId": to_node.parent_id,
                            "beforePath": from_node.path,
                            "afterPath": to_node.path,
                        }));
                    }
                }
            }
        }

        for (id, from_node) in &from_nodes {
            if !to_nodes.contains_key(id) {
                removed.push(from_node.clone());
            }
        }

        added.sort_by(|a, b| a.path.cmp(&b.path));
        removed.sort_by(|a, b| a.path.cmp(&b.path));
        modified.sort_by(|a, b| {
            a.get("id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .cmp(b.get("id").and_then(|v| v.as_str()).unwrap_or_default())
        });
        moved.sort_by(|a, b| {
            a.get("id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .cmp(b.get("id").and_then(|v| v.as_str()).unwrap_or_default())
        });

        let summary = json!({
            "fromNodeCount": from_nodes.len(),
            "toNodeCount": to_nodes.len(),
            "added": added.len(),
            "removed": removed.len(),
            "modified": modified.len(),
            "moved": moved.len(),
            "totalChanges": added.len() + removed.len() + modified.len() + moved.len(),
        });

        let from_ref = json!({
            "type": "version",
            "versionId": from_version.version_id,
            "mindmapId": from_version.mindmap_id,
            "title": from_version.title,
            "createdAt": from_version.created_at,
            "citation": format!("[思维导图:{}:{}（{}）]", from_version.version_id, from_version.title, from_version.created_at),
        });

        Ok(json!({
            "success": true,
            "mindmapId": mindmap_id,
            "from": from_ref,
            "to": to_ref,
            "summary": summary,
            "changes": {
                "added": added.iter().take(detail_limit).map(|n| json!({
                    "id": n.id,
                    "text": n.text,
                    "parentId": n.parent_id,
                    "path": n.path,
                })).collect::<Vec<Value>>(),
                "removed": removed.iter().take(detail_limit).map(|n| json!({
                    "id": n.id,
                    "text": n.text,
                    "parentId": n.parent_id,
                    "path": n.path,
                })).collect::<Vec<Value>>(),
                "modified": modified.iter().take(detail_limit).cloned().collect::<Vec<Value>>(),
                "moved": moved.iter().take(detail_limit).cloned().collect::<Vec<Value>>(),
            },
            "truncated": {
                "added": added.len() > detail_limit,
                "removed": removed.len() > detail_limit,
                "modified": modified.len() > detail_limit,
                "moved": moved.len() > detail_limit,
                "detailLimit": detail_limit,
            }
        }))
    }

    // ------------------------------------------------------------------------
    // 操作分发方法
    // ------------------------------------------------------------------------

    /// update_node: 修改节点属性
    fn op_update_node(doc: &mut Value, op: &Value) -> Result<(), String> {
        let node_id = op
            .get("node_id")
            .and_then(|v| v.as_str())
            .ok_or("update_node: missing 'node_id'")?;

        let patch = op.get("patch").ok_or("update_node: missing 'patch'")?;

        let root = doc.get_mut("root").ok_or("Document has no 'root' node")?;

        let node = Self::find_node_mut(root, node_id)
            .ok_or_else(|| format!("update_node: node '{}' not found", node_id))?;

        Self::apply_update_patch(node, patch);
        Ok(())
    }

    /// add_node: 在指定父节点下添加子节点
    fn op_add_node(doc: &mut Value, op: &Value) -> Result<(), String> {
        let parent_id = op
            .get("parent_id")
            .and_then(|v| v.as_str())
            .ok_or("add_node: missing 'parent_id'")?;

        let data = op.get("data").ok_or("add_node: missing 'data'")?;

        let mut new_node = data.clone();

        let index = op.get("index").and_then(|v| v.as_u64());

        let root = doc.get_mut("root").ok_or("Document has no 'root' node")?;

        // ★ A6-27：先收集文档现有 id，再为新子树分配全局唯一 id（消除重复 id）
        let mut existing_ids = std::collections::HashSet::new();
        Self::collect_node_ids(root, &mut existing_ids);
        Self::ensure_unique_subtree_ids(&mut new_node, &mut existing_ids);

        let parent = Self::find_node_mut(root, parent_id)
            .ok_or_else(|| format!("add_node: parent '{}' not found", parent_id))?;

        // 确保 parent 有 children 数组
        if parent.get("children").is_none() {
            parent["children"] = json!([]);
        }

        let children = parent["children"]
            .as_array_mut()
            .ok_or("add_node: parent 'children' is not an array")?;

        match index {
            Some(idx) => {
                let idx = idx as usize;
                if idx >= children.len() {
                    children.push(new_node);
                } else {
                    children.insert(idx, new_node);
                }
            }
            None => children.push(new_node),
        }

        Ok(())
    }

    /// delete_node: 删除节点（禁止删除根节点）
    fn op_delete_node(doc: &mut Value, op: &Value) -> Result<(), String> {
        let node_id = op
            .get("node_id")
            .and_then(|v| v.as_str())
            .ok_or("delete_node: missing 'node_id'")?;

        // 禁止删除根节点
        if let Some(root) = doc.get("root") {
            if root.get("id").and_then(|v| v.as_str()) == Some(node_id) {
                return Err("delete_node: cannot delete root node".to_string());
            }
        }

        let root = doc.get_mut("root").ok_or("Document has no 'root' node")?;

        Self::find_and_remove_child(root, node_id)
            .ok_or_else(|| format!("delete_node: node '{}' not found", node_id))?;

        Ok(())
    }

    /// move_node: 移动节点到新父节点下
    fn op_move_node(doc: &mut Value, op: &Value) -> Result<(), String> {
        let node_id = op
            .get("node_id")
            .and_then(|v| v.as_str())
            .ok_or("move_node: missing 'node_id'")?;

        let new_parent_id = op
            .get("new_parent_id")
            .and_then(|v| v.as_str())
            .ok_or("move_node: missing 'new_parent_id'")?;

        let index = op.get("index").and_then(|v| v.as_u64());

        // 禁止移动根节点
        if let Some(root) = doc.get("root") {
            if root.get("id").and_then(|v| v.as_str()) == Some(node_id) {
                return Err("move_node: cannot move root node".to_string());
            }
        }

        let root = doc.get_mut("root").ok_or("Document has no 'root' node")?;

        // ★ 修复：移除前完成全部校验，防止"先移除、后查找失败"导致子树永久丢失。
        // 之前若 new_parent 是被移节点自身或其后代，移除后 new_parent 随子树消失，
        // 节点无法插回且同批次其它成功操作仍会保存损坏的文档。
        {
            let root_ref: &Value = root;
            let moving = Self::find_node_ref(root_ref, node_id)
                .ok_or_else(|| format!("move_node: node '{}' not found", node_id))?;
            if node_id == new_parent_id || Self::contains_node_id(moving, new_parent_id) {
                return Err(format!(
                    "move_node: cannot move node '{}' into itself or its own descendant '{}'",
                    node_id, new_parent_id
                ));
            }
            if Self::find_node_ref(root_ref, new_parent_id).is_none() {
                return Err(format!(
                    "move_node: new parent '{}' not found",
                    new_parent_id
                ));
            }
        }

        // 校验通过后再从原位置移除
        let removed = Self::find_and_remove_child(root, node_id)
            .ok_or_else(|| format!("move_node: node '{}' not found", node_id))?;

        // 再插入到新父节点
        let new_parent = Self::find_node_mut(root, new_parent_id)
            .ok_or_else(|| format!("move_node: new parent '{}' not found", new_parent_id))?;

        if new_parent.get("children").is_none() {
            new_parent["children"] = json!([]);
        }

        let children = new_parent["children"]
            .as_array_mut()
            .ok_or("move_node: new parent 'children' is not an array")?;

        match index {
            Some(idx) => {
                let idx = idx as usize;
                if idx >= children.len() {
                    children.push(removed);
                } else {
                    children.insert(idx, removed);
                }
            }
            None => children.push(removed),
        }

        Ok(())
    }

    // ------------------------------------------------------------------------
    // 辅助方法
    // ------------------------------------------------------------------------

    /// 递归查找节点（可变引用）
    ///
    /// 使用两阶段查找绕过 borrow checker：先只读扫描确定路径，再沿路径取可变引用
    fn find_node_mut<'a>(node: &'a mut Value, target_id: &str) -> Option<&'a mut Value> {
        // 先只读判断：目标是否就是当前节点
        if node.get("id").and_then(|v| v.as_str()) == Some(target_id) {
            return Some(node);
        }

        // 只读扫描：找到目标所在的子节点索引
        let child_index = {
            if let Some(children) = node.get("children").and_then(|c| c.as_array()) {
                let mut found_idx: Option<usize> = None;
                for (i, child) in children.iter().enumerate() {
                    if Self::contains_node_id(child, target_id) {
                        found_idx = Some(i);
                        break;
                    }
                }
                found_idx
            } else {
                None
            }
        };

        // 沿确定的路径取可变引用递归
        if let Some(idx) = child_index {
            return Self::find_node_mut(&mut node["children"][idx], target_id);
        }

        None
    }

    /// 递归查找节点（只读引用），用于修改前的存在性/后代关系校验
    fn find_node_ref<'a>(node: &'a Value, target_id: &str) -> Option<&'a Value> {
        if node.get("id").and_then(|v| v.as_str()) == Some(target_id) {
            return Some(node);
        }
        if let Some(children) = node.get("children").and_then(|c| c.as_array()) {
            for child in children {
                if let Some(found) = Self::find_node_ref(child, target_id) {
                    return Some(found);
                }
            }
        }
        None
    }

    /// 只读检查：节点树中是否包含指定 id 的节点
    fn contains_node_id(node: &Value, target_id: &str) -> bool {
        if node.get("id").and_then(|v| v.as_str()) == Some(target_id) {
            return true;
        }
        if let Some(children) = node.get("children").and_then(|c| c.as_array()) {
            for child in children {
                if Self::contains_node_id(child, target_id) {
                    return true;
                }
            }
        }
        false
    }

    /// 递归查找并移除子节点，返回被移除的节点
    fn find_and_remove_child(node: &mut Value, target_id: &str) -> Option<Value> {
        // 在当前节点的 children 中查找
        if let Some(children) = node.get_mut("children").and_then(|c| c.as_array_mut()) {
            // 查找目标在 children 中的位置
            if let Some(pos) = children
                .iter()
                .position(|child| child.get("id").and_then(|v| v.as_str()) == Some(target_id))
            {
                return Some(children.remove(pos));
            }

            // 递归在子节点中查找
            for child in children.iter_mut() {
                if let Some(removed) = Self::find_and_remove_child(child, target_id) {
                    return Some(removed);
                }
            }
        }

        None
    }

    /// 将 patch 合并到节点上（style 字段深度合并）
    fn apply_update_patch(node: &mut Value, patch: &Value) {
        if let Some(patch_obj) = patch.as_object() {
            // ★ A6-27：对齐前端 updateNode 语义——patch 改了 text（且与现值不同）时
            // 自动清除旧 blankedRanges（挖空区间是字符索引，文本一变即失效，否则
            // 背诵模式遮挡错位）。若 patch 自身带了 blankedRanges 则以 patch 为准
            // （下方循环会写入），不清除。
            let text_changed = match patch_obj.get("text") {
                Some(new_text) => node.get("text") != Some(new_text),
                None => false,
            };
            let patch_has_blanked = patch_obj.contains_key("blankedRanges");
            for (key, value) in patch_obj {
                if key == "style" {
                    // style 字段：深度合并而非替换
                    if let Some(new_style_obj) = value.as_object() {
                        let existing_style =
                            node.get("style").cloned().unwrap_or_else(|| json!({}));

                        let mut merged = existing_style;
                        if let Some(merged_obj) = merged.as_object_mut() {
                            for (sk, sv) in new_style_obj {
                                if sv.is_null() {
                                    // null 值表示清除该属性
                                    merged_obj.remove(sk);
                                } else {
                                    merged_obj.insert(sk.clone(), sv.clone());
                                }
                            }
                        }
                        node["style"] = merged;
                    }
                } else {
                    // 其他字段：直接替换
                    node[key] = value.clone();
                }
            }
            if text_changed && !patch_has_blanked {
                if let Some(obj) = node.as_object_mut() {
                    obj.remove("blankedRanges");
                }
            }
        }
    }

    /// 收集子树内所有节点 id（含自身）到集合，用于 add_node 的去重。
    fn collect_node_ids(node: &Value, out: &mut std::collections::HashSet<String>) {
        if let Some(id) = node.get("id").and_then(|v| v.as_str()) {
            out.insert(id.to_string());
        }
        if let Some(children) = node.get("children").and_then(|c| c.as_array()) {
            for child in children {
                Self::collect_node_ids(child, out);
            }
        }
    }

    /// ★ A6-27：确保新子树每个节点都有 id 与 children 数组；id 缺失或与文档中既有
    /// id 冲突时重新生成（LLM 多轮编辑常复制旧节点 JSON 再 add，会带来重复 id，
    /// 破坏前端 findNodeById / React key 的唯一性假设）。`existing` 随新分配的 id
    /// 一起增长，避免新子树内部自冲突。
    fn ensure_unique_subtree_ids(
        node: &mut Value,
        existing: &mut std::collections::HashSet<String>,
    ) {
        let current = node
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let final_id = match current {
            Some(id) if !id.is_empty() && !existing.contains(&id) => id,
            _ => loop {
                let candidate = format!("n_{}", nanoid::nanoid!(8));
                if !existing.contains(&candidate) {
                    break candidate;
                }
            },
        };
        existing.insert(final_id.clone());
        node["id"] = json!(final_id);

        if node.get("children").is_none() {
            node["children"] = json!([]);
        }
        if let Some(children) = node.get("children").and_then(|c| c.as_array()) {
            let len = children.len();
            for i in 0..len {
                Self::ensure_unique_subtree_ids(&mut node["children"][i], existing);
            }
        }
    }
}

impl Default for BuiltinResourceExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for BuiltinResourceExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        let stripped = strip_tool_namespace(tool_name);
        matches!(
            stripped,
            "resource_list"
                | "resource_read"
                | "resource_search"
                | "folder_list"
                | "mindmap_create"
                | "mindmap_update"
                | "mindmap_delete"
                | "mindmap_edit_nodes"
                | "mindmap_versions"
                | "mindmap_diff_versions"
                | "mindmap_import"
        )
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start_time = Instant::now();
        let tool_name = strip_tool_namespace(&call.name);

        log::debug!(
            "[BuiltinResourceExecutor] Executing builtin tool: {} (full: {})",
            tool_name,
            call.name
        );

        // 🔧 修复：发射工具调用开始事件，让前端立即显示工具调用 UI
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let result = match tool_name {
            "resource_list" => self.execute_list(call, ctx).await,
            "resource_read" => self.execute_read(call, ctx).await,
            "resource_search" => self.execute_search(call, ctx).await,
            "folder_list" => self.execute_folder_list(call, ctx).await,
            "mindmap_create" => self.execute_mindmap_create(call, ctx).await,
            "mindmap_update" => self.execute_mindmap_update(call, ctx).await,
            "mindmap_delete" => self.execute_mindmap_delete(call, ctx).await,
            "mindmap_edit_nodes" => self.execute_mindmap_edit_nodes(call, ctx).await,
            "mindmap_versions" => self.execute_mindmap_versions(call, ctx).await,
            "mindmap_diff_versions" => self.execute_mindmap_diff_versions(call, ctx).await,
            "mindmap_import" => self.execute_mindmap_import(call, ctx).await,
            _ => Err(format!("Unknown builtin resource tool: {}", tool_name)),
        };

        let duration = start_time.elapsed().as_millis() as u64;

        match result {
            Ok(output) => {
                // 🔧 修复：发射工具调用结束事件
                ctx.emitter.emit_end_with_meta(
                    event_types::TOOL_CALL,
                    &ctx.block_id,
                    Some(json!({
                        "result": output,
                        "durationMs": duration,
                    })),
                    ctx.variant_id.as_deref(),
                    ctx.skill_state_version,
                    ctx.round_id.as_deref(),
                );

                let result = ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration,
                );

                // 🆕 SSOT: 后端立即保存工具块（防闪退）
                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[BuiltinResourceExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
            Err(e) => {
                // 🔧 修复：发射工具调用错误事件
                ctx.emitter.emit_error_with_meta(
                    event_types::TOOL_CALL,
                    &ctx.block_id,
                    &e,
                    ctx.variant_id.as_deref(),
                    ctx.skill_state_version,
                    ctx.round_id.as_deref(),
                );

                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    e,
                    duration,
                );

                // 🆕 SSOT: 后端立即保存工具块（防闪退）
                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[BuiltinResourceExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
        }
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        let stripped = strip_tool_namespace(tool_name);
        match stripped {
            // 删除操作是破坏性的，需要更高敏感度
            // mindmap_edit_nodes 可混入 delete_node/move_node；当前审批契约只按
            // 工具名分级，因此整个混合工具 fail-closed 提升到 High。
            "mindmap_delete" | "mindmap_edit_nodes" => ToolSensitivity::High,
            // ★ 2026-02-09: mindmap_update 降为 Low
            // 理由：用户主动让 AI 更新导图，且已有乐观并发控制（expected_updated_at）保护
            // ★ 2026-02-09: resource_read/resource_search 降为 Low
            // 理由：这些都是对用户自有数据的只读操作，不涉及修改/删除，
            // 且制卡流程会频繁调用搜索→读取→制卡链路，Medium 导致反复弹确认框体验极差
            "resource_read" | "resource_search" => ToolSensitivity::Low,
            // 其他操作是只读或创建/更新，低敏感
            _ => ToolSensitivity::Low,
        }
    }

    fn concurrency_class(&self, tool_name: &str) -> ToolConcurrency {
        let stripped = strip_tool_namespace(tool_name);
        match stripped {
            // 读类工具：纯只读 VFS 查询，可并行 + 自动重试
            "resource_list" | "resource_read" | "resource_search" | "folder_list" => {
                ToolConcurrency::ReadOnly
            }
            // mindmap_* 含创建/更新/删除等写操作，保持串行（默认）
            _ => ToolConcurrency::Serial,
        }
    }

    fn manages_cancellation(&self, tool_name: &str) -> bool {
        strip_tool_namespace(tool_name) == "mindmap_edit_nodes"
    }

    fn name(&self) -> &'static str {
        "BuiltinResourceExecutor"
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_can_handle() {
        let executor = BuiltinResourceExecutor::new();

        // 处理学习资源工具
        assert!(executor.can_handle("builtin-resource_list"));
        assert!(executor.can_handle("builtin-resource_read"));
        assert!(executor.can_handle("builtin-resource_search"));
        assert!(executor.can_handle("builtin-folder_list"));
        assert!(executor.can_handle("builtin-mindmap_create"));
        assert!(executor.can_handle("builtin-mindmap_update"));
        assert!(executor.can_handle("builtin-mindmap_delete"));
        assert!(executor.can_handle("builtin-mindmap_versions"));
        assert!(executor.can_handle("builtin-mindmap_diff_versions"));
        assert!(executor.can_handle("builtin-mindmap_import"));

        // 不处理其他 builtin 工具
        assert!(!executor.can_handle("builtin-rag_search"));
        assert!(!executor.can_handle("builtin-web_search"));

        // 不处理非 builtin 工具
        assert!(!executor.can_handle("note_read"));
        assert!(!executor.can_handle("mcp_brave_search"));
    }

    #[test]
    fn test_strip_namespace() {
        assert_eq!(
            strip_tool_namespace("builtin-resource_list"),
            "resource_list"
        );
        assert_eq!(
            strip_tool_namespace("builtin-resource_read"),
            "resource_read"
        );
        assert_eq!(strip_tool_namespace("resource_list"), "resource_list");
    }

    #[test]
    fn test_infer_type_from_id() {
        assert_eq!(
            BuiltinResourceExecutor::infer_type_from_id("note_abc123"),
            Some("notes")
        );
        assert_eq!(
            BuiltinResourceExecutor::infer_type_from_id("tb_xyz789"),
            Some("files")
        );
        assert_eq!(
            BuiltinResourceExecutor::infer_type_from_id("exam_test1"),
            Some("exams")
        );
        assert_eq!(
            BuiltinResourceExecutor::infer_type_from_id("essay_essay1"),
            Some("essays")
        );
        assert_eq!(
            BuiltinResourceExecutor::infer_type_from_id("essay_session_abc123"),
            Some("essays")
        );
        assert_eq!(
            BuiltinResourceExecutor::infer_type_from_id("tr_trans1"),
            Some("translations")
        );
        assert_eq!(
            BuiltinResourceExecutor::infer_type_from_id("unknown_id"),
            None
        );
    }

    #[test]
    fn test_parse_resource_type() {
        assert_eq!(
            BuiltinResourceExecutor::parse_resource_type("note"),
            Some(DstuNodeType::Note)
        );
        assert_eq!(
            BuiltinResourceExecutor::parse_resource_type("notes"),
            Some(DstuNodeType::Note)
        );
        assert_eq!(
            BuiltinResourceExecutor::parse_resource_type("textbook"),
            Some(DstuNodeType::Textbook)
        );
        assert_eq!(
            BuiltinResourceExecutor::parse_resource_type("exam"),
            Some(DstuNodeType::Exam)
        );
        assert_eq!(
            BuiltinResourceExecutor::parse_resource_type("file"),
            Some(DstuNodeType::File)
        );
        assert_eq!(
            BuiltinResourceExecutor::parse_resource_type("image"),
            Some(DstuNodeType::Image)
        );
        assert_eq!(
            BuiltinResourceExecutor::parse_resource_type("mindmap"),
            Some(DstuNodeType::MindMap)
        );
        assert_eq!(
            BuiltinResourceExecutor::parse_resource_type("unknown"),
            None
        );
    }

    #[test]
    fn test_is_supported_read_id() {
        assert!(BuiltinResourceExecutor::is_supported_read_id("note_abc"));
        assert!(BuiltinResourceExecutor::is_supported_read_id("tb_abc"));
        assert!(BuiltinResourceExecutor::is_supported_read_id("res_abc"));
        assert!(!BuiltinResourceExecutor::is_supported_read_id(
            "document.pdf"
        ));
    }

    #[test]
    fn test_sanitize_read_resource_id() {
        assert_eq!(
            BuiltinResourceExecutor::sanitize_read_resource_id("  `note_abc123`  "),
            "note_abc123"
        );
        assert_eq!(
            BuiltinResourceExecutor::sanitize_read_resource_id("ID: tb_123，读取它"),
            "tb_123"
        );
        assert_eq!(
            BuiltinResourceExecutor::sanitize_read_resource_id("res_456 (resource)"),
            "res_456"
        );
        assert_eq!(
            BuiltinResourceExecutor::sanitize_read_resource_id(
                "（readResourceId：res_789，请读取）"
            ),
            "res_789"
        );
        assert_eq!(
            BuiltinResourceExecutor::sanitize_read_resource_id("sourceId=exam_111。"),
            "exam_111"
        );
    }

    #[test]
    fn test_pick_resource_read_id_priority() {
        let args = json!({
            "resource_id": "",
            "readResourceId": " res_1 ",
            "sourceId": "note_2"
        });
        let picked = BuiltinResourceExecutor::pick_resource_read_id(&args).unwrap();
        assert_eq!(picked.0, "res_1");
        assert_eq!(picked.1, "readResourceId");

        let args2 = json!({
            "sourceId": "note_2",
            "resourceId": "res_2"
        });
        let picked2 = BuiltinResourceExecutor::pick_resource_read_id(&args2).unwrap();
        assert_eq!(picked2.0, "note_2");
        assert_eq!(picked2.1, "sourceId");
    }

    #[test]
    fn test_build_degradation_info_fallback() {
        let availability = ReadAvailability::default();
        let info = BuiltinResourceExecutor::build_degradation_info(
            "files",
            "[文档: sample.pdf]",
            &availability,
            None,
        );
        assert_eq!(info.level, "fallback");
        assert!(info
            .reason_codes
            .iter()
            .any(|c| c == "filename_placeholder"));
    }

    #[test]
    fn test_sensitivity_level() {
        let executor = BuiltinResourceExecutor::new();
        assert_eq!(
            executor.sensitivity_level("builtin-resource_list"),
            ToolSensitivity::Low
        );
        // ★ 2026-02-09: resource_search/resource_read 降为 Low（只读操作，制卡流畅体验）
        assert_eq!(
            executor.sensitivity_level("builtin-resource_search"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("builtin-resource_read"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("builtin-mindmap_delete"),
            ToolSensitivity::High
        );
        assert_eq!(
            executor.sensitivity_level("builtin-mindmap_edit_nodes"),
            ToolSensitivity::High
        );
        assert!(executor.manages_cancellation("builtin-mindmap_edit_nodes"));
        assert!(!executor.manages_cancellation("builtin-resource_read"));
    }

    /// ★ M-062: 验证 essay 节点的敏感字段被正确移除
    #[test]
    fn test_sanitize_essay_nodes_for_list() {
        // 构造一个 essay 类型节点，metadata 包含敏感字段
        let essay_node = DstuNode {
            id: "essay_001".to_string(),
            path: "/essay_001".to_string(),
            name: "测试作文".to_string(),
            node_type: DstuNodeType::Essay,
            size: None,
            created_at: 0,
            updated_at: 0,
            children: None,
            child_count: None,
            resource_id: None,
            source_id: "essay_001".to_string(),
            resource_hash: None,
            preview_type: None,
            metadata: Some(json!({
                "essayType": "narrative",
                "score": 85,
                "gradingResult": {"level": "A"},
                "latestScore": 90,
                "gradeLevel": "高中",
                "isFavorite": true,
            })),
        };

        // 构造一个 note 类型节点（不应被脱敏）
        let note_node = DstuNode {
            id: "note_001".to_string(),
            path: "/note_001".to_string(),
            name: "测试笔记".to_string(),
            node_type: DstuNodeType::Note,
            size: None,
            created_at: 0,
            updated_at: 0,
            children: None,
            child_count: None,
            resource_id: None,
            source_id: "note_001".to_string(),
            resource_hash: None,
            preview_type: None,
            metadata: Some(json!({
                "tags": ["math"],
                "isFavorite": false,
            })),
        };

        let mut nodes = vec![essay_node, note_node];
        BuiltinResourceExecutor::sanitize_essay_nodes_for_list(&mut nodes);

        // essay 节点：敏感字段已移除，非敏感字段保留
        let essay_meta = nodes[0].metadata.as_ref().unwrap();
        assert!(essay_meta.get("score").is_none(), "score should be removed");
        assert!(
            essay_meta.get("gradingResult").is_none(),
            "gradingResult should be removed"
        );
        assert!(
            essay_meta.get("latestScore").is_none(),
            "latestScore should be removed"
        );
        assert!(
            essay_meta.get("gradeLevel").is_none(),
            "gradeLevel should be removed"
        );
        assert_eq!(
            essay_meta.get("essayType").and_then(|v| v.as_str()),
            Some("narrative"),
            "essayType should be preserved"
        );
        assert_eq!(
            essay_meta.get("isFavorite").and_then(|v| v.as_bool()),
            Some(true),
            "isFavorite should be preserved"
        );

        // note 节点：完全不受影响
        let note_meta = nodes[1].metadata.as_ref().unwrap();
        assert!(
            note_meta.get("tags").is_some(),
            "note tags should be preserved"
        );
        assert_eq!(
            note_meta.get("isFavorite").and_then(|v| v.as_bool()),
            Some(false),
            "note isFavorite should be preserved"
        );
    }

    /// ACR R1-05：operations → AgentOp 转换形状（供 R1-11 对齐）
    #[test]
    fn mindmap_operation_to_agent_op_shapes() {
        let add = json!({
            "type": "add_node",
            "parent_id": "n1",
            "data": { "text": "新子节点" },
            "index": 0
        });
        let add_op = BuiltinResourceExecutor::mindmap_operation_to_agent_op(&add);
        assert_eq!(add_op["kind"], "add_node");
        assert_eq!(add_op["destructive"], false);
        assert_eq!(add_op["anchor"]["parent_id"], "n1");
        assert_eq!(add_op["payload"]["data"]["text"], "新子节点");
        assert_eq!(add_op["payload"]["index"], 0);
        assert!(add_op["label"].as_str().unwrap().contains("添加节点"));

        let update = json!({
            "type": "update_node",
            "node_id": "n2",
            "patch": { "text": "改名", "completed": true }
        });
        let update_op = BuiltinResourceExecutor::mindmap_operation_to_agent_op(&update);
        assert_eq!(update_op["kind"], "update_node");
        assert_eq!(update_op["destructive"], false);
        assert_eq!(update_op["anchor"]["node_id"], "n2");
        assert_eq!(update_op["payload"]["patch"]["text"], "改名");
        assert!(update_op["anchor"].get("parent_id").is_none());

        let delete = json!({
            "type": "delete_node",
            "node_id": "n3"
        });
        let delete_op = BuiltinResourceExecutor::mindmap_operation_to_agent_op(&delete);
        assert_eq!(delete_op["kind"], "delete_node");
        assert_eq!(delete_op["destructive"], true);
        assert_eq!(delete_op["anchor"]["node_id"], "n3");
        assert!(delete_op["payload"].as_object().unwrap().is_empty());

        let move_op_src = json!({
            "type": "move_node",
            "node_id": "n4",
            "new_parent_id": "n5",
            "index": 2
        });
        let move_op = BuiltinResourceExecutor::mindmap_operation_to_agent_op(&move_op_src);
        assert_eq!(move_op["kind"], "move_node");
        assert_eq!(move_op["destructive"], true);
        assert_eq!(move_op["anchor"]["node_id"], "n4");
        assert_eq!(move_op["anchor"]["new_parent_id"], "n5");
        assert_eq!(move_op["payload"]["index"], 2);
        assert!(move_op["label"].as_str().unwrap().contains("移动节点"));
    }

    #[test]
    fn mindmap_op_label_chinese() {
        let add = json!({ "type": "add_node", "data": { "text": "光合作用" } });
        assert_eq!(
            BuiltinResourceExecutor::mindmap_op_label(&add, "add_node"),
            "添加节点「光合作用」"
        );
        let del = json!({ "type": "delete_node", "node_id": "abc" });
        assert_eq!(
            BuiltinResourceExecutor::mindmap_op_label(&del, "delete_node"),
            "删除节点 abc"
        );
    }
}
