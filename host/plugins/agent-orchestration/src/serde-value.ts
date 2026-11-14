/**
 * `serde_json::from_value` for derived structs: fields are visited in input order, unknown fields fail under
 * `deny_unknown_fields`, missing required fields fail after the visit, and the errors use serde's Display text.
 * Decoded structs keep the Rust declaration order; `None` options are omitted and `skipEmpty` vectors are
 * dropped when empty, so the decoded value doubles as the `serde_json::to_value` projection.
 */
export type Spec<T = unknown> = (value: unknown) => T;

export interface FieldSpec {
  key: string;
  spec: Spec;
  /** `Option<T>`: absent or `null` is `None`. */
  optional?: boolean;
  /** `#[serde(default)]`. */
  default?: () => unknown;
  /** `skip_serializing_if = "Vec::is_empty"`. */
  skipEmpty?: boolean;
}

export class SerdeError extends Error {}

/** serde_json `Value::unexpected` rendered through serde's `Unexpected` Display. */
export function unexpected(value: unknown): string {
  if (value === null || value === undefined) return 'unit value';
  if (typeof value === 'boolean') return `boolean \`${value}\``;
  if (typeof value === 'number') return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``;
  if (typeof value === 'string') return `string ${JSON.stringify(value)}`;
  return Array.isArray(value) ? 'sequence' : 'map';
}

const invalidType = (value: unknown, expected: string) => new SerdeError(`invalid type: ${unexpected(value)}, expected ${expected}`);

/** serde `OneOf` Display. */
export function oneOf(names: readonly string[]): string {
  if (names.length === 0) return 'there are no fields';
  if (names.length === 1) return `expected \`${names[0]}\``;
  if (names.length === 2) return `expected \`${names[0]}\` or \`${names[1]}\``;
  return `expected one of ${names.map(name => `\`${name}\``).join(', ')}`;
}

export const string: Spec<string> = value => {
  if (typeof value !== 'string') throw invalidType(value, 'a string');
  return value;
};
export const boolean: Spec<boolean> = value => {
  if (typeof value !== 'boolean') throw invalidType(value, 'a boolean');
  return value;
};
export const any: Spec<unknown> = value => value;

export function unsigned(name: 'u16' | 'u64', max: number): Spec<number> {
  return value => {
    if (typeof value !== 'number' || !Number.isInteger(value)) throw invalidType(value, name);
    if (value < 0 || value > max) throw new SerdeError(`invalid value: integer \`${value}\`, expected ${name}`);
    return value;
  };
}

export function vec<T>(item: Spec<T>): Spec<T[]> {
  return value => {
    if (!Array.isArray(value)) throw invalidType(value, 'a sequence');
    return value.map(item);
  };
}

/** Unit-variant enum (`rename_all`): serde_json accepts a string or a single-key map. */
export function unitEnum<T extends string>(variants: readonly T[]): Spec<T> {
  return value => {
    if (typeof value !== 'string') throw invalidType(value, 'string or map');
    if (!variants.includes(value as T)) throw new SerdeError(`unknown variant \`${value}\`, ${oneOf(variants)}`);
    return value as T;
  };
}

export function struct(name: string, fields: readonly FieldSpec[], denyUnknown = false): Spec<Record<string, unknown>> {
  const names = fields.map(field => field.key);
  return value => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidType(value, `struct ${name}`);
    const input = value as Record<string, unknown>;
    const decoded = new Map<string, unknown>();
    for (const [key, raw] of Object.entries(input)) {
      const field = fields.find(candidate => candidate.key === key);
      if (field === undefined) {
        if (denyUnknown) throw new SerdeError(`unknown field \`${key}\`, ${oneOf(names)}`);
        continue;
      }
      decoded.set(key, field.optional && raw === null ? undefined : field.spec(raw));
    }
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      let fieldValue = decoded.get(field.key);
      if (!decoded.has(field.key)) {
        if (field.default !== undefined) fieldValue = field.default();
        else if (!field.optional) throw new SerdeError(`missing field \`${field.key}\``);
      }
      if (fieldValue === undefined) continue;
      if (field.skipEmpty && Array.isArray(fieldValue) && fieldValue.length === 0) continue;
      out[field.key] = fieldValue;
    }
    return out;
  };
}
