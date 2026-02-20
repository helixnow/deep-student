/**
 * 统一的思维导图状态管理（替代旧 useMindMapStore）
 * 
 * 整合：文档状态、UI状态、历史记录、API调用
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { nanoid } from 'nanoid';
import i18next from 'i18next';
import type { MindMapDocument, MindMapNode, MindMapNodeRef, LayoutDirection, EdgeType, MindMapRenderConfig, LayoutConfig, UpdateNodeParams, BlankRange } from '../types';
import * as api from '../api/mindmapApi';
import type { VfsMindMap, MindMapViewType } from '../types';
import { PresetRegistry } from '../registry';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { findNodeById, findParentNode, isDescendantOf } from '../utils/node/find';
import { mergeRanges, validateRanges } from '../utils/node/blankRanges';
import { DEFAULT_LAYOUT_CONFIG } from '../constants';

// ============================================================================
// M-070: 前端节点深度/数量限制（与后端保持一致）
// ============================================================================

const MAX_MINDMAP_DEPTH = 100;
const MAX_MINDMAP_NODES = 10000;

function getNodeDepth(root: MindMapNode, targetId: string, depth = 0): number {
  if (root.id === targetId) return depth;
  for (const child of root.children) {
    const found = getNodeDepth(child, targetId, depth + 1);
    if (found >= 0) return found;
  }
  return -1;
}

function countNodes(node: MindMapNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
}

function collectTopLevelNodeIds(
  root: MindMapNode,
  nodeIds: string[],
  options?: { excludeRoot?: boolean }
): string[] {
  const uniqueExistingIds: string[] = [];
  const seen = new Set<string>();

  for (const nodeId of nodeIds) {
    if (seen.has(nodeId)) continue;
    if (options?.excludeRoot && nodeId === root.id) continue;
    if (!findNodeById(root, nodeId)) continue;
    seen.add(nodeId);
    uniqueExistingIds.push(nodeId);
  }

  return uniqueExistingIds.filter((nodeId) => {
    return !uniqueExistingIds.some(
      (candidateAncestorId) =>
        candidateAncestorId !== nodeId &&
        isDescendantOf(root, candidateAncestorId, nodeId)
    );
  });
}

function removeNodeById(root: MindMapNode, id: string): boolean {
  const idx = root.children.findIndex((c) => c.id === id);
  if (idx !== -1) {
    root.children.splice(idx, 1);
    return true;
  }
  for (const child of root.children) {
    if (removeNodeById(child, id)) return true;
  }
  return false;
}

function createDefaultDocument(title?: string): MindMapDocument {
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

// ============================================================================
// Store 状态定义
// ============================================================================

interface MindMapStoreState {
  // 元数据
  mindmapId: string | null;
  metadata: VfsMindMap | null;

  // 文档状态
  document: MindMapDocument;
  currentView: MindMapViewType;
  focusedNodeId: string | null;
  editingNodeId: string | null; // 当前正在编辑的节点 ID
  editingNoteNodeId: string | null; // 当前正在编辑备注的节点 ID
  selection: string[];

  // 渲染配置状态
  layoutId: string;           // 当前布局ID，默认 'tree'
  layoutDirection: LayoutDirection; // 布局方向，默认 'right'
  styleId: string;            // 样式主题ID，默认 'default'
  edgeType: EdgeType;         // 边类型，默认 'bezier'
  measuredNodeHeights: Record<string, number>;

  // 历史记录
  history: {
    past: MindMapDocument[];
    future: MindMapDocument[];
  };

  // 保存状态
  isDirty: boolean;
  isSaving: boolean;
  lastSavedAt: number | null;
  /** 文档版本计数器（每次变更递增），用于 save 完成后的快速脏检查 */
  _documentVersion: number;
  /** 加载请求序列号，防止快速切换时旧请求覆盖新数据 (M-066) */
  _loadSeq: number;

  // 背诵模式
  reciteMode: boolean;
  revealedBlanks: Record<string, Record<number, boolean>>;
  setReciteMode: (enabled: boolean) => void;
  revealBlank: (nodeId: string, rangeIndex: number) => void;
  revealAllBlanks: () => void;
  resetAllBlanks: () => void;
  addBlankRange: (nodeId: string, range: BlankRange) => void;
  removeBlankRange: (nodeId: string, rangeIndex: number) => void;
  clearNodeBlanks: (nodeId: string) => void;

  // 搜索状态
  searchQuery: string;
  searchResults: string[];
  currentSearchIndex: number;

  // 导出状态
  isExporting: boolean;
  exportProgress: number;
  setIsExporting: (isExporting: boolean) => void;
  setExportProgress: (progress: number) => void;

  clipboard: {
    nodes: MindMapNode[];
    sourceOperation: 'copy' | 'cut';
  } | null;

  // 初始化/加载
  loadMindMap: (mindmapId: string) => Promise<void>;
  createNewMindMap: (title: string, folderId?: string) => Promise<string>;
  reset: () => void;

  // 文档操作
  setDocument: (doc: MindMapDocument) => void;
  setCurrentView: (view: MindMapViewType) => void;
  setFocusedNodeId: (nodeId: string | null) => void;
  setEditingNodeId: (nodeId: string | null) => void;
  setEditingNoteNodeId: (nodeId: string | null) => void;
  setSelection: (nodeIds: string[]) => void;

  // 节点操作
  updateNode: (
    nodeId: string,
    patch: UpdateNodeParams,
    options?: {
      skipHistory?: boolean;
      skipSave?: boolean;
      markDirty?: boolean;
    }
  ) => void;
  addNode: (parentId: string, index?: number) => string;
  deleteNode: (nodeId: string) => void;
  deleteNodes: (nodeIds: string[]) => void;
  moveNode: (nodeId: string, newParentId: string, index: number) => void;
  toggleCollapse: (
    nodeId: string,
    options?: {
      skipHistory?: boolean;
      skipSave?: boolean;
      markDirty?: boolean;
    }
  ) => void;
  indentNode: (nodeId: string) => void;
  outdentNode: (nodeId: string) => void;

  // 节点资源引用
  addNodeRef: (nodeId: string, ref: MindMapNodeRef) => void;
  removeNodeRef: (nodeId: string, sourceId: string) => void;

  // Undo/Redo
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  // 搜索
  search: (query: string) => void;
  nextSearchResult: () => void;
  prevSearchResult: () => void;
  clearSearch: () => void;
  expandToNode: (
    nodeId: string,
    options?: {
      silent?: boolean;
    }
  ) => void;

  copyNodes: (nodeIds: string[]) => void;
  cutNodes: (nodeIds: string[]) => void;
  pasteNodes: (targetId: string) => void;

  // 保存
  save: () => Promise<void>;
  markDirty: () => void;
  /** M-069: 同步写入 localStorage 草稿，用于组件卸载/关闭时防止异步 save 未完成导致丢失 */
  saveDraftSync: () => void;

  // 布局和样式切换
  setLayoutId: (layoutId: string) => void;
  setLayoutDirection: (direction: LayoutDirection) => void;
  setStyleId: (styleId: string) => void;
  setEdgeType: (edgeType: EdgeType) => void;
  setMeasuredNodeHeight: (nodeId: string, height: number) => void;
  applyPreset: (presetId: string) => void;
  getRenderConfig: () => MindMapRenderConfig;

  // ReactFlow 实例注册（用于图片导出）
  _reactFlowGetter: (() => { getNodes: () => unknown[] }) | null;
  setReactFlowGetter: (getter: (() => { getNodes: () => unknown[] }) | null) => void;
}

const MAX_HISTORY = 50;
const DRAFT_KEY_PREFIX = 'mindmap:draft:';

interface MindMapDraftPayload {
  mindmapId: string;
  document: MindMapDocument;
  currentView: MindMapViewType;
  focusedNodeId: string | null;
  savedAt: string;
  layoutId?: string;
  layoutDirection?: LayoutDirection;
  styleId?: string;
  edgeType?: EdgeType;
}

const getDraftStorage = (): Storage | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  return window.localStorage;
};

const getDraftKey = (mindmapId: string): string => `${DRAFT_KEY_PREFIX}${mindmapId}`;

const readDraft = (mindmapId: string): MindMapDraftPayload | null => {
  const storage = getDraftStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(getDraftKey(mindmapId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MindMapDraftPayload;
    if (!parsed?.document?.root?.id || !Array.isArray(parsed.document.root.children)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const writeDraft = (payload: MindMapDraftPayload): void => {
  const storage = getDraftStorage();
  if (!storage) return;
  try {
    storage.setItem(getDraftKey(payload.mindmapId), JSON.stringify(payload));
  } catch (error) {
    console.error('[MindMapStore] Failed to write draft to localStorage:', error);
    // 尝试降级到 sessionStorage
    try {
      window.sessionStorage.setItem(getDraftKey(payload.mindmapId), JSON.stringify(payload));
    } catch (sessionError) {
      console.error('[MindMapStore] Failed to write draft to sessionStorage as well:', sessionError);
      // 打破用户的安全幻觉，通知用户草稿保存失败
      showGlobalNotification('error', i18next.t('store.draftSaveFailed', { ns: 'mindmap', defaultValue: '本地存储空间不足，草稿保存失败，请及时保存并确保网络畅通' }));
    }
  }
};

const clearDraft = (mindmapId: string): void => {
  const storage = getDraftStorage();
  if (!storage) return;
  try {
    storage.removeItem(getDraftKey(mindmapId));
  } catch {
    // ignore
  }
};

// ============================================================================
// Store 创建
// ============================================================================

export const useMindMapStore = create<MindMapStoreState>()(
  immer((set, get) => {
    let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let retrySaveTimer: ReturnType<typeof setTimeout> | null = null;
    let draftPersistTimer: ReturnType<typeof setTimeout> | null = null;
    let measuredFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const measuredHeightsQueue = new Map<string, number>();
    const lastDraftVersionByMindmap = new Map<string, number>();

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
      if (draftPersistTimer) {
        clearTimeout(draftPersistTimer);
        draftPersistTimer = null;
      }
      if (measuredFlushTimer) {
        clearTimeout(measuredFlushTimer);
        measuredFlushTimer = null;
      }
      measuredHeightsQueue.clear();
    };

    const pushHistory = (doc: MindMapDocument) => {
      set((state) => {
        state.history.past.push(JSON.parse(JSON.stringify(doc)));
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
        document: JSON.parse(JSON.stringify(overrides?.document ?? s.document)),
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
      saveDebounceTimer = setTimeout(() => {
        void get().save();
      }, 1500);
    };

    const applyMutation = (
      mutate: (state: MindMapStoreState) => void,
      options?: {
        skipHistory?: boolean;
        skipSave?: boolean;
        markDirty?: boolean;
      }
    ) => {
      const { document } = get();
      if (!options?.skipHistory) {
        pushHistory(document);
      }
      set((state) => {
        mutate(state);
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

    return {
      // 初始状态
      mindmapId: null,
      metadata: null,
      document: createDefaultDocument(),
      currentView: 'mindmap',
      focusedNodeId: null,
      editingNodeId: null,
      editingNoteNodeId: null,
      selection: [],

      // 渲染配置初始状态
      layoutId: 'tree',
      layoutDirection: 'right' as LayoutDirection,
      styleId: 'default',
      edgeType: 'bezier' as EdgeType,
      measuredNodeHeights: {},

      history: { past: [], future: [] },
      isDirty: false,
      isSaving: false,
      lastSavedAt: null,
      _documentVersion: 0,
      _loadSeq: 0,
      reciteMode: false,
      revealedBlanks: {},
      searchQuery: '',
      searchResults: [],
      currentSearchIndex: -1,
      isExporting: false,
      exportProgress: 0,
      setIsExporting: (isExporting: boolean) => set({ isExporting }),
      setExportProgress: (progress: number) => set({ exportProgress: progress }),
      clipboard: null,
      _reactFlowGetter: null,

      // 加载知识导图（修复: 完整重置所有状态字段）
      loadMindMap: async (mindmapId: string) => {
        // 清除 pending timer，防止跨文档保存/重试
        clearPendingTimers();

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
            const serverUpdatedAt = Date.parse(metadata.updatedAt || '');
            const draftSavedAt = Date.parse(localDraft.savedAt || '');
            if (!Number.isNaN(draftSavedAt) && (Number.isNaN(serverUpdatedAt) || draftSavedAt >= serverUpdatedAt)) {
              document = localDraft.document;
              recoveredDraft = true;
            }
          }

          set((state) => {
            state.mindmapId = mindmapId;
            state.metadata = metadata;
            state.document = document;
            state.currentView =
              (recoveredDraft ? localDraft?.currentView : undefined) ||
              metadata.defaultView ||
              'mindmap';
            state.focusedNodeId =
              (recoveredDraft ? localDraft?.focusedNodeId : undefined) ||
              document.meta?.lastFocusId ||
              null;
            state.editingNodeId = null; // 修复: 重置编辑状态
            state.editingNoteNodeId = null;
            state.selection = [];
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
            state.styleId = rc?.styleId || document.meta?.renderConfig?.styleId || 'default';
            state.edgeType = (rc?.edgeType || document.meta?.renderConfig?.edgeType || 'bezier') as EdgeType;
            // 修复: 重置搜索状态
            state.searchQuery = '';
            state.searchResults = [];
            state.currentSearchIndex = -1;
            // 修复: 重置背诵模式状态
            state.reciteMode = false;
            state.revealedBlanks = {};
          });

          if (recoveredDraft) {
            lastDraftVersionByMindmap.set(mindmapId, 1);
            showGlobalNotification('info', i18next.t('store.draftRecovered', { ns: 'mindmap' }));
            debounceSave();
          } else {
            lastDraftVersionByMindmap.delete(mindmapId);
          }
        } catch (error) {
          console.error('[MindMapStore] loadMindMap failed:', error);
          throw error;
        }
      },

      // 创建新知识导图
      createNewMindMap: async (title: string, folderId?: string) => {
        const doc = createDefaultDocument(title);

        const result = await api.createMindMap({
          title,
          content: JSON.stringify(doc),
          defaultView: 'mindmap',
          folderId,
        });

        set((state) => {
          state.mindmapId = result.id;
          state.metadata = result;
          state.document = doc;
          state.currentView = 'mindmap';
          state.focusedNodeId = doc.root.id;
          state.selection = [];
          state.history = { past: [], future: [] };
          state.isDirty = false;
          state._documentVersion = 0;
          state.measuredNodeHeights = {};
        });

        return result.id;
      },

      // 重置状态（修复: 补全所有遗漏字段）
      reset: () => {
        // 清除 pending timer
        clearPendingTimers();
        const currentId = get().mindmapId;
        if (currentId) {
          clearDraft(currentId);
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
          state.layoutId = 'tree';
          state.layoutDirection = 'right';
          state.styleId = 'default';
          state.edgeType = 'bezier';
          state.history = { past: [], future: [] };
          state.isDirty = false;
          state.isSaving = false;
          state.lastSavedAt = null; // 修复: 重置最后保存时间
          state._documentVersion = 0;
          state.measuredNodeHeights = {};
          // 修复: 重置搜索状态
          state.searchQuery = '';
          state.searchResults = [];
          state.currentSearchIndex = -1;
          // 修复: 重置背诵模式状态
          state.reciteMode = false;
          state.revealedBlanks = {};
          state.isExporting = false;
          state.exportProgress = 0;
          state._reactFlowGetter = null;
        });
      },

      // 设置文档
      setDocument: (doc: MindMapDocument) => {
        const current = get().document;
        pushHistory(current);
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

      // 设置视图
      setCurrentView: (view: MindMapViewType) => {
        set((state) => {
          state.currentView = view;
          state.isDirty = true;
          state._documentVersion += 1;
        });

        const nextState = get();
        if (nextState.mindmapId) {
          scheduleDraftPersist();
        }

        debounceSave();
      },

      // 设置焦点节点
      setFocusedNodeId: (nodeId: string | null) => {
        set((state) => {
          state.focusedNodeId = nodeId;
          if (nodeId && state.document.meta) {
            state.document.meta.lastFocusId = nodeId;
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

      // 设置选中节点
      setSelection: (nodeIds: string[]) => {
        set((state) => {
          state.selection = nodeIds;
        });
      },

      // 更新节点
      updateNode: (nodeId: string, patch: UpdateNodeParams, options) => {
        applyMutation((state) => {
          const node = findNodeById(state.document.root, nodeId);
          if (node) {
            // 文本变更时自动清除挖空（字符索引失效）
            if (patch.text !== undefined && patch.text !== node.text) {
              delete node.blankedRanges;
              delete state.revealedBlanks[nodeId];
            }
            Object.assign(node, patch);
          }
        }, options);
      },

      // 添加节点（M-070: 前端深度/节点数限制）
      addNode: (parentId: string, index?: number) => {
        const state = get();

        // M-070: 深度限制
        const parentDepth = getNodeDepth(state.document.root, parentId);
        if (parentDepth < 0 || parentDepth >= MAX_MINDMAP_DEPTH - 1) {
          if (parentDepth >= 0) {
            showGlobalNotification('warning', i18next.t('store.depthExceeded', { ns: 'mindmap' }));
          }
          return '';
        }

        // M-070: 节点数限制
        const totalNodes = countNodes(state.document.root);
        if (totalNodes >= MAX_MINDMAP_NODES) {
          showGlobalNotification('warning', i18next.t('store.nodeCountExceeded', { ns: 'mindmap' }));
          return '';
        }

        const newId = `node_${nanoid(10)}`;
        const newNode: MindMapNode = {
          id: newId,
          text: '',
          children: [],
        };
        applyMutation((s) => {
          const parent = findNodeById(s.document.root, parentId);
          if (parent) {
            const insertIndex = index ?? parent.children.length;
            parent.children.splice(insertIndex, 0, newNode);
            s.focusedNodeId = newId;
          }
        });

        return newId;
      },

      // 删除节点
      deleteNode: (nodeId: string) => {
        get().deleteNodes([nodeId]);
      },

      deleteNodes: (nodeIds: string[]) => {
        const { document } = get();
        const normalizedIds = collectTopLevelNodeIds(document.root, nodeIds, { excludeRoot: true });
        if (normalizedIds.length === 0) return;

        let nextFocusedNodeId = document.root.id;
        for (const nodeId of normalizedIds) {
          const parent = findParentNode(document.root, nodeId);
          if (parent) {
            nextFocusedNodeId = parent.id;
            break;
          }
        }

        applyMutation((state) => {
          for (const nodeId of normalizedIds) {
            removeNodeById(state.document.root, nodeId);
          }

          if (!state.focusedNodeId || normalizedIds.includes(state.focusedNodeId)) {
            state.focusedNodeId = nextFocusedNodeId;
          }
          if (state.editingNodeId && normalizedIds.includes(state.editingNodeId)) {
            state.editingNodeId = null;
          }
          if (state.editingNoteNodeId && normalizedIds.includes(state.editingNoteNodeId)) {
            state.editingNoteNodeId = null;
          }
          state.selection = state.selection.filter((id) => !normalizedIds.includes(id));
        });
      },

      // 移动节点
      moveNode: (nodeId: string, newParentId: string, index: number) => {
        const { document } = get();
        if (document.root.id === nodeId) return;
        if (nodeId === newParentId) return;
        if (isDescendantOf(document.root, nodeId, newParentId)) return;

        applyMutation((state) => {
          const node = findNodeById(state.document.root, nodeId);
          const currentParent = findParentNode(state.document.root, nodeId);
          const nextParent = findNodeById(state.document.root, newParentId);
          if (!node || !currentParent || !nextParent) {
            return;
          }

          const sourceIndex = currentParent.children.findIndex((child) => child.id === nodeId);
          if (sourceIndex === -1) {
            return;
          }

          const [detachedNode] = currentParent.children.splice(sourceIndex, 1);
          if (!detachedNode) {
            return;
          }

          let targetIndex = index;
          if (currentParent.id === nextParent.id && sourceIndex < targetIndex) {
            targetIndex -= 1;
          }

          const boundedIndex = Math.max(0, Math.min(targetIndex, nextParent.children.length));
          nextParent.children.splice(boundedIndex, 0, detachedNode);
        });
      },

      // 切换折叠
      toggleCollapse: (nodeId: string, options) => {
        applyMutation((state) => {
          const node = findNodeById(state.document.root, nodeId);
          if (node) {
            node.collapsed = !node.collapsed;
          }
        }, options);
      },

      // 缩进节点
      indentNode: (nodeId: string) => {
        const { document } = get();
        if (document.root.id === nodeId) return;

        const parent = findParentNode(document.root, nodeId);
        if (!parent) return;

        const idx = parent.children.findIndex((c) => c.id === nodeId);
        if (idx <= 0) return;

        const prevSibling = parent.children[idx - 1];
        get().moveNode(nodeId, prevSibling.id, prevSibling.children.length);
      },

      // 反缩进节点
      outdentNode: (nodeId: string) => {
        const { document } = get();
        if (document.root.id === nodeId) return;

        const parent = findParentNode(document.root, nodeId);
        if (!parent || parent.id === document.root.id) return;

        const grandParent = findParentNode(document.root, parent.id);
        if (!grandParent) return;

        const parentIdx = grandParent.children.findIndex((c) => c.id === parent.id);
        get().moveNode(nodeId, grandParent.id, parentIdx + 1);
      },

      // 节点资源引用
      addNodeRef: (nodeId: string, ref: MindMapNodeRef) => {
        applyMutation((state) => {
          const node = findNodeById(state.document.root, nodeId);
          if (!node) return;
          if (!node.refs) {
            node.refs = [];
          }
          // 去重：同一 sourceId 不重复添加
          if (node.refs.some((r) => r.sourceId === ref.sourceId)) return;
          node.refs.push(ref);
        });
      },

      removeNodeRef: (nodeId: string, sourceId: string) => {
        applyMutation((state) => {
          const node = findNodeById(state.document.root, nodeId);
          if (!node?.refs) return;
          node.refs = node.refs.filter((r) => r.sourceId !== sourceId);
          if (node.refs.length === 0) {
            delete node.refs;
          }
        });
      },

      // Undo
      undo: () => {
        const { history, document } = get();
        if (history.past.length === 0) return;

        let restoredFocusId: string | null = null;
        set((state) => {
          const prev = state.history.past.pop();
          if (prev) {
            state.history.future.push(JSON.parse(JSON.stringify(document)));
            state.document = prev;
            state.isDirty = true;
            state._documentVersion += 1;
            // ★ 2026-02 修复：退出编辑模式，防止 OutlineView 的 localText 与撤销后的文档不一致
            state.editingNodeId = null;
            state.editingNoteNodeId = null;
            // 恢复焦点
            if (prev.meta?.lastFocusId) {
              state.focusedNodeId = prev.meta.lastFocusId;
              restoredFocusId = prev.meta.lastFocusId;
            } else if (state.focusedNodeId) {
              restoredFocusId = state.focusedNodeId;
            }
          }
        });

        const nextState = get();
        if (restoredFocusId) {
          nextState.expandToNode(restoredFocusId, { silent: true });
        }
        if (nextState.mindmapId) {
          scheduleDraftPersist();
        }

        debounceSave();
      },

      // Redo
      redo: () => {
        const { history, document } = get();
        if (history.future.length === 0) return;

        let restoredFocusId: string | null = null;
        set((state) => {
          const next = state.history.future.pop();
          if (next) {
            state.history.past.push(JSON.parse(JSON.stringify(document)));
            state.document = next;
            state.isDirty = true;
            state._documentVersion += 1;
            state.editingNodeId = null;
            state.editingNoteNodeId = null;
            if (next.meta?.lastFocusId) {
              state.focusedNodeId = next.meta.lastFocusId;
              restoredFocusId = next.meta.lastFocusId;
            } else if (state.focusedNodeId) {
              restoredFocusId = state.focusedNodeId;
            }
          }
        });

        const nextState = get();
        if (restoredFocusId) {
          nextState.expandToNode(restoredFocusId, { silent: true });
        }
        if (nextState.mindmapId) {
          scheduleDraftPersist();
        }

        debounceSave();
      },

      canUndo: () => get().history.past.length > 0,
      canRedo: () => get().history.future.length > 0,

      // 保存（防竞态 + 冲突检测 + 自动重试）
      save: async () => {
        const { mindmapId, metadata, document, currentView, focusedNodeId, isDirty, isSaving, _documentVersion } = get();
        if (!mindmapId || !isDirty || isSaving) return;

        // 捕获保存开始时的版本号，防止竞态（替代 JSON.stringify 全量比较，O(1) 性能）
        const savingMindmapId = mindmapId;
        const savingVersion = _documentVersion;
        const expectedUpdatedAt = metadata?.updatedAt;

        if (saveDebounceTimer) {
          clearTimeout(saveDebounceTimer);
          saveDebounceTimer = null;
        }
        if (retrySaveTimer) {
          clearTimeout(retrySaveTimer);
          retrySaveTimer = null;
        }

        set((state) => {
          state.isSaving = true;
        });

        try {
          const { layoutId: savingLayoutId, layoutDirection: savingLayoutDirection, styleId: savingStyleId, edgeType: savingEdgeType } = get();
          const docWithViewState = {
            ...document,
            meta: {
              ...document.meta,
              lastFocusId: focusedNodeId || undefined,
              updatedAt: new Date().toISOString(),
              renderConfig: {
                layoutId: savingLayoutId,
                direction: savingLayoutDirection,
                styleId: savingStyleId,
                edgeType: savingEdgeType,
                layoutConfig: { ...DEFAULT_LAYOUT_CONFIG, direction: savingLayoutDirection },
              },
            },
          };

          const updated = await api.updateMindMap(savingMindmapId, {
            content: JSON.stringify(docWithViewState),
            defaultView: currentView,
            expectedUpdatedAt,
          });

          set((state) => {
            state.isSaving = false;
            state.lastSavedAt = Date.now();
            if (state.mindmapId === savingMindmapId) {
              state.metadata = updated;
            }
            // ★ 2026-02 优化：用版本号比较替代 JSON.stringify，O(1) 复杂度
            if (state.mindmapId === savingMindmapId &&
              state._documentVersion === savingVersion) {
              state.isDirty = false;
            }
          });

          const nextState = get();
          if (nextState.mindmapId === savingMindmapId) {
            if (!nextState.isDirty) {
              clearDraft(savingMindmapId);
              lastDraftVersionByMindmap.delete(savingMindmapId);
            } else {
              persistDraftNow(true);
              // 保存期间若继续编辑，重排一次自动保存，避免漏存
              debounceSave();
            }
          }
        } catch (error) {
          console.error('[MindMapStore] save failed:', error);
          set((state) => {
            state.isSaving = false;
          });

          const errorMessage =
            typeof error === 'string'
              ? error
              : error instanceof Error
                ? error.message
                : '';

          // M-074: 冲突时自动刷新，提供恢复路径
          if (errorMessage.includes('MINDMAP_UPDATE_CONFLICT')) {
            showGlobalNotification('warning', i18next.t('store.updateConflict', { ns: 'mindmap' }));
            // 清除过期本地草稿，避免 loadMindMap 恢复出冲突的旧版本
            if (savingMindmapId) {
              clearDraft(savingMindmapId);
            }
            // 自动重新加载服务端最新版本
            if (get().mindmapId === savingMindmapId) {
              try {
                await get().loadMindMap(savingMindmapId);
                showGlobalNotification('success', i18next.t('store.conflictResolved', { ns: 'mindmap' }));
              } catch (reloadError) {
                console.error('[MindMapStore] conflict auto-reload failed:', reloadError);
                showGlobalNotification('error', i18next.t('store.conflictReloadFailed', { ns: 'mindmap' }));
              }
            }
            return;
          }

          let userMessage = i18next.t('store.saveFailed', { ns: 'mindmap' });
          if (errorMessage.includes('Mindmap depth exceeds limit')) {
            userMessage = i18next.t('store.depthExceeded', { ns: 'mindmap' });
          } else if (errorMessage.includes('Mindmap node count exceeds limit')) {
            userMessage = i18next.t('store.nodeCountExceeded', { ns: 'mindmap' });
          } else if (errorMessage.includes('Invalid JSON')) {
            userMessage = i18next.t('store.invalidContent', { ns: 'mindmap' });
          }
          showGlobalNotification('error', userMessage, i18next.t('store.saveFailedTitle', { ns: 'mindmap' }));

          const isStructuralError =
            errorMessage.includes('depth exceeds') ||
            errorMessage.includes('node count exceeds') ||
            errorMessage.includes('Invalid JSON') ||
            errorMessage.includes('VALIDATION') ||
            errorMessage.includes('too large') ||
            errorMessage.includes('size exceeds');

          if (!isStructuralError && !retrySaveTimer) {
            retrySaveTimer = setTimeout(() => {
              retrySaveTimer = null;
              void get().save();
            }, 5000);
          }
        }
      },

      markDirty: () => {
        set((state) => {
          state.isDirty = true;
          state._documentVersion += 1;
        });
        scheduleDraftPersist();
        debounceSave();
      },

      // M-069: 同步写入 localStorage 草稿（组件卸载 / beforeunload / pagehide 时调用）
      saveDraftSync: () => {
        persistDraftNow();
      },

      // 设置布局
      setLayoutId: (layoutId: string) => {
        set((state) => {
          state.layoutId = layoutId;
        });
      },

      // 设置布局方向
      setLayoutDirection: (direction: LayoutDirection) => {
        set((state) => {
          state.layoutDirection = direction;
        });
      },

      // 设置样式主题
      setStyleId: (styleId: string) => {
        set((state) => {
          state.styleId = styleId;
        });
      },

      // 设置边类型
      setEdgeType: (edgeType: EdgeType) => {
        set((state) => {
          state.edgeType = edgeType;
        });
      },

      // 记录节点实测高度
      setMeasuredNodeHeight: (nodeId: string, height: number) => {
        if (!nodeId || !Number.isFinite(height) || height <= 0) {
          return;
        }
        measuredHeightsQueue.set(nodeId, height);
        if (measuredFlushTimer) {
          return;
        }
        measuredFlushTimer = setTimeout(() => {
          measuredFlushTimer = null;
          flushMeasuredNodeHeights();
        }, 16);
      },

      // 应用预设
      applyPreset: (presetId: string) => {
        const preset = PresetRegistry.get(presetId);
        if (preset) {
          set((state) => {
            state.layoutId = preset.layoutId;
            state.layoutDirection = preset.layoutDirection as LayoutDirection;
            state.styleId = preset.styleId || 'default';
            state.edgeType = (preset.edgeType || 'bezier') as EdgeType;
          });
        }
      },

      // 获取当前渲染配置
      getRenderConfig: (): MindMapRenderConfig => {
        const state = get();
        return {
          layoutId: state.layoutId,
          direction: state.layoutDirection,
          styleId: state.styleId,
          edgeType: state.edgeType,
          layoutConfig: { ...DEFAULT_LAYOUT_CONFIG, direction: state.layoutDirection },
        };
      },

      // 注册 ReactFlow 实例（用于图片导出）
      setReactFlowGetter: (getter) => {
        set((state) => {
          state._reactFlowGetter = getter as typeof state._reactFlowGetter;
        });
      },

      // 背诵模式
      setReciteMode: (enabled: boolean) => {
        set((state) => {
          state.reciteMode = enabled;
          if (!enabled) {
            state.revealedBlanks = {};
          }
          // 进入背诵模式时退出编辑状态
          if (enabled) {
            state.editingNodeId = null;
            state.editingNoteNodeId = null;
          }
        });
      },

      revealBlank: (nodeId: string, rangeIndex: number) => {
        set((state) => {
          if (!state.revealedBlanks[nodeId]) {
            state.revealedBlanks[nodeId] = {};
          }
          state.revealedBlanks[nodeId][rangeIndex] = true;
        });
      },

      revealAllBlanks: () => {
        set((state) => {
          const allBlanks: Record<string, Record<number, boolean>> = {};
          const collect = (node: MindMapNode) => {
            if (node.blankedRanges && node.blankedRanges.length > 0) {
              const merged = mergeRanges(validateRanges(node.blankedRanges, node.text.length));
              const revealed: Record<number, boolean> = {};
              for (let i = 0; i < merged.length; i++) {
                revealed[i] = true;
              }
              allBlanks[node.id] = revealed;
            }
            node.children.forEach(collect);
          };
          collect(state.document.root);
          state.revealedBlanks = allBlanks;
        });
      },

      resetAllBlanks: () => {
        set((state) => {
          state.revealedBlanks = {};
        });
      },

      addBlankRange: (nodeId: string, range: BlankRange) => {
        applyMutation((state) => {
          const node = findNodeById(state.document.root, nodeId);
          if (!node) return;
          const existing = node.blankedRanges || [];
          node.blankedRanges = mergeRanges(validateRanges([...existing, range], node.text.length));
        });
      },

      removeBlankRange: (nodeId: string, rangeIndex: number) => {
        applyMutation((state) => {
          const node = findNodeById(state.document.root, nodeId);
          if (!node || !node.blankedRanges) return;
          const merged = mergeRanges(validateRanges(node.blankedRanges, node.text.length));
          merged.splice(rangeIndex, 1);
          node.blankedRanges = merged.length > 0 ? merged : undefined;
          // 重建 revealed 索引映射：splice 后索引整体前移
          const oldRevealed = state.revealedBlanks[nodeId];
          if (oldRevealed) {
            if (merged.length === 0) {
              delete state.revealedBlanks[nodeId];
            } else {
              const newRevealed: Record<number, boolean> = {};
              for (const [key, val] of Object.entries(oldRevealed)) {
                const oldIdx = Number(key);
                if (oldIdx < rangeIndex) {
                  newRevealed[oldIdx] = val;
                } else if (oldIdx > rangeIndex) {
                  newRevealed[oldIdx - 1] = val;
                }
                // oldIdx === rangeIndex 的条目被删除，不保留
              }
              if (Object.keys(newRevealed).length > 0) {
                state.revealedBlanks[nodeId] = newRevealed;
              } else {
                delete state.revealedBlanks[nodeId];
              }
            }
          }
        });
      },

      clearNodeBlanks: (nodeId: string) => {
        applyMutation((state) => {
          const node = findNodeById(state.document.root, nodeId);
          if (node) {
            delete node.blankedRanges;
          }
          delete state.revealedBlanks[nodeId];
        });
      },

      // 搜索节点
      search: (query: string) => {
        if (!query.trim()) {
          set((state) => {
            state.searchQuery = '';
            state.searchResults = [];
            state.currentSearchIndex = -1;
          });
          return;
        }

        const { document } = get();
        const results: string[] = [];
        const lowerQuery = query.toLowerCase();

        const searchNode = (node: MindMapNode) => {
          if (
            node.text.toLowerCase().includes(lowerQuery) ||
            (node.note && node.note.toLowerCase().includes(lowerQuery))
          ) {
            results.push(node.id);
          }
          node.children.forEach(searchNode);
        };

        searchNode(document.root);

        set((state) => {
          state.searchQuery = query;
          state.searchResults = results;
          state.currentSearchIndex = results.length > 0 ? 0 : -1;
        });

        if (results.length > 0) {
          get().expandToNode(results[0], { silent: true });
          set((state) => {
            state.focusedNodeId = results[0];
          });
        }
      },

      // 下一个搜索结果
      nextSearchResult: () => {
        const { searchResults, currentSearchIndex } = get();
        if (searchResults.length === 0) return;

        const nextIndex = (currentSearchIndex + 1) % searchResults.length;
        const nodeId = searchResults[nextIndex];

        get().expandToNode(nodeId, { silent: true });
        set((state) => {
          state.currentSearchIndex = nextIndex;
          state.focusedNodeId = nodeId;
        });
      },

      // 上一个搜索结果
      prevSearchResult: () => {
        const { searchResults, currentSearchIndex } = get();
        if (searchResults.length === 0) return;

        const prevIndex =
          currentSearchIndex <= 0 ? searchResults.length - 1 : currentSearchIndex - 1;
        const nodeId = searchResults[prevIndex];

        get().expandToNode(nodeId, { silent: true });
        set((state) => {
          state.currentSearchIndex = prevIndex;
          state.focusedNodeId = nodeId;
        });
      },

      // 清除搜索
      clearSearch: () => {
        set((state) => {
          state.searchQuery = '';
          state.searchResults = [];
          state.currentSearchIndex = -1;
        });
      },

      // 展开到指定节点
      expandToNode: (nodeId: string, options) => {
        const { document } = get();

        const findPath = (
          node: MindMapNode,
          targetId: string,
          path: string[]
        ): string[] | null => {
          if (node.id === targetId) return path;
          for (const child of node.children) {
            const result = findPath(child, targetId, [...path, node.id]);
            if (result) return result;
          }
          return null;
        };

        const path = findPath(document.root, nodeId, []);
        if (!path) return;

        applyMutation((state) => {
          for (const id of path) {
            const node = findNodeById(state.document.root, id);
            if (node) {
              node.collapsed = false;
            }
          }
        }, {
          skipHistory: options?.silent ?? false,
          skipSave: options?.silent ?? false,
          markDirty: !(options?.silent ?? false),
        });
      },

      copyNodes: (nodeIds: string[]) => {
        const { document } = get();
        const normalizedIds = collectTopLevelNodeIds(document.root, nodeIds);
        const copiedNodes: MindMapNode[] = [];

        for (const nodeId of normalizedIds) {
          const node = findNodeById(document.root, nodeId);
          if (node) {
            copiedNodes.push(JSON.parse(JSON.stringify(node)));
          }
        }

        if (copiedNodes.length > 0) {
          set((state) => {
            state.clipboard = {
              nodes: copiedNodes,
              sourceOperation: 'copy',
            };
          });
        }
      },

      cutNodes: (nodeIds: string[]) => {
        const { document } = get();
        const normalizedIds = collectTopLevelNodeIds(document.root, nodeIds, { excludeRoot: true });
        if (normalizedIds.length === 0) return;

        const copiedNodes: MindMapNode[] = [];
        for (const nodeId of normalizedIds) {
          const node = findNodeById(document.root, nodeId);
          if (node) {
            copiedNodes.push(JSON.parse(JSON.stringify(node)));
          }
        }

        if (copiedNodes.length === 0) return;

        let nextFocusedNodeId = document.root.id;
        for (const nodeId of normalizedIds) {
          const parent = findParentNode(document.root, nodeId);
          if (parent) {
            nextFocusedNodeId = parent.id;
            break;
          }
        }

        applyMutation((state) => {
          state.clipboard = {
            nodes: copiedNodes,
            sourceOperation: 'cut',
          };

          for (const nodeId of normalizedIds) {
            removeNodeById(state.document.root, nodeId);
          }

          if (!state.focusedNodeId || normalizedIds.includes(state.focusedNodeId)) {
            state.focusedNodeId = nextFocusedNodeId;
          }
          if (state.editingNodeId && normalizedIds.includes(state.editingNodeId)) {
            state.editingNodeId = null;
          }
          if (state.editingNoteNodeId && normalizedIds.includes(state.editingNoteNodeId)) {
            state.editingNoteNodeId = null;
          }
          state.selection = state.selection.filter((id) => !normalizedIds.includes(id));
        });
      },

      pasteNodes: (targetId: string) => {
        const { clipboard } = get();
        if (!clipboard || clipboard.nodes.length === 0) return;

        function regenerateIds(node: MindMapNode): MindMapNode {
          return {
            ...node,
            id: `node_${nanoid(10)}`,
            children: node.children.map(child => regenerateIds(child)),
          };
        }

        applyMutation((state) => {
          const parentNode = findNodeById(state.document.root, targetId);
          if (!parentNode) return;

          for (const node of clipboard.nodes) {
            const newNode = regenerateIds(node);
            parentNode.children.push(newNode);
          }

          const firstNewIndex = parentNode.children.length - clipboard.nodes.length;
          if (firstNewIndex >= 0) {
            state.focusedNodeId = parentNode.children[firstNewIndex].id;
          }
        });

        if (clipboard.sourceOperation === 'cut') {
          set((state) => {
            state.clipboard = null;
          });
        }
      },
    };
  })
);
