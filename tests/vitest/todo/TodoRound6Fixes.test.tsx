import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { TodoItem, TodoList } from '@/features/todo/types';
import { localToday } from '@/features/todo/types';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, opts?: string | Record<string, unknown>) => {
      if (typeof opts === 'string') return opts;
      const map: Record<string, string> = {
        'todo:views.inbox': '收件箱',
        'todo:views.today': '今日',
        'todo:views.upcoming': '即将到期',
        'todo:views.matrix': '四象限',
        'todo:views.overdue': '已过期',
        'todo:views.completed': '已完成',
        'todo:sections.smartViews': '智能视图',
        'todo:sections.lists': '列表',
        'todo:sections.favorites': '收藏',
        'todo:trash.title': '回收站',
        'todo:empty.todayClear': '今日待办已清零',
        'todo:empty.todayClearHint': '享受当下，或去「即将到期」提前规划。',
        'todo:empty.noSearchResults': '没有找到匹配的任务',
        'todo:filters.allPriorities': '全部优先级',
        'todo:fields.dueDate': '截止日期',
        'todo:fields.dueTime': '时间',
        'todo:fields.description': '描述',
        'todo:fields.priority': '优先级',
        'todo:fields.reminder': '提醒',
        'todo:fields.repeat': '重复',
        'todo:fields.tags': '标签',
        'todo:fields.pomodoros': '番茄',
        'todo:reschedule.pickDate': '选择日期',
        'todo:reschedule.clear': '移除日期',
        'todo:dates.today': '今天',
        'todo:dates.yesterday': '昨天',
        'todo:dates.tomorrow': '明天',
        'todo:subtasks.title': '子任务',
        'todo:subtasks.addPlaceholder': '添加子任务...',
        'todo:subtasks.addButton': '添加子任务',
        'todo:subtasks.aiBreakdown': 'AI 拆解',
        'todo:subtasks.openDetail': '查看子任务详情',
        'todo:subtasks.promote': '转为独立任务',
        'todo:actions.markCompleted': '标记为完成',
        'todo:actions.markPending': '标记为未完成',
        'todo:actions.deleteItem': '删除待办',
        'todo:detail.title': '详情',
        'todo:detail.deleteConfirm': '确认删除？可撤销',
        'common:actions.delete': '删除',
        'common:actions.cancel': '取消',
        'common:actions.close': '关闭',
      };
      if (key === 'todo:detail.updatedAt' && opts?.date) return `更新于 ${String(opts.date)}`;
      if (key === 'todo:detail.subtaskProgress' && opts) {
        return `已完成 ${String(opts.done)}/${String(opts.total)} 个子任务`;
      }
      if (key === 'todo:sidebar.pendingBadgeAria' && opts) {
        return `${String(opts.count)} 项待办`;
      }
      if (key === 'todo:overdue.badgeAria' && opts) {
        return `${String(opts.count)} 个逾期待办`;
      }
      if (map[key]) return map[key];
      if (opts && typeof opts.defaultValue === 'string') return opts.defaultValue;
      return key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: false }),
}));

vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
}));

vi.mock('@/hooks/mobile', () => ({
  haptics: { impact: vi.fn() },
}));

vi.mock('@/app/navigation/androidBackCoordinator', () => ({
  registerBackHandler: () => () => {},
  BACK_PRIORITY: { overlay: 10 },
}));

vi.mock('@/features/learning-today', () => ({
  TodayStudySummaryCard: () => null,
}));

vi.mock('@/features/pomodoro', () => {
  const start = vi.fn();
  const usePomodoroStore = Object.assign(
    (selector?: (s: { mode: string; currentTaskId: string | null }) => unknown) =>
      selector ? selector({ mode: 'idle', currentTaskId: null }) : { mode: 'idle', currentTaskId: null },
    { getState: () => ({ start }) },
  );
  return {
    usePomodoroStore,
    PomodoroPanel: () => null,
  };
});

vi.mock('@/features/pomodoro/api', () => ({
  listPomodorosByTodo: vi.fn(async () => []),
}));

import * as todoApi from '@/features/todo/api';
import { useTodoStore } from '@/features/todo/stores/useTodoStore';
import { TodoSidebar } from '@/features/todo/components/TodoSidebar';
import { TodoMainPanel } from '@/features/todo/components/TodoMainPanel';
import { TodoItemDetail } from '@/features/todo/components/main/TodoItemDetail';

const INBOX_LIST: TodoList = {
  id: 'tdl_inbox',
  title: '收件箱',
  sortOrder: 0,
  isDefault: true,
  isFavorite: false,
  createdAt: '2026-11-20T00:00:00Z',
  updatedAt: '2026-11-20T00:00:00Z',
};

function makeItem(overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    id: overrides.id ?? 'ti_1',
    todoListId: overrides.todoListId ?? 'tdl_inbox',
    title: overrides.title ?? '复习高等数学',
    status: overrides.status ?? 'pending',
    priority: overrides.priority ?? 'none',
    tagsJson: overrides.tagsJson ?? '[]',
    sortOrder: overrides.sortOrder ?? 0,
    attachmentsJson: overrides.attachmentsJson ?? '[]',
    createdAt: '2026-11-20T08:00:00Z',
    updatedAt: '2026-11-25T08:00:00Z',
    ...overrides,
  };
}

describe('Todo Round 6 P1 fixes (S4-09 #1-#5)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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
    Element.prototype.scrollIntoView = vi.fn();

    vi.spyOn(todoApi, 'listAllTags').mockResolvedValue([]);
    vi.spyOn(todoApi, 'getTodoCountsSnapshot').mockResolvedValue({
      todayCount: 0,
      upcomingCount: 0,
      inboxCount: 0,
      allPendingCount: 0,
      perList: [{ listId: 'tdl_inbox', pendingCount: 0 }],
    });
    vi.spyOn(todoApi, 'getTodoTrashCounts').mockResolvedValue({ deletedItems: 0, deletedLists: 0 });
    vi.spyOn(todoApi, 'getActiveTodoSummary').mockResolvedValue(null);
    vi.spyOn(todoApi, 'getTodoStatsOverview').mockResolvedValue({
      totalPending: 0,
      totalCompleted: 0,
      completedToday: 0,
      overdueCount: 0,
      completionTrend: [],
      byList: [],
      byPriority: [],
      byTag: [],
    });

    useTodoStore.setState({
      workspaceView: 'todos',
      lists: [INBOX_LIST],
      activeListId: null,
      items: [],
      selectedItemId: null,
      hasUserSelectedView: false,
      overdueCount: 0,
      todayCompletedCount: 0,
      counts: null,
      isLoadingLists: false,
      isLoadingItems: false,
      itemsRequestVersion: 0,
      error: null,
      filter: {
        view: 'today',
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

  it('#1: syncs 今日 sidebar badge with loaded top-level items and always renders empty state when 0 items', async () => {
    // Backend snapshot stale/subtask-inflated as 3 while Today view actually has 0 top-level tasks
    vi.spyOn(todoApi, 'getTodoCountsSnapshot').mockResolvedValue({
      todayCount: 3,
      upcomingCount: 0,
      inboxCount: 0,
      allPendingCount: 3,
      perList: [{ listId: 'tdl_inbox', pendingCount: 0 }],
    });
    vi.spyOn(todoApi, 'listTodayItems').mockResolvedValue([]);

    useTodoStore.setState({
      counts: {
        todayCount: 3,
        upcomingCount: 0,
        inboxCount: 0,
        allPendingCount: 3,
        perList: [{ listId: 'tdl_inbox', pendingCount: 0 }],
      },
      filter: {
        view: 'today',
        search: '',
        priorityFilter: null,
        showCompleted: false,
        sortBy: 'manual',
      },
      items: [],
      isLoadingItems: false,
    });

    await useTodoStore.getState().loadTodayItems();
    // Store reconciles counts.todayCount to 0 (matching empty Today list)
    expect(useTodoStore.getState().counts?.todayCount).toBe(0);

    render(
      <div>
        <TodoSidebar />
        <TodoMainPanel />
      </div>,
    );

    // Sidebar 今日 row must NOT contradict empty list with badge "3"
    const todayNav = screen.getByTestId('todo-sidebar-smart-today');
    expect(within(todayNav).queryByText('3')).toBeNull();
    // Main panel renders explicit visible empty state copy (never blank)
    expect(screen.getByTestId('todo-empty-state')).toBeInTheDocument();
    expect(screen.getByText('今日待办已清零')).toBeInTheDocument();

    // Priority filter reducing visible items to 0 also renders visible empty state (never blank)
    act(() => {
      useTodoStore.setState({
        items: [makeItem({ id: 't_low', title: '低优先级任务', priority: 'low', dueDate: localToday() })],
        filter: {
          view: 'today',
          search: '',
          priorityFilter: 'urgent',
          showCompleted: false,
          sortBy: 'manual',
        },
      });
    });
    expect(screen.getByTestId('todo-empty-state')).toBeInTheDocument();
    expect(screen.getByText('没有找到匹配的任务')).toBeInTheDocument();

    // Concurrent initialize() (StrictMode double-mount) deduplicates without wiping items
    const today = localToday();
    const t1 = makeItem({ id: 't_1', title: '今日第一项', dueDate: today });
    vi.spyOn(todoApi, 'ensureInbox').mockResolvedValue(INBOX_LIST);
    vi.spyOn(todoApi, 'listTodoLists').mockResolvedValue([INBOX_LIST]);
    vi.spyOn(todoApi, 'listTodoItems').mockResolvedValue([]);
    vi.spyOn(todoApi, 'listTodayItems').mockResolvedValue([t1]);
    vi.spyOn(todoApi, 'getTodoCountsSnapshot').mockResolvedValue({
      todayCount: 3,
      upcomingCount: 0,
      inboxCount: 0,
      allPendingCount: 3,
      perList: [{ listId: 'tdl_inbox', pendingCount: 0 }],
    });
    useTodoStore.setState({ lists: [], items: [], activeListId: null, hasUserSelectedView: false });

    await Promise.all([
      useTodoStore.getState().initialize(),
      useTodoStore.getState().initialize(),
    ]);

    const afterInit = useTodoStore.getState();
    expect(afterInit.filter.view).toBe('today');
    expect(afterInit.isLoadingItems).toBe(false);
    expect(afterInit.items.map((i) => i.id)).toEqual(['t_1']);
    expect(afterInit.counts?.todayCount).toBe(1);
  });

  it('#2: excludes subtasks from top-level task list rows and counts in both manual list and Today views', () => {
    const today = localToday();
    const p1 = makeItem({ id: 'p_1', title: '父任务一', dueDate: today, sortOrder: 0 });
    const p2 = makeItem({ id: 'p_2', title: '父任务二', dueDate: today, sortOrder: 1 });
    const p3 = makeItem({ id: 'p_3', title: '父任务三', dueDate: today, sortOrder: 2 });
    const sub1 = makeItem({ id: 's_1', parentId: 'p_1', title: '子任务 A', dueDate: today, status: 'pending' });
    const sub2 = makeItem({ id: 's_2', parentId: 'p_1', title: '子任务 B', dueDate: today, status: 'completed' });

    useTodoStore.setState({
      lists: [INBOX_LIST],
      activeListId: null,
      items: [p1, p2, p3, sub1, sub2],
      counts: {
        todayCount: 5, // stale backend count including subtasks
        upcomingCount: 0,
        inboxCount: 5,
        allPendingCount: 5,
        perList: [{ listId: 'tdl_inbox', pendingCount: 5 }],
      },
      filter: { view: 'today', search: '', priorityFilter: null, showCompleted: false, sortBy: 'manual' },
    });

    const { container, rerender } = render(
      <div>
        <TodoSidebar />
        <TodoMainPanel />
      </div>,
    );

    // Exactly 3 top-level rows rendered (never 5 flat rows)
    const renderedRows = container.querySelectorAll('[data-agent-entity^="todo:"]');
    expect(renderedRows).toHaveLength(3);
    expect(container.querySelector('[data-agent-entity="todo:s_1"]')).toBeNull();
    expect(container.querySelector('[data-agent-entity="todo:s_2"]')).toBeNull();
    // Parent row displays live subtask progress 1/2
    expect(screen.getByTestId('todo-row-subtasks-p_1')).toHaveTextContent('1/2');
    // Sidebar 今日 badge shows 3 (parent-only pending), NOT 5
    expect(within(screen.getByTestId('todo-sidebar-smart-today')).getByText('3')).toBeInTheDocument();

    // Same invariant in manual-sort Inbox ('all') view
    useTodoStore.setState({
      activeListId: 'tdl_inbox',
      filter: { view: 'all', search: '', priorityFilter: null, showCompleted: false, sortBy: 'manual' },
    });
    rerender(
      <div>
        <TodoSidebar />
        <TodoMainPanel />
      </div>,
    );
    expect(container.querySelectorAll('[data-agent-entity^="todo:"]')).toHaveLength(3);
    expect(container.querySelector('[data-agent-entity="todo:s_1"]')).toBeNull();
    expect(within(screen.getByTestId('todo-sidebar-smart-all')).getByText('3')).toBeInTheDocument();
  });

  it('#3: renders interactive per-subtask checkboxes with checked state, strikethrough, toggle/uncheck, and live progress in detail panel', async () => {
    const db: TodoItem[] = [
      makeItem({ id: 'p_detail', title: '准备高数期中' }),
      makeItem({ id: 'sub_1', parentId: 'p_detail', title: '整理泰勒公式', status: 'pending', sortOrder: 0 }),
      makeItem({ id: 'sub_2', parentId: 'p_detail', title: '刷三套真题', status: 'completed', sortOrder: 1 }),
    ];

    vi.spyOn(todoApi, 'listTodoItems').mockImplementation(async () => db.map((item) => ({ ...item })));
    vi.spyOn(todoApi, 'toggleTodoItem').mockImplementation(async (id: string) => {
      const target = db.find((i) => i.id === id)!;
      target.status = target.status === 'completed' ? 'pending' : 'completed';
      return { ...target };
    });
    vi.spyOn(todoApi, 'listTodayItems').mockImplementation(async () => [{ ...db[0] }]);

    // Start with ONLY the parent in store (e.g. Matrix/Completed view) to verify ensureSubtasksLoaded too
    useTodoStore.setState({
      items: [{ ...db[0] }],
      selectedItemId: 'p_detail',
      filter: { view: 'today', search: '', priorityFilter: null, showCompleted: false, sortBy: 'manual' },
    });

    const DetailHarness = () => {
      const currentParent = useTodoStore((s) => s.items.find((i) => i.id === 'p_detail')!);
      return <TodoItemDetail item={currentParent} onClose={vi.fn()} />;
    };

    render(<DetailHarness />);

    // Wait for fallback subtask load & assert accessible checkboxes + initial progress 1/2 (50%)
    const cb1 = await screen.findByTestId('subtask-checkbox-sub_1');
    const cb2 = screen.getByTestId('subtask-checkbox-sub_2');
    expect(cb1).toHaveAttribute('role', 'checkbox');
    expect(cb1).toHaveAttribute('aria-checked', 'false');
    expect(cb1).toHaveAttribute('data-state', 'unchecked');
    expect(cb2).toHaveAttribute('role', 'checkbox');
    expect(cb2).toHaveAttribute('aria-checked', 'true');
    expect(cb2).toHaveAttribute('data-state', 'checked');
    expect(screen.getByTestId('subtask-title-sub_1').className).not.toContain('line-through');
    expect(screen.getByTestId('subtask-title-sub_2').className).toContain('line-through');
    expect(screen.getByTestId('subtask-progress-count')).toHaveTextContent('1/2');
    expect(screen.getByTestId('subtask-progress-percent')).toHaveTextContent('(50%)');

    // Toggle sub_1 pending -> completed: checked + strikethrough + live 2/2 (100%)
    fireEvent.click(cb1);
    await waitFor(() => {
      expect(screen.getByTestId('subtask-checkbox-sub_1')).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByTestId('subtask-title-sub_1').className).toContain('line-through');
      expect(screen.getByTestId('subtask-progress-count')).toHaveTextContent('2/2');
      expect(screen.getByTestId('subtask-progress-percent')).toHaveTextContent('(100%)');
    });

    // Uncheck sub_2 completed -> pending: unchecked + strikethrough removed + live 1/2 (50%)
    fireEvent.click(screen.getByTestId('subtask-checkbox-sub_2'));
    await waitFor(() => {
      expect(screen.getByTestId('subtask-checkbox-sub_2')).toHaveAttribute('aria-checked', 'false');
      expect(screen.getByTestId('subtask-title-sub_2').className).not.toContain('line-through');
      expect(screen.getByTestId('subtask-progress-count')).toHaveTextContent('1/2');
      expect(screen.getByTestId('subtask-progress-percent')).toHaveTextContent('(50%)');
    });
  });

  it('#4: preserves existing overdue dueDate when editing time, and defaults to today only when no date was set', async () => {
    const overdueItem = makeItem({
      id: 'ti_overdue',
      title: '逾期作业',
      dueDate: '2026-11-20',
      dueTime: '09:00',
    });
    const noDateItem = makeItem({
      id: 'ti_nodate',
      title: '无日期任务',
      dueDate: undefined,
      dueTime: undefined,
    });

    const updateSpy = vi.spyOn(todoApi, 'updateTodoItem').mockImplementation(async (input) => {
      const base = useTodoStore.getState().items.find((i) => i.id === input.id)!;
      return {
        ...base,
        dueDate: input.dueDate !== undefined ? (input.dueDate || undefined) : base.dueDate,
        dueTime: input.dueTime !== undefined ? (input.dueTime || undefined) : base.dueTime,
      };
    });
    vi.spyOn(todoApi, 'listTodoItems').mockResolvedValue([overdueItem, noDateItem]);
    vi.spyOn(todoApi, 'listTodayItems').mockResolvedValue([overdueItem]);

    useTodoStore.setState({
      items: [overdueItem, noDateItem],
      activeListId: 'tdl_inbox',
      filter: { view: 'all', search: '', priorityFilter: null, showCompleted: false, sortBy: 'manual' },
    });

    const { rerender } = render(<TodoItemDetail key={overdueItem.id} item={overdueItem} onClose={vi.fn()} />);

    // Edit time on overdue task -> must preserve 2026-11-20 (never revert to 选择日期)
    const timeInput = screen.getByTestId('todo-detail-due-time');
    fireEvent.change(timeInput, { target: { value: '18:30' } });

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'ti_overdue',
          dueDate: '2026-11-20',
          dueTime: '18:30',
        }),
      );
    });
    expect(screen.queryByText('选择日期')).toBeNull();
    expect(useTodoStore.getState().items.find((i) => i.id === 'ti_overdue')?.dueDate).toBe('2026-11-20');

    // Clear time -> must still preserve existing 2026-11-20 dueDate
    fireEvent.change(timeInput, { target: { value: '' } });
    await waitFor(() => {
      expect(updateSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          id: 'ti_overdue',
          dueDate: '2026-11-20',
          dueTime: '',
        }),
      );
    });
    expect(useTodoStore.getState().items.find((i) => i.id === 'ti_overdue')?.dueDate).toBe('2026-11-20');

    // Edit time on no-due-date task -> defaults dueDate to today
    updateSpy.mockClear();
    rerender(<TodoItemDetail key={noDateItem.id} item={noDateItem} onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId('todo-detail-due-time'), { target: { value: '14:15' } });
    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'ti_nodate',
          dueDate: localToday(),
          dueTime: '14:15',
        }),
      );
    });
  });

  it('#5: expands delete confirmation bar across full footer with nowrap layout and cancels reliably on a single click', () => {
    const item = makeItem({ id: 'ti_del', title: '待删任务' });
    const deleteSpy = vi.spyOn(todoApi, 'deleteTodoItem').mockResolvedValue(undefined);
    const onClose = vi.fn();

    useTodoStore.setState({ items: [item] });
    render(<TodoItemDetail item={item} onClose={onClose} />);

    // Timestamp visible initially
    expect(screen.getByTestId('todo-detail-updated-at')).toBeInTheDocument();

    // First click opens full-width non-collapsing confirmation bar & hides footer timestamp
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(screen.queryByTestId('todo-detail-updated-at')).toBeNull();

    const confirmBar = screen.getByTestId('inline-confirm-delete-bar');
    expect(confirmBar.className).toContain('w-full');
    expect(screen.getByRole('alert').className).toContain('whitespace-nowrap');

    const cancelBtn = screen.getByTestId('inline-confirm-delete-cancel');
    expect(cancelBtn.className).toContain('whitespace-nowrap');

    // Single click on 取消 closes bar immediately without deleting
    fireEvent.click(cancelBtn);
    expect(screen.queryByTestId('inline-confirm-delete-bar')).toBeNull();
    expect(screen.getByTestId('todo-detail-updated-at')).toBeInTheDocument();
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
