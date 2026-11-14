// 集成轮次的全局性故障判定（熔断）：门禁工具自身故障、或大量 lane 因同一原因失败时，判为工具/环境故障，
// 守护进程据此不给 lane 发门禁反馈、撤销本轮记下的失败记录，并上报架构师——避免一次工具故障扩散成几十条错误反馈。

/** 从集成日志中解析候选数与每条失败 lane 的首行失败原因。 */
export function parseIntegrateLog(out) {
  const lines = String(out).split('\n');
  const candidates = Number((/候选 (\d+)/.exec(out) ?? [])[1] ?? 0);
  const failures = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\S+): 未合入（门禁未过：\s*$/.exec(lines[i]);
    if (!m) continue;
    const first = (lines[i + 1] ?? '').trim();
    failures.push({ lane: m[1], reason: first });
  }
  return { candidates, failures };
}

/** 去掉原因中随 lane 变化的部分（耗时、临时目录、作业号），便于判断"是不是同一个原因"。 */
const normalize = (r) => r.replace(/\d+(\.\d+)?\s*ms/g, '<ms>').replace(/_integration-p\d+/g, '<wt>').replace(/\d{14}-[0-9a-f]{6}/g, '<job>').slice(0, 200);

/**
 * 返回 null（正常）或故障说明 { kind, reason, lanes }。
 * - tool：≥3 条 lane 的失败原因是门禁执行器自身报错（gate-runner: 开头，说明检查根本没跑起来）；
 * - uniform：候选 ≥10、失败率 ≥80%，且 ≥80% 的失败原因完全相同。
 */
export function detectSystemicFault(out) {
  const { candidates, failures } = parseIntegrateLog(out);
  const tool = failures.filter((f) => /^gate-runner: /.test(f.reason));
  if (tool.length >= 3) return { kind: 'tool', reason: tool[0].reason.slice(0, 300), lanes: failures.map((f) => f.lane) };
  if (candidates >= 10 && failures.length >= candidates * 0.8) {
    const counts = new Map();
    for (const f of failures) counts.set(normalize(f.reason), (counts.get(normalize(f.reason)) ?? 0) + 1);
    const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
    if (n >= failures.length * 0.8) return { kind: 'uniform', reason: top, lanes: failures.map((f) => f.lane) };
  }
  return null;
}
