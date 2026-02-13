//! 会话管理命令处理器
//!
//! 包含创建、更新设置、归档、保存、列表、删除会话等命令。

use std::sync::Arc;

use serde_json::Value;
use tauri::State;

use crate::chat_v2::database::ChatV2Database;
use crate::chat_v2::error::ChatV2Error;
use crate::chat_v2::events::clear_session_sequence_counter;
use crate::chat_v2::repo::ChatV2Repo;
use crate::chat_v2::types::{ChatSession, PersistStatus, SessionSettings, SessionState};
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::VfsResourceRepo;

/// 创建新会话
///
/// 创建一个新的聊天会话，返回完整的会话信息。
///
/// ## 参数
/// - `mode`: 会话模式（analysis/review/textbook/bridge/general_chat）
/// - `title`: 可选的标题
/// - `metadata`: 可选的扩展元数据
/// - `db`: Chat V2 独立数据库
///
/// ## 返回
/// - `Ok(ChatSession)`: 创建的会话信息
/// - `Err(String)`: 创建失败
#[tauri::command]
pub async fn chat_v2_create_session(
    mode: String,
    title: Option<String>,
    metadata: Option<Value>,
    group_id: Option<String>,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<ChatSession, String> {
    log::info!(
        "[ChatV2::handlers] chat_v2_create_session: mode={}, title={:?}",
        mode,
        title
    );

    // 验证模式
    // 🔧 P0修复：添加 "chat" 模式（前端使用的标准模式名）
    let valid_modes = [
        "chat", // 前端标准聊天模式
        "analysis",
        "review",
        "textbook",
        "bridge",
        "general_chat",
    ];
    if !valid_modes.contains(&mode.as_str()) {
        return Err(ChatV2Error::Validation(format!(
            "Invalid session mode: {}. Valid modes: {:?}",
            mode, valid_modes
        ))
        .into());
    }

    // 创建会话并写入数据库
    let normalized_group_id =
        group_id.and_then(|g| if g.trim().is_empty() { None } else { Some(g) });
    let session = create_session_in_db(&mode, title, metadata, normalized_group_id, &db)?;

    log::info!(
        "[ChatV2::handlers] Created session: id={}, mode={}",
        session.id,
        session.mode
    );

    Ok(session)
}

/// 获取会话信息（不加载消息）
///
/// 用途：
/// - 前端恢复 `LAST_SESSION_KEY` 时校验会话是否存在
/// - 支持 sess_ / agent_ / subagent_ 前缀（Worker/子代理会话不在普通列表中，但仍可被恢复打开）
#[tauri::command]
pub async fn chat_v2_get_session(
    session_id: String,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<Option<ChatSession>, String> {
    // 允许 sess_ / agent_ / subagent_（与 chat_v2_load_session 的校验保持一致）
    if !session_id.starts_with("sess_")
        && !session_id.starts_with("agent_")
        && !session_id.starts_with("subagent_")
    {
        return Err(
            ChatV2Error::Validation(format!("Invalid session_id format: {}", session_id)).into(),
        );
    }

    let session = ChatV2Repo::get_session_v2(&db, &session_id).map_err(|e| e.to_string())?;
    Ok(session)
}

/// 更新会话设置
///
/// 更新会话的标题或其他元数据。
///
/// ## 参数
/// - `session_id`: 会话 ID
/// - `settings`: 要更新的设置
/// - `db`: Chat V2 独立数据库
///
/// ## 返回
/// - `Ok(ChatSession)`: 更新后的会话信息
/// - `Err(String)`: 更新失败
#[tauri::command]
pub async fn chat_v2_update_session_settings(
    session_id: String,
    settings: SessionSettings,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<ChatSession, String> {
    log::info!(
        "[ChatV2::handlers] chat_v2_update_session_settings: session_id={}, title={:?}",
        session_id,
        settings.title
    );

    // 更新会话设置
    let session = update_session_settings_in_db(&session_id, &settings, &db)?;

    log::info!(
        "[ChatV2::handlers] Updated session settings: id={}",
        session.id
    );

    Ok(session)
}

/// 归档会话
///
/// 将会话标记为已归档状态。归档的会话不会在默认列表中显示，但可以恢复。
///
/// ## 参数
/// - `session_id`: 会话 ID
/// - `db`: Chat V2 独立数据库
///
/// ## 返回
/// - `Ok(())`: 归档成功
/// - `Err(String)`: 归档失败
#[tauri::command]
pub async fn chat_v2_archive_session(
    session_id: String,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<(), String> {
    log::info!(
        "[ChatV2::handlers] chat_v2_archive_session: session_id={}",
        session_id
    );

    // 归档会话
    archive_session_in_db(&session_id, &db)?;

    log::info!("[ChatV2::handlers] Archived session: id={}", session_id);

    Ok(())
}

/// 保存会话状态
///
/// 保存会话的临时状态，包括聊天参数、功能开关、输入草稿等。
/// 用于前端状态持久化，下次打开时恢复。
///
/// ## 参数
/// - `session_id`: 会话 ID
/// - `session_state`: 要保存的会话状态
/// - `db`: Chat V2 独立数据库
///
/// ## 返回
/// - `Ok(())`: 保存成功
/// - `Err(String)`: 保存失败
#[tauri::command]
pub async fn chat_v2_save_session(
    session_id: String,
    session_state: SessionState,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<(), String> {
    // 注意：此命令在流式过程中被频繁调用，使用 debug 级别避免日志过多
    log::debug!(
        "[ChatV2::handlers] chat_v2_save_session: session_id={}",
        session_id
    );

    // 保存会话状态
    save_session_state_in_db(&session_id, &session_state, &db)?;

    log::debug!(
        "[ChatV2::handlers] Saved session state: session_id={}",
        session_id
    );

    Ok(())
}

/// 列出会话
///
/// 获取会话列表，支持按状态过滤和限制数量。
///
/// ## 参数
/// - `status`: 可选的状态过滤（active/archived/deleted）
/// - `limit`: 可选的数量限制，默认 50
/// - `db`: Chat V2 独立数据库
///
/// ## 返回
/// - `Ok(Vec<ChatSession>)`: 会话列表
/// - `Err(String)`: 查询失败
#[tauri::command]
pub async fn chat_v2_list_sessions(
    status: Option<String>,
    group_id: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<Vec<ChatSession>, String> {
    log::info!(
        "[ChatV2::handlers] chat_v2_list_sessions: status={:?}, group_id={:?}, limit={:?}, offset={:?}",
        status,
        group_id,
        limit,
        offset
    );

    let limit = limit.unwrap_or(50);
    let offset = offset.unwrap_or(0);

    // 从数据库获取会话列表
    let sessions =
        ChatV2Repo::list_sessions_v2(&db, status.as_deref(), group_id.as_deref(), limit, offset)
            .map_err(|e| e.to_string())?;

    log::info!(
        "[ChatV2::handlers] Listed {} sessions (offset={})",
        sessions.len(),
        offset
    );

    Ok(sessions)
}

/// 获取会话总数
///
/// 获取指定状态的会话总数，用于分页显示。
///
/// ## 参数
/// - `status`: 可选的状态过滤（active/archived/deleted）
/// - `db`: Chat V2 独立数据库
///
/// ## 返回
/// - `Ok(u32)`: 会话总数
/// - `Err(String)`: 查询失败
#[tauri::command]
pub async fn chat_v2_count_sessions(
    status: Option<String>,
    group_id: Option<String>,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<u32, String> {
    log::debug!(
        "[ChatV2::handlers] chat_v2_count_sessions: status={:?}, group_id={:?}",
        status,
        group_id
    );

    let count = ChatV2Repo::count_sessions_v2(&db, status.as_deref(), group_id.as_deref())
        .map_err(|e| e.to_string())?;

    Ok(count)
}

/// 🆕 2026-01-20: 列出 Agent 会话（Worker 会话）
///
/// 列出指定工作区的 Agent 会话，用于工作区面板显示。
///
/// ## 参数
/// - `workspace_id`: 可选的工作区 ID 过滤
/// - `limit`: 数量限制，默认 50
/// - `db`: Chat V2 独立数据库
///
/// ## 返回
/// - `Ok(Vec<ChatSession>)`: Agent 会话列表
/// - `Err(String)`: 查询失败
#[tauri::command]
pub async fn chat_v2_list_agent_sessions(
    workspace_id: Option<String>,
    limit: Option<u32>,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<Vec<ChatSession>, String> {
    log::info!(
        "[ChatV2::handlers] chat_v2_list_agent_sessions: workspace_id={:?}, limit={:?}",
        workspace_id,
        limit
    );

    let limit = limit.unwrap_or(50);

    let sessions = ChatV2Repo::list_agent_sessions_v2(&db, workspace_id.as_deref(), limit)
        .map_err(|e| e.to_string())?;

    log::info!(
        "[ChatV2::handlers] Listed {} agent sessions",
        sessions.len()
    );

    Ok(sessions)
}

/// P1-23: 软删除会话（移动到回收站）
///
/// 将会话标记为已删除状态，但不永久删除数据。可以恢复。
///
/// ## 参数
/// - `session_id`: 会话 ID
/// - `db`: Chat V2 独立数据库
///
/// ## 返回
/// - `Ok(())`: 软删除成功
/// - `Err(String)`: 软删除失败
#[tauri::command]
pub async fn chat_v2_soft_delete_session(
    session_id: String,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<(), String> {
    log::info!(
        "[ChatV2::handlers] chat_v2_soft_delete_session: session_id={}",
        session_id
    );

    // 验证会话 ID 格式
    if !session_id.starts_with("sess_")
        && !session_id.starts_with("agent_")
        && !session_id.starts_with("subagent_")
    {
        return Err(
            ChatV2Error::Validation(format!("Invalid session ID format: {}", session_id)).into(),
        );
    }

    // 软删除会话
    soft_delete_session_in_db(&session_id, &db)?;

    log::info!("[ChatV2::handlers] Soft deleted session: id={}", session_id);

    Ok(())
}

/// P1-23: 恢复会话
///
/// 将已归档或已删除的会话恢复为活跃状态。
///
/// ## 参数
/// - `session_id`: 会话 ID
/// - `db`: Chat V2 独立数据库
///
/// ## 返回
/// - `Ok(ChatSession)`: 恢复后的会话信息
/// - `Err(String)`: 恢复失败
#[tauri::command]
pub async fn chat_v2_restore_session(
    session_id: String,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<ChatSession, String> {
    log::info!(
        "[ChatV2::handlers] chat_v2_restore_session: session_id={}",
        session_id
    );

    // 验证会话 ID 格式
    if !session_id.starts_with("sess_")
        && !session_id.starts_with("agent_")
        && !session_id.starts_with("subagent_")
    {
        return Err(
            ChatV2Error::Validation(format!("Invalid session ID format: {}", session_id)).into(),
        );
    }

    // 恢复会话
    let session = restore_session_in_db(&session_id, &db)?;

    log::info!("[ChatV2::handlers] Restored session: id={}", session.id);

    Ok(session)
}

/// 删除会话（硬删除）
///
/// 永久删除会话及其所有消息和块（级联删除）。
/// 注意：推荐使用 `chat_v2_soft_delete_session` 进行软删除，仅在清空回收站时使用硬删除。
///
/// ## 参数
/// - `session_id`: 会话 ID
/// - `db`: Chat V2 独立数据库
///
/// ## 返回
/// - `Ok(())`: 删除成功
/// - `Err(String)`: 会话不存在或删除失败
///
/// ## 级联删除
/// 删除会话时会自动删除：
/// - `chat_v2_messages` 表中所有关联消息
/// - `chat_v2_blocks` 表中所有关联块
/// - `chat_v2_session_state` 表中的会话状态
#[tauri::command]
pub async fn chat_v2_delete_session(
    session_id: String,
    db: State<'_, Arc<ChatV2Database>>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<(), String> {
    log::info!(
        "[ChatV2::handlers] chat_v2_delete_session: session_id={}",
        session_id
    );

    // 验证会话 ID 格式
    if !session_id.starts_with("sess_")
        && !session_id.starts_with("agent_")
        && !session_id.starts_with("subagent_")
    {
        return Err(
            ChatV2Error::Validation(format!("Invalid session ID format: {}", session_id)).into(),
        );
    }

    // ★ 2026-02 修复：会话删除前收集所有消息的资源引用并递减引用计数
    // 防止 CASCADE DELETE 后资源引用计数永远无法归零
    // ★ 注意：不能去重！引用计数是逐消息递增的，如果消息 A 和 B 都引用了 res_X，
    //   ref_count 被加了 2，必须也递减 2 次。
    if let Ok(messages) = ChatV2Repo::get_session_messages_v2(&db, &session_id) {
        let mut all_resource_ids: Vec<String> = Vec::new();
        for msg in &messages {
            if let Some(ref meta) = msg.meta {
                if let Some(ref context_snapshot) = meta.context_snapshot {
                    let ids = context_snapshot.all_resource_ids();
                    all_resource_ids.extend(ids.into_iter().map(|s| s.to_string()));
                }
            }
        }
        if !all_resource_ids.is_empty() {
            match vfs_db.get_conn_safe() {
                Ok(vfs_conn) => {
                    if let Err(e) =
                        VfsResourceRepo::decrement_refs_with_conn(&vfs_conn, &all_resource_ids)
                    {
                        log::warn!(
                            "[ChatV2::handlers] Failed to decrement refs for session {}: {}",
                            session_id,
                            e
                        );
                    } else {
                        log::debug!(
                            "[ChatV2::handlers] Decremented refs for {} resource references before deleting session {}",
                            all_resource_ids.len(),
                            session_id
                        );
                    }
                }
                Err(e) => {
                    log::warn!(
                        "[ChatV2::handlers] Failed to get vfs.db conn for session delete ref decrement: {}",
                        e
                    );
                }
            }
        }
    }

    // 从数据库删除会话（级联删除）
    ChatV2Repo::delete_session_v2(&db, &session_id).map_err(|e| e.to_string())?;
    clear_session_sequence_counter(&session_id);

    log::info!(
        "[ChatV2::handlers] Deleted session with cascade: id={}",
        session_id
    );

    Ok(())
}

/// P1-3: 清空回收站（永久删除所有已删除会话）
///
/// 一次性删除所有 persist_status = 'deleted' 的会话，
/// 解决前端逐个删除只能处理前 100 条的问题。
///
/// ## 参数
/// - `db`: Chat V2 独立数据库
///
/// ## 返回
/// - `Ok(u32)`: 被删除的会话数量
/// - `Err(String)`: 删除失败
#[tauri::command]
pub async fn chat_v2_empty_deleted_sessions(
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<u32, String> {
    log::info!("[ChatV2::handlers] chat_v2_empty_deleted_sessions");
    let count = ChatV2Repo::purge_deleted_sessions(&db).map_err(|e| e.to_string())?;
    log::info!(
        "[ChatV2::handlers] Emptied trash: {} sessions permanently deleted",
        count
    );
    Ok(count)
}

// ============================================================================
// 内部辅助函数（调用 ChatV2Repo 实现）
// ============================================================================

/// 在数据库中创建会话
fn create_session_in_db(
    mode: &str,
    title: Option<String>,
    metadata: Option<Value>,
    group_id: Option<String>,
    db: &ChatV2Database,
) -> Result<ChatSession, ChatV2Error> {
    let now = chrono::Utc::now();

    let session = ChatSession {
        id: ChatSession::generate_id(),
        mode: mode.to_string(),
        title,
        description: None,
        summary_hash: None,
        persist_status: PersistStatus::Active,
        created_at: now,
        updated_at: now,
        metadata,
        group_id,
    };

    // 写入数据库
    ChatV2Repo::create_session_v2(db, &session)?;

    Ok(session)
}

/// 更新会话设置
fn update_session_settings_in_db(
    session_id: &str,
    settings: &SessionSettings,
    db: &ChatV2Database,
) -> Result<ChatSession, ChatV2Error> {
    // 先获取现有会话
    let existing = ChatV2Repo::get_session_v2(db, session_id)?
        .ok_or_else(|| ChatV2Error::SessionNotFound(session_id.to_string()))?;

    let now = chrono::Utc::now();

    // 构建更新后的会话（只更新设置字段，保留其他字段）
    let updated_session = ChatSession {
        id: existing.id,
        mode: existing.mode,
        title: settings.title.clone().or(existing.title),
        description: existing.description,
        summary_hash: existing.summary_hash,
        persist_status: existing.persist_status,
        created_at: existing.created_at,
        updated_at: now,
        metadata: settings.metadata.clone().or(existing.metadata),
        group_id: existing.group_id,
    };

    // 更新数据库
    ChatV2Repo::update_session_v2(db, &updated_session)?;

    Ok(updated_session)
}

/// 归档会话
fn archive_session_in_db(session_id: &str, db: &ChatV2Database) -> Result<(), ChatV2Error> {
    // 先获取现有会话
    let existing = ChatV2Repo::get_session_v2(db, session_id)?
        .ok_or_else(|| ChatV2Error::SessionNotFound(session_id.to_string()))?;

    let now = chrono::Utc::now();

    // 构建归档后的会话
    let archived_session = ChatSession {
        id: existing.id,
        mode: existing.mode,
        title: existing.title,
        description: existing.description,
        summary_hash: existing.summary_hash,
        persist_status: PersistStatus::Archived,
        created_at: existing.created_at,
        updated_at: now,
        metadata: existing.metadata,
        group_id: existing.group_id,
    };

    // 更新数据库
    ChatV2Repo::update_session_v2(db, &archived_session)?;

    Ok(())
}

/// P1-23: 软删除会话
fn soft_delete_session_in_db(session_id: &str, db: &ChatV2Database) -> Result<(), ChatV2Error> {
    // 先获取现有会话
    let existing = ChatV2Repo::get_session_v2(db, session_id)?
        .ok_or_else(|| ChatV2Error::SessionNotFound(session_id.to_string()))?;

    let now = chrono::Utc::now();

    // 构建软删除后的会话
    let deleted_session = ChatSession {
        id: existing.id,
        mode: existing.mode,
        title: existing.title,
        description: existing.description,
        summary_hash: existing.summary_hash,
        persist_status: PersistStatus::Deleted,
        created_at: existing.created_at,
        updated_at: now,
        metadata: existing.metadata,
        group_id: existing.group_id,
    };

    // 更新数据库
    ChatV2Repo::update_session_v2(db, &deleted_session)?;

    Ok(())
}

/// P1-23: 恢复会话（从归档或已删除状态恢复为活跃状态）
fn restore_session_in_db(
    session_id: &str,
    db: &ChatV2Database,
) -> Result<ChatSession, ChatV2Error> {
    // 先获取现有会话
    let existing = ChatV2Repo::get_session_v2(db, session_id)?
        .ok_or_else(|| ChatV2Error::SessionNotFound(session_id.to_string()))?;

    let now = chrono::Utc::now();

    // 构建恢复后的会话
    let restored_session = ChatSession {
        id: existing.id,
        mode: existing.mode,
        title: existing.title,
        description: existing.description,
        summary_hash: existing.summary_hash,
        persist_status: PersistStatus::Active,
        created_at: existing.created_at,
        updated_at: now,
        metadata: existing.metadata,
        group_id: existing.group_id,
    };

    // 更新数据库
    ChatV2Repo::update_session_v2(db, &restored_session)?;

    Ok(restored_session)
}

/// 保存会话状态
fn save_session_state_in_db(
    session_id: &str,
    session_state: &SessionState,
    db: &ChatV2Database,
) -> Result<(), ChatV2Error> {
    // 验证会话存在
    let _ = ChatV2Repo::get_session_v2(db, session_id)?
        .ok_or_else(|| ChatV2Error::SessionNotFound(session_id.to_string()))?;

    // 保存会话状态（使用 UPSERT）
    ChatV2Repo::save_session_state_v2(db, session_id, session_state)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_modes() {
        let valid_modes = [
            "chat", // 前端标准聊天模式
            "analysis",
            "review",
            "textbook",
            "bridge",
            "general_chat",
        ];

        for mode in valid_modes.iter() {
            assert!(valid_modes.contains(mode));
        }

        assert!(!valid_modes.contains(&"invalid_mode"));
    }

    #[test]
    fn test_session_id_generation() {
        let id1 = ChatSession::generate_id();
        let id2 = ChatSession::generate_id();

        assert!(id1.starts_with("sess_"));
        assert!(id2.starts_with("sess_"));
        assert_ne!(id1, id2);
    }

    #[test]
    fn test_session_id_format_validation() {
        // 有效的会话 ID
        assert!("sess_12345".starts_with("sess_"));
        assert!("sess_a1b2c3d4-e5f6-7890-abcd-ef1234567890".starts_with("sess_"));

        // 无效的会话 ID
        assert!(!"session_12345".starts_with("sess_"));
        assert!(!"invalid".starts_with("sess_"));
    }
}
