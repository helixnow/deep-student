#!/usr/bin/env node
// host/ 与 electron/ 的架构边界检查（规则见 lib/boundary-rules.mjs 的 RULES）。
// 用法：
//   node scripts/arch/boundaries.mjs [--check] [--json] [路径…]
//   node scripts/arch/boundaries.mjs --write-baseline
// 默认无参数运行：逐条打印全部现存违规并退出码 1；
// --check 模式：对照 scripts/arch/gate-checks/host-boundaries-baseline.json（按 规则+文件 计数棘轮，只减不增），仅拦新增违规。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/tree-sitter-rust.mjs';
import { RULES, checkFile, isSourceFile } from './lib/boundary-rules.mjs';
import { applyCountBaseline, countBaselineEntries } from './gate-checks/baseline.mjs';

const BASELINE_FILE = path.join(ROOT, 'scripts/arch/gate-checks/host-boundaries-baseline.json');

const args = process.argv.slice(2);
const json = args.includes('--json');
const checkMode = args.includes('--check');
const writeBaseline = args.includes('--write-baseline');
const roots = args.filter((a) => !a.startsWith('--'));

function walk(dir, acc) {
  if (!fs.existsSync(dir)) return acc;
  const st = fs.statSync(dir);
  if (st.isFile()) {
    acc.push(dir);
    return acc;
  }
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'dist' || e.name === 'out') continue;
    walk(path.join(dir, e.name), acc);
  }
  return acc;
}

const files = [];
for (const r of roots.length ? roots : ['host', 'electron']) walk(path.resolve(ROOT, r), files);
const violations = [];
let scanned = 0;
for (const abs of files.sort()) {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  if (!isSourceFile(rel)) continue;
  scanned++;
  violations.push(...checkFile(rel, fs.readFileSync(abs, 'utf8')));
}
const suppressed = violations.filter((v) => v.suppressed);
violations.splice(0, violations.length, ...violations.filter((v) => !v.suppressed));

const keyOf = (item) => `${item.rule}\0${item.file}`;
const entryOf = (item) => ({ rule: item.rule, file: item.file });

if (writeBaseline) {
  const previous = fs.existsSync(BASELINE_FILE) ? JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) : null;
  const entries = countBaselineEntries(violations, previous, keyOf, entryOf, [(e) => e.rule, (e) => e.file]);
  fs.writeFileSync(
    BASELINE_FILE,
    `${JSON.stringify(
      {
        description: 'Host / Electron 架构边界棘轮基线（按 规则+文件 计数，只减不增）。见 scripts/arch/boundaries.mjs。',
        entries,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`boundaries: wrote baseline (${entries.length} entries, ${violations.length} total findings)`);
  process.exit(0);
}

if (checkMode) {
  const baseline = fs.existsSync(BASELINE_FILE) ? JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) : { entries: [] };
  const { fresh, stale } = applyCountBaseline(violations, baseline, keyOf);
  if (json) {
    console.log(JSON.stringify({ scanned, fresh, stale, totalViolations: violations.length, suppressed: suppressed.length }, null, 2));
  } else {
    for (const v of fresh) console.log(`NEW ${v.file}:${v.line}:${v.col} [${v.rule}] ${v.message}`);
    console.log(
      `boundaries (--check): scanned ${scanned} files, ${fresh.length} new violation(s), ${violations.length} baselined, ${stale.length} improved file-rule bucket(s), ${suppressed.length} suppressed`,
    );
  }
  if (fresh.length > 0) process.exitCode = 1;
  process.exit(fresh.length > 0 ? 1 : 0);
}

if (json) {
  console.log(JSON.stringify({ scanned, violations, suppressed }, null, 2));
} else {
  for (const v of violations) console.log(`${v.file}:${v.line}:${v.col} [${v.rule}] ${v.message}`);
  for (const v of suppressed) console.log(`(allowed) ${v.file}:${v.line}:${v.col} [${v.rule}]`);
  const byRule = {};
  for (const v of violations) byRule[v.rule] = (byRule[v.rule] ?? 0) + 1;
  console.log(`boundaries: scanned ${scanned} files, ${violations.length} violation(s)${violations.length ? ` ${JSON.stringify(byRule)}` : ''}, ${suppressed.length} suppressed via boundary-allow; rules: ${Object.keys(RULES).join(', ')}`);
}
if (violations.length) process.exitCode = 1;
