import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => null as unknown),
  isWebUiShell: vi.fn(() => false),
  isTouchPrimary: false,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

vi.mock('@/utils/platform', () => ({
  isWebUiShell: () => mocks.isWebUiShell(),
}));

vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: (q: string) => (q.includes('coarse') ? mocks.isTouchPrimary : false),
}));

vi.mock('@/hooks/useKeyboardHeight', () => ({
  useKeyboardInset: () => 0,
}));

vi.mock('@/hooks/useComposerDockHeight', () => ({
  useComposerDockHeight: () => '96px',
}));

vi.mock('@/stores/viewStore', () => ({
  useViewStore: (selector: (s: { currentView: string }) => unknown) => selector({ currentView: 'chat' }),
}));

vi.mock('@/features/workbench/core/windowStore', () => ({
  useWindowStore: (selector: (s: { windows: Record<string, unknown> }) => unknown) => selector({ windows: {} }),
}));

vi.mock('../miniWindow', () => ({
  openPomodoroMiniWindow: vi.fn(async () => true),
  closePomodoroMiniWindow: vi.fn(async () => undefined),
  broadcastPomodoroState: vi.fn(),
  isPomodoroMiniWindowOpen: () => false,
  subscribePomodoroMiniWindowOpen: () => () => {},
  EVT_MINI_COMMAND: 'pomodoro:mini-command',
  EVT_MINI_READY: 'pomodoro:mini-ready',
}));

import { GlobalPomodoroWidget } from '../GlobalPomodoroWidget';
import {
  POMODORO_SETTINGS_KEY,
  syncPomodoroSettingsFromBackend,
  usePomodoroStore,
} from '../../stores/usePomodoroStore';
import { DEFAULT_POMODORO_SETTINGS } from '../../types';

describe('GlobalPomodoroWidget & Pomodoro settings backend sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isWebUiShell.mockReturnValue(false);
    mocks.isTouchPrimary = false;
    usePomodoroStore.setState({
      mode: 'work',
      status: 'paused',
      timeLeft: 1200,
      currentTaskId: 'task-1',
      currentTaskTitle: '数学复习',
      settings: { ...DEFAULT_POMODORO_SETTINGS },
      isImmersive: false,
    });
  });

  afterEach(() => {
    cleanup();
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('adds var(--keyboard-inset, 0px) to touch floating pill bottom style', () => {
    mocks.isTouchPrimary = true;
    const { container } = render(<GlobalPomodoroWidget />);
    const pill = container.querySelector('.fixed.right-6') as HTMLElement | null;
    expect(pill).not.toBeNull();
    expect(pill?.style.bottom).toContain('var(--keyboard-inset, 0px)');
  });

  it('hides pop-out mini window button when running inside WebUI shell', () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    mocks.isTouchPrimary = false;

    mocks.isWebUiShell.mockReturnValue(true);
    const { container, rerender } = render(<GlobalPomodoroWidget />);
    expect(container.querySelector('[aria-label="pomodoro.controls.popOut"]')).toBeNull();

    mocks.isWebUiShell.mockReturnValue(false);
    rerender(<GlobalPomodoroWidget />);
    expect(container.querySelector('[aria-label="pomodoro.controls.popOut"]')).not.toBeNull();
  });

  it('mirrors updateSettings to backend pomodoro.settings and hydrates remote settings', async () => {
    usePomodoroStore.setState({ mode: 'idle', status: 'paused', settings: { ...DEFAULT_POMODORO_SETTINGS } });

    usePomodoroStore.getState().updateSettings({ workDuration: 1800, dailyGoal: 6 });
    expect(mocks.invoke).toHaveBeenCalledWith(
      'save_setting',
      expect.objectContaining({
        key: POMODORO_SETTINGS_KEY,
        value: expect.stringContaining('"workDuration":1800'),
      }),
    );

    mocks.invoke.mockResolvedValueOnce(JSON.stringify({ workDuration: 2400, shortBreak: 600 }));
    const applied = await syncPomodoroSettingsFromBackend();
    expect(applied).toBe(true);
    expect(usePomodoroStore.getState().settings.workDuration).toBe(2400);
    expect(usePomodoroStore.getState().settings.shortBreak).toBe(600);
    expect(usePomodoroStore.getState().timeLeft).toBe(2400);
  });
});
