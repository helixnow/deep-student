import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { TODO_CHANGED_EVENT, toggleTodoItem } from '@/features/todo/api';
import { loadTodayTodoCount, useTodayTodoCount } from '../todayTodoCount';

function TodoCountProbe() {
  const count = useTodayTodoCount();
  return React.createElement('span', { 'data-testid': 'todo-count' }, String(count));
}

describe('loadTodayTodoCount', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('queries todo_list_today with includeCompleted=false and excludes subtasks from pending count', async () => {
    invoke.mockResolvedValueOnce([{ id: 't1' }, { id: 't2' }, { id: 'sub1', parentId: 't1' }, { id: 't3' }]);
    expect(await loadTodayTodoCount()).toBe(3);
    expect(invoke).toHaveBeenCalledWith('todo_list_today', { includeCompleted: false });
  });

  it('degrades gracefully to 0 when IPC fails or returns non-array', async () => {
    invoke.mockRejectedValueOnce(new Error('offline'));
    expect(await loadTodayTodoCount()).toBe(0);

    invoke.mockResolvedValueOnce(null);
    expect(await loadTodayTodoCount()).toBe(0);
  });

  it('refreshes live when TODO_CHANGED_EVENT fires after mutating todo commands (BUG-18)', async () => {
    let todayItems = [{ id: 't1' }, { id: 't2' }];
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'todo_list_today') return todayItems;
      if (cmd === 'todo_toggle_item') {
        todayItems = [{ id: 't1' }];
        return { id: 't2', status: 'completed' };
      }
      return undefined;
    });

    render(React.createElement(TodoCountProbe));
    await waitFor(() => expect(screen.getByTestId('todo-count')).toHaveTextContent('2'));

    await act(async () => {
      await toggleTodoItem('t2');
    });

    await waitFor(() => expect(screen.getByTestId('todo-count')).toHaveTextContent('1'));
    expect(TODO_CHANGED_EVENT).toBe('todo:changed');
  });
});
