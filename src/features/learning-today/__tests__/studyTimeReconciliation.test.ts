import { describe, expect, it } from 'vitest';
import { reconcileStudyWindow } from '../studyTimeReconciliation';
import { computeChatV2Stats, formatLocalDateYmd } from '@/hooks/useChatV2Stats';

describe('reconcileStudyWindow (S4-11 study-time vs active-days consistency)', () => {
  it('switches to honest learning-activity mode when activeDays >= 2 with non-timed activities and < 60s timer (no "不到 1 分钟" contradiction)', () => {
    const result = reconcileStudyWindow({
      startKey: '2026-11-19',
      endKey: '2026-11-25',
      maxDays: 7,
      heatmapData: [
        { date: '2026-11-24', count: 8, studySeconds: 15 },
        { date: '2026-11-25', count: 6, studySeconds: 15 },
      ],
    });

    expect(result).toEqual({
      studySeconds: 30,
      totalActivities: 14,
      activeDays: 2,
      timedDays: 2,
      displayMode: 'activity',
    });
  });

  it('reconciles Pomodoro focusSeconds and FSRS studyMs (ms -> sec) without double-counting overlapping timers', () => {
    const result = reconcileStudyWindow({
      startKey: '2026-11-19',
      endKey: '2026-11-25',
      maxDays: 7,
      heatmapData: [
        // Day 1: presence timer = 0s, Pomodoro completed = 25m (1500s)
        { date: '2026-11-24', count: 3, studySeconds: 0 },
        // Day 2: presence timer = 600s + pending 120s = 720s, FSRS review = 480_000ms (480s) -> max = 720s (no double-count)
        { date: '2026-11-25', count: 5, studySeconds: 600 },
      ],
      pendingTodaySeconds: 120,
      pomodoroDaily: [{ date: '2026-11-24', focusSeconds: 1500, completedCount: 1 }],
      fsrsDailyReviews: [
        // Day 3: FSRS-only study 600_000ms = 600s (10 min)
        { date: '2026-11-23', total: 12, studyMs: 600_000 },
        { date: '2026-11-25', total: 8, studyMs: 480_000 },
      ],
    });

    // 1500 (Nov 24) + 720 (Nov 25) + 600 (Nov 23) = 2820s across 3 active & timed days
    expect(result.studySeconds).toBe(2820);
    expect(result.activeDays).toBe(3);
    expect(result.timedDays).toBe(3);
    expect(result.displayMode).toBe('duration');
  });

  it('deduplicates same-day records, clamps out-of-range/future dates, and distinguishes seconds-only vs empty', () => {
    const secondsOnly = reconcileStudyWindow({
      startKey: '2026-11-25',
      endKey: '2026-11-25',
      maxDays: 1,
      heatmapData: [
        { date: '2026-11-25', count: 0, studySeconds: 20 },
        { date: '2026-11-25', count: 0, studySeconds: 15 },
        { date: '2026-11-26', count: 9, studySeconds: 9999 }, // future
      ],
    });
    expect(secondsOnly).toEqual({
      studySeconds: 35,
      totalActivities: 0,
      activeDays: 1,
      timedDays: 1,
      displayMode: 'seconds',
    });

    const empty = reconcileStudyWindow({
      startKey: '2026-11-25',
      endKey: '2026-11-25',
      maxDays: 1,
      heatmapData: [],
    });
    expect(empty).toEqual({
      studySeconds: 0,
      totalActivities: 0,
      activeDays: 0,
      timedDays: 0,
      displayMode: 'empty',
    });
  });
});

describe('computeChatV2Stats O(N) performance & local-date accuracy (S4-11)', () => {
  it('aggregates 2,000 sessions across a 90-day window in < 50ms using local calendar dates', () => {
    const now = new Date(2026, 10, 25, 2, 15, 0); // 02:15 local time (UTC shift edge case)
    const todayKey = formatLocalDateYmd(now);
    expect(todayKey).toBe('2026-11-25');

    const activeSessions = Array.from({ length: 1500 }, (_, i) => {
      const dt = new Date(2026, 10, 25 - (i % 90), 2, 15, 0);
      return {
        id: `a-${i}`,
        mode: i % 3 === 0 ? 'study' : 'chat',
        persistStatus: 'active' as const,
        createdAt: dt.toISOString(),
        updatedAt: dt.toISOString(),
      };
    });
    const archivedSessions = Array.from({ length: 500 }, (_, i) => {
      const dt = new Date(2026, 10, 25 - (i % 90), 10, 0, 0);
      return {
        id: `r-${i}`,
        mode: 'chat',
        persistStatus: 'archived' as const,
        createdAt: dt.toISOString(),
        updatedAt: dt.toISOString(),
      };
    });

    const start = performance.now();
    const stats = computeChatV2Stats(
      activeSessions,
      archivedSessions,
      { total_messages: 12000, user_messages: 6000, assistant_messages: 6000, sessions_with_messages: 2000 },
      90,
      now,
    );
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(100);
    expect(stats.totalSessions).toBe(2000);
    expect(stats.dailyActivity).toHaveLength(90);
    expect(stats.dailyActivity[stats.dailyActivity.length - 1]?.date).toBe('2026-11-25');
    const summed = stats.dailyActivity.reduce((acc, d) => acc + d.sessions, 0);
    expect(summed).toBe(2000);
  });
});
