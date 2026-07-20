import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  handleBackendEventWithSequence,
  flushPendingBackendEvents,
  handleStreamComplete,
  handleStreamAbort,
  showGlobalNotification,
} = vi.hoisted(() => ({
  handleBackendEventWithSequence: vi.fn(),
  flushPendingBackendEvents: vi.fn(),
  handleStreamComplete: vi.fn(() => Promise.resolve()),
  handleStreamAbort: vi.fn(() => Promise.resolve()),
  showGlobalNotification: vi.fn(),
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
    registerSaveCallback: vi.fn(() => () => {}),
  },
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification,
}));

import { ChatV2TauriAdapter } from '../TauriAdapter';
import {
  buildStreamReconnectMeta,
  clearStreamReconnectMetaPatch,
} from '../tauri/streamLifecycle';
import { chunkBuffer } from '../../core/middleware/chunkBuffer';
import { formatStreamReconnectMessage } from '../streamReconnectNotification';

function createStreamingStore() {
  let state: any = {
    sessionId: 'sess_reconnect',
    sessionStatus: 'streaming',
    currentStreamingMessageId: 'msg_reconnect',
    isDataLoaded: true,
    messageMap: new Map([
      ['msg_reconnect', { id: 'msg_reconnect', role: 'assistant', blockIds: [], _meta: {} }],
    ]),
    messageOrder: ['msg_reconnect'],
    blocks: new Map(),
    chatParams: { modelId: 'model_test' },
  };

  const completeStream = vi.fn(() => {
    state = { ...state, sessionStatus: 'idle', currentStreamingMessageId: null };
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
    sessionId: 'sess_reconnect',
    isDataLoaded: true,
    completeStream,
    updateMessageMeta,
    setCurrentStreamingMessage: vi.fn(),
    setPendingParallelModelIds: vi.fn(),
    setSaveCallback: vi.fn(),
    setRetryCallback: vi.fn(),
    setDeleteCallback: vi.fn(),
    setEditAndResendCallback: vi.fn(),
    setSendCallback: vi.fn(),
    setAbortCallback: vi.fn(),
    setContinueMessageCallback: vi.fn(),
    setLoadCallback: vi.fn(),
    setSwitchVariantCallback: vi.fn(),
    setDeleteVariantCallback: vi.fn(),
    setRetryVariantCallback: vi.fn(),
    setRetryAllVariantsCallback: vi.fn(),
    setCancelVariantCallback: vi.fn(),
    setUpdateBlockContentCallback: vi.fn(),
    setUpdateSessionSettingsCallback: vi.fn(),
    forceResetToIdle: vi.fn(),
    initSession: vi.fn(),
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

describe('ChatV2TauriAdapter stream_reconnect behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.spyOn(chunkBuffer, 'flushSession').mockImplementation(() => undefined);
  });

  afterEach(() => {
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('buildStreamReconnectMeta defaults attempt/max without mutating caller payload', () => {
    expect(buildStreamReconnectMeta({})).toEqual({ retryAttempt: 1, retryMax: 5 });
    expect(buildStreamReconnectMeta({ retryAttempt: 3, retryMax: 8 })).toEqual({
      retryAttempt: 3,
      retryMax: 8,
    });
  });

  it('stores reconnect progress on the current assistant message instead of showing a reconnect toast', () => {
    const { store, storeApi, getState } = createStreamingStore();
    const adapter = new ChatV2TauriAdapter('sess_reconnect', store as any, storeApi as any);

    (adapter as any).handleSessionEvent({
      sessionId: 'sess_reconnect',
      eventType: 'stream_reconnect',
      messageId: 'msg_reconnect',
      timestamp: Date.now(),
      retryAttempt: 2,
      retryMax: 5,
    });

    expect(store.updateMessageMeta).toHaveBeenCalledWith('msg_reconnect', {
      streamReconnect: { retryAttempt: 2, retryMax: 5 },
    });
    expect(getState().messageMap.get('msg_reconnect')?._meta?.streamReconnect).toEqual({
      retryAttempt: 2,
      retryMax: 5,
    });

    // Inline meta only — no toast path (notifyStreamReconnect / formatStreamReconnectMessage).
    expect(showGlobalNotification).not.toHaveBeenCalled();
    expect(showGlobalNotification).not.toHaveBeenCalledWith(
      'info',
      formatStreamReconnectMessage({ retryAttempt: 2, retryMax: 5 }),
      undefined,
      expect.anything(),
    );
  });

  it.each([
    ['stream_complete', undefined],
    ['stream_error', 'connection failed'],
    ['stream_cancelled', undefined],
  ] as const)('clears reconnect state when %s finishes the stream', async (eventType, error) => {
    const { store, storeApi, getState } = createStreamingStore();
    const adapter = new ChatV2TauriAdapter('sess_reconnect', store as any, storeApi as any);

    (adapter as any).handleSessionEvent({
      sessionId: 'sess_reconnect',
      eventType: 'stream_reconnect',
      messageId: 'msg_reconnect',
      timestamp: 100,
      retryAttempt: 1,
      retryMax: 5,
    });
    expect(getState().messageMap.get('msg_reconnect')?._meta?.streamReconnect).toBeTruthy();

    (adapter as any).handleSessionEvent({
      sessionId: 'sess_reconnect',
      eventType,
      messageId: 'msg_reconnect',
      timestamp: 101,
      error,
    });

    if (eventType === 'stream_complete') {
      await vi.runAllTimersAsync();
      expect(store.updateMessageMeta).toHaveBeenCalledWith(
        'msg_reconnect',
        clearStreamReconnectMetaPatch({ clearTerminalError: true }),
      );
    } else {
      expect(getState().messageMap.get('msg_reconnect')?._meta?.streamReconnect).toBeUndefined();
    }
  });
});
