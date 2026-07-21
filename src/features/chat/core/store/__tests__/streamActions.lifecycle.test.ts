import { describe, expect, it } from 'vitest';
import type { ChatStoreState, GetState, SetState } from '../types';
import { createStreamActions } from '../streamActions';
import type { Block } from '../../types/block';
import type { Message } from '../../types/message';

function createHarness(initial: Partial<ChatStoreState> & {
  sessionStatus: ChatStoreState['sessionStatus'];
}) {
  let state = {
    activeBlockIds: new Set<string>(),
    currentStreamingMessageId: null as string | null,
    blocks: new Map<string, Block>(),
    messageMap: new Map<string, Message>(),
    ...initial,
  } as unknown as ChatStoreState;

  const set: SetState = (partial) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch } as ChatStoreState;
  };
  const getState: GetState = () => state as ReturnType<GetState>;
  const actions = createStreamActions(set, getState);
  return {
    getState: () => state,
    actions,
  };
}

describe('completeStream lifecycle cleanup', () => {
  it('clears a stale streaming message id even when status already raced back to idle', () => {
    const harness = createHarness({
      sessionStatus: 'idle',
      currentStreamingMessageId: 'msg_stale',
      activeBlockIds: new Set(['blk_stale']),
    });

    harness.actions.completeStream('success');

    expect(harness.getState().currentStreamingMessageId).toBeNull();
    expect(harness.getState().activeBlockIds.size).toBe(0);
  });

  it('does not label orphan preparing blocks as cancelled when stream completes successfully', () => {
    const preparing: Block = {
      id: 'blk_prep',
      type: 'mcp_tool',
      status: 'pending',
      messageId: 'msg_1',
      toolName: 'load_skills',
      toolCallId: 'call_1',
      isPreparing: true,
    };
    const msg = {
      id: 'msg_1',
      role: 'assistant',
      blockIds: ['blk_prep', 'blk_real'],
      _meta: { preparingToolCall: { toolCallId: 'call_1', toolName: 'load_skills' } },
    } as unknown as Message;
    const real: Block = {
      id: 'blk_real',
      type: 'mcp_tool',
      status: 'success',
      messageId: 'msg_1',
      toolName: 'load_skills',
      toolCallId: 'call_2',
      isPreparing: false,
    };

    const harness = createHarness({
      sessionStatus: 'streaming',
      currentStreamingMessageId: 'msg_1',
      blocks: new Map([
        ['blk_prep', preparing],
        ['blk_real', real],
      ]),
      messageMap: new Map([['msg_1', msg]]),
    });

    harness.actions.completeStream('success');

    const state = harness.getState();
    expect(state.sessionStatus).toBe('idle');
    expect(state.blocks.has('blk_prep')).toBe(false);
    expect(state.blocks.get('blk_real')?.status).toBe('success');
    expect(state.messageMap.get('msg_1')?.blockIds).toEqual(['blk_real']);
    expect(state.messageMap.get('msg_1')?._meta?.preparingToolCall).toBeUndefined();
  });

  it('keeps cancelled wording only when stream is cancelled', () => {
    const preparing: Block = {
      id: 'blk_prep',
      type: 'mcp_tool',
      status: 'pending',
      messageId: 'msg_1',
      toolName: 'builtin-local_shell_preflight',
      isPreparing: true,
    };
    const msg = {
      id: 'msg_1',
      role: 'assistant',
      blockIds: ['blk_prep'],
    } as unknown as Message;

    const harness = createHarness({
      sessionStatus: 'streaming',
      currentStreamingMessageId: 'msg_1',
      blocks: new Map([['blk_prep', preparing]]),
      messageMap: new Map([['msg_1', msg]]),
    });

    harness.actions.completeStream('cancelled');

    const block = harness.getState().blocks.get('blk_prep');
    expect(block?.status).toBe('error');
    expect(block?.isPreparing).toBe(false);
    expect(block?.error).toBe('Stream cancelled before tool execution');
  });

  it('uses error-before-execution wording when stream ends with error', () => {
    const preparing: Block = {
      id: 'blk_prep',
      type: 'mcp_tool',
      status: 'pending',
      messageId: 'msg_1',
      toolName: 'load_skills',
      isPreparing: true,
    };
    const msg = {
      id: 'msg_1',
      role: 'assistant',
      blockIds: ['blk_prep'],
    } as unknown as Message;

    const harness = createHarness({
      sessionStatus: 'streaming',
      currentStreamingMessageId: 'msg_1',
      blocks: new Map([['blk_prep', preparing]]),
      messageMap: new Map([['msg_1', msg]]),
    });

    harness.actions.completeStream('error');

    expect(harness.getState().blocks.get('blk_prep')?.error).toBe(
      'Stream ended with error before tool execution',
    );
  });
});
