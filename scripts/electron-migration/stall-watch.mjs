#!/usr/bin/env node
// 卡住检测（用户要求 2026-11-04）：lane 在跑，但 90 秒内没有任何新事件（模型无返回），且其工作树下没有正在执行的
// 工具进程（测试/构建/作业等待等），即视为"卡住"。默认只记录并报告；--auto-restart-min N 时，执行者连续卡住 N 分钟
// 在原会话重启一次（策略与上限见 lib/stall-policy.mjs）。
//
//   node scripts/electron-migration/stall-watch.mjs [--threshold-sec 90] [--interval-sec 15] [--digest-min 5] [--auto-restart-min 0]
//
// 输出：
//   .oc-runs/stalls.jsonl          每段卡住的开始（start）与恢复（end，含持续秒数）
//   .oc-runs/stalls.current.json   当前正在卡住的 lane（面板 / coord.mjs health 读取）
//   协调者信箱                     每个协调者每 digest-min 分钟最多一条汇总（普通优先级，不打断）；
//                                  协调者自身卡住则上报架构师（.oc-runs/escalations）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as stallPolicy from './lib/stall-policy.mjs';
import { dispatchPaused } from './lib/orch-control.mjs';
import { defaultOpsDir } from './lib/ops-intent.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNS = path.join(ROOT, '.oc-runs');
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const THRESHOLD_MS = Number(opt('threshold-sec', '90')) * 1000;
const INTERVAL_MS = Number(opt('interval-sec', '15')) * 1000;
const DIGEST_MS = Number(opt('digest-min', '5')) * 60_000;
const AUTO_RESTART_MS = Number(opt('auto-restart-min', '0')) * 60_000;
const STATE = path.join(RUNS, 'stalls.state.json');
const LOG = path.join(RUNS, 'stalls.jsonl');
const CURRENT = path.join(RUNS, 'stalls.current.json');
const COORDS = ['C1-app', 'C2-platform'];

const readJson = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};
const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const realpath = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};
const iso = (ms) => new Date(ms).toISOString();
const sec = (ms) => Math.round(ms / 1000);

// 状态：{ open: { lane: { since, lastEvent, reportedAt? } }, pendingDigest: { coord: [条目] }, lastDigestAt: { coord: ms } }
const state = readJson(STATE, { open: {}, pendingDigest: {}, lastDigestAt: {} });
const saveState = () => {
  fs.writeFileSync(`${STATE}.tmp`, JSON.stringify(state));
  fs.renameSync(`${STATE}.tmp`, STATE);
};
const appendLog = (rec) => fs.appendFileSync(LOG, `${JSON.stringify(rec)}\n`);

/** 扫描一次 /proc（本用户进程）：工作树 → 正在其中执行的工具进程数，以及无法归属到 lane 的工具进程数。 */
function busyWorktrees(worktrees) {
  const uid = process.getuid();
  const procs = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      if (fs.statSync(`/proc/${d}`).uid !== uid) continue;
      const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8').split(') ').pop().split(' ');
      let oldpwd;
      try {
        oldpwd = fs.readFileSync(`/proc/${d}/environ`, 'utf8').split('\0').find((e) => e.startsWith('OLDPWD='))?.slice(7);
      } catch {
        oldpwd = undefined;
      }
      procs.push({ pid: Number(d), ppid: Number(stat[1]), start: stat[19], cwd: fs.readlinkSync(`/proc/${d}/cwd`), oldpwd, cmd: fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() });
    } catch {
      // 进程已退出或无权限
    }
  }
  return stallPolicy.attributeBusy({ procs, worktrees });
}

/** 最后一个事件：时间取日志文件修改时间，类型取末行。 */
function lastEvent(lane) {
  const f = path.join(RUNS, `${lane}.jsonl`);
  let st;
  try {
    st = fs.statSync(f);
  } catch {
    return null;
  }
  let type = '';
  try {
    const fd = fs.openSync(f, 'r');
    const n = Math.min(st.size, 64 * 1024);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, st.size - n);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    type = last.type === 'tool_use' ? `tool_use:${last.part?.tool ?? ''}` : last.type;
  } catch {
    type = '?';
  }
  return { at: st.mtimeMs, type };
}

function coordinatorOf(lane, sessions) {
  for (const c of COORDS) if ((sessions[c]?.lanes ?? []).includes(lane)) return c;
  return 'C2-platform'; // 未分配的 lane（如新开的 X6/X7）归平台协调者
}

function sendDigest(coord, items, now) {
  const lines = items.map((i) => (i.kind === 'start'
    ? `- ${i.lane}：自 ${i.since.slice(11, 19)}Z 起卡住（已 ${i.forSec} 秒无模型返回；最后事件 ${i.lastEvent}）${i.stillOpen ? '，**仍未恢复**' : ''}`
    : `- ${i.lane}：已恢复，共卡住 ${i.durationSec} 秒`));
  const body = `【卡住检测汇总（自动，${iso(now).slice(11, 19)}Z）】判定：lane 在跑、${sec(THRESHOLD_MS)} 秒内无任何新事件且无工具进程在执行。
系统不会终止这些 lane，仍在等待恢复；请你判断是否需要处理（例如长时间不恢复时用 coord.mjs restart，或查看 coord.mjs report）。

${lines.join('\n')}

明细：.oc-runs/stalls.jsonl；当前卡住：.oc-runs/stalls.current.json`;
  if (COORDS.includes(coord) && coord !== '__architect') {
    fs.mkdirSync(path.join(RUNS, 'inbox'), { recursive: true });
    const file = path.join(RUNS, 'inbox', `${now}-stall-watch-${coord}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ lane: coord, message: body, from: 'stall-watch', action: 'queue', expiresAt: iso(now + 60 * 60_000) }));
    fs.renameSync(`${file}.tmp`, file);
  }
}

function escalate(body, now) {
  fs.mkdirSync(path.join(RUNS, 'escalations'), { recursive: true });
  fs.writeFileSync(path.join(RUNS, 'escalations', `${iso(now).replace(/[:.]/g, '')}-stall-watch.md`), body);
}

function inbox(item, now) {
  fs.mkdirSync(path.join(RUNS, 'inbox'), { recursive: true });
  const file = path.join(RUNS, 'inbox', `${now}-stall-watch-${item.lane}-${item.action}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...item, from: 'stall-watch' }));
  fs.renameSync(`${file}.tmp`, file);
}

/** 卡住达到阈值后的动作：在原会话重启（经守护进程信箱，与 coord.mjs restart 同路径），超过上限只通知协调者一次。 */
function act(lane, s, open, now, sessions, env) {
  state.autoRestarts ??= {};
  const d = stallPolicy.decide({
    forMs: now - open.since, autoRestartMs: AUTO_RESTART_MS, nowMs: now,
    restartedThisEpisode: Boolean(open.autoRestartedAt), escalatedThisEpisode: Boolean(open.escalatedAt),
    recentRestarts: state.autoRestarts[lane] ?? [], coordinator: Boolean(s.coordinator) || COORDS.includes(lane) || /^(C\d|S0)-/.test(lane),
    parked: Boolean(s.parked), dispatchPaused: Boolean(dispatchPaused(RUNS)), ...env,
  });
  if (d.action === 'none' && open.deferredWhy !== d.why && /有意停住|未运行|无法归属/.test(d.why)) {
    open.deferredWhy = d.why;
    appendLog({ t: iso(now), lane, kind: 'auto-restart-deferred', why: d.why });
  }
  if (d.action === 'restart') {
    inbox({ ...stallPolicy.restartItem({ lane }, now), message: `【卡住自动处理】你已 ${Math.round((now - open.since) / 60_000)} 分钟没有模型返回、也没有工具进程在跑，stall-watch 已请守护进程结束本轮并在原会话恢复。先 git status / git log -3 确认现场，再继续当前工作包；不要重做已提交的部分。` }, now);
    open.autoRestartedAt = now;
    state.autoRestarts[lane] = [...(state.autoRestarts[lane] ?? []).filter((t) => now - t < stallPolicy.WINDOW_MS), now];
    appendLog({ t: iso(now), lane, kind: 'auto-restart', since: iso(open.since), forSec: sec(now - open.since) });
  } else if (d.action === 'escalate') {
    inbox({ lane: coordinatorOf(lane, sessions), action: 'queue', message: `【卡住且自动重启无效】${lane} ${d.why}（本段自 ${iso(open.since).slice(11, 19)}Z 起）。不要再重启同一会话：换新会话（assign 新工作包）或换模型，并查 coord.mjs errors ${lane}。` }, now);
    open.escalatedAt = now;
    appendLog({ t: iso(now), lane, kind: 'auto-restart-exhausted', since: iso(open.since), why: d.why });
  }
}

function tick() {
  const now = Date.now();
  const sessions = readJson(path.join(RUNS, 'sessions.json'), {});
  const lanes = Object.keys(sessions).filter((l) => !l.startsWith('__'));
  const running = lanes.filter((l) => !sessions[l].parked && alive(sessions[l].pid) && sessions[l].worktree);
  const wts = [...new Set(running.map((l) => realpath(sessions[l].worktree)).filter(Boolean))];
  const { perWorktree: busy, unattributedProcs } = busyWorktrees(wts);
  const deferral = stallPolicy.unattributedDeferral({ procs: unattributedProcs, seen: state.unattributedSeen ?? {}, nowMs: now });
  state.unattributedSeen = deferral.seen;
  const unattributed = deferral.active;
  // 维护/hold 期间、调度停着时只检测与记录，不发重启（没人送达；送达时 lane 可能已恢复）
  const env = { ...stallPolicy.actionEnv({ runs: RUNS, opsDir: defaultOpsDir(ROOT), nowMs: now }), unattributedBusy: unattributed };

  const current = {};
  for (const lane of lanes) {
    const s = sessions[lane];
    const isRunning = running.includes(lane);
    const ev = isRunning ? lastEvent(lane) : null;
    const wt = isRunning ? realpath(s.worktree) : null;
    const toolBusy = wt ? (busy.get(wt) ?? 0) > 0 : false;
    // 起算点：最后事件与本轮启动/恢复时刻中较晚者（刚恢复的 lane 末行还是上一轮的 exit，不能按它算）
    if (ev) ev.at = Math.max(ev.at, Date.parse(s.lastResumeAt ?? '') || 0, Date.parse(s.startedAt ?? '') || 0);
    const idle = ev ? now - ev.at : 0;
    const stalled = isRunning && ev && !toolBusy && idle >= THRESHOLD_MS;
    const open = state.open[lane];

    if (stalled && !open) {
      const since = ev.at;
      state.open[lane] = { since, lastEvent: ev.type };
      appendLog({ t: iso(now), lane, kind: 'start', since: iso(since), lastEvent: ev.type, model: s.model });
      const coord = COORDS.includes(lane) ? '__architect' : coordinatorOf(lane, sessions);
      (state.pendingDigest[coord] ??= []).push({ kind: 'start', lane, since: iso(since), lastEvent: ev.type, forSec: sec(idle) });
    } else if (open && !stalled) {
      // 恢复：出现新事件、开始执行工具、或 lane 已不在运行
      const end = ev && ev.at > open.since ? ev.at : now;
      const durationSec = sec(end - open.since);
      appendLog({ t: iso(now), lane, kind: 'end', since: iso(open.since), durationSec, reason: !isRunning ? 'lane 已停止' : toolBusy ? '开始执行工具' : '有新事件' });
      const coord = COORDS.includes(lane) ? '__architect' : coordinatorOf(lane, sessions);
      (state.pendingDigest[coord] ??= []).push({ kind: 'end', lane, durationSec });
      delete state.open[lane];
    }
    if (state.open[lane]) {
      act(lane, s, state.open[lane], now, sessions, env);
      current[lane] = { since: iso(state.open[lane].since), forSec: sec(now - state.open[lane].since), lastEvent: state.open[lane].lastEvent, model: s.model };
    }
  }
  fs.writeFileSync(`${CURRENT}.tmp`, JSON.stringify({ at: iso(now), thresholdSec: sec(THRESHOLD_MS), held: env.held, schedulerDown: env.schedulerDown, unattributedBusy: unattributed, lanes: current }));
  fs.renameSync(`${CURRENT}.tmp`, CURRENT);

  // 汇总：每个协调者每 DIGEST_MS 最多一条；条目里标出仍未恢复的
  for (const [coord, items] of Object.entries(state.pendingDigest)) {
    if (!items.length || now - (state.lastDigestAt[coord] ?? 0) < DIGEST_MS) continue;
    for (const i of items) if (i.kind === 'start') i.stillOpen = Boolean(state.open[i.lane]);
    if (coord === '__architect') {
      escalate(`协调者卡住检测：\n${items.map((i) => (i.kind === 'start' ? `- ${i.lane} 自 ${i.since} 起 ${i.forSec} 秒无返回（最后事件 ${i.lastEvent}）${i.stillOpen ? '，仍未恢复' : ''}` : `- ${i.lane} 已恢复（${i.durationSec} 秒）`)).join('\n')}\n`, now);
    } else {
      sendDigest(coord, items, now);
    }
    state.pendingDigest[coord] = [];
    state.lastDigestAt[coord] = now;
  }
  saveState();
}

const loop = () => {
  try {
    tick();
  } catch (e) {
    console.error(`${new Date().toISOString()} stall-watch 出错：${e.message}`);
  }
};
loop();
if (!argv.includes('--once')) setInterval(loop, INTERVAL_MS);
