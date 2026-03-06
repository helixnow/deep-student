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
use serde_json::{json, Value};
use tauri::Emitter;

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::database::ChatV2Database;
use crate::chat_v2::events::event_types;
use crate::chat_v2::repo::ChatV2Repo;
use crate::chat_v2::types::{ChatSession, PersistStatus, SessionGroup, ToolCall, ToolResultInfo};

/// 会话管理变更事件名（前端监听以刷新侧边栏）
const SESSION_MGMT_EVENT: &str = "session_management_change";

// ============================================================================
// 常量
// ============================================================================

const LOG_PREFIX: &str = "[SessionExecutor]";
const MAX_BATCH_OPS_PER_CALL: usize = 200;

/// 所有会话管理工具名
pub mod tool_names {
    pub const SESSION_LIST: &str = "session_list";
    pub const SESSION_SEARCH: &str = "session_search";
    pub const SESSION_GET: &str = "session_get";
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

impl SessionToolExecutor {
    pub fn new() -> Self {
        Self
    }

    /// 从 ExecutionContext 获取 ChatV2Database
    fn get_db<'a>(ctx: &'a ExecutionContext) -> Result<&'a ChatV2Database, String> {
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
            .unwrap_or(30)
            .min(100) as u32;
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

        let results = ChatV2Repo::search_content(&conn, query, limit).map_err(|e| e.to_string())?;

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
            "query": query
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

        let archived = ChatSession {
            persist_status: PersistStatus::Archived,
            updated_at: chrono::Utc::now(),
            ..existing
        };

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

        let session_ids: Vec<String> = args
            .get("session_ids")
            .and_then(|v| v.as_array())
            .ok_or("缺少必需参数: session_ids")?
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect();

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

        let session_ids: Vec<String> = args
            .get("session_ids")
            .and_then(|v| v.as_array())
            .ok_or("缺少必需参数: session_ids")?
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect();

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

        let raw_ops = args
            .get("operations")
            .and_then(|v| v.as_array())
            .ok_or("缺少必需参数: operations")?;
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
                        let archived = ChatSession {
                            persist_status: PersistStatus::Archived,
                            updated_at: chrono::Utc::now(),
                            ..existing
                        };
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
                        | "group_list"
                        | "tag_list_all"
                        | "session_stats"
                );
                if is_write_op {
                    let _ = ctx.window.emit(
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
            "session_tag_add" | "session_tag_remove" | "session_move" | "session_rename"
            | "session_restore" | "group_create" | "group_update" => ToolSensitivity::Medium,
            "session_batch_tag" | "session_batch_move" | "session_batch_ops" => {
                ToolSensitivity::Low
            }
            _ => ToolSensitivity::Low,
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

    #[test]
    fn test_is_session_tool() {
        assert!(is_session_tool("session_list"));
        assert!(is_session_tool("session_search"));
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
            executor.sensitivity_level("session_archive"),
            ToolSensitivity::High
        );
        assert_eq!(
            executor.sensitivity_level("builtin-session_batch_ops"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("session_batch_move"),
            ToolSensitivity::Low
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
}
