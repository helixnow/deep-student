import type { BlankRange, MindMapNode } from '../../types';

export interface TextSegment {
  text: string;
  isBlanked: boolean;
  rangeIndex: number; // -1 表示普通文本
}

/** 排序并合并重叠区间 */
export function mergeRanges(ranges: BlankRange[]): BlankRange[] {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  // ★ A6-26：复制区间对象再合并。旧实现直接改 last.end，会原地修改调用方传入的
  // 区间对象——store 的 document 是 immer frozen 树，若有调用方直接传 node.blankedRanges
  // （未先经 validateRanges 复制）将抛 TypeError。
  const merged: BlankRange[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].start <= last.end) {
      last.end = Math.max(last.end, sorted[i].end);
    } else {
      merged.push({ ...sorted[i] });
    }
  }
  return merged;
}

/** 过滤越界区间 */
export function validateRanges(ranges: BlankRange[], textLength: number): BlankRange[] {
  return ranges
    .map(r => ({
      start: Math.max(0, r.start),
      end: Math.min(textLength, r.end),
    }))
    .filter(r => r.start < r.end);
}

/**
 * 文本编辑后重映射挖空区间（store.updateNode 契约）。
 *
 * 采用单次编辑模型：取新旧文本的公共前缀/公共后缀，中间视为被替换的编辑区。
 * - 完全位于公共前缀内的区间原样保留；
 * - 完全位于公共后缀内的区间按长度差平移；
 * - 与编辑区重叠的区间（挖空文本本身被改写/删除）被丢弃；
 * - 防御性校验：映射后的子串必须与原挖空子串一致，否则丢弃。
 *
 * 返回全新区间对象（不修改入参），全部失效时返回空数组（调用方据此清除挖空状态）。
 */
export function remapRangesAfterTextEdit(
  oldText: string,
  newText: string,
  ranges: BlankRange[],
): BlankRange[] {
  if (ranges.length === 0) return [];
  if (oldText === newText) return ranges.map(r => ({ ...r }));

  let prefixLen = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (prefixLen < maxPrefix && oldText[prefixLen] === newText[prefixLen]) {
    prefixLen++;
  }

  let suffixLen = 0;
  const maxSuffix = Math.min(oldText.length, newText.length) - prefixLen;
  while (
    suffixLen < maxSuffix &&
    oldText[oldText.length - 1 - suffixLen] === newText[newText.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  // 编辑区在旧文本中的区间为 [prefixLen, oldEditEnd)
  const oldEditEnd = oldText.length - suffixLen;
  const delta = newText.length - oldText.length;

  const result: BlankRange[] = [];
  for (const range of ranges) {
    let mapped: BlankRange | null = null;
    if (range.end <= prefixLen) {
      mapped = { start: range.start, end: range.end };
    } else if (range.start >= oldEditEnd) {
      mapped = { start: range.start + delta, end: range.end + delta };
    }
    if (!mapped) continue;
    if (mapped.start < 0 || mapped.end > newText.length || mapped.start >= mapped.end) continue;
    if (newText.slice(mapped.start, mapped.end) !== oldText.slice(range.start, range.end)) continue;
    result.push(mapped);
  }
  return result;
}

/** 将文本按挖空区间拆分为段 */
export function splitTextByRanges(text: string, ranges: BlankRange[]): TextSegment[] {
  if (!ranges || ranges.length === 0) {
    return [{ text, isBlanked: false, rangeIndex: -1 }];
  }

  const valid = mergeRanges(validateRanges(ranges, text.length));
  if (valid.length === 0) {
    return [{ text, isBlanked: false, rangeIndex: -1 }];
  }

  const segments: TextSegment[] = [];
  let cursor = 0;

  for (let i = 0; i < valid.length; i++) {
    const range = valid[i];
    if (cursor < range.start) {
      segments.push({
        text: text.slice(cursor, range.start),
        isBlanked: false,
        rangeIndex: -1,
      });
    }
    segments.push({
      text: text.slice(range.start, range.end),
      isBlanked: true,
      rangeIndex: i,
    });
    cursor = range.end;
  }

  if (cursor < text.length) {
    segments.push({
      text: text.slice(cursor),
      isBlanked: false,
      rangeIndex: -1,
    });
  }

  return segments;
}

/** 统计进度 */
export function countBlankProgress(
  root: MindMapNode,
  revealedBlanks: Record<string, Record<number, boolean>>
): { total: number; revealed: number } {
  let total = 0;
  let revealed = 0;

  const traverse = (node: MindMapNode) => {
    if (node.blankedRanges && node.blankedRanges.length > 0) {
      const merged = mergeRanges(validateRanges(node.blankedRanges, node.text.length));
      total += merged.length;
      const nodeRevealed = revealedBlanks[node.id];
      if (nodeRevealed) {
        for (let i = 0; i < merged.length; i++) {
          if (nodeRevealed[i]) revealed++;
        }
      }
    }
    node.children.forEach(traverse);
  };

  traverse(root);
  return { total, revealed };
}
