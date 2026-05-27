import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AskUserBlockComponent } from '@/features/chat/plugins/blocks/askUserBlock';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'askUser.sourceUserClick': 'User choice',
        'askUser.sourceCustomInput': 'Custom input',
        'askUser.sourceMixed': 'Mixed selection',
        'askUser.sourceNoResponse': 'No response recorded',
        'askUser.sourceChannelClosed': 'Connection lost',
        'askUser.selected': 'Selected',
        'askUser.noResponse': '(No response)',
      };
      return translations[key] || (params?.defaultValue as string) || key;
    },
  }),
}));

describe('AskUserBlockComponent', () => {
  it('does not show a countdown for legacy timeout metadata', () => {
    render(
      <AskUserBlockComponent
        block={{
          id: 'ask-block-active',
          type: 'ask_user',
          status: 'running',
          messageId: 'msg-active',
          toolCallId: 'ask-active',
          toolInput: {
            question: 'How should we continue?',
            options: ['Default route (Recommended)', 'Stop here'],
            multiple: false,
            allowCustom: false,
            timeoutSeconds: 45,
          },
        } as any}
      />,
    );

    expect(screen.queryByText('45s')).not.toBeInTheDocument();
  });

  it('does not describe an empty result as auto-selected', () => {
    render(
      <AskUserBlockComponent
        block={{
          id: 'ask-block-1',
          type: 'ask_user',
          status: 'success',
          messageId: 'msg-1',
          toolCallId: 'ask-1',
          toolInput: {
            question: 'Which option should we use?',
            options: ['Option A (Recommended)', 'Option B'],
            multiple: false,
            allowCustom: false,
          },
          toolOutput: {
            result: {
              question: 'Which option should we use?',
              selected: [],
              selected_indices: [],
              custom_text: null,
              source: 'channel_closed',
              options: ['Option A (Recommended)', 'Option B'],
              multiple: false,
            },
          },
        } as any}
      />,
    );

    expect(screen.getByText('Selected:')).toBeInTheDocument();
    expect(screen.getByText('(No response)')).toBeInTheDocument();
    expect(screen.queryByText(/Auto-selected/i)).not.toBeInTheDocument();
  });
});
