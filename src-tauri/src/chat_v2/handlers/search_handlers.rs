//! 内容搜索与标签管理命令处理器

use std::sync::Arc;
use tauri::State;

use crate::chat_v2::database::ChatV2Database;
use crate::chat_v2::error::ChatV2Error;
use crate::chat_v2::repo::ChatV2Repo;
use crate::chat_v2::types::ContentSearchResult;

/// 校验会话 ID 前缀（sess_ / agent_ / subagent_）
fn validate_session_id(session_id: &str) -> Result<(), String> {
    if !session_id.starts_with("sess_")
        && !session_id.starts_with("agent_")
        && !session_id.starts_with("subagent_")
    {
        return Err(
            ChatV2Error::Validation(format!("Invalid session ID format: {}", session_id)).into(),
        );
    }
    Ok(())
}

/// 搜索消息内容（FTS5 全文搜索）
#[tauri::command]
pub async fn chat_v2_search_content(
    query: String,
    limit: Option<u32>,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<Vec<ContentSearchResult>, String> {
    // 空 query 早退：避免把空串直接下推到 FTS5（MATCH '' 语法错误）
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.unwrap_or(50).min(200);
    let conn = db.get_conn_safe().map_err(String::from)?;
    ChatV2Repo::search_content(&conn, &query, limit).map_err(String::from)
}

/// 重建聊天内容 FTS5 索引（清空后从 chat_v2_blocks 全量回填），返回回填行数。
/// 供设置页「全局索引维护」修复 FTS 与正文不一致。
#[tauri::command]
pub async fn rebuild_chat_fts(db: State<'_, Arc<ChatV2Database>>) -> Result<usize, String> {
    let conn = db.get_conn_safe().map_err(String::from)?;
    ChatV2Repo::rebuild_content_fts(&conn).map_err(String::from)
}

/// 获取会话标签
#[tauri::command]
pub async fn chat_v2_get_session_tags(
    session_id: String,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<Vec<String>, String> {
    validate_session_id(&session_id)?;
    let conn = db.get_conn_safe().map_err(String::from)?;
    ChatV2Repo::get_session_tags(&conn, &session_id).map_err(String::from)
}

/// 批量获取多个会话的标签
#[tauri::command]
pub async fn chat_v2_get_tags_batch(
    session_ids: Vec<String>,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<std::collections::HashMap<String, Vec<String>>, String> {
    let conn = db.get_conn_safe().map_err(String::from)?;
    ChatV2Repo::get_tags_for_sessions(&conn, &session_ids).map_err(String::from)
}

/// 添加手动标签
#[tauri::command]
pub async fn chat_v2_add_tag(
    session_id: String,
    tag: String,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    if tag.trim().is_empty() {
        return Err(ChatV2Error::Validation("Tag must not be empty".to_string()).into());
    }
    let conn = db.get_conn_safe().map_err(String::from)?;
    ChatV2Repo::add_manual_tag(&conn, &session_id, &tag).map_err(String::from)
}

/// 删除标签
#[tauri::command]
pub async fn chat_v2_remove_tag(
    session_id: String,
    tag: String,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    if tag.trim().is_empty() {
        return Err(ChatV2Error::Validation("Tag must not be empty".to_string()).into());
    }
    let conn = db.get_conn_safe().map_err(String::from)?;
    ChatV2Repo::remove_tag(&conn, &session_id, &tag).map_err(String::from)
}

/// 获取所有标签（去重 + 使用次数）
#[tauri::command]
pub async fn chat_v2_list_all_tags(
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<Vec<(String, u32)>, String> {
    let conn = db.get_conn_safe().map_err(String::from)?;
    ChatV2Repo::list_all_tags(&conn).map_err(String::from)
}
