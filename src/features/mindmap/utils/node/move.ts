/**
 * 节点移动工具（不可变更新）
 */

import type { MindMapNode, NodeId, DropPosition } from '../../types';
import { findNodeWithParent, isAncestor } from './find';
import { createNode } from './create';

/** 添加节点到指定父节点 */
export function addNode(
  root: MindMapNode,
  parentId: NodeId,
  index: number = -1,
  text: string = ''
): { tree: MindMapNode; newNodeId: NodeId } {
  const newNode = createNode({ text });
  
  const tree = insertNode(root, parentId, newNode, index);
  
  return { tree, newNodeId: newNode.id };
}

/** 插入节点到指定位置 */
export function insertNode(
  root: MindMapNode,
  parentId: NodeId,
  node: MindMapNode,
  index: number = -1
): MindMapNode {
  if (root.id === parentId) {
    const newChildren = [...root.children];
    const insertIndex = index < 0 ? newChildren.length : Math.min(index, newChildren.length);
    newChildren.splice(insertIndex, 0, node);
    return { ...root, children: newChildren };
  }
  
  return {
    ...root,
    children: root.children.map(child => insertNode(child, parentId, node, index)),
  };
}

/** 移动节点到新位置 */
export function moveNode(
  root: MindMapNode,
  nodeId: NodeId,
  newParentId: NodeId,
  index: number = -1
): MindMapNode {
  // 不能移动根节点
  if (root.id === nodeId) return root;
  
  // 不能移动到自己的子孙节点下
  if (isAncestor(root, nodeId, newParentId)) return root;
  
  // 获取要移动的节点
  const nodeInfo = findNodeWithParent(root, nodeId);
  if (!nodeInfo) return root;
  
  // 从原位置删除
  let result = deleteNodeRecursive(root, nodeId);
  
  // 插入到新位置
  result = insertNode(result, newParentId, nodeInfo.node, index);
  
  return result;
}

function deleteNodeRecursive(
  root: MindMapNode,
  nodeId: NodeId
): MindMapNode {
  return {
    ...root,
    children: root.children
      .filter(child => child.id !== nodeId)
      .map(child => deleteNodeRecursive(child, nodeId)),
  };
}

/** 根据拖放位置移动节点 */
export function moveNodeByDrop(
  root: MindMapNode,
  draggedId: NodeId,
  targetId: NodeId,
  position: DropPosition
): MindMapNode {
  // 不能拖放到自己
  if (draggedId === targetId) return root;
  
  // 不能移动根节点
  if (root.id === draggedId) return root;
  
  const targetInfo = findNodeWithParent(root, targetId);
  if (!targetInfo) return root;
  
  if (position === 'inside') {
    // 作为子节点插入
    return moveNode(root, draggedId, targetId, 0);
  } else {
    // 作为兄弟节点插入
    const parentId = targetInfo.parent?.id || root.id;
    const targetIndex = targetInfo.index;
    const newIndex = position === 'before' ? targetIndex : targetIndex + 1;
    
    return moveNode(root, draggedId, parentId, newIndex);
  }
}

/** 缩进节点（变成上一个兄弟的子节点） */
export function indentNode(
  root: MindMapNode,
  nodeId: NodeId
): MindMapNode {
  const info = findNodeWithParent(root, nodeId);
  if (!info || !info.parent || info.index === 0) return root;
  
  // 上一个兄弟节点
  const prevSibling = info.parent.children[info.index - 1];
  
  // 移动到上一个兄弟节点的末尾
  return moveNode(root, nodeId, prevSibling.id, -1);
}

/** 反缩进节点（变成父节点的下一个兄弟） */
export function outdentNode(
  root: MindMapNode,
  nodeId: NodeId
): MindMapNode {
  const info = findNodeWithParent(root, nodeId);
  if (!info || !info.parent) return root;
  
  // 获取祖父节点信息
  const grandparentInfo = findNodeWithParent(root, info.parent.id);
  if (!grandparentInfo) return root; // 父节点是根节点，无法反缩进
  
  const newParentId = grandparentInfo.parent?.id || root.id;
  const newIndex = grandparentInfo.index + 1;
  
  return moveNode(root, nodeId, newParentId, newIndex);
}

/** 在指定节点后添加兄弟节点 */
export function addSiblingAfter(
  root: MindMapNode,
  siblingId: NodeId,
  text: string = ''
): { tree: MindMapNode; newNodeId: NodeId } {
  const info = findNodeWithParent(root, siblingId);
  if (!info) return { tree: root, newNodeId: '' };
  
  const parentId = info.parent?.id || root.id;
  const newIndex = info.index + 1;
  
  return addNode(root, parentId, newIndex, text);
}

/** 在指定节点前添加兄弟节点 */
export function addSiblingBefore(
  root: MindMapNode,
  siblingId: NodeId,
  text: string = ''
): { tree: MindMapNode; newNodeId: NodeId } {
  const info = findNodeWithParent(root, siblingId);
  if (!info) return { tree: root, newNodeId: '' };
  
  const parentId = info.parent?.id || root.id;
  
  return addNode(root, parentId, info.index, text);
}

/** 添加子节点 */
export function addChild(
  root: MindMapNode,
  parentId: NodeId,
  text: string = ''
): { tree: MindMapNode; newNodeId: NodeId } {
  return addNode(root, parentId, 0, text);
}

