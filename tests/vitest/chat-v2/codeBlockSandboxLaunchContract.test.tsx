import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/features/sandbox/launchSandboxWorkbench', () => ({
  launchSandboxWorkbench: vi.fn(),
}));

import { CodeBlock } from '@/features/chat/components/renderers/CodeBlock';
import { launchSandboxWorkbench } from '@/features/sandbox/launchSandboxWorkbench';

describe('CodeBlock sandbox launch', () => {
  it('offers Open in Sandbox from the html code block more menu and launches workbench', () => {
    render(<CodeBlock className="language-html">{'<div>hello</div>'}</CodeBlock>);

    fireEvent.click(screen.getByRole('button', { name: /More actions|更多操作/i }));
    fireEvent.click(screen.getByText(/Open in Sandbox|在沙箱中打开/i));

    expect(launchSandboxWorkbench).toHaveBeenCalledTimes(1);
  });
});
