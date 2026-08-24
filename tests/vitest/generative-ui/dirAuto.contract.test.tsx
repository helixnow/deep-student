/**
 * Contract: mixed-language generative text uses dir="auto"
 * so LTR/RTL content can inherit the correct base direction.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('@/features/chat/components/renderers/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown-renderer">{content}</div>
  ),
}));

import { TextBlock } from '@/features/generative-ui/components/TextBlock';
import { MarkdownBlock } from '@/features/generative-ui/components/MarkdownBlock';

describe('dir="auto" for mixed-language generative text', () => {
  it('puts dir="auto" on TextBlock heading and body', () => {
    render(<TextBlock heading="Mixed heading עברית" body="Body text مرحبا" />);

    const heading = screen.getByRole('heading', { name: 'Mixed heading עברית' });
    expect(heading.tagName).toBe('H4');
    expect(heading).toHaveAttribute('dir', 'auto');

    const body = screen.getByText('Body text مرحبا');
    expect(body.tagName).toBe('P');
    expect(body).toHaveAttribute('dir', 'auto');
  });

  it('puts dir="auto" on MarkdownBlock title and content wrapper', () => {
    const { container } = render(
      <MarkdownBlock title="Markdown title العربية" body="# Hello مرحبا" />,
    );

    const title = screen.getByRole('heading', { name: 'Markdown title العربية' });
    expect(title.tagName).toBe('H4');
    expect(title).toHaveAttribute('dir', 'auto');

    const contentWrapper = container.querySelector('[dir="auto"]:not(h4)');
    expect(contentWrapper).not.toBeNull();
    expect(contentWrapper).toHaveAttribute('dir', 'auto');
    expect(contentWrapper).toContainElement(screen.getByTestId('markdown-renderer'));
  });
});
