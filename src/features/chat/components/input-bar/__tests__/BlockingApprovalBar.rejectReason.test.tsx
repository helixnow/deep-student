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

import { invoke } from '@tauri-apps/api/core';

const invokeMock = vi.mocked(invoke);

function createInteraction(): ToolApprovalBlockingInteraction {
  return {
    kind: 'tool_approval',
    toolCallId: 'call-reject',
    toolName: 'note_set',
    arguments: { noteId: 'n1' },
    sensitivity: 'high',
    description: 'Will replace note n1',
    timeoutSeconds: 30,
  };
}

describe('BlockingApprovalBar reject reason', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens inline reason input on reject click without sending', () => {
    render(<BlockingApprovalBar interaction={createInteraction()} sessionId="sess-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'approval.reject' }));

    expect(invokeMock).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('approval.rejectReasonPlaceholder')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'approval.rejectDirectly' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'approval.rejectSend' })).toBeInTheDocument();
  });

  it('submits rejection with custom reason on Enter', async () => {
    render(<BlockingApprovalBar interaction={createInteraction()} sessionId="sess-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'approval.reject' }));
    const input = screen.getByPlaceholderText('approval.rejectReasonPlaceholder');
    fireEvent.change(input, { target: { value: '请改用只读命令' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'chat_v2_tool_approval_respond',
        expect.objectContaining({
          sessionId: 'sess-1',
          toolCallId: 'call-reject',
          approved: false,
          reason: '请改用只读命令',
          remember: false,
        })
      );
    });
  });

  it('keeps quick reject path within two clicks using the sentinel reason', async () => {
    render(<BlockingApprovalBar interaction={createInteraction()} sessionId="sess-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'approval.reject' }));
    fireEvent.click(screen.getByRole('button', { name: 'approval.rejectDirectly' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'chat_v2_tool_approval_respond',
        expect.objectContaining({
          approved: false,
          reason: 'user_rejected',
        })
      );
    });
  });

  it('sends immediate rejection without reason on Escape', async () => {
    render(<BlockingApprovalBar interaction={createInteraction()} sessionId="sess-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'approval.reject' }));
    const input = screen.getByPlaceholderText('approval.rejectReasonPlaceholder');
    fireEvent.change(input, { target: { value: '输入到一半' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'chat_v2_tool_approval_respond',
        expect.objectContaining({
          approved: false,
          reason: 'user_rejected',
        })
      );
    });
  });

  it('falls back to sentinel reason when sending with empty input', async () => {
    render(<BlockingApprovalBar interaction={createInteraction()} sessionId="sess-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'approval.reject' }));
    fireEvent.click(screen.getByRole('button', { name: 'approval.rejectSend' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'chat_v2_tool_approval_respond',
        expect.objectContaining({
          approved: false,
          reason: 'user_rejected',
        })
      );
    });
  });
});
