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
import type { AnkiLibraryCard, AnkiLibraryListResponse } from '@/types';
import type { SemanticAnchor } from '@/ui-kernel/contracts/interop';
import type { MindMapExcerptSlot, MindMapNode } from '../types';
import {
  dedupeSemanticAnchors,
  formatMediaRangeLabel,
  formatMindMapSourcePill,
  safeSerializeAnchor,
} from '../utils/nodeAnchors';
import { isSafeImageSrc } from '../utils/imageSanitize';
import { loadReciteStats, smoothedErrorRate } from '../utils/reciteStats';

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

export type MindMapNodeMasteryStatus = 'due' | 'struggling' | 'learning' | 'mastered';

export interface MindMapNodeMasteryEntry {
  status: MindMapNodeMasteryStatus;
  dueAt?: string;
  lapses?: number;
  cardId: string;
}

export type MindMapMasterySummary = Record<string, MindMapNodeMasteryEntry>;

interface FsrsEnqueueStateItem {
  id: string;
  ankiCardId?: string;
  anki_card_id?: string;
}

interface FsrsEnqueueResponse {
  states?: FsrsEnqueueStateItem[];
}

interface FsrsDueCardRow {
  id?: string;
  cardStateId?: string;
  ankiCardId?: string;
  anki_card_id?: string;
  state?: number;
  stability?: number | null;
  reps?: number;
  lapses?: number;
  dueMs?: number | null;
  suspended?: boolean;
  leech?: boolean;
  extraFields?: Record<string, string>;
  extra_fields?: Record<string, string>;
}

interface FsrsMemoryCardRow {
  cardStateId?: string;
  id?: string;
  ankiCardId?: string;
  anki_card_id?: string;
  state?: number;
  stability?: number | null;
  reps?: number;
  lapses?: number;
  dueMs?: number | null;
  lastRating?: number | null;
  extraFields?: Record<string, string>;
  extra_fields?: Record<string, string>;
}

interface FsrsMemoryOverviewRow {
  recent?: FsrsMemoryCardRow[];
}

const LIBRARY_QUERY_PAGE_SIZE = 200;
const LIBRARY_QUERY_MAX_PAGES = 5;
const RECITE_STRUGGLING_ERROR_RATE = 0.55;
const RECITE_MASTERED_ERROR_RATE = 0.25;
const FSRS_MASTERED_STABILITY_DAYS = 7;

const projectionSinks: MindMapCardProjectionSink[] = [];
/** mapId -> Map<nodeId, signature>（用于对账跳过未变更节点与检测取消投影的节点） */
const projectedSignaturesByMap = new Map<string, Map<string, string>>();
/** 已入队过 FSRS 的确定性卡片 ID（避免每次文本微调重复调 fsrs_enqueue_cards） */
const enqueuedCardIds = new Set<string>();
/** ankiCardId -> fsrs_card_states.id（用于取消投影时挂起卡片而不销毁复习历史） */
const fsrsStateIdByCardId = new Map<string, string>();
const persistenceByCardId = new Map<string, Promise<void>>();
/** mapId -> 正在进行的 FSRS stateId 预热 Promise，供取消投影共享等待 */
const warmupByMapId = new Map<string, Promise<void>>();

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

function extractNodeIdForMindMap(
  cardId: string,
  mapId: string,
  extraFields?: Record<string, string> | null,
): string | null {
  const projectedPrefix = `card_mm_${mapId}_`;
  if (cardId.startsWith(projectedPrefix) && cardId.length > projectedPrefix.length) {
    return cardId.slice(projectedPrefix.length);
  }
  const recitePrefix = `card_mm_recite_${mapId}_`;
  if (cardId.startsWith(recitePrefix) && cardId.length > recitePrefix.length) {
    return cardId.slice(recitePrefix.length);
  }
  if (extraFields) {
    const sourceMapId = extraFields.SourceMindMapId?.trim();
    const sourceNodeId = extraFields.SourceNodeId?.trim();
    if (sourceMapId === mapId && sourceNodeId) {
      return sourceNodeId;
    }
  }
  return null;
}

function cacheFsrsStateId(cardId: string | undefined, stateId: string | null | undefined): void {
  const cleanCardId = cardId?.trim();
  const cleanStateId = stateId?.trim();
  if (!cleanCardId || !cleanStateId) return;
  fsrsStateIdByCardId.set(cleanCardId, cleanStateId);
  enqueuedCardIds.add(cleanCardId);
}

async function queryMindMapLibraryCards(
  mapId: string,
  targetCardIds?: ReadonlySet<string>,
): Promise<{ ok: boolean; complete: boolean; cards: AnkiLibraryCard[] }> {
  const cards: AnkiLibraryCard[] = [];
  const seenIds = new Set<string>();
  let complete = false;
  try {
    for (let page = 1; page <= LIBRARY_QUERY_MAX_PAGES; page += 1) {
      const response = await invoke<AnkiLibraryListResponse | null>('list_anki_library_cards', {
        request: {
          search: 'mindmap-card',
          page,
          pageSize: LIBRARY_QUERY_PAGE_SIZE,
        },
      });
      if (!response || !Array.isArray(response.items)) {
        return { ok: false, complete: false, cards };
      }
      for (const item of response.items) {
        if (!item || typeof item.id !== 'string' || seenIds.has(item.id)) continue;
        seenIds.add(item.id);
        const matchesMap =
          item.documentId === mapId ||
          item.sourceId === mapId ||
          item.sourceRef?.id === mapId ||
          extractNodeIdForMindMap(item.id, mapId, item.extra_fields ?? item.fields) !== null ||
          Boolean(targetCardIds?.has(item.id));
        if (matchesMap) {
          cacheFsrsStateId(item.id, item.stateId);
          cards.push(item);
        }
      }
      const foundAllTargets =
        targetCardIds !== undefined &&
        targetCardIds.size > 0 &&
        Array.from(targetCardIds).every((id) => seenIds.has(id));
      const reachedEnd =
        response.items.length < LIBRARY_QUERY_PAGE_SIZE ||
        (typeof response.total === 'number' && page * LIBRARY_QUERY_PAGE_SIZE >= response.total);
      if (foundAllTargets || reachedEnd) {
        complete = true;
        break;
      }
    }
    return { ok: true, complete, cards };
  } catch {
    return { ok: false, complete: false, cards };
  }
}

async function lookupFsrsStateIdFromReviewCommands(cardId: string): Promise<string | null> {
  const [dueRows, overview] = await Promise.all([
    invoke<FsrsDueCardRow[] | null>('fsrs_get_due', { limit: 500, readOnly: true }).catch(() => null),
    invoke<FsrsMemoryOverviewRow | null>('fsrs_get_memory_overview', { recentLimit: 200 }).catch(() => null),
  ]);
  if (Array.isArray(dueRows)) {
    for (const row of dueRows) {
      const ankiCardId = row?.ankiCardId ?? row?.anki_card_id;
      const stateId = row?.id ?? row?.cardStateId;
      cacheFsrsStateId(ankiCardId, stateId);
    }
  }
  if (overview && Array.isArray(overview.recent)) {
    for (const row of overview.recent) {
      const ankiCardId = row?.ankiCardId ?? row?.anki_card_id;
      const stateId = row?.cardStateId ?? row?.id;
      cacheFsrsStateId(ankiCardId, stateId);
    }
  }
  return fsrsStateIdByCardId.get(cardId) ?? null;
}

/**
 * 异步预热指定导图的 FSRS `stateId` 缓存，防止重启后内存表为空导致取消投影无法直接挂起。
 */
export async function hydrateMindMapProjectedFlashcardStates(
  mapId: string,
  cardIds?: readonly string[],
): Promise<void> {
  const cleanMapId = mapId.trim();
  if (!cleanMapId) return;
  const targetSet = cardIds && cardIds.length > 0 ? new Set(cardIds) : undefined;
  const run = async () => {
    await queryMindMapLibraryCards(cleanMapId, targetSet);
  };
  const promise = run();
  warmupByMapId.set(cleanMapId, promise);
  try {
    await promise;
  } finally {
    if (warmupByMapId.get(cleanMapId) === promise) {
      warmupByMapId.delete(cleanMapId);
    }
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
  let existingFsrsStateId = fsrsStateIdByCardId.get(persistedId);
  if (!existingFsrsStateId && isInitialInsert && !wasNewlyInserted) {
    const inflightWarmup = warmupByMapId.get(payload.mapId);
    if (inflightWarmup) {
      await inflightWarmup.catch(() => undefined);
      existingFsrsStateId = fsrsStateIdByCardId.get(persistedId);
    }
    if (!existingFsrsStateId) {
      await queryMindMapLibraryCards(payload.mapId, new Set([persistedId]));
      existingFsrsStateId = fsrsStateIdByCardId.get(persistedId);
    }
  }

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

async function resolveCardRemovalDecision(params: {
  id: string;
  mapId: string;
  nodeId: string;
}): Promise<{ action: 'suspend'; stateId: string } | { action: 'delete' } | { action: 'keep' }> {
  const cachedStateId = fsrsStateIdByCardId.get(params.id);
  if (cachedStateId) {
    return { action: 'suspend', stateId: cachedStateId };
  }

  const inflightWarmup = warmupByMapId.get(params.mapId);
  if (inflightWarmup) {
    await inflightWarmup.catch(() => undefined);
    const warmedStateId = fsrsStateIdByCardId.get(params.id);
    if (warmedStateId) {
      return { action: 'suspend', stateId: warmedStateId };
    }
  }

  const libraryResult = await queryMindMapLibraryCards(params.mapId, new Set([params.id]));
  const hydratedStateId = fsrsStateIdByCardId.get(params.id);
  if (hydratedStateId) {
    return { action: 'suspend', stateId: hydratedStateId };
  }

  const matchedCard = libraryResult.cards.find((card) => card.id === params.id);
  if (matchedCard) {
    const hasReviewHistory =
      Boolean(matchedCard.stateId) ||
      matchedCard.enqueued === true ||
      matchedCard.suspended === true ||
      Boolean(matchedCard.latestReview) ||
      (typeof matchedCard.state === 'number' && matchedCard.state > 0);
    return hasReviewHistory ? { action: 'keep' } : { action: 'delete' };
  }

  const fallbackStateId = await lookupFsrsStateIdFromReviewCommands(params.id);
  if (fallbackStateId) {
    return { action: 'suspend', stateId: fallbackStateId };
  }

  // 仅当 matchedCard 明确被查到且确认无任何 FSRS 状态与复习记录时才允许删除；
  // 未查到目标卡（可能因 >1000 卡分页截断、用户移除标签或后端不可达）时一律保守 keep，绝不物理误删。
  return { action: 'keep' };
}

async function defaultPersistRemove(params: {
  id: string;
  mapId: string;
  nodeId: string;
}): Promise<void> {
  const decision = await resolveCardRemovalDecision(params);
  if (decision.action === 'suspend') {
    await invoke('fsrs_suspend_card', { cardStateId: decision.stateId }).catch(() => undefined);
    return;
  }
  if (decision.action === 'keep') {
    console.warn('[MindMapCardProjection::remove] kept card to avoid losing unverified FSRS history:', params.id);
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
 * 文档加载完成时建立内存投影基线，并异步预热后端 FSRS `stateId` 映射：
 * 记录已持久化 `isFlashcard` 节点的签名，使加载后的首次文本微调走原地更新（保留 FSRS 进度），
 * 加载后直接取消勾选或删除节点时能准确挂起 FSRS 而不误删历史复习曲线。
 */
export function seedMindMapProjectedFlashcardsBaseline(
  mapId: string | null,
  root: MindMapNode | null | undefined,
): void {
  if (!mapId || !root) return;
  const baseline = new Map<string, string>();
  const cardIds: string[] = [];
  for (const card of collectProjectedFlashcards(mapId, root)) {
    baseline.set(card.nodeId, payloadSignature(card));
    enqueuedCardIds.add(card.id);
    cardIds.push(card.id);
  }
  if (baseline.size > 0) {
    projectedSignaturesByMap.set(mapId, baseline);
    if (projectionSinks.length === 0) {
      swallowProjection(hydrateMindMapProjectedFlashcardStates(mapId, cardIds));
    }
  } else {
    projectedSignaturesByMap.delete(mapId);
  }
}

interface AggregatedFsrsSignal {
  cardId: string;
  state?: number | null;
  stability?: number | null;
  reps?: number;
  lapses?: number;
  dueMs?: number | null;
  isDue?: boolean;
  suspended?: boolean;
  leech?: boolean;
  lastRating?: number | null;
}

interface ReciteNodeSignal {
  attempts: number;
  misses: number;
  maxErrorRate: number;
}

const MASTERY_SEVERITY: Record<MindMapNodeMasteryStatus, number> = {
  struggling: 3,
  due: 2,
  learning: 1,
  mastered: 0,
};

function summarizeReciteStatsByNode(mindmapId: string): Map<string, ReciteNodeSignal> {
  const result = new Map<string, ReciteNodeSignal>();
  const stats = loadReciteStats(mindmapId);
  for (const [nodeId, byBlank] of Object.entries(stats)) {
    if (!byBlank || typeof byBlank !== 'object') continue;
    let attempts = 0;
    let misses = 0;
    let maxErrorRate = 0;
    for (const stat of Object.values(byBlank)) {
      if (!stat || typeof stat.attempts !== 'number' || stat.attempts <= 0) continue;
      attempts += stat.attempts;
      misses += typeof stat.misses === 'number' && stat.misses > 0 ? stat.misses : 0;
      const rate = smoothedErrorRate(stat);
      if (rate > maxErrorRate) maxErrorRate = rate;
    }
    if (attempts > 0) {
      result.set(nodeId, { attempts, misses, maxErrorRate });
    }
  }
  return result;
}

function classifyFsrsAndReciteStatus(
  fsrs: AggregatedFsrsSignal,
  recite: ReciteNodeSignal | undefined,
  nowMs: number,
): MindMapNodeMasteryStatus {
  const lapses = fsrs.lapses ?? 0;
  const reciteStruggling = Boolean(recite && recite.maxErrorRate >= RECITE_STRUGGLING_ERROR_RATE);
  if (
    fsrs.leech === true ||
    lapses >= 2 ||
    fsrs.state === 3 ||
    fsrs.lastRating === 1 ||
    reciteStruggling
  ) {
    return 'struggling';
  }
  const dueByClock =
    typeof fsrs.dueMs === 'number' &&
    Number.isFinite(fsrs.dueMs) &&
    fsrs.dueMs <= nowMs &&
    fsrs.state !== 0;
  if ((fsrs.isDue === true && fsrs.state !== 0) || dueByClock) {
    return 'due';
  }
  const stableEnough =
    fsrs.stability == null
      ? typeof fsrs.dueMs === 'number' &&
        Number.isFinite(fsrs.dueMs) &&
        fsrs.dueMs - nowMs >= FSRS_MASTERED_STABILITY_DAYS * 86_400_000 &&
        lapses === 0
      : fsrs.stability >= FSRS_MASTERED_STABILITY_DAYS;
  if (fsrs.state === 2 && stableEnough && lapses === 0) {
    return 'mastered';
  }
  return 'learning';
}

function mergeSignal(
  existing: AggregatedFsrsSignal | undefined,
  incoming: AggregatedFsrsSignal,
): AggregatedFsrsSignal {
  if (!existing) return incoming;
  return {
    cardId: existing.cardId,
    state: incoming.state ?? existing.state,
    stability: incoming.stability ?? existing.stability,
    reps: incoming.reps ?? existing.reps,
    lapses: incoming.lapses ?? existing.lapses,
    dueMs: incoming.dueMs ?? existing.dueMs,
    isDue: existing.isDue || incoming.isDue,
    suspended: incoming.suspended ?? existing.suspended,
    leech: existing.leech || incoming.leech,
    lastRating: incoming.lastRating ?? existing.lastRating,
  };
}

/**
 * 汇总整张导图各节点的掌握度（融合后端 FSRS 卡片状态与本地背诵错误率）。
 * 返回按 `nodeId` 映射的掌握度摘要；无后端或异常时安全降级为空对象，绝不抛错。
 */
export async function loadMindMapMasterySummary(
  mindmapId: string,
): Promise<MindMapMasterySummary> {
  const cleanMapId = mindmapId?.trim();
  if (!cleanMapId) return {};

  try {
    const nowMs = Date.now();
    const reciteByNode = summarizeReciteStatsByNode(cleanMapId);

    const [libraryResult, dueRows, overview] = await Promise.all([
      queryMindMapLibraryCards(cleanMapId).catch(() => ({
        ok: false,
        complete: false,
        cards: [] as AnkiLibraryCard[],
      })),
      invoke<FsrsDueCardRow[] | null>('fsrs_get_due', { limit: 500, readOnly: true }).catch(() => null),
      invoke<FsrsMemoryOverviewRow | null>('fsrs_get_memory_overview', { recentLimit: 200 }).catch(() => null),
    ]);

    const signalsByCardId = new Map<string, { nodeId: string; signal: AggregatedFsrsSignal }>();

    const upsertSignal = (
      cardId: string | undefined,
      extraFields: Record<string, string> | undefined | null,
      signal: Omit<AggregatedFsrsSignal, 'cardId'>,
    ) => {
      if (!cardId) return;
      const nodeId = extractNodeIdForMindMap(cardId, cleanMapId, extraFields);
      if (!nodeId) return;
      const prev = signalsByCardId.get(cardId);
      signalsByCardId.set(cardId, {
        nodeId,
        signal: mergeSignal(prev?.signal, { cardId, ...signal }),
      });
    };

    for (const card of libraryResult.cards) {
      if (!card.enqueued && !card.stateId) continue;
      upsertSignal(card.id, card.extra_fields ?? card.fields, {
        state: card.state,
        dueMs: card.dueMs,
        isDue: card.isDue,
        suspended: card.suspended,
        lastRating: card.latestReview?.rating ?? null,
      });
    }

    if (Array.isArray(dueRows)) {
      for (const row of dueRows) {
        const cardId = row?.ankiCardId ?? row?.anki_card_id;
        cacheFsrsStateId(cardId, row?.id ?? row?.cardStateId);
        upsertSignal(cardId, row?.extraFields ?? row?.extra_fields, {
          state: row?.state,
          stability: row?.stability,
          reps: row?.reps,
          lapses: row?.lapses,
          dueMs: row?.dueMs,
          isDue: row?.suspended !== true && row?.state !== 0,
          suspended: row?.suspended,
          leech: row?.leech,
        });
      }
    }

    if (overview && Array.isArray(overview.recent)) {
      for (const row of overview.recent) {
        const cardId = row?.ankiCardId ?? row?.anki_card_id;
        cacheFsrsStateId(cardId, row?.cardStateId ?? row?.id);
        upsertSignal(cardId, row?.extraFields ?? row?.extra_fields, {
          state: row?.state,
          stability: row?.stability,
          reps: row?.reps,
          lapses: row?.lapses,
          dueMs: row?.dueMs,
          lastRating: row?.lastRating,
        });
      }
    }

    const summary: MindMapMasterySummary = {};

    for (const { nodeId, signal } of signalsByCardId.values()) {
      if (signal.suspended === true) continue;
      const recite = reciteByNode.get(nodeId);
      const status = classifyFsrsAndReciteStatus(signal, recite, nowMs);
      const dueAt =
        typeof signal.dueMs === 'number' && Number.isFinite(signal.dueMs) && signal.dueMs > 0
          ? new Date(signal.dueMs).toISOString()
          : undefined;
      const lapses =
        typeof signal.lapses === 'number' && Number.isFinite(signal.lapses)
          ? signal.lapses
          : recite && recite.misses > 0
            ? recite.misses
            : undefined;
      const entry: MindMapNodeMasteryEntry = {
        status,
        ...(dueAt ? { dueAt } : {}),
        ...(lapses !== undefined ? { lapses } : {}),
        cardId: signal.cardId,
      };
      const existing = summary[nodeId];
      if (
        !existing ||
        MASTERY_SEVERITY[entry.status] > MASTERY_SEVERITY[existing.status]
      ) {
        summary[nodeId] = entry;
      }
    }

    for (const [nodeId, recite] of reciteByNode.entries()) {
      if (summary[nodeId]) continue;
      let status: MindMapNodeMasteryStatus = 'learning';
      if (recite.maxErrorRate >= RECITE_STRUGGLING_ERROR_RATE) {
        status = 'struggling';
      } else if (recite.attempts >= 2 && recite.maxErrorRate <= RECITE_MASTERED_ERROR_RATE) {
        status = 'mastered';
      }
      summary[nodeId] = {
        status,
        ...(recite.misses > 0 ? { lapses: recite.misses } : {}),
        cardId: buildMindMapFlashcardId(cleanMapId, nodeId),
      };
    }

    return summary;
  } catch {
    return {};
  }
}

/** 仅供测试重置内部状态 */
export function __resetMindMapCardProjectionForTests(): void {
  projectionSinks.length = 0;
  projectedSignaturesByMap.clear();
  enqueuedCardIds.clear();
  fsrsStateIdByCardId.clear();
  persistenceByCardId.clear();
  warmupByMapId.clear();
}
