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
  const merged: BlankRange[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].start <= last.end) {
      last.end = Math.max(last.end, sorted[i].end);
    } else {
      merged.push(sorted[i]);
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
