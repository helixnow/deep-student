import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore, type StoreApi } from 'zustand';
import type { DeliverOutcome } from '../../core/types';
import {
  SuperResidentController,
  type ResidentChatState,
  type ResidentControllerDeps,
  type WorkspaceAgentCompletionPayload,
} from '../residentController';
import { superResidentStore, shouldShowPausedBanner } from '../residentState';
import type {
  SuperSessionChangedPayload,
  SuperSessionInboxChangedPayload,
  SuperSessionState,
} from '../api';

type Deliver = (opts?: { force?: boolean }) => Promise<DeliverOutcome>;

function makeChatStore(deliver: Deliver): StoreApi<ResidentChatState> {
  return createStore<ResidentChatState>(() => ({
    sessionStatus: 'idle',
    currentStreamingMessageId: null,
    queuedMessages: [],
    isDataLoaded: true,
    messageOrder: [],
    messageMap: new Map(),
    pendingBlockingInteraction: null,
    deliverSuperInbox: deliver,
  }));
}

interface Harness {
  deps: ResidentControllerDeps;
  stores: Map<string, StoreApi<ResidentChatState>>;
  deliver: ReturnType<typeof vi.fn<Deliver>>;
  backendState: SuperSessionState;
  leases: { acquired: string[]; released: string[] };
  restore: ReturnType<typeof vi.fn>;
  emitChanged: (payload: SuperSessionChangedPayload) => void;
  emitInbox: (payload: SuperSessionInboxChangedPayload) => void;
  emitCompletion: (payload: WorkspaceAgentCompletionPayload) => void;
}

function makeHarness(opts: { mainWindow?: boolean } = {}): Harness {
  const stores = new Map<string, StoreApi<ResidentChatState>>();
  const deliver = vi.fn<Deliver>(async () => ({ status: 'empty' }));
  const leases = { acquired: [] as string[], released: [] as string[] };
  let changed: ((p: SuperSessionChangedPayload) => void) | null = null;
  let inbox: ((p: SuperSessionInboxChangedPayload) => void) | null = null;
  let completion: ((p: WorkspaceAgentCompletionPayload) => void) | null = null;
  const harness: Harness = {
    stores,
    deliver,
    leases,
    backendState: { enabled: true, sessionId: 'sess_super', workspaceId: 'ws_super', pendingInbox: 0 },
    restore: vi.fn(async () => undefined),
    emitChanged: (p) => changed?.(p),
    emitInbox: (p) => inbox?.(p),
    emitCompletion: (p) => completion?.(p),
    deps: undefined as unknown as ResidentControllerDeps,
  };
  harness.deps = {
    isMainWindow: () => opts.mainWindow ?? true,
    waitUntilReady: async () => undefined,
    getState: async () => ({ ...harness.backendState }),
    onChanged: async (handler) => {
      changed = handler;
      return () => {
        changed = null;
      };
    },
    onInboxChanged: async (handler) => {
      inbox = handler;
      return () => {
        inbox = null;
      };
    },
    onAgentCompletion: async (handler) => {
      completion = handler;
      return () => {
        completion = null;
      };
    },
    getOrCreateStore: (sessionId) => {
      let store = stores.get(sessionId);
      if (!store) {
        store = makeChatStore((o) => deliver(o));
        stores.set(sessionId, store);
      }
      return store;
    },
    acquireAdapter: async (sessionId) => {
      leases.acquired.push(sessionId);
      return { release: () => leases.released.push(sessionId) };
    },
    restoreExecutions: (...args: unknown[]) => harness.restore(...args),
  };
  return harness;
}

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('SuperResidentController', () => {
  let controller: SuperResidentController | null = null;

  beforeEach(() => {
    superResidentStore.setState({
      sessionId: null,
      workspaceId: null,
      pendingInbox: 0,
      pausedReason: null,
      autoTurns: 0,
      resuming: false,
    });
  });

  afterEach(async () => {
    await controller?.stop();
    controller = null;
  });

  it('does nothing outside the main window', async () => {
    const h = makeHarness({ mainWindow: false });
    const getState = vi.spyOn(h.deps, 'getState');
    controller = new SuperResidentController(h.deps);
    expect(await controller.start()).toBe(false);
    expect(getState).not.toHaveBeenCalled();
    expect(h.leases.acquired).toEqual([]);
  });

  it('holds a lease while enabled, restores executions and attempts delivery once', async () => {
    const h = makeHarness();
    controller = new SuperResidentController(h.deps);
    await controller.start();
    await flush();

    expect(h.leases.acquired).toEqual(['sess_super']);
    expect(h.restore).toHaveBeenCalledWith('ws_super', 'sess_super');
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(controller.getAttachedSessionId()).toBe('sess_super');
    expect(superResidentStore.getState().sessionId).toBe('sess_super');
  });

  it('releases the lease when disabled', async () => {
    const h = makeHarness();
    controller = new SuperResidentController(h.deps);
    await controller.start();
    await flush();

    h.emitChanged({ enabled: false, sessionId: null });
    await flush();

    expect(h.leases.released).toEqual(['sess_super']);
    expect(controller.getAttachedSessionId()).toBeNull();
    expect(superResidentStore.getState().sessionId).toBeNull();
  });

  it('switches the lease when super_session_changed points to a new session', async () => {
    const h = makeHarness();
    controller = new SuperResidentController(h.deps);
    await controller.start();
    await flush();

    h.backendState = { enabled: true, sessionId: 'sess_super_2', workspaceId: 'ws_2', pendingInbox: 0 };
    h.emitChanged({ enabled: true, sessionId: 'sess_super_2' });
    await flush();

    expect(h.leases.released).toEqual(['sess_super']);
    expect(h.leases.acquired).toEqual(['sess_super', 'sess_super_2']);
    expect(controller.getAttachedSessionId()).toBe('sess_super_2');
  });

  it('only delivers when idle, queue empty and no blocking interaction', async () => {
    const h = makeHarness();
    controller = new SuperResidentController(h.deps);
    await controller.start();
    await flush();
    h.deliver.mockClear();
    const store = h.stores.get('sess_super')!;

    store.setState({ sessionStatus: 'streaming', currentStreamingMessageId: 'msg_a' });
    h.emitInbox({ sessionId: 'sess_super', pendingInbox: 1 });
    await flush();
    expect(h.deliver).not.toHaveBeenCalled();

    // 回合结束但队列非空：用户队列优先
    store.setState({
      sessionStatus: 'idle',
      currentStreamingMessageId: null,
      queuedMessages: [{ id: 'q1' } as unknown as ResidentChatState['queuedMessages'][number]],
    });
    await flush();
    expect(h.deliver).not.toHaveBeenCalled();

    // 阻塞交互（审批）中
    store.setState({ queuedMessages: [], pendingBlockingInteraction: { kind: 'tool_approval' } });
    await flush();
    expect(h.deliver).not.toHaveBeenCalled();

    // 审批解除 → 变为可投递 → 投递一次
    store.setState({ pendingBlockingInteraction: null });
    await flush();
    expect(h.deliver).toHaveBeenCalledTimes(1);
  });

  it('delivers on agent completion of its workers and ignores other parents', async () => {
    const h = makeHarness();
    controller = new SuperResidentController(h.deps);
    await controller.start();
    await flush();
    h.deliver.mockClear();

    h.emitCompletion({ workspace_id: 'ws_other', parent_session_id: 'sess_other' });
    await flush();
    expect(h.deliver).not.toHaveBeenCalled();

    h.emitCompletion({ workspace_id: 'ws_super', parent_session_id: 'sess_super' });
    await flush();
    expect(h.deliver).toHaveBeenCalledTimes(1);
  });

  it('does not re-deliver after busy/empty or from its own placeholder rollback', async () => {
    const h = makeHarness();
    controller = new SuperResidentController(h.deps);
    await controller.start();
    await flush();
    const store = h.stores.get('sess_super')!;
    h.deliver.mockClear();

    // 模拟 store.deliverSuperInbox：先进入 streaming 占位，empty 后回滚为 idle
    h.deliver.mockImplementation(async () => {
      store.setState({ sessionStatus: 'streaming', currentStreamingMessageId: 'msg_placeholder' });
      await Promise.resolve();
      store.setState({ sessionStatus: 'idle', currentStreamingMessageId: null });
      return { status: 'empty' };
    });
    h.emitInbox({ sessionId: 'sess_super', pendingInbox: 1 });
    await flush();
    await flush();
    expect(h.deliver).toHaveBeenCalledTimes(1);

    h.deliver.mockImplementation(async () => ({ status: 'busy' }));
    h.emitInbox({ sessionId: 'sess_super', pendingInbox: 1 });
    await flush();
    await flush();
    expect(h.deliver).toHaveBeenCalledTimes(2);
  });

  it('pauses after a user stop and resumes on the next human message', async () => {
    const h = makeHarness();
    controller = new SuperResidentController(h.deps);
    await controller.start();
    await flush();
    const store = h.stores.get('sess_super')!;
    h.deliver.mockClear();

    store.setState({ sessionStatus: 'streaming', currentStreamingMessageId: 'msg_a' });
    store.setState({ sessionStatus: 'aborting' });
    store.setState({ sessionStatus: 'idle', currentStreamingMessageId: null });
    await flush();
    expect(superResidentStore.getState().pausedReason).toBe('user_stop');
    expect(h.deliver).not.toHaveBeenCalled();

    h.emitInbox({ sessionId: 'sess_super', pendingInbox: 2 });
    await flush();
    expect(h.deliver).not.toHaveBeenCalled();
    expect(shouldShowPausedBanner(superResidentStore.getState(), 'sess_super')).toBe(true);

    // 事件消息（inboundOrigin）不算用户消息
    const inbound = { id: 'msg_in', role: 'user', blockIds: [], timestamp: 1, _meta: { inboundOrigin: { items: [] } } };
    store.setState({ messageOrder: ['msg_in'], messageMap: new Map([['msg_in', inbound as never]]) });
    await flush();
    expect(superResidentStore.getState().pausedReason).toBe('user_stop');

    // 用户发送新消息 → 解除暂停；回合结束变 idle 后自动投递
    const human = { id: 'msg_h', role: 'user', blockIds: [], timestamp: 2 };
    store.setState({
      sessionStatus: 'streaming',
      currentStreamingMessageId: 'msg_b',
      messageOrder: ['msg_in', 'msg_h'],
      messageMap: new Map([['msg_in', inbound as never], ['msg_h', human as never]]),
    });
    await flush();
    expect(superResidentStore.getState().pausedReason).toBeNull();
    store.setState({ sessionStatus: 'idle', currentStreamingMessageId: null });
    await flush();
    expect(h.deliver).toHaveBeenCalledTimes(1);
  });

  it('shows the banner on Paused and force-delivers on resume', async () => {
    const h = makeHarness();
    h.deliver.mockImplementation(async () => ({ status: 'paused', autoTurns: 20 }));
    controller = new SuperResidentController(h.deps);
    await controller.start();
    await flush();

    const state = superResidentStore.getState();
    expect(state.pausedReason).toBe('auto_limit');
    expect(state.autoTurns).toBe(20);
    expect(shouldShowPausedBanner(state, 'sess_super')).toBe(true);
    expect(shouldShowPausedBanner(state, 'sess_other')).toBe(false);

    // 暂停期间信号不触发投递
    h.deliver.mockClear();
    h.emitInbox({ sessionId: 'sess_super', pendingInbox: 3 });
    await flush();
    expect(h.deliver).not.toHaveBeenCalled();

    h.deliver.mockImplementation(async () => ({
      status: 'started',
      userMessage: { id: 'u', content: 'x', timestampMs: 1, inboundOrigin: {} },
      assistantMessageId: 'a',
    }));
    const outcome = await controller.resume();
    expect(outcome?.status).toBe('started');
    expect(h.deliver).toHaveBeenCalledWith({ force: true });
    expect(superResidentStore.getState().pausedReason).toBeNull();
  });

  it('backs off after backend errors instead of retrying on every signal', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      h.deliver.mockImplementation(async () => {
        throw new Error('boom');
      });
      controller = new SuperResidentController(h.deps);
      await controller.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.deliver).toHaveBeenCalledTimes(1);

      h.emitInbox({ sessionId: 'sess_super', pendingInbox: 1 });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.deliver).toHaveBeenCalledTimes(1);

      h.deliver.mockImplementation(async () => ({ status: 'empty' }));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.deliver).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
