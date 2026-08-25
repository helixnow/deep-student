import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import i18n from '@/i18n';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

vi.mock('@/utils/clipboardUtils', () => ({
  copyTextToClipboard: vi.fn().mockResolvedValue(true),
}));

const errorBoundarySource = readFileSync(
  resolve(process.cwd(), 'src/components/ErrorBoundary.tsx'),
  'utf-8',
);

const silenceReactErrorLogs = () => {
  const originalConsoleError = console.error;

  beforeEach(() => {
    console.error = vi.fn();
  });

  afterEach(() => {
    console.error = originalConsoleError;
    vi.clearAllMocks();
  });
};

describe('ErrorBoundary copy action', () => {
  silenceReactErrorLogs();

  it('lets chat-v2 fallback copy the error log', async () => {
    const Crashy = () => {
      throw new Error('sidebar crash');
    };

    render(
      <ErrorBoundary name="chat-v2">
        <Crashy />
      </ErrorBoundary>
    );

    expect(screen.getByText(i18n.t('common:error_boundary.title'))).toBeInTheDocument();

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

describe('ErrorBoundary retry action', () => {
  silenceReactErrorLogs();

  it('labels the inline action as a retry, not a page refresh', () => {
    const Crashy = () => {
      throw new Error('boom');
    };

    render(
      <ErrorBoundary name="inline">
        <Crashy />
      </ErrorBoundary>
    );

    // 这个按钮只重挂子树，不会重载页面；写「刷新页面」是假承诺。
    // 真刷新留在 TopLevelFallback（那里继续用 error_boundary.refresh）。
    expect(
      screen.getByRole('button', { name: i18n.t('common:error_boundary.retry') })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: i18n.t('common:error_boundary.refresh') })
    ).not.toBeInTheDocument();
  });

  it('remounts the children when the failure was transient', () => {
    let shouldThrow = true;
    const Flaky = () => {
      if (shouldThrow) throw new Error('transient crash');
      return <p>recovered</p>;
    };

    render(
      <ErrorBoundary name="inline">
        <Flaky />
      </ErrorBoundary>
    );

    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: i18n.t('common:error_boundary.retry') }));

    expect(screen.getByText('recovered')).toBeInTheDocument();
  });

  it('routes the retry through the shared resetError instead of a partial setState', () => {
    // 只 setState({ hasError: false }) 会把上一次的 error / componentStack / copied
    // 留在 state 里，和 fallback 拿到的 reset 行为对不上。
    expect(errorBoundarySource).toContain('onClick={this.resetError}');
    expect(errorBoundarySource).not.toContain('setState({ hasError: false })');
  });

  it('keeps the retry hit area on the shared touch target size', () => {
    const Crashy = () => {
      throw new Error('boom');
    };

    render(
      <ErrorBoundary name="inline">
        <Crashy />
      </ErrorBoundary>
    );

    const retry = screen.getByRole('button', { name: i18n.t('common:error_boundary.retry') });
    expect(retry).toHaveClass('h-[var(--touch-target-size)]');
    // 旧实现用 !px-3 !py-1.5 把热区压小，移动端会点不中。
    expect(retry.className).not.toContain('!py-');
  });

  it('keeps the dev-only component stack scrollable instead of pushing the button off screen', () => {
    expect(errorBoundarySource).toMatch(/<pre className="[^"]*max-h-40[^"]*overflow-auto/);
  });
});
