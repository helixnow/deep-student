// 回归：按 integrate-parallel.mjs 的输出格式固定的 2026-11-04 故障轮与正常轮快照，验证熔断判定。
// 快照用 .txt：仓库 .gitignore 忽略 **/*.log。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { detectSystemicFault, parseIntegrateLog } from './integrate-fault.mjs';

const fixture = (n) => fs.readFileSync(new URL(`./fixtures/integrate-fault/${n}`, import.meta.url), 'utf8');

test('门禁工具崩溃的轮次判为 tool 故障（22:00 / 22:04 两轮）', () => {
  for (const n of ['tool-fault-1.txt', 'tool-fault-2.txt']) {
    const f = detectSystemicFault(fixture(n));
    assert.equal(f?.kind, 'tool', n);
    assert.ok(f.lanes.length >= 40, `${n}: ${f.lanes.length}`);
  }
});

test('正常轮次（30/43 通过、失败原因各异）不触发熔断', () => {
  const out = fixture('normal.txt');
  const { candidates, failures } = parseIntegrateLog(out);
  assert.ok(candidates >= 40 && failures.length > 0 && failures.length < candidates);
  assert.equal(detectSystemicFault(out), null);
});

test('大量 lane 因同一原因失败判为 uniform 故障；原因各异则不判', () => {
  const mk = (reasons) => `候选 ${reasons.length} 条\n${reasons.map((r, i) => `L${i}: 未合入（门禁未过：\n    ${r}）`).join('\n')}`;
  const same = Array.from({ length: 12 }, (_, i) => `tests: Error: ENOSPC no space left on device ${i * 3}ms`);
  assert.equal(detectSystemicFault(mk(same))?.kind, 'uniform');
  const varied = Array.from({ length: 12 }, (_, i) => `tests: × case_${i} expected ${i}`);
  assert.equal(detectSystemicFault(mk(varied)), null);
});
