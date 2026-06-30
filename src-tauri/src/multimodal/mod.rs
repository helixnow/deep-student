//! 多模态知识库模块
//!
//! ★ 2026-01 清理说明：
//! - 索引和检索已迁移到 VFS 多模态服务（crate::vfs::multimodal_service）
//! - 本模块仅保留被 VFS 服务 / llm_manager 依赖的核心组件：
//!   - `types`: 核心类型定义（含 VLRerankerResult / VLEmbeddingInputItem，llm_manager 依赖）
//!   - `embedding_service` / `embedding_chunker`: 多模态嵌入生成
//!   - `page_indexer`: preview_json 反序列化结构（AttachmentPreview）
//!
//! 已移除（2026-06-13 round2 · G1 死代码清理）：
//! - `vector_store`(MultimodalVectorStore) / `reranker_service` / `retriever`：
//!   仅服务于已废弃的 PageIndexer/Retriever，全仓无活跃引用，已整体删除。
//! - `dimension_registry`: 使用 VfsDimensionRepo 替代（更早移除）。

// 核心类型定义（仍需保留）
pub mod types;

// 嵌入服务（VFS 多模态服务依赖）
pub mod embedding_chunker;
pub mod embedding_service;

// preview_json 反序列化结构（VFS 多模态服务依赖 AttachmentPreview）
pub mod page_indexer;

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

// preview 结构导出（VFS 需要 AttachmentPreview）
pub use page_indexer::AttachmentPreview;
