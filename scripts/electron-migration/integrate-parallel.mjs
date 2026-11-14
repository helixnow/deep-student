#!/usr/bin/env node
// 并行集成：多条 lane 同时在各自的临时工作树里对同一个 main 基线过门禁，通过的再按顺序合入，
// 合入后对整体做一次快速复核（类型检查 + 边界），通过才快进 main。输出格式与 oc-dispatch integrate 相同，
// 守护进程的结果解析与门禁失败反馈无需改动。
//
//   node scripts/electron-migration/integrate-parallel.mjs [--jobs 2] [--lanes a,b@sha] [--owner 名字]
//
// --lanes 里 lane@sha 表示只合到该提交（须仍在分支上）；指定 lane 时按给定顺序合入。
// 不带 --lanes 时先取 coord integrate 排队的批次（lib/orch-control.mjs，.oc-runs/integrate.queue/），队列空才跑全部候选。
// 锁为租约（lib/integrate-lease.mjs）：每个集成动作续租；holds 与他人锁的 deny 作用域只过滤命中的 lane/提交血缘。
// 日志里的"[阶段] X"标记供守护进程判定异常退出停在哪一步（lib/integrate-heartbeat.mjs）。
//
// 与串行集成相同的规则：越界检查、候选（分支最新提交，不过时回退到最近一个非 WIP 提交）、
// lane 自有 LANE/SPEC/TESTMAP 冲突以 lane 版本为准、host/src 门禁项（gate-runner 并发执行）。
// 整体复核失败时退回逐条合入：每合一条做一次快速复核，只合入能共存的 lane。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { allowedPaths } from './lib/lane-paths.mjs';
import { gateChecks } from './lib/gate-checks.mjs';
import * as lease from './lib/integrate-lease.mjs';
import { writeFileAtomic } from './lib/atomic-write.mjs';
import * as control from './lib/orch-control.mjs';
import { orderBatch, loadDeferred, deferredFile } from './lib/batch-order.mjs';

const { deniedBy } = lease;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNS = path.join(ROOT, '.oc-runs');
const WT_ROOT = path.resolve(ROOT, '..', 'ds-mig');
const STAMP = path.join(RUNS, 'integrate.last');
const STRICT_FROM = Date.parse(process.env.DSTU_STRICT_FROM ?? '2026-11-03T17:00:00Z');
const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
let JOBS = Math.max(1, Number(opt('jobs', '2')));
const now = () => new Date().toISOString();
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim();
const inScope = (lane, f) => allowedPaths(lane).some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p));

// ---- 锁（租约，lib/integrate-lease.mjs）----
// 每完成一个集成动作续租；写 main 前确认租约仍属于自己，被收回（超时未续）则停止，不在无锁状态下写 main。
const probe = lease.defaultProbe(ROOT);
{
  const r = lease.acquire(RUNS, { owner: opt('owner', 'integrate-parallel'), probe, reason: `integrate-parallel --jobs ${opt('jobs', '2')}${opt('lanes') ? ` --lanes ${opt('lanes')}` : ''}` });
  if (!r.ok) {
    console.log(`integrate 已在运行（pid ${r.holder?.pid}，${r.holder?.owner ?? '?'}，租约 ${r.state}，到期 ${r.holder?.expiresAt ?? '?'}），跳过`);
    process.exit(0);
  }
}
fs.writeFileSync(STAMP, now());
process.on('exit', () => lease.release(RUNS));
const renew = (what) => {
  if (lease.renew(RUNS)) return;
  console.log(`[阶段] 失去租约：${what} 时集成锁已不属于本进程（被收回或改写），停止，不写 main`);
  process.exit(3);
};
const phase = (name) => {
  console.log(`[阶段] ${name}`);
  renew(`进入${name}`);
};
if (git(ROOT, 'rev-parse', '--abbrev-ref', 'HEAD') !== 'main') throw new Error('主工作树不在 main 上');
// Preflight before expensive gates. Never discard WIP to make integration green.
const mainDirty = git(ROOT, 'status', '--porcelain', '--untracked-files=no');
if (mainDirty) {
  lease.appendIncident(RUNS, { kind: 'integration-worktree-blocked', files: mainDirty });
  console.log(`[阶段] 前置阻塞：main 有未提交改动，请 owner 保全并提交；不运行门禁、不归责业务 lane\n${mainDirty}`);
  process.exitCode = 2;
  process.exit(2);
}
phase('选候选');

const sessions = JSON.parse(fs.readFileSync(path.join(RUNS, 'sessions.json'), 'utf8'));
const laneNames = Object.keys(sessions).filter((k) => !k.startsWith('__')).sort();
const isAncestor = (c, ref) => {
  try {
    git(ROOT, 'merge-base', '--is-ancestor', c, ref);
    return true;
  } catch {
    return false;
  }
};
// 指定批次：命令行 --lanes，或（未指定时）coord integrate 排队的队首批次
let lanesArg = opt('lanes') ? control.parseLanes(opt('lanes')) : null;
let queued = null;
if (!lanesArg) {
  queued = control.takeQueued(RUNS, {
    alive: probe.alive,
    pending: (lane, pin) => {
      const b = sessions[lane]?.branch;
      if (!b) return false;
      try {
        return pin ? !isAncestor(pin, 'main') : Number(git(ROOT, 'rev-list', '--count', `main..${b}`)) > 0;
      } catch {
        return false;
      }
    },
  });
  if (queued) {
    lanesArg = queued.lanes;
    JOBS = control.clampJobs(queued.jobs);
    console.log(`执行排队批次 ${queued.id}（${queued.by}：${queued.reason || '未写原因'}）：${control.lanesSpec(lanesArg)}，并行 ${JOBS}`);
    process.on('exit', (code) => {
      if (code === 0) control.finishQueued(RUNS, queued);
      else control.requeue(RUNS, queued.file, `集成器退出码 ${code}`);
    });
  }
}
const explicit = Boolean(lanesArg);
const pins = Object.fromEntries((lanesArg ?? []).filter((l) => l.pin).map((l) => [l.lane, l.pin]));
const selected = lanesArg ? lanesArg.map((l) => l.lane) : laneNames;
const ownerOf = (file) => {
  let best;
  let len = -1;
  for (const l of laneNames) for (const p of allowedPaths(l)) {
    const hit = p.endsWith('/') ? file.startsWith(p) : file === p;
    if (hit && p.length > len) {
      best = l;
      len = p.length;
    }
  }
  return best;
};

function ensureWorktree(dir, ref) {
  if (!fs.existsSync(dir)) git(ROOT, 'worktree', 'add', '--detach', dir, ref);
  const nm = path.join(dir, 'node_modules');
  if (!fs.existsSync(nm)) fs.symlinkSync(path.join(ROOT, 'node_modules'), nm, 'dir');
}

/** 合并 ref 到 cwd 当前 HEAD；lane 自有文档冲突以 lane 版本为准。返回 null 或冲突说明。 */
function mergeInto(cwd, lane, ref, label) {
  const s = sessions[lane];
  const ownDocs = allowedPaths(lane).filter((p) => p.endsWith('/')).flatMap((p) => ['LANE.md', 'SPEC.md', 'TESTMAP.md'].map((f) => `${p}${f}`));
  try {
    git(cwd, 'merge', '--no-ff', '--no-edit', '-m', label, ref);
    return null;
  } catch (e) {
    const unmerged = git(cwd, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
    if (unmerged.length && unmerged.every((f) => ownDocs.includes(f))) {
      for (const f of unmerged) {
        git(cwd, 'checkout', '--theirs', '--', f);
        git(cwd, 'add', '--', f);
      }
      git(cwd, 'commit', '--no-edit');
      return null;
    }
    try {
      git(cwd, 'merge', '--abort');
    } catch {
      // 没有进行中的合并
    }
    return `合并冲突：${unmerged.slice(0, 5).join(', ') || String(e.stderr || e.message).split('\n')[0]}（${s.branch}）`;
  }
}

// 门禁原件：.oc-runs/gate-raw/<本轮时间>/<序号>-<lane 或阶段>/ 下保存 meta.json（候选、base、试合并提交、起止、
// gate-runner 退出码/信号）、每项检查的完整输出与 code/signal（gate-runner 写入）、gate-runner 自身 stderr。
const RAW_ROOT = path.join(RUNS, 'gate-raw', now().replace(/[:.]/g, ''));
let rawSeq = 0;
function runGate(cwd, checks, meta = {}) {
  const dir = path.join(RAW_ROOT, `${String(++rawSeq).padStart(2, '0')}-${String(meta.tag ?? 'gate').replace(/[^\w.-]+/g, '_')}`);
  fs.mkdirSync(dir, { recursive: true });
  const startedAt = now();
  let merge = '';
  try {
    merge = git(cwd, 'rev-parse', 'HEAD');
  } catch {
    merge = '';
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts/electron-migration/gate-runner.mjs'), JSON.stringify(checks)], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GATE_RAW_DIR: dir } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    // 门禁可能超过租约 TTL（整体复核 tests 15 分钟加重跑）：子进程在跑期间每 5 分钟续租；锁被收回则停门禁、不写 main
    const hb = lease.keepAlive(RUNS, {
      onLost: () => {
        console.log(`[阶段] 失去租约：${meta.tag ?? '门禁'} 运行中集成锁已不属于本进程（被收回或改写），停止，不写 main`);
        child.kill('SIGTERM');
        process.exit(3);
      },
    }).start();
    child.on('close', (code, signal) => {
      hb.stop();
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ ...meta, cwd, merge, startedAt, endedAt: now(), runnerCode: code, runnerSignal: signal, checks: checks.map((c) => c.name) }, null, 1));
      if (err) fs.writeFileSync(path.join(dir, 'gate-runner.stderr.log'), err);
      try {
        const failed = JSON.parse(out).filter((r) => !r.ok).map((r) => `${r.name}: ${r.excerpt}`);
        resolve(failed);
      } catch {
        resolve([`gate-runner: ${err.split('\n').slice(0, 3).join(' | ')}（原件 ${dir}）`]);
      }
      if (meta.lane) console.log(`    原件：${meta.lane} 门禁 → ${dir}`);
    });
  });
}

// ---- 第 0 步：挑出候选 lane ----
// 上次门禁失败且之后没有新提交的 lane 跳过（结果必然相同，白占一轮 CPU）；超过 3 小时放行一次（main 的变化可能已使其通过）。
const FAILS_FILE = path.join(RUNS, 'gate-fail.json');
const fails = (() => {
  try {
    return JSON.parse(fs.readFileSync(FAILS_FILE, 'utf8'));
  } catch {
    return {};
  }
})();
const selfgate = (lane) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(RUNS, 'selfgate', `${lane}.json`), 'utf8'));
  } catch {
    return null;
  }
};
const base = git(ROOT, 'rev-parse', 'main');
// 作用域拒绝（holds + 他人锁的 deny）：只过滤命中的 lane / 提交血缘，其余照常集成
const denyRules = lease.effectiveDeny(RUNS);
if (denyRules.length) console.log(`作用域拒绝规则 ${denyRules.length} 条：${denyRules.map((r) => r.rule).join(', ')}`);
const todo = [];
for (const lane of selected) {
  const s = sessions[lane];
  if (!s) continue;
  // 子代理接管的 lane 停放只为不让守护进程恢复它，集成照常（否则接管成果永远合不进 main）
  if (s.parked && !explicit && !String(s.parkReason ?? '').includes('子代理接管')) {
    console.log(`${lane}: 已停放，跳过`);
    continue;
  }
  const ahead = Number(git(ROOT, 'rev-list', '--count', `main..${s.branch}`));
  if (!ahead) {
    console.log(`${lane}: 无新提交`);
    continue;
  }
  const changed = git(ROOT, 'diff', '--name-only', `main...${s.branch}`).split('\n').filter(Boolean);
  const outside = changed.filter((f) => {
    if (inScope(lane, f)) return false;
    const owner = ownerOf(f);
    if (!owner || !sessions[owner]) return true;
    const commits = git(ROOT, 'log', '--no-merges', '--format=%H', `main..${s.branch}`, '--', f).split('\n').filter(Boolean);
    return !commits.every((c) => isAncestor(c, sessions[owner].branch));
  });
  if (outside.length) {
    console.log(`${lane}: 拒绝合入，改动超出范围：\n    ${outside.join('\n    ')}`);
    continue;
  }
  const tip = git(ROOT, 'rev-parse', s.branch);
  let lastOwn = '';
  try {
    lastOwn = git(ROOT, 'log', '-1', '--format=%H', '--no-merges', '--invert-grep', '--grep=^wip(', s.branch);
  } catch {
    lastOwn = '';
  }
  const candidates = [tip];
  if (lastOwn && lastOwn !== tip && !isAncestor(lastOwn, 'main')) candidates.push(lastOwn);
  if (pins[lane]) {
    // 指定提交：只合到它；它必须仍在分支上且未入 main
    let pin = '';
    try {
      pin = git(ROOT, 'rev-parse', '--verify', `${pins[lane]}^{commit}`);
    } catch {
      pin = '';
    }
    if (!pin || !isAncestor(pin, tip) || isAncestor(pin, 'main')) {
      console.log(`${lane}: 指定提交 ${pins[lane]} ${!pin ? '不存在' : isAncestor(pin, 'main') ? '已在 main' : '不在分支上'}，跳过`);
      continue;
    }
    candidates.splice(0, candidates.length, pin);
  }
  if (denyRules.length) {
    const blockedBy = candidates.map((ref) => deniedBy(denyRules, { lane, ref, isAncestor }));
    if (blockedBy.every(Boolean)) {
      console.log(`${lane}: 作用域保留，跳过（${blockedBy[0]}）`);
      continue;
    }
    for (let i = candidates.length - 1; i >= 0; i--) if (blockedBy[i]) candidates.splice(i, 1);
  }
  const rec = fails[lane];
  if (!explicit && rec && rec.tip === tip && Date.now() - Date.parse(rec.at) < 3 * 3600_000) {
    console.log(`${lane}: 上次门禁失败（${rec.at.slice(11, 16)}Z）后无新提交，跳过`);
    continue;
  }
  const sg = selfgate(lane);
  const pinned = Boolean(pins[lane]);
  const n = pinned ? Number(git(ROOT, 'rev-list', '--count', `main..${candidates[0]}`)) : ahead;
  todo.push({ lane, ahead: n, tip, pinned, candidates, selfGated: Boolean(sg?.ok && sg.tip === (pinned ? candidates[0] : tip)) });
}
// 指定批次（--lanes）保持给定顺序（合入顺序 = 协调者审定的顺序），也不截断：截掉的部分不会再被排队批次取回。
// 自动轮：自检通过（且自检时的提交就是当前分支头）的优先，同为自检通过时被暂缓最久的优先（lib/batch-order.mjs）。
// 批次上限：全量屏障让第一条合入要等 90 分钟，而且整体复核一失败就退化成逐条（再 +75 分钟）。
// 小批滚动把可见周期压到 ~25 分钟，吞吐不降；超出部分下一轮继续（每 15 分钟一轮）。
if (!explicit) {
  const MAX_BATCH = Number(process.env.DS_INTEGRATE_MAX_BATCH ?? 8);
  const r = orderBatch(todo, loadDeferred(RUNS), MAX_BATCH, now());
  todo.splice(0, todo.length, ...r.batch);
  writeFileAtomic(deferredFile(RUNS), JSON.stringify(r.deferred, null, 1));
  if (r.held.length) console.log(`批次上限 ${MAX_BATCH} 条，本轮暂缓 ${r.held.length} 条（下一轮继续）：${r.held.map((t) => t.lane).join(', ')}`);
}
console.log(`候选 ${todo.length} 条，其中自检通过 ${todo.filter((t) => t.selfGated).length} 条`);

// ---- 第 1 步：并行门禁（每条 lane 在自己的临时工作树里对基线 main 试合并）----
phase('门禁');
const passed = [];
let next = 0;
async function worker(k) {
  const dir = path.join(WT_ROOT, `_integration-p${k}`);
  ensureWorktree(dir, base);
  while (next < todo.length) {
    const t = todo[next++];
    let failure = null;
    for (const ref of t.candidates) {
      git(dir, 'reset', '--hard', base);
      git(dir, 'clean', '-fdq', '-e', 'node_modules', '-e', '*.tsbuildinfo');
      const label = `merge ${sessions[t.lane].branch}${ref === t.tip ? '' : ` @${ref.slice(0, 9)}`}`;
      failure = mergeInto(dir, t.lane, ref, label);
      if (!failure) {
        const failed = await runGate(dir, gateChecks(dir, base), { tag: t.lane, phase: '门禁', lane: t.lane, candidate: ref, tip: t.tip, base });
        renew(`${t.lane} 门禁结束`);
        failure = failed.length ? `门禁未过：\n    ${failed.join('\n    ')}` : null;
      }
      if (!failure) {
        passed.push({ ...t, ref, label, order: todo.indexOf(t) });
        break;
      }
    }
    if (failure) {
      console.log(`${t.lane}: 未合入（${failure}）`);
      // 门禁工具自身故障不记为 lane 失败（否则"失败后无新提交即跳过"会把无辜的 lane 白白跳过 3 小时）
      if (!/gate-runner: /.test(failure)) fails[t.lane] = { tip: t.tip, at: now() };
    } else {
      delete fails[t.lane];
    }
  }
}
await Promise.all(Array.from({ length: Math.min(JOBS, todo.length) }, (_, k) => worker(k)));
passed.sort((a, b) => a.order - b.order);
writeFileAtomic(FAILS_FILE, JSON.stringify(fails, null, 1));

// ---- 第 2 步：按顺序合入集成工作树，整体快速复核后快进 main ----
phase('合入');
const INT = path.join(WT_ROOT, '_integration');
ensureWorktree(INT, 'main');
const report = (t) => console.log(`${t.lane}: 已合入${t.ref === t.tip ? '' : t.pinned ? `（指定提交 ${t.ref.slice(0, 9)}）` : `（回退到非 WIP 提交 ${t.ref.slice(0, 9)}）`} ${t.ahead} 个提交`);
/** 快进 main：先确认租约仍属于自己；main 被别处改动导致无法快进时记为未合入而不是整轮崩溃。 */
const ffMain = (lanes) => {
  renew('快进 main 前');
  try {
    git(ROOT, 'merge', '--ff-only', git(INT, 'rev-parse', 'HEAD'));
    renew('快进 main 后');
    return true;
  } catch (e) {
    for (const t of lanes) console.log(`${t.lane}: 未合入（main 快进失败，下一轮重试：${String(e.stderr || e.message).split('\n')[0]}）`);
    return false;
  }
};
if (passed.length) {
  const mainNow = git(ROOT, 'rev-parse', 'main');
  git(INT, 'reset', '--hard', mainNow);
  const merged = [];
  for (const t of passed) {
    const c = mergeInto(INT, t.lane, t.ref, t.label);
    if (c) console.log(`${t.lane}: 未合入（与本轮其他 lane 的改动冲突，下一轮重试：${c}）`);
    else merged.push(t);
  }
  if (merged.length) {
    phase('复核');
    const failed = merged.length > 1 || mainNow !== base ? await runGate(INT, gateChecks(INT, mainNow, { quick: true, tests: true }), { tag: '整体复核', phase: '复核', lanes: merged.map((t) => `${t.lane}@${t.ref}`), base: mainNow }) : [];
    if (!failed.length) {
      if (ffMain(merged)) merged.forEach(report);
    } else {
      // 整体复核失败：退回逐条合入，每合一条做一次快速复核，只保留能共存的 lane。
      console.log(`整体复核未过（${failed.join(' | ').slice(0, 300)}），改为逐条合入`);
      phase('逐条合入');
      for (const t of merged) {
        const head = git(ROOT, 'rev-parse', 'main');
        git(INT, 'reset', '--hard', head);
        const c = mergeInto(INT, t.lane, t.ref, t.label);
        const f = c ? [c] : await runGate(INT, gateChecks(INT, head, { quick: true, tests: true }), { tag: `逐条-${t.lane}`, phase: '逐条合入', lane: t.lane, candidate: t.ref, tip: t.tip, base: head });
        renew(`${t.lane} 逐条复核结束`);
        if (f.length) {
          console.log(`${t.lane}: 未合入（门禁未过：与本轮已合入的其他 lane 共存时失败：\n    ${f.join('\n    ')}）`);
          continue;
        }
        if (ffMain([t])) report(t);
      }
    }
  }
}
console.log(`并行集成完成：候选 ${todo.length}，门禁通过 ${passed.length}，并行度 ${JOBS}`);
