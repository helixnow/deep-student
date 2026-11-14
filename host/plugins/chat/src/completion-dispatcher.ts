/**
 * G03-a completion ledger fallback + G03-d windowless wake turns.
 * Rust source: `chat_v2/completion_dispatcher.rs` (L04-owned).
 *
 * The authoritative ledger is the chat_v2 `completion_outbox` table, owned and
 * published by L05 (`agentCompletionOutbox`). Worker completion closures settle
 * their rows immediately; this dispatcher only converges leftovers.
 *
 * Process model: Rust starts one dispatcher per process (`Once`) on the first
 * `workspace_restore_executions`. The Host equivalent is one dispatcher per chat
 * plugin instance; it stops with the plugin (the Rust task lives until exit).
 */
import { dirname, join } from '../../../platform/util/path.ts';
import { chatLocalFs } from './local-fs.ts';
import type { StorageService } from '../../../platform/storage/api.ts';
import { nowEpochNanos, toRfc3339Opts } from '../../../platform/time/index.ts';
import type {
  AgentCompletionOutbox, CompletionDelivery, SubagentTaskStatus, WorkspaceCoordinator,
} from '../../agent-workspace/api.ts';
import { completionMessageExists } from '../../agent-workspace/portable.ts';
import type { ChatV2Database } from '../api.ts';
import type { ChatV2State } from './state.ts';
import { getSession } from '../repository/sessions.ts';
import { errorText, type ChatLogger } from './logger.ts';
import { ulid } from './ulid.ts';
import { Semaphore } from './semaphore.ts';

/** Frontend fast-path event (same name the worker completion closure emits). */
export const WORKSPACE_AGENT_COMPLETION_EVENT = 'workspace_agent_completion';

const TICK_INTERVAL_MS = 5_000;
const LEASE_SECS = 60;
const SELF_DELIVERY_GRACE_SECS = 15;
const CLAIM_BATCH_SIZE = 20;
const MAX_ATTEMPTS = 50;
const MAX_CONCURRENT_WAKES = 3;
const WAKE_TURN_TIMEOUT_SECS = 300;
const WAKE_SUMMARY_MAX_CHARS = 2000;
const WAKE_TURN_SYSTEM_APPEND = '本回合由后端在无窗口值守模式下触发：一条子代理完成通知已作为当前输入注入。请消化该结果、视需要推进原任务，并给出简洁的进展汇总。不要重复派发已完成的子任务。';
/** Same 4000-char budget as the worker completion closure. */
const ENVELOPE_SUMMARY_MAX_CHARS = 4000;

export interface WakeTurnRequest {
  sessionId: string;
  prompt: string;
  deliveryId: string;
  runId: string;
}
/** Production: L06 `runHeadlessAgentTurn`. Errors never roll back `delivered`. */
export type WakeRunner = (request: WakeTurnRequest) => Promise<void>;

export interface DispatcherTickStats {
  reclaimed: number; claimed: number; delivered: number; released: number; expired: number; failed: number;
}
type ProcessOutcome = 'delivered' | 'released' | 'expired';

function timestampAfterSeconds(seconds: number): string {
  return toRfc3339Opts(nowEpochNanos() + BigInt(seconds) * 1_000_000_000n, 'Millis', true);
}

/** `HeadlessWakeScheduler`: schedule returns immediately; the turn queues on the permit pool. */
export class HeadlessWakeScheduler {
  private readonly permits = new Semaphore(MAX_CONCURRENT_WAKES);
  private readonly runner: WakeRunner;
  private readonly log: ChatLogger;
  private readonly spawn: (task: Promise<void>) => boolean;
  constructor(runner: WakeRunner, log: ChatLogger, spawn: (task: Promise<void>) => boolean) { this.runner = runner; this.log = log; this.spawn = spawn; }

  /** `run_with_permit`. */
  async runWithPermit(request: WakeTurnRequest): Promise<void> {
    const release = await this.permits.acquire();
    const started = performance.now();
    try {
      await this.runner({ ...request });
      this.log.info(`[CompletionDispatcher] Headless wake turn completed: delivery=${request.deliveryId}, run=${request.runId}, session=${request.sessionId}, duration_ms=${Math.trunc(performance.now() - started)}`);
    } catch (error) {
      this.log.warn(`[CompletionDispatcher] Headless wake turn failed: delivery=${request.deliveryId}, run=${request.runId}, session=${request.sessionId}, error=${errorText(error)}（inbox 已持久化，后续 turn 兜底）`);
    } finally { release(); }
  }

  /** `schedule`: false = shutting down (N10 admission closed). */
  schedule(request: WakeTurnRequest): boolean {
    return this.spawn(this.runWithPermit(request));
  }
}

function parsePayload(payloadJson: string): unknown {
  try { return JSON.parse(payloadJson); } catch { return undefined; }
}
function stringField(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}
function hasKey(value: unknown, key: string): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && key in value;
}
/** `payload.get("final_output").or_else(|| payload.get("error")).and_then(as_str)`. */
function finalOutputOrError(value: unknown): string | undefined {
  return hasKey(value, 'final_output') ? stringField(value, 'final_output') : stringField(value, 'error');
}
function takeChars(text: string, max: number): string { return [...text].slice(0, max).join(''); }

/** `wake_prompt_from_delivery`. */
export function wakePromptFromDelivery(delivery: CompletionDelivery): string {
  const payload = parsePayload(delivery.payloadJson) ?? {};
  const status = stringField(payload, 'status') ?? 'unknown';
  const source = finalOutputOrError(payload) ?? '';
  const summary = [...source].length > WAKE_SUMMARY_MAX_CHARS
    ? `${takeChars(source, WAKE_SUMMARY_MAX_CHARS)}…（已截断）` : source;
  return [
    `[子代理完成通知] agent=${delivery.agentSessionId} status=${status}`,
    summary === '' ? '（子代理未产出文本摘要）' : `结果摘要：\n${summary}`,
    '请基于该结果继续处理原任务。若该子代理结果已在之前的回合处理过，无需重复处理。',
    '如还有其他后台子代理未完成，其结果会在完成后另行注入，不要重复派发相同任务。',
  ].join('\n\n');
}

/** `envelope_terminal_status`. */
export function envelopeTerminalStatus(delivery: CompletionDelivery): SubagentTaskStatus | null {
  const value = parsePayload(delivery.payloadJson);
  if (value === undefined) return null;
  switch (stringField(value, 'status')) {
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    default: return null;
  }
}

/** `envelope_summary`. */
export function envelopeSummary(delivery: CompletionDelivery): string | null {
  const value = parsePayload(delivery.payloadJson);
  if (value === undefined) return null;
  const raw = finalOutputOrError(value);
  return raw === undefined ? null : takeChars(raw, ENVELOPE_SUMMARY_MAX_CHARS);
}

export interface DeliveryWorkerDeps {
  outbox: AgentCompletionOutbox;
  db: ChatV2Database;
  storage: Pick<StorageService, 'openFile' | 'close'>;
  coordinator: WorkspaceCoordinator;
  state: ChatV2State;
  /** `app_data_dir/workspaces` (the chat_v2 DB's parent directory). */
  workspacesDir: string;
  owner: string;
  hasWindow: () => boolean;
  emitCompletion: (payload: unknown) => void;
  wake: HeadlessWakeScheduler;
  log: ChatLogger;
}

/** `DeliveryWorker`: single-row convergence kernel with injectable window/emit/wake seams. */
export class DeliveryWorker {
  private readonly deps: DeliveryWorkerDeps;
  constructor(deps: DeliveryWorkerDeps) { this.deps = deps; }

  /** `process_one`. */
  processOne(delivery: CompletionDelivery): ProcessOutcome {
    const { outbox, owner, log } = this.deps;
    if (delivery.attemptCount > MAX_ATTEMPTS) {
      outbox.markExpired(delivery.deliveryId, owner);
      log.warn(`[CompletionDispatcher] Expired delivery ${delivery.deliveryId} after ${delivery.attemptCount} attempts`);
      return 'expired';
    }
    if (!this.workspaceDbExists(delivery.workspaceId)) {
      outbox.markExpired(delivery.deliveryId, owner);
      log.info(`[CompletionDispatcher] Expired delivery ${delivery.deliveryId}: workspace ${delivery.workspaceId} database gone`);
      return 'expired';
    }
    if (this.targetSessionGone(delivery.targetSessionId)) {
      outbox.markExpired(delivery.deliveryId, owner);
      log.info(`[CompletionDispatcher] Expired delivery ${delivery.deliveryId}: target session ${delivery.targetSessionId} gone`);
      return 'expired';
    }
    if (this.deps.state.hasActiveStream(delivery.targetSessionId)) {
      outbox.releaseClaim(delivery.deliveryId, owner);
      return 'released';
    }
    if (!this.completionAlreadyPersisted(delivery)) this.redeliverInboxMessage(delivery);
    this.compensateTaskTerminalState(delivery);

    if (this.deps.hasWindow()) {
      let payload: unknown;
      try { payload = JSON.parse(delivery.payloadJson); }
      catch (error) { throw new Error(`corrupt payload_json for ${delivery.deliveryId}: ${errorText(error)}`); }
      try { this.deps.emitCompletion(payload); }
      catch (error) {
        try { outbox.releaseClaim(delivery.deliveryId, owner); } catch (error) { discardError(error); /* Rust `let _ =` */ }
        throw new Error(`emit ${WORKSPACE_AGENT_COMPLETION_EVENT} failed: ${errorText(error)}`);
      }
      outbox.markDelivered(delivery.deliveryId, owner);
      log.info(`[CompletionDispatcher] Delivered completion ${delivery.deliveryId} (run=${delivery.runId}, target=${delivery.targetSessionId})`);
      return 'delivered';
    }

    const won = outbox.markDelivered(delivery.deliveryId, owner);
    if (!won) {
      log.info(`[CompletionDispatcher] Delivery ${delivery.deliveryId} already settled concurrently; skipping duplicate wake`);
      return 'delivered';
    }
    if (this.targetIsActiveSuper(delivery.targetSessionId)) {
      log.info(`[CompletionDispatcher] Delivered completion ${delivery.deliveryId} (run=${delivery.runId}, target=${delivery.targetSessionId}) to Super session inbox; headless wake skipped`);
      return 'delivered';
    }
    const scheduled = this.deps.wake.schedule({
      sessionId: delivery.targetSessionId, prompt: wakePromptFromDelivery(delivery),
      deliveryId: delivery.deliveryId, runId: delivery.runId,
    });
    if (!scheduled) {
      log.warn(`[CompletionDispatcher] Wake turn spawn rejected (shutdown); delivery ${delivery.deliveryId} stays delivered with inbox fallback`);
    }
    log.info(`[CompletionDispatcher] Delivered completion ${delivery.deliveryId} (run=${delivery.runId}, target=${delivery.targetSessionId}) via headless wake turn (scheduled=${scheduled})`);
    return 'delivered';
  }

  /** Read-only dedup on the workspace DB (raw `Connection::open` + busy_timeout 5000). */
  private completionAlreadyPersisted(delivery: CompletionDelivery): boolean {
    let conn;
    try {
      conn = this.deps.storage.openFile(this.workspaceDbPath(delivery.workspaceId), {
        label: `ws_${delivery.workspaceId} dedup`, profile: { busyTimeoutMs: 5000 }, createParentDirs: false,
      });
    } catch (error) { throw new Error(`open workspace db for dedup check: ${errorText(error)}`); }
    try { return completionMessageExists(conn, delivery.workspaceId, delivery.runId); }
    finally { this.deps.storage.close(conn); }
  }

  /** `redeliver_inbox_message`: payload_json is the original send_message content. */
  private redeliverInboxMessage(delivery: CompletionDelivery): void {
    const message = this.deps.coordinator.sendMessage(delivery.workspaceId, delivery.agentSessionId,
      delivery.targetSessionId, 'result', delivery.payloadJson);
    const value = parsePayload(delivery.payloadJson);
    if (value !== undefined) {
      try {
        this.deps.coordinator.updateMessageMetadata(delivery.workspaceId, message.id,
          value as import('../../agent-workspace/api.ts').JsonValue);
      } catch (error) { discardError(error); /* Rust `let _ =` */ }
    }
  }

  /** `compensate_task_terminal_state`: only pending/running tasks; unknown is user-owned. */
  private compensateTaskTerminalState(delivery: CompletionDelivery): void {
    const taskId = delivery.taskId;
    if (taskId === null) return;
    const target = envelopeTerminalStatus(delivery);
    if (target === null) return;
    let manager;
    try { manager = this.deps.coordinator.getTaskManager(delivery.workspaceId); }
    catch (error) {
      this.deps.log.warn(`[CompletionDispatcher] No task manager for ${delivery.workspaceId}: ${errorText(error)}`);
      return;
    }
    let task;
    try { task = manager.getTask(taskId); } catch { return; }
    if (task === null || (task.status !== 'pending' && task.status !== 'running')) return;
    const summary = envelopeSummary(delivery);
    try { manager.updateStatus(taskId, target, summary); }
    catch (error) {
      this.deps.log.warn(`[CompletionDispatcher] Failed to compensate task ${taskId} to ${debugStatus(target)}: ${debugTaskError(error)}`);
    }
  }

  private workspaceDbPath(workspaceId: string): string {
    return join(this.deps.workspacesDir, `ws_${workspaceId}.db`);
  }
  private workspaceDbExists(workspaceId: string): boolean {
    return chatLocalFs().exists(this.workspaceDbPath(workspaceId));
  }

  /** Active Super session (`metadata.super_agent.active == true`); any failure → false. */
  private targetIsActiveSuper(targetSessionId: string): boolean {
    try {
      const session = getSession(this.deps.db.getConn(), targetSessionId);
      const superAgent = session?.metadata !== null && typeof session?.metadata === 'object'
        ? (session.metadata as Record<string, unknown>).super_agent : undefined;
      return superAgent !== null && typeof superAgent === 'object' && !Array.isArray(superAgent)
        && (superAgent as Record<string, unknown>).active === true;
    } catch { return false; }
  }

  /** Missing or soft-deleted parent → true; query failure → false (warn). */
  private targetSessionGone(targetSessionId: string): boolean {
    const conn = this.deps.db.getConn();
    let session;
    try { session = getSession(conn, targetSessionId); }
    catch (error) {
      this.deps.log.warn(`[CompletionDispatcher] Failed to check target session ${targetSessionId}: ${errorText(error)}`);
      return false;
    }
    return session === null || session.persistStatus === 'deleted';
  }
}

/** Rust `{:?}` of `SubagentTaskStatus`. */
function debugStatus(status: SubagentTaskStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}
/** Rust `{:?}` of `SubagentTaskError` (Database/NotFound/InvalidTransition). */
export function debugTaskError(error: unknown): string {
  if (!(error instanceof Error) || !('kind' in error)) return errorText(error);
  const value = error as Error & { kind: string; detail?: string; taskId?: string; from?: string; to?: string };
  if (value.kind === 'invalid_transition') {
    return `InvalidTransition { task_id: ${JSON.stringify(value.taskId)}, from: ${debugStatus(value.from as SubagentTaskStatus)}, to: ${debugStatus(value.to as SubagentTaskStatus)} }`;
  }
  if (value.kind === 'database') return `Database(${JSON.stringify(value.detail ?? value.message)})`;
  if (value.kind === 'not_found') return `NotFound(${JSON.stringify(value.detail ?? value.message)})`;
  return value.message;
}

/** `CompletionDispatcher`: reclaim → claim batch → converge row by row. */
export class CompletionDispatcher {
  readonly owner: string;
  private readonly outbox: AgentCompletionOutbox;
  private readonly worker: DeliveryWorker;
  private readonly log: ChatLogger;
  constructor(outbox: AgentCompletionOutbox, worker: DeliveryWorker, log: ChatLogger, owner?: string) {
    this.outbox = outbox; this.worker = worker; this.log = log;
    this.owner = owner ?? `completion-dispatcher:${(globalThis as { process?: { pid?: number } }).process?.pid ?? 'worker'}:${ulid()}`;
  }

  /** `tick`. */
  tick(): DispatcherTickStats {
    const stats: DispatcherTickStats = { reclaimed: 0, claimed: 0, delivered: 0, released: 0, expired: 0, failed: 0 };
    stats.reclaimed = this.outbox.reclaimExpiredClaims();
    const leaseExpiry = timestampAfterSeconds(LEASE_SECS);
    const notBefore = timestampAfterSeconds(-SELF_DELIVERY_GRACE_SECS);
    const claimed = this.outbox.claimPending(this.owner, leaseExpiry, notBefore, CLAIM_BATCH_SIZE);
    stats.claimed = claimed.length;
    for (const delivery of claimed) {
      try {
        const outcome = this.worker.processOne(delivery);
        if (outcome === 'delivered') stats.delivered++;
        else if (outcome === 'released') stats.released++;
        else stats.expired++;
      } catch (error) {
        stats.failed++;
        this.log.warn(`[CompletionDispatcher] Failed to process delivery ${delivery.deliveryId} (run=${delivery.runId}): ${errorText(error)}`);
        try { this.outbox.releaseClaim(delivery.deliveryId, this.owner); } catch (error) { discardError(error); /* Rust `let _ =` */ }
        stats.released++;
      }
    }
    return stats;
  }

  /** `DispatcherInfo`. */
  info(): { owner: string; tick_interval_ms: number; lease_secs: number; max_attempts: number } {
    return { owner: this.owner, tick_interval_ms: TICK_INTERVAL_MS, lease_secs: LEASE_SECS, max_attempts: MAX_ATTEMPTS };
  }
}

export interface CompletionDispatcherRuntimeDeps {
  outbox: () => AgentCompletionOutbox | undefined;
  db: ChatV2Database;
  storage: Pick<StorageService, 'openFile' | 'close'>;
  coordinator: () => WorkspaceCoordinator | undefined;
  state: ChatV2State;
  hasWindow: () => boolean;
  emit: (event: string, payload: unknown) => void;
  /** L06 `agentSubagent.runHeadlessAgentTurn`, when published. */
  headlessTurn: () => ((request: {
    sessionId: string; prompt: string; modelId?: string | null; systemPromptAppend?: string | null;
    timeoutMs: number; cancellationToken?: AbortSignal | null;
  }) => Promise<unknown>) | undefined;
  log: ChatLogger;
}

/**
 * `ensure_completion_dispatcher_started` + `spawn_completion_dispatcher`:
 * started at most once per plugin instance; `stop()` closes admission (N10).
 */
export class CompletionDispatcherRuntime {
  private started = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly pending = new Set<Promise<void>>();

  private readonly deps: CompletionDispatcherRuntimeDeps;
  constructor(deps: CompletionDispatcherRuntimeDeps) { this.deps = deps; }

  /** Returns the dispatcher when this call started it (for observation), else null. */
  ensureStarted(): CompletionDispatcher | null {
    if (this.started) return null;
    const { deps } = this;
    const outbox = deps.outbox();
    const coordinator = deps.coordinator();
    if (outbox === undefined || coordinator === undefined) {
      // Host-only: L05 services are late-bound; do not consume the once-flag.
      deps.log.warn('[Workspace::handlers] Completion dispatcher not started: agentCompletionOutbox/agentWorkspace unavailable');
      return null;
    }
    this.started = true;
    const dbPath = deps.db.dbPath();
    if (dbPath === '') {
      deps.log.warn('[Workspace::handlers] chat_v2 db has no parent dir; completion dispatcher not started');
      return null;
    }
    if (this.stopped) {
      deps.log.warn('[Workspace::handlers] Completion dispatcher rejected (shutdown in progress); pending deliveries will converge on next launch');
      return null;
    }
    const parent = dirname(dbPath);
    const owner = `completion-dispatcher:${(globalThis as { process?: { pid?: number } }).process?.pid ?? 'worker'}:${ulid()}`;
    const wake = new HeadlessWakeScheduler(async request => {
      const run = deps.headlessTurn();
      if (run === undefined) throw new Error('headless agent turn runner is not available');
      await run({ sessionId: request.sessionId, prompt: request.prompt, modelId: null,
        systemPromptAppend: WAKE_TURN_SYSTEM_APPEND, timeoutMs: WAKE_TURN_TIMEOUT_SECS * 1000, cancellationToken: null });
    }, deps.log, task => this.spawn(task));
    const worker = new DeliveryWorker({
      outbox, db: deps.db, storage: deps.storage, coordinator, state: deps.state,
      workspacesDir: join(parent, 'workspaces'), owner, hasWindow: deps.hasWindow,
      emitCompletion: payload => deps.emit(WORKSPACE_AGENT_COMPLETION_EVENT, payload), wake, log: deps.log,
    });
    const dispatcher = new CompletionDispatcher(outbox, worker, deps.log, owner);
    // `interval.tick()` fires immediately once; Rust skips it, so the first real tick is after one period.
    this.timer = setInterval(() => {
      try {
        const stats = dispatcher.tick();
        if (stats.claimed > 0 || stats.reclaimed > 0) {
          deps.log.info(`[CompletionDispatcher] tick: claimed=${stats.claimed} delivered=${stats.delivered} released=${stats.released} expired=${stats.expired} failed=${stats.failed} reclaimed=${stats.reclaimed}`);
        }
      } catch (error) {
        deps.log.warn(`[CompletionDispatcher] tick failed: ${errorText(error)}`);
      }
    }, TICK_INTERVAL_MS);
    this.timer.unref?.();
    deps.log.info('[Workspace::handlers] Completion dispatcher started (G03-a)');
    return dispatcher;
  }

  /** `background_tasks::spawn`: None once shutdown began. */
  private spawn(task: Promise<void>): boolean {
    if (this.stopped) return false;
    const tracked = this.deps.state.spawnTracked(task).finally(() => { this.pending.delete(tracked); });
    this.pending.add(tracked);
    return true;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Rust `let _ = ...` / `if let Ok(..)`: the failure is deliberately discarded. */
function discardError(error: unknown): unknown { return error; }
