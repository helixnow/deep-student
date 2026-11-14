import { useCallback, useSyncExternalStore } from 'react';

import { autoUninstalled, type PluginAutoUninstallReason, type PluginErrorBudgetView } from './reasons';

/**
 * 订阅内核错误预算：社区插件累计错误达到预算（默认 3 次）时，内核自动卸载并登记；
 * 管理页据此列出“自动卸载原因”，并用同一快照刷新行内 `errors/budget`。
 */
export function usePluginErrorBudget(budget?: PluginErrorBudgetView | null): PluginAutoUninstallReason[] {
  const subscribe = useCallback(
    (listener: () => void) => budget?.subscribe(listener) ?? (() => undefined),
    [budget],
  );
  const snapshot = useCallback(() => budget?.version() ?? 0, [budget]);
  useSyncExternalStore(subscribe, snapshot, snapshot);
  // 读数本身很便宜：版本号只负责触发重渲染，结果每次渲染重新读取，避免缓存陈旧计数。
  return budget ? autoUninstalled(budget) : [];
}
