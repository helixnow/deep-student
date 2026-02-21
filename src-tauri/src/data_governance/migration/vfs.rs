//! # VFS 数据库迁移定义
//!
//! VFS (Virtual File System) 数据库的迁移定义和验证配置。
//!
//! ## 数据库概述
//!
//! VFS 是核心数据存储层，管理所有用户内容资源：
//! - 笔记、文件、翻译、作文、题目等
//! - 文件夹组织结构
//! - 全文检索索引
//! - 向量索引元数据
//!
//! ## 表结构 (27 个表 + 1 视图 + 1 FTS5 虚拟表)
//!
//! ### 核心资源表
//! - `resources`: 统一资源存储（SSOT）
//! - `blobs`: 大文件外部存储
//!
//! ### 业务实体表
//! - `notes`: 笔记
//! - `files`: 文件统一存储
//! - `exam_sheets`: 整卷识别
//! - `translations`: 翻译记录
//! - `essays`, `essay_sessions`: 作文批改
//! - `mindmaps`: 知识导图
//!
//! ### 题目系统表
//! - `questions`, `question_history`, `question_bank_stats`: 题目实体
//! - `questions_fts`: 题目全文检索（FTS5 虚拟表）
//! - `review_plans`, `review_history`, `review_stats`: 复习计划（SM-2）
//! - `question_sync_conflicts`, `question_sync_logs`: 同步相关
//!
//! ### 文件夹系统表
//! - `folders`, `folder_items`, `path_cache`: 文件夹组织
//!
//! ### 配置与索引表
//! - `memory_config`: 记忆系统配置
//! - `vfs_indexing_config`: 索引配置
//! - `vfs_index_units`, `vfs_index_segments`, `vfs_embedding_dims`: 向量索引

use super::definitions::{MigrationDef, MigrationSet};

// ============================================================================
// VFS 迁移定义
// ============================================================================

/// V20260130: VFS 初始化迁移
///
/// 由 36 个历史迁移文件合并而成的完整 Schema。
/// 包含 27 个表、1 个视图、1 个 FTS5 虚拟表。
///
/// Refinery 文件: V20260130__init.sql -> refinery_version = 20260130
pub const V20260130_INIT: MigrationDef = MigrationDef::new(
    20260130,
    "init",
    include_str!("../../../migrations/vfs/V20260130__init.sql"),
)
.with_expected_tables(VFS_V001_TABLES)
.with_expected_indexes(VFS_V001_KEY_INDEXES)
.with_expected_queries(VFS_V001_SMOKE_QUERIES)
.idempotent();

/// V20260131: 添加变更日志表
///
/// 为增量备份和云同步添加 __change_log 表及触发器。
///
/// Refinery 文件: V20260131__add_change_log.sql -> refinery_version = 20260131
pub const V20260131_CHANGE_LOG: MigrationDef = MigrationDef::new(
    20260131,
    "add_change_log",
    include_str!("../../../migrations/vfs/V20260131__add_change_log.sql"),
)
.with_expected_tables(&["__change_log"])
.idempotent();

/// V20260201: 添加云同步字段
///
/// 为核心业务表添加同步所需字段：device_id, local_version, updated_at, deleted_at
/// 目标表：resources, notes, questions, review_plans, folders
///
/// Refinery 文件: V20260201_001__add_sync_fields.sql -> refinery_version = 20260201
pub const V20260201_SYNC_FIELDS: MigrationDef = MigrationDef::new(
    20260201,
    "add_sync_fields",
    include_str!("../../../migrations/vfs/V20260201__add_sync_fields.sql"),
)
.with_expected_indexes(VFS_V20260201_SYNC_INDEXES)
.idempotent();

/// V20260201 同步字段索引
/// 注意：只列出此迁移创建的新索引，不包括已存在的索引
const VFS_V20260201_SYNC_INDEXES: &[&str] = &[
    // resources 表同步索引（已有 deleted_at 索引）
    "idx_resources_local_version",
    "idx_resources_device_id",
    "idx_resources_device_version",
    "idx_resources_updated_not_deleted",
    // notes 表同步索引（已有 deleted_at 索引）
    "idx_notes_local_version",
    "idx_notes_deleted_at_sync",
    "idx_notes_device_id",
    "idx_notes_device_version",
    "idx_notes_updated_not_deleted",
    // questions 表同步索引（已有 deleted_at 索引）
    "idx_questions_local_version",
    "idx_questions_device_id",
    "idx_questions_device_version",
    "idx_questions_updated_not_deleted",
    // review_plans 表同步索引（新增 deleted_at）
    "idx_review_plans_local_version",
    "idx_review_plans_deleted_at",
    "idx_review_plans_device_id",
    "idx_review_plans_device_version",
    "idx_review_plans_updated_not_deleted",
    // folders 表同步索引（已有 deleted_at 索引）
    "idx_folders_local_version",
    "idx_folders_device_id",
    "idx_folders_device_version",
    "idx_folders_updated_not_deleted",
];

// ============================================================================
// 验证配置
// ============================================================================

/// V001 预期的 26 个表（不含 FTS5 虚拟表 questions_fts）
const VFS_V001_TABLES: &[&str] = &[
    // 核心资源表
    "resources",
    "blobs",
    // 笔记系统
    "notes",
    // 文件系统
    "files",
    // 整卷识别
    "exam_sheets",
    // 翻译系统
    "translations",
    // 作文系统
    "essays",
    "essay_sessions",
    // 文件夹系统
    "folders",
    "folder_items",
    "path_cache",
    // 知识导图
    "mindmaps",
    // 题目系统
    "questions",
    "question_history",
    "question_bank_stats",
    // 复习系统
    "review_plans",
    "review_history",
    "review_stats",
    // 同步系统
    "question_sync_conflicts",
    "question_sync_logs",
    // 配置表
    "memory_config",
    "vfs_indexing_config",
    // 索引系统
    "vfs_index_units",
    "vfs_index_segments",
    "vfs_embedding_dims",
];

/// V001 关键查询（语义 smoke test）
///
/// 验证 FTS5 虚拟表和视图等无法通过 expected_tables 覆盖的对象。
/// prepare() 阶段如果对象不存在会直接报错，无需检查返回行数。
const VFS_V001_SMOKE_QUERIES: &[&str] = &[
    // FTS5 虚拟表 questions_fts 存在且可查询
    "SELECT 1 FROM questions_fts LIMIT 0",
    // 视图 trash_view 存在且可查询
    "SELECT 1 FROM trash_view LIMIT 0",
];

/// V001 关键索引（选择性验证核心索引）
///
/// 不验证全部 100+ 个索引，只验证核心业务索引。
const VFS_V001_KEY_INDEXES: &[&str] = &[
    // resources 核心索引
    "idx_resources_hash",
    "idx_resources_type",
    "idx_resources_source",
    "idx_resources_index_state",
    // notes 核心索引
    "idx_notes_resource",
    "idx_notes_deleted",
    // files 核心索引
    "idx_files_sha256",
    "idx_files_resource",
    "idx_files_blob",
    "idx_files_deleted_at",
    // exam_sheets 核心索引
    "idx_exam_sheets_resource",
    "idx_exam_sheets_status",
    // translations 核心索引
    "idx_translations_resource",
    // essays 核心索引
    "idx_essays_resource",
    "idx_essays_session",
    // folders 核心索引
    "idx_folders_parent",
    "idx_folder_items_folder",
    "idx_folder_items_type_id",
    // questions 核心索引
    "idx_questions_exam_id",
    "idx_questions_status",
    "idx_questions_sync_status",
    // review_plans 核心索引
    "idx_review_plans_exam_id",
    "idx_review_plans_next_review",
    // 索引系统核心索引
    "idx_vfs_index_units_resource",
    "idx_vfs_index_units_text_state",
    "idx_vfs_index_segments_unit",
    "idx_vfs_embedding_dims_table",
];

// ============================================================================
// 迁移集合
// ============================================================================

/// V20260202: 添加外键约束
pub const V20260202_ADD_SEGMENTS_FK: MigrationDef = MigrationDef::new(
    20260202,
    "add_segments_fk",
    include_str!("../../../migrations/vfs/V20260202__add_segments_fk.sql"),
)
.idempotent();

/// V20260203: Schema 修复迁移
///
/// 确保从旧版本升级的数据库具有与新数据库相同的结构。
/// 使用 IF NOT EXISTS 确保幂等性。
pub const V20260203_SCHEMA_REPAIR: MigrationDef = MigrationDef::new(
    20260203,
    "schema_repair",
    include_str!("../../../migrations/vfs/V20260203__schema_repair.sql"),
)
.idempotent();

/// V20260204: 添加 PDF 预处理状态字段
pub const V20260204_PDF_PROCESSING_STATUS: MigrationDef = MigrationDef::new(
    20260204,
    "add_pdf_processing_status",
    include_str!("../../../migrations/vfs/V20260204__add_pdf_processing_status.sql"),
);

/// V20260205: 添加压缩 blob 引用字段
pub const V20260205_ADD_COMPRESSED_BLOB_HASH: MigrationDef = MigrationDef::new(
    20260205,
    "add_compressed_blob_hash",
    include_str!("../../../migrations/vfs/V20260205__add_compressed_blob_hash.sql"),
);

/// V20260206: 修复缺失的索引
pub const V20260206_REPAIR_INDEX_SEGMENTS_UNIT: MigrationDef = MigrationDef::new(
    20260206,
    "repair_vfs_index_segments_unit",
    include_str!("../../../migrations/vfs/V20260206__repair_vfs_index_segments_unit.sql"),
)
.idempotent();

/// V20260207: 统一 deleted_at 列类型
///
/// 将 resources 表的 deleted_at 从 INTEGER（毫秒时间戳）转为 TEXT（ISO 8601），
/// 与其他所有表的 deleted_at 类型保持一致，消除跨表查询和前端处理的类型歧义。
pub const V20260207_UNIFY_DELETED_AT_TYPE: MigrationDef = MigrationDef::new(
    20260207,
    "unify_deleted_at_type",
    include_str!("../../../migrations/vfs/V20260207__unify_deleted_at_type.sql"),
);

/// V20260208: 为 questions.last_attempt_at 添加日期表达式索引
///
/// 多处统计查询使用 DATE(last_attempt_at) 进行过滤和分组（M-040），
/// 缺少对应索引导致大数据量下统计慢。添加表达式索引 + 普通索引覆盖。
pub const V20260208_ADD_QUESTIONS_LAST_ATTEMPT_DATE_INDEX: MigrationDef = MigrationDef::new(
    20260208,
    "add_questions_last_attempt_date_index",
    include_str!("../../../migrations/vfs/V20260208__add_questions_last_attempt_date_index.sql"),
)
.with_expected_indexes(&[
    "idx_questions_last_attempt_date",
    "idx_questions_last_attempt_at",
])
.idempotent();

/// V20260209: 为 questions 表添加图片支持
///
/// 新增 images_json 列存储题目关联图片的 JSON 数组。
/// 每个元素是 VFS 附件引用: [{"id":"att_xxx","name":"图片.png","mime":"image/png","hash":"sha256..."}]
pub const V20260209_ADD_QUESTIONS_IMAGES: MigrationDef = MigrationDef::new(
    20260209,
    "add_questions_images",
    include_str!("../../../migrations/vfs/V20260209__add_questions_images.sql"),
);

/// V20260210: 新增作答历史表和 AI 评判缓存
///
/// - 新增 `answer_submissions` 表，记录每次作答的用户答案、正误和评判方式
/// - 为 `questions` 表新增 `ai_feedback`、`ai_score`、`ai_graded_at` 列，缓存最新一次 AI 评判结果
pub const V20260210_ADD_ANSWER_SUBMISSIONS: MigrationDef = MigrationDef::new(
    20260210,
    "add_answer_submissions",
    include_str!("../../../migrations/vfs/V20260210__add_answer_submissions.sql"),
)
.with_expected_tables(&["answer_submissions"])
.with_expected_indexes(&["idx_submissions_question"]);

/// V20260211: 修复 questions 变更日志 record_id（应为主键 id）
pub const V20260211_FIX_CHANGE_LOG_RECORD_ID: MigrationDef = MigrationDef::new(
    20260211,
    "fix_change_log_record_id",
    include_str!("../../../migrations/vfs/V20260211__fix_change_log_record_id.sql"),
)
.idempotent();

/// V20260212: 新增思维导图版本表（mindmap_versions）
pub const V20260212_ADD_MINDMAP_VERSIONS: MigrationDef = MigrationDef::new(
    20260212,
    "add_mindmap_versions",
    include_str!("../../../migrations/vfs/V20260212__add_mindmap_versions.sql"),
)
.with_expected_tables(&["mindmap_versions"])
.with_expected_indexes(&[
    "idx_mindmap_versions_mindmap",
    "idx_mindmap_versions_resource",
    "idx_mindmap_versions_created",
])
.idempotent();

/// VFS 数据库所有迁移定义
pub const VFS_MIGRATIONS: &[MigrationDef] = &[
    V20260130_INIT,
    V20260131_CHANGE_LOG,
    V20260201_SYNC_FIELDS,
    V20260202_ADD_SEGMENTS_FK,
    V20260203_SCHEMA_REPAIR,
    V20260204_PDF_PROCESSING_STATUS,
    V20260205_ADD_COMPRESSED_BLOB_HASH,
    V20260206_REPAIR_INDEX_SEGMENTS_UNIT,
    V20260207_UNIFY_DELETED_AT_TYPE,
    V20260208_ADD_QUESTIONS_LAST_ATTEMPT_DATE_INDEX,
    V20260209_ADD_QUESTIONS_IMAGES,
    V20260210_ADD_ANSWER_SUBMISSIONS,
    V20260211_FIX_CHANGE_LOG_RECORD_ID,
    V20260212_ADD_MINDMAP_VERSIONS,
];

/// VFS 迁移集合
pub const VFS_MIGRATION_SET: MigrationSet = MigrationSet {
    database_name: "vfs",
    migrations: VFS_MIGRATIONS,
};

// ============================================================================
// 辅助常量（用于外部模块参考）
// ============================================================================

/// VFS 数据库中的所有表名（包含虚拟表）
pub const VFS_ALL_TABLE_NAMES: &[&str] = &[
    // 常规表
    "resources",
    "notes",
    "files",
    "exam_sheets",
    "translations",
    "essays",
    "essay_sessions",
    "blobs",
    "folders",
    "folder_items",
    "path_cache",
    "mindmaps",
    "questions",
    "question_history",
    "question_bank_stats",
    "review_plans",
    "review_history",
    "review_stats",
    "question_sync_conflicts",
    "question_sync_logs",
    "memory_config",
    "vfs_indexing_config",
    "vfs_index_units",
    "vfs_index_segments",
    "vfs_embedding_dims",
    // 作答历史
    "answer_submissions",
    // FTS5 虚拟表
    "questions_fts",
];

/// VFS 数据库中的视图
pub const VFS_VIEW_NAMES: &[&str] = &["trash_view"];

/// VFS 数据库表总数（不含视图和虚拟表）
pub const VFS_TABLE_COUNT: usize = 27;

/// VFS 数据库视图总数
pub const VFS_VIEW_COUNT: usize = 1;

/// VFS 数据库 FTS5 虚拟表总数
pub const VFS_FTS_TABLE_COUNT: usize = 1;

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vfs_migration_set_structure() {
        assert_eq!(VFS_MIGRATION_SET.database_name, "vfs");
        // V20260130 (init) + V20260131 (change_log) + V20260201 (sync_fields)
        // + V20260202 (add_segments_fk) + V20260203 (schema_repair)
        // + V20260204 (pdf_processing_status) + V20260205 (compressed_blob_hash)
        // + V20260206 (repair_vfs_index_segments_unit)
        // + V20260207 (unify_deleted_at_type)
        // + V20260208 (add_questions_last_attempt_date_index)
        // + V20260209 (add_questions_images)
        // + V20260210 (add_answer_submissions)
        // + V20260211 (fix_change_log_record_id)
        assert_eq!(VFS_MIGRATION_SET.count(), 13);
    }

    #[test]
    fn test_v20260130_migration_def() {
        assert_eq!(V20260130_INIT.refinery_version, 20260130);
        assert_eq!(V20260130_INIT.name, "init");
        assert!(V20260130_INIT.idempotent);
        // V001 init 迁移创建 26 个常规表（answer_submissions 在 V20260210 中创建）
        assert_eq!(V20260130_INIT.expected_tables.len(), 26);
        // 验证 FTS5 虚拟表和视图的 smoke test 查询已配置
        assert_eq!(
            V20260130_INIT.expected_queries.len(),
            VFS_FTS_TABLE_COUNT + VFS_VIEW_COUNT
        );
    }

    #[test]
    fn test_v001_expected_tables_count() {
        // 验证表数量正确
        assert_eq!(VFS_V001_TABLES.len(), 26); // 28 - 1 (questions_fts 虚拟表) - 1 (answer_submissions 在 V20260210)
    }

    #[test]
    fn test_v001_sql_not_empty() {
        assert!(!V20260130_INIT.sql.is_empty());
        assert!(V20260130_INIT.sql.contains("CREATE TABLE"));
    }

    #[test]
    fn test_all_table_names_completeness() {
        // 确保 VFS_ALL_TABLE_NAMES 包含所有表
        assert_eq!(
            VFS_ALL_TABLE_NAMES.len(),
            VFS_TABLE_COUNT + VFS_FTS_TABLE_COUNT
        );
    }

    #[test]
    fn test_key_tables_present() {
        // 验证核心表在预期表列表中
        let key_tables = ["resources", "notes", "files", "questions", "folders"];
        for table in key_tables {
            assert!(
                VFS_V001_TABLES.contains(&table),
                "Missing key table: {}",
                table
            );
        }
    }

    #[test]
    fn test_key_indexes_present() {
        // 验证核心索引在预期索引列表中
        let key_indexes = [
            "idx_resources_hash",
            "idx_questions_exam_id",
            "idx_folders_parent",
        ];
        for index in key_indexes {
            assert!(
                VFS_V001_KEY_INDEXES.contains(&index),
                "Missing key index: {}",
                index
            );
        }
    }

    #[test]
    fn test_migration_set_get() {
        // 测试 get 方法使用 refinery_version
        let migration = VFS_MIGRATION_SET.get(20260130);
        assert!(migration.is_some());
        assert_eq!(migration.unwrap().refinery_version, 20260130);

        // 不存在的版本
        assert!(VFS_MIGRATION_SET.get(1).is_none());
    }

    #[test]
    fn test_latest_version() {
        assert_eq!(VFS_MIGRATION_SET.latest_version(), 20260211);
    }
}
