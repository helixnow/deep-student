/**
 * 分析 cdp-drag-trace.mjs 抓取的 Chromium trace，聚合 style/layout 失效来源：
 * - 主要耗时事件（UpdateLayoutTree / Layout / Paint / FunctionCall...）总量与最大单次
 * - 超过 8ms 的样式重算及其波及元素数（elementCount）
 * - 四类 invalidationTracking 事件按"节点 | 原因 | 选择器"聚合排序
 *
 * 用法：node scripts/cdp-trace-analyze.mjs [trace文件=.tmp/cdp-drag-trace.json]
 *
 * 排查案例（2026-07）：拖拽窗口每帧 36-52ms 样式重算，本工具定位到
 * CrepeEditor.css 的 `svg[style] *` 选择器——Blink 失效集按属性名建键，
 * 任何元素改 inline style 都命中"[style] 后代全失效"，整棵窗口子树每帧重算。
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? '.tmp/cdp-drag-trace.json';
const { traceEvents } = JSON.parse(readFileSync(file, 'utf8'));
console.log(`总事件数: ${traceEvents.length}`);

const byName = new Map();
for (const e of traceEvents) {
  if (!byName.has(e.name)) byName.set(e.name, []);
  byName.get(e.name).push(e);
}

function sumDur(list) {
  return list.reduce((s, e) => s + (e.dur ?? 0), 0) / 1000;
}

console.log('\n=== 主要耗时事件（总时长 ms / 次数 / 最大单次 ms）===');
for (const name of ['UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint', 'HitTest', 'FunctionCall', 'EventDispatch', 'Commit', 'UpdateLayerTree']) {
  const list = byName.get(name) ?? [];
  if (!list.length) continue;
  const max = Math.max(...list.map((e) => e.dur ?? 0)) / 1000;
  console.log(`${name.padEnd(18)} total=${sumDur(list).toFixed(1)}ms  n=${list.length}  max=${max.toFixed(2)}ms`);
}

// UpdateLayoutTree 慢帧统计
const ult = (byName.get('UpdateLayoutTree') ?? []).filter((e) => (e.dur ?? 0) > 8000);
console.log(`\n=== UpdateLayoutTree > 8ms 的事件: ${ult.length} 个 ===`);
for (const e of ult.slice(0, 10)) {
  console.log(`  dur=${(e.dur / 1000).toFixed(1)}ms elementCount=${e.args?.elementCount ?? e.args?.beginData?.dirtyObjects ?? '?'} frame=${e.args?.beginData?.frame ?? ''}`);
}

// 失效追踪事件聚合
console.log('\n=== 失效追踪 (invalidationTracking) ===');
for (const name of ['ScheduleStyleInvalidationTracking', 'StyleRecalcInvalidationTracking', 'StyleInvalidatorInvalidationTracking', 'LayoutInvalidationTracking']) {
  const list = byName.get(name) ?? [];
  console.log(`\n--- ${name}: ${list.length} 条 ---`);
  const agg = new Map();
  for (const e of list) {
    const d = e.args?.data ?? {};
    const key = [d.nodeName ?? '?', d.reason ?? '?', d.extraData ?? '', (d.selectorPart ?? '')].join(' | ');
    agg.set(key, (agg.get(key) ?? 0) + 1);
  }
  const top = [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  for (const [k, n] of top) console.log(`  ${String(n).padStart(6)}x  ${k}`);
}

// Layout 事件的 dirty 根节点
const layouts = (byName.get('Layout') ?? []).filter((e) => (e.dur ?? 0) > 4000);
console.log(`\n=== Layout > 4ms: ${layouts.length} 个，根节点统计 ===`);
const rootAgg = new Map();
for (const e of layouts) {
  const roots = e.args?.beginData?.dirtyObjects;
  const nodes = e.args?.endData?.layoutRoots?.map((r) => r.nodeId).join(',');
  const key = `dirty=${roots ?? '?'} partial=${e.args?.beginData?.partialLayout ?? '?'}`;
  rootAgg.set(key, (rootAgg.get(key) ?? 0) + 1);
}
for (const [k, n] of [...rootAgg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${n}x ${k}`);
}
