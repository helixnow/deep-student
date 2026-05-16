import { useEffect, useState, useCallback } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';

export const QUEUE_ENABLED_KEY = 'chat.queue.enabled';

export interface QueueSettings {
  /** 排队功能总开关。开启时同时启用排队 + 引导。 */
  queueEnabled: boolean;
  /** 引导功能。当前与 queueEnabled 等价（合并为单开关）。 */
  allowSteer: boolean;
  setQueueEnabled: (v: boolean) => Promise<void>;
}

async function readBool(key: string, defaultValue: boolean): Promise<boolean> {
  try {
    const raw = await tauriInvoke<string | null>('get_setting', { key });
    if (raw == null || String(raw).trim() === '') return defaultValue;
    // Anything other than literal 'false' is treated as true (default-on).
    return String(raw).trim().toLowerCase() !== 'false';
  } catch {
    return defaultValue;
  }
}

/**
 * 队列设置 hook（单开关版本）。
 * - 默认 queueEnabled=true。
 * - allowSteer === queueEnabled（合并到一个开关，简化心智）。
 * - 持久化到 Tauri `save_setting` / `get_setting`。
 * - 失败时乐观更新自动回滚。
 */
export function useQueueSettings(): QueueSettings {
  const [queueEnabled, setQueueEnabledState] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const enabled = await readBool(QUEUE_ENABLED_KEY, true);
      if (cancelled) return;
      setQueueEnabledState(enabled);
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

  return {
    queueEnabled,
    allowSteer: queueEnabled,
    setQueueEnabled,
  };
}
