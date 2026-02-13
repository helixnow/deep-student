//! VFS (Virtual File System) 虚拟文件系统模块
//!
//! 本模块实现统一虚拟文件系统，作为 Chat V2 上下文注入系统的唯一数据来源（SSOT）。
//!
//! ## 核心概念
//! - **单一数据库**：使用单个 `vfs.db`，通过文件夹层级实现资源组织
//! - **全局去重**：基于 SHA-256 哈希全局去重
//! - **统一资源协议**：所有模块数据通过 VFS 暴露给 Chat V2 上下文注入
//!
//! ## 模块结构
//! ```text
//! vfs/
//! ├── mod.rs           - 模块注册和 re-export
//! ├── types.rs         - 核心类型定义
//! ├── error.rs         - 错误类型
//! ├── database.rs      - VfsDatabase 连接池管理
//! ├── handlers.rs      - Tauri 命令（Prompt 3）
//! └── repos/           - 各表 CRUD
//! ```
//!
//! ## 迁移系统
//! Schema 迁移已统一到 data_governance 模块，使用 Refinery 框架。
//! 迁移文件位于 src-tauri/migrations/vfs/ 目录。

pub mod attachment_config;
pub mod database;
pub mod embedding_service;
pub mod error;
pub mod handlers;
pub mod index_handlers;
pub mod index_service;
pub mod indexing;
pub mod lance_store;
pub mod multimodal_service;
pub mod ocr_utils;
pub mod pdf_processing_service;
pub mod ref_handlers;
pub mod repos;
pub mod types;
pub mod unit_builder;

pub use database::{VfsDatabase, VfsDatabaseStats, VfsPool, VfsPooledConnection};
pub use embedding_service::{
    ChunkWithEmbedding, EmbeddingResult, VfsEmbeddingPipeline, VfsEmbeddingService,
};
pub use error::{VfsError, VfsResult};
pub use indexing::{
    ChunkingConfig, IndexingConfig, PageText, SearchConfig, TextChunk, VfsChunker,
    VfsContentExtractor, VfsDimensionStat, VfsEmbeddingStats, VfsFullIndexingService,
    VfsFullSearchService, VfsIndexingService, VfsSearchMode, VfsSearchParams, VfsSearchResult,
    VfsSearchService,
};
pub use lance_store::{VfsLanceRow, VfsLanceSearchResult, VfsLanceStore};
pub use multimodal_service::{
    VfsMultimodalIndexResult, VfsMultimodalPage, VfsMultimodalSearchResult, VfsMultimodalService,
    VfsMultimodalStats,
};
pub use pdf_processing_service::{
    PdfProcessingCompletedEvent, PdfProcessingErrorEvent, PdfProcessingProgressEvent,
    PdfProcessingService, ProcessingProgress, ProcessingStage, ProcessingStatus,
};
pub use repos::{
    IndexState, VfsDimensionRepo, VfsEmbedding, VfsEmbeddingDimension, VfsIndexStateRepo,
    VfsIndexingConfigRepo, INDEX_STATE_DISABLED, INDEX_STATE_FAILED, INDEX_STATE_INDEXED,
    INDEX_STATE_INDEXING, INDEX_STATE_PENDING, MODALITY_MULTIMODAL, MODALITY_TEXT,
    VFS_EMB_TABLE_PREFIX,
};
pub use repos::{
    VfsAttachmentRepo, VfsBlobRepo, VfsEssayRepo, VfsExamRepo, VfsFileRepo, VfsFolderRepo,
    VfsMindMapRepo, VfsNoteRepo, VfsResourceRepo, VfsTextbookRepo, VfsTranslationRepo,
};
pub use types::*;

// 统一文本抽取策略（供 DSTU 等其他模块调用）
pub use ref_handlers::extract_file_text_with_strategy;

// ============================================================================
// 文件夹相关常量（契约 F）
// ============================================================================

/// 最大文件夹深度
pub const MAX_FOLDER_DEPTH: usize = 10;

/// 单科目最大文件夹数
pub const MAX_FOLDERS_PER_SUBJECT: usize = 500;

/// 单文件夹最大内容数
pub const MAX_ITEMS_PER_FOLDER: usize = 1000;

/// 文件夹名称最大长度
pub const MAX_FOLDER_TITLE_LENGTH: usize = 100;

/// 批量注入最大资源数
pub const MAX_INJECT_RESOURCES: usize = 50;

// ============================================================================
// 文件夹错误码（契约 H）
// ============================================================================

/// 文件夹相关错误码
pub mod folder_errors {
    /// 文件夹不存在
    pub const NOT_FOUND: &str = "FOLDER_NOT_FOUND";
    /// 文件夹已存在（幂等检查）
    pub const ALREADY_EXISTS: &str = "FOLDER_ALREADY_EXISTS";
    /// 超过最大深度
    pub const DEPTH_EXCEEDED: &str = "FOLDER_DEPTH_EXCEEDED";
    /// 内容项不存在
    pub const ITEM_NOT_FOUND: &str = "FOLDER_ITEM_NOT_FOUND";
    /// 迁移失败
    pub const MIGRATION_FAILED: &str = "MIGRATION_FAILED";
    /// 无效的父文件夹
    pub const INVALID_PARENT: &str = "INVALID_PARENT";
    /// 超过文件夹数量限制
    pub const COUNT_EXCEEDED: &str = "FOLDER_COUNT_EXCEEDED";
}
