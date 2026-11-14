// Rust: src/chat_v2/tools/chatanki_executor.rs 的复习统计输出与 enqueue 事件 payload。
// 类型来自 L15 已发布的 `review@1` api.ts；本模块只做 wire 投影。
import type {
  FsrsEnqueueResult, FsrsEnqueuedCard, FsrsStats,
} from '../../review/api.ts';
import { deserializeSerdeStruct } from './serde-struct.ts';

export interface ChatAnkiReviewStatsArgs {
  // Rust `ChatAnkiReviewStatsArgs {}` + deny_unknown_fields：只接受空对象。
}

export function parseChatAnkiReviewStatsArgs(raw: unknown): ChatAnkiReviewStatsArgs {
  deserializeSerdeStruct(raw, 'ChatAnkiReviewStatsArgs', [], true);
  return {};
}

export function chatankiReviewStatsOutput(stats: FsrsStats): Record<string, unknown> {
  return {
    status: 'ok',
    total: stats.total,
    due: stats.due,
    new: stats.newCount,
    learning: stats.learning,
    review: stats.review,
    relearning: stats.relearning,
    suspended: stats.suspended,
    reviews_today: stats.reviewsToday,
  };
}

function enqueuedCardPayload(card: FsrsEnqueuedCard): Record<string, unknown> {
  return {
    id: card.id,
    ankiCardId: card.ankiCardId,
    front: card.front,
    back: card.back,
    tags: [...card.tags],
    ...(card.text === undefined || card.text === null ? {} : { text: card.text }),
    ...(card.templateId === undefined || card.templateId === null
      ? {} : { templateId: card.templateId }),
    extraFields: { ...card.extraFields },
    images: [...card.images],
    isErrorCard: card.isErrorCard,
    ...(card.errorContent === undefined || card.errorContent === null
      ? {} : { errorContent: card.errorContent }),
  };
}

/** chatanki_executor.rs:13738–13746: APKG import `fsrs://changed` payload. */
export function fsrsImportChangedPayload(
  documentId: string, entityIds: readonly string[], runId: string,
): Record<string, unknown> {
  return {
    source: 'agent',
    action: 'import',
    documentId,
    entityIds: [...entityIds],
    runId,
  };
}

/** chatanki_executor.rs:13748–13755: generic `fsrs://changed` payload. */
export function fsrsCardsChangedPayload(
  action: string, entityIds: readonly string[], runId: string,
): Record<string, unknown> {
  return { source: 'agent', action, entityIds: [...entityIds], runId };
}

/** 没有新入队状态时返回 None；任一 state id 找不到对应卡也返回 None。 */
export function buildEnqueueReviewChangedPayload(
  result: FsrsEnqueueResult,
  loadedCards: readonly FsrsEnqueuedCard[],
  runId: string,
): Record<string, unknown> | null {
  if (result.enqueuedStateIds.length === 0) return null;
  const cardsByStateId = new Map(loadedCards.map((card) => [card.id, card]));
  const cards: FsrsEnqueuedCard[] = [];
  for (const stateId of result.enqueuedStateIds) {
    const card = cardsByStateId.get(stateId);
    if (card === undefined) return null;
    cards.push(card);
  }
  return {
    source: 'agent',
    action: 'enqueue',
    entityIds: cards.map((card) => card.ankiCardId),
    cardStateIds: cards.map((card) => card.id),
    cards: cards.map(enqueuedCardPayload),
    runId,
  };
}
