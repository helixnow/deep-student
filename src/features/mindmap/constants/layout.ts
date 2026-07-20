/**
 * 布局常量
 *
 * 字号 / 内边距的权威数据源是 styles/themes 的 getThemeFontMetrics
 * （root 18 / branch 15），布局估算请从那里取值，这里只保留
 * 主题体系不覆盖的布局侧补充常量（note、图标预留等）。
 */

import type { LayoutConfig } from '../types';
import { MM_NODE_LINE_HEIGHT_RATIO } from '../styles/themes';

// ============================================================================
// 布局估算补充常量（主题度量之外的部分）
// ============================================================================

/** 分支节点行内装饰宽度预留（折叠按钮/图标等，叠加在主题 paddingX 之上） */
export const NODE_DECORATION_ALLOWANCE = 16;
/**
 * 根节点文本渲染预留：NodeContent 文本 span 的 px-1（8px）+ 节点 1px 边框 ×2 + 取整余量。
 * 布局估算若不算入，四字中文根节点会差 ~10px 被迫折行（分支节点由
 * NODE_DECORATION_ALLOWANCE 顺带覆盖了同一开销，根节点此前预留为 0）。
 */
export const ROOT_TEXT_RENDER_ALLOWANCE = 12;
/** note 备注字号（text-xs） */
export const NOTE_FONT_SIZE = 12;
/** note 备注行高倍数（leading-tight） */
export const NOTE_LINE_HEIGHT_RATIO = 1.25;

// ============================================================================
// 语义化间距（组织图等结构使用）
// ============================================================================
// LayoutConfig 的 horizontalGap/verticalGap 语义绑定在"思维导图水平展开"上：
// horizontalGap = 父子层级间距，verticalGap = 兄弟间距。
// 组织图（垂直/水平）中排列轴会旋转，这里提供与轴向无关的语义化可选字段：
// - siblingGap：同层兄弟子树之间的间距（沿排列轴）
// - levelGap：父子层级之间的间距（沿展开轴）
// 未提供时回退到 verticalGap/horizontalGap，保证向后兼容。

/** 带语义化间距的布局配置（可选扩展字段，向后兼容 LayoutConfig） */
export interface SemanticSpacingConfig extends LayoutConfig {
  /** 兄弟子树间距（缺省回退 verticalGap） */
  siblingGap?: number;
  /** 父子层级间距（缺省回退 horizontalGap） */
  levelGap?: number;
}

/** 读取兄弟间距（语义化字段优先，回退 verticalGap） */
export function getSiblingGap(config: LayoutConfig): number {
  const gap = (config as SemanticSpacingConfig).siblingGap;
  return Number.isFinite(gap) ? (gap as number) : config.verticalGap;
}

/** 读取层级间距（语义化字段优先，回退 horizontalGap） */
export function getLevelGap(config: LayoutConfig): number {
  const gap = (config as SemanticSpacingConfig).levelGap;
  return Number.isFinite(gap) ? (gap as number) : config.horizontalGap;
}

// ============================================================================
// 深度间距收敛（对标 XMind 的间距节奏）
// ============================================================================
// XMind 的视觉节奏：越深的层级，层距与兄弟距越紧。规则：
//   scale(depth) = max(min, ratio^depth)
// 其中 depth 为「拥有这段间距的父节点」的层级（根 = 0）：
// - 父节点 level L 与其子节点之间的层距 = horizontalGap × scale(L)
// - 父节点 level L 的子节点之间的兄弟距 = verticalGap × scale(L)
// 因此根 → 一级的间距恒为 scale(0) = 1，保持现值不变。
//
// 默认 ratio 0.9 / min 0.6：每深一层收紧 10%，第 5 层起触底
// （0.9^5 ≈ 0.590 < 0.6），深层间距稳定在 0.6×，节奏收敛但不粘连。
//
// 通过 LayoutConfig 可选扩展字段 depthGapScaling 控制：
// - 缺省（undefined）→ 默认开启（DEFAULT_DEPTH_GAP_SCALING）
// - false → 显式关闭，所有 scale 恒为 1，输出与旧布局逐位一致
//   （x × 1 在 IEEE754 中为恒等运算，不引入浮点漂移）
// - { ratio, min } → 自定义收敛系数

/** 深度间距收敛参数 */
export interface DepthGapScaling {
  /** 每深一层的收敛比（0 < ratio <= 1） */
  ratio: number;
  /** 收敛下限（0 < min <= 1，触底后不再收紧） */
  min: number;
}

/** 带深度间距收敛开关的布局配置（可选扩展字段，向后兼容 LayoutConfig） */
export interface DepthGapScalingConfig extends LayoutConfig {
  /** 深度间距收敛：缺省开启（默认系数）；false 显式关闭；对象自定义系数 */
  depthGapScaling?: DepthGapScaling | false;
}

/** 默认收敛系数（每层 ×0.9，下限 0.6×） */
export const DEFAULT_DEPTH_GAP_SCALING: DepthGapScaling = { ratio: 0.9, min: 0.6 };

/**
 * 计算指定深度的间距收敛系数
 * @param config 布局配置（读取可选 depthGapScaling 字段）
 * @param depth 拥有该间距的父节点层级（根 = 0）
 * @returns 收敛系数；depth <= 0 或收敛关闭时恒为 1
 */
export function depthGapScale(config: LayoutConfig, depth: number): number {
  if (depth <= 0) return 1;
  const raw = (config as DepthGapScalingConfig).depthGapScaling;
  if (raw === false) return 1;
  let ratio = DEFAULT_DEPTH_GAP_SCALING.ratio;
  let min = DEFAULT_DEPTH_GAP_SCALING.min;
  if (raw) {
    // 字段级防御：持久化文档可能带入非法值，逐字段回退默认系数
    if (Number.isFinite(raw.ratio) && raw.ratio > 0 && raw.ratio <= 1) ratio = raw.ratio;
    if (Number.isFinite(raw.min) && raw.min > 0 && raw.min <= 1) min = raw.min;
  }
  return Math.max(min, Math.pow(ratio, depth));
}

/** 指定父层级的层距（horizontalGap × scale(depth)） */
export function getDepthHorizontalGap(config: LayoutConfig, depth: number): number {
  return config.horizontalGap * depthGapScale(config, depth);
}

/** 指定父层级的兄弟距（verticalGap × scale(depth)） */
export function getDepthVerticalGap(config: LayoutConfig, depth: number): number {
  return config.verticalGap * depthGapScale(config, depth);
}

/** 默认布局配置 - 平衡风格 */
export const DEFAULT_LAYOUT_CONFIG: LayoutConfig = {
  horizontalGap: 80,  // Tighter horizontal gap (was 100)
  verticalGap: 24,    // ★ 2026-01-31 修复：增加垂直间距避免重叠 (was 18)
  nodeMinWidth: 60,   // ★ 2026-01-31 增加最小宽度防止文字竖排 (was 40)
  nodeMaxWidth: 300,
  nodeHeight: 34,     // Slightly smaller (was 36)
  rootNodeHeight: 44,
  direction: 'right',
};

/** 紧凑布局配置 */
export const COMPACT_LAYOUT_CONFIG: LayoutConfig = {
  horizontalGap: 60,
  verticalGap: 12,
  nodeMinWidth: 60,   // ★ 2026-01-31 增加最小宽度防止文字竖排 (was 40)
  nodeMaxWidth: 200,
  nodeHeight: 28,
  rootNodeHeight: 36,
  direction: 'right',
};

/** 宽松布局配置 - Presentation Style */
export const SPACIOUS_LAYOUT_CONFIG: LayoutConfig = {
  horizontalGap: 140,
  verticalGap: 32,
  nodeMinWidth: 80,
  nodeMaxWidth: 360,
  nodeHeight: 44,
  rootNodeHeight: 52,
  direction: 'right',
};

// ============================================================================
// 节点高度估算（从 CSS 样式推算布局高度）
// ============================================================================

type NodeStyleSize = { fontSize?: number; padding?: string };

const DEFAULT_TEXT_LINE_HEIGHT = MM_NODE_LINE_HEIGHT_RATIO;

/** 根节点默认样式尺寸（与 styles/themes/default 的 node.root 保持同步） */
export const ROOT_NODE_STYLE: NodeStyleSize = { fontSize: 18, padding: '10px 20px' };

/**
 * 解析 CSS padding 值，提取上下内边距
 */
export function parsePadding(padding?: string): { top: number; bottom: number } {
  if (!padding) {
    return { top: 0, bottom: 0 };
  }
  const parts = padding
    .trim()
    .split(/\s+/)
    .map((part) => parseFloat(part))
    .filter((value) => !Number.isNaN(value));
  if (parts.length === 1) {
    return { top: parts[0], bottom: parts[0] };
  }
  if (parts.length === 2) {
    return { top: parts[0], bottom: parts[0] };
  }
  if (parts.length === 3) {
    return { top: parts[0], bottom: parts[2] };
  }
  if (parts.length >= 4) {
    return { top: parts[0], bottom: parts[2] };
  }
  return { top: 0, bottom: 0 };
}

/**
 * 从主题节点样式推算基础布局高度
 */
export function calculateBaseNodeHeight(
  style: NodeStyleSize | undefined,
  fallbackFontSize: number,
  fallbackPadding: string
): number {
  const fontSize = style?.fontSize ?? fallbackFontSize;
  const padding = style?.padding ?? fallbackPadding;
  const { top, bottom } = parsePadding(padding);
  return Math.ceil(fontSize * DEFAULT_TEXT_LINE_HEIGHT + top + bottom);
}

/** ReactFlow 配置 */
export const REACTFLOW_CONFIG = {
  minZoom: 0.1,
  maxZoom: 2,
  fitViewPadding: 0.2,
  snapToGrid: false,
  // 滚轮/触控板语义（默认对齐 XMind/MindNode/macOS 平台习惯）：
  // 双指滑动/滚轮 = 平移画布，pinch 或 Cmd/Ctrl+滚轮 = 缩放。
  // 旧「滚轮直接缩放」保留为用户偏好（useCanvasWheelMode，localStorage），
  // MindMapCanvas 按偏好在这两组值之间切换（见 WHEEL_MODE_*_PROPS）。
  panOnScroll: true,
  zoomOnScroll: false,
  // 触屏双指捏合缩放（捏合手势自带的双指平移由 xyflow 一并处理）
  zoomOnPinch: true,
  // 触点抖动容差：位移超过 ~8px 才认定为节点拖拽，减少触屏误拖
  nodeDragThreshold: 8,
  nodesDraggable: false,
  nodesConnectable: true,
  elementsSelectable: true,
};

/** 滚轮偏好 = pan（默认）：双指/滚轮平移，Cmd/Ctrl+滚轮或 pinch 缩放 */
export const WHEEL_MODE_PAN_PROPS = {
  panOnScroll: true,
  zoomOnScroll: false,
  zoomActivationKeyCode: ['Meta', 'Control'] as string[],
} as const;

/** 滚轮偏好 = zoom（旧行为）：滚轮直接缩放，平移靠拖空白 / Space / 中键 */
export const WHEEL_MODE_ZOOM_PROPS = {
  panOnScroll: false,
  zoomOnScroll: true,
  zoomActivationKeyCode: ['Meta', 'Control'] as string[],
} as const;
