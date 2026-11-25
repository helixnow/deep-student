import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { TodoItem } from '../../types';

const mediaQueryState = { coarse: true };

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, opts?: string | Record<string, unknown>) => {
      if (typeof opts === 'string') return opts;
      if (opts && typeof opts.defaultValue === 'string') return opts.defaultValue;
      return key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: (q: string) => (q.includes('coarse') ? mediaQueryState.coarse : false),
}));

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: true }),
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

import { TodoItemRow } from '../main/TodoItemRow';
import { MatrixBoard } from '../main/MatrixBoard';
import { TodoMainPanel } from '../TodoMainPanel';
import { useTodoStore } from '../../stores/useTodoStore';

function makeTodo(overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    id: overrides.id ?? 'todo-1',
    todoListId: overrides.todoListId ?? 'inbox',
    title: overrides.title ?? '复习高数微积分',
    status: overrides.status ?? 'pending',
    priority: overrides.priority ?? 'medium',
    tagsJson: overrides.tagsJson ?? '[]',
    sortOrder: overrides.sortOrder ?? 0,
    attachmentsJson: overrides.attachmentsJson ?? '[]',
    createdAt: '2026-11-20T08:00:00.000Z',
    updatedAt: '2026-11-20T08:00:00.000Z',
    ...overrides,
  };
}

describe('Todo mobile anti-accidental-delete, MatrixBoard, and Today hierarchy', () => {
  const updateItemMock = vi.fn(async () => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    mediaQueryState.coarse = true;
    useTodoStore.setState({
      lists: [{ id: 'inbox', title: '收件箱', sortOrder: 0, isDefault: true, isFavorite: false, createdAt: '', updatedAt: '' }],
      activeListId: 'inbox',
      items: [],
      isLoadingItems: false,
      selectedItemId: null,
      filter: { view: 'today', search: '', showCompleted: false, sortBy: 'manual', priorityFilter: null },
      updateItem: updateItemMock as never,
      toggleItem: vi.fn(async () => undefined) as never,
      deleteItem: vi.fn(async () => undefined) as never,
      reorderItems: vi.fn(async () => undefined) as never,
      selectItem: vi.fn() as never,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('isolates delete inside More menu with 2-step confirmation and removes -m-2 overlap on touch', () => {
    const onDelete = vi.fn();
    render(
      <TodoItemRow
        item={makeTodo({ id: 't-touch' })}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        onDelete={onDelete}
        isSelected={false}
      />,
    );

    const focusBtn = screen.getByTestId('todo-row-focus-t-touch');
    expect(focusBtn.className).not.toContain('-m-2');

    // Naked inline delete button should not be present next to start-focus on touch
    expect(screen.queryByRole('button', { name: 'todo:actions.deleteItem' })).toBeNull();

    // Open More menu -> first click arms confirmation -> second click deletes
    const moreBtn = screen.getByTestId('todo-row-more-t-touch');
    expect(moreBtn.className).not.toContain('-m-2');
    fireEvent.click(moreBtn);

    const deleteItemBtn = screen.getByTestId('todo-row-more-delete-t-touch');
    fireEvent.click(deleteItemBtn);
    expect(onDelete).not.toHaveBeenCalled();
    expect(deleteItemBtn.textContent).toContain('确认删除');

    fireEvent.click(deleteItemBtn);
    expect(onDelete).toHaveBeenCalledWith('t-touch');
  });

  it('provides touch-none drag handle and click-based Move-to-Quadrant menu in MatrixBoard', () => {
    const item = makeTodo({ id: 'm-1', title: '矩阵任务', priority: 'low', dueDate: undefined });
    render(
      <MatrixBoard
        quadrants={{
          urgentImportant: [],
          importantNotUrgent: [],
          urgentNotImportant: [],
          neither: [item],
        }}
        selectedItemId={null}
        focusedItemId={null}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
      />,
    );

    const dragHandle = screen.getByRole('button', { name: '拖拽移动到其他象限' });
    expect(dragHandle.className).toContain('touch-none');

    fireEvent.click(screen.getByTestId('matrix-move-trigger-m-1'));
    fireEvent.click(screen.getByTestId('matrix-move-option-urgentImportant'));

    expect(updateItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'm-1',
        priority: 'high',
        dueDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      }),
    );
  });

  it('filters subtasks out of top-level Today list rows while showing live progress badge on parent', () => {
    const today = new Date();
    const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const parent = makeTodo({ id: 'p-1', title: '父任务：准备期末', dueDate: ymd });
    const childPending = makeTodo({ id: 'c-1', parentId: 'p-1', title: '子任务：刷真题', dueDate: ymd, status: 'pending' });
    const childDone = makeTodo({ id: 'c-2', parentId: 'p-1', title: '子任务：整理公式', dueDate: ymd, status: 'completed' });

    useTodoStore.setState({
      items: [parent, childPending, childDone],
      filter: { view: 'today', search: '', showCompleted: false, sortBy: 'manual', priorityFilter: null },
    });

    const { container } = render(<TodoMainPanel />);
    // Parent renders once with 1/2 subtask progress badge
    expect(container.querySelector('[data-agent-entity="todo:p-1"]')).not.toBeNull();
    expect(screen.getByTestId('todo-row-subtasks-p-1')).toHaveTextContent('1/2');
    // Subtasks must NOT be flattened into independent rows in the top-level list
    expect(container.querySelector('[data-agent-entity="todo:c-1"]')).toBeNull();
    expect(container.querySelector('[data-agent-entity="todo:c-2"]')).toBeNull();
  });

  it('S4-09: excludes subtasks from top-level Overdue / Matrix / empty Inbox views even when parent is absent', () => {
    const today = new Date();
    const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const orphanSubtask = makeTodo({ id: 'c-orphan', parentId: 'p-missing', title: '不应该出现在顶层的子任务', dueDate: ymd });

    // Overdue view: orphan subtask is excluded
    useTodoStore.setState({
      items: [orphanSubtask],
      filter: { view: 'overdue', search: '', showCompleted: false, sortBy: 'manual', priorityFilter: null },
    });
    const { rerender } = render(<TodoMainPanel />);
    expect(screen.queryByText('不应该出现在顶层的子任务')).toBeNull();

    // Matrix view: orphan subtask is excluded
    useTodoStore.setState({
      items: [orphanSubtask],
      filter: { view: 'matrix', search: '', showCompleted: false, sortBy: 'manual', priorityFilter: null },
    });
    rerender(<TodoMainPanel />);
    expect(screen.queryByText('不应该出现在顶层的子任务')).toBeNull();

    // Empty Inbox shows visible "+ 新建待办" CTA button
    useTodoStore.setState({
      items: [],
      filter: { view: 'all', search: '', showCompleted: false, sortBy: 'manual', priorityFilter: null },
    });
    rerender(<TodoMainPanel />);
    expect(screen.getByTestId('todo-empty-add-button')).toBeInTheDocument();
  });
});
