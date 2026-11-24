import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listTodoLists: vi.fn(),
  listAllPendingItems: vi.fn(),
  toggleTodoItem: vi.fn(),
  updateTodoItem: vi.fn(),
  reloadCurrentView: vi.fn(async () => undefined),
  refreshCounts: vi.fn(async () => undefined),
}));

vi.mock('@/features/todo/api', () => ({
  listTodoLists: mocks.listTodoLists,
  listAllPendingItems: mocks.listAllPendingItems,
  toggleTodoItem: mocks.toggleTodoItem,
  updateTodoItem: mocks.updateTodoItem,
}));

vi.mock('@/features/todo/stores/useTodoStore', () => ({
  useTodoStore: {
    subscribe: () => () => undefined,
    getState: () => ({
      reloadCurrentView: mocks.reloadCurrentView,
      refreshCounts: mocks.refreshCounts,
    }),
  },
}));

vi.mock('../../../agent/domainEvents', () => ({
  registerDomainListener: () => () => undefined,
}));

import {
  completeTodoAgendaItem,
  getTodoAgendaSnapshot,
  refreshTodoAgenda,
  resetTodoAgendaSourceForTests,
} from '../todoAgendaSource';

describe('todoAgendaSource', () => {
  beforeEach(() => {
    resetTodoAgendaSourceForTests();
    mocks.listTodoLists.mockReset();
    mocks.listAllPendingItems.mockReset();
    mocks.toggleTodoItem.mockReset();
    mocks.updateTodoItem.mockReset();
    mocks.reloadCurrentView.mockClear();
    mocks.refreshCounts.mockClear();
  });

  it('读取清单和全部未完成任务，并按日期时间排序', async () => {
    mocks.listTodoLists.mockResolvedValue([{ id: 'list-a', title: '课程' }]);
    mocks.listAllPendingItems.mockResolvedValue([
      { id: 'later', status: 'pending', dueDate: '2026-07-13', dueTime: '09:00', sortOrder: 0 },
      { id: 'done', status: 'completed', dueDate: '2026-07-12', sortOrder: 0 },
      { id: 'first', status: 'pending', dueDate: '2026-07-12', dueTime: '20:00', sortOrder: 0 },
    ]);
    await refreshTodoAgenda();
    expect(getTodoAgendaSnapshot().items.map((item) => item.id)).toEqual(['first', 'later']);
    expect(getTodoAgendaSnapshot().lists).toHaveLength(1);
  });

  it('完成任务时幂等写入 completed、乐观移除，并刷新 Todo 当前视图与计数', async () => {
    mocks.listTodoLists.mockResolvedValue([]);
    mocks.listAllPendingItems
      .mockResolvedValueOnce([{ id: 'item-a', status: 'pending', dueDate: '2026-07-12', sortOrder: 0 }])
      .mockResolvedValueOnce([]);
    mocks.updateTodoItem.mockResolvedValue({ id: 'item-a', status: 'completed' });
    await refreshTodoAgenda();
    await completeTodoAgendaItem('item-a');
    expect(mocks.updateTodoItem).toHaveBeenCalledWith({ id: 'item-a', status: 'completed' });
    expect(mocks.toggleTodoItem).not.toHaveBeenCalled();
    expect(mocks.reloadCurrentView).toHaveBeenCalled();
    expect(mocks.refreshCounts).toHaveBeenCalled();
    expect(getTodoAgendaSnapshot().items).toHaveLength(0);
  });

  it('支持带 todo: 前缀的 id 并在完成期间防止在途旧刷新回滚', async () => {
    let resolveStaleRefresh!: (items: unknown[]) => void;
    mocks.listTodoLists.mockResolvedValue([]);
    mocks.listAllPendingItems
      .mockResolvedValueOnce([{ id: 'ti_123', status: 'pending', dueDate: '2026-07-12', sortOrder: 0 }])
      .mockImplementationOnce(() => new Promise((resolve) => { resolveStaleRefresh = resolve; }))
      .mockResolvedValueOnce([]);
    mocks.updateTodoItem.mockResolvedValue({ id: 'ti_123', status: 'completed' });

    await refreshTodoAgenda();
    const inFlightRefresh = refreshTodoAgenda();
    const completePromise = completeTodoAgendaItem('todo:ti_123');
    // Stale pre-mutation fetch resolves while completion is running: must NOT resurrect ti_123
    resolveStaleRefresh([{ id: 'ti_123', status: 'pending', dueDate: '2026-07-12', sortOrder: 0 }]);

    await Promise.all([inFlightRefresh, completePromise]);
    expect(mocks.updateTodoItem).toHaveBeenCalledWith({ id: 'ti_123', status: 'completed' });
    expect(getTodoAgendaSnapshot().items).toHaveLength(0);
  });
});
