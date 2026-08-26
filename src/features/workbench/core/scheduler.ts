/**
 * 生命周期调度器（主责 P1 完整版；O10 极致打磨升级，已有导出签名冻结）
 *
 * 四档判定（设计文档 §5.1–5.3，不变量保持）：
 * - focused    焦点栈顶（非 minimized）
 * - visible    非焦点但有可见面积（部分遮挡仍是 visible）
 * - background 最小化，或被上层窗口矩形并集完全遮挡
 * - frozen     memoryWeight 预算超限时，对 background 按 lastFocusedAt LRU 冻结
 *
 * 预算：默认 12 点；macOS（navigator.platform 检测）9 点。
 * focused / visible 永不冻结；聚焦唤醒（focus）后窗口立即离开 background，
 * 下一轮重算即解冻。
 *
 * suspend 契约（2026-08 Wave2）：**dirty 窗永不 frozen**。冻结候选若
 * isWindowDirty(windowId) 为真、或应用 AppDefinition.canSuspend(instanceKey)
 * 同步返回 false，则跳过且不计入预算回收（脏窗仍占预算，超限时多冻
 * 干净窗）。canSuspend 的 dirty 查询必须同步；prepareSuspend 仅供
 * 非热路径显式调用，调度器绝不自动 prepare+冻。
 *
 * O10 新增（全部为叠加能力，不改变四档语义）：
 * 1. 遮挡增量化：内部走 computeOcclusionIncremental（只重算受影响窗口），
 *    并产出 visibleRatio 供 visible 细分档。
 * 2. 渲染提示 render hints：visible 档细分「完全可见 / 部分可见」，输出建议
 *    节流间隔 throttleMs；焦点切换给原焦点窗一段 defocus 宽限（先 120ms 档
 *    平滑过渡再落到目标档，避免流式渲染骤停骤起）；滚动/流式期间
 *    reportSchedulerActivity 可对非焦点 visible 窗动态加倍降频。
 *    窗口拖/缩必须用 beginSchedulerDragActivity（begin/end），禁止 400ms 续期：
 *    长拖期间只在首尾刷新 hint；拖拽中连 focused 窗也降频，把帧让给跟手。
 *    消费接口：getWindowRenderHint / subscribeRenderHints / useWindowRenderHint。
 * 3. 预算冻结平滑：超预算候选先进入 FREEZE_GRACE_MS「即将冻结」宽限
 *    （hint.freezeImminent = true），宽限内解除压力或被聚焦则取消；
 *    requestWakePrefetch 可在真正聚焦前把 frozen 窗预取回 background
 *    （DOM 预重建，唤醒即时呈现）。
 * 4. 性能推送：每轮重算把耗时 / 遮挡统计 / 预算占用推给 perfMonitor（O15 消费）。
 */
import { useSyncExternalStore } from 'react';
import { useWindowStore } from './windowStore';
import { appRegistry } from './appRegistry';
import {
  createOcclusionCache,
  computeOcclusionIncremental,
  getLastOcclusionStats,
  type OcclusionCache,
  type OcclusionEntry,
} from './occlusion';
import { recordSchedulerSample } from './perfMonitor';
import { isWindowDirty } from './windowCloseGuard';
import type { WindowLifecycle, WorkbenchWindow } from './types';
import { computeTiledFrame, getTilingRatioForWindow } from './tiling';

export const DEFAULT_MEMORY_BUDGET = 12;
export const MACOS_MEMORY_BUDGET = 9;

// —— O10：平滑与降频参数（导出供消费方对齐） ——
/** 预算冻结前的「即将冻结」宽限时长 */
export const FREEZE_GRACE_MS = 2500;
/** requestWakePrefetch 默认预取豁免时长 */
export const WAKE_PREFETCH_MS = 4000;
/** 焦点切换后原焦点窗的渲染过渡宽限时长 */
export const FOCUS_TRANSITION_MS = 900;
/** reportSchedulerActivity 单次报告的默认衰减时长 */
export const ACTIVITY_DECAY_MS = 600;
/** 建议节流间隔（ms）：focused 全速 */
export const RENDER_THROTTLE_FOCUSED = 0;
/**
 * 拖/缩手势中 focused 窗的建议节流（ms）。
 * ANTI-REGRESSION：不得在拖拽期把 focused 保持为 0——Chat 流式 / 重内容动画
 * 会与壳层 translate 抢帧，跨 WebView2/WKWebView/WebKitGTK 都会表现为起拖卡顿。
 */
export const RENDER_THROTTLE_DRAG_FOCUSED = 500;
/** 建议节流间隔（ms）：visible 且完全可见 */
export const RENDER_THROTTLE_VISIBLE_FULL = 250;
/** 建议节流间隔（ms）：visible 且部分被遮挡/越界（设计文档 §5.1 ~500ms） */
export const RENDER_THROTTLE_VISIBLE_PARTIAL = 500;
/** 建议节流间隔（ms）：defocus 过渡期（避免 0 → 500 骤降） */
export const RENDER_THROTTLE_TRANSITION = 120;
/** 建议节流间隔：background / frozen（暂停渲染） */
export const RENDER_THROTTLE_PAUSED = Number.POSITIVE_INFINITY;
/** 全局活动（滚动/流式/拖拽）期间非焦点 visible 窗的节流放大系数 */
const ACTIVITY_THROTTLE_MULTIPLIER = 2;
/** 活动期节流上限 */
const ACTIVITY_THROTTLE_CAP_MS = 1000;
/** visibleRatio ≥ 此值视为「完全可见」 */
const FULL_VISIBILITY_EPSILON = 0.995;
/** 瞬态定时器的补偿余量（确保触发时宽限已过期） */
const TRANSIENT_TIMER_SLACK_MS = 25;

let budgetOverride: number | null = null;
let freezeGraceOverride: number | null = null;
let nowProvider: (() => number) | null = null;

function now(): number {
  return nowProvider ? nowProvider() : Date.now();
}

/** 诊断面板 / 测试可临时覆盖预算；传 null 恢复平台默认 */
export function setMemoryBudgetOverride(points: number | null): void {
  budgetOverride = points;
}

export function getMemoryBudget(): number {
  if (budgetOverride != null) return budgetOverride;
  const platform =
    typeof navigator !== 'undefined' && typeof navigator.platform === 'string'
      ? navigator.platform
      : '';
  return /mac/i.test(platform) ? MACOS_MEMORY_BUDGET : DEFAULT_MEMORY_BUDGET;
}

/** 测试 / 调优可覆盖冻结宽限；传 null 恢复默认 FREEZE_GRACE_MS；0 = 立即冻结 */
export function setFreezeGraceOverride(ms: number | null): void {
  freezeGraceOverride = ms;
}

export function getFreezeGraceMs(): number {
  return freezeGraceOverride ?? FREEZE_GRACE_MS;
}

/** 仅供单元测试：注入时钟（宽限/过渡的确定性推进）；传 null 恢复 Date.now */
export function setSchedulerNowForTests(provider: (() => number) | null): void {
  nowProvider = provider;
}

function memoryWeightOf(win: WorkbenchWindow): number {
  return appRegistry.get(win.typeId)?.memoryWeight ?? 1;
}

function keepsAliveWhenOccluded(win: WorkbenchWindow): boolean {
  return appRegistry.get(win.typeId)?.keepAliveWhenOccluded === true;
}

/**
 * suspend 契约（AppDefinition.canSuspend）的热路径同步判定。
 *
 * 约定：canSuspend 的 dirty 类查询必须同步（isContentDirty / isWindowDirty
 * 已是同步）。这里绝不 await——返回 Promise 时按「可冻」处理，异步结果
 * 只供非热路径调用方使用；回调抛异常按「不可冻」处理，坏掉的检查器
 * 不能反过来吞掉用户未保存的内存态。
 */
function canSuspendNow(win: WorkbenchWindow): boolean {
  const canSuspend = appRegistry.get(win.typeId)?.canSuspend;
  if (!canSuspend) return true;
  try {
    return canSuspend(win.instanceKey) !== false;
  } catch {
    return false;
  }
}

function sameLifecycles(
  a: Record<string, WindowLifecycle>,
  b: Record<string, WindowLifecycle>,
): boolean {
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  for (const key of keysA) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/** 供 WindowBody / 应用消费的 hook（签名冻结） */
export function useWindowLifecycle(windowId: string): WindowLifecycle {
  return useWindowStore((s) => {
    const explicit = s.lifecycles[windowId];
    if (explicit) return explicit;
    const win = s.windows[windowId];
    if (!win || win.minimized) return 'background';
    const topId = s.focusStack[s.focusStack.length - 1];
    return topId === windowId ? 'focused' : 'visible';
  });
}

type RafLike = (cb: () => void) => void;

const scheduleFrame: RafLike =
  typeof requestAnimationFrame === 'function'
    ? (cb) => requestAnimationFrame(() => cb())
    : (cb) => {
        setTimeout(cb, 16);
      };

// ============================================================================
// O10：模块级瞬态状态（不进 store、不进快照）
// ============================================================================

let occlusionCache: OcclusionCache = createOcclusionCache();
/** 最近一轮遮挡明细（visibleRatio 来源） */
let lastOcclusionDetail: Record<string, OcclusionEntry> = {};
/** windowId -> 首次成为冻结候选的时刻（宽限计时起点） */
const freezeCandidateSince = new Map<string, number>();
/** 本轮处于「即将冻结」宽限期的窗口 */
let pendingFreezeIds: ReadonlySet<string> = new Set<string>();
/** windowId -> 唤醒预取豁免截止时刻 */
const wakePrefetchUntil = new Map<string, number>();
/** windowId -> 失焦渲染过渡宽限截止时刻 */
const defocusGraceUntil = new Map<string, number>();
/** 全局活动（滚动/流式/拖拽）截止时刻 */
let activityUntil = 0;
let activityKind: SchedulerActivityKind | null = null;
/**
 * 拖拽是有明确 begin/end 的持续交互，不能靠每 400ms 续期 activityUntil。
 * 续期会反复安排 rAF/瞬态 timer；深度计数同时支持多指针/多窗口的防御性嵌套。
 */
let persistentDragActivityDepth = 0;
/** 上一轮焦点栈顶（侦测焦点切换） */
let lastTopId: string | null = null;

/** 运行中的调度循环句柄（startScheduler 注册；瞬态定时器只在循环存在时武装） */
let activeLoop: {
  schedule: () => void;
  armTimer: (deadline: number | null) => void;
} | null = null;

// ============================================================================
// O10：渲染提示（render hints）
// ============================================================================

export type SchedulerActivityKind = 'scroll' | 'stream' | 'drag';

export type WindowVisibilityLevel = 'full' | 'partial' | 'hidden';

export interface WindowRenderHint {
  lifecycle: WindowLifecycle;
  /** full = 完全可见；partial = 部分被遮挡或越界；hidden = 无可见面积 */
  visibility: WindowVisibilityLevel;
  /** 可见面积比例 0–1（含桌面裁剪与上层覆盖），保留 3 位小数 */
  visibleRatio: number;
  /** 建议的流式/重渲染节流间隔；0 = 全速；Infinity = 暂停 */
  throttleMs: number;
  /** true = 处于「即将冻结」宽限期（消费方可提示或提前收敛） */
  freezeImminent: boolean;
  /** 'defocus' = 失焦过渡宽限中（throttleMs 已按过渡档收窄） */
  transition: 'defocus' | null;
}

const FALLBACK_HINTS: Record<WindowLifecycle, WindowRenderHint> = {
  focused: Object.freeze({
    lifecycle: 'focused',
    visibility: 'full',
    visibleRatio: 1,
    throttleMs: RENDER_THROTTLE_FOCUSED,
    freezeImminent: false,
    transition: null,
  }),
  visible: Object.freeze({
    lifecycle: 'visible',
    visibility: 'full',
    visibleRatio: 1,
    throttleMs: RENDER_THROTTLE_VISIBLE_FULL,
    freezeImminent: false,
    transition: null,
  }),
  background: Object.freeze({
    lifecycle: 'background',
    visibility: 'hidden',
    visibleRatio: 0,
    throttleMs: RENDER_THROTTLE_PAUSED,
    freezeImminent: false,
    transition: null,
  }),
  frozen: Object.freeze({
    lifecycle: 'frozen',
    visibility: 'hidden',
    visibleRatio: 0,
    throttleMs: RENDER_THROTTLE_PAUSED,
    freezeImminent: false,
    transition: null,
  }),
};

const hintMap = new Map<string, WindowRenderHint>();
const hintListeners = new Set<() => void>();
let hintRefreshScheduled = false;

function roundRatio(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
}

function hintEquals(a: WindowRenderHint, b: WindowRenderHint): boolean {
  return (
    a.lifecycle === b.lifecycle &&
    a.visibility === b.visibility &&
    a.visibleRatio === b.visibleRatio &&
    a.throttleMs === b.throttleMs &&
    a.freezeImminent === b.freezeImminent &&
    a.transition === b.transition
  );
}

function computeHint(
  windowId: string,
  lifecycle: WindowLifecycle,
  nowMs: number,
): WindowRenderHint {
  const detail = lastOcclusionDetail[windowId];
  const fallbackRatio = lifecycle === 'focused' || lifecycle === 'visible' ? 1 : 0;
  const ratio = roundRatio(detail ? detail.visibleRatio : fallbackRatio);
  const visibility: WindowVisibilityLevel =
    ratio >= FULL_VISIBILITY_EPSILON ? 'full' : ratio > 0 ? 'partial' : 'hidden';

  let throttleMs: number;
  let transition: 'defocus' | null = null;
  if (lifecycle === 'focused') {
    // 拖/缩：焦点窗也降频（流式/动画让路）；静止时仍为 0 全速
    throttleMs =
      persistentDragActivityDepth > 0 ? RENDER_THROTTLE_DRAG_FOCUSED : RENDER_THROTTLE_FOCUSED;
  } else if (lifecycle === 'visible') {
    throttleMs =
      visibility === 'full' ? RENDER_THROTTLE_VISIBLE_FULL : RENDER_THROTTLE_VISIBLE_PARTIAL;
    if ((defocusGraceUntil.get(windowId) ?? 0) > nowMs) {
      // 失焦过渡：先收窄到过渡档，宽限过后再落到目标档（避免骤停）
      transition = 'defocus';
      throttleMs = Math.min(throttleMs, RENDER_THROTTLE_TRANSITION);
    } else if (persistentDragActivityDepth > 0 || activityUntil > nowMs) {
      // 滚动/流式/拖拽期间：给交互路径让出帧预算
      throttleMs = Math.min(throttleMs * ACTIVITY_THROTTLE_MULTIPLIER, ACTIVITY_THROTTLE_CAP_MS);
    }
  } else {
    throttleMs = RENDER_THROTTLE_PAUSED;
  }

  return {
    lifecycle,
    visibility,
    visibleRatio: ratio,
    throttleMs,
    freezeImminent: pendingFreezeIds.has(windowId),
    transition,
  };
}

/** 按当前 store + 瞬态状态重建 hintMap；有变化才通知订阅者 */
function refreshRenderHints(force = false): void {
  // 跟手期间禁止推送 hint：throttleMs 翻转会唤醒全部 WindowBody React 树，
  // 与 translate3d 抢主线程。深度仍由 computeHint 可读；松手后再 refresh。
  // force：仅 beginSchedulerDragActivity({ refreshHints: true }) 显式打开。
  if (persistentDragActivityDepth > 0 && !force) return;

  const state = useWindowStore.getState();
  const nowMs = now();
  const topId = state.focusStack.length > 0 ? state.focusStack[state.focusStack.length - 1] : null;
  let changed = false;
  const alive = new Set<string>();
  for (const win of Object.values(state.windows)) {
    alive.add(win.id);
    const lifecycle =
      state.lifecycles[win.id] ??
      (win.minimized ? 'background' : win.id === topId ? 'focused' : 'visible');
    const next = computeHint(win.id, lifecycle, nowMs);
    const prev = hintMap.get(win.id);
    if (!prev || !hintEquals(prev, next)) {
      hintMap.set(win.id, next);
      changed = true;
    }
  }
  for (const id of [...hintMap.keys()]) {
    if (!alive.has(id)) {
      hintMap.delete(id);
      changed = true;
    }
  }
  if (changed) {
    for (const listener of [...hintListeners]) listener();
  }
}

/** rAF 防抖合并的 hint 刷新（activity 报告等高频入口使用） */
function scheduleHintRefresh(): void {
  if (hintRefreshScheduled) return;
  hintRefreshScheduled = true;
  scheduleFrame(() => {
    hintRefreshScheduled = false;
    refreshRenderHints();
  });
}

/**
 * 读取窗口渲染提示。scheduler 未跑过重算时返回按焦点栈派生的兜底常量
 * （引用稳定，可安全用于 useSyncExternalStore）。
 */
export function getWindowRenderHint(windowId: string): WindowRenderHint {
  const hint = hintMap.get(windowId);
  if (hint) return hint;
  const state = useWindowStore.getState();
  const win = state.windows[windowId];
  if (!win || win.minimized) return FALLBACK_HINTS.background;
  const explicit = state.lifecycles[windowId];
  if (explicit) return FALLBACK_HINTS[explicit];
  const topId = state.focusStack[state.focusStack.length - 1];
  return topId === windowId ? FALLBACK_HINTS.focused : FALLBACK_HINTS.visible;
}

/** 订阅渲染提示变化（任意窗口 hint 变化即通知一次）；返回退订函数 */
export function subscribeRenderHints(listener: () => void): () => void {
  hintListeners.add(listener);
  return () => {
    hintListeners.delete(listener);
  };
}

/** React hook：窗口渲染提示（引用稳定，仅在字段变化时触发重渲染） */
export function useWindowRenderHint(windowId: string): WindowRenderHint {
  return useSyncExternalStore(subscribeRenderHints, () => getWindowRenderHint(windowId));
}

/** 窗口是否处于「即将冻结」宽限期 */
export function isFreezeImminent(windowId: string): boolean {
  return pendingFreezeIds.has(windowId);
}

/**
 * 报告全局高频活动（滚动 / 流式输出 / 拖拽）。活动期内非焦点 visible 窗的
 * 建议节流间隔加倍，给交互路径让出帧预算；到期自动恢复（调度循环运行时）。
 * 高频调用安全：hint 刷新按 rAF 防抖合并。
 */
export function reportSchedulerActivity(
  kind: SchedulerActivityKind,
  durationMs = ACTIVITY_DECAY_MS,
): void {
  const until = now() + Math.max(0, durationMs);
  if (until > activityUntil) activityUntil = until;
  activityKind = kind;
  scheduleHintRefresh();
  if (activeLoop) armTransientTimer(now());
}

/**
 * 开始一个有明确生命周期的拖拽活动，返回幂等释放函数。
 *
 * 窗口拖拽必须使用本接口，不要定时调用 reportSchedulerActivity 续期。
 *
 * ANTI-REGRESSION：
 * - 起拖路径默认 **不** scheduleHintRefresh。延后刷新仍会在跟手中途
 *   唤醒全部 WindowBody（Chat/Content 因 throttleMs 翻转重渲），表现为
 *   「拖着拖着卡一下」。拖拽期降频改由 shellGestureFlags 同步旗 + CSS /
 *   流式 imperative 检查承担。
 * - 松手（release）时必须 refresh，恢复静止档 throttle。
 * - `refreshHints: true` 仅留给测试或非跟手场景显式打开。
 */
export function beginSchedulerDragActivity(options?: {
  refreshHints?: boolean;
}): () => void {
  persistentDragActivityDepth += 1;
  const refreshOnBegin = options?.refreshHints === true;
  let hintTimer: ReturnType<typeof setTimeout> | 0 = 0;
  if (refreshOnBegin && persistentDragActivityDepth === 1) {
    if (typeof setTimeout === 'function') {
      hintTimer = setTimeout(() => {
        hintTimer = 0;
        refreshRenderHints(true);
      }, 48);
    } else {
      refreshRenderHints(true);
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (hintTimer) {
      clearTimeout(hintTimer);
      hintTimer = 0;
    }
    persistentDragActivityDepth = Math.max(0, persistentDragActivityDepth - 1);
    if (persistentDragActivityDepth === 0) scheduleHintRefresh();
  };
}

/** 当前全局活动状态（诊断用）；不活跃返回 null */
export function getSchedulerActivity(): { kind: SchedulerActivityKind; until: number } | null {
  if (persistentDragActivityDepth > 0) return { kind: 'drag', until: Number.POSITIVE_INFINITY };
  if (!activityKind || activityUntil <= now()) return null;
  return { kind: activityKind, until: activityUntil };
}

/**
 * 唤醒预取：把 frozen 窗口在真正聚焦前预取回 background（DOM 隐藏重建），
 * 使点击唤醒时内容即时呈现。适合 Dock hover / 窗口切换器高亮 / 俯瞰 hover
 * 等「即将聚焦」信号。豁免期内该窗不会被预算冻结；到期后若预算仍超限，
 * 会重新进入冻结宽限流程。不抢焦点、不改 z 序。
 */
export function requestWakePrefetch(windowId: string, durationMs = WAKE_PREFETCH_MS): void {
  const state = useWindowStore.getState();
  if (!state.windows[windowId]) return;
  wakePrefetchUntil.set(windowId, now() + Math.max(0, durationMs));
  if (activeLoop) activeLoop.schedule();
  else recomputeLifecycles();
}

/** 仅供单元测试：清空 O10 瞬态状态（遮挡缓存 / 宽限 / 预取 / hints） */
export function resetSchedulerTransientsForTests(): void {
  occlusionCache = createOcclusionCache();
  lastOcclusionDetail = {};
  freezeCandidateSince.clear();
  pendingFreezeIds = new Set<string>();
  wakePrefetchUntil.clear();
  defocusGraceUntil.clear();
  activityUntil = 0;
  activityKind = null;
  persistentDragActivityDepth = 0;
  lastTopId = null;
  hintMap.clear();
}

// ============================================================================
// 生命周期重算
// ============================================================================

/**
 * 全量重算生命周期并写回 store.setLifecycles（遮挡部分为增量重算）。
 * 由 startScheduler 在窗口增删 / 移动提交 / 焦点变化 / 桌面尺寸变化时防抖触发；
 * 也可直接调用（同步、幂等，无变化时不写 store）。
 */
export function recomputeLifecycles(): void {
  const startedAt = typeof performance !== 'undefined' ? performance.now() : 0;
  const state = useWindowStore.getState();
  const wins = Object.values(state.windows);
  const next: Record<string, WindowLifecycle> = {};
  const nowMs = now();
  const budget = getMemoryBudget();
  const pending = new Set<string>();
  let usedWeight = 0;
  let frozenCount = 0;

  // occlusion 的冻结签名只接收窗口自身 frame。把受管窗口的当前派生几何
  // 物化为 floating clone，使遮挡计算与 WindowShell 的 active pair ratio 一致。
  const occlusionWins = wins.map((win) => {
    if (win.displayMode === 'floating') return win;
    const frame = computeTiledFrame(win.displayMode, {
      desktopSize: state.desktopSize,
      margin: 0,
      ratio:
        win.displayMode === 'tiled-left' || win.displayMode === 'tiled-right'
          ? getTilingRatioForWindow(state.windows, state.tilingRatios, win.id)
          : undefined,
    });
    return frame ? { ...win, frame, displayMode: 'floating' as const } : win;
  });
  lastOcclusionDetail = computeOcclusionIncremental(
    occlusionCache,
    occlusionWins,
    state.desktopSize,
  );
  const occlusionStats = getLastOcclusionStats(occlusionCache);

  if (wins.length > 0) {
    const topId = state.focusStack.length > 0 ? state.focusStack[state.focusStack.length - 1] : null;

    for (const win of wins) {
      if (win.minimized) next[win.id] = 'background';
      else if (win.id === topId) next[win.id] = 'focused';
      else if (lastOcclusionDetail[win.id]?.occluded && !keepsAliveWhenOccluded(win)) {
        next[win.id] = 'background';
      }
      else next[win.id] = 'visible';
    }

    // 焦点切换平滑：原焦点窗仍可见时给一段渲染过渡宽限（hint 层生效）
    if (topId !== lastTopId) {
      if (lastTopId && next[lastTopId] === 'visible') {
        defocusGraceUntil.set(lastTopId, nowMs + FOCUS_TRANSITION_MS);
      }
      lastTopId = topId;
    }

    // 预算冻结：超预算时从 background 里按 lastFocusedAt 最旧优先冻结。
    // O10：候选先进入「即将冻结」宽限（graceMs），宽限内解除压力/被聚焦即取消；
    // 唤醒预取豁免期内的窗口跳过（保持 background，DOM 可重建）。
    // suspend 契约：dirty 窗永不 frozen——frozen 会卸载 React 子树，未保存的
    // 内存态会随之丢失。脏窗（isWindowDirty 或应用 canSuspend 返回 false）
    // 直接跳过且【不扣 used 预算】：它仍占着内存，超限压力顺延到更旧的
    // 干净窗身上（宁可多冻干净窗，绝不冻脏窗）。本轮不自动 prepareSuspend，
    // 脏窗一律保持 background。
    const graceMs = getFreezeGraceMs();
    let used = wins.reduce((sum, win) => sum + memoryWeightOf(win), 0);
    if (used > budget) {
      const candidates = wins
        .filter((win) => next[win.id] === 'background')
        .sort((a, b) => a.lastFocusedAt - b.lastFocusedAt);
      const selected = new Set<string>();
      for (const win of candidates) {
        if (used <= budget) break;
        if ((wakePrefetchUntil.get(win.id) ?? 0) > nowMs) continue; // 预取豁免
        if (isWindowDirty(win.id) || !canSuspendNow(win)) continue; // 脏窗不冻、不扣预算
        selected.add(win.id);
        const since = freezeCandidateSince.get(win.id);
        if (since == null) freezeCandidateSince.set(win.id, nowMs);
        if ((since != null && nowMs - since >= graceMs) || graceMs <= 0) {
          next[win.id] = 'frozen';
        } else {
          pending.add(win.id);
        }
        // 宽限期内按「将被回收」计入，保证只选必要数量的候选
        used -= memoryWeightOf(win);
      }
      for (const id of [...freezeCandidateSince.keys()]) {
        if (!selected.has(id)) freezeCandidateSince.delete(id);
      }
    } else {
      freezeCandidateSince.clear();
    }

    for (const win of wins) {
      if (next[win.id] === 'frozen') frozenCount += 1;
      else usedWeight += memoryWeightOf(win);
    }
  } else {
    freezeCandidateSince.clear();
    lastTopId = null;
  }

  pendingFreezeIds = pending;

  // 瞬态清理：已关闭窗口 / 已过期条目
  for (const [id, until] of [...wakePrefetchUntil]) {
    if (!state.windows[id] || until <= nowMs) wakePrefetchUntil.delete(id);
  }
  for (const [id, until] of [...defocusGraceUntil]) {
    if (!state.windows[id] || until <= nowMs) defocusGraceUntil.delete(id);
  }

  if (!sameLifecycles(next, state.lifecycles)) {
    state.setLifecycles(next);
  }

  refreshRenderHints();
  armTransientTimer(nowMs);

  recordSchedulerSample({
    recomputeMs: typeof performance !== 'undefined' ? performance.now() - startedAt : 0,
    occlusionMode: occlusionStats?.mode ?? 'none',
    occlusionDirtyCount: occlusionStats?.dirtyCount ?? 0,
    occlusionWindowCount: wins.length,
    usedWeight,
    budget,
    frozenCount,
    pendingFreezeCount: pending.size,
  });
}

/**
 * 计算最近的瞬态截止时刻（冻结宽限 / 预取豁免 / 失焦过渡 / 全局活动），
 * 并让运行中的调度循环在该时刻后自动补一轮重算（无循环时为 no-op，
 * 直接调用方按需自行重算——测试即此模式）。
 */
function armTransientTimer(nowMs: number): void {
  if (!activeLoop) return;
  let earliest: number | null = null;
  const consider = (deadline: number) => {
    if (deadline > nowMs && (earliest == null || deadline < earliest)) earliest = deadline;
  };
  const graceMs = getFreezeGraceMs();
  for (const id of pendingFreezeIds) {
    const since = freezeCandidateSince.get(id);
    if (since != null) consider(since + graceMs);
  }
  for (const until of wakePrefetchUntil.values()) consider(until);
  for (const until of defocusGraceUntil.values()) consider(until);
  if (activityUntil > nowMs) consider(activityUntil);
  activeLoop.armTimer(earliest);
}

/**
 * 启动调度器：订阅 store，窗口集合 / 焦点栈 / 桌面尺寸变化时防抖 1 帧重算
 * （同帧多次变更合并为一轮）。返回停止函数。setLifecycles 的写回不会再次
 * 触发（只比较相关切片引用）。
 * O10：额外武装瞬态定时器，冻结宽限 / 预取豁免 / 失焦过渡 / 活动衰减到期后
 * 自动补一轮重算，无需外部事件驱动。
 */
/** 连续 desktopSize 变化时遮挡重算防抖（与 Desktop 160ms settle 对齐） */
const DESKTOP_SIZE_RECOMPUTE_DEBOUNCE_MS = 160;

export function startScheduler(): () => void {
  let disposed = false;
  let scheduled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let desktopSizeDebounce: ReturnType<typeof setTimeout> | null = null;

  const schedule = () => {
    if (disposed || scheduled) return;
    scheduled = true;
    scheduleFrame(() => {
      scheduled = false;
      if (!disposed) recomputeLifecycles();
    });
  };

  const loop = {
    schedule,
    armTimer: (deadline: number | null) => {
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
      if (disposed || deadline == null) return;
      const delay = Math.max(0, deadline - now()) + TRANSIENT_TIMER_SLACK_MS;
      timer = setTimeout(() => {
        timer = null;
        schedule();
      }, delay);
    },
  };
  activeLoop = loop;

  const unsubscribe = useWindowStore.subscribe((state, prev) => {
    if (
      state.windows !== prev.windows ||
      state.focusStack !== prev.focusStack ||
      state.tilingRatios !== prev.tilingRatios
    ) {
      if (desktopSizeDebounce != null) {
        clearTimeout(desktopSizeDebounce);
        desktopSizeDebounce = null;
      }
      schedule();
      return;
    }
    if (state.desktopSize !== prev.desktopSize) {
      // 交互式 resize：几何由 WindowShell 的 desktopSize selector 跟手；
      // 全量遮挡/生命周期重算防抖，避免每帧 O(N²) occlusion。
      if (desktopSizeDebounce != null) clearTimeout(desktopSizeDebounce);
      desktopSizeDebounce = setTimeout(() => {
        desktopSizeDebounce = null;
        schedule();
      }, DESKTOP_SIZE_RECOMPUTE_DEBOUNCE_MS);
    }
  });

  // 启动即算一遍（快照恢复后立即得到正确档位）
  schedule();

  return () => {
    disposed = true;
    if (timer != null) clearTimeout(timer);
    if (desktopSizeDebounce != null) clearTimeout(desktopSizeDebounce);
    if (activeLoop === loop) activeLoop = null;
    unsubscribe();
  };
}
