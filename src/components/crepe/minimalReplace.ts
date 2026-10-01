import type { Node as ProseNode } from '@milkdown/prose/model';
import type { EditorState, Transaction } from '@milkdown/prose/state';

/**
 * 把当前文档替换成 next 的最小事务：只替换真正变化的区间。
 * 结果文档与整篇 replaceAll 相同；未变化的节点（及其 NodeView）保持原样。
 * 两文档一致时返回 null。
 */
export function minimalReplace(state: EditorState, next: ProseNode): Transaction | null {
  const prev = state.doc;
  const start = prev.content.findDiffStart(next.content);
  if (start == null) return null;
  const end = prev.content.findDiffEnd(next.content);
  if (!end) return null;
  let { a: endA, b: endB } = end;
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  return state.tr.replace(start, endA, next.slice(start, endB));
}
