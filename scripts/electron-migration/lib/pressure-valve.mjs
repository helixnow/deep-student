// 压力阀（S0 G4）：已过自检、待集成的候选积压过多且长时间没有合入时，自动暂停派发并要求 C1 先清积压。
// - 积压 = 非协调者 lane 中：分支领先 main、自检通过且自检提交就是当前分支头、未被作用域 hold 拒绝。
//   以 git + selfgate 为准，不读看板（看板状态靠人维护，会滞后）。
// - 暂停条件：积压 > PAUSE_ABOVE 且 main 已 STALL_MIN 分钟没有前进（人工 resume 之后同样给 STALL_MIN 宽限，避免立刻再停）。
// - 恢复条件：积压 ≤ RESUME_AT_OR_BELOW（只自动恢复由压力阀自己暂停的；人工暂停只能人工恢复），或人工 resume-dispatch。
import fs from 'node:fs';
import path from 'node:path';
import * as control from './orch-control.mjs';
import { deniedBy, effectiveDeny } from './integrate-lease.mjs';

export const PAUSE_ABOVE = 15;
export const RESUME_AT_OR_BELOW = 8;
export const STALL_MIN = 30;

/** 纯决策。返回 'pause' | 'resume' | 'none'。 */
export function decide({ backlog, lastMergeAt, lastResumeAt = 0, paused, nowMs = Date.now() }) {
  if (paused) return paused.auto && backlog <= RESUME_AT_OR_BELOW ? 'resume' : 'none';
  const quietSince = Math.max(lastMergeAt || 0, lastResumeAt || 0);
  return backlog > PAUSE_ABOVE && nowMs - quietSince >= STALL_MIN * 60_000 ? 'pause' : 'none';
}

/** 计算积压（守护进程用；git 为注入函数，便于自证）。 */
export function backlog({ runs, sessions, git, isAncestor }) {
  const rules = effectiveDeny(runs, { selfPid: -1 });
  const lanes = [];
  for (const [lane, s] of Object.entries(sessions)) {
    if (lane.startsWith('__') || s.coordinator || !s.branch) continue;
    let sg;
    try {
      sg = JSON.parse(fs.readFileSync(path.join(runs, 'selfgate', `${lane}.json`), 'utf8'));
    } catch {
      continue;
    }
    if (!sg?.ok) continue;
    let tip;
    try {
      tip = git('rev-parse', s.branch);
    } catch {
      continue;
    }
    if (sg.tip !== tip || isAncestor(tip, 'main')) continue;
    if (rules.length && deniedBy(rules, { lane, ref: tip, isAncestor })) continue;
    lanes.push(lane);
  }
  return lanes;
}

/**
 * 一次评估并执行：暂停时给 C1 发硬指令（notify），恢复时记审计。返回 { action, backlog }。
 * notify(lane, body) 由调用方提供（守护进程里经 coord queue 投递）。
 */
export function evaluate({ runs, lanes, lastMergeAt, nowMs = Date.now(), notify = () => {} }) {
  const paused = control.dispatchPaused(runs);
  const lastResumeAt = Date.parse(control.lastResume(runs)?.at ?? '') || 0;
  const action = decide({ backlog: lanes.length, lastMergeAt, lastResumeAt, paused, nowMs });
  const mins = Math.round((nowMs - Math.max(lastMergeAt || 0, lastResumeAt)) / 60_000);
  if (action === 'pause') {
    const reason = `压力阀：待集成候选 ${lanes.length} 条（> ${PAUSE_ABOVE}），main ${mins} 分钟无合入`;
    control.pauseDispatch(runs, { by: 'pressure-valve', reason, auto: true, nowMs });
    const body = `【压力阀：派发已自动暂停】${reason}。
在跑的 lane 不受影响；守护进程不再启动、续派、恢复执行者，直到积压 ≤ ${RESUME_AT_OR_BELOW} 自动恢复（或用户 coord resume-dispatch）。
硬指令：先清积压，不派新工作包。和 C2 一起让这些候选进 main（coord integrate --lanes … 排指定批次），或明确拒收：
${lanes.join(', ')}`;
    try {
      notify('C1-app', body);
    } catch (e) {
      control.audit(runs, { cmd: 'notify-failed', target: 'C1-app', error: String(e.message).split('\n')[0] }, nowMs);
    }
  } else if (action === 'resume') {
    control.resumeDispatch(runs, { by: 'pressure-valve', reason: `积压降到 ${lanes.length}（≤ ${RESUME_AT_OR_BELOW}）`, auto: true, nowMs });
  }
  return { action, backlog: lanes.length };
}
