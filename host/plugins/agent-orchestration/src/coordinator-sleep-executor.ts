/** sleep_executor.rs:20–529 `CoordinatorSleepExecutor` over the L05 WorkspaceCoordinator/SleepManager. */
import {
  createBlockWithConn, createMessageWithConn, getMessageWithConn, getSessionWithConn,
  type ExecutionContext, type ToolCall, type ToolResultInfo, type ToolSensitivity,
} from '../../chat/api.ts';
import { newSleepBlockData } from '../../agent-workspace/portable.ts';
import type {
  SleepManager, WakeCondition, WakeReason, WakeReceiver, WakeUpPayload, WorkspaceCoordinator,
} from '../../agent-workspace/api.ts';
import { get_string_array_arg, type JsonValue } from '../../../platform/errors/api.ts';
import { chronoRfc3339 } from '../../../platform/time/index.ts';

export const COORDINATOR_SLEEP_TOOL_NAME = 'coordinator_sleep';
export const COORDINATOR_SLEEP_EXECUTOR_NAME = 'CoordinatorSleepExecutor';
/** P0-03: default and maximum sleep timeout. */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;

type SleepCoordinator = Pick<WorkspaceCoordinator, 'listAgents' | 'getSleepManager' | 'emitCoordinatorAwakened'>;
type Log = (message: string) => void;
type AppendBlockId = (conn: Parameters<typeof getMessageWithConn>[0], messageId: string, blockId: string) => void;

const field = (args: unknown, key: string): unknown =>
  args !== null && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>)[key] : undefined;
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const debugStrings = (values: readonly string[]) => `[${values.map(value => JSON.stringify(value)).join(', ')}]`;

const WAKE_REASON_DEBUG: Readonly<Record<WakeReason, string>> = {
  message: 'Message', all_completed: 'AllCompleted', timeout: 'Timeout', manual: 'Manual', cancelled: 'Cancelled',
};
const WAKE_CONDITION_DEBUG: Readonly<Record<WakeCondition['type'], string>> = {
  any_message: 'AnyMessage', result_message: 'ResultMessage', all_completed: 'AllCompleted', timeout: 'Timeout',
};
const MESSAGE_TYPE_DEBUG: Readonly<Record<string, string>> = {
  task: 'Task', progress: 'Progress', result: 'Result', query: 'Query', correction: 'Correction', broadcast: 'Broadcast',
};

/** `{:?}` of `SleepError` (unit variants and `Variant("detail")`). */
function sleepErrorDebug(error: unknown): string {
  const record = error as { name?: unknown; kind?: unknown; message?: unknown } | null;
  if (record === null || typeof record !== 'object' || record.name !== 'SleepError') return errorText(error);
  const message = typeof record.message === 'string' ? record.message : '';
  const detail = (prefix: string) => JSON.stringify(message.startsWith(prefix) ? message.slice(prefix.length) : message);
  switch (record.kind) {
    case 'database': return `Database(${detail('Database error: ')})`;
    case 'not_found': return `NotFound(${detail('Sleep not found: ')})`;
    case 'already_awakened': return `AlreadyAwakened(${detail('Sleep already awakened: ')})`;
    case 'timeout': return 'Timeout';
    default: return 'Cancelled';
  }
}

/** sleep_executor.rs:81–87: unknown or absent values fall back to `ResultMessage`. */
function parseWakeCondition(value: unknown): WakeCondition {
  if (value === 'any_message') return { type: 'any_message' };
  if (value === 'all_completed') return { type: 'all_completed' };
  return { type: 'result_message' };
}

/** serde_json `as_i64`. */
function asI64(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

export class CoordinatorSleepExecutor {
  private readonly coordinator: SleepCoordinator;
  private readonly info: Log;
  private readonly warn: Log;
  constructor(coordinator: SleepCoordinator, log: { info: Log; warn: Log }) {
    this.coordinator = coordinator; this.info = log.info; this.warn = log.warn;
  }

  name(): string { return COORDINATOR_SLEEP_EXECUTOR_NAME; }

  canHandle(toolName: string): boolean {
    const normalized = toolName.startsWith('builtin-') ? toolName.slice('builtin-'.length)
      : toolName.startsWith('workspace_') ? toolName.slice('workspace_'.length) : toolName;
    return normalized === COORDINATOR_SLEEP_TOOL_NAME;
  }

  sensitivityLevel(_toolName: string): ToolSensitivity { return 'low'; }

  async execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResultInfo> {
    const started = performance.now();
    const elapsed = () => Math.trunc(performance.now() - started);
    const persistResult = (result: ToolResultInfo) => {
      try { ctx.saveToolBlock(result); }
      catch (cause) { this.warn(`[CoordinatorSleepExecutor] Failed to save tool block: ${errorText(cause)}`); }
      return result;
    };
    if (this.isSubagentSession(ctx)) {
      const message = 'coordinator_sleep 仅供主代理（coordinator）使用：子代理不允许睡眠等待。建议：请直接完成分配给你的任务，最终回答会自动交付主代理，无需等待其他代理的消息。';
      this.warn(`[CoordinatorSleepExecutor] Rejected coordinator_sleep from subagent session: ${ctx.session_id}`);
      ctx.emitToolCallStart(call.name, call.arguments, call.id);
      ctx.emitToolCallError(message);
      return persistResult({ toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments,
        output: null, success: false, durationMs: elapsed(), error: message });
    }
    const workspaceValue = field(call.arguments, 'workspace_id');
    const workspaceId = typeof workspaceValue === 'string' ? workspaceValue : '';
    let enriched = call.arguments;
    const fromArgs = get_string_array_arg(call.arguments as JsonValue, 'awaiting_agents') ?? [];
    if (fromArgs.length === 0 && workspaceId !== '') {
      const workers = this.workerSessions(workspaceId);
      if (workers !== null && workers.length > 0) {
        enriched = { ...(call.arguments as Record<string, unknown>), awaiting_agents: workers };
        this.info(`[CoordinatorSleepExecutor] Enriched awaiting_agents for event: ${debugStrings(workers)}`);
      }
    }
    ctx.emitToolCallStart(call.name, enriched, call.id);
    try {
      const output = await this.sleep(call.arguments, ctx);
      const durationMs = elapsed();
      ctx.emitToolCallEnd({ result: output, durationMs });
      return persistResult({ toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments,
        output, success: true, durationMs });
    } catch (cause) {
      const error = errorText(cause);
      ctx.emitToolCallError(error);
      return persistResult({ toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments,
        output: null, success: false, error, durationMs: elapsed() });
    }
  }

  /** sleep_executor.rs:44–78: a DB or lookup failure allows the sleep (sleeping has no side effects). */
  private isSubagentSession(ctx: ExecutionContext): boolean {
    if (ctx.chat_v2_db === null) return false;
    let conn;
    try { conn = ctx.chat_v2_db.getConnSafe(); }
    catch {
      this.warn('[CoordinatorSleepExecutor] DB unavailable for subagent guard, allowing sleep');
      return false;
    }
    let session;
    try { session = getSessionWithConn(conn, ctx.session_id); }
    catch (cause) {
      this.warn(`[CoordinatorSleepExecutor] Failed to query session for subagent guard (allowing sleep): ${errorText(cause)}`);
      return false;
    }
    const metadata = session?.metadata;
    return field(metadata, 'is_subagent') === true || field(metadata, 'mode') === 'subagent';
  }

  private workerSessions(workspaceId: string): string[] | null {
    try { return this.coordinator.listAgents(workspaceId).filter(agent => agent.role !== 'coordinator').map(agent => agent.sessionId); }
    catch { return null; }
  }

  /** sleep_executor.rs:159–406 `execute_sleep`. */
  private async sleep(args: unknown, ctx: ExecutionContext): Promise<Record<string, unknown>> {
    const started = performance.now();
    const workspaceId = field(args, 'workspace_id');
    if (typeof workspaceId !== 'string') throw new Error('workspace_id is required');
    let awaiting = get_string_array_arg(args as JsonValue, 'awaiting_agents') ?? [];
    if (awaiting.length === 0) {
      const workers = this.workerSessions(workspaceId);
      if (workers !== null) {
        awaiting = workers;
        this.info(`[CoordinatorSleepExecutor] Auto-populated awaiting_agents from workspace: ${debugStrings(awaiting)}`);
      }
    }
    const condition = parseWakeCondition(field(args, 'wake_condition'));
    const timeoutMs = Math.min(asI64(field(args, 'timeout_ms')) ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const data = {
      ...newSleepBlockData(workspaceId, ctx.session_id, awaiting, condition),
      timeoutAt: chronoRfc3339(BigInt(Date.now() + timeoutMs) * 1_000_000n),
      messageId: ctx.message_id, blockId: ctx.block_id,
    };
    this.info(`[CoordinatorSleepExecutor] Creating sleep: id=${data.id}, workspace=${workspaceId}, awaiting=${debugStrings(awaiting)}, condition=${WAKE_CONDITION_DEBUG[condition.type]}`);
    const manager: SleepManager = this.coordinator.getSleepManager(workspaceId);
    this.preSaveSleepBlock(ctx, args, data.id, workspaceId, awaiting);
    this.info(`[CoordinatorSleepExecutor] Starting sleep: id=${data.id}, workspace=${workspaceId}, awaiting=${debugStrings(awaiting)}`);
    let receiver;
    try { receiver = manager.beginSleep(data); }
    catch (cause) { throw new Error(`Sleep failed to start: ${sleepErrorDebug(cause)}`); }
    try {
      for (const wake of manager.checkInitialWakeConditions(data.id)) {
        this.info(`[CoordinatorSleepExecutor] Initial wake condition already satisfied: sleep=${wake.sleepId}, by=${wake.awakenedBy}, reason=${wake.wakeReason}`);
        this.coordinator.emitCoordinatorAwakened(wake);
      }
    } catch (cause) {
      this.warn(`[CoordinatorSleepExecutor] Initial wake condition check failed (sleep continues normally): sleep=${data.id}, error=${sleepErrorDebug(cause)}`);
    }
    const payload = await this.waitForWake(manager, receiver, data.id, workspaceId, ctx.cancellation_token);
    const durationMs = Math.trunc(performance.now() - started);
    this.info(`[CoordinatorSleepExecutor] Awakened: sleep=${data.id}, by=${payload.awakenedBy}, reason=${WAKE_REASON_DEBUG[payload.reason]}`);
    const now = chronoRfc3339();
    return {
      sleep_id: data.id, workspace_id: workspaceId, awaiting_agents: awaiting, status: 'awakened',
      awakened_by: payload.awakenedBy, awaken_message: payload.message?.content ?? null,
      reason: WAKE_REASON_DEBUG[payload.reason],
      message: payload.message === null ? null : { sender: payload.message.senderSessionId, content: payload.message.content,
        type: MESSAGE_TYPE_DEBUG[payload.message.messageType] ?? payload.message.messageType },
      created_at: now, awakened_at: now, duration_ms: durationMs,
    };
  }

  /** `tokio::select!` over `SleepManager::wait_for_wake` and the cancellation token. */
  private waitForWake(manager: SleepManager, receiver: WakeReceiver, sleepId: string, workspaceId: string,
    signal: AbortSignal | null): Promise<WakeUpPayload> {
    const waiting = receiver.wait().catch((cause: unknown) => {
      // A closed receiver is `SleepError::Cancelled` (sleep_manager.rs wait_for_wake).
      const debug = cause instanceof Error && cause.message === 'Cancelled' ? 'Cancelled' : sleepErrorDebug(cause);
      this.warn(`[CoordinatorSleepExecutor] Sleep error: sleep=${sleepId}, error=${debug}`);
      throw new Error(`Sleep failed: ${debug}`);
    });
    if (signal === null) return waiting;
    return new Promise<WakeUpPayload>((resolve, reject) => {
      const onAbort = () => {
        this.info(`[CoordinatorSleepExecutor] Sleep cancelled: id=${sleepId}, workspace=${workspaceId}`);
        try { manager.cancel(sleepId); }
        catch (cause) { this.warn(`[CoordinatorSleepExecutor] Failed to cancel sleep ${sleepId}: ${errorText(cause)}`); }
        reject(new Error('Coordinator sleep cancelled'));
      };
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      waiting.then(value => { signal.removeEventListener('abort', onAbort); resolve(value); },
        (cause: unknown) => { signal.removeEventListener('abort', onAbort); reject(cause); });
    });
  }

  /** sleep_executor.rs:232–302 (P16): persist the running sleep block before blocking. */
  private preSaveSleepBlock(ctx: ExecutionContext, args: unknown, sleepId: string, workspaceId: string,
    awaiting: readonly string[]): void {
    if (ctx.chat_v2_db === null) {
      this.warn('[CoordinatorSleepExecutor] No chat_v2_db available for pre-save');
      return;
    }
    let conn;
    try { conn = ctx.chat_v2_db.getConnSafe(); }
    catch { return; }
    const now = Date.now();
    try {
      createBlockWithConn(conn, { id: ctx.block_id, messageId: ctx.message_id, type: 'sleep', status: 'running',
        toolName: COORDINATOR_SLEEP_TOOL_NAME, toolInput: args,
        toolOutput: { sleep_id: sleepId, workspace_id: workspaceId, awaiting_agents: awaiting, status: 'sleeping',
          created_at: chronoRfc3339() },
        startedAt: now, firstChunkAt: now, blockIndex: 0 });
      this.info(`[CoordinatorSleepExecutor] Pre-saved sleep block before blocking: id=${ctx.block_id}`);
    } catch (cause) {
      this.warn(`[CoordinatorSleepExecutor] Failed to pre-save sleep block: ${errorText(cause)}`);
    }
    try {
      const message = getMessageWithConn(conn, ctx.message_id);
      if (message !== null) {
        (ctx.services.chatSession.appendBlockIdToMessageWithConn as AppendBlockId)(conn, ctx.message_id, ctx.block_id);
      } else {
        createMessageWithConn(conn, { id: ctx.message_id, sessionId: ctx.session_id, role: 'assistant',
          blockIds: [ctx.block_id], timestamp: now });
        this.info(`[CoordinatorSleepExecutor] Created message with sleep block: msg=${ctx.message_id}, block=${ctx.block_id}`);
      }
      this.info(`[CoordinatorSleepExecutor] Appended sleep block to message: msg=${ctx.message_id}, block=${ctx.block_id}`);
    } catch (cause) {
      this.warn(`[CoordinatorSleepExecutor] Failed to append block_id to message: ${errorText(cause)}`);
    }
  }
}
