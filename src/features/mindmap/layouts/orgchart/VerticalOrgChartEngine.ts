/**
 * 垂直组织结构图布局引擎
 * 
 * 从上到下的层级结构图，子节点水平排列
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
  resolveSubtreeOverlapsX,
  recenterParentsX,
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
   * ★ P1 修复：兄弟间距改用语义化 siblingGap（原先误用 verticalGap 命名，
   *   现通过 getSiblingGap 读取，未配置时保持原有回退值不变）
   *
   * @param depth 节点绝对层级（callsite 传 level）；直接子节点间的兄弟距
   *   = siblingGap × depthGapScale(config, depth)，与布局阶段一致
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

    const siblingGap = getSiblingGap(config) * depthGapScale(config, depth);
    const childrenWidth = node.children.reduce(
      (sum, child, i) => sum + this.calculateSubtreeWidth(child, config, depth + 1, false) + (i > 0 ? siblingGap : 0),
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
    // 入口防御：children 缺失时补空数组
    root = normalizeLayoutRoot(root);
    const validDirection = this.getValidDirection(direction);
    const isUp = validDirection === 'up';

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
        console.warn(`[VerticalOrgChartEngine] Tree depth exceeds limit (${MAX_TREE_DEPTH})`);
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
        console.warn(`[VerticalOrgChartEngine] Layout depth exceeds limit (${MAX_TREE_DEPTH})`);
        truncated = true;
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

      // 添加边（使用 orgchart 类型实现组织结构图的直角连线）
      // railOffset 取父子实际层距的一半：父节点层级为 level - 1（有 parentId 时 level >= 1），
      // 深度间距收敛后层距变窄，水平导轨须同步内移保持居中
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

      // 如果没有子节点或已折叠，返回子树宽度
      if (!hasChildren || isCollapsed) {
        return subtreeWidth;
      }

      // 层距/兄弟距随本节点层级收敛（scale(0)=1 → 根到一级保持现值）
      const levelGapAt = levelGap * depthGapScale(config, level);
      const siblingGapAt = siblingGap * depthGapScale(config, level);

      // 布局子节点（水平排列）
      // ★ P1 修复：向上布局时子节点 Y 按各自高度贴合（底边对齐到父节点上方
      //   levelGap 处），原先统一用父节点高度回退，多行子节点会与父节点重叠
      let currentX = x;
      node.children!.forEach((child) => {
        const childWidth = this.calculateSubtreeWidth(child, config, level + 1);
        const childHeight = calculateNodeHeight(child, false, config);
        const childY = isUp
          ? y - levelGapAt - childHeight
          : y + nodeHeight + levelGapAt;
        layoutNode(child, currentX, childY, level + 1, node.id);
        currentX += childWidth + siblingGapAt;
      });

      return subtreeWidth;
    };

    // 从根节点开始布局
    layoutNode(root, 0, 0, 0);

    // ★ P1 修复：补齐水平方向的子树碰撞消除 + 父节点重新居中
    //   （measuredNodeHeights 注入实测宽高后估算与首帧可能不一致，兜底防重叠）
    const nodesById = new Map(nodes.map(node => [node.id, node]));
    resolveSubtreeOverlapsX(root, nodesById, config, siblingGap, true);
    recenterParentsX(root, nodesById, config, true);

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
