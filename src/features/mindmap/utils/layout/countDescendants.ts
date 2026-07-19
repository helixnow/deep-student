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

// The depth limit is part of the calculation. Cache by remaining depth as well
// as node identity so a subtree counted near the limit cannot poison a later
// count after it is moved or reused closer to the root.
const descendantCountCache = new WeakMap<MindMapNode, Map<number, number>>();

/**
 * 计算所有后代数量（带 WeakMap 缓存）
 * @param node 节点
 * @param depth 当前深度（用于限制递归）
 */
export function countAllDescendants(node: MindMapNode, depth: number = 0): number {
  if (!node.children || depth > MAX_TREE_DEPTH) return 0;
  const remainingDepth = MAX_TREE_DEPTH - Math.max(0, depth);
  const nodeCache = descendantCountCache.get(node);
  const cached = nodeCache?.get(remainingDepth);
  if (cached !== undefined) return cached;
  let sum = 0;
  for (const child of node.children) {
    sum += 1 + countAllDescendants(child, depth + 1);
  }
  if (nodeCache) {
    nodeCache.set(remainingDepth, sum);
  } else {
    descendantCountCache.set(node, new Map([[remainingDepth, sum]]));
  }
  return sum;
}
