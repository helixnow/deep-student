/**
 * Chat / 面板级 HPIAS 事件订阅 hook
 */

import { useEffect } from 'react';
import { retainSharedHpiasEventBridge } from '../bridge/hpiasEventBridge';

export interface UseHpiasEventBridgeOptions {
  enabled?: boolean;
  /** 保留调用方语义；共享 listen 不按 session 过滤，由 store 切片路由。 */
  sessionId?: string | null;
}

/** 在 enabled 时加入共享 hpias_event 订阅，unmount 自动释放 */
export function useHpiasEventBridge(options: UseHpiasEventBridgeOptions = {}): void {
  const { enabled = true } = options;

  useEffect(() => {
    if (!enabled) return;

    let release: (() => void | Promise<void>) | undefined;
    let cancelled = false;

    void retainSharedHpiasEventBridge().then((fn) => {
      if (cancelled) {
        void fn();
        return;
      }
      release = fn;
    });

    return () => {
      cancelled = true;
      void release?.();
    };
  }, [enabled]);
}
