/**
 * Anki 卡片/文档任务的数据库行解码与输入解码
 * （`dstu-storage/src/database/mod.rs:4754-4788,4874-4993,5196-5235,7546-7598`、
 * `dstu-core/src/models.rs:1380-1412,1660-1713`、`dstu-anki/src/anki_gold_set.rs:362-406`）。
 */
import type { AnkiCard, DocumentTask, TaskStatus } from '../../../../contracts/ipc/generated/_shared.ts';

/** `anki_cards` 两套 SELECT 共用的 13 列。 */
export interface AnkiCardRow {
  id: string;
  task_id: string;
  front: string | null;
  back: string | null;
  text: string | null;
  tags_json: string | null;
  images_json: string | null;
  is_error_card: number;
  error_content: string | null;
  created_at: string;
  updated_at: string;
  extra_fields_json: string | null;
  template_id: string | null;
}

/** `get_tasks_for_document` 的 10 列。 */
export interface DocumentTaskRow {
  id: string;
  document_id: string;
  original_document_name: string;
  segment_index: number;
  content_segment: string;
  status: string;
  created_at: string;
  updated_at: string;
  error_message: string | null;
  anki_generation_options_json: string;
}

/** `serde_json::from_str::<Vec<String>>(..).ok().unwrap_or_default()`。 */
export function decodeJsonStringArray(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? (value as string[]) : [];
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}

/** `serde_json::from_str::<HashMap<String, String>>(..).ok().unwrap_or_default()`。 */
export function decodeExtraFields(raw: string | null): Record<string, string> {
  if (raw === null) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    for (const item of Object.values(value)) {
      if (typeof item !== 'string') return {};
    }
    return { ...(value as Record<string, string>) };
  } catch (error) {
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}

/** `query_map` 的 `AnkiCard` 构造（`front`/`back` 的 NULL 回退为空串）。 */
export function decodeAnkiCardRow(row: AnkiCardRow): AnkiCard {
  return {
    front: row.front ?? '',
    back: row.back ?? '',
    text: row.text,
    tags: decodeJsonStringArray(row.tags_json),
    images: decodeJsonStringArray(row.images_json),
    id: row.id,
    task_id: row.task_id,
    is_error_card: row.is_error_card !== 0,
    error_content: row.error_content,
    created_at: row.created_at,
    updated_at: row.updated_at,
    extra_fields: decodeExtraFields(row.extra_fields_json),
    template_id: row.template_id,
  };
}

const TASK_STATUSES: readonly TaskStatus[] = [
  'Pending',
  'Processing',
  'Streaming',
  'Paused',
  'Completed',
  'Failed',
  'Truncated',
  'Cancelled',
];

/** `TaskStatus::from_str`：未知值回退 `Pending`。 */
export function decodeTaskStatus(value: string): TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value) ? (value as TaskStatus) : 'Pending';
}

export function decodeDocumentTaskRow(row: DocumentTaskRow): DocumentTask {
  return {
    id: row.id,
    document_id: row.document_id,
    original_document_name: row.original_document_name,
    segment_index: row.segment_index,
    content_segment: row.content_segment,
    status: decodeTaskStatus(row.status),
    created_at: row.created_at,
    updated_at: row.updated_at,
    error_message: row.error_message,
    anki_generation_options_json: row.anki_generation_options_json,
  };
}

/** serde_json 反序列化 `AnkiCard` 失败；`message` 是 serde 的错误文本（不带 Tauri 前缀）。 */
export class AnkiCardDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnkiCardDecodeError';
  }
}

/** Rust `{:?}` 的 `&str` 转义，与 kernel serde 相同。 */
function rustDebugString(value: string): string {
  let out = '"';
  for (const ch of value) {
    switch (ch) {
      case '"': out += '\\"'; break;
      case '\\': out += '\\\\'; break;
      case '\n': out += '\\n'; break;
      case '\r': out += '\\r'; break;
      case '\t': out += '\\t'; break;
      case '\0': out += '\\0'; break;
      default:
        out += /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u.test(ch)
          ? `\\u{${ch.codePointAt(0)!.toString(16)}}`
          : ch;
    }
  }
  return out + '"';
}

/** serde `Unexpected` 显示；app 图开启 arbitrary_precision，所以数字一律是 `number`。 */
function unexpectedOf(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return `boolean \`${value}\``;
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return `string ${rustDebugString(value)}`;
  if (Array.isArray(value)) return 'sequence';
  return 'map';
}

function invalidType(value: unknown, expected: string): never {
  throw new AnkiCardDecodeError(`invalid type: ${unexpectedOf(value)}, expected ${expected}`);
}

function expectString(value: unknown): string {
  return typeof value === 'string' ? value : invalidType(value, 'a string');
}

function expectOptionString(value: unknown): string | null {
  return value === null ? null : expectString(value);
}

function expectStringVec(value: unknown): string[] {
  if (!Array.isArray(value)) invalidType(value, 'a sequence');
  return value.map(expectString);
}

function expectStringMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalidType(value, 'a map');
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) out[key] = expectString(item);
  return out;
}

/**
 * `AnkiCard` 输入解码（`models.rs:1380-1412,1777-1783`）。`#[serde(default)]` 只覆盖缺失字段；
 * 显式错类型（含非 Option 字段上的 null）按 serde 报错，按输入键顺序报第一个错误，未知字段忽略。
 */
export function decodeAnkiCardInput(raw: Record<string, unknown>, now: () => string): AnkiCard {
  const card: Partial<AnkiCard> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    switch (key) {
      case 'front': card.front = expectString(value); break;
      case 'back': card.back = expectString(value); break;
      case 'text': card.text = expectOptionString(value); break;
      case 'tags': card.tags = expectStringVec(value); break;
      case 'images': card.images = expectStringVec(value); break;
      case 'id': card.id = expectString(value); break;
      case 'task_id': card.task_id = expectString(value); break;
      case 'is_error_card':
        card.is_error_card = typeof value === 'boolean' ? value : invalidType(value, 'a boolean');
        break;
      case 'error_content': card.error_content = expectOptionString(value); break;
      case 'created_at': card.created_at = expectString(value); break;
      case 'updated_at': card.updated_at = expectString(value); break;
      case 'extra_fields': card.extra_fields = expectStringMap(value); break;
      case 'template_id': card.template_id = expectOptionString(value); break;
      default: break;
    }
  }
  return {
    front: card.front ?? '',
    back: card.back ?? '',
    text: card.text ?? null,
    tags: card.tags ?? [],
    images: card.images ?? [],
    id: card.id ?? globalThis.crypto.randomUUID(),
    task_id: card.task_id ?? '',
    is_error_card: card.is_error_card ?? false,
    error_content: card.error_content ?? null,
    created_at: card.created_at ?? now(),
    updated_at: card.updated_at ?? now(),
    extra_fields: card.extra_fields ?? {},
    template_id: card.template_id ?? null,
  };
}

/** `anki_gold_set.rs:53,55`（唯一事实来源在 `anki-gold-set.ts`）。 */
export { CONTENT_PROVENANCE_FIELD, PROVENANCE_ACTOR_USER } from './anki-gold-set.ts';
import { insertContentProvenance, userContentProvenance } from './anki-gold-set.ts';

/**
 * `insert_content_provenance(&mut card.extra_fields, &ContentProvenance::user(code))`
 * （`anki_gold_set.rs:373-406`）：覆盖写入 last-writer-wins 的用户编辑戳。
 */
export function insertUserContentProvenance(
  extraFields: Record<string, string>,
  code: string,
  at: string,
): void {
  insertContentProvenance(extraFields, { ...userContentProvenance(code), at });
}
