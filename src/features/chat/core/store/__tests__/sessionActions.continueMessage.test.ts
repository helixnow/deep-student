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

  it('preserves unsent composer draft and avoids phantom sendMessage when in-place continue succeeds', async () => {
    const continueCallback = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const { actions, getState } = harness({
      inputValue: 'unsent follow-up draft',
      inputValueDirty: true,
      _continueMessageCallback: continueCallback,
      sendMessage,
    } as Partial<ChatStoreState>);

    await actions.continueMessage('msg_1', 'var_1');

    expect(continueCallback).toHaveBeenCalledWith('msg_1', 'var_1');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(getState().inputValue).toBe('unsent follow-up draft');
    expect(getState().inputValueDirty).toBe(true);
  });

  it('rethrows genuine continue errors instead of injecting a phantom user message or wiping draft', async () => {
    const continueCallback = vi.fn().mockRejectedValue(new Error('Database error: locked'));
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const { actions, getState } = harness({
      inputValue: 'keep my draft',
      inputValueDirty: true,
      _continueMessageCallback: continueCallback,
      sendMessage,
    } as Partial<ChatStoreState>);

    await expect(actions.continueMessage('msg_1')).rejects.toThrow('Database error: locked');

    expect(sendMessage).not.toHaveBeenCalled();
    expect(getState().inputValue).toBe('keep my draft');
    expect(getState().inputValueDirty).toBe(true);
  });

  it('preserves unsent composer draft even when falling back to sendMessage on TODO fallback', async () => {
    const continueCallback = vi.fn().mockRejectedValue(new Error('No incomplete TODO list found. Cannot continue execution.'));
    let stateRef: ChatStoreState | null = null;
    const sendMessage = vi.fn().mockImplementation(async () => {
      if (stateRef) {
        stateRef.inputValue = '';
        stateRef.inputValueDirty = false;
      }
    });
    const { actions, getState } = harness({
      inputValue: 'my unsent draft',
      inputValueDirty: true,
      _continueMessageCallback: continueCallback,
      sendMessage,
    } as Partial<ChatStoreState>);
    stateRef = getState();

    await actions.continueMessage('msg_1');

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(getState().inputValue).toBe('my unsent draft');
    expect(getState().inputValueDirty).toBe(true);
  });
});
