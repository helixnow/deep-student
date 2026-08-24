import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string) => key.split('.').pop() ?? key,
  }),
}));

import { IndexStatusGenerativeBriefing } from '@/features/learning-hub/components/IndexStatusGenerativeBriefing';

describe('IndexStatusGenerativeBriefing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders briefing with summary stats', () => {
    render(
      <IndexStatusGenerativeBriefing
        summary={{
          totalResources: 15,
          indexedCount: 10,
          pendingCount: 3,
          failedCount: 2,
          indexingCount: 0,
        }}
        onBatchIndex={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByTestId('index-status-generative-briefing')).toBeInTheDocument();
    expect(screen.getByText('15')).toBeInTheDocument();
    expect(document.querySelector('[data-generative-block="table"]')).toBeTruthy();
    expect(document.querySelector('[data-generative-table]')).toBeTruthy();
    expect(document.querySelector('[data-generative-block="markdown"]')).toBeTruthy();
    expect(document.querySelector('[data-generative-markdown]')).toBeTruthy();
  });
});
