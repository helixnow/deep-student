/**
 * perfMonitor（主责 O10）— Workbench 开发期性能采集与订阅。
 *
 * 采集内容（PerfSample）：
 * - frame：rAF 帧间隔统计（平均/峰值/fps）、掉帧数（自适应基线，兼容高刷屏）、
 *   长任务数（优先 PerformanceObserver 'longtask'，不可用时按帧间隔 ≥50ms 回退推断）；
 * - lifecycle：各生命周期档位的窗口数分布（focused/visible/background/frozen）；
 * - memory：内存预算占用（由 scheduler 每轮重算时经 recordSchedulerSample 推送）；
 * - scheduler：重算次数 / 最近一次重算耗时 / 遮挡增量模式与脏窗口数。
 *
 * 开关模型（引用计数，供 O15 诊断 HUD + ACR 慢帧降级）：
 * - 全局单例；生产路径用 `acquirePerfMonitor()`，测试可用裸 `startPerfMonitor()`；
 * - 未启动时零成本：不跑 rAF 循环，`recordSchedulerSample` 仅做一次赋值 + 计数；
 * - `subscribePerfMonitor(listener)` 订阅；仅在运行中按 intervalMs（默认 500ms）
 *   聚合推送；`getLastPerfSample()` 读取最近一次样本（可用于订阅前回填）。
 * - StageManager 仅在有活跃 run 时 acquire；DevPanel 挂载时 acquire；
 *   双方 release 后才真正 stop。
 *
 * ANTI-REGRESSION：禁止在 StageManager.start() 无条件 startPerfMonitor()——
 * 会在整个 OS 模式生命周期常驻逐帧采样，拖拽跟手与空闲桌面都会被拖慢。
 *
 * 消费方约定（O15）：本模块不从 workbench/index.ts 导出（index.ts 全员冻结，
 * 追加导出交 O20）；workbench 内部组件直接相对导入 `../core/perfMonitor`。
 */
import { useWindowStore } from './windowStore';
import type { WindowLifecycle } from './types';

export const PERF_MONITOR_DEFAULT_INTERVAL_MS = 500;
/** 帧间隔达到该值时按「长任务」回退推断（无 longtask observer 环境） */
export const LONG_TASK_THRESHOLD_MS = 50;
/** 帧间隔超过基线 × 该系数记为掉帧 */
export const DROPPED_FRAME_FACTOR = 1.5;

// ============================================================================
// 稳定订阅契约（O15 消费；字段只增不改）
// ============================================================================

export interface PerfFrameStats {
  /** 本采样窗口内的 rAF 帧数 */
  sampledFrames: number;
  avgFrameMs: number;
  maxFrameMs: number;
  /** 由平均帧间隔换算（0 = 无样本） */
  fps: number;
  /** 帧间隔 > 基线 × DROPPED_FRAME_FACTOR 的帧数（基线取中位数，自适应高刷屏） */
  droppedFrames: number;
  /** 长任务数（observer 可用时为真实 longtask 条目数，否则为回退推断） */
  longTasks: number;
  longTaskTotalMs: number;
}

export interface PerfLifecycleStats {
  counts: Record<WindowLifecycle, number>;
  totalWindows: number;
}

export interface PerfMemoryStats {
  /** 非 frozen 窗口 memoryWeight 之和（scheduler 每轮推送） */
  usedWeight: number;
  budget: number;
  overBudget: boolean;
  frozenCount: number;
  /** 处于「即将冻结」宽限期的窗口数 */
  pendingFreezeCount: number;
}

export interface PerfSchedulerStats {
  /** 累计 recomputeLifecycles 次数（含 monitor 未运行期间） */
  recomputeCount: number;
  lastRecomputeMs: number;
  lastOcclusionMode: 'full' | 'incremental' | 'none';
  lastOcclusionDirtyCount: number;
  lastOcclusionWindowCount: number;
}

export interface PerfSample {
  /** 样本产出时间（performance.now 时基） */
  at: number;
  intervalMs: number;
  frame: PerfFrameStats;
  lifecycle: PerfLifecycleStats;
  memory: PerfMemoryStats;
  scheduler: PerfSchedulerStats;
}

export type PerfMonitorListener = (sample: PerfSample) => void;

/**
 * ACR 演出自动降级钩子（DESIGN §4.3 / §7）：
 * 连续 N 帧间隔 > SLOW_FRAME_MS 时触发一次；恢复后计数清零可再次触发。
 */
export type PerfDegradeListener = (info: {
  consecutiveSlowFrames: number;
  lastFrameMs: number;
}) => void;

export interface PerfMonitorOptions {
  /** 聚合推送周期，默认 500ms，下限 50ms */
  intervalMs?: number;
}

/** 单帧间隔超过该值计为慢帧（≈30fps） */
export const SLOW_FRAME_MS = 33;
/** 连续慢帧达到该次数 → 通知降级钩子 */
export const SLOW_FRAME_DEGRADE_STREAK = 3;

/** 慢帧 streak 状态（导出供单测） */
export interface SlowFrameStreakState {
  consecutive: number;
  notified: boolean;
}

/**
 * 纯函数：根据本帧间隔更新慢帧 streak，决定是否应触发降级通知。
 * DESIGN §4.3：连续帧 >33ms → 自动降 fast。
 */
export function advanceSlowFrameStreak(
  state: SlowFrameStreakState,
  deltaMs: number,
  thresholdMs = SLOW_FRAME_MS,
  streakLimit = SLOW_FRAME_DEGRADE_STREAK,
): { state: SlowFrameStreakState; shouldNotify: boolean } {
  if (deltaMs > thresholdMs) {
    const consecutive = state.consecutive + 1;
    const shouldNotify = consecutive >= streakLimit && !state.notified;
    return {
      state: { consecutive, notified: state.notified || shouldNotify },
      shouldNotify,
    };
  }
  return { state: { consecutive: 0, notified: false }, shouldNotify: false };
}

/** scheduler → perfMonitor 的推送记录（scheduler 每轮 recompute 调用一次） */
export interface SchedulerPerfRecord {
  recomputeMs: number;
  occlusionMode: 'full' | 'incremental' | 'none';
  occlusionDirtyCount: number;
  occlusionWindowCount: number;
  usedWeight: number;
  budget: number;
  frozenCount: number;
  pendingFreezeCount: number;
}

// ============================================================================
// 纯聚合（导出供测试与自定义消费）
// ============================================================================

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * 帧间隔序列 → 帧统计。掉帧基线取中位数并钳制在 [4, 33.4]ms
 * （240Hz–30Hz），避免高刷屏把正常帧误判为掉帧。
 */
export function summarizeFrameDeltas(deltas: readonly number[]): PerfFrameStats {
  if (deltas.length === 0) {
    return {
      sampledFrames: 0,
      avgFrameMs: 0,
      maxFrameMs: 0,
      fps: 0,
      droppedFrames: 0,
      longTasks: 0,
      longTaskTotalMs: 0,
    };
  }
  const sorted = [...deltas].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const expected = Math.min(33.4, Math.max(4, median));
  let sum = 0;
  let max = 0;
  let dropped = 0;
  let longTasks = 0;
  let longTaskTotalMs = 0;
  for (const delta of deltas) {
    sum += delta;
    if (delta > max) max = delta;
    if (delta > expected * DROPPED_FRAME_FACTOR) dropped += 1;
    if (delta >= LONG_TASK_THRESHOLD_MS) {
      longTasks += 1;
      longTaskTotalMs += delta - expected;
    }
  }
  const avg = sum / deltas.length;
  return {
    sampledFrames: deltas.length,
    avgFrameMs: round1(avg),
    maxFrameMs: round1(max),
    fps: avg > 0 ? Math.round(1000 / avg) : 0,
    droppedFrames: dropped,
    longTasks,
    longTaskTotalMs: round1(longTaskTotalMs),
  };
}

// ============================================================================
// 单例状态
// ============================================================================

const listeners = new Set<PerfMonitorListener>();
const degradeListeners = new Set<PerfDegradeListener>();
let running = false;
let intervalMs = PERF_MONITOR_DEFAULT_INTERVAL_MS;
let rafHandle: number | ReturnType<typeof setTimeout> = 0;
let lastTick = 0;
let lastFlush = 0;
let frameDeltas: number[] = [];
let longTaskObserver: PerformanceObserver | null = null;
let observedLongTasks = 0;
let observedLongTaskMs = 0;
let lastSample: PerfSample | null = null;
let schedulerRecord: SchedulerPerfRecord | null = null;
let recomputeCount = 0;
/** 连续慢帧计数（> SLOW_FRAME_MS） */
let consecutiveSlowFrames = 0;
/** 本轮慢帧 streak 是否已通知过降级（恢复后重置） */
let degradeNotified = false;

function nowTs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

const requestFrame: (cb: () => void) => number | ReturnType<typeof setTimeout> =
  typeof requestAnimationFrame === 'function'
    ? (cb) => requestAnimationFrame(() => cb())
    : (cb) => setTimeout(cb, 16);

const cancelFrame: (handle: number | ReturnType<typeof setTimeout>) => void =
  typeof cancelAnimationFrame === 'function'
    ? (handle) => cancelAnimationFrame(handle as number)
    : (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>);

/** scheduler 每轮 recompute 推送；monitor 未运行时也只做赋值 + 计数（零成本） */
export function recordSchedulerSample(record: SchedulerPerfRecord): void {
  schedulerRecord = record;
  recomputeCount += 1;
}

function tryObserveLongTasks(): PerformanceObserver | null {
  try {
    if (typeof PerformanceObserver === 'undefined') return null;
    const supported = (
      PerformanceObserver as unknown as { supportedEntryTypes?: readonly string[] }
    ).supportedEntryTypes;
    if (!supported || !supported.includes('longtask')) return null;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        observedLongTasks += 1;
        observedLongTaskMs += entry.duration;
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
    return observer;
  } catch {
    return null;
  }
}

/** 与 scheduler.useWindowLifecycle 相同的兜底判定，聚合为分布计数 */
function collectLifecycleStats(): PerfLifecycleStats {
  const state = useWindowStore.getState();
  const counts: Record<WindowLifecycle, number> = {
    focused: 0,
    visible: 0,
    background: 0,
    frozen: 0,
  };
  const topId = state.focusStack[state.focusStack.length - 1];
  let total = 0;
  for (const win of Object.values(state.windows)) {
    total += 1;
    const lifecycle =
      state.lifecycles[win.id] ??
      (win.minimized ? 'background' : win.id === topId ? 'focused' : 'visible');
    counts[lifecycle] += 1;
  }
  return { counts, totalWindows: total };
}

function buildMemoryStats(): PerfMemoryStats {
  if (!schedulerRecord) {
    return { usedWeight: 0, budget: 0, overBudget: false, frozenCount: 0, pendingFreezeCount: 0 };
  }
  return {
    usedWeight: schedulerRecord.usedWeight,
    budget: schedulerRecord.budget,
    overBudget: schedulerRecord.usedWeight > schedulerRecord.budget,
    frozenCount: schedulerRecord.frozenCount,
    pendingFreezeCount: schedulerRecord.pendingFreezeCount,
  };
}

function buildSchedulerStats(): PerfSchedulerStats {
  return {
    recomputeCount,
    lastRecomputeMs: schedulerRecord ? round1(schedulerRecord.recomputeMs) : 0,
    lastOcclusionMode: schedulerRecord?.occlusionMode ?? 'none',
    lastOcclusionDirtyCount: schedulerRecord?.occlusionDirtyCount ?? 0,
    lastOcclusionWindowCount: schedulerRecord?.occlusionWindowCount ?? 0,
  };
}

function flush(at: number): void {
  const frame = summarizeFrameDeltas(frameDeltas);
  frameDeltas = [];
  if (longTaskObserver) {
    frame.longTasks = observedLongTasks;
    frame.longTaskTotalMs = round1(observedLongTaskMs);
    observedLongTasks = 0;
    observedLongTaskMs = 0;
  }
  const sample: PerfSample = {
    at,
    intervalMs,
    frame,
    lifecycle: collectLifecycleStats(),
    memory: buildMemoryStats(),
    scheduler: buildSchedulerStats(),
  };
  lastSample = sample;
  for (const listener of [...listeners]) {
    try {
      listener(sample);
    } catch {
      // 订阅方异常不拖垮采集循环
    }
  }
}

// ============================================================================
// 开关 / 订阅（O15 消费的稳定接口）
// ============================================================================

export function isPerfMonitorRunning(): boolean {
  return running;
}

/** 引用计数：StageManager / DevPanel 等持有者共享同一 rAF 循环 */
let ownerCount = 0;

/**
 * 启动采样循环（幂等：已运行时仅更新 intervalMs）。
 * 返回停止函数（等价于 stopPerfMonitor）。
 *
 * 生产路径请优先用 `acquirePerfMonitor()`：裸 start/stop 不会维护持有者计数，
 * 容易在 StageManager 退出后仍被 DevPanel 或其它调用方留下常驻 rAF。
 */
export function startPerfMonitor(options?: PerfMonitorOptions): () => void {
  if (options?.intervalMs != null) {
    intervalMs = Math.max(50, options.intervalMs);
  }
  if (running) return stopPerfMonitor;
  running = true;
  longTaskObserver = tryObserveLongTasks();
  observedLongTasks = 0;
  observedLongTaskMs = 0;
  frameDeltas = [];
  lastTick = nowTs();
  lastFlush = lastTick;

  const tick = () => {
    if (!running) return;
    const ts = nowTs();
    const delta = ts - lastTick;
    frameDeltas.push(delta);
    lastTick = ts;
    // ACR 降级：连续帧 >33ms → 通知（DESIGN §4.3）
    const advanced = advanceSlowFrameStreak(
      { consecutive: consecutiveSlowFrames, notified: degradeNotified },
      delta,
    );
    consecutiveSlowFrames = advanced.state.consecutive;
    degradeNotified = advanced.state.notified;
    if (advanced.shouldNotify && degradeListeners.size > 0) {
      const info = {
        consecutiveSlowFrames,
        lastFrameMs: delta,
      };
      for (const listener of [...degradeListeners]) {
        try {
          listener(info);
        } catch {
          /* 订阅方异常不拖垮采集 */
        }
      }
    }
    if (ts - lastFlush >= intervalMs) {
      flush(ts);
      lastFlush = ts;
    }
    rafHandle = requestFrame(tick);
  };
  rafHandle = requestFrame(tick);
  return stopPerfMonitor;
}

/**
 * 获取一次 monitor 持有权。最后一个持有者释放时才真正 stop。
 * StageManager.start / WorkbenchDevPanel 必须走本接口，禁止只 start 不 release。
 */
export function acquirePerfMonitor(options?: PerfMonitorOptions): () => void {
  ownerCount += 1;
  startPerfMonitor(options);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    ownerCount = Math.max(0, ownerCount - 1);
    if (ownerCount === 0) stopPerfMonitor();
  };
}

/** 强制停止采样；同时清零持有者计数（与 acquire 释放路径一致，防泄漏） */
export function stopPerfMonitor(): void {
  ownerCount = 0;
  if (!running) return;
  running = false;
  cancelFrame(rafHandle);
  longTaskObserver?.disconnect();
  longTaskObserver = null;
}

/**
 * 订阅性能样本；仅在 monitor 运行中收到推送（约每 intervalMs 一次）。
 * 返回退订函数。订阅本身不会启动采集（启动是显式的开发期开关）。
 */
export function subscribePerfMonitor(listener: PerfMonitorListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 订阅 ACR 演出自动降级（连续慢帧）。
 * 不要求 monitor 已启动也可订阅；仅在运行中的 rAF 循环里触发。
 * StageManager 在 start() 时挂上，把活跃 pacer 降为 instant。
 */
export function subscribePerfDegrade(listener: PerfDegradeListener): () => void {
  degradeListeners.add(listener);
  return () => {
    degradeListeners.delete(listener);
  };
}

/** 当前连续慢帧数（测试 / DevPanel） */
export function getConsecutiveSlowFrames(): number {
  return consecutiveSlowFrames;
}

/** 最近一次样本（未采集过为 null）；可用于订阅前回填 HUD 初值 */
export function getLastPerfSample(): PerfSample | null {
  return lastSample;
}

/** 仅供单元测试：停止并清空全部单例状态 */
export function resetPerfMonitorForTests(): void {
  stopPerfMonitor();
  ownerCount = 0;
  listeners.clear();
  degradeListeners.clear();
  frameDeltas = [];
  lastSample = null;
  schedulerRecord = null;
  recomputeCount = 0;
  observedLongTasks = 0;
  observedLongTaskMs = 0;
  consecutiveSlowFrames = 0;
  degradeNotified = false;
  intervalMs = PERF_MONITOR_DEFAULT_INTERVAL_MS;
}
