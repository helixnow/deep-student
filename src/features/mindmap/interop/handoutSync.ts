/**
 * 笔记讲义 -> 导图树原地回写（C7 §2.3 反向结构化同步）。
 *
 * 讲义由 `compileMindMapSubtreeToHandout` 生成时，每个小节都带一条
 * `ds-anchor://v1/...kind=mindmap&resourceId=<mindmapId>&nodeId=<id>` 自出处胶囊。
 * 回写时按该稳定节点 ID 匹配：
 * - 命中：只同步标题 / 个人理解备注，保留节点原有摘录、锚点、样式、折叠态与投影开关；
 * - 未命中（笔记里新增的小节）：作为新节点挂到对应父节点下；
 * - 讲义未提及、但导图里仍存在的子节点：原样挂在末尾，绝不因为笔记删改而丢数据。
 */
import type { SemanticAnchor } from '@/ui-kernel/contracts/interop';
import { fnv1a64Hex, serializeSemanticAnchor } from '@/ui-kernel/contracts/interop';
import type { CompoundMindMapNodeDraft } from '@/ui-kernel/services/mindmapHandoutBridge';
import type {
  MindMapDocument,
  MindMapExcerptSlot,
  MindMapExcerptSlotKind,
  MindMapImage,
  MindMapNode,
} from '../types';
import { generateNodeId } from '../utils/node/create';

export interface MergeHandoutDraftOptions {
  /** 讲义出处胶囊指向的导图 resourceId */
  mindmapId: string;
}

export interface MergeHandoutDraftResult {
  document: MindMapDocument;
  /** 文本或备注被原地改写的节点数 */
  updated: number;
  /** 讲义新增、导图原本不存在的节点数 */
  added: number;
}

function normalizeInlineText(raw: string | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeBlockText(raw: string | undefined): string {
  return (raw ?? '').replace(/\r\n?/g, '\n').trim();
}

function anchorKey(anchor: SemanticAnchor): string {
  try {
    return serializeSemanticAnchor(anchor);
  } catch {
    const nodeId = 'nodeId' in anchor && typeof anchor.nodeId === 'string' ? anchor.nodeId : '';
    return `${anchor.kind}:${anchor.resourceId}:${nodeId}`;
  }
}

function collectDraftAnchors(draftNode: CompoundMindMapNodeDraft): SemanticAnchor[] {
  const out: SemanticAnchor[] = [];
  for (const anchor of draftNode.anchors ?? []) out.push(anchor);
  for (const slot of draftNode.excerpts ?? []) {
    if (slot.anchor) out.push(slot.anchor);
  }
  return out;
}

function toExcerptKind(
  kind: string | undefined,
  anchor: SemanticAnchor,
): MindMapExcerptSlotKind {
  if (kind === 'region-image') return 'image';
  if (kind === 'transcript-cue') return 'media';
  if (anchor.kind === 'qbank') return 'qbank';
  return 'text';
}

function buildExcerptSlots(
  draftNode: CompoundMindMapNodeDraft,
  mindmapId: string,
): MindMapExcerptSlot[] {
  const slots: MindMapExcerptSlot[] = [];
  (draftNode.excerpts ?? []).forEach((slot, index) => {
    if (!slot.anchor) return;
    const anchorUri = anchorKey(slot.anchor);
    const text = (slot.text ?? '').trim();
    const latex = (slot.latex ?? '').trim();
    const imageDataUrl = slot.imageDataUrl?.trim();
    if (!text && !latex && !imageDataUrl) return;
    slots.push({
      id: `slot_${fnv1a64Hex(`${mindmapId}:${draftNode.id}:${index}:${anchorUri}`).slice(0, 12)}`,
      kind: toExcerptKind(slot.excerptKind, slot.anchor),
      anchor: slot.anchor,
      ...(text ? { text } : {}),
      ...(imageDataUrl ? { imageDataUrl } : {}),
      ...(slot.imageAssetId?.trim() ? { imageAssetId: slot.imageAssetId.trim() } : {}),
      ...(slot.sourceTitle?.trim() ? { sourceTitle: slot.sourceTitle.trim() } : {}),
      ...(latex ? { sourceTitle: slot.sourceTitle?.trim() || latex.slice(0, 120) } : {}),
    });
  });
  return slots;
}

function toImages(images: ReadonlyArray<{ src: string; name?: string }> | undefined): MindMapImage[] {
  if (!images?.length) return [];
  const out: MindMapImage[] = [];
  for (const image of images) {
    const src = image.src?.trim();
    if (!src) continue;
    out.push(image.name?.trim() ? { src, name: image.name.trim() } : { src });
  }
  return out;
}

function findProvenanceNodeId(
  draftNode: CompoundMindMapNodeDraft,
  mindmapId: string,
  existingById: Map<string, MindMapNode>,
): string | undefined {
  for (const anchor of collectDraftAnchors(draftNode)) {
    if (anchor.kind !== 'mindmap') continue;
    if (anchor.resourceId !== mindmapId) continue;
    if (!anchor.nodeId) continue;
    if (existingById.has(anchor.nodeId)) return anchor.nodeId;
  }
  return undefined;
}

function replaceSubtree(
  node: MindMapNode,
  targetId: string,
  replacement: MindMapNode,
): MindMapNode | null {
  if (node.id === targetId) return replacement;
  let changed = false;
  const children = node.children.map((child) => {
    const next = replaceSubtree(child, targetId, replacement);
    if (next && next !== child) {
      changed = true;
      return next;
    }
    return child;
  });
  return changed ? { ...node, children } : null;
}

/**
 * 把讲义解析出的节点草稿合并回导图文档（纯函数，不改入参）。
 */
export function mergeHandoutDraftIntoMindMap(
  document: MindMapDocument,
  draft: CompoundMindMapNodeDraft,
  options: MergeHandoutDraftOptions,
): MergeHandoutDraftResult {
  const mindmapId = options.mindmapId.trim();
  if (!mindmapId) {
    throw new Error('mergeHandoutDraftIntoMindMap requires a mindmapId');
  }

  const existingById = new Map<string, MindMapNode>();
  const indexTree = (node: MindMapNode) => {
    existingById.set(node.id, node);
    node.children.forEach(indexTree);
  };
  indexTree(document.root);

  const claimedIds = new Set<string>();
  let updated = 0;
  let added = 0;

  const resolveDraftTargetId = (draftNode: CompoundMindMapNodeDraft): string | undefined => {
    const nodeId = findProvenanceNodeId(draftNode, mindmapId, existingById);
    if (!nodeId || claimedIds.has(nodeId)) return undefined;
    return nodeId;
  };

  const createNode = (draftNode: CompoundMindMapNodeDraft, children: MindMapNode[]): MindMapNode => {
    added += 1;
    const text = normalizeInlineText(draftNode.text) || '未命名节点';
    const node: MindMapNode = { id: generateNodeId(), text, children };
    const note = normalizeBlockText(draftNode.note);
    if (note) node.note = note;
    const anchors = collectDraftAnchors(draftNode).filter((anchor) => {
      if (anchor.kind === 'mindmap' && anchor.resourceId === mindmapId) return false;
      return true;
    });
    if (anchors.length > 0) node.anchors = anchors;
    const slots = buildExcerptSlots(draftNode, mindmapId);
    if (slots.length > 0) node.excerpts = slots;
    const quote = normalizeBlockText(draftNode.excerptQuote);
    if (quote) node.excerptQuote = quote;
    if (draftNode.imageAssetId?.trim()) node.imageAssetId = draftNode.imageAssetId.trim();
    const images = toImages(draftNode.images);
    if (images.length > 0) node.images = images;
    return node;
  };

  const mergeNode = (draftNode: CompoundMindMapNodeDraft): MindMapNode => {
    const existingId = resolveDraftTargetId(draftNode);
    const existing = existingId ? existingById.get(existingId) : undefined;

    const mergedChildIds = new Set<string>();
    const children: MindMapNode[] = [];
    for (const childDraft of draftNode.children ?? []) {
      const childExistingId = resolveDraftTargetId(childDraft);
      if (childExistingId) mergedChildIds.add(childExistingId);
      children.push(mergeNode(childDraft));
    }

    if (!existing) {
      return createNode(draftNode, children);
    }

    claimedIds.add(existing.id);
    for (const child of existing.children) {
      if (!mergedChildIds.has(child.id)) children.push(child);
    }

    const nextText = normalizeInlineText(draftNode.text);
    const textChanged = nextText.length > 0 && nextText !== existing.text;
    const nextNote = normalizeBlockText(draftNode.note);
    const noteChanged = nextNote.length > 0 && nextNote !== (existing.note ?? '');

    const anchors = existing.anchors ? [...existing.anchors] : [];
    const knownAnchorKeys = new Set(anchors.map(anchorKey));
    let anchorsChanged = false;
    for (const anchor of collectDraftAnchors(draftNode)) {
      if (anchor.kind === 'mindmap' && anchor.resourceId === mindmapId) continue;
      const key = anchorKey(anchor);
      if (knownAnchorKeys.has(key)) continue;
      knownAnchorKeys.add(key);
      anchors.push(anchor);
      anchorsChanged = true;
    }

    if (!textChanged && !noteChanged && !anchorsChanged && children.length === existing.children.length
      && children.every((child, index) => child === existing.children[index])) {
      return existing;
    }

    if (textChanged || noteChanged) updated += 1;

    const next: MindMapNode = { ...existing, children };
    if (textChanged) next.text = nextText;
    if (noteChanged) next.note = nextNote;
    if (anchorsChanged) next.anchors = anchors;
    return next;
  };

  const draftRootTargetId = resolveDraftTargetId(draft);
  let nextRoot: MindMapNode = document.root;

  if (draftRootTargetId === document.root.id) {
    nextRoot = mergeNode(draft);
  } else if (draftRootTargetId) {
    const rebuilt = mergeNode(draft);
    nextRoot = replaceSubtree(document.root, draftRootTargetId, rebuilt) ?? document.root;
  } else {
    // 讲义没有指向本导图的出处（或原节点已删除）：作为新分支挂到根节点。
    const branch = mergeNode(draft);
    nextRoot = { ...document.root, children: [...document.root.children, branch] };
  }

  if (nextRoot === document.root) {
    return { document, updated: 0, added: 0 };
  }
  return { document: { ...document, root: nextRoot }, updated, added };
}
