/**
 * super_session/state.rs：Super 会话状态机。
 *
 * 覆盖：settings 开关、会话唯一性（ensure）、开关、退役、删除后重建、
 * Worker 取消、管线入口钩子（apply_turn_overrides）。
 *
 * 与 Rust 一致的语义要点：
 * - 会话标识只有一处真源：会话 metadata `super_agent`（无独立指针）；
 * - 活跃：`{active:true, version:1, workspace_id, hidden}` + `pinned:true`；
 *   退役：`{active:false, retired_at}` 且去掉 `pinned`；
 * - `ensure` / `ensure_workspace` 全程同步：Rust 的进程级 ENSURE_LOCK 防的是
 *   “读 metadata → 建工作区 → 回写”之间被另一次 ensure 插入；TS 事件循环里这段
 *   同步代码本身不可分割，因此不需要显式锁；
 * - 错误文案逐字保留（如 `Agent not found: {id}`）；
 * - `log::warn!` 后继续的分支保持“只告警并继续”，`?` 的分支向上抛。
 *
 * 跨 lane 依赖只声明本模块实际消费的最小接口，由组合根（index.ts）从
 * `ctx.get('chatSession')` / `ctx.get('agentWorkspace')` / `ctx.get('chatState')` 注入。
 */

import { chronoRfc3339 } from '../../../platform/time/index.ts';
import type { ChangedPayload, InboxChangedPayload } from '../../../../contracts/ipc/generated/L06-agent-orchestration.ts';
import type { ChatSession } from '../../chat/api.ts';
import type { AgentRole, AgentStatus, JsonValue, SubagentTaskData, Workspace, WorkspaceAgent } from '../../agent-workspace/api.ts';
import type { SuperSessionState } from '../api.ts';
import { isExternalSender } from './inbound.ts';
import { readEnabled, writeEnabled, type SuperSettingsStore } from './settings.ts';
import {
  applySuperTurn, isActiveSuperMetadata, metadataHidden, metadataWorkspaceId, newSuperMetadata,
  retireSuperMetadata, SUPER_AGENT_META_KEY, type SuperTurnRequest,
} from './super-session.ts';

// ============================================================================
// 常量（state.rs:36–55, 682–708）
// ============================================================================

export const SUPER_SESSION_TITLE = 'Super-agent';
/** Super 工作区名（workspace_index.name；硬删后会话行已不存在，靠它定位工作区）。 */
export const SUPER_WORKSPACE_NAME = 'Super-agent';
export const EVENT_SUPER_SESSION_CHANGED = 'super_session_changed';
export const EVENT_SUPER_SESSION_INBOX_CHANGED = 'super_session_inbox_changed';

/** Worker agent metadata `super_agent.*` 字段名。 */
export const WORKER_META_TITLE = 'title';
export const WORKER_META_DISPATCHED_IN = 'dispatched_in_message_id';
export const WORKER_META_CLOSED_BY_ROUTER = 'closed_by_router';
export const WORKER_META_SUPERSEDED = 'superseded';
export const WORKER_META_INTERRUPT_REPORTED = 'interrupt_reported_task_id';

/**
 * `SendOptions.super_session` / `user_message_origin` 在 Rust 里是 `#[serde(skip)]`：
 * 后端内部字段，前端 JSON 无法设置。
 */
export const BACKEND_ONLY_SEND_OPTION_KEYS = [
  'superSession', 'super_session', 'userMessageOrigin', 'user_message_origin',
] as const;

// ============================================================================
// 对外类型（state.rs:61–91）
// ============================================================================

/** 当前活跃 Super 会话的快照（只读查询结果）。 */
export interface CurrentSuper {
  sessionId: string;
  workspaceId: string | null;
  hidden: boolean;
}

/** `ensure_core` 的结果。 */
export interface EnsureOutcome {
  sessionId: string;
  workspaceId: string;
  /** 本次新建了会话。 */
  created: boolean;
}

export interface SuperSessionLogger {
  info(message: string): void;
  warn(message: string): void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ============================================================================
// 跨 lane 最小消费接口
// ============================================================================

/** `chatSession` 中本模块消费的会话读写子集（= ChatV2Repo::{get,create,update}_session_v2）。 */
export interface SuperChatSessions {
  getSession(sessionId: string): ChatSession | null;
  createSession(session: ChatSession): void;
  updateSession(session: ChatSession): void;
}

/**
 * 会话表的只读查询（SQL 在 repository/super-session.ts）：
 * - `listActiveSuperIds`：`persist_status='active'` 且 `$.super_agent.active` 为真，最新在前；
 * - `workspacesCreatedBy`：`workspace_index` 中该会话创建、名为 `Super-agent` 的工作区。
 */
export interface SuperSessionLookup {
  listActiveSuperIds(): string[];
  workspacesCreatedBy(sessionId: string): string[];
}

/** `agentWorkspace` 中本模块消费的工作区/agent/收件箱子集。 */
export interface SuperWorkspaceCoordinator {
  getWorkspace(workspaceId: string): Workspace | null;
  createWorkspace(creatorSessionId: string, name: string | null): Workspace;
  closeWorkspace(workspaceId: string): void;
  deleteWorkspace(workspaceId: string): void;
  registerAgent(
    workspaceId: string, sessionId: string, role: AgentRole, skillId: string | null, metadata: JsonValue | null,
  ): WorkspaceAgent;
  getAgent(workspaceId: string, sessionId: string): WorkspaceAgent | null;
  updateAgentStatus(workspaceId: string, sessionId: string, status: AgentStatus): void;
  updateAgentMetadata(workspaceId: string, sessionId: string, metadata: JsonValue | null): void;
  listAgents(workspaceId: string): WorkspaceAgent[];
  pendingInboxCount(workspaceId: string, sessionId: string): number;
  /**
   * L05 的子代理任务仓储。`agentWorkspace` 的公开类型里还没有它，但运行时的
   * WorkspaceCoordinator 有；缺失时只跳过“任务置 cancelled”（Rust 的
   * `if let Ok(task_manager)` 同样容忍取不到）。
   */
  getTaskManager?(workspaceId: string): SuperSubagentTaskManager;
}

/** `SubagentTaskManager` 中取消 Worker 用到的子集。 */
export interface SuperSubagentTaskManager {
  getAgentTask(agentSessionId: string): SubagentTaskData | null;
  updateStatus(taskId: string, status: 'cancelled', resultSummary: string | null): void;
}

/** `chatState` 的流取消入口（`ChatV2State::cancel_stream`）。 */
export interface SuperChatStreams {
  cancelStream(sessionId: string): boolean;
}

/** state.rs:667–708 的 `ChangedPayload` / `InboxChangedPayload` 出口。 */
export interface SuperSessionEvents {
  changed(payload: ChangedPayload): void;
  inboxChanged(payload: InboxChangedPayload): void;
}

export type { ChangedPayload, InboxChangedPayload };

export interface SuperSessionDeps {
  chat: SuperChatSessions;
  lookup: SuperSessionLookup;
  workspace: SuperWorkspaceCoordinator;
  /** `chatState`；未初始化时 Rust 跳过 Worker 取消。 */
  streams: SuperChatStreams | null;
  settings: SuperSettingsStore;
  events: SuperSessionEvents;
  logger: SuperSessionLogger;
  /** 新建会话后初始化 runtime roots（Rust `ensure_session_runtime_roots`，失败只告警）。 */
  ensureRuntimeRoots?: ((sessionId: string) => void) | null;
}

// ============================================================================
// metadata 辅助（state.rs:97–220）
// ============================================================================

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/**
 * state.rs:159–177 `super_obj_mut`：取（必要时创建 metadata 中的）`super_agent` 对象。
 * 调用方先保证 `meta` 本身是对象（Rust 会把非对象 metadata 归一成 `{}`）。
 */
export function superObjectMut(meta: Record<string, unknown>): Record<string, unknown> {
  const existing = asRecord(meta[SUPER_AGENT_META_KEY]);
  if (existing !== null) return existing;
  const entry: Record<string, unknown> = {};
  meta[SUPER_AGENT_META_KEY] = entry;
  return entry;
}

/** state.rs:180–185。 */
export function agentSuperFlag(agent: WorkspaceAgent, key: string): boolean {
  const entry = asRecord(agent.metadata);
  const nested = asRecord(entry?.[SUPER_AGENT_META_KEY]);
  return nested?.[key] === true;
}

/** state.rs:188–193。 */
export function agentSuperStr(agent: WorkspaceAgent, key: string): string | null {
  const entry = asRecord(agent.metadata);
  const nested = asRecord(entry?.[SUPER_AGENT_META_KEY]);
  const value = nested?.[key];
  return typeof value === 'string' ? value : null;
}

/** state.rs:211–220：真正的 Worker（排除外部事件伪发送者与 Coordinator）。 */
export function isSuperWorker(agent: WorkspaceAgent): boolean {
  return agent.role === 'worker' && !isExternalSender(agent.sessionId);
}

export function isActiveAgentStatus(status: AgentStatus): boolean {
  return status === 'idle' || status === 'queued' || status === 'running' || status === 'interrupted';
}

// ============================================================================
// 会话读写（state.rs:277–358）
// ============================================================================

/** state.rs:278–295。 */
export function listActiveSuperIds(deps: SuperSessionDeps): string[] {
  return deps.lookup.listActiveSuperIds();
}

/** state.rs:298–314：只读，不做去重/修复。 */
export function currentSuper(deps: SuperSessionDeps): CurrentSuper | null {
  const logger = deps.logger;
  let ids: string[];
  try {
    ids = listActiveSuperIds(deps);
  } catch (error) {
    logger.warn(`[SuperSession] Failed to query active Super session: ${messageOf(error)}`);
    return null;
  }
  const sessionId = ids[0];
  if (sessionId === undefined) return null;
  let session: ChatSession | null;
  try {
    session = deps.chat.getSession(sessionId);
  } catch {
    return null;
  }
  if (session === null) return null;
  return {
    sessionId,
    workspaceId: metadataWorkspaceId(session.metadata),
    hidden: metadataHidden(session.metadata),
  };
}

/** state.rs:316–320。 */
function loadSession(deps: SuperSessionDeps, sessionId: string): ChatSession {
  const session = deps.chat.getSession(sessionId);
  if (session === null) throw new Error(`Session not found: ${sessionId}`);
  return session;
}

/**
 * state.rs:322–330。返回新建的会话；`createSession` 失败时异常向上抛。
 *
 * 与 Rust `ChatSession::new` 一致：mode=`chat`、标题锁定、metadata 为活跃 Super 标记。
 */
export function newSuperSession(now: Date = new Date()): ChatSession {
  const timestamp = chronoRfc3339(BigInt(now.getTime()) * 1_000_000n);
  return {
    id: `sess_${globalThis.crypto.randomUUID()}`,
    mode: 'chat',
    title: SUPER_SESSION_TITLE,
    titleLocked: true,
    persistStatus: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: newSuperMetadata(),
  };
}

export function createSuperSession(deps: SuperSessionDeps): ChatSession {
  const logger = deps.logger;
  const session = newSuperSession();
  deps.chat.createSession(session);
  logger.info(`[SuperSession] Created Super session ${session.id}`);
  return session;
}

/** state.rs:333–341：把会话退役（多活跃去重）。 */
function retireSession(deps: SuperSessionDeps, sessionId: string): void {
  const logger = deps.logger;
  const session = loadSession(deps, sessionId);
  const metadata = asRecord(session.metadata);
  if (metadata !== null) {
    retireSuperMetadata(metadata);
    deps.chat.updateSession({ ...session, metadata });
  } else {
    deps.chat.updateSession(session);
  }
  logger.info(`[SuperSession] Retired duplicate Super session ${sessionId}`);
}

/** state.rs:344–358：设置 hidden；返回是否实际发生变化。 */
export function setHidden(deps: SuperSessionDeps, sessionId: string, hidden: boolean): boolean {
  const session = loadSession(deps, sessionId);
  if (metadataHidden(session.metadata) === hidden) return false;
  const metadata = asRecord(session.metadata) ?? {};
  superObjectMut(metadata).hidden = hidden;
  deps.chat.updateSession({ ...session, metadata });
  return true;
}

// ============================================================================
// ensure / ensure_workspace（state.rs:360–478）
// ============================================================================

function readWorkspace(
  deps: SuperSessionDeps, workspaceId: string,
): Workspace | null {
  const logger = deps.logger;
  try {
    return deps.workspace.getWorkspace(workspaceId);
  } catch (error) {
    // Rust `if let Ok(Some(workspace))`：查询失败等同“没有可用工作区”，继续新建。
    logger.warn(`[SuperSession] Failed to read workspace ${workspaceId}: ${messageOf(error)}`);
    return null;
  }
}

/**
 * state.rs:376–430：确保 Super 会话绑定一个可用（Active）的工作区，并已注册为 Coordinator。
 * 工作区缺失 / 已关闭时新建并回填 metadata。
 */
export function ensureWorkspace(deps: SuperSessionDeps, sessionId: string): string {
  const logger = deps.logger;
  const session = loadSession(deps, sessionId);
  const bound = metadataWorkspaceId(session.metadata);
  if (bound !== null) {
    const workspace = readWorkspace(deps, bound);
    if (workspace !== null && workspace.status === 'active') {
      if (deps.workspace.getAgent(bound, sessionId) === null) {
        deps.workspace.registerAgent(bound, sessionId, 'coordinator', null, null);
      }
      return bound;
    }
  }
  const workspace = deps.workspace.createWorkspace(sessionId, SUPER_WORKSPACE_NAME);
  deps.workspace.registerAgent(workspace.id, sessionId, 'coordinator', null, null);
  const metadata = asRecord(session.metadata) ?? {};
  superObjectMut(metadata).workspace_id = workspace.id;
  deps.chat.updateSession({ ...session, metadata });
  logger.info(`[SuperSession] Bound Super session ${sessionId} to workspace ${workspace.id}`);
  return workspace.id;
}

/** state.rs:433–458：唯一性（多个只留最新、其余退役）→ 去 hidden / 新建会话 → 确保工作区。 */
export function ensureCore(deps: SuperSessionDeps): EnsureOutcome {
  const logger = deps.logger;
  const [keep, ...extras] = listActiveSuperIds(deps);
  let sessionId: string;
  let created: boolean;
  if (keep !== undefined) {
    for (const extra of extras) {
      try {
        retireSession(deps, extra);
      } catch (error) {
        logger.warn(`[SuperSession] Failed to retire duplicate ${extra}: ${messageOf(error)}`);
      }
    }
    setHidden(deps, keep, false);
    sessionId = keep;
    created = false;
  } else {
    sessionId = createSuperSession(deps).id;
    created = true;
  }
  const workspaceId = ensureWorkspace(deps, sessionId);
  return { sessionId, workspaceId, created };
}

/** state.rs:461–478：硬删后会话行已不存在时，靠 workspace_index 定位工作区。 */
export function superWorkspacesCreatedBy(deps: SuperSessionDeps, sessionId: string): string[] {
  try {
    return deps.lookup.workspacesCreatedBy(sessionId);
  } catch {
    return [];
  }
}

// ============================================================================
// Worker 取消（state.rs:480–633）
// ============================================================================

/**
 * state.rs:195–208：修改 Worker agent metadata 的 `super_agent` 子对象并落库。
 * agent 不存在时文案与 Rust 相同：`Agent not found: {id}`。
 */
export function patchAgentSuperMeta(
  deps: SuperSessionDeps, workspaceId: string, agentSessionId: string,
  patch: (entry: Record<string, unknown>) => void,
): void {
  const agent = deps.workspace.getAgent(workspaceId, agentSessionId);
  if (agent === null) throw new Error(`Agent not found: ${agentSessionId}`);
  const metadata = asRecord(agent.metadata) ?? {};
  patch(superObjectMut(metadata));
  deps.workspace.updateAgentMetadata(workspaceId, agentSessionId, metadata as JsonValue);
}

function readAgent(
  deps: SuperSessionDeps, workspaceId: string, agentSessionId: string,
): WorkspaceAgent | null {
  try {
    return deps.workspace.getAgent(workspaceId, agentSessionId);
  } catch {
    return null;
  }
}

function readTaskManager(
  deps: SuperSessionDeps, workspaceId: string,
): SuperSubagentTaskManager | null {
  const logger = deps.logger;
  if (typeof deps.workspace.getTaskManager !== 'function') {
    logger.warn(`[SuperSession] No subagent task repository on agentWorkspace; task status left unchanged for ${workspaceId}`);
    return null;
  }
  try {
    return deps.workspace.getTaskManager(workspaceId);
  } catch (error) {
    logger.warn(`[SuperSession] Failed to get task manager of ${workspaceId}: ${messageOf(error)}`);
    return null;
  }
}

/**
 * state.rs:486–538：取消单个 Worker —— 停流、pending/running 任务置 Cancelled、
 * agent 状态置 Cancelled。返回是否确实取消了什么。
 */
export function cancelWorkerCore(
  deps: SuperSessionDeps, workspaceId: string, agentSessionId: string, reason: string,
): boolean {
  const logger = deps.logger;
  const streamCancelled = deps.streams?.cancelStream(agentSessionId) ?? false;
  let taskCancelled = false;
  const taskManager = readTaskManager(deps, workspaceId);
  if (taskManager !== null) {
    let task: SubagentTaskData | null = null;
    let taskError: unknown = null;
    try {
      task = taskManager.getAgentTask(agentSessionId);
    } catch (error) {
      taskError = error;
    }
    if (taskError !== null) {
      logger.warn(`[SuperSession] Failed to query task of ${agentSessionId}: ${messageOf(taskError)}`);
    } else if (task !== null) {
      try {
        taskManager.updateStatus(task.id, 'cancelled', reason);
        taskCancelled = true;
      } catch (error) {
        logger.warn(`[SuperSession] Failed to cancel task ${task.id} of ${agentSessionId}: ${messageOf(error)}`);
      }
    }
  }
  const agent = readAgent(deps, workspaceId, agentSessionId);
  const wasRunning = agent !== null && (agent.status === 'running' || agent.status === 'queued');
  const cancelled = streamCancelled || taskCancelled || wasRunning;
  if (cancelled) {
    try {
      deps.workspace.updateAgentStatus(workspaceId, agentSessionId, 'cancelled');
    } catch (error) {
      logger.warn(`[SuperSession] Failed to mark ${agentSessionId} cancelled: ${messageOf(error)}`);
    }
    logger.info(`[SuperSession] Cancelled worker ${agentSessionId} (${reason}): had_stream=${streamCancelled}, task_cancelled=${taskCancelled}`);
  }
  return cancelled;
}

/**
 * state.rs:540–581：取消工作区内所有活跃 Worker，并标记 `superseded`
 * （其取消回执投递时被吞掉）。返回被取消的 Worker id（保持 list_agents 顺序）。
 */
export function cancelActiveWorkers(
  deps: SuperSessionDeps, workspaceId: string, reason: string,
): string[] {
  const logger = deps.logger;
  let agents: WorkspaceAgent[];
  try {
    agents = deps.workspace.listAgents(workspaceId);
  } catch (error) {
    logger.warn(`[SuperSession] list_agents failed (${reason}): ${messageOf(error)}`);
    return [];
  }
  const cancelled: string[] = [];
  for (const agent of agents.filter((entry) => isSuperWorker(entry) && isActiveAgentStatus(entry.status))) {
    try {
      patchAgentSuperMeta(deps, workspaceId, agent.sessionId, (entry) => {
        entry[WORKER_META_SUPERSEDED] = true;
      });
    } catch (error) {
      logger.warn(`[SuperSession] Failed to mark ${agent.sessionId} superseded: ${messageOf(error)}`);
    }
    cancelWorkerCore(deps, workspaceId, agent.sessionId, reason);
    cancelled.push(agent.sessionId);
  }
  return cancelled;
}

/**
 * state.rs:584–633：取消在给定消息中派发、且仍在运行的 Worker
 * （编辑重发 / 重新生成替换消息时）。
 */
export function cancelWorkersDispatchedInCore(
  deps: SuperSessionDeps, workspaceId: string, messageIds: readonly string[],
): string[] {
  const logger = deps.logger;
  if (messageIds.length === 0) return [];
  let agents: WorkspaceAgent[];
  try {
    agents = deps.workspace.listAgents(workspaceId);
  } catch (error) {
    logger.warn(`[SuperSession] list_agents failed (superseded): ${messageOf(error)}`);
    return [];
  }
  const cancelled: string[] = [];
  for (const agent of agents.filter((entry) => isSuperWorker(entry) && isActiveAgentStatus(entry.status))) {
    const dispatchedIn = agentSuperStr(agent, WORKER_META_DISPATCHED_IN);
    if (dispatchedIn === null) continue;
    if (!messageIds.includes(dispatchedIn)) continue;
    // 先打标记再取消：取消回执（完成闭包异步写入收件箱）投递时据此被吞掉。
    try {
      patchAgentSuperMeta(deps, workspaceId, agent.sessionId, (entry) => {
        entry[WORKER_META_SUPERSEDED] = true;
      });
    } catch (error) {
      logger.warn(`[SuperSession] Failed to mark ${agent.sessionId} superseded: ${messageOf(error)}`);
    }
    cancelWorkerCore(deps, workspaceId, agent.sessionId, 'superseded by edit/regenerate');
    cancelled.push(agent.sessionId);
  }
  return cancelled;
}

// ============================================================================
// 事件与状态（state.rs:656–794）
// ============================================================================

/** state.rs:656–661。 */
export function pendingInbox(
  deps: SuperSessionDeps, workspaceId: string, sessionId: string,
): number {
  try {
    const count = deps.workspace.pendingInboxCount(workspaceId, sessionId);
    if (!Number.isFinite(count) || count <= 0) return 0;
    return count > 0xFFFF_FFFF ? 0xFFFF_FFFF : Math.trunc(count);
  } catch {
    return 0;
  }
}

export function disabledState(): SuperSessionState {
  return { enabled: false, sessionId: null, workspaceId: null, pendingInbox: 0 };
}

/** state.rs:682–692：`super_session_changed {enabled, sessionId}`（关闭时 sessionId 为 null）。 */
export function emitChanged(
  deps: SuperSessionDeps, enabled: boolean, sessionId: string | null,
): void {
  const logger = deps.logger;
  try {
    deps.events.changed({ enabled, sessionId });
  } catch (error) {
    logger.warn(`[SuperSession] emit ${EVENT_SUPER_SESSION_CHANGED} failed: ${messageOf(error)}`);
  }
}

/** state.rs:695–708：`super_session_inbox_changed {sessionId, pendingInbox}`。 */
export function emitInboxChanged(
  deps: SuperSessionDeps, sessionId: string, workspaceId: string,
): void {
  const logger = deps.logger;
  const payload: InboxChangedPayload = {
    sessionId,
    pendingInbox: pendingInbox(deps, workspaceId, sessionId),
  };
  try {
    deps.events.inboxChanged(payload);
  } catch (error) {
    logger.warn(`[SuperSession] emit ${EVENT_SUPER_SESSION_INBOX_CHANGED} failed: ${messageOf(error)}`);
  }
}

/**
 * state.rs:712–733：唯一性、去 hidden / 新建会话 + 新建工作区 + 注册 Coordinator。
 * 不检查开关（调用方负责）。新建时初始化会话 runtime roots。
 */
export function ensure(deps: SuperSessionDeps): SuperSessionState {
  const logger = deps.logger;
  const outcome = ensureCore(deps);
  if (outcome.created && deps.ensureRuntimeRoots !== null && deps.ensureRuntimeRoots !== undefined) {
    try {
      deps.ensureRuntimeRoots(outcome.sessionId);
    } catch (error) {
      logger.warn(`[SuperSession] Failed to initialize runtime roots for ${outcome.sessionId}: ${messageOf(error)}`);
    }
  }
  return {
    enabled: true,
    sessionId: outcome.sessionId,
    workspaceId: outcome.workspaceId,
    pendingInbox: pendingInbox(deps, outcome.workspaceId, outcome.sessionId),
  };
}

/** state.rs:736–757：当前状态；启用时顺带 ensure（幂等自愈：去重、工作区健康）。 */
export function getState(deps: SuperSessionDeps): SuperSessionState {
  const logger = deps.logger;
  if (!readEnabled(deps.settings)) return disabledState();
  try {
    return ensure(deps);
  } catch (error) {
    logger.warn(`[SuperSession] ensure failed in get_state: ${messageOf(error)}`);
    const state = disabledState();
    state.enabled = true;
    const current = currentSuper(deps);
    if (current !== null) {
      state.sessionId = current.sessionId;
      state.workspaceId = current.workspaceId;
    }
    return state;
  }
}

/**
 * state.rs:760–794：开关。
 * 开启：写 settings → ensure → 发事件；
 * 关闭：写 settings → 取消活跃 Worker → hidden → 发事件（`sessionId` 为 null）。
 */
export function setEnabled(deps: SuperSessionDeps, enabled: boolean): SuperSessionState {
  const logger = deps.logger;
  writeEnabled(deps.settings, enabled);
  if (enabled) {
    const state = ensure(deps);
    emitChanged(deps, true, state.sessionId);
    return state;
  }
  const current = currentSuper(deps);
  if (current !== null) {
    if (current.workspaceId !== null && deps.streams !== null) {
      const cancelled = cancelActiveWorkers(deps, current.workspaceId, 'super_session_disabled');
      if (cancelled.length > 0) {
        logger.info(`[SuperSession] Disabled: cancelled ${cancelled.length} active worker(s)`);
      }
    }
    try {
      setHidden(deps, current.sessionId, true);
    } catch (error) {
      logger.warn(`[SuperSession] Failed to hide Super session: ${messageOf(error)}`);
    }
  }
  emitChanged(deps, false, null);
  return disabledState();
}

/**
 * state.rs:796–849：会话被软删 / 硬删后的钩子（L04 在删除成功后调用，仅对带
 * `super_agent` 标记的会话）。取消 Worker；硬删删工作区、软删关工作区；
 * 已启用则 ensure() 新建空 Super；发 `super_session_changed`。错误只记日志。
 */
export function onSessionRemoved(deps: SuperSessionDeps, sessionId: string, hard: boolean): void {
  const logger = deps.logger;
  const workspaces = superWorkspacesCreatedBy(deps, sessionId);
  let session: ChatSession | null = null;
  try {
    session = deps.chat.getSession(sessionId);
  } catch (error) {
    logger.warn(`[SuperSession] on_session_removed: ${messageOf(error)}`);
  }
  if (session !== null) {
    const bound = metadataWorkspaceId(session.metadata);
    if (bound !== null && !workspaces.includes(bound)) workspaces.push(bound);
  }
  for (const workspaceId of workspaces) {
    if (deps.streams !== null) {
      cancelActiveWorkers(deps, workspaceId, 'super_session_removed');
    }
    try {
      if (hard) deps.workspace.deleteWorkspace(workspaceId);
      else deps.workspace.closeWorkspace(workspaceId);
    } catch (error) {
      logger.warn(`[SuperSession] Failed to ${hard ? 'delete' : 'close'} workspace ${workspaceId} of removed Super ${sessionId}: ${messageOf(error)}`);
    }
  }
  if (readEnabled(deps.settings)) {
    try {
      const state = ensure(deps);
      emitChanged(deps, true, state.sessionId);
    } catch (error) {
      logger.warn(`[SuperSession] ensure after removal failed: ${messageOf(error)}`);
      emitChanged(deps, true, null);
    }
  } else {
    emitChanged(deps, false, null);
  }
}

/**
 * state.rs:853–884：编辑重发 / 重新生成替换消息时取消这些消息里派发且仍在运行的
 * Worker。普通会话、非活跃 Super 为 no-op。
 */
export function cancelWorkersDispatchedIn(
  deps: SuperSessionDeps, sessionId: string, messageIds: readonly string[],
): void {
  const logger = deps.logger;
  if (messageIds.length === 0) return;
  let session: ChatSession | null = null;
  try {
    session = deps.chat.getSession(sessionId);
  } catch {
    return;
  }
  if (session === null) return;
  if (!isActiveSuperMetadata(session.metadata)) return;
  const workspaceId = metadataWorkspaceId(session.metadata);
  if (workspaceId === null) return;
  if (deps.streams === null) return;
  const cancelled = cancelWorkersDispatchedInCore(deps, workspaceId, messageIds);
  if (cancelled.length > 0) {
    logger.info(`[SuperSession] Cancelled ${cancelled.length} superseded worker(s) in ${sessionId}: ${cancelled.join(', ')}`);
  }
}

// ============================================================================
// 管线入口钩子（state.rs:890–972）
// ============================================================================

/**
 * state.rs:897–936：仅 active && enabled && !hidden 时生效。
 * `request.workspaceId = null`（不触发 Stage 5.5 注入），并写入 `options.superSession`；
 * 有窗口时再追加 4 个 Super 工具 schema（按名去重）。
 */
export function applyTurnOverrides(
  deps: SuperSessionDeps, request: SuperTurnRequest & { sessionId: string }, hasWindow: boolean,
): void {
  const logger = deps.logger;
  if (!readEnabled(deps.settings)) return;
  let session: ChatSession | null;
  try {
    session = deps.chat.getSession(request.sessionId);
  } catch (error) {
    logger.warn(`[SuperSession] apply_turn_overrides: failed to load session ${request.sessionId}: ${messageOf(error)}`);
    return;
  }
  if (session === null) return;
  if (session.persistStatus !== 'active') return;
  if (!isActiveSuperMetadata(session.metadata) || metadataHidden(session.metadata)) return;
  const workspaceId = metadataWorkspaceId(session.metadata);
  if (workspaceId === null) {
    logger.warn(`[SuperSession] Active Super session ${request.sessionId} has no workspace_id; skipping overrides`);
    return;
  }
  applySuperTurn(request, workspaceId, hasWindow);
}

/**
 * state.rs:1454–1462：`SendOptions` 的 `super_session` / `user_message_origin`
 * 是 `#[serde(skip)]` 后端内部字段。TS 没有 serde，前端发来的对象会在
 * options 里原样出现，因此入口必须剥掉这两个键（值一律丢弃，绝不采用）。
 */
export function stripBackendOnlySendOptions(raw: unknown): {
  options: Record<string, unknown>;
  stripped: string[];
} {
  const options: Record<string, unknown> = { ...(asRecord(raw) ?? {}) };
  const stripped: string[] = [];
  for (const key of BACKEND_ONLY_SEND_OPTION_KEYS) {
    if (!Object.hasOwn(options, key)) continue;
    delete options[key];
    stripped.push(key);
  }
  return { options, stripped };
}
