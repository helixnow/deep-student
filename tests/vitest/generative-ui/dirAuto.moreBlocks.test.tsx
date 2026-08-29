/**
 * Contract: mixed-language generative text uses dir="auto"
 * on Alert, StatCard, and Flashcard text nodes.
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

import { AlertBlock } from '@/features/generative-ui/components/AlertBlock';
import { StatCardBlock } from '@/features/generative-ui/components/StatCardBlock';
import { FlashcardPreviewBlock } from '@/features/generative-ui/components/FlashcardPreviewBlock';

describe('dir="auto" on Alert, StatCard, and Flashcard text nodes', () => {
  it('puts dir="auto" on AlertTitle and AlertDescription', () => {
    render(
      <AlertBlock
        variant="info"
        title="Alert title עברית"
        description="Alert body مرحبا"
      />,
    );

    const title = screen.getByRole('heading', { name: 'Alert title עברית' });
    expect(title).toHaveAttribute('dir', 'auto');

    const description = screen.getByText('Alert body مرحبا');
    expect(description).toHaveAttribute('dir', 'auto');
  });

  it('puts dir="auto" on StatCard title, value, and subtitle', () => {
    render(
      <StatCardBlock
        title="Stat title العربية"
        value="42k مرحبا"
        subtitle="Subtitle עברית"
      />,
    );

    const title = screen.getByRole('heading', { name: 'Stat title العربية' });
    expect(title).toHaveAttribute('dir', 'auto');

    const value = screen.getByText('42k مرحبا');
    expect(value).toHaveAttribute('dir', 'auto');
    expect(value).toHaveAttribute('data-stat-value', '42k مرحبا');

    const subtitle = screen.getByText('Subtitle עברית');
    expect(subtitle.tagName).toBe('SPAN');
    expect(subtitle).toHaveAttribute('dir', 'auto');
  });

  it('puts dir="auto" on Flashcard front, back, deckName, and tags', () => {
    render(
      <FlashcardPreviewBlock
        front="Front text עברית"
        back="Back text مرحبا"
        deckName="Deck العربية"
        tags={['tag אחד', 'tag اثنين']}
      />,
    );

    expect(screen.getByText('Front text עברית')).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('Back text مرحبا')).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('Deck العربية')).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('tag אחד')).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('tag اثنين')).toHaveAttribute('dir', 'auto');
  });
});
