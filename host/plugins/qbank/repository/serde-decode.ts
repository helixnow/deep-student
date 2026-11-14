/**
 * Decoders for persisted qbank JSON that follow serde_json + `#[derive(Deserialize)]` rules:
 * unknown keys are ignored, a missing `Option<T>` is `None`, a missing non-Option field
 * without `#[serde(default)]` fails, integers are range-checked for their Rust width, and
 * unit enum variants accept both `"name"` and `{"name": null}`.
 * Messages follow serde's wording without the line/column suffix.
 */
import type { JsonValue } from '../../../platform/errors/api.ts';
import { rawJsonNumberAsNumber, valueFromStr } from '../src/raw-json-number.ts';
import { classifyJsonNumber, ryuFormat } from '../../../platform/util/portable.ts';

type JsonNumber = ReturnType<typeof classifyJsonNumber>;

export class SerdeDecodeError extends Error {}

export type Decoder<T> = (value: unknown, path: string) => T;

/** 无损解析留下的原生数字原子（小数/指数/超安全整数 token），按 serde_json 的数字分类。 */
function numberAtom(value: unknown): JsonNumber | null {
  return rawJsonNumberAsNumber(value) === null ? null : classifyJsonNumber((value as { rawJSON: string }).rawJSON);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'sequence';
  const atom = numberAtom(value);
  if (atom !== null) {
    return atom.kind === 'f64' ? `floating point \`${ryuFormat(atom.value)}\`` : `integer \`${atom.value}\``;
  }
  if (typeof value === 'object') return 'map';
  if (typeof value === 'string') return `string ${JSON.stringify(value)}`;
  if (typeof value === 'boolean') return `boolean \`${String(value)}\``;
  if (typeof value === 'number') {
    return Number.isInteger(value) ? `integer \`${String(value)}\`` : `floating point \`${String(value)}\``;
  }
  return typeof value;
}

function fail(path: string, message: string): never {
  throw new SerdeDecodeError(path === '' ? message : `${path}: ${message}`);
}

function invalidType(value: unknown, expected: string, path: string): never {
  return fail(path, `invalid type: ${describe(value)}, expected ${expected}`);
}

export const string: Decoder<string> = (value, path) =>
  typeof value === 'string' ? value : invalidType(value, 'a string', path);

export const boolean: Decoder<boolean> = (value, path) =>
  typeof value === 'boolean' ? value : invalidType(value, 'a boolean', path);

function integer(name: string, min: number, max: number): Decoder<number> {
  return (value, path) => {
    const atom = numberAtom(value);
    if (atom !== null && atom.kind !== 'f64') {
      return fail(path, `invalid value: integer \`${atom.value}\`, expected ${name}`);
    }
    if (typeof value !== 'number' || !Number.isInteger(value)) return invalidType(value, name, path);
    if (value < min || value > max) {
      return fail(path, `invalid value: integer \`${String(value)}\`, expected ${name}`);
    }
    return value;
  };
}

export const u16 = integer('u16', 0, 0xFFFF);
export const u32 = integer('u32', 0, 0xFFFF_FFFF);
export const i32 = integer('i32', -0x8000_0000, 0x7FFF_FFFF);
/** `usize` / `i64`: values beyond 2^53 cannot come from JSON.parse without loss (D3). */
export const usize = integer('usize', 0, Number.MAX_SAFE_INTEGER);
export const i64 = integer('i64', Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);

export const f64: Decoder<number> = (value, path) => {
  if (typeof value === 'number') return value;
  // Value 持久化把小数/指数/超安全整数保留为 F4 原生 raw atom；typed f64 在此边界按
  // serde_json `Number` 的 raw 解析（from_value 路径），不改变 generic Value 的持久化。
  const fromRaw = rawJsonNumberAsNumber(value);
  return fromRaw !== null ? fromRaw : invalidType(value, 'f64', path);
};

/** `serde_json::Value` (always present when the key exists). */
export const json: Decoder<JsonValue> = value => value as JsonValue;

/** `Option<T>`: JSON null (or a missing key, see `field`) is `None`. */
export function option<T>(inner: Decoder<T>): Decoder<T | null> {
  return (value, path) => (value === null || value === undefined ? null : inner(value, path));
}

export function vec<T>(inner: Decoder<T>): Decoder<T[]> {
  return (value, path) => {
    if (!Array.isArray(value)) return invalidType(value, 'a sequence', path);
    return value.map((item, index) => inner(item, `${path}[${index}]`));
  };
}

export function tuple4<T>(inner: Decoder<T>): Decoder<[T, T, T, T]> {
  return (value, path) => {
    if (!Array.isArray(value)) return invalidType(value, 'an array of length 4', path);
    if (value.length !== 4) return fail(path, `invalid length ${value.length}, expected an array of length 4`);
    return value.map((item, index) => inner(item, `${path}[${index}]`)) as [T, T, T, T];
  };
}

/** `HashMap<String, T>`. */
export function map<T>(inner: Decoder<T>): Decoder<Record<string, T>> {
  return (value, path) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || numberAtom(value) !== null) {
      return invalidType(value, 'a map', path);
    }
    const out: Record<string, T> = {};
    for (const [key, item] of Object.entries(value)) out[key] = inner(item, `${path}.${key}`);
    return out;
  };
}

/** Externally tagged enum whose variants are all unit variants. */
export function unitEnum<T extends string>(variants: readonly T[]): Decoder<T> {
  const expected = variants.map(v => `\`${v}\``).join(', ');
  const check = (name: string, path: string): T => (variants as readonly string[]).includes(name)
    ? name as T : fail(path, `unknown variant \`${name}\`, expected one of ${expected}`);
  return (value, path) => {
    if (typeof value === 'string') return check(value, path);
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && numberAtom(value) === null) {
      const keys = Object.keys(value);
      if (keys.length === 1 && (value as Record<string, unknown>)[keys[0]!] === null) return check(keys[0]!, path);
    }
    return invalidType(value, 'enum', path);
  };
}

type FieldSpec = {
  readonly decode: Decoder<unknown>;
  /** `#[serde(default)]` value, or `'option'` for a plain `Option<T>` (missing ⇒ None). */
  readonly missing?: { readonly value: () => unknown } | 'option';
  /** `skip_serializing_if = "Option::is_none"`: omit the key instead of emitting null. */
  readonly omitNone?: boolean;
  /** `#[serde(alias = ...)]`: extra accepted input names. */
  readonly aliases?: readonly string[];
};

export const req = (decode: Decoder<unknown>): FieldSpec => ({ decode });
export const opt = (decode: Decoder<unknown>, omitNone = false): FieldSpec =>
  ({ decode: option(decode), missing: 'option', omitNone });
export const dflt = (decode: Decoder<unknown>, value: () => unknown): FieldSpec =>
  ({ decode, missing: { value } });
export const alias = (spec: FieldSpec, ...aliases: string[]): FieldSpec => ({ ...spec, aliases });

/** A `#[derive(Deserialize)]` struct; output key order follows the Rust field order. */
export function struct<T>(name: string, fields: Readonly<Record<string, FieldSpec>>): Decoder<T> {
  return (value, path) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || numberAtom(value) !== null) {
      return invalidType(value, `struct ${name}`, path);
    }
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(fields)) {
      const childPath = path === '' ? key : `${path}.${key}`;
      const names = [key, ...(spec.aliases ?? []).filter(name => name !== key)];
      const present = names.filter(name => Object.prototype.hasOwnProperty.call(input, name));
      if (present.length > 1) fail(path, `duplicate field \`${key}\``);
      let decoded: unknown;
      if (present.length === 0) {
        if (spec.missing === undefined) fail(path, `missing field \`${key}\``);
        decoded = spec.missing === 'option' ? null : spec.missing.value();
      } else {
        decoded = spec.decode(input[present[0]!], childPath);
      }
      if (spec.omitNone && decoded === null) continue;
      out[key] = decoded;
    }
    return out as T;
  };
}

/**
 * `serde_json::from_str::<T>`: syntax errors and shape errors both throw. Under arbitrary_precision
 * `Value` fields keep every number as written (`2.50`, `1e-2`, big integers) and typed integer
 * fields reject float tokens such as `2.0`, so the text is parsed losslessly before decoding.
 */
export function fromStr<T>(raw: string, decode: Decoder<T>): T {
  let value: unknown;
  try { value = valueFromStr(raw); }
  catch (error) { throw new SerdeDecodeError(error instanceof Error ? error.message : String(error)); }
  return decode(value, '');
}

export const fromValueStr = fromStr;
