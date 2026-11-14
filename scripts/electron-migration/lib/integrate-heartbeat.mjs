// 集成心跳（S0 G1）：自动集成以 sh 包装启动，退出码写入 <log>.exit；守护进程据此判定本轮是否正常结束。
// 判定标准：日志里有"并行集成完成"（或"integrate 已在运行"的正常跳过）。否则按异常处理：
// - 记录退出码/信号与停在哪个阶段（日志里最后一个"[阶段] X"标记），写 incidents.jsonl；
// - 第一次：立即以减半并行度（至少 1）重试一次；
// - 与上一次失败停在同一阶段（连续两次）：熔断——写 escalations、incident，并给 C0-chief 投一条事实消息；
//   熔断期间不再自动发起集成，冷却 COOLDOWN 后自动半开再试一轮。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { appendIncident } from './integrate-lease.mjs';
import { writeFileAtomic } from './atomic-write.mjs';

export const COOLDOWN_MS = 60 * 60_000;
export const DONE_RE = /并行集成完成|integrate 已在运行/;
const SIGNALS = { 1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 6: 'SIGABRT', 9: 'SIGKILL', 11: 'SIGSEGV', 13: 'SIGPIPE', 15: 'SIGTERM' };
const iso = (ms) => new Date(ms).toISOString();
const stateFile = (runs) => path.join(runs, 'integrate.heartbeat.json');

export function loadState(runs) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(runs), 'utf8'));
  } catch {
    return {};
  }
}
export function saveState(runs, st) {
  fs.writeFileSync(`${stateFile(runs)}.tmp`, JSON.stringify(st, null, 1));
  fs.renameSync(`${stateFile(runs)}.tmp`, stateFile(runs));
}

/** 启动一轮集成（detached，独立进程组）。返回写入 integrate.current.json 的记录。 */
export function startRun({ runs, cwd, script, jobs, attempt = 0, extraArgs = [], nowMs = Date.now(), stamp }) {
  const log = path.join(runs, `integrate-auto-${(stamp ?? iso(nowMs)).replace(/[:.]/g, '')}.log`);
  const exitFile = `${log}.exit`;
  const fd = fs.openSync(log, 'w');
  const sh = '"$DS_NODE" "$@"; code=$?; printf "%s" "$code" > "$DS_EXIT_FILE"; exit $code';
  const child = spawn('/bin/sh', ['-c', sh, 'integrate', script, '--jobs', String(jobs), ...extraArgs], {
    cwd, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, DS_EXIT_FILE: exitFile, DS_NODE: process.execPath },
  });
  child.unref();
  fs.closeSync(fd);
  const cur = { pid: child.pid, log, exitFile, jobs, attempt, startedAt: iso(nowMs) };
  writeFileAtomic(path.join(runs, 'integrate.current.json'), JSON.stringify(cur));
  return cur;
}

/** 最后到达的阶段（日志中"[阶段] X"）；没有任何标记时为"启动"。 */
export function lastPhase(out) {
  const all = [...String(out).matchAll(/^\[阶段\] (\S+)/gm)];
  return all.length ? all[all.length - 1][1] : '启动';
}

/** 读取本轮结果。exit 文件缺失（包装进程本身被杀或旧版本启动）时 code=null、signal='unknown'。 */
export function readOutcome(cur, out) {
  let code = null;
  try {
    const t = fs.readFileSync(cur.exitFile ?? `${cur.log}.exit`, 'utf8').trim();
    if (/^\d+$/.test(t)) code = Number(t);
  } catch {
    code = null;
  }
  const signal = code == null ? 'unknown' : code > 128 ? (SIGNALS[code - 128] ?? `SIG${code - 128}`) : null;
  const ok = DONE_RE.test(out);
  const lastLine = String(out).split('\n').filter(Boolean).slice(-1)[0] ?? '（无输出）';
  return { ok, code, signal, location: ok ? null : lastPhase(out), lastLine };
}

/**
 * 纯决策：根据上一状态与本轮结果给出下一状态与动作。
 * 动作：none | retry（jobs）| trip（熔断）
 */
export function decide(st, outcome, cur, { nowMs = Date.now(), cooldownMs = COOLDOWN_MS } = {}) {
  if (outcome.ok) return { state: { ...st, lastFail: null, retry: null, breaker: null }, action: 'none' };
  const prev = st.lastFail;
  const fail = { location: outcome.location, code: outcome.code, signal: outcome.signal, jobs: cur.jobs, attempt: cur.attempt ?? 0, at: iso(nowMs), log: cur.log };
  if (prev && prev.location === outcome.location) {
    return {
      state: { ...st, lastFail: fail, retry: null, breaker: { openedAt: iso(nowMs), until: iso(nowMs + cooldownMs), location: outcome.location, fails: [prev, fail] } },
      action: 'trip',
    };
  }
  const jobs = Math.max(1, Math.floor((cur.jobs ?? 2) / 2));
  if ((cur.attempt ?? 0) === 0) return { state: { ...st, lastFail: fail, retry: { jobs, at: iso(nowMs) } }, action: 'retry', jobs };
  return { state: { ...st, lastFail: fail, retry: null }, action: 'none' };
}

/** 熔断是否打开（冷却结束自动半开，允许再试一轮）。 */
export function breakerOpen(st, nowMs = Date.now()) {
  return Boolean(st.breaker && Date.parse(st.breaker.until) > nowMs);
}

/**
 * 一轮结束后的完整处理：结果判定 → 状态 → incident / escalation / 通知。
 * notify(file) 由调用方提供（守护进程里经 coord queue 投给 C0-chief）。
 */
export function onRunEnd({ runs, cur, out, nowMs = Date.now(), notify = () => {} }) {
  const outcome = readOutcome(cur, out);
  const st = loadState(runs);
  const d = decide(st, outcome, cur, { nowMs });
  saveState(runs, d.state);
  if (outcome.ok) return { outcome, action: 'none' };
  appendIncident(runs, { kind: 'integrate-abnormal', location: outcome.location, code: outcome.code, signal: outcome.signal, jobs: cur.jobs, attempt: cur.attempt ?? 0, pid: cur.pid, log: cur.log, lastLine: outcome.lastLine.slice(0, 300), next: d.action === 'retry' ? `retry --jobs ${d.jobs}` : d.action }, nowMs);
  if (d.action === 'trip') {
    const b = d.state.breaker;
    const body = `【集成熔断】自动集成连续两次停在「${b.location}」阶段且未完成，已暂停自动集成至 ${b.until}（之后自动再试一轮）。
- 第 1 次：${b.fails[0].at} 退出码 ${b.fails[0].code ?? '未知'} 信号 ${b.fails[0].signal ?? '无'} 并行 ${b.fails[0].jobs} 日志 ${b.fails[0].log}
- 第 2 次：${b.fails[1].at} 退出码 ${b.fails[1].code ?? '未知'} 信号 ${b.fails[1].signal ?? '无'} 并行 ${b.fails[1].jobs} 日志 ${b.fails[1].log}
- 最后一行：${outcome.lastLine.slice(0, 300)}
结构化记录：.oc-runs/incidents.jsonl（kind=integrate-breaker）。手动解除：删除 .oc-runs/integrate.heartbeat.json 中的 breaker 字段。
`;
    appendIncident(runs, { kind: 'integrate-breaker', location: b.location, until: b.until, fails: b.fails }, nowMs);
    fs.mkdirSync(path.join(runs, 'escalations'), { recursive: true });
    const file = path.join(runs, 'escalations', `${iso(nowMs).replace(/[:.]/g, '')}-integrate-breaker.md`);
    fs.writeFileSync(file, body);
    try {
      notify(file, body);
    } catch (e) {
      appendIncident(runs, { kind: 'notify-failed', target: 'C0-chief', error: String(e.message).split('\n')[0] }, nowMs);
    }
  }
  return { outcome, action: d.action, jobs: d.jobs, breaker: d.state.breaker };
}
