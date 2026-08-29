//! # LLM Usage Database Migration Definitions
//!
//! LLM Token 使用统计数据库的迁移定义。
//!
//! ## 数据库概述
//!
//! LLM Usage 是一个独立的统计数据库，记录所有 LLM API 调用的详细信息：
//! - Token 使用量（prompt/completion/reasoning/cached）
//! - 性能指标（耗时、TTFT）
//! - 成本估算
//! - 日汇总统计
//!
//! ## 表结构 (2 表)
//!
//! - `llm_usage_logs`: 使用日志主表
//! - `llm_usage_daily`: 日汇总聚合表

use super::definitions::{MigrationDef, MigrationSet};

// ============================================================================
// V001: 初始化迁移
// ============================================================================

/// V001 预期的表（2 个）
const V001_EXPECTED_TABLES: &[&str] = &["llm_usage_logs", "llm_usage_daily"];

/// V001 预期的索引（17 个）
const V001_EXPECTED_INDEXES: &[&str] = &[
    // llm_usage_logs 表索引 (13)
    "idx_llm_usage_logs_timestamp",
    "idx_llm_usage_logs_date_key",
    "idx_llm_usage_logs_hour_key",
    "idx_llm_usage_logs_caller_type",
    "idx_llm_usage_logs_model",
    "idx_llm_usage_logs_provider",
    "idx_llm_usage_logs_status",
    "idx_llm_usage_logs_session_id",
    "idx_llm_usage_logs_api_config_id",
    "idx_llm_usage_logs_date_caller",
    "idx_llm_usage_logs_date_model",
    "idx_llm_usage_logs_date_provider",
    "idx_llm_usage_logs_date_status",
    // llm_usage_daily 表索引 (4)
    "idx_llm_usage_daily_date",
    "idx_llm_usage_daily_caller_type",
    "idx_llm_usage_daily_model",
    "idx_llm_usage_daily_provider",
];

/// V001 预期的关键列（用于验证表结构完整性）
/// 注意：不包括 GENERATED 列（date_key, hour_key），因为 PRAGMA table_info
/// 在某些 SQLite 版本中可能不正确报告它们
const V001_EXPECTED_COLUMNS: &[(&str, &str)] = &[
    // llm_usage_logs 核心字段（不含 GENERATED 列）
    ("llm_usage_logs", "id"),
    ("llm_usage_logs", "timestamp"),
    ("llm_usage_logs", "provider"),
    ("llm_usage_logs", "model"),
    ("llm_usage_logs", "prompt_tokens"),
    ("llm_usage_logs", "completion_tokens"),
    ("llm_usage_logs", "total_tokens"),
    ("llm_usage_logs", "caller_type"),
    ("llm_usage_logs", "status"),
    // llm_usage_daily 核心字段
    ("llm_usage_daily", "date"),
    ("llm_usage_daily", "caller_type"),
    ("llm_usage_daily", "model"),
    ("llm_usage_daily", "provider"),
    ("llm_usage_daily", "request_count"),
    ("llm_usage_daily", "total_tokens"),
];

// ============================================================================
// 迁移定义
// ============================================================================

/// V20260130: LLM Usage 初始化迁移
///
/// Refinery 文件: V20260130__init.sql -> refinery_version = 20260130
pub const V20260130_INIT: MigrationDef = MigrationDef::new(
    20260130,
    "init",
    include_str!("../../../migrations/llm_usage/V20260130__init.sql"),
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
    include_str!("../../../migrations/llm_usage/V20260131__add_change_log.sql"),
)
.with_expected_tables(&["__change_log"])
.idempotent();

/// V20260201: 添加云同步字段
///
/// 为核心业务表添加同步所需字段：device_id, local_version, updated_at, deleted_at
/// 目标表：llm_usage_logs, llm_usage_daily
///
/// Refinery 文件: V20260201_001__add_sync_fields.sql -> refinery_version = 20260201
pub const V20260201_SYNC_FIELDS: MigrationDef = MigrationDef::new(
    20260201,
    "add_sync_fields",
    include_str!("../../../migrations/llm_usage/V20260201__add_sync_fields.sql"),
)
.with_expected_indexes(LLM_USAGE_V20260201_SYNC_INDEXES)
.idempotent();

/// V20260202: 修复 llm_usage_daily 变更日志复合主键编码
pub const V20260202_FIX_CHANGE_LOG_RECORD_ID: MigrationDef = MigrationDef::new(
    20260202,
    "fix_change_log_record_id",
    include_str!("../../../migrations/llm_usage/V20260202__fix_change_log_record_id.sql"),
)
.idempotent();

/// V20260524: 为 __change_log 增加字段增量元数据
pub const V20260524_ADD_CHANGE_LOG_FIELD_DELTAS: MigrationDef = MigrationDef::new(
    20260524,
    "add_change_log_field_deltas",
    include_str!("../../../migrations/llm_usage/V20260524__add_change_log_field_deltas.sql"),
);

/// V20260525: 停止为 llm_usage_daily 生成增量同步日志
pub const V20260525_DROP_DAILY_CHANGE_LOG_TRIGGERS: MigrationDef = MigrationDef::new(
    20260525,
    "drop_daily_change_log_triggers",
    include_str!("../../../migrations/llm_usage/V20260525__drop_daily_change_log_triggers.sql"),
)
.idempotent();

/// V20260824: llm_usage_logs 增加 cache_write_tokens（缓存写入 Token，
/// NULL = 无测量），报表侧据此计算缓存 write/read 比
pub const V20260824_ADD_CACHE_WRITE_TOKENS: MigrationDef = MigrationDef::new(
    20260824,
    "add_cache_write_tokens",
    include_str!("../../../migrations/llm_usage/V20260824__add_cache_write_tokens.sql"),
)
.with_expected_columns(&[("llm_usage_logs", "cache_write_tokens")]);

/// V20260826: llm_usage_logs 增加 variant_id / run_id（遥测身份分列）。
///
/// model2 流式路径此前把 run-scoped stream_event 整体当 session_id 落库；
/// 本迁移为分列后的 variant / run 维度补列（session_id 复用既有列，改为
/// 写真实会话 ID）。NULL = 未知（历史数据 / 非 chat_v2 调用方）。
pub const V20260826_ADD_STREAM_IDENTITY: MigrationDef = MigrationDef::new(
    20260826,
    "add_stream_identity",
    include_str!("../../../migrations/llm_usage/V20260826__add_stream_identity.sql"),
)
.with_expected_columns(&[
    ("llm_usage_logs", "variant_id"),
    ("llm_usage_logs", "run_id"),
])
.with_expected_indexes(&["idx_llm_usage_logs_variant_id", "idx_llm_usage_logs_run_id"]);

/// V20260201 同步字段索引
const LLM_USAGE_V20260201_SYNC_INDEXES: &[&str] = &[
    // llm_usage_logs 表同步索引
    "idx_llm_usage_logs_local_version",
    "idx_llm_usage_logs_deleted_at",
    "idx_llm_usage_logs_device_id",
    "idx_llm_usage_logs_updated_at",
    "idx_llm_usage_logs_device_version",
    "idx_llm_usage_logs_updated_not_deleted",
    // llm_usage_daily 表同步索引
    "idx_llm_usage_daily_local_version",
    "idx_llm_usage_daily_deleted_at",
    "idx_llm_usage_daily_device_id",
    "idx_llm_usage_daily_updated_at",
    "idx_llm_usage_daily_device_version",
    "idx_llm_usage_daily_updated_not_deleted",
];

/// LLM Usage 数据库迁移定义列表
pub const LLM_USAGE_MIGRATIONS: &[MigrationDef] = &[
    V20260130_INIT,
    V20260131_CHANGE_LOG,
    V20260201_SYNC_FIELDS,
    V20260202_FIX_CHANGE_LOG_RECORD_ID,
    V20260524_ADD_CHANGE_LOG_FIELD_DELTAS,
    V20260525_DROP_DAILY_CHANGE_LOG_TRIGGERS,
    V20260824_ADD_CACHE_WRITE_TOKENS,
    V20260826_ADD_STREAM_IDENTITY,
];

/// LLM Usage 数据库迁移集合
pub const LLM_USAGE_MIGRATION_SET: MigrationSet = MigrationSet {
    database_name: "llm_usage",
    migrations: LLM_USAGE_MIGRATIONS,
};

// ============================================================================
// 辅助常量
// ============================================================================

/// LLM Usage 数据库中的所有表名
pub const LLM_USAGE_ALL_TABLE_NAMES: &[&str] = &["llm_usage_logs", "llm_usage_daily"];

/// LLM Usage 数据库表总数
pub const LLM_USAGE_TABLE_COUNT: usize = 2;

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_migration_set_structure() {
        assert_eq!(LLM_USAGE_MIGRATION_SET.database_name, "llm_usage");
        assert_eq!(LLM_USAGE_MIGRATION_SET.count(), 8); // + V20260202 + V20260524 + V20260525 + V20260824 + V20260826
    }

    #[test]
    fn test_v20260130_migration() {
        let migration = LLM_USAGE_MIGRATION_SET
            .get(20260130)
            .expect("V20260130 should exist");
        assert_eq!(migration.name, "init");
        assert_eq!(migration.expected_tables.len(), 2);
        assert_eq!(migration.expected_indexes.len(), 17);
        assert!(migration.idempotent);
    }

    #[test]
    fn test_expected_tables_count() {
        assert_eq!(V001_EXPECTED_TABLES.len(), LLM_USAGE_TABLE_COUNT);
    }

    #[test]
    fn test_sql_content_not_empty() {
        assert!(!V20260130_INIT.sql.is_empty());
        assert!(V20260130_INIT.sql.contains("CREATE TABLE"));
    }

    #[test]
    fn test_latest_version() {
        assert_eq!(LLM_USAGE_MIGRATION_SET.latest_version(), 20260826);
    }

    #[test]
    fn test_pending_migrations() {
        // 从版本 0 开始，应该有 8 个待执行
        let pending: Vec<_> = LLM_USAGE_MIGRATION_SET.pending(0).collect();
        assert_eq!(pending.len(), 8);

        // 从版本 20260130 开始，应该有 7 个待执行
        let pending: Vec<_> = LLM_USAGE_MIGRATION_SET.pending(20260130).collect();
        assert_eq!(pending.len(), 7);

        // 从版本 20260131 开始，应该有 6 个待执行
        let pending: Vec<_> = LLM_USAGE_MIGRATION_SET.pending(20260131).collect();
        assert_eq!(pending.len(), 6);

        // 从版本 20260201 开始，应该有 5 个待执行
        let pending: Vec<_> = LLM_USAGE_MIGRATION_SET.pending(20260201).collect();
        assert_eq!(pending.len(), 5);

        // 从版本 20260202 开始，应该有 4 个待执行
        let pending: Vec<_> = LLM_USAGE_MIGRATION_SET.pending(20260202).collect();
        assert_eq!(pending.len(), 4);
        assert_eq!(pending[0].refinery_version, 20260524);
        assert_eq!(pending[1].refinery_version, 20260525);
        assert_eq!(pending[2].refinery_version, 20260824);
        assert_eq!(pending[3].refinery_version, 20260826);

        // 从版本 20260524 开始，应该有 3 个待执行
        let pending: Vec<_> = LLM_USAGE_MIGRATION_SET.pending(20260524).collect();
        assert_eq!(pending.len(), 3);
        assert_eq!(pending[0].refinery_version, 20260525);
        assert_eq!(pending[1].refinery_version, 20260824);
        assert_eq!(pending[2].refinery_version, 20260826);

        // 从版本 20260525 开始，剩 cache_write_tokens + 遥测身份两列
        let pending: Vec<_> = LLM_USAGE_MIGRATION_SET.pending(20260525).collect();
        assert_eq!(pending.len(), 2);
        assert_eq!(pending[0].refinery_version, 20260824);
        assert_eq!(pending[1].refinery_version, 20260826);

        // 从版本 20260824 开始，只剩遥测身份分列
        let pending: Vec<_> = LLM_USAGE_MIGRATION_SET.pending(20260824).collect();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].refinery_version, 20260826);

        // 从版本 20260826 开始，应该没有待执行
        let pending: Vec<_> = LLM_USAGE_MIGRATION_SET.pending(20260826).collect();
        assert_eq!(pending.len(), 0);
    }
}
