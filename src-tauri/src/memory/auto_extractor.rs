//! 对话后自动记忆提取 Pipeline
//!
//! 受 mem0 `add` 和 memU `memorize` 启发：
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
    /// `existing_profile` 为已有用户画像摘要，注入 prompt 让 LLM 跳过已知事实。
    pub async fn extract_candidates(
        &self,
        user_content: &str,
        assistant_content: &str,
        existing_profile: Option<&str>,
    ) -> Result<Vec<CandidateMemory>> {
        if user_content.chars().count() < 4 && assistant_content.chars().count() < 4 {
            return Ok(vec![]);
        }

        let user_truncated = Self::truncate_head_tail(user_content, 1500);
        let assistant_truncated = Self::truncate_head_tail(assistant_content, 1500);

        let prompt = Self::build_extraction_prompt(
            &user_truncated,
            &assistant_truncated,
            existing_profile,
        );

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
        let existing_profile = memory_service
            .get_profile_summary()
            .ok()
            .flatten();
        let candidates = self
            .extract_candidates(
                user_content,
                assistant_content,
                existing_profile.as_deref(),
            )
            .await?;

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

        // 批量写入完成后统一刷新一次用户画像（避免逐条刷新的性能浪费）
        if stored_count > 0 {
            if let Err(e) = memory_service.refresh_profile_summary() {
                warn!("[MemoryAutoExtractor] Profile refresh after batch store failed: {}", e);
            }
        }

        info!(
            "[MemoryAutoExtractor] Pipeline complete: {}/{} candidates stored",
            stored_count,
            candidates.len()
        );

        Ok(stored_count)
    }

    fn build_extraction_prompt(
        user_content: &str,
        assistant_content: &str,
        existing_profile: Option<&str>,
    ) -> String {
        let existing_section = if let Some(profile) = existing_profile {
            let truncated: String = profile.chars().take(800).collect();
            format!(
                r#"
## 已有记忆（不要重复提取这些事实）
{truncated}

"#
            )
        } else {
            String::new()
        };

        format!(
            r#"你是一个用户记忆提取器。从以下对话中提取关于**用户本人**的原子事实。

## 提取规则
1. 每条记忆是关于用户的一个简短陈述句（≤50字）
2. 只提取关于**用户本人**的事实，不提取通用知识
3. 提取的类型：身份背景、学习状态、个人偏好、时间约束、目标计划
4. **绝对禁止**提取：学科知识、题目内容、解题过程、文档摘要
5. 判断标准：这条信息换一个用户还成立吗？如果是，就不要提取
6. 最多提取 5 条，宁缺毋滥
7. **跳过已有记忆中已记录的事实**——只提取新增或更新的信息
8. 如果对话中没有关于用户的新事实，返回空数组
{existing_section}
## 对话内容

用户: {user_content}

助手: {assistant_content}

## 分类指引
- "偏好"：格式偏好、风格偏好、学习方式偏好
- "偏好/个人背景"：年级、学校、专业、身份信息
- "经历/学科状态"：强项弱项、成绩、学习进度
- "经历/时间节点"：考试日期、截止日期、计划时间
- "经历"：重要经历、计划、目标
- 如果以上分类不合适，可以使用新的分类路径

## 输出格式（JSON 数组）
[
  {{"title": "关键词概括", "content": "一个简短陈述句", "folder": "分类路径"}},
  ...
]

没有可提取的事实时输出空数组 []。请直接输出 JSON，不要添加其他内容。"#,
            existing_section = existing_section,
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
                if Self::contains_sensitive_pattern(&content) || Self::contains_sensitive_pattern(&title) {
                    warn!("[MemoryAutoExtractor] Filtered sensitive content: '{}'", title);
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

    fn contains_sensitive_pattern(text: &str) -> bool {
        use regex::Regex;
        use std::sync::OnceLock;
        static RE: OnceLock<Regex> = OnceLock::new();
        let re = RE.get_or_init(|| {
            Regex::new(concat!(
                r"(?:",
                r"(?<!\d)1[3-9]\d{9}(?!\d)",    // 手机号（前后无数字）
                r"|(?<!\d)\d{15,18}[Xx]?(?!\d)", // 身份证号
                r"|(?<!\d)\d{16,19}(?!\d)",      // 银行卡号
                r"|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", // 邮箱
                r"|密码.{0,5}[:：].+",            // 密码
                r"|password.{0,5}[:=].+",
                r")"
            )).unwrap()
        });
        re.is_match(text)
    }

    /// 截断长文本保留头部和尾部（确保对话后段的关键信息不丢失）
    fn truncate_head_tail(text: &str, max_chars: usize) -> String {
        let total = text.chars().count();
        if total <= max_chars {
            return text.to_string();
        }
        let head_len = max_chars * 2 / 3;
        let tail_len = max_chars - head_len - 10;
        let head: String = text.chars().take(head_len).collect();
        let tail: String = text.chars().skip(total - tail_len).collect();
        format!("{}\n...(省略)...\n{}", head, tail)
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
