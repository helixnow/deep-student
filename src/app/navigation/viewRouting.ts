import type { CurrentView } from '@/types/navigation';
import { pageLifecycleTracker } from '@/debug-panel/services/pageLifecycleTracker';
import { getCardsHubSwitchDirection } from './cardsHub';

// 🚀 LRU 视图淘汰：限制保活视图数量，避免内存无限增长
/** 始终保活的视图（不参与 LRU 淘汰） */
export const PINNED_VIEWS: Set<CurrentView> = new Set(['chat-v2']);
/**
 * 暂缓驱逐的视图（2026-07 移动端审计 残留#3）：该视图的关键状态是纯本地
 * state（pdf-reader 已打开的 PDF 与页码），
 * 被 LRU 驱逐即清零且不可恢复。淘汰时优先驱逐其他视图，仅当候选里只剩它们
 * 时才驱逐（软保护，不是 pinned——总保活上限不变，不抬高低端机内存天花板）。
 */
export const EVICTION_DEFERRED_VIEWS: Set<CurrentView> = new Set(['pdf-reader']);
/** 最大保活视图数量（含 pinned）
 *  桌面用户常用 6-7 个视图，设为 8 避免频繁驱逐导致的重新挂载开销；
 *  搭配 useMemo 缓存子树后，保活视图的 re-render 成本接近零。
 *  触屏设备（PERF-1）：低端 Android 同时保活 8 棵完整视图子树内存压力大，降为 4。
 *  取值在每次淘汰时动态读取，旋转/分屏后自然收敛，无需监听。
 */
export const MAX_ALIVE_VIEWS_DESKTOP = 8;
export const MAX_ALIVE_VIEWS_TOUCH = 4;
export const getMaxAliveViews = (): number => {
  try {
    return window.matchMedia?.('(pointer: coarse)').matches
      ? MAX_ALIVE_VIEWS_TOUCH
      : MAX_ALIVE_VIEWS_DESKTOP;
  } catch {
    return MAX_ALIVE_VIEWS_DESKTOP;
  }
};

/**
 * setCurrentView 的视图访问栈推进与切换方向（仅 <768px 的层滑动画消费）。
 * 原地修改 navStack，并在需要时调用 setViewNavDirection；在 setCurrentView 的
 * startTransition 内与视图切换同批调用。
 */
export function advanceViewNavStack(
  navStack: CurrentView[],
  prevView: CurrentView,
  targetView: CurrentView,
  setViewNavDirection: (direction: 1 | -1) => void,
): void {
  const cardsHubDirection = getCardsHubSwitchDirection(prevView, targetView);
  if (cardsHubDirection !== null) {
    // 闪卡中心分区互切：兄弟分区横向翻页（方向按分区顺序），栈顶替换而非压栈
    if (navStack[navStack.length - 1] === prevView) {
      navStack[navStack.length - 1] = targetView;
    } else {
      navStack.push(targetView);
    }
    setViewNavDirection(cardsHubDirection);
  } else if (targetView !== prevView && navStack[navStack.length - 1] !== targetView) {
    const existingIdx = navStack.lastIndexOf(targetView);
    if (existingIdx >= 0) {
      navStack.length = existingIdx + 1;
      setViewNavDirection(-1);
    } else {
      navStack.push(targetView);
      if (navStack.length > 30) navStack.shift();
      setViewNavDirection(1);
    }
  }
}

/**
 * setCurrentView 的 LRU 更新（setVisitedViews 的 updater）：记录 targetView 的访问
 * 时间戳，超过 getMaxAliveViews() 时淘汰最久未访问的非 pinned 视图。
 */
export function computeNextVisitedViews(
  prev: Map<CurrentView, number>,
  targetView: CurrentView,
): Map<CurrentView, number> {
  const now = Date.now();
  const next = new Map(prev);
  next.set(targetView, now);

  // 淘汰逻辑：仅在超出上限时移除最旧的非 pinned 视图。
  // 两轮扫描：先跳过 EVICTION_DEFERRED_VIEWS（本地状态驱逐即丢的视图），
  // 候选里只剩暂缓视图时才回退为普通 LRU，保证上限恒成立。
  if (next.size > getMaxAliveViews()) {
    let oldestView: CurrentView | null = null;
    let oldestTime = Infinity;
    for (const deferProtected of [true, false]) {
      for (const [view, ts] of next) {
        if (PINNED_VIEWS.has(view)) continue;
        if (view === targetView) continue;
        if (deferProtected && EVICTION_DEFERRED_VIEWS.has(view)) continue;
        if (ts < oldestTime) {
          oldestTime = ts;
          oldestView = view;
        }
      }
      if (oldestView) break;
    }
    if (oldestView) {
      next.delete(oldestView);
      pageLifecycleTracker.log(
        'app',
        'App.tsx',
        'view_evict',
        `LRU evicted: ${oldestView} (%.0fms old)`.replace('%.0fms', `${now - oldestTime}ms`)
      );
    }
  }

  return next;
}
