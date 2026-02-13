//! 用户提问工具执行器
//!
//! 在工具调用循环中向用户提出轻量级问题，不中断执行流程。
//! 使用 oneshot channel 等待前端响应，30 秒超时自动选择推荐选项。
//!
//! ## 流程
//! 1. LLM 调用 `builtin-ask_user` 工具
//! 2. Executor 发射 `tool_call_start` 事件（前端创建 ask_user 块）
//! 3. 创建 oneshot channel，注册到全局 PENDING_ASK_CALLBACKS
//! 4. 等待前端通过 Tauri command 发送用户回答，或 30s 超时
//! 5. 构造 ToolResultInfo 返回给 Pipeline，注入下一轮 LLM 请求
//!
//! ## 设计参考
//! - `canvas_executor.rs`: PENDING_CALLBACKS + oneshot channel 模式
//! - `approval_manager.rs`: 超时 + 前端交互模式

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::oneshot;

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use crate::chat_v2::events::event_types;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};

// ============================================================================
// 类型定义
// ============================================================================

/// 用户回答数据（从前端接收）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskUserResponse {
    /// 工具调用 ID（用于匹配等待的 channel）
    pub tool_call_id: String,
    /// 用户选择的文本内容
    pub selected_text: String,
    /// 选择的选项索引（0-2 为固定选项，-1 为自定义输入）
    pub selected_index: Option<i32>,
    /// 回答来源："user_click" | "custom_input" | "timeout"
    pub source: String,
}

// ============================================================================
// 全局回调管理（参考 canvas_executor.rs PENDING_CALLBACKS 模式）
// ============================================================================

type AskUserSender = oneshot::Sender<AskUserResponse>;

use std::sync::LazyLock;

/// 等待用户回答的回调映射 Map<tool_call_id, Sender>
static PENDING_ASK_CALLBACKS: LazyLock<Arc<Mutex<HashMap<String, AskUserSender>>>> =
    LazyLock::new(|| Arc::new(Mutex::new(HashMap::new())));

/// 注册等待回调
fn register_ask_callback(tool_call_id: &str, sender: AskUserSender) {
    let mut callbacks = PENDING_ASK_CALLBACKS.lock().unwrap_or_else(|poisoned| {
        log::error!("[AskUserExecutor] PENDING_ASK_CALLBACKS mutex poisoned! Attempting recovery");
        poisoned.into_inner()
    });
    callbacks.insert(tool_call_id.to_string(), sender);
}

/// 处理用户回答（由 Tauri command `chat_v2_ask_user_respond` 调用）
///
/// 从全局 map 中取出对应的 Sender，将用户回答发送给等待的 executor。
pub fn handle_ask_user_response(response: AskUserResponse) {
    let mut callbacks = PENDING_ASK_CALLBACKS.lock().unwrap_or_else(|poisoned| {
        log::error!("[AskUserExecutor] PENDING_ASK_CALLBACKS mutex poisoned! Attempting recovery");
        poisoned.into_inner()
    });
    if let Some(sender) = callbacks.remove(&response.tool_call_id) {
        let _ = sender.send(response);
    } else {
        log::warn!(
            "[AskUserExecutor] No pending callback for tool_call_id: {}",
            response.tool_call_id
        );
    }
}

/// 用户提问超时时间（毫秒）
const ASK_USER_TIMEOUT_MS: u64 = 30_000;

// ============================================================================
// 工具执行器
// ============================================================================

/// 用户提问工具执行器
///
/// 在工具调用循环中向用户提出轻量级问题。
/// 提供 3 个固定选项 + 自定义输入，30 秒超时自动选择推荐选项。
pub struct AskUserExecutor;

impl AskUserExecutor {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl ToolExecutor for AskUserExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        let stripped = tool_name
            .strip_prefix("builtin-")
            .or_else(|| tool_name.strip_prefix("mcp_"))
            .unwrap_or(tool_name);
        stripped == "ask_user"
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start = Instant::now();

        // 1. 解析参数
        let question = call
            .arguments
            .get("question")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let options: Vec<String> = call
            .arguments
            .get("options")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        let recommended = call
            .arguments
            .get("recommended")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as usize;
        let _context = call
            .arguments
            .get("context")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        log::info!(
            "[AskUserExecutor] Asking user: question='{}', options={:?}, recommended={}",
            question,
            options,
            recommended
        );

        // 2. 发射 tool_call_start 事件（前端创建 ask_user 类型 block）
        ctx.emitter.emit_tool_call_start(
            &ctx.message_id,
            &ctx.block_id,
            &call.name,
            call.arguments.clone(),
            Some(&call.id),
            None,
        );

        // 3. 创建 oneshot channel，注册回调
        let (tx, rx) = oneshot::channel();
        register_ask_callback(&call.id, tx);

        // 4. 等待用户回答或超时
        let answer = tokio::select! {
            result = rx => {
                match result {
                    Ok(resp) => {
                        log::info!(
                            "[AskUserExecutor] Received user response: selected='{}', source='{}'",
                            resp.selected_text, resp.source
                        );
                        resp
                    }
                    Err(_) => {
                        log::warn!("[AskUserExecutor] Channel closed, using recommended option");
                        AskUserResponse {
                            tool_call_id: call.id.clone(),
                            selected_text: options.get(recommended).cloned().unwrap_or_default(),
                            selected_index: Some(recommended as i32),
                            source: "channel_closed".to_string(),
                        }
                    }
                }
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(ASK_USER_TIMEOUT_MS)) => {
                log::info!(
                    "[AskUserExecutor] Timeout ({}ms), auto-selecting recommended option: '{}'",
                    ASK_USER_TIMEOUT_MS,
                    options.get(recommended).unwrap_or(&String::new())
                );
                // 超时：清理回调
                {
                    let mut callbacks = PENDING_ASK_CALLBACKS.lock().unwrap_or_else(|p| p.into_inner());
                    callbacks.remove(&call.id);
                }
                AskUserResponse {
                    tool_call_id: call.id.clone(),
                    selected_text: options.get(recommended).cloned().unwrap_or_default(),
                    selected_index: Some(recommended as i32),
                    source: "timeout".to_string(),
                }
            }
        };

        let duration_ms = start.elapsed().as_millis() as u64;

        // 5. 构造输出
        let output = json!({
            "question": question,
            "selected": answer.selected_text,
            "selected_index": answer.selected_index,
            "source": answer.source,
            "options": options,
            "recommended": recommended,
        });

        let result = ToolResultInfo::success(
            Some(call.id.clone()),
            Some(ctx.block_id.clone()),
            call.name.clone(),
            call.arguments.clone(),
            output.clone(),
            duration_ms,
        );

        // 6. 发射 end 事件 + 持久化
        ctx.emitter.emit_end(
            event_types::TOOL_CALL,
            &ctx.block_id,
            Some(json!({"result": output, "durationMs": duration_ms})),
            None,
        );

        if let Err(e) = ctx.save_tool_block(&result) {
            log::warn!("[AskUserExecutor] Failed to save tool block: {}", e);
        }

        log::info!(
            "[AskUserExecutor] Completed: selected='{}', source='{}', duration={}ms",
            answer.selected_text,
            answer.source,
            duration_ms
        );

        Ok(result)
    }

    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        // 提问本身就是用户交互，无需额外审批
        ToolSensitivity::Low
    }

    fn name(&self) -> &'static str {
        "AskUserExecutor"
    }
}
