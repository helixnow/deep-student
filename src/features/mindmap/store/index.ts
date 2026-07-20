/**
 * Store 聚合导出
 * 
 * 统一使用 useMindMapStore（整合版）
 */

// 主 Store（整合文档、UI、历史、API）
export {
  createMindMapStore,
  defaultMindMapStore,
  MindMapStoreContext,
  registerMindMapStore,
  getMindMapStoreForResource,
  getMindMapStoreForInstance,
  getMindMapStoreForWindow,
  subscribeMindMapStoreReady,
  subscribeMindMapStoreReadyForWindow,
  useMindMapStore,
  useMindMapStoreApi,
  MAX_MINDMAP_DEPTH,
  MAX_MINDMAP_NODES,
  HISTORY_COALESCE_WINDOW_MS,
  type MindMapStoreApi,
  type MindMapStoreState,
  type MindMapViewports,
  type MindMapViewportView,
  type MergeWithPreviousResult,
  type MindMapHistoryEntry,
  type MindMapHistoryUiSnapshot,
  type MindMapConflictSnapshot,
} from './mindmapStore';

// 兼容旧导入路径
export { useMindMapStore as useDocumentStore } from './mindmapStore';
export { useMindMapStore as useUIStore } from './mindmapStore';

// Selectors
export {
  selectVisibleNodes,
  selectDisplayRoot,
  selectVisibleNodesInScope,
  selectAllNodes,
  selectSearchResults,
  selectNodeAncestors,
  selectIsNodeSelected,
  selectCurrentSearchResultId,
} from './selectors';
