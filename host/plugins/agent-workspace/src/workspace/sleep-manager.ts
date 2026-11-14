// workspace/sleep_manager.rs —— 主代理睡眠/唤醒（持久化 + 重启恢复）。
//
// Rust 用 oneshot + tokio timer；Node 侧用单次 wake 通道 + setTimeout。语义不变：
// begin_sleep 注册 → 可选的初始唤醒条件检查 → wait_for_wake；超时任务在唤醒/取消时中止。
import type {
  AgentStatus, MessageType, SleepBlockData, SleepStatus, WakeCondition, WorkspaceMessage,
} from '../../api.ts';
import type { SqlExecutor } from '../../../../platform/storage/api.ts';
import * as sleepSql from '../../repository/sleep-repository.ts';
import type { SleepRow } from '../../repository/sleep-repository.ts';
import { chronoRfc3339, toRfc3339 as nowRfc3339, toRfc3339, parseRfc3339 } from '../../../../platform/time/index.ts';
import { ulid, EPOCH_RFC3339 } from './util.ts';
import { WorkspaceRepo } from './repo.ts';

export type WakeReason = 'message' | 'all_completed' | 'timeout' | 'manual' | 'cancelled';

export interface WakeUpPayload {
  sleepId: string;
  awakenedBy: string;
  message: WorkspaceMessage | null;
  reason: WakeReason;
}

export interface WakeResultInfo {
  sleepId: string;
  workspaceId: string;
  coordinatorSessionId: string;
  awakenedBy: string;
  awakenMessage: string | null;
  wakeReason: string;
}

export type SleepErrorKind = 'database' | 'not_found' | 'already_awakened' | 'timeout' | 'cancelled';

export class SleepError extends Error {
  readonly kind: SleepErrorKind;

  constructor(kind: SleepErrorKind, detail: string) {
    const text = kind === 'database' ? `Database error: ${detail}`
      : kind === 'not_found' ? `Sleep not found: ${detail}`
        : kind === 'already_awakened' ? `Sleep already awakened: ${detail}`
          : kind === 'timeout' ? 'Timeout'
            : 'Cancelled';
    super(text);
    this.kind = kind;
    this.name = 'SleepError';
  }
}

/** oneshot receiver 的等价物：tryRecv 同步读取，wait 在唤醒前挂起。 */
export class WakeReceiver {
  private payload: WakeUpPayload | null = null;
  private closed = false;
  private resolveWait: ((payload: WakeUpPayload) => void) | null = null;
  private rejectWait: ((error: Error) => void) | null = null;

  send(payload: WakeUpPayload): void {
    if (this.closed || this.payload !== null) return;
    this.payload = payload;
    this.closed = true;
    const resolve = this.resolveWait;
    this.resolveWait = null;
    this.rejectWait = null;
    resolve?.(payload);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const reject = this.rejectWait;
    this.resolveWait = null;
    this.rejectWait = null;
    reject?.(new Error('Cancelled'));
  }

  /** Rust `oneshot::Receiver::try_recv()`：未被唤醒时返回 null。 */
  tryRecv(): WakeUpPayload | null {
    return this.payload;
  }

  wait(): Promise<WakeUpPayload> {
    if (this.payload !== null) return Promise.resolve(this.payload);
    if (this.closed) return Promise.reject(new Error('Cancelled'));
    return new Promise<WakeUpPayload>((resolve, reject) => {
      this.resolveWait = resolve;
      this.rejectWait = reject;
    });
  }
}

interface TimeoutTask {
  cancel(): void;
}

interface ActiveSleep {
  receiver: WakeReceiver;
}

const SLEEP_STATUSES: readonly SleepStatus[] = ['sleeping', 'awakened', 'timeout', 'cancelled'];

export function newSleepBlockData(
  workspaceId: string,
  coordinatorSessionId: string,
  awaitingAgents: string[],
  wakeCondition: WakeCondition,
): SleepBlockData {
  return {
    id: `sleep_${ulid()}`,
    workspaceId,
    coordinatorSessionId,
    awaitingAgents,
    wakeCondition,
    status: 'sleeping',
    timeoutAt: null,
    createdAt: nowRfc3339(),
    awakenedAt: null,
    awakenedBy: null,
    awakenMessage: null,
    messageId: null,
    blockId: null,
  };
}

export function withTimeout(data: SleepBlockData, timeoutMs: number): SleepBlockData {
  const base = Date.parse(data.createdAt);
  const anchor = Number.isNaN(base) ? Date.now() : base;
  return { ...data, timeoutAt: chronoRfc3339(BigInt(Math.trunc(anchor + timeoutMs)) * 1_000_000n) };
}

export function withMessageId(data: SleepBlockData, messageId: string): SleepBlockData {
  return { ...data, messageId };
}

export function withBlockId(data: SleepBlockData, blockId: string): SleepBlockData {
  return { ...data, blockId };
}

export function wakeConditionJson(condition: WakeCondition): string {
  switch (condition.type) {
    case 'timeout': return JSON.stringify({ type: 'timeout', ms: condition.ms });
    default: return JSON.stringify({ type: condition.type });
  }
}

function parseWakeCondition(raw: string): WakeCondition {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const type = (parsed as Record<string, unknown>)['type'];
      if (type === 'any_message' || type === 'result_message' || type === 'all_completed') {
        return { type };
      }
      if (type === 'timeout') {
        const ms = (parsed as Record<string, unknown>)['ms'];
        if (typeof ms === 'number' && Number.isInteger(ms) && ms >= 0) return { type: 'timeout', ms };
      }
    }
  } catch (error) { // boundary-allow empty-catch: 无效 wake_condition JSON 回退 result_message（Rust serde 解析失败回退）
    void error;
  }
  return { type: 'result_message' };
}

function parseSleepStatus(raw: string): SleepStatus {
  return (SLEEP_STATUSES as readonly string[]).includes(raw) ? raw as SleepStatus : 'sleeping';
}

function parseAwaitingAgents(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string');
  } catch (error) { // boundary-allow empty-catch: 无效 awaiting_agents JSON 回退空列表（Rust serde 解析失败回退）
    void error;
  }
  return [];
}

function sleepFromRow(
  row: SleepRow,
  warn: (message: string) => void = () => undefined,
  context = 'get_sleep',
): SleepBlockData {
  const timeout = row.timeout_at === null ? null : parseRfc3339(row.timeout_at);
  const awakened = row.awakened_at === null ? null : parseRfc3339(row.awakened_at);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    coordinatorSessionId: row.coordinator_session_id,
    awaitingAgents: parseAwaitingAgents(row.awaiting_agents),
    wakeCondition: parseWakeCondition(row.wake_condition),
    status: parseSleepStatus(row.status),
    timeoutAt: timeout === null ? null : toRfc3339(timeout.epochNanos),
    createdAt: timestampOrEpoch(row.created_at, warn, context),
    awakenedAt: awakened === null ? null : toRfc3339(awakened.epochNanos),
    awakenedBy: row.awakened_by,
    awakenMessage: row.awaken_message,
    messageId: row.message_id,
    blockId: row.block_id,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timestampOrEpoch(
  value: string,
  warn: (message: string) => void,
  context: string,
): string {
  const parsed = parseRfc3339(value);
  if (parsed !== null) return toRfc3339(parsed.epochNanos);
  warn(`[SleepManager] Failed to parse created_at in ${context} '${value}': invalid RFC3339`);
  return EPOCH_RFC3339;
}

const TERMINAL_AGENT_STATUSES: ReadonlySet<AgentStatus> = new Set(['completed', 'failed', 'cancelled', 'closed']);

export class SleepManager {
  private readonly activeSleeps = new Map<string, ActiveSleep>();
  private readonly timeoutHandles = new Map<string, TimeoutTask>();
  private readonly pendingTimeoutTasks = new Set<Promise<void>>();

  private readonly db: SqlExecutor;
  private readonly warn: (message: string) => void;
  private readonly info: (message: string) => void;

  constructor(
    db: SqlExecutor,
    warn: (message: string) => void = () => undefined,
    info: (message: string) => void = () => undefined,
  ) {
    this.db = db;
    this.warn = warn;
    this.info = info;
  }

  private saveSleep(data: SleepBlockData): void {
    try {
      sleepSql.saveSleep(this.db, {
        id: data.id,
        workspaceId: data.workspaceId,
        coordinatorSessionId: data.coordinatorSessionId,
        awaitingAgentsJson: JSON.stringify(data.awaitingAgents),
        wakeConditionJson: wakeConditionJson(data.wakeCondition),
        status: data.status,
        timeoutAt: data.timeoutAt,
        createdAt: data.createdAt,
        messageId: data.messageId,
        blockId: data.blockId,
      });
    } catch (error) {
      throw new SleepError('database', errorMessage(error));
    }
  }

  getSleep(sleepId: string): SleepBlockData | null {
    let row: SleepRow | undefined;
    try {
      row = sleepSql.getSleep(this.db, sleepId);
    } catch (error) {
      throw new SleepError('database', errorMessage(error));
    }
    return row === undefined ? null : sleepFromRow(row, this.warn);
  }

  private updateSleepStatus(
    sleepId: string,
    status: SleepStatus,
    awakenedBy: string | null,
    awakenMessage: string | null,
  ): void {
    try {
      sleepSql.updateSleepStatus(this.db, sleepId, status, nowRfc3339(), awakenedBy, awakenMessage);
    } catch (error) {
      throw new SleepError('database', errorMessage(error));
    }
  }

  /** 开始睡眠（同步阶段）：持久化、注册、启动超时任务。 */
  beginSleep(data: SleepBlockData): WakeReceiver {
    this.saveSleep(data);
    const receiver = new WakeReceiver();
    this.activeSleeps.set(data.id, { receiver });
    this.info(`[SleepManager] Sleep started: ${data.id}`);
    if (data.timeoutAt !== null) this.spawnTimeoutTask(data.id, data.timeoutAt);
    return receiver;
  }

  async sleep(data: SleepBlockData): Promise<WakeUpPayload> {
    const receiver = this.beginSleep(data);
    return SleepManager.waitForWake(receiver, data.id);
  }

  static async waitForWake(receiver: WakeReceiver, sleepId: string): Promise<WakeUpPayload> {
    try {
      return await receiver.wait();
    } catch (error) {
      if (error instanceof Error && error.message === 'Cancelled') {
        throw new SleepError('cancelled', sleepId);
      }
      throw error;
    }
  }

  private spawnTimeoutTask(sleepId: string, timeoutAt: string): void {
    const target = Date.parse(timeoutAt);
    const delay = Number.isNaN(target) ? 0 : Math.max(0, target - Date.now());
    let settle: () => void = () => {};
    const task = new Promise<void>(resolve => {
      let done = false;
      settle = () => {
        if (done) return;
        done = true;
        resolve();
      };
      const timer = setTimeout(() => {
        this.timeoutHandles.delete(sleepId);
        const active = this.activeSleeps.get(sleepId);
        this.activeSleeps.delete(sleepId);
        if (active) {
          this.info(`[SleepManager] Sleep timeout: ${sleepId}`);
          active.receiver.send({
            sleepId,
            awakenedBy: 'system',
            message: null,
            reason: 'timeout',
          });
          try {
            this.updateSleepStatus(sleepId, 'timeout', null, null);
          } catch (error) {
            this.warn(`[SleepManager] Failed to update timeout status: ${errorMessage(error)}`);
          }
        }
        settle();
      }, delay);
      this.timeoutHandles.set(sleepId, {
        cancel: () => {
          clearTimeout(timer);
          settle();
        },
      });
    });
    this.pendingTimeoutTasks.add(task);
    void task.then(() => { this.pendingTimeoutTasks.delete(task); });
  }

  private abortTimeoutTask(sleepId: string): void {
    const handle = this.timeoutHandles.get(sleepId);
    if (!handle) return;
    this.timeoutHandles.delete(sleepId);
    handle.cancel();
  }

  /** 尝试唤醒指定睡眠（返回是否有注册中的等待方）。 */
  tryWake(sleepId: string, payload: WakeUpPayload): boolean {
    const active = this.activeSleeps.get(sleepId);
    if (!active) return false;
    this.activeSleeps.delete(sleepId);
    this.updateSleepStatus(
      sleepId,
      'awakened',
      payload.awakenedBy,
      payload.message === null ? null : payload.message.content,
    );
    active.receiver.send(payload);
    this.abortTimeoutTask(sleepId);
    return true;
  }

  checkAndWakeByMessage(message: WorkspaceMessage): WakeResultInfo[] {
    const awakened: WakeResultInfo[] = [];
    for (const sleepId of [...this.activeSleeps.keys()]) {
      const sleepData = this.getSleepSafely(sleepId);
      if (!sleepData) continue;
      if (!this.isMessageRelevantToSleep(message, sleepData)) continue;

      let shouldWake = false;
      switch (sleepData.wakeCondition.type) {
        case 'any_message':
          shouldWake = true;
          break;
        case 'result_message':
          shouldWake = message.messageType === 'result';
          break;
        case 'all_completed':
          shouldWake = message.messageType === 'result'
            && this.checkAllAgentsCompleted(sleepData, message.senderSessionId);
          break;
        case 'timeout':
          shouldWake = false;
          break;
      }

      if (!shouldWake) continue;
      const payload: WakeUpPayload = {
        sleepId,
        awakenedBy: message.senderSessionId,
        message,
        reason: 'message',
      };
      if (this.tryWakeSafely(sleepId, payload)) {
        awakened.push({
          sleepId,
          workspaceId: sleepData.workspaceId,
          coordinatorSessionId: sleepData.coordinatorSessionId,
          awakenedBy: message.senderSessionId,
          awakenMessage: message.content,
          wakeReason: 'message',
        });
      }
    }
    return awakened;
  }

  /** worker 进入终态时以"全员终态"兜底唤醒 coordinator。 */
  checkAndWakeByAgentStatus(
    workspaceId: string,
    agentSessionId: string,
    status: AgentStatus,
  ): WakeResultInfo[] {
    if (!TERMINAL_AGENT_STATUSES.has(status)) return [];
    const awakened: WakeResultInfo[] = [];
    for (const sleepId of [...this.activeSleeps.keys()]) {
      const sleepData = this.getSleepSafely(sleepId);
      if (!sleepData) continue;
      if (sleepData.workspaceId !== workspaceId) continue;
      if (!this.isAgentRelevantToSleep(agentSessionId, sleepData)) continue;

      let shouldWake = false;
      switch (sleepData.wakeCondition.type) {
        case 'all_completed':
        case 'result_message':
          shouldWake = this.checkAllAgentsTerminal(sleepData);
          break;
        case 'any_message':
        case 'timeout':
          shouldWake = false;
          break;
      }
      if (!shouldWake) continue;

      const payload: WakeUpPayload = {
        sleepId,
        awakenedBy: agentSessionId,
        message: null,
        reason: 'all_completed',
      };
      if (this.tryWakeSafely(sleepId, payload)) {
        awakened.push({
          sleepId,
          workspaceId: sleepData.workspaceId,
          coordinatorSessionId: sleepData.coordinatorSessionId,
          awakenedBy: agentSessionId,
          awakenMessage: null,
          wakeReason: 'all_completed',
        });
      }
    }
    return awakened;
  }

  private getSleepSafely(sleepId: string): SleepBlockData | null {
    try {
      return this.getSleep(sleepId);
    } catch (error) {
      this.warn(`[SleepManager] Failed to read sleep ${sleepId}: ${errorMessage(error)}`);
      return null;
    }
  }

  private tryWakeSafely(sleepId: string, payload: WakeUpPayload): boolean {
    try {
      return this.tryWake(sleepId, payload);
    } catch (error) {
      this.warn(`[SleepManager] Failed to wake sleep ${sleepId}: ${errorMessage(error)}`);
      return false;
    }
  }

  /** 睡眠注册后的初始唤醒条件检查（修复"结果先到、睡眠后建"的竞态）。 */
  checkInitialWakeConditions(sleepId: string): WakeResultInfo[] {
    if (!this.isSleepActive(sleepId)) return [];
    const sleepData = this.getSleep(sleepId);
    if (!sleepData) return [];
    if (sleepData.status !== 'sleeping') return [];

    const awakened: WakeResultInfo[] = [];

    // 条件 1：inbox 中已有满足唤醒条件的未读消息（优先于终态检查）。
    const pending = this.findPendingWakeMessage(sleepData);
    if (pending !== null) {
      const payload: WakeUpPayload = {
        sleepId,
        awakenedBy: pending.senderSessionId,
        message: pending,
        reason: 'message',
      };
      if (this.tryWake(sleepId, payload)) {
        awakened.push({
          sleepId,
          workspaceId: sleepData.workspaceId,
          coordinatorSessionId: sleepData.coordinatorSessionId,
          awakenedBy: pending.senderSessionId,
          awakenMessage: pending.content,
          wakeReason: 'message',
        });
        return awakened;
      }
    }

    // 条件 2：所有被等待的 agent 已全部终态。
    let allTerminal = false;
    switch (sleepData.wakeCondition.type) {
      case 'all_completed':
      case 'result_message':
        allTerminal = this.checkAllAgentsTerminal(sleepData);
        break;
      case 'any_message':
      case 'timeout':
        allTerminal = false;
        break;
    }
    if (allTerminal) {
      const payload: WakeUpPayload = {
        sleepId,
        awakenedBy: 'system',
        message: null,
        reason: 'all_completed',
      };
      if (this.tryWake(sleepId, payload)) {
        awakened.push({
          sleepId,
          workspaceId: sleepData.workspaceId,
          coordinatorSessionId: sleepData.coordinatorSessionId,
          awakenedBy: 'system',
          awakenMessage: null,
          wakeReason: 'all_completed',
        });
      }
    }
    return awakened;
  }

  /** 在 coordinator 的未读 inbox 中查找第一条满足唤醒条件的消息。 */
  private findPendingWakeMessage(sleepData: SleepBlockData): WorkspaceMessage | null {
    const repo = new WorkspaceRepo(this.db, { warn: message => this.warn(message), info: () => undefined });
    let messages: WorkspaceMessage[];
    try {
      messages = repo.getUnreadInboxMessages(sleepData.coordinatorSessionId);
    } catch (error) {
      throw new SleepError('database', errorMessage(error));
    }
    for (const message of messages) {
      if (!this.isMessageRelevantToSleep(message, sleepData)) continue;
      let shouldWake = false;
      switch (sleepData.wakeCondition.type) {
        case 'any_message':
          shouldWake = true;
          break;
        case 'result_message':
          shouldWake = message.messageType === 'result';
          break;
        case 'all_completed':
          shouldWake = message.messageType === 'result'
            && this.checkAllAgentsCompleted(sleepData, message.senderSessionId);
          break;
        case 'timeout':
          shouldWake = false;
          break;
      }
      if (shouldWake) return message;
    }
    return null;
  }

  /** 消息是否与睡眠相关（直发 / 广播+等待集 / 发送者在等待集）。 */
  isMessageRelevantToSleep(message: WorkspaceMessage, sleepData: SleepBlockData): boolean {
    if (message.targetSessionId !== null && message.targetSessionId === sleepData.coordinatorSessionId) {
      return true;
    }
    if (message.targetSessionId === null) {
      if (sleepData.awaitingAgents.length === 0) return true;
      if (sleepData.awaitingAgents.includes(message.senderSessionId)) return true;
    }
    return sleepData.awaitingAgents.includes(message.senderSessionId);
  }

  isAgentRelevantToSleep(agentSessionId: string, sleepData: SleepBlockData): boolean {
    if (sleepData.awaitingAgents.length === 0) return true;
    return sleepData.awaitingAgents.includes(agentSessionId);
  }

  checkAllAgentsTerminal(sleepData: SleepBlockData): boolean {
    if (sleepData.awaitingAgents.length === 0) return true;
    let rows: Array<{ session_id: string; status: string }>;
    try {
      rows = sleepSql.agentStatuses(this.db, sleepData.workspaceId);
    } catch {
      return false;
    }
    const statuses = new Map(rows.map(row => [row.session_id, row.status]));
    for (const agent of sleepData.awaitingAgents) {
      const status = statuses.get(agent);
      if (status === undefined || !TERMINAL_AGENT_STATUSES.has(status as AgentStatus)) return false;
    }
    return true;
  }

  private checkAllAgentsCompleted(sleepData: SleepBlockData, completedAgent: string): boolean {
    if (sleepData.awaitingAgents.length === 0) return true;
    const completed = new Set(this.getCompletedAgentsForSleep(sleepData.id));
    completed.add(completedAgent);
    return sleepData.awaitingAgents.every(agent => completed.has(agent));
  }

  private getCompletedAgentsForSleep(sleepId: string): string[] {
    const sleepData = this.getSleepSafely(sleepId);
    if (!sleepData) return [];
    try {
      return sleepSql.completedAgentsSince(this.db, sleepData.workspaceId, sleepData.createdAt);
    } catch (error) {
      this.warn(`[SleepManager] Failed to query completed agents: ${errorMessage(error)}`);
      return [];
    }
  }

  /** 手动唤醒（用户点击唤醒按钮）。 */
  manualWake(sleepId: string, userMessage: string | null): WakeResultInfo | null {
    const sleepData = this.getSleep(sleepId);
    const payload: WakeUpPayload = {
      sleepId,
      awakenedBy: 'user',
      message: null,
      reason: 'manual',
    };
    const success = this.tryWake(sleepId, payload);
    if (!success || sleepData === null) return null;
    return {
      sleepId,
      workspaceId: sleepData.workspaceId,
      coordinatorSessionId: sleepData.coordinatorSessionId,
      awakenedBy: 'user',
      awakenMessage: userMessage,
      wakeReason: 'manual',
    };
  }

  cancel(sleepId: string): boolean {
    const active = this.activeSleeps.get(sleepId);
    if (!active) return false;
    this.activeSleeps.delete(sleepId);
    this.updateSleepStatus(sleepId, 'cancelled', null, null);
    active.receiver.send({
      sleepId,
      awakenedBy: 'system',
      message: null,
      reason: 'cancelled',
    });
    this.abortTimeoutTask(sleepId);
    return true;
  }

  /**
   * 取消所有活跃睡眠（幂等）：取消式唤醒 → DB 收敛 cancelled → 中止全部超时任务。
   * 返回被取消的睡眠数量。
   */
  cancelAllActive(reason: string): number {
    const drained = [...this.activeSleeps.entries()];
    this.activeSleeps.clear();
    if (drained.length === 0) return 0;

    for (const [sleepId, active] of drained) {
      try {
        this.updateSleepStatus(sleepId, 'cancelled', 'system', reason);
      } catch (error) {
        this.warn(`[SleepManager] Failed to persist cancelled status for ${sleepId}: ${errorMessage(error)}`);
      }
      active.receiver.send({
        sleepId,
        awakenedBy: 'system',
        message: null,
        reason: 'cancelled',
      });
      this.abortTimeoutTask(sleepId);
    }

    // 兜底：清掉可能残留的孤儿超时任务。
    for (const [sleepId, handle] of [...this.timeoutHandles.entries()]) {
      this.timeoutHandles.delete(sleepId);
      handle.cancel();
    }
    return drained.length;
  }

  /**
   * Plugin unload: stop every timeout timer and leave the rows `sleeping`. Rust never mounts `shutdown_all_sleeps`,
   * so its process exit keeps the rows for the next start to restore; a timer firing later would write to a closed database.
   */
  stopTimeoutTasks(): void {
    for (const [sleepId, handle] of [...this.timeoutHandles.entries()]) {
      this.timeoutHandles.delete(sleepId);
      handle.cancel();
    }
  }

  /** 恢复持久化的睡眠（仅读取数据）。 */
  restoreSleeps(): SleepBlockData[] {
    let rows: SleepRow[];
    try {
      rows = sleepSql.listSleeping(this.db);
    } catch (error) {
      throw new SleepError('database', errorMessage(error));
    }
    this.info(`[SleepManager] Restored ${rows.length} sleeping blocks`);
    return rows.map(row => sleepFromRow(row, this.warn, 'restore_sleeps'));
  }

  /** 恢复持久化的睡眠并重新注册（幂等：已激活的跳过）。 */
  restoreAndActivateSleeps(): Array<{ sleepId: string; receiver: WakeReceiver }> {
    const sleeps = this.restoreSleeps();
    const receivers: Array<{ sleepId: string; receiver: WakeReceiver }> = [];
    for (const sleepData of sleeps) {
      const sleepId = sleepData.id;
      if (this.activeSleeps.has(sleepId)) continue;
      const receiver = new WakeReceiver();
      this.activeSleeps.set(sleepId, { receiver });
      if (sleepData.timeoutAt !== null) this.spawnTimeoutTask(sleepId, sleepData.timeoutAt);
      receivers.push({ sleepId, receiver });
    }
    return receivers;
  }

  isSleepActive(sleepId: string): boolean {
    return this.activeSleeps.has(sleepId);
  }

  getActiveSleepIds(): string[] {
    return [...this.activeSleeps.keys()];
  }

  /** 当前挂着的超时任务 id（Rust 测试直接读取 `timeout_handles`）。 */
  timeoutTaskIds(): string[] {
    return [...this.timeoutHandles.keys()];
  }

  /** 关闭任务追踪器并等待全部超时任务完成；超时返回 false。 */
  async shutdown(timeoutMs: number): Promise<boolean> {
    const tasks = [...this.pendingTimeoutTasks];
    if (tasks.length === 0) {
      this.info('[SleepManager] All timeout tasks completed');
      return true;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const completed = Promise.all(tasks).then(() => true);
    const result = await Promise.race([completed, timedOut]);
    if (timer !== null) clearTimeout(timer);
    if (!result) {
      this.warn('[SleepManager] Timeout waiting for tasks to complete');
    } else {
      this.info('[SleepManager] All timeout tasks completed');
    }
    return result;
  }
}

/** 与 Rust `WakeCondition` 的 serde 名称一致（用于测试与调试展示）。 */
export function wakeConditionTypeName(condition: WakeCondition): string {
  return condition.type;
}

/** 与 Rust `MessageType` 的 serde 名称一致。 */
export function messageTypeName(type: MessageType): string {
  return type;
}
