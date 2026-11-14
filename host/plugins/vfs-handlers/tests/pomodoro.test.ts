import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVfsHost, type VfsHost } from './harness.ts';

let vfs: VfsHost;
beforeEach(async () => { vfs = await createVfsHost(); }, 120_000);
afterEach(async () => { await vfs?.dispose(); }, 120_000);

const invoke = <T = unknown>(name: string, args: Record<string, unknown> = {}) => vfs.host.invoke(name, args) as Promise<T>;

function todayLocal(): string {
  const now = new Date();
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

describe('vfs/pomodoro_handlers.rs command layer', { timeout: 120_000 }, () => {
  it('pomodoro_create_record defaults type and status and links the todo cache', async () => {
    const list = await invoke<{ id: string }>('todo_create_list', { input: { title: 'L' } });
    const item = await invoke<{ id: string; completedPomodoros?: number }>('todo_create_item', {
      input: { todoListId: list.id, title: 'T' },
    });
    vfs.host.events.length = 0;
    const start = new Date().toISOString();
    const record = await invoke<{ id: string; type: string; status: string; todoItemId: string; duration: number }>(
      'pomodoro_create_record',
      { input: { todoItemId: item.id, startTime: start, duration: 25, actualDuration: 22 } },
    );
    expect(record).toMatchObject({ type: 'work', status: 'completed', todoItemId: item.id, duration: 25 });
    expect(vfs.host.eventsNamed('todo://changed')).toEqual([
      { source: 'user', action: 'update', entityIds: [item.id] },
    ]);
    const refreshed = await invoke<{ completedPomodoros?: number }>('todo_get_item', { itemId: item.id });
    expect(refreshed.completedPomodoros).toBe(1);
  });

  it('pomodoro statistics read the persisted records', async () => {
    const start = new Date().toISOString();
    const first = await invoke<{ id: string }>('pomodoro_create_record', {
      input: { startTime: start, duration: 25, actualDuration: 1500 },
    });
    await invoke('pomodoro_create_record', {
      input: { startTime: start, duration: 5, actualDuration: 4, type: 'short_break', status: 'completed' },
    });
    const today = await invoke<{ completedCount: number; totalFocusSeconds: number; interruptedCount: number }>(
      'pomodoro_today_stats',
    );
    expect(today.completedCount).toBe(1);
    expect(today.totalFocusSeconds).toBe(1500);
    expect(today.interruptedCount).toBe(0);

    const daily = await invoke<Array<{ date: string; completedCount: number }>>('pomodoro_daily_stats', { days: 7 });
    expect(daily.at(-1)).toMatchObject({ date: todayLocal(), completedCount: 1 });
    expect(daily).toHaveLength(7);

    const hourly = await invoke<Array<{ hour: number }>>('pomodoro_hourly_stats', { days: 30 });
    expect(hourly).toHaveLength(24);

    const streak = await invoke<{ currentStreakDays: number; longestStreakDays: number }>('pomodoro_streak');
    expect(streak).toEqual({ currentStreakDays: 1, longestStreakDays: 1 });

    const overview = await invoke<{ today: { completedCount: number } }>('pomodoro_stats_overview', { days: 30 });
    expect(overview.today.completedCount).toBe(1);

    expect(await invoke('pomodoro_list_today')).toHaveLength(2);
    expect(await invoke('pomodoro_list_range', { startDate: todayLocal(), endDate: todayLocal() })).toHaveLength(2);
    expect(await invoke('pomodoro_get_record', { recordId: first.id })).toMatchObject({ id: first.id });
    expect(await invoke('pomodoro_list_by_todo', { todoItemId: 'ti_none' })).toEqual([]);
  });

  it('pomodoro_stats_by_todo and todo_focus_summary aggregate per task', async () => {
    const list = await invoke<{ id: string }>('todo_create_list', { input: { title: 'L' } });
    const item = await invoke<{ id: string }>('todo_create_item', { input: { todoListId: list.id, title: '写入' } });
    const start = new Date().toISOString();
    for (let index = 0; index < 2; index += 1) {
      await invoke('pomodoro_create_record', {
        input: { todoItemId: item.id, startTime: start, duration: 25, actualDuration: 1500 },
      });
    }
    const stats = await invoke<Array<{ todoItemId: string; todoTitle?: string; completedCount: number; focusSeconds: number }>>(
      'pomodoro_stats_by_todo', { limit: 20 },
    );
    expect(stats).toEqual([{ todoItemId: item.id, todoTitle: '写入', completedCount: 2, focusSeconds: 3000 }]);

    const summary = await invoke<{
      todoItemId: string; todoTitle?: string; totalFocusSeconds: number; completedCount: number; interruptedCount: number;
    }>('pomodoro_todo_focus_summary', { todoItemId: item.id });
    expect(summary).toMatchObject({
      todoItemId: item.id, todoTitle: '写入', totalFocusSeconds: 3000, completedCount: 2, interruptedCount: 0,
    });

    const missing = await invoke<{ todoItemId: string; totalFocusSeconds: number }>(
      'pomodoro_todo_focus_summary', { todoItemId: 'ti_missing' },
    );
    expect(missing).toMatchObject({ todoItemId: 'ti_missing', totalFocusSeconds: 0 });
  });

  it('pomodoro_delete_record rolls back the derived completed count and emits todo change', async () => {
    const list = await invoke<{ id: string }>('todo_create_list', { input: { title: 'L' } });
    const item = await invoke<{ id: string }>('todo_create_item', { input: { todoListId: list.id, title: 'T' } });
    const record = await invoke<{ id: string }>('pomodoro_create_record', {
      input: { todoItemId: item.id, startTime: new Date().toISOString(), duration: 25, actualDuration: 25 },
    });
    vfs.host.events.length = 0;
    expect(await invoke('pomodoro_delete_record', { recordId: record.id })).toBeNull();
    expect(vfs.host.eventsNamed('todo://changed')).toEqual([
      { source: 'user', action: 'update', entityIds: [item.id] },
    ]);
    const refreshed = await invoke<{ completedPomodoros?: number }>('todo_get_item', { itemId: item.id });
    expect(refreshed.completedPomodoros).toBe(0);
    expect(await invoke('pomodoro_get_record', { recordId: record.id })).toBeNull();
  });
});
