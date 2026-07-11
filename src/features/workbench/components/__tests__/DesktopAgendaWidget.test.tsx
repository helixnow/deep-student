import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TodoAgendaSnapshot } from '../../apps/system/todoAgendaSource';

const mocks = vi.hoisted(() => ({
  snapshot: {
    items: [],
    lists: [],
    isLoading: false,
    error: null,
    updatedAt: Date.now(),
  } as TodoAgendaSnapshot,
  activateDetailed: vi.fn(async () => ({ delivered: true, result: { handled: true } })),
  activate: vi.fn(async () => true),
  complete: vi.fn(async () => undefined),
}));

vi.mock('../../apps/system/todoAgendaSource', () => ({
  getTodoAgendaSnapshot: () => mocks.snapshot,
  subscribeTodoAgenda: () => () => undefined,
  completeTodoAgendaItem: mocks.complete,
}));

vi.mock('../../core/workbenchBus', () => ({
  workbenchBus: {
    activateDetailed: mocks.activateDetailed,
    activate: mocks.activate,
  },
}));

import { buildCalendarDays, DesktopAgendaWidget, formatLocalDateKey } from '../DesktopAgendaWidget';

describe('DesktopAgendaWidget', () => {
  beforeEach(() => {
    mocks.activate.mockClear();
    mocks.activateDetailed.mockClear();
    mocks.complete.mockClear();
    const today = formatLocalDateKey(new Date());
    mocks.snapshot = {
      lists: [{
        id: 'list-a', title: '课程', color: '#0ea5e9', sortOrder: 0,
        isDefault: true, isFavorite: false, createdAt: '', updatedAt: '',
      }],
      items: [{
        id: 'item-a', todoListId: 'list-a', title: '复习线性代数', status: 'pending',
        priority: 'high', dueDate: today, dueTime: '20:00', tagsJson: '[]', sortOrder: 0,
        attachmentsJson: '[]', createdAt: '', updatedAt: '',
      }],
      isLoading: false,
      error: null,
      updatedAt: Date.now(),
    };
  });

  it('生成固定 6 周、周一开头的月历', () => {
    const days = buildCalendarDays(new Date(2026, 6, 1));
    expect(days).toHaveLength(42);
    expect(days[0].getDay()).toBe(1);
    expect(formatLocalDateKey(days[0])).toBe('2026-06-29');
  });

  it('展示日历点位和选中日程', () => {
    render(<DesktopAgendaWidget />);
    expect(screen.getByTestId('wb-agenda-widget')).toBeTruthy();
    expect(screen.getByText('复习线性代数')).toBeTruthy();
    expect(screen.getByText('课程')).toBeTruthy();
  });

  it('点击任务先打开清单，再聚焦任务', async () => {
    render(<DesktopAgendaWidget />);
    fireEvent.click(screen.getByRole('button', { name: '复习线性代数 课程 · 20:00' }));
    await waitFor(() => expect(mocks.activateDetailed).toHaveBeenCalledWith(expect.objectContaining({
      action: 'showList',
      payload: { listId: 'list-a' },
    })));
    expect(mocks.activate).toHaveBeenCalledWith(expect.objectContaining({
      action: 'focusItem',
      payload: { itemId: 'item-a' },
    }));
  });

  it('支持直接完成和按选中日期快速添加', async () => {
    render(<DesktopAgendaWidget />);
    fireEvent.click(screen.getByRole('button', { name: '完成 复习线性代数' }));
    await waitFor(() => expect(mocks.complete).toHaveBeenCalledWith('item-a'));

    fireEvent.click(screen.getByRole('button', { name: '添加日程' }));
    await waitFor(() => expect(mocks.activateDetailed).toHaveBeenCalledWith(expect.objectContaining({
      action: 'quickAdd',
      payload: { dueDate: formatLocalDateKey(new Date()) },
    })));
  });
});
