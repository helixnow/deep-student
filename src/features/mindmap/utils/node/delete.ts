/**
 * 节点删除工具（不可变更新）
 */

import type { MindMapNode, NodeId } from '../../types';
import { findNodeWithParent } from './find';
import { collectTopLevelNodeIds } from './traverse';

/** 删除节点（返回新的树） */
export function deleteNode(
  root: MindMapNode,
  nodeId: NodeId
): MindMapNode {
  // 不能删除根节点
  if (root.id === nodeId) {
    return root;
  }
  
  return {
    ...root,
    children: deleteNodeFromChildren(root.children, nodeId),
  };
}

function deleteNodeFromChildren(
  children: MindMapNode[],
  nodeId: NodeId
): MindMapNode[] {
  return children
    .filter(child => child.id !== nodeId)
    .map(child => ({
      ...child,
      children: deleteNodeFromChildren(child.children, nodeId),
    }));
}

/** 删除节点并将其子节点提升到父级 */
export function deleteNodeAndPromoteChildren(
  root: MindMapNode,
  nodeId: NodeId
): MindMapNode {
  // 不能删除根节点
  if (root.id === nodeId) {
    return root;
  }
  
  const info = findNodeWithParent(root, nodeId);
  if (!info || !info.parent) return root;
  
  return {
    ...root,
    children: promoteChildrenRecursive(root.children, nodeId, info.node.children),
  };
}

function promoteChildrenRecursive(
  children: MindMapNode[],
  nodeId: NodeId,
  promotedChildren: MindMapNode[]
): MindMapNode[] {
  const result: MindMapNode[] = [];
  
  for (const child of children) {
    if (child.id === nodeId) {
      // 用被删除节点的子节点替换
      result.push(...promotedChildren);
    } else {
      result.push({
        ...child,
        children: promoteChildrenRecursive(child.children, nodeId, promotedChildren),
      });
    }
  }
  
  return result;
}

/**
 * 删除多个节点。
 * B9：先做祖先/后代去重（父子同选只删顶层），一次过滤而非逐个顺序删，
 * 与 store.deleteNodes 的 collectTopLevelNodeIds 语义对齐。
 */
export function deleteNodes(
  root: MindMapNode,
  nodeIds: NodeId[]
): MindMapNode {
  const topLevelIds = new Set(
    collectTopLevelNodeIds(root, nodeIds, { excludeRoot: true }),
  );
  if (topLevelIds.size === 0) return root;

  const prune = (node: MindMapNode): MindMapNode => ({
    ...node,
    children: node.children
      .filter((child) => !topLevelIds.has(child.id))
      .map(prune),
  });
  return prune(root);
}

/** 清空节点的子节点 */
export function clearChildren(
  root: MindMapNode,
  nodeId: NodeId
): MindMapNode {
  if (root.id === nodeId) {
    return { ...root, children: [] };
  }
  
  return {
    ...root,
    children: root.children.map(child => clearChildren(child, nodeId)),
  };
}

