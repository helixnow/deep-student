import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const callbacks = new Map<string, (event: { payload: any }) => void>();
  let adapterExists = false;
  let currentEntry: { isReady: boolean; generation: number } | null = null;
  let nextGeneration = 1;
  let adapterSetupGate: Promise<void> | null = null;
  let releaseAdapterSetupGate: (() => void) | null = null;
  let listenerSetupGate: Promise<void> | null = null;
  let releaseListenerSetupGate: (() => void) | null = null;
  let failListenCall: number | null = null;
  let deferredListenCall: number | null = null;
  let deferredListenGate: Promise<void> | null = null;
  let releaseDeferredListen: (() => void) | null = null;
  const unlisteners: Array<ReturnType<typeof vi.fn>> = [];
  return {
    callbacks,
    resetAdapter: () => {
      adapterExists = false;
      currentEntry = null;
      nextGeneration = 1;
      adapterSetupGate = null;
      releaseAdapterSetupGate = null;
      listenerSetupGate = null;
      releaseListenerSetupGate = null;
      failListenCall = null;
      deferredListenCall = null;
      deferredListenGate = null;
      releaseDeferredListen = null;
      unlisteners.length = 0;
    },
    deferAdapterSetup: () => {
      adapterSetupGate = new Promise<void>((resolve) => {
        releaseAdapterSetupGate = resolve;
      });
    },
    finishAdapterSetup: () => releaseAdapterSetupGate?.(),
    deferListenerSetup: () => {
      listenerSetupGate = new Promise<void>((resolve) => {
        releaseListenerSetupGate = resolve;
      });
    },
    finishListenerSetup: () => releaseListenerSetupGate?.(),
    failListenAt: (call: number) => { failListenCall = call; },
    deferListenAt: (call: number) => {
      deferredListenCall = call;
      deferredListenGate = new Promise<void>((resolve) => {
        releaseDeferredListen = resolve;
      });
    },
    finishDeferredListen: () => releaseDeferredListen?.(),
    unlisteners,
    listen: vi.fn(async (eventName: string, callback: (event: { payload: any }) => void) => {
      const callNumber = mocks.listen.mock.calls.length;
      if (failListenCall === callNumber) {
        throw new Error(`listen failed at ${callNumber}`);
      }
      if (deferredListenCall === callNumber) {
        await deferredListenGate;
      }
      callbacks.set(eventName, callback);
      const unlisten = vi.fn();
      unlisteners.push(unlisten);
      return unlisten;
    }),
    adapterManager: {
      get: vi.fn(() => adapterExists ? currentEntry ?? undefined : undefined),
      getOrCreate: vi.fn(async () => {
        adapterExists = true;
        currentEntry ??= { isReady: true, generation: nextGeneration++ };
        await adapterSetupGate;
        return {
          entry: currentEntry,
          lease: {
            sessionId: 'mock_session',
            generation: currentEntry.generation,
            token: Symbol('lease'),
          },
        };
      }),
      waitForListenersReady: vi.fn(async () => {
        await listenerSetupGate;
      }),
      release: vi.fn(),
    },
    sessionManager: {
      getOrCreate: vi.fn(() => ({
        getState: () => ({ isDataLoaded: true }),
      })),
    },
    runAgent: vi.fn(async (_workspaceId: string, agentSessionId: string) => ({
      agentSessionId,
      status: 'running',
    })),
    showGlobalNotification: vi.fn(),
  };
});

vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('../../adapters/AdapterManager', () => ({ adapterManager: mocks.adapterManager }));
vi.mock('../../core/session/sessionManager', () => ({ sessionManager: mocks.sessionManager }));
vi.mock('../api', () => ({ runAgent: mocks.runAgent }));
vi.mock('../../debug/exportSessionDebug', () => ({
  addSubagentEventLog: vi.fn(),
  addSubagentPreheatLog: vi.fn(),
}));
vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: mocks.showGlobalNotification,
}));

import {
  cleanupWorkspaceEventListeners,
  initWorkspaceEventListeners,
  WORKSPACE_EVENTS,
} from '../events';
import { useWorkspaceStore } from '../workspaceStore';

describe('workspace worker adapter lease', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.callbacks.clear();
    mocks.resetAdapter();
    useWorkspaceStore.getState().setCurrentWorkspace(null);
    (window as any).__TAURI_INTERNALS__ = {};
  });

  afterEach(async () => {
    await cleanupWorkspaceEventListeners();
    delete (window as any).__TAURI_INTERNALS__;
  });

  it('releases the WORKER_READY preheat reference exactly once when the agent becomes idle', async () => {
    await initWorkspaceEventListeners();
    const workerReady = mocks.callbacks.get(WORKSPACE_EVENTS.WORKER_READY)!;
    const statusChanged = mocks.callbacks.get(WORKSPACE_EVENTS.AGENT_STATUS_CHANGED)!;

    workerReady({
      payload: {
        workspace_id: 'ws_test',
        agent_session_id: 'agent_test',
        skill_id: 'skill_test',
      },
    });
    await vi.waitFor(() => expect(mocks.adapterManager.waitForListenersReady).toHaveBeenCalledOnce());
    expect(mocks.runAgent).not.toHaveBeenCalled();

    statusChanged({
      payload: { workspace_id: 'ws_test', session_id: 'agent_test', status: 'idle' },
    });
    statusChanged({
      payload: { workspace_id: 'ws_test', session_id: 'agent_test', status: 'completed' },
    });

    expect(mocks.adapterManager.release).toHaveBeenCalledTimes(1);
    expect(mocks.adapterManager.release).toHaveBeenCalledWith(
      'agent_test',
      expect.objectContaining({ generation: 1 }),
    );
  });

  it('releases an acquisition when the terminal status races with adapter setup', async () => {
    mocks.deferAdapterSetup();
    await initWorkspaceEventListeners();
    const workerReady = mocks.callbacks.get(WORKSPACE_EVENTS.WORKER_READY)!;
    const statusChanged = mocks.callbacks.get(WORKSPACE_EVENTS.AGENT_STATUS_CHANGED)!;

    workerReady({
      payload: {
        workspace_id: 'ws_test',
        agent_session_id: 'agent_race',
        skill_id: 'skill_test',
      },
    });
    await vi.waitFor(() => expect(mocks.adapterManager.getOrCreate).toHaveBeenCalledOnce());

    statusChanged({
      payload: { workspace_id: 'ws_test', session_id: 'agent_race', status: 'idle' },
    });
    mocks.finishAdapterSetup();
    await vi.waitFor(() => expect(mocks.adapterManager.release).toHaveBeenCalledOnce());

    expect(mocks.adapterManager.release).toHaveBeenCalledTimes(1);
    expect(mocks.adapterManager.release).toHaveBeenCalledWith(
      'agent_race',
      expect.objectContaining({ generation: 1 }),
    );
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it('does not start a worker after the workspace listeners are cleaned up', async () => {
    mocks.deferListenerSetup();
    await initWorkspaceEventListeners();
    const workerReady = mocks.callbacks.get(WORKSPACE_EVENTS.WORKER_READY)!;

    workerReady({
      payload: {
        workspace_id: 'ws_test',
        agent_session_id: 'agent_cleanup',
        skill_id: 'skill_test',
      },
    });
    await vi.waitFor(() => expect(mocks.adapterManager.waitForListenersReady).toHaveBeenCalledOnce());

    await cleanupWorkspaceEventListeners();
    mocks.finishListenerSetup();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.runAgent).not.toHaveBeenCalled();
    expect(mocks.adapterManager.release).toHaveBeenCalledTimes(1);
    expect(mocks.adapterManager.release).toHaveBeenCalledWith(
      'agent_cleanup',
      expect.objectContaining({ generation: 1 }),
    );
  });

  it('rolls back listeners registered before a partial init failure', async () => {
    mocks.failListenAt(2);

    await expect(initWorkspaceEventListeners()).rejects.toThrow('listen failed at 2');

    expect(mocks.unlisteners).toHaveLength(1);
    expect(mocks.unlisteners[0]).toHaveBeenCalledOnce();
    expect(mocks.adapterManager.release).not.toHaveBeenCalled();
  });

  it('immediately unlistens a registration that resolves after cleanup', async () => {
    mocks.deferListenAt(1);
    const initialization = initWorkspaceEventListeners();
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalledTimes(1));

    await cleanupWorkspaceEventListeners();
    mocks.finishDeferredListen();

    await expect(initialization).rejects.toThrow(
      'Workspace listener generation changed during initialization',
    );
    expect(mocks.unlisteners).toHaveLength(1);
    expect(mocks.unlisteners[0]).toHaveBeenCalledOnce();
  });

  it('does not let an old listener release a newer generation lease', async () => {
    await initWorkspaceEventListeners();
    const oldWorkerReady = mocks.callbacks.get(WORKSPACE_EVENTS.WORKER_READY)!;
    const oldStatusChanged = mocks.callbacks.get(WORKSPACE_EVENTS.AGENT_STATUS_CHANGED)!;
    oldWorkerReady({
      payload: {
        workspace_id: 'ws_test',
        agent_session_id: 'agent_reinit',
        skill_id: 'skill_test',
      },
    });
    await vi.waitFor(() => expect(mocks.adapterManager.waitForListenersReady).toHaveBeenCalledTimes(1));
    expect(mocks.runAgent).not.toHaveBeenCalled();

    await cleanupWorkspaceEventListeners();
    expect(mocks.adapterManager.release).toHaveBeenCalledTimes(1);

    mocks.callbacks.clear();
    await initWorkspaceEventListeners();
    const newWorkerReady = mocks.callbacks.get(WORKSPACE_EVENTS.WORKER_READY)!;
    const newStatusChanged = mocks.callbacks.get(WORKSPACE_EVENTS.AGENT_STATUS_CHANGED)!;
    newWorkerReady({
      payload: {
        workspace_id: 'ws_test',
        agent_session_id: 'agent_reinit',
        skill_id: 'skill_test',
      },
    });
    await vi.waitFor(() => expect(mocks.adapterManager.waitForListenersReady).toHaveBeenCalledTimes(2));
    expect(mocks.runAgent).not.toHaveBeenCalled();

    oldStatusChanged({
      payload: { workspace_id: 'ws_test', session_id: 'agent_reinit', status: 'completed' },
    });
    expect(mocks.adapterManager.release).toHaveBeenCalledTimes(1);

    newStatusChanged({
      payload: { workspace_id: 'ws_test', session_id: 'agent_reinit', status: 'completed' },
    });
    expect(mocks.adapterManager.release).toHaveBeenCalledTimes(2);
  });

  it('does not poison WORKER_READY dedup with a background workspace event', async () => {
    useWorkspaceStore.getState().setCurrentWorkspace('ws_current');
    await initWorkspaceEventListeners();
    const workerReady = mocks.callbacks.get(WORKSPACE_EVENTS.WORKER_READY)!;
    const payload = {
      workspace_id: 'ws_background',
      agent_session_id: 'agent_background',
      skill_id: 'skill_test',
    };

    workerReady({ payload });
    await Promise.resolve();
    expect(mocks.adapterManager.getOrCreate).not.toHaveBeenCalled();

    useWorkspaceStore.getState().setCurrentWorkspace('ws_background');
    workerReady({ payload });
    await vi.waitFor(() => expect(mocks.adapterManager.waitForListenersReady).toHaveBeenCalledOnce());
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it('uses the frontend start path only when the backend explicitly declares legacy ownership', async () => {
    await initWorkspaceEventListeners();
    const workerReady = mocks.callbacks.get(WORKSPACE_EVENTS.WORKER_READY)!;

    workerReady({
      payload: {
        workspace_id: 'ws_test',
        agent_session_id: 'agent_legacy',
        skill_id: 'skill_test',
        runtime_managed: false,
      },
    });

    await vi.waitFor(() => expect(mocks.runAgent).toHaveBeenCalledOnce());
  });

  it('applies a typed runtime completion and releases the observer lease', async () => {
    useWorkspaceStore.getState().setCurrentWorkspace('ws_test');
    useWorkspaceStore.getState().addAgent({
      sessionId: 'agent_complete',
      workspaceId: 'ws_test',
      role: 'worker',
      status: 'running',
      joinedAt: '2026-01-01T00:00:00.000Z',
      lastActiveAt: '2026-01-01T00:00:00.000Z',
    });
    await initWorkspaceEventListeners();
    const workerReady = mocks.callbacks.get(WORKSPACE_EVENTS.WORKER_READY)!;
    const completed = mocks.callbacks.get(WORKSPACE_EVENTS.AGENT_COMPLETION)!;

    workerReady({
      payload: {
        workspace_id: 'ws_test',
        agent_session_id: 'agent_complete',
        runtime_managed: true,
      },
    });
    await vi.waitFor(() => expect(mocks.adapterManager.waitForListenersReady).toHaveBeenCalledOnce());

    completed({
      payload: {
        workspace_id: 'ws_test',
        agent_session_id: 'agent_complete',
        run_id: 'run_1',
        status: 'interrupted',
        final_output: 'partial result',
        completed_at: '2026-01-01T00:01:00.000Z',
      },
    });

    const agent = useWorkspaceStore.getState().agents.find((item) => item.sessionId === 'agent_complete');
    expect(agent?.status).toBe('interrupted');
    expect(agent?.metadata?.lastCompletion).toMatchObject({
      runId: 'run_1',
      finalOutput: 'partial result',
      status: 'interrupted',
    });
    expect(mocks.adapterManager.release).toHaveBeenCalledOnce();
  });

  it('does not poison coordinator wake dedup with a background workspace event', async () => {
    useWorkspaceStore.getState().setCurrentWorkspace('ws_current');
    await initWorkspaceEventListeners();
    const awakened = mocks.callbacks.get(WORKSPACE_EVENTS.COORDINATOR_AWAKENED)!;
    const payload = {
      workspace_id: 'ws_background',
      coordinator_session_id: 'sess_coordinator',
      sleep_id: 'sleep_background',
      awakened_by: 'agent_background',
      wake_reason: 'message',
    };

    awakened({ payload });
    expect(mocks.showGlobalNotification).not.toHaveBeenCalled();

    useWorkspaceStore.getState().setCurrentWorkspace('ws_background');
    awakened({ payload });
    expect(mocks.showGlobalNotification).toHaveBeenCalledOnce();
  });
});
