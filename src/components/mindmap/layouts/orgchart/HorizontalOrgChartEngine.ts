/**
 * 水平组织结构图布局引擎
 * 
 * 从左到右（或从右到左）的层级结构图，子节点垂直排列
 * 使用 ReactFlow 内置的 smoothstep 边类型实现组织结构图连线
 */

import type { Node, Edge } from '@xyflow/react';
import type { MindMapNode, LayoutConfig, LayoutResult, NodeStyle } from '../../types';
import type { LayoutCategory, LayoutDirection } from '../../registry/types';
import { BaseLayoutEngine, MAX_TREE_DEPTH } from '../base/LayoutEngine';
import { DEFAULT_LAYOUT_CONFIG } from '../../constants';
import { calculateNodeWidth, calculateNodeHeight, calculateBounds } from '../../utils/layout/helpers';

/** 组织结构图节点数据类型 */
interface OrgChartNodeData extends Record<string, unknown> {
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
  sourcePosition?: 'left' | 'right' | 'top' | 'bottom' | 'both';
  targetPosition?: 'left' | 'right' | 'top' | 'bottom';
}

/**
 * 水平组织结构图布局引擎
 * 
 * 将节点从左到右（或从右到左）排列，同层级子节点垂直排列
 * 直接使用 ReactFlow 的 smoothstep 边，无需自定义连接器
 */
export class HorizontalOrgChartEngine extends BaseLayoutEngine {
  readonly id = 'orgchart-horizontal';
  readonly name = 'layouts.orgchartHorizontal';
  readonly nameEn = 'layouts.orgchartHorizontal';
  readonly description = 'layouts.orgchartHorizontalDesc';
  readonly category: LayoutCategory = 'orgchart';
  readonly directions: LayoutDirection[] = ['right', 'left'];
  readonly defaultDirection: LayoutDirection = 'right';

  /**
   * 计算子树高度（垂直方向占用的空间）
   * ★ P0 修复：添加深度限制参数
   */
  private calculateSubtreeHeight(node: MindMapNode, config: LayoutConfig, depth: number = 0): number {
    // 深度限制检查
    if (depth > MAX_TREE_DEPTH) {
      console.warn(`[HorizontalOrgChartEngine] calculateSubtreeHeight depth exceeds limit (${MAX_TREE_DEPTH})`);
      return config.nodeHeight;
    }

    const nodeHeight = calculateNodeHeight(node, false, config);

    if (!node.children || node.children.length === 0 || node.collapsed) {
      return nodeHeight;
    }

    const childrenHeight = node.children.reduce(
      (sum, child, i) => sum + this.calculateSubtreeHeight(child, config, depth + 1) + (i > 0 ? config.verticalGap : 0),
      0
    );

    return Math.max(nodeHeight, childrenHeight);
  }

  /**
   * 计算水平组织结构图布局
   */
  calculate(
    root: MindMapNode,
    config: LayoutConfig = DEFAULT_LAYOUT_CONFIG,
    direction: LayoutDirection = this.defaultDirection
  ): LayoutResult {
    const validDirection = this.getValidDirection(direction);
    const isLeft = validDirection === 'left';

    const nodes: Node<OrgChartNodeData>[] = [];
    const edges: Edge[] = [];
    const layoutBoxes: Array<{ x: number; y: number; width: number; height: number }> = [];

    /**
     * 递归布局节点
     * ★ P0 修复：添加深度限制检查
     */
    const layoutNode = (
      node: MindMapNode,
      x: number,
      y: number,
      level: number,
      parentId?: string
    ): number => {
      // 深度限制检查
      if (level > MAX_TREE_DEPTH) {
        console.warn(`[HorizontalOrgChartEngine] Layout depth exceeds limit (${MAX_TREE_DEPTH})`);
        return config.nodeHeight;
      }

      const hasChildren = node.children && node.children.length > 0;
      const isCollapsed = node.collapsed;
      const isRootNode = level === 0;
      const nodeWidth = calculateNodeWidth(node, config, isRootNode);
      const nodeHeight = calculateNodeHeight(node, isRootNode, config);

      const subtreeHeight = this.calculateSubtreeHeight(node, config, level);
      const nodeY = y + (subtreeHeight - nodeHeight) / 2;

      // 计算节点实际 X 位置（向左展开时需要调整）
      const nodeX = isLeft && level > 0 ? x - nodeWidth : x;

      // 根据布局方向设置 Handle 位置
      const sourcePosition = isLeft ? 'left' : 'right';
      const targetPosition = isLeft ? 'right' : 'left';

      // 添加节点（包含尺寸信息供 MiniMap 使用）
      nodes.push({
        id: node.id,
        type: level === 0 ? 'rootNode' : 'branchNode',
        position: { x: nodeX, y: nodeY },
        width: nodeWidth,
        height: nodeHeight,
        data: {
          label: node.text || '',
          note: node.note,
          isRoot: level === 0,
          level,
          collapsed: !!node.collapsed,
          completed: !!node.completed,
          hasChildren,
          childCount: this.countAllDescendants(node),
          nodeId: node.id,
          style: node.style,
          blankedRanges: node.blankedRanges,
          sourcePosition,
          targetPosition: level === 0 ? undefined : targetPosition,
        },
      });
      layoutBoxes.push({ x: nodeX, y: nodeY, width: nodeWidth, height: nodeHeight });

      // 添加边（使用 orgchart 类型实现组织结构图的直角连线）
      if (parentId) {
        edges.push({
          id: `e-${parentId}-${node.id}`,
          source: parentId,
          target: node.id,
          type: 'orgchart',
          data: {
            direction: validDirection,
            railOffset: config.horizontalGap / 2,
          },
        });
      }

      // 如果没有子节点或已折叠，返回子树高度
      if (!hasChildren || isCollapsed) {
        return subtreeHeight;
      }

      // 计算子节点的 X 坐标
      let childX: number;
      if (isLeft) {
        childX = nodeX - config.horizontalGap;
      } else {
        childX = x + nodeWidth + config.horizontalGap;
      }

      // 布局子节点（垂直排列）
      let currentY = y;
      node.children!.forEach((child) => {
        const childHeight = this.calculateSubtreeHeight(child, config, level + 1);
        layoutNode(child, childX, currentY, level + 1, node.id);
        currentY += childHeight + config.verticalGap;
      });

      return subtreeHeight;
    };

    // 从根节点开始布局
    layoutNode(root, 0, 0, 0);

    const bounds = calculateBounds(layoutBoxes);

    return { nodes, edges, bounds };
  }
}
