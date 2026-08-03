import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  isReady: vi.fn(() => false),
  acquireExisting: vi.fn(),
  getOrCreate: vi.fn(),
  release: vi.fn(),
}));

vi.mock('../../adapters/AdapterManager', () => ({
  adapterManager: mocks,
}));

vi.mock('../../adapters/TauriAdapter', () => ({
  ChatV2TauriAdapter: class {},
}));

vi.mock('../../debug/sessionSwitchPerf', () => ({
  sessionSwitchPerf: {
    startTrace: vi.fn(),
    mark: vi.fn(),
  },
}));

import { useTauriAdapter } from '../useTauriAdapter';

function createStore() {
  const state = { isDataLoaded: false };
  return {
    getState: () => state,
    subscribe: vi.fn(() => vi.fn()),
  } as any;
}

function acquisition(generation: number) {
  return {
    entry: {
      adapter: { generation },
      isReady: true,
      error: null,
      setupPromise: null,
      refCount: 1,
      generation,
    },
    lease: { sessionId: 'sess_test', generation },
  } as any;
}

describe('useTauriAdapter lease lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isReady.mockReturnValue(false);
    mocks.get.mockReturnValue(undefined);
    mocks.acquireExisting.mockReturnValue(undefined);
  });

  it('releases a late acquisition after unmount during setup', async () => {
    let resolveAcquisition!: (value: ReturnType<typeof acquisition>) => void;
    mocks.getOrCreate.mockReturnValueOnce(new Promise((resolve) => {
      resolveAcquisition = resolve;
    }));
    const store = createStore();
    const { unmount } = renderHook(() => useTauriAdapter('sess_test', store));
    await waitFor(() => expect(mocks.getOrCreate).toHaveBeenCalledOnce());

    unmount();
    const late = acquisition(2);
    resolveAcquisition(late);

    await waitFor(() => {
      expect(mocks.release).toHaveBeenCalledWith('sess_test', late.lease);
    });
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('atomically replaces and releases the previous lease on reinitialize', async () => {
    const first = acquisition(1);
    const second = acquisition(2);
    mocks.getOrCreate
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const store = createStore();
    const { result, unmount } = renderHook(() => useTauriAdapter('sess_test', store));
    await waitFor(() => expect(result.current.isReady).toBe(true));

    await act(async () => {
      await result.current.reinitialize();
    });

    expect(mocks.release).toHaveBeenCalledWith('sess_test', first.lease);
    expect(mocks.release).not.toHaveBeenCalledWith('sess_test', second.lease);

    unmount();
    expect(mocks.release).toHaveBeenCalledWith('sess_test', second.lease);
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });
});

