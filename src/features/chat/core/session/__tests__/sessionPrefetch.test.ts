import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  peek: vi.fn(),
  getOrCreate: vi.fn(),
  getSessionCount: vi.fn(),
  getMaxSessions: vi.fn(),
  getCurrentSessionId: vi.fn(),
  adapterGetOrCreate: vi.fn(),
  release: vi.fn(),
}));

vi.mock('../sessionManager', () => ({
  sessionManager: {
    peek: mocks.peek,
    getOrCreate: mocks.getOrCreate,
    getSessionCount: mocks.getSessionCount,
    getMaxSessions: mocks.getMaxSessions,
    getCurrentSessionId: mocks.getCurrentSessionId,
  },
}));

vi.mock('../../../adapters/AdapterManager', () => ({
  adapterManager: {
    getOrCreate: mocks.adapterGetOrCreate,
    release: mocks.release,
  },
}));

import { beginSessionHoverPrefetch } from '../sessionPrefetch';

describe('session hover prefetch', () => {
  const lease = { sessionId: 'sess_hover', generation: 1 };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.peek.mockReturnValue(undefined);
    mocks.getSessionCount.mockReturnValue(10);
    mocks.getMaxSessions.mockReturnValue(10);
    mocks.getCurrentSessionId.mockReturnValue(null);
    mocks.getOrCreate.mockReturnValue({ getState: () => ({ isDataLoaded: false }) });
    mocks.adapterGetOrCreate.mockResolvedValue({
      entry: { isReady: true },
      lease,
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('does not create an uncached session when speculative work would trigger LRU eviction', async () => {
    beginSessionHoverPrefetch('sess_hover');
    await vi.advanceTimersByTimeAsync(120);

    expect(mocks.getOrCreate).not.toHaveBeenCalled();
    expect(mocks.adapterGetOrCreate).not.toHaveBeenCalled();
  });

  it('prefetches below capacity and balances the adapter reference', async () => {
    mocks.getSessionCount.mockReturnValue(9);

    beginSessionHoverPrefetch('sess_hover');
    await vi.advanceTimersByTimeAsync(120);

    expect(mocks.getOrCreate).toHaveBeenCalledWith('sess_hover');
    expect(mocks.adapterGetOrCreate).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledWith('sess_hover', lease);
  });

  it('does not duplicate work for the currently mounted session', async () => {
    mocks.getCurrentSessionId.mockReturnValue('sess_hover');
    mocks.getSessionCount.mockReturnValue(1);

    beginSessionHoverPrefetch('sess_hover');
    await vi.advanceTimersByTimeAsync(120);

    expect(mocks.peek).not.toHaveBeenCalled();
    expect(mocks.adapterGetOrCreate).not.toHaveBeenCalled();
  });
});
