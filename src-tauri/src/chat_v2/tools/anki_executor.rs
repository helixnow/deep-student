//! Anki 工具执行器（CardForge 2.0）
//!
//! 处理 Anki 制卡工具的执行，通过 Tauri 事件桥接到前端 CardAgent。
//!
//! ## 设计说明
//! Anki 工具分两类：
//! 1. **异步执行工具**（桥接到前端 CardAgent）：generate_cards, control_task, export_cards, list_templates, analyze_content
//! 2. **同步查询工具**（后端直接执行）：query_progress
//!
//! ## 处理的工具（统一使用 builtin-anki_* 格式）
//! - `builtin-anki_generate_cards`: 生成卡片（异步，前端执行）
//! - `builtin-anki_control_task`: 控制任务（异步，前端执行）
//! - `builtin-anki_export_cards`: 导出卡片（异步，前端执行）
//! - `builtin-anki_list_templates`: 列出模板（异步，前端执行）
//! - `builtin-anki_analyze_content`: 分析内容（异步，前端执行）
//! - `builtin-anki_query_progress`: 查询进度（同步，后端执行）

use std::time::Instant;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;
use tauri::{Emitter, Listener};
use tokio::sync::oneshot;
use tokio::time::{timeout, Duration};

// ★ 2026-01 改造：tool_ids 不再需要，Anki 工具名通过前缀匹配识别
use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use crate::chat_v2::events::event_types;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};

const FRONTEND_BRIDGE_TIMEOUT_MS: u64 = 120_000;

// ============================================================================
// Anki 工具执行器
// ============================================================================

/// Anki 工具执行器
///
/// 将 Anki 工具调用桥接到前端 CardAgent 执行。
///
/// ## 执行模式
/// 由于 Anki 工具需要前端 CardAgent 的 LLM 调用能力，
/// 后端执行器采用"提交并通知"模式：
/// 1. 发射 `anki_tool_call` 事件到前端
/// 2. 立即返回成功结果（工具已提交）
/// 3. 前端 CardAgent 异步执行，通过 UI 或后续消息反馈结果
pub struct AnkiToolExecutor;

impl AnkiToolExecutor {
    /// 创建新的 Anki 工具执行器
    pub fn new() -> Self {
        Self
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

    /// 检查是否为 Anki 工具
    ///
    /// 支持多种前缀格式：
    /// - anki_*（无前缀）
    /// - builtin-anki_*
    /// - mcp_anki_*
    fn is_anki_tool(tool_name: &str) -> bool {
        let stripped = Self::strip_prefix(tool_name);
        stripped.starts_with("anki_")
    }
}

impl Default for AnkiToolExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for AnkiToolExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        Self::is_anki_tool(tool_name)
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start_time = Instant::now();

        log::debug!(
            "[AnkiToolExecutor] Executing Anki tool: name={}, id={}",
            call.name,
            call.id
        );

        // 1. 发射工具调用开始事件
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        // 🆕 2026-01: 区分同步查询工具和异步执行工具
        let normalized_name = call.name.strip_prefix("builtin-").unwrap_or(&call.name);

        // anki_query_progress 是同步查询工具，直接在后端执行
        if normalized_name == "anki_query_progress" {
            return self.execute_query_progress(call, ctx, start_time).await;
        }

        // 其他工具通过事件桥接到前端 CardAgent
        self.execute_frontend_bridge(call, ctx, start_time).await
    }

    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        // ★ 2026-02-09: anki_export_cards 降为 Low
        // 理由：导出卡片是创建性操作，与 chatanki_export 同理，不应打断制卡体验流
        ToolSensitivity::Low
    }

    fn name(&self) -> &'static str {
        "AnkiToolExecutor"
    }
}

impl AnkiToolExecutor {
    /// 执行查询进度工具（同步，后端直接执行）
    async fn execute_query_progress(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        // 从参数中提取 documentId
        let document_id = call
            .arguments
            .get("documentId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        if document_id.is_empty() {
            let error_msg = "documentId 参数是必需的".to_string();
            ctx.emit_tool_call_error(&error_msg);

            let result = ToolResultInfo::failure(
                Some(call.id.clone()),
                Some(ctx.block_id.clone()),
                call.name.clone(),
                call.arguments.clone(),
                error_msg,
                start_time.elapsed().as_millis() as u64,
            );
            if let Err(e) = ctx.save_tool_block(&result) {
                log::warn!("[AnkiToolExecutor] Failed to save tool block: {}", e);
            }
            return Ok(result);
        }

        let db = match &ctx.anki_db {
            Some(db) => db,
            None => {
                let error_msg = "Anki 数据库未初始化，无法查询制卡进度".to_string();
                ctx.emit_tool_call_error(&error_msg);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[AnkiToolExecutor] Failed to save tool block: {}", e);
                }
                return Ok(result);
            }
        };

        let tasks = db
            .get_tasks_for_document(&document_id)
            .map_err(|e| format!("查询文档任务失败: {}", e))?;
        let total = tasks.len() as u32;
        let mut counts = serde_json::Map::new();
        let mut completed = 0u32;
        let mut failed = 0u32;
        let mut truncated = 0u32;
        let mut paused = 0u32;
        let mut processing = 0u32;
        let mut streaming = 0u32;
        let mut pending = 0u32;
        let mut cancelled = 0u32;

        for task in tasks.iter() {
            match task.status {
                crate::models::TaskStatus::Pending => pending += 1,
                crate::models::TaskStatus::Processing => processing += 1,
                crate::models::TaskStatus::Streaming => streaming += 1,
                crate::models::TaskStatus::Paused => paused += 1,
                crate::models::TaskStatus::Completed => completed += 1,
                crate::models::TaskStatus::Failed => failed += 1,
                crate::models::TaskStatus::Truncated => truncated += 1,
                crate::models::TaskStatus::Cancelled => cancelled += 1,
            }
        }

        counts.insert("total".to_string(), json!(total));
        counts.insert("pending".to_string(), json!(pending));
        counts.insert("processing".to_string(), json!(processing));
        counts.insert("streaming".to_string(), json!(streaming));
        counts.insert("paused".to_string(), json!(paused));
        counts.insert("completed".to_string(), json!(completed));
        counts.insert("failed".to_string(), json!(failed));
        counts.insert("truncated".to_string(), json!(truncated));
        counts.insert("cancelled".to_string(), json!(cancelled));

        let completed_ratio = if total > 0 {
            completed as f32 / total as f32
        } else {
            0.0
        };

        let output = json!({
            "status": "ok",
            "documentId": document_id,
            "counts": counts,
            "completedRatio": completed_ratio,
            "message": "已返回制卡任务进度统计。"
        });

        let duration_ms = start_time.elapsed().as_millis() as u64;

        ctx.emit_tool_call_end(Some(json!({
            "result": output,
            "durationMs": duration_ms,
        })));

        log::info!(
            "[AnkiToolExecutor] Query progress for document {} completed in {}ms",
            document_id,
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

        if let Err(e) = ctx.save_tool_block(&result) {
            log::warn!("[AnkiToolExecutor] Failed to save tool block: {}", e);
        }

        Ok(result)
    }

    /// 执行前端桥接工具（异步，发送事件到前端 CardAgent）
    async fn execute_frontend_bridge(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        #[derive(Debug, Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct AnkiToolResultPayload {
            tool_call_id: String,
            tool_name: Option<String>,
            ok: bool,
            result: Option<serde_json::Value>,
            error: Option<String>,
            window_label: Option<String>,
        }

        // 发射 Anki 工具调用事件到前端
        // 前端 CardAgent 会监听此事件并执行工具
        // 🆕 2026-01: 添加 sessionId，用于前端回调时创建 anki_cards 块
        let event_payload = json!({
            "toolCallId": call.id,
            "toolName": call.name,
            "arguments": call.arguments,
            "messageId": ctx.message_id,
            "blockId": ctx.block_id,
            "sessionId": ctx.session_id,
        });

        // 监听前端回传的工具结果
        let event_name = format!("anki_tool_result:{}", call.id);
        let (tx, rx) = oneshot::channel::<AnkiToolResultPayload>();
        let tx_arc = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
        let expected_label = ctx.window.label().to_string();
        let w = ctx.window.clone();
        let tx_arc_closure = tx_arc.clone();
        let listener_id = w.listen(event_name.clone(), move |e| {
            let payload = e.payload();
            if let Ok(val) = serde_json::from_str::<AnkiToolResultPayload>(payload) {
                if let Some(label) = val.window_label.as_deref() {
                    if label != expected_label {
                        return;
                    }
                }
                if let Ok(mut guard) = tx_arc_closure.lock() {
                    if let Some(sender) = guard.take() {
                        let _ = sender.send(val);
                    }
                }
            }
        });

        if let Err(e) = ctx.window.emit("anki_tool_call", &event_payload) {
            let error_msg = format!("Failed to emit Anki tool call event: {}", e);
            ctx.emit_tool_call_error(&error_msg);
            log::error!("[AnkiToolExecutor] {}", error_msg);

            let result = ToolResultInfo::failure(
                Some(call.id.clone()),
                Some(ctx.block_id.clone()),
                call.name.clone(),
                call.arguments.clone(),
                error_msg,
                start_time.elapsed().as_millis() as u64,
            );

            if let Err(e) = ctx.save_tool_block(&result) {
                log::warn!("[AnkiToolExecutor] Failed to save tool block: {}", e);
            }

            let _ = ctx.window.unlisten(listener_id);
            return Ok(result);
        }

        let timeout_override = call
            .arguments
            .as_object()
            .and_then(|obj| {
                obj.get("_timeoutMs")
                    .or_else(|| obj.get("__bridgeTimeoutMs"))
            })
            .and_then(|v| v.as_u64());
        let timeout_ms: u64 = timeout_override
            .map(|v| v.clamp(1_000, FRONTEND_BRIDGE_TIMEOUT_MS))
            .unwrap_or(FRONTEND_BRIDGE_TIMEOUT_MS);
        match timeout(Duration::from_millis(timeout_ms), rx).await {
            Err(_) => {
                let _ = ctx.window.unlisten(listener_id);
                let error_msg = "Anki tool call timed out".to_string();
                ctx.emit_tool_call_error(&error_msg);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg.clone(),
                    start_time.elapsed().as_millis() as u64,
                );
                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[AnkiToolExecutor] Failed to save tool block: {}", e);
                }
                return Ok(result);
            }
            Ok(Err(_)) => {
                let _ = ctx.window.unlisten(listener_id);
                let error_msg = "Anki tool result channel closed".to_string();
                ctx.emit_tool_call_error(&error_msg);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg.clone(),
                    start_time.elapsed().as_millis() as u64,
                );
                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[AnkiToolExecutor] Failed to save tool block: {}", e);
                }
                return Ok(result);
            }
            Ok(Ok(payload)) => {
                let _ = ctx.window.unlisten(listener_id);
                let duration_ms = start_time.elapsed().as_millis() as u64;
                let output = if let Some(result) = payload.result {
                    result
                } else if let Some(error) = payload.error.clone() {
                    json!({ "error": error })
                } else {
                    json!({ "status": if payload.ok { "ok" } else { "error" } })
                };

                let result = if payload.ok {
                    ctx.emit_tool_call_end(Some(json!({
                        "result": output,
                        "durationMs": duration_ms,
                    })));
                    ToolResultInfo::success(
                        Some(call.id.clone()),
                        Some(ctx.block_id.clone()),
                        call.name.clone(),
                        call.arguments.clone(),
                        output,
                        duration_ms,
                    )
                } else {
                    let error_msg = payload
                        .error
                        .unwrap_or_else(|| "Anki tool failed".to_string());
                    ctx.emit_tool_call_error(&error_msg);
                    ToolResultInfo::failure(
                        Some(call.id.clone()),
                        Some(ctx.block_id.clone()),
                        call.name.clone(),
                        call.arguments.clone(),
                        error_msg,
                        duration_ms,
                    )
                };

                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[AnkiToolExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
        }
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
        let executor = AnkiToolExecutor::new();

        // 统一格式：builtin-anki_*
        assert!(executor.can_handle("builtin-anki_generate_cards"));
        assert!(executor.can_handle("builtin-anki_control_task"));
        assert!(executor.can_handle("builtin-anki_export_cards"));
        assert!(executor.can_handle("builtin-anki_list_templates"));
        assert!(executor.can_handle("builtin-anki_analyze_content"));
        assert!(executor.can_handle("builtin-anki_query_progress"));

        // 旧格式不再支持
        assert!(!executor.can_handle("anki:generate_cards"));
        assert!(!executor.can_handle("anki_generate_cards"));

        // 非 Anki 工具
        assert!(!executor.can_handle("note_read"));
        assert!(!executor.can_handle("web_search"));
        assert!(!executor.can_handle("card_update"));
        assert!(!executor.can_handle("builtin-note_read"));
    }

    #[test]
    fn test_sensitivity_level() {
        let executor = AnkiToolExecutor::new();
        assert_eq!(
            executor.sensitivity_level("builtin-anki_generate_cards"),
            ToolSensitivity::Low
        );
    }

    #[test]
    fn test_name() {
        let executor = AnkiToolExecutor::new();
        assert_eq!(executor.name(), "AnkiToolExecutor");
    }
}
