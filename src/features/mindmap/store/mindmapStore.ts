/**
 * 统一的思维导图状态管理（替代旧 useMindMapStore）
 * 
 * 整合：文档状态、UI状态、历史记录、API调用
 */

import { createContext, useContext } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { immer } from 'zustand/middleware/immer';
import { enableMapSet } from 'immer';
import type { LayoutDirection, EdgeType } from '../types';
import type { MindMapStoreState } from './mindmapStoreTypes';
import { createDefaultDocument } from './mindmapStoreHelpers';
import { createMindMapStoreRuntime } from './mindmapStoreRuntime';
import { createLifecycleSlice } from './slices/lifecycleSlice';
import { createDocumentViewSlice, createViewportSlice, createHideCompletedSlice } from './slices/documentViewSlice';
import { createAgentSlice } from './slices/agentSlice';
import { createNodeEditSlice } from './slices/nodeEditSlice';
import { createSplitMergeSlice } from './slices/splitMergeSlice';
import { createAnnotationSlice } from './slices/annotationSlice';
import { createHistorySlice } from './slices/historySlice';
import { createReplaceSlice, createSearchSlice } from './slices/searchSlice';
import { createPersistenceSlice } from './slices/persistenceSlice';
import { createRenderConfigSlice } from './slices/renderConfigSlice';
import { createReciteSlice, createBlankSlice } from './slices/reciteSlice';
import { createClipboardSlice } from './slices/clipboardSlice';
import { createExcerptSlice } from './slices/excerptSlice';

export type {
  MindMapViewports,
  MindMapViewportView,
  MergeWithPreviousResult,
  MindMapHistoryUiSnapshot,
  MindMapHistoryEntry,
  MindMapConflictSnapshot,
  MindMapStoreState,
  IngestExcerptOptions,
  ExcerptInsertContext,
} from './mindmapStoreTypes';
export { MAX_MINDMAP_DEPTH, MAX_MINDMAP_NODES } from './mindmapStoreHelpers';
export { HISTORY_COALESCE_WINDOW_MS } from './mindmapStoreRuntime';

/** ACR R1-11：agentEnteringIds 使用 Set，需启用 Immer MapSet 插件 */
enableMapSet();

// ============================================================================
// Store 创建
// ============================================================================

export type MindMapStoreApi = StoreApi<MindMapStoreState>;

export function createMindMapStore(): MindMapStoreApi {
  return createStore<MindMapStoreState>()(
    immer((set, get) => {
    const rt = createMindMapStoreRuntime(set, get);

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
      selectionAnchorId: null,
      agentEnteringIds: new Set<string>(),
      agentExitingIds: new Set<string>(),
      agentUpdatedIds: new Set<string>(),
      agentFitViewNonce: 0,
      nodeLocateRequest: null,

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
      conflictSnapshot: null,
      reciteMode: false,
      revealedBlanks: {},
      reciteSessionLog: {},
      reciteReviewQueue: null,
      reciteReviewIndex: 0,
      hideCompleted: false,
      viewRootId: null,
      searchQuery: '',
      searchOptions: {},
      searchResults: [],
      currentSearchIndex: -1,
      searchFilterMode: true,
      viewports: {},
      isExporting: false,
      exportProgress: 0,
      setIsExporting: (isExporting: boolean) => set({ isExporting }),
      setExportProgress: (progress: number) => set({ exportProgress: progress }),
      clipboard: null,
      _reactFlowGetter: null,
      autoExcerptEnabled: false,
      setAutoExcerptEnabled: (enabled: boolean) => set({ autoExcerptEnabled: enabled }),
      excerptIntakeMode: 'direct',
      setExcerptIntakeMode: (mode) => set({ excerptIntakeMode: mode }),
      stagingTrayOpen: false,
      setStagingTrayOpen: (open: boolean) => set({ stagingTrayOpen: open }),
      lastExcerptContext: null,
      excerptRevealRequest: null,

      ...createLifecycleSlice(set, get, rt),
      ...createDocumentViewSlice(set, get, rt),
      ...createAgentSlice(set, get, rt),
      ...createNodeEditSlice(set, get, rt),
      ...createSplitMergeSlice(set, get, rt),
      ...createViewportSlice(set, get, rt),
      ...createAnnotationSlice(set, get, rt),
      ...createHistorySlice(set, get, rt),
      ...createReplaceSlice(set, get, rt),
      ...createPersistenceSlice(set, get, rt),
      ...createRenderConfigSlice(set, get, rt),
      ...createReciteSlice(set, get, rt),
      ...createHideCompletedSlice(set, get, rt),
      ...createBlankSlice(set, get, rt),
      ...createSearchSlice(set, get, rt),
      ...createClipboardSlice(set, get, rt),
      ...createExcerptSlice(set, get, rt),
    };
    })
  );
}

export const defaultMindMapStore = createMindMapStore();

/**
 * MindMapContentView 为每个资源实例提供独立 store；未挂 Provider 的旧入口继续
 * 使用 defaultMindMapStore，保持既有 API 兼容。
 */
export const MindMapStoreContext = createContext<MindMapStoreApi | null>(null);

export function useMindMapStoreApi(): MindMapStoreApi {
  return useContext(MindMapStoreContext) ?? defaultMindMapStore;
}

type MindMapStoreHook = {
  <T>(selector: (state: MindMapStoreState) => T): T;
} & MindMapStoreApi;

const useMindMapStoreSelector = <T,>(selector: (state: MindMapStoreState) => T): T => {
  return useStore(useMindMapStoreApi(), selector);
};

export const useMindMapStore = Object.assign(
  useMindMapStoreSelector,
  defaultMindMapStore,
) as MindMapStoreHook;

const registeredStores = new Map<string, MindMapStoreApi[]>();
const registeredStoresByInstance = new Map<
  string,
  { resourceId: string; store: MindMapStoreApi }
>();
interface MindMapStoreReadyWaiter {
  instanceId?: string;
  windowId?: string;
  callback: (store: MindMapStoreApi) => void;
}
const readyWaiters = new Map<string, Set<MindMapStoreReadyWaiter>>();

function flushReadyWaiters(resourceId: string): void {
  const waiters = readyWaiters.get(resourceId);
  if (!waiters || waiters.size === 0) return;
  for (const waiter of [...waiters]) {
    const store = waiter.instanceId
      ? getMindMapStoreForInstance(waiter.instanceId, resourceId)
      : waiter.windowId
        ? getMindMapStoreForWindow(waiter.windowId, resourceId)
      : getMindMapStoreForResource(resourceId);
    if (!store || store.getState().mindmapId !== resourceId) continue;
    waiters.delete(waiter);
    waiter.callback(store);
  }
  if (waiters.size === 0) readyWaiters.delete(resourceId);
}

/** 注册一个已挂载的资源实例；同资源多实例时最近注册者优先。 */
export function registerMindMapStore(
  resourceId: string,
  store: MindMapStoreApi,
  instanceId?: string,
): () => void {
  const current = registeredStores.get(resourceId) ?? [];
  registeredStores.set(resourceId, [...current.filter((item) => item !== store), store]);
  if (instanceId) registeredStoresByInstance.set(instanceId, { resourceId, store });
  const unsubscribeStore = store.subscribe(() => flushReadyWaiters(resourceId));
  flushReadyWaiters(resourceId);
  return () => {
    unsubscribeStore();
    const next = (registeredStores.get(resourceId) ?? []).filter((item) => item !== store);
    if (next.length > 0) registeredStores.set(resourceId, next);
    else registeredStores.delete(resourceId);
    if (instanceId && registeredStoresByInstance.get(instanceId)?.store === store) {
      registeredStoresByInstance.delete(instanceId);
    }
    flushReadyWaiters(resourceId);
  };
}

/** Agent/Workbench 按资源定位实例；默认 store 仅作为旧入口兼容回退。 */
export function getMindMapStoreForResource(resourceId: string): MindMapStoreApi | null {
  const stores = registeredStores.get(resourceId);
  if (stores && stores.length > 0) return stores[stores.length - 1] ?? null;
  return defaultMindMapStore.getState().mindmapId === resourceId
    ? defaultMindMapStore
    : null;
}

/** Workbench activation 按窗口实例精确定位，避免同资源多宿主时命中最近注册者。 */
export function getMindMapStoreForInstance(
  instanceId: string,
  resourceId?: string,
): MindMapStoreApi | null {
  const entry = registeredStoresByInstance.get(instanceId);
  if (!entry || (resourceId && entry.resourceId !== resourceId)) return null;
  return entry.store;
}

/** Resolve a resource instance owned by a Workbench window, including nested pane ids. */
export function getMindMapStoreForWindow(
  windowId: string,
  resourceId: string,
): MindMapStoreApi | null {
  let matched: MindMapStoreApi | null = null;
  const panePrefix = `${windowId}:`;
  for (const [instanceId, entry] of registeredStoresByInstance) {
    if (
      entry.resourceId === resourceId
      && (instanceId === windowId || instanceId.startsWith(panePrefix))
    ) {
      matched = entry.store;
    }
  }
  return matched;
}

/** 在指定资源的实例完成加载后执行一次；返回取消等待的清理函数。 */
export function subscribeMindMapStoreReady(
  resourceId: string,
  callback: (store: MindMapStoreApi) => void,
  instanceId?: string,
): () => void {
  const readyStore = instanceId
    ? getMindMapStoreForInstance(instanceId, resourceId)
    : getMindMapStoreForResource(resourceId);
  if (readyStore?.getState().mindmapId === resourceId) {
    callback(readyStore);
    return () => undefined;
  }

  const waiters = readyWaiters.get(resourceId) ?? new Set<MindMapStoreReadyWaiter>();
  const waiter = { instanceId, callback };
  waiters.add(waiter);
  readyWaiters.set(resourceId, waiters);
  return () => {
    const current = readyWaiters.get(resourceId);
    if (!current) return;
    current.delete(waiter);
    if (current.size === 0) readyWaiters.delete(resourceId);
  };
}

/** Wait for a resource surface belonging to one Workbench window or nested pane. */
export function subscribeMindMapStoreReadyForWindow(
  resourceId: string,
  windowId: string,
  callback: (store: MindMapStoreApi) => void,
): () => void {
  const readyStore = getMindMapStoreForWindow(windowId, resourceId);
  if (readyStore?.getState().mindmapId === resourceId) {
    callback(readyStore);
    return () => undefined;
  }

  const waiters = readyWaiters.get(resourceId) ?? new Set<MindMapStoreReadyWaiter>();
  const waiter = { windowId, callback };
  waiters.add(waiter);
  readyWaiters.set(resourceId, waiters);
  return () => {
    const current = readyWaiters.get(resourceId);
    if (!current) return;
    current.delete(waiter);
    if (current.size === 0) readyWaiters.delete(resourceId);
  };
}

/** 仅供测试清理资源实例注册表。 */
export function __resetMindMapStoreRegistry(): void {
  registeredStores.clear();
  registeredStoresByInstance.clear();
  readyWaiters.clear();
}
