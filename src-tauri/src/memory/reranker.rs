//! 重排序模块
//!
//! 对检索结果进行二次排序，提高相关性。
//! 当配置了专用重排序模型时使用 API 重排序，否则透传（不做额外处理）。

use std::sync::Arc;

use anyhow::Result;

use super::service::MemorySearchResult;
use crate::llm_manager::LLMManager;

pub struct MemoryReranker {
    llm_manager: Arc<LLMManager>,
    has_api: bool,
}

impl MemoryReranker {
    pub async fn new(llm_manager: Arc<LLMManager>) -> Self {
        let has_api = match llm_manager.get_model_assignments().await {
            Ok(assignments) => assignments.reranker_model_config_id.is_some(),
            Err(_) => false,
        };

        if has_api {
            tracing::info!("[MemoryReranker] 检测到重排序模型配置，启用 API 重排序");
        }

        Self { llm_manager, has_api }
    }

    pub fn has_reranker_api(&self) -> bool {
        self.has_api
    }

    pub async fn rerank(
        &self,
        query: &str,
        mut results: Vec<MemorySearchResult>,
    ) -> Result<Vec<MemorySearchResult>> {
        if results.is_empty() || !self.has_api {
            return Ok(results);
        }

        self.rerank_api(query, &mut results).await?;
        Ok(results)
    }

    async fn rerank_api(&self, query: &str, results: &mut Vec<MemorySearchResult>) -> Result<()> {
        use crate::models::{DocumentChunk, RetrievedChunk};

        let model_config_id = match self.llm_manager.get_model_assignments().await {
            Ok(a) => match a.reranker_model_config_id {
                Some(id) => id,
                None => return Ok(()),
            },
            Err(_) => return Ok(()),
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

        match self
            .llm_manager
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
                    "[MemoryReranker] API 重排序完成: {} results",
                    results.len()
                );
            }
            Err(e) => {
                tracing::warn!(
                    "[MemoryReranker] API 重排序失败，保持原排序: {}",
                    e
                );
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_results() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let results: Vec<MemorySearchResult> = vec![];
            assert!(results.is_empty());
        });
    }
}
