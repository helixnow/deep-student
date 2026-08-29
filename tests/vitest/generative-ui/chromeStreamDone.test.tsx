/**
 * Chrome aria-live: streaming vs stream_done announcement
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { GenerativeUIChrome } from '@/features/generative-ui/GenerativeUIChrome';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN' },
  }),
}));

function liveRegion(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[aria-live="polite"]');
  expect(el).toBeInstanceOf(HTMLElement);
  return el as HTMLElement;
}

describe('GenerativeUIChrome stream_done live region', () => {
  it('announces chrome.stream_done in the aria-live region when not streaming', () => {
    const { container } = render(
      <GenerativeUIChrome isStreaming={false} onAction={vi.fn()} />,
    );

    const live = liveRegion(container);
    expect(live).toHaveTextContent('chrome.stream_done');
    expect(live).not.toHaveTextContent('chrome.streaming');
    expect(live).toHaveClass('sr-only');
  });

  it('announces chrome.streaming (not stream_done) while streaming', () => {
    const { container } = render(<GenerativeUIChrome isStreaming />);

    const live = liveRegion(container);
    expect(live).toHaveTextContent('chrome.streaming');
    expect(live).not.toHaveTextContent('chrome.stream_done');
    expect(live).not.toHaveClass('sr-only');
  });
});
