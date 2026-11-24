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
});
