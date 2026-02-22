use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use serde_json::{json, Value};
use tauri::Emitter;

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use crate::chat_v2::events::event_types;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::chat_v2::workspace::{
    AgentRole, AgentStatus, DocumentType, MessageType, SubagentTaskData, WorkspaceCoordinator,
    WorkspaceDocument,
};

/// Worker 准备执行事件名称
pub const WORKSPACE_WORKER_READY_EVENT: &str = "workspace_worker_ready";

pub const WORKSPACE_NAMESPACE: &str = "workspace";

pub mod tool_names {
    pub const CREATE: &str = "workspace_create";
    pub const CREATE_AGENT: &str = "workspace_create_agent";
    pub const SEND: &str = "workspace_send";
    pub const QUERY: &str = "workspace_query";
    pub const SET_CONTEXT: &str = "workspace_set_context";
    pub const GET_CONTEXT: &str = "workspace_get_context";
    pub const UPDATE_DOCUMENT: &str = "workspace_update_document";
    pub const READ_DOCUMENT: &str = "workspace_read_document";
}

pub struct WorkspaceToolExecutor {
    coordinator: Arc<WorkspaceCoordinator>,
}

impl WorkspaceToolExecutor {
    pub fn new(coordinator: Arc<WorkspaceCoordinator>) -> Self {
        Self { coordinator }
    }

    /// 从工具名称中去除前缀
    ///
    /// 支持的前缀：workspace_, builtin-, mcp_
    fn strip_namespace(tool_name: &str) -> &str {
        // workspace_ 前缀是 workspace_executor 特有的，先尝试剥离
        tool_name
            .strip_prefix(&format!("{}_", WORKSPACE_NAMESPACE))
            .unwrap_or_else(|| super::strip_tool_namespace(tool_name))
    }

    async fn execute_create(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let name = args.get("name").and_then(|v| v.as_str()).map(String::from);
        let workspace = self
            .coordinator
            .create_workspace(&ctx.session_id, name.clone())?;

        let coordinator_agent = self.coordinator.register_agent(
            &workspace.id,
            &ctx.session_id,
            AgentRole::Coordinator,
            None,
            None, // metadata
        )?;

        // 🔧 P36 修复：返回完整的快照数据，支持刷新后恢复
        // 前端 workspaceStatus.tsx 需要 snapshotAgents, snapshotName, snapshotCreatedAt
        let snapshot_agents = vec![json!({
            "session_id": coordinator_agent.session_id,
            "role": "coordinator",
            "status": "idle",
            "skill_id": Value::Null,
        })];

        Ok(json!({
            "workspace_id": workspace.id,
            "status": "created",
            "message": "Workspace created successfully. You are registered as the coordinator.",
            // 🆕 快照数据（刷新后可恢复）
            "snapshotAgents": snapshot_agents,
            "snapshotName": name.unwrap_or_else(|| workspace.id[..8.min(workspace.id.len())].to_string()),
            "snapshotCreatedAt": chrono::Utc::now().to_rfc3339(),
        }))
    }

    async fn execute_create_agent(
        &self,
        args: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let workspace_id = args
            .get("workspace_id")
            .and_then(|v| v.as_str())
            .ok_or("workspace_id is required")?;
        let skill_id = args
            .get("skill_id")
            .and_then(|v| v.as_str())
            .map(String::from);
        let role_str = args
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("worker");
        let initial_task = args
            .get("initial_task")
            .and_then(|v| v.as_str())
            .map(String::from);
        let role = match role_str {
            "coordinator" => AgentRole::Coordinator,
            _ => AgentRole::Worker,
        };

        // 🔧 P18: 提前判断是否为 Worker（用于 system_prompt 生成）
        let is_worker = matches!(role, AgentRole::Worker);

        // 生成新的 Agent 会话 ID
        let agent_session_id = format!(
            "agent_{}_{}",
            skill_id.as_deref().unwrap_or("worker"),
            ulid::Ulid::new()
        );

        // 1. 在 chat_v2.db 中创建实际的 ChatSession
        let chat_v2_db = ctx
            .chat_v2_db
            .as_ref()
            .ok_or("chat_v2_db not available for creating agent session")?;

        let conn = chat_v2_db
            .get_conn_safe()
            .map_err(|e| format!("Failed to get db connection: {}", e))?;

        // 构建 Agent 的初始 System Prompt
        let workspace_info = self
            .coordinator
            .get_workspace(workspace_id)?
            .ok_or_else(|| format!("Workspace not found: {}", workspace_id))?;

        let workspace_name = workspace_info
            .name
            .as_deref()
            .unwrap_or(&workspace_id[..8.min(workspace_id.len())]);

        // 🔧 P18 修复：使用详细的子代理 Worker 系统提示词
        // 关键：必须明确告诉子代理如何使用 workspace_send 工具返回结果
        let skill_name = skill_id.as_deref().unwrap_or("通用");
        let system_prompt = if is_worker {
            // Worker 子代理使用详细的执行协议
            format!(
                r#"# 子代理执行协议

你是工作区「{}」中的 **Worker 子代理**。

## 基本信息
- 工作区 ID: {}
- 技能: {}

## 核心职责

1. **专注执行任务**：认真完成主代理分配给你的任务
2. **汇报结果**：任务完成后，**必须**调用工具通知主代理

## 任务完成流程（必须遵循！）

### 步骤 1：执行任务
使用你的能力完成任务。

### 步骤 2：返回结果（必须执行！）
任务完成后，你**必须**调用 `builtin-workspace_send` 工具将结果发送给主代理：

```json
{{
  "workspace_id": "{}",
  "content": "<你的完整任务结果>",
  "message_type": "result"
}}
```

**重要警告**：
- `message_type` 必须设置为 `"result"`，这样主代理才会被唤醒
- 如果不调用此工具，主代理将无法收到你的结果，会一直等待！
- 这是强制要求，不是可选步骤

## 工具使用

你可以使用以下工具：
- `builtin-workspace_send`: 发送消息给主代理（必须用于返回结果）
- `builtin-workspace_query`: 查询工作区信息"#,
                workspace_name, workspace_id, skill_name, workspace_id
            )
        } else {
            // Coordinator 使用简单提示
            format!(
                "你是工作区「{}」中的协调者 (Coordinator)。\n\
                工作区 ID: {}\n\n\
                你可以使用 workspace_send 工具向工作区发送消息，\
                也可以使用 workspace_query 查询工作区状态。",
                workspace_name, workspace_id
            )
        };

        // 推荐模型：由前端在调用 runAgent 时通过 model_id 参数传递
        let recommended_models: Vec<String> = vec![];

        // 创建会话记录
        use crate::chat_v2::repo::ChatV2Repo;
        use crate::chat_v2::types::{ChatSession, PersistStatus};

        let now = chrono::Utc::now();
        let session = ChatSession {
            id: agent_session_id.clone(),
            mode: "agent".to_string(),
            title: Some(format!(
                "Agent: {}",
                skill_id.as_deref().unwrap_or("Worker")
            )),
            description: Some(format!(
                "工作区 {} 的 Agent",
                &workspace_id[..8.min(workspace_id.len())]
            )),
            summary_hash: None,
            persist_status: PersistStatus::Active,
            created_at: now,
            updated_at: now,
            metadata: Some(json!({
                "workspace_id": workspace_id,
                "role": role_str,
                "skill_id": skill_id,
                "system_prompt": system_prompt,
                "recommended_models": recommended_models,
            })),
            group_id: None,
        };

        ChatV2Repo::create_session_with_conn(&conn, &session)
            .map_err(|e| format!("Failed to create agent session: {}", e))?;

        // 2. 在工作区中注册 Agent 元数据
        // 注意：MCP 工具调用时 system_prompt 已存储在 session metadata 中
        let agent = self.coordinator.register_agent(
            workspace_id,
            &agent_session_id,
            role,
            skill_id.clone(),
            None, // metadata - 已存储在 ChatSession.metadata
        )?;

        // 4. 如果有初始任务，发送任务消息并自动启动 Worker
        let has_initial_task = initial_task.is_some();
        if let Some(ref task) = initial_task {
            self.coordinator.send_message(
                workspace_id,
                &ctx.session_id,         // 发送者是创建者
                Some(&agent_session_id), // 目标是新 Agent
                MessageType::Task,
                task.clone(),
            )?;

            // 🆕 P1 修复：持久化 Worker 任务到数据库（支持重启恢复）
            if is_worker {
                if let Ok(task_manager) = self.coordinator.get_task_manager(workspace_id) {
                    let task_data = SubagentTaskData::new(
                        workspace_id.to_string(),
                        agent_session_id.clone(),
                        skill_id.clone(),
                        Some(task.clone()),
                    );
                    if let Err(e) = task_manager.create_task(&task_data) {
                        log::warn!("[WorkspaceExecutor] Failed to persist worker task: {:?}", e);
                    } else {
                        log::info!(
                            "[WorkspaceExecutor] Persisted worker task: task_id={}, agent={}",
                            task_data.id,
                            agent_session_id
                        );
                    }
                }
            }
        }

        // 5. 如果是 Worker 且有初始任务，发射事件通知自动启动
        if is_worker && has_initial_task {
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
                    "[WorkspaceExecutor] Failed to emit worker_ready event: {}",
                    e
                );
            } else {
                log::info!(
                    "[WorkspaceExecutor] Emitted worker_ready event for agent: {}",
                    agent_session_id
                );
            }
        }

        // 🔧 P36 修复：返回完整的快照数据，支持刷新后恢复
        // 获取当前工作区的所有代理作为快照
        let snapshot_agents: Vec<Value> = self
            .coordinator
            .list_agents(workspace_id)
            .map(|agents| {
                agents
                    .iter()
                    .map(|a| {
                        json!({
                            "session_id": a.session_id,
                            "role": match a.role {
                                AgentRole::Coordinator => "coordinator",
                                AgentRole::Worker => "worker",
                            },
                            "status": match a.status {
                                AgentStatus::Idle => "idle",
                                AgentStatus::Running => "running",
                                AgentStatus::Completed => "completed",
                                AgentStatus::Failed => "failed",
                            },
                            "skill_id": a.skill_id,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(json!({
            "agent_session_id": agent.session_id,
            "workspace_id": agent.workspace_id,
            "role": role_str,
            "skill_id": skill_id,
            "status": if is_worker && has_initial_task { "auto_starting" } else { "created" },
            "auto_run": is_worker && has_initial_task,
            "message": if is_worker && has_initial_task {
                format!("Worker agent created and auto-starting. Session ID: {}", agent_session_id)
            } else {
                format!("Agent session created with system prompt configured. Session ID: {}", agent_session_id)
            },
            // 🆕 快照数据（刷新后可恢复）
            "snapshotAgents": snapshot_agents,
            "snapshotCreatedAt": chrono::Utc::now().to_rfc3339(),
        }))
    }

    async fn execute_send(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let workspace_id = args
            .get("workspace_id")
            .and_then(|v| v.as_str())
            .ok_or("workspace_id is required")?;
        let content = args
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or("content is required")?;
        let target_id = args.get("target_session_id").and_then(|v| v.as_str());
        let msg_type_str = args
            .get("message_type")
            .and_then(|v| v.as_str())
            .unwrap_or("task");
        let message_type = match msg_type_str {
            "progress" => MessageType::Progress,
            "result" => MessageType::Result,
            "query" => MessageType::Query,
            "correction" => MessageType::Correction,
            "broadcast" => MessageType::Broadcast,
            _ => MessageType::Task,
        };
        if target_id.is_some() && matches!(message_type, MessageType::Broadcast) {
            return Err("Broadcast message must not specify target_session_id".to_string());
        }

        let message = self.coordinator.send_message(
            workspace_id,
            &ctx.session_id,
            target_id,
            message_type,
            content.to_string(),
        )?;

        Ok(json!({
            "message_id": message.id,
            "status": "sent",
            "is_broadcast": message.is_broadcast()
        }))
    }

    async fn execute_query(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let workspace_id = args
            .get("workspace_id")
            .and_then(|v| v.as_str())
            .ok_or("workspace_id is required")?;
        self.coordinator
            .ensure_member_or_creator(workspace_id, &ctx.session_id)?;
        let query_type = args
            .get("query_type")
            .and_then(|v| v.as_str())
            .unwrap_or("agents");
        let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(50) as usize;

        let serialize_agents = || -> Result<Value, String> {
            let agents = self.coordinator.list_agents(workspace_id)?;
            Ok(json!({
                "agents": agents.iter().map(|a| json!({
                    "session_id": a.session_id,
                    "role": serde_json::to_string(&a.role).unwrap_or_default().trim_matches('"'),
                    "status": serde_json::to_string(&a.status).unwrap_or_default().trim_matches('"'),
                    "skill_id": a.skill_id
                })).collect::<Vec<_>>()
            }))
        };

        let serialize_messages = || -> Result<Value, String> {
            let messages = self.coordinator.list_messages(workspace_id, limit)?;
            Ok(json!({
                "messages": messages.iter().map(|m| json!({
                    "id": m.id,
                    "sender": m.sender_session_id,
                    "target": m.target_session_id,
                    "type": serde_json::to_string(&m.message_type).unwrap_or_default().trim_matches('"'),
                    "content": m.content,
                    "created_at": m.created_at.to_rfc3339()
                })).collect::<Vec<_>>()
            }))
        };

        let serialize_documents = || -> Result<Value, String> {
            let docs = self.coordinator.list_documents(workspace_id)?;
            Ok(json!({
                "documents": docs.iter().map(|d| json!({
                    "id": d.id,
                    "title": d.title,
                    "type": serde_json::to_string(&d.doc_type).unwrap_or_default().trim_matches('"'),
                    "version": d.version
                })).collect::<Vec<_>>()
            }))
        };

        let serialize_context = || -> Result<Value, String> {
            let contexts = self.coordinator.list_context(workspace_id)?;
            Ok(json!({
                "context": contexts.iter().map(|c| json!({
                    "key": c.key,
                    "value": c.value,
                    "updated_by": c.updated_by,
                    "updated_at": c.updated_at.to_rfc3339()
                })).collect::<Vec<_>>()
            }))
        };

        match query_type {
            "agents" => serialize_agents(),
            "messages" => serialize_messages(),
            "documents" => serialize_documents(),
            "context" => serialize_context(),
            "all" => {
                let mut merged = serde_json::Map::new();
                for section in [
                    serialize_agents()?,
                    serialize_messages()?,
                    serialize_documents()?,
                    serialize_context()?,
                ] {
                    if let Value::Object(obj) = section {
                        merged.extend(obj);
                    }
                }
                Ok(Value::Object(merged))
            }
            _ => Err(format!("Unknown query_type: {}", query_type)),
        }
    }

    async fn execute_set_context(
        &self,
        args: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let workspace_id = args
            .get("workspace_id")
            .and_then(|v| v.as_str())
            .ok_or("workspace_id is required")?;
        let key = args
            .get("key")
            .and_then(|v| v.as_str())
            .ok_or("key is required")?;
        let value = args.get("value").cloned().unwrap_or(Value::Null);

        self.coordinator
            .set_context(workspace_id, key, value.clone(), &ctx.session_id)?;

        Ok(json!({
            "key": key,
            "status": "set"
        }))
    }

    async fn execute_get_context(
        &self,
        args: &Value,
        _ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let workspace_id = args
            .get("workspace_id")
            .and_then(|v| v.as_str())
            .ok_or("workspace_id is required")?;
        let key = args
            .get("key")
            .and_then(|v| v.as_str())
            .ok_or("key is required")?;

        match self.coordinator.get_context(workspace_id, key)? {
            Some(ctx) => Ok(json!({
                "key": ctx.key,
                "value": ctx.value,
                "updated_by": ctx.updated_by,
                "updated_at": ctx.updated_at.to_rfc3339()
            })),
            None => Ok(json!({
                "key": key,
                "value": null,
                "found": false
            })),
        }
    }

    async fn execute_update_document(
        &self,
        args: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let workspace_id = args
            .get("workspace_id")
            .and_then(|v| v.as_str())
            .ok_or("workspace_id is required")?;
        let title = args
            .get("title")
            .and_then(|v| v.as_str())
            .ok_or("title is required")?;
        let content = args
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or("content is required")?;
        let doc_type_str = args
            .get("doc_type")
            .and_then(|v| v.as_str())
            .unwrap_or("notes");
        let doc_type = match doc_type_str {
            "plan" => DocumentType::Plan,
            "research" => DocumentType::Research,
            "artifact" => DocumentType::Artifact,
            _ => DocumentType::Notes,
        };

        let doc = WorkspaceDocument::new(
            workspace_id.to_string(),
            doc_type,
            title.to_string(),
            content.to_string(),
            ctx.session_id.clone(),
        );

        self.coordinator.save_document(workspace_id, &doc)?;

        Ok(json!({
            "document_id": doc.id,
            "title": doc.title,
            "status": "saved"
        }))
    }

    async fn execute_read_document(
        &self,
        args: &Value,
        _ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let workspace_id = args
            .get("workspace_id")
            .and_then(|v| v.as_str())
            .ok_or("workspace_id is required")?;
        let doc_id = args
            .get("document_id")
            .and_then(|v| v.as_str())
            .ok_or("document_id is required")?;

        match self.coordinator.get_document(workspace_id, doc_id)? {
            Some(doc) => Ok(json!({
                "id": doc.id,
                "title": doc.title,
                "content": doc.content,
                "type": serde_json::to_string(&doc.doc_type).unwrap_or_default().trim_matches('"'),
                "version": doc.version,
                "updated_by": doc.updated_by,
                "updated_at": doc.updated_at.to_rfc3339()
            })),
            None => Ok(json!({
                "document_id": doc_id,
                "found": false
            })),
        }
    }
}

#[async_trait]
impl ToolExecutor for WorkspaceToolExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        let name = Self::strip_namespace(tool_name);
        matches!(
            name,
            tool_names::CREATE
                | tool_names::CREATE_AGENT
                | tool_names::SEND
                | tool_names::QUERY
                | tool_names::SET_CONTEXT
                | tool_names::GET_CONTEXT
                | tool_names::UPDATE_DOCUMENT
                | tool_names::READ_DOCUMENT
        )
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start = Instant::now();
        let tool_name = Self::strip_namespace(&call.name);

        // 🔧 修复：发射工具调用开始事件，让前端立即显示工具调用 UI
        ctx.emitter.emit_tool_call_start(
            &ctx.message_id,
            &ctx.block_id,
            &call.name,
            call.arguments.clone(),
            Some(&call.id), // 🆕 tool_call_id
            None,           // variant_id: 单变体模式
        );

        let result = match tool_name {
            tool_names::CREATE => self.execute_create(&call.arguments, ctx).await,
            tool_names::CREATE_AGENT => self.execute_create_agent(&call.arguments, ctx).await,
            tool_names::SEND => self.execute_send(&call.arguments, ctx).await,
            tool_names::QUERY => self.execute_query(&call.arguments, ctx).await,
            tool_names::SET_CONTEXT => self.execute_set_context(&call.arguments, ctx).await,
            tool_names::GET_CONTEXT => self.execute_get_context(&call.arguments, ctx).await,
            tool_names::UPDATE_DOCUMENT => self.execute_update_document(&call.arguments, ctx).await,
            tool_names::READ_DOCUMENT => self.execute_read_document(&call.arguments, ctx).await,
            _ => Err(format!("Unknown workspace tool: {}", tool_name)),
        };

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
                    log::warn!("[WorkspaceToolExecutor] Failed to save tool block: {}", e);
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
                    log::warn!("[WorkspaceToolExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
        }
    }

    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        // 工作区工具都是低风险操作，无需用户审批
        ToolSensitivity::Low
    }

    fn name(&self) -> &'static str {
        "WorkspaceToolExecutor"
    }
}

pub fn get_workspace_tool_schemas() -> Vec<Value> {
    vec![
        json!({
            "name": tool_names::CREATE,
            "description": "Create a new workspace for multi-agent collaboration",
            "input_schema": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Optional name for the workspace"
                    }
                }
            }
        }),
        json!({
            "name": tool_names::CREATE_AGENT,
            "description": "Register a new agent in the workspace",
            "input_schema": {
                "type": "object",
                "properties": {
                    "workspace_id": {
                        "type": "string",
                        "description": "The workspace ID"
                    },
                    "agent_session_id": {
                        "type": "string",
                        "description": "The session ID for the new agent"
                    },
                    "role": {
                        "type": "string",
                        "enum": ["coordinator", "worker"],
                        "description": "Agent role (default: worker)"
                    },
                    "skill_id": {
                        "type": "string",
                        "description": "Optional skill ID for the agent"
                    }
                },
                "required": ["workspace_id", "agent_session_id"]
            }
        }),
        json!({
            "name": tool_names::SEND,
            "description": "Send a message to agents in the workspace",
            "input_schema": {
                "type": "object",
                "properties": {
                    "workspace_id": {
                        "type": "string",
                        "description": "The workspace ID"
                    },
                    "content": {
                        "type": "string",
                        "description": "Message content"
                    },
                    "target_session_id": {
                        "type": "string",
                        "description": "Target agent session ID (omit for broadcast)"
                    },
                    "message_type": {
                        "type": "string",
                        "enum": ["task", "progress", "result", "query", "correction", "broadcast"],
                        "description": "Message type (default: task)"
                    }
                },
                "required": ["workspace_id", "content"]
            }
        }),
        json!({
            "name": tool_names::QUERY,
            "description": "Query workspace information",
            "input_schema": {
                "type": "object",
                "properties": {
                    "workspace_id": {
                        "type": "string",
                        "description": "The workspace ID"
                    },
                    "query_type": {
                        "type": "string",
                        "enum": ["agents", "messages", "documents", "context", "all"],
                        "description": "Type of query (default: agents)"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of results (default: 50)"
                    }
                },
                "required": ["workspace_id"]
            }
        }),
        json!({
            "name": tool_names::SET_CONTEXT,
            "description": "Set a shared context value in the workspace",
            "input_schema": {
                "type": "object",
                "properties": {
                    "workspace_id": {
                        "type": "string",
                        "description": "The workspace ID"
                    },
                    "key": {
                        "type": "string",
                        "description": "Context key"
                    },
                    "value": {
                        "description": "Context value (any JSON value)"
                    }
                },
                "required": ["workspace_id", "key", "value"]
            }
        }),
        json!({
            "name": tool_names::GET_CONTEXT,
            "description": "Get a shared context value from the workspace",
            "input_schema": {
                "type": "object",
                "properties": {
                    "workspace_id": {
                        "type": "string",
                        "description": "The workspace ID"
                    },
                    "key": {
                        "type": "string",
                        "description": "Context key"
                    }
                },
                "required": ["workspace_id", "key"]
            }
        }),
        json!({
            "name": tool_names::UPDATE_DOCUMENT,
            "description": "Create or update a document in the workspace",
            "input_schema": {
                "type": "object",
                "properties": {
                    "workspace_id": {
                        "type": "string",
                        "description": "The workspace ID"
                    },
                    "title": {
                        "type": "string",
                        "description": "Document title"
                    },
                    "content": {
                        "type": "string",
                        "description": "Document content"
                    },
                    "doc_type": {
                        "type": "string",
                        "enum": ["plan", "research", "artifact", "notes"],
                        "description": "Document type (default: notes)"
                    }
                },
                "required": ["workspace_id", "title", "content"]
            }
        }),
        json!({
            "name": tool_names::READ_DOCUMENT,
            "description": "Read a document from the workspace",
            "input_schema": {
                "type": "object",
                "properties": {
                    "workspace_id": {
                        "type": "string",
                        "description": "The workspace ID"
                    },
                    "document_id": {
                        "type": "string",
                        "description": "Document ID"
                    }
                },
                "required": ["workspace_id", "document_id"]
            }
        }),
    ]
}
