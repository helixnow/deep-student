import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createSessionActions } from '../sessionActions';
import type { ChatStoreState } from '../types';
import { createInitialState } from '../types';
import type { BlockingInteraction } from '../../types/store';

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

const toolLimitInteraction: BlockingInteraction = {
  kind: 'tool_limit',
  blockId: 'block_1',
  content: '已达到工具调用上限',
  onContinue: null,
};

const approvalInteraction: BlockingInteraction = {
  kind: 'tool_approval',
  toolCallId: 'call_1',
  toolName: 'shell',
  arguments: {},
  sensitivity: 'medium',
  description: 'run shell',
  timeoutSeconds: 60,
};

describe('sessionActions continueMessage', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  function harness(overrides: Partial<ChatStoreState>) {
    let state = { ...createInitialState('sess_1'), ...overrides } as ChatStoreState;
    const set = (partial: Partial<ChatStoreState> | ((s: ChatStoreState) => Partial<ChatStoreState>)) => {
      const next = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...next };
    };
    const getState = () => state as never;
    const actions = createSessionActions(set as never, getState, () => {});
    return { actions, getState: () => state };
  }

  it('clears a pending tool_limit blocking interaction before continuing', async () => {
    const continueCallback = vi.fn().mockResolvedValue(undefined);
    const { actions, getState } = harness({
      pendingBlockingInteraction: toolLimitInteraction,
      _continueMessageCallback: continueCallback,
    });

    await actions.continueMessage('msg_1');

    expect(continueCallback).toHaveBeenCalledWith('msg_1', undefined);
    expect(getState().pendingBlockingInteraction).toBeNull();
  });

  it('keeps non-tool_limit blocking interactions untouched', async () => {
    const continueCallback = vi.fn().mockResolvedValue(undefined);
    const { actions, getState } = harness({
      pendingBlockingInteraction: approvalInteraction,
      _continueMessageCallback: continueCallback,
    });

    await actions.continueMessage('msg_1');

    expect(continueCallback).toHaveBeenCalledWith('msg_1', undefined);
    expect(getState().pendingBlockingInteraction).toEqual(approvalInteraction);
  });
});
