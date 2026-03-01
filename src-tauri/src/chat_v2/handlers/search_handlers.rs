//! 内容搜索与标签管理命令处理器

use std::sync::Arc;
use tauri::State;

use crate::chat_v2::database::ChatV2Database;
use crate::chat_v2::repo::ChatV2Repo;
use crate::chat_v2::types::ContentSearchResult;

/// 搜索消息内容（FTS5 全文搜索）
#[tauri::command]
pub async fn chat_v2_search_content(
    query: String,
    limit: Option<u32>,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<Vec<ContentSearchResult>, String> {
    let limit = limit.unwrap_or(50).min(200);
    let conn = db.get_conn_safe().map_err(|e| e.to_string())?;
    ChatV2Repo::search_content(&conn, &query, limit).map_err(|e| e.to_string())
}

/// 获取会话标签
#[tauri::command]
pub async fn chat_v2_get_session_tags(
    session_id: String,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<Vec<String>, String> {
    let conn = db.get_conn_safe().map_err(|e| e.to_string())?;
    ChatV2Repo::get_session_tags(&conn, &session_id).map_err(|e| e.to_string())
}

/// 批量获取多个会话的标签
#[tauri::command]
pub async fn chat_v2_get_tags_batch(
    session_ids: Vec<String>,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<std::collections::HashMap<String, Vec<String>>, String> {
    let conn = db.get_conn_safe().map_err(|e| e.to_string())?;
    ChatV2Repo::get_tags_for_sessions(&conn, &session_ids).map_err(|e| e.to_string())
}

/// 添加手动标签
#[tauri::command]
pub async fn chat_v2_add_tag(
    session_id: String,
    tag: String,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<(), String> {
    let conn = db.get_conn_safe().map_err(|e| e.to_string())?;
    ChatV2Repo::add_manual_tag(&conn, &session_id, &tag).map_err(|e| e.to_string())
}

/// 删除标签
#[tauri::command]
pub async fn chat_v2_remove_tag(
    session_id: String,
    tag: String,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<(), String> {
    let conn = db.get_conn_safe().map_err(|e| e.to_string())?;
    ChatV2Repo::remove_tag(&conn, &session_id, &tag).map_err(|e| e.to_string())
}

/// 获取所有标签（去重 + 使用次数）
#[tauri::command]
pub async fn chat_v2_list_all_tags(
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<Vec<(String, u32)>, String> {
    let conn = db.get_conn_safe().map_err(|e| e.to_string())?;
    ChatV2Repo::list_all_tags(&conn).map_err(|e| e.to_string())
}
