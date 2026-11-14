#!/usr/bin/env node
// host/ 与 electron/ 的架构边界检查（规则见 lib/boundary-rules.mjs 的 RULES）。
// 用法：node scripts/electron-migration/boundaries.mjs [--json] [路径…]
//   默认扫描 host/ 与 electron/ 下全部源码；发现违规时逐条打印 `文件:行:列 [规则] 说明` 并退出码 1。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/tree-sitter-rust.mjs';
import { RULES, checkFile, isSourceFile } from './lib/boundary-rules.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
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
