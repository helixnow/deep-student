//! VFS 嵌入生成服务
//!
//! ★ 2026-01 简化：VFS 只处理文本嵌入，多模态由 Multimodal 模块统一处理
//!
//! ## 核心功能
//! - 批量文本嵌入生成（带重试和退避）
//! - 多维度向量支持（自动适配不同嵌入模型）
//! - 进度回调支持
//! - 与 LLMManager 集成
//!
//! ## 架构说明
//! - VFS 只处理文本内容（MODALITY_TEXT）
//! - 多模态内容（图片/PDF）由 `crate::multimodal` 模块处理
//! - 两者使用独立的 Lance 表，互不干扰

use std::sync::Arc;
use tracing::{debug, info, warn};

use crate::llm_manager::LLMManager;
use crate::vfs::error::{VfsError, VfsResult};
use crate::vfs::indexing::TextChunk;
use crate::vfs::lance_store::{VfsLanceRow, VfsLanceStore};
use crate::vfs::repos::{VfsEmbedding, MODALITY_TEXT};

// ============================================================================
// 配置常量
// ============================================================================

/// 默认批处理大小
const DEFAULT_BATCH_SIZE: usize = 16;

/// 最大重试次数
const MAX_RETRIES: usize = 3;

/// 基础退避时间（毫秒）
const BASE_BACKOFF_MS: u64 = 400;

// ============================================================================
// 类型定义
// ============================================================================

/// 嵌入生成进度回调
pub type EmbeddingProgressCallback = Box<dyn Fn(usize, usize) + Send + Sync>;

/// 带嵌入的文本块
#[derive(Debug, Clone)]
pub struct ChunkWithEmbedding {
    pub chunk: TextChunk,
    pub embedding: Vec<f32>,
}

/// 嵌入生成结果
#[derive(Debug)]
pub struct EmbeddingResult {
    pub chunks: Vec<ChunkWithEmbedding>,
    pub embedding_dim: usize,
    pub model_config_id: String,
    pub modality: String,
}

/// 索引结果（包含写入 Lance 的 embedding_ids）
///
/// ★ 2026-01 修复：返回 embedding_ids 用于 SQLite lance_row_id 同步
#[derive(Debug, Clone)]
pub struct IndexChunksResult {
    /// 索引的块数量
    pub count: usize,
    /// 嵌入维度
    pub dim: usize,
    /// 写入 Lance 的 embedding_id 列表（与 chunks 一一对应）
    pub embedding_ids: Vec<String>,
}

// ============================================================================
// VfsEmbeddingService 实现
// ============================================================================

/// VFS 嵌入生成服务（仅文本）
///
/// 多模态内容由 `crate::multimodal` 模块统一处理。
///
/// 封装嵌入生成逻辑，支持批处理、重试和进度跟踪。
pub struct VfsEmbeddingService {
    llm_manager: Arc<LLMManager>,
    batch_size: usize,
}

impl VfsEmbeddingService {
    /// 创建新的嵌入服务
    pub fn new(llm_manager: Arc<LLMManager>) -> Self {
        Self {
            llm_manager,
            batch_size: DEFAULT_BATCH_SIZE,
        }
    }

    /// 创建带自定义批处理大小的嵌入服务
    pub fn with_batch_size(llm_manager: Arc<LLMManager>, batch_size: usize) -> Self {
        Self {
            llm_manager,
            batch_size: batch_size.max(1),
        }
    }

    /// 获取当前配置的嵌入模型 ID
    ///
    /// 从维度管理的默认设置中获取嵌入模型配置ID
    pub async fn get_embedding_model_id(&self) -> VfsResult<String> {
        let config = self
            .llm_manager
            .get_embedding_model_config()
            .await
            .map_err(|e| VfsError::Other(format!("获取嵌入模型配置失败: {}", e)))?;

        Ok(config.id)
    }

    /// 获取当前配置的嵌入模型 ID 和名称
    pub async fn get_embedding_model_info(&self) -> VfsResult<(String, String)> {
        let model_id = self.get_embedding_model_id().await?;

        // 从模型配置中获取模型名称
        let model_name = self
            .llm_manager
            .get_api_configs()
            .await
            .ok()
            .and_then(|configs| {
                configs
                    .into_iter()
                    .find(|cfg| cfg.id == model_id)
                    .map(|cfg| cfg.name)
            })
            .unwrap_or_else(|| model_id.clone());

        Ok((model_id, model_name))
    }

    /// 生成单个文本的嵌入向量
    pub async fn generate_embedding(&self, text: &str) -> VfsResult<Vec<f32>> {
        let model_id = self.get_embedding_model_id().await?;

        let embeddings = self
            .llm_manager
            .call_embedding_api(vec![text.to_string()], &model_id)
            .await
            .map_err(|e| VfsError::Other(format!("生成嵌入向量失败: {}", e)))?;

        embeddings
            .into_iter()
            .next()
            .ok_or_else(|| VfsError::Other("嵌入 API 返回空结果".to_string()))
    }

    /// 批量生成嵌入向量
    ///
    /// ## 参数
    /// - `texts`: 待嵌入的文本列表
    ///
    /// ## 返回
    /// 与输入顺序对应的嵌入向量列表
    pub async fn generate_embeddings_batch(&self, texts: Vec<String>) -> VfsResult<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }

        let model_id = self.get_embedding_model_id().await?;
        let total = texts.len();
        let mut all_embeddings = Vec::with_capacity(total);
        let mut start = 0usize;

        while start < total {
            let end = (start + self.batch_size).min(total);
            let batch: Vec<String> = texts[start..end].to_vec();

            debug!(
                "[VfsEmbeddingService] Processing batch {}-{}/{} (model: {})",
                start + 1,
                end,
                total,
                model_id
            );

            let batch_embeddings = self
                .generate_batch_with_retry(&batch, &model_id, start, end, total)
                .await?;

            if batch_embeddings.len() != batch.len() {
                return Err(VfsError::Other(format!(
                    "嵌入数量不匹配: expected {}, got {}",
                    batch.len(),
                    batch_embeddings.len()
                )));
            }

            all_embeddings.extend(batch_embeddings);
            start = end;
        }

        info!(
            "[VfsEmbeddingService] Generated {} embeddings",
            all_embeddings.len()
        );

        Ok(all_embeddings)
    }

    /// 为文本块生成嵌入
    ///
    /// ## 参数
    /// - `chunks`: 文本块列表
    /// - `progress_callback`: 可选的进度回调 (processed, total)
    ///
    /// ## 返回
    /// 带嵌入的文本块列表和嵌入维度
    pub async fn generate_embeddings_for_chunks(
        &self,
        chunks: Vec<TextChunk>,
        progress_callback: Option<EmbeddingProgressCallback>,
    ) -> VfsResult<EmbeddingResult> {
        if chunks.is_empty() {
            return Ok(EmbeddingResult {
                chunks: Vec::new(),
                embedding_dim: 0,
                model_config_id: String::new(),
                modality: "text".to_string(),
            });
        }

        let model_id = self.get_embedding_model_id().await?;
        let total = chunks.len();
        let mut results = Vec::with_capacity(total);
        let mut embedding_dim = 0usize;
        let mut start = 0usize;

        info!(
            "[VfsEmbeddingService] Starting embedding generation for {} chunks",
            total
        );

        while start < total {
            let end = (start + self.batch_size).min(total);
            let batch_chunks = &chunks[start..end];
            let batch_texts: Vec<String> = batch_chunks.iter().map(|c| c.text.clone()).collect();

            debug!(
                "[VfsEmbeddingService] Batch {}-{}/{} (model: {})",
                start + 1,
                end,
                total,
                model_id
            );

            let batch_embeddings = self
                .generate_batch_with_retry(&batch_texts, &model_id, start, end, total)
                .await?;

            if batch_embeddings.len() != batch_chunks.len() {
                return Err(VfsError::Other(format!(
                    "嵌入数量不匹配: expected {}, got {}",
                    batch_chunks.len(),
                    batch_embeddings.len()
                )));
            }

            // 记录嵌入维度（第一个有效嵌入）
            if embedding_dim == 0 && !batch_embeddings.is_empty() {
                embedding_dim = batch_embeddings[0].len();
            }

            for (i, chunk) in batch_chunks.iter().enumerate() {
                results.push(ChunkWithEmbedding {
                    chunk: chunk.clone(),
                    embedding: batch_embeddings[i].clone(),
                });
            }

            // 调用进度回调
            if let Some(ref callback) = progress_callback {
                callback(end, total);
            }

            start = end;
        }

        info!(
            "[VfsEmbeddingService] Completed: {} embeddings, dim={}",
            results.len(),
            embedding_dim
        );

        Ok(EmbeddingResult {
            chunks: results,
            embedding_dim,
            model_config_id: model_id,
            modality: MODALITY_TEXT.to_string(),
        })
    }

    /// 带重试的批次嵌入生成
    async fn generate_batch_with_retry(
        &self,
        texts: &[String],
        model_id: &str,
        start: usize,
        end: usize,
        total: usize,
    ) -> VfsResult<Vec<Vec<f32>>> {
        let mut attempt = 0usize;

        loop {
            match self
                .llm_manager
                .call_embedding_api(texts.to_vec(), model_id)
                .await
            {
                Ok(embeddings) => {
                    return Ok(embeddings);
                }
                Err(e) => {
                    attempt += 1;
                    if attempt >= MAX_RETRIES {
                        return Err(VfsError::Other(format!(
                            "嵌入生成失败 (批次 {}-{}/{}): {} (已重试 {} 次)",
                            start + 1,
                            end,
                            total,
                            e,
                            MAX_RETRIES
                        )));
                    }

                    // 指数退避: 400ms, 800ms, 1600ms, ...
                    let backoff_ms = BASE_BACKOFF_MS * (1u64 << (attempt - 1));
                    warn!(
                        "[VfsEmbeddingService] Batch {}-{} failed, retrying in {}ms (attempt {}/{}): {}",
                        start + 1,
                        end,
                        backoff_ms,
                        attempt,
                        MAX_RETRIES,
                        e
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
                }
            }
        }
    }

    /// 将带嵌入的块转换为 VfsLanceRow 格式
    ///
    /// ## 参数
    /// - `chunks`: 带嵌入的文本块
    /// - `resource_id`: 资源 ID
    /// - `resource_type`: 资源类型
    /// - `folder_id`: 可选的文件夹 ID
    ///
    /// ## 返回
    /// 可写入 Lance 的行数据
    pub fn chunks_to_lance_rows(
        chunks: &[ChunkWithEmbedding],
        resource_id: &str,
        resource_type: &str,
        folder_id: Option<&str>,
    ) -> Vec<VfsLanceRow> {
        let now = chrono::Utc::now().to_rfc3339();

        let has_page_index_count = chunks
            .iter()
            .filter(|c| c.chunk.page_index.is_some())
            .count();
        let has_source_id_count = chunks
            .iter()
            .filter(|c| c.chunk.source_id.is_some())
            .count();
        log::info!(
            "[VfsEmbeddingService] chunks_to_lance_rows: {} chunks, {} with page_index, {} with source_id",
            chunks.len(), has_page_index_count, has_source_id_count
        );

        chunks
            .iter()
            .map(|c| {
                let metadata_json = if c.chunk.page_index.is_some() || c.chunk.source_id.is_some() {
                    Some(
                        serde_json::json!({
                            "page_index": c.chunk.page_index,
                            "source_id": c.chunk.source_id,
                        })
                        .to_string(),
                    )
                } else {
                    None
                };

                VfsLanceRow {
                    embedding_id: VfsEmbedding::generate_id(),
                    resource_id: resource_id.to_string(),
                    resource_type: resource_type.to_string(),
                    folder_id: folder_id.map(|s| s.to_string()),
                    chunk_index: c.chunk.index as i32,
                    text: c.chunk.text.clone(),
                    metadata_json,
                    created_at: now.clone(),
                    embedding: c.embedding.clone(),
                }
            })
            .collect()
    }
}

// ============================================================================
// VfsEmbeddingPipeline - 集成索引流水线
// ============================================================================

/// VFS 嵌入流水线
///
/// 组合嵌入服务和 Lance 存储，提供完整的索引流水线。
pub struct VfsEmbeddingPipeline {
    embedding_service: VfsEmbeddingService,
    lance_store: Arc<VfsLanceStore>,
}

impl VfsEmbeddingPipeline {
    /// 创建新的嵌入流水线
    pub fn new(llm_manager: Arc<LLMManager>, lance_store: Arc<VfsLanceStore>) -> Self {
        Self {
            embedding_service: VfsEmbeddingService::new(llm_manager),
            lance_store,
        }
    }

    /// 索引资源的文本块
    ///
    /// ## 参数
    /// - `resource_id`: 资源 ID
    /// - `resource_type`: 资源类型（如 "note", "textbook"）
    /// - `folder_id`: 可选的文件夹 ID
    /// - `chunks`: 文本块列表
    /// - `modality`: 模态类型 (text/image/multimodal)
    /// - `progress_callback`: 可选的进度回调
    ///
    /// ## 返回
    /// 索引资源的文本块
    ///
    /// ★ 2026-01 修复：返回 IndexChunksResult 包含 embedding_ids，用于 SQLite lance_row_id 同步
    pub async fn index_chunks(
        &self,
        resource_id: &str,
        resource_type: &str,
        folder_id: Option<&str>,
        chunks: Vec<TextChunk>,
        modality: &str,
        progress_callback: Option<EmbeddingProgressCallback>,
    ) -> VfsResult<IndexChunksResult> {
        if chunks.is_empty() {
            return Ok(IndexChunksResult {
                count: 0,
                dim: 0,
                embedding_ids: Vec::new(),
            });
        }

        // VFS 只支持文本模态
        if modality != MODALITY_TEXT {
            return Err(VfsError::Other(format!(
                "VFS 只支持文本模态，多模态内容请使用 crate::multimodal 模块"
            )));
        }

        // 1. 生成嵌入
        let result = self
            .embedding_service
            .generate_embeddings_for_chunks(chunks, progress_callback)
            .await?;

        if result.chunks.is_empty() {
            return Ok(IndexChunksResult {
                count: 0,
                dim: 0,
                embedding_ids: Vec::new(),
            });
        }

        // 2. 转换为 Lance 行格式
        let rows = VfsEmbeddingService::chunks_to_lance_rows(
            &result.chunks,
            resource_id,
            resource_type,
            folder_id,
        );

        // 3. 保存 embedding_ids（用于 SQLite lance_row_id 同步）
        let embedding_ids: Vec<String> = rows.iter().map(|r| r.embedding_id.clone()).collect();

        // 4. 写入 Lance 存储（使用指定模态）
        self.lance_store.write_chunks(modality, &rows).await?;

        let count = result.chunks.len();
        let dim = result.embedding_dim;

        info!(
            "[VfsEmbeddingPipeline] Indexed {} chunks for resource {} (modality={}, dim={})",
            count, resource_id, modality, dim
        );

        Ok(IndexChunksResult {
            count,
            dim,
            embedding_ids,
        })
    }

    /// 删除资源的索引
    pub async fn delete_resource_index(&self, resource_id: &str) -> VfsResult<usize> {
        // VFS 只删除文本索引
        self.lance_store
            .delete_by_resource(MODALITY_TEXT, resource_id)
            .await
    }

    /// 重新索引资源
    ///
    /// 先删除旧索引，再生成新索引。
    pub async fn reindex_chunks(
        &self,
        resource_id: &str,
        resource_type: &str,
        folder_id: Option<&str>,
        chunks: Vec<TextChunk>,
        modality: &str,
        progress_callback: Option<EmbeddingProgressCallback>,
    ) -> VfsResult<IndexChunksResult> {
        // 1. 删除旧索引
        self.delete_resource_index(resource_id).await?;

        // 2. 创建新索引
        self.index_chunks(
            resource_id,
            resource_type,
            folder_id,
            chunks,
            modality,
            progress_callback,
        )
        .await
    }

    /// 获取嵌入服务引用
    pub fn embedding_service(&self) -> &VfsEmbeddingService {
        &self.embedding_service
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_modality_support() {
        // VFS 只支持文本模态
        assert_eq!(MODALITY_TEXT, "text");
    }

    #[test]
    fn test_chunks_to_lance_rows() {
        let chunks = vec![
            ChunkWithEmbedding {
                chunk: TextChunk {
                    index: 0,
                    text: "Hello world".to_string(),
                    start_pos: 0,
                    end_pos: 11,
                    page_index: Some(0),
                    source_id: Some("test_source".to_string()),
                },
                embedding: vec![0.1, 0.2, 0.3],
            },
            ChunkWithEmbedding {
                chunk: TextChunk {
                    index: 1,
                    text: "Second chunk".to_string(),
                    start_pos: 12,
                    end_pos: 24,
                    page_index: Some(1),
                    source_id: Some("test_source".to_string()),
                },
                embedding: vec![0.4, 0.5, 0.6],
            },
        ];

        let rows = VfsEmbeddingService::chunks_to_lance_rows(
            &chunks,
            "resource_123",
            "note",
            Some("folder_456"),
        );

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].resource_id, "resource_123");
        assert_eq!(rows[0].resource_type, "note");
        assert_eq!(rows[0].folder_id, Some("folder_456".to_string()));
        assert_eq!(rows[0].chunk_index, 0);
        assert_eq!(rows[0].text, "Hello world");
        assert_eq!(rows[0].embedding, vec![0.1, 0.2, 0.3]);

        assert_eq!(rows[1].chunk_index, 1);
        assert_eq!(rows[1].text, "Second chunk");
    }
}
