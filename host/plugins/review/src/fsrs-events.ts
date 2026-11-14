/**
 * `fsrs://changed` 事件载荷（Rust `cmd/fsrs_review.rs` 与
 * `fsrs_review_service::build_fsrs_enqueue_changed_payload` 的镜像）。
 *
 * 写操作没有实际写入（changed=false）时返回 null，调用方不 emit。
 */
import type { FsrsEnqueuedCard, FsrsEnqueueResult } from './fsrs-types.ts';

export interface FsrsChangedCardRef {
  id: string;
  ankiCardId: string;
  logId?: string;
}

export interface FsrsChangedPayload {
  source: string;
  action: string;
  entityIds: string[];
  cardStateIds: string[];
  cards: Array<FsrsChangedCardRef | FsrsEnqueuedCard>;
}

/**
 * `build_fsrs_changed_payload_after_write_with_logs`：卡片为空时用
 * `fallbackEntityIds` 作为 entityIds（入队未产生 state 时回退到请求的 anki 卡）。
 */
export function buildFsrsChangedPayloadAfterWrite(
  didWrite: boolean,
  source: string,
  action: string,
  cards: ReadonlyArray<readonly [stateId: string, ankiCardId: string]>,
  fallbackEntityIds: readonly string[] = [],
  logIds: ReadonlyArray<string | null | undefined> = [],
): FsrsChangedPayload | null {
  if (!didWrite) return null;
  const entityIds = cards.length === 0
    ? [...fallbackEntityIds]
    : cards.map(([, ankiCardId]) => ankiCardId);
  const cardStateIds = cards.map(([stateId]) => stateId);
  const payloadCards: FsrsChangedCardRef[] = cards.map(([stateId, ankiCardId], index) => {
    const card: FsrsChangedCardRef = { id: stateId, ankiCardId };
    const logId = logIds[index];
    if (logId !== null && logId !== undefined) card.logId = logId;
    return card;
  });
  return { source, action, entityIds, cardStateIds, cards: payloadCards };
}

/**
 * 入队事件只包含**本次新增**的 state（跳过已存在的卡），卡片携带完整内容。
 * 任一新增 state 缺少卡片内容时返回 null（Rust 的 `collect::<Option<Vec<_>>>`）。
 */
export function buildFsrsEnqueueChangedPayload(
  result: FsrsEnqueueResult,
  loadedCards: readonly FsrsEnqueuedCard[],
  source: string,
): FsrsChangedPayload | null {
  if (result.enqueuedStateIds.length === 0) return null;
  const byStateId = new Map(loadedCards.map(card => [card.id, card]));
  const cards: FsrsEnqueuedCard[] = [];
  for (const stateId of result.enqueuedStateIds) {
    const card = byStateId.get(stateId);
    if (card === undefined) return null;
    cards.push(card);
  }
  return {
    source,
    action: 'enqueue',
    entityIds: cards.map(card => card.ankiCardId),
    cardStateIds: cards.map(card => card.id),
    cards,
  };
}
