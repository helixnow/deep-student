//! 会话分组命令处理器
//!
//! 提供会话分组的 CRUD、排序、会话移动等功能。

use std::sync::Arc;

use tauri::State;

use crate::chat_v2::database::ChatV2Database;
use crate::chat_v2::error::ChatV2Error;
use crate::chat_v2::repo::ChatV2Repo;
use crate::chat_v2::state::ChatV2State;
use crate::chat_v2::types::{CreateGroupRequest, PersistStatus, SessionGroup, UpdateGroupRequest};
use crate::vfs::{VfsDatabase, VfsFolder, VfsFolderRepo, MAX_FOLDER_TITLE_LENGTH};

use super::manage_session::decrement_vfs_refs_for_session;

fn topic_folder_title(name: &str) -> String {
    let mut title: String = name
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, '\0' | '/' | '\\') {
                '_'
            } else {
                ch
            }
        })
        .take(MAX_FOLDER_TITLE_LENGTH)
        .collect();
    title = title.trim_matches('_').trim().to_string();
    if title.is_empty() {
        "未命名课题".to_string()
    } else {
        title
    }
}

fn first_pinned_folder_id(pinned_resource_ids: &[String]) -> Option<String> {
    pinned_resource_ids.iter().find_map(|id| {
        id.trim()
            .strip_prefix("fld_")
            .map(|_| id.trim().to_string())
    })
}

fn prepend_unique_pinned_folder(
    mut pinned_resource_ids: Vec<String>,
    folder_id: String,
) -> Vec<String> {
    pinned_resource_ids.retain(|id| id.trim() != folder_id);
    pinned_resource_ids.insert(0, folder_id);
    pinned_resource_ids
}

pub(crate) fn ensure_group_folder(
    vfs_db: &VfsDatabase,
    group_name: &str,
    pinned_resource_ids: Vec<String>,
) -> Result<Vec<String>, String> {
    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;
    let folder_title = topic_folder_title(group_name);

    if let Some(folder_id) = first_pinned_folder_id(&pinned_resource_ids) {
        if let Some(mut folder) =
            VfsFolderRepo::get_folder_with_conn(&conn, &folder_id).map_err(|e| e.to_string())?
        {
            if folder.parent_id.is_some()
                || !VfsFolderRepo::folder_exists_with_conn(&conn, &folder_id)
                    .map_err(|e| e.to_string())?
            {
                // A pinned child/deleted folder is not a valid topic root. Create a fresh
                // root below instead of reusing another topic's same-named folder.
            } else {
                let unique_title = VfsFolderRepo::generate_unique_folder_title_with_conn(
                    &conn,
                    &folder_title,
                    folder.parent_id.as_deref(),
                    Some(&folder_id),
                )
                .map_err(|e| e.to_string())?;
                if folder.title != unique_title {
                    folder.title = unique_title;
                    VfsFolderRepo::update_folder_with_conn(&conn, &folder)
                        .map_err(|e| e.to_string())?;
                }
                return Ok(prepend_unique_pinned_folder(pinned_resource_ids, folder_id));
            }
        }
    }

    let unique_title =
        VfsFolderRepo::generate_unique_folder_title_with_conn(&conn, &folder_title, None, None)
            .map_err(|e| e.to_string())?;
    let folder = VfsFolder::new(unique_title, None, Some("folder".to_string()), None);
    VfsFolderRepo::create_folder_with_conn(&conn, &folder).map_err(|e| e.to_string())?;
    Ok(prepend_unique_pinned_folder(pinned_resource_ids, folder.id))
}

/// 创建分组
#[tauri::command]
pub async fn chat_v2_create_group(
    request: CreateGroupRequest,
    db: State<'_, Arc<ChatV2Database>>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<SessionGroup, String> {
    let conn = db.get_conn_safe().map_err(|e| e.to_string())?;

    // 计算 sort_order（追加到末尾）
    let existing =
        ChatV2Repo::list_groups_with_conn(&conn, Some("active"), request.workspace_id.as_deref())
            .map_err(|e| e.to_string())?;
    let next_sort = existing.iter().map(|g| g.sort_order).max().unwrap_or(0) + 1;

    let now = chrono::Utc::now();
    let pinned_resource_ids = ensure_group_folder(
        vfs_db.inner().as_ref(),
        &request.name,
        request.pinned_resource_ids.unwrap_or_default(),
    )?;
    let group = SessionGroup {
        id: SessionGroup::generate_id(),
        name: request.name,
        description: request.description,
        icon: request.icon,
        color: request.color,
        system_prompt: request.system_prompt,
        default_skill_ids: request.default_skill_ids.unwrap_or_default(),
        pinned_resource_ids,
        workspace_id: request.workspace_id,
        sort_order: next_sort,
        persist_status: PersistStatus::Active,
        created_at: now,
        updated_at: now,
    };

    ChatV2Repo::create_group_with_conn(&conn, &group).map_err(|e| e.to_string())?;
    Ok(group)
}

/// 更新分组
#[tauri::command]
pub async fn chat_v2_update_group(
    group_id: String,
    request: UpdateGroupRequest,
    db: State<'_, Arc<ChatV2Database>>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<SessionGroup, String> {
    let mut conn = db.get_conn_safe().map_err(|e| e.to_string())?;
    let existing = ChatV2Repo::get_group_with_conn(&conn, &group_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| ChatV2Error::GroupNotFound(group_id.clone()).to_string())?;

    let now = chrono::Utc::now();

    // Helper: None => keep existing, Some("") => clear to None, Some(val) => set new value
    fn merge_optional_string(
        request_val: Option<String>,
        existing_val: Option<String>,
    ) -> Option<String> {
        match request_val {
            None => existing_val,
            Some(s) if s.trim().is_empty() => None,
            Some(s) => Some(s),
        }
    }

    let name = request.name.unwrap_or(existing.name);
    let pinned_resource_ids = ensure_group_folder(
        vfs_db.inner().as_ref(),
        &name,
        request
            .pinned_resource_ids
            .unwrap_or(existing.pinned_resource_ids),
    )?;

    let requested_status = request.persist_status;
    let updated = SessionGroup {
        id: existing.id,
        name,
        description: merge_optional_string(request.description, existing.description),
        icon: merge_optional_string(request.icon, existing.icon),
        color: merge_optional_string(request.color, existing.color),
        system_prompt: merge_optional_string(request.system_prompt, existing.system_prompt),
        default_skill_ids: request
            .default_skill_ids
            .unwrap_or(existing.default_skill_ids),
        pinned_resource_ids,
        workspace_id: merge_optional_string(request.workspace_id, existing.workspace_id),
        sort_order: request.sort_order.unwrap_or(existing.sort_order),
        persist_status: requested_status.clone().unwrap_or(existing.persist_status),
        created_at: existing.created_at,
        updated_at: now,
    };

    ChatV2Repo::update_group_with_conn(&conn, &updated).map_err(|e| e.to_string())?;
    match requested_status {
        Some(PersistStatus::Archived) => {
            ChatV2Repo::archive_group_with_conn(&mut conn, &group_id).map_err(|e| e.to_string())?;
        }
        Some(PersistStatus::Active) => {
            ChatV2Repo::restore_group_with_conn(&mut conn, &group_id).map_err(|e| e.to_string())?;
        }
        _ => {}
    }
    Ok(updated)
}

/// 删除分组（软删除）
#[tauri::command]
pub async fn chat_v2_delete_group(
    group_id: String,
    db: State<'_, Arc<ChatV2Database>>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    chat_v2_state: State<'_, Arc<ChatV2State>>,
) -> Result<(), String> {
    let mut conn = db.get_conn_safe().map_err(|e| e.to_string())?;
    let group = ChatV2Repo::get_group_with_conn(&conn, &group_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| ChatV2Error::GroupNotFound(group_id.clone()).to_string())?;
    if group.persist_status == PersistStatus::Active {
        return Err(
            ChatV2Error::Validation("请先归档课题，再从归档页永久删除。".to_string()).to_string(),
        );
    }

    let session_ids = ChatV2Repo::list_session_ids_owned_by_group_with_conn(&conn, &group_id)
        .map_err(|e| e.to_string())?;
    for session_id in &session_ids {
        if chat_v2_state.has_active_stream(session_id) {
            return Err(ChatV2Error::Other(
                "Cannot delete topic while a session is streaming. Please wait for completion or cancel first."
                    .to_string(),
            )
            .to_string());
        }
        super::manage_session::session_has_running_anki_blocks(db.inner().as_ref(), session_id)?;
    }
    for session_id in &session_ids {
        decrement_vfs_refs_for_session(db.inner().as_ref(), vfs_db.inner().as_ref(), session_id);
    }

    ChatV2Repo::permanently_delete_group_with_conn(&mut conn, &group_id)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 归档分组，并把分组内活跃会话一起归档，保留 group_id 供恢复使用
#[tauri::command]
pub async fn chat_v2_archive_group(
    group_id: String,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<(), String> {
    let mut conn = db.get_conn_safe().map_err(|e| e.to_string())?;
    ChatV2Repo::archive_group_with_conn(&mut conn, &group_id).map_err(|e| e.to_string())?;
    Ok(())
}

/// 恢复分组，并恢复其下已归档会话
#[tauri::command]
pub async fn chat_v2_restore_group(
    group_id: String,
    db: State<'_, Arc<ChatV2Database>>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<SessionGroup, String> {
    let mut conn = db.get_conn_safe().map_err(|e| e.to_string())?;
    ChatV2Repo::restore_group_with_conn(&mut conn, &group_id).map_err(|e| e.to_string())?;

    let mut group = ChatV2Repo::get_group_with_conn(&conn, &group_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| ChatV2Error::GroupNotFound(group_id.clone()).to_string())?;

    let pinned_resource_ids = ensure_group_folder(
        vfs_db.inner().as_ref(),
        &group.name,
        group.pinned_resource_ids.clone(),
    )?;
    if pinned_resource_ids != group.pinned_resource_ids {
        group.pinned_resource_ids = pinned_resource_ids;
        ChatV2Repo::update_group_with_conn(&conn, &group).map_err(|e| e.to_string())?;
    }

    Ok(group)
}

/// 获取分组详情
#[tauri::command]
pub async fn chat_v2_get_group(
    group_id: String,
    db: State<'_, Arc<ChatV2Database>>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Option<SessionGroup>, String> {
    let conn = db.get_conn_safe().map_err(|e| e.to_string())?;
    let Some(mut group) =
        ChatV2Repo::get_group_with_conn(&conn, &group_id).map_err(|e| e.to_string())?
    else {
        return Ok(None);
    };

    if group.persist_status == PersistStatus::Active {
        let pinned_resource_ids = ensure_group_folder(
            vfs_db.inner().as_ref(),
            &group.name,
            group.pinned_resource_ids.clone(),
        )?;
        if pinned_resource_ids != group.pinned_resource_ids {
            group.pinned_resource_ids = pinned_resource_ids;
            group.updated_at = chrono::Utc::now();
            ChatV2Repo::update_group_with_conn(&conn, &group).map_err(|e| e.to_string())?;
        }
    }

    Ok(Some(group))
}

/// 列出分组
#[tauri::command]
pub async fn chat_v2_list_groups(
    status: Option<String>,
    workspace_id: Option<String>,
    db: State<'_, Arc<ChatV2Database>>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<SessionGroup>, String> {
    let conn = db.get_conn_safe().map_err(|e| e.to_string())?;
    let mut groups =
        ChatV2Repo::list_groups_with_conn(&conn, status.as_deref(), workspace_id.as_deref())
            .map_err(|e| e.to_string())?;
    for group in groups.iter_mut() {
        if group.persist_status != PersistStatus::Active {
            continue;
        }
        let next_pinned = ensure_group_folder(
            vfs_db.inner().as_ref(),
            &group.name,
            group.pinned_resource_ids.clone(),
        )?;
        if next_pinned != group.pinned_resource_ids {
            group.pinned_resource_ids = next_pinned;
            ChatV2Repo::update_group_with_conn(&conn, group).map_err(|e| e.to_string())?;
        }
    }
    Ok(groups)
}

/// 批量更新分组排序
#[tauri::command]
pub async fn chat_v2_reorder_groups(
    group_ids: Vec<String>,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<(), String> {
    let mut conn = db.get_conn_safe().map_err(|e| e.to_string())?;
    ChatV2Repo::reorder_groups_with_conn(&mut conn, &group_ids).map_err(|e| e.to_string())?;
    Ok(())
}

/// 移动会话到分组
#[tauri::command]
pub async fn chat_v2_move_session_to_group(
    session_id: String,
    group_id: Option<String>,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<(), String> {
    let conn = db.get_conn_safe().map_err(|e| e.to_string())?;
    let normalized_group_id =
        group_id.and_then(|g| if g.trim().is_empty() { None } else { Some(g) });

    // P1-5/P1-6 fix: Validate target group exists and is active
    if let Some(ref gid) = normalized_group_id {
        let group = ChatV2Repo::get_group_with_conn(&conn, gid).map_err(|e| e.to_string())?;
        match group {
            Some(g) if g.persist_status != PersistStatus::Active => {
                return Err(ChatV2Error::GroupNotFound(gid.clone()).to_string());
            }
            None => {
                return Err(ChatV2Error::GroupNotFound(gid.clone()).to_string());
            }
            _ => {}
        }
    }

    ChatV2Repo::update_session_group_with_conn(&conn, &session_id, normalized_group_id.as_deref())
        .map_err(|e| e.to_string())?;
    Ok(())
}
