import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('maybeDequeue', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('shifts head item, calls sendMessage with content+attachments, sets dequeuing flag', async () => {
    const sentCalls: Array<{ content: string; attachments: unknown[] }> = [];
    const item = makeItem({ id: 'a', content: 'first' });
    const { actions, getState } = harness({
      sessionStatus: 'idle',
      queuedMessages: [item],
    });

    // Inject a fake sendMessage onto the harness state
    (getState() as unknown as { sendMessage: (c: string, a: unknown[]) => Promise<void> })
      .sendMessage = async (content, attachments) => {
        sentCalls.push({ content, attachments });
      };

    await actions.maybeDequeue();

    expect(sentCalls).toEqual([{ content: 'first', attachments: [] }]);
    expect(getState().queuedMessages).toEqual([]);
    expect(getState().dequeuing).toBe(true);

    // After breather, dequeuing flips back
    vi.advanceTimersByTime(300);
    expect(getState().dequeuing).toBe(false);
  });

  it('is a no-op when sessionStatus !== idle', async () => {
    const item = makeItem({ id: 'a', content: 'first' });
    const { actions, getState } = harness({
      sessionStatus: 'streaming',
      queuedMessages: [item],
    });
    await actions.maybeDequeue();
    expect(getState().queuedMessages).toHaveLength(1);
    expect(getState().dequeuing).toBe(false);
  });

  it('is a no-op when queue is empty', async () => {
    const { actions, getState } = harness({ sessionStatus: 'idle' });
    await actions.maybeDequeue();
    expect(getState().dequeuing).toBe(false);
  });

  it('is a no-op when already dequeuing', async () => {
    const item = makeItem({ id: 'a' });
    const { actions, getState } = harness({
      sessionStatus: 'idle',
      queuedMessages: [item],
      dequeuing: true,
    });
    await actions.maybeDequeue();
    expect(getState().queuedMessages).toHaveLength(1);
  });

  it('is a no-op when blocking interaction is present', async () => {
    const item = makeItem({ id: 'a' });
    const { actions, getState } = harness({
      sessionStatus: 'idle',
      queuedMessages: [item],
      pendingBlockingInteraction: { kind: 'tool_limit', blockId: 'b', content: '', onContinue: null } as unknown as ChatStoreState['pendingBlockingInteraction'],
    });
    await actions.maybeDequeue();
    expect(getState().queuedMessages).toHaveLength(1);
  });

  it('is a no-op when any item is already failed (halt)', async () => {
    const item = makeItem({ id: 'a', status: 'failed', error: 'x' });
    const { actions, getState } = harness({
      sessionStatus: 'idle',
      queuedMessages: [item],
    });
    await actions.maybeDequeue();
    expect(getState().queuedMessages).toHaveLength(1);
  });

  it('on sendMessage failure: re-inserts item at head with status=failed and error message', async () => {
    const item = makeItem({ id: 'a', content: 'will-fail' });
    const { actions, getState } = harness({
      sessionStatus: 'idle',
      queuedMessages: [item],
    });
    (getState() as unknown as { sendMessage: (c: string) => Promise<void> }).sendMessage = async () => {
      throw new Error('boom');
    };

    await actions.maybeDequeue();

    const queue = getState().queuedMessages;
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ content: 'will-fail', status: 'failed', error: 'boom' });
  });

  it('on success: queue order preserved for remaining items', async () => {
    const a = makeItem({ id: 'a', content: 'first' });
    const b = makeItem({ id: 'b', content: 'second' });
    const { actions, getState } = harness({
      sessionStatus: 'idle',
      queuedMessages: [a, b],
    });
    (getState() as unknown as { sendMessage: (c: string) => Promise<void> }).sendMessage = async () => {};
    await actions.maybeDequeue();
    expect(getState().queuedMessages.map((q) => q.id)).toEqual(['b']);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Regression tests for critical fixes from final review
  // ─────────────────────────────────────────────────────────────────────────

  describe('blocking-interaction tolerance', () => {
    it('blocks when only the legacy pendingApprovalRequest field is set', async () => {
      const item = makeItem({ id: 'a' });
      const { actions, getState } = harness({
        sessionStatus: 'idle',
        queuedMessages: [item],
        pendingBlockingInteraction: null,
      });
      // Inject the legacy field shape that does not exist on ChatStoreState type
      // but does at HEAD's runtime.
      (getState() as unknown as { pendingApprovalRequest: unknown }).pendingApprovalRequest = {
        toolCallId: 't',
        toolName: 'x',
        arguments: {},
        sensitivity: 'low',
        description: 'd',
        timeoutSeconds: 30,
      };
      await actions.maybeDequeue();
      expect(getState().queuedMessages).toHaveLength(1);
    });

    it('blocks when only the new pendingBlockingInteraction field is set', async () => {
      const item = makeItem({ id: 'a' });
      const { actions, getState } = harness({
        sessionStatus: 'idle',
        queuedMessages: [item],
        pendingBlockingInteraction: { kind: 'tool_limit', blockId: 'b', content: '', onContinue: null } as unknown as ChatStoreState['pendingBlockingInteraction'],
      });
      await actions.maybeDequeue();
      expect(getState().queuedMessages).toHaveLength(1);
    });
  });

  describe('breather-completion retry (fast-stream stall regression)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('continues to next item after breather even if stream finished within breather window', async () => {
      const a = makeItem({ id: 'a', content: 'first' });
      const b = makeItem({ id: 'b', content: 'second' });
      const sentContents: string[] = [];
      const { actions, getState } = harness({
        sessionStatus: 'idle',
        queuedMessages: [a, b],
      });

      // sendMessage resolves "fast" (synchronously) — within the breather.
      (getState() as unknown as { sendMessage: (c: string) => Promise<void> }).sendMessage = async (c) => {
        sentContents.push(c);
      };
      // Wire maybeDequeue back onto the harness state so the breather's
      // self-retry can find it (production: it's on the store via factory wiring).
      (getState() as unknown as { maybeDequeue: () => Promise<void> }).maybeDequeue = actions.maybeDequeue;

      // First dequeue: fires sendMessage(a), sets dequeuing=true.
      await actions.maybeDequeue();
      expect(sentContents).toEqual(['first']);
      expect(getState().queuedMessages.map((q) => q.id)).toEqual(['b']);
      expect(getState().dequeuing).toBe(true);

      // Manual idle transition (in production: subscription fires on stream end,
      // but blocked because dequeuing=true).
      // Here we just advance the breather timer — it should clear the flag AND
      // re-trigger maybeDequeue, which now finds b at head.
      await vi.advanceTimersByTimeAsync(300);

      expect(sentContents).toEqual(['first', 'second']);
      expect(getState().queuedMessages).toEqual([]);
    });
  });

  describe('order-of-operations: bail before mutation when sendMessage missing', () => {
    it('does not drop head item when sendMessage is not wired', async () => {
      const item = makeItem({ id: 'a', content: 'preserved' });
      const { actions, getState } = harness({
        sessionStatus: 'idle',
        queuedMessages: [item],
      });
      // Deliberately do NOT inject sendMessage.
      await actions.maybeDequeue();
      // Head item must remain — silent drop would be a critical bug.
      expect(getState().queuedMessages).toHaveLength(1);
      expect(getState().queuedMessages[0].id).toBe('a');
      expect(getState().dequeuing).toBe(false);
    });
  });
});
