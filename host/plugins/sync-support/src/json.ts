/** Shared exact Host JSON values; parsing/number representation is owned by L20. */
import {
  JsonFloat, isJsonObject, parseJsonLossless, stringifyJsonLossless, cloneDbJson,
  type DbJson,
} from '../../../platform/util/lossless-json.ts';
import { rustTrimStart } from '../../../platform/util/portable.ts';

export { JsonFloat, isJsonFloat, isJsonObject, dbJsonEquals as jsonEquals, cloneDbJson as cloneJson,
  stringifyJsonLossless as stringifyJson } from '../../../platform/util/lossless-json.ts';
export type Json = DbJson;
/** Internal service payload, not an IPC conversion. Float source and bigint stay exact. */
export type WireJson = DbJson;

/** Retained internal name: never round numbers here; F1 alone owns IPC conversion. */
export function toWireJson(value: Json): WireJson {
  return cloneDbJson(value);
}

export function formatJsonFloat(value: number): string {
  return stringifyJsonLossless(new JsonFloat(value));
}

const STRIP_KEYS: readonly string[] = [
  'sync_version', 'local_version', 'updated_at', 'last_synced_at', 'last_attempt_at',
  'indexed_at', 'mm_indexed_at', 'remote_version', 'remote_id', 'sync_status', 'content_hash',
];

/** conflict_resolver.rs:525-561: recursively normalize JSON-looking strings, retaining parse failures. */
export function canonicalizeForCompare(value: Json): Json {
  if (Array.isArray(value)) return value.map(canonicalizeForCompare);
  if (typeof value === 'string') {
    const trimmed = rustTrimStart(value);
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { return canonicalizeForCompare(parseJsonLossless(trimmed)); }
      catch (error) {
        // Rust falls back for malformed JSON, not for a runtime unable to preserve numbers.
        if (error instanceof SyntaxError) return value;
        throw error;
      }
    }
    return value;
  }
  if (isJsonObject(value)) {
    const entries = Object.entries(value)
      .filter(([key]) => !STRIP_KEYS.includes(key))
      .map(([key, item]) => [key, canonicalizeForCompare(item)] as const)
      .sort(([a], [b]) => a === b ? 0 : a < b ? -1 : 1);
    return Object.fromEntries(entries);
  }
  return value;
}
