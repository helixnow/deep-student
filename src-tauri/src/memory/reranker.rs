//! 重排序模块
//!
//! 对检索结果进行二次排序，提高相关性。
//! 适配 VFS Memory

use std::sync::Arc;

use anyhow::Result;

use super::service::MemorySearchResult;
use crate::llm_manager::LLMManager;

/// 重排序策略
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RerankerStrategy {
    /// 基于规则的重排序（默认，无需额外 API 调用）
    RuleBased,
    /// API 重排序（使用项目配置的专用重排序模型）
    Api,
}

impl Default for RerankerStrategy {
    fn default() -> Self {
        Self::RuleBased
    }
}

/// 重排序器
pub struct MemoryReranker {
    strategy: RerankerStrategy,
    llm_manager: Option<Arc<LLMManager>>,
}

impl MemoryReranker {
    /// 创建基于规则的重排序器
    pub fn new_rule_based() -> Self {
        Self {
            strategy: RerankerStrategy::RuleBased,
            llm_manager: None,
        }
    }

    /// 创建 API 重排序器
    pub fn new_api(llm_manager: Arc<LLMManager>) -> Self {
        Self {
            strategy: RerankerStrategy::Api,
            llm_manager: Some(llm_manager),
        }
    }

    /// 智能创建重排序器：如果配置了重排序模型则使用 API，否则使用规则
    pub async fn new_auto(llm_manager: Arc<LLMManager>) -> Self {
        // 检查是否配置了重排序模型
        let has_reranker = match llm_manager.get_model_assignments().await {
            Ok(assignments) => assignments.reranker_model_config_id.is_some(),
            Err(_) => false,
        };

        if has_reranker {
            tracing::info!("[MemoryReranker] 检测到重排序模型配置，使用 API 策略");
            Self::new_api(llm_manager)
        } else {
            tracing::debug!("[MemoryReranker] 未配置重排序模型，使用规则策略");
            Self::new_rule_based()
        }
    }

    /// 获取当前策略
    pub fn strategy(&self) -> RerankerStrategy {
        self.strategy
    }

    /// 执行重排序
    pub async fn rerank(
        &self,
        query: &str,
        mut results: Vec<MemorySearchResult>,
    ) -> Result<Vec<MemorySearchResult>> {
        if results.is_empty() {
            return Ok(results);
        }

        match self.strategy {
            RerankerStrategy::RuleBased => {
                self.rerank_rule_based(query, &mut results);
                Ok(results)
            }
            RerankerStrategy::Api => {
                self.rerank_api(query, &mut results).await?;
                Ok(results)
            }
        }
    }

    /// 基于规则的重排序
    fn rerank_rule_based(&self, query: &str, results: &mut Vec<MemorySearchResult>) {
        let query_lower = query.to_lowercase();
        let query_words: Vec<&str> = query_lower.split_whitespace().collect();

        for result in results.iter_mut() {
            let mut boost = 0.0f32;

            // 标题匹配加分
            let title_lower = result.note_title.to_lowercase();
            for word in &query_words {
                if title_lower.contains(word) {
                    boost += 0.1;
                }
            }

            // 精确标题匹配大加分
            if title_lower.contains(&query_lower) {
                boost += 0.2;
            }

            // 更新分数
            result.score = (result.score + boost).min(1.0);
        }

        // 按分数降序排序
        results.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }

    /// API 重排序：调用 LLMManager 的 reranker API
    async fn rerank_api(&self, query: &str, results: &mut Vec<MemorySearchResult>) -> Result<()> {
        use crate::models::{DocumentChunk, RetrievedChunk};

        let llm = match &self.llm_manager {
            Some(m) => m.clone(),
            None => {
                tracing::warn!("[MemoryReranker] API 策略但无 LLMManager，降级为规则排序");
                self.rerank_rule_based(query, results);
                return Ok(());
            }
        };

        if results.is_empty() {
            return Ok(());
        }

        let model_config_id = match llm.get_model_assignments().await {
            Ok(a) => match a.reranker_model_config_id {
                Some(id) => id,
                None => {
                    tracing::debug!("[MemoryReranker] No reranker model configured, falling back");
                    self.rerank_rule_based(query, results);
                    return Ok(());
                }
            },
            Err(_) => {
                self.rerank_rule_based(query, results);
                return Ok(());
            }
        };

        let chunks: Vec<RetrievedChunk> = results
            .iter()
            .enumerate()
            .map(|(i, r)| {
                let text = if r.chunk_text.is_empty() {
                    r.note_title.clone()
                } else {
                    format!("{}: {}", r.note_title, r.chunk_text)
                };
                RetrievedChunk {
                    chunk: DocumentChunk {
                        id: r.note_id.clone(),
                        document_id: r.note_id.clone(),
                        chunk_index: i,
                        text,
                        metadata: std::collections::HashMap::new(),
                    },
                    score: r.score,
                }
            })
            .collect();

        match llm
            .call_reranker_api(query.to_string(), chunks, &model_config_id)
            .await
        {
            Ok(reranked) => {
                let original = results.clone();
                results.clear();
                for rc in &reranked {
                    let idx = rc.chunk.chunk_index;
                    if let Some(mut item) = original.get(idx).cloned() {
                        item.score = rc.score;
                        results.push(item);
                    }
                }

                tracing::info!(
                    "[MemoryReranker] API 重排序完成: {} results reranked",
                    results.len()
                );
            }
            Err(e) => {
                tracing::warn!(
                    "[MemoryReranker] API 重排序失败，降级为规则排序: {}",
                    e
                );
                self.rerank_rule_based(query, results);
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rule_based_reranking() {
        let reranker = MemoryReranker::new_rule_based();
        assert_eq!(reranker.strategy(), RerankerStrategy::RuleBased);
    }

    #[test]
    fn test_reranker_strategy_default() {
        assert_eq!(RerankerStrategy::default(), RerankerStrategy::RuleBased);
    }
}
