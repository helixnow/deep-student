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
 * - DST boundaries mirror the backend slot builder (`scheduled_slot_on_date`
 *   in src-tauri/src/chat_v2/automations.rs): non-existent wall times
 *   (spring-forward gap) roll forward to the first existing minute (backend
 *   scans 0..=180 minutes), and ambiguous wall times (fall-back overlap)
 *   resolve to the EARLIER of the two instants (chrono `.earliest()`).
 */

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Interval bounds, mirroring backend MIN_/MAX_INTERVAL_MINUTES. */
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 1440;

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
 * All UTC instants (sorted ascending) at which `timeZone` shows exactly the
 * given wall time: one for normal times, two for fall-back overlaps, zero
 * for spring-forward gaps. Offsets are probed a day before/after the target
 * so both sides of any transition are covered.
 */
function utcInstantsForWallTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number[] {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const offsets = new Set<number>();
  for (const probeShift of [-86_400_000, 0, 86_400_000]) {
    const probe = target + probeShift;
    const observed = getZonedParts(new Date(probe), timeZone);
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      0,
      0,
    );
    offsets.add(observedAsUtc - probe);
  }
  const instants: number[] = [];
  for (const offset of offsets) {
    const candidate = target - offset;
    const observed = getZonedParts(new Date(candidate), timeZone);
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      0,
      0,
    );
    if (observedAsUtc === target) instants.push(candidate);
  }
  return instants.sort((a, b) => a - b);
}

/**
 * Inverse mapping: the UTC instant at which `timeZone` shows the given wall
 * time, matching the backend slot builder (`scheduled_slot_on_date`):
 * - Fall-back overlap (two instants): the EARLIER one wins (chrono
 *   `.earliest()` semantics).
 * - Spring-forward gap (no instant): roll forward minute by minute, up to
 *   180 minutes, to the first wall time that exists (backend scans 0..=180).
 */
function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  for (let shiftMinutes = 0; shiftMinutes <= 180; shiftMinutes += 1) {
    // Date.UTC normalizes minute overflow, so day/month rollovers are safe.
    const shifted = new Date(Date.UTC(year, month - 1, day, hour, minute + shiftMinutes, 0, 0));
    const instants = utcInstantsForWallTime(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth() + 1,
      shifted.getUTCDate(),
      shifted.getUTCHours(),
      shifted.getUTCMinutes(),
      timeZone,
    );
    if (instants.length > 0) return new Date(instants[0]);
  }
  // Unreachable for real IANA zones (no gap exceeds 3h); mirror the naive
  // UTC interpretation as a defensive fallback.
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
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
  return (
    typeof value === 'number'
    && Number.isFinite(value)
    && value >= MIN_INTERVAL_MINUTES
    && value <= MAX_INTERVAL_MINUTES
  );
}

function isValidDayOfMonth(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 31;
}

function isValidWeekday(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6;
}

/**
 * weekly 实际生效的星期集合（升序去重）：非空且全部合法的 `weekdays` 优先，
 * 否则回退单数 `weekday`；两者皆不可用返回 null（调度不可运行）。
 * 与后端 `weekly_effective_weekdays` / validate_schedule 的口径一致：
 * weekdays 显式提供但含非法值时整体视为无效（不静默截断）。
 */
function effectiveWeeklyWeekdays(
  schedule: Pick<AutomationSchedule, 'weekday' | 'weekdays'>,
): number[] | null {
  if (schedule.weekdays !== undefined) {
    if (
      !Array.isArray(schedule.weekdays)
      || schedule.weekdays.length === 0
      || !schedule.weekdays.every(isValidWeekday)
    ) {
      return null;
    }
    return Array.from(new Set(schedule.weekdays)).sort((a, b) => a - b);
  }
  return isValidWeekday(schedule.weekday) ? [schedule.weekday] : null;
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
    const weeklyDays = schedule.kind === 'weekly' ? effectiveWeeklyWeekdays(schedule) : null;
    if (schedule.kind === 'weekly' && weeklyDays === null) return [];
    const start = getZonedParts(reference, timeZone);
    const runs: Date[] = [];
    // Weekly needs up to 7 days per hit; +8 days of slack is always enough.
    const maxOffset = count * 7 + 8;
    for (let offset = 0; offset <= maxOffset && runs.length < count; offset += 1) {
      const calendar = addDaysToCalendarDate(start.year, start.month, start.day, offset);
      const weekday = weekdayOfCalendarDate(calendar.year, calendar.month, calendar.day);
      if (schedule.kind === 'weekdays' && (weekday === 0 || weekday === 6)) continue;
      if (schedule.kind === 'weekly' && !(weeklyDays as number[]).includes(weekday)) continue;
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

/** 多天列表项的 i18n 兜底文案（`weekdaysListItem.*` 碎片未合并时使用） */
const WEEKDAY_LIST_ITEM_FALLBACK = ['日', '一', '二', '三', '四', '五', '六'] as const;

/**
 * 多天星期集合的人类可读列表，如 "一、三、五"。
 * 键：`automation.scheduleEditor.weekdaysListItem.{0..6}` + `.weekdayListJoin`。
 */
export function formatWeekdayList(
  days: number[],
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const P = 'automation.scheduleEditor';
  const names = days.map((day) =>
    t(`${P}.weekdaysListItem.${day}`, { defaultValue: WEEKDAY_LIST_ITEM_FALLBACK[day] ?? '?' }),
  );
  return names.join(t(`${P}.weekdayListJoin`, { defaultValue: '、' }));
}

/**
 * Human-readable one-liner, e.g. "每周一 08:00（Asia/Shanghai）" /
 * "每周一、三、五 09:00"（weekly 多天）.
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
      if (!isValidTime(schedule.time)) return invalid();
      const days = effectiveWeeklyWeekdays(schedule);
      if (days === null) return invalid();
      if (days.length > 1) {
        const weekdays = formatWeekdayList(days, t);
        base = t(`${P}.describe.weeklyMulti`, {
          weekdays,
          time: schedule.time,
          defaultValue: `每周${weekdays} ${schedule.time}`,
        });
        break;
      }
      const weekday = t(`${P}.weekdaysLong.${days[0]}`);
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
