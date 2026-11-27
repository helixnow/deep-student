import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params && Object.keys(params).length > 0 ? `${key}:${JSON.stringify(params)}` : key,
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: false }),
}));

vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
}));

vi.mock('@/features/pomodoro/api', () => ({
  getPomodoroTodayStats: vi.fn(async () => ({
    completedCount: 0,
    interruptedCount: 0,
    totalFocusSeconds: 0,
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

import { PomodoroPanel } from '../PomodoroPanel';
import { usePomodoroStore } from '../../stores/usePomodoroStore';
import { DEFAULT_POMODORO_SETTINGS } from '../../types';

function resetPomodoroStore() {
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
    settings: { ...DEFAULT_POMODORO_SETTINGS },
    completedPomodorosToday: 0,
    lastActiveDate: null,
    isImmersive: false,
    noiseEnabled: false,
    streakDays: 0,
    lastGoalMetDate: null,
    endReminderFiredPhase: null,
  });
}

describe('PomodoroPanel tactile & keyboard UX polish', () => {
  beforeEach(() => {
    resetPomodoroStore();
  });

  afterEach(() => {
    resetPomodoroStore();
  });

  it('supports Space start/pause/resume and B skip-break when panel container holds focus', () => {
    const { container } = render(<PomodoroPanel />);
    const root = container.querySelector('[data-pomodoro-mode]') as HTMLElement;
    expect(root).toBeTruthy();
    expect(root).toHaveAttribute('tabindex', '-1');
    expect(screen.getByTestId('pomodoro-space-hint')).toHaveTextContent(
      'pomodoro.controls.spaceShortcutHint',
    );

    root.focus();
    fireEvent.keyDown(root, { key: ' ' });
    expect(usePomodoroStore.getState().mode).toBe('work');
    expect(usePomodoroStore.getState().status).toBe('running');

    fireEvent.keyDown(root, { key: ' ' });
    expect(usePomodoroStore.getState().status).toBe('paused');

    fireEvent.keyDown(root, { key: ' ' });
    expect(usePomodoroStore.getState().status).toBe('running');

    // Switch into short_break and press B to skip break
    usePomodoroStore.setState({ mode: 'short_break', status: 'running', timeLeft: 300 });
    fireEvent.keyDown(root, { key: 'b' });
    expect(usePomodoroStore.getState().mode).toBe('idle');
  });

  it('keeps desktop idle bar single-row without an empty HeroRing svg and shows today badge inline', () => {
    const { container } = render(<PomodoroPanel />);
    // No 44px progress ring SVG in idle state
    expect(container.querySelector('svg[viewBox="0 0 44 44"]')).toBeNull();
    // Single inline today badge still rendered
    expect(screen.getAllByTestId('pomodoro-today-badge')).toHaveLength(1);
  });

  it('switches focus duration via preset capsules and reflects aria-pressed state', () => {
    render(<PomodoroPanel />);

    const preset25 = screen.getByRole('button', { name: 'pomodoro.presets.setTitle:{"count":25}' });
    const preset45 = screen.getByRole('button', { name: 'pomodoro.presets.setTitle:{"count":45}' });
    expect(preset25).toHaveAttribute('aria-pressed', 'true');
    expect(preset45).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'pomodoro.presets.setTitle:{"count":45}' }));
    expect(usePomodoroStore.getState().settings.workDuration).toBe(45 * 60);
    expect(preset45).toHaveAttribute('aria-pressed', 'true');
    expect(preset25).toHaveAttribute('aria-pressed', 'false');
  });

  it('supports bindTask, finishWorkEarly, and skipPhase transitions', () => {
    const state = usePomodoroStore.getState();
    state.bindTask('todo_99', '线代真题');
    expect(usePomodoroStore.getState().currentTaskId).toBe('todo_99');
    expect(usePomodoroStore.getState().currentTaskTitle).toBe('线代真题');

    usePomodoroStore.getState().start('todo_99', '线代真题');
    expect(usePomodoroStore.getState().mode).toBe('work');

    usePomodoroStore.getState().finishWorkEarly();
    expect(usePomodoroStore.getState().completedPomodorosToday).toBe(1);
    expect(usePomodoroStore.getState().mode).toBe('short_break');

    usePomodoroStore.getState().skipPhase();
    expect(usePomodoroStore.getState().mode).toBe('idle');
  });

  it('distinguishes work vs break surface states and highlights today completed badge on goal reached', () => {
    usePomodoroStore.setState({
      mode: 'short_break',
      status: 'running',
      timeLeft: 240,
      completedPomodorosToday: 4,
      settings: { ...DEFAULT_POMODORO_SETTINGS, dailyGoal: 4 },
    });

    const { container } = render(<PomodoroPanel />);
    const root = container.querySelector('[data-pomodoro-mode="short_break"]');
    expect(root).toBeInTheDocument();

    const badge = screen.getByTestId('pomodoro-today-badge');
    expect(badge).toHaveTextContent('4');
    expect(badge).toHaveTextContent('/4');
    expect(screen.getByText('pomodoro.stats.goalReached')).toBeInTheDocument();
  });

  it('S4-10: collapses PomodoroPanel into a compact bridge when a visible PomodoroAppWindow is open and formats <60s durations accurately', async () => {
    const { useWindowStore } = await import('@/features/workbench/core/windowStore');
    const { formatFocusDisplay, formatFocusTooltip } = await import('@/features/pomodoro/utils/focusDuration');

    const fakeT = ((key: string, opts?: Record<string, unknown>) =>
      `${key}:${JSON.stringify(opts ?? {})}`) as unknown as Parameters<typeof formatFocusDisplay>[1];
    expect(formatFocusDisplay(45, fakeT, 'pomodoro.stats')).toContain('"value":45');
    expect(formatFocusTooltip(95, fakeT, 'pomodoro.stats')).toContain('"minutes":1,"seconds":35');

    useWindowStore.setState({
      windows: {
        'w-pomo': {
          id: 'w-pomo',
          typeId: 'pomodoro',
          instanceKey: 'pomodoro',
          title: '番茄钟',
          frame: { x: 40, y: 40, w: 380, h: 560 },
          restoreFrame: null,
          displayMode: 'floating',
          zIndex: 10,
          minimized: false,
          lifecycle: 'active',
          createdAt: 1,
          lastFocusedAt: 1,
        },
      },
      focusStack: ['w-pomo'],
    });

    usePomodoroStore.setState({
      mode: 'work',
      status: 'running',
      timeLeft: 1400,
    });

    render(<PomodoroPanel />);
    expect(screen.getByTestId('pomodoro-panel-host-bridge')).toBeInTheDocument();
    expect(screen.getByTestId('pomodoro-panel-focus-window')).toBeInTheDocument();
    useWindowStore.setState({ windows: {}, focusStack: [] });
  });
});
