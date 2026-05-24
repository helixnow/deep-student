import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { SandboxWorkbenchPage } from '@/features/sandbox/pages/SandboxWorkbenchPage';
import { useSandboxWorkbenchStore } from '@/features/sandbox/store/useSandboxWorkbenchStore';

describe('SandboxWorkbenchPage layout', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    useSandboxWorkbenchStore.setState({
      activeSession: null,
      viewportPreset: 'desktop',
      inspectorOpen: false,
    });
  });

  it('renders toolbar, runtime area, and inspector controls for an active session', () => {
    useSandboxWorkbenchStore.getState().openSession({
      sourceType: 'chat-code-block',
      sourceMessageId: 'msg_1',
      language: 'html',
      title: 'HTML Preview',
      content: '<div>hello</div>',
    });
    useSandboxWorkbenchStore.setState({ inspectorOpen: true });

    render(<SandboxWorkbenchPage />);

    expect(screen.getByRole('heading', { name: /HTML Preview/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '刷新' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '收起检查器' })).toBeInTheDocument();
    expect(screen.getByText('来源')).toBeInTheDocument();
    expect(screen.getByText('统计')).toBeInTheDocument();
    expect(screen.getByTestId('sandbox-runtime-canvas')).toBeInTheDocument();
  });
});
