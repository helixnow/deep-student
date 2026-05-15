import { describe, expect, it } from 'vitest';
import { createQueueActions } from '../queueActions';
import type { ChatStoreState, GetState, SetState } from '../types';
import { QUEUE_HARD_CAP } from '../../types/queue';

function makeItem(overrides: Partial<{ id: string; content: string; status: 'pending' | 'failed'; error: string }> = {}) {
  return {
    id: overrides.id ?? 'q_test',
    content: overrides.content ?? '',
    attachments: [],
    contextRefs: [],
    createdAt: 0,
    status: overrides.status ?? 'pending' as const,
    ...(overrides.error !== undefined ? { error: overrides.error } : {}),
  };
}

function harness(initial?: Partial<ChatStoreState>) {
  let state = {
    sessionStatus: 'streaming',
    queuedMessages: [],
    dequeuing: false,
    pendingBlockingInteraction: null,
    inputValue: '',
    attachments: [],
    pendingContextRefs: [],
    ...initial,
  } as unknown as ChatStoreState;

  const set: SetState = (partial) => {
    const patch = typeof partial === 'function' ? (partial as (s: ChatStoreState) => Partial<ChatStoreState>)(state) : partial;
    state = { ...state, ...patch } as ChatStoreState;
  };
  const get: GetState = () => state as unknown as ReturnType<GetState>;
  const actions = createQueueActions(set, get);
  return { actions, getState: () => state };
}

describe('enqueueMessage', () => {
  it('appends item with pending status and a q_-prefixed unique id', () => {
    const { actions, getState } = harness();
    actions.enqueueMessage('hello', [], []);
    const queue = getState().queuedMessages;
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ content: 'hello', status: 'pending' });
    expect(queue[0].id).toMatch(/^q_/);
  });

  it('generates unique ids across calls', () => {
    const { actions, getState } = harness();
    actions.enqueueMessage('a', [], []);
    actions.enqueueMessage('b', [], []);
    const ids = getState().queuedMessages.map((q) => q.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('refuses when at hard cap', () => {
    const initial = Array.from({ length: QUEUE_HARD_CAP }, (_, i) => makeItem({ id: `q${i}` }));
    const { actions, getState } = harness({ queuedMessages: initial });
    actions.enqueueMessage('overflow', [], []);
    expect(getState().queuedMessages).toHaveLength(QUEUE_HARD_CAP);
  });
});

describe('removeQueued', () => {
  it('removes by id', () => {
    const { actions, getState } = harness({
      queuedMessages: [makeItem({ id: 'a' }), makeItem({ id: 'b' })],
    });
    actions.removeQueued('a');
    expect(getState().queuedMessages.map((q) => q.id)).toEqual(['b']);
  });

  it('is a no-op when id not found', () => {
    const { actions, getState } = harness({
      queuedMessages: [makeItem({ id: 'a' })],
    });
    actions.removeQueued('does-not-exist');
    expect(getState().queuedMessages).toHaveLength(1);
  });
});

describe('clearQueue', () => {
  it('empties queue including failed items', () => {
    const { actions, getState } = harness({
      queuedMessages: [
        makeItem({ id: 'a', status: 'failed', error: 'x' }),
        makeItem({ id: 'b' }),
      ],
    });
    actions.clearQueue();
    expect(getState().queuedMessages).toEqual([]);
  });
});

describe('promoteQueued', () => {
  it('moves matching id to head', () => {
    const { actions, getState } = harness({
      queuedMessages: [makeItem({ id: 'a' }), makeItem({ id: 'b' }), makeItem({ id: 'c' })],
    });
    actions.promoteQueued('c');
    expect(getState().queuedMessages.map((q) => q.id)).toEqual(['c', 'a', 'b']);
  });

  it('is a no-op when item is already head', () => {
    const { actions, getState } = harness({
      queuedMessages: [makeItem({ id: 'a' }), makeItem({ id: 'b' })],
    });
    actions.promoteQueued('a');
    expect(getState().queuedMessages.map((q) => q.id)).toEqual(['a', 'b']);
  });

  it('is a no-op when id not found', () => {
    const { actions, getState } = harness({
      queuedMessages: [makeItem({ id: 'a' })],
    });
    actions.promoteQueued('missing');
    expect(getState().queuedMessages.map((q) => q.id)).toEqual(['a']);
  });
});

describe('retryFailed', () => {
  it('resets matching failed item to pending and clears error', () => {
    const { actions, getState } = harness({
      queuedMessages: [makeItem({ id: 'a', status: 'failed', error: 'oops' })],
    });
    actions.retryFailed('a');
    expect(getState().queuedMessages[0]).toMatchObject({ status: 'pending' });
    expect(getState().queuedMessages[0].error).toBeUndefined();
  });

  it('is a no-op when id not found', () => {
    const { actions, getState } = harness({
      queuedMessages: [makeItem({ id: 'a', status: 'failed', error: 'x' })],
    });
    actions.retryFailed('missing');
    expect(getState().queuedMessages[0].status).toBe('failed');
  });
});

describe('recallToDraft', () => {
  it('populates inputValue/attachments/pendingContextRefs and removes from queue when draft empty', () => {
    const item = makeItem({ id: 't', content: 'recalled' });
    const { actions, getState } = harness({
      queuedMessages: [item],
      inputValue: '',
    });
    actions.recallToDraft('t');
    const s = getState();
    expect(s.inputValue).toBe('recalled');
    expect(s.queuedMessages).toEqual([]);
  });

  it('is a no-op when id not found', () => {
    const { actions, getState } = harness({
      queuedMessages: [makeItem({ id: 'a' })],
      inputValue: 'untouched',
    });
    actions.recallToDraft('missing');
    expect(getState().inputValue).toBe('untouched');
    expect(getState().queuedMessages).toHaveLength(1);
  });
});

describe('swapQueueWithDraft', () => {
  it('when draft is non-empty: appends draft to tail and recalls target', () => {
    const target = makeItem({ id: 't', content: 'recalled' });
    const { actions, getState } = harness({
      queuedMessages: [target],
      inputValue: 'draft text',
    });
    actions.swapQueueWithDraft('t');
    const s = getState();
    expect(s.inputValue).toBe('recalled');
    expect(s.queuedMessages).toHaveLength(1);
    expect(s.queuedMessages[0].content).toBe('draft text');
    expect(s.queuedMessages[0].id).not.toBe('t');
  });

  it('when draft is empty: behaves like recallToDraft', () => {
    const target = makeItem({ id: 't', content: 'recalled' });
    const { actions, getState } = harness({
      queuedMessages: [target],
      inputValue: '   ', // whitespace only counts as empty
    });
    actions.swapQueueWithDraft('t');
    const s = getState();
    expect(s.inputValue).toBe('recalled');
    expect(s.queuedMessages).toEqual([]);
  });

  it('is a no-op when id not found', () => {
    const { actions, getState } = harness({
      queuedMessages: [makeItem({ id: 'a' })],
      inputValue: 'draft',
    });
    actions.swapQueueWithDraft('missing');
    expect(getState().inputValue).toBe('draft');
    expect(getState().queuedMessages).toHaveLength(1);
  });

  it('preserves swap count at hard cap (net-zero)', () => {
    const initial = Array.from({ length: QUEUE_HARD_CAP }, (_, i) => makeItem({ id: `q${i}`, content: `c${i}` }));
    const { actions, getState } = harness({
      queuedMessages: initial,
      inputValue: 'incoming draft',
    });
    actions.swapQueueWithDraft('q0');
    const s = getState();
    expect(s.queuedMessages).toHaveLength(QUEUE_HARD_CAP);
    expect(s.inputValue).toBe('c0');
    expect(s.queuedMessages[s.queuedMessages.length - 1].content).toBe('incoming draft');
  });
});
