import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createChatStore: vi.fn(),
  forceImmediateSave: vi.fn(),
  autoSaveCleanup: vi.fn(),
  flushAndCleanupSession: vi.fn(),
  clearProcessedEventIds: vi.fn(),
  clearBridgeState: vi.fn(),
  clearEventContext: vi.fn(),
  clearVariantTimers: vi.fn(),
  adapterGet: vi.fn(),
  adapterDestroy: vi.fn(),
  clearSessionSkills: vi.fn(),
}));

vi.mock('../../store/createChatStore', () => ({
  createChatStore: mocks.createChatStore,
}));

vi.mock('../../middleware/autoSave', () => ({
  autoSave: {
    forceImmediateSave: mocks.forceImmediateSave,
    cleanup: mocks.autoSaveCleanup,
  },
}));

vi.mock('../../middleware/chunkBuffer', () => ({
  chunkBuffer: {
    flushAndCleanupSession: mocks.flushAndCleanupSession,
    flushSession: vi.fn(),
  },
}));

vi.mock('../../middleware/eventBridge', () => ({
  clearProcessedEventIds: mocks.clearProcessedEventIds,
  clearBridgeState: mocks.clearBridgeState,
  clearEventContext: mocks.clearEventContext,
}));

vi.mock('../../store/variantActions', () => ({
  clearVariantDebounceTimersForSession: mocks.clearVariantTimers,
}));

vi.mock('../../../adapters/AdapterManager', () => ({
  adapterManager: {
    get: mocks.adapterGet,
    destroy: mocks.adapterDestroy,
  },
}));

vi.mock('../../../debug/sessionSwitchPerf', () => ({
  sessionSwitchPerf: { mark: vi.fn() },
}));

vi.mock('../../../skills/progressiveDisclosure', () => ({
  clearSessionSkills: mocks.clearSessionSkills,
}));

import { SessionManagerImpl } from '../sessionManager';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createStore(sessionId: string) {
  const subscribers = new Set<(state: any) => void>();
  const state = {
    sessionId,
    sessionStatus: 'idle',
    pendingBlockingInteraction: null,
    activeBlockIds: new Set<string>(),
    blocks: new Map(),
    abortStream: vi.fn().mockResolvedValue(undefined),
    saveSession: vi.fn().mockResolvedValue(undefined),
    loadSession: vi.fn().mockResolvedValue(undefined),
  };
  return {
    getState: () => state,
    subscribe: (listener: (nextState: typeof state) => void) => {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
  } as any;
}

describe('SessionManager lifecycle races', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createChatStore.mockImplementation((sessionId: string) => createStore(sessionId));
    mocks.forceImmediateSave.mockResolvedValue(undefined);
    mocks.adapterGet.mockReturnValue({ refCount: 0, generation: 1 });
    mocks.adapterDestroy.mockResolvedValue(undefined);
  });

  it('never selects the current session or a session with an active adapter lease for LRU eviction', async () => {
    const manager = new SessionManagerImpl();
    manager.getOrCreate('current');
    manager.getOrCreate('leased');
    manager.getOrCreate('idle');
    manager.setCurrentSessionId('current');
    mocks.adapterGet.mockImplementation((sessionId: string) =>
      sessionId === 'leased'
        ? { refCount: 1, generation: 1 }
        : { refCount: 0, generation: 1 }
    );

    manager.setMaxSessions(2);
    await vi.waitFor(() => expect(manager.has('idle')).toBe(false));

    expect(manager.has('current')).toBe(true);
    expect(manager.has('leased')).toBe(true);
    expect(mocks.forceImmediateSave).toHaveBeenCalledOnce();
    expect(mocks.forceImmediateSave.mock.calls[0][0].sessionId).toBe('idle');
  });

  it('soft-exceeds capacity while newly rendered stores have no adapter entry yet', async () => {
    const manager = new SessionManagerImpl();
    mocks.adapterGet.mockReturnValue(undefined);
    manager.setMaxSessions(1);

    const first = manager.getOrCreate('render-first');
    const second = manager.getOrCreate('render-second');

    expect(manager.peek('render-first')).toBe(first);
    expect(manager.peek('render-second')).toBe(second);
    expect(mocks.forceImmediateSave).not.toHaveBeenCalled();

    // A later creation provides another trim opportunity after the first cache
    // has matured and has no active holder.
    mocks.adapterGet.mockImplementation((sessionId: string) =>
      sessionId === 'render-first' ? { refCount: 0, generation: 1 } : undefined
    );
    manager.getOrCreate('render-third');
    await vi.waitFor(() => expect(manager.has('render-first')).toBe(false));
    expect(manager.has('render-second')).toBe(true);
  });

  it('cancels final eviction when the session becomes current while save is pending', async () => {
    const manager = new SessionManagerImpl();
    const save = deferred();
    mocks.forceImmediateSave.mockReturnValueOnce(save.promise);
    manager.getOrCreate('promoted');

    manager.setMaxSessions(0);
    manager.setCurrentSessionId('promoted');
    save.resolve();
    await save.promise;
    await Promise.resolve();

    expect(manager.has('promoted')).toBe(true);
    expect(mocks.adapterDestroy).not.toHaveBeenCalled();
  });

  it('cancels final eviction when an adapter lease is acquired while save is pending', async () => {
    const manager = new SessionManagerImpl();
    const save = deferred();
    mocks.forceImmediateSave.mockReturnValueOnce(save.promise);
    manager.getOrCreate('mounted-late');

    manager.setMaxSessions(0);
    mocks.adapterGet.mockReturnValue({ refCount: 1, generation: 1 });
    save.resolve();
    await save.promise;
    await Promise.resolve();

    expect(manager.has('mounted-late')).toBe(true);
    expect(mocks.adapterDestroy).not.toHaveBeenCalled();
  });

  it('does not finalize an eviction against a replacement adapter generation', async () => {
    const manager = new SessionManagerImpl();
    const save = deferred();
    mocks.forceImmediateSave.mockReturnValueOnce(save.promise);
    manager.getOrCreate('adapter-replaced');

    manager.setMaxSessions(0);
    mocks.adapterGet.mockReturnValue({ refCount: 0, generation: 2 });
    save.resolve();
    await save.promise;
    await Promise.resolve();

    expect(manager.has('adapter-replaced')).toBe(true);
    expect(mocks.adapterDestroy).not.toHaveBeenCalled();
  });

  it('cancels final eviction when the session starts streaming during save', async () => {
    const manager = new SessionManagerImpl();
    const save = deferred();
    mocks.forceImmediateSave.mockReturnValueOnce(save.promise);
    const store = manager.getOrCreate('streaming-late');

    manager.setMaxSessions(0);
    store.getState().sessionStatus = 'streaming';
    save.resolve();
    await save.promise;
    await Promise.resolve();

    expect(manager.has('streaming-late')).toBe(true);
    expect(mocks.adapterDestroy).not.toHaveBeenCalled();
  });

  it('uses a per-attempt token so an old save cannot finalize a newer eviction', async () => {
    const manager = new SessionManagerImpl();
    const firstSave = deferred();
    const secondSave = deferred();
    mocks.forceImmediateSave
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(secondSave.promise);
    const events: string[] = [];
    manager.subscribe((event) => events.push(`${event.type}:${event.sessionId}`));
    manager.setMaxSessions(1);

    manager.getOrCreate('same');
    manager.getOrCreate('other');
    manager.getOrCreate('same');
    manager.touch('other');
    manager.getOrCreate('third');

    expect(mocks.forceImmediateSave).toHaveBeenCalledTimes(2);
    firstSave.resolve();
    await firstSave.promise;
    await Promise.resolve();
    expect(manager.has('same')).toBe(true);
    expect(events).not.toContain('session-evicted:same');

    secondSave.resolve();
    await secondSave.promise;
    await vi.waitFor(() => expect(manager.has('same')).toBe(false));
    expect(events).toContain('session-evicted:same');
    expect(mocks.adapterDestroy).toHaveBeenCalledWith('same', 1);
  });

  it('cancels destroy during its save phase when the same session is reopened', async () => {
    const manager = new SessionManagerImpl();
    const save = deferred();
    mocks.forceImmediateSave.mockReturnValueOnce(save.promise);
    const original = manager.getOrCreate('reopen');

    const destruction = manager.destroy('reopen');
    expect(mocks.forceImmediateSave).toHaveBeenCalledOnce();
    expect(manager.getOrCreate('reopen')).toBe(original);

    save.resolve();
    await destruction;
    expect(manager.peek('reopen')).toBe(original);
    expect(mocks.adapterDestroy).not.toHaveBeenCalled();
    expect(mocks.autoSaveCleanup).not.toHaveBeenCalled();
  });

  it('starts a new destroy when a reopened session closes before the cancelled save settles', async () => {
    const manager = new SessionManagerImpl();
    const firstSave = deferred();
    mocks.forceImmediateSave
      .mockReturnValueOnce(firstSave.promise)
      // autoSave serializes saves for the same session; model that contract here.
      .mockReturnValueOnce(firstSave.promise.then(() => undefined));
    const store = manager.getOrCreate('rapid-reclose');

    const cancelledDestroy = manager.destroy('rapid-reclose');
    expect(manager.getOrCreate('rapid-reclose')).toBe(store);
    const finalDestroy = manager.destroy('rapid-reclose');
    expect(finalDestroy).not.toBe(cancelledDestroy);

    firstSave.resolve();
    await Promise.all([cancelledDestroy, finalDestroy]);
    expect(manager.has('rapid-reclose')).toBe(false);
    expect(mocks.adapterDestroy).toHaveBeenCalledWith('rapid-reclose', 1);
  });

  it('does not let old adapter cleanup completion delete a reopened store generation', async () => {
    const manager = new SessionManagerImpl();
    const cleanup = deferred();
    mocks.adapterDestroy.mockReturnValueOnce(cleanup.promise);
    const original = manager.getOrCreate('replace');

    const destruction = manager.destroy('replace');
    await vi.waitFor(() => expect(mocks.adapterDestroy).toHaveBeenCalledWith('replace', 1));
    expect(manager.peek('replace')).toBeUndefined();

    const replacement = manager.getOrCreate('replace');
    expect(replacement).not.toBe(original);
    cleanup.resolve();
    await destruction;

    expect(manager.peek('replace')).toBe(replacement);
  });
});
