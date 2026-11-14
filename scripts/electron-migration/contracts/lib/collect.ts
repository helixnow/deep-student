// 单文件抽取：tree-sitter 语法树 → model.ts 中的作用域/定义/函数体摘要。
import type { Node } from 'web-tree-sitter';
import { parseAttributeText, parseMeta, parseMetaList, metaStr, rustStringValue, splitCommas, tokenize, toksText, type Meta, type Tok } from './attrs.ts';
import { evalCfg, type CfgVerdict } from './cfg.ts';
import type {
  Attr, Def, EmitSite, Expr, FieldDef, FnDef, ImplDef, JsonLit, LetBinding, ParamDef, RType, Scope, UseEntry, VariantDef, CallSite,
} from './model.ts';

export const EMIT_METHODS = new Set(['emit', 'emit_to', 'emit_filter', 'emit_str', 'emit_str_to', 'emit_str_filter']);

export interface FileCtx {
  file: string;
  crate: string;
  features: ReadonlySet<string>;
  /** 需要记录调用点的函数/方法名（事件包装函数传播用）。 */
  callNames: ReadonlySet<string> | null;
  /** 收到 `mod x;` 时回调，返回子模块作用域（由调用方解析文件）。 */
  onModDecl: (name: string, pathAttr: string | null, parent: Scope, inlineDirs: string[], line: number) => void;
  /** 记录被 cfg 排除的条目（命令统计用）。 */
  onInactive?: (kind: string, name: string, line: number, attrs: Attr[]) => void;
}

const line = (n: Node): number => n.startPosition.row + 1;

export function newScope(id: string, crate: string, path: string[], file: string, parent: Scope | null, outer: Scope | null): Scope {
  return { id, crate, path, file, parent, outer, defs: new Map(), uses: [], impls: [] };
}

function addDef(scope: Scope, d: Def): void {
  const list = scope.defs.get(d.name) ?? [];
  list.push(d);
  scope.defs.set(d.name, list);
}

// ---------------------------------------------------------------- 属性

/** 展开 cfg_attr：谓词在任一桌面环境可能成立时纳入其属性。 */
function expandAttr(text: string, ln: number, features: ReadonlySet<string>): { attrs: Attr[]; cfg: Tok[] | null } {
  const meta = parseAttributeText(text);
  if (meta && meta.kind === 'list' && meta.path === 'cfg_attr') {
    const parts = splitCommas(meta.toks);
    if (parts.length < 2) return { attrs: [], cfg: null };
    const v = evalCfg(parts[0]!, features);
    if (!v.active) return { attrs: [], cfg: null };
    const attrs: Attr[] = [];
    for (const p of parts.slice(1)) {
      const m = parseMeta(p);
      attrs.push({ text: `#[${p.map((t) => (t.t === 'str' ? JSON.stringify(t.v) : t.t === 'group' ? '(..)' : t.v)).join('')}]`, meta: m, line: ln });
    }
    return { attrs, cfg: null };
  }
  if (meta && meta.kind === 'list' && meta.path === 'cfg') return { attrs: [{ text, meta, line: ln }], cfg: meta.toks };
  return { attrs: [{ text, meta, line: ln }], cfg: null };
}

interface AttrAcc { attrs: Attr[]; cfgs: Tok[][] }

function attrsOf(nodes: Node[], features: ReadonlySet<string>): AttrAcc {
  const acc: AttrAcc = { attrs: [], cfgs: [] };
  for (const n of nodes) {
    const r = expandAttr(n.text, line(n), features);
    acc.attrs.push(...r.attrs);
    if (r.cfg) acc.cfgs.push(r.cfg);
  }
  return acc;
}

function cfgVerdict(acc: AttrAcc, features: ReadonlySet<string>): CfgVerdict | null {
  if (!acc.cfgs.length) return null;
  // 多个 #[cfg] 等价于 all(...)
  const toks: Tok[] = [];
  for (const [i, c] of acc.cfgs.entries()) {
    if (i) toks.push({ t: 'punct', v: ',' });
    toks.push(...c);
  }
  return evalCfg(acc.cfgs.length === 1 ? acc.cfgs[0]! : [{ t: 'ident', v: 'all' }, { t: 'group', open: '(', toks }], features);
}

// ---------------------------------------------------------------- 类型

export function typeOf(n: Node | null): RType {
  if (!n) return { k: 'other', text: '', why: 'missing type' };
  switch (n.type) {
    case 'primitive_type':
    case 'type_identifier':
      return { k: 'path', global: false, segs: [{ name: n.text, args: [] }] };
    case 'scoped_type_identifier': {
      const p = pathSegs(n.childForFieldName('path'));
      if (!p) return { k: 'other', text: n.text, why: 'qualified path' };
      return { k: 'path', global: p.global, segs: [...p.segs.map((s) => ({ name: s, args: [] })), { name: n.childForFieldName('name')!.text, args: [] }] };
    }
    case 'generic_type': {
      const base = typeOf(n.childForFieldName('type'));
      const args = typeArgs(n.childForFieldName('type_arguments'));
      if (base.k !== 'path') return { k: 'other', text: n.text, why: 'generic over non-path' };
      const segs = base.segs.slice();
      segs[segs.length - 1] = { name: segs[segs.length - 1]!.name, args };
      return { k: 'path', global: base.global, segs };
    }
    case 'reference_type':
    case 'pointer_type':
      return { k: 'ref', inner: typeOf(n.childForFieldName('type')) };
    case 'tuple_type':
      return { k: 'tuple', elems: n.namedChildren.filter((c) => c && c.type !== 'line_comment' && c.type !== 'block_comment').map((c) => typeOf(c)) };
    case 'unit_type':
      return { k: 'unit' };
    case 'never_type':
      return { k: 'never' };
    case 'array_type': {
      const elem = typeOf(n.childForFieldName('element'));
      const len = n.childForFieldName('length');
      return len ? { k: 'array', elem, len: len.text } : { k: 'slice', elem };
    }
    case 'bounded_type':
    case 'dynamic_type':
    case 'abstract_type':
    case 'function_type':
    case 'qualified_type':
    case 'macro_invocation':
    default:
      return { k: 'other', text: n.text, why: n.type };
  }
}

function typeArgs(n: Node | null): RType[] {
  if (!n) return [];
  const out: RType[] = [];
  for (const c of n.namedChildren) {
    if (!c || c.type === 'lifetime' || c.type === 'type_binding' || c.type === 'trait_bounds' || c.type.endsWith('comment')) continue;
    if (/_literal$/.test(c.type) || c.type === 'block') { out.push({ k: 'other', text: c.text, why: 'const generic argument' }); continue; }
    out.push(typeOf(c));
  }
  return out;
}

/** scoped_identifier / identifier / crate/self/super → 段列表。 */
function pathSegs(n: Node | null): { global: boolean; segs: string[] } | null {
  if (!n) return { global: false, segs: [] };
  switch (n.type) {
    case 'identifier': case 'crate': case 'self': case 'super': case 'type_identifier': case 'metavariable':
      return { global: false, segs: [n.text] };
    case 'scoped_identifier': {
      const p = n.childForFieldName('path');
      const name = n.childForFieldName('name')!.text;
      if (!p) return { global: n.text.startsWith('::'), segs: [name] };
      const inner = pathSegs(p);
      if (!inner) return null;
      return { global: inner.global, segs: [...inner.segs, name] };
    }
    case 'generic_type': {
      const inner = typeOf(n);
      return inner.k === 'path' ? { global: inner.global, segs: inner.segs.map((s) => s.name) } : null;
    }
    default:
      return null;
  }
}

function genericsOf(n: Node | null): string[] {
  if (!n) return [];
  const out: string[] = [];
  for (const c of n.namedChildren) {
    if (!c) continue;
    switch (c.type) {
      case 'type_identifier': out.push(c.text); break;
      case 'constrained_type_parameter': out.push(c.childForFieldName('left')!.text); break;
      case 'optional_type_parameter': out.push(c.childForFieldName('name')!.text); break;
      case 'const_parameter': out.push(c.childForFieldName('name')!.text); break;
      default: break;
    }
  }
  return out;
}

// ---------------------------------------------------------------- use

function useEntries(n: Node, prefix: string[], vis: boolean, out: UseEntry[]): void {
  const ln = line(n);
  switch (n.type) {
    case 'identifier': case 'crate': case 'self': case 'super': case 'scoped_identifier': case 'metavariable': {
      const p = pathSegs(n);
      if (!p) return;
      const segs = [...prefix, ...(p.global && !prefix.length ? ['::'] : []), ...p.segs];
      // `use a::{self}` → 引入 a 本身
      if (segs[segs.length - 1] === 'self' && segs.length > 1) out.push({ path: segs.slice(0, -1), alias: null, glob: false, vis, line: ln });
      else out.push({ path: segs, alias: null, glob: false, vis, line: ln });
      return;
    }
    case 'use_as_clause': {
      const p = pathSegs(n.childForFieldName('path'));
      if (!p) return;
      let segs = [...prefix, ...(p.global && !prefix.length ? ['::'] : []), ...p.segs];
      if (segs[segs.length - 1] === 'self') segs = segs.slice(0, -1);
      out.push({ path: segs, alias: n.childForFieldName('alias')!.text, glob: false, vis, line: ln });
      return;
    }
    case 'use_wildcard': {
      const base = n.namedChildren.find((c) => c && c.type !== '*');
      const p = base ? pathSegs(base) : { global: n.text.startsWith('::'), segs: [] };
      if (!p) return;
      out.push({ path: [...prefix, ...(p.global && !prefix.length ? ['::'] : []), ...p.segs], alias: null, glob: true, vis, line: ln });
      return;
    }
    case 'scoped_use_list': {
      const pn = n.childForFieldName('path');
      const p = pn ? pathSegs(pn) : { global: n.text.startsWith('::'), segs: [] };
      if (!p) return;
      const np = [...prefix, ...(p.global && !prefix.length ? ['::'] : []), ...p.segs];
      const list = n.childForFieldName('list');
      if (list) for (const c of list.namedChildren) if (c && !c.type.endsWith('comment')) useEntries(c, np, vis, out);
      return;
    }
    case 'use_list':
      for (const c of n.namedChildren) if (c && !c.type.endsWith('comment')) useEntries(c, prefix, vis, out);
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------- 表达式

/** json! 值表达式的二次解析（文本 → Expr），由 workspace 用同一个 parser 提供。 */
let exprParser: ((text: string) => Expr) | null = null;
export function setExprParser(f: ((text: string) => Expr) | null): void { exprParser = f; }

function formatExpr(toks: Tok[]): Expr | null {
  const parts = splitCommas(toks);
  const tok = parts[0]?.length === 1 ? parts[0][0] : undefined;
  if (!tok || tok.t !== 'str') return null;
  const template = tok.v.replace(/\{\{/g, '\u0001').replace(/\}\}/g, '\u0002')
    .replace(/\{([A-Za-z_][A-Za-z0-9_]*|[0-9]*)(:[^}]*)?\}/g, (_m, name: string) => `{${/^[0-9]*$/.test(name) ? '' : name}}`)
    .replace(/\u0001/g, '{{').replace(/\u0002/g, '}}');
  return { k: 'format', template, args: parts.slice(1).map((p) => p.map((t) => (t.t === 'group' ? '(..)' : t.t === 'str' ? JSON.stringify(t.v) : t.v)).join('')) };
}

function jsonLit(toks: Tok[]): JsonLit {
  if (toks.length === 1) {
    const t = toks[0]!;
    if (t.t === 'group' && t.open === '{') {
      const entries: { key: string | null; keyText: string; value: JsonLit }[] = [];
      for (const part of splitCommas(t.toks)) {
        const colon = part.findIndex((x) => x.t === 'punct' && x.v === ':');
        if (colon < 0) { entries.push({ key: null, keyText: part.map((x) => (x.t === 'str' ? x.v : '')).join(''), value: { k: 'expr', text: '' } }); continue; }
        const kt = part.slice(0, colon);
        const k0 = kt.length === 1 ? kt[0] : undefined;
        const key = k0 && k0.t === 'str' ? k0.v : null;
        entries.push({ key, keyText: kt.map((x) => (x.t === 'str' ? JSON.stringify(x.v) : x.t === 'group' ? '(..)' : x.v)).join(''), value: jsonLit(part.slice(colon + 1)) });
      }
      return { k: 'obj', entries };
    }
    if (t.t === 'group' && t.open === '[') return { k: 'arr', elems: splitCommas(t.toks).map(jsonLit) };
    if (t.t === 'ident' && t.v === 'null') return { k: 'null' };
    if (t.t === 'ident' && (t.v === 'true' || t.v === 'false')) return { k: 'bool' };
    if (t.t === 'str') return { k: 'str' };
    if (t.t === 'lit' && /^[0-9]/.test(t.v)) return { k: 'num', text: t.v };
  }
  if (toks.length === 2 && toks[0]!.t === 'punct' && toks[0]!.v === '-' && toks[1]!.t === 'lit') return { k: 'num', text: '-' + toks[1]!.v };
  const text = toksText(toks);
  return { k: 'expr', text, ...(exprParser ? { expr: exprParser(text) } : {}) };
}

export function exprOf(n: Node | null): Expr {
  if (!n) return { k: 'other', text: '', line: 0 };
  switch (n.type) {
    case 'string_literal': case 'raw_string_literal': {
      const v = rustStringValue(n.text);
      return v === null ? { k: 'other', text: n.text, line: line(n) } : { k: 'str', v };
    }
    case 'identifier': case 'self': case 'scoped_identifier': case 'crate': case 'super': {
      const p = pathSegs(n);
      return p ? { k: 'path', segs: p.segs, text: n.text } : { k: 'other', text: n.text, line: line(n) };
    }
    case 'reference_expression':
      return { k: 'ref', inner: exprOf(n.childForFieldName('value')) };
    case 'unary_expression': {
      if (n.text.startsWith('*')) return exprOf(n.namedChildren[0] ?? null);
      return { k: 'other', text: n.text, line: line(n) };
    }
    case 'parenthesized_expression':
      return exprOf(n.namedChildren.find((c) => c && !c.type.endsWith('comment')) ?? null);
    case 'try_expression':
      return { k: 'try', inner: exprOf(n.namedChildren[0] ?? null) };
    case 'await_expression':
      return exprOf(n.namedChildren[0] ?? null);
    case 'unit_expression':
      return { k: 'unit' };
    case 'integer_literal': return { k: 'lit', t: 'int', text: n.text };
    case 'float_literal': return { k: 'lit', t: 'float', text: n.text };
    case 'boolean_literal': return { k: 'lit', t: 'bool', text: n.text };
    case 'char_literal': return { k: 'lit', t: 'char', text: n.text };
    case 'type_cast_expression': return { k: 'cast', ty: typeOf(n.childForFieldName('type')) };
    case 'binary_expression': return { k: 'binary', op: n.childForFieldName('operator')?.text ?? '', left: exprOf(n.childForFieldName('left')), right: exprOf(n.childForFieldName('right')) };
    case 'array_expression': return { k: 'array', elems: n.namedChildren.filter((c) => c && !c.type.endsWith('comment')).map((c) => exprOf(c)) };
    case 'tuple_expression': return { k: 'tuple', elems: n.namedChildren.filter((c) => c && !c.type.endsWith('comment')).map((c) => exprOf(c)) };
    case 'index_expression': return { k: 'index', recv: exprOf(n.namedChildren[0] ?? null) };
    case 'range_expression': return { k: 'range', start: exprOf(n.namedChildren[0] ?? null), end: exprOf(n.namedChildren[1] ?? null) };
    case 'closure_expression': {
      const body = n.childForFieldName('body');
      const params: string[] = [];
      for (const p of n.childForFieldName('parameters')?.namedChildren ?? []) {
        if (!p) continue;
        const pat = p.type === 'parameter' ? p.childForFieldName('pattern') : p;
        if (pat?.type === 'identifier') params.push(pat.text);
      }
      return { k: 'closure', params, body: { k: 'located', inner: exprOf(body), pos: body?.endIndex ? body.endIndex - 1 : n.startIndex } };
    }
    case 'return_expression': case 'break_expression': case 'continue_expression': return { k: 'never' };
    case 'block': {
      const last = n.namedChildren.filter((c) => c && !c.type.endsWith('comment')).at(-1);
      if (last?.type === 'expression_statement') {
        const value = last.namedChildren[0];
        if (!value) return { k: 'unit' };
        if (['return_expression', 'break_expression', 'continue_expression'].includes(value.type)) return { k: 'never' };
        // 无分号的块尾表达式（if/match/block 等由 grammar 包成 expression_statement）。
        if (!/;\s*$/.test(last.text) && ['if_expression', 'match_expression', 'block', 'unsafe_block'].includes(value.type)) return exprOf(value);
        return { k: 'unit' };
      }
      return last && last.type !== 'let_declaration' && last.type !== 'expression_statement' ? exprOf(last) : { k: 'unit' };
    }
    case 'else_clause': return exprOf(n.namedChildren[0] ?? null);
    case 'if_expression': {
      const then = n.childForFieldName('consequence');
      const alt = n.childForFieldName('alternative');
      const altInner = alt?.namedChildren[0] ?? null;
      return {
        k: 'branches',
        values: [
          then ? branchExpr(then) : { k: 'unit' },
          altInner ? branchExpr(altInner) : { k: 'unit' },
        ],
      };
    }
    case 'match_expression': return {
      k: 'branches',
      values: (n.childForFieldName('body')?.namedChildren ?? [])
        .filter((c) => c?.type === 'match_arm')
        .map((c) => {
          const value = c!.childForFieldName('value');
          return value ? branchExpr(value) : { k: 'unit' };
        }),
    };
    case 'struct_expression': {
      const nameNode = n.childForFieldName('name');
      let ty: RType;
      if (nameNode?.type === 'generic_type_with_turbofish') {
        const base = typeOf(nameNode.childForFieldName('type'));
        ty = base.k === 'path' ? { ...base, segs: base.segs.map((s, i, a) => (i === a.length - 1 ? { name: s.name, args: typeArgs(nameNode.childForFieldName('type_arguments')) } : s)) } : base;
      } else ty = typeOf(nameNode);
      const body = n.childForFieldName('body');
      const fields: { name: string; value: Expr | null }[] = [];
      if (body) for (const c of body.namedChildren) {
        if (!c) continue;
        if (c.type === 'field_initializer') fields.push({ name: c.childForFieldName('field')?.text ?? c.childForFieldName('name')?.text ?? '', value: exprOf(c.childForFieldName('value')) });
        else if (c.type === 'shorthand_field_initializer') fields.push({ name: c.text, value: { k: 'path', segs: [c.text], text: c.text } });
      }
      return { k: 'struct', ty, fields };
    }
    case 'field_expression':
      return { k: 'field', recv: exprOf(n.childForFieldName('value')), name: n.childForFieldName('field')?.text ?? '' };
    case 'call_expression': {
      const fnode = n.childForFieldName('function');
      const args = argsOf(n.childForFieldName('arguments'));
      if (fnode?.type === 'field_expression') {
        return { k: 'method', recv: exprOf(fnode.childForFieldName('value')), name: fnode.childForFieldName('field')?.text ?? '', args, turbofish: [] };
      }
      if (fnode?.type === 'generic_function') {
        const inner = fnode.childForFieldName('function');
        const tf = typeArgs(fnode.childForFieldName('type_arguments'));
        if (inner?.type === 'field_expression') return { k: 'method', recv: exprOf(inner.childForFieldName('value')), name: inner.childForFieldName('field')?.text ?? '', args, turbofish: tf };
        return { k: 'call', callee: exprOf(inner), args, turbofish: tf };
      }
      return { k: 'call', callee: exprOf(fnode), args, turbofish: [] };
    }
    case 'macro_invocation': {
      const mname = n.childForFieldName('macro')?.text ?? '';
      const tt = n.namedChildren.find((c) => c?.type === 'token_tree');
      const inner = tt ? tokenize(tt.text.slice(1, -1)) : [];
      const short = mname.split('::').pop()!;
      if (short === 'format') { const f = formatExpr(inner); if (f) return f; }
      if (short === 'json' && (mname === 'json' || mname === 'serde_json::json')) return { k: 'json', value: jsonLit(inner) };
      return { k: 'macro', name: mname, text: n.text.slice(0, 200) };
    }
    default:
      return { k: 'other', text: n.text.slice(0, 200), line: line(n) };
  }
}

function argsOf(n: Node | null): Expr[] {
  if (!n) return [];
  return n.namedChildren.filter((c) => c && !c.type.endsWith('comment') && c.type !== 'attribute_item').map((c) => exprOf(c));
}

// ---------------------------------------------------------------- 函数体

interface BodyOut { lets: LetBinding[]; emits: EmitSite[]; calls: CallSite[]; items: Node[] }

function bindPattern(pat: Node | null, value: Expr | null, ty: RType | null, pos: number, start: number, end: number, out: BodyOut): void {
  if (!pat) return;
  if (pat.type === 'identifier') {
    out.lets.push({ name: pat.text, ty, value, pos, start, end });
  } else if (['mut_pattern', 'ref_pattern', 'reference_pattern', 'match_pattern'].includes(pat.type)) {
    bindPattern(pat.namedChildren.find((c) => c && c.type !== 'mutable_specifier') ?? null, value, ty, pos, start, end, out);
  } else if (pat.type === 'tuple_pattern' || pat.type === 'tuple_struct_pattern') {
    const type = pat.childForFieldName('type');
    const variant = type ? pathSegs(type)?.segs : undefined;
    pat.namedChildren.filter((c) => c && c.id !== type?.id).forEach((p, index) => {
      bindPattern(p, value ? { k: 'project', value, variant, index } : null, null, pos, start, end, out);
    });
  }
}

function enclosingBlock(n: Node): Node {
  let scope = n.parent;
  while (scope?.parent && !['block', 'closure_expression'].includes(scope.type)) scope = scope.parent;
  return scope ?? n;
}

/** 分支体若为块，用块尾表达式的源码位置推断：块内 let 在尾表达式处可见。 */
function branchExpr(n: Node): Expr {
  let pos = n.startIndex;
  if (n.type === 'block') {
    const last = n.namedChildren.filter((c) => c && !c.type.endsWith('comment')).at(-1);
    if (last) {
      if (last.type === 'expression_statement') {
        const inner = last.namedChildren[0];
        pos = inner ? inner.startIndex : last.startIndex;
      } else if (last.type !== 'let_declaration') pos = last.startIndex;
    }
  }
  return { k: 'located', inner: exprOf(n), pos };
}

function walkBody(n: Node, out: BodyOut, ctx: FileCtx, isRoot: boolean): void {
  if (!isRoot) {
    switch (n.type) {
      case 'function_item': case 'struct_item': case 'enum_item': case 'type_item': case 'use_declaration':
      case 'const_item': case 'static_item': case 'impl_item': case 'mod_item': case 'trait_item': {
        const attrs: Node[] = [];
        for (let p = n.previousNamedSibling; p && (p.type === 'attribute_item' || p.type.endsWith('comment')); p = p.previousNamedSibling) {
          if (p.type === 'attribute_item') attrs.unshift(p);
        }
        out.items.push(...attrs, n);
        return;
      }
      default: break;
    }
  }
  if (n.type === 'let_declaration') {
    const pat = n.childForFieldName('pattern');
    const ty = n.childForFieldName('type');
    const val = n.childForFieldName('value');
    bindPattern(pat, val ? exprOf(val) : null, ty ? typeOf(ty) : null, n.startIndex, n.endIndex, enclosingBlock(n).endIndex, out);
  }
  if (n.type === 'let_condition') {
    const parent = n.parent;
    const body = parent?.childForFieldName('consequence') ?? parent?.childForFieldName('body');
    if (body) bindPattern(n.childForFieldName('pattern'), exprOf(n.childForFieldName('value')), null, n.startIndex, body.startIndex, body.endIndex, out);
  }
  if (n.type === 'match_arm') {
    const match = n.parent?.parent;
    const body = n.childForFieldName('value');
    if (match?.type === 'match_expression' && body) bindPattern(n.childForFieldName('pattern'), exprOf(match.childForFieldName('value')), null, match.startIndex, body.startIndex, body.endIndex, out);
  }
  if (n.type === 'for_expression') {
    const body = n.childForFieldName('body');
    if (body) bindPattern(n.childForFieldName('pattern'), { k: 'element', value: exprOf(n.childForFieldName('value')) }, null, n.startIndex, body.startIndex, body.endIndex, out);
  }
  if (n.type === 'closure_expression') {
    const body = n.childForFieldName('body');
    if (body) for (const p of n.childForFieldName('parameters')?.namedChildren ?? []) {
      if (!p) continue;
      const pat = p.type === 'parameter' ? p.childForFieldName('pattern') : p;
      const ty = p.type === 'parameter' ? p.childForFieldName('type') : null;
      bindPattern(pat, null, ty ? typeOf(ty) : null, n.startIndex, body.startIndex, body.endIndex, out);
    }
  }
  if (n.type === 'assignment_expression') {
    // `x = expr`：按最近赋值确定 x 的类型（Rust 保证所有赋值的类型一致）。
    const left = n.childForFieldName('left');
    const right = n.childForFieldName('right');
    if (left?.type === 'identifier' && right) {
      const name = left.text.replace(/^r#/, '');
      const decl = [...out.lets].reverse().find((l) => l.name === name && l.start <= n.startIndex && n.startIndex < l.end);
      out.lets.push({ name, ty: null, value: exprOf(right), pos: n.startIndex, start: n.startIndex, end: decl?.end ?? enclosingBlock(n).endIndex, assign: true });
    }
  }
  if (n.type === 'call_expression') {
    const f = n.childForFieldName('function');
    if (f?.type === 'field_expression') {
      const m = f.childForFieldName('field')?.text ?? '';
      // `let mut xs = Vec::new(); xs.push(v)`：元素类型由 push 实参决定（Rust 类型推断）。
      if (m === 'push') {
        const recv = f.childForFieldName('value');
        const arg = argsOf(n.childForFieldName('arguments'))[0];
        if (recv?.type === 'identifier' && arg) {
          const name = recv.text.replace(/^r#/, '');
          const decl = [...out.lets].reverse().find((l) => l.name === name && l.start <= n.startIndex && n.startIndex < l.end);
          out.lets.push({ name, ty: null, value: { k: 'vec', elems: [arg] }, pos: n.startIndex, start: n.startIndex, end: decl?.end ?? enclosingBlock(n).endIndex, assign: true });
        }
      }
      if (EMIT_METHODS.has(m)) {
        out.emits.push({ method: m, receiver: exprOf(f.childForFieldName('value')), args: argsOf(n.childForFieldName('arguments')), line: line(n), pos: n.startIndex });
      } else if (ctx.callNames?.has(m)) {
        out.calls.push({ callee: exprOf(f), args: argsOf(n.childForFieldName('arguments')), line: line(n), pos: n.startIndex });
      }
    } else if (ctx.callNames && f) {
      const last = f.text.split('::').pop()!.replace(/<.*$/s, '');
      if (ctx.callNames.has(last)) out.calls.push({ callee: exprOf(f.type === 'generic_function' ? f.childForFieldName('function') : f), args: argsOf(n.childForFieldName('arguments')), line: line(n), pos: n.startIndex });
    }
  }
  for (const c of n.children) if (c) walkBody(c, out, ctx, false);
}

function tailExprs(body: Node): Expr[] {
  const out: Expr[] = [];
  const kids = body.namedChildren.filter((c) => c && !c.type.endsWith('comment'));
  const last = kids[kids.length - 1];
  if (last && last.type !== 'expression_statement' && last.type !== 'let_declaration' && !last.type.endsWith('_item') && last.type !== 'use_declaration') out.push({ k: 'located', inner: exprOf(last), pos: last.startIndex });
  for (const r of body.descendantsOfType('return_expression')) {
    // A closure's return constrains that closure, not the containing function.
    let parent = r?.parent;
    while (parent && parent.id !== body.id && !['closure_expression', 'function_item'].includes(parent.type)) parent = parent.parent;
    if (!parent || parent.id !== body.id) continue;
    const v = r?.namedChildren[0];
    if (v) out.push({ k: 'located', inner: exprOf(v), pos: v.startIndex });
  }
  return out;
}

// ---------------------------------------------------------------- 条目

function visOf(n: Node): boolean {
  return n.namedChildren.some((c) => c?.type === 'visibility_modifier');
}

function fieldsOf(body: Node | null, features: ReadonlySet<string>): { form: 'named' | 'tuple' | 'unit'; fields: FieldDef[] } {
  if (!body) return { form: 'unit', fields: [] };
  const fields: FieldDef[] = [];
  let pending: Node[] = [];
  if (body.type === 'field_declaration_list') {
    for (const c of body.namedChildren) {
      if (!c) continue;
      if (c.type === 'attribute_item') { pending.push(c); continue; }
      if (c.type === 'field_declaration') {
        const acc = attrsOf(pending, features);
        pending = [];
        const v = cfgVerdict(acc, features);
        if (v && !v.active) continue;
        fields.push({ name: c.childForFieldName('name')!.text.replace(/^r#/, ''), ty: typeOf(c.childForFieldName('type')), attrs: acc.attrs, line: line(c) });
      }
    }
    return { form: 'named', fields };
  }
  if (body.type === 'ordered_field_declaration_list') {
    const types = new Set(body.childrenForFieldName('type').map((t) => t.startIndex));
    for (const c of body.namedChildren) {
      if (!c) continue;
      if (c.type === 'attribute_item') { pending.push(c); continue; }
      if (types.has(c.startIndex) && c.type !== 'visibility_modifier') {
        const acc = attrsOf(pending, features);
        pending = [];
        const v = cfgVerdict(acc, features);
        if (v && !v.active) continue;
        fields.push({ name: null, ty: typeOf(c), attrs: acc.attrs, line: line(c) });
      }
    }
    return { form: 'tuple', fields };
  }
  return { form: 'unit', fields: [] };
}

function variantsOf(body: Node | null, features: ReadonlySet<string>): VariantDef[] {
  const out: VariantDef[] = [];
  if (!body) return out;
  let pending: Node[] = [];
  for (const c of body.namedChildren) {
    if (!c) continue;
    if (c.type === 'attribute_item') { pending.push(c); continue; }
    if (c.type !== 'enum_variant') continue;
    const acc = attrsOf(pending, features);
    pending = [];
    const v = cfgVerdict(acc, features);
    if (v && !v.active) continue;
    const f = fieldsOf(c.childForFieldName('body'), features);
    out.push({ name: c.childForFieldName('name')!.text.replace(/^r#/, ''), attrs: acc.attrs, form: f.form, fields: f.fields, line: line(c) });
  }
  return out;
}

function paramsOf(n: Node | null): { params: ParamDef[]; hasSelf: boolean } {
  const params: ParamDef[] = [];
  let hasSelf = false;
  if (!n) return { params, hasSelf };
  for (const c of n.namedChildren) {
    if (!c) continue;
    if (c.type === 'self_parameter') { hasSelf = true; continue; }
    if (c.type !== 'parameter') continue;
    const pat = c.childForFieldName('pattern');
    let name: string | null = null;
    if (pat?.type === 'identifier') name = pat.text.replace(/^r#/, '');
    else if (pat?.type === 'mut_pattern') name = pat.namedChildren.find((x) => x?.type === 'identifier')?.text.replace(/^r#/, '') ?? null;
    else if (pat?.type === '_' || pat?.text === '_') name = '';
    else if (pat?.type === 'struct_pattern' || pat?.type === 'tuple_struct_pattern') {
      // tauri-macros：Pat::Struct / Pat::TupleStruct 取类型路径最后一段作为 key
      const t = pat.childForFieldName('type');
      name = t ? t.text.split('::').pop()! : null;
    }
    params.push({ pattern: pat?.text ?? '', name, ty: typeOf(c.childForFieldName('type')), line: line(c) });
  }
  return { params, hasSelf };
}

export function collectItems(container: Node, scope: Scope, ctx: FileCtx, inlineDirs: string[], impl: { self: RType; trait: RType | null; generics: string[] } | null, implOut: FnDef[] | null): void {
  let pending: Node[] = [];
  for (const n of container.namedChildren) {
    if (!n) continue;
    if (n.type === 'attribute_item') { pending.push(n); continue; }
    if (n.type === 'line_comment' || n.type === 'block_comment' || n.type === 'inner_attribute_item') continue;
    const acc = attrsOf(pending, ctx.features);
    pending = [];
    const cfg = cfgVerdict(acc, ctx.features);
    const nameNode = n.childForFieldName('name');
    if (cfg && !cfg.active) {
      ctx.onInactive?.(n.type, nameNode?.text ?? '', line(n), acc.attrs);
      continue;
    }
    const loc = { file: ctx.file, line: line(n) };
    const vis = visOf(n);
    const idBase = `${scope.id}::${nameNode?.text ?? ''}`;
    switch (n.type) {
      case 'use_declaration': {
        const arg = n.childForFieldName('argument');
        if (arg) useEntries(arg, [], vis, scope.uses);
        break;
      }
      case 'struct_item': case 'union_item': {
        const f = fieldsOf(n.childForFieldName('body'), ctx.features);
        addDef(scope, { kind: 'struct', name: nameNode!.text, generics: genericsOf(n.childForFieldName('type_parameters')), attrs: acc.attrs, form: f.form, fields: f.fields, loc, vis, scope, id: idBase });
        break;
      }
      case 'enum_item':
        addDef(scope, { kind: 'enum', name: nameNode!.text, generics: genericsOf(n.childForFieldName('type_parameters')), attrs: acc.attrs, variants: variantsOf(n.childForFieldName('body'), ctx.features), loc, vis, scope, id: idBase });
        break;
      case 'type_item':
        addDef(scope, { kind: 'alias', name: nameNode!.text, generics: genericsOf(n.childForFieldName('type_parameters')), ty: typeOf(n.childForFieldName('type')), loc, vis, scope, id: idBase });
        break;
      case 'const_item': case 'static_item': {
        const t = n.childForFieldName('type');
        const v = n.childForFieldName('value');
        addDef(scope, { kind: 'const', name: nameNode!.text, ty: t ? typeOf(t) : null, value: v ? exprOf(v) : null, loc, vis, scope, id: idBase });
        break;
      }
      case 'trait_item':
        addDef(scope, { kind: 'trait', name: nameNode!.text, vis, scope, id: idBase, loc });
        break;
      case 'function_item': {
        const fn = collectFn(n, acc, cfg, scope, ctx, impl, loc, vis);
        if (implOut) implOut.push(fn);
        else addDef(scope, fn);
        break;
      }
      case 'impl_item': {
        const selfTy = typeOf(n.childForFieldName('type'));
        const tr = n.childForFieldName('trait');
        const generics = genericsOf(n.childForFieldName('type_parameters'));
        const im: ImplDef = { trait: tr ? typeOf(tr) : null, selfTy, generics, scope, methods: [], loc };
        scope.impls.push(im);
        const body = n.childForFieldName('body');
        if (body) collectItems(body, scope, ctx, inlineDirs, { self: selfTy, trait: im.trait, generics }, im.methods);
        break;
      }
      case 'mod_item': {
        const name = nameNode!.text;
        const body = n.childForFieldName('body');
        const pathAttr = acc.attrs.map((a) => a.meta).find((m): m is Meta => !!m && m.kind === 'nv' && m.path === 'path');
        if (body) {
          const child = newScope(`${scope.id}::${name}`, scope.crate, [...scope.path, name], ctx.file, scope, null);
          addDef(scope, { kind: 'mod', name, scope: child, vis, id: child.id, loc });
          collectItems(body, child, ctx, [...inlineDirs, pathAttr ? metaStr(pathAttr)! : name], null, null);
        } else {
          ctx.onModDecl(name, pathAttr ? metaStr(pathAttr) : null, scope, inlineDirs, line(n));
        }
        break;
      }
      default:
        break;
    }
  }
}

function collectFn(n: Node, acc: AttrAcc, cfg: CfgVerdict | null, scope: Scope, ctx: FileCtx, impl: { self: RType; trait: RType | null; generics: string[] } | null, loc: { file: string; line: number }, vis: boolean): FnDef {
  const name = n.childForFieldName('name')!.text;
  const { params, hasSelf } = paramsOf(n.childForFieldName('parameters'));
  const rt = n.childForFieldName('return_type');
  const mods = n.namedChildren.find((c) => c?.type === 'function_modifiers');
  const body = n.childForFieldName('body');
  const out: BodyOut = { lets: [], emits: [], calls: [], items: [] };
  let bodyScope: Scope | null = null;
  if (body) {
    walkBody(body, out, ctx, true);
    if (out.items.length) {
      bodyScope = newScope(`${scope.id}::{fn ${name}#${line(n)}}`, scope.crate, scope.path, ctx.file, scope.parent, scope);
      const fake = { namedChildren: out.items } as unknown as Node;
      collectItems(fake, bodyScope, ctx, [], null, null);
    }
  }
  const generics = [...(impl?.generics ?? []), ...genericsOf(n.childForFieldName('type_parameters'))];
  return {
    kind: 'fn', name, generics, attrs: acc.attrs, params, hasSelf, ret: rt ? typeOf(rt) : null,
    async: !!mods && /\basync\b/.test(mods.text), loc, vis, scope,
    implSelf: impl?.self ?? null, implTrait: impl?.trait ?? null,
    lets: out.lets, emits: out.emits, calls: out.calls, tails: body ? tailExprs(body) : [],
    bodyText: body ? body.text : '', bodyScope, id: `${scope.id}::${impl ? '<impl>::' : ''}${name}@${loc.line}`, cfg,
  };
}

export { parseMetaList };
