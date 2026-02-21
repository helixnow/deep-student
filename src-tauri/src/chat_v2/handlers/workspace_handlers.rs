//! 工作区 Tauri 命令处理器
//!
//! 提供工作区相关的前端 API

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{State, Window};

use crate::chat_v2::database::ChatV2Database;
use crate::chat_v2::pipeline::ChatV2Pipeline;
use crate::chat_v2::state::{ChatV2State, StreamGuard};
use crate::chat_v2::types::{
    ChatMessage, SendMessageRequest as ChatSendMessageRequest, SendOptions,
};
use crate::chat_v2::workspace::{
    AgentRole, AgentStatus, MessageType, SubagentTaskStatus, WorkspaceCoordinator,
    MAX_AGENT_RETRY_ATTEMPTS,
};

// ============================================================
// 请求/响应类型
// ============================================================

#[derive(Debug, Deserialize)]
pub struct CreateWorkspaceRequest {
    pub name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CreateWorkspaceResponse {
    pub workspace_id: String,
    pub name: Option<String>,
    pub status: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateAgentRequest {
    pub workspace_id: String,
    /// 创建者会话 ID（用于权限校验）
    pub requester_session_id: String,
    pub skill_id: Option<String>,
    pub role: Option<String>,
    pub initial_task: Option<String>,
    /// 技能的系统提示词（由前端 skills 系统提供）
    pub system_prompt: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CreateAgentResponse {
    pub agent_session_id: String,
    pub workspace_id: String,
    pub role: String,
    pub skill_id: Option<String>,
    /// 🔧 2026-01-20: 添加 status 字段，前端需要用于显示状态
    pub status: String,
}

#[derive(Debug, Deserialize)]
pub struct WorkspaceSendMessageRequest {
    pub workspace_id: String,
    pub content: String,
    pub target_session_id: Option<String>,
    pub message_type: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SendMessageResponse {
    pub message_id: String,
    pub is_broadcast: bool,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceInfo {
    pub id: String,
    pub name: Option<String>,
    pub status: String,
    pub creator_session_id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
pub struct AgentInfo {
    pub session_id: String,
    pub role: String,
    pub status: String,
    pub skill_id: Option<String>,
    pub joined_at: String,
    pub last_active_at: String,
}

#[derive(Debug, Serialize)]
pub struct MessageInfo {
    pub id: String,
    pub sender_session_id: String,
    pub target_session_id: Option<String>,
    pub message_type: String,
    pub content: String,
    pub status: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct RunAgentRequest {
    pub workspace_id: String,
    pub agent_session_id: String,
    /// 请求者会话 ID（用于权限校验）
    pub requester_session_id: String,
    /// 🆕 P38: 系统提醒消息，用于子代理没发消息时的重试提醒
    pub reminder: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RunAgentResponse {
    pub agent_session_id: String,
    pub message_id: String,
    pub status: String,
}

#[derive(Debug, Serialize)]
pub struct DocumentInfo {
    pub id: String,
    pub doc_type: String,
    pub title: String,
    pub version: i32,
    pub updated_by: String,
    pub updated_at: String,
}

// ============================================================
// Tauri 命令
// ============================================================

/// 创建工作区
#[tauri::command]
pub async fn workspace_create(
    coordinator: State<'_, Arc<WorkspaceCoordinator>>,
    session_id: String,
    request: CreateWorkspaceRequest,
) -> Result<CreateWorkspaceResponse, String> {
    let workspace = coordinator.create_workspace(&session_id, request.name)?;

    Ok(CreateWorkspaceResponse {
        workspace_id: workspace.id,
        name: workspace.name,
        status: format!("{:?}", workspace.status).to_lowercase(),
    })
}

/// 获取工作区信息
#[tauri::command]
pub async fn workspace_get(
    coordinator: State<'_, Arc<WorkspaceCoordinator>>,
    session_id: String,
    workspace_id: String,
) -> Result<Option<WorkspaceInfo>, String> {
    coordinator.ensure_member_or_creator(&workspace_id, &session_id)?;
    let workspace = coordinator.get_workspace(&workspace_id)?;

    Ok(workspace.map(|w| WorkspaceInfo {
        id: w.id,
        name: w.name,
        status: format!("{:?}", w.status).to_lowercase(),
        creator_session_id: w.creator_session_id,
        created_at: w.created_at.to_rfc3339(),
        updated_at: w.updated_at.to_rfc3339(),
    }))
}

/// 关闭工作区
#[tauri::command]
pub async fn workspace_close(
    coordinator: State<'_, Arc<WorkspaceCoordinator>>,
    session_id: String,
    workspace_id: String,
) -> Result<(), String> {
    coordinator.ensure_member_or_creator(&workspace_id, &session_id)?;
    coordinator.close_workspace(&workspace_id)
}

/// 删除工作区
#[tauri::command]
pub async fn workspace_delete(
    coordinator: State<'_, Arc<WorkspaceCoordinator>>,
    session_id: String,
    workspace_id: String,
) -> Result<(), String> {
    coordinator.ensure_member_or_creator(&workspace_id, &session_id)?;
    coordinator.delete_workspace(&workspace_id)
}

/// 创建 Agent
#[tauri::command]
pub async fn workspace_create_agent(
    coordinator: State<'_, Arc<WorkspaceCoordinator>>,
    db: State<'_, Arc<ChatV2Database>>,
    request: CreateAgentRequest,
) -> Result<CreateAgentResponse, String> {
    coordinator.ensure_member_or_creator(&request.workspace_id, &request.requester_session_id)?;
    let role = match request.role.as_deref() {
        Some("coordinator") => AgentRole::Coordinator,
        _ => AgentRole::Worker,
    };
    let role_str = match &role {
        AgentRole::Coordinator => "coordinator",
        AgentRole::Worker => "worker",
    };

    // 生成 Agent 会话 ID
    let agent_session_id = format!(
        "agent_{}_{}",
        request.skill_id.as_deref().unwrap_or("worker"),
        ulid::Ulid::new()
    );

    // 🔧 P0-2 修复：创建 ChatSession 记录，存储 system_prompt
    // 这样 workspace_run_agent 才能正确获取到技能的系统提示词
    let conn = db
        .get_conn_safe()
        .map_err(|e| format!("Failed to get db connection: {}", e))?;

    use crate::chat_v2::repo::ChatV2Repo;
    use crate::chat_v2::types::{ChatSession, PersistStatus};

    let now = chrono::Utc::now();
    let session = ChatSession {
        id: agent_session_id.clone(),
        mode: "agent".to_string(),
        title: Some(format!(
            "Agent: {}",
            request.skill_id.as_deref().unwrap_or("Worker")
        )),
        description: Some(format!(
            "工作区 {} 的 Agent",
            &request.workspace_id[..8.min(request.workspace_id.len())]
        )),
        summary_hash: None,
        persist_status: PersistStatus::Active,
        created_at: now,
        updated_at: now,
        metadata: Some(serde_json::json!({
            "workspace_id": request.workspace_id,
            "role": role_str,
            "skill_id": request.skill_id,
            "system_prompt": request.system_prompt,
            "recommended_models": Vec::<String>::new(),
        })),
        group_id: None,
    };

    ChatV2Repo::create_session_with_conn(&conn, &session)
        .map_err(|e| format!("Failed to create agent session: {}", e))?;

    // 在工作区中注册 Agent 元数据
    let agent = coordinator.register_agent(
        &request.workspace_id,
        &agent_session_id,
        role.clone(),
        request.skill_id.clone(),
        None, // metadata 已存储在 ChatSession 中
    )?;

    // 如果有初始任务，发送任务消息
    if let Some(task) = &request.initial_task {
        coordinator.send_message(
            &request.workspace_id,
            &agent_session_id,
            None,
            MessageType::Task,
            task.clone(),
        )?;
    }

    Ok(CreateAgentResponse {
        agent_session_id: agent.session_id,
        workspace_id: agent.workspace_id,
        role: format!("{:?}", role).to_lowercase(),
        skill_id: request.skill_id,
        status: format!("{:?}", agent.status).to_lowercase(),
    })
}

/// 列出工作区中的 Agent
#[tauri::command]
pub async fn workspace_list_agents(
    coordinator: State<'_, Arc<WorkspaceCoordinator>>,
    session_id: String,
    workspace_id: String,
) -> Result<Vec<AgentInfo>, String> {
    coordinator.ensure_member_or_creator(&workspace_id, &session_id)?;
    let agents = coordinator.list_agents(&workspace_id)?;

    Ok(agents
        .into_iter()
        .map(|a| AgentInfo {
            session_id: a.session_id,
            role: format!("{:?}", a.role).to_lowercase(),
            status: format!("{:?}", a.status).to_lowercase(),
            skill_id: a.skill_id,
            joined_at: a.joined_at.to_rfc3339(),
            last_active_at: a.last_active_at.to_rfc3339(),
        })
        .collect())
}

/// 发送消息到工作区
#[tauri::command]
pub async fn workspace_send_message(
    coordinator: State<'_, Arc<WorkspaceCoordinator>>,
    session_id: String,
    request: WorkspaceSendMessageRequest,
) -> Result<SendMessageResponse, String> {
    let message_type = match request.message_type.as_deref() {
        Some("progress") => MessageType::Progress,
        Some("result") => MessageType::Result,
        Some("query") => MessageType::Query,
        Some("correction") => MessageType::Correction,
        Some("broadcast") => MessageType::Broadcast,
        _ => MessageType::Task,
    };
    if request.target_session_id.is_some() && matches!(message_type, MessageType::Broadcast) {
        return Err("Broadcast message must not specify target_session_id".to_string());
    }

    let message = coordinator.send_message(
        &request.workspace_id,
        &session_id,
        request.target_session_id.as_deref(),
        message_type,
        request.content,
    )?;

    Ok(SendMessageResponse {
        message_id: message.id,
        is_broadcast: request.target_session_id.is_none(),
    })
}

/// 列出工作区消息
#[tauri::command]
pub async fn workspace_list_messages(
    coordinator: State<'_, Arc<WorkspaceCoordinator>>,
    session_id: String,
    workspace_id: String,
    limit: Option<usize>,
) -> Result<Vec<MessageInfo>, String> {
    coordinator.ensure_member_or_creator(&workspace_id, &session_id)?;
    let messages = coordinator.list_messages(&workspace_id, limit.unwrap_or(50))?;

    Ok(messages
        .into_iter()
        .map(|m| MessageInfo {
            id: m.id,
            sender_session_id: m.sender_session_id,
            target_session_id: m.target_session_id,
            message_type: format!("{:?}", m.message_type).to_lowercase(),
            content: m.content,
            status: format!("{:?}", m.status).to_lowercase(),
            created_at: m.created_at.to_rfc3339(),
        })
        .collect())
}

/// 设置工作区上下文
#[tauri::command]
pub async fn workspace_set_context(
    coordinator: State<'_, Arc<WorkspaceCoordinator>>,
    session_id: String,
    workspace_id: String,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    coordinator.set_context(&workspace_id, &key, value, &session_id)
}

/// 获取工作区上下文
#[tauri::command]
pub async fn workspace_get_context(
    coordinator: State<'_, Arc<WorkspaceCoordinator>>,
    session_id: String,
    workspace_id: String,
    key: String,
) -> Result<Option<serde_json::Value>, String> {
    coordinator.ensure_member_or_creator(&workspace_id, &session_id)?;
    let ctx = coordinator.get_context(&workspace_id, &key)?;
    Ok(ctx.map(|c| c.value))
}

/// 列出工作区文档
#[tauri::command]
pub async fn workspace_list_documents(
    coordinator: State<'_, Arc<WorkspaceCoordinator>>,
    session_id: String,
    workspace_id: String,
) -> Result<Vec<DocumentInfo>, String> {
    coordinator.ensure_member_or_creator(&workspace_id, &session_id)?;
    let documents = coordinator.list_documents(&workspace_id)?;

    Ok(documents
        .into_iter()
        .map(|d| DocumentInfo {
            id: d.id,
            doc_type: format!("{:?}", d.doc_type).to_lowercase(),
            title: d.title,
            version: d.version,
            updated_by: d.updated_by,
            updated_at: d.updated_at.to_rfc3339(),
        })
        .collect())
}

/// 获取工作区文档内容
#[tauri::command]
pub async fn workspace_get_document(
    coordinator: State<'_, Arc<WorkspaceCoordinator>>,
    session_id: String,
    workspace_id: String,
    document_id: String,
) -> Result<Option<String>, String> {
    coordinator.ensure_member_or_creator(&workspace_id, &session_id)?;
    let doc = coordinator.get_document(&workspace_id, &document_id)?;
    Ok(doc.map(|d| d.content))
}

/// 列出所有活跃工作区（从索引表）
#[tauri::command]
pub async fn workspace_list_all(
    coordinator: State<'_, Arc<WorkspaceCoordinator>>,
    session_id: String,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<Vec<WorkspaceInfo>, String> {
    let conn = db
        .get_conn_safe()
        .map_err(|e| format!("Failed to get connection: {}", e))?;

    let mut stmt = conn
        .prepare(
            "SELECT workspace_id, name, status, creator_session_id, created_at, updated_at
         FROM workspace_index
         WHERE status = 'active'
         ORDER BY created_at DESC",
        )
        .map_err(|e| format!("Failed to prepare statement: {}", e))?;

    let workspaces = stmt
        .query_map([], |row| {
            Ok(WorkspaceInfo {
                id: row.get(0)?,
                name: row.get(1)?,
                status: row.get(2)?,
                creator_session_id: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(|e| format!("Failed to query workspaces: {}", e))?;

    let mut result = Vec::new();
    for ws in workspaces {
        if let Ok(w) = ws {
            match coordinator.is_member_or_creator_session(&w.id, &session_id) {
                Ok(true) => result.push(w),
                Ok(false) => {}
                Err(e) => {
                    log::warn!(
                        "[Workspace::handlers] Failed to check workspace membership: workspace_id={}, error={}",
                        w.id,
                        e
                    );
                }
            }
        }
    }

    Ok(result)
}

/// 运行 Worker Agent（Headless 执行）
///
/// 启动指定 Agent 的 Pipeline 执行，从 inbox 获取消息作为输入。
/// Worker 会自动处理 inbox 中的任务消息，并在空闲期继续检查新消息。
#[tauri::command]
pub async fn workspace_run_agent(
    request: RunAgentRequest,
    window: Window,
    coordinator: State<'_, Arc<WorkspaceCoordinator>>,
    chat_v2_state: State<'_, Arc<ChatV2State>>,
    pipeline: State<'_, Arc<ChatV2Pipeline>>,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<RunAgentResponse, String> {
    let workspace_id = &request.workspace_id;
    let agent_session_id = &request.agent_session_id;

    coordinator.ensure_member_or_creator(workspace_id, &request.requester_session_id)?;

    log::info!(
        "[Workspace::handlers] [RUN_AGENT_START] workspace_run_agent: workspace_id={}, agent_session_id={}, has_reminder={}",
        workspace_id,
        agent_session_id,
        request.reminder.is_some()
    );

    // 1. 验证 Agent 存在并获取信息
    log::debug!(
        "[Workspace::handlers] [RUN_AGENT] Step 1: Listing agents for workspace {}",
        workspace_id
    );
    let agents = coordinator.list_agents(workspace_id)?;
    log::debug!(
        "[Workspace::handlers] [RUN_AGENT] Found {} agents in workspace {}",
        agents.len(),
        workspace_id
    );
    let agent = agents
        .iter()
        .find(|a| a.session_id == *agent_session_id)
        .ok_or_else(|| format!("Agent not found: {}", agent_session_id))?;
    let is_worker = matches!(agent.role, AgentRole::Worker);

    // 只有 Worker 可以被自动运行
    if matches!(agent.role, AgentRole::Coordinator) {
        return Err(
            "Coordinator agents cannot be auto-run, they are driven by user input".to_string(),
        );
    }

    // 2. 从 inbox 获取待处理消息
    // 🔧 P25 修复：inbox 为空时返回成功（幂等），而不是报错
    // 这解决了重复调用 runAgent 导致的错误（例如页面刷新后 useWorkspaceRestore 再次触发）
    log::info!(
        "[Workspace::handlers] [RUN_AGENT] Step 2: Draining inbox for agent {}",
        agent_session_id
    );
    let messages = coordinator.drain_inbox(workspace_id, agent_session_id, 10)?;
    log::info!(
        "[Workspace::handlers] [RUN_AGENT] Drained {} messages from inbox for agent {}",
        messages.len(),
        agent_session_id
    );
    // 🆕 P38: 处理 inbox 为空但有 reminder 的情况（子代理没发消息的重试）
    if messages.is_empty() {
        if let Some(ref reminder) = request.reminder {
            log::info!(
                "[Workspace::handlers] [INBOX_EMPTY_WITH_REMINDER] P38: No inbox messages but has reminder for agent {}, proceeding with reminder only",
                agent_session_id
            );
            // 继续执行，使用 reminder 作为消息内容
        } else {
            log::info!(
                "[Workspace::handlers] [INBOX_EMPTY] No pending messages for agent {}, returning success (idempotent)",
                agent_session_id
            );
            return Ok(RunAgentResponse {
                agent_session_id: agent_session_id.clone(),
                message_id: String::new(), // 幂等成功时无消息 ID
                status: "idle".to_string(),
            });
        }
    }

    // 保存原始消息 ID（用于冲突回滚与失败重试）
    let original_message_ids: Vec<String> = messages.iter().map(|m| m.id.clone()).collect();

    // 3. 构建用户消息内容（从 inbox 消息）
    let mut content = if messages.is_empty() {
        // 🆕 P38: inbox 为空但有 reminder 时，使用 reminder 作为主要内容
        String::new()
    } else {
        messages
            .iter()
            .map(|m| format!("[来自 {}] {}", m.sender_session_id, m.content))
            .collect::<Vec<_>>()
            .join("\n\n")
    };

    // 🆕 P38: 如果有 reminder，将其添加到消息内容（可能是开头或全部）
    if let Some(ref reminder) = request.reminder {
        log::info!(
            "[Workspace::handlers] [RUN_AGENT] P38: Adding reminder to message content for agent {}",
            agent_session_id
        );
        if content.is_empty() {
            content = reminder.clone();
        } else {
            content = format!("{}\n\n---\n\n{}", reminder, content);
        }
    }

    // 4. 检查是否有活跃流
    let cancel_token = match chat_v2_state.try_register_stream(agent_session_id) {
        Ok(token) => token,
        Err(()) => {
            // 避免 drain 后因并发流冲突直接返回导致消息丢失：将消息回补到 inbox
            let mut rollback_failures: Vec<String> = Vec::new();
            for message_id in &original_message_ids {
                if let Err(e) =
                    coordinator.re_enqueue_message(workspace_id, agent_session_id, message_id)
                {
                    let detail = format!("message_id={}, error={}", message_id, e);
                    rollback_failures.push(detail.clone());
                    log::error!(
                        "[Workspace::handlers] Failed to re-enqueue drained message on active-stream conflict: agent_session_id={}, {}",
                        agent_session_id,
                        detail
                    );
                }
            }

            if !rollback_failures.is_empty() {
                coordinator.emit_warning(crate::chat_v2::workspace::emitter::WorkspaceWarningEvent {
                    workspace_id: workspace_id.clone(),
                    code: "run_agent_conflict_requeue_failed".to_string(),
                    message: format!(
                        "Agent {} is already running, and {} drained message(s) could not be re-queued. Wait for completion, then manually retry the task.",
                        agent_session_id,
                        rollback_failures.len()
                    ),
                    agent_session_id: Some(agent_session_id.clone()),
                    message_id: original_message_ids.first().cloned(),
                    retry_count: None,
                    max_retries: None,
                });

                return Err(format!(
                    "Agent {} has an active stream, and {} drained message(s) failed to restore. Please wait for completion and retry manually.",
                    agent_session_id,
                    rollback_failures.len()
                ));
            }

            return Err("Agent has an active stream. Please wait for completion.".to_string());
        }
    };

    // 5. 更新 Agent 状态为 Running
    coordinator.update_agent_status(workspace_id, agent_session_id, AgentStatus::Running)?;

    // 🆕 P1 修复：标记子代理任务为 Running（支持重启恢复）
    // 🔧 P38 修复：子代理 session ID 实际是 agent_worker_ 前缀
    if is_worker {
        if let Ok(task_manager) = coordinator.get_task_manager(workspace_id) {
            if let Ok(Some(task)) = task_manager.get_agent_task(agent_session_id) {
                if let Err(e) = task_manager.mark_running(&task.id) {
                    log::warn!(
                        "[Workspace::handlers] Failed to mark task as running: {:?}",
                        e
                    );
                } else {
                    log::info!(
                        "[Workspace::handlers] Marked task {} as running for agent {}",
                        task.id,
                        agent_session_id
                    );
                }
            }
        }
    }

    // 6. 获取 Agent 的 System Prompt（从 metadata）
    let conn = db
        .get_conn_safe()
        .map_err(|e| format!("Failed to get db connection: {}", e))?;
    let session = crate::chat_v2::repo::ChatV2Repo::get_session_with_conn(&conn, agent_session_id)
        .map_err(|e| format!("Failed to get agent session: {}", e))?
        .ok_or_else(|| format!("Agent session not found: {}", agent_session_id))?;

    let system_prompt = session
        .metadata
        .as_ref()
        .and_then(|m| m.get("system_prompt"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // 获取 Skill 推荐的模型（优先使用第一个）
    let recommended_model = session
        .metadata
        .as_ref()
        .and_then(|m| m.get("recommended_models"))
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    if let Some(ref model) = recommended_model {
        log::info!(
            "[Workspace::handlers] Using skill recommended model: {} for agent: {}",
            model,
            agent_session_id
        );
    }

    // 7. 构建 SendMessageRequest
    // 🔧 P18 补充：为子代理注入 workspace 工具 Schema
    // 关键：子代理必须有 workspace_send 工具才能返回结果给主代理
    use crate::chat_v2::types::McpToolSchema;
    let workspace_tool_schemas = vec![
        McpToolSchema {
            name: "builtin-workspace_send".to_string(),
            description: Some("【必须调用】向工作区发送消息。任务完成后必须使用此工具发送 result 类型消息通知主代理。".to_string()),
            input_schema: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "workspace_id": {
                        "type": "string",
                        "description": "工作区 ID（必需，从任务消息中获取）"
                    },
                    "content": {
                        "type": "string",
                        "description": "【必需】你完成任务的结果内容"
                    },
                    "message_type": {
                        "type": "string",
                        "enum": ["result", "progress", "query"],
                        "description": "消息类型。任务完成时必须使用 \"result\""
                    }
                },
                "required": ["workspace_id", "content", "message_type"]
            })),
        },
        McpToolSchema {
            name: "builtin-workspace_query".to_string(),
            description: Some("查询工作区信息，包括共享上下文、文档等。".to_string()),
            input_schema: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "workspace_id": {
                        "type": "string",
                        "description": "工作区 ID"
                    },
                    "query_type": {
                        "type": "string",
                        "enum": ["agents", "messages", "documents", "context", "all"],
                        "description": "查询类型"
                    }
                },
                "required": ["workspace_id"]
            })),
        },
    ];

    let assistant_message_id = ChatMessage::generate_id();
    let send_request = ChatSendMessageRequest {
        session_id: agent_session_id.clone(),
        content,
        user_context_refs: None,
        path_map: None,
        workspace_id: Some(workspace_id.clone()),
        options: Some(SendOptions {
            system_prompt_override: system_prompt,
            // 使用 Skill 推荐的模型
            model_id: recommended_model,
            // Worker 默认禁用 RAG 等检索功能
            rag_enabled: Some(false),
            graph_rag_enabled: Some(false),
            memory_enabled: Some(false),
            // 🔧 P18 补充：注入 workspace 工具让子代理可以返回结果
            mcp_tool_schemas: Some(workspace_tool_schemas),
            ..Default::default()
        }),
        assistant_message_id: Some(assistant_message_id.clone()),
        user_message_id: None,
    };

    // 8. 异步执行 Pipeline
    let session_id = agent_session_id.clone();
    let session_id_for_cleanup = session_id.clone();
    let workspace_id_clone = workspace_id.clone();
    let window_clone = window.clone();
    let pipeline_clone = pipeline.inner().clone();
    let chat_v2_state_clone = chat_v2_state.inner().clone();
    let coordinator_clone = coordinator.inner().clone();

    // 🆕 P1修复：使用 TaskTracker 追踪异步任务
    chat_v2_state.spawn_tracked(async move {
        // 🔧 Panic guard: RAII 确保 remove_stream 在正常完成、取消或 panic 时都会被调用
        let _stream_guard = StreamGuard::new(chat_v2_state_clone.clone(), session_id_for_cleanup.clone());

        let result = pipeline_clone
            .execute(window_clone.clone(), send_request, cancel_token, Some(chat_v2_state_clone.clone()))
            .await;

        // remove_stream 由 _stream_guard 自动调用，无需手动清理

        // 🔧 P1-2 修复：执行失败时的重试机制
        // 🔧 P1-3 修复：子代理执行成功后应为 Completed 而非 Idle（子代理是一次性任务）
        // 🔧 P38 修复：子代理 session ID 实际是 agent_worker_ 前缀，不是 subagent_
        let is_subagent = is_worker;
        let final_status = match &result {
            Ok(_) => if is_subagent { AgentStatus::Completed } else { AgentStatus::Idle },
            Err(crate::chat_v2::error::ChatV2Error::Cancelled) => AgentStatus::Idle,
            Err(e) => {
                log::error!(
                    "[Workspace::handlers] Agent pipeline error: agent={}, error={}",
                    session_id,
                    e
                );

                // 🔧 P1-2 修复：失败时将消息重新放回 inbox 以便重试（带重试上限）
                // 注意：这里只是将消息 ID 重新加入 inbox，实际的消息内容仍在数据库中
                let mut exhausted: Vec<(String, u32)> = Vec::new();
                for msg_id in &original_message_ids {
                    let retry_count = coordinator_clone
                        .increment_message_retry_count(&workspace_id_clone, msg_id)
                        .unwrap_or(1);
                    if retry_count > MAX_AGENT_RETRY_ATTEMPTS {
                        exhausted.push((msg_id.clone(), retry_count));
                        continue;
                    }
                    if let Err(re) = coordinator_clone.re_enqueue_message(
                        &workspace_id_clone,
                        &session_id_for_cleanup,
                        msg_id,
                    ) {
                        log::warn!(
                            "[Workspace::handlers] Failed to re-enqueue message {} for retry: {}",
                            msg_id, re
                        );
                    }
                }
                let requeued_count = original_message_ids.len().saturating_sub(exhausted.len());
                log::info!(
                    "[Workspace::handlers] Re-enqueued {} messages for agent {} retry (exhausted: {})",
                    requeued_count,
                    session_id_for_cleanup,
                    exhausted.len()
                );

                if !exhausted.is_empty() {
                    for (msg_id, retry_count) in exhausted {
                        coordinator_clone.emit_warning(crate::chat_v2::workspace::emitter::WorkspaceWarningEvent {
                            workspace_id: workspace_id_clone.clone(),
                            code: "retry_limit_exceeded".to_string(),
                            message: format!(
                                "Retry limit exceeded for message {} (count {})",
                                msg_id, retry_count
                            ),
                            agent_session_id: Some(session_id_for_cleanup.clone()),
                            message_id: Some(msg_id),
                            retry_count: Some(retry_count),
                            max_retries: Some(MAX_AGENT_RETRY_ATTEMPTS),
                        });
                    }
                }

                AgentStatus::Failed
            }
        };
        let _ = coordinator_clone.update_agent_status(&workspace_id_clone, &session_id_for_cleanup, final_status.clone());

        // 🆕 P1 修复：更新子代理任务完成状态
        // 🔧 P38 修复：子代理 session ID 实际是 agent_worker_ 前缀
        if is_worker {
            if let Ok(task_manager) = coordinator_clone.get_task_manager(&workspace_id_clone) {
                if let Ok(Some(task)) = task_manager.get_agent_task(&session_id_for_cleanup) {
                    let task_result = match &final_status {
                        AgentStatus::Completed => {
                            task_manager.mark_completed(&task.id, Some("Task completed successfully"))
                        }
                        AgentStatus::Failed => {
                            task_manager.mark_failed(&task.id, Some("Task execution failed"))
                        }
                        _ => Ok(()),
                    };
                    if let Err(e) = task_result {
                        log::warn!("[Workspace::handlers] Failed to update task status: {:?}", e);
                    } else if matches!(final_status, AgentStatus::Completed | AgentStatus::Failed) {
                        log::info!(
                            "[Workspace::handlers] Updated task {} status to {:?} for agent {}",
                            task.id, final_status, session_id_for_cleanup
                        );
                    }
                }
            }

            // 🆕 P38 修复：子代理完成后检查是否发送过消息
            // 如果没有发送过消息，需要重新触发子代理执行，提醒它必须发送结果
            // 🔧 P38 批判性修复：添加重试次数限制，检查任务开始后的消息
            if matches!(final_status, AgentStatus::Completed) {
                // 获取任务开始时间，只检查此时间之后的消息
                let task_started_at = if let Ok(task_manager) = coordinator_clone.get_task_manager(&workspace_id_clone) {
                    if let Ok(Some(task)) = task_manager.get_agent_task(&session_id_for_cleanup) {
                        task.started_at.map(|t| t.to_rfc3339())
                    } else {
                        None
                    }
                } else {
                    None
                };

                // 使用任务开始时间检查消息，如果没有则使用默认值（1小时前）
                let since = task_started_at.unwrap_or_else(|| {
                    (chrono::Utc::now() - chrono::Duration::hours(1)).to_rfc3339()
                });

                let has_sent_message = coordinator_clone
                    .has_agent_sent_message_since(&workspace_id_clone, &session_id_for_cleanup, &since)
                    .unwrap_or(false);

                if !has_sent_message {
                    // 🔧 P38 批判性修复：限制最大重试次数为 2 次
                    // 使用静态变量跟踪重试次数（简化实现）
                    static RETRY_COUNTS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, u32>>> =
                        std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

                    let mut counts = RETRY_COUNTS.lock().unwrap_or_else(|e| e.into_inner());
                    let retry_count = counts.entry(session_id_for_cleanup.clone()).or_insert(0);
                    *retry_count += 1;

                    const MAX_RETRIES: u32 = 2;
                    if *retry_count > MAX_RETRIES {
                        log::error!(
                            "[Workspace::handlers] ❌ P38: Subagent {} exceeded max retries ({}) without sending message. Giving up.",
                            session_id_for_cleanup, MAX_RETRIES
                        );
                        // 发射失败事件，通知前端
                        use tauri::Emitter;
                        let fail_payload = serde_json::json!({
                            "workspace_id": workspace_id_clone,
                            "agent_session_id": session_id_for_cleanup,
                            "reason": "max_retries_exceeded",
                            "message": format!("子代理已重试 {} 次仍未发送结果，放弃重试", MAX_RETRIES),
                        });
                        let _ = window_clone.emit("workspace_subagent_retry", &fail_payload);
                        // 不再重试，保持 Completed 状态
                    } else {
                        log::warn!(
                            "[Workspace::handlers] 🔔 P38: Subagent {} completed without sending message! Retry {}/{}",
                            session_id_for_cleanup, retry_count, MAX_RETRIES
                        );

                        // 发射 subagent_retry 事件，让前端创建并持久化块
                        use tauri::Emitter;
                        let retry_block_payload = serde_json::json!({
                            "workspace_id": workspace_id_clone,
                            "agent_session_id": session_id_for_cleanup,
                            "reason": "no_message_sent",
                            "message": format!("子代理完成任务但未发送结果消息，正在重试 ({}/{})", retry_count, MAX_RETRIES),
                            "retry_count": retry_count,
                        });
                        if let Err(e) = window_clone.emit("workspace_subagent_retry", &retry_block_payload) {
                            log::warn!("[Workspace::handlers] Failed to emit subagent_retry event: {}", e);
                        }

                        // 重新将状态设为 Running，准备重新执行
                        let _ = coordinator_clone.update_agent_status(
                            &workspace_id_clone,
                            &session_id_for_cleanup,
                            AgentStatus::Running,
                        );

                        // 发射 worker_ready 事件，携带提醒消息
                        let reminder_payload = serde_json::json!({
                            "workspace_id": workspace_id_clone,
                            "agent_session_id": session_id_for_cleanup,
                            "skill_id": Option::<String>::None,
                            "reminder": format!("【重要提醒 - 第{}次】你之前没有发送任何消息就结束了任务。作为子代理，你必须在完成任务后使用 workspace_send_message 工具向主代理报告你的工作结果。请立即发送你的任务完成报告！", retry_count),
                        });
                        if let Err(e) = window_clone.emit(
                            crate::chat_v2::tools::workspace_executor::WORKSPACE_WORKER_READY_EVENT,
                            &reminder_payload
                        ) {
                            log::warn!(
                                "[Workspace::handlers] Failed to emit worker_ready for reminder: {}",
                                e
                            );
                        } else {
                            log::info!(
                                "[Workspace::handlers] 🔔 P38: Emitted worker_ready with reminder for subagent {} (retry {})",
                                session_id_for_cleanup, retry_count
                            );
                        }
                    }
                } else {
                    log::info!(
                        "[Workspace::handlers] ✅ P38: Subagent {} completed and has sent message(s)",
                        session_id_for_cleanup
                    );
                }
            }
        }

        if let Ok(msg_id) = &result {
            log::info!(
                "[Workspace::handlers] Agent pipeline completed: agent={}, message_id={}",
                session_id,
                msg_id
            );
        }

        // Worker 完成后检查 inbox 是否有新消息，如果有则触发继续执行
        if matches!(final_status, AgentStatus::Idle) {
            if coordinator_clone.has_pending_messages(&workspace_id_clone, &session_id_for_cleanup) {
                log::info!(
                    "[Workspace::handlers] Worker has pending messages, triggering continue: agent={}",
                    session_id_for_cleanup
                );
                // 发射 worker_ready 事件触发继续执行
                use tauri::Emitter;
                let event_payload = serde_json::json!({
                    "workspace_id": workspace_id_clone,
                    "agent_session_id": session_id_for_cleanup,
                    "skill_id": Option::<String>::None,
                });
                if let Err(e) = window_clone.emit(
                    crate::chat_v2::tools::workspace_executor::WORKSPACE_WORKER_READY_EVENT,
                    &event_payload
                ) {
                    log::warn!("[Workspace::handlers] Failed to emit worker_ready for continue: {}", e);
                }
            }
        }
    });

    Ok(RunAgentResponse {
        agent_session_id: agent_session_id.clone(),
        message_id: assistant_message_id,
        status: "running".to_string(),
    })
}

/// 取消 Worker Agent 执行（手动中止）
#[tauri::command]
pub async fn workspace_cancel_agent(
    coordinator: State<'_, Arc<WorkspaceCoordinator>>,
    chat_v2_state: State<'_, Arc<ChatV2State>>,
    session_id: String,
    workspace_id: String,
    agent_session_id: String,
) -> Result<bool, String> {
    coordinator.ensure_member_or_creator(&workspace_id, &session_id)?;

    let cancelled = chat_v2_state.cancel_stream(&agent_session_id);
    if cancelled {
        let _ =
            coordinator.update_agent_status(&workspace_id, &agent_session_id, AgentStatus::Idle);
        coordinator.emit_warning(crate::chat_v2::workspace::emitter::WorkspaceWarningEvent {
            workspace_id,
            code: "agent_cancelled".to_string(),
            message: format!("Agent {} execution cancelled by user", agent_session_id),
            agent_session_id: Some(agent_session_id),
            message_id: None,
            retry_count: None,
            max_retries: None,
        });
    }
    Ok(cancelled)
}

// ============================================================
// Skill 相关命令 - 已移除
// ============================================================
// 技能系统由前端 src/chat-v2/skills/ 管理
// workspace_list_skills 和 workspace_get_skill 命令已删除

// ============================================================
// 睡眠/唤醒相关命令
// ============================================================

#[derive(Debug, Deserialize)]
pub struct ManualWakeRequest {
    pub workspace_id: String,
    /// 请求者会话 ID（用于权限校验）
    pub requester_session_id: String,
    pub sleep_id: String,
    pub message: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ManualWakeResponse {
    pub success: bool,
    pub sleep_id: String,
}

/// 手动唤醒睡眠中的 Coordinator
#[tauri::command]
pub async fn workspace_manual_wake(
    request: ManualWakeRequest,
    coordinator: State<'_, Arc<WorkspaceCoordinator>>,
) -> Result<ManualWakeResponse, String> {
    coordinator.ensure_member_or_creator(&request.workspace_id, &request.requester_session_id)?;

    let sleep_manager = coordinator.get_sleep_manager(&request.workspace_id)?;

    // 🔧 P33 修复：获取唤醒结果信息，用于发射事件
    let wake_result = sleep_manager
        .manual_wake(&request.sleep_id, request.message.clone())
        .map_err(|e| format!("Failed to wake: {:?}", e))?;

    let success = wake_result.is_some();

    log::info!(
        "[Workspace::handlers] Manual wake: sleep_id={}, success={}",
        request.sleep_id,
        success
    );

    // 🔧 P33 修复：发射唤醒事件，通知前端更新 UI
    if let Some(info) = wake_result {
        coordinator.emit_coordinator_awakened(&info);
    }

    Ok(ManualWakeResponse {
        success,
        sleep_id: request.sleep_id,
    })
}

/// 取消睡眠
#[tauri::command]
pub async fn workspace_cancel_sleep(
    session_id: String,
    workspace_id: String,
    sleep_id: String,
    coordinator: State<'_, Arc<WorkspaceCoordinator>>,
) -> Result<bool, String> {
    coordinator.ensure_member_or_creator(&workspace_id, &session_id)?;

    let sleep_manager = coordinator.get_sleep_manager(&workspace_id)?;

    let cancelled = sleep_manager
        .cancel(&sleep_id)
        .map_err(|e| format!("Failed to cancel sleep: {:?}", e))?;

    log::info!(
        "[Workspace::handlers] Cancel sleep: sleep_id={}, cancelled={}",
        sleep_id,
        cancelled
    );

    Ok(cancelled)
}

// ============================================================
// 重启恢复相关命令
// ============================================================

#[derive(Debug, Serialize)]
pub struct RestoreExecutionsResponse {
    /// 恢复的子代理任务数量
    pub subagent_tasks_restored: usize,
    /// 恢复的子代理 session IDs
    pub restored_agent_ids: Vec<String>,
    /// 是否有活跃的睡眠块
    pub has_active_sleeps: bool,
    /// 活跃睡眠块 IDs
    pub active_sleep_ids: Vec<String>,
}

/// 🆕 重启后恢复被中断的执行
///
/// 这个命令应该在前端加载 workspace 后调用，用于：
/// 1. 恢复 pending/running 状态的子代理任务
/// 2. 检查并报告活跃的睡眠块状态
///
/// 注意：主代理的 pipeline 恢复依赖于 TodoList 持久化机制，
/// 前端应该在检测到 interrupted 状态的消息时调用 chat_v2_continue_message
#[tauri::command]
pub async fn workspace_restore_executions(
    session_id: String,
    workspace_id: String,
    window: Window,
    coordinator: State<'_, Arc<WorkspaceCoordinator>>,
    chat_v2_state: State<'_, Arc<ChatV2State>>,
    pipeline: State<'_, Arc<ChatV2Pipeline>>,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<RestoreExecutionsResponse, String> {
    coordinator.ensure_member_or_creator(&workspace_id, &session_id)?;

    log::info!(
        "[Workspace::handlers] workspace_restore_executions: workspace_id={}",
        workspace_id
    );

    let mut restored_agent_ids = Vec::new();

    // 1. 获取需要恢复的子代理任务
    let task_manager = coordinator.get_task_manager(&workspace_id)?;
    let tasks_to_restore = task_manager
        .get_tasks_to_restore()
        .map_err(|e| format!("Failed to get tasks to restore: {:?}", e))?;

    // 2. 为每个需要恢复的任务发射 worker_ready 事件
    for task in &tasks_to_restore {
        log::info!(
            "[Workspace::handlers] Restoring subagent task: agent_session_id={}, status={:?}",
            task.agent_session_id,
            task.status
        );

        // 检查 agent 是否有待处理消息
        let has_pending = coordinator.has_pending_messages(&workspace_id, &task.agent_session_id);
        let running_without_inbox =
            matches!(task.status, SubagentTaskStatus::Running) && !has_pending;

        if has_pending || running_without_inbox {
            use tauri::Emitter;
            let event_payload = serde_json::json!({
                "workspace_id": workspace_id,
                "agent_session_id": task.agent_session_id,
                "skill_id": task.skill_id,
                "restored": true,
                "reminder": if running_without_inbox {
                    Some("继续执行上次中断任务（恢复）")
                } else {
                    None
                },
            });

            if let Err(e) = window.emit(
                crate::chat_v2::tools::workspace_executor::WORKSPACE_WORKER_READY_EVENT,
                &event_payload,
            ) {
                log::warn!(
                    "[Workspace::handlers] Failed to emit worker_ready for restore: session={}, error={}",
                    task.agent_session_id, e
                );
            } else {
                restored_agent_ids.push(task.agent_session_id.clone());
            }
        } else {
            log::debug!(
                "[Workspace::handlers] Skipping task restore (no pending messages): agent_session_id={}",
                task.agent_session_id
            );
        }
    }

    // 3. 检查活跃的睡眠块
    let sleep_manager = coordinator.get_sleep_manager(&workspace_id)?;
    let active_sleep_ids = sleep_manager.get_active_sleep_ids();
    let has_active_sleeps = !active_sleep_ids.is_empty();

    if has_active_sleeps {
        log::info!(
            "[Workspace::handlers] Found {} active sleeps for workspace {}",
            active_sleep_ids.len(),
            workspace_id
        );
    }

    log::info!(
        "[Workspace::handlers] Restore complete: {} tasks restored, {} active sleeps",
        restored_agent_ids.len(),
        active_sleep_ids.len()
    );

    Ok(RestoreExecutionsResponse {
        subagent_tasks_restored: restored_agent_ids.len(),
        restored_agent_ids,
        has_active_sleeps,
        active_sleep_ids,
    })
}
