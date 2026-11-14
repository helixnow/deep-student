import type { JsonObject, JsonValue } from '../api.ts';
import { parseJsonLossless, type DbJson } from '../../../platform/util/lossless-json.ts';

/** serde_json Value accessors: wrong-typed/missing fields are None. */
export function object(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
export function array(value: JsonValue | undefined): JsonValue[] | undefined { return Array.isArray(value) ? value : undefined; }
export function string(value: JsonValue | undefined): string | undefined { return typeof value === 'string' ? value : undefined; }
export function field(value: JsonValue | undefined, key: string): JsonValue | undefined { return object(value)?.[key]; }
export function int(value: JsonValue | undefined): number | undefined { return typeof value === 'number' && Number.isInteger(value) ? value : undefined; }
export function uint(value: JsonValue | undefined): number | undefined { const n = int(value); return n !== undefined && n >= 0 ? n : undefined; }
/**
 * `serde_json::from_str::<Value>` acceptance: JSON.parse plus the serde-only
 * rejections recorded by `scanShape` (lone surrogate escapes, recursion limit).
 */
export function parseJson(text: string): JsonValue | undefined {
  return parseJsonExact(text);
}
function parseJsonSyntax(text: string): JsonValue | undefined {
  try { return JSON.parse(text) as JsonValue; } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}
/**
 * Text facts that JSON.parse discards but serde_json sees:
 * - dstu-llm builds serde_json with `arbitrary_precision` (Cargo.toml:40), so
 *   integer serde fields / `as_u64` / `as_i64` see each Number's literal text
 *   (`1.0` is not an integer; the full 64-bit range is accepted);
 * - struct deserialization rejects a repeated known field (`duplicate field`),
 *   while JSON.parse keeps the last value;
 * - serde_json's default recursion limit (128) rejects nesting depth >= 128.
 * `parseJsonExact` records raw keys and number literals per parsed container.
 */
interface Shape { keys: string[]; children: Map<string, Shape | string> }
const keyLists = new WeakMap<object, string[]>();
const numberSources = new WeakMap<object, Map<string, string>>();
const SERDE_RECURSION_LIMIT = 128;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const NUMBER_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** Scans text already accepted by JSON.parse; returns null on serde-only rejections (depth limit, lone surrogate). */
function scanShape(text: string): Shape | string | undefined | null {
  let i = 0;
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++; };
  const readString = (): string => {
    const start = i++;
    while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i++;
    const decoded = JSON.parse(text.slice(start, i)) as string;
    // read.rs:900-960 (validate=true for str/Value): an unpaired \uD800-\uDFFF escape is a syntax error.
    if (LONE_SURROGATE.test(decoded)) throw new RangeError('lone surrogate');
    return decoded;
  };
  const value = (depth: number): Shape | string | undefined => {
    ws();
    const c = text[i];
    if (c === '{' || c === '[') {
      if (depth + 1 >= SERDE_RECURSION_LIMIT) throw new RangeError('recursion limit exceeded');
      const isObject = c === '{', close = isObject ? '}' : ']';
      const shape: Shape = { keys: [], children: new Map() };
      i++; ws();
      if (text[i] === close) { i++; return shape; }
      for (let index = 0; ; index++) {
        let key = String(index);
        if (isObject) { ws(); key = readString(); ws(); i++; }
        const child = value(depth + 1);
        shape.keys.push(key);
        if (child === undefined) shape.children.delete(key); else shape.children.set(key, child);
        ws();
        if (text[i++] === ',') continue;
        return shape;
      }
    }
    if (c === '"') { readString(); return undefined; }
    NUMBER_RE.lastIndex = i;
    const number = NUMBER_RE.exec(text);
    if (number !== null) { i += number[0].length; return number[0]; }
    i += c === 'f' ? 5 : 4;
    return undefined;
  };
  try { return value(0); } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

function attachShape(value: JsonValue, shape: Shape): void {
  if (value === null || typeof value !== 'object') return;
  if (!Array.isArray(value)) keyLists.set(value, shape.keys);
  const sources = new Map<string, string>();
  for (const [key, child] of shape.children) {
    if (typeof child === 'string') sources.set(key, child);
    else attachShape((value as Record<string, JsonValue>)[key]!, child);
  }
  numberSources.set(value, sources);
}

export function parseJsonExact(text: string): JsonValue | undefined {
  const value = parseJsonSyntax(text);
  if (value === undefined) return undefined;
  const shape = scanShape(text);
  if (shape === null) return undefined;
  if (shape !== undefined && typeof shape !== 'string') attachShape(value, shape);
  return value;
}

/**
 * serde struct field scan: the first field (alias groups count as one field)
 * seen twice in key order, as serde's `duplicate field` error. Objects not from
 * `parseJsonExact` use their own keys (alias conflicts only).
 */
export function duplicateField(holder: JsonValue | undefined, fields: readonly (readonly string[])[]): string | undefined {
  if (holder === null || typeof holder !== 'object' || Array.isArray(holder)) return undefined;
  const canonical = new Map<string, string>();
  for (const group of fields) for (const name of group) canonical.set(name, group[0]!);
  const seen = new Set<string>();
  for (const key of keyLists.get(holder) ?? Object.keys(holder)) {
    const field = canonical.get(key);
    if (field === undefined) continue;
    if (seen.has(field)) return field;
    seen.add(field);
  }
  return undefined;
}
/** Literal text of a Number field; values not produced by `parseJsonExact` use their JSON form. */
function numberLiteral(holder: JsonValue | undefined, key: string): string | undefined {
  if (holder === null || typeof holder !== 'object') return undefined;
  const value = (holder as Record<string, JsonValue | undefined>)[key];
  if (typeof value !== 'number') return undefined;
  const literal = numberSources.get(holder)?.get(key);
  if (literal !== undefined) return literal;
  // Host-built values carry no literal: an integral number means its exact value
  // (JSON.stringify would print the shortest round-trip text, e.g. 2^60 → ...847000).
  // Integers >= 1e21 stay in exponent form, which no 64-bit accessor accepts, as in Rust.
  return Number.isInteger(value) && Math.abs(value) < 1e21 ? BigInt(value).toString() : JSON.stringify(value);
}
export const U64_MAX = 18446744073709551615n;
export const I64_MIN = -9223372036854775808n;
export const I64_MAX = 9223372036854775807n;
/** serde_json `Value::as_u64` on `holder[key]` (non-Number → undefined). */
export function fieldU64(holder: JsonValue | undefined, key: string): bigint | undefined {
  // arbitrary_precision stores `-0` as the i64 0 (de.rs parse_any_number → itoa "0"), so as_u64 accepts it.
  const literal = numberLiteral(holder, key);
  if (literal === undefined || !/^(?:\d+|-0)$/.test(literal)) return undefined;
  const value = BigInt(literal);
  return value <= U64_MAX ? value : undefined;
}
/** serde_json `Value::as_i64` on `holder[key]`; direct typed deserialization differs on `-0`. */
export function fieldI64(holder: JsonValue | undefined, key: string): bigint | undefined {
  const literal = numberLiteral(holder, key);
  if (literal === undefined || !/^-?\d+$/.test(literal)) return undefined;
  const value = BigInt(literal);
  return value >= I64_MIN && value <= I64_MAX ? value : undefined;
}
/**
 * Direct serde integer fields use deserialize_number → parse_integer, even with
 * arbitrary_precision (de.rs:319-341,509-527,1500-1507). `-0` is F64(-0), unlike
 * Value::deserialize's parse_any_number path, and the integer visitor rejects it.
 */
export function typedI64(holder: JsonValue | undefined, key: string): bigint | undefined {
  return numberLiteral(holder, key) === '-0' ? undefined : fieldI64(holder, key);
}
export function typedU64(holder: JsonValue | undefined, key: string): bigint | undefined {
  return numberLiteral(holder, key) === '-0' ? undefined : fieldU64(holder, key);
}
/** `holder[key].as_i64()`, narrowed to a JS number at the boundary (D3). */
export function i64At(holder: JsonValue | undefined, key: string): number | undefined {
  const value = fieldI64(holder, key);
  return value === undefined ? undefined : Number(value);
}
/** `holder[key].as_i64().map(|v| v as i32)` (two's-complement truncation, exact before narrowing). */
export function i32At(holder: JsonValue | undefined, key: string): number | undefined {
  const value = fieldI64(holder, key);
  return value === undefined ? undefined : Number(BigInt.asIntN(32, value));
}
/** `holder[key].as_u64()`, narrowed to a JS number at the boundary (D3). */
export function u64At(holder: JsonValue | undefined, key: string): number | undefined {
  const value = fieldU64(holder, key);
  return value === undefined ? undefined : Number(value);
}
/** `Value::as_f64` under arbitrary_precision (number.rs:170) filters non-finite values such as `1e400`. */
export function f64(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
/** `Value::clone` keeping the literal metadata `parseJsonExact` recorded (structuredClone drops it). */
export function cloneExact<T extends JsonValue>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  const copy = (Array.isArray(value) ? value.map(item => cloneExact(item)) : Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, cloneExact(item as JsonValue)]),
  )) as T;
  const keys = keyLists.get(value), sources = numberSources.get(value);
  if (keys !== undefined) keyLists.set(copy as object, [...keys]);
  if (sources !== undefined) numberSources.set(copy as object, new Map(sources));
  return copy;
}
/**
 * Project recorded numeric facts into the existing shared bigint/JsonFloat value
 * representation before owner-side serialization. No parser/serializer is copied.
 */
export function losslessJsonValue(value: JsonValue): DbJson {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((_, index) => losslessJsonField(value, String(index))!);
  return Object.fromEntries(Object.keys(value).map(key => [key, losslessJsonField(value, key)!]));
}
/** A scalar's literal belongs to its source holder/key, so capture it before copying it out. */
export function losslessJsonField(holder: JsonValue, key: string): DbJson | undefined {
  if (holder === null || typeof holder !== 'object' || !Object.hasOwn(holder, key)) return undefined;
  const value = (holder as Record<string, JsonValue>)[key]!;
  const literal = numberLiteral(holder, key);
  return literal === undefined ? losslessJsonValue(value) : parseJsonLossless(literal);
}
/** `map.insert(key, json!(integer))`: stores an exact integer literal for later `as_i64` reads. */
export function setExactInteger(holder: JsonObject, key: string, value: bigint): void {
  holder[key] = Number(value);
  let sources = numberSources.get(holder);
  if (sources === undefined) { sources = new Map(); numberSources.set(holder, sources); }
  sources.set(key, value.toString());
}

/** Rust `str::to_ascii_lowercase`: only A-Z are folded, unlike JS `toLowerCase`. */
export function asciiLowercase(text: string): string { return text.replace(/[A-Z]/g, char => char.toLowerCase()); }

/**
 * Rust `f64::from_str` grammar (std dec2flt): optional sign, `inf`/`infinity`/
 * `nan` case-insensitively, or a decimal with optional fraction/exponent.
 * Rejects empty input, hex, underscores and surrounding whitespace.
 */
const RUST_F64_RE = /^[+-]?(?:(?:inf(?:inity)?|nan)|(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?))$/i;

export function parseRustF64(text: string): number | undefined {
  if (!RUST_F64_RE.test(text)) return undefined;
  const sign = text.startsWith('-') ? -1 : 1;
  const unsigned = text.startsWith('-') || text.startsWith('+') ? text.slice(1) : text;
  const lower = asciiLowercase(unsigned);
  if (lower === 'inf' || lower === 'infinity') return sign * Infinity;
  if (lower === 'nan') return Number.NaN;
  return Number(text);
}

/** Rust `u32::from_str`: ASCII digits only, empty or overflowing runs fail. */
export function parseU32(text: string): number | undefined {
  if (text === '' || !/^\d+$/.test(text)) return undefined;
  const value = Number(text);
  return value <= 0xffff_ffff ? value : undefined;
}
