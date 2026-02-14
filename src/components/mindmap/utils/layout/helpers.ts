/**
 * 布局辅助函数
 */

import type { MindMapNode, LayoutConfig, SubtreeSize } from '../../types';
import { DEFAULT_LAYOUT_CONFIG } from '../../constants';

/**
 * 最大递归深度限制
 * ★ P0 修复：防止深嵌套数据导致栈溢出
 */
const MAX_HELPER_DEPTH = 500;

/** 计算节点文本宽度（估算） */
export function estimateTextWidth(text: string, fontSize: number = 14): number {
  // 安全检查：防止 text 为 undefined 或 null
  if (!text) {
    return 0;
  }
  // 简单估算：中文字符宽度约等于字号，英文字符约等于字号的 0.6 倍
  let width = 0;
  for (const char of text) {
    if (/[\u4e00-\u9fa5]/.test(char)) {
      width += fontSize;
    } else {
      width += fontSize * 0.6;
    }
  }
  return width;
}

/** 估算文本在指定宽度下的行数（支持中文宽度） */
function estimateWrappedLines(text: string, fontSize: number, maxWidth: number): number {
  if (!text) {
    return 0;
  }
  const safeWidth = Math.max(1, maxWidth);
  return text.split('\n').reduce((total, line) => {
    const lineWidth = estimateTextWidth(line, fontSize);
    const lineCount = Math.max(1, Math.ceil(lineWidth / safeWidth));
    return total + lineCount;
  }, 0);
}

/** 计算节点实际宽度 */
export function calculateNodeWidth(
  node: MindMapNode,
  config: LayoutConfig = DEFAULT_LAYOUT_CONFIG,
  isRoot: boolean = false
): number {
  // 根节点渲染字号默认 18px、padding 24px*2=48px
  // 分支节点渲染字号默认 14px、padding 约 12px*2+图标=40px
  const defaultFontSize = isRoot ? 18 : 14;
  const fontSize = node.style?.fontSize || defaultFontSize;
  const textWidth = estimateTextWidth(node.text, fontSize);
  
  // 根节点 padding 更大（12px 24px → 水平 48px）
  const padding = isRoot ? 48 : 40;
  const width = textWidth + padding;
  
  // 如果有 note，宽度稍微增加一点以示区别（可选）
  const finalWidth = node.note ? Math.max(width, 100) : width;
  
  return Math.max(config.nodeMinWidth, Math.min(finalWidth, config.nodeMaxWidth));
}

/** 计算节点高度 */
export function calculateNodeHeight(
  node: MindMapNode,
  isRoot: boolean,
  config: LayoutConfig = DEFAULT_LAYOUT_CONFIG
): number {
  const baseHeight = isRoot ? config.rootNodeHeight : config.nodeHeight;

  const measuredHeight = config.measuredNodeHeights?.[node.id];
  if (Number.isFinite(measuredHeight) && (measuredHeight as number) > 0) {
    return measuredHeight as number;
  }

  // 文本行高估算：默认 line-height 1.5
  const textFontSize = node.style?.fontSize || (isRoot ? 18 : 15);
  const textLineHeight = Math.ceil(textFontSize * 1.5);
  const textLines = Math.max(1, (node.text || '').split('\n').length);
  const extraTextHeight = (textLines - 1) * textLineHeight;

  const totalHeight = baseHeight + extraTextHeight;

  if (!node.note && !node.refs?.length) {
    return totalHeight;
  }

  // Estimate note height (whitespace-pre-wrap)
  let extraHeight = 0;
  if (node.note) {
    const nodeWidth = calculateNodeWidth(node, config, isRoot);
    // Approximate width available for text (minus padding)
    const contentWidth = nodeWidth - 16;
    // Note font size approx 12px
    const noteFontSize = 12;
    const noteLines = estimateWrappedLines(node.note, noteFontSize, contentWidth);
    // Line height approx 1.25 (text-xs leading-tight)
    const noteLineHeight = Math.ceil(noteFontSize * 1.25);
    extraHeight += noteLines * noteLineHeight + 4; // +4 for margin-top
  }

  // Estimate refs height: each ref card ≈ 24px (icon + text + padding) + 4px gap
  if (node.refs && node.refs.length > 0) {
    extraHeight += node.refs.length * 24 + 4; // +4 for margin-top
  }

  return totalHeight + extraHeight;
}

/** 计算子树高度（递归）
 * ★ P0 修复：添加深度限制参数
 */
export function calculateSubtreeHeight(
  node: MindMapNode,
  config: LayoutConfig = DEFAULT_LAYOUT_CONFIG,
  isRoot: boolean = false,
  depth: number = 0
): number {
  // 深度限制检查
  if (depth > MAX_HELPER_DEPTH) {
    console.warn(`[helpers] calculateSubtreeHeight depth exceeds limit (${MAX_HELPER_DEPTH})`);
    return config.nodeHeight;
  }

  // ★ 2026-01-31 修复：使用实际节点高度而不是固定高度
  const nodeHeight = calculateNodeHeight(node, isRoot, config);
  
  if (node.collapsed || !node.children || node.children.length === 0) {
    return nodeHeight;
  }
  
  let totalHeight = 0;
  for (let i = 0; i < node.children.length; i++) {
    // 子节点不是根节点
    totalHeight += calculateSubtreeHeight(node.children[i], config, false, depth + 1);
    if (i < node.children.length - 1) {
      totalHeight += config.verticalGap;
    }
  }
  
  return Math.max(nodeHeight, totalHeight);
}

/** 计算子树尺寸信息
 * ★ P0 修复：添加深度限制参数
 */
export function calculateSubtreeSize(
  node: MindMapNode,
  config: LayoutConfig = DEFAULT_LAYOUT_CONFIG,
  isRoot: boolean = false,
  depth: number = 0
): SubtreeSize {
  // 深度限制检查
  if (depth > MAX_HELPER_DEPTH) {
    console.warn(`[helpers] calculateSubtreeSize depth exceeds limit (${MAX_HELPER_DEPTH})`);
    return {
      width: config.nodeMinWidth,
      height: config.nodeHeight,
      childHeights: [],
    };
  }

  const nodeWidth = calculateNodeWidth(node, config);
  // ★ 2026-01-31 修复：使用实际节点高度
  const nodeHeight = calculateNodeHeight(node, isRoot, config);
  
  if (node.collapsed || !node.children || node.children.length === 0) {
    return {
      width: nodeWidth,
      height: nodeHeight,
      childHeights: [],
    };
  }
  
  const childSizes = node.children.map(child => calculateSubtreeSize(child, config, false, depth + 1));
  const childHeights = childSizes.map(size => size.height);
  const maxChildWidth = Math.max(...childSizes.map(size => size.width));
  
  const totalChildHeight = childHeights.reduce((sum, h, i) => 
    sum + h + (i > 0 ? config.verticalGap : 0), 0
  );
  
  return {
    width: nodeWidth + config.horizontalGap + maxChildWidth,
    height: Math.max(nodeHeight, totalChildHeight),
    childHeights,
  };
}

/** 计算布局边界 */
export function calculateBounds(
  nodes: Array<{ x: number; y: number; width?: number; height?: number }>
): { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number } {
  if (nodes.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  }
  
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  
  for (const node of nodes) {
    const width = node.width || 100;
    const height = node.height || 36;
    
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + width);
    maxY = Math.max(maxY, node.y + height);
  }
  
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

interface LayoutNodeLike {
  id: string;
  position: { x: number; y: number };
  data?: { isRoot?: boolean };
}

interface SubtreeBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function getNodeBounds(
  node: MindMapNode,
  layoutNode: LayoutNodeLike | undefined,
  config: LayoutConfig,
  isRoot: boolean
): SubtreeBounds {
  const width = calculateNodeWidth(node, config);
  const height = calculateNodeHeight(node, isRoot, config);
  const x = layoutNode?.position.x ?? 0;
  const y = layoutNode?.position.y ?? 0;
  return {
    minX: x,
    maxX: x + width,
    minY: y,
    maxY: y + height,
  };
}

function mergeBounds(a: SubtreeBounds, b: SubtreeBounds): SubtreeBounds {
  return {
    minX: Math.min(a.minX, b.minX),
    maxX: Math.max(a.maxX, b.maxX),
    minY: Math.min(a.minY, b.minY),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

function shiftBounds(bounds: SubtreeBounds, deltaY: number): SubtreeBounds {
  return {
    minX: bounds.minX,
    maxX: bounds.maxX,
    minY: bounds.minY + deltaY,
    maxY: bounds.maxY + deltaY,
  };
}/**
 * 移动子树
 * ★ P0 修复：添加深度限制参数
 */
function shiftSubtree(
  node: MindMapNode,
  nodesById: Map<string, LayoutNodeLike>,
  deltaY: number,
  depth: number = 0
): void {
  // 深度限制检查
  if (depth > MAX_HELPER_DEPTH) {
    console.warn(`[helpers] shiftSubtree depth exceeds limit (${MAX_HELPER_DEPTH})`);
    return;
  }

  const layoutNode = nodesById.get(node.id);
  if (layoutNode) {
    layoutNode.position.y += deltaY;
  }
  if (node.collapsed || !node.children || node.children.length === 0) {
    return;
  }
  node.children.forEach(child => shiftSubtree(child, nodesById, deltaY, depth + 1));
}/**
 * 递归消除子树重叠（按实际节点高度）
 * 仅在同侧（X 范围重叠）时施加垂直分离
 * ★ P0 修复：添加深度限制参数
 */
export function resolveSubtreeOverlaps(
  node: MindMapNode,
  nodesById: Map<string, LayoutNodeLike>,
  config: LayoutConfig,
  isRoot: boolean = false,
  depth: number = 0
): SubtreeBounds {
  const layoutNode = nodesById.get(node.id);
  const nodeBounds = getNodeBounds(node, layoutNode, config, isRoot);  // 深度限制检查
  if (depth > MAX_HELPER_DEPTH) {
    console.warn(`[helpers] resolveSubtreeOverlaps depth exceeds limit (${MAX_HELPER_DEPTH})`);
    return nodeBounds;
  }

  if (node.collapsed || !node.children || node.children.length === 0) {
    return nodeBounds;
  }

  const parentCenterX = (nodeBounds.minX + nodeBounds.maxX) / 2;  const childrenWithBounds = node.children.map(child => ({
    node: child,
    bounds: resolveSubtreeOverlaps(child, nodesById, config, false, depth + 1),
  }));

  const leftChildren = childrenWithBounds.filter(({ bounds }) => bounds.maxX <= parentCenterX);
  const rightChildren = childrenWithBounds.filter(({ bounds }) => bounds.minX >= parentCenterX);
  const overlapChildren = childrenWithBounds.filter(
    ({ bounds }) => bounds.minX < parentCenterX && bounds.maxX > parentCenterX
  );

  const applySeparation = (items: Array<{ node: MindMapNode; bounds: SubtreeBounds }>) => {
    let prev: SubtreeBounds | null = null;
    items.forEach(item => {
      if (prev && item.bounds.minY < prev.maxY + config.verticalGap) {
        const delta = prev.maxY + config.verticalGap - item.bounds.minY;
        shiftSubtree(item.node, nodesById, delta, depth + 1);
        item.bounds = shiftBounds(item.bounds, delta);
      }
      prev = item.bounds;
    });
  };

  applySeparation(leftChildren);
  applySeparation(rightChildren);
  applySeparation(overlapChildren);  return childrenWithBounds.reduce(
    (acc, current) => mergeBounds(acc, current.bounds),
    nodeBounds
  );
}

/**
 * 重叠消除后，将每个父节点重新居中于其子节点的实际垂直范围
 * ★ 2026-02 新增：确保分支点视觉居中
 */
export function recenterParents(
  node: MindMapNode,
  nodesById: Map<string, LayoutNodeLike>,
  config: LayoutConfig,
  isRoot: boolean = false,
  depth: number = 0
): void {
  if (depth > MAX_HELPER_DEPTH) return;
  if (node.collapsed || !node.children || node.children.length === 0) return;

  // 先递归处理子树（自底向上）
  node.children.forEach(child => recenterParents(child, nodesById, config, false, depth + 1));

  const parentNode = nodesById.get(node.id);
  if (!parentNode) return;

  // 收集所有直接子节点的布局位置
  const childLayoutNodes = node.children
    .map(c => nodesById.get(c.id))
    .filter((n): n is LayoutNodeLike => !!n);
  if (childLayoutNodes.length === 0) return;

  const parentHeight = calculateNodeHeight(node, isRoot, config);

  // 子节点的实际 Y 范围
  const firstChildY = childLayoutNodes[0].position.y;
  const lastChild = childLayoutNodes[childLayoutNodes.length - 1];
  const lastChildHeight = calculateNodeHeight(
    node.children[node.children.length - 1], false, config
  );
  const lastChildBottom = lastChild.position.y + lastChildHeight;

  // 将父节点居中于子节点范围
  const childrenMidY = (firstChildY + lastChildBottom) / 2;
  parentNode.position.y = childrenMidY - parentHeight / 2;
}