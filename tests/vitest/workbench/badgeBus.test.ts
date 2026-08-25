import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  notifyAppBadgeChanged,
  subscribeAppBadgeChanged,
} from '@/features/workbench/core/badgeBus';

const cleanups: Array<() => void> = [];

function subscribe(typeId: string, callback: () => void): () => void {
  const cleanup = subscribeAppBadgeChanged(typeId, callback);
  cleanups.push(cleanup);
  return cleanup;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

describe('badgeBus', () => {
  it('只通知匹配 typeId，退订幂等且最后一个订阅者移除后静默', () => {
    const flashcards = vi.fn();
    const tasks = vi.fn();
    const unsubscribe = subscribe('flashcards', flashcards);
    subscribe('taskDashboard', tasks);

    notifyAppBadgeChanged('flashcards');
    expect(flashcards).toHaveBeenCalledTimes(1);
    expect(tasks).not.toHaveBeenCalled();

    unsubscribe();
    unsubscribe();
    notifyAppBadgeChanged('flashcards');
    expect(flashcards).toHaveBeenCalledTimes(1);
  });

  it('单个异常订阅者不阻断后续 Dock 实例刷新', () => {
    const error = new Error('badge source failed');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    subscribe('flashcards', () => {
      throw error;
    });
    const healthy = vi.fn();
    subscribe('flashcards', healthy);

    expect(() => notifyAppBadgeChanged('flashcards')).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      '[workbench] badgeBus listener failed for "flashcards"',
      error,
    );
  });

  it('按派发开始时的订阅快照迭代，回调内退订不会跳过下一项', () => {
    const calls: string[] = [];
    let unsubscribeFirst = () => {};
    unsubscribeFirst = subscribe('pomodoro', () => {
      calls.push('first');
      unsubscribeFirst();
    });
    subscribe('pomodoro', () => calls.push('second'));

    notifyAppBadgeChanged('pomodoro');
    notifyAppBadgeChanged('pomodoro');
    expect(calls).toEqual(['first', 'second', 'second']);
  });
});
