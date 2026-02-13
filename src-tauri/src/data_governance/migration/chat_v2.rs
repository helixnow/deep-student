//! # Chat V2 数据库迁移定义
//!
//! 聊天系统 V2 的数据库迁移配置。
//!
//! ## 表清单
//!
//! | 表名 | 说明 |
//! |-----|------|
//! | chat_v2_sessions | 会话表 |
//! | chat_v2_messages | 消息表 |
//! | chat_v2_blocks | 块表 |
//! | chat_v2_attachments | 附件表 |
//! | chat_v2_session_state | 会话状态表 |
//! | chat_v2_session_mistakes | 会话-错题关联表 |
//! | resources | 资源库表 |
//! | chat_v2_todo_lists | TodoList 状态表 |
//! | workspace_index | 工作区索引表 |
//! | sleep_block | 睡眠块表 |
//! | subagent_task | 子代理任务表 |

use super::definitions::{MigrationDef, MigrationSet};

// ============================================================================
// V001: 初始化迁移
// ============================================================================

/// V001 预期的表（11 个）
const V001_EXPECTED_TABLES: &[&str] = &[
    "chat_v2_sessions",
    "chat_v2_messages",
    "chat_v2_blocks",
    "chat_v2_attachments",
    "chat_v2_session_state",
    "chat_v2_session_mistakes",
    "resources",
    "chat_v2_todo_lists",
    "workspace_index",
    "sleep_block",
    "subagent_task",
];

/// V001 预期的索引（38 个）
const V001_EXPECTED_INDEXES: &[&str] = &[
    // sessions 表索引 (5)
    "idx_chat_v2_sessions_mode",
    "idx_chat_v2_sessions_persist_status",
    "idx_chat_v2_sessions_created_at",
    "idx_chat_v2_sessions_updated_at",
    "idx_sessions_workspace",
    // messages 表索引 (7)
    "idx_chat_v2_messages_session_id",
    "idx_chat_v2_messages_timestamp",
    "idx_chat_v2_messages_role",
    "idx_chat_v2_messages_parent_id",
    "idx_chat_v2_messages_active_variant_id",
    "idx_chat_v2_messages_session_timestamp",
    "idx_chat_v2_messages_session_id_id",
    // blocks 表索引 (6)
    "idx_chat_v2_blocks_message_id",
    "idx_chat_v2_blocks_block_type",
    "idx_chat_v2_blocks_status",
    "idx_chat_v2_blocks_order",
    "idx_chat_v2_blocks_variant_id",
    "idx_chat_v2_blocks_first_chunk_at",
    // attachments 表索引 (4)
    "idx_chat_v2_attachments_message_id",
    "idx_chat_v2_attachments_type",
    "idx_chat_v2_attachments_status",
    "idx_chat_v2_attachments_block_id",
    // session_mistakes 表索引 (2)
    "idx_chat_v2_session_mistakes_mistake",
    "idx_chat_v2_session_mistakes_type",
    // resources 表索引 (5)
    "idx_resources_hash",
    "idx_resources_source_id",
    "idx_resources_type",
    "idx_resources_ref_count",
    "idx_resources_created_at",
    // todo_lists 表索引 (2)
    "idx_chat_v2_todo_lists_message_id",
    "idx_chat_v2_todo_lists_is_all_done",
    // workspace_index 表索引 (2)
    "idx_workspace_index_status",
    "idx_workspace_index_creator",
    // sleep_block 表索引 (3)
    "idx_sleep_block_status",
    "idx_sleep_block_workspace",
    "idx_sleep_block_coordinator",
    // subagent_task 表索引 (2)
    "idx_subagent_task_status",
    "idx_subagent_task_recovery",
];

/// V001 预期的关键列（用于验证表结构完整性）
const V001_EXPECTED_COLUMNS: &[(&str, &str)] = &[
    // chat_v2_sessions 核心字段
    ("chat_v2_sessions", "id"),
    ("chat_v2_sessions", "mode"),
    ("chat_v2_sessions", "persist_status"),
    ("chat_v2_sessions", "workspace_id"),
    // chat_v2_messages 核心字段
    ("chat_v2_messages", "id"),
    ("chat_v2_messages", "session_id"),
    ("chat_v2_messages", "role"),
    ("chat_v2_messages", "active_variant_id"),
    ("chat_v2_messages", "variants_json"),
    // chat_v2_blocks 核心字段
    ("chat_v2_blocks", "id"),
    ("chat_v2_blocks", "message_id"),
    ("chat_v2_blocks", "block_type"),
    ("chat_v2_blocks", "variant_id"),
    ("chat_v2_blocks", "first_chunk_at"),
    // chat_v2_attachments 核心字段
    ("chat_v2_attachments", "id"),
    ("chat_v2_attachments", "message_id"),
    ("chat_v2_attachments", "block_id"),
    // chat_v2_session_state 核心字段
    ("chat_v2_session_state", "session_id"),
    ("chat_v2_session_state", "model_id"),
    ("chat_v2_session_state", "loaded_skill_ids_json"),
    ("chat_v2_session_state", "active_skill_id"),
    // chat_v2_session_mistakes 核心字段
    ("chat_v2_session_mistakes", "session_id"),
    ("chat_v2_session_mistakes", "mistake_id"),
    // resources 核心字段
    ("resources", "id"),
    ("resources", "hash"),
    ("resources", "type"),
    // chat_v2_todo_lists 核心字段
    ("chat_v2_todo_lists", "session_id"),
    ("chat_v2_todo_lists", "todo_list_id"),
    // workspace_index 核心字段
    ("workspace_index", "workspace_id"),
    ("workspace_index", "creator_session_id"),
    // sleep_block 核心字段
    ("sleep_block", "id"),
    ("sleep_block", "workspace_id"),
    ("sleep_block", "coordinator_session_id"),
    // subagent_task 核心字段
    ("subagent_task", "id"),
    ("subagent_task", "workspace_id"),
    ("subagent_task", "agent_session_id"),
];

// ============================================================================
// 迁移定义
// ============================================================================

/// V20260130: Chat V2 初始化迁移
///
/// Refinery 文件: V20260130__init.sql -> refinery_version = 20260130
pub const V20260130_INIT: MigrationDef = MigrationDef::new(
    20260130,
    "init",
    include_str!("../../../migrations/chat_v2/V20260130__init.sql"),
)
.with_expected_tables(V001_EXPECTED_TABLES)
.with_expected_columns(V001_EXPECTED_COLUMNS)
.with_expected_indexes(V001_EXPECTED_INDEXES)
.idempotent(); // 使用 IF NOT EXISTS，可重复执行

/// V20260131: 添加变更日志表
///
/// Refinery 文件: V20260131__add_change_log.sql -> refinery_version = 20260131
pub const V20260131_CHANGE_LOG: MigrationDef = MigrationDef::new(
    20260131,
    "add_change_log",
    include_str!("../../../migrations/chat_v2/V20260131__add_change_log.sql"),
)
.with_expected_tables(&["__change_log"])
.idempotent();

/// V20260201: 添加云同步字段
///
/// 为核心业务表添加同步所需字段：device_id, local_version, updated_at, deleted_at
/// 目标表：chat_v2_sessions, chat_v2_messages, chat_v2_blocks
///
/// Refinery 文件: V20260201_001__add_sync_fields.sql -> refinery_version = 20260201
pub const V20260201_SYNC_FIELDS: MigrationDef = MigrationDef::new(
    20260201,
    "add_sync_fields",
    include_str!("../../../migrations/chat_v2/V20260201__add_sync_fields.sql"),
)
.with_expected_indexes(CHAT_V2_V20260201_SYNC_INDEXES)
.idempotent();

/// V20260201 同步字段索引
const CHAT_V2_V20260201_SYNC_INDEXES: &[&str] = &[
    // chat_v2_sessions 表同步索引
    "idx_chat_v2_sessions_local_version",
    "idx_chat_v2_sessions_deleted_at",
    "idx_chat_v2_sessions_device_id",
    "idx_chat_v2_sessions_sync_updated_at",
    "idx_chat_v2_sessions_device_version",
    "idx_chat_v2_sessions_updated_not_deleted",
    // chat_v2_messages 表同步索引
    "idx_chat_v2_messages_local_version",
    "idx_chat_v2_messages_deleted_at",
    "idx_chat_v2_messages_device_id",
    "idx_chat_v2_messages_sync_updated_at",
    "idx_chat_v2_messages_device_version",
    "idx_chat_v2_messages_updated_not_deleted",
    // chat_v2_blocks 表同步索引
    "idx_chat_v2_blocks_local_version",
    "idx_chat_v2_blocks_deleted_at",
    "idx_chat_v2_blocks_device_id",
    "idx_chat_v2_blocks_sync_updated_at",
    "idx_chat_v2_blocks_device_version",
    "idx_chat_v2_blocks_updated_not_deleted",
];

/// V20260202: Schema 修复迁移
///
/// 确保从旧版本升级的数据库具有与新数据库相同的结构。
/// 特别是 sleep_block 表用于工作区协作功能。
pub const V20260202_SCHEMA_REPAIR: MigrationDef = MigrationDef::new(
    20260202,
    "schema_repair",
    include_str!("../../../migrations/chat_v2/V20260202__schema_repair.sql"),
)
.with_expected_tables(&["sleep_block"])
.with_expected_indexes(&[
    "idx_sleep_block_status",
    "idx_sleep_block_workspace",
    "idx_sleep_block_coordinator",
])
.idempotent();

/// V20260203: 补齐子代理任务表
pub const V20260203_ENSURE_SUBAGENT_TASK: MigrationDef = MigrationDef::new(
    20260203,
    "ensure_subagent_task",
    include_str!("../../../migrations/chat_v2/V20260203__ensure_subagent_task.sql"),
)
.with_expected_tables(&["subagent_task"])
.with_expected_indexes(&["idx_subagent_task_status", "idx_subagent_task_recovery"])
.idempotent();

/// V20260204: 会话分组
pub const V20260204_SESSION_GROUPS: MigrationDef = MigrationDef::new(
    20260204,
    "session_groups",
    include_str!("../../../migrations/chat_v2/V20260204__session_groups.sql"),
)
.with_expected_tables(&["chat_v2_session_groups"])
.with_expected_indexes(&[
    "idx_chat_v2_session_groups_sort_order",
    "idx_chat_v2_session_groups_status",
    "idx_chat_v2_session_groups_workspace",
    "idx_chat_v2_sessions_group_id",
])
.idempotent();

/// V20260207: 添加 active_skill_ids_json
pub const V20260207_ACTIVE_SKILL_IDS: MigrationDef = MigrationDef::new(
    20260207,
    "active_skill_ids_json",
    include_str!("../../../migrations/chat_v2/V20260207__add_active_skill_ids_json.sql"),
)
.idempotent();

/// Chat V2 数据库迁移定义列表
pub const CHAT_V2_MIGRATIONS: &[MigrationDef] = &[
    V20260130_INIT,
    V20260131_CHANGE_LOG,
    V20260201_SYNC_FIELDS,
    V20260202_SCHEMA_REPAIR,
    V20260203_ENSURE_SUBAGENT_TASK,
    V20260204_SESSION_GROUPS,
    V20260207_ACTIVE_SKILL_IDS,
];

/// Chat V2 数据库迁移集合
pub const CHAT_V2_MIGRATION_SET: MigrationSet = MigrationSet {
    database_name: "chat_v2",
    migrations: CHAT_V2_MIGRATIONS,
};

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_migration_set_structure() {
        assert_eq!(CHAT_V2_MIGRATION_SET.database_name, "chat_v2");
        assert_eq!(CHAT_V2_MIGRATION_SET.count(), 7); // V20260130 + V20260131 + V20260201 + V20260202 + V20260203 + V20260204 + V20260207
    }

    #[test]
    fn test_v20260130_migration() {
        let migration = CHAT_V2_MIGRATION_SET
            .get(20260130)
            .expect("V20260130 should exist");
        assert_eq!(migration.name, "init");
        assert_eq!(migration.expected_tables.len(), 11);
        assert_eq!(migration.expected_indexes.len(), 38);
        assert!(migration.idempotent);
    }

    #[test]
    fn test_expected_tables_count() {
        assert_eq!(V001_EXPECTED_TABLES.len(), 11);
    }

    #[test]
    fn test_expected_indexes_count() {
        // 5 + 7 + 6 + 4 + 2 + 5 + 2 + 2 + 3 + 2 = 38
        assert_eq!(V001_EXPECTED_INDEXES.len(), 38);
    }

    #[test]
    fn test_latest_version() {
        assert_eq!(CHAT_V2_MIGRATION_SET.latest_version(), 20260207);
    }

    #[test]
    fn test_pending_migrations() {
        // 从版本 0 开始，应该有 7 个待执行
        let pending: Vec<_> = CHAT_V2_MIGRATION_SET.pending(0).collect();
        assert_eq!(pending.len(), 7);

        // 从版本 20260130 开始，应该有 6 个待执行
        let pending: Vec<_> = CHAT_V2_MIGRATION_SET.pending(20260130).collect();
        assert_eq!(pending.len(), 6);

        // 从版本 20260131 开始，应该有 5 个待执行
        let pending: Vec<_> = CHAT_V2_MIGRATION_SET.pending(20260131).collect();
        assert_eq!(pending.len(), 5);

        // 从版本 20260201 开始，应该有 4 个待执行
        let pending: Vec<_> = CHAT_V2_MIGRATION_SET.pending(20260201).collect();
        assert_eq!(pending.len(), 4);

        // 从版本 20260202 开始，应该有 3 个待执行
        let pending: Vec<_> = CHAT_V2_MIGRATION_SET.pending(20260202).collect();
        assert_eq!(pending.len(), 3);

        // 从版本 20260203 开始，应该有 2 个待执行
        let pending: Vec<_> = CHAT_V2_MIGRATION_SET.pending(20260203).collect();
        assert_eq!(pending.len(), 2);

        // 从版本 20260204 开始，应该有 1 个待执行
        let pending: Vec<_> = CHAT_V2_MIGRATION_SET.pending(20260204).collect();
        assert_eq!(pending.len(), 1);

        // 从版本 20260207 开始，应该没有待执行
        let pending: Vec<_> = CHAT_V2_MIGRATION_SET.pending(20260207).collect();
        assert_eq!(pending.len(), 0);
    }
}
