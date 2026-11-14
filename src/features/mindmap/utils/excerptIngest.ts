/**
 * 摘录入图与汇聚中枢（MarginNote 5 式学习流，W08 + C7 §3）纯逻辑：
 * - 摘录载荷 → 节点标题 / 引文 / 区域截图 / 复合摘录槽（distillExcerpt, buildExcerptSlotFromPayload）
 * - 待整理池（Staging Tray）条目构造、转换与跨组件原子拖拽标记
 * - 双热区投放判定：节点中部 60% 合并进当前卡片，外侧边缘新建子卡片（computeNodeDropZone）
 * - 放置位置解析：合并 / 子节点 / 新分支，含深度上限回退（resolveExcerptPlacement）
 * - 划选即入图的确定性落点：选中节点 → 上次摘录上下文 → 专注根 / 根（resolveAutoExcerptParent）
 * - 画布空白处投放的分支插入序号（computeBranchInsertIndex）
 * - 视口安全边距判定：已在可视区内则不移动镜头（isScreenRectWithinViewportInset）
 * - 拖拽进入/离开的深度计数，避免子元素抖动（createExcerptDragDepthTracker）
 * - 分支矿物语义色解析与反向广播（resolveNodeBranchColors + vfs_anchor_edges 元数据同步）
 *
 * 本模块不依赖 React 与插件内核实例，内核能力经 registerMindMapAnchorEdgeSink 注入。
 */

import { nanoid } from 'nanoid';
import {
  fnv1a64Hex,
  sanitizeExcerptDragPayload,
  type AnchorEdgeUpsertInput,
  type ExcerptDragPayload,
  type MindmapSemanticAnchor,
} from '@/ui-kernel/contracts/interop';
import { StyleRegistry } from '../registry';
import {
  COLORFUL_DARK_PALETTE,
  COLORFUL_LIGHT_PALETTE,
  DARK_SAFE_PALETTE,
  DEFAULT_LIGHT_PALETTE,
  MINIMAL_DARK_PALETTE,
  MINIMAL_LIGHT_PALETTE,
  PAPER_DARK_PALETTE,
  PAPER_LIGHT_PALETTE,
} from '../styles/themes/palettes';
import type {
  MindMapExcerptSlot,
  MindMapExcerptSlotKind,
  MindMapImage,
  MindMapNode,
  MindMapStagingExcerpt,
} from '../types';
import { isSafeImageSrc } from './imageSanitize';
import {
  dedupeSemanticAnchors,
  formatMindMapSourcePill,
  safeSerializeAnchor,
} from './nodeAnchors';

/** 节点标题最大码点数（超出截断并补省略号） */
export const EXCERPT_TITLE_MAX_CODE_POINTS = 72;
/** 摘录原文最大字符数 */
export const EXCERPT_QUOTE_MAX_CHARS = 2000;
/** 区域截图缩略图默认显示宽度 */
export const EXCERPT_REGION_IMAGE_WIDTH = 220;
/** 视口安全边距（占可视区宽高比例）：新节点落在此内缩矩形内则镜头不动 */
export const EXCERPT_VIEWPORT_INSET_RATIO = 0.12;
/** 同一摘录重复到达的去重窗口（双击 / mouseup 抖动） */
export const AUTO_EXCERPT_DEDUPE_WINDOW_MS = 400;

// ============================================================================
// 文本提炼与复合摘录槽
// ============================================================================

export interface DistilledExcerpt {
  text: string;
  excerptQuote?: string;
  imageAssetId?: string;
  image?: MindMapImage;
}

const SENTENCE_END_RE = /[。！？!?；;]|\.(?=\s|$)/u;

function truncateCodePoints(value: string, max: number): string {
  const cps = Array.from(value);
  if (cps.length <= max) return value;
  return `${cps.slice(0, max - 1).join('').trimEnd()}\u2026`;
}

function collapseInlineWhitespace(value: string): string {
  return value.replace(/[ \t\f\v\u00a0\u3000]+/g, ' ').trim();
}

/** 规范化摘录正文：统一换行、去首尾空白、行内空白压缩、去掉空行 */
export function normalizeExcerptText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(collapseInlineWhitespace)
    .filter((line) => line.length > 0)
    .join('\n');
}

/** 首句（或首行）作为节点标题，超过 72 码点截断并补省略号 */
export function distillExcerptTitle(normalized: string): string {
  const firstLine = normalized.split('\n')[0] ?? '';
  const match = SENTENCE_END_RE.exec(firstLine);
  const sentence = match ? firstLine.slice(0, match.index + match[0].length).trim() : firstLine;
  return truncateCodePoints(sentence || firstLine, EXCERPT_TITLE_MAX_CODE_POINTS);
}

export function buildExcerptImageAssetId(
  payload: Pick<ExcerptDragPayload, 'imageDataUrl' | 'anchorUri'>,
): string {
  return `img_${fnv1a64Hex(payload.imageDataUrl ?? payload.anchorUri)}`;
}

/**
 * 摘录载荷 → 节点字段。
 * - region-image：标题优先用短说明文字，否则「来源标题 (P.12)」；附 imageAssetId，
 *   内联 data:image 截图（通过导图图片白名单与体积预算时）作为缩略图。
 * - text / transcript-cue：首句作标题；完整原文与标题不同时存入 excerptQuote。
 */
export function distillExcerpt(
  payload: ExcerptDragPayload,
  options: { regionDefaultTitle: string },
): DistilledExcerpt {
  const normalized = normalizeExcerptText(payload.text ?? '');
  const pill = formatMindMapSourcePill(payload.anchor);
  const fallbackTitle = `${payload.sourceTitle ?? payload.anchor.label ?? options.regionDefaultTitle} (${pill})`;

  if (payload.excerptKind === 'region-image') {
    const caption = normalized.replace(/\n/g, ' ');
    const text =
      caption && Array.from(caption).length <= EXCERPT_TITLE_MAX_CODE_POINTS
        ? caption
        : `${payload.sourceTitle ?? options.regionDefaultTitle} (${pill})`;
    const imageAssetId = buildExcerptImageAssetId(payload);
    const result: DistilledExcerpt = { text, imageAssetId };
    if (caption && caption !== text) {
      result.excerptQuote = normalized.slice(0, EXCERPT_QUOTE_MAX_CHARS);
    }
    const src = payload.imageDataUrl;
    if (src && src.startsWith('data:image/') && isSafeImageSrc(src)) {
      result.image = { id: imageAssetId, src, width: EXCERPT_REGION_IMAGE_WIDTH };
    }
    return result;
  }

  if (!normalized) {
    return { text: fallbackTitle };
  }
  const text = distillExcerptTitle(normalized);
  const result: DistilledExcerpt = { text };
  if (text !== normalized) {
    result.excerptQuote = normalized.slice(0, EXCERPT_QUOTE_MAX_CHARS);
  }
  return result;
}

function resolveSlotKindFromPayload(payload: ExcerptDragPayload): MindMapExcerptSlotKind {
  if (payload.anchor.kind === 'qbank') return 'qbank';
  if (payload.anchor.kind === 'media' || payload.excerptKind === 'transcript-cue') return 'media';
  if (payload.excerptKind === 'region-image' || payload.imageDataUrl) return 'image';
  return 'text';
}

/** 从标准化摘录载荷构造复合卡片摘录槽 */
export function buildExcerptSlotFromPayload(
  payload: ExcerptDragPayload,
  distilled?: DistilledExcerpt,
): MindMapExcerptSlot {
  const normalizedText = normalizeExcerptText(payload.text ?? '').slice(0, EXCERPT_QUOTE_MAX_CHARS);
  const kind = resolveSlotKindFromPayload(payload);
  const rawImage = payload.imageDataUrl?.trim();
  const safeImage =
    rawImage && (rawImage.startsWith('vfs://') || isSafeImageSrc(rawImage))
      ? rawImage
      : undefined;
  const imageAssetId =
    distilled?.imageAssetId ??
    (safeImage ? buildExcerptImageAssetId(payload) : undefined);

  const id = `slot_${fnv1a64Hex(`${payload.anchorUri}:${normalizedText}:${imageAssetId ?? ''}`)}`;
  return {
    id,
    kind,
    ...(normalizedText ? { text: normalizedText } : {}),
    ...(safeImage ? { imageDataUrl: safeImage } : {}),
    ...(imageAssetId ? { imageAssetId } : {}),
    ...(payload.anchor.kind === 'media' ? { startMs: payload.anchor.startMs } : {}),
    ...(payload.anchor.kind === 'media' && payload.anchor.endMs !== undefined
      ? { endMs: payload.anchor.endMs }
      : {}),
    ...(payload.anchor.kind === 'qbank' && payload.anchor.questionId
      ? { questionId: payload.anchor.questionId }
      : {}),
    anchor: payload.anchor,
    ...(payload.sourceTitle ? { sourceTitle: payload.sourceTitle } : {}),
    createdAt: payload.createdAt,
  };
}

/** 去重追加复合摘录槽 */
export function appendExcerptSlot(
  existing: readonly MindMapExcerptSlot[] | undefined,
  slot: MindMapExcerptSlot,
): MindMapExcerptSlot[] {
  const list = existing ? [...existing] : [];
  const incomingAnchorUri = safeSerializeAnchor(slot.anchor) ?? '';
  const isDup = list.some((item) => {
    if (item.id === slot.id) return true;
    const uri = safeSerializeAnchor(item.anchor) ?? '';
    return (
      uri === incomingAnchorUri &&
      (item.text ?? '') === (slot.text ?? '') &&
      (item.imageAssetId ?? item.imageDataUrl ?? '') ===
        (slot.imageAssetId ?? slot.imageDataUrl ?? '')
    );
  });
  if (!isDup) {
    list.push(slot);
  }
  return list;
}

/** 合并模式：把新摘录原文追加到已有 excerptQuote（空行分隔，总长受限） */
export function appendExcerptQuote(existing: string | undefined, incoming: string): string | undefined {
  const next = incoming.trim();
  if (!next) return existing;
  if (!existing?.trim()) return next.slice(0, EXCERPT_QUOTE_MAX_CHARS * 2);
  if (existing.includes(next)) return existing;
  return `${existing}\n\n${next}`.slice(0, EXCERPT_QUOTE_MAX_CHARS * 2);
}

/** 按 id 去重追加区域截图 */
export function appendExcerptImage(
  existing: MindMapImage[] | undefined,
  image: MindMapImage | undefined,
): MindMapImage[] | undefined {
  if (!image) return existing;
  if (existing?.some((item) => (image.id && item.id === image.id) || item.src === image.src)) {
    return existing;
  }
  return [...(existing ?? []), image];
}

// ============================================================================
// 待整理池（Staging Tray）转换与拖拽桥接
// ============================================================================

let activeStagingDragId: string | null = null;

export function setActiveStagingExcerptDragId(stagingId: string | null): void {
  activeStagingDragId = stagingId;
}

export function getActiveStagingExcerptDragId(): string | null {
  return activeStagingDragId;
}

export function consumeActiveStagingExcerptDragId(): string | null {
  const current = activeStagingDragId;
  activeStagingDragId = null;
  return current;
}

export function buildStagingExcerptFromPayload(
  payload: ExcerptDragPayload,
  options: { regionDefaultTitle: string; id?: string },
): MindMapStagingExcerpt {
  const distilled = distillExcerpt(payload, { regionDefaultTitle: options.regionDefaultTitle });
  const rawImage = payload.imageDataUrl?.trim();
  const safeImage =
    rawImage && (rawImage.startsWith('vfs://') || isSafeImageSrc(rawImage))
      ? rawImage
      : undefined;
  return {
    id: options.id ?? `stg_${nanoid(10)}`,
    excerptKind: payload.excerptKind,
    text: payload.text,
    title: distilled.text,
    ...(distilled.excerptQuote ? { excerptQuote: distilled.excerptQuote } : {}),
    ...(safeImage ? { imageDataUrl: safeImage } : {}),
    ...(distilled.imageAssetId ? { imageAssetId: distilled.imageAssetId } : {}),
    anchor: payload.anchor,
    anchorUri: payload.anchorUri,
    ...(payload.sourceTitle ? { sourceTitle: payload.sourceTitle } : {}),
    createdAt: payload.createdAt,
  };
}

export function stagingExcerptToDragPayload(
  item: MindMapStagingExcerpt,
): ExcerptDragPayload | null {
  return sanitizeExcerptDragPayload({
    excerptKind: item.excerptKind,
    text: item.text,
    imageDataUrl: item.imageDataUrl,
    anchor: item.anchor,
    sourceTitle: item.sourceTitle,
    createdAt: item.createdAt,
  });
}

// ============================================================================
// 双热区投放（C7 §3.2）：节点中心 60% 合并进当前卡片 | 外侧边缘新建子卡片
// ============================================================================

export type NodeExcerptDropZone = 'merge' | 'child';

export interface NodeDropBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 计算摘录悬停在已有节点上时的双热区落点：
 * - 按住 Alt 键强制为 `'merge'`（兼容键盘直达习惯）；
 * - 指针落在节点中部 60% 主体区（横向 `[0.20, 0.80]` 且纵向 `[0.12, 0.88]`）为 `'merge'`（「合并入当前卡片」）；
 * - 指针落在节点外侧边缘 / 右侧区（横向 `< 0.20` 或 `> 0.80`，或上下外沿）为 `'child'`（「新建子卡片」）；
 * - 带 `±0.025` 迟滞带（hysteresis），消除热区边界微颤。
 */
export function computeNodeDropZone(
  rect: NodeDropBox,
  pointer: { clientX: number; clientY: number },
  options?: {
    altKey?: boolean;
    prevZone?: NodeExcerptDropZone | null;
  },
): NodeExcerptDropZone {
  if (options?.altKey) return 'merge';
  if (
    rect.width <= 1 ||
    rect.height <= 1 ||
    !Number.isFinite(pointer.clientX) ||
    !Number.isFinite(pointer.clientY)
  ) {
    return 'child';
  }
  const relX = (pointer.clientX - rect.left) / rect.width;
  const relY = (pointer.clientY - rect.top) / rect.height;

  const hysteresis =
    options?.prevZone === 'merge' ? -0.025 : options?.prevZone === 'child' ? 0.025 : 0;
  const minX = 0.2 + hysteresis;
  const maxX = 0.8 - hysteresis;
  const minY = 0.12 + hysteresis;
  const maxY = 0.88 - hysteresis;

  if (relX >= minX && relX <= maxX && relY >= minY && relY <= maxY) {
    return 'merge';
  }
  return 'child';
}

// ============================================================================
// 放置位置
// ============================================================================

export interface IngestExcerptOptions {
  /**
   * 'child'  = 在 targetNodeId 下新建子节点；
   * 'merge'  = 把出处与原文合并进 targetNodeId；
   * 'branch' = 在 viewRootId ?? root 下按 insertIndex 新建一级分支。
   */
  mode: 'child' | 'merge' | 'branch';
  targetNodeId?: string;
  insertIndex?: number;
}

export type ExcerptPlacement =
  | { kind: 'merge'; nodeId: string }
  | { kind: 'insert'; parentId: string; index: number };

interface TreeLookup {
  node: MindMapNode;
  parent: MindMapNode | null;
  depth: number;
}

function lookupNode(root: MindMapNode, nodeId: string | null | undefined): TreeLookup | null {
  if (!nodeId) return null;
  const stack: TreeLookup[] = [{ node: root, parent: null, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.node.id === nodeId) return current;
    for (const child of current.node.children ?? []) {
      stack.push({ node: child, parent: current.node, depth: current.depth + 1 });
    }
  }
  return null;
}

export function nodeExistsInTree(root: MindMapNode, nodeId: string | null | undefined): boolean {
  return lookupNode(root, nodeId) !== null;
}

/**
 * 解析摘录落点。
 * - merge：目标存在即合并；
 * - child：目标为空白叶子（非根）时改为合并；目标已在深度上限则回退为其后的同级；
 * - branch：父为专注根（有效时）或根，序号钳制到 [0, children.length]。
 */
export function resolveExcerptPlacement(
  root: MindMapNode,
  options: IngestExcerptOptions,
  context: { viewRootId: string | null; maxDepth: number },
): ExcerptPlacement | null {
  if (options.mode === 'branch') {
    const scope = lookupNode(root, context.viewRootId)?.node ?? root;
    const count = scope.children.length;
    const requested = options.insertIndex ?? count;
    const index = Math.max(0, Math.min(count, Math.floor(Number.isFinite(requested) ? requested : count)));
    return { kind: 'insert', parentId: scope.id, index };
  }

  const fallbackId = lookupNode(root, context.viewRootId)?.node.id ?? root.id;
  // Explicit drops must not silently merge into root after the hovered node was deleted.
  if (options.targetNodeId && !lookupNode(root, options.targetNodeId)) return null;
  const target = lookupNode(root, options.targetNodeId) ?? lookupNode(root, fallbackId);
  if (!target) return null;

  if (options.mode === 'merge') {
    return { kind: 'merge', nodeId: target.node.id };
  }

  const isBlankLeaf =
    target.parent !== null && target.node.text.trim() === '' && target.node.children.length === 0;
  if (isBlankLeaf) {
    return { kind: 'merge', nodeId: target.node.id };
  }

  if (target.depth >= context.maxDepth - 1) {
    if (!target.parent) return null;
    const siblingIndex = target.parent.children.findIndex((child) => child.id === target.node.id);
    return { kind: 'insert', parentId: target.parent.id, index: siblingIndex + 1 };
  }
  return { kind: 'insert', parentId: target.node.id, index: target.node.children.length };
}

// ============================================================================
// 划选即入图：确定性落点与待整理池分流
// ============================================================================

export interface ExcerptInsertContext {
  /** 上次摘录插入时的父节点 */
  parentId: string;
  /** 上次摘录新建的节点 */
  createdId: string;
}

/** 当前是否存在明确的自动入图落点（选中节点 / 上次上下文 / 分支专注根） */
export function hasExplicitAutoExcerptTarget(
  root: MindMapNode,
  state: {
    focusedNodeId: string | null;
    selection: readonly string[];
    viewRootId: string | null;
    lastExcerptContext: ExcerptInsertContext | null;
  },
): boolean {
  if (state.focusedNodeId && nodeExistsInTree(root, state.focusedNodeId)) return true;
  const lastSel = state.selection[state.selection.length - 1];
  if (lastSel && nodeExistsInTree(root, lastSel)) return true;
  if (state.lastExcerptContext && nodeExistsInTree(root, state.lastExcerptContext.parentId)) {
    return true;
  }
  if (state.viewRootId && nodeExistsInTree(root, state.viewRootId)) return true;
  return false;
}

/**
 * 落点优先级：
 * 1. 当前选中节点（仍在树中）。若它正是上次摘录刚建的节点（用户没有换选），
 *    继续落到上次的父节点下作为同级，避免连续划选把摘录串成一条深链；
 * 2. 上次摘录的父节点（仍在树中）；
 * 3. 专注根（有效时）；
 * 4. 根节点——绝不丢弃摘录。
 */
export function resolveAutoExcerptParent(
  root: MindMapNode,
  state: {
    focusedNodeId: string | null;
    selection: readonly string[];
    viewRootId: string | null;
    lastExcerptContext: ExcerptInsertContext | null;
  },
): string {
  const last = state.lastExcerptContext;
  const lastParentValid = last ? nodeExistsInTree(root, last.parentId) : false;
  const candidates = [state.focusedNodeId, state.selection[state.selection.length - 1]];
  for (const candidate of candidates) {
    if (!candidate || !nodeExistsInTree(root, candidate)) continue;
    if (last && lastParentValid && candidate === last.createdId) return last.parentId;
    return candidate;
  }
  if (last && lastParentValid) return last.parentId;
  if (state.viewRootId && nodeExistsInTree(root, state.viewRootId)) return state.viewRootId;
  return root.id;
}

/** 同一摘录（anchorUri + 正文）短时间内重复到达时返回 true */
export function createAutoExcerptDeduper(windowMs = AUTO_EXCERPT_DEDUPE_WINDOW_MS) {
  let lastKey: string | null = null;
  let lastAt = -Infinity;
  return (payload: Pick<ExcerptDragPayload, 'anchorUri' | 'text'>, now = Date.now()): boolean => {
    const key = `${payload.anchorUri}\u0000${payload.text.trim()}`;
    const duplicate = key === lastKey && now - lastAt < windowMs;
    lastKey = key;
    lastAt = now;
    return duplicate;
  };
}

// ============================================================================
// 画布投放几何
// ============================================================================

export interface BranchSlotGeometry {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 空白处投放：按指针在分支轴上的位置计算插入序号。
 * axis 'y'：左右展开布局（兄弟上下排列）；'x'：上下展开布局（兄弟左右排列）。
 */
export function computeBranchInsertIndex(
  pointer: { x: number; y: number },
  children: readonly BranchSlotGeometry[],
  axis: 'x' | 'y' = 'y',
): number {
  let index = 0;
  for (const child of children) {
    const center = axis === 'y' ? child.y + child.height / 2 : child.x + child.width / 2;
    const value = axis === 'y' ? pointer.y : pointer.x;
    if (center < value) index += 1;
  }
  return index;
}

export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 节点屏幕矩形是否完整落在视口内缩 insetRatio 的安全区内（落在内则镜头不动） */
export function isScreenRectWithinViewportInset(
  rect: ScreenRect,
  viewport: ScreenRect,
  insetRatio = EXCERPT_VIEWPORT_INSET_RATIO,
): boolean {
  const insetX = (viewport.right - viewport.left) * insetRatio;
  const insetY = (viewport.bottom - viewport.top) * insetRatio;
  return (
    rect.left >= viewport.left + insetX &&
    rect.right <= viewport.right - insetX &&
    rect.top >= viewport.top + insetY &&
    rect.bottom <= viewport.bottom - insetY
  );
}

/**
 * dragenter / dragleave 深度计数：在节点文字、胶囊等子元素间移动会成对触发
 * enter/leave，只有深度回到 0 才算真正离开容器。
 */
export function createExcerptDragDepthTracker() {
  let depth = 0;
  return {
    enter(): number {
      depth += 1;
      return depth;
    },
    /** 返回 true 表示已真正离开容器 */
    leave(): boolean {
      depth = Math.max(0, depth - 1);
      return depth === 0;
    },
    reset(): void {
      depth = 0;
    },
    get depth(): number {
      return depth;
    },
  };
}

// ============================================================================
// 分支语义色解析与出处反向链接边（vfs_anchor_edges）
// ============================================================================

const BUILTIN_STYLE_PALETTES: Readonly<Record<string, readonly string[]>> = {
  default: DEFAULT_LIGHT_PALETTE,
  cardLight: DEFAULT_LIGHT_PALETTE,
  dark: DARK_SAFE_PALETTE,
  defaultDark: DARK_SAFE_PALETTE,
  'default-dark': DARK_SAFE_PALETTE,
  cardDark: DARK_SAFE_PALETTE,
  minimal: MINIMAL_LIGHT_PALETTE,
  minimalDark: MINIMAL_DARK_PALETTE,
  'minimal-dark': MINIMAL_DARK_PALETTE,
  colorful: COLORFUL_LIGHT_PALETTE,
  colorfulDark: COLORFUL_DARK_PALETTE,
  'colorful-dark': COLORFUL_DARK_PALETTE,
  paper: PAPER_LIGHT_PALETTE,
  paperDark: PAPER_DARK_PALETTE,
  'paper-dark': PAPER_DARK_PALETTE,
};

export function resolveStyleBranchPalette(styleId = 'default'): readonly string[] {
  const registered = (StyleRegistry.get(styleId) || StyleRegistry.getDefault())?.palette;
  if (registered && registered.length > 0) return registered;
  return BUILTIN_STYLE_PALETTES[styleId] ?? DEFAULT_LIGHT_PALETTE;
}

/**
 * 解析整棵树每个节点的语义分支色（`branchColor`）：
 * - 节点自身显式设置 `style.bgColor` 时最优先；
 * - 一级分支（`root.children[index]`）默认取当前主题矿物色板 `palette[index % palette.length]`，整支后代继承；
 * - 根节点缺省使用青瓷松绿主色（色板第 4 色 `#2A6F5E` / 暗色 `#5EA893`）。
 */
export function resolveNodeBranchColors(
  root: MindMapNode,
  styleId = 'default',
): Map<string, string> {
  const palette = resolveStyleBranchPalette(styleId);
  const defaultRootColor = palette[3] ?? palette[0] ?? '#2A6F5E';
  const map = new Map<string, string>();

  const rootColor = root.style?.bgColor?.trim() || root.branchColor?.trim() || defaultRootColor;
  map.set(root.id, rootColor);

  const topBranches = root.children ?? [];
  for (let i = 0; i < topBranches.length; i += 1) {
    const branch = topBranches[i];
    const paletteColor = palette[i % palette.length] ?? defaultRootColor;
    const walk = (node: MindMapNode, inherited: string) => {
      const resolved = node.style?.bgColor?.trim() || node.branchColor?.trim() || inherited;
      map.set(node.id, resolved);
      for (const child of node.children ?? []) {
        walk(child, resolved);
      }
    };
    walk(branch, paletteColor);
  }
  return map;
}

export function resolveSingleNodeBranchColor(
  root: MindMapNode,
  nodeId: string,
  styleId = 'default',
): string | undefined {
  return resolveNodeBranchColors(root, styleId).get(nodeId);
}

export interface MindMapSourceAnchorWithBranchColor extends MindmapSemanticAnchor {
  branchColor?: string;
}

export interface MindMapAnchorEdgeUpsertInput extends AnchorEdgeUpsertInput {
  sourceAnchor: MindMapSourceAnchorWithBranchColor;
  branchColor?: string;
  metadata?: {
    branchColor?: string;
  };
}

export function buildMindMapAnchorEdgeId(mindmapId: string, nodeId: string, targetUri: string): string {
  return `edge_${fnv1a64Hex(`mindmap:${mindmapId}:${nodeId}:${targetUri}`)}`;
}

function collectNodeTargetAnchors(node: MindMapNode) {
  const slotAnchors = (node.excerpts ?? []).map((slot) => slot.anchor);
  return dedupeSemanticAnchors(node.anchors, slotAnchors);
}

function nodeEdgeInputs(
  mindmapId: string,
  node: MindMapNode,
  branchColor: string | undefined,
  studySpaceId: string | null | undefined,
  out: MindMapAnchorEdgeUpsertInput[],
): void {
  const targetAnchors = collectNodeTargetAnchors(node);
  if (targetAnchors.length === 0) return;
  const label = (node.text ?? '').slice(0, 120);
  const resolvedColor = branchColor || node.style?.bgColor?.trim() || node.branchColor?.trim();

  for (const targetAnchor of targetAnchors) {
    const uri = safeSerializeAnchor(targetAnchor);
    if (!uri) continue;
    out.push({
      edgeId: buildMindMapAnchorEdgeId(mindmapId, node.id, uri),
      sourceKind: 'mindmap',
      sourceResourceId: mindmapId,
      sourceSubId: node.id,
      sourceAnchor: {
        kind: 'mindmap',
        resourceId: mindmapId,
        nodeId: node.id,
        ...(label.trim() ? { label } : {}),
        ...(resolvedColor ? { branchColor: resolvedColor } : {}),
      },
      sourceLabel: label,
      targetAnchor,
      ...(resolvedColor ? { branchColor: resolvedColor, metadata: { branchColor: resolvedColor } } : {}),
      ...(studySpaceId ? { studySpaceId } : {}),
    });
  }
}

/** 收集整棵树的出处边（确定性 edgeId + 分支矿物语义色元数据） */
export function collectMindMapAnchorEdgeInputs(
  mindmapId: string,
  root: MindMapNode,
  studySpaceId?: string | null,
  styleId = 'default',
): MindMapAnchorEdgeUpsertInput[] {
  const out: MindMapAnchorEdgeUpsertInput[] = [];
  const colorMap = resolveNodeBranchColors(root, styleId);
  const stack: MindMapNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    nodeEdgeInputs(mindmapId, node, colorMap.get(node.id), studySpaceId, out);
    const children = node.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return out;
}

export function collectNodeAnchorEdgeInputs(
  mindmapId: string,
  node: MindMapNode,
  studySpaceId?: string | null,
  branchColor?: string,
): MindMapAnchorEdgeUpsertInput[] {
  const out: MindMapAnchorEdgeUpsertInput[] = [];
  nodeEdgeInputs(mindmapId, node, branchColor, studySpaceId, out);
  return out;
}

/** 内核 anchors 服务中导图同步所需的最小能力 */
export interface MindMapAnchorEdgeSink {
  upsertAnchorEdges(edges: readonly AnchorEdgeUpsertInput[]): Promise<unknown>;
  pruneAnchorEdgesBySource(params: {
    sourceKind: string;
    sourceResourceId: string;
    keepEdgeIds?: readonly string[];
  }): Promise<unknown>;
}

const anchorEdgeSinks: MindMapAnchorEdgeSink[] = [];
const lastSyncedSignature = new Map<string, string>();

/** 宿主（MindMapContentView）挂载时注入内核 anchors；最近注册者生效 */
export function registerMindMapAnchorEdgeSink(sink: MindMapAnchorEdgeSink): () => void {
  anchorEdgeSinks.push(sink);
  lastSyncedSignature.clear();
  return () => {
    const index = anchorEdgeSinks.lastIndexOf(sink);
    if (index >= 0) anchorEdgeSinks.splice(index, 1);
    lastSyncedSignature.clear();
  };
}

function activeSink(): MindMapAnchorEdgeSink | null {
  return anchorEdgeSinks[anchorEdgeSinks.length - 1] ?? null;
}

const ACTIVE_STUDY_SPACE_STORAGE_KEY = 'ds.studySpace.activeId.v1';

function readActiveStudySpaceId(): string | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  try {
    const raw = localStorage.getItem(ACTIVE_STUDY_SPACE_STORAGE_KEY);
    if (!raw) return undefined;
    let value = raw.trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = JSON.parse(value) as string;
    }
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed || trimmed === '__inbox__' || trimmed === '__all__' || trimmed === 'null') {
      return undefined;
    }
    return trimmed;
  } catch {
    return undefined;
  }
}

function swallow(promise: Promise<unknown> | unknown, context: string): void {
  if (promise && typeof (promise as Promise<unknown>).catch === 'function') {
    (promise as Promise<unknown>).catch((error: unknown) => {
      console.warn(`[MindMapAnchorEdges::${context}] sync failed`, error);
    });
  }
}

/** 即时上报单个节点的出处边（摘录入图 / 追加锚点后，阅读器页边徽标与底色 <16ms 更新） */
export function upsertNodeAnchorEdges(
  mindmapId: string | null,
  node: MindMapNode | null | undefined,
  options?: {
    studySpaceId?: string | null;
    root?: MindMapNode | null;
    styleId?: string;
    branchColor?: string;
  },
): void {
  const sink = activeSink();
  if (!sink || !mindmapId || !node) return;
  try {
    const resolvedSpaceId =
      options?.studySpaceId === undefined ? readActiveStudySpaceId() : options.studySpaceId;
    const resolvedColor =
      options?.branchColor ??
      (options?.root
        ? resolveSingleNodeBranchColor(options.root, node.id, options.styleId ?? 'default')
        : undefined);
    const edges = collectNodeAnchorEdgeInputs(mindmapId, node, resolvedSpaceId, resolvedColor);
    if (edges.length === 0) return;
    swallow(sink.upsertAnchorEdges(edges), 'upsertNode');
    lastSyncedSignature.delete(mindmapId);
  } catch (error) {
    console.warn('[MindMapAnchorEdges::upsertNode] sync failed', error);
  }
}

/**
 * 保存成功、删除节点或切换分支色后全量对账：upsert 当前全部边并按来源剪除已不存在的边。
 * 与上次对账结果（含 branchColor）相同时跳过（避免每次保存都走 IPC）。永不抛错。
 */
export function syncMindMapAnchorEdges(
  mindmapId: string | null,
  root: MindMapNode | null | undefined,
  options?: { force?: boolean; studySpaceId?: string | null; styleId?: string },
): void {
  const sink = activeSink();
  if (!sink || !mindmapId || !root) return;
  try {
    const resolvedSpaceId =
      options?.studySpaceId === undefined ? readActiveStudySpaceId() : options.studySpaceId;
    const edges = collectMindMapAnchorEdgeInputs(
      mindmapId,
      root,
      resolvedSpaceId,
      options?.styleId ?? 'default',
    );
    const keepEdgeIds = edges.map((edge) => edge.edgeId!);
    const signature = edges
      .map(
        (edge) =>
          `${edge.edgeId}|${edge.sourceLabel ?? ''}|${edge.branchColor ?? ''}|${edge.studySpaceId ?? ''}`,
      )
      .sort()
      .join(',');
    if (!options?.force && lastSyncedSignature.get(mindmapId) === signature) return;
    lastSyncedSignature.set(mindmapId, signature);
    const onFailure = (error: unknown) => {
      if (lastSyncedSignature.get(mindmapId) === signature) lastSyncedSignature.delete(mindmapId);
      console.warn('[MindMapAnchorEdges::sync] sync failed', error);
    };
    if (edges.length > 0) swallow(sink.upsertAnchorEdges(edges).catch(onFailure), 'upsert');
    swallow(
      sink.pruneAnchorEdgesBySource({
        sourceKind: 'mindmap',
        sourceResourceId: mindmapId,
        keepEdgeIds,
      }).catch(onFailure),
      'prune',
    );
  } catch (error) {
    console.warn('[MindMapAnchorEdges::sync] sync failed', error);
  }
}

/** 仅供测试 */
export function __resetMindMapAnchorEdgeSyncForTests(): void {
  anchorEdgeSinks.length = 0;
  lastSyncedSignature.clear();
  activeStagingDragId = null;
}
