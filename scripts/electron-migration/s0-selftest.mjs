#!/usr/bin/env node
// S0 自证（G5）：在临时目录里用假 lane / 假集成进程验证 G1 心跳、G2 租约（及之后的 G4 压力阀）的正例与反例。
// 不读写真实 .oc-runs，不碰 main。每次提交编排改动前必须全绿。
//
//   node scripts/electron-migration/s0-selftest.mjs [--keep]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as lease from './lib/integrate-lease.mjs';
import * as hb from './lib/integrate-heartbeat.mjs';
import * as control from './lib/orch-control.mjs';
import * as valve from './lib/pressure-valve.mjs';
import { orderBatch } from './lib/batch-order.mjs';
import * as sa from './lib/sender-audit.mjs';
import * as poison from './lib/session-poison.mjs';
import * as gx from './lib/gate-excerpt.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const base = fs.mkdtempSync(path.join(fs.existsSync('/tmp/opencode') ? '/tmp/opencode' : os.tmpdir(), 's0-selftest-'));
// Gate checks now use the queue. Tests get their own real runner and spool;
// never submit synthetic failing checks into the live migration queue.
process.env.OC_JOBS_DIR = path.join(base, 'jobs');
const testRunner = spawn(process.execPath, [path.join(HERE, 'jobs/runner.mjs')], {
  env: { ...process.env, OC_INTEGRATE_LOCK: path.join(base, 'no-live-lock') }, stdio: 'ignore',
});
process.on('exit', () => testRunner.kill('SIGTERM'));
const results = [];
const test = async (name, fn) => {
  const runs = fs.mkdtempSync(path.join(base, 'runs-'));
  try {
    await fn(runs);
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, err: e.stack?.split('\n').slice(0, 3).join(' | ') ?? String(e) });
  }
};
const eq = (a, b, msg) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
};
const ok = (v, msg) => {
  if (!v) throw new Error(msg);
};
const incidents = (runs) => {
  try {
    return fs.readFileSync(path.join(runs, 'incidents.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const MIN = 60_000;
const T0 = Date.parse('2026-11-06T00:00:00Z');
/** 假探针：pid 是否存活、子进程数、main 最近更新时间均可控。 */
const fakeProbe = ({ alive = [], children = {}, mainAt = 0 } = {}) => ({
  alive: (pid) => alive.includes(pid),
  children: (pid) => children[pid] ?? 0,
  mainUpdatedAt: () => mainAt,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- G2 租约 ----------------
await test('G2 申请：空锁可取，写入完整 JSON 字段', (runs) => {
  const r = lease.acquire(runs, { pid: 101, owner: 'a', deny: ['L17'], probe: fakeProbe(), nowMs: T0 });
  ok(r.ok, '应取得锁');
  const j = JSON.parse(fs.readFileSync(lease.lockFile(runs), 'utf8'));
  eq(Object.keys(j).sort(), ['acquiredAt', 'expiresAt', 'owner', 'pid', 'renewals', 'scope'].sort(), '字段');
  eq(Date.parse(j.expiresAt) - Date.parse(j.acquiredAt), 20 * MIN, 'TTL 20 分钟');
});
await test('G2 反例：持有中（存活、未过期）不可抢', (runs) => {
  lease.acquire(runs, { pid: 101, owner: 'a', probe: fakeProbe(), nowMs: T0 });
  const r = lease.acquire(runs, { pid: 202, owner: 'b', probe: fakeProbe({ alive: [101] }), nowMs: T0 + 5 * MIN });
  ok(!r.ok && r.state === 'held', `应被拒，实际 ${r.state}`);
  eq(lease.readLock(runs).pid, 101, '锁仍属 101');
});
await test('G2 续租：只有持有者能续，renewals 递增、到期后移', (runs) => {
  lease.acquire(runs, { pid: 101, owner: 'a', probe: fakeProbe(), nowMs: T0 });
  ok(!lease.renew(runs, { pid: 202, nowMs: T0 + MIN }), '他人不能续');
  ok(lease.renew(runs, { pid: 101, nowMs: T0 + 15 * MIN }), '本人可续');
  const l = lease.readLock(runs);
  eq(l.renewals, 1, 'renewals');
  eq(l.expiresAt, new Date(T0 + 35 * MIN).toISOString(), '到期后移');
});
await test('G2 验收：idle holder 20 分钟后自动释放并记 incident', (runs) => {
  lease.acquire(runs, { pid: 101, owner: 'idle', probe: fakeProbe(), nowMs: T0 });
  const p = fakeProbe({ alive: [101], mainAt: T0 - 60 * MIN });
  eq(lease.sweep(runs, { probe: p, nowMs: T0 + 19 * MIN }).released, false, '19 分钟不释放');
  const s = lease.sweep(runs, { probe: p, nowMs: T0 + 21 * MIN });
  ok(s.released && s.state === 'expired-idle', `21 分钟应释放，实际 ${s.state}`);
  ok(!fs.existsSync(lease.lockFile(runs)), '锁文件已删');
  const inc = incidents(runs).find((i) => i.kind === 'lock-released');
  ok(inc && inc.why === 'expired-idle' && inc.holder.pid === 101, 'incident 记录');
});
await test('G2 反例：过期但有子进程（忙）不释放，只告警一次', (runs) => {
  lease.acquire(runs, { pid: 101, owner: 'busy', probe: fakeProbe(), nowMs: T0 });
  const p = fakeProbe({ alive: [101], children: { 101: 2 }, mainAt: T0 - 60 * MIN });
  const s1 = lease.sweep(runs, { probe: p, nowMs: T0 + 25 * MIN });
  const s2 = lease.sweep(runs, { probe: p, nowMs: T0 + 30 * MIN });
  ok(!s1.released && !s2.released && s1.state === 'expired-busy', `不应释放，实际 ${s1.state}`);
  eq(incidents(runs).filter((i) => i.kind === 'lock-expired-busy').length, 1, '告警一次');
});
await test('G2 反例：过期但 main 一个 TTL 内有新提交（持有者在推进）不释放', (runs) => {
  lease.acquire(runs, { pid: 101, owner: 'a', probe: fakeProbe(), nowMs: T0 });
  const s = lease.sweep(runs, { probe: fakeProbe({ alive: [101], mainAt: T0 + 18 * MIN }), nowMs: T0 + 22 * MIN });
  eq(s.state, 'expired-busy', '状态');
  ok(!s.released, '不释放');
});
await test('G2 忙持有者超宽限（过期 40 分钟）强制收回并上报，不结束进程', (runs) => {
  lease.acquire(runs, { pid: 101, owner: 'stuck', probe: fakeProbe(), nowMs: T0 });
  const s = lease.sweep(runs, { probe: fakeProbe({ alive: [101], children: { 101: 1 } }), nowMs: T0 + 61 * MIN });
  ok(s.released && s.state === 'expired-overdue' && /强制收回/.test(s.escalate ?? ''), `实际 ${s.state}`);
});
await test('G2 持有者已退出：立即收回；申请方可直接接管', (runs) => {
  lease.acquire(runs, { pid: 101, owner: 'gone', probe: fakeProbe(), nowMs: T0 });
  const r = lease.acquire(runs, { pid: 202, owner: 'b', probe: fakeProbe({ alive: [] }), nowMs: T0 + MIN });
  ok(r.ok, '应接管');
  eq(lease.readLock(runs).pid, 202, '新持有者');
  ok(incidents(runs).some((i) => i.kind === 'lock-released' && /dead/.test(i.why)), 'incident');
});
await test('G2 旧格式（纯 pid）：按 10 分钟 TTL，告警一次', (runs) => {
  fs.writeFileSync(lease.lockFile(runs), '4242');
  const mt = fs.statSync(lease.lockFile(runs)).mtimeMs;
  const p = fakeProbe({ alive: [4242], mainAt: mt - 60 * MIN });
  const s1 = lease.sweep(runs, { probe: p, nowMs: mt + 9 * MIN });
  ok(!s1.released && s1.state === 'held', `9 分钟仍持有，实际 ${s1.state}`);
  const s2 = lease.sweep(runs, { probe: p, nowMs: mt + 11 * MIN });
  ok(s2.released && s2.state === 'expired-idle', `11 分钟释放，实际 ${s2.state}`);
  eq(incidents(runs).filter((i) => i.kind === 'lock-legacy').length, 1, '旧格式告警一次');
});
await test('G2 收回时 deny 作用域转存 holds，保护不随锁丢失', (runs) => {
  lease.acquire(runs, { pid: 101, owner: 'C2-platform', deny: ['L17-memory-research/051c4cb73'], reason: 'D111', probe: fakeProbe(), nowMs: T0 });
  lease.sweep(runs, { probe: fakeProbe({ alive: [] }), nowMs: T0 + MIN });
  const h = lease.loadHolds(runs);
  eq(h.length, 1, 'holds 条数');
  eq(h[0].deny, ['L17-memory-research/051c4cb73'], 'deny 保留');
  eq(lease.effectiveDeny(runs, { selfPid: 999 }).length, 1, '生效规则');
});
await test('G2 收回竞态：判定后持有者续租，收回方不得删除新租约', (runs) => {
  lease.acquire(runs, { pid: 101, owner: 'a', probe: fakeProbe(), nowMs: T0 });
  const stale = lease.readLock(runs);
  ok(lease.renew(runs, { pid: 101, nowMs: T0 + MIN }), '续租');
  ok(!lease.reap(runs, stale, 'test', { nowMs: T0 + 2 * MIN }), '不应收回');
  eq(lease.readLock(runs).renewals, 1, '新租约保留');
});
await test('G2 失去租约后不能续租（集成器据此停止写 main）', (runs) => {
  lease.acquire(runs, { pid: 101, owner: 'a', probe: fakeProbe(), nowMs: T0 });
  lease.sweep(runs, { probe: fakeProbe({ alive: [101] }), nowMs: T0 + 30 * MIN });
  ok(!lease.renew(runs, { pid: 101, nowMs: T0 + 31 * MIN }), '应失败');
});
await test('G2 作用域：提交血缘否定 + lane 通配；已入 main 的提交规则失效', (runs) => {
  const repo = path.join(runs, 'repo');
  fs.mkdirSync(repo);
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 's0@test');
  g('config', 'user.name', 's0');
  const commit = (m) => {
    fs.writeFileSync(path.join(repo, 'f'), m);
    g('add', 'f');
    g('commit', '-qm', m);
    return g('rev-parse', 'HEAD');
  };
  commit('base');
  g('checkout', '-qb', 'L17');
  const bad = commit('051c');
  const child = commit('77ba');
  g('checkout', '-q', 'main');
  g('checkout', '-qb', 'L18');
  const clean = commit('l18');
  const isAncestor = (a, b) => {
    try {
      g('merge-base', '--is-ancestor', a, b);
      return true;
    } catch {
      return false;
    }
  };
  const rules = [{ rule: `L17-memory-research/${bad.slice(0, 9)}`, by: 'D111' }];
  ok(deny(rules, 'L17-memory-research', child, isAncestor), '后代被拒');
  ok(deny(rules, 'L17-memory-research', bad, isAncestor), '提交本身被拒');
  ok(!deny(rules, 'L18-media-docs', clean, isAncestor), '无关 lane 不受影响（不是全局停）');
  ok(deny([{ rule: 'L17*', by: 'x' }], 'L17-memory-research', clean, isAncestor), 'lane 通配命中');
  ok(!deny([{ rule: 'L17', by: 'x' }], 'L18-media-docs', clean, isAncestor), 'lane 前缀不误伤');
  g('checkout', '-q', 'main');
  g('merge', '-q', '--ff-only', 'L17');
  ok(!deny(rules, 'L18-media-docs', clean, isAncestor), '提交已入 main 后规则失效');
});
function deny(rules, lane, ref, isAncestor) {
  return lease.deniedBy(rules, { lane, ref, isAncestor });
}

// ---------------- G1 心跳 ----------------
const cur0 = (runs, extra = {}) => ({ pid: 1, log: path.join(runs, 'x.log'), exitFile: path.join(runs, 'x.log.exit'), jobs: 2, attempt: 0, ...extra });
await test('G1 决策：正常完成清空失败记录与熔断', () => {
  const d = hb.decide({ lastFail: { location: '门禁' }, breaker: { until: 'x' } }, { ok: true }, { jobs: 2 });
  eq(d.action, 'none', '动作');
  eq([d.state.lastFail, d.state.breaker], [null, null], '状态');
});
await test('G1 决策：首次异常 → 减半并行重试（4→2，2→1，最少 1）', () => {
  eq(hb.decide({}, { ok: false, location: '合入' }, { jobs: 4, attempt: 0 }).jobs, 2, '4→2');
  eq(hb.decide({}, { ok: false, location: '合入' }, { jobs: 2, attempt: 0 }).jobs, 1, '2→1');
  eq(hb.decide({}, { ok: false, location: '合入' }, { jobs: 1, attempt: 0 }).jobs, 1, '1→1');
});
await test('G1 决策：同阶段连续两次 → 熔断；不同阶段 → 不熔断', () => {
  const s1 = hb.decide({}, { ok: false, location: '门禁' }, { jobs: 2, attempt: 0 }, { nowMs: T0 }).state;
  const trip = hb.decide(s1, { ok: false, location: '门禁' }, { jobs: 1, attempt: 1 }, { nowMs: T0 + MIN });
  eq(trip.action, 'trip', '同阶段熔断');
  ok(hb.breakerOpen(trip.state, T0 + 30 * MIN) && !hb.breakerOpen(trip.state, T0 + 62 * MIN), '冷却 60 分钟后半开');
  const other = hb.decide(s1, { ok: false, location: '合入' }, { jobs: 1, attempt: 1 }, { nowMs: T0 + MIN });
  eq(other.action, 'none', '重试停在别处：不熔断也不再重试');
});
await test('G1 结果解析：退出码 137 → SIGKILL；无 exit 文件 → unknown；完成标记 → ok', (runs) => {
  const c = cur0(runs);
  fs.writeFileSync(c.exitFile, '137');
  const o = hb.readOutcome(c, '候选 3 条\n[阶段] 选候选\n[阶段] 门禁\nL02: 未合入（x）\n');
  eq([o.ok, o.code, o.signal, o.location], [false, 137, 'SIGKILL', '门禁'], 'kill');
  fs.rmSync(c.exitFile);
  eq(hb.readOutcome(c, '').signal, 'unknown', '无 exit 文件');
  eq(hb.readOutcome(c, '').location, '启动', '无阶段标记');
  ok(hb.readOutcome(c, '[阶段] 合入\n并行集成完成：候选 1').ok, '完成');
  ok(hb.readOutcome(c, 'integrate 已在运行（pid 9），跳过').ok, '正常跳过不算异常');
});
await test('G1 熔断：写 escalation、incident，并通知 C0', (runs) => {
  const sent = [];
  const c = cur0(runs);
  fs.writeFileSync(c.exitFile, '1');
  hb.onRunEnd({ runs, cur: c, out: '[阶段] 合入\n', nowMs: T0, notify: (f) => sent.push(f) });
  const r = hb.onRunEnd({ runs, cur: { ...c, attempt: 1, jobs: 1 }, out: '[阶段] 合入\n', nowMs: T0 + MIN, notify: (f) => sent.push(f) });
  eq(r.action, 'trip', '熔断');
  eq(sent.length, 1, '通知一次');
  ok(fs.readdirSync(path.join(runs, 'escalations')).some((f) => f.endsWith('-integrate-breaker.md')), 'escalation 文件');
  const kinds = incidents(runs).map((i) => i.kind);
  eq(kinds, ['integrate-abnormal', 'integrate-abnormal', 'integrate-breaker'], 'incident 序列');
});

// 端到端：真实 sh 包装 + 真实 kill。假集成脚本按真实 integrate-parallel 的方式持租约、打阶段标记。
const FAKE = path.join(base, 'fake-integrate.mjs');
fs.writeFileSync(FAKE, `
import * as lease from ${JSON.stringify(path.join(HERE, 'lib/integrate-lease.mjs'))};
const runs = process.env.S0_RUNS;
const probe = { alive: (p) => { try { process.kill(p, 0); return true; } catch { return false; } }, children: () => 0, mainUpdatedAt: () => 0 };
const r = lease.acquire(runs, { owner: 'fake', probe });
if (!r.ok) { console.log('integrate 已在运行（pid ' + r.holder.pid + '），跳过'); process.exit(0); }
process.on('exit', () => lease.release(runs));
console.log('[阶段] 选候选'); lease.renew(runs);
console.log('[阶段] 门禁'); lease.renew(runs);
if (process.env.S0_MODE === 'hang') { setInterval(() => {}, 1000); }
else { console.log('[阶段] 合入'); lease.renew(runs); console.log('X1-fake: 已合入 1 个提交'); console.log('并行集成完成：候选 1，门禁通过 1，并行度 ' + process.argv[process.argv.indexOf('--jobs') + 1]); }
`);
const waitFor = async (pred, ms, what) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return;
    await sleep(100);
  }
  throw new Error(`等待超时：${what}`);
};
await test('G1 验收（端到端）：kill 集成进程 → 记 SIGKILL/阶段 → 减半重试 → 完成合入', async (runs) => {
  process.env.S0_RUNS = runs;
  process.env.S0_MODE = 'hang';
  const c1 = hb.startRun({ runs, cwd: base, script: FAKE, jobs: 2, stamp: 'r1' });
  await waitFor(() => lease.readLock(runs) && fs.readFileSync(c1.log, 'utf8').includes('[阶段] 门禁'), 10_000, '假集成进入门禁');
  const holder = lease.readLock(runs).pid;
  ok(holder !== c1.pid, '锁持有者是 node 子进程，不是 sh 包装');
  process.kill(holder, 'SIGKILL');
  await waitFor(() => fs.existsSync(c1.exitFile), 10_000, 'exit 文件');
  const r1 = hb.onRunEnd({ runs, cur: c1, out: fs.readFileSync(c1.log, 'utf8') });
  eq([r1.outcome.signal, r1.outcome.location, r1.action, r1.jobs], ['SIGKILL', '门禁', 'retry', 1], '第一次');
  ok(lease.readLock(runs)?.pid === holder, '被 kill 的持有者锁残留（SIGKILL 无法清理）');
  process.env.S0_MODE = 'ok';
  const st = hb.loadState(runs);
  const c2 = hb.startRun({ runs, cwd: base, script: FAKE, jobs: st.retry.jobs, attempt: 1, stamp: 'r2' });
  await waitFor(() => fs.existsSync(c2.exitFile), 10_000, '重试结束');
  const out2 = fs.readFileSync(c2.log, 'utf8');
  const r2 = hb.onRunEnd({ runs, cur: c2, out: out2 });
  ok(r2.outcome.ok && /已合入/.test(out2) && /并行度 1/.test(out2), `重试应完成合入：${out2}`);
  ok(incidents(runs).some((i) => i.kind === 'lock-released' && /dead/.test(i.why)), '重试接管死锁并记 incident');
  ok(!fs.existsSync(lease.lockFile(runs)), '重试结束后释放锁');
  eq(hb.loadState(runs).lastFail, null, '心跳状态复位');
});

// ---------------- G3 执行器 ----------------
const auditOf = (runs, cmd) => incidents(runs).filter((i) => i.kind === 'command' && i.cmd === cmd);
await test('G3 release-lock：空闲 → 无动作；持有中无 --force → 拒绝且锁不动', (runs) => {
  eq(control.releaseLock(runs, { by: 't', probe: fakeProbe(), nowMs: T0 }).state, 'free', '空闲');
  lease.acquire(runs, { pid: 101, owner: 'a', probe: fakeProbe(), nowMs: T0 });
  const r = control.releaseLock(runs, { by: 'C0-chief', reason: 'x', probe: fakeProbe({ alive: [101] }), nowMs: T0 + MIN });
  ok(!r.ok && !r.released && r.state === 'held', `应拒绝，实际 ${r.state}`);
  eq(lease.readLock(runs).pid, 101, '锁仍在');
  eq(auditOf(runs, 'release-lock').length, 2, '两次都记审计');
});
await test('G3 release-lock --force：收回存活持有者的锁、deny 转存 holds、记审计；持有者此后续租失败', (runs) => {
  lease.acquire(runs, { pid: 101, owner: 'C2-platform', deny: ['L17-memory-research/051c4cb73'], probe: fakeProbe(), nowMs: T0 });
  const r = control.releaseLock(runs, { force: true, by: 'C0-chief', reason: '接管调度', probe: fakeProbe({ alive: [101], children: { 101: 1 } }), nowMs: T0 + MIN });
  ok(r.released, '应收回');
  ok(!fs.existsSync(lease.lockFile(runs)), '锁文件已删');
  eq(lease.loadHolds(runs)[0]?.deny, ['L17-memory-research/051c4cb73'], 'deny 保留');
  const a = auditOf(runs, 'release-lock')[0];
  ok(a && a.by === 'C0-chief' && a.force && a.released && a.reason === '接管调度', '审计字段');
  ok(!lease.renew(runs, { pid: 101, nowMs: T0 + 2 * MIN }), '原持有者续租失败（集成器据此停止写 main）');
});
await test('G3 release-lock：过期空闲持有者不需 --force', (runs) => {
  lease.acquire(runs, { pid: 101, owner: 'a', probe: fakeProbe(), nowMs: T0 });
  ok(control.releaseLock(runs, { by: 't', probe: fakeProbe({ alive: [101] }), nowMs: T0 + 25 * MIN }).released, '应收回');
});
await test('G3 integrate 排队：--jobs 上限 2；按入队顺序取；批次内都已合入 → 跳过取下一条', (runs) => {
  const a = control.enqueueIntegrate(runs, { lanes: control.parseLanes('L02-llm-manager@49e3537e4'), jobs: 4, by: 'C2-platform', nowMs: T0 });
  eq(a.jobs, 2, 'jobs 4 → 2');
  eq(a.lanes, [{ lane: 'L02-llm-manager', pin: '49e3537e4' }], '解析 lane@sha');
  control.enqueueIntegrate(runs, { lanes: control.parseLanes('X6-gate-checks,L19-mcp-browser'), jobs: 2, by: 'C2-platform', nowMs: T0 + 1000 });
  const t = control.takeQueued(runs, { pid: 500, alive: () => true, pending: (lane) => lane !== 'L02-llm-manager', nowMs: T0 + 2000 });
  eq(t.lanes.map((l) => l.lane), ['X6-gate-checks', 'L19-mcp-browser'], '首条无待合内容被跳过，取第二条且保持顺序');
  ok(auditOf(runs, 'integrate-skip').length === 1, '跳过有审计');
  eq(control.listQueue(runs).length, 0, '队列已空');
  control.finishQueued(runs, t);
  ok(fs.readdirSync(control.queueDir(runs)).every((f) => f.endsWith('.done')), '均已归档');
});
await test('G3 integrate 排队：执行进程中途死亡 → 放回重试一次；再死 → 归档 abandoned，不无限重放', (runs) => {
  control.enqueueIntegrate(runs, { lanes: [{ lane: 'L02-llm-manager' }], jobs: 2, by: 't', nowMs: T0 });
  ok(control.takeQueued(runs, { pid: 501, alive: () => true }), '第一次取到');
  const t2 = control.takeQueued(runs, { pid: 502, alive: (p) => p !== 501 });
  ok(t2 && /\.running\.502$/.test(t2.file), '501 死后被放回并由 502 取到');
  const t3 = control.takeQueued(runs, { pid: 503, alive: (p) => p !== 502 });
  eq(t3, null, '第二次死亡后不再重放');
  ok(auditOf(runs, 'integrate-abandon').length === 1, 'abandon 审计');
});
await test('G3 pause/resume-dispatch：幂等、记审计', (runs) => {
  ok(!control.dispatchPaused(runs), '初始未暂停');
  eq(control.pauseDispatch(runs, { by: 'C0-chief', reason: '积压', nowMs: T0 }).already, false, '暂停');
  eq(control.pauseDispatch(runs, { by: 'C0-chief', nowMs: T0 }).already, true, '重复暂停');
  eq(control.dispatchPaused(runs).by, 'C0-chief', '状态');
  eq(control.resumeDispatch(runs, { by: 'user', nowMs: T0 + MIN }).was.by, 'C0-chief', '恢复');
  ok(!control.dispatchPaused(runs) && control.resumeDispatch(runs, { by: 'user' }).already, '恢复后幂等');
  eq([auditOf(runs, 'pause-dispatch').length, auditOf(runs, 'resume-dispatch').length], [1, 1], '审计各一行');
});

// ---------------- G4 压力阀 ----------------
await test('G4 决策：>15 且 30 分钟无合入才暂停；人工恢复后给 30 分钟宽限；人工暂停不自动恢复', () => {
  const d = (o) => valve.decide({ lastMergeAt: T0, nowMs: T0 + 31 * MIN, paused: null, ...o });
  eq(d({ backlog: 16 }), 'pause', '16 条 / 31 分钟 → 暂停');
  eq(d({ backlog: 15 }), 'none', '15 条不暂停（> 15 才停）');
  eq(d({ backlog: 16, nowMs: T0 + 29 * MIN }), 'none', '29 分钟不暂停');
  eq(d({ backlog: 16, lastResumeAt: T0 + 20 * MIN }), 'none', '人工恢复后 30 分钟宽限');
  eq(d({ backlog: 8, paused: { auto: true } }), 'resume', '自动暂停：≤ 8 恢复');
  eq(d({ backlog: 9, paused: { auto: true } }), 'none', '9 条仍暂停');
  eq(d({ backlog: 0, paused: { auto: false } }), 'none', '人工暂停只能人工恢复');
});
await test('G4 验收（假积压）：16 条过检候选 → 自动暂停并给 C1 硬指令；合入 8 条 → 自动恢复', (runs) => {
  const repo = path.join(runs, 'repo');
  fs.mkdirSync(repo);
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 's0@test');
  g('config', 'user.name', 's0');
  fs.writeFileSync(path.join(repo, 'base'), 'b');
  g('add', '.');
  g('commit', '-qm', 'base');
  const isAncestor = (a, b) => {
    try {
      g('merge-base', '--is-ancestor', a, b);
      return true;
    } catch {
      return false;
    }
  };
  const sessions = { 'C1-app': { coordinator: true, branch: 'main' } };
  fs.mkdirSync(path.join(runs, 'selfgate'));
  for (let i = 1; i <= 18; i++) {
    const lane = `F${i}-fake`;
    g('checkout', '-qb', lane, 'main');
    fs.writeFileSync(path.join(repo, lane), lane);
    g('add', '.');
    g('commit', '-qm', lane);
    sessions[lane] = { branch: lane };
    // 16 条自检通过；F17 自检失败、F18 自检提交不是分支头 —— 都不算积压
    const tip = g('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(runs, 'selfgate', `${lane}.json`), JSON.stringify({ ok: i !== 17, tip: i === 18 ? 'deadbeef' : tip }));
  }
  g('checkout', '-q', 'main');
  const sent = [];
  const notify = (to, body) => sent.push({ to, body });
  let lanes = valve.backlog({ runs, sessions, git: g, isAncestor });
  eq(lanes.length, 16, '积压只计自检通过且为分支头的执行者 lane');
  lease.addHold(runs, { deny: ['F16-fake'], owner: 'C2', reason: 't' }, T0);
  lanes = valve.backlog({ runs, sessions, git: g, isAncestor });
  eq(lanes.length, 15, '被 hold 拒绝的不计入');
  eq(valve.evaluate({ runs, lanes, lastMergeAt: T0, nowMs: T0 + 40 * MIN, notify }).action, 'none', '15 条不暂停');
  lease.removeHold(runs, lease.loadHolds(runs)[0].id, T0);
  lanes = valve.backlog({ runs, sessions, git: g, isAncestor });
  eq(valve.evaluate({ runs, lanes, lastMergeAt: T0, nowMs: T0 + 40 * MIN, notify }).action, 'pause', '16 条 / 40 分钟 → 暂停');
  ok(control.dispatchPaused(runs)?.auto, '暂停标记 auto');
  ok(sent.length === 1 && sent[0].to === 'C1-app' && /先清积压/.test(sent[0].body) && /F1-fake/.test(sent[0].body), 'C1 收到硬指令与候选清单');
  eq(valve.evaluate({ runs, lanes, lastMergeAt: T0, nowMs: T0 + 45 * MIN, notify }).action, 'none', '暂停中不重复通知');
  eq(sent.length, 1, '只通知一次');
  for (let i = 1; i <= 8; i++) g('merge', '-q', '--no-edit', `F${i}-fake`);
  lanes = valve.backlog({ runs, sessions, git: g, isAncestor });
  eq(lanes.length, 8, '合入 8 条后积压 8');
  eq(valve.evaluate({ runs, lanes, lastMergeAt: T0 + 50 * MIN, nowMs: T0 + 50 * MIN, notify }).action, 'resume', '≤ 8 自动恢复');
  ok(!control.dispatchPaused(runs), '已恢复');
  eq(incidents(runs).filter((i) => i.kind === 'command').map((i) => i.cmd), ['pause-dispatch', 'resume-dispatch'], '审计');
});

// ---------------- 门禁原件 ----------------
await test('门禁原件：gate-runner 保存每项完整输出（超过内存截断上限也不截断）、code、signal 与 results.json', (runs) => {
  const raw = path.join(runs, 'raw');
  const node = process.execPath;
  const spec = [
    { name: 'big', bin: node, args: ['-e', "process.stdout.write('x'.repeat(5_000_000))"] },
    { name: 'exit3', bin: node, args: ['-e', "console.log('boom'); process.exit(3)"] },
    { name: 'killed', bin: node, args: ['-e', "process.kill(process.pid, 'SIGKILL')"] },
  ];
  const out = execFileSync(node, [path.join(HERE, 'gate-runner.mjs'), JSON.stringify(spec)], { cwd: runs, encoding: 'utf8', env: { ...process.env, GATE_RAW_DIR: raw }, maxBuffer: 64 << 20 });
  const res = JSON.parse(out);
  eq(res.map((r) => r.ok), [true, false, false], 'stdout 结果不变');
  ok(fs.statSync(path.join(raw, 'big.log')).size === 5_000_000, '完整输出 5MB 未截断');
  const j = (n) => JSON.parse(fs.readFileSync(path.join(raw, `${n}.json`), 'utf8'));
  eq([j('exit3').code, j('exit3').signal], [3, null], 'exit 3');
  eq([j('killed').code, j('killed').signal], [null, 'SIGKILL'], '信号');
  ok(/boom/.test(fs.readFileSync(path.join(raw, 'exit3.log'), 'utf8')), '失败项原文');
  eq(JSON.parse(fs.readFileSync(path.join(raw, 'results.json'), 'utf8')).length, 3, 'results.json');
});

await test('批次上限不饿死：排在会话表末尾的自检通过 lane 被暂缓一轮后，下一轮优先进批次', () => {
  // 10 条自检通过 + 1 条未过，上限 4；末尾的 Z 在第 1 轮被暂缓
  const lanes = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'Z'].map((lane) => ({ lane, selfGated: true }));
  const todo = [{ lane: 'U', selfGated: false }, ...lanes];
  const r1 = orderBatch(todo, {}, 4, '2026-11-06T03:00:00.000Z');
  eq(r1.batch.map((t) => t.lane), ['A', 'B', 'C', 'D'], '第 1 轮：自检通过优先，同级按会话表顺序');
  eq(Object.keys(r1.deferred).sort(), ['E', 'F', 'G', 'H', 'I', 'U', 'Z'], '暂缓记录');
  // 第 2 轮：A–D 有了新提交又回到候选（这正是 03:16–03:46Z 的情形），被暂缓过的仍应先进
  const r2 = orderBatch(todo, r1.deferred, 4, '2026-11-06T03:15:00.000Z');
  eq(r2.batch.map((t) => t.lane), ['E', 'F', 'G', 'H'], '第 2 轮：被暂缓过的优先，未自检的不插队');
  eq(r2.deferred.Z, '2026-11-06T03:00:00.000Z', '暂缓起点保留，不被刷新');
  const r3 = orderBatch(todo, r2.deferred, 4, '2026-11-06T03:30:00.000Z');
  ok(r3.batch.some((t) => t.lane === 'Z'), '第 3 轮 Z 进批次');
  eq(orderBatch(todo, {}, 0).batch.length, 11, '上限 0 = 不截断');
});

await test('整体复核 tests 按 vitest JSON 判定：日志里的预期错误不算失败，main 既有失败放行，新增失败拦截，进程级错误不放行', (runs) => {
  const node = process.execPath;
  // 假 vitest：输出大量 "error: Database error … 已拒绝"（预期日志，超过 4MB 截断），按 --outputFile.json 写报告
  const fake = path.join(runs, 'fake-vitest.mjs');
  fs.writeFileSync(fake, `
import fs from 'node:fs';
const mode = process.argv[2];
const file = process.argv.find((a) => a.startsWith('--outputFile.json='))?.split('=')[1];
const line = '      error: "Database error: payload 主键不一致: record_id=rec_0。这可能是云端数据损坏或重放攻击，已拒绝。"\\n';
process.stdout.write(line.repeat(60000));
const ok = (title) => ({ title, ancestorTitles: ['s'], status: 'passed' });
const bad = (title) => ({ title, ancestorTitles: ['s'], status: 'failed' });
const root = process.cwd();
const results = {
  pass: [{ name: root + '/host/plugins/a/t.test.ts', status: 'passed', assertionResults: [ok('x')] }],
  known: [{ name: root + '/host/plugins/a/t.test.ts', status: 'failed', assertionResults: [bad('old')] }],
  fresh: [{ name: root + '/host/plugins/a/t.test.ts', status: 'failed', assertionResults: [bad('old'), bad('new')] }],
  crash: [{ name: root + '/host/plugins/a/t.test.ts', status: 'passed', assertionResults: [ok('x')] }],
}[mode];
if (file && mode !== 'noreport') fs.writeFileSync(file, JSON.stringify({ numTotalTests: 2, numFailedTests: results.flatMap((t) => t.assertionResults).filter((a) => a.status === 'failed').length, testResults: results }));
process.exit(mode === 'pass' ? 0 : 1);
`);
  const baseline = path.join(runs, 'baseline.json');
  fs.writeFileSync(baseline, JSON.stringify({ head: 'base00000', testResults: [{ name: 'host/plugins/a/t.test.ts', status: 'failed', assertionResults: [{ title: 'old', ancestorTitles: ['s'], status: 'failed' }] }] }));
  const judge = (mode) => {
    const spec = [{ name: 'tests', bin: node, args: [fake, mode] }];
    const out = execFileSync(node, [path.join(HERE, 'gate-runner.mjs'), JSON.stringify(spec)], { cwd: runs, encoding: 'utf8', env: { ...process.env, GATE_BASELINE_FILE: baseline, GATE_RAW_DIR: path.join(runs, `raw-${mode}`) }, maxBuffer: 64 << 20 });
    return JSON.parse(out)[0];
  };
  eq(judge('pass').ok, true, '全过');
  const k = judge('known');
  eq([k.ok, k.judgedBy], [true, 'vitest-json'], '只有 main 既有失败 → 放行（日志里的 Database error 不计）');
  const f = judge('fresh');
  ok(!f.ok && /新增失败 1 项/.test(f.excerpt) && /new/.test(f.excerpt) && !/Database error/.test(f.excerpt), `新增失败 → 拦截且摘录是用例名：${f.excerpt.slice(0, 120)}`);
  eq(judge('crash').ok, false, '报告无失败但退出码非 0 → 不放行');
  ok(fs.existsSync(path.join(runs, 'raw-known', 'tests.vitest.json')), 'JSON 报告随原件落盘');
});

// ---------------- 信箱发送方审计 ----------------
await test('信箱发送方审计：记下 pid/ppid/工作目录/会话，按工作目录反查 lane；冒名只记审计不拦截', (runs) => {
  const repo = path.join(runs, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const wt = (l) => path.join(runs, 'wt', l);
  for (const l of ['X7', 'S0-architect', 'C0-chief']) fs.mkdirSync(path.join(wt(l), 'sub'), { recursive: true });
  const ss = { 'X7': { worktree: wt('X7') }, 'S0-architect': { worktree: wt('S0-architect'), coordinator: true }, 'C0-chief': { worktree: wt('C0-chief'), coordinator: true } };
  const R = path.join(repo, '.oc-runs');
  fs.mkdirSync(R, { recursive: true });
  fs.writeFileSync(path.join(R, 'sessions.json'), JSON.stringify(ss));
  const coord = path.join(HERE, 'coord.mjs');
  const msg = path.join(runs, 'm.md');
  fs.writeFileSync(msg, 'hi');
  eq(sa.laneOfCwd(ss, path.join(wt('X7'), 'sub')), 'X7', '子目录反查到 lane');
  eq(sa.laneOfCwd(ss, wt('X7') + '-other'), null, '前缀相同的兄弟目录不算');
  eq(sa.laneOfCwd(ss, repo), null, '不在任何工作树内 → null');
  const real = sa.recordSend(R, ss, { action: 'queue', to: 'C0-chief', from: 'S0-architect', cwd: wt('S0-architect'), pid: 11, ppid: 10, sessionId: 'ses_a' });
  eq([real.mismatch, real.cwdLane, real.pid, real.ppid, real.sessionId], [false, 'S0-architect', 11, 10, 'ses_a'], '自报与工作目录一致');
  const fake = sa.recordSend(R, ss, { action: 'queue', to: 'C0-chief', from: 'S0-architect', cwd: path.join(wt('X7'), 'sub'), pid: 22, ppid: 20, sessionId: 'ses_b' });
  eq([fake.mismatch, fake.cwdLane], [true, 'X7'], 'X7 工作树里以 S0 名义发送 → mismatch');
  const audit = fs.readFileSync(path.join(R, 'inbox-audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  eq(audit.map((a) => [a.from, a.cwdLane, a.mismatch]), [['S0-architect', 'S0-architect', false], ['S0-architect', 'X7', true]], '每次发送都有审计行');
  eq(incidents(R).filter((i) => i.kind === 'sender-mismatch').map((i) => [i.from, i.cwdLane, i.pid]), [['S0-architect', 'X7', 22]], '只有冒名那次记 incident');
  // 端到端：coord queue 照常投递（不拦截），信箱条目带 sender
  const out = execFileSync(process.execPath, [coord, 'queue', 'C0-chief', msg, '--from', 'S0-architect'], { cwd: path.join(wt('X7'), 'sub'), env: { ...process.env, OPENCODE_SESSION_ID: 'ses_fake', GIT_DIR: path.join(repo, '.git') }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  ok(/已投递/.test(out), `冒名也照常投递：${out}`);
  const inbox = fs.readdirSync(path.join(R, 'inbox')).filter((f) => f.endsWith('.json'));
  eq(inbox.length, 1, '信箱里有一条');
  const item = JSON.parse(fs.readFileSync(path.join(R, 'inbox', inbox[0]), 'utf8'));
  eq([item.from, item.sender?.cwdLane, item.sender?.mismatch, item.sender?.sessionId], ['S0-architect', 'X7', true, 'ses_fake'], '信箱条目带实际发送方');
});

// ---------------- 会话中毒 ----------------
await test('会话中毒：被内容过滤拦下的 step_finish 不算进展，连续两次即换新会话；协调者补送被拦轮次的消息且只补一次', () => {
  const T = (s) => Date.parse(`2026-11-06T05:${s}Z`);
  const filtered = (ts) => [
    { type: 'step_start', timestamp: T(ts) },
    { type: 'error', timestamp: T(ts) + 1, error: { type: 'provider.content-filter', message: 'Provider blocked the response' } },
    { type: 'step_finish', timestamp: T(ts) + 2, part: { reason: 'content-filter' } },
    { type: 'exit', code: 1, timestamp: T(ts) + 3 },
  ];
  // 与 oc-dispatch 执行者恢复路径相同的计数规则
  const hitsAfter = (events, resumes) => {
    let hits = 0;
    for (const r of resumes) {
      const ev = events.filter((e) => e.timestamp <= T(r.end));
      if (!poison.poisoned(ev)) return { hits, switched: false };
      hits = poison.progressedSince(ev, `2026-11-06T05:${r.at}Z`) ? 1 : hits + 1;
      if (hits >= 2) return { hits, switched: true };
    }
    return { hits, switched: false };
  };
  const ev = [...filtered('00:10'), ...filtered('05:10')];
  eq(poison.poisoned(ev), true, '最后一轮以内容过滤结束');
  eq(hitsAfter(ev, [{ at: '00:00', end: '00:20' }, { at: '05:00', end: '05:20' }]), { hits: 2, switched: true }, 'U2 现场形态：两次被拦即换会话');
  // 反例：续作后有真正完成的步骤，再被拦只算第一次（内容过滤可能是间歇性的）
  const ok1 = [...filtered('00:10'), { type: 'step_start', timestamp: T('05:05') }, { type: 'step_finish', timestamp: T('05:06'), part: { reason: 'tool-calls' } }, ...filtered('05:10')];
  eq(hitsAfter(ok1, [{ at: '00:00', end: '00:20' }, { at: '05:00', end: '05:20' }]), { hits: 1, switched: false }, '中间有进展 → 不换');
  eq(poison.poisoned([...filtered('00:10'), { type: 'step_start', timestamp: T('00:30') }]), false, '之后又开始新一步 → 不算中毒');
  eq(poison.poisoned([{ type: 'error', error: { type: 'provider.rate-limit' } }]), false, '限流不算中毒');
  // 补送：立即送达会把 lastWakeAt 改成一小时前，补送范围按 lastResumeAt
  const sent = [
    { message: 'old', sentAt: '2026-11-06T04:00:00.000Z' },
    { message: 'a', sentAt: '2026-11-06T05:00:19.990Z' },
    { message: 'b', sentAt: '2026-11-06T05:00:19.995Z' },
  ];
  eq(poison.redeliverable(sent, '2026-11-06T05:00:20.000Z').map((q) => q.message), ['a', 'b'], '只补上一轮送出的');
  for (const q of poison.redeliverable(sent, '2026-11-06T05:00:20.000Z')) q.redelivered = 'x';
  eq(poison.redeliverable(sent, '2026-11-06T05:00:20.000Z').length, 0, '每条只补一次');
});

// ---------------- 门禁心跳续租 ----------------
await test('G2 心跳：门禁子进程在跑期间续租（单次门禁可超过 TTL）；停止后不再续；锁被收回时调用 onLost 并停止', async (runs) => {
  const r = lease.acquire(runs, { pid: process.pid, owner: 'hb', probe: fakeProbe(), nowMs: Date.now() - 19 * MIN });
  ok(r.ok, '取锁');
  const exp0 = Date.parse(lease.readLock(runs).expiresAt);
  let lost = 0;
  const hb = lease.keepAlive(runs, { everyMs: 30, onLost: () => lost++ }).start();
  await sleep(120);
  const l1 = lease.readLock(runs);
  ok(l1.renewals >= 2 && Date.parse(l1.expiresAt) > exp0 + 15 * MIN, `跑门禁期间续租：renewals=${l1.renewals}`);
  hb.stop();
  const n = lease.readLock(runs).renewals;
  await sleep(100);
  eq(lease.readLock(runs).renewals, n, '停止后不再续租（空闲持有者照常按 TTL 过期）');
  // 锁被收回、换给别人 → 心跳发现后调用 onLost 并停止
  const hb2 = lease.keepAlive(runs, { everyMs: 30, onLost: () => lost++ }).start();
  fs.writeFileSync(lease.lockFile(runs), JSON.stringify({ pid: 999999, owner: 'other', scope: { deny: [] }, acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 20 * MIN).toISOString(), renewals: 0 }));
  await sleep(120);
  eq([lost, hb2.running, lease.readLock(runs).pid], [1, false, 999999], '失去租约：回调一次、心跳停止、不复活别人的锁');
});
// integrate-parallel 的门禁确实挂上了心跳（防止以后改动把它摘掉）
await test('G2 心跳接线：integrate-parallel 的 runGate 在门禁子进程存活期间启用 keepAlive，close 时停止', () => {
  const src = fs.readFileSync(path.join(HERE, 'integrate-parallel.mjs'), 'utf8');
  const body = src.slice(src.indexOf('function runGate('), src.indexOf('// ---- 第 0 步'));
  ok(/lease\.keepAlive\(RUNS,[\s\S]*\.start\(\)/.test(body), 'runGate 启动心跳');
  ok(/child\.on\('close'[\s\S]{0,80}hb\.stop\(\)/.test(body), 'close 时停止心跳');
});

// ---------------- 整体复核：RPC 超时误报与超时缩放 ----------------
await test('tests 检查：报告完整、0 失败、未处理错误只有 worker RPC 超时 → 判 ok（infra）且不重跑；夹带其他错误或报告不完整 → 不放行', (runs) => {
  const node = process.execPath;
  const fake = path.join(runs, 'fake-vitest-rpc.mjs');
  fs.writeFileSync(fake, `
import fs from 'node:fs';
const mode = process.argv[2];
const file = process.argv.find((a) => a.startsWith('--outputFile.json='))?.split('=')[1];
const rpc = '⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯\\nError: [vitest-worker]: Timeout calling "onTaskUpdate"\\n ❯ Object.onTimeoutError rpc.js:53:10\\n';
const other = '⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯\\nTypeError: Cannot read properties of undefined (reading "close")\\n ❯ teardown x.ts:3:1\\n';
const errs = { rpc: [rpc], other: [other], mixed: [rpc, other], incomplete: [rpc] }[mode];
process.stdout.write(' ✓ host/plugins/a/t.test.ts (2 tests)\\n⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯\\n\\n' + errs.join('\\n') + '\\n Test Files  1 passed (1)\\n      Tests  1 passed | 1 skipped (2)\\n     Errors  ' + errs.length + ' error' + (errs.length > 1 ? 's' : '') + '\\n');
const root = process.cwd();
const a = [{ title: 'x', ancestorTitles: ['s'], status: 'passed' }, { title: 'y', ancestorTitles: ['s'], status: mode === 'incomplete' ? 'run' : 'skipped' }];
if (file) fs.writeFileSync(file, JSON.stringify({ numTotalTests: 2, numPassedTests: 1, numPendingTests: mode === 'incomplete' ? 0 : 1, numTodoTests: 0, numFailedTests: 0, numFailedTestSuites: 0, testResults: [{ name: root + '/host/plugins/a/t.test.ts', status: 'passed', assertionResults: a }] }));
process.exit(1);
`);
  const judge = (mode) => {
    const raw = path.join(runs, `raw-${mode}`);
    const spec = [{ name: 'tests', bin: node, args: [fake, mode] }];
    const out = execFileSync(node, [path.join(HERE, 'gate-runner.mjs'), JSON.stringify(spec)], { cwd: runs, encoding: 'utf8', env: { ...process.env, GATE_BASELINE_FILE: path.join(runs, 'none.json'), GATE_RAW_DIR: raw } });
    return { ...JSON.parse(out)[0], retried: fs.existsSync(path.join(raw, 'tests.retry1.log')) };
  };
  const r = judge('rpc');
  eq([r.ok, r.infra, r.retried], [true, true, false], 'C2 06:01Z 现场形态：放行、标 infra、不重跑整套');
  ok(/基础设施误报/.test(r.excerpt) && /onTaskUpdate/.test(r.excerpt), `摘录写明原因与原文：${r.excerpt.slice(0, 120)}`);
  eq(judge('other').ok, false, '未处理错误不是 RPC 超时 → 不放行');
  eq(judge('mixed').ok, false, 'RPC 超时夹带别的未处理错误 → 不放行');
  eq(judge('incomplete').ok, false, '报告里有未完成用例 → 不放行');
  // 超时按目录数缩放
  const { timeoutFor } = gx;
  const six = { name: 'tests', args: ['vitest', 'run', '-c', 'vitest.host.config.ts', ...['anki', 'browser', 'mcp', 'notes', 'qbank', 'sync'].map((d) => `host/plugins/${d}/`)] };
  eq([timeoutFor(six) / MIN, timeoutFor(six, 1) / MIN], [52.5, 90], '6 目录整体复核 ≥45 分钟，重跑翻倍封顶 90');
  eq([timeoutFor({ name: 'tests', args: ['host/plugins/a/'] }) / MIN, timeoutFor({ name: 'typecheck', args: ['host/x/'] }) / MIN], [15, 15], '单目录与非测试检查仍为 15 分钟');
});

// ---------------- 汇总 ----------------
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n    ${r.err}`}`);
console.log(`\ns0-selftest：${results.length - failed.length}/${results.length} 通过`);
if (!process.argv.includes('--keep')) fs.rmSync(base, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
