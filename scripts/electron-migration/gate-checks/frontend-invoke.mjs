#!/usr/bin/env node
// 前端 invoke 契约门禁：src/ 生产代码里以字面量命令名调用 invoke（及透传 (command, args) 的包装函数）时，
// 命令名必须在 contracts/ipc/*.json 中，对象字面量参数的键必须是契约 args[].key（kernel 按契约取键、
// 静默忽略多余键，host/kernel/contracts.ts checkArgs）；参数键完全已知时还要求必填键齐全。
// 命令名不是静态可知的调用点（包装函数本身、DI 注入的 invoke 等）必须在白名单里。
// 现存问题列在 frontend-invoke-baseline.json（按 规则+文件+命令/函数+键 计数）；超出基线的出现即为新增问题。
//
//   node scripts/electron-migration/gate-checks/frontend-invoke.mjs [--check] [--json] [--root <dir>]
//   node scripts/electron-migration/gate-checks/frontend-invoke.mjs --write-baseline   按现状重写基线（保留已有 reason；新增项须审阅）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, files, production, source, ts, unwrap, walk } from './common.mjs';
import { enclosingFunctionNode, enclosingName, lineOf, namedFunction, propName, resolveConst } from './ast.mjs';
import { applyCountBaseline, countBaselineEntries } from './baseline.mjs';

export const BASELINE_FILE = 'scripts/electron-migration/gate-checks/frontend-invoke-baseline.json';
const SCRIPT = /\.(?:[cm]?[jt]sx?)$/;

/** contracts/ipc/*.json 按命令名索引（含 F1 `hostNative` 段的内核自有命令）。 */
export function loadCommandContracts(root = ROOT) {
  const dir = path.join(root, 'contracts/ipc');
  const commands = new Map();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && !x.startsWith('_')).sort()) {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const c of [...(doc.commands ?? []), ...(doc.hostNative?.commands ?? [])]) commands.set(c.name, c);
  }
  return commands;
}

/** 命令名表达式 → 所有可能的字面量；无法静态确定时返回 null。 */
function commandNames(expr, depth = 0) {
  if (!expr || depth > 8) return null;
  const e = unwrap(expr);
  if (ts.isStringLiteralLike(e)) return [e.text];
  if (ts.isConditionalExpression(e)) {
    const a = commandNames(e.whenTrue, depth + 1);
    const b = commandNames(e.whenFalse, depth + 1);
    return a && b ? [...new Set([...a, ...b])] : null;
  }
  if (ts.isIdentifier(e)) return commandNames(resolveConst(e), depth + 1);
  const table = (obj) => {
    const init = ts.isIdentifier(obj) ? resolveConst(obj) : null;
    const lit = init && unwrap(init);
    return lit && ts.isObjectLiteralExpression(lit) ? lit : null;
  };
  if (ts.isPropertyAccessExpression(e)) {
    const lit = table(e.expression);
    const prop = lit?.properties.find((p) => propName(p) === e.name.text);
    return prop && ts.isPropertyAssignment(prop) ? commandNames(prop.initializer, depth + 1) : null;
  }
  if (ts.isElementAccessExpression(e)) {
    const lit = table(e.expression);
    if (!lit) return null;
    const values = lit.properties.map((p) => (ts.isPropertyAssignment(p) ? commandNames(p.initializer, depth + 1) : null));
    return values.length && values.every(Boolean) ? [...new Set(values.flat())] : null;
  }
  return null;
}

/** 参数对象字面量的键；`open` 表示含无法展开的 spread/计算键/非字面量，键集合可能不完整。 */
function argKeys(expr) {
  const keys = [];
  let open = false;
  const visit = (node) => {
    const e = unwrap(node);
    if (ts.isConditionalExpression(e)) { visit(e.whenTrue); visit(e.whenFalse); return; }
    if (ts.isBinaryExpression(e) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(e.operatorToken.kind)) { visit(e.right); return; }
    if (!ts.isObjectLiteralExpression(e)) {
      if (!(e.kind === ts.SyntaxKind.NullKeyword || e.kind === ts.SyntaxKind.FalseKeyword || (ts.isIdentifier(e) && e.text === 'undefined'))) open = true;
      return;
    }
    for (const p of e.properties) {
      if (ts.isSpreadAssignment(p)) { visit(p.expression); continue; }
      const k = propName(p);
      if (k === null) open = true;
      else keys.push({ key: k, node: p });
    }
  };
  visit(expr);
  return { keys, open };
}

/** 文件内直接可知的 invoke 绑定：import 的 invoke（含重命名）、非函数的 invoke 绑定、默认值为 invoke 的参数、引用它们的 const。 */
function baseInvokers(sf) {
  const names = new Set();
  const functionNamedInvoke = { seen: false };
  walk(sf, (n) => {
    if (ts.isImportSpecifier(n) && (n.propertyName ?? n.name).text === 'invoke') names.add(n.name.text);
    if (ts.isParameter(n) && ts.isIdentifier(n.name) && n.name.text === 'invoke') names.add('invoke');
    if (ts.isBindingElement(n) && ts.isIdentifier(n.name) && (n.propertyName ?? n.name).getText() === 'invoke') names.add(n.name.text);
    if (ts.isFunctionDeclaration(n) && n.name?.text === 'invoke') functionNamedInvoke.seen = true;
  });
  let changed = true;
  const refersInvoker = (expr) => {
    const e = expr && unwrap(expr);
    if (!e) return false;
    if (ts.isIdentifier(e)) return names.has(e.text);
    if (ts.isConditionalExpression(e)) return refersInvoker(e.whenTrue) || refersInvoker(e.whenFalse);
    if (ts.isAwaitExpression(e)) return refersInvoker(e.expression);
    if (ts.isPropertyAccessExpression(e)) return e.name.text === 'invoke';
    return false;
  };
  while (changed) {
    changed = false;
    walk(sf, (n) => {
      let name = null;
      let init = null;
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) { name = n.name.text; init = n.initializer; }
      else if (ts.isParameter(n) && ts.isIdentifier(n.name)) { name = n.name.text; init = n.initializer; }
      if (!name || names.has(name) || !init) return;
      const fn = unwrap(init);
      const isFn = ts.isArrowFunction(fn) || ts.isFunctionExpression(fn);
      if (refersInvoker(init) || (name === 'invoke' && !isFn)) { names.add(name); changed = true; }
    });
  }
  return names;
}

function parse(entries) {
  return entries.map(({ file, text, index }) => {
    const sf = source(file, text);
    const calls = [];
    walk(sf, (n) => { if (ts.isCallExpression(n) && n.arguments.length > 0) calls.push(n); });
    return { file, index, sf, calls, invokers: baseInvokers(sf), localWrappers: new Set(), exportedWrappers: new Set(), imports: importedNames(sf) };
  });
}

/** 文本中是否以完整标识符出现任一名字（超集判断：字符串、注释里的同名也算）。 */
function mentionsAny(names) {
  const re = new RegExp(`(?<![\\w$])(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w$])`);
  return (text) => re.test(text);
}

function importedNames(sf) {
  const map = new Map();
  walk(sf, (n) => { if (ts.isImportSpecifier(n)) map.set(n.name.text, (n.propertyName ?? n.name).text); });
  return map;
}

/** 调用是否走 invoke（直接或经已识别的包装）。 */
function isInvokerCall(call, unit, global) {
  const e = unwrap(call.expression);
  if (ts.isIdentifier(e)) {
    const n = e.text;
    if (unit.invokers.has(n) || unit.localWrappers.has(n) || unit.exportedWrappers.has(n)) return true;
    const imported = unit.imports.get(n);
    return imported !== undefined && global.exported.has(imported);
  }
  if (ts.isPropertyAccessExpression(e)) {
    const n = e.name.text;
    return n === 'invoke' || global.methods.has(n) || global.exported.has(n);
  }
  return false;
}

/** 把首参原样转发为命令名的函数识别为包装（迭代到不动点，包装的包装也算）。 */
function detectWrappers(units) {
  const global = { exported: new Set(), methods: new Set() };
  let changed = true;
  while (changed) {
    changed = false;
    for (const u of units) {
      for (const call of u.calls) {
        if (!isInvokerCall(call, u, global)) continue;
        const first = unwrap(call.arguments[0]);
        if (!ts.isIdentifier(first)) continue;
        const fn = enclosingFunctionNode(call);
        const param = fn?.parameters[0];
        if (!param || !ts.isIdentifier(param.name) || param.name.text !== first.text) continue;
        const named = namedFunction(fn);
        if (!named) continue;
        const set = named.kind === 'exported' ? u.exportedWrappers : named.kind === 'method' ? global.methods : u.localWrappers;
        if (!set.has(named.name)) { set.add(named.name); changed = true; }
        if (named.kind === 'exported') global.exported.add(named.name);
      }
    }
  }
  return global;
}

/** 扫描一组源文件，返回原始调用点（不判定）。 */
export function scanSources(entries) {
  // invoke 调用点的被调名必是 invoke、文件内由 invoke 派生的别名，或已识别包装的名字（导入/成员访问），
  // 所以文本里一个都没提到的文件不可能贡献调用点或包装。按名字逐轮扩大解析范围，而不是把整棵 src/ 的
  // 语法树同时留在内存里（全量约 650MB 堆，满载机器上 GC 会把这一扫拖过测试超时）。
  // `\u` 转义的标识符无法按文本匹配，含 `\u` 的文件一律解析。
  const units = [];
  const searched = new Set();
  let rest = entries.map((entry, index) => ({ ...entry, index }));
  let global = { exported: new Set(), methods: new Set() };
  let fresh = ['invoke'];
  while (fresh.length && rest.length) {
    for (const n of fresh) searched.add(n);
    const mentions = mentionsAny(fresh);
    const hit = new Set(rest.filter((e) => e.text.includes('\\u') || mentions(e.text)));
    if (!hit.size) break;
    rest = rest.filter((e) => !hit.has(e));
    units.push(...parse([...hit]));
    global = detectWrappers(units);
    fresh = [...global.exported, ...global.methods].filter((n) => !searched.has(n));
  }
  units.sort((a, b) => a.index - b.index);
  const sites = [];
  for (const u of units) {
    for (const call of u.calls) {
      if (!isInvokerCall(call, u, global)) continue;
      const callee = unwrap(call.expression);
      const site = { file: u.file, line: lineOf(u.sf, call), callee: ts.isIdentifier(callee) ? callee.text : callee.name.text, function: enclosingName(call) };
      const names = commandNames(call.arguments[0]);
      if (!names) {
        sites.push({ ...site, dynamic: true, expression: unwrap(call.arguments[0]).getText(u.sf).slice(0, 120) });
        continue;
      }
      const args = call.arguments[1];
      const keys = args ? argKeys(args) : { keys: [], open: false };
      for (const command of names) sites.push({ ...site, dynamic: false, command, keys: keys.keys.map((k) => ({ key: k.key, line: lineOf(u.sf, k.node) })), open: keys.open });
    }
  }
  return sites;
}

export const scanFile = (file, text) => scanSources([{ file, text }]);

/** 包装函数自行补上的参数键（noteHostCoordinator.invokeWithLease 注入 lease）。 */
const WRAPPER_INJECTS = { invokeWithLease: ['lease'] };

/** 将调用点按契约判定为问题（未套用基线）。 */
export function judge(sites, contracts) {
  const findings = [];
  for (const s of sites) {
    if (s.dynamic) {
      findings.push({ rule: 'dynamic-command', file: s.file, line: s.line, function: s.function, command: null, key: null, message: `命令名不是静态可知的字面量（${s.expression}），须在白名单中` });
      continue;
    }
    const c = contracts.get(s.command);
    if (!c) {
      findings.push({ rule: 'unknown-command', file: s.file, line: s.line, function: s.function, command: s.command, key: null, message: `命令 ${s.command} 不在 contracts/ipc 中` });
      continue;
    }
    // tauri::ipc::Request 命令（staged_upload_append 等）自行解析原始 body，契约 args 为空，不做键检查。
    if ((c.injected ?? []).some((i) => i.kind === 'request')) continue;
    const allowed = new Set(c.args.map((a) => a.key));
    const seen = new Set(WRAPPER_INJECTS[s.callee] ?? []);
    for (const k of s.keys) {
      seen.add(k.key);
      if (!allowed.has(k.key)) {
        findings.push({ rule: 'unknown-arg', file: s.file, line: k.line, function: s.function, command: s.command, key: k.key, message: `${s.command} 的参数 ${k.key} 不在契约中（契约键：${[...allowed].join(', ') || '无'}），会被静默忽略` });
      }
    }
    if (!s.open) {
      for (const a of c.args) {
        if (!a.optional && !seen.has(a.key)) findings.push({ rule: 'missing-required', file: s.file, line: s.line, function: s.function, command: s.command, key: a.key, message: `${s.command} 缺少必填参数 ${a.key}，调用会被拒绝` });
      }
    }
  }
  return findings;
}

/**
 * 字面量命令、但参数不是完整对象字面量（变量、调用结果、无法展开的 spread）的调用点：
 * 键集合静态不可知，judge 只能查已知的多余键、不查缺失必填，需人工对照契约。
 * 仅作清单输出，不进 findings、不影响 --check。Request 命令本就不做键检查，不列。
 */
export function openArgSites(sites, contracts = new Map()) {
  return sites
    .filter((s) => !s.dynamic && s.open && !(contracts.get(s.command)?.injected ?? []).some((i) => i.kind === 'request'))
    .map((s) => ({ file: s.file, line: s.line, function: s.function, command: s.command, keys: s.keys.map((k) => k.key) }));
}

export const findingKey = (f) => [f.rule, f.file, f.rule === 'dynamic-command' ? f.function : f.command, f.key ?? ''].join('\u0000');
const entryKey = (e) => findingKey({ rule: e.rule, file: e.file, function: e.function, command: e.command ?? null, key: e.key ?? null });

export const applyBaseline = (findings, baseline) => applyCountBaseline(findings, baseline, entryKey);

export const baselineFrom = (findings, previous = { entries: [] }) => countBaselineEntries(
  findings,
  previous,
  entryKey,
  (f) => ({ rule: f.rule, file: f.file, ...(f.rule === 'dynamic-command' ? { function: f.function } : { command: f.command }), ...(f.key ? { key: f.key } : {}) }),
  [(e) => e.rule, (e) => e.file, (e) => e.command ?? e.function, (e) => e.key],
);

export function frontendFiles(root = ROOT) {
  return files(root, 'src').filter((f) => SCRIPT.test(f) && production(f) && !f.endsWith('.d.ts') && !f.startsWith('src/demo/'));
}

export function run({ root = ROOT } = {}) {
  const contracts = loadCommandContracts(root);
  const sites = scanSources(frontendFiles(root).map((file) => ({ file, text: fs.readFileSync(path.join(root, file), 'utf8') })));
  const findings = judge(sites, contracts);
  const baselinePath = path.join(root, BASELINE_FILE);
  const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : { entries: [] };
  const { fresh, stale } = applyBaseline(findings, baseline);
  const review = openArgSites(sites, contracts);
  return {
    gate: 'frontend-invoke',
    findings: [...fresh, ...stale.map((e) => ({ ...e, line: 1, message: `基线项已不再出现（现 ${e.present}/${e.count ?? 1}），请从基线删除` }))],
    all: findings,
    review,
    summary: { sites: sites.length, literal: sites.filter((s) => !s.dynamic).length, dynamic: sites.filter((s) => s.dynamic).length, existing: findings.length, baselined: findings.length - fresh.length, fresh: fresh.length, stale: stale.length, review: review.length },
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
    console.log(`frontend-invoke: ${s.sites} sites (${s.literal} literal, ${s.dynamic} dynamic); ${s.existing} known issues, ${s.baselined} baselined, ${s.fresh} new, ${s.stale} stale baseline entries`);
    for (const f of result.findings) console.log(`${f.file}:${f.line ?? 1} [${f.rule}${f.severity === 'info' ? ', info' : ''}] ${f.message}`);
    if (s.review) {
      console.log(`frontend-invoke: ${s.review} open-argument call site(s) to review (informational, never fails --check)`);
      for (const r of result.review) console.log(`${r.file}:${r.line} [open-args, review] ${r.command}：参数不是完整的对象字面量，键集合静态不可知，须人工对照契约${r.keys.length ? `（可见键：${r.keys.join(', ')}）` : ''}`);
    }
  }
  if (argv.includes('--check') && result.findings.some((f) => f.severity === 'error')) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.stack); process.exitCode = 2; }
}
