/**
 * `dstu-vision/src/vlm_grounding_service.rs:29-77,301-329` serde types:
 * `VlmPageAnalysis` / `VlmQuestion` / `VlmFigure` / `VlmExtractedQuestion` / `VlmExtractedOption`.
 *
 * Decoders follow `#[derive(Deserialize)]` acceptance: unknown fields ignored, every field
 * `#[serde(default)]` except `VlmPageAnalysis.questions`, `null` is not a default (type error),
 * `[f64; 4]` needs exactly four numbers, `usize` needs a non-negative integer literal.
 * Only success/failure is observable (all Rust call sites use `.ok()` / fall through), so
 * failures are reported as `null`.
 *
 * `serde_json::Value` handling: values read from text keep the integer/float distinction
 * (`parseJsonDocument`); `to_string` re-emits u64/i64 digits and f64 via ryu, keys in
 * insertion order (preserve_order).
 */
import {
  jsonNumberToRawJSON, objectLastWins, parseJsonDocument, ryuFormat, stringifyJsonValue,
  type JsonNode, type JsonValueNumber,
} from '../../../platform/util/portable.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';

import type {
  Bbox, VlmExtractedOption, VlmExtractedQuestion, VlmFigure, VlmPageAnalysis, VlmQuestion,
} from '../api.ts';

export type { Bbox, VlmExtractedOption, VlmExtractedQuestion, VlmFigure, VlmPageAnalysis, VlmQuestion };

class Reject extends Error {}
const reject = (): never => { throw new Reject(); };

/**
 * Struct field view. `strict` = typed `from_str` (a repeated known field is
 * `duplicate field`); otherwise the members come from a `Value` map (last wins).
 */
function fields(node: JsonNode, known: readonly string[], strict: boolean): Map<string, JsonNode> {
  if (node.kind !== 'object') return reject();
  if (!strict) return objectLastWins(node);
  const out = new Map<string, JsonNode>();
  for (const member of node.members) {
    if (known.includes(member.key)) {
      if (out.has(member.key)) reject();
      out.set(member.key, member.value);
    }
  }
  return out;
}

function str(node: JsonNode | undefined): string {
  if (node === undefined) return '';
  return node.kind === 'string' ? node.value : reject();
}

function bool(node: JsonNode | undefined): boolean {
  if (node === undefined) return false;
  return node.kind === 'bool' ? node.value : reject();
}

const U64_MAX = (1n << 64n) - 1n;
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const INTEGER_TOKEN = /^-?(?:0|[1-9][0-9]*)$/;
const UNSIGNED_TOKEN = /^[0-9]+$/;

/** Typed `f64`: `serde_json::Number` parses `raw` (`parse::<f64>()`). */
function f64(node: JsonNode, strict: boolean): number {
  if (node.kind !== 'number') return reject();
  const value = Number(node.value.raw);
  // A Value-only arbitrary token could not come from typed from_str (number out of range).
  if (strict && !Number.isFinite(value)) return reject();
  if (Number.isNaN(value)) return reject();
  return value;
}

/** Typed `usize`: `raw.parse::<u64>()`; projected kind is not authoritative. */
function usize(node: JsonNode): number {
  if (node.kind !== 'number' || !UNSIGNED_TOKEN.test(node.value.raw)) return reject();
  const value = BigInt(node.value.raw);
  if (value > U64_MAX) return reject();
  return Number(value);
}

function seq<T>(node: JsonNode | undefined, item: (n: JsonNode) => T): T[] {
  if (node === undefined) return [];
  if (node.kind !== 'array') return reject();
  return node.items.map(item);
}

function bbox(node: JsonNode | undefined, strict: boolean): Bbox {
  if (node === undefined) return [0, 0, 0, 0];
  // [f64; 4] 反序列化为定长元组：长度不符即 invalid length。
  if (node.kind !== 'array' || node.items.length !== 4) return reject();
  return node.items.map(item => f64(item, strict)) as Bbox;
}

function figure(node: JsonNode, strict: boolean): VlmFigure {
  const f = fields(node, ['bbox', 'fig_label'], strict);
  return { bbox: bbox(f.get('bbox'), strict), fig_label: str(f.get('fig_label')) };
}

const QUESTION_FIELDS = ['label', 'bbox', 'raw_text', 'is_group', 'sub_questions', 'figures',
  'continues_from_previous', 'continues_to_next'] as const;

function question(node: JsonNode, strict: boolean): VlmQuestion {
  const f = fields(node, QUESTION_FIELDS, strict);
  return {
    label: str(f.get('label')),
    bbox: bbox(f.get('bbox'), strict),
    raw_text: str(f.get('raw_text')),
    is_group: bool(f.get('is_group')),
    sub_questions: seq(f.get('sub_questions'), n => str(n)),
    figures: seq(f.get('figures'), n => figure(n, strict)),
    continues_from_previous: bool(f.get('continues_from_previous')),
    continues_to_next: bool(f.get('continues_to_next')),
  };
}

function pageAnalysis(node: JsonNode, strict: boolean): VlmPageAnalysis {
  const f = fields(node, ['questions'], strict);
  const questions = f.get('questions');
  if (questions === undefined) return reject(); // missing field `questions`
  return { questions: seq(questions, n => question(n, strict)) };
}

const EXTRACTED_FIELDS = ['content', 'question_type', 'options', 'answer', 'explanation',
  'image_indices', 'difficulty', 'tags'] as const;

function extractedOption(node: JsonNode, strict: boolean): VlmExtractedOption {
  const f = fields(node, ['key', 'content'], strict);
  return { key: str(f.get('key')), content: str(f.get('content')) };
}

function extractedQuestion(node: JsonNode, strict: boolean): VlmExtractedQuestion {
  const f = fields(node, EXTRACTED_FIELDS, strict);
  return {
    content: str(f.get('content')),
    question_type: str(f.get('question_type')),
    options: seq(f.get('options'), n => extractedOption(n, strict)),
    answer: str(f.get('answer')),
    explanation: str(f.get('explanation')),
    image_indices: seq(f.get('image_indices'), usize),
    difficulty: str(f.get('difficulty')),
    tags: seq(f.get('tags'), n => str(n)),
  };
}

function attempt<T>(run: () => T): T | null {
  try { return run(); }
  catch (error) {
    if (error instanceof Reject || (error instanceof Error && error.name === 'JsonSyntaxError')) return null;
    throw error;
  }
}

/** `serde_json::from_str::<Value>(s).ok()`. */
export function parseJsonNode(text: string): JsonNode | null {
  return attempt(() => parseJsonDocument(text));
}

/** `serde_json::from_str::<VlmPageAnalysis>(s).ok()` — checkpoint `vlm_page_results` restore. */
export function decodeVlmPageAnalysisJson(text: string): VlmPageAnalysis | null {
  return attempt(() => pageAnalysis(parseJsonDocument(text), true));
}

/** `serde_json::from_str::<Vec<VlmQuestion>>(s).ok()`. */
export function decodeVlmQuestionsJson(text: string): VlmQuestion[] | null {
  return attempt(() => {
    const node = parseJsonDocument(text);
    return node.kind === 'array' ? node.items.map(n => question(n, true)) : reject();
  });
}

/** `serde_json::from_value::<Vec<VlmQuestion>>(Value::Array(..)).ok()`. */
export function decodeVlmQuestionsValue(items: readonly JsonNode[]): VlmQuestion[] | null {
  return attempt(() => items.map(n => question(n, false)));
}

/** `serde_json::from_str::<Vec<VlmExtractedQuestion>>(s).ok()`. */
export function decodeVlmExtractedQuestionsJson(text: string): VlmExtractedQuestion[] | null {
  return attempt(() => {
    const node = parseJsonDocument(text);
    return node.kind === 'array' ? node.items.map(n => extractedQuestion(n, true)) : reject();
  });
}

/** `serde_json::from_value::<Vec<VlmExtractedQuestion>>(Value::Array(..)).ok()`. */
export function decodeVlmExtractedQuestionsNodes(items: readonly JsonNode[]): VlmExtractedQuestion[] | null {
  return attempt(() => items.map(n => extractedQuestion(n, false)));
}

/** JS value → node (used for objects produced by L02's `IncrementalJsonArrayParser`). */
export function nodeFromValue(value: JsonValue): JsonNode {
  if (value === null) return { kind: 'null' };
  if (typeof value === 'boolean') return { kind: 'bool', value };
  if (typeof value === 'string') return { kind: 'string', value };
  if (typeof value === 'number') {
    const raw = String(value);
    if (Number.isInteger(value) && !Object.is(value, -0) && Number.isSafeInteger(value)) {
      return { kind: 'number', value: value >= 0
        ? { kind: 'u64', value: BigInt(value), raw } : { kind: 'i64', value: BigInt(value), raw } };
    }
    return { kind: 'number', value: { kind: 'f64', value, raw } };
  }
  if (Array.isArray(value)) return { kind: 'array', items: value.map(nodeFromValue) };
  return { kind: 'object', members: Object.entries(value).map(([key, v]) => ({ key, value: nodeFromValue(v) })) };
}

/** `serde_json::from_value::<VlmExtractedQuestion>(obj).ok()`. */
export function decodeVlmExtractedQuestionValue(value: JsonValue): VlmExtractedQuestion | null {
  return attempt(() => extractedQuestion(nodeFromValue(value), false));
}

/**
 * Value number → old frozen `JsonValue`. Only integer tokens whose exact value is a JS safe
 * integer become numbers; every fraction/exponent/unsafe integer keeps F4's raw numeric atom
 * (e.g. `1.234567890123456789`), so JSON.stringify cannot round or underflow it.
 */
function numberToJsonValue(number: JsonValueNumber): JsonValue {
  if (INTEGER_TOKEN.test(number.raw)) {
    const integer = BigInt(number.raw);
    if (integer >= MIN_SAFE && integer <= MAX_SAFE) return Number(integer);
  }
  return jsonNumberToRawJSON(number);
}

/** `serde_json::Value` → JS value (map last-wins). */
export function valueFromNode(node: JsonNode): JsonValue {
  switch (node.kind) {
    case 'null': return null;
    case 'bool': return node.value;
    case 'string': return node.value;
    case 'number': return numberToJsonValue(node.value);
    case 'array': return node.items.map(valueFromNode);
    case 'object': {
      const out: { [key: string]: JsonValue } = {};
      for (const [key, value] of objectLastWins(node)) out[key] = valueFromNode(value);
      return out;
    }
  }
}

/** serde_json `format_escaped_str`. */
function quote(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

/** serde_json f64 serialization: non-finite → `null`, otherwise ryu. */
function float(value: number): string {
  return Number.isFinite(value) ? ryuFormat(value) : 'null';
}

/** `serde_json::to_string(&Value)` — shared F4 compact Value serializer. */
export function serializeJsonNode(node: JsonNode): string {
  return stringifyJsonValue(node);
}

/** `serde_json::to_string(&VlmPageAnalysis)` — checkpoint `vlm_page_results` persist. */
export function encodeVlmPageAnalysis(analysis: VlmPageAnalysis): string {
  const box = (b: Bbox): string => `[${b.map(float).join(',')}]`;
  const questions = analysis.questions.map(q => `{"label":${quote(q.label)},"bbox":${box(q.bbox)},`
    + `"raw_text":${quote(q.raw_text)},"is_group":${q.is_group},`
    + `"sub_questions":[${q.sub_questions.map(quote).join(',')}],`
    + `"figures":[${q.figures.map(f => `{"bbox":${box(f.bbox)},"fig_label":${quote(f.fig_label)}}`).join(',')}],`
    + `"continues_from_previous":${q.continues_from_previous},"continues_to_next":${q.continues_to_next}}`);
  return `{"questions":[${questions.join(',')}]}`;
}
