import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GenerativeMarkdownBody } from '@/features/generative-ui/components/GenerativeMarkdownBody';
import { ResearchReportBlock } from '@/features/generative-ui/components/ResearchReportBlock';
import { openUrl } from '@/utils/urlOpener';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (
      key === 'research.report.citation_aria' ? `Citation ${params?.label ?? ''}` : key
    ),
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('@/utils/urlOpener', () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/features/chat/components/renderers/MarkdownRenderer', () => {
  throw new Error('Generative rendering must not load the chat renderer');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('GenerativeMarkdownBody runtime', () => {
  it('renders inline, display and fenced math without a chat provider', async () => {
    const { container } = render(
      <GenerativeMarkdownBody content={'Inline $x^2$.\n\n$$\n\\frac{1}{2}\n$$\n\n```math\nx + y\n```'} />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll('.katex')).toHaveLength(3);
    });
    expect(container.querySelectorAll('.katex-display')).toHaveLength(2);
    expect(container.querySelector('pre')).toBeNull();
    expect(container.querySelector('math')).not.toBeNull();
  });

  it('keeps safe HTML and GFM while stripping executable HTML and attributes', () => {
    const content = [
      '<strong onclick="alert(1)" style="position:fixed">safe</strong>',
      '',
      '<script>alert(1)</script><iframe src="https://example.com"></iframe>',
      '',
      '<img src="https://example.com/image.png" onerror="alert(1)" />',
      '',
      '<a href="javascript:alert(1)">unsafe</a>',
      '',
      '| A | B |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '```html',
      '<script>literal</script>',
      '```',
    ].join('\n');
    const { container } = render(<GenerativeMarkdownBody content={content} />);

    expect(screen.getByText('safe').tagName).toBe('STRONG');
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelector('script, iframe, [onclick], [onerror], [style]')).toBeNull();
    expect(screen.getByText('unsafe')).not.toHaveAttribute('href', 'javascript:alert(1)');
    expect(container.querySelector('pre code')).toHaveTextContent('<script>literal</script>');
  });

  it('preserves accessible research badges outside code and math', async () => {
    const { container } = render(
      <ResearchReportBlock
        density="normal"
        body={'Evidence [paper-1].\n\n`[paper-2]`\n\n$[paper-3]$\n\n```text\n[paper-4]\n```'}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('.katex')).not.toBeNull();
    });
    const badges = container.querySelectorAll('[data-citation]');
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveAttribute('role', 'note');
    expect(badges[0]).toHaveAttribute('aria-label', 'Citation [paper-1]');
    expect(badges[0]).toHaveClass('inline-flex');
    expect(container.querySelector('code')).toHaveTextContent('[paper-2]');
    expect(container.querySelector('pre code')).toHaveTextContent('[paper-4]');
  });

  it('keeps incomplete streaming math readable and renders it once complete', async () => {
    const { container, rerender } = render(
      <GenerativeMarkdownBody content="Streaming $x" isStreaming />,
    );
    expect(container).toHaveTextContent('Streaming $x');
    expect(container.querySelector('.katex')).toBeNull();
    expect(container.querySelector('[data-generative-markdown-body]')).toHaveAttribute('data-streaming', 'true');

    rerender(<GenerativeMarkdownBody content="Streaming $x$" />);
    await waitFor(() => {
      expect(container.querySelector('.katex')).not.toBeNull();
    });
    expect(container.querySelector('[data-generative-markdown-body]')).not.toHaveAttribute('data-streaming');
  });

  it('opens external links through the platform opener and keeps anchors local', async () => {
    render(<GenerativeMarkdownBody content="[External](https://example.com) [Anchor](#section)" />);
    const external = screen.getByRole('link', { name: 'External' });
    expect(external).toHaveAttribute('rel', 'noopener noreferrer');
    fireEvent.click(external);
    await waitFor(() => {
      expect(openUrl).toHaveBeenCalledWith('https://example.com');
    });
    fireEvent.click(screen.getByRole('link', { name: 'Anchor' }));
    expect(openUrl).toHaveBeenCalledTimes(1);
  });
});
