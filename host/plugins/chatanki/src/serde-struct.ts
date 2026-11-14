// serde_derive `Deserialize` for structs read through `serde_json::from_value`
// (app graph: preserve_order + arbitrary_precision). Map form visits keys in
// input order; array form is positional; missing fields are checked in struct
// order after the visit.
import { isJsonNumberAtom, oneOf, unexpectedOf } from '../../../kernel/serde.ts';

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
const U64_MAX = 2n ** 64n - 1n;

export function serdeInvalidType(value: unknown, expected: string): never {
  throw new Error(`invalid type: ${unexpectedOf(value)}, expected ${expected}`);
}

export function isSerdeMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !isJsonNumberAtom(value);
}

export interface SerdeStructField {
  /** Wire name after `rename_all`. */
  readonly name: string;
  /** `#[serde(alias)]` names. */
  readonly aliases?: readonly string[];
  /** `Option<T>`: a missing map key is `None`; a positional slot is still required. */
  readonly option?: boolean;
  /** `#[serde(default)]`: missing in either form takes the default. */
  readonly default?: boolean;
  readonly read: (value: unknown) => unknown;
}

/** Values in struct order; `undefined` marks a missing `Option`/`default` field. */
export function deserializeSerdeStruct(
  raw: unknown, struct: string, fields: readonly SerdeStructField[], denyUnknownFields: boolean,
): unknown[] {
  const values: unknown[] = fields.map(() => undefined);
  if (Array.isArray(raw)) {
    const expecting = `struct ${struct} with ${fields.length} element${fields.length === 1 ? '' : 's'}`;
    fields.forEach((field, index) => {
      if (index < raw.length) values[index] = field.read(raw[index]);
      else if (field.default !== true) throw new Error(`invalid length ${index}, expected ${expecting}`);
    });
    if (raw.length > fields.length) {
      throw new Error(`invalid length ${raw.length}, expected fewer elements in array`);
    }
    return values;
  }
  if (!isSerdeMap(raw)) serdeInvalidType(raw, `struct ${struct}`);
  const names = fields.flatMap((field) => [field.name, ...(field.aliases ?? [])].sort());
  const seen = fields.map(() => false);
  for (const [key, value] of Object.entries(raw)) {
    const index = fields.findIndex((field) => field.name === key || (field.aliases ?? []).includes(key));
    if (index < 0) {
      if (!denyUnknownFields) continue;
      throw new Error(names.length === 0
        ? `unknown field \`${key}\`, there are no fields`
        : `unknown field \`${key}\`, expected ${oneOf(names)}`);
    }
    const field = fields[index]!;
    if (seen[index]) throw new Error(`duplicate field \`${field.name}\``);
    seen[index] = true;
    values[index] = field.read(value);
  }
  fields.forEach((field, index) => {
    if (!seen[index] && field.option !== true && field.default !== true) {
      throw new Error(`missing field \`${field.name}\``);
    }
  });
  return values;
}

export function serdeString(value: unknown): string {
  if (typeof value !== 'string') serdeInvalidType(value, 'a string');
  return value;
}

export function serdeBool(value: unknown): boolean {
  if (typeof value !== 'boolean') serdeInvalidType(value, 'a boolean');
  return value;
}

/** Unit-variant enum through serde_json `Value::deserialize_enum` (string, or a one-key map with a null payload). */
export function serdeUnitEnum<T extends string>(variants: readonly T[]): (value: unknown) => T {
  return (value) => {
    let variant: string;
    let payload: unknown = null;
    if (typeof value === 'string') {
      variant = value;
    } else if (isSerdeMap(value)) {
      const entries = Object.entries(value);
      if (entries.length !== 1) throw new Error('invalid value: map, expected map with a single key');
      [variant, payload] = entries[0]!;
    } else {
      return serdeInvalidType(value, 'string or map');
    }
    const match = variants.find((candidate) => candidate === variant);
    if (match === undefined) throw new Error(`unknown variant \`${variant}\`, expected ${oneOf(variants)}`);
    if (payload !== null) serdeInvalidType(payload, 'unit');
    return match;
  };
}

/** `Option<T>` through `Value::deserialize_option`: only JSON null is `None`. */
export function serdeOption<T>(read: (value: unknown) => T): (value: unknown) => T | null {
  return (value) => (value === null ? null : read(value));
}

export function serdeVec<T>(read: (value: unknown) => T): (value: unknown) => T[] {
  return (value) => {
    if (!Array.isArray(value)) serdeInvalidType(value, 'a sequence');
    return value.map(read);
  };
}

/** `HashMap<String, T>`: string keys, values decoded in input order. */
export function serdeMap<T>(read: (value: unknown) => T): (value: unknown) => Record<string, T> {
  return (value) => {
    if (!isSerdeMap(value)) serdeInvalidType(value, 'a map');
    const output: Record<string, T> = {};
    for (const [key, entry] of Object.entries(value)) {
      Object.defineProperty(output, key, {
        value: read(entry), enumerable: true, writable: true, configurable: true,
      });
    }
    return output;
  };
}

export const serdeStringMap: (value: unknown) => Record<string, string> = serdeMap(serdeString);

/** `f64` under arbitrary_precision: any JSON number parses; anything else is `invalid type ... expected f64`. */
export function serdeF64(value: unknown): number {
  if (typeof value === 'number') return value;
  if (isJsonNumberAtom(value)) return Number(value.rawJSON);
  return serdeInvalidType(value, 'f64');
}

function integerTextValue(text: string): number | bigint {
  if (!/^-?(?:0|[1-9][0-9]*)$/.test(text)) throw new Error('invalid number');
  const exact = BigInt(text);
  if (exact < I64_MIN || exact > I64_MAX) throw new Error('invalid number');
  return Number.isSafeInteger(Number(exact)) ? Number(exact) : exact;
}

/**
 * `i64` under arbitrary_precision: a number is `str::parse::<i64>` of its
 * literal (fractions/overflow are `invalid number`); anything else is an
 * `invalid type ... expected i64`.
 */
export function serdeI64(value: unknown): number | bigint {
  if (isJsonNumberAtom(value)) return integerTextValue(value.rawJSON);
  if (typeof value === 'bigint') {
    if (value < I64_MIN || value > I64_MAX) throw new Error('invalid number');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error('invalid number');
    const exact = BigInt(value);
    if (exact < I64_MIN || exact > I64_MAX) throw new Error('invalid number');
    return value;
  }
  return serdeInvalidType(value, 'i64');
}

/** Unsigned integer under arbitrary_precision: `str::parse` of the literal, so a sign is `invalid number`. */
function serdeUnsigned(value: unknown, primitive: 'u32' | 'u64' | 'usize', max: bigint): number | bigint {
  let exact: bigint;
  if (isJsonNumberAtom(value)) {
    // parse_any_number stores the literal `-0` as i64 0; `-0.0` stays text.
    if (!/^(?:-?0|[1-9][0-9]*)$/.test(value.rawJSON)) throw new Error('invalid number');
    exact = BigInt(value.rawJSON);
  } else if (typeof value === 'bigint') {
    exact = value;
  } else if (typeof value === 'number') {
    if (!Number.isInteger(value) || Object.is(value, -0)) throw new Error('invalid number');
    exact = BigInt(value);
  } else {
    return serdeInvalidType(value, primitive);
  }
  if (exact < 0n || exact > max) throw new Error('invalid number');
  return Number.isSafeInteger(Number(exact)) ? Number(exact) : exact;
}

export function serdeU64(value: unknown): number | bigint {
  return serdeUnsigned(value, 'u64', U64_MAX);
}

export function serdeU32(value: unknown): number {
  return Number(serdeUnsigned(value, 'u32', 0xffff_ffffn));
}

/** 64-bit target: `usize` has u64's range. */
export function serdeUsize(value: unknown): number | bigint {
  return serdeUnsigned(value, 'usize', U64_MAX);
}
