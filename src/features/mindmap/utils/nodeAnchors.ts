/**
 * 节点摘录元数据（anchors / excerptQuote / imageAssetId）查询索引与出处格式化。
 *
 * 与 nodeImages / nodeDecorations 同一模式：布局引擎不拷贝这些字段，节点组件经
 * 本索引直接读 store 文档树。索引按 document.root 引用 WeakMap 缓存，每次文档变更
 * 仅重建一次（O(n)）；无摘录节点恒返回同一 null，不触发重渲染。
 *
 * 运行时依赖只取纯契约模块 `ui-kernel/contracts/interop`（`@/ui-sdk` 的同源 re-export），
 * 避免把插件内核拖进导图 store 与单测。
 */

import {
  fnv1a64Hex,
  formatAnchorShortLocator,
  sanitizeExcerptDragPayload,
  sanitizeSemanticAnchor,
  serializeSemanticAnchor,
  type ExcerptContentKind,
  type SemanticAnchor,
} from '@/ui-kernel/contracts/interop';
import type {
  MindMapDocument,
  MindMapExcerptSlot,
  MindMapExcerptSlotKind,
  MindMapNode,
  MindMapStagingExcerpt,
} from '../types';
import { isSafeImageSrc } from './imageSanitize';

export interface NodeExcerptMeta {
  anchors: readonly SemanticAnchor[];
  excerptQuote?: string;
  imageAssetId?: string;
  excerpts?: readonly MindMapExcerptSlot[];
  cardNote?: string;
  isExpandedCard?: boolean;
  isFlashcard?: boolean;
}

/** excerptQuote 持久化上限（字符） */
export const MAX_EXCERPT_QUOTE_CHARS = 4000;
/** cardNote 持久化上限（字符） */
export const MAX_CARD_NOTE_CHARS = 4000;

const VALID_SLOT_KINDS = new Set<MindMapExcerptSlotKind>(['text', 'image', 'media', 'qbank']);
const VALID_EXCERPT_CONTENT_KINDS = new Set<ExcerptContentKind>([
  'text',
  'region-image',
  'transcript-cue',
]);

const excerptMetaCache = new WeakMap<MindMapNode, Map<string, NodeExcerptMeta>>();
/** 按节点对象缓存元数据：immer 结构共享下未变更节点复用同一对象，选择器引用稳定 */
const nodeMetaCache = new WeakMap<MindMapNode, NodeExcerptMeta | null>();

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function buildNodeMeta(node: MindMapNode): NodeExcerptMeta | null {
  const sanitizedSlots =
    Array.isArray(node.excerpts) && node.excerpts.length > 0
      ? (sanitizeExcerptSlots(node.excerpts) ?? [])
      : [];
  // 外部写入（agent / 导入 / 手改 JSON）的锚点在渲染前逐项校验，并与槽位锚点去重合并
  const rawAnchors =
    Array.isArray(node.anchors) && node.anchors.length > 0
      ? (sanitizeNodeAnchors(node.anchors) ?? [])
      : [];
  const anchors =
    sanitizedSlots.length > 0
      ? dedupeSemanticAnchors(
          rawAnchors,
          sanitizedSlots.map((slot) => slot.anchor),
        )
      : rawAnchors;
  const hasQuote = hasNonEmptyString(node.excerptQuote);
  const hasImageAsset = hasNonEmptyString(node.imageAssetId);
  const cardNote = sanitizeCardNote(node.cardNote);
  const isExpandedCard = typeof node.isExpandedCard === 'boolean' ? node.isExpandedCard : undefined;
  const isFlashcard = node.isFlashcard === true ? true : undefined;

  if (
    anchors.length === 0 &&
    !hasQuote &&
    !hasImageAsset &&
    sanitizedSlots.length === 0 &&
    !cardNote &&
    isExpandedCard === undefined &&
    !isFlashcard
  ) {
    return null;
  }

  return {
    anchors,
    ...(hasQuote ? { excerptQuote: node.excerptQuote } : {}),
    ...(hasImageAsset ? { imageAssetId: node.imageAssetId } : {}),
    ...(sanitizedSlots.length > 0 ? { excerpts: sanitizedSlots } : {}),
    ...(cardNote ? { cardNote } : {}),
    ...(isExpandedCard !== undefined ? { isExpandedCard } : {}),
    ...(isFlashcard ? { isFlashcard: true } : {}),
  };
}

export function getNodeExcerptMetaMap(root: MindMapNode): Map<string, NodeExcerptMeta> {
  const cached = excerptMetaCache.get(root);
  if (cached) return cached;
  const map = new Map<string, NodeExcerptMeta>();
  const stack: MindMapNode[] = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const mayHaveMeta =
      (Array.isArray(current.anchors) && current.anchors.length > 0) ||
      (Array.isArray(current.excerpts) && current.excerpts.length > 0) ||
      hasNonEmptyString(current.excerptQuote) ||
      hasNonEmptyString(current.imageAssetId) ||
      hasNonEmptyString(current.cardNote) ||
      typeof current.isExpandedCard === 'boolean' ||
      current.isFlashcard === true;
    if (mayHaveMeta) {
      let meta = nodeMetaCache.get(current);
      if (meta === undefined) {
        meta = buildNodeMeta(current);
        nodeMetaCache.set(current, meta);
      }
      if (meta) map.set(current.id, meta);
    }
    const children = current.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i]);
    }
  }
  excerptMetaCache.set(root, map);
  return map;
}

/** zustand 选择器：节点摘录元数据（引用稳定）；无摘录返回 null */
export function selectNodeExcerptMeta(root: MindMapNode, nodeId: string): NodeExcerptMeta | null {
  return getNodeExcerptMetaMap(root).get(nodeId) ?? null;
}

/**
 * 出处胶囊文案（大写 + 等宽数字）：
 * - pdf   -> "P.218"
 * - media -> "14:22" / "01:04:05"
 * - note  -> "#blk_9f8a"
 * - qbank -> "Q.q_12"
 */
export function formatMindMapSourcePill(anchor: SemanticAnchor): string {
  if (anchor.kind === 'pdf') {
    return `P.${anchor.page}`;
  }
  if (anchor.kind === 'qbank') {
    return anchor.questionId ? `Q.${anchor.questionId}` : 'QBANK';
  }
  const short = formatAnchorShortLocator(anchor);
  return short || anchor.label || anchor.kind.toUpperCase();
}

export function formatMediaTimestampMs(ms: number): string {
  const clamped = Math.max(0, Math.floor(Number.isFinite(ms) ? ms / 1000 : 0));
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = clamped % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatMediaRangeLabel(startMs: number, endMs?: number): string {
  const start = formatMediaTimestampMs(startMs);
  if (endMs !== undefined && Number.isFinite(endMs) && endMs > startMs) {
    return `${start}-${formatMediaTimestampMs(endMs)}`;
  }
  return start;
}

/** 锚点 URI；非法锚点返回 null（不抛错） */
export function safeSerializeAnchor(anchor: SemanticAnchor): string | null {
  try {
    return serializeSemanticAnchor(anchor);
  } catch {
    return null;
  }
}

export function dedupeSemanticAnchors(
  existing: readonly SemanticAnchor[] | undefined,
  incoming: readonly SemanticAnchor[],
): SemanticAnchor[] {
  const result: SemanticAnchor[] = [];
  const seen = new Set<string>();
  for (const item of [...(existing ?? []), ...incoming]) {
    const uri = safeSerializeAnchor(item);
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    result.push(item);
  }
  return result;
}

/** 清洗外部 anchors 字段：逐项校验 + 去重；无有效项返回 undefined（调用方据此删字段） */
export function sanitizeNodeAnchors(raw: unknown): SemanticAnchor[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const valid: SemanticAnchor[] = [];
  for (const item of raw) {
    const anchor = sanitizeSemanticAnchor(item);
    if (anchor) valid.push(anchor);
  }
  const deduped = dedupeSemanticAnchors(undefined, valid);
  return deduped.length > 0 ? deduped : undefined;
}

export function sanitizeExcerptQuote(raw: unknown): string | undefined {
  if (!hasNonEmptyString(raw)) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > MAX_EXCERPT_QUOTE_CHARS ? trimmed.slice(0, MAX_EXCERPT_QUOTE_CHARS) : trimmed;
}

export function sanitizeCardNote(raw: unknown): string | undefined {
  if (!hasNonEmptyString(raw)) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > MAX_CARD_NOTE_CHARS ? trimmed.slice(0, MAX_CARD_NOTE_CHARS) : trimmed;
}

export function sanitizeImageAssetId(raw: unknown): string | undefined {
  return hasNonEmptyString(raw) ? raw.trim() : undefined;
}

function sanitizeSlotImageUrl(raw: unknown): string | undefined {
  if (!hasNonEmptyString(raw)) return undefined;
  const trimmed = raw.trim();
  if (trimmed.startsWith('vfs://') || isSafeImageSrc(trimmed)) {
    return trimmed;
  }
  return undefined;
}

function inferSlotKind(anchor: SemanticAnchor, hasImage: boolean): MindMapExcerptSlotKind {
  if (anchor.kind === 'qbank') return 'qbank';
  if (anchor.kind === 'media') return 'media';
  if (hasImage) return 'image';
  return 'text';
}

export function sanitizeExcerptSlot(raw: unknown): MindMapExcerptSlot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  const anchor = sanitizeSemanticAnchor(candidate.anchor);
  if (!anchor) return null;
  const anchorUri = safeSerializeAnchor(anchor);
  if (!anchorUri) return null;

  const text = sanitizeExcerptQuote(candidate.text);
  const imageDataUrl = sanitizeSlotImageUrl(candidate.imageDataUrl);
  const imageAssetId = sanitizeImageAssetId(candidate.imageAssetId);
  const kind = VALID_SLOT_KINDS.has(candidate.kind as MindMapExcerptSlotKind)
    ? (candidate.kind as MindMapExcerptSlotKind)
    : inferSlotKind(anchor, Boolean(imageDataUrl || imageAssetId));

  const startMs =
    anchor.kind === 'media'
      ? anchor.startMs
      : typeof candidate.startMs === 'number' && Number.isFinite(candidate.startMs) && candidate.startMs >= 0
        ? Math.round(candidate.startMs)
        : undefined;
  const endMs =
    anchor.kind === 'media' && anchor.endMs !== undefined
      ? anchor.endMs
      : typeof candidate.endMs === 'number' &&
          Number.isFinite(candidate.endMs) &&
          startMs !== undefined &&
          candidate.endMs >= startMs
        ? Math.round(candidate.endMs)
        : undefined;
  const questionId =
    anchor.kind === 'qbank'
      ? anchor.questionId
      : hasNonEmptyString(candidate.questionId)
        ? candidate.questionId.trim().slice(0, 128)
        : undefined;
  const sourceTitle = hasNonEmptyString(candidate.sourceTitle)
    ? candidate.sourceTitle.trim().slice(0, 120)
    : undefined;
  const createdAt =
    typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt) && candidate.createdAt >= 0
      ? Math.floor(candidate.createdAt)
      : undefined;
  const id = hasNonEmptyString(candidate.id)
    ? candidate.id.trim().slice(0, 128)
    : `slot_${fnv1a64Hex(`${anchorUri}:${text ?? ''}:${imageAssetId ?? ''}`)}`;

  return {
    id,
    kind,
    ...(text ? { text } : {}),
    ...(imageDataUrl ? { imageDataUrl } : {}),
    ...(imageAssetId ? { imageAssetId } : {}),
    ...(startMs !== undefined ? { startMs } : {}),
    ...(endMs !== undefined ? { endMs } : {}),
    ...(questionId ? { questionId } : {}),
    anchor,
    ...(sourceTitle ? { sourceTitle } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

export function sanitizeExcerptSlots(raw: unknown): MindMapExcerptSlot[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: MindMapExcerptSlot[] = [];
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  for (const item of raw) {
    const slot = sanitizeExcerptSlot(item);
    if (!slot) continue;
    const anchorUri = safeSerializeAnchor(slot.anchor) ?? '';
    const contentKey = `${anchorUri}\u0000${slot.text ?? ''}\u0000${slot.imageAssetId ?? slot.imageDataUrl ?? ''}`;
    if (seenIds.has(slot.id) || seenKeys.has(contentKey)) continue;
    seenIds.add(slot.id);
    seenKeys.add(contentKey);
    out.push(slot);
  }
  return out.length > 0 ? out : undefined;
}

export function sanitizeStagingExcerpts(raw: unknown): MindMapStagingExcerpt[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: MindMapStagingExcerpt[] = [];
  const seenIds = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const candidate = item as Record<string, unknown>;
    const excerptKind = VALID_EXCERPT_CONTENT_KINDS.has(candidate.excerptKind as ExcerptContentKind)
      ? (candidate.excerptKind as ExcerptContentKind)
      : 'text';
    const payload = sanitizeExcerptDragPayload({
      excerptKind,
      text: typeof candidate.text === 'string' ? candidate.text : '',
      imageDataUrl: typeof candidate.imageDataUrl === 'string' ? candidate.imageDataUrl : undefined,
      anchor: candidate.anchor,
      sourceTitle: typeof candidate.sourceTitle === 'string' ? candidate.sourceTitle : undefined,
      createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now(),
    });
    if (!payload) continue;
    const id = hasNonEmptyString(candidate.id)
      ? candidate.id.trim().slice(0, 128)
      : `stg_${fnv1a64Hex(`${payload.anchorUri}:${payload.text}:${payload.createdAt}`)}`;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    const title = hasNonEmptyString(candidate.title)
      ? candidate.title.trim().slice(0, 160)
      : (payload.text.trim().slice(0, 72) || formatMindMapSourcePill(payload.anchor));
    const excerptQuote = sanitizeExcerptQuote(candidate.excerptQuote);
    const imageAssetId = sanitizeImageAssetId(candidate.imageAssetId);
    out.push({
      id,
      excerptKind: payload.excerptKind,
      text: payload.text,
      title,
      ...(excerptQuote ? { excerptQuote } : {}),
      ...(payload.imageDataUrl ? { imageDataUrl: payload.imageDataUrl } : {}),
      ...(imageAssetId ? { imageAssetId } : {}),
      anchor: payload.anchor,
      anchorUri: payload.anchorUri,
      ...(payload.sourceTitle ? { sourceTitle: payload.sourceTitle } : {}),
      createdAt: payload.createdAt,
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * 原地规范化一个节点的摘录与复合卡片字段：保留有效值，删除空数组/空串/非法值，
 * 使旧文档与新文档序列化时都不出现噪声字段。
 */
export function normalizeNodeExcerptFields(node: MindMapNode): void {
  const record = node as unknown as Record<string, unknown>;
  if ('excerpts' in record) {
    const slots = sanitizeExcerptSlots(record.excerpts);
    if (slots) node.excerpts = slots;
    else delete record.excerpts;
  }
  if ('anchors' in record) {
    const anchors = sanitizeNodeAnchors(record.anchors);
    if (anchors) node.anchors = anchors;
    else delete record.anchors;
  }
  if ('excerptQuote' in record) {
    const quote = sanitizeExcerptQuote(record.excerptQuote);
    if (quote) node.excerptQuote = quote;
    else delete record.excerptQuote;
  }
  if ('imageAssetId' in record) {
    const assetId = sanitizeImageAssetId(record.imageAssetId);
    if (assetId) node.imageAssetId = assetId;
    else delete record.imageAssetId;
  }
  if ('cardNote' in record) {
    const cardNote = sanitizeCardNote(record.cardNote);
    if (cardNote) node.cardNote = cardNote;
    else delete record.cardNote;
  }
  if ('isExpandedCard' in record) {
    if (typeof record.isExpandedCard === 'boolean') node.isExpandedCard = record.isExpandedCard;
    else delete record.isExpandedCard;
  }
  if ('isFlashcard' in record) {
    if (record.isFlashcard === true) node.isFlashcard = true;
    else delete record.isFlashcard;
  }
}

/** 遍历整棵树规范化摘录字段（加载文档时调用；无摘录字段的旧文档零改动） */
export function normalizeTreeExcerptFields(root: MindMapNode): void {
  const stack: MindMapNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    normalizeNodeExcerptFields(node);
    for (const child of node.children ?? []) stack.push(child);
  }
}

/** 规范化文档级待整理池（空数组移除） */
export function normalizeDocumentStagingExcerpts(document: MindMapDocument): void {
  const record = document as unknown as Record<string, unknown>;
  if (!('stagingExcerpts' in record)) return;
  const items = sanitizeStagingExcerpts(record.stagingExcerpts);
  if (items) document.stagingExcerpts = items;
  else delete record.stagingExcerpts;
}

/** 树中是否存在任何摘录或复合卡片字段（加载时快速判定是否需要规范化） */
export function treeHasExcerptFields(root: MindMapNode): boolean {
  const stack: MindMapNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (
      'anchors' in node ||
      'excerptQuote' in node ||
      'imageAssetId' in node ||
      'excerpts' in node ||
      'cardNote' in node ||
      'isExpandedCard' in node ||
      'isFlashcard' in node
    ) {
      return true;
    }
    for (const child of node.children ?? []) stack.push(child);
  }
  return false;
}
