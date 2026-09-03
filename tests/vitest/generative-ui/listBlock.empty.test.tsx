import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string) => {
      if (key === 'blocks.list.empty') return '暂无条目';
      return key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

import { ListBlock } from '@/features/generative-ui/components/ListBlock';

describe('ListBlock empty state', () => {
  it('falls back to blocks.list.empty i18n when emptyLabel omitted', () => {
    render(<ListBlock items={[]} />);

    const empty = screen.getByText('暂无条目');
    expect(empty).toBeInTheDocument();
    expect(empty).toHaveAttribute('data-list-empty');
  });

  it('prefers emptyLabel over the i18n fallback', () => {
    render(<ListBlock items={[]} emptyLabel="没有记录" />);

    const empty = screen.getByText('没有记录');
    expect(empty).toBeInTheDocument();
    expect(empty).toHaveAttribute('data-list-empty');
    expect(screen.queryByText('暂无条目')).not.toBeInTheDocument();
  });
});
