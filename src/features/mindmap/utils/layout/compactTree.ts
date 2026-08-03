/**
 * 兄弟子树轮廓紧凑（简化版 Reingold-Tilford 第二趟）
 *
 * 栈式初排与 resolveSubtreeOverlaps 都按「整块子树包围盒」分离兄弟，
 * 深而窄的子树会在浅层留下大片空白。本模块按同侧兄弟顺序，用子树间的
 * 实际轮廓（所有节点盒的逐对 X 重叠比较）把后一个子树尽可能上提，
 * 使相邻子树的最小垂直净距恰为 siblingGap，显著提升「贴边感」。
 *
 * ## 管道位置（重要）
 *
 * 必须在 resolveSubtreeOverlaps + recenterParents **之后**作为最后一步运行：
 * resolve 的分离语义是包围盒级的（不可改动的既有契约），若紧凑先行，
 * resolve 会按包围盒把兄弟重新推开、完全抵消紧凑效果。
 *
 *   layoutNode(...) → resolveSubtreeOverlaps → recenterParents
 *     → compactSiblingSubtrees（自带父节点重居中）
 *
 * ## 安全性设计
 *
 * - 只做「上提」（delta > 0）：上提量以「与本组所有已放置节点盒的
 *   最小净距 = siblingGap」为界，不会产生新的重叠；
 *   净距不足（异常输入）时不动作，维持 resolve 的结果。
 * - 与 resolveSubtreeOverlaps 相同的同侧分组（左/右/跨越父中心），
 *   平衡布局左右分支互不牵拉。
 * - 自底向上递归；每层紧凑完成后立即将父节点重居中于直接子节点
 *  （与 recenterParents 同公式），保证上层比较使用最终坐标。
 * - 默认开启（config.compactSiblings !== false）。理由：紧凑度符合常见导图
 *   常见导图软件的核心差距，且算法只在既有安全间距内收紧、无重叠风险；
 *   如需回退旧观感，上层传 { compactSiblings: false } 即可。
 */

import type { MindMapNode, LayoutConfig } from '../../types';
import { depthGapScale } from '../../constants/layout';
import { calculateNodeWidth, calculateNodeHeight } from './helpers';

/** 最大递归深度限制（与 helpers/countDescendants 一致） */
const MAX_COMPACT_DEPTH = 500;

/** 带紧凑开关的布局配置（可选扩展字段，向后兼容 LayoutConfig） */
export interface CompactionLayoutConfig extends LayoutConfig {
  /** 兄弟子树轮廓紧凑开关（缺省 true） */
  compactSiblings?: boolean;
}

/** 读取紧凑开关（缺省开启） */
export function isCompactionEnabled(config: LayoutConfig): boolean {
  return (config as CompactionLayoutConfig).compactSiblings !== false;
}

interface LayoutNodeLike {
  id: string;
  position: { x: number; y: number };
}

interface Box {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function nodeBox(
  node: MindMapNode,
  layoutNode: LayoutNodeLike | undefined,
  config: LayoutConfig,
  isRoot: boolean
): Box {
  const width = calculateNodeWidth(node, config, isRoot);
  const height = calculateNodeHeight(node, isRoot, config);
  const x = layoutNode?.position.x ?? 0;
  const y = layoutNode?.position.y ?? 0;
  return { minX: x, maxX: x + width, minY: y, maxY: y + height };
}

/** 仅平移 Y 轴的子树移动（紧凑不改变水平锚点语义） */
function shiftSubtreeY(
  node: MindMapNode,
  nodesById: Map<string, LayoutNodeLike>,
  deltaY: number,
  depth: number = 0
): void {
  if (depth > MAX_COMPACT_DEPTH) return;
  const layoutNode = nodesById.get(node.id);
  if (layoutNode) {
    layoutNode.position.y += deltaY;
  }
  if (node.collapsed || !node.children || node.children.length === 0) return;
  node.children.forEach(child => shiftSubtreeY(child, nodesById, deltaY, depth + 1));
}

/**
 * 计算「已放置轮廓」与「当前子树」之间的最小垂直净距。
 * 仅比较 X 范围重叠的盒对（不同 X 带互不约束——这正是紧凑收益的来源）。
 * @returns 最小净距（current 在下时为正）；无任何 X 重叠时 Infinity
 */
function minVerticalClearance(placed: Box[], current: Box[]): number {
  let minGap = Infinity;
  for (const a of placed) {
    for (const b of current) {
      if (b.minX < a.maxX && b.maxX > a.minX) {
        const gap = b.minY - a.maxY;
        if (gap < minGap) minGap = gap;
      }
    }
  }
  return minGap;
}

/**
 * 递归紧凑兄弟子树（自底向上），返回子树内全部节点盒（紧凑后坐标）。
 * 首元素恒为节点自身盒（供父层重居中使用）。
 *
 * @param depth 节点绝对层级（引擎从根调用时为 0，递归层数 == 层级）；
 *   node 的直接子节点间紧凑目标净距 = siblingGap × depthGapScale(config, depth)，
 *   与 resolveSubtreeOverlaps 的分离间距一致（收敛关闭时 scale 恒 1）
 * @param siblingGap 兄弟子树最小垂直净距基准值（缺省 config.verticalGap）
 */
export function compactSiblingSubtrees(
  node: MindMapNode,
  nodesById: Map<string, LayoutNodeLike>,
  config: LayoutConfig,
  isRoot: boolean = false,
  depth: number = 0,
  siblingGap: number = config.verticalGap
): Box[] {
  const layoutNode = nodesById.get(node.id);
  const ownBox = nodeBox(node, layoutNode, config, isRoot);

  if (depth > MAX_COMPACT_DEPTH) {
    console.warn(`[compactTree] compactSiblingSubtrees depth exceeds limit (${MAX_COMPACT_DEPTH})`);
    return [ownBox];
  }

  if (node.collapsed || !node.children || node.children.length === 0) {
    return [ownBox];
  }

  // 先递归紧凑每个子树内部（返回值已是各子树的最终内部坐标）
  const childrenWithBoxes = node.children.map(child => ({
    node: child,
    boxes: compactSiblingSubtrees(child, nodesById, config, false, depth + 1, siblingGap),
  }));

  // 同侧分组（与 resolveSubtreeOverlaps 语义一致），避免平衡布局左右分支互相牵拉
  const parentCenterX = (ownBox.minX + ownBox.maxX) / 2;
  const envelope = (boxes: Box[]): Box =>
    boxes.reduce((acc, b) => ({
      minX: Math.min(acc.minX, b.minX),
      maxX: Math.max(acc.maxX, b.maxX),
      minY: Math.min(acc.minY, b.minY),
      maxY: Math.max(acc.maxY, b.maxY),
    }));

  type Item = { node: MindMapNode; boxes: Box[] };
  const leftGroup: Item[] = [];
  const rightGroup: Item[] = [];
  const spanGroup: Item[] = [];
  for (const item of childrenWithBoxes) {
    const env = envelope(item.boxes);
    if (env.maxX <= parentCenterX) leftGroup.push(item);
    else if (env.minX >= parentCenterX) rightGroup.push(item);
    else spanGroup.push(item);
  }

  // 紧凑目标净距随本节点层级收敛，与 resolveSubtreeOverlaps 的 gapAtDepth 一致
  const gapAtDepth = siblingGap * depthGapScale(config, depth);
  const compactGroup = (items: Item[]) => {
    const placed: Box[] = [];
    for (const item of items) {
      if (placed.length > 0) {
        const clearance = minVerticalClearance(placed, item.boxes);
        const delta = clearance - gapAtDepth;
        // 仅上提（正 delta）；净距不足的异常情形维持 resolve 结果不动
        if (Number.isFinite(delta) && delta > 0) {
          shiftSubtreeY(item.node, nodesById, -delta, depth + 1);
          item.boxes = item.boxes.map(b => ({ ...b, minY: b.minY - delta, maxY: b.maxY - delta }));
        }
      }
      placed.push(...item.boxes);
    }
  };

  compactGroup(leftGroup);
  compactGroup(rightGroup);
  compactGroup(spanGroup);

  // 紧凑改变了子节点 Y 分布，立即将本节点重居中于直接子节点
  // （与 recenterParents 同公式：首子顶边 ↔ 末子底边的中点），
  // 使父层的兄弟比较拿到的是本子树的最终坐标
  if (layoutNode && childrenWithBoxes.length > 0) {
    const firstChildBox = childrenWithBoxes[0].boxes[0];
    const lastChildBox = childrenWithBoxes[childrenWithBoxes.length - 1].boxes[0];
    const childrenMidY = (firstChildBox.minY + lastChildBox.maxY) / 2;
    const ownHeight = ownBox.maxY - ownBox.minY;
    layoutNode.position.y = childrenMidY - ownHeight / 2;
    ownBox.minY = layoutNode.position.y;
    ownBox.maxY = layoutNode.position.y + ownHeight;
  }

  return [ownBox, ...childrenWithBoxes.flatMap(item => item.boxes)];
}
