#!/usr/bin/env node
/**
 * Bundle 体积门禁（WI-8）：检查 dist/assets 关键 JS chunk 的 gzip 体积。
 *
 * 用法：
 *   node scripts/check-bundle-size.mjs              # 超限 exit 1（阻塞模式）
 *   node scripts/check-bundle-size.mjs --warn-only  # 超限只告警，exit 0（引入期）
 *   node scripts/check-bundle-size.mjs --dist-dir /path/to/dist
 *
 * 必须先构建：npx vite build（脚本只测量，不构建）。
 *
 * 阈值 = 基线 × 1.03（R3 起收紧为 +3%，SA-R3-06）。
 *
 * 基线演进记录（zlib.gzipSync level 9，无 sourcemap）：
 * - 2026-08-24 (commit 1bf03a24, R2): total JS 8,311.2 KiB, entry 1,184.2 KiB,
 *   init-*.js 1,396.9 KiB, vendor-milkdown 387.1 KiB。
 * - 2026-11-25 (Wave-2 Bundle Diet, post-b20025):
 *   1) 移除 ~1.9 MiB gz 冗余依赖与冷启动回归：
 *      - FlowToken DefaultCode 替换为零外部依赖轻量桩（移除 @tabler/icons-react /
 *        react-syntax-highlighter / highlight.js，-997 KiB gz, -469 files）
 *      - Milkdown Crepe @codemirror/language-data 裁剪为 ~31 种常用语言（-400+ KiB gz）
 *      - CodeBlock 统一到现有按需 prismjs（移除 react-syntax-highlighter/prism，-180+ KiB gz）
 *      - Anki 卡面 KaTeX 字体由 ?inline 改为 ?url 按需 fetch→base64，chunk-strategy 排除
 *        带 ? 查询参数的资源，冷启动 vendor-katex 268.2 → 158.1 KiB (-110.1 KiB gz)
 *      - MCP SDK 默认 AjvJsonSchemaValidator 生产桩替换（已全量走 CSP 安全 cfworker）
 *      - @sentry/browser 改为命名导出门面（tree-shake 掉未用 Replay/Feedback，111.3 → 37.9 KiB）
 *      - InlineSmiles / SmilesText 统一复用 openchemlib（移除 smiles-drawer，-57.7 KiB gz）
 *      - abcjs 改直连 SVG engraver（移除 MIDI synth）& 3dmol 改用 3Dmol-min（-27.3 KiB gz）
 *   2) 将脆弱的 Rollup 自动命名 `init-*.js` 改为确定性检查「最大非入口非 vendor 应用 chunk」，
 *      并新增 `vendor-katex-*.js` 显式门禁，同时收紧 entry / milkdown / app chunk 基线。
 *   3) 诚实校准 total JS 基线（8,311.2 → 9,806.1 KiB, +1,494.9 KiB 净增），覆盖 2026-08-24
 *      之后新增的按需懒加载特性账本：
 *      - 科学可视化 RichCodeRenderer 懒加载库：@viz-js/viz (470K)、openchemlib (330K)、
 *        vega-embed/lite (235K)、3dmol (158K)、abcjs SVG (129K)、wavedrom (23K) ≈ 1,345 KiB
 *      - 按需导出与工具库：pdfmake (287K)、pdf-lib (175K)、jsQR (46K)、snapdom (39K) ≈ 547 KiB
 *      - 多语言文案增长 (+198 KiB) 与 +40% 业务源码（Memory v2 / Plugin v2 / Media Studio /
 *        Sandbox / Essay Grading / FSRS / Data Governance / Sync / Mobile）
 *
 * 有意降低体积后请把对应 baselineBytes 改小，收紧门禁；
 * 合理增长（新功能）需在 PR 里说明并更新基线。
 */
import { existsSync, readdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const distDirArg = process.argv.indexOf('--dist-dir');
if (distDirArg !== -1 && (!process.argv[distDirArg + 1] || process.argv[distDirArg + 1].startsWith('--'))) {
  console.error('error: --dist-dir requires a directory path');
  process.exit(1);
}
const DIST_DIR = distDirArg === -1 ? 'dist' : process.argv[distDirArg + 1];
const ASSETS_DIR = join(DIST_DIR, 'assets');
/** 允许超出基线的比例（+3%）。 */
const HEADROOM = 1.03;

/**
 * 关键 chunk 预算。kind：
 *   entry       — index.html 的 module script 引用的入口文件本身（不含依赖闭包）
 *   largest-app — 除入口文件与 vendor-*.js 之外体积最大的单个应用 chunk（不依赖 Rollup 自动命名）
 *   chunk       — 按文件名模式匹配（多个匹配时取最大者）
 *   total       — dist/assets 下全部 .js 的 gzip 总和
 * baselineBytes 为 gzip(level 9) 字节数。
 */
const BUDGETS = [
  { name: 'entry (HTML module script)', kind: 'entry', baselineBytes: 1_113_670 },
  { name: 'largest app chunk', kind: 'largest-app', baselineBytes: 663_408 },
  { name: 'vendor-mermaid-*.js', kind: 'chunk', pattern: /^vendor-mermaid-[\w-]+\.js$/, baselineBytes: 734_881 },
  { name: 'vendor-pptx-*.js', kind: 'chunk', pattern: /^vendor-pptx-[\w-]+\.js$/, baselineBytes: 436_143 },
  { name: 'vendor-milkdown-*.js', kind: 'chunk', pattern: /^vendor-milkdown-[\w-]+\.js$/, baselineBytes: 330_483 },
  { name: 'vendor-exceljs-*.js', kind: 'chunk', pattern: /^vendor-exceljs-[\w-]+\.js$/, baselineBytes: 269_554 },
  { name: 'vendor-katex-*.js', kind: 'chunk', pattern: /^vendor-katex-[\w-]+\.js$/, baselineBytes: 161_855 },
  { name: 'total JS (dist/assets/*.js)', kind: 'total', baselineBytes: 10_041_440 },
];

const warnOnly =
  process.argv.includes('--warn-only') || process.env.BUNDLE_SIZE_WARN_ONLY === '1';

if (!existsSync(ASSETS_DIR)) {
  console.error(
    `error: ${ASSETS_DIR} not found — run \`npx vite build\` before check-bundle-size`,
  );
  process.exit(1);
}

const gzipSize = (file) => gzipSync(readFileSync(file), { level: 9 }).length;
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

const jsFiles = readdirSync(ASSETS_DIR).filter((f) => f.endsWith('.js'));
const sizeCache = new Map();
const sizeOf = (f) => {
  if (!sizeCache.has(f)) sizeCache.set(f, gzipSize(join(ASSETS_DIR, f)));
  return sizeCache.get(f);
};

/** 读取构建 HTML 中的本地 module 入口，文件名前缀由 Vite 决定。 */
function resolveEntryFile() {
  const html = readFileSync(join(DIST_DIR, 'index.html'), 'utf8');
  for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) {
    if (!/\btype\s*=\s*(['"])module\1/i.test(tag)) continue;
    const src = tag.match(/\bsrc\s*=\s*(['"])(.*?)\1/i)?.[2];
    if (!src || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(src)) continue;
    const match = src.match(/(?:^|\/)assets\/([^/?#]+\.js)(?:[?#].*)?$/);
    if (match) return match[1];
  }
  return null;
}

const resolvedEntry = resolveEntryFile();
const rows = [];
const violations = [];

for (const budget of BUDGETS) {
  const maxBytes = Math.ceil(budget.baselineBytes * HEADROOM);
  let actualBytes = null;
  let detail = '';

  if (budget.kind === 'entry') {
    if (resolvedEntry) {
      actualBytes = sizeOf(resolvedEntry);
      detail = resolvedEntry;
    } else {
      violations.push(`${budget.name}: no local <script type="module" src="…/assets/*.js"> in ${join(DIST_DIR, 'index.html')}`);
    }
  } else if (budget.kind === 'largest-app') {
    const appChunks = jsFiles.filter((f) => f !== resolvedEntry && !f.startsWith('vendor-'));
    if (appChunks.length > 0) {
      const largest = appChunks.reduce((a, b) => (sizeOf(a) >= sizeOf(b) ? a : b));
      actualBytes = sizeOf(largest);
      detail = `${largest} (of ${appChunks.length} app chunks)`;
    } else {
      violations.push(`${budget.name}: no non-entry/non-vendor JS chunks found in ${ASSETS_DIR}`);
    }
  } else if (budget.kind === 'chunk') {
    const matches = jsFiles.filter((f) => budget.pattern.test(f));
    if (matches.length > 0) {
      // 多个匹配时取最大者：hash 变化不影响，且不会漏掉超限文件
      const largest = matches.reduce((a, b) => (sizeOf(a) >= sizeOf(b) ? a : b));
      actualBytes = sizeOf(largest);
      detail = matches.length > 1 ? `${largest} (+${matches.length - 1} more)` : largest;
    } else {
      // chunk 被改名/拆分时门禁会静默失效 —— 显式报出来，提示更新预算表
      violations.push(`${budget.name}: no file matches ${budget.pattern} — update BUDGETS`);
    }
  } else {
    actualBytes = jsFiles.reduce((sum, f) => sum + sizeOf(f), 0);
    detail = `${jsFiles.length} files`;
  }

  if (actualBytes === null) continue;

  const over = actualBytes > maxBytes;
  if (over) {
    violations.push(
      `${budget.name}: gzip ${kb(actualBytes)} exceeds limit ${kb(maxBytes)} (baseline ${kb(budget.baselineBytes)} +3%)`,
    );
  }
  rows.push({
    name: budget.name,
    detail,
    actualBytes,
    maxBytes,
    deltaPct: ((actualBytes / budget.baselineBytes - 1) * 100).toFixed(1),
    status: over ? 'OVER' : 'ok',
  });
}

console.log('\nBundle size check (gzip, limit = baseline +3%)\n');
for (const row of rows) {
  console.log(
    `  [${row.status.padEnd(4)}] ${row.name.padEnd(30)} ${kb(row.actualBytes).padStart(11)} / ${kb(row.maxBytes).padStart(11)}  (${row.deltaPct}% vs baseline)  ${row.detail}`,
  );
}
console.log('');

// GitHub Actions job summary（与 npm audit / cargo audit 步骤同风格，红字可见）
if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = [
    `## Bundle size check ${violations.length > 0 ? (warnOnly ? '⚠️' : '❌') : '✅'}`,
    '',
    '| chunk | gzip | limit | Δ vs baseline | status |',
    '| --- | ---: | ---: | ---: | --- |',
    ...rows.map(
      (r) => `| ${r.name} | ${kb(r.actualBytes)} | ${kb(r.maxBytes)} | ${r.deltaPct}% | ${r.status} |`,
    ),
    '',
  ];
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'));
}

if (violations.length > 0) {
  const annotation = warnOnly ? 'warning' : 'error';
  for (const violation of violations) {
    console.log(`::${annotation}::bundle-size: ${violation}`);
  }
  if (warnOnly) {
    console.log('\nwarn-only mode: violations reported as warnings, exiting 0');
    process.exit(0);
  }
  process.exit(1);
}

console.log('All bundle size budgets satisfied.');
