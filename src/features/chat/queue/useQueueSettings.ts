import { useEffect, useState, useCallback } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';

export const QUEUE_MODE_KEY = 'chat.queue.mode';

export type QueueMode = 'queue' | 'guide';

export interface QueueSettings {
  mode: QueueMode;
  queueEnabled: boolean;
  allowSteer: boolean;
  setMode: (v: QueueMode) => Promise<void>;
}

async function readMode(defaultValue: QueueMode): Promise<QueueMode> {
  try {
    const raw = await tauriInvoke<string | null>('get_setting', { key: QUEUE_MODE_KEY });
    if (raw === 'queue' || raw === 'guide') return raw;
    return defaultValue;
  } catch {
    return defaultValue;
  }
}

export function useQueueSettings(): QueueSettings {
  const [mode, setModeState] = useState<QueueMode>('queue');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const m = await readMode('queue');
      if (cancelled) return;
      setModeState(m);
    })();
    return () => { cancelled = true; };
  }, []);

  const setMode = useCallback(async (v: QueueMode) => {
    const prev = mode;
    setModeState(v);
    try {
      await tauriInvoke('save_setting', { key: QUEUE_MODE_KEY, value: v });
    } catch {
      setModeState(prev);
    }
  }, [mode]);

  return {
    mode,
    queueEnabled: true,
    allowSteer: mode === 'guide',
    setMode,
  };
}
