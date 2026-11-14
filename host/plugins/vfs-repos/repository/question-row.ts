import { logWarn } from './logger.ts';
import type { Row } from '../../../platform/storage/api.ts';
import { JsonSyntaxError, parseJsonDocument, type JsonNode } from '../../../platform/util/index.ts';
import { VfsRepositoryError, type JsonValue, type Question, type QuestionImage, type QuestionOption, type SourceRef } from '../api.ts';
import { difficultyFromStr, questionStatusFromStr, questionTypeFromStr, sourceTypeFromStr } from '../src/question-types.ts';
import { parseSyncImages, parseSyncOptions, parseSyncTags } from './question-sync-json.ts';

export const questionColumns = ['id', 'exam_id', 'card_id', 'question_label', 'content', 'options_json',
  'answer', 'explanation', 'question_type', 'difficulty', 'tags', 'status', 'user_answer', 'is_correct',
  'attempt_count', 'correct_count', 'last_attempt_at', 'user_note', 'is_favorite', 'is_bookmarked',
  'source_type', 'source_ref', 'images_json', 'parent_id', 'created_at', 'updated_at', 'ai_feedback',
  'ai_score', 'ai_graded_at', 'structured_data', 'group_id', 'group_position', 'source_key', 'provenance_json', 'answer_origin'];
export const selectQuestionColumns = (prefix = '') => questionColumns.map(c => `${prefix}${c}`).join(',');
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string');
export function parseJson(raw: string | null): JsonValue {
  if (raw === null) return null;
  try { return JSON.parse(raw) as JsonValue; }
  catch (error) { logWarn('[VFS::QuestionRepo] JSON parse error:', error); return null; }
}
export function parseImages(raw: string | null): QuestionImage[] {
  return decodeImages(parseJson(raw));
}
/** serde `Vec<QuestionImage>` 解码；不符合时为 `[]`（调用方的 `unwrap_or_default`）。 */
export function decodeImages(value: unknown): QuestionImage[] {
  if (!Array.isArray(value) || !value.every(v => record(v) && ['id', 'name', 'mime', 'hash'].every(k => typeof v[k] === 'string') && (v.role == null || typeof v.role === 'string'))) return [];
  return value.map(v => {
    const row = v as Record<string, JsonValue>;
    return { id: row.id as string, name: row.name as string, mime: row.mime as string, hash: row.hash as string, ...(row.role == null ? {} : { role: row.role as string }) };
  });
}
export function parseSourceRefs(value: unknown): SourceRef[] {
  if (!Array.isArray(value) || !value.every(v => record(v) && typeof v.source_id === 'string'
    && (v.page == null || (typeof v.page === 'number' && Number.isInteger(v.page) && v.page >= 0 && v.page <= 0xffff_ffff))
    && (v.bbox == null || (Array.isArray(v.bbox) && v.bbox.length === 4 && v.bbox.every(n => typeof n === 'number'))))) return [];
  return value.map(v => ({ source_id: v.source_id as string, page: v.page ?? null, bbox: v.bbox ?? null }));
}
function parseOptions(raw: string | null): QuestionOption[] | null {
  return decodeOptions(parseJson(raw));
}
/** serde `Vec<QuestionOption>` 解码；不符合时为 `null`（调用方的 `.ok()`）。 */
export function decodeOptions(value: unknown): QuestionOption[] | null {
  return Array.isArray(value) && value.every(v => record(v) && typeof v.key === 'string' && typeof v.content === 'string')
    ? value.map(v => ({ key: (v as Record<string, string>).key!, content: (v as Record<string, string>).content! })) : null;
}
export function rowToQuestion(row: Row): Question {
  const read = (key: string, type: 'string' | 'number', nullable = false): string | number | null => {
    const value = row[key];
    if (value === null && nullable) return null;
    if (typeof value !== type || (type === 'number' && (!Number.isInteger(value) || Number(value) < -2147483648 || Number(value) > 2147483647))) {
      const kind = value === null ? 'Null' : typeof value === 'string' ? 'Text' : typeof value === 'number' ? Number.isInteger(value) ? 'Integer' : 'Real' : 'Blob';
      throw new VfsRepositoryError('VFS_STORAGE', `Database error: Invalid column type ${kind} at index: ${questionColumns.indexOf(key)}, name: ${key}`);
    }
    return value as string | number;
  };
  const text = (key: string) => read(key, 'string') as string;
  const opt = (key: string) => read(key, 'string', true) as string | null;
  const int = (key: string) => read(key, 'number') as number;
  const optInt = (key: string) => read(key, 'number', true) as number | null;
  const tags = parseJson(opt('tags'));
  const provenance = parseJson(opt('provenance_json'));
  const correct = optInt('is_correct');
  const difficulty = opt('difficulty');
  return {
    id: text('id'), exam_id: text('exam_id'), card_id: opt('card_id'), question_label: opt('question_label'),
    content: text('content'), options: parseOptions(opt('options_json')), answer: opt('answer'), explanation: opt('explanation'),
    structured_data: parseJson(opt('structured_data')), question_type: questionTypeFromStr(opt('question_type') ?? ''),
    difficulty: difficulty === null ? null : difficultyFromStr(difficulty), tags: isStringArray(tags) ? tags : [],
    status: questionStatusFromStr(opt('status') ?? ''), user_answer: opt('user_answer'), is_correct: correct === null ? null : correct !== 0,
    attempt_count: int('attempt_count'), correct_count: int('correct_count'), last_attempt_at: opt('last_attempt_at'),
    user_note: opt('user_note'), is_favorite: int('is_favorite') !== 0, is_bookmarked: int('is_bookmarked') !== 0,
    source_type: sourceTypeFromStr(opt('source_type') ?? ''), source_ref: opt('source_ref'), images: parseImages(opt('images_json')),
    parent_id: opt('parent_id'), created_at: text('created_at'), updated_at: text('updated_at'), ai_feedback: opt('ai_feedback'),
    ai_score: optInt('ai_score'), ai_graded_at: opt('ai_graded_at'), group_id: opt('group_id'), group_position: optInt('group_position'),
    group_label: null, materials: [], answer_origin: opt('answer_origin'),
    source_refs: parseSourceRefs(record(provenance) ? provenance.source_refs : null),
    answer_source_refs: parseSourceRefs(record(provenance) ? provenance.answer_source_refs : null), source_key: opt('source_key'),
  };
}

export function mapSkippingErrors<T>(rows: Row[], parse: (row: Row) => T): T[] {
  const result: T[] = [];
  for (const row of rows) {
    try { result.push(parse(row)); }
    catch (error) { logWarn('[VFS::QuestionRepo] Row parse error (skipped):', error); }
  }
  return result;
}

/** `question_sync_service.rs:1615-1620` 的 30 列（questionColumns 前 30 项同序）。 */
export const syncQuestionColumns = questionColumns.slice(0, 30);
/** `get_question_by_id` 的结果：`structured_data` 为 serde_json Value 树（None → null），仅供本仓储计算哈希。 */
export type SyncQuestion = Omit<Question, 'structured_data'> & { structured_data: JsonNode | null };
/**
 * `QuestionSyncService::get_question_by_id` 的行映射（question_sync_service.rs:1626-1712）。
 * 任一 `row.get` 类型/范围转换失败返回 `null`，调用方按 `.map_err(|_| NotFound)` 处理；
 * 不读 group/provenance/answer_origin（Rust 用 `..Default::default()`）。
 */
export function rowToSyncQuestion(row: Row): SyncQuestion | null {
  let invalid = false;
  const cell = (key: string, type: 'string' | 'number', nullable: boolean): string | number | null => {
    const value = row[key];
    if (value === null && nullable) return null;
    if (typeof value !== type || (type === 'number' && (!Number.isInteger(value) || Number(value) < -2147483648 || Number(value) > 2147483647))) {
      invalid = true;
      return type === 'string' ? '' : 0;
    }
    return value as string | number;
  };
  const text = (key: string) => cell(key, 'string', false) as string;
  const opt = (key: string) => cell(key, 'string', true) as string | null;
  const int = (key: string) => cell(key, 'number', false) as number;
  const optInt = (key: string) => cell(key, 'number', true) as number | null;
  const options = parseSyncOptions(opt('options_json'));
  const tags = parseSyncTags(opt('tags'));
  const questionType = opt('question_type');
  const difficulty = opt('difficulty');
  const status = opt('status');
  const sourceType = opt('source_type');
  const correct = optInt('is_correct');
  const favorite = int('is_favorite');
  const bookmarked = int('is_bookmarked');
  const images = parseSyncImages(opt('images_json'));
  const structuredRaw = opt('structured_data');
  // dstu-vfs 启用 arbitrary_precision + preserve_order：保留 Value 树，哈希时按 serde 输出，不经 Number。
  let structured: JsonNode | null = null;
  if (structuredRaw !== null && !invalid) {
    try {
      const node = parseJsonDocument(structuredRaw);
      structured = node.kind === 'null' ? null : node;
    } catch (error) {
      if (!(error instanceof JsonSyntaxError)) throw error;
      logWarn(`[QuestionSyncService] Failed to parse structured_data: ${error.message}`);
    }
  }
  const question: SyncQuestion = {
    id: text('id'), exam_id: text('exam_id'), card_id: opt('card_id'), question_label: opt('question_label'),
    content: text('content'), options, answer: opt('answer'), explanation: opt('explanation'),
    structured_data: structured, question_type: questionTypeFromStr(questionType ?? ''),
    difficulty: difficulty === null ? null : difficultyFromStr(difficulty), tags,
    status: questionStatusFromStr(status ?? ''), user_answer: opt('user_answer'), is_correct: correct === null ? null : correct !== 0,
    attempt_count: int('attempt_count'), correct_count: int('correct_count'), last_attempt_at: opt('last_attempt_at'),
    user_note: opt('user_note'), is_favorite: favorite !== 0, is_bookmarked: bookmarked !== 0,
    source_type: sourceTypeFromStr(sourceType ?? ''), source_ref: opt('source_ref'), images,
    parent_id: opt('parent_id'), created_at: text('created_at'), updated_at: text('updated_at'), ai_feedback: opt('ai_feedback'),
    ai_score: optInt('ai_score'), ai_graded_at: opt('ai_graded_at'), group_id: null, group_position: null,
    group_label: null, materials: [], answer_origin: null, source_refs: [], answer_source_refs: [], source_key: null,
  };
  return invalid ? null : question;
}
