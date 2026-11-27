import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params && Object.keys(params).length > 0 ? `${key}:${JSON.stringify(params)}` : key,
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
}));

import { TodoQuickAdd } from '@/features/todo/components/main/TodoQuickAdd';
import { TodoItemRow } from '@/features/todo/components/main/TodoItemRow';
import { useTodoStore } from '@/features/todo/stores/useTodoStore';
import type { TodoItem } from '@/features/todo/types';

function makeTodo(overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    id: overrides.id ?? 'todo-1',
    todoListId: overrides.todoListId ?? 'inbox',
    title: overrides.title ?? '完成高数习题',
    status: overrides.status ?? 'pending',
    priority: overrides.priority ?? 'none',
    tagsJson: overrides.tagsJson ?? '[]',
    sortOrder: overrides.sortOrder ?? 0,
    attachmentsJson: overrides.attachmentsJson ?? '[]',
    createdAt: '2026-11-19T08:00:00.000Z',
    updatedAt: '2026-11-19T08:00:00.000Z',
  };
}

describe('TodoQuickAdd & TodoItemRow polish', () => {
  const createItemMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    let seq = 0;
    createItemMock.mockImplementation(async (input: { title: string; todoListId: string }) => ({
      id: `created-${++seq}`,
      todoListId: input.todoListId,
      title: input.title,
      status: 'pending',
      priority: 'none',
      tagsJson: '[]',
      sortOrder: seq,
      attachmentsJson: '[]',
      createdAt: '',
      updatedAt: '',
    }));

    useTodoStore.setState({
      lists: [{ id: 'inbox', title: '收件箱', sortOrder: 0, isDefault: true, isFavorite: false, createdAt: '', updatedAt: '' }],
      activeListId: 'inbox',
      createItem: createItemMock as never,
      updateItem: vi.fn() as never,
      quickAddPreset: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows N shortcut hint when idle, tracks consecutive Enter additions, and blurs on Escape', async () => {
    render(<TodoQuickAdd />);

    expect(screen.getByLabelText('todo:quickAdd.focusShortcutHint')).toHaveTextContent('N');

    const input = document.querySelector('[data-todo-quick-add]') as HTMLInputElement;
    input.focus();
    fireEvent.focus(input);

    expect(screen.getByText('todo:quickAdd.continuousHint')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: '第一项待办' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(createItemMock).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('todo-quickadd-streak')).toHaveTextContent(
        'todo:quickAdd.addedStreak:{"count":1}',
      );
    });
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: '第二项待办' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(createItemMock).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('todo-quickadd-streak')).toHaveTextContent(
        'todo:quickAdd.addedStreak:{"count":2}',
      );
    });

    // Escape exits rapid entry cleanly and blurs the input
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(document.activeElement).not.toBe(input);
    expect(screen.queryByTestId('todo-quickadd-streak')).toBeNull();
  });

  it('auto-collapses options row on blur when empty, and stays expanded when draft text exists', () => {
    render(<TodoQuickAdd />);
    const input = document.querySelector('[data-todo-quick-add]') as HTMLInputElement;

    // Focus opens options row
    fireEvent.focus(input);
    expect(screen.getByText('todo:quickAdd.continuousHint')).toBeInTheDocument();

    // Blur while empty collapses options row automatically
    fireEvent.blur(input, { relatedTarget: document.body });
    expect(screen.queryByText('todo:quickAdd.continuousHint')).toBeNull();

    // Focus + enter text + blur keeps options row open so in-progress draft isn't lost
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '未提交草稿' } });
    fireEvent.blur(input, { relatedTarget: document.body });
    expect(screen.getByText('todo:quickAdd.continuousHint')).toBeInTheDocument();
  });

  it('applies progressive strikethrough sweep during completion before committing toggle', () => {
    vi.useFakeTimers();
    const onToggle = vi.fn();
    render(
      <TodoItemRow
        item={makeTodo({ id: 'todo-smooth', title: '整理错题本' })}
        onToggle={onToggle}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
        isSelected={false}
      />,
    );

    const titleSpan = screen.getByText('整理错题本');
    expect(titleSpan.className).toContain('after:scale-x-0');

    fireEvent.click(screen.getByRole('button', { name: 'todo:actions.markCompleted' }));

    // Immediately enters completing state with progressive strikethrough before store toggle
    expect(titleSpan.className).toContain('after:scale-x-100');
    expect(titleSpan.className).toContain('motion-reduce:after:transition-none');
    expect(onToggle).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(230);
    });
    expect(onToggle).toHaveBeenCalledWith('todo-smooth');
  });
});
