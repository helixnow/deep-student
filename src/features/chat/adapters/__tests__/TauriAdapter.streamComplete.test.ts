import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  handleBackendEventWithSequence,
  flushPendingBackendEvents,
  handleStreamComplete,
  handleStreamAbort,
} = vi.hoisted(() => ({
  handleBackendEventWithSequence: vi.fn(),
  flushPendingBackendEvents: vi.fn(),
  handleStreamComplete: vi.fn(() => Promise.resolve()),
  handleStreamAbort: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../core/middleware/eventBridge', () => ({
  handleBackendEventWithSequence,
  flushPendingBackendEvents,
  handleStreamComplete,
  handleStreamAbort,
  clearEventContext: vi.fn(),
  resetBridgeState: vi.fn(),
}));

vi.mock('../../core/middleware/autoSave', () => ({
  autoSave: {
    forceImmediateSave: vi.fn(() => Promise.resolve()),
    cleanup: vi.fn(),
  },
  streamingBlockSaver: {
    cleanup: vi.fn(),
  },
}));

import { ChatV2TauriAdapter } from '../TauriAdapter';
import { chunkBuffer } from '../../core/middleware/chunkBuffer';

function createStore() {
  return {
    sessionId: 'sess_test',
    currentStreamingMessageId: 'msg_test',
    messageMap: new Map([
      ['msg_test', { id: 'msg_test', role: 'assistant', blockIds: ['blk_test'] }],
    ]),
    blocks: new Map([
      ['blk_test', { id: 'blk_test', messageId: 'msg_test', type: 'content' }],
    ]),
    completeStream: vi.fn(),
    updateMessageMeta: vi.fn(),
  };
}

function createAutonomousStore() {
  let state: any = {
    sessionId: 'agent_test',
    sessionStatus: 'idle',
    currentStreamingMessageId: null,
    messageMap: new Map([
      ['msg_autonomous', {
        id: 'msg_autonomous',
        role: 'assistant',
        blockIds: [],
        timestamp: 100,
      }],
    ]),
    messageOrder: ['msg_autonomous'],
    chatParams: { modelId: 'model_test' },
    messageOperationLock: null,
  };
  const completeStream = vi.fn(() => {
    state = {
      ...state,
      sessionStatus: 'idle',
      currentStreamingMessageId: null,
    };
  });
  const updateMessageMeta = vi.fn((messageId: string, patch: Record<string, unknown>) => {
    const current = state.messageMap.get(messageId);
    state = {
      ...state,
      messageMap: new Map(state.messageMap).set(messageId, {
        ...current,
        _meta: { ...current?._meta, ...patch },
      }),
    };
  });
  const store = {
    completeStream,
    updateMessageMeta,
    setCurrentStreamingMessage: vi.fn((messageId: string | null) => {
      state = { ...state, currentStreamingMessageId: messageId };
    }),
  };
  const storeApi = {
    getState: () => state,
    setState: (patch: any) => {
      const next = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...next };
    },
  };
  return { store, storeApi, getState: () => state };
}

describe('ChatV2TauriAdapter stream_complete sequencing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('flushes buffered chunks before marking the stream complete', async () => {
    const store = createStore();
    const adapter = new ChatV2TauriAdapter('sess_test', store as any);
    const callOrder: string[] = [];
    const flushSpy = vi
      .spyOn(chunkBuffer, 'flushSession')
      .mockImplementation(() => {
        callOrder.push('flush');
      });

    store.completeStream.mockImplementation(() => {
      callOrder.push('complete');
    });

    (adapter as any).handleSessionEvent({
      sessionId: 'sess_test',
      eventType: 'stream_complete',
      messageId: 'msg_test',
      durationMs: 12,
    });

    await vi.runAllTimersAsync();

    expect(flushPendingBackendEvents).toHaveBeenCalledWith(store);
    expect(flushSpy).toHaveBeenCalledWith('sess_test');
    expect(store.completeStream).toHaveBeenCalledWith('success');
    expect(callOrder).toEqual(['flush', 'complete']);
  });

  it('keeps the stream open until late block-channel tail events have drained', async () => {
    const store = createStore();
    const adapter = new ChatV2TauriAdapter('sess_test', store as any);
    const callOrder: string[] = [];
    vi.spyOn(chunkBuffer, 'flushSession').mockImplementation(() => {
      callOrder.push('flush');
    });
    flushPendingBackendEvents.mockImplementation(() => {
      callOrder.push('drain');
    });
    handleBackendEventWithSequence.mockImplementation((_store, event) => {
      callOrder.push(`block:${event.phase}`);
    });
    store.completeStream.mockImplementation(() => {
      callOrder.push('complete');
    });

    // Session and block events are emitted on independent Tauri channels.
    // Reproduce the session terminal callback overtaking the block tail.
    (adapter as any).handleSessionEvent({
      sessionId: 'sess_test',
      eventType: 'stream_complete',
      messageId: 'msg_test',
      durationMs: 12,
      timestamp: 100,
    });

    expect(store.completeStream).not.toHaveBeenCalled();

    (adapter as any).handleBlockEvent({
      type: 'content',
      phase: 'chunk',
      blockId: 'blk_test',
      chunk: 'late tail',
      sequenceId: 2,
    });
    (adapter as any).handleBlockEvent({
      type: 'content',
      phase: 'end',
      blockId: 'blk_test',
      sequenceId: 3,
    });

    await vi.runAllTimersAsync();

    expect(callOrder).toEqual([
      'block:chunk',
      'block:end',
      'drain',
      'flush',
      'complete',
    ]);
    expect(handleStreamComplete).toHaveBeenCalledWith(
      store,
      expect.objectContaining({ messageId: 'msg_test' }),
    );
  });

  it.each([
    ['stream_error', 'error'],
    ['stream_cancelled', 'cancelled'],
  ] as const)('cancels pending success when %s supersedes it', async (eventType, reason) => {
    const store = createStore();
    const adapter = new ChatV2TauriAdapter('sess_test', store as any);

    (adapter as any).handleSessionEvent({
      sessionId: 'sess_test',
      eventType: 'stream_complete',
      messageId: 'msg_test',
      timestamp: 100,
    });
    (adapter as any).handleSessionEvent({
      sessionId: 'sess_test',
      eventType,
      messageId: 'msg_test',
      timestamp: 101,
      error: eventType === 'stream_error' ? 'connection failed' : undefined,
    });

    expect((adapter as any).pendingStreamCompletion).toBeNull();
    await vi.advanceTimersByTimeAsync(100);

    expect(store.completeStream).toHaveBeenCalledTimes(1);
    expect(store.completeStream).toHaveBeenCalledWith(reason);
    expect(store.completeStream).not.toHaveBeenCalledWith('success');
  });

  it('cancels pending success when a retry expectation begins', async () => {
    const store = createStore();
    const adapter = new ChatV2TauriAdapter('sess_test', store as any);

    (adapter as any).handleSessionEvent({
      sessionId: 'sess_test',
      eventType: 'stream_complete',
      messageId: 'msg_test',
      timestamp: 100,
    });
    (adapter as any).beginStreamExpectation('msg_retry');

    expect((adapter as any).pendingStreamCompletion).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    expect(store.completeStream).not.toHaveBeenCalled();
  });

  it('cancels pending success during adapter cleanup', async () => {
    const store = createStore();
    const adapter = new ChatV2TauriAdapter('sess_test', store as any);

    (adapter as any).handleSessionEvent({
      sessionId: 'sess_test',
      eventType: 'stream_complete',
      messageId: 'msg_test',
      timestamp: 100,
    });
    await adapter.cleanup();

    expect((adapter as any).pendingStreamCompletion).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    expect(store.completeStream).not.toHaveBeenCalled();
  });

  it('adopts an existing empty assistant for an autonomous stream and accepts its completion', async () => {
    const { store, storeApi, getState } = createAutonomousStore();
    const adapter = new ChatV2TauriAdapter('agent_test', store as any, storeApi as any);
    vi.spyOn(chunkBuffer, 'flushSession').mockImplementation(() => undefined);

    (adapter as any).handleSessionEvent({
      sessionId: 'agent_test',
      eventType: 'stream_start',
      messageId: 'msg_autonomous',
      timestamp: 101,
      modelId: 'model_runtime',
    });

    expect(getState().sessionStatus).toBe('streaming');
    expect(getState().currentStreamingMessageId).toBe('msg_autonomous');

    (adapter as any).handleSessionEvent({
      sessionId: 'agent_test',
      eventType: 'stream_complete',
      messageId: 'msg_autonomous',
      timestamp: 102,
    });

    await vi.runAllTimersAsync();

    expect(store.completeStream).toHaveBeenCalledWith('success');
    expect(handleStreamComplete).toHaveBeenCalledWith(
      store,
      expect.objectContaining({ messageId: 'msg_autonomous' }),
    );
  });

  it('rejects delayed terminal events from the previous generation of a same-ID retry', async () => {
    const { store, storeApi, getState } = createAutonomousStore();
    const adapter = new ChatV2TauriAdapter('agent_test', store as any, storeApi as any);
    vi.spyOn(chunkBuffer, 'flushSession').mockImplementation(() => undefined);

    (adapter as any).handleSessionEvent({
      sessionId: 'agent_test',
      eventType: 'stream_start',
      messageId: 'msg_autonomous',
      streamGeneration: 41,
      timestamp: 1_000,
    });
    (adapter as any).handleSessionEvent({
      sessionId: 'agent_test',
      eventType: 'stream_complete',
      messageId: 'msg_autonomous',
      streamGeneration: 41,
      timestamp: 1_010,
    });
    await vi.runAllTimersAsync();
    expect(store.completeStream).toHaveBeenCalledTimes(1);

    // retryMessage reuses the assistant message ID and creates an expectation
    // before the backend's new stream_start arrives.
    (adapter as any).beginStreamExpectation('msg_autonomous');
    storeApi.setState({
      sessionStatus: 'streaming',
      currentStreamingMessageId: 'msg_autonomous',
    });

    (adapter as any).handleSessionEvent({
      sessionId: 'agent_test',
      eventType: 'stream_cancelled',
      messageId: 'msg_autonomous',
      streamGeneration: 41,
      timestamp: Date.now() - 50,
    });
    expect(store.completeStream).toHaveBeenCalledTimes(1);
    expect(getState().sessionStatus).toBe('streaming');

    (adapter as any).handleSessionEvent({
      sessionId: 'agent_test',
      eventType: 'stream_start',
      messageId: 'msg_autonomous',
      streamGeneration: 42,
      timestamp: Date.now(),
    });
    (adapter as any).handleSessionEvent({
      sessionId: 'agent_test',
      eventType: 'stream_complete',
      messageId: 'msg_autonomous',
      streamGeneration: 41,
      timestamp: Date.now() + 1,
    });
    expect(store.completeStream).toHaveBeenCalledTimes(1);

    (adapter as any).handleSessionEvent({
      sessionId: 'agent_test',
      eventType: 'stream_complete',
      messageId: 'msg_autonomous',
      streamGeneration: 42,
      timestamp: Date.now() + 2,
    });
    await vi.runAllTimersAsync();
    expect(store.completeStream).toHaveBeenCalledTimes(2);
  });
});
