/**
 * FSRS 复习服务（Rust `dstu-anki/src/fsrs_review_service.rs` 的 TypeScript 迁移）。
 *
 * 调度状态与复习日志在 mistakes 库；记忆模型与 Anki 调度规则见 `fsrs-scheduler.ts`。
 * 本文件保留服务门面、到期读取、评分/Agent scope 编排与调度配置：
 * - 入队：`review-enqueue.ts`
 * - 调度结果与掌握度偏置：`review-scheduling.ts`
 * - 配置校验：`review-config.ts`
 * - 统计与记忆曲线：`review-statistics.ts`
 * - 进度重置与记忆状态重算：`review-memory.ts`
 */
import type { DatabaseHandle, SqlExecutor, SyncTransaction } from '../../../platform/storage/api.ts';
import { scheduleFsrs7, fsrs7Curve, fsrs7Recall } from './fsrs7.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import { appError } from './errors.ts';
import { masteryDueBiasDeltaMs, queueSortKey, MIN_BIASABLE_INTERVAL_MS } from './bias.ts';
import { logicalDayBoundsMs } from './fsrs-scheduler.ts';
import {
  DEFAULT_DECK_ID, MS_PER_DAY, decodeStateBeforeSnapshot, encodeStateBeforeSnapshot, stateBeforeSnapshot, validateSnapshotFor,
  type FsrsAgentReviewMutationOutcome, type FsrsAgentReviewStateSnapshot,
  type FsrsBuryResult, type FsrsCardMemoryHistory, type FsrsCardState,
  type FsrsDueCard, type FsrsEnqueuedCard, type FsrsEnqueueResult,
  type FsrsFeedbackRow, type FsrsImportEnqueueSummary, type FsrsImportedCard,
  type FsrsLibraryEnqueueCard, type FsrsLibraryEnqueueOutcome,
  type FsrsMemoryOverview, type FsrsOptimizeResult, type FsrsPendingMasteryReview,
  type FsrsPreviewResult, type FsrsRateResult, type FsrsResetResult,
  type FsrsReviewStatistics, type FsrsSchedulerConfig, type FsrsSchedulerConfigUpdate,
  type FsrsStats, type FsrsSuspendResult, type FsrsUndoResult,
} from './fsrs-types.ts';
import { rfcNanosAfter, utcNow } from './clock.ts';
import {
  applyMasteryBiasToOutcome, diagnosticError, interleaveNewCards, scheduleAllRatings, type RatingScheduler,
} from './review-scheduling.ts';
import { validateSchedulerConfigUpdate } from './review-config.ts';
import {
  getCardMemoryHistory, getMemoryOverview, getReviewStatistics,
} from './review-statistics.ts';
import {
  ensureMemoryStatesCurrent, optimizeParameters, recomputeMemoryStates, resetCardProgress,
} from './review-memory.ts';
import { normalizeIds, parseClientOpId } from './review-input.ts';
import {
  enqueueCards, enqueueCardsForLibrary, enqueueCardsForSession,
  getEnqueuedCards as getEnqueuedCardsFromResult,
} from './review-enqueue.ts';
import { ReviewRuntime } from './review-runtime.ts';
import { f32Json, type FsrsTrainer } from './fsrs-trainer.ts';
import { f64Json, readConfigObjectExact, swapRemove } from './config-json.ts';
import * as repo from '../repository/fsrs.ts';

export {
  applyMasteryBiasToOutcome, scheduleReviewOutcome,
  type ScheduleOutcome,
} from './review-scheduling.ts';

export type FsrsAgentMutationScope =
  | { kind: 'session'; sessionId: string }
  | { kind: 'library'; scope: string };

export interface SprintRatingOptions {
  operationId: string;
  desiredRetention: number;
  compressInterval: (scheduledDays: number, stability: number, fsrsParams: readonly number[]) => number;
}

/** Rust takes `expected_review_version: i64` and rejects negatives; JS callers can also pass NaN or fractions. */
function i64Version(value: number | bigint): bigint | null {
  if (typeof value !== 'bigint' && (typeof value !== 'number' || !Number.isInteger(value))) return null;
  const exact = BigInt(value);
  return exact >= 0n && exact <= 9223372036854775807n ? exact : null;
}

export class FsrsReviewService {
  private readonly db: DatabaseHandle;
  private readonly warn: (message: string) => void;
  private readonly info: (message: string) => void;
  private readonly debug: (message: string) => void;
  private readonly scheduleRatings: RatingScheduler;
  private readonly trialV7: boolean;

  constructor(
    db: DatabaseHandle,
    warn: (message: string) => void = () => undefined,
    info: (message: string) => void = () => undefined,
    debug: (message: string) => void = () => undefined,
    trialV7 = false,
  ) {
    this.db = db;
    this.warn = warn;
    this.info = info;
    this.debug = debug;
    this.trialV7 = trialV7;
    this.scheduleRatings = trialV7 ? scheduleFsrs7 : (_db, before, nowMs, config) => scheduleAllRatings(before, nowMs, config);
    this.rt = new ReviewRuntime(db, warn, info, debug);
  }

  private readonly rt: ReviewRuntime;

  private tx<T>(behavior: 'immediate' | 'deferred', fn: (tx: SyncTransaction) => T): T {
    return this.rt.tx(behavior, fn);
  }

  // ---------------------------------------------------------------- enqueue

  enqueueCards(ankiCardIds: readonly string[]): FsrsEnqueueResult {
    return enqueueCards(this.rt, ankiCardIds);
  }

  enqueueCardsForSession(
    ankiCardIds: readonly string[],
    sessionId: string,
    expectedDocumentId: string | null,
  ): FsrsEnqueueResult {
    return enqueueCardsForSession(this.rt, ankiCardIds, sessionId, expectedDocumentId);
  }

  enqueueCardsForLibrary(
    scope: string,
    cards: readonly FsrsLibraryEnqueueCard[],
  ): FsrsLibraryEnqueueOutcome {
    return enqueueCardsForLibrary(this.rt, scope, cards);
  }

  getEnqueuedCards(result: FsrsEnqueueResult): FsrsEnqueuedCard[] {
    return getEnqueuedCardsFromResult(result);
  }

  // ---------------------------------------------------------------- reads

  getDue(limit: number | null): FsrsDueCard[] {
    return this.getDueInner(limit, null);
  }

  getDueWithMasteryPriority(limit: number | null, conceptScores: ReadonlyMap<string, number>): FsrsDueCard[] {
    return this.getDueInner(limit, conceptScores);
  }

  private getDueInner(
    limitInput: number | null | undefined,
    conceptScores: ReadonlyMap<string, number> | null,
  ): FsrsDueCard[] {
    const limit = Math.min(500, Math.max(0, (limitInput ?? 50) >>> 0));
    const fetchLimit = conceptScores === null ? limit : Math.min(500, limit * 3);
    const nowMs = utcNow().ms;
    const config = repo.loadSchedulerConfig(this.db, DEFAULT_DECK_ID, this.warn);
    const [dayStartMs, nextDayStartMs] = logicalDayBoundsMs(nowMs, config.dayRolloverHour);
    const counters = repo.dailyCounters(this.db, dayStartMs, nextDayStartMs);
    const newRemaining = Math.min(fetchLimit, Math.max(0, config.newPerDay - counters.newIntroduced));
    const reviewRemaining = Math.min(fetchLimit, Math.max(0, config.reviewsPerDay - counters.reviewsDone));

    let out = repo.dueLearning(this.db, nowMs, fetchLimit);
    const review = this.trialV7 && config.reviewOrder === 'retrievability' && reviewRemaining > 0
      ? repo.dueReview(this.db, nowMs, nextDayStartMs, -1, 'due').map(card => ({
        card, recall: fsrs7Recall((nowMs - card.lastReviewMs!) / MS_PER_DAY, card.stability!,
          fsrs7Curve(repo.currentFastStability(this.db, card.id), card.difficulty)),
      })).sort((a, b) => a.recall - b.recall).slice(0, reviewRemaining).map(({ card }) => card)
      : repo.dueReview(this.db, nowMs, nextDayStartMs, reviewRemaining, config.reviewOrder);
    const fresh = repo.dueNew(this.db, nowMs, newRemaining);
    switch (config.newReviewOrder) {
      case 'before':
        out = [...out, ...fresh, ...review];
        break;
      case 'mix':
        out = [...out, ...interleaveNewCards(review, fresh)];
        break;
      default:
        out = [...out, ...review, ...fresh];
    }
    if (conceptScores === null) return out.slice(0, limit);
    out.sort((a, b) => {
      const conceptA = a.tags.map(rustTrim).find(tag => tag.length > 0);
      const conceptB = b.tags.map(rustTrim).find(tag => tag.length > 0);
      const scoreA = conceptA === undefined ? null : conceptScores.get(conceptA) ?? null;
      const scoreB = conceptB === undefined ? null : conceptScores.get(conceptB) ?? null;
      const keyA = queueSortKey(a.state, scoreA, a.dueMs);
      const keyB = queueSortKey(b.state, scoreB, b.dueMs);
      return keyA[0] - keyB[0] || keyA[1] - keyB[1];
    });
    return out.slice(0, limit);
  }

  getCardState(cardStateId: string): FsrsCardState | null {
    return repo.loadStateById(this.db, cardStateId);
  }

  getCardConceptTags(ankiCardId: string): string[] {
    const tags = repo.cardTags(this.db, ankiCardId);
    if (tags.some(tag => rustTrim(tag).length > 0)) return tags;
    const name = repo.cardDocumentName(this.db, ankiCardId);
    const trimmed = name === null ? '' : rustTrim(name);
    return trimmed.length > 0 && trimmed.toLowerCase() !== 'default' ? [trimmed] : [];
  }

  getCardTags(ankiCardId: string): string[] {
    return repo.cardTags(this.db, ankiCardId);
  }

  listFeedbackRows(limit: number): FsrsFeedbackRow[] {
    return repo.listFeedbackRows(this.db, Math.min(2000, Math.max(0, limit)));
  }

  // ---------------------------------------------------------------- rate

  rate(
    cardStateId: string,
    rating: number,
    durationMs: number | null,
    clientOpId: string | null,
  ): FsrsRateResult {
    return this.rateWithMasteryBias(cardStateId, rating, durationMs, null, clientOpId);
  }

  rateWithMasteryBias(
    cardStateId: string,
    rating: number,
    durationMs: number | null,
    masteryScore: number | null,
    clientOpId: string | null,
    sprint?: SprintRatingOptions,
  ): FsrsRateResult {
    return this.rateWithMasteryBiasCas(
      cardStateId, rating, durationMs, masteryScore, clientOpId, false, null, sprint,
    );
  }

  rateWithMasteryBiasCas(
    cardStateId: string,
    ratingInput: number,
    durationMs: number | null,
    masteryScore: number | null,
    clientOpId: string | null,
    enforceExpectedLastReview: boolean,
    expectedLastReviewMs: number | null,
    sprint?: SprintRatingOptions,
  ): FsrsRateResult {
    if (!Number.isInteger(ratingInput) || ratingInput < 1 || ratingInput > 4) {
      throw appError('Validation', `rating must be 1..=4, got ${ratingInput}`);
    }
    const rating = ratingInput;
    const now = utcNow();
    const nowMs = now.ms;
    const resolvedOpId = sprint?.operationId ?? parseClientOpId(clientOpId);

    const result = this.tx('immediate', tx => {
      if (resolvedOpId !== null) {
        const existing = repo.loadExistingLog(tx, resolvedOpId, cardStateId, rating, this.trialV7);
        if (existing.kind === 'replay') {
          const state = repo.loadStateById(tx, cardStateId);
          if (state === null) {
            throw appError('NotFound', `fsrs card state not found: ${cardStateId}`);
          }
          return {
            cardState: state,
            logId: existing.logId,
            scheduledDays: existing.scheduledDays,
            dueMs: existing.dueMs,
            buriedSiblings: [],
          };
        }
        if (existing.kind === 'soft_deleted') {
          throw appError('Conflict', 'client op id was undone and cannot be reused');
        }
      }

      const loaded = repo.loadStateForRate(tx, cardStateId);
      if (loaded === null) throw appError('NotFound', `fsrs card state not found: ${cardStateId}`);
      const { state: before, isErrorCard } = loaded;
      if (isErrorCard) throw diagnosticError(before.ankiCardId);
      if (before.suspended) throw appError('Validation', 'card is suspended');
      if (enforceExpectedLastReview && before.lastReviewMs !== expectedLastReviewMs) {
        throw appError('Conflict', 'card was rated elsewhere; refresh and retry');
      }

      const config = repo.loadSchedulerConfig(tx, before.deckId ?? DEFAULT_DECK_ID, this.warn);
      if (sprint !== undefined) config.desiredRetention = sprint.desiredRetention;
      const stateBeforeJson = encodeStateBeforeSnapshot(stateBeforeSnapshot(before));
      const outcomes = this.scheduleRatings(tx, before, nowMs, config);
      const outcome = outcomes[rating - 1]!;
      applyMasteryBiasToOutcome(outcome, masteryScore, nowMs);
      if (sprint !== undefined && outcome.state === 2 && outcome.scheduledDays > 1 && outcome.stability !== null) {
        const compressed = sprint.compressInterval(outcome.scheduledDays, outcome.stability, config.fsrsParams);
        if (compressed < outcome.scheduledDays) {
          outcome.scheduledDays = compressed;
          outcome.dueMs = nowMs + compressed * 86_400_000;
        }
      }
      const logId = resolvedOpId ?? globalThis.crypto.randomUUID();

      const lapsed = outcome.lapses > before.lapses;
      const threshold = Math.max(1, config.leechThreshold);
      const halfThreshold = Math.max(1, Math.floor(threshold / 2));
      const leechTriggered = lapsed && outcome.lapses >= threshold
        && (outcome.lapses - threshold) % halfThreshold === 0;
      const leechFlag = before.leech || leechTriggered;
      const autoSuspend = leechTriggered && config.leechAction === 'suspend';

      const updated = repo.updateStateAfterRate(
        tx, cardStateId, outcome, nowMs, now.rfc, config.desiredRetention,
        leechFlag, autoSuspend,
        enforceExpectedLastReview ? { expectedLastReviewMs } : null,
      );
      if (updated !== 1) {
        if (enforceExpectedLastReview) {
          throw appError('Conflict', 'card was rated elsewhere; refresh and retry');
        }
        throw appError('NotFound', `fsrs card state not found: ${cardStateId}`);
      }

      repo.insertReviewLog(
        tx, logId, cardStateId, before.ankiCardId, rating, before, outcome,
        nowMs, now.rfc, durationMs, stateBeforeJson,
      );
      const cardState = repo.loadStateById(tx, cardStateId);
      if (cardState === null) throw appError('Database', 'state missing after update');
      const buriedSiblings = repo.burySiblings(
        tx, cardState, config.buryNewSiblings, config.buryReviewSiblings,
        nowMs, logicalDayBoundsMs(nowMs, config.dayRolloverHour)[1], now.rfc,
      );
      return {
        cardState,
        logId,
        scheduledDays: outcome.scheduledDays,
        dueMs: outcome.dueMs,
        buriedSiblings,
      };
    });
    this.debug(
      `[FsrsReviewService] rate: id=${cardStateId}, rating=${rating}, due_ms=${result.dueMs}, scheduled_days=${result.scheduledDays}`,
    );
    return result;
  }

  // ---------------------------------------------------------------- preview / bury / suspend

  previewIntervals(cardStateId: string, masteryScore: number | null): FsrsPreviewResult {
    const nowMs = utcNow().ms;
    const loaded = repo.loadStateForRate(this.db, cardStateId);
    if (loaded === null) throw appError('NotFound', `fsrs card state not found: ${cardStateId}`);
    const { state: before, isErrorCard } = loaded;
    if (isErrorCard) throw diagnosticError(before.ankiCardId);
    if (before.suspended) throw appError('Validation', 'card is suspended');
    const config = repo.loadSchedulerConfig(this.db, before.deckId ?? DEFAULT_DECK_ID, this.warn);
    const outcomes = this.scheduleRatings(this.db, before, nowMs, config);
    return {
      intervals: outcomes.map((outcome, index) => {
        applyMasteryBiasToOutcome(outcome, masteryScore, nowMs);
        return {
          rating: index + 1,
          scheduledDays: outcome.scheduledDays,
          dueMs: outcome.dueMs,
          intervalMs: outcome.dueMs - nowMs,
        };
      }),
    };
  }

  setBuried(cardStateId: string, buried: boolean): FsrsBuryResult {
    if (rustTrim(cardStateId).length === 0) throw appError('Validation', 'cardStateId is required');
    const now = utcNow();
    const nowMs = now.ms;
    return this.tx('immediate', tx => {
      const before = repo.loadStateById(tx, cardStateId);
      if (before === null) throw appError('NotFound', `fsrs card state not found: ${cardStateId}`);
      const config = repo.loadSchedulerConfig(tx, DEFAULT_DECK_ID, this.warn);
      const currentlyBuried = before.buriedUntilMs !== null && before.buriedUntilMs > nowMs;
      if (currentlyBuried === buried) return { state: before, changed: false };
      const until = buried ? logicalDayBoundsMs(nowMs, config.dayRolloverHour)[1] : null;
      repo.updateBuried(tx, cardStateId, until, now.rfc);
      const state = repo.loadStateById(tx, cardStateId);
      if (state === null) throw appError('Database', 'state missing after bury update');
      return { state, changed: true };
    });
  }

  suspendCard(cardStateId: string): FsrsSuspendResult {
    return this.setSuspended(cardStateId, true);
  }

  unsuspendCard(cardStateId: string): FsrsSuspendResult {
    return this.setSuspended(cardStateId, false);
  }

  private setSuspended(cardStateId: string, suspended: boolean): FsrsSuspendResult {
    if (rustTrim(cardStateId).length === 0) throw appError('Validation', 'cardStateId is required');
    const now = utcNow().rfc;
    return this.tx('immediate', tx => {
      const before = repo.loadStateById(tx, cardStateId);
      if (before === null) throw appError('NotFound', `fsrs card state not found: ${cardStateId}`);
      if (before.suspended === suspended) return { state: before, changed: false };
      const updated = repo.updateSuspended(tx, cardStateId, suspended, before.suspended, now);
      if (updated !== 1) throw appError('Conflict', 'card state changed while updating suspension');
      const state = repo.loadStateById(tx, cardStateId);
      if (state === null) throw appError('Database', 'state missing after suspension update');
      return { state, changed: true };
    });
  }

  // ---------------------------------------------------------------- undo

  undoLastReview(expectedLogId: string, cardStateId: string): FsrsUndoResult {
    if (rustTrim(expectedLogId).length === 0 || rustTrim(cardStateId).length === 0) {
      throw appError('Validation', 'expectedLogId and cardStateId are required');
    }
    const now = utcNow().rfc;
    return this.tx('immediate', tx => {
      const current = repo.loadStateById(tx, cardStateId);
      if (current === null) throw appError('NotFound', `fsrs card state not found: ${cardStateId}`);
      const log = repo.loadLogForUndo(tx, expectedLogId);
      if (log === null) throw appError('NotFound', `active fsrs review log not found: ${expectedLogId}`);
      if (log.stateId !== cardStateId || log.ankiCardId !== current.ankiCardId) {
        throw appError('Conflict', 'review log does not belong to the requested card state');
      }
      const latestLogId = repo.latestActiveLogId(tx, cardStateId, this.trialV7);
      if (latestLogId !== expectedLogId
        || current.lastReviewMs !== log.reviewMs
        || log.updatedAt !== current.updatedAt) {
        throw appError('Conflict', '复习记录已过期，已不是最近一次评分');
      }
      if (log.snapshotJson === null) {
        throw appError('Validation', 'review log predates complete FSRS undo snapshots');
      }
      const snapshot = decodeStateBeforeSnapshot(log.snapshotJson);
      if (snapshot === null) {
        throw appError('Validation', 'review log contains a damaged FSRS snapshot');
      }
      if (!validateSnapshotFor(snapshot, current)) {
        throw appError('Validation', 'review log contains a damaged FSRS snapshot');
      }
      const expectedUpdatedAt = current.updatedAt;
      const restored = repo.restoreStateFromSnapshot(
        tx, cardStateId, snapshot, log.reviewMs, expectedUpdatedAt, now,
      );
      if (restored !== 1) throw appError('Conflict', 'card state changed while undoing the latest rating');
      const deleted = repo.softDeleteLog(tx, expectedLogId, cardStateId, now);
      if (deleted !== 1) throw appError('Conflict', 'review log changed while undoing the latest rating');
      repo.reanchorLatestUndoLog(tx, cardStateId, now, this.trialV7);
      const state = repo.loadStateById(tx, cardStateId);
      if (state === null) throw appError('Database', 'state missing after undo');
      return { state, changed: true, undoneLogId: expectedLogId };
    });
  }

  // ---------------------------------------------------------------- agent scopes

  getReviewStatesForSession(ankiCardIds: readonly string[], sessionId: string): FsrsAgentReviewStateSnapshot[] {
    if (rustTrim(sessionId).length === 0) throw appError('Validation', 'sessionId is required');
    const ids = normalizeIds(ankiCardIds, 'ankiCardIds');
    if (ids.length === 0) return [];
    return this.tx('deferred', tx => {
      const verified = new Set<string>();
      const snapshots: FsrsAgentReviewStateSnapshot[] = [];
      for (const cardId of ids) {
        const guard = repo.loadCardSelection(tx, cardId);
        if (guard === null) throw appError('NotFound', `anki card not found: ${cardId}`);
        if (!verified.has(guard.documentId)) {
          if (!repo.documentOwnedBySession(tx, guard.documentId, sessionId)) {
            throw appError('NotFound', `anki card not found: ${cardId}`);
          }
          verified.add(guard.documentId);
        }
        const record = repo.loadAgentStateRecord(tx, cardId);
        if (record !== null) {
          snapshots.push(this.agentSnapshot(tx, record, guard.isErrorCard));
        }
      }
      return snapshots;
    });
  }

  getReviewStatesForLibrary(
    _scope: string,
    ankiCardIds: readonly string[],
  ): FsrsAgentReviewStateSnapshot[] {
    const ids = normalizeIds(ankiCardIds, 'ankiCardIds', 100);
    if (ids.length === 0) return [];
    return this.tx('deferred', tx => {
      const snapshots: FsrsAgentReviewStateSnapshot[] = [];
      for (const cardId of ids) {
        const guard = repo.loadCardSelection(tx, cardId);
        if (guard === null) throw appError('NotFound', `anki card not found: ${cardId}`);
        const record = repo.loadAgentStateRecord(tx, cardId);
        if (record !== null) snapshots.push(this.agentSnapshot(tx, record, guard.isErrorCard));
      }
      return snapshots;
    });
  }

  setSuspendedForSession(
    cardId: string, sessionId: string, expectedReviewVersion: number | bigint, suspended: boolean,
  ): FsrsAgentReviewMutationOutcome {
    if (rustTrim(sessionId).length === 0) {
      throw appError('Validation', 'cardId and sessionId are required');
    }
    return this.setSuspendedForAgentScope(
      cardId, { kind: 'session', sessionId }, expectedReviewVersion, suspended,
    );
  }

  setSuspendedForLibrary(
    scope: string, cardId: string, expectedReviewVersion: number | bigint, suspended: boolean,
  ): FsrsAgentReviewMutationOutcome {
    return this.setSuspendedForAgentScope(
      cardId, { kind: 'library', scope }, expectedReviewVersion, suspended,
    );
  }

  private setSuspendedForAgentScope(
    cardId: string,
    scope: FsrsAgentMutationScope,
    expectedReviewVersion: number | bigint,
    suspended: boolean,
  ): FsrsAgentReviewMutationOutcome {
    const version = i64Version(expectedReviewVersion);
    if (rustTrim(cardId).length === 0 || version === null) {
      throw appError('Validation', 'cardId and a non-negative expectedReviewVersion are required');
    }
    return this.tx('immediate', tx => {
      const scoped = this.loadScopedAgentState(tx, cardId, scope);
      if (scoped === null) return { status: 'not_found' };
      const { isErrorCard, record } = scoped;
      const current = this.agentSnapshot(tx, record, isErrorCard);
      if (isErrorCard) return { status: 'blocked', reason: 'diagnostic_card', current };
      if (record.reviewVersion !== version) return { status: 'conflict', current };
      if (record.state.suspended === suspended) {
        return { status: 'updated', state: current, changed: false };
      }
      const now = utcNow();
      let stamp = now.rfc;
      if (stamp === record.state.updatedAt) stamp = rfcNanosAfter(now, 1n);
      const updated = repo.updateAgentSuspended(
        tx, record.state.id, cardId, version,
        record.state.suspended, suspended, stamp,
      );
      if (updated !== 1) {
        const latest = this.loadScopedAgentState(tx, cardId, scope);
        if (latest === null) return { status: 'not_found' };
        return {
          status: 'conflict',
          current: this.agentSnapshot(tx, latest.record, latest.isErrorCard),
        };
      }
      const updatedRecord = repo.loadAgentStateRecord(tx, cardId);
      if (updatedRecord === null) throw appError('Database', 'state missing after Agent suspension update');
      return {
        status: 'updated',
        state: this.agentSnapshot(tx, updatedRecord, false),
        changed: true,
      };
    });
  }

  undoLastReviewForSession(
    cardId: string, sessionId: string, expectedReviewVersion: number | bigint, expectedLogId: string,
  ): FsrsAgentReviewMutationOutcome {
    if (rustTrim(sessionId).length === 0) {
      throw appError('Validation', 'cardId, sessionId, and expectedLogId are required');
    }
    return this.undoLastReviewForAgentScope(
      cardId, { kind: 'session', sessionId }, expectedReviewVersion, expectedLogId,
    );
  }

  undoLastReviewForLibrary(
    scope: string, cardId: string, expectedReviewVersion: number | bigint, expectedLogId: string,
  ): FsrsAgentReviewMutationOutcome {
    return this.undoLastReviewForAgentScope(
      cardId, { kind: 'library', scope }, expectedReviewVersion, expectedLogId,
    );
  }

  private undoLastReviewForAgentScope(
    cardId: string,
    scope: FsrsAgentMutationScope,
    expectedReviewVersion: number | bigint,
    expectedLogId: string,
  ): FsrsAgentReviewMutationOutcome {
    const version = i64Version(expectedReviewVersion);
    if (rustTrim(cardId).length === 0 || version === null || rustTrim(expectedLogId).length === 0) {
      throw appError('Validation', 'cardId, non-negative expectedReviewVersion, and expectedLogId are required');
    }
    return this.tx('immediate', tx => {
      const scoped = this.loadScopedAgentState(tx, cardId, scope);
      if (scoped === null) return { status: 'not_found' };
      const { isErrorCard, record } = scoped;
      const current = this.agentSnapshot(tx, record, isErrorCard);
      if (isErrorCard) return { status: 'blocked', reason: 'diagnostic_card', current };
      if (record.reviewVersion !== version) return { status: 'conflict', current };
      const latest = repo.loadLatestAgentReview(tx, record.state.id, this.trialV7);
      if (latest === null) return { status: 'conflict', current };
      if (latest.logId !== expectedLogId
        || latest.ankiCardId !== cardId
        || record.state.lastReviewMs !== latest.reviewMs
        || latest.updatedAt !== record.state.updatedAt) {
        return { status: 'conflict', current };
      }
      if (latest.snapshotJson === null) {
        return { status: 'blocked', reason: 'undo_snapshot_unavailable', current };
      }
      const snapshot = decodeStateBeforeSnapshot(latest.snapshotJson);
      if (snapshot === null) {
        return { status: 'blocked', reason: 'undo_snapshot_damaged', current };
      }
      if (!validateSnapshotFor(snapshot, record.state)) {
        return { status: 'blocked', reason: 'undo_snapshot_invalid', current };
      }
      const now = utcNow();
      let stamp = now.rfc;
      if (stamp === record.state.updatedAt) stamp = rfcNanosAfter(now, 1n);
      const restored = repo.restoreAgentState(
        tx, record.state.id, cardId, version, snapshot,
        latest.reviewMs, record.state.updatedAt, stamp,
      );
      if (restored !== 1) {
        const next = this.loadScopedAgentState(tx, cardId, scope);
        if (next === null) return { status: 'not_found' };
        return {
          status: 'conflict',
          current: this.agentSnapshot(tx, next.record, next.isErrorCard),
        };
      }
      const deleted = repo.softDeleteAgentLog(
        tx, expectedLogId, record.state.id, cardId, record.state.updatedAt, stamp,
      );
      if (deleted !== 1) return { status: 'conflict', current };
      repo.reanchorLatestUndoLog(tx, record.state.id, stamp, this.trialV7);
      const updatedRecord = repo.loadAgentStateRecord(tx, cardId);
      if (updatedRecord === null) throw appError('Database', 'state missing after Agent undo');
      return {
        status: 'updated',
        state: this.agentSnapshot(tx, updatedRecord, false),
        changed: true,
      };
    });
  }

  private loadScopedAgentState(
    tx: SqlExecutor,
    cardId: string,
    scope: FsrsAgentMutationScope,
  ): { isErrorCard: boolean; record: repo.AgentStateRecord } | null {
    const guard = repo.loadCardSelection(tx, cardId);
    if (guard === null) return null;
    if (scope.kind === 'session' && !repo.documentOwnedBySession(tx, guard.documentId, scope.sessionId)) {
      return null;
    }
    const record = repo.loadAgentStateRecord(tx, cardId);
    if (record === null) return null;
    return { isErrorCard: guard.isErrorCard, record };
  }

  private agentSnapshot(
    tx: SqlExecutor,
    record: repo.AgentStateRecord,
    isErrorCard: boolean,
  ): FsrsAgentReviewStateSnapshot {
    const latest = repo.loadLatestAgentReview(tx, record.state.id, this.trialV7);
    return repo.buildAgentSnapshot(record, isErrorCard, latest);
  }

  // ---------------------------------------------------------------- mastery outbox

  pendingMasteryReviews(limit: number): FsrsPendingMasteryReview[] {
    return repo.pendingMasteryReviews(this.db, limit);
  }

  markMasteryReviewSynced(logId: string): void {
    repo.markMasterySynced(this.db, logId, utcNow().rfc);
  }

  // ---------------------------------------------------------------- L16 同事务接口

  /** 在调用方事务内删除卡片 FSRS 行；L16 删除 `anki_cards` 前先调用。 */
  cleanupCardDeletionInTx(conn: SqlExecutor, cardIds: readonly string[]): void {
    repo.deleteFsrsRowsForCards(conn, cardIds);
  }

  /** 在调用方事务内删除任务下全部卡片的 FSRS 行。 */
  cleanupTaskDeletionInTx(conn: SqlExecutor, taskId: string): void {
    repo.deleteFsrsRowsForTask(conn, taskId);
  }

  /** 在调用方事务内删除文档会话下全部卡片的 FSRS 行。 */
  cleanupDocumentDeletionInTx(conn: SqlExecutor, documentId: string): void {
    repo.deleteFsrsRowsForDocument(conn, documentId);
  }

  /** Rust `enqueue_imported_cards_in_tx`：在调用方的 APKG 导入事务内建档。 */
  enqueueImportedCardsInTx(
    conn: SqlExecutor,
    cards: readonly FsrsImportedCard[],
  ): FsrsImportEnqueueSummary {
    const summary: FsrsImportEnqueueSummary = {
      enqueued: 0, skipped: 0, withHistory: 0, suspended: 0,
    };
    if (cards.length === 0) return summary;
    const now = utcNow();
    const config = repo.loadSchedulerConfig(conn, DEFAULT_DECK_ID, this.warn);
    repo.ensureDefaultDeck(conn, now.rfc);
    for (const { cardId, seed } of cards) {
      const outcome = repo.insertStateInTx(
        conn, cardId, seed, config.desiredRetention, now.ms, now.rfc,
      );
      if (outcome.kind === 'already_live') {
        summary.skipped += 1;
        continue;
      }
      summary.enqueued += 1;
      if (seed !== null) {
        if (seed.state !== 0) summary.withHistory += 1;
        if (seed.suspended) summary.suspended += 1;
      }
    }
    return summary;
  }

  // ---------------------------------------------------------------- config / stats

  getSchedulerConfig(): FsrsSchedulerConfig {
    return repo.loadSchedulerConfig(this.db, DEFAULT_DECK_ID, this.warn);
  }

  updateSchedulerConfig(update: FsrsSchedulerConfigUpdate): FsrsSchedulerConfig {
    validateSchedulerConfigUpdate(update);
    const now = utcNow().rfc;
    return this.tx('immediate', tx => {
      repo.ensureDefaultDeck(tx, now);
      const before = repo.loadSchedulerConfig(tx, DEFAULT_DECK_ID, this.warn);
      let value = readConfigObjectExact(repo.readConfigJsonText(tx, DEFAULT_DECK_ID));
      const setField = (snake: string, camel: string, field: unknown): void => {
        value = swapRemove(value, camel);
        value[snake] = field;
      };
      if (update.newPerDay != null) setField('new_per_day', 'newPerDay', update.newPerDay);
      if (update.learnAheadMinutes != null) setField('learn_ahead_minutes', 'learnAheadMinutes', update.learnAheadMinutes);
      if (update.reviewsPerDay != null) setField('reviews_per_day', 'reviewsPerDay', update.reviewsPerDay);
      if (update.desiredRetention != null) setField('desired_retention', 'desiredRetention', f64Json(update.desiredRetention));
      if (update.leechThreshold != null) setField('leech_threshold', 'leechThreshold', update.leechThreshold);
      if (update.leechAction != null) setField('leech_action', 'leechAction', update.leechAction);
      if (update.enableFuzz != null) setField('enable_fuzz', 'enableFuzz', update.enableFuzz);
      if (update.learningSteps != null) setField('learning_steps', 'learningSteps', update.learningSteps.map(f64Json));
      if (update.relearningSteps != null) setField('relearning_steps', 'relearningSteps', update.relearningSteps.map(f64Json));
      if (update.maximumInterval != null) setField('maximum_interval', 'maximumInterval', update.maximumInterval);
      if (update.dayRolloverHour != null) setField('day_rollover_hour', 'dayRolloverHour', update.dayRolloverHour);
      if (update.buryNewSiblings != null) setField('bury_new_siblings', 'buryNewSiblings', update.buryNewSiblings);
      if (update.buryReviewSiblings != null) setField('bury_review_siblings', 'buryReviewSiblings', update.buryReviewSiblings);
      if (update.reviewOrder != null) setField('review_order', 'reviewOrder', update.reviewOrder);
      if (update.newReviewOrder != null) setField('new_review_order', 'newReviewOrder', update.newReviewOrder);
      if (update.maxAnswerSeconds != null) setField('max_answer_seconds', 'maxAnswerSeconds', update.maxAnswerSeconds);
      if (update.fsrsParams != null) {
        setField('fsrs_params', 'fsrsParams', update.fsrsParams.map(f32Json));
        value = swapRemove(swapRemove(value, 'fsrs_optimized_at_ms'), 'fsrs_optimized_review_count');
      }
      repo.writeConfigJson(tx, DEFAULT_DECK_ID, value, now);
      const config = repo.loadSchedulerConfig(tx, DEFAULT_DECK_ID, this.warn);
      if (JSON.stringify(config.fsrsParams) !== JSON.stringify(before.fsrsParams)) {
        recomputeMemoryStates(this.rt, tx, config, now);
      }
      return config;
    });
  }


  getStats(): FsrsStats {
    const nowMs = utcNow().ms;
    const config = repo.loadSchedulerConfig(this.db, DEFAULT_DECK_ID, this.warn);
    const [dayStartMs, nextDayStartMs] = logicalDayBoundsMs(nowMs, config.dayRolloverHour);
    const counters = repo.dailyCounters(this.db, dayStartMs, nextDayStartMs);
    const newRemaining = Math.max(0, config.newPerDay - counters.newIntroduced);
    const reviewRemaining = Math.max(0, config.reviewsPerDay - counters.reviewsDone);
    const counts = repo.statsCounts(this.db, nowMs, nextDayStartMs);
    const reviewCapped = Math.min(counts.reviewDue, reviewRemaining);
    const newCapped = Math.min(counts.newDue, newRemaining);
    return {
      total: counts.total,
      due: counts.learningDue + reviewCapped + newCapped,
      dueReview: reviewCapped,
      dueLearning: counts.learningDue,
      dueNew: newCapped,
      newCount: counts.newCount,
      learning: counts.learning,
      review: counts.review,
      relearning: counts.relearning,
      suspended: counts.suspended,
      reviewsToday: repo.reviewsTodayCount(this.db, dayStartMs, nextDayStartMs),
      buried: counts.buried,
      leech: counts.leech,
      newRemainingToday: newRemaining,
      reviewsRemainingToday: reviewRemaining,
      backlog: (counts.reviewDue - reviewCapped) + (counts.newDue - newCapped),
      backlogReview: counts.reviewDue - reviewCapped,
      backlogNew: counts.newDue - newCapped,
      learningWaiting: Math.max(0, counts.learning + counts.relearning - counts.learningDue),
    };
  }

  // ---------------------------------------------------------------- statistics / memory

  getReviewStatistics(daysInput: number | null): FsrsReviewStatistics {
    return getReviewStatistics(this.rt, daysInput, this.trialV7);
  }

  getMemoryOverview(recentLimitInput: number | null): FsrsMemoryOverview {
    return getMemoryOverview(this.rt, recentLimitInput, this.trialV7);
  }

  getCardMemoryHistory(cardStateId: string): FsrsCardMemoryHistory {
    return getCardMemoryHistory(this.rt, cardStateId, this.trialV7);
  }

  // ---------------------------------------------------------------- reset / recompute

  resetCardProgress(cardStateId: string): FsrsResetResult {
    return resetCardProgress(this.rt, cardStateId);
  }

  ensureMemoryStatesCurrent(): number {
    return ensureMemoryStatesCurrent(this.rt);
  }

  /** Rust `optimize_parameters`；训练/评估由 F7 fsrs 6.6.2 训练器提供。 */
  optimizeParameters(trainer: FsrsTrainer): Promise<FsrsOptimizeResult> {
    return optimizeParameters(this.rt, trainer);
  }
}

export { masteryDueBiasDeltaMs, MIN_BIASABLE_INTERVAL_MS };
