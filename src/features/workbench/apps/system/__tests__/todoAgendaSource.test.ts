import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listTodoLists: vi.fn(),
  listAllPendingItems: vi.fn(),
  toggleTodoItem: vi.fn(),
  reloadCurrentView: vi.fn(async () => undefined),
}));

vi.mock('@/features/todo/api', () => ({
  listTodoLists: mocks.listTodoLists,
  listAllPendingItems: mocks.listAllPendingItems,
  toggleTodoItem: mocks.toggleTodoItem,
}));

vi.mock('@/features/todo/stores/useTodoStore', () => ({
  useTodoStore: {
    subscribe: () => () => undefined,
    getState: () => ({ reloadCurrentView: mocks.reloadCurrentView }),
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
    mocks.reloadCurrentView.mockClear();
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

  it('完成任务时乐观移除，并刷新 Todo 当前视图', async () => {
    mocks.listTodoLists.mockResolvedValue([]);
    mocks.listAllPendingItems
      .mockResolvedValueOnce([{ id: 'item-a', status: 'pending', dueDate: '2026-07-12', sortOrder: 0 }])
      .mockResolvedValueOnce([]);
    mocks.toggleTodoItem.mockResolvedValue({ id: 'item-a', status: 'completed' });
    await refreshTodoAgenda();
    await completeTodoAgendaItem('item-a');
    expect(mocks.toggleTodoItem).toHaveBeenCalledWith('item-a');
    expect(mocks.reloadCurrentView).toHaveBeenCalled();
    expect(getTodoAgendaSnapshot().items).toHaveLength(0);
  });
});
