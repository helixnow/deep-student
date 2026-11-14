/**
 * translate_text / translation_result_read / translation_save argument limits, the structured
 * error payload, and strict argument parsing (translation_executor.rs:30-530, 588-605).
 */
import { charLength, trim } from './policy.ts';

export const MAX_TRANSLATION_TEXT_CHARS = 500_000;
export const MAX_PIPELINE_SEGMENT_CHARS = 100_000;
export const MAX_TOOL_TEXT_FIELD_CHARS = 2_000;
export const MAX_LANGUAGE_CODE_CHARS = 32;
export const MAX_TERMS = 100;
export const MAX_TERM_CHARS = 200;
export const MAX_TITLE_CHARS = 200;
export const MAX_FOLDER_ID_CHARS = 128;
export const MAX_METADATA_CHARS = 200;
export const MAX_RESULT_ID_CHARS = 80;
export const MAX_PROMPT_OVERRIDE_CHARS = 4_000;
export const MAX_RESULT_READ_CHUNK_CHARS = 5_000;

export const OUTPUT_EXPANSION_FACTOR = 4;
export const MIN_TRANSLATED_OUTPUT_CHARS = 8_192;
export const MAX_TRANSLATED_OUTPUT_CHARS = 2_000_000;

export const ALLOWED_FORMALITY: readonly string[] = ['formal', 'casual'];
export const ALLOWED_DOMAINS: readonly string[] = [
  'general', 'academic', 'technical', 'literary', 'casual', 'legal', 'medical',
];

export type Term = [source: string, target: string];

export interface TranslationErrorPayload {
  code: string;
  message: string;
  message_truncated: boolean;
  message_key: string;
  hint: string;
  retryable: boolean;
}

/** `Result<_, String>` in Rust becomes a thrown error carrying the JSON payload. */
export class TranslationToolFailure extends Error {
  readonly payload: TranslationErrorPayload;
  constructor(payload: TranslationErrorPayload) {
    super(JSON.stringify(payload));
    this.name = 'TranslationToolFailure';
    this.payload = payload;
  }
}

export function unicodePreview(value: string, maxChars: number): [preview: string, truncated: boolean] {
  const chars = Array.from(value);
  return [chars.slice(0, maxChars).join(''), chars.length > maxChars];
}

export function translationErrorValue(
  code: string,
  message: string,
  hint: string,
  retryable: boolean,
): TranslationErrorPayload {
  const [preview, truncated] = unicodePreview(message, MAX_TOOL_TEXT_FIELD_CHARS);
  return {
    code,
    message: preview,
    message_truncated: truncated,
    message_key: `chat.tools.translation.errors.${code.toLowerCase()}`,
    hint,
    retryable,
  };
}

export function translationError(code: string, message: string, hint: string, retryable: boolean): string {
  return JSON.stringify(translationErrorValue(code, message, hint, retryable));
}

export function translationFailure(code: string, message: string, hint: string, retryable: boolean): TranslationToolFailure {
  return new TranslationToolFailure(translationErrorValue(code, message, hint, retryable));
}

export function invalidArgument(field: string, reason: string): TranslationToolFailure {
  return translationFailure(
    'INVALID_ARGUMENT',
    `Invalid '${field}': ${reason}`,
    'Correct the tool arguments and retry.',
    false,
  );
}

export function translatedOutputLimit(sourceChars: number): number {
  return Math.min(
    Math.max(sourceChars * OUTPUT_EXPANSION_FACTOR, MIN_TRANSLATED_OUTPUT_CHARS),
    MAX_TRANSLATED_OUTPUT_CHARS,
  );
}

type JsonObject = Record<string, unknown>;

function argsObject(argumentsValue: unknown): JsonObject {
  if (typeof argumentsValue !== 'object' || argumentsValue === null || Array.isArray(argumentsValue)) {
    throw invalidArgument('arguments', 'expected a JSON object');
  }
  return argumentsValue as JsonObject;
}

function ensureAllowedKeys(argumentsValue: JsonObject, allowed: readonly string[]): void {
  const unknownKey = Object.keys(argumentsValue).find(key => !allowed.includes(key));
  if (unknownKey !== undefined) {
    throw invalidArgument(unknownKey, 'unknown field; additional properties are not allowed');
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

function requiredText(argumentsValue: JsonObject, field: string, maxChars: number): string {
  if (!hasOwn(argumentsValue, field)) throw invalidArgument(field, 'field is required');
  const value = argumentsValue[field];
  if (typeof value !== 'string') throw invalidArgument(field, 'expected a string');
  if (trim(value) === '') throw invalidArgument(field, 'must not be blank');
  const charCount = charLength(value);
  if (charCount > maxChars) {
    throw invalidArgument(field, `contains ${charCount} characters; maximum is ${maxChars}`);
  }
  return value;
}

function requiredTrimmedString(argumentsValue: JsonObject, field: string, maxChars: number): string {
  return trim(requiredText(argumentsValue, field, maxChars));
}

function optionalTrimmedString(
  argumentsValue: JsonObject,
  field: string,
  maxChars: number,
): string | undefined {
  if (!hasOwn(argumentsValue, field)) return undefined;
  const value = argumentsValue[field];
  if (value === null) return undefined;
  if (typeof value !== 'string') throw invalidArgument(field, 'expected a string');
  const trimmed = trim(value);
  if (trimmed === '') throw invalidArgument(field, 'must not be blank when provided');
  const charCount = charLength(trimmed);
  if (charCount > maxChars) {
    throw invalidArgument(field, `contains ${charCount} characters; maximum is ${maxChars}`);
  }
  return trimmed;
}

function optionalBoundedUsize(
  argumentsValue: JsonObject,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (!hasOwn(argumentsValue, field)) return undefined;
  const value = argumentsValue[field];
  if (value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalidArgument(field, 'expected a non-negative integer');
  }
  if (!Number.isSafeInteger(value)) throw invalidArgument(field, 'value is too large');
  if (value < min || value > max) {
    throw invalidArgument(field, `expected an integer between ${min} and ${max}`);
  }
  return value;
}

export function validateLanguageCode(code: string, field: string, allowAuto: boolean): void {
  if (code === 'auto') {
    if (allowAuto) return;
    throw invalidArgument(field, "'auto' is only valid for source_lang");
  }
  const parts = code.split('-');
  const primary = parts[0]!;
  const validPrimary = primary !== '' && /^[A-Za-z]+$/.test(primary);
  const validParts = parts.slice(1).every(part => part !== '' && part.length <= 8 && /^[A-Za-z0-9]+$/.test(part));
  if (!validPrimary || !validParts) {
    throw invalidArgument(
      field,
      "expected an ASCII BCP-47-like code such as 'en', 'zh-CN', or 'auto'",
    );
  }
}

function parseLanguage(argumentsValue: JsonObject, field: string, allowAuto: boolean): string {
  const code = requiredTrimmedString(argumentsValue, field, MAX_LANGUAGE_CODE_CHARS);
  validateLanguageCode(code, field, allowAuto);
  return code;
}

function parseEnum(
  argumentsValue: JsonObject,
  field: string,
  allowed: readonly string[],
): string | undefined {
  const value = optionalTrimmedString(argumentsValue, field, MAX_METADATA_CHARS);
  if (value !== undefined && !allowed.includes(value)) {
    throw invalidArgument(field, `expected one of: ${allowed.join(', ')}`);
  }
  return value;
}

export function parseTerms(argumentsValue: JsonObject): Term[] {
  if (!hasOwn(argumentsValue, 'terms')) return [];
  const value = argumentsValue.terms;
  if (value === null) return [];
  if (!Array.isArray(value)) throw invalidArgument('terms', 'expected an array');
  if (value.length > MAX_TERMS) {
    throw invalidArgument('terms', `contains ${value.length} entries; maximum is ${MAX_TERMS}`);
  }
  const parsed: Term[] = [];
  const sourceTerms = new Set<string>();
  value.forEach((term, index) => {
    const field = `terms[${index}]`;
    if (typeof term !== 'object' || term === null || Array.isArray(term)) {
      throw invalidArgument(field, 'expected an object with src and dst');
    }
    const object = term as JsonObject;
    ensureAllowedKeys(object, ['src', 'dst']);
    if (Object.keys(object).length !== 2) throw invalidArgument(field, 'both src and dst are required');
    const parseTerm = (key: 'src' | 'dst'): string => {
      try {
        return requiredTrimmedString(object, key, MAX_TERM_CHARS);
      } catch (error) {
        if (!(error instanceof TranslationToolFailure)) throw error;
        throw invalidArgument(`${field}.${key}`, 'must be a nonblank string of at most 200 characters');
      }
    };
    const src = parseTerm('src');
    const dst = parseTerm('dst');
    if (sourceTerms.has(src)) throw invalidArgument(`${field}.src`, 'duplicate source term');
    sourceTerms.add(src);
    parsed.push([src, dst]);
  });
  return parsed;
}

export interface TranslateArgs {
  text: string;
  sourceLang: string;
  targetLang: string;
  formality?: string;
  domain?: string;
  terms: Term[];
  promptOverride?: string;
}

export function parseTranslateArgs(argumentsValue: unknown): TranslateArgs {
  const argumentsObject = argsObject(argumentsValue);
  if (hasOwn(argumentsObject, 'glossary_id') || hasOwn(argumentsObject, 'glossaryId')) {
    throw translationFailure(
      'GLOSSARY_ID_UNSUPPORTED',
      'Stored glossary IDs are not supported; use inline terms instead.',
      'Pass terms: [{"src": "...", "dst": "..."}].',
      false,
    );
  }
  ensureAllowedKeys(argumentsObject, [
    'text', 'source_lang', 'target_lang', 'formality', 'domain', 'terms', 'prompt_override',
  ]);
  return {
    text: requiredText(argumentsObject, 'text', MAX_TRANSLATION_TEXT_CHARS),
    sourceLang: parseLanguage(argumentsObject, 'source_lang', true),
    targetLang: parseLanguage(argumentsObject, 'target_lang', false),
    formality: parseEnum(argumentsObject, 'formality', ALLOWED_FORMALITY),
    domain: parseEnum(argumentsObject, 'domain', ALLOWED_DOMAINS),
    terms: parseTerms(argumentsObject),
    promptOverride: optionalTrimmedString(argumentsObject, 'prompt_override', MAX_PROMPT_OVERRIDE_CHARS),
  };
}

export interface TranslationResultReadArgs {
  resultId: string;
  offsetChars: number;
  limitChars: number;
}

export function parseTranslationResultReadArgs(argumentsValue: unknown): TranslationResultReadArgs {
  const argumentsObject = argsObject(argumentsValue);
  ensureAllowedKeys(argumentsObject, ['translation_result_id', 'offset_chars', 'limit_chars']);
  return {
    resultId: requiredTrimmedString(argumentsObject, 'translation_result_id', MAX_RESULT_ID_CHARS),
    offsetChars: optionalBoundedUsize(argumentsObject, 'offset_chars', 0, MAX_TRANSLATED_OUTPUT_CHARS) ?? 0,
    limitChars: optionalBoundedUsize(argumentsObject, 'limit_chars', 1, MAX_RESULT_READ_CHUNK_CHARS)
      ?? MAX_TOOL_TEXT_FIELD_CHARS,
  };
}

export type TranslationSaveMode =
  | { kind: 'cached_result'; resultId: string }
  | {
    kind: 'inline';
    source: string;
    translated: string;
    sourceLang: string;
    targetLang: string;
  };

export interface TranslationSaveArgs {
  mode: TranslationSaveMode;
  title?: string;
  folderId?: string;
  engine?: string;
  model?: string;
}

export function parseTranslationSaveArgs(argumentsValue: unknown): TranslationSaveArgs {
  const argumentsObject = argsObject(argumentsValue);
  ensureAllowedKeys(argumentsObject, [
    'translation_result_id', 'source', 'translated', 'source_lang', 'target_lang',
    'title', 'folder_id', 'engine', 'model',
  ]);

  const hasResultId = hasOwn(argumentsObject, 'translation_result_id');
  const inlineFields = ['source', 'translated', 'source_lang', 'target_lang'] as const;
  const hasInlineField = inlineFields.some(field => hasOwn(argumentsObject, field));

  let mode: TranslationSaveMode;
  if (hasResultId && hasInlineField) {
    throw invalidArgument('translation_result_id', 'cached-result and inline source fields are mutually exclusive');
  } else if (hasResultId) {
    mode = {
      kind: 'cached_result',
      resultId: requiredTrimmedString(argumentsObject, 'translation_result_id', MAX_RESULT_ID_CHARS),
    };
  } else if (hasInlineField) {
    mode = {
      kind: 'inline',
      source: requiredText(argumentsObject, 'source', MAX_TOOL_TEXT_FIELD_CHARS),
      translated: requiredText(argumentsObject, 'translated', MAX_TOOL_TEXT_FIELD_CHARS),
      sourceLang: parseLanguage(argumentsObject, 'source_lang', true),
      targetLang: parseLanguage(argumentsObject, 'target_lang', false),
    };
  } else {
    throw invalidArgument(
      'translation_result_id',
      'provide either translation_result_id or all inline source fields',
    );
  }

  return {
    mode,
    title: optionalTrimmedString(argumentsObject, 'title', MAX_TITLE_CHARS),
    folderId: optionalTrimmedString(argumentsObject, 'folder_id', MAX_FOLDER_ID_CHARS),
    engine: optionalTrimmedString(argumentsObject, 'engine', MAX_METADATA_CHARS),
    model: optionalTrimmedString(argumentsObject, 'model', MAX_METADATA_CHARS),
  };
}

export function ensureNotCancelled(cancelled: boolean): void {
  if (cancelled) {
    throw translationFailure(
      'TRANSLATION_CANCELLED',
      'Translation was cancelled.',
      'Retry when translation is still needed.',
      true,
    );
  }
}
