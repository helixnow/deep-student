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
});
