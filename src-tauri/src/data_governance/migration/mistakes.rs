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

/// V20260523: 为剩余 Mistakes 表添加同步字段和变更日志触发器
pub const V20260523_ADD_MISSING_SYNC_COVERAGE: MigrationDef = MigrationDef::new(
    20260523,
    "add_missing_sync_coverage",
    include_str!("../../../migrations/mistakes/V20260523__add_missing_sync_coverage.sql"),
)
.idempotent();

/// V20260524: 为 __change_log 增加字段增量元数据
pub const V20260524_ADD_CHANGE_LOG_FIELD_DELTAS: MigrationDef = MigrationDef::new(
    20260524,
    "add_change_log_field_deltas",
    include_str!("../../../migrations/mistakes/V20260524__add_change_log_field_deltas.sql"),
)
.idempotent();

/// V20260705: 为 document_tasks 补充 source_session_id
///
/// 该列此前由 legacy 运行时代码动态添加（database/mod.rs 的 ALTER TABLE），
/// 未纳入治理迁移，导致 schema 指纹漂移。此迁移将其正式声明。
/// 旧库已存在该列时由 make_alter_columns_safe 幂等跳过。
pub const V20260705_ADD_DOCUMENT_TASKS_SOURCE_SESSION_ID: MigrationDef = MigrationDef::new(
    20260705,
    "add_document_tasks_source_session_id",
    include_str!(
        "../../../migrations/mistakes/V20260705__add_document_tasks_source_session_id.sql"
    ),
)
.with_expected_columns(&[("document_tasks", "source_session_id")])
.idempotent();

/// V20260709: Flashcard FSRS schema（牌组 / 调度状态 / 复习日志）
///
/// 独立于 anki_cards 内容表，不向 anki_cards 添加调度列。
pub const V20260709_FLASHCARD_FSRS: MigrationDef = MigrationDef::new(
    20260709,
    "flashcard_fsrs",
    include_str!("../../../migrations/mistakes/V20260709__flashcard_fsrs.sql"),
)
.with_expected_tables(&["anki_decks", "fsrs_card_states", "fsrs_review_logs"])
.with_expected_indexes(&["idx_fsrs_due", "idx_fsrs_logs_card"])
.idempotent();

/// V20260710: Anki 同步 Receipt 回写字段
///
/// Sync 成功后写回 anki_note_id / export_status / last_exported_at / content_hash。
/// 与 V20260709 FSRS 迁移错开版本（Refinery 不支持 V20260709_1 后缀命名）。
///
/// 字段级 merge 策略已在 classification.rs 登记：receipt 四列作为一组走 row-level LWW
/// （以最新导出为准），不进入 field_merge 自动合并 picklist。
pub const V20260710_ANKI_EXPORT_RECEIPT: MigrationDef = MigrationDef::new(
    20260710,
    "anki_export_receipt",
    include_str!("../../../migrations/mistakes/V20260710__anki_export_receipt.sql"),
)
.with_expected_columns(&[
    ("anki_cards", "anki_note_id"),
    ("anki_cards", "export_status"),
    ("anki_cards", "last_exported_at"),
    ("anki_cards", "content_hash"),
])
.idempotent();

/// V20260711: FSRS RowSync coverage and orphan cleanup
pub const V20260711_FSRS_SYNC_COVERAGE: MigrationDef = MigrationDef::new(
    20260711,
    "fsrs_sync_coverage",
    include_str!("../../../migrations/mistakes/V20260711__fsrs_sync_coverage.sql"),
)
.with_expected_columns(&[
    ("fsrs_card_states", "device_id"),
    ("fsrs_card_states", "local_version"),
    ("fsrs_card_states", "deleted_at"),
    ("fsrs_review_logs", "created_at"),
    ("fsrs_review_logs", "updated_at"),
    ("fsrs_review_logs", "device_id"),
    ("fsrs_review_logs", "local_version"),
    ("fsrs_review_logs", "deleted_at"),
])
.with_expected_indexes(&[
    "idx_anki_decks_device_version",
    "idx_fsrs_card_states_device_version",
    "idx_fsrs_review_logs_device_version",
])
.idempotent();

/// V20260712: 完整 FSRS 评分前快照，支持无损撤销最后一次评分
pub const V20260712_FSRS_UNDO_SNAPSHOT: MigrationDef = MigrationDef::new(
    20260712,
    "fsrs_undo_snapshot",
    include_str!("../../../migrations/mistakes/V20260712__fsrs_undo_snapshot.sql"),
)
.with_expected_columns(&[("fsrs_review_logs", "state_before_json")])
.with_expected_indexes(&["idx_fsrs_logs_state_active"])
.idempotent();

/// V20260713: APKG imports preserve every Anki `cards` row.
///
/// Generated cards retain content-based document deduplication. APKG rows use
/// their local card id because several cards can legitimately share one note.
pub const V20260713_APKG_CARD_IDENTITY: MigrationDef = MigrationDef::new(
    20260713,
    "apkg_card_identity",
    include_str!("../../../migrations/mistakes/V20260713__apkg_card_identity.sql"),
)
.with_expected_indexes(MISTAKES_V20260209_DEDUP_INDEXES)
.idempotent();

/// V20260714: 周期自动化定义、原子领取状态与可查询运行历史
pub const V20260714_AUTOMATION_SCHEDULER: MigrationDef = MigrationDef::new(
    20260714,
    "automation_scheduler",
    include_str!("../../../migrations/mistakes/V20260714__automation_scheduler.sql"),
)
.with_expected_tables(&["automation_definitions", "automation_runs"])
.with_expected_indexes(&[
    "idx_automation_definitions_enabled_next",
    "idx_automation_definitions_updated",
    "idx_automation_runs_automation_created",
    "idx_automation_runs_retry_due",
    "idx_automation_runs_status_updated",
])
.idempotent();

/// V20260715: automation process leases, explicit-retry intent, and orphan cleanup
pub const V20260715_HARDEN_AUTOMATION_RUNTIME: MigrationDef = MigrationDef::new(
    20260715,
    "harden_automation_runtime",
    include_str!("../../../migrations/mistakes/V20260715__harden_automation_runtime.sql"),
)
.with_expected_columns(&[
    ("automation_runs", "lease_expires_at"),
    ("automation_runs", "retry_requested"),
])
.with_expected_indexes(&["idx_automation_runs_owner_lease"])
.idempotent();

/// V20260721: optional hash-locked trusted execution profile for agent automations.
pub const V20260721_TRUSTED_AUTOMATION_PROFILE: MigrationDef = MigrationDef::new(
    20260721,
    "trusted_automation_profile",
    include_str!("../../../migrations/mistakes/V20260721__trusted_automation_profile.sql"),
)
.with_expected_columns(&[("automation_definitions", "trusted_profile_json")])
.idempotent();

/// V20260722: FSRS 调度器加固（leech、bury 到期时间与复习统计索引）
pub const V20260722_FSRS_SCHEDULER_HARDENING: MigrationDef = MigrationDef::new(
    20260722,
    "fsrs_scheduler_hardening",
    include_str!("../../../migrations/mistakes/V20260722__fsrs_scheduler_hardening.sql"),
)
.with_expected_columns(&[
    ("fsrs_card_states", "leech"),
    ("fsrs_card_states", "buried_until_ms"),
])
.with_expected_indexes(&["idx_fsrs_logs_review_ms"])
.idempotent();

/// V20260723: 内置模板用户态标记（user_modified / user_deleted）
///
/// 支撑模板 CRUD 加固：内置模板版本升级导入跳过用户改过/删过的模板，
/// 删除内置模板改为打墓碑标记（停用）而非物理删除，保证模板 ID 稳定。
pub const V20260723_TEMPLATE_USER_STATE: MigrationDef = MigrationDef::new(
    20260723,
    "template_user_state",
    include_str!("../../../migrations/mistakes/V20260723__template_user_state.sql"),
)
.with_expected_columns(&[
    ("custom_anki_templates", "user_modified"),
    ("custom_anki_templates", "user_deleted"),
])
.with_expected_indexes(&["idx_custom_anki_templates_user_deleted"])
.idempotent();

/// V20260724: Anki 去重索引忽略软删除卡片。
///
/// 旧索引已经保证活跃卡片不存在重复；重建为 partial unique index 后，
/// 软删除卡片不再阻止重新生成相同内容。
pub const V20260724_ANKI_DEDUP_INDEX_EXCLUDE_DELETED: MigrationDef = MigrationDef::new(
    20260724,
    "anki_dedup_index_exclude_deleted",
    include_str!("../../../migrations/mistakes/V20260724__anki_dedup_index_exclude_deleted.sql"),
)
.with_expected_indexes(MISTAKES_V20260209_DEDUP_INDEXES)
.idempotent();

/// V20260720: durable FSRS -> mastery outbox marker.
pub const V20260720_FSRS_MASTERY_OUTBOX: MigrationDef = MigrationDef::new(
    20260720,
    "fsrs_mastery_outbox",
    include_str!("../../../migrations/mistakes/V20260720__fsrs_mastery_outbox.sql"),
)
.with_expected_columns(&[
    ("fsrs_review_logs", "mastery_synced_at"),
    ("fsrs_review_logs", "mastery_revert_pending"),
])
.with_expected_indexes(&["idx_fsrs_review_logs_mastery_pending"])
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
        V20260523_ADD_MISSING_SYNC_COVERAGE,
        V20260524_ADD_CHANGE_LOG_FIELD_DELTAS,
        V20260705_ADD_DOCUMENT_TASKS_SOURCE_SESSION_ID,
        V20260709_FLASHCARD_FSRS,
        V20260710_ANKI_EXPORT_RECEIPT,
        V20260711_FSRS_SYNC_COVERAGE,
        V20260712_FSRS_UNDO_SNAPSHOT,
        V20260713_APKG_CARD_IDENTITY,
        V20260714_AUTOMATION_SCHEDULER,
        V20260715_HARDEN_AUTOMATION_RUNTIME,
        V20260720_FSRS_MASTERY_OUTBOX,
        V20260721_TRUSTED_AUTOMATION_PROFILE,
        V20260722_FSRS_SCHEDULER_HARDENING,
        V20260723_TEMPLATE_USER_STATE,
        V20260724_ANKI_DEDUP_INDEX_EXCLUDE_DELETED,
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

    #[test]
    fn test_recent_sync_migrations_are_registered() {
        let sync_coverage = MISTAKES_MIGRATIONS
            .get(20260523)
            .expect("V20260523 should exist");
        assert_eq!(sync_coverage.name, "add_missing_sync_coverage");
        assert!(sync_coverage.idempotent);

        let field_deltas = MISTAKES_MIGRATIONS
            .get(20260524)
            .expect("V20260524 should exist");
        assert_eq!(field_deltas.name, "add_change_log_field_deltas");
        assert!(field_deltas.idempotent);

        let source_session = MISTAKES_MIGRATIONS
            .get(20260705)
            .expect("V20260705 should exist");
        assert_eq!(source_session.name, "add_document_tasks_source_session_id");
        assert!(source_session.idempotent);

        let flashcard_fsrs = MISTAKES_MIGRATIONS
            .get(20260709)
            .expect("V20260709 should exist");
        assert_eq!(flashcard_fsrs.name, "flashcard_fsrs");
        assert!(flashcard_fsrs.idempotent);
        assert!(flashcard_fsrs.expected_tables.contains(&"fsrs_card_states"));

        let export_receipt = MISTAKES_MIGRATIONS
            .get(20260710)
            .expect("V20260710 should exist");
        assert_eq!(export_receipt.name, "anki_export_receipt");
        assert!(export_receipt.idempotent);
        assert!(export_receipt
            .expected_columns
            .contains(&("anki_cards", "anki_note_id")));

        let fsrs_sync = MISTAKES_MIGRATIONS
            .get(20260711)
            .expect("V20260711 should exist");
        assert_eq!(fsrs_sync.name, "fsrs_sync_coverage");
        assert!(fsrs_sync.idempotent);
        assert!(fsrs_sync
            .expected_columns
            .contains(&("fsrs_review_logs", "deleted_at")));
        assert!(fsrs_sync
            .sql
            .contains("trg_fsrs_cleanup_before_anki_card_delete"));

        let fsrs_undo = MISTAKES_MIGRATIONS
            .get(20260712)
            .expect("V20260712 should exist");
        assert_eq!(fsrs_undo.name, "fsrs_undo_snapshot");
        assert!(fsrs_undo.idempotent);
        assert!(fsrs_undo
            .expected_columns
            .contains(&("fsrs_review_logs", "state_before_json")));
        assert!(fsrs_undo
            .expected_indexes
            .contains(&"idx_fsrs_logs_state_active"));

        let apkg_identity = MISTAKES_MIGRATIONS
            .get(20260713)
            .expect("V20260713 should exist");
        assert_eq!(apkg_identity.name, "apkg_card_identity");
        assert!(apkg_identity.idempotent);
        assert!(apkg_identity
            .sql
            .contains("WHEN source_type = 'apkg_import'"));

        let automation_scheduler = MISTAKES_MIGRATIONS
            .get(20260714)
            .expect("V20260714 should exist");
        assert_eq!(automation_scheduler.name, "automation_scheduler");
        assert!(automation_scheduler.idempotent);
        assert!(automation_scheduler
            .expected_tables
            .contains(&"automation_runs"));

        let mastery_outbox = MISTAKES_MIGRATIONS
            .get(20260720)
            .expect("V20260720 should exist");
        assert_eq!(mastery_outbox.name, "fsrs_mastery_outbox");
        assert!(mastery_outbox
            .expected_columns
            .contains(&("fsrs_review_logs", "mastery_synced_at")));

        let fsrs_scheduler = MISTAKES_MIGRATIONS
            .get(20260722)
            .expect("V20260722 should exist");
        assert_eq!(fsrs_scheduler.name, "fsrs_scheduler_hardening");
        assert!(fsrs_scheduler.idempotent);
        assert!(fsrs_scheduler
            .expected_columns
            .contains(&("fsrs_card_states", "leech")));
        assert!(fsrs_scheduler
            .expected_columns
            .contains(&("fsrs_card_states", "buried_until_ms")));

        let template_user_state = MISTAKES_MIGRATIONS
            .get(20260723)
            .expect("V20260723 should exist");
        assert_eq!(template_user_state.name, "template_user_state");
        assert!(template_user_state.idempotent);
        assert!(template_user_state
            .expected_columns
            .contains(&("custom_anki_templates", "user_modified")));
        assert!(template_user_state
            .expected_columns
            .contains(&("custom_anki_templates", "user_deleted")));

        let anki_dedup = MISTAKES_MIGRATIONS
            .get(20260724)
            .expect("V20260724 should exist");
        assert_eq!(anki_dedup.name, "anki_dedup_index_exclude_deleted");
        assert!(anki_dedup.idempotent);

        assert_eq!(
            MISTAKES_MIGRATIONS.latest_version(),
            20260724,
            "Latest version should track the newest published mistakes migration"
        );
    }
}
