/**
 * 资源类型手写分派盘点（W37）。
 *
 * 统计两类"以后必须查表"的位置：
 * - `switch`：任一 `case` 是官方资源类型字面量的 switch；
 * - `map`：对象字面量里连续 3 个以上官方资源类型 key 的映射表。
 *
 * 基线只减不增：新增手写分派会让 `dispatchInventory.test.ts` 失败。行号不进入基线，
 * 避免无关编辑造成漂移；按文件记录每类的数量。
 */
import fs from 'node:fs';
import path from 'node:path';

export const RESOURCE_TYPE_LITERALS = new Set([
  'note',
  'textbook',
  'exam',
  'translation',
  'essay',
  'image',
  'file',
  'mindmap',
]);

export interface FileDispatchCount {
  switch: number;
  map: number;
}

export type DispatchBaseline = Record<string, FileDispatchCount>;

const ANCHOR_ONLY_KINDS = new Set(['pdf', 'epub', 'media', 'qbank', 'custom']);
const ANCHOR_OVERLAP_RESOURCE_TYPES = new Set(['note', 'mindmap']);

const SKIP = /(?:^|\/)(?:__tests__|__golden__|node_modules)(?:\/|$)|\.test\.|\.spec\.|(?:^|\/)shared\/resource-types\//;

function productionFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const posix = full.split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (SKIP.test(`${posix}/`)) continue;
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !SKIP.test(posix)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

function countSwitches(source: string): number {
  let count = 0;
  const re = /switch\s*\(([^)]*)\)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const i = re.lastIndex - 1;
    let depth = 0;
    let j = i;
    for (; j < source.length; j++) {
      if (source[j] === '{') depth++;
      else if (source[j] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = source.slice(i, j + 1);
    const cases = [...body.matchAll(/case\s+'([^']+)'/g)].map((m) => m[1]!);
    const resourceHits = cases.filter((value) => RESOURCE_TYPE_LITERALS.has(value));
    const isSemanticAnchorSwitch =
      cases.some((value) => ANCHOR_ONLY_KINDS.has(value))
      && resourceHits.every((value) => ANCHOR_OVERLAP_RESOURCE_TYPES.has(value));
    if (resourceHits.length >= 2 && !isSemanticAnchorSwitch) count++;
    re.lastIndex = j;
  }
  return count;
}

function countMaps(source: string): number {
  const lines = source.split('\n');
  let count = 0;
  let run = 0;
  for (const line of lines) {
    const match = line.match(/^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/);
    const key = match ? (match[1] ?? match[2] ?? match[3]) : undefined;
    if (key && RESOURCE_TYPE_LITERALS.has(key)) {
      run++;
      continue;
    }
    if (run >= 3) count++;
    if (line.trim() && !line.trim().startsWith('//')) run = 0;
  }
  if (run >= 3) count++;
  return count;
}

export function scanDispatch(root = 'src'): DispatchBaseline {
  const result: DispatchBaseline = {};
  for (const file of productionFiles(root)) {
    const source = fs.readFileSync(file, 'utf8');
    const switches = countSwitches(source);
    const maps = countMaps(source);
    if (switches || maps) {
      result[file.split(path.sep).join('/')] = { switch: switches, map: maps };
    }
  }
  return result;
}

export function summarize(baseline: DispatchBaseline): {
  files: number;
  switchFiles: number;
  mapFiles: number;
  switches: number;
  maps: number;
} {
  const files = Object.keys(baseline);
  return {
    files: files.length,
    switchFiles: files.filter((file) => baseline[file]!.switch > 0).length,
    mapFiles: files.filter((file) => baseline[file]!.map > 0).length,
    switches: files.reduce((sum, file) => sum + baseline[file]!.switch, 0),
    maps: files.reduce((sum, file) => sum + baseline[file]!.map, 0),
  };
}
