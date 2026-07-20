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
