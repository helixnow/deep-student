import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatStore } from '../../types';

vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/debug-panel/debugMasterSwitch', () => ({
  debugLog: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { createAutoSaveMiddleware } from '../autoSave';

describe('B18 autosave slow RPC backpressure', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('coalesces ten throttle windows into one latest-state trailing write', async () => {
    const autoSave = createAutoSaveMiddleware({ throttleMs: 500 });
    let release!: () => void;
    let revision = 0;
    const written: number[] = [];
    const saveSession = vi.fn(async () => {
      written.push(revision);
      if (written.length === 1) await new Promise<void>((resolve) => { release = resolve; });
    });
    const store = { sessionId: 'b18-slow', saveSession } as unknown as ChatStore;
    autoSave.scheduleAutoSave(store);
    for (revision = 1; revision <= 10; revision++) {
      await vi.advanceTimersByTimeAsync(500);
      autoSave.scheduleAutoSave(store);
    }
    revision = 10;
    expect(saveSession).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(written).toEqual([0, 10]);
    await autoSave.forceImmediateSave(store);
    expect(saveSession).toHaveBeenCalledTimes(3);
    autoSave.cleanup(store.sessionId);
  });

  it('uses the newest same-session store and preserves force-save rejection', async () => {
    const autoSave = createAutoSaveMiddleware({ throttleMs: 500 });
    let release!: () => void;
    const oldSave = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const oldStore = { sessionId: 'b18-reopen', saveSession: oldSave } as unknown as ChatStore;
    const newSave = vi.fn(async () => {});
    const newStore = { sessionId: oldStore.sessionId, saveSession: newSave } as unknown as ChatStore;
    autoSave.scheduleAutoSave(oldStore);
    await vi.advanceTimersByTimeAsync(500);
    autoSave.scheduleAutoSave(oldStore);
    await vi.advanceTimersByTimeAsync(500);
    autoSave.scheduleAutoSave(newStore);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(oldSave).toHaveBeenCalledTimes(1);
    expect(newSave).toHaveBeenCalledTimes(1);
    newSave.mockRejectedValueOnce(new Error('force failed'));
    await expect(autoSave.forceImmediateSave(newStore)).rejects.toThrow('force failed');
    autoSave.cleanup(oldStore.sessionId);
  });
});
