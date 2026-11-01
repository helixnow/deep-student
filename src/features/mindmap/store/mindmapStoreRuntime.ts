/**
 * mindmapStore 运行时：保存防抖/重试、草稿落盘、历史合并、批量变更（applyMutation）
 * 以及搜索/过滤/揭示状态的校正。
 */

import type { StateCreator } from 'zustand/vanilla';
import type { MindMapDocument } from '../types';
import { mergeRanges, validateRanges } from '../utils/node/blankRanges';
import { buildCompletedVisibilityIndex, resolveVisibleIdFromIndex } from '../utils/hideCompleted';
import { collectSearchPathIds, searchMindMapNodeIds } from '../utils/searchFilter';
import type {
  MindMapHistoryUiSnapshot,
  MindMapHistoryEntry,
  MindMapStoreState,
} from './mindmapStoreTypes';
import { buildNodeIndex } from './mindmapStoreHelpers';
import { writeDraft, type MindMapDraftPayload } from './mindmapDraftStorage';

const MAX_HISTORY = 50;
/** U5：同一 coalesceKey 在该时间窗内的连续变更合并为一个 undo 步 */
export const HISTORY_COALESCE_WINDOW_MS = 800;

// ============================================================================
// Store 运行时（每个 store 实例一份）
// ============================================================================

/** immer 中间件下的 set / get（与 createStore()(immer(...)) 回调参数一致） */
type MindMapImmerStateCreator = StateCreator<MindMapStoreState, [['zustand/immer', never]], []>;
export type MindMapStoreSet = Parameters<MindMapImmerStateCreator>[0];
export type MindMapStoreGet = Parameters<MindMapImmerStateCreator>[1];

/**
 * 每个 store 实例私有的闭包状态（定时器 / 计数器 / 合并键）与内部辅助函数。
 * 在 createMindMapStore 的 immer 回调内创建一次，所有 slice 共享同一份；
 * 可变的 let 变量经 getter/setter 暴露，slice 通过 rt.xxx 读写同一绑定。
 */
export function createMindMapStoreRuntime(set: MindMapStoreSet, get: MindMapStoreGet) {
  let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let retrySaveTimer: ReturnType<typeof setTimeout> | null = null;
  /** save() 在保存中被调用时置位，当前保存结束后自动补一次保存（可见性 flush 不再空跑） */
  let pendingSaveRequested = false;
  let documentGeneration = 0;
  /** 非结构性保存失败的自动重试计数（成功或用户新编辑周期后清零） */
  let saveRetryCount = 0;
  const MAX_SAVE_AUTO_RETRIES = 3;
  const SAVE_RETRY_BASE_DELAY_MS = 5000;
  let draftPersistTimer: ReturnType<typeof setTimeout> | null = null;
  let measuredFlushTimer: ReturnType<typeof setTimeout> | null = null;
  const measuredHeightsQueue = new Map<string, number>();
  const lastDraftVersionByMindmap = new Map<string, number>();
  /**
   * U5：最近一次进入 history 的合并键与时间。同键且在时间窗内的下一次变更
   * 不再 pushHistory（沿用上一个快照），使连续打字/调样式只占一个 undo 步。
   */
  let lastCoalesce: { key: string; at: number } | null = null;

  const flushMeasuredNodeHeights = () => {
    if (measuredHeightsQueue.size === 0) return;
    const entries = Array.from(measuredHeightsQueue.entries());
    measuredHeightsQueue.clear();

    set((state) => {
      for (const [nodeId, height] of entries) {
        const prev = state.measuredNodeHeights[nodeId];
        if (prev && Math.abs(prev - height) < 1) continue;
        state.measuredNodeHeights[nodeId] = height;
      }
    });
  };

  const persistDraftNow = (force = false) => {
    const s = get();
    if (!s.isDirty || !s.mindmapId) return;

    const lastVersion = lastDraftVersionByMindmap.get(s.mindmapId);
    if (!force && lastVersion === s._documentVersion) return;

    const draft = buildDraftPayload();
    if (!draft) return;
    writeDraft(draft);
    lastDraftVersionByMindmap.set(s.mindmapId, s._documentVersion);
  };

  const scheduleDraftPersist = () => {
    if (draftPersistTimer) {
      clearTimeout(draftPersistTimer);
    }
    draftPersistTimer = setTimeout(() => {
      draftPersistTimer = null;
      persistDraftNow();
    }, 240);
  };

  const clearPendingTimers = () => {
    if (saveDebounceTimer) {
      clearTimeout(saveDebounceTimer);
      saveDebounceTimer = null;
    }
    if (retrySaveTimer) {
      clearTimeout(retrySaveTimer);
      retrySaveTimer = null;
    }
    saveRetryCount = 0;
    if (draftPersistTimer) {
      clearTimeout(draftPersistTimer);
      draftPersistTimer = null;
    }
    if (measuredFlushTimer) {
      clearTimeout(measuredFlushTimer);
      measuredFlushTimer = null;
    }
    measuredHeightsQueue.clear();
    lastCoalesce = null;
  };

  /** 捕获变更前的轻量 UI 快照（存引用，不深拷贝） */
  const captureUiSnapshot = (s: MindMapStoreState): MindMapHistoryUiSnapshot => ({
    focusedNodeId: s.focusedNodeId,
    selection: s.selection,
    viewRootId: s.viewRootId,
  });

  const pushHistory = (doc: MindMapDocument, ui?: MindMapHistoryUiSnapshot) => {
    set((state) => {
      // ★ 性能：store 经 immer 中间件，document 是 frozen 不可变树，
      // 每次 mutation 产生结构共享的新树。历史栈直接存引用即可，
      // 全量深克隆（旧实现）在大导图上每次编辑都有明显开销且浪费内存。
      state.history.past.push({ document: doc, ui });
      if (state.history.past.length > MAX_HISTORY) {
        state.history.past.shift();
      }
      state.history.future = [];
    });
  };

  /** 构建草稿 payload（含布局字段），避免 7 处 writeDraft 重复 */
  const buildDraftPayload = (overrides?: Partial<MindMapDraftPayload>): MindMapDraftPayload | null => {
    const s = get();
    if (!s.mindmapId) return null;
    return {
      mindmapId: s.mindmapId,
      // frozen 树可直接被 JSON.stringify 序列化写入草稿，无需先深克隆
      document: overrides?.document ?? s.document,
      currentView: overrides?.currentView ?? s.currentView,
      focusedNodeId: overrides?.focusedNodeId ?? s.focusedNodeId,
      savedAt: new Date().toISOString(),
      layoutId: s.layoutId,
      layoutDirection: s.layoutDirection,
      styleId: s.styleId,
      edgeType: s.edgeType,
    };
  };

  const debounceSave = () => {
    if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
    if (retrySaveTimer) {
      clearTimeout(retrySaveTimer);
      retrySaveTimer = null;
    }
    // 用户新编辑触发的保存周期：重置自动重试计数
    saveRetryCount = 0;
    saveDebounceTimer = setTimeout(() => {
      void get().save({ source: 'auto' });
    }, 1500);
  };

  /**
   * D1：布局/主题等渲染配置变更。不进 history（撤销栈只管文档结构），
   * 但必须标脏 + 草稿落盘 + 调度保存——save() 会把当前布局字段拼进
   * meta.renderConfig，纯改布局后关闭不再丢失。
   */
  const applyRenderConfigChange = (mutate: (state: MindMapStoreState) => void) => {
    set((state) => {
      mutate(state);
      state.isDirty = true;
      state._documentVersion += 1;
    });
    if (get().mindmapId) {
      scheduleDraftPersist();
    }
    debounceSave();
  };

  const refreshSearchResults = (state: MindMapStoreState) => {
    if (!state.searchQuery.trim()) return;
    const currentId = state.searchResults[state.currentSearchIndex] ?? null;
    const results = searchMindMapNodeIds(state.document.root, state.searchQuery, state.searchOptions);
    state.searchResults = results;
    const retainedIndex = currentId ? results.indexOf(currentId) : -1;
    state.currentSearchIndex = retainedIndex >= 0 ? retainedIndex : (results.length > 0 ? 0 : -1);
  };

  const applyMutation = (
    mutate: (state: MindMapStoreState) => void,
    options?: {
      skipHistory?: boolean;
      skipSave?: boolean;
      markDirty?: boolean;
      /** U5：同键且时间窗内的连续变更合并为一个 undo 步 */
      coalesceKey?: string | null;
    }
  ) => {
    const before = get();
    if (!options?.skipHistory) {
      const now = Date.now();
      const key = options?.coalesceKey ?? null;
      const canCoalesce =
        key !== null &&
        lastCoalesce !== null &&
        lastCoalesce.key === key &&
        now - lastCoalesce.at <= HISTORY_COALESCE_WINDOW_MS &&
        before.history.past.length > 0 &&
        before.history.future.length === 0;
      if (canCoalesce) {
        // 沿用上一个快照：本次不 pushHistory，undo 一次回到合并组之前
        lastCoalesce = { key: key!, at: now };
      } else {
        pushHistory(before.document, captureUiSnapshot(before));
        lastCoalesce = key !== null ? { key, at: now } : null;
      }
    } else {
      // skipHistory 变更（agent 演出等）不在合并组快照内，
      // 之后若继续合并会把这些变更一起吞进 undo，故打断合并链
      lastCoalesce = null;
    }
    set((state) => {
      mutate(state);
      refreshSearchResults(state);
      reconcileFilteredInteractionState(state);
      if (options?.markDirty !== false) {
        state.isDirty = true;
        state._documentVersion += 1;
      }
    });

    const nextState = get();
    if (nextState.mindmapId && nextState.isDirty) {
      scheduleDraftPersist();
    }

    if (!options?.skipSave) {
      debounceSave();
    }
  };

  function reconcileFilteredInteractionState(state: MindMapStoreState) {
    if (state.searchFilterMode && state.searchQuery.trim()) {
      const allowedIds = collectSearchPathIds(state.document.root, state.searchResults);
      state.selection = state.selection.filter((id) => allowedIds.has(id));
      if (state.editingNodeId && !allowedIds.has(state.editingNodeId)) {
        state.editingNodeId = null;
      }
      if (state.focusedNodeId && !allowedIds.has(state.focusedNodeId)) {
        state.focusedNodeId = state.searchResults.find((id) => allowedIds.has(id)) ?? null;
      }
      return;
    }

    if (!state.hideCompleted) return;
    const visibility = buildCompletedVisibilityIndex(state.document.root);
    state.selection = state.selection.filter((id) => visibility.visibleIds.has(id));
    state.focusedNodeId = resolveVisibleIdFromIndex(
      visibility,
      state.focusedNodeId,
      state.document.root.id,
    );
    if (state.editingNodeId && !visibility.visibleIds.has(state.editingNodeId)) {
      state.editingNodeId = null;
    }
    if (state.editingNoteNodeId && !visibility.visibleIds.has(state.editingNoteNodeId)) {
      state.editingNoteNodeId = null;
    }
  }

  /**
   * D5：undo/redo 恢复文档后校正 revealedBlanks——节点已不存在、挖空被清除
   * 或区间数变少时，丢弃越界的揭示状态，避免索引错位揭示到别的空。
   */
  function reconcileRevealedBlanks(state: MindMapStoreState) {
    const nodeIds = Object.keys(state.revealedBlanks);
    if (nodeIds.length === 0) return;
    const nodeById = buildNodeIndex(state.document.root).nodeById;
    for (const nodeId of nodeIds) {
      const node = nodeById.get(nodeId);
      if (!node?.blankedRanges?.length) {
        delete state.revealedBlanks[nodeId];
        continue;
      }
      const rangeCount = mergeRanges(
        validateRanges(node.blankedRanges, node.text.length),
      ).length;
      const next: Record<number, boolean> = {};
      for (const [key, value] of Object.entries(state.revealedBlanks[nodeId])) {
        const index = Number(key);
        if (index >= 0 && index < rangeCount) next[index] = value;
      }
      if (Object.keys(next).length > 0) {
        state.revealedBlanks[nodeId] = next;
      } else {
        delete state.revealedBlanks[nodeId];
      }
    }
  }

  /**
   * U3/U6：undo/redo 恢复 history 条目的 UI 快照。
   * 所有 ID 先对已恢复的 state.document 做存在性校验（复用 reconcile 思路），
   * 旧条目（无 ui 字段）退化为「清理不存在的 ID + meta.lastFocusId 兜底」。
   */
  function restoreUiSnapshot(state: MindMapStoreState, entry: MindMapHistoryEntry) {
    const nodeById = buildNodeIndex(state.document.root).nodeById;
    if (entry.ui) {
      state.selection = entry.ui.selection.filter((id) => nodeById.has(id));
      state.viewRootId =
        entry.ui.viewRootId &&
        entry.ui.viewRootId !== state.document.root.id &&
        nodeById.has(entry.ui.viewRootId)
          ? entry.ui.viewRootId
          : null;
      if (entry.ui.focusedNodeId && nodeById.has(entry.ui.focusedNodeId)) {
        state.focusedNodeId = entry.ui.focusedNodeId;
      }
    } else {
      state.selection = state.selection.filter((id) => nodeById.has(id));
      if (state.viewRootId && !nodeById.has(state.viewRootId)) {
        state.viewRootId = null;
      }
    }
    // 焦点兜底链：快照 → 文档 meta.lastFocusId → 根
    if (!state.focusedNodeId || !nodeById.has(state.focusedNodeId)) {
      const metaFocusId = state.document.meta?.lastFocusId;
      state.focusedNodeId =
        metaFocusId && nodeById.has(metaFocusId) ? metaFocusId : state.document.root.id;
    }
    if (state.selectionAnchorId && !nodeById.has(state.selectionAnchorId)) {
      state.selectionAnchorId = null;
    }
  }

  return {
    get pendingSaveRequested(): boolean {
      return pendingSaveRequested;
    },
    set pendingSaveRequested(value: boolean) {
      pendingSaveRequested = value;
    },
    get documentGeneration(): number {
      return documentGeneration;
    },
    set documentGeneration(value: number) {
      documentGeneration = value;
    },
    get saveRetryCount(): number {
      return saveRetryCount;
    },
    set saveRetryCount(value: number) {
      saveRetryCount = value;
    },
    get saveDebounceTimer(): ReturnType<typeof setTimeout> | null {
      return saveDebounceTimer;
    },
    set saveDebounceTimer(value: ReturnType<typeof setTimeout> | null) {
      saveDebounceTimer = value;
    },
    get retrySaveTimer(): ReturnType<typeof setTimeout> | null {
      return retrySaveTimer;
    },
    set retrySaveTimer(value: ReturnType<typeof setTimeout> | null) {
      retrySaveTimer = value;
    },
    get measuredFlushTimer(): ReturnType<typeof setTimeout> | null {
      return measuredFlushTimer;
    },
    set measuredFlushTimer(value: ReturnType<typeof setTimeout> | null) {
      measuredFlushTimer = value;
    },
    get lastCoalesce(): { key: string; at: number } | null {
      return lastCoalesce;
    },
    set lastCoalesce(value: { key: string; at: number } | null) {
      lastCoalesce = value;
    },
    MAX_SAVE_AUTO_RETRIES,
    SAVE_RETRY_BASE_DELAY_MS,
    measuredHeightsQueue,
    lastDraftVersionByMindmap,
    flushMeasuredNodeHeights,
    persistDraftNow,
    scheduleDraftPersist,
    clearPendingTimers,
    captureUiSnapshot,
    pushHistory,
    debounceSave,
    applyRenderConfigChange,
    refreshSearchResults,
    applyMutation,
    reconcileFilteredInteractionState,
    reconcileRevealedBlanks,
    restoreUiSnapshot,
  };
}

export type MindMapStoreRuntime = ReturnType<typeof createMindMapStoreRuntime>;

/** slice 工厂：返回 MindMapStoreState 中该 slice 负责的字段 */
export type MindMapSliceCreator<K extends keyof MindMapStoreState> = (
  set: MindMapStoreSet,
  get: MindMapStoreGet,
  rt: MindMapStoreRuntime,
) => Pick<MindMapStoreState, K>;
