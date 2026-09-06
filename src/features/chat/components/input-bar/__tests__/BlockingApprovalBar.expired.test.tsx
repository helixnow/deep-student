import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { BlockingApprovalBar } from '../BlockingApprovalBar';
import type { ToolApprovalBlockingInteraction } from '../../../core/types/store';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (_key: string, fallback?: string | { defaultValue?: string }) => {
      if (typeof fallback === 'string') return fallback;
      if (fallback?.defaultValue) return fallback.defaultValue;
      return _key;
    },
  }),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

const mockStoreState = { sessionId: 'sess-1' };

vi.mock('../../../core/session/sessionManager', () => ({
  sessionManager: {
    get: vi.fn(() => ({ getState: () => mockStoreState })),
  },
}));

vi.mock('../../../plugins/events/approval', () => ({
  resolveApprovalLocally: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { resolveApprovalLocally } from '../../../plugins/events/approval';

const invokeMock = vi.mocked(invoke);
const resolveApprovalLocallyMock = vi.mocked(resolveApprovalLocally);
const notifyMock = vi.mocked(showGlobalNotification);

function createInteraction(): ToolApprovalBlockingInteraction {
  return {
    kind: 'tool_approval',
    toolCallId: 'call-stale',
    toolName: 'note_set',
    arguments: { noteId: 'n1' },
    sensitivity: 'high',
    description: 'Will replace note n1',
    timeoutSeconds: 30,
  };
}

describe('BlockingApprovalBar approval_expired', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves the stale approval locally when the backend reports approval_expired', async () => {
    invokeMock.mockRejectedValueOnce(
      new Error('approval_expired: no waiting approval for tool_call_id=call-stale')
    );

    render(<BlockingApprovalBar interaction={createInteraction()} sessionId="sess-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'approval.approve' }));

    await waitFor(() => {
      expect(notifyMock).toHaveBeenCalledWith(
        'warning',
        'approval.notification.expiredTitle',
        'approval.notification.expiredDetail'
      );
    });

    // 后端已权威告知等待者不存在：本地收摊（resolve + 出队），
    // 审批栏不能继续占位等一个永远不会被投递的终止事件
    expect(resolveApprovalLocallyMock).toHaveBeenCalledWith(
      mockStoreState,
      'call-stale',
      'expired'
    );
  });

  it('does not resolve locally for non-expired respond failures', async () => {
    invokeMock.mockRejectedValueOnce(new Error('network unreachable'));

    render(<BlockingApprovalBar interaction={createInteraction()} sessionId="sess-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'approval.approve' }));

    await waitFor(() => {
      expect(notifyMock).toHaveBeenCalledWith(
        'error',
        'approval.notification.responseFailedTitle',
        'approval.notification.responseFailedDetail'
      );
    });

    // 普通失败保留重试空间，不收摊
    expect(resolveApprovalLocallyMock).not.toHaveBeenCalled();
  });
});
