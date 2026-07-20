/**
 * 时间轴布局引擎
 *
 * 横向时间轴：根节点在最左侧，一级节点（时间节点）沿水平主轴从左到右排列，
 * 二级及更深的节点在各自时间节点下方以缩进列表的形式垂直堆叠，
 * 使用直角折线（orgchart 边）连接。
 *
 * 对标 XMind 的 Timeline（水平）结构。
 */

import type { Node, Edge } from '@xyflow/react';
import type { MindMapNode, LayoutConfig, LayoutResult, NodeStyle } from '../../types';
import type { LayoutCategory, LayoutDirection, LayoutBoundsWithMeta } from '../../registry/types';
import { BaseLayoutEngine, MAX_TREE_DEPTH } from '../base/LayoutEngine';
import { DEFAULT_LAYOUT_CONFIG } from '../../constants';
import { getSiblingGap, getLevelGap } from '../../constants/layout';
import {
  calculateNodeWidth,
  calculateNodeHeight,
  calculateBounds,
  normalizeLayoutRoot,
} from '../../utils/layout/helpers';

/** 时间轴节点数据类型 */
interface TimelineNodeData extends Record<string, unknown> {
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

/** 二级及更深节点相对父节点的水平缩进（px） */
const TIMELINE_CHILD_INDENT = 24;

/**
 * 时间轴布局引擎
 *
 * 一级节点水平铺开构成主轴，深层节点垂直缩进悬挂
 */
export class TimelineLayoutEngine extends BaseLayoutEngine {
  readonly id = 'timeline';
  readonly name = 'layouts.timeline';
  readonly nameEn = 'layouts.timeline';
  readonly description = 'layouts.timelineDesc';
  readonly category: LayoutCategory = 'logic';
  readonly directions: LayoutDirection[] = ['right'];
  readonly defaultDirection: LayoutDirection = 'right';

  /**
   * 计算悬挂子树占用的水平宽度（节点宽度与缩进后代宽度的较大者）
   */
  private calculateHangingWidth(
    node: MindMapNode,
    config: LayoutConfig,
    depth: number = 0
  ): number {
    if (depth > MAX_TREE_DEPTH) {
      console.warn(`[TimelineLayoutEngine] calculateHangingWidth depth exceeds limit (${MAX_TREE_DEPTH})`);
      return calculateNodeWidth(node, config);
    }

    const nodeWidth = calculateNodeWidth(node, config);
    if (!node.children || node.children.length === 0 || node.collapsed) {
      return nodeWidth;
    }

    const maxChildWidth = node.children.reduce(
      (max, child) => Math.max(max, this.calculateHangingWidth(child, config, depth + 1)),
      0
    );
    return Math.max(nodeWidth, TIMELINE_CHILD_INDENT + maxChildWidth);
  }

  /**
   * 计算时间轴布局
   * @param root 根节点
   * @param config 布局配置
   * @param _direction 布局方向（当前仅支持 'right'）
   */
  calculate(
    root: MindMapNode,
    config: LayoutConfig = DEFAULT_LAYOUT_CONFIG,
    _direction: LayoutDirection = this.defaultDirection
  ): LayoutResult {
    // 入口防御：children 缺失时补空数组
    root = normalizeLayoutRoot(root);
    const nodes: Node<TimelineNodeData>[] = [];
    const edges: Edge[] = [];
    const siblingGap = getSiblingGap(config);
    const levelGap = getLevelGap(config);
    const mindmapNodeById = new Map<string, MindMapNode>();
    // 深度超限截断标记（随 bounds 返回，供上层提示）
    let truncated = false;

    // ★ 深度限制，防止栈溢出
    const collectMindMapNode = (current: MindMapNode, depth: number = 0) => {
      if (depth > MAX_TREE_DEPTH) {
        console.warn(`[TimelineLayoutEngine] Tree depth exceeds limit (${MAX_TREE_DEPTH})`);
        truncated = true;
        return;
      }
      mindmapNodeById.set(current.id, current);
      current.children?.forEach(child => collectMindMapNode(child, depth + 1));
    };
    collectMindMapNode(root, 0);

    const pushNode = (
      node: MindMapNode,
      x: number,
      y: number,
      level: number,
      sourcePosition: TimelineNodeData['sourcePosition'],
      targetPosition: TimelineNodeData['targetPosition']
    ) => {
      const isRootNode = level === 0;
      const hasChildren = !!node.children && node.children.length > 0;
      nodes.push({
        id: node.id,
        type: isRootNode ? 'rootNode' : 'branchNode',
        position: { x, y },
        width: calculateNodeWidth(node, config, isRootNode),
        height: calculateNodeHeight(node, isRootNode, config),
        data: {
          label: node.text || '',
          note: node.note,
          refs: node.refs,
          isRoot: isRootNode,
          level,
          collapsed: !!node.collapsed,
          completed: !!node.completed,
          hasChildren,
          childCount: this.countAllDescendants(node),
          nodeId: node.id,
          style: node.style,
          blankedRanges: node.blankedRanges,
          sourcePosition,
          targetPosition: isRootNode ? undefined : targetPosition,
        },
      });
    };

    /**
     * 递归布局悬挂子树（level >= 2 的缩进列表）
     * @returns 子树垂直总高度
     */
    const layoutHanging = (
      node: MindMapNode,
      x: number,
      y: number,
      level: number,
      parentId: string
    ): number => {
      if (level > MAX_TREE_DEPTH) {
        console.warn(`[TimelineLayoutEngine] Layout depth exceeds limit (${MAX_TREE_DEPTH})`);
        truncated = true;
        return config.nodeHeight;
      }

      const nodeHeight = calculateNodeHeight(node, false, config);
      pushNode(node, x, y, level, 'bottom', 'top');
      edges.push({
        id: `e-${parentId}-${node.id}`,
        source: parentId,
        target: node.id,
        type: 'orgchart',
        data: {
          direction: 'down',
          railOffset: siblingGap / 2,
        },
      });

      if (!node.children || node.children.length === 0 || node.collapsed) {
        return nodeHeight;
      }

      let currentY = y + nodeHeight + siblingGap;
      node.children.forEach(child => {
        const childHeight = layoutHanging(child, x + TIMELINE_CHILD_INDENT, currentY, level + 1, node.id);
        currentY += childHeight + siblingGap;
      });
      // 最后一个子树之后多加了一个 siblingGap，扣回
      return currentY - siblingGap - y;
    };

    // 根节点
    const rootWidth = calculateNodeWidth(root, config, true);
    const rootHeight = calculateNodeHeight(root, true, config);
    pushNode(root, 0, 0, 0, 'right', undefined);

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

    // 一级节点：沿主轴水平排列，节点中心对齐根节点中心
    let currentX = rootWidth + levelGap;
    root.children.forEach(entry => {
      const entryWidth = calculateNodeWidth(entry, config);
      const entryHeight = calculateNodeHeight(entry, false, config);
      const entryY = rootHeight / 2 - entryHeight / 2;

      pushNode(entry, currentX, entryY, 1, 'bottom', 'left');
      edges.push({
        id: `e-${root.id}-${entry.id}`,
        source: root.id,
        target: entry.id,
        type: 'orgchart',
        data: {
          direction: 'right',
          railOffset: levelGap / 2,
        },
      });

      // 悬挂后代：从时间节点正下方开始垂直堆叠
      if (entry.children && entry.children.length > 0 && !entry.collapsed) {
        let currentY = entryY + entryHeight + siblingGap;
        entry.children.forEach(child => {
          const childHeight = layoutHanging(
            child,
            currentX + TIMELINE_CHILD_INDENT,
            currentY,
            2,
            entry.id
          );
          currentY += childHeight + siblingGap;
        });
      }

      // 主轴槽位推进：取时间节点自身宽度与悬挂子树宽度的较大者
      const slotWidth = Math.max(entryWidth, this.calculateHangingWidth(entry, config, 1));
      currentX += slotWidth + siblingGap;
    });

    // 计算边界
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
