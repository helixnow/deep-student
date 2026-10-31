//! 工作区事件发射器
//!
//! 向前端发射工作区相关事件，用于实时更新 UI

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::types::{WorkspaceAgent, WorkspaceDocument, WorkspaceMessage};

/// 工作区事件通道常量
pub mod workspace_events {
    pub const MESSAGE_RECEIVED: &str = "workspace_message_received";
    pub const AGENT_JOINED: &str = "workspace_agent_joined";
    pub const AGENT_LEFT: &str = "workspace_agent_left";
    pub const AGENT_STATUS_CHANGED: &str = "workspace_agent_status_changed";
    pub const DOCUMENT_UPDATED: &str = "workspace_document_updated";
    pub const WORKSPACE_CLOSED: &str = "workspace_closed";
    /// 🆕 主代理被唤醒事件（睡眠块被唤醒后发射，触发管线恢复）
    pub const COORDINATOR_AWAKENED: &str = "workspace_coordinator_awakened";
    /// 🆕 工作区警告事件（容量溢出、重试耗尽等）
    pub const WORKSPACE_WARNING: &str = "workspace_warning";
}

/// 消息接收事件 payload
#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceMessageEvent {
    pub workspace_id: String,
    pub message: MessagePayload,
}

#[derive(Debug, Clone, Serialize)]
pub struct MessagePayload {
    pub id: String,
    pub sender_session_id: String,
    pub target_session_id: Option<String>,
    pub message_type: String,
    pub content: String,
    pub status: String,
    pub created_at: String,
}

impl From<&WorkspaceMessage> for MessagePayload {
    fn from(msg: &WorkspaceMessage) -> Self {
        Self {
            id: msg.id.clone(),
            sender_session_id: msg.sender_session_id.clone(),
            target_session_id: msg.target_session_id.clone(),
            message_type: format!("{:?}", msg.message_type).to_lowercase(),
            content: msg.content.clone(),
            status: format!("{:?}", msg.status).to_lowercase(),
            created_at: msg.created_at.to_rfc3339(),
        }
    }
}

/// Agent 加入/离开事件 payload
#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceAgentEvent {
    pub workspace_id: String,
    pub agent: AgentPayload,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentPayload {
    pub session_id: String,
    pub role: String,
    pub status: String,
    pub skill_id: Option<String>,
    pub joined_at: String,
    pub last_active_at: String,
}

impl From<&WorkspaceAgent> for AgentPayload {
    fn from(agent: &WorkspaceAgent) -> Self {
        Self {
            session_id: agent.session_id.clone(),
            role: format!("{:?}", agent.role).to_lowercase(),
            status: format!("{:?}", agent.status).to_lowercase(),
            skill_id: agent.skill_id.clone(),
            joined_at: agent.joined_at.to_rfc3339(),
            last_active_at: agent.last_active_at.to_rfc3339(),
        }
    }
}

/// Agent 状态变更事件 payload
#[derive(Debug, Clone, Serialize)]
pub struct AgentStatusEvent {
    pub workspace_id: String,
    pub session_id: String,
    pub status: String,
}

/// 文档更新事件 payload
#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceDocumentEvent {
    pub workspace_id: String,
    pub document: DocumentPayload,
}

#[derive(Debug, Clone, Serialize)]
pub struct DocumentPayload {
    pub id: String,
    pub doc_type: String,
    pub title: String,
    pub version: u32,
    pub updated_by: String,
    pub updated_at: String,
}

impl From<&WorkspaceDocument> for DocumentPayload {
    fn from(doc: &WorkspaceDocument) -> Self {
        Self {
            id: doc.id.clone(),
            doc_type: format!("{:?}", doc.doc_type).to_lowercase(),
            title: doc.title.clone(),
            version: doc.version as u32,
            updated_by: doc.updated_by.clone(),
            updated_at: doc.updated_at.to_rfc3339(),
        }
    }
}

/// 工作区关闭事件 payload
#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceClosedEvent {
    pub workspace_id: String,
}

/// 🆕 主代理唤醒事件 payload
#[derive(Debug, Clone, Serialize)]
pub struct CoordinatorAwakenedEvent {
    pub workspace_id: String,
    pub coordinator_session_id: String,
    pub sleep_id: String,
    pub awakened_by: String,
    pub awaken_message: Option<String>,
    pub wake_reason: String,
}

/// 🆕 工作区警告事件 payload
#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceWarningEvent {
    pub workspace_id: String,
    pub code: String,
    pub message: String,
    pub agent_session_id: Option<String>,
    pub message_id: Option<String>,
    pub retry_count: Option<u32>,
    pub max_retries: Option<u32>,
}

/// 工作区事件发射器
#[derive(Clone)]
pub struct WorkspaceEventEmitter {
    app_handle: Option<AppHandle>,
}

impl WorkspaceEventEmitter {
    pub fn new(app_handle: Option<AppHandle>) -> Self {
        Self { app_handle }
    }

    /// 发射消息接收事件
    pub fn emit_message_received(&self, workspace_id: &str, message: &WorkspaceMessage) {
        if let Some(ref handle) = self.app_handle {
            let event = WorkspaceMessageEvent {
                workspace_id: workspace_id.to_string(),
                message: MessagePayload::from(message),
            };
            if let Err(e) = handle.emit(workspace_events::MESSAGE_RECEIVED, &event) {
                log::warn!("[WorkspaceEmitter] Failed to emit message_received: {}", e);
            }
        }
    }

    /// 发射 Agent 加入事件
    pub fn emit_agent_joined(&self, workspace_id: &str, agent: &WorkspaceAgent) {
        if let Some(ref handle) = self.app_handle {
            let event = WorkspaceAgentEvent {
                workspace_id: workspace_id.to_string(),
                agent: AgentPayload::from(agent),
            };
            if let Err(e) = handle.emit(workspace_events::AGENT_JOINED, &event) {
                log::warn!("[WorkspaceEmitter] Failed to emit agent_joined: {}", e);
            }
        }
    }

    /// 发射 Agent 离开事件
    pub fn emit_agent_left(&self, workspace_id: &str, session_id: &str) {
        if let Some(ref handle) = self.app_handle {
            let event = WorkspaceAgentEvent {
                workspace_id: workspace_id.to_string(),
                agent: AgentPayload {
                    session_id: session_id.to_string(),
                    role: String::new(),
                    status: "left".to_string(),
                    skill_id: None,
                    joined_at: String::new(),
                    last_active_at: String::new(),
                },
            };
            if let Err(e) = handle.emit(workspace_events::AGENT_LEFT, &event) {
                log::warn!("[WorkspaceEmitter] Failed to emit agent_left: {}", e);
            }
        }
    }

    /// 发射 Agent 状态变更事件
    pub fn emit_agent_status_changed(&self, workspace_id: &str, session_id: &str, status: &str) {
        if let Some(ref handle) = self.app_handle {
            let event = AgentStatusEvent {
                workspace_id: workspace_id.to_string(),
                session_id: session_id.to_string(),
                status: status.to_string(),
            };
            if let Err(e) = handle.emit(workspace_events::AGENT_STATUS_CHANGED, &event) {
                log::warn!(
                    "[WorkspaceEmitter] Failed to emit agent_status_changed: {}",
                    e
                );
            }
        }
    }

    /// 发射文档更新事件
    pub fn emit_document_updated(&self, workspace_id: &str, document: &WorkspaceDocument) {
        if let Some(ref handle) = self.app_handle {
            let event = WorkspaceDocumentEvent {
                workspace_id: workspace_id.to_string(),
                document: DocumentPayload::from(document),
            };
            if let Err(e) = handle.emit(workspace_events::DOCUMENT_UPDATED, &event) {
                log::warn!("[WorkspaceEmitter] Failed to emit document_updated: {}", e);
            }
        }
    }

    /// 发射工作区关闭事件
    pub fn emit_workspace_closed(&self, workspace_id: &str) {
        if let Some(ref handle) = self.app_handle {
            let event = WorkspaceClosedEvent {
                workspace_id: workspace_id.to_string(),
            };
            if let Err(e) = handle.emit(workspace_events::WORKSPACE_CLOSED, &event) {
                log::warn!("[WorkspaceEmitter] Failed to emit workspace_closed: {}", e);
            }
        }
    }

    /// 🆕 发射主代理唤醒事件
    ///
    /// 当睡眠块被唤醒时调用，通知前端恢复主代理管线
    pub fn emit_coordinator_awakened(
        &self,
        workspace_id: &str,
        coordinator_session_id: &str,
        sleep_id: &str,
        awakened_by: &str,
        awaken_message: Option<&str>,
        wake_reason: &str,
    ) {
        if let Some(ref handle) = self.app_handle {
            let event = CoordinatorAwakenedEvent {
                workspace_id: workspace_id.to_string(),
                coordinator_session_id: coordinator_session_id.to_string(),
                sleep_id: sleep_id.to_string(),
                awakened_by: awakened_by.to_string(),
                awaken_message: awaken_message.map(|s| s.to_string()),
                wake_reason: wake_reason.to_string(),
            };
            log::info!(
                "[WorkspaceEmitter] Emitting coordinator_awakened: coordinator={}, sleep={}, by={}",
                coordinator_session_id,
                sleep_id,
                awakened_by
            );
            if let Err(e) = handle.emit(workspace_events::COORDINATOR_AWAKENED, &event) {
                log::warn!(
                    "[WorkspaceEmitter] Failed to emit coordinator_awakened: {}",
                    e
                );
            }
        } else {
            log::warn!("[WorkspaceEmitter] No app_handle, cannot emit coordinator_awakened");
        }
    }

    /// 🆕 发射工作区警告事件
    pub fn emit_warning(&self, warning: WorkspaceWarningEvent) {
        if let Some(ref handle) = self.app_handle {
            if let Err(e) = handle.emit(workspace_events::WORKSPACE_WARNING, &warning) {
                log::warn!("[WorkspaceEmitter] Failed to emit workspace_warning: {}", e);
            }
        }
    }
}
