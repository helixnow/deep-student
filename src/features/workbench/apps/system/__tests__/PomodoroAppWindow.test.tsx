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
    const origFinish = usePomodoroStore.getState().finishWorkEarly;
    const origStop = usePomodoroStore.getState().stop;
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

    try {
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
    } finally {
      usePomodoroStore.setState({ finishWorkEarly: origFinish, stop: origStop });
    }
  });

  it('S4-10: keeps active session timeLeft intact when duration setting changes, stops immediately <=10s, and keeps bound todoId across round completion', async () => {
    const { PomodoroWindowSettings } = await vi.importActual<typeof import('../PomodoroWindowSettings')>(
      '../PomodoroWindowSettings',
    );
    usePomodoroStore.setState({
      mode: 'idle',
      status: 'paused',
      timeLeft: 1500,
      phaseEndsAt: null,
      phaseStartedAt: null,
      currentTaskId: null,
      currentTaskTitle: null,
      sessionDuration: null,
      sessionCountUp: null,
      phaseExtraSeconds: 0,
      settings: DEFAULT_POMODORO_SETTINGS,
    });

    // 1) 绑定任务后启动，25 分钟（1500s）运行中改设为 2 分钟（120s），当前倒计时不被裁切
    usePomodoroStore.getState().start('todo-bound-7', '背单词');
    usePomodoroStore.setState({
      timeLeft: 1495,
      phaseEndsAt: Date.now() + 1495 * 1000,
    });
    usePomodoroStore.getState().updateSettings({ workDuration: 120 });

    const afterUpdate = usePomodoroStore.getState();
    expect(afterUpdate.sessionDuration).toBe(1500);
    expect(afterUpdate.timeLeft).toBe(1495);
    expect(afterUpdate.settings.workDuration).toBe(120);

    const settingsView = render(<PomodoroWindowSettings />);
    expect(settingsView.getByTestId('pomodoro-settings-next-round-hint')).toBeInTheDocument();
    settingsView.unmount();

    // 2) 完成本轮并跳过休息回到 idle，再无参 start() 开启下一轮 → todoId 持续绑定，且新一轮应用 2 分钟
    usePomodoroStore.getState().completeCurrentSession();
    expect(usePomodoroStore.getState().currentTaskId).toBe('todo-bound-7');
    usePomodoroStore.getState().skipBreak();
    expect(usePomodoroStore.getState().currentTaskId).toBe('todo-bound-7');
    usePomodoroStore.getState().start();
    expect(usePomodoroStore.getState().currentTaskId).toBe('todo-bound-7');
    expect(usePomodoroStore.getState().sessionDuration).toBe(120);
    expect(usePomodoroStore.getState().timeLeft).toBe(120);

    // 3) <=10s 内点击「停止」直接停止而非假响应
    usePomodoroStore.setState({
      mode: 'work',
      status: 'running',
      timeLeft: 115,
      sessionDuration: 120,
    });
    render(
      <PomodoroAppWindow
        windowId="w-pomo-stop"
        instanceKey={null}
        launchPayload={null}
        isActive
        isVisible
        onTitleChange={vi.fn()}
        requestClose={vi.fn()}
      />,
    );
    const stopBtn = await screen.findByRole('button', { name: 'pomodoro.controls.stop' });
    fireEvent.click(stopBtn);
    expect(usePomodoroStore.getState().mode).toBe('idle');
  });
});
