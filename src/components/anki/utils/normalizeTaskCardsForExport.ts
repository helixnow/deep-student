import type { AnkiCard } from '@/types';

/**
 * 任务页导出卡片归一化（与 ChatAnki 导出保持一致）
 *
 * - 保留 template_id，支持多模板导出
 * - 优先使用结构化字段，避免 front/back JSON 被错误降级
 */
export function normalizeTaskCardsForExport(cards: AnkiCard[]): AnkiCard[] {
  return cards.map((card) => ({
    ...card,
    front: card.front || card.fields?.Front || '',
    back: card.back || card.fields?.Back || '',
    tags: card.tags ?? [],
    images: card.images ?? [],
    extra_fields: card.extra_fields ?? card.fields ?? {},
  }));
}

/**
 * 任务页导出卡片来源选择：
 * - 优先使用聊天块中持久化的编辑后卡片
 * - 无可用编辑卡片时回退数据库原始卡片
 */
export function selectTaskExportCards(
  editedCards: AnkiCard[] | null | undefined,
  dbCards: AnkiCard[],
): AnkiCard[] {
  if (Array.isArray(editedCards) && editedCards.length > 0) {
    return editedCards;
  }
  return dbCards;
}
