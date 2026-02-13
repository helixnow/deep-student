import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToolApprovalCard, type ApprovalRequestData } from '../ToolApprovalCard';

vi.mock('@/mcp/builtinMcpServer', () => ({
  getToolDisplayNameKey: vi.fn(() => null),
}));

const baseRequest: ApprovalRequestData = {
  toolCallId: 'call-1',
  toolName: 'tools.template_fork',
  arguments: { foo: 'bar' },
  sensitivity: 'medium',
  description: 'test description',
  timeoutSeconds: 60,
  resolvedStatus: 'approved',
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
    expect(root?.className).toContain('bg-yellow-50/85');
  });

  it('does not render a leading shield icon next to the approval title', () => {
    render(
      <ToolApprovalCard
        request={baseRequest}
        sessionId="session-1"
      />
    );

    const title = screen.getByText('approval.title');
    const titleElement = title.closest('h3');
    expect(titleElement).not.toBeNull();
    expect(titleElement?.querySelector('svg')).toBeNull();
  });
});
