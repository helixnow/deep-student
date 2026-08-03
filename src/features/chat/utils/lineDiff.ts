/**
 * lineDiff — 基于 diff 包的行级 diff，供 AgentTaskPanel Changes 内联预览渲染。
 */

import { diffLines } from 'diff';

export type DiffLineType = 'added' | 'removed' | 'unchanged';

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

/** 把 diffLines 的块级结果摊平成逐行条目，方便逐行着色渲染 */
export function computeLineDiff(before: string, after: string): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const part of diffLines(before, after)) {
    const type: DiffLineType = part.added ? 'added' : part.removed ? 'removed' : 'unchanged';
    // 去掉块尾换行，避免 split 出一个多余的空行
    const value = part.value.endsWith('\n') ? part.value.slice(0, -1) : part.value;
    for (const text of value.split('\n')) {
      lines.push({ type, text });
    }
  }
  return lines;
}
