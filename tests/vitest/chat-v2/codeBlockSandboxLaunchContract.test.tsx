import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/features/sandbox/launchSandboxWorkbench', () => ({
  launchSandboxWorkbench: vi.fn(),
}));

import { CodeBlock } from '@/features/chat/components/renderers/CodeBlock';
import { launchSandboxWorkbench } from '@/features/sandbox/launchSandboxWorkbench';

describe('CodeBlock sandbox launch', () => {
  it('shows Open in Sandbox for html code blocks and launches workbench', () => {
    render(<CodeBlock className="language-html">{'<div>hello</div>'}</CodeBlock>);

    fireEvent.click(screen.getByText(/Open in Sandbox/i));

    expect(launchSandboxWorkbench).toHaveBeenCalledTimes(1);
  });
});
