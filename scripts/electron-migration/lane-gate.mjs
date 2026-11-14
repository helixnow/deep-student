#!/usr/bin/env node
// lane 自检门禁：与集成门禁同一份检查列表（lib/gate-checks.mjs），对本分支相对 main 的改动运行。
// 每项检查经全局作业队列执行（类型检查/测试/构建各有并发上限，排队期间不占 CPU）。
// 通过后记录到 .oc-runs/selfgate/<lane>.json：集成时优先测试自检通过的 lane，一次过的概率高得多。
//
// 用法（在你自己的工作树里，先提交全部改动并 git merge main）：
//   node /home/dsdev/dev/deep-student/scripts/electron-migration/lane-gate.mjs
// 退出码：0 全部通过；1 有检查失败（输出失败摘录）；2 前置条件不满足（未提交改动 / 未合并最新 main）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gateChecks } from './lib/gate-checks.mjs';
import { excerptFailures, failedKeysFromJson, judgeTestsJson, loadBaselineFailures, withJsonReport } from './lib/gate-excerpt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNS = path.join(ROOT, '.oc-runs');
const JOB = path.join(ROOT, 'scripts/electron-migration/jobs/job.mjs');
const BASELINE = loadBaselineFailures(path.join(RUNS, 'fulltest', 'latest.json'));
const cwd = process.cwd();
const git = (...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
const lane = branch.replace(/^ds-mig\//, '');
if (!branch.startsWith('ds-mig/')) {
  console.error(`当前分支 ${branch} 不是 lane 分支（ds-mig/<lane>）`);
  process.exit(2);
}
const dirty = git('status', '--porcelain', '--untracked-files=no');
if (dirty) {
  console.error(`有未提交的改动，先提交再自检（自检结果按提交记录）：\n${dirty.split('\n').slice(0, 10).join('\n')}`);
  process.exit(2);
}
try {
  git('merge-base', '--is-ancestor', 'main', 'HEAD');
} catch {
  console.error('分支没有包含最新的 main：先 git merge --no-edit main（解决冲突并提交）再自检——集成时就是对最新 main 合并后测试的。');
  process.exit(2);
}
const tip = git('rev-parse', 'HEAD');
const base = git('rev-parse', 'main');
const runId = `${Date.now()}-${process.pid}`;
const checks = gateChecks(cwd, base);
console.log(`${lane}：自检 ${checks.length} 项（${checks.map((c) => c.name).join('、')}），经作业队列执行……`);

const runOne = (c0) => new Promise((resolve) => {
  // 宿主测试另写 vitest JSON 报告，失败按用例 status 判定（与集成门禁 gate-runner 相同）
  const report = path.join(RUNS, 'selfgate', lane, runId, `${c0.name.replace(/[^\w.-]+/g, '_')}.vitest.json`);
  const c = withJsonReport(c0, report);
  if (c !== c0) {
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.rmSync(report, { force: true });
  }
  const envPrefix = Object.entries(c.env ?? {}).map(([k, v]) => `${k}=${v}`);
  const command = envPrefix.length ? ['env', ...envPrefix, c.bin, ...c.args] : [c.bin, ...c.args];
  const child = spawn(process.execPath, [JOB, 'run', '--tail', '3000', '--', ...command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  child.on('close', (code) => {
    const r = { name: c.name, ok: code === 0, code, excerpt: code === 0 ? '' : excerptFailures(out) };
    resolve(c.name === 'tests' ? judgeTestsJson(r, out, BASELINE, failedKeysFromJson(report, cwd)) : r);
  });
});
const results = await Promise.all(checks.map(runOne));
const failed = results.filter((r) => !r.ok);
const headAfter = git('rev-parse', 'HEAD');
const dirtyAfter = git('status', '--porcelain', '--untracked-files=no');
if (headAfter !== tip || dirtyAfter) failed.push({ name: 'source-stability', code: 2, excerpt: '验证期间HEAD或工作树变化，结果不可签收；请提交稳定源码后重新自检' });
fs.mkdirSync(path.join(RUNS, 'selfgate'), { recursive: true });
fs.writeFileSync(path.join(RUNS, 'selfgate', `${lane}.json`), JSON.stringify({
  lane, tip, base, runId, headAfter, dirtyAfter, ok: !failed.length, at: new Date().toISOString(), failed: failed.map((r) => r.name),
}));
if (!failed.length) {
  console.log(`✅ 自检全部通过（${tip.slice(0, 9)}，基线 main ${base.slice(0, 9)}）。可以标记完成，集成时会优先测试你的分支。`);
  process.exit(0);
}
console.log(`❌ 自检未通过 ${failed.length}/${results.length} 项：`);
for (const r of failed) console.log(`  ${r.name}（退出码 ${r.code}）：${r.excerpt}`);
process.exit(1);
