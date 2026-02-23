//! attempt_completion 工具
//!
//! 用于 Agent 显式结束任务，标记任务完成状态。
//!
//! ## 设计文档
//! 参考：`src/chat-v2/docs/29-ChatV2-Agent能力增强改造方案.md` 第 5 节
//!
//! ## 工具行为
//! 1. 标记 `task_completed = true`
//! 2. 终止递归 Agent 循环
//! 3. 返回最终结果作为 assistant 消息内容

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

// ============================================================================
// 工具常量
// ============================================================================

/// 工具名称
pub const TOOL_NAME: &str = "attempt_completion";

/// 工具描述
pub const TOOL_DESCRIPTION: &str = r#"当任务完成时，使用此工具向用户展示最终结果。
这将终止当前的 Agent 循环，不再执行后续工具调用。
只有在确认任务已完成时才应该调用此工具。"#;

// ============================================================================
// 参数和结果类型
// ============================================================================

/// attempt_completion 工具参数
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttemptCompletionParams {
    /// 任务完成的最终结果或总结
    pub result: String,
    /// 建议用户执行的命令（可选）
    #[serde(default)]
    pub command: Option<String>,
}

/// attempt_completion 工具结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttemptCompletionResult {
    /// 是否成功标记完成
    pub completed: bool,
    /// 最终结果
    pub result: String,
    /// 建议命令
    pub command: Option<String>,
}

// ============================================================================
// 工具 Schema
// ============================================================================

/// 获取工具 JSON Schema
pub fn get_schema() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": TOOL_NAME,
            "description": TOOL_DESCRIPTION,
            "parameters": {
                "type": "object",
                "properties": {
                    "result": {
                        "type": "string",
                        "description": "任务完成的最终结果或总结，将展示给用户"
                    },
                    "command": {
                        "type": "string",
                        "description": "建议用户执行的命令（可选），如编译、运行等"
                    }
                },
                "required": ["result"]
            }
        }
    })
}

// ============================================================================
// 工具执行
// ============================================================================

/// 解析参数
pub fn parse_params(arguments: &Value) -> Result<AttemptCompletionParams, String> {
    let result = arguments
        .get("result")
        .and_then(|v| v.as_str())
        .ok_or("缺少必需参数: result")?
        .to_string();

    let command = arguments
        .get("command")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    Ok(AttemptCompletionParams { result, command })
}

/// 执行工具
///
/// 注意：此工具的实际效果（设置 task_completed 标志）需要在 Pipeline 中处理
pub fn execute(params: AttemptCompletionParams) -> AttemptCompletionResult {
    AttemptCompletionResult {
        completed: true,
        result: params.result,
        command: params.command,
    }
}

/// 将结果转换为 JSON
pub fn result_to_json(result: &AttemptCompletionResult) -> Value {
    json!({
        "completed": result.completed,
        "result": result.result,
        "command": result.command
    })
}

/// 去除工具名前缀
///
/// 支持的前缀：builtin-, mcp_
fn strip_prefix(tool_name: &str) -> &str {
    tool_name
        .strip_prefix("builtin-")
        .or_else(|| tool_name.strip_prefix("mcp_"))
        .unwrap_or(tool_name)
}

/// 检查工具名称是否为 attempt_completion
///
/// 支持多种前缀格式：
/// - attempt_completion（无前缀）
/// - builtin-attempt_completion
/// - mcp_attempt_completion
pub fn is_attempt_completion(tool_name: &str) -> bool {
    strip_prefix(tool_name) == TOOL_NAME
}

// ============================================================================
// AttemptCompletionExecutor（文档 29 P1-4）
// ============================================================================

use async_trait::async_trait;
use std::time::Instant;

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use crate::chat_v2::events::event_types;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};

/// AttemptCompletion 工具执行器
///
/// 处理 `attempt_completion` 工具调用，标记任务完成。
///
/// ## 特殊行为
/// - 返回的 `ToolResultInfo.output` 中包含 `task_completed: true`
/// - Pipeline 应检测此标志并终止递归循环
pub struct AttemptCompletionExecutor;

impl AttemptCompletionExecutor {
    pub fn new() -> Self {
        Self
    }
}

impl Default for AttemptCompletionExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for AttemptCompletionExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        is_attempt_completion(tool_name)
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start = Instant::now();

        // 发射开始事件
        ctx.emitter.emit_tool_call_start(
            &ctx.message_id,
            &ctx.block_id,
            TOOL_NAME,
            call.arguments.clone(),
            Some(&call.id), // 🆕 tool_call_id
            None,           // variant_id: 单变体模式
        );

        // 解析参数
        let params = match parse_params(&call.arguments) {
            Ok(p) => p,
            Err(e) => {
                ctx.emitter
                    .emit_error(event_types::TOOL_CALL, &ctx.block_id, &e, None);
                let result = ToolResultInfo {
                    tool_call_id: Some(call.id.clone()),
                    block_id: Some(ctx.block_id.clone()),
                    tool_name: TOOL_NAME.to_string(),
                    input: call.arguments.clone(),
                    output: json!(null),
                    success: false,
                    error: Some(e),
                    duration_ms: Some(start.elapsed().as_millis() as u64),
                    reasoning_content: None,
                    thought_signature: None,
                };

                // 🆕 SSOT: 后端立即保存工具块（防闪退）
                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!(
                        "[AttemptCompletionExecutor] Failed to save tool block: {}",
                        e
                    );
                }

                return Ok(result);
            }
        };

        // 执行工具
        let result = execute(params);
        let duration_ms = start.elapsed().as_millis() as u64;

        // 构建输出（包含 task_completed 标志）
        let output = json!({
            "completed": result.completed,
            "result": result.result,
            "command": result.command,
            "task_completed": true, // 🆕 关键标志：Pipeline 应检测此标志
        });

        // 发射结束事件
        ctx.emitter.emit_end(
            event_types::TOOL_CALL,
            &ctx.block_id,
            Some(json!({
                "result": output,
                "durationMs": duration_ms,
            })),
            None,
        );

        log::info!(
            "[AttemptCompletionExecutor] Task completed: result_len={}, command={:?}",
            result.result.len(),
            result.command
        );

        let tool_result = ToolResultInfo {
            tool_call_id: Some(call.id.clone()),
            block_id: Some(ctx.block_id.clone()),
            tool_name: TOOL_NAME.to_string(),
            input: call.arguments.clone(),
            output,
            success: true,
            error: None,
            duration_ms: Some(duration_ms),
            reasoning_content: None,
            thought_signature: None,
        };

        // 🆕 SSOT: 后端立即保存工具块（防闪退）
        if let Err(e) = ctx.save_tool_block(&tool_result) {
            log::warn!(
                "[AttemptCompletionExecutor] Failed to save tool block: {}",
                e
            );
        }

        Ok(tool_result)
    }

    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        // attempt_completion 是低敏感工具，无需审批
        ToolSensitivity::Low
    }

    fn name(&self) -> &'static str {
        "AttemptCompletionExecutor"
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_params() {
        let args = json!({
            "result": "任务完成",
            "command": "cargo build"
        });

        let params = parse_params(&args).unwrap();
        assert_eq!(params.result, "任务完成");
        assert_eq!(params.command, Some("cargo build".to_string()));
    }

    #[test]
    fn test_parse_params_without_command() {
        let args = json!({
            "result": "任务完成"
        });

        let params = parse_params(&args).unwrap();
        assert_eq!(params.result, "任务完成");
        assert!(params.command.is_none());
    }

    #[test]
    fn test_execute() {
        let params = AttemptCompletionParams {
            result: "测试完成".to_string(),
            command: None,
        };

        let result = execute(params);
        assert!(result.completed);
        assert_eq!(result.result, "测试完成");
    }

    #[test]
    fn test_schema() {
        let schema = get_schema();
        assert_eq!(schema["function"]["name"], TOOL_NAME);
    }
}
