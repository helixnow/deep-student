/**
 * `dstu-vision/src/exam_sheet_service.rs` typed preview/metadata handling and
 * bbox geometry.  The Rust service round-trips `ExamSheetPreviewResult`,
 * `ExamCardPreview` and `ExamSheetSessionMetadata` through serde, which drops
 * unknown fields and applies the struct defaults below; reproducing that here
 * keeps card updates and VFS writes byte-shape compatible.
 */
import type {
  ExamCardPreview, ExamSheetPreviewPage, ExamSheetPreviewResult,
  ExamSheetSessionMetadata,
} from '../../../../contracts/ipc/generated/L14-qbank.ts';
import { isNumberAtom, rs, toRustJson, type RustSchema } from '../../../platform/serde-compat/index.ts';
import {
  compareUtf8 as compareUtf8Bytes, jsonNumberToRawJSON, parseJsonDocument, rustTrim, type JsonNode,
} from '../../../platform/util/portable.ts';

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BBoxPixels {
  x: number;
  y: number;
  width: number;
  height: number;
}

type JsonRecord = Record<string, unknown>;

export class PreviewDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreviewDecodeError';
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(path: string, expected: string): never {
  throw new PreviewDecodeError(`invalid type at ${path}: expected ${expected}`);
}

function record(value: unknown, path: string): JsonRecord {
  if (!isRecord(value)) fail(path, 'object');
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'string');
  return value;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'boolean');
  return value;
}

/** `encodePreview` output carries `JSON.rawJSON` number atoms; read them back as numbers. */
function unwrapNumber(value: unknown): unknown {
  return isNumberAtom(value) ? Number(value.rawJSON) : value;
}

function finite(raw: unknown, path: string): number {
  const value = unwrapNumber(raw);
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'number');
  return value;
}

function usize(raw: unknown, path: string): number {
  const value = unwrapNumber(raw);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(path, 'usize');
  }
  return value;
}

function u32(raw: unknown, path: string): number {
  const value = unwrapNumber(raw);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0
    || value > 0xffffffff) {
    fail(path, 'u32');
  }
  return value;
}

function i32(raw: unknown, path: string): number {
  const value = unwrapNumber(raw);
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
    || value < -2147483648 || value > 2147483647) {
    fail(path, 'i32');
  }
  return value;
}

function optional<T>(value: unknown, path: string, decode: (value: unknown, path: string) => T): T | undefined {
  if (value === undefined || value === null) return undefined;
  return decode(value, path);
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) fail(path, 'array');
  return value.map((item, index) => string(item, `${path}[${index}]`));
}

function bbox(value: unknown, path: string): BBox {
  const source = record(value, path);
  return {
    x: finite(source.x, `${path}.x`),
    y: finite(source.y, `${path}.y`),
    width: finite(source.width, `${path}.width`),
    height: finite(source.height, `${path}.height`),
  };
}

const QUESTION_TYPES = new Set([
  'single_choice', 'multiple_choice', 'indefinite_choice', 'fill_blank', 'short_answer',
  'essay', 'calculation', 'proof', 'true_false', 'matching', 'ordering', 'numeric', 'other',
]);
const DIFFICULTIES = new Set(['easy', 'medium', 'hard', 'very_hard']);
const QUESTION_STATUSES = new Set(['new', 'in_progress', 'mastered', 'review']);
const SOURCE_TYPES = new Map<string, ExamCardPreview['source_type']>([
  ['ocr_image', 'ocr_image'], ['ocr', 'ocr_image'],
  ['import_file', 'import_file'], ['imported', 'import_file'],
  ['manual_create', 'manual_create'], ['manual', 'manual_create'],
  ['ai_generated', 'ai_generated'],
]);

function enumValue<T extends string>(value: unknown, path: string, allowed: Set<string>): T {
  if (typeof value !== 'string' || !allowed.has(value)) fail(path, 'enum');
  return value as T;
}

function sourceType(value: unknown, path: string): ExamCardPreview['source_type'] {
  if (typeof value !== 'string') fail(path, 'source_type');
  const mapped = SOURCE_TYPES.get(value);
  if (mapped === undefined) fail(path, 'source_type');
  return mapped;
}

function decodeCard(value: unknown, path: string): ExamCardPreview {
  const source = record(value, path);
  const card: ExamCardPreview = {
    card_id: source.card_id === undefined ? '' : string(source.card_id, `${path}.card_id`),
    page_index: source.page_index === undefined ? 0 : usize(source.page_index, `${path}.page_index`),
    question_label: source.question_label === undefined
      ? '' : string(source.question_label, `${path}.question_label`),
    bbox: source.bbox === undefined ? { x: 0, y: 0, width: 0, height: 0 } : bbox(source.bbox, `${path}.bbox`),
    ocr_text: source.ocr_text === undefined ? '' : string(source.ocr_text, `${path}.ocr_text`),
    tags: source.tags === undefined ? [] : stringArray(source.tags, `${path}.tags`),
    status: source.status === undefined
      ? 'new' : enumValue(source.status, `${path}.status`, QUESTION_STATUSES),
    attempt_count: source.attempt_count === undefined ? 0 : i32(source.attempt_count, `${path}.attempt_count`),
    correct_count: source.correct_count === undefined ? 0 : i32(source.correct_count, `${path}.correct_count`),
    source_type: source.source_type === undefined
      ? 'ocr_image' : sourceType(source.source_type, `${path}.source_type`),
  };

  const resolved = optional(source.resolved_bbox, `${path}.resolved_bbox`, bbox);
  if (resolved !== undefined) card.resolved_bbox = resolved;
  const cropped = optional(source.cropped_image_path, `${path}.cropped_image_path`, string);
  if (cropped !== undefined && cropped !== '') card.cropped_image_path = cropped;
  if (source.extra_metadata !== undefined && source.extra_metadata !== null) {
    card.extra_metadata = source.extra_metadata;
  }
  const linked = optional(source.linked_mistake_ids, `${path}.linked_mistake_ids`, stringArray);
  if (linked !== undefined) card.linked_mistake_ids = linked;
  if (source.question_type !== undefined && source.question_type !== null) {
    card.question_type = enumValue(source.question_type, `${path}.question_type`, QUESTION_TYPES) as ExamCardPreview['question_type'];
  }
  const answer = optional(source.answer, `${path}.answer`, string);
  if (answer !== undefined) card.answer = answer;
  const explanation = optional(source.explanation, `${path}.explanation`, string);
  if (explanation !== undefined) card.explanation = explanation;
  if (source.difficulty !== undefined && source.difficulty !== null) {
    card.difficulty = enumValue(source.difficulty, `${path}.difficulty`, DIFFICULTIES) as ExamCardPreview['difficulty'];
  }
  const userAnswer = optional(source.user_answer, `${path}.user_answer`, string);
  if (userAnswer !== undefined) card.user_answer = userAnswer;
  if (source.is_correct !== undefined && source.is_correct !== null) {
    card.is_correct = bool(source.is_correct, `${path}.is_correct`);
  }
  const lastAttempt = optional(source.last_attempt_at, `${path}.last_attempt_at`, string);
  if (lastAttempt !== undefined) card.last_attempt_at = lastAttempt;
  const userNote = optional(source.user_note, `${path}.user_note`, string);
  if (userNote !== undefined) card.user_note = userNote;
  if (source.source_info !== undefined && source.source_info !== null) {
    card.source_info = source.source_info;
  }
  const parent = optional(source.parent_card_id, `${path}.parent_card_id`, string);
  if (parent !== undefined) card.parent_card_id = parent;
  const variants = optional(source.variant_ids, `${path}.variant_ids`, stringArray);
  if (variants !== undefined) card.variant_ids = variants;
  return card;
}

/** `serde_json::from_value::<ExamCardPreview>`. */
export function decodeCardJson(value: unknown): ExamCardPreview {
  return decodeCard(value, 'card');
}

function decodePage(value: unknown, path: string): ExamSheetPreviewPage {
  const source = record(value, path);
  if (source.cards === undefined) fail(`${path}.cards`, 'array');
  const page: ExamSheetPreviewPage = {
    page_index: usize(source.page_index, `${path}.page_index`),
    cards: (source.cards as unknown[]).map((card, index) => decodeCard(card, `${path}.cards[${index}]`)),
    ocr_completed: source.ocr_completed === undefined ? false : bool(source.ocr_completed, `${path}.ocr_completed`),
    parse_completed: source.parse_completed === undefined
      ? false : bool(source.parse_completed, `${path}.parse_completed`),
  };
  if (source.blob_hash !== undefined && source.blob_hash !== null) {
    page.blob_hash = string(source.blob_hash, `${path}.blob_hash`);
  }
  if (source.width !== undefined && source.width !== null) {
    page.width = u32(source.width, `${path}.width`);
  }
  if (source.height !== undefined && source.height !== null) {
    page.height = u32(source.height, `${path}.height`);
  }
  if (source.original_image_path !== undefined) {
    const pathValue = string(source.original_image_path, `${path}.original_image_path`);
    if (pathValue !== '') page.original_image_path = pathValue;
  }
  if (source.raw_ocr_text !== undefined && source.raw_ocr_text !== null) {
    page.raw_ocr_text = string(source.raw_ocr_text, `${path}.raw_ocr_text`);
  }
  return page;
}

/** `serde_json::from_value::<ExamSheetPreviewResult>`; throws on any type mismatch. */
export function decodePreview(value: unknown): ExamSheetPreviewResult {
  const source = record(value, 'preview');
  if (source.pages !== undefined && !Array.isArray(source.pages)) fail('preview.pages', 'array');
  const preview: ExamSheetPreviewResult = {
    temp_id: source.temp_id === undefined ? '' : string(source.temp_id, 'preview.temp_id'),
    exam_name: source.exam_name === undefined || source.exam_name === null
      ? null : string(source.exam_name, 'preview.exam_name'),
    pages: ((source.pages as unknown[] | undefined) ?? [])
      .map((page, index) => decodePage(page, `preview.pages[${index}]`)),
  };
  if (source.raw_model_response !== undefined && source.raw_model_response !== null) {
    preview.raw_model_response = source.raw_model_response;
  }
  if (source.instructions !== undefined && source.instructions !== null) {
    preview.instructions = string(source.instructions, 'preview.instructions');
  }
  if (source.session_id !== undefined && source.session_id !== null) {
    preview.session_id = string(source.session_id, 'preview.session_id');
  }
  return preview;
}

function decodeImportSource(value: unknown, path: string): ExamSheetSessionMetadata['import_source'] {
  const source = record(value, path);
  const result: NonNullable<ExamSheetSessionMetadata['import_source']> = {};
  for (const key of ['file_name', 'file_type', 'import_time'] as const) {
    if (source[key] !== undefined && source[key] !== null) {
      result[key] = string(source[key], `${path}.${key}`);
    }
  }
  return result;
}

function decodeStats(value: unknown, path: string): NonNullable<ExamSheetSessionMetadata['stats']> {
  const source = record(value, path);
  const stats = {
    total_count: i32(source.total_count, `${path}.total_count`),
    mastered_count: i32(source.mastered_count, `${path}.mastered_count`),
    review_count: i32(source.review_count, `${path}.review_count`),
    in_progress_count: i32(source.in_progress_count, `${path}.in_progress_count`),
    new_count: i32(source.new_count, `${path}.new_count`),
  } as NonNullable<ExamSheetSessionMetadata['stats']>;
  if (source.correct_rate !== undefined && source.correct_rate !== null) {
    stats.correct_rate = finite(source.correct_rate, `${path}.correct_rate`);
  }
  if (source.last_updated !== undefined && source.last_updated !== null) {
    stats.last_updated = string(source.last_updated, `${path}.last_updated`);
  }
  return stats;
}

/** `serde_json::from_value::<ExamSheetSessionMetadata>`, `None` on failure. */
export function decodeMetadata(value: unknown): ExamSheetSessionMetadata | null {
  try {
    if (!isRecord(value)) return null;
    const metadata: ExamSheetSessionMetadata = { source_type: 'ocr_image' };
    const instructions = optional(value.instructions, 'metadata.instructions', string);
    if (instructions !== undefined) metadata.instructions = instructions;
    const tags = optional(value.tags, 'metadata.tags', stringArray);
    if (tags !== undefined) metadata.tags = tags;
    if (value.page_count !== undefined && value.page_count !== null) {
      metadata.page_count = usize(value.page_count, 'metadata.page_count');
    }
    if (value.card_count !== undefined && value.card_count !== null) {
      metadata.card_count = usize(value.card_count, 'metadata.card_count');
    }
    if (value.raw_model_response !== undefined && value.raw_model_response !== null) {
      metadata.raw_model_response = value.raw_model_response;
    }
    if (value.source_type !== undefined) {
      metadata.source_type = sourceType(value.source_type, 'metadata.source_type') as
        ExamSheetSessionMetadata['source_type'];
    }
    if (value.import_source !== undefined && value.import_source !== null) {
      metadata.import_source = decodeImportSource(value.import_source, 'metadata.import_source');
    }
    if (value.stats !== undefined && value.stats !== null) {
      metadata.stats = decodeStats(value.stats, 'metadata.stats');
    }
    return metadata;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ serde encoding

const optionNone = { skipIf: 'none' } as const;
const stringEmpty = { skipIf: 'empty' } as const;
const unitEnum = (...values: string[]): RustSchema => rs.literal(...values);

/** `dstu-core/src/models.rs` `ExamCardBBox` (all `f32`). */
const EXAM_CARD_BBOX = rs.struct({ x: rs.f32, y: rs.f32, width: rs.f32, height: rs.f32 });

/** `models.rs` `ExamCardPreview`, declaration order. */
const EXAM_CARD_PREVIEW = rs.struct({
  card_id: rs.string,
  page_index: rs.usize,
  question_label: rs.string,
  bbox: EXAM_CARD_BBOX,
  resolved_bbox: rs.field(rs.option(EXAM_CARD_BBOX), optionNone),
  cropped_image_path: rs.field(rs.string, stringEmpty),
  ocr_text: rs.string,
  tags: rs.vec(rs.string),
  extra_metadata: rs.field(rs.option(rs.value()), optionNone),
  linked_mistake_ids: rs.field(rs.option(rs.vec(rs.string)), optionNone),
  question_type: rs.field(rs.option(unitEnum(...QUESTION_TYPES)), optionNone),
  answer: rs.field(rs.option(rs.string), optionNone),
  explanation: rs.field(rs.option(rs.string), optionNone),
  difficulty: rs.field(rs.option(unitEnum(...DIFFICULTIES)), optionNone),
  status: unitEnum(...QUESTION_STATUSES),
  user_answer: rs.field(rs.option(rs.string), optionNone),
  is_correct: rs.field(rs.option(rs.bool), optionNone),
  attempt_count: rs.i32,
  correct_count: rs.i32,
  last_attempt_at: rs.field(rs.option(rs.string), optionNone),
  user_note: rs.field(rs.option(rs.string), optionNone),
  source_type: unitEnum(...new Set(SOURCE_TYPES.values())),
  source_info: rs.field(rs.option(rs.value()), optionNone),
  parent_card_id: rs.field(rs.option(rs.string), optionNone),
  variant_ids: rs.field(rs.option(rs.vec(rs.string)), optionNone),
});

/** `models.rs` `ExamSheetPreviewPage`. */
const EXAM_SHEET_PREVIEW_PAGE = rs.struct({
  page_index: rs.usize,
  blob_hash: rs.field(rs.option(rs.string), optionNone),
  width: rs.field(rs.option(rs.u32), optionNone),
  height: rs.field(rs.option(rs.u32), optionNone),
  original_image_path: rs.field(rs.string, stringEmpty),
  cards: rs.vec(EXAM_CARD_PREVIEW),
  raw_ocr_text: rs.field(rs.option(rs.string), optionNone),
  ocr_completed: rs.bool,
  parse_completed: rs.bool,
});

/** `models.rs` `ExamSheetPreviewResult`; `exam_name` has no skip attribute. */
const EXAM_SHEET_PREVIEW_RESULT = rs.struct({
  temp_id: rs.string,
  exam_name: rs.option(rs.string),
  pages: rs.vec(EXAM_SHEET_PREVIEW_PAGE),
  raw_model_response: rs.field(rs.option(rs.value()), optionNone),
  instructions: rs.field(rs.option(rs.string), optionNone),
  session_id: rs.field(rs.option(rs.string), optionNone),
});

/** `models.rs` `ExamSheetSessionMetadata` with `ImportSource` / `QuestionBankStats`. */
const EXAM_SHEET_SESSION_METADATA = rs.option(rs.struct({
  instructions: rs.field(rs.option(rs.string), optionNone),
  tags: rs.field(rs.option(rs.vec(rs.string)), optionNone),
  page_count: rs.field(rs.option(rs.usize), optionNone),
  card_count: rs.field(rs.option(rs.usize), optionNone),
  raw_model_response: rs.field(rs.option(rs.value()), optionNone),
  source_type: unitEnum(...new Set(SOURCE_TYPES.values())),
  import_source: rs.field(rs.option(rs.struct({
    file_name: rs.field(rs.option(rs.string), optionNone),
    file_type: rs.field(rs.option(rs.string), optionNone),
    import_time: rs.field(rs.option(rs.string), optionNone),
  })), optionNone),
  stats: rs.field(rs.option(rs.struct({
    total_count: rs.i32,
    mastered_count: rs.i32,
    review_count: rs.i32,
    in_progress_count: rs.i32,
    new_count: rs.i32,
    correct_rate: rs.field(rs.option(rs.f64), optionNone),
    last_updated: rs.field(rs.option(rs.string), optionNone),
  })), optionNone),
}));

const rawJSONAvailable = typeof (JSON as { rawJSON?: unknown }).rawJSON === 'function';

/**
 * JSON text → JS value whose `JSON.stringify` reproduces the text: numbers become
 * `JSON.rawJSON` atoms (plain numbers on runtimes without it, losing only `.0`).
 */
function projectJson(node: JsonNode): unknown {
  switch (node.kind) {
    case 'null': return null;
    case 'bool':
    case 'string': return node.value;
    case 'number':
      return rawJSONAvailable ? jsonNumberToRawJSON(node.value) : Number(node.value.raw);
    case 'array': return node.items.map(projectJson);
    case 'object': {
      const output: JsonRecord = {};
      for (const member of node.members) {
        Object.defineProperty(output, member.key, {
          value: projectJson(member.value), enumerable: true, writable: true, configurable: true,
        });
      }
      return output;
    }
  }
}

/** `serde_json::to_string(&ExamSheetPreviewResult)`. */
export function encodePreviewJson(preview: ExamSheetPreviewResult): string {
  return toRustJson(preview, EXAM_SHEET_PREVIEW_RESULT);
}

/** `serde_json::to_value(&ExamSheetPreviewResult)`; `JSON.stringify` of the result equals {@link encodePreviewJson}. */
export function encodePreview(preview: ExamSheetPreviewResult): JsonRecord {
  return projectJson(parseJsonDocument(encodePreviewJson(preview))) as JsonRecord;
}

/** `serde_json::to_string(&Option<ExamSheetSessionMetadata>)`. */
export function encodeMetadataJson(metadata: ExamSheetSessionMetadata | null | undefined): string {
  return toRustJson(metadata ?? null, EXAM_SHEET_SESSION_METADATA);
}

/** `serde_json::to_value(&Option<ExamSheetSessionMetadata>)`; `null` for `None`. */
export function encodeMetadata(metadata: ExamSheetSessionMetadata | null | undefined): JsonRecord | null {
  return projectJson(parseJsonDocument(encodeMetadataJson(metadata))) as JsonRecord | null;
}

/** Rust `ExamSheetService::trim_owned`. */
export function trimOwned(input: string): string | null {
  const trimmed = rustTrim(input);
  return trimmed === '' ? null : trimmed;
}

/** UTF-8 byte order, matching `BTreeSet<String>::iter()`. */
export function compareUtf8(a: string, b: string): number {
  return compareUtf8Bytes(a, b);
}

// ------------------------------------------------------------------ bbox math

function f(value: number): number {
  return Math.fround(value);
}

export function normalizedBboxToPixels(bboxValue: BBox, imgW: number, imgH: number): BBoxPixels {
  const widthF = f(Math.max(1, imgW));
  const heightF = f(Math.max(1, imgH));
  let x = Math.round(f(f(bboxValue.x) * widthF));
  let y = Math.round(f(f(bboxValue.y) * heightF));
  let width = Math.round(f(f(bboxValue.width) * widthF));
  let height = Math.round(f(f(bboxValue.height) * heightF));

  if (width <= 0) width = 1;
  if (height <= 0) height = 1;
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x >= imgW) x = Math.max(0, imgW - 1);
  if (y >= imgH) y = Math.max(0, imgH - 1);
  if (x + width > imgW) width = Math.max(0, imgW - x);
  if (y + height > imgH) height = Math.max(0, imgH - y);
  return { x, y, width: Math.max(1, width), height: Math.max(1, height) };
}

export function resolvedBboxToPixels(bboxValue: BBox, imgW: number, imgH: number): BBoxPixels {
  let x = Math.round(f(bboxValue.x));
  let y = Math.round(f(bboxValue.y));
  let width = Math.round(f(bboxValue.width));
  let height = Math.round(f(bboxValue.height));

  if (width <= 0) width = 1;
  if (height <= 0) height = 1;
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x >= imgW) x = Math.max(0, imgW - 1);
  if (y >= imgH) y = Math.max(0, imgH - 1);
  if (x + width > imgW) width = Math.max(0, imgW - x);
  if (y + height > imgH) height = Math.max(0, imgH - y);
  return { x, y, width: Math.max(1, width), height: Math.max(1, height) };
}

export function approxEqBbox(a: BBox, b: BBox): boolean {
  return Math.abs(a.x - b.x) <= 1e-3
    && Math.abs(a.y - b.y) <= 1e-3
    && Math.abs(a.width - b.width) <= 1e-3
    && Math.abs(a.height - b.height) <= 1e-3;
}

export function sanitizeLabel(label: string): string {
  let output = '';
  for (const char of label) output += /^[A-Za-z0-9]$/.test(char) ? char : '_';
  return output;
}

function valuesLookNormalized(value: BBox): boolean {
  const isNorm = (item: number): boolean => Number.isFinite(item) && item >= -0.05 && item <= 1.05;
  return isNorm(value.x) && isNorm(value.y) && isNorm(value.width) && isNorm(value.height);
}

function clampCandidate(
  x: number, y: number, width: number, height: number, imageW: number, imageH: number,
): BBoxPixels | null {
  if (![x, y, width, height].every(Number.isFinite)) return null;
  let x0 = x;
  let y0 = y;
  let w0 = width;
  let h0 = height;
  if (w0 <= 0.5 || h0 <= 0.5) return null;
  if (x0 < 0) { w0 += x0; x0 = 0; }
  if (y0 < 0) { h0 += y0; y0 = 0; }
  if (x0 >= imageW || y0 >= imageH) return null;
  if (x0 + w0 > imageW) w0 = imageW - x0;
  if (y0 + h0 > imageH) h0 = imageH - y0;
  if (w0 <= 0.5 || h0 <= 0.5) return null;
  const xPx = Math.floor(x0);
  const yPx = Math.floor(y0);
  const maxWidth = Math.max(1, Math.ceil(imageW - xPx));
  const maxHeight = Math.max(1, Math.ceil(imageH - yPx));
  const wPx = Math.min(Math.max(1, Math.ceil(w0)), maxWidth);
  const hPx = Math.min(Math.max(1, Math.ceil(h0)), maxHeight);
  return {
    x: Math.max(0, Math.min(xPx, imageW - 1)),
    y: Math.max(0, Math.min(yPx, imageH - 1)),
    width: Math.max(1, wPx),
    height: Math.max(1, hPx),
  };
}

function toPixelCoord(value: number, dimension: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value >= -0.05 && value <= 1.05) return Math.min(Math.max(value, 0), 1) * dimension;
  return Math.min(Math.max(value, -dimension), dimension * 2);
}

function toPixelLength(value: number, dimension: number): number {
  if (!Number.isFinite(value)) return 0;
  if (Math.abs(value) <= 1.05) return Math.abs(value) * dimension;
  return Math.min(Math.abs(value), dimension * 2);
}

function interpretNormalizedLengths(value: BBox, imageW: number, imageH: number): BBoxPixels | null {
  const x = Math.max(0, Math.min(Math.max(value.x, 0), 1) * imageW);
  const y = Math.max(0, Math.min(Math.max(value.y, 0), 1) * imageH);
  const width = Math.max(1, Math.min(Math.max(value.width, 0), 1) * imageW);
  const height = Math.max(1, Math.min(Math.max(value.height, 0), 1) * imageH);
  return clampCandidate(x, y, width, height, imageW, imageH);
}

function interpretNormalizedBottomRight(value: BBox, imageW: number, imageH: number): BBoxPixels | null {
  if (value.width < value.x || value.height < value.y) return null;
  const x = Math.max(0, Math.min(Math.max(value.x, 0), 1) * imageW);
  const y = Math.max(0, Math.min(Math.max(value.y, 0), 1) * imageH);
  const width = Math.max(1, Math.min(Math.max(value.width - value.x, 0), 1) * imageW);
  const height = Math.max(1, Math.min(Math.max(value.height - value.y, 0), 1) * imageH);
  return clampCandidate(x, y, width, height, imageW, imageH);
}

function interpretMixedLengths(value: BBox, imageW: number, imageH: number): BBoxPixels | null {
  return clampCandidate(
    toPixelCoord(value.x, imageW), toPixelCoord(value.y, imageH),
    toPixelLength(value.width, imageW), toPixelLength(value.height, imageH),
    imageW, imageH);
}

function interpretMixedBottomRight(value: BBox, imageW: number, imageH: number): BBoxPixels | null {
  if (value.width <= value.x && value.height <= value.y) return null;
  const x1 = toPixelCoord(value.x, imageW);
  const y1 = toPixelCoord(value.y, imageH);
  const x2 = toPixelCoord(value.width, imageW);
  const y2 = toPixelCoord(value.height, imageH);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  if (width <= 0.5 || height <= 0.5) return null;
  const x = x2 >= x1 ? x1 : x2;
  const y = y2 >= y1 ? y1 : y2;
  return clampCandidate(x, y, width, height, imageW, imageH);
}

function bboxPenalty(candidate: BBoxPixels, imageW: number, imageH: number, base: number): number {
  const area = candidate.width * candidate.height;
  const imageArea = Math.max(1, imageW * imageH);
  const ratio = Math.min(Math.max(area / imageArea, 0), 1);
  let penalty = base;
  if (ratio < 0.0005) {
    penalty += 1000 + (0.0005 - ratio) * 100_000;
  } else if (ratio > 0.9) {
    penalty += 1000 + (ratio - 0.9) * 100_000;
  } else {
    penalty += Math.abs(ratio - 0.12) * 10;
  }
  return penalty;
}

/** `clamp_bbox`: legacy bbox interpretation used by enrich and card creation. */
export function clampBbox(value: BBox, width: number, height: number): BBoxPixels {
  const imageW = Math.max(1, width);
  const imageH = Math.max(1, height);
  const candidates: Array<{ pixels: BBoxPixels; penalty: number }> = [];

  if (valuesLookNormalized(value)) {
    const lengths = interpretNormalizedLengths(value, imageW, imageH);
    if (lengths !== null) candidates.push({ pixels: lengths, penalty: bboxPenalty(lengths, imageW, imageH, 0) });
    const bottomRight = interpretNormalizedBottomRight(value, imageW, imageH);
    if (bottomRight !== null) {
      candidates.push({ pixels: bottomRight, penalty: bboxPenalty(bottomRight, imageW, imageH, 1) });
    }
  }
  const mixed = interpretMixedLengths(value, imageW, imageH);
  if (mixed !== null) candidates.push({ pixels: mixed, penalty: bboxPenalty(mixed, imageW, imageH, 5) });
  const mixedBottomRight = interpretMixedBottomRight(value, imageW, imageH);
  if (mixedBottomRight !== null) {
    candidates.push({ pixels: mixedBottomRight, penalty: bboxPenalty(mixedBottomRight, imageW, imageH, 6) });
  }

  let best: { pixels: BBoxPixels; penalty: number } | null = null;
  for (const candidate of candidates) {
    if (best === null || candidate.penalty < best.penalty) best = candidate;
  }
  if (best !== null) return best.pixels;
  return { x: 0, y: 0, width, height };
}
