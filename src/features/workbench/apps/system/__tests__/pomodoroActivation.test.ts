/**
 * ACR R2-10 — pomodoro onActivation strictMode 结构化回执
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POMODORO_SETTINGS } from '@/features/pomodoro/types';
import { usePomodoroStore } from '@/features/pomodoro/stores/usePomodoroStore';
import { handlePomodoroActivation } from '../register';

describe('handlePomodoroActivation R2-10', () => {
  beforeEach(() => {
    usePomodoroStore.setState({
      mode: 'idle',
      status: 'paused',
      timeLeft: DEFAULT_POMODORO_SETTINGS.workDuration,
      phaseEndsAt: null,
      phaseStartedAt: null,
      currentTaskId: null,
      currentTaskTitle: null,
      sessionStartTime: null,
      settings: { ...DEFAULT_POMODORO_SETTINGS, strictMode: false },
      completedPomodorosToday: 0,
      lastActiveDate: null,
      isImmersive: false,
    });
  });

  it('start 返回 handled:true + acknowledged:true 且 store 进入 running', () => {
    const r = handlePomodoroActivation({
      windowId: 'w',
      instanceKey: null,
      action: 'start',
      payload: { taskTitle: '写场景库' },
    });
    expect(r).toEqual({ handled: true, acknowledged: true });
    expect(usePomodoroStore.getState().mode).toBe('work');
    expect(usePomodoroStore.getState().currentTaskTitle).toBe('写场景库');
  });

  it('strictMode 下 pause → handled:false + STRICT_MODE', () => {
    usePomodoroStore.setState({
      mode: 'work',
      status: 'running',
      settings: { ...DEFAULT_POMODORO_SETTINGS, strictMode: true },
    });
    const r = handlePomodoroActivation({
      windowId: 'w',
      instanceKey: null,
      action: 'pause',
    });
    expect(r).toEqual({
      handled: false,
      code: 'STRICT_MODE',
      hint: '严格模式下专注中不可暂停',
    });
    expect(usePomodoroStore.getState().status).toBe('running');
  });
});
