//! HPIAS 研究报告 LLM synthesis（Round 25）
//!
//! 基于 VFS 检索片段调用 Model2 生成 Markdown 综合报告；失败时回退确定性拼接。

use std::time::Duration;

use crate::llm_manager::LLMManager;
use crate::vfs::retrieval_planner::FusedRetrievalHit;

use super::retrieval_backend::build_synthesis_markdown;

const SYNTHESIS_LLM_TIMEOUT_SECS: u64 = 90;
const MAX_CONTEXT_CHARS: usize = 12_000;
const MAX_SNIPPET_CHARS: usize = 480;

/// 构建 LLM synthesis prompt（纯函数，便于单测）
pub fn build_synthesis_llm_prompt(
    question: Option<&str>,
    per_query: &[(String, Vec<FusedRetrievalHit>)],
) -> String {
    let topic = question.filter(|q| !q.is_empty()).unwrap_or("研究主题");
    let mut context = String::new();
    context.push_str(&format!("研究问题：{}\n\n检索证据：\n", topic));

    for (query, hits) in per_query {
        context.push_str(&format!("## 查询：{}\n", query));
        if hits.is_empty() {
            context.push_str("（无检索结果）\n\n");
            continue;
        }
        for (i, hit) in hits.iter().take(5).enumerate() {
            let title = hit.hit.title.as_deref().unwrap_or("来源");
            let source = hit.hit.source_id.as_deref().unwrap_or("unknown");
            let snippet: String = hit.hit.text.chars().take(MAX_SNIPPET_CHARS).collect();
            context.push_str(&format!("[{}-{}] {} — {}\n", source, i + 1, title, snippet));
        }
        context.push('\n');
    }

    if context.len() > MAX_CONTEXT_CHARS {
        context.truncate(MAX_CONTEXT_CHARS);
        context.push_str("\n…（上下文已截断）");
    }

    format!(
        r#"你是一名研究助手。根据以下检索证据，撰写一份 Markdown 研究报告。

要求：
1. 使用与「研究问题」相同的语言（中文问题则中文回答）。
2. 以 `## 综合结论` 开头，随后按主题组织 `###` 小节。
3. 引用证据时使用 `[来源-N]` 格式（与上下文中的来源 id 对应）。
4. 只基于给定证据，不要编造未出现的事实。
5. 不要输出 JSON 或代码围栏，直接输出 Markdown 正文。

{context}

请输出研究报告 Markdown："#
    )
}

/// LLM 生成 synthesis；失败/超时/空输出时回退 `build_synthesis_markdown`
pub async fn generate_synthesis_with_llm(
    llm: &LLMManager,
    question: Option<&str>,
    per_query: &[(String, Vec<FusedRetrievalHit>)],
) -> String {
    let fallback = build_synthesis_markdown(question, per_query);
    if per_query.iter().all(|(_, hits)| hits.is_empty()) {
        return fallback;
    }

    let prompt = build_synthesis_llm_prompt(question, per_query);
    match tokio::time::timeout(
        Duration::from_secs(SYNTHESIS_LLM_TIMEOUT_SECS),
        llm.call_with_config_id_raw_prompt("_hpias_synthesis_", &prompt),
    )
    .await
    {
        Ok(Ok(response)) => {
            let text = response.assistant_message.trim();
            if text.is_empty() {
                log::warn!(
                    "[HpiasSynthesis] LLM returned empty output; using deterministic fallback"
                );
                fallback
            } else {
                text.to_string()
            }
        }
        Ok(Err(error)) => {
            log::warn!(
                "[HpiasSynthesis] LLM call failed: {}; using deterministic fallback",
                error
            );
            fallback
        }
        Err(_) => {
            log::warn!(
                "[HpiasSynthesis] LLM timeout after {}s; using deterministic fallback",
                SYNTHESIS_LLM_TIMEOUT_SECS
            );
            fallback
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vfs::retrieval_planner::{FusedRetrievalHit, RetrievalHit, RetrievalIdentity};

    fn sample_hit(text: &str, title: &str) -> FusedRetrievalHit {
        FusedRetrievalHit {
            hit: RetrievalHit {
                identity: RetrievalIdentity {
                    resource_id: "res-1".to_string(),
                    chunk_index: 0,
                    page_index: None,
                },
                embedding_id: "emb-1".to_string(),
                text: text.to_string(),
                title: Some(title.to_string()),
                resource_type: None,
                source_id: Some("paper-1".to_string()),
                folder_id: None,
                blob_hash: None,
                image_url: None,
                raw_score: None,
                metadata: Default::default(),
            },
            rrf_score: 1.0,
            normalized_score: Some(1.0),
            rerank_score: None,
            provenance: vec![],
        }
    }

    #[test]
    fn build_synthesis_llm_prompt_includes_question_and_evidence() {
        let per_query = vec![(
            "AI medicine".to_string(),
            vec![sample_hit("Some finding about AI.", "Paper A")],
        )];
        let prompt = build_synthesis_llm_prompt(Some("AI in medicine?"), &per_query);
        assert!(prompt.contains("AI in medicine?"));
        assert!(prompt.contains("Paper A"));
        assert!(prompt.contains("综合结论"));
    }
}
