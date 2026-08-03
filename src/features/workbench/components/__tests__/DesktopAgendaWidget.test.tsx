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

  it('使用单焦点月历并支持方向键与 PageDown 导航', async () => {
    render(<DesktopAgendaWidget />);
    const selected = screen.getByRole('gridcell', { selected: true });
    expect(selected.getAttribute('tabindex')).toBe('0');
    expect(document.querySelectorAll('.wb-agenda-day[tabindex="0"]')).toHaveLength(1);

    const selectedDate = new Date(`${selected.getAttribute('data-date')}T00:00:00`);
    fireEvent.keyDown(selected, { key: 'ArrowRight' });
    await waitFor(() => {
      const movedCell = screen.getByRole('gridcell', { selected: true });
      expect(movedCell.getAttribute('data-date')).toBe(formatLocalDateKey(addDays(selectedDate, 1)));
      expect(document.activeElement).toBe(movedCell);
    });

    const moved = screen.getByRole('gridcell', { selected: true });
    fireEvent.keyDown(moved, { key: 'PageDown' });
    await waitFor(() => {
      const next = screen.getByRole('gridcell', { selected: true }).getAttribute('data-date');
      expect(next?.slice(0, 7)).not.toBe(formatLocalDateKey(selectedDate).slice(0, 7));
    });
  });

  it('支持触控板横滑切换月份', async () => {
    render(<DesktopAgendaWidget />);
    const widget = screen.getByTestId('wb-agenda-widget');
    const before = screen.getByRole('gridcell', { selected: true }).getAttribute('data-date');
    fireEvent.wheel(widget, { deltaMode: 0, deltaX: 64, deltaY: 0 });
    await waitFor(() => {
      const after = screen.getByRole('gridcell', { selected: true }).getAttribute('data-date');
      expect(after?.slice(0, 7)).not.toBe(before?.slice(0, 7));
    });
  });

  it('空日程区域点击后直达对应待办视图', async () => {
    mocks.snapshot = { ...mocks.snapshot, items: [] };
    render(<DesktopAgendaWidget />);
    fireEvent.click(screen.getByRole('button', { name: '这一天没有待完成事项' }));
    await waitFor(() => expect(mocks.activateDetailed).toHaveBeenCalledWith(expect.objectContaining({
      action: 'showView',
      payload: { view: 'today' },
    })));
  });
});

function addDays(date: Date, amount: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount);
}
