import { createHasherSync } from '../../../platform/crypto/sync.ts';
import { logError, logWarn } from './logger.ts';
import { nanoid } from 'nanoid';
import type { Row, SqlExecutor, SqlParam } from '../../../platform/storage/api.ts';
import { VfsRepositoryError, type AnswerSubmission, type CreateQuestionParams, type JsonValue, type MistakeListFilters,
  type MistakeListResult, type Question, type QuestionBankStats, type QuestionDailyProgress, type QuestionFilters,
  type QuestionGroupMembershipPatch, type QuestionHistory, type QuestionListResult, type QuestionMaterial,
  type QuestionMetadataPatch, type QuestionRepository, type QuestionSearchFilters, type QuestionSearchListResult,
  type ReparseQuestionParams, type SubmissionSnapshot, type UpdateQuestionParams, type VerdictApplyOutcome } from '../api.ts';
import { rustTrim, stringifyJsonValue } from '../../../platform/util/index.ts';
import { databaseResult, rollbackIgnoringFailure } from './errors.ts';
import { utcNow } from './timestamps.ts';
import { mapSkippingErrors, parseImages, parseJson, parseSourceRefs, rowToQuestion, rowToSyncQuestion, selectQuestionColumns,
  syncQuestionColumns, type SyncQuestion } from './question-row.ts';
import { StorageError } from '../../../platform/storage/api.ts';

export const MAX_SEARCH_KEYWORD_LENGTH = 200;
export function escapeFts5Query(keyword: string): string {
  return keyword.split(/\p{White_Space}+/u).filter(Boolean).map(token => `"${token.replaceAll('"', '""')}"`).join(' ');
}
export function sanitizeSearchKeyword(keyword: string): string | null {
  const trimmed = rustTrim(keyword);
  return trimmed === '' ? null : [...trimmed].slice(0, MAX_SEARCH_KEYWORD_LENGTH).join('');
}
const like = (value: string) => `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
function exists(conn: SqlExecutor, table: string): boolean {
  try { return Boolean(conn.pluck("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)", [table])); }
  catch (error) { logWarn('[VFS::QuestionRepo] Table lookup failed:', error); return false; }
}
const notFound = (id: string) => new VfsRepositoryError('VFS_NOT_FOUND', `question not found: ${id}`, { resourceType: 'question', id });
function atomic<T>(conn: SqlExecutor, run: () => T): T {
  conn.exec('BEGIN IMMEDIATE');
  let result: T;
  try { result = run(); }
  catch (error) { rollbackIgnoringFailure(conn); throw error; }
  conn.exec('COMMIT');
  return result;
}
function addFilters(conditions: string[], params: SqlParam[], filters: QuestionFilters, prefix = '', flags = true): void {
  for (const key of ['status', 'difficulty', 'question_type'] as const) {
    const values = filters[key];
    if (values?.length) {
      conditions.push(`${prefix}${key} IN (${values.map((_, i) => `?${params.length + i + 1}`).join(',')})`);
      params.push(...values);
    }
  }
  if (filters.tags?.length) {
    conditions.push(`EXISTS (SELECT 1 FROM json_each(${prefix}tags) WHERE value IN (${filters.tags.map((_, i) => `?${params.length + i + 1}`).join(',')}))`);
    params.push(...filters.tags);
  }
  if (flags) addFlags(conditions, params, filters, prefix);
}
function addFlags(conditions: string[], params: SqlParam[], filters: QuestionFilters, prefix = ''): void {
  for (const key of ['is_favorite', 'is_bookmarked'] as const) {
    if (filters[key] != null) { params.push(filters[key]!); conditions.push(`${prefix}${key}=?${params.length}`); }
  }
}
function likeCondition(param: number, prefix = ''): string {
  return `(${['content', 'answer', 'explanation', 'tags'].map(key => `${prefix}${key} LIKE ?${param} ESCAPE '\\'`).join(' OR ')})`;
}
function randomFilter(examId: string, filters: QuestionFilters, exclude: readonly string[], before: string | null): { conditions: string[]; params: SqlParam[] } {
  const conditions = ['exam_id=?1', 'deleted_at IS NULL'];
  const params: SqlParam[] = [examId];
  addFilters(conditions, params, filters);
  if (exclude.length) {
    conditions.push(`id NOT IN (${exclude.map((_, i) => `?${params.length + i + 1}`).join(',')})`);
    params.push(...exclude);
  }
  if (before !== null) { params.push(before); conditions.push(`(last_attempt_at IS NULL OR last_attempt_at < ?${params.length})`); }
  return { conditions, params };
}
const submissionColumns = 'id,question_id,user_answer,is_correct,grading_method,submitted_at';
function submission(row: Row): AnswerSubmission {
  return { id: row.id as string, question_id: row.question_id as string, user_answer: row.user_answer as string,
    is_correct: row.is_correct === null ? null : row.is_correct !== 0, grading_method: row.grading_method as string, submitted_at: row.submitted_at as string };
}

const STRUCTURED_QUESTION_TYPES = new Set(['fill_blank', 'matching', 'ordering', 'numeric']);

/** `UpdateQuestionParams::should_clear_stale_structured_data` (question_repo.rs:545-556). */
function shouldClearStaleStructuredData(params: UpdateQuestionParams): boolean {
  return params.question_type != null
    && params.structured_data === undefined
    && !STRUCTURED_QUESTION_TYPES.has(params.question_type);
}

/** `QuestionSyncService::compute_content_hash` (question_sync_service.rs:471-517). */
function computeQuestionContentHash(question: SyncQuestion): string {
  const hasher = createHasherSync('SHA-256');
  hasher.update(question.content);
  if (question.options !== null) hasher.update(JSON.stringify(question.options));
  if (question.answer !== null) hasher.update(question.answer);
  if (question.explanation !== null) hasher.update(question.explanation);
  hasher.update(question.question_type);
  if (question.difficulty !== null) hasher.update(question.difficulty);
  hasher.update(JSON.stringify(question.tags));
  if (question.images.length > 0) hasher.update(JSON.stringify(question.images));
  if (question.structured_data !== null) hasher.update(stringifyJsonValue(question.structured_data));
  return hasher.digestHex();
}

/**
 * `QuestionSyncService::get_question_by_id` (question_sync_service.rs:1612-1718)：`prepare` 失败经 `?`
 * 成为 `Database`；`query_row` 的无行/执行/列转换失败一律 `.map_err(|_| NotFound{question,id})`。
 */
function loadSyncQuestion(conn: SqlExecutor, questionId: string): SyncQuestion {
  const row = databaseResult(() => {
    try {
      return conn.get(`SELECT ${syncQuestionColumns.join(',')} FROM questions WHERE id = ?1 AND deleted_at IS NULL`, [questionId]);
    } catch (error) {
      if (error instanceof StorageError && error.phase !== 'prepare') throw notFound(questionId);
      throw error;
    }
  });
  const question = row === undefined ? null : rowToSyncQuestion(row);
  if (question === null) throw notFound(questionId);
  return question;
}

export class QuestionRepo implements QuestionRepository {
  getQuestion(conn: SqlExecutor, id: string): Question | null {
    return databaseResult(() => {
      const row = conn.get(`SELECT ${selectQuestionColumns()} FROM questions WHERE id=?1 AND deleted_at IS NULL`, [id]);
      if (!row) return null;
      const question = rowToQuestion(row);
      this.hydrateQuestionContext(conn, [question]);
      return question;
    });
  }
  getQuestionByCardId(conn: SqlExecutor, examId: string, cardId: string): Question | null {
    return databaseResult(() => {
      const row = conn.get(`SELECT ${selectQuestionColumns()} FROM questions WHERE exam_id=?1 AND (card_id=?2 OR id=?2) AND deleted_at IS NULL`, [examId, cardId]);
      if (!row) return null;
      const question = rowToQuestion(row);
      this.hydrateQuestionContext(conn, [question]);
      return question;
    });
  }
  getQuestionsByIds(conn: SqlExecutor, ids: readonly string[]): Question[] {
    return databaseResult(() => {
      const questions: Question[] = [];
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        questions.push(...mapSkippingErrors(conn.all(`SELECT ${selectQuestionColumns()} FROM questions WHERE id IN (${chunk.map(() => '?').join(',')}) AND deleted_at IS NULL`, chunk), rowToQuestion));
      }
      this.hydrateQuestionContext(conn, questions);
      return questions;
    });
  }
  hydrateQuestionContext(conn: SqlExecutor, questions: Question[]): void {
    databaseResult(() => {
      if (!questions.length || !exists(conn, 'qbank_groups') || !exists(conn, 'qbank_materials')) return;
      const ids = [...new Set(questions.flatMap(q => q.group_id === null ? [] : [q.group_id]))].sort();
      if (!ids.length) return;
      const labels = new Map<string, string>();
      const materials = new Map<string, QuestionMaterial[]>();
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        for (const row of conn.all(`SELECT id,label FROM qbank_groups WHERE id IN (${chunk.map(() => '?').join(',')}) AND deleted_at IS NULL`, chunk)) {
          if (typeof row.id === 'string' && typeof row.label === 'string') labels.set(row.id, row.label);
          else logWarn('[VFS::QuestionRepo] Row parse error (skipped): group label');
        }
      }
      if (exists(conn, 'qbank_group_materials')) {
        for (let i = 0; i < ids.length; i += 500) {
          const chunk = ids.slice(i, i + 500);
          const rows = conn.all(`SELECT gm.group_id,m.id,m.content,m.images_json,m.source_refs_json,m.local_version
            FROM qbank_group_materials gm JOIN qbank_materials m ON m.id=gm.material_id AND m.exam_id=gm.exam_id
            WHERE gm.group_id IN (${chunk.map(() => '?').join(',')}) AND gm.deleted_at IS NULL AND m.deleted_at IS NULL
            ORDER BY gm.group_id ASC,gm.position ASC,gm.id ASC`, chunk);
          for (const row of rows) {
            if (typeof row.group_id !== 'string' || typeof row.id !== 'string' || typeof row.content !== 'string' || typeof row.local_version !== 'number'
              || (row.images_json !== null && typeof row.images_json !== 'string') || (row.source_refs_json !== null && typeof row.source_refs_json !== 'string')) {
              logWarn('[VFS::QuestionRepo] Row parse error (skipped): material'); continue;
            }
            const bucket = materials.get(row.group_id) ?? [];
            if (!bucket.some(m => m.id === row.id)) bucket.push({ id: row.id, content: row.content,
              images: parseImages(row.images_json), source_refs: parseSourceRefs(parseJson(row.source_refs_json)), version: row.local_version });
            materials.set(row.group_id, bucket);
          }
        }
      }
      for (const question of questions) {
        if (question.group_id === null) continue;
        question.group_label = labels.get(question.group_id) ?? null;
        const groupMaterials = materials.get(question.group_id);
        if (groupMaterials) question.materials = structuredClone(groupMaterials);
      }
    });
  }
  listQuestions(conn: SqlExecutor, examId: string, filters: QuestionFilters, page: number, pageSize: number): QuestionListResult {
    return databaseResult(() => {
      page = Math.max(page, 1); pageSize = Math.min(100, Math.max(1, pageSize));
      const offset = (page - 1) * pageSize;
      const conditions = ['exam_id=?1', 'deleted_at IS NULL']; const params: SqlParam[] = [examId];
      addFilters(conditions, params, filters, '', false);
      if (filters.search != null && rustTrim(filters.search) !== '') {
        if (exists(conn, 'questions_fts')) {
          params.push(escapeFts5Query(sanitizeSearchKeyword(filters.search) ?? filters.search));
          conditions.push(`rowid IN (SELECT rowid FROM questions_fts WHERE questions_fts MATCH ?${params.length})`);
        } else { params.push(like(filters.search)); conditions.push(likeCondition(params.length)); }
      }
      addFlags(conditions, params, filters);
      const where = conditions.join(' AND ');
      const total = conn.one<{ n: number }>(`SELECT COUNT(*) AS n FROM questions WHERE ${where}`, params).n;
      const rows = conn.all(`SELECT ${selectQuestionColumns()} FROM questions WHERE ${where} ORDER BY created_at ASC,id ASC LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`, [...params, pageSize, offset]);
      const questions = mapSkippingErrors(rows, rowToQuestion);
      this.hydrateQuestionContext(conn, questions);
      return { questions, total, page, page_size: pageSize, has_more: offset + pageSize < (total >>> 0) };
    });
  }
  listMistakes(conn: SqlExecutor, filters: MistakeListFilters, page: number, pageSize: number): MistakeListResult {
    return databaseResult(() => {
      page = Math.max(1, page); pageSize = Math.min(200, Math.max(1, pageSize));
      const offset = (page - 1) * pageSize;
      const base = "FROM questions q INNER JOIN exam_sheets e ON e.id=q.exam_id AND e.deleted_at IS NULL WHERE q.deleted_at IS NULL AND q.status='review'";
      const exams = conn.all<{ exam_id: string; exam_name: string | null; count: number }>(`SELECT q.exam_id,e.exam_name,COUNT(*) AS count ${base} GROUP BY q.exam_id ORDER BY count DESC,e.exam_name COLLATE NOCASE ASC`);
      const conditions: string[] = []; const params: SqlParam[] = [];
      if (filters.exam_id != null && rustTrim(filters.exam_id) !== '') { params.push(rustTrim(filters.exam_id)); conditions.push(`q.exam_id=?${params.length}`); }
      if (filters.search != null && rustTrim(filters.search) !== '') { params.push(like(rustTrim(filters.search))); conditions.push(likeCondition(params.length, 'q.')); }
      const extra = conditions.map(c => ` AND ${c}`).join('');
      const total = conn.one<{ n: number }>(`SELECT COUNT(*) AS n ${base}${extra}`, params).n;
      const order = filters.sort != null && rustTrim(filters.sort) === 'errors'
        ? '(q.attempt_count-q.correct_count) DESC,COALESCE(q.last_attempt_at,q.updated_at) DESC,q.id ASC'
        : 'COALESCE(q.last_attempt_at,q.updated_at) DESC,q.id ASC';
      const rows = conn.all(`SELECT ${selectQuestionColumns('q.')},e.exam_name ${base}${extra} ORDER BY ${order} LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`, [...params, pageSize, offset]);
      const pairs = mapSkippingErrors(rows, row => ({ question: rowToQuestion(row), examName: row.exam_name as string | null }));
      this.hydrateQuestionContext(conn, pairs.map(p => p.question));
      return { items: pairs.map(p => ({ ...p.question, exam_name: p.examName })), total, page, page_size: pageSize, has_more: offset + pageSize < total, exams };
    });
  }
  searchQuestions(conn: SqlExecutor, keyword: string, examId: string | null, filters: QuestionSearchFilters, page: number, pageSize: number): QuestionSearchListResult {
    return databaseResult(() => {
      const start = performance.now(); const sanitized = sanitizeSearchKeyword(keyword);
      if (sanitized === null) return { results: [], total: 0, page, page_size: pageSize, has_more: false, search_time_ms: 0 };
      const fts = exists(conn, 'questions_fts');
      if (!fts) logWarn('[VFS::QuestionRepo] FTS5 table not found, falling back to LIKE search');
      if (fts) { page = Math.max(1, page); pageSize = Math.min(100, Math.max(1, pageSize)); }
      const offset = Math.max(0, page - 1) * pageSize;
      const prefix = fts ? 'q.' : '';
      const conditions = [`${prefix}deleted_at IS NULL`]; const params: SqlParam[] = [];
      if (!fts) { params.push(like(sanitized)); conditions.push(likeCondition(1)); }
      if (examId !== null) { params.push(examId); conditions.push(`${prefix}exam_id=?${params.length}`); }
      addFilters(conditions, params, filters, prefix);
      const base = fts ? 'FROM questions_fts fts JOIN questions q ON fts.rowid=q.rowid' : 'FROM questions';
      if (fts) { params.push(escapeFts5Query(sanitized)); conditions.unshift(`fts.questions_fts MATCH ?${params.length}`); }
      const where = conditions.join(' AND ');
      const total = conn.one<{ n: number }>(`SELECT COUNT(*) AS n ${base} WHERE ${where}`, params).n;
      const orderBy = fts ? ({ relevance: 'bm25(questions_fts) ASC', created_desc: 'q.created_at DESC', created_asc: 'q.created_at ASC', updated_desc: 'q.updated_at DESC' }[filters.sort_by ?? 'relevance']) : 'created_at ASC,id ASC';
      const extraCols = fts ? ",highlight(questions_fts,0,'<mark>','</mark>') AS hl_content,highlight(questions_fts,1,'<mark>','</mark>') AS hl_answer,highlight(questions_fts,2,'<mark>','</mark>') AS hl_explanation,bm25(questions_fts) AS relevance" : '';
      const rows = conn.all(`SELECT ${selectQuestionColumns(prefix)}${extraCols} ${base} WHERE ${where} ORDER BY ${orderBy} LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`, [...params, pageSize, offset]);
      const results = mapSkippingErrors(rows, row => ({ question: rowToQuestion(row), highlight_content: fts ? row.hl_content as string | null : null,
        highlight_answer: fts ? row.hl_answer as string | null : null, highlight_explanation: fts ? row.hl_explanation as string | null : null,
        relevance_score: fts ? row.relevance as number : 0 }));
      this.hydrateQuestionContext(conn, results.map(r => r.question));
      return { results, total, page, page_size: pageSize, has_more: offset + pageSize < (total >>> 0), search_time_ms: Math.floor(performance.now() - start) };
    });
  }
  rebuildFtsIndex(conn: SqlExecutor): number {
    return databaseResult(() => {
      conn.exec('SAVEPOINT qbank_rebuild_fts');
      let count: number;
      try {
        conn.run('DELETE FROM questions_fts');
        count = conn.run(`INSERT INTO questions_fts(rowid,content,answer,explanation,tags)
          SELECT rowid,content,COALESCE(answer,''),COALESCE(explanation,''),COALESCE(tags,'[]') FROM questions WHERE deleted_at IS NULL`).changes;
        conn.run("INSERT INTO questions_fts(questions_fts) VALUES('optimize')");
      } catch (error) {
        logWarn('[VFS::QuestionRepo] FTS5 rebuild failed, rolled back:', error);
        try { conn.exec('ROLLBACK TO SAVEPOINT qbank_rebuild_fts; RELEASE SAVEPOINT qbank_rebuild_fts;'); }
        catch (rollbackError) { logWarn('[VFS::QuestionRepo] FTS rollback failed:', rollbackError); }
        throw error;
      }
      conn.exec('RELEASE SAVEPOINT qbank_rebuild_fts');
      return count;
    });
  }
  canonicalQuestions(conn: SqlExecutor, examId: string): Question[] {
    const all: Question[] = [];
    let page = 1;
    for (;;) {
      const result = this.listQuestions(conn, examId, {}, page, 100);
      all.push(...result.questions);
      if (!result.has_more || result.questions.length === 0) return all;
      page++;
      if (page > 10000) throw new VfsRepositoryError('VFS_INVALID_ARGUMENT', "Invalid argument 'exam_id': 题目集分页超出安全上限", { param: 'exam_id' });
    }
  }
  canonicalText(conn: SqlExecutor, examId: string): string {
    let out = ''; let lastGroup: string | null = null; const emitted = new Set<string>();
    this.canonicalQuestions(conn, examId).forEach((q, index) => {
      if (q.group_id !== lastGroup) {
        if (q.group_id !== null) {
          if (q.group_label !== null) out += `\n## ${q.group_label}\n`;
          for (const material of q.materials) {
            if (!emitted.has(material.id)) { emitted.add(material.id); out += `\n[共享材料]\n${material.content}\n`; }
          }
        }
        lastGroup = q.group_id;
      }
      out += `\n${q.question_label ?? index + 1}. ${q.content}\n`;
      for (const opt of q.options ?? []) out += `   ${opt.key}. ${opt.content}\n`;
      if (q.answer !== null) out += `   答案：${q.answer}\n`;
      if (q.explanation !== null) out += `   解析：${q.explanation}\n`;
    });
    return out.replace(/^\p{White_Space}+/u, '');
  }
  invalidateExamContentIndex(conn: SqlExecutor, examId: string): void {
    databaseResult(() => {
      if (!exists(conn, 'resources') || !exists(conn, 'exam_sheets')) return;
      const id = conn.pluck<string | null>('SELECT resource_id FROM exam_sheets WHERE id=?1', [examId]);
      if (id == null || rustTrim(id) === '') return;
      conn.run("UPDATE resources SET index_state='pending',indexed_at=NULL,updated_at=?1 WHERE id=?2 AND index_state NOT IN ('pending','disabled')", [utcNow(), id]);
    });
  }
  examIdForQuestion(conn: SqlExecutor, id: string): string | null {
    return databaseResult(() => conn.pluck<string>('SELECT exam_id FROM questions WHERE id=?1', [id]) ?? null);
  }
  createQuestion(conn: SqlExecutor, params: CreateQuestionParams): Question {
    return databaseResult(() => {
      const id = `q_${nanoid(10)}`; const time = utcNow();
      conn.run(`INSERT INTO questions(id,exam_id,card_id,question_label,content,options_json,answer,explanation,question_type,difficulty,tags,status,source_type,source_ref,images_json,parent_id,created_at,updated_at,structured_data)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)`,
      [id, params.exam_id, params.card_id ?? null, params.question_label ?? null, params.content, params.options == null ? null : JSON.stringify(params.options),
        params.answer ?? null, params.explanation ?? null, params.question_type ?? 'other', params.difficulty ?? null, JSON.stringify(params.tags ?? []),
        'new', params.source_type ?? 'ocr', params.source_ref ?? null, JSON.stringify(params.images ?? []), params.parent_id ?? null, time, time,
        params.structured_data == null ? null : JSON.stringify(params.structured_data)]);
      this.invalidateExamContentIndex(conn, params.exam_id);
      const q = this.getQuestion(conn, id);
      if (!q) throw notFound(id);
      return q;
    });
  }
  batchCreateQuestions(conn: SqlExecutor, params: readonly CreateQuestionParams[]): Question[] {
    return databaseResult(() => {
      try { return atomic(conn, () => params.map(p => this.createQuestion(conn, p))); }
      catch (error) {
        logWarn('[VFS::QuestionRepo] Batch create failed, rolled back:', error);
        throw error;
      }
    });
  }
  updateQuestion(conn: SqlExecutor, id: string, params: UpdateQuestionParams): Question {
    return databaseResult(() => {
      const now = utcNow();
      const sets = ['updated_at = ?1', "sync_status = CASE WHEN sync_status = 'synced' THEN 'modified' ELSE sync_status END"];
      const values: SqlParam[] = [now];
      let index = 2;
      const add = (column: string, value: SqlParam) => {
        sets.push(`${column} = ?${index}`);
        values.push(value);
        index += 1;
      };

      if (params.question_label != null) add('question_label', params.question_label);
      if (params.content != null) add('content', params.content);
      if (params.options != null) add('options_json', JSON.stringify(params.options));
      if (params.answer != null) add('answer', params.answer);
      if (params.explanation != null) add('explanation', params.explanation);
      if (params.question_type != null) add('question_type', params.question_type);
      if (params.difficulty != null) add('difficulty', params.difficulty);
      if (params.tags != null) add('tags', JSON.stringify(params.tags));
      if (params.status != null) add('status', params.status);
      if (params.user_answer != null) add('user_answer', params.user_answer);
      if (params.is_correct != null) add('is_correct', params.is_correct ? 1 : 0);
      if (params.user_note != null) add('user_note', params.user_note);
      if (params.is_favorite != null) add('is_favorite', params.is_favorite ? 1 : 0);
      if (params.is_bookmarked != null) add('is_bookmarked', params.is_bookmarked ? 1 : 0);
      if (params.images != null) add('images_json', JSON.stringify(params.images));

      let structuredUpdate: string | null | undefined;
      if (params.structured_data !== undefined) {
        structuredUpdate = params.structured_data === null ? null : JSON.stringify(params.structured_data);
      } else if (shouldClearStaleStructuredData(params)) {
        structuredUpdate = null;
      }
      if (structuredUpdate !== undefined) add('structured_data', structuredUpdate);

      const questionIdParam = index;
      values.push(id);
      index += 1;
      const expected = params.expected_updated_at != null && params.expected_updated_at !== ''
        ? params.expected_updated_at
        : null;
      let occ = '';
      if (expected !== null) {
        occ = ` AND updated_at = ?${index}`;
        values.push(expected);
        index += 1;
      }

      const affected = conn.run(
        `UPDATE questions SET ${sets.join(', ')} WHERE id = ?${questionIdParam} AND deleted_at IS NULL${occ}`,
        values,
      ).changes;
      if (affected === 0) {
        if (expected !== null) {
          const current = this.getQuestion(conn, id);
          if (current !== null) {
            logWarn(`[VFS::QuestionRepo] Optimistic lock conflict for question ${id}: expected updated_at='${expected}', actual='${current.updated_at}'`);
            throw new VfsRepositoryError('VFS_INTERNAL', `QBANK_CONFLICT: expected_updated_at=${expected}, actual_updated_at=${current.updated_at}`);
          }
        }
        throw notFound(id);
      }

      this.markAsModified(conn, id);
      this.updateContentHash(conn, id);
      const examId = this.examIdForQuestion(conn, id);
      if (examId !== null) this.invalidateExamContentIndex(conn, examId);
      const updated = this.getQuestion(conn, id);
      if (updated === null) throw notFound(id);
      return updated;
    });
  }
  fillExplanationIfEmpty(conn: SqlExecutor, id: string, explanation: string): number {
    return conn.run(`UPDATE questions SET explanation = ?1
      WHERE id = ?2 AND deleted_at IS NULL
        AND (explanation IS NULL
             OR TRIM(explanation, ' ' || char(9) || char(10) || char(13)) = '')`,
    [explanation, id]).changes;
  }
  applyQuestionMetadata(conn: SqlExecutor, id: string, params: QuestionMetadataPatch): Question {
    return databaseResult(() => {
      const sets: string[] = [];
      const values: SqlParam[] = [];
      const add = (column: string, value: SqlParam) => {
        values.push(value);
        sets.push(`${column}=?${values.length}`);
      };
      if (params.card_id !== undefined) add('card_id', params.card_id);
      if (params.group_id !== undefined) add('group_id', params.group_id);
      if (params.group_position !== undefined) add('group_position', params.group_position);
      if (params.source_key !== undefined) add('source_key', params.source_key);
      if (params.provenance !== undefined) {
        add('provenance_json', params.provenance === null ? null : JSON.stringify(params.provenance));
      }
      if (params.answer_origin !== undefined) add('answer_origin', params.answer_origin);
      if (params.parent_id !== undefined) add('parent_id', params.parent_id);
      if (sets.length > 0) {
        values.push(id);
        const changed = conn.run(`UPDATE questions SET ${sets.join(',')} WHERE id=?${values.length} AND deleted_at IS NULL`, values).changes;
        if (changed === 0) {
          const current = this.getQuestion(conn, id);
          if (current === null) throw notFound(id);
        }
      }
      const updated = this.getQuestion(conn, id);
      if (updated === null) throw notFound(id);
      return updated;
    });
  }
  bindQuestionCard(conn: SqlExecutor, examId: string, cardId: string, questionId: string, now: string): number {
    return databaseResult(() => conn.run(`UPDATE questions SET card_id=?1,updated_at=?2
      WHERE id=?3 AND exam_id=?4 AND deleted_at IS NULL`, [cardId, now, questionId, examId]).changes);
  }
  mergeQuestionProvenance(conn: SqlExecutor, questionId: string, patch: JsonValue): number {
    return databaseResult(() => conn.run(`UPDATE questions
      SET provenance_json=json_patch(COALESCE(provenance_json,'{}'),json(?1)) WHERE id=?2`,
    [JSON.stringify(patch), questionId]).changes);
  }
  replaceQuestionForReparse(conn: SqlExecutor, examId: string, questionId: string,
    expectedUpdatedAt: string, params: ReparseQuestionParams, now: string): number {
    return databaseResult(() => conn.run(`UPDATE questions SET content=?1,options_json=?2,answer=?3,
        explanation=?4,question_type=?5,difficulty=?6,tags=?7,structured_data=?8,
        images_json=COALESCE(?9,images_json),updated_at=?10,
        sync_status=CASE WHEN sync_status='synced' THEN 'modified' ELSE sync_status END,
        provenance_json=json_patch(COALESCE(provenance_json,'{}'),json(?11))
      WHERE id=?12 AND exam_id=?13 AND deleted_at IS NULL AND updated_at=?14`,
    [params.content, params.options === null ? null : JSON.stringify(params.options), params.answer,
      params.explanation, params.question_type, params.difficulty, JSON.stringify(params.tags),
      params.structured_data === null || params.structured_data === undefined ? null : JSON.stringify(params.structured_data),
      params.images === undefined || params.images === null || params.images.length === 0 ? null : JSON.stringify(params.images),
      now, JSON.stringify(params.provenance_marker), questionId, examId, expectedUpdatedAt]).changes);
  }
  updateQuestionGroupMembership(conn: SqlExecutor, questionId: string,
    patch: QuestionGroupMembershipPatch): number {
    return databaseResult(() => {
      const values: SqlParam[] = [patch.group_id, patch.group_position, questionId];
      const conditions = ['id=?3', 'deleted_at IS NULL'];
      if (patch.exam_id !== undefined && patch.exam_id !== null) {
        values.push(patch.exam_id);
        conditions.push(`exam_id=?${values.length}`);
      }
      if (patch.expected_group_id !== undefined) {
        values.push(patch.expected_group_id);
        conditions.push(`group_id IS ?${values.length}`);
      }
      if (patch.allow_existing_group === true && patch.group_id !== null) {
        values.push(patch.group_id);
        conditions.push(`(group_id IS NULL OR group_id=?${values.length})`);
      }
      return conn.run(`UPDATE questions SET group_id=?1,group_position=?2 WHERE ${conditions.join(' AND ')}`, values).changes;
    });
  }
  softDeleteQuestionInGroup(conn: SqlExecutor, questionId: string, examId: string, now: string): number {
    return databaseResult(() => conn.run(`UPDATE questions SET deleted_at=?1,updated_at=?1,group_id=NULL,group_position=NULL
      WHERE id=?2 AND exam_id=?3 AND deleted_at IS NULL`, [now, questionId, examId]).changes);
  }
  submitAnswer(conn: SqlExecutor, questionId: string, userAnswer: string, isCorrect: boolean | null,
    needsManualGrading: boolean): Question {
    return databaseResult(() => {
      const now = utcNow();
      const affected = conn.run(`UPDATE questions SET
        user_answer = ?1,
        is_correct = ?2,
        attempt_count = attempt_count + 1,
        correct_count = correct_count + ?3,
        last_attempt_at = ?4,
        status = CASE
          WHEN ?5 = 1 THEN 'in_progress'
          WHEN ?2 = 0 THEN 'review'
          WHEN correct_count + ?3 >= 2 THEN 'mastered'
          ELSE 'in_progress'
        END,
        updated_at = ?6
        WHERE id = ?7 AND deleted_at IS NULL`,
      [userAnswer, isCorrect === null ? null : isCorrect ? 1 : 0, isCorrect === true ? 1 : 0,
        now, needsManualGrading ? 1 : 0, now, questionId]).changes;
      if (affected === 0) throw notFound(questionId);

      this.markAsModified(conn, questionId);
      this.updateContentHash(conn, questionId);
      const updated = this.getQuestion(conn, questionId);
      if (updated === null) throw notFound(questionId);
      return updated;
    });
  }
  applySubmissionVerdict(conn: SqlExecutor, questionId: string, submissionId: string,
    isCorrect: boolean, gradingMethod: string, now: string): VerdictApplyOutcome {
    return databaseResult(() => {
      const current = this.getSubmissionById(conn, submissionId);
      if (current === null || current.question_id !== questionId) {
        throw new VfsRepositoryError('VFS_NOT_FOUND', `作答记录不存在或不属于该题目: ${submissionId}`);
      }
      if (current.is_correct === isCorrect) {
        const unchanged = this.getQuestion(conn, questionId);
        if (unchanged === null) throw notFound(questionId);
        return { changed: false, updated_question: unchanged, submission: current };
      }
      const correctDelta = current.is_correct === true && !isCorrect ? -1
        : (current.is_correct === null || current.is_correct === false) && isCorrect ? 1 : 0;
      const submissionUpdated = conn.run(`UPDATE answer_submissions SET is_correct=?1,grading_method=?2,
          updated_at=?3,local_version=COALESCE(local_version,0)+1
        WHERE id=?4 AND question_id=?5`,
      [isCorrect, gradingMethod, now, submissionId, questionId]).changes;
      if (submissionUpdated === 0) {
        throw new VfsRepositoryError('VFS_NOT_FOUND', `作答记录不存在或不属于该题目: ${submissionId}`);
      }
      conn.run(`UPDATE questions SET
          is_correct=CASE WHEN (
            SELECT id FROM answer_submissions WHERE question_id=?3 AND deleted_at IS NULL
            ORDER BY submitted_at DESC,rowid DESC LIMIT 1
          )=?5 THEN ?1 ELSE is_correct END,
          correct_count=MAX(0,correct_count+?4),
          status=CASE
            WHEN (SELECT id FROM answer_submissions WHERE question_id=?3 AND deleted_at IS NULL
                  ORDER BY submitted_at DESC,rowid DESC LIMIT 1)<>?5 THEN status
            WHEN ?1=0 THEN 'review'
            WHEN MAX(0,correct_count+?4)>=2 THEN 'mastered'
            ELSE 'in_progress' END,
          updated_at=?2
        WHERE id=?3 AND deleted_at IS NULL`,
      [isCorrect, now, questionId, correctDelta, submissionId]);
      this.markAsModified(conn, questionId);
      this.updateContentHash(conn, questionId);
      const updated = this.getQuestion(conn, questionId);
      if (updated === null) throw notFound(questionId);
      return { changed: true, updated_question: updated,
        submission: { ...current, is_correct: isCorrect, grading_method: gradingMethod } };
    });
  }
  resetExamProgress(conn: SqlExecutor, examId: string, now: string): QuestionBankStats {
    return databaseResult(() => {
      conn.run(`UPDATE questions SET status='new',user_answer=NULL,is_correct=NULL,
          attempt_count=0,correct_count=0,last_attempt_at=NULL,ai_feedback=NULL,
          ai_score=NULL,ai_graded_at=NULL,updated_at=?1
        WHERE exam_id=?2 AND deleted_at IS NULL`, [now, examId]);
      const ids = conn.all<{ id: string }>('SELECT id FROM questions WHERE exam_id=?1 AND deleted_at IS NULL', [examId])
        .map(row => row.id);
      for (const id of ids) {
        this.markAsModified(conn, id);
        this.updateContentHash(conn, id);
      }
      this.deleteSubmissionsByExam(conn, examId);
      return this.refreshStats(conn, examId);
    });
  }
  resetQuestionProgress(conn: SqlExecutor, questionId: string, now: string): string {
    return databaseResult(() => {
      const examId = conn.pluck<string>('SELECT exam_id FROM questions WHERE id=?1 AND deleted_at IS NULL', [questionId]);
      if (examId === undefined) throw new VfsRepositoryError('VFS_NOT_FOUND', `${questionId}: not found`);
      const affected = conn.run(`UPDATE questions SET status='new',user_answer=NULL,is_correct=NULL,
          attempt_count=0,correct_count=0,last_attempt_at=NULL,ai_feedback=NULL,
          ai_score=NULL,ai_graded_at=NULL,updated_at=?1
        WHERE id=?2 AND deleted_at IS NULL`, [now, questionId]).changes;
      if (affected === 0) throw new VfsRepositoryError('VFS_NOT_FOUND', `${questionId}: not found`);
      this.markAsModified(conn, questionId);
      this.updateContentHash(conn, questionId);
      this.deleteSubmissionsByQuestion(conn, questionId);
      return examId;
    });
  }
  /** `QuestionSyncService::mark_as_modified_with_conn` (question_sync_service.rs:1518-1531)。 */
  markAsModified(conn: SqlExecutor, questionId: string): void {
    databaseResult(() => {
      conn.run(`UPDATE questions SET
        sync_status = CASE WHEN sync_status = 'synced' THEN 'modified' ELSE sync_status END
        WHERE id = ?1 AND deleted_at IS NULL`, [questionId]);
    });
  }
  /** `QuestionSyncService::update_content_hash_with_conn` (question_sync_service.rs:1540-1556)。 */
  updateContentHash(conn: SqlExecutor, questionId: string): string {
    const question = loadSyncQuestion(conn, questionId);
    const hash = computeQuestionContentHash(question);
    databaseResult(() => conn.run('UPDATE questions SET content_hash = ?1 WHERE id = ?2', [hash, questionId]));
    return hash;
  }
  /** `pipeline.rs:596-601` Grade 分支：原始 SQLite 错误不包装，调用方补 `保存 AI 反馈失败: …`。 */
  updateAiFeedback(conn: SqlExecutor, questionId: string, feedback: string, score: number | null, now: string): number {
    return conn.run(`UPDATE questions SET ai_feedback = ?1, ai_score = ?2, ai_graded_at = ?3, updated_at = ?3
      WHERE id = ?4 AND deleted_at IS NULL`, [feedback, score, now, questionId]).changes;
  }
  /** `pipeline.rs:602-607` Analyze 分支：不写 ai_score；错误同上不包装。 */
  updateAiAnalysis(conn: SqlExecutor, questionId: string, feedback: string, now: string): number {
    return conn.run(`UPDATE questions SET ai_feedback = ?1, ai_graded_at = ?2, updated_at = ?2
      WHERE id = ?3 AND deleted_at IS NULL`, [feedback, now, questionId]).changes;
  }
  deleteQuestion(conn: SqlExecutor, id: string): void {
    databaseResult(() => {
      const examId = this.examIdForQuestion(conn, id);
      if (conn.run('UPDATE questions SET deleted_at=?1,updated_at=?1 WHERE id=?2 AND deleted_at IS NULL', [utcNow(), id]).changes === 0) throw notFound(id);
      if (examId !== null) this.invalidateExamContentIndex(conn, examId);
    });
  }
  deleteQuestionIfVersion(conn: SqlExecutor, id: string, expected: string): void {
    databaseResult(() => {
      if (conn.run('UPDATE questions SET deleted_at=?1,updated_at=?1 WHERE id=?2 AND deleted_at IS NULL AND updated_at=?3', [utcNow(), id, expected]).changes !== 0) return;
      const current = this.getQuestion(conn, id);
      if (current) {
        logWarn(`[VFS::QuestionRepo] Optimistic lock conflict for question ${id}: expected updated_at='${expected}', actual='${current.updated_at}'`);
        throw new VfsRepositoryError('VFS_INTERNAL', `QBANK_CONFLICT: question_id=${id}, expected_updated_at=${expected}, actual_updated_at=${current.updated_at}`);
      }
      throw notFound(id);
    });
  }
  batchDeleteQuestions(conn: SqlExecutor, ids: readonly string[]): number {
    return databaseResult(() => {
      try {
        return atomic(conn, () => {
          const time = utcNow(); let deleted = 0; const examIds = new Set<string>();
          for (const id of ids) {
            const examId = this.examIdForQuestion(conn, id);
            if (examId !== null) examIds.add(examId);
            deleted += conn.run('UPDATE questions SET deleted_at=?1,updated_at=?1 WHERE id=?2 AND deleted_at IS NULL', [time, id]).changes;
          }
          for (const examId of examIds) this.invalidateExamContentIndex(conn, examId);
          return deleted;
        });
      } catch (error) {
        logWarn('[VFS::QuestionRepo] Batch delete failed, rolled back:', error);
        throw error;
      }
    });
  }
  countQuestions(conn: SqlExecutor, examId: string): number {
    return databaseResult(() => conn.one<{ n: number }>('SELECT COUNT(*) AS n FROM questions WHERE exam_id=?1 AND deleted_at IS NULL', [examId]).n);
  }
  countByType(conn: SqlExecutor, examId: string): Record<string, number> {
    return databaseResult(() => Object.fromEntries(conn.all<{ question_type: string; n: number }>('SELECT question_type,COUNT(*) AS n FROM questions WHERE exam_id=?1 AND deleted_at IS NULL GROUP BY question_type', [examId]).map(r => [r.question_type, Math.max(0, r.n) >>> 0])));
  }
  randomQuestionIds(conn: SqlExecutor, examId: string, filters: QuestionFilters, exclude: readonly string[], before: string | null, limit: number): string[] {
    return databaseResult(() => {
      const { conditions, params } = randomFilter(examId, filters, exclude, before);
      return conn.all<{ id: string }>(`SELECT id FROM questions WHERE ${conditions.join(' AND ')} ORDER BY RANDOM() LIMIT ?${params.length + 1}`, [...params, limit]).map(r => r.id);
    });
  }
  randomQuestions(conn: SqlExecutor, examId: string, filters: QuestionFilters, exclude: readonly string[], limit: number): Question[] {
    return databaseResult(() => {
      const { conditions, params } = randomFilter(examId, filters, exclude, null);
      const questions = mapSkippingErrors(conn.all(`SELECT ${selectQuestionColumns()} FROM questions WHERE ${conditions.join(' AND ')} ORDER BY RANDOM() LIMIT ?${params.length + 1}`, [...params, limit]), rowToQuestion);
      this.hydrateQuestionContext(conn, questions);
      return questions;
    });
  }
  recordHistory(conn: SqlExecutor, questionId: string, field: string, oldValue: string | null, newValue: string | null, operator: string, reason: string | null): QuestionHistory {
    return databaseResult(() => {
      const result = { id: `qh_${nanoid(10)}`, question_id: questionId, field_name: field, old_value: oldValue, new_value: newValue, operator, reason, created_at: utcNow() };
      conn.run('INSERT INTO question_history(id,question_id,field_name,old_value,new_value,operator,reason,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)', Object.values(result));
      return result;
    });
  }
  getHistory(conn: SqlExecutor, questionId: string, limit: number | null = null): QuestionHistory[] {
    return databaseResult(() => conn.all<QuestionHistory>('SELECT id,question_id,field_name,old_value,new_value,operator,reason,created_at FROM question_history WHERE question_id=?1 ORDER BY created_at DESC,id ASC LIMIT ?2', [questionId, limit ?? 100]));
  }
  getStats(conn: SqlExecutor, examId: string): QuestionBankStats | null {
    return databaseResult(() => conn.get<QuestionBankStats>('SELECT exam_id,total_count,new_count,in_progress_count,mastered_count,review_count,total_attempts,total_correct,correct_rate,updated_at FROM question_bank_stats WHERE exam_id=?1', [examId]) ?? null);
  }
  refreshStats(conn: SqlExecutor, examId: string): QuestionBankStats {
    return databaseResult(() => {
      const row = conn.one<Omit<QuestionBankStats, 'exam_id' | 'correct_rate' | 'updated_at'>>(`SELECT COUNT(*) AS total_count,
        COALESCE(SUM(CASE WHEN status='new' THEN 1 ELSE 0 END),0) AS new_count,
        COALESCE(SUM(CASE WHEN status='in_progress' THEN 1 ELSE 0 END),0) AS in_progress_count,
        COALESCE(SUM(CASE WHEN status='mastered' THEN 1 ELSE 0 END),0) AS mastered_count,
        COALESCE(SUM(CASE WHEN status='review' THEN 1 ELSE 0 END),0) AS review_count,
        COALESCE(SUM(attempt_count),0) AS total_attempts,COALESCE(SUM(correct_count),0) AS total_correct
        FROM questions WHERE exam_id=?1 AND deleted_at IS NULL`, [examId]);
      const result: QuestionBankStats = { exam_id: examId, ...row, correct_rate: row.total_attempts > 0 ? row.total_correct / row.total_attempts : 0, updated_at: utcNow() };
      const keys = Object.keys(result);
      conn.run(`INSERT INTO question_bank_stats(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')}) ON CONFLICT(exam_id) DO UPDATE SET ${keys.slice(1).map(k => `${k}=excluded.${k}`).join(',')}`, Object.values(result));
      return result;
    });
  }
  insertSubmission(conn: SqlExecutor, questionId: string, userAnswer: string, isCorrect: boolean | null, gradingMethod: string, requestId: string | null, questionSnapshot: string | null = null, materialSnapshot: string | null = null): string {
    return databaseResult(() => {
      const normalized = requestId === null ? null : rustTrim(requestId) || null;
      if (normalized !== null) { const existing = this.getSubmissionByClientRequest(conn, questionId, normalized); if (existing) return existing.id; }
      if (questionSnapshot === null && materialSnapshot === null) [questionSnapshot, materialSnapshot] = this.buildSubmissionSnapshots(conn, questionId);
      const id = `as_${nanoid(10)}`;
      conn.run(`INSERT INTO answer_submissions(id,question_id,user_answer,is_correct,grading_method,submitted_at,client_request_id,question_snapshot_json,material_snapshot_json)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`, [id, questionId, userAnswer, isCorrect, gradingMethod, utcNow(), normalized, questionSnapshot, materialSnapshot]);
      return id;
    });
  }
  getSubmissionSnapshot(conn: SqlExecutor, id: string): SubmissionSnapshot | null {
    return databaseResult(() => conn.get<SubmissionSnapshot>('SELECT id AS submission_id,question_snapshot_json,material_snapshot_json FROM answer_submissions WHERE id=?1', [id]) ?? null);
  }
  buildSubmissionSnapshots(conn: SqlExecutor, id: string): [string | null, string | null] {
    const q = this.getQuestion(conn, id);
    if (!q) return [null, null];
    return [JSON.stringify({ id: q.id, exam_id: q.exam_id, question_label: q.question_label, content: q.content, options: q.options, answer: q.answer,
      explanation: q.explanation, structured_data: q.structured_data, question_type: q.question_type, difficulty: q.difficulty, tags: q.tags,
      images: q.images, group_id: q.group_id, group_position: q.group_position, group_label: q.group_label, material_ids: q.materials.map(m => m.id),
      answer_origin: q.answer_origin, question_updated_at: q.updated_at }), JSON.stringify({ materials: q.materials })];
  }
  getSubmissions(conn: SqlExecutor, id: string, limit: number): AnswerSubmission[] {
    return databaseResult(() => mapSkippingErrors(conn.all(`SELECT ${submissionColumns} FROM answer_submissions WHERE question_id=?1 ORDER BY submitted_at DESC LIMIT ?2`, [id, limit]), submission));
  }
  getSubmissionsWithSnapshots(conn: SqlExecutor, id: string, limit: number): [AnswerSubmission, SubmissionSnapshot][] {
    return databaseResult(() => mapSkippingErrors(conn.all(`SELECT ${submissionColumns},question_snapshot_json,material_snapshot_json FROM answer_submissions WHERE question_id=?1 ORDER BY submitted_at DESC LIMIT ?2`, [id, limit]), row => [submission(row), { submission_id: row.id as string, question_snapshot_json: row.question_snapshot_json as string | null, material_snapshot_json: row.material_snapshot_json as string | null }]));
  }
  getSubmissionByClientRequest(conn: SqlExecutor, id: string, requestId: string): AnswerSubmission | null {
    return databaseResult(() => {
      const row = conn.get(`SELECT ${submissionColumns} FROM answer_submissions WHERE question_id=?1 AND client_request_id=?2 ORDER BY submitted_at DESC LIMIT 1`, [id, requestId]);
      return row ? submission(row) : null;
    });
  }
  getSubmissionById(conn: SqlExecutor, submissionId: string): AnswerSubmission | null {
    return databaseResult(() => {
      const row = conn.get(`SELECT ${submissionColumns} FROM answer_submissions WHERE id=?1`, [submissionId]);
      return row ? submission(row) : null;
    });
  }
  dailyProgressRows(conn: SqlExecutor, examId: string, date: string): QuestionDailyProgress {
    return databaseResult(() => {
      const rows = conn.all<{ question_id: string; correct: number }>(`
        SELECT question_id,MAX(correct) AS correct FROM (
          SELECT s.question_id AS question_id,CASE WHEN s.is_correct=1 THEN 1 ELSE 0 END AS correct
          FROM answer_submissions s
          INNER JOIN questions q ON q.id=s.question_id
          WHERE q.exam_id=?1 AND q.deleted_at IS NULL AND DATE(s.submitted_at,'localtime')=?2
          UNION ALL
          SELECT q.id AS question_id,CASE WHEN q.is_correct=1 THEN 1 ELSE 0 END AS correct
          FROM questions q
          WHERE q.exam_id=?1 AND q.deleted_at IS NULL AND q.last_attempt_at IS NOT NULL
            AND DATE(q.last_attempt_at,'localtime')=?2
            AND NOT EXISTS (SELECT 1 FROM answer_submissions s2 WHERE s2.question_id=q.id)
        ) GROUP BY question_id`, [examId, date]);
      return { ids: rows.map(row => row.question_id), correct: rows.filter(row => row.correct === 1).length };
    });
  }
  updateSubmissionCorrect(conn: SqlExecutor, id: string, correct: boolean, method: string): void {
    databaseResult(() => conn.run('UPDATE answer_submissions SET is_correct=?1,grading_method=?2 WHERE id=?3', [correct, method, id]));
  }
  deleteSubmissionsByQuestion(conn: SqlExecutor, id: string): number {
    return databaseResult(() => conn.run('DELETE FROM answer_submissions WHERE question_id=?1', [id]).changes);
  }
  deleteSubmissionsByExam(conn: SqlExecutor, id: string): number {
    return databaseResult(() => conn.run('DELETE FROM answer_submissions WHERE question_id IN (SELECT id FROM questions WHERE exam_id=?1)', [id]).changes);
  }
}
