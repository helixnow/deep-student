import { describe, expect, it } from 'vitest';
import type { Block } from '../../types/block';
import type { Message } from '../../types/message';
import type { ChatStoreState, GetState, SetState } from '../types';
import { cleanupVariantTerminalBlocks, createVariantActions } from '../variantActions';
import { createVariantStoreActions } from '../variantStoreActions';

function makeMessage(id: string, variantId: string, blockIds: string[], status: 'streaming' | 'pending' = 'streaming'): Message {
  return {
    id,
    role: 'assistant',
    blockIds: [],
    timestamp: 1,
    activeVariantId: variantId,
    variants: [
      {
        id: variantId,
        modelId: 'model_a',
        status,
        blockIds,
        createdAt: 1,
      },
    ],
  } as unknown as Message;
}

function makeHarness(initial: Partial<ChatStoreState>) {
  let state = {
    sessionId: 'sess_v',
    sessionStatus: 'streaming',
    currentStreamingMessageId: 'msg_v',
    activeBlockIds: new Set<string>(),
    streamingVariantIds: new Set<string>(),
    blocks: new Map<string, Block>(),
    messageMap: new Map<string, Message>(),
    messageOrder: ['msg_v'],
    ...initial,
  } as unknown as ChatStoreState;

  const set: SetState = (partial) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch } as ChatStoreState;
  };
  const getState: GetState = () => state as ReturnType<GetState>;
  return {
    getState: () => state,
    set,
    getState,
  };
}

describe('variant block lifecycle cleanup', () => {
  it('cleanupVariantTerminalBlocks transitions running and isPreparing blocks on error/cancelled and deletes orphan preparing on success', () => {
    const blocks = new Map<string, Block>([
      ['b_prep', { id: 'b_prep', type: 'mcp_tool', status: 'pending', messageId: 'm1', isPreparing: true }],
      ['b_run', { id: 'b_run', type: 'mcp_tool', status: 'running', messageId: 'm1' }],
    ]);
    const active = new Set(['b_prep', 'b_run']);

    const errRes = cleanupVariantTerminalBlocks(blocks, active, ['b_prep', 'b_run'], 'cancelled', 'user aborted', 1234);
    expect(errRes).toEqual({ updatedCount: 2, removedPreparingIds: [] });
    expect(blocks.get('b_prep')).toMatchObject({ isPreparing: false, status: 'error', error: 'user aborted', endedAt: 1234 });
    expect(blocks.get('b_run')).toMatchObject({ status: 'error', error: 'user aborted', endedAt: 1234 });
    expect(active.size).toBe(0);

    const blocksOk = new Map<string, Block>([
      ['b_prep', { id: 'b_prep', type: 'mcp_tool', status: 'pending', messageId: 'm1', isPreparing: true }],
      ['b_run', { id: 'b_run', type: 'mcp_tool', status: 'running', messageId: 'm1' }],
    ]);
    const activeOk = new Set(['b_prep', 'b_run']);
    const okRes = cleanupVariantTerminalBlocks(blocksOk, activeOk, ['b_prep', 'b_run'], 'success', undefined, 2000);
    expect(okRes).toEqual({ updatedCount: 2, removedPreparingIds: ['b_prep'] });
    expect(blocksOk.has('b_prep')).toBe(false);
    expect(blocksOk.get('b_run')).toMatchObject({ status: 'success', endedAt: 2000 });
    expect(activeOk.size).toBe(0);
  });

  it('variantStoreActions.handleVariantEnd cleans preparing and running blocks on cancelled and prunes preparing on success', () => {
    const hCancel = makeHarness({
      streamingVariantIds: new Set(['var_1']),
      activeBlockIds: new Set(['blk_p', 'blk_r']),
      blocks: new Map<string, Block>([
        ['blk_p', { id: 'blk_p', type: 'mcp_tool', status: 'pending', messageId: 'msg_v', isPreparing: true }],
        ['blk_r', { id: 'blk_r', type: 'rag', status: 'running', messageId: 'msg_v' }],
      ]),
      messageMap: new Map([['msg_v', makeMessage('msg_v', 'var_1', ['blk_p', 'blk_r'])]]),
    });
    const storeActions = createVariantStoreActions(hCancel.set, hCancel.getState);
    storeActions.handleVariantEnd({ type: 'variant_end', variantId: 'var_1', status: 'cancelled' });

    expect(hCancel.getState().blocks.get('blk_p')).toMatchObject({ isPreparing: false, status: 'error' });
    expect(hCancel.getState().blocks.get('blk_r')).toMatchObject({ status: 'error' });
    expect(hCancel.getState().activeBlockIds.size).toBe(0);

    const hSuccess = makeHarness({
      streamingVariantIds: new Set(['var_2']),
      activeBlockIds: new Set(['blk_p2']),
      blocks: new Map<string, Block>([
        ['blk_p2', { id: 'blk_p2', type: 'mcp_tool', status: 'pending', messageId: 'msg_v', isPreparing: true }],
      ]),
      messageMap: new Map([['msg_v', makeMessage('msg_v', 'var_2', ['blk_p2'])]]),
    });
    const successActions = createVariantStoreActions(hSuccess.set, hSuccess.getState);
    successActions.handleVariantEnd({ type: 'variant_end', variantId: 'var_2', status: 'success' });

    expect(hSuccess.getState().blocks.has('blk_p2')).toBe(false);
    expect(hSuccess.getState().messageMap.get('msg_v')?.variants?.[0]?.blockIds).toEqual([]);
  });

  it('variantStoreActions.cancelVariant also clears isPreparing blocks', async () => {
    const h = makeHarness({
      streamingVariantIds: new Set(['var_c']),
      activeBlockIds: new Set(['blk_prep']),
      blocks: new Map<string, Block>([
        ['blk_prep', { id: 'blk_prep', type: 'mcp_tool', status: 'pending', messageId: 'msg_v', isPreparing: true }],
      ]),
      messageMap: new Map([['msg_v', makeMessage('msg_v', 'var_c', ['blk_prep'])]]),
    });
    const actions = createVariantStoreActions(h.set, h.getState);
    await actions.cancelVariant('var_c');

    expect(h.getState().blocks.get('blk_prep')).toMatchObject({
      isPreparing: false,
      status: 'error',
      error: 'cancelled',
    });
  });

  it('variantActions.handleVariantEnd cleans preparing and running blocks on error', () => {
    const h = makeHarness({
      streamingVariantIds: new Set(['var_a']),
      activeBlockIds: new Set(['blk_p', 'blk_r']),
      blocks: new Map<string, Block>([
        ['blk_p', { id: 'blk_p', type: 'mcp_tool', status: 'pending', messageId: 'msg_v', isPreparing: true }],
        ['blk_r', { id: 'blk_r', type: 'web_search', status: 'running', messageId: 'msg_v' }],
      ]),
      messageMap: new Map([['msg_v', makeMessage('msg_v', 'var_a', ['blk_p', 'blk_r'])]]),
    });
    const actions = createVariantActions({
      get: h.getState,
      set: h.set as never,
      invokeBackend: async () => undefined as never,
    });
    actions.handleVariantEnd({ type: 'variant_end', variantId: 'var_a', status: 'error', error: 'model failed' });

    expect(h.getState().blocks.get('blk_p')).toMatchObject({
      isPreparing: false,
      status: 'error',
      error: 'model failed',
    });
    expect(h.getState().blocks.get('blk_r')).toMatchObject({
      status: 'error',
      error: 'model failed',
    });
    expect(h.getState().activeBlockIds.size).toBe(0);
  });
});
