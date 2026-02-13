//! 多模态知识库模块
//!
//! ★ 2026-01 清理说明：
//! - 索引和检索已迁移到 VFS 多模态服务（crate::vfs::multimodal_service）
//! - 本模块仅保留被 VFS 服务依赖的核心组件：
//!   - `types`: 核心类型定义
//!   - `embedding_service`: 多模态嵌入生成
//!   - `page_indexer`: 页面索引元数据解析
//!
//! 已废弃（不再导出）：
//! - `vector_store`: 使用 VFS Lance Store 替代
//! - `retriever`: 使用 VfsMultimodalService.search 替代
//! - `dimension_registry`: 使用 VfsDimensionRepo 替代

// 核心类型定义（仍需保留）
pub mod types;

// 嵌入服务（VFS 多模态服务依赖）
pub mod embedding_chunker;
pub mod embedding_service;

// 页面索引器（VFS 多模态服务依赖）
pub mod page_indexer;

// ★ 以下模块仍需保留（内部依赖）
pub mod reranker_service;
pub mod vector_store; // page_indexer 依赖 // llm_manager 依赖
                      // ★ retriever 已废弃; dimension_registry.rs 已删除（S1 fix: 迁移到 VFS embedding_dim_repo）

// 重新导出常用类型
pub use types::{
    MultimodalImage,
    // 索引相关
    MultimodalIndexingMode,
    // 输入类型
    MultimodalInput,
    MultimodalVideo,
    // 元数据
    PageEmbeddingMetadata,
    // 来源类型
    SourceType,
    // API 类型
    VLEmbeddingInputItem,
    VLRerankerResult, // llm_manager 依赖
};

// 嵌入服务导出
pub use embedding_service::{EmbeddingServiceConfig, MultimodalEmbeddingService};

// 页面索引器导出（VFS 需要 AttachmentPreview）
pub use page_indexer::{AttachmentPreview, PageIndexer};
