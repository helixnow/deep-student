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
use crate::chat_v2::workspace::config::{
    MAX_CONCURRENT_WORKERS, WORKER_PIPELINE_CANCEL_GRACE_SECS, WORKER_PIPELINE_TIMEOUT_SECS,
};
use crate::chat_v2::workspace::{
    AgentRole, AgentStatus, MessageType, SubagentTaskData, SubagentTaskStatus,
    WorkspaceCoordinator, MAX_AGENT_RETRY_ATTEMPTS,
};

// ============================================================
// Worker 生命周期辅助（并发上限 / P38 重试计数 / 结果摘要）
// ============================================================

/// result_summary 最大字符数（按字符截断，非字节）
const WORKER_RESULT_SUMMARY_MAX_CHARS: usize = 500;

/// P38：子代理"完成但未发送结果消息"的最大重试次数
const MAX_NO_MESSAGE_RETRIES: u32 = 2;

/// P38：子代理"完成但未发送结果消息"的进程级重试计数。
/// 条目在成功发送消息或进入终态（Completed/Failed/Cancelled）后必须清理，防止泄漏。
static WORKER_NO_MESSAGE_RETRY_COUNTS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, u32>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

fn bump_no_message_retry_count(agent_session_id: &str) -> u32 {
    let mut counts = WORKER_NO_MESSAGE_RETRY_COUNTS
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let count = counts.entry(agent_session_id.to_string()).or_insert(0);
    *count += 1;
    *count
}

fn clear_no_message_retry_count(agent_session_id: &str) {
    let mut counts = WORKER_NO_MESSAGE_RETRY_COUNTS
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    counts.remove(agent_session_id);
}

/// 全局 worker 管线并发信号量（懒初始化，进程级）
static WORKER_PIPELINE_SEMAPHORE: std::sync::OnceLock<tokio::sync::Semaphore> =
    std::sync::OnceLock::new();

fn worker_pipeline_semaphore() -> &'static tokio::sync::Semaphore {
    WORKER_PIPELINE_SEMAPHORE.get_or_init(|| tokio::sync::Semaphore::new(MAX_CONCURRENT_WORKERS))
}

/// 按字符（非字节）截断文本，避免多字节字符边界 panic
fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let truncated: String = text.chars().take(max_chars).collect();
    format!("{}…", truncated)
}

/// 提取子代理最终 assistant 消息的 content 块文本并截断，供 result_summary 使用
/// （逻辑参考 headless.rs 的 summarize_assistant_message）。
fn summarize_worker_assistant_message(
    db: &ChatV2Database,
    assistant_message_id: &str,
) -> Option<String> {
    let blocks = match crate::chat_v2::repo::ChatV2Repo::get_message_blocks_v2(
        db,
        assistant_message_id,
    ) {
        Ok(blocks) => blocks,
        Err(e) => {
            log::warn!(
                    "[Workspace::handlers] Failed to read assistant blocks for result_summary: message={}, err={}",
                    assistant_message_id,
                    e
                );
            return None;
        }
    };

    let text = blocks
        .iter()
        .filter(|b| b.block_type == "content")
        .filter_map(|b| b.content.as_deref())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();

    if text.is_empty() {
        None
    } else {
        Some(truncate_chars(&text, WORKER_RESULT_SUMMARY_MAX_CHARS))
    }
}

/// 🆕 取消传播：workspace 关闭/删除前，取消该 workspace 内所有活跃 worker 的流，
/// 并把 pending/running 任务置 Cancelled，防止重启后 restore 把它们当"中断任务"复活。
fn cancel_workspace_active_workers(
    coordinator: &WorkspaceCoordinator,
    chat_v2_state: &ChatV2State,
    workspace_id: &str,
    reason: &str,
) {
    match coordinator.list_agents(workspace_id) {
        Ok(agents) => {
            for agent in agents
                .iter()
                .filter(|a| matches!(a.role, AgentRole::Worker))
            {
                let stream_cancelled = chat_v2_state.cancel_stream(&agent.session_id);
                clear_no_message_retry_count(&agent.session_id);
                if stream_cancelled || matches!(agent.status, AgentStatus::Running) {
                    let _ = coordinator.update_agent_status(
                        workspace_id,
                        &agent.session_id,
                        AgentStatus::Cancelled,
                    );
                    log::info!(
                        "[Workspace::handlers] Cancelled worker on {}: agent={}, had_stream={}",
                        reason,
                        agent.session_id,
                        stream_cancelled
                    );
                }
            }
        }
        Err(e) => {
            log::warn!(
                "[Workspace::handlers] Failed to list agents for cancel propagation ({}): {}",
                reason,
                e
            );
        }
    }

    match coordinator.get_task_manager(workspace_id) {
        Ok(task_manager) => match task_manager.get_tasks_to_restore() {
            Ok(tasks) => {
                for task in tasks {
                    if let Err(e) = task_manager.update_status(
                        &task.id,
                        SubagentTaskStatus::Cancelled,
                        Some(reason),
                    ) {
                        log::warn!(
                            "[Workspace::handlers] Failed to cancel task {} on {}: {:?}",
                            task.id,
                            reason,
                            e
                        );
                    }
                }
            }
            Err(e) => {
                log::warn!(
                    "[Workspace::handlers] Failed to enumerate tasks for cancel propagation ({}): {:?}",
                    reason,
                    e
                );
            }
        },
        Err(e) => {
            log::warn!(
                "[Workspace::handlers] Failed to get task manager for cancel propagation ({}): {}",
                reason,
                e
            );
        }
    }
}

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

fn ensure_workspace_creator(
    coordinator: &WorkspaceCoordinator,
    workspace_id: &str,
    session_id: &str,
) -> Result<(), String> {
    let workspace = coordinator
        .get_workspace(workspace_id)?
        .ok_or_else(|| format!("Workspace not found: {}", workspace_id))?;

    if workspace.creator_session_id != session_id {
        return Err(
            "Permission denied: only workspace creator can perform this action".to_string(),
        );
    }

    Ok(())
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
    chat_v2_state: State<'_, Arc<ChatV2State>>,
    session_id: String,
    workspace_id: String,
) -> Result<(), String> {
    ensure_workspace_creator(coordinator.inner().as_ref(), &workspace_id, &session_id)?;
    // 🆕 取消传播：关闭前先取消活跃 worker 流并把任务置 Cancelled
    cancel_workspace_active_workers(
        coordinator.inner().as_ref(),
        chat_v2_state.inner().as_ref(),
        &workspace_id,
        "workspace closed",
    );
    coordinator.close_workspace(&workspace_id)
}

/// 删除工作区
#[tauri::command]
pub async fn workspace_delete(
    coordinator: State<'_, Arc<WorkspaceCoordinator>>,
    chat_v2_state: State<'_, Arc<ChatV2State>>,
    session_id: String,
    workspace_id: String,
) -> Result<(), String> {
    ensure_workspace_creator(coordinator.inner().as_ref(), &workspace_id, &session_id)?;
    // 🆕 取消传播：删除前先取消活跃 worker 流并把任务置 Cancelled
    cancel_workspace_active_workers(
        coordinator.inner().as_ref(),
        chat_v2_state.inner().as_ref(),
        &workspace_id,
        "workspace deleted",
    );
    coordinator.delete_workspace(&workspace_id)
}

/// 创建 Agent
#[tauri::command]
pub async fn workspace_create_agent(
    coordinator: State<'_, Arc<WorkspaceCoordinator>>,
    db: State<'_, Arc<ChatV2Database>>,
    window: Window,
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
    let is_worker = matches!(role, AgentRole::Worker);

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

    // 🆕 子代理深度：从 requester 会话 metadata 继承 +1（与工具路径对齐），
    // 使 UI 创建的 worker 也受 subagent 嵌套深度限制约束。
    let requester_depth = ChatV2Repo::get_session_with_conn(&conn, &request.requester_session_id)
        .map_err(|e| format!("Failed to query requester session for depth: {}", e))?
        .and_then(|s| s.metadata)
        .and_then(|m| m.get("subagent_depth").cloned())
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;

    // 🔧 按字符截取前缀，避免多字节字符边界 panic
    let workspace_id_prefix: String = request.workspace_id.chars().take(8).collect();

    let now = chrono::Utc::now();
    let session = ChatSession {
        id: agent_session_id.clone(),
        mode: "agent".to_string(),
        title: Some(format!(
            "Agent: {}",
            request.skill_id.as_deref().unwrap_or("Worker")
        )),
        description: Some(format!("工作区 {} 的 Agent", workspace_id_prefix)),
        summary_hash: None,
        // Agent 标题是系统语义化命名，锁定避免被自动摘要覆盖
        title_locked: true,
        persist_status: PersistStatus::Active,
        created_at: now,
        updated_at: now,
        metadata: Some(serde_json::json!({
            "workspace_id": request.workspace_id,
            "role": role_str,
            "skill_id": request.skill_id,
            "system_prompt": request.system_prompt,
            "recommended_models": Vec::<String>::new(),
            "parent_session_id": request.requester_session_id,
            "subagent_depth": requester_depth + 1,
        })),
        group_id: None,
        tags_hash: None,
        tags: None,
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

    // 🔧 P0 修复：初始任务投递与工具路径对齐——sender 用 requester、target 指向新 agent。
    // 旧实现 sender=新 agent 自己且广播，router 的 resolve_targets 排除 sender，
    // 导致初始任务永远到不了新 worker 的 inbox。
    let has_initial_task = request.initial_task.is_some();
    if let Some(task) = &request.initial_task {
        coordinator.send_message(
            &request.workspace_id,
            &request.requester_session_id,
            Some(&agent_session_id),
            MessageType::Task,
            task.clone(),
        )?;

        // 🆕 Worker + 初始任务：持久化 subagent_task（与工具路径对齐，支持重启恢复）
        if is_worker {
            match coordinator.get_task_manager(&request.workspace_id) {
                Ok(task_manager) => {
                    let task_data = SubagentTaskData::new(
                        request.workspace_id.clone(),
                        agent_session_id.clone(),
                        request.skill_id.clone(),
                        Some(task.clone()),
                    );
                    if let Err(e) = task_manager.create_task(&task_data) {
                        log::warn!(
                            "[Workspace::handlers] Failed to persist worker task: {:?}",
                            e
                        );
                    } else {
                        log::info!(
                            "[Workspace::handlers] Persisted worker task: task_id={}, agent={}",
                            task_data.id,
                            agent_session_id
                        );
                    }
                }
                Err(e) => {
                    log::warn!(
                        "[Workspace::handlers] Failed to get task manager for worker task: {}",
                        e
                    );
                }
            }
        }
    }

    // 🆕 Worker + 初始任务：发射 worker_ready 事件触发自动执行（与工具路径对齐）
    if is_worker && has_initial_task {
        use tauri::Emitter;
        let event_payload = serde_json::json!({
            "workspace_id": request.workspace_id,
            "agent_session_id": agent_session_id,
            "skill_id": request.skill_id,
        });
        if let Err(e) = window.emit(
            crate::chat_v2::tools::workspace_executor::WORKSPACE_WORKER_READY_EVENT,
            &event_payload,
        ) {
            log::warn!(
                "[Workspace::handlers] Failed to emit worker_ready for created agent: {}",
                e
            );
        } else {
            log::info!(
                "[Workspace::handlers] Emitted worker_ready for created agent: {}",
                agent_session_id
            );
        }
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
        if let Some(ref _reminder) = request.reminder {
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
    let stream_registration = match chat_v2_state.try_register_stream_owned(agent_session_id) {
        Ok(registration) => registration,
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
    let stream_generation = stream_registration.generation();
    let cancel_token = stream_registration.token().clone();
    // Create the guard before the remaining fallible setup. Early `?` returns now release exactly
    // this generation, while a late worker cleanup cannot delete an immediate replacement run.
    let stream_guard = StreamGuard::new(
        chat_v2_state.inner().clone(),
        agent_session_id.clone(),
        stream_registration,
    );

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
            server_id: None,
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
            server_id: None,
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

    // 🆕 执行层工具白名单（fail-closed，参考 headless.rs 的双层防线）：
    // schema 层只注入 workspace_send/query，但执行层若不设白名单则全放行——
    // worker 模型输出 subagent_call / workspace_create_agent 等任意工具名都会被执行，
    // 深度限制可被绕过。白名单直接取注入 schema 的工具集，保持单一事实来源。
    let worker_allowed_tools: Vec<String> = workspace_tool_schemas
        .iter()
        .map(|schema| schema.name.clone())
        .collect();

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
            // 🆕 执行层 fail-closed：白名单外的调用在审批/执行前被直接拦截
            skill_allowed_tools: Some(worker_allowed_tools),
            stream_generation: Some(stream_generation),
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
    let db_clone = db.inner().clone();
    let assistant_message_id_for_task = assistant_message_id.clone();
    let agent_skill_id = agent.skill_id.clone();

    // 🆕 P1修复：使用 TaskTracker 追踪异步任务
    chat_v2_state.spawn_tracked(async move {
        use tauri::Emitter;

        let stream_guard = stream_guard;

        // 🆕 并发上限：全局信号量限制同时运行的 worker 管线数量。
        // acquire 放在 spawn 内部避免阻塞命令返回；permit 持有到管线结束。
        let permit = worker_pipeline_semaphore().acquire().await;
        if permit.is_err() {
            // Semaphore 从不 close，此分支仅为防御
            log::error!(
                "[Workspace::handlers] Worker semaphore closed unexpectedly, aborting pipeline: agent={}",
                session_id_for_cleanup
            );
        }

        // 🆕 整体超时：pipeline 包 wall-clock 上限（对齐 headless），
        // 超时后触发取消并给管线一个收尾窗口保存部分结果。
        let mut timed_out = false;
        let result = if permit.is_ok() {
            let pipeline_fut = pipeline_clone.execute(
                window_clone.clone(),
                send_request,
                cancel_token.clone(),
                Some(chat_v2_state_clone.clone()),
            );
            tokio::pin!(pipeline_fut);
            match tokio::time::timeout(
                std::time::Duration::from_secs(WORKER_PIPELINE_TIMEOUT_SECS),
                &mut pipeline_fut,
            )
            .await
            {
                Ok(res) => res,
                Err(_) => {
                    log::warn!(
                        "[Workspace::handlers] Worker pipeline exceeded {}s timeout, cancelling: agent={}",
                        WORKER_PIPELINE_TIMEOUT_SECS,
                        session_id_for_cleanup
                    );
                    timed_out = true;
                    cancel_token.cancel();
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_secs(WORKER_PIPELINE_CANCEL_GRACE_SECS),
                        &mut pipeline_fut,
                    )
                    .await;
                    Err(crate::chat_v2::error::ChatV2Error::Other(format!(
                        "Worker pipeline timed out after {}s",
                        WORKER_PIPELINE_TIMEOUT_SECS
                    )))
                }
            }
        } else {
            Err(crate::chat_v2::error::ChatV2Error::Other(
                "Worker semaphore closed unexpectedly".to_string(),
            ))
        };
        drop(permit);

        // 管线已结束：先释放流注册，避免下面 worker_ready 触发的下一轮 run_agent
        // 与本次流注册冲突（run_agent 的 try_register_stream 会拒绝并回滚 drain）。
        drop(stream_guard);

        let task_manager = coordinator_clone.get_task_manager(&workspace_id_clone).ok();
        // 当前 pending/running 任务（终态更新前查询一次，后续复用）
        let current_task = task_manager
            .as_ref()
            .and_then(|tm| tm.get_agent_task(&session_id_for_cleanup).ok().flatten());

        match &result {
            Ok(msg_id) => {
                log::info!(
                    "[Workspace::handlers] Agent pipeline completed: agent={}, message_id={}",
                    session_id,
                    msg_id
                );

                if is_worker {
                    // 🔧 P38 时序修复：先检查"是否发过消息"，再决定是否置 Completed。
                    // 过早置 Completed 会立刻触发 coordinator 的 all-terminal 唤醒，
                    // 主代理拿到"完成"信号但没有任何结果。
                    let task_started_at = current_task
                        .as_ref()
                        .and_then(|t| t.started_at)
                        .map(|t| t.to_rfc3339());
                    let since = task_started_at.unwrap_or_else(|| {
                        (chrono::Utc::now() - chrono::Duration::hours(1)).to_rfc3339()
                    });
                    let has_sent_message = coordinator_clone
                        .has_agent_sent_message_since(&workspace_id_clone, &session_id_for_cleanup, &since)
                        .unwrap_or(false);

                    if has_sent_message {
                        log::info!(
                            "[Workspace::handlers] ✅ P38: Subagent {} completed and has sent message(s)",
                            session_id_for_cleanup
                        );
                        // 🔧 泄漏修复：成功发消息后清理进程级重试计数
                        clear_no_message_retry_count(&session_id_for_cleanup);
                        let _ = coordinator_clone.update_agent_status(
                            &workspace_id_clone,
                            &session_id_for_cleanup,
                            AgentStatus::Completed,
                        );
                        if let (Some(tm), Some(task)) = (task_manager.as_ref(), current_task.as_ref()) {
                            // 🔧 result_summary：存最终 assistant 消息内容的截断摘要，而非占位符
                            let summary = summarize_worker_assistant_message(
                                &db_clone,
                                &assistant_message_id_for_task,
                            )
                            .unwrap_or_else(|| "Task completed successfully".to_string());
                            if let Err(e) = tm.mark_completed(&task.id, Some(&summary)) {
                                log::warn!(
                                    "[Workspace::handlers] Failed to mark task completed: {:?}",
                                    e
                                );
                            }
                        }
                    } else {
                        let retry_count = bump_no_message_retry_count(&session_id_for_cleanup);
                        if retry_count > MAX_NO_MESSAGE_RETRIES {
                            // 🔧 重试耗尽 → Failed（而非伪 Completed），并清理重试计数
                            clear_no_message_retry_count(&session_id_for_cleanup);
                            log::error!(
                                "[Workspace::handlers] ❌ P38: Subagent {} exceeded max retries ({}) without sending message. Giving up.",
                                session_id_for_cleanup, MAX_NO_MESSAGE_RETRIES
                            );
                            let fail_payload = serde_json::json!({
                                "workspace_id": workspace_id_clone,
                                "agent_session_id": session_id_for_cleanup,
                                "reason": "max_retries_exceeded",
                                "message": format!("子代理已重试 {} 次仍未发送结果，放弃重试", MAX_NO_MESSAGE_RETRIES),
                            });
                            let _ = window_clone.emit("workspace_subagent_retry", &fail_payload);
                            let _ = coordinator_clone.update_agent_status(
                                &workspace_id_clone,
                                &session_id_for_cleanup,
                                AgentStatus::Failed,
                            );
                            if let (Some(tm), Some(task)) = (task_manager.as_ref(), current_task.as_ref()) {
                                let summary = format!(
                                    "子代理执行了 {} 次均未发送结果消息，放弃重试",
                                    MAX_NO_MESSAGE_RETRIES + 1
                                );
                                if let Err(e) = tm.mark_failed(&task.id, Some(&summary)) {
                                    log::warn!(
                                        "[Workspace::handlers] Failed to mark task failed: {:?}",
                                        e
                                    );
                                }
                            }
                        } else {
                            // 🔧 P38 时序修复：保持 Running（不发 Completed 信号），
                            // task 保持 running，通过 worker_ready + reminder 走重试。
                            log::warn!(
                                "[Workspace::handlers] 🔔 P38: Subagent {} completed without sending message! Retry {}/{}",
                                session_id_for_cleanup, retry_count, MAX_NO_MESSAGE_RETRIES
                            );

                            let retry_block_payload = serde_json::json!({
                                "workspace_id": workspace_id_clone,
                                "agent_session_id": session_id_for_cleanup,
                                "reason": "no_message_sent",
                                "message": format!("子代理完成任务但未发送结果消息，正在重试 ({}/{})", retry_count, MAX_NO_MESSAGE_RETRIES),
                                "retry_count": retry_count,
                            });
                            if let Err(e) = window_clone.emit("workspace_subagent_retry", &retry_block_payload) {
                                log::warn!("[Workspace::handlers] Failed to emit subagent_retry event: {}", e);
                            }

                            let _ = coordinator_clone.update_agent_status(
                                &workspace_id_clone,
                                &session_id_for_cleanup,
                                AgentStatus::Running,
                            );

                            // 🔧 工具名修正：注入的工具是 builtin-workspace_send（不存在 workspace_send_message）
                            let reminder_payload = serde_json::json!({
                                "workspace_id": workspace_id_clone,
                                "agent_session_id": session_id_for_cleanup,
                                "skill_id": agent_skill_id,
                                "reminder": format!("【重要提醒 - 第{}次】你之前没有发送任何消息就结束了任务。作为子代理，你必须在完成任务后调用 `builtin-workspace_send` 工具（message_type 设为 \"result\"）向主代理报告你的工作结果。请立即发送你的任务完成报告！", retry_count),
                            });
                            if let Err(e) = window_clone.emit(
                                crate::chat_v2::tools::workspace_executor::WORKSPACE_WORKER_READY_EVENT,
                                &reminder_payload,
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
                    }
                } else {
                    // 非 worker（当前不可达：coordinator 不允许 auto-run）：保持旧语义置 Idle，
                    // 并在有待处理消息时触发继续执行
                    let _ = coordinator_clone.update_agent_status(
                        &workspace_id_clone,
                        &session_id_for_cleanup,
                        AgentStatus::Idle,
                    );
                    if coordinator_clone.has_pending_messages(&workspace_id_clone, &session_id_for_cleanup) {
                        log::info!(
                            "[Workspace::handlers] Agent has pending messages, triggering continue: agent={}",
                            session_id_for_cleanup
                        );
                        let event_payload = serde_json::json!({
                            "workspace_id": workspace_id_clone,
                            "agent_session_id": session_id_for_cleanup,
                            "skill_id": agent_skill_id,
                        });
                        if let Err(e) = window_clone.emit(
                            crate::chat_v2::tools::workspace_executor::WORKSPACE_WORKER_READY_EVENT,
                            &event_payload,
                        ) {
                            log::warn!("[Workspace::handlers] Failed to emit worker_ready for continue: {}", e);
                        }
                    }
                }
            }
            Err(crate::chat_v2::error::ChatV2Error::Cancelled) => {
                // 🔧 P0 修复：取消必须落库。agent 与 task 都置 Cancelled（旧实现置 Idle
                // 且不动 task，导致任务停留 running、重启后被 restore 当"中断任务"复活）。
                log::info!(
                    "[Workspace::handlers] Agent pipeline cancelled: agent={}",
                    session_id_for_cleanup
                );
                clear_no_message_retry_count(&session_id_for_cleanup);
                let _ = coordinator_clone.update_agent_status(
                    &workspace_id_clone,
                    &session_id_for_cleanup,
                    AgentStatus::Cancelled,
                );
                if let (Some(tm), Some(task)) = (task_manager.as_ref(), current_task.as_ref()) {
                    if let Err(e) = tm.update_status(
                        &task.id,
                        SubagentTaskStatus::Cancelled,
                        Some("execution cancelled"),
                    ) {
                        log::warn!(
                            "[Workspace::handlers] Failed to mark task cancelled: {:?}",
                            e
                        );
                    }
                }
            }
            Err(e) => {
                log::error!(
                    "[Workspace::handlers] Agent pipeline error: agent={}, error={}",
                    session_id,
                    e
                );

                // 🔧 P1-2 修复：失败时将消息重新放回 inbox 以便重试（带重试上限）。
                // 超时失败不重试：整体超时任务重跑大概率再次超时，直接终态。
                let mut exhausted: Vec<(String, u32)> = Vec::new();
                let mut requeued_count = 0usize;
                if !timed_out {
                    for msg_id in &original_message_ids {
                        // 🔧 fail-closed：重试计数读取失败时按超限处理，
                        // 避免 DB 故障下重试上限失效（旧实现 unwrap_or(1) 是 fail-open）
                        let retry_count = match coordinator_clone
                            .increment_message_retry_count(&workspace_id_clone, msg_id)
                        {
                            Ok(count) => count,
                            Err(err) => {
                                log::error!(
                                    "[Workspace::handlers] Failed to read retry count for {} (fail-closed, treating as exhausted): {}",
                                    msg_id, err
                                );
                                MAX_AGENT_RETRY_ATTEMPTS + 1
                            }
                        };
                        if retry_count > MAX_AGENT_RETRY_ATTEMPTS {
                            exhausted.push((msg_id.clone(), retry_count));
                            continue;
                        }
                        match coordinator_clone.re_enqueue_message(
                            &workspace_id_clone,
                            &session_id_for_cleanup,
                            msg_id,
                        ) {
                            Ok(()) => requeued_count += 1,
                            Err(re) => {
                                log::warn!(
                                    "[Workspace::handlers] Failed to re-enqueue message {} for retry: {}",
                                    msg_id, re
                                );
                            }
                        }
                    }
                }
                log::info!(
                    "[Workspace::handlers] Re-enqueued {} messages for agent {} retry (exhausted: {}, timed_out: {})",
                    requeued_count,
                    session_id_for_cleanup,
                    exhausted.len(),
                    timed_out
                );

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

                if requeued_count > 0 {
                    // 🔧 P0 修复：重试链修复——回填的消息必须有人消费。
                    // 保持 Running 并发 worker_ready（旧实现只在 Idle 时发 worker_ready，
                    // Failed 不发，回填消息永远无人消费）。
                    let _ = coordinator_clone.update_agent_status(
                        &workspace_id_clone,
                        &session_id_for_cleanup,
                        AgentStatus::Running,
                    );
                    let retry_payload = serde_json::json!({
                        "workspace_id": workspace_id_clone,
                        "agent_session_id": session_id_for_cleanup,
                        "skill_id": agent_skill_id,
                        "reminder": format!(
                            "上一次执行因错误中断（{}），任务消息已重新入队，请继续完成任务。",
                            truncate_chars(&e.to_string(), 200)
                        ),
                    });
                    if let Err(ee) = window_clone.emit(
                        crate::chat_v2::tools::workspace_executor::WORKSPACE_WORKER_READY_EVENT,
                        &retry_payload,
                    ) {
                        log::warn!(
                            "[Workspace::handlers] Failed to emit worker_ready for failure retry: {}",
                            ee
                        );
                    } else {
                        log::info!(
                            "[Workspace::handlers] Emitted worker_ready for failure retry: agent={}",
                            session_id_for_cleanup
                        );
                    }
                } else {
                    // 重试额度耗尽（或超时/无消息可回填）→ 终态 Failed
                    clear_no_message_retry_count(&session_id_for_cleanup);
                    let _ = coordinator_clone.update_agent_status(
                        &workspace_id_clone,
                        &session_id_for_cleanup,
                        AgentStatus::Failed,
                    );
                    if is_worker {
                        if let (Some(tm), Some(task)) = (task_manager.as_ref(), current_task.as_ref()) {
                            // 🔧 result_summary：存真实错误信息（截断），而非占位符
                            let error_summary =
                                truncate_chars(&e.to_string(), WORKER_RESULT_SUMMARY_MAX_CHARS);
                            if let Err(te) = tm.mark_failed(&task.id, Some(&error_summary)) {
                                log::warn!(
                                    "[Workspace::handlers] Failed to mark task failed: {:?}",
                                    te
                                );
                            }
                        }
                    }
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

    let stream_cancelled = chat_v2_state.cancel_stream(&agent_session_id);

    // 🔧 P0 修复：取消必须落库。查该 agent 的 pending/running 任务并置 Cancelled，
    // 否则任务停留 running，重启后被 workspace_restore_executions 当"中断任务"自动重跑。
    let mut task_cancelled = false;
    match coordinator.get_task_manager(&workspace_id) {
        Ok(task_manager) => match task_manager.get_agent_task(&agent_session_id) {
            Ok(Some(task)) => match task_manager.update_status(
                &task.id,
                SubagentTaskStatus::Cancelled,
                Some("user cancelled"),
            ) {
                Ok(()) => {
                    task_cancelled = true;
                    log::info!(
                        "[Workspace::handlers] Cancelled task {} for agent {}",
                        task.id,
                        agent_session_id
                    );
                }
                Err(e) => {
                    log::warn!(
                        "[Workspace::handlers] Failed to cancel task {} for agent {}: {:?}",
                        task.id,
                        agent_session_id,
                        e
                    );
                }
            },
            Ok(None) => {}
            Err(e) => {
                log::warn!(
                    "[Workspace::handlers] Failed to query task for cancel: agent={}, error={:?}",
                    agent_session_id,
                    e
                );
            }
        },
        Err(e) => {
            log::warn!(
                "[Workspace::handlers] Failed to get task manager for cancel: {}",
                e
            );
        }
    }

    let cancelled = stream_cancelled || task_cancelled;
    if cancelled {
        // 🔧 P0 修复：agent 状态用 Cancelled（而非 Idle），避免被当作可复用的空闲 agent
        clear_no_message_retry_count(&agent_session_id);
        let _ = coordinator.update_agent_status(
            &workspace_id,
            &agent_session_id,
            AgentStatus::Cancelled,
        );
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
    _chat_v2_state: State<'_, Arc<ChatV2State>>,
    _pipeline: State<'_, Arc<ChatV2Pipeline>>,
    _db: State<'_, Arc<ChatV2Database>>,
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
