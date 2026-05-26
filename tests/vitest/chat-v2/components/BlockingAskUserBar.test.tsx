import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BlockingAskUserBar } from '@/features/chat/components/input-bar/BlockingAskUserBar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'askUser.recommended': 'Recommended',
        'askUser.responded': 'Responded',
        'askUser.customPlaceholder': 'Or enter a custom answer...',
        'askUser.ignore': 'Ignore',
        'askUser.submit': 'Submit',
        'askUser.optionReasonLabel': 'Why this option',
      };
      return translations[key] || (params?.defaultValue as string) || key;
    },
  }),
}));

describe('BlockingAskUserBar', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a hover affordance for options that include an llm reason', () => {
    vi.useFakeTimers();

    render(
      <BlockingAskUserBar
        interaction={{
          kind: 'ask_user',
          blockId: 'block-1',
          toolCallId: 'tool-1',
          question: 'Which direction should we take?',
          options: [
            { label: 'Add hover rationale (Recommended)', reason: 'This keeps the main UI clean while still exposing model intent on demand.' },
            'Keep the current compact UI',
          ],
          multiple: false,
          allowCustom: false,
          timeoutSeconds: null,
        } as any}
      />
    );

    const reasonButtons = screen.getAllByRole('button', { name: 'Why this option' });
    expect(reasonButtons).toHaveLength(1);

    fireEvent.mouseEnter(reasonButtons[0]);

    act(() => {
      vi.advanceTimersByTime(150);
    });

    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'This keeps the main UI clean while still exposing model intent on demand.'
    );
  });

  it('does not render a hover affordance when options have no reason metadata', () => {
    render(
      <BlockingAskUserBar
        interaction={{
          kind: 'ask_user',
          blockId: 'block-2',
          toolCallId: 'tool-2',
          question: 'Which format should I use?',
          options: ['Table (Recommended)', 'Bullets'],
          multiple: false,
          allowCustom: false,
          timeoutSeconds: null,
        } as any}
      />
    );

    expect(screen.queryByRole('button', { name: 'Why this option' })).not.toBeInTheDocument();
  });
});
