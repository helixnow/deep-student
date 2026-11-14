/**
 * 非流式生成的 JSON 卡片清洗与解码（`dstu-llm/src/llm_manager/model2_pipeline.rs:10026-10125`，
 * `AnkiCard` serde default 见 `dstu-core/src/models.rs:1381-1412`）。
 */
import type { AnkiCard } from '../../../../contracts/ipc/generated/_shared.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { nowRfc3339 } from './time.ts';


/** `clean_anki_json_response`（`model2_pipeline.rs:10026-10076`）。 */
export function cleanAnkiJsonResponse(content: string): string {
  let cleaned = rustTrim(content);
  cleaned = cleaned.replace(/```(?:json)?\s*/gu, '');
  cleaned = cleaned.replace(/```\s*$/u, '');

  const prefixes = [
    '以下是生成的Anki卡片：',
    'Anki卡片：',
    'JSON结果：',
    '卡片数据：',
    'Here are the Anki cards:',
    'Cards:',
    'JSON:',
    'Result:',
  ];
  for (const prefix of prefixes) {
    if (cleaned.startsWith(prefix)) {
      cleaned = rustTrim(cleaned.slice(prefix.length));
      break;
    }
  }

  if (!cleaned.startsWith('[')) {
    const start = cleaned.indexOf('[');
    if (start < 0) throw AppError.llm('无法找到JSON数组开始标记');
    cleaned = cleaned.slice(start);
  }
  if (!cleaned.endsWith(']')) {
    const end = cleaned.lastIndexOf(']');
    if (end < 0) throw AppError.llm('无法找到JSON数组结束标记');
    cleaned = cleaned.slice(0, end + 1);
  }
  return cleaned;
}

function jsonErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function serdeFieldType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'sequence';
  if (typeof value === 'string') return `string ${JSON.stringify(value)}`;
  if (typeof value === 'number') {
    return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``;
  }
  if (typeof value === 'boolean') return `boolean \`${value}\``;
  if (typeof value === 'object') return 'map';
  return 'unit';
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`invalid type: ${serdeFieldType(value)}, expected a string(field: ${field})`);
  }
  return value;
}

function expectStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`invalid type: ${serdeFieldType(value)}, expected a sequence(field: ${field})`);
  }
  return value.map((item) => expectString(item, field));
}

function expectStringMap(value: unknown, field: string): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`invalid type: ${serdeFieldType(value)}, expected a map(field: ${field})`);
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) out[key] = expectString(item, field);
  return out;
}

/**
 * `AnkiCard` 的 serde default 语义（`dstu-core/src/models.rs:1381-1412`）。
 * 非流式命令返回模型生成的卡片，缺省 id/task/时间/图片等由默认值补齐。
 */
function decodeGeneratedAnkiCard(value: unknown): AnkiCard {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`invalid type: ${serdeFieldType(value)}, expected struct AnkiCard`);
  }
  const record = value as Record<string, unknown>;
  const now = nowRfc3339();
  const text = record.text;
  const errorContent = record.error_content;
  const templateId = record.template_id;
  return {
    front: Object.hasOwn(record, 'front') ? expectString(record.front, 'front') : '',
    back: Object.hasOwn(record, 'back') ? expectString(record.back, 'back') : '',
    text: text === undefined || text === null ? null : expectString(text, 'text'),
    tags: Object.hasOwn(record, 'tags') ? expectStringArray(record.tags, 'tags') : [],
    images: Object.hasOwn(record, 'images') ? expectStringArray(record.images, 'images') : [],
    id: Object.hasOwn(record, 'id') && record.id !== '' ? expectString(record.id, 'id') : globalThis.crypto.randomUUID(),
    task_id: Object.hasOwn(record, 'task_id') ? expectString(record.task_id, 'task_id') : '',
    is_error_card: Object.hasOwn(record, 'is_error_card') && record.is_error_card === true,
    error_content: errorContent === undefined || errorContent === null
      ? null : expectString(errorContent, 'error_content'),
    created_at: Object.hasOwn(record, 'created_at') ? expectString(record.created_at, 'created_at') : now,
    updated_at: Object.hasOwn(record, 'updated_at') ? expectString(record.updated_at, 'updated_at') : now,
    extra_fields: Object.hasOwn(record, 'extra_fields')
      ? expectStringMap(record.extra_fields, 'extra_fields') : {},
    template_id: templateId === undefined || templateId === null
      ? null : expectString(templateId, 'template_id'),
  };
}

/** `parse_anki_cards_with_fallback`（`model2_pipeline.rs:10078-10125`）。 */
export function parseAnkiCardsWithFallback(jsonStr: string, originalContent: string): AnkiCard[] {
  let cardValues: unknown[];
  try {
    const parsed = JSON.parse(jsonStr) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error(`invalid type: ${serdeFieldType(parsed)}, expected a sequence`);
    }
    cardValues = parsed;
  } catch (error) {
    throw AppError.llm(`解析ANKI卡片JSON失败: ${jsonErrorText(error)} - 原始内容: ${originalContent}`);
  }

  for (const cardValue of cardValues) {
    if (typeof cardValue !== 'object' || cardValue === null || Array.isArray(cardValue)) continue;
    const obj = cardValue as Record<string, unknown>;
    if (Object.hasOwn(obj, 'question') && !Object.hasOwn(obj, 'front')) {
      obj.front = obj.question;
      delete obj.question;
    }
    if (!Object.hasOwn(obj, 'images')) obj.images = [];
  }

  let processedJson: string;
  try {
    processedJson = JSON.stringify(cardValues);
  } catch (error) {
    throw AppError.llm(`重新序列化卡片数据失败: ${jsonErrorText(error)}`);
  }
  try {
    return cardValues.map((value) => decodeGeneratedAnkiCard(value));
  } catch (error) {
    throw AppError.llm(`最终解析ANKI卡片失败: ${jsonErrorText(error)} - 处理后JSON: ${processedJson}`);
  }
}
