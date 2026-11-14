/**
 * F4 Value numbers (`arbitrary_precision`) consumed by L18:
 * text extraction (pretty Value), VLM Value/from_value decoding and checkpoint serialization.
 * The raw token is authoritative; the projected kind (`f64`/`u64`/`i64`/`arbitrary`) is a hint.
 *
 * Production feature basis (locked): the app graph includes both `dstu-docs` and
 * `dstu-vision` (`src-tauri/Cargo.toml:314,329`); `dstu-vision/Cargo.toml:34-37` enables
 * `serde_json/arbitrary_precision`, which Cargo unifies onto `serde_json` for the whole graph.
 * In locked serde_json-1.0.149 `de.rs:1027-1050` `scan_exponent` lowercases `e` and writes an
 * explicit `+`; `number.rs:350-366` `Display`/`Serialize` writes that stored string, and
 * `de.rs:938-1000` parses the integer spelling `-0` as `i64(0)`. `document_parser.rs:4075-4086`
 * uses `from_str::<Value>` + `to_string_pretty`, so `1e2` is `1e+2` and `-0` is `0` in production.
 */
import { expect, it } from 'vitest';
import { parseJsonDocument } from '../../../platform/util/api.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';
import {
  decodeVlmExtractedQuestionsJson, decodeVlmExtractedQuestionsNodes, decodeVlmPageAnalysisJson,
  decodeVlmQuestionsValue, serializeJsonNode, valueFromNode,
} from '../src/vlm-serde.ts';

function isRawAtom(value: JsonValue): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === null && typeof value.rawJSON === 'string';
}

it('Value number text keeps the raw token (serde_json Display), not ryu/f64 spelling', () => {
  expect(serializeJsonNode(parseJsonDocument('{"a":1e2,"b":1.0,"c":-0,"d":9007199254740993,"e":1E400}')))
    .toBe('{"a":1e+2,"b":1.0,"c":0,"d":9007199254740993,"e":1e+400}');
});

it('old JsonValue projection preserves exact finite decimals and arbitrary digits', () => {
  const node = parseJsonDocument('{"h":1.234567890123456789,"i":2,"e":1e2,"u":1e-400,"d":9007199254740993}');
  if (node.kind !== 'object') throw new Error('object');
  const projected = valueFromNode(node);
  if (projected === null || typeof projected !== 'object' || Array.isArray(projected)) throw new Error('object');
  expect(projected.i).toBe(2); // safe integer tokens keep the historical number projection
  const exact: ReadonlyArray<readonly [string, string]> = [
    ['h', '1.234567890123456789'], ['e', '1e+2'], ['u', '1e-400'], ['d', '9007199254740993'],
  ];
  for (const [key, raw] of exact) {
    expect(isRawAtom(projected[key]!)).toBe(true);
    expect(JSON.stringify(projected[key])).toBe(raw);
  }
  expect(JSON.stringify(projected)).toBe(
    '{"h":1.234567890123456789,"i":2,"e":1e+2,"u":1e-400,"d":9007199254740993}');
});

it('nested Value arrays/objects keep exact decimals through the old JsonValue projection', () => {
  const node = parseJsonDocument('{"list":[1.234567890123456789,2],"o":{"h":0.1000000000000000001}}');
  expect(JSON.stringify(valueFromNode(node)))
    .toBe('{"list":[1.234567890123456789,2],"o":{"h":0.1000000000000000001}}');
});

it('from_value/from_str numeric decoding follows the raw token and keeps the two paths distinct', () => {
  const node = parseJsonDocument('[{"label":"1","bbox":[1e2,0,1,1]}]');
  if (node.kind !== 'array') throw new Error('array');
  expect(decodeVlmQuestionsValue(node.items)?.[0]?.bbox).toEqual([100, 0, 1, 1]);
  expect(decodeVlmPageAnalysisJson('{"questions":[{"label":"1","bbox":[1e2,0,1,1]}]}')?.questions[0]?.bbox)
    .toEqual([100, 0, 1, 1]);

  // typed from_str (JsonReader) rejects overflow; Value::Number::deserialize_f64 parses raw.
  expect(decodeVlmPageAnalysisJson('{"questions":[{"bbox":[1e400,0,1,1]}]}')).toBeNull();
  const arbitrary = parseJsonDocument('[{"label":"1","bbox":[1e400,0,1,1]}]');
  if (arbitrary.kind !== 'array') throw new Error('array');
  expect(decodeVlmQuestionsValue(arbitrary.items)?.[0]?.bbox[0]).toBe(Infinity);

  // usize is u64 parsing of the token: fractional/exponent/negative/overflow are invalid.
  const accepted = parseJsonDocument('[{"image_indices":[18446744073709551615]}]');
  if (accepted.kind !== 'array') throw new Error('array');
  expect(decodeVlmExtractedQuestionsNodes(accepted.items)?.[0]?.image_indices).toEqual([18446744073709551616]);
  expect(decodeVlmExtractedQuestionsJson('[{"image_indices":[1.0]}]')).toBeNull();
  expect(decodeVlmExtractedQuestionsJson('[{"image_indices":[-1]}]')).toBeNull();
  expect(decodeVlmExtractedQuestionsJson('[{"image_indices":[18446744073709551616]}]')).toBeNull();
});
