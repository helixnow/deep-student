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
import { hubListen } from '../core/eventHub';
import { subscribePerfDegrade, acquirePerfMonitor } from '../core/perfMonitor';
import {
  reportSchedulerActivity,
  requestWakePrefetch,
} from '../core/scheduler';
import { getSortedWindows } from '../core/windowListCache';
import { useWindowStore } from '../core/windowStore';
import { workbenchBus } from '../core/workbenchBus';
import type { DisplayMode } from '../core/types';
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
  isCommandAllowedWhenOff,
  parseAgentControlMode,
  setAgentControlMode,
  type AgentControlMode,
  type GateErrorParts,
} from './gates';
import { runLedger } from './ledger';
import { createPacer, forcePacerInstant } from './pacing';
import { isPresenceExpired, usePresenceStore } from './presenceStore';
import { probeTarget } from './probe';
import { registerBuiltinQueryProviders } from './queryProviders';
import type {
  AcrBridgeRequest,
  AcrBridgeResponse,
  AcrReceipt,
  AcrTarget,
  AgentOp,
  CollabDriver,
  Pacer,
  PacingProfileName,
  StageManagerApi,
  WindowSummary,
} from './types';
import { ACR_ERROR_CODES, ACR_EVENT_CANCEL } from './types';

// ---------------------------------------------------------------------------
// 常量与设置
// ---------------------------------------------------------------------------

/** presence TTL；心跳每 HEARTBEAT_MS 续期（DESIGN §4.1 / R2-06） */
export const PRESENCE_TTL_MS = 8000;
export const HEARTBEAT_MS = 3000;
/** R2-06：过期 presence 自愈扫描周期 */
export const PRESENCE_SWEEP_MS = 2000;
/** stop 后等待当前 op 自然结算的上限；超时转为明确 orphan partial。 */
export const ORPHAN_DRAIN_MS = 15_000;
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
  'mindmap',
]);

/** 本地镜像；真相源在 gates.getAgentControlMode() */
let agentControl: AgentControlMode = 'off';
let agentPacing: PacingProfileName = 'normal';

function parsePacing(raw: string | null | undefined): PacingProfileName {
  if (raw === 'fast' || raw === 'normal' || raw === 'demo') return raw;
  return 'normal';
}

function syncAgentControl(mode: AgentControlMode): void {
  agentControl = mode;
  setAgentControlMode(mode);
}

async function refreshSettings(): Promise<void> {
  try {
    const [control, pacing] = await Promise.all([
      getSetting(SETTING_AGENT_CONTROL),
      getSetting(SETTING_AGENT_PACING),
    ]);
    syncAgentControl(parseAgentControlMode(control));
    agentPacing = parsePacing(pacing);
  } catch {
    /* 读设置失败保持当前缓存 */
  }
}

// ---------------------------------------------------------------------------
// 注册表与活跃 run
// ---------------------------------------------------------------------------

const drivers = new Map<string, CollabDriver>();
const queryProviders = new Map<string, (args: unknown) => unknown>();

interface ActiveRun {
  runId: string;
  correlationId: string;
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
}

/** runId → 活跃 run */
const activeByRun = new Map<string, ActiveRun>();
/** windowId → runId（租约；仅非空 windowId） */
const leaseByWindow = new Map<string, string>();
/** correlationId → runId（取消传播） */
const runByCorrelation = new Map<string, string>();

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

function syncPerfMonitorForActiveRuns(): void {
  if (activeByRun.size > 0) {
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

// ---------------------------------------------------------------------------
// presence / 心跳
// ---------------------------------------------------------------------------

function startHeartbeat(run: ActiveRun): void {
  stopHeartbeat(run);
  if (!run.windowId) return;
  const windowId = run.windowId;
  run.heartbeat = setInterval(() => {
    usePresenceStore.getState().renew(run.runId);
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

function clearDoneHoldTimer(runId: string): void {
  const t = doneHoldTimers.get(runId);
  if (t != null) {
    clearTimeout(t);
    doneHoldTimers.delete(runId);
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
}

function clearActiveRun(
  runId: string,
  opts?: { retainPresenceMs?: number; expectedRun?: ActiveRun },
): void {
  const run = activeByRun.get(runId);
  if (!run || (opts?.expectedRun && run !== opts.expectedRun)) return;
  stopHeartbeat(run);
  clearOrphanTimer(run);
  run.arbitrator.dispose();
  if (run.windowId && leaseByWindow.get(run.windowId) === runId) {
    leaseByWindow.delete(run.windowId);
  }
  if (runByCorrelation.get(run.correlationId) === runId) {
    runByCorrelation.delete(run.correlationId);
  }
  activeByRun.delete(runId);
  syncPerfMonitorForActiveRuns();

  const retainMs = opts?.retainPresenceMs ?? 0;
  clearDoneHoldTimer(runId);
  if (retainMs > 0) {
    // 租约已释放，仅保留光环/Strip 供撤销；TTL 心跳已停，用短时定时器清
    const timer = setTimeout(() => {
      doneHoldTimers.delete(runId);
      usePresenceStore.getState().clearByRun(runId);
    }, retainMs);
    doneHoldTimers.set(runId, timer);
  } else {
    usePresenceStore.getState().clearByRun(runId);
  }
}

function finalizeRun(run: ActiveRun, receipt: AcrReceipt): AcrReceipt {
  if (!run.terminalReceipt) run.terminalReceipt = receipt;
  const authoritative = run.terminalReceipt;
  recordTerminalReceipt(run, authoritative);
  runLedger.sealRun(run.runId);

  if (activeByRun.get(run.runId) === run) {
    const status = run.windowId
      ? usePresenceStore.getState().byWindow[run.windowId]?.status
      : undefined;
    const terminalAborted = authoritative.status !== 'completed';
    if (
      status === 'pausedByUser' ||
      status === 'acting' ||
      status === 'reviewing'
    ) {
      usePresenceStore
        .getState()
        .updateStatus(run.runId, terminalAborted ? 'aborted' : 'done');
    }
    const retainPresenceMs =
      authoritative.status === 'completed' || authoritative.status === 'partial'
        ? DONE_PRESENCE_HOLD_MS
        : 0;
    clearActiveRun(run.runId, { retainPresenceMs, expectedRun: run });
  }
  return authoritative;
}

function requestAbort(run: ActiveRun, reasonLabel: string): AcrReceipt | null {
  if (run.abortRequested) return run.abortFallbackReceipt;
  run.abortRequested = true;
  run.arbitrator.stop();
  try {
    run.abortFallbackReceipt = run.driver.abort(run.runId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    run.abortFallbackReceipt = failedReceipt(0, `abort 异常: ${message}`);
  }
  usePresenceStore.getState().updateStatus(run.runId, 'aborted', reasonLabel);
  return run.abortFallbackReceipt;
}

function scheduleOrphanDeadline(run: ActiveRun): void {
  if (run.orphanTimer != null || run.terminalReceipt) return;
  run.orphanTimer = setTimeout(() => {
    run.orphanTimer = null;
    if (activeByRun.get(run.runId) !== run || run.terminalReceipt) return;
    const snapshot = run.abortFallbackReceipt;
    finalizeRun(run, {
      status: 'partial',
      mode: snapshot?.mode ?? 'frontend',
      applied: snapshot?.applied ?? 0,
      totalOps: snapshot?.totalOps ?? 0,
      entityIds: snapshot?.entityIds ?? [],
      done: snapshot?.done ?? [],
      undone: snapshot?.undone?.length
        ? snapshot.undone
        : ['StageManager 停止后当前操作未在期限内结算'],
      message:
        'StageManager 停止后 15 秒仍未结算，已按 orphan partial 封账并释放租约',
    });
  }, ORPHAN_DRAIN_MS);
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
    const run = activeByRun.get(p.runId);
    if (run) {
      stopHeartbeat(run);
      requestAbort(run, '操作心跳超时，已中止');
    } else {
      usePresenceStore.getState().clearByRun(p.runId);
      if (p.windowId && leaseByWindow.get(p.windowId) === p.runId) {
        leaseByWindow.delete(p.windowId);
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

/**
 * 目标窗已关闭或即将关闭时中断活跃 run（R2-09）。
 * 不在此处 clearActiveRun：等 apply 的 finally 统一清理，避免竞态双清。
 */
function abortRunForWindow(windowId: string, reason: string): void {
  const runId = leaseByWindow.get(windowId);
  if (!runId) return;
  const run = activeByRun.get(runId);
  if (!run) return;
  requestAbort(run, reason);
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
  return bridgeOk(req.correlationId, {
    handled,
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
    return bridgeOk(req.correlationId, {
      handled: true,
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
    return bridgeOk(req.correlationId, {
      handled: true,
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
  return bridgeOk(req.correlationId, {
    handled: true,
    windowId,
    minimized: after?.minimized ?? before.minimized,
    displayMode: after?.displayMode ?? before.displayMode,
    focused:
      useWindowStore.getState().focusStack.at(-1) === windowId &&
      !(after?.minimized ?? before.minimized),
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

async function handleRevertRun(
  req: AcrBridgeRequest,
): Promise<AcrBridgeResponse> {
  const args = asRecord(req.args);
  const runId = typeof args.runId === 'string' ? args.runId : req.runId;
  const reverted = await runLedger.revertRun(runId);
  return bridgeOk(req.correlationId, { reverted });
}

async function handleApplyOps(
  req: AcrBridgeRequest,
): Promise<AcrBridgeResponse> {
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

  if (activeByRun.has(req.runId)) {
    return bridgeErr(
      req.correlationId,
      'DUPLICATE_RUN_ID',
      `runId ${req.runId} 已在执行`,
      '请为新的 apply_ops 请求生成唯一 runId',
      false,
    );
  }
  if (runByCorrelation.has(req.correlationId)) {
    return bridgeErr(
      req.correlationId,
      'DUPLICATE_CORRELATION_ID',
      `correlationId ${req.correlationId} 已在执行`,
      '请为新的桥请求生成唯一 correlationId',
      false,
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

  if (
    target.resourceId &&
    (target.typeId === 'note' || target.typeId === 'mindmap')
  ) {
    const notesWindow = Object.values(useWindowStore.getState().windows).find(
      (window) => window.typeId === 'notes',
    );
    if (notesWindow) {
      await prepareWorkspaceResource(
        { type: target.typeId, id: target.resourceId },
        notesWindow.id,
      );
    }
  }

  // 解析目标窗：优先 probe，其次按 typeId+resourceId 查找
  const probed = probeTarget(target);
  let windowId = probed.windowId;
  if (!windowId && target.resourceId) {
    const found = Object.values(useWindowStore.getState().windows).find(
      (w) => w.typeId === target.typeId && w.instanceKey === target.resourceId,
    );
    windowId = found?.id ?? null;
  }

  // R2-09 / DESIGN §6：follow 档对 frozen 先 focus 唤醒再委托
  windowId = wakeFrozenIfFollow(target, windowId);

  // 快照恢复后旧 windowId 可能已失效：以当前 store 为准再校验一次
  if (windowId && !useWindowStore.getState().windows[windowId]) {
    windowId = null;
  }

  // follow：自动聚焦目标窗（background 不抢焦点）
  if (windowId && agentControl === 'follow') {
    useWindowStore.getState().focusWindow(windowId);
  }

  if (windowId && leaseByWindow.has(windowId)) {
    return bridgeErr(
      req.correlationId,
      ACR_ERROR_CODES.WINDOW_BUSY,
      `窗口 ${windowId} 已有活跃 agent run`,
      '请等待当前操作完成，或先取消/停止后再试',
      true,
    );
  }

  // DESIGN §4.3：最小化 / background / frozen 直落；同时演出 ≤2，超限亦直落
  const pacingName = shouldInstantDrop(windowId)
    ? 'fast'
    : parsePacing(typeof args.pacing === 'string' ? args.pacing : agentPacing);
  const pacer = createPacer(pacingName);
  const gate = applyStagingGates(pacer, windowId);

  const arbitrator = createArbitrator({
    onPauseChange: (paused) => {
      // R3-03：勿覆盖 presence.label（AgentStrip 用 pausedLabel 模板包一层）
      usePresenceStore
        .getState()
        .updateStatus(req.runId, paused ? 'pausedByUser' : 'acting');
      if (paused) {
        emitAcrProgress(
          req.correlationId,
          0,
          ops.length,
          i18n.t('workbench:agent.core.progressPaused', {
            defaultValue: '已暂停：检测到用户输入',
          }),
        );
      }
    },
  });

  const run: ActiveRun = {
    runId: req.runId,
    correlationId: req.correlationId,
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
  };

  clearDoneHoldTimer(req.runId);
  activeByRun.set(req.runId, run);
  runByCorrelation.set(req.correlationId, req.runId);
  if (windowId) leaseByWindow.set(windowId, req.runId);
  syncPerfMonitorForActiveRuns();

  if (windowId) {
    // 同一窗口只能展示一个 terminal presence；新 run 覆盖旧展示时同步取消旧计时器，
    // 避免高频串行 run 在 4 秒保留窗内堆积大量无效 timer。
    const previousPresence = usePresenceStore.getState().byWindow[windowId];
    if (previousPresence && previousPresence.runId !== req.runId) {
      clearDoneHoldTimer(previousPresence.runId);
    }
    const labelExtra =
      gate.reason === 'max-staged'
        ? '（演出槽满，直落）'
        : pacer.profile.instant && shouldInstantDrop(windowId)
          ? '（后台直落）'
          : '';
    usePresenceStore.getState().setPresence({
      runId: req.runId,
      windowId,
      typeId: target.typeId,
      status: 'acting',
      label: `${ops[0]?.label ?? 'AI 正在操作'}${labelExtra}`,
      startedAt: Date.now(),
      ttlMs: PRESENCE_TTL_MS,
    });
    requestWakePrefetch(windowId);
    reportSchedulerActivity('stream');
    startHeartbeat(run);
  }

  const runContext = {
    runId: req.runId,
    sessionId: req.sessionId,
    target,
    windowId,
    pacing: pacer,
    reportProgress(
      step: number,
      total: number,
      message: string,
      entityId?: string,
    ) {
      emitAcrProgress(req.correlationId, step, total, message, entityId);
      if (message) {
        usePresenceStore.getState().updateStatus(req.runId, 'acting', message);
      }
    },
    checkPaused: () => arbitrator.checkPaused(),
    ledger: runLedger,
  };

  let receipt: AcrReceipt;
  try {
    receipt = await driver.apply(runContext, ops);
  } catch (err) {
    // R3-04：apply 抛异常必须收敛为 failed（勿沿用 abort 的 cancelled），并 best-effort 停驱动
    const msg = err instanceof Error ? err.message : String(err);
    try {
      driver.abort(req.runId);
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
}

function handleCancel(payload: unknown): void {
  const corr =
    payload && typeof payload === 'object' && 'correlationId' in payload
      ? String((payload as { correlationId: unknown }).correlationId)
      : '';
  if (!corr) return;
  const runId = runByCorrelation.get(corr);
  if (!runId) return;
  const run = activeByRun.get(runId);
  if (!run) return;
  requestAbort(
    run,
    i18n.t('workbench:agent.core.cancelled', { defaultValue: '已取消' }),
  );
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
    case 'open_app':
    case 'app_command':
    case 'close_window':
    case 'apply_ops':
    case 'revert_run':
      return bridgeGateErr(req.correlationId, gateDisabledOs());
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// StageManagerApi
// ---------------------------------------------------------------------------

/** R3-01：旁路 resumeRun（types.ts 冻结面未列） */
export const stageManager: StageManagerApi & {
  resumeRun(runId: string): void;
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
      if (!started) {
        const inactive = handleInactiveRequest(req);
        if (inactive) return inactive;
      }
      // R2-08：off = list/query/probe 只读允许；写与导航拒绝
      if (agentControl === 'off' && !isCommandAllowedWhenOff(req.command)) {
        return bridgeGateErr(req.correlationId, gateDisabledOff());
      }
      switch (req.command) {
        case 'probe':
          return handleProbe(req);
        case 'apply_ops':
          return await handleApplyOps(req);
        case 'list_windows':
          return handleListWindows(req);
        case 'open_app':
          return handleOpenApp(req);
        case 'app_command':
          return await handleAppCommand(req);
        case 'close_window':
          return await handleCloseWindow(req);
        case 'query_state':
          return handleQueryState(req);
        case 'revert_run':
          return await handleRevertRun(req);
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

  async revertRun(runId) {
    clearDoneHoldTimer(runId);
    const ok = await runLedger.revertRun(runId);
    if (ok) {
      usePresenceStore.getState().clearByRun(runId);
    }
    return ok;
  },

  notifyUserInput(windowId) {
    const runId = leaseByWindow.get(windowId);
    if (!runId) return;
    const run = activeByRun.get(runId);
    if (!run) return;
    run.arbitrator.onUserInput();
  },

  pauseRun(runId) {
    const run = activeByRun.get(runId);
    if (!run) return;
    run.arbitrator.pause();
    // 保留步骤 label；Strip 用 pausedLabel 文案
    usePresenceStore.getState().updateStatus(runId, 'pausedByUser');
  },

  /** R3-01：显式续放（note hot 等待结束）；不在 StageManagerApi 冻结面，旁路扩展 */
  resumeRun(runId: string) {
    const run = activeByRun.get(runId);
    if (!run) return;
    run.arbitrator.resume();
    usePresenceStore.getState().updateStatus(runId, 'acting');
  },

  stopRun(runId) {
    const run = activeByRun.get(runId);
    if (!run) return;
    requestAbort(
      run,
      i18n.t('workbench:agent.core.stopped', { defaultValue: '已停止' }),
    );
  },

  start() {
    if (started) return;
    started = true;
    void refreshSettings();
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
          applyAgentControlChange(
            parseAgentControlMode(
              typeof detail.value === 'string'
                ? detail.value
                : String(detail.value ?? ''),
            ),
          );
        } else if (detail.key === SETTING_AGENT_PACING) {
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
  clearAllDoneHoldTimers();
  drivers.clear();
  queryProviders.clear();
  started = false;
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

/** 仅供测试：覆盖控制档（follow / background / off） */
export function setAgentControlForTests(mode: AgentControlMode): void {
  syncAgentControl(mode);
}
