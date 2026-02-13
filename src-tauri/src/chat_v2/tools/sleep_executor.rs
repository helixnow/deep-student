//! Coordinator Sleep 工具执行器
//!
//! 实现主代理睡眠/唤醒机制的核心工具。
//! 当 Coordinator 调用此工具时，Pipeline 将挂起等待子代理消息唤醒。

use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use chrono::{Duration, Utc};
use serde_json::{json, Value};

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::chat_v2::workspace::{
    SleepBlockData, SleepManager, WakeCondition, WakeUpPayload, WorkspaceCoordinator,
};

pub const COORDINATOR_SLEEP_TOOL_NAME: &str = "coordinator_sleep";

/// P0-03 安全修复：默认超时时间（30 分钟）
const DEFAULT_TIMEOUT_MS: i64 = 30 * 60 * 1000;
/// P0-03 安全修复：最大超时限制（60 分钟）
const MAX_TIMEOUT_MS: i64 = 60 * 60 * 1000;

pub struct CoordinatorSleepExecutor {
    coordinator: Arc<WorkspaceCoordinator>,
}

impl CoordinatorSleepExecutor {
    pub fn new(coordinator: Arc<WorkspaceCoordinator>) -> Self {
        Self { coordinator }
    }

    /// 解析唤醒条件
    fn parse_wake_condition(condition_str: Option<&str>) -> WakeCondition {
        match condition_str {
            Some("any_message") => WakeCondition::AnyMessage,
            Some("all_completed") => WakeCondition::AllCompleted,
            Some("result_message") | _ => WakeCondition::ResultMessage,
        }
    }

    /// 🔧 P16 辅助函数：追加 block_id 到消息的 block_ids 列表
    ///
    /// 如果消息不存在，创建消息；否则追加 block_id 到现有列表
    fn append_block_id_to_message(
        conn: &rusqlite::Connection,
        session_id: &str,
        message_id: &str,
        block_id: &str,
    ) -> Result<(), String> {
        // 1. 尝试读取现有的 block_ids
        // 🔧 P22 修复：列名是 block_ids_json 不是 block_ids
        let existing_block_ids: Result<Option<String>, _> = conn.query_row(
            "SELECT block_ids_json FROM chat_v2_messages WHERE id = ?1",
            rusqlite::params![message_id],
            |row| row.get(0),
        );

        let now_ms = chrono::Utc::now().timestamp_millis();

        match existing_block_ids {
            Ok(block_ids_json) => {
                // 消息存在，追加 block_id
                let mut block_ids: Vec<String> = block_ids_json
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default();

                // 避免重复添加
                if !block_ids.contains(&block_id.to_string()) {
                    block_ids.push(block_id.to_string());
                }

                let block_ids_json = serde_json::to_string(&block_ids)
                    .map_err(|e| format!("Failed to serialize block_ids: {}", e))?;

                // 🔧 P22 修复：列名是 block_ids_json 不是 block_ids
                conn.execute(
                    "UPDATE chat_v2_messages SET block_ids_json = ?1 WHERE id = ?2",
                    rusqlite::params![block_ids_json, message_id],
                )
                .map_err(|e| format!("Failed to update message block_ids: {}", e))?;
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                // 消息不存在，创建消息
                let block_ids = vec![block_id.to_string()];
                let block_ids_json = serde_json::to_string(&block_ids)
                    .map_err(|e| format!("Failed to serialize block_ids: {}", e))?;

                // 🔧 P22 修复：列名是 block_ids_json 不是 block_ids
                conn.execute(
                    r#"INSERT INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp)
                       VALUES (?1, ?2, 'assistant', ?3, ?4)"#,
                    rusqlite::params![message_id, session_id, block_ids_json, now_ms],
                )
                .map_err(|e| format!("Failed to create message: {}", e))?;

                log::info!(
                    "[CoordinatorSleepExecutor] Created message with sleep block: msg={}, block={}",
                    message_id,
                    block_id
                );
            }
            Err(e) => {
                return Err(format!("Failed to read message: {}", e));
            }
        }

        Ok(())
    }

    /// 执行睡眠
    async fn execute_sleep(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let start = Instant::now();

        // 解析参数
        let workspace_id = args
            .get("workspace_id")
            .and_then(|v| v.as_str())
            .ok_or("workspace_id is required")?;

        // 🔧 P14 修复：如果 awaiting_agents 为空，从 workspace 查询实际的子代理
        let mut awaiting_agents: Vec<String> = args
            .get("awaiting_agents")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();

        // 如果 LLM 没有指定 awaiting_agents，从 workspace 查询所有 worker 代理
        if awaiting_agents.is_empty() {
            if let Ok(agents) = self.coordinator.list_agents(workspace_id) {
                use crate::chat_v2::workspace::AgentRole;
                awaiting_agents = agents
                    .into_iter()
                    .filter(|a| a.role != AgentRole::Coordinator)
                    .map(|a| a.session_id)
                    .collect();
                log::info!(
                    "[CoordinatorSleepExecutor] Auto-populated awaiting_agents from workspace: {:?}",
                    awaiting_agents
                );
            }
        }

        let wake_condition_str = args.get("wake_condition").and_then(|v| v.as_str());
        let wake_condition = Self::parse_wake_condition(wake_condition_str);

        // P0-03 安全修复：添加默认超时和最大超时限制，防止永久阻塞
        let timeout_ms = args
            .get("timeout_ms")
            .and_then(|v| v.as_i64())
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .min(MAX_TIMEOUT_MS);

        // 计算超时时间（现在始终有超时）
        let timeout_at = Some(Utc::now() + Duration::milliseconds(timeout_ms));

        // 生成睡眠 ID
        let sleep_id = format!("sleep_{}", ulid::Ulid::new());

        log::info!(
            "[CoordinatorSleepExecutor] Creating sleep: id={}, workspace={}, awaiting={:?}, condition={:?}",
            sleep_id,
            workspace_id,
            awaiting_agents,
            wake_condition
        );

        // 创建睡眠数据
        let sleep_data = SleepBlockData {
            id: sleep_id.clone(),
            workspace_id: workspace_id.to_string(),
            coordinator_session_id: ctx.session_id.clone(),
            awaiting_agents: awaiting_agents.clone(),
            wake_condition: wake_condition.clone(),
            status: super::super::workspace::sleep_manager::SleepStatus::Sleeping,
            timeout_at,
            created_at: chrono::Utc::now(),
            awakened_at: None,
            awakened_by: None,
            awaken_message: None,
            message_id: Some(ctx.message_id.clone()),
            block_id: Some(ctx.block_id.clone()),
        };

        // 获取 SleepManager 并开始睡眠
        let sleep_manager = self.coordinator.get_sleep_manager(workspace_id)?;

        // ============================================================
        // 🔧 P16 修复：在 sleep 阻塞前手动保存睡眠块
        // 问题：Pipeline 的 save_intermediate_results 在 execute_tool_calls 返回后才调用
        //       但 sleep 会阻塞 execute_tool_calls，导致保存永远不执行
        // 解决：在 sleep 阻塞前，直接保存睡眠块到数据库
        // ============================================================
        if let Some(ref chat_v2_db) = ctx.chat_v2_db {
            use crate::chat_v2::repo::ChatV2Repo;
            use crate::chat_v2::types::{block_status, block_types, MessageBlock};

            let now_ms = chrono::Utc::now().timestamp_millis();
            let sleep_block = MessageBlock {
                id: ctx.block_id.clone(),
                message_id: ctx.message_id.clone(),
                block_type: block_types::SLEEP.to_string(),
                status: block_status::RUNNING.to_string(),
                content: None,
                tool_name: Some(COORDINATOR_SLEEP_TOOL_NAME.to_string()),
                tool_input: Some(args.clone()),
                tool_output: Some(json!({
                    "sleep_id": sleep_id,
                    "workspace_id": workspace_id,
                    "awaiting_agents": awaiting_agents,
                    "status": "sleeping",
                    "created_at": chrono::Utc::now().to_rfc3339(),
                })),
                citations: None,
                error: None,
                started_at: Some(now_ms),
                ended_at: None,
                first_chunk_at: Some(now_ms),
                block_index: 0,
            };

            if let Ok(conn) = chat_v2_db.get_conn_safe() {
                // 1. 保存睡眠块
                if let Err(e) = ChatV2Repo::create_block_with_conn(&conn, &sleep_block) {
                    log::warn!(
                        "[CoordinatorSleepExecutor] Failed to pre-save sleep block: {}",
                        e
                    );
                } else {
                    log::info!(
                        "[CoordinatorSleepExecutor] Pre-saved sleep block before blocking: id={}",
                        ctx.block_id
                    );
                }

                // 2. 更新消息的 block_ids 以包含睡眠块（如果消息不存在则创建）
                // 这是关键：如果不更新，刷新后加载消息时不会包含睡眠块
                if let Err(e) = Self::append_block_id_to_message(
                    &conn,
                    &ctx.session_id,
                    &ctx.message_id,
                    &ctx.block_id,
                ) {
                    log::warn!(
                        "[CoordinatorSleepExecutor] Failed to append block_id to message: {}",
                        e
                    );
                } else {
                    log::info!(
                        "[CoordinatorSleepExecutor] Appended sleep block to message: msg={}, block={}",
                        ctx.message_id,
                        ctx.block_id
                    );
                }
            }
        } else {
            log::warn!("[CoordinatorSleepExecutor] No chat_v2_db available for pre-save");
        }

        log::info!(
            "[CoordinatorSleepExecutor] Starting sleep: id={}, workspace={}, awaiting={:?}",
            sleep_id,
            workspace_id,
            awaiting_agents
        );

        // 🆕 取消支持：使用 tokio::select! 同时监听睡眠和取消信号
        let wake_result = if let Some(cancel_token) = ctx.cancellation_token() {
            tokio::select! {
                result = sleep_manager.sleep(sleep_data) => result,
                _ = cancel_token.cancelled() => {
                    log::info!(
                        "[CoordinatorSleepExecutor] Sleep cancelled: id={}, workspace={}",
                        sleep_id,
                        workspace_id
                    );
                    // 取消睡眠，清理状态
                    let _ = sleep_manager.cancel(&sleep_id);
                    return Err("Coordinator sleep cancelled".to_string());
                }
            }
        } else {
            // 无取消令牌，使用原有逻辑
            sleep_manager.sleep(sleep_data).await
        };

        let duration_ms = start.elapsed().as_millis() as u64;

        match wake_result {
            Ok(payload) => {
                log::info!(
                    "[CoordinatorSleepExecutor] Awakened: sleep={}, by={}, reason={:?}",
                    sleep_id,
                    payload.awakened_by,
                    payload.reason
                );

                Ok(json!({
                    "sleep_id": sleep_id,
                    "workspace_id": workspace_id,
                    "awaiting_agents": awaiting_agents,
                    "status": "awakened",
                    "awakened_by": payload.awakened_by,
                    "awaken_message": payload.message.as_ref().map(|m| &m.content),
                    "reason": format!("{:?}", payload.reason),
                    "message": payload.message.map(|m| json!({
                        "sender": m.sender_session_id,
                        "content": m.content,
                        "type": format!("{:?}", m.message_type)
                    })),
                    "created_at": chrono::Utc::now().to_rfc3339(),
                    "awakened_at": chrono::Utc::now().to_rfc3339(),
                    "duration_ms": duration_ms
                }))
            }
            Err(e) => {
                log::warn!(
                    "[CoordinatorSleepExecutor] Sleep error: sleep={}, error={:?}",
                    sleep_id,
                    e
                );

                Err(format!("Sleep failed: {:?}", e))
            }
        }
    }
}

#[async_trait]
impl ToolExecutor for CoordinatorSleepExecutor {
    fn name(&self) -> &'static str {
        "CoordinatorSleepExecutor"
    }

    fn can_handle(&self, tool_name: &str) -> bool {
        let normalized = tool_name
            .strip_prefix("builtin-")
            .or_else(|| tool_name.strip_prefix("workspace_"))
            .unwrap_or(tool_name);

        normalized == COORDINATOR_SLEEP_TOOL_NAME || normalized == "coordinator_sleep"
    }

    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        // 睡眠工具是低敏感度，不需要用户审批
        ToolSensitivity::Low
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start = Instant::now();

        // 🔧 P19 修复：先填充 awaiting_agents，再发射事件
        // 问题：LLM 可能没有传递 awaiting_agents，导致前端收到空列表
        let workspace_id = call
            .arguments
            .get("workspace_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let mut enriched_args = call.arguments.clone();

        // 如果 LLM 没有指定 awaiting_agents，从 workspace 查询所有 worker 代理
        let awaiting_agents_from_args: Vec<String> = call
            .arguments
            .get("awaiting_agents")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();

        if awaiting_agents_from_args.is_empty() && !workspace_id.is_empty() {
            if let Ok(agents) = self.coordinator.list_agents(workspace_id) {
                use crate::chat_v2::workspace::AgentRole;
                let worker_agents: Vec<String> = agents
                    .into_iter()
                    .filter(|a| a.role != AgentRole::Coordinator)
                    .map(|a| a.session_id)
                    .collect();

                if !worker_agents.is_empty() {
                    enriched_args["awaiting_agents"] = serde_json::json!(worker_agents);
                    log::info!(
                        "[CoordinatorSleepExecutor] Enriched awaiting_agents for event: {:?}",
                        worker_agents
                    );
                }
            }
        }

        // 🔧 P17 修复：发射工具调用开始事件，让前端立即显示睡眠块 UI
        // 🔧 P19 修复：使用填充后的参数，确保前端能获取子代理列表
        ctx.emitter.emit_tool_call_start(
            &ctx.message_id,
            &ctx.block_id,
            &call.name,
            enriched_args, // 使用填充后的参数
            Some(&call.id),
            None,
        );

        let result = self.execute_sleep(&call.arguments, ctx).await;

        let duration_ms = start.elapsed().as_millis() as u64;

        match result {
            Ok(output) => Ok(ToolResultInfo {
                tool_call_id: Some(call.id.clone()),
                block_id: Some(ctx.block_id.clone()),
                tool_name: call.name.clone(),
                input: call.arguments.clone(),
                output,
                success: true,
                error: None,
                duration_ms: Some(duration_ms),
                reasoning_content: None,
            }),
            Err(e) => Ok(ToolResultInfo {
                tool_call_id: Some(call.id.clone()),
                block_id: Some(ctx.block_id.clone()),
                tool_name: call.name.clone(),
                input: call.arguments.clone(),
                output: json!(null),
                success: false,
                error: Some(e),
                duration_ms: Some(duration_ms),
                reasoning_content: None,
            }),
        }
    }
}

/// 获取 coordinator_sleep 工具的 JSON Schema
pub fn get_coordinator_sleep_tool_schema() -> Value {
    json!({
        "name": "builtin-coordinator_sleep",
        "description": "创建子代理后调用此工具进入睡眠状态。睡眠期间 pipeline 挂起，等待子代理发送结果消息后自动唤醒继续执行。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace_id": {
                    "type": "string",
                    "description": "工作区 ID（必需）"
                },
                "awaiting_agents": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "等待的子代理 session_id 列表（可选，不指定则等待所有子代理）"
                },
                "wake_condition": {
                    "type": "string",
                    "enum": ["any_message", "result_message", "all_completed"],
                    "description": "唤醒条件：result_message=收到结果消息（默认），any_message=任意消息，all_completed=全部完成"
                },
                "timeout_ms": {
                    "type": "integer",
                    "description": "超时时间（毫秒），超时后自动唤醒。可选，默认无超时"
                }
            },
            "required": ["workspace_id"]
        }
    })
}
