#!/usr/bin/env node
// 定期全量测试（ds-fulltest.timer，每 2 小时）：在独立工作树 ../ds-fulltest 固定到当前 main，
// 4 个分片经全局作业队列执行（受 test 类并发上限约束），合并为 .oc-runs/fulltest/latest.json，
// 供监控面板的账本重算（ledger.mjs --vitest）得出真实的测试 B 级。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { allowedPaths, allLanes } from './lib/lane-paths.mjs';
import { fulltestVerdict } from './lib/fulltest-result.mjs';
import { pidRunsScript } from './lib/repair-actions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNS = path.join(ROOT, '.oc-runs');
const OUT = path.join(RUNS, 'fulltest');
const resumeIndex = process.argv.indexOf('--resume');
const RUN_ID = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : new Date().toISOString().replace(/[:.]/g, '') + `-${process.pid}`;
if (!/^[\wTZ-]+$/.test(RUN_ID)) throw new Error('invalid run ID');
const RUN_DIR = path.join(OUT, 'runs', RUN_ID);
const WT = path.resolve(ROOT, '..', 'ds-fulltest-runs', RUN_ID);
const JOB = path.join(ROOT, 'scripts/electron-migration/jobs/job.mjs');
const SHARDS = 8; // 1.2 万条测试在负载下单片超过作业队列 30 分钟上限（2026-11-05 分片 1 被 SIGTERM）
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

fs.mkdirSync(OUT, { recursive: true });
const LOCK = path.join(OUT, 'running.lock');
try {
  fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
} catch {
  const holder = Number(fs.readFileSync(LOCK, 'utf8'));
  if (pidRunsScript(holder, '/fulltest.mjs')) {
    log(`上一次全量测试仍在运行（pid ${holder}），跳过`);
    process.exit(0);
  }
  fs.writeFileSync(LOCK, String(process.pid));
}
process.on('exit', () => fs.rmSync(LOCK, { force: true }));

const sourceFile = path.join(RUN_DIR, 'source.json');
const head = resumeIndex >= 0 ? JSON.parse(fs.readFileSync(sourceFile, 'utf8')).head : git(ROOT, 'rev-parse', 'main');
fs.mkdirSync(RUN_DIR, { recursive: true });
fs.mkdirSync(path.dirname(WT), { recursive: true });
if (resumeIndex < 0) fs.writeFileSync(sourceFile, JSON.stringify({ head, runId: RUN_ID, worktree: WT, startedAt: new Date().toISOString() }));
if (!fs.existsSync(WT)) git(ROOT, 'worktree', 'add', '--detach', WT, head);
git(WT, 'checkout', '-q', '--detach', head);
const nm = path.join(WT, 'node_modules');
if (!fs.existsSync(nm)) fs.symlinkSync(path.join(ROOT, 'node_modules'), nm, 'dir');
try {
  execFileSync('npm', ['run', '-s', 'version:generate'], { cwd: WT, stdio: 'ignore', timeout: 120_000 });
} catch {
  // 版本文件生成失败只影响个别前端测试
}
log(`全量测试开始：main ${head.slice(0, 9)}，${SHARDS} 个分片经作业队列执行`);

const runShard = (i) => new Promise((resolve) => {
  const file = path.join(RUN_DIR, `shard-${i}.json`);
  const command = ['env', 'VITEST_MAX_FORKS=2', 'VITEST_MAX_THREADS=2', 'npx', 'vitest', 'run', '-c', 'vitest.host.config.ts',
    `--shard=${i}/${SHARDS}`, '--reporter=json', `--outputFile=${file}`];
  const submitted = path.join(RUN_DIR, `shard-${i}.submitted.json`);
  const previous = resumeIndex >= 0 && fs.existsSync(submitted) ? JSON.parse(fs.readFileSync(submitted, 'utf8')) : null;
  if (resumeIndex >= 0 && !previous) throw new Error(`No saved submission for shard ${i}; refusing duplicate work`);
  const jobId = previous?.jobId ?? execFileSync(process.execPath, [JOB, 'submit', '--', ...command], { cwd: WT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (!previous) fs.writeFileSync(submitted, JSON.stringify({ i, jobId, file, worktree: WT, head }));
  const child = spawn(process.execPath, [JOB, 'wait', jobId, '--tail', '5'], { cwd: WT, stdio: 'ignore' });
  child.on('close', (code) => {
    let jobReceipt;
    try { jobReceipt = JSON.parse(fs.readFileSync(path.join(process.env.OC_JOBS_DIR ?? path.join(process.env.HOME, '.oc-jobs'), 'done', `${jobId}.json`), 'utf8')); }
    catch { resolve({ i, code, jobId, report: null }); return; }
    let report = null;
    try {
      report = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      report = null;
    }
    const result = { i, code: jobReceipt.code, signal: jobReceipt.signal, clientCode: code, jobId, file, report };
    fs.writeFileSync(path.join(RUN_DIR, `shard-${i}.receipt.json`), JSON.stringify({ ...jobReceipt, shard: i, file, clientCode: code }));
    resolve(result);
  });
});
const shards = await Promise.all(Array.from({ length: SHARDS }, (_, k) => runShard(k + 1)));
const headAfter = git(WT, 'rev-parse', 'HEAD');
const dirty = git(WT, 'diff', '--name-only', 'HEAD');
const verdict = fulltestVerdict(shards, SHARDS, headAfter === head && !dirty);
fs.writeFileSync(path.join(RUN_DIR, 'verdict.json'), JSON.stringify({ ...verdict, head, headAfter, dirty }));
if (!verdict.complete || !verdict.stable) {
  log(`全测不完整或源码漂移，原件 ${RUN_DIR}；不替换 latest.json`);
  process.exit(1);
}
const sum = (k) => shards.reduce((a, s) => a + (s.report[k] ?? 0), 0);
// 红的判定必须同时看用例和套件：套件收集失败（如插件重复注册、import 崩溃）时 numFailedTests 为 0，
// 只看用例数会把"整个套件没跑起来"当成绿（2026-11-06 embedding-owner-errors 就这样藏了 8 小时）。
const failedTests = sum('numFailedTests');
const failedSuites = sum('numFailedTestSuites');
const ok = verdict.ok;
const merged = {
  head, at: new Date().toISOString(), runId: RUN_ID, runDir: RUN_DIR, worktree: WT,
  complete: verdict.complete, stable: verdict.stable,
  shards: shards.map(({ i, code, signal, jobId, file }) => ({ i, code, signal, jobId, file })), rawFailures: verdict.rawFailures,
  numTotalTests: sum('numTotalTests'), numPassedTests: sum('numPassedTests'), numFailedTests: failedTests,
  numPendingTests: sum('numPendingTests'), numTotalTestSuites: sum('numTotalTestSuites'), numFailedTestSuites: failedSuites,
  ok,
  success: ok,
  // 路径改为相对仓库根（账本在另一个工作树里按相对路径匹配）
  testResults: shards.flatMap((s) => s.report.testResults ?? []).map((r) => ({ ...r, name: path.isAbsolute(r.name) ? path.relative(WT, r.name) : r.name })),
};
fs.writeFileSync(path.join(RUN_DIR, 'merged.json'), JSON.stringify(merged));
fs.writeFileSync(path.join(OUT, 'latest.json.tmp'), JSON.stringify(merged));
fs.renameSync(path.join(OUT, 'latest.json.tmp'), path.join(OUT, 'latest.json'));
fs.appendFileSync(path.join(OUT, 'history.jsonl'), `${JSON.stringify({ head, at: merged.at, tests: merged.numTotalTests, passed: merged.numPassedTests, failed: merged.numFailedTests, pending: merged.numPendingTests, failedSuites: merged.numFailedTestSuites })}\n`);
log(`全量测试完成：用例 ${merged.numTotalTests}，通过 ${merged.numPassedTests}，失败 ${merged.numFailedTests}，pending ${merged.numPendingTests}，失败套件 ${merged.numFailedTestSuites}${ok ? '' : ' ← 红（用例或套件失败）'}`);

// ---- main 红灯分派：main 上失败的测试按目录归属发给负责 lane（每个 main 提交只发一次）----
const ownerOf = (file) => {
  let best = null;
  let len = -1;
  for (const l of allLanes()) for (const p of allowedPaths(l)) {
    const hit = p.endsWith('/') ? file.startsWith(p) : file === p;
    if (hit && p.length > len) {
      best = l;
      len = p.length;
    }
  }
  return best;
};
const sentFile = path.join(OUT, 'dispatched.json');
const sent = (() => {
  try {
    return JSON.parse(fs.readFileSync(sentFile, 'utf8'));
  } catch {
    return {};
  }
})();
const byOwner = {};
for (const t of merged.testResults) {
  const ar = t.assertionResults ?? [];
  const fails = ar.filter((a) => a.status === 'failed').map((a) => `${t.name} > ${[...(a.ancestorTitles ?? []), a.title].join(' > ')}`);
  if (t.status === 'failed' && !ar.length) fails.push(`${t.name}（文件加载失败：${String(t.message ?? '').split('\n')[0].slice(0, 120)}）`);
  if (!fails.length) continue;
  const owner = ownerOf(t.name) ?? 'C2-platform';
  (byOwner[owner] ??= []).push(...fails);
}
const sessions = JSON.parse(fs.readFileSync(path.join(RUNS, 'sessions.json'), 'utf8'));
for (const [lane, fails] of Object.entries(byOwner)) {
  if (!sessions[lane] || sessions[lane].parked || sent[`${lane}@${head}`]) continue;
  const message = `【main 红灯（全量测试 ${head.slice(0, 9)}，${merged.at.slice(11, 16)}Z）——请 C2 归因派包，勿直接重开旧任务】
以下测试在 main 上失败，且位于你负责的目录。main 上的既有失败不会挡住门禁，但它们说明 main 的行为是错的，并且会掩盖之后真正的回归，必须尽快修复：
${fails.slice(0, 40).map((f) => `- ${f}`).join('\n')}${fails.length > 40 ? `\n- ……另有 ${fails.length - 40} 项` : ''}

请先判断原因：是你自己的改动，还是和别的 lane 合并后接口或行为对不上。如果是别人的接口变了，立即用 coord.mjs escalate 说明证据和需要对方做什么。
修复提交写 fix(main-red)，然后 lane-gate 自检。`;
  fs.mkdirSync(path.join(RUNS, 'inbox'), { recursive: true });
  const f = path.join(RUNS, 'inbox', `${Date.now()}-fulltest-${lane}.json`);
    fs.writeFileSync(`${f}.tmp`, JSON.stringify({ lane: 'C2-platform', message: `原owner=${lane}，证据=${RUN_DIR}\n${message}`, from: 'fulltest', action: 'queue' }));
  fs.renameSync(`${f}.tmp`, f);
  sent[`${lane}@${head}`] = merged.at;
  log(`main 红灯已分派：${lane}（${fails.length} 项）`);
}
fs.writeFileSync(sentFile, JSON.stringify(sent));
// 有失败套件时以非零退出：调用方（timer/脚本）能感知红，而不是只看日志。
if (!ok) process.exitCode = 1;
