import type { AutomationSchedule } from '../../../settings/components/automationSettingsApi';

/**
 * Pure schedule math for {@link AutomationScheduleEditor}: next-run preview
 * computation and human-readable descriptions.
 *
 * Timezone / DST approach (Intl only, no external deps):
 * - Wall-clock components in a target IANA zone are read via
 *   `Intl.DateTimeFormat(...).formatToParts` with an explicit `timeZone`.
 * - The inverse mapping (wall time in zone -> UTC instant) uses an iterative
 *   guess-and-correct loop: start from the UTC interpretation of the wall
 *   time, read back what wall time that instant produces in the zone, and
 *   shift by the difference. Two passes converge for every fixed offset and
 *   for DST transitions.
 * - Precision trade-off around DST boundaries: for non-existent wall times
 *   (spring-forward gap) the result lands shifted by the DST delta, and for
 *   ambiguous wall times (fall-back overlap) Intl deterministically picks one
 *   of the two candidate offsets. Both cases follow the host Intl behavior
 *   and are within ±1h, which is acceptable for a "next runs" preview.
 */

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
}

/** Strict 24-hour `HH:MM` check. */
export function isValidTime(time: string): boolean {
  return TIME_RE.test(time);
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    // Throws RangeError for unknown IANA names.
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Effective zone: explicit valid `schedule.timezone`, else the system zone. */
export function getEffectiveTimeZone(schedule: Pick<AutomationSchedule, 'timezone'>): string {
  const tz = schedule.timezone?.trim();
  if (tz && isValidTimeZone(tz)) return tz;
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getPartsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    partsFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Wall-clock components of `date` as observed in `timeZone`. */
export function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = getPartsFormatter(timeZone).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const raw = parts.find((part) => part.type === type)?.value ?? '0';
    return Number.parseInt(raw, 10);
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // Some engines report midnight as "24" with hourCycle h23 quirks; normalize.
    hour: read('hour') % 24,
    minute: read('minute'),
  };
}

/**
 * Inverse mapping: the UTC instant at which `timeZone` shows the given wall
 * time. See the module docstring for DST-boundary precision notes.
 */
function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let utc = target;
  for (let pass = 0; pass < 2; pass += 1) {
    const observed = getZonedParts(new Date(utc), timeZone);
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      0,
      0,
    );
    utc += target - observedAsUtc;
  }
  return new Date(utc);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Weekday (0=Sunday..6=Saturday) of a calendar date; zone-independent. */
function weekdayOfCalendarDate(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function addDaysToCalendarDate(
  year: number,
  month: number,
  day: number,
  offset: number,
): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(year, month - 1, day + offset));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function parseTime(time: string): { hour: number; minute: number } | null {
  const match = TIME_RE.exec(time);
  if (!match) return null;
  return { hour: Number.parseInt(match[1], 10), minute: Number.parseInt(match[2], 10) };
}

function parseDate(date: string | undefined): { year: number; month: number; day: number } | null {
  const match = DATE_RE.exec(date ?? '');
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

function isValidIntervalMinutes(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 5 && value <= 1440;
}

function isValidDayOfMonth(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 31;
}

function isValidWeekday(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6;
}

/**
 * Next `count` run instants strictly after `now` (default: current time).
 * Returns `[]` for any invalid or incomplete schedule — callers (e.g. form
 * submit gating) can rely on `computeNextRuns(schedule, 1).length === 0`
 * as the single "schedule is not runnable" signal.
 */
export function computeNextRuns(schedule: AutomationSchedule, count: number, now?: Date): Date[] {
  if (!Number.isFinite(count) || count <= 0) return [];
  const reference = now ?? new Date();
  if (schedule.timezone?.trim() && !isValidTimeZone(schedule.timezone.trim())) return [];
  const timeZone = getEffectiveTimeZone(schedule);

  if (schedule.kind === 'interval') {
    if (!isValidIntervalMinutes(schedule.intervalMinutes)) return [];
    // Fixed intervals tick in absolute time, independent of wall clocks.
    const stepMs = schedule.intervalMinutes * 60_000;
    return Array.from({ length: count }, (_, index) => new Date(reference.getTime() + stepMs * (index + 1)));
  }

  const time = parseTime(schedule.time);
  if (!time) return [];

  if (schedule.kind === 'once') {
    const date = parseDate(schedule.date);
    if (!date) return [];
    const run = zonedWallTimeToUtc(date.year, date.month, date.day, time.hour, time.minute, timeZone);
    return run.getTime() > reference.getTime() ? [run] : [];
  }

  if (schedule.kind === 'monthly') {
    if (!isValidDayOfMonth(schedule.dayOfMonth)) return [];
    const start = getZonedParts(reference, timeZone);
    const runs: Date[] = [];
    // +2 months of slack covers the "requested day already passed" edge.
    for (let offset = 0; offset <= count + 2 && runs.length < count; offset += 1) {
      const monthIndex = start.month - 1 + offset;
      const year = start.year + Math.floor(monthIndex / 12);
      const month = (monthIndex % 12) + 1;
      // Short-month clamp: day 29-31 rolls back to the month's last day.
      const day = Math.min(schedule.dayOfMonth, daysInMonth(year, month));
      const run = zonedWallTimeToUtc(year, month, day, time.hour, time.minute, timeZone);
      if (run.getTime() > reference.getTime()) runs.push(run);
    }
    return runs;
  }

  if (schedule.kind === 'daily' || schedule.kind === 'weekdays' || schedule.kind === 'weekly') {
    if (schedule.kind === 'weekly' && !isValidWeekday(schedule.weekday)) return [];
    const start = getZonedParts(reference, timeZone);
    const runs: Date[] = [];
    // Weekly needs up to 7 days per hit; +8 days of slack is always enough.
    const maxOffset = count * 7 + 8;
    for (let offset = 0; offset <= maxOffset && runs.length < count; offset += 1) {
      const calendar = addDaysToCalendarDate(start.year, start.month, start.day, offset);
      const weekday = weekdayOfCalendarDate(calendar.year, calendar.month, calendar.day);
      if (schedule.kind === 'weekdays' && (weekday === 0 || weekday === 6)) continue;
      if (schedule.kind === 'weekly' && weekday !== schedule.weekday) continue;
      const run = zonedWallTimeToUtc(
        calendar.year,
        calendar.month,
        calendar.day,
        time.hour,
        time.minute,
        timeZone,
      );
      if (run.getTime() > reference.getTime()) runs.push(run);
    }
    return runs;
  }

  return [];
}

/**
 * Human-readable one-liner, e.g. "每周一 08:00（Asia/Shanghai）".
 * `t` must be bound to the `todo` namespace; keys live under
 * `automation.scheduleEditor.describe.*` / `.weekdaysLong.*`.
 * Incomplete schedules yield the `describe.invalid` string.
 */
export function describeSchedule(
  schedule: AutomationSchedule,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const P = 'automation.scheduleEditor';
  const invalid = () => t(`${P}.describe.invalid`);

  let base: string;
  switch (schedule.kind) {
    case 'daily':
      if (!isValidTime(schedule.time)) return invalid();
      base = t(`${P}.describe.daily`, { time: schedule.time });
      break;
    case 'weekdays':
      if (!isValidTime(schedule.time)) return invalid();
      base = t(`${P}.describe.weekdays`, { time: schedule.time });
      break;
    case 'weekly': {
      if (!isValidTime(schedule.time) || !isValidWeekday(schedule.weekday)) return invalid();
      const weekday = t(`${P}.weekdaysLong.${schedule.weekday}`);
      base = t(`${P}.describe.weekly`, { weekday, time: schedule.time });
      break;
    }
    case 'monthly':
      if (!isValidTime(schedule.time) || !isValidDayOfMonth(schedule.dayOfMonth)) return invalid();
      base = t(`${P}.describe.monthly`, { day: schedule.dayOfMonth, time: schedule.time });
      break;
    case 'interval':
      if (!isValidIntervalMinutes(schedule.intervalMinutes)) return invalid();
      base = t(`${P}.describe.interval`, { minutes: schedule.intervalMinutes });
      break;
    case 'once':
      if (!isValidTime(schedule.time) || !parseDate(schedule.date)) return invalid();
      base = t(`${P}.describe.once`, { date: schedule.date, time: schedule.time });
      break;
    default:
      return invalid();
  }

  const timezone = schedule.timezone?.trim();
  if (timezone && isValidTimeZone(timezone)) {
    return t(`${P}.describe.withTimezone`, { description: base, timezone });
  }
  return base;
}
