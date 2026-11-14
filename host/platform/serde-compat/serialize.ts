/**
 * `toRustJson(value, schema)`：按 schema 输出与 `serde_json::to_string(&rust_value)` 逐字节相同的文本。
 * `toRustValue(value, schema)`：同一份输出在前端 `JSON.parse` 之后的形状（IPC 返回值用）。
 *
 * 规则来源见 tests/serialize.test.ts 头注释（serde_derive ser.rs、serde_json ser.rs、zmij、chrono）。
 */
import { parseJsonDocument, type JsonNode } from '../util/json-exact.ts';
import { parseChronoDateTimeUtc, toRfc3339Opts } from '../time/index.ts';
import {
  RustShapeError, type FieldSpec, type IntKind, type RustJsonOptions, type RustSchema, type SkipIf, type VariantSpec,
} from './api.ts';
import { describe, formatF32, formatF64, formatValueNumber, isNumberAtom, toInteger } from './number.ts';
import { renameField, renameVariant } from './schema.ts';

interface Ctx {
  readonly pretty: boolean;
  /** 选择 untagged / union 分支的试写：结构体不接受多余键。 */
  readonly strict: boolean;
}

type StructSchema = Extract<RustSchema, { kind: 'struct' }>;
type Entry = readonly [key: string, text: string];

const indent = (depth: number) => '  '.repeat(depth);

function renderArray(items: readonly string[], depth: number, ctx: Ctx): string {
  if (!ctx.pretty) return `[${items.join(',')}]`;
  if (items.length === 0) return '[]';
  return `[\n${items.map((item) => indent(depth + 1) + item).join(',\n')}\n${indent(depth)}]`;
}

function renderObject(entries: readonly Entry[], depth: number, ctx: Ctx): string {
  if (!ctx.pretty) return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${v}`).join(',')}}`;
  if (entries.length === 0) return '{}';
  return `{\n${entries.map(([k, v]) => `${indent(depth + 1)}${JSON.stringify(k)}: ${v}`).join(',\n')}\n${indent(depth)}}`;
}

const isObjectLike = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Map) && !(v instanceof Date) && !isNumberAtom(v);

const own = (obj: Record<string, unknown>, key: string): unknown => (Object.hasOwn(obj, key) ? obj[key] : undefined);

function resolve(schema: RustSchema): RustSchema {
  let s = schema;
  while (s.kind === 'lazy') s = s.get();
  return s;
}

/** 缺键时仍有 Rust 值（None / unit / 自定义写出）的类型。 */
function acceptsMissing(schema: RustSchema): boolean {
  const s = resolve(schema);
  if (s.kind === 'option' || s.kind === 'unit' || s.kind === 'custom') return true;
  if (s.kind === 'union') return s.branches.some(acceptsMissing);
  return false;
}

function isEmpty(v: unknown): boolean {
  if (typeof v === 'string' || Array.isArray(v)) return v.length === 0;
  if (v instanceof Map) return v.size === 0;
  if (isObjectLike(v)) return Object.keys(v).length === 0;
  return false;
}

function shouldSkip(rule: SkipIf, v: unknown): boolean {
  switch (rule) {
    case 'none': return v === null || v === undefined;
    case 'empty': return isEmpty(v);
    case 'false': return v === false;
    case 'zero': return v === 0 || v === 0n || (isNumberAtom(v) && Number(v.rawJSON) === 0);
    default: return rule(v);
  }
}

// ------------------------------------------------------------------ map keys

/** UTF-16 字符串按 Unicode 码点（= UTF-8 字节序，即 Rust `String: Ord`）比较。 */
function compareCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x === y) continue;
    if (x >= 0xd800 && y >= 0xd800) {
      // 代理项（码点 >= U+10000）要排在 U+E000..U+FFFF 之后。
      x = x >= 0xe000 ? x - 0x800 : x + 0x2000;
      y = y >= 0xe000 ? y - 0x800 : y + 0x2000;
    }
    return x - y;
  }
  return a.length - b.length;
}

function mapEntries(value: unknown, path: string): (readonly [unknown, unknown])[] {
  if (value instanceof Map) return [...value.entries()];
  if (isObjectLike(value)) return Object.entries(value);
  throw new RustShapeError(path, `expected map, got ${describe(value)}`);
}

function mapKey(key: unknown, kind: 'string' | IntKind, path: string): { text: string; order: string | bigint } {
  if (kind === 'string') {
    if (typeof key !== 'string') throw new RustShapeError(path, `expected string map key, got ${describe(key)}`);
    return { text: key, order: key };
  }
  const raw = typeof key === 'string' && /^-?\d+$/.test(key) ? BigInt(key) : key;
  if (typeof key === 'string' && typeof raw === 'string') throw new RustShapeError(path, `expected ${kind} map key, got "${key}"`);
  const big = toInteger(kind, raw, path);
  return { text: big.toString(), order: big };
}

// ------------------------------------------------------------------ struct

/** 结构体（含 flatten 展开）在输入对象上认领的属性名；`rest` 为 flatten map（认领其余全部）。 */
function claimedNames(schema: StructSchema): { names: Set<string>; rest: boolean } {
  const names = new Set<string>();
  let rest = false;
  for (const [name, spec] of schema.fields) {
    if (spec.flatten) {
      const inner = unwrapFlatten(spec.schema);
      if (inner.kind === 'struct') {
        const sub = claimedNames(inner);
        for (const n of sub.names) names.add(n);
        rest ||= sub.rest;
      } else rest = true;
    } else names.add(spec.from ?? spec.rename ?? renameField(name, schema.renameAll));
  }
  return { names, rest };
}

function unwrapFlatten(schema: RustSchema): RustSchema {
  const s = resolve(schema);
  return s.kind === 'option' ? resolve(s.inner) : s;
}

function structEntries(obj: Record<string, unknown>, schema: StructSchema, path: string, depth: number, ctx: Ctx, siblings: ReadonlySet<string>): Entry[] {
  const entries: Entry[] = [];
  const all = claimedNames(schema);
  const claimed = new Set([...siblings, ...all.names]);
  for (const [name, spec] of schema.fields) {
    if (spec.flatten) {
      entries.push(...flattenEntries(obj, spec, path, depth, ctx, claimed));
      continue;
    }
    const wire = spec.rename ?? renameField(name, schema.renameAll);
    const prop = spec.from ?? wire;
    const fieldPath = `${path}.${prop}`;
    const v = own(obj, prop);
    if (spec.skipIf !== undefined && (v === undefined || shouldSkip(spec.skipIf, v))) continue;
    if (v === undefined && !acceptsMissing(spec.schema)) throw new RustShapeError(fieldPath, 'missing required field');
    entries.push([wire, write(v, spec.schema, fieldPath, depth + 1, ctx)]);
  }
  if ((schema.unknown === 'error' || ctx.strict) && !all.rest) {
    for (const key of Object.keys(obj)) {
      if (obj[key] !== undefined && !claimed.has(key)) throw new RustShapeError(`${path}.${key}`, `unknown field for ${schema.name ?? 'struct'}`);
    }
  }
  return entries;
}

function flattenEntries(obj: Record<string, unknown>, spec: FieldSpec, path: string, depth: number, ctx: Ctx, claimed: ReadonlySet<string>): Entry[] {
  const inner = unwrapFlatten(spec.schema);
  if (inner.kind === 'struct') return structEntries(obj, inner, path, depth, ctx, claimed);
  if (inner.kind === 'map' || inner.kind === 'value' || inner.kind === 'value-object') {
    const entries: Entry[] = [];
    for (const [key, v] of Object.entries(obj)) {
      if (claimed.has(key) || v === undefined) continue;
      const child = inner.kind === 'map' ? inner.value : inner.kind === 'value-object' ? (inner.fields.find(([k]) => k === key)?.[1] ?? inner.rest) : inner;
      if (inner.kind === 'map') mapKey(key, inner.key, `${path}.${key}`);
      entries.push([key, write(v, child, `${path}.${key}`, depth + 1, ctx)]);
    }
    return entries;
  }
  throw new RustShapeError(path, `flatten of ${inner.kind} is not supported by serde`);
}

// ------------------------------------------------------------------ enum

type EnumSchema = Extract<RustSchema, { kind: 'enum' }>;

function variants(schema: EnumSchema): Map<string, VariantSpec> {
  return new Map(schema.variants.map(([name, spec]) => [spec.rename ?? renameVariant(name, schema.renameAll), spec]));
}

function variantOf(schema: EnumSchema, wire: unknown, path: string): VariantSpec {
  const spec = typeof wire === 'string' ? variants(schema).get(wire) : undefined;
  if (!spec) throw new RustShapeError(path, `unknown variant ${JSON.stringify(wire)} of ${schema.name ?? 'enum'} (expected one of ${[...variants(schema).keys()].join(', ')})`);
  return spec;
}

function writeEnum(value: unknown, schema: EnumSchema, path: string, depth: number, ctx: Ctx): string {
  const repr = schema.repr;
  switch (repr.kind) {
    case 'external': {
      if (typeof value === 'string') {
        const spec = variantOf(schema, value, path);
        if (spec.schema !== null) throw new RustShapeError(path, `variant "${value}" carries data`);
        return JSON.stringify(value);
      }
      const keys = isObjectLike(value) ? Object.keys(value).filter((k) => value[k] !== undefined) : [];
      if (keys.length !== 1) throw new RustShapeError(path, `expected externally tagged ${schema.name ?? 'enum'} (string or single-key object), got ${describe(value)}`);
      const wire = keys[0]!;
      const spec = variantOf(schema, wire, path);
      const payload = (value as Record<string, unknown>)[wire];
      if (spec.schema === null) {
        if (payload !== null) throw new RustShapeError(`${path}.${wire}`, 'unit variant carries data');
        return JSON.stringify(wire);
      }
      return renderObject([[wire, write(payload, spec.schema, `${path}.${wire}`, depth + 1, ctx)]], depth, ctx);
    }
    case 'internal': {
      if (!isObjectLike(value)) throw new RustShapeError(path, `expected internally tagged object, got ${describe(value)}`);
      const wire = value[repr.tag];
      const spec = variantOf(schema, wire, `${path}.${repr.tag}`);
      const head: Entry = [repr.tag, JSON.stringify(wire)];
      if (spec.schema === null) return renderObject([head], depth, ctx);
      const inner = resolve(spec.schema);
      if (inner.kind === 'struct') return renderObject([head, ...structEntries(value, inner, path, depth, ctx, new Set([repr.tag]))], depth, ctx);
      if (inner.kind === 'map' || inner.kind === 'value' || inner.kind === 'value-object') {
        return renderObject([head, ...flattenEntries(value, { schema: inner, flatten: true }, path, depth, ctx, new Set([repr.tag]))], depth, ctx);
      }
      throw new RustShapeError(path, 'internally tagged newtype variant must contain a struct or map');
    }
    case 'adjacent': {
      if (!isObjectLike(value)) throw new RustShapeError(path, `expected adjacently tagged object, got ${describe(value)}`);
      const wire = value[repr.tag];
      const spec = variantOf(schema, wire, `${path}.${repr.tag}`);
      const head: Entry = [repr.tag, JSON.stringify(wire)];
      if (spec.schema === null) return renderObject([head], depth, ctx);
      return renderObject([head, [repr.content, write(value[repr.content], spec.schema, `${path}.${repr.content}`, depth + 1, ctx)]], depth, ctx);
    }
    case 'untagged':
      return firstMatch(value, schema.variants.map(([, spec]) => spec.schema ?? { kind: 'unit' }), path, depth, ctx, schema.name ?? 'untagged enum');
  }
}

/** 第一个能写出的分支：先不容忍多余键，再放宽。 */
function firstMatch(value: unknown, branches: readonly RustSchema[], path: string, depth: number, ctx: Ctx, what: string): string {
  for (const strict of [true, false]) {
    for (const branch of branches) {
      if (resolve(branch).kind === 'unit' && value != null) continue;
      try {
        return write(value, branch, path, depth, { ...ctx, strict });
      } catch (error) {
        if (!(error instanceof RustShapeError || error instanceof RangeError)) throw error;
      }
    }
  }
  throw new RustShapeError(path, `${describe(value)} matches no variant of ${what}`);
}

// ------------------------------------------------------------------ value / chrono

function writeValue(value: unknown, path: string, depth: number, ctx: Ctx, integralFloats: 'int' | 'float'): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'bigint' || isNumberAtom(value)) return formatValueNumber(value, integralFloats);
  if (Array.isArray(value)) return renderArray(value.map((item, i) => writeValue(item, `${path}[${i}]`, depth + 1, ctx, integralFloats)), depth, ctx);
  if (value instanceof Map || isObjectLike(value)) {
    const entries: Entry[] = [];
    for (const [key, item] of mapEntries(value, path)) {
      if (item === undefined) continue;
      if (typeof key !== 'string') throw new RustShapeError(path, `serde_json::Value keys must be strings, got ${describe(key)}`);
      entries.push([key, writeValue(item, `${path}.${key}`, depth + 1, ctx, integralFloats)]);
    }
    return renderObject(entries, depth, ctx);
  }
  throw new RustShapeError(path, `not representable as serde_json::Value: ${describe(value)}`);
}

const NS_PER_MS = 1_000_000n;

function epochNanos(value: unknown, path: string): bigint {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) throw new RustShapeError(path, 'invalid Date');
    return BigInt(ms) * NS_PER_MS;
  }
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value) * NS_PER_MS;
  if (typeof value === 'string') {
    const parsed = parseChronoDateTimeUtc(value);
    if (parsed) return parsed.epochNanos;
  }
  throw new RustShapeError(path, `expected DateTime<Utc> (Date, epoch ms number, epoch ns bigint or RFC 3339 text), got ${describe(value)}`);
}

const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/;

function naiveNanos(value: unknown, path: string): bigint {
  if (typeof value !== 'string') return epochNanos(value, path);
  const m = NAIVE.exec(value);
  if (m) {
    const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
    const date = new Date(0);
    date.setUTCFullYear(y, mo - 1, d);
    date.setUTCHours(h, mi, s, 0);
    if (date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d && date.getUTCHours() === h && date.getUTCMinutes() === mi) {
      return BigInt(date.getTime()) * NS_PER_MS + BigInt((m[7] ?? '').padEnd(9, '0') || '0');
    }
  }
  throw new RustShapeError(path, `expected NaiveDateTime text, got ${JSON.stringify(value)}`);
}

// ------------------------------------------------------------------ dispatcher

function write(value: unknown, schema: RustSchema, path: string, depth: number, ctx: Ctx): string {
  if (value === undefined && schema.kind === 'union' && acceptsMissing(schema)) value = null;
  switch (schema.kind) {
    case 'lazy': return write(value, schema.get(), path, depth, ctx);
    case 'unit':
      if (value != null) throw new RustShapeError(path, `expected unit (null), got ${describe(value)}`);
      return 'null';
    case 'option': return value == null ? 'null' : write(value, schema.inner, path, depth, ctx);
    case 'custom': return schema.write(value);
    default:
      if (value === undefined) throw new RustShapeError(path, 'missing value');
  }
  switch (schema.kind) {
    case 'bool':
      if (typeof value !== 'boolean') throw new RustShapeError(path, `expected bool, got ${describe(value)}`);
      return value ? 'true' : 'false';
    case 'string':
      if (typeof value !== 'string') throw new RustShapeError(path, `expected string, got ${describe(value)}`);
      return JSON.stringify(value);
    case 'char':
      if (typeof value !== 'string' || [...value].length !== 1) throw new RustShapeError(path, `expected char, got ${describe(value)}`);
      return JSON.stringify(value);
    case 'int': return toInteger(schema.int, value, path).toString();
    case 'float': return schema.float === 'f32' ? formatF32(value as number, path) : formatF64(value as number, path);
    case 'seq':
      if (!Array.isArray(value)) throw new RustShapeError(path, `expected sequence, got ${describe(value)}`);
      return renderArray(value.map((item, i) => write(item, schema.items, `${path}[${i}]`, depth + 1, ctx)), depth, ctx);
    case 'tuple':
      if (!Array.isArray(value) || value.length !== schema.items.length) throw new RustShapeError(path, `expected tuple of ${schema.items.length}, got ${describe(value)}`);
      return renderArray(schema.items.map((item, i) => write(value[i], item, `${path}[${i}]`, depth + 1, ctx)), depth, ctx);
    case 'map': {
      const rows = mapEntries(value, path)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => ({ key: mapKey(k, schema.key, path), v }));
      if (schema.order === 'sorted') {
        rows.sort((a, b) => (typeof a.key.order === 'bigint'
          ? (a.key.order < (b.key.order as bigint) ? -1 : a.key.order > (b.key.order as bigint) ? 1 : 0)
          : compareCodePoints(a.key.order, b.key.order as string)));
      }
      return renderObject(rows.map(({ key, v }) => [key.text, write(v, schema.value, `${path}.${key.text}`, depth + 1, ctx)] as const), depth, ctx);
    }
    case 'struct':
      if (!isObjectLike(value)) throw new RustShapeError(path, `expected ${schema.name ?? 'struct'} object, got ${describe(value)}`);
      return renderObject(structEntries(value, schema, path, depth, ctx, new Set()), depth, ctx);
    case 'enum': return writeEnum(value, schema, path, depth, ctx);
    case 'literal':
      if (!schema.values.some((v) => Object.is(v, value))) throw new RustShapeError(path, `expected one of ${schema.values.map((v) => JSON.stringify(v)).join(', ')}, got ${describe(value)}`);
      return writeValue(value, path, depth, ctx, 'int');
    case 'union': return firstMatch(value, schema.branches, path, depth, ctx, 'union');
    case 'value': return writeValue(value, path, depth, ctx, schema.integralFloats ?? 'int');
    case 'value-object': {
      const fields = new Map(schema.fields);
      const entries: Entry[] = [];
      for (const [key, item] of mapEntries(value, path)) {
        if (item === undefined) continue;
        if (typeof key !== 'string') throw new RustShapeError(path, `map keys must be strings, got ${describe(key)}`);
        entries.push([key, write(item, fields.get(key) ?? schema.rest, `${path}.${key}`, depth + 1, ctx)]);
      }
      return renderObject(entries, depth, ctx);
    }
    case 'datetime': return JSON.stringify(toRfc3339Opts(epochNanos(value, path), 'AutoSi', true, 0));
    case 'naive-datetime': return JSON.stringify(toRfc3339Opts(naiveNanos(value, path), 'AutoSi', true, 0).slice(0, -1));
  }
}

/**
 * DB 写入入口：`serde_json::to_string(&value)`（`pretty` 时 `to_string_pretty`）的字节。
 * 输入为线上形状（见 api.ts）；与 schema 不符时抛 {@link RustShapeError}（含 `$.a[0]` 路径），整数越界抛 RangeError。
 */
export function toRustJson(value: unknown, schema: RustSchema, options: RustJsonOptions = {}): string {
  return write(value, schema, '$', 0, { pretty: options.pretty === true, strict: false });
}

function toJs(node: JsonNode): unknown {
  switch (node.kind) {
    case 'null': return null;
    case 'bool': case 'string': return node.value;
    case 'number': {
      const n = node.value;
      if (n.kind === 'u64' || n.kind === 'i64') return n.value >= -(2n ** 53n) + 1n && n.value <= 2n ** 53n - 1n ? Number(n.value) : n.value;
      return n.kind === 'f64' ? n.value : Number(n.raw);
    }
    case 'array': return node.items.map(toJs);
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const { key, value } of node.members) {
        Object.defineProperty(out, key, { value: toJs(value), enumerable: true, configurable: true, writable: true });
      }
      return out;
    }
  }
}

/**
 * IPC 返回值：Rust 输出被前端 `JSON.parse` 后的值（键序、缺省键、null、f32 最短十进制）。
 * 超过 2^53 的整数保留为 bigint，由 kernel `toWireJson` 在线上边界按 serde_json 语义转换。
 */
export function toRustValue(value: unknown, schema: RustSchema): unknown {
  return toJs(parseJsonDocument(toRustJson(value, schema)));
}
