import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TodoItem, TodoList } from '../../types';

const {
  createTodoItemApiMock,
  createTodoListApiMock,
  updateTodoItemApiMock,
  listTodoItemsApiMock,
  listTodayItemsApiMock,
  listOverdueItemsApiMock,
  getTodoCountsSnapshotApiMock,
  getTodoTrashCountsApiMock,
  getActiveTodoSummaryApiMock,
} = vi.hoisted(() => ({
  createTodoItemApiMock: vi.fn(),
  createTodoListApiMock: vi.fn(),
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
    createTodoItem: createTodoItemApiMock,
    createTodoList: createTodoListApiMock,
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
import { TodoQuickAdd } from '../main/TodoQuickAdd';
import { SubtaskSection } from '../main/detail/SubtaskSection';

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
    id: 'ti_u03_1',
    todoListId: 'tdl_inbox',
    title: '高数习题整理',
    description: '原始备注',
    status: 'pending',
    priority: 'none',
    tagsJson: '[]',
    sortOrder: 0,
    attachmentsJson: '[]',
    createdAt: '2026-11-24T00:00:00Z',
    updatedAt: '2026-11-24T00:00:00Z',
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

describe('U03 Todo dirty-form protection & rapid double-click idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
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
    vi.useRealTimers();
  });

  describe('TodoItemDetail unsaved changes guard', () => {
    it('closes immediately on Escape or close button when form is clean', () => {
      const onClose = vi.fn();
      const { container } = render(<TodoItemDetail item={makeItem()} onClose={onClose} />);

      fireEvent.click(screen.getByRole('button', { name: 'common:actions.close' }));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('unsaved-changes-guard-bar')).toBeNull();

      onClose.mockClear();
      fireEvent.keyDown(container.querySelector('[data-todo-detail-panel]')!, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('unsaved-changes-guard-bar')).toBeNull();
    });

    it('prompts inline instead of silently discarding description edits on Escape, supports continue editing and discard without persisting', () => {
      vi.useFakeTimers();
      const onClose = vi.fn();
      const item = makeItem();
      useTodoStore.setState({ items: [item] });

      const { unmount } = render(<TodoItemDetail item={item} onClose={onClose} />);

      const desc = screen.getByTestId('todo-detail-description') as HTMLTextAreaElement;
      fireEvent.change(desc, { target: { value: '还没保存的重要推导笔记' } });

      // Accidental Escape before 200ms auto-save must NOT wipe text or close immediately
      fireEvent.keyDown(desc, { key: 'Escape' });

      expect(onClose).not.toHaveBeenCalled();
      expect(desc.value).toBe('还没保存的重要推导笔记');
      const guardBar = screen.getByTestId('unsaved-changes-guard-bar');
      expect(guardBar).toHaveTextContent('有未保存修改，确定放弃？');
      expect(screen.getByTestId('unsaved-changes-continue')).toHaveTextContent('继续编辑');
      expect(screen.getByTestId('unsaved-changes-discard')).toHaveTextContent('放弃修改');

      // Advancing past 200ms while confirmation prompt is open must NOT auto-save behind the user's back
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(updateTodoItemApiMock).not.toHaveBeenCalled();
      expect(screen.getByTestId('unsaved-changes-guard-bar')).toBeInTheDocument();

      // Clicking "继续编辑" dismisses prompt and preserves typed text
      fireEvent.click(screen.getByTestId('unsaved-changes-continue'));
      expect(screen.queryByTestId('unsaved-changes-guard-bar')).toBeNull();
      expect(desc.value).toBe('还没保存的重要推导笔记');
      expect(onClose).not.toHaveBeenCalled();

      // Clicking Close button while still dirty shows inline prompt again
      fireEvent.click(screen.getByRole('button', { name: 'common:actions.close' }));
      expect(screen.getByTestId('unsaved-changes-guard-bar')).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();

      // Clicking "放弃修改" reverts draft, closes panel, and unmount does NOT save discarded text
      fireEvent.click(screen.getByTestId('unsaved-changes-discard'));
      expect(onClose).toHaveBeenCalledTimes(1);
      unmount();
      expect(updateTodoItemApiMock).not.toHaveBeenCalled();
    });

    it('closes cleanly without prompting after Cmd+Enter flushes edits', async () => {
      const item = makeItem();
      updateTodoItemApiMock.mockResolvedValue({ ...item, title: '已保存新标题' });
      useTodoStore.setState({ items: [item] });
      const onClose = vi.fn();

      const { container } = render(<TodoItemDetail item={item} onClose={onClose} />);
      const titleInput = screen.getByPlaceholderText('todo:placeholders.title');
      fireEvent.change(titleInput, { target: { value: '已保存新标题' } });

      fireEvent.keyDown(container.querySelector('[data-todo-detail-panel]')!, {
        key: 'Enter',
        metaKey: true,
      });

      await waitFor(() => {
        expect(updateTodoItemApiMock).toHaveBeenCalledWith({
          id: item.id,
          title: '已保存新标题',
        });
      });

      fireEvent.click(screen.getByRole('button', { name: 'common:actions.close' }));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('unsaved-changes-guard-bar')).toBeNull();
    });
  });

  describe('useTodoStore rapid double-click / weak-network idempotency', () => {
    it('deduplicates concurrent identical createItem calls under weak network latency and releases lock in finally', async () => {
      const slowCreate = deferred<TodoItem>();
      createTodoItemApiMock.mockReturnValueOnce(slowCreate.promise);

      const input = { todoListId: INBOX.id, title: '弱网双击测试待办', priority: 'high' as const };
      const p1 = useTodoStore.getState().createItem(input);
      const p2 = useTodoStore.getState().createItem(input);

      expect(createTodoItemApiMock).toHaveBeenCalledTimes(1);

      const created = makeItem({ id: 'ti_dedup_1', title: '弱网双击测试待办', priority: 'high' });
      listTodoItemsApiMock.mockResolvedValue([created]);
      slowCreate.resolve(created);

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBe(created);
      expect(r2).toBe(created);
      expect(useTodoStore.getState().items.filter((i) => i.id === 'ti_dedup_1')).toHaveLength(1);

      // Lock must be released after rejection so retry works cleanly
      const failingCreate = deferred<TodoItem>();
      createTodoItemApiMock.mockReturnValueOnce(failingCreate.promise);
      const retryInput = { todoListId: INBOX.id, title: '弱网重试待办' };
      const pFail = useTodoStore.getState().createItem(retryInput);
      failingCreate.reject(new Error('network timeout'));
      await expect(pFail).rejects.toThrow('network timeout');

      const retryCreated = makeItem({ id: 'ti_retry_1', title: '弱网重试待办' });
      createTodoItemApiMock.mockResolvedValueOnce(retryCreated);
      await expect(useTodoStore.getState().createItem(retryInput)).resolves.toEqual(retryCreated);
      expect(createTodoItemApiMock).toHaveBeenCalledTimes(3);
    });

    it('deduplicates concurrent identical createList and updateItem calls while in flight', async () => {
      const slowList = deferred<TodoList>();
      createTodoListApiMock.mockReturnValueOnce(slowList.promise);

      const lp1 = useTodoStore.getState().createList('期末复习');
      const lp2 = useTodoStore.getState().createList('期末复习');
      expect(createTodoListApiMock).toHaveBeenCalledTimes(1);
      const createdList: TodoList = { ...INBOX, id: 'tdl_exam', title: '期末复习', isDefault: false };
      slowList.resolve(createdList);
      await Promise.all([lp1, lp2]);

      const baseItem = makeItem({ id: 'ti_upd_1' });
      useTodoStore.setState({ items: [baseItem] });
      const slowUpdate = deferred<TodoItem>();
      updateTodoItemApiMock.mockReturnValueOnce(slowUpdate.promise);

      const up1 = useTodoStore.getState().updateItem({ id: 'ti_upd_1', description: '同一份保存' });
      const up2 = useTodoStore.getState().updateItem({ id: 'ti_upd_1', description: '同一份保存' });
      expect(updateTodoItemApiMock).toHaveBeenCalledTimes(1);

      slowUpdate.resolve({ ...baseItem, description: '同一份保存' });
      await Promise.all([up1, up2]);
    });
  });

  describe('TodoQuickAdd & SubtaskSection double-click guards', () => {
    it('prevents rapid double-clicking Add button or pressing Enter twice in TodoQuickAdd from creating 2 todos', async () => {
      const slowCreate = deferred<TodoItem>();
      createTodoItemApiMock.mockReturnValueOnce(slowCreate.promise);

      render(<TodoQuickAdd />);
      const input = document.querySelector('[data-todo-quick-add]') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '买牛奶' } });

      const addButton = screen.getByRole('button', { name: 'todo:actions.add' });
      fireEvent.click(addButton);
      fireEvent.click(addButton);
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(createTodoItemApiMock).toHaveBeenCalledTimes(1);
      expect(addButton).toBeDisabled();

      slowCreate.resolve(makeItem({ id: 'ti_milk', title: '买牛奶' }));
      await waitFor(() => {
        expect(input.value).toBe('');
      });

      // After error, submit lock releases cleanly in finally
      const failingCreate = deferred<TodoItem>();
      createTodoItemApiMock.mockReturnValueOnce(failingCreate.promise);
      fireEvent.change(input, { target: { value: '重试任务' } });
      const retryBtn = screen.getByRole('button', { name: 'todo:actions.add' });
      fireEvent.click(retryBtn);
      expect(retryBtn).toBeDisabled();

      failingCreate.reject(new Error('offline'));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'todo:actions.add' })).toBeEnabled();
      });
    });

    it('prevents same-tick double click in SubtaskSection from firing duplicate createItem calls', async () => {
      const slowSubtask = deferred<TodoItem>();
      createTodoItemApiMock.mockReturnValueOnce(slowSubtask.promise);

      const parent = makeItem({ id: 'ti_parent_1' });
      useTodoStore.setState({ items: [parent] });

      render(<SubtaskSection item={parent} subtasks={[]} />);
      const input = screen.getByPlaceholderText('todo:subtasks.addPlaceholder');
      fireEvent.change(input, { target: { value: '刷完第一套卷子' } });

      const addBtn = screen.getByRole('button', { name: '添加子任务' });
      fireEvent.click(addBtn);
      fireEvent.click(addBtn);

      expect(createTodoItemApiMock).toHaveBeenCalledTimes(1);

      const createdSub = makeItem({ id: 'ti_sub_1', parentId: parent.id, title: '刷完第一套卷子' });
      listTodoItemsApiMock.mockResolvedValue([parent, createdSub]);
      slowSubtask.resolve(createdSub);
      await waitFor(() => {
        expect(useTodoStore.getState().items.some((i) => i.id === 'ti_sub_1')).toBe(true);
      });
    });
  });
});
