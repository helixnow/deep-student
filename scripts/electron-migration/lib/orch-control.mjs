// 编排执行器（S0 G3）：把"协调者发一条消息请人处理"换成能直接改变系统状态的动作。
// - 释放集成锁：release-lock [--force]（只收回锁，从不结束持有者进程）
// - 指定批次集成：integrate --lanes a,b[@sha] --jobs n（锁空闲立即启动，否则排队；集成器空闲时先取队首批次）
// - 暂停 / 恢复派发：pause-dispatch / resume-dispatch（守护进程不再启动、续派、恢复执行者；在跑的 lane 不受影响）
// 每个动作在 incidents.jsonl 追加一行 kind=command 的审计记录（board/COMMAND.md 归 C0 独占，不写）。
import fs from 'node:fs';
import path from 'node:path';
import * as lease from './integrate-lease.mjs';

export const MAX_JOBS = 2; // 用户红线：不把 --jobs 调回 4
const iso = (ms) => new Date(ms).toISOString();
const readJson = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};
export const pauseFile = (runs) => path.join(runs, 'dispatch.paused.json');
const resumeFile = (runs) => path.join(runs, 'dispatch.resumed.json');
export const queueDir = (runs) => path.join(runs, 'integrate.queue');

export function audit(runs, rec, nowMs = Date.now()) {
  lease.appendIncident(runs, { kind: 'command', ...rec }, nowMs);
}

/**
 * 释放集成锁。可收回状态（dead / invalid / expired-idle / expired-overdue）直接收回；
 * 持有中或过期但忙的，只有 --force 才收回。deny 作用域照常转存 holds。
 */
export function releaseLock(runs, { force = false, reason = '', by = '?', probe, nowMs = Date.now() } = {}) {
  const a = lease.assess(runs, { probe, nowMs });
  let result;
  if (a.state === 'free') result = { ok: true, released: false, state: 'free' };
  else if (!force && (a.state === 'held' || a.state === 'expired-busy')) result = { ok: false, released: false, state: a.state, holder: a.lock };
  else {
    const released = lease.reap(runs, a.lock, `${force ? 'force' : a.state}（${by}：${reason || '未写原因'}）`, { nowMs, facts: { children: a.children, mainUpdatedAt: a.mainUpdatedAt } });
    result = { ok: released, released, state: a.state, holder: a.lock };
  }
  audit(runs, { cmd: 'release-lock', by, force, reason, state: result.state, released: result.released, holder: a.lock ? { pid: a.lock.pid, owner: a.lock.owner } : null }, nowMs);
  return result;
}

/** "a,b@sha,c" → [{ lane, pin? }] */
export function parseLanes(spec) {
  return String(spec ?? '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const [lane, pin] = x.split('@');
    return pin ? { lane, pin } : { lane };
  });
}
export const lanesSpec = (lanes) => lanes.map((l) => (l.pin ? `${l.lane}@${l.pin}` : l.lane)).join(',');
export const clampJobs = (j) => Math.min(MAX_JOBS, Math.max(1, Number(j) || MAX_JOBS));

export function enqueueIntegrate(runs, { lanes, jobs, by = '?', reason = '', nowMs = Date.now() }) {
  fs.mkdirSync(queueDir(runs), { recursive: true });
  const id = `IQ-${iso(nowMs).replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
  const entry = { id, lanes, jobs: clampJobs(jobs), by, reason, at: iso(nowMs) };
  const f = path.join(queueDir(runs), `${id}.json`);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(entry, null, 1));
  fs.renameSync(`${f}.tmp`, f);
  audit(runs, { cmd: 'integrate-enqueue', by, reason, id, lanes: lanesSpec(lanes), jobs: entry.jobs }, nowMs);
  return entry;
}

export function listQueue(runs) {
  try {
    return fs.readdirSync(queueDir(runs)).filter((f) => /^IQ-.*\.json$/.test(f)).sort().map((f) => ({ file: path.join(queueDir(runs), f), ...readJson(path.join(queueDir(runs), f), {}) }));
  } catch {
    return [];
  }
}

/**
 * 集成器（持锁时）取队首批次：
 * - 先把"执行中但执行进程已不在"的批次放回队列（集成器中途退出不丢批次）；
 * - 批次里没有任何 lane 还有待合内容（pending(lane, pin) 为 false）→ 记为 skipped，取下一条；
 * - 取到的批次改名为 .running.<pid>，完成后由 finishQueued 归档为 .done。
 */
export function takeQueued(runs, { pid = process.pid, alive, pending = () => true, nowMs = Date.now() } = {}) {
  const dir = queueDir(runs);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const n of names) {
    const m = /^(IQ-.*\.json)\.running\.(\d+)$/.exec(n);
    if (m && !alive(Number(m[2]))) requeue(runs, path.join(dir, n), `执行进程 ${m[2]} 已不在`, nowMs);
  }
  for (const e of listQueue(runs)) {
    if (!e.lanes?.some((l) => pending(l.lane, l.pin))) {
      fs.renameSync(e.file, `${e.file}.done`);
      audit(runs, { cmd: 'integrate-skip', id: e.id, lanes: lanesSpec(e.lanes ?? []), why: '批次内 lane 均无待合内容' }, nowMs);
      continue;
    }
    const running = `${e.file}.running.${pid}`;
    fs.renameSync(e.file, running);
    return { ...e, file: running };
  }
  return null;
}

/** 执行中的批次异常结束：放回队列重试一次；第二次仍异常则归档为 abandoned（避免同一批次无限重放）。 */
export function requeue(runs, runningFile, why, nowMs = Date.now()) {
  const base = runningFile.replace(/\.running\.\d+$/, '');
  const e = readJson(runningFile, {});
  const attempts = (e.attempts ?? 0) + 1;
  if (attempts > 1) {
    fs.renameSync(runningFile, `${base}.done`);
    audit(runs, { cmd: 'integrate-abandon', id: e.id, why, attempts }, nowMs);
    return false;
  }
  fs.writeFileSync(runningFile, JSON.stringify({ ...e, attempts }, null, 1));
  fs.renameSync(runningFile, base);
  audit(runs, { cmd: 'integrate-requeue', id: e.id, why, attempts }, nowMs);
  return true;
}

export function finishQueued(runs, entry, { result = 'done', nowMs = Date.now() } = {}) {
  if (!entry?.file) return;
  const base = entry.file.replace(/\.running\.\d+$/, '');
  try {
    fs.renameSync(entry.file, `${base}.done`);
  } catch {
    // 已被归档
  }
  audit(runs, { cmd: 'integrate-done', id: entry.id, result }, nowMs);
}

export function dispatchPaused(runs) {
  return readJson(pauseFile(runs), null);
}
export function pauseDispatch(runs, { by = '?', reason = '', auto = false, nowMs = Date.now() } = {}) {
  const cur = dispatchPaused(runs);
  if (cur) return { ok: true, already: true, state: cur };
  const state = { by, reason, auto, at: iso(nowMs) };
  fs.writeFileSync(`${pauseFile(runs)}.tmp`, JSON.stringify(state, null, 1));
  fs.renameSync(`${pauseFile(runs)}.tmp`, pauseFile(runs));
  audit(runs, { cmd: 'pause-dispatch', by, reason, auto }, nowMs);
  return { ok: true, already: false, state };
}
export function resumeDispatch(runs, { by = '?', reason = '', auto = false, nowMs = Date.now() } = {}) {
  const cur = dispatchPaused(runs);
  if (!cur) return { ok: true, already: true };
  fs.rmSync(pauseFile(runs), { force: true });
  fs.writeFileSync(resumeFile(runs), JSON.stringify({ by, reason, auto, at: iso(nowMs) }));
  audit(runs, { cmd: 'resume-dispatch', by, reason, auto, pausedBy: cur.by, pausedAt: cur.at }, nowMs);
  return { ok: true, already: false, was: cur };
}
/** 最近一次恢复派发（压力阀据此给人工恢复留宽限）。 */
export function lastResume(runs) {
  return readJson(resumeFile(runs), null);
}
