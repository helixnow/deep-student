#!/usr/bin/env node
/**
 * 制卡质量 eval：回放全部 fixture 并打印指标草表。
 *
 * 用法：node scripts/anki-eval/run-eval.mjs [--json]
 *   --json  以 JSON 输出完整结果（供 CI 工件归档 / 趋势对比）
 *
 * 退出码：0 = 全部 fixture 符合 manifest 预期；1 = 存在偏离（回归）。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAll } from './lib/harness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const asJson = process.argv.includes('--json');

const pct = (x) => `${(x * 100).toFixed(1)}%`;

function printMetrics(label, m) {
  console.log(`\n  [${label}] cases=${m.cases} segments=${m.totalSegments}`);
  console.log(
    `    parse_ok=${m.parseOk}  repair_ok=${m.repairOk}  error_card=${m.errorCards}  dropped_prose=${m.droppedProse}  lint_flagged=${m.lintFlagged}`
  );
  console.log(
    `    parse_success_rate=${pct(m.parseSuccessRate)}  error_card_rate=${pct(m.errorCardRate)}  lint_flag_rate=${pct(m.lintFlagRate)}`
  );
}

const { results, failures, metricsBySet, goldPairs } = await runAll(repoRoot);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        failures,
        metrics: metricsBySet,
        cases: results.map(({ caseDef, actual }) => ({
          id: caseDef.id,
          set: caseDef.set,
          category: caseDef.category,
          outcomes: actual.cards.map((c) => c.outcome),
          lintCodes: actual.cards.map((c) => c.lintCodes),
          droppedProse: actual.droppedProse,
        })),
        goldPairs: goldPairs.results.map((r) => ({
          id: r.id,
          originalCodes: r.originalCodes,
          editedCodes: r.editedCodes,
          problems: r.problems,
        })),
      },
      null,
      2
    )
  );
} else {
  console.log('anki eval：坏输出回放基线');
  console.log('='.repeat(60));
  for (const { caseDef, actual, problems } of results) {
    const status = problems.length === 0 ? 'PASS' : 'FAIL';
    const outcomes = actual.cards
      .map((c) => c.outcome + (c.lintCodes.length ? `[${c.lintCodes.join(',')}]` : ''))
      .join(' ');
    console.log(`  ${status}  ${caseDef.id.padEnd(32)} ${outcomes || '(无卡片段)'}`);
    for (const p of problems) console.log(`        ↳ ${p}`);
  }
  console.log('\n金标修正对回归（改前=劣化应命中 lint、改后=金标应零命中）');
  console.log('='.repeat(60));
  for (const r of goldPairs.results) {
    const status = r.problems.length === 0 ? 'PASS' : 'FAIL';
    console.log(
      `  ${status}  ${r.id.padEnd(32)} original[${r.originalCodes.join(',')}] → edited[${r.editedCodes.join(',') || '∅'}]`
    );
    for (const p of r.problems) console.log(`        ↳ ${p}`);
  }

  console.log('\n指标草表');
  console.log('='.repeat(60));
  printMetrics('bad（坏样本集）', metricsBySet.bad);
  printMetrics('good（好卡对照集）', metricsBySet.good);
  printMetrics('all（全量）', metricsBySet.all);
}

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} 个 fixture 偏离基线预期`);
  process.exit(1);
}
console.log('\n✓ 全部 fixture 符合基线预期');
