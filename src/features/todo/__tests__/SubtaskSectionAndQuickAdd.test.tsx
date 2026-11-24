import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown> | string) =>
      typeof opts === 'string'
        ? opts
        : (opts?.defaultValue as string) || key,
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: false }),
}));

vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
}));

const { dbItems, createTodoItemMock } = vi.hoisted(() => {
  const rows: Array<Record<string, unknown>> = [];
  return {
    dbItems: rows,
    createTodoItemMock: vi.fn(async (input: { todoListId: string; title: string; parentId?: string }) => {
      const created = {
        id: `item_${Math.random().toString(36).slice(2, 8)}`,
        todoListId: input.todoListId,
        parentId: input.parentId ?? null,
        title: input.title,
        status: 'pending' as const,
        priority: 'none' as const,
        tagsJson: '[]',
        sortOrder: 0,
        attachmentsJson: '[]',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      rows.push(created);
      return created;
    }),
  };
});

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    createTodoItem: createTodoItemMock,
    listTodayItems: vi.fn(async () => dbItems.filter((item) => !item.parentId)),
    listTodoItems: vi.fn(async () => [...dbItems]),
    listTodoLists: vi.fn(async () => []),
    getTodoCountsSnapshot: vi.fn(async () => null),
    getActiveTodoSummary: vi.fn(async () => null),
    listReminderItems: vi.fn(async () => []),
    listOverdueItems: vi.fn(async () => []),
    listAllPendingItems: vi.fn(async () => []),
  };
});

import { parseQuickAddInput } from '../quickAddParser';
import { useTodoStore } from '../stores/useTodoStore';
import { SubtaskSection } from '../components/main/detail/SubtaskSection';
import { InlineConfirmDelete } from '../components/main/detail/InlineConfirmDelete';

describe('Stage 4A Todo fixes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const parent = {
      id: 'parent_1',
      todoListId: 'tdl_inbox',
      parentId: null,
      title: '复习高数泰勒展开',
      status: 'pending',
      priority: 'high',
      dueDate: new Date().toISOString().slice(0, 10),
      tagsJson: '[]',
      sortOrder: 0,
      attachmentsJson: '[]',
      createdAt: '',
      updatedAt: '',
    };
    dbItems.splice(0, dbItems.length, parent);
    useTodoStore.setState({
      lists: [{ id: 'tdl_inbox', title: 'Inbox', isDefault: true, sortOrder: 0, isFavorite: false, createdAt: '', updatedAt: '' } as never],
      activeListId: null,
      items: [parent as never],
      filter: {
        view: 'today',
        search: '',
        priorityFilter: null,
        showCompleted: false,
        sortBy: 'manual',
      },
    });
  });

  it('parses 明早8点前 with tomorrow dueDate and 08:00 dueTime', () => {
    const now = new Date(2026, 10, 24, 15, 0, 0);
    const parsed = parseQuickAddInput('明早8点前提交复习报告', now);
    expect(parsed.dueDate).toBe('2026-11-25');
    expect(parsed.dueTime).toBe('08:00');
  });

  it('exposes explicit add button in SubtaskSection and retains subtask in today view store', async () => {
    const parent = useTodoStore.getState().items[0];
    render(<SubtaskSection item={parent} subtasks={[]} />);

    const input = screen.getByPlaceholderText('todo:subtasks.addPlaceholder');
    const addBtn = screen.getByRole('button', { name: '添加子任务' });
    expect(addBtn).toBeDisabled();

    fireEvent.change(input, { target: { value: '默写泰勒展开前 4 项' } });
    expect(addBtn).toBeEnabled();
    fireEvent.click(addBtn);

    await vi.waitFor(() => {
      expect(useTodoStore.getState().items.some((i) => i.title === '默写泰勒展开前 4 项' && i.parentId === 'parent_1')).toBe(true);
    });
  });

  it('closes InlineConfirmDelete immediately on Cancel without leaving stale alert text', () => {
    const onConfirm = vi.fn();
    render(
      <InlineConfirmDelete
        label="删除"
        question="确认删除？可撤销"
        confirmLabel="确认删除"
        cancelLabel="取消"
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(screen.getByText('确认删除？可撤销')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByText('确认删除？可撤销')).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
