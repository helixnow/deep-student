//! Chat V2 - 新版聊天后端模块
//!
//! 基于 Block 的消息架构，支持流式事件驱动的聊天体验。
//!
//! ## 模块结构
//! - `database`: 独立数据库管理（chat_v2.db）
//! - `error`: 统一错误处理
//! - `events`: 块级和会话级事件发射系统
//! - `handlers`: Tauri 命令处理器
//! - `state`: 全局状态管理
//! - `types`: 核心类型定义
//! - `adapters`: 外部服务适配器（待完善）
//! - `repo`: 数据存取层
//! - `pipeline`: 编排引擎（待实现）

pub mod adapters;
pub mod approval_manager; // 🆕 工具审批管理器（文档 29 P1-3）
pub(crate) mod context; // PipelineContext 拆分
pub mod database;
pub mod error;
pub mod events;
pub mod handlers;
pub mod migration; // 旧版数据迁移模块
pub mod pipeline;
pub mod prompt_builder;
pub mod repo;
pub mod resource_repo; // ⚠️ DEPRECATED: 资源存储已迁移到 VFS (vfs.db)，由 vfs/repos/resource_repo.rs 替代。参见 P1-#9。
pub mod resource_types; // 统一上下文注入系统 - 资源类型定义（类型仍被 pipeline/context 使用，暂不废弃）
pub mod skills; // 🆕 Skills 文件系统处理器
pub mod state;
pub mod tools;
pub mod types;
pub mod user_message_builder; // 用户消息统一构建模块
pub mod variant_context;
pub mod vfs_resolver;
pub mod workspace; // VFS 解引用模块 - 统一处理首次发送和历史加载的资源解引用

// 测试模块（仅在测试时编译）
#[cfg(test)]
mod pipeline_tests;

// 重导出错误类型
pub use error::{ChatV2Error, ChatV2Result};

// 重导出数据库类型
pub use database::{
    ChatV2Database, ChatV2DatabaseStats, ChatV2Pool, ChatV2PooledConnection, CURRENT_SCHEMA_VERSION,
};

// 重导出数据存取层
pub use repo::ChatV2Repo;

// 重导出事件类型
pub use events::{event_phase, event_types, session_event_type};
pub use events::{BackendEvent, ChatV2EventEmitter, SessionEvent};

// 重导出状态类型
pub use state::{ChatV2State, StreamGuard};

// 重导出核心类型
pub use types::{
    // 常量模块
    block_status,
    block_types,
    // Feature Flags
    feature_flags,
    variant_status,
    // 附件相关
    AttachmentInput,
    AttachmentMeta,
    // 消息相关
    ChatMessage,
    // 会话状态
    ChatParams,
    // 会话相关
    ChatSession,
    // 块相关
    Citation,
    // 多变体相关
    DeleteVariantResult,
    // 请求/响应
    LoadSessionResponse,
    MessageBlock,
    MessageMeta,
    MessageRole,
    MessageSources,
    PanelStates,
    PersistStatus,
    SendMessageRequest,
    SendOptions,
    SessionSettings,
    SessionState,
    SharedContext,
    SourceInfo,
    // Token 统计相关
    TokenSource,
    TokenUsage,
    ToolResultInfo,
    Variant,
};

// 重导出变体执行上下文
pub use variant_context::{ParallelExecutionManager, VariantExecutionContext};

pub use workspace::{
    AgentRole, AgentStatus, DocumentType, InjectionResult, MessageStatus as WorkspaceMessageStatus,
    MessageType, Workspace, WorkspaceAgent, WorkspaceContext, WorkspaceCoordinator,
    WorkspaceDatabase, WorkspaceDocument, WorkspaceInjector, WorkspaceMessage, WorkspaceRepo,
    WorkspaceStatus,
};

// 重导出资源库类型（统一上下文注入系统）
// NOTE: 这些类型仍被 pipeline/context/user_message_builder 等模块使用，暂不废弃。
// resource_repo 和 resource_handlers 已废弃，参见 P1-#9。
pub use resource_types::{
    // 资源相关
    ContentBlock,
    ContextRef,
    ContextSnapshot,
    CreateResourceParams,
    CreateResourceResult,
    Resource,
    ResourceMetadata,
    ResourceType,
    SendContextRef,
};

// 重导出用户消息构建器（统一用户消息处理）
pub use user_message_builder::{
    build_user_message, convert_attachment_input_to_meta, extract_user_refs_snapshot,
    UserMessageParams, UserMessageResult,
};

// 重导出 Skills 命令
pub use skills::{skill_list_directories, skill_read_file};

// 重导出 Tauri 命令
pub use handlers::{
    chat_v2_archive_session,
    chat_v2_cancel_stream,
    chat_v2_cancel_variant,
    // 数据迁移命令
    chat_v2_check_migration_status,
    chat_v2_copy_block_content,
    chat_v2_count_sessions,
    chat_v2_create_session,
    chat_v2_delete_message,
    chat_v2_delete_session,
    chat_v2_delete_variant,
    chat_v2_edit_and_resend,
    chat_v2_empty_deleted_sessions,
    chat_v2_list_sessions,
    chat_v2_load_session,
    chat_v2_migrate_legacy_chat,
    chat_v2_perform_ocr,
    chat_v2_retry_message,
    chat_v2_retry_variant,
    chat_v2_retry_variants,
    chat_v2_rollback_migration,
    // 资源库命令已迁移至 VFS 模块（vfs_* 命令）
    chat_v2_save_session,
    chat_v2_send_message,
    // 变体管理命令
    chat_v2_switch_variant,
    chat_v2_update_block_content,
    chat_v2_update_session_settings,
    chat_v2_upsert_streaming_block,
};

// ============================================================================
// 统一初始化函数
// ============================================================================

use std::path::Path;

/// Chat V2 统一初始化函数
///
/// 创建 Chat V2 数据库并执行 schema 迁移。
/// 这是 Chat V2 模块的唯一入口点。
///
/// ## 初始化流程
/// 1. 创建 `chat_v2.db` 数据库文件
/// 2. 执行 schema 迁移（如有更新）
/// 3. 返回 ChatV2Database
///
/// ## 参数
/// - `app_data_dir`: 应用数据目录路径
///
/// ## 返回
/// - `Ok(ChatV2Database)`: 初始化成功
/// - `Err(ChatV2Error)`: 初始化失败
pub fn init_chat_v2(app_data_dir: &Path) -> ChatV2Result<ChatV2Database> {
    tracing::info!(
        "[ChatV2] 开始统一初始化, 数据目录: {}",
        app_data_dir.display()
    );

    // 创建数据库（内部执行 schema 迁移）
    let db = ChatV2Database::new(app_data_dir)?;

    // 🔧 A1修复：启动时清理历史遗留的孤儿用户消息 content block
    // 之前 build_user_message 每次生成随机 block_id，多次 save 导致 DB 积累重复块
    match repo::ChatV2Repo::cleanup_orphan_user_content_blocks(&db) {
        Ok(count) => {
            if count > 0 {
                tracing::info!(
                    "[ChatV2] Startup cleanup: removed {} orphan user content blocks",
                    count
                );
            }
        }
        Err(e) => {
            tracing::warn!("[ChatV2] Startup cleanup failed (non-fatal): {}", e);
        }
    }

    tracing::info!("[ChatV2] 统一初始化完成: {}", db.db_path().display());

    Ok(db)
}
