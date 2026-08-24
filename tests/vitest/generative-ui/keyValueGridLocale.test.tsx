import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

import { KeyValueGridBlock } from '@/features/generative-ui/components/KeyValueGridBlock';
import { formatGenerativeStatValue } from '@/features/generative-ui/utils/formatGenerativeNumber';

describe('KeyValueGridBlock locale format', () => {
  it('formats numeric-looking values and leaves non-numeric strings as-is', () => {
    render(
      <KeyValueGridBlock
        title="Details"
        rows={[
          { key: 'Due', value: '1200' },
          { key: 'Note', value: 'hello' },
        ]}
      />,
    );

    const values = document.querySelectorAll('[data-kv-value]');
    expect(document.querySelector('[role="region"] [id]')).toHaveAttribute('dir', 'auto');
    expect(document.querySelector('dt')).toHaveAttribute('dir', 'auto');
    expect(values).toHaveLength(2);
    expect(values[0]).toHaveAttribute('dir', 'auto');
    expect(values[0]?.textContent).toBe(formatGenerativeStatValue('1200'));
    expect(values[1]?.textContent).toBe('hello');
  });
});
