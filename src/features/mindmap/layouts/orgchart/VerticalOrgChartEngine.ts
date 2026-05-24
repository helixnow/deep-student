/**
 * 垂直组织结构图布局引擎
 * 
 * 从上到下的层级结构图，子节点水平排列
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
 * 垂直组织结构图布局引擎
 * 
 * 将节点从上到下（或从下到上）排列，同层级子节点水平排列
 * 直接使用 ReactFlow 的 smoothstep 边，无需自定义连接器
 */
export class VerticalOrgChartEngine extends BaseLayoutEngine {
  readonly id = 'orgchart-vertical';
  readonly name = 'layouts.orgchartVertical';
  readonly nameEn = 'layouts.orgchartVertical';
  readonly description = 'layouts.orgchartVerticalDesc';
  readonly category: LayoutCategory = 'orgchart';
  readonly directions: LayoutDirection[] = ['down', 'up'];
  readonly defaultDirection: LayoutDirection = 'down';

  /**
   * 计算子树宽度（水平方向占用的空间）
   * ★ P0 修复：添加深度限制参数
   */
  private calculateSubtreeWidth(node: MindMapNode, config: LayoutConfig, depth: number = 0, isRoot: boolean = false): number {
    // 深度限制检查
    if (depth > MAX_TREE_DEPTH) {
      console.warn(`[VerticalOrgChartEngine] calculateSubtreeWidth depth exceeds limit (${MAX_TREE_DEPTH})`);
      return calculateNodeWidth(node, config, isRoot);
    }

    if (!node.children || node.children.length === 0 || node.collapsed) {
      return calculateNodeWidth(node, config, isRoot);
    }

    const childrenWidth = node.children.reduce(
      (sum, child, i) => sum + this.calculateSubtreeWidth(child, config, depth + 1, false) + (i > 0 ? config.verticalGap : 0),
      0
    );

    return Math.max(calculateNodeWidth(node, config, isRoot), childrenWidth);
  }

  /**
   * 计算垂直组织结构图布局
   */
  calculate(
    root: MindMapNode,
    config: LayoutConfig = DEFAULT_LAYOUT_CONFIG,
    direction: LayoutDirection = this.defaultDirection
  ): LayoutResult {
    const validDirection = this.getValidDirection(direction);
    const isUp = validDirection === 'up';

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
        console.warn(`[VerticalOrgChartEngine] Layout depth exceeds limit (${MAX_TREE_DEPTH})`);
        return config.nodeMinWidth;
      }

      const hasChildren = node.children && node.children.length > 0;
      const isCollapsed = node.collapsed;
      const isRootNode = level === 0;
      const nodeWidth = calculateNodeWidth(node, config, isRootNode);
      const nodeHeight = calculateNodeHeight(node, isRootNode, config);

      const subtreeWidth = this.calculateSubtreeWidth(node, config, level, isRootNode);
      const nodeX = x + (subtreeWidth - nodeWidth) / 2;

      // 根据布局方向设置 Handle 位置
      const sourcePosition = isUp ? 'top' : 'bottom';
      const targetPosition = isUp ? 'bottom' : 'top';

      // 添加节点（包含尺寸信息供 MiniMap 使用）
      nodes.push({
        id: node.id,
        type: level === 0 ? 'rootNode' : 'branchNode',
        position: { x: nodeX, y },
        width: nodeWidth,
        height: nodeHeight,
        data: {
          label: node.text || '',
          note: node.note,
          refs: node.refs,
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
      layoutBoxes.push({ x: nodeX, y, width: nodeWidth, height: nodeHeight });

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

      // 如果没有子节点或已折叠，返回子树宽度
      if (!hasChildren || isCollapsed) {
        return subtreeWidth;
      }

      // 计算子节点的 Y 坐标
      const childY = isUp
        ? y - config.horizontalGap - nodeHeight
        : y + nodeHeight + config.horizontalGap;

      // 布局子节点（水平排列）
      let currentX = x;
      node.children!.forEach((child) => {
        const childWidth = this.calculateSubtreeWidth(child, config, level + 1);
        layoutNode(child, currentX, childY, level + 1, node.id);
        currentX += childWidth + config.verticalGap;
      });

      return subtreeWidth;
    };

    // 从根节点开始布局
    layoutNode(root, 0, 0, 0);

    const bounds = calculateBounds(layoutBoxes);

    return { nodes, edges, bounds };
  }
}
