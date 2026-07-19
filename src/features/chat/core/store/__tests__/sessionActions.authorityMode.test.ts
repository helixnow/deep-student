import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createSessionActions } from '../sessionActions';
import type { ChatStoreState } from '../types';
import { createInitialState } from '../types';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('../../registry/eventRegistry', () => {
  const handlers = new Map<string, unknown>();
  return {
    eventRegistry: {
      register: (type: string, handler: unknown) => {
        handlers.set(type, handler);
      },
      get: (type: string) => handlers.get(type),
      has: (type: string) => handlers.has(type),
    },
  };
});

describe('sessionActions authority mode', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ id: 'sess_1' });
  });

  it('setAuthorityMode invokes backend once and updates local state', async () => {
    let state = createInitialState('sess_1') as ChatStoreState;

    const set = (partial: Partial<ChatStoreState> | ((s: ChatStoreState) => Partial<ChatStoreState>)) => {
      const next = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...next };
    };
    const getState = () => state as never;

    const actions = createSessionActions(set as never, getState, () => {});
    await actions.setAuthorityMode('ask');

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('chat_v2_set_authority_mode', {
      sessionId: 'sess_1',
      mode: 'ask',
    });
    expect(state.authorityMode).toBe('ask');
    expect(state.authorityAskBlockedHint).toBe(false);
    expect((state.sessionMetadata as { authorityMode?: string })?.authorityMode).toBe('ask');
    expect((state.sessionMetadata as { authority_mode?: string })?.authority_mode).toBe('ask');
  });

  it('setAuthorityMode no-ops without sessionId and does not invoke', async () => {
    let state = { ...createInitialState(''), sessionId: null } as ChatStoreState;
    const set = (partial: Partial<ChatStoreState> | ((s: ChatStoreState) => Partial<ChatStoreState>)) => {
      const next = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...next };
    };
    const actions = createSessionActions(set as never, () => state as never, () => {});
    await actions.setAuthorityMode('plan');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('does not revive a dismissed Ask-blocked hint after switching away and back', async () => {
    let state = createInitialState('sess_1') as ChatStoreState;
    const set = (partial: Partial<ChatStoreState> | ((s: ChatStoreState) => Partial<ChatStoreState>)) => {
      const next = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...next };
    };
    const actions = createSessionActions(set as never, () => state as never, () => {});

    actions.setAuthorityAskBlockedHint(true);
    expect(state.authorityAskBlockedHint).toBe(true);
    await actions.setAuthorityMode('plan');
    await actions.setAuthorityMode('ask');

    expect(state.authorityAskBlockedHint).toBe(false);
  });

  it('handlePlanGateRequest sets plan_gate blocking interaction', () => {
    let state = createInitialState('sess_1') as ChatStoreState;

    const set = (partial: Partial<ChatStoreState> | ((s: ChatStoreState) => Partial<ChatStoreState>)) => {
      const next = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...next };
    };
    const getState = () => state as never;
    const actions = createSessionActions(set as never, getState, () => {});

    actions.handlePlanGateRequest({
      planId: 'plan_1',
      toolCallId: 'call_1',
      toolName: 'builtin-note_delete',
      summary: 'delete note',
      timeoutSeconds: 60,
    });

    expect(state.pendingBlockingInteraction).toEqual(
      expect.objectContaining({
        kind: 'plan_gate',
        planId: 'plan_1',
        toolCallId: 'call_1',
      }),
    );
  });
});
