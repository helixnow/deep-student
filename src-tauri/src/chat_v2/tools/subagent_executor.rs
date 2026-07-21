use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use super::workspace_executor::WORKSPACE_WORKER_READY_EVENT;
use crate::chat_v2::events::event_types;
use crate::chat_v2::repo::ChatV2Repo;
use crate::chat_v2::types::{ChatSession, PersistStatus, ToolCall, ToolResultInfo};
use crate::chat_v2::workspace::config::{MAX_SUBAGENT_DEPTH, SUBAGENT_WAIT_BUDGET_SECS};
use crate::chat_v2::workspace::{
    agent_profile::validate_persona_model_config, AgentProfileOverride, AgentProfileResolver,
    AgentProfileSelection, AgentRole, AgentStatus, MessageType, SubagentTaskData,
    SubagentTaskStatus, WorkspaceCoordinator,
};

pub const SUBAGENT_TOOL_NAME: &str = "subagent_call";

/// 阻塞等待路径的任务状态轮询间隔
const SUBAGENT_POLL_INTERVAL_MS: u64 = 500;
/// `result_summary` 的写入端字符预算（由运行时截断，契约见 A2）。
/// 达到该长度即认为结果可能被截断，返回 `output_truncated: true`。
const RESULT_SUMMARY_BUDGET_CHARS: usize = 4000;
/// 自动创建工作区时，工作区名取 task 的前 N 个字符
const AUTO_WORKSPACE_NAME_CHARS: usize = 24;

/// 契约 C7 兜底：续跑幂等派发（目标 agent 已有活跃流）时，观察到 agent
/// 回到终态/Idle 后再给任务终态写入留的宽限窗口（完成路径先置 agent 状态
/// 再写 task 终态，二者之间有毫秒级窗口）。
const AGENT_SETTLE_GRACE_MS: u64 = 3_000;

/// `subagent_call` 的解析后参数（契约 C4/C7 入参侧，schema 由前端分区同步维护）
#[derive(Debug)]
struct SubagentCallArgs {
    task: String,
    workspace_id: Option<String>,
    profile: Option<String>,
    skill_id: Option<String>,
    model: Option<String>,
    context: Option<Value>,
    wait: bool,
    /// 契约 C7：提供时走续跑路径（跳过创建，向既有 worker 投递追问）
    resume_agent_session_id: Option<String>,
}

fn optional_trimmed_string(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

fn parse_subagent_args(args: &Value) -> Result<SubagentCallArgs, String> {
    let task = args
        .get("task")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("task is required")?
        .to_string();

    Ok(SubagentCallArgs {
        task,
        workspace_id: optional_trimmed_string(args, "workspace_id"),
        profile: optional_trimmed_string(args, "profile"),
        skill_id: optional_trimmed_string(args, "skill_id"),
        model: optional_trimmed_string(args, "model"),
        context: args.get("context").cloned().filter(|v| !v.is_null()),
        wait: args.get("wait").and_then(|v| v.as_bool()).unwrap_or(true),
        resume_agent_session_id: optional_trimmed_string(args, "resume_agent_session_id"),
    })
}

/// 任务内容拼接（创建与续跑路径共用的 context 附带逻辑）
fn build_task_content(args: &SubagentCallArgs) -> String {
    match &args.context {
        Some(ctx_value) => format!(
            "{}\n\n[Context]\n{}",
            args.task,
            serde_json::to_string_pretty(ctx_value).unwrap_or_default()
        ),
        None => args.task.clone(),
    }
}

/// 自动创建工作区时从任务文本派生名称（按字符截断，UTF-8 安全）
fn derive_workspace_name(task: &str) -> String {
    let name: String = task
        .trim()
        .chars()
        .take(AUTO_WORKSPACE_NAME_CHARS)
        .collect();
    if name.is_empty() {
        "Subagent Task".to_string()
    } else {
        name
    }
}

pub(super) fn build_profile_skill_snapshot(
    skill_ids: &[String],
    available: Option<&std::collections::HashMap<String, String>>,
) -> Result<std::collections::HashMap<String, String>, String> {
    if skill_ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let available = available.ok_or_else(|| {
        format!(
            "Profile requires skills [{}], but the current runtime has no skill content registry",
            skill_ids.join(", ")
        )
    })?;
    let mut snapshot = std::collections::HashMap::new();
    let mut missing = Vec::new();
    for skill_id in skill_ids {
        match available.get(skill_id) {
            Some(content) => {
                snapshot.insert(skill_id.clone(), content.clone());
            }
            None => missing.push(skill_id.clone()),
        }
    }
    if !missing.is_empty() {
        return Err(format!(
            "Profile skills are unavailable in the current runtime: [{}]. Refusing to create a worker that would silently ignore them.",
            missing.join(", ")
        ));
    }
    Ok(snapshot)
}

/// 判断一条收件箱消息是否是本次子代理的运行时完成信封。
///
/// 运行时的 `AgentCompletionEnvelope`（A2 所有）把 `kind` 字段序列化为
/// `"type"`；此处同时识别 `"kind"` 与 `"type"` 两个键，保持对信封演进的
/// 前向兼容。匹配到的消息内容已经作为工具返回值交付，直接吞掉以避免
/// 结果双份进入父上下文。
fn is_own_agent_completion(content: &str, agent_session_id: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(content) else {
        return false;
    };
    let kind = value
        .get("kind")
        .or_else(|| value.get("type"))
        .and_then(|v| v.as_str());
    let agent = value.get("agent_session_id").and_then(|v| v.as_str());
    kind == Some("agent_completion") && agent == Some(agent_session_id)
}

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

    /// 契约 C5：父级取消时停止子代理管线（best-effort，失败仅记日志）。
    async fn cancel_subagent_run(
        &self,
        workspace_id: &str,
        agent_session_id: &str,
        chat_v2_state: &Arc<crate::chat_v2::state::ChatV2State>,
    ) {
        if let Err(e) =
            crate::chat_v2::handlers::workspace_handlers::cancel_workspace_agent_backend(
                workspace_id,
                agent_session_id,
                self.coordinator.clone(),
                chat_v2_state.clone(),
            )
            .await
        {
            log::warn!(
                "[SubagentExecutor] Failed to cancel subagent {} after parent cancellation: {}",
                agent_session_id,
                e
            );
        }
    }

    /// 回滚刚创建的子代理 ChatSession（创建链路失败时调用，best-effort）。
    fn rollback_subagent_session(&self, ctx: &ExecutionContext, agent_session_id: &str) {
        let Some(chat_v2_db) = ctx.chat_v2_db.as_ref() else {
            return;
        };
        if let Err(e) = ChatV2Repo::delete_session_v2(chat_v2_db, agent_session_id) {
            log::warn!(
                "[SubagentExecutor] Failed to roll back subagent session {}: {}",
                agent_session_id,
                e
            );
        }
    }

    /// 从 window state 解析运行时句柄并派发 agent run，尊重取消令牌
    /// （创建与续跑路径共用）。派发被取消时先停子代理管线再返回 Err。
    async fn dispatch_agent_run(
        &self,
        ctx: &ExecutionContext,
        workspace_id: &str,
        agent_session_id: &str,
    ) -> Result<
        (
            crate::chat_v2::handlers::workspace_handlers::RunAgentResponse,
            Arc<crate::chat_v2::state::ChatV2State>,
        ),
        String,
    > {
        let app_handle = ctx.window_ref().app_handle();
        let chat_v2_state = app_handle
            .try_state::<Arc<crate::chat_v2::state::ChatV2State>>()
            .ok_or("ChatV2State not available for subagent runtime")?
            .inner()
            .clone();
        let pipeline = app_handle
            .try_state::<Arc<crate::chat_v2::pipeline::ChatV2Pipeline>>()
            .ok_or("ChatV2Pipeline not available for subagent runtime")?
            .inner()
            .clone();
        let runtime_db = app_handle
            .try_state::<Arc<crate::chat_v2::database::ChatV2Database>>()
            .ok_or("ChatV2Database not available for subagent runtime")?
            .inner()
            .clone();
        // 本执行器声明 manages_cancellation=true（注册表不再代为中断），
        // 因此派发本身（可能阻塞在 worker 调度信号量上）也必须响应取消。
        let dispatch_future =
            crate::chat_v2::handlers::workspace_handlers::run_workspace_agent_backend(
                crate::chat_v2::handlers::workspace_handlers::RunAgentRequest {
                    workspace_id: workspace_id.to_string(),
                    agent_session_id: agent_session_id.to_string(),
                    requester_session_id: ctx.session_id.clone(),
                    reminder: None,
                },
                ctx.window_ref().clone(),
                self.coordinator.clone(),
                chat_v2_state.clone(),
                pipeline,
                runtime_db,
            );
        let run = if let Some(token) = ctx.cancellation_token() {
            tokio::select! {
                result = dispatch_future => result?,
                _ = token.cancelled() => {
                    self.cancel_subagent_run(workspace_id, agent_session_id, &chat_v2_state)
                        .await;
                    return Err("Subagent call cancelled".to_string());
                }
            }
        } else {
            dispatch_future.await?
        };
        Ok((run, chat_v2_state))
    }

    /// 契约 C7：续跑/追问路径。跳过创建（深度检查 / register_agent /
    /// profile 持久化都不做），向既有 worker 投递新 Task 并复用派发 + 等待
    /// 逻辑；子代理 session 的历史对话天然保留（带上下文续跑）。
    async fn execute_resume_call(
        &self,
        args: &SubagentCallArgs,
        resume_id: &str,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        // 1. 续跑必须显式提供 workspace_id（首次调用的返回值里有）
        let workspace_id = args.workspace_id.clone().ok_or(
            "resume_agent_session_id requires workspace_id \
             (it is included in the original subagent_call return value)",
        )?;

        // 2. 校验：workspace / agent（且必须是 Worker）/ chat_v2 session 都存在
        self.coordinator
            .get_workspace(&workspace_id)?
            .ok_or_else(|| format!("Workspace not found: {}", workspace_id))?;
        let agent = self
            .coordinator
            .get_agent(&workspace_id, resume_id)?
            .ok_or_else(|| {
                format!(
                    "Agent {} not found in workspace {}; it may have been unregistered",
                    resume_id, workspace_id
                )
            })?;
        if !matches!(agent.role, AgentRole::Worker) {
            return Err(format!(
                "Agent {} is not a worker and cannot be resumed",
                resume_id
            ));
        }
        let chat_v2_db = ctx
            .chat_v2_db
            .as_ref()
            .ok_or("chat_v2_db not available for resuming subagent")?;
        {
            let conn = chat_v2_db
                .get_conn_safe()
                .map_err(|e| format!("Failed to get db connection: {}", e))?;
            ChatV2Repo::get_session_with_conn(&conn, resume_id)
                .map_err(|e| format!("Failed to query subagent session: {}", e))?
                .ok_or_else(|| {
                    format!(
                        "Chat session not found for agent {}; the subagent conversation was deleted",
                        resume_id
                    )
                })?;
        }

        // 3. 不写 profile：沿用 agent metadata 里持久化的（legacy 行走
        //    skill_id 回退），这里只取 id 用于返回值。
        let profile_id = AgentProfileResolver::resolve_for_agent(&agent)
            .map(|profile| profile.id)
            .unwrap_or_else(|_| "worker".to_string());

        // 4. 为本次续跑新建 task 行——wait 轮询的载体
        let task_manager = self.coordinator.get_task_manager(&workspace_id)?;
        let task_data = SubagentTaskData::new(
            workspace_id.clone(),
            resume_id.to_string(),
            agent.skill_id.clone(),
            Some(args.task.clone()),
        );
        task_manager
            .create_task(&task_data)
            .map_err(|e| format!("Failed to persist resume task: {:?}", e))?;

        // 5. 投递追问（沿用现有 context 拼接逻辑）
        let message = self.coordinator.send_message(
            &workspace_id,
            &ctx.session_id,
            Some(resume_id),
            MessageType::Task,
            build_task_content(args),
        )?;

        // 6. 走既有后端派发
        let (run, chat_v2_state) = self
            .dispatch_agent_run(ctx, &workspace_id, resume_id)
            .await?;
        // 幂等分支特征（run_workspace_agent_backend）：目标 agent 正在
        // Running/Queued 且已有活跃流时直接返回 message_id 为空的响应，
        // 消息留在 inbox 由下一轮注入消费——此时新 task 可能长期 pending。
        let dispatch_was_idempotent = run.message_id.is_empty();

        log::info!(
            "[SubagentExecutor] Resumed subagent {} in workspace {} (task_id={}, idempotent_dispatch={})",
            resume_id,
            workspace_id,
            task_data.id,
            dispatch_was_idempotent
        );

        if !args.wait {
            return Ok(json!({
                "agent_session_id": resume_id,
                "workspace_id": workspace_id,
                "skill_id": args.skill_id,
                "task_message_id": message.id,
                "run_id": run.message_id,
                "status": run.status,
                "auto_created_workspace": false,
                "profile_id": profile_id,
                "resumed": true,
                "message": "Follow-up task was delivered to the existing subagent (wait=false; not waiting for completion).",
            }));
        }

        let dispatched_line = json!({
            "phase": "dispatched",
            "workspace_id": workspace_id,
            "agent_session_id": resume_id,
            "run_id": run.message_id,
            "status": "running",
            "resumed": true,
        });
        if let Ok(json_line) = serde_json::to_string(&dispatched_line) {
            ctx.emitter.emit_chunk(
                event_types::TOOL_CALL,
                &ctx.block_id,
                &format!("{}\n", json_line),
                None,
            );
        }

        self.wait_for_subagent_completion(
            ctx,
            &workspace_id,
            resume_id,
            &task_data.id,
            &run.message_id,
            &message.id,
            false,
            &profile_id,
            args.skill_id.as_deref(),
            chat_v2_state,
            true,
            dispatch_was_idempotent,
        )
        .await
    }

    async fn execute_subagent_call(
        &self,
        raw_args: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        // 🆕 取消检查：在执行前检查是否已取消
        if ctx.is_cancelled() {
            return Err("Subagent call cancelled before start".to_string());
        }

        let args = parse_subagent_args(raw_args)?;

        // 契约 C7：resume_agent_session_id 提供时走续跑路径，跳过创建
        if let Some(resume_id) = args.resume_agent_session_id.clone() {
            let mut unsupported = Vec::new();
            if args.profile.is_some() {
                unsupported.push("profile");
            }
            if args.skill_id.is_some() {
                unsupported.push("skill_id");
            }
            if args.model.is_some() {
                unsupported.push("model");
            }
            if !unsupported.is_empty() {
                return Err(format!(
                    "resume_agent_session_id reuses the persisted agent profile; [{}] cannot be overridden during resume. Omit these fields or create a new subagent.",
                    unsupported.join(", ")
                ));
            }
            return self.execute_resume_call(&args, &resume_id, ctx).await;
        }

        // 🔒 安全检查：防止子代理无限递归嵌套（fail-closed: DB错误时拒绝）
        let current_depth = self.get_subagent_depth(ctx)?;
        if current_depth >= MAX_SUBAGENT_DEPTH {
            return Err(format!(
                "Maximum subagent nesting depth ({}) exceeded. Current depth: {}. \
                 Recursive subagent creation is not allowed to prevent resource exhaustion.",
                MAX_SUBAGENT_DEPTH, current_depth
            ));
        }

        // 工作区解析：缺省时自动创建并把当前会话注册为 coordinator
        let (workspace_id, auto_created_workspace) = match &args.workspace_id {
            Some(id) => {
                self.coordinator
                    .get_workspace(id)?
                    .ok_or_else(|| format!("Workspace not found: {}", id))?;
                (id.clone(), false)
            }
            None => {
                let workspace = self
                    .coordinator
                    .create_workspace(&ctx.session_id, Some(derive_workspace_name(&args.task)))?;
                self.coordinator.register_agent(
                    &workspace.id,
                    &ctx.session_id,
                    AgentRole::Coordinator,
                    None,
                    None,
                )?;
                (workspace.id, true)
            }
        };

        // 契约 C2：profile 解析（skill_id 仅作兼容别名，model 作为覆盖项）
        // 契约 C6：内建之外再查 {workspaces_dir}/agents/*.md 的自定义 profile
        let profile = AgentProfileResolver::resolve_with_custom(
            AgentProfileSelection {
                profile_id: args.profile.clone(),
                skill_id: args.skill_id.clone(),
                overrides: AgentProfileOverride {
                    model: args.model.clone(),
                    ..Default::default()
                },
            },
            Some(&self.coordinator.custom_agents_dir()),
        )?;
        let profile_skill_contents =
            build_profile_skill_snapshot(&profile.skills, ctx.skill_contents.as_ref())?;
        if let Some(model_id) = profile.model.as_deref() {
            let manager = ctx.llm_manager.as_ref().ok_or_else(|| {
                format!(
                    "Cannot validate persona model '{}': model catalog is unavailable. Runtime fallback is disabled for explicit persona models.",
                    model_id
                )
            })?;
            let configs = manager
                .get_api_configs()
                .await
                .map_err(|error| format!("Failed to read model catalog: {}", error))?;
            validate_persona_model_config(model_id, &configs)?;
        }

        let agent_session_id = format!("subagent_{}_{}", profile.id, ulid::Ulid::new());
        let agent_label = args.skill_id.clone().unwrap_or_else(|| profile.id.clone());

        // 在 chat_v2.db 中创建 ChatSession（SubagentContainer 通过
        // chat_v2_load_session 加载子代理消息依赖它）
        let chat_v2_db = ctx
            .chat_v2_db
            .as_ref()
            .ok_or("chat_v2_db not available for creating subagent session")?;

        // 运行时优先从 agent metadata 的 profile 构建提示词（A2 职责）；
        // session 里的 system_prompt 仅作 legacy 兜底。
        let system_prompt = format!(
            "You are a subagent in workspace {}. Complete the delegated task; the runtime delivers your final answer to the parent agent.",
            workspace_id
        );

        let now = chrono::Utc::now();
        let session = ChatSession {
            id: agent_session_id.clone(),
            mode: "subagent".to_string(),
            title: Some(format!("Subagent: {}", agent_label)),
            description: Some(format!(
                "工作区 {} 的子代理",
                &workspace_id[..8.min(workspace_id.len())]
            )),
            summary_hash: None,
            // Subagent 标题是系统语义化命名，锁定避免被自动摘要覆盖
            title_locked: true,
            persist_status: PersistStatus::Active,
            created_at: now,
            updated_at: now,
            metadata: Some(json!({
                "workspace_id": workspace_id,
                "role": "worker",
                "skill_id": args.skill_id,
                "system_prompt": system_prompt,
                "is_subagent": true,
                "parent_session_id": ctx.session_id,
                "subagent_depth": current_depth + 1,
                // Durable creation-time skill snapshot. The worker runtime consumes
                // only ids declared by the persisted profile; embedded tools are not
                // inherited, so a skill cannot widen the profile tool whitelist.
                "profile_skill_contents": profile_skill_contents,
                "effective_agent_profile": {
                    "id": profile.id.clone(),
                    "model_id": profile.model.clone(),
                    "reasoning_effort": profile.reasoning_effort.as_ref().map(|effort| effort.as_str()),
                    "skill_ids": profile.skills.clone(),
                },
            })),
            group_id: None,
            tags_hash: None,
            tags: None,
        };

        {
            let conn = chat_v2_db
                .get_conn_safe()
                .map_err(|e| format!("Failed to get db connection: {}", e))?;
            ChatV2Repo::create_session_with_conn(&conn, &session)
                .map_err(|e| format!("Failed to create subagent session: {}", e))?;
        }

        log::info!(
            "[SubagentExecutor] Created chat_v2 session for subagent: {}",
            agent_session_id
        );

        // 在工作区中注册子代理；失败时回滚刚创建的 ChatSession
        // 契约 C2：resolved profile 持久化进 agent metadata，运行时以其为准
        let agent = match self.coordinator.register_agent(
            &workspace_id,
            &agent_session_id,
            AgentRole::Worker,
            args.skill_id.clone(),
            Some(AgentProfileResolver::persist_into_metadata(None, &profile)),
        ) {
            Ok(agent) => agent,
            Err(e) => {
                self.rollback_subagent_session(ctx, &agent_session_id);
                return Err(format!("Failed to register subagent: {}", e));
            }
        };

        // 持久化子代理任务（支持重启恢复 + 阻塞等待路径的终态轮询）。
        // 失败即回滚 agent 注册与 ChatSession 并返回错误：阻塞等待依赖
        // task 行读取终态，不允许 warn-and-continue。
        let task_manager = self.coordinator.get_task_manager(&workspace_id)?;
        let task_data = SubagentTaskData::new(
            workspace_id.clone(),
            agent_session_id.clone(),
            args.skill_id.clone(),
            Some(args.task.clone()),
        );
        if let Err(e) = task_manager.create_task(&task_data) {
            if let Err(unregister_err) = self
                .coordinator
                .unregister_agent(&workspace_id, &agent_session_id)
            {
                log::warn!(
                    "[SubagentExecutor] Failed to roll back agent registration for {}: {}",
                    agent_session_id,
                    unregister_err
                );
            }
            self.rollback_subagent_session(ctx, &agent_session_id);
            return Err(format!("Failed to persist subagent task: {:?}", e));
        }
        log::info!(
            "[SubagentExecutor] Persisted subagent task: task_id={}, agent={}",
            task_data.id,
            agent_session_id
        );

        // 发送任务消息（context 拼接见 build_task_content）
        let message = self.coordinator.send_message(
            &workspace_id,
            &ctx.session_id,
            Some(&agent_session_id),
            MessageType::Task,
            build_task_content(&args),
        )?;

        let event_payload = json!({
            "workspace_id": workspace_id,
            "agent_session_id": agent_session_id,
            "skill_id": args.skill_id,
            "runtime_managed": true,
        });
        // Backend-native dispatch. The compatibility event below is observational;
        // execution does not depend on a frontend listener being mounted.
        let (run, chat_v2_state) = self
            .dispatch_agent_run(ctx, &workspace_id, &agent_session_id)
            .await?;

        // Preserve the old signal for UI observation only. Emitting after backend
        // dispatch prevents legacy listeners from winning the startup race.
        if let Err(error) = ctx
            .window_ref()
            .emit(WORKSPACE_WORKER_READY_EVENT, &event_payload)
        {
            log::warn!(
                "[SubagentExecutor] Failed to emit compatibility worker_ready event: {}",
                error
            );
        }

        if !args.wait {
            // wait=false：保持旧行为，立即返回 ids + status
            return Ok(json!({
                "agent_session_id": agent.session_id,
                "workspace_id": workspace_id,
                "skill_id": args.skill_id,
                "task_message_id": message.id,
                "run_id": run.message_id,
                "status": run.status,
                "auto_created_workspace": auto_created_workspace,
                "profile_id": profile.id,
                "resumed": false,
                "message": "Subagent was created and dispatched by the backend runtime (wait=false; not waiting for completion).",
            }));
        }

        // 契约 C4 partial：派发进度 NDJSON，前端在等待期靠它渲染子代理嵌入对话
        let dispatched_line = json!({
            "phase": "dispatched",
            "workspace_id": workspace_id,
            "agent_session_id": agent_session_id,
            "run_id": run.message_id,
            "status": "running",
        });
        if let Ok(json_line) = serde_json::to_string(&dispatched_line) {
            ctx.emitter.emit_chunk(
                event_types::TOOL_CALL,
                &ctx.block_id,
                &format!("{}\n", json_line),
                None,
            );
        }

        self.wait_for_subagent_completion(
            ctx,
            &workspace_id,
            &agent_session_id,
            &task_data.id,
            &run.message_id,
            &message.id,
            auto_created_workspace,
            &profile.id,
            args.skill_id.as_deref(),
            chat_v2_state,
            false,
            false,
        )
        .await
    }

    /// 阻塞等待子代理终态（wait=true 默认路径）。
    ///
    /// 轮询 subagent_task 行直到 Completed/Failed/Cancelled；总预算
    /// [`SUBAGENT_WAIT_BUDGET_SECS`]。父级取消时调用
    /// `cancel_workspace_agent_backend`（契约 C5，A2 提供）后返回 Err。
    ///
    /// 契约 C7 兜底（`watch_agent_settle=true`，仅续跑幂等派发时启用）：
    /// 追问消息落在活跃 run 的 inbox 里，可能由注入被当前 run 消费；本次
    /// 新建的 task 行也会在该 run 收尾时被 `get_agent_task`（最新 pending）
    /// 命中并写终态。但若当前 run 结束时没有走到收尾写入（例如取消竞态），
    /// task 会长期 pending——因此额外轮询 agent 状态：观察到 agent 回到
    /// 终态/Idle 且宽限 [`AGENT_SETTLE_GRACE_MS`] 后 task 仍非终态时提前
    /// 返回 status:"running" + 提示，避免白等满 750s。
    #[allow(clippy::too_many_arguments)]
    async fn wait_for_subagent_completion(
        &self,
        ctx: &ExecutionContext,
        workspace_id: &str,
        agent_session_id: &str,
        task_id: &str,
        run_id: &str,
        task_message_id: &str,
        auto_created_workspace: bool,
        profile_id: &str,
        skill_id: Option<&str>,
        chat_v2_state: Arc<crate::chat_v2::state::ChatV2State>,
        resumed: bool,
        watch_agent_settle: bool,
    ) -> Result<Value, String> {
        let task_manager = self.coordinator.get_task_manager(workspace_id)?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(SUBAGENT_WAIT_BUDGET_SECS);
        let poll_interval = Duration::from_millis(SUBAGENT_POLL_INTERVAL_MS);
        let settle_grace = Duration::from_millis(AGENT_SETTLE_GRACE_MS);
        // agent 首次被观察到处于终态/Idle 的时刻（见 watch_agent_settle 文档）
        let mut agent_settled_since: Option<Instant> = None;
        let mut agent_settled_without_terminal = false;

        let terminal_task = loop {
            if ctx.is_cancelled() {
                // 契约 C5：父级取消时停止子代理管线，再向上返回取消错误
                self.cancel_subagent_run(workspace_id, agent_session_id, &chat_v2_state)
                    .await;
                return Err("Subagent call cancelled".to_string());
            }

            match task_manager.get_task(task_id) {
                Ok(Some(task))
                    if matches!(
                        task.status,
                        SubagentTaskStatus::Completed
                            | SubagentTaskStatus::Failed
                            | SubagentTaskStatus::Cancelled
                    ) =>
                {
                    break Some(task);
                }
                Ok(_) => {}
                Err(e) => {
                    // 瞬态 DB 错误不终止等待；终态最终仍可被后续 tick 观察到
                    log::warn!(
                        "[SubagentExecutor] Transient error polling subagent task {}: {:?}",
                        task_id,
                        e
                    );
                }
            }

            if watch_agent_settle {
                match self.coordinator.get_agent(workspace_id, agent_session_id) {
                    Ok(Some(agent))
                        if matches!(
                            agent.status,
                            AgentStatus::Idle
                                | AgentStatus::Completed
                                | AgentStatus::Failed
                                | AgentStatus::Cancelled
                                | AgentStatus::Closed
                        ) =>
                    {
                        let settled_since = *agent_settled_since.get_or_insert_with(Instant::now);
                        // 完成路径先置 agent 终态、后写 task 终态：给终态写入
                        // 留出宽限，超过宽限仍未写入才判定 task 不会被消费
                        if settled_since.elapsed() >= settle_grace {
                            agent_settled_without_terminal = true;
                            break None;
                        }
                    }
                    Ok(_) => {
                        agent_settled_since = None;
                    }
                    Err(e) => {
                        log::warn!(
                            "[SubagentExecutor] Transient error polling agent {} status: {}",
                            agent_session_id,
                            e
                        );
                    }
                }
            }

            if tokio::time::Instant::now() >= deadline {
                break None;
            }

            // sleep 与取消令牌 select：取消由下一轮循环顶部统一处理
            if let Some(token) = ctx.cancellation_token() {
                tokio::select! {
                    _ = tokio::time::sleep(poll_interval) => {}
                    _ = token.cancelled() => {}
                }
            } else {
                tokio::time::sleep(poll_interval).await;
            }
        };

        let Some(task) = terminal_task else {
            // 未拿到终态：等待超预算，或（续跑幂等派发）agent 已回到终态但
            // 新 task 未被收尾写入。均不视为失败，返回 running + 提示。
            let hint = if agent_settled_without_terminal {
                "Subagent finished its active run without finalizing this follow-up task; \
                 the follow-up message may still be pending in its inbox. Call subagent_call \
                 again with the same resume_agent_session_id to trigger another run, or use \
                 workspace_query to inspect the workspace."
            } else {
                "Subagent is still running; use coordinator_sleep or workspace_query to continue waiting."
            };
            return Ok(json!({
                "workspace_id": workspace_id,
                "agent_session_id": agent_session_id,
                "run_id": run_id,
                "task_message_id": task_message_id,
                "status": "running",
                "auto_created_workspace": auto_created_workspace,
                "profile_id": profile_id,
                "skill_id": skill_id,
                "resumed": resumed,
                "message": hint,
            }));
        };

        // 去重回收：排干父会话收件箱，吞掉本次子代理的 agent_completion
        // （其内容已在工具返回值里），其余消息放回收件箱。
        match self
            .coordinator
            .drain_inbox(workspace_id, &ctx.session_id, 10)
        {
            Ok(messages) => {
                for msg in messages {
                    if is_own_agent_completion(&msg.content, agent_session_id) {
                        log::debug!(
                            "[SubagentExecutor] Swallowed duplicate completion message {} for agent {}",
                            msg.id,
                            agent_session_id
                        );
                        continue;
                    }
                    if let Err(e) =
                        self.coordinator
                            .re_enqueue_message(workspace_id, &ctx.session_id, &msg.id)
                    {
                        log::warn!(
                            "[SubagentExecutor] Failed to re-enqueue inbox message {}: {}",
                            msg.id,
                            e
                        );
                    }
                }
            }
            Err(e) => {
                log::warn!(
                    "[SubagentExecutor] Failed to drain parent inbox for dedup: {}",
                    e
                );
            }
        }

        // 契约 C4：终态返回值（failed 也走 Ok，结构化失败回喂模型）
        let status_str = match task.status {
            SubagentTaskStatus::Completed => "completed",
            SubagentTaskStatus::Failed => "failed",
            SubagentTaskStatus::Cancelled => "cancelled",
            // 循环仅在终态 break，此分支不可达；防御性兜底
            SubagentTaskStatus::Pending | SubagentTaskStatus::Running => "running",
        };
        let output = task.result_summary.clone().unwrap_or_default();
        let output_truncated = output.chars().count() >= RESULT_SUMMARY_BUDGET_CHARS;

        // 契约 C8：按 run_id（= assistant 消息 ID）读取该 run 持久化的
        // token usage（与 completion envelope 共用同一 helper）；读不到写 null。
        // 续跑幂等派发时 run_id 为空（没有新 run），直接 null。
        let token_usage = if run_id.is_empty() {
            None
        } else {
            ctx.chat_v2_db.as_ref().and_then(|db| {
                crate::chat_v2::handlers::workspace_handlers::worker_message_usage(db, run_id)
            })
        };

        let mut result = json!({
            "workspace_id": workspace_id,
            "agent_session_id": agent_session_id,
            "run_id": run_id,
            "task_message_id": task_message_id,
            "status": status_str,
            "output": output,
            "output_truncated": output_truncated,
            "auto_created_workspace": auto_created_workspace,
            "profile_id": profile_id,
            "skill_id": skill_id,
            "resumed": resumed,
            "token_usage": token_usage,
        });
        if matches!(task.status, SubagentTaskStatus::Failed) {
            let error_context = task
                .result_summary
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("Subagent failed without an error summary");
            result["error"] = json!(error_context);
        }
        Ok(result)
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
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let result = self.execute_subagent_call(&call.arguments, ctx).await;
        let duration_ms = start.elapsed().as_millis() as u64;

        match result {
            Ok(output) => {
                // 🔧 修复：发射工具调用结束事件
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
                ctx.emitter.emit_error_with_meta(
                    event_types::TOOL_CALL,
                    &ctx.block_id,
                    &error,
                    ctx.variant_id.as_deref(),
                    ctx.skill_state_version,
                    ctx.round_id.as_deref(),
                );

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

    /// 阻塞等待路径必须在父级取消时先调用 `cancel_workspace_agent_backend`
    /// 停止子代理管线；若由注册表 select 直接 drop 本执行 future，该收尾
    /// 永远不会执行。轮询循环每个 tick 检查取消令牌，取消响应上限约 500ms。
    fn manages_cancellation(&self, _tool_name: &str) -> bool {
        true
    }

    fn name(&self) -> &'static str {
        "SubagentExecutor"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subagent_call_is_a_medium_sensitivity_mutation() {
        let temp_dir = tempfile::tempdir().expect("create workspace directory");
        let coordinator = Arc::new(WorkspaceCoordinator::new(temp_dir.path().to_path_buf()));
        let executor = SubagentExecutor::new(coordinator);

        assert!(executor.can_handle("subagent_call"));
        assert!(executor.can_handle("builtin-subagent_call"));
        assert_eq!(
            executor.sensitivity_level("builtin-subagent_call"),
            ToolSensitivity::Medium
        );
        // 阻塞等待路径自管理取消（先取消子代理管线再返回）
        assert!(executor.manages_cancellation("subagent_call"));
    }

    #[test]
    fn parse_args_requires_task() {
        assert!(parse_subagent_args(&json!({})).is_err());
        assert!(parse_subagent_args(&json!({ "task": "  " })).is_err());
        assert!(parse_subagent_args(&json!({ "task": "do it" })).is_ok());
    }

    #[test]
    fn parse_args_defaults_wait_true_and_all_fields_optional() {
        let args = parse_subagent_args(&json!({ "task": "summarize the paper" })).unwrap();
        assert_eq!(args.task, "summarize the paper");
        assert!(args.wait, "wait must default to true");
        assert!(args.workspace_id.is_none());
        assert!(args.profile.is_none());
        assert!(args.skill_id.is_none());
        assert!(args.model.is_none());
        assert!(args.context.is_none());
        assert!(args.resume_agent_session_id.is_none());
    }

    #[test]
    fn parse_args_reads_resume_agent_session_id() {
        // 契约 C7：resume_agent_session_id 是可选 string，空白视为未提供
        let args = parse_subagent_args(&json!({
            "task": "follow-up question",
            "workspace_id": "ws_1",
            "resume_agent_session_id": "subagent_worker_01ABC",
        }))
        .unwrap();
        assert_eq!(
            args.resume_agent_session_id.as_deref(),
            Some("subagent_worker_01ABC")
        );

        let blank = parse_subagent_args(&json!({
            "task": "t",
            "resume_agent_session_id": "   ",
        }))
        .unwrap();
        assert!(blank.resume_agent_session_id.is_none());
    }

    #[test]
    fn build_task_content_appends_context_block() {
        let plain = parse_subagent_args(&json!({ "task": "do it" })).unwrap();
        assert_eq!(build_task_content(&plain), "do it");

        let with_ctx = parse_subagent_args(&json!({
            "task": "do it",
            "context": { "hint": 1 },
        }))
        .unwrap();
        let content = build_task_content(&with_ctx);
        assert!(content.starts_with("do it\n\n[Context]\n"));
        assert!(content.contains("\"hint\": 1"));
    }

    #[test]
    fn profile_skill_snapshot_is_exact_and_fails_closed_on_missing_content() {
        let available = std::collections::HashMap::from([
            ("research".to_string(), "research body".to_string()),
            ("other".to_string(), "other body".to_string()),
        ]);
        let snapshot =
            build_profile_skill_snapshot(&["research".to_string()], Some(&available)).unwrap();
        assert_eq!(snapshot.len(), 1);
        assert_eq!(
            snapshot.get("research").map(String::as_str),
            Some("research body")
        );
        assert!(!snapshot.contains_key("other"));

        let error =
            build_profile_skill_snapshot(&["missing".to_string()], Some(&available)).unwrap_err();
        assert!(error.contains("silently ignore"));
    }

    #[test]
    fn parse_args_reads_all_optional_fields() {
        let args = parse_subagent_args(&json!({
            "task": "t",
            "workspace_id": "ws_1",
            "profile": "explorer",
            "skill_id": "research",
            "model": "model-config-1",
            "context": { "hint": 1 },
            "wait": false,
        }))
        .unwrap();
        assert_eq!(args.workspace_id.as_deref(), Some("ws_1"));
        assert_eq!(args.profile.as_deref(), Some("explorer"));
        assert_eq!(args.skill_id.as_deref(), Some("research"));
        assert_eq!(args.model.as_deref(), Some("model-config-1"));
        assert_eq!(args.context, Some(json!({ "hint": 1 })));
        assert!(!args.wait);
    }

    #[test]
    fn derive_workspace_name_truncates_by_chars_not_bytes() {
        assert_eq!(derive_workspace_name("short task"), "short task");
        let long = "a".repeat(40);
        assert_eq!(derive_workspace_name(&long).chars().count(), 24);
        // 多字节字符按字符截断，不产生非法 UTF-8 边界
        let cjk = "分析这篇论文的方法论并总结创新点与局限性以及未来方向";
        assert_eq!(derive_workspace_name(cjk).chars().count(), 24);
        assert_eq!(derive_workspace_name("   "), "Subagent Task");
    }

    #[test]
    fn profile_resolution_defaults_to_worker_and_applies_model_override() {
        // 契约 C2：profile 缺省解析为 worker，model 作为覆盖项生效
        let profile = AgentProfileResolver::resolve(AgentProfileSelection {
            profile_id: None,
            skill_id: Some("custom_skill".into()),
            overrides: AgentProfileOverride {
                model: Some("model-config-2".into()),
                ..Default::default()
            },
        })
        .unwrap();
        assert_eq!(profile.id, "worker");
        assert_eq!(profile.model.as_deref(), Some("model-config-2"));
        assert_eq!(profile.skills, vec!["custom_skill"]);

        // 未知 profile 显式拒绝
        assert!(AgentProfileResolver::resolve(AgentProfileSelection {
            profile_id: Some("nonexistent".into()),
            ..Default::default()
        })
        .is_err());
    }

    #[test]
    fn completion_dedup_matches_type_and_kind_keys_and_agent_id() {
        // 运行时信封当前把 kind 序列化为 "type"
        let type_key = r#"{"type":"agent_completion","agent_session_id":"subagent_x"}"#;
        assert!(is_own_agent_completion(type_key, "subagent_x"));
        // 前向兼容 "kind" 键
        let kind_key = r#"{"kind":"agent_completion","agent_session_id":"subagent_x"}"#;
        assert!(is_own_agent_completion(kind_key, "subagent_x"));
        // 其他子代理的完成消息不吞
        assert!(!is_own_agent_completion(type_key, "subagent_other"));
        // 非完成消息、非 JSON 消息不吞
        assert!(!is_own_agent_completion(
            r#"{"type":"progress","agent_session_id":"subagent_x"}"#,
            "subagent_x"
        ));
        assert!(!is_own_agent_completion(
            "plain text progress",
            "subagent_x"
        ));
    }
}
