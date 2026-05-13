/**
 * Store 选择器
 * 
 * 职责：提供派生状态的选择器函数
 */

import type { MindMapNode, NodeWithParent } from '../types';
import { flattenVisibleNodes, flattenAllNodes, searchNodes, getAncestors } from '../utils/node';

/** 获取展平的可见节点列表（用于大纲视图） */
export function selectVisibleNodes(root: MindMapNode | null): NodeWithParent[] {
  if (!root) return [];
  return flattenVisibleNodes(root);
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

