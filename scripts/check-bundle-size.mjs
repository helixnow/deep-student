#!/usr/bin/env node
/**
 * Bundle 体积门禁（WI-8）：检查 dist/assets 关键 JS chunk 的 gzip 体积。
 *
 * 用法：
 *   node scripts/check-bundle-size.mjs              # 超限 exit 1（阻塞模式）
 *   node scripts/check-bundle-size.mjs --warn-only  # 超限只告警，exit 0（引入期）
 *
 * 必须先构建：npx vite build（脚本只测量，不构建）。
 *
 * 阈值 = 基线 × 1.03。基线为 2026-08-24 在 commit 1bf03a24（R2 优化
 * 落地后：wallpapers 压缩 / pdfjs 精简 / dnd-kit 迁移）上
 * `npx vite build`（无 sourcemap）后用 zlib.gzipSync level 9 实测。
 * R1 引入期为 +5%，R3 起收紧为 +3%（SA-R3-06）。
 * 有意降低体积后请把对应 baselineBytes 改小，收紧门禁；
 * 合理增长（新功能）需在 PR 里说明并更新基线。
 */
import { existsSync, readdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const DIST_DIR = 'dist';
const ASSETS_DIR = join(DIST_DIR, 'assets');
/** 允许超出基线的比例（+3%）。 */
const HEADROOM = 1.03;

/**
 * 关键 chunk 预算。kind：
 *   entry   — dist/index.html <script> 引用的主入口 index-*.js
 *   chunk   — 按文件名模式匹配（多个匹配时取最大者）
 *   total   — dist/assets 下全部 .js 的 gzip 总和
 * baselineBytes 为 gzip(level 9) 字节数。
 */
const BUDGETS = [
  { name: 'entry (index-*.js)', kind: 'entry', baselineBytes: 1_212_646 },
  { name: 'init-*.js', kind: 'chunk', pattern: /^init-[\w-]+\.js$/, baselineBytes: 1_430_414 },
  { name: 'vendor-mermaid-*.js', kind: 'chunk', pattern: /^vendor-mermaid-[\w-]+\.js$/, baselineBytes: 734_881 },
  { name: 'vendor-pptx-*.js', kind: 'chunk', pattern: /^vendor-pptx-[\w-]+\.js$/, baselineBytes: 436_143 },
  { name: 'vendor-milkdown-*.js', kind: 'chunk', pattern: /^vendor-milkdown-[\w-]+\.js$/, baselineBytes: 396_367 },
  { name: 'vendor-exceljs-*.js', kind: 'chunk', pattern: /^vendor-exceljs-[\w-]+\.js$/, baselineBytes: 269_554 },
  { name: 'total JS (dist/assets/*.js)', kind: 'total', baselineBytes: 8_510_689 },
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

/** dist/index.html <script src="…/assets/index-XXXX.js"> 即主入口。 */
function resolveEntryFile() {
  const html = readFileSync(join(DIST_DIR, 'index.html'), 'utf8');
  const match = html.match(/<script[^>]+src="[^"]*assets\/(index-[\w-]+\.js)"/);
  return match ? match[1] : null;
}

const rows = [];
const violations = [];

for (const budget of BUDGETS) {
  const maxBytes = Math.ceil(budget.baselineBytes * HEADROOM);
  let actualBytes = null;
  let detail = '';

  if (budget.kind === 'entry') {
    const entry = resolveEntryFile();
    if (entry) {
      actualBytes = sizeOf(entry);
      detail = entry;
    } else {
      violations.push(`${budget.name}: no <script src="assets/index-*.js"> in dist/index.html`);
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
