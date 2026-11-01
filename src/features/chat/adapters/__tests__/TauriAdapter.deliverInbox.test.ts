import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

const { showGlobalNotification } = vi.hoisted(() => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification }));

import { ChatV2TauriAdapter } from '../TauriAdapter';

const invokeMock = vi.mocked(invoke);

function createAdapter() {
  const state = {
    sessionId: 'sess_super',
    sessionStatus: 'streaming',
    currentStreamingMessageId: 'msg_assistant',
    messageMap: new Map(),
    messageOrder: [],
    blocks: new Map(),
    chatParams: { modelId: 'model_test' },
  };
  const store = { ...state, setCurrentStreamingMessage: vi.fn() };
  const adapter = new ChatV2TauriAdapter('sess_super', store as any, { getState: () => state } as any);
  vi.spyOn(adapter as any, 'ensureModelMetadataReady').mockResolvedValue(undefined);
  const buildSendOptions = vi
    .spyOn(adapter as any, 'buildSendOptions')
    .mockResolvedValue({ modelId: 'model_test', enableThinking: true });
  vi.spyOn(adapter as any, 'applyRuntimeModelSelection').mockResolvedValue({
    modelId: 'model_test',
    effectiveModelId: 'model_test',
    modelDisplayName: 'model_test',
  });
  const clearStreamExpectation = vi.spyOn(adapter as any, 'clearStreamExpectation');
  return { adapter, store, buildSendOptions, clearStreamExpectation };
}

describe('ChatV2TauriAdapter.executeDeliverInbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('invokes chat_v2_super_deliver_inbox with the shared send options', async () => {
    const { adapter, buildSendOptions } = createAdapter();
    const outcome = {
      status: 'started',
      userMessage: { id: 'msg_user', content: 'x', timestampMs: 1, inboundOrigin: {} },
      assistantMessageId: 'msg_assistant',
    };
    invokeMock.mockResolvedValueOnce(outcome);

    const result = await (adapter as any).executeDeliverInbox('msg_user', 'msg_assistant', true);

    expect(result).toEqual(outcome);
    expect(buildSendOptions).toHaveBeenCalledWith(
      expect.objectContaining({ pendingContextRefs: [] }),
    );
    expect(invokeMock).toHaveBeenCalledWith('chat_v2_super_deliver_inbox', {
      request: {
        sessionId: 'sess_super',
        userMessageId: 'msg_user',
        assistantMessageId: 'msg_assistant',
        options: { modelId: 'model_test', enableThinking: true },
        force: true,
      },
    });
  });

  it('clears the stream expectation for non-started outcomes without notifying', async () => {
    const { adapter, clearStreamExpectation } = createAdapter();
    invokeMock.mockResolvedValueOnce({ status: 'empty' });

    const result = await (adapter as any).executeDeliverInbox('msg_user', 'msg_assistant', false);

    expect(result).toEqual({ status: 'empty' });
    expect(clearStreamExpectation).toHaveBeenCalledWith('msg_assistant');
    expect(showGlobalNotification).not.toHaveBeenCalled();
  });

  it('maps an active-stream conflict to busy', async () => {
    const { adapter, clearStreamExpectation } = createAdapter();
    invokeMock.mockRejectedValueOnce(
      new Error('Session has an active stream. Please wait for completion or cancel first.'),
    );

    const result = await (adapter as any).executeDeliverInbox('msg_user', 'msg_assistant', false);

    expect(result).toEqual({ status: 'busy' });
    expect(clearStreamExpectation).toHaveBeenCalledWith('msg_assistant');
  });

  it('rethrows other backend errors after clearing the expectation', async () => {
    const { adapter, clearStreamExpectation } = createAdapter();
    invokeMock.mockRejectedValueOnce(new Error('session not writable'));

    await expect(
      (adapter as any).executeDeliverInbox('msg_user', 'msg_assistant', false),
    ).rejects.toThrow('session not writable');
    expect(clearStreamExpectation).toHaveBeenCalledWith('msg_assistant');
  });
});
