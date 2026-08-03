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

const hasId = (card: AnkiCard): card is AnkiCard & { id: string } =>
  typeof card.id === 'string' && card.id.trim() !== '';

const parseTimestamp = (value?: string): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const resolveFields = (card: AnkiCard): Record<string, string> => {
  if (card.fields && Object.keys(card.fields).length > 0) return card.fields;
  if (card.extra_fields && Object.keys(card.extra_fields).length > 0) return card.extra_fields;
  return {};
};

/**
 * 比较导出相关内容是否一致，用于识别“确有编辑”的卡。
 *
 * 注意：块快照卡经后端 `chat_v2_anki_cards_result` 落库时只保留
 * id/front/back/text/tags 等核心键，fields/extra_fields/template_id 会
 * 丢失（serde 默认空值）。因此当某一侧的字段/模板为空时视为“未知”而
 * 非“不同”，只比较双方都有值的维度，避免信息缺失的快照误判为编辑版。
 */
const cardContentEquals = (a: AnkiCard, b: AnkiCard): boolean => {
  const core = (card: AnkiCard) =>
    JSON.stringify({
      front: card.front ?? '',
      back: card.back ?? '',
      text: card.text ?? null,
      tags: card.tags ?? [],
    });
  if (core(a) !== core(b)) return false;

  const fieldsA = resolveFields(a);
  const fieldsB = resolveFields(b);
  const hasFieldsA = Object.keys(fieldsA).length > 0;
  const hasFieldsB = Object.keys(fieldsB).length > 0;
  if (hasFieldsA && hasFieldsB && JSON.stringify(fieldsA) !== JSON.stringify(fieldsB)) {
    return false;
  }

  const templateA = a.template_id ?? '';
  const templateB = b.template_id ?? '';
  if (templateA && templateB && templateA !== templateB) {
    return false;
  }

  return true;
};

/**
 * 判断块快照中的编辑副本是否应覆盖 DB 卡。
 *
 * 注意：块快照经后端反序列化时缺失的 updated_at 会被默认为“读取时刻”，
 * 时间戳不可尽信，因此以“内容是否确有差异”为主信号：
 * - 内容一致 → 使用 DB 权威副本（元数据更完整）
 * - 内容不同 → 视为用户在聊天块内的编辑，编辑副本覆盖；仅当双方
 *   时间戳都可解析且 DB 明确更新（DB > 快照）时才让 DB 胜出
 */
const shouldPreferEdited = (edited: AnkiCard, db: AnkiCard): boolean => {
  if (cardContentEquals(edited, db)) {
    return false;
  }
  const editedTime = parseTimestamp(edited.updated_at);
  const dbTime = parseTimestamp(db.updated_at);
  if (editedTime !== null && dbTime !== null && dbTime > editedTime) {
    return false;
  }
  return true;
};

/**
 * 任务页导出卡片来源选择（A9 修复）：
 *
 * 旧行为：只要聊天块快照非空就整批优先，DB 中新生成/新编辑的卡会被
 * 旧快照遮蔽（数量、内容都可能落后）。
 *
 * 新行为——以 DB 为权威基线、块快照仅补充/覆盖确有编辑的卡：
 * 1. 任一侧为空 → 直接返回另一侧（保持旧语义）
 * 2. 双方卡片均有 id → 按 id 合并：
 *    - DB 卡为基线（顺序、数量以 DB 为准）
 *    - 同 id 且块副本确有编辑（内容不同且 DB 未更新）→ 用块副本覆盖
 *    - 块快照独有的卡（如用户在聊天块内新增）→ 追加在末尾
 * 3. 存在无 id 的卡（旧版快照）→ 无法对齐，保留旧行为整批优先块副本
 *
 * 已知取舍：若用户在聊天块内删除了某张卡而 DB 仍保留，合并结果会
 * 重新包含该卡（DB 权威）；相比丢失新生成的卡，这是更安全的方向。
 */
export function selectTaskExportCards(
  editedCards: AnkiCard[] | null | undefined,
  dbCards: AnkiCard[],
): AnkiCard[] {
  if (!Array.isArray(editedCards) || editedCards.length === 0) {
    return dbCards;
  }
  if (!Array.isArray(dbCards) || dbCards.length === 0) {
    return editedCards;
  }

  const canMergeById = editedCards.every(hasId) && dbCards.every(hasId);
  if (!canMergeById) {
    // 传统场景（无 id 的旧快照）：无法按 id 对齐，保留“优先块副本”旧语义
    return editedCards;
  }

  const editedById = new Map<string, AnkiCard>();
  for (const card of editedCards) {
    if (hasId(card)) {
      editedById.set(card.id, card);
    }
  }

  const merged: AnkiCard[] = dbCards.map((dbCard) => {
    const edited = hasId(dbCard) ? editedById.get(dbCard.id) : undefined;
    if (edited && shouldPreferEdited(edited, dbCard)) {
      return edited;
    }
    return dbCard;
  });

  // 补充块快照独有的卡（DB 中不存在的 id），保持快照内原有顺序
  const dbIds = new Set(dbCards.filter(hasId).map((card) => card.id));
  for (const card of editedCards) {
    if (hasId(card) && !dbIds.has(card.id)) {
      merged.push(card);
    }
  }

  return merged;
}
