import { describe, expect, it } from 'vitest';
import { parseRetentionInsights } from '@/features/flashcards/components/RetentionInsightsPanel';

describe('parseRetentionInsights', () => {
  it('reads the true retention table, distributions and study time', () => {
    const insights = parseRetentionInsights({
      dailyReviews: [
        { date: '2026-10-05', total: 3, studyMs: 120_000 },
        { date: '2026-10-04', total: 2, studyMs: 300_000 },
      ],
      trueRetention: [
        { period: 'today', youngReviews: 2, youngPassed: 1, matureReviews: 1, maturePassed: 1 },
        { period: 'bogus', youngReviews: 9 },
      ],
      memoryDistributions: { cards: 3, difficulty: [1, 2], stability: [3], retrievability: [0, 0, 0, 0, 0, 0, 0, 0, 1, 2] },
    }, '2026-10-05');
    expect(insights).not.toBeNull();
    expect(insights!.trueRetention).toEqual([
      { period: 'today', youngReviews: 2, youngPassed: 1, matureReviews: 1, maturePassed: 1 },
    ]);
    expect(insights!.distributions.difficulty).toHaveLength(10);
    expect(insights!.distributions.difficulty.slice(0, 3)).toEqual([1, 2, 0]);
    expect(insights!.distributions.stability).toHaveLength(9);
    expect(insights!.studyMsToday).toBe(120_000);
    expect(insights!.studyMsWeekAverage).toBe(60_000);
  });

  it('returns null for older backends without the new fields', () => {
    expect(parseRetentionInsights({ dailyReviews: [] }, '2026-10-05')).toBeNull();
    expect(parseRetentionInsights(null, '2026-10-05')).toBeNull();
  });
});
