import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

vi.mock('@/utils/clipboardUtils', () => ({
  copyTextToClipboard: vi.fn().mockResolvedValue(true),
}));

describe('ErrorBoundary copy action', () => {
  const originalConsoleError = console.error;

  beforeEach(() => {
    console.error = vi.fn();
  });

  afterEach(() => {
    console.error = originalConsoleError;
    vi.clearAllMocks();
  });

  it('lets chat-v2 fallback copy the error log', async () => {
    const Crashy = () => {
      throw new Error('sidebar crash');
    };

    render(
      <ErrorBoundary name="chat-v2">
        <Crashy />
      </ErrorBoundary>
    );

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /复制错误日志|Copy Error Log/ }));

    await waitFor(() => {
      expect(copyTextToClipboard).toHaveBeenCalledTimes(1);
    });

    const copiedPayload = vi.mocked(copyTextToClipboard).mock.calls[0]?.[0] ?? '';
    expect(copiedPayload).toContain('sidebar crash');
    expect(copiedPayload).toContain('Timestamp:');
  });
});
