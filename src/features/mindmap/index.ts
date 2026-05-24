/**
 * 思维导图模块主入口
 * 
 * 该文件作为整个思维导图模块的统一入口，自动初始化并导出所有公共 API
 */

// 初始化模块（自动注册内置组件）
import './init';

// 导出注册系统（包括 LayoutDirection, LayoutCategory, EdgeType 等类型）
export * from './registry';

// 导出布局引擎
export * from './layouts';

// 导出样式主题
export * from './styles';

// 导出预设
export * from './presets';

// 导出类型（排除已从 registry 导出的类型，避免重复导出）
export type {
  MindMapViewType,
  NodeId,
  ThemeId,
  NodeStyle,
  MindMapNodeStyle,
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
} from './types';

// 导出常量
export * from './constants';

// 导出 Store
export { useMindMapStore } from './store';

// 导出组件
export { MindMapCanvas } from './components/mindmap/MindMapCanvas';
export { StructureSelector } from './components/mindmap/StructureSelector';
export { MindMapContentView } from './MindMapContentView';

// 导出工具函数
export * from './utils';
