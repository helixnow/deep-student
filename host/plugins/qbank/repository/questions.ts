/** VFS question repository, mirroring src-tauri/crates/dstu-vfs/src/vfs/repos/question_repo.rs. */
import { nanoid } from 'nanoid';
import type { SqlExecutor, SqlValue } from '../../../platform/storage/api.ts';
import { rfc3339Now } from '../../../platform/storage/time.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import type { QuestionRepository } from '../../vfs-repos/api.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';
import { valueFromStr } from '../src/raw-json-number.ts';
import type {
  CreateQuestionParams, Question, QuestionFilters, QuestionHistory, QuestionImage, QuestionListResult,
  QuestionMaterial, QuestionOption, QuestionSearchFilters, QuestionSearchListResult, QuestionSearchResult,
  AnswerSubmission, BatchResult, UpdateQuestionParams,
  dstu_vfs__vfs__repos__question_repo__QuestionBankStats as QuestionBankStats,
} from '../api.ts';
import {
  difficultyFrom, enumList, questionTypeFrom, sourceTypeFrom, statusFrom, toDifficulty, toQuestionType,
  toSearchSortBy, toSourceType, toStatus, type Difficulty, type QuestionStatus, type QuestionType, type SourceType,
} from '../src/question-enums.ts';

export const MAX_SEARCH_KEYWORD_LENGTH = 200;

export function utcNow(): string {
  return rfc3339Now();
}

export function localDate(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function str(value: SqlValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}
function requiredStr(value: SqlValue | undefined): string {
  return typeof value === 'string' ? value : '';
}
function num(value: SqlValue | undefined): number | null {
  return typeof value === 'number' ? value : null;
}
function int(value: SqlValue | undefined, fallback = 0): number {
  return typeof value === 'number' ? Math.trunc(value) : fallback;
}
function flag(value: SqlValue | undefined): boolean {
  return int(value) !== 0;
}
function boolOrNull(value: SqlValue | undefined): boolean | null {
  const current = num(value);
  return current === null ? null : current !== 0;
}
function jsonValue(value: SqlValue | undefined): unknown | null {
  const text = str(value);
  if (text === null || text.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed === null ? null : parsed;
  } catch {
    return null;
  }
}
/** `question_repo.rs:3416-3427`：`serde_json::from_str::<Value>`，Null/解析失败为 None，数字原文保留。 */
function structuredData(value: SqlValue | undefined): JsonValue | null {
  const text = str(value);
  if (text === null) return null;
  try { return valueFromStr(text); } catch { return null; }
}
function parseOptions(value: SqlValue | undefined): QuestionOption[] | null {
  const parsed = jsonValue(value);
  if (!Array.isArray(parsed)) return null;
  const options = parsed.filter((item): item is QuestionOption => item !== null && typeof item === 'object'
    && typeof (item as QuestionOption).key === 'string' && typeof (item as QuestionOption).content === 'string');
  return options.length === parsed.length ? options : null;
}
function parseImageList(value: SqlValue | undefined): QuestionImage[] {
  const parsed = jsonValue(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is QuestionImage => item !== null && typeof item === 'object'
    && typeof (item as QuestionImage).id === 'string' && typeof (item as QuestionImage).name === 'string'
    && typeof (item as QuestionImage).mime === 'string' && typeof (item as QuestionImage).hash === 'string'
    && ((item as QuestionImage).role == null || typeof (item as QuestionImage).role === 'string'));
}
function parseMaterials(value: SqlValue | undefined): QuestionMaterial[] {
  const parsed = jsonValue(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is QuestionMaterial => item !== null && typeof item === 'object'
    && typeof (item as QuestionMaterial).id === 'string' && typeof (item as QuestionMaterial).content === 'string'
    && Array.isArray((item as QuestionMaterial).images) && Array.isArray((item as QuestionMaterial).source_refs)
    && typeof (item as QuestionMaterial).version === 'number');
}
interface SourceRef { bbox: number[] | null; page: number; source_id: string }
function parseSourceRefs(value: unknown): SourceRef[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is SourceRef => item !== null && typeof item === 'object'
    && typeof (item as SourceRef).source_id === 'string' && typeof (item as SourceRef).page === 'number'
    && ((item as SourceRef).bbox === null || Array.isArray((item as SourceRef).bbox)));
}
function parseProvenance(value: SqlValue | undefined): { source_refs: SourceRef[]; answer_source_refs: SourceRef[] } {
  const text = str(value);
  if (text === null || text.trim() === '') return { source_refs: [], answer_source_refs: [] };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { source_refs: [], answer_source_refs: [] };
    }
    const record = parsed as Record<string, unknown>;
    return { source_refs: parseSourceRefs(record.source_refs), answer_source_refs: parseSourceRefs(record.answer_source_refs) };
  } catch {
    return { source_refs: [], answer_source_refs: [] };
  }
}

const COLUMNS = `id, exam_id, card_id, question_label, content, options_json,
  answer, explanation, question_type, difficulty, tags,
  status, user_answer, is_correct, attempt_count, correct_count,
  last_attempt_at, user_note, is_favorite, is_bookmarked,
  source_type, source_ref, images_json, parent_id, created_at, updated_at,
  ai_feedback, ai_score, ai_graded_at, structured_data,
  group_id, group_position, source_key, provenance_json, answer_origin`;

const Q_COLUMNS = `q.id, q.exam_id, q.card_id, q.question_label, q.content, q.options_json,
  q.answer, q.explanation, q.question_type, q.difficulty, q.tags,
  q.status, q.user_answer, q.is_correct, q.attempt_count, q.correct_count,
  q.last_attempt_at, q.user_note, q.is_favorite, q.is_bookmarked,
  q.source_type, q.source_ref, q.images_json, q.parent_id, q.created_at, q.updated_at,
  q.ai_feedback, q.ai_score, q.ai_graded_at, q.structured_data,
  q.group_id, q.group_position, q.source_key, q.provenance_json, q.answer_origin`;

export interface QuestionRow {
  id: SqlValue; exam_id: SqlValue; card_id: SqlValue; question_label: SqlValue; content: SqlValue;
  options_json: SqlValue; answer: SqlValue; explanation: SqlValue; question_type: SqlValue;
  difficulty: SqlValue; tags: SqlValue; status: SqlValue; user_answer: SqlValue; is_correct: SqlValue;
  attempt_count: SqlValue; correct_count: SqlValue; last_attempt_at: SqlValue; user_note: SqlValue;
  is_favorite: SqlValue; is_bookmarked: SqlValue; source_type: SqlValue; source_ref: SqlValue;
  images_json: SqlValue; parent_id: SqlValue; created_at: SqlValue; updated_at: SqlValue;
  ai_feedback: SqlValue; ai_score: SqlValue; ai_graded_at: SqlValue; structured_data: SqlValue;
  group_id: SqlValue; group_position: SqlValue; source_key: SqlValue; provenance_json: SqlValue;
  answer_origin: SqlValue;
}

export function rowToQuestion(row: QuestionRow): Question {
  const tags = jsonValue(row.tags);
  const provenance = parseProvenance(row.provenance_json);
  const questionTypeRaw = str(row.question_type);
  const difficultyRaw = str(row.difficulty);
  const statusRaw = str(row.status);
  const sourceTypeRaw = str(row.source_type);
  return {
    id: requiredStr(row.id),
    exam_id: requiredStr(row.exam_id),
    card_id: str(row.card_id),
    question_label: str(row.question_label),
    content: requiredStr(row.content),
    options: parseOptions(row.options_json),
    answer: str(row.answer),
    explanation: str(row.explanation),
    structured_data: structuredData(row.structured_data),
    question_type: questionTypeRaw === null ? 'other' : questionTypeFrom(questionTypeRaw),
    difficulty: difficultyRaw === null ? null : difficultyFrom(difficultyRaw),
    tags: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [],
    status: statusRaw === null ? 'new' : statusFrom(statusRaw),
    user_answer: str(row.user_answer),
    is_correct: boolOrNull(row.is_correct),
    attempt_count: int(row.attempt_count),
    correct_count: int(row.correct_count),
    last_attempt_at: str(row.last_attempt_at),
    user_note: str(row.user_note),
    is_favorite: flag(row.is_favorite),
    is_bookmarked: flag(row.is_bookmarked),
    source_type: sourceTypeRaw === null ? 'ocr' : sourceTypeFrom(sourceTypeRaw),
    source_ref: str(row.source_ref),
    images: parseImageList(row.images_json),
    parent_id: str(row.parent_id),
    created_at: requiredStr(row.created_at),
    updated_at: requiredStr(row.updated_at),
    ai_feedback: str(row.ai_feedback),
    ai_score: num(row.ai_score) === null ? null : int(row.ai_score),
    ai_graded_at: str(row.ai_graded_at),
    group_id: str(row.group_id),
    group_position: num(row.group_position) === null ? null : int(row.group_position),
    group_label: null,
    materials: [],
    answer_origin: str(row.answer_origin),
    source_refs: provenance.source_refs,
    answer_source_refs: provenance.answer_source_refs,
    source_key: str(row.source_key),
  };
}

function tableExists(db: SqlExecutor, table: string): boolean {
  return db.pluck<number>("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)", [table]) === 1;
}

/** question_repo.rs:1810-1927 */
export function hydrateQuestionContext(db: SqlExecutor, questions: Question[]): void {
  if (questions.length === 0) return;
  if (!tableExists(db, 'qbank_groups') || !tableExists(db, 'qbank_materials')) return;
  const groupIds = [...new Set(questions.map(question => question.group_id).filter((id): id is string => id !== null))];
  if (groupIds.length === 0) return;

  const labels = new Map<string, string>();
  const materialsByGroup = new Map<string, QuestionMaterial[]>();
  for (let start = 0; start < groupIds.length; start += 500) {
    const chunk = groupIds.slice(start, start + 500);
    const placeholders = chunk.map((_, index) => `?${index + 1}`).join(', ');
    for (const row of db.all<{ id: string; label: string }>(
      `SELECT id, label FROM qbank_groups WHERE id IN (${placeholders}) AND deleted_at IS NULL`, chunk)) {
      labels.set(row.id, row.label);
    }
    if (!tableExists(db, 'qbank_group_materials')) continue;
    const rows = db.all<{ group_id: string; id: string; content: string; images_json: string | null;
      source_refs_json: string | null; local_version: number }>(
      `SELECT gm.group_id, m.id, m.content, m.images_json, m.source_refs_json, m.local_version
       FROM qbank_group_materials gm
       JOIN qbank_materials m ON m.id = gm.material_id AND m.exam_id = gm.exam_id
       WHERE gm.group_id IN (${placeholders}) AND gm.deleted_at IS NULL AND m.deleted_at IS NULL
       ORDER BY gm.group_id ASC, gm.position ASC, gm.id ASC`, chunk);
    for (const row of rows) {
      const bucket = materialsByGroup.get(row.group_id) ?? [];
      if (bucket.some(material => material.id === row.id)) continue;
      bucket.push({
        id: row.id,
        content: row.content,
        images: parseImageList(row.images_json),
        source_refs: parseSourceRefs(jsonValue(row.source_refs_json)),
        version: row.local_version,
      });
      materialsByGroup.set(row.group_id, bucket);
    }
  }
  for (const question of questions) {
    if (question.group_id === null) continue;
    question.group_label = labels.get(question.group_id) ?? null;
    const materials = materialsByGroup.get(question.group_id);
    if (materials) question.materials = materials;
  }
}

export function getQuestion(db: SqlExecutor, questionId: string): Question | null {
  const row = db.get<QuestionRow>(`SELECT ${COLUMNS} FROM questions WHERE id = ?1 AND deleted_at IS NULL`, [questionId]);
  if (!row) return null;
  const question = rowToQuestion(row);
  hydrateQuestionContext(db, [question]);
  return question;
}

/** card_id also accepts a question id (question_repo.rs:2099-2141). */
export function getQuestionByCardId(db: SqlExecutor, examId: string, cardId: string): Question | null {
  const row = db.get<QuestionRow>(
    `SELECT ${COLUMNS} FROM questions WHERE exam_id = ?1 AND (card_id = ?2 OR id = ?2) AND deleted_at IS NULL`,
    [examId, cardId]);
  if (!row) return null;
  const question = rowToQuestion(row);
  hydrateQuestionContext(db, [question]);
  return question;
}

interface FilterSql { conditions: string[]; params: SqlValue[] }

/** question_repo.rs:1227-1348 filter construction. */
function filterSql(filters: QuestionFilters, examId: string | null, startIndex = 1): FilterSql {
  const conditions: string[] = [];
  const params: SqlValue[] = [];
  let index = startIndex;
  if (examId !== null) {
    conditions.push(`exam_id = ?${index}`);
    params.push(examId);
    index += 1;
  }
  const statuses = enumList(filters.status);
  if (statuses !== null && statuses.length > 0) {
    conditions.push(`status IN (${statuses.map(() => `?${index++}`).join(', ')})`);
    params.push(...statuses.map(value => statusFrom(value)));
  }
  const difficulties = enumList(filters.difficulty);
  if (difficulties !== null && difficulties.length > 0) {
    conditions.push(`difficulty IN (${difficulties.map(() => `?${index++}`).join(', ')})`);
    params.push(...difficulties.map(value => difficultyFrom(value)));
  }
  const types = enumList(filters.question_type);
  if (types !== null && types.length > 0) {
    conditions.push(`question_type IN (${types.map(() => `?${index++}`).join(', ')})`);
    params.push(...types.map(value => questionTypeFrom(value)));
  }
  if (filters.tags !== null && filters.tags !== undefined && filters.tags.length > 0) {
    conditions.push(`EXISTS (SELECT 1 FROM json_each(tags) WHERE value IN (${filters.tags.map(() => `?${index++}`).join(', ')}))`);
    params.push(...filters.tags);
  }
  if (filters.is_favorite !== null && filters.is_favorite !== undefined) {
    conditions.push(`is_favorite = ?${index++}`);
    params.push(filters.is_favorite ? 1 : 0);
  }
  if (filters.is_bookmarked !== null && filters.is_bookmarked !== undefined) {
    conditions.push(`is_bookmarked = ?${index++}`);
    params.push(filters.is_bookmarked ? 1 : 0);
  }
  return { conditions, params };
}

function escapeFts5Query(keyword: string): string {
  return keyword.split(/\s+/u).filter(Boolean).map(token => `"${token.replaceAll('"', '""')}"`).join(' ');
}
function sanitizeSearchKeyword(keyword: string): string | null {
  const trimmed = keyword.trim();
  if (trimmed === '') return null;
  return [...trimmed].slice(0, MAX_SEARCH_KEYWORD_LENGTH).join('');
}
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/gu, char => `\\${char}`);
}

export function listQuestions(db: SqlExecutor, examId: string, filters: QuestionFilters,
  pageInput: number, pageSizeInput: number): QuestionListResult {
  const page = Math.max(1, pageInput);
  const pageSize = Math.min(100, Math.max(1, pageSizeInput));
  const offset = (page - 1) * pageSize;
  const { conditions, params } = filterSql(filters, examId);
  conditions.push('deleted_at IS NULL');
  let index = params.length + 1;

  const search = filters.search;
  if (search !== null && search !== undefined) {
    if (search.trim() !== '') {
      if (tableExists(db, 'questions_fts')) {
        const sanitized = sanitizeSearchKeyword(search) ?? search;
        conditions.push(`rowid IN (SELECT rowid FROM questions_fts WHERE questions_fts MATCH ?${index++})`);
        params.push(escapeFts5Query(sanitized));
      } else {
        conditions.push(`(content LIKE ?${index} ESCAPE '\\' OR answer LIKE ?${index} ESCAPE '\\' OR explanation LIKE ?${index} ESCAPE '\\' OR tags LIKE ?${index} ESCAPE '\\')`);
        params.push(`%${escapeLikePattern(search)}%`);
        index += 1;
      }
    }
  }

  const where = conditions.join(' AND ');
  const total = db.pluck<number>(`SELECT COUNT(*) FROM questions WHERE ${where}`, params) ?? 0;
  const rows = db.all<QuestionRow>(
    `SELECT ${COLUMNS} FROM questions WHERE ${where}
     ORDER BY created_at ASC, id ASC LIMIT ?${index} OFFSET ?${index + 1}`,
    [...params, pageSize, offset]);
  const questions = rows.map(rowToQuestion);
  hydrateQuestionContext(db, questions);
  return { questions, total, page, page_size: pageSize, has_more: offset + pageSize < total };
}

export function searchQuestions(db: SqlExecutor, keyword: string, examId: string | null,
  filters: QuestionSearchFilters, pageInput: number, pageSizeInput: number): QuestionSearchListResult {
  const started = Date.now();
  const sanitized = sanitizeSearchKeyword(keyword);
  if (sanitized === null) {
    return { results: [], total: 0, page: pageInput, page_size: pageSizeInput, has_more: false, search_time_ms: 0 };
  }
  if (!tableExists(db, 'questions_fts')) {
    return fallbackLikeSearch(db, sanitized, examId, filters, pageInput, pageSizeInput, started);
  }

  const page = Math.max(1, pageInput);
  const pageSize = Math.min(100, Math.max(1, pageSizeInput));
  const offset = (page - 1) * pageSize;
  const escaped = escapeFts5Query(sanitized);

  const conditions: string[] = ['q.deleted_at IS NULL'];
  const params: SqlValue[] = [];
  let index = 1;
  if (examId !== null) {
    conditions.push(`q.exam_id = ?${index++}`);
    params.push(examId);
  }
  const statuses = enumList(filters.status);
  if (statuses !== null && statuses.length > 0) {
    conditions.push(`q.status IN (${statuses.map(() => `?${index++}`).join(', ')})`);
    params.push(...statuses.map(value => statusFrom(value)));
  }
  const difficulties = enumList(filters.difficulty);
  if (difficulties !== null && difficulties.length > 0) {
    conditions.push(`q.difficulty IN (${difficulties.map(() => `?${index++}`).join(', ')})`);
    params.push(...difficulties.map(value => difficultyFrom(value)));
  }
  const types = enumList(filters.question_type);
  if (types !== null && types.length > 0) {
    conditions.push(`q.question_type IN (${types.map(() => `?${index++}`).join(', ')})`);
    params.push(...types.map(value => questionTypeFrom(value)));
  }
  if (filters.tags !== null && filters.tags !== undefined && filters.tags.length > 0) {
    conditions.push(`EXISTS (SELECT 1 FROM json_each(q.tags) WHERE value IN (${filters.tags.map(() => `?${index++}`).join(', ')}))`);
    params.push(...filters.tags);
  }
  if (filters.is_favorite !== null && filters.is_favorite !== undefined) {
    conditions.push(`q.is_favorite = ?${index++}`);
    params.push(filters.is_favorite ? 1 : 0);
  }
  if (filters.is_bookmarked !== null && filters.is_bookmarked !== undefined) {
    conditions.push(`q.is_bookmarked = ?${index++}`);
    params.push(filters.is_bookmarked ? 1 : 0);
  }
  const where = conditions.join(' AND ');
  const matchIndex = index;
  const sort = toSearchSortBy(filters.sort_by);
  const order = sort === 'created_desc' ? 'q.created_at DESC'
    : sort === 'created_asc' ? 'q.created_at ASC'
      : sort === 'updated_desc' ? 'q.updated_at DESC' : 'bm25(questions_fts) ASC';

  const total = db.pluck<number>(
    `SELECT COUNT(*) FROM questions_fts JOIN questions q ON questions_fts.rowid = q.rowid
     WHERE questions_fts MATCH ?${matchIndex} AND ${where}`, [...params, escaped]) ?? 0;
  const rows = db.all<QuestionRow & {
    hl_content: SqlValue; hl_answer: SqlValue; hl_explanation: SqlValue; relevance: SqlValue;
  }>(
    `SELECT ${Q_COLUMNS},
       highlight(questions_fts, 0, '<mark>', '</mark>') AS hl_content,
       highlight(questions_fts, 1, '<mark>', '</mark>') AS hl_answer,
       highlight(questions_fts, 2, '<mark>', '</mark>') AS hl_explanation,
       bm25(questions_fts) AS relevance
     FROM questions_fts JOIN questions q ON questions_fts.rowid = q.rowid
     WHERE questions_fts MATCH ?${matchIndex} AND ${where}
     ORDER BY ${order} LIMIT ?${matchIndex + 1} OFFSET ?${matchIndex + 2}`,
    [...params, escaped, pageSize, offset]);

  const results: QuestionSearchResult[] = rows.map(row => ({
    question: rowToQuestion(row),
    highlight_content: str(row.hl_content),
    highlight_answer: str(row.hl_answer),
    highlight_explanation: str(row.hl_explanation),
    relevance_score: num(row.relevance) ?? 0,
  }));
  hydrateQuestionContext(db, results.map(result => result.question));
  return { results, total, page, page_size: pageSize, has_more: offset + pageSize < total, search_time_ms: Date.now() - started };
}

function fallbackLikeSearch(db: SqlExecutor, keyword: string, examId: string | null,
  filters: QuestionSearchFilters, pageInput: number, pageSizeInput: number, started: number): QuestionSearchListResult {
  const page = Math.max(1, pageInput);
  const pageSize = Math.min(100, Math.max(1, pageSizeInput));
  const offset = (page - 1) * pageSize;
  const like = `%${escapeLikePattern(keyword)}%`;
  const { conditions, params } = filterSql(filters, examId);
  conditions.push('deleted_at IS NULL');
  conditions.push(`(content LIKE ?${params.length + 1} ESCAPE '\\' OR answer LIKE ?${params.length + 1} ESCAPE '\\'
    OR explanation LIKE ?${params.length + 1} ESCAPE '\\' OR tags LIKE ?${params.length + 1} ESCAPE '\\')`);
  params.push(like);
  const where = conditions.join(' AND ');
  const total = db.pluck<number>(`SELECT COUNT(*) FROM questions WHERE ${where}`, params) ?? 0;
  const rows = db.all<QuestionRow>(
    `SELECT ${COLUMNS} FROM questions WHERE ${where} ORDER BY created_at ASC, id ASC
     LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`,
    [...params, pageSize, offset]);
  const questions = rows.map(rowToQuestion);
  hydrateQuestionContext(db, questions);
  return {
    results: questions.map(question => ({
      question, highlight_content: null, highlight_answer: null, highlight_explanation: null, relevance_score: 0,
    })),
    total, page, page_size: pageSize, has_more: offset + pageSize < total, search_time_ms: Date.now() - started,
  };
}

export function countByType(db: SqlExecutor, examId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of db.all<{ question_type: string; total: number }>(
    `SELECT question_type, COUNT(*) AS total FROM questions
     WHERE exam_id = ?1 AND deleted_at IS NULL GROUP BY question_type`, [examId])) {
    counts[row.question_type] = Math.max(0, row.total);
  }
  return counts;
}

export function getStats(db: SqlExecutor, examId: string): QuestionBankStats | null {
  const row = db.get<QuestionBankStats>(`SELECT exam_id, total_count, new_count, in_progress_count,
    mastered_count, review_count, total_attempts, total_correct, correct_rate, updated_at
    FROM question_bank_stats WHERE exam_id = ?1`, [examId]);
  return row ?? null;
}


export function getHistory(db: SqlExecutor, questionId: string, limit: number | null): QuestionHistory[] {
  return db.all<QuestionHistory>(`SELECT id, question_id, field_name, old_value, new_value,
    operator, reason, created_at FROM question_history WHERE question_id = ?1
    ORDER BY created_at DESC, id ASC LIMIT ?2`, [questionId, limit ?? 100]);
}

export function fillExplanationIfEmpty(questions: QuestionRepository, db: SqlExecutor,
  questionId: string, explanation: string): boolean {
  if (rustTrim(explanation) === '') return false;
  let changes: number;
  try {
    changes = db.run(`UPDATE questions SET explanation = ?1
      WHERE id = ?2 AND deleted_at IS NULL
        AND (explanation IS NULL OR TRIM(explanation, ' ' || char(9) || char(10) || char(13)) = '')`,
    [explanation, questionId]).changes;
  } catch (error) {
    throw new Error(`写入解析失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (changes === 0) return false;
  try {
    questions.recordHistory(db, questionId, 'explanation', null, explanation, 'ai', 'AI 解析填充空解析');
  } catch (error) {
    throw new Error(`记录解析历史失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  return true;
}

function optionsJson(options: QuestionOption[] | null): string | null {
  return options === null ? null : JSON.stringify(options.map(option => ({ key: option.key, content: option.content })));
}
function imagesJson(images: QuestionImage[] | null): string {
  return JSON.stringify((images ?? []).map(image => ({
    id: image.id, name: image.name, mime: image.mime, hash: image.hash,
    ...(image.role == null ? {} : { role: image.role }),
  })));
}










/** question_repo.rs:2548-2609 */

interface SubmissionRow {
  id: string; question_id: string; user_answer: string; is_correct: number | null;
  grading_method: string; submitted_at: string;
}
function rowToSubmission(row: SubmissionRow): AnswerSubmission {
  return { id: row.id, question_id: row.question_id, user_answer: row.user_answer,
    is_correct: row.is_correct === null ? null : row.is_correct !== 0,
    grading_method: row.grading_method, submitted_at: row.submitted_at };
}

export function getSubmissions(db: SqlExecutor, questionId: string, limit: number): AnswerSubmission[] {
  return db.all<SubmissionRow>(`SELECT id, question_id, user_answer, is_correct, grading_method, submitted_at
    FROM answer_submissions WHERE question_id = ?1 ORDER BY submitted_at DESC LIMIT ?2`, [questionId, limit])
    .map(rowToSubmission);
}

export function getSubmissionByClientRequest(db: SqlExecutor, questionId: string, clientRequestId: string): AnswerSubmission | null {
  const row = db.get<SubmissionRow>(`SELECT id, question_id, user_answer, is_correct, grading_method, submitted_at
    FROM answer_submissions WHERE question_id = ?1 AND client_request_id = ?2
    ORDER BY submitted_at DESC LIMIT 1`, [questionId, clientRequestId]);
  return row ? rowToSubmission(row) : null;
}

export function getSubmissionById(db: SqlExecutor, submissionId: string): AnswerSubmission | null {
  const row = db.get<SubmissionRow>(`SELECT id, question_id, user_answer, is_correct, grading_method, submitted_at
    FROM answer_submissions WHERE id = ?1`, [submissionId]);
  return row ? rowToSubmission(row) : null;
}

export function buildSubmissionSnapshots(db: SqlExecutor, questionId: string): { question: string | null; material: string | null } {
  const question = getQuestion(db, questionId);
  if (!question) return { question: null, material: null };
  return buildSubmissionSnapshotsFor(question);
}

export function buildSubmissionSnapshotsFor(question: Question): { question: string; material: string } {
  const snapshot = {
    id: question.id, exam_id: question.exam_id, question_label: question.question_label,
    content: question.content, options: question.options, answer: question.answer,
    explanation: question.explanation, structured_data: question.structured_data,
    question_type: question.question_type, difficulty: question.difficulty, tags: question.tags,
    images: question.images, group_id: question.group_id, group_position: question.group_position,
    group_label: question.group_label, material_ids: question.materials.map(material => material.id),
    answer_origin: question.answer_origin, question_updated_at: question.updated_at,
  };
  return {
    question: JSON.stringify(snapshot),
    material: JSON.stringify({ materials: question.materials.map(material => ({
      id: material.id, content: material.content, images: material.images,
      source_refs: material.source_refs, version: material.version,
    })) }),
  };
}

/** 读取 submission 上的版本快照；列不存在（旧库）或行缺失时返回空。 */
export function submissionSnapshots(db: SqlExecutor, submissionId: string):
  [string | null, string | null] {
  try {
    const row = db.get<{ question_snapshot_json: string | null; material_snapshot_json: string | null }>(
      `SELECT question_snapshot_json, material_snapshot_json
       FROM answer_submissions WHERE id = ?1`, [submissionId]);
    if (row === undefined) return [null, null];
    return [row.question_snapshot_json ?? null, row.material_snapshot_json ?? null];
  } catch {
    return [null, null];
  }
}



/** question_repo.rs:1546-1662 filter construction for random selection. */
function randomQuestionIds(db: SqlExecutor, examId: string, filters: QuestionFilters,
  excludeIds: string[], lastAttemptBefore: string | null, limit: number): string[] {
  const { conditions, params } = filterSql(filters, examId);
  conditions.push('deleted_at IS NULL');
  let index = params.length + 1;
  if (excludeIds.length > 0) {
    conditions.push(`id NOT IN (${excludeIds.map(() => `?${index++}`).join(', ')})`);
    params.push(...excludeIds);
  }
  if (lastAttemptBefore !== null) {
    conditions.push(`(last_attempt_at IS NULL OR last_attempt_at < ?${index++})`);
    params.push(lastAttemptBefore);
  }
  return db.all<{ id: string }>(`SELECT id FROM questions WHERE ${conditions.join(' AND ')}
    ORDER BY RANDOM() LIMIT ?${index}`, [...params, limit]).map(row => row.id);
}

export function randomQuestions(db: SqlExecutor, examId: string, filters: QuestionFilters,
  excludeIds: string[], limit: number): Question[] {
  const ids = randomQuestionIds(db, examId, filters, excludeIds, null, limit);
  const byId = new Map<string, Question>();
  for (const question of getQuestionsByIds(db, ids)) byId.set(question.id, question);
  return ids.map(id => byId.get(id)).filter((question): question is Question => question !== undefined);
}

export function getQuestionsByIds(db: SqlExecutor, ids: string[]): Question[] {
  if (ids.length === 0) return [];
  const questions: Question[] = [];
  for (let start = 0; start < ids.length; start += 500) {
    const chunk = ids.slice(start, start + 500);
    const placeholders = chunk.map((_, index) => `?${index + 1}`).join(', ');
    questions.push(...db.all<QuestionRow>(`SELECT ${COLUMNS} FROM questions
      WHERE id IN (${placeholders}) AND deleted_at IS NULL`, chunk).map(rowToQuestion));
  }
  hydrateQuestionContext(db, questions);
  return questions;
}

export { randomQuestionIds };

export interface MistakeListFilters { exam_id?: string | null; search?: string | null; sort?: string | null }
export interface MistakeExamCount { exam_id: string; exam_name: string | null; count: number }
export interface MistakeQuestion extends Question { exam_name: string | null }
export interface MistakeListResult {
  items: MistakeQuestion[]; total: number; page: number; page_size: number; has_more: boolean;
  exams: MistakeExamCount[];
}



export function dailyProgressRows(db: SqlExecutor, examId: string, date: string): { ids: string[]; correct: number } {
  const rows = db.all<{ question_id: string; correct: number }>(`
    SELECT question_id, MAX(correct) AS correct FROM (
      SELECT s.question_id AS question_id, CASE WHEN s.is_correct = 1 THEN 1 ELSE 0 END AS correct
      FROM answer_submissions s
      INNER JOIN questions q ON q.id = s.question_id
      WHERE q.exam_id = ?1 AND q.deleted_at IS NULL AND DATE(s.submitted_at, 'localtime') = ?2
      UNION ALL
      SELECT q.id AS question_id, CASE WHEN q.is_correct = 1 THEN 1 ELSE 0 END AS correct
      FROM questions q
      WHERE q.exam_id = ?1 AND q.deleted_at IS NULL AND q.last_attempt_at IS NOT NULL
        AND DATE(q.last_attempt_at, 'localtime') = ?2
        AND NOT EXISTS (SELECT 1 FROM answer_submissions s2 WHERE s2.question_id = q.id)
    ) GROUP BY question_id`, [examId, date]);
  return { ids: rows.map(row => row.question_id), correct: rows.filter(row => row.correct === 1).length };
}


/** question_repo.rs:1416-1537 */
export function listMistakes(db: SqlExecutor, filters: MistakeListFilters,
  pageInput: number, pageSizeInput: number): MistakeListResult {
  const page = Math.max(1, pageInput);
  const pageSize = Math.min(200, Math.max(1, pageSizeInput));
  const offset = (page - 1) * pageSize;
  const base = `FROM questions q
    INNER JOIN exam_sheets e ON e.id = q.exam_id AND e.deleted_at IS NULL
    WHERE q.deleted_at IS NULL AND q.status = 'review'`;
  const exams = db.all<{ exam_id: string; exam_name: string | null; count: number }>(
    `SELECT q.exam_id, e.exam_name, COUNT(*) AS count ${base}
     GROUP BY q.exam_id ORDER BY count DESC, e.exam_name COLLATE NOCASE ASC`).map(row => ({
    exam_id: row.exam_id, exam_name: row.exam_name, count: row.count,
  }));

  const conditions: string[] = [];
  const params: SqlValue[] = [];
  const examId = filters.exam_id?.trim();
  if (examId) {
    params.push(examId);
    conditions.push(`q.exam_id = ?${params.length}`);
  }
  const search = filters.search?.trim();
  if (search) {
    params.push(`%${escapeLikePattern(search)}%`);
    const index = params.length;
    conditions.push(`(q.content LIKE ?${index} ESCAPE '\\' OR q.answer LIKE ?${index} ESCAPE '\\'
      OR q.explanation LIKE ?${index} ESCAPE '\\' OR q.tags LIKE ?${index} ESCAPE '\\')`);
  }
  const extra = conditions.map(condition => ` AND ${condition}`).join('');
  const total = db.pluck<number>(`SELECT COUNT(*) ${base}${extra}`, params) ?? 0;
  const order = filters.sort?.trim() === 'errors'
    ? '(q.attempt_count - q.correct_count) DESC, COALESCE(q.last_attempt_at, q.updated_at) DESC, q.id ASC'
    : 'COALESCE(q.last_attempt_at, q.updated_at) DESC, q.id ASC';
  const rows = db.all<QuestionRow & { exam_name: string | null }>(
    `SELECT ${Q_COLUMNS}, e.exam_name ${base}${extra} ORDER BY ${order}
     LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`,
    [...params, pageSize, offset]);
  const items: MistakeQuestion[] = rows.map(row => ({ ...rowToQuestion(row), exam_name: row.exam_name }));
  hydrateQuestionContext(db, items);
  return { items, total, page, page_size: pageSize, has_more: offset + pageSize < total, exams };
}
