/**
 * pomodoroSource — 番茄钟投射源生命周期
 *
 * - 开始（idle→active）立即声明实例（投射管理器据此开窗）；
 * - stop（active→idle）不瞬间收口：余韵 POMODORO_CLOSE_LINGER_MS 后
 *   仍 idle 才通知实例消失（窗口短暂停留在 idle 态可直接再开始）；
 * - 余韵期内重新开始 → 取消关窗。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => null }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async () => () => {},
  emit: async () => {},
}));

import {
  pomodoroProjectionSource,
  POMODORO_CLOSE_LINGER_MS,
  POMODORO_INSTANCE_KEY,
} from '@/features/workbench/apps/system/pomodoroSource';
import { usePomodoroStore } from '@/features/pomodoro/stores/usePomodoroStore';

const aliveInstance = expect.objectContaining({ instanceKey: POMODORO_INSTANCE_KEY });

describe('pomodoroSource 投射生命周期', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    usePomodoroStore.setState({ mode: 'idle', status: 'paused', currentTaskTitle: null });
  });

  afterEach(() => {
    usePomodoroStore.setState({ mode: 'idle', status: 'paused', currentTaskTitle: null });
    vi.useRealTimers();
  });

  it('开始专注立即声明实例；stop 后延迟余韵才收口', () => {
    const notify = vi.fn();
    const unsubscribe = pomodoroProjectionSource.subscribe(notify);
    notify.mockClear();

    usePomodoroStore.setState({ mode: 'work', status: 'running' });
    expect(notify).toHaveBeenLastCalledWith([aliveInstance]);
    notify.mockClear();

    usePomodoroStore.setState({ mode: 'idle', status: 'paused' });
    // 不瞬间关窗：余韵期内没有任何「实例消失」通知
    expect(notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(POMODORO_CLOSE_LINGER_MS - 1);
    expect(notify).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(notify).toHaveBeenLastCalledWith([]);

    unsubscribe();
  });

  it('余韵期内重新开始：取消关窗，实例持续存活', () => {
    const notify = vi.fn();
    const unsubscribe = pomodoroProjectionSource.subscribe(notify);

    usePomodoroStore.setState({ mode: 'work', status: 'running' });
    usePomodoroStore.setState({ mode: 'idle', status: 'paused' });
    notify.mockClear();

    vi.advanceTimersByTime(1000);
    usePomodoroStore.setState({ mode: 'work', status: 'running' });
    expect(notify).toHaveBeenLastCalledWith([aliveInstance]);
    notify.mockClear();

    // 被取消的余韵定时器不会在之后误发「实例消失」
    vi.advanceTimersByTime(POMODORO_CLOSE_LINGER_MS * 2);
    expect(notify).not.toHaveBeenCalled();

    unsubscribe();
  });

  it('退订时清掉挂起的余韵定时器（不再回调）', () => {
    const notify = vi.fn();
    const unsubscribe = pomodoroProjectionSource.subscribe(notify);

    usePomodoroStore.setState({ mode: 'work', status: 'running' });
    usePomodoroStore.setState({ mode: 'idle', status: 'paused' });
    notify.mockClear();

    unsubscribe();
    vi.advanceTimersByTime(POMODORO_CLOSE_LINGER_MS * 2);
    expect(notify).not.toHaveBeenCalled();
  });
});
