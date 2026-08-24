/**
 * 只读闪卡预览 — 确定性意图构建
 *
 * 持久化统一由 anki_cards 管线负责，以保留 QA / critic 处理与审计信息。
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
  };
}

export function buildFlashcardPreviewIntent(input: FlashcardPreviewInput): GenerativeUIIntent {
  return {
    version: '1',
    meta: {
      title: input.labels.metaTitle,
      description: input.labels.metaDescription,
    },
    blocks: [{
      type: 'flashcard-preview',
      props: {
        front: input.front,
        back: input.back,
        tags: input.tags,
        deckName: input.deckName,
      },
    }],
  };
}
