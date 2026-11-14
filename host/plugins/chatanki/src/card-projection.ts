// Rust: chatanki_executor.rs:12476–12636 工具输出里的卡片投影与分页。
import type { AnkiCard } from '../api.ts';

export type ChatAnkiCardsFilter = 'all' | 'error_only' | 'edited_only';

export const CHATANKI_CARD_FIELD_LIMIT = 2_000;

function safeTruncateChars(value: string, maxChars: number): string {
  const chars = [...value];
  return chars.length <= maxChars ? value : chars.slice(0, maxChars).join('');
}

function truncateCardField(
  value: string, path: string, truncatedFields: string[],
): string {
  if ([...value].length <= CHATANKI_CARD_FIELD_LIMIT) return value;
  truncatedFields.push(path);
  return safeTruncateChars(value, CHATANKI_CARD_FIELD_LIMIT);
}

/** get_cards / library 的卡片投影：长字段按 2000 字符截断并报告路径。 */
export function convertCardForTool(
  card: AnkiCard, index: number | null,
): Record<string, unknown> {
  const truncatedFields: string[] = [];
  const front = truncateCardField(card.front, 'front', truncatedFields);
  const back = truncateCardField(card.back, 'back', truncatedFields);
  const text = card.text === null
    ? null
    : truncateCardField(card.text, 'text', truncatedFields);
  const tags = card.tags.map((value, tagIndex) =>
    truncateCardField(value, `tags[${tagIndex}]`, truncatedFields));
  const extraFields: Record<string, string> = {};
  for (const [key, value] of Object.entries(card.extra_fields)) {
    Object.defineProperty(extraFields, key, {
      value: truncateCardField(value, `extraFields.${key}`, truncatedFields),
      enumerable: true, writable: true, configurable: true,
    });
  }
  const errorContent = card.error_content === null
    ? null
    : truncateCardField(card.error_content, 'errorContent', truncatedFields);
  return {
    id: card.id,
    index,
    front,
    back,
    text,
    tags,
    templateId: card.template_id,
    extraFields,
    isErrorCard: card.is_error_card,
    errorContent,
    updatedAt: card.updated_at,
    version: card.updated_at,
    truncated: truncatedFields.length > 0,
    truncatedFields,
  };
}

export interface ChatAnkiCardsPage {
  total: number;
  items: Array<Record<string, unknown>>;
}

/** 先过滤再分页；index 是过滤前 1-based 位置。 */
export function selectChatankiCardsPage(
  cards: readonly AnkiCard[], filter: ChatAnkiCardsFilter, page: number, pageSize: number,
): ChatAnkiCardsPage {
  const filtered: Array<{ index: number; card: AnkiCard }> = [];
  cards.forEach((card, position) => {
    const keep = filter === 'all'
      || (filter === 'error_only' && card.is_error_card)
      || (filter === 'edited_only' && card.updated_at !== card.created_at);
    if (keep) filtered.push({ index: position + 1, card });
  });
  const offset = Math.max(page - 1, 0) * pageSize;
  return {
    total: filtered.length,
    items: filtered.slice(offset, offset + pageSize)
      .map(({ index, card }) => convertCardForTool(card, index)),
  };
}
