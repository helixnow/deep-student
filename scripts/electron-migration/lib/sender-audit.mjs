// 信箱发送方审计：coord 的 queue / restart / assign 只凭自报的 --from 标明来源，无法区分冒名。
// 这里记下调用方的 pid、ppid、工作目录和 opencode 会话，并按工作目录反查实际所在 lane。
// 只审计，不拦截：自报来源与工作目录所属 lane 不一致时，在 inbox-audit.jsonl 标 mismatch，并记 incident kind=sender-mismatch。
import fs from 'node:fs';
import path from 'node:path';
import * as lease from './integrate-lease.mjs';

/** 工作目录所在的 lane（取工作树路径最长的匹配；不在任何 lane 工作树内 → null）。 */
export function laneOfCwd(sessions, cwd) {
  const real = path.resolve(cwd);
  let best = null;
  for (const [lane, s] of Object.entries(sessions ?? {})) {
    if (lane.startsWith('__') || !s?.worktree) continue;
    const wt = path.resolve(s.worktree);
    if ((real === wt || real.startsWith(`${wt}${path.sep}`)) && (!best || wt.length > best.wt.length)) best = { lane, wt };
  }
  return best?.lane ?? null;
}

export function senderInfo(sessions, { from, pid = process.pid, ppid = process.ppid, cwd = process.cwd(), sessionId = process.env.OPENCODE_SESSION_ID ?? null } = {}) {
  const cwdLane = laneOfCwd(sessions, cwd);
  return { from, pid, ppid, cwd, sessionId, cwdLane, mismatch: Boolean(cwdLane && from && cwdLane !== from) };
}

/** 追加审计行；不一致时另记 incident。返回 sender 信息供写入信箱条目。 */
export function recordSend(runs, sessions, { action, to, file, ...who }, nowMs = Date.now()) {
  const sender = senderInfo(sessions, who);
  fs.appendFileSync(path.join(runs, 'inbox-audit.jsonl'), `${JSON.stringify({ t: new Date(nowMs).toISOString(), action, to, file: file ? path.basename(file) : null, ...sender })}\n`);
  if (sender.mismatch) lease.appendIncident(runs, { kind: 'sender-mismatch', action, to, ...sender }, nowMs);
  return sender;
}
