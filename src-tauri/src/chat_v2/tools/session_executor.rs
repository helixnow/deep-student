//! 会话管理工具执行器
//!
//! 让 AI 具备管理自身会话的能力：列表、搜索、分组、打标、归档等。
//!
//! ## 安全设计
//! - 读操作（list/search/get）：Low 敏感度，直接执行
//! - 写操作（tag/move/rename/group_create）：Medium 敏感度
//! - 破坏性操作（archive/delete）：High 敏感度，skill 指令要求先 ask_user 确认
//!
//! ## 工具列表
//! | 工具名 | 类型 | 说明 |
//! |--------|------|------|
//! | `session_list` | 读 | 列出会话，支持状态/分组/标签筛选 |
//! | `session_search` | 读 | 跨会话全文搜索 |
//! | `session_get` | 读 | 获取单个会话详情（含标签） |
//! | `session_get_messages` | 读 | 分页读取会话消息正文与块摘要 |
//! | `session_export` | 写 | 导出 Markdown 或创建 VFS 笔记 |
//! | `session_import` | 写 | 从导出 JSON 导入为新会话（ID 全量重映射） |
//! | `group_list` | 读 | 列出所有分组 |
//! | `tag_list_all` | 读 | 列出所有标签及使用次数 |
//! | `session_stats` | 读 | 会话统计（数量/分布/趋势） |
//! | `session_tag_add` | 写 | 给会话添加标签 |
//! | `session_tag_remove` | 写 | 移除会话标签 |
//! | `session_move` | 写 | 移动会话到分组 |
//! | `session_rename` | 写 | 重命名会话 |
//! | `group_create` | 写 | 创建新分组 |
//! | `group_update` | 写 | 更新分组信息 |
//! | `session_archive` | 危险 | 归档会话 |
//! | `session_batch_move` | 危险 | 批量移动会话到分组 |
//! | `session_batch_tag` | 写 | 批量给会话打标 |
//! | `session_batch_ops` | 危险 | 统一批量混合操作（move/tag/rename/archive/restore） |

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use super::arg_utils::{get_json_array_arg, get_string_array_arg};
use super::attachment_stage_executor::resolve_staged_file_in_temp_root;
use super::executor::{ExecutionContext, ToolConcurrency, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::database::ChatV2Database;
use crate::chat_v2::repo::ChatV2Repo;
use crate::chat_v2::runtime_roots::temp_root;
use crate::chat_v2::types::{
    ChatMessage, ChatSession, MessageBlock, MessageRole, PersistStatus, SessionGroup, ToolCall,
    ToolResultInfo,
};
use crate::dstu::handler_utils::{emit_watch_event, note_to_dstu_node};
use crate::dstu::types::DstuWatchEvent;
use crate::vfs::{VfsCreateNoteParams, VfsNoteRepo};

/// 会话管理变更事件名（前端监听以刷新侧边栏）
const SESSION_MGMT_EVENT: &str = "session_management_change";

// ============================================================================
// 常量
// ============================================================================

const LOG_PREFIX: &str = "[SessionExecutor]";
const MAX_BATCH_OPS_PER_CALL: usize = 200;
const MANUALLY_ARCHIVED_BY_KEY: &str = "manuallyArchivedBy";
const MAX_MESSAGE_PAGE_SIZE: u32 = 20;
const MAX_TOOL_FIELD_CHARS: usize = 2_000;
const MAX_TOOL_OUTPUT_PREVIEW_CHARS: usize = 200;
const MAX_EXPORT_TITLE_CHARS: usize = 120;

// session_import 限额：staged json 文件 / 内联 json 字符 / 消息与块数量
const MAX_SESSION_IMPORT_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SESSION_IMPORT_CONTENT_CHARS: usize = 2_000_000;
const MAX_SESSION_IMPORT_MESSAGES: usize = 2_000;
const MAX_SESSION_IMPORT_BLOCKS: usize = 20_000;

/// 所有会话管理工具名
pub mod tool_names {
    pub const SESSION_LIST: &str = "session_list";
    pub const SESSION_SEARCH: &str = "session_search";
    pub const SESSION_GET: &str = "session_get";
    pub const SESSION_GET_MESSAGES: &str = "session_get_messages";
    pub const SESSION_EXPORT: &str = "session_export";
    pub const SESSION_IMPORT: &str = "session_import";
    pub const GROUP_LIST: &str = "group_list";
    pub const TAG_LIST_ALL: &str = "tag_list_all";
    pub const SESSION_STATS: &str = "session_stats";
    pub const SESSION_TAG_ADD: &str = "session_tag_add";
    pub const SESSION_TAG_REMOVE: &str = "session_tag_remove";
    pub const SESSION_MOVE: &str = "session_move";
    pub const SESSION_RENAME: &str = "session_rename";
    pub const GROUP_CREATE: &str = "group_create";
    pub const GROUP_UPDATE: &str = "group_update";
    pub const SESSION_ARCHIVE: &str = "session_archive";
    pub const SESSION_BATCH_MOVE: &str = "session_batch_move";
    pub const SESSION_BATCH_TAG: &str = "session_batch_tag";
    pub const SESSION_BATCH_OPS: &str = "session_batch_ops";
}

fn is_session_tool(name: &str) -> bool {
    matches!(
        name,
        "session_list"
            | "session_search"
            | "session_get"
            | "session_get_messages"
            | "session_export"
            | "session_import"
            | "group_list"
            | "tag_list_all"
            | "session_stats"
            | "session_tag_add"
            | "session_tag_remove"
            | "session_move"
            | "session_rename"
            | "group_create"
            | "group_update"
            | "session_archive"
            | "session_restore"
            | "session_batch_move"
            | "session_batch_tag"
            | "session_batch_ops"
    )
}

// ============================================================================
// 执行器
// ============================================================================

pub struct SessionToolExecutor;

impl Default for SessionToolExecutor {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionToolExecutor {
    pub fn new() -> Self {
        Self
    }

    /// 从 ExecutionContext 获取 ChatV2Database
    fn get_db(ctx: &ExecutionContext) -> Result<&ChatV2Database, String> {
        ctx.chat_v2_db
            .as_ref()
            .map(|arc| arc.as_ref())
            .ok_or_else(|| {
                format!(
                    "{} chat_v2_db not available in ExecutionContext",
                    LOG_PREFIX
                )
            })
    }

    fn ensure_not_current_session(
        session_id: &str,
        ctx: &ExecutionContext,
        action_label: &str,
    ) -> Result<(), String> {
        if session_id == ctx.session_id {
            return Err(format!("不能对当前正在使用的会话执行{}", action_label));
        }
        Ok(())
    }

    fn batch_ops_confirmation_required(unique_sessions: usize, has_archive: bool) -> bool {
        unique_sessions > 3 || has_archive
    }

    fn batch_move_confirmation_required(total_sessions: usize) -> bool {
        total_sessions > 3
    }

    fn batch_tag_confirmation_required(total_sessions: usize) -> bool {
        total_sessions > 5
    }

    // ========================================================================
    // 读操作
    // ========================================================================

    fn execute_session_list(args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let db = Self::get_db(ctx)?;
        Self::execute_session_list_with_db(args, db)
    }

    fn execute_session_list_with_db(args: &Value, db: &ChatV2Database) -> Result<Value, String> {
        let conn = db.get_conn_safe().map_err(|e| e.to_string())?;

        let status = args.get("status").and_then(|v| v.as_str());
        let group_id = args.get("group_id").and_then(|v| v.as_str());
        let include_tags = args
            .get("include_tags")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let limit = args
            .get("limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(20)
            .clamp(1, 20) as u32;
        let offset = args.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as u32;

        let sessions = ChatV2Repo::list_sessions_with_conn(&conn, status, group_id, limit, offset)
            .map_err(|e| e.to_string())?;
        let total = ChatV2Repo::count_sessions_with_conn(&conn, status, group_id)
            .map_err(|e| e.to_string())?;

        let tags_map = if include_tags {
            let ids: Vec<String> = sessions.iter().map(|s| s.id.clone()).collect();
            ChatV2Repo::get_tags_for_sessions(&conn, &ids).unwrap_or_default()
        } else {
            std::collections::HashMap::new()
        };

        let items: Vec<Value> = sessions
            .iter()
            .map(|s| {
                let mut v = session_to_summary(s);
                if include_tags {
                    if let Some(obj) = v.as_object_mut() {
                        let tags = tags_map.get(&s.id).cloned().unwrap_or_default();
                        obj.insert("tags".to_string(), json!(tags));
                    }
                }
                v
            })
            .collect();

        Ok(json!({
            "sessions": items,
            "total": total,
            "limit": limit,
            "offset": offset,
            "hasMore": offset + limit < total
        }))
    }

    fn execute_session_search(args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let db = Self::get_db(ctx)?;
        let conn = db.get_conn_safe().map_err(|e| e.to_string())?;

        let query = args
            .get("query")
            .and_then(|v| v.as_str())
            .ok_or("缺少必需参数: query")?;
        let limit = args
            .get("limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(20)
            .min(50) as u32;

        let (date_from, date_to) = parse_search_date_range(args)?;

        let results = ChatV2Repo::search_content_with_date_range(
            &conn,
            query,
            limit,
            date_from.as_deref(),
            date_to.as_deref(),
        )
        .map_err(|e| e.to_string())?;

        let items: Vec<Value> = results
            .iter()
            .map(|r| {
                json!({
                    "sessionId": r.session_id,
                    "sessionTitle": r.session_title,
                    "messageId": r.message_id,
                    "role": r.role,
                    "snippet": r.snippet,
                    "updatedAt": r.updated_at
                })
            })
            .collect();

        Ok(json!({
            "results": items,
            "count": items.len(),
            "query": query,
            "dateFrom": date_from,
            "dateTo": date_to
        }))
    }

    fn execute_session_get(args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let db = Self::get_db(ctx)?;
        let conn = db.get_conn_safe().map_err(|e| e.to_string())?;

        let session_id = args
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or("缺少必需参数: session_id")?;

        let session = ChatV2Repo::get_session_with_conn(&conn, session_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("会话不存在: {}", session_id))?;

        let tags = ChatV2Repo::get_session_tags(&conn, session_id).map_err(|e| e.to_string())?;

        let group_name = if let Some(ref gid) = session.group_id {
            ChatV2Repo::get_group_with_conn(&conn, gid)
                .ok()
                .flatten()
                .map(|g| g.name)
        } else {
            None
        };

        Ok(json!({
            "id": session.id,
            "mode": session.mode,
            "title": session.title,
            "description": session.description,
            "persistStatus": format!("{:?}", session.persist_status).to_lowercase(),
            "createdAt": session.created_at.to_rfc3339(),
            "updatedAt": session.updated_at.to_rfc3339(),
            "groupId": session.group_id,
            "groupName": group_name,
            "tags": tags,
            "metadata": session.metadata
        }))
    }

    fn execute_session_get_messages(args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let db = Self::get_db(ctx)?;
        Self::execute_session_get_messages_with_db(args, db)
    }

    fn execute_session_get_messages_with_db(
        args: &Value,
        db: &ChatV2Database,
    ) -> Result<Value, String> {
        let conn = db.get_conn_safe().map_err(|e| e.to_string())?;

        let session_id = required_non_empty_string(args, "session_id")?;
        let page = parse_bounded_u32(args, "page", 1, 1, u32::MAX)?;
        let page_size = parse_bounded_u32(
            args,
            "page_size",
            MAX_MESSAGE_PAGE_SIZE,
            1,
            MAX_MESSAGE_PAGE_SIZE,
        )?;
        let role_filter = parse_role_filter(args)?;

        let session = ChatV2Repo::get_session_with_conn(&conn, session_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("SESSION_NOT_FOUND: {}", session_id))?;

        let (messages, blocks, total) = ChatV2Repo::load_session_messages_page_with_conn(
            &conn,
            session_id,
            page,
            page_size,
            role_filter,
        )
        .map_err(|e| e.to_string())?;

        let blocks_by_message = group_blocks_by_message(&blocks);
        let items: Vec<Value> = messages
            .iter()
            .map(|message| {
                let message_blocks = blocks_by_message
                    .get(message.id.as_str())
                    .cloned()
                    .unwrap_or_default();
                let visible_blocks = visible_blocks_for_message(message, &message_blocks);
                message_to_tool_value(message, &visible_blocks)
            })
            .collect();

        let offset = u64::from(page.saturating_sub(1)) * u64::from(page_size);
        let has_more = offset + (items.len() as u64) < u64::from(total);

        Ok(json!({
            "sessionId": session.id,
            "sessionTitle": session.title,
            "messages": items,
            "page": page,
            "pageSize": page_size,
            "roleFilter": role_filter,
            "total": total,
            "hasMore": has_more
        }))
    }

    fn execute_session_export(args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let db = Self::get_db(ctx)?;
        let format = required_non_empty_string(args, "format")?;
        if !matches!(format, "markdown" | "note") {
            return Err("SESSION_EXPORT_INVALID_FORMAT: expected markdown or note".to_string());
        }
        let export = prepare_session_export(db, args)?;

        if format == "markdown" {
            return Ok(markdown_export_to_tool_value(export));
        }

        let folder_id = optional_non_empty_string(args, "folder_id")?;
        let vfs_db = ctx
            .vfs_db
            .as_ref()
            .ok_or("SESSION_EXPORT_VFS_UNAVAILABLE")?;
        let note = VfsNoteRepo::create_note_in_folder(
            vfs_db,
            VfsCreateNoteParams {
                title: export.title.clone(),
                content: export.markdown,
                tags: Vec::new(),
            },
            folder_id,
        )
        .map_err(|e| format!("SESSION_EXPORT_NOTE_FAILED: {}", e))?;

        let node = note_to_dstu_node(&note);
        emit_watch_event(
            ctx.window_ref(),
            DstuWatchEvent::created(&node.path, node.clone()),
        );

        Ok(json!({
            "success": true,
            "format": "note",
            "sessionId": export.session_id,
            "title": note.title,
            "range": export.range,
            "messageCount": export.message_count,
            "folderId": folder_id,
            "noteId": note.id,
            "resourceId": note.resource_id,
            "path": node.path,
            "target": {
                "kind": "vfs_note",
                "folderId": folder_id,
                "noteId": note.id,
                "resourceId": note.resource_id,
                "path": node.path
            },
            "reversible": true,
            "reverseWith": "builtin-note_delete"
        }))
    }

    /// 从导出 JSON（chat_v2_export_session format=json 的结构）导入为新会话。
    ///
    /// 与 session_export 对偶：接受内联 json_content 或 attachment_stage
    /// 物化后的 staged json 文件（root_id=temp + relative_path，会话归属由
    /// per-session temp root 隔离保证）。导入产生**新会话**（全部 ID 重映射），
    /// 绝不覆盖既有会话。
    fn execute_session_import(args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let db = Self::get_db(ctx)?;

        let raw = if let Some(content) = args
            .get("json_content")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            if content.chars().count() > MAX_SESSION_IMPORT_CONTENT_CHARS {
                return Err(format!(
                    "SESSION_IMPORT_TOO_LARGE: json_content exceeds {} chars; stage the file and pass root_id + relative_path instead",
                    MAX_SESSION_IMPORT_CONTENT_CHARS
                ));
            }
            content.to_string()
        } else {
            let root_id = args
                .get("root_id")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("temp");
            if !root_id.eq_ignore_ascii_case("temp") {
                return Err(format!(
                    "SESSION_IMPORT_INVALID_ROOT: only root_id=temp is accepted, got '{}'",
                    root_id
                ));
            }
            let relative_path = args
                .get("relative_path")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or(
                    "SESSION_IMPORT_MISSING_SOURCE: provide json_content, or root_id + relative_path of a staged json file",
                )?;
            let app_handle = ctx.window_ref().app_handle().clone();
            let temp = temp_root(&app_handle, &ctx.session_id, true)?;
            let path = resolve_staged_file_in_temp_root(&temp.path, relative_path)?;
            let meta = std::fs::metadata(&path)
                .map_err(|e| format!("SESSION_IMPORT_READ_FAILED: {}", e))?;
            if meta.len() > MAX_SESSION_IMPORT_FILE_BYTES {
                return Err(format!(
                    "SESSION_IMPORT_TOO_LARGE: file is {} bytes, limit is {} bytes",
                    meta.len(),
                    MAX_SESSION_IMPORT_FILE_BYTES
                ));
            }
            std::fs::read_to_string(&path)
                .map_err(|e| format!("SESSION_IMPORT_READ_FAILED: {}", e))?
        };

        let title_override = optional_non_empty_string(args, "title")?;
        Self::import_session_payload(db, &raw, title_override)
    }

    /// 解析 + 重映射 + 落库（从 execute_session_import 拆出，便于单元测试）
    fn import_session_payload(
        db: &ChatV2Database,
        raw: &str,
        title_override: Option<&str>,
    ) -> Result<Value, String> {
        let payload: Value =
            serde_json::from_str(raw).map_err(|e| format!("SESSION_IMPORT_INVALID_JSON: {}", e))?;
        let session_value = payload.get("session").cloned().ok_or(
            "SESSION_IMPORT_INVALID_FORMAT: missing 'session' field (expected the JSON produced by session export)",
        )?;
        let messages_value = payload
            .get("messages")
            .cloned()
            .ok_or("SESSION_IMPORT_INVALID_FORMAT: missing 'messages' field")?;
        let blocks_value = payload.get("blocks").cloned().unwrap_or_else(|| json!([]));

        let session: ChatSession = serde_json::from_value(session_value)
            .map_err(|e| format!("SESSION_IMPORT_INVALID_FORMAT: bad session object: {}", e))?;
        let messages: Vec<ChatMessage> = serde_json::from_value(messages_value)
            .map_err(|e| format!("SESSION_IMPORT_INVALID_FORMAT: bad messages array: {}", e))?;
        let blocks: Vec<MessageBlock> = serde_json::from_value(blocks_value)
            .map_err(|e| format!("SESSION_IMPORT_INVALID_FORMAT: bad blocks array: {}", e))?;

        if messages.is_empty() {
            return Err("SESSION_IMPORT_EMPTY: the export contains no messages".to_string());
        }
        if messages.len() > MAX_SESSION_IMPORT_MESSAGES {
            return Err(format!(
                "SESSION_IMPORT_TOO_LARGE: {} messages exceeds the {} limit",
                messages.len(),
                MAX_SESSION_IMPORT_MESSAGES
            ));
        }
        if blocks.len() > MAX_SESSION_IMPORT_BLOCKS {
            return Err(format!(
                "SESSION_IMPORT_TOO_LARGE: {} blocks exceeds the {} limit",
                blocks.len(),
                MAX_SESSION_IMPORT_BLOCKS
            ));
        }

        let (new_session, new_messages, new_blocks, stats) =
            remap_imported_session(session, messages, blocks, title_override);

        let conn = db.get_conn_safe().map_err(|e| e.to_string())?;
        conn.execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| format!("SESSION_IMPORT_DB_FAILED: {}", e))?;
        let insert_result = (|| -> Result<(), String> {
            ChatV2Repo::create_session_with_conn(&conn, &new_session).map_err(|e| e.to_string())?;
            for message in &new_messages {
                ChatV2Repo::create_message_with_conn(&conn, message).map_err(|e| e.to_string())?;
            }
            ChatV2Repo::create_blocks_batch_with_conn(&conn, &new_blocks)
                .map_err(|e| e.to_string())?;
            Ok(())
        })();
        match insert_result {
            Ok(()) => {
                conn.execute_batch("COMMIT")
                    .map_err(|e| format!("SESSION_IMPORT_DB_FAILED: {}", e))?;
            }
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(format!("SESSION_IMPORT_DB_FAILED: {}", error));
            }
        }

        Ok(json!({
            "success": true,
            "sessionId": new_session.id,
            "title": new_session.title,
            "mode": new_session.mode,
            "importedFromSessionId": stats.original_session_id,
            "messageCount": new_messages.len(),
            "blockCount": new_blocks.len(),
            "droppedOrphanBlocks": stats.orphan_blocks,
            "droppedMissingBlockRefs": stats.missing_block_refs,
            "attachmentsNote": "消息中的附件仅保留元数据引用；原始附件二进制不随 JSON 导出，跨设备导入后可能无法读取。",
            "hint": "导入完成：已创建新会话（未分组、无标签），可用 session_get / session_get_messages 验证内容。"
        }))
    }

    fn execute_group_list(ctx: &ExecutionContext) -> Result<Value, String> {
        let db = Self::get_db(ctx)?;
        let conn = db.get_conn_safe().map_err(|e| e.to_string())?;

        let groups = ChatV2Repo::list_groups_with_conn(&conn, Some("active"), None)
            .map_err(|e| e.to_string())?;

        let items: Vec<Value> = groups
            .iter()
            .map(|g| {
                json!({
                    "id": g.id,
                    "name": g.name,
                    "description": g.description,
                    "icon": g.icon,
                    "color": g.color,
                    "sortOrder": g.sort_order,
                    "defaultSkillIds": g.default_skill_ids,
                    "defaultRuntimeRootId": g.default_runtime_root_id,
                    "preferredProjectRootPath": g.preferred_project_root_path,
                    "systemPromptPreview": g.system_prompt.as_ref().map(|s| {
                        let preview: String = s.chars().take(50).collect();
                        if preview.len() < s.len() { format!("{}...", preview) } else { s.clone() }
                    })
                })
            })
            .collect();

        Ok(json!({
            "groups": items,
            "count": items.len()
        }))
    }

    fn execute_tag_list_all(ctx: &ExecutionContext) -> Result<Value, String> {
        let db = Self::get_db(ctx)?;
        let conn = db.get_conn_safe().map_err(|e| e.to_string())?;

        let tags = ChatV2Repo::list_all_tags(&conn).map_err(|e| e.to_string())?;

        let items: Vec<Value> = tags
            .iter()
            .map(|(tag, count)| json!({"tag": tag, "count": count}))
            .collect();

        Ok(json!({
            "tags": items,
            "totalTags": items.len()
        }))
    }

    fn execute_session_stats(ctx: &ExecutionContext) -> Result<Value, String> {
        let db = Self::get_db(ctx)?;
        let conn = db.get_conn_safe().map_err(|e| e.to_string())?;

        let active = ChatV2Repo::count_sessions_with_conn(&conn, Some("active"), None)
            .map_err(|e| e.to_string())?;
        let archived = ChatV2Repo::count_sessions_with_conn(&conn, Some("archived"), None)
            .map_err(|e| e.to_string())?;
        let deleted = ChatV2Repo::count_sessions_with_conn(&conn, Some("deleted"), None)
            .map_err(|e| e.to_string())?;

        let groups = ChatV2Repo::list_groups_with_conn(&conn, Some("active"), None)
            .map_err(|e| e.to_string())?;

        let ungrouped =
            ChatV2Repo::count_sessions_with_conn(&conn, Some("active"), Some("")).unwrap_or(0);

        let mut group_stats: Vec<Value> = Vec::new();
        for g in &groups {
            let count = ChatV2Repo::count_sessions_with_conn(&conn, Some("active"), Some(&g.id))
                .unwrap_or(0);
            group_stats.push(json!({
                "groupId": g.id,
                "groupName": g.name,
                "sessionCount": count
            }));
        }

        let tags = ChatV2Repo::list_all_tags(&conn).map_err(|e| e.to_string())?;

        Ok(json!({
            "total": active + archived + deleted,
            "active": active,
            "archived": archived,
            "deleted": deleted,
            "groups": {
                "count": groups.len(),
                "distribution": group_stats,
                "ungroupedCount": ungrouped
            },
            "tags": {
                "uniqueCount": tags.len(),
                "top10": tags.iter().take(10).map(|(t, c)| json!({"tag": t, "count": c})).collect::<Vec<_>>()
            }
        }))
    }

    // ========================================================================
    // 写操作
    // ========================================================================

    fn execute_session_tag_add(args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let db = Self::get_db(ctx)?;
        let conn = db.get_conn_safe().map_err(|e| e.to_string())?;

        let session_id = args
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or("缺少必需参数: session_id")?;
        let tag = args
            .get("tag")
            .and_then(|v| v.as_str())
            .ok_or("缺少必需参数: tag")?;

        Self::ensure_not_current_session(session_id, ctx, "标签添加")?;

        // 验证会话存在
        ChatV2Repo::get_session_with_conn(&conn, session_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("会话不存在: {}", session_id))?;

        ChatV2Repo::add_manual_tag(&conn, session_id, tag).map_err(|e| e.to_string())?;

        Ok(json!({
            "success": true,
            "sessionId": session_id,
            "tag": tag,
            "message": format!("已为会话添加标签「{}」", tag)
        }))
    }

    fn execute_session_tag_remove(args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let db = Self::get_db(ctx)?;
        let conn = db.get_conn_safe().map_err(|e| e.to_string())?;

        let session_id = args
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or("缺少必需参数: session_id")?;
        let tag = args
            .get("tag")
            .and_then(|v| v.as_str())
            .ok_or("缺少必需参数: tag")?;

        Self::ensure_not_current_session(session_id, ctx, "标签移除")?;

        ChatV2Repo::remove_tag(&conn, session_id, tag).map_err(|e| e.to_string())?;

        Ok(json!({
            "success": true,
            "sessionId": session_id,
            "tag": tag,
            "message": format!("已移除标签「{}」", tag)
        }))
    }

    fn execute_session_move(args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let db = Self::get_db(ctx)?;
        let conn = db.get_conn_safe().map_err(|e| e.to_string())?;

        let session_id = args
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or("缺少必需参数: session_id")?;
        let group_id = args.get("group_id").and_then(|v| v.as_str());

        Self::ensure_not_current_session(session_id, ctx, "分组移动")?;

        // 验证目标分组存在
        if let Some(gid) = group_id {
            let group = ChatV2Repo::get_group_with_conn(&conn, gid)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("分组不存在: {}", gid))?;
            if group.persist_status != PersistStatus::Active {
                return Err(format!("分组已被删除: {}", gid));
            }
        }

        ChatV2Repo::update_session_group_with_conn(&conn, session_id, group_id)
            .map_err(|e| e.to_string())?;

        let msg = match group_id {
            Some(gid) => {
                let name = ChatV2Repo::get_group_with_conn(&conn, gid)
                    .ok()
                    .flatten()
                    .map(|g| g.name)
                    .unwrap_or_else(|| gid.to_string());
                format!("已将会话移入分组「{}」", name)
            }
            None => "已将会话移出分组".to_string(),
        };

        Ok(json!({
            "success": true,
            "sessionId": session_id,
            "groupId": group_id,
            "message": msg
        }))
    }

    fn execute_session_rename(args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let db = Self::get_db(ctx)?;

        let session_id = args
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or("缺少必需参数: session_id")?;
        let title = args
            .get("title")
            .and_then(|v| v.as_str())
            .ok_or("缺少必需参数: title")?;

        Self::ensure_not_current_session(session_id, ctx, "重命名")?;

        let existing = ChatV2Repo::get_session_v2(db, session_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("会话不存在: {}", session_id))?;

        let updated = ChatSession {
            title: Some(title.to_string()),
            updated_at: chrono::Utc::now(),
            ..existing
        };

        ChatV2Repo::update_session_v2(db, &updated).map_err(|e| e.to_string())?;

        Ok(json!({
            "success": true,
            "sessionId": session_id,
            "title": title,
            "message": format!("已将会话重命名为「{}」", title)
        }))
    }

    fn execute_group_create(args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let db = Self::get_db(ctx)?;
        let conn = db.get_conn_safe().map_err(|e| e.to_string())?;

        let name = args
            .get("name")
            .and_then(|v| v.as_str())
            .ok_or("缺少必需参数: name")?;
        let description = args.get("description").and_then(|v| v.as_str());
        let icon = args.get("icon").and_then(|v| v.as_str());
        let color = args.get("color").and_then(|v| v.as_str());

        let existing = ChatV2Repo::list_groups_with_conn(&conn, Some("active"), None)
            .map_err(|e| e.to_string())?;
        let next_sort = existing.iter().map(|g| g.sort_order).max().unwrap_or(0) + 1;

        let now = chrono::Utc::now();
        let group = SessionGroup {
            id: SessionGroup::generate_id(),
            name: name.to_string(),
            description: description.map(String::from),
            icon: icon.map(String::from),
            color: color.map(String::from),
            system_prompt: None,
            default_skill_ids: vec![],
            pinned_resource_ids: vec![],
            workspace_id: None,
            default_runtime_root_id: None,
            preferred_project_root_path: None,
            sort_order: next_sort,
            persist_status: PersistStatus::Active,
            created_at: now,
            updated_at: now,
        };

        ChatV2Repo::create_group_with_conn(&conn, &group).map_err(|e| e.to_string())?;

        Ok(json!({
            "success": true,
            "groupId": group.id,
            "name": name,
            "message": format!("已创建分组「{}」({})", name, group.id)
        }))
    }

    fn execute_group_update(args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let db = Self::get_db(ctx)?;
        let conn = db.get_conn_safe().map_err(|e| e.to_string())?;

        let group_id = args
            .get("group_id")
            .and_then(|v| v.as_str())
            .ok_or("缺少必需参数: group_id")?;

        let existing = ChatV2Repo::get_group_with_conn(&conn, group_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("分组不存在: {}", group_id))?;

        // 与 group_handlers.rs 一致：None→保留, Some("")→清除, Some(val)→更新
        fn merge_opt(request_val: Option<&str>, existing_val: Option<String>) -> Option<String> {
            match request_val {
                None => existing_val,
                Some(s) if s.trim().is_empty() => None,
                Some(s) => Some(s.to_string()),
            }
        }

        let updated = SessionGroup {
            name: args
                .get("name")
                .and_then(|v| v.as_str())
                .map(String::from)
                .unwrap_or(existing.name),
            description: merge_opt(
                args.get("description").and_then(|v| v.as_str()),
                existing.description,
            ),
            icon: merge_opt(args.get("icon").and_then(|v| v.as_str()), existing.icon),
            color: merge_opt(args.get("color").and_then(|v| v.as_str()), existing.color),
            updated_at: chrono::Utc::now(),
            ..existing
        };

        ChatV2Repo::update_group_with_conn(&conn, &updated).map_err(|e| e.to_string())?;

        Ok(json!({
            "success": true,
            "groupId": group_id,
            "message": format!("已更新分组「{}」", updated.name)
        }))
    }

    // ========================================================================
    // 危险操作
    // ========================================================================

    fn execute_session_archive(args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let db = Self::get_db(ctx)?;

        let session_id = args
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or("缺少必需参数: session_id")?;

        Self::ensure_not_current_session(session_id, ctx, "归档")?;

        let existing = ChatV2Repo::get_session_v2(db, session_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("会话不存在: {}", session_id))?;

        if existing.persist_status != PersistStatus::Active {
            return Err(format!(
                "只能归档活跃会话，当前状态: {:?}",
                existing.persist_status
            ));
        }

        let archived = manually_archive_session(existing);

        ChatV2Repo::update_session_v2(db, &archived).map_err(|e| e.to_string())?;

        Ok(json!({
            "success": true,
            "sessionId": session_id,
            "message": format!("已归档会话「{}」", archived.title.unwrap_or_else(|| session_id.to_string()))
        }))
    }

    fn execute_session_restore(args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let db = Self::get_db(ctx)?;

        let session_id = args
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or("缺少必需参数: session_id")?;

        Self::ensure_not_current_session(session_id, ctx, "恢复")?;

        let existing = ChatV2Repo::get_session_v2(db, session_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("会话不存在: {}", session_id))?;

        if existing.persist_status == PersistStatus::Active {
            return Err("会话已是活跃状态，无需恢复".to_string());
        }

        ensure_session_group_restorable(db, &existing)?;

        let restored = ChatSession {
            persist_status: PersistStatus::Active,
            updated_at: chrono::Utc::now(),
            ..existing
        };

        ChatV2Repo::update_session_v2(db, &restored).map_err(|e| e.to_string())?;

        Ok(json!({
            "success": true,
            "sessionId": session_id,
            "message": format!("已恢复会话「{}」", restored.title.unwrap_or_else(|| session_id.to_string()))
        }))
    }

    fn execute_session_batch_move(args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let db = Self::get_db(ctx)?;
        let conn = db.get_conn_safe().map_err(|e| e.to_string())?;

        let session_ids: Vec<String> =
            get_string_array_arg(args, "session_ids").ok_or("缺少必需参数: session_ids")?;

        let group_id = args.get("group_id").and_then(|v| v.as_str());
        let confirmed = args
            .get("confirmed")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if session_ids.is_empty() {
            return Err("session_ids 不能为空".to_string());
        }
        if session_ids.len() > 50 {
            return Err("单次批量操作不能超过 50 个会话".to_string());
        }
        if Self::batch_move_confirmation_required(session_ids.len()) && !confirmed {
            return Err("批量移动超过 3 个会话时，需要用户确认并传入 confirmed=true".to_string());
        }
        if session_ids.iter().any(|sid| sid == &ctx.session_id) {
            return Err("批量移动不能包含当前正在使用的会话".to_string());
        }

        // 验证目标分组
        if let Some(gid) = group_id {
            let group = ChatV2Repo::get_group_with_conn(&conn, gid)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("分组不存在: {}", gid))?;
            if group.persist_status != PersistStatus::Active {
                return Err(format!("分组已被删除: {}", gid));
            }
        }

        let mut moved = 0;
        let mut errors: Vec<String> = Vec::new();

        for sid in &session_ids {
            match ChatV2Repo::update_session_group_with_conn(&conn, sid, group_id) {
                Ok(_) => moved += 1,
                Err(e) => errors.push(format!("{}: {}", sid, e)),
            }
        }

        Ok(json!({
            "success": errors.is_empty(),
            "moved": moved,
            "total": session_ids.len(),
            "errors": errors,
            "groupId": group_id,
            "message": format!("已移动 {}/{} 个会话", moved, session_ids.len())
        }))
    }

    fn execute_session_batch_tag(args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let db = Self::get_db(ctx)?;
        let conn = db.get_conn_safe().map_err(|e| e.to_string())?;

        let session_ids: Vec<String> =
            get_string_array_arg(args, "session_ids").ok_or("缺少必需参数: session_ids")?;

        let tag = args
            .get("tag")
            .and_then(|v| v.as_str())
            .ok_or("缺少必需参数: tag")?;
        let confirmed = args
            .get("confirmed")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if session_ids.is_empty() {
            return Err("session_ids 不能为空".to_string());
        }
        if session_ids.len() > 50 {
            return Err("单次批量操作不能超过 50 个会话".to_string());
        }
        if Self::batch_tag_confirmation_required(session_ids.len()) && !confirmed {
            return Err("批量打标超过 5 个会话时，需要用户确认并传入 confirmed=true".to_string());
        }
        if session_ids.iter().any(|sid| sid == &ctx.session_id) {
            return Err("批量打标不能包含当前正在使用的会话".to_string());
        }

        let mut tagged = 0;
        let mut errors: Vec<String> = Vec::new();
        for sid in &session_ids {
            match ChatV2Repo::add_manual_tag(&conn, sid, tag) {
                Ok(_) => tagged += 1,
                Err(e) => errors.push(format!("{}: {}", sid, e)),
            }
        }

        Ok(json!({
            "success": errors.is_empty(),
            "tagged": tagged,
            "total": session_ids.len(),
            "tag": tag,
            "errors": errors,
            "message": format!("已为 {}/{} 个会话添加标签「{}」", tagged, session_ids.len(), tag)
        }))
    }

    fn execute_session_batch_ops(args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let db = Self::get_db(ctx)?;
        let conn = db.get_conn_safe().map_err(|e| e.to_string())?;

        let raw_ops = get_json_array_arg(args, "operations").ok_or("缺少必需参数: operations")?;
        if raw_ops.is_empty() {
            return Err("operations 不能为空".to_string());
        }
        if raw_ops.len() > MAX_BATCH_OPS_PER_CALL {
            return Err(format!(
                "operations 过多：单次最多 {} 条",
                MAX_BATCH_OPS_PER_CALL
            ));
        }

        #[derive(Clone)]
        struct BatchOp {
            session_id: String,
            action: String,
            group_id: Option<String>,
            tag: Option<String>,
            title: Option<String>,
        }

        let mut operations: Vec<BatchOp> = Vec::with_capacity(raw_ops.len());
        let mut unique_session_ids: HashSet<String> = HashSet::new();

        for (index, raw) in raw_ops.iter().enumerate() {
            let obj = raw
                .as_object()
                .ok_or_else(|| format!("operations[{}] 必须是对象", index))?;

            let session_id = obj
                .get("session_id")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| format!("operations[{}] 缺少必需参数: session_id", index))?;

            let action = obj
                .get("action")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| format!("operations[{}] 缺少必需参数: action", index))?;

            unique_session_ids.insert(session_id.clone());
            operations.push(BatchOp {
                session_id,
                action,
                group_id: obj
                    .get("group_id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                tag: obj
                    .get("tag")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                title: obj
                    .get("title")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
            });
        }

        if unique_session_ids.len() > 50 {
            return Err("单次 unified 批量操作最多涉及 50 个不同会话".to_string());
        }
        let has_archive = operations.iter().any(|op| op.action == "archive");
        let confirmed = args
            .get("confirmed")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if Self::batch_ops_confirmation_required(unique_session_ids.len(), has_archive)
            && !confirmed
        {
            return Err(
                "批量操作需要显式确认：请先征得用户同意，然后以 confirmed=true 重新调用"
                    .to_string(),
            );
        }

        // 全量预校验：避免执行到中途才因参数问题失败（导致前半段已生效）。
        for (index, op) in operations.iter().enumerate() {
            match op.action.as_str() {
                "move" => {
                    Self::ensure_not_current_session(&op.session_id, ctx, "分组移动")
                        .map_err(|e| format!("operations[{}]: {}", index, e))?;
                }
                "tag_add" | "tag_remove" => {
                    Self::ensure_not_current_session(&op.session_id, ctx, "标签操作")
                        .map_err(|e| format!("operations[{}]: {}", index, e))?;
                    let has_tag = op
                        .tag
                        .as_deref()
                        .map(|s| !s.trim().is_empty())
                        .unwrap_or(false);
                    if !has_tag {
                        return Err(format!(
                            "operations[{}] action={} 缺少必需参数: tag",
                            index, op.action
                        ));
                    }
                }
                "rename" => {
                    Self::ensure_not_current_session(&op.session_id, ctx, "重命名")
                        .map_err(|e| format!("operations[{}]: {}", index, e))?;
                    let has_title = op
                        .title
                        .as_deref()
                        .map(|s| !s.trim().is_empty())
                        .unwrap_or(false);
                    if !has_title {
                        return Err(format!(
                            "operations[{}] action=rename 缺少必需参数: title",
                            index
                        ));
                    }
                }
                "archive" => {
                    Self::ensure_not_current_session(&op.session_id, ctx, "归档")
                        .map_err(|e| format!("operations[{}]: {}", index, e))?;
                }
                "restore" => {
                    Self::ensure_not_current_session(&op.session_id, ctx, "恢复")
                        .map_err(|e| format!("operations[{}]: {}", index, e))?;
                }
                _ => {
                    return Err(format!(
                        "operations[{}] 不支持的 action: {}",
                        index, op.action
                    ));
                }
            }
        }

        // 预先验证 move 目标分组，避免执行到中途才发现分组非法。
        let mut checked_groups: HashSet<String> = HashSet::new();
        for op in &operations {
            if op.action != "move" {
                continue;
            }
            if let Some(gid) = op
                .group_id
                .as_deref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
            {
                if checked_groups.contains(gid) {
                    continue;
                }
                let group = ChatV2Repo::get_group_with_conn(&conn, gid)
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| format!("分组不存在: {}", gid))?;
                if group.persist_status != PersistStatus::Active {
                    return Err(format!("分组已被删除: {}", gid));
                }
                checked_groups.insert(gid.to_string());
            }
        }

        let mut applied = 0usize;
        let mut failed = 0usize;
        let mut attempted_by_action: HashMap<String, usize> = HashMap::new();
        let mut applied_by_action: HashMap<String, usize> = HashMap::new();
        let mut failed_by_action: HashMap<String, usize> = HashMap::new();
        let mut results: Vec<Value> = Vec::with_capacity(operations.len());

        for (index, op) in operations.iter().enumerate() {
            *attempted_by_action.entry(op.action.clone()).or_insert(0) += 1;

            let result: Result<String, String> = match op.action.as_str() {
                "move" => {
                    let group_id = op
                        .group_id
                        .as_deref()
                        .map(|s| s.trim())
                        .filter(|s| !s.is_empty());
                    ChatV2Repo::update_session_group_with_conn(&conn, &op.session_id, group_id)
                        .map_err(|e| e.to_string())?;
                    Ok(match group_id {
                        Some(gid) => format!("已移动到分组 {}", gid),
                        None => "已移出分组".to_string(),
                    })
                }
                "tag_add" => {
                    let tag = op
                        .tag
                        .as_deref()
                        .ok_or("action=tag_add 时缺少必需参数: tag")?;
                    ChatV2Repo::get_session_with_conn(&conn, &op.session_id)
                        .map_err(|e| e.to_string())?
                        .ok_or_else(|| format!("会话不存在: {}", op.session_id))?;
                    ChatV2Repo::add_manual_tag(&conn, &op.session_id, tag)
                        .map_err(|e| e.to_string())?;
                    Ok(format!("已添加标签 {}", tag))
                }
                "tag_remove" => {
                    let tag = op
                        .tag
                        .as_deref()
                        .ok_or("action=tag_remove 时缺少必需参数: tag")?;
                    ChatV2Repo::remove_tag(&conn, &op.session_id, tag)
                        .map_err(|e| e.to_string())?;
                    Ok(format!("已移除标签 {}", tag))
                }
                "rename" => {
                    let title = op
                        .title
                        .as_deref()
                        .ok_or("action=rename 时缺少必需参数: title")?;
                    let existing = ChatV2Repo::get_session_v2(db, &op.session_id)
                        .map_err(|e| e.to_string())?
                        .ok_or_else(|| format!("会话不存在: {}", op.session_id))?;
                    let updated = ChatSession {
                        title: Some(title.to_string()),
                        updated_at: chrono::Utc::now(),
                        ..existing
                    };
                    ChatV2Repo::update_session_v2(db, &updated).map_err(|e| e.to_string())?;
                    Ok(format!("已重命名为 {}", title))
                }
                "archive" => {
                    let existing = ChatV2Repo::get_session_v2(db, &op.session_id)
                        .map_err(|e| e.to_string())?
                        .ok_or_else(|| format!("会话不存在: {}", op.session_id))?;
                    if existing.persist_status != PersistStatus::Active {
                        Err(format!(
                            "只能归档活跃会话，当前状态: {:?}",
                            existing.persist_status
                        ))
                    } else {
                        let archived = manually_archive_session(existing);
                        ChatV2Repo::update_session_v2(db, &archived).map_err(|e| e.to_string())?;
                        Ok("已归档".to_string())
                    }
                }
                "restore" => {
                    let existing = ChatV2Repo::get_session_v2(db, &op.session_id)
                        .map_err(|e| e.to_string())?
                        .ok_or_else(|| format!("会话不存在: {}", op.session_id))?;
                    if existing.persist_status == PersistStatus::Active {
                        Err("会话已是活跃状态，无需恢复".to_string())
                    } else {
                        ensure_session_group_restorable(db, &existing)?;
                        let restored = ChatSession {
                            persist_status: PersistStatus::Active,
                            updated_at: chrono::Utc::now(),
                            ..existing
                        };
                        ChatV2Repo::update_session_v2(db, &restored).map_err(|e| e.to_string())?;
                        Ok("已恢复为活跃状态".to_string())
                    }
                }
                _ => Err(format!("不支持的 action: {}", op.action)),
            };

            match result {
                Ok(message) => {
                    applied += 1;
                    *applied_by_action.entry(op.action.clone()).or_insert(0) += 1;
                    results.push(json!({
                        "index": index,
                        "sessionId": op.session_id,
                        "action": op.action,
                        "success": true,
                        "message": message
                    }));
                }
                Err(error) => {
                    failed += 1;
                    *failed_by_action.entry(op.action.clone()).or_insert(0) += 1;
                    results.push(json!({
                        "index": index,
                        "sessionId": op.session_id,
                        "action": op.action,
                        "success": false,
                        "error": error
                    }));
                }
            }
        }

        Ok(json!({
            "success": failed == 0,
            "totalOperations": operations.len(),
            "totalSessions": unique_session_ids.len(),
            "applied": applied,
            "failed": failed,
            "actionStats": {
                "attempted": attempted_by_action,
                "applied": applied_by_action,
                "failed": failed_by_action
            },
            "results": results,
            "message": format!("统一批量操作完成：成功 {}，失败 {}", applied, failed)
        }))
    }
}

// ============================================================================
// 辅助函数
// ============================================================================

fn ensure_session_group_restorable(
    db: &ChatV2Database,
    session: &ChatSession,
) -> Result<(), String> {
    let Some(group_id) = session.group_id.as_deref() else {
        return Ok(());
    };
    let conn = db.get_conn_safe().map_err(|e| e.to_string())?;
    let group = ChatV2Repo::get_group_with_conn(&conn, group_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("会话归属课题不存在: {}", group_id))?;
    match group.persist_status {
        PersistStatus::Active => Ok(()),
        PersistStatus::Archived => {
            Err("该会话属于已归档课题，请先恢复整个课题，避免历史会话脱离课题分组。".to_string())
        }
        PersistStatus::Deleted => Err(format!("会话归属课题已删除: {}", group_id)),
    }
}

fn manually_archive_session(mut existing: ChatSession) -> ChatSession {
    let now = chrono::Utc::now();
    let mut metadata = existing
        .metadata
        .take()
        .unwrap_or_else(|| Value::Object(Default::default()));
    if !metadata.is_object() {
        metadata = Value::Object(Default::default());
    }
    if let Some(obj) = metadata.as_object_mut() {
        obj.insert(
            MANUALLY_ARCHIVED_BY_KEY.to_string(),
            json!({
                "archivedAt": now.to_rfc3339(),
            }),
        );
    }

    ChatSession {
        persist_status: PersistStatus::Archived,
        updated_at: now,
        metadata: Some(metadata),
        ..existing
    }
}

fn session_to_summary(s: &ChatSession) -> Value {
    json!({
        "id": s.id,
        "mode": s.mode,
        "title": s.title,
        "description": s.description,
        "persistStatus": format!("{:?}", s.persist_status).to_lowercase(),
        "createdAt": s.created_at.to_rfc3339(),
        "updatedAt": s.updated_at.to_rfc3339(),
        "groupId": s.group_id
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SessionExportRange {
    start_message_id: Option<String>,
    end_message_id: Option<String>,
}

#[derive(Debug)]
struct PreparedSessionExport {
    session_id: String,
    title: String,
    markdown: String,
    message_count: usize,
    range: Option<Value>,
}

fn required_non_empty_string<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    let value = args
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("SESSION_INVALID_ARGUMENT: {} is required", key))?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!(
            "SESSION_INVALID_ARGUMENT: {} must not be empty",
            key
        ));
    }
    Ok(trimmed)
}

fn optional_non_empty_string<'a>(args: &'a Value, key: &str) -> Result<Option<&'a str>, String> {
    let Some(value) = args.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let value = value
        .as_str()
        .ok_or_else(|| format!("SESSION_INVALID_ARGUMENT: {} must be a string", key))?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!(
            "SESSION_INVALID_ARGUMENT: {} must not be empty",
            key
        ));
    }
    Ok(Some(trimmed))
}

fn parse_bounded_u32(
    args: &Value,
    key: &str,
    default: u32,
    min: u32,
    max: u32,
) -> Result<u32, String> {
    let Some(value) = args.get(key) else {
        return Ok(default);
    };
    let parsed = value
        .as_u64()
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| format!("SESSION_INVALID_ARGUMENT: {} must be an integer", key))?;
    if !(min..=max).contains(&parsed) {
        return Err(format!(
            "SESSION_INVALID_ARGUMENT: {} must be between {} and {}",
            key, min, max
        ));
    }
    Ok(parsed)
}

fn parse_role_filter(args: &Value) -> Result<Option<&str>, String> {
    let Some(role) = optional_non_empty_string(args, "role_filter")? else {
        return Ok(None);
    };
    match role {
        "user" | "assistant" => Ok(Some(role)),
        _ => Err("SESSION_INVALID_ROLE_FILTER: expected one of user or assistant".to_string()),
    }
}

fn normalize_date_bound(raw: &str, is_end: bool) -> Result<String, String> {
    let trimmed = raw.trim();
    if let Ok(value) = DateTime::parse_from_rfc3339(trimmed) {
        return Ok(value
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true));
    }

    if let Ok(date) = NaiveDate::parse_from_str(trimmed, "%Y-%m-%d") {
        let naive = if is_end {
            date.and_hms_milli_opt(23, 59, 59, 999)
        } else {
            date.and_hms_milli_opt(0, 0, 0, 0)
        }
        .expect("valid date components");
        return Ok(naive.and_utc().to_rfc3339_opts(SecondsFormat::Millis, true));
    }

    Err(format!(
        "SESSION_INVALID_DATE: expected YYYY-MM-DD or RFC3339, got {}",
        trimmed
    ))
}

fn parse_search_date_range(args: &Value) -> Result<(Option<String>, Option<String>), String> {
    let date_from = optional_non_empty_string(args, "date_from")?
        .map(|value| normalize_date_bound(value, false))
        .transpose()?;
    let date_to = optional_non_empty_string(args, "date_to")?
        .map(|value| normalize_date_bound(value, true))
        .transpose()?;

    if let (Some(from), Some(to)) = (&date_from, &date_to) {
        let from = DateTime::parse_from_rfc3339(from).expect("normalized RFC3339 date_from");
        let to = DateTime::parse_from_rfc3339(to).expect("normalized RFC3339 date_to");
        if from > to {
            return Err("SESSION_INVALID_DATE_RANGE: date_from is after date_to".to_string());
        }
    }

    Ok((date_from, date_to))
}

fn truncate_field(value: &str, max_chars: usize) -> (String, bool) {
    let mut chars = value.chars();
    let prefix: String = chars.by_ref().take(max_chars).collect();
    (prefix, chars.next().is_some())
}

fn group_blocks_by_message(blocks: &[MessageBlock]) -> HashMap<&str, Vec<&MessageBlock>> {
    let mut grouped: HashMap<&str, Vec<&MessageBlock>> = HashMap::new();
    for block in blocks {
        grouped
            .entry(block.message_id.as_str())
            .or_default()
            .push(block);
    }
    for message_blocks in grouped.values_mut() {
        message_blocks.sort_by_key(|block| block.block_index);
    }
    grouped
}

fn visible_blocks_for_message<'a>(
    message: &ChatMessage,
    message_blocks: &[&'a MessageBlock],
) -> Vec<&'a MessageBlock> {
    let selected_ids = message
        .active_variant_id
        .as_deref()
        .and_then(|active_id| {
            message
                .variants
                .as_ref()?
                .iter()
                .find(|variant| variant.id == active_id)
                .map(|variant| variant.block_ids.as_slice())
        })
        .filter(|ids| !ids.is_empty())
        .or_else(|| (!message.block_ids.is_empty()).then_some(message.block_ids.as_slice()));

    let Some(selected_ids) = selected_ids else {
        return message_blocks.to_vec();
    };

    let by_id: HashMap<&str, &MessageBlock> = message_blocks
        .iter()
        .map(|block| (block.id.as_str(), *block))
        .collect();
    selected_ids
        .iter()
        .filter_map(|id| by_id.get(id.as_str()).copied())
        .collect()
}

fn role_name(role: &MessageRole) -> &'static str {
    match role {
        MessageRole::User => "user",
        MessageRole::Assistant => "assistant",
    }
}

fn timestamp_iso(timestamp: i64) -> Option<String> {
    DateTime::<Utc>::from_timestamp_millis(timestamp)
        .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn message_content(blocks: &[&MessageBlock]) -> String {
    blocks
        .iter()
        .filter(|block| block.block_type == "content")
        .filter_map(|block| block.content.as_deref())
        .filter(|content| !content.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn tool_output_summary(output: Option<&Value>) -> (String, bool) {
    let Some(output) = output else {
        return (
            "Tool completed without a persisted output".to_string(),
            false,
        );
    };
    match output {
        Value::Null => ("Tool returned null".to_string(), false),
        Value::Bool(value) => (format!("Tool returned {}", value), false),
        Value::Number(value) => (format!("Tool returned {}", value), false),
        Value::String(value) => {
            let total_chars = value.chars().count();
            let (preview, truncated) = truncate_field(value, MAX_TOOL_OUTPUT_PREVIEW_CHARS);
            (
                format!(
                    "Tool returned text ({} characters): {}",
                    total_chars, preview
                ),
                truncated,
            )
        }
        Value::Array(values) => (
            format!("Tool returned an array with {} items", values.len()),
            false,
        ),
        Value::Object(values) => {
            for key in ["summary", "message", "error"] {
                if let Some(value) = values.get(key).and_then(Value::as_str) {
                    if !value.trim().is_empty() {
                        let total_chars = value.chars().count();
                        let (preview, truncated) =
                            truncate_field(value, MAX_TOOL_OUTPUT_PREVIEW_CHARS);
                        return (
                            format!("{} ({} characters): {}", key, total_chars, preview),
                            truncated,
                        );
                    }
                }
            }

            let mut facts = Vec::new();
            for key in [
                "success", "status", "count", "total", "created", "updated", "deleted",
            ] {
                if let Some(value) = values.get(key) {
                    if value.is_boolean() || value.is_number() || value.is_string() {
                        facts.push(format!("{}={}", key, value));
                    }
                }
            }
            if !facts.is_empty() {
                return (facts.join(", "), false);
            }

            let mut keys: Vec<&str> = values.keys().map(String::as_str).collect();
            keys.sort_unstable();
            keys.truncate(12);
            if keys.is_empty() {
                ("Tool returned an empty object".to_string(), false)
            } else {
                (
                    format!("Tool returned fields: {}", keys.join(", ")),
                    values.len() > keys.len(),
                )
            }
        }
    }
}

fn block_to_summary(block: &MessageBlock) -> Value {
    let is_tool_output = block.tool_name.is_some()
        || block.tool_output.is_some()
        || matches!(block.block_type.as_str(), "mcp_tool" | "workbench_ops");
    let (raw_summary, source_truncated) = if block.block_type == "thinking" {
        ("Model reasoning (hidden)".to_string(), false)
    } else if is_tool_output {
        tool_output_summary(block.tool_output.as_ref())
    } else {
        (
            block.content.clone().unwrap_or_else(|| {
                if let Some(citations) = block.citations.as_ref() {
                    format!("{} citations", citations.len())
                } else {
                    format!("{} block", block.block_type)
                }
            }),
            false,
        )
    };
    let (summary, summary_truncated) = truncate_field(&raw_summary, MAX_TOOL_FIELD_CHARS);
    let (error, error_truncated) = block
        .error
        .as_deref()
        .map(|value| truncate_field(value, MAX_TOOL_FIELD_CHARS))
        .unwrap_or_default();

    json!({
        "id": block.id,
        "type": block.block_type,
        "status": block.status,
        "toolName": block.tool_name,
        "isToolOutput": is_tool_output,
        "summary": summary,
        "summaryTruncated": summary_truncated || source_truncated,
        "toolOutputTruncated": is_tool_output && source_truncated,
        "error": if error.is_empty() { None } else { Some(error) },
        "errorTruncated": error_truncated,
        "truncated": summary_truncated || source_truncated || error_truncated,
        "citationCount": block.citations.as_ref().map(Vec::len),
        "startedAt": block.started_at,
        "endedAt": block.ended_at
    })
}

fn message_to_tool_value(message: &ChatMessage, blocks: &[&MessageBlock]) -> Value {
    let raw_content = message_content(blocks);
    let (content, content_truncated) = truncate_field(&raw_content, MAX_TOOL_FIELD_CHARS);
    let block_summaries: Vec<Value> = blocks.iter().map(|block| block_to_summary(block)).collect();
    let attachments: Vec<Value> = message
        .attachments
        .as_ref()
        .map(|attachments| {
            attachments
                .iter()
                .map(|attachment| {
                    let (name, name_truncated) =
                        truncate_field(&attachment.name, MAX_TOOL_FIELD_CHARS);
                    let (error, error_truncated) = attachment
                        .error
                        .as_deref()
                        .map(|value| truncate_field(value, MAX_TOOL_FIELD_CHARS))
                        .unwrap_or_default();
                    json!({
                        "id": attachment.id,
                        "name": name,
                        "type": attachment.r#type,
                        "mimeType": attachment.mime_type,
                        "size": attachment.size,
                        "status": attachment.status,
                        "error": if error.is_empty() { None } else { Some(error) },
                        "truncated": name_truncated || error_truncated
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    json!({
        "id": message.id,
        "role": role_name(&message.role),
        "timestamp": message.timestamp,
        "timestampIso": timestamp_iso(message.timestamp),
        "content": content,
        "truncated": content_truncated,
        "blocks": block_summaries,
        "attachments": attachments
    })
}

fn object_string_alias(
    object: &serde_json::Map<String, Value>,
    keys: &[&str],
) -> Result<Option<String>, String> {
    for key in keys {
        if let Some(value) = object.get(*key) {
            if value.is_null() {
                return Ok(None);
            }
            let value = value
                .as_str()
                .ok_or_else(|| format!("SESSION_INVALID_EXPORT_RANGE: {} must be a string", key))?;
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Err(format!(
                    "SESSION_INVALID_EXPORT_RANGE: {} must not be empty",
                    key
                ));
            }
            return Ok(Some(trimmed.to_string()));
        }
    }
    Ok(None)
}

fn parse_export_range(args: &Value) -> Result<Option<SessionExportRange>, String> {
    let Some(range) = args.get("range") else {
        return Ok(None);
    };
    if range.is_null() {
        return Ok(None);
    }
    let object = range
        .as_object()
        .ok_or("SESSION_INVALID_EXPORT_RANGE: range must be an object")?;
    let start_message_id = object_string_alias(
        object,
        &[
            "start_message_id",
            "from_message_id",
            "startMessageId",
            "fromMessageId",
        ],
    )?;
    let end_message_id = object_string_alias(
        object,
        &[
            "end_message_id",
            "to_message_id",
            "endMessageId",
            "toMessageId",
        ],
    )?;
    if start_message_id.is_none() && end_message_id.is_none() {
        return Ok(None);
    }
    Ok(Some(SessionExportRange {
        start_message_id,
        end_message_id,
    }))
}

fn select_export_messages<'a>(
    messages: &'a [ChatMessage],
    range: Option<&SessionExportRange>,
) -> Result<Vec<&'a ChatMessage>, String> {
    let Some(range) = range else {
        return Ok(messages.iter().collect());
    };
    if messages.is_empty() {
        return Ok(Vec::new());
    }

    let start = match range.start_message_id.as_deref() {
        Some(id) => messages
            .iter()
            .position(|message| message.id == id)
            .ok_or_else(|| format!("SESSION_EXPORT_RANGE_START_NOT_FOUND: {}", id))?,
        None => 0,
    };
    let end = match range.end_message_id.as_deref() {
        Some(id) => messages
            .iter()
            .position(|message| message.id == id)
            .ok_or_else(|| format!("SESSION_EXPORT_RANGE_END_NOT_FOUND: {}", id))?,
        None => messages.len() - 1,
    };
    if start > end {
        return Err(
            "SESSION_INVALID_EXPORT_RANGE: start_message_id is after end_message_id".to_string(),
        );
    }
    Ok(messages[start..=end].iter().collect())
}

fn resolve_export_title(
    args: &Value,
    session_title: Option<&str>,
    session_id: &str,
) -> Result<String, String> {
    let raw = optional_non_empty_string(args, "title")?
        .or_else(|| {
            session_title
                .map(str::trim)
                .filter(|title| !title.is_empty())
        })
        .map(str::to_string)
        .unwrap_or_else(|| format!("Chat session {}", session_id));
    let single_line = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    Ok(truncate_field(&single_line, MAX_EXPORT_TITLE_CHARS).0)
}

fn render_session_markdown(
    title: &str,
    session_id: &str,
    messages: &[&ChatMessage],
    blocks: &[MessageBlock],
) -> String {
    let blocks_by_message = group_blocks_by_message(blocks);
    let mut markdown = format!("# {}\n\n> Session: `{}`\n", title, session_id);

    for message in messages {
        let message_blocks = blocks_by_message
            .get(message.id.as_str())
            .cloned()
            .unwrap_or_default();
        let visible_blocks = visible_blocks_for_message(message, &message_blocks);
        let role = match message.role {
            MessageRole::User => "User",
            MessageRole::Assistant => "Assistant",
        };
        markdown.push_str("\n## ");
        markdown.push_str(role);
        if let Some(timestamp) = timestamp_iso(message.timestamp) {
            markdown.push_str(" · ");
            markdown.push_str(&timestamp);
        }
        markdown.push_str("\n\n");

        let content = message_content(&visible_blocks);
        if !content.trim().is_empty() {
            markdown.push_str(content.trim());
            markdown.push('\n');
        } else {
            for block in visible_blocks.iter().filter(|block| {
                block.tool_name.is_some()
                    || block.tool_output.is_some()
                    || block.block_type == "mcp_tool"
            }) {
                let (summary, _) = tool_output_summary(block.tool_output.as_ref());
                let (summary, _) = truncate_field(&summary, MAX_TOOL_FIELD_CHARS);
                markdown.push_str("- Tool `");
                markdown.push_str(block.tool_name.as_deref().unwrap_or("unknown"));
                markdown.push_str("`: ");
                markdown.push_str(&summary);
                markdown.push('\n');
            }
        }

        if let Some(attachments) = message.attachments.as_ref() {
            for attachment in attachments {
                let (name, _) = truncate_field(&attachment.name, MAX_TOOL_FIELD_CHARS);
                markdown.push_str("- Attachment: ");
                markdown.push_str(&name);
                markdown.push_str(" (`");
                markdown.push_str(&attachment.mime_type);
                markdown.push_str("`)\n");
            }
        }
    }

    markdown
}

fn prepare_session_export(
    db: &ChatV2Database,
    args: &Value,
) -> Result<PreparedSessionExport, String> {
    let conn = db.get_conn_safe().map_err(|error| error.to_string())?;
    let session_id = required_non_empty_string(args, "session_id")?;
    let session = ChatV2Repo::get_session_with_conn(&conn, session_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("SESSION_NOT_FOUND: {}", session_id))?;
    let messages = ChatV2Repo::get_session_messages_with_conn(&conn, session_id)
        .map_err(|error| error.to_string())?;
    let blocks = ChatV2Repo::get_session_blocks_with_conn(&conn, session_id)
        .map_err(|error| error.to_string())?;
    let range = parse_export_range(args)?;
    let selected_messages = select_export_messages(&messages, range.as_ref())?;
    if selected_messages.is_empty() {
        return Err("SESSION_EXPORT_EMPTY_RANGE: no messages to export".to_string());
    }

    let title = resolve_export_title(args, session.title.as_deref(), session_id)?;
    let markdown = render_session_markdown(&title, session_id, &selected_messages, &blocks);
    let range_value = range.as_ref().map(|value| {
        json!({
            "startMessageId": value.start_message_id,
            "endMessageId": value.end_message_id
        })
    });

    Ok(PreparedSessionExport {
        session_id: session_id.to_string(),
        title,
        markdown,
        message_count: selected_messages.len(),
        range: range_value,
    })
}

fn markdown_export_to_tool_value(export: PreparedSessionExport) -> Value {
    let total_chars = export.markdown.chars().count();
    let (markdown, truncated) = truncate_field(&export.markdown, MAX_TOOL_FIELD_CHARS);
    json!({
        "success": true,
        "format": "markdown",
        "sessionId": export.session_id,
        "title": export.title,
        "range": export.range,
        "messageCount": export.message_count,
        "markdown": markdown,
        "totalChars": total_chars,
        "truncated": truncated
    })
}

// ============================================================================
// session_import：ID 重映射
// ============================================================================

struct ImportRemapStats {
    original_session_id: String,
    /// message_id 不在导出消息集内的块（被丢弃）
    orphan_blocks: usize,
    /// 消息 block_ids / 变体 block_ids 中指向缺失块的引用（被丢弃）
    missing_block_refs: usize,
}

/// 把导出的会话数据重映射为全新 ID，避免与本机既有数据主键冲突。
///
/// - 会话/消息/块 ID 全部重新生成；parent_id、supersedes、block_ids、
///   变体 block_ids 按映射表转换，指向导出集外的引用被置空/丢弃并计数。
/// - 会话强制 Active、未分组、无标签；metadata 记录 importedFromSessionId。
fn remap_imported_session(
    mut session: ChatSession,
    mut messages: Vec<ChatMessage>,
    mut blocks: Vec<MessageBlock>,
    title_override: Option<&str>,
) -> (
    ChatSession,
    Vec<ChatMessage>,
    Vec<MessageBlock>,
    ImportRemapStats,
) {
    let original_session_id = session.id.clone();
    let new_session_id = ChatSession::generate_id();

    let message_id_map: HashMap<String, String> = messages
        .iter()
        .map(|message| (message.id.clone(), ChatMessage::generate_id()))
        .collect();
    let block_id_map: HashMap<String, String> = blocks
        .iter()
        .map(|block| (block.id.clone(), MessageBlock::generate_id()))
        .collect();

    let mut orphan_blocks = 0usize;
    blocks.retain_mut(|block| {
        if let Some(new_message_id) = message_id_map.get(&block.message_id) {
            block.message_id = new_message_id.clone();
            if let Some(new_id) = block_id_map.get(&block.id) {
                block.id = new_id.clone();
            }
            true
        } else {
            orphan_blocks += 1;
            false
        }
    });

    let mut missing_block_refs = 0usize;
    for message in &mut messages {
        if let Some(new_id) = message_id_map.get(&message.id) {
            message.id = new_id.clone();
        }
        message.session_id = new_session_id.clone();
        message.persistent_stable_id = None;
        message.parent_id = message
            .parent_id
            .take()
            .and_then(|parent| message_id_map.get(&parent).cloned());
        message.supersedes = message
            .supersedes
            .take()
            .and_then(|superseded| message_id_map.get(&superseded).cloned());

        let before = message.block_ids.len();
        message.block_ids = message
            .block_ids
            .drain(..)
            .filter_map(|block_id| block_id_map.get(&block_id).cloned())
            .collect();
        missing_block_refs += before - message.block_ids.len();

        if let Some(variants) = message.variants.as_mut() {
            for variant in variants {
                let before = variant.block_ids.len();
                variant.block_ids = variant
                    .block_ids
                    .drain(..)
                    .filter_map(|block_id| block_id_map.get(&block_id).cloned())
                    .collect();
                missing_block_refs += before - variant.block_ids.len();
            }
        }
    }

    session.id = new_session_id;
    session.persist_status = PersistStatus::Active;
    session.group_id = None;
    session.tags = None;
    session.tags_hash = None;
    session.summary_hash = None;
    session.updated_at = Utc::now();
    if session.mode.trim().is_empty() {
        session.mode = "chat".to_string();
    }
    if let Some(title) = title_override {
        session.title = Some(title.to_string());
        session.title_locked = true;
    }
    let mut metadata = match session.metadata.take() {
        Some(Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    };
    metadata.insert(
        "importedFromSessionId".to_string(),
        json!(original_session_id),
    );
    metadata.insert("importedAt".to_string(), json!(Utc::now().to_rfc3339()));
    session.metadata = Some(Value::Object(metadata));

    (
        session,
        messages,
        blocks,
        ImportRemapStats {
            original_session_id,
            orphan_blocks,
            missing_block_refs,
        },
    )
}

// ============================================================================
// ToolExecutor 实现
// ============================================================================

#[async_trait]
impl ToolExecutor for SessionToolExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        let stripped = strip_tool_namespace(tool_name);
        is_session_tool(stripped)
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start = Instant::now();

        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let tool_name = strip_tool_namespace(&call.name);

        let result = match tool_name {
            "session_list" => Self::execute_session_list(&call.arguments, ctx),
            "session_search" => Self::execute_session_search(&call.arguments, ctx),
            "session_get" => Self::execute_session_get(&call.arguments, ctx),
            "session_get_messages" => Self::execute_session_get_messages(&call.arguments, ctx),
            "session_export" => Self::execute_session_export(&call.arguments, ctx),
            "session_import" => Self::execute_session_import(&call.arguments, ctx),
            "group_list" => Self::execute_group_list(ctx),
            "tag_list_all" => Self::execute_tag_list_all(ctx),
            "session_stats" => Self::execute_session_stats(ctx),
            "session_tag_add" => Self::execute_session_tag_add(&call.arguments, ctx),
            "session_tag_remove" => Self::execute_session_tag_remove(&call.arguments, ctx),
            "session_move" => Self::execute_session_move(&call.arguments, ctx),
            "session_rename" => Self::execute_session_rename(&call.arguments, ctx),
            "group_create" => Self::execute_group_create(&call.arguments, ctx),
            "group_update" => Self::execute_group_update(&call.arguments, ctx),
            "session_archive" => Self::execute_session_archive(&call.arguments, ctx),
            "session_restore" => Self::execute_session_restore(&call.arguments, ctx),
            "session_batch_move" => Self::execute_session_batch_move(&call.arguments, ctx),
            "session_batch_tag" => Self::execute_session_batch_tag(&call.arguments, ctx),
            "session_batch_ops" => Self::execute_session_batch_ops(&call.arguments, ctx),
            _ => Err(format!("未知的会话管理工具: {}", call.name)),
        };

        let duration_ms = start.elapsed().as_millis() as u64;

        match result {
            Ok(output) => {
                ctx.emit_tool_call_end(Some(json!({"result": output, "durationMs": duration_ms})));

                log::info!(
                    "{} Tool {} completed in {}ms",
                    LOG_PREFIX,
                    call.name,
                    duration_ms
                );

                // 写操作成功后通知前端刷新侧边栏
                let is_write_op = !matches!(
                    tool_name,
                    "session_list"
                        | "session_search"
                        | "session_get"
                        | "session_get_messages"
                        | "session_export"
                        | "group_list"
                        | "tag_list_all"
                        | "session_stats"
                );
                if is_write_op {
                    let _ = ctx.window_ref().emit(
                        SESSION_MGMT_EVENT,
                        json!({"tool": tool_name, "sessionId": ctx.session_id}),
                    );
                }

                let tool_result = ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration_ms,
                );

                if let Err(e) = ctx.save_tool_block(&tool_result) {
                    log::warn!("{} Failed to save tool block: {}", LOG_PREFIX, e);
                }

                Ok(tool_result)
            }
            Err(error) => {
                ctx.emit_tool_call_error(&error);

                log::warn!("{} Tool {} failed: {}", LOG_PREFIX, call.name, error);

                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error,
                    duration_ms,
                );

                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("{} Failed to save tool block: {}", LOG_PREFIX, e);
                }

                Ok(result)
            }
        }
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        match strip_tool_namespace(tool_name) {
            "session_archive" => ToolSensitivity::High,
            "session_export" | "session_import" => ToolSensitivity::Medium,
            "session_tag_add" | "session_tag_remove" | "session_move" | "session_rename"
            | "session_restore" | "group_create" | "group_update" => ToolSensitivity::Medium,
            "session_batch_tag" | "session_batch_move" | "session_batch_ops" => {
                ToolSensitivity::Medium
            }
            _ => ToolSensitivity::Low,
        }
    }

    fn sensitivity_level_for_call(&self, tool_name: &str, arguments: &Value) -> ToolSensitivity {
        if strip_tool_namespace(tool_name) == "session_batch_ops"
            && arguments
                .get("operations")
                .and_then(Value::as_array)
                .is_some_and(|operations| {
                    operations.iter().any(|operation| {
                        operation.get("action").and_then(Value::as_str) == Some("archive")
                    })
                })
        {
            ToolSensitivity::High
        } else {
            self.sensitivity_level(tool_name)
        }
    }

    fn concurrency_class(&self, tool_name: &str) -> ToolConcurrency {
        match strip_tool_namespace(tool_name) {
            // 只读子集：查询/搜索/统计/标签列表/分组列表，可并行 + 自动重试
            "session_list"
            | "session_search"
            | "session_get"
            | "session_get_messages"
            | "session_stats"
            | "tag_list_all"
            | "group_list" => ToolConcurrency::ReadOnly,
            // 重命名/移动/归档/打标签/批量操作等写操作，保持串行（默认）
            _ => ToolConcurrency::Serial,
        }
    }

    fn name(&self) -> &'static str {
        "SessionToolExecutor"
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_chat_db() -> (tempfile::TempDir, ChatV2Database) {
        use crate::data_governance::migration::coordinator::MigrationCoordinator;
        use crate::data_governance::schema_registry::DatabaseId;

        let temp_dir = tempfile::tempdir().expect("create ChatV2 test directory");
        let mut coordinator =
            MigrationCoordinator::new(temp_dir.path().to_path_buf()).with_audit_db(None);
        coordinator
            .migrate_single(DatabaseId::ChatV2)
            .expect("apply production ChatV2 migrations");
        let db = ChatV2Database::new(temp_dir.path()).expect("open migrated ChatV2 database");
        (temp_dir, db)
    }

    fn seed_persisted_session(db: &ChatV2Database) -> (String, String, String) {
        let session_id = "sess_executor_repo".to_string();
        let mut session = ChatSession::new(session_id.clone(), "chat".to_string());
        session.title = Some("Persisted export".to_string());
        ChatV2Repo::create_session_v2(db, &session).expect("persist session");

        let mut user = ChatMessage::new_user(session_id.clone(), Vec::new());
        user.id = "msg_executor_user".to_string();
        user.timestamp = 1_700_000_000_000;
        let mut user_content = MessageBlock::new_content(user.id.clone(), 0);
        user_content.id = "blk_executor_user".to_string();
        user_content.content = Some("Persisted user question".to_string());
        user_content.set_success();
        user.block_ids = vec![user_content.id.clone()];
        ChatV2Repo::create_message_v2(db, &user).expect("persist user message");
        ChatV2Repo::create_block_v2(db, &user_content).expect("persist user block");

        let mut assistant = ChatMessage::new_assistant(session_id.clone());
        assistant.id = "msg_executor_assistant".to_string();
        assistant.timestamp = 1_700_000_001_000;
        let mut thinking = MessageBlock::new_thinking(assistant.id.clone(), 0);
        thinking.id = "blk_executor_thinking".to_string();
        thinking.content = Some("private reasoning".to_string());
        thinking.set_success();
        let mut answer = MessageBlock::new_content(assistant.id.clone(), 1);
        answer.id = "blk_executor_answer".to_string();
        answer.content = Some("Persisted assistant answer".to_string());
        answer.set_success();
        assistant.block_ids = vec![thinking.id.clone(), answer.id.clone()];
        ChatV2Repo::create_message_v2(db, &assistant).expect("persist assistant message");
        ChatV2Repo::create_block_v2(db, &thinking).expect("persist thinking block");
        ChatV2Repo::create_block_v2(db, &answer).expect("persist answer block");

        (session_id, user.id, assistant.id)
    }

    #[test]
    fn test_is_session_tool() {
        assert!(is_session_tool("session_list"));
        assert!(is_session_tool("session_search"));
        assert!(is_session_tool("session_get_messages"));
        assert!(is_session_tool("session_export"));
        assert!(is_session_tool("group_create"));
        assert!(is_session_tool("session_batch_move"));
        assert!(is_session_tool("session_batch_ops"));
        assert!(!is_session_tool("note_read"));
        assert!(!is_session_tool("todo_init"));
    }

    #[test]
    fn test_can_handle_with_prefix() {
        let executor = SessionToolExecutor::new();
        assert!(executor.can_handle("builtin-session_list"));
        assert!(executor.can_handle("session_list"));
        assert!(executor.can_handle("mcp_session_search"));
        assert!(executor.can_handle("builtin-session_get_messages"));
        assert!(executor.can_handle("builtin-session_export"));
        assert!(!executor.can_handle("builtin-note_read"));
    }

    #[test]
    fn test_sensitivity_levels() {
        let executor = SessionToolExecutor::new();
        assert_eq!(
            executor.sensitivity_level("session_list"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("session_tag_add"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.sensitivity_level("session_export"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.sensitivity_level("session_archive"),
            ToolSensitivity::High
        );
        assert_eq!(
            executor.sensitivity_level("builtin-session_batch_ops"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.sensitivity_level("session_batch_move"),
            ToolSensitivity::Medium
        );
    }

    #[test]
    fn test_batch_ops_confirmation_required() {
        assert!(!SessionToolExecutor::batch_ops_confirmation_required(
            3, false
        ));
        assert!(SessionToolExecutor::batch_ops_confirmation_required(
            4, false
        ));
        assert!(SessionToolExecutor::batch_ops_confirmation_required(
            1, true
        ));
    }

    #[test]
    fn test_batch_move_tag_confirmation_required() {
        assert!(!SessionToolExecutor::batch_move_confirmation_required(3));
        assert!(SessionToolExecutor::batch_move_confirmation_required(4));
        assert!(!SessionToolExecutor::batch_tag_confirmation_required(5));
        assert!(SessionToolExecutor::batch_tag_confirmation_required(6));
    }

    #[test]
    fn test_message_page_argument_validation() {
        assert_eq!(
            parse_bounded_u32(&json!({}), "page_size", 20, 1, 20).unwrap(),
            20
        );
        assert!(
            parse_bounded_u32(&json!({"page_size": 21}), "page_size", 20, 1, 20)
                .unwrap_err()
                .contains("between 1 and 20")
        );
        assert_eq!(
            parse_role_filter(&json!({"role_filter": "assistant"})).unwrap(),
            Some("assistant")
        );
        assert!(parse_role_filter(&json!({"role_filter": "tool"}))
            .unwrap_err()
            .contains("SESSION_INVALID_ROLE_FILTER"));
    }

    #[test]
    fn test_date_only_range_is_inclusive_for_entire_end_day() {
        let (date_from, date_to) = parse_search_date_range(&json!({
            "date_from": "2026-07-01",
            "date_to": "2026-07-13"
        }))
        .unwrap();
        assert_eq!(date_from.as_deref(), Some("2026-07-01T00:00:00.000Z"));
        assert_eq!(date_to.as_deref(), Some("2026-07-13T23:59:59.999Z"));

        assert!(parse_search_date_range(&json!({
            "date_from": "2026-07-14",
            "date_to": "2026-07-13"
        }))
        .unwrap_err()
        .contains("SESSION_INVALID_DATE_RANGE"));
    }

    #[test]
    fn test_message_output_truncates_fields_and_summarizes_tools() {
        let mut message = ChatMessage::new_assistant("sess_output".to_string());
        message.id = "msg_output".to_string();
        message.timestamp = 1_700_000_000_000;

        let mut content = MessageBlock::new_content(message.id.clone(), 0);
        content.id = "blk_content".to_string();
        content.content = Some("界".repeat(MAX_TOOL_FIELD_CHARS + 1));

        let mut tool = MessageBlock::new_tool(
            message.id.clone(),
            "builtin-example",
            json!({"secretInput": "must-not-be-returned"}),
            1,
        );
        tool.id = "blk_tool".to_string();
        tool.tool_output = Some(json!({
            "payload": "private raw payload",
            "items": [1, 2, 3]
        }));

        let mut string_tool =
            MessageBlock::new_tool(message.id.clone(), "builtin-string-output", json!({}), 2);
        string_tool.id = "blk_string_tool".to_string();
        string_tool.tool_output = Some(Value::String("S".repeat(500)));
        message.block_ids = vec![content.id.clone(), tool.id.clone(), string_tool.id.clone()];

        let output = message_to_tool_value(&message, &[&content, &tool, &string_tool]);
        assert_eq!(
            output["content"].as_str().unwrap().chars().count(),
            MAX_TOOL_FIELD_CHARS
        );
        assert_eq!(output["truncated"], true);
        assert_eq!(output["blocks"][1]["isToolOutput"], true);
        assert_eq!(
            output["blocks"][1]["summary"],
            "Tool returned fields: items, payload"
        );
        assert!(output["blocks"][1].get("toolOutput").is_none());
        assert!(!output.to_string().contains("private raw payload"));
        assert!(!output.to_string().contains("must-not-be-returned"));
        assert_eq!(output["blocks"][2]["toolOutputTruncated"], true);
        assert_eq!(output["blocks"][2]["truncated"], true);
        assert!(output["blocks"][2]["summary"]
            .as_str()
            .unwrap()
            .starts_with("Tool returned text (500 characters): "));
        assert!(!output.to_string().contains(&"S".repeat(201)));
    }

    #[test]
    fn test_export_range_is_inclusive_and_markdown_omits_thinking() {
        let mut messages = Vec::new();
        let mut blocks = Vec::new();
        for index in 0..3 {
            let mut message = if index % 2 == 0 {
                ChatMessage::new_user("sess_export".to_string(), Vec::new())
            } else {
                ChatMessage::new_assistant("sess_export".to_string())
            };
            message.id = format!("msg_export_{}", index);
            message.timestamp = 1_700_000_000_000 + index;

            let mut content = MessageBlock::new_content(message.id.clone(), 0);
            content.id = format!("blk_export_content_{}", index);
            content.content = Some(format!("visible {}", index));
            let mut thinking = MessageBlock::new_thinking(message.id.clone(), 1);
            thinking.id = format!("blk_export_thinking_{}", index);
            thinking.content = Some(format!("hidden reasoning {}", index));
            message.block_ids = vec![content.id.clone(), thinking.id.clone()];
            blocks.push(content);
            blocks.push(thinking);
            messages.push(message);
        }

        let range = SessionExportRange {
            start_message_id: Some("msg_export_1".to_string()),
            end_message_id: Some("msg_export_2".to_string()),
        };
        let selected = select_export_messages(&messages, Some(&range)).unwrap();
        assert_eq!(
            selected
                .iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>(),
            vec!["msg_export_1", "msg_export_2"]
        );

        let markdown = render_session_markdown("Export title", "sess_export", &selected, &blocks);
        assert!(markdown.contains("# Export title"));
        assert!(markdown.contains("visible 1"));
        assert!(markdown.contains("visible 2"));
        assert!(!markdown.contains("visible 0"));
        assert!(!markdown.contains("hidden reasoning"));
    }

    #[test]
    fn test_export_range_parser_accepts_stable_message_id_bounds() {
        let parsed = parse_export_range(&json!({
            "range": {
                "start_message_id": "msg_start",
                "end_message_id": "msg_end"
            }
        }))
        .unwrap()
        .unwrap();
        assert_eq!(parsed.start_message_id.as_deref(), Some("msg_start"));
        assert_eq!(parsed.end_message_id.as_deref(), Some("msg_end"));
        assert!(parse_export_range(&json!({"range": "all"})).is_err());
    }

    #[test]
    fn get_messages_and_markdown_export_read_real_migrated_chat_repository() {
        let (_temp_dir, db) = setup_chat_db();
        let (session_id, first_message_id, last_message_id) = seed_persisted_session(&db);

        let page = SessionToolExecutor::execute_session_get_messages_with_db(
            &json!({
                "session_id": session_id,
                "page": 1,
                "page_size": 20
            }),
            &db,
        )
        .expect("read persisted messages through executor core");
        assert_eq!(page["total"], 2);
        assert_eq!(page["messages"][0]["content"], "Persisted user question");
        assert_eq!(page["messages"][1]["content"], "Persisted assistant answer");
        assert!(!page.to_string().contains("private reasoning"));

        let export = prepare_session_export(
            &db,
            &json!({
                "session_id": session_id,
                "format": "markdown",
                "range": {
                    "start_message_id": first_message_id,
                    "end_message_id": last_message_id
                }
            }),
        )
        .expect("prepare export from persisted repository rows");
        assert_eq!(export.message_count, 2);
        assert!(export.markdown.contains("# Persisted export"));
        assert!(export.markdown.contains("Persisted user question"));
        assert!(export.markdown.contains("Persisted assistant answer"));
        assert!(!export.markdown.contains("private reasoning"));
    }

    #[test]
    fn session_list_defaults_to_twenty_and_clamps_requested_limit() {
        let (_temp_dir, db) = setup_chat_db();
        for index in 0..25 {
            let session = ChatSession::new(format!("sess_list_{index:02}"), "chat".to_string());
            ChatV2Repo::create_session_v2(&db, &session).expect("persist listed session");
        }

        let default_page = SessionToolExecutor::execute_session_list_with_db(&json!({}), &db)
            .expect("list sessions with default bound");
        assert_eq!(default_page["limit"], 20);
        assert_eq!(default_page["sessions"].as_array().unwrap().len(), 20);
        assert_eq!(default_page["total"], 25);
        assert_eq!(default_page["hasMore"], true);

        let oversized_page =
            SessionToolExecutor::execute_session_list_with_db(&json!({"limit": 500}), &db)
                .expect("clamp oversized session list request");
        assert_eq!(oversized_page["limit"], 20);
        assert_eq!(oversized_page["sessions"].as_array().unwrap().len(), 20);

        let zero_page =
            SessionToolExecutor::execute_session_list_with_db(&json!({"limit": 0}), &db)
                .expect("clamp zero session list request");
        assert_eq!(zero_page["limit"], 1);
        assert_eq!(zero_page["sessions"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn session_import_creates_new_session_with_remapped_ids() {
        let (_temp_dir, db) = setup_chat_db();
        let (session_id, user_message_id, _assistant_message_id) = seed_persisted_session(&db);

        // 构造与 chat_v2_export_session format=json 相同结构的导出载荷
        let session = ChatV2Repo::get_session_v2(&db, &session_id)
            .expect("load session")
            .expect("session exists");
        let messages =
            ChatV2Repo::get_session_messages_v2(&db, &session_id).expect("load messages");
        let blocks = ChatV2Repo::get_session_blocks_v2(&db, &session_id).expect("load blocks");
        let payload = json!({
            "session": session,
            "messages": messages,
            "blocks": blocks,
            "exportedAt": Utc::now().to_rfc3339(),
        })
        .to_string();

        let result = SessionToolExecutor::import_session_payload(&db, &payload, Some("导入验证"))
            .expect("import exported session");
        assert_eq!(result["success"], true);
        let new_session_id = result["sessionId"].as_str().unwrap().to_string();
        assert_ne!(new_session_id, session_id);
        assert!(new_session_id.starts_with("sess_"));
        assert_eq!(result["messageCount"], 2);
        assert_eq!(result["importedFromSessionId"], session_id.as_str());

        let imported = ChatV2Repo::get_session_v2(&db, &new_session_id)
            .expect("load imported session")
            .expect("imported session exists");
        assert_eq!(imported.title.as_deref(), Some("导入验证"));
        assert_eq!(imported.group_id, None);

        let imported_messages =
            ChatV2Repo::get_session_messages_v2(&db, &new_session_id).expect("imported messages");
        assert_eq!(imported_messages.len(), 2);
        assert!(imported_messages
            .iter()
            .all(|message| message.id != user_message_id));
        let imported_blocks =
            ChatV2Repo::get_session_blocks_v2(&db, &new_session_id).expect("imported blocks");
        assert_eq!(imported_blocks.len(), 3);

        // 原会话保持不变
        let original_messages =
            ChatV2Repo::get_session_messages_v2(&db, &session_id).expect("original messages");
        assert_eq!(original_messages.len(), 2);
    }

    #[test]
    fn session_import_rejects_invalid_payloads() {
        let (_temp_dir, db) = setup_chat_db();
        let bad_json = SessionToolExecutor::import_session_payload(&db, "not-json", None);
        assert!(bad_json
            .unwrap_err()
            .contains("SESSION_IMPORT_INVALID_JSON"));

        let missing_session =
            SessionToolExecutor::import_session_payload(&db, r#"{"messages":[]}"#, None);
        assert!(missing_session
            .unwrap_err()
            .contains("SESSION_IMPORT_INVALID_FORMAT"));
    }

    #[test]
    fn markdown_export_returns_bounded_preview_with_total_character_count() {
        let export = PreparedSessionExport {
            session_id: "sess_long_export".to_string(),
            title: "Long export".to_string(),
            markdown: "界".repeat(MAX_TOOL_FIELD_CHARS + 37),
            message_count: 3,
            range: None,
        };

        let output = markdown_export_to_tool_value(export);
        assert_eq!(
            output["markdown"].as_str().unwrap().chars().count(),
            MAX_TOOL_FIELD_CHARS
        );
        assert_eq!(output["totalChars"], MAX_TOOL_FIELD_CHARS + 37);
        assert_eq!(output["truncated"], true);
        assert_eq!(output["messageCount"], 3);
    }
}
