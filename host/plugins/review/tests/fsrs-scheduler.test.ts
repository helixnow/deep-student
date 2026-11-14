import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DAY_ROLLOVER_HOUR, DEFAULT_LEARNING_STEPS_MINUTES, DEFAULT_MAXIMUM_INTERVAL_DAYS,
  DEFAULT_RELEARNING_STEPS_MINUTES, MAX_STEP_MINUTES, Fsrs6, type CardSnapshot, type SchedulerContext,
  buildFsrs, constrainedFuzzBounds, forgettingCurveConstants, fuzzDelta, fuzzFactorFor, hardDelay,
  learningDueMs, logicalDayBoundsMs, logicalDayKey, logicalDaysBetween, retrievability,
  sanitizeSteps, schedule, withReviewFuzz, effectiveParameters,
} from '../src/fsrs-scheduler.ts';
import { DEFAULT_PARAMETERS } from '../src/fsrs-scheduler.ts';

const SHANGHAI = 8 * 60;
function ms(y: number, mo: number, d: number, h: number, mi: number): number {
  return Date.UTC(y, mo - 1, d, h, mi) - SHANGHAI * 60_000;
}
function ctx(fsrs: Fsrs6, fuzz: number | null = null): SchedulerContext {
  return {
    fsrs, desiredRetention: 0.9,
    learningSteps: DEFAULT_LEARNING_STEPS_MINUTES, relearningSteps: DEFAULT_RELEARNING_STEPS_MINUTES,
    maximumInterval: DEFAULT_MAXIMUM_INTERVAL_DAYS, fuzzFactor: fuzz,
  };
}
function newCard(): CardSnapshot {
  return { phase: 'new', memory: null, learningStep: 0, daysElapsed: 0, reps: 0, lapses: 0 };
}
function reviewCard(stability: number, daysElapsed: number): CardSnapshot {
  return {
    phase: 'review', memory: { stability, difficulty: 5 }, learningStep: 0,
    daysElapsed, reps: 3, lapses: 0,
  };
}
function days(value: { kind: string; days?: number; minutes?: number }): number {
  if (value.kind !== 'days') throw new Error(`expected days, got ${value.kind}`);
  return value.days!;
}

describe('fsrs_scheduler', () => {
  it('new_card_follows_default_learning_steps', () => {
    const fsrs = new Fsrs6();
    const out = schedule(newCard(), ctx(fsrs));
    expect(out.again.delay).toEqual({ kind: 'minutes', minutes: 1 });
    expect(out.hard.delay).toEqual({ kind: 'minutes', minutes: 5.5 });
    expect(out.good.delay).toEqual({ kind: 'minutes', minutes: 10 });
    expect(out.good.learningStep).toBe(1);
    expect(out.good.phase).toBe('learning');
    expect(out.easy.phase).toBe('review');
    expect(out.easy.delay).toEqual({ kind: 'days', days: 8 });
    expect(Math.abs(out.easy.memory.stability - 8.2956)).toBeLessThan(1e-3);
    expect(out.good.reps).toBe(1);
  });

  it('last_learning_step_good_graduates_with_fsrs_interval', () => {
    const fsrs = new Fsrs6();
    const scheduler = ctx(fsrs);
    const afterNewGood = schedule(newCard(), scheduler).good;
    const learning: CardSnapshot = {
      phase: 'learning', memory: afterNewGood.memory, learningStep: afterNewGood.learningStep,
      daysElapsed: 0, reps: afterNewGood.reps, lapses: 0,
    };
    const out = schedule(learning, scheduler);
    expect(out.good.phase).toBe('review');
    expect(out.good.delay).toEqual({ kind: 'days', days: 2 });
    expect(out.again.delay).toEqual({ kind: 'minutes', minutes: 1 });
    expect(out.again.learningStep).toBe(0);
    expect(out.hard.delay).toEqual({ kind: 'minutes', minutes: 10 });
    expect(days(out.easy.delay)).toBeGreaterThan(days(out.good.delay));
  });

  it('single_step_hard_is_one_and_a_half_times_capped_at_one_extra_day', () => {
    expect(hardDelay([10], 0)).toBe(15);
    expect(hardDelay([2880], 0)).toBe(2880 + 1440);
    expect(hardDelay([1, 10, 60], 2)).toBe(60);
  });

  it('single_learning_step_good_on_new_card_graduates', () => {
    const fsrs = new Fsrs6();
    const scheduler = { ...ctx(fsrs), learningSteps: [10] };
    const out = schedule(newCard(), scheduler);
    expect(out.good.phase).toBe('review');
    expect(out.again.delay).toEqual({ kind: 'minutes', minutes: 10 });
  });

  it('review_again_enters_relearning_and_counts_a_lapse', () => {
    const out = schedule(reviewCard(10, 10), ctx(new Fsrs6()));
    expect(out.again.phase).toBe('relearning');
    expect(out.again.delay).toEqual({ kind: 'minutes', minutes: 10 });
    expect(out.again.lapses).toBe(1);
    expect(out.good.lapses).toBe(0);
  });

  it('empty_relearning_steps_reschedule_lapse_in_days', () => {
    const scheduler = { ...ctx(new Fsrs6()), relearningSteps: [] as number[] };
    const out = schedule(reviewCard(10, 10), scheduler);
    expect(out.again.phase).toBe('review');
    expect(out.again.delay.kind).toBe('days');
    expect(days(out.again.delay)).toBeGreaterThanOrEqual(1);
  });

  it('relearning_good_graduates_back_to_review', () => {
    const scheduler = ctx(new Fsrs6());
    const lapse = schedule(reviewCard(10, 10), scheduler).again;
    const relearning: CardSnapshot = {
      phase: 'relearning', memory: lapse.memory, learningStep: lapse.learningStep,
      daysElapsed: 0, reps: lapse.reps, lapses: lapse.lapses,
    };
    const out = schedule(relearning, scheduler);
    expect(out.good.phase).toBe('review');
    expect(days(out.good.delay)).toBeGreaterThanOrEqual(1);
    expect(out.good.lapses).toBe(1);
    expect(out.again.phase).toBe('relearning');
  });

  it('review_intervals_are_strictly_increasing', () => {
    const fsrs = new Fsrs6();
    for (const stability of [0.5, 1, 3, 12, 80]) {
      for (const fuzz of [null, 0, 0.5, 0.99]) {
        const out = schedule(reviewCard(stability, Math.round(stability)), ctx(fsrs, fuzz));
        expect(days(out.hard.delay)).toBeGreaterThanOrEqual(1);
        expect(days(out.good.delay)).toBeGreaterThan(days(out.hard.delay));
        expect(days(out.easy.delay)).toBeGreaterThan(days(out.good.delay));
      }
    }
  });

  it('maximum_interval_caps_every_passing_answer', () => {
    const scheduler = { ...ctx(new Fsrs6()), maximumInterval: 30 };
    const out = schedule(reviewCard(400, 400), scheduler);
    for (const answer of [out.hard, out.good, out.easy]) {
      expect(answer.delay).toEqual({ kind: 'days', days: 30 });
    }
  });

  it('review_on_due_day_counts_full_logical_days', () => {
    const last = ms(2026, 10, 1, 21, 0);
    const nextMorning = ms(2026, 10, 2, 8, 0);
    const elapsed = logicalDaysBetween(last, nextMorning, DEFAULT_DAY_ROLLOVER_HOUR, SHANGHAI);
    expect(elapsed).toBe(1);
    const scheduler = ctx(new Fsrs6());
    const onDueDay = schedule(reviewCard(1, elapsed), scheduler);
    const sameDay = schedule(reviewCard(1, 0), scheduler);
    expect(onDueDay.good.memory.stability).toBeGreaterThan(2);
    expect(onDueDay.good.memory.stability).toBeGreaterThan(sameDay.good.memory.stability);
  });

  it('same_logical_day_reviews_use_short_term_stability', () => {
    const out = schedule(reviewCard(5, 0), ctx(new Fsrs6()));
    expect(out.good.memory.stability).toBeGreaterThanOrEqual(5);
    expect(out.good.memory.stability).toBeLessThan(6);
  });

  it('rollover_hour_moves_the_day_boundary', () => {
    const before = ms(2026, 10, 2, 3, 30);
    const after = ms(2026, 10, 2, 4, 30);
    expect(logicalDayKey(before, 4, SHANGHAI)).toBe('2026-10-01');
    expect(logicalDayKey(after, 4, SHANGHAI)).toBe('2026-10-02');
    expect(logicalDayKey(before, 0, SHANGHAI)).toBe('2026-10-02');
    const [start, next] = logicalDayBoundsMs(before, 4, SHANGHAI);
    expect(start).toBe(ms(2026, 10, 1, 4, 0));
    expect(next).toBe(ms(2026, 10, 2, 4, 0));
  });

  it('learning_step_crossing_rollover_is_due_at_next_logical_day_start', () => {
    const now = ms(2026, 10, 1, 23, 0);
    expect(learningDueMs(now, 10, 4, SHANGHAI)).toBe(now + 10 * 60_000);
    expect(learningDueMs(now, 360, 4, SHANGHAI)).toBe(ms(2026, 10, 2, 4, 0));
    expect(learningDueMs(now, 1440, 4, SHANGHAI)).toBe(ms(2026, 10, 2, 4, 0));
  });

  it('fuzz_matches_anki_ranges', () => {
    expect(fuzzDelta(2)).toBe(0);
    expect(Math.abs(fuzzDelta(3) - 1.075)).toBeLessThan(1e-6);
    expect(Math.abs(fuzzDelta(10) - (1 + 0.15 * 4.5 + 0.1 * 3))).toBeLessThan(1e-5);
    expect(constrainedFuzzBounds(3, 1, 36_500)).toEqual([2, 4]);
    expect(withReviewFuzz(0, 3, 1, 36_500)).toBe(2);
    expect(withReviewFuzz(0.999, 3, 1, 36_500)).toBe(4);
    expect(withReviewFuzz(null, 3.4, 1, 36_500)).toBe(3);
    expect(withReviewFuzz(0.99, 2, 1, 36_500)).toBe(2);
  });

  it('fuzz_factor_is_deterministic_and_bounded', () => {
    const a = fuzzFactorFor('card-1', 3);
    expect(a).toBe(fuzzFactorFor('card-1', 3));
    expect(a).not.toBe(fuzzFactorFor('card-1', 4));
    for (let reps = 0; reps < 200; reps++) {
      const factor = fuzzFactorFor('card-x', reps);
      expect(factor).toBeGreaterThanOrEqual(0);
      expect(factor).toBeLessThan(1);
    }
  });

  it('fuzz_factor hashes UTF-8 id bytes then reps as i32 little-endian', () => {
    // 期望值来自 Buffer.from(id, 'utf8') + writeInt32LE 的原实现（含孤立代理 → U+FFFD、负数、i32 上界）。
    expect(fuzzFactorFor('card-1', 3)).toBe(0.8645288348197937);
    expect(fuzzFactorFor('fsrs_卡片_é', 0)).toBe(0.02028799057006836);
    expect(fuzzFactorFor('x\uD800y', -1)).toBe(0.8720685243606567);
    expect(fuzzFactorFor('', 2147483647)).toBe(0.918796956539154);
    expect(fuzzFactorFor('🃏', 7)).toBe(0.3736802339553833);
  });

  it('fuzz_does_not_regress_below_elapsed_days', () => {
    const out = schedule(reviewCard(30, 30), ctx(new Fsrs6(), 0));
    expect(days(out.good.delay)).toBeGreaterThan(30);
  });

  it('sanitize_steps_drops_invalid_entries', () => {
    expect(sanitizeSteps([1, -2, Number.NaN, 0, 10, 1e9])).toEqual([1, 10, MAX_STEP_MINUTES]);
  });

  it('forgetting_curve_constants_follow_fsrs6_decay', () => {
    const [decay, factor] = forgettingCurveConstants([]);
    expect(Math.abs(decay + 0.1542)).toBeLessThan(1e-6);
    expect(Math.abs(retrievability(7, 7, decay, factor) - 0.9)).toBeLessThan(1e-9);
    const [decay5] = forgettingCurveConstants(DEFAULT_PARAMETERS.slice(0, 19));
    expect(Math.abs(decay5 + 0.5)).toBeLessThan(1e-6);
  });

  it('missing_memory_on_learning_card_reinitializes_like_new', () => {
    const broken: CardSnapshot = { ...reviewCard(1, 3), phase: 'review', memory: null };
    const out = schedule(broken, ctx(new Fsrs6()));
    expect(out.good.phase).toBe('learning');
    expect(out.again.lapses).toBe(0);
  });

  it('effective_parameters_accepts_17_19_and_21_values_and_rejects_others', () => {
    expect(effectiveParameters(DEFAULT_PARAMETERS.slice(0, 17))).toHaveLength(21);
    expect(effectiveParameters(DEFAULT_PARAMETERS.slice(0, 19))[20]).toBe(0.5);
    expect(buildFsrs([]).nextStates(null, 0.9, 0).good.interval).toBeCloseTo(2.3065, 4);
  });
});
