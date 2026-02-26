//! LLM 决策模块
//!
//! 使用 LLM 自动决定记忆操作：ADD / UPDATE / NONE
//! 适配 VFS Memory

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
    /// 删除过时/矛盾的旧记忆（对齐 mem0 conflict resolution）
    DELETE,
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
            Self::DELETE => "DELETE",
            Self::NONE => "NONE",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s.to_uppercase().as_str() {
            "ADD" => Self::ADD,
            "UPDATE" => Self::UPDATE,
            "APPEND" => Self::APPEND,
            "DELETE" => Self::DELETE,
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

        // 使用记忆决策模型（回退链：memory_decision_model → model2）
        let output = self
            .llm_manager
            .call_memory_decision_raw_prompt(&prompt)
            .await
            .map_err(|e| anyhow!("LLM 调用失败: {}", e))?;
        let response = output.assistant_message;

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
                    "{}. [ID: {}] 标题: {}\n   内容: {}",
                    i + 1,
                    m.note_id,
                    m.title,
                    m.content_preview,
                )
            })
            .collect();

        let title_part = new_title
            .map(|t| format!("标题: {}\n", t))
            .unwrap_or_default();

        format!(
            r#"你是一个记忆管理助手。记忆只存储关于用户本人的原子事实（≤50字的短句），不存储学科知识、题目分析、解题过程、文档摘要等通用内容。

## 内容合法性检查（优先于决策规则）

先判断新记忆的内容是否合法。以下内容必须返回 NONE：
- 学科知识（定理、公式、概念解释、知识点罗列）
- 题目内容（题干、选项、解题过程、错题分析）
- 文档摘要（PDF/文件的内容总结、章节概要）
- 通用事实（换一个用户也成立的信息）
- 内容超过 50 字的长文本

合法的记忆示例："高三理科生" / "数学是弱项" / "偏好表格形式总结" / "高考在2026年6月7日"

## 新记忆
{title_part}内容: {new_content}

## 现有相似记忆
{similar_list}

## 决策规则（仅在内容合法时适用）
1. **ADD**: 新记忆包含全新的用户事实，与现有记忆不重复
2. **UPDATE**: 新记忆是对某条现有记忆的修正或替换（指定 target_note_id）
3. **APPEND**: 新记忆是对某条现有记忆的补充（指定 target_note_id）
4. **DELETE**: 新记忆与某条现有记忆**矛盾**（如 "数学进步了" 与 "数学是弱项"），应删除旧记忆并新增新记忆（指定 target_note_id 为要删除的旧记忆）
5. **NONE**: 信息已包含在现有记忆中，或内容不合法，无需操作

## 矛盾检测指引
- 状态变化属于矛盾：如 "数学弱项" → "数学已提升"，应 DELETE 旧 + ADD 新
- 时间更新属于矛盾：如 "下次模考在3月" → "下次模考改到4月"，应 DELETE 旧 + ADD 新
- 偏好变化属于矛盾：如 "偏好列表格式" → "偏好思维导图格式"，应 DELETE 旧 + ADD 新
- 补充信息不属于矛盾：如 "高三理科生" + "就读于XX中学"，应 APPEND

## 输出格式（JSON）
{{
  "event": "ADD" | "UPDATE" | "APPEND" | "DELETE" | "NONE",
  "target_note_id": "UPDATE/APPEND/DELETE 时填写目标记忆的 ID",
  "confidence": 0.0-1.0,
  "reason": "简短说明决策原因"
}}

请直接输出 JSON，不要添加其他内容。"#,
            title_part = title_part,
            new_content = new_content,
            similar_list = similar_list.join("\n"),
        )
    }

    /// 解析 LLM 响应（无启发式回退，复用 parser 模块成熟的 JSON 提取逻辑）
    fn parse_response(&self, response: &str) -> Result<MemoryDecisionResponse> {
        // 策略 1：enhanced_clean_json_response 清理后直接解析
        let cleaned = crate::llm_manager::parser::enhanced_clean_json_response(response);
        if let Ok(decision) = serde_json::from_str::<MemoryDecisionResponse>(&cleaned) {
            return Ok(decision);
        }

        // 策略 2：从清理后文本提取第一个 JSON 对象
        if let Some(json_str) = Self::extract_first_json_object(&cleaned) {
            if let Ok(decision) = serde_json::from_str::<MemoryDecisionResponse>(&json_str) {
                return Ok(decision);
            }
        }

        // 策略 3：从原始响应提取（防止清理过程破坏内容）
        if let Some(json_str) = Self::extract_first_json_object(response) {
            if let Ok(decision) = serde_json::from_str::<MemoryDecisionResponse>(&json_str) {
                return Ok(decision);
            }
        }

        let preview: String = response.chars().take(300).collect();
        tracing::warn!(
            "[MemoryLLMDecision] 所有 JSON 解析策略失败, raw(前300): {}",
            preview
        );
        Err(anyhow!("LLM 决策响应 JSON 解析失败"))
    }

    /// 从文本中提取第一个平衡的 JSON 对象 `{ ... }`
    fn extract_first_json_object(text: &str) -> Option<String> {
        let mut depth = 0i32;
        let mut start = None;
        for (i, ch) in text.char_indices() {
            match ch {
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
    fn test_memory_event_serde() {
        let json = r#"{"event":"ADD","confidence":0.9,"reason":"test"}"#;
        let response: MemoryDecisionResponse = serde_json::from_str(json).unwrap();
        assert_eq!(response.event, MemoryEvent::ADD);
        assert_eq!(response.confidence, 0.9);
    }

    #[test]
    fn test_extract_and_parse_clean_json() {
        let raw = r#"{"event":"ADD","confidence":0.9,"reason":"test"}"#;
        let json = MemoryLLMDecision::extract_first_json_object(raw).unwrap();
        let resp: MemoryDecisionResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(resp.event, MemoryEvent::ADD);
    }

    #[test]
    fn test_extract_json_from_surrounding_text() {
        let raw = "根据分析，决策如下：\n{\"event\":\"ADD\",\"confidence\":0.9,\"reason\":\"新信息\"}\n以上是我的判断。";
        let json = MemoryLLMDecision::extract_first_json_object(raw).unwrap();
        assert_eq!(
            json,
            "{\"event\":\"ADD\",\"confidence\":0.9,\"reason\":\"新信息\"}"
        );
    }

    #[test]
    fn test_extract_json_with_think_tag() {
        let raw = "<think>让我分析一下...</think>\n{\"event\":\"ADD\",\"confidence\":0.95,\"reason\":\"全新\"}";
        let json = MemoryLLMDecision::extract_first_json_object(raw).unwrap();
        assert_eq!(
            json,
            "{\"event\":\"ADD\",\"confidence\":0.95,\"reason\":\"全新\"}"
        );
    }

    #[test]
    fn test_extract_json_markdown_with_text_before() {
        let raw = "好的，以下是结果：\n```json\n{\"event\":\"UPDATE\",\"target_note_id\":\"note_abc\"}\n```";
        let json = MemoryLLMDecision::extract_first_json_object(raw).unwrap();
        assert_eq!(
            json,
            "{\"event\":\"UPDATE\",\"target_note_id\":\"note_abc\"}"
        );
    }

    #[test]
    fn test_extract_json_returns_none_for_no_json() {
        assert!(MemoryLLMDecision::extract_first_json_object("no json here").is_none());
    }

    #[test]
    fn test_memory_event_from_str() {
        assert_eq!(MemoryEvent::from_str("ADD"), MemoryEvent::ADD);
        assert_eq!(MemoryEvent::from_str("update"), MemoryEvent::UPDATE);
        assert_eq!(MemoryEvent::from_str("APPEND"), MemoryEvent::APPEND);
        assert_eq!(MemoryEvent::from_str("DELETE"), MemoryEvent::DELETE);
        assert_eq!(MemoryEvent::from_str("delete"), MemoryEvent::DELETE);
        assert_eq!(MemoryEvent::from_str("none"), MemoryEvent::NONE);
        assert_eq!(MemoryEvent::from_str("invalid"), MemoryEvent::NONE);
    }
}
