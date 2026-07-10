/**
 * interactionTrace — OS 模式交互级延迟时间线（拖/缩/吸附 settle）
 *
 * 与 perfMonitor（全局帧）互补：回答「起拖各阶段各花多少 / 跟手掉帧 /
 * longtask 占比 / 内容冻结是否命中」，而不只是一个 avg。
 *
 * 可读出口：
 * 1. globalThis.__WB_INTERACTION_TRACE__
 * 2. DEV POST → `.tmp/wb-interaction-trace.json`
 * 3. console `[WB_TRACE]` 摘要（含 costs 占比）
 */
import { summarizeFrameDeltas, type PerfFrameStats } from './perfMonitor';

export type InteractionKind = 'drag' | 'resize' | 'snap.settle';

/** 相对 startedAt 的 mark（ms）；同名只记首次 */
export interface InteractionMarkMap {
  /** pointerdown / beginInteraction */
  arm?: number;
  /** data-wb-dragging 已挂 */
  flagSet?: number;
  /** ensureLayoutFrame 完成 */
  layoutAnchor?: number;
  /** wb-shell-dragging|resizing class 已挂 */
  shellClass?: number;
  /** beginShellGesture 同步段结束 */
  armed?: number;
  /** 内容冻结（display:none / 截图）生效 */
  contentFreeze?: number;
  /** 首个 translate3d / 布局跟手 */
  firstMove?: number;
  /** 松手 / settle 结束 */
  end?: number;
}

export interface InteractionLongTaskEntry {
  /** 相对 startedAt */
  atMs: number;
  durationMs: number;
  name?: string;
}

export interface InteractionFrameBuckets {
  /** <8.3ms (~120fps+) */
  lt8: number;
  /** 8.3–16.7ms */
  lt17: number;
  /** 16.7–33.3ms */
  lt33: number;
  /** 33.3–50ms */
  lt50: number;
  /** ≥50ms */
  gte50: number;
}

export interface InteractionCosts {
  /** begin 路径同步分段耗时（ms） */
  syncPhases: Record<string, number>;
  /** PerformanceObserver longtask（手势期内） */
  longTasks: {
    count: number;
    totalMs: number;
    maxMs: number;
    /** 占 totalMs 的百分比 */
    shareOfTotalPct?: number;
    entries: InteractionLongTaskEntry[];
  };
  /** 跟手帧分桶 + p95 */
  frames?: {
    buckets: InteractionFrameBuckets;
    p50Ms?: number;
    p95Ms?: number;
  };
  /** 内容冻结策略结果 */
  freeze?: {
    applied: boolean;
    reason: string;
    snapshotHit: boolean;
    atMs?: number;
    liveProbeFrames?: number;
  };
}

export interface InteractionSession {
  id: string;
  kind: InteractionKind;
  windowId?: string;
  startedAt: number;
  endedAt?: number;
  marks: InteractionMarkMap;
  measures: {
    armToFirstMoveMs?: number;
    armToFreezeMs?: number;
    armedMs?: number;
    totalMs?: number;
  };
  frame?: PerfFrameStats;
  costs?: InteractionCosts;
  meta?: Record<string, unknown>;
}

export type InteractionTraceListener = (sessions: readonly InteractionSession[]) => void;

export const INTERACTION_TRACE_MAX_SESSIONS = 40;
export const INTERACTION_TRACE_DUMP_PATH = '.tmp/wb-interaction-trace.json';
export const INTERACTION_TRACE_HTTP_PATH = '/__wb_interaction_trace';
export const INTERACTION_TRACE_MAX_LONGTASKS = 40;

const BRIDGE_KEY = '__WB_INTERACTION_TRACE__';

function nowTs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function isDevBuild(): boolean {
  try {
    return Boolean(import.meta.env?.DEV);
  } catch {
    return false;
  }
}

function emptyCosts(): InteractionCosts {
  return {
    syncPhases: {},
    longTasks: { count: 0, totalMs: 0, maxMs: 0, entries: [] },
  };
}

function ensureCosts(session: InteractionSession): InteractionCosts {
  if (!session.costs) session.costs = emptyCosts();
  return session.costs;
}

function percentile(sortedAsc: number[], p: number): number | undefined {
  if (sortedAsc.length === 0) return undefined;
  const i = (sortedAsc.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return round1(sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (i - lo));
}

function bucketFrames(deltas: readonly number[]): InteractionFrameBuckets {
  const buckets: InteractionFrameBuckets = { lt8: 0, lt17: 0, lt33: 0, lt50: 0, gte50: 0 };
  for (const d of deltas) {
    if (d < 8.3) buckets.lt8 += 1;
    else if (d < 16.7) buckets.lt17 += 1;
    else if (d < 33.3) buckets.lt33 += 1;
    else if (d < 50) buckets.lt50 += 1;
    else buckets.gte50 += 1;
  }
  return buckets;
}

// ============================================================================
// 单例状态
// ============================================================================

let enabled = isDevBuild();
let ownerCount = 0;
let seq = 0;
let active: InteractionSession | null = null;
const sessions: InteractionSession[] = [];
const listeners = new Set<InteractionTraceListener>();

let frameDeltas: number[] = [];
let frameRaf: number | ReturnType<typeof setTimeout> = 0;
let lastFrameTs = 0;
let consoleLog = isDevBuild();
let persistScheduled = false;
let longTaskObserver: PerformanceObserver | null = null;

const requestFrame: (cb: () => void) => number | ReturnType<typeof setTimeout> =
  typeof requestAnimationFrame === 'function'
    ? (cb) => requestAnimationFrame(() => cb())
    : (cb) => setTimeout(cb, 16);

const cancelFrame: (handle: number | ReturnType<typeof setTimeout>) => void =
  typeof cancelAnimationFrame === 'function'
    ? (handle) => cancelAnimationFrame(handle as number)
    : (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>);

function notify(): void {
  const snapshot = sessions.slice();
  for (const listener of [...listeners]) {
    try {
      listener(snapshot);
    } catch {
      /* 订阅方异常不拖垮采集 */
    }
  }
}

function stopLongTaskObserver(): void {
  if (longTaskObserver) {
    try {
      longTaskObserver.disconnect();
    } catch {
      /* ignore */
    }
    longTaskObserver = null;
  }
}

function startLongTaskObserver(session: InteractionSession): void {
  stopLongTaskObserver();
  if (typeof PerformanceObserver !== 'function') return;
  try {
    const supported =
      typeof PerformanceObserver.supportedEntryTypes !== 'undefined'
        ? PerformanceObserver.supportedEntryTypes
        : null;
    if (supported && !supported.includes('longtask')) return;
    longTaskObserver = new PerformanceObserver((list) => {
      if (!active || active !== session) return;
      const costs = ensureCosts(session);
      for (const entry of list.getEntries()) {
        const duration = round1(entry.duration);
        const atMs = round1(entry.startTime - session.startedAt);
        costs.longTasks.count += 1;
        costs.longTasks.totalMs = round1(costs.longTasks.totalMs + duration);
        if (duration > costs.longTasks.maxMs) costs.longTasks.maxMs = duration;
        if (costs.longTasks.entries.length < INTERACTION_TRACE_MAX_LONGTASKS) {
          costs.longTasks.entries.push({
            atMs,
            durationMs: duration,
            name: entry.name || undefined,
          });
        }
      }
    });
    longTaskObserver.observe({ entryTypes: ['longtask'] });
  } catch {
    longTaskObserver = null;
  }
}

function stopFrameSample(): PerfFrameStats | undefined {
  if (frameRaf) {
    cancelFrame(frameRaf);
    frameRaf = 0;
  }
  const stats = frameDeltas.length > 0 ? summarizeFrameDeltas(frameDeltas) : undefined;
  return stats;
}

function startFrameSample(): void {
  if (frameRaf) {
    cancelFrame(frameRaf);
    frameRaf = 0;
  }
  frameDeltas = [];
  lastFrameTs = nowTs();
  const tick = () => {
    if (!active || !enabled) return;
    const ts = nowTs();
    frameDeltas.push(ts - lastFrameTs);
    lastFrameTs = ts;
    frameRaf = requestFrame(tick);
  };
  frameRaf = requestFrame(tick);
}

function finalizeCosts(session: InteractionSession): void {
  const costs = ensureCosts(session);
  const total = session.measures.totalMs ?? 0;
  if (total > 0 && costs.longTasks.totalMs > 0) {
    costs.longTasks.shareOfTotalPct = round1((costs.longTasks.totalMs / total) * 100);
  }
  if (frameDeltas.length > 0) {
    const sorted = [...frameDeltas].sort((a, b) => a - b);
    costs.frames = {
      buckets: bucketFrames(frameDeltas),
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
    };
  }
  // 派生 mark 间距，便于看起拖哪一段贵
  const m = session.marks;
  if (m.flagSet != null) costs.syncPhases.flagSetAt = m.flagSet;
  if (m.layoutAnchor != null) costs.syncPhases.layoutAnchorAt = m.layoutAnchor;
  if (m.shellClass != null) costs.syncPhases.shellClassAt = m.shellClass;
  if (m.armed != null) {
    costs.syncPhases.armedAt = m.armed;
    session.measures.armedMs = m.armed;
  }
  if (m.contentFreeze != null && m.arm != null) {
    session.measures.armToFreezeMs = round1(m.contentFreeze - m.arm);
  }
}

function formatCostsLine(session: InteractionSession): string | null {
  const c = session.costs;
  if (!c) return null;
  const parts: string[] = [];
  const syncKeys = Object.keys(c.syncPhases).filter((k) => k.endsWith('Ms'));
  if (syncKeys.length > 0) {
    parts.push(`sync=${syncKeys.map((k) => `${k.replace(/Ms$/, '')}:${c.syncPhases[k]}`).join(',')}`);
  }
  if (c.longTasks.count > 0) {
    parts.push(
      `lt=${c.longTasks.count}/${c.longTasks.totalMs}ms` +
        (c.longTasks.shareOfTotalPct != null ? `(${c.longTasks.shareOfTotalPct}%)` : '') +
        ` max${c.longTasks.maxMs}`,
    );
  }
  if (c.frames) {
    const b = c.frames.buckets;
    parts.push(`buckets=<8:${b.lt8} <17:${b.lt17} <33:${b.lt33} <50:${b.lt50} ≥50:${b.gte50}`);
    if (c.frames.p95Ms != null) parts.push(`p95=${c.frames.p95Ms}`);
  }
  if (c.freeze) {
    parts.push(
      `freeze=${c.freeze.applied ? 'on' : 'off'}/${c.freeze.reason}` +
        (c.freeze.snapshotHit ? '+snap' : '') +
        (c.freeze.liveProbeFrames != null ? ` live${c.freeze.liveProbeFrames}f` : ''),
    );
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

function pushSession(session: InteractionSession): void {
  sessions.push(session);
  while (sessions.length > INTERACTION_TRACE_MAX_SESSIONS) {
    sessions.shift();
  }
  notify();
  schedulePersist();
  if (consoleLog) {
    const m = session.measures;
    const f = session.frame;
    const parts = [
      `[WB_TRACE]`,
      session.kind,
      session.windowId ? `win=${session.windowId.slice(0, 8)}` : null,
      typeof session.meta?.typeId === 'string' ? `type=${session.meta.typeId}` : null,
      m.armToFirstMoveMs != null ? `arm→move=${m.armToFirstMoveMs}ms` : 'arm→move=—',
      m.armedMs != null ? `armed=${m.armedMs}ms` : null,
      m.armToFreezeMs != null ? `arm→freeze=${m.armToFreezeMs}ms` : null,
      m.totalMs != null ? `total=${m.totalMs}ms` : null,
      f
        ? `frames=${f.sampledFrames} avg=${f.avgFrameMs} max=${f.maxFrameMs} drop=${f.droppedFrames}`
        : null,
      formatCostsLine(session),
    ].filter(Boolean);
    // eslint-disable-next-line no-console
    console.info(parts.join(' '));
  }
}

function buildExportPayload(): string {
  return JSON.stringify(
    {
      updatedAt: new Date().toISOString(),
      path: INTERACTION_TRACE_DUMP_PATH,
      enabled,
      schema: 'interactionTrace.v2',
      active: active
        ? {
            id: active.id,
            kind: active.kind,
            windowId: active.windowId,
            startedAt: active.startedAt,
            marks: active.marks,
            costs: active.costs,
            meta: active.meta,
          }
        : null,
      sessions: sessions.slice(),
    },
    null,
    2,
  );
}

function schedulePersist(): void {
  if (!enabled || !isDevBuild() || persistScheduled) return;
  persistScheduled = true;
  const run = () => {
    persistScheduled = false;
    void persistInteractionTrace();
  };
  if (typeof queueMicrotask === 'function') queueMicrotask(run);
  else setTimeout(run, 0);
}

export async function persistInteractionTrace(): Promise<boolean> {
  if (!isDevBuild()) return false;
  const body = buildExportPayload();
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(BRIDGE_KEY, body);
    }
  } catch {
    /* quota */
  }
  try {
    if (typeof fetch !== 'function') return false;
    const res = await fetch(INTERACTION_TRACE_HTTP_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function isInteractionTraceEnabled(): boolean {
  return enabled;
}

export function enableInteractionTrace(): void {
  enabled = true;
  installInteractionTraceBridge();
}

export function disableInteractionTrace(): void {
  if (ownerCount > 0) return;
  enabled = false;
  if (active) endInteraction({ aborted: true });
}

export function acquireInteractionTrace(): () => void {
  ownerCount += 1;
  enabled = true;
  installInteractionTraceBridge();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    ownerCount = Math.max(0, ownerCount - 1);
    if (ownerCount === 0 && !isDevBuild()) {
      enabled = false;
      if (active) endInteraction({ aborted: true });
    }
  };
}

export function beginInteraction(input: {
  kind: InteractionKind;
  windowId?: string;
  meta?: Record<string, unknown>;
}): string | null {
  if (!enabled) return null;
  if (active) endInteraction({ superseded: true });
  seq += 1;
  const startedAt = nowTs();
  active = {
    id: `ix_${seq}_${Math.round(startedAt)}`,
    kind: input.kind,
    windowId: input.windowId,
    startedAt,
    marks: { arm: 0 },
    measures: {},
    costs: emptyCosts(),
    meta: input.meta,
  };
  startLongTaskObserver(active);
  if (input.kind === 'snap.settle') {
    startFrameSample();
  }
  notify();
  return active.id;
}

/** 在当前会话上打 mark（相对 startedAt）；同名只记首次 */
export function markInteraction(name: keyof InteractionMarkMap): void {
  if (!enabled || !active) return;
  if (active.marks[name] != null) return;
  active.marks[name] = round1(nowTs() - active.startedAt);
  if (name === 'firstMove' && active.marks.arm != null) {
    active.measures.armToFirstMoveMs = round1(active.marks.firstMove! - active.marks.arm);
    if (frameRaf === 0 && frameDeltas.length === 0) {
      startFrameSample();
    }
  }
  notify();
}

/**
 * 测量同步分段耗时，写入 costs.syncPhases[nameMs]，并可选打同名 mark。
 * 用于 beginShellGesture 内部分解（flag / layout / class）。
 */
export function timeInteractionPhase<T>(name: string, fn: () => T, alsoMark?: keyof InteractionMarkMap): T {
  const t0 = nowTs();
  try {
    return fn();
  } finally {
    if (enabled && active) {
      const ms = round1(nowTs() - t0);
      ensureCosts(active).syncPhases[`${name}Ms`] = ms;
      if (alsoMark) markInteraction(alsoMark);
    }
  }
}

/** 合并 meta / costs.freeze 等诊断字段（跟手期可多次调用） */
export function patchInteractionMeta(patch: Record<string, unknown>): void {
  if (!enabled || !active) return;
  active.meta = { ...active.meta, ...patch };
  const freeze = patch.freeze;
  if (freeze && typeof freeze === 'object') {
    ensureCosts(active).freeze = freeze as InteractionCosts['freeze'];
  }
  notify();
}

export function recordInteractionFreeze(info: NonNullable<InteractionCosts['freeze']>): void {
  if (!enabled || !active) return;
  ensureCosts(active).freeze = info;
  if (info.applied && info.atMs == null) {
    markInteraction('contentFreeze');
    info.atMs = active.marks.contentFreeze;
  } else if (info.applied) {
    markInteraction('contentFreeze');
  }
  active.meta = { ...active.meta, freeze: info };
  notify();
}

export function endInteraction(meta?: Record<string, unknown>): InteractionSession | null {
  if (!active) return null;
  const session = active;
  active = null;
  stopLongTaskObserver();
  const endRel = round1(nowTs() - session.startedAt);
  session.marks.end = endRel;
  session.endedAt = session.startedAt + endRel;
  session.measures.totalMs = endRel;
  if (session.marks.firstMove != null && session.measures.armToFirstMoveMs == null) {
    session.measures.armToFirstMoveMs = round1(session.marks.firstMove - (session.marks.arm ?? 0));
  }
  session.frame = stopFrameSample();
  if (meta && Object.keys(meta).length > 0) {
    session.meta = { ...session.meta, ...meta };
  }
  finalizeCosts(session);
  frameDeltas = [];
  lastFrameTs = 0;
  if (meta?.superseded && endRel < 2) {
    notify();
    return session;
  }
  pushSession(session);
  return session;
}

export function getActiveInteraction(): InteractionSession | null {
  return active;
}

export function getRecentInteractions(limit = INTERACTION_TRACE_MAX_SESSIONS): InteractionSession[] {
  if (limit >= sessions.length) return sessions.slice();
  return sessions.slice(-limit);
}

export function exportInteractionTraceJson(): string {
  return buildExportPayload();
}

export function clearInteractionTrace(): void {
  if (active) endInteraction({ cleared: true });
  sessions.length = 0;
  notify();
  schedulePersist();
}

export function subscribeInteractionTrace(listener: InteractionTraceListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setInteractionTraceConsoleLog(on: boolean): void {
  consoleLog = on;
}

export interface InteractionTraceBridge {
  enable: typeof enableInteractionTrace;
  disable: typeof disableInteractionTrace;
  acquire: typeof acquireInteractionTrace;
  isEnabled: typeof isInteractionTraceEnabled;
  begin: typeof beginInteraction;
  mark: typeof markInteraction;
  timePhase: typeof timeInteractionPhase;
  patchMeta: typeof patchInteractionMeta;
  recordFreeze: typeof recordInteractionFreeze;
  end: typeof endInteraction;
  getRecent: typeof getRecentInteractions;
  getActive: typeof getActiveInteraction;
  exportJson: typeof exportInteractionTraceJson;
  clear: typeof clearInteractionTrace;
  subscribe: typeof subscribeInteractionTrace;
  persist: typeof persistInteractionTrace;
  dumpPath: string;
}

export function installInteractionTraceBridge(): InteractionTraceBridge {
  const bridge: InteractionTraceBridge = {
    enable: enableInteractionTrace,
    disable: disableInteractionTrace,
    acquire: acquireInteractionTrace,
    isEnabled: isInteractionTraceEnabled,
    begin: beginInteraction,
    mark: markInteraction,
    timePhase: timeInteractionPhase,
    patchMeta: patchInteractionMeta,
    recordFreeze: recordInteractionFreeze,
    end: endInteraction,
    getRecent: getRecentInteractions,
    getActive: getActiveInteraction,
    exportJson: exportInteractionTraceJson,
    clear: clearInteractionTrace,
    subscribe: subscribeInteractionTrace,
    persist: persistInteractionTrace,
    dumpPath: INTERACTION_TRACE_DUMP_PATH,
  };
  try {
    (globalThis as Record<string, unknown>)[BRIDGE_KEY] = bridge;
  } catch {
    /* non-browser */
  }
  return bridge;
}

export function resetInteractionTraceForTests(): void {
  stopFrameSample();
  stopLongTaskObserver();
  frameDeltas = [];
  lastFrameTs = 0;
  active = null;
  sessions.length = 0;
  listeners.clear();
  ownerCount = 0;
  seq = 0;
  enabled = isDevBuild();
  consoleLog = false;
  persistScheduled = false;
  try {
    delete (globalThis as Record<string, unknown>)[BRIDGE_KEY];
  } catch {
    /* ignore */
  }
}

if (isDevBuild()) {
  installInteractionTraceBridge();
}
