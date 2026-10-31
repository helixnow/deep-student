//! 多模态知识库支撑模块
//!
//! 真实的索引/检索编排在 VFS 多模态服务（crate::vfs::multimodal_service），
//! 本模块仅保留被 VFS 服务 / llm_manager 依赖的核心组件：
//! - `types`: 核心类型定义（MultimodalInput、VLEmbeddingInputItem/VLRerankerResult、
//!   MultimodalIndexingMode、IndexProgressEvent）
//! - `embedding_service` / `embedding_chunker`: 多模态/文本嵌入生成与长文本分块
//! - `page_indexer`: preview_json 反序列化结构（AttachmentPreview）
//!
//! 历史清理记录：
//! - 2026-06-13 round2 · G1：`vector_store` / `reranker_service` / `retriever` 死代码整体删除；
//!   `dimension_registry` 由 VfsDimensionRepo 替代（更早移除）。
//! - 2026-07-19：types.rs 死类型清理（SourceType / PageEmbeddingMetadata /
//!   MultimodalRetrievalResult / MultimodalRetrievalConfig / DimensionRegistry /
//!   PageIndexTask / PageIndexLog / IndexResult / VLRerankerRequest）。

// 核心类型定义（仍需保留）
pub mod types;

// 嵌入服务（VFS 多模态服务依赖）
pub mod embedding_chunker;
pub mod embedding_service;

// preview_json 反序列化结构（VFS 多模态服务依赖 AttachmentPreview）
pub mod page_indexer;

// 重新导出常用类型
pub use types::{
    // 输入类型
    MultimodalImage,
    // 索引相关
    MultimodalIndexingMode,
    MultimodalInput,
    MultimodalVideo,
    // API 类型
    VLEmbeddingInputItem,
    VLRerankerResult, // llm_manager 依赖
};

// 嵌入服务导出
pub use embedding_service::{EmbeddingServiceConfig, MultimodalEmbeddingService};

// preview 结构导出（VFS 需要 AttachmentPreview）
pub use page_indexer::AttachmentPreview;
