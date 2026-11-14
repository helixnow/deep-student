/** Saving a validated JsonReader Value without widening numbers to JS f64.
 * serde_json1.0.149 arbitrary_precision: number.rs Display/Serialize,
 * de.rs scan_exponent (lowercase e, explicit positive exponent).
 */
import { objectLastWins, type JsonNode, type JsonValueNumber } from './json-exact.ts';

/** Native JSON.rawJSON numeric atom. Treat as opaque; it is not a business
 * object/string or a JsonNumber with a fabricated numeric `.value`.
 */
export type JsonRawNumber = Readonly<{ rawJSON: string }>;

function numberText(number: JsonValueNumber): string {
  if (number.kind === 'u64' || number.kind === 'i64') return number.value.toString();
  // parse_any_number reads the integer spelling -0 as i64(0) for Value.
  if (number.raw === '-0') return '0';
  return number.raw.replace('E', 'e').replace(/e(?=\d)/, 'e+');
}

/**
 * Numeric projection for a Value node returned by JsonReader.readValue /
 * parseJsonDocument. JSON.stringify preserves the atom as a JSON number,
 * including 1e999 and integers above 2^53. No Number conversion or null fallback.
 * This is not a typed numeric decoder; don't feed unchecked/handwritten raw text.
 * Don't structuredClone or spread the atom (that loses its native raw brand).
 * Keep atoms local to JSON.stringify persistence; they are not IPC/domain DTOs.
 */
export function jsonNumberToRawJSON(number: JsonValueNumber): JsonRawNumber {
  const json = JSON as typeof JSON & { rawJSON(text: string): JsonRawNumber };
  if (typeof json.rawJSON !== 'function') throw new Error('JSON.rawJSON is required for lossless Value numeric projection');
  return json.rawJSON(numberText(number));
}

/**
 * Compact serde_json::Value output from the validated reader tree, not arbitrary
 * JS objects. Number digits/float spelling are retained and exponents normalized;
 * duplicate map keys are last-wins at the first insertion position.
 * Unlike projecting to ordinary JS objects then JSON.stringify, integer-looking
 * object keys keep their original preserve_order position here.
 */
export function stringifyJsonValue(node: JsonNode): string {
  switch (node.kind) {
    case 'null': return 'null';
    case 'bool': return node.value ? 'true' : 'false';
    case 'string': return JSON.stringify(node.value);
    case 'number': return numberText(node.value);
    case 'array': return `[${node.items.map(stringifyJsonValue).join(',')}]`;
    case 'object': return `{${[...objectLastWins(node)].map(([key, value]) => `${JSON.stringify(key)}:${stringifyJsonValue(value)}`).join(',')}}`;
  }
}
