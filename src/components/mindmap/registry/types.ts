/**
 * 注册表类型定义
 */

import type { MindMapNode, LayoutConfig, LayoutResult, NodeStyle } from '../types';

// ============================================================================
// 布局引擎类型
// ============================================================================

/** 布局类别 */
export type LayoutCategory = 'mindmap' | 'logic' | 'orgchart' | 'custom';

/** 布局方向 */
export type LayoutDirection = 'left' | 'right' | 'both' | 'up' | 'down' | 'radial';

/**
 * 布局引擎接口
 */
export interface ILayoutEngine {
  /** 唯一标识 */
  id: string;
  /** 中文名称 */
  name: string;
  /** 英文名称 */
  nameEn: string;
  /** 描述 */
  description: string;
  /** 布局类别 */
  category: LayoutCategory;
  /** 支持的方向 */
  directions: LayoutDirection[];
  /** 默认方向 */
  defaultDirection: LayoutDirection;
  
  /**
   * 自定义节点组件（可选）
   * 用于覆盖或扩展默认节点类型
   */
  customNodeTypes?: Record<string, React.ComponentType<any>>;
  
  /**
   * 自定义边组件（可选）
   * 用于覆盖或扩展默认边类型
   */
  customEdgeTypes?: Record<string, React.ComponentType<any>>;

  /**
   * 计算布局
   * @param root 根节点
   * @param config 布局配置
   * @param direction 布局方向
   * @returns 布局结果
   */
  calculate(
    root: MindMapNode,
    config: LayoutConfig,
    direction: LayoutDirection
  ): LayoutResult;
}

/**
 * 布局引擎注册信息
 */
export interface LayoutEngineInfo {
  id: string;
  name: string;
  nameEn: string;
  description: string;
  category: LayoutCategory;
  directions: LayoutDirection[];
  defaultDirection: LayoutDirection;
}

// ============================================================================
// 组件注册表类型
// ============================================================================

/** 边类型 */
export type EdgeType = 'curved' | 'straight' | 'step' | 'smoothstep' | 'bezier' | 'orthogonal';

/** 预设分类 */
export type PresetCategory = 'mindmap' | 'logic' | 'orgchart' | 'custom';

/**
 * 节点组件配置
 */
export interface INodeComponentConfig {
  /** 唯一标识 */
  id: string;
  /** 显示名称 */
  name: string;
  /** 描述 */
  description?: string;
  /** React 组件 */
  component: React.ComponentType<any>;
}

/**
 * 边组件配置
 */
export interface IEdgeComponentConfig {
  /** 唯一标识 */
  id: string;
  /** 显示名称 */
  name: string;
  /** 边类型 */
  type: EdgeType;
  /** 描述 */
  description?: string;
  /** React 组件 */
  component: React.ComponentType<any>;
}

// ============================================================================
// 样式注册表类型
// ============================================================================

/**
 * 节点级别样式配置
 */
export interface INodeLevelStyle {
  /** 背景色或渐变 */
  background: string;
  /** 前景色（文字颜色） */
  foreground: string;
  /** 边框样式 */
  border: string;
  /** 圆角大小 */
  borderRadius: number;
  /** 字体大小 */
  fontSize: number;
  /** 字体粗细 */
  fontWeight?: string;
  /** 内边距 */
  padding: string;
  /** 阴影 */
  shadow?: string;
}

/**
 * 主题节点样式配置
 */
export interface IThemeNodeStyle {
  /** 根节点样式 */
  root: INodeLevelStyle;
  /** 分支节点样式 */
  branch: INodeLevelStyle;
  /** 叶子节点样式 */
  leaf: INodeLevelStyle;
}

/**
 * 主题边样式配置
 */
export interface IThemeEdgeStyle {
  /** 边类型 */
  type: EdgeType;
  /** 边颜色 */
  stroke: string;
  /** 边宽度 */
  strokeWidth: number;
  /** 虚线样式 */
  strokeDasharray?: string;
}

/**
 * 主题画布样式配置
 */
export interface IThemeCanvasStyle {
  /** 背景色 */
  background: string;
  /** 网格颜色 */
  gridColor?: string;
}

/**
 * 样式主题配置
 */
export interface IStyleTheme {
  /** 唯一标识 */
  id: string;
  /** 显示名称 */
  name: string;
  /** 英文名称 */
  nameEn?: string;
  /** 描述 */
  description?: string;
  /** 是否在主题选择列表中隐藏（暗色变体自动解析，无需用户手动选择） */
  hidden?: boolean;
  /** 节点样式（新版详细配置） */
  node?: IThemeNodeStyle;
  /** 边样式（新版详细配置） */
  edge?: IThemeEdgeStyle;
  /** 画布样式（新版详细配置） */
  canvas?: IThemeCanvasStyle;
  /** 彩虹分支色板（如果存在，将自动开启彩虹分支模式） */
  palette?: string[];
  /** @deprecated 使用 node 代替 */
  nodeStyle?: Partial<NodeStyle>;
  /** @deprecated 使用 edge 代替 */
  edgeStyle?: {
    stroke?: string;
    strokeWidth?: number;
    strokeDasharray?: string;
  };
  /** @deprecated 使用 canvas 代替 */
  canvasStyle?: {
    background?: string;
    gridColor?: string;
  };
}

// ============================================================================
// 预设注册表类型
// ============================================================================

/**
 * 预设组合配置
 */
export interface IPreset {
  /** 唯一标识 */
  id: string;
  /** 显示名称 */
  name: string;
  /** 英文名称 */
  nameEn?: string;
  /** 描述 */
  description?: string;
  /** 预设分类 */
  category: PresetCategory;
  /** 布局引擎 ID */
  layoutId: string;
  /** 布局方向 */
  layoutDirection: LayoutDirection;
  /** 样式主题 ID */
  styleId?: string;
  /** 边类型 */
  edgeType?: EdgeType;
  /** 是否锁定（内置预设不可删除） */
  locked?: boolean;
  /** 预览图片 URL */
  previewImage?: string;
}
