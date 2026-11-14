#!/usr/bin/env node
// 协调者工具：查看 lane 状态与报告、读集成结果、向 lane（或另一位协调者）发指令。
// 只读调度状态；发指令只写信箱（.oc-runs/inbox），由守护进程并入队列——不直接改 sessions.json。
//
//   node scripts/electron-migration/coord.mjs status [--mine <协调者>] [--all]
//   node scripts/electron-migration/coord.mjs health [--mine <协调者>] [--all]   各 lane 健康度（上下文占用、无输出、出错率、空转、排队、重试、会话步数）
//   node scripts/electron-migration/coord.mjs progress [--minutes 120] [--mine <协调者>] [--all] [--json]   产出与空转（产品提交/文档提交/步骤）+ 账本全测对账
//   node scripts/electron-migration/coord.mjs report <lane> [--chars 6000]     最近一轮的完整报告（最后的文本输出）
//   node scripts/electron-migration/coord.mjs errors <lane>                    最近的错误事件
//   node scripts/electron-migration/coord.mjs integrate                        最近一次集成的合入/拒绝明细
//   node scripts/electron-migration/coord.mjs queue <lane> <消息文件|-> --from <协调者>
//        协调者同主题 2 小时内第 3 次且无新证据（提交号/job id/run id）的催办会被拒（退出码 3）并给出升级阶梯；
//        确有新事实时加 --force-repeat --reason "<新事实>"
//   node scripts/electron-migration/coord.mjs commits <lane> [-n 15]           分支相对 main 的新提交
//   node scripts/electron-migration/coord.mjs queue <lane> <消息文件> --from <你> --now   立即打断该 lane 当前一轮，在原会话送达
//   node scripts/electron-migration/coord.mjs restart <lane> [消息文件] --from <你>       结束卡住的 lane 并在原会话恢复
//   node scripts/electron-migration/coord.mjs escalate <文件|-> --from <你>               上报架构师（首行进调度日志，务必写成一句话摘要）
//
// 执行器（S0 G3，每个动作在 .oc-runs/incidents.jsonl 记 kind=command 审计行）：
//   node scripts/electron-migration/coord.mjs release-lock --from <你> [--force] [--reason ...]   收回集成锁（只收回锁，不结束持有者进程）
//   node scripts/electron-migration/coord.mjs integrate --lanes a,b@sha --from <你> [--jobs 2] [--reason ...]
//        指定批次集成：排进 .oc-runs/integrate.queue/；集成器空闲则立即启动，否则当前一轮结束后先跑队首批次。按给定顺序合入。
//   node scripts/electron-migration/coord.mjs pause-dispatch --from <你> [--reason ...]   暂停启动/续派/恢复执行者（在跑的不受影响）
//   node scripts/electron-migration/coord.mjs resume-dispatch --from <你> [--reason ...]
//   node scripts/electron-migration/coord.mjs repair check|plan <动作>|apply <动作> --from <你> [--approve]   管线修复动作（repair.mjs）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as lease from './lib/integrate-lease.mjs';
import * as heartbeat from './lib/integrate-heartbeat.mjs';
import * as control from './lib/orch-control.mjs';
import * as senderAudit from './lib/sender-audit.mjs';
import * as nudge from './lib/nudge-guard.mjs';
import { laneStatus } from './lib/lane-paths.mjs';

/** 处置表（dispatch/DISPOSITION.json）里已退役 / 已并入的 lane 不再接受派发与重启。 */
function requireActive(lane) {
  const st = laneStatus(lane);
  if (!st.active) throw new Error(`${lane} 已${st.action === 'merge' ? '并入' : '退役，路径归'} ${st.into}（dispatch/DISPOSITION.json：${st.reason}），改派给 ${st.into}`);
}

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
// 主仓库（.oc-runs 所在处）：worktree 的 common dir 的上级。
const MAIN = path.resolve(git(process.cwd(), 'rev-parse', '--path-format=absolute', '--git-common-dir'), '..');
const RUNS = path.join(MAIN, '.oc-runs');
if (argv[0] === 'repair') {
  // 在读 sessions.json 之前分流：它损坏时其余子命令都会崩，协调者仍要能检测和修复它。
  const r = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'repair.mjs'), ...argv.slice(1), '--root', MAIN], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
const sessions = JSON.parse(fs.readFileSync(path.join(RUNS, 'sessions.json'), 'utf8'));

const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
function events(lane) {
  const f = path.join(RUNS, `${lane}.jsonl`);
  if (!fs.existsSync(f)) return [];
  const text = fs.readFileSync(f, 'utf8');
  const tail = text.length > 2_000_000 ? text.slice(-2_000_000) : text;
  return tail.split('\n').flatMap((l) => {
    try {
      return l ? [JSON.parse(l)] : [];
    } catch {
      return [];
    }
  });
}
/**
 * 进程号是否仍属于该 lane：机器重启后进程号会被重新分配，旧 pid 可能恰好指向无关进程（实测指向 opencode serve），
 * 若照旧当作"在跑"，既会让 lane 永远不被恢复，打断/重启时还会误杀共享服务。Linux 上以进程工作目录 == lane 工作树为准。
 */
function pidBelongsTo(pid, worktree) {
  if (!pid || !worktree || process.platform !== 'linux') return true;
  try {
    return fs.realpathSync(`/proc/${pid}/cwd`) === fs.realpathSync(worktree);
  } catch {
    return true; // 进程已不存在（由 alive 判定）或无权读取
  }
}
function state(lane, s, ev) {
  if (s.parked) return 'parked';
  if (alive(s.pid) && pidBelongsTo(s.pid, s.worktree)) return 'running';
  if (alive(s.pid)) return 'failed';
  if (!s.pid && !s.session) return 'pending';
  if (s.queue?.length) return 'queued';
  let i = ev.length - 1;
  while (i >= 0 && ev[i].type === 'raw') i--;
  if (i >= 0 && ev[i].type === 'exit' && ev[i].code === 0) return 'review';
  let j = ev.length - 1;
  while (j >= 0 && (ev[j].type === 'exit' || ev[j].type === 'raw')) j--;
  if (j >= 0 && ev[j].type === 'step_finish' && ev[j].part?.reason === 'stop') return 'review';
  return 'failed';
}
const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 60 ? `${m}m` : `${(m / 60).toFixed(1)}h`;
};

const cmd = argv[0];
if (cmd === 'substance') {
  // 含金量报告：最近 N 分钟主线的代码/文档构成、账本、全测、集成、工作包与风险。
  const minutes = Number(opt('minutes', '60'));
  const since = new Date(Date.now() - minutes * 60_000).toISOString();
  const safe = (fn, dflt = '?') => { try { return fn(); } catch { return dflt; } };
  const out = [];
  const headLine = safe(() => git(MAIN, 'log', '-1', 'main', '--format=%h|%cI|%s'), '?|?|?');
  const [head, headAt, headSubj] = headLine.split('|');
  out.push(`# 含金量报告（最近 ${minutes} 分钟）`, '', '## 主线');
  out.push(`- main: ${head}${headAt ? ` ${ago(Date.parse(headAt))}前` : ''} ${String(headSubj).slice(0, 90)}`);
  const commits = safe(() => git(MAIN, 'log', 'main', '--first-parent', `--since=${since}`, '--format=%H').split('\n').filter(Boolean), []);
  const rows = commits.map((c) => {
    const files = safe(() => git(MAIN, 'diff', '--name-only', `${c}^1`, c).split('\n').filter(Boolean), []);
    let code = 0;
    let orch = 0;
    let docs = 0;
    for (const f of files) {
      if (f.startsWith('docs/') || f.startsWith('migration/') || f.endsWith('.md')) docs++;
      else if (f.startsWith('scripts/electron-migration/')) orch++;
      else code++;
    }
    const subject = safe(() => git(MAIN, 'log', '-1', '--format=%h %s', c), c);
    return { code, orch, docs, subject, files: files.length };
  });
  const codeN = rows.filter((r) => r.code > 0).length;
  const docN = rows.filter((r) => r.code === 0).length;
  out.push(`- 新提交: ${rows.length}（含产品代码 ${codeN} / 非产品 ${docN}）`);
  for (const r of rows.slice(0, 12)) out.push(`  - ${String(r.subject).slice(0, 110)} → 代码 ${r.code} / 编排 ${r.orch} / 文档 ${r.docs}`);
  if (!rows.length) out.push('- 本窗口 main 无新提交');

  out.push('', '## 账本');
  const hist = safe(() => fs.readFileSync(path.join(RUNS, 'ledger-history.jsonl'), 'utf8').trim().split('\n').slice(-2).map((l) => JSON.parse(l)), []);
  if (hist.length) {
    const lastRow = hist[hist.length - 1];
    const prev = hist.length > 1 ? hist[hist.length - 2] : null;
    const dA = prev ? (lastRow.testA - prev.testA).toFixed(1) : '—';
    const dB = prev ? (lastRow.testB - prev.testB).toFixed(1) : '—';
    out.push(`- 最近: A${lastRow.testA}% / B${lastRow.testB}% @${String(lastRow.head).slice(0, 9)}（${ago(Date.parse(lastRow.t))}前），较上一条 ΔA ${dA} / ΔB ${dB}`);
  }
  const ft = safe(() => JSON.parse(fs.readFileSync(path.join(RUNS, 'fulltest/latest.json'), 'utf8')), null);
  if (ft) {
    const lag = safe(() => git(MAIN, 'rev-list', '--count', '--first-parent', `${ft.head}..main`), '?');
    const mt = safe(() => fs.statSync(path.join(RUNS, 'fulltest/latest.json')).mtimeMs, Date.now());
    const suites = ft.numFailedTestSuites ?? 0;
    const red = (ft.numFailedTests ?? 0) > 0 || suites > 0;
    out.push(`- 全测: ${String(ft.head).slice(0, 9)} ${ft.numFailedTests} failed / ${ft.numTotalTests}，失败套件 ${suites}${red ? ' ← 红' : ''}（${ago(mt)}前，落后 main ${lag} 个提交）`);
  }

  out.push('', '## 集成');
  const cur = safe(() => JSON.parse(fs.readFileSync(path.join(RUNS, 'integrate.current.json'), 'utf8')), null);
  if (cur && alive(cur.pid)) out.push(`- 运行中 pid ${cur.pid}（${ago(Date.parse(cur.startedAt))}）`);
  else out.push('- 当前无集成进程');
  const logs = safe(() => fs.readdirSync(RUNS).filter((f) => /^integrate-auto-.*\.log$/.test(f)).map((f) => ({ f, t: fs.statSync(path.join(RUNS, f)).mtimeMs })).sort((a, b) => b.t - a.t), []);
  if (logs.length) {
    const text = safe(() => fs.readFileSync(path.join(RUNS, logs[0].f), 'utf8'), '');
    const cand = /候选 (\d+) 条，其中自检通过 (\d+) 条/.exec(text);
    const merged = [...text.matchAll(/^(\S+): 已合入 (\d+) 个提交/gm)];
    const rejected = [...text.matchAll(/^(\S+): 未合入（/gm)].map((m) => m[1]);
    const mergedCommits = merged.reduce((a, m) => a + Number(m[2]), 0);
    out.push(`- ${cur && alive(cur.pid) ? '本轮（进行中）' : '最近一轮'}（${ago(logs[0].t)}前）: 候选 ${cand?.[1] ?? '?'} / 自检通过 ${cand?.[2] ?? '?'}；合入 ${merged.length} lane / ${mergedCommits} 提交；拒绝 ${rejected.length}${rejected.length ? `（${rejected.join(', ')}）` : ''}`);
  }

  out.push('', '## 工作包');
  const wps = safe(() => fs.readFileSync(path.join(RUNS, 'board/WORKPLAN.md'), 'utf8').split('\n').filter((l) => /^\| WP-/.test(l)).map((l) => l.split('|').map((x) => x.trim())).filter((p) => p.length > 7).map((p) => ({ id: p[1], lane: p[2], status: p[6] })), []);
  if (wps.length) {
    const cnt = (st) => wps.filter((w) => w.status === st).length;
    out.push(`- assigned ${cnt('assigned')} / ready ${cnt('ready')} / blocked ${cnt('blocked')} / delivered ${cnt('delivered')} / integrated ${cnt('integrated')}`);
    const blocked = wps.filter((w) => w.status === 'blocked').slice(0, 6).map((w) => `${w.id}@${w.lane}`);
    if (blocked.length) out.push(`- blocked: ${blocked.join(', ')}`);
    const delivered = wps.filter((w) => w.status === 'delivered').map((w) => `${w.id}@${w.lane}`);
    if (delivered.length) out.push(`- delivered 未集成: ${delivered.join(', ')}`);
  }

  out.push('', '## 风险');
  const esc = safe(() => fs.readdirSync(path.join(RUNS, 'escalations')).filter((f) => f.endsWith('.md') && !fs.existsSync(path.join(RUNS, 'escalations', `${f}.seen`))), []);
  out.push(`- 未处理 escalation: ${esc.length}${esc.length ? `（最新 ${esc.slice(-3).join(', ')}）` : ''}`);
  const gf = safe(() => Object.keys(JSON.parse(fs.readFileSync(path.join(RUNS, 'gate-fail.json'), 'utf8'))), []);
  out.push(`- 门禁失败待处理: ${gf.length}${gf.length ? `（${gf.join(', ')}）` : ''}`);
  const dec = safe(() => fs.readFileSync(path.join(RUNS, 'board/DECISIONS.md'), 'utf8'), '');
  const userDec = (dec.match(/^- \*\*U-\d+/gm) || []).length;
  out.push(`- 用户待裁定: ${userDec}（U-001/U-002 见 DECISIONS.md）`);
  const intText = safe(() => fs.readFileSync(path.join(RUNS, 'board/INTEGRATION.md'), 'utf8'), '');
  const nInt = (intText.match(/待回滚/g) || []).length;
  const nDec = (dec.match(/待回滚/g) || []).length;
  out.push(`- 待回滚标记: INTEGRATION ${nInt} 处 / DECISIONS ${nDec} 处（要求 C2 给出已 revert / 未 revert 的明确状态）`);

  out.push('', '## 协调者');
  for (const c of ['C1-app', 'C2-platform']) {
    const s = sessions[c];
    if (!s) continue;
    const st = s.parked ? 'parked' : alive(s.pid) ? 'running' : s.queue?.length ? 'queued' : 'idle';
    out.push(`- ${c}: ${st}，排队 ${s.queue?.length ?? 0}，上次唤醒 ${s.lastWakeAt ? `${ago(Date.parse(s.lastWakeAt))}前` : '—'}`);
  }
  // 独立架构代理：它改编排层本身，卡住时没有别的层会替它发现，所以固定列在摘要里。
  const s0 = sessions['S0-architect'];
  if (s0) {
    let idle = '?';
    try {
      idle = `${Math.round((Date.now() - fs.statSync(path.join(RUNS, 'S0-architect.jsonl')).mtimeMs) / 60000)}m`;
    } catch {
      idle = '无日志';
    }
    const st = s0.parked ? 'parked' : alive(s0.pid) ? 'running' : 'idle';
    out.push(`- S0-architect: ${st}，最近输出 ${idle} 前（超过 45 分钟无产出应视为卡住）`);
  }
  console.log(out.join('\n'));
} else if (cmd === 'progress') {
  // 进展与空转：每条 lane 窗口内的产品提交 / 文档提交 / 检查点 / 消耗步骤，加账本与全测对账（lib/progress.mjs）。
  const { collectProgress, formatProgress } = await import('./lib/progress.mjs');
  const p = collectProgress({ runs: RUNS, sessions, git: (...a) => git(MAIN, ...a), minutes: Number(opt('minutes', '120')), alive: (pid) => alive(pid), mine: opt('mine') });
  if (argv.includes('--json')) process.stdout.write(JSON.stringify(p));
  else console.log(formatProgress(p, { all: argv.includes('--all') }));
} else if (cmd === 'status') {
  const mine = opt('mine');
  const lanes = Object.keys(sessions).filter((k) => !k.startsWith('__') && (!mine || argv.includes('--all') || (sessions[mine]?.lanes ?? []).includes(k)));
  console.log('| lane | 状态 | 工作包 | 模型 | 领先 main | 排队 | 恢复 | 最近活动 |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const l of lanes.sort()) {
    const s = sessions[l];
    const ev = events(l);
    let ahead = '?';
    try {
      ahead = git(MAIN, 'rev-list', '--count', '--no-merges', `main..${s.branch ?? `ds-mig/${l}`}`);
    } catch {
      ahead = '?';
    }
    let mt = 0;
    try {
      mt = fs.statSync(path.join(RUNS, `${l}.jsonl`)).mtimeMs;
    } catch {
      mt = 0;
    }
    console.log(`| ${l} | ${state(l, s, ev)} | ${s.wp ?? '—'} | ${String(s.model).replace(/^.*\//, '')} | ${ahead} | ${s.queue?.length ?? 0} | ${s.retries ?? 0} | ${mt ? ago(mt) : '—'} |`);
  }
} else if (cmd === 'health') {
  const { computeHealth, loadModelLimits, sessionSteps, loadStalls } = await import('./lib/health.mjs');
  const limits = loadModelLimits();
  const stalls = loadStalls(RUNS);
  const mine = opt('mine');
  const rows = [];
  for (const l of Object.keys(sessions).filter((k) => !k.startsWith('__') && (!mine || argv.includes('--all') || (sessions[mine]?.lanes ?? []).includes(k))).sort()) {
    const s = sessions[l];
    if (s.parked) continue;
    const ev = events(l);
    let mt = 0;
    try {
      mt = fs.statSync(path.join(RUNS, `${l}.jsonl`)).mtimeMs;
    } catch {
      mt = 0;
    }
    let lc = null;
    try {
      lc = Date.parse(git(MAIN, 'log', '-1', '--format=%cI', s.branch ?? `ds-mig/${l}`)) || null;
    } catch {
      lc = null;
    }
    const h = computeHealth({ model: s.model, alive: alive(s.pid) && pidBelongsTo(s.pid, s.worktree), events: ev, lastActivityMs: mt || null, lastCommitMs: lc, queue: s.queue, retries: s.retries, sessionSteps: sessionSteps(path.join(RUNS, `${l}.jsonl`)), stallSec: stalls[l] ?? null }, limits);
    rows.push({ l, h });
  }
  const order = { bad: 0, warn: 1, ok: 2 };
  rows.sort((a, b) => order[a.h.level] - order[b.h.level] || a.l.localeCompare(b.l));
  console.log('| lane | 健康 | 上下文 | 原因 |');
  console.log('|---|---|---|---|');
  for (const { l, h } of rows) console.log(`| ${l} | ${{ ok: '健康', warn: '注意', bad: '异常' }[h.level]} | ${h.ctxPct != null ? Math.round(h.ctxPct * 100) + '%' : '—'} | ${h.flags.map((f) => f.msg).join('；') || '—'} |`);
} else if (cmd === 'report') {
  const lane = argv[1];
  const chars = Number(opt('chars', '6000'));
  const texts = events(lane).filter((e) => e.type === 'text').map((e) => e.part?.text ?? '');
  const out = texts.slice(-3).join('\n\n---\n\n');
  console.log(out.length > chars ? `…（截断，显示末尾 ${chars} 字符）\n${out.slice(-chars)}` : out || '（暂无文本输出）');
} else if (cmd === 'errors') {
  for (const e of events(argv[1]).filter((x) => x.type === 'error').slice(-8)) console.log(`${new Date(e.timestamp).toISOString()} ${e.error?.type ?? ''} ${String(e.error?.message ?? '').slice(0, 400)}`);
} else if (cmd === 'integrate' && opt('lanes')) {
  const from = opt('from');
  if (!from) throw new Error('必须用 --from <你的 lane 名> 标明来源');
  const lanes = control.parseLanes(opt('lanes'));
  const unknown = lanes.filter((l) => !sessions[l.lane]).map((l) => l.lane);
  if (unknown.length) throw new Error(`未知 lane：${unknown.join(', ')}`);
  if (Number(opt('jobs', '2')) > control.MAX_JOBS) console.log(`--jobs 上限 ${control.MAX_JOBS}（用户红线），已按 ${control.MAX_JOBS} 执行`);
  const e = control.enqueueIntegrate(RUNS, { lanes, jobs: opt('jobs', '2'), by: from, reason: opt('reason', '') });
  const probe = lease.defaultProbe(MAIN);
  let cur = null;
  try {
    cur = JSON.parse(fs.readFileSync(path.join(RUNS, 'integrate.current.json'), 'utf8'));
  } catch {
    cur = null;
  }
  const busy = (cur && alive(cur.pid)) || lease.assess(RUNS, { probe }).state !== 'free';
  if (busy) {
    const l = lease.readLock(RUNS);
    console.log(`已排队 ${e.id}：${control.lanesSpec(lanes)}（集成器忙：锁 ${l ? `${l.owner}/${l.pid} 到期 ${l.expiresAt}` : '空'}；当前一轮结束后先跑队首批次，排队 ${control.listQueue(RUNS).length} 条）`);
  } else {
    const run = heartbeat.startRun({ runs: RUNS, cwd: MAIN, script: path.join(MAIN, 'scripts/electron-migration/integrate-parallel.mjs'), jobs: e.jobs });
    control.audit(RUNS, { cmd: 'integrate-start', by: from, id: e.id, pid: run.pid, log: run.log });
    console.log(`已启动 ${e.id}：${control.lanesSpec(lanes)}（pid ${run.pid}，--jobs ${e.jobs}，日志 ${run.log}）`);
  }
} else if (cmd === 'integrate') {
  const q = control.listQueue(RUNS);
  if (q.length) console.log(`排队批次 ${q.length} 条：${q.map((x) => `${x.id}[${control.lanesSpec(x.lanes ?? [])}]`).join('；')}\n`);
  const files = fs.readdirSync(RUNS).filter((f) => /^integrate-(auto|manual)/.test(f) && f.endsWith('.log')).map((f) => ({ f, t: fs.statSync(path.join(RUNS, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  if (!files.length) console.log('（尚无集成日志）');
  else {
    console.log(`# ${files[0].f}（${ago(files[0].t)}前）\n`);
    console.log(fs.readFileSync(path.join(RUNS, files[0].f), 'utf8').replace(/ \| /g, '\n      ').slice(0, 20000));
  }
} else if (cmd === 'commits') {
  const lane = argv[1];
  console.log(git(MAIN, 'log', '--no-merges', '--format=%h %cr %s', '-n', opt('n', '15'), `main..${sessions[lane]?.branch ?? `ds-mig/${lane}`}`) || '（无新提交）');
} else if (cmd === 'queue') {
  const [lane, src] = [argv[1], argv[2]];
  const from = opt('from');
  if (!sessions[lane]) throw new Error(`未知 lane：${lane}`);
  if (!from) throw new Error('必须用 --from <你的协调者 lane 名> 标明来源');
  const message = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8');
  if (!message.trim()) throw new Error('消息为空');
  // 催办闸：协调者同主题第 3 次无新证据的催办不发送，改走升级阶梯（lib/nudge-guard.mjs）
  const forced = argv.includes('--force-repeat') ? opt('reason', '') : null;
  if (forced !== null && !forced.trim()) throw new Error('--force-repeat 必须配 --reason "<新事实>"');
  const verdict = nudge.assess(nudge.readHistory(RUNS), { from, to: lane, text: message });
  if (!verdict.allow && forced === null) {
    nudge.record(RUNS, { from, to: lane, features: verdict.features, blocked: true, level: verdict.level });
    console.error(`未发送：${from} → ${lane}\n${verdict.ladder}`);
    process.exit(3);
  }
  if (verdict.features) nudge.record(RUNS, { from, to: lane, features: verdict.features, forced, level: verdict.level });
  if (verdict.allow && verdict.ladder) console.error(`注意：${verdict.ladder}`);
  fs.mkdirSync(path.join(RUNS, 'inbox'), { recursive: true });
  const file = path.join(RUNS, 'inbox', `${Date.now()}-${from}-${lane}.json`);
  const action = argv.includes('--now') || opt('priority') === 'high' ? 'interrupt' : 'queue';
  const sender = senderAudit.recordSend(RUNS, sessions, { action, to: lane, file, from });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ lane, message, from, action, sender }));
  fs.renameSync(`${file}.tmp`, file);
  if (sender.mismatch) console.error(`注意：--from ${from} 与工作目录所属 lane ${sender.cwdLane} 不一致，已记审计（不拦截）`);
  console.log(action === 'interrupt'
    ? `已投递（立即送达）：${from} → ${lane}（守护进程下一轮打断该 lane 当前运行，在原会话送达）`
    : `已投递：${from} → ${lane}（守护进程下一轮并入队列；lane 本轮收尾后送达；若该 lane 已停/失败则立即送达）`);
} else if (cmd === 'restart') {
  const lane = argv[1];
  const from = opt('from');
  if (!sessions[lane]) throw new Error(`未知 lane：${lane}`);
  if (!from) throw new Error('必须用 --from <你的协调者 lane 名> 标明来源');
  requireActive(lane);
  const src = argv[2] && !argv[2].startsWith('--') ? argv[2] : null;
  const message = src ? fs.readFileSync(src, 'utf8') : '';
  fs.mkdirSync(path.join(RUNS, 'inbox'), { recursive: true });
  const file = path.join(RUNS, 'inbox', `${Date.now()}-${from}-${lane}-restart.json`);
  const sender = senderAudit.recordSend(RUNS, sessions, { action: 'restart', to: lane, file, from });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ lane, message, from, action: 'restart', sender }));
  fs.renameSync(`${file}.tmp`, file);
  if (sender.mismatch) console.error(`注意：--from ${from} 与工作目录所属 lane ${sender.cwdLane} 不一致，已记审计（不拦截）`);
  console.log(`已请求重启：${lane}（守护进程下一轮结束其当前运行并在原会话恢复）`);
} else if (cmd === 'assign') {
  // v3：派发一个工作包给 lane（新会话执行）。用法：assign <lane> <WP编号> <brief文件|-> --from <协调者> [--model m] [--force]
  const [lane, wp, src] = [argv[1], argv[2], argv[3]];
  const from = opt('from');
  if (!sessions[lane] || sessions[lane].coordinator) throw new Error(`不能派发给：${lane}`);
  requireActive(lane);
  if (!wp || !/^WP-[\w.-]+$/.test(wp)) throw new Error('工作包编号格式：WP-<序号>，如 WP-031');
  if (!from) throw new Error('必须用 --from <你的协调者 lane 名> 标明来源');
  const brief = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8');
  if (!brief.trim()) throw new Error('brief 为空');
  const board = path.join(RUNS, 'board', 'wp');
  fs.mkdirSync(board, { recursive: true });
  fs.writeFileSync(path.join(board, `${wp}.brief.md`), brief);
  fs.mkdirSync(path.join(RUNS, 'inbox'), { recursive: true });
  const file = path.join(RUNS, 'inbox', `${Date.now()}-${from}-${lane}-assign.json`);
  const sender = senderAudit.recordSend(RUNS, sessions, { action: 'assign', to: lane, file, from });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ lane, wp, message: brief, from, action: 'assign', model: opt('model'), force: argv.includes('--force'), sender }));
  fs.renameSync(`${file}.tmp`, file);
  if (sender.mismatch) console.error(`注意：--from ${from} 与工作目录所属 lane ${sender.cwdLane} 不一致，已记审计（不拦截）`);
  console.log(`已派发：${wp} → ${lane}（brief 已存 .oc-runs/board/wp/${wp}.brief.md；守护进程下一轮以新会话启动）`);
} else if (cmd === 'wp-done') {
  // v3：执行者交付工作包报告。用法：wp-done <WP编号> <报告文件|-> --lane <你的 lane>
  const [wp, src] = [argv[1], argv[2]];
  const lane = opt('lane');
  if (!wp || !lane || !sessions[lane]) throw new Error('用法：wp-done <WP编号> <报告文件|-> --lane <lane>');
  const body = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8');
  if (!body.trim()) throw new Error('报告为空');
  let tip = '?';
  try {
    tip = git(MAIN, 'rev-parse', '--short', sessions[lane].branch ?? `ds-mig/${lane}`);
  } catch {
    tip = '?';
  }
  const board = path.join(RUNS, 'board', 'wp');
  fs.mkdirSync(board, { recursive: true });
  const reportFile = path.join(board, `${wp}.report.md`);
  const deliveredAt = new Date().toISOString();
  fs.writeFileSync(reportFile, `<!-- lane=${lane} tip=${tip} at=${deliveredAt} -->\n${body}`);
  // 报告文件每次交付都会覆盖；重复交付次数（空转判定第 4 条）只能从这份追加日志里数
  fs.appendFileSync(path.join(board, 'deliveries.jsonl'), `${JSON.stringify({ wp, lane, tip, at: deliveredAt })}\n`);
  const owner = Object.keys(sessions).find((k) => sessions[k]?.coordinator && (sessions[k].lanes ?? []).includes(lane));
  const first = body.split('\n').find((l) => l.trim()) ?? '';
  fs.mkdirSync(path.join(RUNS, 'inbox'), { recursive: true });
  for (const to of [...new Set([owner, 'C2-platform'].filter(Boolean))]) {
    const f = path.join(RUNS, 'inbox', `${Date.now()}-${lane}-${to}-wpdone.json`);
    fs.writeFileSync(`${f}.tmp`, JSON.stringify({ lane: to, from: lane, action: 'queue', message: `【工作包交付】${wp}（${lane} @${tip}）：${first.slice(0, 200)}\n报告：${reportFile}` }));
    fs.renameSync(`${f}.tmp`, f);
  }
  console.log(`已交付：${wp}（报告 ${reportFile}；已通知 ${[owner, 'C2-platform'].filter(Boolean).join('、')}）`);
} else if (cmd === 'release-lock') {
  const from = opt('from');
  if (!from) throw new Error('必须用 --from <你的 lane 名> 标明来源');
  const r = control.releaseLock(RUNS, { force: argv.includes('--force'), reason: opt('reason', ''), by: from, probe: lease.defaultProbe(MAIN) });
  if (r.state === 'free') console.log('集成锁本来就空闲');
  else if (r.released) console.log(`已收回集成锁：pid ${r.holder.pid}（${r.holder.owner}，${r.state}）；未结束该进程，deny 作用域已转存 integrate.holds.json`);
  else if (!r.ok && (r.state === 'held' || r.state === 'expired-busy')) {
    console.log(`未收回：持有者 pid ${r.holder.pid}（${r.holder.owner}）${r.state === 'held' ? `租约有效至 ${r.holder.expiresAt}` : '租约已过期但仍在工作'}。确需收回加 --force（持有者下次续租失败会自行停止、不写 main）`);
    process.exitCode = 2;
  } else console.log(`收回失败（状态 ${r.state}，锁可能刚被续租或换了持有者），请重试`);
} else if (cmd === 'pause-dispatch' || cmd === 'resume-dispatch') {
  const from = opt('from');
  if (!from) throw new Error('必须用 --from <你的 lane 名> 标明来源');
  const r = cmd === 'pause-dispatch' ? control.pauseDispatch(RUNS, { by: from, reason: opt('reason', '') }) : control.resumeDispatch(RUNS, { by: from, reason: opt('reason', '') });
  console.log(cmd === 'pause-dispatch'
    ? (r.already ? `派发早已暂停（${r.state.by} ${r.state.at}）` : '已暂停派发：守护进程不再启动、续派、恢复执行者；在跑的 lane 与协调者不受影响')
    : (r.already ? '派发本来就未暂停' : `已恢复派发（原暂停：${r.was.by} ${r.was.at}）`));
} else if (cmd === 'escalate') {
  const from = opt('from');
  if (!from) throw new Error('必须用 --from <你的协调者 lane 名> 标明来源');
  const body = argv[1] === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(argv[1], 'utf8');
  fs.mkdirSync(path.join(RUNS, 'escalations'), { recursive: true });
  const file = path.join(RUNS, 'escalations', `${new Date().toISOString().replace(/[:.]/g, '')}-${from}.md`);
  fs.writeFileSync(file, body);
  console.log(`已上报：${path.basename(file)}（lane 的上报转给其协调者；协调者的上报记入 .oc-runs/board/ESCALATIONS.log 供用户裁定）`);
} else {
  console.log('用法见文件头注释：status | health | report | errors | integrate | commits | queue | restart | assign | wp-done | escalate | release-lock | pause-dispatch | resume-dispatch');
  process.exit(1);
}
