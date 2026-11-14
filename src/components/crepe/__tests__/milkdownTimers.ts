import { afterAll, beforeAll, vi } from 'vitest';

/** Keep Milkdown's uncancelled Timer deadlines inside the jsdom lifetime. */
export function setupMilkdownTimers() {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
  });
  afterAll(async () => {
    try {
      // Timer.done() removes its listener but leaves its timeout queued. Execute
      // it while DOM globals still exist; pending/rejected timers still fail.
      await vi.runOnlyPendingTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });
}
