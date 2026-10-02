/**
 * 卡片在列表里的显示标题 / 摘要（卡片库、今日「接下来」共用）。
 *
 * 生成时 front 列可能落在模板的辅助字段上（选择题正面成了「高等数学」、蓝图模板成了
 * 「LMT-01」），填空卡的 front 则是带 {{cN::…}} 的原文。列表要的是真正的题面与答案：
 * 先按语义字段取值，再回退 front/back，填空标记统一折叠为「[…]」。
 */
const FRONT_FIELD_KEYS = ['question', 'term', 'word', 'name', 'symbol', 'title', 'text', 'front'];
const BACK_FIELD_KEYS = ['answer', 'definition', 'explanation', 'expl', 'detail', 'backdetail', 'meaning', 'back'];
const CLOZE_PATTERN = /\{\{c\d+::([\s\S]*?)(?:::[\s\S]*?)?\}\}/g;

export interface DisplayableCard {
  front?: string | null;
  back?: string | null;
  text?: string | null;
  fields?: Record<string, string> | null;
  extra_fields?: Record<string, string> | null;
  extraFields?: Record<string, string> | null;
}

/** 列表里遮住填空答案，避免标题直接剧透 */
export function collapseCloze(value: string): string {
  return value.replace(CLOZE_PATTERN, '[…]');
}

function pickField(card: DisplayableCard, keys: string[]): string {
  const merged: Record<string, unknown> = {
    ...(card.fields ?? {}),
    ...(card.extra_fields ?? {}),
    ...(card.extraFields ?? {}),
  };
  const byLower = new Map<string, string>();
  for (const [key, value] of Object.entries(merged)) {
    if (key.startsWith('_') || typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed && !byLower.has(key.toLowerCase())) byLower.set(key.toLowerCase(), trimmed);
  }
  for (const key of keys) {
    const value = byLower.get(key);
    if (value) return value;
  }
  return '';
}

export function cardDisplayFront(card: DisplayableCard): string {
  const raw = pickField(card, FRONT_FIELD_KEYS) || card.front || card.fields?.Front || card.text || '';
  return collapseCloze(raw);
}

export function cardDisplayBack(card: DisplayableCard): string {
  const front = cardDisplayFront(card);
  const semantic = collapseCloze(pickField(card, BACK_FIELD_KEYS));
  if (semantic && semantic !== front) return semantic;
  const fallback = collapseCloze(card.back || card.fields?.Back || '');
  return fallback !== front ? fallback : '';
}
