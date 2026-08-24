/**
 * Contract: mixed-language generative text uses dir="auto"
 * on List, Steps, and Table user-text nodes.
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

import { ListBlock } from '@/features/generative-ui/components/ListBlock';
import { StepsBlock } from '@/features/generative-ui/components/StepsBlock';
import { TableBlock } from '@/features/generative-ui/components/TableBlock';

describe('dir="auto" on List, Steps, and Table user text', () => {
  it('puts dir="auto" on List title and item label/description/badge', () => {
    render(
      <ListBlock
        title="List title עברית"
        items={[
          {
            id: '1',
            label: 'Item label العربية',
            description: 'Item description مرحبا',
            badge: 'Badge אחד',
          },
        ]}
      />,
    );

    expect(screen.getByRole('heading', { name: 'List title עברית' })).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('Item label العربية')).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('Item description مرحبا')).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('Badge אחד')).toHaveAttribute('dir', 'auto');
  });

  it('puts dir="auto" on Steps title and step label/description/durationLabel', () => {
    render(
      <StepsBlock
        title="Steps title العربية"
        steps={[
          {
            id: 's1',
            label: 'Step label עברית',
            description: 'Step description مرحبا',
            durationLabel: '10 min אחד',
            status: 'active',
          },
        ]}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Steps title العربية' })).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('Step label עברית')).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('Step description مرحبا')).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('10 min אחד')).toHaveAttribute('dir', 'auto');
  });

  it('puts dir="auto" on Table title, caption, header labels, and cells', () => {
    render(
      <TableBlock
        title="Table title עברית"
        caption="Caption العربية"
        columns={[
          { key: 'name', label: 'Name אחד' },
          { key: 'score', label: 'Score اثنين' },
        ]}
        rows={[{ name: 'Alice مرحبا', score: '98 עברית' }]}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Table title עברית' })).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('Caption العربية')).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('Name אחד')).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('Score اثنين')).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('Alice مرحبا')).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('98 עברית')).toHaveAttribute('dir', 'auto');
  });
});
