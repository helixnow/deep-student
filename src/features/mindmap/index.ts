/**
 * 思维导图模块纯 Headless 公共 API 入口
 *
 * 约束：本入口严禁引入副作用初始化（`./init`）、React UI 组件、`@xyflow/react`、`mindmap.css` 或 `jszip`，
 * 以保证 workbench agent driver 等非导图主链路可安全静态依赖而不破坏 `MindMapContentView` 的 `React.lazy` 代码分割。
 */

// 导出纯 TypeScript 类型
export type {
  MindMapViewType,
  NodeId,
  ThemeId,
  NodeStyle,
  MindMapNodeStyle,
  MindMapImage,
  MindMapNode,
  CreateNodeParams,
  UpdateNodeParams,
  NodePath,
  NodeWithParent,
  MindMapMeta,
  DocumentMeta,
  MindMapDocument,
  DocumentSettings,
  CreateDocumentParams,
  LayoutType,
  LayoutDirection,
  LayoutCategory,
  EdgeType,
  LayoutConfig,
  MindMapRenderConfig,
  PresetConfig,
  LayoutNode,
  LayoutResult,
  SubtreeSize,
  ThemeColors,
  NodeTheme,
  EdgeTheme,
  Theme,
  DropPosition,
  DragEventData,
  DropEventData,
  SelectionEvent,
  EditEvent,
  NodeActionType,
  NodeActionEvent,
  HistoryEntry,
  VfsMindMap,
  CreateMindMapParams,
  UpdateMindMapParams,
  LayoutOptions,
  BlankRange,
  MindMapNodeRef,
  MindMapSummaryBrace,
} from './types';

// 导出 Tauri API 封装（含版本历史 API 与类型化错误）
export * from './api';

// 导出常量
export * from './constants';

// 导出 Store 与核心辅助函数
export {
  useMindMapStore,
  MAX_MINDMAP_DEPTH,
  MAX_MINDMAP_NODES,
  getMindMapStoreForResource,
  getMindMapStoreForWindow,
  type MindMapStoreApi,
  type MindMapStoreState,
} from './store';
export { buildNodeIndex } from './store/mindmapStoreHelpers';

// 导出跨特性协作所需的公开纯逻辑工具与互操作函数（供 workbench agent driver 等通过 barrel 访问）
export { reconcileMindMapProjectedFlashcards } from './interop/mindmapCardProjection';
export { syncMindMapAnchorEdges } from './utils/excerptIngest';
export {
  buildCompletedVisibilityIndex,
  resolveVisibleIdFromIndex,
} from './utils/hideCompleted';
export {
  createImageSanitizeBudget,
  sanitizeNodeImages,
} from './utils/imageSanitize';
export { mergeRanges, validateRanges } from './utils/node/blankRanges';
export {
  sanitizeCardNote,
  sanitizeExcerptQuote,
  sanitizeExcerptSlots,
  sanitizeImageAssetId,
  sanitizeNodeAnchors,
} from './utils/nodeAnchors';
export {
  collectSearchPathIds,
  searchMindMapNodeIds,
} from './utils/searchFilter';
export {
  reconcileSummariesWithTree,
  sanitizeDocumentSummaries,
} from './utils/summaryBraces';
