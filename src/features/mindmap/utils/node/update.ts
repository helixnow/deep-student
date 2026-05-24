/**
 * 节点更新工具（不可变更新）
 */

import type { MindMapNode, NodeId, UpdateNodeParams } from '../../types';
import { findNodeWithParent } from './find';

/** 更新节点（返回新的树） */
export function updateNode(
  root: MindMapNode,
  nodeId: NodeId,
  updates: UpdateNodeParams
): MindMapNode {
  if (root.id === nodeId) {
    return { ...root, ...updates };
  }
  
  return {
    ...root,
    children: root.children.map(child => updateNode(child, nodeId, updates)),
  };
}

/** 更新节点文本 */
export function updateNodeText(
  root: MindMapNode,
  nodeId: NodeId,
  text: string
): MindMapNode {
  return updateNode(root, nodeId, { text });
}

/** 切换折叠状态 */
export function toggleCollapse(
  root: MindMapNode,
  nodeId: NodeId
): MindMapNode {
  const node = findNodeWithParent(root, nodeId)?.node;
  if (!node) return root;
  
  return updateNode(root, nodeId, { collapsed: !node.collapsed });
}

/** 切换完成状态 */
export function toggleComplete(
  root: MindMapNode,
  nodeId: NodeId
): MindMapNode {
  const node = findNodeWithParent(root, nodeId)?.node;
  if (!node) return root;
  
  return updateNode(root, nodeId, { completed: !node.completed });
}

/** 展开到指定节点（展开所有祖先） */
export function expandToNode(
  root: MindMapNode,
  nodeId: NodeId
): MindMapNode {
  const info = findNodeWithParent(root, nodeId);
  if (!info) return root;
  
  let result = root;
  
  // 展开路径上的所有节点（除了目标节点本身）
  for (let i = 0; i < info.path.length - 1; i++) {
    result = updateNode(result, info.path[i], { collapsed: false });
  }
  
  return result;
}

/** 折叠所有节点 */
export function collapseAll(root: MindMapNode): MindMapNode {
  return {
    ...root,
    collapsed: false, // 根节点不折叠
    children: root.children.map(child => collapseAllRecursive(child)),
  };
}

function collapseAllRecursive(node: MindMapNode): MindMapNode {
  return {
    ...node,
    collapsed: node.children.length > 0,
    children: node.children.map(collapseAllRecursive),
  };
}

/** 展开所有节点 */
export function expandAll(root: MindMapNode): MindMapNode {
  return {
    ...root,
    collapsed: false,
    children: root.children.map(expandAllRecursive),
  };
}

function expandAllRecursive(node: MindMapNode): MindMapNode {
  return {
    ...node,
    collapsed: false,
    children: node.children.map(expandAllRecursive),
  };
}

/** 展开到指定深度 */
export function expandToDepth(root: MindMapNode, depth: number): MindMapNode {
  function expand(node: MindMapNode, currentDepth: number): MindMapNode {
    const shouldCollapse = currentDepth >= depth && node.children.length > 0;
    return {
      ...node,
      collapsed: shouldCollapse,
      children: node.children.map(child => expand(child, currentDepth + 1)),
    };
  }
  
  return expand(root, 0);
}

