import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { ProgressBlock } from '@/features/generative-ui/components/ProgressBlock';
import { formatGenerativeNumber } from '@/features/generative-ui/utils/formatGenerativeNumber';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN' },
  }),
}));

describe('ProgressBlock locale format', () => {
  it('formats default current/total and percent with formatGenerativeNumber', () => {
    render(<ProgressBlock current={3} total={10} />);

    const labelEl = document.querySelector('[data-progress-label]');
    const percentEl = document.querySelector('[data-progress-percent]');

    expect(labelEl).toBeTruthy();
    expect(labelEl).toHaveTextContent(
      `${formatGenerativeNumber(3)} / ${formatGenerativeNumber(10)}`,
    );
    expect(percentEl).toHaveTextContent(`${formatGenerativeNumber(30)}%`);
  });

  it('uses automatic direction for generated title and label text', () => {
    render(<ProgressBlock title="Completion" current={3} total={10} label="Three done" />);

    expect(document.querySelector('[role="region"] [id]')).toHaveAttribute('dir', 'auto');
    expect(document.querySelector('[data-progress-label]')).toHaveAttribute('dir', 'auto');
  });
});
