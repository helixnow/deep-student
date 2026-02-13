import { useCallback, useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';

// 简化 Tauri 事件监听与清理，避免内存泄漏
// ★ 2026-02-13 修复：memoize attach/cleanup，防止消费者 useEffect 因引用变化重复注册监听器
export function useTauriEventListener() {
  const unsubsRef = useRef<Array<() => void>>([]);

  useEffect(() => {
    return () => {
      try { unsubsRef.current.forEach((u) => u()); } catch {}
      unsubsRef.current = [];
    };
  }, []);

  const attach = useCallback(async function attach<T = any>(eventName: string, handler: (event: { payload: T }) => void) {
    const unlisten = await listen<T>(eventName, handler);
    unsubsRef.current.push(unlisten);
    return unlisten;
  }, []);

  const cleanup = useCallback(function cleanup(unlisten?: () => void) {
    if (!unlisten) return;
    try { unlisten(); } catch {}
    unsubsRef.current = unsubsRef.current.filter((u) => u !== unlisten);
  }, []);

  return { attach, cleanup };
}




