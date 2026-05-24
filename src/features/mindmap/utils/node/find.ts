/**
 * 节点查找工具
 */

import type { MindMapNode, NodeId, NodeWithParent, NodePath } from '../../types';

/** 根据 ID 查找节点 */
export function findNodeById(root: MindMapNode, id: NodeId): MindMapNode | null {
  if (root.id === id) return root;
  
  for (const child of root.children) {
    const found = findNodeById(child, id);
    if (found) return found;
  }
  
  return null;
}

/** 根据 ID 查找节点及其父节点 */
export function findNodeWithParent(
  root: MindMapNode,
  id: NodeId
): NodeWithParent | null {
  // 检查是否是根节点
  if (root.id === id) {
    return {
      node: root,
      parent: null,
      index: 0,
      path: [root.id],
      depth: 0,
    };
  }
  
  function find(
    node: MindMapNode,
    depth: number,
    path: NodePath
  ): NodeWithParent | null {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const childPath = [...path, child.id];
      
      if (child.id === id) {
        return {
          node: child,
          parent: node,
          index: i,
          path: childPath,
          depth: depth + 1,
        };
      }
      
      const found = find(child, depth + 1, childPath);
      if (found) return found;
    }
    return null;
  }
  
  return find(root, 0, [root.id]);
}

/** 根据路径查找节点 */
export function findNodeByPath(root: MindMapNode, path: NodePath): MindMapNode | null {
  if (path.length === 0) return null;
  if (path[0] !== root.id) return null;
  
  let current: MindMapNode = root;
  
  for (let i = 1; i < path.length; i++) {
    const child = current.children.find(c => c.id === path[i]);
    if (!child) return null;
    current = child;
  }
  
  return current;
}

/** 搜索节点（文本匹配） */
export function searchNodes(
  root: MindMapNode,
  query: string,
  options: { caseSensitive?: boolean; includeNotes?: boolean } = {}
): MindMapNode[] {
  const { caseSensitive = false, includeNotes = true } = options;
  const results: MindMapNode[] = [];
  
  const normalizedQuery = caseSensitive ? query : query.toLowerCase();
  
  function search(node: MindMapNode) {
    const text = caseSensitive ? node.text : node.text.toLowerCase();
    const note = caseSensitive ? (node.note || '') : (node.note || '').toLowerCase();
    
    if (text.includes(normalizedQuery)) {
      results.push(node);
    } else if (includeNotes && note.includes(normalizedQuery)) {
      results.push(node);
    }
    
    node.children.forEach(search);
  }
  
  search(root);
  return results;
}

/** 获取下一个兄弟节点 */
export function getNextSibling(root: MindMapNode, nodeId: NodeId): MindMapNode | null {
  const info = findNodeWithParent(root, nodeId);
  if (!info || !info.parent) return null;
  
  const nextIndex = info.index + 1;
  if (nextIndex >= info.parent.children.length) return null;
  
  return info.parent.children[nextIndex];
}

/** 获取上一个兄弟节点 */
export function getPrevSibling(root: MindMapNode, nodeId: NodeId): MindMapNode | null {
  const info = findNodeWithParent(root, nodeId);
  if (!info || !info.parent) return null;
  
  const prevIndex = info.index - 1;
  if (prevIndex < 0) return null;
  
  return info.parent.children[prevIndex];
}

/** 获取第一个子节点 */
export function getFirstChild(root: MindMapNode, nodeId: NodeId): MindMapNode | null {
  const node = findNodeById(root, nodeId);
  if (!node || node.children.length === 0) return null;
  return node.children[0];
}

/** 检查是否是祖先节点 */
export function isAncestor(root: MindMapNode, ancestorId: NodeId, descendantId: NodeId): boolean {
  const descendantInfo = findNodeWithParent(root, descendantId);
  if (!descendantInfo) return false;
  
  return descendantInfo.path.includes(ancestorId);
}

/**
 * 查找节点的直接父节点
 * 
 * 轻量级函数，只返回父节点引用（不构建完整路径）。
 * 适用于只需要父节点的场景（如删除、移动节点时查找父容器）。
 */
export function findParentNode(root: MindMapNode, targetId: NodeId): MindMapNode | null {
  for (const child of root.children) {
    if (child.id === targetId) return root;
    const found = findParentNode(child, targetId);
    if (found) return found;
  }
  return null;
}

/**
 * 检查 nodeId 是否是 ancestorId 的后代（含自身判断）
 * 
 * 用于拖拽时防止将节点移入自己的子树。
 */
export function isDescendantOf(root: MindMapNode, ancestorId: NodeId, nodeId: NodeId): boolean {
  const ancestor = findNodeById(root, ancestorId);
  if (!ancestor) return false;
  return !!findNodeById(ancestor, nodeId);
}

