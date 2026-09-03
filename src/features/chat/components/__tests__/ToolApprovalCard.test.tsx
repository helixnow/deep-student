import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToolApprovalCard, type ApprovalRequestData } from '../ToolApprovalCard';

vi.mock('@/mcp/builtinMcpServer', () => ({
  getToolDisplayNameKey: vi.fn(() => null),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';

const invokeMock = vi.mocked(invoke);

const baseRequest: ApprovalRequestData = {
  toolCallId: 'call-1',
  toolName: 'tools.template_fork',
  arguments: { foo: 'bar' },
  sensitivity: 'medium',
  description: 'test description',
  timeoutSeconds: 60,
  resolvedStatus: 'approved',
};

const pendingRequest: ApprovalRequestData = {
  ...baseRequest,
  toolCallId: 'call-pending',
  resolvedStatus: undefined,
};

describe('ToolApprovalCard', () => {
  it('applies blurred background styles to approval container', () => {
    const { container } = render(
      <ToolApprovalCard
        request={baseRequest}
        sessionId="session-1"
      />
    );

    const root = container.firstElementChild;
    expect(root).not.toBeNull();
    expect(root?.className).toContain('backdrop-blur-md');
    expect(root?.className).toContain('bg-warning/10');
  });

  it('does not render a leading shield icon next to the approval title', () => {
    render(
      <ToolApprovalCard
        request={baseRequest}
        sessionId="session-1"
      />
    );

    const title = screen.getByText('工具执行确认');
    const titleElement = title.closest('h3');
    expect(titleElement).not.toBeNull();
    expect(titleElement?.querySelector('svg')).toBeNull();
  });

  describe('reject reason flow', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('opens inline reason input on reject click without sending', () => {
      render(<ToolApprovalCard request={pendingRequest} sessionId="session-1" />);

      fireEvent.click(screen.getByRole('button', { name: '本次拒绝' }));

      expect(invokeMock).not.toHaveBeenCalled();
      expect(
        screen.getByPlaceholderText('可选：告诉 AI 为什么拒绝或希望它怎么做'),
      ).toBeInTheDocument();
    });

    it('submits rejection with custom reason on Enter', async () => {
      render(<ToolApprovalCard request={pendingRequest} sessionId="session-1" />);

      fireEvent.click(screen.getByRole('button', { name: '本次拒绝' }));
      const input = screen.getByPlaceholderText('可选：告诉 AI 为什么拒绝或希望它怎么做');
      fireEvent.change(input, { target: { value: '不要覆盖这个模板' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      await waitFor(() => {
        expect(invokeMock).toHaveBeenCalledWith(
          'chat_v2_tool_approval_respond',
          expect.objectContaining({
            sessionId: 'session-1',
            toolCallId: 'call-pending',
            approved: false,
            reason: '不要覆盖这个模板',
          })
        );
      });
    });

    it('rejects immediately with sentinel reason via the direct-reject button', async () => {
      render(<ToolApprovalCard request={pendingRequest} sessionId="session-1" />);

      fireEvent.click(screen.getByRole('button', { name: '本次拒绝' }));
      fireEvent.click(screen.getByRole('button', { name: '直接拒绝' }));

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

  describe('resolved reason display', () => {
    it('shows the user-written reason on a rejected card', () => {
      render(
        <ToolApprovalCard
          request={{ ...baseRequest, resolvedStatus: 'rejected', resolvedReason: '请先备份再执行' }}
          sessionId="session-1"
        />
      );

      expect(screen.getByText(/请先备份再执行/)).toBeInTheDocument();
    });

    it('hides the sentinel user_rejected reason on a rejected card', () => {
      render(
        <ToolApprovalCard
          request={{ ...baseRequest, resolvedStatus: 'rejected', resolvedReason: 'user_rejected' }}
          sessionId="session-1"
        />
      );

      expect(screen.queryByText(/user_rejected/)).not.toBeInTheDocument();
    });
  });
});
