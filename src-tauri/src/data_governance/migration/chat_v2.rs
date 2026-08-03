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

/// V20260221: 分组关联来源（pinned_resource_ids_json）
pub const V20260221_GROUP_PINNED_RESOURCES: MigrationDef = MigrationDef::new(
    20260221,
    "group_pinned_resources",
    include_str!("../../../migrations/chat_v2/V20260221__group_pinned_resources.sql"),
)
.idempotent();

/// V20260301: 内容全文检索 + 会话标签系统
pub const V20260301_CONTENT_SEARCH_AND_TAGS: MigrationDef = MigrationDef::new(
    20260301,
    "content_search_and_tags",
    include_str!("../../../migrations/chat_v2/V20260301__content_search_and_tags.sql"),
)
.with_expected_tables(&["chat_v2_content_fts", "chat_v2_session_tags"])
.with_expected_indexes(&["idx_session_tags_tag", "idx_session_tags_type"])
.idempotent();

/// V20260302: 对齐 subagent_task 结构到运行时代码约定
pub const V20260302_SUBAGENT_TASK_SCHEMA_ALIGN: MigrationDef = MigrationDef::new(
    20260302,
    "subagent_task_schema_align",
    include_str!("../../../migrations/chat_v2/V20260302__subagent_task_schema_align.sql"),
)
.with_expected_columns(&[
    ("subagent_task", "initial_task"),
    ("subagent_task", "started_at"),
    ("subagent_task", "completed_at"),
    ("subagent_task", "result_summary"),
])
.with_expected_indexes(&["idx_subagent_task_workspace"]);

/// V20260306: 添加结构化 skill_state_json
pub const V20260306_SKILL_STATE_JSON: MigrationDef = MigrationDef::new(
    20260306,
    "skill_state_json",
    include_str!("../../../migrations/chat_v2/V20260306__add_skill_state_json.sql"),
)
.with_expected_columns(&[("chat_v2_session_state", "skill_state_json")])
.idempotent();

/// V20260502: 将旧版回收站会话解释为归档会话
pub const V20260502_ARCHIVE_LEGACY_DELETED_SESSIONS: MigrationDef = MigrationDef::new(
    20260502,
    "archive_legacy_deleted_sessions",
    include_str!("../../../migrations/chat_v2/V20260502__archive_legacy_deleted_sessions.sql"),
)
.idempotent();

/// V20260510: 添加会话压缩记录与压缩标记字段
pub const V20260510_ADD_COMPACTION: MigrationDef = MigrationDef::new(
    20260510,
    "add_compaction",
    include_str!("../../../migrations/chat_v2/V20260510__add_compaction.sql"),
)
.with_expected_tables(&["chat_v2_compactions"])
.with_expected_columns(&[
    ("chat_v2_blocks", "compacted_at"),
    ("chat_v2_sessions", "last_compaction_id"),
])
.with_expected_indexes(&["idx_chat_v2_compactions_session_created"]);

/// V20260516: 为 chat_v2_sessions 添加 title_locked 字段
///
/// 用户手动改名后永久锁定标题，自动摘要 LLM 不再覆盖。
pub const V20260516_ADD_TITLE_LOCKED: MigrationDef = MigrationDef::new(
    20260516,
    "add_title_locked",
    include_str!("../../../migrations/chat_v2/V20260516__add_title_locked.sql"),
)
.with_expected_columns(&[("chat_v2_sessions", "title_locked")])
.idempotent();

/// V20260523: 为剩余 Chat V2 表添加同步字段和变更日志触发器
pub const V20260523_ADD_MISSING_SYNC_COVERAGE: MigrationDef = MigrationDef::new(
    20260523,
    "add_missing_sync_coverage",
    include_str!("../../../migrations/chat_v2/V20260523__add_missing_sync_coverage.sql"),
);

/// V20260524: 为 __change_log 增加字段增量元数据
pub const V20260524_ADD_CHANGE_LOG_FIELD_DELTAS: MigrationDef = MigrationDef::new(
    20260524,
    "add_change_log_field_deltas",
    include_str!("../../../migrations/chat_v2/V20260524__add_change_log_field_deltas.sql"),
);

/// V20260527: 添加本地工作区数据库删除队列表
pub const V20260527_ADD_WORKSPACE_DELETION_QUEUE: MigrationDef = MigrationDef::new(
    20260527,
    "add_workspace_deletion_queue",
    include_str!("../../../migrations/chat_v2/V20260527__add_workspace_deletion_queue.sql"),
)
.with_expected_tables(&["__workspace_deletion_queue"])
.with_expected_indexes(&["idx__workspace_deletion_queue_retry"])
.idempotent();

/// V20260528: 重建 resources 表并移除过时的 type CHECK 约束
pub const V20260528_RESOURCES_TYPE_CHECK_REBUILD: MigrationDef = MigrationDef::new(
    20260528,
    "resources_type_check_rebuild",
    include_str!("../../../migrations/chat_v2/V20260528__resources_type_check_rebuild.sql"),
)
.with_expected_columns(&[
    ("resources", "type"),
    ("resources", "device_id"),
    ("resources", "deleted_at"),
])
.with_expected_indexes(&[
    "idx_resources_hash",
    "idx_resources_type",
    "idx_resources_local_version",
])
.idempotent();

/// V20260711: 为会话标签补齐复合主键变更日志触发器
pub const V20260711_SESSION_TAGS_SYNC_COVERAGE: MigrationDef = MigrationDef::new(
    20260711,
    "session_tags_sync_coverage",
    include_str!("../../../migrations/chat_v2/V20260711__session_tags_sync_coverage.sql"),
)
.idempotent();

/// V20260717: 课题首选 runtime root（default_runtime_root_id + preferred_project_root_path）
pub const V20260717_GROUP_PREFERRED_RUNTIME_ROOT: MigrationDef = MigrationDef::new(
    20260717,
    "group_preferred_runtime_root",
    include_str!("../../../migrations/chat_v2/V20260717__group_preferred_runtime_root.sql"),
)
.with_expected_columns(&[
    ("chat_v2_session_groups", "default_runtime_root_id"),
    ("chat_v2_session_groups", "preferred_project_root_path"),
])
.idempotent();

/// V20260719: FTS 触发器覆盖 block_type 变更 + 会话列表复合索引
///
/// 重建 chat_v2_content_fts 的 UPDATE/DELETE 触发器（监听 content + block_type），
/// 全量重建 FTS 修复历史幽灵/漏索引，并添加 (persist_status, updated_at DESC) 复合索引。
pub const V20260719_FTS_BLOCKTYPE_COVERAGE: MigrationDef = MigrationDef::new(
    20260719,
    "fts_blocktype_coverage_and_indexes",
    include_str!("../../../migrations/chat_v2/V20260719__fts_blocktype_coverage_and_indexes.sql"),
)
.with_expected_indexes(&["idx_chat_v2_sessions_status_updated"])
.idempotent();

pub const V20260720_COMPACTION_LINEAGE_AND_SYNC: MigrationDef = MigrationDef::new(
    20260720,
    "compaction_lineage_and_sync",
    include_str!("../../../migrations/chat_v2/V20260720__compaction_lineage_and_sync.sql"),
)
.with_expected_columns(&[
    ("chat_v2_compactions", "previous_compaction_id"),
    ("chat_v2_compactions", "range_start_message_id"),
    ("chat_v2_compactions", "range_end_message_id"),
    ("chat_v2_compactions", "compacted_message_count"),
    ("chat_v2_compactions", "model_config_id"),
    ("chat_v2_compactions", "device_id"),
    ("chat_v2_compactions", "local_version"),
    ("chat_v2_compactions", "updated_at"),
    ("chat_v2_compactions", "deleted_at"),
])
.with_expected_indexes(&[
    "idx_chat_v2_compactions_previous",
    "idx_chat_v2_compactions_local_version",
    "idx_chat_v2_compactions_device_version",
    "idx_chat_v2_compactions_sync_updated_at",
    "idx_chat_v2_compactions_updated_not_deleted",
])
.idempotent();

/// V20260721: 工作区数据库删除两阶段日志。
///
/// 旧队列表继续作为仅包含 ready 项的同步 outbox；DELETE 触发器在云端发布成功、
/// drain 删除 outbox 行时把持久 journal 原子推进到 published。
pub const V20260721_WORKSPACE_DELETION_INTENT_JOURNAL: MigrationDef = MigrationDef::new(
    20260721,
    "workspace_deletion_intent_journal",
    include_str!("../../../migrations/chat_v2/V20260721__workspace_deletion_intent_journal.sql"),
)
.with_expected_tables(&["__file_deletion_journal"])
.with_expected_columns(&[
    ("__file_deletion_journal", "operation_id"),
    ("__file_deletion_journal", "target_kind"),
    ("__file_deletion_journal", "entity_key"),
    ("__file_deletion_journal", "local_path"),
    ("__file_deletion_journal", "expected_hash"),
    ("__file_deletion_journal", "state"),
    ("__file_deletion_journal", "prepared_at"),
    ("__file_deletion_journal", "ready_at"),
    ("__file_deletion_journal", "published_at"),
])
.with_expected_indexes(&[
    "idx__file_deletion_journal_recovery",
    "idx__file_deletion_journal_target",
])
.with_expected_queries(&[
    "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg__workspace_deletion_queue_published'",
])
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
    V20260221_GROUP_PINNED_RESOURCES,
    V20260301_CONTENT_SEARCH_AND_TAGS,
    V20260302_SUBAGENT_TASK_SCHEMA_ALIGN,
    V20260306_SKILL_STATE_JSON,
    V20260502_ARCHIVE_LEGACY_DELETED_SESSIONS,
    V20260510_ADD_COMPACTION,
    V20260516_ADD_TITLE_LOCKED,
    V20260523_ADD_MISSING_SYNC_COVERAGE,
    V20260524_ADD_CHANGE_LOG_FIELD_DELTAS,
    V20260527_ADD_WORKSPACE_DELETION_QUEUE,
    V20260528_RESOURCES_TYPE_CHECK_REBUILD,
    V20260711_SESSION_TAGS_SYNC_COVERAGE,
    V20260717_GROUP_PREFERRED_RUNTIME_ROOT,
    V20260719_FTS_BLOCKTYPE_COVERAGE,
    V20260720_COMPACTION_LINEAGE_AND_SYNC,
    V20260721_WORKSPACE_DELETION_INTENT_JOURNAL,
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
        assert_eq!(CHAT_V2_MIGRATION_SET.count(), 23); // V20260130 ~ V20260721
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
        assert_eq!(
            CHAT_V2_MIGRATION_SET.latest_version(),
            crate::chat_v2::database::CURRENT_SCHEMA_VERSION as i32
        );
    }

    #[test]
    fn test_v20260528_rebuild_removes_type_check_and_preserves_data() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE __change_log (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 table_name TEXT NOT NULL,
                 record_id TEXT NOT NULL,
                 operation TEXT NOT NULL,
                 field_deltas_json TEXT
             );
             CREATE TABLE resources (
                 id TEXT PRIMARY KEY,
                 hash TEXT NOT NULL UNIQUE,
                 type TEXT NOT NULL CHECK(type IN ('image','file','note','card','retrieval')),
                 source_id TEXT,
                 data TEXT,
                 metadata_json TEXT,
                 ref_count INTEGER NOT NULL DEFAULT 0,
                 created_at INTEGER NOT NULL,
                 device_id TEXT,
                 local_version INTEGER DEFAULT 0,
                 updated_at TEXT,
                 deleted_at TEXT
             );
             INSERT INTO resources (id, hash, type, data, created_at)
             VALUES ('existing', 'hash-existing', 'image', 'payload', 1);",
        )
        .unwrap();

        conn.execute_batch(V20260528_RESOURCES_TYPE_CHECK_REBUILD.sql)
            .unwrap();
        conn.execute(
            "INSERT INTO resources (id, hash, type, data, created_at)
             VALUES ('new-type', 'hash-new-type', 'folder', 'folder payload', 2)",
            [],
        )
        .expect("new ResourceType variants must no longer violate a stale CHECK constraint");

        let existing_payload: String = conn
            .query_row(
                "SELECT data FROM resources WHERE id = 'existing'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(existing_payload, "payload");

        let resources_sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'resources'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            !resources_sql.to_ascii_uppercase().contains("CHECK"),
            "rebuilt resources schema must not retain the stale type CHECK: {resources_sql}"
        );

        conn.execute_batch(V20260528_RESOURCES_TYPE_CHECK_REBUILD.sql)
            .expect("migration is marked idempotent and must be replayable");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM resources", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn test_v20260711_session_tags_emit_unambiguous_composite_keys() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE __change_log (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 table_name TEXT NOT NULL,
                 record_id TEXT NOT NULL,
                 operation TEXT NOT NULL CHECK(operation IN ('INSERT', 'UPDATE', 'DELETE'))
             );
             CREATE TABLE chat_v2_session_tags (
                 session_id TEXT NOT NULL,
                 tag TEXT NOT NULL,
                 tag_type TEXT NOT NULL DEFAULT 'auto',
                 created_at TEXT NOT NULL DEFAULT (datetime('now')),
                 PRIMARY KEY (session_id, tag)
             );",
        )
        .unwrap();

        conn.execute_batch(V20260711_SESSION_TAGS_SYNC_COVERAGE.sql)
            .unwrap();
        conn.execute_batch(V20260711_SESSION_TAGS_SYNC_COVERAGE.sql)
            .expect("migration is idempotent and must not duplicate triggers");

        conn.execute(
            "INSERT INTO chat_v2_session_tags (session_id, tag) VALUES (?1, ?2)",
            rusqlite::params!["session:one", "tag:\"quoted\""],
        )
        .unwrap();
        conn.execute(
            "UPDATE chat_v2_session_tags SET tag_type = 'manual'
             WHERE session_id = ?1 AND tag = ?2",
            rusqlite::params!["session:one", "tag:\"quoted\""],
        )
        .unwrap();
        conn.execute(
            "UPDATE chat_v2_session_tags SET tag = ?1
             WHERE session_id = ?2 AND tag = ?3",
            rusqlite::params!["renamed:tag", "session:one", "tag:\"quoted\""],
        )
        .unwrap();
        conn.execute(
            "DELETE FROM chat_v2_session_tags WHERE session_id = ?1 AND tag = ?2",
            rusqlite::params!["session:one", "renamed:tag"],
        )
        .unwrap();

        let mut stmt = conn
            .prepare(
                "SELECT operation, record_id FROM __change_log
                 WHERE table_name = 'chat_v2_session_tags' ORDER BY id",
            )
            .unwrap();
        let changes: Vec<(String, serde_json::Value)> = stmt
            .query_map([], |row| {
                let operation: String = row.get(0)?;
                let record_id: String = row.get(1)?;
                Ok((operation, record_id))
            })
            .unwrap()
            .map(|row| {
                let (operation, record_id) = row.unwrap();
                (operation, serde_json::from_str(&record_id).unwrap())
            })
            .collect();

        assert_eq!(changes.len(), 5);
        assert_eq!(changes[0].0, "INSERT");
        assert_eq!(changes[1].0, "UPDATE");
        assert_eq!(changes[2].0, "DELETE");
        assert_eq!(changes[3].0, "INSERT");
        assert_eq!(changes[4].0, "DELETE");
        assert_eq!(
            changes[0].1,
            serde_json::json!({"session_id": "session:one", "tag": "tag:\"quoted\""})
        );
        assert_eq!(changes[1].1, changes[0].1);
        assert_eq!(changes[2].1, changes[0].1);
        assert_eq!(
            changes[3].1,
            serde_json::json!({"session_id": "session:one", "tag": "renamed:tag"})
        );
        assert_eq!(changes[4].1, changes[3].1);
    }

    #[test]
    fn test_pending_migrations() {
        let expected_versions = vec![
            20260130, 20260131, 20260201, 20260202, 20260203, 20260204, 20260207, 20260221,
            20260301, 20260302, 20260306, 20260502, 20260510, 20260516, 20260523, 20260524,
            20260527, 20260528, 20260711, 20260717, 20260719, 20260720, 20260721,
        ];
        let actual_versions: Vec<_> = CHAT_V2_MIGRATION_SET
            .pending(0)
            .map(|migration| migration.refinery_version)
            .collect();

        assert_eq!(actual_versions, expected_versions);
        for (index, version) in expected_versions.iter().enumerate() {
            let remaining: Vec<_> = CHAT_V2_MIGRATION_SET.pending(*version).collect();
            assert_eq!(remaining.len(), expected_versions.len() - index - 1);
        }
        assert_eq!(CHAT_V2_MIGRATION_SET.pending(20260721).count(), 0);
    }

    #[test]
    fn test_get_compaction_migration() {
        let migration = CHAT_V2_MIGRATION_SET
            .get(20260510)
            .expect("V20260510 should exist");
        assert_eq!(migration.name, "add_compaction");
    }
}
