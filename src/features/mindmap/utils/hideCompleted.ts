/**
 * 「隐藏已完成」过滤：隐藏 completed 且子树内无未完成节点的整枝；
 * 若有未完成后代则保留该祖先（及其通向未完成节点的路径）。
 */

import type { MindMapNode } from '../types';

/** 子树内是否存在未完成节点（含自身） */
export function subtreeHasIncomplete(node: MindMapNode): boolean {
  if (!node.completed) return true;
  return node.children.some(subtreeHasIncomplete);
}

/** 是否应隐藏该节点（根节点永不隐藏） */
export function shouldHideCompletedNode(
  node: MindMapNode,
  options?: { isRoot?: boolean }
): boolean {
  if (options?.isRoot) return false;
  if (!node.completed) return false;
  return !subtreeHasIncomplete(node);
}

/**
 * 返回用于布局/展示的过滤树（结构共享不可变浅拷贝）。
 * 根始终保留；隐藏 completed 且无未完成后代的整枝。
 */
export function filterCompletedTree(root: MindMapNode): MindMapNode {
  const filterChildren = (node: MindMapNode): MindMapNode[] => {
    const next: MindMapNode[] = [];
    for (const child of node.children) {
      if (shouldHideCompletedNode(child)) continue;
      next.push({
        ...child,
        children: filterChildren(child),
      });
    }
    return next;
  };

  return {
    ...root,
    children: filterChildren(root),
  };
}

/** 焦点落在被隐藏节点时，上移到最近仍可见的祖先（或根） */
export function resolveVisibleFocusId(
  root: MindMapNode,
  focusedNodeId: string | null,
  hideCompleted: boolean
): string | null {
  if (!focusedNodeId || !hideCompleted) return focusedNodeId;

  const path: MindMapNode[] = [];
  const findPath = (node: MindMapNode, trail: MindMapNode[]): boolean => {
    const next = [...trail, node];
    if (node.id === focusedNodeId) {
      path.push(...next);
      return true;
    }
    for (const child of node.children) {
      if (findPath(child, next)) return true;
    }
    return false;
  };

  if (!findPath(root, [])) return focusedNodeId;

  // path[0] 是 root；从焦点向上找第一个不应被隐藏的节点
  for (let i = path.length - 1; i >= 0; i--) {
    const node = path[i];
    const isRoot = i === 0;
    if (!shouldHideCompletedNode(node, { isRoot })) {
      return node.id;
    }
  }
  return root.id;
}
