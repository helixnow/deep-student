//! # 向量存储抽象接口（维护模式）
//!
//! ⚠️ 退役计划说明（2026-07）：
//! - 本 trait 目前只有 `LanceVectorStore` 一个实现，且没有任何外部多态使用
//!   （无 `dyn VectorStore` / 泛型约束调用方），属于悬空抽象。
//! - 活跃的知识库检索已迁移至 `vfs::lance_store::VfsLanceStore`，本层仅为
//!   遗留 KB 数据与聊天向量维护保留。
//! - 保留 trait 与全部公开方法签名是为了兼容可能存在的并行任务/外部调用；
//!   新代码不应再实现或依赖本 trait，待确认无调用方后整体移除。

use crate::models::{
    AppError, DocumentChunk, DocumentChunkWithEmbedding, RetrievedChunk, VectorStoreStats,
};
use async_trait::async_trait;
use serde_json::Value;
use std::any::Any;

type Result<T> = std::result::Result<T, AppError>;

/// 向量存储抽象接口（维护模式，见模块级说明；请勿在新代码中使用）
#[async_trait]
pub trait VectorStore: Send + Sync {
    /// 添加文档块和对应的向量
    async fn add_chunks(&self, chunks: Vec<DocumentChunkWithEmbedding>) -> Result<()>;

    /// 搜索相似的文档块
    async fn search_similar_chunks(
        &self,
        query_embedding: Vec<f32>,
        top_k: usize,
    ) -> Result<Vec<RetrievedChunk>>;

    /// 在指定分库中搜索相似的文档块
    async fn search_similar_chunks_in_libraries(
        &self,
        query_embedding: Vec<f32>,
        top_k: usize,
        sub_library_ids: Option<Vec<String>>,
    ) -> Result<Vec<RetrievedChunk>>;

    /// 混合检索（所有库）。
    /// 命名沿革：早期实现依赖 SQLite FTS 预筛，现由 LanceDB 原生
    /// FTS + 向量混合检索完成，方法名仅为兼容保留。
    async fn search_similar_chunks_with_prefilter(
        &self,
        query_text: &str,
        query_embedding: Vec<f32>,
        top_k: usize,
    ) -> Result<Vec<RetrievedChunk>>;

    /// 混合检索（限定分库）。命名沿革同 `search_similar_chunks_with_prefilter`。
    async fn search_similar_chunks_in_libraries_with_prefilter(
        &self,
        query_text: &str,
        query_embedding: Vec<f32>,
        top_k: usize,
        sub_library_ids: Option<Vec<String>>,
    ) -> Result<Vec<RetrievedChunk>>;

    /// 根据文档ID删除所有相关块
    async fn delete_chunks_by_document_id(&self, document_id: &str) -> Result<()>;

    /// 清理指定文档的所有块，但保留文档头信息（默认回退为彻底删除）。
    async fn clear_document_chunks_keep_header(&self, document_id: &str) -> Result<()> {
        self.delete_chunks_by_document_id(document_id).await
    }

    /// 删除指定 chunk_id 列表（用于增量更新）
    async fn delete_chunks_by_ids(&self, chunk_ids: Vec<String>) -> Result<()>;

    /// 按 document_id 读取所有已存储的文档块（按 chunk_index 排序）
    async fn load_document_chunks(&self, document_id: &str) -> Result<Vec<DocumentChunk>> {
        let _ = document_id;
        Err(AppError::not_implemented(
            "当前向量后端未实现 load_document_chunks",
        ))
    }

    /// 获取统计信息
    async fn get_stats(&self) -> Result<VectorStoreStats>;

    /// 清空所有向量数据
    async fn clear_all(&self) -> Result<()>;

    /// 文档元数据管理（保持在 SQLite）
    fn add_document_record_with_library(
        &self,
        document_id: &str,
        file_name: &str,
        file_path: Option<&str>,
        file_size: Option<u64>,
        sub_library_id: &str,
    ) -> Result<()>;
    fn update_document_chunk_count(&self, document_id: &str, chunk_count: usize) -> Result<()>;
    fn get_all_documents(&self) -> Result<Vec<Value>>;
    fn as_any(&self) -> &dyn Any;
}
