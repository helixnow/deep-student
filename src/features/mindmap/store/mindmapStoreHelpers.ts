/**
 * mindmapStore 纯函数辅助：节点深度/数量限制、树索引、删除后清理、挖空区间重映射、默认文档。
 */

import { nanoid } from 'nanoid';
import i18next from 'i18next';
import type { MindMapDocument, MindMapNode, MindMapAssociation, BlankRange } from '../types';
import { findNodeById } from '../utils/node/find';
import { mergeRanges, validateRanges, remapRangesAfterTextEdit } from '../utils/node/blankRanges';
import type { MindMapStoreState } from './mindmapStoreTypes';

/** 将历史保存的主题 ID 规范化为中性命名。 */
export function normalizeStyleId(styleId: string): string {
  return ({ cardDark: 'cardDark', cardLight: 'cardLight' } as Record<string, string>)[styleId] ?? styleId;
}

// ============================================================================
// M-070: 前端节点深度/数量限制（与后端保持一致）
// ============================================================================

export const MAX_MINDMAP_DEPTH = 100;
export const MAX_MINDMAP_NODES = 10000;

export function getNodeDepth(root: MindMapNode, targetId: string, depth = 0): number {
  if (root.id === targetId) return depth;
  for (const child of root.children) {
    const found = getNodeDepth(child, targetId, depth + 1);
    if (found >= 0) return found;
  }
  return -1;
}

export function countNodes(node: MindMapNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
}

export function getSubtreeHeight(node: MindMapNode): number {
  let height = 0;
  for (const child of node.children) {
    height = Math.max(height, 1 + getSubtreeHeight(child));
  }
  return height;
}

export function buildNodeIndex(root: MindMapNode): {
  nodeById: Map<string, MindMapNode>;
  parentById: Map<string, MindMapNode | null>;
  depthById: Map<string, number>;
  indexById: Map<string, number>;
} {
  const nodeById = new Map<string, MindMapNode>();
  const parentById = new Map<string, MindMapNode | null>();
  const depthById = new Map<string, number>();
  const indexById = new Map<string, number>();
  const stack: Array<{
    node: MindMapNode;
    parent: MindMapNode | null;
    depth: number;
    index: number;
  }> = [
    { node: root, parent: null, depth: 0, index: 0 },
  ];
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodeById.set(current.node.id, current.node);
    parentById.set(current.node.id, current.parent);
    depthById.set(current.node.id, current.depth);
    indexById.set(current.node.id, current.index);
    for (let i = current.node.children.length - 1; i >= 0; i--) {
      stack.push({
        node: current.node.children[i],
        parent: current.node,
        depth: current.depth + 1,
        index: i,
      });
    }
  }
  return { nodeById, parentById, depthById, indexById };
}

export function collectNodeAndDescendantIds(root: MindMapNode, nodeIds: readonly string[]): Set<string> {
  const nodeById = buildNodeIndex(root).nodeById;
  const result = new Set<string>();
  const stack = nodeIds.flatMap((id) => {
    const node = nodeById.get(id);
    return node ? [node] : [];
  });
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (result.has(node.id)) continue;
    result.add(node.id);
    stack.push(...node.children);
  }
  return result;
}

export function removeNodesById(root: MindMapNode, ids: ReadonlySet<string>): void {
  root.children = root.children.filter((child) => !ids.has(child.id));
  for (const child of root.children) removeNodesById(child, ids);
}

/** 节点删除时级联清理关联线 */
export function pruneAssociationsForRemovedNodes(
  document: MindMapDocument,
  removedIds: ReadonlySet<string>,
): void {
  if (!document.associations?.length) return;
  document.associations = document.associations.filter(
    (a) => !removedIds.has(a.source) && !removedIds.has(a.target),
  );
  if (document.associations.length === 0) {
    delete document.associations;
  }
}

/**
 * 节点从树中移除后的统一后置清理（deleteNodes / cutNodes / agentDeleteNode / merge 共用）：
 * 关联线剪枝、焦点回退、编辑态退出、选中/锚点过滤、viewRootId 失效退出。
 * 必须在节点已从 state.document 移除之后调用。
 */
export function afterRemoveNodes(
  state: MindMapStoreState,
  removedIds: ReadonlySet<string>,
  fallbackFocusId?: string,
): void {
  pruneAssociationsForRemovedNodes(state.document, removedIds);
  if (!state.focusedNodeId || removedIds.has(state.focusedNodeId)) {
    state.focusedNodeId = fallbackFocusId ?? state.document.root.id;
  }
  if (state.editingNodeId && removedIds.has(state.editingNodeId)) {
    state.editingNodeId = null;
  }
  if (state.editingNoteNodeId && removedIds.has(state.editingNoteNodeId)) {
    state.editingNoteNodeId = null;
  }
  state.selection = state.selection.filter((id) => !removedIds.has(id));
  if (state.selectionAnchorId && removedIds.has(state.selectionAnchorId)) {
    state.selectionAnchorId = null;
  }
  // 专注根被删（或其祖先被删导致不可达）时退出专注，避免视图指向已删节点
  if (
    state.viewRootId &&
    (removedIds.has(state.viewRootId) ||
      !findNodeById(state.document.root, state.viewRootId))
  ) {
    state.viewRootId = null;
  }
}

/**
 * 拆分/合并保留挖空区间的辅助：把「以节点已提交文本为基」的挖空区间
 * 重映射到草稿文本（textOverride）。基文本与草稿一致时等价于深拷贝；
 * 无法映射（挖空文本本身被改写）的区间被丢弃。
 */
export function resolveDraftBlankRanges(node: MindMapNode, draftText: string): BlankRange[] {
  if (!node.blankedRanges?.length) return [];
  const baseText = node.text ?? '';
  const merged = mergeRanges(validateRanges(node.blankedRanges, baseText.length));
  return remapRangesAfterTextEdit(baseText, draftText, merged);
}

/** 合并拼接时整体平移被合并节点的挖空区间 */
export function shiftBlankRanges(ranges: BlankRange[], delta: number): BlankRange[] {
  return ranges.map((range) => ({ start: range.start + delta, end: range.end + delta }));
}

export function findAssociationPair(
  associations: MindMapAssociation[] | undefined,
  source: string,
  target: string,
): MindMapAssociation | undefined {
  if (!associations?.length) return undefined;
  return associations.find(
    (a) =>
      (a.source === source && a.target === target) ||
      (a.source === target && a.target === source),
  );
}

export function createDefaultDocument(title?: string): MindMapDocument {
  const resolvedTitle = title || i18next.t('placeholder.root', { ns: 'mindmap' });
  return {
    version: '1.0',
    root: {
      id: `root_${nanoid(8)}`,
      text: resolvedTitle,
      children: [],
    },
    meta: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}
