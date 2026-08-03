/**
 * 水平组织结构图布局引擎
 * 
 * 从左到右（或从右到左）的层级结构图，子节点垂直排列
 * 使用 ReactFlow 内置的 smoothstep 边类型实现组织结构图连线
 */

import type { Node, Edge } from '@xyflow/react';
import type { MindMapNode, LayoutConfig, LayoutResult, NodeStyle } from '../../types';
import type { LayoutCategory, LayoutDirection, LayoutBoundsWithMeta } from '../../registry/types';
import { BaseLayoutEngine, MAX_TREE_DEPTH } from '../base/LayoutEngine';
import { DEFAULT_LAYOUT_CONFIG } from '../../constants';
import { getSiblingGap, getLevelGap, depthGapScale } from '../../constants/layout';
import {
  calculateNodeWidth,
  calculateNodeHeight,
  calculateBounds,
  resolveSubtreeOverlaps,
  recenterParents,
  normalizeLayoutRoot,
} from '../../utils/layout/helpers';

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
   * ★ P1 修复：传入 isRoot（根节点更高），兄弟间距改用语义化 siblingGap
   *
   * @param depth 节点绝对层级（callsite 传 level）；直接子节点间的兄弟距
   *   = siblingGap × depthGapScale(config, depth)，与布局阶段一致
   */
  private calculateSubtreeHeight(node: MindMapNode, config: LayoutConfig, depth: number = 0, isRoot: boolean = false): number {
    // 深度限制检查
    if (depth > MAX_TREE_DEPTH) {
      console.warn(`[HorizontalOrgChartEngine] calculateSubtreeHeight depth exceeds limit (${MAX_TREE_DEPTH})`);
      return config.nodeHeight;
    }

    const nodeHeight = calculateNodeHeight(node, isRoot, config);

    if (!node.children || node.children.length === 0 || node.collapsed) {
      return nodeHeight;
    }

    const siblingGap = getSiblingGap(config) * depthGapScale(config, depth);
    const childrenHeight = node.children.reduce(
      (sum, child, i) => sum + this.calculateSubtreeHeight(child, config, depth + 1, false) + (i > 0 ? siblingGap : 0),
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
    // 入口防御：children 缺失时补空数组
    root = normalizeLayoutRoot(root);
    const validDirection = this.getValidDirection(direction);
    const isLeft = validDirection === 'left';

    const nodes: Node<OrgChartNodeData>[] = [];
    const edges: Edge[] = [];
    const siblingGap = getSiblingGap(config);
    const levelGap = getLevelGap(config);
    const mindmapNodeById = new Map<string, MindMapNode>();
    // 深度超限截断标记（随 bounds 返回，供上层提示）
    let truncated = false;

    // ★ P0 修复：添加深度限制，防止栈溢出
    const collectMindMapNode = (current: MindMapNode, depth: number = 0) => {
      if (depth > MAX_TREE_DEPTH) {
        console.warn(`[HorizontalOrgChartEngine] Tree depth exceeds limit (${MAX_TREE_DEPTH})`);
        truncated = true;
        return;
      }
      mindmapNodeById.set(current.id, current);
      current.children?.forEach(child => collectMindMapNode(child, depth + 1));
    };
    collectMindMapNode(root, 0);

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
        truncated = true;
        return config.nodeHeight;
      }

      const hasChildren = node.children && node.children.length > 0;
      const isCollapsed = node.collapsed;
      const isRootNode = level === 0;
      const nodeWidth = calculateNodeWidth(node, config, isRootNode);
      const nodeHeight = calculateNodeHeight(node, isRootNode, config);

      const subtreeHeight = this.calculateSubtreeHeight(node, config, level, isRootNode);
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

      // 添加边（使用 orgchart 类型实现组织结构图的直角连线）
      // railOffset 取父子实际层距的一半：父节点层级为 level - 1（有 parentId 时 level >= 1），
      // 深度间距收敛后层距变窄，竖直导轨须同步内移保持居中
      if (parentId) {
        edges.push({
          id: `e-${parentId}-${node.id}`,
          source: parentId,
          target: node.id,
          type: 'orgchart',
          data: {
            direction: validDirection,
            railOffset: (levelGap * depthGapScale(config, level - 1)) / 2,
          },
        });
      }

      // 如果没有子节点或已折叠，返回子树高度
      if (!hasChildren || isCollapsed) {
        return subtreeHeight;
      }

      // 层距/兄弟距随本节点层级收敛（scale(0)=1 → 根到一级保持现值）
      const levelGapAt = levelGap * depthGapScale(config, level);
      const siblingGapAt = siblingGap * depthGapScale(config, level);

      // 计算子节点的 X 坐标
      let childX: number;
      if (isLeft) {
        childX = nodeX - levelGapAt;
      } else {
        childX = x + nodeWidth + levelGapAt;
      }

      // 布局子节点（垂直排列）
      let currentY = y;
      node.children!.forEach((child) => {
        const childHeight = this.calculateSubtreeHeight(child, config, level + 1);
        layoutNode(child, childX, currentY, level + 1, node.id);
        currentY += childHeight + siblingGapAt;
      });

      return subtreeHeight;
    };

    // 从根节点开始布局
    layoutNode(root, 0, 0, 0);

    // ★ P1 修复：补齐垂直方向的子树碰撞消除 + 父节点重新居中
    //   （与 Tree/Logic 引擎保持一致，实测高度注入后兜底防重叠）
    const nodesById = new Map(nodes.map(node => [node.id, node]));
    resolveSubtreeOverlaps(root, nodesById, config, true, 0, siblingGap);
    recenterParents(root, nodesById, config, true);

    // 基于最终位置重新计算边界
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
