/**
 * 主题解析 hook
 *
 * 通过 useSyncExternalStore 订阅 StyleRegistry（契约见 registry/StyleRegistry.ts）：
 * - html.dark class 切换（暗色变体 `${id}-dark` 自动解析）
 * - 主题注册 / 注销 / 清空
 *
 * 修复原先节点组件用 useMemo([styleId]) 缓存 StyleRegistry.get 结果、
 * 应用切换暗色模式时不重算、节点卡在旧主题的问题。
 */

import { useCallback, useSyncExternalStore } from 'react';
import { StyleRegistry } from '../registry/StyleRegistry';
import type { IStyleTheme } from '../registry/types';

const subscribe = (listener: () => void) => StyleRegistry.subscribe(listener);

// SSR / 测试环境下 document 不可用时的保守快照
const getServerDarkSnapshot = () => false;

/**
 * 解析当前应显示的主题（含暗色变体自动映射），
 * styleId 或暗色模式变化时自动返回新引用触发重渲染。
 */
export function useMindMapTheme(styleId: string): IStyleTheme {
  const getSnapshot = useCallback(
    () => StyleRegistry.get(styleId) ?? StyleRegistry.getDefault(),
    [styleId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 当前是否处于暗色模式（html.dark），随 StyleRegistry 通知更新 */
export function useMindMapDarkMode(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => StyleRegistry.isDarkMode(),
    getServerDarkSnapshot,
  );
}
