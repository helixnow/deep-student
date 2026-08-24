/**
 * 从 Generative UI 意图中提取 flashcard-preview 块数据
 */

import type { GenerativeUIIntent } from '../types';
import type { FlashcardPreviewProps } from '../components/FlashcardPreviewBlock';

export interface FlashcardPreviewData {
  front: string;
  back: string;
  tags?: string[];
  deckName?: string;
}

export function extractFlashcardsFromIntent(intent: GenerativeUIIntent): FlashcardPreviewData[] {
  return intent.blocks
    .filter((block) => block.type === 'flashcard-preview')
    .map((block) => block.props as FlashcardPreviewProps)
    .filter((props) => Boolean(props?.front && props?.back))
    .map((props) => ({
      front: props.front,
      back: props.back,
      tags: props.tags,
      deckName: props.deckName,
    }));
}

/** 将 flashcard-preview 数据映射为 AnkiCard 保存格式 */
export function flashcardPreviewToAnkiCards(cards: FlashcardPreviewData[]) {
  return cards.map((card, index) => ({
    id: `gen-ui-flashcard-${index}`,
    front: card.front,
    back: card.back,
    tags: card.tags ?? [],
    images: [] as string[],
  }));
}
