//! Chat V2 工作区模块 - 多 Agent 协作共享空间

pub mod config;
pub mod coordinator;
pub mod database;
pub mod emitter;
pub mod inbox;
pub mod injector;
pub mod repo;
pub mod router;
pub mod skills;
pub mod sleep_manager;
pub mod subagent_task;
pub mod types;

pub use types::{
    AgentId, AgentRole, AgentStatus, DocumentId, DocumentType, HistoryInjectionConfig, InboxItem,
    InboxStatus, MessageId, MessageStatus, MessageType, Workspace, WorkspaceAgent,
    WorkspaceContext, WorkspaceDocument, WorkspaceId, WorkspaceMessage, WorkspaceStatus,
};

pub use config::{
    DEFAULT_HISTORY_INJECTION_COUNT, INJECTION_COOLDOWN_MS, MAX_AGENTS_PER_WORKSPACE,
    MAX_AGENT_RETRY_ATTEMPTS, MAX_INBOX_SIZE, MAX_MESSAGES_PER_INJECTION,
};
pub use coordinator::WorkspaceCoordinator;
pub use database::{WorkspaceDatabase, WorkspaceDatabaseManager, WorkspaceDatabasePool};
pub use emitter::{workspace_events, WorkspaceEventEmitter};
pub use inbox::InboxManager;
pub use injector::{InjectionResult, WorkspaceInjector};
pub use repo::WorkspaceRepo;
pub use router::MessageRouter;
pub use skills::{get_skill, get_skill_recommended_models, list_skills, WorkspaceSkill};
pub use sleep_manager::{
    SleepBlockData, SleepError, SleepManager, SleepStatus, WakeCondition, WakeReason, WakeUpPayload,
};
pub use subagent_task::{
    SubagentTaskData, SubagentTaskError, SubagentTaskManager, SubagentTaskStatus,
};
