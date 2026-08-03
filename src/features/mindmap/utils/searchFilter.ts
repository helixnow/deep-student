/**
 * 搜索过滤视图工具（匹配节点 + 祖先路径）
 */

import type { MindMapNode } from '../types';
import { shouldHideCompletedNode } from './hideCompleted';

const searchResultSetCache = new WeakMap<readonly string[], ReadonlySet<string>>();

/** 将 store 的稳定结果数组复用为 Set，供每个画布节点 O(1) 判断命中。 */
export function getSearchResultIdSet(ids: readonly string[]): ReadonlySet<string> {
  const cached = searchResultSetCache.get(ids);
  if (cached) return cached;
  const result = new Set(ids);
  searchResultSetCache.set(ids, result);
  return result;
}

/**
 * 搜索匹配选项（C13）。
 * 全部可选且默认关闭——不传选项时行为与旧版完全一致（大小写不敏感的子串匹配）。
 */
export interface SearchOptions {
  /** 大小写敏感匹配；默认 false */
  caseSensitive?: boolean;
  /** 全词匹配（匹配两侧不能是字母/数字/下划线）；默认 false */
  wholeWord?: boolean;
}

/** 词字符定义（Unicode 字母 / 数字 / 下划线），用于全词边界判断 */
const WORD_CHAR = /[\p{L}\p{N}_]/u;

function isWholeWordAt(text: string, index: number, length: number): boolean {
  const before = index > 0 ? text[index - 1] : '';
  const after = index + length < text.length ? text[index + length] : '';
  return !(before && WORD_CHAR.test(before)) && !(after && WORD_CHAR.test(after));
}

/**
 * 在（已按 caseSensitive 归一化的）文本中查找下一处匹配；
 * wholeWord 时跳过非全词出现。无匹配返回 -1。
 */
function findNextMatchIndex(
  haystack: string,
  needle: string,
  from: number,
  wholeWord: boolean,
): number {
  let idx = haystack.indexOf(needle, from);
  while (idx !== -1) {
    if (!wholeWord || isWholeWordAt(haystack, idx, needle.length)) return idx;
    idx = haystack.indexOf(needle, idx + 1);
  }
  return -1;
}

function textMatchesQuery(
  value: string | undefined,
  normalizedQuery: string,
  options: SearchOptions,
): boolean {
  if (!value) return false;
  const haystack = options.caseSensitive ? value : value.toLowerCase();
  return findNextMatchIndex(haystack, normalizedQuery, 0, !!options.wholeWord) !== -1;
}

/**
 * 前序搜索正文和备注，结果顺序与大纲/画布遍历顺序一致。
 * 第三参可选（向后兼容）：见 SearchOptions。
 */
export function searchMindMapNodeIds(
  root: MindMapNode,
  query: string,
  options: SearchOptions = {},
): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const normalizedQuery = options.caseSensitive ? trimmed : trimmed.toLowerCase();
  const results: string[] = [];
  const visit = (node: MindMapNode) => {
    if (
      textMatchesQuery(node.text, normalizedQuery, options) ||
      textMatchesQuery(node.note, normalizedQuery, options)
    ) {
      results.push(node.id);
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return results;
}

/** 收集匹配节点及其全部祖先 ID（含匹配自身） */
export function collectSearchPathIds(
  root: MindMapNode,
  matchIds: readonly string[]
): Set<string> {
  const pathIds = new Set<string>();
  if (matchIds.length === 0) return pathIds;

  const matchSet = new Set(matchIds);
  const visit = (node: MindMapNode): boolean => {
    let subtreeMatches = matchSet.has(node.id);
    for (const child of node.children) {
      if (visit(child)) subtreeMatches = true;
    }
    if (subtreeMatches) pathIds.add(node.id);
    return subtreeMatches;
  };

  visit(root);
  return pathIds;
}

/**
 * 判断当前搜索状态是否「有结果可展示」，供 UI 决定是否显示零命中空态文案。
 * - 搜索未激活 / 查询为空：返回 true（此时展示全树，不属于空态）；
 * - 搜索激活且查询非空：matchIds 非空才返回 true。
 * 过滤模式零命中仍保持「空树」行为（有单测锁定），本函数只提供空态判定，
 * UI 接线（空态文案 toolbar.searchNoResults）归 W10。
 */
export function hasSearchResults(state: {
  enabled: boolean;
  query: string;
  matchIds: readonly string[];
}): boolean {
  if (!state.enabled || !state.query.trim()) return true;
  return state.matchIds.length > 0;
}

/** 解析大纲搜索过滤状态；非空查询即使零命中也返回空 Set。 */
export function resolveSearchPathIds(
  root: MindMapNode,
  options: {
    enabled: boolean;
    query: string;
    matchIds: readonly string[];
  }
): Set<string> | null {
  if (!options.enabled || !options.query.trim()) return null;
  return collectSearchPathIds(root, options.matchIds);
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

/**
 * 将文本按查询词切分为高亮片段。
 * 第三参可选（向后兼容）：默认大小写不敏感、非全词，与旧行为一致。
 * 传入的 options 应与 searchMindMapNodeIds 保持一致，否则高亮与命中会不同步。
 */
export function splitSearchHighlights(
  text: string,
  query: string,
  options: SearchOptions = {},
): SearchHighlightPart[] {
  const q = query.trim();
  if (!q || !text) return [{ text, match: false }];

  const haystack = options.caseSensitive ? text : text.toLowerCase();
  const needle = options.caseSensitive ? q : q.toLowerCase();
  const wholeWord = !!options.wholeWord;
  const parts: SearchHighlightPart[] = [];
  let start = 0;

  while (start < text.length) {
    const idx = findNextMatchIndex(haystack, needle, start, wholeWord);
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
