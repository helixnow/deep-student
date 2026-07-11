import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  handleStreamComplete,
  handleStreamAbort,
} = vi.hoisted(() => ({
  handleStreamComplete: vi.fn(() => Promise.resolve()),
  handleStreamAbort: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../core/middleware/eventBridge', () => ({
  handleBackendEventWithSequence: vi.fn(),
  handleStreamComplete,
  handleStreamAbort,
  clearEventContext: vi.fn(),
  resetBridgeState: vi.fn(),
}));

vi.mock('../../core/middleware/autoSave', () => ({
  autoSave: {
    forceImmediateSave: vi.fn(() => Promise.resolve()),
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
  });

  it('flushes buffered chunks before marking the stream complete', () => {
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

    expect(flushSpy).toHaveBeenCalledWith('sess_test');
    expect(store.completeStream).toHaveBeenCalledWith('success');
    expect(callOrder).toEqual(['flush', 'complete']);
  });

  it('adopts an existing empty assistant for an autonomous stream and accepts its completion', () => {
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

    expect(store.completeStream).toHaveBeenCalledWith('success');
    expect(handleStreamComplete).toHaveBeenCalledWith(
      store,
      expect.objectContaining({ messageId: 'msg_autonomous' }),
    );
  });

  it('rejects delayed terminal events from the previous generation of a same-ID retry', () => {
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
    expect(store.completeStream).toHaveBeenCalledTimes(2);
  });
});
