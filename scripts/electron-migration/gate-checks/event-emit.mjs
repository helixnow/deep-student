#!/usr/bin/env node
// 事件可达性门禁：src/ 生产代码里 listen/once（@tauri-apps/api/event、窗口对象、透传事件名的包装函数）
// 监听的事件名，必须能由某个发射点产生。发射点静态扫描 host/、electron/ 与 src/ 生产代码中
// 被调函数名形如 emit/send/dispatch/deliver/publish/broadcast/sink 的调用，其任一可解析实参都算候选事件名
// （事件名常经注入的 sink 回调或 send/dispatch 包装层层转发，按名字过近似：只会漏报缺口，不会误报）。
// 事件名可由字面量、作用域 const、跨文件导入的 const/对象表/enum、模板字符串与 + 拼接、
// 返回事件名的函数/方法/getter 调用解析；
// 无法静态确定的片段视为通配，两侧模式互相可匹配即算覆盖；完全动态的发射点不参与覆盖。
// 监听名无法静态确定的调用点（包装函数本身等）记为 dynamic-event，须在白名单（基线）里。
// 现存缺口列在 event-emit-baseline.json（按 规则+文件+事件名/函数 计数）；超出基线的出现即为新增问题。
//
//   node scripts/electron-migration/gate-checks/event-emit.mjs [--check] [--json] [--root <dir>]
//   node scripts/electron-migration/gate-checks/event-emit.mjs --write-baseline   按现状重写基线（保留已有 reason；新增项须审阅）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, files, production, source, ts, unwrap, walk } from './common.mjs';
import { enclosingFunctionNode, enclosingName, lineOf, namedFunction, propName, resolveConst } from './ast.mjs';
import { applyCountBaseline, countBaselineEntries } from './baseline.mjs';
import { frontendFiles } from './frontend-invoke.mjs';

export const BASELINE_FILE = 'scripts/electron-migration/gate-checks/event-emit-baseline.json';
const EVENT_MODULE = '@tauri-apps/api/event';
const LISTEN_NAMES = new Set(['listen', 'once']);
const WINDOW_FACTORIES = new Set(['getCurrentWindow', 'getCurrentWebviewWindow', 'getCurrentWebview', 'getByLabel']);
const WINDOW_CLASSES = new Set(['WebviewWindow', 'Window', 'Webview']);
const EMITTER_CALLEE = /emit|send|dispatch|deliver|publish|broadcast|sink/i;
const MAX_PATTERNS = 64;
/** 模式：字符串片段与通配（null）交替的数组。 */
const HOLE = null;

// ------------------------------------------------------------------ 源文件索引与跨文件常量解析

const MODULE_EXTS = ['', '.ts', '.tsx', '.mts', '.mjs', '.js', '/index.ts', '/index.tsx', '/index.mjs', '/index.js'];

function indexSources(entries) {
  const units = entries.map(({ file, text }) => {
    const sf = source(file, text);
    const imports = new Map();
    const namespaces = new Map();
    const topConsts = new Map();
    const enums = new Map();
    const functions = new Map();
    const reexports = [];
    for (const s of sf.statements) {
      if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)) {
        const spec = s.moduleSpecifier.text;
        const b = s.importClause?.namedBindings;
        if (b && ts.isNamespaceImport(b)) namespaces.set(b.name.text, spec);
        if (b && ts.isNamedImports(b)) for (const el of b.elements) imports.set(el.name.text, { spec, name: (el.propertyName ?? el.name).text });
      } else if (ts.isExportDeclaration(s) && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier)) {
        const names = s.exportClause && ts.isNamedExports(s.exportClause)
          ? new Map(s.exportClause.elements.map((el) => [el.name.text, (el.propertyName ?? el.name).text]))
          : null;
        reexports.push({ spec: s.moduleSpecifier.text, names });
      } else if (ts.isVariableStatement(s) && s.declarationList.flags & ts.NodeFlags.Const) {
        for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) topConsts.set(d.name.text, d.initializer);
      } else if (ts.isEnumDeclaration(s)) enums.set(s.name.text, s);
      else if (ts.isFunctionDeclaration(s) && s.name) functions.set(s.name.text, s);
    }
    return { file, sf, imports, namespaces, topConsts, enums, functions, reexports };
  });
  const byFile = new Map(units.map((u) => [u.file, u]));
  return { units, byFile };
}

function resolveModule(index, from, spec) {
  let base;
  if (spec.startsWith('@/')) base = `src/${spec.slice(2)}`;
  else if (spec.startsWith('.')) base = path.posix.join(path.posix.dirname(from), spec);
  else return null;
  const stems = [base, base.replace(/\.js$/, '.ts'), base.replace(/\.mjs$/, '.mts')];
  for (const stem of stems) for (const ext of MODULE_EXTS) if (index.byFile.has(stem + ext)) return index.byFile.get(stem + ext);
  return null;
}

/** 模块导出名 → 声明节点（const 初始值、enum 或函数声明），沿 export … from 追踪。 */
function exportedDecl(index, unit, name, depth = 0) {
  if (!unit || depth > 6) return null;
  if (unit.topConsts.has(name)) return unit.topConsts.get(name);
  if (unit.enums.has(name)) return unit.enums.get(name);
  if (unit.functions.has(name)) return unit.functions.get(name);
  const imported = unit.imports.get(name);
  if (imported) return exportedDecl(index, resolveModule(index, unit.file, imported.spec), imported.name, depth + 1);
  for (const r of unit.reexports) {
    const target = r.names ? r.names.get(name) : name;
    if (!target) continue;
    const found = exportedDecl(index, resolveModule(index, unit.file, r.spec), target, depth + 1);
    if (found) return found;
  }
  return null;
}

const unitOf = (index, node) => index.byFile.get(node.getSourceFile().fileName);

/** 标识符 → 声明节点：作用域内 const/函数声明、本文件 enum、跨文件导入。 */
function declOf(index, id) {
  const local = resolveConst(id) ?? localFunction(id);
  if (local) return local;
  const unit = unitOf(index, id);
  if (!unit) return null;
  if (unit.enums.has(id.text)) return unit.enums.get(id.text);
  const imported = unit.imports.get(id.text);
  return imported ? exportedDecl(index, resolveModule(index, unit.file, imported.spec), imported.name) : null;
}

function localFunction(id) {
  for (let p = id.parent; p; p = p.parent) {
    const statements = ts.isSourceFile(p) || ts.isBlock(p) || ts.isModuleBlock(p) ? p.statements : null;
    const fn = statements?.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === id.text);
    if (fn) return fn;
  }
  return null;
}

const isFunctionValue = (n) => !!n && (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n));

/**
 * this.member → 所在类中同名的方法 / getter，或字段的取值表达式（初始值与构造函数里的 `this.x = …`）。
 * 返回 { fn } 或 { values }。
 */
function classMember(expr) {
  if (!ts.isPropertyAccessExpression(expr) || expr.expression.kind !== ts.SyntaxKind.ThisKeyword) return null;
  let cls = expr.parent;
  while (cls && !ts.isClassDeclaration(cls) && !ts.isClassExpression(cls)) cls = cls.parent;
  if (!cls) return null;
  const name = expr.name.text;
  const member = cls.members.find((m) => m.name && ts.isIdentifier(m.name) && m.name.text === name);
  if (member && (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member))) return { fn: member };
  const values = member && ts.isPropertyDeclaration(member) && member.initializer ? [member.initializer] : [];
  for (const ctor of cls.members.filter(ts.isConstructorDeclaration)) {
    walk(ctor, (n) => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left)
        && n.left.expression.kind === ts.SyntaxKind.ThisKeyword && n.left.name.text === name) values.push(n.right);
    });
  }
  if (values.length === 1 && isFunctionValue(unwrapAll(values[0]))) return { fn: unwrapAll(values[0]) };
  return values.length ? { values } : null;
}

/** 函数体所有 return（不含嵌套函数）的事件名模式；参数等不可知片段为通配。 */
function returnPatterns(index, fn, depth) {
  if (!isFunctionValue(fn) || !fn.body) return null;
  const exprs = [];
  if (!ts.isBlock(fn.body)) exprs.push(fn.body);
  else {
    const visit = (n) => {
      if (n !== fn.body && (ts.isFunctionLike(n) || ts.isClassLike(n))) return;
      if (ts.isReturnStatement(n) && n.expression) exprs.push(n.expression);
      ts.forEachChild(n, visit);
    };
    visit(fn.body);
  }
  const all = exprs.flatMap((x) => patternsOf(index, x, depth + 1) ?? [[HOLE]]);
  return all.length && !all.every(isPureHole) ? all : null;
}

/** 表达式 → 对象字面量或 enum 声明（事件名表）。 */
function tableOf(index, expr, depth) {
  const e = unwrapAll(expr);
  if (!e || depth > 8) return null;
  if (ts.isObjectLiteralExpression(e) || ts.isEnumDeclaration(e)) return e;
  if (ts.isIdentifier(e)) return tableOf(index, declOf(index, e), depth + 1);
  if (ts.isCallExpression(e) && /^(?:Object\.)?freeze$/.test(e.expression.getText()) && e.arguments[0]) return tableOf(index, e.arguments[0], depth + 1);
  if (ts.isPropertyAccessExpression(e)) {
    const unit = unitOf(index, e);
    if (ts.isIdentifier(e.expression) && unit?.namespaces.has(e.expression.text)) {
      return tableOf(index, exportedDecl(index, resolveModule(index, unit.file, unit.namespaces.get(e.expression.text)), e.name.text), depth + 1);
    }
    const member = memberOf(tableOf(index, e.expression, depth + 1), e.name.text);
    return member ? tableOf(index, member, depth + 1) : null;
  }
  return null;
}

function memberOf(table, name) {
  if (!table) return null;
  if (ts.isEnumDeclaration(table)) return table.members.find((m) => m.name.getText().replace(/^['"]|['"]$/g, '') === name)?.initializer ?? null;
  const prop = table.properties.find((p) => propName(p) === name);
  return prop && ts.isPropertyAssignment(prop) ? prop.initializer : null;
}

function memberValues(table) {
  if (!table) return null;
  if (ts.isEnumDeclaration(table)) return table.members.map((m) => m.initializer ?? null);
  return table.properties.map((p) => (ts.isPropertyAssignment(p) ? p.initializer : null));
}

function unwrapAll(n) {
  let e = unwrap(n);
  while (e && ts.isSatisfiesExpression?.(e)) e = unwrap(e.expression);
  return e;
}

function normalize(pattern) {
  const out = [];
  for (const part of pattern) {
    const last = out.length ? out[out.length - 1] : undefined;
    if (part === HOLE) { if (last !== HOLE || out.length === 0) out.push(HOLE); }
    else if (part === '') continue;
    else if (typeof last === 'string') out[out.length - 1] = last + part;
    else out.push(part);
  }
  return out;
}

function concat(lefts, rights) {
  const out = [];
  for (const l of lefts) for (const r of rights) { out.push([...l, ...r]); if (out.length >= MAX_PATTERNS) return out; }
  return out;
}

/** 事件名表达式 → 所有可能的模式；完全无法解析时返回 null。 */
function patternsOf(index, expr, depth = 0) {
  const e = unwrapAll(expr);
  if (!e || depth > 10) return null;
  if (ts.isStringLiteralLike(e)) return [[e.text]];
  if (ts.isTemplateExpression(e)) {
    let acc = [[e.head.text]];
    for (const span of e.templateSpans) {
      acc = concat(acc, patternsOf(index, span.expression, depth + 1) ?? [[HOLE]]);
      acc = concat(acc, [[span.literal.text]]);
    }
    return acc.map(normalize);
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = patternsOf(index, e.left, depth + 1);
    const r = patternsOf(index, e.right, depth + 1);
    if (!l && !r) return null;
    return concat(l ?? [[HOLE]], r ?? [[HOLE]]).map(normalize);
  }
  if (ts.isConditionalExpression(e)) {
    const a = patternsOf(index, e.whenTrue, depth + 1);
    const b = patternsOf(index, e.whenFalse, depth + 1);
    return a && b ? [...a, ...b] : null;
  }
  if (ts.isIdentifier(e)) {
    const decl = declOf(index, e);
    return decl && !ts.isEnumDeclaration(decl) && !isFunctionValue(decl) ? patternsOf(index, decl, depth + 1) : null;
  }
  if (ts.isCallExpression(e)) {
    const callee = unwrapAll(e.expression);
    const fn = ts.isIdentifier(callee) ? declOf(index, callee) : classMember(callee)?.fn;
    return isFunctionValue(fn) ? returnPatterns(index, fn, depth) : null;
  }
  if (ts.isPropertyAccessExpression(e)) {
    const field = classMember(e);
    if (field?.fn) return ts.isGetAccessorDeclaration(field.fn) ? returnPatterns(index, field.fn, depth) : null;
    if (field?.values) {
      const all = field.values.map((v) => patternsOf(index, v, depth + 1));
      return all.every(Boolean) ? all.flat() : null;
    }
    const unit = unitOf(index, e);
    if (ts.isIdentifier(e.expression) && unit?.namespaces.has(e.expression.text)) {
      const decl = exportedDecl(index, resolveModule(index, unit.file, unit.namespaces.get(e.expression.text)), e.name.text);
      return decl && !ts.isEnumDeclaration(decl) && !isFunctionValue(decl) ? patternsOf(index, decl, depth + 1) : null;
    }
    const member = memberOf(tableOf(index, e.expression, depth + 1), e.name.text);
    return member ? patternsOf(index, member, depth + 1) : null;
  }
  if (ts.isElementAccessExpression(e)) {
    const values = memberValues(tableOf(index, e.expression, depth + 1));
    if (!values?.length) return null;
    const all = values.map((v) => (v ? patternsOf(index, v, depth + 1) : null));
    return all.every(Boolean) ? all.flat() : null;
  }
  return null;
}

const isPureHole = (p) => p.every((x) => x === HOLE);
/** 发射侧模式至少要有一段含 3 个连续字母数字的静态片段，否则 `${…}:${…}` 之类会吞掉任何监听名。 */
const informative = (p) => p.some((x) => typeof x === 'string' && /[A-Za-z0-9]{3}/.test(x));
export const display = (p) => p.map((x) => (x === HOLE ? '${…}' : x)).join('');
const SAMPLE_HOLE = '\u0007';
const sample = (p) => p.map((x) => (x === HOLE ? SAMPLE_HOLE : x)).join('');
const regexOf = (p) => new RegExp(`^${p.map((x) => (x === HOLE ? '[^]*' : x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('')}$`);

/** 监听模式能否由某个发射模式产生（任一方向的通配可吸收另一方的片段）。 */
export function matches(listener, emitters) {
  const lr = regexOf(listener);
  const ls = sample(listener);
  return emitters.some((e) => regexOf(e).test(ls) || lr.test(sample(e)));
}

// ------------------------------------------------------------------ 调用点识别

const calleeName = (call) => {
  const e = unwrap(call.expression);
  return ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;
};

function isWindowish(index, expr, depth = 0) {
  const e = unwrapAll(expr);
  if (!e || depth > 6) return false;
  if (ts.isAwaitExpression(e)) return isWindowish(index, e.expression, depth + 1);
  if (ts.isCallExpression(e)) return WINDOW_FACTORIES.has(calleeName(e) ?? '');
  if (ts.isNewExpression(e)) return ts.isIdentifier(e.expression) && WINDOW_CLASSES.has(e.expression.text);
  if (ts.isIdentifier(e)) return isWindowish(index, resolveConst(e), depth + 1);
  return false;
}

const DYNAMIC_EVENT_IMPORT = /import\(\s*['"]@tauri-apps\/api\/event['"]\s*\)/;

/** `import('@tauri-apps/api/event')`（可带 await、经 const），或调用返回它的本地箭头函数（`const events = () => import(…)`）。 */
function isEventModule(expr, depth = 0) {
  const e = unwrapAll(expr);
  if (!e || depth > 6) return false;
  if (ts.isAwaitExpression(e)) return isEventModule(e.expression, depth + 1);
  if (ts.isIdentifier(e)) return isEventModule(resolveConst(e), depth + 1);
  if (!ts.isCallExpression(e)) return false;
  if (e.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const spec = e.arguments[0];
    return !!spec && ts.isStringLiteralLike(spec) && spec.text === EVENT_MODULE;
  }
  const callee = unwrap(e.expression);
  const loader = ts.isIdentifier(callee) ? unwrapAll(resolveConst(callee)) : null;
  return !!loader && (ts.isArrowFunction(loader) || ts.isFunctionExpression(loader)) && !ts.isBlock(loader.body) && isEventModule(loader.body, depth + 1);
}

/** 函数是否是 `<事件模块>.then(fn)` 的回调。 */
function isEventModuleCallback(fn) {
  const call = fn.parent;
  if (!call || !ts.isCallExpression(call) || call.arguments[0] !== fn) return false;
  const callee = unwrap(call.expression);
  return ts.isPropertyAccessExpression(callee) && callee.name.text === 'then' && isEventModule(callee.expression);
}

/** 由最近的函数参数声明的标识符：{ fn, prop }，prop 为解构时取的属性名（整参数为 null）。 */
function declaringParameter(id) {
  for (let p = id.parent; p; p = p.parent) {
    if (!ts.isFunctionLike(p) || !p.parameters) continue;
    for (const param of p.parameters) {
      if (ts.isIdentifier(param.name) && param.name.text === id.text) return { fn: p, prop: null };
      if (!ts.isObjectBindingPattern(param.name)) continue;
      const el = param.name.elements.find((x) => ts.isIdentifier(x.name) && x.name.text === id.text);
      const prop = el && (el.propertyName ?? el.name);
      if (prop) return { fn: p, prop: ts.isIdentifier(prop) || ts.isStringLiteral(prop) ? prop.text : undefined };
    }
  }
  return null;
}

/** 经动态导入事件模块拿到的 listen/once：解构 await 结果或 .then 回调参数，或模块对象上的成员调用。 */
function isDynamicEventListen(call) {
  const e = unwrap(call.expression);
  if (ts.isIdentifier(e)) {
    const binding = destructuredFrom(e);
    if (binding) return LISTEN_NAMES.has(binding.prop) && isEventModule(binding.init);
    const param = declaringParameter(e);
    return !!param?.prop && LISTEN_NAMES.has(param.prop) && isEventModuleCallback(param.fn);
  }
  if (!ts.isPropertyAccessExpression(e) || !LISTEN_NAMES.has(e.name.text)) return false;
  const recv = unwrap(e.expression);
  if (isEventModule(recv)) return true;
  const param = ts.isIdentifier(recv) ? declaringParameter(recv) : null;
  return !!param && param.prop === null && isEventModuleCallback(param.fn);
}

/**
 * 监听调用点：直接调用（base 为真，事件名在首参）或包装调用。把某个参数原样转发为事件名的函数识别为包装，
 * 记下该参数位置（迭代到不动点，包装的包装也算）。返回 eventArgOf(call, unit)：非监听调用返回 undefined。
 */
function forwardingCalls(index, base) {
  const local = new Map(index.units.map((u) => [u.file, new Map()]));
  const exported = new Map();
  const methods = new Map();
  const wrapperIndex = (call, unit) => {
    const e = unwrap(call.expression);
    if (ts.isIdentifier(e)) {
      if (local.get(unit.file).has(e.text)) return local.get(unit.file).get(e.text);
      const imported = unit.imports.get(e.text);
      return imported !== undefined ? exported.get(imported.name) : undefined;
    }
    return ts.isPropertyAccessExpression(e) ? methods.get(e.name.text) : undefined;
  };
  const eventArgOf = (call, unit) => {
    if (base(call, unit)) return call.arguments[0] ?? null;
    const i = wrapperIndex(call, unit);
    return i === undefined ? undefined : call.arguments[i] ?? null;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const u of index.units) {
      for (const call of u.calls) {
        const arg = eventArgOf(call, u);
        const id = arg && unwrap(arg);
        if (!id || !ts.isIdentifier(id)) continue;
        const fn = enclosingFunctionNode(call);
        const i = fn ? fn.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === id.text) : -1;
        if (i < 0) continue;
        const named = namedFunction(fn);
        if (!named) continue;
        const map = named.kind === 'exported' ? exported : named.kind === 'method' ? methods : local.get(u.file);
        if (!map.has(named.name)) { map.set(named.name, i); changed = true; }
      }
    }
  }
  return eventArgOf;
}

function withCalls(index) {
  for (const u of index.units) {
    if (u.calls) continue;
    u.calls = [];
    walk(u.sf, (n) => { if (ts.isCallExpression(n) && n.arguments.length > 0) u.calls.push(n); });
  }
  return index;
}

const asIndex = (entriesOrIndex) => withCalls(Array.isArray(entriesOrIndex) ? indexSources(entriesOrIndex) : entriesOrIndex);

/**
 * 事件名经对象字段或 hook 返回的方法才交给 listen、包装识别跟不到的注册入口（审计 V03）。调用入口的地方按监听点处理，
 * 事件名在首参；把参数转交给入口的函数照常识别为包装（registerDomainListener 等）。入口内部的 listen 仍是 dynamic-event。
 *   export：该文件导出的函数；hook + member：调用该 hook 得到的对象上的方法（`const { attach } = hook()` 或 `x.attach`）。
 */
export const REGISTRATION_ENTRIES = [
  { file: 'src/features/workbench/core/eventHub.ts', export: 'hubListen' },
  { file: 'src/features/workbench/core/eventHub.ts', export: 'hubListenKeyed' },
  { file: 'src/hooks/useTauriEventListener.ts', hook: 'useTauriEventListener', member: 'attach' },
];

/** 标识符是否指向 file 中声明的函数 name（沿导入与 export … from）。 */
function isFunctionOf(index, id, file, name) {
  const decl = declOf(index, id);
  return !!decl && ts.isFunctionDeclaration(decl) && decl.name?.text === name && decl.getSourceFile().fileName === file;
}

/** `const { prop: id } = init` / `const { id } = init` → { prop, init }（作用域内最近的一处）。 */
function destructuredFrom(id) {
  for (let p = id.parent; p; p = p.parent) {
    const statements = ts.isSourceFile(p) || ts.isBlock(p) || ts.isModuleBlock(p) ? p.statements : null;
    if (!statements) continue;
    for (const s of statements) {
      if (!ts.isVariableStatement(s)) continue;
      for (const d of s.declarationList.declarations) {
        if (!ts.isObjectBindingPattern(d.name) || !d.initializer) continue;
        const el = d.name.elements.find((x) => ts.isIdentifier(x.name) && x.name.text === id.text);
        const prop = el && (el.propertyName ?? el.name);
        if (prop && (ts.isIdentifier(prop) || ts.isStringLiteral(prop))) return { prop: prop.text, init: d.initializer };
      }
    }
  }
  return null;
}

function isRegistrationEntry(index, call) {
  const e = unwrap(call.expression);
  return REGISTRATION_ENTRIES.some((entry) => {
    if (entry.export) return ts.isIdentifier(e) && isFunctionOf(index, e, entry.file, entry.export);
    const hookCall = (init) => {
      const c = init && unwrapAll(init);
      return !!c && ts.isCallExpression(c) && ts.isIdentifier(unwrap(c.expression)) && isFunctionOf(index, unwrap(c.expression), entry.file, entry.hook);
    };
    if (ts.isPropertyAccessExpression(e)) {
      const recv = unwrap(e.expression);
      return e.name.text === entry.member && ts.isIdentifier(recv) && hookCall(resolveConst(recv));
    }
    const binding = ts.isIdentifier(e) ? destructuredFrom(e) : null;
    return !!binding && binding.prop === entry.member && hookCall(binding.init);
  });
}

/** src/ 中的监听点：{ sites: [{ file, line, function, patterns | null, expression }] }。 */
export function scanListeners(entriesOrIndex, onlyFiles = null) {
  const index = asIndex(entriesOrIndex);
  const eventBindings = new Map(index.units.map((u) => {
    const names = new Set();
    for (const [local, { spec, name }] of u.imports) if (spec === EVENT_MODULE && LISTEN_NAMES.has(name)) names.add(local);
    const namespaces = new Set([...u.namespaces].filter(([, spec]) => spec === EVENT_MODULE).map(([local]) => local));
    return [u.file, { names, namespaces, dynamic: DYNAMIC_EVENT_IMPORT.test(u.sf.text) }];
  }));
  const base = (call, unit) => {
    const e = unwrap(call.expression);
    const b = eventBindings.get(unit.file);
    if (ts.isIdentifier(e) && b.names.has(e.text)) return true;
    if (ts.isPropertyAccessExpression(e) && LISTEN_NAMES.has(e.name.text)) {
      const recv = unwrap(e.expression);
      if ((ts.isIdentifier(recv) && b.namespaces.has(recv.text)) || isWindowish(index, recv)) return true;
    }
    if (b.dynamic && isDynamicEventListen(call)) return true;
    return isRegistrationEntry(index, call);
  };
  const eventArgOf = forwardingCalls(index, base);
  const sites = [];
  for (const u of index.units) {
    if (onlyFiles && !onlyFiles.has(u.file)) continue;
    for (const call of u.calls) {
      const arg = eventArgOf(call, u);
      if (!arg) continue;
      const patterns = patternsOf(index, arg);
      const resolved = patterns && !patterns.every(isPureHole) ? patterns.filter((p) => !isPureHole(p)) : null;
      sites.push({ file: u.file, line: lineOf(u.sf, call), function: enclosingName(call), patterns: resolved, expression: unwrap(arg).getText(u.sf).slice(0, 120) });
    }
  }
  return { sites };
}

/** 发射点：{ patterns, sites, dynamic }（dynamic 为没有任何可解析实参的发射调用数）。 */
export function scanEmitters(entriesOrIndex, onlyFiles = null) {
  const index = asIndex(entriesOrIndex);
  const patterns = [];
  let sites = 0;
  let dynamic = 0;
  for (const u of index.units) {
    if (onlyFiles && !onlyFiles.has(u.file)) continue;
    for (const call of u.calls) {
      if (!EMITTER_CALLEE.test(calleeName(call) ?? '')) continue;
      sites += 1;
      const found = call.arguments.flatMap((arg) => (patternsOf(index, arg) ?? []).filter(informative));
      if (found.length === 0) dynamic += 1;
      patterns.push(...found);
    }
  }
  return { patterns, sites, dynamic };
}

// ------------------------------------------------------------------ 判定与基线

export function judge(listeners, emitters) {
  const findings = [];
  for (const s of listeners.sites) {
    if (!s.patterns) {
      findings.push({ rule: 'dynamic-event', file: s.file, line: s.line, function: s.function, event: null, message: `监听的事件名不是静态可知的（${s.expression}），须在白名单中` });
      continue;
    }
    for (const p of s.patterns) {
      if (matches(p, emitters.patterns)) continue;
      findings.push({ rule: 'unemitted-event', file: s.file, line: s.line, function: s.function, event: display(p), message: `监听事件 ${display(p)}，但 host/electron/src 中没有可产生该事件名的 emit 发射点` });
    }
  }
  return findings;
}

export const findingKey = (f) => [f.rule, f.file, f.rule === 'dynamic-event' ? f.function : f.event].join('\u0000');
const entryKey = (e) => findingKey({ rule: e.rule, file: e.file, function: e.function, event: e.event ?? null });

export const applyBaseline = (findings, baseline) => applyCountBaseline(findings, baseline, entryKey);

export const baselineFrom = (findings, previous = { entries: [] }) => countBaselineEntries(
  findings,
  previous,
  entryKey,
  (f) => ({ rule: f.rule, file: f.file, ...(f.rule === 'dynamic-event' ? { function: f.function } : { event: f.event }) }),
  [(e) => e.rule, (e) => e.file, (e) => e.event ?? e.function],
);

const SCRIPT = /\.(?:[cm]?[jt]sx?)$/;

export function emitterFiles(root = ROOT) {
  const backend = [...files(root, 'host'), ...files(root, 'electron')]
    .filter((f) => SCRIPT.test(f) && production(f) && !f.endsWith('.d.ts') && !f.endsWith('.d.mts') && !f.includes('/e2e/') && !f.includes('/node_modules/'));
  return [...backend, ...frontendFiles(root)];
}

export function run({ root = ROOT } = {}) {
  const listenerFiles = frontendFiles(root);
  const all = [...new Set([...listenerFiles, ...emitterFiles(root)])];
  const index = asIndex(all.map((file) => ({ file, text: fs.readFileSync(path.join(root, file), 'utf8') })));
  const listeners = scanListeners(index, new Set(listenerFiles));
  const emitters = scanEmitters(index);
  const findings = judge(listeners, emitters);
  const baselinePath = path.join(root, BASELINE_FILE);
  const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : { entries: [] };
  const { fresh, stale } = applyBaseline(findings, baseline);
  return {
    gate: 'event-emit',
    findings: [...fresh, ...stale.map((e) => ({ ...e, line: 1, message: `基线项已不再出现（现 ${e.present}/${e.count ?? 1}），请从基线删除` }))],
    all: findings,
    summary: {
      listeners: listeners.sites.length,
      emitters: emitters.sites,
      dynamicEmitters: emitters.dynamic,
      existing: findings.length,
      unemitted: findings.filter((f) => f.rule === 'unemitted-event').length,
      dynamic: findings.filter((f) => f.rule === 'dynamic-event').length,
      baselined: findings.length - fresh.length,
      fresh: fresh.length,
      stale: stale.length,
    },
    baseline,
  };
}

function main(argv) {
  const root = argv.includes('--root') ? path.resolve(argv[argv.indexOf('--root') + 1]) : ROOT;
  const result = run({ root });
  if (argv.includes('--write-baseline')) {
    const entries = baselineFrom(result.all, result.baseline);
    fs.writeFileSync(path.join(root, BASELINE_FILE), `${JSON.stringify({ ...result.baseline, entries }, null, 1)}\n`);
    console.log(`wrote ${entries.length} baseline entries (${result.all.length} findings)`);
    return;
  }
  if (argv.includes('--json')) console.log(JSON.stringify({ ...result, baseline: undefined }, null, 2));
  else {
    const s = result.summary;
    console.log(`event-emit: ${s.listeners} listen sites vs ${s.emitters} emit sites (${s.dynamicEmitters} fully dynamic); ${s.existing} known gaps (${s.unemitted} unemitted, ${s.dynamic} dynamic), ${s.baselined} baselined, ${s.fresh} new, ${s.stale} stale baseline entries`);
    for (const f of result.findings) console.log(`${f.file}:${f.line ?? 1} [${f.rule}${f.severity === 'info' ? ', info' : ''}] ${f.message}`);
  }
  if (argv.includes('--check') && result.findings.some((f) => f.severity === 'error')) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.stack); process.exitCode = 2; }
}
