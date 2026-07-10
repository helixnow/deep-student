/**
 * 搜索过滤视图工具（Workflowy 风格：匹配节点 + 祖先路径）
 */

import type { MindMapNode } from '../types';
import { getAncestors } from './node/traverse';
import { shouldHideCompletedNode } from './hideCompleted';

/** 收集匹配节点及其全部祖先 ID（含匹配自身） */
export function collectSearchPathIds(
  root: MindMapNode,
  matchIds: readonly string[]
): Set<string> {
  const pathIds = new Set<string>();
  if (matchIds.length === 0) return pathIds;

  for (const id of matchIds) {
    pathIds.add(id);
    for (const ancestor of getAncestors(root, id)) {
      pathIds.add(ancestor.id);
    }
  }
  return pathIds;
}

export interface OutlineFlatNode {
  id: string;
  node: MindMapNode;
  level: number;
  parentId: string | null;
  indexInParent: number;
}

export interface FlattenOutlineOptions {
  /** 隐藏已完成且无未完成后代的节点 */
  hideCompleted?: boolean;
  /**
   * 非空时进入过滤模式：只输出 pathIds 中的节点。
   * 过滤模式下忽略 collapsed，按路径展开可见祖先链。
   */
  pathIds?: Set<string> | null;
}

/** 扁平化大纲树；可选按搜索路径过滤 / 隐藏已完成 */
export function flattenOutlineTree(
  root: MindMapNode,
  options: FlattenOutlineOptions = {}
): OutlineFlatNode[] {
  const { hideCompleted = false, pathIds = null } = options;
  const result: OutlineFlatNode[] = [];

  const traverse = (
    node: MindMapNode,
    level: number,
    parentId: string | null,
    indexInParent: number
  ) => {
    const isRoot = level === 0 && parentId === null;
    // 搜索过滤路径优先：路径上的匹配/祖先即使已完成也保留
    if (!pathIds && hideCompleted && shouldHideCompletedNode(node, { isRoot })) return;
    if (pathIds && !pathIds.has(node.id)) return;

    result.push({ id: node.id, node, level, parentId, indexInParent });

    const children = node.children ?? [];
    if (children.length === 0) return;

    if (pathIds) {
      children.forEach((child, idx) => {
        if (pathIds.has(child.id)) {
          traverse(child, level + 1, node.id, idx);
        }
      });
      return;
    }

    if (!node.collapsed) {
      children.forEach((child, idx) => {
        traverse(child, level + 1, node.id, idx);
      });
    }
  };

  traverse(root, 0, null, 0);
  return result;
}

export interface SearchHighlightPart {
  text: string;
  match: boolean;
}

/** 将文本按查询词切分为高亮片段（大小写不敏感） */
export function splitSearchHighlights(
  text: string,
  query: string
): SearchHighlightPart[] {
  const q = query.trim();
  if (!q || !text) return [{ text, match: false }];

  const lowerText = text.toLowerCase();
  const lowerQuery = q.toLowerCase();
  const parts: SearchHighlightPart[] = [];
  let start = 0;

  while (start < text.length) {
    const idx = lowerText.indexOf(lowerQuery, start);
    if (idx === -1) {
      parts.push({ text: text.slice(start), match: false });
      break;
    }
    if (idx > start) {
      parts.push({ text: text.slice(start, idx), match: false });
    }
    parts.push({ text: text.slice(idx, idx + q.length), match: true });
    start = idx + q.length;
  }

  return parts.length > 0 ? parts : [{ text, match: false }];
}
