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

  it('switches focus duration via preset capsules and reflects aria-pressed state', () => {
    render(<PomodoroPanel />);

    const preset25 = screen.getByRole('button', { name: 'pomodoro.presets.setTitle:{"count":25}' });
    const preset45 = screen.getByRole('button', { name: 'pomodoro.presets.setTitle:{"count":45}' });
    expect(preset25).toHaveAttribute('aria-pressed', 'true');
    expect(preset45).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(preset45);
    expect(usePomodoroStore.getState().settings.workDuration).toBe(45 * 60);
    expect(preset45).toHaveAttribute('aria-pressed', 'true');
    expect(preset25).toHaveAttribute('aria-pressed', 'false');
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
});
