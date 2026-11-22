import { invoke } from '@tauri-apps/api/core';
import type { SemanticAnchor } from '@/ui-kernel/contracts/interop';
import { getMindMapStoreForResource } from '../store/mindmapStore';
import type { MindMapNode } from '../types';
import { findNodeById } from './node/find';
import { dedupeSemanticAnchors } from './nodeAnchors';
import type { ReciteMissCard } from './reciteCards';

export interface ReciteMissCardInput extends ReciteMissCard {
  /** 可选显式传入的节点出处锚点；缺省时从 root 或当前导图 store 自动提取 */
  anchors?: SemanticAnchor[];
}

export interface SaveReciteMissCardsInput {
  cards: ReciteMissCardInput[];
  mindmapId: string | null;
  /** 导图标题（中心主题），用作牌组名与来源标题 */
  title: string;
  deckPrefix: string;
  tag: string;
  /** 可选导图根节点（传入时按 nodeId 提取节点 anchors 与摘录槽锚点） */
  root?: MindMapNode | null;
}

/** 背诵错题闪卡的确定性 ID：`card_mm_recite_${mindmapId}_${nodeId}`，避免跨会话重复建卡 */
export function buildReciteMissFlashcardId(mindmapId: string, nodeId: string): string {
  return `card_mm_recite_${mindmapId}_${nodeId}`;
}

function collectReciteCardAnchors(
  mindmapId: string | null,
  card: ReciteMissCardInput,
  resolvedNode: MindMapNode | null,
): SemanticAnchor[] {
  const incoming: SemanticAnchor[] = [];
  if (card.anchors?.length) {
    incoming.push(...card.anchors);
  }
  if (resolvedNode) {
    if (resolvedNode.anchors?.length) {
      incoming.push(...resolvedNode.anchors);
    }
    for (const slot of resolvedNode.excerpts ?? []) {
      if (slot?.anchor) incoming.push(slot.anchor);
    }
  }
  if (mindmapId) {
    const label = (resolvedNode?.text ?? card.back ?? '').trim().slice(0, 120);
    incoming.push({
      kind: 'mindmap',
      resourceId: mindmapId,
      nodeId: card.nodeId,
      ...(label ? { label } : {}),
    });
  }
  return dedupeSemanticAnchors(undefined, incoming);
}

function resolveDocumentRoot(input: SaveReciteMissCardsInput): MindMapNode | null {
  if (input.root) return input.root;
  if (!input.mindmapId) return null;
  try {
    return getMindMapStoreForResource(input.mindmapId)?.getState().document.root ?? null;
  } catch {
    return null;
  }
}

/**
 * 存成普通问答卡并直接加入 FSRS 复习：
 * - 按 `mindmapId + nodeId` 生成确定性卡片 ID 并按 `nodeId` 去重，避免跨会话重复建卡；
 * - 写入 `SourceMindMapId` / `SourceNodeId` / `AnchorsJson` 溯源字段，支持从闪卡直达原导图节点与原 PDF 页。
 * 返回本次落库/同步的卡片数。
 */
export async function saveReciteMissCards(input: SaveReciteMissCardsInput): Promise<number> {
  if (input.cards.length === 0) return 0;

  // 单次调用内按 nodeId 去重，避免重复提交同一节点错题
  const dedupedCards: ReciteMissCardInput[] = [];
  const seenNodeIds = new Set<string>();
  for (const card of input.cards) {
    if (!card.nodeId || seenNodeIds.has(card.nodeId)) continue;
    seenNodeIds.add(card.nodeId);
    dedupedCards.push(card);
  }
  if (dedupedCards.length === 0) return 0;

  const mindmapId = input.mindmapId?.trim() || null;
  const title = input.title.trim();
  const root = resolveDocumentRoot(input);
  const { ankiApiAdapter } = await import('@/services/ankiApiAdapter');
  const options = {
    deck_name: title ? `${input.deckPrefix}::${title}` : input.deckPrefix,
    note_type: 'Basic',
    enable_images: false,
    max_cards_per_source: dedupedCards.length,
    max_cards_per_mistake: dedupedCards.length,
    ...(mindmapId ? { source_ref: { kind: 'mindmap', id: mindmapId, title } } : {}),
  };

  const response = await ankiApiAdapter.saveAnkiCards({
    ...(mindmapId ? { documentId: mindmapId } : {}),
    cards: dedupedCards.map((card) => {
      const resolvedNode = root ? findNodeById(root, card.nodeId) : null;
      const anchors = collectReciteCardAnchors(mindmapId, card, resolvedNode);
      const deterministicId = mindmapId
        ? buildReciteMissFlashcardId(mindmapId, card.nodeId)
        : undefined;
      return {
        ...(deterministicId ? { id: deterministicId } : {}),
        front: card.front,
        back: card.back,
        tags: Array.from(
          new Set([input.tag, 'mindmap-card', ...(title ? [title] : [])].filter(Boolean)),
        ),
        images: [],
        fields: {
          Front: card.front,
          Back: card.back,
          SourceNodeId: card.nodeId,
          ...(mindmapId ? { SourceMindMapId: mindmapId } : {}),
          ...(anchors.length > 0 ? { AnchorsJson: JSON.stringify(anchors) } : {}),
        },
      };
    }),
    options,
  });

  const savedIds = (response.savedIds ?? []).filter(Boolean);
  const duplicatedIds = (response.duplicatedIds ?? []).filter(Boolean);
  const mappingIds = (response.cardIdMappings ?? [])
    .map((mapping) => mapping.persistedId)
    .filter(Boolean);

  const persistedIds = Array.from(new Set([...savedIds, ...duplicatedIds, ...mappingIds]));
  if (persistedIds.length === 0) {
    throw new Error(response.failed?.[0]?.error || 'save_anki_cards returned no cards');
  }

  // fsrs_enqueue_cards 幂等（已入队卡片原样保留 FSRS 进度），直接传入 persistedIds 防止漏入队
  await invoke('fsrs_enqueue_cards', { ankiCardIds: persistedIds });
  return persistedIds.length;
}
