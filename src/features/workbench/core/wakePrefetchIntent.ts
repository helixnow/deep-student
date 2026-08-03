/**
 * wakePrefetchIntent — 「即将聚焦」UI 信号 → frozen 窗唤醒预取的接线层
 *
 * requestWakePrefetch（scheduler O10）本身幂等且 rAF 合并重算，但 hover /
 * 高亮类信号会高频重复触发（扫过 Dock、切换器连按）。这里加一层：
 * - 只对当前确实 frozen 的窗口触发（background/visible 窗预取是空操作，
 *   却仍会排一轮重算）；
 * - 同窗冷却去重（冷却窗口远小于 WAKE_PREFETCH_MS 豁免期，重复 hover
 *   仍能在豁免到期前续期，但不会每次事件都打调度器）。
 *
 * 消费方：Dock 图标 hover（DockItem）、窗口列表弹层高亮（DockWindowList）、
 * 窗口切换器高亮（WindowSwitcher）。agent 的 stageManager 有自己的
 * 心跳节奏，不走本层。
 */
import { requestWakePrefetch } from './scheduler';
import { useWindowStore } from './windowStore';

/** 同窗重复触发冷却（« WAKE_PREFETCH_MS = 4000，保证豁免可被续期） */
const INTENT_COOLDOWN_MS = 1000;

const lastIntentAt = new Map<string, number>();

/** 单窗「即将聚焦」信号：仅 frozen 时预取，冷却期内去重 */
export function prefetchFrozenWindow(windowId: string): void {
  if (useWindowStore.getState().lifecycles[windowId] !== 'frozen') return;
  const now = Date.now();
  const last = lastIntentAt.get(windowId) ?? 0;
  if (now - last < INTENT_COOLDOWN_MS) return;
  lastIntentAt.set(windowId, now);
  requestWakePrefetch(windowId);
}

/** 多窗信号（Dock 图标代表整个应用）：逐窗走同样的 frozen 判定与冷却 */
export function prefetchFrozenWindows(windowIds: Iterable<string>): void {
  for (const id of windowIds) prefetchFrozenWindow(id);
}

/** 仅供单元测试：清空冷却记录 */
export function resetWakePrefetchIntentForTests(): void {
  lastIntentAt.clear();
}
