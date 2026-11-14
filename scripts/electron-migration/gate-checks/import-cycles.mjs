#!/usr/bin/env node
// 运行时导入环门禁：从每个 Host 插件的 host/plugins/<x>/api.ts 与 portable.ts 出发，沿运行时导入边求闭包，按强连通分量找环。
// 同一分量内的每条导入边都落在某个运行时环上；环上的模块求值顺序取决于谁先被加载，顶层读取对方绑定就会 TDZ
// （2026-11-07 agent-skills/api.ts ⇄ chat/api.ts 即此类）。棘轮式：现状按 导入方→被导入方 计数登记为基线，只拦新增。
//
// 计入（模块求值期就会加载对方）：import x / { a } / * as ns / 'side-effect'；非 type 的 export … from；import x = require()。
// 不计：import type / export type（擦除）；import() 与 require() 调用（运行到才加载，不参与求值顺序）。
// tsconfig.host.json 开了 verbatimModuleSyntax：`import { type A } from` 会保留为 `import {} from`，对方模块照样求值，所以计入。
//
//   node scripts/electron-migration/gate-checks/import-cycles.mjs [--check] [--json] [--root <dir>]
//   node scripts/electron-migration/gate-checks/import-cycles.mjs --write-baseline [--allow-increase]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, ts } from './common.mjs';
import { applyCountBaseline, countBaselineEntries } from './baseline.mjs';

export const BASELINE_FILE = 'scripts/electron-migration/gate-checks/import-cycles-baseline.json';
const MODULE = /\.(?:[cm]?ts|tsx|[cm]?js)$/;

/** 各插件发布的跨插件入口 api.ts 与 portable.ts（闭包的起点；boundary-rules 的 isPublishedApi 同时放行两者）。 */
export function entryPoints(root) {
  const dir = path.join(root, 'host/plugins');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())
    .flatMap((e) => [`host/plugins/${e.name}/api.ts`, `host/plugins/${e.name}/portable.ts`])
    .filter((f) => fs.existsSync(path.join(root, f))).sort();
}

const isFile = (root, f) => {
  try {
    return fs.statSync(path.join(root, f)).isFile();
  } catch {
    return false;
  }
};

/** 只解析相对路径；包名与 node: 内置模块不在仓库内，不会成环。 */
export function resolveSpecifier(root, from, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  const candidates = [base, base.replace(/\.js$/, '.ts'), base.replace(/\.mjs$/, '.mts'), `${base}.ts`, `${base}/index.ts`];
  return candidates.find((f) => MODULE.test(f) && isFile(root, f)) ?? null;
}

/** 一个模块的运行时导入（按语句，含行号）。 */
export function runtimeImports(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out = [];
  const add = (node, specifier) => {
    if (specifier && ts.isStringLiteralLike(specifier)) out.push({ specifier: specifier.text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
  };
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      if (!st.importClause?.isTypeOnly) add(st, st.moduleSpecifier);
    } else if (ts.isExportDeclaration(st)) {
      if (st.moduleSpecifier && !st.isTypeOnly) add(st, st.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(st)) {
      if (!st.isTypeOnly && ts.isExternalModuleReference(st.moduleReference)) add(st, st.moduleReference.expression);
    }
  }
  return out;
}

/** 从 entries 出发的运行时导入图：Map<file, {to, line}[]>。 */
export function importGraph(root, entries = entryPoints(root)) {
  const graph = new Map();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop();
    if (graph.has(file)) continue;
    const edges = runtimeImports(file, fs.readFileSync(path.join(root, file), 'utf8'))
      .map((i) => ({ to: resolveSpecifier(root, file, i.specifier), line: i.line }))
      .filter((e) => e.to !== null);
    graph.set(file, edges);
    for (const e of edges) if (!graph.has(e.to)) queue.push(e.to);
  }
  return graph;
}

/** Tarjan（迭代版，避免深链爆栈）。返回成环的强连通分量（多于一个模块，或有自导入）。 */
export function cyclicComponents(graph) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let next = 0;
  for (const start of graph.keys()) {
    if (index.has(start)) continue;
    const work = [{ v: start, i: 0 }];
    index.set(start, next); low.set(start, next); next += 1; stack.push(start); onStack.add(start);
    while (work.length) {
      const frame = work[work.length - 1];
      const edges = graph.get(frame.v) ?? [];
      if (frame.i < edges.length) {
        const w = edges[frame.i++].to;
        if (!index.has(w)) {
          index.set(w, next); low.set(w, next); next += 1; stack.push(w); onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) low.set(frame.v, Math.min(low.get(frame.v), index.get(w)));
        continue;
      }
      work.pop();
      if (work.length) low.set(work[work.length - 1].v, Math.min(low.get(work[work.length - 1].v), low.get(frame.v)));
      if (low.get(frame.v) !== index.get(frame.v)) continue;
      const component = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        component.push(w);
      } while (w !== frame.v);
      if (component.length > 1 || (graph.get(component[0]) ?? []).some((e) => e.to === component[0])) components.push(component.sort());
    }
  }
  return components.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}

/** 分量内 from 回到自身、经过 to 的最短环（BFS）。 */
function cycleThrough(graph, members, from, to) {
  const prev = new Map([[to, null]]);
  const queue = [to];
  while (queue.length) {
    const v = queue.shift();
    if (v === from) break;
    for (const { to: w } of graph.get(v) ?? []) {
      if (members.has(w) && !prev.has(w)) {
        prev.set(w, v);
        queue.push(w);
      }
    }
  }
  const back = [];
  for (let v = from; v !== null && v !== undefined; v = prev.get(v)) back.unshift(v);
  return [from, ...back];
}

export const ownerOf = (file) => /^host\/(?:plugins|platform)\/([^/]+)\//.exec(file)?.[1] ?? (file.startsWith('host/kernel/') ? 'kernel' : file);

/** 环上的每条导入语句一条发现。 */
export function scanImportCycles(graph) {
  const components = cyclicComponents(graph);
  const findings = [];
  for (const component of components) {
    const members = new Set(component);
    for (const file of component) {
      for (const { to, line } of graph.get(file) ?? []) {
        if (!members.has(to)) continue;
        const cycle = cycleThrough(graph, members, file, to);
        const crossPlugin = ownerOf(file) !== ownerOf(to);
        const owners = new Set(cycle.map(ownerOf)).size;
        findings.push({
          rule: 'runtime-import-cycle', file, line, to, cycle, crossPlugin,
          message: `${owners > 1 ? '跨插件' : '插件内'}运行时导入环：${cycle.join(' → ')}；改为 import type、把共享常量下沉到无依赖的模块，或在使用处惰性读取`,
        });
      }
    }
  }
  return {
    components,
    findings: findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.to.localeCompare(b.to)),
  };
}

const keyOf = (f) => `${f.file}\u0000${f.to}`;
export const applyBaseline = (findings, baseline) => applyCountBaseline(findings, baseline, keyOf);
export const baselineFrom = (findings, previous = { entries: [] }) =>
  countBaselineEntries(findings, previous, keyOf, (f) => ({ file: f.file, to: f.to }), [(e) => e.file, (e) => e.to]);

/** 基线重写时计数上升的项（新增键也算）。 */
export function baselineGrowth(previous, entries) {
  const before = new Map((previous?.entries ?? []).map((e) => [keyOf(e), e.count ?? 1]));
  return entries
    .filter((e) => e.count > (before.get(keyOf(e)) ?? 0))
    .map((e) => ({ file: e.file, to: e.to, from: before.get(keyOf(e)) ?? 0, count: e.count }));
}

export function run({ root = ROOT } = {}) {
  const entries = entryPoints(root);
  const graph = importGraph(root, entries);
  const { components, findings } = scanImportCycles(graph);
  const baselinePath = path.join(root, BASELINE_FILE);
  const hasBaseline = fs.existsSync(baselinePath);
  const baseline = hasBaseline ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : { entries: [] };
  const { fresh, stale } = applyBaseline(findings, baseline);
  return {
    gate: 'import-cycles',
    findings: [
      ...fresh,
      ...stale.map((e) => ({ ...e, rule: 'runtime-import-cycle', line: 1, message: `基线中的环边已减少（现 ${e.present}/${e.count ?? 1}）：${e.file} → ${e.to}，请重写基线把计数降下来` })),
    ],
    all: findings,
    components,
    summary: {
      entries: entries.length, modules: graph.size, components: components.length, cyclicEdges: findings.length,
      crossPlugin: findings.filter((f) => f.crossPlugin).length, baselined: findings.length - fresh.length, fresh: fresh.length, stale: stale.length,
    },
    baseline,
    hasBaseline,
  };
}

function main(argv) {
  const root = argv.includes('--root') ? path.resolve(argv[argv.indexOf('--root') + 1]) : ROOT;
  const result = run({ root });
  if (argv.includes('--write-baseline')) {
    const entries = baselineFrom(result.all, result.baseline);
    const growth = result.hasBaseline ? baselineGrowth(result.baseline, entries) : [];
    if (growth.length && !argv.includes('--allow-increase')) {
      console.log('import-cycles: 基线计数只能减少；以下环边会增加（确需登记请加 --allow-increase 并在评审中说明）：');
      for (const g of growth) console.log(`  ${g.file} → ${g.to} ${g.from} → ${g.count}`);
      process.exitCode = 1;
      return;
    }
    const description = result.baseline.description
      ?? '运行时导入环基线（Host 插件 api.ts 的值导入闭包内、处于环上的导入边，按 导入方→被导入方 计数，只减不增）。见 import-cycles.mjs 文件头。';
    fs.mkdirSync(path.dirname(path.join(root, BASELINE_FILE)), { recursive: true });
    fs.writeFileSync(path.join(root, BASELINE_FILE), `${JSON.stringify({ description, entries }, null, 1)}\n`);
    console.log(`wrote ${entries.length} baseline entries (${result.all.length} cyclic imports in ${result.components.length} components)`);
    return;
  }
  if (argv.includes('--json')) console.log(JSON.stringify({ ...result, baseline: undefined }, null, 2));
  else {
    const s = result.summary;
    console.log(`import-cycles: ${s.entries} api.ts/portable.ts entries, ${s.modules} modules; ${s.components} cyclic components, ${s.cyclicEdges} cyclic imports (${s.crossPlugin} cross-plugin), ${s.baselined} baselined, ${s.fresh} new, ${s.stale} stale baseline entries`);
    for (const f of result.findings) console.log(`${f.file}:${f.line ?? 1} [${f.rule}${f.severity === 'info' ? ', info' : ''}] ${f.message}`);
  }
  if (argv.includes('--check') && result.findings.some((f) => f.severity === 'error')) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.stack); process.exitCode = 2; }
}
