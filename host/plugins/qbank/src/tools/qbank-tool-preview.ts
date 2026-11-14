/**
 * Legacy `exam_sheets.preview_json` path of the qbank tools: `ExamSheetPreviewResult`
 * (dstu-core/src/models.rs:397-490) decoded with serde semantics and re-encoded with its
 * `skip_serializing_if` rules, plus `check_answer_correctness` (qbank_executor.rs:1443).
 */
import type { JsonValue } from '../../../../platform/errors/api.ts';
import {
  boolean, dflt, f64, i32, json, opt, req, string, struct, u32, unitEnum, usize, vec, type Decoder,
} from '../../repository/serde-decode.ts';
import { examCardBBoxJson, type ExamCardBBox } from '../exam-card-bbox.ts';
import { errorText, qbankConflictError } from './qbank-tool-args.ts';
import type { QbankToolEnv } from './qbank-tool-env.ts';

export type PreviewStatus = 'new' | 'in_progress' | 'mastered' | 'review';
export type PreviewQuestionType = 'single_choice' | 'multiple_choice' | 'indefinite_choice' | 'fill_blank'
  | 'short_answer' | 'essay' | 'calculation' | 'proof' | 'true_false' | 'matching' | 'ordering' | 'numeric' | 'other';

export interface PreviewCard {
  card_id: string;
  question_label: string;
  ocr_text: string;
  tags: string[];
  question_type?: PreviewQuestionType;
  answer?: string;
  explanation?: string;
  difficulty?: string;
  status: PreviewStatus;
  user_answer?: string;
  is_correct?: boolean;
  attempt_count: number;
  correct_count: number;
  last_attempt_at?: string;
  user_note?: string;
  [key: string]: unknown;
}

export interface PreviewPage { cards: PreviewCard[]; [key: string]: unknown }
export interface PreviewDocument { pages: PreviewPage[]; [key: string]: unknown }

const bbox = struct('ExamCardBBox', { x: req(f64), y: req(f64), width: req(f64), height: req(f64) });
const questionType = unitEnum<PreviewQuestionType>(['single_choice', 'multiple_choice', 'indefinite_choice',
  'fill_blank', 'short_answer', 'essay', 'calculation', 'proof', 'true_false', 'matching', 'ordering', 'numeric', 'other']);
const difficulty = unitEnum(['easy', 'medium', 'hard', 'very_hard']);
const status = unitEnum<PreviewStatus>(['new', 'in_progress', 'mastered', 'review']);
const sourceTypeNames = unitEnum(['ocr_image', 'import_file', 'manual_create', 'ai_generated', 'ocr', 'imported', 'manual']);
/** `SourceType` with `#[serde(alias = "ocr" | "imported" | "manual")]`. */
const sourceType: Decoder<string> = (value, path) => {
  const name = sourceTypeNames(value, path);
  return ({ ocr: 'ocr_image', imported: 'import_file', manual: 'manual_create' } as Record<string, string>)[name] ?? name;
};

const card = struct<PreviewCard>('ExamCardPreview', {
  card_id: dflt(string, () => ''),
  page_index: dflt(usize, () => 0),
  question_label: dflt(string, () => ''),
  bbox: dflt(bbox, () => ({ x: 0, y: 0, width: 0, height: 0 })),
  resolved_bbox: opt(bbox, true),
  cropped_image_path: dflt(string, () => ''),
  ocr_text: dflt(string, () => ''),
  tags: dflt(vec(string), () => []),
  extra_metadata: opt(json, true),
  linked_mistake_ids: opt(vec(string), true),
  question_type: opt(questionType, true),
  answer: opt(string, true),
  explanation: opt(string, true),
  difficulty: opt(difficulty, true),
  status: dflt(status, () => 'new'),
  user_answer: opt(string, true),
  is_correct: opt(boolean, true),
  attempt_count: dflt(i32, () => 0),
  correct_count: dflt(i32, () => 0),
  last_attempt_at: opt(string, true),
  user_note: opt(string, true),
  source_type: dflt(sourceType, () => 'ocr_image'),
  source_info: opt(json, true),
  parent_card_id: opt(string, true),
  variant_ids: opt(vec(string), true),
});

const page = struct<PreviewPage>('ExamSheetPreviewPage', {
  page_index: req(usize),
  blob_hash: opt(string, true),
  width: opt(u32, true),
  height: opt(u32, true),
  original_image_path: dflt(string, () => ''),
  cards: req(vec(card)),
  raw_ocr_text: opt(string, true),
  ocr_completed: dflt(boolean, () => false),
  parse_completed: dflt(boolean, () => false),
});

const preview = struct<PreviewDocument>('ExamSheetPreviewResult', {
  temp_id: dflt(string, () => ''),
  exam_name: opt(string),
  pages: dflt(vec(page), () => []),
  raw_model_response: opt(json, true),
  instructions: opt(string, true),
  session_id: opt(string, true),
});

/** `serde_json::from_value::<ExamSheetPreviewResult>`; throws on any shape mismatch. */
export function decodeToolPreview(value: unknown): PreviewDocument {
  return preview(value, '');
}

/**
 * `serde_json::to_value(&ExamSheetPreviewResult)` (`skip_serializing_if = "String::is_empty"` paths).
 * Copied level by level, never `structuredClone`d: `serde_json::Value` fields may hold
 * `JSON.rawJSON` number atoms, which cannot be cloned.
 */
export function encodeToolPreview(document: PreviewDocument): JsonValue {
  const pages = document.pages.map(entry => {
    const encoded: PreviewPage = { ...entry, cards: entry.cards.map(encodeCard) };
    if (encoded.original_image_path === '') delete encoded.original_image_path;
    return encoded;
  });
  return { ...document, pages } as unknown as JsonValue;
}

function encodeCard(entry: PreviewCard): PreviewCard {
  const encoded: PreviewCard = { ...entry, bbox: examCardBBoxJson(entry.bbox as ExamCardBBox) };
  if (encoded.resolved_bbox !== undefined) encoded.resolved_bbox = examCardBBoxJson(encoded.resolved_bbox as ExamCardBBox);
  if (encoded.cropped_image_path === '') delete encoded.cropped_image_path;
  return encoded;
}

export function previewCards(document: PreviewDocument): PreviewCard[] {
  return document.pages.flatMap(entry => entry.cards);
}

/** `VfsExamRepo::get_exam_sheet` + preview decode used by every legacy fallback. */
export function loadPreview(env: QbankToolEnv, sessionId: string): { document: PreviewDocument; updatedAt: string } {
  const { db, repos } = env.vfs();
  let exam;
  try { exam = repos.exams.getExamSheet(db, sessionId); }
  catch (error) { throw new Error(`Failed to get exam sheet: ${errorText(error)}`); }
  if (exam === null) throw new Error('Exam sheet not found');
  let document: PreviewDocument;
  try { document = decodeToolPreview(exam.previewJson); }
  catch (error) { throw new Error(`Failed to parse preview: ${errorText(error)}`); }
  return { document, updatedAt: exam.updatedAt };
}

export function writePreviewIfUnchanged(env: QbankToolEnv, sessionId: string, document: PreviewDocument,
  revision: string, conflictMessage: string, conflictHint: string): void {
  const { db, repos } = env.vfs();
  let ok: boolean;
  try { ok = repos.exams.updatePreviewJsonIfUnchanged(db, sessionId, encodeToolPreview(document), revision); }
  catch (error) { throw new Error(`Failed to update exam sheet: ${errorText(error)}`); }
  if (!ok) throw qbankConflictError(conflictMessage, conflictHint, { session_id: sessionId, expected_updated_at: revision });
}

/** qbank_executor.rs:1443 `check_answer_correctness` (legacy preview grading). */
export function checkPreviewAnswerCorrectness(userAnswer: string, correctAnswer: string,
  type: PreviewQuestionType | undefined): boolean {
  const normalize = (value: string): string => Array.from(value.trim().toLowerCase())
    .filter(ch => !/\s/u.test(ch)).join('');
  const normalizeChoice = (value: string): string => Array.from(value.toUpperCase())
    .filter(ch => /[\p{L}\p{N}]/u.test(ch)).join('');
  if (type === 'multiple_choice') {
    const user = Array.from(normalizeChoice(userAnswer)).sort();
    const correct = Array.from(normalizeChoice(correctAnswer)).sort();
    return user.length === correct.length && user.every((ch, index) => ch === correct[index]);
  }
  if (type === 'single_choice') return normalizeChoice(userAnswer) === normalizeChoice(correctAnswer);
  return normalize(userAnswer) === normalize(correctAnswer);
}
