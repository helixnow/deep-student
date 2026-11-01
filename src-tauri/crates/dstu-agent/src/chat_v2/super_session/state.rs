//! Super 会话状态：settings 读写、会话唯一性（ensure）、开关、退役、删除后重建、
//! 管线入口钩子（apply_turn_overrides）、Worker 取消，以及旧 superagent.db 迁移。
//!
//! 会话标识（无独立指针，唯一真源是会话 metadata）：
//! - 活跃：`{"super_agent":{"active":true,"version":1,"workspace_id":"ws_…","hidden":false},"pinned":true}`；
//! - 退役：`{"super_agent":{"active":false,"retired_at":"…"}}`，去掉 `pinned`。
//!
//! 开关与额外指令存主库 settings：`super_agent.enabled` / `super_agent.instructions`。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager};

use super::inbound::is_external_sender;
use super::tools_schema::{super_tool_schemas, SUPER_TOOL_NAMES};
use crate::chat_v2::database::ChatV2Database;
use crate::chat_v2::repo::ChatV2Repo;
use crate::chat_v2::state::ChatV2State;
use crate::chat_v2::types::{
    ChatSession, McpToolSchema, PersistStatus, SendMessageRequest, SendOptions, SuperTurn,
};
use crate::chat_v2::workspace::{
    AgentRole, AgentStatus, SubagentTaskStatus, WorkspaceAgent, WorkspaceCoordinator,
    WorkspaceStatus,
};
use crate::database::Database;

// ============================================================================
// 常量
// ============================================================================

pub const SETTING_ENABLED: &str = "super_agent.enabled";
pub const SETTING_INSTRUCTIONS: &str = "super_agent.instructions";
/// 会话 metadata / Worker agent metadata 中的 Super 标记键。
pub const SUPER_AGENT_META_KEY: &str = "super_agent";
pub const SUPER_SESSION_TITLE: &str = "Super-agent";
/// Super 工作区名（workspace_index.name；硬删后会话行已不存在，靠它定位工作区）。
pub const SUPER_WORKSPACE_NAME: &str = "Super-agent";
pub const SUPER_METADATA_VERSION: u64 = 1;
/// 额外指令最大字符数。
pub const MAX_INSTRUCTIONS_CHARS: usize = 4_000;

pub const EVENT_SUPER_SESSION_CHANGED: &str = "super_session_changed";
pub const EVENT_SUPER_SESSION_INBOX_CHANGED: &str = "super_session_inbox_changed";

/// Worker agent metadata `super_agent.*` 字段名。
pub const WORKER_META_TITLE: &str = "title";
pub const WORKER_META_DISPATCHED_IN: &str = "dispatched_in_message_id";
pub const WORKER_META_CLOSED_BY_ROUTER: &str = "closed_by_router";
pub const WORKER_META_SUPERSEDED: &str = "superseded";
pub const WORKER_META_INTERRUPT_REPORTED: &str = "interrupt_reported_task_id";

// ============================================================================
// 对外类型
// ============================================================================

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SuperSessionState {
    pub enabled: bool,
    pub session_id: Option<String>,
    pub workspace_id: Option<String>,
    pub pending_inbox: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct SuperSessionSettings {
    pub instructions: String,
}

/// 当前活跃 Super 会话的快照（只读查询结果）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurrentSuper {
    pub session_id: String,
    pub workspace_id: Option<String>,
    pub hidden: bool,
}

/// `ensure_core` 的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnsureOutcome {
    pub session_id: String,
    pub workspace_id: String,
    /// 本次新建了会话。
    pub created: bool,
}

// ============================================================================
// metadata 辅助
// ============================================================================

pub fn super_meta(meta: Option<&Value>) -> Option<&Value> {
    meta?.get(SUPER_AGENT_META_KEY)
}

pub fn is_active_super_metadata(meta: Option<&Value>) -> bool {
    super_meta(meta)
        .and_then(|s| s.get("active"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

pub fn metadata_workspace_id(meta: Option<&Value>) -> Option<String> {
    super_meta(meta)
        .and_then(|s| s.get("workspace_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

pub fn metadata_hidden(meta: Option<&Value>) -> bool {
    super_meta(meta)
        .and_then(|s| s.get("hidden"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// 新建活跃 Super 会话的 metadata（workspace_id 由 ensure_workspace 回填）。
pub fn new_super_metadata() -> Value {
    json!({
        "super_agent": {
            "active": true,
            "version": SUPER_METADATA_VERSION,
            "workspace_id": Value::Null,
            "hidden": false,
        },
        "pinned": true,
    })
}

/// 退役：`super_agent` 置为 `{"active":false,"retired_at":…}` 并去掉 `pinned`。
///
/// 仅当 metadata 带 `super_agent` 键时生效（普通会话调用为 no-op，不会误删用户置顶）。
/// 用于回收站恢复的旧 Super、分支克隆、多活跃去重。幂等（重复调用仅刷新 retired_at）。
pub fn retire_metadata(meta: &mut Value) {
    let Some(obj) = meta.as_object_mut() else {
        return;
    };
    if !obj.contains_key(SUPER_AGENT_META_KEY) {
        return;
    }
    obj.insert(
        SUPER_AGENT_META_KEY.to_string(),
        json!({
            "active": false,
            "retired_at": chrono::Utc::now().to_rfc3339(),
        }),
    );
    obj.remove("pinned");
}

/// 取（必要时创建）metadata 中 `super_agent` 对象的可变引用。
fn super_obj_mut(meta: &mut Value) -> &mut Map<String, Value> {
    if !meta.is_object() {
        *meta = json!({});
    }
    let obj = match meta {
        Value::Object(obj) => obj,
        _ => unreachable!("normalized to object above"),
    };
    let entry = obj
        .entry(SUPER_AGENT_META_KEY.to_string())
        .or_insert_with(|| json!({}));
    if !entry.is_object() {
        *entry = json!({});
    }
    match entry {
        Value::Object(map) => map,
        _ => unreachable!("normalized to object above"),
    }
}

/// Worker agent metadata 上 `super_agent.<key>` 是否为 true。
pub fn agent_super_flag(agent: &WorkspaceAgent, key: &str) -> bool {
    super_meta(agent.metadata.as_ref())
        .and_then(|s| s.get(key))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Worker agent metadata 上 `super_agent.<key>` 的字符串值。
pub fn agent_super_str(agent: &WorkspaceAgent, key: &str) -> Option<String> {
    super_meta(agent.metadata.as_ref())
        .and_then(|s| s.get(key))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// 修改 Worker agent metadata 的 `super_agent` 子对象并落库。
pub(crate) fn patch_agent_super_meta(
    coordinator: &WorkspaceCoordinator,
    workspace_id: &str,
    agent_session_id: &str,
    patch: impl FnOnce(&mut Map<String, Value>),
) -> Result<(), String> {
    let agent = coordinator
        .get_agent(workspace_id, agent_session_id)?
        .ok_or_else(|| format!("Agent not found: {agent_session_id}"))?;
    let mut meta = agent.metadata.unwrap_or_else(|| json!({}));
    patch(super_obj_mut(&mut meta));
    coordinator.update_agent_metadata(workspace_id, agent_session_id, Some(meta))
}

/// Super 工作区中「真正的」Worker（排除外部事件伪发送者与 Coordinator）。
pub fn is_super_worker(agent: &WorkspaceAgent) -> bool {
    matches!(agent.role, AgentRole::Worker) && !is_external_sender(&agent.session_id)
}

pub fn is_active_agent_status(status: &AgentStatus) -> bool {
    matches!(
        status,
        AgentStatus::Idle | AgentStatus::Queued | AgentStatus::Running | AgentStatus::Interrupted
    )
}

// ============================================================================
// settings
// ============================================================================

pub fn read_enabled(main_db: &Database) -> bool {
    matches!(
        main_db
            .get_setting(SETTING_ENABLED)
            .ok()
            .flatten()
            .as_deref()
            .map(str::trim),
        Some("true") | Some("1")
    )
}

pub fn write_enabled(main_db: &Database, enabled: bool) -> Result<(), String> {
    main_db
        .save_setting(SETTING_ENABLED, if enabled { "true" } else { "false" })
        .map_err(|e| format!("保存 {SETTING_ENABLED} 失败: {e}"))
}

pub fn read_settings(main_db: &Database) -> SuperSessionSettings {
    SuperSessionSettings {
        instructions: main_db
            .get_setting(SETTING_INSTRUCTIONS)
            .ok()
            .flatten()
            .unwrap_or_default(),
    }
}

pub fn write_settings(main_db: &Database, settings: &SuperSessionSettings) -> Result<(), String> {
    let trimmed = settings.instructions.trim();
    let clipped: String = trimmed.chars().take(MAX_INSTRUCTIONS_CHARS).collect();
    main_db
        .save_setting(SETTING_INSTRUCTIONS, &clipped)
        .map_err(|e| format!("保存 {SETTING_INSTRUCTIONS} 失败: {e}"))
}

pub(crate) fn main_db_from_app(app: &AppHandle) -> Option<Arc<Database>> {
    app.try_state::<Arc<Database>>().map(|s| s.inner().clone())
}

/// Super 会话是否启用（读主库 settings；主库不可用视为关闭）。托盘驻留判断也用它。
pub fn is_enabled(app: &AppHandle) -> bool {
    main_db_from_app(app)
        .map(|db| read_enabled(&db))
        .unwrap_or(false)
}

// ============================================================================
// 会话查询 / ensure（核心逻辑不依赖 AppHandle，便于单测）
// ============================================================================

/// 所有活跃 Super 会话 id（persist_status=active 且 `$.super_agent.active` 为真），最新在前。
pub(crate) fn list_active_super_ids(db: &ChatV2Database) -> Result<Vec<String>, String> {
    let conn = db.get_conn_safe().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id FROM chat_v2_sessions
             WHERE persist_status = 'active'
               AND (CASE WHEN json_valid(metadata_json)
                         THEN json_extract(metadata_json, '$.super_agent.active')
                    END) = 1
             ORDER BY created_at DESC, rowid DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let ids: Vec<String> = rows.filter_map(Result::ok).collect();
    Ok(ids)
}

/// 当前活跃 Super 会话（只读，不做去重/修复）。
pub fn current_super(db: &ChatV2Database) -> Option<CurrentSuper> {
    let ids = match list_active_super_ids(db) {
        Ok(ids) => ids,
        Err(error) => {
            log::warn!("[SuperSession] Failed to query active Super session: {error}");
            return None;
        }
    };
    let id = ids.into_iter().next()?;
    let session = ChatV2Repo::get_session_v2(db, &id).ok().flatten()?;
    let meta = session.metadata.as_ref();
    Some(CurrentSuper {
        workspace_id: metadata_workspace_id(meta),
        hidden: metadata_hidden(meta),
        session_id: id,
    })
}

fn load_session(db: &ChatV2Database, session_id: &str) -> Result<ChatSession, String> {
    ChatV2Repo::get_session_v2(db, session_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Session not found: {session_id}"))
}

fn create_super_session(db: &ChatV2Database) -> Result<ChatSession, String> {
    let mut session = ChatSession::new(ChatSession::generate_id(), "chat".to_string());
    session.title = Some(SUPER_SESSION_TITLE.to_string());
    session.title_locked = true;
    session.metadata = Some(new_super_metadata());
    ChatV2Repo::create_session_v2(db, &session).map_err(|e| e.to_string())?;
    log::info!("[SuperSession] Created Super session {}", session.id);
    Ok(session)
}

/// 把会话退役（多活跃去重）。
fn retire_session(db: &ChatV2Database, session_id: &str) -> Result<(), String> {
    let mut session = load_session(db, session_id)?;
    if let Some(meta) = session.metadata.as_mut() {
        retire_metadata(meta);
    }
    ChatV2Repo::update_session_v2(db, &session).map_err(|e| e.to_string())?;
    log::info!("[SuperSession] Retired duplicate Super session {session_id}");
    Ok(())
}

/// 设置 hidden；返回是否实际发生变化。
pub(crate) fn set_hidden(
    db: &ChatV2Database,
    session_id: &str,
    hidden: bool,
) -> Result<bool, String> {
    let mut session = load_session(db, session_id)?;
    if metadata_hidden(session.metadata.as_ref()) == hidden {
        return Ok(false);
    }
    let mut meta = session.metadata.take().unwrap_or_else(|| json!({}));
    super_obj_mut(&mut meta).insert("hidden".to_string(), Value::Bool(hidden));
    session.metadata = Some(meta);
    ChatV2Repo::update_session_v2(db, &session).map_err(|e| e.to_string())?;
    Ok(true)
}

/// 确保 Super 会话绑定一个可用（Active）的工作区，并已注册为 Coordinator。
/// 返回工作区 id。工作区缺失 / 已关闭时新建并回填 metadata。
pub fn ensure_workspace(
    db: &ChatV2Database,
    coordinator: &WorkspaceCoordinator,
    session_id: &str,
) -> Result<String, String> {
    let mut session = load_session(db, session_id)?;
    if let Some(workspace_id) = metadata_workspace_id(session.metadata.as_ref()) {
        if let Ok(Some(workspace)) = coordinator.get_workspace(&workspace_id) {
            if workspace.status == WorkspaceStatus::Active {
                if coordinator.get_agent(&workspace_id, session_id)?.is_none() {
                    coordinator.register_agent(
                        &workspace_id,
                        session_id,
                        AgentRole::Coordinator,
                        None,
                        None,
                    )?;
                }
                return Ok(workspace_id);
            }
        }
    }
    let workspace =
        coordinator.create_workspace(session_id, Some(SUPER_WORKSPACE_NAME.to_string()))?;
    coordinator.register_agent(
        &workspace.id,
        session_id,
        AgentRole::Coordinator,
        None,
        None,
    )?;
    let mut meta = session.metadata.take().unwrap_or_else(|| json!({}));
    super_obj_mut(&mut meta).insert(
        "workspace_id".to_string(),
        Value::String(workspace.id.clone()),
    );
    session.metadata = Some(meta);
    ChatV2Repo::update_session_v2(db, &session).map_err(|e| e.to_string())?;
    log::info!(
        "[SuperSession] Bound Super session {} to workspace {}",
        session_id,
        workspace.id
    );
    Ok(workspace.id)
}

/// ensure 核心：唯一性（多个只留最新、其余退役）→ 去 hidden / 新建会话 → 确保工作区。
pub(crate) fn ensure_core(
    db: &ChatV2Database,
    coordinator: &WorkspaceCoordinator,
) -> Result<EnsureOutcome, String> {
    let ids = list_active_super_ids(db)?;
    let mut iter = ids.into_iter();
    let (session_id, created) = match iter.next() {
        Some(keep) => {
            for extra in iter {
                if let Err(error) = retire_session(db, &extra) {
                    log::warn!("[SuperSession] Failed to retire duplicate {extra}: {error}");
                }
            }
            set_hidden(db, &keep, false)?;
            (keep, false)
        }
        None => (create_super_session(db)?.id, true),
    };
    let workspace_id = ensure_workspace(db, coordinator, &session_id)?;
    Ok(EnsureOutcome {
        session_id,
        workspace_id,
        created,
    })
}

/// 工作区索引中由该会话创建、名为 Super-agent 的工作区（硬删后会话行已不存在时使用）。
pub(crate) fn super_workspaces_created_by(db: &ChatV2Database, session_id: &str) -> Vec<String> {
    let Ok(conn) = db.get_conn_safe() else {
        return Vec::new();
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT workspace_id FROM workspace_index WHERE creator_session_id = ?1 AND name = ?2",
    ) else {
        return Vec::new();
    };
    let rows = stmt.query_map(rusqlite::params![session_id, SUPER_WORKSPACE_NAME], |row| {
        row.get::<_, String>(0)
    });
    let ids: Vec<String> = match rows {
        Ok(rows) => rows.filter_map(Result::ok).collect(),
        Err(_) => Vec::new(),
    };
    ids
}

// ============================================================================
// Worker 取消
// ============================================================================

/// 取消单个 Worker：停流、pending/running 任务置 Cancelled、agent 状态置 Cancelled。
/// 语义对齐 workspace_handlers::cancel_workspace_agent_core（该函数私有，这里同构实现）。
pub(crate) fn cancel_worker_core(
    coordinator: &WorkspaceCoordinator,
    chat_v2_state: &ChatV2State,
    workspace_id: &str,
    agent_session_id: &str,
    reason: &str,
) -> bool {
    let stream_cancelled = chat_v2_state.cancel_stream(agent_session_id);
    let mut task_cancelled = false;
    if let Ok(task_manager) = coordinator.get_task_manager(workspace_id) {
        match task_manager.get_agent_task(agent_session_id) {
            Ok(Some(task)) => {
                match task_manager.update_status(
                    &task.id,
                    SubagentTaskStatus::Cancelled,
                    Some(reason),
                ) {
                    Ok(()) => task_cancelled = true,
                    Err(error) => log::warn!(
                        "[SuperSession] Failed to cancel task {} of {}: {:?}",
                        task.id,
                        agent_session_id,
                        error
                    ),
                }
            }
            Ok(None) => {}
            Err(error) => log::warn!(
                "[SuperSession] Failed to query task of {}: {:?}",
                agent_session_id,
                error
            ),
        }
    }
    let was_running = coordinator
        .get_agent(workspace_id, agent_session_id)
        .ok()
        .flatten()
        .is_some_and(|a| matches!(a.status, AgentStatus::Running | AgentStatus::Queued));
    let cancelled = stream_cancelled || task_cancelled || was_running;
    if cancelled {
        let _ =
            coordinator.update_agent_status(workspace_id, agent_session_id, AgentStatus::Cancelled);
        log::info!(
            "[SuperSession] Cancelled worker {} ({}): had_stream={}, task_cancelled={}",
            agent_session_id,
            reason,
            stream_cancelled,
            task_cancelled
        );
    }
    cancelled
}

/// 取消工作区内所有活跃 Worker，并标记 `superseded`（其取消回执投递时被吞掉）。
/// 返回被取消的 Worker id。
pub(crate) fn cancel_active_workers(
    coordinator: &WorkspaceCoordinator,
    chat_v2_state: &ChatV2State,
    workspace_id: &str,
    reason: &str,
) -> Vec<String> {
    let agents = match coordinator.list_agents(workspace_id) {
        Ok(agents) => agents,
        Err(error) => {
            log::warn!("[SuperSession] list_agents failed ({reason}): {error}");
            return Vec::new();
        }
    };
    let mut cancelled = Vec::new();
    for agent in agents
        .iter()
        .filter(|a| is_super_worker(a) && is_active_agent_status(&a.status))
    {
        if let Err(error) =
            patch_agent_super_meta(coordinator, workspace_id, &agent.session_id, |m| {
                m.insert(WORKER_META_SUPERSEDED.to_string(), Value::Bool(true));
            })
        {
            log::warn!(
                "[SuperSession] Failed to mark {} superseded: {}",
                agent.session_id,
                error
            );
        }
        cancel_worker_core(
            coordinator,
            chat_v2_state,
            workspace_id,
            &agent.session_id,
            reason,
        );
        cancelled.push(agent.session_id.clone());
    }
    cancelled
}

/// 取消在给定消息中派发、且仍在运行的 Worker（编辑重发 / 重新生成替换消息时）。
pub(crate) fn cancel_workers_dispatched_in_core(
    coordinator: &WorkspaceCoordinator,
    chat_v2_state: &ChatV2State,
    workspace_id: &str,
    message_ids: &[String],
) -> Vec<String> {
    if message_ids.is_empty() {
        return Vec::new();
    }
    let agents = match coordinator.list_agents(workspace_id) {
        Ok(agents) => agents,
        Err(error) => {
            log::warn!("[SuperSession] list_agents failed (superseded): {error}");
            return Vec::new();
        }
    };
    let mut cancelled = Vec::new();
    for agent in agents
        .iter()
        .filter(|a| is_super_worker(a) && is_active_agent_status(&a.status))
    {
        let Some(dispatched_in) = agent_super_str(agent, WORKER_META_DISPATCHED_IN) else {
            continue;
        };
        if !message_ids.iter().any(|id| id == &dispatched_in) {
            continue;
        }
        // 先打标记再取消：取消回执（完成闭包异步写入收件箱）投递时据此被吞掉。
        if let Err(error) =
            patch_agent_super_meta(coordinator, workspace_id, &agent.session_id, |m| {
                m.insert(WORKER_META_SUPERSEDED.to_string(), Value::Bool(true));
            })
        {
            log::warn!(
                "[SuperSession] Failed to mark {} superseded: {}",
                agent.session_id,
                error
            );
        }
        cancel_worker_core(
            coordinator,
            chat_v2_state,
            workspace_id,
            &agent.session_id,
            "superseded by edit/regenerate",
        );
        cancelled.push(agent.session_id.clone());
    }
    cancelled
}

// ============================================================================
// AppHandle 层
// ============================================================================

pub(crate) fn chat_db_from_app(app: &AppHandle) -> Result<Arc<ChatV2Database>, String> {
    app.try_state::<Arc<ChatV2Database>>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| "ChatV2Database 未初始化".to_string())
}

pub(crate) fn coordinator_from_app(app: &AppHandle) -> Result<Arc<WorkspaceCoordinator>, String> {
    app.try_state::<Arc<WorkspaceCoordinator>>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| "WorkspaceCoordinator 未初始化".to_string())
}

pub(crate) fn chat_state_from_app(app: &AppHandle) -> Option<Arc<ChatV2State>> {
    app.try_state::<Arc<ChatV2State>>()
        .map(|s| s.inner().clone())
}

fn pending_inbox(coordinator: &WorkspaceCoordinator, workspace_id: &str, session_id: &str) -> u32 {
    coordinator
        .pending_inbox_count(workspace_id, session_id)
        .map(|n| u32::try_from(n).unwrap_or(u32::MAX))
        .unwrap_or(0)
}

pub fn disabled_state() -> SuperSessionState {
    SuperSessionState::default()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangedPayload<'a> {
    enabled: bool,
    session_id: Option<&'a str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InboxChangedPayload<'a> {
    session_id: &'a str,
    pending_inbox: u32,
}

/// 发 `super_session_changed {enabled, sessionId}`（关闭时 sessionId 为 null）。
pub fn emit_changed(app: &AppHandle, enabled: bool, session_id: Option<&str>) {
    if let Err(error) = app.emit(
        EVENT_SUPER_SESSION_CHANGED,
        ChangedPayload {
            enabled,
            session_id,
        },
    ) {
        log::warn!("[SuperSession] emit {EVENT_SUPER_SESSION_CHANGED} failed: {error}");
    }
}

/// 发 `super_session_inbox_changed {sessionId, pendingInbox}`。
pub fn emit_inbox_changed(
    app: &AppHandle,
    coordinator: &WorkspaceCoordinator,
    session_id: &str,
    workspace_id: &str,
) {
    let payload = InboxChangedPayload {
        session_id,
        pending_inbox: pending_inbox(coordinator, workspace_id, session_id),
    };
    if let Err(error) = app.emit(EVENT_SUPER_SESSION_INBOX_CHANGED, payload) {
        log::warn!("[SuperSession] emit {EVENT_SUPER_SESSION_INBOX_CHANGED} failed: {error}");
    }
}

/// ensure（AppHandle 层）：唯一性、去 hidden / 新建会话 + 新建工作区 + 注册 Coordinator。
/// 不检查开关（调用方负责）。新建时初始化会话 runtime roots。
pub fn ensure(app: &AppHandle) -> Result<SuperSessionState, String> {
    let db = chat_db_from_app(app)?;
    let coordinator = coordinator_from_app(app)?;
    let outcome = ensure_core(&db, &coordinator)?;
    if outcome.created {
        if let Err(error) =
            crate::chat_v2::runtime_roots::ensure_session_runtime_roots(app, &outcome.session_id)
        {
            log::warn!(
                "[SuperSession] Failed to initialize runtime roots for {}: {}",
                outcome.session_id,
                error
            );
        }
    }
    Ok(SuperSessionState {
        enabled: true,
        pending_inbox: pending_inbox(&coordinator, &outcome.workspace_id, &outcome.session_id),
        session_id: Some(outcome.session_id),
        workspace_id: Some(outcome.workspace_id),
    })
}

/// 当前状态。启用时顺带 ensure（幂等自愈：去重、工作区健康）。
pub fn get_state(app: &AppHandle) -> SuperSessionState {
    if !is_enabled(app) {
        return disabled_state();
    }
    match ensure(app) {
        Ok(state) => state,
        Err(error) => {
            log::warn!("[SuperSession] ensure failed in get_state: {error}");
            let mut state = SuperSessionState {
                enabled: true,
                ..SuperSessionState::default()
            };
            if let Ok(db) = chat_db_from_app(app) {
                if let Some(current) = current_super(&db) {
                    state.session_id = Some(current.session_id);
                    state.workspace_id = current.workspace_id;
                }
            }
            state
        }
    }
}

/// 开关。开启：写 settings → ensure → 发事件；关闭：写 settings → 取消活跃 Worker → hidden → 发事件。
pub fn set_enabled(app: &AppHandle, enabled: bool) -> Result<SuperSessionState, String> {
    let main_db = main_db_from_app(app).ok_or_else(|| "主数据库未初始化".to_string())?;
    write_enabled(&main_db, enabled)?;
    if enabled {
        let state = ensure(app)?;
        emit_changed(app, true, state.session_id.as_deref());
        return Ok(state);
    }
    let db = chat_db_from_app(app)?;
    if let Some(current) = current_super(&db) {
        if let (Some(workspace_id), Ok(coordinator), Some(chat_state)) = (
            current.workspace_id.as_deref(),
            coordinator_from_app(app),
            chat_state_from_app(app),
        ) {
            let cancelled = cancel_active_workers(
                &coordinator,
                &chat_state,
                workspace_id,
                "super_session_disabled",
            );
            if !cancelled.is_empty() {
                log::info!(
                    "[SuperSession] Disabled: cancelled {} active worker(s)",
                    cancelled.len()
                );
            }
        }
        if let Err(error) = set_hidden(&db, &current.session_id, true) {
            log::warn!("[SuperSession] Failed to hide Super session: {error}");
        }
    }
    emit_changed(app, false, None);
    Ok(disabled_state())
}

/// 会话被软删 / 硬删后的钩子（manage_session 在删除成功后调用，仅对带 super_agent 标记的会话）。
///
/// 取消 Worker；硬删删工作区、软删关工作区；已启用则 ensure() 新建空 Super；
/// 发 `super_session_changed{sessionId}`。错误只记日志。
pub fn on_session_removed(app: &AppHandle, session_id: &str, hard: bool) {
    let db = match chat_db_from_app(app) {
        Ok(db) => db,
        Err(error) => {
            log::warn!("[SuperSession] on_session_removed: {error}");
            return;
        }
    };
    if let Ok(coordinator) = coordinator_from_app(app) {
        let mut workspaces = super_workspaces_created_by(&db, session_id);
        if let Ok(Some(session)) = ChatV2Repo::get_session_v2(&db, session_id) {
            if let Some(ws) = metadata_workspace_id(session.metadata.as_ref()) {
                if !workspaces.contains(&ws) {
                    workspaces.push(ws);
                }
            }
        }
        let chat_state = chat_state_from_app(app);
        for workspace_id in &workspaces {
            if let Some(state) = chat_state.as_ref() {
                cancel_active_workers(&coordinator, state, workspace_id, "super_session_removed");
            }
            let result = if hard {
                coordinator.delete_workspace(workspace_id)
            } else {
                coordinator.close_workspace(workspace_id)
            };
            if let Err(error) = result {
                log::warn!(
                    "[SuperSession] Failed to {} workspace {} of removed Super {}: {}",
                    if hard { "delete" } else { "close" },
                    workspace_id,
                    session_id,
                    error
                );
            }
        }
    }
    if is_enabled(app) {
        match ensure(app) {
            Ok(state) => emit_changed(app, true, state.session_id.as_deref()),
            Err(error) => {
                log::warn!("[SuperSession] ensure after removal failed: {error}");
                emit_changed(app, true, None);
            }
        }
    } else {
        emit_changed(app, false, None);
    }
}

/// 编辑重发 / 重新生成替换消息时调用：取消这些消息里派发且仍在运行的 Worker。
/// 普通会话、非活跃 Super 为 no-op。同步、不阻塞（取消只是停流 + 落库）。
pub fn cancel_workers_dispatched_in(app: &AppHandle, session_id: &str, message_ids: &[String]) {
    if message_ids.is_empty() {
        return;
    }
    let Ok(db) = chat_db_from_app(app) else {
        return;
    };
    let Ok(Some(session)) = ChatV2Repo::get_session_v2(&db, session_id) else {
        return;
    };
    let meta = session.metadata.as_ref();
    if !is_active_super_metadata(meta) {
        return;
    }
    let Some(workspace_id) = metadata_workspace_id(meta) else {
        return;
    };
    let (Ok(coordinator), Some(chat_state)) = (coordinator_from_app(app), chat_state_from_app(app))
    else {
        return;
    };
    let cancelled =
        cancel_workers_dispatched_in_core(&coordinator, &chat_state, &workspace_id, message_ids);
    if !cancelled.is_empty() {
        log::info!(
            "[SuperSession] Cancelled {} superseded worker(s) in {}: {:?}",
            cancelled.len(),
            session_id,
            cancelled
        );
    }
}

// ============================================================================
// 管线入口钩子
// ============================================================================

/// 管线入口钩子（ChatV2Pipeline::execute / execute_with_emitter 入口各调一次，幂等）。
///
/// 仅 active && enabled && !hidden 时生效：
/// - `request.workspace_id = None`（不触发 Stage 5.5 注入）；
/// - `options.super_session = Some(SuperTurn{workspace_id})`；
/// - 有窗口时把 4 个 Super 工具 schema 按名去重追加到 `options.mcp_tool_schemas`，
///   若 `execution_allowed_tools` 为 Some 同时追加名字；无窗口不加工具。
pub fn apply_turn_overrides(
    db: &ChatV2Database,
    main_db: Option<&Database>,
    request: &mut SendMessageRequest,
    has_window: bool,
) {
    let Some(main_db) = main_db else {
        return;
    };
    if !read_enabled(main_db) {
        return;
    }
    let session = match ChatV2Repo::get_session_v2(db, &request.session_id) {
        Ok(Some(session)) => session,
        Ok(None) => return,
        Err(error) => {
            log::warn!(
                "[SuperSession] apply_turn_overrides: failed to load session {}: {}",
                request.session_id,
                error
            );
            return;
        }
    };
    if session.persist_status != PersistStatus::Active {
        return;
    }
    let meta = session.metadata.as_ref();
    if !is_active_super_metadata(meta) || metadata_hidden(meta) {
        return;
    }
    let Some(workspace_id) = metadata_workspace_id(meta) else {
        log::warn!(
            "[SuperSession] Active Super session {} has no workspace_id; skipping overrides",
            request.session_id
        );
        return;
    };
    apply_super_turn(request, &workspace_id, has_window);
}

/// 钩子的纯变换部分（幂等）。
pub(crate) fn apply_super_turn(
    request: &mut SendMessageRequest,
    workspace_id: &str,
    has_window: bool,
) {
    request.workspace_id = None;
    let options = request.options.get_or_insert_with(SendOptions::default);
    options.super_session = Some(SuperTurn {
        workspace_id: workspace_id.to_string(),
    });
    if !has_window {
        return;
    }
    let schemas = options.mcp_tool_schemas.get_or_insert_with(Vec::new);
    for raw in super_tool_schemas() {
        match serde_json::from_value::<McpToolSchema>(raw) {
            Ok(schema) => {
                if !schemas.iter().any(|existing| existing.name == schema.name) {
                    schemas.push(schema);
                }
            }
            Err(error) => {
                log::error!("[SuperSession] Invalid Super tool schema: {error}");
            }
        }
    }
    if let Some(allowed) = options.execution_allowed_tools.as_mut() {
        for name in SUPER_TOOL_NAMES {
            if !allowed.iter().any(|existing| existing == name) {
                allowed.push(name.to_string());
            }
        }
    }
}

// ============================================================================
// init + legacy 迁移
// ============================================================================

/// 旧 superagent.db 迁移：读 `sa_kv.enabled` → 若 settings 尚无 `super_agent.enabled` 则写入；
/// 文件（含 -wal/-shm）改名为 `.legacy`。不导入历史。返回旧库记录的开关值（若有）。
pub(crate) fn migrate_legacy_db(path: &Path, main_db: &Database) -> Result<Option<bool>, String> {
    let legacy_enabled = {
        let conn = rusqlite::Connection::open(path)
            .map_err(|e| format!("打开旧 superagent.db 失败: {e}"))?;
        let value: Option<String> = conn
            .query_row("SELECT value FROM sa_kv WHERE key = 'enabled'", [], |row| {
                row.get(0)
            })
            .optional()
            .unwrap_or_else(|error| {
                log::warn!("[SuperSession] Legacy sa_kv unreadable: {error}");
                None
            });
        value.map(|v| v.trim() == "true")
    }; // 连接在此关闭，之后才能改名（Windows 文件锁）
    if let Some(flag) = legacy_enabled {
        let already_set = main_db
            .get_setting(SETTING_ENABLED)
            .ok()
            .flatten()
            .is_some();
        if !already_set {
            write_enabled(main_db, flag)?;
        }
    }
    for suffix in ["", "-wal", "-shm"] {
        let mut from = path.as_os_str().to_owned();
        from.push(suffix);
        let from = PathBuf::from(from);
        if !from.exists() {
            continue;
        }
        let mut to = from.as_os_str().to_owned();
        to.push(".legacy");
        let mut to = PathBuf::from(to);
        if to.exists() {
            let mut alt = to.as_os_str().to_owned();
            alt.push(format!(".{}", chrono::Utc::now().timestamp_millis()));
            to = PathBuf::from(alt);
        }
        std::fs::rename(&from, &to).map_err(|e| format!("重命名 {} 失败: {e}", from.display()))?;
    }
    Ok(legacy_enabled)
}

/// 应用启动时调用：旧库迁移；启用时 ensure()。不启动任何后台循环。错误只记日志。
pub fn init(app: &AppHandle) {
    if let Some(main_db) = main_db_from_app(app) {
        match app.path().app_data_dir() {
            Ok(dir) => {
                let legacy = dir.join("superagent").join("superagent.db");
                if legacy.exists() {
                    match migrate_legacy_db(&legacy, &main_db) {
                        Ok(flag) => log::info!(
                            "[SuperSession] Migrated legacy superagent.db (enabled={flag:?})"
                        ),
                        Err(error) => {
                            log::warn!(
                                "[SuperSession] Legacy superagent.db migration failed: {error}"
                            )
                        }
                    }
                }
            }
            Err(error) => log::warn!("[SuperSession] app_data_dir unavailable: {error}"),
        }
    } else {
        log::warn!("[SuperSession] init: main database unavailable");
    }
    if is_enabled(app) {
        match ensure(app) {
            Ok(state) => log::info!(
                "[SuperSession] initialized: session={:?}, workspace={:?}, pending={}",
                state.session_id,
                state.workspace_id,
                state.pending_inbox
            ),
            Err(error) => log::warn!("[SuperSession] ensure on init failed: {error}"),
        }
    } else {
        log::info!("[SuperSession] initialized (disabled)");
    }
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::super::test_support::{chat_db, coordinator_for, main_db};
    use super::*;
    use crate::chat_v2::workspace::SubagentTaskData;

    fn session_meta(db: &ChatV2Database, id: &str) -> Value {
        ChatV2Repo::get_session_v2(db, id)
            .unwrap()
            .unwrap()
            .metadata
            .unwrap_or(Value::Null)
    }

    #[test]
    fn ensure_is_idempotent_and_binds_workspace() {
        let (_d, db) = chat_db();
        let (_w, coordinator) = coordinator_for(&db);
        let first = ensure_core(&db, &coordinator).unwrap();
        assert!(first.created);
        let second = ensure_core(&db, &coordinator).unwrap();
        assert!(!second.created);
        assert_eq!(
            first,
            EnsureOutcome {
                created: true,
                ..second.clone()
            }
        );
        assert_eq!(
            list_active_super_ids(&db).unwrap(),
            vec![first.session_id.clone()]
        );

        let session = ChatV2Repo::get_session_v2(&db, &first.session_id)
            .unwrap()
            .unwrap();
        assert_eq!(session.title.as_deref(), Some(SUPER_SESSION_TITLE));
        assert!(session.title_locked);
        assert_eq!(session.mode, "chat");
        let meta = session.metadata.unwrap();
        assert_eq!(meta["pinned"], true);
        assert_eq!(meta["super_agent"]["active"], true);
        assert_eq!(meta["super_agent"]["version"], 1);
        assert_eq!(meta["super_agent"]["hidden"], false);
        assert_eq!(
            meta["super_agent"]["workspace_id"],
            first.workspace_id.as_str()
        );

        let agent = coordinator
            .get_agent(&first.workspace_id, &first.session_id)
            .unwrap()
            .expect("Super registered as coordinator");
        assert_eq!(agent.role, AgentRole::Coordinator);
    }

    #[test]
    fn ensure_recreates_after_removal() {
        let (_d, db) = chat_db();
        let (_w, coordinator) = coordinator_for(&db);
        let first = ensure_core(&db, &coordinator).unwrap();
        // 软删（进回收站）后不再是活跃会话
        let mut session = ChatV2Repo::get_session_v2(&db, &first.session_id)
            .unwrap()
            .unwrap();
        session.persist_status = PersistStatus::Deleted;
        ChatV2Repo::update_session_v2(&db, &session).unwrap();
        coordinator.close_workspace(&first.workspace_id).unwrap();

        let second = ensure_core(&db, &coordinator).unwrap();
        assert!(second.created);
        assert_ne!(second.session_id, first.session_id);
        assert_ne!(second.workspace_id, first.workspace_id);
        assert_eq!(list_active_super_ids(&db).unwrap(), vec![second.session_id]);
    }

    #[test]
    fn ensure_replaces_closed_workspace() {
        let (_d, db) = chat_db();
        let (_w, coordinator) = coordinator_for(&db);
        let first = ensure_core(&db, &coordinator).unwrap();
        coordinator.close_workspace(&first.workspace_id).unwrap();
        let again = ensure_core(&db, &coordinator).unwrap();
        assert_eq!(again.session_id, first.session_id);
        assert_ne!(again.workspace_id, first.workspace_id);
        assert_eq!(
            metadata_workspace_id(Some(&session_meta(&db, &first.session_id))),
            Some(again.workspace_id)
        );
    }

    #[test]
    fn hidden_on_disable_and_restored_on_enable() {
        let (_d, db) = chat_db();
        let (_w, coordinator) = coordinator_for(&db);
        let first = ensure_core(&db, &coordinator).unwrap();
        assert!(set_hidden(&db, &first.session_id, true).unwrap());
        assert!(!set_hidden(&db, &first.session_id, true).unwrap());
        let current = current_super(&db).unwrap();
        assert!(current.hidden);
        // 开启时 ensure 去掉 hidden，沿用同一会话与工作区
        let again = ensure_core(&db, &coordinator).unwrap();
        assert!(!again.created);
        assert_eq!(again.session_id, first.session_id);
        assert_eq!(again.workspace_id, first.workspace_id);
        assert!(!current_super(&db).unwrap().hidden);
    }

    #[test]
    fn multiple_active_keeps_only_newest() {
        let (_d, db) = chat_db();
        let (_w, coordinator) = coordinator_for(&db);
        let older = create_super_session(&db).unwrap();
        let mut newer = ChatSession::new(ChatSession::generate_id(), "chat".to_string());
        newer.metadata = Some(new_super_metadata());
        newer.created_at = older.created_at + chrono::Duration::seconds(5);
        newer.updated_at = newer.created_at;
        ChatV2Repo::create_session_v2(&db, &newer).unwrap();

        let outcome = ensure_core(&db, &coordinator).unwrap();
        assert_eq!(outcome.session_id, newer.id);
        assert_eq!(list_active_super_ids(&db).unwrap(), vec![newer.id.clone()]);
        let retired = session_meta(&db, &older.id);
        assert_eq!(retired["super_agent"]["active"], false);
        assert!(retired["super_agent"]["retired_at"].is_string());
        assert!(retired.get("pinned").is_none());
    }

    #[test]
    fn retire_metadata_shapes_and_ignores_plain_sessions() {
        let mut meta = json!({
            "super_agent": {"active": true, "version": 1, "workspace_id": "ws_1", "hidden": false},
            "pinned": true,
            "other": 1
        });
        retire_metadata(&mut meta);
        assert_eq!(meta["super_agent"]["active"], false);
        assert!(meta["super_agent"].get("workspace_id").is_none());
        assert!(meta.get("pinned").is_none());
        assert_eq!(meta["other"], 1);
        assert!(!is_active_super_metadata(Some(&meta)));

        // 普通会话：不动（保留用户置顶）
        let mut plain = json!({"pinned": true});
        retire_metadata(&mut plain);
        assert_eq!(plain, json!({"pinned": true}));
        let mut null = Value::Null;
        retire_metadata(&mut null);
        assert_eq!(null, Value::Null);
    }

    #[test]
    fn branch_clone_is_stripped_of_super_identity() {
        // 分支会克隆 metadata：克隆体经 retire_metadata 后不再是活跃 Super、无置顶
        let (_d, db) = chat_db();
        let (_w, coordinator) = coordinator_for(&db);
        let outcome = ensure_core(&db, &coordinator).unwrap();
        let mut cloned = session_meta(&db, &outcome.session_id);
        retire_metadata(&mut cloned);
        let mut branch = ChatSession::new(ChatSession::generate_id(), "chat".to_string());
        branch.metadata = Some(cloned);
        ChatV2Repo::create_session_v2(&db, &branch).unwrap();
        assert_eq!(
            list_active_super_ids(&db).unwrap(),
            vec![outcome.session_id.clone()]
        );
        let meta = session_meta(&db, &branch.id);
        assert!(meta.get("pinned").is_none());
        assert_eq!(meta["super_agent"]["active"], false);
    }

    #[test]
    fn super_workspace_lookup_by_creator_survives_hard_delete() {
        let (_d, db) = chat_db();
        let (_w, coordinator) = coordinator_for(&db);
        let outcome = ensure_core(&db, &coordinator).unwrap();
        ChatV2Repo::delete_session_v2(&db, &outcome.session_id).unwrap();
        assert_eq!(
            super_workspaces_created_by(&db, &outcome.session_id),
            vec![outcome.workspace_id]
        );
        assert!(super_workspaces_created_by(&db, "sess_other").is_empty());
    }

    #[test]
    fn settings_roundtrip() {
        let (_m, main) = main_db();
        assert!(!read_enabled(&main));
        write_enabled(&main, true).unwrap();
        assert!(read_enabled(&main));
        write_enabled(&main, false).unwrap();
        assert!(!read_enabled(&main));

        assert_eq!(read_settings(&main), SuperSessionSettings::default());
        write_settings(
            &main,
            &SuperSessionSettings {
                instructions: format!("  {}  ", "x".repeat(MAX_INSTRUCTIONS_CHARS + 10)),
            },
        )
        .unwrap();
        assert_eq!(
            read_settings(&main).instructions.chars().count(),
            MAX_INSTRUCTIONS_CHARS
        );
    }

    #[test]
    fn legacy_db_migration_copies_enabled_and_renames() {
        let (_m, main) = main_db();
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("superagent.db");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE sa_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO sa_kv (key, value) VALUES ('enabled', 'true');",
            )
            .unwrap();
        }
        assert_eq!(migrate_legacy_db(&path, &main).unwrap(), Some(true));
        assert!(read_enabled(&main));
        assert!(!path.exists());
        assert!(dir.path().join("superagent.db.legacy").exists());
    }

    #[test]
    fn legacy_db_migration_does_not_override_existing_setting() {
        let (_m, main) = main_db();
        write_enabled(&main, false).unwrap();
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("superagent.db");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE sa_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO sa_kv (key, value) VALUES ('enabled', 'true');",
            )
            .unwrap();
        }
        assert_eq!(migrate_legacy_db(&path, &main).unwrap(), Some(true));
        assert!(!read_enabled(&main));
        // 无 sa_kv 的残缺库：不报错、照样改名
        let path2 = dir.path().join("other.db");
        rusqlite::Connection::open(&path2)
            .unwrap()
            .execute_batch("CREATE TABLE unrelated (x INTEGER);")
            .unwrap();
        assert_eq!(migrate_legacy_db(&path2, &main).unwrap(), None);
        assert!(dir.path().join("other.db.legacy").exists());
    }

    fn request(session_id: &str) -> SendMessageRequest {
        SendMessageRequest {
            session_id: session_id.to_string(),
            content: "hi".to_string(),
            options: None,
            user_message_id: None,
            assistant_message_id: None,
            user_context_refs: None,
            path_map: None,
            workspace_id: Some("ws_frontend".to_string()),
        }
    }

    #[test]
    fn turn_overrides_only_for_active_enabled_visible_super() {
        let (_d, db) = chat_db();
        let (_w, coordinator) = coordinator_for(&db);
        let (_m, main) = main_db();
        let outcome = ensure_core(&db, &coordinator).unwrap();

        // 未启用：不动
        let mut req = request(&outcome.session_id);
        apply_turn_overrides(&db, Some(&main), &mut req, true);
        assert_eq!(req.workspace_id.as_deref(), Some("ws_frontend"));
        assert!(req.options.is_none());

        // 无主库：不动
        write_enabled(&main, true).unwrap();
        let mut req = request(&outcome.session_id);
        apply_turn_overrides(&db, None, &mut req, true);
        assert!(req.options.is_none());

        // 普通会话：不动
        let mut plain = ChatSession::new(ChatSession::generate_id(), "chat".to_string());
        plain.metadata = Some(json!({"pinned": true}));
        ChatV2Repo::create_session_v2(&db, &plain).unwrap();
        let mut req = request(&plain.id);
        apply_turn_overrides(&db, Some(&main), &mut req, true);
        assert!(req.options.is_none());

        // hidden：不动
        set_hidden(&db, &outcome.session_id, true).unwrap();
        let mut req = request(&outcome.session_id);
        apply_turn_overrides(&db, Some(&main), &mut req, true);
        assert!(req.options.is_none());
        set_hidden(&db, &outcome.session_id, false).unwrap();

        // 活跃 + 启用 + 可见：生效
        let mut req = request(&outcome.session_id);
        apply_turn_overrides(&db, Some(&main), &mut req, true);
        assert!(req.workspace_id.is_none());
        let options = req.options.as_ref().unwrap();
        assert_eq!(
            options.super_session,
            Some(SuperTurn {
                workspace_id: outcome.workspace_id.clone()
            })
        );
        let names: Vec<&str> = options
            .mcp_tool_schemas
            .as_ref()
            .unwrap()
            .iter()
            .map(|s| s.name.as_str())
            .collect();
        assert_eq!(names, SUPER_TOOL_NAMES.to_vec());
    }

    #[test]
    fn turn_overrides_are_idempotent_and_respect_window_and_allowlist() {
        let mut req = request("sess_x");
        let mut options = SendOptions::default();
        options.execution_allowed_tools = Some(vec!["builtin-web_search".to_string()]);
        req.options = Some(options);
        apply_super_turn(&mut req, "ws_1", true);
        apply_super_turn(&mut req, "ws_1", true);
        let options = req.options.as_ref().unwrap();
        assert_eq!(options.mcp_tool_schemas.as_ref().unwrap().len(), 4);
        let allowed = options.execution_allowed_tools.as_ref().unwrap();
        assert_eq!(allowed.len(), 5);
        for name in SUPER_TOOL_NAMES {
            assert_eq!(allowed.iter().filter(|a| *a == name).count(), 1);
        }

        // 无窗口：只打标记，不加工具
        let mut headless = request("sess_y");
        apply_super_turn(&mut headless, "ws_1", false);
        let options = headless.options.as_ref().unwrap();
        assert!(options.super_session.is_some());
        assert!(options.mcp_tool_schemas.is_none());
        assert!(headless.workspace_id.is_none());
    }

    #[test]
    fn frontend_cannot_forge_super_session_marker() {
        let options: SendOptions = serde_json::from_value(json!({
            "superSession": {"workspaceId": "ws_evil"},
            "super_session": {"workspace_id": "ws_evil"},
            "userMessageOrigin": {"kind": "super_inbox"},
        }))
        .unwrap();
        assert!(options.super_session.is_none());
        assert!(options.user_message_origin.is_none());
    }

    fn add_worker(coordinator: &WorkspaceCoordinator, ws: &str, id: &str, dispatched_in: &str) {
        coordinator
            .register_agent(
                ws,
                id,
                AgentRole::Worker,
                None,
                Some(json!({"super_agent": {"title": "整理错题", "dispatched_in_message_id": dispatched_in}})),
            )
            .unwrap();
        coordinator
            .update_agent_status(ws, id, AgentStatus::Running)
            .unwrap();
        let tm = coordinator.get_task_manager(ws).unwrap();
        let task = SubagentTaskData::new(ws.to_string(), id.to_string(), None, Some("t".into()));
        tm.create_task(&task).unwrap();
        tm.update_status(&task.id, SubagentTaskStatus::Running, None)
            .unwrap();
    }

    #[test]
    fn cancel_dispatched_in_only_hits_replaced_messages() {
        let (_d, db) = chat_db();
        let (_w, coordinator) = coordinator_for(&db);
        let outcome = ensure_core(&db, &coordinator).unwrap();
        let ws = &outcome.workspace_id;
        add_worker(&coordinator, ws, "subagent_explorer_a", "msg_old");
        add_worker(&coordinator, ws, "subagent_explorer_b", "msg_keep");
        let state = ChatV2State::new();

        let cancelled =
            cancel_workers_dispatched_in_core(&coordinator, &state, ws, &["msg_old".to_string()]);
        assert_eq!(cancelled, vec!["subagent_explorer_a".to_string()]);
        let a = coordinator
            .get_agent(ws, "subagent_explorer_a")
            .unwrap()
            .unwrap();
        assert_eq!(a.status, AgentStatus::Cancelled);
        assert!(agent_super_flag(&a, WORKER_META_SUPERSEDED));
        assert_eq!(
            agent_super_str(&a, WORKER_META_TITLE).as_deref(),
            Some("整理错题")
        );
        let b = coordinator
            .get_agent(ws, "subagent_explorer_b")
            .unwrap()
            .unwrap();
        assert_eq!(b.status, AgentStatus::Running);
        assert!(!agent_super_flag(&b, WORKER_META_SUPERSEDED));
        assert!(cancel_workers_dispatched_in_core(&coordinator, &state, ws, &[]).is_empty());
    }

    #[test]
    fn cancel_active_workers_on_disable_marks_superseded() {
        let (_d, db) = chat_db();
        let (_w, coordinator) = coordinator_for(&db);
        let outcome = ensure_core(&db, &coordinator).unwrap();
        let ws = &outcome.workspace_id;
        add_worker(&coordinator, ws, "subagent_explorer_a", "m1");
        let state = ChatV2State::new();
        let cancelled = cancel_active_workers(&coordinator, &state, ws, "disabled");
        assert_eq!(cancelled, vec!["subagent_explorer_a".to_string()]);
        let a = coordinator
            .get_agent(ws, "subagent_explorer_a")
            .unwrap()
            .unwrap();
        assert_eq!(a.status, AgentStatus::Cancelled);
        assert!(agent_super_flag(&a, WORKER_META_SUPERSEDED));
        // Coordinator（Super 自身）不受影响
        let me = coordinator
            .get_agent(ws, &outcome.session_id)
            .unwrap()
            .unwrap();
        assert_eq!(me.role, AgentRole::Coordinator);
        assert_ne!(me.status, AgentStatus::Cancelled);
    }
}
