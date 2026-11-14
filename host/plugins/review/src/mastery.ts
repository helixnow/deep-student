import { Service, type Context } from '@deepseek-ai/cordis';
import { nanoid } from 'nanoid';
import { rustTrim } from '../../../platform/util/portable.ts';
import { CommandError } from '../../../kernel/api.ts';
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import type { MasteryService, MasterySource, MasteryOutcome, MasteryState, MasteryEvent, MasteryOverviewSummary, MasteryPriorityReviewItem } from '../api.ts';
import * as repo from '../repository/mastery.ts';
import { appError, errorText } from './errors.ts';
import { rfcNanosAfter, utcNow } from './clock.ts';

const ANTI_FARM_WINDOW_NANOS = 60_000_000_000n;

export { WEAK_SCORE_THRESHOLD, MIN_TOTAL_FOR_WEAK, RECOVER_SCORE_THRESHOLD } from '../repository/mastery.ts';
export function conceptKeyFromTags(tags: string[], fallback: string): string | null {
  for (const tag of tags) {
    const trimmed = rustTrim(tag);
    if (trimmed) return trimmed;
  }
  const fallbackTrimmed = rustTrim(fallback);
  return fallbackTrimmed ? `item:${fallbackTrimmed}` : null;
}
function database<T>(fn: () => T): T {
  try { return fn(); } catch (e) { if (e instanceof CommandError) throw e; throw appError('Database', errorText(e)); }
}
// Rust formatting with zero fractional places rounds ties to even.
function roundedScore(score: number): number {
  const n = score * 100, floor = Math.floor(n);
  return n - floor === 0.5 ? floor + floor % 2 : Math.round(n);
}
export class Mastery extends Service implements MasteryService {
  constructor(ctx: Context) { super(ctx, 'mastery'); }
  _db(): DatabaseHandle { return database(() => this.ctx.storage.database('vfs')); }
  _record(conn: SqlExecutor, id: string | null, source: MasterySource, concept: string, item: string, outcome: MasteryOutcome): MasteryState {
    concept = rustTrim(concept); item = rustTrim(item);
    if (!concept || !item) throw appError('Validation', 'mastery concept_key and item_id must be non-empty');
    const now = utcNow();
    return database(() => {
      repo.insertEvent(
        conn, id ?? `me_${nanoid(12)}`, now.rfc,
        rfcNanosAfter(now, -ANTI_FARM_WINDOW_NANOS), source, concept, item, outcome,
      );
      const state = repo.recomputeStateWithConn(conn, concept);
      const outcomeDb = typeof outcome === 'string' ? outcome : 'rating';
      this.ctx.logger('review').info(
        '[Mastery] recorded %s/%s concept=%s score=%s total=%d',
        source, outcomeDb, concept, state.score.toFixed(3), state.total,
      );
      return state;
    });
  }
  recordEvent(source: MasterySource, concept: string, item: string, outcome: MasteryOutcome, operationId?: string): MasteryState {
    if (!rustTrim(concept) || !rustTrim(item)) throw appError('Validation', 'mastery concept_key and item_id must be non-empty');
    return database(() => this._db().transaction(tx => this._record(tx, operationId ?? null, source, concept, item, outcome), { behavior: 'immediate' }));
  }
  recordQbankAnswer(questionId: string, tags: string[], correct: boolean): MasteryState {
    const concept = conceptKeyFromTags(tags, questionId);
    if (concept === null) throw appError('Validation', 'mastery concept_key unavailable for question');
    const state = this.recordEvent('qbank', concept, questionId, correct ? 'correct' : 'wrong');
    this.syncLearnerProfile(state); return state;
  }
  recordQbankAnswerWithConn(conn: SqlExecutor, submissionId: string, questionId: string, tags: string[], correct: boolean): MasteryState {
    const concept = conceptKeyFromTags(tags, questionId);
    if (concept === null) throw appError('Validation', 'mastery concept_key unavailable for question');
    return this._record(conn, `me_qbank_${rustTrim(submissionId)}`, 'qbank', concept, questionId, correct ? 'correct' : 'wrong');
  }
  recordFsrsRating(cardId: string, tags: string[], rating: number): MasteryState | null {
    const concept = conceptKeyFromTags(tags, '');
    if (concept === null) {
      this.ctx.logger('review').debug('[Mastery] skip FSRS emit: card %s has no usable tags', cardId);
      return null;
    }
    if (rating < 1 || rating > 4) {
      this.ctx.logger('review').warn('[Mastery] skip FSRS emit: invalid rating %d for card %s', rating, cardId);
      return null;
    }
    const state = this.recordEvent('fsrs', concept, cardId, { rating }); this.syncLearnerProfile(state); return state;
  }
  recordFsrsRatingForLog(logId: string, cardId: string, tags: string[], rating: number): MasteryState | null {
    const concept = conceptKeyFromTags(tags, '');
    if (concept === null) return null;
    if (rating < 1 || rating > 4) throw appError('Validation', 'FSRS rating must be 1..=4');
    const state = database(() => this._db().transaction(tx => this._record(tx, `me_fsrs_${rustTrim(logId)}`, 'fsrs', concept, cardId, { rating }), { behavior: 'immediate' }));
    try { this.syncLearnerProfile(state); } catch (e) { this.ctx.logger('review').warn('[Mastery] FSRS event committed but profile reflux failed for log %s: %s', logId, errorText(e)); }
    return state;
  }
  revertFsrsRatingForLog(logId: string): MasteryState | null {
    const id = `me_fsrs_${rustTrim(logId)}`;
    const state = database(() => this._db().transaction(tx => {
      const concept = repo.eventConcept(tx, id);
      if (concept === null) return null;
      repo.tombstone(tx, id, utcNow().rfc); return repo.recomputeStateWithConn(tx, concept);
    }, { behavior: 'immediate' }));
    if (state !== null) this.syncLearnerProfile(state); return state;
  }
  recordQbankVerdictCorrectionWithConn(conn: SqlExecutor, submissionId: string, questionId: string, tags: string[], correct: boolean): MasteryState {
    submissionId = rustTrim(submissionId); questionId = rustTrim(questionId);
    if (!submissionId || !questionId) throw appError('Validation', 'mastery correction requires non-empty submission_id and question_id');
    const concept = conceptKeyFromTags(tags, questionId);
    if (concept === null) throw appError('Validation', 'mastery concept_key unavailable for question');
    return database(() => {
      const outcome = correct ? 'correct' : 'wrong', base = `me_qbank_${submissionId}`, chain = repo.correctionChain(conn, base);
      if (!chain.length) return this._record(conn, base, 'qbank', concept, questionId, outcome);
      const latest = chain.filter(e => e.deleted_at === null).sort((a, b) => b.revision - a.revision)[0];
      if (latest?.outcome === outcome) return repo.recomputeStateWithConn(conn, concept);
      const stale = new Set<string>(), now = utcNow().rfc;
      for (const e of chain.filter(e => e.deleted_at === null)) {
        repo.tombstone(conn, e.id, now); if (e.concept_key !== concept) stale.add(e.concept_key);
      }
      const revision = Math.max(...chain.map(e => e.revision)) + 1;
      const correctionId = `${base}_r${revision}`;
      repo.insertCorrection(conn, correctionId, now, concept, questionId, outcome);
      for (const c of stale) repo.recomputeStateWithConn(conn, c);
      const state = repo.recomputeStateWithConn(conn, concept);
      this.ctx.logger('review').info(
        '[Mastery] qbank verdict corrected submission=%s -> %s (%s) concept=%s score=%s total=%d',
        submissionId, outcome, correctionId, concept, state.score.toFixed(3), state.total,
      );
      return state;
    });
  }
  recordQbankVerdictCorrection(submissionId: string, questionId: string, tags: string[], correct: boolean): MasteryState {
    const state = database(() => this._db().transaction(tx => this.recordQbankVerdictCorrectionWithConn(tx, submissionId, questionId, tags, correct), { behavior: 'immediate' }));
    try { this.syncLearnerProfile(state); } catch (e) { this.ctx.logger('review').warn('[Mastery] qbank correction committed but profile reflux failed for submission %s: %s', submissionId, errorText(e)); }
    return state;
  }
  recomputeState(concept: string): MasteryState { return database(() => this._db().transaction(tx => repo.recomputeStateWithConn(tx, concept), { behavior: 'immediate' })); }
  recordInsightRecallVerdictWithConn(conn: SqlExecutor, insightId: string, sessionId: string, success: boolean, now: string): void {
    repo.insertInsightRecallVerdict(conn, insightId, sessionId, success, now);
  }
  recomputeAllStatesWithConn(conn: SqlExecutor): number {
    return database(() => { const concepts = repo.allConcepts(conn); for (const c of concepts) repo.recomputeStateWithConn(conn, c); return concepts.length; });
  }
  syncAllLearnerProfiles(): number {
    const states = database(() => repo.allStates(this._db()));
    for (const state of states) this.syncLearnerProfile(state); return states.length;
  }
  getState(concept: string): MasteryState | null { return database(() => repo.getState(this._db(), concept)); }
  weakConcepts(limit: number): MasteryState[] { return database(() => repo.weakConcepts(this._db(), limit)); }
  overviewSummary(limit: number): MasteryOverviewSummary {
    const summary = database(() => repo.overview(this._db()));
    return { ...summary, weakest: this.weakConcepts(limit), todayPriorityReview: this.todayPriorityReview(Math.min(limit, 5)) };
  }
  todayPriorityReview(limit: number): MasteryPriorityReviewItem[] {
    return this.weakConcepts(limit).map((s, i) => ({ conceptKey: s.conceptKey, score: s.score, total: s.total, wrongCount: s.wrongCount,
      priority: i + 1, reason: `掌握度 ${roundedScore(s.score)}%（样本 ${s.total}，错 ${s.wrongCount}）— 建议优先复习同概念闪卡` }));
  }
  syncLearnerProfile(state: MasteryState): void {
    const sink = this.ctx.get('masteryProfileSink');
    if (state.score < repo.WEAK_SCORE_THRESHOLD && state.total >= repo.MIN_TOTAL_FOR_WEAK) {
      // Source computes the evidence even when no profile extension is registered.
      const summary = database(() => repo.recentWrongSummary(this._db(), state.conceptKey, 3));
      if (sink) {
        database(() => sink.upsertWeakPointFromMastery(this._db(), state.conceptKey, {
          score: state.score, total: state.total, wrongCount: state.wrongCount, recentWrongSummary: summary,
        }));
        this.ctx.logger('review').debug(
          '[Mastery] upserted weak_point source=mastery concept=%s', state.conceptKey,
        );
      }
    } else if (state.total === 0 || state.score > repo.RECOVER_SCORE_THRESHOLD) {
      if (sink) {
        database(() => sink.removeWeakPointFromMastery(this._db(), state.conceptKey));
        this.ctx.logger('review').debug(
          '[Mastery] removed/recovered weak_point concept=%s score=%s',
          state.conceptKey, state.score.toFixed(3),
        );
      }
    }
  }
  listEvents(concept: string, limit: number): MasteryEvent[] { return database(() => repo.listEvents(this._db(), concept, limit)); }
}
