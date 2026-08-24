/**
 * 闪卡预览场景 action handlers — save-to-library 走 chat/anki 管线
 */

import { saveCardsToLibrary } from '@/features/chat/anki';
import type { GenerativeActionDefinition } from '../types';
import {
  extractFlashcardsFromIntent,
  flashcardPreviewToAnkiCards,
} from '../utils/extractFlashcardsFromIntent';
import type { GenerativeUIIntent } from '../types';

export interface FlashcardSaveContext {
  blockId?: string;
  messageStableId?: string;
  businessSessionId?: string;
  documentId?: string;
  templateId?: string;
}

export interface FlashcardActionLabels {
  saveToLibrary: string;
}

export function createFlashcardSaveActionHandlers(
  intent: GenerativeUIIntent,
  context: FlashcardSaveContext,
  labels: FlashcardActionLabels,
): Record<string, GenerativeActionDefinition> {
  const previewCards = extractFlashcardsFromIntent(intent);
  const ankiCards = flashcardPreviewToAnkiCards(previewCards);

  return {
    'save-to-library': {
      id: 'save-to-library',
      label: labels.saveToLibrary,
      riskLevel: 'medium',
      handler: async () => {
        if (ankiCards.length === 0) {
          throw new Error('No flashcard-preview blocks in intent');
        }
        const result = await saveCardsToLibrary({
          cards: ankiCards,
          context: {
            blockId: context.blockId,
            messageStableId: context.messageStableId,
            businessSessionId: context.businessSessionId,
            documentId: context.documentId,
            templateId: context.templateId,
          },
        });
        if (!result.success) {
          throw new Error(result.error ?? 'Failed to save flashcards');
        }
      },
    },
  };
}
