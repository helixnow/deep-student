// 事件抽取：tauri `Emitter` 的 `emit(event, payload)`、`emit_to(target, event, payload)`、
// `emit_filter(event, payload, filter)`、`emit_str*`（tauri-2.11.5 src/lib.rs `trait Emitter`）。
// 接收者类型能推断时只接受 AppHandle / Window / WebviewWindow / Webview（Emitter 的实现者）；
// 推断不出时，事件名为字面量 / 常量 / format! 才计入（与项目自有 `.emit` 方法区分）。
// 事件名是所在函数参数时，该函数视为包装函数，名字与 payload 从调用点传播（可多层）。
import { extKey as extKeyOf, type Resolver } from './resolve.ts';
import type { Def, EmitSite, Expr, FnDef, JsonLit, LetBinding, RType, Scope, StructDef, EnumDef } from './model.ts';
import { rtypeText, semText, semKey, type Sem, type TypeResolver, type TyCtx, type SchemaBuilder, type Owner } from './schema.ts';
import type { JsonSchema } from '../../../../host/kernel/contract.ts';

const TAURI_EMITTERS = new Set(['tauri::AppHandle', 'tauri::Window', 'tauri::WebviewWindow', 'tauri::Webview']);

export type NameRes =
  | { k: 'lit'; name: string }
  | { k: 'tpl'; name: string }
  | { k: 'names'; names: { k: 'lit' | 'tpl'; name: string }[] }
  | { k: 'param'; idx: number }
  | { k: 'unknown'; why: string };

export type PayloadRes = { k: 'sem'; sem: Sem } | { k: 'json'; lit: JsonLit; fn: FnDef; pos: number } | { k: 'param'; idx: number } | { k: 'unknown'; why: string };

export interface EmitRecord {
  name: string;
  dynamic: boolean;
  payload: PayloadRes;
  fn: FnDef;
  file: string;
  line: number;
  method: 'emit' | 'emit_to' | 'emit_filter' | 'other';
  via?: string;
  receiverNote?: string;
}

export interface Wrapper { fn: FnDef; nameIdx: number; payload: PayloadRes; method: EmitRecord['method']; site: string; nameTransform?: (inner: string) => string }

export class EventAnalyzer {
  readonly r: Resolver;
  readonly tr: TypeResolver;
  constructor(r: Resolver, tr: TypeResolver) { this.r = r; this.tr = tr; }

  /** 闭包形参类型在调用点才确定：分析闭包体时叠加到词法绑定之上。 */
  private extraLets: LetBinding[] = [];

  private withLets<T>(entries: LetBinding[], f: () => T): T {
    const n = this.extraLets.length;
    this.extraLets.push(...entries);
    try { return f(); } finally { this.extraLets.length = n; }
  }

  /** 以调用点给出的形参类型分析闭包体；非闭包直接分析表达式。 */
  private closureBody(e: Expr | undefined, params: (Sem | null)[], f: (body: Expr) => Sem | null): Sem | null {
    if (!e) return null;
    if (e.k !== 'closure') return f(e);
    const entries: LetBinding[] = [];
    e.params.forEach((name, i) => {
      const sem = params[i];
      if (sem) entries.push({ name, ty: null, value: null, pos: 0, start: 0, end: Number.MAX_SAFE_INTEGER, sem });
    });
    return this.withLets(entries, () => f(e.body));
  }

  ctxOf(fn: FnDef): TyCtx {
    const env = new Map<string, Sem>();
    for (const g of fn.generics) env.set(g, { k: 'generic', name: g });
    const scope = fn.bodyScope ?? fn.scope;
    const self = fn.implSelf ? this.tr.sem(fn.implSelf, { scope: fn.scope, env, self: null }) : null;
    return { scope, env, self };
  }

  private letBefore(fn: FnDef, name: string, pos: number): FnDef['lets'][number] | null {
    // 闭包形参遮蔽外层同名绑定。
    for (let i = this.extraLets.length - 1; i >= 0; i--) if (this.extraLets[i]!.name === name) return this.extraLets[i]!;
    let best: FnDef['lets'][number] | null = null;
    for (const l of fn.lets) if (l.name === name && l.start <= pos && pos < l.end && (!best || l.start > best.start)) best = l;
    return best;
  }

  /** 可见的同名绑定，最近的在前（用于赋值伪绑定推断失败时回退到声明）。 */
  private bindingChain(fn: FnDef, name: string, pos: number): FnDef['lets'][number][] {
    for (let i = this.extraLets.length - 1; i >= 0; i--) if (this.extraLets[i]!.name === name) return [this.extraLets[i]!];
    return fn.lets.filter((l) => l.name === name && l.start <= pos && pos < l.end).sort((a, b) => b.start - a.start);
  }

  private bindingType(l: FnDef['lets'][number], fn: FnDef, name: string, ctx: TyCtx, depth: number): Sem | null {
    if (l.sem) return l.sem;
    if (l.ty) return this.tr.sem(l.ty, ctx);
    // The function's declared return type constrains the same lexical
    // binding even when its initializer uses a generic closure helper.
    for (const tail of fn.tails) {
      if (tail.k !== 'located') continue;
      let value = tail.inner;
      let result = false;
      if (value.k === 'call' && value.callee.k === 'path' && value.callee.segs.join('::') === 'Ok' && value.args.length === 1) { value = value.args[0]!; result = true; }
      if (value.k === 'path' && value.segs.length === 1 && value.segs[0] === name && this.letBefore(fn, name, tail.pos) === l && fn.ret) {
        const expected = this.tr.sem(fn.ret, ctx);
        if (!result) return expected;
        if (expected.k === 'ext' && expected.key === 'std::Result') return expected.args[0] ?? null;
      }
    }
    return l.value ? this.inferType(l.value, fn, l.start - 1, depth + 1) : null;
  }

  // ---------------------------------------------------------------- 类型推断（只做事件分析需要的子集）

  inferType(e: Expr, fn: FnDef, pos: number, depth = 0): Sem | null {
    if (depth > 64) return null;
    const ctx = this.ctxOf(fn);
    switch (e.k) {
      case 'located': return this.inferType(e.inner, fn, e.pos, depth + 1);
      case 'ref': case 'try': return this.unwrapTry(this.inferType(e.inner, fn, pos, depth + 1), e.k === 'try');
      case 'str': return { k: 'prim', name: 'str' };
      case 'format': return { k: 'ext', key: 'std::String', path: 'std::string::String', args: [] };
      case 'unit': return { k: 'unit' };
      case 'never': return { k: 'never' };
      case 'branches': {
        const sems = e.values
          .map((v) => ({ v, s: this.inferType(v, fn, pos, depth + 1) }))
          .filter((x) => x.s?.k !== 'never');
        const typed = sems.filter((x) => !isUnsuffixedNumber(x.v));
        const first = typed[0]?.s;
        if (!first) return sems.length && sems.every((x) => isUnsuffixedNumber(x.v)) ? { k: 'prim', name: 'i32' } : null;
        let merged = first;
        for (const x of typed.slice(1)) {
          const u = x.s ? mergeSem(merged, x.s) : null;
          if (!u) return null;
          merged = u;
        }
        // Rust 让无后缀整数字面量采用另一分支推出的整数类型。
        const adoptable = merged.k === 'prim' && /^[ui](8|16|32|64|128|size)$/.test(merged.name);
        return sems.every((x) => typed.includes(x) || adoptable) ? merged : null;
      }
      case 'tuple': {
        const elems = e.elems.map((v) => this.inferType(v, fn, pos, depth + 1));
        return elems.every((s) => s !== null) ? { k: 'tuple', elems } : null;
      }
      case 'vec': {
        const elems = e.elems.map((v) => this.inferType(v, fn, pos, depth + 1));
        const first = elems[0];
        if (!first || !elems.every((s) => s && semKey(s) === semKey(first))) return null;
        return { k: 'ext', key: 'std::Vec', path: 'std::vec::Vec', args: [first] };
      }
      case 'element': case 'index': {
        const recv = this.inferType(e.k === 'element' ? e.value : e.recv, fn, pos, depth + 1);
        if (recv?.k === 'array' || recv?.k === 'slice') return recv.elem;
        if (recv?.k === 'ext' && ['std::Vec', 'std::VecDeque', 'std::HashSet', 'std::BTreeSet', 'std::Iterator', 'std::Range'].includes(recv.key)) return recv.args[0] ?? null;
        if (recv?.k === 'ext' && recv.key === 'serde_json::Value' && e.k === 'index') return recv;
        return null;
      }
      case 'range': {
        const a = this.inferType(e.start, fn, pos, depth + 1);
        const b = this.inferType(e.end, fn, pos, depth + 1);
        // 无后缀字面量端点采用另一端的整数类型。
        const item = isUnsuffixedNumber(e.start) ? b : isUnsuffixedNumber(e.end) ? a : a && b && semKey(a) === semKey(b) ? a : null;
        return item?.k === 'prim' && /^[ui](8|16|32|64|128|size)$/.test(item.name) ? { k: 'ext', key: 'std::Range', path: 'std::ops::Range', args: [item] } : null;
      }
      case 'project': {
        const source = this.inferType(e.value, fn, pos, depth + 1);
        if (!e.variant) return source?.k === 'tuple' ? source.elems[e.index] ?? null : null;
        const name = e.variant.at(-1)!;
        if (source?.k === 'ext' && source.key === 'std::Option' && name === 'Some') return source.args[0] ?? null;
        if (source?.k === 'ext' && source.key === 'std::Result' && ['Ok', 'Err'].includes(name)) return source.args[name === 'Ok' ? 0 : 1] ?? null;
        if (source?.k === 'ext' && source.key === 'serde_json::Value') {
          // serde_json::Value 的变体（serde_json 1.0.149 value/mod.rs）。
          const value: Sem = { k: 'ext', key: 'serde_json::Value', path: 'serde_json::Value', args: [] };
          const variants: Record<string, Sem> = {
            Array: { k: 'ext', key: 'std::Vec', path: 'std::vec::Vec', args: [value] },
            Object: { k: 'ext', key: 'serde_json::Map', path: 'serde_json::Map', args: [{ k: 'prim', name: 'str' }, value] },
            String: { k: 'ext', key: 'std::String', path: 'std::string::String', args: [] },
            Number: { k: 'ext', key: 'serde_json::Number', path: 'serde_json::Number', args: [] },
            Bool: { k: 'prim', name: 'bool' },
            Null: { k: 'unit' },
          };
          return variants[name] ?? null;
        }
        const res = this.r.resolvePathRes(e.variant, ctx.scope, 'value');
        const variant = res.length === 1 && res[0]!.k === 'variant' ? res[0]! : null;
        const def = source?.k === 'def' && source.def.kind === 'enum' ? source.def : variant?.def;
        const field = def?.variants.find((v) => v.name === name)?.fields[e.index];
        if (!def || !field) return null;
        const env = new Map<string, Sem>();
        if (source?.k === 'def') def.generics.forEach((g, i) => { if (source.args[i]) env.set(g, source.args[i]!); });
        return this.tr.sem(field.ty, { scope: def.scope, env, self: source });
      }
      case 'lit': {
        if (e.t === 'bool' || e.t === 'char') return { k: 'prim', name: e.t };
        const suffix = /(?:[0-9_])([ui](?:8|16|32|64|128|size)|f32|f64)$/.exec(e.text);
        if (suffix) return { k: 'prim', name: suffix[1]! };
        // Rust 默认类型：无后缀整数 i32，无后缀浮点 f64。
        return { k: 'prim', name: e.t === 'int' ? 'i32' : 'f64' };
      }
      case 'cast': return this.tr.sem(e.ty, ctx);
      case 'binary': {
        if (['==', '!=', '<', '>', '<=', '>=', '&&', '||'].includes(e.op)) return { k: 'prim', name: 'bool' };
        const l = this.inferType(e.left, fn, pos, depth + 1);
        return l && l.k === 'prim' ? l : null;
      }
      case 'json': return { k: 'ext', key: 'serde_json::Value', path: 'serde_json::Value', args: [] };
      case 'path': {
        if (e.segs.length === 1) {
          const n = e.segs[0]!;
          if (n === 'self') return ctx.self;
          if (n === 'None') return { k: 'ext', key: 'std::Option', path: 'std::option::Option', args: [] };
          const chain = this.bindingChain(fn, n, pos);
          for (const l of chain) {
            const s = this.bindingType(l, fn, n, ctx, depth);
            // `x = None` 的 Option 缺少类型参数时不比之前的同变量赋值更有信息量。
            const uninformative = !!s && l.assign && s.k === 'ext' && (s.key === 'std::Option' || s.key === 'std::Result') && s.args.length === 0;
            if (s && !uninformative) return s;
            // 赋值伪绑定推断不出时，回退到同一变量此前的声明/赋值（Rust 保证类型一致）。
            if (!l.assign) break;
          }
          const p = fn.params.find((x) => x.name === n);
          if (p) return this.tr.sem(p.ty, ctx);
        }
        const res = this.r.resolvePathRes(e.segs, ctx.scope, 'value');
        if (res.length === 1) {
          const x = res[0]!;
          if (x.k === 'def' && x.def.kind === 'const' && x.def.ty) return this.tr.sem(x.def.ty, { scope: x.def.scope, env: new Map(), self: null });
          if (x.k === 'def' && x.def.kind === 'struct' && x.def.form === 'unit') return { k: 'def', def: x.def, args: [] };
          if (x.k === 'variant') return { k: 'def', def: x.def, args: [] };
          if (x.k === 'ext' && x.path.length >= 3 && extKeyOf(x.path.slice(0, -1)) === 'serde_json::Value') return { k: 'ext', key: 'serde_json::Value', path: 'serde_json::Value', args: [] };
        }
        return null;
      }
      case 'struct': {
        const s = this.tr.sem(e.ty, ctx);
        if (s.k === 'def') return s;
        if (s.k === 'unres' && e.ty.k === 'path' && e.ty.segs.length >= 2) {
          // `Enum::Variant { .. }`
          const res = this.r.resolvePathRes(e.ty.segs.map((x) => x.name), ctx.scope, 'any');
          if (res.length === 1 && res[0]!.k === 'variant') return { k: 'def', def: res[0]!.def, args: [] };
          if (e.ty.segs[0]!.name === 'Self' && ctx.self?.k === 'def' && ctx.self.def.kind === 'enum') return ctx.self;
        }
        return s.k === 'unres' ? null : s;
      }
      case 'call': {
        if (e.callee.k === 'closure') return this.inferType(e.callee.body, fn, pos, depth + 1);
        if (e.callee.k !== 'path') return null;
        const segs = e.callee.segs;
        if (segs.length === 2 && segs[0] === 'Self' && ctx.self) {
          const m = this.methodOf(ctx.self, segs[1]!);
          if (m) return this.retOf(m, ctx.self);
          if (ctx.self.k === 'def' && ctx.self.def.kind === 'enum' && ctx.self.def.variants.some((v) => v.name === segs[1])) return ctx.self;
          return null;
        }
        if (segs.length === 1 && segs[0] === 'None') return { k: 'ext', key: 'std::Option', path: 'std::option::Option', args: [] };
        if (segs.length === 1 && ['Some', 'Ok', 'Err'].includes(segs[0]!) && e.args.length) {
          const inner = this.inferType(e.args[0]!, fn, pos, depth + 1);
          if (!inner) return null;
          if (segs[0] === 'Some') return { k: 'ext', key: 'std::Option', path: 'std::option::Option', args: [inner] };
          const failure: Sem = { k: 'unres', why: `serde error type of ${segs[0]}` };
          return { k: 'ext', key: 'std::Result', path: 'std::result::Result', args: segs[0] === 'Ok' ? [inner, failure] : [failure, inner] };
        }
        const callee = segs.join('::');
        // 原子类型：AtomicUsize::new(0) 等（std::sync::atomic）。
        const atomic = /(?:^|::)Atomic(Usize|Isize|U8|U16|U32|U64|U128|I8|I16|I32|I64|I128|Bool)::new$/.exec(callee);
        if (atomic) {
          const name = `Atomic${atomic[1]}`;
          return { k: 'ext', key: `std::sync::atomic::${name}`, path: `std::sync::atomic::${name}`, args: [] };
        }
        // tokio::time::timeout(dur, fut) → Result<fut::Output, Elapsed>。
        if (/(^|::)timeout$/.test(callee) && e.args[1]) {
          const inner = this.inferType(e.args[1]!, fn, pos, depth + 1);
          if (!inner) return null;
          return { k: 'ext', key: 'std::Result', path: 'std::result::Result', args: [inner, { k: 'ext', key: 'tokio::time::error::Elapsed', path: 'tokio::time::error::Elapsed', args: [] }] };
        }
        // tokio::sync::mpsc::{unbounded_channel,channel}(::<T>) → (Sender<T>, Receiver<T>)
        if (/(^|::)mpsc::(unbounded_channel|channel)$/.test(callee) && e.turbofish[0]) {
          const item = this.tr.sem(e.turbofish[0], ctx);
          if (item.k === 'unres' || item.k === 'generic') return null;
          const dir = /Unbounded|::channel$/.test(callee) ? (callee.endsWith('unbounded_channel') ? 'Unbounded' : '') : '';
          return {
            k: 'tuple',
            elems: [
              { k: 'ext', key: `mpsc::${dir}Sender`, path: 'tokio::sync::mpsc::Sender', args: [item] },
              { k: 'ext', key: `mpsc::${dir}Receiver`, path: 'tokio::sync::mpsc::Receiver', args: [item] },
            ],
          };
        }
        // Arc::new / Arc::clone / Rc 的等价形式。
        if ((/^(std::sync::)?(Arc|Rc)::(new|clone)$/.test(callee)) && e.args[0]) {
          const inner = this.derefSem(this.inferType(e.args[0], fn, pos, depth + 1) ?? { k: 'unit' });
          if (this.inferType(e.args[0], fn, pos, depth + 1)) return inner;
        }
        const res = this.r.resolvePathRes(segs, ctx.scope, 'value');
        if (res.length === 1) {
          const x = res[0]!;
          if (x.k === 'def' && x.def.kind === 'fn') return this.retOf(x.def, null);
          if (x.k === 'def' && x.def.kind === 'struct') return { k: 'def', def: x.def, args: [] };
          if (x.k === 'variant') return { k: 'def', def: x.def, args: [] };
          if (x.k === 'ext') {
            const p = x.path.join('::');
            // serde_json::to_value 返回 Result<Value, Error>；Value 的线上形状即入参的 serde 形状。
            if (/^(serde_json::(to_value|json)|serde_json::value::to_value)$/.test(p)) {
              const arg = e.args[0] ? this.inferType(e.args[0], fn, pos, depth + 1) : null;
              const shape: Sem = arg && arg.k !== 'unres' && arg.k !== 'generic' ? arg : { k: 'ext', key: 'serde_json::Value', path: 'serde_json::Value', args: [] };
              const failure: Sem = { k: 'unres', why: 'serde_json::Error' };
              return { k: 'ext', key: 'std::Result', path: 'std::result::Result', args: [shape, failure] };
            }
          }
        }
        if (segs.length >= 2) {
          const tyRes = this.r.resolvePathRes(segs.slice(0, -1), ctx.scope, 'type');
          if (tyRes.length === 1 && tyRes[0]!.k === 'def') {
            const d = tyRes[0]!.def;
            if (d.kind === 'struct' || d.kind === 'enum') {
              const self: Sem = { k: 'def', def: d, args: [] };
              const m = this.methodOf(self, segs[segs.length - 1]!);
              if (m) return this.retOf(m, self);
              if (d.kind === 'enum' && d.variants.some((v) => v.name === segs[segs.length - 1])) return self;
            }
            if (d.kind === 'alias') {
              const s = this.tr.sem({ k: 'path', global: false, segs: segs.slice(0, -1).map((n) => ({ name: n, args: [] })) }, ctx);
              const m = this.methodOf(s, segs[segs.length - 1]!);
              if (m) return this.retOf(m, s);
            }
          }
        }
        return null;
      }
      case 'method': {
        const recv = this.inferType(e.recv, fn, pos, depth + 1);
        switch (e.name) {
          case 'clone': case 'as_ref': case 'as_mut': case 'borrow': case 'deref':
            return recv;
          case 'to_owned':
            if (recv?.k === 'prim' && recv.name === 'str') return { k: 'ext', key: 'std::String', path: 'std::string::String', args: [] };
            return recv;
          case 'inner':
            if (recv?.k === 'ext' && recv.key === 'tauri::State') return recv.args[0] ?? null;
            break;
          case 'take': case 'as_deref':
            if (recv?.k === 'ext' && ['std::Option', 'std::Result'].includes(recv.key)) return recv;
            break;
          case 'to_string': case 'to_rfc3339': case 'to_lowercase': case 'to_uppercase': case 'to_string_lossy': case 'display':
            return { k: 'ext', key: 'std::String', path: 'std::string::String', args: [] };
          case 'as_str':
            if (recv?.k === 'ext' && recv.key === 'serde_json::Value') return { k: 'ext', key: 'std::Option', path: 'std::option::Option', args: [{ k: 'prim', name: 'str' }] };
            return { k: 'prim', name: 'str' };
          case 'trim': return { k: 'prim', name: 'str' };
          case 'len': case 'count': return { k: 'prim', name: 'usize' };
          case 'is_empty': case 'is_some': case 'is_none': case 'is_ok': case 'is_err': case 'contains': case 'starts_with': case 'ends_with':
            return { k: 'prim', name: 'bool' };
          case 'unwrap': case 'expect': case 'unwrap_or_default': return this.unwrapTry(recv, true);
          case 'unwrap_or': case 'unwrap_or_else': return recv?.k === 'ext' && ['std::Option', 'std::Result'].includes(recv.key) ? recv.args[0] ?? null : null;
          case 'then': case 'then_some': {
            if (!(recv?.k === 'prim' && recv.name === 'bool')) break;
            const value = e.name === 'then_some' ? this.inferType(e.args[0] ?? { k: 'unit' }, fn, pos, depth + 1) : this.closureBody(e.args[0], [], (body) => this.inferType(body, fn, pos, depth + 1));
            return value ? { k: 'ext', key: 'std::Option', path: 'std::option::Option', args: [value] } : null;
          }
          case 'load': case 'fetch_add': case 'fetch_sub': case 'fetch_and': case 'fetch_or': case 'fetch_xor': case 'swap': {
            const m = recv?.k === 'ext' ? /^std::sync::atomic::Atomic(Usize|Isize|U8|U16|U32|U64|U128|I8|I16|I32|I64|I128|Bool)$/.exec(recv.key) : null;
            if (!m) break;
            return { k: 'prim', name: m[1] === 'Bool' ? 'bool' : m[1]!.toLowerCase() };
          }
          case 'recv': case 'try_recv': case 'blocking_recv':
            if (recv?.k === 'ext' && /mpsc::(Unbounded|)Receiver/.test(recv.key)) return { k: 'ext', key: 'std::Option', path: 'std::option::Option', args: recv.args[0] ? [recv.args[0]] : [] };
            break;
          case 'send': case 'blocking_send': case 'try_send':
            if (recv?.k === 'ext' && /mpsc::(Unbounded|)Sender/.test(recv.key)) return { k: 'ext', key: 'std::Result', path: 'std::result::Result', args: [{ k: 'unit' }, { k: 'unres', why: 'mpsc send error' }] };
            break;
          case 'is_some_and': case 'is_ok_and':
            if (recv?.k === 'ext' && ['std::Option', 'std::Result'].includes(recv.key)) return { k: 'prim', name: 'bool' };
            break;
          case 'map_err':
            if (recv?.k === 'ext' && recv.key === 'std::Result') {
              const out = this.closureBody(e.args[0], [recv.args[1] ?? null], (body) => this.inferType(body, fn, pos, depth + 1));
              return { ...recv, args: [recv.args[0]!, out ?? { k: 'unres', why: 'map_err closure output' }] };
            }
            break;
          case 'ok_or': case 'ok_or_else':
            if (recv?.k === 'ext' && recv.key === 'std::Option') return { k: 'ext', key: 'std::Result', path: 'std::result::Result', args: [recv.args[0]!, { k: 'unres', why: 'ok_or error output' }] };
            break;
          case 'iter': case 'into_iter': case 'iter_mut':
            if (recv && (recv.k === 'array' || recv.k === 'slice' || (recv.k === 'ext' && ['std::Vec', 'std::VecDeque', 'std::HashSet', 'std::BTreeSet'].includes(recv.key)))) {
              const item = recv.k === 'ext' ? recv.args[0] : recv.elem;
              if (item) return { k: 'ext', key: 'std::Iterator', path: 'std::iter::Iterator', args: [item] };
            }
            break;
          case 'enumerate':
            if (recv?.k === 'ext' && recv.key === 'std::Iterator' && recv.args[0]) return { ...recv, args: [{ k: 'tuple', elems: [{ k: 'prim', name: 'usize' }, recv.args[0]] }] };
            break;
          case 'filter': case 'filter_map': case 'cloned': case 'copied': case 'or_else':
            if (recv?.k === 'ext' && recv.key === 'std::Option' && e.name !== 'filter_map') return recv;
            break;
          case 'find': case 'first': case 'position': case 'next': case 'last': case 'max': case 'min': {
            if ((e.name === 'max' || e.name === 'min') && recv?.k === 'prim' && /^(?:[ui](?:8|16|32|64|128|size)|f32|f64)$/.test(recv.name)) return recv;
            if ((recv?.k === 'array' || recv?.k === 'slice' || (recv?.k === 'ext' && ['std::Vec', 'std::VecDeque'].includes(recv.key))) && (e.name === 'first' || e.name === 'last')) {
              const item = recv.k === 'ext' ? recv.args[0] : recv.elem;
              return item ? { k: 'ext', key: 'std::Option', path: 'std::option::Option', args: [item] } : null;
            }
            if (recv?.k !== 'ext' || recv.key !== 'std::Iterator') break;
            const item = recv.args[0] ?? null;
            if (e.name === 'position') return { k: 'ext', key: 'std::Option', path: 'std::option::Option', args: [{ k: 'prim', name: 'usize' }] };
            return item ? { k: 'ext', key: 'std::Option', path: 'std::option::Option', args: [item] } : null;
          }
          case 'collect':
            if (recv?.k === 'ext' && recv.key === 'std::Iterator' && e.turbofish[0]) {
              const s = this.tr.sem(e.turbofish[0], ctx);
              return s.k === 'unres' ? null : s;
            }
            break;
          case 'get':
            if (recv?.k === 'ext' && recv.key === 'serde_json::Value') return { k: 'ext', key: 'std::Option', path: 'std::option::Option', args: [recv] };
            if (recv?.k === 'ext' && ['serde_json::Map', 'std::HashMap', 'std::BTreeMap', 'indexmap::IndexMap'].includes(recv.key)) {
              const value = recv.args[1] ?? recv.args[0] ?? null;
              return value ? { k: 'ext', key: 'std::Option', path: 'std::option::Option', args: [value] } : null;
            }
            if (recv?.k === 'ext' && ['std::Vec', 'std::VecDeque'].includes(recv.key)) {
              const item = recv.args[0];
              return item ? { k: 'ext', key: 'std::Option', path: 'std::option::Option', args: [item] } : null;
            }
            break;
          case 'remove':
            if (recv?.k === 'ext' && ['serde_json::Map', 'std::HashMap', 'std::BTreeMap', 'indexmap::IndexMap'].includes(recv.key)) {
              const value = recv.args[1] ?? recv.args[0] ?? null;
              return value ? { k: 'ext', key: 'std::Option', path: 'std::option::Option', args: [value] } : null;
            }
            break;
          case 'as_object': case 'as_object_mut':
            if (recv?.k === 'ext' && recv.key === 'serde_json::Value') return { k: 'ext', key: 'std::Option', path: 'std::option::Option', args: [{ k: 'ext', key: 'serde_json::Map', path: 'serde_json::Map', args: [{ k: 'prim', name: 'str' }, recv] }] };
            break;
          case 'as_i64': case 'as_u64':
            if (recv?.k === 'ext' && recv.key === 'serde_json::Value') return { k: 'ext', key: 'std::Option', path: 'std::option::Option', args: [{ k: 'prim', name: e.name === 'as_i64' ? 'i64' : 'u64' }] };
            break;
          case 'as_f64':
            if (recv?.k === 'ext' && recv.key === 'serde_json::Value') return { k: 'ext', key: 'std::Option', path: 'std::option::Option', args: [{ k: 'prim', name: 'f64' }] };
            break;
          case 'as_bool':
            if (recv?.k === 'ext' && recv.key === 'serde_json::Value') return { k: 'ext', key: 'std::Option', path: 'std::option::Option', args: [{ k: 'prim', name: 'bool' }] };
            break;
          case 'as_array':
            if (recv?.k === 'ext' && recv.key === 'serde_json::Value') return { k: 'ext', key: 'std::Option', path: 'std::option::Option', args: [{ k: 'ext', key: 'std::Vec', path: 'std::vec::Vec', args: [recv] }] };
            break;
          case 'map': case 'and_then': {
            if (recv?.k === 'ext' && recv.key === 'std::Iterator') {
              const item = recv.args[0] ?? null;
              const out = this.closureBody(e.args[0], [item], (body) => this.inferType(body, fn, pos, depth + 1));
              return out ? { k: 'ext', key: 'std::Iterator', path: 'std::iter::Iterator', args: [out] } : null;
            }
            if (recv?.k !== 'ext' || !['std::Option', 'std::Result'].includes(recv.key)) break;
            const item = recv.args[0] ?? null;
            const mapper = e.args[0];
            let output: Sem | null = null;
            if (mapper?.k === 'closure') output = this.closureBody(mapper, [item], (body) => this.inferType(body, fn, pos, depth + 1));
            if (mapper && mapper.k !== 'closure') output = this.inferType(mapper, fn, pos, depth + 1);
            if (mapper?.k === 'path') {
              const p = mapper.segs.join('::');
              if (/(^|::)(String::from|ToString::to_string|str::to_string|str::to_owned)$/.test(p)) output = { k: 'ext', key: 'std::String', path: 'std::string::String', args: [] };
              const res = this.r.resolvePathRes(mapper.segs, ctx.scope, 'value');
              if (res.length === 1 && res[0]!.k === 'ext' && res[0]!.path.join('::') === 'serde_json::Value::as_str' && item?.k === 'ext' && item.key === 'serde_json::Value') output = { k: 'ext', key: 'std::Option', path: 'std::option::Option', args: [{ k: 'prim', name: 'str' }] };
            }
            if (output) return e.name === 'and_then' ? output : { ...recv, args: [output, ...recv.args.slice(1)] };
            break;
          }
          case 'app_handle': return { k: 'ext', key: 'tauri::AppHandle', path: 'tauri::AppHandle', args: [] };
          case 'get_webview_window': return { k: 'ext', key: 'std::Option', path: 'std::option::Option', args: [{ k: 'ext', key: 'tauri::WebviewWindow', path: 'tauri::WebviewWindow', args: [] }] };
          case 'get_window': return { k: 'ext', key: 'std::Option', path: 'std::option::Option', args: [{ k: 'ext', key: 'tauri::Window', path: 'tauri::Window', args: [] }] };
          case 'get_webview': return { k: 'ext', key: 'std::Option', path: 'std::option::Option', args: [{ k: 'ext', key: 'tauri::Webview', path: 'tauri::Webview', args: [] }] };
          case 'window': if (recv?.k === 'ext' && recv.key === 'tauri::Webview') return { k: 'ext', key: 'tauri::Window', path: 'tauri::Window', args: [] }; break;
          default: break;
        }
        if (recv && (recv.k === 'def' || recv.k === 'ext')) {
          const m = this.methodOf(this.derefSem(recv), e.name);
          if (m) return this.retOf(m, this.derefSem(recv));
        }
        return null;
      }
      case 'field': {
        const recv = this.inferType(e.recv, fn, pos, depth + 1);
        const base = recv ? this.derefSem(recv) : null;
        if (base?.k === 'def' && base.def.kind === 'struct') {
          const f = base.def.fields.find((x) => x.name === e.name);
          if (f) {
            const env = new Map<string, Sem>();
            base.def.generics.forEach((g, i) => { if (base.args[i]) env.set(g, base.args[i]!); });
            return this.tr.sem(f.ty, { scope: base.def.scope, env, self: base });
          }
        }
        return null;
      }
      default: return null;
    }
  }

  private derefSem(s: Sem): Sem {
    let cur = s;
    while (cur.k === 'ext' && ['std::Arc', 'std::Rc', 'std::Box', 'std::Cow', 'tauri::State'].includes(cur.key) && cur.args[0]) cur = cur.args[0];
    return cur;
  }

  private unwrapTry(s: Sem | null, unwrap: boolean): Sem | null {
    if (!s || !unwrap) return s;
    if (s.k === 'ext' && (s.key === 'std::Option' || s.key === 'std::Result')) return s.args[0] ?? null;
    return s;
  }

  private implIndex: Map<Def, FnDef[]> | null = null;

  methodOf(self: Sem, name: string): FnDef | null {
    if (self.k !== 'def') return null;
    if (!this.implIndex) {
      this.implIndex = new Map();
      for (const fn of this.allMethods()) {
        if (!fn.implSelf || fn.implSelf.k !== 'path') continue;
        for (const t of this.r.resolvePathRes(fn.implSelf.segs.map((s) => s.name), fn.scope, 'type')) {
          if (t.k !== 'def') continue;
          const l = this.implIndex.get(t.def) ?? [];
          l.push(fn);
          this.implIndex.set(t.def, l);
        }
      }
    }
    const ms = (this.implIndex.get(self.def) ?? []).filter((m) => m.name === name);
    return ms.length === 1 ? ms[0]! : null;
  }

  private methodsCache: FnDef[] | null = null;
  allMethods(): FnDef[] {
    if (this.methodsCache) return this.methodsCache;
    const out: FnDef[] = [];
    const seen = new Set<Scope>();
    const visit = (s: Scope): void => {
      if (seen.has(s)) return;
      seen.add(s);
      for (const im of s.impls) for (const m of im.methods) { out.push(m); if (m.bodyScope) visit(m.bodyScope); }
      for (const ds of s.defs.values()) for (const d of ds) {
        if (d.kind === 'mod') visit(d.scope);
        if (d.kind === 'fn' && d.bodyScope) visit(d.bodyScope);
      }
    };
    for (const c of this.r.ws.crates.values()) visit(c.scope);
    this.methodsCache = out;
    return out;
  }

  allFunctions(): FnDef[] {
    const out: FnDef[] = [];
    const seen = new Set<Scope>();
    const visit = (s: Scope): void => {
      if (seen.has(s)) return;
      seen.add(s);
      for (const ds of s.defs.values()) for (const d of ds) {
        if (d.kind === 'fn') { out.push(d); if (d.bodyScope) visit(d.bodyScope); }
        if (d.kind === 'mod') visit(d.scope);
      }
      for (const im of s.impls) for (const m of im.methods) { out.push(m); if (m.bodyScope) visit(m.bodyScope); }
    };
    for (const c of this.r.ws.crates.values()) visit(c.scope);
    return out;
  }

  retOf(fn: FnDef, self: Sem | null): Sem | null {
    if (!fn.ret) return { k: 'unit' };
    const env = new Map<string, Sem>();
    for (const g of fn.generics) env.set(g, { k: 'generic', name: g });
    if (self?.k === 'def') self.def.generics.forEach((g, i) => { if (self.args[i]) env.set(g, self.args[i]!); });
    const s = this.tr.sem(fn.ret, { scope: fn.scope, env, self: self ?? (fn.implSelf ? this.tr.sem(fn.implSelf, { scope: fn.scope, env, self: null }) : null) });
    return s.k === 'unres' ? null : s;
  }

  // ---------------------------------------------------------------- 事件名

  evalName(e: Expr, fn: FnDef, pos: number, depth = 0): NameRes {
    if (depth > 10) return { k: 'unknown', why: 'name expression too deep' };
    switch (e.k) {
      case 'located': return this.evalName(e.inner, fn, e.pos, depth + 1);
      case 'str': return { k: 'lit', name: e.v };
      case 'format': return { k: 'tpl', name: e.template };
      case 'branches': {
        const names: { k: 'lit' | 'tpl'; name: string }[] = [];
        for (const value of e.values) {
          const n = this.evalName(value, fn, pos, depth + 1);
          if (n.k === 'unknown' || n.k === 'param') return { k: 'unknown', why: 'event name branch not statically determined' };
          names.push(...(n.k === 'names' ? n.names : [n]));
        }
        return { k: 'names', names: names.filter((n, i) => names.findIndex((x) => x.k === n.k && x.name === n.name) === i) };
      }
      case 'project':
        if (e.variant?.at(-1) === 'Some') return this.evalName(e.value, fn, pos, depth + 1);
        return { k: 'unknown', why: 'event name from unsupported destructuring pattern' };
      case 'ref': return this.evalName(e.inner, fn, pos, depth + 1);
      case 'method':
        if (['to_string', 'as_str', 'clone', 'into', 'to_owned', 'as_ref'].includes(e.name) && !e.args.length) return this.evalName(e.recv, fn, pos, depth + 1);
        return this.fnNameOf(e, fn, pos, depth);
      case 'call':
        if (e.callee.k === 'path' && e.callee.segs.join('::') === 'Some' && e.args.length === 1) return this.evalName(e.args[0]!, fn, pos, depth + 1);
        return this.fnNameOf(e, fn, pos, depth);
      case 'path': {
        if (e.segs.join('::') === 'None') return { k: 'names', names: [] };
        if (e.segs.length === 1) {
          const n = e.segs[0]!;
          const l = this.letBefore(fn, n, pos);
          if (l) return l.value ? this.evalName(l.value, fn, l.pos, depth + 1) : { k: 'unknown', why: `let ${n} without initializer` };
          const pi = fn.params.findIndex((p) => p.name === n);
          if (pi >= 0) return { k: 'param', idx: pi };
        }
        const ctx = this.ctxOf(fn);
        let res = this.r.resolvePathRes(e.segs, ctx.scope, 'value');
        if (!res.length && e.segs[0] === 'Self' && ctx.self?.k === 'def') {
          // `Self::CONST`：impl 内的关联常量
          res = [];
        }
        if (res.length === 1 && res[0]!.k === 'def' && res[0]!.def.kind === 'const') {
          const c = res[0]!.def;
          if (c.value) {
            const fake: FnDef = { ...fn, lets: [], params: [], scope: c.scope, bodyScope: null, implSelf: null };
            return this.evalName(c.value, fake, 0, depth + 1);
          }
        }
        return { k: 'unknown', why: `event name \`${e.text}\` is not a literal/const/format!` };
      }
      default: return { k: 'unknown', why: `event name expression kind ${e.k}` };
    }
  }

  /** 名字来自函数调用：函数所有返回点都是同一字面量/模板时采用。 */
  private fnNameOf(e: Extract<Expr, { k: 'call' } | { k: 'method' }>, fn: FnDef, _pos: number, depth: number): NameRes {
    const ctx = this.ctxOf(fn);
    let target: FnDef | null = null;
    if (e.k === 'call' && e.callee.k === 'path') {
      const segs = e.callee.segs;
      if (segs.length === 2 && segs[0] === 'Self' && ctx.self) target = this.methodOf(ctx.self, segs[1]!);
      else {
        const res = this.r.resolvePathRes(segs, ctx.scope, 'value');
        if (res.length === 1 && res[0]!.k === 'def' && res[0]!.def.kind === 'fn') target = res[0]!.def;
        else if (segs.length >= 2) {
          const tyRes = this.r.resolvePathRes(segs.slice(0, -1), ctx.scope, 'type');
          if (tyRes.length === 1 && tyRes[0]!.k === 'def' && (tyRes[0]!.def.kind === 'struct' || tyRes[0]!.def.kind === 'enum')) target = this.methodOf({ k: 'def', def: tyRes[0]!.def as StructDef | EnumDef, args: [] }, segs[segs.length - 1]!);
        }
      }
    } else if (e.k === 'method') {
      const recv = this.inferType(e.recv, fn, _pos);
      if (recv) target = this.methodOf(this.derefSem(recv), e.name);
    }
    if (!target) return { k: 'unknown', why: `event name from call \`${e.k === 'call' && e.callee.k === 'path' ? e.callee.text : e.k === 'method' ? '.' + e.name + '()' : '?'}\` could not be resolved` };
    const names = target.tails.map((t) => this.evalName(t, target!, Number.MAX_SAFE_INTEGER, depth + 1));
    if (!names.length) return { k: 'unknown', why: `function ${target.name} has no analysable return expression` };
    const first = names[0]!;
    if ((first.k === 'lit' || first.k === 'tpl') && names.every((n) => n.k === first.k && n.name === first.name)) return first;
    return { k: 'unknown', why: `function ${target.name} returns a non-constant event name` };
  }

  // ---------------------------------------------------------------- payload

  evalPayload(e: Expr, fn: FnDef, pos: number): PayloadRes {
    let x = e;
    while (x.k === 'ref') x = x.inner;
    if (x.k === 'json') return { k: 'json', lit: x.value, fn, pos };
    if (x.k === 'path' && x.segs.length === 1) {
      const n = x.segs[0]!;
      const l = this.letBefore(fn, n, pos);
      if (l && !l.ty && l.value) {
        let v = l.value;
        while (v.k === 'ref') v = v.inner;
        if (v.k === 'json') return { k: 'json', lit: v.value, fn, pos: l.pos };
      }
      if (!l) {
        const pi = fn.params.findIndex((p) => p.name === n);
        if (pi >= 0) {
          const p = fn.params[pi]!;
          const s = this.tr.sem(p.ty, this.ctxOf(fn));
          if (s.k === 'generic' || (s.k === 'unres' && p.ty.k === 'other')) return { k: 'param', idx: pi };
          if (s.k !== 'unres') return { k: 'sem', sem: s };
        }
      }
    }
    const s = this.inferType(x, fn, pos);
    if (s && s.k !== 'unres' && s.k !== 'generic') return { k: 'sem', sem: s };
    return { k: 'unknown', why: `payload type of \`${exprText(x)}\` not determinable statically` };
  }

  // ---------------------------------------------------------------- 主流程

  isTauriReceiver(site: EmitSite, fn: FnDef): boolean | null {
    const t = this.inferType(site.receiver, fn, site.pos);
    if (!t) return null;
    const base = this.derefSem(t);
    if (base.k === 'ext' && TAURI_EMITTERS.has(base.key)) return true;
    if (base.k === 'unres') return null;
    if (base.k === 'generic') {
      // `fn f<R: Runtime>(app: &AppHandle<R>)` 已在上面命中；`impl Emitter` 泛型参数视为 tauri
      return null;
    }
    return false;
  }

  siteArgs(site: EmitSite): { name: Expr; payload: Expr | null } | null {
    const a = site.args;
    switch (site.method) {
      case 'emit': case 'emit_str': return a.length === 2 ? { name: a[0]!, payload: a[1]! } : null;
      case 'emit_to': case 'emit_str_to': return a.length === 3 ? { name: a[1]!, payload: a[2]! } : null;
      case 'emit_filter': case 'emit_str_filter': return a.length === 3 ? { name: a[0]!, payload: a[1]! } : null;
      default: return null;
    }
  }
}

/** 无类型后缀的整数字面量：Rust 会按上下文推断其整数类型。 */
function isUnsuffixedNumber(e: Expr): boolean {
  const inner = e.k === 'located' ? e.inner : e;
  return inner.k === 'lit' && (inner.t === 'int' || inner.t === 'float') && !/(?:[0-9_])([ui](8|16|32|64|128|size)|f32|f64)$/.test(inner.text);
}

/** 分支类型合并：同一 Option/Result 的缺失类型参数由另一分支补全（如 None 与 Some(T)）。 */
function mergeSem(a: Sem, b: Sem): Sem | null {
  if (semKey(a) === semKey(b)) return a;
  if (a.k === 'unres' && b.k === 'unres') return a;
  if (a.k === 'ext' && b.k === 'ext' && a.key === b.key && (a.key === 'std::Option' || a.key === 'std::Result')) {
    const len = Math.max(a.args.length, b.args.length);
    const args: Sem[] = [];
    for (let i = 0; i < len; i++) {
      const x = a.args[i];
      const y = b.args[i];
      if (x && y) {
        const m = mergeSem(x, y);
        if (!m) return null;
        args.push(m);
      } else if (x ?? y) args.push((x ?? y)!);
      else return null;
    }
    return { ...a, args };
  }
  return null;
}

export function exprText(e: Expr): string {
  switch (e.k) {
    case 'str': return JSON.stringify(e.v);
    case 'format': return `format!(${JSON.stringify(e.template)}, ..)`;
    case 'path': return e.text;
    case 'ref': return `&${exprText(e.inner)}`;
    case 'struct': return `${rtypeText(e.ty)} { .. }`;
    case 'call': return `${exprText(e.callee)}(..)`;
    case 'method': return `${exprText(e.recv)}.${e.name}(..)`;
    case 'field': return `${exprText(e.recv)}.${e.name}`;
    case 'macro': return `${e.name}!(..)`;
    case 'json': return 'json!(..)';
    case 'unit': return '()';
    case 'lit': return e.text;
    case 'try': return `${exprText(e.inner)}?`;
    case 'cast': return `as ${rtypeText(e.ty)}`;
    case 'array': return '[..]';
    case 'vec': return 'vec![..]';
    case 'tuple': return '(..)';
    case 'binary': return `${exprText(e.left)} ${e.op} ${exprText(e.right)}`;
    case 'other': return e.text.slice(0, 60);
    case 'located': return exprText(e.inner);
    case 'range': return `${exprText(e.start)}..${exprText(e.end)}`;
    case 'closure': return '|..| { .. }';
    case 'index': return `${exprText(e.recv)}[..]`;
    case 'branches': return 'if/match { .. }';
    case 'project': return `pattern(${exprText(e.value)})`;
    case 'element': return `element(${exprText(e.value)})`;
    case 'never': return 'return/break/continue';
  }
}

/** `json!` 字面量 → schema：结构（键、嵌套）确定，表达式值按类型推断，推断不出则 x-unresolved。 */
export function jsonLitSchema(lit: JsonLit, fn: FnDef, ea: EventAnalyzer, sb: SchemaBuilder, pos: number): JsonSchema {
  switch (lit.k) {
    case 'null': return { type: 'null' };
    case 'bool': return { type: 'boolean' };
    case 'str': return { type: 'string' };
    case 'num': return /[.eE]/.test(lit.text) && !/^0x/.test(lit.text) ? { type: 'number' } : { type: 'integer' };
    case 'arr': return { type: 'array', prefixItems: lit.elems.map((x) => jsonLitSchema(x, fn, ea, sb, pos)), items: false };
    case 'obj': {
      const props: Record<string, JsonSchema> = {};
      const req: string[] = [];
      for (const en of lit.entries) {
        if (en.key === null) return sb.unres(`json! object with computed key \`${en.keyText}\``);
        props[en.key] = jsonLitSchema(en.value, fn, ea, sb, pos);
        req.push(en.key);
      }
      return { type: 'object', properties: props, required: req, additionalProperties: false };
    }
    case 'expr': {
      const inferred = lit.expr ? ea.inferType(lit.expr, fn, pos) : null;
      if (inferred && inferred.k !== 'unres' && inferred.k !== 'generic') return sb.schema(inferred, 'ser');
      const s = simpleExprSem(lit.text, fn, ea, pos);
      if (s) return sb.schema(s, 'ser');
      return sb.unres(`json! value \`${lit.text.slice(0, 80)}\` type not determinable statically`);
    }
  }
}

/** json! 里的值表达式：只认 `ident` / `ident.field` / `&ident` / `ident.clone()` 这类简单形态。 */
function simpleExprSem(text: string, fn: FnDef, ea: EventAnalyzer, pos: number): Sem | null {
  if (/^format!/.test(text)) return { k: 'ext', key: 'std::String', path: 'std::string::String', args: [] };
  const t = text.replace(/^&/, '').replace(/\.clone\(\)$/, '').replace(/\.to_string\(\)$/, '.__to_string');
  const m = /^([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z_][A-Za-z0-9_]*)*)$/.exec(t);
  if (!m) return null;
  let e: Expr = { k: 'path', segs: [m[1]!], text: m[1]! };
  for (const f of m[2]!.split('.').filter(Boolean)) {
    if (f === '__to_string') return { k: 'ext', key: 'std::String', path: 'std::string::String', args: [] };
    e = { k: 'field', recv: e, name: f };
  }
  const s = ea.inferType(e, fn, pos);
  return s && s.k !== 'unres' && s.k !== 'generic' ? s : null;
}

export { semText };
export type { Owner, RType };
