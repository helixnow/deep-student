/**
 * contracts/ipc（F5 从 Rust 源码抽取的 JSON Schema，格式见 host/kernel/contract.ts）→ RustSchema。
 *
 * 对应关系（scripts/electron-migration/contracts/lib/schema.ts 的产出）：
 * - object.properties 的顺序 = Rust 序列化顺序（含 flatten 展开）；不在 required 中的键带
 *   `x-option: omit`（skip_serializing_if = "Option::is_none"）或 `x-skip-serializing-if`。
 * - `anyOf [T, null]`（`x-option: null` 或 f32/f64 的 NaN → null）= Option<T>。
 * - `x-float` / `x-int` = 原数值类型；无标注的 number 按 f64，integer 按 i64。
 * - `additionalProperties: <schema>` 无 properties = map；`x-key-order: unspecified` 为 HashMap。
 *   BTreeMap 与 IndexMap 在契约里不可区分，默认按插入序（`mapOrder` 可改为 sorted）。
 * - `x-rust: serde_json::Value` 或空 schema = Value；`format: date-time` = DateTime<Utc>。
 * - `oneOf` / 多分支 `anyOf` = 依序结构匹配（外部标记 enum 的字符串 / 单键对象、内部标记的 const tag 分支）。
 * - `x-unresolved`：抽取器未能确定的形状，使用时报错。
 */
import { RustShapeError, type IntKind, type MapOrder, type RustSchema, type SkipIf } from './api.ts';
import { rs } from './schema.ts';

type Json = Record<string, unknown>;

export interface ContractResolver {
  /** `$ref`（`file.json#/$defs/X` 或 `#/$defs/X`）相对 `base` 文件解析；找不到返回 undefined。 */
  resolve(ref: string, base: string): { schema: unknown; base: string } | undefined;
}

/** 由已读入的契约文件（文件名 → 文档）构造解析器；平台代码不读文件，调用方负责加载。 */
export function contractResolver(documents: Readonly<Record<string, unknown>>): ContractResolver {
  return {
    resolve(ref, base) {
      const hash = ref.indexOf('#');
      const file = hash <= 0 ? (hash === 0 ? base : ref) : ref.slice(0, hash);
      let node: unknown = documents[file];
      const pointer = hash < 0 ? '' : ref.slice(hash + 1);
      for (const raw of pointer.split('/').slice(1)) {
        if (typeof node !== 'object' || node === null) return undefined;
        node = (node as Json)[raw.replaceAll('~1', '/').replaceAll('~0', '~')];
      }
      return node === undefined ? undefined : { schema: node, base: file };
    },
  };
}

export interface FromContractOptions {
  readonly resolver: ContractResolver;
  /** 顶层 schema 所在的契约文件名（解析 `#/$defs/...`）。 */
  readonly base: string;
  /** 非标准 `x-skip-serializing-if` 谓词（如 `ApkgMediaReport::is_empty`）。 */
  readonly skipPredicates?: Readonly<Record<string, (value: unknown) => boolean>>;
  /** 无 x-key-order 的 map（BTreeMap / IndexMap 不可区分）采用的顺序。默认 insertion。 */
  readonly mapOrder?: Exclude<MapOrder, 'unspecified'>;
  /** 允许反序列化形状的对象 schema（无 additionalProperties）；默认在使用时报错。 */
  readonly allowDeserializeForm?: boolean;
}

const STANDARD_SKIPS: Readonly<Record<string, SkipIf>> = {
  'Option::is_none': 'none',
  'Vec::is_empty': 'empty',
  'HashMap::is_empty': 'empty',
  'std::collections::HashMap::is_empty': 'empty',
  'BTreeMap::is_empty': 'empty',
  'String::is_empty': 'empty',
  is_false: 'false',
  is_zero: 'zero',
};

const INT_KINDS = new Set<IntKind>(['u8', 'u16', 'u32', 'u64', 'u128', 'usize', 'i8', 'i16', 'i32', 'i64', 'i128', 'isize']);

const failing = (name: string, message: string): RustSchema => rs.custom(name, () => { throw new RustShapeError('$', message); }, () => false);

/** 契约 JSON Schema → RustSchema（`$ref` 惰性解析，支持递归类型）。 */
export function fromContractSchema(schema: unknown, options: FromContractOptions): RustSchema {
  const cache = new Map<string, RustSchema>();

  const skipRule = (name: string): SkipIf => {
    const standard = STANDARD_SKIPS[name];
    if (standard !== undefined) return standard;
    const custom = options.skipPredicates?.[name];
    if (custom) return custom;
    return () => { throw new RustShapeError('$', `skip_serializing_if = "${name}" needs a predicate (FromContractOptions.skipPredicates)`); };
  };

  const ref = (target: string, base: string): RustSchema => {
    const found = options.resolver.resolve(target, base);
    if (!found) return failing(target, `unresolved $ref ${target} (from ${base})`);
    const key = `${found.base}${target.slice(target.indexOf('#'))}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const lazy = rs.lazy(key, () => convert(found.schema, found.base));
    cache.set(key, lazy);
    return lazy;
  };

  const object = (s: Json, base: string): RustSchema => {
    // 序列化形状总带 additionalProperties（false 或 flatten map 的 schema）；没有它的是反序列化形状
    // （`X__De` 或只作命令参数的类型），其中不记录 skip_serializing_if，不能用来推出 Rust 的输出。
    if (!Object.hasOwn(s, 'additionalProperties') && !options.allowDeserializeForm) {
      return failing('deserialize-form', `${String(s['x-rust'] ?? 'object')} is a deserialization-form contract schema (skip_serializing_if not recorded); describe the Rust struct with rs.struct`);
    }
    const properties = (s.properties ?? {}) as Record<string, Json>;
    const required = new Set((s.required ?? []) as string[]);
    const fields: Record<string, ReturnType<typeof rs.field>> = {};
    for (const [key, prop] of Object.entries(properties)) {
      const field = convert(prop, base);
      const skip = typeof prop['x-skip-serializing-if'] === 'string' ? skipRule(prop['x-skip-serializing-if']) : undefined;
      if (skip !== undefined) fields[key] = rs.field(field, { skipIf: skip });
      else if (prop['x-option'] === 'omit' || (!required.has(key) && prop['x-option'] !== 'null')) fields[key] = rs.field(field, { skipIf: 'none' });
      else fields[key] = rs.field(field);
    }
    const extra = s.additionalProperties;
    if (extra !== undefined && extra !== false) {
      // flatten map：struct 自身字段之外的键（抽取器在合并层给出）。
      fields['\u0000rest'] = rs.field(map(s, base), { flatten: true });
    }
    return rs.struct(fields, typeof s['x-rust'] === 'string' ? { name: s['x-rust'] } : {});
  };

  const map = (s: Json, base: string): RustSchema => {
    const names = s.propertyNames as Json | undefined;
    const keyKind = typeof names?.['x-key'] === 'string' && INT_KINDS.has(names['x-key'] as IntKind) ? names['x-key'] as IntKind : 'string';
    const value = s.additionalProperties === true || s.additionalProperties === undefined ? rs.value() : convert(s.additionalProperties, base);
    const order: MapOrder = s['x-key-order'] === 'unspecified' ? 'unspecified' : options.mapOrder ?? 'insertion';
    return { kind: 'map', key: keyKind, value, order };
  };

  const convert = (input: unknown, base: string): RustSchema => {
    // `{}` / 只有注释性 x-* 关键字：任意 JSON（serde_json::Value 或抽取器未细化的外部类型）。
    if (input === true || (typeof input === 'object' && input !== null && Object.keys(input).every((k) => k.startsWith('x-') && k !== 'x-unresolved'))) return rs.value();
    if (input === false || typeof input !== 'object' || input === null) return failing('false', 'schema `false` admits no value');
    const s = input as Json;
    if (typeof s['x-unresolved'] === 'string') return failing('x-unresolved', `contract shape unresolved: ${s['x-unresolved']}`);
    if (typeof s.$ref === 'string') return ref(s.$ref, base);
    const serdeWith = typeof s['x-serde-with'] === 'string' ? s['x-serde-with'] : '';
    if (serdeWith.startsWith('serialize_option_string_as_string')) {
      return rs.custom('serialize_option_string_as_string', (v) => {
        if (v == null) return '""';
        if (typeof v !== 'string') throw new RustShapeError('$', `expected Option<String>, got ${typeof v}`);
        return JSON.stringify(v);
      }, (v) => v == null || typeof v === 'string');
    }
    if (s['x-rust'] === 'serde_json::Value') return rs.value();
    if (Object.hasOwn(s, 'const')) return rs.literal(s.const);
    if (Array.isArray(s.enum)) return rs.literal(...s.enum);
    const branches = (s.oneOf ?? (s.properties === undefined ? s.anyOf : undefined)) as unknown[] | undefined;
    if (Array.isArray(branches)) {
      const nonNull = branches.filter((b) => !(typeof b === 'object' && b !== null && (b as Json).type === 'null' && Object.keys(b).length === 1));
      if (nonNull.length === branches.length - 1 && nonNull.length === 1) return rs.option(convert(nonNull[0], base));
      return rs.union(...branches.map((b) => convert(b, base)));
    }
    const type = s.type;
    if (Array.isArray(type)) {
      const rest = type.filter((t) => t !== 'null');
      const one = (t: unknown) => convert({ ...s, type: t }, base);
      const inner = rest.length === 1 ? one(rest[0]) : rs.union(...rest.map(one));
      return type.includes('null') ? rs.option(inner) : inner;
    }
    switch (type) {
      case 'null': return rs.unit;
      case 'boolean': return rs.bool;
      case 'string': return s.format === 'date-time' ? rs.dateTimeUtc : rs.string;
      case 'integer': return { kind: 'int', int: INT_KINDS.has(s['x-int'] as IntKind) ? s['x-int'] as IntKind : 'i64' };
      case 'number': return s['x-float'] === 'f32' ? rs.f32 : rs.f64;
      case 'array':
        if (Array.isArray(s.prefixItems)) return rs.tuple(...s.prefixItems.map((item) => convert(item, base)));
        return rs.vec(s.items === undefined ? rs.value() : convert(s.items, base));
      case 'object':
        return s.properties === undefined && s.additionalProperties !== false ? map(s, base) : object(s, base);
      default:
        if (s.properties !== undefined) return object(s, base);
        return failing(String(type), `unsupported contract schema ${JSON.stringify(s).slice(0, 120)}`);
    }
  };

  return convert(schema, options.base);
}
