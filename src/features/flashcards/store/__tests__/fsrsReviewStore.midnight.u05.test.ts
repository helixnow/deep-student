import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('../../events', () => ({
  requestFlashcardsDueRefresh: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import { requestFlashcardsDueRefresh } from '../../events';
import {
  FSRS_DUE_REFRESH_EVENT,
  formatLocalDateKey,
  formatLogicalDateKey,
  msUntilNextDayBoundary,
  stopFsrsDayRolloverTimer,
  useFsrsReviewStore,
} from '../fsrsReviewStore';

const invokeMock = vi.mocked(invoke);
const refreshDueMock = vi.mocked(requestFlashcardsDueRefresh);

function resetFsrsStore() {
  stopFsrsDayRolloverTimer();
  useFsrsReviewStore.setState({
    screen: 'today',
    sessionMode: null,
    dayRolloverHour: 4,
    dueDateKey: null,
    dueLogicalDayKey: null,
    learnAheadMinutes: 15,
    maxAnswerMs: 60_000,
    dueCards: [],
    dueTotal: 0,
    queue: [],
    queueIndex: 0,
    flipped: false,
    flippedAtMs: null,
    loading: false,
    ratingBusy: false,
    error: null,
    errorKind: null,
    lastRated: null,
    lastReview: null,
    reviewHistory: [],
    lastSuspended: null,
    retryBatchRequest: null,
    sessionRatedCount: 0,
    sessionAgainCount: 0,
    sessionAgainCardIds: [],
    sessionRatingCounts: { 1: 0, 2: 0, 3: 0, 4: 0 },
    sessionStreak: 0,
    sessionBestStreak: 0,
    sessionStartedAtMs: null,
    remainingDueAfterSession: null,
    ratingPreviews: null,
    lastSchedule: null,
    recentLocalLogIds: [],
    pendingExternalRateIds: [],
    pendingRateOp: null,
  });
}

describe('U05 fsrsReviewStore midnight crossover & cross-timezone date boundaries', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    refreshDueMock.mockClear();
    resetFsrsStore();
  });

  afterEach(() => {
    stopFsrsDayRolloverTimer();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetFsrsStore();
  });

  it('computes local calendar & logical FSRS day keys with zero UTC off-by-one across UTC-5 and UTC+9', () => {
    // UTC-5 (America/New_York): local 2026-11-25 23:58 -> UTC 2026-11-26 04:58
    const ny2358 = new Date('2026-11-26T04:58:00.000Z');
    const ny0005 = new Date('2026-11-26T05:05:00.000Z');
    expect(ny2358.toISOString().slice(0, 10)).toBe('2026-11-26');
    expect(formatLocalDateKey(ny2358, -300)).toBe('2026-11-25');
    expect(formatLocalDateKey(ny0005, -300)).toBe('2026-11-26');
    expect(formatLogicalDateKey(ny2358, 0, -300)).toBe('2026-11-25');
    expect(formatLogicalDateKey(ny0005, 0, -300)).toBe('2026-11-26');
    // With rolloverHour=4, 00:05 is still logical 2026-11-25; 04:05 switches to 2026-11-26
    expect(formatLogicalDateKey(ny0005, 4, -300)).toBe('2026-11-25');
    expect(formatLogicalDateKey(new Date('2026-11-26T09:05:00.000Z'), 4, -300)).toBe('2026-11-26');

    // UTC+9 (Asia/Tokyo): local 2026-11-26 00:05 -> UTC 2026-11-25 15:05
    const tokyo2358 = new Date('2026-11-25T14:58:00.000Z');
    const tokyo0005 = new Date('2026-11-25T15:05:00.000Z');
    expect(tokyo0005.toISOString().slice(0, 10)).toBe('2026-11-25');
    expect(formatLocalDateKey(tokyo2358, 540)).toBe('2026-11-25');
    expect(formatLocalDateKey(tokyo0005, 540)).toBe('2026-11-26');
    expect(formatLogicalDateKey(tokyo2358, 0, 540)).toBe('2026-11-25');
    expect(formatLogicalDateKey(tokyo0005, 0, 540)).toBe('2026-11-26');
    expect(formatLogicalDateKey(tokyo0005, 4, 540)).toBe('2026-11-25');
    expect(formatLogicalDateKey(new Date('2026-11-25T19:05:00.000Z'), 4, 540)).toBe('2026-11-26');
  });

  it.each([
    { tz: 'America/New_York', at2358Iso: '2026-11-26T04:58:00.000Z' },
    { tz: 'Asia/Tokyo', at2358Iso: '2026-11-25T14:58:00.000Z' },
  ])('auto-refreshes due queue & Today count when virtual clock crosses 23:58 -> 00:05 in $tz', async ({
    tz,
    at2358Iso,
  }) => {
    vi.stubEnv('TZ', tz);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(at2358Iso));

    const events: Event[] = [];
    const listener = (e: Event) => events.push(e);
    window.addEventListener(FSRS_DUE_REFRESH_EVENT, listener);

    try {
      let dayPhase: 'before' | 'after' = 'before';
      invokeMock.mockImplementation(async (cmd: string) => {
        if (cmd === 'fsrs_get_scheduler_config') {
          return { learnAheadMinutes: 15, maxAnswerSeconds: 60, dayRolloverHour: 0 };
        }
        if (cmd === 'fsrs_get_due') {
          return dayPhase === 'before'
            ? []
            : [
                { id: 'state-day2-1', ankiCardId: 'card-1', front: 'New Day Q1', back: 'A1' },
                { id: 'state-day2-2', ankiCardId: 'card-2', front: 'New Day Q2', back: 'A2' },
              ];
        }
        if (cmd === 'fsrs_get_stats') {
          return dayPhase === 'before' ? { due: 0 } : { due: 2 };
        }
        return null;
      });

      const ok = await useFsrsReviewStore.getState().loadDue();
      expect(ok).toBe(true);
      expect(useFsrsReviewStore.getState().dueDateKey).toBe('2026-11-25');
      expect(useFsrsReviewStore.getState().dueLogicalDayKey).toBe('2026-11-25');
      expect(useFsrsReviewStore.getState().dueTotal).toBe(0);
      expect(useFsrsReviewStore.getState().dueCards).toHaveLength(0);

      // Next boundary from 23:58 is ~2 minutes away
      const waitMs = msUntilNextDayBoundary(new Date(), 0);
      expect(waitMs).toBeGreaterThan(119_000);
      expect(waitMs).toBeLessThan(125_000);

      // Advance across midnight: 23:58 -> 00:05 (+7 minutes)
      dayPhase = 'after';
      await vi.advanceTimersByTimeAsync(7 * 60_000);

      const next = useFsrsReviewStore.getState();
      expect(next.dueDateKey).toBe('2026-11-26');
      expect(next.dueLogicalDayKey).toBe('2026-11-26');
      expect(next.dueTotal).toBe(2);
      expect(next.dueCards.map((c) => c.id)).toEqual(['state-day2-1', 'state-day2-2']);
      expect(refreshDueMock).toHaveBeenCalled();
      expect(events.length).toBeGreaterThanOrEqual(1);
    } finally {
      window.removeEventListener(FSRS_DUE_REFRESH_EVENT, listener);
    }
  });

  it('refreshes again across dayRolloverHour (03:58 -> 04:05) without clobbering an active session or zeroing on transient error', async () => {
    vi.stubEnv('TZ', 'Asia/Tokyo');
    vi.useFakeTimers();
    // 2026-11-26 03:58+09:00 (still logical day 2026-11-25 when dayRolloverHour = 4)
    vi.setSystemTime(new Date('2026-11-25T18:58:00.000Z'));

    let shouldFail = false;
    let rolledDueCount = 1;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (shouldFail) throw new Error('offline');
      if (cmd === 'fsrs_get_scheduler_config') {
        return { learnAheadMinutes: 15, maxAnswerSeconds: 60, dayRolloverHour: 4 };
      }
      if (cmd === 'fsrs_get_due') {
        return Array.from({ length: rolledDueCount }, (_, i) => ({
          id: `state-${i + 1}`,
          ankiCardId: `card-${i + 1}`,
          front: `Q${i + 1}`,
          back: `A${i + 1}`,
        }));
      }
      if (cmd === 'fsrs_get_stats') {
        return { due: rolledDueCount };
      }
      return null;
    });

    await useFsrsReviewStore.getState().loadDue();
    expect(useFsrsReviewStore.getState().dueDateKey).toBe('2026-11-26');
    expect(useFsrsReviewStore.getState().dueLogicalDayKey).toBe('2026-11-25');
    expect(useFsrsReviewStore.getState().dueTotal).toBe(1);

    // Start an active session before rollover
    useFsrsReviewStore.getState().startDueSession();
    expect(useFsrsReviewStore.getState().screen).toBe('session');
    expect(useFsrsReviewStore.getState().queue).toHaveLength(1);

    // First rollover attempt fails transiently -> must NOT zero out dueCards/dueTotal!
    shouldFail = true;
    await vi.advanceTimersByTimeAsync(7 * 60_000); // 04:05+09:00
    expect(useFsrsReviewStore.getState().dueTotal).toBe(1);
    expect(useFsrsReviewStore.getState().dueCards).toHaveLength(1);
    expect(useFsrsReviewStore.getState().queue).toHaveLength(1);
    expect(useFsrsReviewStore.getState().dueLogicalDayKey).toBe('2026-11-25');

    // Recover and call refreshIfDayRolledOver -> updates due bucket silently while keeping active queue intact
    shouldFail = false;
    rolledDueCount = 4;
    const refreshed = await useFsrsReviewStore.getState().refreshIfDayRolledOver();
    expect(refreshed).toBe(true);
    expect(useFsrsReviewStore.getState().dueLogicalDayKey).toBe('2026-11-26');
    expect(useFsrsReviewStore.getState().dueTotal).toBe(4);
    expect(useFsrsReviewStore.getState().screen).toBe('session');
    expect(useFsrsReviewStore.getState().queue).toHaveLength(1);
    expect(useFsrsReviewStore.getState().loading).toBe(false);
  });

  it('does not carry yesterday previousDueTotal across midnight when stats call fails on a capped batch', async () => {
    vi.stubEnv('TZ', 'America/New_York');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-26T04:58:00.000Z')); // 23:58-05:00 (2026-11-25)

    const fiftyCards = Array.from({ length: 50 }, (_, i) => ({
      id: `s-${i}`,
      ankiCardId: `c-${i}`,
      front: `Q${i}`,
      back: `A${i}`,
    }));

    let failStats = false;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'fsrs_get_scheduler_config') {
        return { learnAheadMinutes: 15, maxAnswerSeconds: 60, dayRolloverHour: 0 };
      }
      if (cmd === 'fsrs_get_due') return fiftyCards;
      if (cmd === 'fsrs_get_stats') {
        if (failStats) throw new Error('stats unavailable');
        return { due: 120 };
      }
      return null;
    });

    await useFsrsReviewStore.getState().loadDue();
    expect(useFsrsReviewStore.getState().dueTotal).toBe(120);

    // Same day stats failure keeps honest 120
    failStats = true;
    await useFsrsReviewStore.getState().loadDue();
    expect(useFsrsReviewStore.getState().dueTotal).toBe(120);

    // Next day (00:05-05:00) stats failure must NOT carry stale 120 from yesterday
    vi.setSystemTime(new Date('2026-11-26T05:05:00.000Z'));
    await useFsrsReviewStore.getState().loadDue();
    expect(useFsrsReviewStore.getState().dueDateKey).toBe('2026-11-26');
    expect(useFsrsReviewStore.getState().dueTotal).toBe(50);
  });
});
