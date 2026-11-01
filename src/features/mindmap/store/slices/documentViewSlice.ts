/**
 * mindmapStore slice：文档/视图 UI 状态：setDocument、视图切换、焦点、专注根、编辑态、选中、双模视口、隐藏已完成。
 */

import type { MindMapDocument, MindMapViewType } from '../../types';
import { findNodeById } from '../../utils/node/find';
import { flattenOutlineTree, resolveSearchPathIds } from '../../utils/searchFilter';
import { mergeMindMapViewport } from '../../utils/viewport';
import type { MindMapViewportView, MindMapStoreState } from '../mindmapStoreTypes';
import { buildNodeIndex } from '../mindmapStoreHelpers';
import type { MindMapSliceCreator } from '../mindmapStoreRuntime';

export const createDocumentViewSlice: MindMapSliceCreator<
  | 'setDocument'
  | 'setCurrentView'
  | 'setFocusedNodeId'
  | 'setViewRootId'
  | 'setEditingNodeId'
  | 'setEditingNoteNodeId'
  | 'setSelection'
  | 'setSelectionAnchorId'
  | 'selectAllVisible'
> = (set, get, rt) => {
  const { scheduleDraftPersist, captureUiSnapshot, pushHistory, debounceSave } = rt;

  return {
    // 设置文档
    setDocument: (doc: MindMapDocument) => {
      const current = get();
      pushHistory(current.document, captureUiSnapshot(current));
      rt.lastCoalesce = null;
      set((state) => {
        state.document = doc;
        state.isDirty = true;
        state._documentVersion += 1;
      });

      const nextState = get();
      if (nextState.mindmapId) {
        scheduleDraftPersist();
      }

      debounceSave();
    },

    // 设置视图（仅切换投影；defaultView 随下次内容保存写入，避免纯切换标脏轰炸）
    setCurrentView: (view: MindMapViewType) => {
      const prev = get().currentView;
      if (prev === view) return;
      set((state) => {
        state.currentView = view;
      });
    },

    // 设置焦点节点
    // B4/性能：不再把 lastFocusId 写进 document.meta——immer 下每次点击都会产生
    // 新的 document 引用，导致订阅 document 的大纲/画布整体重渲染。
    // 持久化的 lastFocusId 由 save()/splitNode/merge* 从 focusedNodeId 写入。
    setFocusedNodeId: (nodeId: string | null) => {
      set((state) => {
        state.focusedNodeId = nodeId;
      });
    },

    // 分支专注根（大纲/画布共享）
    setViewRootId: (nodeId: string | null) => {
      set((state) => {
        const nodeIndex = buildNodeIndex(state.document.root);
        if (!nodeId) {
          state.viewRootId = null;
        } else if (nodeId === state.document.root.id) {
          // 根节点等同于退出专注
          state.viewRootId = null;
        } else {
          const node = nodeIndex.nodeById.get(nodeId);
          state.viewRootId = node ? nodeId : null;
        }

        // 清理不在当前可见子树内的选中，避免批量操作改到屏外节点
        const rootId = state.viewRootId;
        if (!rootId) return;
        const scopeRoot = nodeIndex.nodeById.get(rootId);
        if (!scopeRoot) return;
        const scopeIds = new Set<string>();
        const stack = [scopeRoot];
        while (stack.length > 0) {
          const current = stack.pop()!;
          scopeIds.add(current.id);
          stack.push(...current.children);
        }
        state.selection = state.selection.filter((id) => scopeIds.has(id));
        if (state.focusedNodeId && !scopeIds.has(state.focusedNodeId)) {
          state.focusedNodeId = scopeRoot.id;
        }
      });
    },

    // 设置正在编辑的节点
    setEditingNodeId: (nodeId: string | null) => {
      set((state) => {
        state.editingNodeId = nodeId;
        // 进入标题编辑时退出备注编辑
        if (nodeId) state.editingNoteNodeId = null;
      });
    },

    // 设置正在编辑备注的节点
    setEditingNoteNodeId: (nodeId: string | null) => {
      set((state) => {
        state.editingNoteNodeId = nodeId;
        // 进入备注编辑时退出标题编辑
        if (nodeId) state.editingNodeId = null;
      });
    },

    // 设置选中节点（同集跳过，避免 RF onSelectionChange ↔ controlled selected 空转）
    setSelection: (nodeIds: string[]) => {
      const current = get().selection;
      if (
        current.length === nodeIds.length &&
        (current.length <= 1
          ? current[0] === nodeIds[0]
          : current.every((id) => nodeIds.includes(id)))
      ) {
        return;
      }
      set((state) => {
        state.selection = nodeIds;
      });
    },

    setSelectionAnchorId: (nodeId: string | null) => {
      set((state) => {
        state.selectionAnchorId = nodeId;
      });
    },

    // 全选当前视图可见节点（mod+a）：与大纲的可见性计算保持一致
    selectAllVisible: () => {
      const s = get();
      const displayRoot = s.viewRootId
        ? findNodeById(s.document.root, s.viewRootId) ?? s.document.root
        : s.document.root;
      // 搜索过滤模式优先（与 OutlineView 的 resolveSearchPathIds 相同语义）
      const pathIds = resolveSearchPathIds(displayRoot, {
        enabled: s.searchFilterMode,
        query: s.searchQuery,
        matchIds: s.searchResults,
      });
      const flat = flattenOutlineTree(displayRoot, {
        hideCompleted: s.hideCompleted,
        pathIds,
      });
      // 视图根自身不入选：根不可删除/移动，作为标题行不参与批量操作
      const visibleIds = flat
        .filter((row) => row.id !== displayRoot.id)
        .map((row) => row.id);
      set((state) => {
        state.selection = visibleIds;
        state.selectionAnchorId = visibleIds[0] ?? null;
      });
    },
  };
};

export const createViewportSlice: MindMapSliceCreator<'setViewViewport'> = (set) => {
  return {
    setViewViewport: ((view: MindMapViewportView, partial: Record<string, number>) => {
      set((state) => {
        if (view === 'outline') {
          const prev = state.viewports.outline ?? { scrollTop: 0 };
          state.viewports.outline = {
            scrollTop: partial.scrollTop ?? prev.scrollTop,
          };
          return;
        }
        const prev = state.viewports.mindmap ?? { x: 0, y: 0, zoom: 1 };
        state.viewports.mindmap = mergeMindMapViewport(prev, partial);
      });
    }) as MindMapStoreState['setViewViewport'],
  };
};

export const createHideCompletedSlice: MindMapSliceCreator<'setHideCompleted'> = (set, get, rt) => {
  const { reconcileFilteredInteractionState } = rt;

  return {
    setHideCompleted: (hide: boolean) => {
      set((state) => {
        state.hideCompleted = hide;
        if (hide) reconcileFilteredInteractionState(state);
      });
    },
  };
};
