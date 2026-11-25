import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TodoItem } from '../../types';

const { updateItemMock, toggleItemMock, deleteItemMock } = vi.hoisted(() => ({
  updateItemMock: vi.fn(async () => undefined),
  toggleItemMock: vi.fn(async () => undefined),
  deleteItemMock: vi.fn(async () => undefined),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, opts?: string | Record<string, unknown>) =>
      typeof opts === 'string' ? opts : (opts && typeof opts.defaultValue === 'string' ? opts.defaultValue : key),
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('@/hooks/mobile', () => ({ haptics: { impact: vi.fn() } }));
vi.mock('@/app/navigation/androidBackCoordinator', () => ({
  registerBackHandler: () => () => {},
  BACK_PRIORITY: { overlay: 10 },
}));
vi.mock('@/features/pomodoro', () => ({
  usePomodoroStore: { getState: () => ({ start: vi.fn() }) },
}));
vi.mock('@/features/pomodoro/api', () => ({
  listPomodorosByTodo: vi.fn(async () => []),
}));
vi.mock('../../api', () => ({
  listAllTags: vi.fn(async () => []),
}));
vi.mock('../../stores/useTodoStore', () => ({
  useTodoStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      items: [],
      updateItem: updateItemMock,
      toggleItem: toggleItemMock,
      deleteItem: deleteItemMock,
      createSubtask: vi.fn(),
    }),
}));

import { TodoItemDetail } from '../main/TodoItemDetail';

function makeItem(overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    id: 'ti_desc_1',
    todoListId: 'tdl_inbox',
    title: '整理笔记',
    description: '',
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

describe('TodoItemDetail description immediate blur persistence (S4-09)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('commits description edit immediately on blur without waiting for a 300ms debounce timer', () => {
    vi.useFakeTimers();
    try {
      render(<TodoItemDetail item={makeItem()} onClose={vi.fn()} />);

      const textarea = screen.getByPlaceholderText('todo:placeholders.description');
      fireEvent.change(textarea, { target: { value: '补充微积分第三章例题' } });
      fireEvent.blur(textarea);

      // Must call updateItem synchronously on blur so reload < 300ms cannot drop edits
      expect(updateItemMock).toHaveBeenCalledTimes(1);
      expect(updateItemMock).toHaveBeenCalledWith({
        id: 'ti_desc_1',
        description: '补充微积分第三章例题',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes unblurred description synchronously on task switch (key remount) and visibly renders saved text after reload', () => {
    const note = '佩亚诺余项推导卡住，先看第 3 章例题再重做。';
    const taskA = makeItem({ id: 'ti_a', title: '泰勒展开推导' });
    const taskB = makeItem({ id: 'ti_b', title: '定积分换元' });

    const { rerender } = render(
      <TodoItemDetail key={taskA.id} item={taskA} onClose={vi.fn()} />,
    );

    const textarea = screen.getByPlaceholderText('todo:placeholders.description');
    fireEvent.change(textarea, { target: { value: note } });

    // Switch directly to taskB WITHOUT firing blur (matches programmatic .click() on another row)
    rerender(<TodoItemDetail key={taskB.id} item={taskB} onClose={vi.fn()} />);

    expect(updateItemMock).toHaveBeenCalledTimes(1);
    expect(updateItemMock).toHaveBeenCalledWith({
      id: 'ti_a',
      description: note,
    });

    // Simulate reload + re-selecting taskA with persisted description from SQLite
    const reloadedTaskA = makeItem({
      id: 'ti_a',
      title: '泰勒展开推导',
      description: note,
      updatedAt: '2026-11-25T02:30:00Z',
    });
    const { container } = render(
      <TodoItemDetail key={reloadedTaskA.id} item={reloadedTaskA} onClose={vi.fn()} />,
    );

    const reloadedTextareas = screen.getAllByPlaceholderText('todo:placeholders.description');
    expect(reloadedTextareas[reloadedTextareas.length - 1]).toHaveValue(note);
    // Visible DOM text inside detail panel must also expose the saved description
    expect(container.querySelector('[data-todo-detail-panel]')?.textContent).toContain(note);
  });

  it('auto-saves description within 200ms while typing even if page reloads without blur', () => {
    vi.useFakeTimers();
    try {
      const note = '未失焦直接刷新也要保留的备注';
      const { unmount } = render(<TodoItemDetail item={makeItem()} onClose={vi.fn()} />);

      const textarea = screen.getByPlaceholderText('todo:placeholders.description');
      fireEvent.change(textarea, { target: { value: note } });
      expect(updateItemMock).not.toHaveBeenCalled();

      vi.advanceTimersByTime(200);
      expect(updateItemMock).toHaveBeenCalledTimes(1);
      expect(updateItemMock).toHaveBeenCalledWith({
        id: 'ti_desc_1',
        description: note,
      });

      // Subsequent unmount must NOT send a duplicate write when already committed
      unmount();
      expect(updateItemMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
