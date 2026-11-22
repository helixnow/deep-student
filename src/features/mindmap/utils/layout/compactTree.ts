/**
 * 兄弟子树轮廓紧凑（简化版 Reingold-Tilford 第二趟）
 *
 * 栈式初排与 resolveSubtreeOverlaps 都按「整块子树包围盒」分离兄弟，
 * 深而窄的子树会在浅层留下大片空白。本模块按同侧兄弟顺序，用子树间的
 * 实际轮廓（上下包络线扫描比较）把后一个子树尽可能上提，
 * 使相邻子树的最小垂直净距恰为 siblingGap，显著提升「贴边感」。
 *
 * ## 复杂度优化
 *
 * - 将逐对节点盒枚举（$O(N^2)$）改为「X 排序互不相交区间的上下轮廓包络」：
 *   - 已放置兄弟维护压缩下轮廓 `placedBottom`（同 X 区间保留最大 `maxY`，相邻等高区间自动合并）；
 *   - 新子树以压缩上轮廓 `topContour`（同 X 区间保留最小 `minY`）经二分定位 + 双指针扫描计算最小垂直净距；
 *   - 子树垂直上提改用延迟偏移 `pendingShifts`，底向上紧凑结束后单趟 $O(N)$ 顶向下统一下发，
 *     避免深树逐层重复平移与全量盒数组拷贝。
 * - 数学上与全量逐对 X 重叠盒比较 100% 等价，零节点重叠，宽树/大树性能提升一个数量级。
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
 * - 默认开启（config.compactSiblings !== false）。
 */

import type { MindMapNode, LayoutConfig } from '../../types';
import { depthGapScale } from '../../constants/layout';
import { calculateNodeWidth, calculateNodeHeight } from './helpers';

/** 最大递归深度限制（与 helpers/countDescendants 一致） */
const MAX_COMPACT_DEPTH = 500;
/** `Array.prototype.splice` 展开参数安全上限，超出后走线性重建避免调用栈溢出 */
const SPLICE_ARG_LIMIT = 4096;

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

/**
 * 水平 X 轴分段常量轮廓区间：
 * 不变量：`minX < maxX`；同一数组内按 `minX` 严格递增且互不重叠（`spans[i].maxX <= spans[i+1].minX`）。
 */
interface ContourSpan {
  minX: number;
  maxX: number;
  y: number;
}

interface SubtreeContour {
  node: MindMapNode;
  ownBox: Box;
  minX: number;
  maxX: number;
  /** 子树上轮廓：各 X 区间内所有节点 minY 的最小值 */
  topContour: ContourSpan[];
  /** 子树下轮廓：各 X 区间内所有节点 maxY 的最大值 */
  bottomContour: ContourSpan[];
  /** 父层紧凑施加到本子树的延迟 Y 偏移（≤ 0） */
  yOffset: number;
}

interface GroupContourResult {
  topContour: ContourSpan[];
  bottomContour: ContourSpan[];
  minX: number;
  maxX: number;
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

/** 追加并压缩相邻等高区间 */
function pushSpan(out: ContourSpan[], minX: number, maxX: number, y: number): void {
  if (maxX <= minX) return;
  const last = out[out.length - 1];
  if (last && last.maxX === minX && last.y === y) {
    last.maxX = maxX;
  } else {
    out.push({ minX, maxX, y });
  }
}

/** 二分查找首个 `maxX > x` 的区间索引 */
function findFirstSpanEndingAfter(spans: readonly ContourSpan[], x: number): number {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (spans[mid].maxX <= x) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** 二分查找首个 `minX >= x` 的区间索引 */
function findFirstSpanStartingAtOrAfter(spans: readonly ContourSpan[], x: number): number {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (spans[mid].minX < x) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * 线性归并两段 X 排序互不相交轮廓：
 * - `pickMax = true`：合并下轮廓（重叠区间取较大 `y`）
 * - `pickMax = false`：合并上轮廓（重叠区间取较小 `y`）
 */
function mergeContoursSlice(
  a: readonly ContourSpan[],
  aFrom: number,
  aTo: number,
  offsetA: number,
  b: readonly ContourSpan[],
  offsetB: number,
  pickMax: boolean
): ContourSpan[] {
  const out: ContourSpan[] = [];
  let i = aFrom;
  let j = 0;
  let cursor = -Infinity;

  while (i < aTo && j < b.length) {
    const sa = a[i];
    const sb = b[j];
    const aStart = sa.minX > cursor ? sa.minX : cursor;
    const bStart = sb.minX > cursor ? sb.minX : cursor;

    if (sa.maxX <= bStart) {
      pushSpan(out, aStart, sa.maxX, sa.y + offsetA);
      cursor = sa.maxX;
      i++;
    } else if (sb.maxX <= aStart) {
      pushSpan(out, bStart, sb.maxX, sb.y + offsetB);
      cursor = sb.maxX;
      j++;
    } else {
      if (aStart < bStart) {
        pushSpan(out, aStart, bStart, sa.y + offsetA);
      } else if (bStart < aStart) {
        pushSpan(out, bStart, aStart, sb.y + offsetB);
      }
      const overlapStart = aStart > bStart ? aStart : bStart;
      const overlapEnd = sa.maxX < sb.maxX ? sa.maxX : sb.maxX;
      const ya = sa.y + offsetA;
      const yb = sb.y + offsetB;
      const y = pickMax ? (ya >= yb ? ya : yb) : (ya <= yb ? ya : yb);
      pushSpan(out, overlapStart, overlapEnd, y);
      cursor = overlapEnd;
      if (sa.maxX <= overlapEnd) i++;
      if (sb.maxX <= overlapEnd) j++;
    }
  }

  while (i < aTo) {
    const sa = a[i++];
    const aStart = sa.minX > cursor ? sa.minX : cursor;
    pushSpan(out, aStart, sa.maxX, sa.y + offsetA);
    cursor = sa.maxX;
  }
  while (j < b.length) {
    const sb = b[j++];
    const bStart = sb.minX > cursor ? sb.minX : cursor;
    pushSpan(out, bStart, sb.maxX, sb.y + offsetB);
    cursor = sb.maxX;
  }

  return out;
}

function mergeContours(
  a: readonly ContourSpan[],
  offsetA: number,
  b: readonly ContourSpan[],
  offsetB: number,
  pickMax: boolean
): ContourSpan[] {
  if (a.length === 0) {
    return b.map(s => ({ minX: s.minX, maxX: s.maxX, y: s.y + offsetB }));
  }
  if (b.length === 0) {
    return a.map(s => ({ minX: s.minX, maxX: s.maxX, y: s.y + offsetA }));
  }
  return mergeContoursSlice(a, 0, a.length, offsetA, b, offsetB, pickMax);
}

/**
 * 局部原地更新轮廓：仅对与 `incoming` 水平区间重叠的 `target[lo..hi)` 切片归并并做边界压缩。
 */
function mergeIntoContourInPlace(
  target: ContourSpan[],
  incoming: readonly ContourSpan[],
  incomingOffsetY: number,
  pickMax: boolean
): void {
  if (incoming.length === 0) return;
  if (target.length === 0) {
    for (const s of incoming) {
      target.push({ minX: s.minX, maxX: s.maxX, y: s.y + incomingOffsetY });
    }
    return;
  }

  const inMinX = incoming[0].minX;
  const inMaxX = incoming[incoming.length - 1].maxX;
  const lo = findFirstSpanEndingAfter(target, inMinX);
  const hi = findFirstSpanStartingAtOrAfter(target, inMaxX);

  const merged = mergeContoursSlice(target, lo, hi, 0, incoming, incomingOffsetY, pickMax);

  let replaceLo = lo;
  let replaceHi = hi;
  if (replaceLo > 0 && merged.length > 0) {
    const prev = target[replaceLo - 1];
    const first = merged[0];
    if (prev.maxX === first.minX && prev.y === first.y) {
      first.minX = prev.minX;
      replaceLo -= 1;
    }
  }
  if (replaceHi < target.length && merged.length > 0) {
    const next = target[replaceHi];
    const last = merged[merged.length - 1];
    if (last.maxX === next.minX && last.y === next.y) {
      last.maxX = next.maxX;
      replaceHi += 1;
    }
  }

  if (merged.length < SPLICE_ARG_LIMIT) {
    target.splice(replaceLo, replaceHi - replaceLo, ...merged);
  } else {
    const rebuilt: ContourSpan[] = [];
    for (let k = 0; k < replaceLo; k++) rebuilt.push(target[k]);
    for (let k = 0; k < merged.length; k++) rebuilt.push(merged[k]);
    for (let k = replaceHi; k < target.length; k++) rebuilt.push(target[k]);
    target.length = 0;
    for (let k = 0; k < rebuilt.length; k++) target.push(rebuilt[k]);
  }
}

/** 分治归并同组所有子树的上轮廓（O(sum|contour| · log K)） */
function mergeGroupTopContours(items: readonly SubtreeContour[]): ContourSpan[] {
  if (items.length === 0) return [];
  let level: ContourSpan[][] = items.map(it =>
    it.yOffset === 0
      ? it.topContour
      : it.topContour.map(s => ({ minX: s.minX, maxX: s.maxX, y: s.y + it.yOffset }))
  );
  while (level.length > 1) {
    const next: ContourSpan[][] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        next.push(mergeContours(level[i], 0, level[i + 1], 0, false));
      } else {
        next.push(level[i]);
      }
    }
    level = next;
  }
  return level[0];
}

/**
 * 计算「已放置下轮廓」与「当前子树上轮廓」之间的最小垂直净距。
 * 利用二分定位首个重叠 X 区间 + 双指针扫描线，只访问实际 X 重叠的轮廓片段。
 * 数学上等价于对所有 X 重叠盒对求 `min(b.minY - a.maxY)`。
 * @returns 最小净距（current 在下时为正）；无任何 X 重叠时 Infinity
 */
function minVerticalClearance(
  placedBottom: readonly ContourSpan[],
  currentTop: readonly ContourSpan[],
  currentOffsetY: number = 0
): number {
  if (placedBottom.length === 0 || currentTop.length === 0) return Infinity;
  const topMinX = currentTop[0].minX;
  const topMaxX = currentTop[currentTop.length - 1].maxX;
  if (placedBottom[placedBottom.length - 1].maxX <= topMinX) return Infinity;
  if (placedBottom[0].minX >= topMaxX) return Infinity;

  let i = findFirstSpanEndingAfter(placedBottom, topMinX);
  let j = 0;
  let minGap = Infinity;

  while (i < placedBottom.length && j < currentTop.length) {
    const a = placedBottom[i];
    if (a.minX >= topMaxX) break;
    const b = currentTop[j];
    if (a.maxX <= b.minX) {
      i++;
    } else if (b.maxX <= a.minX) {
      j++;
    } else {
      const gap = (b.y + currentOffsetY) - a.y;
      if (gap < minGap) minGap = gap;
      if (a.maxX <= b.maxX) i++;
      else j++;
    }
  }
  return minGap;
}

/** 自底向上递归紧凑，记录每棵子树的延迟偏移并返回压缩上下轮廓 */
function compactSubtreeContour(
  node: MindMapNode,
  nodesById: Map<string, LayoutNodeLike>,
  config: LayoutConfig,
  isRoot: boolean,
  depth: number,
  siblingGap: number,
  pendingShifts: Map<MindMapNode, number>,
  boxByNode: Map<MindMapNode, Box>
): SubtreeContour {
  const layoutNode = nodesById.get(node.id);
  const ownBox = nodeBox(node, layoutNode, config, isRoot);
  boxByNode.set(node, ownBox);

  const ownTop: ContourSpan[] =
    ownBox.maxX > ownBox.minX ? [{ minX: ownBox.minX, maxX: ownBox.maxX, y: ownBox.minY }] : [];
  const ownBottom: ContourSpan[] =
    ownBox.maxX > ownBox.minX ? [{ minX: ownBox.minX, maxX: ownBox.maxX, y: ownBox.maxY }] : [];

  if (depth > MAX_COMPACT_DEPTH) {
    console.warn(`[compactTree] compactSiblingSubtrees depth exceeds limit (${MAX_COMPACT_DEPTH})`);
    return {
      node,
      ownBox,
      minX: ownBox.minX,
      maxX: ownBox.maxX,
      topContour: ownTop,
      bottomContour: ownBottom,
      yOffset: 0,
    };
  }

  if (node.collapsed || !node.children || node.children.length === 0) {
    return {
      node,
      ownBox,
      minX: ownBox.minX,
      maxX: ownBox.maxX,
      topContour: ownTop,
      bottomContour: ownBottom,
      yOffset: 0,
    };
  }

  // 先递归紧凑每个子树内部（返回各子树的压缩上下轮廓）
  const childrenContours = node.children.map(child =>
    compactSubtreeContour(child, nodesById, config, false, depth + 1, siblingGap, pendingShifts, boxByNode)
  );

  // 同侧分组（与 resolveSubtreeOverlaps 语义一致），避免平衡布局左右分支互相牵拉
  const parentCenterX = (ownBox.minX + ownBox.maxX) / 2;
  const leftGroup: SubtreeContour[] = [];
  const rightGroup: SubtreeContour[] = [];
  const spanGroup: SubtreeContour[] = [];
  for (const item of childrenContours) {
    if (item.maxX <= parentCenterX) leftGroup.push(item);
    else if (item.minX >= parentCenterX) rightGroup.push(item);
    else spanGroup.push(item);
  }

  // 紧凑目标净距随本节点层级收敛，与 resolveSubtreeOverlaps 的 gapAtDepth 一致
  const gapAtDepth = siblingGap * depthGapScale(config, depth);
  const compactGroup = (items: SubtreeContour[]): GroupContourResult | null => {
    if (items.length === 0) return null;
    const placedBottom: ContourSpan[] = [];
    let groupMinX = Infinity;
    let groupMaxX = -Infinity;

    for (const item of items) {
      if (placedBottom.length > 0) {
        const clearance = minVerticalClearance(placedBottom, item.topContour, item.yOffset);
        const delta = clearance - gapAtDepth;
        // 仅上提（正 delta）；净距不足的异常情形维持 resolve 结果不动
        if (Number.isFinite(delta) && delta > 0) {
          item.yOffset -= delta;
          pendingShifts.set(item.node, (pendingShifts.get(item.node) ?? 0) - delta);
        }
      }
      mergeIntoContourInPlace(placedBottom, item.bottomContour, item.yOffset, true);
      if (item.minX < groupMinX) groupMinX = item.minX;
      if (item.maxX > groupMaxX) groupMaxX = item.maxX;
    }

    return {
      topContour: mergeGroupTopContours(items),
      bottomContour: placedBottom,
      minX: groupMinX,
      maxX: groupMaxX,
    };
  };

  const groupResults = [
    compactGroup(leftGroup),
    compactGroup(rightGroup),
    compactGroup(spanGroup),
  ].filter((g): g is GroupContourResult => g !== null);

  // 紧凑改变了子节点 Y 分布，立即将本节点重居中于直接子节点
  // （与 recenterParents 同公式：首子顶边 ↔ 末子底边的中点），
  // 使父层的兄弟比较拿到的是本子树的最终坐标
  if (layoutNode && childrenContours.length > 0) {
    const first = childrenContours[0];
    const last = childrenContours[childrenContours.length - 1];
    const childrenMidY =
      (first.ownBox.minY + first.yOffset + (last.ownBox.maxY + last.yOffset)) / 2;
    const ownHeight = ownBox.maxY - ownBox.minY;
    layoutNode.position.y = childrenMidY - ownHeight / 2;
    ownBox.minY = layoutNode.position.y;
    ownBox.maxY = layoutNode.position.y + ownHeight;
    if (ownTop.length > 0) ownTop[0].y = ownBox.minY;
    if (ownBottom.length > 0) ownBottom[0].y = ownBox.maxY;
  }

  let combinedTop = ownTop;
  let combinedBottom = ownBottom;
  let minX = ownBox.minX;
  let maxX = ownBox.maxX;
  for (const group of groupResults) {
    combinedTop = mergeContours(combinedTop, 0, group.topContour, 0, false);
    combinedBottom = mergeContours(combinedBottom, 0, group.bottomContour, 0, true);
    if (group.minX < minX) minX = group.minX;
    if (group.maxX > maxX) maxX = group.maxX;
  }

  return {
    node,
    ownBox,
    minX,
    maxX,
    topContour: combinedTop,
    bottomContour: combinedBottom,
    yOffset: 0,
  };
}

/** 顶向下单趟 O(N) 下发延迟偏移并收集最终节点盒（首元素恒为根节点自身盒） */
function applyPendingShifts(
  node: MindMapNode,
  nodesById: Map<string, LayoutNodeLike>,
  pendingShifts: Map<MindMapNode, number>,
  boxByNode: Map<MindMapNode, Box>,
  inheritedShiftY: number,
  depth: number,
  outBoxes: Box[]
): void {
  const box = boxByNode.get(node);
  if (depth > MAX_COMPACT_DEPTH) {
    if (box) outBoxes.push(box);
    return;
  }

  const shiftY = inheritedShiftY + (pendingShifts.get(node) ?? 0);
  if (shiftY !== 0) {
    const layoutNode = nodesById.get(node.id);
    if (layoutNode) {
      layoutNode.position.y += shiftY;
    }
    if (box) {
      box.minY += shiftY;
      box.maxY += shiftY;
    }
  }
  if (box) {
    outBoxes.push(box);
  }

  if (node.collapsed || !node.children || node.children.length === 0) return;
  for (const child of node.children) {
    applyPendingShifts(child, nodesById, pendingShifts, boxByNode, shiftY, depth + 1, outBoxes);
  }
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
  const pendingShifts = new Map<MindMapNode, number>();
  const boxByNode = new Map<MindMapNode, Box>();

  compactSubtreeContour(node, nodesById, config, isRoot, depth, siblingGap, pendingShifts, boxByNode);

  const boxes: Box[] = [];
  applyPendingShifts(node, nodesById, pendingShifts, boxByNode, 0, depth, boxes);
  return boxes;
}
