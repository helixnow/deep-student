/**
 * Minimal serde_json mirror. JSON.parse loses the distinction between `5` and `5.0` and rounds
 * integers past 2^53; serde_json keeps it. Numbers are kept as their source token so callers
 * can apply serde's rules exactly.
 *
 * dstu-anki builds serde_json with `arbitrary_precision` (dstu-anki/Cargo.toml:34-37), which
 * changes `Value` numbers but not direct struct deserialization, so both rule sets live here.
 */
export class JsonNumberToken {
  readonly source: string;
  constructor(source: string) {
    this.source = source;
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const U64_MAX = 18446744073709551615n;
const I64_MIN = -9223372036854775808n;
const I64_MAX = 9223372036854775807n;

/** JSON syntax only: numbers become tokens; string validity is checked by the decoders below. */
export function parseJsonTokens(raw: string): unknown {
  try {
    return JSON.parse(raw, (_key: string, item: unknown, context?: { source?: string }) =>
      typeof item === 'number' ? new JsonNumberToken(context?.source ?? String(item)) : item);
  } catch {
    return undefined;
  }
}

/** serde_json decodes every string it does not skip and rejects unpaired surrogate escapes. */
export function hasLoneSurrogate(text: string): boolean {
  return LONE_SURROGATE.test(text);
}

function anyLoneSurrogate(value: unknown): boolean {
  if (typeof value === 'string') return hasLoneSurrogate(value);
  if (Array.isArray(value)) return value.some(anyLoneSurrogate);
  if (value !== null && typeof value === 'object' && !(value instanceof JsonNumberToken)) {
    return Object.entries(value).some(([key, item]) => hasLoneSurrogate(key) || anyLoneSurrogate(item));
  }
  return false;
}

/**
 * `serde_json::from_str::<Value>` (and `Vec<String>` / `HashMap<String, String>`, which decode
 * every string): undefined where serde returns Err. Duplicate keys keep the last value.
 */
export function parseSerdeJson(raw: string): unknown {
  const value = parseJsonTokens(raw);
  return value === undefined || anyLoneSurrogate(value) ? undefined : value;
}

// ---- struct fields (`deserialize_i32` etc.: serde_json's normal number parser) ----

/** Integer token for a typed struct field: no fraction/exponent, and `-0` is the float -0.0. */
export function structInteger(value: unknown): bigint | null {
  if (!(value instanceof JsonNumberToken) || !/^-?\d+$/.test(value.source)) return null;
  if (/^-0+$/.test(value.source)) return null;
  return BigInt(value.source);
}

/** f64 struct field: overflow is `NumberOutOfRange`. */
export function structF64(value: unknown): number | null {
  if (!(value instanceof JsonNumberToken)) return null;
  const n = Number(value.source);
  return Number.isFinite(n) ? n : null;
}

// ---- `Value` accessors under arbitrary_precision (number.rs: `self.n.parse().ok()`) ----

/** In-range integers are re-rendered from u64/i64, so `-0` reads back as `0`. */
function valueInteger(value: unknown): bigint | null {
  if (!(value instanceof JsonNumberToken) || !/^-?\d+$/.test(value.source)) return null;
  const n = BigInt(value.source);
  return n >= I64_MIN && n <= U64_MAX ? n : null;
}

/** `Value::as_u64`. */
export function asU64(value: unknown): bigint | null {
  const n = valueInteger(value);
  return n !== null && n >= 0n ? n : null;
}

/** `Value::as_i64`. */
export function asI64(value: unknown): bigint | null {
  const n = valueInteger(value);
  return n !== null && n <= I64_MAX ? n : null;
}

/** `Value::as_f64`: `parse::<f64>().ok().filter(is_finite)`. */
export function asF64(value: unknown): number | null {
  if (!(value instanceof JsonNumberToken)) return null;
  const n = Number(value.source);
  return Number.isFinite(n) ? n : null;
}

/** `Value::get` on an object: a present key (even with null) wins; non-objects yield None. */
export function getKey(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}
