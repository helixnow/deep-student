import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatStore } from '../../../core/types';
import { resetTransientRuntimes } from '../../../core/store/transientRuntimeRegistry';

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('@/debug-panel/plugins/ToolCallLifecycleDebugPlugin', () => ({
  emitToolCallDebug: vi.fn(),
  trackStart: vi.fn(),
  trackEnd: vi.fn(),
}));

vi.mock('@/features/workbench', () => ({
  workbenchBus: { activate: vi.fn() },
}));

vi.mock('i18next', () => ({
  default: { t: (key: string) => key },
}));

vi.mock('../../../registry/eventRegistry', () => ({
  eventRegistry: { register: vi.fn() },
}));

import { approvalEventHandler } from '../approval';

function createStoreHarness() {
  let store: ChatStore;
  const setPendingApproval = vi.fn((request: Record<string, unknown> | null) => {
    store.pendingBlockingInteraction = request
      ? { kind: 'tool_approval', ...request } as ChatStore['pendingBlockingInteraction']
      : null;
  });
  const clearPendingApproval = vi.fn(() => {
    store.pendingBlockingInteraction = null;
  });
  store = {
    sessionId: 'session-1',
    pendingBlockingInteraction: null,
    setPendingApproval,
    clearPendingApproval,
  } as unknown as ChatStore;
  return { store, setPendingApproval, clearPendingApproval };
}

function request(toolCallId: string) {
  return {
    toolCallId,
    toolName: 'builtin-test',
    arguments: {},
    sensitivity: 'high',
    permissionPreset: 'relaxed',
    description: 'test',
    timeoutSeconds: 30,
  };
}

describe('approval event queue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('deduplicates repeated starts by toolCallId', () => {
    const { store, setPendingApproval } = createStoreHarness();

    approvalEventHandler.onStart(store, 'message-1', request('call-1'));
    approvalEventHandler.onStart(store, 'message-1', request('call-1'));

    expect(setPendingApproval).toHaveBeenCalledTimes(1);
  });

  it('removes a queued approval when its terminal event arrives', () => {
    const { store, setPendingApproval } = createStoreHarness();

    approvalEventHandler.onStart(store, 'message-1', request('call-1'));
    approvalEventHandler.onStart(store, 'message-1', request('call-2'));
    approvalEventHandler.onEnd(store, 'approval_call-2', {
      toolCallId: 'call-2',
      approved: false,
    });
    approvalEventHandler.onEnd(store, 'approval_call-1', {
      toolCallId: 'call-1',
      approved: true,
    });
    vi.advanceTimersByTime(1000);

    expect(setPendingApproval).toHaveBeenCalledTimes(2);
    expect(store.pendingBlockingInteraction).toBeNull();
  });

  it('does not surface terminal or expired start payloads', () => {
    const { store, setPendingApproval } = createStoreHarness();

    approvalEventHandler.onStart(store, 'message-1', {
      ...request('call-terminal'),
      status: 'completed',
    });
    approvalEventHandler.onStart(store, 'message-1', {
      ...request('call-expired'),
      expiresAt: Date.now() - 1,
    });

    expect(setPendingApproval).not.toHaveBeenCalled();
  });

  it('cancels queue timers and queued work when the store runtime resets', () => {
    const { store, setPendingApproval, clearPendingApproval } = createStoreHarness();

    approvalEventHandler.onStart(store, 'message-1', request('call-1'));
    approvalEventHandler.onStart(store, 'message-1', request('call-2'));
    approvalEventHandler.onEnd(store, 'approval_call-1', {
      toolCallId: 'call-1',
      approved: true,
    });

    resetTransientRuntimes(store.setPendingApproval);
    vi.advanceTimersByTime(1000);

    expect(clearPendingApproval).not.toHaveBeenCalled();
    expect(setPendingApproval).toHaveBeenCalledTimes(2);
  });
});
