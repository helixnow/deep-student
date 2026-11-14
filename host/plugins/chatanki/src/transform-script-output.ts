// Rust: src/chat_v2/tools/chatanki_transform_script.rs — 输出合同（$CHATANKI_OUTPUT）校验。
import type { AnkiCard } from '../api.ts';
import type { TransformFields } from './transform.ts';
import { errorText } from './execution.ts';
import {
  CHATANKI_OUTPUT_FILE, CHATANKI_TRANSFORM_SCRIPT_FIELD_MAX_CHARS, CHATANKI_TRANSFORM_SCRIPT_ID_MAX_CHARS,
  CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_BYTES, CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_ENTRIES,
  CHATANKI_TRANSFORM_SCRIPT_TAG_MAX_CHARS, CHATANKI_TRANSFORM_SCRIPT_TAGS_LIMIT, SCRIPT_ISSUE_ECHO_MAX_CHARS,
  charCount,
} from './transform-script-spec.ts';
import { rustTrim } from '../../../platform/util/text.ts';

// ============================================================================
// 输出合同（$CHATANKI_OUTPUT）校验
// ============================================================================

/** 顶层输出不可用（整批失败，不写库）。 */
export type ScriptOutputErrorKind = 'too_large' | 'parse' | 'schema';

export class ScriptOutputError extends Error {
  readonly kind: ScriptOutputErrorKind;
  readonly bytes: number | null;
  readonly limit: number | null;

  constructor(kind: ScriptOutputErrorKind, detail: string, bytes: number | null = null, limit: number | null = null) {
    super(kind === 'too_large' && bytes !== null && limit !== null
      ? `${CHATANKI_OUTPUT_FILE} is ${bytes} bytes, exceeding the ${limit} byte limit`
      : detail);
    this.name = 'ScriptOutputError';
    this.kind = kind;
    this.bytes = bytes;
    this.limit = limit;
  }

  detail(): string {
    return this.message;
  }
}

/** 单卡输出条目被拒绝的结构化原因（不整批失败，逐卡 invalid）。 */
export interface ScriptCardIssue {
  code: 'unknown_output_field' | 'empty_field' | 'invalid_field_type' | 'field_too_large'
    | 'tag_too_large' | 'tags_limit_exceeded' | 'invalid_cloze_text';
  detail: string;
}

export type ScriptCardPlan =
  | { ok: true; fields: TransformFields }
  | { ok: false; issue: ScriptCardIssue };

/** 输出评估结果：与选择集**等长且同序**的逐卡计划。 */
export interface ScriptTransformEvaluation {
  cardPlans: ScriptCardPlan[];
  /** 输出中出现但不在快照内的 id（v1 禁止脚本增删卡，逐项报告）。 */
  unknownCardIds: string[];
}

const SCRIPT_OUTPUT_UPDATE_KEYS = ['front', 'back', 'text', 'tags'];
const SCRIPT_OUTPUT_ECHO_KEYS = ['id', 'version', 'index', 'templateId', 'extraFields'];

/** 与 `database::contains_valid_anki_cloze_markup` 同语义：至少一个 `{{cN::非空答案}}`。 */
export function textHasValidClozeMarkup(text: string): boolean {
  let cursor = 0;
  while (cursor <= text.length) {
    const relativeStart = text.indexOf('{{c', cursor);
    if (relativeStart === -1) return false;
    const start = relativeStart + 3;
    let digitEnd = start;
    while (digitEnd < text.length) {
      const code = text.charCodeAt(digitEnd);
      if (code < 0x30 || code > 0x39) break;
      digitEnd += 1;
    }
    if (digitEnd === start) {
      cursor = start;
      continue;
    }
    const digits = text.slice(start, digitEnd);
    let clozeNumber = Number(digits);
    // Rust `parse::<usize>()` fails on overflow and falls back to 0.
    if (!Number.isSafeInteger(clozeNumber) || digits.length > 20) clozeNumber = 0;
    const afterNumber = text.slice(digitEnd);
    if (clozeNumber === 0 || !afterNumber.startsWith('::')) {
      cursor = start;
      continue;
    }
    const body = afterNumber.slice(2);
    const close = body.indexOf('}}');
    if (close === -1) {
      cursor = start;
      continue;
    }
    const answer = body.slice(0, close).split('::')[0] ?? '';
    if (rustTrim(answer).length > 0) return true;
    cursor = start + digits.length;
  }
  return false;
}

function truncateEcho(value: string, maxChars: number): string {
  if (charCount(value) <= maxChars) return value;
  let truncated = '';
  let taken = 0;
  for (const char of value) {
    if (taken === maxChars) break;
    truncated += char;
    taken += 1;
  }
  return `${truncated}…`;
}

function jsonTypeName(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  if (Array.isArray(value)) return 'array';
  return 'object';
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 从一条输出条目构造变换后的字段快照（逐卡规则见 Rust 注释）。 */
export function evaluateScriptCardEntry(
  entry: Record<string, unknown>, before: TransformFields,
): ScriptCardPlan {
  // app 图开启 serde_json preserve_order（src-tauri/Cargo.toml:101）：Map 按输出 JSON 的书写顺序迭代，
  // 报告的是第一个出现的未知键（chatanki_transform_script.rs:316）。
  for (const key of Object.keys(entry)) {
    if (!SCRIPT_OUTPUT_UPDATE_KEYS.includes(key) && !SCRIPT_OUTPUT_ECHO_KEYS.includes(key)) {
      return {
        ok: false,
        issue: {
          code: 'unknown_output_field',
          detail: `output card contains unsupported field '${truncateEcho(key, SCRIPT_ISSUE_ECHO_MAX_CHARS)}' ` +
            '(v1 allows front/back/text/tags updates only)',
        },
      };
    }
  }

  const after: TransformFields = { ...before, tags: [...before.tags] };

  for (const field of ['front', 'back', 'text'] as const) {
    const value = entry[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      return {
        ok: false,
        issue: {
          code: 'invalid_field_type',
          detail: `output card field '${field}' must be a string or null, got ${jsonTypeName(value)}`,
        },
      };
    }
    if (rustTrim(value).length === 0) {
      return {
        ok: false,
        issue: {
          code: 'empty_field',
          detail: `output card sets '${field}' to an empty string (clearing fields is not allowed in v1)`,
        },
      };
    }
    const unchanged = field === 'front' ? value === before.front
      : field === 'back' ? value === before.back
        : value === before.text;
    if (!unchanged && charCount(value) > CHATANKI_TRANSFORM_SCRIPT_FIELD_MAX_CHARS) {
      return {
        ok: false,
        issue: {
          code: 'field_too_large',
          detail: `output card sets '${field}' to ${charCount(value)} characters, ` +
            `exceeding the ${CHATANKI_TRANSFORM_SCRIPT_FIELD_MAX_CHARS} character limit`,
        },
      };
    }
    if (field === 'front') after.front = value;
    else if (field === 'back') after.back = value;
    else after.text = value;
  }

  const rawTags = entry.tags;
  if (rawTags !== undefined && rawTags !== null) {
    if (!Array.isArray(rawTags)) {
      return {
        ok: false,
        issue: {
          code: 'invalid_field_type',
          detail: `output card field 'tags' must be an array or null, got ${jsonTypeName(rawTags)}`,
        },
      };
    }
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const rawTag of rawTags) {
      if (typeof rawTag !== 'string') {
        return {
          ok: false,
          issue: { code: 'invalid_field_type', detail: 'output card tags must be an array of strings' },
        };
      }
      const tag = rustTrim(rawTag);
      if (tag.length === 0) {
        return {
          ok: false,
          issue: { code: 'empty_field', detail: 'output card tags must not contain empty entries' },
        };
      }
      if (charCount(tag) > CHATANKI_TRANSFORM_SCRIPT_TAG_MAX_CHARS && !before.tags.includes(tag)) {
        return {
          ok: false,
          issue: {
            code: 'tag_too_large',
            detail: `output card carries a ${charCount(tag)} character tag, ` +
              `exceeding the ${CHATANKI_TRANSFORM_SCRIPT_TAG_MAX_CHARS} character limit`,
          },
        };
      }
      if (!seen.has(tag)) {
        seen.add(tag);
        tags.push(tag);
      }
    }
    if (tags.length > CHATANKI_TRANSFORM_SCRIPT_TAGS_LIMIT) {
      return {
        ok: false,
        issue: {
          code: 'tags_limit_exceeded',
          detail: `output card carries ${tags.length} unique tags, ` +
            `exceeding the ${CHATANKI_TRANSFORM_SCRIPT_TAGS_LIMIT} limit`,
        },
      };
    }
    after.tags = tags;
  }

  if (after.text !== before.text && after.text !== null && !textHasValidClozeMarkup(after.text)) {
    return {
      ok: false,
      issue: {
        code: 'invalid_cloze_text',
        detail: "output card sets 'text' without a valid {{cN::answer}} cloze marker",
      },
    };
  }

  return { ok: true, fields: after };
}

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

/** 校验脚本输出并生成逐卡计划（顶层错误整批失败，逐卡错误只影响该卡）。 */
export function evaluateScriptOutput(
  raw: Uint8Array, selected: readonly AnkiCard[],
): ScriptTransformEvaluation {
  if (raw.length > CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_BYTES) {
    throw new ScriptOutputError('too_large', '', raw.length, CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_BYTES);
  }
  let text: string;
  try {
    text = UTF8_DECODER.decode(raw);
  } catch (error) {
    throw new ScriptOutputError('parse', `output is not valid JSON: ${errorText(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ScriptOutputError('parse', `output is not valid JSON: ${errorText(error)}`);
  }
  if (!isJsonObject(parsed)) {
    throw new ScriptOutputError('schema', "output root must be a JSON object with a 'cards' array");
  }
  if (!Object.hasOwn(parsed, 'cards')) {
    throw new ScriptOutputError('schema', "output root is missing the required 'cards' array");
  }
  const cards = parsed.cards;
  if (!Array.isArray(cards)) {
    throw new ScriptOutputError('schema', "'cards' must be a JSON array");
  }
  if (cards.length > CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_ENTRIES) {
    throw new ScriptOutputError('schema',
      `'cards' contains ${cards.length} entries, exceeding the ` +
      `${CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_ENTRIES} entry limit`);
  }

  const entries = new Map<string, Record<string, unknown>>();
  const order: string[] = [];
  for (const [index, entry] of cards.entries()) {
    if (!isJsonObject(entry)) {
      throw new ScriptOutputError('schema', `cards[${index}] must be a JSON object`);
    }
    const rawId = entry.id;
    if (typeof rawId !== 'string') {
      throw new ScriptOutputError('schema', `cards[${index}] is missing a string 'id'`);
    }
    const id = rustTrim(rawId);
    if (id.length === 0) throw new ScriptOutputError('schema', `cards[${index}] has an empty 'id'`);
    if (charCount(id) > CHATANKI_TRANSFORM_SCRIPT_ID_MAX_CHARS) {
      throw new ScriptOutputError('schema',
        `cards[${index}] has a ${charCount(id)} character 'id', exceeding the ` +
        `${CHATANKI_TRANSFORM_SCRIPT_ID_MAX_CHARS} character limit`);
    }
    if (entries.has(id)) throw new ScriptOutputError('schema', `cards contains duplicate id '${id}'`);
    entries.set(id, entry);
    order.push(id);
  }

  const snapshotIds = new Set(selected.map((card) => card.id));
  const unknownCardIds = order.filter((id) => !snapshotIds.has(id));
  const cardPlans = selected.map((card): ScriptCardPlan => {
    const before: TransformFields = transformFieldsFromCard(card);
    const entry = entries.get(card.id);
    return entry === undefined
      ? { ok: true, fields: before }
      : evaluateScriptCardEntry(entry, before);
  });
  return { cardPlans, unknownCardIds };
}

function transformFieldsFromCard(card: AnkiCard): TransformFields {
  return { front: card.front, back: card.back, text: card.text, tags: [...card.tags] };
}


