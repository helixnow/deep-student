//! Chat V2 Tauri 命令处理器
//!
//! 提供所有 Chat V2 相关的 Tauri 命令，包括：
//! - 消息发送、取消、重试、编辑重发
//! - 会话加载、创建、更新、归档、保存
//! - 块操作（删除消息、复制块内容）
//! - OCR 识别（纯 OCR，不创建会话）
//! - 变体管理（切换、删除、重试、取消变体）
//! - 数据迁移（旧版 chat_messages 迁移到 Chat V2）
//! - 工具审批（敏感工具用户确认）
//!
//! ## 命令命名约定
//! 所有命令以 `chat_v2_` 前缀命名，以区分旧版聊天命令。
//!
//! ## 错误处理
//! 所有命令返回 `Result<T, String>`，使用 `ChatV2Error::to_string()` 格式化错误。
//!
//! ## 资源操作
//! 资源相关操作已迁移至 VFS 模块（vfs_* 命令），不再使用旧的 resource_* 命令。

pub mod approval_handlers;
pub mod ask_user_handlers; // 🆕 用户提问命令处理器
pub mod block_actions;
pub mod canvas_handlers;
pub mod group_handlers;
pub mod load_session;
pub mod manage_session;
pub mod migration;
pub mod ocr;
pub mod resource_handlers; // ⚠️ DEPRECATED: 前端已迁移到 VFS (vfs_* 命令)，resource_* 命令零引用。参见 P1-#9。
pub mod search_handlers;
pub mod send_message;
pub mod variant_handlers;
pub mod workspace_handlers;

// 重导出所有 Tauri 命令
pub use approval_handlers::{chat_v2_tool_approval_cancel, chat_v2_tool_approval_respond};
pub use ask_user_handlers::chat_v2_ask_user_respond; // 🆕 用户提问响应
pub use block_actions::{
    chat_v2_anki_cards_result, chat_v2_copy_block_content, chat_v2_delete_message,
    chat_v2_get_anki_cards_from_block_by_document_id, chat_v2_update_block_content,
    chat_v2_update_block_tool_output, chat_v2_upsert_streaming_block,
};
pub use canvas_handlers::chat_v2_canvas_edit_result;
pub use group_handlers::{
    chat_v2_create_group, chat_v2_delete_group, chat_v2_get_group, chat_v2_list_groups,
    chat_v2_move_session_to_group, chat_v2_reorder_groups, chat_v2_update_group,
};
pub use load_session::chat_v2_load_session;
pub use manage_session::{
    chat_v2_archive_session, chat_v2_branch_session, chat_v2_count_sessions,
    chat_v2_create_session, chat_v2_delete_session, chat_v2_empty_deleted_sessions,
    chat_v2_get_session, chat_v2_list_agent_sessions, chat_v2_list_sessions,
    chat_v2_restore_session, chat_v2_save_session, chat_v2_session_message_count,
    chat_v2_soft_delete_session, chat_v2_update_session_settings,
};
pub use migration::{
    chat_v2_check_migration_status, chat_v2_migrate_legacy_chat, chat_v2_rollback_migration,
};
pub use ocr::chat_v2_perform_ocr;
pub use search_handlers::{
    chat_v2_add_tag, chat_v2_get_session_tags, chat_v2_get_tags_batch, chat_v2_list_all_tags,
    chat_v2_remove_tag, chat_v2_search_content,
};
pub use send_message::{
    chat_v2_cancel_stream, chat_v2_continue_message, chat_v2_edit_and_resend,
    chat_v2_retry_message, chat_v2_send_message,
};
pub use variant_handlers::{
    chat_v2_cancel_variant, chat_v2_delete_variant, chat_v2_retry_variant, chat_v2_retry_variants,
    chat_v2_switch_variant,
};
pub use workspace_handlers::{
    workspace_cancel_agent, workspace_cancel_sleep, workspace_close, workspace_create,
    workspace_create_agent, workspace_delete, workspace_get, workspace_get_context,
    workspace_get_document, workspace_list_agents, workspace_list_all, workspace_list_documents,
    workspace_list_messages, workspace_manual_wake, workspace_restore_executions,
    workspace_run_agent, workspace_send_message, workspace_set_context,
};
