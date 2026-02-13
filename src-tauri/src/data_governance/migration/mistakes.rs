//! # Mistakes Database Migration Definitions
//!
//! 主数据库（历史命名为 mistakes）的迁移定义，包含完整的验证配置。
//!
//! ## 表结构概览
//!
//! - 核心表：mistakes, chat_messages, temp_sessions
//! - 回顾分析：review_analyses, review_chat_messages, review_sessions, review_session_mistakes
//! - 配置表：settings, rag_configurations
//! - Anki卡片：document_tasks, anki_cards, custom_anki_templates, document_control_states
//! - 向量搜索：vectorized_data, rag_sub_libraries, search_logs
//! - 试卷：exam_sheet_sessions
//! - 迁移追踪：migration_progress

use super::definitions::{MigrationDef, MigrationSet};

// ============================================================================
// V001: Initial Schema (完整初始化)
// ============================================================================

/// V20260130 迁移定义 - 完整初始化 Schema
///
/// 包含 18 个表，19 个索引，1 个触发器
///
/// Refinery 文件: V20260130__init.sql -> refinery_version = 20260130
pub const V20260130_INIT: MigrationDef = MigrationDef::new(
    20260130,
    "init",
    include_str!("../../../migrations/mistakes/V20260130__init.sql"),
)
.with_expected_tables(V001_EXPECTED_TABLES)
.with_expected_columns(KEY_COLUMNS_VERIFICATION)
.with_expected_indexes(V001_EXPECTED_INDEXES)
.with_expected_queries(V001_SMOKE_QUERIES)
.idempotent();

/// V20260131 迁移定义 - 添加变更日志表
///
/// Refinery 文件: V20260131__add_change_log.sql -> refinery_version = 20260131
pub const V20260131_CHANGE_LOG: MigrationDef = MigrationDef::new(
    20260131,
    "add_change_log",
    include_str!("../../../migrations/mistakes/V20260131__add_change_log.sql"),
)
.with_expected_tables(&["__change_log"])
.idempotent();

/// V20260201: 添加云同步字段
///
/// 为核心业务表添加同步所需字段：device_id, local_version, updated_at, deleted_at
/// 目标表：mistakes, anki_cards, review_analyses
///
/// Refinery 文件: V20260201_001__add_sync_fields.sql -> refinery_version = 20260201
pub const V20260201_SYNC_FIELDS: MigrationDef = MigrationDef::new(
    20260201,
    "add_sync_fields",
    include_str!("../../../migrations/mistakes/V20260201__add_sync_fields.sql"),
)
.with_expected_indexes(MISTAKES_V20260201_SYNC_INDEXES)
.idempotent();

/// V20260207: 添加 Anki 模板预览字段
pub const V20260207_TEMPLATE_PREVIEW_DATA: MigrationDef = MigrationDef::new(
    20260207,
    "add_template_preview_data",
    include_str!("../../../migrations/mistakes/V20260207__add_template_preview_data.sql"),
)
.idempotent();

/// V20260208: 添加高频查询索引
pub const V20260208_HOT_QUERY_INDEXES: MigrationDef = MigrationDef::new(
    20260208,
    "add_hot_query_indexes",
    include_str!("../../../migrations/mistakes/V20260208__add_hot_query_indexes.sql"),
)
.with_expected_indexes(MISTAKES_V20260208_HOT_INDEXES)
.idempotent();

/// V20260209: Anki 卡片去重索引
pub const V20260209_ANKI_CARD_DEDUP_UNIQUE: MigrationDef = MigrationDef::new(
    20260209,
    "anki_card_dedup_unique",
    include_str!("../../../migrations/mistakes/V20260209__anki_card_dedup_unique.sql"),
)
.with_expected_indexes(MISTAKES_V20260209_DEDUP_INDEXES)
.idempotent();

/// V20260201 同步字段索引
const MISTAKES_V20260201_SYNC_INDEXES: &[&str] = &[
    // mistakes 表同步索引
    "idx_mistakes_local_version",
    "idx_mistakes_deleted_at",
    "idx_mistakes_device_id",
    "idx_mistakes_updated_at",
    "idx_mistakes_device_version",
    "idx_mistakes_updated_not_deleted",
    // anki_cards 表同步索引
    "idx_anki_cards_local_version",
    "idx_anki_cards_deleted_at",
    "idx_anki_cards_device_id",
    "idx_anki_cards_updated_at",
    "idx_anki_cards_device_version",
    "idx_anki_cards_updated_not_deleted",
    // review_analyses 表同步索引
    "idx_review_analyses_local_version",
    "idx_review_analyses_deleted_at",
    "idx_review_analyses_device_id",
    "idx_review_analyses_updated_at",
    "idx_review_analyses_device_version",
    "idx_review_analyses_updated_not_deleted",
];

/// V20260208 高频查询索引
const MISTAKES_V20260208_HOT_INDEXES: &[&str] = &[
    "idx_document_tasks_updated_at",
    "idx_document_tasks_document_segment",
    "idx_anki_cards_created_at",
    "idx_anki_cards_template_id",
    "idx_anki_cards_task_order",
];

/// V20260209 Anki 卡片去重索引
const MISTAKES_V20260209_DEDUP_INDEXES: &[&str] = &["idx_anki_cards_dedup_unique"];

/// V001 预期表列表 (18 tables)
const V001_EXPECTED_TABLES: &[&str] = &[
    // Core Tables
    "mistakes",
    "chat_messages",
    "temp_sessions",
    // Review Analysis Tables
    "review_analyses",
    "review_chat_messages",
    "review_sessions",
    "review_session_mistakes",
    // Settings & Configuration Tables
    "settings",
    "rag_configurations",
    // Anki Card Generation Tables
    "document_tasks",
    "anki_cards",
    "custom_anki_templates",
    "document_control_states",
    // Vector & Search Tables
    "vectorized_data",
    "rag_sub_libraries",
    "search_logs",
    // Exam Sheet Tables
    "exam_sheet_sessions",
    // Migration Progress Table
    "migration_progress",
];

/// V001 预期索引列表 (19 indexes)
const V001_EXPECTED_INDEXES: &[&str] = &[
    // Mistakes indexes
    "idx_mistakes_irec_card_id",
    // Chat messages indexes
    "idx_chat_turn_id",
    "idx_chat_turn_pair",
    // Document tasks indexes
    "idx_document_tasks_document_id",
    "idx_document_tasks_status",
    // Anki cards indexes
    "idx_anki_cards_task_id",
    "idx_anki_cards_is_error_card",
    "idx_anki_cards_source",
    "idx_anki_cards_text",
    // Custom Anki templates indexes
    "idx_custom_anki_templates_is_active",
    "idx_custom_anki_templates_is_built_in",
    // Document control states indexes
    "idx_document_control_states_state",
    "idx_document_control_states_updated_at",
    // Vectorized data indexes
    "idx_vectorized_data_mistake_id",
    // Review session mistakes indexes
    "idx_review_session_mistakes_session_id",
    "idx_review_session_mistakes_mistake_id",
    // Search logs indexes
    "idx_search_logs_created_at",
    "idx_search_logs_search_type",
    // Exam sheet sessions indexes
    "idx_exam_sheet_sessions_status",
];

/// V001 关键查询 smoke test
///
/// 这些查询对应运行时关键路径，确保表结构不仅存在，而且可被真实查询使用。
const V001_SMOKE_QUERIES: &[&str] = &[
    "SELECT id, mistake_summary, user_error_analysis FROM mistakes LIMIT 1",
    "SELECT id, graph_sources, turn_id, turn_seq, reply_to_msg_id, message_kind, lifecycle, metadata FROM chat_messages LIMIT 1",
    "SELECT id, web_search_sources, tool_call, tool_result, overrides, relations FROM review_chat_messages LIMIT 1",
    "SELECT id FROM review_sessions LIMIT 1",
    "SELECT id, text FROM anki_cards LIMIT 1",
];

// ============================================================================
// Migration Set
// ============================================================================

/// Mistakes 数据库迁移集合
pub const MISTAKES_MIGRATIONS: MigrationSet = MigrationSet {
    database_name: "mistakes",
    migrations: &[
        V20260130_INIT,
        V20260131_CHANGE_LOG,
        V20260201_SYNC_FIELDS,
        V20260207_TEMPLATE_PREVIEW_DATA,
        V20260208_HOT_QUERY_INDEXES,
        V20260209_ANKI_CARD_DEDUP_UNIQUE,
    ],
};

// ============================================================================
// Key Column Verification (可选的详细列验证)
// ============================================================================

/// 关键列验证配置 - 用于验证核心表的关键字段
///
/// 格式: (table_name, column_name)
pub const KEY_COLUMNS_VERIFICATION: &[(&str, &str)] = &[
    // mistakes 表关键列
    ("mistakes", "id"),
    ("mistakes", "created_at"),
    ("mistakes", "question_images"),
    ("mistakes", "status"),
    ("mistakes", "irec_card_id"),
    ("mistakes", "irec_status"),
    // chat_messages 表关键列
    ("chat_messages", "id"),
    ("chat_messages", "mistake_id"),
    ("chat_messages", "role"),
    ("chat_messages", "content"),
    ("chat_messages", "turn_id"),
    ("chat_messages", "stable_id"),
    // review_analyses 表关键列
    ("review_analyses", "id"),
    ("review_analyses", "mistake_ids"),
    ("review_analyses", "status"),
    // anki_cards 表关键列
    ("anki_cards", "id"),
    ("anki_cards", "task_id"),
    ("anki_cards", "front"),
    ("anki_cards", "back"),
    ("anki_cards", "text"),
    ("anki_cards", "source_type"),
    ("anki_cards", "source_id"),
    // document_tasks 表关键列
    ("document_tasks", "id"),
    ("document_tasks", "document_id"),
    ("document_tasks", "status"),
];

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_migration_set_structure() {
        assert_eq!(MISTAKES_MIGRATIONS.database_name, "mistakes");
        assert!(
            MISTAKES_MIGRATIONS.count() >= 4,
            "Should have at least 4 migrations"
        );
    }

    #[test]
    fn test_v20260130_migration() {
        let migration = MISTAKES_MIGRATIONS
            .get(20260130)
            .expect("V20260130 should exist");
        assert_eq!(migration.refinery_version, 20260130);
        assert_eq!(migration.name, "init");
        assert!(migration.idempotent);
        assert!(
            migration.expected_columns.contains(&("anki_cards", "text")),
            "V20260130 must verify anki_cards.text column"
        );
        assert!(
            migration
                .expected_queries
                .iter()
                .any(|q| q.contains("SELECT id, text FROM anki_cards")),
            "V20260130 must include anki_cards smoke query"
        );
    }

    #[test]
    fn test_expected_tables_count() {
        assert_eq!(V001_EXPECTED_TABLES.len(), 18, "Expected 18 tables");
    }

    #[test]
    fn test_expected_indexes_count() {
        assert_eq!(V001_EXPECTED_INDEXES.len(), 19, "Expected 19 indexes");
    }

    #[test]
    fn test_sql_content_not_empty() {
        assert!(
            !V20260130_INIT.sql.is_empty(),
            "SQL content should not be empty"
        );
        assert!(
            V20260130_INIT.sql.contains("CREATE TABLE"),
            "SQL should contain CREATE TABLE"
        );
    }

    #[test]
    fn test_latest_version() {
        assert!(
            MISTAKES_MIGRATIONS.latest_version() >= 20260207,
            "Latest should be >= 20260207"
        );
    }

    #[test]
    fn test_get_migration() {
        // 验证所有迁移集中声明的版本都可查找
        for m in MISTAKES_MIGRATIONS.migrations {
            assert!(
                MISTAKES_MIGRATIONS.get(m.refinery_version).is_some(),
                "Migration V{} should be findable",
                m.refinery_version
            );
        }
        assert!(
            MISTAKES_MIGRATIONS.get(1).is_none(),
            "Nonexistent version should return None"
        );
    }
}
