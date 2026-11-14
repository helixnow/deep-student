#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { classifications, islands } from './classifications.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TEST = /(?:^|\/)(?:tests|__tests__|__fixtures__|fixtures)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const isTest = file => TEST.test(file.includes('/host/') ? file.slice(file.lastIndexOf('/host/') + 6) : file);
// These are Context operations, not service requests (Cordis + host/kernel/runtime.ts).
const CONTEXT = new Set(['get', 'set', 'provide', 'inject', 'plugin', 'effect', 'on', 'once', 'emit',
  'parallel', 'serial', 'bail', 'waterfall', 'extend', 'isolate', 'intercept', 'collect', 'dispose',
  'logger', 'reflect', 'fiber', 'root', 'scope', 'registry', 'events', 'lifecycle', 'name', 'model']);
export const KERNEL_SERVICES = ['app', 'commands', 'backendEvents', 'protocols', 'shell'];
const FAILURE = /not available|unavailable|待接线|not wired|not published|does not expose|未发布|未接线|尚未就绪|功能不可用|not configured|未在 TypeScript 宿主中实现|requires .*services|which is not published/i;

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : /\.[cm]?[jt]sx?$/.test(e.name) && !e.name.endsWith('.d.ts') ? [path.join(dir, e.name)] : []);
}
const unbox = n => {
  while (n && (ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n))) n = n.expression;
  return n;
};
const keyOf = n => n && (ts.isIdentifier(n) || ts.isStringLiteralLike(n)) ? n.text : null;
function resolveImport(file, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(file), spec);
  return [base, `${base}.ts`, `${base}.mjs`, path.join(base, 'index.ts')].find(p => fs.existsSync(p) && fs.statSync(p).isFile()) ?? null;
}

/** Import entry modules, never apply plugins or open application databases. */
export async function loadPlugins(root) {
  const entries = new Set();
  for (const area of ['host/plugins', 'host/platform']) {
    const dir = path.join(root, area);
    if (!fs.existsSync(dir)) continue;
    for (const child of fs.readdirSync(dir).sort()) {
      const entry = path.join(dir, child, 'index.ts');
      if (fs.existsSync(entry)) entries.add(entry);
    }
  }
  const profileFile = path.join(root, 'host/profiles/desktop.json');
  const profile = fs.existsSync(profileFile) ? JSON.parse(fs.readFileSync(profileFile, 'utf8')).plugins : [];
  for (const p of profile) if (p.module) entries.add(path.resolve(path.dirname(profileFile), p.module));
  const plugins = [], loadErrors = [];
  for (const entry of [...entries].sort()) {
    try {
      const module = await import(pathToFileURL(entry).href);
      const p = module.default;
      if (!p?.meta) continue; // utility index.ts, not a plugin
      plugins.push({ id: p.meta.id, lane: p.meta.lane ?? 'unknown', entry,
        directory: path.dirname(entry), provides: [...(p.meta.provides ?? [])],
        commands: [...(p.meta.commands ?? [])], remote: p.meta.remote ?? {},
        inject: Array.isArray(p.inject) ? [...p.inject] : Object.keys(p.inject ?? {}),
        inProfile: profile.some(item => item.id === p.meta.id && item.enabled !== false) });
    } catch (error) { loadErrors.push({ file: path.relative(root, entry), error: String(error.stack ?? error) }); }
  }
  return { plugins, loadErrors };
}

/** Syntax-backed extraction: comments/strings cannot create dependency edges. */
export function createScanner(files) {
  const parsed = new Map();
  const source = file => {
    if (!parsed.has(file)) parsed.set(file, ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true));
    return parsed.get(file);
  };
  // Symbol identity separates Cordis Context from tool ExecutionContext and PipelineContext.
  const program = ts.createProgram(files, { noResolve: true, noLib: true, allowJs: true, target: ts.ScriptTarget.Latest });
  const checker = program.getTypeChecker();
  function literal(node, file, seen = new Set()) {
    node = unbox(node);
    if (!node) return undefined;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties
      .filter(ts.isPropertyAssignment).map(p => [keyOf(p.name), literal(p.initializer, file, seen)]));
    if (ts.isPropertyAccessExpression(node)) return literal(node.expression, file, seen)?.[node.name.text];
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(e => {
      const v = literal(ts.isSpreadElement(e) ? e.expression : e, file, seen);
      return Array.isArray(v) ? v : v === undefined ? [] : [v];
    });
    if (ts.isIdentifier(node)) {
      const token = `${file}:${node.text}`;
      if (seen.has(token)) return undefined;
      seen = new Set([...seen, token]);
      let result;
      const visit = n => {
        if (ts.isVariableDeclaration(n) && keyOf(n.name) === node.text && n.initializer) result = literal(n.initializer, file, seen);
        if (ts.isImportDeclaration(n) && ts.isStringLiteralLike(n.moduleSpecifier)) {
          const bindings = n.importClause?.namedBindings;
          if (bindings && ts.isNamedImports(bindings)) for (const e of bindings.elements) if (e.name.text === node.text) {
            const target = resolveImport(file, n.moduleSpecifier.text);
            if (target) result = literal(ts.factory.createIdentifier(e.propertyName?.text ?? e.name.text), target, seen);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(source(file));
      return result;
    }
    return undefined;
  }
  function isContext(n) {
    n = unbox(n);
    if (!n) return false;
    if (ts.isIdentifier(n)) {
      const declarations = checker.getSymbolAtLocation(n)?.declarations ?? [];
      return declarations.some(d => {
        if (d.type && /^(?:Readonly<)?Context>?$/.test(d.type.getText())) return true;
        if (ts.isVariableDeclaration(d) && d.initializer && unbox(d.initializer) !== n && isContext(d.initializer)) return true;
        if (!d.type && ts.isParameter(d) && ts.isMethodDeclaration(d.parent) && ts.isObjectLiteralExpression(d.parent.parent) && keyOf(d.parent.name) === 'apply' && d.parent.parameters[0] === d) return true;
        // Cordis child injection callback receives a Context.
        const fn = d.parent, call = fn?.parent;
        return ts.isParameter(d) && call && ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)
          && call.expression.name.text === 'inject' && isContext(call.expression.expression);
      });
    }
    if (ts.isPropertyAccessExpression(n) && n.expression.kind === ts.SyntaxKind.ThisKeyword) {
      for (let p = n.parent; p; p = p.parent) if (ts.isClassDeclaration(p) || ts.isClassExpression(p)) {
        if (p.members.some(m => (ts.isPropertyDeclaration(m) || ts.isParameter(m)) && keyOf(m.name) === n.name.text && m.type?.getText() === 'Context')) return true;
        if (p.members.some(m => ts.isConstructorDeclaration(m) && m.parameters.some(a => keyOf(a.name) === n.name.text && a.type?.getText() === 'Context'))) return true;
        return n.name.text === 'ctx' && !!p.heritageClauses?.some(h => h.types.some(t => t.expression.getText() === 'Service'));
      }
    }
    return false;
  }
  function imports(file) {
    const out = [];
    const visit = n => {
      let spec;
      if ((ts.isImportDeclaration(n) && !n.importClause?.isTypeOnly &&
        !(n.importClause?.namedBindings && ts.isNamedImports(n.importClause.namedBindings) && !n.importClause.name && n.importClause.namedBindings.elements.every(e => e.isTypeOnly))) ||
        (ts.isExportDeclaration(n) && !n.isTypeOnly)) spec = n.moduleSpecifier;
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) spec = n.arguments[0];
      if (spec && ts.isStringLiteralLike(spec)) {
        const target = resolveImport(file, spec.text);
        if (target && !isTest(target)) out.push(target);
      }
      ts.forEachChild(n, visit);
    };
    visit(source(file));
    return out;
  }
  function scan(file) {
    const sf = program.getSourceFile(file) ?? source(file);
    const references = [], provisions = [], failures = [], unresolved = [], bypassImports = [], fallbacks = [];
    const evidence = n => ({ file, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
      text: sf.text.slice(n.getStart(sf), n.getEnd()).replace(/\s+/g, ' ').slice(0, 350) });
    const add = (name, kind, node) => references.push({ name, kind, ...evidence(node) });
    // Expand the repository's small lookup(names)/attach(name) wrappers at their call sites.
    const wrappers = new Map();
    const discover = n => {
      if ((ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n)) && n.name) {
        const fn = ts.isVariableDeclaration(n) ? unbox(n.initializer) : n;
        if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isMethodDeclaration(fn) || ts.isFunctionDeclaration(fn)) && fn.body) {
          let readsContext = false;
          const check = b => {
            if (ts.isCallExpression(b) && ts.isPropertyAccessExpression(b.expression) && b.expression.name.text === 'get' && isContext(b.expression.expression)) readsContext = true;
            ts.forEachChild(b, check);
          };
          check(fn.body);
          if (readsContext) wrappers.set(keyOf(n.name), fn);
        }
      }
      ts.forEachChild(n, discover);
    };
    discover(sf);
    // Silent optional-method/default branches have no "not available" diagnostic.
    // Follow local variable initializers back to a Context read; report candidates,
    // not method-availability defects (normal configuration branches also appear).
    function usesService(node, seen = new Set()) {
      if (!node) return false;
      if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && isContext(node.expression)) {
        const name = ts.isPropertyAccessExpression(node) ? node.name.text : literal(node.argumentExpression, file);
        if (typeof name === 'string' && !CONTEXT.has(name)) return true;
      }
      if (ts.isCallExpression(node)) {
        const e = node.expression;
        if (ts.isPropertyAccessExpression(e) && e.name.text === 'get' &&
          (isContext(e.expression) || (ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'reflect' && isContext(e.expression.expression)))) return true;
        if (ts.isIdentifier(e) && ['optionalService', 'ctxGet'].includes(e.text)) return true;
      }
      if (ts.isIdentifier(node)) {
        const symbol = checker.getSymbolAtLocation(node);
        if (symbol && !seen.has(symbol)) {
          const next = new Set([...seen, symbol]);
          if (symbol.declarations?.some(d => ts.isVariableDeclaration(d) && usesService(d.initializer, next))) return true;
        }
      }
      return !!ts.forEachChild(node, child => usesService(child, seen) || undefined);
    }
    const visit = n => {
      const condition = ts.isIfStatement(n) ? n.expression : ts.isConditionalExpression(n) ? n.condition
        : ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ? n.left : null;
      if (condition && usesService(condition)) fallbacks.push(evidence(n));
      if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && isContext(n.expression)) {
        const name = ts.isPropertyAccessExpression(n) ? n.name.text : literal(n.argumentExpression, file);
        // A provide target is not a read. Context APIs are excluded, not unknown service names.
        if (typeof name === 'string' && !CONTEXT.has(name)) add(name, 'property', n);
      }
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : keyOf(callee);
        const contextCall = ts.isPropertyAccessExpression(callee) && (isContext(callee.expression) ||
          (ts.isPropertyAccessExpression(callee.expression) && callee.expression.name.text === 'reflect' && isContext(callee.expression.expression)));
        if (contextCall && ['get', 'inject', 'provide'].includes(method)) {
          const value = literal(n.arguments[0], file);
          const names = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
          for (const name of names) {
            if (method === 'provide') provisions.push({ name, ...evidence(n) });
            else add(name, method === 'inject' ? 'child-inject' : 'get', n);
          }
          if (!names.length) unresolved.push({ kind: method, ...evidence(n) });
        }
        if (callee.kind === ts.SyntaxKind.SuperKeyword) {
          const name = literal(n.arguments[1], file);
          if (typeof name === 'string' && isContext(n.arguments[0])) provisions.push({ name, ...evidence(n) });
        }
        if (method === 'optionalService' && isContext(n.arguments[0])) {
          const name = literal(n.arguments[1], file);
          if (typeof name === 'string') add(name, 'optional-get', n);
        }
        // Imported Context helper, not a tool's unrelated get()/settings lookup.
        if (method === 'ctxGet') {
          const name = literal(n.arguments[1], file);
          if (typeof name === 'string') add(name, 'context-helper', n);
        }
        const wrapper = wrappers.get(method);
        if (wrapper && method !== 'optionalService' && wrapper !== n.parent) {
          wrapper.parameters.forEach((param, i) => {
            const value = literal(n.arguments[i], file);
            const names = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
            if (!names.length) return;
            const body = wrapper.body.getText();
            if (new RegExp(`\\.get\\(\\s*${keyOf(param.name)}\\s*\\)`).test(body) ||
              new RegExp(`of\\s+${keyOf(param.name)}\\b`).test(body)) for (const name of names) add(name, 'lookup-wrapper', n);
          });
        }
      }
      if (ts.isImportDeclaration(n) && !n.importClause?.isTypeOnly && ts.isStringLiteralLike(n.moduleSpecifier)
        && /platform\/native\//.test(n.moduleSpecifier.text)) bypassImports.push(evidence(n));
      if (ts.isPropertyAssignment(n) && keyOf(n.name) === 'provides') {
        for (const name of literal(n.initializer, file) ?? []) provisions.push({ name, ...evidence(n) });
      }
      // createTestHost({ provide: { productionName: stub } }) is also a bridge.
      if (ts.isPropertyAssignment(n) && keyOf(n.name) === 'provide' && ts.isObjectLiteralExpression(n.initializer)) {
        for (const p of n.initializer.properties) if (p.name && keyOf(p.name)) provisions.push({ name: keyOf(p.name), ...evidence(p) });
      }
      if (ts.isStringLiteralLike(n) || ts.isTemplateExpression(n)) {
        // Exclude literal types; retain diagnostics as candidates, not automatically defects.
        if (!ts.isLiteralTypeNode(n.parent) && FAILURE.test(n.getText(sf))) failures.push(evidence(n));
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return { references, provisions, failures, unresolved, bypassImports, fallbacks };
  }
  return { scan, imports };
}

/** Strongly connected components of required startup inject edges only. */
export function findCycles(plugins) {
  const owners = new Map();
  for (const p of plugins) for (const name of p.provides) owners.set(name, [...(owners.get(name) ?? []), p.id]);
  const edges = plugins.flatMap(p => p.inject.flatMap(name => (owners.get(name) ?? []).map(to => ({ from: p.id, to, service: name }))));
  const adjacency = new Map(plugins.map(p => [p.id, edges.filter(e => e.from === p.id).map(e => e.to)]));
  let next = 0;
  const indices = new Map(), low = new Map(), stack = [], active = new Set(), cycles = [];
  function visit(v) {
    indices.set(v, next); low.set(v, next++); stack.push(v); active.add(v);
    for (const w of adjacency.get(v) ?? []) {
      if (!indices.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (active.has(w)) low.set(v, Math.min(low.get(v), indices.get(w)));
    }
    if (indices.get(v) === low.get(v)) {
      const members = []; let w;
      do { w = stack.pop(); active.delete(w); members.push(w); } while (w !== v);
      if (members.length > 1 || adjacency.get(v)?.includes(v)) cycles.push({ plugins: members.sort(), edges: edges.filter(e => members.includes(e.from) && members.includes(e.to)) });
    }
  }
  for (const p of plugins) if (!indices.has(p.id)) visit(p.id);
  return cycles;
}

export async function audit(root = ROOT) {
  root = path.resolve(root);
  const { plugins, loadErrors } = await loadPlugins(root);
  const files = walk(path.join(root, 'host'));
  const scanner = createScanner(files);
  const reachable = new Set(), stack = plugins.map(p => p.entry);
  while (stack.length) {
    const file = stack.pop();
    if (reachable.has(file)) continue;
    reachable.add(file); stack.push(...scanner.imports(file));
  }
  const owner = file => plugins.filter(p => file === p.entry || file.startsWith(p.directory + path.sep))
    .sort((a, b) => b.directory.length - a.directory.length)[0];
  const references = [], failures = [], bridges = [], unresolved = [], dormantReferences = [], bypassImports = [], fallbacks = [];
  for (const file of files) {
    const p = owner(file);
    const scanned = scanner.scan(file);
    const location = e => ({ ...e, file: path.relative(root, e.file).split(path.sep).join('/'), plugin: p?.id ?? 'kernel', lane: p?.lane ?? 'F1-kernel' });
    if (isTest(file)) { bridges.push(...scanned.provisions.map(location)); continue; }
    const target = reachable.has(file) ? references : dormantReferences;
    target.push(...scanned.references.map(location));
    failures.push(...scanned.failures.map(e => ({ ...location(e), reachable: reachable.has(file) })));
    fallbacks.push(...scanned.fallbacks.map(e => ({ ...location(e), reachable: reachable.has(file) })));
    bypassImports.push(...scanned.bypassImports.map(e => ({ ...location(e), reachable: reachable.has(file) })));
    if (reachable.has(file)) unresolved.push(...scanned.unresolved.map(location));
  }
  for (const p of plugins) for (const name of p.inject) references.push({ name, kind: 'inject', plugin: p.id, lane: p.lane,
    file: path.relative(root, p.entry), line: fs.readFileSync(p.entry, 'utf8').split('\n').findIndex(l => /^\s*inject\s*:/.test(l)) + 1, text: `inject: ${name}` });
  const services = [...new Set(plugins.flatMap(p => p.provides))].sort().map(name => {
    const providers = plugins.filter(p => p.provides.includes(name));
    return { name, providers: providers.map(p => p.id), consumers: references.filter(r => r.name === name && !providers.some(p => p.id === r.plugin)),
      localUses: references.filter(r => r.name === name && providers.some(p => p.id === r.plugin)),
      testBridges: bridges.filter(b => b.name === name) };
  });
  const provided = new Set([...services.map(s => s.name), ...KERNEL_SERVICES]);
  const missing = [...new Set(references.filter(r => !provided.has(r.name)).map(r => r.name))].sort()
    .map(name => ({ name, references: references.filter(r => r.name === name) }));
  const cycles = findCycles(plugins);
  const profileOmissions = fs.existsSync(path.join(root, 'host/profiles/desktop.json'))
    ? plugins.filter(p => !p.inProfile).map(p => ({ id: p.id, entry: path.relative(root, p.entry) })) : [];
  for (const service of services.filter(s => !s.consumers.length)) {
    const classified = classifications[service.name];
    const remote = plugins.some(p => p.provides.includes(service.name) && p.remote[service.name]?.length);
    service.classification = remote ? 'remote-surface' : classified?.[0] ?? (islands[service.name] ? 'island' : 'needs-review');
    service.reason = remote ? 'meta.remote explicitly exposes methods to frontend plugin:host|call'
      : classified?.[1] ?? (islands[service.name] ? `See wiring task ${islands[service.name]}` : 'New unconsumed service: inspect command/remote surfaces before calling it an island');
  }
  return { summary: { plugins: plugins.length, services: services.length, unconsumed: services.filter(s => !s.consumers.length).length,
    islands: services.filter(s => s.classification === 'island').length,
    bypassed: services.filter(s => s.classification === 'bypassed').length,
    wiringIslands: services.filter(s => ['island', 'bypassed'].includes(s.classification)).length,
    commandSurfaces: services.filter(s => s.classification === 'command-surface').length,
    missing: missing.length, missingHardInject: missing.filter(s => s.references.some(r => r.kind === 'inject')).length,
    cycles: cycles.length, loadErrors: loadErrors.length, profileOmissions: profileOmissions.length },
    plugins: plugins.map(p => ({ ...p, entry: path.relative(root, p.entry), directory: path.relative(root, p.directory) })),
    services, missing, cycles, profileOmissions, failures, fallbacks, bridges: bridges.filter(b => provided.has(b.name) || references.some(r => r.name === b.name)), unresolved, dormantReferences, bypassImports, loadErrors };
}

export function checkFailed(report) {
  return report.loadErrors.length > 0 || report.cycles.length > 0 || report.missing.length > 0;
}

export function markdown(report) {
  const loc = e => `${e.file}:${e.line}`;
  const cell = text => String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = ['# X4 接线审计原始证据', '',
    '<!-- Generated: node scripts/electron-migration/wiring-audit/audit.mjs --markdown -->', '',
    '只导入入口读取 meta，不执行 apply；以下是静态证据，不是全应用运行成功证明。缺服务诊断为候选，包含 Rust 原有的正常不可用分支。', '',
    '```json', JSON.stringify(report.summary, null, 2), '```', '',
    '## 插件入口 / meta', '', '| id / lane | 入口 | profile | provides | inject | commands |', '|---|---|---|---|---|---|'];
  for (const p of report.plugins) lines.push(`| ${p.id} / ${p.lane} | ${p.entry} | ${p.inProfile} | ${p.provides.join(', ')} | ${p.inject.join(', ')} | ${p.commands.length} |`);
  lines.push('', '## 服务依赖图（消费者 → 服务 → 提供方）', '', '| 服务 | 提供方 | 生产消费者（含 get / 子 inject） | 无外部消费者的分类 |', '|---|---|---|---|');
  for (const s of report.services) lines.push(`| ${s.name} | ${s.providers.join(', ')} | ${[...new Set(s.consumers.map(c => `${c.plugin} (${loc(c)}, ${c.kind})`))].join('<br>') || '—'} | ${cell(s.classification ? `${s.classification}: ${s.reason}` : '—')} |`);
  lines.push('', '## 悬空名字（不以测试桥接补齐）', '');
  for (const m of report.missing) {
    lines.push(`### ${m.name}`, '');
    for (const r of m.references) lines.push(`- ${loc(r)} · ${r.lane} · ${r.kind}: \`${cell(r.text)}\``);
    lines.push('');
  }
  lines.push('## 硬 inject 环', '', report.cycles.length ? JSON.stringify(report.cycles, null, 2) : '无。ctx.inject 子回调不参与顶层启动环。', '',
    '## 服务不可用/待接线诊断候选（逐位置；reachable 为入口导入可达）', '', '| lane | 位置 | 可达 | 原文 |', '|---|---|---|---|');
  for (const f of report.failures) lines.push(`| ${f.lane} | ${loc(f)} | ${f.reachable} | ${cell(f.text)} |`);
  lines.push('', '## Context 来源的条件/默认值分支（含无诊断的静默降级；候选而非逐条缺陷）', '', '| lane | 位置 | 可达 | 分支 |', '|---|---|---|---|');
  for (const f of report.fallbacks) lines.push(`| ${f.lane} | ${loc(f)} | ${f.reachable} | ${cell(f.text)} |`);
  lines.push('', '## 测试桥接/替身（提供正式服务或正式路径获取的名字）', '', '| 名字 | 测试位置 | 提供声明/调用 |', '|---|---|---|');
  for (const b of report.bridges) lines.push(`| ${b.name} | ${loc(b)} | ${cell(b.text)} |`);
  lines.push('', '## 绕过服务的 native 导入', '');
  for (const b of report.bypassImports) lines.push(`- ${loc(b)} (reachable=${b.reachable}): \`${cell(b.text)}\``);
  lines.push('', '## 动态表达式（包装器调用点已展开；不声称通用数据流证明）', '');
  for (const u of report.unresolved) lines.push(`- ${loc(u)}: \`${cell(u.text)}\``);
  lines.push('', '## 入口不可达模块中的服务引用', '');
  for (const u of report.dormantReferences) lines.push(`- ${u.name}: ${loc(u)} (${u.kind})`);
  lines.push('', '## 入口加载错误', '', report.loadErrors.length ? JSON.stringify(report.loadErrors, null, 2) : '无。', '');
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node scripts/electron-migration/wiring-audit/audit.mjs [--json|--markdown] [--check] [--root <repo>]');
  } else {
    const root = args.includes('--root') ? args[args.indexOf('--root') + 1] : ROOT;
    const report = await audit(root);
    if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else if (args.includes('--markdown')) console.log(markdown(report));
    else {
      console.log(JSON.stringify(report.summary));
      for (const m of report.missing) console.log(`MISSING ${m.name}: ${m.references.map(r => `${r.file}:${r.line} (${r.kind})`).join(', ')}`);
      for (const c of report.cycles) console.log(`CYCLE ${c.plugins.join(' <-> ')}`);
      for (const p of report.profileOmissions) console.log(`PROFILE OMITTED ${p.id}: ${p.entry}`);
      for (const s of report.services.filter(s => !s.consumers.length)) console.log(`NO CROSS-PLUGIN CONSUMER [${s.classification}] ${s.name} (${s.providers.join(', ')})`);
      for (const e of report.loadErrors) console.error(`LOAD ERROR ${e.file}: ${e.error}`);
    }
    if (args.includes('--check') && checkFailed(report)) process.exitCode = 1;
  }
}
