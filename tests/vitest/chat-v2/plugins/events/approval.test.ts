import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatStore } from '@/chat-v2/core/types';

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('i18next', () => ({
  default: {
    t: (key: string) => key,
  },
}));

import { showGlobalNotification } from '@/components/UnifiedNotification';
import { eventRegistry } from '@/chat-v2/registry/eventRegistry';
import '@/chat-v2/plugins/events/approval';

function createMockStore(): ChatStore {
  const store = {
    pendingApprovalRequest: null,
    setPendingApproval: vi.fn((request) => {
      store.pendingApprovalRequest = request;
    }),
    clearPendingApproval: vi.fn(() => {
      store.pendingApprovalRequest = null;
    }),
  } as unknown as ChatStore;

  return store;
}

describe('ApprovalEventHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  it('queues approval requests and advances after resolution', () => {
    const handler = eventRegistry.get('tool_approval_request');
    expect(handler?.onStart).toBeDefined();
    expect(handler?.onEnd).toBeDefined();

    const store = createMockStore();
    handler!.onStart!(store, 'msg-1', {
      toolCallId: 'call-1',
      toolName: 'danger_tool',
      arguments: { a: 1 },
      sensitivity: 'high',
      description: 'desc',
      timeoutSeconds: 30,
    });

    handler!.onStart!(store, 'msg-1', {
      toolCallId: 'call-2',
      toolName: 'danger_tool_2',
      arguments: { b: 2 },
      sensitivity: 'high',
      description: 'desc2',
      timeoutSeconds: 30,
    });

    expect(store.setPendingApproval).toHaveBeenCalledTimes(1);
    expect(store.pendingApprovalRequest?.toolCallId).toBe('call-1');

    handler!.onEnd!(store, 'approval_call-1', { toolCallId: 'call-1', approved: true });
    expect(store.pendingApprovalRequest?.resolvedStatus).toBe('approved');

    vi.advanceTimersByTime(1000);
    expect(store.clearPendingApproval).toHaveBeenCalled();
    expect(store.pendingApprovalRequest?.toolCallId).toBe('call-2');
  });

  it('marks timeout on end and notifies user', () => {
    const handler = eventRegistry.get('tool_approval_request');
    const store = createMockStore();

    handler!.onStart!(store, 'msg-1', {
      toolCallId: 'call-timeout',
      toolName: 'danger_tool',
      arguments: {},
      sensitivity: 'high',
      description: 'desc',
      timeoutSeconds: 1,
    });

    handler!.onEnd!(store, 'approval_call-timeout', {
      toolCallId: 'call-timeout',
      approved: false,
      reason: 'timeout',
    });

    expect(store.pendingApprovalRequest?.resolvedStatus).toBe('timeout');
    expect(showGlobalNotification).toHaveBeenCalledWith(
      'warning',
      'chatV2:approval.notification.timeoutTitle',
      'chatV2:approval.notification.timeoutDetail'
    );

    vi.advanceTimersByTime(1000);
  });

  it('marks timeout on error and notifies user', () => {
    const handler = eventRegistry.get('tool_approval_request');
    const store = createMockStore();

    handler!.onStart!(store, 'msg-1', {
      toolCallId: 'call-error',
      toolName: 'danger_tool',
      arguments: {},
      sensitivity: 'high',
      description: 'desc',
      timeoutSeconds: 1,
    });

    handler!.onError!(store, 'approval_call-error', 'timeout while waiting');
    expect(store.pendingApprovalRequest?.resolvedStatus).toBe('timeout');
    expect(showGlobalNotification).toHaveBeenCalledWith(
      'warning',
      'chatV2:approval.notification.timeoutTitle',
      'chatV2:approval.notification.timeoutDetail'
    );

    vi.advanceTimersByTime(1000);
  });
});
