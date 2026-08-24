/**
 * 闪卡预览 + 保存 action-bar — 确定性意图构建
 */

import type { GenerativeUIIntent } from '../types';

export interface FlashcardPreviewInput {
  front: string;
  back: string;
  tags?: string[];
  deckName?: string;
  labels: {
    metaTitle: string;
    metaDescription?: string;
    saveToLibrary: string;
  };
}

export function buildFlashcardPreviewIntent(input: FlashcardPreviewInput): GenerativeUIIntent {
  return {
    version: '1',
    meta: {
      title: input.labels.metaTitle,
      description: input.labels.metaDescription,
    },
    blocks: [
      {
        type: 'flashcard-preview',
        props: {
          front: input.front,
          back: input.back,
          tags: input.tags,
          deckName: input.deckName,
        },
      },
      {
        type: 'action-bar',
        props: {
          actions: [
            {
              id: 'save-to-library',
              label: input.labels.saveToLibrary,
              variant: 'primary',
              riskLevel: 'medium',
            },
          ],
        },
      },
    ],
  };
}
