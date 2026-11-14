// Rust: src/chat_v2/tools/chatanki_transform.rs. The ops engine is pure.
import type {
  AnkiCard, ChatAnkiAsyncNativeRegex, ChatAnkiAsyncRegexPattern, ChatAnkiCompiledRegex,
  ChatAnkiNativeRegex, ChatAnkiRegexMatch,
} from '../api.ts';
import type { NormalizedTransformScript, TransformScriptSpec } from './transform-script-spec.ts';
import { decodeScriptSpec, normalizeDecodedScriptSpec, normalizeScriptSpec } from './transform-script-spec.ts';
import {
  deserializeSerdeStruct, serdeOption, serdeString, serdeStringMap, serdeUnitEnum, serdeVec,
  type SerdeStructField,
} from './serde-struct.ts';
import { rustTrim } from '../../../platform/util/text.ts';
import { compareUtf8 } from '../../../platform/util/utf8.ts';

export const CHATANKI_TRANSFORM_OPS_LIMIT = 20;
export const CHATANKI_TRANSFORM_CARD_LIMIT = 500;
export const CHATANKI_TRANSFORM_PATTERN_MAX_LEN = 1024;
export const CHATANKI_TRANSFORM_REPLACEMENT_MAX_LEN = 4096;
export const CHATANKI_TRANSFORM_TAGS_LIMIT = 50;
export const CHATANKI_TRANSFORM_TAG_MAX_CHARS = 4096;
export const CHATANKI_TRANSFORM_FIELD_GROWTH_MAX_BYTES = 1024 * 1024;

export type TransformMode = 'dry_run' | 'apply';
export type TransformFilter = 'all' | 'edited_only' | 'error_only';
export type TransformField = 'front' | 'back' | 'text';
type TransformOpKind = 'regex_replace' | 'tag_add' | 'tag_remove';

export interface TransformOpSpec {
  op: TransformOpKind;
  field: TransformField | null;
  pattern: string | null;
  replacement: string | null;
  tags: string[] | null;
}

export interface TransformSelectionArgs { cardIds: string[] | null; filter: TransformFilter | null }
export interface TransformSpecArgs { script: TransformScriptSpec | null; ops: TransformOpSpec[] | null }

export interface ChatAnkiTransformArgs {
  documentId: string;
  selection: TransformSelectionArgs | null;
  mode: TransformMode;
  transform: TransformSpecArgs;
  expectedVersions: Record<string, string> | null;
  purpose: string | null;
}

export type NormalizedTransformOp =
  | { kind: 'regex_replace'; field: TransformField; pattern: string; replacement: string }
  | { kind: 'tag_add'; tags: string[] }
  | { kind: 'tag_remove'; tags: string[] };

export type NormalizedTransformSelection =
  | { kind: 'default_live' }
  | { kind: 'filter'; filter: TransformFilter }
  | { kind: 'cards'; cardIds: string[] };

export interface NormalizedTransformRequest {
  documentId: string;
  selection: NormalizedTransformSelection;
  mode: TransformMode;
  ops: NormalizedTransformOp[] | null;
  script: NormalizedTransformScript | null;
  expectedVersions: Record<string, string>;
  purpose: string | null;
}

// chatanki_transform.rs:47-126 serde shapes (deny_unknown_fields, camelCase).
// `undefined` from deserializeSerdeStruct marks a missing Option/default field.
const OP_FIELDS: readonly SerdeStructField[] = [
  { name: 'op', read: serdeUnitEnum<TransformOpKind>(['regex_replace', 'tag_add', 'tag_remove']) },
  { name: 'field', option: true, read: serdeOption(serdeUnitEnum<TransformField>(['front', 'back', 'text'])) },
  { name: 'pattern', option: true, read: serdeOption(serdeString) },
  { name: 'replacement', option: true, read: serdeOption(serdeString) },
  { name: 'tags', option: true, read: serdeOption(serdeVec(serdeString)) },
];

const SELECTION_FIELDS: readonly SerdeStructField[] = [
  { name: 'cardIds', option: true, read: serdeOption(serdeVec(serdeString)) },
  { name: 'filter', option: true, read: serdeOption(serdeUnitEnum<TransformFilter>(['all', 'edited_only', 'error_only'])) },
];

const SPEC_FIELDS: readonly SerdeStructField[] = [
  { name: 'script', option: true, read: serdeOption(decodeScriptSpec) },
  { name: 'ops', option: true, read: serdeOption(serdeVec(parseOp)) },
];

const ARGS_FIELDS: readonly SerdeStructField[] = [
  { name: 'documentId', read: serdeString },
  { name: 'selection', option: true, read: serdeOption(parseSelection) },
  { name: 'mode', default: true, read: serdeUnitEnum<TransformMode>(['dry_run', 'apply']) },
  { name: 'transform', read: parseSpec },
  { name: 'expectedVersions', option: true, default: true, read: serdeOption(serdeStringMap) },
  { name: 'purpose', option: true, read: serdeOption(serdeString) },
];

function parseOp(raw: unknown): TransformOpSpec {
  const [op, field, pattern, replacement, tags] = deserializeSerdeStruct(raw, 'TransformOpSpec', OP_FIELDS, true);
  return {
    op: op as TransformOpKind,
    field: (field ?? null) as TransformField | null,
    pattern: (pattern ?? null) as string | null,
    replacement: (replacement ?? null) as string | null,
    tags: (tags ?? null) as string[] | null,
  };
}

function parseSelection(raw: unknown): TransformSelectionArgs {
  const [cardIds, filter] = deserializeSerdeStruct(raw, 'TransformSelectionArgs', SELECTION_FIELDS, true);
  return { cardIds: (cardIds ?? null) as string[] | null, filter: (filter ?? null) as TransformFilter | null };
}

function parseSpec(raw: unknown): TransformSpecArgs {
  const [script, ops] = deserializeSerdeStruct(raw, 'TransformSpecArgs', SPEC_FIELDS, true);
  return { script: (script ?? null) as TransformScriptSpec | null, ops: (ops ?? null) as TransformOpSpec[] | null };
}

export function parseTransformArgs(raw: unknown): ChatAnkiTransformArgs {
  const [documentId, selection, mode, transform, expectedVersions, purpose] = deserializeSerdeStruct(
    raw, 'ChatAnkiTransformArgs', ARGS_FIELDS, true,
  );
  return {
    documentId: documentId as string,
    selection: (selection ?? null) as TransformSelectionArgs | null,
    mode: (mode ?? 'dry_run') as TransformMode,
    transform: transform as TransformSpecArgs,
    expectedVersions: (expectedVersions ?? null) as Record<string, string> | null,
    purpose: (purpose ?? null) as string | null,
  };
}

export function normalizeTransformArgs(args: ChatAnkiTransformArgs): NormalizedTransformRequest {
  const documentId = rustTrim(args.documentId);
  if (!documentId) throw new Error('documentId is required');
  let ops: NormalizedTransformOp[] | null = null;
  let script: NormalizedTransformScript | null = null;
  if (args.transform.script != null && args.transform.ops != null) throw new Error('transform.script and transform.ops are mutually exclusive');
  if (args.transform.script == null && args.transform.ops == null) throw new Error('transform requires exactly one of script or ops');
  if (args.transform.script != null) script = normalizeDecodedScriptSpec(args.transform.script);
  else ops = normalizeTransformOps(args.transform.ops as TransformOpSpec[]);

  let selection: NormalizedTransformSelection;
  if (args.selection === null) selection = { kind: 'default_live' };
  else if (args.selection.cardIds !== null && args.selection.filter !== null) throw new Error('selection.cardIds and selection.filter are mutually exclusive');
  else if (args.selection.cardIds === null && args.selection.filter === null) throw new Error('selection requires cardIds or filter');
  else if (args.selection.filter !== null) selection = { kind: 'filter', filter: args.selection.filter };
  else {
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const rawId of args.selection.cardIds as string[]) {
      const cardId = rustTrim(rawId);
      if (!cardId) throw new Error('selection.cardIds must not contain empty IDs');
      if (seen.has(cardId)) throw new Error('selection.cardIds must not contain duplicate IDs');
      seen.add(cardId);
      normalized.push(cardId);
    }
    if (normalized.length === 0 || normalized.length > CHATANKI_TRANSFORM_CARD_LIMIT) {
      throw new Error(`selection.cardIds must contain 1..=${CHATANKI_TRANSFORM_CARD_LIMIT} unique entries`);
    }
    selection = { kind: 'cards', cardIds: normalized };
  }

  let expectedVersions: Record<string, string> = {};
  if (args.mode === 'apply') {
    const raw = args.expectedVersions;
    if (raw === null || Object.keys(raw).length === 0) {
      throw new Error('mode=apply requires expectedVersions (cardId -> version from the latest get_cards)');
    }
    for (const [rawId, rawVersion] of Object.entries(raw)) {
      const cardId = rustTrim(rawId);
      const version = rustTrim(rawVersion);
      if (!cardId || !version) throw new Error('expectedVersions keys and values must not be empty');
      if (Object.hasOwn(expectedVersions, cardId)) throw new Error('expectedVersions contains duplicate normalized card IDs');
      Object.defineProperty(expectedVersions, cardId, { value: version, enumerable: true, writable: true, configurable: true });
    }
  }
  const purpose = args.purpose === null ? null : rustTrim(args.purpose) || null;
  return { documentId, selection, mode: args.mode, ops, script, expectedVersions, purpose };
}

// chatanki_transform_script.rs:137–166 (script spec is shared with script mode).
export { normalizeScriptSpec };

function normalizeTransformOps(ops: TransformOpSpec[]): NormalizedTransformOp[] {
  if (ops.length === 0 || ops.length > CHATANKI_TRANSFORM_OPS_LIMIT) {
    throw new Error(`transform.ops must contain 1..=${CHATANKI_TRANSFORM_OPS_LIMIT} operations`);
  }
  return ops.map((op, index) => {
    if (op.op === 'regex_replace') {
      if (op.field === null) throw new Error(`ops[${index}]: regex_replace requires field (front/back/text)`);
      const pattern = rustTrim((op.pattern ?? ''));
      if (!pattern) throw new Error(`ops[${index}]: regex_replace requires a non-empty pattern`);
      if ([...pattern].length > CHATANKI_TRANSFORM_PATTERN_MAX_LEN) throw new Error(`ops[${index}]: pattern exceeds ${CHATANKI_TRANSFORM_PATTERN_MAX_LEN} characters`);
      const replacement = op.replacement ?? '';
      if ([...replacement].length > CHATANKI_TRANSFORM_REPLACEMENT_MAX_LEN) throw new Error(`ops[${index}]: replacement exceeds ${CHATANKI_TRANSFORM_REPLACEMENT_MAX_LEN} characters`);
      if (op.tags !== null) throw new Error(`ops[${index}]: regex_replace does not accept tags`);
      return { kind: 'regex_replace', field: op.field, pattern, replacement };
    }
    if (op.field !== null || op.pattern !== null || op.replacement !== null) {
      throw new Error(`ops[${index}]: tag_add/tag_remove only accept the tags parameter`);
    }
    if (op.tags === null) throw new Error(`ops[${index}]: tag_add/tag_remove require a non-empty tags list`);
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const rawTag of op.tags) {
      const tag = rustTrim(rawTag);
      if (!tag) throw new Error(`ops[${index}]: tags must not contain empty entries`);
      if ([...tag].length > CHATANKI_TRANSFORM_TAG_MAX_CHARS) throw new Error(`ops[${index}]: tags must not exceed ${CHATANKI_TRANSFORM_TAG_MAX_CHARS} characters`);
      if (!seen.has(tag)) { seen.add(tag); tags.push(tag); }
    }
    if (tags.length === 0 || tags.length > CHATANKI_TRANSFORM_TAGS_LIMIT) throw new Error(`ops[${index}]: tags must contain 1..=${CHATANKI_TRANSFORM_TAGS_LIMIT} unique entries`);
    return { kind: op.op, tags } as NormalizedTransformOp;
  });
}

export interface CompiledRegexReplace {
  kind: 'regex_replace';
  field: TransformField;
  matcher: ChatAnkiCompiledRegex;
  source: string;
  replacement: string;
}
export type CompiledTransformOp = CompiledRegexReplace | { kind: 'tag_add'; tags: string[] } | { kind: 'tag_remove'; tags: string[] };

export class InvalidPatternError extends Error {
  readonly opIndex: number;
  readonly pattern: string;
  constructor(opIndex: number, pattern: string, error: string) {
    super(error);
    this.name = 'InvalidPatternError';
    this.opIndex = opIndex;
    this.pattern = pattern;
  }
}

/** Compile through F7 `nativeRegex`; JS RegExp is not Rust-regex compatible. */
export function compilePattern(
  nativeRegex: ChatAnkiNativeRegex, pattern: string,
): ChatAnkiCompiledRegex {
  return nativeRegex.compile(pattern);
}

export function compileTransformOps(
  ops: NormalizedTransformOp[], nativeRegex: ChatAnkiNativeRegex,
): CompiledTransformOp[] {
  return ops.map((op, index) => {
    if (op.kind !== 'regex_replace') return op.kind === 'tag_add' ? { kind: 'tag_add', tags: [...op.tags] } : { kind: 'tag_remove', tags: [...op.tags] };
    try {
      return {
        kind: 'regex_replace', field: op.field,
        matcher: compilePattern(nativeRegex, op.pattern),
        source: op.pattern, replacement: op.replacement,
      };
    } catch (error) {
      throw new InvalidPatternError(index, op.pattern, error instanceof Error ? error.message : String(error));
    }
  });
}

export interface TransformFields { front: string; back: string; text: string | null; tags: string[] }

export function transformFieldsFromCard(card: AnkiCard): TransformFields {
  return { front: card.front, back: card.back, text: card.text, tags: [...card.tags] };
}

export class TransformFieldGrowthError extends Error {
  readonly opIndex: number;
  readonly field: 'front' | 'back' | 'text';
  readonly bytes: number;
  constructor(opIndex: number, field: 'front' | 'back' | 'text', bytes: number) {
    super(`ops[${opIndex}] would grow field '${field}' to at least ${bytes} bytes, exceeding the ${CHATANKI_TRANSFORM_FIELD_GROWTH_MAX_BYTES} byte limit`);
    this.name = 'TransformFieldGrowthError';
    this.opIndex = opIndex;
    this.field = field;
    this.bytes = bytes;
  }
}

function captureReference(match: ChatAnkiRegexMatch, reference: string): string {
  if (/^\+?\d+$/.test(reference)) {
    const index = Number(reference);
    return index < match.captures.length ? match.captures[index] ?? '' : '';
  }
  return match.named[reference] ?? '';
}

function expandReplacement(match: ChatAnkiRegexMatch, replacement: string): string {
  let expanded = '';
  let cursor = 0;
  while (cursor < replacement.length) {
    const dollar = replacement.indexOf('$', cursor);
    if (dollar === -1) { expanded += replacement.slice(cursor); break; }
    expanded += replacement.slice(cursor, dollar);
    const next = replacement[dollar + 1];
    if (next === '$') { expanded += '$'; cursor = dollar + 2; continue; }
    if (next === '{') {
      const end = replacement.indexOf('}', dollar + 2);
      if (end === -1) { expanded += '$'; cursor = dollar + 1; continue; }
      expanded += captureReference(match, replacement.slice(dollar + 2, end));
      cursor = end + 1;
      continue;
    }
    if (next !== undefined && /[A-Za-z0-9_]/.test(next)) {
      let end = dollar + 1;
      while (end < replacement.length && /[A-Za-z0-9_]/.test(replacement[end] as string)) end += 1;
      expanded += captureReference(match, replacement.slice(dollar + 1, end));
      cursor = end;
      continue;
    }
    expanded += '$';
    cursor = dollar + 1;
  }
  return expanded;
}

/** Byte length of the projected expansion; never materializes the string. */
function expandedReplacementLength(match: ChatAnkiRegexMatch, replacement: string): number {
  let length = 0;
  let cursor = 0;
  while (cursor < replacement.length) {
    const dollar = replacement.indexOf('$', cursor);
    if (dollar === -1) return length + new TextEncoder().encode(replacement.slice(cursor)).length;
    length += new TextEncoder().encode(replacement.slice(cursor, dollar)).length;
    const next = replacement[dollar + 1];
    if (next === '$') { length += 1; cursor = dollar + 2; continue; }
    if (next === '{') {
      const end = replacement.indexOf('}', dollar + 2);
      if (end === -1) { length += 1; cursor = dollar + 1; continue; }
      length += new TextEncoder().encode(captureReference(match, replacement.slice(dollar + 2, end))).length;
      cursor = end + 1;
      continue;
    }
    if (next !== undefined && /[A-Za-z0-9_]/.test(next)) {
      let end = dollar + 1;
      while (end < replacement.length && /[A-Za-z0-9_]/.test(replacement[end] as string)) end += 1;
      length += new TextEncoder().encode(captureReference(match, replacement.slice(dollar + 1, end))).length;
      cursor = end;
      continue;
    }
    length += 1;
    cursor = dollar + 1;
  }
  return length;
}

function boundedRegexReplace(
  opIndex: number, field: 'front' | 'back' | 'text', matcher: ChatAnkiCompiledRegex,
  before: string, replacement: string,
): string {
  const limit = Math.max(CHATANKI_TRANSFORM_FIELD_GROWTH_MAX_BYTES, new TextEncoder().encode(before).length);
  let projected = 0;
  let previousEnd = 0;
  let after = '';
  const add = (additional: number): void => {
    projected += additional;
    if (projected > limit) throw new TransformFieldGrowthError(opIndex, field, projected);
  };
  for (const match of matcher.execAll(before)) {
    const start = match.start;
    const matched = match.text;
    add(new TextEncoder().encode(before.slice(previousEnd, start)).length);
    add(expandedReplacementLength(match, replacement));
    after += before.slice(previousEnd, start) + expandReplacement(match, replacement);
    previousEnd = start + matched.length;
  }
  add(new TextEncoder().encode(before.slice(previousEnd)).length);
  after += before.slice(previousEnd);
  return after;
}

export function applyTransformOps(ops: CompiledTransformOp[], fields: TransformFields): TransformFields {
  const result: TransformFields = { ...fields, tags: [...fields.tags] };
  for (const [opIndex, op] of ops.entries()) {
    if (op.kind === 'regex_replace') {
      if (op.field === 'front') result.front = boundedRegexReplace(opIndex, 'front', op.matcher, result.front, op.replacement);
      else if (op.field === 'back') result.back = boundedRegexReplace(opIndex, 'back', op.matcher, result.back, op.replacement);
      else if (result.text !== null) result.text = boundedRegexReplace(opIndex, 'text', op.matcher, result.text, op.replacement);
      continue;
    }
    if (op.kind === 'tag_add') {
      for (const tag of op.tags) if (!result.tags.includes(tag)) result.tags.push(tag);
    } else {
      result.tags = result.tags.filter((tag) => !op.tags.includes(tag));
    }
  }
  return result;
}

export function changedFieldNames(before: TransformFields, after: TransformFields): Array<'front' | 'back' | 'text' | 'tags'> {
  const changed: Array<'front' | 'back' | 'text' | 'tags'> = [];
  if (before.front !== after.front) changed.push('front');
  if (before.back !== after.back) changed.push('back');
  if (before.text !== after.text) changed.push('text');
  if (before.tags.length !== after.tags.length || before.tags.some((tag, index) => tag !== after.tags[index])) changed.push('tags');
  return changed;
}

export type TransformCardPlan =
  | { kind: 'after'; fields: TransformFields }
  | { kind: 'invalid'; code: string; detail: string };

export function planTransformOps(ops: CompiledTransformOp[], selected: AnkiCard[]): TransformCardPlan[] {
  return selected.map((card) => {
    try { return { kind: 'after', fields: applyTransformOps(ops, transformFieldsFromCard(card)) }; }
    catch (error) {
      if (error instanceof TransformFieldGrowthError) return { kind: 'invalid', code: 'field_growth_exceeded', detail: error.message };
      throw error;
    }
  });
}

// ---------------------------------------------------------------------------
// F7 async production path. L16 keeps the synchronous pure API above; the host
// only publishes the Rust regex engine asynchronously, so the executor compiles
// and applies ops through this parallel path.
// ---------------------------------------------------------------------------

export interface AsyncCompiledRegexReplace {
  kind: 'regex_replace';
  field: TransformField;
  matcher: ChatAnkiAsyncRegexPattern;
  source: string;
  replacement: string;
}
export type AsyncCompiledTransformOp =
  | AsyncCompiledRegexReplace
  | { kind: 'tag_add'; tags: string[] }
  | { kind: 'tag_remove'; tags: string[] };

export async function compileTransformOpsAsync(
  ops: NormalizedTransformOp[], nativeRegex: ChatAnkiAsyncNativeRegex,
): Promise<AsyncCompiledTransformOp[]> {
  const compiled: AsyncCompiledTransformOp[] = [];
  for (const [index, op] of ops.entries()) {
    if (op.kind !== 'regex_replace') {
      compiled.push(op.kind === 'tag_add'
        ? { kind: 'tag_add', tags: [...op.tags] }
        : { kind: 'tag_remove', tags: [...op.tags] });
      continue;
    }
    try {
      compiled.push({
        kind: 'regex_replace', field: op.field,
        matcher: await nativeRegex.compile(op.pattern),
        source: op.pattern, replacement: op.replacement,
      });
    } catch (error) {
      throw new InvalidPatternError(
        index, op.pattern, error instanceof Error ? error.message : String(error),
      );
    }
  }
  return compiled;
}

async function boundedRegexReplaceAsync(
  opIndex: number, field: 'front' | 'back' | 'text',
  nativeRegex: ChatAnkiAsyncNativeRegex, matcher: ChatAnkiAsyncRegexPattern,
  before: string, replacement: string,
): Promise<string> {
  const limit = Math.max(CHATANKI_TRANSFORM_FIELD_GROWTH_MAX_BYTES, new TextEncoder().encode(before).length);
  const growth = (projected: number): TransformFieldGrowthError =>
    new TransformFieldGrowthError(opIndex, field, projected);

  // Rust :550-594 prechecks the complete result before allocating it, for
  // constant and capture replacements alike. Do not rebuild a result in JS.
  // `$name` / `$1` / `${...}` / `$$` must expand against the captures of the
  // match in the full original field. Slicing from `match.start` changes
  // boundary-sensitive patterns (`\\b`, `\\B`, `^`, ...), so keep the complete
  // input and let F7 perform the exact projection followed by one replacement.
  const projected = await nativeRegex.replaceAllProjected(
    matcher, before, replacement, limit,
  );
  if (!projected.ok) throw growth(projected.bytes);
  return projected.value;
}

export async function applyTransformOpsAsync(
  ops: AsyncCompiledTransformOp[], fields: TransformFields,
  nativeRegex: ChatAnkiAsyncNativeRegex,
): Promise<TransformFields> {
  const result: TransformFields = { ...fields, tags: [...fields.tags] };
  for (const [opIndex, op] of ops.entries()) {
    if (op.kind === 'regex_replace') {
      if (op.field === 'front') {
        result.front = await boundedRegexReplaceAsync(
          opIndex, 'front', nativeRegex, op.matcher, result.front, op.replacement,
        );
      } else if (op.field === 'back') {
        result.back = await boundedRegexReplaceAsync(
          opIndex, 'back', nativeRegex, op.matcher, result.back, op.replacement,
        );
      } else if (result.text !== null) {
        result.text = await boundedRegexReplaceAsync(
          opIndex, 'text', nativeRegex, op.matcher, result.text, op.replacement,
        );
      }
      continue;
    }
    if (op.kind === 'tag_add') {
      for (const tag of op.tags) if (!result.tags.includes(tag)) result.tags.push(tag);
    } else {
      result.tags = result.tags.filter((tag) => !op.tags.includes(tag));
    }
  }
  return result;
}

export async function planTransformOpsAsync(
  ops: AsyncCompiledTransformOp[], selected: AnkiCard[],
  nativeRegex: ChatAnkiAsyncNativeRegex,
): Promise<TransformCardPlan[]> {
  const plans: TransformCardPlan[] = [];
  for (const card of selected) {
    try {
      plans.push({
        kind: 'after',
        fields: await applyTransformOpsAsync(ops, transformFieldsFromCard(card), nativeRegex),
      });
    } catch (error) {
      if (error instanceof TransformFieldGrowthError) {
        plans.push({ kind: 'invalid', code: 'field_growth_exceeded', detail: error.message });
      } else {
        throw error;
      }
    }
  }
  return plans;
}

export function transformFieldsAreValid(fields: TransformFields): boolean {
  return (fields.text !== null && rustTrim(fields.text) !== '') || (rustTrim(fields.front) !== '' && rustTrim(fields.back) !== '');
}

export class TransformSelectionError extends Error {
  readonly missingCards: string[] | null;
  tooLarge: { selected: number; limit: number } | null;
  constructor(kind: 'missing', ids: string[]) {
    super(`selection references unknown card ids: ${ids.join(', ')}`);
    this.name = 'TransformSelectionError';
    this.missingCards = ids;
    this.tooLarge = null;
  }
  static tooLarge(selected: number, limit: number): TransformSelectionError {
    const error = new TransformSelectionError('missing', []);
    error.message = `selection has ${selected} cards, exceeding the ${limit} card limit`;
    error.tooLarge = { selected, limit };
    return error;
  }
}

export function selectTransformCards(cards: AnkiCard[], selection: NormalizedTransformSelection): AnkiCard[] {
  let selected: AnkiCard[];
  if (selection.kind === 'default_live') selected = cards.filter((card) => !card.is_error_card);
  else if (selection.kind === 'filter') {
    selected = cards.filter((card) => {
      if (selection.filter === 'all') return true;
      if (selection.filter === 'edited_only') return card.updated_at !== card.created_at;
      return card.is_error_card;
    });
  } else {
    const wanted = new Set(selection.cardIds);
    selected = cards.filter((card) => wanted.has(card.id));
    const found = new Set(selected.map((card) => card.id));
    const missing = selection.cardIds.filter((id) => !found.has(id)).sort(compareUtf8);
    if (missing.length) throw new TransformSelectionError('missing', missing);
  }
  if (selected.length > CHATANKI_TRANSFORM_CARD_LIMIT) throw TransformSelectionError.tooLarge(selected.length, CHATANKI_TRANSFORM_CARD_LIMIT);
  return selected;
}

export class ExpectedVersionsMismatch extends Error {
  readonly missingVersionIds: string[];
  readonly unexpectedVersionIds: string[];
  constructor(missing: string[], unexpected: string[]) {
    super(`expectedVersions mismatch: missing [${missing.join(', ')}], unexpected [${unexpected.join(', ')}]`);
    this.name = 'ExpectedVersionsMismatch';
    this.missingVersionIds = missing;
    this.unexpectedVersionIds = unexpected;
  }
}

export function checkExpectedVersions(selectedCardIds: string[], expectedVersions: Record<string, string>): void {
  const selected = new Set(selectedCardIds);
  const missing = selectedCardIds.filter((id) => !Object.hasOwn(expectedVersions, id)).sort(compareUtf8);
  const unexpected = Object.keys(expectedVersions).filter((id) => !selected.has(id)).sort(compareUtf8);
  if (missing.length || unexpected.length) throw new ExpectedVersionsMismatch(missing, unexpected);
}
