// Rust: src/chat_v2/tools/chatanki_executor.rs 的偏好观察提取纯函数。
// 持久化（settings + anki_preference_memory consolidate）不在本模块。
import type { AnkiCard } from '../api.ts';
import { normalizeTemplateCardFieldKey, templateAliases } from './executor-args.ts';
import { rustTrim } from '../../../platform/util/text.ts';
import { compareUtf8 } from '../../../platform/util/utf8.ts';

export interface CardEditObservation {
  field: string;
  before: string;
  after: string;
}

export interface CardDeleteObservation {
  front: string;
  back: string;
}

export interface PreferenceDeletionObservation {
  deletions: CardDeleteObservation[];
  generatedCount: number;
}

/** 只记录 trim 后真正变化的字段；同步过的模板别名不重复记录。 */
export function cardEditObservations(
  before: AnkiCard, after: AnkiCard,
): CardEditObservation[] {
  const edits: CardEditObservation[] = [];
  const frontChanged = rustTrim(before.front) !== rustTrim(after.front);
  const backChanged = rustTrim(before.back) !== rustTrim(after.back);
  const beforeText = before.text ?? '';
  const afterText = after.text ?? '';
  const textChanged = rustTrim(beforeText) !== rustTrim(afterText);

  const push = (field: string, oldValue: string, newValue: string): void => {
    if (rustTrim(oldValue) !== rustTrim(newValue)) {
      edits.push({ field, before: oldValue, after: newValue });
    }
  };
  push('front', before.front, after.front);
  push('back', before.back, after.back);
  push('text', beforeText, afterText);

  const keys = new Set([...Object.keys(before.extra_fields), ...Object.keys(after.extra_fields)]);
  for (const key of [...keys].sort(compareUtf8)) {
    const normalized = normalizeTemplateCardFieldKey(key);
    const mirrorsChangedCanonical = (frontChanged && templateAliases('front').includes(normalized))
      || (backChanged && templateAliases('back').includes(normalized))
      || (textChanged && templateAliases('text').includes(normalized));
    if (mirrorsChangedCanonical) continue;
    push(`extra_fields.${key}`, before.extra_fields[key] ?? '', after.extra_fields[key] ?? '');
  }
  return edits;
}

/** 删除观察排除诊断错误卡（isErrorCard）。 */
export function deletionPreferenceObservation(
  deletedCards: readonly AnkiCard[], generatedCount: number,
): PreferenceDeletionObservation {
  return {
    deletions: deletedCards
      .filter((card) => !card.is_error_card)
      .map((card) => ({ front: card.front, back: card.back })),
    generatedCount,
  };
}
