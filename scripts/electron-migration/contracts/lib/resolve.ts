// 名字解析（Rust 2018/2021 路径语义的静态子集）：
// - 模块内查找顺序：本模块条目与显式 `use` > glob `use` > extern prelude（依赖 crate 名）> std prelude；
// - 成员查找（`a::b` 的 b）只看 a 自身的条目、显式 use 与 glob use；
// - glob 只带入可见名字：`pub` 条目/`pub use`，或导入方是目标模块的后代（如 `use super::*`）；
// - `crate::` / `self::` / `super::` / `::name`；块作用域（函数体内条目）先查自身再查外层。
// 多个候选（例如 cfg 分支各定义一份且都可能启用）视为歧义，交由调用方报 x-unresolved。
import type { Workspace } from './workspace.ts';
import type { Def, EnumDef, Scope, UseEntry } from './model.ts';

export type Res =
  | { k: 'def'; def: Def }
  | { k: 'mod'; scope: Scope }
  | { k: 'ext'; path: string[] }
  | { k: 'variant'; def: EnumDef; variant: string };

export type Ns = 'type' | 'value' | 'any';

export const STD_CRATES = new Set(['std', 'core', 'alloc']);
const STD_PRELUDE_TYPES = new Map<string, string[]>([
  ['Option', ['std', 'option', 'Option']],
  ['Result', ['std', 'result', 'Result']],
  ['Vec', ['std', 'vec', 'Vec']],
  ['String', ['std', 'string', 'String']],
  ['Box', ['std', 'boxed', 'Box']],
  ['Some', ['std', 'option', 'Option', 'Some']],
  ['None', ['std', 'option', 'Option', 'None']],
  ['Ok', ['std', 'result', 'Result', 'Ok']],
  ['Err', ['std', 'result', 'Result', 'Err']],
  ['ToString', ['std', 'string', 'ToString']],
  ['Default', ['std', 'default', 'Default']],
]);

const isTypeDef = (d: Def): boolean => d.kind === 'struct' || d.kind === 'enum' || d.kind === 'alias' || d.kind === 'mod' || d.kind === 'trait';
const isValueDef = (d: Def): boolean => d.kind === 'fn' || d.kind === 'const' || (d.kind === 'struct' && d.form !== 'named');
const nsOk = (d: Def, ns: Ns): boolean => ns === 'any' || (ns === 'type' ? isTypeDef(d) : isValueDef(d));

function moduleOf(s: Scope): Scope {
  let m = s;
  while (m.outer) m = m.outer;
  return m;
}

function isDescendant(s: Scope, ancestor: Scope): boolean {
  for (let m: Scope | null = moduleOf(s); m; m = m.parent) if (m === ancestor) return true;
  return false;
}

export interface Lookup { res: Res[]; why?: string }

function dedupe(rs: Res[]): Res[] {
  const seen = new Set<string>();
  const out: Res[] = [];
  for (const r of rs) {
    const key = r.k === 'def' ? `d:${r.def.id}@${r.def.loc.file}:${r.def.loc.line}` : r.k === 'mod' ? `m:${r.scope.id}` : r.k === 'ext' ? `e:${r.path.join('::')}` : `v:${r.def.id}::${r.variant}`;
    if (!seen.has(key)) { seen.add(key); out.push(r); }
  }
  return out;
}

export class Resolver {
  readonly ws: Workspace;
  private busy = new Set<string>();
  private cache = new Map<string, Res[]>();
  constructor(ws: Workspace) { this.ws = ws; }

  crateRoot(s: Scope): Scope { return this.ws.crates.get(s.crate)!.scope; }

  private externCrate(s: Scope, name: string): Res | null {
    const c = this.ws.crates.get(s.crate);
    if (!c) return null;
    if (name === c.name) return null;
    const pkg = c.deps.get(name);
    if (pkg) {
      const target = [...this.ws.crates.values()].find((x) => x.pkg === pkg && x.dir !== 'tests');
      if (target) return { k: 'mod', scope: target.scope };
    }
    if (STD_CRATES.has(name) || c.externDeps.has(name)) return { k: 'ext', path: [name] };
    return null;
  }

  /** 在作用域中查找名字。member=true 表示 `a::name` 形式（不查 extern/prelude/外层）。 */
  lookup(scope: Scope, name: string, ns: Ns, member: boolean, from: Scope): Res[] {
    const key = `${scope.id}|${name}|${ns}|${member ? 1 : 0}|${member ? (isDescendant(from, scope) ? 'in' : 'out') : ''}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    if (this.busy.has(key)) return [];
    this.busy.add(key);
    try {
      const r = dedupe(this.lookupInner(scope, name, ns, member, from));
      this.cache.set(key, r);
      return r;
    } finally {
      this.busy.delete(key);
    }
  }

  private lookupInner(scope: Scope, name: string, ns: Ns, member: boolean, from: Scope): Res[] {
    const inside = isDescendant(from, moduleOf(scope));
    const out: Res[] = [];
    for (const d of scope.defs.get(name) ?? []) {
      if (!nsOk(d, ns)) continue;
      if (member && !inside && !d.vis) continue;
      out.push(d.kind === 'mod' ? { k: 'mod', scope: d.scope } : { k: 'def', def: d });
    }
    for (const u of scope.uses) {
      if (u.glob) continue;
      const local = u.alias ?? u.path[u.path.length - 1];
      if (local !== name || local === '_') continue;
      if (member && !inside && !u.vis) continue;
      out.push(...this.resolveUse(u, scope, ns));
    }
    if (out.length) return out;
    if (scope.outer && !member) {
      const r = this.lookup(scope.outer, name, ns, false, from);
      if (r.length) return r;
    }
    for (const u of scope.uses) {
      if (!u.glob) continue;
      if (member && !inside && !u.vis) continue;
      for (const t of this.resolvePathRes(u.path, scope, 'type')) {
        if (t.k === 'mod') out.push(...this.lookup(t.scope, name, ns, true, scope));
        else if (t.k === 'def' && t.def.kind === 'enum' && t.def.variants.some((v) => v.name === name)) out.push({ k: 'variant', def: t.def, variant: name });
        else if (t.k === 'ext') out.push({ k: 'ext', path: [...t.path, `*${name}`] });
      }
    }
    if (out.length) {
      const picked = this.pickGlob(out);
      // 外部 crate 的 glob 无法静态得知导出名；std prelude 名字按 prelude 解析（已人工核对工作区里的
      // 三处外部 glob：docx_rs 0.4.19、pdfium_render 0.8.37 prelude 均不导出 Result/String/Vec/Option/Box）；
      // 同理，依赖 crate 名（extern prelude，如 `std`）也不按外部 glob 猜测。
      const onlyExtGuess = out.every((r) => r.k === 'ext' && r.path[r.path.length - 1]!.startsWith('*'));
      if (!(onlyExtGuess && !member && (STD_PRELUDE_TYPES.has(name) || this.externCrate(scope, name)))) return picked;
    }
    if (member) return [];
    const ec = this.externCrate(scope, name);
    if (ec) return [ec];
    const pre = STD_PRELUDE_TYPES.get(name);
    if (pre) return [{ k: 'ext', path: pre }];
    return [];
  }

  /** glob 导入到外部 crate 时只能记下“可能来自该 crate”，有确定的工作区结果时优先。 */
  private pickGlob(rs: Res[]): Res[] {
    const concrete = rs.filter((r) => !(r.k === 'ext' && r.path[r.path.length - 1]!.startsWith('*')));
    if (concrete.length) return concrete;
    return rs.map((r) => (r.k === 'ext' ? { k: 'ext', path: [...r.path.slice(0, -1), r.path[r.path.length - 1]!.slice(1)] } : r));
  }

  private resolveUse(u: UseEntry, scope: Scope, ns: Ns): Res[] {
    return this.resolvePathRes(u.path, scope, ns);
  }

  /** 解析路径。ns 只约束最后一段。 */
  resolvePathRes(segs: string[], scope: Scope, ns: Ns): Res[] {
    if (!segs.length) return [];
    let cur: Res[];
    let i = 0;
    const first = segs[0]!;
    if (first === '::') {
      const n = segs[1];
      if (!n) return [];
      const ec = this.externCrate(scope, n);
      cur = ec ? [ec] : [];
      i = 2;
    } else if (first === 'crate') { cur = [{ k: 'mod', scope: this.crateRoot(scope) }]; i = 1; }
    else if (first === 'self') { cur = [{ k: 'mod', scope: moduleOf(scope) }]; i = 1; }
    else if (first === 'super') {
      let m: Scope | null = moduleOf(scope);
      while (segs[i] === 'super') { m = m?.parent ?? null; i++; }
      if (!m) return [];
      cur = [{ k: 'mod', scope: m }];
    } else {
      cur = this.lookup(scope, first, segs.length === 1 ? ns : 'type', false, scope);
      i = 1;
    }
    for (; i < segs.length; i++) {
      const seg = segs[i]!;
      const last = i === segs.length - 1;
      const next: Res[] = [];
      for (const c of cur) {
        if (c.k === 'mod') next.push(...this.lookup(c.scope, seg, last ? ns : 'type', true, scope));
        else if (c.k === 'ext') next.push({ k: 'ext', path: [...c.path, seg] });
        else if (c.k === 'def' && c.def.kind === 'enum' && c.def.variants.some((v) => v.name === seg)) next.push({ k: 'variant', def: c.def, variant: seg });
      }
      cur = dedupe(next);
      if (!cur.length) return [];
    }
    return cur;
  }
}

/** 外部路径规范化：std/core/alloc 合并为 std，取 `crate::Last` 作为匹配键。 */
export function extKey(path: string[]): string {
  const crate = STD_CRATES.has(path[0]!) ? 'std' : path[0]!;
  return `${crate}::${path[path.length - 1]}`;
}
