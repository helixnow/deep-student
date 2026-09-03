import { useCallback, useSyncExternalStore } from 'react';

/**
 * 响应式媒体查询Hook
 *
 * useSyncExternalStore 实现（对齐 mindmap/hooks/useCoarsePointer.ts）：
 * 首帧即读取真实 matchMedia 快照，避免旧 useState+useEffect 版本
 * mount 后先渲染一帧过期值再纠正的闪变；并发渲染下也不会撕裂。
 *
 * @param query - CSS媒体查询字符串，如 '(max-width: 768px)'
 * @returns 是否匹配该媒体查询
 *
 * @example
 * const isMobile = useMediaQuery('(max-width: 768px)');
 * const isDarkMode = useMediaQuery('(prefers-color-scheme: dark)');
 */
function subscribeMediaQuery(query: string, callback: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mql = window.matchMedia(query);
  if (!mql) return () => {};
  // 旧 WebView 兼容：addEventListener 缺失时退回 addListener
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', callback);
    return () => mql.removeEventListener('change', callback);
  }
  if (typeof mql.addListener === 'function') {
    mql.addListener(callback);
    return () => mql.removeListener(callback);
  }
  return () => {};
}

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (callback: () => void) => subscribeMediaQuery(query, callback),
    [query],
  );
  const getSnapshot = useCallback(
    () => Boolean(typeof window !== 'undefined' && window.matchMedia?.(query)?.matches),
    [query],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

export default useMediaQuery;
