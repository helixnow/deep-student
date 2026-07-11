/**
 * 节点遍历工具
 */

import type { MindMapNode, NodeId, NodeWithParent, NodePath } from '../../types';

/** 遍历回调 */
export type TraverseCallback = (
  node: MindMapNode,
  parent: MindMapNode | null,
  index: number,
  depth: number
) => boolean | void;  // 返回 false 停止遍历

/** 深度优先遍历（前序） */
export function traverseDFS(
  root: MindMapNode,
  callback: TraverseCallback,
  parent: MindMapNode | null = null,
  index: number = 0,
  depth: number = 0
): boolean {
  const result = callback(root, parent, index, depth);
  if (result === false) return false;

  for (let i = 0; i < root.children.length; i++) {
    const shouldContinue = traverseDFS(root.children[i], callback, root, i, depth + 1);
    if (!shouldContinue) return false;
  }
  return true;
}

/** 广度优先遍历 */
export function traverseBFS(
  root: MindMapNode,
  callback: TraverseCallback
): void {
  const queue: Array<{ node: MindMapNode; parent: MindMapNode | null; index: number; depth: number }> = [
    { node: root, parent: null, index: 0, depth: 0 }
  ];

  while (queue.length > 0) {
    const { node, parent, index, depth } = queue.shift()!;
    const result = callback(node, parent, index, depth);
    if (result === false) return;

    node.children.forEach((child, i) => {
      queue.push({ node: child, parent: node, index: i, depth: depth + 1 });
    });
  }
}

/** 展平节点树为数组（仅可见节点） */
export function flattenVisibleNodes(root: MindMapNode): NodeWithParent[] {
  const result: NodeWithParent[] = [];
  
  function traverse(
    node: MindMapNode,
    parent: MindMapNode | null,
    index: number,
    depth: number,
    path: NodePath
  ) {
    const currentPath = [...path, node.id];
    result.push({ node, parent, index, depth, path: currentPath });
    
    if (!node.collapsed) {
      node.children.forEach((child, i) => {
        traverse(child, node, i, depth + 1, currentPath);
      });
    }
  }
  
  traverse(root, null, 0, 0, []);
  return result;
}

/** 展平所有节点（包括折叠的） */
export function flattenAllNodes(root: MindMapNode): NodeWithParent[] {
  const result: NodeWithParent[] = [];
  
  function traverse(
    node: MindMapNode,
    parent: MindMapNode | null,
    index: number,
    depth: number,
    path: NodePath
  ) {
    const currentPath = [...path, node.id];
    result.push({ node, parent, index, depth, path: currentPath });
    
    node.children.forEach((child, i) => {
      traverse(child, node, i, depth + 1, currentPath);
    });
  }
  
  traverse(root, null, 0, 0, []);
  return result;
}

/** 获取节点的所有祖先（从根到父） */
export function getAncestors(root: MindMapNode, nodeId: NodeId): MindMapNode[] {
  const ancestors: MindMapNode[] = [];
  
  function find(node: MindMapNode, path: MindMapNode[]): boolean {
    if (node.id === nodeId) {
      ancestors.push(...path);
      return true;
    }
    
    for (const child of node.children) {
      if (find(child, [...path, node])) {
        return true;
      }
    }
    return false;
  }
  
  find(root, []);
  return ancestors;
}

/** 计算节点总数（含自身） */
export function countNodes(root: MindMapNode): number {
  let count = 1;
  for (const child of root.children) {
    count += countNodes(child);
  }
  return count;
}

/** 计算后代节点总数（不含自身） */
export function countDescendants(node: MindMapNode): number {
  if (!node.children || node.children.length === 0) return 0;
  return node.children.reduce((sum, child) => sum + 1 + countDescendants(child), 0);
}

/** 获取最大深度 */
export function getMaxDepth(root: MindMapNode): number {
  if (root.children.length === 0) return 0;
  return 1 + Math.max(...root.children.map(getMaxDepth));
}

/**
 * 去重并移除已选祖先的后代，仅保留选中集中的顶层节点。
 * 遍历树一次，结果顺序保持调用方传入顺序。
 */
export function collectTopLevelNodeIds(
  root: MindMapNode,
  nodeIds: readonly string[],
  options?: { excludeRoot?: boolean }
): string[] {
  const orderedIds: string[] = [];
  const selectedIds = new Set<string>();

  for (const nodeId of nodeIds) {
    if (selectedIds.has(nodeId)) continue;
    if (options?.excludeRoot && nodeId === root.id) continue;
    selectedIds.add(nodeId);
    orderedIds.push(nodeId);
  }

  if (selectedIds.size === 0) return [];

  const topLevelIds = new Set<string>();
  const visit = (node: MindMapNode, hasSelectedAncestor: boolean) => {
    const isSelected = selectedIds.has(node.id);
    if (isSelected && !hasSelectedAncestor) {
      topLevelIds.add(node.id);
    }
    const descendantHasSelectedAncestor = hasSelectedAncestor || isSelected;
    for (const child of node.children) {
      visit(child, descendantHasSelectedAncestor);
    }
  };

  visit(root, false);
  return orderedIds.filter((nodeId) => topLevelIds.has(nodeId));
}
