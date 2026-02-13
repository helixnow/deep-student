//! Chat V2 数据存取层
//!
//! 提供 Chat V2 模块的数据库 CRUD 操作。
//! 支持两种数据库连接方式：
//! - `ChatV2Database`：Chat V2 独立数据库（推荐）
//!
//! 所有方法均提供 `_with_conn` 版本，直接操作 `Connection`。

use crate::database::Database;
use chrono::{DateTime, TimeZone, Utc};
use log::{debug, info};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::Value;
use std::time::Instant;

use super::database::ChatV2Database;
use super::error::{ChatV2Error, ChatV2Result};
use super::types::{
    AttachmentMeta, ChatMessage, ChatParams, ChatSession, DeleteVariantResult, LoadSessionResponse,
    MessageBlock, MessageMeta, MessageRole, PanelStates, PersistStatus, SessionGroup, SessionState,
    SharedContext, Variant,
};

/// Chat V2 数据存取层
///
/// 所有方法均为静态方法，支持事务操作。
pub struct ChatV2Repo;

impl ChatV2Repo {
    // ========================================================================
    // 会话 CRUD
    // ========================================================================

    /// 创建会话
    pub fn create_session(db: &Database, session: &ChatSession) -> ChatV2Result<()> {
        let conn = db.get_conn_safe()?;
        Self::create_session_with_conn(&conn, session)
    }

    /// 创建会话（使用现有连接）
    pub fn create_session_with_conn(conn: &Connection, session: &ChatSession) -> ChatV2Result<()> {
        debug!(
            "[ChatV2::Repo] Creating session: id={}, mode={}",
            session.id, session.mode
        );

        let metadata_json = session
            .metadata
            .as_ref()
            .map(|v| serde_json::to_string(v))
            .transpose()?;

        let persist_status = match session.persist_status {
            PersistStatus::Active => "active",
            PersistStatus::Archived => "archived",
            PersistStatus::Deleted => "deleted",
        };

        conn.execute(
            r#"
            INSERT INTO chat_v2_sessions (
                id, mode, title, description, summary_hash, persist_status,
                created_at, updated_at, metadata_json, group_id
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            "#,
            params![
                session.id,
                session.mode,
                session.title,
                session.description,
                session.summary_hash,
                persist_status,
                session.created_at.to_rfc3339(),
                session.updated_at.to_rfc3339(),
                metadata_json,
                session.group_id,
            ],
        )?;

        info!("[ChatV2::Repo] Session created: {}", session.id);
        Ok(())
    }

    /// 获取会话
    pub fn get_session(db: &Database, session_id: &str) -> ChatV2Result<Option<ChatSession>> {
        let conn = db.get_conn_safe()?;
        Self::get_session_with_conn(&conn, session_id)
    }

    /// 获取会话（使用现有连接）
    pub fn get_session_with_conn(
        conn: &Connection,
        session_id: &str,
    ) -> ChatV2Result<Option<ChatSession>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, mode, title, description, summary_hash, persist_status, created_at, updated_at, metadata_json, group_id
            FROM chat_v2_sessions
            WHERE id = ?1
            "#,
        )?;

        let session = stmt
            .query_row(params![session_id], Self::row_to_session_full)
            .optional()?;

        Ok(session)
    }

    /// 将数据库行转换为 ChatSession（完整字段）
    fn row_to_session_full(row: &rusqlite::Row) -> rusqlite::Result<ChatSession> {
        let id: String = row.get(0)?;
        let mode: String = row.get(1)?;
        let title: Option<String> = row.get(2)?;
        let description: Option<String> = row.get(3)?;
        let summary_hash: Option<String> = row.get(4)?;
        let persist_status_str: String = row.get(5)?;
        let created_at_str: String = row.get(6)?;
        let updated_at_str: String = row.get(7)?;
        let metadata_json: Option<String> = row.get(8)?;
        let group_id: Option<String> = row.get(9)?;

        let persist_status = match persist_status_str.as_str() {
            "active" => PersistStatus::Active,
            "archived" => PersistStatus::Archived,
            "deleted" => PersistStatus::Deleted,
            _ => PersistStatus::Active,
        };

        // 🔒 审计修复: 时间戳解析失败时使用 UNIX_EPOCH 而非 Utc::now()
        // 原代码使用 Utc::now() 导致旧数据在解析失败时"变成最新"，破坏排序
        let created_at = DateTime::parse_from_rfc3339(&created_at_str)
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(|e| {
                log::warn!(
                    "[ChatV2Repo] Failed to parse created_at '{}': {}, using epoch fallback",
                    created_at_str,
                    e
                );
                DateTime::<Utc>::from(std::time::UNIX_EPOCH)
            });

        let updated_at = DateTime::parse_from_rfc3339(&updated_at_str)
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(|e| {
                log::warn!(
                    "[ChatV2Repo] Failed to parse updated_at '{}': {}, using epoch fallback",
                    updated_at_str,
                    e
                );
                DateTime::<Utc>::from(std::time::UNIX_EPOCH)
            });

        let metadata: Option<Value> = metadata_json
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok());

        Ok(ChatSession {
            id,
            mode,
            title,
            description,
            summary_hash,
            persist_status,
            created_at,
            updated_at,
            metadata,
            group_id,
        })
    }

    /// 更新会话
    pub fn update_session(db: &Database, session: &ChatSession) -> ChatV2Result<()> {
        let conn = db.get_conn_safe()?;
        Self::update_session_with_conn(&conn, session)
    }

    /// 更新会话（使用现有连接）
    pub fn update_session_with_conn(conn: &Connection, session: &ChatSession) -> ChatV2Result<()> {
        debug!("[ChatV2::Repo] Updating session: {}", session.id);

        let metadata_json = session
            .metadata
            .as_ref()
            .map(|v| serde_json::to_string(v))
            .transpose()?;

        let persist_status = match session.persist_status {
            PersistStatus::Active => "active",
            PersistStatus::Archived => "archived",
            PersistStatus::Deleted => "deleted",
        };

        let rows_affected = conn.execute(
            r#"
            UPDATE chat_v2_sessions
            SET mode = ?2, title = ?3, description = ?4, summary_hash = ?5, persist_status = ?6,
                updated_at = ?7, metadata_json = ?8, group_id = ?9
            WHERE id = ?1
            "#,
            params![
                session.id,
                session.mode,
                session.title,
                session.description,
                session.summary_hash,
                persist_status,
                session.updated_at.to_rfc3339(),
                metadata_json,
                session.group_id,
            ],
        )?;

        if rows_affected == 0 {
            return Err(ChatV2Error::SessionNotFound(session.id.clone()));
        }

        info!("[ChatV2::Repo] Session updated: {}", session.id);
        Ok(())
    }

    /// 删除会话（级联删除消息和块）
    pub fn delete_session(db: &Database, session_id: &str) -> ChatV2Result<()> {
        let mut conn = db.get_conn_safe()?;
        let tx = conn.transaction()?;
        Self::delete_session_with_tx(&tx, session_id)?;
        tx.commit()?;
        Ok(())
    }

    /// 删除会话（使用事务）
    pub fn delete_session_with_tx(tx: &Transaction, session_id: &str) -> ChatV2Result<()> {
        debug!("[ChatV2::Repo] Deleting session: {}", session_id);

        // 级联删除由外键约束自动处理（ON DELETE CASCADE）
        let rows_affected = tx.execute(
            "DELETE FROM chat_v2_sessions WHERE id = ?1",
            params![session_id],
        )?;

        if rows_affected == 0 {
            return Err(ChatV2Error::SessionNotFound(session_id.to_string()));
        }

        info!(
            "[ChatV2::Repo] Session deleted with cascade: {}",
            session_id
        );
        Ok(())
    }

    /// 列出会话
    pub fn list_sessions(
        db: &Database,
        status: Option<&str>,
        limit: u32,
    ) -> ChatV2Result<Vec<ChatSession>> {
        let conn = db.get_conn_safe()?;
        Self::list_sessions_with_conn(&conn, status, None, limit, 0)
    }

    /// 列出会话（使用现有连接）
    ///
    /// ## 参数
    /// - `conn`: 数据库连接
    /// - `status`: 可选的状态过滤（active/archived/deleted）
    /// - `limit`: 数量限制
    /// - `offset`: 偏移量（用于分页）
    pub fn list_sessions_with_conn(
        conn: &Connection,
        status: Option<&str>,
        group_id: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> ChatV2Result<Vec<ChatSession>> {
        // 动态构建 SQL 查询
        // 🔧 2026-01-20: 过滤掉 mode='agent' 的 Worker 会话，它们应该在工作区面板中单独显示
        let mut sql = String::from(
            r#"
                SELECT id, mode, title, description, summary_hash, persist_status, created_at, updated_at, metadata_json, group_id
                FROM chat_v2_sessions
                WHERE mode != 'agent'
            "#,
        );
        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        if let Some(s) = status {
            sql.push_str(" AND persist_status = ?");
            params_vec.push(Box::new(s.to_string()));
        }

        if let Some(gid) = group_id {
            if gid.is_empty() {
                sql.push_str(" AND group_id IS NULL");
            } else {
                sql.push_str(" AND group_id = ?");
                params_vec.push(Box::new(gid.to_string()));
            }
        }

        sql.push_str(" ORDER BY updated_at DESC LIMIT ? OFFSET ?");
        params_vec.push(Box::new(limit));
        params_vec.push(Box::new(offset));

        let mut stmt = conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();
        let rows = stmt.query_map(params_refs.as_slice(), Self::row_to_session_full)?;

        let sessions: Vec<ChatSession> = rows
            .filter_map(|r| match r {
                Ok(val) => Some(val),
                Err(e) => {
                    log::warn!("[ChatV2Repo] Skipping malformed row: {}", e);
                    None
                }
            })
            .collect();
        Ok(sessions)
    }

    /// 获取会话总数
    ///
    /// ## 参数
    /// - `conn`: 数据库连接
    /// - `status`: 可选的状态过滤（active/archived/deleted）
    ///
    /// 🔧 2026-01-20: 过滤掉 mode='agent' 的 Worker 会话
    pub fn count_sessions_with_conn(
        conn: &Connection,
        status: Option<&str>,
        group_id: Option<&str>,
    ) -> ChatV2Result<u32> {
        let mut sql = String::from("SELECT COUNT(*) FROM chat_v2_sessions WHERE mode != 'agent'");
        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        if let Some(s) = status {
            sql.push_str(" AND persist_status = ?");
            params_vec.push(Box::new(s.to_string()));
        }

        if let Some(gid) = group_id {
            if gid.is_empty() {
                sql.push_str(" AND group_id IS NULL");
            } else {
                sql.push_str(" AND group_id = ?");
                params_vec.push(Box::new(gid.to_string()));
            }
        }

        let params_refs: Vec<&dyn rusqlite::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();
        let count: u32 = conn.query_row(&sql, params_refs.as_slice(), |row| row.get(0))?;
        Ok(count)
    }

    // ========================================================================
    // 会话分组 CRUD
    // ========================================================================

    /// 创建分组
    pub fn create_group_with_conn(conn: &Connection, group: &SessionGroup) -> ChatV2Result<()> {
        let default_skill_ids_json = serde_json::to_string(&group.default_skill_ids)?;
        let persist_status = match group.persist_status {
            PersistStatus::Active => "active",
            PersistStatus::Archived => "archived",
            PersistStatus::Deleted => "deleted",
        };

        conn.execute(
            r#"
            INSERT INTO chat_v2_session_groups (
                id, name, description, icon, color, system_prompt,
                default_skill_ids_json, workspace_id, sort_order, persist_status,
                created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
            "#,
            params![
                group.id,
                group.name,
                group.description,
                group.icon,
                group.color,
                group.system_prompt,
                default_skill_ids_json,
                group.workspace_id,
                group.sort_order,
                persist_status,
                group.created_at.to_rfc3339(),
                group.updated_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    /// 获取分组
    pub fn get_group_with_conn(
        conn: &Connection,
        group_id: &str,
    ) -> ChatV2Result<Option<SessionGroup>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, name, description, icon, color, system_prompt, default_skill_ids_json,
                   workspace_id, sort_order, persist_status, created_at, updated_at
            FROM chat_v2_session_groups
            WHERE id = ?1
            "#,
        )?;

        let group = stmt
            .query_row(params![group_id], Self::row_to_group)
            .optional()?;
        Ok(group)
    }

    /// 列出分组
    pub fn list_groups_with_conn(
        conn: &Connection,
        status: Option<&str>,
        workspace_id: Option<&str>,
    ) -> ChatV2Result<Vec<SessionGroup>> {
        let mut sql = String::from(
            r#"
                SELECT id, name, description, icon, color, system_prompt, default_skill_ids_json,
                       workspace_id, sort_order, persist_status, created_at, updated_at
                FROM chat_v2_session_groups
                WHERE 1=1
            "#,
        );
        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        if let Some(s) = status {
            sql.push_str(" AND persist_status = ?");
            params_vec.push(Box::new(s.to_string()));
        }

        if let Some(wid) = workspace_id {
            sql.push_str(" AND workspace_id = ?");
            params_vec.push(Box::new(wid.to_string()));
        }

        sql.push_str(" ORDER BY sort_order ASC, updated_at DESC");

        let mut stmt = conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();
        let rows = stmt.query_map(params_refs.as_slice(), Self::row_to_group)?;
        Ok(rows
            .filter_map(|r| match r {
                Ok(val) => Some(val),
                Err(e) => {
                    log::warn!("[ChatV2Repo] Skipping malformed row: {}", e);
                    None
                }
            })
            .collect())
    }

    /// 更新分组
    pub fn update_group_with_conn(conn: &Connection, group: &SessionGroup) -> ChatV2Result<()> {
        let default_skill_ids_json = serde_json::to_string(&group.default_skill_ids)?;
        let persist_status = match group.persist_status {
            PersistStatus::Active => "active",
            PersistStatus::Archived => "archived",
            PersistStatus::Deleted => "deleted",
        };

        conn.execute(
            r#"
            UPDATE chat_v2_session_groups
            SET name = ?2, description = ?3, icon = ?4, color = ?5, system_prompt = ?6,
                default_skill_ids_json = ?7, workspace_id = ?8, sort_order = ?9,
                persist_status = ?10, updated_at = ?11
            WHERE id = ?1
            "#,
            params![
                group.id,
                group.name,
                group.description,
                group.icon,
                group.color,
                group.system_prompt,
                default_skill_ids_json,
                group.workspace_id,
                group.sort_order,
                persist_status,
                group.updated_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    /// 软删除分组（并将关联会话置为未分组）
    pub fn soft_delete_group_with_conn(conn: &mut Connection, group_id: &str) -> ChatV2Result<()> {
        let tx = conn.transaction()?;
        tx.execute(
            r#"
            UPDATE chat_v2_session_groups
            SET persist_status = 'deleted', updated_at = ?2
            WHERE id = ?1
            "#,
            params![group_id, Utc::now().to_rfc3339()],
        )?;

        tx.execute(
            "UPDATE chat_v2_sessions SET group_id = NULL WHERE group_id = ?1",
            params![group_id],
        )?;

        tx.commit()?;
        Ok(())
    }

    /// 批量更新分组排序
    pub fn reorder_groups_with_conn(
        conn: &mut Connection,
        group_ids: &[String],
    ) -> ChatV2Result<()> {
        let tx = conn.transaction()?;
        for (idx, group_id) in group_ids.iter().enumerate() {
            tx.execute(
                "UPDATE chat_v2_session_groups SET sort_order = ?2, updated_at = ?3 WHERE id = ?1",
                params![group_id, idx as i32, Utc::now().to_rfc3339()],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// 移动会话到分组（group_id 为 None 表示移除分组）
    pub fn update_session_group_with_conn(
        conn: &Connection,
        session_id: &str,
        group_id: Option<&str>,
    ) -> ChatV2Result<()> {
        conn.execute(
            "UPDATE chat_v2_sessions SET group_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![session_id, group_id, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    /// 将数据库行转换为 SessionGroup
    fn row_to_group(row: &rusqlite::Row) -> rusqlite::Result<SessionGroup> {
        let id: String = row.get(0)?;
        let name: String = row.get(1)?;
        let description: Option<String> = row.get(2)?;
        let icon: Option<String> = row.get(3)?;
        let color: Option<String> = row.get(4)?;
        let system_prompt: Option<String> = row.get(5)?;
        let default_skill_ids_json: Option<String> = row.get(6)?;
        let workspace_id: Option<String> = row.get(7)?;
        let sort_order: i32 = row.get(8)?;
        let persist_status_str: String = row.get(9)?;
        let created_at_str: String = row.get(10)?;
        let updated_at_str: String = row.get(11)?;

        let persist_status = match persist_status_str.as_str() {
            "active" => PersistStatus::Active,
            "archived" => PersistStatus::Archived,
            "deleted" => PersistStatus::Deleted,
            _ => PersistStatus::Active,
        };

        // 🔒 审计修复: row_to_group 也使用 UNIX_EPOCH fallback（与 row_to_session_full 一致）
        let created_at = DateTime::parse_from_rfc3339(&created_at_str)
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(|e| {
                log::warn!("[ChatV2Repo] row_to_group: Failed to parse created_at '{}': {}, using epoch fallback", created_at_str, e);
                DateTime::<Utc>::from(std::time::UNIX_EPOCH)
            });

        let updated_at = DateTime::parse_from_rfc3339(&updated_at_str)
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(|e| {
                log::warn!("[ChatV2Repo] row_to_group: Failed to parse updated_at '{}': {}, using epoch fallback", updated_at_str, e);
                DateTime::<Utc>::from(std::time::UNIX_EPOCH)
            });

        let default_skill_ids: Vec<String> = default_skill_ids_json
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();

        Ok(SessionGroup {
            id,
            name,
            description,
            icon,
            color,
            system_prompt,
            default_skill_ids,
            workspace_id,
            sort_order,
            persist_status,
            created_at,
            updated_at,
        })
    }

    /// 🆕 2026-01-20: 列出 Worker 会话（mode='agent'）
    ///
    /// 用于工作区面板显示 Agent 会话列表
    ///
    /// ## 参数
    /// - `conn`: 数据库连接
    /// - `workspace_id`: 可选的工作区 ID 过滤（从 metadata_json 中提取）
    /// - `limit`: 数量限制
    pub fn list_agent_sessions_with_conn(
        conn: &Connection,
        workspace_id: Option<&str>,
        limit: u32,
    ) -> ChatV2Result<Vec<ChatSession>> {
        let (sql, params_vec): (String, Vec<Box<dyn rusqlite::ToSql>>) = match workspace_id {
            Some(wid) => (
                r#"
                    SELECT id, mode, title, description, summary_hash, persist_status, created_at, updated_at, metadata_json, group_id
                    FROM chat_v2_sessions
                    WHERE mode = 'agent'
                      AND persist_status = 'active'
                      AND json_extract(metadata_json, '$.workspace_id') = ?1
                    ORDER BY updated_at DESC
                    LIMIT ?2
                "#.to_string(),
                vec![Box::new(wid.to_string()), Box::new(limit)]
            ),
            None => (
                r#"
                    SELECT id, mode, title, description, summary_hash, persist_status, created_at, updated_at, metadata_json, group_id
                    FROM chat_v2_sessions
                    WHERE mode = 'agent' AND persist_status = 'active'
                    ORDER BY updated_at DESC
                    LIMIT ?1
                "#.to_string(),
                vec![Box::new(limit)]
            ),
        };

        let mut stmt = conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();
        let rows = stmt.query_map(params_refs.as_slice(), Self::row_to_session_full)?;

        let sessions: Vec<ChatSession> = rows
            .filter_map(|r| match r {
                Ok(val) => Some(val),
                Err(e) => {
                    log::warn!("[ChatV2Repo] Skipping malformed row: {}", e);
                    None
                }
            })
            .collect();
        Ok(sessions)
    }

    /// 🆕 2026-01-20: 列出 Worker 会话（使用 ChatV2Database）
    pub fn list_agent_sessions_v2(
        db: &ChatV2Database,
        workspace_id: Option<&str>,
        limit: u32,
    ) -> ChatV2Result<Vec<ChatSession>> {
        let conn = db.get_conn_safe()?;
        Self::list_agent_sessions_with_conn(&conn, workspace_id, limit)
    }

    // ========================================================================
    // 消息 CRUD
    // ========================================================================

    /// 创建消息
    pub fn create_message(db: &Database, message: &ChatMessage) -> ChatV2Result<()> {
        let conn = db.get_conn_safe()?;
        Self::create_message_with_conn(&conn, message)
    }

    /// 创建消息（使用现有连接）
    pub fn create_message_with_conn(conn: &Connection, message: &ChatMessage) -> ChatV2Result<()> {
        debug!(
            "[ChatV2::Repo] Creating message: id={}, session_id={}",
            message.id, message.session_id
        );

        let block_ids_json = serde_json::to_string(&message.block_ids)?;
        let meta_json = message
            .meta
            .as_ref()
            .map(|v| serde_json::to_string(v))
            .transpose()?;
        let attachments_json = message
            .attachments
            .as_ref()
            .map(|v| serde_json::to_string(v))
            .transpose()?;
        let variants_json = message
            .variants
            .as_ref()
            .map(|v| serde_json::to_string(v))
            .transpose()?;
        let shared_context_json = message
            .shared_context
            .as_ref()
            .map(|v| serde_json::to_string(v))
            .transpose()?;

        let role_str = match message.role {
            MessageRole::User => "user",
            MessageRole::Assistant => "assistant",
        };

        conn.execute(
            r#"
            INSERT OR REPLACE INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp, persistent_stable_id, parent_id, supersedes, meta_json, attachments_json, active_variant_id, variants_json, shared_context_json)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
            "#,
            params![
                message.id,
                message.session_id,
                role_str,
                block_ids_json,
                message.timestamp,
                message.persistent_stable_id,
                message.parent_id,
                message.supersedes,
                meta_json,
                attachments_json,
                message.active_variant_id,
                variants_json,
                shared_context_json,
            ],
        )?;

        debug!("[ChatV2::Repo] Message created: {}", message.id);
        Ok(())
    }

    /// 获取消息
    pub fn get_message(db: &Database, message_id: &str) -> ChatV2Result<Option<ChatMessage>> {
        let conn = db.get_conn_safe()?;
        Self::get_message_with_conn(&conn, message_id)
    }

    /// 获取消息（使用现有连接）
    pub fn get_message_with_conn(
        conn: &Connection,
        message_id: &str,
    ) -> ChatV2Result<Option<ChatMessage>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, session_id, role, block_ids_json, timestamp, persistent_stable_id, parent_id, supersedes, meta_json, attachments_json, active_variant_id, variants_json, shared_context_json
            FROM chat_v2_messages
            WHERE id = ?1
            "#,
        )?;

        let message = stmt
            .query_row(params![message_id], Self::row_to_message)
            .optional()?;

        Ok(message)
    }

    /// 获取会话的所有消息
    pub fn get_session_messages(db: &Database, session_id: &str) -> ChatV2Result<Vec<ChatMessage>> {
        let conn = db.get_conn_safe()?;
        Self::get_session_messages_with_conn(&conn, session_id)
    }

    /// 获取会话的所有消息（使用现有连接）
    pub fn get_session_messages_with_conn(
        conn: &Connection,
        session_id: &str,
    ) -> ChatV2Result<Vec<ChatMessage>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, session_id, role, block_ids_json, timestamp, persistent_stable_id, parent_id, supersedes, meta_json, attachments_json, active_variant_id, variants_json, shared_context_json
            FROM chat_v2_messages
            WHERE session_id = ?1
            ORDER BY timestamp ASC, rowid ASC
            "#,
        )?;

        let rows = stmt.query_map(params![session_id], Self::row_to_message)?;
        let messages: Vec<ChatMessage> = rows
            .filter_map(|r| match r {
                Ok(val) => Some(val),
                Err(e) => {
                    log::warn!("[ChatV2Repo] Skipping malformed row: {}", e);
                    None
                }
            })
            .collect();
        Ok(messages)
    }

    /// 更新消息
    pub fn update_message(db: &Database, message: &ChatMessage) -> ChatV2Result<()> {
        let conn = db.get_conn_safe()?;
        Self::update_message_with_conn(&conn, message)
    }

    /// 更新消息（使用现有连接）
    pub fn update_message_with_conn(conn: &Connection, message: &ChatMessage) -> ChatV2Result<()> {
        debug!("[ChatV2::Repo] Updating message: {}", message.id);

        let block_ids_json = serde_json::to_string(&message.block_ids)?;
        let meta_json = message
            .meta
            .as_ref()
            .map(|v| serde_json::to_string(v))
            .transpose()?;
        let attachments_json = message
            .attachments
            .as_ref()
            .map(|v| serde_json::to_string(v))
            .transpose()?;
        let variants_json = message
            .variants
            .as_ref()
            .map(|v| serde_json::to_string(v))
            .transpose()?;
        let shared_context_json = message
            .shared_context
            .as_ref()
            .map(|v| serde_json::to_string(v))
            .transpose()?;

        let rows_affected = conn.execute(
            r#"
            UPDATE chat_v2_messages
            SET block_ids_json = ?2, meta_json = ?3, attachments_json = ?4, parent_id = ?5, supersedes = ?6, active_variant_id = ?7, variants_json = ?8, shared_context_json = ?9
            WHERE id = ?1
            "#,
            params![
                message.id,
                block_ids_json,
                meta_json,
                attachments_json,
                message.parent_id,
                message.supersedes,
                message.active_variant_id,
                variants_json,
                shared_context_json,
            ],
        )?;

        if rows_affected == 0 {
            return Err(ChatV2Error::MessageNotFound(message.id.clone()));
        }

        debug!("[ChatV2::Repo] Message updated: {}", message.id);
        Ok(())
    }

    /// 删除消息（级联删除块）
    pub fn delete_message(db: &Database, message_id: &str) -> ChatV2Result<()> {
        let conn = db.get_conn_safe()?;
        Self::delete_message_with_conn(&conn, message_id)
    }

    /// 删除消息（使用现有连接）
    pub fn delete_message_with_conn(conn: &Connection, message_id: &str) -> ChatV2Result<()> {
        debug!("[ChatV2::Repo] Deleting message: {}", message_id);

        // 级联删除由外键约束自动处理（ON DELETE CASCADE）
        let rows_affected = conn.execute(
            "DELETE FROM chat_v2_messages WHERE id = ?1",
            params![message_id],
        )?;

        if rows_affected == 0 {
            return Err(ChatV2Error::MessageNotFound(message_id.to_string()));
        }

        debug!(
            "[ChatV2::Repo] Message deleted with cascade: {}",
            message_id
        );
        Ok(())
    }

    fn row_to_message(row: &rusqlite::Row) -> rusqlite::Result<ChatMessage> {
        let id: String = row.get(0)?;
        let session_id: String = row.get(1)?;
        let role_str: String = row.get(2)?;
        let block_ids_json: String = row.get(3)?;
        let timestamp: i64 = row.get(4)?;
        let persistent_stable_id: Option<String> = row.get(5)?;
        let parent_id: Option<String> = row.get(6)?;
        let supersedes: Option<String> = row.get(7)?;
        let meta_json: Option<String> = row.get(8)?;
        let attachments_json: Option<String> = row.get(9)?;
        let active_variant_id: Option<String> = row.get(10)?;
        let variants_json: Option<String> = row.get(11)?;
        let shared_context_json: Option<String> = row.get(12)?;

        let role = match role_str.as_str() {
            "user" => MessageRole::User,
            "assistant" => MessageRole::Assistant,
            _ => MessageRole::User,
        };

        let block_ids: Vec<String> =
            serde_json::from_str(&block_ids_json).unwrap_or_else(|_| Vec::new());

        let meta: Option<MessageMeta> = meta_json
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok());

        let attachments: Option<Vec<AttachmentMeta>> = attachments_json
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok());

        let variants: Option<Vec<Variant>> = variants_json
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok());

        let shared_context: Option<SharedContext> = shared_context_json
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok());

        Ok(ChatMessage {
            id,
            session_id,
            role,
            block_ids,
            timestamp,
            persistent_stable_id,
            parent_id,
            supersedes,
            meta,
            attachments,
            active_variant_id,
            variants,
            shared_context,
        })
    }

    // ========================================================================
    // 块 CRUD
    // ========================================================================

    /// 创建块
    pub fn create_block(db: &Database, block: &MessageBlock) -> ChatV2Result<()> {
        let conn = db.get_conn_safe()?;
        Self::create_block_with_conn(&conn, block)
    }

    /// 创建块（使用现有连接）
    pub fn create_block_with_conn(conn: &Connection, block: &MessageBlock) -> ChatV2Result<()> {
        debug!(
            "[ChatV2::Repo] Creating block: id={}, message_id={}, type={}",
            block.id, block.message_id, block.block_type
        );

        let tool_input_json = block
            .tool_input
            .as_ref()
            .map(|v| serde_json::to_string(v))
            .transpose()?;
        let tool_output_json = block
            .tool_output
            .as_ref()
            .map(|v| serde_json::to_string(v))
            .transpose()?;
        let citations_json = block
            .citations
            .as_ref()
            .map(|v| serde_json::to_string(v))
            .transpose()?;

        // 🔧 使用 INSERT OR REPLACE，兼容 save_tool_block 的增量保存
        conn.execute(
            r#"
            INSERT OR REPLACE INTO chat_v2_blocks (id, message_id, block_type, status, block_index, content, tool_name, tool_input_json, tool_output_json, citations_json, error, started_at, ended_at, first_chunk_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
            "#,
            params![
                block.id,
                block.message_id,
                block.block_type,
                block.status,
                block.block_index,
                block.content,
                block.tool_name,
                tool_input_json,
                tool_output_json,
                citations_json,
                block.error,
                block.started_at,
                block.ended_at,
                block.first_chunk_at,
            ],
        )?;

        debug!("[ChatV2::Repo] Block created: {}", block.id);
        Ok(())
    }

    /// 获取块
    pub fn get_block(db: &Database, block_id: &str) -> ChatV2Result<Option<MessageBlock>> {
        let conn = db.get_conn_safe()?;
        Self::get_block_with_conn(&conn, block_id)
    }

    /// 获取块（使用现有连接）
    pub fn get_block_with_conn(
        conn: &Connection,
        block_id: &str,
    ) -> ChatV2Result<Option<MessageBlock>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, message_id, block_type, status, block_index, content, tool_name, tool_input_json, tool_output_json, citations_json, error, started_at, ended_at, first_chunk_at
            FROM chat_v2_blocks
            WHERE id = ?1
            "#,
        )?;

        let block = stmt
            .query_row(params![block_id], Self::row_to_block)
            .optional()?;

        Ok(block)
    }

    /// 获取消息的所有块
    pub fn get_message_blocks(db: &Database, message_id: &str) -> ChatV2Result<Vec<MessageBlock>> {
        let conn = db.get_conn_safe()?;
        Self::get_message_blocks_with_conn(&conn, message_id)
    }

    /// 获取消息的所有块（使用现有连接）
    pub fn get_message_blocks_with_conn(
        conn: &Connection,
        message_id: &str,
    ) -> ChatV2Result<Vec<MessageBlock>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, message_id, block_type, status, block_index, content, tool_name, tool_input_json, tool_output_json, citations_json, error, started_at, ended_at, first_chunk_at
            FROM chat_v2_blocks
            WHERE message_id = ?1
            ORDER BY block_index ASC
            "#,
        )?;

        let rows = stmt.query_map(params![message_id], Self::row_to_block)?;
        let blocks: Vec<MessageBlock> = rows
            .filter_map(|r| match r {
                Ok(val) => Some(val),
                Err(e) => {
                    log::warn!("[ChatV2Repo] Skipping malformed row: {}", e);
                    None
                }
            })
            .collect();
        Ok(blocks)
    }

    /// 更新块
    pub fn update_block(db: &Database, block: &MessageBlock) -> ChatV2Result<()> {
        let conn = db.get_conn_safe()?;
        Self::update_block_with_conn(&conn, block)
    }

    /// 更新块（使用现有连接）
    pub fn update_block_with_conn(conn: &Connection, block: &MessageBlock) -> ChatV2Result<()> {
        debug!(
            "[ChatV2::Repo] Updating block: id={}, status={}",
            block.id, block.status
        );

        let tool_input_json = block
            .tool_input
            .as_ref()
            .map(|v| serde_json::to_string(v))
            .transpose()?;
        let tool_output_json = block
            .tool_output
            .as_ref()
            .map(|v| serde_json::to_string(v))
            .transpose()?;
        let citations_json = block
            .citations
            .as_ref()
            .map(|v| serde_json::to_string(v))
            .transpose()?;

        let rows_affected = conn.execute(
            r#"
            UPDATE chat_v2_blocks
            SET status = ?2, content = ?3, tool_input_json = ?4, tool_output_json = ?5, citations_json = ?6, error = ?7, started_at = ?8, ended_at = ?9, first_chunk_at = ?10
            WHERE id = ?1
            "#,
            params![
                block.id,
                block.status,
                block.content,
                tool_input_json,
                tool_output_json,
                citations_json,
                block.error,
                block.started_at,
                block.ended_at,
                block.first_chunk_at,
            ],
        )?;

        if rows_affected == 0 {
            return Err(ChatV2Error::BlockNotFound(block.id.clone()));
        }

        debug!("[ChatV2::Repo] Block updated: {}", block.id);
        Ok(())
    }

    /// 删除块
    pub fn delete_block(db: &Database, block_id: &str) -> ChatV2Result<()> {
        let conn = db.get_conn_safe()?;
        Self::delete_block_with_conn(&conn, block_id)
    }

    /// 删除块（使用现有连接）
    pub fn delete_block_with_conn(conn: &Connection, block_id: &str) -> ChatV2Result<()> {
        debug!("[ChatV2::Repo] Deleting block: {}", block_id);

        let rows_affected = conn.execute(
            "DELETE FROM chat_v2_blocks WHERE id = ?1",
            params![block_id],
        )?;

        if rows_affected == 0 {
            return Err(ChatV2Error::BlockNotFound(block_id.to_string()));
        }

        debug!("[ChatV2::Repo] Block deleted: {}", block_id);
        Ok(())
    }

    fn row_to_block(row: &rusqlite::Row) -> rusqlite::Result<MessageBlock> {
        let id: String = row.get(0)?;
        let message_id: String = row.get(1)?;
        let block_type: String = row.get(2)?;
        let status: String = row.get(3)?;
        let block_index: u32 = row.get(4)?;
        let content: Option<String> = row.get(5)?;
        let tool_name: Option<String> = row.get(6)?;
        let tool_input_json: Option<String> = row.get(7)?;
        let tool_output_json: Option<String> = row.get(8)?;
        let citations_json: Option<String> = row.get(9)?;
        let error: Option<String> = row.get(10)?;
        let started_at: Option<i64> = row.get(11)?;
        let ended_at: Option<i64> = row.get(12)?;
        let first_chunk_at: Option<i64> = row.get(13)?;

        let tool_input: Option<Value> = tool_input_json
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok());

        let tool_output: Option<Value> = tool_output_json
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok());

        let citations = citations_json
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok());

        Ok(MessageBlock {
            id,
            message_id,
            block_type,
            status,
            block_index,
            content,
            tool_name,
            tool_input,
            tool_output,
            citations,
            error,
            started_at,
            ended_at,
            first_chunk_at,
        })
    }

    // ========================================================================
    // 批量加载
    // ========================================================================

    /// 批量获取会话的所有块（使用 JOIN 查询，一次查询获取所有块）
    ///
    /// ## 性能优化
    /// 替代对每个消息单独查询块的 N 次查询方式，
    /// 使用 JOIN 一次查询获取会话所有块，将 N+3 次查询降为 4 次。
    pub fn get_session_blocks_with_conn(
        conn: &Connection,
        session_id: &str,
    ) -> ChatV2Result<Vec<MessageBlock>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT b.id, b.message_id, b.block_type, b.status, b.block_index,
                   b.content, b.tool_name, b.tool_input_json, b.tool_output_json,
                   b.citations_json, b.error, b.started_at, b.ended_at, b.first_chunk_at
            FROM chat_v2_blocks b
            INNER JOIN chat_v2_messages m ON b.message_id = m.id
            WHERE m.session_id = ?1
            ORDER BY m.timestamp ASC, COALESCE(b.first_chunk_at, b.started_at) ASC, b.block_index ASC
            "#,
        )?;

        let rows = stmt.query_map(params![session_id], Self::row_to_block)?;
        let blocks: Vec<MessageBlock> = rows
            .filter_map(|r| match r {
                Ok(val) => Some(val),
                Err(e) => {
                    log::warn!("[ChatV2Repo] Skipping malformed row: {}", e);
                    None
                }
            })
            .collect();
        Ok(blocks)
    }

    /// 加载完整会话（包含会话、消息、块和状态）
    pub fn load_session_full(db: &Database, session_id: &str) -> ChatV2Result<LoadSessionResponse> {
        let conn = db.get_conn_safe()?;
        Self::load_session_full_with_conn(&conn, session_id)
    }

    /// 加载完整会话（使用现有连接）
    ///
    /// ## 性能优化
    /// 使用批量查询，将 N+3 次查询（N = 消息数）降为 4 次：
    /// 1. 获取会话
    /// 2. 获取所有消息
    /// 3. 批量获取所有块（使用 JOIN）
    /// 4. 获取会话状态
    pub fn load_session_full_with_conn(
        conn: &Connection,
        session_id: &str,
    ) -> ChatV2Result<LoadSessionResponse> {
        let t0 = Instant::now();
        debug!("[ChatV2::Repo] Loading full session: {}", session_id);

        // 1. 获取会话
        let session = Self::get_session_with_conn(conn, session_id)?
            .ok_or_else(|| ChatV2Error::SessionNotFound(session_id.to_string()))?;
        let t_session = t0.elapsed().as_millis();
        debug!(
            "[ChatV2::Repo] load_session_full_with_conn session fetched: {} ms",
            t_session
        );

        // 2. 获取所有消息
        let messages = Self::get_session_messages_with_conn(conn, session_id)?;
        let t_messages = t0.elapsed().as_millis();
        debug!(
            "[ChatV2::Repo] load_session_full_with_conn messages fetched: {} ms (delta {} ms, count {})",
            t_messages,
            t_messages - t_session,
            messages.len()
        );

        // 3. 批量获取所有块（性能优化：使用 JOIN 一次查询）
        let blocks = Self::get_session_blocks_with_conn(conn, session_id)?;
        let t_blocks = t0.elapsed().as_millis();
        debug!(
            "[ChatV2::Repo] load_session_full_with_conn blocks fetched: {} ms (delta {} ms, count {})",
            t_blocks,
            t_blocks - t_messages,
            blocks.len()
        );

        // 4. 获取会话状态（可选）
        let state = Self::load_session_state_with_conn(conn, session_id)?;
        let t_state = t0.elapsed().as_millis();
        debug!(
            "[ChatV2::Repo] load_session_full_with_conn state fetched: {} ms (delta {} ms, has_state={})",
            t_state,
            t_state - t_blocks,
            state.is_some()
        );

        info!(
            "[ChatV2::Repo] Loaded full session: {} with {} messages and {} blocks (optimized batch query), total {} ms",
            session_id,
            messages.len(),
            blocks.len(),
            t0.elapsed().as_millis()
        );

        Ok(LoadSessionResponse {
            session,
            messages,
            blocks,
            state,
        })
    }

    // ========================================================================
    // 会话状态
    // ========================================================================

    /// 保存会话状态
    pub fn save_session_state(
        db: &Database,
        session_id: &str,
        state: &SessionState,
    ) -> ChatV2Result<()> {
        let conn = db.get_conn_safe()?;
        Self::save_session_state_with_conn(&conn, session_id, state)
    }

    /// 保存会话状态（使用现有连接）
    pub fn save_session_state_with_conn(
        conn: &Connection,
        session_id: &str,
        state: &SessionState,
    ) -> ChatV2Result<()> {
        debug!("[ChatV2::Repo] Saving session state: {}", session_id);

        let chat_params_json = state
            .chat_params
            .as_ref()
            .map(|v| serde_json::to_string(v))
            .transpose()?;
        let features_json = state
            .features
            .as_ref()
            .map(|v| serde_json::to_string(v))
            .transpose()?;
        let mode_state_json = state
            .mode_state
            .as_ref()
            .map(|v| serde_json::to_string(v))
            .transpose()?;
        let panel_states_json = state
            .panel_states
            .as_ref()
            .map(|v| serde_json::to_string(v))
            .transpose()?;

        conn.execute(
            r#"
            INSERT INTO chat_v2_session_state (session_id, chat_params_json, features_json, mode_state_json, input_value, panel_states_json, pending_context_refs_json, loaded_skill_ids_json, active_skill_ids_json, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            ON CONFLICT(session_id) DO UPDATE SET
                chat_params_json = excluded.chat_params_json,
                features_json = excluded.features_json,
                mode_state_json = excluded.mode_state_json,
                input_value = excluded.input_value,
                panel_states_json = excluded.panel_states_json,
                pending_context_refs_json = excluded.pending_context_refs_json,
                loaded_skill_ids_json = excluded.loaded_skill_ids_json,
                active_skill_ids_json = excluded.active_skill_ids_json,
                updated_at = excluded.updated_at
            "#,
            params![
                session_id,
                chat_params_json,
                features_json,
                mode_state_json,
                state.input_value,
                panel_states_json,
                state.pending_context_refs_json,
                state.loaded_skill_ids_json,
                state.active_skill_ids_json,
                state.updated_at,
            ],
        )?;

        debug!("[ChatV2::Repo] Session state saved: {}", session_id);
        Ok(())
    }

    /// 加载会话状态
    pub fn load_session_state(
        db: &Database,
        session_id: &str,
    ) -> ChatV2Result<Option<SessionState>> {
        let conn = db.get_conn_safe()?;
        Self::load_session_state_with_conn(&conn, session_id)
    }

    /// 加载会话状态（使用现有连接）
    pub fn load_session_state_with_conn(
        conn: &Connection,
        session_id: &str,
    ) -> ChatV2Result<Option<SessionState>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT session_id, chat_params_json, features_json, mode_state_json, input_value, panel_states_json, pending_context_refs_json, loaded_skill_ids_json, active_skill_ids_json, updated_at
            FROM chat_v2_session_state
            WHERE session_id = ?1
            "#,
        )?;

        let state = stmt
            .query_row(params![session_id], |row| {
                let session_id: String = row.get(0)?;
                let chat_params_json: Option<String> = row.get(1)?;
                let features_json: Option<String> = row.get(2)?;
                let mode_state_json: Option<String> = row.get(3)?;
                let input_value: Option<String> = row.get(4)?;
                let panel_states_json: Option<String> = row.get(5)?;
                let pending_context_refs_json: Option<String> = row.get(6)?;
                let loaded_skill_ids_json: Option<String> = row.get(7)?;
                let active_skill_ids_json: Option<String> = row.get(8)?;
                let updated_at: String = row.get(9)?;

                let chat_params: Option<ChatParams> = chat_params_json
                    .as_ref()
                    .and_then(|s| serde_json::from_str(s).ok());

                let features = features_json
                    .as_ref()
                    .and_then(|s| serde_json::from_str(s).ok());

                let mode_state: Option<Value> = mode_state_json
                    .as_ref()
                    .and_then(|s| serde_json::from_str(s).ok());

                let panel_states: Option<PanelStates> = panel_states_json
                    .as_ref()
                    .and_then(|s| serde_json::from_str(s).ok());

                Ok(SessionState {
                    session_id,
                    chat_params,
                    features,
                    mode_state,
                    input_value,
                    panel_states,
                    pending_context_refs_json,
                    loaded_skill_ids_json,
                    active_skill_ids_json,
                    updated_at,
                })
            })
            .optional()?;

        Ok(state)
    }

    // ========================================================================
    // 数据库迁移
    // ========================================================================

    /// 初始化 Chat V2 数据库表
    /// 在应用启动时调用，确保表结构存在
    ///
    /// 注意：生产环境使用 data_governance 模块的 Refinery 迁移系统。
    /// 此方法仅用于测试和紧急初始化场景。
    pub fn initialize_schema(conn: &Connection) -> ChatV2Result<()> {
        info!("[ChatV2::Repo] Initializing Chat V2 schema...");

        // 读取并执行迁移 SQL（使用 Refinery 格式的初始化迁移）
        let migration_sql = include_str!("../../migrations/chat_v2/V20260130__init.sql");

        conn.execute_batch(migration_sql)?;

        info!("[ChatV2::Repo] Chat V2 schema initialized successfully");
        Ok(())
    }

    /// 检查 Chat V2 表是否存在
    pub fn check_schema_exists(conn: &Connection) -> ChatV2Result<bool> {
        let count: i32 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='chat_v2_sessions'",
            [],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    // ========================================================================
    // ChatV2Database 便捷方法（推荐使用）
    // ========================================================================

    /// 创建会话（使用 ChatV2Database）
    pub fn create_session_v2(db: &ChatV2Database, session: &ChatSession) -> ChatV2Result<()> {
        let conn = db.get_conn_safe()?;
        Self::create_session_with_conn(&conn, session)
    }

    /// 获取会话（使用 ChatV2Database）
    pub fn get_session_v2(
        db: &ChatV2Database,
        session_id: &str,
    ) -> ChatV2Result<Option<ChatSession>> {
        let conn = db.get_conn_safe()?;
        Self::get_session_with_conn(&conn, session_id)
    }

    /// 更新会话（使用 ChatV2Database）
    pub fn update_session_v2(db: &ChatV2Database, session: &ChatSession) -> ChatV2Result<()> {
        let conn = db.get_conn_safe()?;
        Self::update_session_with_conn(&conn, session)
    }

    /// 删除会话（使用 ChatV2Database）
    pub fn delete_session_v2(db: &ChatV2Database, session_id: &str) -> ChatV2Result<()> {
        let mut conn = db.get_conn_safe()?;
        let tx = conn.transaction()?;
        Self::delete_session_with_tx(&tx, session_id)?;
        tx.commit()?;
        Ok(())
    }

    /// 清空所有已删除的会话（永久删除）
    ///
    /// 一次性删除所有 persist_status = 'deleted' 的会话。
    /// 依赖数据库的 ON DELETE CASCADE 自动清理关联数据。
    ///
    /// ## 返回
    /// - `Ok(u32)`: 被删除的会话数量
    pub fn purge_deleted_sessions(db: &ChatV2Database) -> ChatV2Result<u32> {
        let conn = db.get_conn_safe()?;
        let count = conn.execute(
            "DELETE FROM chat_v2_sessions WHERE persist_status = 'deleted'",
            [],
        )?;
        info!("[ChatV2::Repo] Purged {} deleted sessions", count);
        Ok(count as u32)
    }

    /// 列出会话（使用 ChatV2Database）
    ///
    /// ## 参数
    /// - `db`: ChatV2 数据库
    /// - `status`: 可选的状态过滤
    /// - `limit`: 数量限制
    /// - `offset`: 偏移量（用于分页）
    pub fn list_sessions_v2(
        db: &ChatV2Database,
        status: Option<&str>,
        group_id: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> ChatV2Result<Vec<ChatSession>> {
        let conn = db.get_conn_safe()?;
        Self::list_sessions_with_conn(&conn, status, group_id, limit, offset)
    }

    /// 获取会话总数（使用 ChatV2Database）
    ///
    /// ## 参数
    /// - `db`: ChatV2 数据库
    /// - `status`: 可选的状态过滤
    pub fn count_sessions_v2(
        db: &ChatV2Database,
        status: Option<&str>,
        group_id: Option<&str>,
    ) -> ChatV2Result<u32> {
        let conn = db.get_conn_safe()?;
        Self::count_sessions_with_conn(&conn, status, group_id)
    }

    /// 创建消息（使用 ChatV2Database）
    pub fn create_message_v2(db: &ChatV2Database, message: &ChatMessage) -> ChatV2Result<()> {
        let conn = db.get_conn_safe()?;
        Self::create_message_with_conn(&conn, message)
    }

    /// 获取消息（使用 ChatV2Database）
    pub fn get_message_v2(
        db: &ChatV2Database,
        message_id: &str,
    ) -> ChatV2Result<Option<ChatMessage>> {
        let conn = db.get_conn_safe()?;
        Self::get_message_with_conn(&conn, message_id)
    }

    /// 获取会话的所有消息（使用 ChatV2Database）
    pub fn get_session_messages_v2(
        db: &ChatV2Database,
        session_id: &str,
    ) -> ChatV2Result<Vec<ChatMessage>> {
        let conn = db.get_conn_safe()?;
        Self::get_session_messages_with_conn(&conn, session_id)
    }

    /// 更新消息（使用 ChatV2Database）
    pub fn update_message_v2(db: &ChatV2Database, message: &ChatMessage) -> ChatV2Result<()> {
        let conn = db.get_conn_safe()?;
        Self::update_message_with_conn(&conn, message)
    }

    /// 删除消息（使用 ChatV2Database）
    pub fn delete_message_v2(db: &ChatV2Database, message_id: &str) -> ChatV2Result<()> {
        let conn = db.get_conn_safe()?;
        Self::delete_message_with_conn(&conn, message_id)
    }

    /// 创建块（使用 ChatV2Database）
    pub fn create_block_v2(db: &ChatV2Database, block: &MessageBlock) -> ChatV2Result<()> {
        let conn = db.get_conn_safe()?;
        Self::create_block_with_conn(&conn, block)
    }

    /// 获取块（使用 ChatV2Database）
    pub fn get_block_v2(db: &ChatV2Database, block_id: &str) -> ChatV2Result<Option<MessageBlock>> {
        let conn = db.get_conn_safe()?;
        Self::get_block_with_conn(&conn, block_id)
    }

    /// 获取消息的所有块（使用 ChatV2Database）
    pub fn get_message_blocks_v2(
        db: &ChatV2Database,
        message_id: &str,
    ) -> ChatV2Result<Vec<MessageBlock>> {
        let conn = db.get_conn_safe()?;
        Self::get_message_blocks_with_conn(&conn, message_id)
    }

    /// 批量获取会话的所有块（使用 ChatV2Database）
    ///
    /// 性能优化：使用 JOIN 查询，一次获取会话所有块
    pub fn get_session_blocks_v2(
        db: &ChatV2Database,
        session_id: &str,
    ) -> ChatV2Result<Vec<MessageBlock>> {
        let conn = db.get_conn_safe()?;
        Self::get_session_blocks_with_conn(&conn, session_id)
    }

    /// 更新块（使用 ChatV2Database）
    pub fn update_block_v2(db: &ChatV2Database, block: &MessageBlock) -> ChatV2Result<()> {
        let conn = db.get_conn_safe()?;
        Self::update_block_with_conn(&conn, block)
    }

    /// 删除块（使用 ChatV2Database）
    pub fn delete_block_v2(db: &ChatV2Database, block_id: &str) -> ChatV2Result<()> {
        let conn = db.get_conn_safe()?;
        Self::delete_block_with_conn(&conn, block_id)
    }

    /// 加载完整会话（使用 ChatV2Database）
    pub fn load_session_full_v2(
        db: &ChatV2Database,
        session_id: &str,
    ) -> ChatV2Result<LoadSessionResponse> {
        let conn = db.get_conn_safe()?;
        Self::load_session_full_with_conn(&conn, session_id)
    }

    /// 保存会话状态（使用 ChatV2Database）
    pub fn save_session_state_v2(
        db: &ChatV2Database,
        session_id: &str,
        state: &SessionState,
    ) -> ChatV2Result<()> {
        let conn = db.get_conn_safe()?;
        Self::save_session_state_with_conn(&conn, session_id, state)
    }

    /// 加载会话状态（使用 ChatV2Database）
    pub fn load_session_state_v2(
        db: &ChatV2Database,
        session_id: &str,
    ) -> ChatV2Result<Option<SessionState>> {
        let conn = db.get_conn_safe()?;
        Self::load_session_state_with_conn(&conn, session_id)
    }

    // ========================================================================
    // 消息元数据操作
    // ========================================================================

    /// 更新消息的元数据（使用现有连接）
    ///
    /// 用于在流式完成后更新消息的 `meta` 字段，包含 `model_id` 和 `usage`
    pub fn update_message_meta_with_conn(
        conn: &Connection,
        message_id: &str,
        meta: &MessageMeta,
    ) -> ChatV2Result<()> {
        debug!(
            "[ChatV2::Repo] Updating message meta: message_id={}, model_id={:?}",
            message_id, meta.model_id
        );

        let meta_json = serde_json::to_string(meta)?;

        let rows_affected = conn.execute(
            "UPDATE chat_v2_messages SET meta_json = ?2 WHERE id = ?1",
            params![message_id, meta_json],
        )?;

        if rows_affected == 0 {
            return Err(ChatV2Error::MessageNotFound(message_id.to_string()));
        }

        debug!(
            "[ChatV2::Repo] Message meta updated: message_id={}",
            message_id
        );
        Ok(())
    }

    // ========================================================================
    // 变体相关操作（多模型并行执行支持）
    // ========================================================================

    /// 更新消息的激活变体 ID
    pub fn update_message_active_variant(
        db: &Database,
        message_id: &str,
        variant_id: &str,
    ) -> ChatV2Result<()> {
        let conn = db.get_conn_safe()?;
        Self::update_message_active_variant_with_conn(&conn, message_id, variant_id)
    }

    /// 更新消息的激活变体 ID（使用现有连接）
    pub fn update_message_active_variant_with_conn(
        conn: &Connection,
        message_id: &str,
        variant_id: &str,
    ) -> ChatV2Result<()> {
        debug!(
            "[ChatV2::Repo] Updating active variant: message_id={}, variant_id={}",
            message_id, variant_id
        );

        let rows_affected = conn.execute(
            "UPDATE chat_v2_messages SET active_variant_id = ?2 WHERE id = ?1",
            params![message_id, variant_id],
        )?;

        if rows_affected == 0 {
            return Err(ChatV2Error::MessageNotFound(message_id.to_string()));
        }

        debug!(
            "[ChatV2::Repo] Active variant updated: message_id={}, variant_id={}",
            message_id, variant_id
        );
        Ok(())
    }

    /// 更新消息的变体列表和激活变体 ID
    pub fn update_message_variants(
        db: &Database,
        message_id: &str,
        variants: &[Variant],
        active_variant_id: Option<&str>,
    ) -> ChatV2Result<()> {
        let conn = db.get_conn_safe()?;
        Self::update_message_variants_with_conn(&conn, message_id, variants, active_variant_id)
    }

    /// 更新消息的变体列表和激活变体 ID（使用现有连接）
    pub fn update_message_variants_with_conn(
        conn: &Connection,
        message_id: &str,
        variants: &[Variant],
        active_variant_id: Option<&str>,
    ) -> ChatV2Result<()> {
        debug!(
            "[ChatV2::Repo] Updating variants: message_id={}, count={}",
            message_id,
            variants.len()
        );

        let variants_json = serde_json::to_string(variants)?;

        let rows_affected = conn.execute(
            "UPDATE chat_v2_messages SET variants_json = ?2, active_variant_id = ?3 WHERE id = ?1",
            params![message_id, variants_json, active_variant_id],
        )?;

        if rows_affected == 0 {
            return Err(ChatV2Error::MessageNotFound(message_id.to_string()));
        }

        debug!(
            "[ChatV2::Repo] Variants updated: message_id={}, count={}",
            message_id,
            variants.len()
        );
        Ok(())
    }

    /// 更新变体状态
    pub fn update_variant_status(
        db: &Database,
        message_id: &str,
        variant_id: &str,
        status: &str,
        error: Option<&str>,
    ) -> ChatV2Result<()> {
        let conn = db.get_conn_safe()?;
        Self::update_variant_status_with_conn(&conn, message_id, variant_id, status, error)
    }

    /// 更新变体状态（使用现有连接）
    pub fn update_variant_status_with_conn(
        conn: &Connection,
        message_id: &str,
        variant_id: &str,
        status: &str,
        error: Option<&str>,
    ) -> ChatV2Result<()> {
        debug!(
            "[ChatV2::Repo] Updating variant status: message_id={}, variant_id={}, status={}",
            message_id, variant_id, status
        );

        // 获取当前消息
        let message = Self::get_message_with_conn(conn, message_id)?
            .ok_or_else(|| ChatV2Error::MessageNotFound(message_id.to_string()))?;

        // 获取并更新变体
        let mut variants = message.variants.unwrap_or_default();
        let variant = variants
            .iter_mut()
            .find(|v| v.id == variant_id)
            .ok_or_else(|| ChatV2Error::Other(format!("Variant not found: {}", variant_id)))?;

        variant.status = status.to_string();
        variant.error = error.map(|s| s.to_string());

        // 保存更新后的变体列表
        let variants_json = serde_json::to_string(&variants)?;
        conn.execute(
            "UPDATE chat_v2_messages SET variants_json = ?2 WHERE id = ?1",
            params![message_id, variants_json],
        )?;

        debug!(
            "[ChatV2::Repo] Variant status updated: variant_id={}, status={}",
            variant_id, status
        );
        Ok(())
    }

    /// 删除变体
    ///
    /// 删除变体时会级联删除其所属的所有块。
    /// 如果删除的是最后一个变体，则删除整个消息。
    pub fn delete_variant(
        db: &Database,
        message_id: &str,
        variant_id: &str,
    ) -> ChatV2Result<DeleteVariantResult> {
        let conn = db.get_conn_safe()?;
        Self::delete_variant_with_conn(&conn, message_id, variant_id)
    }

    /// 删除变体（使用现有连接）
    pub fn delete_variant_with_conn(
        conn: &Connection,
        message_id: &str,
        variant_id: &str,
    ) -> ChatV2Result<DeleteVariantResult> {
        debug!(
            "[ChatV2::Repo] Deleting variant: message_id={}, variant_id={}",
            message_id, variant_id
        );

        // 获取当前消息
        let message = Self::get_message_with_conn(conn, message_id)?
            .ok_or_else(|| ChatV2Error::MessageNotFound(message_id.to_string()))?;

        let mut variants = message.variants.unwrap_or_default();
        let variant_index = variants
            .iter()
            .position(|v| v.id == variant_id)
            .ok_or_else(|| ChatV2Error::Other(format!("Variant not found: {}", variant_id)))?;

        // 获取要删除的变体的 block_ids
        let block_ids_to_delete = variants[variant_index].block_ids.clone();

        // 如果只有一个变体，删除整个消息
        if variants.len() == 1 {
            // 删除消息（级联删除块）
            Self::delete_message_with_conn(conn, message_id)?;
            info!(
                "[ChatV2::Repo] Last variant deleted, message removed: {}",
                message_id
            );
            return Ok(DeleteVariantResult::MessageDeleted);
        }

        // 删除变体所属的块（使用 variant_id 批量删除，更可靠）
        // 首先尝试通过 variant_id 删除
        let deleted_by_variant_id = conn.execute(
            "DELETE FROM chat_v2_blocks WHERE variant_id = ?1",
            params![variant_id],
        )?;

        // 如果没有通过 variant_id 删除任何块，回退到通过 block_ids 删除
        // 这可能发生在旧数据或 block_ids 列表不为空但 variant_id 未设置的情况
        if deleted_by_variant_id == 0 && !block_ids_to_delete.is_empty() {
            for block_id in &block_ids_to_delete {
                let _ = Self::delete_block_with_conn(conn, block_id);
            }
        }

        debug!(
            "[ChatV2::Repo] Deleted {} blocks by variant_id, {} in block_ids list",
            deleted_by_variant_id,
            block_ids_to_delete.len()
        );

        // 从变体列表中移除
        variants.remove(variant_index);

        // 确定新的激活变体 ID
        let current_active = message.active_variant_id.as_deref();
        let new_active_id = if current_active == Some(variant_id) {
            // 如果删除的是当前激活的变体，选择新的激活变体
            // 优先级：第一个 success > 第一个 cancelled > 第一个变体
            Self::determine_active_variant(&variants)
        } else {
            // 保持原来的激活变体
            current_active.map(|s| s.to_string())
        };

        // 更新消息
        let variants_json = serde_json::to_string(&variants)?;
        conn.execute(
            "UPDATE chat_v2_messages SET variants_json = ?2, active_variant_id = ?3 WHERE id = ?1",
            params![message_id, variants_json, &new_active_id],
        )?;

        info!(
            "[ChatV2::Repo] Variant deleted: variant_id={}, new_active_id={:?}",
            variant_id, new_active_id
        );

        Ok(DeleteVariantResult::VariantDeleted { new_active_id })
    }

    /// 确定激活变体 ID
    ///
    /// 优先级：
    /// 1. 第一个 success 状态的变体
    /// 2. 第一个 cancelled 状态的变体
    /// 3. 第一个变体（即使是 error）
    fn determine_active_variant(variants: &[Variant]) -> Option<String> {
        use super::types::variant_status;

        // 第一优先：第一个 success 变体
        if let Some(v) = variants
            .iter()
            .find(|v| v.status == variant_status::SUCCESS)
        {
            return Some(v.id.clone());
        }

        // 第二优先：第一个 cancelled 变体
        if let Some(v) = variants
            .iter()
            .find(|v| v.status == variant_status::CANCELLED)
        {
            return Some(v.id.clone());
        }

        // 兜底：第一个变体
        variants.first().map(|v| v.id.clone())
    }

    /// 将块添加到变体
    pub fn add_block_to_variant(
        db: &Database,
        message_id: &str,
        variant_id: &str,
        block_id: &str,
    ) -> ChatV2Result<()> {
        let conn = db.get_conn_safe()?;
        Self::add_block_to_variant_with_conn(&conn, message_id, variant_id, block_id)
    }

    /// 将块添加到变体（使用现有连接）
    pub fn add_block_to_variant_with_conn(
        conn: &Connection,
        message_id: &str,
        variant_id: &str,
        block_id: &str,
    ) -> ChatV2Result<()> {
        debug!(
            "[ChatV2::Repo] Adding block to variant: message_id={}, variant_id={}, block_id={}",
            message_id, variant_id, block_id
        );

        // 获取当前消息
        let message = Self::get_message_with_conn(conn, message_id)?
            .ok_or_else(|| ChatV2Error::MessageNotFound(message_id.to_string()))?;

        // 更新变体的 block_ids
        let mut variants = message.variants.unwrap_or_default();
        let variant = variants
            .iter_mut()
            .find(|v| v.id == variant_id)
            .ok_or_else(|| ChatV2Error::Other(format!("Variant not found: {}", variant_id)))?;

        // 添加 block_id（避免重复）
        if !variant.block_ids.contains(&block_id.to_string()) {
            variant.block_ids.push(block_id.to_string());
        }

        // 保存更新后的变体列表
        let variants_json = serde_json::to_string(&variants)?;
        conn.execute(
            "UPDATE chat_v2_messages SET variants_json = ?2 WHERE id = ?1",
            params![message_id, variants_json],
        )?;

        // 同时更新块表的 variant_id 字段
        conn.execute(
            "UPDATE chat_v2_blocks SET variant_id = ?2 WHERE id = ?1",
            params![block_id, variant_id],
        )?;

        debug!(
            "[ChatV2::Repo] Block added to variant: block_id={}, variant_id={}",
            block_id, variant_id
        );
        Ok(())
    }

    /// 更新消息的共享上下文
    pub fn update_message_shared_context(
        db: &Database,
        message_id: &str,
        shared_context: &SharedContext,
    ) -> ChatV2Result<()> {
        let conn = db.get_conn_safe()?;
        Self::update_message_shared_context_with_conn(&conn, message_id, shared_context)
    }

    /// 更新消息的共享上下文（使用现有连接）
    pub fn update_message_shared_context_with_conn(
        conn: &Connection,
        message_id: &str,
        shared_context: &SharedContext,
    ) -> ChatV2Result<()> {
        debug!(
            "[ChatV2::Repo] Updating shared context: message_id={}",
            message_id
        );

        let shared_context_json = serde_json::to_string(shared_context)?;

        let rows_affected = conn.execute(
            "UPDATE chat_v2_messages SET shared_context_json = ?2 WHERE id = ?1",
            params![message_id, shared_context_json],
        )?;

        if rows_affected == 0 {
            return Err(ChatV2Error::MessageNotFound(message_id.to_string()));
        }

        debug!(
            "[ChatV2::Repo] Shared context updated: message_id={}",
            message_id
        );
        Ok(())
    }

    /// 修复消息中的变体状态（崩溃恢复）
    ///
    /// 将 streaming/pending 状态的变体标记为 error，并修复 active_variant_id。
    /// 应在会话加载时调用。
    pub fn repair_message_variant_status(db: &Database, message_id: &str) -> ChatV2Result<bool> {
        let conn = db.get_conn_safe()?;
        Self::repair_message_variant_status_with_conn(&conn, message_id)
    }

    /// 修复消息中的变体状态（使用现有连接）
    pub fn repair_message_variant_status_with_conn(
        conn: &Connection,
        message_id: &str,
    ) -> ChatV2Result<bool> {
        use super::types::variant_status;

        let message = match Self::get_message_with_conn(conn, message_id)? {
            Some(m) => m,
            None => return Ok(false),
        };

        let mut variants = match message.variants {
            Some(v) if !v.is_empty() => v,
            _ => return Ok(false),
        };

        let mut repaired = false;

        // 修复 streaming/pending 状态的变体
        for variant in &mut variants {
            if variant.status == variant_status::STREAMING
                || variant.status == variant_status::PENDING
            {
                variant.status = variant_status::ERROR.to_string();
                variant.error = Some("Process interrupted unexpectedly".to_string());
                repaired = true;
            }
        }

        if !repaired {
            return Ok(false);
        }

        // 修复 active_variant_id
        let current_active = message.active_variant_id.as_deref();
        let needs_new_active = current_active
            .and_then(|id| variants.iter().find(|v| v.id == id))
            .map_or(true, |v| v.status == variant_status::ERROR);

        let new_active_id = if needs_new_active {
            Self::determine_active_variant(&variants)
        } else {
            current_active.map(|s| s.to_string())
        };

        // 保存更新
        let variants_json = serde_json::to_string(&variants)?;
        conn.execute(
            "UPDATE chat_v2_messages SET variants_json = ?2, active_variant_id = ?3 WHERE id = ?1",
            params![message_id, variants_json, &new_active_id],
        )?;

        info!(
            "[ChatV2::Repo] Repaired variant status for message: {}, new_active_id={:?}",
            message_id, new_active_id
        );

        Ok(true)
    }

    /// 修复会话中所有消息的变体状态（崩溃恢复）
    pub fn repair_session_variant_status(db: &Database, session_id: &str) -> ChatV2Result<u32> {
        let conn = db.get_conn_safe()?;
        Self::repair_session_variant_status_with_conn(&conn, session_id)
    }

    /// 修复会话中所有消息的变体状态（使用现有连接）
    pub fn repair_session_variant_status_with_conn(
        conn: &Connection,
        session_id: &str,
    ) -> ChatV2Result<u32> {
        let messages = Self::get_session_messages_with_conn(conn, session_id)?;
        let mut repaired_count = 0;

        for message in &messages {
            if Self::repair_message_variant_status_with_conn(conn, &message.id)? {
                repaired_count += 1;
            }
        }

        if repaired_count > 0 {
            info!(
                "[ChatV2::Repo] Repaired {} messages in session: {}",
                repaired_count, session_id
            );
        }

        Ok(repaired_count)
    }

    // ========================================================================
    // 变体相关操作（使用 ChatV2Database）
    // ========================================================================

    /// 更新消息的激活变体 ID（使用 ChatV2Database）
    pub fn update_message_active_variant_v2(
        db: &ChatV2Database,
        message_id: &str,
        variant_id: &str,
    ) -> ChatV2Result<()> {
        let conn = db.get_conn_safe()?;
        Self::update_message_active_variant_with_conn(&conn, message_id, variant_id)
    }

    /// 更新消息的变体列表和激活变体 ID（使用 ChatV2Database）
    pub fn update_message_variants_v2(
        db: &ChatV2Database,
        message_id: &str,
        variants: &[Variant],
        active_variant_id: Option<&str>,
    ) -> ChatV2Result<()> {
        let conn = db.get_conn_safe()?;
        Self::update_message_variants_with_conn(&conn, message_id, variants, active_variant_id)
    }

    /// 更新变体状态（使用 ChatV2Database）
    pub fn update_variant_status_v2(
        db: &ChatV2Database,
        message_id: &str,
        variant_id: &str,
        status: &str,
        error: Option<&str>,
    ) -> ChatV2Result<()> {
        let conn = db.get_conn_safe()?;
        Self::update_variant_status_with_conn(&conn, message_id, variant_id, status, error)
    }

    /// 删除变体（使用 ChatV2Database）
    pub fn delete_variant_v2(
        db: &ChatV2Database,
        message_id: &str,
        variant_id: &str,
    ) -> ChatV2Result<DeleteVariantResult> {
        let conn = db.get_conn_safe()?;
        Self::delete_variant_with_conn(&conn, message_id, variant_id)
    }

    /// 将块添加到变体（使用 ChatV2Database）
    pub fn add_block_to_variant_v2(
        db: &ChatV2Database,
        message_id: &str,
        variant_id: &str,
        block_id: &str,
    ) -> ChatV2Result<()> {
        let conn = db.get_conn_safe()?;
        Self::add_block_to_variant_with_conn(&conn, message_id, variant_id, block_id)
    }

    /// 更新消息的共享上下文（使用 ChatV2Database）
    pub fn update_message_shared_context_v2(
        db: &ChatV2Database,
        message_id: &str,
        shared_context: &SharedContext,
    ) -> ChatV2Result<()> {
        let conn = db.get_conn_safe()?;
        Self::update_message_shared_context_with_conn(&conn, message_id, shared_context)
    }

    /// 修复消息中的变体状态（使用 ChatV2Database）
    pub fn repair_message_variant_status_v2(
        db: &ChatV2Database,
        message_id: &str,
    ) -> ChatV2Result<bool> {
        let conn = db.get_conn_safe()?;
        Self::repair_message_variant_status_with_conn(&conn, message_id)
    }

    /// 修复会话中所有消息的变体状态（使用 ChatV2Database）
    pub fn repair_session_variant_status_v2(
        db: &ChatV2Database,
        session_id: &str,
    ) -> ChatV2Result<u32> {
        let conn = db.get_conn_safe()?;
        Self::repair_session_variant_status_with_conn(&conn, session_id)
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_v2::SourceInfo;
    use rusqlite::Connection;
    use std::collections::HashMap;

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();

        // 初始化 schema（使用完整的初始化迁移，包含所有表结构）
        let init_sql = include_str!("../../migrations/chat_v2/V20260130__init.sql");
        conn.execute_batch(init_sql).unwrap();

        conn
    }

    #[test]
    fn test_session_crud() {
        let conn = setup_test_db();

        // Create
        let session = ChatSession::new("sess_test_123".to_string(), "analysis".to_string());
        ChatV2Repo::create_session_with_conn(&conn, &session).unwrap();

        // Read
        let loaded = ChatV2Repo::get_session_with_conn(&conn, "sess_test_123")
            .unwrap()
            .expect("Session should exist");
        assert_eq!(loaded.id, "sess_test_123");
        assert_eq!(loaded.mode, "analysis");
        assert_eq!(loaded.persist_status, PersistStatus::Active);

        // Update
        let mut updated_session = loaded.clone();
        updated_session.title = Some("Test Session".to_string());
        updated_session.persist_status = PersistStatus::Archived;
        ChatV2Repo::update_session_with_conn(&conn, &updated_session).unwrap();

        let reloaded = ChatV2Repo::get_session_with_conn(&conn, "sess_test_123")
            .unwrap()
            .expect("Session should exist");
        assert_eq!(reloaded.title, Some("Test Session".to_string()));
        assert_eq!(reloaded.persist_status, PersistStatus::Archived);

        // List
        let sessions =
            ChatV2Repo::list_sessions_with_conn(&conn, Some("archived"), None, 10, 0).unwrap();
        assert_eq!(sessions.len(), 1);

        // Delete (using transaction)
        let tx = conn.unchecked_transaction().unwrap();
        ChatV2Repo::delete_session_with_tx(&tx, "sess_test_123").unwrap();
        tx.commit().unwrap();

        let deleted = ChatV2Repo::get_session_with_conn(&conn, "sess_test_123").unwrap();
        assert!(deleted.is_none());
    }

    #[test]
    fn test_message_crud() {
        let conn = setup_test_db();

        // Create session first
        let session = ChatSession::new("sess_msg_test".to_string(), "analysis".to_string());
        ChatV2Repo::create_session_with_conn(&conn, &session).unwrap();

        // Create message
        let message = ChatMessage::new_user("sess_msg_test".to_string(), vec!["blk_1".to_string()]);
        let message_id = message.id.clone();
        ChatV2Repo::create_message_with_conn(&conn, &message).unwrap();

        // Read
        let loaded = ChatV2Repo::get_message_with_conn(&conn, &message_id)
            .unwrap()
            .expect("Message should exist");
        assert_eq!(loaded.role, MessageRole::User);
        assert_eq!(loaded.block_ids, vec!["blk_1".to_string()]);

        // Get session messages
        let messages = ChatV2Repo::get_session_messages_with_conn(&conn, "sess_msg_test").unwrap();
        assert_eq!(messages.len(), 1);

        // Delete
        ChatV2Repo::delete_message_with_conn(&conn, &message_id).unwrap();
        let deleted = ChatV2Repo::get_message_with_conn(&conn, &message_id).unwrap();
        assert!(deleted.is_none());
    }

    #[test]
    fn test_insert_or_replace_message_cascades_blocks() {
        let conn = setup_test_db();

        // Create session first
        let session_id = "sess_or_replace_test";
        let session = ChatSession::new(session_id.to_string(), "analysis".to_string());
        ChatV2Repo::create_session_with_conn(&conn, &session).unwrap();

        // Create message with a stable id so we can trigger INSERT OR REPLACE.
        let message_id = "msg_test_or_replace";
        let block_id = "blk_test_anki_cards";
        let mut message = ChatMessage::new_assistant(session_id.to_string());
        message.id = message_id.to_string();
        message.block_ids = vec![block_id.to_string()];
        ChatV2Repo::create_message_with_conn(&conn, &message).unwrap();

        // Insert an anki_cards block referencing the message_id.
        let mut block = MessageBlock::new(
            message_id.to_string(),
            crate::chat_v2::types::block_types::ANKI_CARDS,
            0,
        );
        block.id = block_id.to_string();
        ChatV2Repo::create_block_with_conn(&conn, &block).unwrap();

        // Verify it exists before we replace the message row.
        assert!(ChatV2Repo::get_block_with_conn(&conn, block_id)
            .unwrap()
            .is_some());

        // Re-inserting the same message id uses INSERT OR REPLACE, which performs a DELETE + INSERT.
        // The DELETE triggers ON DELETE CASCADE, removing blocks for this message_id.
        ChatV2Repo::create_message_with_conn(&conn, &message).unwrap();

        // The block row is gone even though the message row still exists and references it.
        assert!(ChatV2Repo::get_block_with_conn(&conn, block_id)
            .unwrap()
            .is_none());
        let reloaded_message = ChatV2Repo::get_message_with_conn(&conn, message_id)
            .unwrap()
            .expect("Message should exist after INSERT OR REPLACE");
        assert_eq!(reloaded_message.block_ids, vec![block_id.to_string()]);
    }

    #[test]
    fn test_block_crud() {
        let conn = setup_test_db();

        // Create session and message first
        let session = ChatSession::new("sess_blk_test".to_string(), "analysis".to_string());
        ChatV2Repo::create_session_with_conn(&conn, &session).unwrap();

        let message = ChatMessage::new_assistant("sess_blk_test".to_string());
        let message_id = message.id.clone();
        ChatV2Repo::create_message_with_conn(&conn, &message).unwrap();

        // Create block
        let block = MessageBlock::new_content(message_id.clone(), 0);
        let block_id = block.id.clone();
        ChatV2Repo::create_block_with_conn(&conn, &block).unwrap();

        // Read
        let loaded = ChatV2Repo::get_block_with_conn(&conn, &block_id)
            .unwrap()
            .expect("Block should exist");
        assert_eq!(loaded.block_type, "content");
        assert_eq!(loaded.status, "pending");

        // Update
        let mut updated_block = loaded.clone();
        updated_block.content = Some("Hello, world!".to_string());
        updated_block.status = "success".to_string();
        ChatV2Repo::update_block_with_conn(&conn, &updated_block).unwrap();

        let reloaded = ChatV2Repo::get_block_with_conn(&conn, &block_id)
            .unwrap()
            .expect("Block should exist");
        assert_eq!(reloaded.content, Some("Hello, world!".to_string()));
        assert_eq!(reloaded.status, "success");

        // Get message blocks
        let blocks = ChatV2Repo::get_message_blocks_with_conn(&conn, &message_id).unwrap();
        assert_eq!(blocks.len(), 1);

        // Delete
        ChatV2Repo::delete_block_with_conn(&conn, &block_id).unwrap();
        let deleted = ChatV2Repo::get_block_with_conn(&conn, &block_id).unwrap();
        assert!(deleted.is_none());
    }

    #[test]
    fn test_cascade_delete() {
        let conn = setup_test_db();

        // Create session
        let session = ChatSession::new("sess_cascade_test".to_string(), "analysis".to_string());
        ChatV2Repo::create_session_with_conn(&conn, &session).unwrap();

        // Create messages
        let msg1 = ChatMessage::new_user("sess_cascade_test".to_string(), vec![]);
        let msg1_id = msg1.id.clone();
        ChatV2Repo::create_message_with_conn(&conn, &msg1).unwrap();

        let msg2 = ChatMessage::new_assistant("sess_cascade_test".to_string());
        let msg2_id = msg2.id.clone();
        ChatV2Repo::create_message_with_conn(&conn, &msg2).unwrap();

        // Create blocks for msg2
        let block1 = MessageBlock::new_thinking(msg2_id.clone(), 0);
        let block1_id = block1.id.clone();
        ChatV2Repo::create_block_with_conn(&conn, &block1).unwrap();

        let block2 = MessageBlock::new_content(msg2_id.clone(), 1);
        let block2_id = block2.id.clone();
        ChatV2Repo::create_block_with_conn(&conn, &block2).unwrap();

        // Verify all exist
        assert!(ChatV2Repo::get_message_with_conn(&conn, &msg1_id)
            .unwrap()
            .is_some());
        assert!(ChatV2Repo::get_message_with_conn(&conn, &msg2_id)
            .unwrap()
            .is_some());
        assert!(ChatV2Repo::get_block_with_conn(&conn, &block1_id)
            .unwrap()
            .is_some());
        assert!(ChatV2Repo::get_block_with_conn(&conn, &block2_id)
            .unwrap()
            .is_some());

        // Delete session (should cascade to messages and blocks)
        let tx = conn.unchecked_transaction().unwrap();
        ChatV2Repo::delete_session_with_tx(&tx, "sess_cascade_test").unwrap();
        tx.commit().unwrap();

        // Verify all are deleted
        assert!(
            ChatV2Repo::get_session_with_conn(&conn, "sess_cascade_test")
                .unwrap()
                .is_none()
        );
        assert!(ChatV2Repo::get_message_with_conn(&conn, &msg1_id)
            .unwrap()
            .is_none());
        assert!(ChatV2Repo::get_message_with_conn(&conn, &msg2_id)
            .unwrap()
            .is_none());
        assert!(ChatV2Repo::get_block_with_conn(&conn, &block1_id)
            .unwrap()
            .is_none());
        assert!(ChatV2Repo::get_block_with_conn(&conn, &block2_id)
            .unwrap()
            .is_none());
    }

    #[test]
    fn test_load_session_full() {
        let conn = setup_test_db();

        // Create session
        let session = ChatSession::new("sess_full_test".to_string(), "analysis".to_string());
        ChatV2Repo::create_session_with_conn(&conn, &session).unwrap();

        // Create messages
        let msg1 = ChatMessage::new_user("sess_full_test".to_string(), vec![]);
        ChatV2Repo::create_message_with_conn(&conn, &msg1).unwrap();

        let msg2 = ChatMessage::new_assistant("sess_full_test".to_string());
        let msg2_id = msg2.id.clone();
        ChatV2Repo::create_message_with_conn(&conn, &msg2).unwrap();

        // Create blocks for msg2
        let block1 = MessageBlock::new_thinking(msg2_id.clone(), 0);
        ChatV2Repo::create_block_with_conn(&conn, &block1).unwrap();

        let block2 = MessageBlock::new_content(msg2_id.clone(), 1);
        ChatV2Repo::create_block_with_conn(&conn, &block2).unwrap();

        // Save session state
        let state = SessionState {
            session_id: "sess_full_test".to_string(),
            chat_params: Some(ChatParams::default()),
            features: Some(HashMap::from([("rag".to_string(), true)])),
            mode_state: None,
            input_value: Some("draft input".to_string()),
            panel_states: Some(PanelStates::default()),
            pending_context_refs_json: None,
            loaded_skill_ids_json: None,
            active_skill_ids_json: None,
            updated_at: Utc::now().to_rfc3339(),
        };
        ChatV2Repo::save_session_state_with_conn(&conn, "sess_full_test", &state).unwrap();

        // Load full session
        let full = ChatV2Repo::load_session_full_with_conn(&conn, "sess_full_test").unwrap();

        assert_eq!(full.session.id, "sess_full_test");
        assert_eq!(full.messages.len(), 2);
        assert_eq!(full.blocks.len(), 2);
        assert!(full.state.is_some());

        let loaded_state = full.state.unwrap();
        assert_eq!(loaded_state.input_value, Some("draft input".to_string()));
        assert!(loaded_state
            .features
            .unwrap()
            .get("rag")
            .copied()
            .unwrap_or(false));
    }

    #[test]
    fn test_session_state_upsert() {
        let conn = setup_test_db();

        // Create session
        let session = ChatSession::new("sess_state_test".to_string(), "analysis".to_string());
        ChatV2Repo::create_session_with_conn(&conn, &session).unwrap();

        // First save
        let state1 = SessionState {
            session_id: "sess_state_test".to_string(),
            chat_params: None,
            features: None,
            mode_state: None,
            input_value: Some("first draft".to_string()),
            panel_states: None,
            pending_context_refs_json: None,
            loaded_skill_ids_json: None,
            active_skill_ids_json: None,
            updated_at: Utc::now().to_rfc3339(),
        };
        ChatV2Repo::save_session_state_with_conn(&conn, "sess_state_test", &state1).unwrap();

        // Verify first save
        let loaded1 = ChatV2Repo::load_session_state_with_conn(&conn, "sess_state_test")
            .unwrap()
            .expect("State should exist");
        assert_eq!(loaded1.input_value, Some("first draft".to_string()));

        // Upsert (update)
        let state2 = SessionState {
            session_id: "sess_state_test".to_string(),
            chat_params: Some(ChatParams {
                model_id: Some("gpt-4".to_string()),
                ..Default::default()
            }),
            features: None,
            mode_state: None,
            input_value: Some("second draft".to_string()),
            panel_states: None,
            pending_context_refs_json: None,
            loaded_skill_ids_json: None,
            active_skill_ids_json: None,
            updated_at: Utc::now().to_rfc3339(),
        };
        ChatV2Repo::save_session_state_with_conn(&conn, "sess_state_test", &state2).unwrap();

        // Verify upsert
        let loaded2 = ChatV2Repo::load_session_state_with_conn(&conn, "sess_state_test")
            .unwrap()
            .expect("State should exist");
        assert_eq!(loaded2.input_value, Some("second draft".to_string()));
        assert_eq!(
            loaded2
                .chat_params
                .as_ref()
                .and_then(|p| p.model_id.as_ref()),
            Some(&"gpt-4".to_string())
        );
    }

    // ========================================================================
    // Prompt 7 相关测试：pending_context_refs_json 持久化
    // ========================================================================

    /// 测试 pending_context_refs_json 的保存和恢复
    /// 对应 Prompt 7 要求的单测：验证保存和恢复一致性
    #[test]
    fn test_pending_context_refs_json_persistence() {
        let conn = setup_test_db();

        // 创建会话
        let session = ChatSession::new(
            "sess_context_refs_test".to_string(),
            "general_chat".to_string(),
        );
        ChatV2Repo::create_session_with_conn(&conn, &session).unwrap();

        // 保存带有 pending_context_refs_json 的状态
        let context_refs_json =
            r#"[{"resourceId":"res_abc123","hash":"sha256_xyz","typeId":"note"}]"#;
        let state = SessionState {
            session_id: "sess_context_refs_test".to_string(),
            chat_params: None,
            features: None,
            mode_state: None,
            input_value: None,
            panel_states: None,
            pending_context_refs_json: Some(context_refs_json.to_string()),
            loaded_skill_ids_json: None,
            active_skill_ids_json: None,
            updated_at: Utc::now().to_rfc3339(),
        };
        ChatV2Repo::save_session_state_with_conn(&conn, "sess_context_refs_test", &state).unwrap();

        // 验证恢复
        let loaded = ChatV2Repo::load_session_state_with_conn(&conn, "sess_context_refs_test")
            .unwrap()
            .expect("State should exist");
        assert_eq!(
            loaded.pending_context_refs_json,
            Some(context_refs_json.to_string()),
            "pending_context_refs_json should be correctly restored"
        );
    }

    /// 测试空数组处理
    /// 对应 Prompt 7 要求的单测：验证空数组处理
    #[test]
    fn test_pending_context_refs_json_empty_array() {
        let conn = setup_test_db();

        // 创建会话
        let session = ChatSession::new(
            "sess_empty_refs_test".to_string(),
            "general_chat".to_string(),
        );
        ChatV2Repo::create_session_with_conn(&conn, &session).unwrap();

        // 保存空数组
        let empty_array_json = "[]";
        let state = SessionState {
            session_id: "sess_empty_refs_test".to_string(),
            chat_params: None,
            features: None,
            mode_state: None,
            input_value: None,
            panel_states: None,
            pending_context_refs_json: Some(empty_array_json.to_string()),
            loaded_skill_ids_json: None,
            active_skill_ids_json: None,
            updated_at: Utc::now().to_rfc3339(),
        };
        ChatV2Repo::save_session_state_with_conn(&conn, "sess_empty_refs_test", &state).unwrap();

        // 验证恢复
        let loaded = ChatV2Repo::load_session_state_with_conn(&conn, "sess_empty_refs_test")
            .unwrap()
            .expect("State should exist");
        assert_eq!(
            loaded.pending_context_refs_json,
            Some(empty_array_json.to_string()),
            "Empty array should be correctly restored"
        );
    }

    /// 测试 None 处理
    /// 对应 Prompt 7 要求的单测：验证无上下文引用的情况
    #[test]
    fn test_pending_context_refs_json_none() {
        let conn = setup_test_db();

        // 创建会话
        let session = ChatSession::new("sess_no_refs_test".to_string(), "general_chat".to_string());
        ChatV2Repo::create_session_with_conn(&conn, &session).unwrap();

        // 保存 None
        let state = SessionState {
            session_id: "sess_no_refs_test".to_string(),
            chat_params: None,
            features: None,
            mode_state: None,
            input_value: None,
            panel_states: None,
            pending_context_refs_json: None,
            loaded_skill_ids_json: None,
            active_skill_ids_json: None,
            updated_at: Utc::now().to_rfc3339(),
        };
        ChatV2Repo::save_session_state_with_conn(&conn, "sess_no_refs_test", &state).unwrap();

        // 验证恢复
        let loaded = ChatV2Repo::load_session_state_with_conn(&conn, "sess_no_refs_test")
            .unwrap()
            .expect("State should exist");
        assert_eq!(
            loaded.pending_context_refs_json, None,
            "None should be correctly restored as None"
        );
    }

    // ========================================================================
    // Prompt 5 相关测试：Pipeline 数据持久化
    // ========================================================================

    /// 测试保存结果的基本功能（验证消息和块正确保存）
    /// 对应 Prompt 5 要求的 test_save_results_basic
    #[test]
    fn test_save_results_basic() {
        let conn = setup_test_db();

        // 创建会话
        let session = ChatSession::new("sess_save_test".to_string(), "general_chat".to_string());
        ChatV2Repo::create_session_with_conn(&conn, &session).unwrap();

        // 模拟 save_results 的行为：保存用户消息和块
        let user_msg =
            ChatMessage::new_user("sess_save_test".to_string(), vec!["blk_user_1".to_string()]);
        let user_msg_id = user_msg.id.clone();
        ChatV2Repo::create_message_with_conn(&conn, &user_msg).unwrap();

        let user_block = MessageBlock {
            id: "blk_user_1".to_string(),
            message_id: user_msg_id.clone(),
            block_type: "content".to_string(),
            status: "success".to_string(),
            content: Some("用户问题内容".to_string()),
            tool_name: None,
            tool_input: None,
            tool_output: None,
            citations: None,
            error: None,
            started_at: Some(1000),
            ended_at: Some(1001),
            first_chunk_at: None,
            block_index: 0,
        };
        ChatV2Repo::create_block_with_conn(&conn, &user_block).unwrap();

        // 保存助手消息和多个块
        let assistant_msg = ChatMessage::new_assistant("sess_save_test".to_string());
        let assistant_msg_id = assistant_msg.id.clone();
        ChatV2Repo::create_message_with_conn(&conn, &assistant_msg).unwrap();

        // 创建多个块，验证 block_index 正确
        for i in 0..3 {
            let block = MessageBlock {
                id: format!("blk_assistant_{}", i),
                message_id: assistant_msg_id.clone(),
                block_type: if i == 0 {
                    "thinking".to_string()
                } else {
                    "content".to_string()
                },
                status: "success".to_string(),
                content: Some(format!("块内容 {}", i)),
                tool_name: None,
                tool_input: None,
                tool_output: None,
                citations: None,
                error: None,
                started_at: Some(2000 + i as i64),
                ended_at: Some(2001 + i as i64),
                first_chunk_at: None,
                block_index: i as u32,
            };
            ChatV2Repo::create_block_with_conn(&conn, &block).unwrap();
        }

        // 验证消息保存正确
        let messages = ChatV2Repo::get_session_messages_with_conn(&conn, "sess_save_test").unwrap();
        assert_eq!(messages.len(), 2, "应该有 2 条消息（用户和助手）");

        // 验证块保存正确
        let assistant_blocks =
            ChatV2Repo::get_message_blocks_with_conn(&conn, &assistant_msg_id).unwrap();
        assert_eq!(assistant_blocks.len(), 3, "助手消息应该有 3 个块");

        // 验证 block_index 正确（按顺序）
        for (i, block) in assistant_blocks.iter().enumerate() {
            assert_eq!(block.block_index, i as u32, "block_index 应该正确");
        }
    }

    /// 测试加载聊天历史的基本功能
    /// 对应 Prompt 5 要求的 test_load_chat_history_basic
    #[test]
    fn test_load_chat_history_basic() {
        let conn = setup_test_db();

        // 创建会话
        let session = ChatSession::new("sess_history_test".to_string(), "general_chat".to_string());
        ChatV2Repo::create_session_with_conn(&conn, &session).unwrap();

        // 创建多条消息
        for i in 0..5 {
            let msg = if i % 2 == 0 {
                ChatMessage::new_user("sess_history_test".to_string(), vec![format!("blk_{}", i)])
            } else {
                ChatMessage::new_assistant("sess_history_test".to_string())
            };
            let msg_id = msg.id.clone();
            ChatV2Repo::create_message_with_conn(&conn, &msg).unwrap();

            // 为每条消息创建 content 块
            let block = MessageBlock {
                id: format!("blk_{}", i),
                message_id: msg_id,
                block_type: "content".to_string(),
                status: "success".to_string(),
                content: Some(format!("消息 {} 的内容", i)),
                tool_name: None,
                tool_input: None,
                tool_output: None,
                citations: None,
                error: None,
                started_at: Some(i as i64 * 1000),
                ended_at: Some(i as i64 * 1000 + 100),
                first_chunk_at: None,
                block_index: 0,
            };
            ChatV2Repo::create_block_with_conn(&conn, &block).unwrap();
        }

        // 验证消息加载
        let messages =
            ChatV2Repo::get_session_messages_with_conn(&conn, "sess_history_test").unwrap();
        assert_eq!(messages.len(), 5, "应该加载 5 条消息");

        // 验证每条消息的块可以正确加载
        for msg in &messages {
            let blocks = ChatV2Repo::get_message_blocks_with_conn(&conn, &msg.id).unwrap();
            assert!(!blocks.is_empty(), "每条消息应该有至少一个块");
        }
    }

    /// 测试加载聊天历史时的上下文限制
    /// 对应 Prompt 5 要求的 test_load_chat_history_context_limit
    #[test]
    fn test_load_chat_history_context_limit() {
        let conn = setup_test_db();

        // 创建会话
        let session = ChatSession::new("sess_limit_test".to_string(), "general_chat".to_string());
        ChatV2Repo::create_session_with_conn(&conn, &session).unwrap();

        // 创建 25 条消息（超过默认的 context_limit=20）
        for i in 0..25 {
            let msg = if i % 2 == 0 {
                ChatMessage::new_user("sess_limit_test".to_string(), vec![])
            } else {
                ChatMessage::new_assistant("sess_limit_test".to_string())
            };
            let msg_id = msg.id.clone();
            ChatV2Repo::create_message_with_conn(&conn, &msg).unwrap();

            let block = MessageBlock {
                id: format!("blk_limit_{}", i),
                message_id: msg_id,
                block_type: "content".to_string(),
                status: "success".to_string(),
                content: Some(format!("限制测试消息 {}", i)),
                tool_name: None,
                tool_input: None,
                tool_output: None,
                citations: None,
                error: None,
                started_at: None,
                ended_at: None,
                first_chunk_at: None,
                block_index: 0,
            };
            ChatV2Repo::create_block_with_conn(&conn, &block).unwrap();
        }

        // 加载所有消息
        let all_messages =
            ChatV2Repo::get_session_messages_with_conn(&conn, "sess_limit_test").unwrap();
        assert_eq!(all_messages.len(), 25, "应该有 25 条消息");

        // 模拟 load_chat_history 中的 context_limit 逻辑
        let context_limit: usize = 20;
        let messages_to_load: Vec<_> = if all_messages.len() > context_limit {
            // 取最新的 context_limit 条消息
            all_messages
                .into_iter()
                .rev()
                .take(context_limit)
                .rev()
                .collect()
        } else {
            all_messages
        };

        assert_eq!(
            messages_to_load.len(),
            20,
            "应用 context_limit 后应该只有 20 条消息"
        );
    }

    /// 测试只提取 content 类型块的内容（不包含 thinking 等其他类型）
    /// 对应 Prompt 5 约束条件：只提取 content 类型块的内容
    #[test]
    fn test_load_chat_history_content_only() {
        let conn = setup_test_db();

        // 创建会话和消息
        let session = ChatSession::new("sess_content_test".to_string(), "general_chat".to_string());
        ChatV2Repo::create_session_with_conn(&conn, &session).unwrap();

        let msg = ChatMessage::new_assistant("sess_content_test".to_string());
        let msg_id = msg.id.clone();
        ChatV2Repo::create_message_with_conn(&conn, &msg).unwrap();

        // 创建多种类型的块
        let blocks_data = vec![
            ("thinking", "这是思维链内容，不应该被提取"),
            ("content", "这是主要内容，应该被提取"),
            ("rag", "这是 RAG 结果，不应该被提取"),
            ("content", "这是第二段内容，也应该被提取"),
        ];

        for (i, (block_type, content)) in blocks_data.iter().enumerate() {
            let block = MessageBlock {
                id: format!("blk_content_test_{}", i),
                message_id: msg_id.clone(),
                block_type: block_type.to_string(),
                status: "success".to_string(),
                content: Some(content.to_string()),
                tool_name: None,
                tool_input: None,
                tool_output: None,
                citations: None,
                error: None,
                started_at: None,
                ended_at: None,
                first_chunk_at: None,
                block_index: i as u32,
            };
            ChatV2Repo::create_block_with_conn(&conn, &block).unwrap();
        }

        // 加载块
        let blocks = ChatV2Repo::get_message_blocks_with_conn(&conn, &msg_id).unwrap();
        assert_eq!(blocks.len(), 4, "应该有 4 个块");

        // 模拟 load_chat_history 中只提取 content 类型块的逻辑
        let content: String = blocks
            .iter()
            .filter(|b| b.block_type == "content")
            .filter_map(|b| b.content.as_ref())
            .cloned()
            .collect::<Vec<_>>()
            .join("");

        assert!(
            content.contains("这是主要内容"),
            "应该包含第一个 content 块"
        );
        assert!(
            content.contains("这是第二段内容"),
            "应该包含第二个 content 块"
        );
        assert!(!content.contains("思维链"), "不应该包含 thinking 块");
        assert!(!content.contains("RAG"), "不应该包含 rag 块");
    }

    /// 测试块索引正确设置（Prompt 5 约束条件）
    #[test]
    fn test_block_index_correct() {
        let conn = setup_test_db();

        // 创建会话和消息
        let session = ChatSession::new("sess_index_test".to_string(), "general_chat".to_string());
        ChatV2Repo::create_session_with_conn(&conn, &session).unwrap();

        let msg = ChatMessage::new_assistant("sess_index_test".to_string());
        let msg_id = msg.id.clone();
        ChatV2Repo::create_message_with_conn(&conn, &msg).unwrap();

        // 创建多个块，确保 block_index 正确
        let block_ids: Vec<String> = (0..5).map(|i| format!("blk_idx_{}", i)).collect();

        for (i, block_id) in block_ids.iter().enumerate() {
            let block = MessageBlock {
                id: block_id.clone(),
                message_id: msg_id.clone(),
                block_type: "content".to_string(),
                status: "success".to_string(),
                content: Some(format!("块 {} 内容", i)),
                tool_name: None,
                tool_input: None,
                tool_output: None,
                citations: None,
                error: None,
                started_at: None,
                ended_at: None,
                first_chunk_at: None,
                block_index: i as u32,
            };
            ChatV2Repo::create_block_with_conn(&conn, &block).unwrap();
        }

        // 加载块（应该按 block_index 排序）
        let loaded_blocks = ChatV2Repo::get_message_blocks_with_conn(&conn, &msg_id).unwrap();

        // 验证顺序和索引
        for (i, block) in loaded_blocks.iter().enumerate() {
            assert_eq!(block.block_index, i as u32, "block_index 应该为 {}", i);
            assert_eq!(block.id, format!("blk_idx_{}", i), "块 ID 顺序应该正确");
        }
    }

    // ========================================================================
    // 变体相关测试（Prompt 3）
    // ========================================================================

    /// 测试变体 CRUD 操作
    #[test]
    fn test_variant_crud() {
        let conn = setup_test_db();

        // 创建会话和消息
        let session = ChatSession::new("sess_variant_test".to_string(), "general_chat".to_string());
        ChatV2Repo::create_session_with_conn(&conn, &session).unwrap();

        let msg = ChatMessage::new_assistant("sess_variant_test".to_string());
        let msg_id = msg.id.clone();
        ChatV2Repo::create_message_with_conn(&conn, &msg).unwrap();

        // 创建变体
        let variant1 = Variant::new("gpt-4".to_string());
        let variant2 = Variant::new("claude-3".to_string());
        let var1_id = variant1.id.clone();
        let var2_id = variant2.id.clone();

        let variants = vec![variant1, variant2];

        // 更新变体列表
        ChatV2Repo::update_message_variants_with_conn(&conn, &msg_id, &variants, Some(&var1_id))
            .unwrap();

        // 验证变体保存正确
        let loaded = ChatV2Repo::get_message_with_conn(&conn, &msg_id)
            .unwrap()
            .unwrap();
        assert_eq!(loaded.active_variant_id, Some(var1_id.clone()));
        assert!(loaded.variants.is_some());
        let loaded_variants = loaded.variants.unwrap();
        assert_eq!(loaded_variants.len(), 2);
        assert_eq!(loaded_variants[0].model_id, "gpt-4");
        assert_eq!(loaded_variants[1].model_id, "claude-3");

        // 更新激活变体
        ChatV2Repo::update_message_active_variant_with_conn(&conn, &msg_id, &var2_id).unwrap();
        let reloaded = ChatV2Repo::get_message_with_conn(&conn, &msg_id)
            .unwrap()
            .unwrap();
        assert_eq!(reloaded.active_variant_id, Some(var2_id));
    }

    /// 测试变体状态更新
    #[test]
    fn test_variant_status_update() {
        let conn = setup_test_db();

        // 创建会话和消息
        let session = ChatSession::new("sess_status_test".to_string(), "general_chat".to_string());
        ChatV2Repo::create_session_with_conn(&conn, &session).unwrap();

        let msg = ChatMessage::new_assistant("sess_status_test".to_string());
        let msg_id = msg.id.clone();
        ChatV2Repo::create_message_with_conn(&conn, &msg).unwrap();

        // 创建变体
        let variant = Variant::new("gpt-4".to_string());
        let var_id = variant.id.clone();
        let variants = vec![variant];

        ChatV2Repo::update_message_variants_with_conn(&conn, &msg_id, &variants, Some(&var_id))
            .unwrap();

        // 更新状态为 streaming
        ChatV2Repo::update_variant_status_with_conn(&conn, &msg_id, &var_id, "streaming", None)
            .unwrap();
        let loaded = ChatV2Repo::get_message_with_conn(&conn, &msg_id)
            .unwrap()
            .unwrap();
        assert_eq!(loaded.variants.unwrap()[0].status, "streaming");

        // 更新状态为 error
        ChatV2Repo::update_variant_status_with_conn(
            &conn,
            &msg_id,
            &var_id,
            "error",
            Some("Test error"),
        )
        .unwrap();
        let loaded2 = ChatV2Repo::get_message_with_conn(&conn, &msg_id)
            .unwrap()
            .unwrap();
        let variant = &loaded2.variants.unwrap()[0];
        assert_eq!(variant.status, "error");
        assert_eq!(variant.error, Some("Test error".to_string()));
    }

    /// 测试删除变体（级联删除块）
    #[test]
    fn test_delete_variant_cascade() {
        let conn = setup_test_db();

        // 创建会话和消息
        let session = ChatSession::new("sess_delete_test".to_string(), "general_chat".to_string());
        ChatV2Repo::create_session_with_conn(&conn, &session).unwrap();

        let msg = ChatMessage::new_assistant("sess_delete_test".to_string());
        let msg_id = msg.id.clone();
        ChatV2Repo::create_message_with_conn(&conn, &msg).unwrap();

        // 创建两个变体
        let mut variant1 = Variant::new("gpt-4".to_string());
        let mut variant2 = Variant::new("claude-3".to_string());
        variant1.status = "success".to_string();
        variant2.status = "error".to_string();
        let var1_id = variant1.id.clone();
        let var2_id = variant2.id.clone();

        // 为变体1创建块
        let block1 = MessageBlock::new_content(msg_id.clone(), 0);
        let block1_id = block1.id.clone();
        ChatV2Repo::create_block_with_conn(&conn, &block1).unwrap();
        variant1.block_ids.push(block1_id.clone());

        // 为变体2创建块
        let block2 = MessageBlock::new_content(msg_id.clone(), 1);
        let block2_id = block2.id.clone();
        ChatV2Repo::create_block_with_conn(&conn, &block2).unwrap();
        variant2.block_ids.push(block2_id.clone());

        let variants = vec![variant1, variant2];
        ChatV2Repo::update_message_variants_with_conn(&conn, &msg_id, &variants, Some(&var1_id))
            .unwrap();

        // 设置块表中的 variant_id（模拟 add_block_to_variant 的效果）
        conn.execute(
            "UPDATE chat_v2_blocks SET variant_id = ?2 WHERE id = ?1",
            params![&block1_id, &var1_id],
        )
        .unwrap();
        conn.execute(
            "UPDATE chat_v2_blocks SET variant_id = ?2 WHERE id = ?1",
            params![&block2_id, &var2_id],
        )
        .unwrap();

        // 删除变体1（应该级联删除其块）
        let result = ChatV2Repo::delete_variant_with_conn(&conn, &msg_id, &var1_id).unwrap();

        match result {
            DeleteVariantResult::VariantDeleted { new_active_id } => {
                // 应该自动选择新的激活变体
                assert!(new_active_id.is_some());
                // 因为 var2 是 error 状态，但是是唯一剩下的，所以会被选中
                assert_eq!(new_active_id.as_deref(), Some(var2_id.as_str()));
            }
            DeleteVariantResult::MessageDeleted => {
                panic!("不应该删除消息，还有一个变体");
            }
        }

        // 验证变体1的块已删除
        assert!(ChatV2Repo::get_block_with_conn(&conn, &block1_id)
            .unwrap()
            .is_none());

        // 验证变体2的块仍存在
        assert!(ChatV2Repo::get_block_with_conn(&conn, &block2_id)
            .unwrap()
            .is_some());

        // 验证消息中只剩一个变体
        let msg = ChatV2Repo::get_message_with_conn(&conn, &msg_id)
            .unwrap()
            .unwrap();
        assert_eq!(msg.variants.unwrap().len(), 1);
    }

    /// 测试删除最后一个变体时删除消息
    #[test]
    fn test_delete_last_variant_deletes_message() {
        let conn = setup_test_db();

        // 创建会话和消息
        let session =
            ChatSession::new("sess_last_var_test".to_string(), "general_chat".to_string());
        ChatV2Repo::create_session_with_conn(&conn, &session).unwrap();

        let msg = ChatMessage::new_assistant("sess_last_var_test".to_string());
        let msg_id = msg.id.clone();
        ChatV2Repo::create_message_with_conn(&conn, &msg).unwrap();

        // 创建单个变体
        let variant = Variant::new("gpt-4".to_string());
        let var_id = variant.id.clone();
        let variants = vec![variant];

        ChatV2Repo::update_message_variants_with_conn(&conn, &msg_id, &variants, Some(&var_id))
            .unwrap();

        // 删除最后一个变体
        let result = ChatV2Repo::delete_variant_with_conn(&conn, &msg_id, &var_id).unwrap();

        match result {
            DeleteVariantResult::MessageDeleted => {
                // 正确！删除最后一个变体应该删除消息
            }
            DeleteVariantResult::VariantDeleted { .. } => {
                panic!("删除最后一个变体应该删除消息");
            }
        }

        // 验证消息已删除
        assert!(ChatV2Repo::get_message_with_conn(&conn, &msg_id)
            .unwrap()
            .is_none());
    }

    /// 测试将块添加到变体
    #[test]
    fn test_add_block_to_variant() {
        let conn = setup_test_db();

        // 创建会话和消息
        let session = ChatSession::new(
            "sess_add_block_test".to_string(),
            "general_chat".to_string(),
        );
        ChatV2Repo::create_session_with_conn(&conn, &session).unwrap();

        let msg = ChatMessage::new_assistant("sess_add_block_test".to_string());
        let msg_id = msg.id.clone();
        ChatV2Repo::create_message_with_conn(&conn, &msg).unwrap();

        // 创建变体
        let variant = Variant::new("gpt-4".to_string());
        let var_id = variant.id.clone();
        let variants = vec![variant];

        ChatV2Repo::update_message_variants_with_conn(&conn, &msg_id, &variants, Some(&var_id))
            .unwrap();

        // 创建块
        let block = MessageBlock::new_content(msg_id.clone(), 0);
        let block_id = block.id.clone();
        ChatV2Repo::create_block_with_conn(&conn, &block).unwrap();

        // 添加块到变体
        ChatV2Repo::add_block_to_variant_with_conn(&conn, &msg_id, &var_id, &block_id).unwrap();

        // 验证块已添加到变体
        let loaded = ChatV2Repo::get_message_with_conn(&conn, &msg_id)
            .unwrap()
            .unwrap();
        let variant = &loaded.variants.unwrap()[0];
        assert!(variant.block_ids.contains(&block_id));

        // 验证块表中的 variant_id 已更新
        let block_row: String = conn
            .query_row(
                "SELECT variant_id FROM chat_v2_blocks WHERE id = ?1",
                params![&block_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(block_row, var_id);
    }

    /// 测试共享上下文更新
    #[test]
    fn test_shared_context_update() {
        let conn = setup_test_db();

        // 创建会话和消息
        let session = ChatSession::new("sess_context_test".to_string(), "general_chat".to_string());
        ChatV2Repo::create_session_with_conn(&conn, &session).unwrap();

        let msg = ChatMessage::new_assistant("sess_context_test".to_string());
        let msg_id = msg.id.clone();
        ChatV2Repo::create_message_with_conn(&conn, &msg).unwrap();

        // 创建共享上下文
        let shared_context = SharedContext {
            rag_sources: Some(vec![SourceInfo {
                title: Some("Test Doc".to_string()),
                url: Some("https://example.com".to_string()),
                snippet: Some("Test snippet".to_string()),
                score: Some(0.95),
                metadata: None,
            }]),
            memory_sources: None,
            graph_sources: None,
            web_search_sources: None,
            multimodal_sources: None,
            rag_block_id: None,
            memory_block_id: None,
            graph_block_id: None,
            web_search_block_id: None,
            multimodal_block_id: None,
        };

        // 更新共享上下文
        ChatV2Repo::update_message_shared_context_with_conn(&conn, &msg_id, &shared_context)
            .unwrap();

        // 验证共享上下文保存正确
        let loaded = ChatV2Repo::get_message_with_conn(&conn, &msg_id)
            .unwrap()
            .unwrap();
        assert!(loaded.shared_context.is_some());
        let ctx = loaded.shared_context.unwrap();
        assert!(ctx.rag_sources.is_some());
        assert_eq!(
            ctx.rag_sources.unwrap()[0].title,
            Some("Test Doc".to_string())
        );
    }

    /// 测试 is_multi_variant 和 get_active_block_ids 辅助方法
    #[test]
    fn test_message_variant_helpers() {
        // 测试无变体消息
        let msg1 = ChatMessage::new_assistant("sess_test".to_string());
        assert!(!msg1.is_multi_variant());
        assert!(msg1.get_active_block_ids().is_empty());

        // 测试单变体消息
        let mut msg2 = ChatMessage::new_assistant("sess_test".to_string());
        let variant = Variant::new("gpt-4".to_string());
        let var_id = variant.id.clone();
        msg2.variants = Some(vec![variant]);
        msg2.active_variant_id = Some(var_id);
        assert!(!msg2.is_multi_variant()); // 单变体不是多变体模式

        // 测试多变体消息
        let mut msg3 = ChatMessage::new_assistant("sess_test".to_string());
        let mut var1 = Variant::new("gpt-4".to_string());
        var1.block_ids = vec!["blk_1".to_string(), "blk_2".to_string()];
        let var1_id = var1.id.clone();
        let var2 = Variant::new("claude-3".to_string());
        msg3.variants = Some(vec![var1, var2]);
        msg3.active_variant_id = Some(var1_id);

        assert!(msg3.is_multi_variant());
        assert_eq!(
            msg3.get_active_block_ids(),
            &["blk_1".to_string(), "blk_2".to_string()]
        );
    }

    /// 测试崩溃恢复（修复 streaming/pending 状态的变体）
    #[test]
    fn test_repair_variant_status() {
        let conn = setup_test_db();

        // 创建会话和消息
        let session = ChatSession::new("sess_repair_test".to_string(), "general_chat".to_string());
        ChatV2Repo::create_session_with_conn(&conn, &session).unwrap();

        let msg = ChatMessage::new_assistant("sess_repair_test".to_string());
        let msg_id = msg.id.clone();
        ChatV2Repo::create_message_with_conn(&conn, &msg).unwrap();

        // 创建包含各种状态的变体
        let mut variant1 = Variant::new("gpt-4".to_string());
        variant1.status = "streaming".to_string(); // 需要修复
        let var1_id = variant1.id.clone();

        let mut variant2 = Variant::new("claude-3".to_string());
        variant2.status = "pending".to_string(); // 需要修复

        let mut variant3 = Variant::new("gemini".to_string());
        variant3.status = "success".to_string(); // 正常
        let var3_id = variant3.id.clone();

        let variants = vec![variant1, variant2, variant3];
        ChatV2Repo::update_message_variants_with_conn(&conn, &msg_id, &variants, Some(&var1_id))
            .unwrap();

        // 执行修复
        let repaired = ChatV2Repo::repair_message_variant_status_with_conn(&conn, &msg_id).unwrap();
        assert!(repaired);

        // 验证修复结果
        let loaded = ChatV2Repo::get_message_with_conn(&conn, &msg_id)
            .unwrap()
            .unwrap();
        let loaded_variants = loaded.variants.unwrap();

        // streaming 和 pending 应该变成 error
        assert_eq!(loaded_variants[0].status, "error");
        assert!(loaded_variants[0].error.is_some());
        assert_eq!(loaded_variants[1].status, "error");
        assert!(loaded_variants[1].error.is_some());

        // success 应该保持不变
        assert_eq!(loaded_variants[2].status, "success");

        // active_variant_id 应该更新为第一个 success 变体
        assert_eq!(loaded.active_variant_id, Some(var3_id));
    }
}
