/**
 * WorkbenchDevPanel — 诊断 HUD / 性能可视化（O15，前身 P10）
 *
 * 显示：实时帧耗时曲线（掉帧标记 + 16.7/33.3ms 参考线）、FPS/平均/峰值/掉帧/长任务、
 * 最近交互时间线（起拖→首帧 / 跟手帧 / settle）、生命周期分布、活动窗口列表、
 * memoryWeight 预算占用条、focusStack、快照最后保存时间。
 *
 * 交互：玻璃 HUD 可拖动（标题栏 pointer capture，transform 直写 DOM 不进 React state，
 * rAF 合帧，位置持久化）、可折叠（按钮 / 双击标题栏）、外部按住指针期间自动幽灵化
 * （降透明 + pointer-events:none，不遮挡桌面操作）。
 *
 * 性能数据源（O10 perfMonitor）：
 *   1. globalThis.__WB_PERF_MONITOR__ 全局桥（subscribe / subscribePerfMonitor）
 *   2. 静态 import('../core/perfMonitor')（R3-02：解包 frame + acquirePerfMonitor 引用计数；
 *      卸载面板必须 release，禁止裸 startPerfMonitor 常驻 rAF）
 *   3. 本地 rAF 帧采样 + PerformanceObserver('longtask') 兜底
 *
 * 交互时间线（interactionTrace）：
 *   globalThis.__WB_INTERACTION_TRACE__ + DEV 落盘 `.tmp/wb-interaction-trace.json`
 *
 * 由 `desktop.workbenchDevPanel` 设置开启时挂载到 WorkbenchDesktop（开发期开关）；
 * 也可独立渲染（store 数据全部来自 useWindowStore / appRegistry，可 mock 测试）。
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { useWindowStore } from '../core/windowStore';
import { appRegistry } from '../core/appRegistry';
import { getMemoryBudget } from '../core/scheduler';
import type { WindowLifecycle, WorkbenchWindow } from '../core/types';
import { usePresenceStore } from '../agent/presenceStore';
import {
  KNOWN_DOMAIN_EVENTS,
  registerDomainListener,
  useRecentDomainEvents,
  useRecentReceiptSummaries,
} from '../agent/domainEvents';
import { runLedger } from '../agent/ledger';
import { stageManager } from '../agent/stageManager';
import type { AcrDiagnosticsSnapshot, PresenceState } from '../agent/types';
import {
  acquireInteractionTrace,
  clearInteractionTrace,
  exportInteractionTraceJson,
  getRecentInteractions,
  INTERACTION_TRACE_DUMP_PATH,
  subscribeInteractionTrace,
  type InteractionSession,
} from '../core/interactionTrace';
import './WorkbenchDevPanel.css';

/**
 * 账本 run 数只读探测（ledger.ts 归 R1-06，本卡不改）。
 * 若暴露 listRuns / size / getRunCount 则显示数字；仅有 hasRun 不可枚举 → null（UI 显示 n/a）。
 */
function probeLedgerRunCount(): number | null {
  const ledger = runLedger as unknown as Record<string, unknown>;
  try {
    if (typeof ledger.listRuns === 'function') {
      const runs = (ledger.listRuns as () => unknown)();
      return Array.isArray(runs) ? runs.length : null;
    }
    if (typeof ledger.getRunCount === 'function') {
      const n = (ledger.getRunCount as () => unknown)();
      return typeof n === 'number' && Number.isFinite(n) ? n : null;
    }
    if (typeof ledger.size === 'number' && Number.isFinite(ledger.size)) {
      return ledger.size as number;
    }
  } catch {
    return null;
  }
  // hasRun 存在但无法枚举 → n/a
  return null;
}

function formatDomainEventLine(eventName: string, payload: { source: string; action: string }): string {
  const short = eventName.includes('://')
    ? eventName.split('://')[0]
    : eventName.replace(/:change$/, '');
  return `${short} · ${payload.source}/${payload.action}`;
}

function formatReceiptLine(r: {
  runId: string;
  status: string;
  applied?: number;
  totalOps?: number;
}): string {
  const ops =
    typeof r.applied === 'number' && typeof r.totalOps === 'number'
      ? ` ${r.applied}/${r.totalOps}`
      : '';
  const shortId = r.runId.length > 10 ? `${r.runId.slice(0, 8)}…` : r.runId;
  return `${r.status}${ops} · ${shortId}`;
}

const EMPTY_ACR_DIAGNOSTICS: AcrDiagnosticsSnapshot = {
  transactions: [],
  leases: [],
  cancelling: 0,
  orphanDraining: 0,
  undoInFlight: 0,
};

/** ACR 3.0 只读诊断采样；与 HUD 其他汇总保持同一 500ms 刷新节拍。 */
function useAcrDiagnostics(): AcrDiagnosticsSnapshot {
  const readSnapshot = useCallback((): AcrDiagnosticsSnapshot => {
    try {
      return stageManager.getDiagnostics();
    } catch {
      return EMPTY_ACR_DIAGNOSTICS;
    }
  }, []);
  const [snapshot, setSnapshot] = useState<AcrDiagnosticsSnapshot>(readSnapshot);

  useEffect(() => {
    const timer = setInterval(() => setSnapshot(readSnapshot()), FLUSH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [readSnapshot]);

  return snapshot;
}

const LIFECYCLE_ORDER: readonly WindowLifecycle[] = ['focused', 'visible', 'background', 'frozen'];

/** 曲线保留的帧数（296px 宽卡片内 1 帧 ≈ 2.3px） */
const MAX_POINTS = 120;
const CHART_W = 120;
const CHART_H = 44;
/** 曲线 y 轴钳制上限（ms）；超过按 50ms 画 */
const CHART_CLAMP_MS = 50;
/** 掉帧判定：超过 2 个 60fps 帧预算 */
const DROP_THRESHOLD_MS = 33.4;
/** HUD 自身的 React 刷新节流：500ms 汇总一次，避免面板反噬性能 */
const FLUSH_INTERVAL_MS = 500;

const POS_STORAGE_KEY = 'workbench.hud.offset';
const COLLAPSE_STORAGE_KEY = 'workbench.hud.collapsed';
const EDGE_MARGIN = 8;
const DRAG_THRESHOLD_PX = 3;

/** 与 scheduler.useWindowLifecycle 相同的兜底判定，但一次性算全量窗口 */
function deriveLifecycle(
  win: WorkbenchWindow,
  lifecycles: Record<string, WindowLifecycle>,
  topId: string | undefined,
): WindowLifecycle {
  const explicit = lifecycles[win.id];
  if (explicit) return explicit;
  if (win.minimized) return 'background';
  return topId === win.id ? 'focused' : 'visible';
}

// ============================================================================
// perfMonitor 消费（O10 预告契约，字段全部可选、逐字段校验）
// ============================================================================

interface PerfMonitorSampleLike {
  at?: number;
  /** 汇总窗口内逐帧耗时 ms（优先消费，曲线最准） */
  frames?: number[];
  frameAvgMs?: number;
  frameMaxMs?: number;
  droppedFrames?: number;
  longTasks?: number;
  /**
   * R3-02：真实 `PerfSample` 把帧统计嵌在 `frame` 下；
   * 旧扁平契约仍兼容。
   */
  frame?: {
    avgFrameMs?: number;
    maxFrameMs?: number;
    fps?: number;
    droppedFrames?: number;
    longTasks?: number;
    sampledFrames?: number;
  };
}

type PerfSubscribe = (listener: (sample: PerfMonitorSampleLike) => void) => () => void;

type PerfSource = 'local' | 'perfMonitor';

/**
 * 三级探测 O10 订阅接口：全局桥 → 静态 import → null（调用方回退本地采样）。
 * R3-02：改为静态 import，确保订阅到真实 PerfSample，并在面板挂载时启动采样。
 */
async function resolvePerfSubscribe(): Promise<{
  subscribe: PerfSubscribe;
  release: (() => void) | null;
} | null> {
  const bridge = (globalThis as Record<string, unknown>).__WB_PERF_MONITOR__ as
    | {
        subscribe?: unknown;
        subscribePerfMonitor?: unknown;
        start?: unknown;
        startPerfMonitor?: unknown;
        acquire?: unknown;
        acquirePerfMonitor?: unknown;
      }
    | undefined;
  if (bridge) {
    const acquireFn = bridge.acquire ?? bridge.acquirePerfMonitor;
    const startFn = bridge.start ?? bridge.startPerfMonitor;
    let release: (() => void) | null = null;
    try {
      if (typeof acquireFn === 'function') {
        release = (acquireFn as () => () => void)();
      } else if (typeof startFn === 'function') {
        // 兼容旧桥：无 acquire 时退回 start，但仍尽量拿到 stop 句柄
        const maybeStop = (startFn as () => unknown)();
        release = typeof maybeStop === 'function' ? (maybeStop as () => void) : null;
      }
    } catch {
      /* best-effort */
    }
    const fn = bridge.subscribe ?? bridge.subscribePerfMonitor;
    if (typeof fn === 'function') {
      return { subscribe: (fn as PerfSubscribe).bind(bridge), release };
    }
  }
  try {
    const mod = await import('../core/perfMonitor');
    // DevPanel 与 StageManager 共享引用计数；卸载面板时 release，勿裸 start
    const release =
      typeof mod.acquirePerfMonitor === 'function' ? mod.acquirePerfMonitor() : null;
    if (typeof mod.subscribePerfMonitor === 'function') {
      return { subscribe: mod.subscribePerfMonitor as PerfSubscribe, release };
    }
    release?.();
  } catch {
    // 模块不可用 → 本地兜底
  }
  return null;
}

interface PerfView {
  /** 最近 MAX_POINTS 帧的耗时（ms），曲线右对齐滚动 */
  frames: number[];
  /** 最近一个汇总窗口的均值 / 峰值 */
  avg: number;
  max: number;
  fps: number;
  /** 挂载以来累计掉帧 / 长任务 */
  dropped: number;
  longTasks: number;
  source: PerfSource;
}

function formatInteractionLine(s: InteractionSession): string {
  const type =
    typeof s.meta?.typeId === 'string' ? s.meta.typeId : s.windowId?.slice(0, 6) ?? '?';
  const arm =
    s.measures.armToFirstMoveMs != null ? `${s.measures.armToFirstMoveMs}ms→首帧` : '—→首帧';
  const armed = s.measures.armedMs != null ? ` armed${s.measures.armedMs}` : '';
  const total = s.measures.totalMs != null ? `${s.measures.totalMs}ms` : '—';
  const f = s.frame;
  const framePart = f
    ? `${f.sampledFrames}f avg${f.avgFrameMs} max${f.maxFrameMs} drop${f.droppedFrames}`
    : 'no-frames';
  const c = s.costs;
  const lt =
    c && c.longTasks.count > 0
      ? ` lt${c.longTasks.count}/${c.longTasks.totalMs}ms` +
        (c.longTasks.shareOfTotalPct != null ? `(${c.longTasks.shareOfTotalPct}%)` : '')
      : '';
  const fr = c?.freeze
    ? ` freeze:${c.freeze.applied ? 'on' : 'off'}/${c.freeze.reason}${c.freeze.snapshotHit ? '+snap' : ''}`
    : '';
  const p95 = c?.frames?.p95Ms != null ? ` p95=${c.frames.p95Ms}` : '';
  return `${s.kind}/${type} · ${arm}${armed} · ${total} · ${framePart}${p95}${lt}${fr}`;
}

function useInteractionFeed(): InteractionSession[] {
  const [rows, setRows] = useState<InteractionSession[]>(() => getRecentInteractions(12));
  useEffect(() => {
    const release = acquireInteractionTrace();
    setRows(getRecentInteractions(12));
    const unsub = subscribeInteractionTrace((all) => {
      setRows(all.slice(-12));
    });
    return () => {
      unsub();
      release();
    };
  }, []);
  return rows;
}

/**
 * 性能数据流：本地 rAF 采样立即可用；O10 perfMonitor 解析成功后无缝接管
 * （停掉本地帧采样，避免双重统计）。500ms 才 setState 一次。
 */
function usePerfFeed(): PerfView | null {
  const [view, setView] = useState<PerfView | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let disposed = false;

    const history: number[] = [];
    let dropped = 0;
    let localLongTasks = 0;
    let extLongTasks = 0;
    let extLongProvided = false;
    let source: PerfSource = 'local';
    let dirty = false;
    let winSum = 0;
    let winCount = 0;
    let winMax = 0;

    const pushFrame = (ms: number, countDrop: boolean) => {
      if (!Number.isFinite(ms) || ms < 0) return;
      history.push(ms);
      if (history.length > MAX_POINTS) history.splice(0, history.length - MAX_POINTS);
      winSum += ms;
      winCount += 1;
      if (ms > winMax) winMax = ms;
      // 只在壳层手势/settle 期间累计掉帧，避免空闲高刷桌面把计数刷到上千
      const gesture =
        typeof document !== 'undefined' &&
        (document.documentElement.hasAttribute('data-wb-dragging') ||
          document.documentElement.hasAttribute('data-wb-settling'));
      if (countDrop && gesture && ms >= DROP_THRESHOLD_MS) dropped += 1;
      dirty = true;
    };

    // —— 本地 rAF 兜底采样 ——
    let raf = 0;
    let localActive = false;
    let last = 0;
    const tick = (now: number) => {
      if (disposed || !localActive) return;
      pushFrame(now - last, true);
      last = now;
      raf = requestAnimationFrame(tick);
    };
    const startLocal = () => {
      if (localActive || typeof requestAnimationFrame !== 'function') return;
      localActive = true;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    };
    const stopLocal = () => {
      localActive = false;
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
    };

    let longObserver: PerformanceObserver | null = null;
    if (typeof PerformanceObserver === 'function') {
      try {
        longObserver = new PerformanceObserver((list) => {
          localLongTasks += list.getEntries().length;
          dirty = true;
        });
        longObserver.observe({ entryTypes: ['longtask'] });
      } catch {
        longObserver = null;
      }
    }

    startLocal();

    // —— O10 perfMonitor 接管 ——
    let unsubscribe: (() => void) | null = null;
    let releasePerf: (() => void) | null = null;
    const onSample = (sample: PerfMonitorSampleLike) => {
      if (disposed || !sample || typeof sample !== 'object') return;
      // R3-02：解包 PerfSample.frame；兼容旧扁平字段
      const nested = sample.frame;
      const longVal =
        typeof sample.longTasks === 'number'
          ? sample.longTasks
          : typeof nested?.longTasks === 'number'
            ? nested.longTasks
            : undefined;
      const avgMs =
        typeof sample.frameAvgMs === 'number'
          ? sample.frameAvgMs
          : typeof nested?.avgFrameMs === 'number'
            ? nested.avgFrameMs
            : undefined;
      const maxMs =
        typeof sample.frameMaxMs === 'number'
          ? sample.frameMaxMs
          : typeof nested?.maxFrameMs === 'number'
            ? nested.maxFrameMs
            : undefined;

      // 掉帧只走 pushFrame 的手势门控；忽略 perfMonitor 累计 droppedFrames
      // （空闲高刷自适应阈值会把 HUD 刷到上千，掩盖真实跟手掉帧）。
      if (Array.isArray(sample.frames) && sample.frames.length > 0) {
        for (const ms of sample.frames) pushFrame(ms, true);
      } else if (typeof avgMs === 'number') {
        pushFrame(avgMs, true);
        if (typeof maxMs === 'number' && maxMs > avgMs) {
          pushFrame(maxMs, true);
        }
      }
      if (typeof longVal === 'number') {
        extLongProvided = true;
        extLongTasks += longVal;
        dirty = true;
      }
    };

    void resolvePerfSubscribe().then((resolved) => {
      if (disposed || !resolved) return;
      try {
        releasePerf = resolved.release;
        unsubscribe = resolved.subscribe(onSample);
        source = 'perfMonitor';
        stopLocal();
      } catch {
        unsubscribe = null;
        releasePerf?.();
        releasePerf = null;
      }
    });

    const flushTimer = setInterval(() => {
      if (disposed || !dirty) return;
      dirty = false;
      const avg = winCount > 0 ? winSum / winCount : 0;
      setView({
        frames: [...history],
        avg,
        max: winMax,
        fps: avg > 0 ? Math.min(999, Math.round(1000 / avg)) : 0,
        dropped,
        longTasks: extLongProvided ? extLongTasks : localLongTasks,
        source,
      });
      winSum = 0;
      winCount = 0;
      winMax = 0;
    }, FLUSH_INTERVAL_MS);

    return () => {
      disposed = true;
      stopLocal();
      longObserver?.disconnect();
      clearInterval(flushTimer);
      if (unsubscribe) {
        try {
          unsubscribe();
        } catch {
          // noop
        }
      }
      try {
        releasePerf?.();
      } catch {
        // noop
      }
    };
  }, []);

  return view;
}

// ============================================================================
// 帧耗时曲线（SVG，右对齐滚动，掉帧红点标记）
// ============================================================================

const chartY = (ms: number): number =>
  CHART_H - (Math.min(CHART_CLAMP_MS, Math.max(0, ms)) / CHART_CLAMP_MS) * (CHART_H - 4) - 2;

const FrameChart: React.FC<{ frames: number[]; placeholder: string }> = ({
  frames,
  placeholder,
}) => {
  const n = frames.length;
  const points = useMemo(() => {
    if (n < 2) return '';
    return frames
      .map((ms, i) => `${CHART_W - (n - 1 - i)},${chartY(ms).toFixed(1)}`)
      .join(' ');
  }, [frames, n]);

  const drops = useMemo(() => {
    const xs: Array<{ key: string; x: number }> = [];
    frames.forEach((ms, i) => {
      if (ms >= DROP_THRESHOLD_MS) xs.push({ key: `d${i}`, x: CHART_W - (n - 1 - i) });
    });
    return xs;
  }, [frames, n]);

  return (
    <div className="wb-hud-chart" data-testid="wb-hud-frame-chart">
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" aria-hidden="true">
        <line
          className="wb-hud-chart-ref"
          x1={0}
          x2={CHART_W}
          y1={chartY(16.7)}
          y2={chartY(16.7)}
          vectorEffect="non-scaling-stroke"
        />
        <line
          className="wb-hud-chart-ref"
          x1={0}
          x2={CHART_W}
          y1={chartY(33.3)}
          y2={chartY(33.3)}
          vectorEffect="non-scaling-stroke"
        />
        {points && (
          <polyline className="wb-hud-chart-line" points={points} vectorEffect="non-scaling-stroke" />
        )}
        {drops.map(({ key, x }) => (
          <circle key={key} className="wb-hud-chart-drop" cx={x} cy={4} r={1.6} />
        ))}
      </svg>
      {!points && <div className="wb-hud-chart-placeholder">{placeholder}</div>}
    </div>
  );
};

const HudScrollList: React.FC<
  React.HTMLAttributes<HTMLUListElement> & { variant: 'interactions' | 'windows' }
> = ({ variant, className, children, ...props }) => (
  <CustomScrollArea
    className={`wb-hud-list-scroll wb-hud-${variant}-scroll`}
    fullHeight={false}
    trackOffsetTop={2}
    trackOffsetBottom={2}
    trackOffsetRight={1}
  >
    <ul className={className} {...props}>{children}</ul>
  </CustomScrollArea>
);

// ============================================================================
// HUD 主体
// ============================================================================

export interface WorkbenchDevPanelProps {
  className?: string;
  onClose?: () => void;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  startOffsetX: number;
  startOffsetY: number;
  /** 去掉当前 offset 后的锚定位置（CSS right/bottom 的自然落点） */
  baseLeft: number;
  baseTop: number;
  w: number;
  h: number;
  moved: boolean;
}

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

export const WorkbenchDevPanel: React.FC<WorkbenchDevPanelProps> = ({ className, onClose }) => {
  const { t } = useTranslation(['workbench']);
  const windows = useWindowStore((s) => s.windows);
  const focusStack = useWindowStore((s) => s.focusStack);
  const lifecycles = useWindowStore((s) => s.lifecycles);

  const [lastSnapshotAt, setLastSnapshotAt] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSE_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const budgetRef = useRef(getMemoryBudget());
  const perf = usePerfFeed();
  const interactions = useInteractionFeed();

  const copyInteractions = useCallback(async () => {
    const text = exportInteractionTraceJson();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* best-effort */
    }
  }, []);

  // ---- ACR（R1-18）：presence / 域事件环 / 最近回执 / 账本概要 ----
  const presenceByWindow = usePresenceStore((s) => s.byWindow);
  const recentDomainEvents = useRecentDomainEvents();
  const recentReceipts = useRecentReceiptSummaries();
  const acrDiagnostics = useAcrDiagnostics();
  const [acrCollapsed, setAcrCollapsed] = useState(false);
  /** 账本无订阅面：每次渲染鸭子探测；不可枚举则 n/a */
  const ledgerRunCount = probeLedgerRunCount();

  const presenceList = useMemo(() => {
    return Object.values(presenceByWindow) as PresenceState[];
  }, [presenceByWindow]);

  const lastReceipt = recentReceipts.length > 0 ? recentReceipts[recentReceipts.length - 1] : null;

  // 预热已知域事件的 hub 订阅，使环形缓冲在尚无 driver 时也能收到事件
  useEffect(() => {
    const unsubs = KNOWN_DOMAIN_EVENTS.map((name) =>
      registerDomainListener(name, () => undefined),
    );
    return () => {
      for (const u of unsubs) {
        try {
          u();
        } catch {
          /* ignore */
        }
      }
    };
  }, []);

  // ---- 快照保存时间 ----
  useEffect(() => {
    const handler = (event: Event) => {
      const at = (event as CustomEvent<{ at?: number }>).detail?.at;
      setLastSnapshotAt(typeof at === 'number' ? at : Date.now());
    };
    window.addEventListener('workbench:snapshot-saved', handler);
    return () => window.removeEventListener('workbench:snapshot-saved', handler);
  }, []);

  // ---- 拖动（直写 DOM transform，rAF 合帧，不进 React state） ----
  const rootRef = useRef<HTMLDivElement | null>(null);
  const offsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const dragRef = useRef<DragState | null>(null);
  const dragRafRef = useRef(0);
  const pendingOffsetRef = useRef<{ x: number; y: number } | null>(null);

  const applyOffset = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const { x, y } = offsetRef.current;
    root.style.transform = x === 0 && y === 0 ? '' : `translate3d(${x}px, ${y}px, 0)`;
  }, []);

  useLayoutEffect(() => {
    try {
      const raw = localStorage.getItem(POS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
        if (Number.isFinite(parsed?.x) && Number.isFinite(parsed?.y)) {
          offsetRef.current = { x: parsed.x as number, y: parsed.y as number };
        }
      }
    } catch {
      // 坏数据 → 默认位置
    }
    applyOffset();
    // 分辨率变化后把恢复位置钳回可视区
    const root = rootRef.current;
    if (root && (offsetRef.current.x !== 0 || offsetRef.current.y !== 0)) {
      const rect = root.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const left = clamp(rect.left, EDGE_MARGIN, Math.max(EDGE_MARGIN, window.innerWidth - rect.width - EDGE_MARGIN));
        const top = clamp(rect.top, EDGE_MARGIN, Math.max(EDGE_MARGIN, window.innerHeight - rect.height - EDGE_MARGIN));
        offsetRef.current = {
          x: offsetRef.current.x + (left - rect.left),
          y: offsetRef.current.y + (top - rect.top),
        };
        applyOffset();
      }
    }
  }, [applyOffset]);

  const scheduleOffset = useCallback(
    (next: { x: number; y: number }) => {
      pendingOffsetRef.current = next;
      if (typeof requestAnimationFrame !== 'function') {
        offsetRef.current = next;
        pendingOffsetRef.current = null;
        applyOffset();
        return;
      }
      if (dragRafRef.current) return;
      dragRafRef.current = requestAnimationFrame(() => {
        dragRafRef.current = 0;
        if (pendingOffsetRef.current) {
          offsetRef.current = pendingOffsetRef.current;
          pendingOffsetRef.current = null;
          applyOffset();
        }
      });
    },
    [applyOffset],
  );

  const onHeaderPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement | null)?.closest('.wb-hud-btn')) return;
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startOffsetX: offsetRef.current.x,
      startOffsetY: offsetRef.current.y,
      baseLeft: rect.left - offsetRef.current.x,
      baseTop: rect.top - offsetRef.current.y,
      w: rect.width,
      h: rect.height,
      moved: false,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, []);

  const onHeaderPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!drag.moved) {
        if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
        drag.moved = true;
        const root = rootRef.current;
        if (root) {
          root.classList.add('wb-hud-dragging');
          root.style.willChange = 'transform';
        }
      }
      const desiredLeft = drag.baseLeft + drag.startOffsetX + dx;
      const desiredTop = drag.baseTop + drag.startOffsetY + dy;
      const maxLeft = Math.max(EDGE_MARGIN, window.innerWidth - drag.w - EDGE_MARGIN);
      const maxTop = Math.max(EDGE_MARGIN, window.innerHeight - drag.h - EDGE_MARGIN);
      scheduleOffset({
        x: clamp(desiredLeft, EDGE_MARGIN, maxLeft) - drag.baseLeft,
        y: clamp(desiredTop, EDGE_MARGIN, maxTop) - drag.baseTop,
      });
    },
    [scheduleOffset],
  );

  const endDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      dragRef.current = null;
      if (dragRafRef.current && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(dragRafRef.current);
        dragRafRef.current = 0;
      }
      if (pendingOffsetRef.current) {
        offsetRef.current = pendingOffsetRef.current;
        pendingOffsetRef.current = null;
        applyOffset();
      }
      const root = rootRef.current;
      if (root) {
        root.classList.remove('wb-hud-dragging');
        root.style.willChange = '';
      }
      if (drag.moved) {
        try {
          localStorage.setItem(POS_STORAGE_KEY, JSON.stringify(offsetRef.current));
        } catch {
          // 存储不可用则本次会话内有效
        }
      }
      try {
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      } catch {
        // 未捕获时忽略
      }
    },
    [applyOffset],
  );

  // ---- 不遮挡操作：外部按住指针期间幽灵化（直写 class，不进 state） ----
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof window === 'undefined') return;
    let lift: (() => void) | null = null;
    const onDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || root.contains(event.target)) return;
      root.classList.add('wb-hud-ghost');
      const clear = () => {
        root.classList.remove('wb-hud-ghost');
        window.removeEventListener('pointerup', clear, true);
        window.removeEventListener('pointercancel', clear, true);
        lift = null;
      };
      lift = clear;
      window.addEventListener('pointerup', clear, true);
      window.addEventListener('pointercancel', clear, true);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      lift?.();
    };
  }, []);

  // ---- 折叠 ----
  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSE_STORAGE_KEY, String(next));
      } catch {
        // noop
      }
      return next;
    });
  }, []);

  const onHeaderDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement | null)?.closest('.wb-hud-btn')) return;
      toggleCollapsed();
    },
    [toggleCollapsed],
  );

  // ---- store 派生数据 ----
  const topId = focusStack[focusStack.length - 1];

  const rows = useMemo(() => {
    return Object.values(windows)
      .sort((a, b) => b.zIndex - a.zIndex)
      .map((win) => ({
        win,
        lifecycle: deriveLifecycle(win, lifecycles, topId),
        weight: appRegistry.get(win.typeId)?.memoryWeight ?? 1,
      }));
  }, [windows, lifecycles, topId]);

  const lifecycleCounts = useMemo(() => {
    const counts: Record<WindowLifecycle, number> = {
      focused: 0,
      visible: 0,
      background: 0,
      frozen: 0,
    };
    for (const row of rows) counts[row.lifecycle] += 1;
    return counts;
  }, [rows]);

  const budget = budgetRef.current;
  const usedWeight = rows
    .filter((r) => r.lifecycle !== 'frozen')
    .reduce((sum, r) => sum + r.weight, 0);
  const budgetRatio = Math.min(1, usedWeight / budget);
  const overBudget = usedWeight > budget;

  const fpsHot = perf != null && perf.avg > 20;

  return (
    <div
      ref={rootRef}
      data-testid="workbench-dev-panel"
      className={`wb-hud ${className ?? ''}`}
    >
      <div className="wb-glass wb-glass-highlight wb-hud-card">
        <div
          className="wb-hud-header"
          onPointerDown={onHeaderPointerDown}
          onPointerMove={onHeaderPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={onHeaderDoubleClick}
        >
          <span className="wb-hud-grip" aria-hidden="true" />
          <span className="wb-hud-title">{t('workbench:devPanel.title')}</span>
          <span className="wb-hud-fps-badge" data-hot={fpsHot ? 'true' : undefined}>
            {perf ? `${perf.fps} fps` : '—'}
          </span>
          <button
            type="button"
            className="wb-hud-btn"
            aria-expanded={!collapsed}
            aria-label={
              collapsed
                ? t('workbench:devPanel.expand')
                : t('workbench:devPanel.collapse')
            }
            onClick={toggleCollapsed}
          >
            {collapsed ? '▸' : '▾'}
          </button>
          {onClose && (
            <button
              type="button"
              className="wb-hud-btn"
              aria-label={t('workbench:devPanel.close')}
              onClick={onClose}
            >
              ×
            </button>
          )}
        </div>

        {!collapsed && (
          <CustomScrollArea
            className="wb-hud-body-scroll"
            trackOffsetTop={2}
            trackOffsetBottom={8}
            trackOffsetRight={2}
          >
            <div className="wb-hud-body">
            {/* 帧耗时曲线 + 掉帧标记 */}
            <div className="wb-hud-section">
              <div className="wb-hud-label">
                <span>{t('workbench:devPanel.frameTime')}</span>
                {perf && (
                  <span className="wb-hud-muted">
                    {t('workbench:devPanel.avg')} {perf.avg.toFixed(1)}ms ·{' '}
                    {t('workbench:devPanel.max')} {perf.max.toFixed(1)}ms
                  </span>
                )}
              </div>
              <FrameChart
                frames={perf?.frames ?? []}
                placeholder={t('workbench:devPanel.sampling')}
              />
              <div className="wb-hud-chips">
                <span className="wb-hud-chip" data-alert={perf != null && perf.dropped > 0 ? 'true' : undefined}>
                  {t('workbench:devPanel.gestureDropped')} {perf?.dropped ?? 0}
                </span>
                <span className="wb-hud-chip" data-alert={perf != null && perf.longTasks > 0 ? 'true' : undefined}>
                  {t('workbench:devPanel.longTasks')} {perf?.longTasks ?? 0}
                </span>
                <span
                  className="wb-hud-chip"
                  data-src={perf?.source ?? 'local'}
                  title={t('workbench:devPanel.source')}
                >
                  {perf?.source ?? 'local'}
                </span>
              </div>
            </div>

            {/* 最近交互时间线（拖/缩/settle） */}
            <div className="wb-hud-section" data-testid="wb-hud-interactions">
              <div className="wb-hud-label">
                <span>{t('workbench:devPanel.interactions')}</span>
                <span className="wb-hud-muted">{interactions.length}</span>
              </div>
              {interactions.length === 0 ? (
                <div className="wb-hud-empty">
                  {t('workbench:devPanel.interactionsEmpty')}
                </div>
              ) : (
                <HudScrollList variant="interactions" className="wb-hud-ixlist">
                  {[...interactions].reverse().map((s) => (
                    <li
                      key={s.id}
                      className="wb-hud-ixrow"
                      data-kind={s.kind}
                      data-alert={
                        (s.measures.armToFirstMoveMs != null && s.measures.armToFirstMoveMs >= 50) ||
                        (s.frame?.droppedFrames ?? 0) > 0
                          ? 'true'
                          : undefined
                      }
                    >
                      {formatInteractionLine(s)}
                    </li>
                  ))}
                </HudScrollList>
              )}
              <div className="wb-hud-ix-actions">
                <button
                  type="button"
                  className="wb-hud-linkbtn"
                  onClick={() => {
                    void copyInteractions();
                  }}
                >
                  {t('workbench:devPanel.copyTrace')}
                </button>
                <button
                  type="button"
                  className="wb-hud-linkbtn"
                  onClick={() => clearInteractionTrace()}
                >
                  {t('workbench:devPanel.clearTrace')}
                </button>
                <span className="wb-hud-muted" title={INTERACTION_TRACE_DUMP_PATH}>
                  {INTERACTION_TRACE_DUMP_PATH}
                </span>
              </div>
            </div>

            {/* 生命周期分布 */}
            <div className="wb-hud-section">
              <div className="wb-hud-label">
                <span>{t('workbench:devPanel.distribution')}</span>
                <span className="wb-hud-muted">{rows.length}</span>
              </div>
              <div className="wb-hud-stack" data-testid="wb-hud-lifecycle-stack">
                {LIFECYCLE_ORDER.filter((lc) => lifecycleCounts[lc] > 0).map((lc) => (
                  <span
                    key={lc}
                    className="wb-hud-stack-seg"
                    data-lc={lc}
                    style={{ width: `${(lifecycleCounts[lc] / rows.length) * 100}%` }}
                  />
                ))}
              </div>
              <div className="wb-hud-legend">
                {LIFECYCLE_ORDER.map((lc) => (
                  <span key={lc} className="wb-hud-legend-item">
                    <span className="wb-hud-dot" data-lc={lc} aria-hidden="true" />
                    {t(`workbench:devPanel.lifecycle.${lc}`, lc)} {lifecycleCounts[lc]}
                  </span>
                ))}
              </div>
            </div>

            {/* 活动窗口列表（lifecycle 着色） */}
            <div className="wb-hud-section">
              <div className="wb-hud-label">
                <span>
                  {t('workbench:devPanel.windows')} ({rows.length})
                </span>
              </div>
              {rows.length === 0 ? (
                <div className="wb-hud-empty">{t('workbench:devPanel.noWindows')}</div>
              ) : (
                <HudScrollList variant="windows" className="wb-hud-winlist">
                  {rows.map(({ win, lifecycle, weight }) => (
                    <li key={win.id} className="wb-hud-winrow" data-lifecycle={lifecycle}>
                      <span className="wb-hud-dot" data-lc={lifecycle} aria-hidden="true" />
                      <span className="wb-hud-winrow-title">{win.title || win.typeId}</span>
                      {win.minimized && (
                        <span className="wb-hud-winrow-tag">
                          {t('workbench:devPanel.minimizedTag')}
                        </span>
                      )}
                      <span className="wb-hud-winrow-meta">
                        {t(`workbench:devPanel.lifecycle.${lifecycle}`, lifecycle)} · w{weight}
                      </span>
                    </li>
                  ))}
                </HudScrollList>
              )}
            </div>

            {/* 内存预算占用条 */}
            <div className="wb-hud-section">
              <div className="wb-hud-label">
                <span>{t('workbench:devPanel.budget')}</span>
                <span className="wb-hud-budget-value" data-over={overBudget ? 'true' : undefined}>
                  {usedWeight} / {budget}
                </span>
              </div>
              <div className="wb-hud-bar">
                <div
                  className="wb-hud-bar-fill"
                  data-over={overBudget ? 'true' : undefined}
                  style={{ '--wb-hud-bar-ratio': budgetRatio } as React.CSSProperties}
                />
              </div>
            </div>

            {/* 焦点栈 */}
            <div className="wb-hud-section">
              <div className="wb-hud-label">
                <span>{t('workbench:devPanel.focusStack')}</span>
              </div>
              <div className="wb-hud-focus-stack">
                {focusStack.length === 0
                  ? t('workbench:devPanel.emptyFocusStack')
                  : [...focusStack]
                      .reverse()
                      .map((id) => windows[id]?.title || windows[id]?.typeId || id)
                      .join(' › ')}
              </div>
            </div>

            {/* 快照 */}
            <div className="wb-hud-section wb-hud-meta-row">
              <span>
                {t('workbench:devPanel.lastSnapshot')}:{' '}
                {lastSnapshotAt
                  ? new Date(lastSnapshotAt).toLocaleTimeString()
                  : t('workbench:devPanel.never')}
              </span>
            </div>

            {/* ACR（R1-18） */}
            <div className="wb-hud-section" data-testid="wb-hud-acr">
              <div className="wb-hud-label">
                <button
                  type="button"
                  className="wb-hud-acr-toggle"
                  aria-expanded={!acrCollapsed}
                  onClick={() => setAcrCollapsed((v) => !v)}
                >
                  <span aria-hidden="true">{acrCollapsed ? '▸' : '▾'}</span>
                  <span>ACR</span>
                </button>
                <span className="wb-hud-muted">
                  {presenceList.length} run · ledger{' '}
                  {ledgerRunCount == null ? 'n/a' : ledgerRunCount}
                  {' · '}{acrDiagnostics.transactions.length} tx
                  {' · '}{acrDiagnostics.leases.length} lease
                  {lastReceipt ? ` · ${lastReceipt.status}` : ''}
                </span>
              </div>
              {!acrCollapsed && (
                <div className="wb-hud-acr-body">
                  <div className="wb-hud-chips">
                    <span className="wb-hud-chip" data-testid="wb-hud-acr-transactions">
                      transactions {acrDiagnostics.transactions.length}
                    </span>
                    <span
                      className="wb-hud-chip"
                      data-testid="wb-hud-acr-leases"
                      title={acrDiagnostics.leases
                        .map((lease) => `${lease.windowId} · ${lease.sessionId}/${lease.runId}`)
                        .join('\n') || undefined}
                    >
                      leases {acrDiagnostics.leases.length}
                    </span>
                    <span
                      className="wb-hud-chip"
                      data-alert={acrDiagnostics.cancelling > 0 ? 'true' : undefined}
                      data-testid="wb-hud-acr-cancelling"
                    >
                      cancelling {acrDiagnostics.cancelling}
                    </span>
                    <span
                      className="wb-hud-chip"
                      data-alert={acrDiagnostics.orphanDraining > 0 ? 'true' : undefined}
                      data-testid="wb-hud-acr-orphans"
                    >
                      orphan-draining {acrDiagnostics.orphanDraining}
                    </span>
                    <span
                      className="wb-hud-chip"
                      data-alert={acrDiagnostics.undoInFlight > 0 ? 'true' : undefined}
                      data-testid="wb-hud-acr-undo-in-flight"
                    >
                      undo-in-flight {acrDiagnostics.undoInFlight}
                    </span>
                    {KNOWN_DOMAIN_EVENTS.map((name) => (
                      <span key={name} className="wb-hud-chip" title={name}>
                        {name.includes('://') ? name.split('://')[0] : name}
                      </span>
                    ))}
                  </div>

                  <div className="wb-hud-label" style={{ marginTop: 6 }}>
                    <span>transactions</span>
                    <span className="wb-hud-muted">{acrDiagnostics.transactions.length}</span>
                  </div>
                  {acrDiagnostics.transactions.length === 0 ? (
                    <div className="wb-hud-empty">（无活跃 transaction）</div>
                  ) : (
                    <HudScrollList variant="windows" className="wb-hud-winlist" data-testid="wb-hud-acr-transaction-list">
                      {acrDiagnostics.transactions.map((transaction) => (
                        <li
                          key={`${transaction.sessionId}:${transaction.correlationId}:${transaction.kind}`}
                          className="wb-hud-winrow"
                          data-acr-transaction-state={transaction.state}
                          title={`${transaction.sessionId} · ${transaction.runId} · ${transaction.correlationId}`}
                        >
                          <span
                            className="wb-hud-dot"
                            data-acr={transaction.state === 'active' ? 'acting' : 'paused'}
                            aria-hidden="true"
                          />
                          <span className="wb-hud-winrow-title">
                            {transaction.kind}/{transaction.state}
                          </span>
                          <span className="wb-hud-winrow-meta">
                            {transaction.windowId ?? 'no-window'}
                            {transaction.ownsLease ? ' · lease' : ''}
                          </span>
                        </li>
                      ))}
                    </HudScrollList>
                  )}

                  <div className="wb-hud-label" style={{ marginTop: 6 }}>
                    <span>presence</span>
                    <span className="wb-hud-muted">{presenceList.length}</span>
                  </div>
                  {presenceList.length === 0 ? (
                    <div className="wb-hud-empty">（无活跃 presence）</div>
                  ) : (
                    <HudScrollList variant="windows" className="wb-hud-winlist">
                      {presenceList.map((p) => (
                        <li key={p.windowId} className="wb-hud-winrow" data-acr-status={p.status}>
                          <span
                            className="wb-hud-dot"
                            data-acr={
                              p.status === 'pausedByUser'
                                ? 'paused'
                                : p.status === 'done' || p.status === 'aborted'
                                  ? 'done'
                                  : 'acting'
                            }
                            aria-hidden="true"
                          />
                          <span
                            className="wb-hud-winrow-title"
                            title={`${p.windowId} · ${p.label}`}
                          >
                            {p.typeId}/{p.status}
                          </span>
                          <span className="wb-hud-winrow-meta">{p.label}</span>
                        </li>
                      ))}
                    </HudScrollList>
                  )}

                  <div className="wb-hud-label" style={{ marginTop: 6 }}>
                    <span>receipts</span>
                    <span className="wb-hud-muted">{recentReceipts.length}/5</span>
                  </div>
                  {recentReceipts.length === 0 ? (
                    <div className="wb-hud-empty">（尚无回执 · StageManager 接线后可见）</div>
                  ) : (
                    <HudScrollList variant="windows" className="wb-hud-winlist" data-testid="wb-hud-acr-receipts">
                      {[...recentReceipts].reverse().map((r, i) => (
                        <li
                          key={`${r.at}-${r.runId}-${i}`}
                          className="wb-hud-winrow"
                          data-acr-receipt={r.status}
                          title={r.message ?? r.runId}
                        >
                          <span
                            className="wb-hud-dot"
                            data-acr={
                              r.status === 'completed'
                                ? 'done'
                                : r.status === 'partial' || r.status === 'cancelled'
                                  ? 'paused'
                                  : 'failed'
                            }
                            aria-hidden="true"
                          />
                          <span className="wb-hud-winrow-title">{formatReceiptLine(r)}</span>
                          <span className="wb-hud-winrow-meta">
                            {new Date(r.at).toLocaleTimeString()}
                          </span>
                        </li>
                      ))}
                    </HudScrollList>
                  )}

                  <div className="wb-hud-label" style={{ marginTop: 6 }}>
                    <span>domain events</span>
                    <span className="wb-hud-muted">{recentDomainEvents.length}/5</span>
                  </div>
                  {recentDomainEvents.length === 0 ? (
                    <div className="wb-hud-empty">（尚无域事件）</div>
                  ) : (
                    <HudScrollList variant="windows" className="wb-hud-winlist">
                      {[...recentDomainEvents].reverse().map((ev, i) => (
                        <li
                          key={`${ev.at}-${ev.eventName}-${i}`}
                          className="wb-hud-winrow"
                          title={JSON.stringify(ev.payload)}
                        >
                          <span className="wb-hud-winrow-title">
                            {formatDomainEventLine(ev.eventName, ev.payload)}
                          </span>
                          <span className="wb-hud-winrow-meta">
                            {new Date(ev.at).toLocaleTimeString()}
                          </span>
                        </li>
                      ))}
                    </HudScrollList>
                  )}
                </div>
              )}
            </div>
            </div>
          </CustomScrollArea>
        )}
      </div>
    </div>
  );
};

export default WorkbenchDevPanel;
