/** serde_json decoding of the FSRS repository's JSON text columns. */
import { parseSerdeJson } from '../src/serde-json.ts';

/** `serde_json::from_str::<Vec<String>>`: null where serde returns Err (any non-string element fails the whole value). */
export function decodeStringArray(raw: string): string[] | null {
  const value = parseSerdeJson(raw);
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value as string[] : null;
}

/** `serde_json::from_str::<HashMap<String, String>>`: null where serde returns Err; no per-entry filtering. */
export function decodeStringMap(raw: string): Record<string, string> | null {
  const value = parseSerdeJson(raw);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return Object.values(value).every(item => typeof item === 'string') ? value as Record<string, string> : null;
}

/** Read paths use `.and_then(|json| serde_json::from_str(json).ok()).unwrap_or_default()`. */
export function parseJsonArray(raw: string | null | undefined): string[] {
  return raw === null || raw === undefined ? [] : decodeStringArray(raw) ?? [];
}

export function parseJsonObject(raw: string | null | undefined): Record<string, string> {
  return raw === null || raw === undefined ? {} : decodeStringMap(raw) ?? {};
}
