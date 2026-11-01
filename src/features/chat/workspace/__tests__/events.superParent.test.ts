import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const callbacks = new Map<string, (event: { payload: any }) => void>();
  const stores = new Map<string, any>();
  return {
    callbacks,
    stores,
    listen: vi.fn(async (eventName: string, callback: (event: { payload: any }) => void) => {
      callbacks.set(eventName, callback);
      return vi.fn();
    }),
    adapterManager: {
      get: vi.fn(() => undefined),
      getOrCreate: vi.fn(async () => ({
        entry: { isReady: true, generation: 1 },
        lease: { sessionId: 'x', generation: 1, token: Symbol('lease') },
      })),
      waitForListenersReady: vi.fn(async () => undefined),
      release: vi.fn(),
    },
    sessionManager: {
      peek: vi.fn((id: string) => stores.get(id)),
      getOrCreate: vi.fn(() => ({ getState: () => ({ isDataLoaded: true }) })),
    },
    invoke: vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => false),
  };
});

vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../../adapters/AdapterManager', () => ({ adapterManager: mocks.adapterManager }));
vi.mock('../../core/session/sessionManager', () => ({ sessionManager: mocks.sessionManager }));
vi.mock('../../core/store/createChatStore', () => ({
  generateId: vi.fn((prefix: string) => `${prefix}_mock`),
}));
vi.mock('../api', () => ({ runAgent: vi.fn() }));
vi.mock('../../debug/exportSessionDebug', () => ({
  addSubagentEventLog: vi.fn(),
  addSubagentPreheatLog: vi.fn(),
}));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
// 工作包 E 提供的判定函数；此处按契约（metadata.super_agent?.active === true）模拟
vi.mock('../../superSession/isSuperSession', () => ({
  isSuperSession: (metadata: any) => metadata?.super_agent?.active === true,
}));

import {
  cleanupWorkspaceEventListeners,
  initWorkspaceEventListeners,
  WORKSPACE_EVENTS,
} from '../events';

function makeParentStore(metadata: Record<string, unknown> | null) {
  const state = {
    sessionStatus: 'idle',
    currentStreamingMessageId: null,
    sessionMetadata: metadata,
    blocks: new Map(),
    wakeSession: vi.fn(async () => undefined),
  };
  return {
    state,
    store: { getState: () => state, subscribe: vi.fn(() => () => undefined) },
  };
}

function completion(parentSessionId: string, agent: string) {
  return {
    payload: {
      workspace_id: 'ws_super',
      agent_session_id: agent,
      parent_session_id: parentSessionId,
      run_id: `run_${agent}`,
      status: 'completed',
      final_output: 'done',
    },
  };
}

describe('workspace completion wake with a Super parent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.callbacks.clear();
    mocks.stores.clear();
    (window as any).__TAURI_INTERNALS__ = {};
  });

  afterEach(async () => {
    await cleanupWorkspaceEventListeners();
    delete (window as any).__TAURI_INTERNALS__;
  });

  it('does not wake a Super parent (inbox delivery handles it)', async () => {
    const parent = makeParentStore({ super_agent: { active: true, version: 1 } });
    mocks.stores.set('sess_super', parent.store);
    await initWorkspaceEventListeners();

    mocks.callbacks.get(WORKSPACE_EVENTS.AGENT_COMPLETION)!(completion('sess_super', 'subagent_explorer_1'));

    await vi.waitFor(() => expect(mocks.sessionManager.peek).toHaveBeenCalledWith('sess_super'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(parent.state.wakeSession).not.toHaveBeenCalled();
    expect(mocks.adapterManager.getOrCreate).not.toHaveBeenCalled();
  });

  it('still wakes a normal idle parent', async () => {
    const parent = makeParentStore({ super_agent: { active: false } });
    mocks.stores.set('sess_normal', parent.store);
    await initWorkspaceEventListeners();

    mocks.callbacks.get(WORKSPACE_EVENTS.AGENT_COMPLETION)!(completion('sess_normal', 'subagent_explorer_2'));

    await vi.waitFor(() => expect(parent.state.wakeSession).toHaveBeenCalledTimes(1));
  });
});
