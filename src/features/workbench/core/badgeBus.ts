/**
 * badgeBus — Dock 角标失效推送通道（2026-08）
 *
 * badgeSource 本身是拉模式（appRegistry 上的纯函数）；此前 Dock 靠 2s 共享
 * 轮询发现变化。本模块补一条极薄的推送通道：各角标数据源在自身状态变化时
 * notifyAppBadgeChanged(typeId)，Dock 侧订阅后立刻重读 badgeSource。
 * 轮询保留为低频兜底（见 DockItem BADGE_POLL_MS），防事件丢失。
 *
 * 不承载数据（payload 永远是「去重读一次」），因此无顺序/合并问题；
 * 通知同步派发，源在 store 提交后调用即可。订阅者逐个故障隔离，避免某个
 * badgeSource / 已卸载视图异常阻断同应用其余 Dock 实例刷新。
 */

const listenersByType = new Map<string, Set<() => void>>();

/** 数据源侧：typeId 应用的角标可能变化，通知订阅者重读 badgeSource */
export function notifyAppBadgeChanged(typeId: string): void {
  const set = listenersByType.get(typeId);
  if (!set) return;
  for (const cb of Array.from(set)) {
    try {
      cb();
    } catch (error) {
      console.error(`[workbench] badgeBus listener failed for "${typeId}"`, error);
    }
  }
}

/** 消费侧（DockItem 等）：订阅 typeId 的角标失效通知 */
export function subscribeAppBadgeChanged(typeId: string, cb: () => void): () => void {
  let set = listenersByType.get(typeId);
  if (!set) {
    set = new Set();
    listenersByType.set(typeId, set);
  }
  set.add(cb);
  return () => {
    set.delete(cb);
    if (set.size === 0) listenersByType.delete(typeId);
  };
}
