// Rust: src/chat_v2/tools/chatanki_executor.rs 的库卡投影 / 冲突 payload / 复习事件 payload。
//
// Production list consumes L16's canonical flat record; older nested helper
// fixtures remain accepted. Review snapshots come from the published L15 API.
import type {
  AnkiCard, ChatAnkiLibraryCardRecord, FsrsAgentReviewMutationOutcome, FsrsAgentReviewStateSnapshot,
} from '../api.ts';
import type { AnkiAgentLibraryRecord } from '../../anki/api.ts';
export type {
  FsrsAgentLatestReviewSnapshot, FsrsAgentReviewStateSnapshot,
} from '../api.ts';
import { convertCardForTool } from './executor-args.ts';

export interface AnkiLibraryCard {
  sourceSessionId: string | null;
  sourceRef?: unknown;
  card: AnkiCard;
  sourceType: string | null;
  sourceId: string | null;
  stateId: string | null;
  state: number | null;
  dueMs: number | null;
  suspended: boolean;
  enqueued: boolean;
  isDue: boolean;
}

export interface AnkiLibraryCardLocator {
  documentId: string;
  sourceSessionId: string | null;
}

export interface AnkiLibraryCardRecord {
  libraryCard: AnkiLibraryCard;
  locator: AnkiLibraryCardLocator;
}

/** 库卡投影：在 get_cards 投影上追加 locator/状态字段与 reviewState。 */
export function convertLibraryRecordForTool(
  record: AnkiLibraryCardRecord | AnkiAgentLibraryRecord | ChatAnkiLibraryCardRecord,
  reviewState: FsrsAgentReviewStateSnapshot | null,
): Record<string, unknown> {
  const libraryCard = record.libraryCard;
  const output = convertCardForTool('card' in libraryCard ? libraryCard.card : libraryCard, null);
  output.documentId = record.locator.documentId;
  output.sourceType = record.libraryCard.sourceType;
  output.sourceId = record.libraryCard.sourceId;
  output.enqueued = record.libraryCard.enqueued;
  output.isDue = record.libraryCard.isDue;
  output.reviewState = reviewState;
  output.ratingAvailableToAgent = false;
  return output;
}

export function chatankiVersionConflictPayload(
  documentId: string, current: AnkiCard,
): Record<string, unknown> {
  return {
    status: 'conflict',
    error: 'version_conflict',
    documentId,
    current: convertCardForTool(current, null),
    retryable: true,
  };
}

export function chatankiDeleteReviewConflictPayload(
  documentId: string, current: AnkiCard, reviewState: FsrsAgentReviewStateSnapshot | null,
): Record<string, unknown> {
  const projected = convertCardForTool(current, null);
  projected.reviewState = reviewState;
  return {
    status: 'conflict',
    error: 'review_state_conflict',
    documentId,
    current: projected,
    mutationApplied: false,
    retryable: true,
    guidance: 'Call builtin-chatanki_get_cards to refresh reviewState before retrying.',
  };
}

export function chatankiLibraryVersionConflictPayload(
  current: AnkiLibraryCardRecord,
  reviewState: FsrsAgentReviewStateSnapshot | null,
  error: string,
): Record<string, unknown> {
  return {
    status: 'conflict',
    error,
    cardId: current.libraryCard.card.id,
    current: convertLibraryRecordForTool(current, reviewState),
    mutationApplied: false,
    retryable: true,
    guidance: 'Call builtin-chatanki_list_library_cards to refresh content and review versions before retrying.',
  };
}

/** get_cards：按 id 把 reviewState 挂到投影卡上；未入队的卡显式 null。 */
export function attachReviewStates(
  cards: Array<Record<string, unknown>>,
  reviewStates: readonly FsrsAgentReviewStateSnapshot[],
): void {
  const byCardId = new Map(reviewStates.map((state) => [state.ankiCardId, state]));
  for (const card of cards) {
    const cardId = card.id;
    if (typeof cardId !== 'string') {
      card.reviewState = null;
      continue;
    }
    const state = byCardId.get(cardId) ?? null;
    byCardId.delete(cardId);
    card.reviewState = state;
  }
}

export function chatankiReviewMutationOkPayload(
  cardId: string, state: FsrsAgentReviewStateSnapshot, changed: boolean,
): Record<string, unknown> {
  return {
    status: 'ok',
    cardId,
    changed,
    mutationApplied: changed,
    retryable: false,
    reviewState: state,
  };
}

export function chatankiReviewMutationConflictPayload(
  cardId: string, current: FsrsAgentReviewStateSnapshot,
): Record<string, unknown> {
  return {
    status: 'conflict',
    error: 'review_state_conflict',
    cardId,
    current,
    mutationApplied: false,
    retryable: true,
    guidance: 'Call builtin-chatanki_get_cards to refresh reviewState before retrying.',
  };
}

export function chatankiLibraryReviewMutationConflictPayload(
  cardId: string, current: FsrsAgentReviewStateSnapshot,
): Record<string, unknown> {
  return {
    status: 'conflict',
    error: 'review_state_conflict',
    cardId,
    current,
    mutationApplied: false,
    retryable: true,
    guidance: 'Call builtin-chatanki_list_library_cards to refresh reviewState before retrying.',
  };
}

export function chatankiReviewMutationBlockedPayload(
  cardId: string, reason: string, current: FsrsAgentReviewStateSnapshot,
): Record<string, unknown> {
  return {
    status: 'blocked',
    error: reason,
    cardId,
    current,
    mutationApplied: false,
    retryable: false,
  };
}

/** 只有 `Updated { changed: true }` 才需要发出 fsrs://changed。 */
export function agentReviewChangedState(
  outcome: FsrsAgentReviewMutationOutcome,
): FsrsAgentReviewStateSnapshot | null {
  return outcome.status === 'updated' && outcome.changed ? outcome.state : null;
}

export function buildAgentReviewChangedPayload(
  action: string, state: FsrsAgentReviewStateSnapshot, runId: string,
): Record<string, unknown> {
  return {
    source: 'agent',
    action,
    entityIds: [state.ankiCardId],
    cardStateIds: [state.cardStateId],
    cards: [state],
    runId,
  };
}
