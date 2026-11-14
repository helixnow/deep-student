// Rust: src/chat_v2/tools/chatanki_executor.rs 的 retemplate fill_missing_llm Phase 2
// 纯函数（prompt / 响应解析 / 字段落位）。CAS 写回与 LLM 调用不在本模块。
//
// `AnkiRetemplateCardUpdate` / `AnkiRetemplateMissingField` 镜像 dstu-storage 的
// 同名结构；L16 发布卡片仓储 API 后应改为消费其契约。
import type {
  AnkiCard, AnkiCardVersionUpdate, AnkiRetemplateCardUpdate, AnkiRetemplateMissingField,
} from '../api.ts';
import type { ChatAnkiRetemplateStrategy } from './executor-args.ts';
import { convertCardForTool } from './executor-args.ts';
import { errorText } from './execution.ts';
import { objectLastWins, parseJsonDocument, type JsonNode } from '../../../platform/util/json-exact.ts';
import { rustTrim } from '../../../platform/util/text.ts';
import { compareUtf8 } from '../../../platform/util/utf8.ts';

export type { AnkiRetemplateCardUpdate, AnkiRetemplateMissingField } from '../api.ts';

export const CHATANKI_RETEMPLATE_FILL_BATCH_SIZE = 8;
export const CHATANKI_RETEMPLATE_FILL_FIELD_CHAR_LIMIT = 800;

export interface RetemplateFillOutcome {
  status: 'filled' | 'partial' | 'skipped' | 'conflict' | 'failed';
  filledFields: string[];
  error: string | null;
}

export function retemplateFillSkipped(reason: string): RetemplateFillOutcome {
  return { status: 'skipped', filledFields: [], error: reason };
}

export function retemplateFillFailed(error: string): RetemplateFillOutcome {
  return { status: 'failed', filledFields: [], error };
}

function safeTruncateChars(value: string, maxChars: number): string {
  const chars = [...value];
  return chars.length <= maxChars ? value : chars.slice(0, maxChars).join('');
}

/** 与 database 层字段别名匹配一致的宽松键归一化（ASCII 字母数字 + 小写）。 */
export function normalizeRetemplateFillKey(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

/** 为一批缺字段卡构建严格 JSON 输出的补字段 prompt。 */
export function buildRetemplateFillPrompt(
  targetNoteType: string, batch: readonly AnkiRetemplateCardUpdate[],
): string {
  let prompt = '';
  prompt += '你是 Anki 卡片字段补全助手。以下卡片刚更换为目标模板，部分模板字段缺失。\n';
  prompt += `目标 noteType：${targetNoteType}\n\n`;
  prompt += '规则：\n';
  prompt += '1. 只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。\n';
  prompt += '2. 输出格式：{"cards":[{"cardId":"...","fields":{"字段名":"字段值"}}]}\n';
  prompt += '3. fields 里只允许出现该卡列出的缺失字段名，字段名必须逐字一致。\n';
  prompt += '4. 只根据卡片现有内容推断；无法可靠推断的字段直接省略，禁止编造。\n';
  prompt += '5. 字段值使用与卡片内容相同的语言，保持简洁。\n\n';
  prompt += '卡片列表：\n';
  batch.forEach((update, index) => {
    prompt += `[card ${index + 1}]\n`;
    prompt += `cardId: ${update.card.id}\n`;
    prompt += '现有内容：\n';
    const pushField = (name: string, value: string): void => {
      const trimmed = rustTrim(value);
      if (trimmed.length === 0) return;
      prompt += `- ${name}: ${safeTruncateChars(trimmed, CHATANKI_RETEMPLATE_FILL_FIELD_CHAR_LIMIT)}\n`;
    };
    pushField('front', update.source.front);
    pushField('back', update.source.back);
    if (update.source.text !== null) pushField('text', update.source.text);
    for (const key of Object.keys(update.source.extra_fields).sort(compareUtf8)) {
      pushField(key, update.source.extra_fields[key] ?? '');
    }
    const missing = update.missingFields.map((entry) =>
      entry.required ? `${entry.field}（必填）` : entry.field);
    prompt += `缺失字段：${missing.join(', ')}\n\n`;
  });
  return prompt;
}

/** `serde_json::from_str::<Value>`: serde's syntax error text and position, last-wins duplicate keys. */
function parseFillDocument(raw: string): JsonNode {
  try {
    return parseJsonDocument(raw);
  } catch (error) {
    throw new Error(`fill response is not valid JSON: ${errorText(error)}`);
  }
}

function member(node: JsonNode | undefined, key: string): JsonNode | undefined {
  return node?.kind === 'object' ? objectLastWins(node).get(key) : undefined;
}

/** 解析 LLM 响应为 cardId -> (字段名 -> 非空值)；容忍代码块，丢弃空值/非字符串。 */
export function parseRetemplateFillResponse(
  raw: string,
): Map<string, Map<string, string>> {
  const start = raw.indexOf('{');
  if (start === -1) throw new Error('fill response contains no JSON object');
  const end = raw.lastIndexOf('}');
  if (end < start) throw new Error('fill response contains no JSON object');
  const cards = member(parseFillDocument(raw.slice(start, end + 1)), 'cards');
  if (cards?.kind !== 'array') throw new Error('fill response missing cards array');
  const generated = new Map<string, Map<string, string>>();
  for (const rawCard of cards.items) {
    const rawCardId = member(rawCard, 'cardId');
    if (rawCardId?.kind !== 'string') continue;
    const cardId = rustTrim(rawCardId.value);
    if (cardId.length === 0) continue;
    const rawFields = member(rawCard, 'fields');
    if (rawFields?.kind !== 'object') continue;
    let entry = generated.get(cardId);
    if (entry === undefined) {
      entry = new Map<string, string>();
      generated.set(cardId, entry);
    }
    for (const [field, value] of objectLastWins(rawFields)) {
      if (value.kind !== 'string') continue;
      const trimmed = rustTrim(value.value);
      if (trimmed.length === 0) continue;
      entry.set(field, trimmed);
    }
  }
  for (const [cardId, fields] of generated) {
    if (fields.size === 0) generated.delete(cardId);
  }
  return generated;
}

function cloneCard(card: AnkiCard): AnkiCard {
  return {
    ...card,
    tags: [...card.tags],
    images: [...card.images],
    extra_fields: { ...card.extra_fields },
  };
}

/** 只允许填 missingFields 中列出的字段（精确 -> 归一化两级匹配）。 */
export function applyRetemplateFillToCard(
  update: AnkiRetemplateCardUpdate, generated: Record<string, string> | Map<string, string>,
): { card: AnkiCard; filledFields: string[] } {
  const source = generated instanceof Map ? generated : new Map(Object.entries(generated));
  const normalizedGenerated = new Map<string, string>();
  for (const key of [...source.keys()].sort(compareUtf8)) {
    const normalized = normalizeRetemplateFillKey(key);
    if (normalized.length === 0) continue;
    if (!normalizedGenerated.has(normalized)) {
      normalizedGenerated.set(normalized, source.get(key) ?? '');
    }
  }

  const filledCard = cloneCard(update.card);
  const filledFields: string[] = [];
  for (const missing of update.missingFields) {
    const value = source.get(missing.field)
      ?? normalizedGenerated.get(normalizeRetemplateFillKey(missing.field));
    if (value === undefined) continue;
    filledCard.extra_fields[missing.field] = value;
    filledFields.push(missing.field);
  }
  return { card: filledCard, filledFields };
}

/**
 * Phase 2 single-card CAS write-back. Mutates `update` in place on success so the
 * payload's missingFields/version match the persisted terminal state.
 */
export function writeRetemplateFill(
  update: AnkiRetemplateCardUpdate,
  generated: Record<string, string> | Map<string, string>,
  casUpdate: (card: AnkiCard, expectedVersion: string) => AnkiCardVersionUpdate,
): RetemplateFillOutcome {
  const { card: filledCard, filledFields } = applyRetemplateFillToCard(update, generated);
  if (filledFields.length === 0) {
    return retemplateFillSkipped('llm_returned_no_matching_fields');
  }
  const expectedVersion = update.card.updated_at;
  let outcome: AnkiCardVersionUpdate;
  try {
    outcome = casUpdate(filledCard, expectedVersion);
  } catch (caught) {
    return retemplateFillFailed(`fill write failed: ${errorText(caught)}`);
  }
  if (outcome.kind === 'updated') {
    update.card = cloneCard(outcome.card);
    update.missingFields = update.missingFields.filter(
      (missing) => !filledFields.includes(missing.field),
    );
    return {
      status: update.missingFields.length === 0 ? 'filled' : 'partial',
      filledFields,
      error: null,
    };
  }
  if (outcome.kind === 'conflict') {
    update.card = cloneCard(outcome.current);
    return { status: 'conflict', filledFields: [], error: 'version_conflict' };
  }
  return retemplateFillFailed('card_not_found');
}

export function retemplateFillSummary(
  outcomes: ReadonlyMap<string, RetemplateFillOutcome>,
): Record<string, number> {
  const count = (status: RetemplateFillOutcome['status']): number =>
    [...outcomes.values()].filter((outcome) => outcome.status === status).length;
  return {
    attempted: outcomes.size,
    filled: count('filled'),
    partial: count('partial'),
    skipped: count('skipped'),
    conflicts: count('conflict'),
    failed: count('failed'),
  };
}

/** chatanki_executor.rs:12959–13016. */
export function retemplateUpdateForTool(
  update: AnkiRetemplateCardUpdate,
  strategy: ChatAnkiRetemplateStrategy,
  fill: RetemplateFillOutcome | null,
): Record<string, unknown> {
  const output = convertCardForTool(update.card, null);
  output.missingFields = update.missingFields.map((missing) => missing.field);
  output.missingFieldDetails = update.missingFields.map((missing) => ({
    field: missing.field,
    required: missing.required,
  }));
  const includeSource = (strategy === 'fill_missing' || strategy === 'fill_missing_llm')
    && update.missingFields.length > 0;
  if (includeSource) output.source = convertCardForTool(update.source, null);
  if (strategy === 'fill_missing_llm') {
    if (fill === null) {
      output.fillStatus = 'not_needed';
      output.filledFields = [];
    } else {
      output.fillStatus = fill.status;
      output.filledFields = [...fill.filledFields];
      if (fill.error !== null) output.fillError = fill.error;
    }
  }
  return output;
}
