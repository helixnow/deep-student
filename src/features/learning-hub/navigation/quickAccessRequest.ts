/**
 * 从学习资源外部「打开某个快捷入口」（今日待复习笔记、跨题目集错题本…）。
 *
 * Finder 按宿主分桶（经典壳 page / page-mobile 各一桶，学习桌面 files 窗口用 default 桶），
 * 外部拿不到当前可见访达的桶，直接改 `useFinderStore`（default）在经典壳里不生效。
 * 所以由挂载着的全屏访达自己在本桶上执行跳转：已挂载时收事件立即跳，还没挂载时请求挂起、挂载后消费。
 *
 * 本模块保持零运行时依赖（仅 type import），可被各功能静态引用。
 */
import type { QuickAccessType } from '../learningHubContracts';

export const LEARNING_HUB_QUICK_ACCESS_EVENT = 'learningHub:open-quick-access';

/** 覆盖学习资源冷加载；过期请求不再把之后的进入拽走 */
const PENDING_TTL_MS = 15_000;

let pending: { type: QuickAccessType; requestedAt: number } | null = null;

export function requestLearningHubQuickAccess(type: QuickAccessType): void {
  pending = { type, requestedAt: Date.now() };
  window.dispatchEvent(new CustomEvent(LEARNING_HUB_QUICK_ACCESS_EVENT, { detail: { type } }));
}

/** 取走挂起的请求（只能取一次）；已执行或过期返回 null */
export function takePendingLearningHubQuickAccess(): QuickAccessType | null {
  const current = pending;
  pending = null;
  return current && Date.now() - current.requestedAt <= PENDING_TTL_MS ? current.type : null;
}
