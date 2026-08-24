import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { PaperDigestBlock } from '@/features/generative-ui/components/PaperDigestBlock';
import { formatGenerativeNumber } from '@/features/generative-ui/utils/formatGenerativeNumber';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'research.paper_digest.citations') {
        return `${params?.count ?? 0} citations`;
      }
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

describe('PaperDigestBlock locale format', () => {
  it('puts dir="auto" on title/citation label and locale-formats citationCount', () => {
    const formatted = formatGenerativeNumber(1200);
    render(
      <PaperDigestBlock
        title="Attention Is All You Need"
        citationLabel="Citation ציטוט"
        citationCount={1200}
        abstractExcerpt="We propose the Transformer."
      />,
    );

    const title = screen.getByRole('heading', { name: 'Attention Is All You Need' });
    expect(title).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('Citation ציטוט')).toHaveAttribute('dir', 'auto');

    const citationLine = document.querySelector('[data-citation-count]');
    expect(citationLine).toBeTruthy();
    expect(citationLine).toHaveAttribute('data-citation-count', formatted);
    expect(citationLine).toHaveTextContent(formatted);
  });
});
