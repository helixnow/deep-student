#!/usr/bin/env node
// 流水线体检：检查"流水线本身是否健康"的不变量，不依赖任何人想起来去看。
//   node scripts/electron-migration/pipeline-check.mjs            打印体检表（架构师每次唤醒先看这个）
//   node scripts/electron-migration/pipeline-check.mjs --alert    有新报警时：上报架构师 + 写入协调者信箱（同一报警 2 小时内不重复）
//   node scripts/electron-migration/pipeline-check.mjs --json     机器可读（面板/协调者摘要用）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectSystemicFault, parseIntegrateLog } from './lib/integrate-fault.mjs';
import * as repair from './lib/repair-actions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNS = path.join(ROOT, '.oc-runs');
const argv = process.argv.slice(2);
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const readJson = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// 关键路径 lane：超过阈值未合入即报警
const CRITICAL = ['L03-chat-pipeline', 'L04-chat-session', 'L13-vfs-api', 'L20-sync', 'L05-agent-workspace', 'L02-llm-manager', 'F1-kernel', 'F3-storage'];
const STALE_HOURS = 6;

const checks = []; // { id, level: 'ok'|'warn'|'alarm', msg }
const add = (id, level, msg) => checks.push({ id, level, msg });

// 1) 最近几轮集成：合入数、通过率、全局性故障
const logs = fs.readdirSync(RUNS).filter((f) => /^integrate-auto-.*\.log$/.test(f)).sort().slice(-4)
  .map((f) => ({ f, out: fs.readFileSync(path.join(RUNS, f), 'utf8') }))
  .filter((x) => /并行集成完成/.test(x.out));
for (const { f, out } of logs.slice(-3)) {
  const m = /候选 (\d+)，门禁通过 (\d+)/.exec(out);
  const merged = (out.match(/: 已合入/g) ?? []).length;
  const fault = detectSystemicFault(out);
  const at = f.replace(/^integrate-auto-(\d{4}-\d\d-\d\d)T(\d\d)(\d\d).*$/, '$2:$3Z');
  if (fault) add(`round-fault:${f}`, 'alarm', `${at} 集成轮全局性故障（${fault.kind}）：${fault.lanes.length} 条 lane 同因失败——${fault.reason.slice(0, 120)}`);
  else if (m && Number(m[1]) >= 5 && (merged === 0 || Number(m[2]) / Number(m[1]) < 0.3)) add(`round-low:${f}`, 'alarm', `${at} 集成轮合入 ${merged} 条（候选 ${m[1]}，通过 ${m[2]}）`);
  else if (m) add(`round:${f}`, 'ok', `${at} 集成轮 候选 ${m[1]} 通过 ${m[2]} 合入 ${merged}`);
}
if (!logs.length) add('round-none', 'warn', '没有已完成的集成轮');
const lastRoundAt = logs.length ? fs.statSync(path.join(RUNS, logs[logs.length - 1].f)).mtimeMs : 0;
if (lastRoundAt && Date.now() - lastRoundAt > 90 * 60_000) add('round-gap', 'alarm', `已 ${Math.round((Date.now() - lastRoundAt) / 60_000)} 分钟没有完成的集成轮`);

// 2) 关键 lane 距上次合入
const sessions = readJson(path.join(RUNS, 'sessions.json'), {});
for (const lane of CRITICAL) {
  if (!sessions[lane] || sessions[lane].parked) continue;
  let ahead = 0;
  let lastMs = 0;
  try {
    ahead = Number(git('rev-list', '--count', `main..ds-mig/${lane}`));
    lastMs = Date.parse(git('log', '-1', '--format=%cI', '--grep', `merge ds-mig/${lane}\\b`, 'main')) || 0;
  } catch {
    continue;
  }
  const hours = lastMs ? (Date.now() - lastMs) / 3_600_000 : Infinity;
  if (ahead > 0 && hours > STALE_HOURS) {
    const fail = readJson(path.join(RUNS, 'gate-fail.json'), {})[lane];
    add(`stale:${lane}`, 'alarm', `${lane} ${Number.isFinite(hours) ? hours.toFixed(1) : '∞'} 小时未合入（领先 ${ahead} 个提交）${fail ? `，最近门禁失败 ${fail.at.slice(11, 16)}Z` : ''}`);
  }
}

// 3) main 红灯趋势（全量测试历史）
const hist = (() => {
  try {
    return fs.readFileSync(path.join(RUNS, 'fulltest', 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  } catch {
    return [];
  }
})();
if (hist.length >= 2) {
  const [a, b] = hist.slice(-2);
  if (b.failed > a.failed) add('main-red-up', 'alarm', `main 失败用例增加：${a.failed} → ${b.failed}（全量测试 ${b.head.slice(0, 9)}）`);
  else add('main-red', 'ok', `main 失败用例 ${b.failed}（上次 ${a.failed}）`);
}
if (hist.length && Date.now() - Date.parse(hist[hist.length - 1].at) > 3 * 3_600_000) add('fulltest-stale', 'warn', '超过 3 小时没有新的全量测试结果');

// 3b) 套件级红灯：numFailedTests 为 0 也可能是红的（套件收集失败时用例根本没跑起来）
const latestFull = readJson(path.join(RUNS, 'fulltest', 'latest.json'), null);
if (latestFull) {
  const head9 = String(latestFull.head ?? '').slice(0, 9);
  const n = latestFull.numFailedTestSuites ?? 0;
  if (n > 0) {
    const suites = (latestFull.testResults ?? []).filter((t) => t.status === 'failed' && !(t.assertionResults ?? []).length).map((t) => t.name).slice(0, 3);
    add(`main-red-suites:${head9}`, 'alarm', `全量测试 ${head9} 有 ${n} 个失败套件（用例失败 ${latestFull.numFailedTests ?? 0}，只看用例数会误判为绿）：${suites.join(' | ') || '见 latest.json'}`);
  } else {
    add(`main-suites:${head9}`, 'ok', `全量测试 ${head9} 失败套件 0`);
  }
}

// 4) 协调者：在跑 / 积压 / 唤醒失败
const watchLog = (() => {
  try {
    const t = fs.readFileSync(path.join(RUNS, 'watch.log'), 'utf8');
    return t.slice(-400_000);
  } catch {
    return '';
  }
})();
const recent = watchLog.split('\n').filter((l) => Date.now() - Date.parse(l.slice(0, 24)) < 30 * 60_000);
for (const c of ['C1-app', 'C2-platform']) {
  const s = sessions[c];
  if (!s) continue;
  const q = s.queue?.length ?? 0;
  const wakeFail = recent.filter((l) => l.includes(`${c}: 唤醒协调者失败`)).length;
  if (wakeFail >= 3) add(`coord-wake:${c}`, 'alarm', `${c} 近 30 分钟唤醒失败 ${wakeFail} 次`);
  if (q >= 15) add(`coord-queue:${c}`, 'warn', `${c} 积压 ${q} 条消息`);
}

// 4b) lane 有活动但无产出：近 60 分钟错误退出 ≥5 次且没有一次正常的 step_finish（如会话中毒、供应商连败）
//     只看"90 秒无响应"的卡住检测发现不了这种秒级报错的空转（2026-11-04 漏报 7 小时）。
for (const [lane, s] of Object.entries(sessions)) {
  if (lane.startsWith('__') || s.parked) continue;
  const f = path.join(RUNS, `${lane}.jsonl`);
  let tail = '';
  try {
    const fd = fs.openSync(f, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 400_000);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    tail = buf.toString('utf8');
  } catch {
    continue;
  }
  const since = Date.now() - 60 * 60_000;
  let errors = 0;
  let finishes = 0;
  let lastErr = '';
  for (const line of tail.split('\n')) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!(e.timestamp > since)) continue;
    if (e.type === 'error') {
      errors++;
      lastErr = String(e.error?.type ?? e.error?.message ?? '').slice(0, 60);
    } else if (e.type === 'step_finish') finishes++;
  }
  if (errors >= 5 && finishes === 0) add(`no-output:${lane}`, 'alarm', `${lane} 近 60 分钟报错退出 ${errors} 次、没有一次有效步骤（${lastErr}）——在空转`);
}

// 5) 守护进程与关键服务心跳
if (!recent.length) add('daemon-silent', 'alarm', '守护进程 30 分钟内没有任何日志输出');

// 5b) S0（独立架构代理）产出心跳：它在改编排层本身，卡住时没有别的层能替它发现。
const s0 = sessions['S0-architect'];
if (s0 && !s0.parked) {
  let lastCommit = 0;
  try {
    lastCommit = Date.parse(git('log', '-1', '--format=%cI', 'ds-mig/S0-architect')) || 0;
  } catch {
    lastCommit = 0;
  }
  let lastEvent = 0;
  try {
    lastEvent = fs.statSync(path.join(RUNS, 'S0-architect.jsonl')).mtimeMs;
  } catch {
    lastEvent = 0;
  }
  const last = Math.max(lastCommit, lastEvent);
  const idleMin = last ? Math.round((Date.now() - last) / 60_000) : 9999;
  if (idleMin > 45) add('s0-idle', 'alarm', `S0-architect ${idleMin} 分钟无提交也无输出——自愈改造可能已卡住`);
  else add('s0', 'ok', `S0-architect 最近产出 ${idleMin} 分钟前`);
}

// 6) 管线结构：lane 自己修不了的故障（.git 属主漂移、状态文件损坏、残留 pid 锁、孤儿全测）。
//    2026-11-07 root 跑 git 留下 134 个 root 属主文件，X7 提交失败，看板与升级记录都没有指出根因。
try {
  for (const a of repair.check(repair.makeContext({ root: ROOT, runs: RUNS }))) {
    for (const f of a.findings) {
      const what = `${f.kind}${f.file ? ` ${f.file}` : ''}${f.runId ? ` ${f.runId}` : ''}${f.count ? ` ×${f.count}（样本 ${(f.sample ?? []).slice(0, 2).join('、')}）` : ''}`;
      const how = a.policy === 'report'
        ? `不自动修复；请主 agent 人工执行：${repair.manualOwnershipFix({ root: ROOT, worktreesRoot: path.resolve(ROOT, '..', 'ds-mig') })}`
        : `coord.mjs repair apply ${a.action} --from <你>${f.policy === 'confirm' ? ' --approve（需确认）' : ''}`;
      add(`repair:${a.action}:${f.kind}:${f.file ?? f.runId ?? ''}`, a.action === 'git-ownership' || f.kind === 'corrupt' ? 'alarm' : 'warn', `管线结构：${a.action} ${what}——${how}`);
    }
  }
} catch (e) {
  add('repair-check', 'warn', `管线结构检测失败：${String(e.message).split('\n')[0]}`);
}

const alarms = checks.filter((c) => c.level === 'alarm');
if (argv.includes('--json')) {
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), alarms, checks }));
} else {
  const icon = { ok: '✅', warn: '⚠️', alarm: '🚨' };
  console.log(`流水线体检 ${new Date().toISOString().slice(11, 16)}Z：报警 ${alarms.length}，注意 ${checks.filter((c) => c.level === 'warn').length}`);
  for (const c of [...checks].sort((x, y) => ['alarm', 'warn', 'ok'].indexOf(x.level) - ['alarm', 'warn', 'ok'].indexOf(y.level))) console.log(`${icon[c.level]} ${c.msg}`);
}

if (argv.includes('--alert') && alarms.length) {
  const stateFile = path.join(RUNS, 'pipeline-alerts.json');
  const state = readJson(stateFile, {});
  const fresh = alarms.filter((a) => !state[a.id] || Date.now() - Date.parse(state[a.id]) > 2 * 3_600_000);
  if (fresh.length) {
    const body = `【流水线体检报警（自动）】\n${fresh.map((a) => `- ${a.msg}`).join('\n')}\n\n这是流水线本身的健康问题，不是某一条 lane 的问题。完整体检：node ${path.relative(ROOT, fileURLToPath(import.meta.url))}`;
    fs.mkdirSync(path.join(RUNS, 'escalations'), { recursive: true });
    fs.writeFileSync(path.join(RUNS, 'escalations', `${new Date().toISOString().replace(/[:.]/g, '')}-pipeline-check.md`), body);
    fs.mkdirSync(path.join(RUNS, 'inbox'), { recursive: true });
    for (const c of ['C1-app', 'C2-platform']) {
      const f = path.join(RUNS, 'inbox', `${Date.now()}-pipeline-check-${c}.json`);
      fs.writeFileSync(`${f}.tmp`, JSON.stringify({ lane: c, message: `${body}\n\n请判断各报警的原因：属于 lane 层面的，由你推动；属于工具/基础设施的，用 escalate 交架构师。`, from: 'pipeline-check', action: 'queue' }));
      fs.renameSync(`${f}.tmp`, f);
    }
    for (const a of fresh) state[a.id] = new Date().toISOString();
    fs.writeFileSync(stateFile, JSON.stringify(state));
    console.log(`已报警 ${fresh.length} 条`);
  }
}
process.exitCode = alarms.length ? 1 : 0;
