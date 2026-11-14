import type { JsonValue } from '../api.ts';
import { stringifyJsonLossless } from '../../../platform/util/lossless-json.ts';
import { cloneExact, losslessJsonValue } from './json.ts';

/**
 * Host-only ToolCall copy. Use before structuredClone/JSON.stringify would discard
 * numeric facts on nonstandard argument objects. This cannot restore facts lost upstream.
 */
export function cloneProviderToolCall<T extends JsonValue>(value: T): T {
  return cloneExact(value);
}

/**
 * Serialize a provider ToolCall (or object arguments) with its recorded serde
 * numeric semantics. Standard arguments strings are still strings, not parsed.
 * Cross-owner consumers must call this before losing the source metadata.
 */
export function stringifyProviderToolCall(value: JsonValue): string {
  return stringifyJsonLossless(losslessJsonValue(value));
}
