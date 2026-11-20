import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { setViewFilter, setWorkspaceView, initialize } = vi.hoisted(() => ({
  setViewFilter: vi.fn(),
  setWorkspaceView: vi.fn(),
  initialize: vi.fn(async () => {}),
}));

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: false }),
}));
vi.mock('@/features/pomodoro', () => ({
  PomodoroSettingsContent: () => null,
  PomodoroStatsContent: () => null,
  PomodoroPanel: () => null,
}));
vi.mock('@/features/workbench/agent/domainEvents', () => ({
  registerDomainListener: () => () => {},
}));
vi.mock('../TodoMainPanel', () => ({
  TodoMainPanel: () => <div data-testid="todo-main-panel-stub" />,
  MobileDetailOverlay: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../TodoTrashDialog', () => ({
  TodoTrashScreen: () => null,
  TodoTrashWorkspace: () => null,
  useTodoTrashView: (selector: (s: { isOpen: boolean; close: () => void }) => unknown) =>
    selector({ isOpen: false, close: vi.fn() }),
}));
vi.mock('../TodoAutomationWorkspace', () => ({
  TodoAutomationWorkspace: () => null,
}));
vi.mock('../../stores/useAutomationStore', () => ({
  useAutomationStore: (selector: (s: { count: number; max: number }) => unknown) =>
    selector({ count: 0, max: 20 }),
}));
vi.mock('../../stores/useTodoStore', () => ({
  useTodoStore: Object.assign(
    () => ({
      initialize,
      setActiveList: vi.fn(),
      setViewFilter,
      activeListId: 'inbox',
      filter: { view: 'all', search: '', priorityFilter: null, showCompleted: false },
      lists: [{ id: 'inbox', title: '收件箱' }],
      items: [],
      selectedItemId: null,
      selectItem: vi.fn(),
      workspaceView: 'todos' as const,
      setWorkspaceView,
    }),
    {
      getState: () => ({
        loadLists: vi.fn(),
        reloadCurrentView: vi.fn(),
        refreshTrashCounts: vi.fn(),
      }),
    },
  ),
}));

import { APP_EVENTS, dispatchAppEvent } from '@/events';
import { TodoContentView } from '../TodoContentView';

describe('TodoContentView — Today Learning direct entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('consumes todo.pendingSmartView="today" after initialize on mount', async () => {
    localStorage.setItem('todo.pendingSmartView', 'today');
    render(<TodoContentView />);

    await waitFor(() => {
      expect(setWorkspaceView).toHaveBeenCalledWith('todos');
      expect(setViewFilter).toHaveBeenCalledWith('today');
    });
    expect(localStorage.getItem('todo.pendingSmartView')).toBeNull();
  });

  it('switches an already-mounted TodoContentView to Today when NAVIGATE_TO_VIEW(todo) arrives', async () => {
    render(<TodoContentView />);
    await waitFor(() => expect(initialize).toHaveBeenCalled());
    setViewFilter.mockClear();

    localStorage.setItem('todo.pendingSmartView', 'today');
    act(() => {
      dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, { view: 'todo' });
    });

    expect(setViewFilter).toHaveBeenCalledWith('today');
    expect(localStorage.getItem('todo.pendingSmartView')).toBeNull();
  });
});
