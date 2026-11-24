import React from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { pendingItemsMock } = vi.hoisted(() => ({
  pendingItemsMock: vi.fn(async () => [
    {
      id: 'todo_bound_1',
      todoListId: 'tdl_inbox',
      title: '完成考研数学错题整理',
      status: 'pending',
      priority: 'high',
      tagsJson: '[]',
      sortOrder: 0,
      attachmentsJson: '[]',
      createdAt: '2026-11-24T00:00:00Z',
      updatedAt: '2026-11-24T00:00:00Z',
    },
  ]),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, opts?: string | Record<string, unknown>) =>
      typeof opts === 'string'
        ? opts
        : opts && typeof opts.defaultValue === 'string'
          ? opts.defaultValue
          : key,
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('@/features/todo/api', () => ({
  listAllPendingItems: pendingItemsMock,
}));

vi.mock('@/features/pomodoro/api', () => ({
  createPomodoroRecord: vi.fn(async () => ({ id: 'rec_1' })),
  getPomodoroTodayStats: vi.fn(async () => ({
    completedPomodoros: 0,
    totalFocusSeconds: 0,
    completedFocusSeconds: 0,
    streakDays: 0,
  })),
}));

vi.mock('@/features/pomodoro/components/PomodoroStatsPopover', () => ({
  PomodoroStatsContent: () => null,
}));

vi.mock('../PomodoroWindowSettings', () => ({
  PomodoroWindowSettings: () => null,
}));

vi.mock('../flashcardsDueSource', () => ({
  getFlashcardsDueCount: () => 0,
  subscribeFlashcardsDueCount: () => () => {},
}));

import { DEFAULT_POMODORO_SETTINGS } from '@/features/pomodoro/types';
import { usePomodoroStore } from '@/features/pomodoro/stores/usePomodoroStore';
import PomodoroAppWindow from '../PomodoroAppWindow';

beforeAll(() => {
  if (typeof globalThis.ResizeObserver !== 'function') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

describe('PomodoroAppWindow todo binding & <60s preview guard (S4-10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePomodoroStore.setState({
      mode: 'idle',
      status: 'paused',
      timeLeft: DEFAULT_POMODORO_SETTINGS.workDuration,
      phaseEndsAt: null,
      phaseStartedAt: null,
      currentTaskId: null,
      currentTaskTitle: null,
      sessionStartTime: null,
      sessionCountUp: null,
      phaseExtraSeconds: 0,
      settings: { ...DEFAULT_POMODORO_SETTINGS, countUp: false, strictMode: false },
      completedPomodorosToday: 0,
      lastActiveDate: null,
      isImmersive: false,
    });
  });

  it('preserves selected todo binding when clicking Start Focus', async () => {
    render(
      <PomodoroAppWindow
        windowId="w-pomo"
        instanceKey={null}
        launchPayload={null}
        isActive
        isVisible
        onTitleChange={vi.fn()}
        requestClose={vi.fn()}
      />,
    );

    const select = (await screen.findByLabelText('绑定待办任务')) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBeGreaterThan(1));

    fireEvent.change(select, { target: { value: 'todo_bound_1' } });
    expect(select.value).toBe('todo_bound_1');
    expect(usePomodoroStore.getState().currentTaskId).toBe('todo_bound_1');

    // Click primary Start button -> bound todo must NOT be cleared to null
    const startBtn = screen.getByRole('button', { name: 'pomodoro.controls.startFocus' });
    fireEvent.click(startBtn);

    expect(usePomodoroStore.getState().mode).toBe('work');
    expect(usePomodoroStore.getState().status).toBe('running');
    expect(usePomodoroStore.getState().currentTaskId).toBe('todo_bound_1');
    expect(usePomodoroStore.getState().currentTaskTitle).toBe('完成考研数学错题整理');
    expect(select.value).toBe('todo_bound_1');
  });

  it('marks <60s work sessions as short preview and suppresses full pomodoro completion', async () => {
    const finishSpy = vi.fn();
    const stopSpy = vi.fn();
    usePomodoroStore.setState({
      mode: 'work',
      status: 'running',
      timeLeft: DEFAULT_POMODORO_SETTINGS.workDuration - 5,
      phaseEndsAt: Date.now() + (DEFAULT_POMODORO_SETTINGS.workDuration - 5) * 1000,
      currentTaskId: 'todo_bound_1',
      currentTaskTitle: '完成考研数学错题整理',
      finishWorkEarly: finishSpy,
      stop: stopSpy,
    });

    render(
      <PomodoroAppWindow
        windowId="w-pomo"
        instanceKey={null}
        launchPayload={null}
        isActive
        isVisible
        onTitleChange={vi.fn()}
        requestClose={vi.fn()}
      />,
    );

    const previewBtn = await screen.findByRole('button', {
      name: '结束预览（不足 1 分钟不计番茄）',
    });
    expect(previewBtn).toHaveAttribute('data-short-preview', 'true');

    act(() => {
      fireEvent.click(previewBtn);
    });
    expect(finishSpy).not.toHaveBeenCalled();
    expect(stopSpy).toHaveBeenCalledWith(true);
  });
});
