/**
 * 大纲拆分/合并后恢复光标位置（跨节点 remount 时由聚焦 effect 消费）
 * 以及 ↑↓ 导航的 goal column（目标列）状态。
 */

import type { MindMapNode } from '../types';

let pending: { nodeId: string; offset: number } | null = null;
/** 连续 ↑↓ 时沿用的水平字符列；←→ / 输入后清空 */
let goalColumn: number | null = null;

export function requestOutlineCaret(nodeId: string, offset: number): void {
  pending = { nodeId, offset };
}

export function takeOutlineCaret(nodeId: string): number | null {
  if (!pending || pending.nodeId !== nodeId) return null;
  const offset = pending.offset;
  pending = null;
  return offset;
}

export function setOutlineGoalColumn(column: number | null): void {
  goalColumn = column == null ? null : Math.max(0, Math.floor(column));
}

export function getOutlineGoalColumn(): number | null {
  return goalColumn;
}

export function clearOutlineGoalColumn(): void {
  goalColumn = null;
}

/**
 * 解析垂直导航落到目标行的光标 offset。
 * goal 优先；缺失时用 fallbackOffset（通常为起跳列）。
 */
export function resolveGoalColumnOffset(
  goal: number | null | undefined,
  textLength: number,
  fallbackOffset = 0,
): number {
  const len = Math.max(0, textLength);
  const raw = goal == null ? fallbackOffset : goal;
  return Math.max(0, Math.min(Math.floor(raw), len));
}

/**
 * 多行标题的 ↑/↓ 先交给 textarea；只有位于第一/最后一个逻辑行时才跨节点。
 * 这里按换行符判断，软换行仍由浏览器原生光标移动处理。
 */
export function shouldNavigateAcrossOutlineNode(
  text: string,
  caretOffset: number,
  direction: 'up' | 'down',
): boolean {
  const offset = Math.max(0, Math.min(Math.floor(caretOffset), text.length));
  if (direction === 'up') return !text.slice(0, offset).includes('\n');
  return !text.slice(offset).includes('\n');
}

/** React KeyboardEvent/native KeyboardEvent 均可映射到该最小形状。 */
export function isOutlineCompositionActive(event: {
  isComposing?: boolean;
  keyCode?: number;
}): boolean {
  return event.isComposing === true || event.keyCode === 229;
}

/** 统计后代节点数（不含自身） */
export function countDescendants(node: Pick<MindMapNode, 'children'>): number {
  let count = 0;
  const walk = (n: Pick<MindMapNode, 'children'>) => {
    const children = n.children ?? [];
    for (const child of children) {
      count += 1;
      walk(child);
    }
  };
  walk(node);
  return count;
}

/**
 * 收集 viewRoot 子树内需折叠/展开的节点 id。
 * viewRoot 自身不折叠（对齐 store.collapseAll 对文档根的处理）。
 */
export function collectSubtreeCollapseTargets(
  root: MindMapNode,
  mode: 'collapse' | 'expand',
): string[] {
  const ids: string[] = [];
  const walk = (node: MindMapNode, isSubtreeRoot: boolean) => {
    const children = node.children ?? [];
    if (!isSubtreeRoot && children.length > 0) {
      const collapsed = !!node.collapsed;
      if (mode === 'collapse' && !collapsed) ids.push(node.id);
      if (mode === 'expand' && collapsed) ids.push(node.id);
    }
    for (const child of children) walk(child, false);
  };
  walk(root, true);
  return ids;
}
