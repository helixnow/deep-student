#!/usr/bin/env node
// 前端边界门禁（FE-A4，plans/FRONTEND-PLUGINIZATION.md §3）：棘轮式，现状登记为基线，只拦新增。
//   plugin-tauri-import  插件代码（src/ui-plugins/**、src/plugins/**，测试与 testing/ 除外）不得直连 `@tauri-apps/*`
//                        （import / export-from / import() / require；`import type` 不算）；
//   ua-sniffing          平台模块（src/platform/**、src/utils/platform.ts）之外不得读 navigator.userAgent /
//                        userAgentData / platform / vendor；
//   bare-custom-event    src/events/** 之外不得 `new CustomEvent(…)`（走 @/events 的 dispatchAppEvent 等）；
//   plugin-import-boundary  插件（src/plugins/<x>/、src/ui-plugins/official/<x>/；official 根目录的装配文件以整个
//                        official/ 为本目录）只能 import 本目录、SDK（src/ui-sdk/）、src/shared/、src/lib/、其他插件的 api.ts；
//   cross-feature-import src/features/<A>/ 引用 src/features/<B>/（plan §1 的 547 条边口径）。
// 两条 import 规则按 (文件, 解析后的目标文件) 去重计边，`@/` 与相对路径都解析，import type、export … from、import()
// 都算（类型与懒加载同样是对他人内部实现的依赖）；npm 包不在此列（@tauri-apps 见第一条）。
// 范围：src/ 生产代码（测试、.d.ts、src/demo/ 除外）。基线 ui-boundaries-baseline.json 按 规则+文件 计数，import 规则另按
// 目标（插件规则取目标前三段路径、跨 feature 规则取目标 feature）分键，换一个违规目标也算新增；
// 重写基线时计数只能减少，增加须显式 --allow-increase（并在评审中说明）。
//
//   node scripts/electron-migration/gate-checks/ui-boundaries.mjs [--check] [--json] [--root <dir>]
//   node scripts/electron-migration/gate-checks/ui-boundaries.mjs --write-baseline [--allow-increase]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, files, production, source, ts, unwrap, walk } from './common.mjs';
import { lineOf } from './ast.mjs';
import { applyCountBaseline, countBaselineEntries } from './baseline.mjs';

export const BASELINE_FILE = 'scripts/electron-migration/gate-checks/ui-boundaries-baseline.json';
const SCRIPT = /\.(?:[cm]?[jt]sx?)$/;
const UA_PROPS = new Set(['userAgent', 'userAgentData', 'platform', 'vendor']);
const GLOBALS = new Set(['window', 'globalThis', 'self']);

const MESSAGES = {
  'plugin-tauri-import': '插件代码直连 @tauri-apps；改用 @deepstudent/ui SDK 或本插件 api.ts 封装的客户端',
  'ua-sniffing': '平台模块之外的 UA 嗅探；改用 @/utils/platform（或 src/platform/）提供的判定',
  'bare-custom-event': '裸 CustomEvent；改用 @/events 的 dispatchAppEvent / addAppEventListener',
  'plugin-import-boundary': '插件引用了本目录、SDK、shared/lib、他人 api.ts 之外的模块；经 @/ui-sdk 或对方 api.ts 暴露的服务访问',
  'cross-feature-import': '跨 feature 直接 import；改经对方插件 api.ts / UI 服务（ctx.provide + inject）访问',
};

const isPluginFile = (f) => (f.startsWith('src/ui-plugins/') || f.startsWith('src/plugins/')) && !f.startsWith('src/ui-plugins/testing/');
const isPlatformFile = (f) => f === 'src/utils/platform.ts' || f.startsWith('src/platform/');
const isEventsFile = (f) => f.startsWith('src/events/');

/** 插件的“本目录”：src/plugins/<x>/、src/ui-plugins/official/<x>/；official 根目录的装配文件以 official/ 为本目录。 */
export function pluginUnit(file) {
  return /^src\/plugins\/[^/]+\//.exec(file)?.[0] ?? /^src\/ui-plugins\/official\/[^/]+\//.exec(file)?.[0]
    ?? (/^src\/ui-plugins\/official\/[^/]+$/.test(file) ? 'src/ui-plugins/official/' : null);
}
export const featureOf = (file) => /^src\/features\/([^/]+)(?:\/|$)/.exec(file)?.[1] ?? null;
const PLUGIN_API = /^src\/(?:plugins|ui-plugins\/official)\/[^/]+\/api\.tsx?$/;
const SHARED = ['src/ui-sdk/', 'src/shared/', 'src/lib/'];
const pluginMayImport = (unit, target) => target.startsWith(unit) || PLUGIN_API.test(target)
  || SHARED.some((p) => target.startsWith(p) || `${target}/` === p);

const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js'];
/** `@/x` 与相对路径解析为仓库内路径；包名返回 null。找不到文件时返回规范化后的路径（仍可按目录归属判定）。 */
export function resolveImport(from, specifier, known) {
  const spec = specifier.replace(/[?#].*$/, '');
  let base;
  if (spec.startsWith('@/')) base = `src/${spec.slice(2)}`;
  else if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  else return null;
  for (const suffix of RESOLVE_SUFFIXES) if (known.has(base + suffix)) return base + suffix;
  const js = /\.jsx?$/.exec(base);
  if (js) for (const ext of ['.ts', '.tsx']) if (known.has(base.slice(0, -js[0].length) + ext)) return base.slice(0, -js[0].length) + ext;
  return base;
}

/** 模块的全部引用（静态、类型、再导出、动态 import()），含节点。 */
function moduleReferences(sf) {
  const out = [];
  walk(sf, (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      out.push({ node, specifier: node.moduleSpecifier.text });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      out.push({ node, specifier: node.arguments[0].text });
    }
  });
  return out;
}

export function inScope(file) {
  return file.startsWith('src/') && SCRIPT.test(file) && production(file) && !file.endsWith('.d.ts')
    && !file.startsWith('src/demo/') && !/(^|\/)__golden__\//.test(file);
}

/** `navigator`、`window.navigator`、`globalThis.navigator`… */
function isNavigator(expr) {
  const e = unwrap(expr);
  if (ts.isIdentifier(e)) return e.text === 'navigator';
  return ts.isPropertyAccessExpression(e) && e.name.text === 'navigator' && ts.isIdentifier(unwrap(e.expression)) && GLOBALS.has(unwrap(e.expression).text);
}

function isCustomEventCtor(expr) {
  const e = unwrap(expr);
  if (ts.isIdentifier(e)) return e.text === 'CustomEvent';
  return ts.isPropertyAccessExpression(e) && e.name.text === 'CustomEvent' && ts.isIdentifier(unwrap(e.expression)) && GLOBALS.has(unwrap(e.expression).text);
}

const tauriSpecifier = (node) => node && ts.isStringLiteralLike(node) && node.text.startsWith('@tauri-apps/');

/**
 * @param {{file: string, text: string}[]} entries
 * @param {{known?: Set<string>}} [options] known：用于解析 import 的仓库文件集合（缺省为 entries 本身）
 */
export function scanUiBoundaries(entries, { known = new Set(entries.map((e) => e.file)) } = {}) {
  const findings = [];
  for (const { file, text } of entries) {
    if (!inScope(file)) continue;
    const plugin = isPluginFile(file);
    const ua = !isPlatformFile(file);
    const events = !isEventsFile(file);
    if (!plugin && !ua && !events) continue;
    const sf = source(file, text);
    const add = (rule, node) => findings.push({ rule, file, line: lineOf(sf, node), message: MESSAGES[rule] });
    const unit = pluginUnit(file);
    const feature = featureOf(file);
    if (unit || feature) {
      const seen = new Set();
      for (const { node, specifier } of moduleReferences(sf)) {
        const target = resolveImport(file, specifier, known);
        if (target === null || seen.has(target)) continue;
        seen.add(target);
        if (unit && !pluginMayImport(unit, target)) {
          findings.push({ rule: 'plugin-import-boundary', file, line: lineOf(sf, node), target, scope: target.split('/').slice(0, 3).join('/'), message: `${MESSAGES['plugin-import-boundary']}（${target}）` });
        }
        const other = featureOf(target);
        if (feature && other && other !== feature) {
          findings.push({ rule: 'cross-feature-import', file, line: lineOf(sf, node), target, scope: `src/features/${other}`, message: `${MESSAGES['cross-feature-import']}（${target}）` });
        }
      }
    }
    walk(sf, (node) => {
      if (plugin) {
        if (ts.isImportDeclaration(node) && tauriSpecifier(node.moduleSpecifier) && !node.importClause?.isTypeOnly) add('plugin-tauri-import', node);
        else if (ts.isExportDeclaration(node) && tauriSpecifier(node.moduleSpecifier) && !node.isTypeOnly) add('plugin-tauri-import', node);
        else if (ts.isCallExpression(node) && tauriSpecifier(node.arguments[0])
          && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
          add('plugin-tauri-import', node);
        }
      }
      if (ua) {
        if (ts.isPropertyAccessExpression(node) && UA_PROPS.has(node.name.text) && isNavigator(node.expression)) add('ua-sniffing', node);
        else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
          && UA_PROPS.has(node.argumentExpression.text) && isNavigator(node.expression)) add('ua-sniffing', node);
      }
      if (events && ts.isNewExpression(node) && isCustomEventCtor(node.expression)) add('bare-custom-event', node);
    });
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
}

const keyOf = (f) => `${f.rule}\u0000${f.file}${f.scope ? `\u0000${f.scope}` : ''}`;
export const applyBaseline = (findings, baseline) => applyCountBaseline(findings, baseline, keyOf);
export const baselineFrom = (findings, previous = { entries: [] }) =>
  countBaselineEntries(findings, previous, keyOf, (f) => ({ rule: f.rule, file: f.file, ...(f.scope ? { scope: f.scope } : {}) }), [(e) => e.rule, (e) => e.file, (e) => e.scope]);

/** 基线重写时计数上升的项（新增键也算）。 */
export function baselineGrowth(previous, entries) {
  const before = new Map((previous?.entries ?? []).map((e) => [keyOf(e), e.count ?? 1]));
  return entries
    .filter((e) => e.count > (before.get(keyOf(e)) ?? 0))
    .map((e) => ({ rule: e.rule, file: e.file, ...(e.scope ? { scope: e.scope } : {}), from: before.get(keyOf(e)) ?? 0, to: e.count }));
}

export function run({ root = ROOT } = {}) {
  const all = files(root, 'src');
  const entries = all.filter(inScope).map((file) => ({ file, text: fs.readFileSync(path.join(root, file), 'utf8') }));
  const findings = scanUiBoundaries(entries, { known: new Set(all) });
  const baselinePath = path.join(root, BASELINE_FILE);
  const hasBaseline = fs.existsSync(baselinePath);
  const baseline = hasBaseline ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : { entries: [] };
  const { fresh, stale } = applyBaseline(findings, baseline);
  const byRule = {};
  for (const f of findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  return {
    gate: 'ui-boundaries',
    findings: [...fresh, ...stale.map((e) => ({ ...e, line: 1, message: `基线项已减少（现 ${e.present}/${e.count ?? 1}），请重写基线把计数降下来` }))],
    all: findings,
    summary: { files: entries.length, existing: findings.length, byRule, baselined: findings.length - fresh.length, fresh: fresh.length, stale: stale.length },
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
      console.log('ui-boundaries: 基线计数只能减少；以下项会增加（确需登记请加 --allow-increase 并在评审中说明）：');
      for (const g of growth) console.log(`  ${g.rule} ${g.file}${g.scope ? ` → ${g.scope}` : ''} ${g.from} → ${g.to}`);
      process.exitCode = 1;
      return;
    }
    const description = result.baseline.description
      ?? 'FE-A4 前端边界门禁基线（按 规则+文件 计数，只减不增）。见 ui-boundaries.mjs 文件头。';
    fs.mkdirSync(path.dirname(path.join(root, BASELINE_FILE)), { recursive: true });
    fs.writeFileSync(path.join(root, BASELINE_FILE), `${JSON.stringify({ description, entries }, null, 1)}\n`);
    console.log(`wrote ${entries.length} baseline entries (${result.all.length} findings)`);
    return;
  }
  if (argv.includes('--json')) console.log(JSON.stringify({ ...result, baseline: undefined }, null, 2));
  else {
    const s = result.summary;
    const rules = Object.entries(s.byRule).map(([r, n]) => `${r} ${n}`).join(', ') || 'none';
    console.log(`ui-boundaries: ${s.files} files; ${s.existing} known (${rules}), ${s.baselined} baselined, ${s.fresh} new, ${s.stale} stale baseline entries`);
    for (const f of result.findings) console.log(`${f.file}:${f.line ?? 1} [${f.rule}${f.severity === 'info' ? ', info' : ''}] ${f.message}`);
  }
  if (argv.includes('--check') && result.findings.some((f) => f.severity === 'error')) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.stack); process.exitCode = 2; }
}
