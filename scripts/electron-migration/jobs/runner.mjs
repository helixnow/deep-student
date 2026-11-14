#!/usr/bin/env node
// 重任务作业执行器（全局唯一，systemd ds-jobs.service 运行在 dsdev.slice 内）。
//
// 作业由 job.mjs submit 写入 <JOBS>/queue/<id>.json（{ id, cwd, cmd: [bin, ...args], from, submittedAt }），
// 本进程按类别限流、先进先出执行，结果写到 <JOBS>/done/<id>.json（退出码、起止时间）与 <id>.log（完整输出）。
// 类别与默认并发：typecheck（tsc）8、test（vitest）8、build（vite build）2、other 6；可用 --limits typecheck=8,test=8,... 覆盖。
// tsc 作业自动加增量编译（每个工作目录独立缓存 .lane.tsbuildinfo），重复检查只算变化部分。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { admission, resources } from '../lib/resource-budget.mjs';
import { jobTmpRoot, jobTmpDir } from './tmp-dir.mjs';

const JOBS = process.env.OC_JOBS_DIR ?? path.join(process.env.HOME ?? '/tmp', '.oc-jobs');
const QUEUE = path.join(JOBS, 'queue');
const RUNNING = path.join(JOBS, 'running');
const DONE = path.join(JOBS, 'done');
for (const d of [QUEUE, RUNNING, DONE]) fs.mkdirSync(d, { recursive: true });
// Resolved once at startup so a misconfigured OC_JOBS_TMP_DIR stops the runner instead of failing each job.
const TMP_ROOT = jobTmpRoot({ jobsDir: JOBS });

const argv = process.argv.slice(2);
const limits = { typecheck: 2, test: 3, build: 1, other: 2, rust: 1 };
const li = argv.indexOf('--limits');
if (li >= 0) for (const kv of argv[li + 1].split(',')) { const [k, v] = kv.split('='); limits[k] = Number(v); }
const TIMEOUT_MS = 30 * 60_000;
// Rust（cargo/rustc）单独成类：冷编译 20–60 分钟，30 分钟上限会把它杀掉（2026-11-05 X7 WP-012 被阻塞于此）。
const TIMEOUT_BY_CLASS = { rust: Number(process.env.DS_RUST_TIMEOUT_MIN ?? '150') * 60_000 };
const now = () => new Date().toISOString();

export function classify(cmd) {
  const s = cmd.join(' ');
  if (/(^|[\s/=])(cargo|rustc)(\s|$)/.test(s)) return 'rust';
  if (/(^|[\s/])tsc(\s|$)|tsgo(\s|$)/.test(s)) return 'typecheck';
  if (/(^|[\s/])vitest(\s|$)/.test(s)) return 'test';
  if (/(^|[\s/])vite(\s|$).*\bbuild\b|\bbuild:demo\b|npm run -?s? ?build\b/.test(s)) return 'build';
  return 'other';
}

/** tsc 自动加增量编译（未显式指定时）。 */
function withIncremental(cmd) {
  const s = cmd.join(' ');
  if (!/(^|[\s/])tsc(\s|$)/.test(s) || /--incremental|--build|\s-b(\s|$)|--watch/.test(s)) return cmd;
  return [...cmd, '--incremental', '--tsBuildInfoFile', '.lane.tsbuildinfo'];
}

const running = new Map(); // id -> { cls, child, lane }

// ---- 调度策略：让 CPU 跑满又不互相打架 ----
// 1) CPU 压力自适应：资源组 cpu.pressure 的 some avg10 > HIGH 时暂停派发；< LOW 且有排队时允许每类临时多跑 BURST 个。
// 2) 集成门禁运行时（.oc-runs/integrate.lock 的持有进程存活）各类上限收紧到 3/4，给合入 main 的关键路径让路。
// 3) 公平：优先派发"当前在跑作业最少"的 lane 的作业，同 lane 内先到先得。
const PRESSURE_FILE = '/sys/fs/cgroup/dsdev.slice/cpu.pressure';
const INTEGRATE_LOCK = process.env.OC_INTEGRATE_LOCK ?? '/home/dsdev/dev/deep-student/.oc-runs/integrate.lock';
const HIGH = 40;
const LOW = 10;
const MAX_RUNNING = 6;
let draining = false;
function cpuPressure() {
  try {
    return Number(/some avg10=([\d.]+)/.exec(fs.readFileSync(PRESSURE_FILE, 'utf8'))?.[1] ?? 0);
  } catch {
    return 0;
  }
}
function integrating() {
  try {
    const text = fs.readFileSync(INTEGRATE_LOCK, 'utf8').trim();
    const pid = /^\d+$/.test(text) ? Number(text) : JSON.parse(text).pid;
    if (!Number.isInteger(pid) || pid <= 1) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 启动时：上次运行中被中断的作业记为失败（执行器重启）。
for (const f of fs.readdirSync(RUNNING).filter((x) => x.endsWith('.json'))) {
  const job = JSON.parse(fs.readFileSync(path.join(RUNNING, f), 'utf8'));
  fs.writeFileSync(path.join(DONE, `${job.id}.json`), JSON.stringify({ ...job, code: -1, endedAt: now(), note: '作业执行器重启，作业被中断，请重新提交' }));
  fs.rmSync(path.join(RUNNING, f));
}

function start(job) {
  let tmpdir;
  try {
    tmpdir = jobTmpDir(job.id, { jobsDir: JOBS, env: { OC_JOBS_TMP_DIR: TMP_ROOT } });
  } catch (e) {
    // The id also names DONE/RUNNING files, so an unsafe id cannot get a result record either.
    console.error(`${now()} 丢弃作业：${e.message}`);
    return;
  }
  const cls = classify(job.cmd);
  const cmd = withIncremental(job.cmd);
  const log = fs.openSync(path.join(DONE, `${job.id}.log`), 'w');
  const startedAt = now();
  const source = () => {
    try {
      const git = (...args) => execFileSync('git', args, { cwd: job.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
      return { head: git('rev-parse', 'HEAD'), dirty: git('diff', '--name-only', 'HEAD') };
    } catch { return null; }
  };
  const sourceBefore = source();
  fs.mkdirSync(tmpdir, { recursive: true });
  fs.writeFileSync(path.join(RUNNING, `${job.id}.json`), JSON.stringify({ ...job, cls, startedAt }));
  const child = spawn(cmd[0], cmd.slice(1), {
    cwd: job.cwd, stdio: ['ignore', log, log], detached: true,
    env: { ...process.env, ...(job.env ?? {}), TMPDIR: tmpdir, ...(cls === 'build' ? { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=8192`.trim() } : {}), VITEST_MAX_FORKS: process.env.VITEST_MAX_FORKS ?? '3', VITEST_MAX_THREADS: process.env.VITEST_MAX_THREADS ?? '3' },
  });
  const terminate = (signal) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch { /* group already exited */ }
  };
  let killTimer;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    terminate('SIGTERM');
    killTimer = setTimeout(() => terminate('SIGKILL'), 10_000);
  }, TIMEOUT_BY_CLASS[cls] ?? TIMEOUT_MS);
  running.set(job.id, { cls, child, lane: job.from });
  let finished = false;
  const finish = (code, note, signal = null) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    clearTimeout(killTimer);
    // Reap only this job's descendants, including Xvfb/dbus left by its workers.
    terminate('SIGTERM');
    const reap = setTimeout(() => terminate('SIGKILL'), 3000);
    reap.unref();
    fs.closeSync(log);
    running.delete(job.id);
    fs.writeFileSync(path.join(DONE, `${job.id}.json`), JSON.stringify({ ...job, cmd, cls, startedAt, endedAt: now(), code, signal, tmpdir, sourceBefore, sourceAfter: source(), ...(note ? { note } : {}) }));
    fs.rmSync(path.join(RUNNING, `${job.id}.json`), { force: true });
  };
  child.on('error', (e) => finish(127, `无法启动：${e.message}`));
  child.on('exit', (code, signal) => finish(code, timedOut ? `execution timeout (${(TIMEOUT_BY_CLASS[cls] ?? TIMEOUT_MS) / 60000} min), signal=${signal}` : signal ? `signal=${signal}` : undefined, signal));
}

function tick() {
  let files;
  try {
    files = fs.readdirSync(QUEUE).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return;
  }
  const count = (cls) => [...running.values()].filter((r) => r.cls === cls).length;
  const laneLoad = (lane) => [...running.values()].filter((r) => r.lane === lane).length;
  const metrics = resources();
  const budget = admission(metrics);
  const pressure = metrics.pressure;
  const integ = integrating();
  const cap = (cls) => {
    let n = limits[cls] ?? limits.other;
    if (cls === 'rust' || cls === 'build') n = Math.min(1, n);
    if (integ) n = Math.max(1, Math.floor(n * 0.75));
    return n;
  };
  const jobs = [];
  for (const f of files) {
    try {
      jobs.push({ f, job: JSON.parse(fs.readFileSync(path.join(QUEUE, f), 'utf8')) });
    } catch {
      // 正在写入，下一秒再看
    }
  }
  if (!draining && budget.ok) {
    // 公平：按（该 lane 当前在跑数，提交时间）排序后依次派发
    jobs.sort((a, b) => laneLoad(a.job.from) - laneLoad(b.job.from) || a.f.localeCompare(b.f));
    for (const { f, job } of jobs) {
      if (running.size >= MAX_RUNNING) break;
      const cls = classify(job.cmd);
      if (count(cls) >= cap(cls)) continue;
      start(job);
      // Publish RUNNING before removing QUEUE so wait clients never see a gap.
      fs.rmSync(path.join(QUEUE, f), { force: true });
    }
  }
  // 状态快照供客户端显示排队位置
  fs.writeFileSync(path.join(JOBS, 'status.json'), JSON.stringify({
    at: now(), limits,
    running: Object.fromEntries(Object.keys(limits).map((c) => [c, count(c)])),
    queued: files.length,
    cpuPressure: pressure,
    integrating: integ,
    paused: draining || !budget.ok, draining, metrics, reasons: budget.reasons,
  }));
  if (draining && !running.size) process.exit(0);
}

// Restart without interrupting active jobs. systemd restarts after the queue drains.
process.on('SIGUSR2', () => { draining = true; });

// 清理 3 天前的结果
setInterval(() => {
  const cutoff = Date.now() - 3 * 86400_000;
  for (const f of fs.readdirSync(DONE)) {
    const p = path.join(DONE, f);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p);
    } catch {
      // 已被删除
    }
  }
}, 3600_000);

console.log(`${now()} 作业执行器启动，目录 ${JOBS}，作业 TMPDIR 根 ${TMP_ROOT}，并发上限 ${JSON.stringify(limits)}`);
setInterval(tick, 1000);
