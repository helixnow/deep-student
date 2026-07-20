import { useEffect, useState, useCallback } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';

export const QUEUE_MODE_KEY = 'chat.queue.mode';

export type QueueMode = 'queue' | 'guide';

export interface QueueSettings {
  mode: QueueMode;
  loading: boolean;
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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const m = await readMode('queue');
      if (cancelled) return;
      setModeState(m);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 🔧 修复闭包陷阱：原实现依赖 [mode] 捕获 prev，快速连点两次时
  // 第二次调用捕获的 prev 可能是过期值，保存失败回滚会回到错误状态。
  // 改为函数式更新读取当前值，且仅当状态仍是本次乐观值时才回滚
  // （避免覆盖用户在保存窗口内做出的更新切换）。
  const setMode = useCallback(async (v: QueueMode) => {
    let prev: QueueMode = 'queue';
    setModeState((current) => {
      prev = current;
      return v;
    });
    try {
      await tauriInvoke('save_setting', { key: QUEUE_MODE_KEY, value: v });
    } catch {
      setModeState((current) => (current === v ? prev : current));
    }
  }, []);

  return {
    mode,
    loading,
    queueEnabled: true,
    allowSteer: mode === 'guide',
    setMode,
  };
}
