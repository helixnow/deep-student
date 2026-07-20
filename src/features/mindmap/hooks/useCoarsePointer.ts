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
 * 移动端窄屏检测（与 App shell / Tailwind md 的 768px 断点对齐）。
 *
 * 导图的内联子屏、移动工具栏和资源选择器必须与宿主在同一断点切换；
 * 否则 640–767px 的移动壳会混入桌面 popover，并在横竖屏切换时留下不可见浮层。
 *
 * 用 `not (min-width: 768px)` 而非 `max-width: 767px`：缩放产生的小数视口宽度
 * 下不会与 CSS/Tailwind 的 md 断点判定错位。
 */
export function useMobileScreen(): boolean {
  return useMediaQuery('not (min-width: 768px)');
}
