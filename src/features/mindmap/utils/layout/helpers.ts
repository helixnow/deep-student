/**
 * 布局辅助函数
 */

import type { MindMapNode, LayoutConfig, SubtreeSize } from '../../types';
import { DEFAULT_LAYOUT_CONFIG } from '../../constants';
import {
  NODE_DECORATION_ALLOWANCE,
  NOTE_FONT_SIZE,
  NOTE_LINE_HEIGHT_RATIO,
  ROOT_TEXT_RENDER_ALLOWANCE,
  depthGapScale,
  getDepthVerticalGap,
} from '../../constants/layout';
import {
  getThemeFontMetrics,
  MM_NODE_LINE_HEIGHT_RATIO,
  type ThemeFontMetrics,
} from '../../styles/themes';

/**
 * 最大递归深度限制
 * ★ P0 修复：防止深嵌套数据导致栈溢出
 */
const MAX_HELPER_DEPTH = 500;

/**
 * 默认主题字体度量缓存（root 18 / branch 15）
 *
 * 字号/padding 的权威数据源是 styles/themes 的 getThemeFontMetrics；
 * 布局估算目前不携带主题上下文，统一取默认主题度量。
 * 内置主题为静态常量，模块级缓存安全。
 */
let defaultMetricsCache: { root: ThemeFontMetrics; branch: ThemeFontMetrics } | null = null;
function defaultFontMetrics(isRoot: boolean): ThemeFontMetrics {
  if (!defaultMetricsCache) {
    defaultMetricsCache = {
      root: getThemeFontMetrics(null, true),
      branch: getThemeFontMetrics(null, false),
    };
  }
  return isRoot ? defaultMetricsCache.root : defaultMetricsCache.branch;
}

/**
 * 布局入口的根节点规范化：children 缺失时补空数组
 *
 * 文档模型约定始终提供 children: []，但外部导入/损坏数据可能缺失；
 * 引擎入口统一调用，避免 root.children.length 直接解引用抛错。
 * 仅在缺失时浅拷贝根节点（不影响 WeakMap 缓存——根节点本就不进缓存）。
 */
export function normalizeLayoutRoot(root: MindMapNode): MindMapNode {
  return Array.isArray(root.children) ? root : { ...root, children: [] };
}

/** 计算节点文本宽度（估算）；fontSize 缺省取主题分支字号 */
export function estimateTextWidth(text: string, fontSize?: number): number {
  // 安全检查：防止 text 为 undefined 或 null
  if (!text) {
    return 0;
  }
  const size = fontSize ?? defaultFontMetrics(false).fontSize;
  // 简单估算：中文字符宽度约等于字号，英文字符约等于字号的 0.6 倍
  let width = 0;
  for (const char of text) {
    if (/[\u4e00-\u9fa5]/.test(char)) {
      width += size;
    } else {
      width += size * 0.6;
    }
  }
  return width;
}

/** 估算文本在指定宽度下的行数（支持中文宽度） */
function estimateWrappedLines(text: string, fontSize: number, maxWidth: number): number {
  if (!text) {
    return 0;
  }
  const safeWidth = Math.max(1, maxWidth);
  return text.split('\n').reduce((total, line) => {
    const lineWidth = estimateTextWidth(line, fontSize);
    const lineCount = Math.max(1, Math.ceil(lineWidth / safeWidth));
    return total + lineCount;
  }, 0);
}

/** 节点估算字号（主题权威值根 18 / 分支 15，节点级样式可覆盖） */
function resolveNodeFontSize(node: MindMapNode, isRoot: boolean): number {
  return node.style?.fontSize || defaultFontMetrics(isRoot).fontSize;
}

/** 节点水平占位合计（主题 paddingX + 分支装饰预留 / 根节点文本渲染预留） */
function resolveNodeHPadding(isRoot: boolean): number {
  return defaultFontMetrics(isRoot).paddingX
    + (isRoot ? ROOT_TEXT_RENDER_ALLOWANCE : NODE_DECORATION_ALLOWANCE);
}

/** 计算节点实际宽度 */
export function calculateNodeWidth(
  node: MindMapNode,
  config: LayoutConfig = DEFAULT_LAYOUT_CONFIG,
  isRoot: boolean = false
): number {
  const fontSize = resolveNodeFontSize(node, isRoot);
  const textWidth = estimateTextWidth(node.text, fontSize);
  const padding = resolveNodeHPadding(isRoot);
  const width = textWidth + padding;

  // 如果有 note，宽度稍微增加一点以示区别（可选）
  const finalWidth = node.note ? Math.max(width, 100) : width;

  return Math.max(config.nodeMinWidth, Math.min(finalWidth, config.nodeMaxWidth));
}

/** 计算节点高度 */
export function calculateNodeHeight(
  node: MindMapNode,
  isRoot: boolean,
  config: LayoutConfig = DEFAULT_LAYOUT_CONFIG
): number {
  const baseHeight = isRoot ? config.rootNodeHeight : config.nodeHeight;

  const measuredHeight = config.measuredNodeHeights?.[node.id];
  if (Number.isFinite(measuredHeight) && (measuredHeight as number) > 0) {
    return measuredHeight as number;
  }

  const nodeWidth = calculateNodeWidth(node, config, isRoot);

  // 文本行高估算：默认 line-height 1.5
  // ★ P0 修复：长句到达 nodeMaxWidth 后会自动换行，
  //   这里复用 note 的换行估算逻辑，按可用内容宽度估算实际行数，
  //   避免首帧低估高度导致节点重叠。
  const textFontSize = resolveNodeFontSize(node, isRoot);
  const textLineHeight = Math.ceil(textFontSize * MM_NODE_LINE_HEIGHT_RATIO);
  const contentWidth = nodeWidth - resolveNodeHPadding(isRoot);
  const textLines = Math.max(1, estimateWrappedLines(node.text || '', textFontSize, contentWidth));
  const extraTextHeight = (textLines - 1) * textLineHeight;

  const totalHeight = baseHeight + extraTextHeight;

  if (!node.note && !node.refs?.length) {
    return totalHeight;
  }

  // 备注高度估算（whitespace-pre-wrap，按可用宽度换行）
  let extraHeight = 0;
  if (node.note) {
    // 备注区可用宽度（扣除左右 padding）
    const noteContentWidth = nodeWidth - 16;
    const noteLines = estimateWrappedLines(node.note, NOTE_FONT_SIZE, noteContentWidth);
    const noteLineHeight = Math.ceil(NOTE_FONT_SIZE * NOTE_LINE_HEIGHT_RATIO);
    extraHeight += noteLines * noteLineHeight + 4; // +4 for margin-top
  }

  // 引用卡片高度估算：每张 ≈ 24px（图标 + 文字 + padding）+ 4px 间隔
  if (node.refs && node.refs.length > 0) {
    extraHeight += node.refs.length * 24 + 4; // +4 for margin-top
  }

  return totalHeight + extraHeight;
}

/**
 * 子树高度缓存
 *
 * 布局引擎在一次 calculate() 中对同一子树会重复调用 calculateSubtreeHeight
 * （父层分配 + 每层递归），无缓存时整体接近 O(n²)。
 * 文档树经 immer 冻结、结构共享：节点变更必然产生新对象身份，
 * 因此以「节点对象 + config 对象」双身份做缓存键是安全的——
 * config 变化（如 measuredNodeHeights 更新）时整体失效。
 * 注意：若在测试中原地 mutate 普通对象树并复用同一 config，需自行换新 config 引用。
 *
 * 深度间距收敛后子树高度随节点绝对层级变化，缓存值须记录计算时的
 * depth，仅在 depth 一致时命中（单次布局内每个节点层级唯一 → 仍 O(n)；
 * 子树被移动到不同深度时自然失效重算）。
 */
let subtreeHeightCacheConfig: LayoutConfig | null = null;
let subtreeHeightCache = new WeakMap<MindMapNode, { depth: number; height: number }>();

/** 计算子树高度（递归，带 WeakMap 缓存 → 单次布局 O(n)）
 * ★ P0 修复：添加深度限制参数
 *
 * @param depth 节点的绝对层级（根 = 0）。除递归防御外还决定深度间距收敛：
 *   本节点的直接子节点之间的兄弟距 = verticalGap × depthGapScale(config, depth)。
 *   收敛关闭时任意 depth 结果一致（scale 恒 1），保持旧行为。
 */
export function calculateSubtreeHeight(
  node: MindMapNode,
  config: LayoutConfig = DEFAULT_LAYOUT_CONFIG,
  isRoot: boolean = false,
  depth: number = 0
): number {
  // 深度限制检查
  if (depth > MAX_HELPER_DEPTH) {
    console.warn(`[helpers] calculateSubtreeHeight depth exceeds limit (${MAX_HELPER_DEPTH})`);
    return config.nodeHeight;
  }

  if (subtreeHeightCacheConfig !== config) {
    subtreeHeightCacheConfig = config;
    subtreeHeightCache = new WeakMap();
  }
  // 根节点高度受 isRoot 影响且每次布局只算一次，不进缓存
  if (!isRoot) {
    const cached = subtreeHeightCache.get(node);
    if (cached !== undefined && cached.depth === depth) return cached.height;
  }

  // ★ 2026-01-31 修复：使用实际节点高度而不是固定高度
  const nodeHeight = calculateNodeHeight(node, isRoot, config);

  let result: number;
  if (node.collapsed || !node.children || node.children.length === 0) {
    result = nodeHeight;
  } else {
    // 兄弟距随本节点层级收敛（根到一级 scale(0)=1 保持现值）
    const siblingGap = getDepthVerticalGap(config, depth);
    let totalHeight = 0;
    for (let i = 0; i < node.children.length; i++) {
      // 子节点不是根节点
      totalHeight += calculateSubtreeHeight(node.children[i], config, false, depth + 1);
      if (i < node.children.length - 1) {
        totalHeight += siblingGap;
      }
    }
    result = Math.max(nodeHeight, totalHeight);
  }

  if (!isRoot) {
    subtreeHeightCache.set(node, { depth, height: result });
  }
  return result;
}

/**
 * 子树尺寸缓存（与 subtreeHeightCache 同一套「节点对象 + config 对象」双身份键策略，
 * 依赖 immer 结构共享保证节点变更时对象身份变化 → WeakMap 天然失效）
 */
let subtreeSizeCacheConfig: LayoutConfig | null = null;
let subtreeSizeCache = new WeakMap<MindMapNode, SubtreeSize>();

/** 计算子树尺寸信息（递归，带 WeakMap 缓存 → 单次布局 O(n)）
 * ★ P0 修复：添加深度限制参数
 *
 * 注意：本函数是均匀间距下的包络估算（无生产调用方），
 * 不应用深度间距收敛（depthGapScaling）——收敛开启时估算值可能略偏大。
 */
export function calculateSubtreeSize(
  node: MindMapNode,
  config: LayoutConfig = DEFAULT_LAYOUT_CONFIG,
  isRoot: boolean = false,
  depth: number = 0
): SubtreeSize {
  // 深度限制检查
  if (depth > MAX_HELPER_DEPTH) {
    console.warn(`[helpers] calculateSubtreeSize depth exceeds limit (${MAX_HELPER_DEPTH})`);
    return {
      width: config.nodeMinWidth,
      height: config.nodeHeight,
      childHeights: [],
    };
  }

  if (subtreeSizeCacheConfig !== config) {
    subtreeSizeCacheConfig = config;
    subtreeSizeCache = new WeakMap();
  }
  // 根节点尺寸受 isRoot 影响且每次布局只算一次，不进缓存
  if (!isRoot) {
    const cached = subtreeSizeCache.get(node);
    if (cached !== undefined) return cached;
  }

  const nodeWidth = calculateNodeWidth(node, config, isRoot);
  // ★ 2026-01-31 修复：使用实际节点高度
  const nodeHeight = calculateNodeHeight(node, isRoot, config);

  if (node.collapsed || !node.children || node.children.length === 0) {
    const leafSize: SubtreeSize = {
      width: nodeWidth,
      height: nodeHeight,
      childHeights: [],
    };
    if (!isRoot) {
      subtreeSizeCache.set(node, leafSize);
    }
    return leafSize;
  }

  const childSizes = node.children.map(child => calculateSubtreeSize(child, config, false, depth + 1));
  const childHeights = childSizes.map(size => size.height);
  const maxChildWidth = Math.max(...childSizes.map(size => size.width));

  const totalChildHeight = childHeights.reduce((sum, h, i) =>
    sum + h + (i > 0 ? config.verticalGap : 0), 0
  );

  const result: SubtreeSize = {
    width: nodeWidth + config.horizontalGap + maxChildWidth,
    height: Math.max(nodeHeight, totalChildHeight),
    childHeights,
  };
  if (!isRoot) {
    subtreeSizeCache.set(node, result);
  }
  return result;
}

/** 计算布局边界 */
export function calculateBounds(
  nodes: Array<{ x: number; y: number; width?: number; height?: number }>
): { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number } {
  if (nodes.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const node of nodes) {
    const width = node.width || 100;
    const height = node.height || 36;

    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + width);
    maxY = Math.max(maxY, node.y + height);
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

interface LayoutNodeLike {
  id: string;
  position: { x: number; y: number };
  data?: { isRoot?: boolean };
}

interface SubtreeBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function getNodeBounds(
  node: MindMapNode,
  layoutNode: LayoutNodeLike | undefined,
  config: LayoutConfig,
  isRoot: boolean
): SubtreeBounds {
  // ★ P0 修复：宽度估算需传入 isRoot（根节点字号/内边距更大），
  //   否则重叠检测使用的包围盒与实际渲染宽度不一致
  const width = calculateNodeWidth(node, config, isRoot);
  const height = calculateNodeHeight(node, isRoot, config);
  const x = layoutNode?.position.x ?? 0;
  const y = layoutNode?.position.y ?? 0;
  return {
    minX: x,
    maxX: x + width,
    minY: y,
    maxY: y + height,
  };
}

function mergeBounds(a: SubtreeBounds, b: SubtreeBounds): SubtreeBounds {
  return {
    minX: Math.min(a.minX, b.minX),
    maxX: Math.max(a.maxX, b.maxX),
    minY: Math.min(a.minY, b.minY),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

function shiftBounds(bounds: SubtreeBounds, deltaX: number, deltaY: number): SubtreeBounds {
  return {
    minX: bounds.minX + deltaX,
    maxX: bounds.maxX + deltaX,
    minY: bounds.minY + deltaY,
    maxY: bounds.maxY + deltaY,
  };
}

/**
 * 移动子树（支持 X/Y 双轴平移）
 * ★ P0 修复：添加深度限制参数
 */
function shiftSubtree(
  node: MindMapNode,
  nodesById: Map<string, LayoutNodeLike>,
  deltaX: number,
  deltaY: number,
  depth: number = 0
): void {
  // 深度限制检查
  if (depth > MAX_HELPER_DEPTH) {
    console.warn(`[helpers] shiftSubtree depth exceeds limit (${MAX_HELPER_DEPTH})`);
    return;
  }

  const layoutNode = nodesById.get(node.id);
  if (layoutNode) {
    layoutNode.position.x += deltaX;
    layoutNode.position.y += deltaY;
  }
  if (node.collapsed || !node.children || node.children.length === 0) {
    return;
  }
  node.children.forEach(child => shiftSubtree(child, nodesById, deltaX, deltaY, depth + 1));
}

/**
 * 递归消除子树重叠（按实际节点高度）
 * 仅在同侧（X 范围重叠）时施加垂直分离
 * ★ P0 修复：添加深度限制参数
 * @param depth 节点绝对层级（引擎从根调用时为 0，递归层数 == 层级）；
 *   node 的直接子节点间实际分离间距 = siblingGap × depthGapScale(config, depth)，
 *   与初排的深度收敛间距一致（收敛关闭时 scale 恒 1，保持旧行为）
 * @param siblingGap 兄弟子树最小垂直间距基准值（缺省使用 config.verticalGap）
 */
export function resolveSubtreeOverlaps(
  node: MindMapNode,
  nodesById: Map<string, LayoutNodeLike>,
  config: LayoutConfig,
  isRoot: boolean = false,
  depth: number = 0,
  siblingGap: number = config.verticalGap
): SubtreeBounds {
  const layoutNode = nodesById.get(node.id);
  const nodeBounds = getNodeBounds(node, layoutNode, config, isRoot);

  // 深度限制检查
  if (depth > MAX_HELPER_DEPTH) {
    console.warn(`[helpers] resolveSubtreeOverlaps depth exceeds limit (${MAX_HELPER_DEPTH})`);
    return nodeBounds;
  }

  if (node.collapsed || !node.children || node.children.length === 0) {
    return nodeBounds;
  }

  const parentCenterX = (nodeBounds.minX + nodeBounds.maxX) / 2;
  const childrenWithBounds = node.children.map(child => ({
    node: child,
    bounds: resolveSubtreeOverlaps(child, nodesById, config, false, depth + 1, siblingGap),
  }));

  const leftChildren = childrenWithBounds.filter(({ bounds }) => bounds.maxX <= parentCenterX);
  const rightChildren = childrenWithBounds.filter(({ bounds }) => bounds.minX >= parentCenterX);
  const overlapChildren = childrenWithBounds.filter(
    ({ bounds }) => bounds.minX < parentCenterX && bounds.maxX > parentCenterX
  );

  // 本节点的子节点间分离间距随层级收敛（scale(0)=1 → 根级保持基准值）
  const gapAtDepth = siblingGap * depthGapScale(config, depth);
  const applySeparation = (items: Array<{ node: MindMapNode; bounds: SubtreeBounds }>) => {
    let prev: SubtreeBounds | null = null;
    items.forEach(item => {
      if (prev && item.bounds.minY < prev.maxY + gapAtDepth) {
        const delta = prev.maxY + gapAtDepth - item.bounds.minY;
        shiftSubtree(item.node, nodesById, 0, delta, depth + 1);
        item.bounds = shiftBounds(item.bounds, 0, delta);
      }
      prev = item.bounds;
    });
  };

  applySeparation(leftChildren);
  applySeparation(rightChildren);
  applySeparation(overlapChildren);

  return childrenWithBounds.reduce(
    (acc, current) => mergeBounds(acc, current.bounds),
    nodeBounds
  );
}

/**
 * 重叠消除后，将每个父节点重新居中于其子节点的实际垂直范围
 * ★ 2026-02 新增：确保分支点视觉居中
 */
export function recenterParents(
  node: MindMapNode,
  nodesById: Map<string, LayoutNodeLike>,
  config: LayoutConfig,
  isRoot: boolean = false,
  depth: number = 0
): void {
  if (depth > MAX_HELPER_DEPTH) return;
  if (node.collapsed || !node.children || node.children.length === 0) return;

  // 先递归处理子树（自底向上）
  node.children.forEach(child => recenterParents(child, nodesById, config, false, depth + 1));

  const parentNode = nodesById.get(node.id);
  if (!parentNode) return;

  // 收集所有直接子节点的布局位置
  const childLayoutNodes = node.children
    .map(c => nodesById.get(c.id))
    .filter((n): n is LayoutNodeLike => !!n);
  if (childLayoutNodes.length === 0) return;

  const parentHeight = calculateNodeHeight(node, isRoot, config);

  // 子节点的实际 Y 范围
  const firstChildY = childLayoutNodes[0].position.y;
  const lastChild = childLayoutNodes[childLayoutNodes.length - 1];
  const lastChildHeight = calculateNodeHeight(
    node.children[node.children.length - 1], false, config
  );
  const lastChildBottom = lastChild.position.y + lastChildHeight;

  // 将父节点居中于子节点范围
  const childrenMidY = (firstChildY + lastChildBottom) / 2;
  parentNode.position.y = childrenMidY - parentHeight / 2;
}

/**
 * 递归消除子树重叠（水平排列版本，垂直组织图使用）
 *
 * 兄弟子树沿 X 轴顺序排列，若相邻子树的水平包围盒间距不足 siblingGap
 * 则整体右移后者。与 resolveSubtreeOverlaps 的 Y 轴逻辑对称
 * （含相同的深度间距收敛：实际间距 = siblingGap × depthGapScale(config, depth)）。
 */
export function resolveSubtreeOverlapsX(
  node: MindMapNode,
  nodesById: Map<string, LayoutNodeLike>,
  config: LayoutConfig,
  siblingGap: number,
  isRoot: boolean = false,
  depth: number = 0
): SubtreeBounds {
  const layoutNode = nodesById.get(node.id);
  const nodeBounds = getNodeBounds(node, layoutNode, config, isRoot);

  if (depth > MAX_HELPER_DEPTH) {
    console.warn(`[helpers] resolveSubtreeOverlapsX depth exceeds limit (${MAX_HELPER_DEPTH})`);
    return nodeBounds;
  }

  if (node.collapsed || !node.children || node.children.length === 0) {
    return nodeBounds;
  }

  const childrenWithBounds = node.children.map(child => ({
    node: child,
    bounds: resolveSubtreeOverlapsX(child, nodesById, config, siblingGap, false, depth + 1),
  }));

  // 组织图兄弟按文档顺序从左到右排列，直接按序分离（间距随层级收敛）
  const gapAtDepth = siblingGap * depthGapScale(config, depth);
  let prev: SubtreeBounds | null = null;
  childrenWithBounds.forEach(item => {
    if (prev && item.bounds.minX < prev.maxX + gapAtDepth) {
      const delta = prev.maxX + gapAtDepth - item.bounds.minX;
      shiftSubtree(item.node, nodesById, delta, 0, depth + 1);
      item.bounds = shiftBounds(item.bounds, delta, 0);
    }
    prev = item.bounds;
  });

  return childrenWithBounds.reduce(
    (acc, current) => mergeBounds(acc, current.bounds),
    nodeBounds
  );
}

/**
 * 将每个父节点重新水平居中于其子节点的实际 X 范围（垂直组织图使用）
 * 与 recenterParents 的 Y 轴逻辑对称。
 */
export function recenterParentsX(
  node: MindMapNode,
  nodesById: Map<string, LayoutNodeLike>,
  config: LayoutConfig,
  isRoot: boolean = false,
  depth: number = 0
): void {
  if (depth > MAX_HELPER_DEPTH) return;
  if (node.collapsed || !node.children || node.children.length === 0) return;

  // 先递归处理子树（自底向上）
  node.children.forEach(child => recenterParentsX(child, nodesById, config, false, depth + 1));

  const parentNode = nodesById.get(node.id);
  if (!parentNode) return;

  const childLayoutNodes = node.children
    .map(c => nodesById.get(c.id))
    .filter((n): n is LayoutNodeLike => !!n);
  if (childLayoutNodes.length === 0) return;

  const parentWidth = calculateNodeWidth(node, config, isRoot);

  // 子节点的实际 X 范围（首子左边缘 → 末子右边缘）
  const firstChildX = childLayoutNodes[0].position.x;
  const lastChild = childLayoutNodes[childLayoutNodes.length - 1];
  const lastChildWidth = calculateNodeWidth(
    node.children[node.children.length - 1], config, false
  );
  const lastChildRight = lastChild.position.x + lastChildWidth;

  // 将父节点水平居中于子节点范围
  const childrenMidX = (firstChildX + lastChildRight) / 2;
  parentNode.position.x = childrenMidX - parentWidth / 2;
}
