import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { loadTodayTodoCount } from '../todayTodoCount';

describe('loadTodayTodoCount', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('queries todo_list_today with includeCompleted=false and returns pending count', async () => {
    invoke.mockResolvedValueOnce([{ id: 't1' }, { id: 't2' }, { id: 't3' }]);
    expect(await loadTodayTodoCount()).toBe(3);
    expect(invoke).toHaveBeenCalledWith('todo_list_today', { includeCompleted: false });
  });

  it('degrades gracefully to 0 when IPC fails or returns non-array', async () => {
    invoke.mockRejectedValueOnce(new Error('offline'));
    expect(await loadTodayTodoCount()).toBe(0);

    invoke.mockResolvedValueOnce(null);
    expect(await loadTodayTodoCount()).toBe(0);
  });
});
