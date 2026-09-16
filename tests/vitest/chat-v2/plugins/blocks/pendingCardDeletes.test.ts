import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));

import {
  cancelPendingDelete,
  commitPendingDeleteNow,
  schedulePendingDelete,
} from '@/features/chat/plugins/blocks/pendingCardDeletes';

describe('pendingCardDeletes (F19)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('commits after the undo window elapses and reports success', async () => {
    mockInvoke.mockResolvedValue(undefined);
    const restore = vi.fn();
    const onResult = vi.fn();

    schedulePendingDelete('block-1', { cardIds: ['c1', 'c2'], restore, onResult }, 5000);
    expect(mockInvoke).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);

    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockInvoke).toHaveBeenCalledWith('delete_anki_card', { cardId: 'c1' });
    expect(mockInvoke).toHaveBeenCalledWith('delete_anki_card', { cardId: 'c2' });
    expect(restore).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledWith({ committed: ['c1', 'c2'], failed: [] });
  });

  it('restores failed cards instead of swallowing the error', async () => {
    mockInvoke.mockImplementation(async (_cmd: string, args: { cardId: string }) => {
      if (args.cardId === 'c2') throw new Error('db locked');
    });
    const restore = vi.fn();
    const onResult = vi.fn();

    schedulePendingDelete('block-2', { cardIds: ['c1', 'c2'], restore, onResult }, 1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(restore).toHaveBeenCalledWith(['c2']);
    expect(onResult).toHaveBeenCalledWith({ committed: ['c1'], failed: ['c2'] });
  });

  it('does not commit when the undo window is cancelled', async () => {
    mockInvoke.mockResolvedValue(undefined);

    schedulePendingDelete('block-3', { cardIds: ['c1'], restore: vi.fn() }, 5000);
    cancelPendingDelete('block-3');
    await vi.advanceTimersByTimeAsync(5000);

    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('commits immediately when a new delete flushes the previous window', async () => {
    mockInvoke.mockResolvedValue(undefined);
    const onResult = vi.fn();

    schedulePendingDelete('block-4', { cardIds: ['c1'], restore: vi.fn(), onResult }, 5000);
    commitPendingDeleteNow('block-4');
    await vi.runAllTimersAsync();

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith({ committed: ['c1'], failed: [] });
  });
});
