use chrono::{DateTime, Utc};
use rusqlite::{params, Row};
use serde_json::Value;
use std::sync::Arc;

/// Log row-parse errors instead of silently discarding them.
fn log_and_skip_err<T>(result: Result<T, rusqlite::Error>) -> Option<T> {
    match result {
        Ok(v) => Some(v),
        Err(e) => {
            log::warn!("Row parse error: {}", e);
            None
        }
    }
}

use super::database::WorkspaceDatabase;
use super::types::*;

pub struct WorkspaceRepo {
    db: Arc<WorkspaceDatabase>,
}

impl WorkspaceRepo {
    pub fn new(db: Arc<WorkspaceDatabase>) -> Self {
        Self { db }
    }

    pub fn save_workspace(&self, workspace: &Workspace) -> Result<(), String> {
        let conn = self.db.get_connection()?;
        conn.execute(
            "INSERT OR REPLACE INTO workspace (id, name, status, creator_session_id, created_at, updated_at, metadata_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                workspace.id,
                workspace.name,
                serde_json::to_string(&workspace.status).unwrap().trim_matches('"'),
                workspace.creator_session_id,
                workspace.created_at.to_rfc3339(),
                workspace.updated_at.to_rfc3339(),
                workspace.metadata.as_ref().map(|v| v.to_string()),
            ],
        ).map_err(|e| format!("Failed to save workspace: {}", e))?;
        Ok(())
    }

    pub fn get_workspace(&self) -> Result<Option<Workspace>, String> {
        let conn = self.db.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT id, name, status, creator_session_id, created_at, updated_at, metadata_json FROM workspace LIMIT 1"
        ).map_err(|e| format!("Failed to prepare statement: {}", e))?;

        let result = stmt.query_row([], |row| Self::row_to_workspace(row));
        match result {
            Ok(ws) => Ok(Some(ws)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("Failed to query workspace: {}", e)),
        }
    }

    pub fn update_workspace_status(&self, status: WorkspaceStatus) -> Result<(), String> {
        let conn = self.db.get_connection()?;
        conn.execute(
            "UPDATE workspace SET status = ?1, updated_at = ?2",
            params![
                serde_json::to_string(&status).unwrap().trim_matches('"'),
                Utc::now().to_rfc3339(),
            ],
        )
        .map_err(|e| format!("Failed to update workspace status: {}", e))?;
        Ok(())
    }

    pub fn save_agent(&self, agent: &WorkspaceAgent) -> Result<(), String> {
        let conn = self.db.get_connection()?;
        conn.execute(
            "INSERT OR REPLACE INTO agent (session_id, workspace_id, role, skill_id, status, joined_at, last_active_at, metadata_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                agent.session_id,
                agent.workspace_id,
                serde_json::to_string(&agent.role).unwrap().trim_matches('"'),
                agent.skill_id,
                serde_json::to_string(&agent.status).unwrap().trim_matches('"'),
                agent.joined_at.to_rfc3339(),
                agent.last_active_at.to_rfc3339(),
                agent.metadata.as_ref().map(|v| v.to_string()),
            ],
        ).map_err(|e| format!("Failed to save agent: {}", e))?;
        Ok(())
    }

    pub fn get_agent(&self, session_id: &str) -> Result<Option<WorkspaceAgent>, String> {
        let conn = self.db.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT session_id, workspace_id, role, skill_id, status, joined_at, last_active_at, metadata_json FROM agent WHERE session_id = ?1"
        ).map_err(|e| format!("Failed to prepare statement: {}", e))?;

        let result = stmt.query_row([session_id], |row| Self::row_to_agent(row));
        match result {
            Ok(agent) => Ok(Some(agent)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("Failed to query agent: {}", e)),
        }
    }

    pub fn list_agents(&self) -> Result<Vec<WorkspaceAgent>, String> {
        let conn = self.db.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT session_id, workspace_id, role, skill_id, status, joined_at, last_active_at, metadata_json FROM agent ORDER BY joined_at"
        ).map_err(|e| format!("Failed to prepare statement: {}", e))?;

        let agents = stmt
            .query_map([], |row| Self::row_to_agent(row))
            .map_err(|e| format!("Failed to query agents: {}", e))?
            .filter_map(log_and_skip_err)
            .collect();

        Ok(agents)
    }

    pub fn update_agent_status(&self, session_id: &str, status: AgentStatus) -> Result<(), String> {
        let conn = self.db.get_connection()?;
        conn.execute(
            "UPDATE agent SET status = ?1, last_active_at = ?2 WHERE session_id = ?3",
            params![
                serde_json::to_string(&status).unwrap().trim_matches('"'),
                Utc::now().to_rfc3339(),
                session_id,
            ],
        )
        .map_err(|e| format!("Failed to update agent status: {}", e))?;
        Ok(())
    }

    pub fn delete_agent(&self, session_id: &str) -> Result<(), String> {
        let conn = self.db.get_connection()?;
        conn.execute("DELETE FROM agent WHERE session_id = ?1", [session_id])
            .map_err(|e| format!("Failed to delete agent: {}", e))?;
        Ok(())
    }

    pub fn save_message(&self, message: &WorkspaceMessage) -> Result<(), String> {
        let conn = self.db.get_connection()?;
        conn.execute(
            "INSERT INTO message (id, workspace_id, sender_session_id, target_session_id, message_type, content, status, created_at, metadata_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                message.id,
                message.workspace_id,
                message.sender_session_id,
                message.target_session_id,
                serde_json::to_string(&message.message_type).unwrap().trim_matches('"'),
                message.content,
                serde_json::to_string(&message.status).unwrap().trim_matches('"'),
                message.created_at.to_rfc3339(),
                message.metadata.as_ref().map(|v| v.to_string()),
            ],
        ).map_err(|e| format!("Failed to save message: {}", e))?;
        Ok(())
    }

    pub fn get_message(&self, message_id: &str) -> Result<Option<WorkspaceMessage>, String> {
        let conn = self.db.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT id, workspace_id, sender_session_id, target_session_id, message_type, content, status, created_at, metadata_json FROM message WHERE id = ?1"
        ).map_err(|e| format!("Failed to prepare statement: {}", e))?;

        let result = stmt.query_row([message_id], |row| Self::row_to_message(row));
        match result {
            Ok(msg) => Ok(Some(msg)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("Failed to query message: {}", e)),
        }
    }

    pub fn list_messages(&self, limit: usize) -> Result<Vec<WorkspaceMessage>, String> {
        let conn = self.db.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT id, workspace_id, sender_session_id, target_session_id, message_type, content, status, created_at, metadata_json
             FROM message ORDER BY created_at DESC LIMIT ?1"
        ).map_err(|e| format!("Failed to prepare statement: {}", e))?;

        let messages = stmt
            .query_map([limit], |row| Self::row_to_message(row))
            .map_err(|e| format!("Failed to query messages: {}", e))?
            .filter_map(log_and_skip_err)
            .collect();

        Ok(messages)
    }

    /// 🆕 P38: 检查某个代理在指定时间后是否发送过消息
    /// since: 任务开始时间，只检查此时间之后的消息
    pub fn has_agent_sent_message_since(
        &self,
        agent_session_id: &str,
        since: &str,
    ) -> Result<bool, String> {
        let conn = self.db.get_connection()?;
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM message WHERE sender_session_id = ?1 AND created_at > ?2",
                params![agent_session_id, since],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to count messages: {}", e))?;
        Ok(count > 0)
    }

    pub fn update_message_status(
        &self,
        message_id: &str,
        status: MessageStatus,
    ) -> Result<(), String> {
        let conn = self.db.get_connection()?;
        conn.execute(
            "UPDATE message SET status = ?1 WHERE id = ?2",
            params![
                serde_json::to_string(&status).unwrap().trim_matches('"'),
                message_id,
            ],
        )
        .map_err(|e| format!("Failed to update message status: {}", e))?;
        Ok(())
    }

    pub fn update_message_metadata(
        &self,
        message_id: &str,
        metadata: Option<&Value>,
    ) -> Result<(), String> {
        let conn = self.db.get_connection()?;
        let metadata_json = metadata.map(|v| v.to_string());
        conn.execute(
            "UPDATE message SET metadata_json = ?1 WHERE id = ?2",
            params![metadata_json, message_id],
        )
        .map_err(|e| format!("Failed to update message metadata: {}", e))?;
        Ok(())
    }

    pub fn add_to_inbox(
        &self,
        session_id: &str,
        message_id: &str,
        priority: i32,
    ) -> Result<i64, String> {
        let conn = self.db.get_connection()?;
        conn.execute(
            "INSERT INTO inbox (session_id, message_id, priority, status, created_at) VALUES (?1, ?2, ?3, 'unread', ?4)",
            params![session_id, message_id, priority, Utc::now().to_rfc3339()],
        ).map_err(|e| format!("Failed to add to inbox: {}", e))?;
        Ok(conn.last_insert_rowid())
    }

    pub fn get_unread_inbox(
        &self,
        session_id: &str,
        limit: usize,
    ) -> Result<Vec<InboxItem>, String> {
        let conn = self.db.get_connection()?;
        let mut stmt = conn
            .prepare(
                "SELECT id, session_id, message_id, priority, status, created_at FROM inbox
             WHERE session_id = ?1 AND status = 'unread' ORDER BY priority DESC, id ASC LIMIT ?2",
            )
            .map_err(|e| format!("Failed to prepare statement: {}", e))?;

        let items = stmt
            .query_map(params![session_id, limit], |row| {
                Self::row_to_inbox_item(row)
            })
            .map_err(|e| format!("Failed to query inbox: {}", e))?
            .filter_map(log_and_skip_err)
            .collect();

        Ok(items)
    }

    pub fn mark_inbox_processed(&self, inbox_ids: &[i64]) -> Result<(), String> {
        if inbox_ids.is_empty() {
            return Ok(());
        }
        let conn = self.db.get_connection()?;
        let placeholders: Vec<String> = inbox_ids.iter().map(|_| "?".to_string()).collect();
        let sql = format!(
            "UPDATE inbox SET status = 'processed' WHERE id IN ({})",
            placeholders.join(",")
        );
        let params: Vec<&dyn rusqlite::ToSql> = inbox_ids
            .iter()
            .map(|id| id as &dyn rusqlite::ToSql)
            .collect();
        conn.execute(&sql, params.as_slice())
            .map_err(|e| format!("Failed to mark inbox processed: {}", e))?;
        Ok(())
    }

    pub fn mark_inbox_processed_by_message(
        &self,
        session_id: &str,
        message_id: &str,
    ) -> Result<(), String> {
        let conn = self.db.get_connection()?;
        conn.execute(
            "UPDATE inbox SET status = 'processed' WHERE session_id = ?1 AND message_id = ?2 AND status = 'unread'",
            params![session_id, message_id],
        ).map_err(|e| format!("Failed to mark inbox processed by message: {}", e))?;
        Ok(())
    }

    /// 获取所有 agent 的 unread inbox 项（用于恢复内存状态）
    pub fn get_all_unread_inbox(&self) -> Result<Vec<InboxItem>, String> {
        let conn = self.db.get_connection()?;
        let mut stmt = conn
            .prepare(
                "SELECT id, session_id, message_id, priority, status, created_at FROM inbox
             WHERE status = 'unread' ORDER BY priority DESC, id ASC",
            )
            .map_err(|e| format!("Failed to prepare statement: {}", e))?;

        let items = stmt
            .query_map([], |row| Self::row_to_inbox_item(row))
            .map_err(|e| format!("Failed to query all unread inbox: {}", e))?
            .filter_map(log_and_skip_err)
            .collect();

        Ok(items)
    }

    pub fn save_document(&self, doc: &WorkspaceDocument) -> Result<(), String> {
        let conn = self.db.get_connection()?;
        conn.execute(
            "INSERT OR REPLACE INTO document (id, workspace_id, doc_type, title, content, version, updated_by, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                doc.id,
                doc.workspace_id,
                serde_json::to_string(&doc.doc_type).unwrap().trim_matches('"'),
                doc.title,
                doc.content,
                doc.version,
                doc.updated_by,
                doc.updated_at.to_rfc3339(),
            ],
        ).map_err(|e| format!("Failed to save document: {}", e))?;
        Ok(())
    }

    pub fn get_document(&self, doc_id: &str) -> Result<Option<WorkspaceDocument>, String> {
        let conn = self.db.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT id, workspace_id, doc_type, title, content, version, updated_by, updated_at FROM document WHERE id = ?1"
        ).map_err(|e| format!("Failed to prepare statement: {}", e))?;

        let result = stmt.query_row([doc_id], |row| Self::row_to_document(row));
        match result {
            Ok(doc) => Ok(Some(doc)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("Failed to query document: {}", e)),
        }
    }

    pub fn list_documents(&self) -> Result<Vec<WorkspaceDocument>, String> {
        let conn = self.db.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT id, workspace_id, doc_type, title, content, version, updated_by, updated_at FROM document ORDER BY updated_at DESC"
        ).map_err(|e| format!("Failed to prepare statement: {}", e))?;

        let docs = stmt
            .query_map([], |row| Self::row_to_document(row))
            .map_err(|e| format!("Failed to query documents: {}", e))?
            .filter_map(log_and_skip_err)
            .collect();

        Ok(docs)
    }

    pub fn set_context(&self, ctx: &WorkspaceContext) -> Result<(), String> {
        let conn = self.db.get_connection()?;
        conn.execute(
            "INSERT OR REPLACE INTO context (workspace_id, key, value_json, updated_by, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                ctx.workspace_id,
                ctx.key,
                ctx.value.to_string(),
                ctx.updated_by,
                ctx.updated_at.to_rfc3339(),
            ],
        )
        .map_err(|e| format!("Failed to set context: {}", e))?;
        Ok(())
    }

    pub fn get_context(&self, key: &str) -> Result<Option<WorkspaceContext>, String> {
        let conn = self.db.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT workspace_id, key, value_json, updated_by, updated_at FROM context WHERE key = ?1"
        ).map_err(|e| format!("Failed to prepare statement: {}", e))?;

        let result = stmt.query_row([key], |row| Self::row_to_context(row));
        match result {
            Ok(ctx) => Ok(Some(ctx)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("Failed to query context: {}", e)),
        }
    }

    pub fn list_context(&self) -> Result<Vec<WorkspaceContext>, String> {
        let conn = self.db.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT workspace_id, key, value_json, updated_by, updated_at FROM context ORDER BY key"
        ).map_err(|e| format!("Failed to prepare statement: {}", e))?;

        let contexts = stmt
            .query_map([], |row| Self::row_to_context(row))
            .map_err(|e| format!("Failed to query contexts: {}", e))?
            .filter_map(log_and_skip_err)
            .collect();

        Ok(contexts)
    }

    fn row_to_workspace(row: &Row) -> Result<Workspace, rusqlite::Error> {
        let created_at_str: String = row.get(4)?;
        let updated_at_str: String = row.get(5)?;
        Ok(Workspace {
            id: row.get(0)?,
            name: row.get(1)?,
            status: serde_json::from_str(&format!("\"{}\"", row.get::<_, String>(2)?))
                .unwrap_or_default(),
            creator_session_id: row.get(3)?,
            created_at: DateTime::parse_from_rfc3339(&created_at_str)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|e| {
                    log::warn!(
                        "[WorkspaceRepo] Failed to parse created_at '{}': {}, using epoch fallback",
                        created_at_str,
                        e
                    );
                    DateTime::<Utc>::from(std::time::UNIX_EPOCH)
                }),
            updated_at: DateTime::parse_from_rfc3339(&updated_at_str)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|e| {
                    log::warn!(
                        "[WorkspaceRepo] Failed to parse updated_at '{}': {}, using epoch fallback",
                        updated_at_str,
                        e
                    );
                    DateTime::<Utc>::from(std::time::UNIX_EPOCH)
                }),
            metadata: row
                .get::<_, Option<String>>(6)?
                .and_then(|s| serde_json::from_str(&s).ok()),
        })
    }

    fn row_to_agent(row: &Row) -> Result<WorkspaceAgent, rusqlite::Error> {
        let joined_at_str: String = row.get(5)?;
        let last_active_at_str: String = row.get(6)?;
        Ok(WorkspaceAgent {
            session_id: row.get(0)?,
            workspace_id: row.get(1)?,
            role: serde_json::from_str(&format!("\"{}\"", row.get::<_, String>(2)?))
                .unwrap_or_default(),
            skill_id: row.get(3)?,
            status: serde_json::from_str(&format!("\"{}\"", row.get::<_, String>(4)?))
                .unwrap_or_default(),
            joined_at: DateTime::parse_from_rfc3339(&joined_at_str)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|e| {
                    log::warn!("[WorkspaceRepo] Failed to parse joined_at '{}': {}, using epoch fallback", joined_at_str, e);
                    DateTime::<Utc>::from(std::time::UNIX_EPOCH)
                }),
            last_active_at: DateTime::parse_from_rfc3339(&last_active_at_str)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|e| {
                    log::warn!("[WorkspaceRepo] Failed to parse last_active_at '{}': {}, using epoch fallback", last_active_at_str, e);
                    DateTime::<Utc>::from(std::time::UNIX_EPOCH)
                }),
            metadata: row
                .get::<_, Option<String>>(7)?
                .and_then(|s| serde_json::from_str(&s).ok()),
        })
    }

    fn row_to_message(row: &Row) -> Result<WorkspaceMessage, rusqlite::Error> {
        let created_at_str: String = row.get(7)?;
        Ok(WorkspaceMessage {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            sender_session_id: row.get(2)?,
            target_session_id: row.get(3)?,
            message_type: serde_json::from_str(&format!("\"{}\"", row.get::<_, String>(4)?))
                .unwrap_or(MessageType::Task),
            content: row.get(5)?,
            status: serde_json::from_str(&format!("\"{}\"", row.get::<_, String>(6)?))
                .unwrap_or_default(),
            created_at: DateTime::parse_from_rfc3339(&created_at_str)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|e| {
                    log::warn!(
                        "[WorkspaceRepo] Failed to parse created_at '{}': {}, using epoch fallback",
                        created_at_str,
                        e
                    );
                    DateTime::<Utc>::from(std::time::UNIX_EPOCH)
                }),
            metadata: row
                .get::<_, Option<String>>(8)?
                .and_then(|s| serde_json::from_str(&s).ok()),
        })
    }

    fn row_to_inbox_item(row: &Row) -> Result<InboxItem, rusqlite::Error> {
        let created_at_str: String = row.get(5)?;
        Ok(InboxItem {
            id: row.get(0)?,
            session_id: row.get(1)?,
            message_id: row.get(2)?,
            priority: row.get(3)?,
            status: serde_json::from_str(&format!("\"{}\"", row.get::<_, String>(4)?))
                .unwrap_or_default(),
            created_at: DateTime::parse_from_rfc3339(&created_at_str)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|e| {
                    log::warn!(
                        "[WorkspaceRepo] Failed to parse created_at '{}': {}, using epoch fallback",
                        created_at_str,
                        e
                    );
                    DateTime::<Utc>::from(std::time::UNIX_EPOCH)
                }),
        })
    }

    fn row_to_document(row: &Row) -> Result<WorkspaceDocument, rusqlite::Error> {
        let updated_at_str: String = row.get(7)?;
        Ok(WorkspaceDocument {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            doc_type: serde_json::from_str(&format!("\"{}\"", row.get::<_, String>(2)?))
                .unwrap_or(DocumentType::Notes),
            title: row.get(3)?,
            content: row.get(4)?,
            version: row.get(5)?,
            updated_by: row.get(6)?,
            updated_at: DateTime::parse_from_rfc3339(&updated_at_str)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|e| {
                    log::warn!(
                        "[WorkspaceRepo] Failed to parse updated_at '{}': {}, using epoch fallback",
                        updated_at_str,
                        e
                    );
                    DateTime::<Utc>::from(std::time::UNIX_EPOCH)
                }),
        })
    }

    fn row_to_context(row: &Row) -> Result<WorkspaceContext, rusqlite::Error> {
        let updated_at_str: String = row.get(4)?;
        Ok(WorkspaceContext {
            workspace_id: row.get(0)?,
            key: row.get(1)?,
            value: serde_json::from_str(&row.get::<_, String>(2)?).unwrap_or(Value::Null),
            updated_by: row.get(3)?,
            updated_at: DateTime::parse_from_rfc3339(&updated_at_str)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|e| {
                    log::warn!(
                        "[WorkspaceRepo] Failed to parse updated_at '{}': {}, using epoch fallback",
                        updated_at_str,
                        e
                    );
                    DateTime::<Utc>::from(std::time::UNIX_EPOCH)
                }),
        })
    }
}
