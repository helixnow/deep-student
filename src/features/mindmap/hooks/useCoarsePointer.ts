/**
 * 响应式指针/视口媒体查询 hook。
 *
 * 旧实现（MindMapCanvas / MindMapEmbed）只在 mount 时读一次
 * matchMedia('(pointer: coarse)')，外接鼠标 / 触屏切换、二合一设备旋转后
 * 不会更新。这里改为订阅 change 事件，值变化时触发重渲染。
 */
import { useCallback, useSyncExternalStore } from 'react';

function subscribeMediaQuery(query: string, callback: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mql = window.matchMedia(query);
  // 旧 WebView 兼容：addEventListener 缺失时退回 addListener
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', callback);
    return () => mql.removeEventListener('change', callback);
  }
  mql.addListener(callback);
  return () => mql.removeListener(callback);
}

/** 订阅任意媒体查询，返回当前是否命中（随系统变化实时更新）。 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (callback: () => void) => subscribeMediaQuery(query, callback),
    [query],
  );
  const getSnapshot = useCallback(
    () => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches,
    [query],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** 触屏（粗指针）设备检测，响应外接/断开鼠标等运行时变化。 */
export function useCoarsePointer(): boolean {
  return useMediaQuery('(pointer: coarse)');
}

/**
 * 移动端窄屏检测（与 Tailwind sm 断点 640px 对齐）。
 *
 * 设计意图：<640 为「内联子屏」形态（面板全屏化等），640-767 保留压缩桌面形态
 * （App shell 的移动切换点是 768，见 useBreakpoint().isSmallScreen）。
 *
 * 用 `not (min-width: 640px)` 而非 `max-width: 639px`：缩放产生的小数视口宽度
 * （如 639.5px）下 max-width 会与 CSS 端 640 断点判定不一致，导致布局分支错位。
 */
export function useMobileScreen(): boolean {
  return useMediaQuery('not (min-width: 640px)');
}
