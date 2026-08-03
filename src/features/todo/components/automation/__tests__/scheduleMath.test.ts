import { describe, expect, it } from 'vitest';

import type { AutomationSchedule } from '../../../../settings/components/automationSettingsApi';
import {
  computeNextRuns,
  describeSchedule,
  getEffectiveTimeZone,
  getZonedParts,
  isValidTime,
  isValidTimeZone,
} from '../scheduleMath';

// All fixtures pin an explicit timezone so results are host-independent.
const TZ = 'Asia/Shanghai'; // UTC+8, no DST
const UTC = 'UTC';

/** Wall-clock parts of `date` in the fixture zone, as 'YYYY-MM-DD HH:MM'. */
function wallClock(date: Date, timeZone = TZ): string {
  const p = getZonedParts(date, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** A fixed reference: 2026-07-19 16:00 Asia/Shanghai (= 08:00 UTC). */
const NOW = new Date('2026-07-19T08:00:00Z');

describe('validators', () => {
  it('accepts strict HH:MM and rejects loose formats', () => {
    expect(isValidTime('08:00')).toBe(true);
    expect(isValidTime('23:59')).toBe(true);
    expect(isValidTime('24:00')).toBe(false);
    expect(isValidTime('8:00')).toBe(false);
    expect(isValidTime('')).toBe(false);
  });

  it('validates IANA timezones', () => {
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('falls back to the system zone when timezone is missing or invalid', () => {
    const system = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(getEffectiveTimeZone({})).toBe(system);
    expect(getEffectiveTimeZone({ timezone: 'Not/AZone' })).toBe(system);
    expect(getEffectiveTimeZone({ timezone: TZ })).toBe(TZ);
  });
});

describe('computeNextRuns — daily', () => {
  it('runs today when the time has not yet passed', () => {
    const schedule: AutomationSchedule = { kind: 'daily', time: '20:00', timezone: TZ };
    const runs = computeNextRuns(schedule, 3, NOW);
    expect(runs.map((d) => wallClock(d))).toEqual([
      '2026-07-19 20:00',
      '2026-07-20 20:00',
      '2026-07-21 20:00',
    ]);
  });

  it('starts tomorrow when the time already passed today', () => {
    const schedule: AutomationSchedule = { kind: 'daily', time: '08:00', timezone: TZ };
    const runs = computeNextRuns(schedule, 2, NOW);
    expect(runs.map((d) => wallClock(d))).toEqual(['2026-07-20 08:00', '2026-07-21 08:00']);
  });

  it('returns [] for invalid time', () => {
    expect(computeNextRuns({ kind: 'daily', time: '25:00', timezone: TZ }, 3, NOW)).toEqual([]);
    expect(computeNextRuns({ kind: 'daily', time: '', timezone: TZ }, 3, NOW)).toEqual([]);
  });
});

describe('computeNextRuns — weekdays', () => {
  it('skips weekends (2026-07-19 is a Sunday in Asia/Shanghai)', () => {
    const schedule: AutomationSchedule = { kind: 'weekdays', time: '09:00', timezone: TZ };
    const runs = computeNextRuns(schedule, 3, NOW);
    expect(runs.map((d) => wallClock(d))).toEqual([
      '2026-07-20 09:00', // Monday
      '2026-07-21 09:00',
      '2026-07-22 09:00',
    ]);
  });

  it('bridges Friday to Monday', () => {
    // 2026-07-24 is a Friday; reference is 10:00 local, after the 09:00 slot.
    const friday = new Date('2026-07-24T02:00:00Z');
    const runs = computeNextRuns({ kind: 'weekdays', time: '09:00', timezone: TZ }, 2, friday);
    expect(runs.map((d) => wallClock(d))).toEqual(['2026-07-27 09:00', '2026-07-28 09:00']);
  });
});

describe('computeNextRuns — weekly', () => {
  it('honors the requested weekday (1 = Monday)', () => {
    const schedule: AutomationSchedule = { kind: 'weekly', time: '08:00', weekday: 1, timezone: TZ };
    const runs = computeNextRuns(schedule, 3, NOW);
    expect(runs.map((d) => wallClock(d))).toEqual([
      '2026-07-20 08:00',
      '2026-07-27 08:00',
      '2026-08-03 08:00',
    ]);
  });

  it('runs today (Sunday, weekday 0) when the time is still ahead', () => {
    const schedule: AutomationSchedule = { kind: 'weekly', time: '23:00', weekday: 0, timezone: TZ };
    const runs = computeNextRuns(schedule, 2, NOW);
    expect(runs.map((d) => wallClock(d))).toEqual(['2026-07-19 23:00', '2026-07-26 23:00']);
  });

  it('returns [] when weekday is missing or out of range', () => {
    expect(computeNextRuns({ kind: 'weekly', time: '08:00', timezone: TZ }, 3, NOW)).toEqual([]);
    expect(computeNextRuns({ kind: 'weekly', time: '08:00', weekday: 7, timezone: TZ }, 3, NOW)).toEqual([]);
  });
});

describe('computeNextRuns — monthly (short-month clamping)', () => {
  it('clamps day 31 to the last day of shorter months', () => {
    const schedule: AutomationSchedule = { kind: 'monthly', time: '10:00', dayOfMonth: 31, timezone: TZ };
    const runs = computeNextRuns(schedule, 4, NOW);
    expect(runs.map((d) => wallClock(d))).toEqual([
      '2026-07-31 10:00',
      '2026-08-31 10:00',
      '2026-09-30 10:00', // September clamped from 31 → 30
      '2026-10-31 10:00',
    ]);
  });

  it('clamps day 30/31 to Feb 28 in non-leap years and Feb 29 in leap years', () => {
    const janRef = new Date('2027-01-15T00:00:00Z');
    const runs = computeNextRuns({ kind: 'monthly', time: '10:00', dayOfMonth: 31, timezone: TZ }, 2, janRef);
    expect(runs.map((d) => wallClock(d))).toEqual(['2027-01-31 10:00', '2027-02-28 10:00']);

    const leapRef = new Date('2028-01-15T00:00:00Z');
    const leapRuns = computeNextRuns({ kind: 'monthly', time: '10:00', dayOfMonth: 31, timezone: TZ }, 2, leapRef);
    expect(leapRuns.map((d) => wallClock(d))).toEqual(['2028-01-31 10:00', '2028-02-29 10:00']);
  });

  it('returns [] for out-of-range dayOfMonth', () => {
    expect(computeNextRuns({ kind: 'monthly', time: '10:00', dayOfMonth: 0, timezone: TZ }, 3, NOW)).toEqual([]);
    expect(computeNextRuns({ kind: 'monthly', time: '10:00', dayOfMonth: 32, timezone: TZ }, 3, NOW)).toEqual([]);
  });
});

describe('computeNextRuns — interval', () => {
  it('ticks in absolute time from now', () => {
    const schedule: AutomationSchedule = { kind: 'interval', time: '', intervalMinutes: 60 };
    const runs = computeNextRuns(schedule, 3, NOW);
    expect(runs.map((d) => d.getTime() - NOW.getTime())).toEqual([3_600_000, 7_200_000, 10_800_000]);
  });

  it('rejects out-of-range intervals (5–1440)', () => {
    expect(computeNextRuns({ kind: 'interval', time: '', intervalMinutes: 4 }, 3, NOW)).toEqual([]);
    expect(computeNextRuns({ kind: 'interval', time: '', intervalMinutes: 1441 }, 3, NOW)).toEqual([]);
    expect(computeNextRuns({ kind: 'interval', time: '' }, 3, NOW)).toEqual([]);
  });
});

describe('computeNextRuns — once', () => {
  it('returns a single future run', () => {
    const schedule: AutomationSchedule = { kind: 'once', time: '09:30', date: '2026-08-01', timezone: TZ };
    const runs = computeNextRuns(schedule, 3, NOW);
    expect(runs).toHaveLength(1);
    expect(wallClock(runs[0])).toBe('2026-08-01 09:30');
  });

  it('returns [] when the instant is already in the past', () => {
    expect(
      computeNextRuns({ kind: 'once', time: '08:00', date: '2026-07-19', timezone: TZ }, 1, NOW),
    ).toEqual([]);
    expect(
      computeNextRuns({ kind: 'once', time: '08:00', date: '2020-01-01', timezone: TZ }, 1, NOW),
    ).toEqual([]);
  });

  it('returns [] for missing or malformed dates', () => {
    expect(computeNextRuns({ kind: 'once', time: '08:00', timezone: TZ }, 1, NOW)).toEqual([]);
    expect(computeNextRuns({ kind: 'once', time: '08:00', date: '2026-02-30', timezone: TZ }, 1, NOW)).toEqual([]);
    expect(computeNextRuns({ kind: 'once', time: '08:00', date: '2026/08/01', timezone: TZ }, 1, NOW)).toEqual([]);
  });
});

describe('computeNextRuns — explicit timezone semantics', () => {
  it('same wall time in different zones maps to different instants', () => {
    const shanghai = computeNextRuns({ kind: 'daily', time: '20:00', timezone: TZ }, 1, NOW)[0];
    const utc = computeNextRuns({ kind: 'daily', time: '20:00', timezone: UTC }, 1, NOW)[0];
    // 20:00 Asia/Shanghai = 12:00 UTC → the UTC run is 8h later.
    expect(utc.getTime() - shanghai.getTime()).toBe(8 * 3_600_000);
    expect(wallClock(utc, UTC)).toBe('2026-07-19 20:00');
  });

  it('crosses the date line correctly (tomorrow local is still today in UTC)', () => {
    // At NOW (08:00 UTC) it is 22:00 on 2026-07-19 in Pacific/Kiritimati (UTC+14),
    // so today's 08:00 has passed → next run is tomorrow local…
    const runs = computeNextRuns({ kind: 'daily', time: '08:00', timezone: 'Pacific/Kiritimati' }, 1, NOW);
    expect(wallClock(runs[0], 'Pacific/Kiritimati')).toBe('2026-07-20 08:00');
    // …which, across the date line, is still 2026-07-19 in UTC (08:00 − 14h = 18:00Z).
    expect(runs[0].toISOString()).toBe('2026-07-19T18:00:00.000Z');
  });

  it('resolves DST wall times per Intl (America/New_York, EDT in July)', () => {
    // At NOW (08:00 UTC) it is 04:00 EDT — today's 08:00 has not passed yet.
    const runs = computeNextRuns({ kind: 'daily', time: '08:00', timezone: 'America/New_York' }, 1, NOW);
    expect(wallClock(runs[0], 'America/New_York')).toBe('2026-07-19 08:00');
    // 08:00 EDT = 12:00 UTC (UTC−4 under DST, not the EST −5).
    expect(runs[0].toISOString()).toBe('2026-07-19T12:00:00.000Z');
  });

  it('returns [] for an invalid explicit timezone', () => {
    expect(computeNextRuns({ kind: 'daily', time: '08:00', timezone: 'Not/AZone' }, 3, NOW)).toEqual([]);
  });
});

describe('computeNextRuns — argument guards', () => {
  it('returns [] for non-positive counts', () => {
    expect(computeNextRuns({ kind: 'daily', time: '08:00', timezone: TZ }, 0, NOW)).toEqual([]);
    expect(computeNextRuns({ kind: 'daily', time: '08:00', timezone: TZ }, -1, NOW)).toEqual([]);
  });
});

describe('describeSchedule', () => {
  // Echo translator: returns "key|{json options}" so assertions can check
  // both the key and the interpolation payload without loading i18next.
  const t = (key: string, options?: Record<string, unknown>) =>
    options ? `${key}|${JSON.stringify(options)}` : key;

  it('describes each valid kind through the expected keys', () => {
    expect(describeSchedule({ kind: 'daily', time: '08:00' }, t)).toBe(
      'automation.scheduleEditor.describe.daily|{"time":"08:00"}',
    );
    expect(describeSchedule({ kind: 'weekly', time: '08:00', weekday: 1 }, t)).toBe(
      'automation.scheduleEditor.describe.weekly|{"weekday":"automation.scheduleEditor.weekdaysLong.1","time":"08:00"}',
    );
    expect(describeSchedule({ kind: 'interval', time: '', intervalMinutes: 30 }, t)).toBe(
      'automation.scheduleEditor.describe.interval|{"minutes":30}',
    );
    expect(describeSchedule({ kind: 'once', time: '09:30', date: '2026-08-01' }, t)).toBe(
      'automation.scheduleEditor.describe.once|{"date":"2026-08-01","time":"09:30"}',
    );
  });

  it('wraps a valid explicit timezone', () => {
    const result = describeSchedule({ kind: 'daily', time: '08:00', timezone: TZ }, t);
    expect(result).toContain('automation.scheduleEditor.describe.withTimezone');
    expect(result).toContain('"timezone":"Asia/Shanghai"');
  });

  it('falls back to the invalid key for incomplete schedules', () => {
    expect(describeSchedule({ kind: 'weekly', time: '08:00' }, t)).toBe(
      'automation.scheduleEditor.describe.invalid',
    );
    expect(describeSchedule({ kind: 'daily', time: 'nope' }, t)).toBe(
      'automation.scheduleEditor.describe.invalid',
    );
  });
});
