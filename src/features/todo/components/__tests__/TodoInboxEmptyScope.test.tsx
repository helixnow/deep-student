import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, opts?: string | Record<string, unknown>) => {
      if (typeof opts === 'string') return opts;
      if (key === 'todo:empty.scopeCaption' && opts) {
        return `当前视图：${String(opts.view)}（共 ${String(opts.count)} 项）`;
      }
      if (key === 'todo:empty.inboxClearWithToday' && opts) {
        return `收件箱已清空 · 今日还有 ${String(opts.count)} 项待办`;
      }
      if (key === 'todo:empty.listEmptyWithToday' && opts) {
        return `「${String(opts.list)}」为空 · 今日还有 ${String(opts.count)} 项待办`;
      }
      if (key === 'todo:empty.inboxClearWithTodayHint') {
        return '你的待办安排在今日日程或其他列表中，点击下方按钮立即查看。';
      }
      if (key === 'todo:empty.noItems') {
        return '暂无待办事项';
      }
      if (key === 'todo:empty.viewTodayWithCount' && opts) {
        return `查看今日待办 (${String(opts.count)})`;
      }
      if (key === 'todo:views.inbox') return '收件箱';
      if (opts && typeof opts.defaultValue === 'string') return opts.defaultValue;
      return key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
}));

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: false }),
}));

vi.mock('@/hooks/mobile', () => ({
  haptics: { impact: vi.fn() },
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

import { TodoMainPanel } from '../TodoMainPanel';
import { useTodoStore } from '../../stores/useTodoStore';
import * as todoApi from '../../api';

describe('TodoMainPanel Inbox empty scope clarity & initial Today fallback (S4-09)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useTodoStore.setState({
      items: [],
      lists: [],
      activeListId: null,
      hasUserSelectedView: false,
      overdueCount: 0,
      isLoadingItems: false,
      filter: {
        view: 'all',
        listId: null,
        search: '',
        priorityFilter: null,
        showCompleted: false,
        sortBy: 'manual',
      },
      counts: {
        inboxCount: 0,
        todayCount: 3,
        todayCompletedCount: 0,
        upcomingCount: 3,
        overdueCount: 0,
        completedCount: 0,
        allCount: 3,
      },
    } as never);
  });

  it('shows explicit "收件箱已清空 · 今日还有 3 项待办" card + primary View Today CTA and never renders generic "暂无待办事项"', () => {
    const setViewFilter = vi.fn();
    useTodoStore.setState({ setViewFilter } as never);

    render(<TodoMainPanel />);

    expect(screen.getByText('收件箱已清空 · 今日还有 3 项待办')).toBeInTheDocument();
    expect(screen.queryByText('暂无待办事项')).not.toBeInTheDocument();
    expect(screen.getByTestId('todo-empty-scope-caption')).toHaveTextContent(
      '当前视图：收件箱（共 0 项）',
    );
    const todayCta = screen.getByTestId('todo-empty-view-today');
    expect(todayCta).toHaveTextContent('查看今日待办 (3)');
    fireEvent.click(todayCta);
    expect(setViewFilter).toHaveBeenCalledWith('today');
  });

  it('still renders the Today/Overdue CTA card when counts snapshot is null but overdueCount > 0', () => {
    useTodoStore.setState({
      counts: null,
      overdueCount: 3,
    } as never);

    render(<TodoMainPanel />);

    expect(screen.getByText('收件箱已清空 · 今日还有 3 项待办')).toBeInTheDocument();
    expect(screen.queryByText('暂无待办事项')).not.toBeInTheDocument();
    expect(screen.getByTestId('todo-empty-view-today')).toHaveTextContent('查看今日待办 (3)');
  });

  it('auto-selects "today" on initialize() when Inbox is empty while Today/Overdue has pending tasks', async () => {
    const inboxList = {
      id: 'tdl_inbox',
      title: '收件箱',
      sortOrder: 0,
      isDefault: true,
      isFavorite: false,
      createdAt: '2026-11-25T00:00:00Z',
      updatedAt: '2026-11-25T00:00:00Z',
    };
    const todayTask = {
      id: 'ti_today_1',
      todoListId: 'tdl_math',
      title: '重做泰勒公式例题',
      status: 'pending' as const,
      priority: 'high' as const,
      dueDate: '2026-11-25',
      tagsJson: '[]',
      sortOrder: 0,
      attachmentsJson: '[]',
      createdAt: '2026-11-25T00:00:00Z',
      updatedAt: '2026-11-25T00:00:00Z',
    };

    vi.spyOn(todoApi, 'ensureInbox').mockResolvedValue(inboxList);
    vi.spyOn(todoApi, 'listTodoLists').mockResolvedValue([inboxList]);
    vi.spyOn(todoApi, 'listTodoItems').mockResolvedValue([]);
    vi.spyOn(todoApi, 'getActiveTodoSummary').mockResolvedValue({
      items: [todayTask],
      stats: { totalPending: 3, overdueCount: 1, dueTodayCount: 2 },
    } as never);
    vi.spyOn(todoApi, 'getTodoCountsSnapshot').mockResolvedValue({
      todayCount: 3,
      upcomingCount: 0,
      inboxCount: 0,
      allPendingCount: 3,
      perList: [{ listId: 'tdl_inbox', pendingCount: 0 }],
    });
    vi.spyOn(todoApi, 'listTodayItems').mockResolvedValue([todayTask]);

    useTodoStore.setState({
      lists: [],
      activeListId: null,
      hasUserSelectedView: false,
      counts: null,
      overdueCount: 0,
    });

    await useTodoStore.getState().initialize();

    const after = useTodoStore.getState();
    expect(after.filter.view).toBe('today');
    expect(after.activeListId).toBeNull();
    expect(after.items.map((i) => i.id)).toEqual(['ti_today_1']);
  });
});
