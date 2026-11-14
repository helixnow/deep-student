// 集成锁租约（S0 G2）：.oc-runs/integrate.lock 由"持有者存活即永久持有"改为带 TTL 的租约。
//
// 锁文件（JSON）：{ pid, owner, scope: { deny: [...] }, acquiredAt, expiresAt, renewals, reason? }
// - TTL 20 分钟；持有者每完成一个集成动作（门禁结果、合入）调用 renew 续租。
// - 过期后：持有者已退出 / 无子进程且 main 一个 TTL 内无新提交 → 自动释放并记 incident；
//   有子进程或 main 仍在前进 → 宽限 BUSY_GRACE，超过即强制释放并上报（不杀持有者进程，只收回锁）。
// - 旧格式（文件内容是纯 pid）：按 10 分钟 TTL（自文件修改时间起算）处理，每个 pid 告警一次。
// - scope.deny：只拒绝匹配的 lane / 提交血缘，不是全局停。锁被收回时 deny 转存到 integrate.holds.json 继续生效，
//   保护意图不随锁丢失；集成器对 holds 与当前锁的 deny 一并过滤候选。
//
// 所有函数接受 runs 目录与可注入的 probe/now，供 s0-selftest 在临时目录中验证。
import fs from 'node:fs';
import { writeFileAtomic } from './atomic-write.mjs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const TTL_MS = 20 * 60_000;
export const LEGACY_TTL_MS = 10 * 60_000;
export const BUSY_GRACE_MS = 40 * 60_000;

export const lockFile = (runs) => path.join(runs, 'integrate.lock');
export const holdsFile = (runs) => path.join(runs, 'integrate.holds.json');
const sweepStateFile = (runs) => path.join(runs, 'integrate.lease-state.json');
const iso = (ms) => new Date(ms).toISOString();

export function appendIncident(runs, rec, nowMs = Date.now()) {
  fs.appendFileSync(path.join(runs, 'incidents.jsonl'), `${JSON.stringify({ t: iso(nowMs), ...rec })}\n`);
}

const readJson = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};

/** 读锁：null（无锁）| { legacy, invalid, pid, owner, scope, acquiredAt, expiresAt, renewals, raw } */
export function readLock(runs) {
  let raw;
  let st;
  try {
    raw = fs.readFileSync(lockFile(runs), 'utf8');
    st = fs.statSync(lockFile(runs));
  } catch {
    return null;
  }
  const t = raw.trim();
  if (/^\d+$/.test(t)) {
    const at = st.mtimeMs;
    return { legacy: true, pid: Number(t), owner: 'legacy', scope: { deny: [] }, acquiredAt: iso(at), expiresAt: iso(at + LEGACY_TTL_MS), renewals: 0, raw };
  }
  try {
    const j = JSON.parse(t);
    if (!Number.isInteger(j.pid)) throw new Error('pid');
    return { legacy: false, renewals: 0, ...j, scope: { deny: Array.isArray(j.scope?.deny) ? j.scope.deny : [] }, raw };
  } catch {
    // 正在写入（空文件）或损坏：按修改时间 + 旧 TTL 判断，避免把半写状态当成无锁
    return { invalid: true, pid: 0, owner: '?', scope: { deny: [] }, acquiredAt: iso(st.mtimeMs), expiresAt: iso(st.mtimeMs + LEGACY_TTL_MS), renewals: 0, raw };
  }
}

/** 默认探针：进程存活、子进程数、main 最近一次更新时间（reflog，取不到时用提交时间）。 */
export function defaultProbe(root) {
  return {
    alive(pid) {
      if (!pid) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return e.code === 'EPERM';
      }
    },
    children(pid) {
      try {
        return fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).length;
      } catch {
        return 0;
      }
    },
    mainUpdatedAt() {
      const g = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      try {
        const s = g('reflog', '-1', '--date=unix', '--format=%gd', 'refs/heads/main');
        const m = /\{(\d+)\}/.exec(s);
        if (m) return Number(m[1]) * 1000;
      } catch {
        // 没有 reflog
      }
      try {
        return Number(g('log', '-1', '--format=%ct', 'main')) * 1000;
      } catch {
        return 0;
      }
    },
  };
}

function writeExclusive(file, body) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, body);
  try {
    fs.linkSync(tmp, file); // 原子：已存在则失败，读者永远看不到半写的锁
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * 判定当前锁状态：
 * free | held | dead | invalid | expired-idle | expired-busy | expired-overdue
 * 只有 dead / invalid（已过期） / expired-idle / expired-overdue 可被收回。
 */
export function assess(runs, { probe, nowMs = Date.now() } = {}) {
  const lock = readLock(runs);
  if (!lock) return { state: 'free', lock: null };
  const exp = Date.parse(lock.expiresAt) || 0;
  if (lock.invalid) return { state: nowMs > exp ? 'invalid' : 'held', lock };
  if (!probe.alive(lock.pid)) return { state: 'dead', lock };
  if (nowMs <= exp) return { state: 'held', lock };
  const children = probe.children(lock.pid);
  const ttl = lock.legacy ? LEGACY_TTL_MS : TTL_MS;
  const mainAt = probe.mainUpdatedAt();
  const mainRecent = mainAt > nowMs - ttl;
  const facts = { children, mainUpdatedAt: mainAt ? iso(mainAt) : null, overdueMs: nowMs - exp };
  if (nowMs - exp > BUSY_GRACE_MS) return { state: 'expired-overdue', lock, ...facts };
  if (children > 0 || mainRecent) return { state: 'expired-busy', lock, ...facts };
  return { state: 'expired-idle', lock, ...facts };
}

/**
 * 收回锁：先改名到一边再核对内容，若期间持有者续租（内容已变）则放回，不误删新租约。
 * deny 作用域转存到 holds，保护意图继续生效。返回是否收回。
 */
export function reap(runs, expected, why, { nowMs = Date.now(), facts = {} } = {}) {
  const file = lockFile(runs);
  const aside = `${file}.reaping.${process.pid}`;
  try {
    fs.renameSync(file, aside);
  } catch {
    return false;
  }
  const got = fs.readFileSync(aside, 'utf8');
  if (expected && got !== expected.raw) {
    try {
      fs.linkSync(aside, file);
    } catch {
      // 期间已有新持有者：不覆盖
    }
    fs.rmSync(aside, { force: true });
    return false;
  }
  fs.rmSync(aside, { force: true });
  const deny = expected?.scope?.deny ?? [];
  if (deny.length) addHold(runs, { deny, owner: expected.owner, reason: `锁被收回（${why}）后保留其作用域：${expected.reason ?? ''}`.trim(), from: 'lease-reap' }, nowMs);
  appendIncident(runs, { kind: 'lock-released', by: 'lease', why, holder: { pid: expected?.pid, owner: expected?.owner, legacy: Boolean(expected?.legacy), acquiredAt: expected?.acquiredAt, expiresAt: expected?.expiresAt, renewals: expected?.renewals }, carriedDeny: deny, ...facts }, nowMs);
  return true;
}

/**
 * 申请租约。持有中返回 { ok:false, holder }；可收回（dead/过期空闲等）的先收回再取。
 * opts：{ pid, owner, deny, reason, ttlMs, probe, nowMs }
 */
export function acquire(runs, opts) {
  const { pid = process.pid, owner, deny = [], reason, ttlMs = TTL_MS, probe, nowMs = Date.now() } = opts;
  fs.mkdirSync(runs, { recursive: true });
  const body = () => JSON.stringify({ pid, owner, scope: { deny }, acquiredAt: iso(nowMs), expiresAt: iso(nowMs + ttlMs), renewals: 0, ...(reason ? { reason } : {}) });
  for (let i = 0; i < 3; i++) {
    if (writeExclusive(lockFile(runs), body())) return { ok: true };
    const a = assess(runs, { probe, nowMs });
    if (a.state === 'free') continue;
    if (['dead', 'invalid', 'expired-idle', 'expired-overdue'].includes(a.state)) {
      reap(runs, a.lock, `${a.state}（申请方 ${owner}）`, { nowMs, facts: pick(a) });
      continue;
    }
    return { ok: false, holder: a.lock, state: a.state };
  }
  return { ok: false, holder: readLock(runs), state: 'contended' };
}

const pick = (a) => ({ children: a.children, mainUpdatedAt: a.mainUpdatedAt, overdueMs: a.overdueMs });

/** 续租：只有持有者本人能续；锁已不属于自己返回 false（调用方应停止写 main）。 */
export function renew(runs, { pid = process.pid, ttlMs = TTL_MS, nowMs = Date.now() } = {}) {
  const lock = readLock(runs);
  if (!lock || lock.legacy || lock.invalid || lock.pid !== pid) return false;
  const { raw, legacy, invalid, ...rest } = lock;
  const next = JSON.stringify({ ...rest, expiresAt: iso(nowMs + ttlMs), renewals: (lock.renewals ?? 0) + 1 });
  const tmp = `${lockFile(runs)}.${pid}.renew`;
  fs.writeFileSync(tmp, next);
  // 再核对一次：期间被收回则不复活
  const again = readLock(runs);
  if (!again || again.raw !== raw) {
    fs.rmSync(tmp, { force: true });
    return false;
  }
  fs.renameSync(tmp, lockFile(runs));
  return true;
}

/**
 * 门禁子进程在跑期间的续租心跳。单次门禁可以超过 TTL：05:11–05:41Z 那次整体复核跑了 30 分钟（tests 15 分钟加一次重跑），
 * 期间没有续租，05:31Z 租约过期，被记为 lock-expired-busy，再过 40 分钟就会从活着的持有者手里强制收回。
 * 心跳只在 start() 和 stop() 之间工作（即门禁子进程存活期间）。门禁本身有单项 15 分钟超时，所以心跳不会无限续租；
 * 空闲持有者照样按 TTL 过期。续租失败（锁已被收回或改写）→ 调用 onLost，由调用方停止门禁、不写 main。
 */
export function keepAlive(runs, { pid = process.pid, everyMs = 5 * 60_000, onLost = () => {}, renewFn = renew } = {}) {
  let timer = null;
  const tick = () => {
    if (!renewFn(runs, { pid })) {
      stop();
      onLost();
    }
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  return {
    start() {
      if (!timer) timer = setInterval(tick, everyMs);
      return this;
    },
    stop,
    tick,
    get running() {
      return Boolean(timer);
    },
  };
}

export function holds(runs, { pid = process.pid } = {}) {
  const lock = readLock(runs);
  return Boolean(lock && !lock.invalid && lock.pid === pid);
}

export function release(runs, { pid = process.pid } = {}) {
  const lock = readLock(runs);
  if (!lock || lock.pid !== pid) return false;
  fs.rmSync(lockFile(runs), { force: true });
  return true;
}

/**
 * 守护进程每轮调用：收回可收回的锁、对旧格式与"过期但忙"各告警一次。
 * 返回 { state, released, escalate? }。escalate 由调用方写 escalations（守护进程统一转发）。
 */
export function sweep(runs, { probe, nowMs = Date.now() } = {}) {
  const a = assess(runs, { probe, nowMs });
  const st = readJson(sweepStateFile(runs), {});
  const key = a.lock ? `${a.lock.pid}@${a.lock.acquiredAt}` : '';
  const out = { state: a.state, released: false, lock: a.lock };
  if (a.lock?.legacy && st.legacyWarned !== key) {
    appendIncident(runs, { kind: 'lock-legacy', pid: a.lock.pid, note: '旧格式锁（纯 pid），按 10 分钟 TTL 处理；请改用 lease 申请' }, nowMs);
    st.legacyWarned = key;
  }
  if (a.state === 'expired-busy' && st.busyWarned !== key) {
    appendIncident(runs, { kind: 'lock-expired-busy', pid: a.lock.pid, owner: a.lock.owner, ...pick(a), note: `租约已过期但持有者仍在工作，${Math.round(BUSY_GRACE_MS / 60000)} 分钟宽限后强制收回` }, nowMs);
    st.busyWarned = key;
  }
  if (['dead', 'invalid', 'expired-idle', 'expired-overdue'].includes(a.state)) {
    out.released = reap(runs, a.lock, a.state, { nowMs, facts: pick(a) });
    if (out.released && a.state === 'expired-overdue') {
      out.escalate = `【集成锁强制收回】pid ${a.lock.pid}（${a.lock.owner}）租约过期 ${Math.round(a.overdueMs / 60000)} 分钟仍未释放（子进程 ${a.children}），已收回锁（未结束该进程）。作用域 deny ${JSON.stringify(a.lock.scope.deny)} 已转存 integrate.holds.json。`;
    }
  }
  writeFileAtomic(sweepStateFile(runs), JSON.stringify(st));
  return out;
}

// ---- 作用域（血缘否定）----

export function loadHolds(runs) {
  const h = readJson(holdsFile(runs), []);
  return Array.isArray(h) ? h : [];
}
export function addHold(runs, { deny, owner, reason, from }, nowMs = Date.now()) {
  const list = loadHolds(runs);
  const id = `H-${iso(nowMs).replace(/[-:.TZ]/g, '').slice(0, 14)}-${list.length + 1}`;
  list.push({ id, deny, owner, reason, from, at: iso(nowMs) });
  fs.writeFileSync(`${holdsFile(runs)}.tmp`, JSON.stringify(list, null, 1));
  fs.renameSync(`${holdsFile(runs)}.tmp`, holdsFile(runs));
  appendIncident(runs, { kind: 'hold-added', id, deny, owner, reason, from }, nowMs);
  return id;
}
export function removeHold(runs, id, nowMs = Date.now()) {
  const list = loadHolds(runs);
  const next = list.filter((h) => h.id !== id);
  if (next.length === list.length) return false;
  fs.writeFileSync(`${holdsFile(runs)}.tmp`, JSON.stringify(next, null, 1));
  fs.renameSync(`${holdsFile(runs)}.tmp`, holdsFile(runs));
  appendIncident(runs, { kind: 'hold-removed', id }, nowMs);
  return true;
}

/** 生效的拒绝规则：holds + 当前锁（非自己持有时）的 deny。 */
export function effectiveDeny(runs, { selfPid = process.pid } = {}) {
  const rules = loadHolds(runs).flatMap((h) => h.deny.map((d) => ({ rule: d, by: `${h.id}（${h.owner}）` })));
  const lock = readLock(runs);
  if (lock && lock.pid !== selfPid) rules.push(...lock.scope.deny.map((d) => ({ rule: d, by: `锁持有者 ${lock.owner}/${lock.pid}` })));
  return rules;
}

/**
 * 解析规则："L17-memory-research" / "L17*"（lane 名或通配）、"051c4cb73"（提交及其后代）、
 * "L17/051c4cb73"（同上，lane 只作说明）、显式前缀 "lane:" / "commit:"。
 */
export function parseRule(rule) {
  const r = String(rule).trim();
  if (r.startsWith('lane:')) return { lane: r.slice(5) };
  if (r.startsWith('commit:')) return { commit: r.slice(7) };
  const m = /^([^/]+)\/([0-9a-f]{7,40})$/.exec(r);
  if (m) return { lane: m[1], commit: m[2], lineage: true };
  if (/^[0-9a-f]{7,40}$/.test(r)) return { commit: r };
  return { lane: r };
}
const laneMatch = (pat, lane) => {
  if (pat.includes('*')) return new RegExp(`^${pat.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(lane);
  return lane === pat || lane.startsWith(`${pat}-`);
};

/**
 * 候选 (lane, ref) 是否被拒：返回命中的规则说明或 null。
 * 提交规则 = 该提交及其所有后代（git merge-base --is-ancestor）；已在 main 里的提交规则视为失效（否则会拒绝一切）。
 */
export function deniedBy(rules, { lane, ref, isAncestor }) {
  for (const { rule, by } of rules) {
    const p = parseRule(rule);
    if (p.commit) {
      if (isAncestor(p.commit, 'main')) continue;
      if (isAncestor(p.commit, ref)) return `${rule}（${by}）`;
      continue;
    }
    if (p.lane && laneMatch(p.lane, lane)) return `${rule}（${by}）`;
  }
  return null;
}
