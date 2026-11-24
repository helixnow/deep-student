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

describe('TodoMainPanel Inbox empty scope clarity (S4-09)', () => {
  beforeEach(() => {
    useTodoStore.setState({
      items: [],
      lists: [],
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

  it('shows explicit Inbox scope caption and one-click View Today button when todayCount > 0', () => {
    const setViewFilter = vi.fn();
    useTodoStore.setState({ setViewFilter } as never);

    render(<TodoMainPanel onSelectItem={vi.fn()} />);

    expect(screen.getByTestId('todo-empty-scope-caption')).toHaveTextContent(
      '当前视图：收件箱（共 0 项）',
    );
    const todayCta = screen.getByTestId('todo-empty-view-today');
    expect(todayCta).toHaveTextContent('查看今日待办 (3)');
    fireEvent.click(todayCta);
    expect(setViewFilter).toHaveBeenCalledWith('today');
  });
});
