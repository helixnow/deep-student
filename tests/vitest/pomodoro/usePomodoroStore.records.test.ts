import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/pomodoro/api', () => ({
  createPomodoroRecord: vi.fn(),
}));

import { createPomodoroRecord } from '@/features/pomodoro/api';
import { usePomodoroStore } from '@/features/pomodoro/stores/usePomodoroStore';
import { DEFAULT_POMODORO_SETTINGS } from '@/features/pomodoro/types';

describe('pomodoro record persistence boundary', () => {
  beforeEach(async () => {
    vi.mocked(createPomodoroRecord).mockReset();
    try {
      await usePomodoroStore.getState().flushPendingRecords();
    } catch {
      // Consume a failure left by the preceding test before resetting state.
    }
    usePomodoroStore.setState({
      mode: 'work',
      status: 'paused',
      timeLeft: DEFAULT_POMODORO_SETTINGS.workDuration - 10,
      phaseEndsAt: null,
      phaseStartedAt: null,
      currentTaskId: 'todo-1',
      currentTaskTitle: '任务',
      sessionStartTime: new Date().toISOString(),
      settings: { ...DEFAULT_POMODORO_SETTINGS },
    });
  });

  it('flushPendingRecords waits until stop record is persisted', async () => {
    let resolveRecord!: (value: unknown) => void;
    vi.mocked(createPomodoroRecord).mockImplementationOnce(
      () => new Promise((resolve) => { resolveRecord = resolve; }) as never,
    );

    usePomodoroStore.getState().stop(true);
    let flushed = false;
    const flush = usePomodoroStore.getState().flushPendingRecords().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);

    resolveRecord({ id: 'record-1' });
    await flush;
    expect(flushed).toBe(true);
  });

  it('flushPendingRecords surfaces backend failure once', async () => {
    vi.mocked(createPomodoroRecord).mockRejectedValueOnce(new Error('write failed'));
    usePomodoroStore.getState().stop(true);

    await expect(usePomodoroStore.getState().flushPendingRecords()).rejects.toThrow(
      'write failed',
    );
    await expect(usePomodoroStore.getState().flushPendingRecords()).resolves.toBeUndefined();
  });

  it('settled UI history failure does not poison a later flush', async () => {
    vi.mocked(createPomodoroRecord).mockRejectedValueOnce(new Error('old UI failure'));
    usePomodoroStore.getState().stop(true);
    await vi.waitFor(() => expect(createPomodoroRecord).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    await Promise.resolve();

    await expect(usePomodoroStore.getState().flushPendingRecords()).resolves.toBeUndefined();
  });
});
