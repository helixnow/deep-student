use std::sync::Arc;
use tracing::{debug, warn};

use crate::llm_manager::LLMManager;
use super::service::MemorySearchResult;

/// 记忆检索压缩器
///
/// 在 unified_search 返回记忆结果时，将多条原始 chunk_text 压缩为
/// 精简摘要，减少注入 LLM context 的 token 消耗。
///
/// 使用 `memory_decision_model`（低成本模型），与记忆决策复用同一槽位。
pub struct MemoryCompressor {
    llm_manager: Arc<LLMManager>,
}

const MAX_UNCOMPRESSED_CHARS: usize = 300;

impl MemoryCompressor {
    pub fn new(llm_manager: Arc<LLMManager>) -> Self {
        Self { llm_manager }
    }

    /// 压缩记忆搜索结果
    ///
    /// 策略：
    /// - 总字符数 ≤ MAX_UNCOMPRESSED_CHARS 时跳过压缩（省 API 调用）
    /// - 否则调用 LLM 将所有记忆合并压缩为紧凑摘要
    /// - LLM 调用失败时降级为截断，不阻塞主流程
    pub async fn compress(
        &self,
        query: &str,
        results: &[MemorySearchResult],
    ) -> Vec<MemorySearchResult> {
        if results.is_empty() {
            return vec![];
        }

        let total_chars: usize = results.iter().map(|r| r.chunk_text.chars().count()).sum();
        if total_chars <= MAX_UNCOMPRESSED_CHARS {
            debug!(
                "[MemoryCompressor] Total {} chars <= {} threshold, skipping compression",
                total_chars, MAX_UNCOMPRESSED_CHARS
            );
            return results.to_vec();
        }

        let prompt = self.build_prompt(query, results);

        match self.llm_manager.call_memory_decision_raw_prompt(&prompt).await {
            Ok(output) => {
                let compressed_text = output.assistant_message.trim().to_string();
                if compressed_text.is_empty() {
                    warn!("[MemoryCompressor] LLM returned empty, falling back to originals");
                    return results.to_vec();
                }

                debug!(
                    "[MemoryCompressor] Compressed {} results ({} chars) -> {} chars",
                    results.len(),
                    total_chars,
                    compressed_text.chars().count()
                );

                vec![MemorySearchResult {
                    note_id: "__compressed__".to_string(),
                    note_title: "用户记忆摘要".to_string(),
                    folder_path: String::new(),
                    chunk_text: compressed_text,
                    score: results.first().map(|r| r.score).unwrap_or(0.5),
                    updated_at: None,
                }]
            }
            Err(e) => {
                warn!(
                    "[MemoryCompressor] LLM compression failed, using originals: {}",
                    e
                );
                results.to_vec()
            }
        }
    }

    fn build_prompt(&self, query: &str, results: &[MemorySearchResult]) -> String {
        let mut memory_lines = String::new();
        for (i, r) in results.iter().enumerate() {
            memory_lines.push_str(&format!(
                "{}. [{}] {}: {}\n",
                i + 1,
                r.folder_path,
                r.note_title,
                r.chunk_text
            ));
        }

        format!(
            r#"你是一个记忆压缩助手。将以下用户记忆检索结果压缩为一段紧凑摘要，保留与当前查询最相关的信息。

## 当前查询
{query}

## 原始记忆（{count} 条）
{memories}

## 压缩规则
1. 保留与查询直接相关的事实，删除不相关的
2. 合并重复/近似内容
3. 使用简短陈述句，用分号分隔
4. 保留 LaTeX 公式原样（如有）
5. 输出不超过 200 字
6. 只输出压缩结果，不要任何前缀或解释"#,
            query = query,
            count = results.len(),
            memories = memory_lines,
        )
    }
}
