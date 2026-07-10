/**
 * Store 聚合导出
 * 
 * 统一使用 useMindMapStore（整合版）
 */

// 主 Store（整合文档、UI、历史、API）
export {
  useMindMapStore,
  type MindMapViewports,
  type MindMapViewportView,
  type MergeWithPreviousResult,
} from './mindmapStore';

// 兼容旧导入路径
export { useMindMapStore as useDocumentStore } from './mindmapStore';
export { useMindMapStore as useUIStore } from './mindmapStore';

// Selectors
export {
  selectVisibleNodes,
  selectAllNodes,
  selectSearchResults,
  selectNodeAncestors,
  selectIsNodeSelected,
  selectCurrentSearchResultId,
} from './selectors';
