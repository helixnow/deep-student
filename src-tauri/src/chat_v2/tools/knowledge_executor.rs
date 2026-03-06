//! 知识工具执行器
//!
//! 执行知识提取相关的内置工具：
//! - `builtin-knowledge_extract` - 从对话中提取知识点并保存到待处理记忆候选表

use std::time::Instant;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::events::event_types;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};

/// 知识工具执行器
pub struct KnowledgeExecutor;

impl KnowledgeExecutor {
    /// 创建新的知识工具执行器
    pub fn new() -> Self {
        Self
    }

    // ========================================================================
    // 工具实现
    // ========================================================================

    /// 执行 knowledge_extract - 从对话中提取知识点
    async fn execute_extract(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        // 解析参数
        let conversation_id = call
            .arguments
            .get("conversation_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'conversation_id' parameter")?;

        let chat_history = call
            .arguments
            .get("chat_history")
            .and_then(|v| v.as_array())
            .ok_or("Missing 'chat_history' parameter")?;

        if chat_history.is_empty() {
            return Err("chat_history 不能为空".to_string());
        }

        let focus_categories: Option<Vec<String>> = call
            .arguments
            .get("focus_categories")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            });

        // 获取 LLM Manager
        let llm_manager = ctx
            .llm_manager
            .clone()
            .ok_or("LLM Manager not available in context")?;

        // 构建提取提示词
        let prompt = build_extraction_prompt(chat_history, focus_categories.as_deref());

        // 调用 LLM 提取知识点
        let mut context = std::collections::HashMap::new();
        context.insert("task".to_string(), serde_json::json!(prompt));

        let response = llm_manager
            .call_unified_model_2(&context, &[], "通用", false, None, Some(&prompt), None)
            .await
            .map_err(|e| format!("AI 提取失败: {}", e))?;

        // 解析响应
        let candidates = parse_extraction_response(&response.assistant_message)
            .map_err(|e| format!("解析提取结果失败: {}", e))?;

        // 规范化 conversation_id
        let normalized_id = conversation_id
            .strip_prefix("chat-")
            .unwrap_or(conversation_id)
            .to_string();

        // 保存到待处理记忆候选表（如果有主数据库），使用事务保证原子性
        let mut saved_count = 0usize;
        if !candidates.is_empty() {
            if let Some(db) = &ctx.main_db {
                match db.get_conn_safe() {
                    Ok(conn) => {
                        if let Err(e) = conn.execute("BEGIN", []) {
                            log::warn!("[knowledge_extract] 开启事务失败: {}", e);
                        } else {
                            // 清除旧的待处理候选
                            if let Err(e) = conn.execute(
                                "DELETE FROM pending_memory_candidates WHERE conversation_id = ?1 AND status = 'pending'",
                                rusqlite::params![&normalized_id],
                            ) {
                                log::warn!("[knowledge_extract] 清除旧候选失败，回滚: {}", e);
                                let _ = conn.execute("ROLLBACK", []);
                            } else {
                                // 插入新候选
                                let mut insert_failed = false;
                                for candidate in &candidates {
                                    match conn.execute(
                                        "INSERT INTO pending_memory_candidates (conversation_id, subject, content, category, origin, user_edited) \
                                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                                        rusqlite::params![
                                            &normalized_id,
                                            "通用",
                                            &candidate.content,
                                            &candidate.category,
                                            "tool_extract",
                                            0
                                        ],
                                    ) {
                                        Ok(_) => saved_count += 1,
                                        Err(e) => {
                                            log::warn!("[knowledge_extract] 保存候选失败，回滚: {}", e);
                                            let _ = conn.execute("ROLLBACK", []);
                                            insert_failed = true;
                                            saved_count = 0;
                                            break;
                                        }
                                    }
                                }

                                if !insert_failed {
                                    if let Err(e) = conn.execute("COMMIT", []) {
                                        log::warn!("[knowledge_extract] 提交事务失败: {}", e);
                                        let _ = conn.execute("ROLLBACK", []);
                                        saved_count = 0;
                                    }
                                }
                            }
                        }

                        if saved_count > 0 {
                            log::info!("[knowledge_extract] 已保存 {} 条候选到数据库", saved_count);
                        }
                    }
                    Err(e) => {
                        log::warn!("[knowledge_extract] 获取数据库连接失败: {}", e);
                    }
                }
            }
        }

        log::info!(
            "[knowledge_extract] 提取完成: conversation_id={}, candidates={}",
            normalized_id,
            candidates.len()
        );

        Ok(json!({
            "success": true,
            "conversation_id": normalized_id,
            "candidates": candidates,
            "count": candidates.len(),
            "message": if candidates.is_empty() {
                "未能从对话中提取到知识点".to_string()
            } else {
                format!("成功提取 {} 条知识点候选", candidates.len())
            },
        }))
    }
}

impl Default for KnowledgeExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for KnowledgeExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        let stripped = strip_tool_namespace(tool_name);
        matches!(stripped, "knowledge_extract")
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start_time = Instant::now();
        let tool_name = strip_tool_namespace(&call.name);

        log::debug!(
            "[KnowledgeExecutor] Executing tool: {} (full: {})",
            tool_name,
            call.name
        );

        // 🔧 修复：发射工具调用开始事件，让前端立即显示工具调用 UI
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let result = match tool_name {
            "knowledge_extract" => self.execute_extract(call, ctx).await,
            _ => Err(format!("Unknown knowledge tool: {}", tool_name)),
        };

        let duration = start_time.elapsed().as_millis() as u64;

        match result {
            Ok(output) => {
                log::debug!(
                    "[KnowledgeExecutor] Tool {} completed in {}ms",
                    tool_name,
                    duration
                );

                // 🔧 修复：发射工具调用结束事件
                ctx.emit_tool_call_end(Some(json!({
                    "result": output,
                    "durationMs": duration,
                })));

                let result = ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration,
                );

                // 🆕 SSOT: 后端立即保存工具块（防闪退）
                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[KnowledgeExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
            Err(e) => {
                log::error!("[KnowledgeExecutor] Tool {} failed: {}", tool_name, e);

                // 🔧 修复：发射工具调用错误事件
                ctx.emit_tool_call_error(&e);

                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    e,
                    duration,
                );

                // 🆕 SSOT: 后端立即保存工具块（防闪退）
                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[KnowledgeExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
        }
    }

    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        // 所有知识工具都是低风险操作，无需用户审批
        ToolSensitivity::Low
    }

    fn name(&self) -> &'static str {
        "KnowledgeExecutor"
    }
}

// ============================================================================
// 辅助函数
// ============================================================================

/// 知识点候选
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeCandidate {
    pub content: String,
    pub category: String,
}

/// 构建提取提示词
fn build_extraction_prompt(chat_history: &[Value], focus_categories: Option<&[String]>) -> String {
    let mut prompt = String::from(
        "你是知识整理助手。请从以下对话中提取值得长期记住的知识点，生成简要的知识候选条目。\n\n",
    );

    // 添加对话历史
    prompt.push_str("【对话记录】\n");
    for msg in chat_history {
        let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("user");
        let content = msg.get("content").and_then(|v| v.as_str()).unwrap_or("");
        prompt.push_str(&format!("{}: {}\n", role, content));
    }
    prompt.push('\n');

    // 添加重点类别（如果有）
    if let Some(categories) = focus_categories {
        if !categories.is_empty() {
            prompt.push_str(&format!("【重点提取类别】{}\n\n", categories.join("、")));
        }
    }

    prompt.push_str(
        r#"【输出要求】
请以 JSON 数组格式输出知识点候选，每个条目包含：
- content: 知识点内容（简洁明了）
- category: 知识类别（如：概念、定理、公式、方法、技巧、易错点、总结等）

【示例输出】
```json
[
  {"content": "勾股定理：直角三角形两直角边的平方和等于斜边的平方", "category": "定理"},
  {"content": "解一元二次方程可用公式法、配方法、因式分解法", "category": "方法"}
]
```

【注意事项】
1. 只提取有价值的知识点，忽略寒暄和无关内容
2. 内容要简洁，便于记忆
3. 类别要准确反映知识点性质
4. 如果对话中没有明确的知识点，返回空数组 []

请直接输出 JSON 数组，不要添加额外说明。"#,
    );

    prompt
}

/// 解析提取响应
fn parse_extraction_response(response: &str) -> Result<Vec<KnowledgeCandidate>, String> {
    let trimmed = response.trim();

    // 尝试移除 markdown 代码块
    let cleaned = trimmed
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    // 解析 JSON
    let parsed: Value =
        serde_json::from_str(cleaned).map_err(|e| format!("JSON 解析失败: {}", e))?;

    // 确保是数组
    let array = parsed.as_array().ok_or("响应不是 JSON 数组")?;

    // 转换为 KnowledgeCandidate
    let candidates: Vec<KnowledgeCandidate> = array
        .iter()
        .filter_map(|item| {
            let content = item.get("content")?.as_str()?.to_string();
            let category = item.get("category")?.as_str()?.to_string();
            Some(KnowledgeCandidate { content, category })
        })
        .collect();

    Ok(candidates)
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_can_handle() {
        let executor = KnowledgeExecutor::new();

        // 处理知识工具
        assert!(!executor.can_handle("builtin-knowledge_internalize")); // deprecated
        assert!(executor.can_handle("builtin-knowledge_extract"));

        // 不处理其他工具
        assert!(!executor.can_handle("builtin-memory_search"));
        assert!(!executor.can_handle("builtin-rag_search"));
        assert!(!executor.can_handle("note_read"));
    }

    #[test]
    fn test_strip_namespace() {
        assert_eq!(
            strip_tool_namespace("knowledge_extract"),
            "knowledge_extract"
        );
    }

    #[test]
    fn test_sensitivity_level() {
        let executor = KnowledgeExecutor::new();

        assert_eq!(
            executor.sensitivity_level("builtin-knowledge_extract"),
            ToolSensitivity::Low
        );
    }

    #[test]
    fn test_parse_extraction_response() {
        let response = r#"```json
[
  {"content": "勾股定理", "category": "定理"},
  {"content": "公式法解方程", "category": "方法"}
]
```"#;

        let candidates = parse_extraction_response(response).unwrap();
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].content, "勾股定理");
        assert_eq!(candidates[0].category, "定理");
    }

    #[test]
    fn test_parse_empty_response() {
        let response = "[]";
        let candidates = parse_extraction_response(response).unwrap();
        assert!(candidates.is_empty());
    }
}
