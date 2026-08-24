import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string) => key.split('.').pop() ?? key,
  }),
}));

import { MemoryGenerativeBriefing } from '@/features/learning-hub/components/MemoryGenerativeBriefing';

describe('MemoryGenerativeBriefing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders briefing with memory count', () => {
    render(
      <MemoryGenerativeBriefing
        memoryCount={6}
        rootFolderTitle="Study"
        autoExtractFrequency="balanced"
        onRefresh={vi.fn()}
        onCreateMemory={vi.fn()}
      />,
    );
    expect(screen.getByTestId('memory-generative-briefing')).toBeInTheDocument();
    expect(screen.getByText('6')).toBeInTheDocument();
    expect(document.querySelector('[data-generative-block="steps"]')).toBeTruthy();
    expect(document.querySelector('[data-generative-steps]')).toBeTruthy();
    expect(document.querySelector('[data-generative-block="table"]')).toBeTruthy();
    expect(document.querySelector('[data-generative-table]')).toBeTruthy();
  });

  it('renders markdown guide when memory list is empty', () => {
    render(
      <MemoryGenerativeBriefing
        memoryCount={0}
        onRefresh={vi.fn()}
        onCreateMemory={vi.fn()}
      />,
    );
    expect(screen.getByTestId('memory-generative-briefing')).toBeInTheDocument();
    expect(document.querySelector('[data-generative-block="markdown"]')).toBeTruthy();
    expect(document.querySelector('[data-generative-markdown]')).toBeTruthy();
    expect(document.querySelector('[data-generative-block="steps"]')).toBeTruthy();
  });
});
