// 自动集成的批次排序与上限：自检通过的优先；同为自检通过时，被暂缓得最久的优先。
// 只按会话表顺序截断会让排在后面的 lane 永远进不了批次（2026-11-06 03:16–03:46Z，S0 连续 3 轮被暂缓），
// 所以暂缓记录跨轮保存（.oc-runs/integrate.deferred.json：lane → 首次被暂缓的时间）。
import fs from 'node:fs';
import path from 'node:path';

export const deferredFile = (runs) => path.join(runs, 'integrate.deferred.json');

export function loadDeferred(runs) {
  try {
    return JSON.parse(fs.readFileSync(deferredFile(runs), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * todo：[{ lane, selfGated }]（会话表顺序）；deferred：{ lane: iso }；max ≤ 0 表示不设上限。
 * 返回 { batch, held, deferred }，deferred 为下一轮应保存的暂缓记录（只含本轮被暂缓的 lane）。
 */
export function orderBatch(todo, deferred, max, nowIso = new Date().toISOString()) {
  const since = (t) => (deferred[t.lane] ? Date.parse(deferred[t.lane]) : Infinity);
  const ranked = todo
    .map((t, i) => ({ t, i }))
    .sort((a, b) => Number(b.t.selfGated) - Number(a.t.selfGated) || since(a.t) - since(b.t) || a.i - b.i)
    .map((x) => x.t);
  const batch = max > 0 ? ranked.slice(0, max) : ranked;
  const held = max > 0 ? ranked.slice(max) : [];
  const next = {};
  for (const t of held) next[t.lane] = deferred[t.lane] ?? nowIso;
  return { batch, held, deferred: next };
}
