/**
 * super_session/state.rs 的行为测试。
 *
 * 被测代码是真实的 `src/super-state.ts`；只有跨 lane 的 `chatSession` /
 * `agentWorkspace` 用最小内存替身（经 `createTestHost({ provide })` 提供），
 * 替身按 Rust DB / WorkspaceCoordinator 的语义实现：会话按插入顺序与 created_at
 * 排序、json metadata 原样保存、工作区状态 active→completed、agent 状态机、
 * 每个 agent 一个子代理任务。仓库 SQL 另有独立用例跑真实 SQLite。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { ChatSession } from '../../chat/api.ts';
import type {
  AgentRole, AgentStatus, JsonValue, SubagentTaskData, Workspace, WorkspaceAgent,
} from '../../agent-workspace/api.ts';
import { createSuperSessionLookup, listActiveSuperIds as listActiveSuperIdsQuery, superWorkspaceIdsCreatedBy } from '../repository/super-session.ts';
import {
  SUPER_SESSION_TITLE, SUPER_WORKSPACE_NAME, WORKER_META_DISPATCHED_IN, WORKER_META_SUPERSEDED,
  WORKER_META_TITLE, agentSuperFlag, agentSuperStr, applyTurnOverrides, cancelActiveWorkers,
  cancelWorkersDispatchedIn, cancelWorkersDispatchedInCore, createSuperSession, currentSuper,
  disabledState, emitChanged, ensureCore, ensureWorkspace, getState, isActiveAgentStatus,
  isSuperWorker, listActiveSuperIds as listActiveIds, newSuperSession, patchAgentSuperMeta,
  pendingInbox, setEnabled, setHidden, stripBackendOnlySendOptions, superWorkspacesCreatedBy,
  type ChangedPayload, type EnsureOutcome, type SuperChatStreams, type SuperSessionDeps,
  type SuperSessionLookup, type SuperWorkspaceCoordinator,
} from '../src/super-state.ts';
import {
  isActiveSuperMetadata, metadataHidden, metadataWorkspaceId, SUPER_TOOL_NAMES, type SuperTurnRequest,
} from '../src/super-session.ts';

// ============================================================================
// 跨 lane 替身：会话表
// ============================================================================

interface SessionRow {
  session: ChatSession;
  insertedAt: number;
}

interface MemoryChatWorld {
  rows: Map<string, SessionRow>;
  workspaceIndex: Array<{ workspaceId: string; creatorSessionId: string; name: string }>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function createMemoryChat(): {
  world: MemoryChatWorld;
  chat: SuperSessionDeps['chat'];
  lookup: SuperSessionLookup;
  removeSession(sessionId: string): void;
} {
  const world: MemoryChatWorld = { rows: new Map(), workspaceIndex: [] };
  let counter = 0;
  return {
    world,
    chat: {
      getSession(sessionId) {
        const row = world.rows.get(sessionId);
        return row === undefined ? null : clone(row.session);
      },
      createSession(session) {
        if (world.rows.has(session.id)) throw new Error(`UNIQUE constraint failed: chat_v2_sessions.id`);
        counter += 1;
        world.rows.set(session.id, { session: clone(session), insertedAt: counter });
      },
      updateSession(session) {
        const row = world.rows.get(session.id);
        if (row === undefined) throw new Error(`Session not found: ${session.id}`);
        world.rows.set(session.id, { session: clone(session), insertedAt: row.insertedAt });
      },
    },
    lookup: {
      /** `ORDER BY created_at DESC, rowid DESC`。 */
      listActiveSuperIds() {
        return [...world.rows.values()]
          .filter((row) => row.session.persistStatus === 'active' && isActiveSuperMetadata(row.session.metadata))
          .sort((left, right) => right.session.createdAt.localeCompare(left.session.createdAt)
            || right.insertedAt - left.insertedAt)
          .map((row) => row.session.id);
      },
      /** workspace_index：硬删会话行后索引仍在。 */
      workspacesCreatedBy(sessionId) {
        return world.workspaceIndex
          .filter((entry) => entry.creatorSessionId === sessionId && entry.name === SUPER_WORKSPACE_NAME)
          .map((entry) => entry.workspaceId);
      },
    },
    /** 仅模拟 `ChatV2Repo::delete_session_v2`：会话行消失，workspace_index 不动。 */
    removeSession(sessionId) {
      world.rows.delete(sessionId);
    },
  };
}

// ============================================================================
// 跨 lane 替身：WorkspaceCoordinator + subagent_task
// ============================================================================

interface MemoryWorkspaceWorld {
  workspaces: Map<string, Workspace>;
  agents: Map<string, Map<string, WorkspaceAgent>>;
  tasks: Map<string, Map<string, SubagentTaskData>>;
  inbox: Map<string, number>;
  created: Array<{ workspaceId: string; creatorSessionId: string; name: string | null }>;
}

function taskKey(workspaceId: string, agentSessionId: string): string {
  return `${workspaceId}\u0000${agentSessionId}`;
}

/** `SubagentTaskManager::get_agent_task` / `update_status`（含状态机）。 */
function createMemoryTasks(workspaceId: string, tasks: Map<string, SubagentTaskData>) {
  let counter = 0;
  return {
    create(agentSessionId: string, status: SubagentTaskData['status']): SubagentTaskData {
      counter += 1;
      const now = new Date().toISOString();
      const task: SubagentTaskData = {
        id: `task_${workspaceId}_${counter}`,
        workspaceId,
        agentSessionId,
        skillId: null,
        initialTask: 't',
        status,
        createdAt: now,
        startedAt: status === 'running' ? now : null,
        completedAt: null,
        resultSummary: null,
      };
      tasks.set(task.id, task);
      return clone(task);
    },
    manager: {
      getAgentTask(agentSessionId: string): SubagentTaskData | null {
        const found = [...tasks.values()].find((task) => task.agentSessionId === agentSessionId);
        return found === undefined ? null : clone(found);
      },
      updateStatus(taskId: string, status: 'cancelled', resultSummary: string | null): void {
        const task = tasks.get(taskId);
        if (task === undefined) throw new Error(`Task not found: ${taskId}`);
        const allowed = task.status === status
          || task.status === 'pending' || task.status === 'running' || task.status === 'unknown';
        if (!allowed) throw new Error(`Invalid task status transition: ${task.status} -> ${status}`);
        task.status = status;
        task.resultSummary = resultSummary;
        task.completedAt = new Date().toISOString();
      },
    },
  };
}

function createMemoryWorkspace(world: MemoryChatWorld) {
  const state: MemoryWorkspaceWorld = {
    workspaces: new Map(), agents: new Map(), tasks: new Map(), inbox: new Map(), created: [],
  };
  const managers = new Map<string, ReturnType<typeof createMemoryTasks>>();
  let counter = 0;

  const requireAgent = (workspaceId: string, sessionId: string): WorkspaceAgent => {
    const agent = state.agents.get(workspaceId)?.get(sessionId);
    if (agent === undefined) throw new Error(`Agent not found: ${sessionId}`);
    return agent;
  };

  const port: SuperWorkspaceCoordinator = {
    getWorkspace(workspaceId) {
      const workspace = state.workspaces.get(workspaceId);
      return workspace === undefined ? null : clone(workspace);
    },
    createWorkspace(creatorSessionId, name) {
      counter += 1;
      const now = new Date().toISOString();
      const workspace: Workspace = {
        id: `ws_${counter}`, name, status: 'active', creatorSessionId,
        createdAt: now, updatedAt: now,
      };
      state.workspaces.set(workspace.id, workspace);
      state.agents.set(workspace.id, new Map());
      state.tasks.set(workspace.id, new Map());
      managers.set(workspace.id, createMemoryTasks(workspace.id, state.tasks.get(workspace.id)!));
      state.created.push({ workspaceId: workspace.id, creatorSessionId, name });
      // Rust `sync_to_index`：workspace_index 由 coordinator 写入。
      world.workspaceIndex.push({ workspaceId: workspace.id, creatorSessionId, name: name ?? '' });
      return clone(workspace);
    },
    closeWorkspace(workspaceId) {
      const workspace = state.workspaces.get(workspaceId);
      if (workspace === undefined) throw new Error(`Workspace not found: ${workspaceId}`);
      workspace.status = 'completed';
      workspace.updatedAt = new Date().toISOString();
    },
    deleteWorkspace(workspaceId) {
      if (!state.workspaces.has(workspaceId)) throw new Error(`Workspace not found: ${workspaceId}`);
      state.workspaces.delete(workspaceId);
      state.agents.delete(workspaceId);
      state.tasks.delete(workspaceId);
      managers.delete(workspaceId);
      const index = world.workspaceIndex.findIndex((entry) => entry.workspaceId === workspaceId);
      if (index >= 0) world.workspaceIndex.splice(index, 1);
    },
    registerAgent(workspaceId, sessionId, role, skillId, metadata) {
      if (!state.workspaces.has(workspaceId)) throw new Error(`Workspace not found: ${workspaceId}`);
      const now = new Date().toISOString();
      const agent: WorkspaceAgent = {
        sessionId, workspaceId, role, skillId: skillId ?? null, status: 'idle',
        joinedAt: now, lastActiveAt: now, metadata: metadata ?? undefined,
      };
      state.agents.get(workspaceId)!.set(sessionId, agent);
      return clone(agent);
    },
    getAgent(workspaceId, sessionId) {
      const agent = state.agents.get(workspaceId)?.get(sessionId);
      return agent === undefined ? null : clone(agent);
    },
    updateAgentStatus(workspaceId, sessionId, status) {
      const agent = requireAgent(workspaceId, sessionId);
      agent.status = status;
      agent.lastActiveAt = new Date().toISOString();
    },
    updateAgentMetadata(workspaceId, sessionId, metadata) {
      const agent = requireAgent(workspaceId, sessionId);
      agent.metadata = metadata ?? undefined;
    },
    listAgents(workspaceId) {
      if (!state.workspaces.has(workspaceId)) throw new Error(`Workspace not found: ${workspaceId}`);
      return [...state.agents.get(workspaceId)!.values()].map((agent) => clone(agent));
    },
    pendingInboxCount(workspaceId, sessionId) {
      return state.inbox.get(taskKey(workspaceId, sessionId)) ?? 0;
    },
    getTaskManager(workspaceId) {
      const manager = managers.get(workspaceId);
      if (manager === undefined) throw new Error(`Workspace not found: ${workspaceId}`);
      return manager.manager;
    },
  };

  return {
    port,
    world: state,
    created: state.created,
    agent(workspaceId: string, sessionId: string): WorkspaceAgent | null {
      const agent = state.agents.get(workspaceId)?.get(sessionId);
      return agent === undefined ? null : clone(agent);
    },
    task(workspaceId: string, agentSessionId: string): SubagentTaskData | null {
      const found = [...(state.tasks.get(workspaceId)?.values() ?? [])]
        .find((task) => task.agentSessionId === agentSessionId);
      return found === undefined ? null : clone(found);
    },
    createTask(workspaceId: string, agentSessionId: string): SubagentTaskData {
      return managers.get(workspaceId)!.create(agentSessionId, 'running');
    },
    setPending(workspaceId: string, sessionId: string, count: number): void {
      state.inbox.set(taskKey(workspaceId, sessionId), count);
    },
  };
}

// ============================================================================
// 测试宿主
// ============================================================================

interface Fixture {
  host: TestHost;
  deps: SuperSessionDeps;
  memory: ReturnType<typeof createMemoryChat>;
  workspace: ReturnType<typeof createMemoryWorkspace>;
  settings: Map<string, string>;
  events: { changed: ChangedPayload[]; inboxChanged: Array<{ sessionId: string; pendingInbox: number }> };
  logs: { info: string[]; warn: string[] };
  streams: { active: Set<string>; cancelled: string[]; port: SuperChatStreams };
}

const hosts: TestHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
});

function createMemoryStreams() {
  const active = new Set<string>();
  const cancelled: string[] = [];
  const port: SuperChatStreams = {
    cancelStream(sessionId) {
      if (!active.has(sessionId)) return false;
      active.delete(sessionId);
      cancelled.push(sessionId);
      return true;
    },
  };
  return { active, cancelled, port };
}

async function fixture(): Promise<Fixture> {
  const memory = createMemoryChat();
  const workspace = createMemoryWorkspace(memory.world);
  const streams = createMemoryStreams();
  const settings = new Map<string, string>();
  const events = { changed: [] as ChangedPayload[], inboxChanged: [] as Array<{ sessionId: string; pendingInbox: number }> };
  const logs = { info: [] as string[], warn: [] as string[] };

  // 其他 lane 的服务经 createTestHost 提供，再从 ctx 取回（与生产组合根同一路径）。
  const host = await createTestHost({
    provide: {
      chatSession: memory.chat,
      agentWorkspace: workspace.port,
    },
  });
  hosts.push(host);

  const sessions = host.ctx.get('chatSession') as unknown as SuperSessionDeps['chat'];
  const coordinator = host.ctx.get('agentWorkspace') as unknown as SuperWorkspaceCoordinator;
  return {
    host,
    memory,
    workspace,
    settings,
    events,
    logs,
    streams,
    deps: {
      chat: sessions,
      lookup: memory.lookup,
      workspace: coordinator,
      streams: streams.port,
      settings: {
        get: (key) => settings.get(key) ?? null,
        save: (key, value) => { settings.set(key, value); },
      },
      events: {
        changed: (payload) => { events.changed.push(payload); },
        inboxChanged: (payload) => { events.inboxChanged.push(payload); },
      },
      logger: {
        info: (message) => { logs.info.push(message); },
        warn: (message) => { logs.warn.push(message); },
      },
    },
  };
}

function addWorker(
  f: Fixture, workspaceId: string, agentSessionId: string, dispatchedIn: string,
): WorkspaceAgent {
  f.workspace.port.registerAgent(workspaceId, agentSessionId, 'worker', null, {
    super_agent: { title: '整理错题', [WORKER_META_DISPATCHED_IN]: dispatchedIn },
  } as unknown as JsonValue);
  f.workspace.port.updateAgentStatus(workspaceId, agentSessionId, 'running');
  f.workspace.createTask(workspaceId, agentSessionId);
  return f.workspace.agent(workspaceId, agentSessionId)!;
}

function turnRequest(sessionId: string): SuperTurnRequest & { sessionId: string } {
  return { sessionId, workspaceId: 'ws_frontend', options: null };
}

function sessionMetadata(f: Fixture, sessionId: string): Record<string, unknown> {
  const session = f.memory.world.rows.get(sessionId)!.session;
  return session.metadata as Record<string, unknown>;
}

// ============================================================================
// state.rs::tests
// ============================================================================

describe('super_session/state.rs ensure and lifecycle', () => {
  it('concurrent_ensure_creates_one_session_and_one_workspace', async () => {
    const f = await fixture();
    // Rust 用 8 个线程；这里的等价性质是：ensure 的“读 metadata → 建工作区 → 回写”
    // 是同步临界区，即使把 8 次调用排进同一批微任务，也不会出现第二个会话或工作区。
    const settled: EnsureOutcome[] = await Promise.all(
      Array.from({ length: 8 }, () => Promise.resolve().then(() => ensureCore(f.deps))),
    );
    expect(settled.filter((outcome) => outcome.created)).toHaveLength(1);
    const first = settled[0]!;
    for (const outcome of settled) {
      expect(outcome.sessionId).toBe(first.sessionId);
      expect(outcome.workspaceId).toBe(first.workspaceId);
    }
    expect(listActiveIds(f.deps)).toEqual([first.sessionId]);
    expect(metadataWorkspaceId(sessionMetadata(f, first.sessionId))).toBe(first.workspaceId);
    // 并发直接调 ensure_workspace（投递路径）也不能换绑
    const again: string[] = await Promise.all(
      Array.from({ length: 4 }, () => Promise.resolve().then(() => ensureWorkspace(f.deps, first.sessionId))),
    );
    expect(again).toEqual([first.workspaceId, first.workspaceId, first.workspaceId, first.workspaceId]);
    expect(f.workspace.created).toHaveLength(1);
    expect(f.workspace.created[0]).toEqual({
      workspaceId: first.workspaceId, creatorSessionId: first.sessionId, name: SUPER_WORKSPACE_NAME,
    });
  });

  it('ensure_is_idempotent_and_binds_workspace', async () => {
    const f = await fixture();
    const first = ensureCore(f.deps);
    expect(first.created).toBe(true);
    const second = ensureCore(f.deps);
    expect(second.created).toBe(false);
    expect(second).toEqual({ ...first, created: false });
    expect(listActiveIds(f.deps)).toEqual([first.sessionId]);

    const session = f.memory.world.rows.get(first.sessionId)!.session;
    expect(session.title).toBe(SUPER_SESSION_TITLE);
    expect(session.titleLocked).toBe(true);
    expect(session.mode).toBe('chat');
    const meta = session.metadata as Record<string, unknown>;
    expect(meta.pinned).toBe(true);
    const superAgent = meta.super_agent as Record<string, unknown>;
    expect(superAgent.active).toBe(true);
    expect(superAgent.version).toBe(1);
    expect(superAgent.hidden).toBe(false);
    expect(superAgent.workspace_id).toBe(first.workspaceId);

    const agent = f.workspace.agent(first.workspaceId, first.sessionId);
    expect(agent).not.toBeNull();
    expect(agent!.role).toBe('coordinator');
  });

  it('ensure_recreates_after_removal', async () => {
    const f = await fixture();
    const first = ensureCore(f.deps);
    // 软删（进回收站）后不再是活跃会话
    const session = f.memory.world.rows.get(first.sessionId)!.session;
    f.deps.chat.updateSession({ ...session, persistStatus: 'deleted' });
    f.workspace.port.closeWorkspace(first.workspaceId);

    const second = ensureCore(f.deps);
    expect(second.created).toBe(true);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.workspaceId).not.toBe(first.workspaceId);
    expect(listActiveIds(f.deps)).toEqual([second.sessionId]);
  });

  it('ensure_replaces_closed_workspace', async () => {
    const f = await fixture();
    const first = ensureCore(f.deps);
    f.workspace.port.closeWorkspace(first.workspaceId);
    const again = ensureCore(f.deps);
    expect(again.sessionId).toBe(first.sessionId);
    expect(again.workspaceId).not.toBe(first.workspaceId);
    expect(metadataWorkspaceId(sessionMetadata(f, first.sessionId))).toBe(again.workspaceId);
  });

  it('hidden_on_disable_and_restored_on_enable', async () => {
    const f = await fixture();
    const first = ensureCore(f.deps);
    expect(setHidden(f.deps, first.sessionId, true)).toBe(true);
    expect(setHidden(f.deps, first.sessionId, true)).toBe(false);
    expect(currentSuper(f.deps)).toEqual({
      sessionId: first.sessionId, workspaceId: first.workspaceId, hidden: true,
    });

    // set_enabled(false)：写 settings → 取消 Worker（无）→ hidden → 事件
    expect(setEnabled(f.deps, false)).toEqual(disabledState());
    expect(f.settings.get('super_agent.enabled')).toBe('false');
    expect(metadataHidden(sessionMetadata(f, first.sessionId))).toBe(true);
    expect(f.events.changed).toEqual([{ enabled: false, sessionId: null }]);

    // 开启时 ensure 去掉 hidden，沿用同一会话与工作区
    f.workspace.setPending(first.workspaceId, first.sessionId, 3);
    expect(setEnabled(f.deps, true)).toEqual({
      enabled: true, sessionId: first.sessionId, workspaceId: first.workspaceId, pendingInbox: 3,
    });
    expect(f.settings.get('super_agent.enabled')).toBe('true');
    expect(currentSuper(f.deps)!.hidden).toBe(false);
    expect(f.events.changed).toEqual([
      { enabled: false, sessionId: null },
      { enabled: true, sessionId: first.sessionId },
    ]);
    expect(getState(f.deps)).toEqual({
      enabled: true, sessionId: first.sessionId, workspaceId: first.workspaceId, pendingInbox: 3,
    });
  });

  it('multiple_active_keeps_only_newest', async () => {
    const f = await fixture();
    const older = createSuperSession(f.deps);
    const newer = newSuperSession(new Date(Date.parse(older.createdAt) + 5_000));
    f.deps.chat.createSession(newer);

    const outcome = ensureCore(f.deps);
    expect(outcome.sessionId).toBe(newer.id);
    expect(listActiveIds(f.deps)).toEqual([newer.id]);
    const retired = sessionMetadata(f, older.id);
    const superAgent = retired.super_agent as Record<string, unknown>;
    expect(superAgent.active).toBe(false);
    expect(typeof superAgent.retired_at).toBe('string');
    expect(superAgent.workspace_id).toBeUndefined();
    expect(retired.pinned).toBeUndefined();
    expect(isActiveSuperMetadata(retired)).toBe(false);
  });

  it('super_workspace_lookup_by_creator_survives_hard_delete', async () => {
    const f = await fixture();
    const outcome = ensureCore(f.deps);
    expect(superWorkspacesCreatedBy(f.deps, outcome.sessionId)).toEqual([outcome.workspaceId]);

    f.memory.removeSession(outcome.sessionId);
    expect(f.memory.world.rows.has(outcome.sessionId)).toBe(false);
    expect(superWorkspacesCreatedBy(f.deps, outcome.sessionId)).toEqual([outcome.workspaceId]);
    expect(superWorkspacesCreatedBy(f.deps, 'sess_other')).toEqual([]);
    expect(currentSuper(f.deps)).toBeNull();
  });

  it('turn_overrides_only_for_active_enabled_visible_super', async () => {
    const f = await fixture();
    const outcome = ensureCore(f.deps);

    // 未启用：不动
    let request = turnRequest(outcome.sessionId);
    applyTurnOverrides(f.deps, request, true);
    expect(request.workspaceId).toBe('ws_frontend');
    expect(request.options).toBeNull();

    // 普通会话：不动
    f.settings.set('super_agent.enabled', 'true');
    const plain = newSuperSession();
    plain.metadata = { pinned: true };
    f.deps.chat.createSession(plain);
    request = turnRequest(plain.id);
    applyTurnOverrides(f.deps, request, true);
    expect(request.options).toBeNull();
    expect(request.workspaceId).toBe('ws_frontend');

    // hidden：不动
    setHidden(f.deps, outcome.sessionId, true);
    request = turnRequest(outcome.sessionId);
    applyTurnOverrides(f.deps, request, true);
    expect(request.options).toBeNull();
    setHidden(f.deps, outcome.sessionId, false);

    // 活跃 + 启用 + 可见：生效
    request = turnRequest(outcome.sessionId);
    applyTurnOverrides(f.deps, request, true);
    expect(request.workspaceId).toBeNull();
    expect(request.options!.superSession).toEqual({ workspaceId: outcome.workspaceId });
    expect(request.options!.mcpToolSchemas!.map((schema) => schema.name)).toEqual([...SUPER_TOOL_NAMES]);
  });

  it('frontend_cannot_forge_super_session_marker', async () => {
    const f = await fixture();
    const outcome = ensureCore(f.deps);
    f.settings.set('super_agent.enabled', 'true');

    // Rust `#[serde(skip)]`：这两个字段来自前端时一律丢弃。
    const forged = {
      superSession: { workspaceId: 'ws_evil' },
      super_session: { workspace_id: 'ws_evil' },
      userMessageOrigin: { kind: 'super_inbox' },
      modelId: 'cfg-1',
    };
    const { options, stripped } = stripBackendOnlySendOptions(forged);
    expect(stripped).toEqual(['superSession', 'super_session', 'userMessageOrigin']);
    expect(options).toEqual({ modelId: 'cfg-1' });
    expect(Object.hasOwn(forged, 'superSession')).toBe(true);
    const cleanOptions = structuredClone(options);

    // 剥离后的 options 交给管线钩子：只有后端认定的活跃 Super 工作区才会出现标记。
    const request: SuperTurnRequest & { sessionId: string } = {
      sessionId: outcome.sessionId,
      workspaceId: null,
      options: options as unknown as SuperTurnRequest['options'],
    };
    applyTurnOverrides(f.deps, request, true);
    expect(request.options!.superSession).toEqual({ workspaceId: outcome.workspaceId });
    expect(request.options!.superSession).not.toEqual({ workspaceId: 'ws_evil' });

    const plain = newSuperSession();
    plain.metadata = { pinned: true };
    f.deps.chat.createSession(plain);
    const plainRequest: SuperTurnRequest & { sessionId: string } = {
      sessionId: plain.id,
      workspaceId: null,
      options: cleanOptions as unknown as SuperTurnRequest['options'],
    };
    applyTurnOverrides(f.deps, plainRequest, true);
    expect(plainRequest.options!.superSession).toBeUndefined();
    expect((plainRequest.options as unknown as Record<string, unknown>).userMessageOrigin).toBeUndefined();
  });

  it('cancel_dispatched_in_only_hits_replaced_messages', async () => {
    const f = await fixture();
    const outcome = ensureCore(f.deps);
    const workspaceId = outcome.workspaceId;
    addWorker(f, workspaceId, 'subagent_explorer_a', 'msg_old');
    addWorker(f, workspaceId, 'subagent_explorer_b', 'msg_keep');

    const cancelled = cancelWorkersDispatchedInCore(f.deps, workspaceId, ['msg_old']);
    expect(cancelled).toEqual(['subagent_explorer_a']);
    const a = f.workspace.agent(workspaceId, 'subagent_explorer_a')!;
    expect(a.status).toBe('cancelled');
    expect(agentSuperFlag(a, WORKER_META_SUPERSEDED)).toBe(true);
    expect(agentSuperStr(a, WORKER_META_TITLE)).toBe('整理错题');
    const taskA = f.workspace.task(workspaceId, 'subagent_explorer_a')!;
    expect(taskA.status).toBe('cancelled');
    expect(taskA.resultSummary).toBe('superseded by edit/regenerate');

    const b = f.workspace.agent(workspaceId, 'subagent_explorer_b')!;
    expect(b.status).toBe('running');
    expect(agentSuperFlag(b, WORKER_META_SUPERSEDED)).toBe(false);
    expect(cancelWorkersDispatchedInCore(f.deps, workspaceId, [])).toEqual([]);

    // 普通会话：命令层 no-op（不会碰 b）
    const plain = newSuperSession();
    plain.metadata = { pinned: true };
    f.deps.chat.createSession(plain);
    cancelWorkersDispatchedIn(f.deps, plain.id, ['msg_keep']);
    expect(f.workspace.agent(workspaceId, 'subagent_explorer_b')!.status).toBe('running');

    // list_agents 失败只告警并返回空集
    const failing: SuperWorkspaceCoordinator = {
      ...f.workspace.port,
      listAgents: () => { throw new Error('workspace db unavailable'); },
    };
    expect(cancelActiveWorkers({ ...f.deps, workspace: failing }, workspaceId, 'x')).toEqual([]);
    expect(f.logs.warn.some((line) => line.includes('list_agents failed (x)'))).toBe(true);

    // Agent 不存在：文案与 Rust 逐字一致
    expect(() => patchAgentSuperMeta(f.deps, workspaceId, 'subagent_missing', () => undefined))
      .toThrow('Agent not found: subagent_missing');
  });

  it('cancel_active_workers_on_disable_marks_superseded', async () => {
    const f = await fixture();
    const outcome = ensureCore(f.deps);
    const workspaceId = outcome.workspaceId;
    addWorker(f, workspaceId, 'subagent_explorer_a', 'm1');
    // 外部事件伪发送者与已完成 Worker 都不在取消范围内
    f.workspace.port.registerAgent(workspaceId, 'external:ilink', 'worker', null, null);
    f.workspace.port.updateAgentStatus(workspaceId, 'external:ilink', 'running');
    f.workspace.port.registerAgent(workspaceId, 'subagent_explorer_done', 'worker', null, null);
    f.workspace.port.updateAgentStatus(workspaceId, 'subagent_explorer_done', 'completed');

    const cancelled = cancelActiveWorkers(f.deps, workspaceId, 'disabled');
    expect(cancelled).toEqual(['subagent_explorer_a']);
    const a = f.workspace.agent(workspaceId, 'subagent_explorer_a')!;
    expect(a.status).toBe('cancelled');
    expect(agentSuperFlag(a, WORKER_META_SUPERSEDED)).toBe(true);
    expect(f.workspace.task(workspaceId, 'subagent_explorer_a')!.resultSummary).toBe('disabled');
    expect(f.workspace.agent(workspaceId, 'external:ilink')!.status).toBe('running');
    expect(f.workspace.agent(workspaceId, 'subagent_explorer_done')!.status).toBe('completed');

    // Cooperative 自身（Super 会话的 Coordinator）不受影响
    const me = f.workspace.agent(workspaceId, outcome.sessionId)!;
    expect(me.role).toBe('coordinator');
    expect(me.status).not.toBe('cancelled');

    // 真正的关闭路径：settings + Worker 取消（superseded）+ hidden + 事件
    addWorker(f, workspaceId, 'subagent_explorer_b', 'm2');
    f.workspace.port.updateAgentStatus(workspaceId, outcome.sessionId, 'running');
    expect(setEnabled(f.deps, false)).toEqual(disabledState());
    const b = f.workspace.agent(workspaceId, 'subagent_explorer_b')!;
    expect(b.status).toBe('cancelled');
    expect(agentSuperFlag(b, WORKER_META_SUPERSEDED)).toBe(true);
    expect(f.workspace.task(workspaceId, 'subagent_explorer_b')!.resultSummary).toBe('super_session_disabled');
    expect(metadataHidden(sessionMetadata(f, outcome.sessionId))).toBe(true);
    expect(f.events.changed).toEqual([{ enabled: false, sessionId: null }]);
    expect(f.workspace.agent(workspaceId, outcome.sessionId)!.status).toBe('running');
  });
});

describe('super_session/state.rs pure helpers', () => {
  it('worker_and_status_predicates_match_rust', () => {
    const agent = (role: AgentRole, sessionId: string, status: AgentStatus): WorkspaceAgent => ({
      sessionId, workspaceId: 'ws_1', role, skillId: null, status,
      joinedAt: 't', lastActiveAt: 't',
    });
    expect(isSuperWorker(agent('worker', 'subagent_explorer_1', 'running'))).toBe(true);
    expect(isSuperWorker(agent('worker', 'external:ilink', 'running'))).toBe(false);
    expect(isSuperWorker(agent('coordinator', 'sess_super', 'running'))).toBe(false);
    for (const status of ['idle', 'queued', 'running', 'interrupted'] as const) {
      expect(isActiveAgentStatus(status)).toBe(true);
    }
    for (const status of ['completed', 'failed', 'cancelled', 'closed'] as const) {
      expect(isActiveAgentStatus(status)).toBe(false);
    }
    expect(disabledState()).toEqual({ enabled: false, sessionId: null, workspaceId: null, pendingInbox: 0 });
  });

  it('emit_changed_payloads_and_pending_inbox_failures', async () => {
    const f = await fixture();
    f.workspace.setPending('ws_x', 'sess_x', 5);
    expect(pendingInbox(f.deps, 'ws_x', 'sess_x')).toBe(5);
    // 收件箱查询失败：Rust `.unwrap_or(0)`，这里同样退化为 0（不抛）。
    const failing: SuperWorkspaceCoordinator = {
      ...f.workspace.port,
      pendingInboxCount: () => { throw new Error('inbox unavailable'); },
    };
    expect(pendingInbox({ ...f.deps, workspace: failing }, 'ws_x', 'sess_x')).toBe(0);
    emitChanged(f.deps, true, 'sess_x');
    expect(f.events.changed).toEqual([{ enabled: true, sessionId: 'sess_x' }]);
    expect(currentSuper(f.deps)).toBeNull();
  });
});

// ============================================================================
// repository SQL（真实 SQLite；Rust 的两条查询逐字移植）
// ============================================================================

describe('super_session/state.rs chat_v2 SQL', () => {
  it('active_ids_order_and_workspace_index_lookup', () => {
    const root = mkdtempSync(join(tmpdir(), 'l06-super-state-'));
    const storage = createStorageService({ baseDir: root, dataLocalDir: root });
    try {
      const db = storage.database('chat_v2');
      db.exec(`CREATE TABLE chat_v2_sessions (
        id TEXT PRIMARY KEY, persist_status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, metadata_json TEXT);
        CREATE TABLE workspace_index (
          workspace_id TEXT PRIMARY KEY, creator_session_id TEXT NOT NULL, name TEXT);`);
      const insert = (id: string, status: string, createdAt: string, metadata: string | null) =>
        db.run(`INSERT INTO chat_v2_sessions (id, persist_status, created_at, updated_at, metadata_json)
          VALUES (?1, ?2, ?3, ?3, ?4)`, [id, status, createdAt, metadata]);
      insert('sess_older', 'active', '2026-01-01T00:00:00.000Z',
        '{"super_agent":{"active":true,"version":1,"hidden":false}}');
      insert('sess_newer', 'active', '2026-01-02T00:00:00.000Z',
        '{"super_agent":{"active":true,"version":1,"hidden":true}}');
      // 同 created_at：后插入的 rowid 更大，排前面
      insert('sess_tie_first', 'active', '2026-01-03T00:00:00.000Z',
        '{"super_agent":{"active":true}}');
      insert('sess_tie_second', 'active', '2026-01-03T00:00:00.000Z',
        '{"super_agent":{"active":true}}');
      insert('sess_retired', 'active', '2026-01-04T00:00:00.000Z',
        '{"super_agent":{"active":false,"retired_at":"2026-01-04T00:00:00Z"}}');
      insert('sess_deleted', 'deleted', '2026-01-05T00:00:00.000Z',
        '{"super_agent":{"active":true}}');
      insert('sess_plain', 'active', '2026-01-06T00:00:00.000Z', '{"pinned":true}');
      insert('sess_malformed', 'active', '2026-01-07T00:00:00.000Z', 'not json');

      expect(listActiveSuperIdsQuery(db)).toEqual([
        'sess_tie_second', 'sess_tie_first', 'sess_newer', 'sess_older',
      ]);

      db.run('INSERT INTO workspace_index (workspace_id, creator_session_id, name) VALUES (?1, ?2, ?3)',
        ['ws_super', 'sess_super', SUPER_WORKSPACE_NAME]);
      db.run('INSERT INTO workspace_index (workspace_id, creator_session_id, name) VALUES (?1, ?2, ?3)',
        ['ws_other', 'sess_super', 'Other']);
      expect(superWorkspaceIdsCreatedBy(db, 'sess_super')).toEqual(['ws_super']);
      expect(superWorkspaceIdsCreatedBy(db, 'sess_absent')).toEqual([]);

      const lookup = createSuperSessionLookup(db);
      expect(lookup.listActiveSuperIds()).toEqual([
        'sess_tie_second', 'sess_tie_first', 'sess_newer', 'sess_older',
      ]);
      expect(lookup.workspacesCreatedBy('sess_super')).toEqual(['ws_super']);
    } finally {
      storage.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
