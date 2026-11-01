//! 会话加载命令处理器
//!
//! 加载会话的完整数据，包括会话信息、消息列表、块列表和会话状态。

use std::sync::Arc;

use std::time::Instant;

use tauri::State;

use crate::chat_v2::database::ChatV2Database;
use crate::chat_v2::error::ChatV2Error;
use crate::chat_v2::repo::ChatV2Repo;
use crate::chat_v2::types::{AuthorityMode, LoadSessionResponse, SessionAuthorityState};

/// 加载会话完整数据
///
/// 从数据库加载会话的所有相关数据，用于前端初始化会话视图。
///
/// ## 参数
/// - `session_id`: 会话 ID
/// - `db`: Chat V2 独立数据库
///
/// ## 返回
/// - `Ok(LoadSessionResponse)`: 会话完整数据
/// - `Err(String)`: 会话不存在或加载失败
///
/// ## 响应结构
/// ```json
/// {
///   "session": { ... },
///   "messages": [ ... ],
///   "blocks": [ ... ],
///   "state": { ... }
/// }
/// ```
#[tauri::command]
pub async fn chat_v2_load_session(
    session_id: String,
    tail_limit: Option<u32>,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<LoadSessionResponse, String> {
    let t0 = Instant::now();
    log::info!(
        "[ChatV2::handlers] chat_v2_load_session: session_id={}, tail_limit={:?}",
        session_id,
        tail_limit
    );

    // 历史版本使用过多种会话 ID 前缀；这里只拒绝空值，具体存在性由仓储层判断。
    if session_id.trim().is_empty() {
        return Err(
            ChatV2Error::Validation("Invalid session ID: empty or whitespace-only".into()).into(),
        );
    }

    // 从数据库加载会话数据（tail_limit 存在时只取最近 N 条，用于首屏加速）
    let response = load_session_from_db(&session_id, tail_limit, &db)?;

    let elapsed_ms = t0.elapsed().as_millis();
    log::info!(
        "[ChatV2::handlers] Loaded session: session_id={}, messages={}, blocks={}, total={:?}, elapsed_ms={}",
        session_id,
        response.messages.len(),
        response.blocks.len(),
        response.total_message_count,
        elapsed_ms
    );

    Ok(response)
}

/// 从数据库加载会话数据
fn load_session_from_db(
    session_id: &str,
    tail_limit: Option<u32>,
    db: &ChatV2Database,
) -> Result<LoadSessionResponse, ChatV2Error> {
    let mut response = match tail_limit {
        Some(limit) if limit > 0 => {
            let conn = db.get_conn_safe()?;
            ChatV2Repo::load_session_tail_with_conn(&conn, session_id, limit)
        }
        _ => ChatV2Repo::load_session_full_v2(db, session_id),
    }?;

    // Ask/Plan were removed from the product UI. Normalize their persisted
    // backend state before returning so an old session cannot look like Craft
    // while remaining governed by a hidden authority mode.
    let authority = SessionAuthorityState::from_metadata(response.session.metadata.as_ref());
    if authority.authority_mode != AuthorityMode::Craft {
        response.session =
            ChatV2Repo::set_session_authority_mode(db, session_id, AuthorityMode::Craft)?;
    }

    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_v2::types::{ChatSession, PermissionPreset};
    use crate::data_governance::migration::coordinator::MigrationCoordinator;
    use crate::data_governance::schema_registry::DatabaseId;

    #[test]
    fn test_session_id_validation() {
        // 有效的会话 ID
        assert!("sess_12345".starts_with("sess_"));
        assert!("sess_a1b2c3d4-e5f6-7890-abcd-ef1234567890".starts_with("sess_"));
        assert!("agent_12345".starts_with("agent_"));
        assert!("subagent_foo_bar".starts_with("subagent_"));

        // 无效的会话 ID
        assert!(!"invalid_id".starts_with("sess_"));
        assert!(!"session_12345".starts_with("sess_"));
    }

    #[test]
    fn loading_session_persists_retired_authority_mode_as_craft() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut coordinator =
            MigrationCoordinator::new(dir.path().to_path_buf()).with_audit_db(None);
        coordinator
            .migrate_single(DatabaseId::ChatV2)
            .expect("chat v2 migrations");
        let db = ChatV2Database::new(dir.path()).expect("chat v2 db");

        let mut session = ChatSession::new("sess_retired_plan".into(), "general_chat".into());
        session.metadata = Some(
            SessionAuthorityState {
                authority_mode: AuthorityMode::Plan,
                permission_preset: PermissionPreset::FullAccess,
                plan: None,
            }
            .apply_to_metadata(None),
        );
        ChatV2Repo::create_session_v2(&db, &session).expect("create session");

        let loaded = load_session_from_db(&session.id, None, &db).expect("load session");
        let loaded_authority =
            SessionAuthorityState::from_metadata(loaded.session.metadata.as_ref());
        assert_eq!(loaded_authority.authority_mode, AuthorityMode::Craft);
        assert_eq!(
            loaded_authority.permission_preset,
            PermissionPreset::FullAccess
        );

        let persisted =
            ChatV2Repo::get_session_authority_state(&db, &session.id).expect("load authority");
        assert_eq!(persisted, loaded_authority);
    }
}
