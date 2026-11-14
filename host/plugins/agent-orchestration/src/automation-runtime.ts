/**
 * automations.rs:7–100、2635–2900、3343–3560、3641–3710、4820–5000、5398–5635 —
 * 调度器状态机、每轮 tick、到期/重试派发与手动运行（run_now）。
 *
 * 跨 lane 的副作用（OS 通知、VFS 待办、headless agent turn）不在本文件实现：
 * 它们由 {@link AutomationDispatchPort} 注入，索引层用已发布的服务装配；
 * 服务缺失时由装配层显式记录/报错，不做静默降级。
 */
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { errorMessage } from './automation-errors.ts';
import {
  ActiveAutomationRunGuard, AgentAutomationRunGuard, cancelAllAutomationRunTokens,
} from './automation-run-guard.ts';
import {
  type AutomationDefinition, type ClaimedAutomationRun, type RunFinalizeOutcome,
  automationRunIsRunning, automationVersionConflictError,
  claimRetryRun, claimScheduledRun, completeRun, createManualRun, dueRetryIds, effectiveAgentPrompt,
  finalizeOnceAutomation, initializeNextRun, loadAutomations, loadRunDeliveries,
  recoverStaleAutomationRuns, repairSkewedNextRun, retryOrFinishRun, updateAutomationAgentSessionId,
} from '../repository/automations.ts';
import { parseTimestampMillis } from './automation-schedule.ts';
import {
  heartbeatIsSilent, notificationFailedFallbackBody, notificationSuccessBody,
  notificationTitleFailed, notificationTitleSuccess, notificationTitleRunning,
  truncateForNotification, truncatePromptForNotification, type NotificationLang,
} from './automation-notifications.ts';
import type { HeadlessTurnRequest, HeadlessTurnResult } from '../api.ts';

export const SCHEDULER_POLL_SECS = 15;
/** catch_up_all 单 tick 单任务最多补跑的错过槽位数。 */
export const CATCH_UP_BATCH = 5;

export interface AutomationLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

// ------------------------------------------------------------------ 调度器状态

/**
 * 调度器的暂停与退出标记（Rust 里是进程级静态量）。这里每个插件实例一份：重装后的调度器从未暂停、
 * 未退出开始；旧实例的在途运行仍按旧实例的退出标记收尾。
 */
export class AutomationSchedulerState {
  private paused = false;
  private exiting = false;

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  isPaused(): boolean { return this.paused; }

  /** `mark_automation_app_exiting`：此后不再派发；在途运行以 shutdown 取消，留给下次启动恢复。 */
  markAppExiting(): void {
    this.exiting = true;
    cancelActiveAutomationRuns('shutdown');
  }

  isExiting(): boolean { return this.exiting; }

  /** tick / run_now 是否允许派发（暂停或退出时禁止）。 */
  dispatchAllowed(): boolean { return !this.paused && !this.exiting; }
}

/** 取消全部在跑的自动化 token（Kill Switch emergency_stop）。 */
export function cancelActiveAutomationRunsForEmergencyStop(): number {
  return cancelActiveAutomationRuns('emergency_stop');
}

function cancelActiveAutomationRuns(reason: string): number {
  const count = cancelAllAutomationRunTokens();
  if (count > 0) automationLog?.warn(`[AutomationScheduler] cancelled ${count} active automation run token(s) (${reason})`);
  return count;
}

let automationLog: AutomationLog | null = null;

/** 供紧急停止等无 ctx 路径记录日志；由插件装配时注入。 */
export function setAutomationRuntimeLogger(log: AutomationLog | null): void {
  automationLog = log;
}

// ------------------------------------------------------------------ 派发端口

export interface RunNotificationRequest {
  runId: string;
  attempt: number;
  status: string;
  title: string;
  body: string;
  suppressIfWindowActive: boolean;
}

export interface RunNotificationOutcome {
  handled: boolean;
  deliveredOs: boolean;
}

/** automations.rs:4100–4124 的 `chat_v2_automation_run_completed` 载荷。 */
export interface AutomationRunCompletedPayload {
  automationId: string;
  automationName: string;
  sessionId: string | null;
  runId: string;
  attempt: number;
  status: string;
  summary: string;
  heartbeat: boolean;
  osNotificationDelivered: boolean;
}

export interface AutomationDispatchPort {
  /**
   * Kill Switch 准入：未通过时抛出 CommandError（文案与 L04
   * `admit_or_block_from_app` 一致），确保 IPC 正常 settle。
   */
  ensureKillSwitchAllowed(): void;
  /** 发出 `chat_v2://automations_changed`。 */
  emitChanged(action: string, automationId: string): void;
  notificationLanguage(): NotificationLang;
  /**
   * 拉起一轮 headless turn。取消应通过 resolve 的 status='cancelled' 表达；
   * 抛错只表示基础设施级失败（Rust `ChatV2Error::Cancelled` 也按 cancelled 处理）。
   */
  runHeadlessTurn(request: HeadlessTurnRequest): Promise<HeadlessTurnResult>;
  /**
   * 派发 notify：投递 OS 通知 + 创建待办，并写入 `notification` / `todo`
   * 投递回执（automations.rs:3086–3219、2508–2612）。返回实际成功投递的渠道。
   */
  deliverNotify(claimed: ClaimedAutomationRun, nowMs: number): Promise<{ delivered: string[] }>;
  /** 投递一条 run 相关通知（at-most-once + 策略/窗口抑制）。 */
  sendRunNotification(request: RunNotificationRequest): Promise<RunNotificationOutcome>;
  /** 补投历史遗留的 `notification_pending` 回执（automations.rs:5296–5380）。 */
  deliverPendingNotifications(): Promise<number>;
  emitRunCompleted(payload: AutomationRunCompletedPayload): void;
  /** 心跳空转纯 DB 预检；失败按“有待办”处理（fail-open）。 */
  heartbeatIdlePrecheck?(automation: AutomationDefinition): boolean | Promise<boolean>;
}

export interface AutomationRuntimeDeps {
  db: DatabaseHandle;
  dispatch: AutomationDispatchPort;
  log: AutomationLog;
  now(): number;
  scheduler: AutomationSchedulerState;
}

function onceFinalizeHooks(deps: AutomationRuntimeDeps) {
  return {
    info: (message: string) => deps.log.info(message),
    warn: (message: string) => deps.log.warn(message),
    emitChanged: (action: string, automationId: string) => deps.dispatch.emitChanged(action, automationId),
  };
}

function finalizeOnce(deps: AutomationRuntimeDeps, automation: AutomationDefinition): void {
  finalizeOnceAutomation(deps.db, automation, onceFinalizeHooks(deps));
}

// ------------------------------------------------------------------ 每轮 tick

/** automations.rs:5448–5560。 */
export async function tickAutomations(deps: AutomationRuntimeDeps): Promise<void> {
  if (!deps.scheduler.dispatchAllowed()) return;
  // 错误隔离：孤儿恢复 / 补投通知失败不阻断本轮到期调度，下一 tick 自然重试。
  try {
    recoverStaleAutomationRuns(deps.db, deps.now(), onceFinalizeHooks(deps));
  } catch (error) {
    deps.log.warn(`[AutomationScheduler] stale run recovery failed this tick: ${errorMessage(error)}`);
  }
  try {
    await deps.dispatch.deliverPendingNotifications();
  } catch (error) {
    deps.log.warn(`[AutomationScheduler] pending notification delivery failed this tick: ${errorMessage(error)}`);
  }

  const nowMs = deps.now();
  for (const runId of dueRetryIds(deps.db, nowMs)) {
    let claimed: ClaimedAutomationRun | null;
    try {
      claimed = claimRetryRun(deps.db, runId, nowMs);
    } catch (error) {
      deps.log.warn(`[AutomationScheduler] failed to claim retry run '${runId}': ${errorMessage(error)}`);
      continue;
    }
    if (claimed !== null) await processDueAutomation(deps, claimed, nowMs);
  }

  for (const automation of loadAutomations(deps.db)) {
    if (!automation.enabled) continue;
    // 单个自动化的调度错误只记录并跳过，不能打断整个 tick。
    try {
      await tickAutomation(deps, automation, nowMs);
    } catch (error) {
      deps.log.warn(`[AutomationScheduler] scheduling tick failed for automation '${automation.id}': ${errorMessage(error)}`);
    }
  }
}

async function tickAutomation(deps: AutomationRuntimeDeps, automation: AutomationDefinition, nowMs: number): Promise<void> {
  if (automation.next_run_at === null) {
    initializeNextRun(deps.db, automation);
    return;
  }
  let expectedNextRunAt = automation.next_run_at;
  const repaired = repairSkewedNextRun(deps.db, automation, expectedNextRunAt, nowMs);
  if (repaired !== null) {
    deps.log.warn(`[AutomationScheduler] next_run_at of '${automation.id}' (${expectedNextRunAt}) exceeds the schedule's max gap; clock skew or stale data suspected, recomputed to ${repaired}`);
    expectedNextRunAt = repaired;
  }
  const maxSlots = automation.catch_up_policy === 'catch_up_all' ? CATCH_UP_BATCH : 1;
  for (let slot = 0; slot < maxSlots; slot += 1) {
    const scheduledFor = parseTimestampMillis(expectedNextRunAt);
    if (scheduledFor === null) throw AppError.internal('Invalid automation timestamp');
    if (scheduledFor > nowMs) break;
    const claimed = claimScheduledRun(deps.db, automation.id, expectedNextRunAt, nowMs);
    if (claimed === null) break;
    const advancedNext = claimed.automation.next_run_at;
    const lateness = nowMs - scheduledFor;
    if (automation.catch_up_policy === 'skip' && lateness > SCHEDULER_POLL_SECS * 2 * 1000) {
      completeRun(deps.db, claimed.run_id, claimed.attempt, 'skipped', [], null,
        'Skipped by catch-up policy after the app was unavailable', null);
      // once 的时点被 skip 消耗后同样进入“已完成”暂停态。
      finalizeOnce(deps, claimed.automation);
    } else {
      await processDueAutomation(deps, claimed, nowMs);
    }
    if (advancedNext === null) break;
    expectedNextRunAt = advancedNext;
  }
}

// ------------------------------------------------------------------ 单次派发

/** automations.rs:3343–3560。 */
export async function processDueAutomation(
  deps: AutomationRuntimeDeps, claimed: ClaimedAutomationRun, nowMs: number,
): Promise<void> {
  const automation = claimed.automation;
  let killSwitchError: string | null = null;
  if (!deps.scheduler.dispatchAllowed()) {
    killSwitchError = 'Skipped: AgentKillSwitch / automation scheduler paused';
  } else {
    try {
      deps.dispatch.ensureKillSwitchAllowed();
    } catch (error) {
      killSwitchError = errorMessage(error);
    }
  }
  if (killSwitchError !== null) {
    deps.log.info(`[AutomationScheduler] skip dispatch for run=${claimed.run_id} (scheduler paused / kill switch)`);
    try {
      if (completeRun(deps.db, claimed.run_id, claimed.attempt, 'cancelled', [], null,
        'Skipped: AgentKillSwitch / automation scheduler paused', null)) {
        finalizeOnce(deps, claimed.automation);
      }
    } catch (error) {
      deps.log.warn(`[AutomationScheduler] failed to cancel claimed run '${claimed.run_id}' during pause: ${errorMessage(error)}`);
    }
    deps.dispatch.emitChanged('run_cancelled', automation.id);
    return;
  }

  if (automation.action_type === 'agent_turn') {
    dispatchAgentTurn(deps, claimed);
    return;
  }
  await dispatchNotify(deps, claimed, nowMs);
}

function dispatchAgentTurn(deps: AutomationRuntimeDeps, claimed: ClaimedAutomationRun): void {
  const automation = claimed.automation;
  let guard: ReturnType<typeof AgentAutomationRunGuard.tryAcquire>;
  try {
    guard = AgentAutomationRunGuard.tryAcquire(automation.id);
  } catch (error) {
    void handleSpawnError(deps, claimed, errorMessage(error));
    return;
  }
  if (guard === null) {
    void handleSpawnError(deps, claimed, `Automation '${automation.id}' is already running (single-flight)`);
    return;
  }
  startGuardedAgentTurn(deps, claimed, guard);
}

function startGuardedAgentTurn(
  deps: AutomationRuntimeDeps, claimed: ClaimedAutomationRun,
  guard: AgentAutomationRunGuard,
): void {
  const automation = claimed.automation;
  // automations.rs:3798–3820：先登记活跃 token，再后台执行；取消命令通过该
  // token 中止 headless turn。执行前 executeAgentTurnAutomation 会重新核对 run
  // 仍为 running，覆盖“claim 之后、token 登记之前已被取消”的窗口。
  const { guard: activeGuard, token } = ActiveAutomationRunGuard.register(claimed.run_id);
  const started = executeAgentTurnAutomation(deps, claimed, token.signal);
  started.then(
    () => deps.log.info(`[AutomationScheduler] fired agent_turn automation '${automation.name}' run=${claimed.run_id}`),
    (error: unknown) => { void handleSpawnError(deps, claimed, errorMessage(error)); },
  ).finally(() => {
    activeGuard.release();
    guard.release();
  });
}

async function handleSpawnError(
  deps: AutomationRuntimeDeps, claimed: ClaimedAutomationRun, error: string,
): Promise<void> {
  const automation = claimed.automation;
  deps.log.warn(`[AutomationScheduler] agent_turn automation '${automation.name}' failed to start: ${error}`);
  let outcome: RunFinalizeOutcome = 'finished';
  try {
    outcome = retryOrFinishRun(deps.db, claimed.run_id, claimed.attempt, automation,
      'spawn_error', null, error, !automation.heartbeat);
  } catch (persistError) {
    deps.log.error(`[AutomationScheduler] failed to persist spawn_error for run '${claimed.run_id}': ${errorMessage(persistError)}`);
    outcome = 'finished';
  }
  if (outcome !== 'finished' || automation.heartbeat) return;
  finalizeOnce(deps, automation);
  // spawn_error 终态不经过 run_completed 事件（无前端 toast），OS 通知是唯一告知渠道，
  // 不做窗口活跃抑制（automations.rs:3395–3420）。
  try {
    const lang = deps.dispatch.notificationLanguage();
    await deps.dispatch.sendRunNotification({
      runId: claimed.run_id, attempt: claimed.attempt, status: 'spawn_error',
      title: notificationTitleFailed(lang, automation.name),
      body: truncateForNotification(error, 120), suppressIfWindowActive: false,
    });
  } catch (notifyError) {
    deps.log.warn(`[AutomationScheduler] failed to deliver spawn_error notification for '${claimed.run_id}': ${errorMessage(notifyError)}`);
  }
}

async function dispatchNotify(deps: AutomationRuntimeDeps, claimed: ClaimedAutomationRun, nowMs: number): Promise<void> {
  const automation = claimed.automation;
  const lang = deps.dispatch.notificationLanguage();
  // notify 类型的到点提醒是交付物本身（前端无对应 toast），永不抑制。
  try {
    await deps.dispatch.sendRunNotification({
      runId: claimed.run_id, attempt: claimed.attempt, status: 'running',
      title: notificationTitleRunning(lang, automation.name),
      body: truncatePromptForNotification(automation.prompt, lang),
      suppressIfWindowActive: false,
    });
  } catch (error) {
    deps.log.warn(`[AutomationScheduler] running notification failed for run '${claimed.run_id}': ${errorMessage(error)}`);
  }
  let delivered: string[] = [];
  try {
    delivered = (await deps.dispatch.deliverNotify(claimed, nowMs)).delivered;
  } catch (error) {
    deps.log.warn(`[AutomationScheduler] notify delivery failed for run '${claimed.run_id}': ${errorMessage(error)}`);
  }
  let persisted = delivered;
  // 回执以数据库为准：投递端口可能只写回了部分渠道。
  try {
    persisted = loadRunDeliveries(deps.db, claimed.run_id);
  } catch (error) {
    deps.log.warn(`[AutomationScheduler] failed to load deliveries for run '${claimed.run_id}': ${errorMessage(error)}`);
  }
  const notificationDelivered = persisted.includes('notification');
  const todoDelivered = persisted.includes('todo');
  const errorMessageText = !notificationDelivered && !todoDelivered
    ? 'Notification and todo delivery both failed'
    : !notificationDelivered
      ? 'Notification delivery failed'
      : !todoDelivered
        ? 'Todo delivery failed'
        : '';

  let outcome: RunFinalizeOutcome;
  if (errorMessageText === '') {
    try {
      outcome = completeRun(deps.db, claimed.run_id, claimed.attempt, 'success', persisted, null,
        automation.prompt, null) ? 'finished' : 'superseded';
    } catch (error) {
      deps.log.warn(`[AutomationScheduler] failed to finish run '${claimed.run_id}' for '${automation.id}': ${errorMessage(error)}`);
      outcome = 'superseded';
    }
  } else {
    try {
      outcome = retryOrFinishRun(deps.db, claimed.run_id, claimed.attempt, automation,
        'error', null, errorMessageText, false);
    } catch (error) {
      deps.log.error(`[AutomationScheduler] failed to persist notify delivery outcome for run '${claimed.run_id}': ${errorMessage(error)}`);
      outcome = 'superseded';
    }
  }
  if (outcome === 'finished') finalizeOnce(deps, automation);

  const status = outcome === 'finished'
    ? (errorMessageText === '' ? 'success' : 'error')
    : outcome === 'retry_scheduled' ? 'retrying' : 'superseded';
  deps.dispatch.emitChanged('run_completed', automation.id);
  deps.log.info(`[AutomationScheduler] notify run '${claimed.run_id}' finalized: ${status}`);
}

// ------------------------------------------------------------------ agent_turn 执行与终态

/** automations.rs:3823–4140：headless turn、状态映射、named 回存、终态与完成事件。 */
async function executeAgentTurnAutomation(
  deps: AutomationRuntimeDeps, claimed: ClaimedAutomationRun, cancellationToken: AbortSignal,
): Promise<void> {
  const automation = claimed.automation;
  let running: boolean;
  try {
    running = automationRunIsRunning(deps.db, claimed.run_id, claimed.attempt);
  } catch (error) {
    deps.log.warn(`[AutomationScheduler] failed to verify run '${claimed.run_id}' before executing; deferring to lease recovery: ${errorMessage(error)}`);
    return;
  }
  if (!running) return;

  if (automation.heartbeat && claimed.trigger_type !== 'manual') {
    let idle = false;
    if (deps.dispatch.heartbeatIdlePrecheck !== undefined) {
      try {
        idle = await deps.dispatch.heartbeatIdlePrecheck(automation);
      } catch (error) {
        // Rust debug：预检失败 fail-open，照常执行 LLM 检查。
        deps.log.info(`[AutomationScheduler] heartbeat '${automation.name}' idle precheck failed (${errorMessage(error)}); falling back to LLM run`);
        idle = false;
      }
    }
    if (idle) {
      deps.log.info(`[AutomationScheduler] heartbeat '${automation.name}' idle precheck found no due reviews or todos; skipping LLM call for run=${claimed.run_id}`);
      finalizeHeartbeatIdleSkip(deps, automation, claimed.run_id, claimed.attempt);
      return;
    }
  }

  const lang = deps.dispatch.notificationLanguage();
  const sessionMode = automation.session_mode ?? 'isolated';
  const request: HeadlessTurnRequest = {
    prompt: effectiveAgentPrompt(automation),
    sessionMode,
    namedSessionId: automation.agent_session_id,
    modelId: automation.model_id,
    source: `automation:${automation.id}:${claimed.trigger_type}`,
    title: notificationTitleRunning(lang, automation.name),
    hardTimeoutSecs: automation.timeout_seconds,
    maxToolRounds: automation.trusted_profile?.maxToolRounds ?? null,
    trustedProfile: automation.trusted_profile,
    cancellationToken,
  };

  let result: HeadlessTurnResult | null = null;
  let thrown: unknown = null;
  try {
    result = await deps.dispatch.runHeadlessTurn(request);
  } catch (error) {
    thrown = error;
  }

  if (sessionMode === 'named' && result !== null) {
    if (automation.agent_session_id !== result.sessionId) {
      try {
        updateAutomationAgentSessionId(deps.db, automation.id, automation.version, result.sessionId);
      } catch (error) {
        deps.log.warn(`[AutomationScheduler] failed to persist named session id for '${automation.id}': ${errorMessage(error)}`);
      }
    }
  }

  let status: string;
  let summary: string;
  let sessionId: string | null;
  if (result !== null) {
    sessionId = result.sessionId;
    if (result.status === 'completed') {
      if (automation.heartbeat && heartbeatIsSilent(result.summary)) {
        status = 'heartbeat_ok';
        summary = 'HEARTBEAT_OK';
        deps.log.info(`[AutomationScheduler] heartbeat '${automation.name}' reported OK; suppressing notification`);
      } else {
        status = 'success';
        summary = truncateForNotification(result.summary, 120);
      }
    } else {
      status = result.status;
      summary = truncateForNotification(result.error ?? 'headless turn failed', 160);
      deps.log.warn(`[AutomationScheduler] agent_turn automation '${automation.name}' ended with status=${result.status}: ${result.error ?? ''}`);
    }
  } else {
    sessionId = null;
    status = isCancellationError(thrown) ? 'cancelled' : 'error';
    summary = truncateForNotification(errorMessage(thrown), 160);
    deps.log.warn(`[AutomationScheduler] agent_turn automation '${automation.name}' failed: ${errorMessage(thrown)}`);
  }

  if (status === 'cancelled' && deps.scheduler.isExiting()) {
    deps.log.info(`[AutomationScheduler] leaving run '${claimed.run_id}' recoverable during shutdown`);
    return;
  }

  const successful = status === 'success' || status === 'heartbeat_ok';
  const completionDeliveries = status === 'success' && !automation.heartbeat
    ? ['notification_pending'] : [];
  let outcome: RunFinalizeOutcome;
  if (successful) {
    try {
      outcome = completeRun(deps.db, claimed.run_id, claimed.attempt, status,
        completionDeliveries, sessionId, summary, null) ? 'finished' : 'superseded';
    } catch (error) {
      deps.log.warn(`[AutomationScheduler] failed to complete run: ${errorMessage(error)}`);
      outcome = 'superseded';
    }
  } else if (status === 'cancelled') {
    try {
      outcome = completeRun(deps.db, claimed.run_id, claimed.attempt, 'cancelled',
        [], sessionId, summary, summary) ? 'finished' : 'superseded';
    } catch (error) {
      deps.log.warn(`[AutomationScheduler] failed to persist cancellation: ${errorMessage(error)}`);
      outcome = 'superseded';
    }
  } else {
    try {
      outcome = retryOrFinishRun(deps.db, claimed.run_id, claimed.attempt, automation,
        status, sessionId, summary, !automation.heartbeat);
    } catch (error) {
      deps.log.warn(`[AutomationScheduler] failed to persist retry: ${errorMessage(error)}`);
      outcome = 'superseded';
    }
  }

  if (outcome === 'superseded') {
    deps.dispatch.emitChanged('run_superseded', automation.id);
    return;
  }
  const retryScheduled = outcome === 'retry_scheduled';
  if (outcome === 'finished') finalizeOnce(deps, automation);

  let osNotificationDelivered = false;
  if (successful && status === 'success') {
    try {
      osNotificationDelivered = (await deps.dispatch.sendRunNotification({
        runId: claimed.run_id, attempt: claimed.attempt, status: 'success',
        title: notificationTitleSuccess(lang, automation.name),
        body: notificationSuccessBody(lang, summary, sessionId),
        suppressIfWindowActive: true,
      })).deliveredOs;
    } catch (error) {
      deps.log.warn(`[AutomationScheduler] success notification failed for run '${claimed.run_id}': ${errorMessage(error)}`);
    }
  } else if (!successful && !retryScheduled && status !== 'cancelled' && !automation.heartbeat) {
    try {
      osNotificationDelivered = (await deps.dispatch.sendRunNotification({
        runId: claimed.run_id, attempt: claimed.attempt, status,
        title: notificationTitleFailed(lang, automation.name),
        body: summary, suppressIfWindowActive: true,
      })).deliveredOs;
    } catch (error) {
      deps.log.warn(`[AutomationScheduler] failure notification failed for run '${claimed.run_id}': ${errorMessage(error)}`);
    }
  }

  try {
    deps.dispatch.emitRunCompleted({
      automationId: automation.id,
      automationName: automation.name,
      sessionId,
      runId: claimed.run_id,
      attempt: claimed.attempt,
      status: retryScheduled ? 'retrying' : status,
      summary,
      heartbeat: automation.heartbeat,
      osNotificationDelivered,
    });
  } catch (error) {
    deps.log.warn(`[AutomationScheduler] failed to emit run_completed for run '${claimed.run_id}': ${errorMessage(error)}`);
  }
  deps.dispatch.emitChanged('run_completed', automation.id);
}

/** automations.rs:4185–4225：空转心跳的 heartbeat_ok 收尾。 */
function finalizeHeartbeatIdleSkip(
  deps: AutomationRuntimeDeps, automation: AutomationDefinition, runId: string, attempt: number,
): void {
  let finished = false;
  try {
    finished = completeRun(deps.db, runId, attempt, 'heartbeat_ok', [], null, 'HEARTBEAT_OK', null);
  } catch (error) {
    deps.log.warn(`[AutomationScheduler] failed to complete idle heartbeat run '${runId}': ${errorMessage(error)}`);
  }
  if (!finished) {
    deps.dispatch.emitChanged('run_superseded', automation.id);
    return;
  }
  finalizeOnce(deps, automation);
  try {
    deps.dispatch.emitRunCompleted({
      automationId: automation.id, automationName: automation.name, sessionId: null,
      runId, attempt, status: 'heartbeat_ok', summary: 'HEARTBEAT_OK',
      heartbeat: automation.heartbeat, osNotificationDelivered: false,
    });
  } catch (error) {
    deps.log.warn(`[AutomationScheduler] failed to emit run_completed for idle heartbeat run '${runId}': ${errorMessage(error)}`);
  }
  deps.dispatch.emitChanged('run_completed', automation.id);
}

function isCancellationError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'CancelledError');
}

// ------------------------------------------------------------------ run_now

/** automations.rs:4839–4960（命令路径，`agent_facing=false`）。 */
export function runAutomationNow(
  deps: AutomationRuntimeDeps, automationId: string, expectedVersion: number,
): Record<string, unknown> {
  if (!deps.scheduler.dispatchAllowed()) {
    throw AppError.validation('Automation dispatch is paused (AgentKillSwitch / scheduler pause). Resume agents and automations first.');
  }
  deps.dispatch.ensureKillSwitchAllowed();
  const automation = loadAutomations(deps.db).find((entry) => entry.id === automationId);
  if (automation === undefined) {
    throw AppError.not_found(`Automation '${automationId}' not found`);
  }
  if (automation.version !== expectedVersion) {
    throw automationVersionConflictError(automationId, expectedVersion, automation);
  }
  let result: Record<string, unknown>;
  if (automation.action_type === 'agent_turn') {
    result = startAgentTurnNow(deps, automationId, expectedVersion);
  } else {
    const claimed = createManualRun(deps.db, automationId, expectedVersion);
    const nowMs = deps.now();
    const started = Promise.resolve().then(() => processDueAutomation(deps, claimed, nowMs));
    started.catch((error: unknown) => {
      deps.log.warn(`[AutomationScheduler] manual notify run '${claimed.run_id}' delivery task failed (lease recovery will finalize it): ${errorMessage(error)}`);
    });
    result = { status: 'started', automationId, runId: claimed.run_id };
  }
  deps.dispatch.emitChanged('run_now', automationId);
  return result;
}

function startAgentTurnNow(
  deps: AutomationRuntimeDeps, automationId: string, expectedVersion: number,
): Record<string, unknown> {
  const guard = AgentAutomationRunGuard.tryAcquire(automationId);
  if (guard === null) {
    throw AppError.validation(`Automation '${automationId}' is already running (single-flight)`);
  }
  let claimed: ClaimedAutomationRun;
  try {
    claimed = createManualRun(deps.db, automationId, expectedVersion);
  } catch (error) {
    guard.release();
    throw error;
  }
  startGuardedAgentTurn(deps, claimed, guard);
  return { status: 'started', automationId, timeoutSecs: claimed.automation.timeout_seconds };
}

/** automations.rs:1250–1268 的版本冲突（沿用 repository 的固定文案与 code）。 */
