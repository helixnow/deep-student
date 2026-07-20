/**
 * notesTreeStore —— 兼容空壳（已按审计建议 8 · 方案 A 收敛）
 *
 * 历史上这里是一份 ~465 行的 Zustand+Immer 树视图状态（展开/选中/拖拽/过滤/typeahead/持久化快照），
 * 但从未被任何业务组件订阅：文件树交互由 `DndFileTree/TreeContext`（useReducer）+ 侧栏受控 props 驱动，
 * 展开状态持久化改由 `NotesSidebarV2` 直接走 `notes_set_pref('notes_tree_expanded:default')`。
 *
 * 保留本文件仅为兼容两处既有引用，避免 import 崩溃：
 * - `src/features/notes/index.ts` 的 re-export
 * - `src/mcp-debug/registerStores.ts` 的调试注册（依赖 `useNotesTreeStore.getState`）
 *
 * 请勿在新代码中使用本 store；树状态一律走 TreeContext + 受控 props。
 */

import { create } from 'zustand';
import { TreeData } from '../DndFileTree/types';

export type DropPosition = 'before' | 'after' | 'inside';

export interface FlattenedTreeNode {
  id: string;
  depth: number;
  parentId: string | null;
  isFolder: boolean;
}

export interface NotesTreePersistenceSnapshot {
  expandedIds: string[];
  selectedIds: string[];
  focusedId: string | null;
  version: number;
}

const NOTES_TREE_VIEW_VERSION = 2;

interface NotesTreeShellState {
  /** 标记：状态已收敛到 TreeContext，本 store 不再承载业务数据 */
  deprecated: true;
  viewVersion: number;
}

/** @deprecated 树状态已收敛到 `DndFileTree/TreeContext`；此 store 仅为兼容保留 */
export const useNotesTreeStore = create<NotesTreeShellState>()(() => ({
  deprecated: true,
  viewVersion: NOTES_TREE_VIEW_VERSION,
}));

/** @deprecated 可见顺序请直接由 `DndFileTree` 内部的扁平化逻辑计算 */
export const computeVisibleOrder = (
  treeData: TreeData,
  expandedIds: Set<string>,
): FlattenedTreeNode[] => {
  const result: FlattenedTreeNode[] = [];
  const visit = (id: string, depth: number, parentId: string | null) => {
    const node = treeData[id];
    if (!node) return;
    if (id !== 'root') {
      result.push({ id, depth, parentId, isFolder: node.isFolder });
    }
    if (!node.children || (id !== 'root' && !expandedIds.has(id))) return;
    for (const childId of node.children) {
      visit(childId, id === 'root' ? depth : depth + 1, id === 'root' ? null : id);
    }
  };
  visit('root', 0, null);
  return result;
};

/** @deprecated 父链请通过 `TreeData` 的 children 关系推导 */
export const getParentChain = (treeData: TreeData, id: string): string[] => {
  const parents: Record<string, string | null> = {};
  for (const [nodeId, node] of Object.entries(treeData)) {
    for (const childId of node.children ?? []) {
      parents[childId] = nodeId;
    }
  }
  const chain: string[] = [];
  const visited = new Set<string>();
  let current: string | null = parents[id] ?? null;
  while (current && current !== 'root' && !visited.has(current)) {
    visited.add(current);
    chain.unshift(current);
    current = parents[current] ?? null;
  }
  return chain;
};

/** @deprecated 展开状态持久化已由 `NotesSidebarV2` 直接走 notes_set_pref */
export const toPersistenceSnapshot = (state: {
  expandedIds: Iterable<string>;
  selectedIds: Iterable<string>;
  focusedId: string | null;
}): NotesTreePersistenceSnapshot => ({
  expandedIds: Array.from(state.expandedIds),
  selectedIds: Array.from(state.selectedIds),
  focusedId: state.focusedId,
  version: NOTES_TREE_VIEW_VERSION,
});
