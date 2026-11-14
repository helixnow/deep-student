/** Recorder-local JSON views. Raw text is evidence; parsed values are for display/waits only. */
import { parseJsonDocument, objectLastWins, type JsonNode } from '../../../platform/util/api.ts';

export const nativeJson = JSON as typeof JSON & {
  rawJSON(text: string): Readonly<{ rawJSON: string }>;
  isRawJSON(value: unknown): value is Readonly<{ rawJSON: string }>;
};

/** Keep numeric tokens as numbers (native raw atoms), never business strings.
 * Only exactly round-trippable tokens use ordinary numbers. No parser is duplicated here.
 */
export function parseWireJson(text: string): unknown {
  const project = (node: JsonNode): unknown => {
    switch (node.kind) {
      case 'null': return null;
      case 'bool': case 'string': return node.value;
      case 'number': {
        const raw = node.value.raw;
        const value = Number(raw);
        return JSON.stringify(value) === raw && (!Number.isInteger(value) || Number.isSafeInteger(value))
          ? value : nativeJson.rawJSON(raw);
      }
      case 'array': return node.items.map(project);
      case 'object': return Object.fromEntries([...objectLastWins(node)].map(([key, value]) => [key, project(value)]));
    }
  };
  return project(parseJsonDocument(text));
}

/** Serialization at an owned input boundary; BigInt is a JSON number, not a string. */
export function encodeWireJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? nativeJson.rawJSON(item.toString()) : item);
}

/** A kernel object without source text cannot prove an unsafe Number's original digits.
 * Native atoms / BigInt are still exact; ordinary safe wire objects can be serialized.
 */
export function exactObjectJson(value: unknown): string | null {
  const ambiguous = (item: unknown): boolean => {
    if (typeof item === 'number') return !Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item)) || Object.is(item, -0);
    if (item === null || typeof item !== 'object' || nativeJson.isRawJSON(item)) return false;
    return Object.values(item).some(ambiguous);
  };
  return ambiguous(value) ? null : encodeWireJson(value) ?? null;
}

export function captureJson(value: unknown, raw: string | null | undefined, allowObject: boolean): { value: unknown; json: string | null } {
  const json = raw === undefined ? (allowObject ? exactObjectJson(value) : null) : raw;
  if (json !== null) {
    parseJsonDocument(json); // validate through the public lossless reader before keeping the original bytes
    return { value: JSON.parse(json), json };
  }
  // A missing raw source remains missing; this display serialization is never evidence.
  const display = encodeWireJson(value);
  return { value: display === undefined ? undefined : JSON.parse(display), json: null };
}
