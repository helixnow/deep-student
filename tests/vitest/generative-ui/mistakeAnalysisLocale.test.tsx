import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { MistakeAnalysisBlock } from '@/features/generative-ui/components/MistakeAnalysisBlock';
import { formatGenerativeNumber } from '@/features/generative-ui/utils/formatGenerativeNumber';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'mistake.error_rate') {
        return `Error rate ${params?.rate ?? 0}%`;
      }
      if (key === 'mistake.count') {
        return `(${params?.count ?? 0} items)`;
      }
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

describe('MistakeAnalysisBlock locale format', () => {
  it('formats counts and puts dir="auto" on topic and suggestion', () => {
    const formattedRate = formatGenerativeNumber(12.5);
    const formattedCount = formatGenerativeNumber(3);

    render(
      <MistakeAnalysisBlock topic="X" errorRate={12.5} mistakeCount={3} suggestion="Review" />,
    );

    const title = screen.getByRole('heading');
    expect(title).toHaveTextContent(formattedRate);
    expect(title).toHaveTextContent(formattedCount);
    expect(title).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('Review')).toHaveAttribute('dir', 'auto');

    const errorRateEl = document.querySelector('[data-error-rate]');
    expect(errorRateEl).toBeTruthy();
    expect(errorRateEl).toHaveAttribute('data-error-rate', formattedRate);
  });
});
