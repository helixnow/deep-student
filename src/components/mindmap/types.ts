/**
 * 思维导图模块类型定义
 * 
 * 这是主要的类型定义文件，types/ 目录中的文件也会重新导出这些类型
 */

export type MindMapViewType = 'outline' | 'mindmap';

// ============================================================================
// 挖空（背诵模式）相关类型
// ============================================================================

/** 挖空区间 */
export interface BlankRange {
  start: number;  // inclusive
  end: number;    // exclusive
}

// ============================================================================
// 节点相关类型
// ============================================================================

/** 节点 ID */
export type NodeId = string;

/** 主题 ID */
export type ThemeId = 'default' | 'dark' | 'minimal' | 'colorful' | string;

/** 节点样式 */
export interface NodeStyle {
  bgColor?: string;
  textColor?: string;
  fontSize?: number;
  fontWeight?: 'normal' | 'bold';
  icon?: string;
}

// 兼容别名
export type MindMapNodeStyle = NodeStyle;

/** 思维导图节点 */
export interface MindMapNode {
  id: NodeId;
  text: string;
  note?: string;
  children: MindMapNode[];
  collapsed?: boolean;
  completed?: boolean;
  style?: NodeStyle;
  /** 挖空区间（背诵模式） */
  blankedRanges?: BlankRange[];
  // 运行时注入属性
  branchColor?: string;
}

/** 创建节点参数 */
export interface CreateNodeParams {
  text?: string;
  note?: string;
  style?: NodeStyle;
}

/** 更新节点参数 */
export interface UpdateNodeParams {
  text?: string;
  note?: string;
  collapsed?: boolean;
  completed?: boolean;
  style?: NodeStyle;
  blankedRanges?: BlankRange[];
}

/** 节点路径（从根到当前节点的 ID 数组） */
export type NodePath = NodeId[];

/** 节点与父节点的关系 */
export interface NodeWithParent {
  node: MindMapNode;
  parent: MindMapNode | null;
  index: number;
  path: NodePath;
  depth: number;
}

// ============================================================================
// 文档相关类型
// ============================================================================

export interface MindMapMeta {
  createdAt: string;
  updatedAt?: string;
  lastFocusId?: string;
  theme?: string;
  /** 渲染配置 */
  renderConfig?: MindMapRenderConfig;
}

// 兼容别名
export type DocumentMeta = MindMapMeta;

export interface MindMapDocument {
  version: '1.0';
  root: MindMapNode;
  meta: MindMapMeta;
}

export interface DocumentSettings {
  defaultView: MindMapViewType;
  theme?: ThemeId;
  autoSave?: boolean;
  autoSaveInterval?: number;
}

export interface CreateDocumentParams {
  title?: string;
  settings?: Partial<DocumentSettings>;
}

// ============================================================================
// 布局类型
// ============================================================================

// Import types from registry for local use
import type {
  LayoutDirection as RegistryLayoutDirection,
  LayoutCategory as RegistryLayoutCategory,
  EdgeType as RegistryEdgeType,
} from './registry/types';

// Re-export from registry to ensure type consistency across the codebase
export type LayoutDirection = RegistryLayoutDirection;
export type LayoutCategory = RegistryLayoutCategory;
export type EdgeType = RegistryEdgeType;

/** 布局类型 */
export type LayoutType = 'tree' | 'balanced' | 'logic-tree' | 'logic-balanced' | 'orgchart-vertical' | 'orgchart-horizontal';

/** 布局配置 */
export interface LayoutConfig {
  /** 水平间距 */
  horizontalGap: number;
  /** 垂直间距 */
  verticalGap: number;
  /** 节点最小宽度 */
  nodeMinWidth: number;
  /** 节点最大宽度 */
  nodeMaxWidth: number;
  /** 节点高度 */
  nodeHeight: number;
  /** 根节点高度 */
  rootNodeHeight: number;
  /** 实测节点高度（nodeId -> height） */
  measuredNodeHeights?: Record<string, number>;
  /** 布局方向 */
  direction: LayoutDirection;
  /** 布局类型 */
  layoutType?: LayoutType;
  /** 边类型 */
  edgeType?: EdgeType;
}

/** 思维导图渲染配置 */
export interface MindMapRenderConfig {
  /** 布局ID */
  layoutId: string;
  /** 布局方向 */
  direction: LayoutDirection;
  /** 样式主题ID */
  styleId: string;
  /** 边类型 */
  edgeType: EdgeType;
  /** 布局参数配置 */
  layoutConfig: LayoutConfig;
}

/** 预设配置 */
export interface PresetConfig {
  /** 预设ID */
  id: string;
  /** 预设名称（中文） */
  name: string;
  /** 预设名称（英文） */
  nameEn: string;
  /** 布局分类 */
  category: LayoutCategory;
  /** 布局ID */
  layoutId: string;
  /** 布局方向 */
  direction: LayoutDirection;
  /** 样式ID */
  styleId: string;
  /** 边类型 */
  edgeType: EdgeType;
  /** 是否锁定（不可编辑） */
  locked?: boolean;
  /** 缩略图路径 */
  thumbnail?: string;
}

/** 计算后的节点位置 */
export interface LayoutNode {
  id: NodeId;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  isRoot: boolean;
  isCollapsed: boolean;
  hasChildren: boolean;
  childCount: number;
  data: MindMapNode;
}

/** 布局结果 */
export interface LayoutResult {
  nodes: import('@xyflow/react').Node[];
  edges: import('@xyflow/react').Edge[];
  bounds: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    width: number;
    height: number;
  };
}

/** 子树尺寸信息 */
export interface SubtreeSize {
  width: number;
  height: number;
  childHeights: number[];
}

// ============================================================================
// 主题类型
// ============================================================================

/** 颜色定义 */
export interface ThemeColors {
  background: string;
  foreground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  border: string;
  accent: string;
}

/** 节点主题样式 */
export interface NodeTheme {
  root: {
    background: string;
    foreground: string;
    border: string;
    borderRadius: number;
    fontSize: number;
    fontWeight: string;
    padding: string;
  };
  branch: {
    background: string;
    foreground: string;
    border: string;
    borderRadius: number;
    fontSize: number;
    padding: string;
  };
  leaf: {
    background: string;
    foreground: string;
    border: string;
    borderRadius: number;
    fontSize: number;
    padding: string;
  };
}

/** 连接线主题样式 */
export interface EdgeTheme {
  stroke: string;
  strokeWidth: number;
  strokeDasharray?: string;
}

/** 完整主题配置 */
export interface Theme {
  id: ThemeId;
  name: string;
  colors: ThemeColors;
  node: NodeTheme;
  edge: EdgeTheme;
}

// ============================================================================
// 事件类型
// ============================================================================

export type DropPosition = 'before' | 'after' | 'inside';

export interface DragEventData {
  nodeId: NodeId;
  sourceParentId: NodeId | null;
  sourceIndex: number;
}

export interface DropEventData {
  targetNodeId: NodeId;
  position: DropPosition;
}

export interface SelectionEvent {
  nodeIds: NodeId[];
  isMultiSelect: boolean;
}

export interface EditEvent {
  nodeId: NodeId;
  field: 'text' | 'note';
  oldValue: string;
  newValue: string;
}

export type NodeActionType =
  | 'add'
  | 'delete'
  | 'move'
  | 'update'
  | 'collapse'
  | 'expand';

export interface NodeActionEvent {
  type: NodeActionType;
  nodeId: NodeId;
  payload?: unknown;
}

export interface HistoryEntry {
  type: NodeActionType;
  timestamp: number;
  data: unknown;
}

// ============================================================================
// VFS 后端类型（与 Rust 后端保持一致）
// ============================================================================

export interface VfsMindMap {
  id: string;
  resourceId: string;
  title: string;
  description?: string;
  isFavorite: boolean;
  defaultView: MindMapViewType;
  theme?: string;
  settings?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface CreateMindMapParams {
  title: string;
  description?: string;
  content?: string;
  defaultView?: MindMapViewType;
  theme?: string;
  folderId?: string;
}

export interface UpdateMindMapParams {
  title?: string;
  description?: string;
  content?: string;
  defaultView?: MindMapViewType;
  theme?: string;
  settings?: Record<string, unknown>;
  /** 乐观并发控制：期望的服务端 updatedAt */
  expectedUpdatedAt?: string;
}

// ============================================================================
// 布局计算相关类型（兼容旧代码）
// ============================================================================

export interface LayoutOptions {
  horizontalGap: number;
  verticalGap: number;
  nodeWidth: number;
  nodeHeight: number;
  direction: 'horizontal' | 'vertical';
}
