use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use super::config::MAX_AGENTS_PER_WORKSPACE;
use super::database::{WorkspaceDatabase, WorkspaceDatabaseManager};
use super::emitter::{WorkspaceEventEmitter, WorkspaceWarningEvent};
use super::inbox::InboxManager;
use super::repo::WorkspaceRepo;
use super::router::{InboxOverflow, MessageRouter};
use super::sleep_manager::{SleepManager, WakeResultInfo};
use super::subagent_task::SubagentTaskManager;
use super::types::*;
use crate::chat_v2::database::ChatV2Database;
use crate::chat_v2::repo::ChatV2Repo;
use tauri::AppHandle;

struct WorkspaceInstance {
    workspace: Workspace,
    db: Arc<WorkspaceDatabase>,
    repo: Arc<WorkspaceRepo>,
    inbox_manager: Arc<InboxManager>,
    router: Arc<MessageRouter>,
    sleep_manager: Arc<SleepManager>,
    task_manager: Arc<SubagentTaskManager>,
}

pub struct WorkspaceCoordinator {
    workspaces_dir: PathBuf,
    db_manager: WorkspaceDatabaseManager,
    instances: RwLock<HashMap<WorkspaceId, Arc<WorkspaceInstance>>>,
    /// 主 chat_v2.db 引用，用于同步 workspace_index 表
    chat_v2_db: Option<Arc<ChatV2Database>>,
    /// 事件发射器，用于向前端发射工作区事件
    emitter: WorkspaceEventEmitter,
}

impl WorkspaceCoordinator {
    pub fn new(workspaces_dir: PathBuf) -> Self {
        Self {
            workspaces_dir: workspaces_dir.clone(),
            db_manager: WorkspaceDatabaseManager::new(workspaces_dir),
            instances: RwLock::new(HashMap::new()),
            chat_v2_db: None,
            emitter: WorkspaceEventEmitter::new(None),
        }
    }

    /// 设置 AppHandle，用于发射事件到前端
    pub fn with_app_handle(mut self, app_handle: AppHandle) -> Self {
        self.emitter = WorkspaceEventEmitter::new(Some(app_handle));
        self
    }

    /// 设置 chat_v2.db 引用，用于同步 workspace_index 表
    pub fn with_chat_v2_db(mut self, db: Arc<ChatV2Database>) -> Self {
        self.chat_v2_db = Some(db);
        self
    }

    /// 同步工作区到 workspace_index 表
    fn sync_to_index(&self, workspace: &Workspace) -> Result<(), String> {
        let db = match &self.chat_v2_db {
            Some(db) => db,
            None => {
                log::debug!("[WorkspaceCoordinator] chat_v2_db not set, skipping index sync");
                return Ok(());
            }
        };

        let conn = db
            .get_conn_safe()
            .map_err(|e| format!("Failed to get chat_v2 connection: {}", e))?;

        conn.execute(
            "INSERT OR REPLACE INTO workspace_index (workspace_id, name, status, creator_session_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                workspace.id,
                workspace.name,
                serde_json::to_string(&workspace.status).unwrap_or_default().trim_matches('"'),
                workspace.creator_session_id,
                workspace.created_at.to_rfc3339(),
                workspace.updated_at.to_rfc3339(),
            ],
        ).map_err(|e| format!("Failed to sync workspace to index: {}", e))?;

        log::debug!(
            "[WorkspaceCoordinator] Synced workspace {} to index",
            workspace.id
        );
        Ok(())
    }

    /// 从 workspace_index 表删除工作区
    fn remove_from_index(&self, workspace_id: &str) -> Result<(), String> {
        let db = match &self.chat_v2_db {
            Some(db) => db,
            None => return Ok(()),
        };

        let conn = db
            .get_conn_safe()
            .map_err(|e| format!("Failed to get chat_v2 connection: {}", e))?;

        conn.execute(
            "DELETE FROM workspace_index WHERE workspace_id = ?1",
            rusqlite::params![workspace_id],
        )
        .map_err(|e| format!("Failed to remove workspace from index: {}", e))?;

        log::debug!(
            "[WorkspaceCoordinator] Removed workspace {} from index",
            workspace_id
        );
        Ok(())
    }

    /// 更新 workspace_index 中的状态
    fn update_index_status(
        &self,
        workspace_id: &str,
        status: &WorkspaceStatus,
    ) -> Result<(), String> {
        let db = match &self.chat_v2_db {
            Some(db) => db,
            None => return Ok(()),
        };

        let conn = db
            .get_conn_safe()
            .map_err(|e| format!("Failed to get chat_v2 connection: {}", e))?;

        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE workspace_index SET status = ?1, updated_at = ?2 WHERE workspace_id = ?3",
            rusqlite::params![
                serde_json::to_string(status)
                    .unwrap_or_default()
                    .trim_matches('"'),
                now,
                workspace_id,
            ],
        )
        .map_err(|e| format!("Failed to update workspace status in index: {}", e))?;

        Ok(())
    }

    pub fn create_workspace(
        &self,
        creator_session_id: &str,
        name: Option<String>,
    ) -> Result<Workspace, String> {
        let workspace_id = Workspace::generate_id();
        let mut workspace = Workspace::new(workspace_id.clone(), creator_session_id.to_string());
        workspace.name = name;

        let db = self.db_manager.get_or_create(&workspace_id)?;
        let repo = Arc::new(WorkspaceRepo::new(Arc::clone(&db)));
        repo.save_workspace(&workspace)?;

        // 同步到 workspace_index 表
        self.sync_to_index(&workspace)?;

        let inbox_manager = Arc::new(InboxManager::new());
        let router = Arc::new(MessageRouter::new(
            Arc::clone(&repo),
            Arc::clone(&inbox_manager),
        ));
        let sleep_manager = Arc::new(SleepManager::new(Arc::clone(&db)));
        let task_manager = Arc::new(SubagentTaskManager::new(Arc::clone(&db)));

        let instance = Arc::new(WorkspaceInstance {
            workspace: workspace.clone(),
            db,
            repo,
            inbox_manager,
            router,
            sleep_manager,
            task_manager,
        });

        let mut instances = self.instances.write().unwrap_or_else(|poisoned| {
            log::error!("[WorkspaceCoordinator] RwLock poisoned (write)! Attempting recovery");
            poisoned.into_inner()
        });
        instances.insert(workspace_id, instance);

        Ok(workspace)
    }

    pub fn get_workspace(&self, workspace_id: &str) -> Result<Option<Workspace>, String> {
        let instances = self.instances.read().unwrap_or_else(|poisoned| {
            log::error!("[WorkspaceCoordinator] RwLock poisoned (read)! Attempting recovery");
            poisoned.into_inner()
        });
        if let Some(instance) = instances.get(workspace_id) {
            return Ok(Some(instance.workspace.clone()));
        }

        let db = match self.db_manager.get_or_create(workspace_id) {
            Ok(db) => db,
            Err(_) => return Ok(None),
        };
        let repo = WorkspaceRepo::new(db);
        repo.get_workspace()
    }

    pub fn close_workspace(&self, workspace_id: &str) -> Result<(), String> {
        let removed_instance = {
            let mut instances = self.instances.write().unwrap_or_else(|poisoned| {
                log::error!("[WorkspaceCoordinator] RwLock poisoned (write)! Attempting recovery");
                poisoned.into_inner()
            });
            instances.remove(workspace_id)
        };
        if let Some(instance) = removed_instance {
            instance
                .repo
                .update_workspace_status(WorkspaceStatus::Completed)?;
        } else if let Ok(instance) = self.get_instance(workspace_id) {
            let _ = instance
                .repo
                .update_workspace_status(WorkspaceStatus::Completed);
            let mut instances = self.instances.write().unwrap_or_else(|poisoned| {
                log::error!("[WorkspaceCoordinator] RwLock poisoned (write)! Attempting recovery");
                poisoned.into_inner()
            });
            instances.remove(workspace_id);
        }
        self.db_manager.remove(workspace_id);

        // 更新 workspace_index 中的状态
        self.update_index_status(workspace_id, &WorkspaceStatus::Completed)?;

        // 发射 workspace_closed 事件
        self.emitter.emit_workspace_closed(workspace_id);

        Ok(())
    }

    pub fn delete_workspace(&self, workspace_id: &str) -> Result<(), String> {
        // 在关闭/删除之前获取 worker 会话列表，用于清理 ChatSession
        let worker_session_ids = self
            .list_agents(workspace_id)
            .map(|agents| {
                agents
                    .into_iter()
                    .filter(|a| matches!(a.role, AgentRole::Worker))
                    .map(|a| a.session_id)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        self.close_workspace(workspace_id)?;
        self.db_manager.delete(workspace_id)?;

        // 从 workspace_index 删除记录
        self.remove_from_index(workspace_id)?;

        // 清理关联的 worker ChatSession（避免残留会话）
        self.cleanup_agent_sessions(&worker_session_ids);

        Ok(())
    }

    pub fn register_agent(
        &self,
        workspace_id: &str,
        session_id: &str,
        role: AgentRole,
        skill_id: Option<String>,
        metadata: Option<serde_json::Value>,
    ) -> Result<WorkspaceAgent, String> {
        let instance = self.get_instance(workspace_id)?;

        let agents = instance.repo.list_agents()?;
        if agents.len() >= MAX_AGENTS_PER_WORKSPACE {
            return Err(format!(
                "Workspace has reached maximum agent limit: {}",
                MAX_AGENTS_PER_WORKSPACE
            ));
        }

        let mut agent = WorkspaceAgent::new(session_id.to_string(), workspace_id.to_string(), role);
        agent.skill_id = skill_id;
        agent.metadata = metadata;
        instance.repo.save_agent(&agent)?;

        // 发射 agent_joined 事件
        self.emitter.emit_agent_joined(workspace_id, &agent);

        Ok(agent)
    }

    pub fn unregister_agent(&self, workspace_id: &str, session_id: &str) -> Result<(), String> {
        let instance = self.get_instance(workspace_id)?;
        instance.inbox_manager.clear(session_id);
        instance.repo.delete_agent(session_id)?;

        // 发射 agent_left 事件
        self.emitter.emit_agent_left(workspace_id, session_id);

        Ok(())
    }

    pub fn update_agent_status(
        &self,
        workspace_id: &str,
        session_id: &str,
        status: AgentStatus,
    ) -> Result<(), String> {
        let instance = self.get_instance(workspace_id)?;
        instance
            .repo
            .update_agent_status(session_id, status.clone())?;

        // 发射 agent_status_changed 事件
        self.emitter.emit_agent_status_changed(
            workspace_id,
            session_id,
            &format!("{:?}", status).to_lowercase(),
        );

        // worker 进入终态时，尝试通过状态信号唤醒 coordinator，避免仅靠 timeout 恢复
        if matches!(status, AgentStatus::Completed | AgentStatus::Failed) {
            match instance.sleep_manager.check_and_wake_by_agent_status(
                workspace_id,
                session_id,
                &status,
            ) {
                Ok(awakened) => {
                    for wake_info in awakened {
                        self.emitter.emit_coordinator_awakened(
                            &wake_info.workspace_id,
                            &wake_info.coordinator_session_id,
                            &wake_info.sleep_id,
                            &wake_info.awakened_by,
                            wake_info.awaken_message.as_deref(),
                            &wake_info.wake_reason,
                        );
                    }
                }
                Err(e) => {
                    log::warn!(
                        "[WorkspaceCoordinator] Failed to check wake-by-status condition: {:?}",
                        e
                    );
                }
            }
        }

        Ok(())
    }

    pub fn list_agents(&self, workspace_id: &str) -> Result<Vec<WorkspaceAgent>, String> {
        let instance = self.get_instance(workspace_id)?;
        instance.repo.list_agents()
    }

    /// 🆕 P38: 检查某个代理在指定时间后是否发送过消息
    pub fn has_agent_sent_message_since(
        &self,
        workspace_id: &str,
        agent_session_id: &str,
        since: &str,
    ) -> Result<bool, String> {
        let instance = self.get_instance(workspace_id)?;
        instance
            .repo
            .has_agent_sent_message_since(agent_session_id, since)
    }

    pub fn send_message(
        &self,
        workspace_id: &str,
        sender_id: &str,
        target_id: Option<&str>,
        message_type: MessageType,
        content: String,
    ) -> Result<WorkspaceMessage, String> {
        let instance = self.get_instance(workspace_id)?;
        if !self.is_member_or_creator(&instance, sender_id)? {
            return Err("Permission denied: sender is not a workspace member".to_string());
        }
        if let Some(target) = target_id {
            if instance.repo.get_agent(target)?.is_none() {
                return Err(format!("Target agent not found: {}", target));
            }
        }
        let mut normalized_type = message_type;
        if target_id.is_none() && !matches!(normalized_type, MessageType::Broadcast) {
            normalized_type = MessageType::Broadcast;
        }
        if target_id.is_some() && matches!(normalized_type, MessageType::Broadcast) {
            return Err("Broadcast message must not specify target_session_id".to_string());
        }

        let (message, overflow) = match target_id {
            Some(target) => instance.router.send_unicast(
                workspace_id,
                sender_id,
                target,
                normalized_type,
                content,
            )?,
            None => {
                let (msg, _targets, overflow) = instance.router.send_broadcast(
                    workspace_id,
                    sender_id,
                    normalized_type,
                    content,
                )?;
                (msg, overflow)
            }
        };

        // 发射 message_received 事件
        self.emitter.emit_message_received(workspace_id, &message);

        // 如果 inbox 溢出，发射警告事件（前端可提示用户）
        if !overflow.is_empty() {
            self.emit_inbox_overflow_warning(workspace_id, &overflow);
        }

        // 🆕 检查是否需要唤醒某个睡眠中的 Coordinator
        match instance.sleep_manager.check_and_wake_by_message(&message) {
            Ok(awakened) => {
                // 🆕 为每个被唤醒的睡眠发射事件，通知前端恢复管线
                for wake_info in awakened {
                    self.emitter.emit_coordinator_awakened(
                        &wake_info.workspace_id,
                        &wake_info.coordinator_session_id,
                        &wake_info.sleep_id,
                        &wake_info.awakened_by,
                        wake_info.awaken_message.as_deref(),
                        &wake_info.wake_reason,
                    );
                }
            }
            Err(e) => {
                log::warn!(
                    "[WorkspaceCoordinator] Failed to check wake condition: {:?}",
                    e
                );
            }
        }

        Ok(message)
    }

    pub fn drain_inbox(
        &self,
        workspace_id: &str,
        session_id: &str,
        limit: usize,
    ) -> Result<Vec<WorkspaceMessage>, String> {
        log::info!(
            "[WorkspaceCoordinator] [DRAIN_INBOX] Starting drain for session={}, workspace={}, limit={}",
            session_id, workspace_id, limit
        );
        let instance = self.get_instance(workspace_id)?;

        let message_ids = instance.inbox_manager.drain(session_id, limit);
        log::info!(
            "[WorkspaceCoordinator] [DRAIN_INBOX] Drained {} message IDs from inbox for session={}",
            message_ids.len(),
            session_id
        );
        if message_ids.is_empty() {
            log::info!(
                "[WorkspaceCoordinator] [DRAIN_INBOX] Inbox empty for session={}, returning empty vec",
                session_id
            );
            return Ok(Vec::new());
        }

        let mut messages = Vec::new();
        let mut inbox_ids = Vec::new();

        for message_id in &message_ids {
            if let Some(message) = instance.repo.get_message(message_id)? {
                messages.push(message);
            }
        }

        let inbox_items = instance.repo.get_unread_inbox(session_id, limit)?;
        for item in inbox_items {
            if message_ids.contains(&item.message_id) {
                inbox_ids.push(item.id);
            }
        }

        if !inbox_ids.is_empty() {
            instance.repo.mark_inbox_processed(&inbox_ids)?;
        }

        Ok(messages)
    }

    pub fn has_pending_messages(&self, workspace_id: &str, session_id: &str) -> bool {
        let instances = self.instances.read().unwrap_or_else(|poisoned| {
            log::error!("[WorkspaceCoordinator] RwLock poisoned (read)! Attempting recovery");
            poisoned.into_inner()
        });
        if let Some(instance) = instances.get(workspace_id) {
            return !instance.inbox_manager.is_empty(session_id);
        }
        false
    }

    /// 🔧 P1-2 修复：重新将消息加入 inbox 以便重试
    /// 当 Agent 执行失败时，调用此方法将原消息重新加入 inbox
    pub fn re_enqueue_message(
        &self,
        workspace_id: &str,
        session_id: &str,
        message_id: &str,
    ) -> Result<(), String> {
        let instance = self.get_instance(workspace_id)?;

        // 将消息 ID 重新加入内存 inbox；队列满时拒绝新入队，避免静默挤掉旧消息
        let push_result = instance.inbox_manager.push(session_id, message_id);
        if let Some(rejected_message_id) = push_result.rejected_message_id {
            self.emit_inbox_overflow_warning(
                workspace_id,
                &[InboxOverflow {
                    target_session_id: session_id.to_string(),
                    rejected_message_id,
                }],
            );
            return Err(format!(
                "Agent inbox is full for {}. Retry after the agent drains pending tasks.",
                session_id
            ));
        }

        // 同时在数据库中添加新的 inbox 记录（优先级 0，因为是重试）
        instance.repo.add_to_inbox(session_id, message_id, 0)?;

        log::debug!(
            "[WorkspaceCoordinator] Re-enqueued message {} to agent {} inbox for retry",
            message_id,
            session_id
        );

        Ok(())
    }

    pub fn set_context(
        &self,
        workspace_id: &str,
        key: &str,
        value: serde_json::Value,
        updated_by: &str,
    ) -> Result<(), String> {
        let instance = self.get_instance(workspace_id)?;
        if !self.can_update_context(&instance, updated_by)? {
            return Err(
                "Permission denied: only coordinator can update workspace context".to_string(),
            );
        }
        let ctx = WorkspaceContext::new(
            workspace_id.to_string(),
            key.to_string(),
            value,
            updated_by.to_string(),
        );
        instance.repo.set_context(&ctx)
    }

    pub fn get_context(
        &self,
        workspace_id: &str,
        key: &str,
    ) -> Result<Option<WorkspaceContext>, String> {
        let instance = self.get_instance(workspace_id)?;
        instance.repo.get_context(key)
    }

    pub fn list_context(&self, workspace_id: &str) -> Result<Vec<WorkspaceContext>, String> {
        let instance = self.get_instance(workspace_id)?;
        instance.repo.list_context()
    }

    pub fn save_document(&self, workspace_id: &str, doc: &WorkspaceDocument) -> Result<(), String> {
        let instance = self.get_instance(workspace_id)?;
        instance.repo.save_document(doc)?;

        // 发射 document_updated 事件
        self.emitter.emit_document_updated(workspace_id, doc);

        Ok(())
    }

    pub fn get_document(
        &self,
        workspace_id: &str,
        doc_id: &str,
    ) -> Result<Option<WorkspaceDocument>, String> {
        let instance = self.get_instance(workspace_id)?;
        instance.repo.get_document(doc_id)
    }

    pub fn list_documents(&self, workspace_id: &str) -> Result<Vec<WorkspaceDocument>, String> {
        let instance = self.get_instance(workspace_id)?;
        instance.repo.list_documents()
    }

    pub fn list_messages(
        &self,
        workspace_id: &str,
        limit: usize,
    ) -> Result<Vec<WorkspaceMessage>, String> {
        let instance = self.get_instance(workspace_id)?;
        instance.repo.list_messages(limit)
    }

    /// 获取睡眠管理器
    pub fn get_sleep_manager(&self, workspace_id: &str) -> Result<Arc<SleepManager>, String> {
        let instance = self.get_instance(workspace_id)?;
        Ok(Arc::clone(&instance.sleep_manager))
    }

    /// 🔧 P33 修复：发射唤醒事件（供 handler 调用）
    pub fn emit_coordinator_awakened(&self, info: &WakeResultInfo) {
        self.emitter.emit_coordinator_awakened(
            &info.workspace_id,
            &info.coordinator_session_id,
            &info.sleep_id,
            &info.awakened_by,
            info.awaken_message.as_deref(),
            &info.wake_reason,
        );
    }

    /// 🔧 允许 Coordinator 或 creator 更新共享上下文
    fn can_update_context(
        &self,
        instance: &WorkspaceInstance,
        session_id: &str,
    ) -> Result<bool, String> {
        if let Ok(Some(agent)) = instance.repo.get_agent(session_id) {
            if matches!(agent.role, AgentRole::Coordinator) {
                return Ok(true);
            }
        }
        if let Ok(Some(workspace)) = instance.repo.get_workspace() {
            if workspace.creator_session_id == session_id {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// 校验会话是否为成员或创建者
    fn is_member_or_creator(
        &self,
        instance: &WorkspaceInstance,
        session_id: &str,
    ) -> Result<bool, String> {
        if let Ok(Some(_agent)) = instance.repo.get_agent(session_id) {
            return Ok(true);
        }
        if let Ok(Some(workspace)) = instance.repo.get_workspace() {
            if workspace.creator_session_id == session_id {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// 对外校验：会话是否属于该工作区
    pub fn ensure_member_or_creator(
        &self,
        workspace_id: &str,
        session_id: &str,
    ) -> Result<(), String> {
        let instance = self.get_instance(workspace_id)?;
        if self.is_member_or_creator(&instance, session_id)? {
            Ok(())
        } else {
            Err("Permission denied: session is not a workspace member".to_string())
        }
    }

    /// 对外查询：会话是否属于该工作区
    pub fn is_member_or_creator_session(
        &self,
        workspace_id: &str,
        session_id: &str,
    ) -> Result<bool, String> {
        let instance = self.get_instance(workspace_id)?;
        self.is_member_or_creator(&instance, session_id)
    }

    /// 🆕 递增消息重试次数（写入 metadata）
    pub fn increment_message_retry_count(
        &self,
        workspace_id: &str,
        message_id: &str,
    ) -> Result<u32, String> {
        let instance = self.get_instance(workspace_id)?;
        let message = instance
            .repo
            .get_message(message_id)?
            .ok_or_else(|| format!("Message not found: {}", message_id))?;

        let mut metadata = match message.metadata {
            Some(serde_json::Value::Object(map)) => serde_json::Value::Object(map),
            _ => serde_json::json!({}),
        };
        let current = metadata
            .get("retry_count")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let next = current.saturating_add(1);
        if let serde_json::Value::Object(ref mut map) = metadata {
            map.insert("retry_count".to_string(), serde_json::Value::from(next));
        }
        instance
            .repo
            .update_message_metadata(message_id, Some(&metadata))?;
        Ok(next as u32)
    }

    /// 🆕 inbox 溢出警告（聚合并发射事件）
    fn emit_inbox_overflow_warning(&self, workspace_id: &str, overflow: &[InboxOverflow]) {
        if overflow.is_empty() {
            return;
        }
        let mut by_target: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        for entry in overflow {
            by_target
                .entry(entry.target_session_id.clone())
                .or_default()
                .push(entry.rejected_message_id.clone());
        }

        for (target_session_id, dropped_ids) in by_target {
            let warning = WorkspaceWarningEvent {
                workspace_id: workspace_id.to_string(),
                code: "inbox_full_rejected".to_string(),
                message: format!(
                    "Agent {} inbox is full: rejected {} new message(s). Wait for the worker to finish and retry.",
                    target_session_id,
                    dropped_ids.len()
                ),
                agent_session_id: Some(target_session_id),
                message_id: dropped_ids.last().cloned(),
                retry_count: None,
                max_retries: None,
            };
            self.emitter.emit_warning(warning);
        }
    }

    /// 🆕 发射通用工作区警告事件
    pub fn emit_warning(&self, warning: WorkspaceWarningEvent) {
        self.emitter.emit_warning(warning);
    }

    /// 🆕 清理关联的 worker ChatSession
    fn cleanup_agent_sessions(&self, worker_session_ids: &[String]) {
        let db = match &self.chat_v2_db {
            Some(db) => db,
            None => return,
        };
        for session_id in worker_session_ids {
            if let Err(e) = ChatV2Repo::delete_session_v2(db, session_id) {
                log::warn!(
                    "[WorkspaceCoordinator] Failed to delete worker session {}: {:?}",
                    session_id,
                    e
                );
            }
        }
    }

    fn get_instance(&self, workspace_id: &str) -> Result<Arc<WorkspaceInstance>, String> {
        {
            let instances = self.instances.read().unwrap_or_else(|poisoned| {
                log::error!("[WorkspaceCoordinator] RwLock poisoned (read)! Attempting recovery");
                poisoned.into_inner()
            });
            if let Some(instance) = instances.get(workspace_id) {
                return Ok(Arc::clone(instance));
            }
        }

        let db = self.db_manager.get_or_create(workspace_id)?;
        let repo = Arc::new(WorkspaceRepo::new(Arc::clone(&db)));

        let workspace = repo
            .get_workspace()?
            .ok_or_else(|| format!("Workspace not found: {}", workspace_id))?;

        let inbox_manager = Arc::new(InboxManager::new());

        // 🔧 P0-1 修复：从数据库恢复 inbox 内存状态，防止重启丢失
        if let Ok(unread_items) = repo.get_all_unread_inbox() {
            if !unread_items.is_empty() {
                log::info!(
                    "[WorkspaceCoordinator] Restoring {} unread inbox items for workspace {}",
                    unread_items.len(),
                    workspace_id
                );
                inbox_manager.restore_from_db(unread_items);
            }
        }

        let router = Arc::new(MessageRouter::new(
            Arc::clone(&repo),
            Arc::clone(&inbox_manager),
        ));
        let sleep_manager = Arc::new(SleepManager::new(Arc::clone(&db)));

        // 🆕 恢复睡眠状态：将数据库中 sleeping 的睡眠块重新激活
        match sleep_manager.restore_and_activate_sleeps() {
            Ok(activated) => {
                if !activated.is_empty() {
                    log::info!(
                        "[WorkspaceCoordinator] Restored {} active sleeps for workspace {}",
                        activated.len(),
                        workspace_id
                    );
                    // 注：这些 receiver 不需要被 await，因为它们会在收到消息时被唤醒
                    // 唤醒逻辑已经在 check_and_wake_by_message 中处理
                }
            }
            Err(e) => {
                log::warn!(
                    "[WorkspaceCoordinator] Failed to restore sleeps for workspace {}: {:?}",
                    workspace_id,
                    e
                );
            }
        }

        let task_manager = Arc::new(SubagentTaskManager::new(Arc::clone(&db)));

        // 🆕 恢复子代理任务：检查是否有需要恢复的任务
        match task_manager.get_tasks_to_restore() {
            Ok(tasks) => {
                if !tasks.is_empty() {
                    log::info!(
                        "[WorkspaceCoordinator] Found {} subagent tasks to restore for workspace {}",
                        tasks.len(),
                        workspace_id
                    );
                    // 任务恢复将在前端加载时触发（通过前端调用 workspace_run_agent）
                    // 这里只记录日志，实际恢复逻辑由前端驱动
                }
            }
            Err(e) => {
                log::warn!(
                    "[WorkspaceCoordinator] Failed to check tasks to restore: {:?}",
                    e
                );
            }
        }

        let instance = Arc::new(WorkspaceInstance {
            workspace,
            db,
            repo,
            inbox_manager,
            router,
            sleep_manager,
            task_manager,
        });

        let mut instances = self.instances.write().unwrap_or_else(|poisoned| {
            log::error!("[WorkspaceCoordinator] RwLock poisoned (write)! Attempting recovery");
            poisoned.into_inner()
        });
        instances.insert(workspace_id.to_string(), Arc::clone(&instance));

        Ok(instance)
    }

    /// 获取子代理任务管理器
    pub fn get_task_manager(&self, workspace_id: &str) -> Result<Arc<SubagentTaskManager>, String> {
        let instance = self.get_instance(workspace_id)?;
        Ok(Arc::clone(&instance.task_manager))
    }

    /// 进入维护模式：暂停所有活跃工作区的数据库连接池
    ///
    /// 在备份/恢复操作期间调用，确保 ws_*.db 文件不被锁定。
    /// 单个工作区失败不阻断其他工作区。
    pub fn enter_maintenance_mode(&self) -> Result<(), String> {
        let instances = self.instances.read().unwrap_or_else(|poisoned| {
            log::error!("[WorkspaceCoordinator] RwLock poisoned (read)! Attempting recovery");
            poisoned.into_inner()
        });

        let mut failures = Vec::new();
        for (id, instance) in instances.iter() {
            if let Err(e) = instance.db.enter_maintenance_mode() {
                log::warn!(
                    "[WorkspaceCoordinator] 工作区 {} 进入维护模式失败: {}",
                    id,
                    e
                );
                failures.push(format!("{}: {}", id, e));
            }
        }

        if failures.is_empty() {
            log::info!(
                "[WorkspaceCoordinator] 所有 {} 个工作区已进入维护模式",
                instances.len()
            );
        } else {
            log::warn!(
                "[WorkspaceCoordinator] {} 个工作区进入维护模式失败: {:?}",
                failures.len(),
                failures
            );
        }

        Ok(())
    }

    /// 退出维护模式：恢复所有活跃工作区的磁盘数据库连接
    pub fn exit_maintenance_mode(&self) -> Result<(), String> {
        let instances = self.instances.read().unwrap_or_else(|poisoned| {
            log::error!("[WorkspaceCoordinator] RwLock poisoned (read)! Attempting recovery");
            poisoned.into_inner()
        });

        let mut failures = Vec::new();
        for (id, instance) in instances.iter() {
            if let Err(e) = instance.db.exit_maintenance_mode() {
                log::warn!(
                    "[WorkspaceCoordinator] 工作区 {} 退出维护模式失败: {}",
                    id,
                    e
                );
                failures.push(format!("{}: {}", id, e));
            }
        }

        if failures.is_empty() {
            log::info!(
                "[WorkspaceCoordinator] 所有 {} 个工作区已退出维护模式",
                instances.len()
            );
        } else {
            log::warn!(
                "[WorkspaceCoordinator] {} 个工作区退出维护模式失败: {:?}",
                failures.len(),
                failures
            );
        }

        Ok(())
    }
}
