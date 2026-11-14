/**
 * 思维导图节点 → FSRS 闪卡确定性投影适配器（C7 §3.4）
 *
 * 契约：
 * - 确定性卡片 ID：`card_mm_${mapId}_${nodeId}`
 * - 正面（front）：`[父级路径] 节点标题`（根节点无祖先时直接为标题）
 * - 背面（back）：`个人理解批注（cardNote / note） + 格式化多源摘录槽（excerpts[] / excerptQuote） + 子节点要点列表`
 * - 出处锚点（anchors）：节点 provenance 锚点 + 自身 mindmap 节点锚点（去重）
 * - 幂等更新保护：首次开启时入队 FSRS；后续标题 / 批注 / 摘录 / 子节点编辑只走同文档 `save_anki_cards`
 *   原地更新 `front` / `back` / `fields`，绝不重置已有 FSRS 记忆参数（stability / difficulty / reps / lapses）。
 */

import { invoke } from '@tauri-apps/api/core';
import { dispatchTypedEvent } from '@/events';
import type { SemanticAnchor } from '@/ui-kernel/contracts/interop';
import type { MindMapExcerptSlot, MindMapNode } from '../types';
import {
  dedupeSemanticAnchors,
  formatMediaRangeLabel,
  formatMindMapSourcePill,
  safeSerializeAnchor,
} from '../utils/nodeAnchors';
import { isSafeImageSrc } from '../utils/imageSanitize';

export const DS_MINDMAP_FLASHCARD_PROJECTED_EVENT = 'ds:mindmap-flashcard-projected';

const PATH_SEPARATOR = ' \u203a ';

export interface MindMapProjectedFlashcardPayload {
  /** 确定性闪卡 ID：`card_mm_${mapId}_${nodeId}` */
  id: string;
  mapId: string;
  nodeId: string;
  mapTitle: string;
  ancestorPath: string[];
  front: string;
  back: string;
  anchors: SemanticAnchor[];
  images: string[];
  tags: string[];
}

export interface MindMapCardProjectionSink {
  upsertProjectedCard: (
    payload: MindMapProjectedFlashcardPayload,
    meta: { isInitialInsert: boolean },
  ) => Promise<void> | void;
  removeProjectedCard: (params: {
    id: string;
    mapId: string;
    nodeId: string;
  }) => Promise<void> | void;
}

interface FsrsEnqueueStateItem {
  id: string;
  ankiCardId?: string;
  anki_card_id?: string;
}

interface FsrsEnqueueResponse {
  states?: FsrsEnqueueStateItem[];
}

const projectionSinks: MindMapCardProjectionSink[] = [];
/** mapId -> Map<nodeId, signature>（用于对账跳过未变更节点与检测取消投影的节点） */
const projectedSignaturesByMap = new Map<string, Map<string, string>>();
/** 已入队过 FSRS 的确定性卡片 ID（避免每次文本微调重复调 fsrs_enqueue_cards） */
const enqueuedCardIds = new Set<string>();
/** ankiCardId -> fsrs_card_states.id（用于取消投影时挂起卡片而不销毁复习历史） */
const fsrsStateIdByCardId = new Map<string, string>();
const persistenceByCardId = new Map<string, Promise<void>>();

/** A toggle-off must wait for an in-flight save/enqueue, otherwise it can leave a live orphan card. */
function persistInOrder(id: string, action: () => Promise<void>): Promise<void> {
  const previous = persistenceByCardId.get(id);
  const next = previous ? previous.catch(() => undefined).then(action) : action();
  persistenceByCardId.set(id, next);
  void next.finally(() => {
    if (persistenceByCardId.get(id) === next) persistenceByCardId.delete(id);
  }).catch(() => undefined);
  return next;
}

export function buildMindMapFlashcardId(mapId: string, nodeId: string): string {
  return `card_mm_${mapId}_${nodeId}`;
}

function formatExcerptSlotLine(slot: MindMapExcerptSlot): string | null {
  let locator: string;
  if (slot.anchor.kind === 'media') {
    locator = formatMediaRangeLabel(
      slot.startMs ?? slot.anchor.startMs,
      slot.endMs ?? slot.anchor.endMs,
    );
  } else {
    locator = formatMindMapSourcePill(slot.anchor);
  }
  const sourcePrefix = slot.sourceTitle ? `${slot.sourceTitle} ${locator}` : locator;
  const body = (slot.text ?? ('quote' in slot.anchor ? slot.anchor.quote : '') ?? '').trim();
  if (body) {
    return `[${sourcePrefix}] ${body}`;
  }
  if (slot.imageDataUrl || slot.imageAssetId) {
    return `[${sourcePrefix}] (Image Excerpt)`;
  }
  return `[${sourcePrefix}]`;
}

function collectNodeProvenanceAnchors(
  mapId: string,
  node: MindMapNode,
): SemanticAnchor[] {
  const slotAnchors = (node.excerpts ?? []).map((slot) => slot.anchor);
  const selfAnchor: SemanticAnchor = {
    kind: 'mindmap',
    resourceId: mapId,
    nodeId: node.id,
    ...(node.text?.trim() ? { label: node.text.trim().slice(0, 120) } : {}),
  };
  return dedupeSemanticAnchors(node.anchors, [...slotAnchors, selfAnchor]);
}

function collectNodeCardImages(node: MindMapNode): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (src: string | undefined) => {
    if (!src) return;
    const trimmed = src.trim();
    if (!trimmed || seen.has(trimmed)) return;
    if (!isSafeImageSrc(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };
  for (const slot of node.excerpts ?? []) push(slot.imageDataUrl);
  for (const img of node.images ?? []) push(img.src);
  return out;
}

function buildPayloadFromResolvedNode(
  mapId: string,
  mapTitle: string,
  node: MindMapNode,
  ancestorPath: string[],
): MindMapProjectedFlashcardPayload {
  const id = buildMindMapFlashcardId(mapId, node.id);
  const nodeLabel = (node.text ?? '').trim() || mapTitle || node.id;
  const cleanAncestors = ancestorPath.map((item) => item.trim()).filter(Boolean);
  const front =
    cleanAncestors.length > 0
      ? `[${cleanAncestors.join(PATH_SEPARATOR)}] ${nodeLabel}`
      : nodeLabel;

  const sections: string[] = [];

  // 1. 个人理解批注（cardNote 优先；若 legacy note 不同则一并保留）
  const synthesisNote = (node.cardNote ?? '').trim();
  const legacyNote = (node.note ?? '').trim();
  if (synthesisNote) {
    sections.push(synthesisNote);
  }
  if (legacyNote && legacyNote !== synthesisNote) {
    sections.push(legacyNote);
  }

  // 2. 多源摘录槽（或单摘录 excerptQuote 回退）
  if (node.excerpts && node.excerpts.length > 0) {
    const slotLines = node.excerpts
      .map(formatExcerptSlotLine)
      .filter((line): line is string => Boolean(line));
    if (slotLines.length > 0) {
      sections.push(slotLines.join('\n'));
    }
  } else if (node.excerptQuote?.trim()) {
    const firstAnchor = node.anchors?.[0];
    const prefix = firstAnchor ? `[${formatMindMapSourcePill(firstAnchor)}] ` : '';
    sections.push(`${prefix}${node.excerptQuote.trim()}`);
  }

  // 3. 子节点要点摘要
  const childBullets = (node.children ?? [])
    .map((child) => (child.text ?? '').trim())
    .filter(Boolean)
    .map((text) => `- ${text}`);
  if (childBullets.length > 0) {
    sections.push(childBullets.join('\n'));
  }

  // 兜底：独立叶子节点尚未填写批注/子节点时保证 Basic 卡背面非空
  const back = sections.length > 0 ? sections.join('\n\n') : nodeLabel;
  const anchors = collectNodeProvenanceAnchors(mapId, node);
  const images = collectNodeCardImages(node);
  const cleanTitle = mapTitle.trim();
  const tags = ['mindmap-card', ...(cleanTitle ? [cleanTitle] : [])];

  return {
    id,
    mapId,
    nodeId: node.id,
    mapTitle: cleanTitle,
    ancestorPath: cleanAncestors,
    front,
    back,
    anchors,
    images,
    tags,
  };
}

/** 为指定节点构造确定性闪卡载荷（不要求 node.isFlashcard 为 true，便于预览与单测） */
export function buildProjectedFlashcardPayload(
  mapId: string,
  root: MindMapNode,
  targetNodeId: string,
): MindMapProjectedFlashcardPayload | null {
  if (!mapId || !targetNodeId) return null;
  const mapTitle = (root.text ?? '').trim();

  const walk = (
    current: MindMapNode,
    ancestors: string[],
  ): MindMapProjectedFlashcardPayload | null => {
    if (current.id === targetNodeId) {
      return buildPayloadFromResolvedNode(mapId, mapTitle, current, ancestors);
    }
    const nextAncestors = [...ancestors, current.text ?? ''];
    for (const child of current.children ?? []) {
      const found = walk(child, nextAncestors);
      if (found) return found;
    }
    return null;
  };

  return walk(root, []);
}

/** 收集整棵树所有开启 `isFlashcard` 的节点载荷 */
export function collectProjectedFlashcards(
  mapId: string,
  root: MindMapNode,
): MindMapProjectedFlashcardPayload[] {
  if (!mapId) return [];
  const mapTitle = (root.text ?? '').trim();
  const out: MindMapProjectedFlashcardPayload[] = [];

  const walk = (current: MindMapNode, ancestors: string[]) => {
    if (current.isFlashcard === true) {
      out.push(buildPayloadFromResolvedNode(mapId, mapTitle, current, ancestors));
    }
    const nextAncestors = [...ancestors, current.text ?? ''];
    for (const child of current.children ?? []) {
      walk(child, nextAncestors);
    }
  };

  walk(root, []);
  return out;
}

function payloadSignature(payload: MindMapProjectedFlashcardPayload): string {
  const anchorSig = payload.anchors
    .map((anchor) => safeSerializeAnchor(anchor) ?? '')
    .join('|');
  return `${payload.front}\u0000${payload.back}\u0000${anchorSig}\u0000${payload.images.join('|')}`;
}

export function registerMindMapCardProjectionSink(sink: MindMapCardProjectionSink): () => void {
  projectionSinks.push(sink);
  return () => {
    const idx = projectionSinks.lastIndexOf(sink);
    if (idx >= 0) projectionSinks.splice(idx, 1);
  };
}

function dispatchProjectionDomEvent(
  action: 'upsert' | 'remove',
  detail: Record<string, unknown>,
): void {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    dispatchTypedEvent(DS_MINDMAP_FLASHCARD_PROJECTED_EVENT, { action, ...detail });
  }
}

async function defaultPersistUpsert(
  payload: MindMapProjectedFlashcardPayload,
  isInitialInsert: boolean,
): Promise<void> {
  const { ankiApiAdapter } = await import('@/services/ankiApiAdapter');
  const deckName = payload.mapTitle ? `MindMap::${payload.mapTitle}` : 'MindMap';
  const options = {
    deck_name: deckName,
    note_type: 'Basic',
    enable_images: false,
    max_cards_per_source: 1,
    max_cards_per_mistake: 1,
    source_ref: {
      kind: 'mindmap',
      id: payload.mapId,
      title: payload.mapTitle,
    },
  };
  const response = await ankiApiAdapter.saveAnkiCards({
    documentId: payload.mapId,
    cards: [
      {
        id: payload.id,
        front: payload.front,
        back: payload.back,
        tags: payload.tags,
        images: payload.images,
        fields: {
          Front: payload.front,
          Back: payload.back,
          SourceMindMapId: payload.mapId,
          SourceNodeId: payload.nodeId,
          AnchorsJson: JSON.stringify(payload.anchors),
        },
      },
    ],
    options,
  });

  const persistedId =
    response.savedIds?.[0] ??
    response.cardIdMappings?.[0]?.persistedId ??
    payload.id;
  const wasNewlyInserted = (response.savedIds ?? []).includes(persistedId);
  const existingFsrsStateId = fsrsStateIdByCardId.get(persistedId);

  // 仅在首次新建或尚未入队时调用 fsrs_enqueue_cards；若此前被挂起则恢复，绝不重置已有 FSRS 进度
  if (existingFsrsStateId && isInitialInsert) {
    await invoke('fsrs_unsuspend_card', { cardStateId: existingFsrsStateId }).catch(() => undefined);
  } else if (wasNewlyInserted || (isInitialInsert && !enqueuedCardIds.has(persistedId))) {
    const enq = await invoke<FsrsEnqueueResponse>('fsrs_enqueue_cards', {
      ankiCardIds: [persistedId],
    }).catch(() => null);
    enqueuedCardIds.add(persistedId);
    const firstState = enq?.states?.[0];
    if (firstState?.id) {
      fsrsStateIdByCardId.set(persistedId, firstState.id);
    }
  }
}

async function defaultPersistRemove(params: {
  id: string;
  mapId: string;
  nodeId: string;
}): Promise<void> {
  const stateId = fsrsStateIdByCardId.get(params.id);
  if (stateId) {
    await invoke('fsrs_suspend_card', { cardStateId: stateId }).catch(() => undefined);
    return;
  }
  const { ankiApiAdapter } = await import('@/services/ankiApiAdapter');
  await ankiApiAdapter.deleteAnkiCards({ cardIds: [params.id] }).catch(() => undefined);
}

/** 立即创建或原地更新单张节点投影闪卡（不重置 FSRS 调度参数） */
export async function upsertProjectedFlashcard(
  payload: MindMapProjectedFlashcardPayload,
  options?: { isInitialInsert?: boolean },
): Promise<void> {
  const isInitialInsert = options?.isInitialInsert ?? !enqueuedCardIds.has(payload.id);
  dispatchProjectionDomEvent('upsert', { card: payload, isInitialInsert });

  const activeSink = projectionSinks[projectionSinks.length - 1];
  if (activeSink) {
    await activeSink.upsertProjectedCard(payload, { isInitialInsert });
    enqueuedCardIds.add(payload.id);
    return;
  }

  try {
    await persistInOrder(payload.id, () => defaultPersistUpsert(payload, isInitialInsert));
  } catch (error) {
    // 非 Tauri 环境或离线单测静默降级，不阻塞导图编辑
    console.warn('[MindMapCardProjection::upsert] persistence skipped:', error);
    projectedSignaturesByMap.get(payload.mapId)?.delete(payload.nodeId);
  }
}

/** 取消节点闪卡投影（优先挂起 FSRS 保留记忆曲线，无状态时删除草稿卡） */
export async function removeProjectedFlashcard(params: {
  id: string;
  mapId: string;
  nodeId: string;
}): Promise<void> {
  dispatchProjectionDomEvent('remove', params);

  const activeSink = projectionSinks[projectionSinks.length - 1];
  if (activeSink) {
    await activeSink.removeProjectedCard(params);
    return;
  }

  try {
    await persistInOrder(params.id, () => defaultPersistRemove(params));
  } catch (error) {
    console.warn('[MindMapCardProjection::remove] persistence skipped:', error);
  }
}

function swallowProjection(promise: Promise<unknown> | unknown): void {
  if (promise && typeof (promise as Promise<unknown>).catch === 'function') {
    (promise as Promise<unknown>).catch((error: unknown) => {
      console.warn('[MindMapCardProjection] async error:', error);
    });
  }
}

/**
 * 对账整张导图的闪卡投影：
 * - 新增勾选 `isFlashcard` 的节点 -> 创建卡片并入队 FSRS
 * - 已投影节点的标题 / 父路径 / cardNote / excerpts / 子节点变更 -> 原地更新卡面，保留 FSRS 参数
 * - 取消勾选或被删除的节点 -> 挂起/移除对应投影闪卡
 * - 未变更节点零 IPC 开销
 */
export function reconcileMindMapProjectedFlashcards(
  mapId: string | null,
  root: MindMapNode | null | undefined,
  options?: { force?: boolean },
): void {
  if (!mapId || !root) return;
  const previous = projectedSignaturesByMap.get(mapId) ?? new Map<string, string>();
  const next = new Map<string, string>();
  const currentCards = collectProjectedFlashcards(mapId, root);

  for (const card of currentCards) {
    const sig = payloadSignature(card);
    next.set(card.nodeId, sig);
    const prevSig = previous.get(card.nodeId);
    if (options?.force || prevSig !== sig) {
      // A re-enabled card must unsuspend even if it has already been enqueued this session.
      const isInitialInsert = prevSig === undefined;
      swallowProjection(upsertProjectedFlashcard(card, { isInitialInsert }));
    }
  }

  for (const [prevNodeId] of previous) {
    if (!next.has(prevNodeId)) {
      const id = buildMindMapFlashcardId(mapId, prevNodeId);
      swallowProjection(removeProjectedFlashcard({ id, mapId, nodeId: prevNodeId }));
    }
  }

  if (next.size > 0) {
    projectedSignaturesByMap.set(mapId, next);
  } else {
    projectedSignaturesByMap.delete(mapId);
  }
}

/**
 * 文档加载完成时建立内存投影基线（零 IPC 调用）：
 * 记录已持久化 `isFlashcard` 节点的签名，使加载后的首次文本微调走原地更新（保留 FSRS 进度），
 * 加载后直接取消勾选或删除节点时能准确触发挂起/移除。
 */
export function seedMindMapProjectedFlashcardsBaseline(
  mapId: string | null,
  root: MindMapNode | null | undefined,
): void {
  if (!mapId || !root) return;
  const baseline = new Map<string, string>();
  for (const card of collectProjectedFlashcards(mapId, root)) {
    baseline.set(card.nodeId, payloadSignature(card));
    enqueuedCardIds.add(card.id);
  }
  if (baseline.size > 0) {
    projectedSignaturesByMap.set(mapId, baseline);
  } else {
    projectedSignaturesByMap.delete(mapId);
  }
}

/** 仅供测试重置内部状态 */
export function __resetMindMapCardProjectionForTests(): void {
  projectionSinks.length = 0;
  projectedSignaturesByMap.clear();
  enqueuedCardIds.clear();
  fsrsStateIdByCardId.clear();
  persistenceByCardId.clear();
}
