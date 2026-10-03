import { describe, expect, it } from 'vitest';
import {
  FSRS5_CURVE,
  MS_PER_DAY,
  daysUntilRetention,
  historyRange,
  historyRows,
  historySegments,
  parseCardMemoryHistory,
  parseMemoryOverview,
  recentFloor,
  recentRange,
  retrievability,
  sampleLogCurve,
  type CardMemoryHistory,
  type MemoryCard,
} from '@/features/flashcards/memoryCurve';

const NOW = Date.UTC(2026, 9, 3, 13, 0, 0);
const MINUTE_MS = 60_000;

function card(overrides: Partial<MemoryCard>): MemoryCard {
  return {
    cardStateId: 'state',
    ankiCardId: 'card',
    front: 'front',
    text: null,
    extraFields: {},
    state: 2,
    stability: 1,
    difficulty: 5,
    lastReviewMs: NOW,
    dueMs: NOW + MS_PER_DAY,
    reps: 1,
    lapses: 0,
    lastRating: 3,
    ...overrides,
  };
}

/** rs-fsrs 1.2 默认参数下新卡首评：重来 / 良好（学习步）/ 简单 */
const FIRST_RATINGS = [
  card({ cardStateId: 'again', state: 1, stability: 0.4072, dueMs: NOW + MINUTE_MS, lastRating: 1 }),
  card({ cardStateId: 'good', state: 1, stability: 3.1262, dueMs: NOW + 10 * MINUTE_MS, lastRating: 3 }),
  card({ cardStateId: 'easy', state: 2, stability: 15.4722, dueMs: NOW + 15 * MS_PER_DAY, lastRating: 4 }),
];

describe('FSRS forgetting curve', () => {
  it('equals 90% when elapsed time equals stability and 100% right after a review', () => {
    for (const stability of [0.4, 3.13, 15.47, 120]) {
      expect(retrievability(stability, stability)).toBeCloseTo(0.9, 12);
      expect(retrievability(0, stability)).toBe(1);
    }
  });

  it('decays monotonically and matches the power curve (1 + 19/81 · t/S)^-0.5', () => {
    expect(retrievability(30, 15.4722)).toBeCloseTo((1 + (19 / 81) * (30 / 15.4722)) ** -0.5, 12);
    expect(retrievability(2, 3)).toBeGreaterThan(retrievability(3, 3));
    expect(retrievability(1, 0)).toBe(0);
  });

  it('inverts to the interval at which recall falls to a target', () => {
    expect(daysUntilRetention(0.9, 15.4722)).toBeCloseTo(15.4722, 9);
    const days = daysUntilRetention(0.8, 7);
    expect(retrievability(days, 7)).toBeCloseTo(0.8, 12);
    expect(daysUntilRetention(1, 7)).toBeNaN();
  });
});

describe('recent view axes', () => {
  it('starts at the earliest learning step and spans past the farthest due date', () => {
    const range = recentRange(FIRST_RATINGS, NOW + 1000);
    expect(range.minDays).toBeCloseTo(1 / 1440, 12);
    expect(range.maxDays).toBe(30);
    expect(range.ticks.map((tick) => `${tick.count}${tick.unit}`)).toEqual([
      '1minute', '10minute', '1hour', '1day', '1week', '1month',
    ]);
  });

  it('starts at one hour when nothing needs to be seen earlier', () => {
    const cards = [card({ lastReviewMs: NOW - 3 * MS_PER_DAY, dueMs: NOW + 4 * MS_PER_DAY, stability: 7 })];
    const range = recentRange(cards, NOW);
    expect(range.minDays).toBeCloseTo(1 / 24, 12);
    expect(range.ticks[0].unit).toBe('hour');
  });

  it('clips the retention floor to 40% for fast-forgetting cards', () => {
    expect(recentFloor(FIRST_RATINGS, 30, FSRS5_CURVE)).toBe(0.4);
    expect(recentFloor([card({ stability: 200 })], 30, FSRS5_CURVE)).toBe(0.8);
  });

  it('samples through the exact marker times', () => {
    const points = sampleLogCurve(3.1262, FSRS5_CURVE, 1 / 1440, 30, [10 / 1440]);
    expect(points[0].days).toBeCloseTo(1 / 1440, 12);
    expect(points[points.length - 1].days).toBeCloseTo(30, 9);
    expect(points.some((point) => Math.abs(point.days - 10 / 1440) < 1e-12)).toBe(true);
    for (let i = 1; i < points.length; i += 1) expect(points[i].r).toBeLessThanOrEqual(points[i - 1].r);
  });
});

describe('single-card history', () => {
  const history: CardMemoryHistory = {
    generatedAtMs: NOW,
    desiredRetention: 0.9,
    curve: FSRS5_CURVE,
    card: card({ cardStateId: 'h', stability: 9, lastReviewMs: NOW - 2 * MS_PER_DAY, dueMs: NOW + 7 * MS_PER_DAY, reps: 3 }),
    reviews: [
      { logId: 'l1', reviewMs: NOW - 6 * MS_PER_DAY, rating: 3, stateBefore: 0, stateAfter: 2, stabilityAfter: 3, difficultyAfter: 5, dueAfterMs: null },
      { logId: 'l2', reviewMs: NOW - 3 * MS_PER_DAY, rating: 1, stateBefore: 2, stateAfter: 3, stabilityAfter: 1, difficultyAfter: 6, dueAfterMs: null },
      { logId: 'l3', reviewMs: NOW - 2 * MS_PER_DAY, rating: 3, stateBefore: 3, stateAfter: 2, stabilityAfter: 9, difficultyAfter: 6, dueAfterMs: NOW + 7 * MS_PER_DAY },
    ],
  };

  it('reports the interval and recall just before each review', () => {
    const rows = historyRows(history);
    expect(rows[0]).toMatchObject({ elapsedDays: null, recallBefore: null, stabilityAfter: 3 });
    expect(rows[1].elapsedDays).toBeCloseTo(3, 9);
    expect(rows[1].recallBefore).toBeCloseTo(0.9, 12);
    expect(rows[2].elapsedDays).toBeCloseTo(1, 9);
    expect(rows[2].recallBefore).toBeCloseTo(0.9, 12);
  });

  it('restarts a segment at every review and extends the last one to the end of the chart', () => {
    const range = historyRange(history, NOW);
    const segments = historySegments(history, range.endMs);
    expect(segments.map((segment) => segment.fromMs)).toEqual(history.reviews.map((review) => review.reviewMs));
    expect(segments[0].toMs).toBe(history.reviews[1].reviewMs);
    expect(segments[2].toMs).toBe(range.endMs);
    expect(range.endMs).toBeGreaterThan(history.card.dueMs);
    expect(range.ticks.length).toBeLessThanOrEqual(6);
    expect(range.label).toBe('day');
  });
});

describe('payload parsing', () => {
  it('rejects malformed overviews and falls back to the FSRS-5 curve constants', () => {
    expect(parseMemoryOverview(null)).toBeNull();
    expect(parseMemoryOverview({ recent: 'nope' })).toBeNull();
    const parsed = parseMemoryOverview({
      desiredRetention: 2,
      curve: { decay: 0.5, factor: -1 },
      recent: [{ cardStateId: 's1', dueMs: NOW, lastRating: 7 }, { dueMs: NOW }],
      memorizedCount: 1,
      averageRetrievability: 0.93,
      trueRetention: { windowDays: 30, reviews: 10, passed: 9 },
    });
    expect(parsed?.curve).toEqual(FSRS5_CURVE);
    expect(parsed?.desiredRetention).toBe(0.9);
    expect(parsed?.recent).toHaveLength(1);
    expect(parsed?.recent[0].lastRating).toBeNull();
    expect(parsed?.trueRetention).toEqual({ windowDays: 30, reviews: 10, passed: 9 });
  });

  it('sorts history reviews chronologically and drops invalid ratings', () => {
    const parsed = parseCardMemoryHistory({
      desiredRetention: 0.85,
      curve: { decay: -0.5, factor: 19 / 81 },
      card: { cardStateId: 'h', dueMs: NOW },
      reviews: [
        { logId: 'b', reviewMs: NOW, rating: 3, stabilityAfter: 4 },
        { logId: 'x', reviewMs: NOW, rating: 9 },
        { logId: 'a', reviewMs: NOW - MS_PER_DAY, rating: 1, stabilityAfter: 0.4 },
      ],
    });
    expect(parsed?.desiredRetention).toBe(0.85);
    expect(parsed?.reviews.map((review) => review.logId)).toEqual(['a', 'b']);
  });
});
