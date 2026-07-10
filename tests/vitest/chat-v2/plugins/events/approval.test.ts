import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatStore } from '@/features/chat/core/types';

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('i18next', () => ({
  default: {
    t: (key: string) => key,
  },
}));

const mockActivate = vi.fn(() => true);

vi.mock('@/features/workbench', () => ({
  workbenchBus: {
    activate: (...args: unknown[]) => mockActivate(...args),
  },
}));

import { showGlobalNotification } from '@/components/UnifiedNotification';
import { eventRegistry } from '@/features/chat/registry/eventRegistry';
import '@/features/chat/plugins/events/approval';

function createMockStore(sessionId = 'sess-1'): ChatStore {
  const store = {
    sessionId,
    pendingApprovalRequest: null,
    pendingBlockingInteraction: null,
    setPendingApproval: vi.fn((request) => {
      const interaction = request ? { kind: 'tool_approval', ...request } : null;
      store.pendingApprovalRequest = request;
      store.pendingBlockingInteraction = interaction;
    }),
    clearPendingApproval: vi.fn(() => {
      store.pendingApprovalRequest = null;
      store.pendingBlockingInteraction = null;
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
    expect(store.pendingBlockingInteraction?.toolCallId).toBe('call-1');
    // ACR R2-05: High 审批首次展示时 focus chat 窗
    expect(mockActivate).toHaveBeenCalledWith(
      expect.objectContaining({
        typeId: 'chat',
        instanceKey: 'sess-1',
        action: 'focus',
      })
    );

    handler!.onEnd!(store, 'approval_call-1', { toolCallId: 'call-1', approved: true });
    expect(store.pendingBlockingInteraction?.resolvedStatus).toBe('approved');

    vi.advanceTimersByTime(1000);
    expect(store.clearPendingApproval).toHaveBeenCalled();
    expect(store.pendingBlockingInteraction?.toolCallId).toBe('call-2');
    // 队列出队的 High 审批也会 focus
    expect(mockActivate).toHaveBeenCalledTimes(2);
  });

  it('does not focus chat window for medium sensitivity', () => {
    const handler = eventRegistry.get('tool_approval_request');
    const store = createMockStore();

    handler!.onStart!(store, 'msg-1', {
      toolCallId: 'call-med',
      toolName: 'medium_tool',
      arguments: {},
      sensitivity: 'medium',
      description: 'desc',
      timeoutSeconds: 30,
    });

    expect(mockActivate).not.toHaveBeenCalled();
    expect(store.setPendingApproval).toHaveBeenCalledTimes(1);
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

    expect(store.pendingBlockingInteraction?.resolvedStatus).toBe('timeout');
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
    expect(store.pendingBlockingInteraction?.resolvedStatus).toBe('timeout');
    expect(showGlobalNotification).toHaveBeenCalledWith(
      'warning',
      'chatV2:approval.notification.timeoutTitle',
      'chatV2:approval.notification.timeoutDetail'
    );

    vi.advanceTimersByTime(1000);
  });

  it('propagates custom user rejection reason into resolvedReason', () => {
    const handler = eventRegistry.get('tool_approval_request');
    const store = createMockStore();

    handler!.onStart!(store, 'msg-1', {
      toolCallId: 'call-reject-reason',
      toolName: 'danger_tool',
      arguments: {},
      sensitivity: 'high',
      description: 'desc',
      timeoutSeconds: 30,
    });

    handler!.onEnd!(store, 'approval_call-reject-reason', {
      toolCallId: 'call-reject-reason',
      approved: false,
      reason: '请改用只读命令查看文件',
    });

    expect(store.pendingBlockingInteraction?.resolvedStatus).toBe('rejected');
    expect(store.pendingBlockingInteraction?.resolvedReason).toBe('请改用只读命令查看文件');

    vi.advanceTimersByTime(1000);
  });

  it('keeps sentinel user_rejected reason as resolvedReason without misclassifying status', () => {
    const handler = eventRegistry.get('tool_approval_request');
    const store = createMockStore();

    handler!.onStart!(store, 'msg-1', {
      toolCallId: 'call-reject-plain',
      toolName: 'danger_tool',
      arguments: {},
      sensitivity: 'high',
      description: 'desc',
      timeoutSeconds: 30,
    });

    handler!.onEnd!(store, 'approval_call-reject-plain', {
      toolCallId: 'call-reject-plain',
      approved: false,
      reason: 'user_rejected',
    });

    expect(store.pendingBlockingInteraction?.resolvedStatus).toBe('rejected');
    expect(store.pendingBlockingInteraction?.resolvedReason).toBe('user_rejected');

    vi.advanceTimersByTime(1000);
  });

  it('preserves runtime scope metadata for inline approval UI', () => {
    const handler = eventRegistry.get('tool_approval_request');
    const store = createMockStore();

    handler!.onStart!(store, 'msg-1', {
      toolCallId: 'call-shell',
      toolName: 'builtin-local_shell_execute',
      arguments: { command: 'git status --short' },
      sensitivity: 'high',
      description: 'desc',
      timeoutSeconds: 30,
      runtimeScope: {
        kind: 'shell',
        toolSource: 'builtin',
        toolName: 'local_shell_execute',
        rootId: 'workspace',
        cwd: '.',
        commandPrefix: 'git status',
        commandHash: '1234567890abcdef',
        riskLevel: 'high',
        hasShellOperators: false,
        usesScriptRunner: false,
        firstToken: 'git',
      },
    });

    expect(store.pendingBlockingInteraction).toMatchObject({
      kind: 'tool_approval',
      toolCallId: 'call-shell',
      runtimeScope: {
        kind: 'shell',
        rootId: 'workspace',
        cwd: '.',
        commandPrefix: 'git status',
      },
    });
  });
});
