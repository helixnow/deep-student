/**
 * serde_json 反序列化错误文案的模拟器。
 *
 * Tauri 把参数反序列化失败的 `serde_json::Error` 原样拼进 `invalid args ...` 字符串（errors.ts），
 * 所以前端看到的 detail 部分是 serde 的 Display。本模块按契约 schema 走一遍值，复现 serde 在
 * **能确定**的情形下产出的第一条错误；遇到无法确定的形状（untagged/复杂 tagged enum、flatten、
 * tuple、以数组表示的 struct 等）返回 `unknown`，由调用方回退到 ajv 的校验结果。
 *
 * 依据（版本取自 src-tauri/Cargo.lock：serde 1.0.228、serde_json 1.0.149）：
 * - 桌面构建的 serde_json 开启了 `preserve_order` 与 `arbitrary_precision`（src-tauri/Cargo.toml:101，
 *   各 crate Cargo.toml 中"app 图里 starlark 打开了 arbitrary_precision"的说明）。
 *   因此 Value 中对象键按前端 JSON 顺序迭代，数字的 `Unexpected` 为 `Other("number")`
 *   （serde_json-1.0.149/src/number.rs:809-813），显示为 `number`。
 * - `invalid type: {unexp}, expected {exp}` / `invalid value: ...`：serde_json-1.0.149/src/error.rs:439-456；
 *   `null` 与浮点的显示：error.rs:465-478（浮点用 zmij 格式化）。
 * - 数字访问顺序（u64 → i64 → u128 → i128 → f64）：serde_json-1.0.149/src/number.rs:549-570。
 * - 整数越界 `Unexpected::Unsigned/Signed`、128 位越界 `Unexpected::Other("u128"/"i128")`：
 *   serde_core-1.0.228/src/de/impls.rs（int_to_int / num_128 宏，:466-481）。
 * - `missing field`/`unknown field`/`unknown variant` 与 OneOf 列表格式：serde_core-1.0.228/src/de/mod.rs:252-291、:2333-2355。
 * - enum 给了非字符串非对象：serde_json-1.0.149/src/value/de.rs `deserialize_enum` 的 `"string or map"`。
 */
import type { JsonSchema } from './contract.ts';

/** Only native numeric raw atoms, never a business object with a rawJSON key. */
export function isJsonNumberAtom(value: unknown): value is Readonly<{ rawJSON: string }> {
  return (JSON as typeof JSON & { isRawJSON?(value: unknown): boolean }).isRawJSON?.(value) === true
    && /^-?\d/.test((value as { rawJSON: string }).rawJSON);
}

export type SerdeCheck = { ok: true } | { ok: false; detail: string } | { ok: 'unknown' };

/** 解析 `$ref`：返回目标 schema 与它所在文档的 base（用于继续解析嵌套的相对引用）。 */
export interface SchemaRefResolver {
  resolve(ref: string, base: string): { schema: JsonSchema | boolean; base: string } | undefined;
}

const OK: SerdeCheck = { ok: true };
const UNKNOWN: SerdeCheck = { ok: 'unknown' };

const INT_RANGES: Record<string, [bigint, bigint]> = {
  u8: [0n, 255n],
  u16: [0n, 65535n],
  u32: [0n, 4294967295n],
  u64: [0n, 18446744073709551615n],
  usize: [0n, 18446744073709551615n],
  u128: [0n, 340282366920938463463374607431768211455n],
  i8: [-128n, 127n],
  i16: [-32768n, 32767n],
  i32: [-2147483648n, 2147483647n],
  i64: [-9223372036854775808n, 9223372036854775807n],
  isize: [-9223372036854775808n, 9223372036854775807n],
  i128: [-170141183460469231731687303715884105728n, 170141183460469231731687303715884105727n],
};

const U64_MAX = 18446744073709551615n;
const I64_MIN = -9223372036854775808n;
const U128_MAX = 340282366920938463463374607431768211455n;
const I128_MIN = -170141183460469231731687303715884105728n;

/**
 * 按 zmij（serde_json 1.0.149 的浮点格式化）规则输出 f64：
 * 十进制指数在 [-5, 15] 内用定点表示（整数值补 `.0`），否则 `d.ddde+X` / `de-X`
 * （zmij-1.0.21/src/lib.rs:1064-1135）。有效数字取最短往返表示（与 JS `toExponential()` 相同）。
 */
export function formatF64(value: number): string {
  const exp = value.toExponential();
  const neg = exp.startsWith('-');
  const [mantissa = '', expPart = '0'] = (neg ? exp.slice(1) : exp).split('e');
  const digits = mantissa.replace('.', '');
  const e = Number(expPart);
  const len = digits.length;
  let out: string;
  if (e >= -5 && e <= 15) {
    if (len - 1 <= e) out = digits + '0'.repeat(e - (len - 1)) + '.0';
    else if (e >= 0) out = `${digits.slice(0, e + 1)}.${digits.slice(e + 1)}`;
    else out = `0.${'0'.repeat(-e - 1)}${digits}`;
  } else {
    out = digits[0] + (len > 1 ? `.${digits.slice(1)}` : '') + 'e' + (e < 0 ? '-' : '+') + String(Math.abs(e));
  }
  return neg ? `-${out}` : out;
}

/** Rust `{:?}` 对 `&str` 的转义（core::char::escape_debug 的近似：控制字符、格式字符与未分配码位用 `\u{..}`）。 */
export function rustDebugString(value: string): string {
  let out = '"';
  for (const ch of value) {
    switch (ch) {
      case '"': out += '\\"'; break;
      case '\\': out += '\\\\'; break;
      case '\n': out += '\\n'; break;
      case '\r': out += '\\r'; break;
      case '\t': out += '\\t'; break;
      case '\0': out += '\\0'; break;
      default:
        if (/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u.test(ch)) {
          out += `\\u{${ch.codePointAt(0)!.toString(16)}}`;
        } else {
          out += ch;
        }
    }
  }
  return out + '"';
}

/** serde_json Value 的 `Unexpected` 显示（arbitrary_precision 下数字为 `number`）。 */
export function unexpectedOf(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return `boolean \`${value}\``;
  if (typeof value === 'number' || typeof value === 'bigint' || isJsonNumberAtom(value)) return 'number';
  if (typeof value === 'string') return `string ${rustDebugString(value)}`;
  if (Array.isArray(value)) return 'sequence';
  return 'map';
}

function invalidType(value: unknown, expected: string): SerdeCheck {
  return { ok: false, detail: `invalid type: ${unexpectedOf(value)}, expected ${expected}` };
}

export function oneOf(names: readonly string[]): string {
  if (names.length === 1) return `\`${names[0]}\``;
  if (names.length === 2) return `\`${names[0]}\` or \`${names[1]}\``;
  return `one of ${names.map((n) => `\`${n}\``).join(', ')}`;
}

/** `dstu_vfs::types::VfsResource<T>` → `VfsResource`。 */
function rustTypeName(path: unknown): string | undefined {
  if (typeof path !== 'string' || !path) return undefined;
  const base = path.replace(/<.*$/s, '');
  const segments = base.split('::');
  return segments[segments.length - 1] || undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isJsonNumberAtom(value);
}

/**
 * 契约生成器的反序列化 unit enum（scripts/electron-migration/contracts/lib/schema.ts:867-871）是
 * `oneOf: [{type:'string', enum}, ...每个变体一支 {"<Variant>": null}]`，`x-rust`/`x-also-accepts` 在外层。
 * 只认这个精确形状并折叠成单个 enum schema；`#[serde(other)]`（字符串分支无 enum）等其余形状返回 undefined。
 */
function unitEnumOf(s: JsonSchema): JsonSchema | undefined {
  if (!s['x-also-accepts'] || 'enum' in s || 'anyOf' in s || !Array.isArray(s.oneOf)) return undefined;
  const [strings, ...maps] = s.oneOf as (JsonSchema | boolean)[];
  if (!isPlainObject(strings) || strings.type !== 'string' || !Array.isArray(strings.enum)
    || Object.keys(strings).some(key => key !== 'type' && key !== 'enum')) return undefined;
  const variants = strings.enum;
  if (!variants.every(v => typeof v === 'string') || maps.length !== variants.length) return undefined;
  const isUnitMap = (map: JsonSchema | boolean, name: string): boolean => {
    if (!isPlainObject(map) || map.type !== 'object' || map.additionalProperties !== false
      || Object.keys(map).some(key => !['type', 'properties', 'required', 'additionalProperties'].includes(key))) return false;
    const { properties, required } = map;
    if (!Array.isArray(required) || required.length !== 1 || required[0] !== name
      || !isPlainObject(properties) || Object.keys(properties).length !== 1) return false;
    const field = properties[name];
    return isPlainObject(field) && Object.keys(field).length === 1 && field.type === 'null';
  };
  if (!maps.every((map, i) => isUnitMap(map, variants[i] as string))) return undefined;
  return { type: 'string', enum: variants, 'x-rust': s['x-rust'], 'x-also-accepts': s['x-also-accepts'] };
}

/** 整数参数：模拟 serde_json Number::deserialize_any 的访问顺序与 primitive visitor 的越界文案。 */
function checkInteger(value: unknown, kind: string): SerdeCheck {
  const range = INT_RANGES[kind];
  if (!range) return UNKNOWN;
  // &Value → Number::deserialize_i*/u* parses the retained decimal text directly
  // with arbitrary_precision (number.rs:592-598), not deserialize_any's visitor.
  if (isJsonNumberAtom(value)) {
    if (!/^-?\d+$/.test(value.rawJSON)) return { ok: false, detail: 'invalid number' };
    const big = BigInt(value.rawJSON);
    return big >= range[0] && big <= range[1] ? OK : { ok: false, detail: 'invalid number' };
  }
  if (typeof value !== 'number') return invalidType(value, kind);
  if (!Number.isFinite(value)) return UNKNOWN;
  if (!Number.isInteger(value)) {
    return { ok: false, detail: `invalid type: floating point \`${formatF64(value)}\`, expected ${kind}` };
  }
  const big = BigInt(value);
  if (big >= range[0] && big <= range[1]) return OK;
  if (big >= I64_MIN && big <= U64_MAX) {
    return { ok: false, detail: `invalid value: integer \`${big.toString()}\`, expected ${kind}` };
  }
  // JSON 文本：|v| < 1e21 时 JS 输出完整整数字面量，serde 走 u128/i128；否则输出指数形式，走 f64。
  if (Math.abs(value) < 1e21) {
    if (big > 0n && big <= U128_MAX) return { ok: false, detail: `invalid value: u128, expected ${kind}` };
    if (big < 0n && big >= I128_MIN) return { ok: false, detail: `invalid value: i128, expected ${kind}` };
  }
  return { ok: false, detail: `invalid type: floating point \`${formatF64(value)}\`, expected ${kind}` };
}

interface Frame {
  base: string;
  resolver: SchemaRefResolver;
  depth: number;
}

/**
 * 对 `value` 按 `schema` 模拟 serde 反序列化，返回第一条错误（或 `unknown`）。
 * `base` 是 schema 所在文档的 URI，用于解析相对 `$ref`。
 */
export function serdeCheck(schema: JsonSchema | boolean, value: unknown, base: string, resolver: SchemaRefResolver): SerdeCheck {
  return check(schema, value, { base, resolver, depth: 0 });
}

function check(schema: JsonSchema | boolean, value: unknown, frame: Frame): SerdeCheck {
  if (frame.depth > 64) return UNKNOWN;
  if (schema === true) return OK;
  if (schema === false) return UNKNOWN;
  const s = schema;

  if (typeof s.$ref === 'string') {
    const target = frame.resolver.resolve(s.$ref, frame.base);
    if (!target) return UNKNOWN;
    return check(target.schema, value, { ...frame, base: target.base, depth: frame.depth + 1 });
  }

  for (const key of ['allOf', 'not', 'if', 'prefixItems', 'patternProperties', 'dependentSchemas', 'unevaluatedProperties']) {
    if (key in s) return UNKNOWN;
  }

  const unitEnum = unitEnumOf(s);
  if (unitEnum) return check(unitEnum, value, { ...frame, depth: frame.depth + 1 });

  const alternatives = (s.anyOf ?? s.oneOf) as (JsonSchema | boolean)[] | undefined;
  if (Array.isArray(alternatives)) {
    // `Option<T>`：一支为 null，另一支为 T。
    const isNull = (b: JsonSchema | boolean) => typeof b === 'object' && b.type === 'null' && Object.keys(b).every((k) => k === 'type' || k.startsWith('x-') || k === 'description');
    const nonNull = alternatives.filter((b) => !isNull(b));
    if (alternatives.length === 2 && nonNull.length === 1) {
      if (value === null) return OK;
      return check(nonNull[0]!, value, { ...frame, depth: frame.depth + 1 });
    }
    return checkInternalStructEnum(s, value, frame);
  }

  let type = s.type;
  if (Array.isArray(type)) {
    const nonNull = type.filter((t) => t !== 'null');
    if (type.includes('null') && value === null) return OK;
    if (nonNull.length !== 1) return UNKNOWN;
    type = nonNull[0];
  }

  const xInt = s['x-int'];
  const xFloat = s['x-float'];
  const typeName = rustTypeName(s['x-rust']);

  if (Array.isArray(s.enum)) {
    const variants = s.enum;
    if (variants.some((v) => v === value)) return OK;
    if (!typeName || !variants.every((v) => typeof v === 'string')) return UNKNOWN;
    if (typeof value === 'string') {
      return {
        ok: false,
        detail: variants.length === 0
          ? `unknown variant \`${value}\`, there are no variants`
          : `unknown variant \`${value}\`, expected ${oneOf(variants as string[])}`,
      };
    }
    if (isPlainObject(value) && s['x-also-accepts']) {
      const keys = Object.keys(value);
      if (keys.length !== 1) return { ok: false, detail: 'invalid value: map, expected map with a single key' };
      const variant = keys[0]!;
      if (!variants.includes(variant)) return check(s, variant, frame);
      return value[variant] === null ? OK : invalidType(value[variant], 'unit');
    }
    if (isPlainObject(value)) return UNKNOWN;
    return invalidType(value, 'string or map');
  }

  if ('const' in s) return value === s.const ? OK : UNKNOWN;

  if (typeof xInt === 'string') return checkInteger(value, xInt);
  if (typeof xFloat === 'string') {
    if (typeof value === 'number' || isJsonNumberAtom(value)) return OK;
    return invalidType(value, xFloat);
  }

  switch (type) {
    case 'null':
      return value === null ? OK : invalidType(value, 'unit');
    case 'boolean':
      return typeof value === 'boolean' ? OK : invalidType(value, 'a boolean');
    case 'string': {
      const rust = s['x-rust'];
      // serde_core-1.0.228/src/de/impls.rs：PathBufVisitor 的 expecting 为 "path string"；
      // char 经 serde_json `deserialize_char` → 字符串，长度不为 1 时 `invalid_value(Unexpected::Str, "a character")`。
      if (rust === 'std::PathBuf' || rust === 'std::Path') return typeof value === 'string' ? OK : invalidType(value, 'path string');
      if (rust === 'char') {
        if (typeof value !== 'string') return invalidType(value, 'a character');
        return [...value].length === 1 ? OK : { ok: false, detail: `invalid value: string ${rustDebugString(value)}, expected a character` };
      }
      return typeof value === 'string' ? OK : invalidType(value, 'a string');
    }
    case 'integer':
    case 'number':
      return typeof value === 'number' ? OK : UNKNOWN;
    case 'array': {
      if (!Array.isArray(value)) return invalidType(value, 'a sequence');
      const items = s.items as JsonSchema | boolean | undefined;
      if (items === undefined) return OK;
      for (const item of value) {
        const r = check(items, item, { ...frame, depth: frame.depth + 1 });
        if (r.ok !== true) return r;
      }
      return OK;
    }
    case 'object':
    case undefined:
      return checkObject(s, value, typeName, frame, type === 'object');
    default:
      return UNKNOWN;
  }
}

/** Only the extractor's unambiguous strict internal struct-variant shape:
 * schema.ts:837-877 emits external objects with one key, adjacent objects with
 * at most two, and untagged unions as anyOf. Requiring >2 fields in every branch
 * deliberately leaves the ambiguous cases on the existing UNKNOWN path.
 */
function checkInternalStructEnum(s: JsonSchema, value: unknown, frame: Frame): SerdeCheck {
  if (s.anyOf || !Array.isArray(s.oneOf) || s.oneOf.length < 2 || !rustTypeName(s['x-rust'])) return UNKNOWN;
  let tag: string | undefined;
  const branches = new Map<string, JsonSchema>();
  for (const alternative of s.oneOf) {
    if (!isPlainObject(alternative) || alternative.type !== 'object' || alternative.additionalProperties !== false
      || !isPlainObject(alternative.properties) || !Array.isArray(alternative.required)
      || Object.keys(alternative).some(key => !['type', 'properties', 'required', 'additionalProperties'].includes(key))) return UNKNOWN;
    const properties = alternative.properties;
    const names = Object.keys(properties);
    if (names.length <= 2) return UNKNOWN;
    const key = names[0]!;
    const discriminator = properties[key];
    if (!isPlainObject(discriminator) || Object.keys(discriminator).length !== 1
      || typeof discriminator.const !== 'string' || !alternative.required.includes(key)
      || (tag !== undefined && tag !== key) || branches.has(discriminator.const)) return UNKNOWN;
    tag = key;
    branches.set(discriminator.const, alternative);
  }
  if (tag === undefined || Array.isArray(value)) return UNKNOWN;
  // TaggedContentVisitor buffers *all* content before decoding the variant.
  // Number::deserialize_any / ContentVisitor differ from direct &Value numeric
  // decoding (including u128 rejection). Do not invent first errors for them.
  if (!nonNumericContent(value, frame.depth)) return UNKNOWN;
  if (!isPlainObject(value)) return invalidType(value, `internally tagged enum ${rustTypeName(s['x-rust'])}`);
  if (!Object.hasOwn(value, tag)) return { ok: false, detail: `missing field \`${tag}\`` };
  const variant = value[tag];
  if (typeof variant !== 'string') return invalidType(variant, 'variant identifier');
  const branch = branches.get(variant);
  if (!branch) return { ok: false, detail: `unknown variant \`${variant}\`, expected ${oneOf([...branches.keys()])}` };
  // serde_derive enum_internally.rs:54-61 strips the tag. struct_.rs:55-65,
  // 122-130 builds FIELDS from variant fields alone, in declaration order.
  const properties = Object.fromEntries(Object.entries(branch.properties as Record<string, JsonSchema>).filter(([key]) => key !== tag));
  const content = Object.fromEntries(Object.entries(value).filter(([key]) => key !== tag));
  return checkObject({ ...branch, properties }, content, undefined, { ...frame, depth: frame.depth + 1 }, true);
}

function nonNumericContent(value: unknown, depth: number): boolean {
  if (depth > 64 || typeof value === 'number' || typeof value === 'bigint' || isJsonNumberAtom(value)) return false;
  if (value !== null && typeof value === 'object') return Object.values(value).every(item => nonNumericContent(item, depth + 1));
  return true;
}

/** Deserialization-only normalization. Never widens output schemas or mutates raw Request payload. */
export function normalizeUnitEnums(schema: JsonSchema | boolean, value: unknown, base: string, resolver: SchemaRefResolver): unknown {
  if (typeof schema === 'boolean') return value;
  if (typeof schema.$ref === 'string') {
    const target = resolver.resolve(schema.$ref, base);
    return target ? normalizeUnitEnums(target.schema, value, target.base, resolver) : value;
  }
  const unitEnum = unitEnumOf(schema);
  if (unitEnum) return normalizeUnitEnums(unitEnum, value, base, resolver);
  if (schema['x-also-accepts'] && Array.isArray(schema.enum) && isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && schema.enum.includes(keys[0]) && value[keys[0]!] === null) return keys[0];
  }
  const alternatives = (schema.anyOf ?? schema.oneOf) as (JsonSchema | boolean)[] | undefined;
  if (alternatives) for (const branch of alternatives) {
    const normalized = normalizeUnitEnums(branch, value, base, resolver);
    if (serdeCheck(branch, normalized, base, resolver).ok === true) return normalized;
  }
  if (Array.isArray(value)) {
    const tuple = schema.prefixItems as JsonSchema[] | undefined;
    return value.map((item, i) => normalizeUnitEnums(tuple?.[i] ?? schema.items as JsonSchema | boolean ?? true, item, base, resolver));
  }
  if (isPlainObject(value)) {
    const properties = schema.properties as Record<string, JsonSchema> | undefined;
    const additional = schema.additionalProperties as JsonSchema | boolean | undefined;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeUnitEnums(properties?.[key] ?? additional ?? true, item, base, resolver)]));
  }
  return value;
}

function checkObject(s: JsonSchema, value: unknown, typeName: string | undefined, frame: Frame, explicitObject: boolean): SerdeCheck {
  const properties = s.properties as Record<string, JsonSchema | boolean> | undefined;
  const additional = s.additionalProperties as JsonSchema | boolean | undefined;

  if (properties && typeof properties === 'object') {
    // struct
    if (!isPlainObject(value)) {
      if (Array.isArray(value) || !typeName) return UNKNOWN; // serde 允许以序列表示 struct，不模拟
      return invalidType(value, `struct ${typeName}`);
    }
    const names = Object.keys(properties);
    for (const [key, fieldValue] of Object.entries(value)) {
      const field = properties[key];
      if (field === undefined) {
        if (additional === false) {
          return {
            ok: false,
            detail: names.length === 0 ? `unknown field \`${key}\`, there are no fields` : `unknown field \`${key}\`, expected ${oneOf(names)}`,
          };
        }
        continue;
      }
      const r = check(field, fieldValue, { ...frame, depth: frame.depth + 1 });
      if (r.ok !== true) return r;
    }
    const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
    for (const name of names) {
      if (required.has(name) && !Object.hasOwn(value, name)) return { ok: false, detail: `missing field \`${name}\`` };
    }
    return OK;
  }

  if (additional !== undefined && typeof additional === 'object') {
    // map
    if (!isPlainObject(value)) return invalidType(value, 'a map');
    for (const entry of Object.values(value)) {
      const r = check(additional, entry, { ...frame, depth: frame.depth + 1 });
      if (r.ok !== true) return r;
    }
    return OK;
  }

  if (!explicitObject) {
    // 没有类型约束的 schema（如 serde_json::Value 的 `{}`）
    const constraining = Object.keys(s).filter((k) => !k.startsWith('x-') && !['description', 'title', '$comment', 'default', 'examples', '$defs', '$id', '$schema'].includes(k));
    return constraining.length === 0 ? OK : UNKNOWN;
  }
  return isPlainObject(value) ? OK : UNKNOWN;
}
