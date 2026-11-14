/**
 * FSRS 入队（拆分自 `review.ts`）。
 *
 * 内部 / 会话 / 资料库三种 scope 的校验、事务与去重逐条对应 Rust
 * `enqueue_cards_inner`；资料库 scope 的缺失、诊断卡与内容版本冲突保持
 * `FsrsLibraryEnqueueOutcome` 分支，不合并成异常。
 */
import { rustTrim } from '../../../platform/util/portable.ts';
import { utcNow } from './clock.ts';
import { appError } from './errors.ts';
import {
  DEFAULT_DECK_ID,
  type FsrsCardState, type FsrsEnqueuedCard, type FsrsEnqueueResult,
  type FsrsLibraryEnqueueCard, type FsrsLibraryEnqueueOutcome,
} from './fsrs-types.ts';
import { normalizeIds } from './review-input.ts';
import { diagnosticError } from './review-scheduling.ts';
import type { ReviewRuntime } from './review-runtime.ts';
import * as repo from '../repository/fsrs.ts';

export function enqueueCards(rt: ReviewRuntime, ankiCardIds: readonly string[]): FsrsEnqueueResult {
  const result = expectPlainEnqueue(enqueueCardsInner(rt, ankiCardIds, { kind: 'internal' }));
  rt.info(`[FsrsReviewService] enqueue: enqueued=${result.enqueued}, skipped=${result.skipped}`);
  return result;
}

export function enqueueCardsForSession(
  rt: ReviewRuntime,
  ankiCardIds: readonly string[],
  sessionId: string,
  expectedDocumentId: string | null,
): FsrsEnqueueResult {
  let normalized: string[];
  if (expectedDocumentId !== null) {
    normalized = [];
  } else {
    normalized = normalizeIds(ankiCardIds, 'cardIds', 100);
  }
  const result = expectPlainEnqueue(enqueueCardsInner(rt, normalized, {
    kind: 'session', sessionId, expectedDocumentId,
  }));
  rt.info(`[FsrsReviewService] enqueue: enqueued=${result.enqueued}, skipped=${result.skipped}`);
  return result;
}

export function enqueueCardsForLibrary(
  rt: ReviewRuntime,
  _scope: string,
  cards: readonly FsrsLibraryEnqueueCard[],
): FsrsLibraryEnqueueOutcome {
  if (cards.length === 0 || cards.length > 100) {
    throw appError('Validation', 'cards must contain between 1 and 100 entries');
  }
  const expectedVersions = new Map<string, string>();
  const cardIds: string[] = [];
  for (const card of cards) {
    const cardId = rustTrim(card.cardId);
    const expectedVersion = rustTrim(card.expectedContentVersion);
    if (cardId.length === 0 || expectedVersion.length === 0) {
      throw appError('Validation', 'cards must contain non-empty cardId and expectedVersion values');
    }
    if (expectedVersions.has(cardId)) throw appError('Validation', 'cards must not contain duplicate IDs');
    expectedVersions.set(cardId, expectedVersion);
    cardIds.push(cardId);
  }
  const outcome = enqueueCardsInner(rt, cardIds, { kind: 'library', expectedVersions });
  if (outcome.status === 'enqueued') {
    rt.info(`[FsrsReviewService] enqueue: enqueued=${outcome.result.enqueued}, skipped=${outcome.result.skipped}`);
  }
  return outcome;
}

function expectPlainEnqueue(outcome: FsrsLibraryEnqueueOutcome): FsrsEnqueueResult {
  if (outcome.status === 'enqueued') return outcome.result;
  throw appError('Database', `unexpected scoped enqueue outcome: ${JSON.stringify(outcome)}`);
}

function enqueueCardsInner(
  rt: ReviewRuntime,
  ankiCardIds: readonly string[],
  scope:
    | { kind: 'internal' }
    | { kind: 'session'; sessionId: string; expectedDocumentId: string | null }
    | { kind: 'library'; expectedVersions: Map<string, string> },
): FsrsLibraryEnqueueOutcome {
  if (ankiCardIds.length === 0 && !(scope.kind === 'session' && scope.expectedDocumentId !== null)) {
    return {
      status: 'enqueued',
      result: { enqueued: 0, skipped: 0, enqueuedStateIds: [], states: [], reviewCards: [] },
    };
  }
  const now = utcNow();
  const nowMs = now.ms;

  return rt.tx('immediate', tx => {
    const schedulerConfig = repo.loadSchedulerConfig(tx, DEFAULT_DECK_ID, rt.warn);
    let ids: readonly string[] = ankiCardIds;
    if (scope.kind === 'session' && scope.expectedDocumentId !== null) {
      const documentId = scope.expectedDocumentId;
      const sessionId = scope.sessionId;
      if (!repo.documentOwnedBySession(tx, documentId, sessionId)) {
        throw appError('NotFound', 'blocks.ankiCards.errors.statusNotFound');
      }
      ids = repo.documentLiveCardIds(tx, documentId, sessionId);
    }

    const validatedDocuments = new Set<string>();
    const libraryMissing: string[] = [];
    const libraryDiagnostic: string[] = [];
    const libraryConflicts: { cardId: string; expectedVersion: string; currentVersion: string }[] = [];
    for (const rawId of ids) {
      const cardId = rustTrim(rawId);
      if (cardId.length === 0) throw appError('Validation', 'cardIds must not contain empty IDs');
      const selection = repo.loadCardSelection(tx, cardId);
      if (selection === null) {
        if (scope.kind === 'library') {
          libraryMissing.push(cardId);
          continue;
        }
        throw appError('NotFound', 'blocks.ankiCards.errors.statusNotFound');
      }
      if (scope.kind === 'session') {
        if (selection.sourceSessionId !== scope.sessionId
          || (scope.expectedDocumentId !== null && scope.expectedDocumentId !== selection.documentId)) {
          throw appError('NotFound', 'blocks.ankiCards.errors.statusNotFound');
        }
        if (!validatedDocuments.has(selection.documentId)) {
          validatedDocuments.add(selection.documentId);
          if (!repo.documentOwnedBySession(tx, selection.documentId, scope.sessionId)) {
            throw appError('NotFound', 'blocks.ankiCards.errors.statusNotFound');
          }
        }
      } else if (scope.kind === 'library') {
        const expectedVersion = scope.expectedVersions.get(cardId)!;
        if (expectedVersion !== selection.currentVersion) {
          libraryConflicts.push({
            cardId, expectedVersion, currentVersion: selection.currentVersion,
          });
        }
      }
      if (selection.isErrorCard) {
        if (scope.kind === 'library') libraryDiagnostic.push(cardId);
        else throw diagnosticError(cardId);
      }
    }

    if (libraryMissing.length > 0) return { status: 'not_found', cardIds: libraryMissing };
    if (libraryDiagnostic.length > 0) {
      return { status: 'blocked', reason: 'diagnostic_card', cardIds: libraryDiagnostic };
    }
    if (libraryConflicts.length > 0) return { status: 'conflict', conflicts: libraryConflicts };

    repo.ensureDefaultDeck(tx, now.rfc);
    let enqueued = 0;
    let skipped = 0;
    const enqueuedStateIds: string[] = [];
    const states: FsrsCardState[] = [];
    for (const rawId of ids) {
      if (rustTrim(rawId).length === 0) {
        skipped += 1;
        continue;
      }
      const inserted = repo.insertStateInTx(
        tx, rawId, null, schedulerConfig.desiredRetention, nowMs, now.rfc,
      );
      if (inserted.kind === 'already_live') {
        skipped += 1;
        const state = repo.loadStateByAnkiCard(tx, rawId);
        if (state !== null) states.push(state);
      } else {
        enqueued += 1;
        enqueuedStateIds.push(inserted.id);
        const state = repo.loadStateById(tx, inserted.id);
        if (state !== null) states.push(state);
      }
    }
    const reviewCards = repo.loadReviewCardsForStates(tx, states);
    return {
      status: 'enqueued',
      result: { enqueued, skipped, enqueuedStateIds, states, reviewCards },
    };
  });
}

export function getEnqueuedCards(result: FsrsEnqueueResult): FsrsEnqueuedCard[] {
  if (result.enqueuedStateIds.length === 0) return [];
  const byState = new Map(result.reviewCards.map(card => [card.id, card]));
  return result.enqueuedStateIds.map(stateId => {
    const card = byState.get(stateId);
    if (card === undefined) {
      throw appError('Database', `enqueue result is missing newly inserted review card: ${stateId}`);
    }
    return card;
  });
}
