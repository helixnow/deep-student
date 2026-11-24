import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TodoItem } from '../../types';
import { TodoItemRow } from '../main/TodoItemRow';

const makeItem = (overrides: Partial<TodoItem> = {}): TodoItem => ({
  id: 'ti_test_1',
  todoListId: 'tdl_inbox',
  title: '完成线性代数习题',
  status: 'pending',
  priority: 'medium',
  dueDate: '2026-11-25',
  tagsJson: '[]',
  sortOrder: 0,
  attachmentsJson: '[]',
  createdAt: '2026-11-24T00:00:00Z',
  updatedAt: '2026-11-24T00:00:00Z',
  ...overrides,
});

describe('TodoItemRow detail & completion separation (W8B-09)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
  });

  it('clicking the task title opens detail/subtasks and never marks it complete', () => {
    const onToggle = vi.fn();
    const onSelect = vi.fn();
    const onDelete = vi.fn();

    render(
      <TodoItemRow
        item={makeItem()}
        onToggle={onToggle}
        onSelect={onSelect}
        onDelete={onDelete}
        isSelected={false}
      />,
    );

    fireEvent.click(screen.getByTestId('todo-row-title-ti_test_1'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('ti_test_1');
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('exposes a visible accessible detail trigger button that opens detail without toggling', () => {
    const onToggle = vi.fn();
    const onSelect = vi.fn();
    const onDelete = vi.fn();

    render(
      <TodoItemRow
        item={makeItem()}
        onToggle={onToggle}
        onSelect={onSelect}
        onDelete={onDelete}
        isSelected={false}
      />,
    );

    const detailBtn = screen.getByTestId('todo-row-detail-ti_test_1');
    expect(detailBtn).toBeTruthy();
    fireEvent.click(detailBtn);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('ti_test_1');
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('clicking only the checkbox toggles completion and does not open detail', () => {
    const onToggle = vi.fn();
    const onSelect = vi.fn();
    const onDelete = vi.fn();

    render(
      <TodoItemRow
        item={makeItem()}
        onToggle={onToggle}
        onSelect={onSelect}
        onDelete={onDelete}
        isSelected={false}
      />,
    );

    fireEvent.click(screen.getByTestId('todo-row-toggle-ti_test_1'));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith('ti_test_1');
    expect(onSelect).not.toHaveBeenCalled();
  });
});
