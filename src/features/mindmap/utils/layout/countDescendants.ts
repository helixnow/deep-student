/**
 * 子树后代数计数（WeakMap 缓存，O(n) / 布局）
 *
 * 布局递归到每个节点时若无缓存会重新遍历整棵子树 → O(n²)。
 * 文档树由 immer 管理（结构共享）：未变化子树保持对象身份，
 * 以节点对象为键的 WeakMap 因此天然正确失效。
 */

import type { MindMapNode } from '../../types';

/** 最大树深度限制，防止栈溢出 */
export const MAX_TREE_DEPTH = 500;

interface SubtreeStats {
  /** 全部后代数 */
  count: number;
  /** 最深后代的相对层数（无子节点为 0） */
  height: number;
}

// The depth limit is part of the calculation: a count started at `depth` only reaches
// MAX_TREE_DEPTH - depth + 1 levels below the node. Whole-subtree stats answer every call
// whose subtree fits in that budget; only subtrees deeper than the budget need a truncated
// count, cached by node and level budget so a count near the limit cannot poison a later one.
const subtreeStatsCache = new WeakMap<MindMapNode, SubtreeStats>();
const truncatedCountCache = new WeakMap<MindMapNode, Map<number, number>>();

/**
 * 整棵子树的后代数与高度，迭代计算（不受深度上限约束，也不会栈溢出），子孙的结果一并缓存。
 * 同一节点经两条路径可达（不是树，含环）时返回 undefined，交给按层数截断的计数。
 */
function subtreeStats(root: MindMapNode): SubtreeStats | undefined {
  const cached = subtreeStatsCache.get(root);
  if (cached) return cached;
  const order: MindMapNode[] = [];
  const seen = new Set<MindMapNode>();
  const pending: MindMapNode[] = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (seen.has(node)) return undefined;
    seen.add(node);
    order.push(node);
    for (const child of node.children ?? []) {
      if (!subtreeStatsCache.has(child)) pending.push(child);
    }
  }
  // 先序的逆序：子节点总在父节点之前汇总
  for (let i = order.length - 1; i >= 0; i--) {
    const node = order[i];
    let count = 0;
    let height = 0;
    for (const child of node.children ?? []) {
      const stats = subtreeStatsCache.get(child)!;
      count += 1 + stats.count;
      height = Math.max(height, 1 + stats.height);
    }
    subtreeStatsCache.set(node, { count, height });
  }
  return subtreeStatsCache.get(root);
}

/** 相对层数不超过 `levels` 的后代数，按定义递归（只用于不是树的结构）。 */
function countWithin(node: MindMapNode, levels: number): number {
  if (levels <= 0 || !node.children) return 0;
  let sum = 0;
  for (const child of node.children) {
    sum += 1 + countWithin(child, levels - 1);
  }
  return sum;
}

/**
 * 一次遍历缓存 `root` 子树里每个比 `levels` 更深的节点的截断计数：
 * 恰好在 v 下方 levels + 1 层的节点 u 连同其子树都不计入 v，其余后代都计入。
 * 每个 u 只扣在它往上第 levels + 1 层的祖先身上，所以总工作量是子树大小。
 */
function cacheTruncatedCounts(root: MindMapNode, levels: number): void {
  const excluded = new Map<MindMapNode, number>();
  const path: MindMapNode[] = [];
  const pending: Array<{ node: MindMapNode; depth: number }> = [{ node: root, depth: 0 }];
  while (pending.length > 0) {
    const { node, depth } = pending.pop()!;
    path.length = depth;
    path.push(node);
    if (depth > levels) {
      const ancestor = path[depth - levels - 1];
      excluded.set(ancestor, (excluded.get(ancestor) ?? 0) + 1 + subtreeStatsCache.get(node)!.count);
    }
    for (const child of node.children ?? []) pending.push({ node: child, depth: depth + 1 });
  }
  for (const [node, excess] of excluded) {
    const count = subtreeStatsCache.get(node)!.count - excess;
    const nodeCache = truncatedCountCache.get(node);
    if (nodeCache) nodeCache.set(levels, count);
    else truncatedCountCache.set(node, new Map([[levels, count]]));
  }
}

/**
 * 计算所有后代数量（带 WeakMap 缓存）
 * @param node 节点
 * @param depth 当前深度（用于限制递归）
 */
export function countAllDescendants(node: MindMapNode, depth: number = 0): number {
  if (!node.children || depth > MAX_TREE_DEPTH) return 0;
  const levels = MAX_TREE_DEPTH - depth + 1;
  // RUST-FIX(RF-W09-mindmap-descendant-count-linear): the depth-keyed cache never hit across a layout pass (every node is counted at depth 0), so each count re-walked its subtree
  const stats = subtreeStats(node);
  if (!stats) return countWithin(node, levels);
  if (stats.height <= levels) return stats.count;
  const cached = truncatedCountCache.get(node)?.get(levels);
  if (cached !== undefined) return cached;
  cacheTruncatedCounts(node, levels);
  return truncatedCountCache.get(node)!.get(levels)!;
}
