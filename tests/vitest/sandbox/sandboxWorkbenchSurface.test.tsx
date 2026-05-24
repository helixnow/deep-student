import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { SandboxWorkbenchSurface } from '@/features/sandbox/components/SandboxWorkbenchSurface';
import { useSandboxWorkbenchStore } from '@/features/sandbox/store/useSandboxWorkbenchStore';

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: false }),
}));

describe('SandboxWorkbenchSurface', () => {
  beforeEach(() => {
    useSandboxWorkbenchStore.setState({
      activeSession: null,
      isOpen: false,
      viewportPreset: 'desktop',
      inspectorOpen: false,
    });
  });

  it('renders a reopen shell when the workbench is collapsed with an active session', () => {
    useSandboxWorkbenchStore.setState({
      activeSession: {
        id: 'sandbox_1',
        sourceType: 'chat-code-block',
        sourceMessageId: 'msg_1',
        language: 'html',
        title: 'Preview Card',
        content: '<div>Hello</div>',
        mode: 'safe-preview',
        createdAt: 1,
        updatedAt: 1,
      },
      isOpen: false,
    });

    render(<SandboxWorkbenchSurface />);

    fireEvent.click(screen.getByRole('button', { name: '打开沙箱工作台' }));
    expect(useSandboxWorkbenchStore.getState().isOpen).toBe(true);
  });

  it('renders the embedded preview iframe when the workbench is open', () => {
    useSandboxWorkbenchStore.setState({
      activeSession: {
        id: 'sandbox_2',
        sourceType: 'chat-code-block',
        sourceMessageId: 'msg_2',
        language: 'html',
        title: 'Open Preview',
        content: '<main>Preview</main>',
        mode: 'safe-preview',
        createdAt: 2,
        updatedAt: 2,
      },
      isOpen: true,
    });

    const { container } = render(<SandboxWorkbenchSurface embedded />);

    expect(screen.getByText('Open Preview')).toBeInTheDocument();
    expect(container.querySelector('iframe')).not.toBeNull();
  });

  it('keeps the iframe mounted when refreshing the session metadata', () => {
    useSandboxWorkbenchStore.setState({
      activeSession: {
        id: 'sandbox_3',
        sourceType: 'chat-code-block',
        sourceMessageId: 'msg_3',
        language: 'html',
        title: 'Stable Preview',
        content: '<section>Stable</section>',
        mode: 'safe-preview',
        createdAt: 3,
        updatedAt: 3,
      },
      isOpen: true,
    });

    const { container } = render(<SandboxWorkbenchSurface embedded />);
    const initialIframe = container.querySelector('iframe');
    expect(initialIframe).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '刷新' }));

    const nextIframe = container.querySelector('iframe');
    expect(nextIframe).toBe(initialIframe);
  });
});
