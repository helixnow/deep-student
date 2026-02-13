//! 多模态重排序服务
//!
//! 对召回结果进行多模态精排，弥补单向量召回的精度不足。
//!
//! ## 设计要点
//!
//! - **不存储模型配置**: 通过 LLMManager 动态获取配置
//! - **泛型设计**: 支持对任意实现 `RerankableItem` trait 的类型进行重排序
//! - **内容加载**: 重排序需要原始内容，服务负责协调从 Blob 加载图片
//!
//! 设计文档参考: docs/multimodal-knowledge-base-design.md (Section 7.4)

use std::sync::Arc;

use crate::llm_manager::LLMManager;
use crate::models::AppError;
use crate::multimodal::types::{MultimodalInput, VLRerankerResult};

type Result<T> = std::result::Result<T, AppError>;

/// 默认批量大小（重排序模型处理较慢）
const DEFAULT_BATCH_SIZE: usize = 10;

/// 可重排序项目的 trait
///
/// 实现此 trait 的类型可以被 MultimodalRerankerService 重排序
pub trait RerankableItem: Clone + Send + Sync {
    /// 获取项目的唯一标识
    fn item_id(&self) -> &str;

    /// 获取项目的原始分数
    fn original_score(&self) -> f32;

    /// 将项目转换为多模态输入
    fn to_multimodal_input(&self) -> MultimodalInput;

    /// 使用新分数创建副本
    fn with_score(&self, score: f32) -> Self;
}

/// 重排序服务配置
#[derive(Debug, Clone)]
pub struct RerankerServiceConfig {
    /// 单次 API 调用的最大文档数量
    pub batch_size: usize,
    /// 最小分数阈值（低于此分数的结果会被过滤）
    pub min_score_threshold: Option<f32>,
}

impl Default for RerankerServiceConfig {
    fn default() -> Self {
        Self {
            batch_size: DEFAULT_BATCH_SIZE,
            min_score_threshold: None,
        }
    }
}

/// 多模态重排序服务
///
/// 使用 Qwen3-VL-Reranker 对召回结果进行精排
pub struct MultimodalRerankerService {
    llm_manager: Arc<LLMManager>,
    config: RerankerServiceConfig,
}

impl MultimodalRerankerService {
    /// 创建新的重排序服务实例
    pub fn new(llm_manager: Arc<LLMManager>) -> Self {
        Self {
            llm_manager,
            config: RerankerServiceConfig::default(),
        }
    }

    /// 使用自定义配置创建重排序服务
    pub fn with_config(llm_manager: Arc<LLMManager>, config: RerankerServiceConfig) -> Self {
        Self {
            llm_manager,
            config,
        }
    }

    /// 检查多模态重排序模型是否已配置
    pub async fn is_configured(&self) -> bool {
        self.llm_manager.is_multimodal_rag_configured().await
    }

    /// 对候选文档进行重排序
    ///
    /// ## 参数
    /// - `query`: 查询内容（多模态输入）
    /// - `candidates`: 候选文档列表
    /// - `top_k`: 返回的最大结果数量
    ///
    /// ## 返回
    /// 按相关性分数降序排列的结果列表
    pub async fn rerank<T: RerankableItem>(
        &self,
        query: &MultimodalInput,
        candidates: &[T],
        top_k: usize,
    ) -> Result<Vec<T>> {
        if candidates.is_empty() {
            return Ok(Vec::new());
        }

        // 检查是否配置了多模态模型
        if !self.is_configured().await {
            log::warn!("未配置多模态重排序模型，返回原始排序");
            return Ok(candidates.iter().take(top_k).cloned().collect());
        }

        log::info!(
            "🔄 多模态重排序服务：开始处理 {} 个候选文档",
            candidates.len()
        );

        // 转换候选文档为多模态输入
        let doc_inputs: Vec<MultimodalInput> =
            candidates.iter().map(|c| c.to_multimodal_input()).collect();

        // 分批处理（如果候选数量超过批量大小）
        let scores = if candidates.len() <= self.config.batch_size {
            // 单批处理
            self.rerank_batch(query, &doc_inputs).await?
        } else {
            // 多批处理
            self.rerank_batched(query, &doc_inputs).await?
        };

        // 合并分数和候选文档
        let mut scored_items: Vec<(T, f32)> = candidates
            .iter()
            .zip(scores.iter())
            .map(|(item, &score)| (item.clone(), score))
            .collect();

        // 按分数降序排序
        scored_items.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        // 应用分数阈值过滤
        if let Some(threshold) = self.config.min_score_threshold {
            scored_items.retain(|(_, score)| *score >= threshold);
        }

        // 取 top_k 并更新分数
        let results: Vec<T> = scored_items
            .into_iter()
            .take(top_k)
            .map(|(item, score)| item.with_score(score))
            .collect();

        log::info!("✅ 多模态重排序完成：返回 {} 个结果", results.len());

        Ok(results)
    }

    /// 对多模态查询和文档进行直接重排序（不使用泛型）
    ///
    /// ## 参数
    /// - `query`: 查询内容
    /// - `documents`: 文档内容列表
    ///
    /// ## 返回
    /// 每个文档的相关性分数（与输入顺序对应）
    pub async fn rerank_raw(
        &self,
        query: &MultimodalInput,
        documents: &[MultimodalInput],
    ) -> Result<Vec<f32>> {
        if documents.is_empty() {
            return Ok(Vec::new());
        }

        if !self.is_configured().await {
            return Err(AppError::configuration("未配置多模态重排序模型"));
        }

        self.rerank_batched(query, documents).await
    }

    /// 批量重排序（分批处理大量文档）
    async fn rerank_batched(
        &self,
        query: &MultimodalInput,
        documents: &[MultimodalInput],
    ) -> Result<Vec<f32>> {
        let batch_size = self.config.batch_size;
        let mut all_scores = Vec::with_capacity(documents.len());

        for (batch_idx, chunk) in documents.chunks(batch_size).enumerate() {
            log::debug!(
                "  处理批次 {}: 文档 {}-{} / {}",
                batch_idx + 1,
                batch_idx * batch_size + 1,
                (batch_idx * batch_size + chunk.len()).min(documents.len()),
                documents.len()
            );

            let batch_scores = self.rerank_batch(query, chunk).await?;
            all_scores.extend(batch_scores);
        }

        Ok(all_scores)
    }

    /// 单批重排序
    async fn rerank_batch(
        &self,
        query: &MultimodalInput,
        documents: &[MultimodalInput],
    ) -> Result<Vec<f32>> {
        // 调用 LLMManager 的重排序 API
        let results = self
            .llm_manager
            .call_multimodal_reranker_api(query, documents)
            .await?;

        // 将结果转换为分数数组（按原始索引排序）
        let mut scores = vec![0.0f32; documents.len()];
        for result in results {
            if result.index < scores.len() {
                scores[result.index] = result.relevance_score;
            }
        }

        Ok(scores)
    }
}

/// 简单的可重排序项目包装器
///
/// 用于快速将现有数据结构包装为可重排序项目
#[derive(Debug, Clone)]
pub struct SimpleRerankItem {
    pub id: String,
    pub score: f32,
    pub input: MultimodalInput,
}

impl SimpleRerankItem {
    pub fn new(id: impl Into<String>, score: f32, input: MultimodalInput) -> Self {
        Self {
            id: id.into(),
            score,
            input,
        }
    }
}

impl RerankableItem for SimpleRerankItem {
    fn item_id(&self) -> &str {
        &self.id
    }

    fn original_score(&self) -> f32 {
        self.score
    }

    fn to_multimodal_input(&self) -> MultimodalInput {
        self.input.clone()
    }

    fn with_score(&self, score: f32) -> Self {
        Self {
            id: self.id.clone(),
            score,
            input: self.input.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_reranker_service_config_default() {
        let config = RerankerServiceConfig::default();
        assert_eq!(config.batch_size, DEFAULT_BATCH_SIZE);
        assert!(config.min_score_threshold.is_none());
    }

    #[test]
    fn test_simple_rerank_item() {
        let input = MultimodalInput::text("test content");
        let item = SimpleRerankItem::new("item_1", 0.5, input);

        assert_eq!(item.item_id(), "item_1");
        assert_eq!(item.original_score(), 0.5);

        let updated = item.with_score(0.9);
        assert_eq!(updated.score, 0.9);
        assert_eq!(updated.id, "item_1");
    }

    #[test]
    fn test_rerankable_trait() {
        let input = MultimodalInput::text("hello");
        let item = SimpleRerankItem::new("test", 0.3, input);

        // 验证 trait 方法
        let mm_input = item.to_multimodal_input();
        assert_eq!(mm_input.text, Some("hello".to_string()));
    }
}
