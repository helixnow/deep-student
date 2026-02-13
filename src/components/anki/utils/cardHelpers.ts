/**
 * Anki 卡片操作辅助函数
 *
 * 从 AnkiCardGeneration.tsx 提取的卡片操作相关函数
 */

import type { AnkiCard } from '@/types';

/**
 * 卡片选择映射结果
 */
export interface CardSelectionResult {
  /** 有效的卡片列表 */
  validCards: AnkiCard[];
  /** 有效的卡片 ID 列表 */
  validIds: string[];
  /** 无效的卡片 ID 列表 */
  invalidIds: string[];
}

/**
 * 错误卡片分离结果
 */
export interface ErrorCardSeparationResult {
  /** 非错误卡片列表 */
  validCards: AnkiCard[];
  /** 被跳过的卡片 ID 列表 */
  skippedIds: string[];
  /** 跳过的数量 */
  skippedCount: number;
}

/**
 * 将选中的卡片 ID 映射到对应的卡片
 *
 * @param cardIds - 选中的卡片 ID 集合
 * @param sourceCards - 源卡片数组
 * @returns 映射结果，包含有效卡片、有效 ID 和无效 ID
 */
export function mapSelectionToCards(
  cardIds: Set<string>,
  sourceCards: AnkiCard[],
): CardSelectionResult {
  const validCards: AnkiCard[] = [];
  const validIds: string[] = [];
  const invalidIds: string[] = [];
  const cardById = new Map(
    sourceCards
      .filter((card) => typeof card.id === 'string' && card.id.length > 0)
      .map((card) => [card.id as string, card]),
  );

  cardIds.forEach((cardId) => {
    const card = cardById.get(cardId);
    if (!card) {
      invalidIds.push(cardId);
      return;
    }
    validCards.push(card);
    validIds.push(cardId);
  });

  return { validCards, validIds, invalidIds };
}

/**
 * 分离错误卡片和有效卡片
 *
 * @param cards - 卡片数组
 * @param originIds - 原始卡片 ID 数组（可选）
 * @returns 分离结果，包含有效卡片、跳过的 ID 和跳过数量
 */
export function separateErrorCards(
  cards: AnkiCard[],
  originIds: string[] = [],
): ErrorCardSeparationResult {
  const validCards: AnkiCard[] = [];
  const skippedIds: string[] = [];
  let skippedCount = 0;

  cards.forEach((card, idx) => {
    if (card?.is_error_card) {
      skippedCount += 1;
      if (originIds[idx]) {
        skippedIds.push(originIds[idx]);
      }
      return;
    }
    validCards.push(card);
  });

  return { validCards, skippedIds, skippedCount };
}

/**
 * 检查两张卡片是否重复
 *
 * @param existingCard - 已存在的卡片
 * @param newCard - 新卡片
 * @param noteType - 笔记类型（用于判断 Cloze 类型）
 * @returns 是否重复
 */
export function isDuplicateCard(
  existingCard: AnkiCard,
  newCard: AnkiCard,
  noteType: string = 'Basic',
): boolean {
  if (noteType === 'Cloze') {
    const existingText = existingCard.text || existingCard.front || '';
    const newText = newCard.text || newCard.front || '';
    return existingText === newText && existingText.length > 0;
  }
  return (
    existingCard.front === newCard.front &&
    existingCard.back === newCard.back
  );
}

/**
 * 过滤重复卡片
 *
 * @param cards - 卡片数组
 * @param existingCards - 已存在的卡片数组
 * @param noteType - 笔记类型
 * @returns 去重后的卡片数组
 */
export function filterDuplicateCards(
  cards: AnkiCard[],
  existingCards: AnkiCard[],
  noteType: string = 'Basic',
): AnkiCard[] {
  return cards.filter(
    (newCard) =>
      !existingCards.some((existing) =>
        isDuplicateCard(existing, newCard, noteType)
      )
  );
}

/**
 * 计算卡片统计信息
 *
 * @param cards - 卡片数组
 * @returns 统计信息
 */
export function getCardStats(cards: AnkiCard[]): {
  total: number;
  valid: number;
  error: number;
} {
  const total = cards.length;
  const error = cards.filter((c) => c.is_error_card).length;
  return {
    total,
    valid: total - error,
    error,
  };
}
