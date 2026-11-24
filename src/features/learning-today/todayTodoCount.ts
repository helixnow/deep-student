import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useEventRegistry } from '@/hooks/useEventRegistry';

/** 与 features/todo/api.ts 的 TODO_CHANGED_EVENT 同名（避免新增跨 feature import）。 */
const TODO_CHANGED_EVENT = 'todo:changed';

/**
 * 读取今日待完成待办数量（与 TodayCommandCenter 同一 IPC 口径：todo_list_today(includeCompleted=false)）。
 * 独立成轻量辅助模块，不侵入 loadTodayLearning 的契约形状，也不新增跨 feature import。
 */
export async function loadTodayTodoCount(): Promise<number> {
  try {
    const items = await invoke<unknown>('todo_list_today', { includeCompleted: false });
    if (!Array.isArray(items)) return 0;
    return items.filter((item) => {
      if (!item || typeof item !== 'object') return true;
      return (item as { parentId?: string | null }).parentId == null;
    }).length;
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
          {
            target: 'window',
            type: TODO_CHANGED_EVENT,
            listener: refresh,
          },
        ],
    [usesExternal, refresh],
  );

  return usesExternal ? Math.max(0, externalCount) : fetchedCount;
}
