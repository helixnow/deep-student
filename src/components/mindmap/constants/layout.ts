/**
 * 布局常量
 */

import type { LayoutConfig } from '../types';

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

const DEFAULT_TEXT_LINE_HEIGHT = 1.5;

/** 根节点默认样式尺寸 */
export const ROOT_NODE_STYLE: NodeStyleSize = { fontSize: 18, padding: '12px 24px' };

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
  panOnScroll: false,
  zoomOnScroll: true,
  nodesDraggable: false,
  nodesConnectable: true,
  elementsSelectable: true,
};

