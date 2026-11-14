// 进展与空转监控：回答"lane 在跑"之外的问题——它产出了什么。
// 实测（2026-11-03~06）：执行者有改动的轮次里 38% 只改文档，45% 的轮次没有任何改动；main 上 53% 的提交是自动检查点；
// 账本命令 B 级连续 47 小时为 0 而 A 级 99.8%（口径问题，不是没做）。这些都不会让"进程活着/有输出"的检查报警。
import fs from 'node:fs';
import path from 'node:path';

const MIN = 60_000;
export const SPIN = { steps: 40, docCommits: 2 };

export function classifyFile(f) {
  if (/(^|\/)(docs|migration)\//.test(f) || f.endsWith('.md') || /TESTMAP|SPEC|LANE|ACCEPTANCE|approvals/.test(path.basename(f))) return 'doc';
  if (f.startsWith('scripts/electron-migration/')) return 'orch';
  return 'product';
}

export function classifyCommit({ subject = '', files = [] }) {
  const kinds = new Set(files.map(classifyFile));
  const kind = kinds.has('product') ? 'product' : kinds.has('orch') ? 'orch' : kinds.has('doc') ? 'doc' : 'empty';
  return { kind, checkpoint: /检查点|checkpoint|\bWIP\b/i.test(subject) };
}

/** 评审/协调类 lane 的产出本来就是文档，不判文档空转。 */
const docByDesign = (lane) => /^(R\d|C\d|S0)-/.test(lane);

/**
 * @param o { lane, commits: [{subject, files}], steps, alive }
 * verdict：producing（有产品代码或测试提交）/ doc-spin（只有文档提交）/ idle-spin（消耗步骤但无提交）/ quiet
 */
export function classifyLane({ lane, commits = [], steps = 0, alive = false }) {
  const c = commits.map(classifyCommit);
  const n = (k) => c.filter((x) => x.kind === k).length;
  const product = n('product');
  const doc = n('doc');
  const orch = n('orch');
  const checkpoint = c.filter((x) => x.checkpoint).length;
  let verdict = 'quiet';
  let reason = '';
  if (product > 0) {
    verdict = 'producing';
    reason = `产品/测试提交 ${product}${checkpoint ? `（其中自动检查点 ${c.filter((x) => x.checkpoint && x.kind === 'product').length}）` : ''}`;
  } else if (doc >= SPIN.docCommits && !docByDesign(lane)) {
    verdict = 'doc-spin';
    reason = `只有文档提交 ${doc} 个，没有产品代码或测试`;
  } else if (steps >= SPIN.steps && product + doc + orch === 0) {
    verdict = 'idle-spin';
    reason = `${steps} 步没有任何提交${alive ? '（仍在跑）' : ''}`;
  }
  return { lane, verdict, reason, product, doc, orch, checkpoint, steps, alive };
}

/**
 * 账本、全测与 main 对账。区分"没做"和"没统计"：数字不动时先问口径和数据源是否一致。
 * @param o { ledger: [rows], fulltest, mainHead, fulltestLagCommits, nowMs }
 */
export function reconcile({ ledger = [], fulltest = null, mainHead = '', fulltestLagCommits = null, nowMs = Date.now() }) {
  const out = [];
  const last = ledger.at(-1);
  if (last) {
    // 同一指标长时间不动：A 级已满而 B 级为 0 → 判据/统计口径问题（没统计），不是没做
    for (const [a, b, label] of [['cmdA', 'cmdB', '命令'], ['testA', 'testB', '测试']]) {
      if (!(last[a] >= 95) || last[b] > 0) continue;
      const since = [...ledger].reverse().find((r) => r[b] > 0);
      const hours = (nowMs - Date.parse(since?.t ?? ledger[0].t)) / 3_600_000;
      if (hours >= 6) out.push({ id: `metric-uncounted:${b}`, level: 'alarm', msg: `${label} ${a.slice(-1)} 级 ${last[a]}% 而 ${b.slice(-1)} 级连续 ${hours.toFixed(0)} 小时为 0：先查 ${b.slice(-1)} 级判据是否要求了代码之外的东西（如 SPEC 勾选），这是"没统计"，不要派人补文档凑数` });
    }
    const ageH = (nowMs - Date.parse(last.t)) / 3_600_000;
    if (mainHead && last.head && !mainHead.startsWith(last.head) && ageH > 1) out.push({ id: 'ledger-stale', level: 'warn', msg: `账本最近一次计算在 ${String(last.head).slice(0, 9)}（${ageH.toFixed(1)} 小时前），main 已前进` });
    if (fulltest?.head && last.testsHead && !String(fulltest.head).startsWith(last.testsHead)) out.push({ id: 'ledger-head-mismatch', level: 'warn', msg: `账本测试 B 级基于 ${last.testsHead}，最新全测是 ${String(fulltest.head).slice(0, 9)}：两者不同源，不能互相印证` });
    if (last.fulltestOk === false && last.testB > 0) out.push({ id: 'testB-on-red', level: 'warn', msg: `测试 B 级 ${last.testB}% 来自一次非绿全测（raw 非 0 / 缺片 / 有失败），只能当进度参考，不是验收证据` });
  }
  if (fulltest) {
    const ageH = (nowMs - Date.parse(fulltest.at)) / 3_600_000;
    if (ageH > 3) out.push({ id: 'fulltest-stale', level: 'warn', msg: `最新全测 ${ageH.toFixed(1)} 小时前（${String(fulltest.head).slice(0, 9)}）` });
    if (fulltestLagCommits != null && fulltestLagCommits > 20) out.push({ id: 'fulltest-lag', level: 'warn', msg: `全测落后 main ${fulltestLagCommits} 个提交，main 当前状态没有测试证据` });
    if (fulltest.complete === false || (fulltest.rawFailures ?? []).length) out.push({ id: 'fulltest-incomplete', level: 'alarm', msg: `最新全测不完整或有 raw 非 0 分片（${JSON.stringify(fulltest.rawFailures ?? []).slice(0, 120)}）` });
  }
  return out;
}

/** watch.log 里最近若干轮自动集成：连续 0 合入的轮数。 */
export function zeroMergeStreak(watchLogText) {
  const rounds = [...String(watchLogText).matchAll(/自动集成：合入 (\d+)/g)].map((m) => Number(m[1]));
  let n = 0;
  for (let i = rounds.length - 1; i >= 0 && rounds[i] === 0; i--) n++;
  return { streak: n, rounds: rounds.length };
}

/** lane 日志里 [sinceMs, untilMs] 内的 step_start 数（只读末尾 2MB）。 */
export function stepsSince(file, sinceMs, untilMs = Infinity) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return 0;
  }
  const n = Math.min(st.size, 2 * 1024 * 1024);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(n);
  try {
    fs.readSync(fd, buf, 0, n, st.size - n);
  } finally {
    fs.closeSync(fd);
  }
  let count = 0;
  for (const m of buf.toString('utf8').matchAll(/"type":"step_start"[^\n]*?"timestamp":(\d{13})|"timestamp":(\d{13})[^\n]*?"type":"step_start"/g)) {
    const t = Number(m[1] ?? m[2]);
    if (t >= sinceMs && t <= untilMs) count++;
  }
  return count;
}

const parseLog = (text) => text.split('@@').slice(1).map((blk) => {
  const [head, ...files] = blk.trim().split('\n');
  const [sha, ...subject] = head.split('|');
  return { sha, subject: subject.join('|'), files: files.filter(Boolean) };
});

/**
 * lane 窗口内的产出 = 尚未集成的（main..分支）+ 窗口内由集成合并（"merge ds-mig/<lane>[ @sha]"，integrate-parallel 的标签）带进 main 的。
 * 不能按分支 first-parent 算：lane 集成后 merge main 会快进，自己的提交就离开了 first-parent 线。
 */
export function laneCommits(git, branch, sinceIso, untilIso = null) {
  const window = [`--since=${sinceIso}`, ...(untilIso ? [`--until=${untilIso}`] : [])];
  const out = new Map();
  const add = (text) => {
    for (const c of parseLog(text)) out.set(c.sha, c);
  };
  try {
    add(git('log', '--no-merges', ...window, '--name-only', '--format=@@%H|%s', `main..${branch}`));
  } catch {
    return [];
  }
  let merges = [];
  try {
    merges = git('log', 'main', '--first-parent', '--merges', ...window, '--format=%H|%s').split('\n').filter(Boolean)
      .map((l) => l.split('|')).filter(([, s]) => s === `merge ${branch}` || s.startsWith(`merge ${branch} @`)).map(([h]) => h);
  } catch {
    merges = [];
  }
  for (const m of merges) {
    try {
      add(git('log', '--no-merges', ...window, '--name-only', '--format=@@%H|%s', `${m}^1..${m}^2`));
    } catch {
      // 合并提交缺第二父（不该发生）时跳过
    }
  }
  return [...out.values()];
}

export function collectProgress({ runs, sessions, git, minutes = 120, nowMs = Date.now(), alive = () => false, mine = null }) {
  const sinceMs = nowMs - minutes * MIN;
  const sinceIso = new Date(sinceMs).toISOString();
  const lanes = Object.keys(sessions).filter((k) => !k.startsWith('__') && !sessions[k]?.parked && !sessions[k]?.coordinator && (!mine || (sessions[mine]?.lanes ?? []).includes(k)));
  const rows = lanes.map((lane) => classifyLane({
    lane,
    commits: laneCommits(git, sessions[lane].branch ?? `ds-mig/${lane}`, sinceIso, new Date(nowMs).toISOString()),
    steps: stepsSince(path.join(runs, `${lane}.jsonl`), sinceMs, nowMs),
    alive: alive(sessions[lane].pid),
  }));
  const readJson = (f, d) => {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      return d;
    }
  };
  let ledger = [];
  try {
    ledger = fs.readFileSync(path.join(runs, 'ledger-history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => Date.parse(r.t) <= nowMs).slice(-400);
  } catch {
    ledger = [];
  }
  const fulltest = readJson(path.join(runs, 'fulltest', 'latest.json'), null);
  let mainHead = '';
  let lag = null;
  try {
    mainHead = git('rev-parse', 'main');
    if (fulltest?.head) lag = Number(git('rev-list', '--count', '--first-parent', `${fulltest.head}..main`));
  } catch {
    // 不是 git 仓库或 main 不存在
  }
  let watch = '';
  try {
    watch = fs.readFileSync(path.join(runs, 'watch.log'), 'utf8').slice(-400_000);
  } catch {
    watch = '';
  }
  const alarms = reconcile({ ledger, fulltest: fulltest && { ...fulltest, testResults: undefined }, mainHead, fulltestLagCommits: lag, nowMs });
  const zm = zeroMergeStreak(watch);
  if (zm.streak >= 3) alarms.push({ id: 'zero-merge', level: 'alarm', msg: `自动集成连续 ${zm.streak} 轮 0 合入` });
  const count = (v) => rows.filter((r) => r.verdict === v).length;
  return { at: new Date(nowMs).toISOString(), minutes, totals: { producing: count('producing'), docSpin: count('doc-spin'), idleSpin: count('idle-spin'), quiet: count('quiet') }, rows, alarms };
}

export function formatProgress(p, { all = false } = {}) {
  const order = { 'idle-spin': 0, 'doc-spin': 1, producing: 2, quiet: 3 };
  const label = { 'idle-spin': '空转（耗步骤无提交）', 'doc-spin': '只改文档', producing: '有产出', quiet: '安静' };
  const shown = p.rows.filter((r) => all || r.verdict === 'idle-spin' || r.verdict === 'doc-spin').sort((a, b) => order[a.verdict] - order[b.verdict] || b.steps - a.steps);
  const out = [`# 进展与空转（最近 ${p.minutes} 分钟）`, '', `- 有产出 ${p.totals.producing} / 只改文档 ${p.totals.docSpin} / 空转 ${p.totals.idleSpin} / 安静 ${p.totals.quiet}`];
  if (shown.length) {
    out.push('', '| lane | 判定 | 产品提交 | 文档提交 | 检查点 | 步骤 | 说明 |', '|---|---|---|---|---|---|---|');
    for (const r of shown) out.push(`| ${r.lane} | ${label[r.verdict]} | ${r.product} | ${r.doc} | ${r.checkpoint} | ${r.steps} | ${r.reason || '—'} |`);
  }
  out.push('', '## 对账（没做 vs 没统计）');
  out.push(...(p.alarms.length ? p.alarms.map((a) => `- ${a.level === 'alarm' ? '🚨' : '⚠️'} ${a.msg}`) : ['- 无']));
  return out.join('\n');
}
