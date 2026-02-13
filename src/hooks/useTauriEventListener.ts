import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';

// 简化 Tauri 事件监听与清理，避免内存泄漏
export function useTauriEventListener() {
  const unsubsRef = useRef<Array<() => void>>([]);

  useEffect(() => {
    return () => {
      try { unsubsRef.current.forEach((u) => u()); } catch {}
      unsubsRef.current = [];
    };
  }, []);

  async function attach<T = any>(eventName: string, handler: (event: { payload: T }) => void) {
    const unlisten = await listen<T>(eventName, handler);
    unsubsRef.current.push(unlisten);
    return unlisten;
  }

  function cleanup(unlisten?: () => void) {
    if (!unlisten) return;
    try { unlisten(); } catch {}
    unsubsRef.current = unsubsRef.current.filter((u) => u !== unlisten);
  }

  return { attach, cleanup };
}




