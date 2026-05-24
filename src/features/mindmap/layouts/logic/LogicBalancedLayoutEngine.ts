/**
 * 逻辑图平衡布局引擎
 * 
 * 根节点居中，子节点左右分布的平衡布局，使用直角折线连接
 */

import type { Node, Edge } from '@xyflow/react';
import type { MindMapNode, LayoutConfig, LayoutResult, NodeStyle } from '../../types';
import type { LayoutCategory, LayoutDirection } from '../../registry/types';
import { DEFAULT_LAYOUT_CONFIG } from '../../constants';
import {
  calculateSubtreeHeight,
  calculateNodeWidth,
  calculateNodeHeight,
  calculateBounds,
  resolveSubtreeOverlaps,
  recenterParents,
} from '../../utils/layout/helpers';
import { BaseLayoutEngine, MAX_TREE_DEPTH } from '../base/LayoutEngine';

/** 逻辑图平衡布局节点数据类型 */
interface LogicBalancedNodeData extends Record<string, unknown> {
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
  sourcePosition?: 'left' | 'right' | 'top' | 'bottom' | 'both';
  targetPosition?: 'left' | 'right' | 'top' | 'bottom';
}

/**
 * 逻辑图平衡布局引擎
 * 
 * 将思维导图节点按照左右平衡的方式进行布局，
 * 根节点居中，子节点根据子树大小自动分配到左侧或右侧，
 * 使用直角折线连接节点
 */
export class LogicBalancedLayoutEngine extends BaseLayoutEngine {
  readonly id = 'logic-balanced';
  readonly name = 'layouts.logicBalanced';
  readonly nameEn = 'layouts.logicBalanced';
  readonly description = 'layouts.logicBalancedDesc';
  readonly category: LayoutCategory = 'logic';
  readonly directions: LayoutDirection[] = ['both'];
  readonly defaultDirection: LayoutDirection = 'both';

  /**
   * 按子树视觉高度分配左右
   *
   * 使用实际子树像素高度（而非节点数量）作为权重，
   * 并将间距纳入累计高度，确保视觉上左右两侧高度接近。
   * 分配完成后恢复子节点的原始顺序，保持用户编辑顺序。
   */
  private distributeChildren(
    children: MindMapNode[],
    config: LayoutConfig
  ): { left: MindMapNode[]; right: MindMapNode[] } {
    if (children.length === 0) {
      return { left: [], right: [] };
    }

    // 计算每个子树的实际视觉高度，并记录原始顺序
    const childrenWithHeight = children.map((child, originalIndex) => ({
      node: child,
      height: calculateSubtreeHeight(child, config),
      originalIndex,
    }));

    // 按视觉高度降序排列——大的先分配，贪心效果更好
    const sorted = [...childrenWithHeight].sort((a, b) => b.height - a.height);

    const leftIndices: number[] = [];
    const rightIndices: number[] = [];
    let leftHeight = 0;
    let rightHeight = 0;

    // 贪心分配：将子树放到累计高度较小的一侧（含间距）
    for (const item of sorted) {
      if (rightHeight < leftHeight) {
        const gap = rightIndices.length > 0 ? config.verticalGap : 0;
        rightIndices.push(item.originalIndex);
        rightHeight += item.height + gap;
      } else {
        const gap = leftIndices.length > 0 ? config.verticalGap : 0;
        leftIndices.push(item.originalIndex);
        leftHeight += item.height + gap;
      }
    }

    // 恢复原始顺序，保持用户创建的子节点排列
    leftIndices.sort((a, b) => a - b);
    rightIndices.sort((a, b) => a - b);

    return {
      left: leftIndices.map(i => children[i]),
      right: rightIndices.map(i => children[i]),
    };
  }

  /**
   * 计算逻辑图平衡布局
   * @param root 根节点
   * @param config 布局配置
   * @param _direction 布局方向（平衡布局始终使用 'both'）
   * @returns 布局结果
   */
  calculate(
    root: MindMapNode,
    config: LayoutConfig = DEFAULT_LAYOUT_CONFIG,
    _direction: LayoutDirection = this.defaultDirection
  ): LayoutResult {
    const nodes: Node<LogicBalancedNodeData>[] = [];
    const edges: Edge[] = [];

    // 根节点
    const rootWidth = calculateNodeWidth(root, config, true);
    const rootHeight = calculateNodeHeight(root, true, config);

    nodes.push({
      id: root.id,
      type: 'rootNode',
      position: { x: 0, y: 0 },
      width: rootWidth,
      height: rootHeight,
      data: {
        label: root.text || '',
        note: root.note,
        refs: root.refs,
        isRoot: true,
        level: 0,
        collapsed: false,
        completed: !!root.completed,
        hasChildren: root.children.length > 0,
        childCount: this.countAllDescendants(root),
        nodeId: root.id,
        side: 'center',
        style: root.style,
        blankedRanges: root.blankedRanges,
        sourcePosition: 'both', // 根节点需要左右都有 Handle
      },
    });

    if (root.collapsed || root.children.length === 0) {
      return {
        nodes,
        edges,
        bounds: {
          minX: 0,
          minY: 0,
          maxX: rootWidth,
          maxY: rootHeight,
          width: rootWidth,
          height: rootHeight,
        },
      };
    }

    // 分配左右子节点（基于视觉高度）
    const { left, right } = this.distributeChildren(root.children, config);

    /**
     * 布局一侧的子树
     */
    const layoutSide = (
      children: MindMapNode[],
      side: 'left' | 'right',
      startX: number
    ) => {
      if (children.length === 0) return;

      // 计算子树高度
      const subtreeHeights = children.map(child =>
        calculateSubtreeHeight(child, config)
      );
      const totalHeight = subtreeHeights.reduce(
        (sum, h, i) => sum + h + (i > 0 ? config.verticalGap : 0),
        0
      );

      // 起始 Y 位置
      let currentY = rootHeight / 2 - totalHeight / 2;

      children.forEach((child, index) => {
        layoutSubtree(child, startX, currentY, 1, root.id, side);
        currentY += subtreeHeights[index] + config.verticalGap;
      });
    };

    /**
     * 递归布局子树
     * ★ P0 修复：添加深度限制检查
     */
    const layoutSubtree = (
      node: MindMapNode,
      x: number,
      y: number,
      level: number,
      parentId: string,
      side: 'left' | 'right'
    ): number => {
      // 深度限制检查
      if (level > MAX_TREE_DEPTH) {
        console.warn(`[LogicBalancedLayoutEngine] Layout depth exceeds limit (${MAX_TREE_DEPTH})`);
        return config.nodeHeight;
      }

      const hasChildren = node.children && node.children.length > 0;
      const nodeWidth = calculateNodeWidth(node, config);
      const nodeHeight = calculateNodeHeight(node, false, config);

      // 根据分支位置设置 Handle 位置（同 BalancedLayoutEngine）
      // 左侧分支：target 在右边（连接根节点），source 在左边（连接子节点）
      // 右侧分支：target 在左边（连接根节点），source 在右边（连接子节点）
      const sourcePosition = side === 'left' ? 'left' : 'right';
      const targetPosition = side === 'left' ? 'right' : 'left';

      nodes.push({
        id: node.id,
        type: 'branchNode',
        position: { x, y },
        width: nodeWidth,
        height: nodeHeight,
        data: {
          label: node.text || '',
          note: node.note,
          refs: node.refs,
          isRoot: false,
          level,
          collapsed: !!node.collapsed,
          completed: !!node.completed,
          hasChildren: hasChildren && !node.collapsed,
          childCount: this.countAllDescendants(node),
          nodeId: node.id,
          side,
          style: node.style,
          blankedRanges: node.blankedRanges,
          sourcePosition,
          targetPosition,
        },
      });

      // 如果父节点是根节点，需要指定 sourceHandle（根节点有左右两个 Handle）
      const isConnectingToRoot = parentId === root.id;
      // 使用 orgchart 类型实现逻辑图的阶梯连线
      edges.push({
        id: `e-${parentId}-${node.id}`,
        source: parentId,
        target: node.id,
        type: 'orgchart',
        sourceHandle: isConnectingToRoot ? side : undefined,
        data: {
          direction: side,
          railOffset: config.horizontalGap / 2,
        },
      });

      if (!hasChildren || node.collapsed) {
        return nodeHeight;
      }

      // 计算子节点位置
      const childX =
        side === 'right'
          ? x + nodeWidth + config.horizontalGap
          : x - config.horizontalGap - calculateNodeWidth(node.children![0], config);

      const subtreeHeights = node.children!.map(child =>
        calculateSubtreeHeight(child, config)
      );
      const totalHeight = subtreeHeights.reduce(
        (sum, h, i) => sum + h + (i > 0 ? config.verticalGap : 0),
        0
      );

      let currentY = y + nodeHeight / 2 - totalHeight / 2;

      node.children!.forEach((child, index) => {
        layoutSubtree(child, childX, currentY, level + 1, node.id, side);
        currentY += subtreeHeights[index] + config.verticalGap;
      });

      return Math.max(nodeHeight, totalHeight);
    };

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

    // 基于实测高度的子树碰撞消除
    const nodesById = new Map(nodes.map(node => [node.id, node]));
    resolveSubtreeOverlaps(root, nodesById, config, true);
    recenterParents(root, nodesById, config, true);

    // 计算边界
    const layoutBoxes = nodes.map(node => {
      const width = calculateNodeWidth(
        { text: String(node.data?.label || ''), style: node.data?.style as NodeStyle | undefined } as MindMapNode,
        config,
        !!node.data?.isRoot
      );
      const height = calculateNodeHeight(
        { text: String(node.data?.label || ''), note: node.data?.note as string | undefined, style: node.data?.style as NodeStyle | undefined } as MindMapNode,
        !!node.data?.isRoot,
        config
      );
      return { x: node.position.x, y: node.position.y, width, height };
    });
    const bounds = calculateBounds(layoutBoxes);

    return { nodes, edges, bounds };
  }
}
