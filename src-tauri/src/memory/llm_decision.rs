//! LLM 决策模块
//!
//! 使用 LLM 自动决定记忆操作：ADD / UPDATE / NONE
//! 从 user_memory 模块迁移并适配 VFS Memory

use std::sync::Arc;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use crate::llm_manager::LLMManager;

/// 记忆操作事件类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum MemoryEvent {
    /// 新增记忆（创建新笔记）
    ADD,
    /// 更新现有记忆（更新已有笔记）
    UPDATE,
    /// 追加到现有记忆
    APPEND,
    /// 无需操作（信息已存在）
    NONE,
}

impl Default for MemoryEvent {
    fn default() -> Self {
        Self::NONE
    }
}

impl MemoryEvent {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ADD => "ADD",
            Self::UPDATE => "UPDATE",
            Self::APPEND => "APPEND",
            Self::NONE => "NONE",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s.to_uppercase().as_str() {
            "ADD" => Self::ADD,
            "UPDATE" => Self::UPDATE,
            "APPEND" => Self::APPEND,
            _ => Self::NONE,
        }
    }
}

/// 相似记忆摘要（用于 LLM 决策）
#[derive(Debug, Clone)]
pub struct SimilarMemorySummary {
    pub note_id: String,
    pub title: String,
    pub content_preview: String,
}

/// LLM 决策响应
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryDecisionResponse {
    /// 决策事件
    pub event: MemoryEvent,
    /// UPDATE/APPEND 时指定的目标笔记 ID
    #[serde(default)]
    pub target_note_id: Option<String>,
    /// 决策置信度 (0.0 - 1.0)
    #[serde(default = "default_confidence")]
    pub confidence: f32,
    /// 决策原因
    #[serde(default)]
    pub reason: String,
}

fn default_confidence() -> f32 {
    0.8
}

impl Default for MemoryDecisionResponse {
    fn default() -> Self {
        Self {
            event: MemoryEvent::NONE,
            target_note_id: None,
            confidence: 0.8,
            reason: String::new(),
        }
    }
}

/// LLM 决策器
pub struct MemoryLLMDecision {
    llm_manager: Arc<LLMManager>,
}

impl MemoryLLMDecision {
    /// 创建决策器
    pub fn new(llm_manager: Arc<LLMManager>) -> Self {
        Self { llm_manager }
    }

    /// 执行决策
    ///
    /// 根据新内容和相似的现有记忆，决定应该执行什么操作
    pub async fn decide(
        &self,
        new_content: &str,
        new_title: Option<&str>,
        similar_memories: &[SimilarMemorySummary],
    ) -> Result<MemoryDecisionResponse> {
        // 如果没有相似记忆，直接返回 ADD
        if similar_memories.is_empty() {
            return Ok(MemoryDecisionResponse {
                event: MemoryEvent::ADD,
                target_note_id: None,
                confidence: 1.0,
                reason: "没有相似的现有记忆，直接新增".to_string(),
            });
        }

        // 构造决策 Prompt
        let prompt = self.build_decision_prompt(new_content, new_title, similar_memories);

        // 使用轻量模型进行决策
        let output = self
            .llm_manager
            .call_model2_raw_prompt(&prompt, None)
            .await
            .map_err(|e| anyhow!("LLM 调用失败: {}", e))?;
        let response = output.raw_response.unwrap_or(output.assistant_message);

        // 解析响应
        let decision = self.parse_response(&response)?;

        tracing::info!(
            "[MemoryLLMDecision] event={:?}, target={:?}, confidence={:.2}, reason={}",
            decision.event,
            decision.target_note_id,
            decision.confidence,
            decision.reason
        );

        Ok(decision)
    }

    /// 构建决策 Prompt
    fn build_decision_prompt(
        &self,
        new_content: &str,
        new_title: Option<&str>,
        similar_memories: &[SimilarMemorySummary],
    ) -> String {
        let similar_list: Vec<String> = similar_memories
            .iter()
            .enumerate()
            .map(|(i, m)| {
                format!(
                    "{}. [ID: {}] 标题: {}\n   内容预览: {}",
                    i + 1,
                    m.note_id,
                    m.title,
                    if m.content_preview.len() > 200 {
                        format!("{}...", &m.content_preview[..200])
                    } else {
                        m.content_preview.clone()
                    }
                )
            })
            .collect();

        let title_part = new_title
            .map(|t| format!("标题: {}\n", t))
            .unwrap_or_default();

        format!(
            r#"你是一个记忆管理助手。请判断新记忆与现有记忆的关系，并决定如何处理。

## 新记忆
{title_part}内容: {new_content}

## 现有相似记忆
{similar_list}

## 决策规则
1. **ADD**: 新记忆包含全新信息，与现有记忆不重复，需要创建新笔记
2. **UPDATE**: 新记忆是对某条现有记忆的修正或完全替换（指定 target_note_id）
3. **APPEND**: 新记忆是对某条现有记忆的补充，应追加到末尾（指定 target_note_id）
4. **NONE**: 新记忆的信息已完全包含在现有记忆中，无需任何操作

## 输出格式（JSON）
{{
  "event": "ADD" | "UPDATE" | "APPEND" | "NONE",
  "target_note_id": "仅 UPDATE/APPEND 时填写相似记忆的 ID",
  "confidence": 0.0-1.0,
  "reason": "简短说明决策原因"
}}

请直接输出 JSON，不要添加其他内容。"#,
            title_part = title_part,
            new_content = new_content,
            similar_list = similar_list.join("\n"),
        )
    }

    /// 解析 LLM 响应
    fn parse_response(&self, response: &str) -> Result<MemoryDecisionResponse> {
        let cleaned = Self::sanitize_json_response(response);

        // 尝试解析 JSON
        match serde_json::from_str::<MemoryDecisionResponse>(&cleaned) {
            Ok(decision) => {
                // 确保 event 字符串被正确解析
                Ok(decision)
            }
            Err(e) => {
                tracing::warn!("JSON 解析失败: {}, 原始响应: {}", e, response);
                // 尝试从响应中提取事件类型
                let event = if response.to_uppercase().contains("\"ADD\"") {
                    MemoryEvent::ADD
                } else if response.to_uppercase().contains("\"UPDATE\"") {
                    MemoryEvent::UPDATE
                } else if response.to_uppercase().contains("\"APPEND\"") {
                    MemoryEvent::APPEND
                } else {
                    MemoryEvent::NONE
                };

                Ok(MemoryDecisionResponse {
                    event,
                    target_note_id: None,
                    confidence: 0.5,
                    reason: "JSON 解析失败，使用启发式提取".to_string(),
                })
            }
        }
    }

    /// 清理 JSON 响应（移除 Markdown 代码块等）
    fn sanitize_json_response(raw: &str) -> String {
        let trimmed = raw.trim();

        // 移除 Markdown 代码块
        if trimmed.starts_with("```") {
            let without_prefix = trimmed
                .trim_start_matches("```json")
                .trim_start_matches("```JSON")
                .trim_start_matches("```");
            let without_suffix = without_prefix.trim_end_matches("```");
            return without_suffix.trim().to_string();
        }

        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_memory_event_serde() {
        let json = r#"{"event":"ADD","confidence":0.9,"reason":"test"}"#;
        let response: MemoryDecisionResponse = serde_json::from_str(json).unwrap();
        assert_eq!(response.event, MemoryEvent::ADD);
        assert_eq!(response.confidence, 0.9);
    }

    #[test]
    fn test_sanitize_json() {
        let raw = "```json\n{\"event\":\"ADD\"}\n```";
        let cleaned = MemoryLLMDecision::sanitize_json_response(raw);
        assert_eq!(cleaned, "{\"event\":\"ADD\"}");
    }

    #[test]
    fn test_memory_event_from_str() {
        assert_eq!(MemoryEvent::from_str("ADD"), MemoryEvent::ADD);
        assert_eq!(MemoryEvent::from_str("update"), MemoryEvent::UPDATE);
        assert_eq!(MemoryEvent::from_str("APPEND"), MemoryEvent::APPEND);
        assert_eq!(MemoryEvent::from_str("none"), MemoryEvent::NONE);
        assert_eq!(MemoryEvent::from_str("invalid"), MemoryEvent::NONE);
    }
}
