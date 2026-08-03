/**
 * Store 选择器
 * 
 * 职责：提供派生状态的选择器函数
 */

import type { MindMapNode, NodeWithParent } from '../types';
import { flattenVisibleNodes, flattenAllNodes, searchNodes, getAncestors } from '../utils/node';
import { findNodeById } from '../utils/node/find';

/** 获取展平的可见节点列表（用于大纲视图） */
export function selectVisibleNodes(root: MindMapNode | null): NodeWithParent[] {
  if (!root) return [];
  return flattenVisibleNodes(root);
}

/**
 * 解析分支专注（viewRootId）下的显示根：
 * 专注根缺失/失效时回落整棵树，与大纲/画布的 displayRoot 计算一致。
 */
export function selectDisplayRoot(
  root: MindMapNode | null,
  viewRootId: string | null,
): MindMapNode | null {
  if (!root) return null;
  if (!viewRootId || viewRootId === root.id) return root;
  return findNodeById(root, viewRootId) ?? root;
}

/** 获取专注范围内展平的可见节点列表（mergeWithPrevious scopeRootId 等场景） */
export function selectVisibleNodesInScope(
  root: MindMapNode | null,
  viewRootId: string | null,
): NodeWithParent[] {
  const displayRoot = selectDisplayRoot(root, viewRootId);
  if (!displayRoot) return [];
  return flattenVisibleNodes(displayRoot);
}

/** 获取展平的所有节点列表 */
export function selectAllNodes(root: MindMapNode | null): NodeWithParent[] {
  if (!root) return [];
  return flattenAllNodes(root);
}

/** 获取搜索结果 */
export function selectSearchResults(
  root: MindMapNode | null,
  query: string
): MindMapNode[] {
  if (!root || !query.trim()) return [];
  return searchNodes(root, query, { caseSensitive: false, includeNotes: true });
}

/** 获取节点的祖先路径 */
export function selectNodeAncestors(
  root: MindMapNode | null,
  nodeId: string
): MindMapNode[] {
  if (!root) return [];
  return getAncestors(root, nodeId);
}

/** 判断节点是否在选中列表中 */
export function selectIsNodeSelected(
  selectedNodeIds: string[],
  nodeId: string
): boolean {
  return selectedNodeIds.includes(nodeId);
}

/** 获取当前搜索结果的节点 ID */
export function selectCurrentSearchResultId(
  searchResults: string[],
  searchIndex: number
): string | null {
  if (searchResults.length === 0) return null;
  return searchResults[searchIndex] || null;
}

