/**
 * 归纳总结大括号 `}`（Summary Braces）纯逻辑与几何计算：
 * - 校验多选节点是否为同一父节点下的兄弟区间（resolveSiblingRangeForSummary）
 * - 节点删除 / 移动 / 缩进后的大括号裁剪与对齐（reconcileSummariesWithTree）
 * - 画布 flow 坐标系下的子树包络与三次贝塞尔大括号 SVG 路径（computeSummaryBraceGeometry）
 */

import type { LayoutDirection, MindMapDocument, MindMapNode, MindMapSummaryBrace } from '../types';
import { findNodeById } from './node/find';

export interface SiblingSummaryRange {
  parentId: string;
  startChildId: string;
  endChildId: string;
  startIndex: number;
  endIndex: number;
  coveredChildIds: string[];
}

export interface NodeBoxGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type SummaryBraceOrientation = 'right' | 'left' | 'down' | 'up';

export interface SummaryBraceGeometry {
  id: string;
  label: string;
  orientation: SummaryBraceOrientation;
  /** SVG cubic-bezier curly brace path in flow coordinates */
  path: string;
  /** Tip point of the curly brace where the summary pill attaches */
  tipX: number;
  tipY: number;
  /** Anchor position for the summary pill container */
  labelX: number;
  labelY: number;
}

const MAX_SUMMARY_LABEL_CHARS = 240;

function buildParentChildMap(root: MindMapNode): Map<string, { parent: MindMapNode; index: number }> {
  const map = new Map<string, { parent: MindMapNode; index: number }>();
  const stack: MindMapNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const children = node.children ?? [];
    for (let i = 0; i < children.length; i += 1) {
      map.set(children[i].id, { parent: node, index: i });
      stack.push(children[i]);
    }
  }
  return map;
}

/**
 * 判断选中的节点集合是否构成同一父节点下至少 2 个兄弟节点的连续或跨度区间。
 * 满足时返回 `[minIndex .. maxIndex]` 兄弟区间；否则返回 null。
 */
export function resolveSiblingRangeForSummary(
  root: MindMapNode,
  selectedNodeIds: readonly string[],
): SiblingSummaryRange | null {
  if (!Array.isArray(selectedNodeIds) || selectedNodeIds.length < 2) return null;
  const uniqueIds = Array.from(new Set(selectedNodeIds.filter(Boolean)));
  if (uniqueIds.length < 2) return null;

  const parentMap = buildParentChildMap(root);
  let sharedParent: MindMapNode | null = null;
  let minIndex = Infinity;
  let maxIndex = -Infinity;

  for (const nodeId of uniqueIds) {
    const entry = parentMap.get(nodeId);
    if (!entry) return null; // root 或不存在的节点
    if (!sharedParent) {
      sharedParent = entry.parent;
    } else if (sharedParent.id !== entry.parent.id) {
      return null; // 跨父节点不可直接生成同级大括号
    }
    if (entry.index < minIndex) minIndex = entry.index;
    if (entry.index > maxIndex) maxIndex = entry.index;
  }

  if (!sharedParent || minIndex >= maxIndex) return null;
  const covered = sharedParent.children.slice(minIndex, maxIndex + 1).map((c) => c.id);
  if (covered.length < 2) return null;

  return {
    parentId: sharedParent.id,
    startChildId: sharedParent.children[minIndex].id,
    endChildId: sharedParent.children[maxIndex].id,
    startIndex: minIndex,
    endIndex: maxIndex,
    coveredChildIds: covered,
  };
}

export function sanitizeSummaryLabel(raw: unknown, fallback = ''): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw.replace(/\r\n?/g, ' ').trim();
  if (!cleaned) return fallback;
  return cleaned.length > MAX_SUMMARY_LABEL_CHARS
    ? cleaned.slice(0, MAX_SUMMARY_LABEL_CHARS)
    : cleaned;
}

/** 校验并清洗文档 summaries 列表；无效或退化为单节点的条目自动丢弃 */
export function sanitizeDocumentSummaries(
  raw: unknown,
  root: MindMapNode,
): MindMapSummaryBrace[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: MindMapSummaryBrace[] = [];
  const seenIds = new Set<string>();
  const seenRanges = new Set<string>();

  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const candidate = item as Record<string, unknown>;
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const parentId = typeof candidate.parentId === 'string' ? candidate.parentId.trim() : '';
    const rawStart = typeof candidate.startChildId === 'string' ? candidate.startChildId.trim() : '';
    const rawEnd = typeof candidate.endChildId === 'string' ? candidate.endChildId.trim() : '';
    if (!id || !parentId || !rawStart || !rawEnd || seenIds.has(id)) continue;

    const parent = findNodeById(root, parentId);
    if (!parent || !Array.isArray(parent.children) || parent.children.length < 2) continue;

    const idxA = parent.children.findIndex((c) => c.id === rawStart);
    const idxB = parent.children.findIndex((c) => c.id === rawEnd);
    if (idxA < 0 || idxB < 0 || idxA === idxB) continue;

    const startIndex = Math.min(idxA, idxB);
    const endIndex = Math.max(idxA, idxB);
    const startChildId = parent.children[startIndex].id;
    const endChildId = parent.children[endIndex].id;
    const rangeKey = `${parentId}:${startChildId}:${endChildId}`;
    if (seenRanges.has(rangeKey)) continue;

    seenIds.add(id);
    seenRanges.add(rangeKey);
    out.push({
      id,
      parentId,
      startChildId,
      endChildId,
      label: sanitizeSummaryLabel(candidate.label, ''),
    });
  }

  return out.length > 0 ? out : undefined;
}

/** 树结构变更（删除 / 移动 / 缩进 / 反缩进）后同步修剪失效的大括号 */
export function reconcileSummariesWithTree(document: MindMapDocument): void {
  const record = document as unknown as Record<string, unknown>;
  if (!('summaries' in record)) return;
  const sanitized = sanitizeDocumentSummaries(document.summaries, document.root);
  if (sanitized && sanitized.length > 0) {
    document.summaries = sanitized;
  } else {
    delete record.summaries;
  }
}

interface BoundsRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function collectVisibleSubtreeBounds(
  node: MindMapNode,
  layoutById: ReadonlyMap<string, NodeBoxGeometry>,
): BoundsRect | null {
  const selfBox = layoutById.get(node.id);
  if (!selfBox) return null;

  const bounds: BoundsRect = {
    minX: selfBox.x,
    minY: selfBox.y,
    maxX: selfBox.x + selfBox.width,
    maxY: selfBox.y + selfBox.height,
  };

  if (!node.collapsed && node.children?.length) {
    for (const child of node.children) {
      const childBounds = collectVisibleSubtreeBounds(child, layoutById);
      if (!childBounds) continue;
      if (childBounds.minX < bounds.minX) bounds.minX = childBounds.minX;
      if (childBounds.minY < bounds.minY) bounds.minY = childBounds.minY;
      if (childBounds.maxX > bounds.maxX) bounds.maxX = childBounds.maxX;
      if (childBounds.maxY > bounds.maxY) bounds.maxY = childBounds.maxY;
    }
  }
  return bounds;
}

/** 生成平滑的 SVG 三次贝塞尔大括号路径 */
export function buildCurlyBraceSvgPath(
  orientation: SummaryBraceOrientation,
  spanStart: number,
  spanEnd: number,
  anchorCoord: number,
  armDepth = 10,
): { path: string; tipX: number; tipY: number } {
  const start = Math.min(spanStart, spanEnd);
  const end = Math.max(spanStart, spanEnd);
  const mid = (start + end) / 2;
  const r = Math.min(armDepth, Math.max(4, (end - start) / 4));

  if (orientation === 'right' || orientation === 'left') {
    const dir = orientation === 'right' ? 1 : -1;
    const baseX = anchorCoord;
    const spineX = baseX + dir * r;
    const tipX = spineX + dir * r;
    const path = [
      `M ${baseX} ${start}`,
      `Q ${spineX} ${start} ${spineX} ${start + r}`,
      `L ${spineX} ${mid - r}`,
      `Q ${spineX} ${mid} ${tipX} ${mid}`,
      `Q ${spineX} ${mid} ${spineX} ${mid + r}`,
      `L ${spineX} ${end - r}`,
      `Q ${spineX} ${end} ${baseX} ${end}`,
    ].join(' ');
    return { path, tipX, tipY: mid };
  }

  const dir = orientation === 'down' ? 1 : -1;
  const baseY = anchorCoord;
  const spineY = baseY + dir * r;
  const tipY = spineY + dir * r;
  const path = [
    `M ${start} ${baseY}`,
    `Q ${start} ${spineY} ${start + r} ${spineY}`,
    `L ${mid - r} ${spineY}`,
    `Q ${mid} ${spineY} ${mid} ${tipY}`,
    `Q ${mid} ${spineY} ${mid + r} ${spineY}`,
    `L ${end - r} ${spineY}`,
    `Q ${end} ${spineY} ${end} ${baseY}`,
  ].join(' ');
  return { path, tipX: mid, tipY };
}

/**
 * 计算单个归纳大括号在画布 flow 坐标系中的几何与标签锚点。
 * 若父节点已折叠或覆盖节点均未在当前视口子树内（如专注模式下不可见），返回 null。
 */
export function computeSummaryBraceGeometry(
  summary: MindMapSummaryBrace,
  root: MindMapNode,
  layoutById: ReadonlyMap<string, NodeBoxGeometry>,
  direction: LayoutDirection,
): SummaryBraceGeometry | null {
  const parent = findNodeById(root, summary.parentId);
  if (!parent || parent.collapsed || !parent.children?.length) return null;

  const idxA = parent.children.findIndex((c) => c.id === summary.startChildId);
  const idxB = parent.children.findIndex((c) => c.id === summary.endChildId);
  if (idxA < 0 || idxB < 0 || idxA === idxB) return null;

  const startIdx = Math.min(idxA, idxB);
  const endIdx = Math.max(idxA, idxB);
  const slice = parent.children.slice(startIdx, endIdx + 1);

  let union: BoundsRect | null = null;
  for (const child of slice) {
    const childBounds = collectVisibleSubtreeBounds(child, layoutById);
    if (!childBounds) continue;
    if (!union) {
      union = { ...childBounds };
    } else {
      if (childBounds.minX < union.minX) union.minX = childBounds.minX;
      if (childBounds.minY < union.minY) union.minY = childBounds.minY;
      if (childBounds.maxX > union.maxX) union.maxX = childBounds.maxX;
      if (childBounds.maxY > union.maxY) union.maxY = childBounds.maxY;
    }
  }
  if (!union) return null;

  let orientation: SummaryBraceOrientation = 'right';
  if (direction === 'left') {
    orientation = 'left';
  } else if (direction === 'down') {
    orientation = 'down';
  } else if (direction === 'up') {
    orientation = 'up';
  } else if (direction === 'both') {
    const parentBox = layoutById.get(parent.id);
    if (parentBox) {
      const parentCenterX = parentBox.x + parentBox.width / 2;
      const groupCenterX = (union.minX + union.maxX) / 2;
      orientation = groupCenterX < parentCenterX ? 'left' : 'right';
    }
  }

  const gap = 14;
  const labelGap = 8;
  if (orientation === 'right') {
    const { path, tipX, tipY } = buildCurlyBraceSvgPath(
      'right',
      union.minY + 2,
      union.maxY - 2,
      union.maxX + gap,
    );
    return {
      id: summary.id,
      label: summary.label,
      orientation,
      path,
      tipX,
      tipY,
      labelX: tipX + labelGap,
      labelY: tipY,
    };
  }
  if (orientation === 'left') {
    const { path, tipX, tipY } = buildCurlyBraceSvgPath(
      'left',
      union.minY + 2,
      union.maxY - 2,
      union.minX - gap,
    );
    return {
      id: summary.id,
      label: summary.label,
      orientation,
      path,
      tipX,
      tipY,
      labelX: tipX - labelGap,
      labelY: tipY,
    };
  }
  if (orientation === 'down') {
    const { path, tipX, tipY } = buildCurlyBraceSvgPath(
      'down',
      union.minX + 2,
      union.maxX - 2,
      union.maxY + gap,
    );
    return {
      id: summary.id,
      label: summary.label,
      orientation,
      path,
      tipX,
      tipY,
      labelX: tipX,
      labelY: tipY + labelGap,
    };
  }
  const { path, tipX, tipY } = buildCurlyBraceSvgPath(
    'up',
    union.minX + 2,
    union.maxX - 2,
    union.minY - gap,
  );
  return {
    id: summary.id,
    label: summary.label,
    orientation,
    path,
    tipX,
    tipY,
    labelX: tipX,
    labelY: tipY - labelGap,
  };
}
