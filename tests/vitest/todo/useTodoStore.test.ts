import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

import type { TodoItem, TodoList } from '@/features/todo/types';
import { useTodoStore } from '@/features/todo/stores/useTodoStore';
import * as api from '@/features/todo/api';

vi.mock('@/features/todo/api', () => ({
  listTodoLists: vi.fn(),
  ensureInbox: vi.fn(),
  createTodoList: vi.fn(),
  updateTodoList: vi.fn(),
  deleteTodoList: vi.fn(),
  toggleTodoListFavorite: vi.fn(),
  reorderTodoLists: vi.fn(),
  createTodoItem: vi.fn(),
  getTodoItem: vi.fn(),
  listTodoItems: vi.fn(),
  updateTodoItem: vi.fn(),
  toggleTodoItem: vi.fn(),
  deleteTodoItem: vi.fn(),
  reorderTodoItems: vi.fn(),
  moveTodoItem: vi.fn(),
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

function makeList(overrides: Partial<TodoList> = {}): TodoList {
  return {
    id: overrides.id ?? 'list-a',
    title: overrides.title ?? 'List',
    description: overrides.description,
    icon: overrides.icon,
    color: overrides.color,
    sortOrder: overrides.sortOrder ?? 0,
    isDefault: overrides.isDefault ?? false,
    isFavorite: overrides.isFavorite ?? false,
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

  it('optimistically removes the item when moving it out of the active list', async () => {
    const item = makeItem({ id: 'ti_move', todoListId: 'list-a' });
    useTodoStore.setState({ activeListId: 'list-a', items: [item], selectedItemId: 'ti_move' });
    vi.mocked(api.moveTodoItem).mockResolvedValue({ ...item, todoListId: 'list-b' });
    // move 后的静默校准会重拉当前清单；覆盖第一个用例遗留的 mockImplementation
    // （vi.clearAllMocks 不清实现），避免旧的 list-a 数据回灌
    vi.mocked(api.listTodoItems).mockResolvedValue([]);

    await useTodoStore.getState().moveItemToList('ti_move', 'list-b');

    expect(api.moveTodoItem).toHaveBeenCalledWith('ti_move', 'list-b');
    expect(useTodoStore.getState().items).toEqual([]);
    expect(useTodoStore.getState().selectedItemId).toBeNull();
  });

  it('optimistically reorders lists', async () => {
    useTodoStore.setState({
      lists: [makeList({ id: 'l1' }), makeList({ id: 'l2' }), makeList({ id: 'l3' })],
    });
    vi.mocked(api.reorderTodoLists).mockResolvedValue(undefined);

    const promise = useTodoStore.getState().reorderLists(['l3', 'l1', 'l2']);

    // 乐观重排：await 之前本地顺序已更新
    expect(useTodoStore.getState().lists.map((l) => l.id)).toEqual(['l3', 'l1', 'l2']);

    await promise;

    expect(api.reorderTodoLists).toHaveBeenCalledWith(['l3', 'l1', 'l2']);
    expect(useTodoStore.getState().lists.map((l) => l.id)).toEqual(['l3', 'l1', 'l2']);
  });
});
