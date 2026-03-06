//! 通用工具执行器
//!
//! 处理所有非 Canvas 工具的执行，通过 ToolRegistry 调用。
//!
//! ## 设计文档
//! 参考：`src/chat-v2/docs/29-ChatV2-Agent能力增强改造方案.md` 第 2.3.5 节

use std::time::Instant;

use async_trait::async_trait;
use serde_json::json;

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::is_canvas_tool;
use crate::chat_v2::events::event_types;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::tools::ToolContext;

// ============================================================================
// 通用工具执行器
// ============================================================================

/// 通用工具执行器
///
/// 处理所有非 Canvas 工具，通过 `ToolRegistry.call_tool()` 执行。
///
/// ## 处理的工具
/// - 所有非 Canvas 工具（`!is_canvas_tool(name)`）
///
/// ## 执行步骤
/// 1. 发射 `tool_call` start 事件
/// 2. 构建 `ToolContext`
/// 3. 调用 `tool_registry.call_tool()`
/// 4. 超时控制由 ToolExecutorRegistry 统一处理
/// 5. 发射 end/error 事件
/// 6. 返回 `ToolResultInfo`
pub struct GeneralToolExecutor;

impl GeneralToolExecutor {
    /// 创建新的通用工具执行器
    pub fn new() -> Self {
        Self
    }
}

impl Default for GeneralToolExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for GeneralToolExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        // 处理所有非 Canvas 工具
        !is_canvas_tool(tool_name)
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start_time = Instant::now();

        log::debug!(
            "[GeneralToolExecutor] Executing tool: name={}, id={}",
            call.name,
            call.id
        );

        // 1. 发射工具调用开始事件
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        // 2. 构建工具上下文
        let tool_ctx = ToolContext {
            db: ctx.main_db.as_ref().map(|db| db.as_ref()),
            mcp_client: None,
            supports_tools: true,
            window: Some(&ctx.window),
            stream_event: None,
            stage: Some("tool_call"),
            memory_enabled: None, // 🔧 P1-36: 通用工具执行不涉及记忆开关
            llm_manager: ctx.llm_manager.clone(), // 🔧 重排器功能恢复
        };

        // 3. 执行工具调用（超时由 ToolExecutorRegistry 统一控制）
        let (ok, data, error, _usage, _citations, _inject) = ctx
            .tool_registry
            .call_tool(&call.name, &call.arguments, &tool_ctx)
            .await;

        let duration_ms = start_time.elapsed().as_millis() as u64;

        // 4. 处理结果
        if ok {
            // 工具调用成功
            let output = data.unwrap_or(json!(null));
            ctx.emit_tool_call_end(Some(json!({
                "result": output,
                "durationMs": duration_ms,
            })));

            log::debug!(
                "[GeneralToolExecutor] Tool {} completed successfully in {}ms",
                call.name,
                duration_ms
            );

            let result = ToolResultInfo::success(
                Some(call.id.clone()),
                Some(ctx.block_id.clone()),
                call.name.clone(),
                call.arguments.clone(),
                output,
                duration_ms,
            );

            // 🆕 SSOT: 后端立即保存工具块（防闪退）
            if let Err(e) = ctx.save_tool_block(&result) {
                log::warn!("[GeneralToolExecutor] Failed to save tool block: {}", e);
            }

            Ok(result)
        } else {
            // 工具调用返回错误
            let error_msg = error.unwrap_or_else(|| "Tool call failed".to_string());
            ctx.emit_tool_call_error(&error_msg);

            log::warn!(
                "[GeneralToolExecutor] Tool {} failed: {} ({}ms)",
                call.name,
                error_msg,
                duration_ms
            );

            let result = ToolResultInfo::failure(
                Some(call.id.clone()),
                Some(ctx.block_id.clone()),
                call.name.clone(),
                call.arguments.clone(),
                error_msg,
                duration_ms,
            );

            // 🆕 SSOT: 后端立即保存工具块（防闪退）
            if let Err(e) = ctx.save_tool_block(&result) {
                log::warn!("[GeneralToolExecutor] Failed to save tool block: {}", e);
            }

            Ok(result)
        }
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        // 默认提升到 Medium，避免审批机制被通用执行器绕过
        const LOW_RISK_TOOLS: &[&str] = &[
            // 明确的只读/外部检索工具
            "web_search",
            "mcp_brave_search",
            "mcp_web_search",
        ];

        const HIGH_RISK_TOOLS: &[&str] = &[
            // 明确的高风险工具
            "mcp_shell_execute",
            "mcp_file_write",
            "mcp_file_delete",
        ];

        if HIGH_RISK_TOOLS.contains(&tool_name) {
            log::debug!(
                "[GeneralToolExecutor] Tool '{}' is registered as high-risk -> High sensitivity",
                tool_name
            );
            return ToolSensitivity::High;
        }

        if LOW_RISK_TOOLS.contains(&tool_name) {
            return ToolSensitivity::Low;
        }

        ToolSensitivity::Medium
    }

    fn name(&self) -> &'static str {
        "GeneralToolExecutor"
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_can_handle() {
        let executor = GeneralToolExecutor::new();

        // 不处理 Canvas 工具
        assert!(!executor.can_handle("note_read"));
        assert!(!executor.can_handle("note_append"));
        assert!(!executor.can_handle("note_replace"));
        assert!(!executor.can_handle("note_set"));

        // 处理其他工具
        assert!(executor.can_handle("web_search"));
        assert!(executor.can_handle("mcp_brave_search"));
        assert!(executor.can_handle("some_custom_tool"));
    }

    #[test]
    fn test_sensitivity_level() {
        let executor = GeneralToolExecutor::new();

        // 明确的低风险工具
        assert_eq!(
            executor.sensitivity_level("web_search"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("mcp_brave_search"),
            ToolSensitivity::Low
        );

        // 默认 Medium
        assert_eq!(
            executor.sensitivity_level("some_custom_tool"),
            ToolSensitivity::Medium
        );

        // 明确高风险
        assert_eq!(
            executor.sensitivity_level("mcp_shell_execute"),
            ToolSensitivity::High
        );
    }

    #[test]
    fn test_name() {
        let executor = GeneralToolExecutor::new();
        assert_eq!(executor.name(), "GeneralToolExecutor");
    }
}
