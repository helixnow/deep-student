// 修复动作库：协调者、守护进程与 root 巡检共用的「检测 → 计划 → 执行」动作，处理管线自身的故障。
// 约定：
// - 幂等：执行后再检测应为空；重复执行不产生新的副作用。
// - 不删除：坏文件、旧状态一律移入 .oc-runs/repair/quarantine/<时间>/ 或归档，不 rm。
// - 可审计：每次 plan/apply 追加 .oc-runs/repairs.jsonl（动作、发起者、发现数、样本、结果）。
// - 分级：auto（巡检可直接执行）/ confirm（只出计划，需 --approve，由人或 C2 执行）/ report（只报告，附人工命令）。
// - 只以 dsdev 身份运行：这里读写的全是 dsdev 可写的状态，root 运行会跟随其中的链接、把文件变成 root 属主。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { holdReason, defaultOpsDir } from './ops-intent.mjs';
import { writeFileAtomic } from './atomic-write.mjs';

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const stamp = (ms = Date.now()) => iso(ms).replace(/[:.]/g, '');

export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** pid 是否仍是指定脚本（防 PID 复用：机器重启或长时间运行后旧 pid 可能指向无关进程）。非 Linux 无法核对时按存活判断。 */
export function pidRunsScript(pid, suffix, { platform = process.platform, readCmdline = (p) => fs.readFileSync(`/proc/${p}/cmdline`) } = {}) {
  if (!pidAlive(pid)) return false;
  if (platform !== 'linux') return true;
  try {
    return readCmdline(pid).toString().split('\0').some((a) => a.endsWith(suffix));
  } catch {
    return false;
  }
}

export function appendRepair(runs, rec, nowMs = Date.now()) {
  fs.mkdirSync(runs, { recursive: true });
  fs.appendFileSync(path.join(runs, 'repairs.jsonl'), `${JSON.stringify({ t: iso(nowMs), ...rec })}\n`);
}

function readRepairs(runs) {
  try {
    return fs.readFileSync(path.join(runs, 'repairs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function quarantine(runs, file, nowMs) {
  const dir = path.join(runs, 'repair', 'quarantine', stamp(nowMs));
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.relative(runs, file).replace(/[\\/]/g, '__'));
  fs.renameSync(file, dest);
  return dest;
}

const writeAtomic = writeFileAtomic;

// ---------------------------------------------------------------------------
// git-ownership：.git 与 lane 工作树里不归仓库属主的文件。
// 根因（2026-11-07）：维护会话以 root 身份在仓库里跑 git，一次改写了 packed-refs 与 113 个工作树的 logs/HEAD，
// 之后 dsdev 下的 lane 提交失败（X7 报 logs/HEAD 权限），协调者都是 dsdev，无权修复。
// 只检测与告警：改属主需要 root，而 root 不能在 dsdev 可写的目录树里常驻执行动作（链接、竞态）。
// 修复是人工一次性命令（manualFix），根因是"有人以 root 跑了 git"，应当在源头杜绝。
// ---------------------------------------------------------------------------
export function scanOwnership({ root, worktreesRoot = null, uid, limit = 5000, refused = [] }) {
  const out = [];
  const visit = (p, depth, maxDepth, skip) => {
    if (out.length >= limit) return;
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    if (depth === 0 && st.isSymbolicLink()) {
      refused.push(p);
      return;
    }
    if (st.uid !== uid) out.push({ path: p, uid: st.uid });
    if (!st.isDirectory() || depth >= maxDepth || skip(p)) return;
    let names = [];
    try {
      names = fs.readdirSync(p);
    } catch {
      return;
    }
    for (const n of names) visit(path.join(p, n), depth + 1, maxDepth, skip);
  };
  const gitDir = path.join(root, '.git');
  // objects/xx 目录本身要查（root 建的目录会让 dsdev 写不进以 xx 开头的新对象），里面的只读对象文件不逐个查。
  const looseObjectDir = (p) => /[\\/]objects[\\/][0-9a-f]{2}$/.test(p);
  visit(gitDir, 0, 12, looseObjectDir);
  if (worktreesRoot) {
    let st = null;
    try {
      st = fs.lstatSync(worktreesRoot);
    } catch {
      st = null;
    }
    if (st?.isSymbolicLink()) refused.push(worktreesRoot);
    else if (st?.isDirectory()) {
      for (const l of fs.readdirSync(worktreesRoot)) visit(path.join(worktreesRoot, l), 0, 2, (p) => path.basename(p) === 'node_modules');
    }
  }
  return out;
}

export function manualOwnershipFix({ root, worktreesRoot, owner = 'dsdev' }) {
  const tops = [path.join(root, '.git'), worktreesRoot].filter(Boolean).join(' ');
  return `先停服务并确认 pgrep -u ${owner} 无输出；sudo find ${tops} -xdev -user root -print 核对清单；再执行 sudo chown -R -P --from=root ${owner}:${owner} ${tops}`;
}

function gitOwnership(ctx) {
  const uid = ctx.uid ?? fs.statSync(ctx.root).uid;
  return {
    name: 'git-ownership',
    policy: 'report',
    detect() {
      const refused = [];
      const files = scanOwnership({ root: ctx.root, worktreesRoot: ctx.worktreesRoot, uid, refused });
      const out = files.length ? [{ kind: 'foreign-owner', count: files.length, owners: [...new Set(files.map((f) => f.uid))], sample: files.slice(0, 8).map((f) => path.relative(path.dirname(ctx.root), f.path)), files }] : [];
      if (refused.length) out.push({ kind: 'symlinked-top', refused, note: '扫描顶层是符号链接，已拒绝遍历；需要人查明是谁替换的' });
      return out;
    },
    plan(findings) {
      return findings.filter((f) => f.kind === 'foreign-owner').map((f) => ({ op: 'manual-chown', count: f.count, cmd: manualOwnershipFix(ctx), note: '人工一次性执行（先去掉 chown 段核对清单）；巡检与 repair 都不改属主' }));
    },
    apply(findings) {
      return { ok: false, manual: manualOwnershipFix(ctx), note: '改属主需要 root，不自动执行；见 plan 中的人工命令' };
    },
  };
}

// ---------------------------------------------------------------------------
// state-json：调度状态文件损坏。读方大多是 try/catch 回落默认值——损坏不会报错，而是悄悄改变行为
// （dispatch.paused.json 坏了 = 派发被恢复；integrate.holds.json 坏了 = deny 保护消失）。
// ---------------------------------------------------------------------------
export const STATE_FILES = [
  { file: 'stalls.state.json', policy: 'auto', reset: { open: {}, pendingDigest: {}, lastDigestAt: {} } },
  { file: 'stalls.current.json', policy: 'auto', reset: { lanes: {} } },
  { file: 'pipeline-alerts.json', policy: 'auto', reset: {} },
  { file: 'gate-fail.json', policy: 'auto', reset: {} },
  { file: 'integrate.deferred.json', policy: 'auto', reset: {} },
  { file: 'integrate.lease-state.json', policy: 'auto', reset: {} },
  // 下列文件的默认值会改变调度语义，只出计划
  { file: 'integrate.heartbeat.json', policy: 'confirm', reset: {}, why: '集成熔断的失败历史；重置 = 熔断被关闭' },
  { file: 'feedback-state.json', policy: 'confirm', reset: null, why: '重置会把全部历史质量问题重新发给 lane' },
  { file: 'integrate.holds.json', policy: 'confirm', reset: null, why: '读方回落为空 = 现有 deny 保护全部失效' },
  { file: 'dispatch.paused.json', policy: 'confirm', reset: { by: 'repair', reason: '原暂停文件损坏，按暂停处理', auto: true }, why: '读方回落为 null = 派发被悄悄恢复' },
  { file: 'sessions.json', policy: 'confirm', backups: /^sessions\.json\.bak/, why: '守护进程唯一状态；从最新可解析备份恢复' },
];

function parses(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.trim()) return false;
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function stateJson(ctx) {
  const staleTmpMs = 10 * 60_000;
  // 写者若不是原子写，读到的可能是写了一半的文件：隔一段时间再读一次，两次都坏才算损坏。
  const recheck = ctx.recheck ?? (() => sleepSync(ctx.recheckMs ?? 1500));
  const corrupt = (f) => {
    if (!fs.existsSync(f) || parses(f)) return false;
    recheck(f);
    return fs.existsSync(f) && !parses(f);
  };
  return {
    name: 'state-json',
    policy: 'auto',
    detect() {
      const found = [];
      for (const spec of STATE_FILES) {
        const f = path.join(ctx.runs, spec.file);
        if (corrupt(f)) found.push({ kind: 'corrupt', file: spec.file, policy: spec.policy, why: spec.why });
        for (const suffix of ['.tmp', '.repair-tmp']) {
          const t = `${f}${suffix}`;
          try {
            if (ctx.now - fs.statSync(t).mtimeMs > staleTmpMs) found.push({ kind: 'stale-tmp', file: `${spec.file}${suffix}`, policy: 'auto' });
          } catch {
            // 没有残留临时文件
          }
        }
      }
      return found;
    },
    plan(findings) {
      return findings.map((x) => {
        const spec = STATE_FILES.find((s) => x.file.startsWith(s.file));
        if (x.kind === 'stale-tmp') return { op: 'quarantine', file: x.file, policy: 'auto' };
        if (spec.backups) return { op: 'restore-from-backup', file: x.file, policy: spec.policy, why: spec.why };
        if (spec.reset) return { op: 'quarantine+reset', file: x.file, reset: spec.reset, policy: spec.policy, why: spec.why };
        return { op: 'quarantine-only', file: x.file, policy: spec.policy, why: spec.why };
      });
    },
    apply(findings, { approve }) {
      const done = [];
      for (const step of this.plan(findings)) {
        if (step.policy === 'confirm' && !approve) {
          done.push({ ...step, skipped: '需要 --approve' });
          continue;
        }
        const f = path.join(ctx.runs, step.file);
        if (!fs.existsSync(f)) continue;
        if (step.op === 'restore-from-backup') {
          const base = path.basename(f);
          const spec = STATE_FILES.find((s) => s.file === base);
          const candidates = fs.readdirSync(path.dirname(f)).filter((n) => spec.backups.test(n))
            .map((n) => ({ n, t: fs.statSync(path.join(path.dirname(f), n)).mtimeMs })).sort((a, b) => b.t - a.t)
            .map(({ n }) => path.join(path.dirname(f), n)).filter(parses);
          if (!candidates.length) {
            done.push({ ...step, error: '没有可解析的备份' });
            continue;
          }
          const moved = quarantine(ctx.runs, f, ctx.now);
          fs.copyFileSync(candidates[0], f);
          done.push({ ...step, quarantined: moved, restoredFrom: path.basename(candidates[0]) });
          continue;
        }
        const moved = quarantine(ctx.runs, f, ctx.now);
        if (step.op === 'quarantine+reset') writeAtomic(f, JSON.stringify({ ...step.reset, ...(step.file === 'dispatch.paused.json' ? { at: iso(ctx.now) } : {}) }));
        done.push({ ...step, quarantined: moved });
      }
      return { ok: done.every((d) => !d.error), steps: done };
    },
  };
}

// ---------------------------------------------------------------------------
// sessions-compact：sessions.json 是守护进程每轮全量读写的文件，实测涨到 7.6MB（sentQueue 历史占绝大部分），
// 还留了 5 份 7MB 备份。只保留每 lane 最近的已送达消息，其余归档到 archive/，不丢历史。
// 前提：守护进程未运行（它是唯一写者）。
// ---------------------------------------------------------------------------
/**
 * 调度守护进程是否在运行。systemd 下跑的是 `oc-dispatch.mjs watch`，不写 watch.pid（只有 daemon 子命令写），
 * 所以以 fastTick 每轮写的 scheduler-heartbeat.json {pid, at} 为准：pid 仍是 oc-dispatch，或心跳在 10 分钟内，都算在运行。
 * 心跳文件存在但读不懂（写了一半、空、字段不对）一律按"在运行"：误判为停止会放行只能在停止时做的动作。
 */
export function dispatcherRunning(ctx) {
  const freshMs = ctx.heartbeatFreshMs ?? 10 * 60_000;
  let text = null;
  try {
    text = fs.readFileSync(path.join(ctx.runs, 'scheduler-heartbeat.json'), 'utf8');
  } catch {
    text = null; // 没有心跳：再看 daemon 模式的 watch.pid
  }
  if (text !== null) {
    let hb;
    try {
      hb = JSON.parse(text);
    } catch {
      return true;
    }
    const at = Date.parse(hb?.at ?? '');
    if (!hb || typeof hb !== 'object' || !Number.isFinite(at)) return true;
    if (pidRunsScript(Number(hb.pid), 'oc-dispatch.mjs', ctx.procOpts)) return true;
    if (ctx.now - at < freshMs) return true;
  }
  try {
    return pidRunsScript(Number(fs.readFileSync(path.join(ctx.runs, 'watch.pid'), 'utf8')), 'oc-dispatch.mjs', ctx.procOpts);
  } catch {
    return false;
  }
}

function sessionsCompact(ctx) {
  const file = path.join(ctx.runs, 'sessions.json');
  const maxBytes = ctx.sessionsMaxBytes ?? 2 * 1024 * 1024;
  const keep = { sentQueue: 50, archivedQueue: 20 };
  const daemonRunning = () => dispatcherRunning(ctx);
  return {
    name: 'sessions-compact',
    policy: 'auto',
    detect() {
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {
        return [];
      }
      if (size <= maxBytes || !parses(file)) return [];
      const ss = JSON.parse(fs.readFileSync(file, 'utf8'));
      let excess = 0;
      for (const [k, v] of Object.entries(ss)) {
        if (k.startsWith('__') || !v) continue;
        for (const [field, n] of Object.entries(keep)) excess += Math.max(0, (v[field]?.length ?? 0) - n);
      }
      return excess ? [{ kind: 'oversized', bytes: size, excessEntries: excess }] : [];
    },
    plan(findings) {
      return findings.map((f) => ({ op: 'archive-history', bytes: f.bytes, entries: f.excessEntries, keep, precondition: '守护进程未运行' }));
    },
    apply(findings) {
      if (!findings.length) return { ok: true, noop: true };
      if (daemonRunning()) return { ok: false, blocked: '守护进程在运行（sessions.json 唯一写者），停止 ds-migration 后再执行' };
      const ss = JSON.parse(fs.readFileSync(file, 'utf8'));
      const archiveDir = path.join(ctx.runs, 'archive');
      fs.mkdirSync(archiveDir, { recursive: true });
      const archive = path.join(archiveDir, `sessions-history-${stamp(ctx.now)}.jsonl`);
      const lines = [];
      for (const [lane, v] of Object.entries(ss)) {
        if (lane.startsWith('__') || !v) continue;
        for (const [field, n] of Object.entries(keep)) {
          const arr = v[field] ?? [];
          if (arr.length <= n) continue;
          for (const entry of arr.slice(0, arr.length - n)) lines.push(JSON.stringify({ lane, field, entry }));
          v[field] = arr.slice(-n);
        }
      }
      fs.writeFileSync(archive, `${lines.join('\n')}\n`);
      const before = fs.statSync(file).size;
      const keepDir = path.join(ctx.runs, 'repair', 'quarantine', stamp(ctx.now));
      fs.mkdirSync(keepDir, { recursive: true });
      fs.copyFileSync(file, path.join(keepDir, 'sessions.json.before-compact'));
      writeAtomic(file, `${JSON.stringify(ss, null, 2)}\n`);
      return { ok: true, archived: lines.length, archive, bytesBefore: before, bytesAfter: fs.statSync(file).size };
    },
  };
}

// ---------------------------------------------------------------------------
// stale-locks：持有者已退出或 pid 已被复用的 pid 锁文件。fulltest 的 running.lock 曾在 pid 复用后让定时全测一直"跳过"。
// 集成锁不在这里：它有租约语义，由 integrate-lease.sweep 处理。
// ---------------------------------------------------------------------------
export const PID_LOCKS = [
  { file: 'fulltest/running.lock', script: 'fulltest.mjs' },
  { file: 'watch.pid', script: 'oc-dispatch.mjs' },
];
function staleLocks(ctx) {
  return {
    name: 'stale-locks',
    policy: 'auto',
    detect() {
      const out = [];
      for (const l of PID_LOCKS) {
        const f = path.join(ctx.runs, l.file);
        let pid;
        try {
          pid = Number(fs.readFileSync(f, 'utf8').trim());
        } catch {
          continue;
        }
        if (!pidRunsScript(pid, l.script, ctx.procOpts)) out.push({ kind: pidAlive(pid) ? 'pid-reused' : 'holder-dead', file: l.file, pid });
      }
      return out;
    },
    plan(findings) {
      return findings.map((f) => ({ op: 'quarantine', file: f.file, pid: f.pid }));
    },
    apply(findings) {
      const moved = [];
      for (const f of findings) {
        const p = path.join(ctx.runs, f.file);
        if (fs.existsSync(p)) moved.push(quarantine(ctx.runs, p, ctx.now));
      }
      return { ok: true, moved };
    },
  };
}

// ---------------------------------------------------------------------------
// fulltest-resume：全测控制进程死了，但 8 个分片作业已经提交（作业仍在队列里跑完）。用已保存的 job ID 收结果，
// 绝不重新提交测试、不改判已有的红。每个 run 只恢复一次（repairs.jsonl 记账）。
// ---------------------------------------------------------------------------
function fulltestResume(ctx) {
  const runsRoot = path.join(ctx.runs, 'fulltest', 'runs');
  const shards = ctx.fulltestShards ?? 8;
  const controllerAlive = () => {
    try {
      return pidRunsScript(Number(fs.readFileSync(path.join(ctx.runs, 'fulltest', 'running.lock'), 'utf8')), 'fulltest.mjs', ctx.procOpts);
    } catch {
      return false;
    }
  };
  return {
    name: 'fulltest-resume',
    policy: 'auto',
    detect() {
      let dirs = [];
      try {
        dirs = fs.readdirSync(runsRoot).filter((d) => /^[\wTZ-]+$/.test(d)).sort().reverse();
      } catch {
        return [];
      }
      const latest = dirs[0];
      if (!latest || controllerAlive()) return [];
      const held = holdReason({ runs: ctx.runs, opsDir: ctx.opsDir, unit: 'ds-fulltest' });
      if (held) return [{ kind: 'held', runId: latest, note: `有意停住，不恢复：${held}` }];
      const dir = path.join(runsRoot, latest);
      const submitted = fs.readdirSync(dir).filter((n) => /^shard-\d+\.submitted\.json$/.test(n)).length;
      let complete = false;
      try {
        complete = Boolean(JSON.parse(fs.readFileSync(path.join(dir, 'verdict.json'), 'utf8')).complete);
      } catch {
        complete = false;
      }
      if (complete || submitted !== shards || !fs.existsSync(path.join(dir, 'source.json'))) return [];
      if (readRepairs(ctx.runs).some((r) => r.action === 'fulltest-resume' && r.mode === 'apply' && r.result?.pid && r.result?.runId === latest)) return [{ kind: 'resume-exhausted', runId: latest, note: '已恢复过一次仍未完成，需要人判断' }];
      return [{ kind: 'orphaned-run', runId: latest, submitted }];
    },
    plan(findings) {
      return findings.filter((f) => f.kind === 'orphaned-run').map((f) => ({ op: 'resume', runId: f.runId, cmd: ['node', 'scripts/electron-migration/fulltest.mjs', '--resume', f.runId] }));
    },
    apply(findings) {
      const steps = this.plan(findings);
      if (!steps.length) return { ok: true, noop: true, note: findings.map((f) => f.note).filter(Boolean).join('；') || undefined };
      const { runId } = steps[0];
      const log = path.join(ctx.runs, 'fulltest', `resume-${runId}.log`);
      const spawnFn = ctx.spawn ?? ((cmd, args, opts) => spawn(cmd, args, opts));
      const out = fs.openSync(log, 'a');
      const child = spawnFn(process.execPath, [path.join(ctx.root, 'scripts/electron-migration/fulltest.mjs'), '--resume', runId], { cwd: ctx.root, detached: true, stdio: ['ignore', out, out] });
      child.unref?.();
      fs.closeSync(out);
      return { ok: true, runId, pid: child.pid, log };
    },
  };
}

const FACTORIES = { 'git-ownership': gitOwnership, 'state-json': stateJson, 'sessions-compact': sessionsCompact, 'stale-locks': staleLocks, 'fulltest-resume': fulltestResume };
export const ACTION_NAMES = Object.keys(FACTORIES);

export function makeContext({ root, runs = path.join(root, '.oc-runs'), worktreesRoot = path.resolve(root, '..', 'ds-mig'), opsDir = defaultOpsDir(root), by = '?', now = Date.now(), ...rest }) {
  return { root, runs, worktreesRoot, opsDir, by, now, ...rest };
}

function refuseRoot(ctx) {
  const uid = (ctx.getuid ?? process.getuid)?.();
  if (uid === 0) throw new Error('repair 不以 root 运行：请用 sudo -u dsdev（这里的状态全部 dsdev 可写，root 会跟随其中的链接并留下 root 属主文件）');
}

/** 只检测（只读）：返回每个动作的发现，不写审计。 */
export function check(ctx, names = ACTION_NAMES) {
  refuseRoot(ctx);
  return names.map((n) => {
    const a = FACTORIES[n](ctx);
    let findings = [];
    try {
      findings = a.detect();
    } catch (e) {
      findings = [{ kind: 'detect-error', error: String(e.message).split('\n')[0] }];
    }
    return { action: n, policy: a.policy, findings };
  });
}

/** 检测 + 计划（+ 执行）。confirm 级动作没有 approve 时只记计划。审计不含完整文件清单，只含计数与样本。 */
export function run(ctx, name, { apply = false, approve = false, reason = '' } = {}) {
  if (!FACTORIES[name]) throw new Error(`未知修复动作：${name}（可用：${ACTION_NAMES.join(', ')}）`);
  refuseRoot(ctx);
  const a = FACTORIES[name](ctx);
  const findings = a.detect();
  const plan = a.plan(findings);
  const slim = findings.map(({ files, ...f }) => f);
  let result = null;
  const gated = a.policy === 'confirm' && !approve;
  if (apply && findings.length && !gated) result = a.apply(findings, { approve });
  else if (apply && gated) result = { ok: false, skipped: '需要 --approve（confirm 级动作）' };
  const runId = findings.find((f) => f.runId)?.runId;
  appendRepair(ctx.runs, { action: name, mode: apply ? 'apply' : 'plan', by: ctx.by, reason, policy: a.policy, findings: slim, plan, result, ...(runId && apply ? { runId } : {}) }, ctx.now);
  return { action: name, policy: a.policy, findings: slim, plan, result };
}
