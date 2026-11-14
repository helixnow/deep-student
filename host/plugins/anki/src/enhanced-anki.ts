/**
 * 增强 Anki 命令的纯逻辑（`src/cmd/enhanced_anki.rs:16-77`）：
 * Cloze 占位符识别与卡片更新前校验。
 */
import type { AnkiCard } from '../../../../contracts/ipc/generated/_shared.ts';

const U64_MAX = 18_446_744_073_709_551_615n;

function parseU64(digits: string): bigint | null {
  const value = BigInt(digits);
  return value > U64_MAX ? null : value;
}

/** `enhanced_anki.rs:16-56`：`{{c<正整数>::<非空答案>}}`（可带 `::提示`）。 */
export function hasValidClozeMarker(text: string): boolean {
  let searchFrom = 0;
  for (;;) {
    const relativeStart = text.slice(searchFrom).indexOf('{{c');
    if (relativeStart < 0) return false;
    const numberStart = searchFrom + relativeStart + 3;
    let digitCount = 0;
    while (numberStart + digitCount < text.length) {
      const code = text.charCodeAt(numberStart + digitCount);
      if (code < 0x30 || code > 0x39) break;
      digitCount += 1;
    }
    if (digitCount === 0) {
      searchFrom = numberStart;
      continue;
    }
    const numberEnd = numberStart + digitCount;
    const number = parseU64(text.slice(numberStart, numberEnd));
    if (number === null) {
      searchFrom = numberEnd;
      continue;
    }
    if (number === 0n || !text.startsWith('::', numberEnd)) {
      searchFrom = numberEnd;
      continue;
    }
    const answerStart = numberEnd + 2;
    const remainder = text.slice(answerStart);
    const relativeClose = remainder.indexOf('}}');
    if (relativeClose < 0) return false;
    const relativeNested = remainder.indexOf('{{c');
    if (relativeNested >= 0 && relativeNested < relativeClose) {
      searchFrom = answerStart + relativeNested;
      continue;
    }
    const body = remainder.slice(0, relativeClose);
    const separator = body.indexOf('::');
    const answer = separator < 0 ? body : body.slice(0, separator);
    if (answer.trim().length > 0) return true;
    searchFrom = answerStart + relativeClose + 2;
  }
}

/** 仅折叠 ASCII 大小写（Rust `eq_ignore_ascii_case`）。 */
function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

/** `enhanced_anki.rs:58-64`：`text` 字段、`extra_fields` 中的 `Text`、或 `front`。 */
export function hasValidClozeText(card: Pick<AnkiCard, 'text' | 'extra_fields' | 'front'>): boolean {
  if (card.text !== null && hasValidClozeMarker(card.text)) return true;
  for (const [field, value] of Object.entries(card.extra_fields)) {
    if (asciiLower(field.trim()) === 'text' && hasValidClozeMarker(value)) return true;
  }
  return hasValidClozeMarker(card.front);
}

/**
 * `enhanced_anki.rs:66-77`：Cloze 的 Text 是有效内容时允许空 back；
 * 其余情况必须同时有正反面。返回错误文案（`AppError::validation`），通过返回 null。
 */
export function validateAnkiCardUpdate(card: Pick<AnkiCard, 'text' | 'extra_fields' | 'front' | 'back'>): string | null {
  if (hasValidClozeText(card)) return null;
  if (card.front.trim().length === 0) return '卡片正面不能为空';
  if (card.back.trim().length === 0) return '卡片背面不能为空';
  return null;
}
