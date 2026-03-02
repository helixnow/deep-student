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
use crate::chat_v2::state::ChatV2State;
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

    // P1-5 fix: Validate target group exists and is active
    if let Some(ref gid) = normalized_group_id {
        let conn = db.get_conn_safe().map_err(|e| e.to_string())?;
        let group = ChatV2Repo::get_group_with_conn(&conn, gid).map_err(|e| e.to_string())?;
        match group {
            Some(g) if g.persist_status != PersistStatus::Active => {
                log::warn!(
                    "[ChatV2::handlers] Ignoring deleted/archived group_id: {}",
                    gid
                );
                return Err(format!("Group not found or inactive: {}", gid));
            }
            None => {
                log::warn!("[ChatV2::handlers] Ignoring non-existent group_id: {}", gid);
                return Err(format!("Group not found: {}", gid));
            }
            _ => {}
        }
    }

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

/// 会话分支：从指定消息处创建新会话
///
/// 深拷贝源会话中从开头到目标消息（含）的所有消息和块，
/// 创建为一个新的普通 sess_ 会话。
///
/// ## 参数
/// - `source_session_id`: 源会话 ID（支持 sess_/agent_/subagent_ 前缀）
/// - `up_to_message_id`: 截止到的消息 ID（含此消息）
/// - `db`: Chat V2 独立数据库
/// - `vfs_db`: VFS 数据库（用于资源引用计数）
///
/// ## 返回
/// - `Ok(ChatSession)`: 新创建的分支会话
/// - `Err(String)`: 分支失败
#[tauri::command]
pub async fn chat_v2_branch_session(
    source_session_id: String,
    up_to_message_id: String,
    db: State<'_, Arc<ChatV2Database>>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<ChatSession, String> {
    log::info!(
        "[ChatV2::handlers] chat_v2_branch_session: source={}, upTo={}",
        source_session_id,
        up_to_message_id
    );

    // 1. 校验源会话 ID 前缀
    if !source_session_id.starts_with("sess_")
        && !source_session_id.starts_with("agent_")
        && !source_session_id.starts_with("subagent_")
    {
        return Err(ChatV2Error::Validation(format!(
            "Invalid source session_id format: {}",
            source_session_id
        ))
        .into());
    }

    // 2. 在事务中执行分支
    let (new_session, resource_ids) =
        branch_session_in_db(&source_session_id, &up_to_message_id, &db)?;

    // 3. 事务提交后：增量 VFS 资源引用计数（失败仅告警）
    if !resource_ids.is_empty() {
        match vfs_db.get_conn_safe() {
            Ok(vfs_conn) => {
                let mut success_count = 0usize;
                for rid in &resource_ids {
                    match VfsResourceRepo::increment_ref_with_conn(&vfs_conn, rid) {
                        Ok(_) => success_count += 1,
                        Err(e) => {
                            log::warn!(
                                "[ChatV2::handlers] Failed to increment ref for {}: {}",
                                rid,
                                e
                            );
                        }
                    }
                }
                log::debug!(
                    "[ChatV2::handlers] Incremented refs for {}/{} resources in branched session {}",
                    success_count,
                    resource_ids.len(),
                    new_session.id
                );
            }
            Err(e) => {
                log::warn!(
                    "[ChatV2::handlers] Failed to get vfs.db conn for branch ref increment: {}",
                    e
                );
            }
        }
    }

    log::info!(
        "[ChatV2::handlers] Branched session created: id={}, from={}",
        new_session.id,
        source_session_id
    );

    Ok(new_session)
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
    chat_v2_state: State<'_, Arc<ChatV2State>>,
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

    // P0 修复：检查会话是否有活跃流，防止流式中删除导致 save_results 写入失败
    if chat_v2_state.has_active_stream(&session_id) {
        return Err(ChatV2Error::Other(
            "Cannot delete session while streaming. Please wait for completion or cancel first."
                .to_string(),
        )
        .into());
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
    chat_v2_state: State<'_, Arc<ChatV2State>>,
) -> Result<(), String> {
    log::info!(
        "[ChatV2::handlers] chat_v2_delete_session: session_id={}",
        session_id
    );

    // P0 修复：检查会话是否有活跃流，防止级联删除导致 save_results 外键违反
    if chat_v2_state.has_active_stream(&session_id) {
        return Err(ChatV2Error::Other(
            "Cannot delete session while streaming. Please wait for completion or cancel first."
                .to_string(),
        )
        .into());
    }

    // 验证会话 ID 格式
    if !session_id.starts_with("sess_")
        && !session_id.starts_with("agent_")
        && !session_id.starts_with("subagent_")
    {
        return Err(
            ChatV2Error::Validation(format!("Invalid session ID format: {}", session_id)).into(),
        );
    }

    // 会话删除前递减 VFS 资源引用计数，防止 CASCADE DELETE 后引用计数永远无法归零
    decrement_vfs_refs_for_session(&db, &vfs_db, &session_id);

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
/// ★ 2026-02 修复：删除前先递减所有待删除会话中消息的 VFS 资源引用计数，
/// 防止 CASCADE DELETE 后引用计数永远无法归零导致资源孤儿。
///
/// ## 参数
/// - `db`: Chat V2 独立数据库
/// - `vfs_db`: VFS 数据库（用于资源引用计数递减）
///
/// ## 返回
/// - `Ok(u32)`: 被删除的会话数量
/// - `Err(String)`: 删除失败
#[tauri::command]
pub async fn chat_v2_empty_deleted_sessions(
    db: State<'_, Arc<ChatV2Database>>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<u32, String> {
    log::info!("[ChatV2::handlers] chat_v2_empty_deleted_sessions");

    // ★ 先查出所有待删除的会话 ID，逐个收集资源引用并批量递减
    let deleted_ids = ChatV2Repo::list_deleted_session_ids(&db).map_err(|e| e.to_string())?;

    if !deleted_ids.is_empty() {
        // 收集所有待删除会话中消息引用的资源 ID（不去重，与递增时对称）
        let mut all_resource_ids: Vec<String> = Vec::new();
        for sid in &deleted_ids {
            if let Ok(messages) = ChatV2Repo::get_session_messages_v2(&db, sid) {
                for msg in &messages {
                    if let Some(ref meta) = msg.meta {
                        if let Some(ref context_snapshot) = meta.context_snapshot {
                            let ids = context_snapshot.all_resource_ids();
                            all_resource_ids.extend(ids.into_iter().map(|s| s.to_string()));
                        }
                    }
                }
            }
        }

        // 批量递减 VFS 资源引用计数（失败仅告警，不阻塞删除）
        if !all_resource_ids.is_empty() {
            match vfs_db.get_conn_safe() {
                Ok(vfs_conn) => {
                    if let Err(e) =
                        VfsResourceRepo::decrement_refs_with_conn(&vfs_conn, &all_resource_ids)
                    {
                        log::warn!(
                            "[ChatV2::handlers] Failed to decrement refs during trash empty: {}",
                            e
                        );
                    } else {
                        log::debug!(
                            "[ChatV2::handlers] Decremented refs for {} resource references before emptying trash ({} sessions)",
                            all_resource_ids.len(),
                            deleted_ids.len()
                        );
                    }
                }
                Err(e) => {
                    log::warn!(
                        "[ChatV2::handlers] Failed to get vfs.db conn for trash empty ref decrement: {}",
                        e
                    );
                }
            }
        }
    }

    // 执行批量硬删除
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

/// 递减指定会话中所有消息引用的 VFS 资源引用计数
///
/// 遍历会话的全部消息，收集 `meta.context_snapshot` 中的资源 ID，
/// 然后批量递减 VFS 引用计数。
///
/// **不去重**：引用计数是逐消息递增的，必须逐条递减以保持一致。
/// 失败仅记录警告，不会阻断调用方流程。
fn decrement_vfs_refs_for_session(db: &ChatV2Database, vfs_db: &VfsDatabase, session_id: &str) {
    let messages = match ChatV2Repo::get_session_messages_v2(db, session_id) {
        Ok(msgs) => msgs,
        Err(e) => {
            log::warn!(
                "[ChatV2::handlers] Failed to load messages for VFS ref decrement (session {}): {}",
                session_id,
                e
            );
            return;
        }
    };

    let mut all_resource_ids: Vec<String> = Vec::new();
    for msg in &messages {
        if let Some(ref meta) = msg.meta {
            if let Some(ref context_snapshot) = meta.context_snapshot {
                let ids = context_snapshot.all_resource_ids();
                all_resource_ids.extend(ids.into_iter().map(|s| s.to_string()));
            }
        }
    }

    if all_resource_ids.is_empty() {
        return;
    }

    match vfs_db.get_conn_safe() {
        Ok(vfs_conn) => {
            if let Err(e) = VfsResourceRepo::decrement_refs_with_conn(&vfs_conn, &all_resource_ids)
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
        tags_hash: None,
        tags: None,
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
        tags_hash: existing.tags_hash,
        tags: None,
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
        tags_hash: existing.tags_hash,
        tags: None,
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
        tags_hash: existing.tags_hash,
        tags: None,
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
        tags_hash: existing.tags_hash,
        tags: None,
    };

    // 更新数据库
    ChatV2Repo::update_session_v2(db, &restored_session)?;

    Ok(restored_session)
}

/// 会话分支核心逻辑（事务内执行）
///
/// 返回: (新会话, 需要增量引用计数的资源 ID 列表)
fn branch_session_in_db(
    source_session_id: &str,
    up_to_message_id: &str,
    db: &ChatV2Database,
) -> Result<(ChatSession, Vec<String>), String> {
    use std::collections::HashMap;

    let mut conn = db.get_conn_safe().map_err(|e| e.to_string())?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;

    // 1. 加载并校验源会话
    let source_session = ChatV2Repo::get_session_with_conn(&tx, source_session_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Source session not found: {}", source_session_id))?;

    if source_session.persist_status != PersistStatus::Active {
        return Err(format!(
            "Source session is not active (status: {:?}): {}",
            source_session.persist_status, source_session_id
        ));
    }

    // 2. 加载源消息（按 timestamp ASC, rowid ASC 排序）
    let source_messages = ChatV2Repo::get_session_messages_with_conn(&tx, source_session_id)
        .map_err(|e| e.to_string())?;

    // 3. 按 index 截断（不用 timestamp）
    let cut_index = source_messages
        .iter()
        .position(|m| m.id == up_to_message_id)
        .ok_or_else(|| {
            format!(
                "Message {} not found in session {}",
                up_to_message_id, source_session_id
            )
        })?;

    let messages_to_copy = &source_messages[..=cut_index];

    // 4. 收集需要复制的所有块 ID
    let mut all_block_ids: Vec<String> = Vec::new();
    for msg in messages_to_copy {
        // message.block_ids
        all_block_ids.extend(msg.block_ids.iter().cloned());
        // variant block_ids
        if let Some(ref variants) = msg.variants {
            for variant in variants {
                all_block_ids.extend(variant.block_ids.iter().cloned());
            }
        }
    }
    all_block_ids.sort();
    all_block_ids.dedup();

    // 5. 批量加载所有源块
    let mut source_blocks_map: HashMap<String, crate::chat_v2::types::MessageBlock> =
        HashMap::new();
    for block_id in &all_block_ids {
        if let Some(block) =
            ChatV2Repo::get_block_with_conn(&tx, block_id).map_err(|e| e.to_string())?
        {
            source_blocks_map.insert(block_id.clone(), block);
        }
    }

    // 6. 创建新会话
    let now = chrono::Utc::now();
    let new_session_id = ChatSession::generate_id();

    // 构建 metadata，加入 branchedFrom 信息
    let mut metadata = source_session
        .metadata
        .clone()
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(obj) = metadata.as_object_mut() {
        obj.insert(
            "branchedFrom".to_string(),
            serde_json::json!({
                "sessionId": source_session_id,
                "messageId": up_to_message_id,
                "branchedAt": now.to_rfc3339(),
            }),
        );
    }

    let new_session = ChatSession {
        id: new_session_id.clone(),
        mode: "chat".to_string(),
        title: source_session.title.map(|t| format!("{} (branch)", t)),
        description: source_session.description.clone(),
        summary_hash: None,
        persist_status: PersistStatus::Active,
        created_at: now,
        updated_at: now,
        metadata: Some(metadata),
        group_id: source_session.group_id.clone(),
        tags_hash: None,
        tags: None,
    };

    ChatV2Repo::create_session_with_conn(&tx, &new_session).map_err(|e| e.to_string())?;

    // 7. 构建 ID 映射（old -> new）并深拷贝消息和块
    let mut msg_id_map: HashMap<String, String> = HashMap::new();
    let mut block_id_map: HashMap<String, String> = HashMap::new();
    let mut resource_ids: Vec<String> = Vec::new();

    // 预生成所有新 ID
    for msg in messages_to_copy {
        let new_msg_id = crate::chat_v2::types::ChatMessage::generate_id();
        msg_id_map.insert(msg.id.clone(), new_msg_id);
    }
    for block_id in &all_block_ids {
        let new_block_id = crate::chat_v2::types::MessageBlock::generate_id();
        block_id_map.insert(block_id.clone(), new_block_id);
    }

    // 8. 先写入新消息（含 ID 重映射）
    //    ⚠️ 必须先写 messages 再写 blocks，因为 blocks.message_id 有外键约束指向 messages.id
    for msg in messages_to_copy {
        let new_msg_id = msg_id_map.get(&msg.id).unwrap().clone();

        // 重映射 block_ids
        let new_block_ids: Vec<String> = msg
            .block_ids
            .iter()
            .map(|bid| {
                block_id_map
                    .get(bid)
                    .cloned()
                    .unwrap_or_else(|| bid.clone())
            })
            .collect();

        // 重映射 parent_id / supersedes
        let new_parent_id = msg
            .parent_id
            .as_ref()
            .and_then(|pid| msg_id_map.get(pid).cloned());
        let new_supersedes = msg
            .supersedes
            .as_ref()
            .and_then(|sid| msg_id_map.get(sid).cloned());

        // 重映射 variants
        let new_variants = msg.variants.as_ref().map(|variants| {
            variants
                .iter()
                .map(|v| {
                    let new_var_block_ids: Vec<String> = v
                        .block_ids
                        .iter()
                        .map(|bid| {
                            block_id_map
                                .get(bid)
                                .cloned()
                                .unwrap_or_else(|| bid.clone())
                        })
                        .collect();
                    crate::chat_v2::types::Variant {
                        id: crate::chat_v2::types::Variant::generate_id(),
                        model_id: v.model_id.clone(),
                        config_id: v.config_id.clone(),
                        block_ids: new_var_block_ids,
                        status: v.status.clone(),
                        error: v.error.clone(),
                        created_at: v.created_at,
                        usage: v.usage.clone(),
                    }
                })
                .collect::<Vec<_>>()
        });

        // 重映射 active_variant_id
        let new_active_variant_id =
            if let (Some(ref old_active), Some(ref old_variants), Some(ref new_vars)) =
                (&msg.active_variant_id, &msg.variants, &new_variants)
            {
                // 找到旧 active 在旧 variants 中的 index，映射到新 variants 的 id
                old_variants
                    .iter()
                    .position(|v| &v.id == old_active)
                    .and_then(|idx| new_vars.get(idx))
                    .map(|v| v.id.clone())
            } else {
                None
            };

        // 重映射 shared_context 中的 block_ids
        let new_shared_context = msg.shared_context.as_ref().map(|sc| {
            let remap = |bid: &Option<String>| -> Option<String> {
                bid.as_ref().and_then(|b| block_id_map.get(b).cloned())
            };
            crate::chat_v2::types::SharedContext {
                rag_sources: sc.rag_sources.clone(),
                memory_sources: sc.memory_sources.clone(),
                graph_sources: sc.graph_sources.clone(),
                web_search_sources: sc.web_search_sources.clone(),
                multimodal_sources: sc.multimodal_sources.clone(),
                rag_block_id: remap(&sc.rag_block_id),
                memory_block_id: remap(&sc.memory_block_id),
                graph_block_id: remap(&sc.graph_block_id),
                web_search_block_id: remap(&sc.web_search_block_id),
                multimodal_block_id: remap(&sc.multimodal_block_id),
            }
        });

        // 收集 context_snapshot 中的资源 ID（用于后续 ref_count 增量）
        if let Some(ref meta) = msg.meta {
            if let Some(ref cs) = meta.context_snapshot {
                let ids = cs.all_resource_ids();
                resource_ids.extend(ids.into_iter().map(|s| s.to_string()));
            }
        }

        let new_message = crate::chat_v2::types::ChatMessage {
            id: new_msg_id,
            session_id: new_session_id.clone(),
            role: msg.role.clone(),
            block_ids: new_block_ids,
            timestamp: msg.timestamp,
            persistent_stable_id: msg.persistent_stable_id.clone(),
            parent_id: new_parent_id,
            supersedes: new_supersedes,
            meta: msg.meta.clone(),
            attachments: msg.attachments.clone(),
            active_variant_id: new_active_variant_id,
            variants: new_variants,
            shared_context: new_shared_context,
        };

        ChatV2Repo::create_message_with_conn(&tx, &new_message).map_err(|e| e.to_string())?;
    }

    // 9. 写入新块（必须在 messages 之后，因为 blocks.message_id FK → messages.id）
    for (old_block_id, new_block_id) in &block_id_map {
        if let Some(source_block) = source_blocks_map.get(old_block_id) {
            // 映射 message_id
            let new_message_id = msg_id_map
                .get(&source_block.message_id)
                .cloned()
                .unwrap_or_else(|| source_block.message_id.clone());

            let new_block = crate::chat_v2::types::MessageBlock {
                id: new_block_id.clone(),
                message_id: new_message_id,
                block_type: source_block.block_type.clone(),
                status: source_block.status.clone(),
                content: source_block.content.clone(),
                tool_name: source_block.tool_name.clone(),
                tool_input: source_block.tool_input.clone(),
                tool_output: source_block.tool_output.clone(),
                citations: source_block.citations.clone(),
                error: source_block.error.clone(),
                started_at: source_block.started_at,
                ended_at: source_block.ended_at,
                first_chunk_at: source_block.first_chunk_at,
                block_index: source_block.block_index,
            };
            ChatV2Repo::create_block_with_conn(&tx, &new_block).map_err(|e| e.to_string())?;
        }
    }

    // 10. 复制 session_state（裁剪草稿字段）
    if let Ok(Some(source_state)) = ChatV2Repo::load_session_state_with_conn(&tx, source_session_id)
    {
        let branched_state = SessionState {
            session_id: new_session_id.clone(),
            chat_params: source_state.chat_params,
            features: source_state.features,
            mode_state: source_state.mode_state,
            input_value: None,  // 清空输入草稿
            panel_states: None, // 清空面板 UI 状态
            updated_at: now.to_rfc3339(),
            pending_context_refs_json: None, // 清空待发送上下文
            loaded_skill_ids_json: source_state.loaded_skill_ids_json,
            active_skill_ids_json: source_state.active_skill_ids_json,
        };
        let _ = ChatV2Repo::save_session_state_with_conn(&tx, &new_session_id, &branched_state);
    }

    // 11. 提交事务
    tx.commit()
        .map_err(|e| format!("Failed to commit branch transaction: {}", e))?;

    log::info!(
        "[ChatV2::handlers] Branch transaction committed: {} messages, {} blocks copied",
        messages_to_copy.len(),
        block_id_map.len()
    );

    Ok((new_session, resource_ids))
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
