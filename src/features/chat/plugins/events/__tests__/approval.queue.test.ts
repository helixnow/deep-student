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

import { approvalEventHandler, resolveApprovalLocally } from '../approval';

function createStoreHarness() {
  const store = {
    sessionId: 'session-1',
    pendingBlockingInteraction: null,
  } as unknown as ChatStore;
  const setPendingApproval = vi.fn((request: Record<string, unknown> | null) => {
    store.pendingBlockingInteraction = request
      ? { kind: 'tool_approval', ...request } as ChatStore['pendingBlockingInteraction']
      : null;
  });
  const clearPendingApproval = vi.fn(() => {
    store.pendingBlockingInteraction = null;
  });
  store.setPendingApproval = setPendingApproval;
  store.clearPendingApproval = clearPendingApproval;
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

describe('resolveApprovalLocally', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('opts into direct terminal delivery by blockId', () => {
    expect(approvalEventHandler.deliverTerminalByBlockId).toBe(true);
  });

  it('resolves the pending approval and advances the queue', () => {
    const { store, clearPendingApproval } = createStoreHarness();

    approvalEventHandler.onStart(store, 'message-1', request('call-1'));
    approvalEventHandler.onStart(store, 'message-1', request('call-2'));

    resolveApprovalLocally(store, 'call-1', 'expired');

    expect(store.pendingBlockingInteraction).toMatchObject({
      toolCallId: 'call-1',
      resolvedStatus: 'expired',
    });

    vi.advanceTimersByTime(1000);

    expect(clearPendingApproval).toHaveBeenCalled();
    // 出队后队列中的下一个审批上场
    expect(store.pendingBlockingInteraction).toMatchObject({
      toolCallId: 'call-2',
    });
    expect(store.pendingBlockingInteraction?.resolvedStatus).toBeUndefined();
  });

  it('is idempotent when no approval is pending', () => {
    const { store, setPendingApproval, clearPendingApproval } = createStoreHarness();

    resolveApprovalLocally(store, 'call-missing', 'expired');
    vi.advanceTimersByTime(1000);

    expect(setPendingApproval).not.toHaveBeenCalled();
    expect(clearPendingApproval).not.toHaveBeenCalled();
  });

  it('ignores a stale resolution when the pending approval has a different toolCallId', () => {
    const { store } = createStoreHarness();

    approvalEventHandler.onStart(store, 'message-1', request('call-current'));
    resolveApprovalLocally(store, 'call-stale', 'expired');
    vi.advanceTimersByTime(1000);

    expect(store.pendingBlockingInteraction).toMatchObject({
      toolCallId: 'call-current',
    });
    expect(store.pendingBlockingInteraction?.resolvedStatus).toBeUndefined();
  });

  it('drops a re-emitted start for a locally resolved toolCallId', () => {
    const { store, setPendingApproval } = createStoreHarness();

    approvalEventHandler.onStart(store, 'message-1', request('call-1'));
    resolveApprovalLocally(store, 'call-1', 'expired');
    vi.advanceTimersByTime(1000);

    // 首次 onStart + resolve 标记各调用一次；出队后 pending 已清空
    expect(setPendingApproval).toHaveBeenCalledTimes(2);
    expect(store.pendingBlockingInteraction).toBeNull();

    // 同一 toolCallId 的 start 重放（断流重连/事件重发）不得复活审批栏
    approvalEventHandler.onStart(store, 'message-1', request('call-1'));
    expect(setPendingApproval).toHaveBeenCalledTimes(2);
    expect(store.pendingBlockingInteraction).toBeNull();
  });
});
