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
    MAX_CONCURRENT_WORKERS, MAX_SUBAGENT_DEPTH, WORKER_PIPELINE_CANCEL_GRACE_SECS,
    WORKER_PIPELINE_TIMEOUT_SECS,
};
use crate::chat_v2::workspace::{
    AgentProfileResolver, AgentRole, AgentStatus, MessageType, SubagentTaskData,
    SubagentTaskStatus, WorkspaceCoordinator,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum AgentCompletionStatus {
    Completed,
    Failed,
    Cancelled,
}

/// Durable parent/child completion protocol. The same envelope is persisted as a
/// workspace Result message and emitted as `workspace_agent_completion`.
///
/// 注：`TokenUsage` 未派生 `Eq`，因此本结构体不再派生 `PartialEq, Eq`
/// （既有代码从不比较信封实例，测试只断言序列化后的 JSON）。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct AgentCompletionEnvelope {
    #[serde(rename = "type")]
    kind: String,
    workspace_id: String,
    agent_session_id: String,
    /// 派发该子代理的主代理（coordinator）会话 ID。
    /// 前端据此在主代理空闲时唤醒它处理完成结果（异步派发场景）。
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    task_id: Option<String>,
    run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    correlation_id: Option<String>,
    status: AgentCompletionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    final_output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    completed_at: String,
    /// 契约 C8：本次 run 的 token 归集（camelCase `TokenUsage` 对象）。
    /// 从 assistant 消息持久化的 meta 读取；读不到时省略。
    #[serde(skip_serializing_if = "Option::is_none")]
    token_usage: Option<crate::chat_v2::types::TokenUsage>,
}

impl AgentCompletionEnvelope {
    fn metadata(&self) -> serde_json::Value {
        // 结构体字段全部可序列化；万一未来字段变更引入不可序列化类型，
        // 降级为最小完成协议载荷而不是 panic 掉 command 线程。
        serde_json::to_value(self).unwrap_or_else(|e| {
            log::error!(
                "[Workspace] Failed to serialize completion envelope (run_id={}): {}",
                self.run_id,
                e
            );
            serde_json::json!({
                "type": self.kind,
                "workspace_id": self.workspace_id,
                "agent_session_id": self.agent_session_id,
                "run_id": self.run_id,
                "completed_at": self.completed_at,
            })
        })
    }
}

// ============================================================
// Worker 生命周期辅助（并发上限 / P38 重试计数 / 结果摘要）
// ============================================================

/// result_summary 最大字符数（按字符截断，非字节）。
///
/// 契约 C1：阻塞式 `subagent_call` 会把 `task.result_summary` 作为工具返回值
/// output 交回父代理，4000 字符是父上下文预算（成功与失败分支共用）。
const WORKER_RESULT_SUMMARY_MAX_CHARS: usize = 4000;

/// 按嵌套深度分池的 worker 管线并发信号量（懒初始化，进程级）。
///
/// 每层深度各有 `MAX_CONCURRENT_WORKERS` 个槽位。阻塞式 `subagent_call`
/// （wait=true）会让持有本层 permit 的父 worker 管线原地等待其子代理完成；
/// 若父子共用同一个池，4 个父辈可以占满全部槽位互相等待各自的子代理排队，
/// 形成调度饥饿（750s 等待预算兜底后才能解开）。按深度分池后，深度 n 的
/// worker 只会等待深度 n+1 的池，资源获取严格按深度排序，环等待不可能成立。
static WORKER_PIPELINE_SEMAPHORES: std::sync::OnceLock<Vec<tokio::sync::Semaphore>> =
    std::sync::OnceLock::new();

fn worker_pipeline_semaphore_for_depth(depth: u32) -> &'static tokio::sync::Semaphore {
    let pools = WORKER_PIPELINE_SEMAPHORES.get_or_init(|| {
        (0..MAX_SUBAGENT_DEPTH)
            .map(|_| tokio::sync::Semaphore::new(MAX_CONCURRENT_WORKERS))
            .collect()
    });
    // worker 的 subagent_depth 从 1 开始；0（缺失/legacy 行）与超界值夹取到有效层
    let index = depth.clamp(1, MAX_SUBAGENT_DEPTH) as usize - 1;
    &pools[index]
}

/// 读取 worker 会话的嵌套深度（仅用于调度池选择）。
///
/// 读取失败回退深度 1：这只是调度分层依据，不承担安全语义（深度上限的
/// fail-closed 检查在创建路径上，见 subagent_executor / workspace_executor）。
fn worker_depth_for_scheduling(db: &ChatV2Database, agent_session_id: &str) -> u32 {
    let depth = db
        .get_conn_safe()
        .ok()
        .and_then(|conn| {
            crate::chat_v2::repo::ChatV2Repo::get_session_with_conn(&conn, agent_session_id)
                .ok()
                .flatten()
        })
        .and_then(|session| session.metadata)
        .and_then(|m| m.get("subagent_depth").and_then(|v| v.as_u64()))
        .map(|d| d as u32)
        .unwrap_or(1);
    if depth == 0 {
        1
    } else {
        depth
    }
}

/// drain-then-fail 守卫：`drain_inbox` 之后、异步管线 spawn 之前的任何错误返回
/// 路径都必须先把已 drain 的消息回补到 inbox（inbox 已标 processed，不回补即
/// 永久丢失）。回补失败时发工作区警告，并把失败信息注解进返回的错误串。
fn fail_with_drained_rollback(
    coordinator: &WorkspaceCoordinator,
    workspace_id: &str,
    agent_session_id: &str,
    drained_message_ids: &[String],
    error: String,
) -> String {
    let mut rollback_failures: Vec<String> = Vec::new();
    for message_id in drained_message_ids {
        if let Err(e) = coordinator.re_enqueue_message(workspace_id, agent_session_id, message_id) {
            let detail = format!("message_id={}, error={}", message_id, e);
            rollback_failures.push(detail.clone());
            log::error!(
                "[Workspace::handlers] Failed to re-enqueue drained message on aborted run: agent_session_id={}, {}",
                agent_session_id,
                detail
            );
        }
    }
    if rollback_failures.is_empty() {
        return error;
    }
    coordinator.emit_warning(crate::chat_v2::workspace::emitter::WorkspaceWarningEvent {
        workspace_id: workspace_id.to_string(),
        code: "run_agent_requeue_failed".to_string(),
        message: format!(
            "Worker run for {} aborted ({}), and {} drained message(s) could not be re-queued. Please retry the task manually.",
            agent_session_id,
            error,
            rollback_failures.len()
        ),
        agent_session_id: Some(agent_session_id.to_string()),
        message_id: drained_message_ids.first().cloned(),
        retry_count: None,
        max_retries: None,
    });
    format!(
        "{} ({} drained message(s) additionally failed to restore to the inbox; please retry manually)",
        error,
        rollback_failures.len()
    )
}

/// 按字符（非字节）截断文本，避免多字节字符边界 panic
fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let truncated: String = text.chars().take(max_chars).collect();
    format!("{}…", truncated)
}

fn resolve_profile_skill_snapshot(
    skill_ids: &[String],
    metadata: Option<&serde_json::Value>,
) -> Result<std::collections::HashMap<String, String>, String> {
    if skill_ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let available: std::collections::HashMap<String, String> = metadata
        .and_then(|value| value.get("profile_skill_contents"))
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| format!("Invalid persisted persona skill snapshot: {}", error))?
        .unwrap_or_default();
    let mut selected = std::collections::HashMap::new();
    let mut missing = Vec::new();
    for skill_id in skill_ids {
        match available.get(skill_id) {
            Some(content) => {
                selected.insert(skill_id.clone(), content.clone());
            }
            None => missing.push(skill_id.clone()),
        }
    }
    if !missing.is_empty() {
        return Err(format!(
            "Persisted persona skill snapshot is missing [{}]; refusing to run with silently ignored skills",
            missing.join(", ")
        ));
    }
    Ok(selected)
}

/// 提取子代理最终 assistant 消息的 content 块文本并截断，供 result_summary 使用
/// （逻辑参考 headless.rs 的 summarize_assistant_message）。
fn summarize_worker_assistant_message(
    db: &ChatV2Database,
    assistant_message_id: &str,
) -> Option<String> {
    worker_assistant_output(db, assistant_message_id)
        .map(|output| truncate_chars(&output, WORKER_RESULT_SUMMARY_MAX_CHARS))
}

/// 读取 worker 的完整最终输出。Runtime completion 使用完整内容，任务表中的
/// result_summary 仍单独截断，避免把展示层限制带入父子线程协议。
fn worker_assistant_output(db: &ChatV2Database, assistant_message_id: &str) -> Option<String> {
    let blocks =
        crate::chat_v2::repo::ChatV2Repo::get_message_blocks_v2(db, assistant_message_id).ok()?;
    if let Some(result) = blocks.iter().rev().find_map(|block| {
        if block.status != crate::chat_v2::types::block_status::SUCCESS
            || !block
                .tool_name
                .as_deref()
                .is_some_and(crate::chat_v2::tools::attempt_completion::is_attempt_completion)
        {
            return None;
        }
        block
            .tool_output
            .as_ref()?
            .get("result")?
            .as_str()
            .map(str::trim)
            .filter(|result| !result.is_empty())
            .map(str::to_string)
    }) {
        return Some(result);
    }
    let output = blocks
        .iter()
        .filter(|b| b.block_type == "content")
        .filter_map(|b| b.content.as_deref())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    (!output.is_empty()).then_some(output)
}

/// 契约 C8：读取 worker assistant 消息持久化的 token usage。
///
/// 数据事实（读取路径）：流式完成后管线把 usage 写进
/// `chat_v2_messages.meta_json`（`MessageMeta.usage`，见
/// pipeline/persistence.rs 的 save_results 与 repo.rs 的
/// `update_message_meta_with_conn`）。多变体模式下 usage 挂在变体上
/// （`Variant.usage`）：消息级读不到时回退激活变体，再退任何带 usage 的变体。
///
/// `pub(crate)`：subagent_executor 的阻塞等待路径复用同一实现按 run_id
/// （= assistant 消息 ID）读取，避免复制。
pub(crate) fn worker_message_usage(
    db: &ChatV2Database,
    assistant_message_id: &str,
) -> Option<crate::chat_v2::types::TokenUsage> {
    let message =
        crate::chat_v2::repo::ChatV2Repo::get_message_v2(db, assistant_message_id).ok()??;
    if let Some(usage) = message.meta.as_ref().and_then(|meta| meta.usage.clone()) {
        return Some(usage);
    }
    let variants = message.variants.as_ref()?;
    let active_id = message.active_variant_id.as_deref();
    variants
        .iter()
        .find(|variant| active_id == Some(variant.id.as_str()))
        .and_then(|variant| variant.usage.clone())
        .or_else(|| variants.iter().find_map(|variant| variant.usage.clone()))
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

/// 🆕 B2（一键断电）：把所有已加载工作区中仍处于活跃态（Running/Queued/Interrupted）
/// 的 worker 标记为 Cancelled，并把 pending/running 子代理任务一并置 Cancelled。
///
/// 供 `kill_switch::chat_v2_emergency_stop` 调用（streams 已由
/// `ChatV2State::cancel_all_streams` 统一取消，这里只负责状态落库，防止重启
/// restore 把它们当"中断任务"复活）。返回被置为 Cancelled 的 worker 数量。
pub fn mark_all_workers_cancelled(
    coordinator: &WorkspaceCoordinator,
    chat_v2_state: &ChatV2State,
    reason: &str,
) -> usize {
    let mut cancelled_workers = 0usize;
    for workspace_id in coordinator.loaded_workspace_ids() {
        match coordinator.list_agents(&workspace_id) {
            Ok(agents) => {
                for agent in agents
                    .iter()
                    .filter(|a| matches!(a.role, AgentRole::Worker))
                {
                    // 兜底：个别流可能在 cancel_all_streams 之后才注册
                    let stream_cancelled = chat_v2_state.cancel_stream(&agent.session_id);
                    let is_active = matches!(
                        agent.status,
                        AgentStatus::Running | AgentStatus::Queued | AgentStatus::Interrupted
                    );
                    if !(is_active || stream_cancelled) {
                        continue;
                    }
                    match coordinator.update_agent_status(
                        &workspace_id,
                        &agent.session_id,
                        AgentStatus::Cancelled,
                    ) {
                        Ok(()) => {
                            cancelled_workers += 1;
                            log::info!(
                                "[Workspace::handlers] mark_all_workers_cancelled ({}): workspace={}, agent={}, prev_status={:?}",
                                reason,
                                workspace_id,
                                agent.session_id,
                                agent.status
                            );
                        }
                        Err(e) => {
                            log::warn!(
                                "[Workspace::handlers] Failed to cancel worker {} in {} ({}): {}",
                                agent.session_id,
                                workspace_id,
                                reason,
                                e
                            );
                        }
                    }
                }
            }
            Err(e) => {
                log::warn!(
                    "[Workspace::handlers] mark_all_workers_cancelled: failed to list agents for {} ({}): {}",
                    workspace_id,
                    reason,
                    e
                );
            }
        }

        // pending/running 任务同样置 Cancelled，与 cancel_workspace_active_workers 一致
        if let Ok(task_manager) = coordinator.get_task_manager(&workspace_id) {
            if let Ok(tasks) = task_manager.get_tasks_to_restore() {
                for task in tasks {
                    if let Err(e) = task_manager.update_status(
                        &task.id,
                        SubagentTaskStatus::Cancelled,
                        Some(reason),
                    ) {
                        log::warn!(
                            "[Workspace::handlers] Failed to cancel task {} in {} ({}): {:?}",
                            task.id,
                            workspace_id,
                            reason,
                            e
                        );
                    }
                }
            }
        }
    }
    cancelled_workers
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
    /// agent metadata 中持久化的 AgentProfile id（worker/explorer/自定义名）；
    /// legacy 行（无 agent_profile 键）为 None，前端回退显示 skill_id
    pub agent_profile_id: Option<String>,
    /// 🆕 契约 C12：该 agent inbox 中未消费（unread）的消息数；查询失败按 0
    pub pending_inbox_count: usize,
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
    chat_v2_state: State<'_, Arc<ChatV2State>>,
    pipeline: State<'_, Arc<ChatV2Pipeline>>,
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

    // Worker + initial task: backend runtime owns dispatch. The event remains an
    // observation signal for legacy UI consumers.
    if is_worker && has_initial_task {
        use tauri::Emitter;
        let run = run_workspace_agent_backend(
            RunAgentRequest {
                workspace_id: request.workspace_id.clone(),
                agent_session_id: agent_session_id.clone(),
                requester_session_id: request.requester_session_id.clone(),
                reminder: None,
            },
            window.clone(),
            coordinator.inner().clone(),
            chat_v2_state.inner().clone(),
            pipeline.inner().clone(),
            db.inner().clone(),
        )
        .await?;
        let event_payload = serde_json::json!({
            "workspace_id": request.workspace_id,
            "agent_session_id": agent_session_id,
            "skill_id": request.skill_id,
            "run_id": run.message_id,
            "runtime_managed": true,
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
        .map(|a| {
            let agent_profile_id = AgentProfileResolver::from_metadata(a.metadata.as_ref())
                .ok()
                .flatten()
                .map(|profile| profile.id);
            // 🆕 契约 C12：每 agent 一次 count 查询（agent 数上限 10，可接受）；
            // 查询失败按 0，不阻断列表返回
            let pending_inbox_count = coordinator
                .pending_inbox_count(&workspace_id, &a.session_id)
                .unwrap_or(0);
            AgentInfo {
                session_id: a.session_id,
                role: format!("{:?}", a.role).to_lowercase(),
                status: format!("{:?}", a.status).to_lowercase(),
                skill_id: a.skill_id,
                agent_profile_id,
                pending_inbox_count,
                joined_at: a.joined_at.to_rfc3339(),
                last_active_at: a.last_active_at.to_rfc3339(),
            }
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
    for w in workspaces.flatten() {
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
    run_workspace_agent_backend(
        request,
        window,
        coordinator.inner().clone(),
        chat_v2_state.inner().clone(),
        pipeline.inner().clone(),
        db.inner().clone(),
    )
    .await
}

/// Runtime-native worker entry point. This is deliberately independent from the
/// `workspace_worker_ready` frontend event: tools, restore code and Tauri commands
/// all enter the same scheduler path.
pub async fn run_workspace_agent_backend(
    request: RunAgentRequest,
    window: Window,
    coordinator: Arc<WorkspaceCoordinator>,
    chat_v2_state: Arc<ChatV2State>,
    pipeline: Arc<ChatV2Pipeline>,
    db: Arc<ChatV2Database>,
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
    if matches!(agent.status, AgentStatus::Running | AgentStatus::Queued)
        && chat_v2_state.has_active_stream(agent_session_id)
    {
        return Ok(RunAgentResponse {
            agent_session_id: agent_session_id.clone(),
            message_id: String::new(),
            status: format!("{:?}", agent.status).to_lowercase(),
        });
    }

    // Acquire execution capacity before touching the durable inbox, stream registry,
    // or externally visible Running state. A queued worker must not consume input or
    // masquerade as running while it is still waiting for scheduler capacity.
    coordinator.update_agent_status(workspace_id, agent_session_id, AgentStatus::Queued)?;
    // 按嵌套深度选择调度池：父 worker 阻塞等待子代理时（subagent_call wait=true），
    // 父子位于不同深度的池，父辈占满本层槽位不会阻塞子代理起跑。
    let worker_depth = worker_depth_for_scheduling(&db, agent_session_id);
    let permit = worker_pipeline_semaphore_for_depth(worker_depth)
        .acquire()
        .await
        .map_err(|_| "Worker scheduler is unavailable".to_string())?;

    // 🆕 排队取消检查：permit 等待期间用户可能已取消/关闭该 agent。
    // 此时不 drain、不覆盖状态，直接释放 permit 返回 cancelled。
    if let Some(current) = coordinator.get_agent(workspace_id, agent_session_id)? {
        if matches!(current.status, AgentStatus::Cancelled | AgentStatus::Closed) {
            log::info!(
                "[Workspace::handlers] [RUN_AGENT] Agent {} was {:?} while queued, skipping run",
                agent_session_id,
                current.status
            );
            drop(permit);
            return Ok(RunAgentResponse {
                agent_session_id: agent_session_id.clone(),
                message_id: String::new(),
                status: "cancelled".to_string(),
            });
        }
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
            let _ =
                coordinator.update_agent_status(workspace_id, agent_session_id, AgentStatus::Idle);
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
    // 避免 drain 后因并发流冲突直接返回导致消息丢失：统一走 drain 回滚守卫
    let stream_registration = match chat_v2_state.try_register_stream_owned(agent_session_id) {
        Ok(registration) => registration,
        Err(()) => {
            return Err(fail_with_drained_rollback(
                &coordinator,
                workspace_id,
                agent_session_id,
                &original_message_ids,
                "Agent has an active stream. Please wait for completion.".to_string(),
            ));
        }
    };
    let stream_generation = stream_registration.generation();
    let cancel_token = stream_registration.token().clone();
    // Create the guard before the remaining fallible setup. Early `?` returns now release exactly
    // this generation, while a late worker cleanup cannot delete an immediate replacement run.
    let stream_guard = StreamGuard::new(
        chat_v2_state.clone(),
        agent_session_id.clone(),
        stream_registration,
    );

    // 5. 更新 Agent 状态为 Running
    coordinator
        .update_agent_status(workspace_id, agent_session_id, AgentStatus::Running)
        .map_err(|e| {
            fail_with_drained_rollback(
                &coordinator,
                workspace_id,
                agent_session_id,
                &original_message_ids,
                e,
            )
        })?;

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

    // 6. 解析运行时配置：优先消费 agent metadata 中持久化的 AgentProfile，
    // 解析失败时 log warn 并回退 legacy 路径（session metadata 的
    // system_prompt / recommended_models），不 hard fail。
    let runtime_config = match AgentProfileResolver::runtime_config_for_agent(agent) {
        Ok(config) => Some(config),
        Err(error) => {
            log::warn!(
                "[Workspace::handlers] Failed to resolve agent profile for {}, falling back to legacy session metadata: {}",
                agent_session_id,
                error
            );
            None
        }
    };
    // 只有 agent metadata 里真的持久化了 agent_profile 键时，系统提示词才
    // 由 profile 接管；legacy 行（仅 skill_id 回退出来的 worker profile）
    // 继续用 session metadata 里的技能 system_prompt。
    let has_persisted_profile = matches!(
        AgentProfileResolver::from_metadata(agent.metadata.as_ref()),
        Ok(Some(_))
    );

    let conn = db
        .get_conn_safe()
        .map_err(|e| format!("Failed to get db connection: {}", e))
        .map_err(|e| {
            fail_with_drained_rollback(
                &coordinator,
                workspace_id,
                agent_session_id,
                &original_message_ids,
                e,
            )
        })?;
    let session = crate::chat_v2::repo::ChatV2Repo::get_session_with_conn(&conn, agent_session_id)
        .map_err(|e| format!("Failed to get agent session: {}", e))
        .and_then(|session| {
            session.ok_or_else(|| format!("Agent session not found: {}", agent_session_id))
        })
        .map_err(|e| {
            fail_with_drained_rollback(
                &coordinator,
                workspace_id,
                agent_session_id,
                &original_message_ids,
                e,
            )
        })?;

    let legacy_system_prompt = session
        .metadata
        .as_ref()
        .and_then(|m| m.get("system_prompt"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let profile_skill_contents = if has_persisted_profile {
        let skill_ids = runtime_config
            .as_ref()
            .map(|config| config.skill_ids.as_slice())
            .unwrap_or(&[]);
        resolve_profile_skill_snapshot(skill_ids, session.metadata.as_ref()).map_err(|error| {
            fail_with_drained_rollback(
                &coordinator,
                workspace_id,
                agent_session_id,
                &original_message_ids,
                error,
            )
        })?
    } else {
        std::collections::HashMap::new()
    };
    let profile_skill_ids = if has_persisted_profile {
        runtime_config
            .as_ref()
            .map(|config| config.skill_ids.clone())
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let profile_reasoning_effort = if has_persisted_profile {
        runtime_config
            .as_ref()
            .and_then(|config| config.reasoning_effort.as_ref())
            .map(|effort| effort.as_str().to_string())
    } else {
        None
    };

    let system_prompt = match (&runtime_config, has_persisted_profile) {
        (Some(config), true) => {
            let workspace_name = coordinator
                .get_workspace(workspace_id)
                .ok()
                .flatten()
                .and_then(|w| w.name)
                .unwrap_or_else(|| workspace_id.chars().take(8).collect());
            Some(format!(
                "{}\n\n# 工作区协作环境\n- 工作区名称: {}\n- 工作区 ID: {}\n\n最终回答会由运行时自动交付给主代理；workspace_send 仅用于进度、提问或中间协作。",
                config.system_instructions, workspace_name, workspace_id
            ))
        }
        _ => legacy_system_prompt,
    };

    // 获取 Skill 推荐的模型（legacy 回退：优先使用第一个）
    let recommended_model = session
        .metadata
        .as_ref()
        .and_then(|m| m.get("recommended_models"))
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    // 模型：profile 的 model_id（Some 时优先）→ recommended_models[0] 回退
    let selected_model = runtime_config
        .as_ref()
        .and_then(|config| config.model_id.clone())
        .or(recommended_model);
    let parent_session_id = session
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("parent_session_id"))
        .and_then(|value| value.as_str())
        .map(str::to_string);

    if let Some(ref model) = selected_model {
        log::info!(
            "[Workspace::handlers] Using model: {} for agent: {}",
            model,
            agent_session_id
        );
    }

    // 7. 构建 SendMessageRequest
    // Worker collaboration tools. Final completion is delivered by the runtime;
    // workspace_send remains available for progress, questions and intermediate data.
    use crate::chat_v2::types::McpToolSchema;
    let workspace_tool_schemas = vec![
        McpToolSchema {
            name: "builtin-workspace_send".to_string(),
            server_id: None,
            description: Some(
                "向工作区发送进度、问题或中间协作消息。最终结果由运行时自动交付。".to_string(),
            ),
            input_schema: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "workspace_id": {
                        "type": "string",
                        "description": "工作区 ID（必需，从任务消息中获取）"
                    },
                    "content": {
                        "type": "string",
                        "description": "消息内容"
                    },
                    "message_type": {
                        "type": "string",
                        "enum": ["result", "progress", "query"],
                        "description": "消息类型"
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
                        "enum": ["agents", "messages", "documents", "context", "tasks", "all"],
                        "description": "查询类型（tasks=后台子代理任务状态）"
                    }
                },
                "required": ["workspace_id"]
            })),
        },
    ];

    // 🆕 工具面（fail-closed，参考 headless.rs 的双层防线）：
    // - 基座：上面两个本地 workspace schema（workspace_send/query 不重复注入）；
    // - profile 存在时：从 headless 只读 schema 集中按 profile.allowed_tools
    //   精确匹配追加 schema，执行层白名单取 profile.allowed_tools 全集；
    // - profile 缺失（解析失败回退 legacy）时：维持现状只放行两个 workspace 工具。
    let mut workspace_tool_schemas = workspace_tool_schemas;
    let worker_allowed_tools: Vec<String> = match runtime_config.as_ref() {
        Some(config) => {
            for schema in crate::chat_v2::headless::headless_tool_schemas() {
                if config.allowed_tools.iter().any(|tool| *tool == schema.name)
                    && !workspace_tool_schemas
                        .iter()
                        .any(|existing| existing.name == schema.name)
                {
                    workspace_tool_schemas.push(schema);
                }
            }
            config.allowed_tools.clone()
        }
        None => workspace_tool_schemas
            .iter()
            .map(|schema| schema.name.clone())
            .collect(),
    };

    let assistant_message_id = ChatMessage::generate_id();
    let send_request = ChatSendMessageRequest {
        session_id: agent_session_id.clone(),
        content,
        user_context_refs: None,
        path_map: None,
        workspace_id: Some(workspace_id.clone()),
        options: Some(SendOptions {
            system_prompt_override: system_prompt,
            // profile.model_id 优先，legacy recommended_models[0] 回退
            model_id: selected_model,
            // Persona model references are exact config ids. The context compiler
            // must fail instead of selecting another local/cloud configuration.
            strict_model_id: has_persisted_profile
                && runtime_config
                    .as_ref()
                    .is_some_and(|config| config.model_id.is_some()),
            reasoning_effort: profile_reasoning_effort,
            // Worker 默认禁用 RAG 等检索功能
            rag_enabled: Some(false),
            graph_rag_enabled: Some(false),
            memory_enabled: Some(false),
            // Workspace tools are collaborative capabilities, not completion protocol.
            mcp_tool_schemas: Some(workspace_tool_schemas),
            // 🆕 执行层 fail-closed：白名单外的调用在审批/执行前被直接拦截
            execution_allowed_tools: Some(worker_allowed_tools),
            active_skill_ids: (!profile_skill_ids.is_empty()).then_some(profile_skill_ids),
            skill_contents: (!profile_skill_contents.is_empty()).then_some(profile_skill_contents),
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
    let pipeline_clone = pipeline.clone();
    let chat_v2_state_clone = chat_v2_state.clone();
    let coordinator_clone = coordinator.clone();
    let db_clone = db.clone();
    let assistant_message_id_for_task = assistant_message_id.clone();
    let agent_skill_id = agent.skill_id.clone();
    let parent_session_id_for_task = parent_session_id.clone();

    // 🆕 P1修复：使用 TaskTracker 追踪异步任务
    chat_v2_state.spawn_tracked(async move {
        use tauri::Emitter;

        let stream_guard = stream_guard;

        // 🆕 整体超时：pipeline 包 wall-clock 上限（对齐 headless），
        // 超时后触发取消并给管线一个收尾窗口保存部分结果。
        let result = {
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
                    let final_output = worker_assistant_output(
                        &db_clone,
                        &assistant_message_id_for_task,
                    )
                    .unwrap_or_default();
                    let summary = summarize_worker_assistant_message(
                        &db_clone,
                        &assistant_message_id_for_task,
                    )
                    .unwrap_or_else(|| "Task completed successfully".to_string());
                    let task_id = current_task.as_ref().map(|task| task.id.clone());
                    let correlation_id = original_message_ids.first().cloned();
                    let completed_at = chrono::Utc::now().to_rfc3339();
                    let completion = AgentCompletionEnvelope {
                        kind: "agent_completion".to_string(),
                        workspace_id: workspace_id_clone.clone(),
                        agent_session_id: session_id_for_cleanup.clone(),
                        parent_session_id: parent_session_id_for_task.clone(),
                        task_id,
                        run_id: assistant_message_id_for_task.clone(),
                        correlation_id,
                        status: AgentCompletionStatus::Completed,
                        final_output: Some(final_output),
                        error: None,
                        completed_at,
                        token_usage: worker_message_usage(
                            &db_clone,
                            &assistant_message_id_for_task,
                        ),
                    };
                    let completion_metadata = completion.metadata();

                    // The runtime owns completion delivery. The model may still use
                    // workspace_send for progress, but correctness never depends on it.
                    match coordinator_clone.send_message(
                        &workspace_id_clone,
                        &session_id_for_cleanup,
                        parent_session_id_for_task.as_deref(),
                        MessageType::Result,
                        serde_json::to_string(&completion).unwrap_or_default(),
                    ) {
                        Ok(message) => {
                            if let Err(error) = coordinator_clone.update_message_metadata(
                                &workspace_id_clone,
                                &message.id,
                                &completion_metadata,
                            ) {
                                log::warn!(
                                    "[Workspace::handlers] Failed to persist completion metadata: {}",
                                    error
                                );
                            }
                        }
                        Err(error) => log::error!(
                            "[Workspace::handlers] Failed to deliver runtime completion: {}",
                            error
                        ),
                    }
                    let _ = coordinator_clone.update_agent_status(
                        &workspace_id_clone,
                        &session_id_for_cleanup,
                        AgentStatus::Completed,
                    );
                    if let (Some(tm), Some(task)) = (task_manager.as_ref(), current_task.as_ref()) {
                        if let Err(error) = tm.mark_completed(&task.id, Some(&summary)) {
                            log::warn!(
                                "[Workspace::handlers] Failed to mark task completed: {:?}",
                                error
                            );
                        }
                    }
                    let _ = window_clone.emit("workspace_agent_completion", &completion);
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
                let completion = AgentCompletionEnvelope {
                    kind: "agent_completion".to_string(),
                    workspace_id: workspace_id_clone.clone(),
                    agent_session_id: session_id_for_cleanup.clone(),
                    parent_session_id: parent_session_id_for_task.clone(),
                    task_id: current_task.as_ref().map(|task| task.id.clone()),
                    run_id: assistant_message_id_for_task.clone(),
                    correlation_id: original_message_ids.first().cloned(),
                    status: AgentCompletionStatus::Cancelled,
                    final_output: None,
                    error: Some("execution cancelled".to_string()),
                    completed_at: chrono::Utc::now().to_rfc3339(),
                    // 取消时尽力读取（部分轮次可能已持久化 usage），读不到为 None
                    token_usage: worker_message_usage(&db_clone, &assistant_message_id_for_task),
                };
                let completion_metadata = completion.metadata();
                if let Ok(message) = coordinator_clone.send_message(
                    &workspace_id_clone,
                    &session_id_for_cleanup,
                    parent_session_id_for_task.as_deref(),
                    MessageType::Result,
                    serde_json::to_string(&completion).unwrap_or_default(),
                ) {
                    let _ = coordinator_clone.update_message_metadata(
                        &workspace_id_clone,
                        &message.id,
                        &completion_metadata,
                    );
                }
                let _ = window_clone.emit("workspace_agent_completion", &completion);
            }
            Err(e) => {
                log::error!(
                    "[Workspace::handlers] Agent pipeline error: agent={}, error={}",
                    session_id,
                    e
                );

                let error_summary =
                    truncate_chars(&e.to_string(), WORKER_RESULT_SUMMARY_MAX_CHARS);
                let _ = coordinator_clone.update_agent_status(
                    &workspace_id_clone,
                    &session_id_for_cleanup,
                    AgentStatus::Failed,
                );
                if let (Some(tm), Some(task)) = (task_manager.as_ref(), current_task.as_ref()) {
                    if let Err(task_error) = tm.mark_failed(&task.id, Some(&error_summary)) {
                        log::warn!(
                            "[Workspace::handlers] Failed to mark task failed: {:?}",
                            task_error
                        );
                    }
                }
                let completion = AgentCompletionEnvelope {
                    kind: "agent_completion".to_string(),
                    workspace_id: workspace_id_clone.clone(),
                    agent_session_id: session_id_for_cleanup.clone(),
                    parent_session_id: parent_session_id_for_task.clone(),
                    task_id: current_task.as_ref().map(|task| task.id.clone()),
                    run_id: assistant_message_id_for_task.clone(),
                    correlation_id: original_message_ids.first().cloned(),
                    status: AgentCompletionStatus::Failed,
                    final_output: None,
                    error: Some(error_summary),
                    completed_at: chrono::Utc::now().to_rfc3339(),
                    // 失败时尽力读取（部分轮次可能已持久化 usage），读不到为 None
                    token_usage: worker_message_usage(&db_clone, &assistant_message_id_for_task),
                };
                let completion_metadata = completion.metadata();
                if let Ok(message) = coordinator_clone.send_message(
                    &workspace_id_clone,
                    &session_id_for_cleanup,
                    parent_session_id_for_task.as_deref(),
                    MessageType::Result,
                    serde_json::to_string(&completion).unwrap_or_default(),
                ) {
                    let _ = coordinator_clone.update_message_metadata(
                        &workspace_id_clone,
                        &message.id,
                        &completion_metadata,
                    );
                }
                let _ = window_clone.emit("workspace_agent_completion", &completion);
            }
        }
    });

    Ok(RunAgentResponse {
        agent_session_id: agent_session_id.clone(),
        message_id: assistant_message_id,
        status: "running".to_string(),
    })
}

/// 取消 Worker Agent 执行（手动中止）——薄壳：权限校验后委托后端取消函数
#[tauri::command]
pub async fn workspace_cancel_agent(
    coordinator: State<'_, Arc<WorkspaceCoordinator>>,
    chat_v2_state: State<'_, Arc<ChatV2State>>,
    session_id: String,
    workspace_id: String,
    agent_session_id: String,
) -> Result<bool, String> {
    coordinator.ensure_member_or_creator(&workspace_id, &session_id)?;
    cancel_workspace_agent_core(
        &workspace_id,
        &agent_session_id,
        coordinator.inner().as_ref(),
        chat_v2_state.inner().as_ref(),
    )
}

/// 契约 C5：后端取消入口，供 subagent_executor 的阻塞等待路径调用。
/// 不做权限校验（调用方是受信任的后端运行时）；事件通过 coordinator 自带的
/// emitter 通路发出，不依赖 window。
/// 签名保持 async 以稳定跨模块契约（内部当前无 await）。
#[allow(clippy::unused_async)]
pub async fn cancel_workspace_agent_backend(
    workspace_id: &str,
    agent_session_id: &str,
    coordinator: Arc<WorkspaceCoordinator>,
    chat_v2_state: Arc<ChatV2State>,
) -> Result<(), String> {
    cancel_workspace_agent_core(
        workspace_id,
        agent_session_id,
        coordinator.as_ref(),
        chat_v2_state.as_ref(),
    )
    .map(|_| ())
}

/// 取消核心逻辑：取消活跃流、把 pending/running 任务置 Cancelled、agent 状态落库。
/// 返回是否实际取消了任何东西（流或任务）。
fn cancel_workspace_agent_core(
    workspace_id: &str,
    agent_session_id: &str,
    coordinator: &WorkspaceCoordinator,
    chat_v2_state: &ChatV2State,
) -> Result<bool, String> {
    let stream_cancelled = chat_v2_state.cancel_stream(agent_session_id);

    // 🔧 P0 修复：取消必须落库。查该 agent 的 pending/running 任务并置 Cancelled，
    // 否则任务停留 running，重启后被 workspace_restore_executions 当"中断任务"自动重跑。
    let mut task_cancelled = false;
    match coordinator.get_task_manager(workspace_id) {
        Ok(task_manager) => match task_manager.get_agent_task(agent_session_id) {
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
        let _ =
            coordinator.update_agent_status(workspace_id, agent_session_id, AgentStatus::Cancelled);
        coordinator.emit_warning(crate::chat_v2::workspace::emitter::WorkspaceWarningEvent {
            workspace_id: workspace_id.to_string(),
            code: "agent_cancelled".to_string(),
            message: format!("Agent {} execution cancelled by user", agent_session_id),
            agent_session_id: Some(agent_session_id.to_string()),
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

    // 2. Resume each task through the backend runtime. worker_ready is emitted only
    // after dispatch and is no longer a startup mechanism.
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
            let reminder =
                running_without_inbox.then(|| "继续执行上次中断任务（恢复）".to_string());
            match run_workspace_agent_backend(
                RunAgentRequest {
                    workspace_id: workspace_id.clone(),
                    agent_session_id: task.agent_session_id.clone(),
                    requester_session_id: session_id.clone(),
                    reminder: reminder.clone(),
                },
                window.clone(),
                coordinator.inner().clone(),
                chat_v2_state.inner().clone(),
                pipeline.inner().clone(),
                db.inner().clone(),
            )
            .await
            {
                Ok(_) => restored_agent_ids.push(task.agent_session_id.clone()),
                Err(error) => {
                    log::warn!(
                        "[Workspace::handlers] Failed to restore worker through backend runtime: session={}, error={}",
                        task.agent_session_id,
                        error
                    );
                    continue;
                }
            }
            let event_payload = serde_json::json!({
                "workspace_id": workspace_id,
                "agent_session_id": task.agent_session_id,
                "skill_id": task.skill_id,
                "restored": true,
                "reminder": reminder,
                "runtime_managed": true,
            });

            if let Err(e) = window.emit(
                crate::chat_v2::tools::workspace_executor::WORKSPACE_WORKER_READY_EVENT,
                &event_payload,
            ) {
                log::warn!(
                    "[Workspace::handlers] Failed to emit worker_ready for restore: session={}, error={}",
                    task.agent_session_id, e
                );
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

// ============================================================
// 子代理档案管理（设置页管理入口）
// ============================================================

/// 内建子代理档案的列表摘要。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfileSummary {
    pub id: String,
    pub description: Option<String>,
    pub model: Option<String>,
    pub tool_count: usize,
}

/// 单个自定义档案文件的列表摘要（含加载器会跳过的非法文件，供设置页修复）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomAgentFileSummary {
    pub file_name: String,
    pub bytes: u64,
    /// RFC3339 修改时间（stat 失败时为 None）。
    pub modified_at: Option<String>,
    /// frontmatter 宽容解析结果（文件非法时也尽量给出）。
    pub name: Option<String>,
    pub description: Option<String>,
    pub base: Option<String>,
    pub model: Option<String>,
    /// fail-closed 解析成功时的工具数。
    pub tool_count: Option<usize>,
    /// 加载器是否会接受该文件（false = 定义非法，运行时被跳过）。
    pub valid: bool,
    /// 是否实际生效（valid 且同名档案中按文件名排序先加载者）。
    pub active: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListAgentProfilesResponse {
    pub builtin: Vec<AgentProfileSummary>,
    pub custom_files: Vec<CustomAgentFileSummary>,
    /// 自定义档案目录（`{workspaces_dir}/agents`）的绝对路径。
    pub agents_dir: String,
}

/// 列出全部子代理档案：内建三型 + `{workspaces_dir}/agents/*.md` 自定义档案。
///
/// 目录不存在时 best-effort 创建（失败仅 warn，不阻塞列表返回），
/// 以便前端"打开档案目录"按钮始终有目录可揭示。
#[tauri::command]
pub async fn workspace_list_agent_profiles(
    coordinator: State<'_, Arc<WorkspaceCoordinator>>,
) -> Result<ListAgentProfilesResponse, String> {
    use crate::chat_v2::workspace::agent_profile::{
        DEFAULT_PROFILE_ID, EXPLORER_PROFILE_ID, WORKER_PROFILE_ID,
    };

    let agents_dir = coordinator.custom_agents_dir();
    if let Err(e) = std::fs::create_dir_all(&agents_dir) {
        log::warn!(
            "[Workspace::handlers] Failed to ensure custom agents dir {}: {}",
            agents_dir.display(),
            e
        );
    }

    let builtin: Vec<AgentProfileSummary> =
        [DEFAULT_PROFILE_ID, WORKER_PROFILE_ID, EXPLORER_PROFILE_ID]
            .iter()
            .filter_map(|id| AgentProfileResolver::built_in(id))
            .map(|profile| AgentProfileSummary {
                id: profile.id.clone(),
                description: profile.description.clone(),
                model: profile.model.clone(),
                tool_count: profile.allowed_tools.len(),
            })
            .collect();

    // active 判定与加载器一致：按文件名排序后，同名档案先加载者生效
    let mut seen_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let custom_files = crate::chat_v2::workspace::list_custom_agent_files(&agents_dir)
        .into_iter()
        .map(|file| {
            let active = file
                .profile
                .as_ref()
                .is_some_and(|profile| seen_ids.insert(profile.id.clone()));
            CustomAgentFileSummary {
                file_name: file.file_name,
                bytes: file.bytes,
                modified_at: file.modified_at,
                name: file.summary.name,
                description: file.summary.description,
                base: file.summary.base,
                model: file.summary.model,
                tool_count: file.profile.as_ref().map(|p| p.allowed_tools.len()),
                valid: file.profile.is_some(),
                active,
            }
        })
        .collect();

    Ok(ListAgentProfilesResponse {
        builtin,
        custom_files,
        agents_dir: agents_dir.to_string_lossy().into_owned(),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfileFileResponse {
    pub file_name: String,
    pub content: String,
}

/// 读取单个自定义档案文件全文（设置页编辑用）。
///
/// 文件名/路径安全校验与 agent 侧 custom_agent_* 工具共用同一套实现
/// （`CustomAgentExecutor`），两条读写路径规则保持一致。
#[tauri::command]
pub async fn workspace_read_agent_profile_file(
    coordinator: State<'_, Arc<WorkspaceCoordinator>>,
    file_name: String,
) -> Result<AgentProfileFileResponse, String> {
    use crate::chat_v2::tools::custom_agent_executor::CustomAgentExecutor;

    let agents_dir = coordinator.custom_agents_dir();
    let path = CustomAgentExecutor::resolve_persona_path(&agents_dir, &file_name)?;
    if !path.exists() {
        return Err("PROFILE_FILE_NOT_FOUND".to_string());
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read profile file '{}': {}", file_name, e))?;
    Ok(AgentProfileFileResponse { file_name, content })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAgentProfileFileResponse {
    pub file_name: String,
    /// frontmatter 中声明的档案 id。
    pub agent_name: String,
    pub bytes: usize,
    /// Model catalog could not be read at save time. Runtime still enforces
    /// exact model identity and will fail rather than fall back.
    pub warnings: Vec<serde_json::Value>,
}

/// 写入（新建或覆盖）单个自定义档案文件（设置页编辑用）。
///
/// `overwrite=false` 时目标已存在返回 `PROFILE_FILE_EXISTS`（前端本地化）。
/// 内容校验与加载器 fail-closed 规则一致，拦截落盘后永远不生效的定义。
#[tauri::command]
pub async fn workspace_save_agent_profile_file(
    coordinator: State<'_, Arc<WorkspaceCoordinator>>,
    llm_manager: State<'_, Arc<crate::llm_manager::LLMManager>>,
    file_name: String,
    content: String,
    overwrite: bool,
) -> Result<SaveAgentProfileFileResponse, String> {
    use crate::chat_v2::tools::custom_agent_executor::CustomAgentExecutor;
    use crate::chat_v2::workspace::agent_profile::validate_persona_model_config;

    let (agent_name, _, model) = CustomAgentExecutor::validate_persona_content(&content)?;
    let mut warnings = Vec::new();
    if let Some(model_id) = model.as_deref() {
        match llm_manager.get_api_configs().await {
            Ok(configs) => validate_persona_model_config(model_id, &configs)?,
            Err(error) => warnings.push(serde_json::json!({
                "code": "PERSONA_MODEL_CATALOG_UNAVAILABLE",
                "model_id": model_id,
                "message": format!(
                    "Failed to read the model catalog: {}. The profile was saved, but runtime will require this exact model configuration and will not fall back.",
                    error
                ),
            })),
        }
    }
    let agents_dir = coordinator.custom_agents_dir();
    let path = CustomAgentExecutor::resolve_persona_path(&agents_dir, &file_name)?;
    let _file_guard = crate::chat_v2::workspace::custom_agents::lock_custom_agent_files()?;
    if !overwrite && path.exists() {
        return Err("PROFILE_FILE_EXISTS".to_string());
    }
    CustomAgentExecutor::atomic_write(&path, content.as_bytes())?;
    log::info!(
        "[Workspace::handlers] Saved custom agent profile '{}' ({} bytes) via settings",
        file_name,
        content.len()
    );
    Ok(SaveAgentProfileFileResponse {
        file_name,
        agent_name,
        bytes: content.len(),
        warnings,
    })
}

/// 删除单个自定义档案文件（设置页编辑用）。删除立即生效且不可撤销。
#[tauri::command]
pub async fn workspace_delete_agent_profile_file(
    coordinator: State<'_, Arc<WorkspaceCoordinator>>,
    file_name: String,
) -> Result<(), String> {
    use crate::chat_v2::tools::custom_agent_executor::CustomAgentExecutor;

    let agents_dir = coordinator.custom_agents_dir();
    let path = CustomAgentExecutor::resolve_persona_path(&agents_dir, &file_name)?;
    let _file_guard = crate::chat_v2::workspace::custom_agents::lock_custom_agent_files()?;
    if !path.exists() {
        return Err("PROFILE_FILE_NOT_FOUND".to_string());
    }
    std::fs::remove_file(&path)
        .map_err(|e| format!("Failed to delete profile file '{}': {}", file_name, e))?;
    log::info!(
        "[Workspace::handlers] Deleted custom agent profile '{}' via settings",
        file_name
    );
    Ok(())
}

#[cfg(test)]
mod runtime_completion_tests {
    use super::*;

    #[test]
    fn completion_envelope_uses_stable_runtime_protocol_fields() {
        let envelope = AgentCompletionEnvelope {
            kind: "agent_completion".to_string(),
            workspace_id: "ws_test".to_string(),
            agent_session_id: "agent_test".to_string(),
            parent_session_id: Some("sess_parent".to_string()),
            task_id: Some("task_test".to_string()),
            run_id: "msg_run".to_string(),
            correlation_id: Some("wsmsg_task".to_string()),
            status: AgentCompletionStatus::Completed,
            final_output: Some("done".to_string()),
            error: None,
            completed_at: "2026-07-11T00:00:00Z".to_string(),
            token_usage: Some(crate::chat_v2::types::TokenUsage {
                prompt_tokens: 120,
                completion_tokens: 30,
                total_tokens: 150,
                ..Default::default()
            }),
        };

        let value = envelope.metadata();
        assert_eq!(value["type"], "agent_completion");
        assert_eq!(value["workspace_id"], "ws_test");
        assert_eq!(value["agent_session_id"], "agent_test");
        assert_eq!(value["parent_session_id"], "sess_parent");
        assert_eq!(value["task_id"], "task_test");
        assert_eq!(value["run_id"], "msg_run");
        assert_eq!(value["correlation_id"], "wsmsg_task");
        assert_eq!(value["status"], "completed");
        assert_eq!(value["final_output"], "done");
        assert!(value.get("error").is_none());
        // 契约 C8：token_usage 内部字段是 camelCase TokenUsage 对象
        assert_eq!(value["token_usage"]["promptTokens"], 120);
        assert_eq!(value["token_usage"]["completionTokens"], 30);
        assert_eq!(value["token_usage"]["totalTokens"], 150);
    }

    #[test]
    fn failed_completion_omits_output_and_carries_error() {
        let envelope = AgentCompletionEnvelope {
            kind: "agent_completion".to_string(),
            workspace_id: "ws_test".to_string(),
            agent_session_id: "agent_test".to_string(),
            parent_session_id: None,
            task_id: None,
            run_id: "msg_run".to_string(),
            correlation_id: None,
            status: AgentCompletionStatus::Failed,
            final_output: None,
            error: Some("pipeline failed".to_string()),
            completed_at: "2026-07-11T00:00:00Z".to_string(),
            token_usage: None,
        };

        let value = envelope.metadata();
        assert_eq!(value["status"], "failed");
        assert_eq!(value["error"], "pipeline failed");
        assert!(value.get("final_output").is_none());
        assert!(value.get("task_id").is_none());
        assert!(value.get("correlation_id").is_none());
        assert!(value.get("parent_session_id").is_none());
        // usage 读不到时整个键省略
        assert!(value.get("token_usage").is_none());
    }

    #[test]
    fn profile_skill_snapshot_selects_declared_ids_and_rejects_missing() {
        let metadata = serde_json::json!({
            "profile_skill_contents": {
                "research": "snapshot body",
                "unrelated": "must not be injected"
            }
        });
        let selected =
            resolve_profile_skill_snapshot(&["research".to_string()], Some(&metadata)).unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(
            selected.get("research").map(String::as_str),
            Some("snapshot body")
        );
        assert!(!selected.contains_key("unrelated"));

        let error =
            resolve_profile_skill_snapshot(&["missing".to_string()], Some(&metadata)).unwrap_err();
        assert!(error.contains("silently ignored"));
    }
}
