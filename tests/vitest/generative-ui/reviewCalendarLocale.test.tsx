import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { ReviewCalendarBlock } from '@/features/generative-ui/components/ReviewCalendarBlock';
import { formatGenerativeDate } from '@/features/generative-ui/utils/formatGenerativeDate';
import { formatGenerativeNumber } from '@/features/generative-ui/utils/formatGenerativeNumber';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN' },
  }),
}));

describe('formatGenerativeDate', () => {
  it('formats YYYY-MM-DD with Intl medium date for the local date', () => {
    const expected = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(
      new Date(2026, 7, 24),
    );
    expect(formatGenerativeDate('2026-08-24', 'en-US')).toBe(expected);
  });

  it('returns non-date strings unchanged', () => {
    expect(formatGenerativeDate('soon')).toBe('soon');
  });
});

describe('ReviewCalendarBlock locale format', () => {
  it('keeps ISO dateTime and exposes a locale-formatted due count', () => {
    render(<ReviewCalendarBlock days={[{ date: '2026-08-24', dueCount: 4 }]} />);

    const timeEl = document.querySelector('time');
    expect(timeEl).toBeTruthy();
    expect(timeEl).toHaveAttribute('dateTime', '2026-08-24');
    expect(timeEl).toHaveAttribute('dir', 'auto');

    const badge = document.querySelector('[data-due-count]');
    expect(badge).toHaveAttribute('data-due-count', formatGenerativeNumber(4));
  });
});
