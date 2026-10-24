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
  registerBridgeStoreResolver: vi.fn(() => () => undefined),
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
  clearAdapterErrorFlag,
  getAdapterErrorFlag,
} from '../errors/adapterErrorChannel';

function createStreamingStore() {
  let state: any = {
    sessionId: 'sess_err',
    sessionStatus: 'streaming',
    currentStreamingMessageId: 'msg_err',
    isDataLoaded: true,
    messageMap: new Map([
      ['msg_err', { id: 'msg_err', role: 'assistant', blockIds: [], _meta: {} }],
    ]),
    messageOrder: ['msg_err'],
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
    sessionId: 'sess_err',
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
    setWakeSessionCallback: vi.fn(),
    setAbortCallback: vi.fn(),
    setContinueMessageCallback: vi.fn(),
    setLoadCallback: vi.fn(),
    setLoadEarlierMessagesCallback: vi.fn(),
    setSwitchVariantCallback: vi.fn(),
    setDeleteVariantCallback: vi.fn(),
    setRetryVariantCallback: vi.fn(),
    setRetryAllVariantsCallback: vi.fn(),
    setCancelVariantCallback: vi.fn(),
    setUpdateBlockContentCallback: vi.fn(),
    setUpdateSessionSettingsCallback: vi.fn(),
    abortStream: vi.fn(() => Promise.reject(new Error('abort ipc failed'))),
    forceResetToIdle: vi.fn(),
    initSession: vi.fn(),
  };

  const setState = vi.fn((patch: any) => {
    const next = typeof patch === 'function' ? patch(state) : patch;
    state = { ...state, ...next };
  });

  const storeApi = {
    getState: () => state,
    setState,
  };

  return { store, storeApi, getState: () => state };
}

describe('ChatV2TauriAdapter error channel surfacing', () => {
  it('surfaces automatic compaction progress and notifies after the summary is committed', () => {
    const { store, storeApi, getState } = createStreamingStore();
    const setCompactionInProgress = vi.fn((active: boolean) => storeApi.setState({ compactionInProgress: active }));
    const setContextUsageOverride = vi.fn();
    Object.assign(store, { setCompactionInProgress, setContextUsageOverride });
    const adapter = new ChatV2TauriAdapter('sess_err', store as any, storeApi as any);
    const start = { sessionId: 'sess_err', eventType: 'compaction_started', timestamp: Date.now(), payload: { reason: 'auto' } };
    (adapter as any).handleSessionEvent(start);
    (adapter as any).handleSessionEvent(start);
    expect(getState().compactionInProgress).toBe(true);
    expect(showGlobalNotification).toHaveBeenCalledTimes(1);
    (adapter as any).handleSessionEvent({ sessionId: 'sess_err', eventType: 'compaction_finished', timestamp: Date.now() });
    expect(getState().compactionInProgress).toBe(false);
    (adapter as any).handleSessionEvent({ sessionId: 'sess_err', eventType: 'compaction_completed', timestamp: Date.now(), payload: { tokensBefore: 200_000, tokensAfter: 40_000 } });
    expect(setContextUsageOverride).toHaveBeenCalledWith({ sessionId: 'sess_err', tokensAfter: 40_000 });
    expect(showGlobalNotification).toHaveBeenLastCalledWith('success', expect.any(String), expect.any(String));
  });

  it('clears automatic compaction progress on failure without a success notification', () => {
    const { store, storeApi, getState } = createStreamingStore();
    const setCompactionInProgress = vi.fn((active: boolean) => storeApi.setState({ compactionInProgress: active }));
    Object.assign(store, { setCompactionInProgress });
    const adapter = new ChatV2TauriAdapter('sess_err', store as any, storeApi as any);
    (adapter as any).handleSessionEvent({ sessionId: 'sess_err', eventType: 'compaction_started', timestamp: Date.now() });
    (adapter as any).handleSessionEvent({ sessionId: 'sess_err', eventType: 'compaction_failed', timestamp: Date.now(), payload: { reason: 'summaryFailed' } });
    expect(getState().compactionInProgress).toBe(false);
    expect(showGlobalNotification.mock.calls.some(([type]) => type === 'success')).toBe(false);
    expect(showGlobalNotification).toHaveBeenLastCalledWith('warning', expect.any(String), expect.any(String));
  });

  it('preserves the context-overflow code as a localized error with an actionable model picker', () => {
    const { store, storeApi, getState } = createStreamingStore();
    getState().setModelRetryTarget = vi.fn();
    getState().setPanelState = vi.fn();
    const adapter = new ChatV2TauriAdapter('sess_err', store as any, storeApi as any);
    (adapter as any).handleSessionEvent({ sessionId: 'sess_err', eventType: 'stream_error', messageId: 'msg_err', timestamp: Date.now(), error: 'budget failure', payload: { code: 'CONTEXT_WINDOW_EXCEEDED' } });
    expect(showGlobalNotification).toHaveBeenCalledWith('error', expect.stringMatching(/context|上下文/i), expect.any(String), expect.objectContaining({ action: expect.any(Object) }));
    const action = showGlobalNotification.mock.calls.at(-1)![3].action;
    action.onClick();
    expect(getState().setModelRetryTarget).toHaveBeenCalledWith('msg_err');
    expect(getState().setPanelState).toHaveBeenCalledWith('model', true);
    expect(store.completeStream).toHaveBeenCalledWith('error', expect.stringMatching(/context|上下文/i));
  });
  beforeEach(() => {
    vi.clearAllMocks();
    clearAdapterErrorFlag('sess_err');
    (window as any).__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    clearAdapterErrorFlag('sess_err');
    delete (window as any).__TAURI_INTERNALS__;
  });

  it('surfaces stream_error as a user-visible notification and store flag', () => {
    const { store, storeApi, getState } = createStreamingStore();
    const adapter = new ChatV2TauriAdapter('sess_err', store as any, storeApi as any);

    (adapter as any).handleSessionEvent({
      sessionId: 'sess_err',
      eventType: 'stream_error',
      messageId: 'msg_err',
      timestamp: Date.now(),
      error: 'upstream stream setup failed',
    });

    expect(store.completeStream).toHaveBeenCalledWith(
      'error',
      expect.stringMatching(/upstream stream setup failed/i),
    );
    expect(showGlobalNotification).toHaveBeenCalledWith(
      'error',
      expect.stringMatching(/upstream stream setup failed|Load failed|加载失败/i),
      expect.any(String),
      undefined,
    );

    const flag = getAdapterErrorFlag('sess_err');
    expect(flag).toMatchObject({
      code: 'stream_error',
      sessionId: 'sess_err',
      retryable: false,
    });
    expect(storeApi.setState).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterError: expect.objectContaining({ code: 'stream_error' }),
      }),
    );
    expect(getState().messageMap.get('msg_err')?._meta?.terminalError).toBeTruthy();
  });

  it('surfaces save_error via notification instead of silent console-only failure', () => {
    const { store, storeApi } = createStreamingStore();
    const adapter = new ChatV2TauriAdapter('sess_err', store as any, storeApi as any);

    (adapter as any).handleSessionEvent({
      sessionId: 'sess_err',
      eventType: 'save_error',
      error: 'disk full',
    });

    expect(showGlobalNotification).toHaveBeenCalledWith(
      'error',
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        action: expect.objectContaining({ onClick: expect.any(Function) }),
      }),
    );
    expect(getAdapterErrorFlag('sess_err')).toMatchObject({
      code: 'session_save_failed',
      retryable: true,
    });
  });

  it('surfaces listener setup failure through the error channel with retry action', async () => {
    const { store, storeApi } = createStreamingStore();
    const adapter = new ChatV2TauriAdapter('sess_err', store as any, storeApi as any);

    vi.spyOn(adapter as any, 'registerEventListenersWithRollback').mockRejectedValue(
      new Error('stream setup failed'),
    );

    await expect(adapter.setup()).rejects.toThrow(/stream setup failed/);

    expect(showGlobalNotification).toHaveBeenCalledWith(
      'error',
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        action: expect.objectContaining({
          label: expect.any(String),
          onClick: expect.any(Function),
        }),
      }),
    );
    expect(getAdapterErrorFlag('sess_err')).toMatchObject({
      code: 'listener_registration_failed',
      retryable: true,
      causeMessage: 'stream setup failed',
    });
    expect(adapter.getListenerRegistrationError()?.message).toBe('stream setup failed');
  });

  it('surfaces abortStream failure as a user-visible recovery notice', async () => {
    const { store, storeApi } = createStreamingStore();
    const adapter = new ChatV2TauriAdapter('sess_err', store as any, storeApi as any);

    await expect(adapter.abortStream()).rejects.toThrow(/abort ipc failed/);

    expect(store.forceResetToIdle).toHaveBeenCalled();
    expect(showGlobalNotification).toHaveBeenCalledWith(
      'error',
      expect.any(String),
      expect.any(String),
      undefined,
    );
    expect(getAdapterErrorFlag('sess_err')).toMatchObject({
      code: 'abort_failed',
      retryable: false,
    });
  });
});
