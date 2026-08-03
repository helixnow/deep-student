/**
 * 「隐藏已完成」过滤：隐藏 completed 且子树内无未完成节点的整枝；
 * 若有未完成后代则保留该祖先（及其通向未完成节点的路径）。
 */

import type { MindMapNode } from '../types';

export interface CompletedVisibilityIndex {
  visibleIds: Set<string>;
  parentById: Map<string, string | null>;
}

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

/** 一次后序遍历构建隐藏已完成视图所需的可见集合与父链。 */
export function buildCompletedVisibilityIndex(root: MindMapNode): CompletedVisibilityIndex {
  const visibleIds = new Set<string>();
  const parentById = new Map<string, string | null>();

  const visit = (node: MindMapNode, parentId: string | null, isRoot: boolean): boolean => {
    parentById.set(node.id, parentId);
    let subtreeHasOpenNode = !node.completed;
    for (const child of node.children) {
      if (visit(child, node.id, false)) subtreeHasOpenNode = true;
    }
    if (isRoot || subtreeHasOpenNode) visibleIds.add(node.id);
    return subtreeHasOpenNode;
  };

  visit(root, null, true);
  return { visibleIds, parentById };
}

/** 从给定节点沿父链上溯到最近可见节点。 */
export function resolveVisibleIdFromIndex(
  index: CompletedVisibilityIndex,
  nodeId: string | null,
  rootId: string
): string | null {
  if (!nodeId) return null;
  let current: string | null | undefined = nodeId;
  while (current) {
    if (index.visibleIds.has(current)) return current;
    current = index.parentById.get(current);
  }
  return index.parentById.has(nodeId) ? rootId : nodeId;
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
  return resolveVisibleIdFromIndex(
    buildCompletedVisibilityIndex(root),
    focusedNodeId,
    root.id,
  );
}
