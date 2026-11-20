import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useEventRegistry } from '@/hooks/useEventRegistry';

/**
 * 读取今日待完成待办数量（与 TodayCommandCenter 同一 IPC 口径：todo_list_today(includeCompleted=false)）。
 * 独立成轻量辅助模块，不侵入 loadTodayLearning 的契约形状，也不新增跨 feature import。
 */
export async function loadTodayTodoCount(): Promise<number> {
  try {
    const items = await invoke<unknown>('todo_list_today', { includeCompleted: false });
    return Array.isArray(items) ? items.length : 0;
  } catch {
    return 0;
  }
}

export function useTodayTodoCount(externalCount?: number): number {
  const [fetchedCount, setFetchedCount] = useState(0);
  const usesExternal = typeof externalCount === 'number';

  const refresh = useCallback(() => {
    if (usesExternal) return;
    void loadTodayTodoCount().then((count) => {
      setFetchedCount(count);
    });
  }, [usesExternal]);

  useEffect(() => {
    if (usesExternal) return;
    refresh();
  }, [usesExternal, refresh]);

  useEventRegistry(
    usesExternal
      ? []
      : [
          {
            target: 'document',
            type: 'visibilitychange',
            listener: () => {
              if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
                refresh();
              }
            },
          },
        ],
    [usesExternal, refresh],
  );

  return usesExternal ? Math.max(0, externalCount) : fetchedCount;
}
