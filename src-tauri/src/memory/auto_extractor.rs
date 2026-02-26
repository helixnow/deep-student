//! 对话后自动记忆提取 Pipeline
//!
//! 对齐 mem0 的 `add` 和 memU 的 `memorize`：
//! 从每轮对话的用户消息和助手回复中自动提取候选记忆，
//! 通过 write_smart 去重后写入。
//!
//! 触发点：ChatV2Pipeline::save_results_post_commit

use std::sync::Arc;

use anyhow::Result;
use tracing::{debug, info, warn};

use super::service::MemoryService;
use crate::llm_manager::LLMManager;

/// 从一次 LLM 调用中提取出的候选记忆
#[derive(Debug, Clone)]
pub struct CandidateMemory {
    pub title: String,
    pub content: String,
    pub folder: Option<String>,
}

pub struct MemoryAutoExtractor {
    llm_manager: Arc<LLMManager>,
}

impl MemoryAutoExtractor {
    pub fn new(llm_manager: Arc<LLMManager>) -> Self {
        Self { llm_manager }
    }

    /// 从对话内容中提取候选记忆
    ///
    /// 使用轻量模型（model2）分析用户消息和助手回复，
    /// 提取出关于用户的原子事实。
    pub async fn extract_candidates(
        &self,
        user_content: &str,
        assistant_content: &str,
    ) -> Result<Vec<CandidateMemory>> {
        if user_content.len() < 5 && assistant_content.len() < 5 {
            return Ok(vec![]);
        }

        let user_truncated: String = user_content.chars().take(1500).collect();
        let assistant_truncated: String = assistant_content.chars().take(1500).collect();

        let prompt = Self::build_extraction_prompt(&user_truncated, &assistant_truncated);

        let output = self
            .llm_manager
            .call_memory_decision_raw_prompt(&prompt)
            .await
            .map_err(|e| anyhow::anyhow!("LLM extraction call failed: {}", e))?;

        let candidates = self.parse_extraction_response(&output.assistant_message)?;

        debug!(
            "[MemoryAutoExtractor] Extracted {} candidate memories from conversation",
            candidates.len()
        );

        Ok(candidates)
    }

    /// 提取并通过 write_smart 写入（完整 pipeline）
    pub async fn extract_and_store(
        &self,
        memory_service: &MemoryService,
        user_content: &str,
        assistant_content: &str,
    ) -> Result<usize> {
        let candidates = self.extract_candidates(user_content, assistant_content).await?;

        if candidates.is_empty() {
            debug!("[MemoryAutoExtractor] No candidate memories extracted, skipping");
            return Ok(0);
        }

        let mut stored_count = 0usize;

        for candidate in &candidates {
            match memory_service
                .write_smart(
                    candidate.folder.as_deref(),
                    &candidate.title,
                    &candidate.content,
                )
                .await
            {
                Ok(output) => {
                    if output.event != "NONE" {
                        stored_count += 1;
                        info!(
                            "[MemoryAutoExtractor] Auto-stored memory: event={}, note_id={}, title='{}'",
                            output.event, output.note_id, candidate.title
                        );
                    } else {
                        debug!(
                            "[MemoryAutoExtractor] Skipped (NONE): '{}' — {}",
                            candidate.title, output.reason
                        );
                    }
                }
                Err(e) => {
                    warn!(
                        "[MemoryAutoExtractor] Failed to store '{}': {}",
                        candidate.title, e
                    );
                }
            }
        }

        info!(
            "[MemoryAutoExtractor] Pipeline complete: {}/{} candidates stored",
            stored_count,
            candidates.len()
        );

        Ok(stored_count)
    }

    fn build_extraction_prompt(user_content: &str, assistant_content: &str) -> String {
        format!(
            r#"你是一个用户记忆提取器。从以下对话中提取关于**用户本人**的原子事实。

## 提取规则
1. 每条记忆是关于用户的一个简短陈述句（≤50字）
2. 只提取关于**用户本人**的事实，不提取通用知识
3. 提取的类型：身份背景、学习状态、个人偏好、时间约束、目标计划
4. **绝对禁止**提取：学科知识、题目内容、解题过程、文档摘要
5. 判断标准：这条信息换一个用户还成立吗？如果是，就不要提取
6. 最多提取 5 条，宁缺毋滥
7. 如果对话中没有关于用户的新事实，返回空数组

## 对话内容

用户: {user_content}

助手: {assistant_content}

## 分类指引
- "偏好"：格式偏好、风格偏好、学习方式偏好
- "偏好/个人背景"：年级、学校、专业、身份信息
- "经历/学科状态"：强项弱项、成绩、学习进度
- "经历/时间节点"：考试日期、截止日期、计划时间
- "经历"：重要经历、计划、目标

## 输出格式（JSON 数组）
[
  {{"title": "关键词概括", "content": "一个简短陈述句", "folder": "分类路径"}},
  ...
]

没有可提取的事实时输出空数组 []。请直接输出 JSON，不要添加其他内容。"#,
            user_content = user_content,
            assistant_content = assistant_content,
        )
    }

    fn parse_extraction_response(&self, response: &str) -> Result<Vec<CandidateMemory>> {
        let cleaned = crate::llm_manager::parser::enhanced_clean_json_response(response);

        if let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(&cleaned) {
            return Ok(Self::values_to_candidates(&items));
        }

        if let Some(arr_str) = Self::extract_json_array(&cleaned) {
            if let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(&arr_str) {
                return Ok(Self::values_to_candidates(&items));
            }
        }

        if let Some(arr_str) = Self::extract_json_array(response) {
            if let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(&arr_str) {
                return Ok(Self::values_to_candidates(&items));
            }
        }

        debug!(
            "[MemoryAutoExtractor] No valid JSON array found in response, returning empty"
        );
        Ok(vec![])
    }

    fn values_to_candidates(items: &[serde_json::Value]) -> Vec<CandidateMemory> {
        items
            .iter()
            .filter_map(|item| {
                let title = item.get("title")?.as_str()?.to_string();
                let content = item.get("content")?.as_str()?.to_string();
                if title.is_empty() || content.is_empty() || content.chars().count() > 80 {
                    return None;
                }
                let folder = item
                    .get("folder")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string());
                Some(CandidateMemory {
                    title,
                    content,
                    folder,
                })
            })
            .take(5)
            .collect()
    }

    /// 从文本中提取第一个 JSON 数组 `[ ... ]`
    fn extract_json_array(text: &str) -> Option<String> {
        let mut depth = 0i32;
        let mut start = None;
        for (i, ch) in text.char_indices() {
            match ch {
                '[' => {
                    if depth == 0 {
                        start = Some(i);
                    }
                    depth += 1;
                }
                ']' => {
                    if depth > 0 {
                        depth -= 1;
                        if depth == 0 {
                            if let Some(s) = start {
                                return Some(text[s..=i].to_string());
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_json_array() {
        let raw = "以下是提取结果：\n[{\"title\":\"高三\",\"content\":\"高三理科生\",\"folder\":\"偏好/个人背景\"}]";
        let arr = MemoryAutoExtractor::extract_json_array(raw).unwrap();
        let items: Vec<serde_json::Value> = serde_json::from_str(&arr).unwrap();
        assert_eq!(items.len(), 1);
    }

    #[test]
    fn test_extract_json_array_empty() {
        let raw = "没有可提取的事实。\n[]";
        let arr = MemoryAutoExtractor::extract_json_array(raw).unwrap();
        let items: Vec<serde_json::Value> = serde_json::from_str(&arr).unwrap();
        assert!(items.is_empty());
    }

    #[test]
    fn test_values_to_candidates_filters_long_content() {
        let items: Vec<serde_json::Value> = serde_json::from_str(
            r#"[{"title":"ok","content":"短内容","folder":"偏好"},{"title":"bad","content":"这是一段超过八十个字的超长内容这是一段超过八十个字的超长内容这是一段超过八十个字的超长内容这是一段超过八十个字的超长内容这是一段超过八十个字的超长内容","folder":""}]"#,
        ).unwrap();
        let candidates = MemoryAutoExtractor::values_to_candidates(&items);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].title, "ok");
    }
}
