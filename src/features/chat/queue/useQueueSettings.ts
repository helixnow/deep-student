import { useEffect, useState, useCallback } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';

export const QUEUE_ENABLED_KEY = 'chat.queue.enabled';
export const QUEUE_ALLOW_STEER_KEY = 'chat.queue.allowSteer';

export interface QueueSettings {
  queueEnabled: boolean;
  allowSteer: boolean;
  setQueueEnabled: (v: boolean) => Promise<void>;
  setAllowSteer: (v: boolean) => Promise<void>;
}

async function readBool(key: string, defaultValue: boolean): Promise<boolean> {
  try {
    const raw = await tauriInvoke<string | null>('get_setting', { key });
    if (raw == null || String(raw).trim() === '') return defaultValue;
    // Anything other than literal 'false' is treated as true (default-on semantics).
    return String(raw).trim().toLowerCase() !== 'false';
  } catch {
    return defaultValue;
  }
}

/**
 * 队列设置 hook。
 * - 默认 queueEnabled=true, allowSteer=true（业界 SOTA 默认开）。
 * - 持久化到 Tauri `save_setting` / `get_setting`。
 * - 失败时乐观更新自动回滚。
 */
export function useQueueSettings(): QueueSettings {
  const [queueEnabled, setQueueEnabledState] = useState(true);
  const [allowSteer, setAllowSteerState] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [enabled, steer] = await Promise.all([
        readBool(QUEUE_ENABLED_KEY, true),
        readBool(QUEUE_ALLOW_STEER_KEY, true),
      ]);
      if (cancelled) return;
      setQueueEnabledState(enabled);
      setAllowSteerState(steer);
    })();
    return () => { cancelled = true; };
  }, []);

  const setQueueEnabled = useCallback(async (v: boolean) => {
    const prev = queueEnabled;
    setQueueEnabledState(v);
    try {
      await tauriInvoke('save_setting', { key: QUEUE_ENABLED_KEY, value: String(v) });
    } catch {
      setQueueEnabledState(prev);
    }
  }, [queueEnabled]);

  const setAllowSteer = useCallback(async (v: boolean) => {
    const prev = allowSteer;
    setAllowSteerState(v);
    try {
      await tauriInvoke('save_setting', { key: QUEUE_ALLOW_STEER_KEY, value: String(v) });
    } catch {
      setAllowSteerState(prev);
    }
  }, [allowSteer]);

  return { queueEnabled, allowSteer, setQueueEnabled, setAllowSteer };
}
