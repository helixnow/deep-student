import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const adapterSpies = vi.hoisted(() => ({
  setup: vi.fn(),
  cleanup: vi.fn(),
}));

vi.mock('../TauriAdapter', () => ({
  ChatV2TauriAdapter: class {
    onDataRestored: (() => void) | null = null;

    async setup() {
      await adapterSpies.setup();
      this.onDataRestored?.();
    }

    async cleanup() {
      await adapterSpies.cleanup();
    }

    async waitForListenersReady() {}
  },
}));

import { AdapterManagerImpl, SUBAGENT_IDLE_EVICT_MS } from '../AdapterManager';

function createStore() {
  let state = {
    sessionStatus: 'idle',
    pendingBlockingInteraction: null,
    activeBlockIds: new Set<string>(),
    blocks: new Map(),
    messageMap: new Map(),
  };
  return {
    store: { getState: () => state } as any,
    setState: (patch: Partial<typeof state>) => {
      state = { ...state, ...patch };
    },
  };
}

function deferredSetup() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('AdapterManager subagent idle eviction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    adapterSpies.setup.mockReset();
    adapterSpies.cleanup.mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('destroys an unreferenced idle subagent adapter after the grace period', async () => {
    const manager = new AdapterManagerImpl();
    const { store } = createStore();
    const acquisition = await manager.getOrCreate('agent_test', store);

    manager.release('agent_test', acquisition.lease);
    await vi.advanceTimersByTimeAsync(SUBAGENT_IDLE_EVICT_MS);

    expect(manager.has('agent_test')).toBe(false);
    expect(adapterSpies.cleanup).toHaveBeenCalledOnce();
  });

  it('does not let stale historical pending blocks pin an otherwise idle adapter', async () => {
    const manager = new AdapterManagerImpl();
    const { store, setState } = createStore();
    setState({
      blocks: new Map([
        ['blk_stale', { id: 'blk_stale', status: 'pending' }],
      ]),
    } as any);
    const acquisition = await manager.getOrCreate('agent_stale_block', store);

    manager.release('agent_stale_block', acquisition.lease);
    await vi.advanceTimersByTimeAsync(SUBAGENT_IDLE_EVICT_MS);

    expect(manager.has('agent_stale_block')).toBe(false);
  });

  it('cancels eviction on reacquire and defers eviction while the runtime is busy', async () => {
    const manager = new AdapterManagerImpl();
    const { store, setState } = createStore();
    const initial = await manager.getOrCreate('subagent_test', store);

    manager.release('subagent_test', initial.lease);
    await vi.advanceTimersByTimeAsync(SUBAGENT_IDLE_EVICT_MS / 2);
    const reacquired = await manager.getOrCreate('subagent_test', store);
    await vi.advanceTimersByTimeAsync(SUBAGENT_IDLE_EVICT_MS);
    expect(manager.has('subagent_test')).toBe(true);

    setState({ sessionStatus: 'streaming' });
    manager.release('subagent_test', reacquired.lease);
    await vi.advanceTimersByTimeAsync(SUBAGENT_IDLE_EVICT_MS);
    expect(manager.has('subagent_test')).toBe(true);

    setState({ sessionStatus: 'idle' });
    await vi.advanceTimersByTimeAsync(SUBAGENT_IDLE_EVICT_MS);
    expect(manager.has('subagent_test')).toBe(false);
  });

  it('does not let slow cleanup delete a newly reacquired adapter generation', async () => {
    const manager = new AdapterManagerImpl();
    const { store } = createStore();
    let finishCleanup!: () => void;
    adapterSpies.cleanup.mockImplementationOnce(
      () => new Promise<void>((resolve) => { finishCleanup = resolve; })
    );
    const first = await manager.getOrCreate('agent_race', store);

    manager.release('agent_race', first.lease);
    await vi.advanceTimersByTimeAsync(SUBAGENT_IDLE_EVICT_MS);
    expect(manager.has('agent_race')).toBe(false);

    const second = await manager.getOrCreate('agent_race', store);
    expect(second.lease.generation).not.toBe(first.lease.generation);
    finishCleanup();
    await vi.waitFor(() => expect(adapterSpies.cleanup).toHaveBeenCalledOnce());

    expect(manager.has('agent_race')).toBe(true);
    expect(manager.getStatus().adapters[0]?.refCount).toBe(1);
    expect(manager.release('agent_race', first.lease)).toBe(false);
    expect(manager.getStatus().adapters[0]?.refCount).toBe(1);
    await manager.destroyAll();
  });

  it('detaches an explicitly destroyed generation before awaiting slow cleanup', async () => {
    const manager = new AdapterManagerImpl();
    const { store } = createStore();
    let finishCleanup!: () => void;
    adapterSpies.cleanup.mockImplementationOnce(
      () => new Promise<void>((resolve) => { finishCleanup = resolve; })
    );
    const first = await manager.getOrCreate('sess_race', store);

    const destroyPromise = manager.destroy('sess_race', first.entry.generation);
    let cleanupSettled = false;
    void destroyPromise.then(() => { cleanupSettled = true; });
    expect(manager.has('sess_race')).toBe(false);
    const second = await manager.getOrCreate('sess_race', store);
    const repeatedOldDestroy = manager.destroy('sess_race', first.entry.generation);
    expect(repeatedOldDestroy).toBe(destroyPromise);
    expect(manager.get('sess_race')).toBe(second.entry);
    await Promise.resolve();
    expect(cleanupSettled).toBe(false);

    finishCleanup();
    await destroyPromise;

    expect(manager.has('sess_race')).toBe(true);
    expect(manager.getStatus().adapters[0]?.refCount).toBe(1);
    expect(manager.release('sess_race', first.lease)).toBe(false);
    expect(manager.release('sess_race', second.lease)).toBe(true);
    await manager.destroyAll();
  });

  it('cancels a pending acquisition when explicit destroy detaches its generation', async () => {
    const manager = new AdapterManagerImpl();
    const { store } = createStore();
    let finishSetup!: () => void;
    adapterSpies.setup.mockImplementationOnce(
      () => new Promise<void>((resolve) => { finishSetup = resolve; })
    );

    const acquisition = manager.getOrCreate('agent_setup_race', store);
    await Promise.resolve();
    const generation = manager.get('agent_setup_race')!.generation;
    const destruction = manager.destroy('agent_setup_race', generation);

    await expect(acquisition).rejects.toMatchObject({
      name: 'AdapterAcquisitionCancelledError',
      reason: 'destroy',
    });
    expect(manager.has('agent_setup_race')).toBe(false);

    finishSetup();
    await destruction;

    expect(manager.has('agent_setup_race')).toBe(false);
    await manager.destroyAll();
  });

  it('cancels all pending acquisitions before destroyAll awaits setup', async () => {
    const manager = new AdapterManagerImpl();
    const firstStore = createStore().store;
    const secondStore = createStore().store;
    const setupResolvers: Array<() => void> = [];
    adapterSpies.setup.mockImplementation(
      () => new Promise<void>((resolve) => { setupResolvers.push(resolve); })
    );

    const first = manager.getOrCreate('agent_first', firstStore);
    const second = manager.getOrCreate('agent_second', secondStore);
    await vi.waitFor(() => expect(setupResolvers).toHaveLength(2));

    const destruction = manager.destroyAll();
    expect(manager.getAdapterCount()).toBe(0);
    await expect(first).rejects.toMatchObject({ reason: 'destroy-all' });
    await expect(second).rejects.toMatchObject({ reason: 'destroy-all' });

    setupResolvers.forEach((resolve) => resolve());
    await destruction;
    expect(manager.getAdapterCount()).toBe(0);
  });

  it('makes releases idempotent and generation-scoped', async () => {
    const manager = new AdapterManagerImpl();
    const { store } = createStore();
    const first = await manager.getOrCreate('agent_lease', store);
    const second = manager.acquireExisting('agent_lease');

    expect(second).toBeDefined();
    expect(second!.lease).not.toBe(first.lease);
    expect(manager.getStatus().adapters[0]?.refCount).toBe(2);
    expect(manager.release('agent_lease', first.lease)).toBe(true);
    expect(manager.release('agent_lease', first.lease)).toBe(false);
    expect(manager.getStatus().adapters[0]?.refCount).toBe(1);

    await manager.destroy('agent_lease', first.entry.generation);
    const next = await manager.getOrCreate('agent_lease', store);
    expect(next.lease.generation).not.toBe(first.lease.generation);
    expect(manager.release('agent_lease', second!.lease)).toBe(false);
    expect(manager.getStatus().adapters[0]?.refCount).toBe(1);
    await manager.destroyAll();
  });

  it('runs cleanup without waiting for a setup that never settles', async () => {
    const manager = new AdapterManagerImpl();
    const { store } = createStore();
    adapterSpies.setup.mockImplementationOnce(() => new Promise<void>(() => {}));

    const acquisition = manager.getOrCreate('agent_stuck_setup', store);
    await vi.waitFor(() => expect(adapterSpies.setup).toHaveBeenCalledOnce());
    const generation = manager.get('agent_stuck_setup')!.generation;
    const destruction = manager.destroy('agent_stuck_setup', generation);

    await expect(acquisition).rejects.toMatchObject({ reason: 'destroy' });
    await destruction;
    expect(adapterSpies.cleanup).toHaveBeenCalledOnce();
    expect(manager.has('agent_stuck_setup')).toBe(false);
  });

  it('makes concurrent waiters follow the same bounded setup retry', async () => {
    const manager = new AdapterManagerImpl();
    const { store } = createStore();
    const retry = deferredSetup();
    adapterSpies.setup
      .mockRejectedValueOnce(new Error('initial setup failed'))
      .mockReturnValueOnce(retry.promise);

    const firstPromise = manager.getOrCreate('agent_retry_waiters', store);
    const secondPromise = manager.getOrCreate('agent_retry_waiters', store);
    let firstSettled = false;
    let secondSettled = false;
    void firstPromise.then(() => { firstSettled = true; });
    void secondPromise.then(() => { secondSettled = true; });

    await vi.waitFor(() => expect(adapterSpies.setup).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);

    retry.resolve();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first.entry.isReady).toBe(true);
    expect(second.entry).toBe(first.entry);
    expect(adapterSpies.setup).toHaveBeenCalledTimes(2);
    manager.release('agent_retry_waiters', first.lease);
    manager.release('agent_retry_waiters', second.lease);
    await manager.destroyAll();
  });
});
