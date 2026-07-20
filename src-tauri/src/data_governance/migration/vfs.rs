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
//! ## 表结构 (32 个表 + 1 视图 + 1 FTS5 虚拟表)
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
//! - `todo_lists`, `todo_items`, `pomodoro_records`: 待办与番茄钟
//! - `memory_write_idempotency`, `__blob_deletion_queue`: 本地辅助表

use super::definitions::{MigrationDef, MigrationSet};

// ============================================================================
// VFS 迁移定义
// ============================================================================

/// V20260130: VFS 初始化迁移
///
/// 由 36 个历史迁移文件合并而成的完整 Schema。
/// SQL 包含 26 个常规表、1 个视图、1 个 FTS5 虚拟表。
/// 迁移验证清单排除后续 V20260214 删除的 `notes_versions`。
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

/// V001 预期的 25 个最终保留表（不含 FTS5 虚拟表 questions_fts）
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

/// V20260213: 为向量化状态查询补充 resources(source_id) 单列索引
pub const V20260213_ADD_INDEX_STATUS_PERF_INDEXES: MigrationDef = MigrationDef::new(
    20260213,
    "add_index_status_perf_indexes",
    include_str!("../../../migrations/vfs/V20260213__add_index_status_perf_indexes.sql"),
)
.with_expected_indexes(&["idx_resources_source_id"])
.idempotent();

/// V20260214: 删除已废弃的 notes_versions 表
pub const V20260214_DROP_NOTES_VERSIONS: MigrationDef = MigrationDef::new(
    20260214,
    "drop_notes_versions",
    include_str!("../../../migrations/vfs/V20260214__drop_notes_versions.sql"),
);

/// V20260215: 题目集导入断点续导支持
///
/// 新增 `import_state_json` 列，持久化导入中间状态（OCR 文本、chunk 进度等）。
/// 正常完成后清空，仅 status='importing' 时有值。
pub const V20260215_ADD_IMPORT_CHECKPOINT: MigrationDef = MigrationDef::new(
    20260215,
    "add_import_checkpoint",
    include_str!("../../../migrations/vfs/V20260215__add_import_checkpoint.sql"),
)
.idempotent();

/// V20260227: 记忆审计日志表
pub const V20260227_ADD_MEMORY_AUDIT_LOG: MigrationDef = MigrationDef::new(
    20260227,
    "add_memory_audit_log",
    include_str!("../../../migrations/vfs/V20260227__add_memory_audit_log.sql"),
)
.with_expected_tables(&["memory_audit_log"])
.with_expected_indexes(&[
    "idx_memory_audit_log_timestamp",
    "idx_memory_audit_log_source",
    "idx_memory_audit_log_operation",
    "idx_memory_audit_log_note_id",
])
.idempotent();

/// V20260302: 规范化 folder_items 时间戳列类型
///
/// 将历史写入的 TEXT 时间值统一修复为 INTEGER(毫秒时间戳)，
/// 避免读取 folder_items.created_at 时出现类型错误。
pub const V20260302_NORMALIZE_FOLDER_ITEMS_TIMESTAMPS: MigrationDef = MigrationDef::new(
    20260302,
    "normalize_folder_items_timestamps",
    include_str!("../../../migrations/vfs/V20260302__normalize_folder_items_timestamps.sql"),
)
.idempotent();

/// V20260303: 记忆写入幂等表
pub const V20260303_ADD_MEMORY_WRITE_IDEMPOTENCY: MigrationDef = MigrationDef::new(
    20260303,
    "add_memory_write_idempotency",
    include_str!("../../../migrations/vfs/V20260303__add_memory_write_idempotency.sql"),
)
.with_expected_tables(&["memory_write_idempotency"])
.with_expected_indexes(&["idx_memory_write_idempotency_created_at"])
.idempotent();

/// V20260304: 加固 note folder_items 与 memory audit 关键索引
pub const V20260304_HARDEN_MEMORY_FOLDER_ITEMS_AND_AUDIT_INDEXES: MigrationDef = MigrationDef::new(
    20260304,
    "harden_memory_folder_items_and_audit_indexes",
    include_str!(
        "../../../migrations/vfs/V20260304__harden_memory_folder_items_and_audit_indexes.sql"
    ),
)
.with_expected_indexes(&[
    "idx_folder_items_note_active_unique",
    "idx_folder_items_note_folder_sort_active",
    "idx_folder_items_note_lifecycle",
    "idx_memory_audit_log_source_operation_success_id_desc",
    "idx_memory_audit_log_operation_id_desc",
])
.idempotent();

/// V20260305: 为 answer_submissions 增加客户端请求幂等键
pub const V20260305_ADD_ANSWER_SUBMISSION_IDEMPOTENCY: MigrationDef = MigrationDef::new(
    20260305,
    "add_answer_submission_idempotency",
    include_str!("../../../migrations/vfs/V20260305__add_answer_submission_idempotency.sql"),
)
.with_expected_columns(&[("answer_submissions", "client_request_id")])
.with_expected_indexes(&["idx_submissions_question_request_id"]);

/// V20260306: 统一 folder_items/path_cache 的 file 别名并补活动挂载唯一约束
pub const V20260306_CANONICALIZE_FOLDER_ITEM_MOUNTS: MigrationDef = MigrationDef::new(
    20260306,
    "canonicalize_folder_item_mounts",
    include_str!("../../../migrations/vfs/V20260306__canonicalize_folder_item_mounts.sql"),
)
.with_expected_indexes(&["idx_folder_items_item_active_unique"])
.idempotent();

/// V20260308: 添加待办列表与待办项表
pub const V20260308_ADD_TODO_TABLES: MigrationDef = MigrationDef::new(
    20260308,
    "add_todo_tables",
    include_str!("../../../migrations/vfs/V20260308__add_todo_tables.sql"),
)
.with_expected_tables(&["todo_lists", "todo_items"])
.with_expected_indexes(&[
    "idx_todo_lists_deleted",
    "idx_todo_lists_favorite",
    "idx_todo_lists_updated",
    "idx_todo_lists_default",
    "idx_todo_items_list",
    "idx_todo_items_status",
    "idx_todo_items_priority",
    "idx_todo_items_due_date",
    "idx_todo_items_parent",
    "idx_todo_items_deleted",
    "idx_todo_items_updated",
    "idx_todo_items_list_status",
])
.idempotent();

/// V20260309: 待办列表与 VFS resources 解耦
pub const V20260309_DECOUPLE_TODO_FROM_VFS: MigrationDef = MigrationDef::new(
    20260309,
    "decouple_todo_from_vfs",
    include_str!("../../../migrations/vfs/V20260309__decouple_todo_from_vfs.sql"),
)
.with_expected_columns(&[
    ("todo_lists", "id"),
    ("todo_lists", "title"),
    ("todo_lists", "updated_at"),
]);

/// V20260310: 为待办增加番茄钟字段与 pomodoro_records 表
pub const V20260310_ADD_POMODORO: MigrationDef = MigrationDef::new(
    20260310,
    "add_pomodoro",
    include_str!("../../../migrations/vfs/V20260310__add_pomodoro.sql"),
)
.with_expected_tables(&["pomodoro_records"])
.with_expected_columns(&[
    ("todo_items", "estimated_pomodoros"),
    ("todo_items", "completed_pomodoros"),
])
.with_expected_indexes(&[
    "idx_pomodoro_item",
    "idx_pomodoro_type",
    "idx_pomodoro_status",
    "idx_pomodoro_created",
]);

/// V20260311: 为 todo_items 添加约束触发器
pub const V20260311_TODO_CONSTRAINTS: MigrationDef = MigrationDef::new(
    20260311,
    "todo_constraints",
    include_str!("../../../migrations/vfs/V20260311__todo_constraints.sql"),
)
.idempotent();

/// V20260312: 添加本地 blob 删除队列表
pub const V20260312_ADD_BLOB_DELETION_QUEUE: MigrationDef = MigrationDef::new(
    20260312,
    "add_blob_deletion_queue",
    include_str!("../../../migrations/vfs/V20260312__add_blob_deletion_queue.sql"),
)
.with_expected_tables(&["__blob_deletion_queue"])
.with_expected_indexes(&["idx__blob_deletion_queue_retry"])
.idempotent();

/// V20260523: 为剩余 VFS 表添加同步字段和变更日志触发器
pub const V20260523_ADD_MISSING_SYNC_COVERAGE: MigrationDef = MigrationDef::new(
    20260523,
    "add_missing_sync_coverage",
    include_str!("../../../migrations/vfs/V20260523__add_missing_sync_coverage.sql"),
);

/// V20260524: 为 __change_log 增加字段增量元数据
pub const V20260524_ADD_CHANGE_LOG_FIELD_DELTAS: MigrationDef = MigrationDef::new(
    20260524,
    "add_change_log_field_deltas",
    include_str!("../../../migrations/vfs/V20260524__add_change_log_field_deltas.sql"),
);

/// V20260525: 修复旧版 questions 变更日志中的 record_id
pub const V20260525_REPAIR_LEGACY_QUESTIONS_CHANGE_LOG_RECORD_IDS: MigrationDef = MigrationDef::new(
    20260525,
    "repair_legacy_questions_change_log_record_ids",
    include_str!(
        "../../../migrations/vfs/V20260525__repair_legacy_questions_change_log_record_ids.sql"
    ),
);

/// V20260526: 为 blobs 元数据添加同步触发器并回填已有行
pub const V20260526_ADD_BLOB_METADATA_SYNC: MigrationDef = MigrationDef::new(
    20260526,
    "add_blob_metadata_sync",
    include_str!("../../../migrations/vfs/V20260526__add_blob_metadata_sync.sql"),
);

/// V20260527: 添加本地资产删除队列表
pub const V20260527_ADD_ASSET_DELETION_QUEUE: MigrationDef = MigrationDef::new(
    20260527,
    "add_asset_deletion_queue",
    include_str!("../../../migrations/vfs/V20260527__add_asset_deletion_queue.sql"),
)
.with_expected_tables(&["__asset_deletion_queue"])
.with_expected_indexes(&["idx__asset_deletion_queue_retry"])
.idempotent();

/// V20260610: 重建 questions_fts 触发器为 FTS5 'delete' 命令模式并 rebuild 存量索引
pub const V20260610_FIX_QUESTIONS_FTS_TRIGGERS: MigrationDef = MigrationDef::new(
    20260610,
    "fix_questions_fts_triggers",
    include_str!("../../../migrations/vfs/V20260610__fix_questions_fts_triggers.sql"),
)
.idempotent();

/// V20260611: 添加 Lance 孤立向量清理队列表
pub const V20260611_ADD_LANCE_ORPHAN_QUEUE: MigrationDef = MigrationDef::new(
    20260611,
    "add_lance_orphan_queue",
    include_str!("../../../migrations/vfs/V20260611__add_lance_orphan_queue.sql"),
)
.with_expected_tables(&["__lance_orphan_queue"])
.with_expected_indexes(&["idx__lance_orphan_queue_retry"])
.idempotent();

/// V20260612: todo_items INSERT 触发器补 parent_id 自引用检查
pub const V20260612_TODO_INSERT_SELF_REF_CHECK: MigrationDef = MigrationDef::new(
    20260612,
    "todo_insert_self_ref_check",
    include_str!("../../../migrations/vfs/V20260612__todo_insert_self_ref_check.sql"),
)
.idempotent();

/// V20260613: 番茄钟裸时间戳转 UTC + pomodoro_records 枚举/数值校验触发器
pub const V20260613_POMODORO_TIMESTAMPS_AND_CONSTRAINTS: MigrationDef = MigrationDef::new(
    20260613,
    "pomodoro_timestamps_and_constraints",
    include_str!("../../../migrations/vfs/V20260613__pomodoro_timestamps_and_constraints.sql"),
)
.idempotent();

/// V20260614: parent_id 同清单校验与软删除冲突修复（软删父任务级联失败）
pub const V20260614_TODO_PARENT_CHECK_SOFTDELETE_FIX: MigrationDef = MigrationDef::new(
    20260614,
    "todo_parent_check_softdelete_fix",
    include_str!("../../../migrations/vfs/V20260614__todo_parent_check_softdelete_fix.sql"),
)
.idempotent();

/// V20260615: todo_items 环检测覆盖软删除节点（全图遍历 + 深度上限）
pub const V20260615_TODO_CYCLE_CHECK_FULL_GRAPH: MigrationDef = MigrationDef::new(
    20260615,
    "todo_cycle_check_full_graph",
    include_str!("../../../migrations/vfs/V20260615__todo_cycle_check_full_graph.sql"),
)
.idempotent();

/// V20260714: add explicit vector index profiles and generation metadata.
pub const V20260714_ADD_VECTOR_INDEX_PROFILES: MigrationDef = MigrationDef::new(
    20260714,
    "add_vector_index_profiles",
    include_str!("../../../migrations/vfs/V20260714__add_vector_index_profiles.sql"),
)
.with_expected_tables(&["vfs_index_profiles"])
.with_expected_columns(&[
    ("vfs_index_profiles", "id"),
    ("vfs_index_profiles", "model_fingerprint"),
    ("vfs_index_profiles", "model_config_id"),
    ("vfs_index_profiles", "model_name"),
    ("vfs_index_profiles", "dimension"),
    ("vfs_index_profiles", "modality"),
    ("vfs_index_profiles", "embedding_protocol"),
    ("vfs_index_profiles", "schema_version"),
    ("vfs_index_profiles", "lance_table_name"),
    ("vfs_index_profiles", "active_generation"),
    ("vfs_index_profiles", "state"),
    ("vfs_index_profiles", "ann_metric"),
    ("vfs_index_profiles", "ann_index_version"),
    ("vfs_index_profiles", "created_at"),
    ("vfs_index_profiles", "updated_at"),
    ("vfs_embedding_dims", "active_profile_id"),
    ("vfs_embedding_dims", "model_fingerprint"),
    ("vfs_embedding_dims", "embedding_protocol"),
    ("vfs_embedding_dims", "active_generation"),
    ("vfs_embedding_dims", "ann_metric"),
    ("vfs_embedding_dims", "ann_index_version"),
    ("vfs_index_segments", "index_profile_id"),
    ("vfs_index_segments", "generation"),
    ("vfs_index_units", "text_profile_id"),
    ("vfs_index_units", "text_generation"),
    ("vfs_index_units", "mm_profile_id"),
    ("vfs_index_units", "mm_generation"),
    ("resources", "index_generation"),
    ("resources", "mm_index_generation"),
    ("resources", "index_next_retry_at"),
    ("resources", "mm_index_next_retry_at"),
    ("__lance_orphan_queue", "next_retry_at"),
    ("__lance_orphan_queue", "last_error"),
])
.with_expected_indexes(&[
    "idx_vfs_index_profiles_route",
    "idx_vfs_index_profiles_model",
    "idx_vfs_index_segments_profile_generation",
    "idx_vfs_index_units_text_profile",
    "idx_vfs_index_units_mm_profile",
    "idx_resources_index_retry_due",
    "idx_resources_mm_index_retry_due",
    "idx_lance_orphan_retry_due",
]);

/// V20260715: deduplicate todo side effects across automation retries/recovery.
pub const V20260715_AUTOMATION_TODO_DELIVERY_RECEIPTS: MigrationDef = MigrationDef::new(
    20260715,
    "automation_todo_delivery_receipts",
    include_str!("../../../migrations/vfs/V20260715__automation_todo_delivery_receipts.sql"),
)
.with_expected_tables(&["automation_todo_deliveries"])
.with_expected_indexes(&["idx_automation_todo_deliveries_item"])
.idempotent();

/// V20260718: mastery intermediate layer (events + aggregated states)
pub const V20260718_ADD_MASTERY_TABLES: MigrationDef = MigrationDef::new(
    20260718,
    "add_mastery_tables",
    include_str!("../../../migrations/vfs/V20260718__add_mastery_tables.sql"),
)
.with_expected_tables(&["mastery_events", "mastery_states"])
.with_expected_columns(&[
    ("mastery_events", "id"),
    ("mastery_events", "created_at"),
    ("mastery_events", "source"),
    ("mastery_events", "concept_key"),
    ("mastery_events", "item_id"),
    ("mastery_events", "outcome"),
    ("mastery_events", "weight"),
    ("mastery_states", "concept_key"),
    ("mastery_states", "score"),
    ("mastery_states", "streak"),
    ("mastery_states", "total"),
    ("mastery_states", "wrong_count"),
    ("mastery_states", "last_signal_at"),
])
.with_expected_indexes(&[
    "idx_mastery_events_concept_time",
    "idx_mastery_events_item_time",
    "idx_mastery_states_score",
])
.idempotent();

/// V20260719: optional signal strength on mastery_events (A-P1 FSRS rating differentiation)
pub const V20260719_MASTERY_EVENTS_SIGNAL: MigrationDef = MigrationDef::new(
    20260719,
    "mastery_events_signal",
    include_str!("../../../migrations/vfs/V20260719__mastery_events_signal.sql"),
)
.with_expected_columns(&[("mastery_events", "signal")])
.idempotent();

/// V20260720: sync append-only mastery evidence; states remain derived.
pub const V20260720_MASTERY_EVENTS_SYNC: MigrationDef = MigrationDef::new(
    20260720,
    "mastery_events_sync",
    include_str!("../../../migrations/vfs/V20260720__mastery_events_sync.sql"),
)
.with_expected_columns(&[
    ("mastery_events", "device_id"),
    ("mastery_events", "local_version"),
    ("mastery_events", "updated_at"),
    ("mastery_events", "deleted_at"),
])
.with_expected_indexes(&[
    "idx_mastery_events_local_version",
    "idx_mastery_events_updated_at",
    "idx_mastery_events_device_version",
])
.with_expected_queries(&[
    "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg__change_log_mastery_events_insert'",
    "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg__change_log_mastery_events_update'",
    "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg__change_log_mastery_events_delete'",
])
.idempotent();

/// V20260721: backfill pomodoro_records.updated_at (= created_at) for LWW sync coverage.
pub const V20260721_POMODORO_BACKFILL_UPDATED_AT: MigrationDef = MigrationDef::new(
    20260721,
    "pomodoro_backfill_updated_at",
    include_str!("../../../migrations/vfs/V20260721__pomodoro_backfill_updated_at.sql"),
)
.with_expected_queries(&[
    "SELECT 1 FROM pomodoro_records WHERE updated_at IS NULL AND created_at IS NOT NULL LIMIT 0",
])
.idempotent();

/// V20260722: 笔记规范化标签表 note_tags（触发器随 notes.tags JSON 同步维护 + 回填）。
/// 回填使用无 WHERE 的 DELETE 清空映射表后全量重建，属预期行为（幂等重建）。
pub const V20260722_NOTE_TAGS: MigrationDef = MigrationDef::new(
    20260722,
    "note_tags",
    include_str!("../../../migrations/vfs/V20260722__note_tags.sql"),
)
.with_expected_tables(&["note_tags"])
.with_expected_indexes(&["idx_note_tags_tag"])
.with_expected_queries(&[
    "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_note_tags_insert'",
    "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_note_tags_update'",
    "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_note_tags_delete'",
])
.idempotent();

/// V20260723: 修复历史翻译软删除的 folder_items 幽灵挂载，并补齐列表索引。
pub const V20260723_TRANSLATION_SOFT_DELETE_REPAIR_AND_INDEXES: MigrationDef = MigrationDef::new(
    20260723,
    "translation_soft_delete_repair_and_indexes",
    include_str!(
        "../../../migrations/vfs/V20260723__translation_soft_delete_repair_and_indexes.sql"
    ),
)
.with_expected_indexes(&[
    "idx_translations_created_alive",
    "idx_folder_items_translation_folder_sort_active",
])
.idempotent();

/// V20260724: 笔记全文检索 notes_fts（FTS5 contentless + trigram，触发器维护 + 回填）。
pub const V20260724_NOTES_FTS: MigrationDef = MigrationDef::new(
    20260724,
    "notes_fts",
    include_str!("../../../migrations/vfs/V20260724__notes_fts.sql"),
)
.with_expected_tables(&["notes_fts"])
.with_expected_queries(&[
    "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_notes_fts_insert'",
    "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_notes_fts_update'",
    "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_notes_fts_delete'",
    "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_notes_fts_resource_insert'",
    "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_notes_fts_resource_data_update'",
])
.idempotent();

/// V20260725: 笔记链接图 note_links（wikilink / note:// 双链，触发器维护解析状态）。
/// 派生数据表（可由正文全量重建，见 notes_rebuild_links），不进 __change_log 同步。
pub const V20260725_NOTE_LINKS: MigrationDef = MigrationDef::new(
    20260725,
    "note_links",
    include_str!("../../../migrations/vfs/V20260725__note_links.sql"),
)
.with_expected_tables(&["note_links"])
.with_expected_indexes(&[
    "idx_note_links_target_id",
    "idx_note_links_unresolved",
    "idx_notes_title_nocase",
])
.with_expected_queries(&[
    "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_note_links_on_note_delete'",
    "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_note_links_resolve_on_insert'",
    "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_note_links_resolve_on_update'",
])
.idempotent();

/// V20260726: mindmaps.content_updated_at — OCC 内容锁与元数据时间戳解耦（B5）。
/// 仅内容实际变化时推进；收藏/重命名等元数据操作不再造成编辑端乐观锁伪冲突。
/// 回填 = updated_at（幂等，仅作用于 NULL 行）。
pub const V20260726_MINDMAP_CONTENT_UPDATED_AT: MigrationDef = MigrationDef::new(
    20260726,
    "mindmap_content_updated_at",
    include_str!("../../../migrations/vfs/V20260726__mindmap_content_updated_at.sql"),
)
.with_expected_columns(&[("mindmaps", "content_updated_at")])
.with_expected_queries(&[
    "SELECT 1 FROM mindmaps WHERE content_updated_at IS NULL AND updated_at IS NOT NULL LIMIT 0",
])
.idempotent();

/// V20260727: partial index on todo_items.completed_at for local-day "today completed" stats.
/// （原 V20260723，与并行合入的 translation 迁移版本号冲突，重命名顺延；内容未变。）
pub const V20260727_TODO_COMPLETED_AT_INDEX: MigrationDef = MigrationDef::new(
    20260727,
    "todo_completed_at_index",
    include_str!("../../../migrations/vfs/V20260727__todo_completed_at_index.sql"),
)
.with_expected_indexes(&["idx_todo_items_completed_at"])
.idempotent();

/// V20260728: todo_items.reminder 部分索引（提醒调度器高频轮询）
/// 与 (todo_list_id, parent_id, sort_order) 复合部分索引（清单视图排序、
/// 每次创建/移动/重复派生的 MAX(sort_order) 查询）。
pub const V20260728_TODO_REMINDER_INDEX_AND_LIST_SORT: MigrationDef = MigrationDef::new(
    20260728,
    "todo_reminder_index_and_list_sort",
    include_str!("../../../migrations/vfs/V20260728__todo_reminder_index_and_list_sort.sql"),
)
.with_expected_indexes(&["idx_todo_items_reminder", "idx_todo_items_list_parent_sort"])
.idempotent();

/// V20260801: 待办/番茄钟统计与批量操作的查询索引（只增索引）。
/// - (status, due_date) 复合部分索引服务 today/overdue/upcoming/counts 谓词；
/// - work 记录 created_at 部分索引服务全部番茄钟统计聚合的时间窗扫描；
/// - (todo_item_id, created_at) 部分索引服务任务关联查询的过滤 + 排序。
pub const V20260801_TODO_POMODORO_STATS_INDEXES: MigrationDef = MigrationDef::new(
    20260801,
    "todo_pomodoro_stats_indexes",
    include_str!("../../../migrations/vfs/V20260801__todo_pomodoro_stats_indexes.sql"),
)
.with_expected_indexes(&[
    "idx_todo_items_status_due",
    "idx_pomodoro_records_work_created",
    "idx_pomodoro_records_item_created",
])
.idempotent();

/// V20260806: mindmap_versions 复合查询索引（只增索引）。
/// (mindmap_id, created_at DESC, version_id DESC) 覆盖自动保存合并窗口检查、
/// 版本列表分页与保留策略清理的 `WHERE mindmap_id = ? ORDER BY ...` 形态。
pub const V20260806_MINDMAP_VERSIONS_LOOKUP_INDEX: MigrationDef = MigrationDef::new(
    20260806,
    "mindmap_versions_lookup_index",
    include_str!("../../../migrations/vfs/V20260806__mindmap_versions_lookup_index.sql"),
)
.with_expected_indexes(&["idx_mindmap_versions_mindmap_created"])
.idempotent();

/// V20260807: questions.structured_data 列（新题型结构化答案契约，
/// true_false/matching/ordering/numeric 与增强填空题）。不参与 FTS 索引。
/// 裸 ALTER ADD COLUMN 不可重复执行，故不标 idempotent。
pub const V20260807_QUESTION_STRUCTURED_DATA: MigrationDef = MigrationDef::new(
    20260807,
    "question_structured_data",
    include_str!("../../../migrations/vfs/V20260807__question_structured_data.sql"),
)
.with_expected_columns(&[("questions", "structured_data")]);

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
    V20260213_ADD_INDEX_STATUS_PERF_INDEXES,
    V20260214_DROP_NOTES_VERSIONS,
    V20260215_ADD_IMPORT_CHECKPOINT,
    V20260227_ADD_MEMORY_AUDIT_LOG,
    V20260302_NORMALIZE_FOLDER_ITEMS_TIMESTAMPS,
    V20260303_ADD_MEMORY_WRITE_IDEMPOTENCY,
    V20260304_HARDEN_MEMORY_FOLDER_ITEMS_AND_AUDIT_INDEXES,
    V20260305_ADD_ANSWER_SUBMISSION_IDEMPOTENCY,
    V20260306_CANONICALIZE_FOLDER_ITEM_MOUNTS,
    V20260308_ADD_TODO_TABLES,
    V20260309_DECOUPLE_TODO_FROM_VFS,
    V20260310_ADD_POMODORO,
    V20260311_TODO_CONSTRAINTS,
    V20260312_ADD_BLOB_DELETION_QUEUE,
    V20260523_ADD_MISSING_SYNC_COVERAGE,
    V20260524_ADD_CHANGE_LOG_FIELD_DELTAS,
    V20260525_REPAIR_LEGACY_QUESTIONS_CHANGE_LOG_RECORD_IDS,
    V20260526_ADD_BLOB_METADATA_SYNC,
    V20260527_ADD_ASSET_DELETION_QUEUE,
    V20260610_FIX_QUESTIONS_FTS_TRIGGERS,
    V20260611_ADD_LANCE_ORPHAN_QUEUE,
    V20260612_TODO_INSERT_SELF_REF_CHECK,
    V20260613_POMODORO_TIMESTAMPS_AND_CONSTRAINTS,
    V20260614_TODO_PARENT_CHECK_SOFTDELETE_FIX,
    V20260615_TODO_CYCLE_CHECK_FULL_GRAPH,
    V20260714_ADD_VECTOR_INDEX_PROFILES,
    V20260715_AUTOMATION_TODO_DELIVERY_RECEIPTS,
    V20260718_ADD_MASTERY_TABLES,
    V20260719_MASTERY_EVENTS_SIGNAL,
    V20260720_MASTERY_EVENTS_SYNC,
    V20260721_POMODORO_BACKFILL_UPDATED_AT,
    V20260722_NOTE_TAGS,
    V20260723_TRANSLATION_SOFT_DELETE_REPAIR_AND_INDEXES,
    V20260724_NOTES_FTS,
    V20260725_NOTE_LINKS,
    V20260726_MINDMAP_CONTENT_UPDATED_AT,
    V20260727_TODO_COMPLETED_AT_INDEX,
    V20260728_TODO_REMINDER_INDEX_AND_LIST_SORT,
    V20260801_TODO_POMODORO_STATS_INDEXES,
    V20260806_MINDMAP_VERSIONS_LOOKUP_INDEX,
    V20260807_QUESTION_STRUCTURED_DATA,
];

/// VFS 当前 Schema 版本，始终由已注册迁移的最后一项推导。
///
/// 数据库统计和版本断言应复用此常量，避免新增迁移时维护重复版本号。
pub const VFS_SCHEMA_VERSION: u32 =
    VFS_MIGRATIONS[VFS_MIGRATIONS.len() - 1].refinery_version as u32;

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
    "mindmap_versions",
    "questions",
    "question_history",
    "question_bank_stats",
    "review_plans",
    "review_history",
    "review_stats",
    "question_sync_conflicts",
    "question_sync_logs",
    "memory_config",
    "memory_audit_log",
    "memory_write_idempotency",
    "vfs_indexing_config",
    "vfs_index_units",
    "vfs_index_segments",
    "vfs_embedding_dims",
    "vfs_index_profiles",
    // 作答历史
    "answer_submissions",
    // Todo / Pomodoro
    "todo_lists",
    "todo_items",
    "automation_todo_deliveries",
    "pomodoro_records",
    // 掌握度中间层
    "mastery_events",
    "mastery_states",
    // 笔记规范化标签（V20260722）
    "note_tags",
    // 笔记链接图（V20260725，派生数据，不参与同步）
    "note_links",
    // 本地辅助队列
    "__blob_deletion_queue",
    "__asset_deletion_queue",
    "__lance_orphan_queue",
    // FTS5 虚拟表
    "questions_fts",
    "notes_fts",
];

/// VFS 数据库中的视图
pub const VFS_VIEW_NAMES: &[&str] = &["trash_view"];

/// VFS 数据库当前保留表总数（不含视图、虚拟表、已废弃表）
pub const VFS_TABLE_COUNT: usize = 41;

/// VFS 数据库视图总数
pub const VFS_VIEW_COUNT: usize = 1;

/// VFS 数据库 FTS5 虚拟表总数（questions_fts + notes_fts）
pub const VFS_FTS_TABLE_COUNT: usize = 2;

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

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
        // + V20260227 (add_memory_audit_log) + V20260302 (normalize_folder_items_timestamps)
        // + V20260303 (add_memory_write_idempotency)
        // + V20260304 (harden_memory_folder_items_and_audit_indexes)
        // + V20260305 (add_answer_submission_idempotency)
        // + V20260306 (canonicalize_folder_item_mounts) + V20260308 (add_todo_tables)
        // + V20260309 (decouple_todo_from_vfs) + V20260310 (add_pomodoro)
        // + V20260311 (todo_constraints) + V20260312 (add_blob_deletion_queue)
        // + V20260523 (missing_sync_coverage) + V20260524 (field_deltas)
        // + V20260525 (repair_legacy_questions_change_log_record_ids)
        // + V20260526 (add_blob_metadata_sync) + V20260527 (add_asset_deletion_queue)
        // + V20260610 (fix_questions_fts_triggers) + V20260611 (add_lance_orphan_queue)
        // + V20260612 (todo_insert_self_ref_check)
        // + V20260613 (pomodoro_timestamps_and_constraints)
        // + V20260614 (todo_parent_check_softdelete_fix)
        // + V20260615 (todo_cycle_check_full_graph)
        // + V20260714 (add_vector_index_profiles)
        // + V20260715 (automation_todo_delivery_receipts)
        // + V20260718 (add_mastery_tables)
        // + V20260719 (mastery_events_signal)
        assert_eq!(
            VFS_MIGRATION_SET.migrations.as_ptr(),
            VFS_MIGRATIONS.as_ptr()
        );
        assert_eq!(VFS_MIGRATION_SET.count(), VFS_MIGRATIONS.len());
        assert!(VFS_MIGRATIONS
            .windows(2)
            .all(|pair| pair[0].refinery_version < pair[1].refinery_version));
    }

    #[test]
    fn test_v20260130_migration_def() {
        assert_eq!(V20260130_INIT.refinery_version, 20260130);
        assert_eq!(V20260130_INIT.name, "init");
        assert!(V20260130_INIT.idempotent);
        // V001 init 迁移的最终保留表清单排除 V20260214 删除的 notes_versions
        assert_eq!(V20260130_INIT.expected_tables.len(), 25);
        // 验证 FTS5 虚拟表和视图的 smoke test 查询已配置。
        // 注意：这里锚定的是 init 时点的对象（questions_fts + trash_view），
        // 不能挂钩 VFS_FTS_TABLE_COUNT 等 head 状态常量——
        // notes_fts 等后续迁移新增的 FTS 表不属于 init 的 smoke 范围。
        assert_eq!(V20260130_INIT.expected_queries.len(), 2);
    }

    #[test]
    fn test_v001_expected_tables_count() {
        // 验证迁移后仍保留的表数量正确
        assert_eq!(VFS_V001_TABLES.len(), 25);
    }

    #[test]
    fn test_v001_sql_not_empty() {
        assert!(!V20260130_INIT.sql.is_empty());
        assert!(V20260130_INIT.sql.contains("CREATE TABLE"));
    }

    #[test]
    fn test_notes_versions_create_then_drop_is_declared() {
        assert!(V20260130_INIT
            .sql
            .contains("CREATE TABLE IF NOT EXISTS notes_versions"));
        assert!(V20260214_DROP_NOTES_VERSIONS
            .sql
            .contains("DROP TABLE IF EXISTS notes_versions"));
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

        let migration = VFS_MIGRATION_SET.get(20260525);
        assert!(migration.is_some());
        assert_eq!(migration.unwrap().refinery_version, 20260525);

        // 不存在的版本
        assert!(VFS_MIGRATION_SET.get(1).is_none());
    }

    #[test]
    fn test_latest_version() {
        assert_eq!(
            VFS_MIGRATION_SET.latest_version(),
            VFS_SCHEMA_VERSION as i32
        );
    }

    #[test]
    fn vector_profile_migration_backfills_legacy_image_as_multimodal_deterministically() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE vfs_embedding_dims (
                dimension INTEGER NOT NULL, modality TEXT NOT NULL,
                lance_table_name TEXT NOT NULL, record_count INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL,
                model_config_id TEXT, model_name TEXT,
                PRIMARY KEY (dimension, modality));
             CREATE TABLE vfs_index_units (
                id TEXT PRIMARY KEY, text_embedding_dim INTEGER, mm_embedding_dim INTEGER,
                text_required INTEGER NOT NULL DEFAULT 0, text_state TEXT NOT NULL DEFAULT 'disabled',
                text_error TEXT, mm_required INTEGER NOT NULL DEFAULT 0,
                mm_state TEXT NOT NULL DEFAULT 'disabled', mm_error TEXT);
             CREATE TABLE vfs_index_segments (
                id TEXT PRIMARY KEY, embedding_dim INTEGER NOT NULL, modality TEXT NOT NULL);
             CREATE TABLE resources (
                id TEXT PRIMARY KEY, index_state TEXT, index_error TEXT,
                index_retry_count INTEGER DEFAULT 0, mm_index_state TEXT,
                mm_index_error TEXT, mm_index_retry_count INTEGER DEFAULT 0);
             CREATE TABLE __lance_orphan_queue (
                lance_row_id TEXT PRIMARY KEY, enqueued_at INTEGER NOT NULL DEFAULT 0);
             INSERT INTO vfs_embedding_dims VALUES
                (512, 'image', 'legacy_image_512', 1, 1, 1, 'cfg-image', 'image-model'),
                (1024, 'image', 'legacy_image_1024', 1, 1, 1, 'cfg-image', 'image-model'),
                (1024, 'multimodal', 'legacy_mm_1024', 1, 1, 1, 'cfg-mm', 'mm-model');
             INSERT INTO vfs_index_units
                (id, mm_embedding_dim, mm_required, mm_state)
             VALUES ('unit-image-only', 512, 1, 'indexed'),
                    ('unit-both', 1024, 1, 'indexed');",
        )
        .unwrap();

        conn.execute_batch(include_str!(
            "../../../migrations/vfs/V20260714__add_vector_index_profiles.sql"
        ))
        .unwrap();

        let image_protocol: String = conn
            .query_row(
                "SELECT embedding_protocol FROM vfs_embedding_dims
                 WHERE dimension = 512 AND modality = 'image'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(image_protocol, "multimodal-embedding-v1");
        let image_profile: String = conn
            .query_row(
                "SELECT mm_profile_id FROM vfs_index_units WHERE id = 'unit-image-only'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(image_profile, "profile_legacy_image_512");
        let preferred_profile: String = conn
            .query_row(
                "SELECT mm_profile_id FROM vfs_index_units WHERE id = 'unit-both'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(preferred_profile, "profile_legacy_multimodal_1024");
    }
}
