import { describe, expect, it } from 'vitest';
import type { ChatStoreState, GetState, SetState } from '../types';
import { createStreamActions } from '../streamActions';

describe('completeStream lifecycle cleanup', () => {
  it('clears a stale streaming message id even when status already raced back to idle', () => {
    let state = {
      sessionStatus: 'idle',
      currentStreamingMessageId: 'msg_stale',
      activeBlockIds: new Set(['blk_stale']),
    } as unknown as ChatStoreState;
    const set: SetState = (partial) => {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...patch } as ChatStoreState;
    };
    const getState: GetState = () => state as ReturnType<GetState>;
    const actions = createStreamActions(set, getState);

    actions.completeStream('success');

    expect(state.currentStreamingMessageId).toBeNull();
    expect(state.activeBlockIds.size).toBe(0);
  });
});
