/** Shared by the Gemini request (gemini-openai-converter.ts) and response (gemini-openai-response.ts) halves. */
import type { JsonValue } from '../../api.ts';

/** adapters/gemini-openai-converter.rs:17 `AdapterError`; Display keeps the Rust prefix. */
export type AdapterErrorKind = 'invalid_format' | 'conversion_failed' | 'serialization_error';

export class AdapterError extends Error {
  readonly kind: AdapterErrorKind;

  constructor(kind: AdapterErrorKind, detail: string) {
    const prefix = kind === 'invalid_format'
      ? 'Invalid format'
      : kind === 'conversion_failed' ? 'Conversion failed' : 'Serialization error';
    super(`${prefix}: ${detail}`);
    this.name = 'AdapterError';
    this.kind = kind;
  }
}

/** adapters/gemini-openai-converter.rs:238 `is_synthetic_tool_call_id`. */
export function isSyntheticToolCallId(id: string): boolean {
  if (!id.startsWith('call-')) return false;
  return isUuid(id.slice('call-'.length));
}

function isUuid(text: string): boolean {
  let candidate = text;
  if (candidate.toLowerCase().startsWith('urn:uuid:')) candidate = candidate.slice('urn:uuid:'.length);
  candidate = candidate.replace(/^[{|]/, '').replace(/[}|]$/, '');
  const hex = candidate.replace(/-/g, '');
  return hex.length === 32 && /^[0-9a-f]+$/i.test(hex);
}

export function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, char => char.toLowerCase());
}

export function compactJson(value: JsonValue | undefined): string {
  if (value === undefined) return '{}';
  return JSON.stringify(value);
}
