#!/usr/bin/env node
// ============================================================================
// 前端分层守卫（CI Gate，基线棘轮）
//
// 职责：扫描 src/ 下非测试源码的 import 依赖方向，存量违规冻结在基线里，
// CI 只拦截"新增"违规。
//   1. 层序（低 → 高）：foundation < platform < ui < feature < app，
//      层图在 config/frontend-layers.json。低层不得 import 高层，同层允许。
//   2. feature → feature：`src/features/X/**` import `src/features/Y/**`（Y≠X）
//      只允许解析到 `src/features/Y/index.ts(x)`（公开入口）。feature 层中
//      非 features 的顶层目录（command-palette、translation …）各自视为一个
//      feature 模块，同样适用此规则。
//   3. src/ 下每个顶层目录/顶层文件都必须在层图中登记；出现未登记的顶层项
//      直接失败（新目录必须先决定归属）。
//
// 统计口径：
//   - 计入：`import … from`、`export … from`、副作用 `import '…'`、`import('…')`。
//   - 不计：`import type` / `export type`、只含内联 type 的
//     `import { type A, type B }`、`vi.mock(…)`、裸包名、解析不到 src/ 内文件的路径。
//   - 解析：`@/` → src/，相对路径；无扩展名与 `/index` 依次尝试
//     .ts .tsx .js .jsx .mjs；去掉 `?url` / `?raw` 等 Vite 查询后缀。
//   - 扫描范围排除 `**/__tests__/**`、`*.test.*`、`*.spec.*`。
//
// 违规键：`${fromModule} -> ${目标文件(src/ 相对)}`，fromModule 对 features
// 取 `features/<name>`，其余取顶层目录名（或顶层文件名），因此源文件拆分/
// 挪动不改变键；同键去重。
//
// 归类说明（层图之外需要判断的顶层目录）：
//   - promptkit：聊天输入/容器的 prompt-kit 组件，仅服务 chat 能力，归 feature。
//   - menu：原生菜单事件桥，依赖 command-palette 的命令事件，归 feature。
//   - essay-grading / quick-assistant / translation / voice-input / command-palette：
//     自成一体的功能模块（有自己的 API、状态与界面），归 feature。
//   - boot：首帧 BootShell，只依赖平台能力，归 platform。
//   - dev / debug-panel / mcp-debug / demo / button-audit / __tests__：
//     调试、演示与入口级装配，位于最顶层 app。
//   - constants：当前不存在，预留在 foundation。
//
// 用法：
//   node scripts/check-frontend-layers.mjs            # 与基线比较，有新增违规时退出码 1
//   node scripts/check-frontend-layers.mjs --update   # 用当前违规重写基线
//   node scripts/check-frontend-layers.mjs --json     # 机器可读输出
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const CONFIG_PATH = path.join(ROOT, 'config', 'frontend-layers.json');
const BASELINE_PATH = path.join(ROOT, 'config', 'frontend-layers-baseline.json');

export const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];
const SCAN_EXTENSIONS = new Set(RESOLVE_EXTENSIONS);
export const KINDS = ['upward-layer', 'cross-feature-deep'];

/** src 相对路径（posix）是否属于测试代码 */
export function isTestPath(rel) {
  const parts = rel.split('/');
  if (parts.includes('__tests__')) return true;
  return /\.(test|spec)\.[^/]+$/.test(parts[parts.length - 1]);
}

/** 是否参与扫描的源文件（src 相对路径） */
export function isScannedSource(rel) {
  return SCAN_EXTENSIONS.has(path.posix.extname(rel)) && !isTestPath(rel);
}

/**
 * 模块归属：features/<name> 或顶层目录/顶层文件名。
 * 入参为 src 相对路径（posix，不带 `src/` 前缀）。
 */
export function moduleOf(rel) {
  const parts = rel.split('/');
  if (parts.length === 1) return parts[0];
  if (parts[0] === 'features' && parts.length > 2) return `features/${parts[1]}`;
  return parts[0];
}

/** 从源码中提取计入分层的 import 说明符 */
export function extractImports(code, fileName = 'file.tsx') {
  const kind = fileName.endsWith('.tsx') || fileName.endsWith('.jsx') ? ts.ScriptKind.TSX
    : fileName.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JSX;
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, false, kind);
  const out = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (isRuntimeImport(node.importClause)) out.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (isRuntimeExport(node)) out.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length > 0
      && ts.isStringLiteralLike(node.arguments[0])
    ) {
      out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function isRuntimeImport(clause) {
  if (!clause) return true; // import './side-effect'
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  const nb = clause.namedBindings;
  if (!nb) return true;
  if (ts.isNamespaceImport(nb)) return true;
  if (nb.elements.length === 0) return true;
  return nb.elements.some((el) => !el.isTypeOnly);
}

function isRuntimeExport(decl) {
  if (decl.isTypeOnly) return false;
  const ec = decl.exportClause;
  if (!ec || !ts.isNamedExports(ec)) return true; // export * / export * as ns
  if (ec.elements.length === 0) return true;
  return ec.elements.some((el) => !el.isTypeOnly);
}

/**
 * 把说明符解析为 src 相对路径；裸包名、src 外路径或解析不到时返回 null。
 * fileSet：src 下全部文件的 src 相对路径集合（含非代码资源）。
 */
export function resolveImport(fromRel, spec, fileSet) {
  const clean = spec.replace(/[?#].*$/, '');
  let base;
  if (clean.startsWith('@/')) base = clean.slice(2);
  else if (clean.startsWith('./') || clean.startsWith('../') || clean === '.' || clean === '..') {
    base = path.posix.join(path.posix.dirname(fromRel), clean);
  } else return null;
  base = path.posix.normalize(base).replace(/\/$/, '');
  if (base === '..' || base.startsWith('../')) return null;
  const candidates = [base];
  for (const ext of RESOLVE_EXTENSIONS) candidates.push(base + ext);
  // TS 风格 `./foo.js` 指向 foo.ts
  const m = base.match(/^(.*)\.(js|jsx|mjs)$/);
  if (m) for (const ext of ['.ts', '.tsx']) candidates.push(m[1] + ext);
  for (const ext of RESOLVE_EXTENSIONS) candidates.push(`${base}/index${ext}`);
  for (const c of candidates) if (fileSet.has(c)) return c;
  return null;
}

/** 由层图构建 顶层项 → { layer, rank } */
export function buildLayerMap(config) {
  const map = new Map();
  const problems = [];
  config.layers.forEach((layer, rank) => {
    for (const entry of layer.entries) {
      if (map.has(entry)) problems.push(`层图重复登记：${entry}（${map.get(entry).layer} / ${layer.name}）`);
      else map.set(entry, { layer: layer.name, rank });
    }
  });
  return { map, problems };
}

/**
 * 纯函数：给定 src 下文件与层图，计算分层违规。
 * @param {{ files: Record<string, string>, extraFiles?: string[], config: object }} input
 *   files：参与扫描的源文件（src 相对 posix 路径 → 源码）；
 *   extraFiles：其余 src 内文件路径（测试、资源等，只用于解析与顶层项登记检查）。
 */
export function checkFrontendLayers({ files, extraFiles = [], config }) {
  const { map: layerMap, problems } = buildLayerMap(config);
  const fileSet = new Set([...Object.keys(files), ...extraFiles]);

  const topLevel = new Set([...fileSet].map((f) => f.split('/')[0]));
  for (const top of [...topLevel].sort()) {
    if (!layerMap.has(top)) problems.push(`src/${top} 未在 config/frontend-layers.json 中登记层级`);
  }
  const absent = [...layerMap.keys()].filter((k) => !topLevel.has(k)).sort();

  const byKey = new Map();
  let importCount = 0;
  let unresolved = 0;
  const featureModuleTops = new Set(
    config.layers.find((l) => l.name === 'feature')?.entries.filter((e) => e !== 'features') ?? [],
  );
  const isFeatureModule = (mod) => mod.startsWith('features/') || featureModuleTops.has(mod);

  for (const rel of Object.keys(files).sort()) {
    const fromTop = rel.split('/')[0];
    const fromLayer = layerMap.get(fromTop);
    if (!fromLayer) continue;
    const fromModule = moduleOf(rel);
    for (const spec of extractImports(files[rel], rel)) {
      if (!(spec.startsWith('@/') || spec.startsWith('.'))) continue;
      importCount += 1;
      const target = resolveImport(rel, spec, fileSet);
      if (!target) {
        unresolved += 1;
        continue;
      }
      const toLayer = layerMap.get(target.split('/')[0]);
      if (!toLayer) continue;
      const toModule = moduleOf(target);
      let kind = null;
      if (toLayer.rank > fromLayer.rank) kind = 'upward-layer';
      else if (
        toModule !== fromModule
        && isFeatureModule(fromModule)
        && isFeatureModule(toModule)
        && !isModuleIndex(target, toModule)
      ) kind = 'cross-feature-deep';
      if (!kind) continue;
      const key = `${fromModule} -> src/${target}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.occurrences += 1;
        if (!existing.files.includes(rel)) existing.files.push(rel);
      } else {
        byKey.set(key, {
          key,
          kind,
          fromModule,
          fromLayer: fromLayer.layer,
          target: `src/${target}`,
          toModule,
          toLayer: toLayer.layer,
          occurrences: 1,
          files: [rel],
        });
      }
    }
  }

  const violations = [...byKey.values()].sort((a, b) => cmp(a.key, b.key));
  const totals = Object.fromEntries(KINDS.map((k) => [k, violations.filter((v) => v.kind === k).length]));
  return {
    violations,
    keys: violations.map((v) => v.key),
    totals,
    problems,
    absentEntries: absent,
    stats: { files: Object.keys(files).length, imports: importCount, unresolved },
  };
}

function isModuleIndex(target, toModule) {
  return target === `${toModule}/index.ts` || target === `${toModule}/index.tsx`;
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 与基线比较：新增（失败）与消失（提示 --update） */
export function diffBaseline(keys, baselineKeys) {
  const base = new Set(baselineKeys);
  const cur = new Set(keys);
  return {
    added: keys.filter((k) => !base.has(k)),
    removed: [...base].filter((k) => !cur.has(k)).sort(cmp),
  };
}

/** 按 (fromModule → toModule) 聚合，返回按违规键数降序的列表 */
export function summarizePairs(violations) {
  const pairs = new Map();
  for (const v of violations) {
    const k = `${v.fromModule} → ${v.toModule}`;
    const p = pairs.get(k) ?? { pair: k, keys: 0, occurrences: 0 };
    p.keys += 1;
    p.occurrences += v.occurrences;
    pairs.set(k, p);
  }
  return [...pairs.values()].sort((a, b) => b.keys - a.keys || cmp(a.pair, b.pair));
}

function walk(dir, rel = '', out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) walk(path.join(dir, ent.name), r, out);
    else if (ent.isFile()) out.push(r);
  }
  return out;
}

export function loadSourceTree(srcDir = SRC) {
  const files = {};
  const extraFiles = [];
  for (const rel of walk(srcDir)) {
    if (isScannedSource(rel)) files[rel] = fs.readFileSync(path.join(srcDir, rel), 'utf8');
    else extraFiles.push(rel);
  }
  return { files, extraFiles };
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const update = args.includes('--update');
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const result = checkFrontendLayers({ ...loadSourceTree(), config });
  const baseline = fs.existsSync(BASELINE_PATH)
    ? JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')).violations ?? []
    : [];
  const diff = diffBaseline(result.keys, baseline);

  if (update && result.problems.length === 0) {
    const body = {
      $comment: '由 `node scripts/check-frontend-layers.mjs --update` 生成：冻结的存量前端分层违规，只减不增。',
      violations: result.keys,
    };
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(body, null, 2)}\n`);
  }

  if (json) {
    console.log(JSON.stringify({
      totals: result.totals,
      problems: result.problems,
      added: diff.added,
      removed: diff.removed,
      stats: result.stats,
      violations: result.violations,
    }, null, 2));
  } else {
    console.log(`扫描 ${result.stats.files} 个源文件、${result.stats.imports} 条 src 内 import（${result.stats.unresolved} 条未解析，已忽略）`);
    console.log(`违规键合计：${KINDS.map((k) => `${k} ${result.totals[k]}`).join('，')}（基线 ${baseline.length}）`);
    if (result.absentEntries.length) console.log(`提示：层图登记但 src/ 下不存在：${result.absentEntries.join(', ')}`);
    if (result.problems.length) {
      console.error(`\n层图配置问题（${result.problems.length} 处）：`);
      for (const p of result.problems) console.error(`  - ${p}`);
    }
    if (update) {
      if (result.problems.length) console.error('\n存在层图配置问题，未写入基线。');
      else console.log(`\n已写入基线：${path.relative(ROOT, BASELINE_PATH)}（${result.keys.length} 条）`);
    } else {
      if (diff.removed.length) {
        console.log(`\n已消失的基线违规（${diff.removed.length} 条），请运行 npm run check:frontend-layers -- --update 收紧基线：`);
        for (const k of diff.removed) console.log(`  - ${k}`);
      }
      if (diff.added.length) {
        const byKey = new Map(result.violations.map((v) => [v.key, v]));
        console.error(`\n新增分层违规（${diff.added.length} 条）：`);
        for (const k of diff.added) {
          const v = byKey.get(k);
          console.error(`  - [${v.kind}] ${k}  (${v.fromLayer} → ${v.toLayer}; 来自 ${v.files.map((f) => `src/${f}`).join(', ')})`);
        }
        console.error('\n低层不得 import 高层；跨 feature 只能经由目标模块的 index.ts(x)。');
      } else if (!result.problems.length) {
        console.log('\n前端分层校验通过：无新增违规');
      }
    }
  }
  const failed = result.problems.length > 0 || (!update && diff.added.length > 0);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
