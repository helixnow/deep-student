/**
 * `chat_v2/vfs_resolver.rs` 的 SQL 只读访问层。
 *
 * 与 Rust 一样，VFS 库是同一连接上的同步查询；错误在调用方按 Rust 的
 * `match conn.query_row(..)` 分支处理（有的分支降级为空，有的视为未找到）。
 * SQL 集中在本目录，符合 host 边界规则。
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';

export interface TextbookFileRow {
  fileName: string | null;
  ocrPagesJson: string | null;
  extractedText: string | null;
  previewJson: string | null;
}

/** `resolve_textbook`：按 id 优先、resource_id 兜底取一行。 */
export function textbookFileRow(db: SqlExecutor, sourceId: string): TextbookFileRow | null {
  try {
    const row = db.get<{
      fileName: string | null;
      ocrPagesJson: string | null;
      extractedText: string | null;
      previewJson: string | null;
    }>(
      'SELECT file_name AS fileName, ocr_pages_json AS ocrPagesJson, extracted_text AS extractedText, preview_json AS previewJson FROM files ' +
      'WHERE id = ?1 OR resource_id = ?1 ' +
      'ORDER BY CASE WHEN id = ?1 THEN 0 ELSE 1 END LIMIT 1',
      [sourceId],
    );
    if (!row) return null;
    return {
      fileName: row.fileName ?? null,
      ocrPagesJson: row.ocrPagesJson ?? null,
      extractedText: row.extractedText ?? null,
      previewJson: row.previewJson ?? null,
    };
  } catch (error) {
    return null;
  }
}

/** `resolve_question_image_blob`：`files` 表按 id / resource_id 兜底。 */
export function questionImageBlobHash(db: SqlExecutor, fileId: string): string | null {
  try {
    const value = db.pluck<string | null>(
      'SELECT COALESCE(compressed_blob_hash, blob_hash) FROM files WHERE id = ?1 OR resource_id = ?1 LIMIT 1',
      [fileId],
    );
    return value ?? null;
  } catch (error) {
    return null;
  }
}

export interface ExamQuestionRow {
  label: string;
  content: string;
  status: string;
  difficulty: string | null;
  questionType: string | null;
  answer: string | null;
  explanation: string | null;
  userNote: string | null;
  userAnswer: string | null;
  attemptCount: number;
  correctCount: number;
  tags: string;
}

/** `build_exam_questions_ssot_block` 的题目查询；prepare/query 失败返回 null。 */
export function examQuestionRows(db: SqlExecutor, examId: string, limit: number): ExamQuestionRow[] | null {
  try {
    const rows = db.all<{
      label: string;
      content: string;
      status: string;
      difficulty: string | null;
      questionType: string | null;
      answer: string | null;
      explanation: string | null;
      userNote: string | null;
      userAnswer: string | null;
      attemptCount: number;
      correctCount: number;
      tags: string;
    }>(
      "SELECT COALESCE(question_label, '') AS label, COALESCE(content, '') AS content, COALESCE(status, 'new') AS status, " +
      'difficulty, question_type AS questionType, answer, explanation, user_note AS userNote, user_answer AS userAnswer, ' +
      'COALESCE(attempt_count, 0) AS attemptCount, COALESCE(correct_count, 0) AS correctCount, COALESCE(tags, \'[]\') AS tags ' +
      'FROM questions WHERE exam_id = ?1 AND deleted_at IS NULL ' +
      'ORDER BY created_at ASC, id ASC LIMIT ?2',
      [examId, limit],
    );
    return rows.map(row => ({
      label: row.label ?? '',
      content: row.content ?? '',
      status: row.status ?? 'new',
      difficulty: row.difficulty ?? null,
      questionType: row.questionType ?? null,
      answer: row.answer ?? null,
      explanation: row.explanation ?? null,
      userNote: row.userNote ?? null,
      userAnswer: row.userAnswer ?? null,
      attemptCount: Number(row.attemptCount ?? 0),
      correctCount: Number(row.correctCount ?? 0),
      tags: row.tags ?? '[]',
    }));
  } catch (error) {
    return null;
  }
}

/** `build_exam_questions_ssot_block` 的 COUNT(*)（`unwrap_or(0)`）。 */
export function examQuestionTotal(db: SqlExecutor, examId: string): number {
  try {
    const value = db.pluck<number>(
      'SELECT COUNT(*) FROM questions WHERE exam_id = ?1 AND deleted_at IS NULL',
      [examId],
    );
    return Number(value ?? 0);
  } catch (error) {
    return 0;
  }
}

export interface ExamHistoryRow {
  questionId: string;
  label: string;
  userAnswer: string;
  isCorrect: number | null;
  gradingMethod: string;
  submittedAt: string;
}

/** `build_exam_history_xml`：每题最近 5 条作答；旧库/缺表返回空。 */
export function examHistoryRows(db: SqlExecutor, examId: string): ExamHistoryRow[] {
  try {
    const rows = db.all<{
      questionId: string;
      label: string | null;
      userAnswer: string;
      isCorrect: number | null;
      gradingMethod: string;
      submittedAt: string;
    }>(
      'SELECT sub.question_id AS questionId, sub.question_label AS label, sub.user_answer AS userAnswer, sub.is_correct AS isCorrect, ' +
      'sub.grading_method AS gradingMethod, sub.submitted_at AS submittedAt FROM (' +
      'SELECT s.question_id, q.question_label, s.user_answer, s.is_correct, s.grading_method, ' +
      's.submitted_at, ROW_NUMBER() OVER (PARTITION BY s.question_id ORDER BY s.submitted_at DESC) AS rn ' +
      'FROM answer_submissions s INNER JOIN questions q ON q.id = s.question_id ' +
      'WHERE q.exam_id = ?1 AND q.deleted_at IS NULL) sub ' +
      'WHERE sub.rn <= 5 ORDER BY sub.question_id, sub.submitted_at DESC',
      [examId],
    );
    return rows.map(row => ({
      questionId: row.questionId,
      label: row.label ?? '',
      userAnswer: row.userAnswer,
      isCorrect: row.isCorrect === null || row.isCorrect === undefined ? null : Number(row.isCorrect),
      gradingMethod: row.gradingMethod,
      submittedAt: row.submittedAt,
    }));
  } catch (error) {
    return [];
  }
}

export interface ExamManualImageRow {
  label: string;
  imagesJson: string;
}

/** `append_exam_manual_images`：题目手动图片；缺表/查询失败返回 null。 */
export function examManualImageRows(db: SqlExecutor, examId: string): ExamManualImageRow[] | null {
  try {
    const rows = db.all<{ label: string; imagesJson: string }>(
      "SELECT COALESCE(question_label, '') AS label, COALESCE(images_json, '[]') AS imagesJson " +
      'FROM questions WHERE exam_id = ?1 AND deleted_at IS NULL',
      [examId],
    );
    return rows.map(row => ({ label: row.label ?? '', imagesJson: row.imagesJson ?? '[]' }));
  } catch (error) {
    return null;
  }
}

export interface BlobRow {
  relativePath: string;
}

/** `resolve_exam`：`undefined` = 查询出错；`null` = 行存在但 preview_json 为空。 */
export function examPreviewJsonRow(db: SqlExecutor, examId: string): string | null | undefined {
  try {
    const row = db.get<{ previewJson: string | null }>(
      'SELECT preview_json AS previewJson FROM exam_sheets WHERE id = ?1',
      [examId],
    );
    return row ? (row.previewJson ?? null) : undefined;
  } catch (error) {
    return undefined;
  }
}

/** `VfsBlobRepo::get_blob_with_conn` 的路径解析所需列。 */
export function blobRow(db: SqlExecutor, hash: string): BlobRow | null {
  try {
    const row = db.get<{ relativePath: string }>(
      'SELECT relative_path AS relativePath FROM blobs WHERE hash = ?1',
      [hash],
    );
    return row ? { relativePath: row.relativePath } : null;
  } catch (error) {
    return null;
  }
}

// ------------------------------------------------------------------ 笔记 / 作文 / 翻译 / 导图 / 灵感卡

export interface ResourceTitleRow {
  data: string | null;
  title: string | null;
}

/** `resolve_note`：`notes JOIN resources`；无行或查询失败均返回 null（Rust 两者都返回空）。 */
export function noteContentRow(db: SqlExecutor, noteId: string): ResourceTitleRow | null {
  try {
    const row = db.get<{ data: string | null; title: string | null }>(
      'SELECT r.data, n.title FROM notes n JOIN resources r ON n.resource_id = r.id WHERE n.id = ?1',
      [noteId],
    );
    return row ? { data: row.data ?? null, title: row.title ?? null } : null;
  } catch (error) {
    return null;
  }
}

/** `resolve_essay`：单个作文轮次，`essays JOIN resources`。 */
export function essayContentRow(db: SqlExecutor, essayId: string): ResourceTitleRow | null {
  try {
    const row = db.get<{ data: string | null; title: string | null }>(
      'SELECT r.data, e.title FROM essays e JOIN resources r ON e.resource_id = r.id WHERE e.id = ?1',
      [essayId],
    );
    return row ? { data: row.data ?? null, title: row.title ?? null } : null;
  } catch (error) {
    return null;
  }
}

export interface EssaySessionInfo {
  title: string;
  essayType: string | null;
  totalRounds: number;
}

export type EssaySessionInfoResult =
  | { kind: 'ok'; info: EssaySessionInfo }
  | { kind: 'notFound' }
  | { kind: 'error'; message: string };

/** `resolve_essay_session` 第 1 步：区分 NotFound 与真正的 SQL 错误。 */
export function essaySessionInfoRow(db: SqlExecutor, sessionId: string): EssaySessionInfoResult {
  try {
    const row = db.get<{ title: string; essayType: string | null; totalRounds: number }>(
      "SELECT COALESCE(title, '') AS title, essay_type AS essayType, total_rounds AS totalRounds FROM essay_sessions " +
      'WHERE id = ?1 AND deleted_at IS NULL',
      [sessionId],
    );
    if (!row) return { kind: 'notFound' };
    return {
      kind: 'ok',
      info: {
        title: row.title ?? '',
        essayType: row.essayType ?? null,
        totalRounds: Number(row.totalRounds ?? 0),
      },
    };
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

export interface EssayRoundRow {
  roundNumber: number;
  data: string | null;
}

export type EssayRoundsResult =
  | { kind: 'ok'; rows: EssayRoundRow[] }
  | { kind: 'error'; message: string };

/** `resolve_essay_session` 第 2 步：所有轮次内容（`LEFT JOIN resources`）。 */
export function essayRoundRows(db: SqlExecutor, sessionId: string): EssayRoundsResult {
  try {
    const rows = db.all<{ roundNumber: number; data: string | null }>(
      'SELECT e.round_number AS roundNumber, r.data FROM essays e LEFT JOIN resources r ON e.resource_id = r.id ' +
      'WHERE e.session_id = ?1 AND e.deleted_at IS NULL ' +
      'ORDER BY e.round_number ASC, e.created_at ASC',
      [sessionId],
    );
    return {
      kind: 'ok',
      rows: rows.map(row => ({ roundNumber: Number(row.roundNumber ?? 0), data: row.data ?? null })),
    };
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

/** `resolve_translation`：`translations JOIN resources`。 */
export function translationContentRow(db: SqlExecutor, translationId: string): ResourceTitleRow | null {
  try {
    const row = db.get<{ data: string | null; title: string | null }>(
      'SELECT r.data, t.title FROM translations t JOIN resources r ON t.resource_id = r.id WHERE t.id = ?1',
      [translationId],
    );
    return row ? { data: row.data ?? null, title: row.title ?? null } : null;
  } catch (error) {
    return null;
  }
}

export interface MindmapContentRow {
  data: string | null;
  title: string | null;
  description: string | null;
}

export type MindmapContentResult =
  | { kind: 'ok'; row: MindmapContentRow }
  | { kind: 'notFound' }
  | { kind: 'error'; message: string };

/** `resolve_mindmap`：未找到与 SQL 错误在 Rust 中同样返回“未找到”块，这里保留区分供日志。 */
export function mindmapContentRow(db: SqlExecutor, mindmapId: string): MindmapContentResult {
  try {
    const row = db.get<{ data: string | null; title: string | null; description: string | null }>(
      'SELECT r.data, m.title, m.description FROM mindmaps m JOIN resources r ON m.resource_id = r.id ' +
      'WHERE m.id = ?1 AND m.deleted_at IS NULL',
      [mindmapId],
    );
    if (!row) return { kind: 'notFound' };
    return {
      kind: 'ok',
      row: {
        data: row.data ?? null,
        title: row.title ?? null,
        description: row.description ?? null,
      },
    };
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

/** `resolve_insight_card`：当前修订正文；任何失败都返回 null（Rust 返回空 Vec）。 */
export function insightCardContentRow(db: SqlExecutor, insightId: string): ResourceTitleRow | null {
  try {
    const row = db.get<{ data: string | null; title: string | null }>(
      'SELECT r.data, i.title FROM insights i ' +
      'JOIN insight_revisions rev ON i.current_revision_id = rev.id ' +
      'JOIN resources r ON rev.resource_id = r.id ' +
      'WHERE i.id = ?1 AND i.deleted_at IS NULL',
      [insightId],
    );
    return row ? { data: row.data ?? null, title: row.title ?? null } : null;
  } catch (error) {
    return null;
  }
}

// ------------------------------------------------------------------ 图片 / 文件 / PDF

/** `get_image_ocr_text`：`files JOIN resources`，id 优先、resource_id 兜底。 */
export function imageOcrTextRow(db: SqlExecutor, sourceId: string): string | null {
  try {
    const row = db.get<{ ocrText: string | null }>(
      'SELECT r.ocr_text AS ocrText FROM files a JOIN resources r ON a.resource_id = r.id ' +
      'WHERE a.id = ?1 OR a.resource_id = ?1 ORDER BY CASE WHEN a.id = ?1 THEN 0 ELSE 1 END LIMIT 1',
      [sourceId],
    );
    return row ? (row.ocrText ?? null) : null;
  } catch (error) {
    return null;
  }
}

/** `resolve_file` 的已存储 `extracted_text`（id 优先、resource_id 兜底）。 */
export function fileExtractedTextRow(db: SqlExecutor, sourceId: string): string | null {
  try {
    const row = db.get<{ extractedText: string | null }>(
      'SELECT extracted_text AS extractedText FROM files WHERE id = ?1 OR resource_id = ?1 ' +
      'ORDER BY CASE WHEN id = ?1 THEN 0 ELSE 1 END LIMIT 1',
      [sourceId],
    );
    return row ? (row.extractedText ?? null) : null;
  } catch (error) {
    return null;
  }
}

export interface PdfFileRow {
  previewJson: string | null;
  extractedText: string | null;
  pageCount: number | null;
  ocrPagesJson: string | null;
}

/** `resolve_pdf` 的 files 行；查询失败与无行都返回 null（Rust 走 fallback）。 */
export function pdfFileRow(db: SqlExecutor, sourceId: string): PdfFileRow | null {
  try {
    const row = db.get<{
      previewJson: string | null;
      extractedText: string | null;
      pageCount: number | null;
      ocrPagesJson: string | null;
    }>(
      'SELECT preview_json AS previewJson, extracted_text AS extractedText, page_count AS pageCount, ocr_pages_json AS ocrPagesJson FROM files ' +
      'WHERE id = ?1 OR resource_id = ?1 ORDER BY CASE WHEN id = ?1 THEN 0 ELSE 1 END LIMIT 1',
      [sourceId],
    );
    if (!row) return null;
    return {
      previewJson: row.previewJson ?? null,
      extractedText: row.extractedText ?? null,
      pageCount: row.pageCount === null || row.pageCount === undefined ? null : Number(row.pageCount),
      ocrPagesJson: row.ocrPagesJson ?? null,
    };
  } catch (error) {
    return null;
  }
}
