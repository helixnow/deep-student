/**
 * `exam_sheet_service.rs` `get_from_vfs` projection: a stored `exam_sheets` row
 * plus its formal questions become the session detail the UI edits.
 */
import type { Question, VfsExamSheet } from '../../vfs-repos/api.ts';
import type {
  ExamCardPreview, ExamSheetPreviewPage, ExamSheetPreviewResult, ExamSheetSessionDetail,
  ExamSheetSessionSummary,
} from '../../../../contracts/ipc/generated/L14-qbank.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { parseRfc3339, toRfc3339Opts } from '../../../platform/time/index.ts';
import { ExamSheetSessionError } from './errors.ts';
import { decodeCardJson, decodeMetadata, decodePreview } from './exam-sheet-model.ts';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function utcTimestamp(raw: string, log: { warn(message: string): void }): string {
  const parsed = parseRfc3339(raw);
  if (parsed !== null) return toRfc3339Opts(parsed.epochNanos, 'AutoSi', true);
  log.warn(`[ExamSheetService] Failed to parse timestamp '${raw}': invalid RFC 3339 timestamp, using epoch fallback`);
  return toRfc3339Opts(0n, 'AutoSi', true);
}

function vfsSourceType(value: Question['source_type']): ExamCardPreview['source_type'] {
  switch (value) {
    case 'ocr': return 'ocr_image';
    case 'imported': return 'import_file';
    case 'manual': return 'manual_create';
    case 'ai_generated': return 'ai_generated';
    default: return 'ocr_image';
  }
}

function cardToJson(card: ExamCardPreview): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  // `serde_json::to_value(card)` omits None and empty cropped_image_path.
  value.card_id = card.card_id;
  value.page_index = card.page_index;
  value.question_label = card.question_label;
  value.bbox = { ...card.bbox };
  if (card.resolved_bbox != null) value.resolved_bbox = { ...card.resolved_bbox };
  if (card.cropped_image_path !== undefined && card.cropped_image_path !== '') {
    value.cropped_image_path = card.cropped_image_path;
  }
  value.ocr_text = card.ocr_text;
  value.tags = [...card.tags];
  if (card.extra_metadata != null) value.extra_metadata = card.extra_metadata;
  if (card.linked_mistake_ids != null) value.linked_mistake_ids = [...card.linked_mistake_ids];
  if (card.question_type != null) value.question_type = card.question_type;
  if (card.answer != null) value.answer = card.answer;
  if (card.explanation != null) value.explanation = card.explanation;
  if (card.difficulty != null) value.difficulty = card.difficulty;
  value.status = card.status;
  if (card.user_answer != null) value.user_answer = card.user_answer;
  if (card.is_correct != null) value.is_correct = card.is_correct;
  value.attempt_count = card.attempt_count;
  value.correct_count = card.correct_count;
  if (card.last_attempt_at != null) value.last_attempt_at = card.last_attempt_at;
  if (card.user_note != null) value.user_note = card.user_note;
  value.source_type = card.source_type;
  if (card.source_info != null) value.source_info = card.source_info;
  if (card.parent_card_id != null) value.parent_card_id = card.parent_card_id;
  if (card.variant_ids != null) value.variant_ids = [...card.variant_ids];
  return value;
}

function defaultPage(): ExamSheetPreviewPage {
  return { page_index: 0, cards: [], ocr_completed: true, parse_completed: true };
}

/** `formal` is every question of the sheet, already read page by page. */
export function projectExamSheetDetail(
  exam: VfsExamSheet,
  formal: readonly Question[],
  log: { warn(message: string): void },
): ExamSheetSessionDetail {
  const metadata = decodeMetadata(exam.metadataJson);
  let preview: ExamSheetPreviewResult;
  try {
    preview = decodePreview(exam.previewJson);
  } catch {
    preview = {
      temp_id: exam.tempId,
      exam_name: exam.examName ?? null,
      pages: [],
      session_id: exam.id,
    };
  }

  const metadataHasDocumentVersion = isRecord(exam.metadataJson)
    && Object.prototype.hasOwnProperty.call(exam.metadataJson, 'question_document_version');
  if (formal.length > 0 || metadataHasDocumentVersion) {
    const old = new Map<string, ExamCardPreview>();
    for (const page of preview.pages) {
      for (const card of page.cards) old.set(card.card_id, card);
    }
    for (const page of preview.pages) page.cards = [];
    if (preview.pages.length === 0) preview.pages.push(defaultPage());

    for (let index = 0; index < formal.length; index += 1) {
      const question = formal[index]!;
      const cardId = question.card_id ?? question.id;
      const previous = old.get(cardId);
      const value: Record<string, unknown> = previous === undefined ? {} : cardToJson(previous);
      value.card_id = cardId;
      value.question_label = question.question_label ?? String(index + 1);
      value.ocr_text = question.content;
      value.question_type = question.question_type;
      value.answer = question.answer;
      value.explanation = question.explanation;
      value.difficulty = question.difficulty;
      value.tags = [...question.tags];
      value.status = question.status;
      value.user_answer = question.user_answer;
      value.is_correct = question.is_correct;
      value.attempt_count = question.attempt_count;
      value.correct_count = question.correct_count;
      value.source_type = vfsSourceType(question.source_type);
      value.options = question.options;
      value.structured_data = question.structured_data;
      value.images = question.images;

      const rawPageIndex = value.page_index;
      const pageIndex = typeof rawPageIndex === 'number'
        && Number.isSafeInteger(rawPageIndex) && rawPageIndex >= 0 ? rawPageIndex : 0;
      const target = Math.min(pageIndex, preview.pages.length - 1);
      value.page_index = target;

      let card: ExamCardPreview;
      try {
        card = decodeCardJson(value);
      } catch (error) {
        throw new ExamSheetSessionError(AppError.validation(`正式题目预览投影无效: ${messageOf(error)}`));
      }
      preview.pages[target]!.cards.push(card);
    }
  }

  const summary: ExamSheetSessionSummary = {
    id: exam.id,
    ...(exam.examName === undefined || exam.examName === null ? {} : { exam_name: exam.examName }),
    temp_id: exam.tempId,
    created_at: utcTimestamp(exam.createdAt, log),
    updated_at: utcTimestamp(exam.updatedAt, log),
    status: exam.status,
    ...(metadata === null ? {} : { metadata }),
    ...(exam.linkedMistakeIds === undefined ? {} : { linked_mistake_ids: exam.linkedMistakeIds }),
  };
  return { summary, preview };
}
