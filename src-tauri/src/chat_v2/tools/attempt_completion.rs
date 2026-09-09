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

use crate::chat_v2::finalizer::DeclaredArtifact;

// ============================================================================
// 工具常量
// ============================================================================

/// 工具名称
pub const TOOL_NAME: &str = "attempt_completion";

/// 工具描述
pub const TOOL_DESCRIPTION: &str = r#"当任务完成时，使用此工具向用户展示最终结果。
这将终止当前的 Agent 循环，不再执行后续工具调用。
只有在确认任务已完成时才应该调用此工具。
如果任务产生了文件产物，result 中应包含产物清单（相对路径 + 一句话用途），
并同时在 artifacts 参数中显式申报产物（相对路径 + 可选 sha256）；
后端验收器（TaskFinalizer）会核对申报产物真实存在，验收结论写入完成块。"#;

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
    /// 显式申报的任务产物（可选，G07-a）
    ///
    /// 申报后后端 TaskFinalizer 会核对产物在对应 runtime root 下真实存在、
    /// sha256（若申报）匹配；不申报则按纯解释性回答的兼容语义处理。
    #[serde(default)]
    pub artifacts: Option<Vec<DeclaredArtifact>>,
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
                    },
                    "artifacts": {
                        "type": "array",
                        "description": "任务产生的文件产物清单（可选）。申报后后端验收器会核对产物真实存在与内容哈希。",
                        "items": {
                            "type": "object",
                            "properties": {
                                "path": {
                                    "type": "string",
                                    "description": "产物相对路径（相对 runtime root，默认 artifacts root；拒绝绝对路径与 ..）"
                                },
                                "sha256": {
                                    "type": "string",
                                    "description": "产物内容的 SHA-256 hex（可选；申报即校验）"
                                },
                                "root_id": {
                                    "type": "string",
                                    "description": "产物所在 runtime root（可选，默认 artifacts；可选 workspace/temp/authorized_*/skill:*）"
                                }
                            },
                            "required": ["path"]
                        }
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

    // G07-a：可选产物申报。格式错误时拒绝本次调用（模型可修正后重试），
    // 不静默吞掉——申报了却无法核查比不申报更糟糕。
    let artifacts = arguments
        .get("artifacts")
        .filter(|v| !v.is_null())
        .map(|v| {
            serde_json::from_value::<Vec<DeclaredArtifact>>(v.clone())
                .map_err(|e| format!("artifacts 参数格式错误: {}", e))
        })
        .transpose()?;

    Ok(AttemptCompletionParams {
        result,
        command,
        artifacts,
    })
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
/// 支持的前缀：builtin-, builtin:
///
/// 🔒 刻意**不**剥 `mcp_` / `mcp.tools.`：外部 MCP 服务器暴露的同名工具
/// 由不受信实现提供，不能被当作 builtin 控制工具（否则受限运行时白名单
/// 与 headless 完成检测都会被同名外部工具冒名顶替）。builtin 的
/// attempt_completion 在注入与落库时始终使用裸名/builtin 命名空间。
fn strip_prefix(tool_name: &str) -> &str {
    tool_name
        .strip_prefix("builtin-")
        .or_else(|| tool_name.strip_prefix("builtin:"))
        .unwrap_or(tool_name)
}

/// 检查工具名称是否为 attempt_completion
///
/// 支持的格式：
/// - attempt_completion（无前缀）
/// - builtin-attempt_completion / builtin:attempt_completion
///
/// `mcp_attempt_completion` 等外部 MCP 命名空间**不**匹配（见 strip_prefix）。
pub fn is_attempt_completion(tool_name: &str) -> bool {
    strip_prefix(tool_name) == TOOL_NAME
}

// ============================================================================
// AttemptCompletionExecutor（文档 29 P1-4）
// ============================================================================

use async_trait::async_trait;
use std::time::Instant;

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
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
        ctx.emit_tool_call_start(TOOL_NAME, call.arguments.clone(), Some(&call.id));

        // 解析参数
        let params = match parse_params(&call.arguments) {
            Ok(p) => p,
            Err(e) => {
                ctx.emit_tool_call_error(&e);
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
        ctx.emit_tool_call_end(Some(json!({
            "result": output,
            "durationMs": duration_ms,
        })));

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
        assert!(params.artifacts.is_none());
    }

    /// 🆕 G07-a：可选产物申报解析
    #[test]
    fn test_parse_params_with_artifacts() {
        let args = json!({
            "result": "已生成报告",
            "artifacts": [
                {"path": "report.md", "sha256": "abc123"},
                {"path": "data/out.xlsx", "root_id": "workspace"}
            ]
        });

        let params = parse_params(&args).unwrap();
        let artifacts = params.artifacts.unwrap();
        assert_eq!(artifacts.len(), 2);
        assert_eq!(artifacts[0].path, "report.md");
        assert_eq!(artifacts[0].sha256, Some("abc123".to_string()));
        assert!(artifacts[0].root_id.is_none());
        assert_eq!(artifacts[1].path, "data/out.xlsx");
        assert_eq!(artifacts[1].root_id, Some("workspace".to_string()));
        assert!(artifacts[1].sha256.is_none());
    }

    /// 🆕 G07-a：artifacts 格式错误时拒绝调用（不静默吞掉申报）
    #[test]
    fn test_parse_params_rejects_malformed_artifacts() {
        let args = json!({
            "result": "任务完成",
            "artifacts": [{"sha256": "abc123"}] // 缺少必需 path
        });
        assert!(parse_params(&args).is_err());

        let args = json!({
            "result": "任务完成",
            "artifacts": "not-an-array"
        });
        assert!(parse_params(&args).is_err());
    }

    #[test]
    fn test_execute() {
        let params = AttemptCompletionParams {
            result: "测试完成".to_string(),
            command: None,
            artifacts: None,
        };

        let result = execute(params);
        assert!(result.completed);
        assert_eq!(result.result, "测试完成");
    }

    #[test]
    fn test_schema() {
        let schema = get_schema();
        assert_eq!(schema["function"]["name"], TOOL_NAME);
        // 🆕 G07-a：artifacts 为可选参数（不进 required）
        let params = &schema["function"]["parameters"];
        assert!(params["properties"]["artifacts"].is_object());
        assert_eq!(params["required"], json!(["result"]));
    }

    /// 🔒 外部 MCP 命名空间不得冒名顶替 builtin 控制工具
    #[test]
    fn mcp_namespaced_names_are_not_attempt_completion() {
        assert!(is_attempt_completion("attempt_completion"));
        assert!(is_attempt_completion("builtin-attempt_completion"));
        assert!(is_attempt_completion("builtin:attempt_completion"));
        assert!(!is_attempt_completion("mcp_attempt_completion"));
        assert!(!is_attempt_completion("mcp.tools.attempt_completion"));
        assert!(!is_attempt_completion("other_tool"));
    }
}
