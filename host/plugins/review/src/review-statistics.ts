/**
 * 复习统计与记忆曲线（拆分自 `review.ts`）。
 *
 * 只读 mistakes 库；统计按排期的学习日分桶。
 */
import {
  forgettingCurveConstants, logicalDayBoundsMs, logicalDayKey, logicalDaysBetween, retrievability,
} from './fsrs-scheduler.ts';
import { FSRS7_CURVE, fsrs7Curve, fsrs7Recall } from './fsrs7.ts';
import {
  DEFAULT_DECK_ID, MS_PER_DAY,
  type FsrsCardMemoryHistory, type FsrsDailyReviewStat, type FsrsMemoryCard, type FsrsForgettingCurve,
  type FsrsMemoryDistributions, type FsrsMemoryOverview, type FsrsRatingDistribution,
  type FsrsRetentionStats, type FsrsReviewStatistics, type FsrsTrueRetentionRow,
} from './fsrs-types.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import { utcNow } from './clock.ts';
import { appError } from './errors.ts';
import type { ReviewRuntime } from './review-runtime.ts';
import * as repo from '../repository/fsrs.ts';

const MEMORY_TRUE_RETENTION_DAYS = 30;
const MEMORY_HISTORY_MAX_REVIEWS = 2000;
const STABILITY_BUCKET_UPPER_DAYS = [1, 3, 7, 14, 30, 90, 180, 365] as const;
const TRUE_RETENTION_PERIODS: readonly (readonly [string, number, number])[] = [
  ['today', 0, 0],
  ['yesterday', 1, 1],
  ['week', 0, 6],
  ['month', 0, 29],
  ['year', 0, 364],
];

export function getReviewStatistics(rt: ReviewRuntime, daysInput: number | null, trialV7 = false): FsrsReviewStatistics {
  const days = Math.min(730, Math.max(7, Math.trunc(daysInput ?? 365)));
  const nowMs = utcNow().ms;
  const config = repo.loadSchedulerConfig(rt.db, DEFAULT_DECK_ID, rt.warn);
  const [dayStartMs, nextDayStartMs] = logicalDayBoundsMs(nowMs, config.dayRolloverHour);
  const windowStartMs = dayStartMs - (days - 1) * MS_PER_DAY;
  const counters = repo.dailyCounters(rt.db, dayStartMs, nextDayStartMs);

  const daily = new Map<string, FsrsDailyReviewStat>();
  const ratingDistribution: FsrsRatingDistribution = { again: 0, hard: 0, good: 0, easy: 0, total: 0 };
  const retention: FsrsRetentionStats = {
    youngReviews: 0, youngPassed: 0, matureReviews: 0, maturePassed: 0,
    overallPassRate: 0, youngPassRate: 0, maturePassRate: 0,
  };
  const trueRetention: FsrsTrueRetentionRow[] = TRUE_RETENTION_PERIODS.map(([period]) => ({
    period, youngReviews: 0, youngPassed: 0, matureReviews: 0, maturePassed: 0,
  }));
  const retentionSeen = new Set<string>();
  for (const row of repo.reviewLogsForStats(rt.db, windowStartMs, trialV7)) {
    if (row.rating < 1 || row.rating > 4) continue;
    const date = logicalDayKey(row.reviewMs, config.dayRolloverHour);
    let entry = daily.get(date);
    if (entry === undefined) {
      entry = { date, total: 0, again: 0, hard: 0, good: 0, easy: 0, newIntroduced: 0, studyMs: 0 };
      daily.set(date, entry);
    }
    entry.total += 1;
    entry.studyMs += Math.max(0, row.durationMs ?? 0);
    ratingDistribution.total += 1;
    if (row.rating === 1) { entry.again += 1; ratingDistribution.again += 1; }
    else if (row.rating === 2) { entry.hard += 1; ratingDistribution.hard += 1; }
    else if (row.rating === 3) { entry.good += 1; ratingDistribution.good += 1; }
    else { entry.easy += 1; ratingDistribution.easy += 1; }
    if (row.stateBefore === 0) entry.newIntroduced += 1;
    if (row.stateBefore === 2 && !retentionSeen.has(`${row.cardStateId}\u0000${date}`)) {
      retentionSeen.add(`${row.cardStateId}\u0000${date}`);
      const passed = row.rating >= 2;
      // In V7 slow stability is a model parameter, not the previous scheduled interval.
      const maturityDays = trialV7 ? row.scheduledDaysBefore : row.stabilityBefore;
      const mature = maturityDays !== null && maturityDays >= 21;
      const daysAgo = logicalDaysBetween(row.reviewMs, nowMs, config.dayRolloverHour);
      trueRetention.forEach((bucket, index) => {
        const [, from, to] = TRUE_RETENTION_PERIODS[index]!;
        if (daysAgo < from || daysAgo > to) return;
        if (mature) {
          bucket.matureReviews += 1;
          if (passed) bucket.maturePassed += 1;
        } else {
          bucket.youngReviews += 1;
          if (passed) bucket.youngPassed += 1;
        }
      });
      if (mature) {
        retention.matureReviews += 1;
        if (passed) retention.maturePassed += 1;
      } else {
        retention.youngReviews += 1;
        if (passed) retention.youngPassed += 1;
      }
    }
  }
  const passRate = (passed: number, total: number): number => total > 0 ? passed / total : 0;
  retention.youngPassRate = passRate(retention.youngPassed, retention.youngReviews);
  retention.maturePassRate = passRate(retention.maturePassed, retention.matureReviews);
  retention.overallPassRate = passRate(
    retention.youngPassed + retention.maturePassed,
    retention.youngReviews + retention.matureReviews,
  );

  const breakdown = repo.stateBreakdown(rt.db, nowMs);
  const dailyLimits = {
    newPerDay: config.newPerDay,
    reviewsPerDay: config.reviewsPerDay,
    newIntroducedToday: counters.newIntroduced,
    reviewsDoneToday: counters.reviewsDone,
    newRemainingToday: Math.max(0, config.newPerDay - counters.newIntroduced),
    reviewsRemainingToday: Math.max(0, config.reviewsPerDay - counters.reviewsDone),
  };

  const forecastDays = 15;
  const horizon = new Date(dayStartMs);
  horizon.setDate(horizon.getDate() + forecastDays);
  const todayKey = logicalDayKey(nowMs, config.dayRolloverHour);
  const calendarDay = Date.parse(`${todayKey}T00:00:00Z`);
  const forecast = new Map<string, number>(Array.from({ length: forecastDays }, (_, offset) => [
    new Date(calendarDay + offset * MS_PER_DAY).toISOString().slice(0, 10), 0,
  ]));
  for (const dueMs of repo.forecastDueRows(rt.db, horizon.getTime())) {
    const key = dueMs < nextDayStartMs ? todayKey : logicalDayKey(dueMs, config.dayRolloverHour);
    const count = forecast.get(key);
    if (count !== undefined) forecast.set(key, count + 1);
  }
  const forecastRows = Array.from(forecast, ([date, count]) => ({ date, count }));
  const scheduledForecast = forecastRows.slice(1, 8);
  const dueForecast = forecastRows.filter(({ count }) => count > 0);

  const [decay, factor] = forgettingCurveConstants(config.fsrsParams);
  const memoryDistributions: FsrsMemoryDistributions = {
    cards: 0,
    difficulty: new Array(10).fill(0) as number[],
    stability: new Array(STABILITY_BUCKET_UPPER_DAYS.length + 1).fill(0) as number[],
    retrievability: new Array(10).fill(0) as number[],
  };
  for (const row of repo.memorizedRows(rt.db, trialV7)) {
    if (!Number.isFinite(row.stability) || row.stability <= 0) continue;
    memoryDistributions.cards += 1;
    if (row.difficulty !== null && Number.isFinite(row.difficulty)) {
      const bucket = Math.min(9, Math.floor(Math.min(10, Math.max(1, row.difficulty)) - 1));
      memoryDistributions.difficulty[bucket]! += 1;
    }
    const stabilityBucket = STABILITY_BUCKET_UPPER_DAYS.findIndex(upper => row.stability < upper);
    memoryDistributions.stability[stabilityBucket < 0 ? STABILITY_BUCKET_UPPER_DAYS.length : stabilityBucket]! += 1;
    const elapsedDays = Math.max(0, nowMs - row.lastReviewMs) / MS_PER_DAY;
    const r = trialV7 ? fsrs7Recall(elapsedDays, row.stability, fsrs7Curve(row.stabilityFast, row.difficulty))
      : retrievability(elapsedDays, row.stability, decay, factor);
    if (Number.isFinite(r)) {
      const bucket = Math.min(9, Math.floor(Math.min(1, Math.max(0, r)) * 10));
      memoryDistributions.retrievability[bucket]! += 1;
    }
  }

  return {
    ...(trialV7 && { model: 'fsrs-7' }),
    generatedAtMs: nowMs,
    dayStartMs,
    days,
    dailyReviews: [...daily.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value),
    ratingDistribution,
    stateBreakdown: breakdown,
    retention,
    dailyLimits,
    dueForecast,
    scheduledForecast,
    trueRetention,
    memoryDistributions,
  };
}

export function getMemoryOverview(rt: ReviewRuntime, recentLimitInput: number | null, trialV7 = false): FsrsMemoryOverview {
  const limit = Math.min(20, Math.max(1, Math.trunc(recentLimitInput ?? 5)));
  const retention = getReviewStatistics(rt, MEMORY_TRUE_RETENTION_DAYS, trialV7).retention;
  const nowMs = utcNow().ms;
  const config = repo.loadSchedulerConfig(rt.db, DEFAULT_DECK_ID, rt.warn);
  const memoryConfig = (deckConfig: typeof config) => {
    const [decay, factor] = forgettingCurveConstants(deckConfig.fsrsParams);
    return { curve: { decay, factor }, desiredRetention: deckConfig.desiredRetention };
  };
  const defaults = memoryConfig(config);
  const byDeck = new Map([[DEFAULT_DECK_ID, defaults]]);
  const forDeck = (deckId: string | null) => {
    const id = deckId ?? DEFAULT_DECK_ID;
    const cached = byDeck.get(id);
    if (cached) return cached;
    const value = memoryConfig(repo.loadSchedulerConfig(rt.db, id, rt.warn));
    byDeck.set(id, value);
    return value;
  };
  const recent = repo.memoryRecent(rt.db, limit, trialV7).map((card) => ({ ...card, ...forDeck(card.deckId),
    ...(trialV7 && { curve: fsrs7Curve(repo.currentFastStability(rt.db, card.cardStateId), card.difficulty) }),
  }));
  let memorizedCount = 0;
  let retrievabilitySum = 0;
  for (const row of repo.memorizedRows(rt.db, trialV7)) {
    const elapsedDays = Math.max(0, nowMs - row.lastReviewMs) / MS_PER_DAY;
    const { curve: { decay, factor } } = forDeck(row.deckId);
    const r = trialV7 ? fsrs7Recall(elapsedDays, row.stability, fsrs7Curve(row.stabilityFast, row.difficulty))
      : retrievability(elapsedDays, row.stability, decay, factor);
    if (Number.isFinite(r)) {
      memorizedCount += 1;
      retrievabilitySum += r;
    }
  }
  return {
    generatedAtMs: nowMs,
    ...defaults,
    ...(trialV7 && { curve: FSRS7_CURVE }),
    recent,
    memorizedCount,
    averageRetrievability: memorizedCount > 0 ? retrievabilitySum / memorizedCount : null,
    trueRetention: {
      windowDays: MEMORY_TRUE_RETENTION_DAYS,
      reviews: retention.youngReviews + retention.matureReviews,
      passed: retention.youngPassed + retention.maturePassed,
    },
  };
}

export function getCardMemoryHistory(rt: ReviewRuntime, cardStateId: string, trialV7 = false): FsrsCardMemoryHistory {
  if (rustTrim(cardStateId).length === 0) throw appError('Validation', 'cardStateId is required');
  const nowMs = utcNow().ms;
  const card: FsrsMemoryCard | null = repo.memoryCard(rt.db, cardStateId, trialV7);
  if (card === null) throw appError('NotFound', `fsrs card state not found: ${cardStateId}`);
  const config = repo.loadSchedulerConfig(rt.db, card.deckId ?? DEFAULT_DECK_ID, rt.warn);
  const reviews = repo.memoryReviews(rt.db, cardStateId, MEMORY_HISTORY_MAX_REVIEWS, trialV7)
    .map(({ stabilityFast, ...row }) => ({ ...row,
      ...(trialV7 && { curve: fsrs7Curve(stabilityFast, row.difficultyAfter) }),
    }));
  const [decay, factor] = forgettingCurveConstants(config.fsrsParams);
  const curve: FsrsForgettingCurve = trialV7
    ? (card.state === 0 ? FSRS7_CURVE : fsrs7Curve(repo.currentFastStability(rt.db, cardStateId), card.difficulty))
    : { decay, factor };
  return { generatedAtMs: nowMs, desiredRetention: config.desiredRetention, curve, card, reviews };
}
