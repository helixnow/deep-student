//! Super 会话：普通 chat_v2 会话（mode=chat）+ metadata 标记。
//!
//! - 管线入口钩子 [`apply_turn_overrides`] 为活跃且启用的 Super 会话注入 Router 提示词段
//!   （[`router_stable_section`] / [`roster_volatile_section`]）与 4 个 Super 工具；
//! - Worker 复用 workspace 子代理编排，结果 / 外部事件（[`post_external_event`]）进入 Super
//!   工作区收件箱，由前端常驻控制器在会话空闲时经 `chat_v2_super_deliver_inbox` 投递为一条
//!   持久化 user 消息（带 inboundOrigin meta）并走普通发送管线；
//! - 开关与额外指令存主库 settings（`super_agent.enabled` / `super_agent.instructions`）。
//!
//! 取代旧实验性 `superagent` 模块（Router/Worker headless 双层 + superagent.db）。

pub mod commands;
pub mod inbound;
pub mod inbox;
pub mod prompt;
pub mod state;
pub mod tools_schema;

pub use crate::chat_v2::types::SuperTurn;
pub use commands::{
    chat_v2_super_deliver_inbox, super_session_ensure, super_session_get_settings,
    super_session_get_state, super_session_set_enabled, super_session_set_settings,
};
pub use inbound::{post_external_event, IncomingTrigger, IngestOutcome};
pub use inbox::{neutralize, DeliverInboxRequest, DeliverOutcome, DeliveredUserMessage};
pub use prompt::{roster_volatile_section, router_stable_section};
pub use state::{
    apply_turn_overrides, cancel_workers_dispatched_in, ensure, ensure_workspace, get_state, init,
    is_active_super_metadata, is_enabled, on_session_removed, retire_metadata, set_enabled,
    SuperSessionSettings, SuperSessionState, EVENT_SUPER_SESSION_CHANGED,
    EVENT_SUPER_SESSION_INBOX_CHANGED, SETTING_ENABLED, SETTING_INSTRUCTIONS,
};
pub use tools_schema::{super_tool_schemas, SUPER_TOOL_NAMES};

#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::Arc;

    use tempfile::TempDir;

    use crate::chat_v2::database::ChatV2Database;
    use crate::chat_v2::workspace::WorkspaceCoordinator;
    use crate::database::Database;

    /// 已应用全部 chat_v2 迁移的测试库（同 database.rs 的 setup_test_db）。
    pub(crate) fn chat_db() -> (TempDir, Arc<ChatV2Database>) {
        use crate::data_governance::migration::coordinator::MigrationCoordinator;
        use crate::data_governance::schema_registry::DatabaseId;

        let temp_dir = TempDir::new().expect("temp dir");
        let mut coordinator =
            MigrationCoordinator::new(temp_dir.path().to_path_buf()).with_audit_db(None);
        coordinator
            .migrate_single(DatabaseId::ChatV2)
            .expect("ChatV2 migrations should apply cleanly");
        let db = ChatV2Database::new(temp_dir.path()).expect("chat db");
        (temp_dir, Arc::new(db))
    }

    /// 工作区协调器（同步 workspace_index 到给定 chat 库）。
    pub(crate) fn coordinator_for(db: &Arc<ChatV2Database>) -> (TempDir, WorkspaceCoordinator) {
        let dir = TempDir::new().expect("temp dir");
        let coordinator =
            WorkspaceCoordinator::new(dir.path().to_path_buf()).with_chat_v2_db(db.clone());
        (dir, coordinator)
    }

    /// 带 settings 表的主库。
    pub(crate) fn main_db() -> (TempDir, Database) {
        let dir = TempDir::new().expect("temp dir");
        let db = Database::new(&dir.path().join("main.db")).expect("main db");
        {
            let conn = db.get_conn_safe().expect("conn");
            conn.execute(
                "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)",
                [],
            )
            .expect("settings table");
        }
        (dir, db)
    }
}
