/**
 * 声明式 Rust 类型构造器（`rs.*`）与 serde rename_all 规则。
 *
 * ```ts
 * const ProcessingProgress = rs.struct({
 *   stage: rs.string,
 *   current_page: rs.field(rs.option(rs.usize), { skipIf: 'none' }),
 *   percent: rs.f32,
 *   ready_modes: rs.vec(rs.string),
 * }, { renameAll: 'camelCase' });
 * ```
 * 字段对象的键顺序即 Rust 字段声明顺序（Rust 字段名不会是整数样式，JS 对象保持其插入顺序）。
 */
import type {
  EnumRepr, FieldSpec, IntKind, RenameRule, RustSchema, SkipIf, VariantSpec,
} from './api.ts';

const isUpper = (c: string): boolean => /\p{Uppercase}/u.test(c);
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const asciiUpper = (s: string): string => s.replace(/[a-z]/g, (c) => c.toUpperCase());

/** serde_derive-1.0.228 src/internals/case.rs `RenameRule::apply_to_variant`（输入为 PascalCase 变体名）。 */
export function renameVariant(name: string, rule: RenameRule | undefined): string {
  switch (rule) {
    case undefined: case 'PascalCase': return name;
    case 'lowercase': return asciiLower(name);
    case 'UPPERCASE': return asciiUpper(name);
    case 'camelCase': return asciiLower(name.slice(0, 1)) + name.slice(1);
    case 'snake_case': {
      let out = '';
      let first = true;
      for (const ch of name) {
        if (!first && isUpper(ch)) out += '_';
        out += asciiLower(ch);
        first = false;
      }
      return out;
    }
    case 'SCREAMING_SNAKE_CASE': return asciiUpper(renameVariant(name, 'snake_case'));
    case 'kebab-case': return renameVariant(name, 'snake_case').replace(/_/g, '-');
    case 'SCREAMING-KEBAB-CASE': return renameVariant(name, 'SCREAMING_SNAKE_CASE').replace(/_/g, '-');
  }
}

/** serde_derive-1.0.228 src/internals/case.rs `RenameRule::apply_to_field`（输入为 snake_case 字段名）。 */
export function renameField(name: string, rule: RenameRule | undefined): string {
  switch (rule) {
    case undefined: case 'lowercase': case 'snake_case': return name;
    case 'UPPERCASE': case 'SCREAMING_SNAKE_CASE': return asciiUpper(name);
    case 'PascalCase': {
      let out = '';
      let capitalize = true;
      for (const ch of name) {
        if (ch === '_') capitalize = true;
        else if (capitalize) { out += asciiUpper(ch); capitalize = false; } else out += ch;
      }
      return out;
    }
    case 'camelCase': {
      const pascal = renameField(name, 'PascalCase');
      return asciiLower(pascal.slice(0, 1)) + pascal.slice(1);
    }
    case 'kebab-case': return name.replace(/_/g, '-');
    case 'SCREAMING-KEBAB-CASE': return asciiUpper(name).replace(/_/g, '-');
  }
}

const isSchema = (x: unknown): x is RustSchema => typeof x === 'object' && x !== null && typeof (x as { kind?: unknown }).kind === 'string';

const int = (kind: IntKind): RustSchema => Object.freeze({ kind: 'int', int: kind });

export interface StructOptions {
  readonly renameAll?: RenameRule;
  readonly name?: string;
  readonly unknown?: 'drop' | 'error';
}

export interface EnumOptions {
  readonly renameAll?: RenameRule;
  readonly name?: string;
  /** 内部标记 `#[serde(tag = "...")]`；与 `content` 同给即相邻标记。 */
  readonly tag?: string;
  readonly content?: string;
  readonly untagged?: boolean;
}

function enumRepr(options: EnumOptions): EnumRepr {
  if (options.untagged) return { kind: 'untagged' };
  if (options.tag !== undefined && options.content !== undefined) return { kind: 'adjacent', tag: options.tag, content: options.content };
  if (options.tag !== undefined) return { kind: 'internal', tag: options.tag };
  return { kind: 'external' };
}

export const rs = Object.freeze({
  bool: Object.freeze({ kind: 'bool' }) as RustSchema,
  string: Object.freeze({ kind: 'string' }) as RustSchema,
  char: Object.freeze({ kind: 'char' }) as RustSchema,
  unit: Object.freeze({ kind: 'unit' }) as RustSchema,
  u8: int('u8'), u16: int('u16'), u32: int('u32'), u64: int('u64'), u128: int('u128'), usize: int('usize'),
  i8: int('i8'), i16: int('i16'), i32: int('i32'), i64: int('i64'), i128: int('i128'), isize: int('isize'),
  f32: Object.freeze({ kind: 'float', float: 'f32' }) as RustSchema,
  f64: Object.freeze({ kind: 'float', float: 'f64' }) as RustSchema,
  dateTimeUtc: Object.freeze({ kind: 'datetime' }) as RustSchema,
  naiveDateTime: Object.freeze({ kind: 'naive-datetime' }) as RustSchema,

  option: (inner: RustSchema): RustSchema => ({ kind: 'option', inner }),
  vec: (items: RustSchema): RustSchema => ({ kind: 'seq', items }),
  tuple: (...items: RustSchema[]): RustSchema => ({ kind: 'tuple', items }),
  /** `HashMap<K, V>`：Rust 侧键序不确定，按输入顺序输出。 */
  hashMap: (value: RustSchema, key: 'string' | IntKind = 'string'): RustSchema => ({ kind: 'map', key, value, order: 'unspecified' }),
  /** `BTreeMap<K, V>`：按键排序。 */
  btreeMap: (value: RustSchema, key: 'string' | IntKind = 'string'): RustSchema => ({ kind: 'map', key, value, order: 'sorted' }),
  /** `IndexMap<K, V>` / `serde_json::Map`（preserve_order）：插入顺序。 */
  indexMap: (value: RustSchema, key: 'string' | IntKind = 'string'): RustSchema => ({ kind: 'map', key, value, order: 'insertion' }),

  field: (schema: RustSchema, options: Omit<FieldSpec, 'schema'> & { skipIf?: SkipIf } = {}): FieldSpec => ({ ...options, schema }),
  struct: (fields: Readonly<Record<string, RustSchema | FieldSpec>>, options: StructOptions = {}): RustSchema => ({
    kind: 'struct',
    fields: Object.entries(fields).map(([name, spec]) => [name, isSchema(spec) ? { schema: spec } : spec] as const),
    ...options,
  }),

  variant: (schema: RustSchema | null, options: { rename?: string } = {}): VariantSpec => ({ ...options, schema }),
  /** 变体值：`null` = 单元变体；schema = newtype/tuple/struct 变体；或用 `rs.variant` 指定 rename。 */
  enum: (variants: Readonly<Record<string, RustSchema | VariantSpec | null>>, options: EnumOptions = {}): RustSchema => ({
    kind: 'enum',
    repr: enumRepr(options),
    variants: Object.entries(variants).map(([name, v]) => [name, v === null ? { schema: null } : isSchema(v) ? { schema: v } : v] as const),
    ...(options.renameAll !== undefined && { renameAll: options.renameAll }),
    ...(options.name !== undefined && { name: options.name }),
  }),

  literal: (...values: unknown[]): RustSchema => ({ kind: 'literal', values }),
  union: (...branches: RustSchema[]): RustSchema => ({ kind: 'union', branches }),
  value: (options: { integralFloats?: 'int' | 'float' } = {}): RustSchema => ({ kind: 'value', ...options }),
  valueObject: (fields: Readonly<Record<string, RustSchema>>, options: { rest?: RustSchema } = {}): RustSchema => ({
    kind: 'value-object', fields: Object.entries(fields), rest: options.rest ?? { kind: 'value' },
  }),
  custom: (name: string, write: (value: unknown) => string, matches?: (value: unknown) => boolean): RustSchema => ({ kind: 'custom', name, write, ...(matches && { matches }) }),
  lazy: (name: string, get: () => RustSchema): RustSchema => {
    let cached: RustSchema | undefined;
    return { kind: 'lazy', name, get: () => (cached ??= get()) };
  },
});
