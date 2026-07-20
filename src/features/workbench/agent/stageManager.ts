/**
 * ACR StageManager — R1-06 / R2-09 / R3-04
 * 桥请求分发、租约互斥、presence 心跳、仲裁接线、账本回滚。
 * R2-09：关窗/资源删 abort run、follow 唤醒 frozen、最小化/background 直落 pacing。
 * R3-04：apply 抛异常 → failed 回执 + presence/租约清理（勿沿用 abort 的 cancelled）。
 * 契约见 ./types.ts；状态机见 docs/dev/acr/DESIGN.md §2.4 / §4.1 / §6。
 */
import { getSetting } from '@/utils/settingsApi';
import { isContentDirty } from '../apps/content/contentDirtyRegistry';
import { prepareWorkspaceResource } from '../apps/notes/workspaceRegistry';
import { appRegistry } from '../core/appRegistry';
import { getAgentUndo } from '../core/agentUndoJournal';
import { hubListen } from '../core/eventHub';
import { subscribePerfDegrade, acquirePerfMonitor } from '../core/perfMonitor';
import {
  reportSchedulerActivity,
  requestWakePrefetch,
} from '../core/scheduler';
import { getSortedWindows } from '../core/windowListCache';
import { useWindowStore } from '../core/windowStore';
import { workbenchBus } from '../core/workbenchBus';
import {
  isAgentActRequestReadOnly,
  isAgentRuntimeError,
} from '../core/agentRuntime';
import type {
  AgentActRequest,
  AgentCapabilityRisk,
  AgentWaitForRequest,
  AgentWindowTarget,
  DisplayMode,
} from '../core/types';
import i18n from 'i18next';
import { createArbitrator, type Arbitrator } from './arbitration';
import { emitAcrProgress } from './bridge';
import { recordAcrReceiptSummary } from './domainEvents';
import { disposeAllDrivers, registerAllDrivers } from './drivers';
import {
  gateDisabledLaunchFailed,
  gateDisabledOff,
  gateDisabledOs,
  getAgentControlMode,
  parseAgentControlMode,
  setAgentControlMode,
  type AgentControlMode,
  type GateErrorParts,
} from './gates';
import {
  bindRunLedgerMetadata,
  discardEmptyRunLedger,
  elevateRunLedgerRisk,
  findRunLedgerKeyByExternalId,
  getRunLedgerMetadata,
  runLedger,
} from './ledger';
import { createPacer, forcePacerInstant } from './pacing';
import { isPresenceExpired, usePresenceStore } from './presenceStore';
import { probeTarget } from './probe';
import {
  readDriverQueryState,
  registerBuiltinQueryProviders,
} from './queryProviders';
import type {
  AcrBridgeRequest,
  AcrBridgeResponse,
  AcrDiagnosticsSnapshot,
  AcrPlacementHint,
  AcrReceipt,
  AcrTarget,
  AgentOp,
  CollabDriver,
  Pacer,
  PacingProfileName,
  RunLedger,
  StageManagerApi,
  WindowSummary,
} from './types';
import {
  ACR_ERROR_CODES,
  ACR_EVENT_CANCEL,
  getAcrCommandAccess,
} from './types';

// ---------------------------------------------------------------------------
// 常量与设置
// ---------------------------------------------------------------------------

/** presence TTL；心跳每 HEARTBEAT_MS 续期（DESIGN §4.1 / R2-06） */
export const PRESENCE_TTL_MS = 8000;
export const HEARTBEAT_MS = 3000;
/** R2-06：过期 presence 自愈扫描周期 */
export const PRESENCE_SWEEP_MS = 2000;
/**
 * stop 后等待当前 op 自然结算的上限；超时转为明确 orphan partial。
 * 与 Rust 侧 CANCEL_DRAIN_MS(3s) 对齐语义：Rust 3s 后已向模型报
 * RESULT_UNKNOWN，前端无需再等 15s 才承认 orphan——6s（2× Rust drain +
 * 余量）即可进入 orphan-draining 诊断态；写租约仍保持到 promise 真正
 * settle（防幽灵写），此常量只控制状态标记时机。
 */
export const ORPHAN_DRAIN_MS = 6_000;
/** DESIGN §4.3 / §7：同时演出窗口上限 */
const MAX_STAGED_WINDOWS = 2;
const SETTING_AGENT_CONTROL = 'desktop.workbenchAgentControl';
const SETTING_AGENT_PACING = 'desktop.workbenchAgentPacing';
const RESOURCE_KEY_REQUIRED_TYPE_IDS = new Set([
  'note',
  'textbook',
  'exam',
  'translation',
  'essay',
  'image',
  'file',
  // OS 模式统一文件预览应用（instanceKey=resourceId），无资源开窗只有空壳
  'file-preview',
  'mindmap',
]);

/**
 * 本地镜像；真相源在 gates.getAgentControlMode()。
 * ACR 4.0：初始值与 gates 产品默认（follow）一致，消灭「settings 未加载完
 * mutating 请求被误拒 WORKBENCH_DISABLED」的启动竞态；settings 未就绪时
 * mutating 请求会先 await refreshSettings（见 handleBridgeRequest）。
 */
let agentControl: AgentControlMode = 'follow';
let agentPacing: PacingProfileName = 'normal';
let lifecycleGeneration = 0;
let controlSettingRevision = 0;
let pacingSettingRevision = 0;
/** ACR 4.0：控制档设置是否已完成首次加载（或被显式覆盖） */
let controlSettingsReady = false;
/** start() 发起的首次 refreshSettings；未就绪时 mutating 请求 await 它 */
let pendingSettingsRefresh: Promise<void> | null = null;

function parsePacing(raw: string | null | undefined): PacingProfileName {
  if (raw === 'fast' || raw === 'normal' || raw === 'demo') return raw;
  return 'normal';
}

function syncAgentControl(mode: AgentControlMode): void {
  agentControl = mode;
  setAgentControlMode(mode);
}

async function refreshSettings(
  generation: number,
  controlRevision: number,
  pacingRevision: number,
): Promise<void> {
  try {
    const [control, pacing] = await Promise.all([
      getSetting(SETTING_AGENT_CONTROL),
      getSetting(SETTING_AGENT_PACING),
    ]);
    if (!started || lifecycleGeneration !== generation) return;
    if (controlSettingRevision === controlRevision) {
      syncAgentControl(parseAgentControlMode(control));
    }
    if (pacingSettingRevision === pacingRevision) {
      agentPacing = parsePacing(pacing);
    }
  } catch {
    /* 读设置失败保持当前缓存 */
  } finally {
    // 成功与否都视为「已尝试加载」：失败时沿用缓存档位，
    // 避免每个 mutating 请求都反复 await 一个注定失败的读取。
    if (started && lifecycleGeneration === generation) {
      controlSettingsReady = true;
    }
  }
}

// ---------------------------------------------------------------------------
// 注册表与活跃 run
// ---------------------------------------------------------------------------

const drivers = new Map<string, CollabDriver>();
const queryProviders = new Map<string, (args: unknown) => unknown>();

interface ActiveRun {
  /** Session-isolated internal identity; never expose in tool cards. */
  key: string;
  runId: string;
  sessionId: string;
  correlationId: string;
  bridgeToken?: string;
  windowId: string | null;
  typeId: string;
  arbitrator: Arbitrator;
  driver: CollabDriver;
  heartbeat: ReturnType<typeof setInterval> | null;
  /** 本 run 的 pacer；perf 降级 / 超限时可变 instant */
  pacer: Pacer;
  /** 是否占用「演出槽」（非 instant 才占；background/超限直落不占） */
  staging: boolean;
  /** 宿主销毁时可预置 fallback；常规取消必须等待 apply 的真实终态。 */
  terminalReceipt: AcrReceipt | null;
  receiptRecorded: boolean;
  abortRequested: boolean;
  abortFallbackReceipt: AcrReceipt | null;
  orphanTimer: ReturnType<typeof setTimeout> | null;
  /** Drain deadline elapsed but the underlying driver has not actually settled. */
  orphaned: boolean;
}

type ManagedOperationKind = AcrDiagnosticsSnapshot['transactions'][number]['kind'];

interface ManagedOperation {
  key: string;
  runId: string;
  sessionId: string;
  correlationId: string;
  bridgeToken?: string;
  kind: ManagedOperationKind;
  windowId: string | null;
  controller: AbortController;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  orphanTimer: ReturnType<typeof setTimeout> | null;
  /** Keep the write lease quarantined until the underlying promise settles. */
  orphaned: boolean;
  ownsLease: boolean;
}

function makeRunKey(sessionId: string, runId: string): string {
  return JSON.stringify([sessionId, runId]);
}

interface TerminalRunRecord {
  command: AcrBridgeRequest['command'];
  fingerprint: string;
  response: AcrBridgeResponse;
}

const MAX_TERMINAL_RUNS = 100;
const terminalRuns = new Map<string, TerminalRunRecord>();
const terminalRunOrder: string[] = [];
/**
 * Forward operation ids stay consumed for the desktop session even after
 * response LRU eviction.
 * ACR 4.0：有界 LRU——每 session 至多 MAX_FORWARD_RUNS_PER_SESSION 个 runId、
 * 至多 MAX_FORWARD_RUN_SESSIONS 个 session，均逐出最旧。被逐出的 runId 重放时
 * 按现有 fallback 处理（terminalRuns 也已淘汰 → 请求按新事务执行）。
 */
const seenForwardRuns = new Map<string, Set<string>>();
export const MAX_FORWARD_RUNS_PER_SESSION = 200;
export const MAX_FORWARD_RUN_SESSIONS = 50;

/** 记录 forward runId（Map/Set 迭代序 = 插入序，天然充当 LRU 队列） */
function rememberForwardRun(sessionId: string, runId: string): void {
  let seen = seenForwardRuns.get(sessionId);
  if (seen) {
    // touch：重插会话使其成为最新，session 级按 LRU 逐出
    seenForwardRuns.delete(sessionId);
  } else {
    seen = new Set<string>();
  }
  seen.delete(runId);
  seen.add(runId);
  while (seen.size > MAX_FORWARD_RUNS_PER_SESSION) {
    const oldest = seen.values().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
  seenForwardRuns.set(sessionId, seen);
  while (seenForwardRuns.size > MAX_FORWARD_RUN_SESSIONS) {
    const oldestSession = seenForwardRuns.keys().next().value;
    if (oldestSession === undefined) break;
    seenForwardRuns.delete(oldestSession);
  }
}

function stableRequestValue(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableRequestValue(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${stableRequestValue(record[key])}`,
  ).join(',')}}`;
}

function requestFingerprint(req: AcrBridgeRequest): string {
  return stableRequestValue(req.args);
}

function isTransactionalCommand(command: AcrBridgeRequest['command']): boolean {
  return command === 'apply_ops'
    || command === 'act'
    || command === 'wait_for'
    || command === 'revert_run'
    || command === 'open_app'
    || command === 'app_command'
    || command === 'close_window';
}

function terminalRunKey(req: AcrBridgeRequest): string {
  const phase = req.command === 'apply_ops' || req.command === 'act'
    ? 'forward'
    : req.command;
  return JSON.stringify([req.sessionId, req.runId, phase]);
}

/** session-scoped run key → active apply_ops */
const activeByRun = new Map<string, ActiveRun>();
/** session-scoped run key → active ACR 2/3 semantic operation */
const managedOperations = new Map<string, ManagedOperation>();
/** windowId → session-scoped run key（租约；仅非空 windowId） */
const leaseByWindow = new Map<string, string>();
/** correlationId → one or more run keys（legacy cancel lacks session identity） */
const runByCorrelation = new Map<string, Set<string>>();
/** UI-triggered session-ledger undo flights (persistent undo uses managedOperations). */
const uiUndoFlights = new Map<string, Promise<boolean>>();
let uiUndoSequence = 0;

let started = false;
let unlistenCancel: (() => void) | null = null;
let unlistenSettings: (() => void) | null = null;
let unlistenMode: (() => void) | null = null;
let presenceSweepTimer: ReturnType<typeof setInterval> | null = null;
let unlistenPerfDegrade: (() => void) | null = null;
/**
 * perfMonitor 持有权：仅在存在活跃 Agent run 时 acquire。
 * 禁止在 start() 无条件启动——空闲 OS 桌面不应常驻 rAF 采样。
 */
let releasePerfMonitorOwner: (() => void) | null = null;

function registerCorrelation(correlationId: string, runKey: string): void {
  const keys = runByCorrelation.get(correlationId) ?? new Set<string>();
  keys.add(runKey);
  runByCorrelation.set(correlationId, keys);
}

function unregisterCorrelation(correlationId: string, runKey: string): void {
  const keys = runByCorrelation.get(correlationId);
  if (!keys) return;
  keys.delete(runKey);
  if (keys.size === 0) runByCorrelation.delete(correlationId);
}

function hasActiveRunKey(runKey: string): boolean {
  return activeByRun.has(runKey) || managedOperations.has(runKey);
}

function resolveLedgerKey(runId: string, sessionId?: string): string | null {
  if (sessionId) {
    const exact = makeRunKey(sessionId, runId);
    return runLedger.hasRun(exact) || getRunLedgerMetadata(exact) ? exact : null;
  }
  // ACR3 callers must supply session identity. Bare IDs are accepted only for
  // metadata-free legacy buckets, never by searching current ACR3 transactions.
  if (findRunLedgerKeyByExternalId(runId)) return null;
  return runLedger.hasRun(runId) && !getRunLedgerMetadata(runId) ? runId : null;
}

function identityFromRunKey(key: string): { sessionId: string; runId: string } {
  try {
    const parsed = JSON.parse(key) as unknown;
    if (
      Array.isArray(parsed)
      && typeof parsed[0] === 'string'
      && typeof parsed[1] === 'string'
    ) {
      return { sessionId: parsed[0], runId: parsed[1] };
    }
  } catch {
    /* legacy key */
  }
  return { sessionId: '', runId: key };
}

function getDiagnosticsSnapshot(): AcrDiagnosticsSnapshot {
  const transactions: AcrDiagnosticsSnapshot['transactions'] = [];
  for (const run of activeByRun.values()) {
    const state = run.orphaned
      ? 'orphan-draining'
      : run.abortRequested
        ? 'cancelling'
        : 'active';
    transactions.push({
      runId: run.runId,
      sessionId: run.sessionId,
      correlationId: run.correlationId,
      kind: 'apply_ops',
      windowId: run.windowId,
      state,
      ownsLease: Boolean(run.windowId && leaseByWindow.get(run.windowId) === run.key),
    });
  }
  for (const operation of managedOperations.values()) {
    const state = operation.orphaned
      ? 'orphan-draining'
      : operation.controller.signal.aborted
        ? 'cancelling'
        : 'active';
    transactions.push({
      runId: operation.runId,
      sessionId: operation.sessionId,
      correlationId: operation.correlationId,
      kind: operation.kind,
      windowId: operation.windowId,
      state,
      ownsLease: Boolean(
        operation.ownsLease
        && operation.windowId
        && leaseByWindow.get(operation.windowId) === operation.key
      ),
    });
  }
  const leases = [...leaseByWindow.entries()].map(([windowId, key]) => {
    const active = activeByRun.get(key);
    const managed = managedOperations.get(key);
    const identity = active ?? managed ?? identityFromRunKey(key);
    return {
      windowId,
      runId: identity.runId,
      sessionId: identity.sessionId,
    };
  });
  return {
    transactions,
    leases,
    cancelling: transactions.filter((item) => item.state === 'cancelling').length,
    orphanDraining: transactions.filter((item) => item.state === 'orphan-draining').length,
    undoInFlight:
      uiUndoFlights.size
      + transactions.filter((item) => item.kind === 'revert_run').length,
  };
}

function syncPerfMonitorForActiveRuns(): void {
  if (activeByRun.size > 0 || managedOperations.size > 0) {
    if (releasePerfMonitorOwner) return;
    try {
      releasePerfMonitorOwner = acquirePerfMonitor();
    } catch {
      /* jsdom / 无 rAF 环境忽略 */
      releasePerfMonitorOwner = null;
    }
    return;
  }
  releasePerfMonitorOwner?.();
  releasePerfMonitorOwner = null;
}

function countStagingRuns(): number {
  let n = 0;
  for (const run of activeByRun.values()) {
    if (run.staging) n += 1;
  }
  return n;
}

/**
 * 演出槽闸门（DESIGN §4.3 / §7）：
 * - 已 instant（含 shouldInstantDrop / reduced-motion）→ 不占槽
 * - 已有 ≥ MAX_STAGED_WINDOWS 路非 instant 演出 → 本路直落（不拒，避免卡死）
 */
function applyStagingGates(
  pacer: Pacer,
  _windowId: string | null,
): { staging: boolean; reason?: string } {
  if (pacer.profile.instant) {
    return { staging: false };
  }
  if (countStagingRuns() >= MAX_STAGED_WINDOWS) {
    forcePacerInstant(pacer, `max-staged=${MAX_STAGED_WINDOWS}`);
    return { staging: false, reason: 'max-staged' };
  }
  return { staging: true };
}

function degradeAllActivePacers(reason: string): void {
  for (const run of activeByRun.values()) {
    if (!run.pacer.profile.instant) {
      forcePacerInstant(run.pacer, reason);
      run.staging = false;
    }
  }
}
/** 窗口被外部关闭（resourceSync / 用户关窗）时中断对应 run */
let unlistenWindows: (() => void) | null = null;

// ---------------------------------------------------------------------------
// 工具：结构化错误 / 回执包装
// ---------------------------------------------------------------------------

function bridgeOk(correlationId: string, data: unknown): AcrBridgeResponse {
  return { correlationId, ok: true, data };
}

function bridgeErr(
  correlationId: string,
  code: string,
  message: string,
  hint: string,
  retryable = false,
): AcrBridgeResponse {
  return {
    correlationId,
    ok: false,
    error: JSON.stringify({ code, message, hint, retryable }),
  };
}

function cloneBridgeResponse(
  response: AcrBridgeResponse,
  correlationId: string,
): AcrBridgeResponse {
  let data = response.data;
  if (data !== undefined) {
    try {
      data = JSON.parse(JSON.stringify(data)) as unknown;
    } catch {
      // Bridge payloads are serializable; retain the original only for legacy local callers.
    }
  }
  return { ...response, correlationId, ...(data !== undefined ? { data } : {}) };
}

function rememberTerminalRun(
  req: AcrBridgeRequest,
  response: AcrBridgeResponse,
): void {
  // Preflight/gate errors did not start a transaction and may be retried with the
  // same identity after their condition changes. Only authoritative successes replay.
  if (!isTransactionalCommand(req.command) || !response.ok) return;
  const key = terminalRunKey(req);
  if (terminalRuns.has(key)) return;
  terminalRuns.set(key, {
    command: req.command,
    fingerprint: requestFingerprint(req),
    response: cloneBridgeResponse(response, req.correlationId),
  });
  if (req.command === 'apply_ops' || req.command === 'act') {
    rememberForwardRun(req.sessionId, req.runId);
  }
  terminalRunOrder.push(key);
  while (terminalRunOrder.length > MAX_TERMINAL_RUNS) {
    const oldest = terminalRunOrder.shift();
    if (oldest) terminalRuns.delete(oldest);
  }
}

function replayTerminalRun(req: AcrBridgeRequest): AcrBridgeResponse | null {
  if (!isTransactionalCommand(req.command)) return null;
  const record = terminalRuns.get(terminalRunKey(req));
  if (!record) {
    if (
      (req.command === 'apply_ops' || req.command === 'act')
      && seenForwardRuns.get(req.sessionId)?.has(req.runId)
    ) {
      return bridgeErr(
        req.correlationId,
        'RUN_ID_EXPIRED',
        `runId ${req.runId} 已完成，但终态正文已从缓存淘汰`,
        '不要重新执行旧事务；重新 observe 后使用新的 toolCallId 规划后续动作',
        false,
      );
    }
    return null;
  }
  if (
    record.command !== req.command
    || record.fingerprint !== requestFingerprint(req)
  ) {
    return bridgeErr(
      req.correlationId,
      'RUN_ID_REUSE',
      `runId ${req.runId} 已绑定到另一个终态事务`,
      '为不同 command/args 生成新的 toolCallId；不要复用已完成事务身份',
      false,
    );
  }
  return cloneBridgeResponse(record.response, req.correlationId);
}

async function runTransactionalRequest(
  req: AcrBridgeRequest,
  task: () => Promise<AcrBridgeResponse>,
): Promise<AcrBridgeResponse> {
  const response = await task();
  rememberTerminalRun(req, response);
  return response;
}

function bridgeGateErr(
  correlationId: string,
  parts: GateErrorParts,
): AcrBridgeResponse {
  return bridgeErr(
    correlationId,
    parts.code,
    parts.message,
    parts.hint,
    parts.retryable,
  );
}

/** control=off / OS 关闭：中止全部活跃 run（partial 由 driver.abort） */
function abortAllActiveRuns(reasonLabel: string): void {
  for (const runId of [...activeByRun.keys()]) {
    const run = activeByRun.get(runId);
    if (!run) continue;
    requestAbort(run, reasonLabel);
  }
  for (const operation of managedOperations.values()) {
    abortManagedOperation(operation, reasonLabel);
  }
}

function applyAgentControlChange(next: AgentControlMode): void {
  const prev = agentControl;
  syncAgentControl(next);
  if (prev !== 'off' && next === 'off') {
    abortAllActiveRuns(
      i18n.t('workbench:agent.errors.abortedByControlOff', {
        defaultValue: '操控已关闭，操作已中止',
      }),
    );
  }
}

function failedReceipt(totalOps: number, message: string): AcrReceipt {
  return {
    status: 'failed',
    mode: 'frontend',
    applied: 0,
    totalOps,
    entityIds: [],
    done: [],
    undone: [],
    message,
  };
}

function recordTerminalReceipt(run: ActiveRun, receipt: AcrReceipt): void {
  if (run.receiptRecorded) return;
  run.receiptRecorded = true;
  recordAcrReceiptSummary({
    runId: run.runId,
    status: receipt.status,
    mode: receipt.mode,
    applied: receipt.applied,
    totalOps: receipt.totalOps,
    message: receipt.message,
  });
}

function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object'
    ? (args as Record<string, unknown>)
    : {};
}

function agentRuntimeOptions(
  req: AcrBridgeRequest,
  opts: {
    withUndo?: boolean;
    runKey?: string;
    signal?: AbortSignal;
    approvalRiskCeiling?: AgentCapabilityRisk;
  } = {},
) {
  const runKey = opts.runKey ?? makeRunKey(req.sessionId, req.runId);
  return {
    runId: req.runId,
    sessionId: req.sessionId,
    resolveDirty: (typeId: string, instanceKey: string | null) =>
      isContentDirty(typeId, instanceKey),
    resolveBusy: (windowId: string) => {
      const owner = leaseByWindow.get(windowId);
      return Boolean(owner && owner !== runKey);
    },
    resolveLegacyState: (ctx: { windowId: string }) => {
      const win = useWindowStore.getState().windows[ctx.windowId];
      return win ? readDriverQueryState(stageManager, win) : {};
    },
    signal: opts.signal,
    approvalRiskCeiling: opts.approvalRiskCeiling,
    ...(opts.withUndo
      ? {
          registerSessionUndo: (
            invert: () => Promise<void> | void,
            label: string,
            risk: AgentCapabilityRisk = 'medium',
          ) => {
            elevateRunLedgerRisk(runKey, risk);
            runLedger.record(runKey, invert, label);
          },
        }
      : {}),
  };
}

function bridgeAgentRuntimeError(
  req: AcrBridgeRequest,
  error: unknown,
): AcrBridgeResponse {
  if (isAgentRuntimeError(error)) {
    return bridgeErr(
      req.correlationId,
      error.code,
      error.message,
      error.hint,
      error.retryable,
    );
  }
  throw error;
}

function resolveAgentRequestWindowId(target: AgentWindowTarget): string | null {
  const state = useWindowStore.getState();
  if (target.windowId) return state.windows[target.windowId]?.id ?? null;
  if (target.typeId) {
    const candidates = Object.values(state.windows).filter(
      (window) => window.typeId === target.typeId,
    );
    if (target.instanceKey) {
      return candidates.find((window) => window.instanceKey === target.instanceKey)?.id ?? null;
    }
    if (appRegistry.get(target.typeId)?.instanceMode === 'single') {
      return candidates[0]?.id ?? null;
    }
    const focusedId = state.focusStack.at(-1);
    return candidates.find((window) => window.id === focusedId)?.id
      ?? candidates[0]?.id
      ?? null;
  }
  const focusedId = state.focusStack.at(-1);
  return focusedId && state.windows[focusedId] ? focusedId : null;
}

function beginManagedOperation(
  req: AcrBridgeRequest,
  kind: ManagedOperationKind,
  windowId: string | null,
  ownsLease: boolean,
): { operation?: ManagedOperation; error?: AcrBridgeResponse } {
  const key = makeRunKey(req.sessionId, req.runId);
  if (hasActiveRunKey(key)) {
    return {
      error: bridgeErr(
        req.correlationId,
        'DUPLICATE_RUN_ID',
        `runId ${req.runId} 已在当前会话执行`,
        '请为新的桥请求生成唯一 runId',
        false,
      ),
    };
  }
  if (runByCorrelation.has(req.correlationId)) {
    return {
      error: bridgeErr(
        req.correlationId,
        'DUPLICATE_CORRELATION_ID',
        `correlationId ${req.correlationId} 已在执行`,
        '请为新的桥请求生成唯一 correlationId',
        false,
      ),
    };
  }
  if (ownsLease && windowId && leaseByWindow.has(windowId)) {
    return {
      error: bridgeErr(
        req.correlationId,
        ACR_ERROR_CODES.WINDOW_BUSY,
        `窗口 ${windowId} 已有活跃 agent run`,
        '请等待当前操作完成，或先取消/停止后再试',
        true,
      ),
    };
  }

  const operation: ManagedOperation = {
    key,
    runId: req.runId,
    sessionId: req.sessionId,
    correlationId: req.correlationId,
    bridgeToken: req.bridgeToken,
    kind,
    windowId,
    controller: new AbortController(),
    timeoutTimer: null,
    orphanTimer: null,
    orphaned: false,
    ownsLease,
  };
  managedOperations.set(key, operation);
  registerCorrelation(req.correlationId, key);
  if (ownsLease && windowId) leaseByWindow.set(windowId, key);
  if (Number.isFinite(req.timeoutMs) && req.timeoutMs > 0) {
    operation.timeoutTimer = setTimeout(() => {
      operation.timeoutTimer = null;
      abortManagedOperation(operation, 'bridge timeout');
    }, req.timeoutMs);
  }
  syncPerfMonitorForActiveRuns();
  return { operation };
}

function finishManagedOperation(operation: ManagedOperation): void {
  if (managedOperations.get(operation.key) !== operation) return;
  if (operation.timeoutTimer != null) clearTimeout(operation.timeoutTimer);
  if (operation.orphanTimer != null) clearTimeout(operation.orphanTimer);
  operation.timeoutTimer = null;
  operation.orphanTimer = null;
  operation.orphaned = false;
  if (
    operation.ownsLease
    && operation.windowId
    && leaseByWindow.get(operation.windowId) === operation.key
  ) {
    leaseByWindow.delete(operation.windowId);
  }
  unregisterCorrelation(operation.correlationId, operation.key);
  managedOperations.delete(operation.key);
  syncPerfMonitorForActiveRuns();
}

function abortManagedOperation(
  operation: ManagedOperation,
  reason: string,
): void {
  if (!operation.controller.signal.aborted) operation.controller.abort(reason);
  if (operation.orphanTimer != null || operation.orphaned) return;
  operation.orphanTimer = setTimeout(() => {
    operation.orphanTimer = null;
    if (managedOperations.get(operation.key) === operation) {
      operation.orphaned = true;
    }
  }, ORPHAN_DRAIN_MS);
}

function rebindManagedOperationLease(
  operation: ManagedOperation,
  windowId: string | null,
): AcrBridgeResponse | null {
  if (operation.windowId === windowId && operation.ownsLease === Boolean(windowId)) {
    return null;
  }
  const owner = windowId ? leaseByWindow.get(windowId) : undefined;
  if (owner && owner !== operation.key) {
    return bridgeErr(
      operation.correlationId,
      ACR_ERROR_CODES.WINDOW_BUSY,
      `窗口 ${windowId} 已有活跃 agent run`,
      '请等待当前操作完成，或先取消/停止后再试',
      true,
    );
  }
  if (
    operation.ownsLease
    && operation.windowId
    && leaseByWindow.get(operation.windowId) === operation.key
  ) {
    leaseByWindow.delete(operation.windowId);
  }
  operation.windowId = windowId;
  operation.ownsLease = Boolean(windowId);
  if (windowId) leaseByWindow.set(windowId, operation.key);
  return null;
}

function promoteManagedApply(
  operation: ManagedOperation,
  run: ActiveRun,
): void {
  if (operation.timeoutTimer != null) clearTimeout(operation.timeoutTimer);
  if (operation.orphanTimer != null) clearTimeout(operation.orphanTimer);
  operation.timeoutTimer = null;
  operation.orphanTimer = null;
  operation.orphaned = false;
  activeByRun.set(run.key, run);
  managedOperations.delete(operation.key);
  // Correlation registration and the window lease keep the same run key, so the
  // preparing -> active transition is atomic from cancel/lease observers' view.
  syncPerfMonitorForActiveRuns();
}

function cancelledBeforeApplyReceipt(
  correlationId: string,
  ops: AgentOp[],
  message = '操作在准备阶段已取消，未开始执行',
): AcrBridgeResponse {
  return bridgeOk(correlationId, {
    status: 'cancelled',
    mode: 'frontend',
    applied: 0,
    totalOps: ops.length,
    entityIds: [],
    done: [],
    undone: ops.map((op) => op.label || op.kind),
    message,
  } satisfies AcrReceipt);
}

function resolveLegacyMutationWindowId(req: AcrBridgeRequest): string | null {
  const args = asRecord(req.args);
  if (req.command === 'close_window') {
    const windowId = typeof args.windowId === 'string' ? args.windowId : '';
    return windowId && useWindowStore.getState().windows[windowId] ? windowId : null;
  }
  if (req.command !== 'app_command') return null;
  const payload = asRecord(args.payload);
  const explicitWindowId = typeof payload.windowId === 'string' ? payload.windowId : '';
  if (explicitWindowId && useWindowStore.getState().windows[explicitWindowId]) {
    return explicitWindowId;
  }
  const typeId = typeof args.typeId === 'string' ? args.typeId : '';
  const instanceKey = typeof args.instanceKey === 'string' ? args.instanceKey : null;
  const candidates = Object.values(useWindowStore.getState().windows).filter(
    (window) => window.typeId === typeId,
  );
  return (
    instanceKey
      ? candidates.find((window) => window.instanceKey === instanceKey)
      : candidates[0]
  )?.id ?? null;
}

async function runLegacyMutation(
  req: AcrBridgeRequest,
  task: () => Promise<AcrBridgeResponse> | AcrBridgeResponse,
): Promise<AcrBridgeResponse> {
  const windowId = resolveLegacyMutationWindowId(req);
  // Closing is the lifecycle escape hatch for an active apply. It must wait for
  // canClose and then abort that run, rather than deadlocking on the run's lease.
  const ownsLease = req.command !== 'close_window' && Boolean(windowId);
  const started = beginManagedOperation(
    req,
    req.command as 'open_app' | 'app_command' | 'close_window',
    windowId,
    ownsLease,
  );
  if (started.error) return started.error;
  const operation = started.operation!;
  try {
    return await task();
  } finally {
    finishManagedOperation(operation);
  }
}

// ---------------------------------------------------------------------------
// presence / 心跳
// ---------------------------------------------------------------------------

function startHeartbeat(run: ActiveRun): void {
  stopHeartbeat(run);
  if (!run.windowId) return;
  const windowId = run.windowId;
  run.heartbeat = setInterval(() => {
    usePresenceStore.getState().renew(run.key);
    requestWakePrefetch(windowId);
    reportSchedulerActivity('stream');
  }, HEARTBEAT_MS);
}

function stopHeartbeat(run: ActiveRun): void {
  if (run.heartbeat != null) {
    clearInterval(run.heartbeat);
    run.heartbeat = null;
  }
}

/** S-REV-02：done 态短时保留 presence，便于 AgentStrip 点撤销 */
const DONE_PRESENCE_HOLD_MS = 4000;
const doneHoldTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearDoneHoldTimer(runKey: string): void {
  const t = doneHoldTimers.get(runKey);
  if (t != null) {
    clearTimeout(t);
    doneHoldTimers.delete(runKey);
  }
}

function clearAllDoneHoldTimers(): void {
  for (const timer of doneHoldTimers.values()) {
    clearTimeout(timer);
  }
  doneHoldTimers.clear();
}

function clearOrphanTimer(run: ActiveRun): void {
  if (run.orphanTimer != null) {
    clearTimeout(run.orphanTimer);
    run.orphanTimer = null;
  }
  run.orphaned = false;
}

function clearActiveRun(
  runKey: string,
  opts?: {
    retainPresenceMs?: number;
    expectedRun?: ActiveRun;
    /** ACR 4.0（A8）：reviewing（建议挂起）presence 由建议流程自管，勿在此清除 */
    preservePresence?: boolean;
  },
): void {
  const run = activeByRun.get(runKey);
  if (!run || (opts?.expectedRun && run !== opts.expectedRun)) return;
  stopHeartbeat(run);
  clearOrphanTimer(run);
  run.arbitrator.dispose();
  if (run.windowId && leaseByWindow.get(run.windowId) === runKey) {
    leaseByWindow.delete(run.windowId);
  }
  unregisterCorrelation(run.correlationId, runKey);
  activeByRun.delete(runKey);
  syncPerfMonitorForActiveRuns();

  const retainMs = opts?.retainPresenceMs ?? 0;
  clearDoneHoldTimer(run.key);
  if (opts?.preservePresence) return;
  if (retainMs > 0) {
    // 租约已释放，仅保留光环/Strip 供撤销；TTL 心跳已停，用短时定时器清
    const timer = setTimeout(() => {
      doneHoldTimers.delete(run.key);
      usePresenceStore.getState().clearByRun(run.key);
    }, retainMs);
    doneHoldTimers.set(run.key, timer);
  } else {
    usePresenceStore.getState().clearByRun(run.key);
  }
}

function finalizeRun(run: ActiveRun, receipt: AcrReceipt): AcrReceipt {
  if (!run.terminalReceipt) run.terminalReceipt = receipt;
  const authoritative = run.terminalReceipt;
  recordTerminalReceipt(run, authoritative);
  runLedger.sealRun(run.key);

  if (activeByRun.get(run.key) === run) {
    const status = run.windowId
      ? usePresenceStore.getState().byWindow[run.windowId]?.status
      : undefined;
    const terminalAborted = authoritative.status !== 'completed';
    // ACR 4.0（A8 集成核对）：建议模式回执（suggestionPending）在 run 结束后由
    // markSuggestionReviewing 维持 reviewing presence（自带心跳与清除函数），
    // 终态化不得把它覆写为 done / 按保留期清除，否则 AIDiffPanel 挂起期间光环消失。
    const suggestionReviewing =
      status === 'reviewing'
      && !terminalAborted
      && authoritative.suggestionPending === true;
    if (
      !suggestionReviewing &&
      (status === 'pausedByUser' ||
        status === 'acting' ||
        status === 'reviewing')
    ) {
      usePresenceStore
        .getState()
        .updateStatus(run.key, terminalAborted ? 'aborted' : 'done');
    }
    const retainPresenceMs =
      authoritative.status === 'completed' || authoritative.status === 'partial'
        ? DONE_PRESENCE_HOLD_MS
        : 0;
    clearActiveRun(run.key, {
      retainPresenceMs,
      expectedRun: run,
      preservePresence: suggestionReviewing,
    });
  }
  return authoritative;
}

function requestAbort(run: ActiveRun, reasonLabel: string): AcrReceipt | null {
  if (run.abortRequested) return run.abortFallbackReceipt;
  run.abortRequested = true;
  run.arbitrator.stop();
  try {
    run.abortFallbackReceipt = run.driver.abort(run.key);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    run.abortFallbackReceipt = failedReceipt(0, `abort 异常: ${message}`);
  }
  // Cancellation stops renewal immediately. The driver still gets a bounded
  // drain window to publish its authoritative partial receipt.
  stopHeartbeat(run);
  usePresenceStore.getState().updateStatus(run.key, 'aborted', reasonLabel);
  scheduleOrphanDeadline(run);
  return run.abortFallbackReceipt;
}

function scheduleOrphanDeadline(run: ActiveRun): void {
  if (run.orphanTimer != null || run.orphaned || run.terminalReceipt) return;
  run.orphanTimer = setTimeout(() => {
    run.orphanTimer = null;
    if (activeByRun.get(run.key) !== run || run.terminalReceipt) return;
    // Rust has already surfaced RESULT_UNKNOWN after its bounded drain. A handler
    // that ignored cancellation may still write, so quarantine the window until
    // the underlying promise actually settles instead of releasing its lease.
    run.orphaned = true;
  }, ORPHAN_DRAIN_MS);
}

function findActiveApplyRun(
  runIdentity: string,
  windowId?: string,
): ActiveRun | undefined {
  const exact = activeByRun.get(runIdentity);
  return exact && (!windowId || exact.windowId === windowId) ? exact : undefined;
}

/**
 * R2-06 presence 泄漏自愈：
 * - 心跳停更后超过 ttlMs → 中止挂死 run 并清租约/光环
 * - 无活跃 run 的孤儿 presence → 直接清除
 */
function healStalePresence(now = Date.now()): void {
  const entries = Object.values(usePresenceStore.getState().byWindow);
  for (const p of entries) {
    if (!isPresenceExpired(p, now)) continue;
    const run = activeByRun.get(p.runKey);
    if (run) {
      stopHeartbeat(run);
      requestAbort(run, '操作心跳超时，已中止');
    } else {
      usePresenceStore.getState().clearByRun(p.runKey);
      if (p.windowId) {
        const owner = leaseByWindow.get(p.windowId);
        if (owner && !hasActiveRunKey(owner)) leaseByWindow.delete(p.windowId);
      }
    }
  }
}

function startPresenceSweep(): void {
  stopPresenceSweep();
  presenceSweepTimer = setInterval(() => {
    healStalePresence();
  }, PRESENCE_SWEEP_MS);
}

function stopPresenceSweep(): void {
  if (presenceSweepTimer != null) {
    clearInterval(presenceSweepTimer);
    presenceSweepTimer = null;
  }
}

/** 仅供测试：手动触发 TTL 自愈 */
export function __healStalePresenceForTests(now?: number): void {
  healStalePresence(now);
}

/** 仅供测试：直接注入取消载荷（jsdom 下无法经 Tauri 事件触发） */
export function __handleCancelForTests(payload: unknown): void {
  handleCancel(payload);
}

/** 仅供测试：写入 forward runId（走真实 LRU 逐出逻辑） */
export function __rememberForwardRunForTests(
  sessionId: string,
  runId: string,
): void {
  rememberForwardRun(sessionId, runId);
}

/** 仅供测试：只读窥视 seenForwardRuns */
export function __getSeenForwardRunsForTests(): ReadonlyMap<
  string,
  ReadonlySet<string>
> {
  return seenForwardRuns;
}

/**
 * 目标窗已关闭或即将关闭时中断活跃 run（R2-09）。
 * 不在此处 clearActiveRun：等 apply 的 finally 统一清理，避免竞态双清。
 */
function abortRunForWindow(windowId: string, reason: string): void {
  const runKey = leaseByWindow.get(windowId);
  if (!runKey) return;
  const run = activeByRun.get(runKey);
  if (run) {
    requestAbort(run, reason);
    return;
  }
  const operation = managedOperations.get(runKey);
  if (operation) abortManagedOperation(operation, reason);
}

/** DESIGN §4.3：仅 focused/visible 演出；minimized / background / frozen 直落终态 */
function shouldInstantDrop(windowId: string | null): boolean {
  if (!windowId) return true;
  const { windows, lifecycles } = useWindowStore.getState();
  const win = windows[windowId];
  if (!win) return true;
  if (win.minimized) return true;
  const lc = lifecycles[windowId];
  return lc === 'background' || lc === 'frozen';
}

/**
 * ACR 4.0：直落原因的结构化提示（写入 PresenceState.placementHint）。
 * 与旧 label 后缀语义一一对应：max-staged → stage-full；
 * instant 且窗口不可见 → background（frozen 生命周期单独标出）。
 */
function resolvePlacementHint(
  windowId: string | null,
  pacer: Pacer,
  gateReason: string | undefined,
): AcrPlacementHint | undefined {
  if (gateReason === 'max-staged') return 'stage-full';
  if (!pacer.profile.instant || !shouldInstantDrop(windowId)) return undefined;
  if (windowId && useWindowStore.getState().lifecycles[windowId] === 'frozen') {
    return 'frozen';
  }
  return 'background';
}

/**
 * follow 档：frozen 窗先 focus 唤醒再委托（DESIGN §6）。
 * background 档由 Rust probe 回落，一般不会进 apply_ops；若仍进入则直落 pacing。
 */
function wakeFrozenIfFollow(
  target: AcrTarget,
  windowId: string | null,
): string | null {
  if (!windowId || agentControl !== 'follow') return windowId;
  const probed = probeTarget(target);
  if (probed.state !== 'frozen') return windowId;
  const store = useWindowStore.getState();
  store.focusWindow(windowId);
  // focusWindow 不改 lifecycle；对齐 WindowBody 唤醒：乐观标 focused + prefetch
  const lc = {
    ...useWindowStore.getState().lifecycles,
    [windowId]: 'focused' as const,
  };
  useWindowStore.getState().setLifecycles(lc);
  requestWakePrefetch(windowId);
  reportSchedulerActivity('stream');
  const again = probeTarget(target);
  return again.windowId ?? windowId;
}

// ---------------------------------------------------------------------------
// 命令实现
// ---------------------------------------------------------------------------

function handleProbe(req: AcrBridgeRequest): AcrBridgeResponse {
  const args = asRecord(req.args);
  const target = args.target as AcrTarget | undefined;
  if (!target?.typeId) {
    return bridgeErr(
      req.correlationId,
      'INVALID_ARGS',
      'probe 缺少 target.typeId',
      '请传入 { target: { typeId, resourceId? } }',
    );
  }
  const result = probeTarget(target);
  return bridgeOk(req.correlationId, result);
}

function buildWindowSummaries(): {
  windows: WindowSummary[];
  focused?: string;
} {
  const state = useWindowStore.getState();
  const focused = state.focusStack[state.focusStack.length - 1];
  const windows: WindowSummary[] = getSortedWindows(state.windows).map((w) => {
    const top = focused === w.id;
    const lifecycle =
      state.lifecycles[w.id] ??
      (w.minimized ? 'background' : top ? 'focused' : 'visible');
    return {
      windowId: w.id,
      typeId: w.typeId,
      instanceKey: w.instanceKey,
      title: w.title,
      lifecycle,
      focused: top,
      dirty: isContentDirty(w.typeId, w.instanceKey),
      agentReady: Boolean(appRegistry.getAgentManifest(w.typeId)),
      availableActions: appRegistry.getAgentManifest(w.typeId)?.capabilities
        .map((capability) => capability.name),
    };
  });
  return { windows, focused };
}

function handleListWindows(req: AcrBridgeRequest): AcrBridgeResponse {
  // 优先走 R1-08 provider；缺省时本地实现
  const provider = queryProviders.get('list_windows');
  if (provider) {
    return bridgeOk(req.correlationId, provider(req.args));
  }
  return bridgeOk(req.correlationId, buildWindowSummaries());
}

/**
 * background 档聚焦策略（决策）：
 * openWindow / workbenchBus.launch 会 focus 新窗。为遵守「不抢焦点」，
 * launch 前记录原焦点窗，launch 后若控制档为 background（且 args.focus !== true）
 * 则 focusWindow 回原焦点。不采用 minimize：避免「开窗即最小化」的怪异体验。
 * follow 档或显式 focus:true 保持聚焦。
 */
function handleOpenApp(req: AcrBridgeRequest): AcrBridgeResponse {
  if (!workbenchBus.isEnabled()) {
    return bridgeGateErr(req.correlationId, gateDisabledOs());
  }
  const args = asRecord(req.args);
  const typeId = typeof args.typeId === 'string' ? args.typeId : '';
  if (!typeId) {
    return bridgeErr(
      req.correlationId,
      'INVALID_ARGS',
      'open_app 缺少 typeId',
      '请传入 { typeId, instanceKey?, payload?, focus? }',
    );
  }
  const instanceKey =
    typeof args.instanceKey === 'string' ? args.instanceKey : undefined;
  if (RESOURCE_KEY_REQUIRED_TYPE_IDS.has(typeId) && !instanceKey) {
    return bridgeErr(
      req.correlationId,
      'INVALID_ARGS',
      `open_app 打开 ${typeId} 时缺少 instanceKey`,
      '资源型应用必须传入资源 id 作为 instanceKey',
      false,
    );
  }
  const forceFocus = args.focus === true;
  const wantBackground =
    !forceFocus && (args.focus === false || agentControl === 'background');

  const store = useWindowStore.getState();
  const prevFocus = store.focusStack[store.focusStack.length - 1] ?? null;
  const beforeIds = new Set(Object.keys(store.windows));

  const windowId = workbenchBus.launch({
    typeId,
    instanceKey,
    payload: args.payload,
    reason: 'api',
  });

  if (!windowId) {
    return bridgeGateErr(req.correlationId, gateDisabledLaunchFailed());
  }

  // background：把焦点还给原窗（新窗仍保留在桌面，不 minimize）
  if (wantBackground && prevFocus && prevFocus !== windowId) {
    useWindowStore.getState().focusWindow(prevFocus);
  } else if (agentControl === 'follow' || forceFocus) {
    useWindowStore.getState().focusWindow(windowId);
  }

  const created = !beforeIds.has(windowId);
  return bridgeOk(req.correlationId, { windowId, created });
}

async function handleAppCommand(req: AcrBridgeRequest): Promise<AcrBridgeResponse> {
  if (!workbenchBus.isEnabled()) {
    return bridgeGateErr(req.correlationId, gateDisabledOs());
  }
  const args = asRecord(req.args);
  const typeId = typeof args.typeId === 'string' ? args.typeId : '';
  const action = typeof args.action === 'string' ? args.action : '';
  if (!typeId || !action) {
    return bridgeErr(
      req.correlationId,
      'INVALID_ARGS',
      'app_command 缺少 typeId/action',
      '请传入 { typeId, instanceKey?, action, payload? }',
    );
  }
  const declaredCapability = appRegistry.getAgentCapability(typeId, action);
  if (declaredCapability?.risk === 'high') {
    return bridgeErr(
      req.correlationId,
      ACR_ERROR_CODES.RISK_APPROVAL_REQUIRED,
      `${typeId}.${action} 是 high 风险动作，不能通过 legacy app_command 执行`,
      '先 observe 获取 revision，再使用经过确认的 high-risk act 工具',
      false,
    );
  }
  const instanceKey =
    typeof args.instanceKey === 'string' ? args.instanceKey : '';
  if (typeId === 'workbench') {
    return handleWindowCommand(req, action, args.payload);
  }
  // R2-10：single（pomodoro/browser）或带 instanceKey 的 multi 可 fallbackLaunch；
  // 无 key 的 multi 不瞎开窗（避免 exam 无资源 id 时开空壳）
  const def = appRegistry.get(typeId);
  const canFallback = def?.instanceMode === 'single' || Boolean(instanceKey);
  const store = useWindowStore.getState();
  const prevFocus = store.focusStack[store.focusStack.length - 1] ?? null;
  const explicitFocus = args.focus === true || /^focus/i.test(action);
  let activation;
  try {
    activation = await workbenchBus.activateDetailed({
      typeId,
      instanceKey,
      action,
      payload: args.payload,
      ...(canFallback
        ? {
            fallbackLaunch: {
              typeId,
              instanceKey: instanceKey || undefined,
              payload: args.payload,
              reason: 'api' as const,
            },
          }
        : {}),
    });
  } finally {
    if (agentControl === 'background' && !explicitFocus && prevFocus) {
      useWindowStore.getState().focusWindow(prevFocus);
    }
  }
  const handled = activation.delivered;
  const detail = activation.result;
  if (detail && !detail.handled) {
    return bridgeOk(req.correlationId, {
      handled: false,
      code: detail.code,
      hint: detail.hint,
      message: detail.message ?? detail.hint,
    });
  }
  if (!handled || detail?.acknowledged !== true) {
    return bridgeOk(req.correlationId, {
      handled: false,
      code: 'ACTION_UNVERIFIED',
      hint: '目标应用未返回持久化或领域状态 ACK，操作结果按失败处理',
      message: detail?.message ?? '动作已派发但未获得 authoritative ACK',
    });
  }
  return bridgeOk(req.correlationId, {
    handled: true,
    acknowledged: true,
    ...(detail?.code ? { code: detail.code } : {}),
    ...(detail?.hint ? { hint: detail.hint } : {}),
  });
}

const WINDOW_DISPLAY_ACTIONS: Readonly<Record<string, DisplayMode>> = {
  maximizeWindow: 'maximized',
  restoreWindow: 'floating',
  tileLeft: 'tiled-left',
  tileRight: 'tiled-right',
  tileTopLeft: 'tiled-tl',
  tileTopRight: 'tiled-tr',
  tileBottomLeft: 'tiled-bl',
  tileBottomRight: 'tiled-br',
};

function handleWindowCommand(
  req: AcrBridgeRequest,
  action: string,
  payload: unknown,
): AcrBridgeResponse {
  const input = asRecord(payload);
  const store = useWindowStore.getState();

  if (action === 'showDesktop') {
    const windowIds = Object.keys(store.windows);
    for (const id of windowIds) store.minimizeWindow(id, true);
    const acknowledged = Object.values(useWindowStore.getState().windows)
      .every((window) => window.minimized);
    return bridgeOk(req.correlationId, {
      handled: acknowledged,
      ...(acknowledged
        ? { acknowledged: true }
        : { code: 'ACTION_UNAVAILABLE', hint: '部分窗口未能最小化' }),
      affectedWindowIds: windowIds,
    });
  }

  if (action === 'tileAll') {
    const windows = getSortedWindows(store.windows).filter((win) => !win.minimized);
    const modes: DisplayMode[] =
      windows.length <= 1
        ? ['maximized']
        : windows.length === 2
          ? ['tiled-left', 'tiled-right']
          : windows.length === 3
            ? ['tiled-left', 'tiled-tr', 'tiled-br']
            : ['tiled-tl', 'tiled-tr', 'tiled-bl', 'tiled-br'];
    const entries = windows.slice(0, 4).map((win, index) => ({
      id: win.id,
      mode: modes[index]!,
    }));
    if (store.batchSetDisplayModes) store.batchSetDisplayModes(entries);
    else for (const entry of entries) store.setDisplayMode(entry.id, entry.mode);
    const acknowledged = entries.every(
      (entry) => useWindowStore.getState().windows[entry.id]?.displayMode === entry.mode,
    );
    return bridgeOk(req.correlationId, {
      handled: acknowledged,
      ...(acknowledged
        ? { acknowledged: true }
        : { code: 'ACTION_UNAVAILABLE', hint: '部分窗口未达到目标布局' }),
      affectedWindowIds: entries.map((entry) => entry.id),
      overflow: Math.max(0, windows.length - entries.length),
    });
  }

  const windowId = typeof input.windowId === 'string' ? input.windowId : '';
  if (!windowId) {
    return bridgeErr(
      req.correlationId,
      'INVALID_ARGS',
      `${action} 缺少 payload.windowId`,
      '请先调用 list_windows 获取 windowId',
      false,
    );
  }

  const before = store.windows[windowId];
  if (!before) {
    return bridgeErr(
      req.correlationId,
      ACR_ERROR_CODES.WINDOW_NOT_FOUND,
      `窗口不存在: ${windowId}`,
      '窗口可能已关闭；请重新调用 list_windows',
      false,
    );
  }

  if (action === 'focusWindow') {
    store.focusWindow(windowId);
  } else if (action === 'minimizeWindow') {
    store.minimizeWindow(windowId, true);
  } else if (action === 'unminimizeWindow') {
    store.minimizeWindow(windowId, false);
  } else {
    const mode = WINDOW_DISPLAY_ACTIONS[action];
    if (!mode) {
      return bridgeOk(req.correlationId, {
        handled: false,
        code: 'UNSUPPORTED_ACTION',
        hint: `workbench 不支持窗口指令 ${action}`,
      });
    }
    store.setDisplayMode(windowId, mode);
  }

  const after = useWindowStore.getState().windows[windowId];
  const focused = useWindowStore.getState().focusStack.at(-1) === windowId
    && !(after?.minimized ?? before.minimized);
  const acknowledged = action === 'focusWindow'
    ? focused
    : action === 'minimizeWindow'
      ? after?.minimized === true
      : action === 'unminimizeWindow'
        ? after?.minimized === false
        : after?.displayMode === WINDOW_DISPLAY_ACTIONS[action];
  if (!acknowledged) {
    return bridgeOk(req.correlationId, {
      handled: false,
      code: 'ACTION_UNAVAILABLE',
      hint: `${action} 未达到请求后的窗口状态`,
    });
  }
  return bridgeOk(req.correlationId, {
    handled: true,
    acknowledged: true,
    windowId,
    minimized: after?.minimized ?? before.minimized,
    displayMode: after?.displayMode ?? before.displayMode,
    focused,
  });
}

async function handleCloseWindow(
  req: AcrBridgeRequest,
): Promise<AcrBridgeResponse> {
  if (!workbenchBus.isEnabled()) {
    return bridgeGateErr(req.correlationId, gateDisabledOs());
  }
  const args = asRecord(req.args);
  const windowId = typeof args.windowId === 'string' ? args.windowId : '';
  if (!windowId) {
    return bridgeErr(
      req.correlationId,
      'INVALID_ARGS',
      'close_window 缺少 windowId',
      '请传入 { windowId }',
    );
  }
  if (!useWindowStore.getState().windows[windowId]) {
    return bridgeErr(
      req.correlationId,
      ACR_ERROR_CODES.WINDOW_NOT_FOUND,
      `窗口 ${windowId} 不存在`,
      '请先调用 list_windows 获取当前窗口',
      false,
    );
  }
  const closed = await workbenchBus.closeWindow(windowId);
  if (closed) {
    // canClose 确认成功后再中止；若 store 订阅已先处理，此调用保持幂等。
    abortRunForWindow(windowId, '窗口已关闭，操作中断');
  }
  return bridgeOk(req.correlationId, { closed });
}

function handleQueryState(req: AcrBridgeRequest): AcrBridgeResponse {
  const args = asRecord(req.args);
  const scope = typeof args.scope === 'string' ? args.scope : 'focused';
  const provider =
    queryProviders.get(scope) ?? queryProviders.get('query_state');
  if (!provider) {
    // 最小兜底：返回焦点窗摘要
    const { windows, focused } = buildWindowSummaries();
    const win = windows.find((w) => w.windowId === focused) ?? null;
    return bridgeOk(req.correlationId, { scope, window: win });
  }
  return bridgeOk(req.correlationId, provider(req.args));
}

function handleGetCapabilities(req: AcrBridgeRequest): AcrBridgeResponse {
  try {
    return bridgeOk(
      req.correlationId,
      workbenchBus.getAgentCapabilities(asRecord(req.args) as AgentWindowTarget),
    );
  } catch (error) {
    return bridgeAgentRuntimeError(req, error);
  }
}

async function handleObserve(req: AcrBridgeRequest): Promise<AcrBridgeResponse> {
  try {
    const observation = await workbenchBus.observeAgent(
      asRecord(req.args) as AgentWindowTarget,
      agentRuntimeOptions(req),
    );
    return bridgeOk(req.correlationId, observation);
  } catch (error) {
    return bridgeAgentRuntimeError(req, error);
  }
}

async function handleAct(req: AcrBridgeRequest): Promise<AcrBridgeResponse> {
  const readOnly = isAgentActRequestReadOnly(req.args);
  if (!readOnly && !workbenchBus.isEnabled()) {
    return bridgeGateErr(req.correlationId, gateDisabledOs());
  }
  const request = asRecord(req.args) as unknown as AgentActRequest;
  const windowId = resolveAgentRequestWindowId(request);
  // 只读 act（整批 mutates=false）不占窗口写租约：不阻塞并行的
  // mutating run / 另一路只读 act（对齐 observe/wait_for 语义）
  const startedOperation = beginManagedOperation(req, 'act', windowId, !readOnly);
  if (startedOperation.error) return startedOperation.error;
  const operation = startedOperation.operation!;
  bindRunLedgerMetadata(operation.key, {
    sessionId: req.sessionId,
    externalRunId: req.runId,
    windowId,
    requiredRisk: 'read',
  });
  try {
    const receipt = await workbenchBus.actAgent(
      request,
      agentRuntimeOptions(req, {
        withUndo: true,
        runKey: operation.key,
        signal: operation.controller.signal,
      }),
    );
    if (runLedger.hasRun(operation.key)) runLedger.sealRun(operation.key);
    else discardEmptyRunLedger(operation.key);
    return bridgeOk(req.correlationId, receipt);
  } catch (error) {
    discardEmptyRunLedger(operation.key);
    return bridgeAgentRuntimeError(req, error);
  } finally {
    finishManagedOperation(operation);
  }
}

async function handleWaitFor(req: AcrBridgeRequest): Promise<AcrBridgeResponse> {
  const request = asRecord(req.args) as unknown as AgentWaitForRequest;
  const windowId = resolveAgentRequestWindowId(request);
  const startedOperation = beginManagedOperation(req, 'wait_for', windowId, false);
  if (startedOperation.error) return startedOperation.error;
  const operation = startedOperation.operation!;
  try {
    const result = await workbenchBus.waitForAgent(
      request,
      agentRuntimeOptions(req, {
        runKey: operation.key,
        signal: operation.controller.signal,
      }),
    );
    return bridgeOk(req.correlationId, result);
  } catch (error) {
    return bridgeAgentRuntimeError(req, error);
  } finally {
    finishManagedOperation(operation);
  }
}

const STAGE_RISK_RANK: Record<AgentCapabilityRisk, number> = {
  read: 0,
  low: 1,
  medium: 2,
  high: 3,
};

function parseApprovalRiskCeiling(value: unknown): AgentCapabilityRisk {
  return value === 'read' || value === 'low' || value === 'medium' || value === 'high'
    ? value
    : 'medium';
}

async function handleRevertRun(
  req: AcrBridgeRequest,
): Promise<AcrBridgeResponse> {
  const args = asRecord(req.args);
  const undoToken = typeof args.undoToken === 'string' ? args.undoToken : '';
  const approvalRiskCeiling = parseApprovalRiskCeiling(args.approvalRiskCeiling);
  if (undoToken.startsWith('acr-undo:')) {
    const entry = getAgentUndo(undoToken);
    const windowId = entry
      ? resolveAgentRequestWindowId({
          windowId: entry.windowId,
          typeId: entry.typeId,
          instanceKey: entry.instanceKey ?? undefined,
        })
      : null;
    const startedOperation = beginManagedOperation(
      req,
      'revert_run',
      windowId,
      true,
    );
    if (startedOperation.error) return startedOperation.error;
    const operation = startedOperation.operation!;
    try {
      const result = await workbenchBus.revertAgentAction(
        undoToken,
        agentRuntimeOptions(req, {
          runKey: operation.key,
          signal: operation.controller.signal,
          approvalRiskCeiling,
        }),
      );
      return bridgeOk(req.correlationId, result);
    } catch (error) {
      return bridgeAgentRuntimeError(req, error);
    } finally {
      finishManagedOperation(operation);
    }
  }
  if (undoToken.startsWith('acr-run:')) {
    const externalRunId = undoToken.slice('acr-run:'.length);
    const ledgerKey = makeRunKey(req.sessionId, externalRunId);
    const metadata = getRunLedgerMetadata(ledgerKey);
    if (!metadata || metadata.sessionId !== req.sessionId) {
      return bridgeOk(req.correlationId, {
        reverted: false,
        undoToken,
        durability: 'session',
        message: '撤销令牌不属于当前会话或已失效',
      });
    }
    if (
      STAGE_RISK_RANK[metadata.requiredRisk]
      > STAGE_RISK_RANK[approvalRiskCeiling]
    ) {
      return bridgeOk(req.correlationId, {
        reverted: false,
        undoToken,
        durability: 'session',
        message: `撤销需要 ${metadata.requiredRisk} 风险授权，当前上限为 ${approvalRiskCeiling}`,
      });
    }
    const startedOperation = beginManagedOperation(
      req,
      'revert_run',
      metadata.windowId,
      true,
    );
    if (startedOperation.error) return startedOperation.error;
    const operation = startedOperation.operation!;
    try {
      const reverted = await runLedger.revertRun(ledgerKey);
      if (reverted) usePresenceStore.getState().clearByRun(ledgerKey);
      return bridgeOk(req.correlationId, {
        reverted,
        undoToken,
        durability: 'session',
      });
    } finally {
      finishManagedOperation(operation);
    }
  }
  const externalRunId = typeof args.runId === 'string' ? args.runId : req.runId;
  let ledgerKey = makeRunKey(req.sessionId, externalRunId);
  let metadata = getRunLedgerMetadata(ledgerKey);
  // Compatibility for local callers/tests that recorded directly before ACR3
  // session keys existed. ACR3 session tokens never use this fallback.
  if (!metadata && !runLedger.hasRun(ledgerKey) && runLedger.hasRun(externalRunId)) {
    ledgerKey = externalRunId;
    metadata = getRunLedgerMetadata(ledgerKey);
  }
  const startedOperation = beginManagedOperation(
    req,
    'revert_run',
    metadata?.windowId ?? null,
    Boolean(metadata?.windowId),
  );
  if (startedOperation.error) return startedOperation.error;
  const operation = startedOperation.operation!;
  try {
    const reverted = await runLedger.revertRun(ledgerKey);
    return bridgeOk(req.correlationId, { reverted });
  } finally {
    finishManagedOperation(operation);
  }
}

async function handleApplyOps(
  req: AcrBridgeRequest,
): Promise<AcrBridgeResponse> {
  const runKey = makeRunKey(req.sessionId, req.runId);
  const args = asRecord(req.args);
  const target = args.target as AcrTarget | undefined;
  const ops = Array.isArray(args.ops) ? (args.ops as AgentOp[]) : [];
  if (!target?.typeId) {
    return bridgeErr(
      req.correlationId,
      'INVALID_ARGS',
      'apply_ops 缺少 target.typeId',
      '请传入 { target, ops, pacing?, destructive }',
    );
  }

  const driver = drivers.get(target.typeId);
  if (!driver) {
    return bridgeErr(
      req.correlationId,
      ACR_ERROR_CODES.DRIVER_NOT_FOUND,
      `未注册 typeId=${target.typeId} 的 CollabDriver`,
      '请改用对应领域工具直写数据面，或等待该应用 Driver 就绪',
      false,
    );
  }

  const initialProbe = probeTarget(target);
  if (target.windowId && initialProbe.windowId !== target.windowId) {
    return bridgeErr(
      req.correlationId,
      'STALE_TARGET_WINDOW',
      `精确目标窗口 ${target.windowId} 已关闭、切换资源或不再匹配`,
      '重新 probe，并使用新回执的 windowId 提交 apply_ops',
      false,
    );
  }

  const notesWindow = !target.windowId
    && target.resourceId
    && (target.typeId === 'note' || target.typeId === 'mindmap')
    ? Object.values(useWindowStore.getState().windows).find(
        (window) => window.typeId === 'notes',
      )
    : undefined;
  let preparingWindowId = notesWindow?.id ?? initialProbe.windowId;
  if (!preparingWindowId && target.resourceId) {
    preparingWindowId = Object.values(useWindowStore.getState().windows).find(
      (window) => window.typeId === target.typeId
        && window.instanceKey === target.resourceId,
    )?.id ?? null;
  }

  const startedOperation = beginManagedOperation(
    req,
    'apply_ops',
    preparingWindowId,
    Boolean(preparingWindowId),
  );
  if (startedOperation.error) return startedOperation.error;
  const preparation = startedOperation.operation!;
  let promoted = false;

  try {
    if (notesWindow && target.resourceId) {
      await prepareWorkspaceResource(
        { type: target.typeId as 'note' | 'mindmap', id: target.resourceId },
        notesWindow.id,
      );
    }
    if (preparation.controller.signal.aborted) {
      return cancelledBeforeApplyReceipt(req.correlationId, ops);
    }

    // Resolve again after resource activation; probe is authoritative for the
    // exact editor/window that will receive side effects.
    const probed = probeTarget(target);
    let windowId = probed.windowId;
    if (!target.windowId && !windowId && target.resourceId) {
      const found = Object.values(useWindowStore.getState().windows).find(
        (window) => window.typeId === target.typeId
          && window.instanceKey === target.resourceId,
      );
      windowId = found?.id ?? null;
    }
    if (windowId && !useWindowStore.getState().windows[windowId]) {
      windowId = null;
    }

    const leaseError = rebindManagedOperationLease(preparation, windowId);
    if (leaseError) return leaseError;
    if (preparation.controller.signal.aborted) {
      return cancelledBeforeApplyReceipt(req.correlationId, ops);
    }

    // The lease is now held, so follow-mode focus/wake cannot perturb a winner.
    const wokenWindowId = wakeFrozenIfFollow(target, windowId);
    if (wokenWindowId !== windowId) {
      const wakeLeaseError = rebindManagedOperationLease(preparation, wokenWindowId);
      if (wakeLeaseError) return wakeLeaseError;
      windowId = wokenWindowId;
    }
    if (preparation.controller.signal.aborted) {
      return cancelledBeforeApplyReceipt(req.correlationId, ops);
    }
    if (windowId && agentControl === 'follow') {
      useWindowStore.getState().focusWindow(windowId);
    }

    const pacingName = shouldInstantDrop(windowId)
      ? 'fast'
      : parsePacing(typeof args.pacing === 'string' ? args.pacing : agentPacing);
    const pacer = createPacer(pacingName);
    const gate = applyStagingGates(pacer, windowId);

    const arbitrator = createArbitrator({
      onPauseChange: (paused, meta) => {
        usePresenceStore
          .getState()
          .updateStatus(runKey, paused ? 'pausedByUser' : 'acting');
        // ACR 4.0：pausedByUser 时写入自动中止时刻与是否可续放；恢复时清除
        usePresenceStore.getState().patchPresence(
          runKey,
          paused
            ? {
                abortDeadline: meta.abortDeadline ?? undefined,
                ...(meta.explicit ? { resumable: true } : {}),
              }
            : { abortDeadline: undefined, resumable: undefined },
        );
        if (paused) {
          emitAcrProgress(
            req.correlationId,
            0,
            ops.length,
            i18n.t('workbench:agent.core.progressPaused', {
              defaultValue: '已暂停：检测到用户输入',
            }),
            undefined,
            req.bridgeToken,
          );
        }
      },
    });

    const run: ActiveRun = {
      key: runKey,
      runId: req.runId,
      sessionId: req.sessionId,
      correlationId: req.correlationId,
      bridgeToken: req.bridgeToken,
      windowId,
      typeId: target.typeId,
      arbitrator,
      driver,
      heartbeat: null,
      pacer,
      staging: gate.staging,
      terminalReceipt: null,
      receiptRecorded: false,
      abortRequested: false,
      abortFallbackReceipt: null,
      orphanTimer: null,
      orphaned: false,
    };

    clearDoneHoldTimer(runKey);
    promoteManagedApply(preparation, run);
    promoted = true;
    bindRunLedgerMetadata(runKey, {
      sessionId: req.sessionId,
      externalRunId: req.runId,
      windowId,
      requiredRisk: 'medium',
    });

    if (windowId) {
      const previousPresence = usePresenceStore.getState().byWindow[windowId];
      if (previousPresence && previousPresence.runKey !== runKey) {
        clearDoneHoldTimer(previousPresence.runKey);
      }
      // ACR 4.0：直落原因走结构化 placementHint，由 AgentStrip（A5）i18n 渲染括注；
      // 旧的 labelExtra 中文后缀拼接已随 A5 接线移除。
      const placementHint = resolvePlacementHint(windowId, pacer, gate.reason);
      usePresenceStore.getState().setPresence({
        runKey,
        runId: req.runId,
        sessionId: req.sessionId,
        windowId,
        typeId: target.typeId,
        status: 'acting',
        label: ops[0]?.label ?? 'AI 正在操作',
        startedAt: Date.now(),
        ttlMs: PRESENCE_TTL_MS,
        ...(placementHint ? { placementHint } : {}),
      });
      requestWakePrefetch(windowId);
      reportSchedulerActivity('stream');
      startHeartbeat(run);
    }

    const runContext = {
      runId: runKey,
      externalRunId: req.runId,
      sessionId: req.sessionId,
      target: { ...target, ...(windowId ? { windowId } : {}) },
      windowId,
      pacing: pacer,
      reportProgress(
        step: number,
        total: number,
        message: string,
        entityId?: string,
      ) {
        emitAcrProgress(
          req.correlationId,
          step,
          total,
          message,
          entityId,
          req.bridgeToken,
        );
        if (message) {
          usePresenceStore.getState().updateStatus(runKey, 'acting', message);
        }
      },
      checkPaused: () => arbitrator.checkPaused(),
      ledger: {
        record(_runId, invert, label) {
          runLedger.record(runKey, invert, label);
        },
        revertRun: () => runLedger.revertRun(runKey),
        hasRun: () => runLedger.hasRun(runKey),
        sealRun: () => runLedger.sealRun(runKey),
      } satisfies RunLedger,
    };

    let receipt: AcrReceipt;
    try {
      receipt = await driver.apply(runContext, ops);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        driver.abort(runKey);
      } catch {
        /* abort 失败仍返回 failed */
      }
      receipt = failedReceipt(ops.length, `apply 异常: ${msg}`);
    } finally {
      try {
        pacer.dispose();
      } catch {
        /* ignore */
      }
      receipt = finalizeRun(run, receipt!);
    }

    return bridgeOk(req.correlationId, receipt!);
  } finally {
    if (!promoted) finishManagedOperation(preparation);
  }
}

/**
 * ACR 4.0 legacy cancel 身份收紧：
 * - 有 token 的 run 仅接受 token 完全一致的取消（Rust 正常路径，行为不变）；
 * - 无 token 的本地 run 仅接受同样无 token 的取消载荷（防止仅凭 correlationId
 *   碰撞取消他人事务）；
 * - 载荷带 sessionId 时必须与 run.sessionId 一致。
 */
function cancelIdentityMatches(
  target: { bridgeToken?: string; sessionId: string },
  payloadToken: string | undefined,
  payloadSessionId: string | undefined,
): boolean {
  const targetToken = target.bridgeToken || undefined;
  if (targetToken !== payloadToken) return false;
  if (payloadSessionId && target.sessionId !== payloadSessionId) return false;
  return true;
}

function handleCancel(payload: unknown): void {
  const record = asRecord(payload);
  const corr = typeof record.correlationId === 'string' ? record.correlationId : '';
  if (!corr) return;
  const exactKey = typeof record.sessionId === 'string' && typeof record.runId === 'string'
    ? makeRunKey(record.sessionId, record.runId)
    : null;
  const payloadToken =
    typeof record.bridgeToken === 'string' && record.bridgeToken
      ? record.bridgeToken
      : undefined;
  const payloadSessionId =
    typeof record.sessionId === 'string' && record.sessionId
      ? record.sessionId
      : undefined;
  const keys = runByCorrelation.get(corr);
  if (!keys) return;
  for (const key of keys) {
    if (exactKey && key !== exactKey) continue;
    const run = activeByRun.get(key);
    if (run) {
      if (!cancelIdentityMatches(run, payloadToken, payloadSessionId)) continue;
      requestAbort(
        run,
        i18n.t('workbench:agent.core.cancelled', { defaultValue: '已取消' }),
      );
      continue;
    }
    const operation = managedOperations.get(key);
    if (!operation) continue;
    if (!cancelIdentityMatches(operation, payloadToken, payloadSessionId)) continue;
    abortManagedOperation(operation, 'bridge cancelled');
  }
}

function handleInactiveRequest(
  req: AcrBridgeRequest,
): AcrBridgeResponse | null {
  switch (req.command) {
    case 'probe':
      return bridgeOk(req.correlationId, { state: 'disabled', windowId: null });
    case 'list_windows':
      return handleListWindows(req);
    case 'query_state':
      return handleQueryState(req);
    case 'get_capabilities':
    case 'observe':
    case 'wait_for':
      return null;
    case 'open_app':
    case 'app_command':
    case 'close_window':
    case 'apply_ops':
    case 'act':
    case 'revert_run':
      return bridgeGateErr(req.correlationId, gateDisabledOs());
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// StageManagerApi
// ---------------------------------------------------------------------------

/** R3-01：旁路 resumeRun；ACR 4.0（A8）：旁路只读 isRunActive（types.ts 冻结面未列） */
export const stageManager: StageManagerApi & {
  resumeRun(runId: string): void;
  isRunActive(runKey: string): boolean;
} = {
  registerDriver(driver) {
    drivers.set(driver.typeId, driver);
  },

  getDriver(typeId) {
    return drivers.get(typeId);
  },

  registerQueryProvider(scope, fn) {
    queryProviders.set(scope, fn);
  },

  async handleBridgeRequest(req: AcrBridgeRequest): Promise<AcrBridgeResponse> {
    try {
      const terminal = replayTerminalRun(req);
      if (terminal) return terminal;
      if (!started) {
        const inactive = handleInactiveRequest(req);
        if (inactive) return inactive;
      }
      // R2-08 / ACR 2.0：off 允许只读命令；act 按 capability.mutates 动态判定。
      const access = getAcrCommandAccess(req.command);
      const allowedWhenOff = access === 'read-only'
        || (access === 'dynamic' && isAgentActRequestReadOnly(req.args));
      // ACR 4.0 启动竞态修复：settings 尚未就绪时，mutating 请求先等首次
      // refreshSettings 完成再按真实档位裁决，而不是拿本地镜像误判。
      if (!allowedWhenOff && !controlSettingsReady && pendingSettingsRefresh) {
        try {
          await pendingSettingsRefresh;
        } catch {
          /* refreshSettings 自身不抛；保险起见沿用缓存档位 */
        }
      }
      if (agentControl === 'off' && !allowedWhenOff) {
        return bridgeGateErr(req.correlationId, gateDisabledOff());
      }
      switch (req.command) {
        case 'probe':
          return handleProbe(req);
        case 'apply_ops':
          return await runTransactionalRequest(req, () => handleApplyOps(req));
        case 'list_windows':
          return handleListWindows(req);
        case 'open_app':
          return await runTransactionalRequest(
            req,
            () => runLegacyMutation(req, () => handleOpenApp(req)),
          );
        case 'app_command':
          return await runTransactionalRequest(
            req,
            () => runLegacyMutation(req, () => handleAppCommand(req)),
          );
        case 'close_window':
          return await runTransactionalRequest(
            req,
            () => runLegacyMutation(req, () => handleCloseWindow(req)),
          );
        case 'query_state':
          return handleQueryState(req);
        case 'get_capabilities':
          return handleGetCapabilities(req);
        case 'observe':
          return await handleObserve(req);
        case 'act':
          return await runTransactionalRequest(req, () => handleAct(req));
        case 'wait_for':
          return await runTransactionalRequest(req, () => handleWaitFor(req));
        case 'revert_run':
          return await runTransactionalRequest(req, () => handleRevertRun(req));
        default:
          return bridgeErr(
            req.correlationId,
            'UNKNOWN_COMMAND',
            `未知命令: ${String((req as AcrBridgeRequest).command)}`,
            '请使用 DESIGN §2.3 列出的命令',
          );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return bridgeErr(
        req.correlationId,
        'INTERNAL',
        msg,
        'StageManager 内部异常，请改走数据面',
        true,
      );
    }
  },

  async revertRun(runId, sessionId) {
    const ledgerKey = resolveLedgerKey(runId, sessionId);
    if (!ledgerKey) return false;
    const existing = uiUndoFlights.get(ledgerKey);
    if (existing) return existing;
    const flight = (async () => {
      const metadata = getRunLedgerMetadata(ledgerKey);
      const request: AcrBridgeRequest = {
        correlationId: `ui-undo:${++uiUndoSequence}`,
        command: 'revert_run',
        args: { runId },
        timeoutMs: 0,
        runId: `ui-undo:${uiUndoSequence}:${runId}`,
        sessionId: sessionId ?? metadata?.sessionId ?? 'local-ui',
      };
      const started = beginManagedOperation(
        request,
        'revert_run',
        metadata?.windowId ?? null,
        Boolean(metadata?.windowId),
      );
      if (started.error) return false;
      const operation = started.operation!;
      clearDoneHoldTimer(ledgerKey);
      try {
        const ok = await runLedger.revertRun(ledgerKey);
        if (ok) {
          usePresenceStore.getState().clearByRun(ledgerKey);
        }
        return ok;
      } finally {
        finishManagedOperation(operation);
      }
    })().finally(() => {
      if (uiUndoFlights.get(ledgerKey) === flight) uiUndoFlights.delete(ledgerKey);
    });
    uiUndoFlights.set(ledgerKey, flight);
    return flight;
  },

  hasReversibleRun(runId, sessionId) {
    const ledgerKey = resolveLedgerKey(runId, sessionId);
    return Boolean(ledgerKey && runLedger.hasRun(ledgerKey));
  },

  /**
   * ACR 4.0（A8，旁路只读）：该 runKey 是否仍有活跃事务（apply / 语义操作）。
   * AgentStrip 在 reviewing（run 已结束、仅建议挂起）时据此禁用暂停/停止，
   * 避免按钮呈可用态却静默 no-op。不在 StageManagerApi 冻结面。
   */
  isRunActive(runKey: string): boolean {
    return hasActiveRunKey(runKey);
  },

  getDiagnostics() {
    return getDiagnosticsSnapshot();
  },

  notifyUserInput(windowId) {
    const runId = leaseByWindow.get(windowId);
    if (!runId) return;
    const run = activeByRun.get(runId);
    if (!run) return;
    run.arbitrator.onUserInput();
  },

  pauseRun(runId) {
    const run = findActiveApplyRun(runId);
    if (!run) return;
    run.arbitrator.pause();
    // 保留步骤 label；Strip 用 pausedLabel 文案
    usePresenceStore.getState().updateStatus(run.key, 'pausedByUser');
    // ACR 4.0：显式暂停可续放；已处于用户输入暂停时 onPauseChange 不会再触发，
    // 此处兜底写入 resumable 与自动中止时刻。
    usePresenceStore.getState().patchPresence(run.key, {
      resumable: true,
      abortDeadline: run.arbitrator.abortDeadline ?? undefined,
    });
  },

  /**
   * R3-01：显式续放（note hot 等待结束 / AgentStrip「继续」）；
   * 不在 StageManagerApi 冻结面，旁路扩展。ACR 4.0 核实：resume() 会释放
   * 显式暂停（explicitHold），对 pauseRun 后的续放安全；入参与 pauseRun 一致，
   * 传 presence.runKey（AgentStrip 调用方式相同）。
   */
  resumeRun(runId: string) {
    const run = findActiveApplyRun(runId);
    if (!run) return;
    run.arbitrator.resume();
    usePresenceStore.getState().updateStatus(run.key, 'acting');
    usePresenceStore.getState().patchPresence(run.key, {
      abortDeadline: undefined,
      resumable: undefined,
    });
  },

  stopRun(runId) {
    const reason = i18n.t('workbench:agent.core.stopped', { defaultValue: '已停止' });
    const run = findActiveApplyRun(runId);
    if (run) {
      requestAbort(run, reason);
      return;
    }
    for (const operation of managedOperations.values()) {
      if (operation.key === runId) {
        abortManagedOperation(operation, reason);
      }
    }
  },

  start() {
    if (started) return;
    started = true;
    lifecycleGeneration += 1;
    const generation = lifecycleGeneration;
    controlSettingsReady = false;
    pendingSettingsRefresh = refreshSettings(
      generation,
      controlSettingRevision,
      pacingSettingRevision,
    );
    void pendingSettingsRefresh;
    registerAllDrivers(stageManager);
    registerBuiltinQueryProviders(stageManager);
    unlistenCancel = hubListen(ACR_EVENT_CANCEL, handleCancel);
    startPresenceSweep();
    // R2-07：慢帧钩子可先订阅；真正 rAF 仅在活跃 run / DevPanel acquire 时启动
    unlistenPerfDegrade = subscribePerfDegrade(() => {
      degradeAllActivePacers('perfMonitor-slow-frames');
    });
    syncPerfMonitorForActiveRuns();
    // R2-09：resourceSync / 用户关窗等外部 closeWindow 时中断对应 run
    let prevWindowIds = new Set(Object.keys(useWindowStore.getState().windows));
    unlistenWindows = useWindowStore.subscribe((state) => {
      const nextIds = new Set(Object.keys(state.windows));
      for (const id of prevWindowIds) {
        if (!nextIds.has(id)) {
          abortRunForWindow(id, '窗口已关闭（资源删除或用户关窗），操作中断');
        }
      }
      prevWindowIds = nextIds;
    });
    if (typeof window !== 'undefined') {
      const onSettings = (ev: Event) => {
        const detail = (ev as CustomEvent<{ key?: string; value?: unknown }>)
          .detail;
        if (!detail?.key) return;
        if (detail.key === SETTING_AGENT_CONTROL) {
          controlSettingRevision += 1;
          // 显式设置事件即权威值：无需再等首次异步加载
          controlSettingsReady = true;
          applyAgentControlChange(
            parseAgentControlMode(
              typeof detail.value === 'string'
                ? detail.value
                : String(detail.value ?? ''),
            ),
          );
        } else if (detail.key === SETTING_AGENT_PACING) {
          pacingSettingRevision += 1;
          agentPacing = parsePacing(
            typeof detail.value === 'string'
              ? detail.value
              : String(detail.value ?? ''),
          );
        }
      };
      window.addEventListener('workbench:settings-changed', onSettings);
      unlistenSettings = () =>
        window.removeEventListener('workbench:settings-changed', onSettings);

      // R2-08：OS 模式关闭 → 活跃 run abort partial
      const onMode = (ev: Event) => {
        const enabled = Boolean(
          (ev as CustomEvent<{ enabled?: boolean }>).detail?.enabled,
        );
        if (!enabled) {
          abortAllActiveRuns(
            i18n.t('workbench:agent.errors.abortedByOsOff', {
              defaultValue: '桌面模式已关闭，操作已中止',
            }),
          );
        }
      };
      window.addEventListener('workbench:mode-changed', onMode);
      unlistenMode = () =>
        window.removeEventListener('workbench:mode-changed', onMode);
    }
  },

  stop() {
    if (!started) return;
    started = false;
    lifecycleGeneration += 1;
    controlSettingsReady = false;
    pendingSettingsRefresh = null;
    unlistenCancel?.();
    unlistenCancel = null;
    unlistenSettings?.();
    unlistenSettings = null;
    unlistenMode?.();
    unlistenMode = null;
    unlistenWindows?.();
    unlistenWindows = null;
    unlistenPerfDegrade?.();
    unlistenPerfDegrade = null;
    releasePerfMonitorOwner?.();
    releasePerfMonitorOwner = null;
    stopPresenceSweep();
    for (const runId of [...activeByRun.keys()]) {
      const run = activeByRun.get(runId);
      if (run) {
        stopHeartbeat(run);
        requestAbort(run, 'StageManager 已停止，操作中断');
        scheduleOrphanDeadline(run);
      }
    }
    for (const operation of managedOperations.values()) {
      abortManagedOperation(operation, 'StageManager 已停止，操作中断');
    }
    clearAllDoneHoldTimers();
    usePresenceStore.getState().clearAll();
    disposeAllDrivers();
    drivers.clear();
    queryProviders.clear();
  },
};

/** 仅供测试：重置 StageManager 内部状态（不触发 driver 注册） */
export function resetStageManagerForTests(): void {
  for (const runId of [...activeByRun.keys()]) {
    clearActiveRun(runId);
  }
  for (const operation of [...managedOperations.values()]) {
    finishManagedOperation(operation);
  }
  clearAllDoneHoldTimers();
  terminalRuns.clear();
  terminalRunOrder.length = 0;
  seenForwardRuns.clear();
  drivers.clear();
  queryProviders.clear();
  started = false;
  lifecycleGeneration += 1;
  controlSettingsReady = false;
  pendingSettingsRefresh = null;
  unlistenCancel?.();
  unlistenCancel = null;
  unlistenSettings?.();
  unlistenSettings = null;
  unlistenMode?.();
  unlistenMode = null;
  unlistenWindows?.();
  unlistenWindows = null;
  unlistenPerfDegrade?.();
  unlistenPerfDegrade = null;
  releasePerfMonitorOwner?.();
  releasePerfMonitorOwner = null;
  stopPresenceSweep();
  syncAgentControl('background');
  agentPacing = 'normal';
  usePresenceStore.getState().clearAll();
}

/** 仅供测试：覆盖控制档（follow / background / off）；视为已就绪的权威值 */
export function setAgentControlForTests(mode: AgentControlMode): void {
  // bump revision：防止 start() 发起的异步 refreshSettings 回写覆盖测试档位
  controlSettingRevision += 1;
  syncAgentControl(mode);
  controlSettingsReady = true;
}
