/**
 * serde #6: `exam_sheets.preview_json` / `metadata_json` text.
 *
 * Rust `ExamSheetService::save_to_vfs` (`dstu-vision/src/exam_sheet_service.rs:93-107`)
 * stores `serde_json::to_value(&detail.preview)` / `to_value(&detail.summary.metadata)`.
 * Struct field order comes from `dstu-core/src/models.rs:258-492` (`preserve_order`);
 * `ExamCardBBox` is f32, so whole numbers print `50.0` and fractions use the f32
 * shortest spelling. `QuestionBankStats.correct_rate` is f64.
 */
import { describe, expect, it } from 'vitest';
import {
  ExamSheetSessionError, decodePreview, encodePreview,
  type ExamSheetPreviewResult,
} from '../api.ts';
import { encodeMetadata, encodeMetadataJson, encodePreviewJson } from '../src/exam-sheet-model.ts';
import { ExamSheetSessionError as InternalExamSheetSessionError } from '../src/errors.ts';

const preview: ExamSheetPreviewResult = {
  temp_id: 'tmp_1',
  exam_name: null,
  pages: [{
    page_index: 0,
    blob_hash: 'hash_page',
    width: 800,
    height: 600,
    original_image_path: '',
    cards: [{
      card_id: 'card_1',
      page_index: 0,
      question_label: '1',
      bbox: { x: 0.1, y: 0.123456789, width: 0.5, height: 0 },
      resolved_bbox: { x: 50, y: 100, width: 300, height: 120.5 },
      cropped_image_path: '',
      ocr_text: '题干',
      tags: ['代数'],
      extra_metadata: { score: 2 },
      question_type: 'single_choice',
      answer: 'A',
      status: 'review',
      is_correct: false,
      attempt_count: 2,
      correct_count: 1,
      user_note: 'n',
      source_type: 'import_file',
      variant_ids: ['v1'],
    }],
    raw_ocr_text: 'raw',
    ocr_completed: true,
    parse_completed: false,
  }],
  instructions: 'do it',
  session_id: 'exam_1',
};

const RUST_PREVIEW_JSON = '{"temp_id":"tmp_1","exam_name":null,"pages":[{"page_index":0,'
  + '"blob_hash":"hash_page","width":800,"height":600,"cards":[{"card_id":"card_1","page_index":0,'
  + '"question_label":"1","bbox":{"x":0.1,"y":0.12345679,"width":0.5,"height":0.0},'
  + '"resolved_bbox":{"x":50.0,"y":100.0,"width":300.0,"height":120.5},"ocr_text":"题干",'
  + '"tags":["代数"],"extra_metadata":{"score":2},"question_type":"single_choice","answer":"A",'
  + '"status":"review","is_correct":false,"attempt_count":2,"correct_count":1,"user_note":"n",'
  + '"source_type":"import_file","variant_ids":["v1"]}],"raw_ocr_text":"raw","ocr_completed":true,'
  + '"parse_completed":false}],"instructions":"do it","session_id":"exam_1"}';

describe('preview_json follows serde_json::to_value(&ExamSheetPreviewResult)', () => {
  it('writes Rust field order, f32 bbox spelling and skips None/empty fields', () => {
    expect(encodePreviewJson(preview)).toBe(RUST_PREVIEW_JSON);
    // The repository persists the value with JSON.stringify.
    expect(JSON.stringify(encodePreview(preview))).toBe(RUST_PREVIEW_JSON);
  });

  it('round-trips through decodePreview, including its own f32 number atoms', () => {
    const encoded = encodePreview(preview);
    const decoded = decodePreview(encoded);
    // serde_json::Value subtrees keep their number spelling (arbitrary_precision).
    expect(JSON.stringify(decoded.pages[0]!.cards[0]!.extra_metadata)).toBe('{"score":2}');
    decoded.pages[0]!.cards[0]!.extra_metadata = { score: 2 };
    expect(decoded).toEqual({
      ...preview,
      pages: [{
        ...preview.pages[0]!,
        original_image_path: undefined,
        cards: [{
          ...preview.pages[0]!.cards[0]!,
          cropped_image_path: undefined,
          bbox: { x: 0.1, y: 0.12345679, width: 0.5, height: 0 },
        }],
      }],
    });
    expect(JSON.stringify(encodePreview(decodePreview(encoded)))).toBe(RUST_PREVIEW_JSON);
    expect(JSON.stringify(encodePreview(decodePreview(JSON.parse(RUST_PREVIEW_JSON))))).toBe(RUST_PREVIEW_JSON);
  });

  it('keeps the Option<String> exam_name as null instead of skipping it', () => {
    const minimal = decodePreview({});
    expect(JSON.stringify(encodePreview(minimal))).toBe('{"temp_id":"","exam_name":null,"pages":[]}');
  });

  it('exports the pure codec and ExamSheetSessionError for qbank', () => {
    expect(typeof encodePreview).toBe('function');
    expect(typeof decodePreview).toBe('function');
    expect(ExamSheetSessionError).toBe(InternalExamSheetSessionError);
  });
});

describe('metadata_json follows serde_json::to_value(&Option<ExamSheetSessionMetadata>)', () => {
  it('writes Rust field order and f64 correct_rate', () => {
    const metadata = {
      source_type: 'ocr_image' as const,
      instructions: 'i',
      page_count: 2,
      stats: {
        total_count: 1, mastered_count: 1, review_count: 0, in_progress_count: 0, new_count: 0,
        correct_rate: 1,
      },
    };
    const rust = '{"instructions":"i","page_count":2,"source_type":"ocr_image","stats":'
      + '{"total_count":1,"mastered_count":1,"review_count":0,"in_progress_count":0,"new_count":0,'
      + '"correct_rate":1.0}}';
    expect(encodeMetadataJson(metadata)).toBe(rust);
    expect(JSON.stringify(encodeMetadata(metadata))).toBe(rust);
    expect(encodeMetadataJson(null)).toBe('null');
    expect(encodeMetadata(null)).toBeNull();
  });
});
