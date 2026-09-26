import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { Block, ChatStore, Message } from '../../core/types';
import type { MessageSearchMatch, MessageSearchRequest, MessageSearchResponse } from '../../components/messageSearch';
import { useMessageSearch } from '../useMessageSearch';

const instances: MockWorker[] = [];
class MockWorker {
  requests: MessageSearchRequest[] = [];
  onmessage: ((event: MessageEvent<MessageSearchResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  constructor() { instances.push(this); }
  postMessage(request: MessageSearchRequest) { this.requests.push(request); }
  respond(request: MessageSearchRequest, matches: MessageSearchMatch[]) {
    this.onmessage?.({ data: { requestId: request.requestId, matches } } as MessageEvent<MessageSearchResponse>);
  }
}

function makeStore(sessionId = 'session') {
  const messages: Message[] = [
    { id: 'm1', role: 'assistant', blockIds: ['b1'], timestamp: 0 },
    { id: 'm2', role: 'assistant', blockIds: ['b2'], timestamp: 1 },
  ];
  const blocks: Block[] = [
    { id: 'b1', messageId: 'm1', type: 'content', status: 'success', content: 'first hit' },
    { id: 'b2', messageId: 'm2', type: 'content', status: 'running', content: 'second' },
  ];
  return createStore<ChatStore>(() => ({
    sessionId,
    messageOrder: messages.map((message) => message.id),
    messageMap: new Map(messages.map((message) => [message.id, message])),
    blocks: new Map(blocks.map((block) => [block.id, block])),
  } as ChatStore));
}

function append(store: ReturnType<typeof makeStore>, content: string) {
  const state = store.getState();
  store.setState({ blocks: new Map(state.blocks).set('b2', { ...state.blocks.get('b2')!, content }) });
}

beforeEach(() => {
  instances.length = 0;
  vi.stubGlobal('Worker', MockWorker);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useMessageSearch', () => {
  it('sends one initial snapshot, then only changed blocks or query text', () => {
    const store = makeStore();
    const { result, rerender } = renderHook(({ query }) => useMessageSearch(store, true, query), {
      initialProps: { query: 'hit' },
    });
    const worker = instances[0];
    expect(worker.requests).toHaveLength(1);
    expect(worker.requests[0].blocks).toHaveLength(2);
    expect(worker.requests[0].messages).toEqual([
      { messageId: 'm1', blockIds: ['b1'] }, { messageId: 'm2', blockIds: ['b2'] },
    ]);
    act(() => worker.respond(worker.requests[0], [{ messageId: 'm1', occurrenceIndex: 0 }]));
    const originalMatches = result.current;

    act(() => append(store, 'second appended'));
    const updated = worker.requests[1];
    expect(updated.blocks).toEqual([{ id: 'b2', content: 'second appended' }]);
    expect(updated.messages).toBeUndefined();
    act(() => worker.respond(updated, [{ messageId: 'm1', occurrenceIndex: 0 }]));
    expect(result.current).toBe(originalMatches);

    rerender({ query: 'second' });
    expect(result.current).toEqual([]);
    expect(worker.requests[2].blocks).toEqual([]);
    expect(worker.requests[2].messages).toBeUndefined();
    expect(worker.requests[2].query).toBe('second');
    act(() => worker.respond(updated, [{ messageId: 'stale', occurrenceIndex: 0 }]));
    expect(result.current).toEqual([]);
    act(() => worker.respond(worker.requests[2], [{ messageId: 'm2', occurrenceIndex: 0 }]));
    expect(result.current).toEqual([{ messageId: 'm2', occurrenceIndex: 0 }]);
  });

  it('synchronizes message order and deleted blocks without resending unchanged text', () => {
    const store = makeStore();
    renderHook(() => useMessageSearch(store, true, 'hit'));
    act(() => store.setState({ messageOrder: ['m2'] }));
    const update = instances[0].requests[1];
    expect(update.messages).toEqual([{ messageId: 'm2', blockIds: ['b2'] }]);
    expect(update.removedBlockIds).toEqual(['b1']);
    expect(update.blocks).toEqual([]);
  });

  it('does not index an empty query and ignores in-flight results after clearing it', () => {
    const store = makeStore();
    const { result, rerender } = renderHook(({ query }) => useMessageSearch(store, true, query), {
      initialProps: { query: '' },
    });
    act(() => append(store, 'latest hit'));
    expect(instances[0].requests).toHaveLength(0);
    rerender({ query: 'hit' });
    const request = instances[0].requests[0];
    expect(request.blocks.find((block) => block.id === 'b2')?.content).toBe('latest hit');
    rerender({ query: '' });
    act(() => instances[0].respond(request, [{ messageId: 'm1', occurrenceIndex: 0 }]));
    expect(result.current).toEqual([]);
  });

  it('terminates and unsubscribes on close and when the conversation changes', () => {
    const store = makeStore();
    const nextStore = makeStore('next-session');
    const { result, rerender, unmount } = renderHook(
      (props) => useMessageSearch(props.store, props.open, 'hit'),
      { initialProps: { store, open: true } },
    );
    const oldWorker = instances[0];
    const lateMessage = oldWorker.onmessage!;
    rerender({ store: nextStore, open: true });
    expect(oldWorker.terminate).toHaveBeenCalledOnce();
    act(() => lateMessage({ data: { requestId: 1, matches: [{ messageId: 'stale', occurrenceIndex: 0 }] } } as MessageEvent<MessageSearchResponse>));
    expect(result.current).toEqual([]);
    const currentWorker = instances[1];
    rerender({ store: nextStore, open: false });
    expect(currentWorker.terminate).toHaveBeenCalledOnce();
    act(() => append(nextStore, 'after close'));
    expect(currentWorker.requests).toHaveLength(1);
    unmount();
    expect(currentWorker.terminate).toHaveBeenCalledOnce();
  });

  it('rebuilds a local cached index if the worker errors and keeps later searches usable', () => {
    const store = makeStore();
    const { result, rerender } = renderHook(({ query }) => useMessageSearch(store, true, query), {
      initialProps: { query: 'hit' },
    });
    const worker = instances[0];
    const preventDefault = vi.fn();
    act(() => worker.onerror?.({ preventDefault } as unknown as ErrorEvent));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(result.current).toEqual([{ messageId: 'm1', occurrenceIndex: 0 }]);
    act(() => append(store, 'second hit'));
    expect(result.current).toEqual([
      { messageId: 'm1', occurrenceIndex: 0 }, { messageId: 'm2', occurrenceIndex: 0 },
    ]);
    rerender({ query: 'second' });
    expect(result.current).toEqual([{ messageId: 'm2', occurrenceIndex: 0 }]);
    expect(instances).toHaveLength(1);
  });

  it('retains matching behavior if Worker construction is unavailable', () => {
    vi.stubGlobal('Worker', class { constructor() { throw new Error('unavailable'); } });
    const store = makeStore();
    const { result } = renderHook(() => useMessageSearch(store, true, 'ＨＩＴ'));
    expect(result.current).toEqual([{ messageId: 'm1', occurrenceIndex: 0 }]);
  });
});
