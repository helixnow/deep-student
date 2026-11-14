// lane 归属：与 scripts/electron-migration/inventory.mjs 完全一致。
// inventory.mjs 在模块顶层执行盘点并写文件，不能 import；这里从其源码中取出
// `LANE_RULES`、`COMMAND_NAME_RULES` 与 `NAME_ROUTED_FILES` 的字面量求值，保证单一来源。
import type { SourceTree } from './source.ts';

export interface LaneRules {
  laneRules: [string, RegExp][];
  nameRules: [string, RegExp][];
  nameRouted: Set<string>;
}

function literalAfter(src: string, marker: string, open: string, close: string): string {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`inventory.mjs 中找不到 ${marker}`);
  const start = src.indexOf(open, at + marker.length);
  let depth = 0;
  let inRe = false;
  let inClass = false;
  let inStr: string | null = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i]!;
    if (inStr) { if (c === '\\') { i++; continue; } if (c === inStr) inStr = null; continue; }
    if (inRe) {
      if (c === '\\') { i++; continue; }
      if (inClass) { if (c === ']') inClass = false; continue; }
      if (c === '[') { inClass = true; continue; }
      if (c === '/') inRe = false;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
    if (c === '/' && /[,[(\s]/.test(src[i - 1] ?? '')) { inRe = true; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (!depth) return src.slice(start, i + 1); }
  }
  throw new Error(`inventory.mjs 中 ${marker} 未闭合`);
}

export function loadLaneRules(tree: SourceTree): LaneRules {
  const src = tree.read('scripts/electron-migration/inventory.mjs');
  const ev = (lit: string): unknown => new Function(`return ${lit};`)();
  return {
    laneRules: ev(literalAfter(src, 'export const LANE_RULES =', '[', ']')) as [string, RegExp][],
    nameRules: ev(literalAfter(src, 'export const COMMAND_NAME_RULES =', '[', ']')) as [string, RegExp][],
    nameRouted: ev(literalAfter(src, 'const NAME_ROUTED_FILES =', '(', ')').replace(/^\(/, 'new Set(')) as Set<string>,
  };
}

export function laneOfFile(rules: LaneRules, file: string): string | null {
  for (const [lane, re] of rules.laneRules) if (re.test(file)) return lane;
  return null;
}

/** inventory 对命令的归属：先按文件，再对 NAME_ROUTED_FILES 按命令名分派。 */
export function laneOfCommand(rules: LaneRules, file: string, name: string): string {
  const fileLane = laneOfFile(rules, file);
  if (rules.nameRouted.has(file)) return rules.nameRules.find(([, r]) => r.test(name))?.[0] ?? 'UNROUTED';
  return fileLane ?? 'UNASSIGNED';
}
