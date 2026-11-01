use std::sync::Arc;
use tracing::{debug, warn};

use super::service::MemorySearchResult;
use crate::llm_manager::LLMManager;

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

/// 压缩器输出条目
///
/// - 未压缩（透传）：`note_id` 为原始笔记的真实 ID，`source_note_ids` 为空
/// - 压缩摘要：`note_id` 为 None（不再使用 `__compressed__` 哨兵值，避免
///   LLM 拿假 ID 调 memory_read/memory_update_by_id 必然 NotFound），
///   `source_note_ids` 保留压缩前所有成员的真实 note_id 供溯源
#[derive(Debug, Clone)]
pub struct CompressedMemoryResult {
    pub note_id: Option<String>,
    pub note_title: String,
    pub folder_path: String,
    pub chunk_text: String,
    pub score: f32,
    pub source_note_ids: Vec<String>,
}

impl CompressedMemoryResult {
    fn passthrough(results: &[MemorySearchResult]) -> Vec<Self> {
        results
            .iter()
            .map(|r| Self {
                note_id: Some(r.note_id.clone()),
                note_title: r.note_title.clone(),
                folder_path: r.folder_path.clone(),
                chunk_text: r.chunk_text.clone(),
                score: r.score,
                source_note_ids: Vec::new(),
            })
            .collect()
    }
}

impl MemoryCompressor {
    pub fn new(llm_manager: Arc<LLMManager>) -> Self {
        Self { llm_manager }
    }

    /// 压缩记忆搜索结果
    ///
    /// 策略：
    /// - 总字符数 ≤ MAX_UNCOMPRESSED_CHARS 时跳过压缩（省 API 调用）
    /// - 否则调用 LLM 将所有记忆合并压缩为紧凑摘要
    /// - LLM 调用失败时降级为透传原始结果，不阻塞主流程
    pub async fn compress(
        &self,
        query: &str,
        results: &[MemorySearchResult],
    ) -> Vec<CompressedMemoryResult> {
        if results.is_empty() {
            return vec![];
        }

        let total_chars: usize = results.iter().map(|r| r.chunk_text.chars().count()).sum();
        if total_chars <= MAX_UNCOMPRESSED_CHARS {
            debug!(
                "[MemoryCompressor] Total {} chars <= {} threshold, skipping compression",
                total_chars, MAX_UNCOMPRESSED_CHARS
            );
            return CompressedMemoryResult::passthrough(results);
        }

        let prompt = self.build_prompt(query, results);

        match self
            .llm_manager
            .call_memory_decision_raw_prompt(&prompt)
            .await
        {
            Ok(output) => {
                let compressed_text = output.assistant_message.trim().to_string();
                if compressed_text.is_empty() {
                    warn!("[MemoryCompressor] LLM returned empty, falling back to originals");
                    return CompressedMemoryResult::passthrough(results);
                }

                debug!(
                    "[MemoryCompressor] Compressed {} results ({} chars) -> {} chars",
                    results.len(),
                    total_chars,
                    compressed_text.chars().count()
                );

                let source_note_ids: Vec<String> =
                    results.iter().map(|r| r.note_id.clone()).collect();
                let chunk_text = format!(
                    "本条为 {} 条记忆的压缩摘要，可用 memory_read 按 sourceNoteIds 中的 ID 查看原文。\n{}",
                    results.len(),
                    compressed_text
                );
                vec![CompressedMemoryResult {
                    note_id: None,
                    note_title: "用户记忆摘要".to_string(),
                    folder_path: String::new(),
                    chunk_text,
                    score: results.first().map(|r| r.score).unwrap_or(0.5),
                    source_note_ids,
                }]
            }
            Err(e) => {
                warn!(
                    "[MemoryCompressor] LLM compression failed, using originals: {}",
                    e
                );
                CompressedMemoryResult::passthrough(results)
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
