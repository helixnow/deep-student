//! Super 会话工具执行器（Router 专用的 4 个 Worker 编排工具）。
//!
//! - `super_dispatch_worker{title, task, context?, profile?, model?}`：委托
//!   [`SubagentExecutor::execute_subagent_call_with_args`] 创建 Worker，固定
//!   `wait=false`、`workspace_id` = 本回合 Super 工作区、`profile` 默认 `explorer`；
//!   agent metadata 追加 `super_agent:{title, dispatched_in_message_id}`。返回结构与
//!   `subagent_call` 一致（前端映射为 subagent_embed 卡片），另附 `worker_id` / `title`。
//! - `super_message_worker{worker_id, message}`：走 subagent 续跑路径（wait=false）。
//! - `super_close_worker{worker_id}`：先 `cancel_workspace_agent_backend`，再置
//!   `Closed` 并在 metadata 标 `super_agent.closed_by_router=true`。
//! - `super_list_workers{}`：汇总 Super 工作区的 Worker（agents + 最近任务）。
//!
//! 仅当本回合属于活跃且启用的 Super 会话时可执行：执行前以
//! `super_session::apply_turn_overrides` 对当前会话做一次探测，得到
//! `SendOptions.super_session`（与管线入口钩子同一判定），为 None 时返回错误。

use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use serde_json::{json, Map, Value};
use tauri::Manager;

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use super::subagent_executor::{SubagentCallArgs, SubagentExecutor};
use crate::chat_v2::events::event_types;
use crate::chat_v2::types::{SendMessageRequest, SendOptions, SuperTurn, ToolCall, ToolResultInfo};
use crate::chat_v2::workspace::{
    AgentProfileResolver, AgentRole, AgentStatus, SubagentTaskData, WorkspaceAgent,
    WorkspaceCoordinator,
};

/// 裸工具名（与 `super_session::SUPER_TOOL_NAMES` 去掉 `builtin-` 前缀后一致）。
pub mod tool_names {
    pub const DISPATCH_WORKER: &str = "super_dispatch_worker";
    pub const MESSAGE_WORKER: &str = "super_message_worker";
    pub const CLOSE_WORKER: &str = "super_close_worker";
    pub const LIST_WORKERS: &str = "super_list_workers";
    pub const ALL: [&str; 4] = [DISPATCH_WORKER, MESSAGE_WORKER, CLOSE_WORKER, LIST_WORKERS];
}

/// Worker 默认 profile（用户已采纳默认值 ①）。
pub const DEFAULT_WORKER_PROFILE: &str = "explorer";
/// agent metadata 中 Super 专属键。
const SUPER_AGENT_METADATA_KEY: &str = "super_agent";
/// list 汇总读取的最近任务条数上限。
const LIST_RECENT_TASKS_LIMIT: usize = 200;
/// list 输出中任务文本 / 结果摘要的截断长度（字符）。
const LIST_TASK_PREVIEW_CHARS: usize = 200;
const LIST_RESULT_PREVIEW_CHARS: usize = 600;

fn required_trimmed_string(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .ok_or_else(|| format!("{} is required", key))
}

fn optional_trimmed_string(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        let mut out: String = text.chars().take(max).collect();
        out.push('…');
        out
    }
}

/// `super_dispatch_worker` 参数 → 委托给 SubagentExecutor 的参数。
pub(crate) fn build_dispatch_args(
    raw: &Value,
    turn: &SuperTurn,
    dispatched_in_message_id: &str,
) -> Result<SubagentCallArgs, String> {
    let title = required_trimmed_string(raw, "title")?;
    let task = required_trimmed_string(raw, "task")?;
    let profile =
        optional_trimmed_string(raw, "profile").unwrap_or_else(|| DEFAULT_WORKER_PROFILE.into());
    Ok(SubagentCallArgs {
        task,
        workspace_id: Some(turn.workspace_id.clone()),
        profile: Some(profile),
        skill_id: None,
        model: optional_trimmed_string(raw, "model"),
        context: raw.get("context").cloned().filter(|v| !v.is_null()),
        wait: false,
        resume_agent_session_id: None,
        agent_metadata: Some(json!({
            "super_agent": {
                "title": title,
                "dispatched_in_message_id": dispatched_in_message_id,
            }
        })),
        title: Some(title),
    })
}

/// `super_message_worker` 参数 → 续跑参数（worker_id 校验由调用方完成）。
pub(crate) fn build_message_args(
    raw: &Value,
    turn: &SuperTurn,
) -> Result<(String, SubagentCallArgs), String> {
    let worker_id = required_trimmed_string(raw, "worker_id")?;
    let message = required_trimmed_string(raw, "message")?;
    Ok((
        worker_id.clone(),
        SubagentCallArgs {
            task: message,
            workspace_id: Some(turn.workspace_id.clone()),
            wait: false,
            resume_agent_session_id: Some(worker_id),
            ..Default::default()
        },
    ))
}

fn super_agent_meta(agent: &WorkspaceAgent) -> Option<&Map<String, Value>> {
    agent
        .metadata
        .as_ref()
        .and_then(|m| m.get(SUPER_AGENT_METADATA_KEY))
        .and_then(|v| v.as_object())
}

fn worker_title(agent: &WorkspaceAgent) -> Option<String> {
    super_agent_meta(agent)
        .and_then(|m| m.get("title"))
        .and_then(|v| v.as_str())
        .map(String::from)
}

/// 校验 worker_id 是 Super 工作区里的 Worker。
fn load_worker(
    coordinator: &WorkspaceCoordinator,
    workspace_id: &str,
    worker_id: &str,
) -> Result<WorkspaceAgent, String> {
    let agent = coordinator
        .get_agent(workspace_id, worker_id)?
        .ok_or_else(|| {
            format!(
                "Worker {} not found in the Super-agent workspace; use super_list_workers to see current workers",
                worker_id
            )
        })?;
    if !matches!(agent.role, AgentRole::Worker) {
        return Err(format!("Agent {} is not a worker", worker_id));
    }
    Ok(agent)
}

/// 在 agent metadata 的 `super_agent` 对象上合并字段（保留其余键）。
fn merge_super_agent_metadata(metadata: Option<Value>, patch: &[(&str, Value)]) -> Value {
    let mut root = match metadata {
        Some(Value::Object(object)) => object,
        _ => Map::new(),
    };
    let entry = root
        .entry(SUPER_AGENT_METADATA_KEY.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !entry.is_object() {
        *entry = Value::Object(Map::new());
    }
    if let Some(object) = entry.as_object_mut() {
        for (key, value) in patch {
            object.insert((*key).to_string(), value.clone());
        }
    }
    Value::Object(root)
}

/// `super_close_worker` 核心：先取消运行，再置 Closed，并标记 closed_by_router。
///
/// 已 Closed 的 Worker 幂等返回。取消失败时直接返回错误（不置 Closed、不打标记，
/// 避免把仍在运行的 Worker 的结果当作“已由 Router 关闭”吞掉）。
pub(crate) async fn close_worker_core(
    coordinator: Arc<WorkspaceCoordinator>,
    chat_v2_state: Arc<crate::chat_v2::state::ChatV2State>,
    workspace_id: &str,
    worker_id: &str,
) -> Result<Value, String> {
    let agent = load_worker(&coordinator, workspace_id, worker_id)?;
    let title = worker_title(&agent);
    if matches!(agent.status, AgentStatus::Closed) {
        return Ok(json!({
            "worker_id": worker_id,
            "workspace_id": workspace_id,
            "title": title,
            "status": "closed",
            "already_closed": true,
        }));
    }

    // 1. 先取消（停流 + pending/running 任务置 Cancelled）
    crate::chat_v2::handlers::workspace_handlers::cancel_workspace_agent_backend(
        workspace_id,
        worker_id,
        coordinator.clone(),
        chat_v2_state,
    )
    .await?;

    // 2. 再置 Closed
    coordinator.update_agent_status(workspace_id, worker_id, AgentStatus::Closed)?;

    // 3. 标记 closed_by_router（收件箱据此吞掉取消回执）。重新读取 metadata，
    //    避免覆盖取消过程中的并发写入。
    let latest_metadata = coordinator
        .get_agent(workspace_id, worker_id)?
        .and_then(|a| a.metadata)
        .or(agent.metadata);
    let metadata = merge_super_agent_metadata(
        latest_metadata,
        &[
            ("closed_by_router", Value::Bool(true)),
            ("closed_at", json!(chrono::Utc::now().to_rfc3339())),
        ],
    );
    coordinator.update_agent_metadata(workspace_id, worker_id, Some(metadata))?;

    Ok(json!({
        "worker_id": worker_id,
        "workspace_id": workspace_id,
        "title": title,
        "status": "closed",
        "already_closed": false,
    }))
}

fn task_summary(task: &SubagentTaskData) -> Value {
    json!({
        "task_id": task.id,
        "status": serde_json::to_value(&task.status).unwrap_or(Value::Null),
        "task": task.initial_task.as_deref().map(|t| truncate_chars(t, LIST_TASK_PREVIEW_CHARS)),
        "result_summary": task
            .result_summary
            .as_deref()
            .map(|r| truncate_chars(r, LIST_RESULT_PREVIEW_CHARS)),
        "created_at": task.created_at.to_rfc3339(),
        "completed_at": task.completed_at.map(|t| t.to_rfc3339()),
    })
}

/// `super_list_workers` 核心：Super 工作区全部 Worker + 各自最近任务。
pub(crate) fn list_workers_core(
    coordinator: &WorkspaceCoordinator,
    workspace_id: &str,
) -> Result<Value, String> {
    let agents = coordinator.list_agents(workspace_id)?;
    let tasks = coordinator
        .get_task_manager(workspace_id)?
        .list_recent_tasks(LIST_RECENT_TASKS_LIMIT)
        .map_err(|e| format!("Failed to list worker tasks: {:?}", e))?;

    let mut workers: Vec<Value> = agents
        .iter()
        .filter(|agent| matches!(agent.role, AgentRole::Worker))
        .map(|agent| {
            // list_recent_tasks 按 created_at DESC，第一条即最近任务
            let latest = tasks
                .iter()
                .find(|task| task.agent_session_id == agent.session_id);
            let task_count = tasks
                .iter()
                .filter(|task| task.agent_session_id == agent.session_id)
                .count();
            let meta = super_agent_meta(agent);
            json!({
                "worker_id": agent.session_id,
                "title": worker_title(agent),
                "status": serde_json::to_value(&agent.status).unwrap_or(Value::Null),
                "profile_id": AgentProfileResolver::resolve_for_agent(agent).ok().map(|p| p.id),
                "dispatched_in_message_id": meta
                    .and_then(|m| m.get("dispatched_in_message_id"))
                    .cloned()
                    .unwrap_or(Value::Null),
                "closed_by_router": meta
                    .and_then(|m| m.get("closed_by_router"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                "joined_at": agent.joined_at.to_rfc3339(),
                "last_active_at": agent.last_active_at.to_rfc3339(),
                "task_count": task_count,
                "latest_task": latest.map(task_summary),
            })
        })
        .collect();
    // 最近活跃在前
    workers.sort_by(|a, b| {
        b.get("last_active_at")
            .and_then(|v| v.as_str())
            .cmp(&a.get("last_active_at").and_then(|v| v.as_str()))
    });

    Ok(json!({
        "workspace_id": workspace_id,
        "count": workers.len(),
        "workers": workers,
    }))
}

pub struct SuperSessionExecutor {
    coordinator: Arc<WorkspaceCoordinator>,
    subagent: SubagentExecutor,
}

impl SuperSessionExecutor {
    pub fn new(coordinator: Arc<WorkspaceCoordinator>) -> Self {
        Self {
            subagent: SubagentExecutor::new(coordinator.clone()),
            coordinator,
        }
    }

    /// 本回合的 Super 标记：与管线入口钩子同一判定（活跃 && 启用 && 未隐藏）。
    fn resolve_super_turn(ctx: &ExecutionContext) -> Result<SuperTurn, String> {
        const NOT_SUPER: &str =
            "Super-agent tools are only available in the active Super-agent session";
        let db = ctx.chat_v2_db.as_ref().ok_or(NOT_SUPER)?;
        let mut probe = SendMessageRequest {
            session_id: ctx.session_id.clone(),
            content: String::new(),
            options: Some(SendOptions::default()),
            user_message_id: None,
            assistant_message_id: None,
            user_context_refs: None,
            path_map: None,
            workspace_id: None,
        };
        crate::chat_v2::super_session::apply_turn_overrides(
            &**db,
            ctx.main_db.as_deref(),
            &mut probe,
            false,
        );
        probe
            .options
            .and_then(|options| options.super_session)
            .filter(|turn| !turn.workspace_id.trim().is_empty())
            .ok_or_else(|| NOT_SUPER.to_string())
    }

    fn require_window(ctx: &ExecutionContext) -> Result<(), String> {
        if ctx.try_window().is_none() {
            return Err(
                "Super-agent worker dispatch requires the desktop window runtime".to_string(),
            );
        }
        Ok(())
    }

    fn chat_v2_state(
        ctx: &ExecutionContext,
    ) -> Result<Arc<crate::chat_v2::state::ChatV2State>, String> {
        let from_window = ctx.try_window().and_then(|window| {
            window
                .app_handle()
                .try_state::<Arc<crate::chat_v2::state::ChatV2State>>()
                .map(|state| state.inner().clone())
        });
        from_window
            .or_else(|| {
                crate::get_global_app_handle().and_then(|app| {
                    app.try_state::<Arc<crate::chat_v2::state::ChatV2State>>()
                        .map(|state| state.inner().clone())
                })
            })
            .ok_or_else(|| "ChatV2State not available for Super-agent tools".to_string())
    }

    async fn dispatch_worker(&self, raw: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let turn = Self::resolve_super_turn(ctx)?;
        Self::require_window(ctx)?;
        let args = build_dispatch_args(raw, &turn, &ctx.message_id)?;
        let title = args.title.clone();
        let mut result = self
            .subagent
            .execute_subagent_call_with_args(args, ctx)
            .await?;
        if let Some(object) = result.as_object_mut() {
            let worker_id = object
                .get("agent_session_id")
                .cloned()
                .unwrap_or(Value::Null);
            object.insert("worker_id".to_string(), worker_id);
            object.insert("title".to_string(), json!(title));
        }
        Ok(result)
    }

    async fn message_worker(&self, raw: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let turn = Self::resolve_super_turn(ctx)?;
        Self::require_window(ctx)?;
        let (worker_id, args) = build_message_args(raw, &turn)?;
        let agent = load_worker(&self.coordinator, &turn.workspace_id, &worker_id)?;
        if matches!(agent.status, AgentStatus::Closed) {
            return Err(format!(
                "Worker {} was closed; dispatch a new worker instead",
                worker_id
            ));
        }
        let title = worker_title(&agent);
        let mut result = self
            .subagent
            .execute_subagent_call_with_args(args, ctx)
            .await?;
        if let Some(object) = result.as_object_mut() {
            object.insert("worker_id".to_string(), json!(worker_id));
            object.insert("title".to_string(), json!(title));
        }
        Ok(result)
    }

    async fn close_worker(&self, raw: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let turn = Self::resolve_super_turn(ctx)?;
        let worker_id = required_trimmed_string(raw, "worker_id")?;
        let state = Self::chat_v2_state(ctx)?;
        close_worker_core(
            self.coordinator.clone(),
            state,
            &turn.workspace_id,
            &worker_id,
        )
        .await
    }

    fn list_workers(&self, ctx: &ExecutionContext) -> Result<Value, String> {
        let turn = Self::resolve_super_turn(ctx)?;
        list_workers_core(&self.coordinator, &turn.workspace_id)
    }

    async fn execute_tool(&self, call: &ToolCall, ctx: &ExecutionContext) -> Result<Value, String> {
        if ctx.is_cancelled() {
            return Err("Super-agent tool call cancelled before start".to_string());
        }
        match strip_tool_namespace(&call.name) {
            tool_names::DISPATCH_WORKER => self.dispatch_worker(&call.arguments, ctx).await,
            tool_names::MESSAGE_WORKER => self.message_worker(&call.arguments, ctx).await,
            tool_names::CLOSE_WORKER => self.close_worker(&call.arguments, ctx).await,
            tool_names::LIST_WORKERS => self.list_workers(ctx),
            other => Err(format!("Unknown Super-agent tool: {}", other)),
        }
    }
}

#[async_trait]
impl ToolExecutor for SuperSessionExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        let name = strip_tool_namespace(tool_name);
        tool_names::ALL.iter().any(|candidate| *candidate == name)
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start = Instant::now();
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let result = self.execute_tool(call, ctx).await;
        let duration_ms = start.elapsed().as_millis() as u64;

        let info = match result {
            Ok(output) => {
                ctx.emitter.emit_end_with_meta(
                    event_types::TOOL_CALL,
                    &ctx.block_id,
                    Some(json!({
                        "result": output,
                        "durationMs": duration_ms,
                    })),
                    ctx.variant_id.as_deref(),
                    ctx.skill_state_version,
                    ctx.round_id.as_deref(),
                );
                ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration_ms,
                )
            }
            Err(error) => {
                ctx.emitter.emit_error_with_meta(
                    event_types::TOOL_CALL,
                    &ctx.block_id,
                    &error,
                    ctx.variant_id.as_deref(),
                    ctx.skill_state_version,
                    ctx.round_id.as_deref(),
                );
                ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error,
                    duration_ms,
                )
            }
        };

        // SSOT：后端立即保存工具块（防闪退）
        if let Err(e) = ctx.save_tool_block(&info) {
            log::warn!("[SuperSessionExecutor] Failed to save tool block: {}", e);
        }
        Ok(info)
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        match strip_tool_namespace(tool_name) {
            tool_names::DISPATCH_WORKER | tool_names::MESSAGE_WORKER => ToolSensitivity::Medium,
            _ => ToolSensitivity::Low,
        }
    }

    /// 派发/续跑可能阻塞在 worker 调度信号量上；委托的 SubagentExecutor 派发
    /// 自行 select 取消令牌并在取消时停止 Worker 管线，因此自管理取消。
    fn manages_cancellation(&self, tool_name: &str) -> bool {
        matches!(
            strip_tool_namespace(tool_name),
            tool_names::DISPATCH_WORKER | tool_names::MESSAGE_WORKER
        )
    }

    fn name(&self) -> &'static str {
        "SuperSessionExecutor"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_v2::events::ChatV2EventEmitter;
    use crate::chat_v2::workspace::SubagentTaskStatus;
    use crate::tools::ToolRegistry;

    const SUPER_SESSION: &str = "sess_super";

    fn turn(workspace_id: &str) -> SuperTurn {
        SuperTurn {
            workspace_id: workspace_id.to_string(),
        }
    }

    fn setup() -> (tempfile::TempDir, Arc<WorkspaceCoordinator>, String) {
        let temp = tempfile::tempdir().expect("temp dir");
        let coordinator = Arc::new(WorkspaceCoordinator::new(temp.path().to_path_buf()));
        let workspace = coordinator
            .create_workspace(SUPER_SESSION, Some("Super-agent".to_string()))
            .expect("create workspace");
        coordinator
            .register_agent(
                &workspace.id,
                SUPER_SESSION,
                AgentRole::Coordinator,
                None,
                None,
            )
            .expect("register coordinator");
        (temp, coordinator, workspace.id)
    }

    #[test]
    fn handles_exactly_the_four_super_tools_with_contract_sensitivity() {
        let (_temp, coordinator, _ws) = setup();
        let executor = SuperSessionExecutor::new(coordinator);
        for name in tool_names::ALL {
            assert!(executor.can_handle(name));
            assert!(executor.can_handle(&format!("builtin-{name}")));
        }
        assert!(!executor.can_handle("builtin-subagent_call"));
        assert!(!executor.can_handle("super_unknown"));

        assert_eq!(
            executor.sensitivity_level("builtin-super_dispatch_worker"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.sensitivity_level("builtin-super_message_worker"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.sensitivity_level("builtin-super_close_worker"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("builtin-super_list_workers"),
            ToolSensitivity::Low
        );
        assert!(executor.manages_cancellation("builtin-super_dispatch_worker"));
        assert!(executor.manages_cancellation("builtin-super_message_worker"));
        assert!(!executor.manages_cancellation("builtin-super_close_worker"));
        assert!(!executor.manages_cancellation("builtin-super_list_workers"));
    }

    #[test]
    fn tool_names_match_super_session_contract() {
        let contract: Vec<&str> = crate::chat_v2::super_session::SUPER_TOOL_NAMES
            .iter()
            .map(|name| strip_tool_namespace(name))
            .collect();
        assert_eq!(contract, tool_names::ALL.to_vec());
        for name in tool_names::ALL {
            assert!(
                crate::chat_v2::tool_descriptors::lookup(name).is_some(),
                "missing descriptor for {name}"
            );
        }
    }

    #[test]
    fn dispatch_args_use_super_workspace_wait_false_and_default_explorer() {
        let args = build_dispatch_args(
            &json!({ "title": " 整理错题 ", "task": "collect mistakes", "context": { "k": 1 } }),
            &turn("ws_super"),
            "msg_assistant_1",
        )
        .unwrap();
        assert_eq!(args.workspace_id.as_deref(), Some("ws_super"));
        assert!(!args.wait);
        assert_eq!(args.profile.as_deref(), Some(DEFAULT_WORKER_PROFILE));
        assert_eq!(args.profile.as_deref(), Some("explorer"));
        assert!(args.resume_agent_session_id.is_none());
        assert!(args.skill_id.is_none());
        assert_eq!(args.title.as_deref(), Some("整理错题"));
        assert_eq!(args.context, Some(json!({ "k": 1 })));
        assert_eq!(
            args.agent_metadata,
            Some(json!({
                "super_agent": {
                    "title": "整理错题",
                    "dispatched_in_message_id": "msg_assistant_1",
                }
            }))
        );

        // 模型给的 workspace_id / wait 被忽略；显式 profile/model 生效
        let explicit = build_dispatch_args(
            &json!({
                "title": "t",
                "task": "x",
                "profile": "worker",
                "model": "cfg-1",
                "workspace_id": "ws_other",
                "wait": true,
            }),
            &turn("ws_super"),
            "m",
        )
        .unwrap();
        assert_eq!(explicit.workspace_id.as_deref(), Some("ws_super"));
        assert!(!explicit.wait);
        assert_eq!(explicit.profile.as_deref(), Some("worker"));
        assert_eq!(explicit.model.as_deref(), Some("cfg-1"));

        assert!(build_dispatch_args(&json!({ "task": "x" }), &turn("w"), "m").is_err());
        assert!(build_dispatch_args(&json!({ "title": "t" }), &turn("w"), "m").is_err());
    }

    #[test]
    fn message_args_resume_in_super_workspace_without_waiting() {
        let (worker_id, args) = build_message_args(
            &json!({ "worker_id": "subagent_explorer_1", "message": "also check B" }),
            &turn("ws_super"),
        )
        .unwrap();
        assert_eq!(worker_id, "subagent_explorer_1");
        assert_eq!(
            args.resume_agent_session_id.as_deref(),
            Some("subagent_explorer_1")
        );
        assert_eq!(args.workspace_id.as_deref(), Some("ws_super"));
        assert_eq!(args.task, "also check B");
        assert!(!args.wait);
        assert!(args.profile.is_none() && args.model.is_none() && args.skill_id.is_none());
        assert!(build_message_args(&json!({ "worker_id": "w" }), &turn("x")).is_err());
    }

    #[tokio::test]
    async fn close_cancels_then_marks_closed_by_router() {
        let (_temp, coordinator, ws) = setup();
        let worker = "subagent_explorer_close";
        coordinator
            .register_agent(
                &ws,
                worker,
                AgentRole::Worker,
                None,
                Some(json!({ "super_agent": { "title": "整理错题", "dispatched_in_message_id": "m1" } })),
            )
            .unwrap();
        coordinator
            .update_agent_status(&ws, worker, AgentStatus::Running)
            .unwrap();
        let task_manager = coordinator.get_task_manager(&ws).unwrap();
        let task =
            SubagentTaskData::new(ws.clone(), worker.to_string(), None, Some("collect".into()));
        task_manager.create_task(&task).unwrap();
        task_manager.mark_running(&task.id).unwrap();

        let state = Arc::new(crate::chat_v2::state::ChatV2State::new());
        let output = close_worker_core(coordinator.clone(), state.clone(), &ws, worker)
            .await
            .unwrap();
        assert_eq!(output["status"], "closed");
        assert_eq!(output["already_closed"], false);
        assert_eq!(output["title"], "整理错题");

        // 取消已落库（任务 Cancelled），随后状态被置为 Closed（不被取消的 Cancelled 覆盖）
        let task_after = task_manager.get_task(&task.id).unwrap().unwrap();
        assert_eq!(task_after.status, SubagentTaskStatus::Cancelled);
        let agent = coordinator.get_agent(&ws, worker).unwrap().unwrap();
        assert_eq!(agent.status, AgentStatus::Closed);
        let meta = agent.metadata.unwrap();
        assert_eq!(meta["super_agent"]["closed_by_router"], true);
        // 原有 super_agent 字段保留
        assert_eq!(meta["super_agent"]["title"], "整理错题");
        assert_eq!(meta["super_agent"]["dispatched_in_message_id"], "m1");

        // 幂等
        let again = close_worker_core(coordinator.clone(), state, &ws, worker)
            .await
            .unwrap();
        assert_eq!(again["already_closed"], true);
    }

    #[tokio::test]
    async fn close_rejects_coordinator_and_unknown_agents() {
        let (_temp, coordinator, ws) = setup();
        let state = Arc::new(crate::chat_v2::state::ChatV2State::new());
        assert!(
            close_worker_core(coordinator.clone(), state.clone(), &ws, SUPER_SESSION)
                .await
                .is_err()
        );
        assert!(close_worker_core(coordinator, state, &ws, "missing")
            .await
            .is_err());
    }

    #[test]
    fn list_summarizes_workers_with_latest_task() {
        let (_temp, coordinator, ws) = setup();
        coordinator
            .register_agent(
                &ws,
                "subagent_explorer_a",
                AgentRole::Worker,
                None,
                Some(json!({ "super_agent": { "title": "A", "dispatched_in_message_id": "m1" } })),
            )
            .unwrap();
        coordinator
            .register_agent(&ws, "subagent_worker_b", AgentRole::Worker, None, None)
            .unwrap();
        let task_manager = coordinator.get_task_manager(&ws).unwrap();
        let task = SubagentTaskData::new(
            ws.clone(),
            "subagent_explorer_a".into(),
            None,
            Some("find notes".into()),
        );
        task_manager.create_task(&task).unwrap();

        let listed = list_workers_core(&coordinator, &ws).unwrap();
        assert_eq!(listed["workspace_id"], ws.as_str());
        assert_eq!(listed["count"], 2);
        let workers = listed["workers"].as_array().unwrap();
        // Coordinator（Super 会话自身）不在名单内
        assert!(workers.iter().all(|w| w["worker_id"] != SUPER_SESSION));
        let a = workers
            .iter()
            .find(|w| w["worker_id"] == "subagent_explorer_a")
            .unwrap();
        assert_eq!(a["title"], "A");
        assert_eq!(a["dispatched_in_message_id"], "m1");
        assert_eq!(a["closed_by_router"], false);
        assert_eq!(a["task_count"], 1);
        assert_eq!(a["latest_task"]["task_id"], task.id.as_str());
        assert_eq!(a["latest_task"]["task"], "find notes");
        let b = workers
            .iter()
            .find(|w| w["worker_id"] == "subagent_worker_b")
            .unwrap();
        assert!(b["title"].is_null());
        assert!(b["latest_task"].is_null());
    }

    #[tokio::test]
    async fn tools_fail_closed_outside_super_session() {
        let (_temp, coordinator, _ws) = setup();
        let executor = SuperSessionExecutor::new(coordinator);
        // 无 chat_v2_db（无法判定 Super 回合）→ 一律拒绝，不派发
        let ctx = ExecutionContext::new(
            "sess_plain".to_string(),
            "msg_1".to_string(),
            "blk_1".to_string(),
            Arc::new(ChatV2EventEmitter::new_windowless_for_test(
                "sess_plain".to_string(),
            )),
            Arc::new(ToolRegistry::new()),
            None,
        );
        for name in tool_names::ALL {
            let call = ToolCall::new(
                format!("call_{name}"),
                format!("builtin-{name}"),
                json!({ "title": "t", "task": "x", "worker_id": "w", "message": "m" }),
            );
            let result = executor.execute(&call, &ctx).await.unwrap();
            assert!(!result.success, "{name} must fail outside Super session");
            assert!(result
                .error
                .as_deref()
                .unwrap_or_default()
                .contains("Super-agent session"));
        }
    }

    #[test]
    fn history_maps_dispatch_and_message_to_subagent_embed_blocks() {
        use crate::chat_v2::context::PipelineContext;
        use crate::chat_v2::types::block_types;
        for name in [
            "builtin-super_dispatch_worker",
            "builtin-super_message_worker",
            "builtin-subagent_call",
        ] {
            assert_eq!(
                PipelineContext::get_block_type_for_tool_static(name),
                block_types::SUBAGENT_EMBED,
                "{name}"
            );
        }
        assert_eq!(
            PipelineContext::get_block_type_for_tool_static("builtin-super_list_workers"),
            block_types::MCP_TOOL
        );
    }

    #[test]
    fn merge_super_agent_metadata_preserves_other_keys() {
        let merged = merge_super_agent_metadata(
            Some(json!({ "agent_profile": { "id": "explorer" }, "super_agent": { "title": "T" } })),
            &[("closed_by_router", json!(true))],
        );
        assert_eq!(merged["agent_profile"]["id"], "explorer");
        assert_eq!(merged["super_agent"]["title"], "T");
        assert_eq!(merged["super_agent"]["closed_by_router"], true);

        let from_none = merge_super_agent_metadata(None, &[("closed_by_router", json!(true))]);
        assert_eq!(from_none["super_agent"]["closed_by_router"], true);
    }
}
