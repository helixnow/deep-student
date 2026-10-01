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
    const { result } = renderHook(() => useMessageSearch(store, true, 'hit'));
    act(() => store.setState({ messageOrder: ['m2'] }));
    expect(instances[0].requests).toHaveLength(1);
    act(() => instances[0].respond(instances[0].requests[0], [{ messageId: 'm1', occurrenceIndex: 0 }]));
    expect(result.current).toEqual([]);
    const update = instances[0].requests[1];
    expect(update.messages).toEqual([{ messageId: 'm2', blockIds: ['b2'] }]);
    expect(update.removedBlockIds).toEqual(['b1']);
    expect(update.blocks).toEqual([]);
  });

  it('coalesces an in-flight burst into the latest query and store delta', () => {
    const store = makeStore();
    const { result, rerender } = renderHook(({ query }) => useMessageSearch(store, true, query), {
      initialProps: { query: 'hit' },
    });
    const worker = instances[0];
    const getState = vi.spyOn(store, 'getState');
    for (let i = 0; i < 20; i += 1) {
      act(() => store.setState((state) => ({
        blocks: new Map(state.blocks).set('b2', { ...state.blocks.get('b2')!, content: `latest ${i}` }),
      })));
    }
    rerender({ query: 'intermediate' });
    rerender({ query: 'latest' });
    // No text snapshots are collected or queued while the worker is occupied.
    expect(getState).not.toHaveBeenCalled();
    expect(worker.requests).toHaveLength(1);

    act(() => worker.respond(worker.requests[0], [{ messageId: 'm1', occurrenceIndex: 0 }]));
    expect(result.current).toEqual([]);
    expect(getState).toHaveBeenCalledOnce();
    expect(worker.requests).toHaveLength(2);
    const latest = worker.requests[1];
    expect(latest.query).toBe('latest');
    expect(latest.blocks).toEqual([{ id: 'b2', content: 'latest 19' }]);
    expect(latest.messages).toBeUndefined();

    act(() => worker.respond(latest, [{ messageId: 'm2', occurrenceIndex: 0 }]));
    expect(result.current).toEqual([{ messageId: 'm2', occurrenceIndex: 0 }]);
    expect(worker.requests).toHaveLength(2);
  });

  it('keeps a valid reply when pending changes did not change searchable text', () => {
    const store = makeStore();
    const { result } = renderHook(() => useMessageSearch(store, true, 'hit'));
    const worker = instances[0];
    act(() => store.setState((state) => ({
      blocks: new Map(state.blocks).set('b2', { ...state.blocks.get('b2')!, status: 'success' }),
    })));
    act(() => worker.respond(worker.requests[0], [{ messageId: 'm1', occurrenceIndex: 0 }]));
    expect(worker.requests).toHaveLength(1);
    expect(result.current).toEqual([{ messageId: 'm1', occurrenceIndex: 0 }]);
  });

  it('does not reuse an in-flight reply after a query is cleared and restored', () => {
    const store = makeStore();
    const { result, rerender } = renderHook(({ query }) => useMessageSearch(store, true, query), {
      initialProps: { query: 'hit' },
    });
    const worker = instances[0];
    rerender({ query: '' });
    act(() => append(store, 'second hit'));
    rerender({ query: 'hit' });
    expect(worker.requests).toHaveLength(1);
    act(() => worker.respond(worker.requests[0], [{ messageId: 'm1', occurrenceIndex: 0 }]));
    expect(result.current).toEqual([]);
    expect(worker.requests).toHaveLength(2);
    expect(worker.requests[1].blocks).toEqual([{ id: 'b2', content: 'second hit' }]);
    act(() => worker.respond(worker.requests[1], [
      { messageId: 'm1', occurrenceIndex: 0 }, { messageId: 'm2', occurrenceIndex: 0 },
    ]));
    expect(result.current).toHaveLength(2);
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

  it('stops search while suspended and rebuilds the current query from the latest store on resume', () => {
    const store = makeStore();
    const { result, rerender } = renderHook(
      ({ query, suspended }) => useMessageSearch(store, true, query, suspended),
      { initialProps: { query: 'hit', suspended: false } },
    );
    const oldWorker = instances[0];
    const lateMessage = oldWorker.onmessage!;
    act(() => oldWorker.respond(oldWorker.requests[0], [{ messageId: 'm1', occurrenceIndex: 0 }]));
    rerender({ query: 'hit', suspended: true });
    expect(result.current).toEqual([]);
    expect(oldWorker.terminate).toHaveBeenCalledOnce();
    for (let i = 0; i < 10; i += 1) act(() => append(store, `latest ${i}`));
    rerender({ query: 'latest', suspended: true });
    expect(instances).toHaveLength(1);
    expect(oldWorker.requests).toHaveLength(1);
    act(() => lateMessage({ data: { requestId: 1, matches: [{ messageId: 'stale', occurrenceIndex: 0 }] } } as MessageEvent<MessageSearchResponse>));
    expect(result.current).toEqual([]);

    rerender({ query: 'latest', suspended: false });
    const resumedWorker = instances[1];
    expect(resumedWorker.requests).toHaveLength(1);
    expect(resumedWorker.requests[0].query).toBe('latest');
    expect(resumedWorker.requests[0].messages).toHaveLength(2);
    expect(resumedWorker.requests[0].blocks).toEqual([
      { id: 'b1', content: 'first hit' }, { id: 'b2', content: 'latest 9' },
    ]);
    act(() => resumedWorker.respond(resumedWorker.requests[0], [{ messageId: 'm2', occurrenceIndex: 0 }]));
    expect(result.current).toEqual([{ messageId: 'm2', occurrenceIndex: 0 }]);
  });

  it('does not create a worker when initially suspended', () => {
    const store = makeStore();
    const { rerender } = renderHook(
      ({ suspended }) => useMessageSearch(store, true, 'hit', suspended),
      { initialProps: { suspended: true } },
    );
    act(() => append(store, 'second hit'));
    expect(instances).toHaveLength(0);
    rerender({ suspended: false });
    expect(instances).toHaveLength(1);
    expect(instances[0].requests[0].blocks).toContainEqual({ id: 'b2', content: 'second hit' });
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

  it('rebuilds fallback from queued changes when an in-flight request fails', () => {
    const store = makeStore();
    const { result, rerender } = renderHook(({ query }) => useMessageSearch(store, true, query), {
      initialProps: { query: 'hit' },
    });
    const worker = instances[0];
    act(() => append(store, 'second latest'));
    rerender({ query: 'latest' });
    act(() => worker.onmessage?.({
      data: { requestId: worker.requests[0].requestId, error: 'worker failed' },
    } as MessageEvent<MessageSearchResponse>));
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(result.current).toEqual([{ messageId: 'm2', occurrenceIndex: 0 }]);
    expect(instances).toHaveLength(1);
  });

  it('does not overwrite latest fallback results with the reply that released the worker', () => {
    const store = makeStore();
    const { result } = renderHook(() => useMessageSearch(store, true, 'hit'));
    const worker = instances[0];
    act(() => append(store, 'second hit'));
    vi.spyOn(worker, 'postMessage').mockImplementationOnce(() => { throw new Error('post failed'); });
    act(() => worker.respond(worker.requests[0], [{ messageId: 'm1', occurrenceIndex: 0 }]));
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(result.current).toEqual([
      { messageId: 'm1', occurrenceIndex: 0 }, { messageId: 'm2', occurrenceIndex: 0 },
    ]);
  });
});
