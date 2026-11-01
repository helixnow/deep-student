#!/usr/bin/env node
// ============================================================================
// ESLint 告警棘轮（CI Gate，基线只减不增）
//
// 职责：把"先 warn、逐步清理"的规则存量按 (规则, 模块) 冻结在
// config/lint-ratchet-baseline.json，CI 只拦截"变多"。
//   1. 受棘轮约束的规则：所有 `ds-components/*`、`no-restricted-syntax`、
//      `react-hooks/exhaustive-deps`、`no-console`。
//   2. 模块口径与 scripts/check-frontend-layers.mjs 的 fromModule 一致：
//      features 下取 `features/<name>`，其余取 src/ 顶层目录名（或顶层文件名）。
//   3. 任一 (规则, 模块) 告警数超过基线即失败；ESLint 报告任何 error
//      （含解析失败）也失败。低于基线时提示运行 --update 收紧。
//   4. `--update` 重写基线，但拒绝调高任何已有计数（含新出现的 (规则, 模块)，
//      视为 0 → N），列出将上涨的条目后退出码 1；确需调高时加 `--allow-increase`。
//      基线文件不存在时视为首次生成，直接写入。
//
// 用法：
//   node scripts/check-lint-ratchet.mjs                         # 自行运行 eslint src/ -f json
//   node scripts/check-lint-ratchet.mjs eslint-report.json      # 读取已有 ESLint JSON 报告
//   node scripts/check-lint-ratchet.mjs --update [--allow-increase]
//   node scripts/check-lint-ratchet.mjs --json                  # 机器可读输出
// ============================================================================

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { moduleOf } from './check-frontend-layers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = path.join(ROOT, 'config', 'lint-ratchet-baseline.json');
const EXACT_RULES = new Set(['no-restricted-syntax', 'react-hooks/exhaustive-deps', 'no-console']);

export function isRatchetedRule(ruleId) {
  return typeof ruleId === 'string' && (ruleId.startsWith('ds-components/') || EXACT_RULES.has(ruleId));
}

/** 绝对/相对文件路径 → 模块名；不在 src/ 下返回 `(root)/<相对路径首段>` */
export function moduleOfFile(filePath, root = ROOT) {
  const rel = path.relative(root, filePath).split(path.sep).join('/');
  if (rel.startsWith('src/')) return moduleOf(rel.slice(4));
  return `(root)/${rel.split('/')[0]}`;
}

/**
 * 汇总 ESLint JSON 报告。
 * @returns {{ counts: Record<string, Record<string, number>>, errors: Array<object>, warnings: number }}
 *   counts：rule → module → 告警数（只含受棘轮约束的规则）。
 */
export function summarizeEslintReport(report, root = ROOT) {
  const counts = {};
  const errors = [];
  let warnings = 0;
  for (const file of report) {
    for (const m of file.messages ?? []) {
      if (m.severity === 2 || m.fatal) {
        errors.push({
          file: path.relative(root, file.filePath).split(path.sep).join('/'),
          line: m.line,
          ruleId: m.ruleId ?? '(fatal)',
          message: m.message,
        });
        continue;
      }
      if (m.severity !== 1) continue;
      warnings += 1;
      if (!isRatchetedRule(m.ruleId)) continue;
      const mod = moduleOfFile(file.filePath, root);
      counts[m.ruleId] ??= {};
      counts[m.ruleId][mod] = (counts[m.ruleId][mod] ?? 0) + 1;
    }
  }
  return { counts: sortCounts(counts), errors, warnings };
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortCounts(counts) {
  const out = {};
  for (const rule of Object.keys(counts).sort(cmp)) {
    const mods = {};
    for (const mod of Object.keys(counts[rule]).sort(cmp)) if (counts[rule][mod] > 0) mods[mod] = counts[rule][mod];
    if (Object.keys(mods).length) out[rule] = mods;
  }
  return out;
}

export function ruleTotals(counts) {
  return Object.fromEntries(
    Object.entries(counts).map(([rule, mods]) => [rule, Object.values(mods).reduce((a, b) => a + b, 0)]),
  );
}

/** 逐 (规则, 模块) 比较：increased 失败，decreased 提示收紧 */
export function compareCounts(current, baseline) {
  const increased = [];
  const decreased = [];
  const keys = new Set();
  for (const src of [current, baseline]) {
    for (const [rule, mods] of Object.entries(src)) for (const mod of Object.keys(mods)) keys.add(`${rule}\u0000${mod}`);
  }
  for (const k of [...keys].sort(cmp)) {
    const [rule, module] = k.split('\u0000');
    const now = current[rule]?.[module] ?? 0;
    const was = baseline[rule]?.[module] ?? 0;
    if (now > was) increased.push({ rule, module, baseline: was, current: now });
    else if (now < was) decreased.push({ rule, module, baseline: was, current: now });
  }
  return { increased, decreased };
}

function runEslint() {
  const require = createRequire(import.meta.url);
  const eslintBin = path.join(path.dirname(require.resolve('eslint/package.json')), 'bin', 'eslint.js');
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lint-ratchet-')), 'eslint.json');
  const res = spawnSync(process.execPath, [eslintBin, 'src/', '-f', 'json', '-o', outFile], {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  });
  // eslint 退出码：0 无 error，1 有 error（报告仍完整），2 配置/运行失败
  if (res.status === 2 || res.error || !fs.existsSync(outFile)) {
    console.error(`ESLint 运行失败（退出码 ${res.status}）${res.error ? `：${res.error.message}` : ''}`);
    process.exit(2);
  }
  const report = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  fs.rmSync(path.dirname(outFile), { recursive: true, force: true });
  return report;
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const update = args.includes('--update');
  const allowIncrease = args.includes('--allow-increase');
  const reportPath = args.find((a) => !a.startsWith('--'));

  const report = reportPath ? JSON.parse(fs.readFileSync(path.resolve(reportPath), 'utf8')) : runEslint();
  const summary = summarizeEslintReport(report);
  const hasBaseline = fs.existsSync(BASELINE_PATH);
  const baseline = hasBaseline ? JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')).counts ?? {} : {};
  const { increased, decreased } = compareCounts(summary.counts, baseline);
  const totals = ruleTotals(summary.counts);

  let failed = summary.errors.length > 0;
  let wrote = false;
  if (update) {
    if (increased.length && hasBaseline && !allowIncrease) {
      failed = true;
    } else {
      const body = {
        $comment: '由 `node scripts/check-lint-ratchet.mjs --update` 生成：受棘轮约束规则的存量告警，按 (规则, 模块) 只减不增。totals 仅供阅读。',
        totals,
        counts: summary.counts,
      };
      fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(body, null, 2)}\n`);
      wrote = true;
    }
  } else if (increased.length) {
    failed = true;
  }

  if (json) {
    console.log(JSON.stringify({ totals, errors: summary.errors, increased, decreased, wrote }, null, 2));
  } else {
    console.log(`ESLint：${report.length} 个文件，${summary.warnings} 条告警，${summary.errors.length} 条错误`);
    console.log('受棘轮约束规则合计（当前 / 基线）：');
    const baseTotals = ruleTotals(baseline);
    for (const rule of [...new Set([...Object.keys(totals), ...Object.keys(baseTotals)])].sort(cmp)) {
      console.log(`  ${rule.padEnd(40)} ${String(totals[rule] ?? 0).padStart(6)} / ${baseTotals[rule] ?? 0}`);
    }
    if (summary.errors.length) {
      console.error(`\nESLint 报告了 ${summary.errors.length} 条 error（不允许任何 error）：`);
      for (const e of summary.errors.slice(0, 50)) console.error(`  - ${e.file}:${e.line} [${e.ruleId}] ${e.message}`);
      if (summary.errors.length > 50) console.error(`  … 另有 ${summary.errors.length - 50} 条`);
    }
    if (increased.length && hasBaseline) {
      const refused = update && !allowIncrease;
      const log = update && !refused ? console.log : console.error;
      log(refused
        ? '\n以下计数将上涨，已拒绝更新基线（确需调高请加 --allow-increase）：'
        : update ? '\n以下计数已上调（--allow-increase）：' : '\n告警数超过基线：');
      for (const d of increased) log(`  - ${d.rule} @ ${d.module}: ${d.baseline} → ${d.current}`);
    }
    if (decreased.length && !update) {
      console.log(`\n${decreased.length} 处计数已低于基线，请运行 npm run check:lint-ratchet -- --update 收紧：`);
      for (const d of decreased) console.log(`  - ${d.rule} @ ${d.module}: ${d.baseline} → ${d.current}`);
    }
    if (wrote) console.log(`\n已写入基线：${path.relative(ROOT, BASELINE_PATH)}`);
    else if (!failed) console.log('\nESLint 棘轮校验通过：无新增告警');
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
