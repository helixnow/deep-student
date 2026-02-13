use crate::models::{
    AppError, DocumentChunk, DocumentChunkWithEmbedding, RetrievedChunk, VectorStoreStats,
};
use async_trait::async_trait;
use serde_json::Value;
use std::any::Any;

type Result<T> = std::result::Result<T, AppError>;

/// 向量存储抽象接口
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

    /// 带 FTS 预筛的混合检索（所有库）
    async fn search_similar_chunks_with_prefilter(
        &self,
        query_text: &str,
        query_embedding: Vec<f32>,
        top_k: usize,
    ) -> Result<Vec<RetrievedChunk>>;

    /// 带 FTS 预筛的混合检索（限定分库）
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
