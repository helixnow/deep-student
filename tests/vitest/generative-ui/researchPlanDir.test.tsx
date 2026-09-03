import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { ResearchPlanBlock } from '@/features/generative-ui/components/ResearchPlanBlock';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'research.plan.progress') {
        return `${params?.done ?? 0} / ${params?.total ?? 0}`;
      }
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

describe('ResearchPlanBlock dir="auto"', () => {
  it('puts dir="auto" on the plan title and step label', () => {
    render(
      <ResearchPlanBlock
        title="Research plan title"
        steps={[{ label: 'Gather sources', status: 'pending' }]}
      />,
    );

    const title = screen.getByRole('heading', { name: 'Research plan title' });
    expect(title).toHaveAttribute('dir', 'auto');

    const stepLabel = screen.getByText('Gather sources');
    expect(stepLabel).toHaveAttribute('dir', 'auto');
  });
});
