//! 压缩前记忆冲刷（Memory Flush）
//!
//! 参考成熟代理运行时的 memory flush 机制：长对话被 compaction 摘要之前，
//! 先用一次静默 LLM 调用把"即将被摘要掉的对话段"中尚未落盘的学习者
//! 事实与当日学习活动提取出来并持久化——把"上下文压缩会丢信息"转化为
//! "压缩前强制持久化"。
//!
//! 调用点：`chat_v2/pipeline/compaction.rs::run_compaction_for_session`
//! （摘要 LLM 调用之前，带 30s 超时；失败绝不阻塞压缩）。
//!
//! 落盘分流：
//! - 持久事实（学习者画像类）→ `memory_write_smart` 路径（LLM 决策去重）
//! - 活动流水（当日做了什么）→ `daily_log` 追加

use std::sync::Arc;

use anyhow::Result;
use tracing::{debug, info, warn};

use crate::llm_manager::LLMManager;

use super::audit_log::MemoryOpSource;
use super::auto_extractor::MemoryAutoExtractor;
use super::daily_log;
use super::service::{MemoryService, MemoryType};

/// flush 输入对话段的最大字符数（超出部分头尾截断）
const FLUSH_SEGMENT_MAX_CHARS: usize = 12_000;
/// 单次 flush 最多写入的事实条数
const FLUSH_MAX_FACTS: usize = 5;
/// 单次 flush 最多写入的活动条数
const FLUSH_MAX_ACTIVITIES: usize = 5;

/// flush 提取出的持久事实
#[derive(Debug, Clone, PartialEq)]
pub struct FlushFact {
    pub title: String,
    pub content: String,
    pub folder: Option<String>,
}

/// flush 提取结果
#[derive(Debug, Clone, Default)]
pub struct FlushExtraction {
    /// 持久事实 → memory_write_smart 路径
    pub facts: Vec<FlushFact>,
    /// 当日学习活动流水 → daily log
    pub activities: Vec<String>,
}

impl FlushExtraction {
    pub fn is_empty(&self) -> bool {
        self.facts.is_empty() && self.activities.is_empty()
    }
}

/// flush 执行报告
#[derive(Debug, Clone, Default)]
pub struct FlushReport {
    pub facts_extracted: usize,
    pub facts_stored: usize,
    pub activities_extracted: usize,
    pub activities_stored: usize,
}

pub struct CompactionMemoryFlush {
    llm_manager: Arc<LLMManager>,
}

impl CompactionMemoryFlush {
    pub fn new(llm_manager: Arc<LLMManager>) -> Self {
        Self { llm_manager }
    }

    /// 完整 flush 流程：提取 + 落盘。
    ///
    /// 任何错误由调用方 warn 后忽略——flush 是尽力而为的保底，不允许阻塞压缩。
    pub async fn flush_segment(
        &self,
        memory_service: &MemoryService,
        segment_text: &str,
        session_id: Option<&str>,
    ) -> Result<FlushReport> {
        let extraction = self.extract(segment_text).await?;
        if extraction.is_empty() {
            debug!("[MemoryFlush] Nothing worth persisting in segment; skip");
            return Ok(FlushReport::default());
        }
        Ok(self
            .store_extraction(memory_service, &extraction, session_id)
            .await)
    }

    /// 用一次静默 LLM 调用从对话段提取事实与活动
    pub async fn extract(&self, segment_text: &str) -> Result<FlushExtraction> {
        let trimmed = segment_text.trim();
        // 过短内容不值得一次 LLM 调用
        if trimmed.chars().count() < 40 {
            return Ok(FlushExtraction::default());
        }

        let segment = truncate_head_tail(trimmed, FLUSH_SEGMENT_MAX_CHARS);
        let prompt = build_flush_prompt(&segment);

        let output = self
            .llm_manager
            .call_memory_decision_raw_prompt(&prompt)
            .await
            .map_err(|e| anyhow::anyhow!("Memory flush LLM call failed: {}", e))?;

        Ok(parse_flush_response(&output.assistant_message))
    }

    /// 把提取结果分流落盘：事实 → write_smart；活动 → daily log
    async fn store_extraction(
        &self,
        memory_service: &MemoryService,
        extraction: &FlushExtraction,
        session_id: Option<&str>,
    ) -> FlushReport {
        let mut report = FlushReport {
            facts_extracted: extraction.facts.len(),
            activities_extracted: extraction.activities.len(),
            ..Default::default()
        };

        for fact in &extraction.facts {
            match memory_service
                .write_smart_with_source(
                    fact.folder.as_deref(),
                    &fact.title,
                    &fact.content,
                    MemoryOpSource::AutoExtract,
                    session_id,
                    MemoryType::Fact,
                    None,
                    None,
                )
                .await
            {
                Ok(output) => {
                    if matches!(output.event.as_str(), "ADD" | "UPDATE" | "APPEND") {
                        report.facts_stored += 1;
                    } else {
                        debug!(
                            "[MemoryFlush] Fact skipped (event={}): '{}'",
                            output.event, fact.title
                        );
                    }
                }
                Err(e) => warn!("[MemoryFlush] Failed to store fact '{}': {}", fact.title, e),
            }
        }

        report.activities_stored =
            daily_log::append_entries(memory_service, &extraction.activities);

        if report.facts_stored > 0 || report.activities_stored > 0 {
            info!(
                "[MemoryFlush] Flushed before compaction: facts {}/{}, activities {}/{}",
                report.facts_stored,
                report.facts_extracted,
                report.activities_stored,
                report.activities_extracted
            );
        }
        report
    }
}

/// 构建 flush 提取 prompt（对空/闲聊内容要求模型返回空列表，避免垃圾写入）
fn build_flush_prompt(segment_text: &str) -> String {
    format!(
        r#"这段对话即将被压缩摘要，请提取其中**值得长期记住**的信息。宁缺毋滥。

## 提取两类信息

### 1. facts —— 关于学习者本人的持久事实
- 每条是一个简短陈述句（≤50字），如"配方法中符号处理是薄弱环节"、"偏好先看结论再看推导"
- 只提取关于**学习者本人**的信息：薄弱点、偏好、目标、时间约束、身份背景
- **禁止**提取：学科知识、题目内容、解题过程、通用常识
- 最多 {max_facts} 条

### 2. activities —— 本段对话中的学习活动流水
- 每条概括一件"今天做了什么"，如"做了 5 道二次函数题，错 2 道，均为符号错误"
- 只记录有实质学习内容的活动（做题、复习、批改、制卡、背诵等）
- 最多 {max_activities} 条

## 重要规则
- 如果对话是闲聊/寒暄/无实质学习内容，两个数组都返回空 []
- 不确定是否值得记住时，不要提取

## 对话内容
{segment}

## 输出格式（严格 JSON，不要其他内容）
{{
  "facts": [
    {{"title": "关键词概括", "content": "一个简短陈述句", "folder": "分类路径（可选，如 偏好、经历/学科状态）"}}
  ],
  "activities": [
    "活动概括一句话"
  ]
}}"#,
        max_facts = FLUSH_MAX_FACTS,
        max_activities = FLUSH_MAX_ACTIVITIES,
        segment = segment_text,
    )
}

/// 解析 flush LLM 响应（容错：裸 JSON / 代码块包裹 / 前后杂讯）
pub fn parse_flush_response(response: &str) -> FlushExtraction {
    let cleaned = crate::llm_manager::parser::enhanced_clean_json_response(response);

    let value = serde_json::from_str::<serde_json::Value>(&cleaned)
        .ok()
        .or_else(|| {
            extract_json_object(&cleaned)
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        })
        .or_else(|| {
            extract_json_object(response)
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        });

    let Some(value) = value else {
        debug!("[MemoryFlush] No valid JSON object in response, treating as empty");
        return FlushExtraction::default();
    };

    let facts = value
        .get("facts")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let title = item.get("title")?.as_str()?.trim().to_string();
                    let content = item.get("content")?.as_str()?.trim().to_string();
                    if title.is_empty()
                        || content.is_empty()
                        || content.chars().count() > 80
                        || MemoryAutoExtractor::contains_sensitive_pattern_pub(&content)
                        || MemoryAutoExtractor::contains_sensitive_pattern_pub(&title)
                    {
                        return None;
                    }
                    let folder = item
                        .get("folder")
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string());
                    Some(FlushFact {
                        title,
                        content,
                        folder,
                    })
                })
                .take(FLUSH_MAX_FACTS)
                .collect()
        })
        .unwrap_or_default();

    let activities = value
        .get("activities")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty() && s.chars().count() <= 200)
                .filter(|s| !MemoryAutoExtractor::contains_sensitive_pattern_pub(s))
                .map(|s| s.to_string())
                .take(FLUSH_MAX_ACTIVITIES)
                .collect()
        })
        .unwrap_or_default();

    FlushExtraction { facts, activities }
}

/// 从文本中提取第一个平衡的 JSON 对象 `{ ... }`（evolution 晋升 pass 复用）
pub(crate) fn extract_json_object(text: &str) -> Option<String> {
    let mut depth = 0i32;
    let mut start = None;
    let mut in_string = false;
    let mut escaped = false;
    for (i, ch) in text.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' => {
                if depth == 0 {
                    start = Some(i);
                }
                depth += 1;
            }
            '}' => {
                if depth > 0 {
                    depth -= 1;
                    if depth == 0 {
                        if let Some(s) = start {
                            return Some(text[s..=i + ch.len_utf8() - 1].to_string());
                        }
                    }
                }
            }
            _ => {}
        }
    }
    None
}

/// 头尾截断（保留对话前段任务背景和后段最新信息）
fn truncate_head_tail(text: &str, max_chars: usize) -> String {
    let total = text.chars().count();
    if total <= max_chars {
        return text.to_string();
    }
    let head_len = max_chars / 2;
    let tail_len = max_chars - head_len - 12;
    let head: String = text.chars().take(head_len).collect();
    let tail: String = text.chars().skip(total - tail_len).collect();
    format!("{}\n...(中段省略)...\n{}", head, tail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_flush_response_basic() {
        let raw = r#"{"facts":[{"title":"二次函数薄弱","content":"配方法符号处理是薄弱环节","folder":"经历/学科状态"}],"activities":["做了 5 道二次函数题，错 2 道，均为符号错误"]}"#;
        let result = parse_flush_response(raw);
        assert_eq!(result.facts.len(), 1);
        assert_eq!(result.facts[0].title, "二次函数薄弱");
        assert_eq!(result.facts[0].folder.as_deref(), Some("经历/学科状态"));
        assert_eq!(result.activities.len(), 1);
    }

    #[test]
    fn test_parse_flush_response_with_noise_and_codeblock() {
        let raw = "提取结果如下：\n```json\n{\"facts\":[],\"activities\":[\"复习虚拟语气 30 分钟\"]}\n```\n希望有帮助";
        let result = parse_flush_response(raw);
        assert!(result.facts.is_empty());
        assert_eq!(result.activities, vec!["复习虚拟语气 30 分钟"]);
    }

    #[test]
    fn test_parse_flush_response_empty_for_chitchat() {
        let raw = r#"{"facts":[],"activities":[]}"#;
        let result = parse_flush_response(raw);
        assert!(result.is_empty());
    }

    #[test]
    fn test_parse_flush_response_garbage_returns_empty() {
        // 模型输出完全不含 JSON 时不得报错，兜底为空（flush 失败不阻塞压缩）
        let result = parse_flush_response("抱歉，我无法处理这个请求。");
        assert!(result.is_empty());
    }

    #[test]
    fn test_parse_flush_response_filters_invalid_facts() {
        let long_content = "超".repeat(100);
        let raw = format!(
            r#"{{"facts":[
                {{"title":"","content":"缺标题"}},
                {{"title":"超长","content":"{}"}},
                {{"title":"敏感","content":"手机号是13812345678"}},
                {{"title":"有效","content":"数学是弱项"}}
            ],"activities":["", "  "]}}"#,
            long_content
        );
        let result = parse_flush_response(&raw);
        assert_eq!(result.facts.len(), 1);
        assert_eq!(result.facts[0].title, "有效");
        assert!(result.activities.is_empty());
    }

    #[test]
    fn test_parse_flush_response_caps_counts() {
        let facts: Vec<String> = (0..10)
            .map(|i| format!(r#"{{"title":"事实{}","content":"内容{}"}}"#, i, i))
            .collect();
        let activities: Vec<String> = (0..10).map(|i| format!(r#""活动{}""#, i)).collect();
        let raw = format!(
            r#"{{"facts":[{}],"activities":[{}]}}"#,
            facts.join(","),
            activities.join(",")
        );
        let result = parse_flush_response(&raw);
        assert_eq!(result.facts.len(), FLUSH_MAX_FACTS);
        assert_eq!(result.activities.len(), FLUSH_MAX_ACTIVITIES);
    }

    #[test]
    fn test_extract_json_object_with_nested_braces_in_string() {
        let text = r#"前缀 {"facts":[{"title":"a{b}","content":"c"}],"activities":[]} 后缀"#;
        let extracted = extract_json_object(text).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&extracted).unwrap();
        assert!(parsed.get("facts").is_some());
    }

    #[test]
    fn test_truncate_head_tail() {
        let text = "a".repeat(20_000);
        let out = truncate_head_tail(&text, 1000);
        assert!(out.chars().count() <= 1000 + 20);
        assert!(out.contains("(中段省略)"));
    }
}
