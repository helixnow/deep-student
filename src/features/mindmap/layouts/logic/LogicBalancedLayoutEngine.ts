/**
 * 逻辑图平衡布局引擎
 * 
 * 根节点居中，子节点左右分布的平衡布局，使用直角折线连接
 */

import type { Node, Edge } from '@xyflow/react';
import type { MindMapNode, LayoutConfig, LayoutResult, NodeStyle } from '../../types';
import type { LayoutCategory, LayoutDirection } from '../../registry/types';
import type { LayoutBoundsWithMeta } from '../../registry/types';
import { DEFAULT_LAYOUT_CONFIG } from '../../constants';
import { getDepthHorizontalGap, getDepthVerticalGap } from '../../constants/layout';
import {
  calculateSubtreeHeight,
  calculateNodeWidth,
  calculateNodeHeight,
  calculateBounds,
  resolveSubtreeOverlaps,
  recenterParents,
  normalizeLayoutRoot,
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
    // （children 恒为根的直接子节点 → 绝对层级 1，供深度间距收敛）
    const childrenWithHeight = children.map((child, originalIndex) => ({
      node: child,
      height: calculateSubtreeHeight(child, config, false, 1),
      originalIndex,
    }));

    // 按视觉高度降序排列——大的先分配，贪心效果更好
    const sorted = [...childrenWithHeight].sort((a, b) => b.height - a.height);

    const leftIndices: number[] = [];
    const rightIndices: number[] = [];
    let leftHeight = 0;
    let rightHeight = 0;

    // 贪心分配：将子树放到累计高度较小的一侧（含间距）
    // ★ P1 修复：高度相等时不再恒偏左——先比子树数量，再默认右侧
    //   （首条分支默认出现在右侧，等高兄弟左右交替）
    for (const item of sorted) {
      const placeRight =
        rightHeight < leftHeight ||
        (rightHeight === leftHeight && rightIndices.length <= leftIndices.length);
      if (placeRight) {
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
    // 入口防御：children 缺失时补空数组
    root = normalizeLayoutRoot(root);
    const nodes: Node<LogicBalancedNodeData>[] = [];
    const edges: Edge[] = [];
    const mindmapNodeById = new Map<string, MindMapNode>();
    // 深度超限截断标记（随 bounds 返回，供上层提示）
    let truncated = false;

    // ★ P0 修复：添加深度限制，防止栈溢出
    const collectMindMapNode = (current: MindMapNode, depth: number = 0) => {
      if (depth > MAX_TREE_DEPTH) {
        console.warn(`[LogicBalancedLayoutEngine] Tree depth exceeds limit (${MAX_TREE_DEPTH})`);
        truncated = true;
        return;
      }
      mindmapNodeById.set(current.id, current);
      current.children?.forEach(child => collectMindMapNode(child, depth + 1));
    };
    collectMindMapNode(root, 0);

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
          ...(truncated ? { truncated: true } : {}),
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

      // 计算子树高度（一级节点绝对层级为 1；根级兄弟距 scale(0)=1 不收敛）
      const subtreeHeights = children.map(child =>
        calculateSubtreeHeight(child, config, false, 1)
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
     * @param x 右侧分支为左边缘；左侧分支为右边缘锚点（同 BalancedLayoutEngine 的向左语义）
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
        truncated = true;
        return config.nodeHeight;
      }

      const hasChildren = node.children && node.children.length > 0;
      const nodeWidth = calculateNodeWidth(node, config);
      const nodeHeight = calculateNodeHeight(node, false, config);
      // ★ P0 修复：左侧不再用 children[0] 的宽度定锚——
      //   x 是右边缘锚点，实际左边缘 = x - ownWidth（宽窄兄弟各自独立，避免错位/重叠）
      const nodeX = side === 'left' ? x - nodeWidth : x;

      // 根据分支位置设置 Handle 位置（同 BalancedLayoutEngine）
      // 左侧分支：target 在右边（连接根节点），source 在左边（连接子节点）
      // 右侧分支：target 在左边（连接根节点），source 在右边（连接子节点）
      const sourcePosition = side === 'left' ? 'left' : 'right';
      const targetPosition = side === 'left' ? 'right' : 'left';

      nodes.push({
        id: node.id,
        type: 'branchNode',
        position: { x: nodeX, y },
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
          // 折叠节点也要保留 hasChildren=true，展开按钮/子数徽章依赖它（与 Tree/OrgChart 语义一致）
          hasChildren,
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
      // railOffset 取父子实际层距的一半：父节点层级为 level - 1（level >= 1），
      // 深度间距收敛后层距变窄，竖直导轨须同步内移保持居中
      edges.push({
        id: `e-${parentId}-${node.id}`,
        source: parentId,
        target: node.id,
        type: 'orgchart',
        sourceHandle: isConnectingToRoot ? side : undefined,
        data: {
          direction: side,
          railOffset: getDepthHorizontalGap(config, level - 1) / 2,
        },
      });

      if (!hasChildren || node.collapsed) {
        return nodeHeight;
      }

      // 层距/兄弟距随本节点层级收敛（level >= 1，一级节点的子代起开始收紧）
      const levelGap = getDepthHorizontalGap(config, level);
      const siblingGap = getDepthVerticalGap(config, level);

      // 右侧：子节点左边缘；左侧：子节点右边缘锚点（各子节点再按自身宽度回退）
      const childX =
        side === 'right'
          ? nodeX + nodeWidth + levelGap
          : nodeX - levelGap;

      const subtreeHeights = node.children!.map(child =>
        calculateSubtreeHeight(child, config, false, level + 1)
      );
      const totalHeight = subtreeHeights.reduce(
        (sum, h, i) => sum + h + (i > 0 ? siblingGap : 0),
        0
      );

      let currentY = y + nodeHeight / 2 - totalHeight / 2;

      node.children!.forEach((child, index) => {
        layoutSubtree(child, childX, currentY, level + 1, node.id, side);
        currentY += subtreeHeights[index] + siblingGap;
      });

      return Math.max(nodeHeight, totalHeight);
    };

    // 布局左侧：传入右边缘锚点（根左边缘 0 - gap），各子节点按自身宽度定位
    if (left.length > 0) {
      const leftAnchorX = -config.horizontalGap;
      layoutSide(left, 'left', leftAnchorX);
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

    // 计算边界（直接查原始节点，避免用 data 拼装的伪节点丢失 refs 等高度因素）
    const layoutBoxes = nodes.map(node => {
      const mmNode = mindmapNodeById.get(node.id);
      const isRootNode = !!node.data?.isRoot || node.type === 'rootNode';
      const width = mmNode ? calculateNodeWidth(mmNode, config, isRootNode) : config.nodeMinWidth;
      const height = mmNode ? calculateNodeHeight(mmNode, isRootNode, config) : config.nodeHeight;
      return { x: node.position.x, y: node.position.y, width, height };
    });
    const bounds: LayoutBoundsWithMeta = {
      ...calculateBounds(layoutBoxes),
      ...(truncated ? { truncated: true } : {}),
    };

    return { nodes, edges, bounds };
  }
}
