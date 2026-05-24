/**
 * 左右平衡布局（根节点居中，子节点左右分布）
 */

import type { Node, Edge } from '@xyflow/react';
import type { MindMapNode, LayoutConfig, LayoutResult, NodeStyle } from '../../types';
import { DEFAULT_LAYOUT_CONFIG } from '../../constants';
import { calculateSubtreeHeight, calculateNodeWidth, calculateNodeHeight } from './helpers';

/** 节点数据类型 */
interface BalancedNodeData extends Record<string, unknown> {
  label: string;
  note?: string;
  isRoot: boolean;
  level: number;
  collapsed: boolean;
  completed: boolean;
  hasChildren: boolean;
  childCount: number;
  nodeId: string;
  side: 'left' | 'right' | 'center';
  style?: NodeStyle;
}

/** 计算所有后代数量 */
function countAllDescendants(node: MindMapNode): number {
  if (!node.children) return 0;
  return node.children.reduce(
    (sum, child) => sum + 1 + countAllDescendants(child),
    0
  );
}

/** 按子树大小分配左右 */
function distributeChildren(
  children: MindMapNode[]
): { left: MindMapNode[]; right: MindMapNode[] } {
  if (children.length === 0) {
    return { left: [], right: [] };
  }

  // 按子树大小排序
  const sorted = [...children].sort((a, b) => 
    countAllDescendants(b) - countAllDescendants(a)
  );

  const left: MindMapNode[] = [];
  const right: MindMapNode[] = [];
  let leftWeight = 0;
  let rightWeight = 0;

  // 交替分配，保持平衡
  for (const child of sorted) {
    const weight = 1 + countAllDescendants(child);
    if (leftWeight <= rightWeight) {
      left.push(child);
      leftWeight += weight;
    } else {
      right.push(child);
      rightWeight += weight;
    }
  }

  return { left, right };
}

/** 计算左右平衡布局 */
export function calculateBalancedLayout(
  root: MindMapNode,
  config: LayoutConfig = DEFAULT_LAYOUT_CONFIG
): LayoutResult {
  const nodes: Node<BalancedNodeData>[] = [];
  const edges: Edge[] = [];

  // 根节点
  const rootWidth = calculateNodeWidth(root, config);
  const rootHeight = calculateNodeHeight(root, true, config);

  nodes.push({
    id: root.id,
    type: 'rootNode',
    position: { x: 0, y: 0 },
    data: {
      label: root.text || '',
      note: root.note,
      isRoot: true,
      level: 0,
      collapsed: false,
      completed: !!root.completed,
      hasChildren: root.children.length > 0,
      childCount: countAllDescendants(root),
      nodeId: root.id,
      side: 'center',
      style: root.style,
      blankedRanges: root.blankedRanges,
    },
  });

  if (root.collapsed || root.children.length === 0) {
    return {
      nodes,
      edges,
      bounds: { minX: 0, minY: 0, maxX: rootWidth, maxY: rootHeight, width: rootWidth, height: rootHeight },
    };
  }

  // 分配左右子节点
  const { left, right } = distributeChildren(root.children);

  /** 布局一侧的子树 */
  function layoutSide(
    children: MindMapNode[],
    side: 'left' | 'right',
    startX: number
  ) {
    if (children.length === 0) return;

    // 计算子树高度
    const subtreeHeights = children.map(child => 
      calculateSubtreeHeight(child, config)
    );
    const totalHeight = subtreeHeights.reduce((sum, h, i) => 
      sum + h + (i > 0 ? config.verticalGap : 0), 0
    );

    // 起始 Y 位置
    let currentY = rootHeight / 2 - totalHeight / 2;

    children.forEach((child, index) => {
      layoutSubtree(child, startX, currentY, 1, root.id, side);
      currentY += subtreeHeights[index] + config.verticalGap;
    });
  }

  /** 递归布局子树 */
  function layoutSubtree(
    node: MindMapNode,
    x: number,
    y: number,
    level: number,
    parentId: string,
    side: 'left' | 'right'
  ): number {
    const hasChildren = node.children && node.children.length > 0;
    const nodeWidth = calculateNodeWidth(node, config);
    const nodeHeight = calculateNodeHeight(node, false, config);

    nodes.push({
      id: node.id,
      type: 'branchNode',
      position: { x, y },
      data: {
        label: node.text || '',
        note: node.note,
        isRoot: false,
        level,
        collapsed: !!node.collapsed,
        completed: !!node.completed,
        hasChildren: hasChildren && !node.collapsed,
        childCount: countAllDescendants(node),
        nodeId: node.id,
        side,
        style: node.style,
        blankedRanges: node.blankedRanges,
      },
    });

    edges.push({
      id: `e-${parentId}-${node.id}`,
      source: parentId,
      target: node.id,
      type: 'curved',
    });

    if (!hasChildren || node.collapsed) {
      return nodeHeight;
    }

    // 计算子节点位置
    const childX = side === 'right' 
      ? x + nodeWidth + config.horizontalGap
      : x - config.horizontalGap - calculateNodeWidth(node.children[0], config);

    const subtreeHeights = node.children.map(child => 
      calculateSubtreeHeight(child, config)
    );
    const totalHeight = subtreeHeights.reduce((sum, h, i) => 
      sum + h + (i > 0 ? config.verticalGap : 0), 0
    );

    let currentY = y + nodeHeight / 2 - totalHeight / 2;

    node.children.forEach((child, index) => {
      layoutSubtree(child, childX, currentY, level + 1, node.id, side);
      currentY += subtreeHeights[index] + config.verticalGap;
    });

    return Math.max(nodeHeight, totalHeight);
  }

  // 布局左侧
  if (left.length > 0) {
    const leftX = -config.horizontalGap - calculateNodeWidth(left[0], config);
    layoutSide(left, 'left', leftX);
  }

  // 布局右侧
  if (right.length > 0) {
    const rightX = rootWidth + config.horizontalGap;
    layoutSide(right, 'right', rightX);
  }

  // 计算边界
  const allX = nodes.map(n => n.position.x);
  const allY = nodes.map(n => n.position.y);
  const bounds = {
    minX: Math.min(...allX) - 50,
    minY: Math.min(...allY) - 20,
    maxX: Math.max(...allX) + 200,
    maxY: Math.max(...allY) + config.nodeHeight + 20,
    width: 0,
    height: 0,
  };
  bounds.width = bounds.maxX - bounds.minX;
  bounds.height = bounds.maxY - bounds.minY;

  return { nodes, edges, bounds };
}

