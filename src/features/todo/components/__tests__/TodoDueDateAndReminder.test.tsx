import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TodoItem, TodoList } from '../../types';

const {
  updateTodoItemApiMock,
  listTodoItemsApiMock,
  listTodayItemsApiMock,
  listOverdueItemsApiMock,
  getTodoCountsSnapshotApiMock,
  getTodoTrashCountsApiMock,
  getActiveTodoSummaryApiMock,
} = vi.hoisted(() => ({
  updateTodoItemApiMock: vi.fn(),
  listTodoItemsApiMock: vi.fn(async () => []),
  listTodayItemsApiMock: vi.fn(async () => []),
  listOverdueItemsApiMock: vi.fn(async () => []),
  getTodoCountsSnapshotApiMock: vi.fn(async () => null),
  getTodoTrashCountsApiMock: vi.fn(async () => null),
  getActiveTodoSummaryApiMock: vi.fn(async () => null),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, opts?: string | Record<string, unknown>) =>
      typeof opts === 'string'
        ? opts
        : opts && typeof opts.defaultValue === 'string'
          ? opts.defaultValue
          : key,
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('@/hooks/mobile', () => ({ haptics: { impact: vi.fn() } }));
vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => false }));
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => ({ isSmallScreen: false }) }));
vi.mock('@/app/navigation/androidBackCoordinator', () => ({
  registerBackHandler: () => () => {},
  BACK_PRIORITY: { overlay: 10, view: 5 },
}));
vi.mock('@/features/pomodoro', () => ({
  usePomodoroStore: { getState: () => ({ start: vi.fn() }) },
}));
vi.mock('@/features/pomodoro/api', () => ({
  listPomodorosByTodo: vi.fn(async () => []),
}));
vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    listAllTags: vi.fn(async () => []),
    updateTodoItem: updateTodoItemApiMock,
    listTodoItems: listTodoItemsApiMock,
    listTodayItems: listTodayItemsApiMock,
    listOverdueItems: listOverdueItemsApiMock,
    getTodoCountsSnapshot: getTodoCountsSnapshotApiMock,
    getTodoTrashCounts: getTodoTrashCountsApiMock,
    getActiveTodoSummary: getActiveTodoSummaryApiMock,
  };
});

import { useTodoStore } from '../../stores/useTodoStore';
import { TodoItemDetail } from '../main/TodoItemDetail';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeItem(overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    id: 'ti_g12_1',
    todoListId: 'tdl_inbox',
    title: '交英语作文初稿',
    description: '',
    status: 'pending',
    priority: 'medium',
    dueDate: '2026-11-26',
    dueTime: undefined,
    reminder: undefined,
    tagsJson: '[]',
    sortOrder: 0,
    attachmentsJson: '[]',
    createdAt: '2026-11-20T00:00:00Z',
    updatedAt: '2026-11-20T00:00:00Z',
    ...overrides,
  };
}

const INBOX: TodoList = {
  id: 'tdl_inbox',
  title: '收件箱',
  sortOrder: 0,
  isDefault: true,
  isFavorite: false,
  createdAt: '2026-11-20T00:00:00Z',
  updatedAt: '2026-11-20T00:00:00Z',
};

describe('Todo due-date atomic save & reminder input (G12)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: true,
        media: '',
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    useTodoStore.setState({
      lists: [INBOX],
      activeListId: INBOX.id,
      items: [],
      selectedItemId: null,
      quickAddPreset: null,
      isLoadingItems: false,
      isLoadingLists: false,
      itemsRequestVersion: 0,
      error: null,
      filter: {
        view: 'all',
        search: '',
        priorityFilter: null,
        showCompleted: false,
        sortBy: 'manual',
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('merges concurrent in-flight dueDate and dueTime updates so dueDate never reverts to 11/26', async () => {
    const initial = makeItem({ dueDate: '2026-11-26', dueTime: undefined });
    let persisted = { ...initial };
    listTodoItemsApiMock.mockImplementation(async () => [persisted]);
    useTodoStore.setState({ items: [initial] });

    const req1 = deferred<TodoItem>();
    const req2 = deferred<TodoItem>();
    updateTodoItemApiMock
      .mockReturnValueOnce(req1.promise)
      .mockReturnValueOnce(req2.promise);

    // User changes dueDate to 2026-11-24 and immediately sets dueTime to 09:00 while req1 is still in flight
    const p1 = useTodoStore.getState().updateItem({ id: initial.id, dueDate: '2026-11-24' });
    const p2 = useTodoStore.getState().updateItem({ id: initial.id, dueTime: '09:00' });

    expect(updateTodoItemApiMock).toHaveBeenCalledTimes(2);
    expect(updateTodoItemApiMock).toHaveBeenNthCalledWith(1, {
      id: initial.id,
      dueDate: '2026-11-24',
    });
    // Critical G12 fix: second payload merges the in-flight dueDate rather than sending only dueTime
    expect(updateTodoItemApiMock).toHaveBeenNthCalledWith(2, {
      id: initial.id,
      dueDate: '2026-11-24',
      dueTime: '09:00',
    });

    // Even if req1 resolves first with only dueDate (without dueTime), optimistic state keeps both
    persisted = { ...initial, dueDate: '2026-11-24', dueTime: undefined };
    req1.resolve(persisted);
    await p1;
    expect(useTodoStore.getState().items[0]).toMatchObject({
      dueDate: '2026-11-24',
      dueTime: '09:00',
    });

    persisted = { ...initial, dueDate: '2026-11-24', dueTime: '09:00' };
    req2.resolve(persisted);
    await p2;
    expect(useTodoStore.getState().items[0]).toMatchObject({
      dueDate: '2026-11-24',
      dueTime: '09:00',
    });
  });

  it('prevents stale item prop re-renders from clobbering an in-flight dueDate edit and commits reminder with accessible label', async () => {
    const initial = makeItem({ dueDate: '2026-11-26', dueTime: '09:00' });
    useTodoStore.setState({ items: [initial] });

    const slowReminder = deferred<TodoItem>();
    updateTodoItemApiMock.mockReturnValueOnce(slowReminder.promise);

    const { rerender } = render(<TodoItemDetail item={initial} onClose={vi.fn()} />);

    const reminderInput = screen.getByLabelText('todo:fields.reminder') as HTMLInputElement;
    expect(reminderInput).toHaveAttribute('data-testid', 'todo-detail-reminder');

    // Setting a complete YYYY-MM-DDTHH:MM reminder commits immediately without waiting for blur debounce
    fireEvent.change(reminderInput, { target: { value: '2026-11-24T09:00' } });

    await waitFor(() => {
      expect(updateTodoItemApiMock).toHaveBeenCalledWith({
        id: initial.id,
        reminder: '2026-11-24T09:00',
      });
    });

    // A stale prop re-render while the reminder update is in flight must NOT wipe the input
    rerender(<TodoItemDetail item={{ ...initial, title: '标题被外部更新' }} onClose={vi.fn()} />);
    expect(reminderInput.value).toBe('2026-11-24T09:00');

    slowReminder.resolve({ ...initial, reminder: '2026-11-24T09:00' });
    await waitFor(() => {
      expect(useTodoStore.getState().items[0]?.reminder).toBe('2026-11-24T09:00');
    });
  });
});
