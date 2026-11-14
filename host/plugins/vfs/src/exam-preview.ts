/** serde_json::from_value<ExamSheetPreviewResult>; dstu-core/models.rs:299-491. */
import { isNumberAtom } from '../../../platform/serde-compat/index.ts';
import { ryuFormat } from '../../../platform/util/portable.ts';

export interface ExamCard {
  question_label: string;
  ocr_text: string;
  bbox: { x: number; y: number; width: number; height: number };
}
export interface ExamPreview {
  exam_name: string | null;
  pages: { page_index: number; blob_hash: string | null; original_image_path: string; cards: ExamCard[] }[];
}

/** Number text from a `JSON.rawJSON` atom: an integer spelling, or the f64 serde reads it as. */
function atomNumber(raw: string): bigint | number {
  return /^-?\d+$/.test(raw) ? BigInt(raw) : Number(raw);
}
function unexpected(value: unknown): string {
  if (value === null) return 'null';
  if (isNumberAtom(value)) {
    const number = atomNumber(value.rawJSON);
    return typeof number === 'bigint' ? `integer \`${number}\`` : `floating point \`${ryuFormat(number)}\``;
  }
  if (typeof value === 'string') return `string ${JSON.stringify(value)}`;
  if (typeof value === 'number') return `${Number.isInteger(value) ? 'integer' : 'floating point'} \`${value}\``;
  if (typeof value === 'boolean') return `boolean \`${value}\``;
  return Array.isArray(value) ? 'sequence' : 'map';
}
function invalid(value: unknown, expected: string): never {
  throw new Error(`invalid type: ${unexpected(value)}, expected ${expected}`);
}
function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid(value, `struct ${name}`);
  return value as Record<string, unknown>;
}
function required(row: Record<string, unknown>, key: string): unknown {
  if (!Object.hasOwn(row, key)) throw new Error(`missing field \`${key}\``);
  return row[key];
}
function string(value: unknown): string {
  return typeof value === 'string' ? value : invalid(value, 'a string');
}
function bool(value: unknown): boolean {
  return typeof value === 'boolean' ? value : invalid(value, 'a boolean');
}
function sequence(value: unknown): unknown[] {
  return Array.isArray(value) ? value : invalid(value, 'a sequence');
}
const INTEGER_RANGE = { usize: [0n, 18446744073709551615n], u32: [0n, 4294967295n], i32: [-2147483648n, 2147483647n] } as const;
function integer(value: unknown, type: 'usize' | 'u32' | 'i32'): number {
  const [min, max] = INTEGER_RANGE[type];
  let number: bigint;
  if (isNumberAtom(value)) {
    const atom = atomNumber(value.rawJSON);
    if (typeof atom !== 'bigint') return invalid(value, type);
    number = atom;
  } else if (typeof value === 'number' && Number.isInteger(value)) {
    number = BigInt(value);
  } else {
    return invalid(value, type);
  }
  if (number < min || number > max) throw new Error(`invalid value: ${unexpected(value)}, expected ${type}`);
  return Number(number);
}
function optional<T>(row: Record<string, unknown>, key: string, parse: (v: unknown) => T): T | null {
  return row[key] == null ? null : parse(row[key]);
}
function defaulted<T>(row: Record<string, unknown>, key: string, fallback: T, parse: (v: unknown) => T): T {
  return Object.hasOwn(row, key) ? parse(row[key]) : fallback;
}
function bbox(value: unknown): ExamCard['bbox'] {
  const row = object(value, 'ExamCardBBox');
  const coordinate = (key: string) => {
    const value = required(row, key);
    if (isNumberAtom(value)) return Math.fround(Number(atomNumber(value.rawJSON)));
    return typeof value === 'number' ? Math.fround(value) : invalid(value, 'f32');
  };
  return { x: coordinate('x'), y: coordinate('y'), width: coordinate('width'), height: coordinate('height') };
}
function enumValue(value: unknown, variants: readonly string[], aliases: readonly string[] = []): string {
  const name = string(value);
  if (variants.includes(name) || aliases.includes(name)) return name;
  throw new Error(`unknown variant \`${name}\`, expected one of ${[...variants, ...aliases].map(v => `\`${v}\``).join(', ')}`);
}
function card(value: unknown): ExamCard {
  const row = object(value, 'ExamCardPreview');
  // Validate even fields not rendered: Rust deserializes the whole preview before formatting.
  for (const key of ['card_id', 'question_label', 'cropped_image_path', 'ocr_text']) defaulted(row, key, '', string);
  defaulted(row, 'page_index', 0, v => integer(v, 'usize'));
  defaulted(row, 'tags', [], v => sequence(v).map(string));
  optional(row, 'resolved_bbox', bbox);
  for (const key of ['linked_mistake_ids', 'variant_ids']) optional(row, key, v => sequence(v).map(string));
  for (const key of ['answer', 'explanation', 'user_answer', 'last_attempt_at', 'user_note', 'parent_card_id']) optional(row, key, string);
  optional(row, 'is_correct', bool);
  for (const key of ['attempt_count', 'correct_count']) defaulted(row, key, 0, v => integer(v, 'i32'));
  optional(row, 'question_type', v => enumValue(v, ['single_choice', 'multiple_choice', 'indefinite_choice',
    'fill_blank', 'short_answer', 'essay', 'calculation', 'proof', 'true_false', 'matching', 'ordering', 'numeric', 'other']));
  optional(row, 'difficulty', v => enumValue(v, ['easy', 'medium', 'hard', 'very_hard']));
  defaulted(row, 'status', 'new', v => enumValue(v, ['new', 'in_progress', 'mastered', 'review']));
  defaulted(row, 'source_type', 'ocr_image', v => enumValue(v,
    ['ocr_image', 'import_file', 'manual_create', 'ai_generated'], ['ocr', 'imported', 'manual']));
  return {
    question_label: defaulted(row, 'question_label', '', string),
    ocr_text: defaulted(row, 'ocr_text', '', string),
    bbox: defaulted(row, 'bbox', { x: 0, y: 0, width: 0, height: 0 }, bbox),
  };
}

export function parseExamPreview(value: unknown): ExamPreview {
  const row = object(value, 'ExamSheetPreviewResult');
  defaulted(row, 'temp_id', '', string);
  for (const key of ['instructions', 'session_id']) optional(row, key, string);
  return {
    exam_name: optional(row, 'exam_name', string),
    pages: defaulted(row, 'pages', [], sequence).map(value => {
      const page = object(value, 'ExamSheetPreviewPage');
      const page_index = integer(required(page, 'page_index'), 'usize');
      for (const key of ['width', 'height']) optional(page, key, v => integer(v, 'u32'));
      optional(page, 'raw_ocr_text', string);
      for (const key of ['ocr_completed', 'parse_completed']) defaulted(page, key, false, bool);
      return { page_index, blob_hash: optional(page, 'blob_hash', string),
        original_image_path: defaulted(page, 'original_image_path', '', string),
        cards: sequence(required(page, 'cards')).map(card) };
    }),
  };
}
