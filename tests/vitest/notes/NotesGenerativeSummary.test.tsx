import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { NotesGenerativeSummary } from '@/features/notes/components/NotesGenerativeSummary';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? key.split('.').pop() ?? key,
    i18n: { language: 'zh-CN' },
  }),
}));

describe('NotesGenerativeSummary', () => {
  it('renders markdown overview after building note summary intent', () => {
    render(
      <NotesGenerativeSummary
        title="Linear Algebra"
        tags={['math']}
        content={'# Eigenvalues\n\nBody text for the note summary.'.repeat(3)}
        headingLabels={['Eigenvalues']}
        updatedAt="2026-08-24T00:00:00.000Z"
      />,
    );
    expect(document.querySelector('[data-notes-generative-summary]')).toBeTruthy();
    expect(screen.getByText('summary_title')).toBeInTheDocument();
    expect(document.querySelector('[data-generative-block="markdown"]')).toBeTruthy();
    expect(document.querySelector('[data-generative-markdown]')).toBeTruthy();
  });

  it('returns null without title or content', () => {
    const { container } = render(<NotesGenerativeSummary />);
    expect(container.firstChild).toBeNull();
  });
});
