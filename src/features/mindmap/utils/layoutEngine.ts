/**
 * 知识导图布局计算引擎
 *
 * 基于树形布局算法，计算节点位置
 * 支持水平和垂直布局
 */

import type { MindMapNode, LayoutOptions } from '../types';

/** 树形布局节点（内部使用，带有 children 属性） */
export interface TreeLayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  children: TreeLayoutNode[];
  depth: number;
  direction?: 'left' | 'right';
}

// ============================================================================
// 默认配置
// ============================================================================

export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = {
  horizontalGap: 50,
  verticalGap: 20,
  nodeWidth: 160,
  nodeHeight: 40,
  direction: 'horizontal',
};

// ============================================================================
// 动态节点尺寸计算
// ============================================================================

const CHAR_WIDTH = 8; // 平均字符宽度（像素）
const LINE_HEIGHT = 20; // 行高
const NODE_PADDING_X = 24; // 节点水平内边距
const NODE_PADDING_Y = 16; // 节点垂直内边距
const MIN_NODE_WIDTH = 80;
const MAX_NODE_WIDTH = 300;
const MIN_NODE_HEIGHT = 36;

/**
 * 根据节点文本计算动态尺寸
 */
export function computeNodeSize(node: MindMapNode): { width: number; height: number } {
  const text = node.text || '';
  const note = node.note || '';
  
  // 计算文本宽度
  const textWidth = Math.min(text.length * CHAR_WIDTH + NODE_PADDING_X, MAX_NODE_WIDTH);
  const width = Math.max(MIN_NODE_WIDTH, textWidth);
  
  // 计算文本行数
  const maxCharsPerLine = Math.floor((width - NODE_PADDING_X) / CHAR_WIDTH);
  const textLines = Math.ceil(text.length / maxCharsPerLine) || 1;
  
  // 备注额外增加高度
  const noteLines = note ? Math.min(Math.ceil(note.length / maxCharsPerLine), 2) : 0;
  
  const height = Math.max(
    MIN_NODE_HEIGHT,
    (textLines + noteLines * 0.8) * LINE_HEIGHT + NODE_PADDING_Y
  );
  
  return { width, height };
}

// ============================================================================
// 布局计算
// ============================================================================

interface NodeBounds {
  width: number;
  height: number;
}

/**
 * 计算子树的边界（宽度和高度）
 * @param useDynamicSize 是否使用动态节点尺寸
 */
function computeSubtreeBounds(
  node: MindMapNode,
  options: LayoutOptions,
  useDynamicSize: boolean = false
): NodeBounds {
  const nodeSize = useDynamicSize 
    ? computeNodeSize(node) 
    : { width: options.nodeWidth, height: options.nodeHeight };
  
  if (node.collapsed || node.children.length === 0) {
    return nodeSize;
  }

  let totalChildHeight = 0;
  let maxChildWidth = 0;

  for (const child of node.children) {
    const childBounds = computeSubtreeBounds(child, options, useDynamicSize);
    totalChildHeight += childBounds.height;
    maxChildWidth = Math.max(maxChildWidth, childBounds.width);
  }

  totalChildHeight += (node.children.length - 1) * options.verticalGap;

  return {
    width: nodeSize.width + options.horizontalGap + maxChildWidth,
    height: Math.max(nodeSize.height, totalChildHeight),
  };
}

/**
 * 递归布局节点
 */
function computeNodeLayout(
  node: MindMapNode,
  x: number,
  y: number,
  options: LayoutOptions,
  depth: number,
  direction: 'left' | 'right' = 'right'
): TreeLayoutNode {
  const result: TreeLayoutNode = {
    id: node.id,
    x,
    y,
    width: options.nodeWidth,
    height: options.nodeHeight,
    children: [],
    depth,
    direction,
  };

  if (node.collapsed || node.children.length === 0) {
    return result;
  }

  // 计算子节点总高度
  const childBounds = node.children.map((child) =>
    computeSubtreeBounds(child, options)
  );
  const totalChildHeight =
    childBounds.reduce((sum, b) => sum + b.height, 0) +
    (node.children.length - 1) * options.verticalGap;

  // 子节点起始 Y 位置（居中对齐）
  let currentY = y + options.nodeHeight / 2 - totalChildHeight / 2;

  // 子节点 X 位置
  const childX =
    direction === 'right'
      ? x + options.nodeWidth + options.horizontalGap
      : x - options.horizontalGap - options.nodeWidth;

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    const bounds = childBounds[i];

    const childLayout = computeNodeLayout(
      child,
      childX,
      currentY + bounds.height / 2 - options.nodeHeight / 2,
      options,
      depth + 1,
      direction
    );

    result.children.push(childLayout);
    currentY += bounds.height + options.verticalGap;
  }

  return result;
}

/**
 * 计算思维导图布局（根节点居中，左右分布子节点）
 */
export function computeMindMapLayout(
  root: MindMapNode,
  options: Partial<LayoutOptions> = {}
): TreeLayoutNode {
  const opts = { ...DEFAULT_LAYOUT_OPTIONS, ...options };

  // 将子节点分为左右两部分
  const leftChildren: MindMapNode[] = [];
  const rightChildren: MindMapNode[] = [];

  root.children.forEach((child, index) => {
    if (index % 2 === 0) {
      rightChildren.push(child);
    } else {
      leftChildren.push(child);
    }
  });

  // 计算左右子树的高度
  const leftBounds = leftChildren.map((c) => computeSubtreeBounds(c, opts));
  const rightBounds = rightChildren.map((c) => computeSubtreeBounds(c, opts));

  const leftTotalHeight =
    leftBounds.reduce((sum, b) => sum + b.height, 0) +
    Math.max(0, leftChildren.length - 1) * opts.verticalGap;
  const rightTotalHeight =
    rightBounds.reduce((sum, b) => sum + b.height, 0) +
    Math.max(0, rightChildren.length - 1) * opts.verticalGap;

  const maxHeight = Math.max(leftTotalHeight, rightTotalHeight, opts.nodeHeight);

  // 根节点位置（居中）
  const rootX = 0;
  const rootY = maxHeight / 2 - opts.nodeHeight / 2;

  const rootLayout: TreeLayoutNode = {
    id: root.id,
    x: rootX,
    y: rootY,
    width: opts.nodeWidth,
    height: opts.nodeHeight,
    children: [],
    depth: 0,
  };

  // 布局右侧子节点
  let rightY = rootY + opts.nodeHeight / 2 - rightTotalHeight / 2;
  for (let i = 0; i < rightChildren.length; i++) {
    const child = rightChildren[i];
    const bounds = rightBounds[i];
    const childLayout = computeNodeLayout(
      child,
      rootX + opts.nodeWidth + opts.horizontalGap,
      rightY + bounds.height / 2 - opts.nodeHeight / 2,
      opts,
      1,
      'right'
    );
    rootLayout.children.push(childLayout);
    rightY += bounds.height + opts.verticalGap;
  }

  // 布局左侧子节点
  let leftY = rootY + opts.nodeHeight / 2 - leftTotalHeight / 2;
  for (let i = 0; i < leftChildren.length; i++) {
    const child = leftChildren[i];
    const bounds = leftBounds[i];
    const childLayout = computeNodeLayout(
      child,
      rootX - opts.horizontalGap - opts.nodeWidth,
      leftY + bounds.height / 2 - opts.nodeHeight / 2,
      opts,
      1,
      'left'
    );
    rootLayout.children.push(childLayout);
    leftY += bounds.height + opts.verticalGap;
  }

  return rootLayout;
}

/**
 * 计算大纲布局（垂直树形）
 */
export function computeOutlineLayout(
  root: MindMapNode,
  options: Partial<LayoutOptions> = {}
): TreeLayoutNode {
  const opts = { ...DEFAULT_LAYOUT_OPTIONS, ...options };
  return computeNodeLayout(root, 0, 0, opts, 0, 'right');
}

/**
 * 获取布局边界
 */
export function getLayoutBounds(layout: TreeLayoutNode): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
} {
  let minX = layout.x;
  let minY = layout.y;
  let maxX = layout.x + layout.width;
  let maxY = layout.y + layout.height;

  function traverse(node: TreeLayoutNode) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.width);
    maxY = Math.max(maxY, node.y + node.height);
    node.children.forEach(traverse);
  }

  traverse(layout);

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/**
 * 扁平化布局节点（用于渲染）
 */
export function flattenLayout(layout: TreeLayoutNode): TreeLayoutNode[] {
  const result: TreeLayoutNode[] = [layout];
  layout.children.forEach((child) => {
    result.push(...flattenLayout(child));
  });
  return result;
}

/**
 * 获取节点之间的连接线
 */
export interface LayoutEdge {
  id: string;
  sourceId: string;
  targetId: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
}

export function getLayoutEdges(layout: TreeLayoutNode): LayoutEdge[] {
  const edges: LayoutEdge[] = [];

  function traverse(node: TreeLayoutNode) {
    for (const child of node.children) {
      const sourceX =
        child.direction === 'left' ? node.x : node.x + node.width;
      const sourceY = node.y + node.height / 2;
      const targetX =
        child.direction === 'left' ? child.x + child.width : child.x;
      const targetY = child.y + child.height / 2;

      edges.push({
        id: `${node.id}-${child.id}`,
        sourceId: node.id,
        targetId: child.id,
        sourceX,
        sourceY,
        targetX,
        targetY,
      });

      traverse(child);
    }
  }

  traverse(layout);
  return edges;
}
