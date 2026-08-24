/**
 * Chat / 面板级 HPIAS 事件订阅 hook
 */

import { useEffect } from 'react';
import { startHpiasEventBridge } from '../bridge/hpiasEventBridge';

export interface UseHpiasEventBridgeOptions {
  enabled?: boolean;
  sessionId?: string | null;
}

/** 在 enabled 时订阅 hpias_event，unmount 自动清理 */
export function useHpiasEventBridge(options: UseHpiasEventBridgeOptions = {}): void {
  const { enabled = true, sessionId } = options;

  useEffect(() => {
    if (!enabled) return;

    let unlisten: (() => void | Promise<void>) | undefined;
    let cancelled = false;

    void startHpiasEventBridge({
      sessionId: sessionId ?? undefined,
    }).then((fn) => {
      if (cancelled) {
        void fn();
        return;
      }
      unlisten = fn;
    });

    return () => {
      cancelled = true;
      void unlisten?.();
    };
  }, [enabled, sessionId]);
}
