import { describe, it, expect, vi } from 'vitest';
import { extractFlashcardsFromIntent, flashcardPreviewToAnkiCards } from '@/features/generative-ui/utils/extractFlashcardsFromIntent';
import { buildFlashcardPreviewIntent } from '@/features/generative-ui/utils/buildFlashcardPreviewIntent';
import { createFlashcardSaveActionHandlers } from '@/features/generative-ui/handlers/flashcardActionHandlers';
import { resolveGenerativeUIChatActionHandlers } from '@/features/generative-ui/bridge/resolveGenerativeUIChatActionHandlers';

vi.mock('@/features/chat/anki', () => ({
  saveCardsToLibrary: vi.fn(async () => ({ success: true, savedCount: 1 })),
}));

import { saveCardsToLibrary } from '@/features/chat/anki';

describe('extractFlashcardsFromIntent', () => {
  it('extracts flashcard-preview blocks from intent', () => {
    const intent = buildFlashcardPreviewIntent({
      front: 'Q',
      back: 'A',
      tags: ['math'],
      labels: { metaTitle: 'Preview', saveToLibrary: 'Save' },
    });
    const cards = extractFlashcardsFromIntent(intent);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ front: 'Q', back: 'A', tags: ['math'] });
  });

  it('maps preview data to anki card shape', () => {
    const ankiCards = flashcardPreviewToAnkiCards([{ front: 'F', back: 'B', tags: ['t'] }]);
    expect(ankiCards[0]).toMatchObject({
      front: 'F',
      back: 'B',
      tags: ['t'],
      images: [],
    });
  });
});

describe('createFlashcardSaveActionHandlers', () => {
  it('calls saveCardsToLibrary with cards from intent', async () => {
    const intent = buildFlashcardPreviewIntent({
      front: 'What is FSRS?',
      back: 'A scheduling algorithm',
      labels: { metaTitle: 'Card', saveToLibrary: 'Save' },
    });
    const handlers = createFlashcardSaveActionHandlers(
      intent,
      { blockId: 'blk-1', businessSessionId: 'sess-1' },
      { saveToLibrary: 'Save' },
    );

    await handlers['save-to-library']!.handler();

    expect(saveCardsToLibrary).toHaveBeenCalledWith({
      cards: [
        expect.objectContaining({
          front: 'What is FSRS?',
          back: 'A scheduling algorithm',
        }),
      ],
      context: {
        blockId: 'blk-1',
        businessSessionId: 'sess-1',
      },
    });
  });
});

describe('resolveGenerativeUIChatActionHandlers flashcard', () => {
  it('includes save-to-library when intent has flashcard action-bar', () => {
    const intent = buildFlashcardPreviewIntent({
      front: 'Q',
      back: 'A',
      labels: { metaTitle: 'Preview', saveToLibrary: 'Save' },
    });
    const handlers = resolveGenerativeUIChatActionHandlers({ intent });
    expect(handlers['save-to-library']).toBeDefined();
  });
});
