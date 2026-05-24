import { describe, expect, it } from 'vitest';
import type { ContextRef } from '../../../context/types';
import type { ChatStoreState, GetState, SetState } from '../types';
import { createContextActions } from '../contextActions';

function createHarness(initialRefs: ContextRef[]) {
  let state = {
    pendingContextRefs: initialRefs,
    activeSkillIds: [],
  } as unknown as ChatStoreState;

  const set: SetState = (partial) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch } as ChatStoreState;
  };

  const get: GetState = () => state as unknown as ReturnType<GetState>;
  const actions = createContextActions(set, get);

  return {
    actions,
    getState: () => state,
  };
}

describe('contextActions.addContextRef', () => {
  it('去重命中时应更新完整字段（displayName/injectModes/typeId）', () => {
    const initialRef: ContextRef = {
      resourceId: 'res_same_1',
      hash: 'hash_old_12345678',
      typeId: 'file',
      displayName: 'Old Name',
      injectModes: { pdf: ['text'] },
    };

    const { actions, getState } = createHarness([initialRef]);

    actions.addContextRef({
      resourceId: 'res_same_1',
      hash: 'hash_new_87654321',
      typeId: 'image',
      displayName: 'New Name',
      injectModes: { image: ['image', 'ocr'] },
    });

    const refs = getState().pendingContextRefs;
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      resourceId: 'res_same_1',
      hash: 'hash_new_87654321',
      typeId: 'image',
      displayName: 'New Name',
      injectModes: { image: ['image', 'ocr'] },
    });
  });
});
