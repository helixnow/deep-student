import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import review from '../index.ts';
import { addLocalDays, localDateKey } from '../src/local-date.ts';
import {
  logicalDayBoundsMs,
  logicalDayKey,
  logicalDaysBetween,
} from '../src/fsrs-scheduler.ts';
import { FsrsReviewService } from '../src/review.ts';
import { schedulePlanAllRatings } from '../src/review-plan-fsrs.ts';
import type { ReviewPlan } from '../../vfs-repos/api.ts';
import { mistakesFixture, storageFixture } from './storage.ts';

const cleanups: (() => void)[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const fn of cleanups.splice(0)) fn();
});

function setupMistakes() {
  const fixture = mistakesFixture();
  cleanups.push(() => fixture.dispose());
  return { ...fixture, service: new FsrsReviewService(fixture.db) };
}

function insertCard(
  db: ReturnType<typeof mistakesFixture>['db'],
  taskId: string,
  cardId: string,
): void {
  db.run(
    `INSERT OR IGNORE INTO document_tasks (
      id, document_id, original_document_name, segment_index,
      content_segment, status, anki_generation_options_json
    ) VALUES (?1, 'doc-u05', 'u05.md', 0, 'seg', 'Completed', '{}')`,
    [taskId],
  );
  db.run(
    `INSERT INTO anki_cards (
      id, task_id, front, back, source_type, source_id
    ) VALUES (?1, ?2, ?3, ?4, 'document', 'doc-u05')`,
    [cardId, taskId, `front-${cardId}`, `back-${cardId}`],
  );
}

describe('U05 host/plugins/review midnight crossover & cross-timezone boundaries', () => {
  it('computes localDateKey, logicalDayKey, and logicalDaysBetween at 23:58 and 00:05 for UTC-5 and UTC+9 with zero off-by-one', () => {
    // UTC-5 (America/New_York): local 2026-11-25 23:58 -> UTC 2026-11-26 04:58
    const ny2358Ms = Date.UTC(2026, 10, 26, 4, 58, 0, 0);
    const ny0005Ms = Date.UTC(2026, 10, 26, 5, 5, 0, 0);
    expect(localDateKey(new Date(ny2358Ms), -300)).toBe('2026-11-25');
    expect(localDateKey(new Date(ny0005Ms), -300)).toBe('2026-11-26');
    expect(logicalDayKey(ny2358Ms, 0, -300)).toBe('2026-11-25');
    expect(logicalDayKey(ny0005Ms, 0, -300)).toBe('2026-11-26');
    expect(logicalDaysBetween(ny2358Ms, ny0005Ms, 0, -300)).toBe(1);
    expect(logicalDaysBetween(ny2358Ms, ny0005Ms, 4, -300)).toBe(0);

    // UTC+9 (Asia/Tokyo): local 2026-11-26 00:05 -> UTC 2026-11-25 15:05
    const tokyo2358Ms = Date.UTC(2026, 10, 25, 14, 58, 0, 0);
    const tokyo0005Ms = Date.UTC(2026, 10, 25, 15, 5, 0, 0);
    expect(localDateKey(new Date(tokyo2358Ms), 540)).toBe('2026-11-25');
    expect(localDateKey(new Date(tokyo0005Ms), 540)).toBe('2026-11-26');
    expect(logicalDayKey(tokyo2358Ms, 0, 540)).toBe('2026-11-25');
    expect(logicalDayKey(tokyo0005Ms, 0, 540)).toBe('2026-11-26');
    expect(logicalDaysBetween(tokyo2358Ms, tokyo0005Ms, 0, 540)).toBe(1);
    expect(logicalDaysBetween(tokyo2358Ms, tokyo0005Ms, 4, 540)).toBe(0);

    // Pure calendar arithmetic
    expect(addLocalDays('2026-11-25', 1)).toBe('2026-11-26');
    expect(addLocalDays('2026-11-26', -1)).toBe('2026-11-25');
  });

  it.each([
    {
      tz: 'America/New_York',
      at2358Iso: '2026-11-26T04:58:00.000Z',
      at0005Iso: '2026-11-26T05:05:00.000Z',
    },
    {
      tz: 'Asia/Tokyo',
      at2358Iso: '2026-11-25T14:58:00.000Z',
      at0005Iso: '2026-11-25T15:05:00.000Z',
    },
  ])('resets FSRS daily limits, due buckets, and review statistics cleanly across 23:58 -> 00:05 in $tz', ({
    tz,
    at2358Iso,
    at0005Iso,
  }) => {
    vi.stubEnv('TZ', tz);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(at2358Iso));

    const { db, service } = setupMistakes();
    // Set rolloverHour = 0 so local calendar midnight is the exact logical boundary,
    // and cap newPerDay = 1 to verify daily quota reset across midnight.
    service.updateSchedulerConfig({ dayRolloverHour: 0, newPerDay: 1, reviewsPerDay: 10 });
    insertCard(db, 'task-tz', 'card-a');
    insertCard(db, 'task-tz', 'card-b');
    const enq = service.enqueueCards(['card-a', 'card-b']);
    const stateA = enq.states.find((s) => s.ankiCardId === 'card-a')!.id;

    // At 23:58 local on 2026-11-25: 1 new card allowed today (card-b is backlogNew)
    expect(service.getStats().dueNew).toBe(1);
    expect(service.getStats().backlogNew).toBe(1);

    // Rate card-a (Easy -> graduates to Review due in future days)
    service.rate(stateA, 4, 1500, null);
    const statsBefore = service.getStats();
    expect(statsBefore.reviewsToday).toBe(1);
    expect(statsBefore.newRemainingToday).toBe(0);
    expect(statsBefore.due).toBe(0);

    const reviewStatsBefore = service.getReviewStatistics(7);
    expect(reviewStatsBefore.dailyReviews.map((d) => d.date)).toEqual(['2026-11-25']);
    expect(reviewStatsBefore.scheduledForecast[0]?.date).toBe('2026-11-26');

    // Advance 7 minutes past local midnight -> 00:05 on 2026-11-26
    vi.setSystemTime(new Date(at0005Iso));
    const statsAfter = service.getStats();
    expect(statsAfter.reviewsToday).toBe(0);
    expect(statsAfter.newRemainingToday).toBe(1);
    expect(statsAfter.dueNew).toBe(1);
    expect(statsAfter.due).toBe(1);

    const dueAfter = service.getDue(10);
    expect(dueAfter.map((c) => c.ankiCardId)).toEqual(['card-b']);

    // Rate card-b at 00:05 -> logged strictly under 2026-11-26 (zero off-by-one!)
    service.rate(dueAfter[0]!.id, 4, 1200, null);
    const reviewStatsAfter = service.getReviewStatistics(7);
    expect(reviewStatsAfter.dailyReviews.map((d) => ({ date: d.date, total: d.total }))).toEqual([
      { date: '2026-11-25', total: 1 },
      { date: '2026-11-26', total: 1 },
    ]);
    expect(reviewStatsAfter.scheduledForecast[0]?.date).toBe('2026-11-27');

    // Verify logicalDayBoundsMs spans exact local midnight
    const [start26, next27] = logicalDayBoundsMs(Date.now(), 0);
    expect(localDateKey(new Date(start26))).toBe('2026-11-26');
    expect(localDateKey(new Date(next27))).toBe('2026-11-27');
  });

  it('keeps ReviewPlan FSRS nextReviewDate exact across DST spring-forward (23:58) and fall-back (00:05) in America/New_York', () => {
    vi.stubEnv('TZ', 'America/New_York');

    const basePlan: ReviewPlan = {
      id: 'rp-dst',
      question_id: 'q-dst',
      exam_id: 'e-dst',
      ease_factor: 2.5,
      interval_days: 1,
      repetitions: 1,
      next_review_date: '2026-03-07',
      last_review_date: '2026-03-06',
      status: 'reviewing',
      total_reviews: 1,
      total_correct: 1,
      consecutive_failures: 0,
      is_difficult: false,
      created_at: '2026-03-01T00:00:00+00:00',
      updated_at: '2026-03-06T00:00:00+00:00',
    };

    // Spring-forward eve: 2026-03-07 23:58 EST (UTC-5); 2026-03-08 is a 23-hour day!
    const springEveMs = new Date('2026-03-08T04:58:00.000Z').getTime();
    const springOutcomes = schedulePlanAllRatings(
      basePlan,
      {
        stability: 1,
        difficulty: 5,
        phase: 'review',
        learning_step: 0,
        lapses: 0,
        due_at: springEveMs,
        last_review_at: springEveMs - 86_400_000,
      },
      springEveMs,
    );
    const springHard = springOutcomes[1]!;
    expect(springHard.intervalDays).toBeGreaterThanOrEqual(1);
    expect(springHard.nextReviewDate).toBe(addLocalDays('2026-03-07', springHard.intervalDays));

    // Fall-back morning: 2026-11-01 00:05 EDT (UTC-4); 2026-11-01 is a 25-hour day!
    const fallMorningMs = new Date('2026-11-01T04:05:00.000Z').getTime();
    const fallOutcomes = schedulePlanAllRatings(
      { ...basePlan, next_review_date: '2026-11-01', last_review_date: '2026-10-31' },
      {
        stability: 1,
        difficulty: 5,
        phase: 'review',
        learning_step: 0,
        lapses: 0,
        due_at: fallMorningMs,
        last_review_at: fallMorningMs - 86_400_000,
      },
      fallMorningMs,
    );
    const fallHard = fallOutcomes[1]!;
    expect(fallHard.intervalDays).toBeGreaterThanOrEqual(1);
    expect(fallHard.nextReviewDate).toBe(addLocalDays('2026-11-01', fallHard.intervalDays));
  });

  it('logs study_time_add to exact local calendar day at 23:58 and 00:05 across UTC-5 and UTC+9', async () => {
    const migration = readFileSync('resources/app/migrations/vfs/V20261006__study_time.sql', 'utf8');

    for (const { tz, at2358Iso, at0005Iso } of [
      { tz: 'America/New_York', at2358Iso: '2026-11-26T04:58:00.000Z', at0005Iso: '2026-11-26T05:05:00.000Z' },
      { tz: 'Asia/Tokyo', at2358Iso: '2026-11-25T14:58:00.000Z', at0005Iso: '2026-11-25T15:05:00.000Z' },
    ]) {
      vi.stubEnv('TZ', tz);
      vi.useFakeTimers({ toFake: ['Date'] });
      const f = storageFixture();
      cleanups.push(() => f.dispose());
      f.db.exec(migration);
      const host = await createTestHost({ plugins: [review], provide: { storage: f.storage } });
      try {
        vi.setSystemTime(new Date(at2358Iso));
        const dayBefore = (await host.invoke('study_time_add', { seconds: 120 })) as {
          date: string;
          seconds: number;
        };
        expect(dayBefore).toEqual({ date: '2026-11-25', seconds: 120 });

        vi.setSystemTime(new Date(at0005Iso));
        const dayAfter = (await host.invoke('study_time_add', { seconds: 180 })) as {
          date: string;
          seconds: number;
        };
        expect(dayAfter).toEqual({ date: '2026-11-26', seconds: 180 });
      } finally {
        await host.dispose();
      }
    }
  });
});
