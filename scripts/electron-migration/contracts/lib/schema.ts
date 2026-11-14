// 类型语义解析（RType → Sem）与 serde 序列化形状（Sem → JSON Schema 2020-12）。
//
// 依据（均为 ~/.cargo/registry/src/*/ 下工作区 Cargo.lock 锁定的版本）：
// - serde_derive-1.0.228：src/internals/attr.rs（属性）、ast.rs（rename 规则应用顺序）、
//   de.rs `expr_is_missing`（缺字段：default > 容器 default > deserialize_with 报错 > missing_field，
//   后者只对 `deserialize_option` 返回 None，即 Option<T>）、ser.rs（各种 enum 表示）；
// - serde_core-1.0.228 src/ser/impls.rs：Duration {secs,nanos}、SystemTime
//   {secs_since_epoch,nanos_since_epoch}、Path/PathBuf → str、OsStr → {"Unix": [u8]}/{"Windows": [u16]}；
// - serde_json-1.0.149 src/ser.rs：非有限浮点输出 null；`MapKeySerializer` 只接受
//   str / 单元变体 / newtype / bool / 整数 / 有限浮点 / char 作为对象键（转为字符串）；
// - chrono-0.4.41：DateTime → RFC 3339（SecondsFormat::AutoSi，UTC 写 Z），NaiveDateTime/NaiveDate
//   → Debug 格式，NaiveTime → Display，TimeDelta → (i64 秒, i32 纳秒) 元组；
// - uuid-1.20.0：human-readable 序列化为小写连字符字符串；ulid-1.2.1 → 26 字符串；url-2.5.8 → 字符串。
import { applyToField, applyToVariant, SERDE_RULES, type SerdeRenameRule } from './case.ts';
import { metaStr, parseMetaList, type Meta } from './attrs.ts';
import { extKey, type Resolver } from './resolve.ts';
import type { Attr, Def, EnumDef, FieldDef, FnDef, RType, Scope, StructDef } from './model.ts';
import type { JsonSchema } from '../../../../host/kernel/contract.ts';

export type Dir = 'ser' | 'de';

export type Sem =
  | { k: 'prim'; name: string }
  | { k: 'def'; def: StructDef | EnumDef; args: Sem[] }
  | { k: 'ext'; key: string; path: string; args: Sem[] }
  | { k: 'tuple'; elems: Sem[] }
  | { k: 'array'; elem: Sem; len: string }
  | { k: 'slice'; elem: Sem }
  | { k: 'unit' }
  | { k: 'never' }
  | { k: 'generic'; name: string }
  | { k: 'unres'; why: string };

export interface TyCtx { scope: Scope; env: Map<string, Sem>; self: Sem | null }

const INTS = new Set(['u8', 'u16', 'u32', 'u64', 'u128', 'usize', 'i8', 'i16', 'i32', 'i64', 'i128', 'isize']);
const FLOATS = new Set(['f32', 'f64']);
export const PRIMS = new Set([...INTS, ...FLOATS, 'bool', 'char', 'str']);

export function semKey(s: Sem): string {
  switch (s.k) {
    case 'prim': return s.name;
    case 'def': return `${s.def.id}@${s.def.loc.line}${s.args.length ? `<${s.args.map(semKey).join(',')}>` : ''}`;
    case 'ext': return `${s.key}${s.args.length ? `<${s.args.map(semKey).join(',')}>` : ''}`;
    case 'tuple': return `(${s.elems.map(semKey).join(',')})`;
    case 'array': return `[${semKey(s.elem)};${s.len}]`;
    case 'slice': return `[${semKey(s.elem)}]`;
    case 'unit': return '()';
    case 'never': return '!';
    case 'generic': return `?${s.name}`;
    case 'unres': return `!unres(${s.why})`;
  }
}

export function semText(s: Sem): string {
  switch (s.k) {
    case 'prim': return s.name;
    case 'def': return `${defRustPath(s.def)}${s.args.length ? `<${s.args.map(semText).join(', ')}>` : ''}`;
    case 'ext': return `${s.path}${s.args.length ? `<${s.args.map(semText).join(', ')}>` : ''}`;
    case 'tuple': return `(${s.elems.map(semText).join(', ')})`;
    case 'array': return `[${semText(s.elem)}; ${s.len}]`;
    case 'slice': return `[${semText(s.elem)}]`;
    case 'unit': return '()';
    case 'never': return '!';
    case 'generic': return s.name;
    case 'unres': return '?';
  }
}

export function defRustPath(d: Def): string {
  const m = /\{fn ([A-Za-z0-9_]+)#/.exec(d.scope.id);
  return [d.scope.crate, ...d.scope.path, ...(m ? [`{fn ${m[1]}}`] : []), d.name].join('::');
}

export function rtypeText(t: RType): string {
  switch (t.k) {
    case 'path': return (t.global ? '::' : '') + t.segs.map((s) => s.name + (s.args.length ? `<${s.args.map(rtypeText).join(', ')}>` : '')).join('::');
    case 'ref': return `&${rtypeText(t.inner)}`;
    case 'tuple': return `(${t.elems.map(rtypeText).join(', ')})`;
    case 'array': return `[${rtypeText(t.elem)}; ${t.len}]`;
    case 'slice': return `[${rtypeText(t.elem)}]`;
    case 'unit': return '()';
    case 'never': return '!';
    case 'other': return t.text;
  }
}

// ======================================================================== RType → Sem

export class TypeResolver {
  readonly r: Resolver;
  constructor(r: Resolver) { this.r = r; }

  sem(t: RType, ctx: TyCtx, depth = 0): Sem {
    if (depth > 64) return { k: 'unres', why: `type alias recursion too deep at ${rtypeText(t)}` };
    switch (t.k) {
      case 'ref': return this.sem(t.inner, ctx, depth + 1);
      case 'tuple': return { k: 'tuple', elems: t.elems.map((e) => this.sem(e, ctx, depth + 1)) };
      case 'array': return { k: 'array', elem: this.sem(t.elem, ctx, depth + 1), len: t.len };
      case 'slice': return { k: 'slice', elem: this.sem(t.elem, ctx, depth + 1) };
      case 'unit': return { k: 'unit' };
      case 'never': return { k: 'never' };
      case 'other': return { k: 'unres', why: `unsupported type syntax (${t.why}): ${t.text.slice(0, 120)}` };
      case 'path': break;
    }
    const segs = t.segs;
    const last = segs[segs.length - 1]!;
    if (!t.global && segs.length === 1) {
      const g = ctx.env.get(last.name);
      if (g) return g;
      if (last.name === 'Self') return ctx.self ?? { k: 'unres', why: '`Self` outside impl' };
      if (PRIMS.has(last.name) && !last.args.length) return { k: 'prim', name: last.name };
    }
    if (segs[0]!.name === 'Self') return { k: 'unres', why: `associated type ${rtypeText(t)}` };
    const names = t.global ? ['::', ...segs.map((s) => s.name)] : segs.map((s) => s.name);
    const res = this.r.resolvePathRes(names, ctx.scope, 'type');
    const args = last.args.map((a) => this.sem(a, ctx, depth + 1));
    if (!res.length) return { k: 'unres', why: `cannot resolve type path \`${rtypeText(t)}\` in ${ctx.scope.id}` };
    if (res.length > 1) {
      const locs = res.map((x) => (x.k === 'def' ? `${x.def.loc.file}:${x.def.loc.line}` : x.k === 'ext' ? x.path.join('::') : x.k)).join(', ');
      return { k: 'unres', why: `ambiguous type path \`${rtypeText(t)}\` → ${res.length} candidates (${locs})` };
    }
    const r = res[0]!;
    if (r.k === 'ext') {
      const key = extKey(r.path);
      // anyhow-1.x src/lib.rs：`pub type Result<T, E = Error> = core::result::Result<T, E>;`
      if (key === 'anyhow::Result') return { k: 'ext', key: 'std::Result', path: 'std::result::Result', args: [args[0] ?? { k: 'unres', why: 'anyhow::Result without T' }, args[1] ?? { k: 'ext', key: 'anyhow::Error', path: 'anyhow::Error', args: [] }] };
      return { k: 'ext', key, path: r.path.join('::'), args };
    }
    if (r.k !== 'def') return { k: 'unres', why: `\`${rtypeText(t)}\` is not a type (${r.k})` };
    const d = r.def;
    if (d.kind === 'struct' || d.kind === 'enum') return { k: 'def', def: d, args };
    if (d.kind === 'alias') {
      const env = new Map<string, Sem>();
      d.generics.forEach((g, i) => { if (args[i]) env.set(g, args[i]!); });
      return this.sem(d.ty, { scope: d.scope, env, self: null }, depth + 1);
    }
    return { k: 'unres', why: `\`${rtypeText(t)}\` resolves to a ${d.kind}` };
  }
}

// ======================================================================== serde 属性

interface Pair<T> { ser: T; de: T }

export interface ContainerAttrs {
  renameAll: Pair<SerdeRenameRule | null>;
  renameAllFields: Pair<SerdeRenameRule | null>;
  tag: string | null;
  content: string | null;
  untagged: boolean;
  transparent: boolean;
  denyUnknown: boolean;
  default: boolean;
  unsupported: string[];
  derives: Set<string>;
}

export interface FieldAttrs {
  rename: Pair<string | null>;
  renameAll: Pair<SerdeRenameRule | null>;
  aliases: string[];
  default: boolean;
  skip: boolean;
  skipSer: boolean;
  skipDe: boolean;
  skipSerIf: string | null;
  flatten: boolean;
  serWith: string | null;
  deWith: string | null;
  other: boolean;
  untagged: boolean;
  unsupported: string[];
}

function serdeMetas(attrs: Attr[]): Meta[] {
  const out: Meta[] = [];
  for (const a of attrs) {
    if (a.meta?.kind === 'list' && a.meta.path === 'serde') for (const m of parseMetaList(a.meta.toks)) if (m) out.push(m);
  }
  return out;
}

function rule(v: string | null, bad: string[]): SerdeRenameRule | null {
  if (v === null) return null;
  if ((SERDE_RULES as readonly string[]).includes(v)) return v as SerdeRenameRule;
  bad.push(`unknown rename rule ${v}`);
  return null;
}

function pairOf(m: Meta, bad: string[]): Pair<string | null> {
  if (m.kind === 'nv') { const v = metaStr(m); return { ser: v, de: v }; }
  if (m.kind === 'list') {
    const p: Pair<string | null> = { ser: null, de: null };
    for (const x of parseMetaList(m.toks)) {
      if (x?.kind === 'nv' && x.path === 'serialize') p.ser = metaStr(x);
      else if (x?.kind === 'nv' && x.path === 'deserialize') p.de = metaStr(x);
      else bad.push(`${m.path}(...) form`);
    }
    return p;
  }
  bad.push(`${m.path} without value`);
  return { ser: null, de: null };
}

export function derivesOf(attrs: Attr[]): Set<string> {
  const out = new Set<string>();
  for (const a of attrs) {
    if (a.meta?.kind === 'list' && a.meta.path === 'derive') {
      for (const m of parseMetaList(a.meta.toks)) if (m) out.add(m.path.split('::').pop()!);
    }
  }
  return out;
}

export function containerAttrs(attrs: Attr[]): ContainerAttrs {
  const c: ContainerAttrs = {
    renameAll: { ser: null, de: null }, renameAllFields: { ser: null, de: null }, tag: null, content: null,
    untagged: false, transparent: false, denyUnknown: false, default: false, unsupported: [], derives: derivesOf(attrs),
  };
  for (const m of serdeMetas(attrs)) {
    switch (m.path) {
      case 'rename_all': { const p = pairOf(m, c.unsupported); c.renameAll = { ser: rule(p.ser, c.unsupported), de: rule(p.de, c.unsupported) }; break; }
      case 'rename_all_fields': { const p = pairOf(m, c.unsupported); c.renameAllFields = { ser: rule(p.ser, c.unsupported), de: rule(p.de, c.unsupported) }; break; }
      case 'tag': c.tag = metaStr(m); break;
      case 'content': c.content = metaStr(m); break;
      case 'untagged': c.untagged = true; break;
      case 'transparent': c.transparent = true; break;
      case 'deny_unknown_fields': c.denyUnknown = true; break;
      case 'default': c.default = true; break;
      // 不影响 JSON 形状：
      case 'rename': case 'bound': case 'crate': case 'expecting': break;
      default: c.unsupported.push(`container attribute \`${m.path}\``);
    }
  }
  return c;
}

export function fieldAttrs(attrs: Attr[]): FieldAttrs {
  const f: FieldAttrs = {
    rename: { ser: null, de: null }, renameAll: { ser: null, de: null }, aliases: [], default: false, skip: false, skipSer: false,
    skipDe: false, skipSerIf: null, flatten: false, serWith: null, deWith: null, other: false, untagged: false, unsupported: [],
  };
  for (const m of serdeMetas(attrs)) {
    switch (m.path) {
      case 'rename': f.rename = pairOf(m, f.unsupported); break;
      case 'rename_all': { const p = pairOf(m, f.unsupported); f.renameAll = { ser: rule(p.ser, f.unsupported), de: rule(p.de, f.unsupported) }; break; }
      case 'alias': { const v = metaStr(m); if (v) f.aliases.push(v); break; }
      case 'default': f.default = true; break;
      case 'skip': f.skip = true; break;
      case 'skip_serializing': f.skipSer = true; break;
      case 'skip_deserializing': f.skipDe = true; break;
      case 'skip_serializing_if': f.skipSerIf = metaStr(m); break;
      case 'flatten': f.flatten = true; break;
      case 'with': { const v = metaStr(m); f.serWith = v ? `${v}::serialize` : null; f.deWith = v ? `${v}::deserialize` : null; break; }
      case 'serialize_with': f.serWith = metaStr(m); break;
      case 'deserialize_with': f.deWith = metaStr(m); break;
      case 'other': f.other = true; break;
      case 'untagged': f.untagged = true; break;
      case 'borrow': case 'bound': break;
      default: f.unsupported.push(`field attribute \`${m.path}\``);
    }
  }
  return f;
}

// ======================================================================== Schema 构建

export interface UnresItem { reason: string; file: string; line: number }

export interface DefInstance {
  key: string;
  def: StructDef | EnumDef;
  args: Sem[];
  dir: Dir;
  rustName: string;
  schema: JsonSchema | null;
  refs: Set<string>;
  unresolved: UnresItem[];
}

export interface Owner { refs: Set<string>; unresolved: UnresItem[]; file: string; line: number }

export const REF_PREFIX = 'def:';

/** 自定义 serialize_with / deserialize_with 函数：按函数体（去空白）逐字匹配已读过的实现。 */
interface KnownWith { body: string; dir: Dir; describe: string; shape: (fieldSem: Sem, b: SchemaBuilder) => JsonSchema | null }

const norm = (s: string): string => s.replace(/\s+/g, '').replace(/,\}/g, '}');

const KNOWN_WITH: KnownWith[] = [
  {
    // crates/dstu-agent/src/chat_v2/types.rs `deserialize_optional_value`、automations.rs
    // `deserialize_optional_nullable`：Option<Option<T>>，出现键即 Some(内层)，null → Some(None)。
    body: norm('{ Option::<T>::deserialize(deserializer).map(Some) }'),
    dir: 'de',
    describe: 'present key → Some(Option<T>) (null → Some(None))',
    shape: (s, b) => (s.k === 'ext' && s.key === 'std::Option' && s.args[0] ? b.schema(s.args[0], 'de') : null),
  },
  {
    // crates/dstu-vfs/src/vfs/types.rs `serialize_option_string_as_string`：None → ""。
    body: norm('{ match value { Some(s) => serializer.serialize_str(s), None => serializer.serialize_str(""), } }'),
    dir: 'ser',
    describe: 'Option<String> serialized as string (None → "")',
    shape: () => ({ type: 'string' }),
  },
  {
    // crates/dstu-anki/src/apkg_exporter_service.rs `serialize_id_as_number`：可解析为 i64 则输出整数，否则原字符串。
    body: norm('{ if let Ok(n) = id.parse::<i64>() { serializer.serialize_i64(n) } else { serializer.serialize_str(id) } }'),
    dir: 'ser',
    describe: 'string id serialized as i64 when parseable, else as string',
    shape: () => ({ anyOf: [{ type: 'integer', 'x-int': 'i64' }, { type: 'string' }] }),
  },
];

/**
 * serde_json-1.0.149 src/ser.rs:155-179：f32/f64 的 NaN、±∞ 序列化为 `null`。
 * 仅登记已经核实会在出站 IPC/事件中出现的字段；键为 `defRustPath(owner).字段名`。
 * 只影响序列化方向：反序列化仍按 Rust 类型只接受 JSON number，不随此表放宽。
 */
const SERDE_JSON_NULL_FLOATS = new Set([
  // crates/dstu-vfs/src/vfs/pdf_processing_service.rs:235 `pub percent: f32`。
  // f32 溢出（如数据库中的 1e40 → ∞）由 serde 输出 null，命令与事件均为成功响应。
  'dstu_vfs::vfs::pdf_processing_service::ProcessingProgress.percent',
]);

function serdeJsonFloatSchema(owner: StructDef | EnumDef, f: FieldDef, dir: Dir, schema: JsonSchema): JsonSchema {
  if (dir !== 'ser' || !SERDE_JSON_NULL_FLOATS.has(`${defRustPath(owner)}.${f.name}`)) return schema;
  if (typeof schema['x-float'] !== 'string') return schema;
  return { anyOf: [schema, { type: 'null' }] };
}

function intSchema(name: string): JsonSchema {
  const s: JsonSchema = { type: 'integer', 'x-int': name as JsonSchema['x-int'] };
  const bits = name === 'usize' || name === 'isize' ? 64 : Number(name.slice(1));
  if (name.startsWith('u')) {
    s.minimum = 0;
    if (bits <= 32) s.maximum = 2 ** bits - 1;
  } else if (bits <= 32) {
    s.minimum = -(2 ** (bits - 1));
    s.maximum = 2 ** (bits - 1) - 1;
  }
  return s;
}

const isOption = (s: Sem): boolean => s.k === 'ext' && s.key === 'std::Option';

const STRINGISH = new Set(['std::String', 'std::PathBuf', 'std::Path', 'uuid::Uuid', 'ulid::Ulid', 'url::Url', 'std::str']);
const TRANSPARENT = new Set(['std::Box', 'std::Rc', 'std::Arc', 'std::Cow', 'std::RefCell', 'std::Cell', 'std::Mutex', 'std::RwLock', 'std::Reverse', 'std::Wrapping', 'std::Saturating']);
const SEQS = new Set(['std::Vec', 'std::VecDeque', 'std::LinkedList', 'std::BinaryHeap', 'smallvec::SmallVec']);
const SETS = new Set(['std::HashSet', 'std::BTreeSet', 'indexmap::IndexSet', 'dashmap::DashSet']);
const MAPS = new Set(['std::HashMap', 'std::BTreeMap', 'indexmap::IndexMap', 'serde_json::Map', 'dashmap::DashMap']);
const NONZERO = /^std::NonZero(U|I)(8|16|32|64|128|size)$/;
const ATOMIC = /^std::Atomic(U|I)(8|16|32|64|size)$/;

/** flatten 合并所需的字段集合（additionalProperties 在合并层统一决定）。 */
interface NamedParts {
  props: Record<string, JsonSchema>;
  required: string[];
  aliasReq: JsonSchema[];
  /** 仅来自 flatten map/Value 的额外键 schema；null 表示没有 map。 */
  mapAdditional: JsonSchema | boolean | null;
  /** 无法内联的 flatten 目标（x-unresolved 标记，不参与约束）。 */
  unresolvedFlat: JsonSchema[];
}

export class SchemaBuilder {
  readonly tr: TypeResolver;
  readonly instances = new Map<string, DefInstance>();
  private owners: Owner[] = [];
  constructor(tr: TypeResolver) { this.tr = tr; }

  withOwner<T>(o: Owner, f: () => T): T {
    this.owners.push(o);
    try { return f(); } finally { this.owners.pop(); }
  }

  private get owner(): Owner { return this.owners[this.owners.length - 1]!; }

  unres(reason: string, loc?: { file: string; line: number }): JsonSchema {
    const o = this.owner;
    o.unresolved.push({ reason, file: loc?.file ?? o.file, line: loc?.line ?? o.line });
    return { 'x-unresolved': reason };
  }

  // ---------------------------------------------------------------- 入口

  schema(s: Sem, dir: Dir): JsonSchema {
    switch (s.k) {
      case 'unres': return this.unres(s.why);
      case 'generic': return this.unres(`unbound generic parameter \`${s.name}\``);
      case 'never': return { not: {} };
      case 'unit': return { type: 'null' };
      case 'prim':
        if (INTS.has(s.name)) return intSchema(s.name);
        if (FLOATS.has(s.name)) return { type: 'number', 'x-float': s.name as 'f32' | 'f64' };
        if (s.name === 'bool') return { type: 'boolean' };
        if (s.name === 'char') return { type: 'string', minLength: 1, maxLength: 2, 'x-rust': 'char' };
        return { type: 'string' };
      case 'tuple': return {
        type: 'array', prefixItems: s.elems.map((e) => this.schema(e, dir)), items: false, minItems: s.elems.length, maxItems: s.elems.length,
      };
      case 'array': {
        const n = Number(s.len);
        if (!Number.isInteger(n)) return this.unres(`array length \`${s.len}\` is not a literal`);
        return { type: 'array', items: this.schema(s.elem, dir), minItems: n, maxItems: n };
      }
      case 'slice': return { type: 'array', items: this.schema(s.elem, dir) };
      case 'ext': return this.extSchema(s, dir);
      case 'def': return this.ref(s.def, s.args, dir);
    }
  }

  private extSchema(s: Extract<Sem, { k: 'ext' }>, dir: Dir): JsonSchema {
    const a0 = s.args[0];
    const k = s.key;
    if (k === 'std::String' || k === 'std::str') return { type: 'string' };
    if (k === 'std::PathBuf' || k === 'std::Path') return { type: 'string', 'x-rust': s.path };
    if (TRANSPARENT.has(k)) {
      if (!a0) return this.unres(`${s.path} without type argument`);
      return this.schema(a0, dir);
    }
    if (k === 'std::Option') {
      if (!a0) return this.unres('Option without type argument');
      return { anyOf: [this.schema(a0, dir), { type: 'null' }], 'x-option': 'null' };
    }
    if (SEQS.has(k)) return a0 ? { type: 'array', items: this.schema(a0, dir) } : this.unres(`${s.path} without item type`);
    if (SETS.has(k)) return a0 ? { type: 'array', items: this.schema(a0, dir), uniqueItems: true } : this.unres(`${s.path} without item type`);
    if (MAPS.has(k)) {
      if (k === 'serde_json::Map' && !s.args.length) return { type: 'object', additionalProperties: {}, 'x-rust': 'serde_json::Map<String, Value>' };
      const kk = s.args[0];
      const vv = s.args[1];
      if (!kk || !vv) return this.unres(`${s.path} without key/value types`);
      const out: JsonSchema = { type: 'object', additionalProperties: this.schema(vv, dir) };
      const keyS = this.keySchema(kk);
      if (keyS) out.propertyNames = keyS;
      if (k === 'std::HashMap' || k === 'dashmap::DashMap') out['x-key-order'] = 'unspecified';
      return out;
    }
    if (k === 'std::Result') {
      const e = s.args[1];
      if (!a0 || !e) return this.unres('Result without type arguments (alias not resolved?)');
      return {
        oneOf: [
          { type: 'object', properties: { Ok: this.schema(a0, dir) }, required: ['Ok'], additionalProperties: false },
          { type: 'object', properties: { Err: this.schema(e, dir) }, required: ['Err'], additionalProperties: false },
        ],
      };
    }
    if (k === 'std::Duration') {
      return { type: 'object', properties: { secs: intSchema('u64'), nanos: intSchema('u32') }, required: ['secs', 'nanos'], additionalProperties: dir === 'ser' ? false : undefined, 'x-rust': 'std::time::Duration' };
    }
    if (k === 'std::SystemTime') {
      return { type: 'object', properties: { secs_since_epoch: intSchema('u64'), nanos_since_epoch: intSchema('u32') }, required: ['secs_since_epoch', 'nanos_since_epoch'], 'x-rust': 'std::time::SystemTime' };
    }
    if (k === 'std::PhantomData') return { type: 'null' };
    if (NONZERO.test(k)) { const m = NONZERO.exec(k)!; const s2 = intSchema(`${m[1]!.toLowerCase()}${m[2]}`); s2.not = { const: 0 }; return s2; }
    if (ATOMIC.test(k)) { const m = ATOMIC.exec(k)!; return intSchema(`${m[1]!.toLowerCase()}${m[2]}`); }
    if (k === 'std::AtomicBool') return { type: 'boolean' };
    if (k === 'std::OsString' || k === 'std::OsStr') return { oneOf: [{ type: 'object', properties: { Unix: { type: 'array', items: intSchema('u8') } }, required: ['Unix'] }, { type: 'object', properties: { Windows: { type: 'array', items: intSchema('u16') } }, required: ['Windows'] }], 'x-rust': s.path };
    if (k === 'std::IpAddr' || k === 'std::Ipv4Addr' || k === 'std::Ipv6Addr' || k === 'std::SocketAddr') return { type: 'string', 'x-rust': s.path };
    if (k === 'serde_json::Value') return { 'x-rust': 'serde_json::Value' };
    if (k === 'serde_json::Number') return { type: 'number', 'x-rust': 'serde_json::Number' };
    if (k === 'serde_json::RawValue') return { 'x-rust': 'serde_json::value::RawValue' };
    if (k === 'chrono::DateTime') {
      return { type: 'string', format: 'date-time', 'x-rust': `chrono::DateTime<${a0 ? semText(a0) : '?'}>`, 'x-format': dir === 'ser' ? 'RFC 3339, SecondsFormat::AutoSi, Z for UTC' : 'RFC 3339' };
    }
    if (k === 'chrono::NaiveDateTime') return { type: 'string', 'x-rust': 'chrono::NaiveDateTime', 'x-format': '%Y-%m-%dT%H:%M:%S%.f (Debug)' };
    if (k === 'chrono::NaiveDate') return { type: 'string', format: 'date', 'x-rust': 'chrono::NaiveDate', 'x-format': '%Y-%m-%d (Debug)' };
    if (k === 'chrono::NaiveTime') return { type: 'string', 'x-rust': 'chrono::NaiveTime', 'x-format': '%H:%M:%S%.f (Display)' };
    if (k === 'chrono::TimeDelta' || k === 'chrono::Duration') {
      return { type: 'array', prefixItems: [intSchema('i64'), intSchema('i32')], items: false, minItems: 2, maxItems: 2, 'x-rust': 'chrono::TimeDelta (secs, nanos)' };
    }
    if (k === 'uuid::Uuid') return { type: 'string', format: 'uuid', 'x-rust': 'uuid::Uuid' };
    if (k === 'ulid::Ulid') return { type: 'string', minLength: 26, maxLength: 26, 'x-rust': 'ulid::Ulid' };
    if (k === 'url::Url') return { type: 'string', format: 'uri', 'x-rust': 'url::Url' };
    if (k === 'bytes::Bytes' || k === 'bytes::BytesMut' || k === 'serde_bytes::ByteBuf' || k === 'serde_bytes::Bytes') return { type: 'array', items: intSchema('u8'), 'x-rust': s.path };
    return this.unres(`external type \`${s.path}\` (serde shape not modelled by the extractor)`);
  }

  /** serde_json MapKeySerializer 规则下的键 schema；字符串键返回 null。 */
  private keySchema(k: Sem): JsonSchema | null {
    if (k.k === 'prim') {
      if (k.name === 'str' || k.name === 'char') return null;
      if (INTS.has(k.name)) return { pattern: k.name.startsWith('u') ? '^[0-9]+$' : '^-?[0-9]+$', 'x-key': k.name };
      if (k.name === 'bool') return { enum: ['true', 'false'] };
      if (FLOATS.has(k.name)) return { 'x-key': k.name };
    }
    if (k.k === 'ext') {
      if (STRINGISH.has(k.key)) return null;
      if (TRANSPARENT.has(k.key) && k.args[0]) return this.keySchema(k.args[0]);
    }
    if (k.k === 'def') {
      const d = k.def;
      if (d.kind === 'enum') {
        const ca = containerAttrs(d.attrs);
        if (!ca.tag && !ca.untagged && d.variants.every((v) => v.form === 'unit')) {
          return { enum: d.variants.filter((v) => !fieldAttrs(v.attrs).skip).map((v) => fieldAttrs(v.attrs).rename.ser ?? applyToVariant(ca.renameAll.ser, v.name)) };
        }
      }
      if (d.kind === 'struct' && d.form === 'tuple' && d.fields.length === 1) {
        const env = new Map<string, Sem>();
        d.generics.forEach((g, i) => { if (k.args[i]) env.set(g, k.args[i]!); });
        return this.keySchema(this.tr.sem(d.fields[0]!.ty, { scope: d.scope, env, self: k }));
      }
    }
    return { 'x-unresolved': this.unres(`map key type \`${semText(k)}\` (serde_json only accepts string-like / integer / bool / char / unit-variant / newtype keys)`)['x-unresolved'] };
  }

  // ---------------------------------------------------------------- 具名定义

  ref(def: StructDef | EnumDef, args: Sem[], dir: Dir): JsonSchema {
    const key = `${def.id}@${def.loc.file}:${def.loc.line}${args.length ? `<${args.map(semKey).join(',')}>` : ''}|${dir}`;
    this.owner.refs.add(key);
    if (!this.instances.has(key)) {
      const inst: DefInstance = {
        key, def, args, dir, rustName: `${defRustPath(def)}${args.length ? `<${args.map(semText).join(', ')}>` : ''}`,
        schema: null, refs: new Set(), unresolved: [],
      };
      this.instances.set(key, inst);
      inst.schema = this.withOwner({ refs: inst.refs, unresolved: inst.unresolved, file: def.loc.file, line: def.loc.line }, () => this.defSchema(def, args, dir));
      inst.schema['x-rust'] = inst.rustName;
    }
    return { $ref: REF_PREFIX + key };
  }

  private ctxFor(def: StructDef | EnumDef, args: Sem[]): TyCtx {
    const env = new Map<string, Sem>();
    def.generics.forEach((g, i) => env.set(g, args[i] ?? { k: 'unres', why: `missing generic argument ${g}` }));
    return { scope: def.scope, env, self: { k: 'def', def, args } };
  }

  private defSchema(def: StructDef | EnumDef, args: Sem[], dir: Dir): JsonSchema {
    const ca = containerAttrs(def.attrs);
    const trait = dir === 'ser' ? 'Serialize' : 'Deserialize';
    if (!ca.derives.has(trait)) {
      // secret_prompt.rs:23: a newtype constructor after String deserialization
      // changes ownership/zeroization only, not the accepted JSON shape.
      if (dir === 'de' && def.kind === 'struct' && def.form === 'tuple' && def.fields.length === 1) {
        for (const scope of this.allScopes()) for (const im of scope.impls) {
          if (im.trait?.k !== 'path' || im.trait.segs.at(-1)?.name !== 'Deserialize' || im.selfTy.k !== 'path') continue;
          const targets = this.tr.r.resolvePathRes(im.selfTy.segs.map((s) => s.name), im.scope, 'type');
          if (targets.length !== 1 || targets[0]!.k !== 'def' || targets[0]!.def !== def) continue;
          const method = im.methods.find((m) => m.name === 'deserialize');
          const inner = this.fieldSem(def.fields[0]!, this.ctxFor(def, args));
          if (method && norm(method.bodyText) === norm('{ String::deserialize(deserializer).map(Self) }') && inner.k === 'ext' && inner.key === 'std::String') return { type: 'string' };
        }
      }
      const manual = this.manualImpl(def, trait);
      if (manual) return this.unres(`manual \`impl ${trait}\` for ${defRustPath(def)} at ${manual}`, { file: def.loc.file, line: def.loc.line });
      return this.unres(`${defRustPath(def)} has no #[derive(${trait})] and no impl ${trait} was found`, { file: def.loc.file, line: def.loc.line });
    }
    if (ca.unsupported.length) return this.unres(`${defRustPath(def)}: unsupported serde ${ca.unsupported.join(', ')}`);
    const ctx = this.ctxFor(def, args);
    if (def.kind === 'struct') return this.structSchema(def, ca, ctx, dir);
    return this.enumSchema(def, ca, ctx, dir);
  }

  private manualIndex: Map<Def, Map<string, string>> | null = null;

  /** 手写 `impl Serialize/Deserialize for X` 的位置。 */
  manualImpl(def: StructDef | EnumDef, trait: 'Serialize' | 'Deserialize'): string | null {
    if (!this.manualIndex) {
      this.manualIndex = new Map();
      for (const scope of this.allScopes()) {
        for (const im of scope.impls) {
          if (!im.trait || im.trait.k !== 'path' || im.selfTy.k !== 'path') continue;
          const tl = im.trait.segs[im.trait.segs.length - 1]!.name;
          if (tl !== 'Serialize' && tl !== 'Deserialize') continue;
          for (const t of this.tr.r.resolvePathRes(im.selfTy.segs.map((s) => s.name), im.scope, 'type')) {
            if (t.k !== 'def') continue;
            const m = this.manualIndex.get(t.def) ?? new Map<string, string>();
            m.set(tl, `${im.loc.file}:${im.loc.line}`);
            this.manualIndex.set(t.def, m);
          }
        }
      }
    }
    return this.manualIndex.get(def)?.get(trait) ?? null;
  }

  private scopesCache: Scope[] | null = null;
  allScopes(): Scope[] {
    if (this.scopesCache) return this.scopesCache;
    const out: Scope[] = [];
    const seen = new Set<Scope>();
    const visit = (s: Scope): void => {
      if (seen.has(s)) return;
      seen.add(s);
      out.push(s);
      for (const ds of s.defs.values()) for (const d of ds) {
        if (d.kind === 'mod') visit(d.scope);
        if (d.kind === 'fn' && d.bodyScope) visit(d.bodyScope);
      }
      for (const im of s.impls) for (const m of im.methods) if (m.bodyScope) visit(m.bodyScope);
    };
    for (const c of this.tr.r.ws.crates.values()) visit(c.scope);
    this.scopesCache = out;
    return out;
  }

  private fieldSem(f: FieldDef, ctx: TyCtx): Sem { return this.tr.sem(f.ty, ctx); }

  /** 应用 serialize_with / deserialize_with；不认识的函数报 x-unresolved。 */
  private withSchema(path: string, f: FieldDef, sem: Sem, ctx: TyCtx, dir: Dir, owner: StructDef | EnumDef): JsonSchema {
    const fnRes = this.tr.r.resolvePathRes(path.split('::'), ctx.scope, 'value');
    const fn = fnRes.length === 1 && fnRes[0]!.k === 'def' && fnRes[0]!.def.kind === 'fn' ? (fnRes[0]!.def as FnDef) : null;
    if (fn) {
      const body = norm(fn.bodyText);
      const known = KNOWN_WITH.find((k) => k.dir === dir && k.body === body);
      if (known) {
        const s = known.shape(sem, this);
        if (s) { s['x-serde-with'] = `${path}: ${known.describe}`; return s; }
      }
      return this.unres(`${dir === 'ser' ? 'serialize_with' : 'deserialize_with'} = "${path}" (${fn.loc.file}:${fn.loc.line}) is not a modelled implementation`, { file: owner.loc.file, line: f.line });
    }
    return this.unres(`${dir === 'ser' ? 'serialize_with' : 'deserialize_with'} = "${path}" could not be resolved`, { file: owner.loc.file, line: f.line });
  }

  private fieldValueSchema(f: FieldDef, fa: FieldAttrs, ctx: TyCtx, dir: Dir, owner: StructDef | EnumDef): { schema: JsonSchema; sem: Sem } {
    const sem = this.fieldSem(f, ctx);
    const w = dir === 'ser' ? fa.serWith : fa.deWith;
    if (w) return { schema: this.withSchema(w, f, sem, ctx, dir, owner), sem };
    const schema = this.schemaAt(sem, dir, { file: owner.loc.file, line: f.line });
    return { schema: serdeJsonFloatSchema(owner, f, dir, schema), sem };
  }

  /** 以字段位置作为未解析项的位置。 */
  private schemaAt(sem: Sem, dir: Dir, loc: { file: string; line: number }): JsonSchema {
    const o = this.owner;
    const saved = { file: o.file, line: o.line };
    o.file = loc.file;
    o.line = loc.line;
    try { return this.schema(sem, dir); } finally { o.file = saved.file; o.line = saved.line; }
  }

  /** 具名字段集合 → object schema（不含容器层面的 tag）。flatten 字段并入同一层。 */
  private namedFields(fields: FieldDef[], rules: Pair<SerdeRenameRule | null>, containerDefault: boolean, deny: boolean, ctx: TyCtx, dir: Dir, owner: StructDef | EnumDef, extraProps: Record<string, JsonSchema> = {}, extraRequired: string[] = []): JsonSchema {
    const parts = this.collectNamedParts(fields, rules, containerDefault, deny, ctx, dir, owner, new Set());
    const props: Record<string, JsonSchema> = { ...extraProps, ...parts.props };
    const required: string[] = [...extraRequired, ...parts.required];
    const base: JsonSchema = { type: 'object', properties: props };
    if (required.length) base.required = required;
    if (parts.aliasReq.length) base.allOf = parts.aliasReq;
    if (parts.mapAdditional !== null) base.additionalProperties = parts.mapAdditional;
    else if (!parts.unresolvedFlat.length && (dir === 'ser' || deny)) base.additionalProperties = false;
    return parts.unresolvedFlat.length ? { allOf: [base, ...parts.unresolvedFlat] } : base;
  }

  private collectNamedParts(fields: FieldDef[], rules: Pair<SerdeRenameRule | null>, containerDefault: boolean, deny: boolean, ctx: TyCtx, dir: Dir, owner: StructDef | EnumDef, seen: Set<StructDef>): NamedParts {
    const props: Record<string, JsonSchema> = {};
    const required: string[] = [];
    const aliasReq: JsonSchema[] = [];
    const unresolvedFlat: JsonSchema[] = [];
    let mapAdditional: JsonSchema | boolean | null = null;
    for (const f of fields) {
      const fa = fieldAttrs(f.attrs);
      if (fa.unsupported.length) { props[f.name ?? '?'] = this.unres(`field ${f.name}: unsupported serde ${fa.unsupported.join(', ')}`, { file: owner.loc.file, line: f.line }); continue; }
      if (fa.skip || (dir === 'ser' ? fa.skipSer : fa.skipDe)) continue;
      if (fa.flatten) {
        const loc = { file: owner.loc.file, line: f.line };
        const sem = this.fieldSem(f, ctx);
        const custom = dir === 'ser' ? fa.serWith : fa.deWith;
        if (custom) { unresolvedFlat.push(this.unres(`flatten field \`${f.name}\` with custom ${dir} is not modelled`, loc)); continue; }
        if (isOption(sem)) { unresolvedFlat.push(this.unres(`flatten of Option<_> field \`${f.name}\` (all-or-nothing semantics not modelled)`, loc)); continue; }
        const shape = this.flattenParts(sem, dir, seen, loc);
        if (!shape) { unresolvedFlat.push(this.unres(`flatten field \`${f.name}\` is not a named struct or map (${semText(sem)})`, loc)); continue; }
        for (const [k, v] of Object.entries(shape.props)) {
          if (props[k]) props[k] = this.unres(`flatten field \`${f.name}\` duplicates property \`${k}\``, loc);
          else props[k] = v;
        }
        required.push(...shape.required);
        aliasReq.push(...shape.aliasReq);
        unresolvedFlat.push(...shape.unresolvedFlat);
        if (shape.mapAdditional !== null) {
          if (mapAdditional === null) mapAdditional = shape.mapAdditional;
          else unresolvedFlat.push(this.unres(`multiple flattened maps in ${defRustPath(owner)} are not modelled`, loc));
        }
        continue;
      }
      const name = (dir === 'ser' ? fa.rename.ser : fa.rename.de) ?? applyToField(dir === 'ser' ? rules.ser : rules.de, f.name!);
      const { schema, sem } = this.fieldValueSchema(f, fa, ctx, dir, owner);
      if (dir === 'ser') {
        if (fa.skipSerIf) {
          if (fa.skipSerIf === 'Option::is_none' && isOption(sem) && !fa.serWith) schema['x-option'] = 'omit';
          else schema['x-skip-serializing-if'] = fa.skipSerIf;
        } else required.push(name);
      } else {
        const optional = fa.default || containerDefault || (isOption(sem) && !fa.deWith);
        const aliases = fa.aliases.filter((a) => a !== name);
        if (aliases.length) {
          schema['x-aliases'] = aliases;
          for (const a of aliases) props[a] = schema;
          if (!optional) aliasReq.push({ anyOf: [name, ...aliases].map((n) => ({ required: [n] })) });
        } else if (!optional) required.push(name);
      }
      props[name] = schema;
    }
    return { props, required, aliasReq, mapAdditional, unresolvedFlat };
  }

  /** flatten 目标 → 可并入同一层的字段集合；非具名 struct/map 返回 null。 */
  private flattenParts(sem: Sem, dir: Dir, seen: Set<StructDef>, loc: { file: string; line: number }): NamedParts | null {
    let s = sem;
    while (s.k === 'ext' && TRANSPARENT.has(s.key) && s.args[0]) s = s.args[0];
    if (s.k === 'ext' && s.key === 'serde_json::Value') return { props: {}, required: [], aliasReq: [], mapAdditional: {}, unresolvedFlat: [] };
    if (s.k === 'ext' && MAPS.has(s.key)) {
      const sc = this.schemaAt(s, dir, loc);
      const ap = sc.additionalProperties;
      return { props: {}, required: [], aliasReq: [], mapAdditional: (ap === undefined ? {} : ap) as JsonSchema | boolean, unresolvedFlat: [] };
    }
    if (s.k === 'def' && s.def.kind === 'struct') return this.inlineNamed(s.def, s.args, dir, seen);
    return null;
  }

  private inlineNamed(def: StructDef, args: Sem[], dir: Dir, seen: Set<StructDef>): NamedParts | null {
    if (def.form !== 'named') return null;
    const ca = containerAttrs(def.attrs);
    if (ca.tag || ca.untagged || ca.content || ca.transparent) return null;
    if (seen.has(def)) return null;
    seen.add(def);
    try {
      return this.collectNamedParts(def.fields, ca.renameAll, ca.default, ca.denyUnknown, this.ctxFor(def, args), dir, def, seen);
    } finally {
      seen.delete(def);
    }
  }

  private structSchema(def: StructDef, ca: ContainerAttrs, ctx: TyCtx, dir: Dir): JsonSchema {
    if (ca.tag || ca.untagged || ca.content) {
      if (ca.tag && def.form === 'named' && !ca.untagged) {
        // serde 支持 struct 上的 `tag`：序列化时多写一个 tag 字段（值为容器名）
        const cname = this.containerName(def, dir);
        return this.namedFields(def.fields, ca.renameAll, ca.default, ca.denyUnknown, ctx, dir, def, { [ca.tag]: { const: cname } }, [ca.tag]);
      }
      return this.unres(`struct ${defRustPath(def)} with tag/untagged/content attributes`);
    }
    if (ca.transparent) {
      const live = def.fields.filter((f) => { const fa = fieldAttrs(f.attrs); return !fa.skip && !(dir === 'ser' ? fa.skipSer : fa.skipDe); });
      if (live.length !== 1) return this.unres(`transparent ${defRustPath(def)} with ${live.length} non-skipped fields`);
      const f = live[0]!;
      return this.fieldValueSchema(f, fieldAttrs(f.attrs), ctx, dir, def).schema;
    }
    if (def.form === 'unit') return { type: 'null' };
    if (def.form === 'named') return this.namedFields(def.fields, ca.renameAll, ca.default, ca.denyUnknown, ctx, dir, def);
    if (def.fields.length === 1) {
      const f = def.fields[0]!;
      const fa = fieldAttrs(f.attrs);
      if (fa.skip || fa.skipSer || fa.skipDe) return this.unres(`newtype ${defRustPath(def)} with skipped field`);
      return this.fieldValueSchema(f, fa, ctx, dir, def).schema;
    }
    const items: JsonSchema[] = [];
    for (const f of def.fields) {
      const fa = fieldAttrs(f.attrs);
      if (fa.skip || (dir === 'ser' ? fa.skipSer : fa.skipDe)) return this.unres(`tuple struct ${defRustPath(def)} with skipped fields`);
      items.push(this.fieldValueSchema(f, fa, ctx, dir, def).schema);
    }
    return { type: 'array', prefixItems: items, items: false, minItems: items.length, maxItems: items.length };
  }

  private containerName(def: StructDef | EnumDef, dir: Dir): string {
    for (const m of serdeMetas(def.attrs)) if (m.path === 'rename') { const p = pairOf(m, []); return (dir === 'ser' ? p.ser : p.de) ?? def.name; }
    return def.name;
  }

  /** 判断内层 schema 是否序列化为 JSON 对象（内部标签 newtype 变体要求）。 */
  private objectLike(sem: Sem): boolean | null {
    if (sem.k === 'def') {
      const ca = containerAttrs(sem.def.attrs);
      if (sem.def.kind === 'struct') {
        if (ca.transparent) {
          const f = sem.def.fields.find((x) => !fieldAttrs(x.attrs).skip);
          return f ? this.objectLike(this.tr.sem(f.ty, this.ctxFor(sem.def, sem.args))) : null;
        }
        if (sem.def.form === 'named' || sem.def.form === 'unit') return true;
        if (sem.def.fields.length === 1) return this.objectLike(this.tr.sem(sem.def.fields[0]!.ty, this.ctxFor(sem.def, sem.args)));
        return false;
      }
      if (ca.untagged) return null;
      if (ca.tag) return true;
      return sem.def.variants.every((v) => v.form !== 'unit') ? true : null;
    }
    if (sem.k === 'ext') {
      if (MAPS.has(sem.key)) return true;
      if (TRANSPARENT.has(sem.key) && sem.args[0]) return this.objectLike(sem.args[0]);
      if (sem.key === 'serde_json::Value') return null;
      return false;
    }
    if (sem.k === 'unit') return true;
    return false;
  }

  private enumSchema(def: EnumDef, ca: ContainerAttrs, ctx: TyCtx, dir: Dir): JsonSchema {
    const tag = ca.tag;
    const content = ca.content;
    const repr: 'external' | 'internal' | 'adjacent' | 'untagged' = ca.untagged ? 'untagged' : tag && content ? 'adjacent' : tag ? 'internal' : 'external';
    if (content && !tag) return this.unres(`enum ${defRustPath(def)} has content without tag`);
    const tagged: JsonSchema[] = [];
    const untaggedVariants: JsonSchema[] = [];
    const unitNames: string[] = [];
    let allSimpleUnit = repr === 'external';
    let otherVariant = false;
    for (const v of def.variants) {
      const va = fieldAttrs(v.attrs);
      if (va.unsupported.length) { tagged.push(this.unres(`variant ${v.name}: unsupported serde ${va.unsupported.join(', ')}`, { file: def.loc.file, line: v.line })); allSimpleUnit = false; continue; }
      if (va.skip || (dir === 'ser' ? va.skipSer : va.skipDe)) continue;
      const name = (dir === 'ser' ? va.rename.ser : va.rename.de) ?? applyToVariant(dir === 'ser' ? ca.renameAll.ser : ca.renameAll.de, v.name);
      const names = dir === 'de' ? [name, ...va.aliases.filter((a) => a !== name)] : [name];
      const fieldRules: Pair<SerdeRenameRule | null> = { ser: va.renameAll.ser ?? ca.renameAllFields.ser, de: va.renameAll.de ?? ca.renameAllFields.de };
      const vw = dir === 'ser' ? va.serWith : va.deWith;
      if (vw) { tagged.push(this.unres(`variant ${v.name} with ${dir === 'ser' ? 'serialize_with' : 'deserialize_with'} = "${vw}"`, { file: def.loc.file, line: v.line })); allSimpleUnit = false; continue; }
      if (va.other && dir === 'de') otherVariant = true;
      const isUntagged = repr === 'untagged' || va.untagged;
      // 变体内容
      let body: JsonSchema | null = null;
      let innerSem: Sem | null = null;
      if (v.form === 'tuple' && v.fields.length === 1) {
        const f = v.fields[0]!;
        const r = this.fieldValueSchema(f, fieldAttrs(f.attrs), ctx, dir, def);
        body = r.schema;
        innerSem = r.sem;
      } else if (v.form === 'tuple') {
        body = { type: 'array', prefixItems: v.fields.map((f) => this.fieldValueSchema(f, fieldAttrs(f.attrs), ctx, dir, def).schema), items: false, minItems: v.fields.length, maxItems: v.fields.length };
      } else if (v.form === 'named') {
        body = null;
      }
      if (v.form !== 'unit') allSimpleUnit = false;
      if (isUntagged) {
        if (v.form === 'unit') untaggedVariants.push({ type: 'null' });
        else if (v.form === 'named') untaggedVariants.push(this.namedFields(v.fields, fieldRules, false, false, ctx, dir, def));
        else untaggedVariants.push(body!);
        continue;
      }
      for (const n of names) {
        const tagConst: JsonSchema = va.other && dir === 'de' ? { type: 'string', 'x-serde-other': true } : { const: n };
        switch (repr) {
          case 'external':
            if (v.form === 'unit') {
              unitNames.push(n);
              tagged.push({ const: n });
              if (dir === 'de') tagged.push({ type: 'object', properties: { [n]: { type: 'null' } }, required: [n], additionalProperties: false });
            }
            else {
              const inner = v.form === 'named' ? this.namedFields(v.fields, fieldRules, false, false, ctx, dir, def) : body!;
              tagged.push({ type: 'object', properties: { [n]: inner }, required: [n], additionalProperties: false });
            }
            break;
          case 'internal':
            if (v.form === 'unit') tagged.push({ type: 'object', properties: { [tag!]: tagConst }, required: [tag!], ...(dir === 'ser' ? { additionalProperties: false } : {}) });
            else if (v.form === 'named') tagged.push(this.namedFields(v.fields, fieldRules, false, ca.denyUnknown, ctx, dir, def, { [tag!]: tagConst }, [tag!]));
            else if (v.fields.length === 1) {
              const ol = this.objectLike(innerSem!);
              if (ol === false) tagged.push(this.unres(`internally tagged newtype variant ${v.name} wraps non-object \`${semText(innerSem!)}\` (serde errors at runtime)`, { file: def.loc.file, line: v.line }));
              else tagged.push({ allOf: [{ type: 'object', properties: { [tag!]: tagConst }, required: [tag!] }, body!], ...(ol === null ? { 'x-note': 'inner value must serialize as an object' } : {}) });
            } else tagged.push(this.unres(`internally tagged tuple variant ${v.name} (rejected by serde)`, { file: def.loc.file, line: v.line }));
            break;
          case 'adjacent': {
            if (v.form === 'unit') { tagged.push({ type: 'object', properties: { [tag!]: tagConst }, required: [tag!], ...(dir === 'ser' ? { additionalProperties: false } : {}) }); break; }
            const inner = v.form === 'named' ? this.namedFields(v.fields, fieldRules, false, false, ctx, dir, def) : body!;
            tagged.push({ type: 'object', properties: { [tag!]: tagConst, [content!]: inner }, required: [tag!, content!], ...(dir === 'ser' || ca.denyUnknown ? { additionalProperties: false } : {}) });
            break;
          }
          default: break;
        }
      }
    }
    if (allSimpleUnit && !untaggedVariants.length && tagged.length) {
      const strings: JsonSchema = otherVariant ? { type: 'string' } : { type: 'string', enum: unitNames };
      const out: JsonSchema = dir === 'de' ? { oneOf: [strings, ...tagged.filter((s) => s.type === 'object')] } : strings;
      if (dir === 'de') out['x-also-accepts'] = 'externally tagged map form {"<Variant>": null}';
      return out;
    }
    if (!tagged.length && !untaggedVariants.length) return { not: {}, 'x-note': 'enum has no (de)serializable variants' };
    if (repr === 'untagged') return untaggedVariants.length === 1 ? untaggedVariants[0]! : { anyOf: untaggedVariants };
    const taggedS: JsonSchema = tagged.length === 1 ? tagged[0]! : { oneOf: tagged };
    if (!untaggedVariants.length) return taggedS;
    return { anyOf: [taggedS, ...untaggedVariants] };
  }
}

export { isOption };
