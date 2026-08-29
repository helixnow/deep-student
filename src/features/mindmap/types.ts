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
  fontStyle?: 'normal' | 'italic';
  textDecoration?: 'none' | 'underline' | 'line-through';
  headingLevel?: 'h1' | 'h2' | 'h3';
  icon?: string;
  /**
   * 完成态以 checkbox 视觉呈现（默认仅划线）。
   * 渲染：NodeContent 在正文前渲染可点击勾选框，点击切换 `completed`。
   */
  showCheckbox?: boolean;
}

// 兼容别名
export type MindMapNodeStyle = NodeStyle;

/**
 * 节点内嵌图片（导入时从 .xmind/.mmap 压缩包提取的小图，以 data URL 内联存储）。
 * 超过大小阈值的图片不内联，仍走备注占位文案；见 importers 中的 resource 提取逻辑。
 */
export interface MindMapImage {
  /**
   * data URL（data:image/png;base64,...）或 https 地址。
   * 外部入口（JSON 导入 / 剪贴板结构化载荷）经 utils/imageSanitize 运行时清洗：
   * data URL 限白名单 MIME + 体积预算，远程地址仅放行 https。
   */
  src: string;
  /** 原始文件名（可选，悬停提示用） */
  name?: string;
  /** 原始宽度（px，可选） */
  width?: number;
  /** 原始高度（px，可选） */
  height?: number;
}

/** 节点关联的 VFS 资源引用（轻量级，只存引用信息） */
export interface MindMapNodeRef {
  /** 稳定的业务 ID（note_abc, tb_xyz, mm_xxx 等） */
  sourceId: string;
  /** 资源类型 */
  type: string;
  /** 显示名称（快照，用于离线/加载前显示） */
  name: string;
  /** 资源内容 hash（可选，用于失效检测） */
  resourceHash?: string;
}

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
  /** 关联的 VFS 资源引用列表 */
  refs?: MindMapNodeRef[];
  /**
   * 优先级（1–6；1 最高）。渲染为正文前的圆形数字徽标。
   * 写入入口由样式/属性面板负责（W08），undefined 表示无优先级。
   */
  priority?: number;
  /**
   * 进度百分比（0–100）。渲染为正文前的小进度环。
   * undefined 表示不显示进度。
   */
  progress?: number;
  /**
   * 节点超链接（http/https/mailto）。渲染为正文后的链接图标，点击经安全白名单打开。
   */
  href?: string;
  /** 内嵌图片列表（导入内联小图；画布渲染缩略图，大纲渲染角标） */
  images?: MindMapImage[];
  // 运行时注入属性
  branchColor?: string;
}

/** 创建节点参数 */
export interface CreateNodeParams {
  text?: string;
  note?: string;
  style?: NodeStyle;
}

/**
 * 更新节点参数。
 * 出现在 patch 中且值为 `undefined` 的键会从节点上删除（如 `{ completed: undefined }` 移除任务标记）；
 * 未出现的键保持不变。
 */
export interface UpdateNodeParams {
  text?: string;
  note?: string;
  collapsed?: boolean;
  completed?: boolean;
  style?: NodeStyle;
  blankedRanges?: BlankRange[];
  refs?: MindMapNodeRef[];
  /** 优先级（1–6；显式 undefined 移除） */
  priority?: number;
  /** 进度百分比（0–100；显式 undefined 移除） */
  progress?: number;
  /** 超链接（显式 undefined 移除） */
  href?: string;
  /** 内嵌图片列表（显式 undefined 移除） */
  images?: MindMapImage[];
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

/**
 * 多画布（sheet）元数据 —— 多 sheet 数据模型第一步。
 *
 * 当前运行时仍是单树模型：多 sheet 文件导入时合并为「虚拟根 + 每 sheet 一个
 * 一级子节点」。本结构把「哪个一级子节点来自哪个 sheet」显式记录进 meta，
 * 供未来的多画布 UI 直接升格使用；所有现有读取方可安全忽略此字段。
 */
export interface MindMapSheetMeta {
  /** sheet 标识（导入时生成，文档内唯一） */
  id: string;
  /** sheet 标题（源文件 sheet 名，缺省回退根主题标题） */
  title: string;
  /** 该 sheet 对应的节点 id（虚拟根的直接子节点） */
  rootNodeId: string;
}

export interface MindMapMeta {
  createdAt: string;
  updatedAt?: string;
  lastFocusId?: string;
  theme?: string;
  /** 渲染配置 */
  renderConfig?: MindMapRenderConfig;
  /** 多 sheet 导入来源记录（单树模型不消费；见 MindMapSheetMeta） */
  sheets?: MindMapSheetMeta[];
}

// 兼容别名
export type DocumentMeta = MindMapMeta;

/** 关联线样式（跨分支自由连线，非父子边） */
export interface AssociationStyle {
  stroke?: string;
  strokeWidth?: number;
  strokeDasharray?: string;
}

/** 跨分支关联线 */
export interface MindMapAssociation {
  id: string;
  source: NodeId;
  target: NodeId;
  label?: string;
  style?: AssociationStyle;
}

export interface MindMapDocument {
  version: '1.0';
  root: MindMapNode;
  meta: MindMapMeta;
  /** 跨分支关联线；布局引擎不消费此字段 */
  associations?: MindMapAssociation[];
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
