import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

import type { TodoItem } from '@/components/todo/types';
import { useTodoStore } from '@/components/todo/useTodoStore';
import * as api from '@/components/todo/api';

vi.mock('@/components/todo/api', () => ({
  listTodoLists: vi.fn(),
  ensureInbox: vi.fn(),
  createTodoList: vi.fn(),
  updateTodoList: vi.fn(),
  deleteTodoList: vi.fn(),
  toggleTodoListFavorite: vi.fn(),
  createTodoItem: vi.fn(),
  getTodoItem: vi.fn(),
  listTodoItems: vi.fn(),
  updateTodoItem: vi.fn(),
  toggleTodoItem: vi.fn(),
  deleteTodoItem: vi.fn(),
  reorderTodoItems: vi.fn(),
  listTodayItems: vi.fn(),
  listOverdueItems: vi.fn(),
  listUpcomingItems: vi.fn(),
  listCompletedItems: vi.fn(),
  searchTodoItems: vi.fn(),
  getActiveTodoSummary: vi.fn(),
}));

function makeItem(overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    id: overrides.id ?? 'ti_1',
    todoListId: overrides.todoListId ?? 'list-a',
    title: overrides.title ?? 'Task',
    description: overrides.description,
    status: overrides.status ?? 'pending',
    priority: overrides.priority ?? 'none',
    dueDate: overrides.dueDate,
    dueTime: overrides.dueTime,
    reminder: overrides.reminder,
    tagsJson: overrides.tagsJson ?? '[]',
    sortOrder: overrides.sortOrder ?? 0,
    parentId: overrides.parentId,
    completedAt: overrides.completedAt,
    repeatJson: overrides.repeatJson,
    attachmentsJson: overrides.attachmentsJson ?? '[]',
    estimatedPomodoros: overrides.estimatedPomodoros,
    completedPomodoros: overrides.completedPomodoros,
    createdAt: overrides.createdAt ?? '2026-03-10T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-03-10T00:00:00.000Z',
    deletedAt: overrides.deletedAt,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function resetTodoStore() {
  useTodoStore.setState({
    lists: [],
    activeListId: null,
    items: [],
    selectedItemId: null,
    filter: {
      view: 'all',
      search: '',
      priorityFilter: null,
      showCompleted: false,
    },
    isLoadingLists: false,
    isLoadingItems: false,
    itemsRequestVersion: 0,
    error: null,
  });
}

describe('useTodoStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTodoStore();
  });

  it('ignores stale list responses when switching lists quickly', async () => {
    const listA = deferred<TodoItem[]>();
    const listB = deferred<TodoItem[]>();

    vi.mocked(api.listTodoItems).mockImplementation((listId) => {
      if (listId === 'list-a') return listA.promise;
      if (listId === 'list-b') return listB.promise;
      return Promise.resolve([]);
    });

    useTodoStore.getState().setActiveList('list-a');
    useTodoStore.getState().setActiveList('list-b');

    listB.resolve([makeItem({ id: 'ti_b', todoListId: 'list-b', title: 'B item' })]);

    await waitFor(() => {
      expect(useTodoStore.getState().items.map((item) => item.id)).toEqual(['ti_b']);
    });

    listA.resolve([makeItem({ id: 'ti_a', todoListId: 'list-a', title: 'A item' })]);

    await Promise.resolve();
    await Promise.resolve();

    expect(useTodoStore.getState().items.map((item) => item.id)).toEqual(['ti_b']);
    expect(useTodoStore.getState().activeListId).toBe('list-b');
  });

  it('reloads smart views with completed items when showCompleted is enabled', async () => {
    vi.mocked(api.listTodayItems)
      .mockResolvedValueOnce([makeItem({ id: 'pending_today', dueDate: '2026-03-10' })])
      .mockResolvedValueOnce([
        makeItem({ id: 'pending_today', dueDate: '2026-03-10' }),
        makeItem({
          id: 'completed_today',
          status: 'completed',
          dueDate: '2026-03-10',
          completedAt: '2026-03-10T09:00:00.000Z',
        }),
      ]);

    useTodoStore.getState().setViewFilter('today');

    await waitFor(() => {
      expect(api.listTodayItems).toHaveBeenNthCalledWith(1, false);
      expect(useTodoStore.getState().items).toHaveLength(1);
    });

    useTodoStore.getState().setShowCompleted(true);

    await waitFor(() => {
      expect(api.listTodayItems).toHaveBeenNthCalledWith(2, true);
      expect(useTodoStore.getState().items).toHaveLength(2);
    });
  });

  it('loads completed view from the dedicated completed query', async () => {
    vi.mocked(api.listCompletedItems).mockResolvedValue([
      makeItem({
        id: 'done_1',
        status: 'completed',
        completedAt: '2026-03-10T10:00:00.000Z',
      }),
    ]);

    useTodoStore.getState().setViewFilter('completed');

    await waitFor(() => {
      expect(api.listCompletedItems).toHaveBeenCalledWith(undefined);
      expect(useTodoStore.getState().items.map((item) => item.id)).toEqual(['done_1']);
    });
  });
});
