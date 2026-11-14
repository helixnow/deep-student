/**
 * mindmapStore slice：导图生命周期：加载、新建、销毁、草稿清除、重置。
 */

import i18next from 'i18next';
import type { MindMapDocument, LayoutDirection, EdgeType } from '../../types';
import * as api from '../../api/mindmapApi';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { findNodeById } from '../../utils/node/find';
import { normalizeStyleId, createDefaultDocument } from '../mindmapStoreHelpers';
import { readDraft, removeDraftFromStorage } from '../mindmapDraftStorage';
import {
  normalizeDocumentStagingExcerpts,
  normalizeTreeExcerptFields,
  treeHasExcerptFields,
} from '../../utils/nodeAnchors';
import { reconcileSummariesWithTree } from '../../utils/summaryBraces';
import { seedMindMapProjectedFlashcardsBaseline } from '../../interop/mindmapCardProjection';
import type { MindMapSliceCreator } from '../mindmapStoreRuntime';

export const createLifecycleSlice: MindMapSliceCreator<
  | 'loadMindMap'
  | 'createNewMindMap'
  | 'destroy'
  | 'clearDraft'
  | 'reset'
> = (set, get, rt) => {
  const { lastDraftVersionByMindmap, clearPendingTimers, debounceSave } = rt;

  return {
    // 加载知识导图（修复: 完整重置所有状态字段）
    loadMindMap: async (mindmapId: string, opts?: { preserveViewports?: boolean; preserveLocalChanges?: boolean }) => {
      const initialState = get();
      const hasLocalChanges = () => {
        const current = get();
        return current.isDirty || current.isSaving ||
          current.editingNodeId !== null || current.editingNoteNodeId !== null ||
          current.document !== initialState.document ||
          current._documentVersion !== initialState._documentVersion;
      };
      if (opts?.preserveLocalChanges && hasLocalChanges()) return;

      // 清除 pending timer，防止跨文档保存/重试
      clearPendingTimers();
      rt.pendingSaveRequested = false;

      // M-066: 递增加载序列号，防止快速切换时旧请求覆盖新数据
      let seq: number;
      set((state) => {
        seq = ++state._loadSeq;
      });

      try {
        const [metadata, contentStr] = await Promise.all([
          api.getMindMap(mindmapId),
          api.getMindMapContent(mindmapId),
        ]);

        // M-066: 请求返回后检查序列号，若已有更新的请求发出则丢弃旧结果
        if (get()._loadSeq !== seq!) return;
        if (opts?.preserveLocalChanges && hasLocalChanges()) return;

        if (!metadata) {
          throw new Error(`MindMap not found: ${mindmapId}`);
        }

        let document: MindMapDocument;
        if (contentStr) {
          try {
            const parsed = JSON.parse(contentStr) as MindMapDocument;
            if (!parsed?.root || !parsed.root.id || !Array.isArray(parsed.root.children)) {
              throw new Error('Invalid mindmap document structure');
            }
            document = parsed;
          } catch (parseError) {
            throw new Error(i18next.t('store.contentCorrupted', { ns: 'mindmap', error: parseError instanceof Error ? parseError.message : 'parse error' }));
          }
        } else {
          document = createDefaultDocument(metadata.title);
        }

        let recoveredDraft = false;
        const localDraft = readDraft(mindmapId);
        if (localDraft) {
          if (localDraft.baseUpdatedAt !== undefined && localDraft.baseUpdatedAt === metadata.updatedAt) {
            document = localDraft.document;
            recoveredDraft = true;
          }
        }

        // 摘录与汇聚中枢字段清洗；旧文档无这些字段时零开销跳过
        if (treeHasExcerptFields(document.root)) normalizeTreeExcerptFields(document.root);
        normalizeDocumentStagingExcerpts(document);
        reconcileSummariesWithTree(document);

        rt.documentGeneration += 1;
        set((state) => {
          state.mindmapId = mindmapId;
          state.metadata = metadata;
          state.document = document;
          state.conflictSnapshot = localDraft && !recoveredDraft
            && JSON.stringify(localDraft.document) !== JSON.stringify(document)
            ? {
              mindmapId,
              document: localDraft.document,
              currentView: localDraft.currentView,
              focusedNodeId: localDraft.focusedNodeId,
              layoutId: localDraft.layoutId || 'tree',
              layoutDirection: localDraft.layoutDirection || 'right',
              styleId: normalizeStyleId(localDraft.styleId || 'default'),
              edgeType: localDraft.edgeType || 'bezier',
            }
            : null;
          if (!opts?.preserveViewports) {
            state.currentView =
              (recoveredDraft ? localDraft?.currentView : undefined) ||
              metadata.defaultView ||
              'mindmap';
          }
          const focusedNodeId = opts?.preserveViewports
            ? state.focusedNodeId
            : (recoveredDraft ? localDraft?.focusedNodeId : undefined) ||
              document.meta?.lastFocusId || null;
          state.focusedNodeId = focusedNodeId && findNodeById(document.root, focusedNodeId)
            ? focusedNodeId
            : null;
          state.editingNodeId = null; // 修复: 重置编辑状态
          state.editingNoteNodeId = null;
          state.selection = [];
          state.selectionAnchorId = null;
          state.history = { past: [], future: [] };
          state.isDirty = recoveredDraft;
          state.isSaving = false; // 修复: 重置保存状态
          state.lastSavedAt = null; // 修复: 重置最后保存时间
          state._documentVersion = recoveredDraft ? 1 : 0;
          state.measuredNodeHeights = {};
          // P1-3: 恢复布局/样式配置（优先草稿 > 文档 meta > 默认值）
          const rc = recoveredDraft ? localDraft : undefined;
          state.layoutId = rc?.layoutId || document.meta?.renderConfig?.layoutId || 'tree';
          state.layoutDirection = (rc?.layoutDirection || document.meta?.renderConfig?.direction || 'right') as LayoutDirection;
          state.styleId = normalizeStyleId(rc?.styleId || document.meta?.renderConfig?.styleId || 'default');
          state.edgeType = (rc?.edgeType || document.meta?.renderConfig?.edgeType || 'bezier') as EdgeType;
          // 修复: 重置搜索状态
          state.searchQuery = '';
          state.searchOptions = {};
          state.searchResults = [];
          state.currentSearchIndex = -1;
          // 修复: 重置背诵模式状态
          state.reciteMode = false;
          state.revealedBlanks = {};
          state.reciteSessionLog = {};
          state.reciteReviewQueue = null;
          state.reciteReviewIndex = 0;
          // ACR 瞬态入场/退场/更新标记随文档重载清除
          state.agentEnteringIds = new Set();
          state.agentExitingIds = new Set();
          state.agentUpdatedIds = new Set();
          state.lastExcerptContext = null;
          state.excerptRevealRequest = null;
          state.stagingTrayOpen = Boolean(document.stagingExcerpts?.length);
          seedMindMapProjectedFlashcardsBaseline(mindmapId, document.root);
          // 分支专注 / 视口保真为会话级，换图时重置；
          // preserveViewports（外部 watch 静默重载）时保留视口与当前视图
          state.viewRootId = null;
          if (!opts?.preserveViewports) {
            state.viewports = {};
          }
          // hideCompleted / searchFilterMode 为会话级 UI 偏好，切换导图时保留
        });

        if (recoveredDraft) {
          lastDraftVersionByMindmap.set(mindmapId, 1);
          showGlobalNotification('info', i18next.t('store.draftRecovered', { ns: 'mindmap' }));
          debounceSave();
        } else {
          lastDraftVersionByMindmap.delete(mindmapId);
          if (get().conflictSnapshot) {
            showGlobalNotification('warning', i18next.t('store.conflictSnapshotKept', { ns: 'mindmap' }));
          }
        }
      } catch (error) {
        if (get()._loadSeq !== seq!) return;
        console.error('[MindMapStore] loadMindMap failed:', error);
        throw error;
      }
    },

    // 创建新知识导图（B13：重置字段与 loadMindMap / reset 对齐）
    createNewMindMap: async (title: string, folderId?: string) => {
      const seq = get()._loadSeq + 1;
      set({ _loadSeq: seq });
      const doc = createDefaultDocument(title);

      const result = await api.createMindMap({
        title,
        content: JSON.stringify(doc),
        defaultView: 'mindmap',
        folderId,
      });

      if (get()._loadSeq !== seq) return result.id;
      rt.documentGeneration += 1;

      // 与 loadMindMap 一致：切文档前清 pending 定时器，防止旧文档的 debounce 保存串扰
      clearPendingTimers();
      rt.pendingSaveRequested = false;
      lastDraftVersionByMindmap.delete(result.id);
      rt.lastCoalesce = null;
      set((state) => {
        state.mindmapId = result.id;
        state.metadata = result;
        state.document = doc;
        state.currentView = 'mindmap';
        state.focusedNodeId = doc.root.id;
        state.editingNodeId = null;
        state.editingNoteNodeId = null;
        state.selection = [];
        state.selectionAnchorId = null;
        state.agentEnteringIds = new Set();
        state.agentExitingIds = new Set();
        state.agentUpdatedIds = new Set();
        state.history = { past: [], future: [] };
        state.isDirty = false;
        state.isSaving = false;
        state.lastSavedAt = null;
        state._documentVersion = 0;
        state.conflictSnapshot = null;
        state.measuredNodeHeights = {};
        // 新文档回到默认渲染配置（与 reset 一致）
        state.layoutId = 'tree';
        state.layoutDirection = 'right';
        state.styleId = 'default';
        state.edgeType = 'bezier';
        state.viewRootId = null;
        state.viewports = {};
        state.lastExcerptContext = null;
        state.excerptRevealRequest = null;
        state.stagingTrayOpen = false;
        state.reciteMode = false;
        state.revealedBlanks = {};
        state.reciteSessionLog = {};
        state.reciteReviewQueue = null;
        state.reciteReviewIndex = 0;
        state.searchQuery = '';
        state.searchOptions = {};
        state.searchResults = [];
        state.currentSearchIndex = -1;
      });

      return result.id;
    },

    // 清全部 pending 定时器（宿主换 store 实例前调用）；幂等，不重置状态
    destroy: () => {
      rt.documentGeneration += 1;
      set({ _loadSeq: get()._loadSeq + 1 });
      rt.pendingSaveRequested = false;
      clearPendingTimers();
    },

    // 公开草稿清除（Discard 关闭：调用后再卸载即可跳过 saveDraftSync 残留）
    clearDraft: () => {
      const currentId = get().mindmapId;
      if (!currentId) return;
      removeDraftFromStorage(currentId);
      lastDraftVersionByMindmap.delete(currentId);
    },

    // 重置状态（修复: 补全所有遗漏字段）
    reset: () => {
      rt.documentGeneration += 1;
      set({ _loadSeq: get()._loadSeq + 1 });
      // 清除 pending timer
      clearPendingTimers();
      rt.pendingSaveRequested = false;
      const currentId = get().mindmapId;
      if (currentId) {
        removeDraftFromStorage(currentId);
        lastDraftVersionByMindmap.delete(currentId);
      }
      set((state) => {
        state.mindmapId = null;
        state.metadata = null;
        state.document = createDefaultDocument();
        state.currentView = 'mindmap';
        state.focusedNodeId = null;
        state.editingNodeId = null; // 修复: 重置编辑状态
        state.editingNoteNodeId = null;
        state.selection = [];
        state.selectionAnchorId = null;
        state.agentEnteringIds = new Set(); // ACR R1-11 瞬态
        state.agentExitingIds = new Set(); // ACR 4.0 A4 瞬态
        state.agentUpdatedIds = new Set(); // ACR 4.0 A4 瞬态
        state.agentFitViewNonce = 0; // ACR R2-02
        state.nodeLocateRequest = null;
        state.lastExcerptContext = null;
        state.excerptRevealRequest = null;
        state.stagingTrayOpen = false;
        state.excerptIntakeMode = 'direct';
        state.layoutId = 'tree';
        state.layoutDirection = 'right';
        state.styleId = 'default';
        state.edgeType = 'bezier';
        state.history = { past: [], future: [] };
        state.isDirty = false;
        state.isSaving = false;
        state.lastSavedAt = null; // 修复: 重置最后保存时间
        state._documentVersion = 0;
        state.conflictSnapshot = null; // A6-24: 切换/重置导图时清除暂存冲突快照
        state.measuredNodeHeights = {};
        // 修复: 重置搜索状态
        state.searchQuery = '';
        state.searchOptions = {};
        state.searchResults = [];
        state.currentSearchIndex = -1;
        // 修复: 重置背诵模式状态
        state.reciteMode = false;
        state.revealedBlanks = {};
        state.reciteSessionLog = {};
        state.reciteReviewQueue = null;
        state.reciteReviewIndex = 0;
        state.viewRootId = null;
        // hideCompleted / searchFilterMode 为会话级 UI 偏好，reset 时保留
        state.viewports = {};
        state.isExporting = false;
        state.exportProgress = 0;
        state._reactFlowGetter = null;
      });
    },
  };
};
