/**
 * Store 聚合导出
 * 
 * 统一使用 useMindMapStore（整合版）
 */

// 主 Store（整合文档、UI、历史、API）
export { useMindMapStore } from './mindmapStore';

// 兼容旧导入路径
export { useMindMapStore as useDocumentStore } from './mindmapStore';
export { useMindMapStore as useUIStore } from './mindmapStore';

// 历史 Store（独立）
export {
  useHistoryStore,
  type HistoryItem,
  type HistoryState,
  type HistoryActions,
  type HistoryStore,
} from './historyStore';

// Selectors
export {
  selectVisibleNodes,
  selectAllNodes,
  selectSearchResults,
  selectNodeAncestors,
  selectIsNodeSelected,
  selectCurrentSearchResultId,
} from './selectors';
