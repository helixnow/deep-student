//! 对话后自动记忆提取 Pipeline
//!
//! 受 mem0 `add` 和 memU `memorize` 启发：
//! 从每轮对话的用户消息和助手回复中自动提取候选记忆，
//! 通过 write_smart 去重后写入。
//!
//! 三层记忆分流：提取结果分为两类——
//! - 持久事实（关于用户本人）→ write_smart 普通记忆路径
//! - 当日学习活动流水（做了什么题/错在哪）→ daily_log 追加（只可检索不注入）
//!
//! 触发点：ChatV2Pipeline::save_results_post_commit

use std::collections::HashSet;
use std::sync::Arc;

use anyhow::Result;
use tracing::{debug, info, warn};

use super::audit_log::{MemoryOpSource, OpTimer};
use super::daily_log;
use super::service::MemoryService;
use crate::llm_manager::LLMManager;

/// 从一次 LLM 调用中提取出的候选记忆
#[derive(Debug, Clone)]
pub struct CandidateMemory {
    pub title: String,
    pub content: String,
    pub folder: Option<String>,
}

/// 单条活动流水的最大字符数
const ACTIVITY_MAX_CHARS: usize = 200;
/// 单次提取的活动流水条数上限
const MAX_ACTIVITIES: usize = 5;

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
        let (candidates, _activities) = self
            .extract_candidates_and_activities(user_content, assistant_content, existing_profile)
            .await?;
        Ok(candidates)
    }

    /// 从对话内容中提取候选记忆 + 当日学习活动流水（三层记忆分流）
    pub async fn extract_candidates_and_activities(
        &self,
        user_content: &str,
        assistant_content: &str,
        existing_profile: Option<&str>,
    ) -> Result<(Vec<CandidateMemory>, Vec<String>)> {
        if user_content.chars().count() < 4 && assistant_content.chars().count() < 4 {
            return Ok((vec![], vec![]));
        }

        let user_truncated = Self::truncate_head_tail(user_content, 1500);
        let assistant_truncated = Self::truncate_head_tail(assistant_content, 1500);

        let prompt =
            Self::build_extraction_prompt(&user_truncated, &assistant_truncated, existing_profile);

        let output = self
            .llm_manager
            .call_memory_decision_raw_prompt(&prompt)
            .await
            .map_err(|e| anyhow::anyhow!("LLM extraction call failed: {}", e))?;

        let (candidates, activities) =
            Self::parse_extraction_response_full(&output.assistant_message);

        debug!(
            "[MemoryAutoExtractor] Extracted {} candidate memories, {} activities from conversation",
            candidates.len(),
            activities.len()
        );

        Ok((candidates, activities))
    }

    /// 提取并通过 write_smart 写入（完整 pipeline）
    ///
    /// 持久事实走 write_smart 去重写入；当日学习活动流水同时追加进 daily log
    /// （区分：持久事实→普通 memory，活动流水→daily log）。
    pub async fn extract_and_store(
        &self,
        memory_service: &MemoryService,
        user_content: &str,
        assistant_content: &str,
    ) -> Result<usize> {
        let pipeline_timer = OpTimer::start();

        let existing_profile = memory_service.get_profile_summary().ok().flatten();
        let (candidates, activities) = self
            .extract_candidates_and_activities(
                user_content,
                assistant_content,
                existing_profile.as_deref(),
            )
            .await?;

        // 活动流水 → 当日学习日志（append-only，失败不影响事实写入）
        if !activities.is_empty() {
            let appended = daily_log::append_entries(memory_service, &activities);
            if appended > 0 {
                info!(
                    "[MemoryAutoExtractor] Appended {}/{} activities to daily log",
                    appended,
                    activities.len()
                );
            }
        }

        if candidates.is_empty() {
            debug!("[MemoryAutoExtractor] No candidate memories extracted, skipping");
            return Ok(0);
        }

        let audit_logger = memory_service.audit_logger().clone();
        let mut stored_count = 0usize;
        let mut seen_keys: HashSet<String> = HashSet::new();

        for candidate in &candidates {
            let dedup_key = format!(
                "{}|{}|{}",
                candidate
                    .folder
                    .as_deref()
                    .unwrap_or("")
                    .trim()
                    .to_lowercase(),
                candidate.title.trim().to_lowercase(),
                candidate.content.trim().to_lowercase(),
            );
            if !seen_keys.insert(dedup_key) {
                debug!(
                    "[MemoryAutoExtractor] Skip duplicated candidate in same batch: '{}'",
                    candidate.title
                );
                continue;
            }
            match memory_service
                .write_smart_with_source(
                    candidate.folder.as_deref(),
                    &candidate.title,
                    &candidate.content,
                    MemoryOpSource::AutoExtract,
                    None,
                    crate::memory::MemoryType::Fact,
                    None,
                    None,
                )
                .await
            {
                Ok(output) => {
                    let is_mutating_event = matches!(
                        output.event.as_str(),
                        "ADD" | "UPDATE" | "APPEND" | "DELETE"
                    );
                    if is_mutating_event {
                        stored_count += 1;
                        info!(
                            "[MemoryAutoExtractor] Auto-stored memory: event={}, note_id={}, title='{}'",
                            output.event, output.note_id, candidate.title
                        );
                    } else {
                        debug!(
                            "[MemoryAutoExtractor] Skipped (event={}): '{}' — {}",
                            output.event, candidate.title, output.reason
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

        audit_logger.log_extract_result(
            candidates.len(),
            stored_count,
            pipeline_timer.elapsed_ms(),
            None,
        );

        if stored_count > 0 {
            if let Err(e) = memory_service.refresh_profile_summary() {
                warn!(
                    "[MemoryAutoExtractor] Profile refresh after batch store failed: {}",
                    e
                );
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
            r#"你是一个用户记忆提取器。从以下对话中提取两类信息：关于**用户本人**的原子事实（facts）与本轮对话中的**学习活动流水**（activities）。

## facts 提取规则
1. 每条记忆是关于用户的一个简短陈述句（≤50字）
2. 只提取关于**用户本人**的事实，不提取通用知识
3. 提取的类型：身份背景、学习状态、个人偏好、时间约束、目标计划
4. **绝对禁止**提取：学科知识、题目内容、解题过程、文档摘要
5. 判断标准：这条信息换一个用户还成立吗？如果是，就不要提取
6. 最多提取 5 条，宁缺毋滥
7. **跳过已有记忆中已记录的事实**——只提取新增或更新的信息
8. 如果对话中没有关于用户的新事实，facts 返回空数组

## activities 提取规则
1. 每条概括本轮对话中一件"今天做了什么"的学习活动（≤80字），
   如"做了 5 道二次函数题，错 2 道，均为符号错误"
2. 只记录有实质学习内容的活动（做题、复习、批改、背诵、制卡等）；
   闲聊/问答咨询不算活动
3. 最多提取 5 条；没有实质学习活动时 activities 返回空数组
{existing_section}
## 对话内容

用户: {user_content}

助手: {assistant_content}

## facts 分类指引
- "偏好"：格式偏好、风格偏好、学习方式偏好
- "偏好/个人背景"：年级、学校、专业、身份信息
- "经历/学科状态"：强项弱项、成绩、学习进度
- "经历/时间节点"：考试日期、截止日期、计划时间
- "经历"：重要经历、计划、目标
- 如果以上分类不合适，可以使用新的分类路径

## 输出格式（严格 JSON 对象）
{{
  "facts": [
    {{"title": "关键词概括", "content": "一个简短陈述句", "folder": "分类路径"}}
  ],
  "activities": [
    "学习活动概括一句话"
  ]
}}

没有可提取的内容时对应数组输出 []。请直接输出 JSON，不要添加其他内容。"#,
            existing_section = existing_section,
            user_content = user_content,
            assistant_content = assistant_content,
        )
    }

    /// 解析提取响应（facts + activities 双通道）
    ///
    /// 容错顺序：
    /// 1. JSON 对象 `{"facts":[...],"activities":[...]}`（当前 prompt 格式）
    /// 2. 裸 JSON 数组 `[...]`（旧格式兜底，视为 facts）
    fn parse_extraction_response_full(response: &str) -> (Vec<CandidateMemory>, Vec<String>) {
        let cleaned = crate::llm_manager::parser::enhanced_clean_json_response(response);

        // 1. 对象格式（facts + activities）
        let object = serde_json::from_str::<serde_json::Value>(&cleaned)
            .ok()
            .filter(|v| v.is_object())
            .or_else(|| {
                super::compaction_flush::extract_json_object(&cleaned)
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            })
            .or_else(|| {
                super::compaction_flush::extract_json_object(response)
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            });
        if let Some(obj) = object {
            let facts = obj
                .get("facts")
                .and_then(|v| v.as_array())
                .map(|items| Self::values_to_candidates(items))
                .unwrap_or_default();
            let activities = obj
                .get("activities")
                .and_then(|v| v.as_array())
                .map(|items| Self::values_to_activities(items))
                .unwrap_or_default();
            return (facts, activities);
        }

        // 2. 旧格式兜底：裸数组视为 facts
        if let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(&cleaned) {
            return (Self::values_to_candidates(&items), vec![]);
        }
        if let Some(arr_str) = Self::extract_json_array(&cleaned) {
            if let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(&arr_str) {
                return (Self::values_to_candidates(&items), vec![]);
            }
        }
        if let Some(arr_str) = Self::extract_json_array(response) {
            if let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(&arr_str) {
                return (Self::values_to_candidates(&items), vec![]);
            }
        }

        debug!("[MemoryAutoExtractor] No valid JSON found in response, returning empty");
        (vec![], vec![])
    }

    /// 过滤活动流水条目（长度/敏感信息）
    fn values_to_activities(items: &[serde_json::Value]) -> Vec<String> {
        items
            .iter()
            .filter_map(|item| item.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty() && s.chars().count() <= ACTIVITY_MAX_CHARS)
            .filter(|s| !Self::contains_sensitive_pattern(s))
            .map(|s| s.to_string())
            .take(MAX_ACTIVITIES)
            .collect()
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
                if Self::contains_sensitive_pattern(&content)
                    || Self::contains_sensitive_pattern(&title)
                {
                    warn!(
                        "[MemoryAutoExtractor] Filtered sensitive content: '{}'",
                        title
                    );
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

    pub fn contains_sensitive_pattern_pub(text: &str) -> bool {
        Self::contains_sensitive_pattern(text)
    }

    fn contains_sensitive_pattern(text: &str) -> bool {
        use regex::Regex;
        use std::sync::OnceLock;
        // Rust regex crate 不支持 look-around，用 \b 边界代替
        static RE: OnceLock<Regex> = OnceLock::new();
        let re = RE.get_or_init(|| {
            Regex::new(concat!(
                r"(?:",
                r"\b1[3-9]\d{9}\b",     // 手机号（11 位，1[3-9] 开头）
                r"|\b\d{15,18}[Xx]?\b", // 身份证号（15-18 位 + 可选 X）
                r"|\b\d{16,19}\b",      // 银行卡号（16-19 位）
                r"|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", // 邮箱
                r"|密码.{0,5}[:：].+",  // 密码
                r"|password.{0,5}[:=].+",
                r")"
            ))
            .unwrap()
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
    fn test_parse_extraction_response_full_object_format() {
        let raw = r#"{"facts":[{"title":"高三","content":"高三理科生","folder":"偏好/个人背景"}],"activities":["做了 5 道二次函数题，错 2 道"]}"#;
        let (facts, activities) = MemoryAutoExtractor::parse_extraction_response_full(raw);
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].title, "高三");
        assert_eq!(activities, vec!["做了 5 道二次函数题，错 2 道"]);
    }

    #[test]
    fn test_parse_extraction_response_full_legacy_array_format() {
        // 旧格式（裸数组）兜底：视为 facts，活动为空
        let raw = r#"[{"title":"高三","content":"高三理科生","folder":"偏好/个人背景"}]"#;
        let (facts, activities) = MemoryAutoExtractor::parse_extraction_response_full(raw);
        assert_eq!(facts.len(), 1);
        assert!(activities.is_empty());
    }

    #[test]
    fn test_parse_extraction_response_full_garbage() {
        let (facts, activities) =
            MemoryAutoExtractor::parse_extraction_response_full("无法解析的输出");
        assert!(facts.is_empty());
        assert!(activities.is_empty());
    }

    #[test]
    fn test_values_to_activities_filters() {
        let items: Vec<serde_json::Value> = serde_json::from_str(&format!(
            r#"["有效活动", "", "  ", "{}", "手机号13812345678相关"]"#,
            "长".repeat(300)
        ))
        .unwrap();
        let activities = MemoryAutoExtractor::values_to_activities(&items);
        assert_eq!(activities, vec!["有效活动"]);
    }

    #[test]
    fn test_values_to_candidates_filters_long_content() {
        // "bad" 的 content 为 15 字 × 6 = 90 字符（> 80 过滤阈值）；
        // 旧测试数据只有 75 字符未超阈值，导致断言与过滤语义不符
        let items: Vec<serde_json::Value> = serde_json::from_str(
            r#"[{"title":"ok","content":"短内容","folder":"偏好"},{"title":"bad","content":"这是一段超过八十个字的超长内容这是一段超过八十个字的超长内容这是一段超过八十个字的超长内容这是一段超过八十个字的超长内容这是一段超过八十个字的超长内容这是一段超过八十个字的超长内容","folder":""}]"#,
        ).unwrap();
        let candidates = MemoryAutoExtractor::values_to_candidates(&items);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].title, "ok");
    }
}
