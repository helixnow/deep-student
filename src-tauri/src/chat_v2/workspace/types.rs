use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type WorkspaceId = String;
pub type AgentId = String;
pub type MessageId = String;
pub type DocumentId = String;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceStatus {
    Active,
    Completed,
    Archived,
}

impl Default for WorkspaceStatus {
    fn default() -> Self {
        Self::Active
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: WorkspaceId,
    pub name: Option<String>,
    pub status: WorkspaceStatus,
    pub creator_session_id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

impl Workspace {
    pub fn new(id: WorkspaceId, creator_session_id: String) -> Self {
        let now = Utc::now();
        Self {
            id,
            name: None,
            status: WorkspaceStatus::Active,
            creator_session_id,
            created_at: now,
            updated_at: now,
            metadata: None,
        }
    }

    pub fn generate_id() -> WorkspaceId {
        format!("ws_{}", ulid::Ulid::new())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentRole {
    Coordinator,
    Worker,
}

impl Default for AgentRole {
    fn default() -> Self {
        Self::Worker
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Idle,
    Running,
    Completed,
    Failed,
}

impl Default for AgentStatus {
    fn default() -> Self {
        Self::Idle
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceAgent {
    pub session_id: AgentId,
    pub workspace_id: WorkspaceId,
    pub role: AgentRole,
    pub skill_id: Option<String>,
    pub status: AgentStatus,
    pub joined_at: DateTime<Utc>,
    pub last_active_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

impl WorkspaceAgent {
    pub fn new(session_id: AgentId, workspace_id: WorkspaceId, role: AgentRole) -> Self {
        let now = Utc::now();
        Self {
            session_id,
            workspace_id,
            role,
            skill_id: None,
            status: AgentStatus::Idle,
            joined_at: now,
            last_active_at: now,
            metadata: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageType {
    Task,
    Progress,
    Result,
    Query,
    Correction,
    Broadcast,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageStatus {
    Pending,
    Delivered,
    Processed,
}

impl Default for MessageStatus {
    fn default() -> Self {
        Self::Pending
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMessage {
    pub id: MessageId,
    pub workspace_id: WorkspaceId,
    pub sender_session_id: AgentId,
    pub target_session_id: Option<AgentId>,
    pub message_type: MessageType,
    pub content: String,
    pub status: MessageStatus,
    pub created_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

impl WorkspaceMessage {
    pub fn new(
        workspace_id: WorkspaceId,
        sender_session_id: AgentId,
        target_session_id: Option<AgentId>,
        message_type: MessageType,
        content: String,
    ) -> Self {
        Self {
            id: Self::generate_id(),
            workspace_id,
            sender_session_id,
            target_session_id,
            message_type,
            content,
            status: MessageStatus::Pending,
            created_at: Utc::now(),
            metadata: None,
        }
    }

    pub fn generate_id() -> MessageId {
        format!("wsmsg_{}", ulid::Ulid::new())
    }

    pub fn is_broadcast(&self) -> bool {
        self.target_session_id.is_none()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InboxStatus {
    Unread,
    Read,
    Processed,
}

impl Default for InboxStatus {
    fn default() -> Self {
        Self::Unread
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    pub id: i64,
    pub session_id: AgentId,
    pub message_id: MessageId,
    pub priority: i32,
    pub status: InboxStatus,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DocumentType {
    Plan,
    Research,
    Artifact,
    Notes,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDocument {
    pub id: DocumentId,
    pub workspace_id: WorkspaceId,
    pub doc_type: DocumentType,
    pub title: String,
    pub content: String,
    pub version: i32,
    pub updated_by: AgentId,
    pub updated_at: DateTime<Utc>,
}

impl WorkspaceDocument {
    pub fn new(
        workspace_id: WorkspaceId,
        doc_type: DocumentType,
        title: String,
        content: String,
        updated_by: AgentId,
    ) -> Self {
        Self {
            id: Self::generate_id(),
            workspace_id,
            doc_type,
            title,
            content,
            version: 1,
            updated_by,
            updated_at: Utc::now(),
        }
    }

    pub fn generate_id() -> DocumentId {
        format!("wsdoc_{}", ulid::Ulid::new())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContext {
    pub workspace_id: WorkspaceId,
    pub key: String,
    pub value: Value,
    pub updated_by: AgentId,
    pub updated_at: DateTime<Utc>,
}

impl WorkspaceContext {
    pub fn new(workspace_id: WorkspaceId, key: String, value: Value, updated_by: AgentId) -> Self {
        Self {
            workspace_id,
            key,
            value,
            updated_by,
            updated_at: Utc::now(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HistoryInjectionConfig {
    pub enabled: bool,
    pub max_messages: usize,
    pub message_types: Vec<String>,
    pub since_minutes: u32,
}

impl HistoryInjectionConfig {
    pub fn default_config() -> Self {
        Self {
            enabled: true,
            max_messages: 10,
            message_types: vec!["task".into(), "result".into(), "broadcast".into()],
            since_minutes: 60,
        }
    }
}
