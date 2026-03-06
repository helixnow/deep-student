import { useCallback, useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';

// 简化 Tauri 事件监听与清理，避免内存泄漏
// ★ 2026-02-13 修复：memoize attach/cleanup，防止消费者 useEffect 因引用变化重复注册监听器
export function useTauriEventListener() {
  const unsubsRef = useRef<Set<() => void>>(new Set());
  const disposedRef = useRef(false);

  const cleanup = useCallback(function cleanup(unlisten?: () => void) {
    if (!unlisten) return;
    try { unlisten(); } catch { /* ignore teardown errors */ }
    unsubsRef.current.delete(unlisten);
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      const pending = Array.from(unsubsRef.current);
      unsubsRef.current.clear();
      pending.forEach((u) => {
        try { u(); } catch { /* ignore teardown errors */ }
      });
    };
  }, []);

  const attach = useCallback(async function attach<T = unknown>(eventName: string, handler: (event: { payload: T }) => void) {
    if (disposedRef.current) {
      return () => {};
    }
    const unlisten = await listen<T>(eventName, handler);
    // 处理竞态：组件已卸载但 listen 刚 resolve
    if (disposedRef.current) {
      try { unlisten(); } catch { /* ignore teardown errors */ }
      return () => {};
    }
    unsubsRef.current.add(unlisten);
    return () => cleanup(unlisten);
  }, [cleanup]);

  return { attach, cleanup };
}


