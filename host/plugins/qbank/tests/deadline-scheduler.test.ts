import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeadlineScheduler } from '../src/deadline-scheduler.ts';
import type { PracticeAttempt, PracticeDraft } from '../api.ts';

function draft(id: string, deadline: string | null): PracticeDraft {
  return {
    id, scope_id: 'exam_1', paper_id: null, title: id, mode: 'timed', questions: [],
    answers: {}, marked_ids: [], current_index: 0, elapsed_seconds: 0,
    duration_seconds: 60, deadline, revision: 1,
    created_at: '2026-01-01T00:00:00+00:00', updated_at: '2026-01-01T00:00:00+00:00',
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('qbank_practice.rs::schedule_deadline', () => {
  it('schedule_deadline_truncates_rfc3339_to_whole_seconds_and_adds_three', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.500Z'));
    const calls: string[] = [];
    const scheduler = new DeadlineScheduler({
      loadDeadlineDrafts: async () => [],
      submitLatestRevision: async (id): Promise<PracticeAttempt> => {
        calls.push(`submit:${id}`);
        return { id } as PracticeAttempt;
      },
      emitUpdated: id => { calls.push(`emit:${id}`); },
      startGrading: () => { calls.push('start-grading'); },
    });
    scheduler.schedule(draft('practice_1', '2026-01-01T00:00:10.900+00:00'));

    await vi.advanceTimersByTimeAsync(12_999);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(['submit:practice_1', 'emit:practice_1', 'start-grading']);
    scheduler.dispose();
  });

  it('schedule_deadline_registers_once_per_draft_and_ignores_invalid_deadlines', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const submitted: string[] = [];
    const scheduler = new DeadlineScheduler({
      loadDeadlineDrafts: async () => [],
      submitLatestRevision: async id => {
        submitted.push(id);
        return { id } as PracticeAttempt;
      },
      emitUpdated: () => undefined,
      startGrading: () => undefined,
    });
    scheduler.schedule(draft('practice_1', '2026-01-01T00:00:01+00:00'));
    scheduler.schedule(draft('practice_1', '2026-01-01T00:00:01+00:00'));
    scheduler.schedule(draft('practice_2', 'not-a-date'));
    scheduler.schedule(draft('practice_3', null));

    await vi.advanceTimersByTimeAsync(4_000);
    expect(submitted).toEqual(['practice_1']);
    scheduler.dispose();
  });

  it('resume_deadline_drafts_schedules_every_persisted_deadline_once', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const submitted: string[] = [];
    const scheduler = new DeadlineScheduler({
      loadDeadlineDrafts: async () => [
        draft('practice_1', '2026-01-01T00:00:01+00:00'),
        draft('practice_2', '2026-01-01T00:00:02+00:00'),
        draft('practice_3', null),
      ],
      submitLatestRevision: async id => {
        submitted.push(id);
        return { id } as PracticeAttempt;
      },
      emitUpdated: () => undefined,
      startGrading: () => undefined,
    });

    await scheduler.resume();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(submitted).toEqual(['practice_1', 'practice_2']);
    scheduler.dispose();
  });

  it('dispose_clears_pending_deadline_timers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const submitted: string[] = [];
    const scheduler = new DeadlineScheduler({
      loadDeadlineDrafts: async () => [],
      submitLatestRevision: async id => {
        submitted.push(id);
        return { id } as PracticeAttempt;
      },
      emitUpdated: () => undefined,
      startGrading: () => undefined,
    });
    scheduler.schedule(draft('practice_1', '2026-01-01T00:00:01+00:00'));
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(submitted).toEqual([]);
  });
});
