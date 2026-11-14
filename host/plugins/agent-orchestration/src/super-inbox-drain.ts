/**
 * super_session/inbox.rs 的运行时/投递部分：drain → 分类 → 格式化 → 启动发送管线。
 *
 * 格式化与序列化（neutralize / xmlAttr / formatSuperInboxDelivery / DeliverOutcome /
 * parseDeliverInboxRequest …）已在 `./super-session.ts` 中移植，这里只复用，不重复实现。
 *
 * 跨 lane 依赖尚未由各自的插件 provide；本文件只声明**最小消费接口**，在运行时用
 * `ctx.get('<service>')` 取；缺任何一个都抛明确错误（绝不静默降级）：
 * - `chatSession`           会话读取 / 工作区绑定回写（L04）
 * - `agentWorkspace`        收件箱 drain/peek/re-enqueue + agent metadata（L05）
 * - `chatState`             kill switch + 流注册（L04）
 * - `chat.send@1`              发送管线 `run_send_message_pipeline_owned`（chat-pipeline 发布）
 * - `storage`                  chat_v2.db 句柄（自动回合计数的只读 SQL，见 repository/super-inbox.ts）
 */

import type { Context } from '@deepseek-ai/cordis';
import type { SendOptions } from '../../../../contracts/ipc/generated/_shared.ts';
import type { WindowRef } from '../../../kernel/api.ts';
import type { SqlExecutor, StorageService } from '../../../platform/storage/api.ts';
import type { AgentRole, SubagentTaskData, Workspace, WorkspaceAgent, WorkspaceMessage } from '../../agent-workspace/api.ts';
import {
  ChatV2Error, KILL_SWITCH_BLOCKED_MESSAGE, KILL_SWITCH_STATE_UNAVAILABLE_MESSAGE, type ChatSession,
} from '../../chat/api.ts';
import { countConsecutiveInbound } from '../repository/super-inbox.ts';
import { isExternalSender } from './inbound.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { readEnabled, type SuperSettingsStore } from './settings.ts';
import {
  MAX_AUTO_TURNS, MAX_DRAIN, formatSuperInboxDelivery, isActiveSuperMetadata, metadataHidden,
  metadataWorkspaceId, oneLine, superMeta,
  type DeliverOutcome, type SuperInboxEntry,
} from './super-session.ts';

export { countConsecutiveInbound };

/** 前面若干批全是 Progress / 被吞回执时，最多继续 drain 的批数（inbox.rs:47）。 */
export const MAX_DRAIN_ROUNDS = 10;
/** Super 工作区名（state.rs `SUPER_WORKSPACE_NAME`）。 */
export const SUPER_WORKSPACE_NAME = 'Super-agent';

export const SUPER_AGENT_META_KEY = 'super_agent';
export const WORKER_META_TITLE = 'title';
export const WORKER_META_CLOSED_BY_ROUTER = 'closed_by_router';
export const WORKER_META_SUPERSEDED = 'superseded';
export const WORKER_META_INTERRUPT_REPORTED = 'interrupt_reported_task_id';
/** 外部事件伪发送者：`inbound.rs` 的 `EXTERNAL_META_KEY`。 */
export const EXTERNAL_META_KEY = 'super_external';
/** 每个外部事件伪发送者的 session id 前缀（inbound.rs `EXTERNAL_SENDER_PREFIX`）。 */
export const EXTERNAL_SENDER_PREFIX = 'external:';

const VALIDATION_PREFIX = 'Validation error: ';

// ============================================================================
// 跨 lane 最小消费接口
// ============================================================================

/** `agentWorkspace` 中本模块消费的收件箱/agent 子集。 */
export interface SuperInboxWorkspaceCoordinator {
  getWorkspace(workspaceId: string): Workspace | null;
  createWorkspace(creatorSessionId: string, name: string | null): Workspace;
  registerAgent(workspaceId: string, sessionId: string, role: AgentRole, skillId: string | null, metadata: unknown): WorkspaceAgent;
  getAgent(workspaceId: string, sessionId: string): WorkspaceAgent | null;
  updateAgentMetadata(workspaceId: string, sessionId: string, metadata: unknown): void;
  drainInbox(workspaceId: string, sessionId: string, limit: number): WorkspaceMessage[];
  peekInbox(workspaceId: string, sessionId: string): WorkspaceMessage[];
  pendingInboxCount(workspaceId: string, sessionId: string): number;
  reEnqueueMessage(workspaceId: string, sessionId: string, messageId: string): void;
  /**
   * L05 的 subagent 任务仓储。`agentWorkspace` 的公开类型里还没有它，但未知任务
   * （应用重启时正在运行）只能从这里读；缺失时投递直接失败而不是漏报中断。
   */
  getTaskManager(workspaceId: string): SuperInboxTaskManager;
}

/** `SubagentTaskManager::get_unknown_tasks` 的最小形状。 */
export interface SuperInboxTaskManager {
  getUnknownTasks(): SubagentTaskData[];
}

/** `chatSession` 中本模块消费的会话读写子集。 */
export interface SuperInboxChatSession {
  getSession(sessionId: string): ChatSession | null;
  updateSession(session: ChatSession): void;
}

export interface SuperInboxKillSwitch {
  isTripped(): boolean;
  ensureAllowed(): void;
}

/** `chatState.tryRegisterStreamOwned` 的结果；投递把它整份交给发送管线（Rust 的 owned registration）。 */
export interface SuperInboxStreamRegistration {
  readonly token: AbortController;
  readonly generation: bigint;
}

/** `chatState`：kill switch + 原子流注册 + 后台任务跟踪。 */
export interface SuperInboxChatState {
  readonly killSwitch: SuperInboxKillSwitch;
  tryRegisterStreamOwned(sessionId: string): SuperInboxStreamRegistration | null;
  removeStreamIfGeneration(sessionId: string, generation: bigint): boolean;
  spawnTracked<T>(task: Promise<T>): Promise<T>;
}

export type SuperInboxReplayMode = NonNullable<SendOptions['replayMode']>;

export interface SendMessageTurnOptions {
  modelId: string | null;
  userMessageOrigin: Record<string, unknown>;
  autoMemoryExtraction: false;
  replayMode: SuperInboxReplayMode | null;
  temperature: number | null;
}

/** `SendMessageRequest` 中本流程实际使用的字段（inbox.rs:900–909）。 */
export interface SendMessageRequest {
  sessionId: string;
  content: string;
  options: SendMessageTurnOptions;
  userMessageId: string;
  assistantMessageId: string;
  userContextRefs: null;
  pathMap: null;
  workspaceId: null;
  skipUserMessageSave: null;
}

/**
 * `chat.send@1`：send_message.rs `run_send_message_pipeline_owned(window, …, request, registration)`，
 * 由 chat-pipeline 发布。`registration` 是投递方已原子注册的流；管线持有它直到回合结束。
 * 解析到 assistant 消息 id（Rust `ChatV2Result<String>`）。
 */
export interface SendMessagePipeline {
  runSendMessage(window: WindowRef, request: SendMessageRequest, registration: SuperInboxStreamRegistration): Promise<string>;
  /** goal/runtime.rs `spawn_goal_continuation_if_idle`（chat 的 GoalRuntime.spawnContinuation）。 */
  spawnGoalContinuation(window: WindowRef, sessionId: string): void;
  /** goal/runtime.rs `settle_active_goal_on_turn_end`（chat 的 GoalRuntime.settleActive）。 */
  settleActiveGoal(window: WindowRef, sessionId: string, status: 'paused' | 'blocked'): void;
}

/** 投递流程内部告警（对应 Rust 的 `coordinator.emit_warning` / 收不到流事件时的告警）。 */
export interface SuperInboxWarning {
  code: string;
  message: string;
  workspaceId: string;
  sessionId: string;
  messageId: string | null;
}

export interface SuperInboxInboxChangedEvent {
  sessionId: string;
  workspaceId: string;
  pendingInbox: number;
}

export interface SuperInboxDeps {
  chat: SuperInboxChatSession;
  workspace: SuperInboxWorkspaceCoordinator;
  /** chat_v2.db：自动回合计数只读查询。 */
  chatDb: SqlExecutor;
  settings: SuperSettingsStore;
  state: SuperInboxChatState;
  pipeline: SendMessagePipeline;
  reportWarning: (warning: SuperInboxWarning) => void;
  emitInboxChanged: (event: SuperInboxInboxChangedEvent) => void;
}

/** 投递请求：`options` 取 Rust `SendOptions` 中本流程会用到的字段（含 replay 覆盖）。 */
export type SuperInboxDeliverOptions = Pick<SendOptions, 'modelId' | 'temperature' | 'replayMode'>;

export interface SuperInboxDeliverRequest {
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  options: SuperInboxDeliverOptions;
  force: boolean;
  /** 发起投递的窗口（Rust 命令注入的 `Window`），流事件发往这里。 */
  window: WindowRef;
}

// ============================================================================
// 服务解析（缺失即显式失败）
// ============================================================================

export const SEND_MESSAGE_PIPELINE_SERVICE = 'chat.send@1';

function requireService<T>(ctx: Context, name: string): T {
  const service = ctx.get(name) as T | undefined;
  if (service === undefined) {
    throw new Error(
      `Service "${name}" is not published; chat_v2_super_deliver_inbox cannot deliver the inbox without it.`,
    );
  }
  return service;
}

/** kill switch 服务缺失时 fail-closed（Rust `admit_or_block_from_app` 的同一语义）。 */
function requireChatState(ctx: Context): SuperInboxChatState {
  const service = ctx.get('chatState') as SuperInboxChatState | undefined;
  if (service === undefined) {
    throw new Error(`${KILL_SWITCH_STATE_UNAVAILABLE_MESSAGE} (service "chatState" is not published)`);
  }
  return service;
}

/**
 * 生产装配：从 Context 取齐全部依赖。
 *
 * `chatState` 未发布时直接抛错（fail-closed），与 Rust `admit_or_block_from_app`
 * 的语义一致——绝不因为拿不到 kill switch 就放行。
 */
export function resolveSuperInboxDeps(
  ctx: Context,
  hooks: {
    reportWarning: SuperInboxDeps['reportWarning'];
    emitInboxChanged: SuperInboxDeps['emitInboxChanged'];
    pipeline?: SendMessagePipeline | null;
  },
): SuperInboxDeps {
  const storage = requireService<StorageService>(ctx, 'storage');
  return {
    chat: requireService<SuperInboxChatSession>(ctx, 'chatSession'),
    workspace: requireService<SuperInboxWorkspaceCoordinator>(ctx, 'agentWorkspace'),
    chatDb: storage.database('chat_v2'),
    settings: requireService<SuperSettingsStore>(ctx, 'settings'),
    state: requireChatState(ctx),
    pipeline: hooks.pipeline ?? requireService<SendMessagePipeline>(ctx, SEND_MESSAGE_PIPELINE_SERVICE),
    reportWarning: hooks.reportWarning,
    emitInboxChanged: hooks.emitInboxChanged,
  };
}

// ============================================================================
// metadata 辅助（state.rs 的子集；与 super-session.ts 的 superMeta 共用解析）
// ============================================================================

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function agentSuperFlag(agent: WorkspaceAgent, key: string): boolean {
  return superMeta(agent.metadata)?.[key] === true;
}

export function agentSuperStr(agent: WorkspaceAgent, key: string): string | null {
  const value = superMeta(agent.metadata)?.[key];
  return typeof value === 'string' ? value : null;
}

/** prompt.rs:112–117。 */
export function workerTitle(agent: WorkspaceAgent): string {
  const title = agentSuperStr(agent, WORKER_META_TITLE);
  if (title === null) return agent.sessionId;
  const trimmed = rustTrim(title);
  return trimmed === '' ? agent.sessionId : trimmed;
}

/** state.rs `is_super_worker`：真正的 Worker，排除外部事件伪发送者。 */
export function isSuperWorker(agent: WorkspaceAgent): boolean {
  return agent.role === 'worker' && !isExternalSender(agent.sessionId);
}

// ============================================================================
// 分类（inbox.rs:220–336）
// ============================================================================

export type Classified =
  | { kind: 'swallow' }
  | { kind: 'entry'; entry: SuperInboxEntry };

function strField(value: unknown, keys: readonly string[]): string | null {
  const object = asRecord(value);
  if (object === null) return null;
  for (const key of keys) {
    const raw = object[key];
    if (typeof raw !== 'string') continue;
    const trimmed = rustTrim(raw);
    if (trimmed !== '') return trimmed;
  }
  return null;
}

function isProgressEntry(entry: SuperInboxEntry): boolean {
  return entry.kind === 'worker' && entry.event === 'progress';
}

/** `Result` 消息若是 `agent_completion` 信封：先看正文 JSON，再看 metadata。 */
function completionEnvelope(message: WorkspaceMessage): Record<string, unknown> | null {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(message.content);
  } catch {
    parsed = null;
  }
  const body = asRecord(parsed);
  if (body !== null && body.type === 'agent_completion') return body;
  const metadata = asRecord(message.metadata);
  return metadata !== null && metadata.type === 'agent_completion' ? metadata : null;
}

/** `Result` 信封 status → 事件种类；未知 status 退化为普通消息（inbox.rs:298–303）。 */
function workerKind(status: string | null): 'completed' | 'failed' | 'cancelled' | 'message' {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  return 'message';
}

/** inbox.rs:232–336。`agent` 为发送者在工作区中的 agent 记录（若有）。 */
export function classify(message: WorkspaceMessage, agent: WorkspaceAgent | null): Classified {
  const at = message.createdAt;
  const externalMeta = asRecord(message.metadata)?.[EXTERNAL_META_KEY];
  if (isExternalSender(message.senderSessionId) || externalMeta !== undefined) {
    const meta = externalMeta ?? null;
    const fromSender = message.senderSessionId.startsWith(EXTERNAL_SENDER_PREFIX)
      ? message.senderSessionId.slice(EXTERNAL_SENDER_PREFIX.length)
      : message.senderSessionId;
    return {
      kind: 'entry',
      entry: {
        kind: 'external',
        messageId: message.id,
        source: strField(meta, ['source']) ?? fromSender,
        sender: strField(meta, ['sender']) ?? '',
        eventKind: strField(meta, ['kind']) ?? 'message',
        threadKey: strField(meta, ['threadKey']) ?? '',
        body: message.content,
        at,
      },
    };
  }

  const workerId = message.senderSessionId;
  const title = agent === null ? workerId : workerTitle(agent);
  const workerEntry = (
    event: 'progress' | 'completed' | 'failed' | 'cancelled' | 'message',
    body: string,
    taskId: string | null,
    runId: string | null,
    entryAt: string,
  ): SuperInboxEntry => ({
    kind: 'worker',
    event,
    workerId,
    title,
    taskId,
    runId,
    messageId: message.id,
    body,
    at: entryAt,
  });

  if (message.messageType === 'progress') {
    return { kind: 'entry', entry: workerEntry('progress', message.content, null, null, at) };
  }
  if (message.messageType !== 'result') {
    return { kind: 'entry', entry: workerEntry('message', message.content, null, null, at) };
  }

  const envelope = completionEnvelope(message);
  if (envelope === null) {
    return { kind: 'entry', entry: workerEntry('message', message.content, null, null, at) };
  }
  const event = workerKind(strField(envelope, ['status']));
  if (event === 'cancelled' && agent !== null
    && (agentSuperFlag(agent, WORKER_META_CLOSED_BY_ROUTER) || agentSuperFlag(agent, WORKER_META_SUPERSEDED))) {
    return { kind: 'swallow' };
  }
  const body = event === 'completed'
    ? strField(envelope, ['final_output', 'finalOutput']) ?? ''
    : strField(envelope, ['error', 'final_output', 'finalOutput']) ?? '';
  const entryAt = strField(envelope, ['completed_at', 'completedAt']) ?? at;
  return {
    kind: 'entry',
    entry: workerEntry(event, body, strField(envelope, ['task_id', 'taskId']), strField(envelope, ['run_id', 'runId']), entryAt),
  };
}

// ============================================================================
// 未知任务（应用重启时正在运行 → worker.interrupted）
// ============================================================================

export interface InterruptMark {
  agentSessionId: string;
  taskId: string;
}

/**
 * 未上报过的 Unknown 任务（应用重启时正在运行、结果未知）。
 *
 * Rust 在 `get_unknown_tasks` 出错时只 warn 并返回空集；这里改为显式抛错：
 * 静默漏报会让 Worker 永远消失在没有结果的状态里。
 */
export function collectUnknownInterrupts(
  coordinator: SuperInboxWorkspaceCoordinator, workspaceId: string,
): Array<{ mark: InterruptMark; entry: SuperInboxEntry }> {
  const manager = coordinator.getTaskManager;
  if (typeof manager !== 'function') {
    throw new Error(
      '"agentWorkspace" does not expose getTaskManager(); L05 must publish the subagent task repository '
      + 'before restart-interrupted workers can be reported.',
    );
  }
  const tasks = manager.call(coordinator, workspaceId).getUnknownTasks();
  const out: Array<{ mark: InterruptMark; entry: SuperInboxEntry }> = [];
  for (const task of tasks) {
    const agent = coordinator.getAgent(workspaceId, task.agentSessionId);
    if (agent === null) continue;
    if (!isSuperWorker(agent)) continue;
    if (agentSuperFlag(agent, WORKER_META_CLOSED_BY_ROUTER)) continue;
    if (agentSuperFlag(agent, WORKER_META_SUPERSEDED)) continue;
    if (agentSuperStr(agent, WORKER_META_INTERRUPT_REPORTED) === task.id) continue;
    const brief = task.initialTask === null ? '' : oneLine(task.initialTask, 200);
    const body = brief === ''
      ? '应用重启时该 Worker 正在运行，结果未知。可视情况用 builtin-super_message_worker 让它继续，或重新派发。'
      : `应用重启时该 Worker 正在运行，结果未知（任务：${brief}）。可视情况用 builtin-super_message_worker 让它继续，或重新派发。`;
    out.push({
      mark: { agentSessionId: agent.sessionId, taskId: task.id },
      entry: {
        kind: 'worker',
        event: 'interrupted',
        workerId: agent.sessionId,
        title: workerTitle(agent),
        taskId: task.id,
        runId: null,
        messageId: null,
        body,
        at: task.startedAt ?? task.createdAt,
      },
    });
  }
  return out;
}

export interface InterruptMarkFailure {
  agentSessionId: string;
  error: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 记下已上报的 Unknown 任务（每个只上报一次）；返回写失败的 agent（Rust 只 warn 并继续）。 */
export function commitInterruptMarks(
  coordinator: SuperInboxWorkspaceCoordinator, workspaceId: string, marks: readonly InterruptMark[],
): InterruptMarkFailure[] {
  const failed: InterruptMarkFailure[] = [];
  for (const mark of marks) {
    try {
      const agent = coordinator.getAgent(workspaceId, mark.agentSessionId);
      if (agent === null) throw new Error(`Agent not found: ${mark.agentSessionId}`);
      const metadata = asRecord(agent.metadata) ?? {};
      metadata[SUPER_AGENT_META_KEY] = {
        ...(asRecord(metadata[SUPER_AGENT_META_KEY]) ?? {}),
        [WORKER_META_INTERRUPT_REPORTED]: mark.taskId,
      };
      coordinator.updateAgentMetadata(workspaceId, mark.agentSessionId, metadata);
    } catch (error) {
      failed.push({ agentSessionId: mark.agentSessionId, error: errorMessage(error) });
    }
  }
  return failed;
}

/** 把已 drain 的消息放回收件箱；返回放回失败的消息 id（按传入顺序尝试）。 */
export function rollbackDrained(
  coordinator: SuperInboxWorkspaceCoordinator, workspaceId: string, sessionId: string,
  messageIds: readonly string[],
): string[] {
  const failed: string[] = [];
  for (const messageId of messageIds) {
    try {
      coordinator.reEnqueueMessage(workspaceId, sessionId, messageId);
    } catch {
      failed.push(messageId);
    }
  }
  return failed;
}

// ============================================================================
// 投递准备（inbox.rs:670–802）
// ============================================================================

export interface PreparedDelivery {
  content: string;
  origin: Record<string, unknown>;
  /** 本次 drain 掉、且出现在正文中的消息（失败时需要放回）。 */
  drainedIds: string[];
  interruptMarks: InterruptMark[];
}

export type Prepared =
  | { status: 'paused'; autoTurns: number }
  | { status: 'empty' }
  | { status: 'ready'; delivery: PreparedDelivery };

export interface PrepareDeliveryContext {
  chatDb: SqlExecutor;
  coordinator: SuperInboxWorkspaceCoordinator;
  reportWarning: (warning: SuperInboxWarning) => void;
}

function reportRequeueFailure(
  context: Pick<PrepareDeliveryContext, 'reportWarning'>,
  workspaceId: string, sessionId: string, failed: readonly string[],
): void {
  if (failed.length === 0) return;
  context.reportWarning({
    code: 'super_inbox_requeue_failed',
    message: `Super inbox delivery aborted and ${failed.length} drained message(s) could not be re-queued.`,
    workspaceId,
    sessionId,
    messageId: failed[0] ?? null,
  });
}

/**
 * 投递准备：自动回合检查 → drain + 分类 → 格式化。
 *
 * 不改任何状态的提前返回（Paused / 仅 Progress 的 Empty）不 drain；drain 之后的 Empty
 * （全部是被吞的取消回执）会把顺带 drain 的 Progress 放回。内部出错时自行回滚已 drain 的消息。
 */
export function prepareDelivery(
  context: PrepareDeliveryContext, sessionId: string, workspaceId: string, force: boolean,
): Prepared {
  const coordinator = context.coordinator;
  const rollback = (messageIds: readonly string[]): void => {
    reportRequeueFailure(context, workspaceId, sessionId,
      rollbackDrained(coordinator, workspaceId, sessionId, messageIds));
  };

  const autoTurns = countConsecutiveInbound(context.chatDb, sessionId);
  if (autoTurns >= MAX_AUTO_TURNS && !force) return { status: 'paused', autoTurns };

  const pending = coordinator.peekInbox(workspaceId, sessionId);
  const hasActionablePending = pending.some((message) => message.messageType !== 'progress');
  const interrupts = collectUnknownInterrupts(coordinator, workspaceId);
  if (!hasActionablePending && interrupts.length === 0) return { status: 'empty' };

  const entries: Array<{ messageId: string; entry: SuperInboxEntry }> = [];
  const allDrained: string[] = [];
  if (hasActionablePending) {
    const agents = new Map<string, WorkspaceAgent | null>();
    try {
      for (let round = 0; round < MAX_DRAIN_ROUNDS; round += 1) {
        const batch = coordinator.drainInbox(workspaceId, sessionId, MAX_DRAIN);
        if (batch.length === 0) break;
        for (const message of batch) {
          allDrained.push(message.id);
          if (!agents.has(message.senderSessionId)) {
            agents.set(message.senderSessionId, coordinator.getAgent(workspaceId, message.senderSessionId));
          }
          const classified = classify(message, agents.get(message.senderSessionId) ?? null);
          if (classified.kind === 'entry') entries.push({ messageId: message.id, entry: classified.entry });
        }
        if (entries.some(({ entry }) => !isProgressEntry(entry))) break;
      }
    } catch (error) {
      rollback(allDrained);
      throw error;
    }
  }

  // 同一 Worker 的多条进度只保留最新一条
  const latestProgress = new Map<string, number>();
  entries.forEach(({ entry }, index) => {
    if (entry.kind === 'worker' && entry.event === 'progress') latestProgress.set(entry.workerId, index);
  });
  const kept = entries.filter(({ entry }, index) => entry.kind !== 'worker'
    || entry.event !== 'progress' || latestProgress.get(entry.workerId) === index);

  const hasActionable = kept.some(({ entry }) => !isProgressEntry(entry)) || interrupts.length > 0;
  if (!hasActionable) {
    // 只剩进度（可操作项全被吞）：把进度放回，等有实质事件时一起投递
    rollback(kept.map(({ messageId }) => messageId));
    return { status: 'empty' };
  }

  const drainedIds = kept.map(({ messageId }) => messageId);
  const rendered: SuperInboxEntry[] = kept.map(({ entry }) => entry);
  const interruptMarks: InterruptMark[] = [];
  for (const interrupt of interrupts) {
    interruptMarks.push(interrupt.mark);
    rendered.push(interrupt.entry);
  }
  const { content, origin } = formatSuperInboxDelivery(rendered, workspaceId, autoTurns + 1);
  return { status: 'ready', delivery: { content, origin, drainedIds, interruptMarks } };
}

// ============================================================================
// 会话校验 / 工作区绑定（handlers/mod.rs + state.rs）
// ============================================================================

/** handlers/mod.rs:29–47：子代理会话只读。 */
export function ensureSessionWritable(session: ChatSession): void {
  const metadata = asRecord(session.metadata);
  const metadataMarksSubagent = metadata?.is_subagent === true;
  if (session.mode === 'subagent' || metadataMarksSubagent) {
    throw new Error(`${VALIDATION_PREFIX}Subagent sessions are read-only; use the workspace runtime to communicate with them.`);
  }
}

/**
 * state.rs:376–415：确保 Super 会话绑定一个可用（Active）的工作区并注册为 Coordinator。
 *
 * Rust 用进程级 Mutex 串行化；本移植的整段逻辑同步执行，单线程事件循环已提供同样的互斥。
 */
export function ensureSuperWorkspace(
  chat: SuperInboxChatSession, coordinator: SuperInboxWorkspaceCoordinator, sessionId: string,
): string {
  const session = chat.getSession(sessionId);
  if (session === null) throw new Error(`Session not found: ${sessionId}`);
  const bound = metadataWorkspaceId(session.metadata);
  if (bound !== null) {
    const workspace = coordinator.getWorkspace(bound);
    if (workspace !== null && workspace.status === 'active') {
      if (coordinator.getAgent(bound, sessionId) === null) {
        coordinator.registerAgent(bound, sessionId, 'coordinator', null, null);
      }
      return bound;
    }
  }
  const created = coordinator.createWorkspace(sessionId, SUPER_WORKSPACE_NAME);
  coordinator.registerAgent(created.id, sessionId, 'coordinator', null, null);
  const metadata = asRecord(session.metadata) ?? {};
  metadata[SUPER_AGENT_META_KEY] = {
    ...(asRecord(metadata[SUPER_AGENT_META_KEY]) ?? {}),
    workspace_id: created.id,
  };
  chat.updateSession({ ...session, metadata });
  return created.id;
}

// ============================================================================
// 投递（inbox.rs:808–989）
// ============================================================================

/** inbox.rs:808–813：replay 模式下温度归零。 */
export function buildSendOptions(
  options: SuperInboxDeliverOptions, origin: Record<string, unknown>,
): SendMessageTurnOptions {
  const replayMode = options.replayMode ?? null;
  return {
    modelId: options.modelId ?? null,
    userMessageOrigin: origin,
    autoMemoryExtraction: false,
    replayMode,
    temperature: replayMode !== null ? 0 : options.temperature ?? null,
  };
}

function admitOrBlock(state: SuperInboxChatState): void {
  state.killSwitch.ensureAllowed();
}

/** `chat_v2_super_deliver_inbox` 的实现；管线在后台任务中运行，本函数只同步完成前置步骤。 */
export async function deliverInbox(
  deps: SuperInboxDeps, request: SuperInboxDeliverRequest,
): Promise<DeliverOutcome> {
  const sessionId = request.sessionId;
  if (!sessionId.startsWith('sess_')) {
    throw new Error(`${VALIDATION_PREFIX}Invalid session ID format: ${sessionId}`);
  }
  const userMessageId = request.userMessageId.trim();
  const assistantMessageId = request.assistantMessageId.trim();
  if (userMessageId === '' || assistantMessageId === '') {
    throw new Error(`${VALIDATION_PREFIX}userMessageId and assistantMessageId are required`);
  }

  // 1) 活跃 + 启用 + 可见
  if (!readEnabled(deps.settings)) return { status: 'disabled' };
  const session = deps.chat.getSession(sessionId);
  if (session === null) return { status: 'disabled' };
  if (session.persistStatus !== 'active'
    || !isActiveSuperMetadata(session.metadata)
    || metadataHidden(session.metadata)) {
    return { status: 'disabled' };
  }
  ensureSessionWritable(session);
  admitOrBlock(deps.state);
  const workspaceId = ensureSuperWorkspace(deps.chat, deps.workspace, sessionId);

  // 2) 原子注册流
  const registration = deps.state.tryRegisterStreamOwned(sessionId);
  if (registration === null) {
    if (deps.state.killSwitch.isTripped()) throw new Error(KILL_SWITCH_BLOCKED_MESSAGE);
    return { status: 'busy' };
  }
  const release = (): void => { deps.state.removeStreamIfGeneration(sessionId, registration.generation); };

  // 3) 4) 5)
  let prepared: Prepared;
  try {
    prepared = prepareDelivery(
      { chatDb: deps.chatDb, coordinator: deps.workspace, reportWarning: deps.reportWarning },
      sessionId, workspaceId, request.force,
    );
  } catch (error) {
    release();
    throw error;
  }
  if (prepared.status === 'paused') {
    release();
    return { status: 'paused', autoTurns: prepared.autoTurns };
  }
  if (prepared.status === 'empty') {
    release();
    return { status: 'empty' };
  }
  const delivery = prepared.delivery;

  // 6) 组装请求（与普通发送同一套 options，叠加内部字段）
  const sendRequest: SendMessageRequest = {
    sessionId,
    content: delivery.content,
    options: buildSendOptions(request.options, delivery.origin),
    userMessageId,
    assistantMessageId,
    userContextRefs: null,
    pathMap: null,
    workspaceId: null,
    skipUserMessageSave: null,
  };

  // 7) 启动前最后一道校验（kill switch 可能在 drain 期间触发）：失败则放回
  try {
    admitOrBlock(deps.state);
  } catch (error) {
    reportRequeueFailure(deps, workspaceId, sessionId,
      rollbackDrained(deps.workspace, workspaceId, sessionId, delivery.drainedIds));
    release();
    throw error;
  }
  const failedMarks = commitInterruptMarks(deps.workspace, workspaceId, delivery.interruptMarks);
  if (failedMarks.length > 0) {
    deps.reportWarning({
      code: 'super_inbox_interrupt_mark_failed',
      message: `Super inbox delivery could not record ${failedMarks.length} interrupted-task report(s): `
        + failedMarks.map((failure) => `${failure.agentSessionId}: ${failure.error}`).join('; '),
      workspaceId,
      sessionId,
      messageId: null,
    });
  }

  // 管线启动本身失败（同步抛错）→ 已 drain 的消息放回
  let turn: Promise<string>;
  try {
    turn = deps.pipeline.runSendMessage(request.window, sendRequest, registration);
  } catch (error) {
    reportRequeueFailure(deps, workspaceId, sessionId,
      rollbackDrained(deps.workspace, workspaceId, sessionId, delivery.drainedIds));
    release();
    throw error;
  }

  const timestampMs = Date.now();
  // goal/runtime.rs 的两个收尾钩子不返回错误；这里的失败只能告警，不能变成游离的 rejection。
  const goalHook = (hook: () => void): void => {
    try { hook(); } catch (error) {
      deps.reportWarning({
        code: 'super_inbox_goal_hook_failed',
        message: `Super inbox delivery could not settle the session goal: ${errorMessage(error)}`,
        workspaceId,
        sessionId,
        messageId: assistantMessageId,
      });
    }
  };
  // inbox.rs:940-973：投递回合结束与普通发送回合同一套 goal 收尾（取消即暂停目标）。
  deps.state.spawnTracked(turn.then(
    () => {
      release();
      goalHook(() => { deps.pipeline.spawnGoalContinuation(request.window, sessionId); });
    },
    (error: unknown) => {
      release();
      goalHook(() => {
        deps.pipeline.settleActiveGoal(request.window, sessionId,
          error instanceof ChatV2Error && error.kind === 'Cancelled' ? 'paused' : 'blocked');
      });
      deps.reportWarning({
        code: 'super_inbox_turn_failed',
        message: `Super inbox delivery turn failed: ${errorMessage(error)}`,
        workspaceId,
        sessionId,
        messageId: assistantMessageId,
      });
    },
  ));

  deps.emitInboxChanged({
    sessionId,
    workspaceId,
    pendingInbox: deps.workspace.pendingInboxCount(workspaceId, sessionId),
  });

  // 8)
  return {
    status: 'started',
    userMessage: {
      id: userMessageId,
      content: delivery.content,
      timestampMs,
      inboundOrigin: delivery.origin,
    },
    assistantMessageId,
  };
}
