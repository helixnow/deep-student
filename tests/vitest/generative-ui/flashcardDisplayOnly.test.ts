import { describe, expect, it } from 'vitest';
import { resolveGenerativeUIChatActionHandlers } from '@/features/generative-ui/bridge/resolveGenerativeUIChatActionHandlers';
import { buildFlashcardPreviewIntent } from '@/features/generative-ui/utils/buildFlashcardPreviewIntent';
import type { GenerativeUIIntent } from '@/features/generative-ui/types';

describe('Generative UI flashcard previews', () => {
  it('builds a display-only preview without a save action', () => {
    const intent = buildFlashcardPreviewIntent({
      front: 'What is FSRS?',
      back: 'A scheduling algorithm',
      tags: ['anki'],
      labels: { metaTitle: 'Preview' },
    });

    expect(intent.blocks).toEqual([
      {
        type: 'flashcard-preview',
        props: {
          front: 'What is FSRS?',
          back: 'A scheduling algorithm',
          tags: ['anki'],
          deckName: undefined,
        },
      },
    ]);
    expect(resolveGenerativeUIChatActionHandlers({ intent })).not.toHaveProperty('save-to-library');
  });

  it('does not register a legacy save action supplied by an external intent', () => {
    const intent: GenerativeUIIntent = {
      version: '1',
      blocks: [
        {
          type: 'flashcard-preview',
          props: { front: 'Q', back: 'A' },
        },
        {
          type: 'action-bar',
          props: {
            actions: [{
              id: 'save-to-library',
              label: 'Save',
              riskLevel: 'medium',
            }],
          },
        },
      ],
    };

    expect(resolveGenerativeUIChatActionHandlers({ intent })).not.toHaveProperty('save-to-library');
  });
});
