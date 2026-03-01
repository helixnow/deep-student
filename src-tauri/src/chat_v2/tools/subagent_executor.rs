use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use serde_json::{json, Value};
use tauri::Emitter;

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use super::workspace_executor::WORKSPACE_WORKER_READY_EVENT;
use crate::chat_v2::events::event_types;
use crate::chat_v2::repo::ChatV2Repo;
use crate::chat_v2::types::{ChatSession, PersistStatus, ToolCall, ToolResultInfo};
use crate::chat_v2::workspace::{AgentRole, MessageType, SubagentTaskData, WorkspaceCoordinator};

pub const SUBAGENT_TOOL_NAME: &str = "subagent_call";

pub struct SubagentExecutor {
    coordinator: Arc<WorkspaceCoordinator>,
}

impl SubagentExecutor {
    pub fn new(coordinator: Arc<WorkspaceCoordinator>) -> Self {
        Self { coordinator }
    }

    /// 从当前会话的 metadata 中获取子代理嵌套深度。
    /// Fail-closed: 数据库不可用时返回错误，拒绝创建子代理。
    fn get_subagent_depth(&self, ctx: &ExecutionContext) -> Result<u32, String> {
        let chat_v2_db = ctx
            .chat_v2_db
            .as_ref()
            .ok_or("chat_v2_db not available for subagent depth check")?;
        let conn = chat_v2_db
            .get_conn_safe()
            .map_err(|e| format!("DB connection failed during depth check: {}", e))?;
        let session = ChatV2Repo::get_session_with_conn(&conn, &ctx.session_id)
            .map_err(|e| format!("Failed to query session for depth: {}", e))?;
        Ok(session
            .and_then(|s| s.metadata)
            .and_then(|m| m.get("subagent_depth").cloned())
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32)
    }

    /// 子代理递归嵌套的最大深度
    const MAX_SUBAGENT_DEPTH: u32 = 3;

    async fn execute_subagent_call(
        &self,
        args: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        // 🆕 取消检查：在执行前检查是否已取消
        if ctx.is_cancelled() {
            return Err("Subagent call cancelled before start".to_string());
        }

        // 🔒 安全检查：防止子代理无限递归嵌套（fail-closed: DB错误时拒绝）
        let current_depth = self.get_subagent_depth(ctx)?;
        if current_depth >= Self::MAX_SUBAGENT_DEPTH {
            return Err(format!(
                "Maximum subagent nesting depth ({}) exceeded. Current depth: {}. \
                 Recursive subagent creation is not allowed to prevent resource exhaustion.",
                Self::MAX_SUBAGENT_DEPTH,
                current_depth
            ));
        }

        let workspace_id = args
            .get("workspace_id")
            .and_then(|v| v.as_str())
            .ok_or("workspace_id is required")?;
        let skill_id = args
            .get("skill_id")
            .and_then(|v| v.as_str())
            .ok_or("skill_id is required")?;
        let task = args
            .get("task")
            .and_then(|v| v.as_str())
            .ok_or("task is required")?;
        let context = args.get("context").cloned();

        let agent_session_id = format!("subagent_{}_{}", skill_id, ulid::Ulid::new());

        // 🔧 P0-1 修复：在 chat_v2.db 中创建 ChatSession
        // 这样 SubagentContainer 才能通过 chat_v2_load_session 加载子代理的消息
        let chat_v2_db = ctx
            .chat_v2_db
            .as_ref()
            .ok_or("chat_v2_db not available for creating subagent session")?;

        let conn = chat_v2_db
            .get_conn_safe()
            .map_err(|e| format!("Failed to get db connection: {}", e))?;

        // 获取工作区信息用于构建 system_prompt
        let workspace_info = self
            .coordinator
            .get_workspace(workspace_id)?
            .ok_or_else(|| format!("Workspace not found: {}", workspace_id))?;
        let workspace_name = workspace_info
            .name
            .as_deref()
            .unwrap_or(&workspace_id[..8.min(workspace_id.len())]);

        // 构建子代理的 system_prompt
        let system_prompt = format!(
            "你是工作区「{}」中的一个子代理 (Subagent)。\n\
            技能: {}\n\
            工作区 ID: {}\n\n\
            你被分派了一个特定任务，请专注完成该任务。\n\
            完成后请使用 workspace_send 工具发送 result 类型的消息汇报结果。",
            workspace_name, skill_id, workspace_id
        );

        let now = chrono::Utc::now();
        let session = ChatSession {
            id: agent_session_id.clone(),
            mode: "subagent".to_string(),
            title: Some(format!("Subagent: {}", skill_id)),
            description: Some(format!(
                "工作区 {} 的子代理",
                &workspace_id[..8.min(workspace_id.len())]
            )),
            summary_hash: None,
            persist_status: PersistStatus::Active,
            created_at: now,
            updated_at: now,
            metadata: Some(json!({
                "workspace_id": workspace_id,
                "role": "worker",
                "skill_id": skill_id,
                "system_prompt": system_prompt,
                "is_subagent": true,
                "parent_session_id": ctx.session_id,
                "subagent_depth": current_depth + 1,
            })),
            group_id: None,
            tags_hash: None,
            tags: None,
        };

        ChatV2Repo::create_session_with_conn(&conn, &session)
            .map_err(|e| format!("Failed to create subagent session: {}", e))?;

        log::info!(
            "[SubagentExecutor] Created chat_v2 session for subagent: {}",
            agent_session_id
        );

        // 在工作区中注册子代理
        let agent = self.coordinator.register_agent(
            workspace_id,
            &agent_session_id,
            AgentRole::Worker,
            Some(skill_id.to_string()),
            None, // metadata 已存储在 ChatSession.metadata
        )?;

        // 🆕 P1 修复：持久化子代理任务到数据库（支持重启恢复）
        let task_manager = self.coordinator.get_task_manager(workspace_id)?;
        let task_data = SubagentTaskData::new(
            workspace_id.to_string(),
            agent_session_id.clone(),
            Some(skill_id.to_string()),
            Some(task.to_string()),
        );
        if let Err(e) = task_manager.create_task(&task_data) {
            log::warn!(
                "[SubagentExecutor] Failed to persist subagent task: {:?}",
                e
            );
        } else {
            log::info!(
                "[SubagentExecutor] Persisted subagent task: task_id={}, agent={}",
                task_data.id,
                agent_session_id
            );
        }

        // 构建任务内容
        let mut task_content = task.to_string();
        if let Some(ctx_value) = context {
            task_content = format!(
                "{}\n\n[Context]\n{}",
                task,
                serde_json::to_string_pretty(&ctx_value).unwrap_or_default()
            );
        }

        // 发送任务消息
        let message = self.coordinator.send_message(
            workspace_id,
            &ctx.session_id,
            Some(&agent_session_id),
            MessageType::Task,
            task_content,
        )?;

        // 🔧 P0-2 修复：发射 worker_ready 事件触发子代理自动执行
        log::info!(
            "[SubagentExecutor] [WORKER_READY_EMIT] Preparing to emit worker_ready for subagent: {}, skill: {}, workspace: {}",
            agent_session_id, skill_id, workspace_id
        );
        let event_payload = json!({
            "workspace_id": workspace_id,
            "agent_session_id": agent_session_id,
            "skill_id": skill_id,
        });
        if let Err(e) = ctx
            .window
            .emit(WORKSPACE_WORKER_READY_EVENT, &event_payload)
        {
            log::warn!(
                "[SubagentExecutor] [WORKER_READY_EMIT] Failed to emit worker_ready event: {}",
                e
            );
        } else {
            log::info!(
                "[SubagentExecutor] [WORKER_READY_EMIT] Successfully emitted worker_ready event for subagent: {}",
                agent_session_id
            );
        }

        Ok(json!({
            "agent_session_id": agent.session_id,
            "workspace_id": workspace_id,
            "skill_id": skill_id,
            "task_message_id": message.id,
            "status": "auto_starting",
            "message": format!("Subagent with skill '{}' created and auto-starting. It will process the task and send results back.", skill_id)
        }))
    }
}

#[async_trait]
impl ToolExecutor for SubagentExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        let name = strip_tool_namespace(tool_name);
        name == SUBAGENT_TOOL_NAME
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start = Instant::now();

        // 🔧 修复：发射工具调用开始事件，让前端立即显示工具调用 UI
        ctx.emitter.emit_tool_call_start(
            &ctx.message_id,
            &ctx.block_id,
            &call.name,
            call.arguments.clone(),
            Some(&call.id), // 🆕 tool_call_id
            None,           // variant_id: 单变体模式
        );

        let result = self.execute_subagent_call(&call.arguments, ctx).await;
        let duration_ms = start.elapsed().as_millis() as u64;

        match result {
            Ok(output) => {
                // 🔧 修复：发射工具调用结束事件
                ctx.emitter.emit_end(
                    event_types::TOOL_CALL,
                    &ctx.block_id,
                    Some(json!({
                        "result": output,
                        "durationMs": duration_ms,
                    })),
                    None,
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
                    log::warn!("[SubagentExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
            Err(error) => {
                // 🔧 修复：发射工具调用错误事件
                ctx.emitter
                    .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error, None);

                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error,
                    duration_ms,
                );

                // 🆕 SSOT: 后端立即保存工具块（防闪退）
                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[SubagentExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
        }
    }

    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        ToolSensitivity::Medium
    }

    fn name(&self) -> &'static str {
        "SubagentExecutor"
    }
}

pub fn get_subagent_tool_schema() -> Value {
    json!({
        "name": SUBAGENT_TOOL_NAME,
        "description": "Dispatch a task to a specialized subagent. The subagent will process the task asynchronously and send results back through the workspace messaging system.",
        "input_schema": {
            "type": "object",
            "properties": {
                "workspace_id": {
                    "type": "string",
                    "description": "The workspace ID where the subagent will be created"
                },
                "skill_id": {
                    "type": "string",
                    "description": "The skill/capability identifier for the subagent (e.g., 'code_review', 'research', 'translation')"
                },
                "task": {
                    "type": "string",
                    "description": "The task description for the subagent to execute"
                },
                "context": {
                    "description": "Optional context data to pass to the subagent (any JSON value)"
                }
            },
            "required": ["workspace_id", "skill_id", "task"]
        }
    })
}
