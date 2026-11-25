import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  createPomodoroRecord: vi.fn(async () => ({ id: 'rec-u05' })),
  getPomodoroTodayStats: vi.fn(async () => ({
    completedCount: 0,
    interruptedCount: 0,
    totalFocusSeconds: 0,
  })),
  getPomodoroDailyStats: vi.fn(async () => [] as Array<{
    date: string;
    completedCount: number;
    focusSeconds: number;
    interruptedCount: number;
  }>),
  listPomodorosInRange: vi.fn(async () => [] as Array<{
    id: string;
    startTime: string;
    actualDuration: number;
    type: 'work' | 'short_break' | 'long_break';
    status: 'completed' | 'interrupted';
    duration: number;
    createdAt: string;
  }>),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, opts?: string | Record<string, unknown>) => {
      if (typeof opts === 'string') return opts;
      if (opts && typeof opts.defaultValue === 'string') return opts.defaultValue;
      return key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: false }),
}));

vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
}));

vi.mock('../../api', () => ({
  createPomodoroRecord: mocks.createPomodoroRecord,
  getPomodoroTodayStats: mocks.getPomodoroTodayStats,
  getPomodoroDailyStats: mocks.getPomodoroDailyStats,
  listPomodorosInRange: mocks.listPomodorosInRange,
}));

vi.mock('../../noiseEngine', () => ({
  NOISE_TYPES: ['brown', 'pink', 'white', 'rain'],
  noiseEngine: {
    start: vi.fn(),
    stop: vi.fn(),
    setType: vi.fn(),
    setVolume: vi.fn(),
  },
}));

import {
  formatLocalDateKey,
  normalizeLocalDateKey,
  parseLocalDateNoon,
  shiftLocalDateKey,
} from '../../utils/localDate';
import { usePomodoroStore } from '../usePomodoroStore';
import { PomodoroPanel } from '../../components/PomodoroPanel';
import { PomodoroStatsContent } from '../../components/PomodoroStatsPopover';
import { DEFAULT_POMODORO_SETTINGS } from '../../types';

function resetStore() {
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
    sessionDuration: null,
    phaseExtraSeconds: 0,
    settings: { ...DEFAULT_POMODORO_SETTINGS, dailyGoal: 2, workDuration: 1500 },
    completedPomodorosToday: 0,
    lastActiveDate: null,
    isImmersive: false,
    noiseEnabled: false,
    streakDays: 0,
    lastGoalMetDate: null,
    endReminderFiredPhase: null,
  });
}

describe('U05 Pomodoro midnight crossover & cross-timezone date boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  afterEach(async () => {
    cleanup();
    mocks.createPomodoroRecord.mockResolvedValue({ id: 'cleanup' });
    await usePomodoroStore.getState().flushPendingRecords().catch(() => {});
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetStore();
  });

  it('formats 23:58 and 00:05 with zero UTC off-by-one shift across UTC-5, UTC+8, and UTC+9', () => {
    // UTC-5 (America/New_York): local 2026-11-25 23:58 is UTC 2026-11-26 04:58
    const ny2358 = new Date('2026-11-26T04:58:00.000Z');
    const ny0005 = new Date('2026-11-26T05:05:00.000Z');
    expect(ny2358.toISOString().slice(0, 10)).toBe('2026-11-26'); // UTC is already tomorrow!
    expect(formatLocalDateKey(ny2358, -5 * 60)).toBe('2026-11-25');
    expect(formatLocalDateKey(ny0005, -5 * 60)).toBe('2026-11-26');

    // UTC+9 (Asia/Tokyo): local 2026-11-26 00:05 is UTC 2026-11-25 15:05
    const tokyo2358 = new Date('2026-11-25T14:58:00.000Z');
    const tokyo0005 = new Date('2026-11-25T15:05:00.000Z');
    expect(tokyo0005.toISOString().slice(0, 10)).toBe('2026-11-25'); // UTC is still yesterday!
    expect(formatLocalDateKey(tokyo2358, 9 * 60)).toBe('2026-11-25');
    expect(formatLocalDateKey(tokyo0005, 9 * 60)).toBe('2026-11-26');

    // UTC+8 (Asia/Shanghai): local 2026-11-26 00:05 is UTC 2026-11-25 16:05
    const sh0005 = new Date('2026-11-25T16:05:00.000Z');
    expect(formatLocalDateKey(sh0005, 8 * 60)).toBe('2026-11-26');

    // Pure calendar math & legacy toDateString normalization
    expect(shiftLocalDateKey('2026-11-25', 1)).toBe('2026-11-26');
    expect(shiftLocalDateKey('2026-03-01', -1)).toBe('2026-02-28');
    expect(normalizeLocalDateKey('2026-11-25')).toBe('2026-11-25');
    expect(normalizeLocalDateKey('Wed Nov 25 2026')).toBe('2026-11-25');
    expect(parseLocalDateNoon('2026-11-25')?.getDate()).toBe(25);
  });

  it.each([
    { tz: 'America/New_York', at2358Iso: '2026-11-26T04:58:00.000Z', at0005Iso: '2026-11-26T05:05:00.000Z' },
    { tz: 'Asia/Tokyo', at2358Iso: '2026-11-25T14:58:00.000Z', at0005Iso: '2026-11-25T15:05:00.000Z' },
  ])('rolls over completedPomodorosToday and maintains streak cleanly across 23:58 -> 00:05 in $tz', ({
    tz,
    at2358Iso,
    at0005Iso,
  }) => {
    vi.stubEnv('TZ', tz);
    vi.useFakeTimers();

    // 23:58 local on 2026-11-25
    vi.setSystemTime(new Date(at2358Iso));
    usePomodoroStore.setState({
      settings: { ...DEFAULT_POMODORO_SETTINGS, dailyGoal: 1, workDuration: 600 },
    });

    // Complete 1st pomodoro at 23:58 local -> meets dailyGoal on 2026-11-25
    usePomodoroStore.getState().start('todo-1', 'Late study');
    usePomodoroStore.getState().finishWorkEarly();
    expect(usePomodoroStore.getState().lastActiveDate).toBe('2026-11-25');
    expect(usePomodoroStore.getState().completedPomodorosToday).toBe(1);
    expect(usePomodoroStore.getState().streakDays).toBe(1);
    expect(usePomodoroStore.getState().lastGoalMetDate).toBe('2026-11-25');

    // Start a focus session at 23:58 that runs across midnight
    usePomodoroStore.getState().skipBreak();
    usePomodoroStore.getState().start('todo-1', 'Midnight crossing');
    expect(usePomodoroStore.getState().completedPomodorosToday).toBe(1);

    // Advance clock to 00:05 local on 2026-11-26
    vi.setSystemTime(new Date(at0005Iso));
    usePomodoroStore.getState().tick();

    // Yesterday's count rolled to 0 immediately; streak from yesterday is preserved!
    expect(usePomodoroStore.getState().lastActiveDate).toBe('2026-11-26');
    expect(usePomodoroStore.getState().completedPomodorosToday).toBe(0);
    expect(usePomodoroStore.getState().streakDays).toBe(1);
    expect(usePomodoroStore.getState().lastGoalMetDate).toBe('2026-11-25');

    // Finishing the session at 00:05 attributes to 2026-11-26 and advances streak 1 -> 2
    usePomodoroStore.getState().finishWorkEarly();
    expect(usePomodoroStore.getState().lastActiveDate).toBe('2026-11-26');
    expect(usePomodoroStore.getState().completedPomodorosToday).toBe(1);
    expect(usePomodoroStore.getState().streakDays).toBe(2);
    expect(usePomodoroStore.getState().lastGoalMetDate).toBe('2026-11-26');

    // Skip an entire calendar day (2026-11-27 missed) -> on 2026-11-28, syncWallClock clears expired streak & count
    vi.setSystemTime(new Date(new Date(at0005Iso).getTime() + 2 * 86_400_000));
    usePomodoroStore.getState().syncWallClock();
    expect(usePomodoroStore.getState().lastActiveDate).toBe('2026-11-28');
    expect(usePomodoroStore.getState().completedPomodorosToday).toBe(0);
    expect(usePomodoroStore.getState().streakDays).toBe(0);
  });

  it('refreshes PomodoroPanel today stats and clears yesterday totals when clock crosses 23:58 -> 00:05', async () => {
    vi.stubEnv('TZ', 'Asia/Tokyo');
    vi.useFakeTimers();
    // 2026-11-25 23:58+09:00
    vi.setSystemTime(new Date('2026-11-25T14:58:00.000Z'));

    usePomodoroStore.setState({
      mode: 'idle',
      status: 'paused',
      completedPomodorosToday: 3,
      lastActiveDate: '2026-11-25',
    });

    mocks.getPomodoroTodayStats
      .mockResolvedValueOnce({ completedCount: 3, interruptedCount: 1, totalFocusSeconds: 4500 })
      .mockResolvedValue({ completedCount: 0, interruptedCount: 0, totalFocusSeconds: 0 });

    render(<PomodoroPanel />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId('pomodoro-today-badge')).toHaveTextContent('3');

    // Cross midnight: 23:58 -> 00:05 (+7 min)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7 * 60_000);
    });

    expect(usePomodoroStore.getState().lastActiveDate).toBe('2026-11-26');
    expect(usePomodoroStore.getState().completedPomodorosToday).toBe(0);
    expect(screen.getByTestId('pomodoro-today-badge')).toHaveTextContent('0');
    expect(mocks.getPomodoroTodayStats.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('reloads PomodoroStatsContent with the new local YYYY-MM-DD range across 23:58 -> 00:05 in UTC-5', async () => {
    vi.stubEnv('TZ', 'America/New_York');
    vi.useFakeTimers();
    // 2026-11-25 23:58-05:00 (UTC is already 2026-11-26 04:58Z!)
    vi.setSystemTime(new Date('2026-11-26T04:58:00.000Z'));

    mocks.getPomodoroDailyStats.mockResolvedValue([
      { date: '2026-11-25', completedCount: 2, focusSeconds: 3000, interruptedCount: 0 },
    ]);
    mocks.listPomodorosInRange.mockResolvedValue([]);

    render(<PomodoroStatsContent />);
    await act(async () => {
      await Promise.resolve();
    });

    // At 23:58 local in UTC-5, range MUST end on 2026-11-25 (NOT UTC 2026-11-26)
    expect(mocks.listPomodorosInRange).toHaveBeenCalledWith('2026-11-19', '2026-11-25');

    // Advance 7 minutes to 00:05 local on 2026-11-26
    mocks.getPomodoroDailyStats.mockResolvedValue([
      { date: '2026-11-25', completedCount: 2, focusSeconds: 3000, interruptedCount: 0 },
      { date: '2026-11-26', completedCount: 0, focusSeconds: 0, interruptedCount: 0 },
    ]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(7 * 60_000);
    });

    expect(mocks.listPomodorosInRange).toHaveBeenLastCalledWith('2026-11-20', '2026-11-26');
  });
});
