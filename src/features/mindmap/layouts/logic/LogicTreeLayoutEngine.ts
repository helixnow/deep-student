/**
 * 逻辑图树形布局引擎
 * 
 * 与普通树形布局类似，但使用直角折线连接
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

/** 逻辑图节点数据类型 */
interface LogicNodeData extends Record<string, unknown> {
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
 * 逻辑图树形布局引擎
 * 
 * 将思维导图节点按照逻辑图风格进行布局，
 * 使用直角折线连接节点，支持向左或向右展开
 */
export class LogicTreeLayoutEngine extends BaseLayoutEngine {
  readonly id = 'logic-tree';
  readonly name = 'layouts.logicTree';
  readonly nameEn = 'layouts.logicTree';
  readonly description = 'layouts.logicTreeDesc';
  readonly category: LayoutCategory = 'logic';
  readonly directions: LayoutDirection[] = ['right', 'left'];
  readonly defaultDirection: LayoutDirection = 'right';

  /**
   * 计算逻辑图树形布局
   * @param root 根节点
   * @param config 布局配置
   * @param direction 布局方向（'left' 或 'right'）
   * @returns 布局结果
   */
  calculate(
    root: MindMapNode,
    config: LayoutConfig = DEFAULT_LAYOUT_CONFIG,
    direction: LayoutDirection = this.defaultDirection
  ): LayoutResult {
    // 入口防御：children 缺失时补空数组
    root = normalizeLayoutRoot(root);
    const validDirection = this.getValidDirection(direction);
    const isLeftDirection = validDirection === 'left';

    const nodes: Node<LogicNodeData>[] = [];
    const edges: Edge[] = [];
    const mindmapNodeById = new Map<string, MindMapNode>();
    // 深度超限截断标记（随 bounds 返回，供上层提示）
    let truncated = false;

    // ★ P0 修复：添加深度限制
    const collectMindMapNode = (current: MindMapNode, depth: number = 0) => {
      if (depth > MAX_TREE_DEPTH) {
        console.warn(`[LogicTreeLayoutEngine] Tree depth exceeds limit (${MAX_TREE_DEPTH})`);
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
        console.warn(`[LogicTreeLayoutEngine] Layout depth exceeds limit (${MAX_TREE_DEPTH})`);
        truncated = true;
        return config.nodeHeight;
      }

      const hasChildren = node.children && node.children.length > 0;
      const isCollapsed = node.collapsed;
      const isRootNode = level === 0;
      const nodeWidth = calculateNodeWidth(node, config, isRootNode);
      const nodeHeight = calculateNodeHeight(node, isRootNode, config);

      // 计算节点实际 X 位置（向左展开时需要调整）
      const nodeX = isLeftDirection && level > 0 ? x - nodeWidth : x;

      // 根据布局方向设置 Handle 位置（同 TreeLayoutEngine）
      // 向右布局：根节点 source 在右边，分支节点 target 在左边、source 在右边
      // 向左布局：根节点 source 在左边，分支节点 target 在右边、source 在左边
      const sourcePosition = isLeftDirection ? 'left' : 'right';
      const targetPosition = isLeftDirection ? 'right' : 'left';

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
          hasChildren: hasChildren,
          childCount: this.countAllDescendants(node),
          nodeId: node.id,
          style: node.style,
          blankedRanges: node.blankedRanges,
          sourcePosition,
          targetPosition: level === 0 ? undefined : targetPosition,
        },
      });
      // layoutBoxes 将在最终阶段统一计算

      // 添加边（使用 orgchart 类型实现逻辑图的阶梯连线）
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
            railOffset: getDepthHorizontalGap(config, level - 1) / 2,
          },
        });
      }

      // 如果没有子节点或已折叠，返回当前节点高度
      if (!hasChildren || isCollapsed) {
        return nodeHeight;
      }

      // 层距/兄弟距随本节点层级收敛（scale(0)=1 → 根到一级保持现值）
      const levelGap = getDepthHorizontalGap(config, level);
      const siblingGap = getDepthVerticalGap(config, level);

      // 计算子节点 X 位置
      let childX: number;
      if (isLeftDirection) {
        // 向左展开：子节点在父节点左侧
        childX = nodeX - levelGap;
      } else {
        // 向右展开：子节点在父节点右侧
        childX = x + nodeWidth + levelGap;
      }

      // 计算每个子节点的子树高度（传入子节点绝对层级，供深度间距收敛）
      const subtreeHeights = node.children!.map(child =>
        calculateSubtreeHeight(child, config, false, level + 1)
      );

      // 总高度
      const totalHeight = subtreeHeights.reduce(
        (sum, h, i) => sum + h + (i > 0 ? siblingGap : 0),
        0
      );

      // 起始 Y 位置：使子节点整体垂直居中于父节点
      let currentY = y + nodeHeight / 2 - totalHeight / 2;

      // 布局子节点
      node.children!.forEach((child, index) => {
        layoutNode(child, childX, currentY, level + 1, node.id);
        currentY += subtreeHeights[index] + siblingGap;
      });

      return Math.max(nodeHeight, totalHeight);
    };

    // 从根节点开始布局
    layoutNode(root, 0, 0, 0);

    // 基于实测高度的子树碰撞消除
    const nodesById = new Map(nodes.map(node => [node.id, node]));
    resolveSubtreeOverlaps(root, nodesById, config, true);
    recenterParents(root, nodesById, config, true);

    // 重新计算边界
    // ★ P0 修复：宽度估算传入 isRoot，保证 bounds 与实际渲染宽度一致
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
