/**
 * mindmapStore slice：Undo / Redo（恢复文档与变更前 UI 快照）。
 */

import type { MindMapHistoryEntry } from '../mindmapStoreTypes';
import type { MindMapSliceCreator } from '../mindmapStoreRuntime';
import { syncMindMapAnchorEdges } from '../../utils/excerptIngest';
import { reconcileMindMapProjectedFlashcards } from '../../interop/mindmapCardProjection';

export const createHistorySlice: MindMapSliceCreator<
  | 'undo'
  | 'redo'
  | 'canUndo'
  | 'canRedo'
> = (set, get, rt) => {
  const {
    scheduleDraftPersist,
    captureUiSnapshot,
    debounceSave,
    refreshSearchResults,
    reconcileFilteredInteractionState,
    reconcileRevealedBlanks,
    restoreUiSnapshot,
  } = rt;

  return {
    // Undo（恢复文档 + 条目附带的 UI 快照，并对新树做存在性校验）
    undo: () => {
      const current = get();
      if (current.history.past.length === 0) return;
      // undo 后继续输入应开启新的 undo 步
      rt.lastCoalesce = null;
      // document 为 immer frozen 树，直接存引用（见 pushHistory）
      const currentEntry: MindMapHistoryEntry = {
        document: current.document,
        ui: captureUiSnapshot(current),
      };

      let restoredFocusId: string | null = null;
      set((state) => {
        const entry = state.history.past.pop();
        if (!entry) return;
        state.history.future.push(currentEntry);
        state.document = entry.document;
        restoreUiSnapshot(state, entry);
        refreshSearchResults(state);
        reconcileFilteredInteractionState(state);
        reconcileRevealedBlanks(state);
        state.isDirty = true;
        state._documentVersion += 1;
        // ★ 2026-02 修复：退出编辑模式，防止 OutlineView 的 localText 与撤销后的文档不一致
        state.editingNodeId = null;
        state.editingNoteNodeId = null;
        restoredFocusId = state.focusedNodeId;
      });

      const nextState = get();
      if (restoredFocusId) {
        nextState.expandToNode(restoredFocusId, { silent: true });
      }
      if (nextState.mindmapId) {
        scheduleDraftPersist();
      }
      syncMindMapAnchorEdges(nextState.mindmapId, nextState.document.root, {
        styleId: nextState.styleId,
      });
      reconcileMindMapProjectedFlashcards(nextState.mindmapId, nextState.document.root);

      debounceSave();
    },

    // Redo（对称恢复 undo 前的文档与 UI 状态）
    redo: () => {
      const current = get();
      if (current.history.future.length === 0) return;
      rt.lastCoalesce = null;
      // document 为 immer frozen 树，直接存引用（见 pushHistory）
      const currentEntry: MindMapHistoryEntry = {
        document: current.document,
        ui: captureUiSnapshot(current),
      };

      let restoredFocusId: string | null = null;
      set((state) => {
        const entry = state.history.future.pop();
        if (!entry) return;
        state.history.past.push(currentEntry);
        state.document = entry.document;
        restoreUiSnapshot(state, entry);
        refreshSearchResults(state);
        reconcileFilteredInteractionState(state);
        reconcileRevealedBlanks(state);
        state.isDirty = true;
        state._documentVersion += 1;
        state.editingNodeId = null;
        state.editingNoteNodeId = null;
        restoredFocusId = state.focusedNodeId;
      });

      const nextState = get();
      if (restoredFocusId) {
        nextState.expandToNode(restoredFocusId, { silent: true });
      }
      if (nextState.mindmapId) {
        scheduleDraftPersist();
      }
      syncMindMapAnchorEdges(nextState.mindmapId, nextState.document.root, {
        styleId: nextState.styleId,
      });
      reconcileMindMapProjectedFlashcards(nextState.mindmapId, nextState.document.root);

      debounceSave();
    },

    canUndo: () => get().history.past.length > 0,
    canRedo: () => get().history.future.length > 0,
  };
};
