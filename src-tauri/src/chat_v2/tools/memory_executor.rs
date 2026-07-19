use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Emitter;

use super::arg_utils::with_localized_message;
use super::executor::{ExecutionContext, ToolConcurrency, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::memory::{MemoryOpSource, MemoryOpType, MemoryService, MemoryType, OpTimer, WriteMode};
use crate::vfs::error::VfsError;
use crate::vfs::lance_store::VfsLanceStore;

pub const MEMORY_SEARCH: &str = "builtin-memory_search";
pub const MEMORY_READ: &str = "builtin-memory_read";
pub const MEMORY_WRITE: &str = "builtin-memory_write";
pub const MEMORY_LIST: &str = "builtin-memory_list";
pub const MEMORY_UPDATE_BY_ID: &str = "builtin-memory_update_by_id";
pub const MEMORY_DELETE: &str = "builtin-memory_delete";
pub const MEMORY_WRITE_SMART: &str = "builtin-memory_write_smart";
pub const MEMORY_WRITE_BATCH: &str = "builtin-memory_write_batch";
pub const MEMORY_BATCH_MOVE: &str = "builtin-memory_batch_move";
pub const MEMORY_ADD_RELATION: &str = "builtin-memory_add_relation";
pub const MEMORY_REMOVE_RELATION: &str = "builtin-memory_remove_relation";
pub const MEMORY_UPDATE_TAGS: &str = "builtin-memory_update_tags";
pub const MEMORY_EXPORT_ALL: &str = "builtin-memory_export_all";
pub const LEARNER_PROFILE_GET: &str = "builtin-learner_profile_get";
pub const LEARNER_PROFILE_UPDATE: &str = "builtin-learner_profile_update";

const MEMORY_BATCH_LIMIT: usize = 20;
const MEMORY_LIST_PAGE_SIZE: usize = 20;
const MEMORY_EXPORT_PAGE_SIZE: usize = 20;
const MEMORY_EXPORT_CONTENT_CHARS: usize = 2_000;
const MEMORY_TAG_LIMIT: usize = 50;
const MEMORY_TAG_CHARS: usize = 200;
const MEMORY_FOLDER_PATH_CHARS: usize = 1_000;

pub struct MemoryToolExecutor;

impl Default for MemoryToolExecutor {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryToolExecutor {
    pub fn new() -> Self {
        Self
    }

    /// 检查工具名是否为 Memory 工具
    fn is_memory_tool(tool_name: &str) -> bool {
        let stripped = strip_tool_namespace(tool_name);
        matches!(
            stripped,
            "memory_search"
                | "memory_read"
                | "memory_write"
                | "memory_list"
                | "memory_update_by_id"
                | "memory_delete"
                | "memory_write_smart"
                | "memory_write_batch"
                | "memory_batch_move"
                | "memory_add_relation"
                | "memory_remove_relation"
                | "memory_update_tags"
                | "memory_export_all"
                | "learner_profile_get"
                | "learner_profile_update"
        )
    }

    fn needs_root_bootstrap(root_folder_id: Option<&str>) -> bool {
        root_folder_id.is_none()
    }

    fn parse_memory_type(
        raw: Option<&str>,
        default_type: MemoryType,
    ) -> Result<MemoryType, String> {
        match raw {
            Some("fact") => Ok(MemoryType::Fact),
            Some("study") => Ok(MemoryType::Study),
            Some("note") => Ok(MemoryType::Note),
            Some(other) => Err(format!(
                "Invalid memory_type '{}': expected fact, study, or note",
                other
            )),
            None => Ok(default_type),
        }
    }

    fn invalid_args(field: &str, zh_cn: impl Into<String>, en_us: impl Into<String>) -> String {
        with_localized_message(
            json!({
                "code": "MEMORY_INVALID_ARGS",
                "field": field,
                "retryable": false,
            }),
            "chat.tools.memory.invalid_args",
            json!({ "field": field }),
            zh_cn,
            en_us,
        )
        .to_string()
    }

    fn required_string(args: &Value, key: &str) -> Result<String, String> {
        args.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .ok_or_else(|| {
                Self::invalid_args(
                    key,
                    format!("缺少必需参数 {key}"),
                    format!("Required parameter {key} is missing."),
                )
            })
    }

    fn required_string_allow_empty(args: &Value, key: &str) -> Result<String, String> {
        args.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .map(str::to_string)
            .ok_or_else(|| {
                Self::invalid_args(
                    key,
                    format!("参数 {key} 必须是字符串"),
                    format!("Parameter {key} must be a string."),
                )
            })
    }

    fn parse_batch_move_args(args: &Value) -> Result<Vec<(String, String)>, String> {
        let values = args
            .get("note_ids")
            .or_else(|| args.get("noteIds"))
            .and_then(Value::as_array)
            .ok_or_else(|| {
                Self::invalid_args(
                    "note_ids",
                    "note_ids 必须是数组",
                    "note_ids must be an array.",
                )
            })?;
        if values.is_empty() || values.len() > MEMORY_BATCH_LIMIT {
            return Err(Self::invalid_args(
                "note_ids",
                format!("note_ids 必须包含 1 至 {MEMORY_BATCH_LIMIT} 个记忆 ID"),
                format!("note_ids must contain 1 to {MEMORY_BATCH_LIMIT} memory IDs."),
            ));
        }

        let mut seen = HashSet::with_capacity(values.len());
        let mut note_ids = Vec::with_capacity(values.len());
        for value in values {
            let note_id = value.as_str().map(str::trim).filter(|id| !id.is_empty());
            let Some(note_id) = note_id else {
                return Err(Self::invalid_args(
                    "note_ids",
                    "note_ids 只能包含非空字符串",
                    "note_ids may only contain non-empty strings.",
                ));
            };
            if !seen.insert(note_id.to_string()) {
                return Err(Self::invalid_args(
                    "note_ids",
                    format!("note_ids 包含重复 ID: {note_id}"),
                    format!("note_ids contains a duplicate ID: {note_id}."),
                ));
            }
            note_ids.push(note_id.to_string());
        }

        let version_map = args
            .get("expected_updated_at_by_id")
            .or_else(|| args.get("expectedUpdatedAtById"))
            .and_then(Value::as_object)
            .ok_or_else(|| {
                Self::invalid_args(
                    "expected_updated_at_by_id",
                    "批量移动前必须提供每条记忆的 expected_updated_at",
                    "Every memory must have an expected_updated_at before a batch move.",
                )
            })?;
        if version_map.len() != note_ids.len() {
            return Err(Self::invalid_args(
                "expected_updated_at_by_id",
                "版本映射必须与 note_ids 完全一致",
                "The version map must contain exactly the IDs in note_ids.",
            ));
        }

        note_ids
            .into_iter()
            .map(|note_id| {
                let version = version_map
                    .get(&note_id)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        Self::invalid_args(
                            "expected_updated_at_by_id",
                            format!("缺少 {note_id} 的 expected_updated_at"),
                            format!("expected_updated_at is missing for {note_id}."),
                        )
                    })?;
                Ok((note_id, version.to_string()))
            })
            .collect()
    }

    fn parse_tags(args: &Value) -> Result<Vec<String>, String> {
        let values = args.get("tags").and_then(Value::as_array).ok_or_else(|| {
            Self::invalid_args("tags", "tags 必须是数组", "tags must be an array.")
        })?;
        if values.len() > MEMORY_TAG_LIMIT {
            return Err(Self::invalid_args(
                "tags",
                format!("tags 最多允许 {MEMORY_TAG_LIMIT} 项"),
                format!("tags may contain at most {MEMORY_TAG_LIMIT} entries."),
            ));
        }
        let mut seen = HashSet::with_capacity(values.len());
        let mut tags = Vec::with_capacity(values.len());
        for value in values {
            let tag = value.as_str().map(str::trim).filter(|tag| !tag.is_empty());
            let Some(tag) = tag else {
                return Err(Self::invalid_args(
                    "tags",
                    "tags 只能包含非空字符串",
                    "tags may only contain non-empty strings.",
                ));
            };
            if tag.chars().count() > MEMORY_TAG_CHARS {
                return Err(Self::invalid_args(
                    "tags",
                    format!("单个标签最多允许 {MEMORY_TAG_CHARS} 个字符"),
                    format!("Each tag may contain at most {MEMORY_TAG_CHARS} characters."),
                ));
            }
            if seen.insert(tag.to_string()) {
                tags.push(tag.to_string());
            }
        }
        Ok(tags)
    }

    fn export_pagination(args: &Value) -> Result<(u32, u32, u32), String> {
        let page = args.get("page").and_then(Value::as_u64).unwrap_or(1);
        let page_size = args
            .get("page_size")
            .or_else(|| args.get("pageSize"))
            .and_then(Value::as_u64)
            .unwrap_or(MEMORY_EXPORT_PAGE_SIZE as u64);
        if page == 0 || !(1..=MEMORY_EXPORT_PAGE_SIZE as u64).contains(&page_size) {
            return Err(Self::invalid_args(
                "page",
                format!("page 必须从 1 开始，page_size 必须在 1 至 {MEMORY_EXPORT_PAGE_SIZE} 之间"),
                format!(
                    "page must start at 1 and page_size must be between 1 and {MEMORY_EXPORT_PAGE_SIZE}."
                ),
            ));
        }
        let page = u32::try_from(page)
            .map_err(|_| Self::invalid_args("page", "page 超出范围", "page is out of range."))?;
        let page_size = u32::try_from(page_size).map_err(|_| {
            Self::invalid_args(
                "page_size",
                "page_size 超出范围",
                "page_size is out of range.",
            )
        })?;
        let offset = page
            .checked_sub(1)
            .and_then(|value| value.checked_mul(page_size))
            .ok_or_else(|| {
                Self::invalid_args("page", "分页参数超出范围", "Pagination is out of range.")
            })?;
        Ok((page, page_size, offset))
    }

    fn list_pagination(args: &Value) -> Result<(u32, u32), String> {
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(MEMORY_LIST_PAGE_SIZE as u64);
        if !(1..=MEMORY_LIST_PAGE_SIZE as u64).contains(&limit) {
            return Err(Self::invalid_args(
                "limit",
                format!("limit 必须在 1 至 {MEMORY_LIST_PAGE_SIZE} 之间"),
                format!("limit must be between 1 and {MEMORY_LIST_PAGE_SIZE}."),
            ));
        }
        let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0);
        let limit = u32::try_from(limit)
            .map_err(|_| Self::invalid_args("limit", "limit 超出范围", "limit is out of range."))?;
        let offset = u32::try_from(offset).map_err(|_| {
            Self::invalid_args("offset", "offset 超出范围", "offset is out of range.")
        })?;
        Ok((limit, offset))
    }

    fn truncate_export_content(content: &str) -> (String, bool) {
        let mut chars = content.chars();
        let bounded = chars
            .by_ref()
            .take(MEMORY_EXPORT_CONTENT_CHARS)
            .collect::<String>();
        (bounded, chars.next().is_some())
    }

    fn export_page(
        service: &MemoryService,
        page_size: u32,
        offset: u32,
    ) -> Result<(Vec<Value>, bool), VfsError> {
        let mut listed = service.list(None, page_size + 1, offset)?;
        let has_more = listed.len() > page_size as usize;
        if has_more {
            listed.pop();
        }
        let mut items = Vec::with_capacity(listed.len());
        for item in listed {
            let Some((note, content)) = service.read(&item.id)? else {
                continue;
            };
            let (content, content_truncated) = Self::truncate_export_content(&content);
            items.push(json!({
                "note_id": note.id,
                "title": note.title,
                "content": content,
                "content_truncated": content_truncated,
                "folder_path": service.get_note_relative_folder_path(&note.id)?,
                "tags": note.tags,
                "memory_type": item.memory_type,
                "memory_purpose": item.memory_purpose,
                "updated_at": note.updated_at,
            }));
        }
        Ok((items, has_more))
    }

    fn current_note_state(service: &MemoryService, note_id: &str) -> Value {
        match service.read(note_id) {
            Ok(Some((note, content))) => {
                let (content, content_truncated) = Self::truncate_export_content(&content);
                let folder_path = service
                    .get_note_relative_folder_path(note_id)
                    .unwrap_or_default();
                json!({
                    "note_id": note.id,
                    "title": note.title,
                    "content": content,
                    "content_truncated": content_truncated,
                    "folder_path": folder_path,
                    "tags": note.tags,
                    "updated_at": note.updated_at,
                })
            }
            _ => Value::Null,
        }
    }

    fn service_error(
        service: &MemoryService,
        action: &str,
        note_ids: &[String],
        error: VfsError,
    ) -> String {
        let current: Vec<Value> = note_ids
            .iter()
            .map(|note_id| Self::current_note_state(service, note_id))
            .collect();
        match error {
            VfsError::Conflict { .. } => with_localized_message(
                json!({
                    "code": "MEMORY_CONFLICT",
                    "action": action,
                    "current": current,
                    "retryable": false,
                    "hint": "重新读取记忆并使用返回的 updated_at；不要盲目重试 / Read the memories again and use their returned updated_at values; do not retry blindly.",
                }),
                "chat.tools.memory.conflict",
                json!({ "action": action }),
                "记忆已被其他操作更新，请读取当前值后再重试",
                "The memory changed elsewhere. Read its current value before retrying.",
            )
            .to_string(),
            VfsError::NotFound { .. } => with_localized_message(
                json!({
                    "code": "MEMORY_NOT_FOUND",
                    "action": action,
                    "current": current,
                    "retryable": false,
                }),
                "chat.tools.memory.not_found",
                json!({ "action": action }),
                "未找到指定记忆，或该笔记不在记忆根目录内",
                "The requested memory was not found or is outside the memory root.",
            )
            .to_string(),
            other => with_localized_message(
                json!({
                    "code": "MEMORY_OPERATION_FAILED",
                    "action": action,
                    "details": other.to_string(),
                    "retryable": false,
                }),
                "chat.tools.memory.operation_failed",
                json!({ "action": action }),
                "记忆操作失败",
                "The memory operation failed.",
            )
            .to_string(),
        }
    }

    fn emit_memory_changed(ctx: &ExecutionContext, action: &str, note_ids: &[String]) {
        let payload = json!({
            "source": "ai",
            "action": action,
            "entityIds": note_ids,
            "runId": ctx.run_id(),
        });
        if let Err(error) = ctx.window_ref().emit("memory://changed", payload) {
            log::debug!(
                "[MemoryToolExecutor] Failed to emit memory://changed: {}",
                error
            );
        }
    }

    fn get_service(&self, ctx: &ExecutionContext) -> Result<MemoryService, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let llm_manager = ctx
            .llm_manager
            .as_ref()
            .ok_or("LLM manager not available")?;

        let lance_store = ctx
            .vfs_lance_store
            .clone()
            .map(Ok)
            .unwrap_or_else(|| VfsLanceStore::new(vfs_db.clone()).map(Arc::new))
            .map_err(|e| format!("Failed to create lance store: {}", e))?;

        Ok(MemoryService::new(
            vfs_db.clone(),
            lance_store,
            llm_manager.clone(),
        ))
    }

    fn ensure_root_configured(&self, service: &MemoryService) -> Result<(), Value> {
        let config = service.get_config().map_err(|e| {
            json!({
                "error": "记忆功能配置读取失败",
                "details": e.to_string()
            })
        })?;

        if Self::needs_root_bootstrap(config.memory_root_folder_id.as_deref()) {
            let folder_id = service.get_or_create_root_folder().map_err(|e| {
                json!({
                    "error": "记忆根文件夹初始化失败",
                    "hint": "请前往「学习资源中心 > 记忆管理」手动设置记忆根文件夹，或前往数据治理进行修复",
                    "details": e.to_string(),
                    "action_required": true
                })
            })?;
            log::info!(
                "[MemoryToolExecutor] Auto-created memory root folder for first use: {}",
                folder_id
            );
        }
        Ok(())
    }

    async fn execute_search(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        // 🆕 取消检查：在执行前检查是否已取消
        if ctx.is_cancelled() {
            return Err("Memory search cancelled before start".to_string());
        }

        let service = self.get_service(ctx)?;

        if let Err(hint) = self.ensure_root_configured(&service) {
            return Ok(hint);
        }

        let query = call
            .arguments
            .get("query")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'query' parameter")?;

        let top_k = call
            .arguments
            .get("top_k")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize)
            .unwrap_or(5);

        let results = if let Some(cancel_token) = ctx.cancellation_token() {
            tokio::select! {
                res = service.search_with_rerank(query, top_k, false) => res.map_err(|e| e.to_string())?,
                _ = cancel_token.cancelled() => {
                    log::info!("[MemoryToolExecutor] Memory search cancelled");
                    return Err("Memory search cancelled during execution".to_string());
                }
            }
        } else {
            service
                .search_with_rerank(query, top_k, false)
                .await
                .map_err(|e| e.to_string())?
        };

        // 兼容检索块与来源面板：输出统一的 sources 结构，
        // 同时保留 results 字段给旧调用方。
        let sources: Vec<Value> = results
            .iter()
            .map(|item| {
                json!({
                    "title": item.note_title,
                    "snippet": item.chunk_text,
                    "score": item.score,
                    "metadata": {
                        "document_id": item.note_id,
                        "memory_id": item.note_id,
                        "note_id": item.note_id,
                        "folder_path": item.folder_path,
                        "source_type": "memory"
                    }
                })
            })
            .collect();

        Ok(json!({
            "sources": sources,
            "results": results,
            "count": results.len()
        }))
    }

    async fn execute_read(&self, call: &ToolCall, ctx: &ExecutionContext) -> Result<Value, String> {
        // 🆕 取消检查：在执行前检查是否已取消
        if ctx.is_cancelled() {
            return Err("Memory read cancelled before start".to_string());
        }

        let service = self.get_service(ctx)?;

        if let Err(hint) = self.ensure_root_configured(&service) {
            return Ok(hint);
        }

        let note_id = call
            .arguments
            .get("note_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'note_id' parameter")?;

        let note_id_owned = note_id.to_string();

        // 🆕 取消支持：使用 spawn_blocking + tokio::select! 监听取消信号
        let read_task = {
            let service = service.clone();
            tokio::task::spawn_blocking(move || service.read(&note_id_owned))
        };

        let result = if let Some(cancel_token) = ctx.cancellation_token() {
            tokio::select! {
                res = read_task => res.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?,
                _ = cancel_token.cancelled() => {
                    log::info!("[MemoryToolExecutor] Memory read cancelled");
                    return Err("Memory read cancelled during execution".to_string());
                }
            }
        } else {
            read_task
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?
        };

        match result {
            Some((note, content)) => {
                let folder_path = service
                    .get_note_relative_folder_path(&note.id)
                    .map_err(|error| error.to_string())?;
                let related_note_ids: Vec<String> = note
                    .tags
                    .iter()
                    .filter_map(|tag| tag.strip_prefix("_ref:").map(str::to_string))
                    .collect();
                Ok(json!({
                    "found": true,
                    "note_id": note.id,
                    "title": note.title,
                    "content": content,
                    "folder_path": folder_path,
                    "tags": note.tags,
                    "related_note_ids": related_note_ids,
                    "updated_at": note.updated_at
                }))
            }
            None => Ok(json!({
                "found": false,
                "note_id": note_id
            })),
        }
    }

    async fn execute_write(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        if ctx.is_cancelled() {
            return Err("Memory write cancelled before start".to_string());
        }

        let service = self.get_service(ctx)?;

        if let Err(hint) = self.ensure_root_configured(&service) {
            return Ok(hint);
        }

        let note_id = call
            .arguments
            .get("note_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let title = call
            .arguments
            .get("title")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let content = call
            .arguments
            .get("content")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let folder = call
            .arguments
            .get("folder")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        // ★ 修复不一致：工具路径也需要敏感信息过滤
        if let Some(ref c) = content {
            if crate::memory::auto_extractor::MemoryAutoExtractor::contains_sensitive_pattern_pub(c)
            {
                service.audit_logger().log_filtered(
                    MemoryOpSource::ToolCall,
                    title.as_deref().unwrap_or(""),
                    c,
                    "包含敏感信息（手机号/身份证/银行卡/邮箱/密码）",
                );
                return Ok(json!({
                    "success": false,
                    "error": "内容包含敏感信息，已拦截。请勿在记忆中存储个人敏感信息。"
                }));
            }
        }
        if let Some(ref t) = title {
            if crate::memory::auto_extractor::MemoryAutoExtractor::contains_sensitive_pattern_pub(t)
            {
                service.audit_logger().log_filtered(
                    MemoryOpSource::ToolCall,
                    t,
                    content.as_deref().unwrap_or(""),
                    "标题包含敏感信息",
                );
                return Ok(json!({
                    "success": false,
                    "error": "标题包含敏感信息，已拦截。"
                }));
            }
        }

        let mode_str = call
            .arguments
            .get("mode")
            .and_then(|v| v.as_str())
            .unwrap_or(if note_id.is_some() {
                "update"
            } else {
                "create"
            });

        let mode = WriteMode::from_str(mode_str);
        let timer = OpTimer::start();

        let write_task = {
            let service = service.clone();
            let note_id = note_id.clone();
            let title = title.clone();
            let content = content.clone();
            let folder = folder.clone();
            tokio::task::spawn_blocking(move || -> Result<_, String> {
                if let Some(ref note_id) = note_id {
                    match mode {
                        WriteMode::Append => {
                            let current = service
                                .read(note_id)
                                .map_err(|e| e.to_string())?
                                .map(|(_, c)| c)
                                .unwrap_or_default();
                            let append_content =
                                content.as_ref().ok_or("Missing 'content' parameter")?;
                            let final_content = format!("{}\n\n{}", current, append_content);
                            service
                                .update_by_id_with_source(
                                    note_id,
                                    title.as_deref(),
                                    Some(&final_content),
                                    MemoryOpSource::ToolCall,
                                    None,
                                )
                                .map_err(|e| e.to_string())
                        }
                        _ => {
                            if title.is_none() && content.is_none() {
                                return Err("Missing 'title' or 'content' parameter".to_string());
                            }
                            service
                                .update_by_id_with_source(
                                    note_id,
                                    title.as_deref(),
                                    content.as_deref(),
                                    MemoryOpSource::ToolCall,
                                    None,
                                )
                                .map_err(|e| e.to_string())
                        }
                    }
                } else {
                    let title = title.as_ref().ok_or("Missing 'title' parameter")?;
                    let content = content.as_ref().ok_or("Missing 'content' parameter")?;
                    service
                        .write(folder.as_deref(), title, content, mode)
                        .map_err(|e| e.to_string())
                }
            })
        };

        let result = if let Some(cancel_token) = ctx.cancellation_token() {
            tokio::select! {
                res = write_task => res.map_err(|e| e.to_string())??,
                _ = cancel_token.cancelled() => {
                    log::info!("[MemoryToolExecutor] Memory write cancelled");
                    return Err("Memory write cancelled during execution".to_string());
                }
            }
        } else {
            write_task.await.map_err(|e| e.to_string())??
        };

        if note_id.is_none() {
            service
                .audit_logger()
                .log(&crate::memory::audit_log::MemoryAuditEntry {
                    source: MemoryOpSource::ToolCall,
                    operation: MemoryOpType::Write,
                    success: true,
                    note_id: Some(result.note_id.clone()),
                    title: title.clone(),
                    content_preview: content.clone(),
                    folder: folder.clone(),
                    event: Some(if result.is_new { "ADD" } else { "UPDATE" }.to_string()),
                    confidence: None,
                    reason: None,
                    session_id: None,
                    duration_ms: Some(timer.elapsed_ms()),
                    extra_json: None,
                });
        }

        let svc_for_idx = self.get_service(ctx).ok();
        if let Some(svc) = svc_for_idx {
            let resource_id = result.resource_id.clone();
            tokio::spawn(async move {
                svc.index_resource_immediately(&resource_id).await;
            });
        }
        service.spawn_post_write_maintenance();

        Ok(json!({
            "success": true,
            "note_id": result.note_id,
            "is_new": result.is_new
        }))
    }

    async fn execute_list(&self, call: &ToolCall, ctx: &ExecutionContext) -> Result<Value, String> {
        // 🆕 取消检查：在执行前检查是否已取消
        if ctx.is_cancelled() {
            return Err("Memory list cancelled before start".to_string());
        }

        let service = self.get_service(ctx)?;

        if let Err(hint) = self.ensure_root_configured(&service) {
            return Ok(hint);
        }

        let folder = call
            .arguments
            .get("folder")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let (limit, offset) = Self::list_pagination(&call.arguments)?;
        let probe_limit = limit.saturating_add(1);

        // 🆕 取消支持：使用 spawn_blocking + tokio::select! 监听取消信号
        let list_task = {
            let service = service.clone();
            tokio::task::spawn_blocking(move || {
                service.list(folder.as_deref(), probe_limit, offset)
            })
        };

        let mut items = if let Some(cancel_token) = ctx.cancellation_token() {
            tokio::select! {
                res = list_task => res.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?,
                _ = cancel_token.cancelled() => {
                    log::info!("[MemoryToolExecutor] Memory list cancelled");
                    return Err("Memory list cancelled during execution".to_string());
                }
            }
        } else {
            list_task
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?
        };
        let has_more = items.len() > limit as usize;
        if has_more {
            items.truncate(limit as usize);
        }
        let count = items.len();
        let next_offset = has_more.then(|| offset.saturating_add(count as u32));

        Ok(json!({
            "items": items,
            "count": count,
            "limit": limit,
            "offset": offset,
            "has_more": has_more,
            "next_offset": next_offset,
        }))
    }

    async fn execute_update_by_id(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        // 🆕 取消检查：在执行前检查是否已取消
        if ctx.is_cancelled() {
            return Err("Memory update cancelled before start".to_string());
        }

        let service = self.get_service(ctx)?;

        if let Err(hint) = self.ensure_root_configured(&service) {
            return Ok(hint);
        }

        let note_id = call
            .arguments
            .get("note_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'note_id' parameter")?
            .to_string();
        let title = call
            .arguments
            .get("title")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let content = call
            .arguments
            .get("content")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        if title.is_none() && content.is_none() {
            return Err("Missing 'title' or 'content' parameter".to_string());
        }

        // 🆕 取消支持：使用 spawn_blocking + tokio::select! 监听取消信号
        let update_task = {
            let service = service.clone();
            tokio::task::spawn_blocking(move || {
                service.update_by_id_with_source(
                    &note_id,
                    title.as_deref(),
                    content.as_deref(),
                    MemoryOpSource::ToolCall,
                    None,
                )
            })
        };

        let result = if let Some(cancel_token) = ctx.cancellation_token() {
            tokio::select! {
                res = update_task => res.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?,
                _ = cancel_token.cancelled() => {
                    log::info!("[MemoryToolExecutor] Memory update cancelled");
                    return Err("Memory update cancelled during execution".to_string());
                }
            }
        } else {
            update_task
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?
        };

        // 更新后即时索引，保证 write-then-search SLA（与 handler 路径对齐）
        let svc_for_idx = self.get_service(ctx).ok();
        if let Some(svc) = svc_for_idx {
            let resource_id = result.resource_id.clone();
            tokio::spawn(async move {
                svc.index_resource_immediately(&resource_id).await;
            });
        }
        service.spawn_post_write_maintenance();

        Ok(json!({
            "success": true,
            "note_id": result.note_id,
            "is_new": result.is_new
        }))
    }

    async fn execute_delete(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        // 🆕 取消检查：在执行前检查是否已取消
        if ctx.is_cancelled() {
            return Err("Memory delete cancelled before start".to_string());
        }

        let service = self.get_service(ctx)?;

        if let Err(hint) = self.ensure_root_configured(&service) {
            return Ok(hint);
        }

        let note_id = call
            .arguments
            .get("note_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'note_id' parameter")?;

        // 🆕 取消支持：使用 tokio::select! 监听取消信号
        if let Some(cancel_token) = ctx.cancellation_token() {
            tokio::select! {
                res = service.delete_with_source(note_id, MemoryOpSource::ToolCall, None) => res.map_err(|e| e.to_string())?,
                _ = cancel_token.cancelled() => {
                    log::info!("[MemoryToolExecutor] Memory delete cancelled");
                    return Err("Memory delete cancelled during execution".to_string());
                }
            }
        } else {
            service
                .delete_with_source(note_id, MemoryOpSource::ToolCall, None)
                .await
                .map_err(|e| e.to_string())?
        };
        service.spawn_post_write_maintenance();
        Ok(json!({ "success": true, "note_id": note_id }))
    }

    async fn execute_write_smart(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        if ctx.is_cancelled() {
            return Err("Memory write_smart cancelled before start".to_string());
        }

        let service = self.get_service(ctx)?;

        if let Err(hint) = self.ensure_root_configured(&service) {
            return Ok(hint);
        }

        let title = call
            .arguments
            .get("title")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'title' parameter")?;
        let content = call
            .arguments
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'content' parameter")?;
        let folder = call.arguments.get("folder").and_then(|v| v.as_str());
        let memory_type = Self::parse_memory_type(
            call.arguments.get("memory_type").and_then(|v| v.as_str()),
            MemoryType::Fact,
        )?;
        let memory_purpose = call
            .arguments
            .get("memory_purpose")
            .and_then(|v| v.as_str())
            .map(crate::memory::MemoryPurpose::from_str);

        // 敏感信息过滤（所有类型都检查）
        if crate::memory::auto_extractor::MemoryAutoExtractor::contains_sensitive_pattern_pub(
            content,
        ) || crate::memory::auto_extractor::MemoryAutoExtractor::contains_sensitive_pattern_pub(
            title,
        ) {
            service.audit_logger().log_filtered(
                MemoryOpSource::ToolCall,
                title,
                content,
                "包含敏感信息（手机号/身份证/银行卡/邮箱/密码）",
            );
            return Ok(json!({
                "note_id": "",
                "event": "FILTERED",
                "is_new": false,
                "confidence": 1.0,
                "reason": "内容包含敏感信息（手机号/身份证/银行卡/邮箱/密码），已拦截。请勿在记忆中存储个人敏感信息。",
                "downgraded": false
            }));
        }

        // 内容长度限制（按类型区分）
        let max_chars = memory_type.max_content_chars();
        if content.chars().count() > max_chars {
            service.audit_logger().log_filtered(
                MemoryOpSource::ToolCall,
                title,
                content,
                &format!(
                    "内容超过 {} 字限制（类型: {}）",
                    max_chars,
                    memory_type.as_str()
                ),
            );
            let hint = match memory_type {
                MemoryType::Fact => format!(
                    "原子事实记忆内容过长（超过 {} 字）。请拆分为多条简短事实，或使用 memory_type='study' / 'note'。",
                    max_chars
                ),
                MemoryType::Study => {
                    format!("学习记忆内容过长（超过 {} 字）。请精简或拆分为多条。", max_chars)
                }
                MemoryType::Note => {
                    format!("经验笔记内容过长（超过 {} 字）。请精简内容。", max_chars)
                }
            };
            return Ok(json!({
                "note_id": "",
                "event": "FILTERED",
                "is_new": false,
                "confidence": 1.0,
                "reason": hint,
                "downgraded": false
            }));
        }

        let result = if let Some(cancel_token) = ctx.cancellation_token() {
            let idempotency_key = Self::resolve_idempotency_key(
                call,
                &ctx.session_id,
                &ctx.message_id,
                folder,
                title,
                content,
                memory_type,
                memory_purpose,
            );
            tokio::select! {
                res = service.write_smart_with_source(
                    folder,
                    title,
                    content,
                    MemoryOpSource::ToolCall,
                    Some(&ctx.session_id),
                    memory_type,
                    memory_purpose,
                    Some(idempotency_key.as_str()),
                ) => res.map_err(|e| e.to_string())?,
                _ = cancel_token.cancelled() => {
                    log::info!("[MemoryToolExecutor] Memory write_smart cancelled");
                    return Err("Memory write_smart cancelled during execution".to_string());
                }
            }
        } else {
            let idempotency_key = Self::resolve_idempotency_key(
                call,
                &ctx.session_id,
                &ctx.message_id,
                folder,
                title,
                content,
                memory_type,
                memory_purpose,
            );
            service
                .write_smart_with_source(
                    folder,
                    title,
                    content,
                    MemoryOpSource::ToolCall,
                    Some(&ctx.session_id),
                    memory_type,
                    memory_purpose,
                    Some(idempotency_key.as_str()),
                )
                .await
                .map_err(|e| e.to_string())?
        };

        if result.event != "NONE" && result.event != "FILTERED" {
            service.spawn_post_write_maintenance();
        }

        Ok(json!({
            "note_id": result.note_id,
            "event": result.event,
            "is_new": result.is_new,
            "confidence": result.confidence,
            "reason": result.reason,
            "downgraded": result.downgraded
        }))
    }

    async fn execute_write_batch(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        if ctx.is_cancelled() {
            return Err("Memory write_batch cancelled before start".to_string());
        }

        let service = self.get_service(ctx)?;
        if let Err(hint) = self.ensure_root_configured(&service) {
            return Ok(hint);
        }

        let items = call
            .arguments
            .get("items")
            .and_then(|v| v.as_array())
            .ok_or("Missing 'items' parameter")?;
        let default_folder = call.arguments.get("folder").and_then(|v| v.as_str());
        let default_memory_type = Self::parse_memory_type(
            call.arguments.get("memory_type").and_then(|v| v.as_str()),
            MemoryType::Study,
        )?;
        let default_memory_purpose = call
            .arguments
            .get("memory_purpose")
            .and_then(|v| v.as_str())
            .map(crate::memory::MemoryPurpose::from_str);

        let mut added = 0usize;
        let mut updated = 0usize;
        let mut skipped = 0usize;
        let mut filtered = 0usize;
        let mut results = Vec::with_capacity(items.len());
        let mut resource_ids = Vec::new();

        for (index, item) in items.iter().enumerate() {
            let title = item
                .get("title")
                .and_then(|v| v.as_str())
                .ok_or("Each batch item requires 'title'")?;
            let content = item
                .get("content")
                .and_then(|v| v.as_str())
                .ok_or("Each batch item requires 'content'")?;
            let folder = item
                .get("folder")
                .or_else(|| item.get("folder_path"))
                .and_then(|v| v.as_str())
                .or(default_folder);
            let memory_type = Self::parse_memory_type(
                item.get("memory_type").and_then(|v| v.as_str()),
                default_memory_type,
            )?;
            let memory_purpose = item
                .get("memory_purpose")
                .and_then(|v| v.as_str())
                .map(crate::memory::MemoryPurpose::from_str)
                .or(default_memory_purpose);
            let idempotency_key = item
                .get("idempotency_key")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| {
                    format!(
                        "{}:{}:{}",
                        ctx.message_id,
                        index,
                        Self::resolve_idempotency_key(
                            call,
                            &ctx.session_id,
                            &ctx.message_id,
                            folder,
                            title,
                            content,
                            memory_type,
                            memory_purpose,
                        )
                    )
                });

            let output = match memory_type {
                MemoryType::Fact => service
                    .write_smart_with_source(
                        folder,
                        title,
                        content,
                        MemoryOpSource::ToolCall,
                        Some(&ctx.session_id),
                        memory_type,
                        memory_purpose,
                        Some(idempotency_key.as_str()),
                    )
                    .await
                    .map_err(|e| e.to_string())?,
                _ => service
                    .write_explicit_memory(folder, title, content, memory_type, memory_purpose)
                    .map_err(|e| e.to_string())?,
            };

            match output.event.as_str() {
                "ADD" => added += 1,
                "UPDATE" | "APPEND" | "DELETE" => updated += 1,
                "FILTERED" => filtered += 1,
                _ => skipped += 1,
            }
            if let Some(resource_id) = &output.resource_id {
                resource_ids.push(resource_id.clone());
            }
            results.push(json!({
                "title": title,
                "note_id": output.note_id,
                "event": output.event,
                "is_new": output.is_new,
                "confidence": output.confidence,
                "reason": output.reason,
                "downgraded": output.downgraded,
            }));
        }

        if added + updated > 0 {
            for resource_id in resource_ids {
                let svc = service.clone();
                tokio::spawn(async move {
                    svc.index_resource_immediately(&resource_id).await;
                });
            }
            service.spawn_post_write_maintenance();
        }

        Ok(json!({
            "total": items.len(),
            "succeeded": added + updated,
            "failed": filtered,
            "added": added,
            "updated": updated,
            "skipped": skipped,
            "filtered": filtered,
            "results": results,
        }))
    }

    async fn execute_batch_move(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        if ctx.is_cancelled() {
            return Err(Self::invalid_args(
                "cancellation",
                "批量移动在开始前已取消",
                "The batch move was cancelled before it started.",
            ));
        }
        let service = self.get_service(ctx)?;
        if let Err(hint) = self.ensure_root_configured(&service) {
            return Ok(hint);
        }
        let expected_versions = Self::parse_batch_move_args(&call.arguments)?;
        let target_folder_path =
            Self::required_string_allow_empty(&call.arguments, "target_folder_path")?;
        if target_folder_path.chars().count() > MEMORY_FOLDER_PATH_CHARS {
            return Err(Self::invalid_args(
                "target_folder_path",
                format!("目标文件夹路径最多允许 {MEMORY_FOLDER_PATH_CHARS} 个字符"),
                format!(
                    "target_folder_path may contain at most {MEMORY_FOLDER_PATH_CHARS} characters."
                ),
            ));
        }
        let session_id = ctx.session_id.clone();
        let cancel_token = ctx.cancellation_token().cloned();
        let service_for_task = service.clone();
        let target_for_task = target_folder_path.clone();

        let outcome = tokio::task::spawn_blocking(move || {
            let total = expected_versions.len();
            let mut succeeded_ids = Vec::new();
            let mut results = Vec::with_capacity(total);
            let mut undo = Vec::new();
            let mut cancelled = false;

            for (note_id, expected_updated_at) in expected_versions {
                if cancel_token
                    .as_ref()
                    .map(|token| token.is_cancelled())
                    .unwrap_or(false)
                {
                    cancelled = true;
                    break;
                }
                match service_for_task.move_to_folder_with_occ(
                    &note_id,
                    &expected_updated_at,
                    &target_for_task,
                    MemoryOpSource::ToolCall,
                    Some(&session_id),
                ) {
                    Ok((updated, previous_folder_path)) => {
                        let undo_versions =
                            HashMap::from([(note_id.clone(), updated.updated_at.clone())]);
                        succeeded_ids.push(note_id.clone());
                        undo.push(json!({
                            "tool": MEMORY_BATCH_MOVE,
                            "note_ids": [note_id.clone()],
                            "target_folder_path": previous_folder_path.clone(),
                            "expected_updated_at_by_id": undo_versions,
                        }));
                        results.push(json!({
                            "success": true,
                            "note_id": note_id,
                            "previous_folder_path": previous_folder_path,
                            "folder_path": target_for_task.clone(),
                            "updated_at": updated.updated_at,
                        }));
                    }
                    Err(error) => {
                        let structured = Self::service_error(
                            &service_for_task,
                            "batch_move",
                            std::slice::from_ref(&note_id),
                            error,
                        );
                        let error_value = serde_json::from_str::<Value>(&structured)
                            .unwrap_or_else(|_| json!({ "message": structured }));
                        results.push(json!({
                            "success": false,
                            "note_id": note_id,
                            "error": error_value,
                        }));
                    }
                }
            }

            let failed = results
                .iter()
                .filter(|item| item["success"].as_bool() == Some(false))
                .count();
            (total, succeeded_ids, failed, cancelled, results, undo)
        })
        .await
        .map_err(|error| error.to_string())?;

        let (total, succeeded_ids, failed, cancelled, results, undo) = outcome;
        if !succeeded_ids.is_empty() {
            Self::emit_memory_changed(ctx, "batch_move", &succeeded_ids);
            service.spawn_post_write_maintenance();
        }
        let succeeded = succeeded_ids.len();
        let processed = results.len();
        let remaining = total.saturating_sub(processed);
        Ok(with_localized_message(
            json!({
                "success": failed == 0 && !cancelled && succeeded == total,
                "total": total,
                "processed": processed,
                "remaining": remaining,
                "succeeded": succeeded,
                "failed": failed,
                "cancelled": cancelled,
                "target_folder_path": target_folder_path,
                "results": results,
                "reversible": succeeded > 0,
                "undo": undo,
            }),
            "chat.tools.memory.batch_move_completed",
            json!({ "succeeded": succeeded, "failed": failed, "total": total }),
            format!("批量移动完成：成功 {succeeded} 条，失败 {failed} 条"),
            format!("Batch move completed: {succeeded} succeeded and {failed} failed."),
        ))
    }

    async fn execute_relation(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        add: bool,
    ) -> Result<Value, String> {
        if ctx.is_cancelled() {
            return Err(Self::invalid_args(
                "cancellation",
                "关联操作在开始前已取消",
                "The relation operation was cancelled before it started.",
            ));
        }
        let service = self.get_service(ctx)?;
        if let Err(hint) = self.ensure_root_configured(&service) {
            return Ok(hint);
        }
        let note_id_a = Self::required_string(&call.arguments, "note_id_a")?;
        let note_id_b = Self::required_string(&call.arguments, "note_id_b")?;
        if note_id_a == note_id_b {
            return Err(Self::invalid_args(
                "note_id_b",
                "关联的两个记忆 ID 必须不同",
                "The two relation endpoints must be different.",
            ));
        }
        let expected_updated_at_a =
            Self::required_string(&call.arguments, "expected_updated_at_a")?;
        let expected_updated_at_b =
            Self::required_string(&call.arguments, "expected_updated_at_b")?;
        let service_for_task = service.clone();
        let session_id = ctx.session_id.clone();
        let task_note_id_a = note_id_a.clone();
        let task_note_id_b = note_id_b.clone();
        let action = if add {
            "add_relation"
        } else {
            "remove_relation"
        };

        let operation = tokio::task::spawn_blocking(move || {
            if add {
                service_for_task.add_relation_with_occ(
                    &task_note_id_a,
                    &expected_updated_at_a,
                    &task_note_id_b,
                    &expected_updated_at_b,
                    MemoryOpSource::ToolCall,
                    Some(&session_id),
                )
            } else {
                service_for_task.remove_relation_with_occ(
                    &task_note_id_a,
                    &expected_updated_at_a,
                    &task_note_id_b,
                    &expected_updated_at_b,
                    MemoryOpSource::ToolCall,
                    Some(&session_id),
                )
            }
        })
        .await
        .map_err(|error| error.to_string())?;

        let (note_a, note_b, changed) = operation.map_err(|error| {
            Self::service_error(
                &service,
                action,
                &[note_id_a.clone(), note_id_b.clone()],
                error,
            )
        })?;
        if changed {
            Self::emit_memory_changed(ctx, action, &[note_id_a.clone(), note_id_b.clone()]);
        }
        let related_a: Vec<String> = note_a
            .tags
            .iter()
            .filter_map(|tag| tag.strip_prefix("_ref:").map(str::to_string))
            .collect();
        let related_b: Vec<String> = note_b
            .tags
            .iter()
            .filter_map(|tag| tag.strip_prefix("_ref:").map(str::to_string))
            .collect();
        let inverse_tool = if add {
            MEMORY_REMOVE_RELATION
        } else {
            MEMORY_ADD_RELATION
        };
        let note_a_id = note_a.id.clone();
        let note_b_id = note_b.id.clone();
        let note_a_updated_at = note_a.updated_at.clone();
        let note_b_updated_at = note_b.updated_at.clone();
        Ok(with_localized_message(
            json!({
                "success": true,
                "changed": changed,
                "note_a": {
                    "note_id": note_a_id,
                    "updated_at": note_a_updated_at,
                    "related_note_ids": related_a,
                },
                "note_b": {
                    "note_id": note_b_id,
                    "updated_at": note_b_updated_at,
                    "related_note_ids": related_b,
                },
                "reversible": changed,
                "undo": if changed {
                    json!({
                        "tool": inverse_tool,
                        "note_id_a": note_id_a,
                        "note_id_b": note_id_b,
                        "expected_updated_at_a": note_a_updated_at,
                        "expected_updated_at_b": note_b_updated_at,
                    })
                } else {
                    Value::Null
                },
            }),
            if add {
                "chat.tools.memory.relation_added"
            } else {
                "chat.tools.memory.relation_removed"
            },
            json!({ "changed": changed }),
            if add {
                "记忆关联已添加"
            } else {
                "记忆关联已移除"
            },
            if add {
                "The memory relation was added."
            } else {
                "The memory relation was removed."
            },
        ))
    }

    async fn execute_update_tags(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        if ctx.is_cancelled() {
            return Err(Self::invalid_args(
                "cancellation",
                "标签更新在开始前已取消",
                "The tag update was cancelled before it started.",
            ));
        }
        let service = self.get_service(ctx)?;
        if let Err(hint) = self.ensure_root_configured(&service) {
            return Ok(hint);
        }
        let note_id = Self::required_string(&call.arguments, "note_id")?;
        let expected_updated_at = Self::required_string(&call.arguments, "expected_updated_at")?;
        let tags = Self::parse_tags(&call.arguments)?;
        let service_for_task = service.clone();
        let task_note_id = note_id.clone();
        let session_id = ctx.session_id.clone();

        let operation = tokio::task::spawn_blocking(move || {
            service_for_task.update_tags_with_occ(
                &task_note_id,
                &expected_updated_at,
                tags,
                MemoryOpSource::ToolCall,
                Some(&session_id),
            )
        })
        .await
        .map_err(|error| error.to_string())?;
        let (previous, updated) = operation.map_err(|error| {
            Self::service_error(
                &service,
                "update_tags",
                std::slice::from_ref(&note_id),
                error,
            )
        })?;
        Self::emit_memory_changed(ctx, "update_tags", std::slice::from_ref(&note_id));
        let previous_user_tags: Vec<String> = previous
            .tags
            .iter()
            .filter(|tag| !tag.starts_with('_'))
            .cloned()
            .collect();
        let user_tags: Vec<String> = updated
            .tags
            .iter()
            .filter(|tag| !tag.starts_with('_'))
            .cloned()
            .collect();
        let updated_id = updated.id.clone();
        let updated_at = updated.updated_at.clone();

        Ok(with_localized_message(
            json!({
                "success": true,
                "note_id": note_id,
                "tags": updated.tags,
                "user_tags": user_tags,
                "system_tags_preserved": true,
                "updated_at": updated_at,
                "reversible": true,
                "undo": {
                    "tool": MEMORY_UPDATE_TAGS,
                    "note_id": updated_id,
                    "tags": previous_user_tags,
                    "expected_updated_at": updated_at,
                },
            }),
            "chat.tools.memory.tags_updated",
            json!({ "noteId": updated_id }),
            "记忆标签已更新",
            "The memory tags were updated.",
        ))
    }

    async fn execute_export_all(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        if ctx.is_cancelled() {
            return Err(Self::invalid_args(
                "cancellation",
                "记忆导出在开始前已取消",
                "The memory export was cancelled before it started.",
            ));
        }
        let service = self.get_service(ctx)?;
        if let Err(hint) = self.ensure_root_configured(&service) {
            return Ok(hint);
        }
        let (page, page_size, offset) = Self::export_pagination(&call.arguments)?;
        let service_for_task = service.clone();
        let export = tokio::task::spawn_blocking(move || {
            Self::export_page(&service_for_task, page_size, offset)
        })
        .await
        .map_err(|error| error.to_string())?;
        let (items, has_more) =
            export.map_err(|error| Self::service_error(&service, "export_all", &[], error))?;
        let returned = items.len();
        let any_truncated = items
            .iter()
            .any(|item| item["content_truncated"].as_bool() == Some(true));
        let next_page = has_more.then(|| page.checked_add(1)).flatten();

        Ok(with_localized_message(
            json!({
                "success": true,
                "items": items,
                "page": page,
                "page_size": page_size,
                "returned": returned,
                "has_more": has_more,
                "next_page": next_page,
                "truncated": any_truncated,
                "content_limit_chars": MEMORY_EXPORT_CONTENT_CHARS,
            }),
            "chat.tools.memory.export_page_ready",
            json!({ "page": page, "returned": returned, "hasMore": has_more }),
            format!("记忆导出第 {page} 页已生成，共 {returned} 条"),
            format!("Memory export page {page} is ready with {returned} items."),
        ))
    }

    /// 读取学习者画像（结构化 JSON + 渲染后的 Markdown）
    async fn execute_learner_profile_get(
        &self,
        _call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        if ctx.is_cancelled() {
            return Err("Learner profile get cancelled before start".to_string());
        }

        let service = self.get_service(ctx)?;
        if let Err(hint) = self.ensure_root_configured(&service) {
            return Ok(hint);
        }

        let load_task = {
            let service = service.clone();
            tokio::task::spawn_blocking(move || {
                crate::memory::learner_profile::load_profile(&service)
            })
        };
        let profile = load_task
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;

        match profile {
            Some(profile) => Ok(json!({
                "found": true,
                "version": profile.version,
                "updated_at": profile.updated_at,
                "profile": serde_json::to_value(&profile).unwrap_or(Value::Null),
                "rendered_markdown": profile.render_markdown(),
            })),
            None => Ok(json!({
                "found": false,
                "hint": "学习者画像尚未建立。可通过 learner_profile_update 写入首批内容，或等待系统从每日学习日志自动晋升。"
            })),
        }
    }

    /// 结构化 merge 更新学习者画像（非整体覆盖）
    ///
    /// 超过 4000 字符硬上限时拒绝写入并要求精炼——画像是"策展层"，不是日志。
    async fn execute_learner_profile_update(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        use crate::memory::learner_profile::{
            self, LearnerProfileUpdate, LEARNER_PROFILE_MAX_CHARS,
        };

        if ctx.is_cancelled() {
            return Err("Learner profile update cancelled before start".to_string());
        }

        let service = self.get_service(ctx)?;
        if let Err(hint) = self.ensure_root_configured(&service) {
            return Ok(hint);
        }

        let update: LearnerProfileUpdate = serde_json::from_value(call.arguments.clone())
            .map_err(|e| format!("Invalid learner_profile_update arguments: {}", e))?;
        if update.is_empty() {
            return Ok(json!({
                "success": false,
                "error": "更新内容为空：请至少提供 weak_points_add / preferences / goals_add / recent_status 之一。"
            }));
        }

        // 敏感信息过滤（与其他记忆写路径一致）
        let update_json = serde_json::to_string(&update).unwrap_or_default();
        if crate::memory::auto_extractor::MemoryAutoExtractor::contains_sensitive_pattern_pub(
            &update_json,
        ) {
            return Ok(json!({
                "success": false,
                "error": "更新内容包含敏感信息（手机号/身份证/银行卡/邮箱/密码），已拦截。"
            }));
        }

        let session_id = ctx.session_id.clone();
        let cancel_token = ctx.cancellation_token().cloned();
        let update_task = {
            let service = service.clone();
            tokio::task::spawn_blocking(move || -> Result<Value, String> {
                let outcome = match learner_profile::apply_profile_update(
                    &service,
                    &update,
                    MemoryOpSource::ToolCall,
                    Some(&session_id),
                    "learner_profile_update 工具更新",
                    learner_profile::ProfileLimitPolicy::Reject,
                    || {
                        cancel_token
                            .as_ref()
                            .map(|token| token.is_cancelled())
                            .unwrap_or(false)
                    },
                ) {
                    Ok(outcome) => outcome,
                    Err(crate::vfs::error::VfsError::InvalidArgument { param, reason })
                        if param == "profile" =>
                    {
                        let rendered_chars = reason
                            .strip_prefix("合并后画像 ")
                            .and_then(|rest| rest.split_once(" 字符"))
                            .and_then(|(count, _)| count.parse::<usize>().ok())
                            .unwrap_or(LEARNER_PROFILE_MAX_CHARS.saturating_add(1));
                        return Ok(json!({
                            "success": false,
                            "error": format!(
                                "{} 画像是策展层而非日志：请精炼本次更新（减少条目、缩短描述），或先用 weak_points_remove/goals_remove 清理过时内容。",
                                reason
                            ),
                            "rendered_chars": rendered_chars,
                            "max_chars": LEARNER_PROFILE_MAX_CHARS,
                        }));
                    }
                    Err(error) => return Err(error.to_string()),
                };

                Ok(json!({
                    "success": true,
                    "changed": outcome.changed,
                    "version": outcome.profile.version,
                    "rendered_chars": outcome.profile.rendered_char_count(),
                    "reason": if outcome.changed {
                        "画像已更新"
                    } else {
                        "更新与当前画像一致，无变更"
                    },
                }))
            })
        };

        // Do not drop a running spawn_blocking JoinHandle on cancellation: a
        // detached task could otherwise commit after the tool already
        // reported "cancelled". The blocking CAS loop checks cancellation
        // immediately before its commit point, and a completed commit is
        // always returned as success.
        update_task.await.map_err(|e| e.to_string())?
    }
}

impl MemoryToolExecutor {
    fn resolve_idempotency_key(
        call: &ToolCall,
        session_id: &str,
        message_id: &str,
        folder: Option<&str>,
        title: &str,
        content: &str,
        memory_type: MemoryType,
        memory_purpose: Option<crate::memory::MemoryPurpose>,
    ) -> String {
        if let Some(explicit) = call
            .arguments
            .get("idempotency_key")
            .or_else(|| call.arguments.get("idempotencyKey"))
            .and_then(|v| v.as_str())
        {
            let explicit = explicit.trim();
            if !explicit.is_empty() {
                return explicit.to_string();
            }
        }

        let normalized = format!(
            "{}|{}|{}|{}|{}",
            folder.unwrap_or("").trim().to_lowercase(),
            title.trim().to_lowercase(),
            content.trim().to_lowercase(),
            memory_type.as_str(),
            memory_purpose.map(|p| p.as_str()).unwrap_or(""),
        );
        let mut hasher = Sha256::new();
        hasher.update(normalized.as_bytes());
        let digest = format!("{:x}", hasher.finalize());
        format!("mem:{}:{}:{}", session_id, message_id, digest)
    }
}

#[async_trait]
impl ToolExecutor for MemoryToolExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        Self::is_memory_tool(tool_name)
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start_time = Instant::now();

        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let stripped_name = strip_tool_namespace(&call.name);

        let result = match stripped_name {
            "memory_search" => self.execute_search(call, ctx).await,
            "memory_read" => self.execute_read(call, ctx).await,
            "memory_write" => self.execute_write(call, ctx).await,
            "memory_list" => self.execute_list(call, ctx).await,
            "memory_update_by_id" => self.execute_update_by_id(call, ctx).await,
            "memory_delete" => self.execute_delete(call, ctx).await,
            "memory_write_smart" => self.execute_write_smart(call, ctx).await,
            "memory_write_batch" => self.execute_write_batch(call, ctx).await,
            "memory_batch_move" => self.execute_batch_move(call, ctx).await,
            "memory_add_relation" => self.execute_relation(call, ctx, true).await,
            "memory_remove_relation" => self.execute_relation(call, ctx, false).await,
            "memory_update_tags" => self.execute_update_tags(call, ctx).await,
            "memory_export_all" => self.execute_export_all(call, ctx).await,
            "learner_profile_get" => self.execute_learner_profile_get(call, ctx).await,
            "learner_profile_update" => self.execute_learner_profile_update(call, ctx).await,
            _ => Err(format!("Unknown memory tool: {}", call.name)),
        };

        let duration_ms = start_time.elapsed().as_millis() as u32;

        match result {
            Ok(output) => {
                ctx.emit_tool_call_end(Some(json!({
                    "result": output,
                    "durationMs": duration_ms,
                })));
                Ok(ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration_ms as u64,
                ))
            }
            Err(e) => {
                ctx.emit_tool_call_error(&e);
                Ok(ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    e,
                    duration_ms as u64,
                ))
            }
        }
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        let stripped = strip_tool_namespace(tool_name);
        match stripped {
            "memory_export_all" => ToolSensitivity::High,
            "memory_batch_move"
            | "memory_add_relation"
            | "memory_remove_relation"
            | "memory_update_tags"
            | "memory_write"
            | "memory_write_smart"
            | "memory_write_batch"
            | "memory_update_by_id" => ToolSensitivity::Medium,
            "memory_delete" => ToolSensitivity::Medium, // 删除操作需要更高敏感度
            // 学习者画像随每次会话注入 system prompt，读写均为 Medium
            "learner_profile_get" | "learner_profile_update" => ToolSensitivity::Medium,
            _ => ToolSensitivity::Low,
        }
    }

    fn concurrency_class(&self, tool_name: &str) -> ToolConcurrency {
        let stripped = strip_tool_namespace(tool_name);
        match stripped {
            // 读类工具：纯只读记忆查询，可并行 + 自动重试
            "memory_search" | "memory_read" | "memory_list" | "memory_export_all" => {
                ToolConcurrency::ReadOnly
            }
            // write/update/delete/write_smart/write_batch 为写操作，保持串行（默认）
            _ => ToolConcurrency::Serial,
        }
    }

    fn name(&self) -> &'static str {
        "MemoryToolExecutor"
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::{
        MemoryToolExecutor, MEMORY_BATCH_LIMIT, MEMORY_EXPORT_CONTENT_CHARS,
        MEMORY_EXPORT_PAGE_SIZE, MEMORY_LIST_PAGE_SIZE,
    };
    use crate::chat_v2::tools::executor::{ToolConcurrency, ToolExecutor, ToolSensitivity};

    #[test]
    fn test_needs_root_bootstrap() {
        assert!(MemoryToolExecutor::needs_root_bootstrap(None));
        assert!(!MemoryToolExecutor::needs_root_bootstrap(Some("folder-1")));
    }

    #[test]
    fn phase9_memory_tools_have_explicit_sensitivity_and_concurrency() {
        let executor = MemoryToolExecutor::new();
        for tool in [
            "builtin-memory_batch_move",
            "builtin-memory_add_relation",
            "builtin-memory_remove_relation",
            "builtin-memory_update_tags",
            "builtin-memory_write",
            "builtin-memory_write_smart",
            "builtin-memory_write_batch",
            "builtin-memory_update_by_id",
        ] {
            assert!(executor.can_handle(tool), "executor must handle {tool}");
            assert_eq!(executor.sensitivity_level(tool), ToolSensitivity::Medium);
            assert_eq!(executor.concurrency_class(tool), ToolConcurrency::Serial);
        }
        assert!(executor.can_handle("builtin-memory_export_all"));
        assert_eq!(
            executor.sensitivity_level("builtin-memory_export_all"),
            ToolSensitivity::High
        );
        assert_eq!(
            executor.concurrency_class("builtin-memory_export_all"),
            ToolConcurrency::ReadOnly
        );
    }

    #[test]
    fn batch_move_parser_requires_complete_occ_map_and_enforces_limit() {
        let note_ids: Vec<String> = (0..MEMORY_BATCH_LIMIT)
            .map(|index| format!("note-{index}"))
            .collect();
        let versions = note_ids
            .iter()
            .map(|id| (id.clone(), json!(format!("version-{id}"))))
            .collect::<serde_json::Map<String, Value>>();
        let parsed = MemoryToolExecutor::parse_batch_move_args(&json!({
            "note_ids": note_ids,
            "expected_updated_at_by_id": versions,
        }))
        .expect("complete OCC map should parse");
        assert_eq!(parsed.len(), MEMORY_BATCH_LIMIT);

        let missing = MemoryToolExecutor::parse_batch_move_args(&json!({
            "note_ids": ["note-a", "note-b"],
            "expected_updated_at_by_id": {"note-a": "v1"},
        }))
        .expect_err("missing OCC entry must fail");
        assert!(missing.contains("MEMORY_INVALID_ARGS"));

        let too_many: Vec<String> = (0..=MEMORY_BATCH_LIMIT)
            .map(|index| format!("note-{index}"))
            .collect();
        let too_many_error = MemoryToolExecutor::parse_batch_move_args(&json!({
            "note_ids": too_many,
            "expected_updated_at_by_id": {},
        }))
        .expect_err("more than 20 IDs must fail before execution");
        assert!(too_many_error.contains("MEMORY_INVALID_ARGS"));
    }

    #[test]
    fn export_pagination_and_content_are_bounded() {
        assert_eq!(
            MemoryToolExecutor::export_pagination(&json!({})).expect("defaults"),
            (1, MEMORY_EXPORT_PAGE_SIZE as u32, 0)
        );
        let invalid = MemoryToolExecutor::export_pagination(&json!({
            "page": 1,
            "page_size": MEMORY_EXPORT_PAGE_SIZE + 1,
        }))
        .expect_err("oversized export page must fail");
        assert!(invalid.contains("MEMORY_INVALID_ARGS"));

        let content = "学".repeat(MEMORY_EXPORT_CONTENT_CHARS + 1);
        let (bounded, truncated) = MemoryToolExecutor::truncate_export_content(&content);
        assert!(truncated);
        assert_eq!(bounded.chars().count(), MEMORY_EXPORT_CONTENT_CHARS);
    }

    #[test]
    fn list_pagination_matches_global_read_limit() {
        assert_eq!(
            MemoryToolExecutor::list_pagination(&json!({})).expect("defaults"),
            (MEMORY_LIST_PAGE_SIZE as u32, 0)
        );
        let oversized = MemoryToolExecutor::list_pagination(&json!({
            "limit": MEMORY_LIST_PAGE_SIZE + 1,
        }))
        .expect_err("oversized list page must fail");
        assert!(oversized.contains("MEMORY_INVALID_ARGS"));
    }

    #[test]
    fn export_page_returns_real_memory_content_and_has_more() {
        let (_temp_dir, _vfs_db, service) = crate::memory::test_support::setup_memory_service();
        service
            .write_typed(
                None,
                "Export first",
                &"A".repeat(MEMORY_EXPORT_CONTENT_CHARS + 1),
                crate::memory::WriteMode::Create,
                crate::memory::MemoryType::Study,
                None,
            )
            .expect("create first export memory");
        service
            .write(
                Some("Study"),
                "Export second",
                "second content",
                crate::memory::WriteMode::Create,
            )
            .expect("create second export memory");

        let (items, has_more) = MemoryToolExecutor::export_page(&service, 1, 0)
            .expect("export first page from real VFS data");
        assert_eq!(items.len(), 1);
        assert!(has_more);
        assert!(items[0]["note_id"].as_str().is_some());
        assert!(items[0]["updated_at"].as_str().is_some());
        assert!(items[0]["content"].as_str().is_some());
        assert!(items[0]["content_truncated"].is_boolean());
    }

    #[test]
    fn tags_are_trimmed_deduplicated_and_bounded() {
        assert_eq!(
            MemoryToolExecutor::parse_tags(&json!({
                "tags": [" exam ", "exam", "focus"]
            }))
            .expect("valid tags"),
            vec!["exam", "focus"]
        );
        let oversized = "x".repeat(super::MEMORY_TAG_CHARS + 1);
        assert!(MemoryToolExecutor::parse_tags(&json!({ "tags": [oversized] })).is_err());
    }
}
