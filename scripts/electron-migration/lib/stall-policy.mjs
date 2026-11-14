// 卡住后的动作策略（stall-watch 调用）。实测 11-04~06：1215 段卡住里 44 段超过 10 分钟，只有 3 段在恢复前有人干预；
// 最长一段 R6 卡了 18.3 小时。检测早就有（90 秒），缺的是检测到之后的动作。
// 规则：执行者 lane 连续卡住达到阈值 → 在原会话重启一次（与协调者手动 coord.mjs restart 相同）；
// 同一 lane 3 小时内最多自动重启 2 次，之后只通知它的协调者一次，不再自动处理（模型/会话本身有问题，要人换会话或换模型）。
// 协调者不在此处理（守护进程有单轮超时看门狗）；派发暂停或 lane 停放时不动作。
import { holdReason } from './ops-intent.mjs';
import { dispatcherRunning } from './repair-actions.mjs';

export const WINDOW_MS = 3 * 3_600_000;
export const MAX_AUTO_RESTARTS = 2;

/**
 * @param o { forMs, autoRestartMs, restartedThisEpisode, escalatedThisEpisode, recentRestarts: [ms], nowMs, coordinator, parked, dispatchPaused }
 * @returns { action: 'none' | 'restart' | 'escalate', why }
 */
export function decide(o) {
  if (!o.autoRestartMs) return { action: 'none', why: '未启用（--auto-restart-min 0）' };
  if (o.coordinator) return { action: 'none', why: '协调者由守护进程单轮超时处理' };
  if (o.parked) return { action: 'none', why: 'lane 已停放' };
  if (o.forMs < o.autoRestartMs) return { action: 'none', why: '未到阈值' };
  if (o.dispatchPaused) return { action: 'none', why: '派发已暂停' };
  if (o.held) return { action: 'none', why: `有意停住：${o.held}` };
  if (o.schedulerDown) return { action: 'none', why: '调度守护进程未运行，重启请求无人送达' };
  if (o.unattributedBusy) return { action: 'none', why: `有 ${o.unattributedBusy} 个工具进程无法归属到 lane（工作目录不在任何 lane 工作树内），可能就是这个 lane 的长任务` };
  if (o.restartedThisEpisode) return { action: 'none', why: '本段已重启过' };
  const recent = (o.recentRestarts ?? []).filter((t) => o.nowMs - t < WINDOW_MS);
  if (recent.length >= MAX_AUTO_RESTARTS) return o.escalatedThisEpisode ? { action: 'none', why: '已通知协调者' } : { action: 'escalate', why: `3 小时内已自动重启 ${recent.length} 次仍卡住` };
  return { action: 'restart', why: `连续 ${Math.round(o.forMs / 60_000)} 分钟无模型返回且无工具进程` };
}

const OPENCODE_CLIENT = /^opencode run\b|^\/bin\/sh -c trap "" HUP; opencode/;
// opencode 的快照 git 进程是服务端在模型步骤之间做的，不代表工具在跑
const OPENCODE_SNAPSHOT = /--git-dir \S*\/opencode\/snapshot\//;
const OPENCODE_SERVE = /(^|\/)opencode(\s.*)?\sserve\b/;

/**
 * 工具进程归属。工具由 opencode serve 执行（不是 lane 的 opencode run 客户端），只能按目录线索归属到 lane。
 * 依次看：自身工作目录、到 serve 为止各祖先的工作目录、环境里的 OLDPWD、命令行里出现的工作树路径
 * （cd 到主仓库跑的长测试，其外层 shell 或 OLDPWD 通常仍指向 lane 工作树）。归属到的 lane 视为忙；
 * serve 的后代里一条线索都没有的计入 unattributedProcs。
 * @param procs [{ pid, ppid, cwd, cmd, oldpwd? }]（cwd 已 realpath）
 */
export function attributeBusy({ procs, worktrees }) {
  const perWorktree = new Map(worktrees.map((w) => [w, 0]));
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const children = new Map();
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  const underServe = new Set();
  const stack = procs.filter((p) => OPENCODE_SERVE.test(p.cmd));
  while (stack.length) {
    for (const c of children.get(stack.pop().pid) ?? []) {
      if (underServe.has(c.pid)) continue;
      underServe.add(c.pid);
      stack.push(c);
    }
  }
  const inside = (dir) => (dir ? worktrees.find((w) => dir === w || dir.startsWith(`${w}/`)) : undefined);
  const mentioned = (cmd) => worktrees.find((w) => new RegExp(`(^|[\\s=:'"])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/|\\s|$|['"])`).test(cmd ?? ''));
  const laneOf = (p) => {
    for (let q = p, hops = 0; q && hops < 64 && !OPENCODE_SERVE.test(q.cmd); q = byPid.get(q.ppid), hops++) {
      const wt = inside(q.cwd);
      if (wt) return wt;
    }
    return inside(p.oldpwd) ?? mentioned(p.cmd);
  };
  const unattributedProcs = [];
  for (const p of procs) {
    if (OPENCODE_CLIENT.test(p.cmd) || OPENCODE_SNAPSHOT.test(p.cmd) || OPENCODE_SERVE.test(p.cmd)) continue;
    const own = inside(p.cwd);
    const wt = own ?? (underServe.has(p.pid) ? laneOf(p) : undefined);
    if (wt) perWorktree.set(wt, perWorktree.get(wt) + 1);
    else if (underServe.has(p.pid)) unattributedProcs.push(p);
  }
  return { perWorktree, unattributed: unattributedProcs.length, unattributedProcs };
}

export const UNATTRIBUTED_CAP_MS = 30 * 60_000;

/**
 * 无法归属的工具进程推迟自动重启，但每个进程只推迟 capMs（自首次看到起）；之后恢复正常判断，
 * 否则一个跑飞的后台进程会让全部 lane 永远不被自动重启。seen 以 pid+启动时刻为键，进程退出即遗忘。
 */
export function unattributedDeferral({ procs, seen = {}, nowMs, capMs = UNATTRIBUTED_CAP_MS }) {
  const next = {};
  let active = 0;
  for (const p of procs) {
    const key = `${p.pid}:${p.start ?? p.cmd}`;
    next[key] = seen[key] ?? nowMs;
    if (nowMs - next[key] < capMs) active++;
  }
  return { active, seen: next };
}

export const RESTART_MAIL_TTL_MS = 15 * 60_000;

/** 自动重启请求带过期时间：调度停着时排进信箱的重启，几小时后恢复调度再送达只会打断已经恢复的 lane。 */
export function restartItem(item, nowMs) {
  return { ...item, action: 'restart', expiresAt: new Date(nowMs + RESTART_MAIL_TTL_MS).toISOString() };
}

export function inboxExpired(item, nowMs) {
  const t = Date.parse(item?.expiresAt ?? '');
  return Number.isFinite(t) && nowMs > t;
}

/** 本轮能否发自动重启：维护/hold 时、调度守护进程没在运行时都不能。 */
export function actionEnv({ runs, opsDir, nowMs, procOpts }) {
  return {
    held: holdReason({ runs, opsDir, unit: 'ds-stall-watch' }),
    schedulerDown: !dispatcherRunning({ runs, now: nowMs, procOpts }),
  };
}
