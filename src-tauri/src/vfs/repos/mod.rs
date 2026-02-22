//! VFS Repo 模块
//!
//! 提供 VFS 各表的 CRUD 操作。
//! 所有 Repo 方法提供 `_with_conn` 版本，避免二次获取连接造成死锁。
//!
//! ## 模块结构
//! - `resource_repo`: 资源表 CRUD（内容 SSOT）
//! - `note_repo`: 笔记元数据 CRUD + 版本管理
//! - `textbook_repo`: 教材元数据 CRUD（已废弃，使用 file_repo）
//! - `exam_repo`: 题目集识别元数据 CRUD
//! - `translation_repo`: 翻译元数据 CRUD
//! - `essay_repo`: 作文批改元数据 CRUD
//! - `blob_repo`: 大文件外部存储管理
//! - `folder_repo`: 文件夹层级结构 CRUD + 递归查询
//! - `file_repo`: 统一文件管理（合并 textbooks + attachments）
//! - `path_cache_repo`: 路径缓存系统（契约 A4, C2）
//! - `index_unit_repo`: 图片-文本组索引单元 CRUD
//! - `index_segment_repo`: 最小检索单位 CRUD
//! - `embedding_dim_repo`: 向量维度注册表 CRUD

pub mod attachment_repo;
pub mod blob_repo;
pub mod embedding_dim_repo;
pub mod embedding_repo;
pub mod essay_repo;
pub mod exam_repo;
pub mod file_repo;
pub mod folder_repo;
pub mod index_segment_repo;
pub mod index_unit_repo;
pub mod mindmap_repo;
pub mod note_repo;
pub mod path_cache_repo;
pub mod pdf_preview;
pub mod question_repo;
pub mod resource_repo;
pub mod review_plan_repo;
pub mod textbook_repo;
pub mod translation_repo;

pub use attachment_repo::VfsAttachmentRepo;
pub use blob_repo::VfsBlobRepo;
pub use embedding_repo::{
    IndexState, VfsDimensionRepo, VfsEmbedding, VfsEmbeddingDimension, VfsIndexStateRepo,
    VfsIndexingConfigRepo, INDEX_STATE_DISABLED, INDEX_STATE_FAILED, INDEX_STATE_INDEXED,
    INDEX_STATE_INDEXING, INDEX_STATE_PENDING, MODALITY_MULTIMODAL, MODALITY_TEXT,
    VFS_EMB_TABLE_PREFIX,
};
pub use essay_repo::VfsEssayRepo;
pub use exam_repo::{ImportingSession, VfsExamRepo};
pub use file_repo::VfsFileRepo;
pub use folder_repo::VfsFolderRepo;
pub use mindmap_repo::VfsMindMapRepo;
pub use note_repo::VfsNoteRepo;
pub use path_cache_repo::{PathCacheEntry, PathCacheStats, VfsPathCacheRepo};
pub use question_repo::{
    AnswerSubmission,
    CreateQuestionParams,
    Difficulty,
    Question,
    QuestionBankStats,
    QuestionFilters,
    QuestionHistory,
    QuestionImage,
    QuestionListResult,
    QuestionOption,
    QuestionSearchFilters,
    QuestionSearchListResult,
    // FTS5 全文搜索相关导出
    QuestionSearchResult,
    QuestionStatus,
    QuestionType,
    SearchSortBy,
    SourceType,
    UpdateQuestionParams,
    VfsQuestionRepo,
    MAX_SEARCH_KEYWORD_LENGTH,
};
pub use resource_repo::VfsResourceRepo;
pub use textbook_repo::{PageIndexMeta, VfsTextbookRepo};
pub use translation_repo::VfsTranslationRepo;

pub use embedding_dim_repo::VfsEmbeddingDim;
pub use index_segment_repo::{CreateSegmentInput, ModalityDimStats, VfsIndexSegment};
pub use index_unit_repo::{CreateUnitInput, IndexState as UnitIndexState, UnitStats, VfsIndexUnit};
pub use review_plan_repo::{
    CreateReviewPlanParams, DueReviewsFilter, DueReviewsResult, RecordReviewHistoryParams,
    ReviewHistory, ReviewPlan, ReviewPlanStatus, ReviewStats, UpdateReviewPlanParams,
    VfsReviewPlanRepo,
};
