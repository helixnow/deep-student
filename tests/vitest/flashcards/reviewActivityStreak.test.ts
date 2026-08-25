import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addDays,
  computeBestStreak,
  computeCurrentStreak,
  localDayKey,
} from '@/features/flashcards/hooks/useReviewActivity';

describe('flashcard review streaks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 25, 12));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts through today and consecutive local calendar days', () => {
    const today = new Date();
    const activeDays = new Set([
      localDayKey(today),
      localDayKey(addDays(today, -1)),
      localDayKey(addDays(today, -2)),
    ]);

    expect(computeCurrentStreak(activeDays, false)).toBe(3);
  });

  it('keeps a streak alive from yesterday and fills today from fsrs stats', () => {
    const today = new Date();
    const yesterday = localDayKey(addDays(today, -1));
    const dayBefore = localDayKey(addDays(today, -2));

    expect(computeCurrentStreak(new Set([yesterday, dayBefore]), false)).toBe(2);
    expect(computeCurrentStreak(new Set([yesterday, dayBefore]), true)).toBe(3);
  });

  it('stops at gaps and reports the longest historical run', () => {
    const today = new Date();
    const activeDays = new Set([
      localDayKey(today),
      localDayKey(addDays(today, -2)),
      localDayKey(addDays(today, -3)),
      localDayKey(addDays(today, -4)),
    ]);

    expect(computeCurrentStreak(activeDays, false)).toBe(1);
    expect(computeBestStreak(activeDays)).toBe(3);
  });
});
