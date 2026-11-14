/**
 * inbox.rs::tests 的运行/投递部分（8 个原测试 + 投递编排）。
 *
 * 协调器 / 发送管线是行为忠实的测试替身（FIFO 收件箱、agent metadata、re-enqueue 顺序），
 * 自动回合计数走真实 SQLite（与生产同一条 SQL）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { WindowRef } from '../../../kernel/api.ts';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import type { DatabaseHandle, StorageService } from '../../../platform/storage/api.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type {
  AgentRole, AgentStatus, MessageType, SubagentTaskData, Workspace, WorkspaceAgent, WorkspaceMessage,
} from '../../agent-workspace/api.ts';
import type { ChatSession } from '../../chat/api.ts';
import { ChatV2Error, KILL_SWITCH_BLOCKED_MESSAGE } from '../../chat/api.ts';
import { countConsecutiveInbound } from '../repository/super-inbox.ts';
import { SETTING_ENABLED } from '../src/settings.ts';
import { MAX_AUTO_TURNS, MAX_DRAIN } from '../src/super-session.ts';
import {
  SUPER_WORKSPACE_NAME, classify, commitInterruptMarks, deliverInbox, prepareDelivery, rollbackDrained,
  type Prepared, type PreparedDelivery, type PrepareDeliveryContext, type SendMessagePipeline,
  type SendMessageRequest, type SuperInboxChatSession, type SuperInboxChatState,
  type SuperInboxDeps, type SuperInboxInboxChangedEvent, type SuperInboxKillSwitch,
  type SuperInboxStreamRegistration, type SuperInboxTaskManager, type SuperInboxWarning,
  type SuperInboxWorkspaceCoordinator,
} from '../src/super-inbox-drain.ts';

// ============================================================================
// 测试替身：行为忠实的协调器 / 会话 / chat state / 发送管线
// ============================================================================

class FakeTaskManager implements SuperInboxTaskManager {
  private readonly tasks: SubagentTaskData[] = [];

  create(task: SubagentTaskData): void { this.tasks.push(task); }

  getUnknownTasks(): SubagentTaskData[] { return this.tasks.filter((task) => task.status === 'unknown'); }
}

class FakeCoordinator implements SuperInboxWorkspaceCoordinator {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly agents = new Map<string, Map<string, WorkspaceAgent>>();
  private readonly messages = new Map<string, WorkspaceMessage>();
  private readonly inboxes = new Map<string, string[]>();
  private readonly managers = new Map<string, FakeTaskManager>();
  private sequence = 0;

  private key(workspaceId: string, sessionId: string): string { return `${workspaceId}::${sessionId}`; }

  private inboxOf(workspaceId: string, sessionId: string): string[] {
    const key = this.key(workspaceId, sessionId);
    const existing = this.inboxes.get(key);
    if (existing !== undefined) return existing;
    const created: string[] = [];
    this.inboxes.set(key, created);
    return created;
  }

  createWorkspace(creatorSessionId: string, name: string | null): Workspace {
    this.sequence += 1;
    const id = `ws_${this.sequence}`;
    const now = new Date(this.sequence * 1_000).toISOString();
    const workspace: Workspace = { id, name, status: 'active', creatorSessionId, createdAt: now, updatedAt: now };
    this.workspaces.set(id, workspace);
    this.agents.set(id, new Map());
    this.managers.set(id, new FakeTaskManager());
    return workspace;
  }

  getWorkspace(workspaceId: string): Workspace | null { return this.workspaces.get(workspaceId) ?? null; }

  registerAgent(
    workspaceId: string, sessionId: string, role: AgentRole, skillId: string | null, metadata: unknown,
  ): WorkspaceAgent {
    const now = new Date(2_000 + this.agents.get(workspaceId)!.size * 1_000).toISOString();
    const agent: WorkspaceAgent = {
      sessionId, workspaceId, role, skillId, status: 'idle', joinedAt: now, lastActiveAt: now,
      metadata: metadata as WorkspaceAgent['metadata'],
    };
    this.agents.get(workspaceId)!.set(sessionId, agent);
    return agent;
  }

  getAgent(workspaceId: string, sessionId: string): WorkspaceAgent | null {
    return this.agents.get(workspaceId)?.get(sessionId) ?? null;
  }

  updateAgentMetadata(workspaceId: string, sessionId: string, metadata: unknown): void {
    const agent = this.getAgent(workspaceId, sessionId);
    if (agent === null) throw new Error(`Agent not found: ${sessionId}`);
    this.agents.get(workspaceId)!.set(sessionId, { ...agent, metadata: metadata as WorkspaceAgent['metadata'] });
  }

  updateAgentStatus(workspaceId: string, sessionId: string, status: AgentStatus): void {
    const agent = this.getAgent(workspaceId, sessionId);
    if (agent === null) throw new Error(`Agent not found: ${sessionId}`);
    this.agents.get(workspaceId)!.set(sessionId, { ...agent, status });
  }

  sendMessage(
    workspaceId: string, senderId: string, targetId: string | null, messageType: MessageType, content: string,
  ): WorkspaceMessage {
    this.sequence += 1;
    const message: WorkspaceMessage = {
      id: `wsmsg_${this.sequence}`,
      workspaceId,
      senderSessionId: senderId,
      targetSessionId: targetId,
      messageType,
      content,
      status: 'pending',
      createdAt: new Date(3_000 + this.sequence * 1_000).toISOString(),
    };
    this.messages.set(message.id, message);
    if (targetId !== null) this.inboxOf(workspaceId, targetId).push(message.id);
    return message;
  }

  drainInbox(workspaceId: string, sessionId: string, limit: number): WorkspaceMessage[] {
    const ids = this.inboxOf(workspaceId, sessionId).splice(0, limit);
    return ids.map((id) => {
      const message = this.messages.get(id);
      if (message === undefined) throw new Error(`Message not found: ${id}`);
      return message;
    });
  }

  peekInbox(workspaceId: string, sessionId: string): WorkspaceMessage[] {
    return this.inboxOf(workspaceId, sessionId).map((id) => {
      const message = this.messages.get(id);
      if (message === undefined) throw new Error(`Message not found: ${id}`);
      return message;
    });
  }

  pendingInboxCount(workspaceId: string, sessionId: string): number {
    return this.inboxOf(workspaceId, sessionId).length;
  }

  /** Rust `re_enqueue_message`：追加到内存 FIFO 尾部（重复入队被忽略）。 */
  reEnqueueMessage(workspaceId: string, sessionId: string, messageId: string): void {
    if (!this.messages.has(messageId)) throw new Error(`Message not found: ${messageId}`);
    const ids = this.inboxOf(workspaceId, sessionId);
    if (!ids.includes(messageId)) ids.push(messageId);
  }

  getTaskManager(workspaceId: string): SuperInboxTaskManager {
    const manager = this.managers.get(workspaceId);
    if (manager === undefined) throw new Error(`Workspace not found: ${workspaceId}`);
    return manager;
  }

  unknownTasks(workspaceId: string): FakeTaskManager { return this.managers.get(workspaceId)!; }
}

class FakeChatSession implements SuperInboxChatSession {
  readonly sessions = new Map<string, ChatSession>();

  getSession(sessionId: string): ChatSession | null { return this.sessions.get(sessionId) ?? null; }

  updateSession(session: ChatSession): void { this.sessions.set(session.id, session); }
}

class FakeKillSwitch implements SuperInboxKillSwitch {
  tripped = false;
  calls = 0;
  afterAllowed: ((call: number) => void) | null = null;

  isTripped(): boolean { return this.tripped; }

  ensureAllowed(): void {
    if (this.tripped) throw new Error(KILL_SWITCH_BLOCKED_MESSAGE);
    this.calls += 1;
    this.afterAllowed?.(this.calls);
  }

  trip(): void { this.tripped = true; }
}

class FakeChatState implements SuperInboxChatState {
  readonly killSwitch = new FakeKillSwitch();
  readonly tracked: Promise<unknown>[] = [];
  private readonly streams = new Map<string, bigint>();
  private nextGeneration = 1n;

  tryRegisterStreamOwned(sessionId: string): SuperInboxStreamRegistration | null {
    if (this.killSwitch.isTripped() || this.streams.has(sessionId)) return null;
    const registration = { token: new AbortController(), generation: this.nextGeneration };
    this.nextGeneration += 1n;
    this.streams.set(sessionId, registration.generation);
    return registration;
  }

  removeStreamIfGeneration(sessionId: string, generation: bigint): boolean {
    if (this.streams.get(sessionId) !== generation) return false;
    return this.streams.delete(sessionId);
  }

  spawnTracked<T>(task: Promise<T>): Promise<T> { this.tracked.push(task); return task; }

  activeStreams(): number { return this.streams.size; }

  async settle(): Promise<void> { await Promise.all(this.tracked); }
}

const WINDOW: WindowRef = { window: 'main', webview: 'main' };

class FakeSendMessagePipeline implements SendMessagePipeline {
  readonly requests: SendMessageRequest[] = [];
  readonly windows: WindowRef[] = [];
  readonly registrations: SuperInboxStreamRegistration[] = [];
  /** 管线启动瞬间注册中的流数量（Rust 里流由管线持有到回合结束）。 */
  streamsAtStart: number | null = null;
  state: FakeChatState | null = null;
  /** 同步抛出（管线未能启动）。 */
  startError: Error | null = null;
  /** 返回被拒绝的 Promise（回合启动后失败）。 */
  turnError: Error | null = null;
  readonly goalHooks: string[] = [];

  spawnGoalContinuation(window: WindowRef, sessionId: string): void {
    this.windows.push(window);
    this.goalHooks.push(`continue:${sessionId}`);
  }

  settleActiveGoal(window: WindowRef, sessionId: string, status: 'paused' | 'blocked'): void {
    this.windows.push(window);
    this.goalHooks.push(`${status}:${sessionId}`);
  }

  runSendMessage(window: WindowRef, request: SendMessageRequest, registration: SuperInboxStreamRegistration): Promise<string> {
    if (this.startError !== null) throw this.startError;
    this.streamsAtStart = this.state?.activeStreams() ?? null;
    this.windows.push(window);
    this.registrations.push(registration);
    this.requests.push(request);
    if (this.turnError !== null) return Promise.reject(this.turnError);
    return Promise.resolve(request.assistantMessageId);
  }
}

// ============================================================================
// 夹具
// ============================================================================

interface Fixture {
  host: TestHost;
  storage: StorageService;
  db: DatabaseHandle;
  coordinator: FakeCoordinator;
  chat: FakeChatSession;
  state: FakeChatState;
  pipeline: FakeSendMessagePipeline;
  deps: SuperInboxDeps;
  sid: string;
  ws: string;
  enabled: { value: boolean };
  warnings: SuperInboxWarning[];
  inboxEvents: SuperInboxInboxChangedEvent[];
}

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function setup(): Promise<Fixture> {
  const host = await createTestHost();
  const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  cleanup = async () => { storage.dispose(); await host.dispose(); };
  const db = storage.database('chat_v2');
  db.exec(`CREATE TABLE chat_v2_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    block_ids_json TEXT NOT NULL DEFAULT '[]',
    timestamp INTEGER NOT NULL,
    meta_json TEXT
  )`);

  const sid = 'sess_1';
  const coordinator = new FakeCoordinator();
  const workspace = coordinator.createWorkspace(sid, SUPER_WORKSPACE_NAME);
  coordinator.registerAgent(workspace.id, sid, 'coordinator', null, null);

  const chat = new FakeChatSession();
  const now = new Date(0).toISOString();
  chat.updateSession({
    id: sid,
    mode: 'chat',
    title: 'Super-agent',
    titleLocked: true,
    persistStatus: 'active',
    createdAt: now,
    updatedAt: now,
    metadata: {
      super_agent: { active: true, version: 1, workspace_id: workspace.id, hidden: false },
      pinned: true,
    },
  });

  const enabled = { value: true };
  const warnings: SuperInboxWarning[] = [];
  const inboxEvents: SuperInboxInboxChangedEvent[] = [];
  const state = new FakeChatState();
  const pipeline = new FakeSendMessagePipeline();
  pipeline.state = state;
  const deps: SuperInboxDeps = {
    chat,
    workspace: coordinator,
    chatDb: db,
    settings: {
      get: (key: string) => (key === SETTING_ENABLED ? (enabled.value ? 'true' : null) : null),
      save: () => undefined,
    },
    state,
    pipeline,
    reportWarning: (warning) => { warnings.push(warning); },
    emitInboxChanged: (event) => { inboxEvents.push(event); },
  };
  return {
    host, storage, db, coordinator, chat, state, pipeline, deps,
    sid, ws: workspace.id, enabled, warnings, inboxEvents,
  };
}

function prepareContext(f: Fixture): PrepareDeliveryContext {
  return {
    chatDb: f.db,
    coordinator: f.coordinator,
    reportWarning: (warning) => { f.warnings.push(warning); },
  };
}

function prepare(f: Fixture, force = false): Prepared {
  return prepareDelivery(prepareContext(f), f.sid, f.ws, force);
}

function ready(prepared: Prepared): PreparedDelivery {
  if (prepared.status !== 'ready') throw new Error(`expected Ready, got ${prepared.status}`);
  return prepared.delivery;
}

function addWorker(f: Fixture, id: string, extra: Record<string, unknown> = {}): void {
  f.coordinator.registerAgent(f.ws, id, 'worker', null, {
    super_agent: { title: '整理错题', dispatched_in_message_id: 'msg_1', ...extra },
  });
  f.coordinator.updateAgentStatus(f.ws, id, 'running');
}

function sendResult(
  f: Fixture, worker: string, status: 'completed' | 'failed' | 'cancelled', output: string,
): string {
  const envelope = {
    type: 'agent_completion',
    workspace_id: f.ws,
    agent_session_id: worker,
    parent_session_id: f.sid,
    task_id: 'task_1',
    run_id: 'run_1',
    status,
    final_output: status === 'completed' ? output : null,
    error: status === 'completed' ? null : output,
    completed_at: '2026-11-01T00:00:00Z',
  };
  return f.coordinator.sendMessage(f.ws, worker, f.sid, 'result', JSON.stringify(envelope)).id;
}

function sendProgress(f: Fixture, worker: string, text: string): string {
  return f.coordinator.sendMessage(f.ws, worker, f.sid, 'progress', text).id;
}

function insertUserMessage(f: Fixture, timestamp: number, inbound: boolean): void {
  f.db.run(
    `INSERT INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp, meta_json)
     VALUES (?, ?, 'user', '[]', ?, ?)`,
    [
      `msg_u_${timestamp}`,
      f.sid,
      timestamp,
      inbound ? JSON.stringify({ inboundOrigin: { kind: 'super_inbox', items: [] } }) : null,
    ],
  );
}

// ============================================================================
// inbox.rs::tests
// ============================================================================

describe('super_session/inbox.rs prepare_delivery', () => {
  it('progress_only_does_not_trigger_and_is_not_consumed', async () => {
    const f = await setup();
    addWorker(f, 'w1');
    sendProgress(f, 'w1', '进行中 30%');
    sendProgress(f, 'w1', '进行中 60%');

    expect(prepare(f)).toEqual({ status: 'empty' });
    expect(f.coordinator.pendingInboxCount(f.ws, f.sid)).toBe(2);
  });

  it('completion_is_delivered_with_latest_progress_only', async () => {
    const f = await setup();
    addWorker(f, 'w1');
    sendProgress(f, 'w1', '进行中 30%');
    sendProgress(f, 'w1', '进行中 60%');
    const resultId = sendResult(f, 'w1', 'completed', '共 12 道错题，已按知识点归类');

    const delivery = ready(prepare(f));
    expect(delivery.content).toContain('worker.completed');
    expect(delivery.content).toContain('共 12 道错题');
    expect(delivery.content).toContain('进行中 60%');
    expect(delivery.content).not.toContain('进行中 30%');
    expect(delivery.drainedIds).toContain(resultId);
    expect(delivery.drainedIds).toHaveLength(2);

    const items = delivery.origin.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('整理错题');
    expect(items[0]!.taskId).toBe('task_1');
    expect(f.coordinator.pendingInboxCount(f.ws, f.sid)).toBe(0);
  });

  it('drain_is_capped_per_batch', async () => {
    const f = await setup();
    addWorker(f, 'w1');
    for (let index = 0; index < MAX_DRAIN + 3; index += 1) {
      sendResult(f, 'w1', 'completed', `结果${index}`);
    }

    const delivery = ready(prepare(f));
    expect(delivery.drainedIds).toHaveLength(MAX_DRAIN);
    expect(f.coordinator.pendingInboxCount(f.ws, f.sid)).toBe(3);
  });

  it('failure_after_drain_rolls_back', async () => {
    const f = await setup();
    addWorker(f, 'w1');
    sendResult(f, 'w1', 'failed', 'boom');

    const delivery = ready(prepare(f));
    expect(delivery.content).toContain('worker.failed');
    expect((delivery.origin.items as Array<Record<string, unknown>>)[0]!.status).toBe('failed');
    expect(f.coordinator.pendingInboxCount(f.ws, f.sid)).toBe(0);

    // 管线启动前失败 → 放回
    expect(rollbackDrained(f.coordinator, f.ws, f.sid, delivery.drainedIds)).toEqual([]);
    expect(f.coordinator.pendingInboxCount(f.ws, f.sid)).toBe(1);

    const again = ready(prepare(f));
    expect(again.drainedIds).toEqual(delivery.drainedIds);
  });

  it('cancel_receipts_of_closed_or_superseded_workers_are_swallowed', async () => {
    const f = await setup();
    addWorker(f, 'w_closed', { closed_by_router: true });
    addWorker(f, 'w_super', { superseded: true });
    addWorker(f, 'w_plain');
    sendResult(f, 'w_closed', 'cancelled', 'execution cancelled');
    sendResult(f, 'w_super', 'cancelled', 'execution cancelled');

    expect(prepare(f)).toEqual({ status: 'empty' });
    // 被吞的回执已消费，不会反复触发
    expect(f.coordinator.pendingInboxCount(f.ws, f.sid)).toBe(0);

    // 普通 Worker 的取消回执照常上报
    sendResult(f, 'w_plain', 'cancelled', 'execution cancelled');
    const delivery = ready(prepare(f));
    const items = delivery.origin.items as Array<Record<string, unknown>>;
    expect(items[0]!.status).toBe('cancelled');
    expect(items[0]!.agentSessionId).toBe('w_plain');
  });

  it('swallowed_with_progress_puts_progress_back', async () => {
    const f = await setup();
    addWorker(f, 'w_closed', { closed_by_router: true });
    addWorker(f, 'w1');
    sendProgress(f, 'w1', '进行中');
    sendResult(f, 'w_closed', 'cancelled', 'execution cancelled');

    expect(prepare(f)).toEqual({ status: 'empty' });
    expect(f.coordinator.pendingInboxCount(f.ws, f.sid)).toBe(1);
  });

  it('unknown_task_is_reported_once', async () => {
    const f = await setup();
    addWorker(f, 'w1');
    const task: SubagentTaskData = {
      id: 'task_unknown',
      workspaceId: f.ws,
      agentSessionId: 'w1',
      skillId: null,
      initialTask: '整理错题',
      status: 'unknown',
      createdAt: '2026-11-01T00:00:00Z',
      startedAt: '2026-11-01T00:00:01Z',
      completedAt: null,
      resultSummary: null,
    };
    f.coordinator.unknownTasks(f.ws).create(task);

    const delivery = ready(prepare(f));
    expect(delivery.content).toContain('worker.interrupted');
    expect(delivery.drainedIds).toEqual([]);
    expect((delivery.origin.items as Array<Record<string, unknown>>)[0]!.status).toBe('interrupted');
    expect(delivery.interruptMarks).toHaveLength(1);

    // 未提交标记前仍会再次出现（启动前失败可重试）
    expect(prepare(f).status).toBe('ready');
    expect(commitInterruptMarks(f.coordinator, f.ws, delivery.interruptMarks)).toEqual([]);
    expect(prepare(f)).toEqual({ status: 'empty' });
  });

  it('auto_turn_limit_pauses_and_force_skips', async () => {
    const f = await setup();
    addWorker(f, 'w1');
    sendResult(f, 'w1', 'completed', 'ok');
    insertUserMessage(f, 1, false); // 人类消息
    for (let index = 0; index < MAX_AUTO_TURNS; index += 1) {
      insertUserMessage(f, 10 + index, true);
    }

    expect(countConsecutiveInbound(f.db, f.sid)).toBe(MAX_AUTO_TURNS);
    expect(prepare(f)).toEqual({ status: 'paused', autoTurns: MAX_AUTO_TURNS });
    // Paused 不消费收件箱
    expect(f.coordinator.pendingInboxCount(f.ws, f.sid)).toBe(1);

    const delivery = ready(prepare(f, true));
    expect(delivery.origin.autoTurn).toBe(MAX_AUTO_TURNS + 1);

    // 新的人类消息重置计数
    insertUserMessage(f, 1_000, false);
    expect(countConsecutiveInbound(f.db, f.sid)).toBe(0);
  });
});

// ============================================================================
// 分类 / 收件箱投递编排
// ============================================================================

describe('super_session/inbox.rs deliver_inbox', () => {
  it('classify_swallows_cancel_receipts_only_for_closed_or_superseded_workers', async () => {
    const f = await setup();
    addWorker(f, 'w_closed', { closed_by_router: true });
    addWorker(f, 'w_plain');
    sendResult(f, 'w_closed', 'cancelled', 'execution cancelled');
    sendResult(f, 'w_plain', 'cancelled', 'execution cancelled');

    const messages = f.coordinator.peekInbox(f.ws, f.sid);
    expect(classify(messages[0]!, f.coordinator.getAgent(f.ws, 'w_closed'))).toEqual({ kind: 'swallow' });
    const plain = classify(messages[1]!, f.coordinator.getAgent(f.ws, 'w_plain'));
    expect(plain.kind).toBe('entry');
  });

  it('deliver_starts_the_pipeline_with_super_inbox_options', async () => {
    const f = await setup();
    addWorker(f, 'w1');
    sendResult(f, 'w1', 'completed', '共 12 道错题');

    const outcome = await deliverInbox(f.deps, {
      sessionId: f.sid,
      userMessageId: 'msg_u',
      assistantMessageId: 'msg_a',
      options: { modelId: 'm1' },
      force: false,
      window: WINDOW,
    });
    if (outcome.status !== 'started') throw new Error(`expected started, got ${outcome.status}`);

    expect(outcome.userMessage.id).toBe('msg_u');
    expect(outcome.assistantMessageId).toBe('msg_a');
    expect(outcome.userMessage.content).toContain('worker.completed');
    expect(outcome.userMessage.content).toContain('共 12 道错题');
    expect(outcome.userMessage.timestampMs).toBeGreaterThan(0);
    expect((outcome.userMessage.inboundOrigin as Record<string, unknown>).kind).toBe('super_inbox');

    expect(f.pipeline.requests).toHaveLength(1);
    const request = f.pipeline.requests[0]!;
    expect(request.sessionId).toBe(f.sid);
    expect(request.content).toBe(outcome.userMessage.content);
    expect(request.options.modelId).toBe('m1');
    expect(request.options.userMessageOrigin).toBe(outcome.userMessage.inboundOrigin);
    expect(request.options.autoMemoryExtraction).toBe(false);
    expect(request.options.replayMode).toBeNull();
    expect(request.userMessageId).toBe('msg_u');
    expect(request.assistantMessageId).toBe('msg_a');
    expect(request.workspaceId).toBeNull();
    expect(request.skipUserMessageSave).toBeNull();

    expect(f.inboxEvents).toEqual([{ sessionId: f.sid, workspaceId: f.ws, pendingInbox: 0 }]);
    expect(f.pipeline.streamsAtStart).toBe(1);
    // send_message.rs run_send_message_pipeline_owned: the pipeline gets the delivery's own registration and window.
    expect(f.pipeline.registrations).toHaveLength(1);
    expect(f.pipeline.registrations[0]!.generation).toBe(1n);
    expect(f.pipeline.registrations[0]!.token.signal.aborted).toBe(false);
    await f.state.settle();
    expect(f.pipeline.windows).toEqual([WINDOW, WINDOW]);
    expect(f.state.activeStreams()).toBe(0);
    expect(f.warnings).toEqual([]);
  });

  it('deliver_reports_a_goal_hook_failure_instead_of_leaving_a_rejected_task', async () => {
    const f = await setup();
    addWorker(f, 'w1');
    sendResult(f, 'w1', 'completed', 'ok');
    f.pipeline.spawnGoalContinuation = () => { throw new Error('backgroundTasks missing'); };

    const outcome = await deliverInbox(f.deps, {
      sessionId: f.sid, userMessageId: 'msg_u', assistantMessageId: 'msg_a',
      options: { modelId: null }, force: false, window: WINDOW,
    });
    expect(outcome.status).toBe('started');
    await f.state.settle();

    expect(f.state.activeStreams()).toBe(0);
    expect(f.warnings).toEqual([expect.objectContaining({
      code: 'super_inbox_goal_hook_failed', sessionId: f.sid, messageId: 'msg_a',
      message: expect.stringContaining('backgroundTasks missing'),
    })]);
  });

  it('deliver_returns_busy_when_the_session_stream_is_taken', async () => {
    const f = await setup();
    addWorker(f, 'w1');
    sendResult(f, 'w1', 'completed', 'ok');
    f.state.tryRegisterStreamOwned(f.sid);

    expect(await deliverInbox(f.deps, {
      sessionId: f.sid, userMessageId: 'msg_u', assistantMessageId: 'msg_a',
      options: { modelId: null }, force: false, window: WINDOW,
    })).toEqual({ status: 'busy' });
    expect(f.coordinator.pendingInboxCount(f.ws, f.sid)).toBe(1);
    expect(f.pipeline.requests).toEqual([]);
  });

  it('deliver_returns_disabled_when_the_super_session_is_off_or_hidden', async () => {
    const f = await setup();
    addWorker(f, 'w1');
    sendResult(f, 'w1', 'completed', 'ok');

    f.enabled.value = false;
    expect(await deliverInbox(f.deps, {
      sessionId: f.sid, userMessageId: 'msg_u', assistantMessageId: 'msg_a',
      options: { modelId: null }, force: false, window: WINDOW,
    })).toEqual({ status: 'disabled' });

    f.enabled.value = true;
    f.chat.updateSession({
      ...f.chat.getSession(f.sid)!,
      metadata: { super_agent: { active: true, workspace_id: f.ws, hidden: true } },
    });
    expect(await deliverInbox(f.deps, {
      sessionId: f.sid, userMessageId: 'msg_u', assistantMessageId: 'msg_a',
      options: { modelId: null }, force: false, window: WINDOW,
    })).toEqual({ status: 'disabled' });
    expect(f.pipeline.requests).toEqual([]);
  });

  it('deliver_puts_drained_messages_back_when_the_kill_switch_trips_after_drain', async () => {
    const f = await setup();
    addWorker(f, 'w1');
    sendResult(f, 'w1', 'completed', 'ok');
    f.state.killSwitch.afterAllowed = (call) => { if (call === 1) f.state.killSwitch.trip(); };

    await expect(deliverInbox(f.deps, {
      sessionId: f.sid, userMessageId: 'msg_u', assistantMessageId: 'msg_a',
      options: { modelId: null }, force: false, window: WINDOW,
    })).rejects.toThrow(KILL_SWITCH_BLOCKED_MESSAGE);

    expect(f.coordinator.pendingInboxCount(f.ws, f.sid)).toBe(1);
    expect(f.pipeline.requests).toEqual([]);
    expect(f.state.activeStreams()).toBe(0);
    expect(f.inboxEvents).toEqual([]);
  });

  it('deliver_puts_drained_messages_back_when_the_pipeline_cannot_start', async () => {
    const f = await setup();
    addWorker(f, 'w1');
    const resultId = sendResult(f, 'w1', 'completed', 'ok');
    f.pipeline.startError = new Error('send pipeline offline');

    await expect(deliverInbox(f.deps, {
      sessionId: f.sid, userMessageId: 'msg_u', assistantMessageId: 'msg_a',
      options: { modelId: null }, force: false, window: WINDOW,
    })).rejects.toThrow('send pipeline offline');

    expect(f.coordinator.pendingInboxCount(f.ws, f.sid)).toBe(1);
    expect(f.coordinator.peekInbox(f.ws, f.sid).map((message) => message.id)).toEqual([resultId]);
    expect(f.state.activeStreams()).toBe(0);
    expect(f.inboxEvents).toEqual([]);
  });

  it('deliver_reports_a_failed_turn_without_re_enqueueing_the_delivered_messages', async () => {
    const f = await setup();
    addWorker(f, 'w1');
    sendResult(f, 'w1', 'completed', 'ok');
    f.pipeline.turnError = new Error('model exploded');

    const outcome = await deliverInbox(f.deps, {
      sessionId: f.sid, userMessageId: 'msg_u', assistantMessageId: 'msg_a',
      options: { modelId: null }, force: false, window: WINDOW,
    });
    expect(outcome.status).toBe('started');
    await f.state.settle();

    // 消息已进入会话历史，重放会重复投递；只报告并释放流。
    expect(f.coordinator.pendingInboxCount(f.ws, f.sid)).toBe(0);
    expect(f.state.activeStreams()).toBe(0);
    expect(f.warnings).toHaveLength(1);
    expect(f.warnings[0]!.code).toBe('super_inbox_turn_failed');
    expect(f.warnings[0]!.message).toContain('model exploded');
  });

  // inbox.rs:940-973: the delivery turn ends like a send turn — continue an active goal, pause it on cancel, block it on error.
  it('deliver_settles_the_session_goal_when_the_delivery_turn_ends', async () => {
    const outcomes: Array<[Error | null, string]> = [
      [null, 'continue:sess_1'],
      [new ChatV2Error('Cancelled'), 'paused:sess_1'],
      [new Error('model exploded'), 'blocked:sess_1'],
    ];
    for (const [turnError, hook] of outcomes) {
      const f = await setup();
      addWorker(f, 'w1');
      sendResult(f, 'w1', 'completed', 'ok');
      f.pipeline.turnError = turnError;

      const outcome = await deliverInbox(f.deps, {
        sessionId: f.sid, userMessageId: 'msg_u', assistantMessageId: 'msg_a',
        options: { modelId: null }, force: false, window: WINDOW,
      });
      expect(outcome.status).toBe('started');
      await f.state.settle();

      expect(f.pipeline.goalHooks).toEqual([hook]);
      expect(f.state.activeStreams()).toBe(0);
      await cleanup?.();
      cleanup = null;
    }
  });
});
