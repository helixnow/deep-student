import { useEffect } from 'react';
import { useNetworkStore } from '@/stores/networkStore';

/**
 * 全局网络状态 Hook
 *
 * 监听浏览器原生 online/offline 事件，将状态同步到 Zustand store。
 * 在 App 顶层调用一次即可完成初始化；其他组件直接读取 store。
 *
 * @example
 * // App.tsx — 初始化
 * useNetworkStatus();
 *
 * // 任意组件 — 读取状态
 * const isOnline = useNetworkStore(s => s.isOnline);
 */
export function useNetworkStatus() {
  const isOnline = useNetworkStore((s) => s.isOnline);
  const setOnline = useNetworkStore((s) => s._setOnline);

  useEffect(() => {
    // 同步初始值（处理 SSR / test 环境）
    if (typeof window === 'undefined') return;

    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [setOnline]);

  return { isOnline };
}
