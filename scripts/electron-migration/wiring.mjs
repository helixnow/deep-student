#!/usr/bin/env node
// 接线检查：TESTMAP 中 `ported:` 的测试，所测的插件内模块是否从插件入口 index.ts 可达（即生产路径确实使用）。
// quality.md §3.3：只有生产代码已接入，才能标 ported。本脚本只读，输出每条 lane 的"ported 但未接入"统计。
//
//   node scripts/electron-migration/wiring.mjs [--json] [--lane <dir>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PLUGINS = path.join(ROOT, 'host/plugins');
const args = process.argv.slice(2);
const only = args.includes('--lane') ? args[args.indexOf('--lane') + 1] : null;

const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolveRel(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

function importsOf(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  for (let m; (m = IMPORT_RE.exec(text)); ) {
    const r = resolveRel(file, m[1] ?? m[2]);
    if (r) out.push(r);
  }
  return out;
}

const isTest = (f) => /\.test\.ts$/.test(f) || /\/tests\//.test(f) || /__fixtures__/.test(f);

function reachable(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f) || isTest(f)) continue;
    seen.add(f);
    for (const d of importsOf(f)) stack.push(d);
  }
  return seen;
}

// 全局可达集：从所有插件入口 index.ts 出发（含跨插件经 api.ts 的再导出）。
const globalWired = new Set();
for (const d of fs.readdirSync(PLUGINS)) {
  const e = path.join(PLUGINS, d, 'index.ts');
  if (fs.existsSync(e)) for (const f of reachable(e)) globalWired.add(f);
}

const results = [];
for (const dir of fs.readdirSync(PLUGINS).sort()) {
  if (only && dir !== only) continue;
  const pdir = path.join(PLUGINS, dir);
  const entry = path.join(pdir, 'index.ts');
  const testmap = path.join(pdir, 'TESTMAP.md');
  if (!fs.existsSync(testmap)) continue;
  const wired = globalWired;
  const rows = fs.readFileSync(testmap, 'utf8').split('\n').filter((l) => /^\| `/.test(l));
  let ported = 0;
  let unwired = 0;
  const byFile = new Map();
  for (const row of rows) {
    const m = /ported:\s*([^\s|]+)/.exec(row);
    if (!m) continue;
    ported++;
    const testFile = path.resolve(ROOT, m[1]);
    if (!fs.existsSync(testFile)) continue;
    // 被测模块：测试文件直接导入的、本插件内的非测试模块
    const subjects = importsOf(testFile).filter((f) => f.startsWith(pdir + path.sep) && !isTest(f) && !f.endsWith(`${path.sep}api.ts`));
    if (!subjects.length) continue; // 只经 createTestHost/命令调用的测试，视为走生产入口
    if (!subjects.some((f) => wired.has(f))) {
      unwired++;
      const k = path.relative(ROOT, testFile);
      byFile.set(k, (byFile.get(k) ?? 0) + 1);
    }
  }
  results.push({ plugin: dir, ported, unwired, files: [...byFile.entries()].sort((a, b) => b[1] - a[1]) });
}

if (args.includes('--json')) {
  console.log(JSON.stringify(results, null, 2));
} else {
  let tp = 0;
  let tu = 0;
  for (const r of results) {
    tp += r.ported;
    tu += r.unwired;
    if (!r.unwired) continue;
    console.log(`${r.plugin.padEnd(22)} ported ${String(r.ported).padStart(4)}  未接入 ${String(r.unwired).padStart(4)}  ${r.files.slice(0, 3).map(([f, n]) => `${path.basename(f)}×${n}`).join(' ')}`);
  }
  console.log(`合计 ported ${tp}，其中所测模块未从 index.ts 接入 ${tu}（${tp ? ((tu / tp) * 100).toFixed(1) : 0}%）`);
}
