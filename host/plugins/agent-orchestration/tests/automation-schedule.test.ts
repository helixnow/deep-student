import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HEARTBEAT_INTERVAL_MINUTES, type AutomationSchedule, type ScheduleAutomation,
  computeNextTrigger, formatTimestampMillis, isDue, normalizeScheduleShape, parseLastRunAt,
  parseTimeHhmm, validateAutomationFields, validateSchedule, weeklyEffectiveWeekdays,
} from '../src/automation-schedule.ts';

function localAt(year: number, month: number, day: number, hour: number, minute: number): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

function schedule(kind: AutomationSchedule['kind'], time: string, overrides: Partial<AutomationSchedule> = {}): AutomationSchedule {
  return {
    kind, time, weekday: null, weekdays: null, day_of_month: null,
    interval_minutes: null, date: null, timezone: null, ...overrides,
  };
}

function sampleDaily(time: string, overrides: Partial<ScheduleAutomation> = {}): ScheduleAutomation {
  return {
    enabled: true, created_at: formatTimestampMillis(Date.now()), next_run_at: null, last_run_at: null,
    schedule: schedule('daily', time), ...overrides,
  };
}

function sampleInterval(minutes: number): ScheduleAutomation {
  return {
    enabled: true, created_at: formatTimestampMillis(Date.now()), next_run_at: null, last_run_at: null,
    schedule: schedule('interval', '', { interval_minutes: minutes }),
  };
}

describe('automations.rs schedule parsing and validation', () => {
  it('parse_time_accepts_hhmm', () => {
    expect(parseTimeHhmm('09:30')).toEqual({ hour: 9, minute: 30 });
    expect(parseTimeHhmm(' 23:59\n')).toEqual({ hour: 23, minute: 59 });
  });

  it('parse_time_accepts_24_hour_boundaries', () => {
    expect(parseTimeHhmm('00:00')).toEqual({ hour: 0, minute: 0 });
    expect(parseTimeHhmm('23:59')).toEqual({ hour: 23, minute: 59 });
    expect(() => parseTimeHhmm('24:00')).toThrow();
    expect(() => parseTimeHhmm('23:60')).toThrow();
  });

  it('parse_time_rejects_non_hhmm_shapes', () => {
    for (const invalid of ['', '9:30', '09:3', '009:30', '09:030', '09-30', '09:30:00', '09 :30', '０９:３０']) {
      expect(() => parseTimeHhmm(invalid), invalid).toThrow();
    }
  });

  it('parse_last_run_at_preserves_rfc3339_timezone_instant', () => {
    expect(parseLastRunAt('2026-07-08T09:30:00+08:00')).toBe(Date.UTC(2026, 6, 8, 1, 30));
  });

  it('validate_schedule_daily_rejects_weekday', () => {
    expect(() => validateSchedule(schedule('daily', '08:00', { weekday: 1 }))).toThrow('weekday must not be set');
  });

  it('validate_schedule_weekly_requires_weekday', () => {
    expect(() => validateSchedule(schedule('weekly', '08:00'))).toThrow('weekday is required');
  });

  it('normalize_schedule_shape_weekly_canonicalizes', () => {
    const multi = schedule('weekly', '08:00', { weekdays: [5, 3, 1, 3] });
    normalizeScheduleShape(multi);
    expect(multi.weekday).toBe(1);
    expect(multi.weekdays).toEqual([1, 3, 5]);

    const single = schedule('weekly', '08:00', { weekdays: [4] });
    normalizeScheduleShape(single);
    expect(single.weekday).toBe(4);
    expect(single.weekdays).toBeNull();

    const plain = schedule('weekly', '08:00', { weekday: 2 });
    normalizeScheduleShape(plain);
    expect(plain.weekday).toBe(2);
    expect(plain.weekdays).toBeNull();

    const daily = schedule('daily', '08:00');
    normalizeScheduleShape(daily);
    expect(daily.weekday).toBeNull();
    expect(daily.weekdays).toBeNull();
  });

  it('validate_name_and_prompt_limits', () => {
    expect(() => validateAutomationFields('', 'ok')).toThrow();
    expect(() => validateAutomationFields('x', 'a'.repeat(4001))).toThrow();
    expect(() => validateAutomationFields('n'.repeat(101), 'ok')).toThrow();
    expect(() => validateAutomationFields('ok', 'prompt')).not.toThrow();
  });

  it('weekly_effective_weekdays_prefers_the_set', () => {
    expect(weeklyEffectiveWeekdays(schedule('weekly', '08:00', { weekday: 6, weekdays: [5, 3, 3, 1] }))).toEqual([1, 3, 5]);
    expect(weeklyEffectiveWeekdays(schedule('weekly', '08:00', { weekday: 6 }))).toEqual([6]);
    expect(weeklyEffectiveWeekdays(schedule('weekly', '08:00'))).toBeNull();
  });
});

describe('automations.rs due checks and next triggers', () => {
  it('is_due_daily_before_time', () => {
    expect(isDue(sampleDaily('09:00'), localAt(2026, 7, 8, 8, 30), null)).toBe(false);
  });

  it('is_due_daily_after_time_never_run', () => {
    expect(isDue(sampleDaily('09:00'), localAt(2026, 7, 8, 10, 0), null)).toBe(true);
  });

  it('is_due_daily_already_ran_today', () => {
    expect(isDue(sampleDaily('09:00'), localAt(2026, 7, 8, 10, 0), localAt(2026, 7, 8, 9, 5))).toBe(false);
  });

  it('is_due_daily_catch_up_after_offline_same_day', () => {
    expect(isDue(sampleDaily('09:00'), localAt(2026, 7, 8, 11, 0), localAt(2026, 7, 7, 9, 5))).toBe(true);
  });

  it('is_due_weekly_wrong_weekday', () => {
    const auto = sampleDaily('09:00');
    auto.schedule = schedule('weekly', '09:00', { weekday: 1 });
    // 2026-07-08 is Wednesday.
    expect(isDue(auto, localAt(2026, 7, 8, 10, 0), null)).toBe(false);
  });

  it('is_due_weekly_on_scheduled_day', () => {
    const auto = sampleDaily('09:00');
    auto.schedule = schedule('weekly', '09:00', { weekday: 3 });
    expect(isDue(auto, localAt(2026, 7, 8, 10, 0), null)).toBe(true);
  });

  it('compute_next_trigger_daily_later_today', () => {
    expect(computeNextTrigger(schedule('daily', '18:00'), localAt(2026, 7, 8, 10, 0)))
      .toBe(localAt(2026, 7, 8, 18, 0));
  });

  it('compute_next_trigger_daily_tomorrow', () => {
    expect(computeNextTrigger(schedule('daily', '08:00'), localAt(2026, 7, 8, 10, 0)))
      .toBe(localAt(2026, 7, 9, 8, 0));
  });
});

describe('automations.rs interval and once schedules', () => {
  it('validate_schedule_interval_bounds', () => {
    const value = schedule('interval', '', { interval_minutes: 30 });
    expect(() => validateSchedule(value)).not.toThrow();
    value.interval_minutes = 4;
    expect(() => validateSchedule(value)).toThrow();
    value.interval_minutes = 1441;
    expect(() => validateSchedule(value)).toThrow();
    value.interval_minutes = null;
    expect(() => validateSchedule(value)).toThrow();
    value.interval_minutes = 30;
    value.weekday = 1;
    expect(() => validateSchedule(value)).toThrow();
  });

  it('validate_schedule_daily_rejects_interval_minutes', () => {
    expect(() => validateSchedule(schedule('daily', '08:00', { interval_minutes: 30 }))).toThrow();
  });

  it('is_due_interval_never_run_waits_until_next_run', () => {
    const auto = sampleInterval(30);
    auto.next_run_at = formatTimestampMillis(localAt(2026, 7, 8, 10, 30));
    expect(isDue(auto, localAt(2026, 7, 8, 10, 0), null)).toBe(false);
    expect(isDue(auto, localAt(2026, 7, 8, 10, 31), null)).toBe(true);
  });

  it('is_due_interval_within_interval_not_due', () => {
    expect(isDue(sampleInterval(30), localAt(2026, 7, 8, 10, 0), localAt(2026, 7, 8, 9, 45))).toBe(false);
  });

  it('is_due_interval_after_interval_is_due', () => {
    expect(isDue(sampleInterval(30), localAt(2026, 7, 8, 10, 0), localAt(2026, 7, 8, 9, 30))).toBe(true);
    expect(isDue(sampleInterval(30), localAt(2026, 7, 8, 10, 0), localAt(2026, 7, 8, 9, 0))).toBe(true);
  });

  it('is_due_interval_disabled_never_due', () => {
    const auto = sampleInterval(30);
    auto.enabled = false;
    expect(isDue(auto, localAt(2026, 7, 8, 10, 0), null)).toBe(false);
  });

  it('compute_next_trigger_interval_adds_minutes', () => {
    expect(computeNextTrigger(schedule('interval', '', { interval_minutes: 45 }), localAt(2026, 7, 8, 10, 0)))
      .toBe(localAt(2026, 7, 8, 10, 45));
    expect(computeNextTrigger(schedule('interval', ''), localAt(2026, 7, 8, 10, 0)))
      .toBe(localAt(2026, 7, 8, 10, 0) + DEFAULT_HEARTBEAT_INTERVAL_MINUTES * 60_000);
  });

  it('validate_schedule_once_requires_valid_future_date', () => {
    expect(() => validateSchedule(schedule('once', '09:00'))).toThrow('date');
    expect(() => validateSchedule(schedule('once', '09:00', { date: '2999-13-01' }))).toThrow();
    expect(() => validateSchedule(schedule('once', '09:00', { date: 'not-a-date' }))).toThrow();
    expect(() => validateSchedule(schedule('once', '09:00', { date: '2020-01-01' }))).toThrow('already passed');
    expect(() => validateSchedule(schedule('once', '09:00', { date: '2999-01-01' }))).not.toThrow();
    expect(() => validateSchedule(schedule('daily', '09:00', { date: '2999-01-01' }))).toThrow('only allowed for once');
    expect(() => validateSchedule(schedule('once', '09:00', { date: '2999-01-01', weekday: 1 }))).toThrow();
  });

  it('compute_next_trigger_once_returns_fixed_instant', () => {
    const once = schedule('once', '09:00', { date: '2026-08-01', timezone: 'UTC' });
    const expected = Date.UTC(2026, 7, 1, 9, 0);
    expect(computeNextTrigger(once, Date.UTC(2026, 6, 1))).toBe(expected);
    expect(computeNextTrigger(once, Date.UTC(2026, 8, 1))).toBe(expected);
  });

  it('monthly_schedule_uses_month_end_and_honors_timezone', () => {
    const monthly = schedule('monthly', '09:00', { day_of_month: 31, timezone: 'UTC' });
    expect(computeNextTrigger(monthly, Date.UTC(2026, 1, 27, 12, 0))).toBe(Date.UTC(2026, 1, 28, 9, 0));
  });

  it('weekdays_schedule_skips_weekend', () => {
    const weekdays = schedule('weekdays', '09:00', { timezone: 'UTC' });
    expect(computeNextTrigger(weekdays, Date.UTC(2026, 6, 17, 12, 0))).toBe(Date.UTC(2026, 6, 20, 9, 0));
  });

  it('dst_gap_moves_to_the_first_valid_local_minute', () => {
    const gap = schedule('daily', '02:30', { timezone: 'America/New_York' });
    expect(computeNextTrigger(gap, Date.UTC(2026, 2, 8, 5, 0))).toBe(Date.UTC(2026, 2, 8, 7, 0));
  });
});
