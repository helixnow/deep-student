#!/usr/bin/env node
// 集成门禁执行器：并发运行一组检查，汇总结果为 JSON（供 oc-dispatch integrate 调用）。
//
//   node scripts/electron-migration/gate-runner.mjs '<JSON>'
//   JSON：[{ "name": "typecheck", "bin": "npx", "args": [...], "env": { ... } }, ...]
// 输出（stdout，单行 JSON）：[{ "name", "ok", "code", "excerpt" }]；每项超时 15 分钟，宿主测试按目录数放宽（lib/gate-excerpt.mjs timeoutFor）。
// 设置 GATE_RAW_DIR 时保存原件：每项检查的完整输出 <name>.log（直接写盘，不截断）与 <name>.json
// （code、signal、起止时间、命令、是否重跑），全部结果 results.json。供协调者事后核对，不再只剩失败摘录。
import { spawn, execFileSync } from 'node:child_process';
import { INFRA_TIMEOUT, excerptFailures, timeoutFor, failedKeysFromJson, judgeTestsJson, loadBaselineFailures, withJsonReport } from './lib/gate-excerpt.mjs';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const checks = JSON.parse(process.argv[2] ?? '[]');
const BASELINE = loadBaselineFailures(process.env.GATE_BASELINE_FILE || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.oc-runs/fulltest/latest.json'));
const TIMEOUT_MS = 15 * 60_000;
const RAW = process.env.GATE_RAW_DIR || '';
if (RAW) fs.mkdirSync(RAW, { recursive: true });
const rawName = (c, attempt) => path.join(RAW, `${String(c.name).replace(/[^\w.-]+/g, '_')}${attempt ? `.retry${attempt}` : ''}`);

// 宿主测试另写 vitest JSON 报告：失败按用例 status 判定，不受输出截断和日志里预期错误文本的影响
const jsonFile = (c, attempt) => (RAW ? `${rawName(c, attempt)}.vitest.json` : path.join(os.tmpdir(), `gate-${process.pid}-${String(c.name).replace(/[^\w.-]+/g, '_')}-${attempt}.vitest.json`));

const run = (c0, attempt = 0) => new Promise((resolve) => {
  const startedAt = new Date().toISOString();
  const report = jsonFile(c0, attempt);
  const c = withJsonReport(c0, report);
  if (c !== c0) fs.rmSync(report, { force: true });
  // Integration and lane checks use the same global leaf-job budget.
  const jobClient = path.join(path.dirname(fileURLToPath(import.meta.url)), 'jobs/job.mjs');
  const envArgs = Object.entries(c.env ?? {}).map(([k, v]) => `${k}=${v}`);
  const command = envArgs.length ? ['env', ...envArgs, c.bin, ...c.args] : [c.bin, ...c.args];
  const jobId = execFileSync(process.execPath, [jobClient, 'submit', '--', ...command], { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const doneDir = path.join(process.env.OC_JOBS_DIR ?? path.join(os.homedir(), '.oc-jobs'), 'done');
  const child = spawn(process.execPath, [jobClient, 'wait', jobId, '--tail', '3000'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  const logFd = RAW ? fs.openSync(`${rawName(c, attempt)}.log`, 'w') : null;
  let out = '';
  const keep = (d) => {
    if (logFd != null) fs.writeSync(logFd, d);
    out += d;
    if (out.length > 4_000_000) out = out.slice(-2_000_000);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  // Execution timeout belongs to the queue runner; queue waiting must not kill
  // the client and leave its test mutating an integration tree after release.
  child.on('close', (clientCode, clientSignal) => {
    const receipt = JSON.parse(fs.readFileSync(path.join(doneDir, `${jobId}.json`), 'utf8'));
    const { code, signal = clientSignal } = receipt;
    const rawLog = path.join(doneDir, `${jobId}.log`);
    out = fs.readFileSync(rawLog, 'utf8');
    const excerpt = excerptFailures(out);
    const r = { name: c.name, ok: code === 0, code: code ?? signal, excerpt };
    if (logFd != null) {
      fs.closeSync(logFd);
      fs.copyFileSync(rawLog, `${rawName(c, attempt)}.log`);
      fs.writeFileSync(`${rawName(c, attempt)}.json`, JSON.stringify({ name: c.name, attempt, code, signal, clientCode, jobId, rawLog, ok: code === 0, startedAt, endedAt: new Date().toISOString(), bin: c.bin, args: c.args, env: c.env ?? {}, log: `${rawName(c, attempt)}.log` }, null, 1));
    }
    // 宿主测试按 main 基线判定：只拦新增失败（main 既有失败由全量测试分派给所有者修复）
    if (c.name !== 'tests') return resolve(r);
    const json = failedKeysFromJson(report, process.cwd());
    if (!RAW) fs.rmSync(report, { force: true });
    resolve({ ...judgeTestsJson(r, out, BASELINE, json), judgedBy: json ? 'vitest-json' : 'text' });
  });
});

// 全局构建槽：标记 serial 的检查（vite 构建，单个峰值 4GB+）跨所有并行集成工作树最多同时 GATE_BUILD_SLOTS 个。
// 槽 = 锁文件（内容为持有者 pid）；持有者已退出的锁视为过期，直接接管。
const SLOT_DIR = path.join(os.homedir(), '.oc-jobs', 'gate-slots');
const SLOTS = Number(process.env.GATE_BUILD_SLOTS ?? 3);
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function acquireSlot() {
  fs.mkdirSync(SLOT_DIR, { recursive: true });
  for (;;) {
    for (let i = 0; i < SLOTS; i++) {
      const f = path.join(SLOT_DIR, `slot-${i}.lock`);
      try {
        fs.writeFileSync(f, String(process.pid), { flag: 'wx' });
        return f;
      } catch {
        let holder = 0;
        try {
          holder = Number(fs.readFileSync(f, 'utf8'));
        } catch {
          holder = 0;
        }
        if (holder && !pidAlive(holder)) fs.rmSync(f, { force: true });
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}
async function runSerial(list) {
  const out = [];
  for (const c of list) {
    const slot = await acquireSlot();
    try {
      out.push(await run(c));
    } finally {
      fs.rmSync(slot, { force: true });
    }
  }
  return out;
}

// vitest worker 与主进程的 RPC 超时（"Timeout calling \"onTaskUpdate\""）是 CPU 争抢造成的基础设施故障，不是代码问题：
// 测试检查因此失败、且解析不出具体失败用例时，降低并发重跑一次。
const runWithInfraRetry = async (c) => {
  const r = await run(c);
  // 报告完整且 0 失败、只有 RPC 超时的情况已在 judgeTestsJson 里判为 ok（infra），不会走到这里重跑
  if (r.ok || !/^tests/.test(c.name) || !INFRA_TIMEOUT.test(r.excerpt) || /×|新增失败/.test(r.excerpt)) return r;
  const retry = await run({ ...c, env: { ...(c.env ?? {}), VITEST_MAX_FORKS: '2', VITEST_MAX_THREADS: '2' } }, 1);
  if (retry.ok) return { ...retry, excerpt: `（首次因 worker RPC 超时失败，降并发重跑通过）${retry.excerpt}` };
  // 重跑仍是 worker/基础设施故障、且解析不出具体失败用例 → 判为工具故障，不记 lane 失败。
  // integrate-parallel 对 "gate-runner: " 前缀的失败不写入 gate-fail（否则无辜 lane 会被"无新提交即跳过"白白跳过 3 小时）。
  if (INFRA_TIMEOUT.test(retry.excerpt) && !/×|新增失败/.test(retry.excerpt)) {
    return { ...retry, infra: true, excerpt: `gate-runner: 基础设施故障（worker RPC 超时或测试进程崩溃），降并发重跑仍失败，本轮不记 lane 失败：${retry.excerpt}`.slice(0, 1500) };
  }
  return retry;
};

const concurrent = checks.filter((c) => !c.serial);
const serial = checks.filter((c) => c.serial);
const [a, b] = await Promise.all([Promise.all(concurrent.map(runWithInfraRetry)), runSerial(serial)]);
const byName = new Map([...a, ...b].map((r) => [r.name, r]));
const results = checks.map((c) => byName.get(c.name));
if (RAW) fs.writeFileSync(path.join(RAW, 'results.json'), JSON.stringify(results, null, 1));
process.stdout.write(JSON.stringify(results));
