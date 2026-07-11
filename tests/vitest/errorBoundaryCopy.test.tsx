import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import i18n from '@/i18n';
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

    expect(screen.getByText(i18n.t('common:errorBoundary.title'))).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', {
        name: i18n.t('common:error_boundary.copy_error'),
      })
    );

    await waitFor(() => {
      expect(copyTextToClipboard).toHaveBeenCalledTimes(1);
    });

    const copiedPayload = vi.mocked(copyTextToClipboard).mock.calls[0]?.[0] ?? '';
    expect(copiedPayload).toContain('sidebar crash');
    expect(copiedPayload).toContain('Timestamp:');
  });
});
