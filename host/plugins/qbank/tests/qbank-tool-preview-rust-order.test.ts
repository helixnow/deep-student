import { describe, expect, it } from 'vitest';
import { decodeToolPreview, encodeToolPreview } from '../src/tools/qbank-tool-preview.ts';

/** Persisted preview_json key order; existing rows and the W04 decoder depend on it. */
const FIELD_ORDER: Record<string, string[]> = {
  ExamSheetPreviewResult: ['temp_id', 'exam_name', 'pages', 'raw_model_response', 'instructions', 'session_id'],
  ExamSheetPreviewPage: ['page_index', 'blob_hash', 'width', 'height', 'original_image_path', 'cards', 'raw_ocr_text',
    'ocr_completed', 'parse_completed'],
  ExamCardPreview: ['card_id', 'page_index', 'question_label', 'bbox', 'resolved_bbox', 'cropped_image_path', 'ocr_text',
    'tags', 'extra_metadata', 'linked_mistake_ids', 'question_type', 'answer', 'explanation', 'difficulty', 'status',
    'user_answer', 'is_correct', 'attempt_count', 'correct_count', 'last_attempt_at', 'user_note', 'source_type',
    'source_info', 'parent_card_id', 'variant_ids'],
};
const rustFields = (struct: string): string[] => FIELD_ORDER[struct]!;

const FULL_CARD = {
  variant_ids: ['v'], parent_card_id: 'p', source_info: { s: 1 }, source_type: 'manual', user_note: 'n',
  last_attempt_at: 't', correct_count: 1, attempt_count: 2, is_correct: true, user_answer: 'A', status: 'review',
  difficulty: 'hard', explanation: 'e', answer: 'A', question_type: 'single_choice', linked_mistake_ids: ['m'],
  extra_metadata: { k: 1 }, tags: ['x'], ocr_text: 'o', cropped_image_path: 'c.png',
  resolved_bbox: { x: 0, y: 0, width: 1, height: 1 }, bbox: { x: 0, y: 0, width: 1, height: 1 },
  question_label: '1', page_index: 0, card_id: 'c',
};
const FULL_PAGE = {
  parse_completed: true, ocr_completed: true, raw_ocr_text: 'r', cards: [FULL_CARD], original_image_path: 'p.png',
  height: 2, width: 1, blob_hash: 'h', page_index: 0,
};
const FULL_PREVIEW = {
  session_id: 's', instructions: 'i', raw_model_response: { r: 1 }, pages: [FULL_PAGE], exam_name: 'e', temp_id: 't',
};

describe('qbank 的 preview_json 编码按 Rust 结构体字段声明顺序输出（W04 decodePreview 交接依据）', () => {
  it('ExamSheetPreviewResult / ExamSheetPreviewPage / ExamCardPreview 键序与 models.rs 一致', () => {
    const encoded = encodeToolPreview(decodeToolPreview(FULL_PREVIEW)) as {
      pages: { cards: Record<string, unknown>[] }[];
    } & Record<string, unknown>;
    expect(Object.keys(encoded)).toEqual(rustFields('ExamSheetPreviewResult'));
    expect(Object.keys(encoded.pages[0]!)).toEqual(rustFields('ExamSheetPreviewPage'));
    expect(Object.keys(encoded.pages[0]!.cards[0]!)).toEqual(rustFields('ExamCardPreview'));
  });
});
