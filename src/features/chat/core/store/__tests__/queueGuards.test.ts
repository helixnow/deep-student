import { describe, expect, it } from 'vitest';
import { createGuards } from '../guards';
import type { ChatStoreState } from '../types';
import type { QueuedMessage } from '../../types/queue';
import { QUEUE_HARD_CAP } from '../../types/queue';

function makeState(overrides: Partial<ChatStoreState> = {}): ChatStoreState {
  return {
    sessionStatus: 'idle',
    queuedMessages: [],
    dequeuing: false,
    pendingBlockingInteraction: null,
    activeBlockIds: new Set<string>(),
    messageMap: new Map(),
    ...overrides,
  } as unknown as ChatStoreState;
}

function pendingItem(id = 'q1'): QueuedMessage {
  return {
    id,
    content: 'hi',
    attachments: [],
    contextRefs: [],
    createdAt: Date.now(),
    status: 'pending',
  };
}

describe('canEnqueue', () => {
  it('rejects when queue is at hard cap', () => {
    const state = makeState({
      queuedMessages: Array.from({ length: QUEUE_HARD_CAP }, (_, i) => pendingItem(`q${i}`)),
    });
    const guards = createGuards(() => state);
    expect(guards.canEnqueue(true)).toBe(false);
  });

  it('rejects when queueEnabled=false', () => {
    const state = makeState();
    const guards = createGuards(() => state);
    expect(guards.canEnqueue(false)).toBe(false);
  });

  it('accepts when below cap and enabled', () => {
    const state = makeState();
    const guards = createGuards(() => state);
    expect(guards.canEnqueue(true)).toBe(true);
  });
});

describe('canEnqueueSwap', () => {
  it('rejects when queueEnabled=false', () => {
    const state = makeState({ queuedMessages: [pendingItem()] });
    const guards = createGuards(() => state);
    expect(guards.canEnqueueSwap(false)).toBe(false);
  });

  it('allows net-zero swap at cap', () => {
    const state = makeState({
      queuedMessages: Array.from({ length: QUEUE_HARD_CAP }, (_, i) => pendingItem(`q${i}`)),
    });
    const guards = createGuards(() => state);
    expect(guards.canEnqueueSwap(true)).toBe(true);
  });
});

describe('canDequeue', () => {
  it('blocks when status !== idle', () => {
    const state = makeState({ sessionStatus: 'streaming', queuedMessages: [pendingItem()] });
    const guards = createGuards(() => state);
    expect(guards.canDequeue()).toBe(false);
  });

  it('blocks when queue empty', () => {
    const state = makeState();
    const guards = createGuards(() => state);
    expect(guards.canDequeue()).toBe(false);
  });

  it('blocks when dequeuing flag is set', () => {
    const state = makeState({ queuedMessages: [pendingItem()], dequeuing: true });
    const guards = createGuards(() => state);
    expect(guards.canDequeue()).toBe(false);
  });

  it('blocks when blocking interaction present', () => {
    const state = makeState({
      queuedMessages: [pendingItem()],
      pendingBlockingInteraction: { kind: 'tool_limit', blockId: 'b', content: '', onContinue: null } as unknown as ChatStoreState['pendingBlockingInteraction'],
    });
    const guards = createGuards(() => state);
    expect(guards.canDequeue()).toBe(false);
  });

  it('blocks when any item is failed (halt-on-failure)', () => {
    const state = makeState({
      queuedMessages: [{ ...pendingItem(), status: 'failed' as const, error: 'x' }],
    });
    const guards = createGuards(() => state);
    expect(guards.canDequeue()).toBe(false);
  });

  it('accepts when all conditions met', () => {
    const state = makeState({ queuedMessages: [pendingItem()] });
    const guards = createGuards(() => state);
    expect(guards.canDequeue()).toBe(true);
  });
});
