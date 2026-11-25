import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const breakpointState = { isSmallScreen: false };

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, opts?: string | Record<string, unknown>) => {
      if (typeof opts === 'string') return opts;
      const map: Record<string, string> = {
        'pomodoro.modes.shortBreak': '短休息',
        'pomodoro.modes.longBreak': '长休息',
        'pomodoro.modes.focusing': '专注中',
        'pomodoro.modes.idle': '番茄钟',
        'pomodoro.modes.ready': '准备就绪',
        'pomodoro.controls.skipBreak': '跳过休息',
        'pomodoro.controls.skipBreakKey': '跳过休息 (B)',
        'pomodoro.controls.stop': '停止',
        'pomodoro.controls.pause': '暂停',
        'pomodoro.controls.pauseSpace': '暂停 (Space)',
        'pomodoro.controls.resume': '继续',
        'pomodoro.controls.resumeSpace': '继续 (Space)',
        'pomodoro.controls.start': '开始',
        'pomodoro.controls.startFocus': '开始专注',
        'pomodoro.controls.startSpace': '开始 (Space)',
        'pomodoro.controls.noiseOn': '开启环境音',
        'pomodoro.controls.noiseOnKey': '开启环境音 (M)',
        'pomodoro.controls.noiseOff': '关闭环境音',
        'pomodoro.controls.noiseOffKey': '关闭环境音 (M)',
        'pomodoro.controls.enterImmersive': '进入沉浸式专注模式',
        'pomodoro.controls.exitImmersive': '退出专注模式 (ESC)',
        'pomodoro.controls.more': '更多操作',
        'pomodoro.notifications.stopped': '已停止当前番茄钟',
      };
      if (map[key]) return map[key];
      if (opts && typeof opts.defaultValue === 'string') return opts.defaultValue;
      return key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: breakpointState.isSmallScreen }),
}));

vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
}));

vi.mock('@/app/navigation/androidBackCoordinator', () => ({
  registerBackHandler: () => () => {},
  BACK_PRIORITY: { overlay: 10 },
}));

vi.mock('@/features/pomodoro/api', () => ({
  getPomodoroTodayStats: vi.fn(async () => ({
    completedCount: 1,
    interruptedCount: 0,
    totalFocusSeconds: 1500,
  })),
  createPomodoroRecord: vi.fn(async () => ({ id: 'rec-1' })),
  getPomodoroDailyStats: vi.fn(async () => []),
  listPomodorosInRange: vi.fn(async () => []),
}));

vi.mock('@/features/pomodoro/noiseEngine', () => ({
  NOISE_TYPES: ['brown', 'pink', 'white', 'rain'],
  noiseEngine: {
    start: vi.fn(),
    stop: vi.fn(),
    setType: vi.fn(),
    setVolume: vi.fn(),
  },
}));

import { PomodoroPanel } from '@/features/pomodoro/components/PomodoroPanel';
import { ImmersiveFocusMode } from '@/features/pomodoro/components/ImmersiveFocusMode';
import { usePomodoroStore } from '@/features/pomodoro/stores/usePomodoroStore';
import { DEFAULT_POMODORO_SETTINGS } from '@/features/pomodoro/types';

function seedBreakState(mode: 'short_break' | 'long_break' = 'short_break') {
  usePomodoroStore.setState({
    mode,
    status: 'running',
    timeLeft: mode === 'short_break' ? 300 : 900,
    phaseEndsAt: Date.now() + 300_000,
    phaseStartedAt: Date.now(),
    currentTaskId: 'ti_1',
    currentTaskTitle: '数学微积分',
    sessionStartTime: new Date().toISOString(),
    sessionCountUp: false,
    sessionDuration: mode === 'short_break' ? 300 : 900,
    phaseExtraSeconds: 0,
    settings: { ...DEFAULT_POMODORO_SETTINGS },
    completedPomodorosToday: 1,
    lastActiveDate: null,
    isImmersive: false,
    noiseEnabled: false,
    streakDays: 0,
    lastGoalMetDate: null,
    endReminderFiredPhase: null,
  });
}

describe('Pomodoro Round 6 P1 fix (S4-10): break state skipBreak & stop buttons', () => {
  beforeEach(() => {
    breakpointState.isSmallScreen = false;
    seedBreakState('short_break');
  });

  afterEach(() => {
    cleanup();
  });

  it('renders clearly labeled 跳过休息 and 停止 buttons with crisp icons and contrast on desktop short_break & long_break', () => {
    const { rerender } = render(<PomodoroPanel />);

    const skipBtn = screen.getByTestId('pomodoro-skip-break-btn');
    const stopBtn = screen.getByTestId('pomodoro-stop-btn');

    // Both buttons render clear visible Chinese text labels + SVG icons (not unlabeled blank squares)
    expect(skipBtn).toHaveTextContent('跳过休息');
    expect(skipBtn).toHaveAccessibleName('跳过休息');
    expect(skipBtn.querySelector('svg')).not.toBeNull();
    expect(skipBtn.className).toContain('!text-foreground');

    expect(stopBtn).toHaveTextContent('停止');
    expect(stopBtn).toHaveAccessibleName('停止');
    expect(stopBtn.querySelector('svg')).not.toBeNull();
    expect(stopBtn.className).toContain('!text-foreground');

    // Clicking 跳过休息 exits break mode cleanly
    fireEvent.click(skipBtn);
    expect(usePomodoroStore.getState().mode).toBe('idle');

    // Verify long_break mode & 停止 action as well
    seedBreakState('long_break');
    rerender(<PomodoroPanel />);

    const longSkipBtn = screen.getByTestId('pomodoro-skip-break-btn');
    const longStopBtn = screen.getByTestId('pomodoro-stop-btn');
    expect(longSkipBtn).toHaveTextContent('跳过休息');
    expect(longStopBtn).toHaveTextContent('停止');

    fireEvent.click(longStopBtn);
    expect(usePomodoroStore.getState().mode).toBe('idle');
  });

  it('renders labeled 跳过休息 and 停止 buttons on mobile break drawer', () => {
    breakpointState.isSmallScreen = true;
    seedBreakState('short_break');

    render(<PomodoroPanel />);

    // Open mobile secondary actions drawer
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));

    const skipBtn = screen.getByTestId('pomodoro-skip-break-btn');
    const stopBtn = screen.getByTestId('pomodoro-stop-btn');
    expect(skipBtn).toHaveTextContent('跳过休息');
    expect(skipBtn.querySelector('svg')).not.toBeNull();
    expect(stopBtn).toHaveTextContent('停止');
    expect(stopBtn.querySelector('svg')).not.toBeNull();
  });

  it('renders clearly labeled 跳过休息 and 停止 buttons in ImmersiveFocusMode break state', () => {
    seedBreakState('short_break');

    render(<ImmersiveFocusMode onClose={vi.fn()} />);

    const skipBtn = screen.getByTestId('immersive-pomodoro-skip-break-btn');
    const stopBtn = screen.getByTestId('immersive-pomodoro-stop-btn');

    expect(skipBtn).toHaveTextContent('跳过休息');
    expect(skipBtn.querySelector('svg')).not.toBeNull();
    expect(stopBtn).toHaveTextContent('停止');
    expect(stopBtn.querySelector('svg')).not.toBeNull();

    fireEvent.click(skipBtn);
    expect(usePomodoroStore.getState().mode).toBe('idle');
  });
});
