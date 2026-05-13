/**
 * 单向树形布局（向右展开）
 */

import type { Node, Edge } from '@xyflow/react';
import type { MindMapNode, LayoutConfig, LayoutResult, NodeStyle } from '../../types';
import { DEFAULT_LAYOUT_CONFIG } from '../../constants';
import { calculateSubtreeHeight, calculateNodeWidth, calculateNodeHeight, calculateBounds } from './helpers';

/** 节点数据类型 */
interface TreeNodeData extends Record<string, unknown> {
  label: string;
  note?: string;
  isRoot: boolean;
  level: number;
  collapsed: boolean;
  completed: boolean;
  hasChildren: boolean;
  childCount: number;
  nodeId: string;
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

/** 计算单向右展开树形布局 */
export function calculateTreeLayout(
  root: MindMapNode,
  config: LayoutConfig = DEFAULT_LAYOUT_CONFIG
): LayoutResult {
  const nodes: Node<TreeNodeData>[] = [];
  const edges: Edge[] = [];
  const layoutBoxes: Array<{ x: number; y: number; width: number; height: number }> = [];

  /** 递归布局节点 */
  function layoutNode(
    node: MindMapNode,
    x: number,
    y: number,
    level: number,
    parentId?: string
  ): number {
    const hasChildren = node.children && node.children.length > 0;
    const isCollapsed = node.collapsed;
    const nodeWidth = calculateNodeWidth(node, config);
    const nodeHeight = calculateNodeHeight(node, level === 0, config);

    // 添加节点
    nodes.push({
      id: node.id,
      type: level === 0 ? 'rootNode' : 'branchNode',
      position: { x, y },
      data: {
        label: node.text || '',
        note: node.note,
        isRoot: level === 0,
        level,
        collapsed: !!node.collapsed,
        completed: !!node.completed,
        hasChildren: hasChildren,
        childCount: countAllDescendants(node),
        nodeId: node.id,
        style: node.style,
        blankedRanges: node.blankedRanges,
      },
    });
    layoutBoxes.push({ x, y, width: nodeWidth, height: nodeHeight });

    // 添加边
    if (parentId) {
      edges.push({
        id: `e-${parentId}-${node.id}`,
        source: parentId,
        target: node.id,
        type: 'curved',
      });
    }

    // 如果没有子节点或已折叠，返回当前节点高度
    if (!hasChildren || isCollapsed) {
      return nodeHeight;
    }

    // 计算子节点布局
    const childX = x + nodeWidth + config.horizontalGap;
    
    // 计算每个子节点的子树高度
    const subtreeHeights = node.children.map(child => 
      calculateSubtreeHeight(child, config)
    );
    
    // 总高度
    const totalHeight = subtreeHeights.reduce((sum, h, i) => 
      sum + h + (i > 0 ? config.verticalGap : 0), 0
    );

    // 起始 Y 位置：使子节点整体垂直居中于父节点
    let currentY = y + nodeHeight / 2 - totalHeight / 2;

    // 布局子节点
    node.children.forEach((child, index) => {
      layoutNode(child, childX, currentY, level + 1, node.id);
      currentY += subtreeHeights[index] + config.verticalGap;
    });

    return Math.max(nodeHeight, totalHeight);
  }

  // 从根节点开始布局
  layoutNode(root, 0, 0, 0);

  const bounds = calculateBounds(layoutBoxes);

  return { nodes, edges, bounds };
}

