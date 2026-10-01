import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { subscribeWithSelector } from 'zustand/middleware';

const mocks = vi.hoisted(() => ({
  createChatStore: vi.fn(),
  forceImmediateSave: vi.fn(),
  adapterGet: vi.fn(),
  adapterDestroy: vi.fn(),
}));

vi.mock('../../core/store/createChatStore', () => ({
  createChatStore: mocks.createChatStore,
}));
vi.mock('../../core/middleware/autoSave', () => ({
  autoSave: { forceImmediateSave: mocks.forceImmediateSave, cleanup: vi.fn() },
}));
vi.mock('../../core/middleware/chunkBuffer', () => ({
  chunkBuffer: { flushAndCleanupSession: vi.fn() },
}));
vi.mock('../../core/middleware/eventBridge', () => ({
  clearProcessedEventIds: vi.fn(), clearBridgeState: vi.fn(), clearEventContext: vi.fn(),
}));
vi.mock('../../core/store/variantActions', () => ({
  clearVariantDebounceTimersForSession: vi.fn(),
}));
vi.mock('../../adapters/AdapterManager', () => ({
  adapterManager: {
    get: mocks.adapterGet,
    destroy: mocks.adapterDestroy,
  },
}));
vi.mock('../../debug/sessionSwitchPerf', () => ({ sessionSwitchPerf: { mark: vi.fn() } }));
vi.mock('../../skills/progressiveDisclosure', () => ({ clearSessionSkills: vi.fn() }));

import { sessionManager } from '../../core/session';
import { useAllSessionIds, useSessionStats } from '../SessionManager';

describe('SessionManager event-driven hooks', () => {
  beforeEach(() => {
    mocks.forceImmediateSave.mockResolvedValue(undefined);
    mocks.adapterGet.mockReturnValue({ refCount: 0, generation: 1 });
    mocks.adapterDestroy.mockResolvedValue(undefined);
    mocks.createChatStore.mockImplementation((sessionId: string) =>
      createStore(subscribeWithSelector(() => ({
        sessionId,
        sessionStatus: 'idle',
        pendingBlockingInteraction: null,
        activeBlockIds: new Set<string>(),
        blocks: new Map(),
        attachments: [],
        abortStream: vi.fn().mockResolvedValue(undefined),
      })))
    );
    sessionManager.setMaxSessions(10);
  });

  afterEach(async () => {
    cleanup();
    await sessionManager.destroyAll();
    vi.restoreAllMocks();
  });

  it('removes an evicted ID immediately after the real manager finishes saving', async () => {
    const { result } = renderHook(() => useAllSessionIds());
    await act(async () => {
      sessionManager.getOrCreate('oldest');
      sessionManager.getOrCreate('newest');
    });
    expect(result.current).toEqual(['oldest', 'newest']);

    await act(async () => { sessionManager.setMaxSessions(1); });

    await waitFor(() => expect(result.current).toEqual(['newest']));
  });

  it('updates streaming counts and capacity without waiting for polling', async () => {
    const store = sessionManager.getOrCreate('stream');
    const { result } = renderHook(() => useSessionStats());
    expect(result.current).toEqual({ total: 1, streaming: 0, idle: 1, maxSessions: 10 });

    act(() => { store.setState({ sessionStatus: 'streaming' }); });
    expect(result.current).toEqual({ total: 1, streaming: 1, idle: 0, maxSessions: 10 });

    act(() => { sessionManager.setMaxSessions(20); });
    expect(result.current.maxSessions).toBe(20);

    act(() => { store.setState({ sessionStatus: 'idle' }); });
    expect(result.current.streaming).toBe(0);
  });

  it('recovers the cache cap after busy sessions temporarily prevent eviction', async () => {
    sessionManager.setMaxSessions(1);
    const first = sessionManager.getOrCreate('busy-first');
    first.setState({ sessionStatus: 'streaming' });
    const second = sessionManager.getOrCreate('busy-second');
    second.setState({ sessionStatus: 'streaming' });
    sessionManager.getOrCreate('temporary-overflow');
    expect(sessionManager.getSessionCount()).toBe(3);

    first.setState({ sessionStatus: 'idle' });
    second.setState({ sessionStatus: 'idle' });
    sessionManager.getOrCreate('newest');

    await waitFor(() => expect(sessionManager.getAllSessionIds()).toEqual(['newest']));
  });

  it('unsubscribes on unmount and does not install a fallback timer', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval');
    const getIds = vi.spyOn(sessionManager, 'getAllSessionIds');
    const getCount = vi.spyOn(sessionManager, 'getSessionCount');
    const { unmount } = renderHook(() => ({ ids: useAllSessionIds(), stats: useSessionStats() }));
    expect(interval).not.toHaveBeenCalled();

    unmount();
    getIds.mockClear();
    getCount.mockClear();
    await act(async () => { sessionManager.getOrCreate('after-unmount'); });

    expect(getIds).not.toHaveBeenCalled();
    expect(getCount).not.toHaveBeenCalled();
  });
});
