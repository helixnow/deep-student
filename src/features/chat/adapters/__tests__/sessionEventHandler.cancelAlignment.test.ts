import { describe, expect, it, vi } from 'vitest';

const { align } = vi.hoisted(() => ({ align: vi.fn(() => Promise.resolve(0)) }));
vi.mock('../tauri/cancelAlignment', () => ({ alignCancelledMessageWithArchive: align }));
vi.mock('../../core/middleware/eventBridge', () => ({ handleStreamAbort: vi.fn(() => Promise.resolve()) }));

import { handleSessionEvent } from '../tauri/sessionEventHandler';
import type { TauriAdapterHost } from '../tauri/adapterHost';

function host(currentStreamingMessageId: string | null) {
  const store = {
    sessionId: 's1',
    currentStreamingMessageId,
    completeStream: vi.fn(),
    updateMessageMeta: vi.fn(),
    setPendingParallelModelIds: vi.fn(),
  };
  return {
    sessionId: 's1',
    store,
    streamExpectation: null,
    lastStreamGenerationByMessageId: new Map(),
    isSessionRuntimeOwner: () => true,
    getCurrentState: () => store,
    cancelPendingStreamCompletion: vi.fn(),
    clearStreamExpectation: vi.fn(),
    getErrorStoreApi: () => undefined,
  } as unknown as TauriAdapterHost;
}

describe('stream_cancelled aligns the message with its archive', () => {
  it('aligns the cancelled message after resetting the stream', () => {
    const h = host('m2');
    handleSessionEvent(h, { sessionId: 's1', eventType: 'stream_cancelled', messageId: 'm2', timestamp: Date.now() } as never);
    expect(h.store.completeStream).toHaveBeenCalledWith('cancelled');
    expect(align).toHaveBeenCalledWith(h, 'm2');
  });

  it('does not touch messages from stale cancellations', () => {
    align.mockClear();
    handleSessionEvent(host('m3'), { sessionId: 's1', eventType: 'stream_cancelled', messageId: 'm2', timestamp: Date.now() } as never);
    expect(align).not.toHaveBeenCalled();
  });
});
