import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

const { showGlobalNotification } = vi.hoisted(() => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification }));

import { ChatV2TauriAdapter } from '../TauriAdapter';

const invokeMock = vi.mocked(invoke);

function createStore() {
  const state = {
    sessionId: 'sess_hmr',
    sessionStatus: 'idle',
    currentStreamingMessageId: null,
    messageMap: new Map(),
    messageOrder: [],
    blocks: new Map(),
    chatParams: { modelId: 'model_test' },
  };
  const store = {
    ...state,
    sendMessageWithIds: vi.fn(),
    abortStream: vi.fn(),
  };
  return {
    store,
    storeApi: { getState: () => state },
  };
}

describe('ChatV2TauriAdapter active stream conflict', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeMock.mockResolvedValue(true);
  });

  it('does not create or abort a turn when HMR lost the backend stream state', async () => {
    const { store, storeApi } = createStore();
    const adapter = new ChatV2TauriAdapter('sess_hmr', store as any, storeApi as any);

    await expect(
      (adapter as any).executeSendMessage('new message', undefined, 'msg_user', 'msg_assistant'),
    ).rejects.toThrow(/active stream/i);

    expect(invokeMock).toHaveBeenCalledWith('chat_v2_has_active_stream', {
      sessionId: 'sess_hmr',
    });
    expect(store.sendMessageWithIds).not.toHaveBeenCalled();
    expect(store.abortStream).not.toHaveBeenCalled();
    expect(showGlobalNotification).toHaveBeenCalledTimes(1);
  });

  it('does not abort the existing stream when atomic registration wins the race', async () => {
    const { store, storeApi } = createStore();
    const adapter = new ChatV2TauriAdapter('sess_hmr', store as any, storeApi as any);
    vi.spyOn(adapter as any, 'ensureModelMetadataReady').mockResolvedValue(undefined);
    vi.spyOn(adapter as any, 'buildSendOptions').mockResolvedValue({ modelId: 'model_test' });
    vi.spyOn(adapter as any, 'applyRuntimeModelSelection').mockResolvedValue({
      modelId: 'model_test',
      effectiveModelId: 'model_test',
      modelDisplayName: 'model_test',
    });
    invokeMock
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(
        new Error('Session has an active stream. Please wait for completion or cancel first.'),
      );

    await expect(
      (adapter as any).executeSendMessage('new message', undefined, 'msg_user', 'msg_assistant'),
    ).rejects.toThrow(/active stream/i);

    expect(store.sendMessageWithIds).toHaveBeenCalledTimes(1);
    expect(store.abortStream).not.toHaveBeenCalled();
    expect(showGlobalNotification).toHaveBeenCalledTimes(1);
  });
});
