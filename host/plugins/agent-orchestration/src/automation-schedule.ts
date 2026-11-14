import { AppError } from '../../../platform/errors/api.ts';
import { chronoRfc3339, parseRfc3339 as parsePlatformRfc3339 } from '../../../platform/time/index.ts';
import { rustTrim } from '../../../platform/util/index.ts';

/** automations.rs:38–104 */
export const MAX_AUTOMATIONS = 20;
export const MAX_PROMPT_LEN = 4000;
export const MAX_NAME_LEN = 100;
export const MAX_RUN_HISTORY = 50;
export const MAX_STORED_RUNS_PER_AUTOMATION = 200;
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_RETRY_BACKOFF_SECS = 60;
export const MAX_RETRY_BACKOFF_SECS = 86_400;
export const DEFAULT_TIMEOUT_SECS = 600;
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 24 * 60;
export const DEFAULT_HEARTBEAT_INTERVAL_MINUTES = 30;
export const HEARTBEAT_OK_SENTINEL = 'HEARTBEAT_OK';
export const ONCE_PAST_GRACE_SECS = 60;

export type ScheduleKind = 'daily' | 'weekly' | 'weekdays' | 'monthly' | 'interval' | 'once';
export type CatchUpPolicy = 'skip' | 'run_once' | 'catch_up_all';

/** Rust `AutomationSchedule`; field names follow serde's snake_case shape. */
export interface AutomationSchedule {
  kind: ScheduleKind;
  time: string;
  weekday: number | null;
  weekdays: number[] | null;
  day_of_month: number | null;
  interval_minutes: number | null;
  date: string | null;
  timezone: string | null;
}

export interface ScheduleAutomation {
  enabled: boolean;
  created_at: string;
  next_run_at: string | null;
  last_run_at: string | null;
  schedule: AutomationSchedule;
}

interface DateParts { year: number; month: number; day: number }
interface WallParts extends DateParts { hour: number; minute: number }

const HHMM = /^[0-9]{2}:[0-9]{2}$/;

function invalidTime(raw: string): AppError {
  return AppError.validation(`Invalid time '${raw}': expected HH:MM (24h)`);
}

/** automations.rs:659–678. */
export function parseTimeHhmm(raw: string): { hour: number; minute: number } {
  const trimmed = rustTrim(raw);
  if (!HHMM.test(trimmed)) throw invalidTime(raw);
  const hour = Number(trimmed.slice(0, 2));
  const minute = Number(trimmed.slice(3, 5));
  if (hour > 23 || minute > 59) throw invalidTime(raw);
  return { hour, minute };
}

function parseOnceDate(schedule: AutomationSchedule): DateParts {
  const raw = schedule.date === null ? '' : rustTrim(schedule.date);
  if (raw === '') {
    throw AppError.validation('date (YYYY-MM-DD) is required for once schedule');
  }
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(raw);
  if (match === null) {
    throw AppError.validation(`Invalid date '${raw}': expected YYYY-MM-DD`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidCivilDate(year, month, day)) {
    throw AppError.validation(`Invalid date '${raw}': expected YYYY-MM-DD`);
  }
  return { year, month, day };
}

function isValidCivilDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= lastDayOfMonth(year, month);
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** automations.rs:700–710; weekdays 0=Sunday … 6=Saturday. */
export function weeklyEffectiveWeekdays(schedule: AutomationSchedule): number[] | null {
  if (schedule.weekdays !== null && schedule.weekdays.length > 0) {
    return [...new Set(schedule.weekdays)].sort((a, b) => a - b);
  }
  return schedule.weekday === null ? null : [schedule.weekday];
}

/** automations.rs:713–733. */
function validateWeekdaysList(weekdays: readonly number[]): void {
  if (weekdays.length === 0) {
    throw AppError.validation('weekdays must not be empty (0=Sunday … 6=Saturday)');
  }
  if (weekdays.some((weekday) => weekday > 6 || weekday < 0 || !Number.isInteger(weekday))) {
    throw AppError.validation('weekdays values must be between 0 (Sunday) and 6 (Saturday)');
  }
  if (new Set(weekdays).size !== weekdays.length) {
    throw AppError.validation('weekdays must not contain duplicates');
  }
}

/** automations.rs:742–759. Mutates the schedule like the Rust entry point. */
export function normalizeScheduleShape(schedule: AutomationSchedule): void {
  if (schedule.kind !== 'weekly' || schedule.weekdays === null) return;
  const weekdays = [...new Set(schedule.weekdays)].sort((a, b) => a - b);
  if (weekdays.length === 0) {
    schedule.weekdays = null;
    return;
  }
  if (weekdays.length === 1) {
    schedule.weekday = weekdays[0]!;
    schedule.weekdays = null;
    return;
  }
  schedule.weekday = weekdays[0]!;
  schedule.weekdays = weekdays;
}

function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** automations.rs:761–914. `nowMs` is Rust's `Local::now()`. */
export function validateSchedule(schedule: AutomationSchedule, nowMs: number = Date.now()): void {
  if (schedule.timezone !== null && !isValidTimeZone(schedule.timezone)) {
    throw AppError.validation(`Invalid IANA timezone '${schedule.timezone}'`);
  }
  if (schedule.kind !== 'once' && schedule.date !== null) {
    throw AppError.validation('date is only allowed for once schedule');
  }
  if (schedule.kind !== 'weekly' && schedule.weekdays !== null) {
    throw AppError.validation('weekdays is only allowed for weekly schedule');
  }
  switch (schedule.kind) {
    case 'daily': {
      parseTimeHhmm(schedule.time);
      if (schedule.weekday !== null) throw AppError.validation('weekday must not be set for daily schedule');
      if (schedule.interval_minutes !== null) throw AppError.validation('interval_minutes must not be set for daily schedule');
      if (schedule.day_of_month !== null) throw AppError.validation('day_of_month must not be set for daily schedule');
      break;
    }
    case 'weekly': {
      parseTimeHhmm(schedule.time);
      if (schedule.weekdays !== null) {
        validateWeekdaysList(schedule.weekdays);
      } else {
        if (schedule.weekday === null) {
          throw AppError.validation('weekday is required for weekly schedule (0=Sun … 6=Sat)');
        }
        if (schedule.weekday > 6 || schedule.weekday < 0) {
          throw AppError.validation('weekday must be between 0 (Sunday) and 6 (Saturday)');
        }
      }
      if (schedule.weekdays !== null && schedule.weekday !== null && (schedule.weekday > 6 || schedule.weekday < 0)) {
        throw AppError.validation('weekday must be between 0 (Sunday) and 6 (Saturday)');
      }
      if (schedule.interval_minutes !== null) throw AppError.validation('interval_minutes must not be set for weekly schedule');
      if (schedule.day_of_month !== null) throw AppError.validation('day_of_month must not be set for weekly schedule');
      break;
    }
    case 'weekdays': {
      parseTimeHhmm(schedule.time);
      if (schedule.weekday !== null || schedule.interval_minutes !== null || schedule.day_of_month !== null) {
        throw AppError.validation('weekdays schedule only accepts time and timezone');
      }
      break;
    }
    case 'monthly': {
      parseTimeHhmm(schedule.time);
      if (schedule.day_of_month === null) {
        throw AppError.validation('day_of_month is required for monthly schedule');
      }
      if (schedule.day_of_month < 1 || schedule.day_of_month > 31) {
        throw AppError.validation('day_of_month must be between 1 and 31');
      }
      if (schedule.weekday !== null || schedule.interval_minutes !== null) {
        throw AppError.validation('weekday and interval_minutes must not be set for monthly schedule');
      }
      break;
    }
    case 'interval': {
      if (rustTrim(schedule.time) !== '' || schedule.timezone !== null) {
        throw AppError.validation('interval schedule does not accept time or timezone');
      }
      if (schedule.weekday !== null) throw AppError.validation('weekday must not be set for interval schedule');
      if (schedule.day_of_month !== null) throw AppError.validation('day_of_month must not be set for interval schedule');
      if (schedule.interval_minutes === null) {
        throw AppError.validation('interval_minutes is required for interval schedule');
      }
      if (schedule.interval_minutes < MIN_INTERVAL_MINUTES || schedule.interval_minutes > MAX_INTERVAL_MINUTES) {
        throw AppError.validation(`interval_minutes must be between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}`);
      }
      break;
    }
    case 'once': {
      parseTimeHhmm(schedule.time);
      const date = parseOnceDate(schedule);
      if (schedule.weekday !== null || schedule.interval_minutes !== null || schedule.day_of_month !== null) {
        throw AppError.validation('once schedule only accepts date, time, and timezone');
      }
      const slot = scheduledSlotOnDate(schedule, date);
      if (slot === null) throw AppError.internal('Failed to resolve once schedule slot');
      if (slot + ONCE_PAST_GRACE_SECS * 1000 < nowMs) {
        throw AppError.validation(`once schedule time '${schedule.date ?? ''} ${schedule.time}' has already passed`);
      }
      break;
    }
  }
}

/** automations.rs:916–937. */
export function validateAutomationFields(name: string, prompt: string): void {
  const trimmedName = rustTrim(name);
  if (trimmedName === '') throw AppError.validation('name must not be empty');
  if ([...trimmedName].length > MAX_NAME_LEN) {
    throw AppError.validation(`name must be at most ${MAX_NAME_LEN} characters`);
  }
  if (rustTrim(prompt) === '') throw AppError.validation('prompt must not be empty');
  if ([...prompt].length > MAX_PROMPT_LEN) {
    throw AppError.validation(`prompt must be at most ${MAX_PROMPT_LEN} characters`);
  }
}

// ---------------------------------------------------------------------------
// Timezone arithmetic. Chrono's Local is the host system zone; named zones use
// Intl. Wall times are resolved in 0..=180 minute steps like Rust to survive
// spring-forward gaps, and ambiguous wall times pick the earliest instant.
// ---------------------------------------------------------------------------

function zonedParts(ms: number, timezone: string): WallParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = new Map(formatter.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.get('year')), month: Number(parts.get('month')), day: Number(parts.get('day')),
    hour: Number(parts.get('hour')), minute: Number(parts.get('minute')),
  };
}

function timezoneOffsetMs(ms: number, timezone: string): number {
  const parts = zonedParts(ms, timezone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0) - ms;
}

function sameWall(parts: WallParts, other: WallParts): boolean {
  return parts.year === other.year && parts.month === other.month && parts.day === other.day
    && parts.hour === other.hour && parts.minute === other.minute;
}

function resolveZonedWallTime(parts: WallParts, timezone: string): number | null {
  const utcGuess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
  const offsets = new Set([
    timezoneOffsetMs(utcGuess - 36 * 3_600_000, timezone),
    timezoneOffsetMs(utcGuess + 36 * 3_600_000, timezone),
  ]);
  const candidates: number[] = [];
  for (const offset of offsets) {
    const candidate = utcGuess - offset;
    if (sameWall(zonedParts(candidate, timezone), parts)) candidates.push(candidate);
  }
  return candidates.length === 0 ? null : Math.min(...candidates);
}

function resolveLocalWallTime(parts: WallParts): number | null {
  const candidate = new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
  const actual: WallParts = {
    year: candidate.getFullYear(), month: candidate.getMonth() + 1, day: candidate.getDate(),
    hour: candidate.getHours(), minute: candidate.getMinutes(),
  };
  return sameWall(actual, parts) ? candidate.getTime() : null;
}

function buildSlot(schedule: AutomationSchedule, date: DateParts, hour: number, minute: number): number {
  if (schedule.timezone !== null) {
    for (let offset = 0; offset <= 180; offset += 1) {
      const candidate: WallParts = { ...date, hour, minute: minute + offset };
      // Normalize minute overflow without relying on Date's DST behavior.
      const normalized = new Date(Date.UTC(candidate.year, candidate.month - 1, candidate.day, candidate.hour, candidate.minute));
      const wall: WallParts = {
        year: normalized.getUTCFullYear(), month: normalized.getUTCMonth() + 1, day: normalized.getUTCDate(),
        hour: normalized.getUTCHours(), minute: normalized.getUTCMinutes(),
      };
      const resolved = resolveZonedWallTime(wall, schedule.timezone);
      if (resolved !== null) return resolved;
    }
    throw AppError.internal('Failed to build timezone slot');
  }
  for (let offset = 0; offset <= 180; offset += 1) {
    const normalized = new Date(Date.UTC(date.year, date.month - 1, date.day, hour, minute + offset));
    const wall: WallParts = {
      year: normalized.getUTCFullYear(), month: normalized.getUTCMonth() + 1, day: normalized.getUTCDate(),
      hour: normalized.getUTCHours(), minute: normalized.getUTCMinutes(),
    };
    const resolved = resolveLocalWallTime(wall);
    if (resolved !== null) return resolved;
  }
  throw AppError.internal('Failed to build local schedule slot');
}

function addDays(date: DateParts, days: number): DateParts {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

function weekdayOf(date: DateParts): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function localDateParts(ms: number): DateParts {
  const value = new Date(ms);
  return { year: value.getFullYear(), month: value.getMonth() + 1, day: value.getDate() };
}

function scheduleDateParts(schedule: AutomationSchedule, nowMs: number): DateParts {
  if (schedule.timezone !== null) {
    const parts = zonedParts(nowMs, schedule.timezone);
    return { year: parts.year, month: parts.month, day: parts.day };
  }
  return localDateParts(nowMs);
}

/** automations.rs:2150–2228. */
export function scheduledSlotOnDate(schedule: AutomationSchedule, date: DateParts): number | null {
  if (schedule.kind === 'interval') return null;
  const { hour, minute } = parseTimeHhmm(schedule.time);
  switch (schedule.kind) {
    case 'once': {
      const target = parseOnceDate(schedule);
      if (target.year !== date.year || target.month !== date.month || target.day !== date.day) return null;
      return buildSlot(schedule, date, hour, minute);
    }
    case 'daily':
      return buildSlot(schedule, date, hour, minute);
    case 'weekly': {
      const targets = weeklyEffectiveWeekdays(schedule);
      if (targets === null) throw AppError.validation('weekly schedule missing weekday');
      return targets.includes(weekdayOf(date)) ? buildSlot(schedule, date, hour, minute) : null;
    }
    case 'weekdays':
      return weekdayOf(date) >= 1 && weekdayOf(date) <= 5 ? buildSlot(schedule, date, hour, minute) : null;
    case 'monthly': {
      const requested = schedule.day_of_month ?? 1;
      const lastDay = lastDayOfMonth(date.year, date.month);
      return date.day === Math.min(requested, lastDay) ? buildSlot(schedule, date, hour, minute) : null;
    }
  }
}

/** automations.rs:2231–2244. */
export function scheduledSlotToday(schedule: AutomationSchedule, nowMs: number): number | null {
  return scheduledSlotOnDate(schedule, scheduleDateParts(schedule, nowMs));
}

/** automations.rs:2312–2324. */
export function parseLastRunAt(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = rustTrim(raw);
  if (trimmed === '') return null;
  const parsed = parseTimestampMillis(trimmed);
  if (parsed === null) throw AppError.internal('Invalid last_run_at: invalid RFC 3339 timestamp');
  return parsed;
}

/** F4 `host/platform/time::parseRfc3339` 的毫秒适配器（非本地解析实现）。 */
export function parseTimestampMillis(raw: string): number | null {
  const parsed = parsePlatformRfc3339(rustTrim(raw));
  return parsed === null ? null : parsed.millis;
}

/** automations.rs:2263–2310. */
export function isDue(automation: ScheduleAutomation, nowMs: number, lastRunAt: number | null): boolean {
  if (!automation.enabled) return false;
  if (automation.schedule.kind === 'interval') {
    const minutes = automation.schedule.interval_minutes ?? DEFAULT_HEARTBEAT_INTERVAL_MINUTES;
    if (lastRunAt === null) {
      if (automation.next_run_at !== null) {
        const next = parseTimestampMillis(automation.next_run_at);
        if (next === null) throw AppError.internal('Invalid next_run_at: invalid RFC 3339 timestamp');
        return next <= nowMs;
      }
      const created = parseTimestampMillis(automation.created_at);
      return created !== null && nowMs - created >= minutes * 60_000;
    }
    return nowMs - lastRunAt >= minutes * 60_000;
  }
  const slot = scheduledSlotToday(automation.schedule, nowMs);
  if (slot === null || nowMs < slot) return false;
  return lastRunAt === null || lastRunAt < slot;
}

/** automations.rs:2326–2368. */
export function computeNextTrigger(schedule: AutomationSchedule, nowMs: number): number {
  if (schedule.kind === 'interval') {
    return nowMs + (schedule.interval_minutes ?? DEFAULT_HEARTBEAT_INTERVAL_MINUTES) * 60_000;
  }
  if (schedule.kind === 'once') {
    const date = parseOnceDate(schedule);
    const slot = scheduledSlotOnDate(schedule, date);
    if (slot === null) throw AppError.internal('Failed to resolve once schedule slot');
    return slot;
  }
  const start = scheduleDateParts(schedule, nowMs);
  const horizon = schedule.kind === 'monthly' ? 40 : 8;
  for (let dayOffset = 0; dayOffset < horizon; dayOffset += 1) {
    const slot = scheduledSlotOnDate(schedule, addDays(start, dayOffset));
    if (slot === null) continue;
    if (dayOffset === 0 && slot <= nowMs) continue;
    return slot;
  }
  throw AppError.internal('Could not compute next trigger');
}

/** automations.rs:1870–1876. */
export function onceSlotAlreadyConsumed(automation: ScheduleAutomation, slot: number): boolean {
  if (automation.schedule.kind !== 'once') return false;
  const last = parseLastRunAt(automation.last_run_at);
  return last !== null && last >= slot;
}

/** automations.rs:1883–1888. */
export function onceAutomationCompleted(automation: ScheduleAutomation): boolean {
  return automation.schedule.kind === 'once' && !automation.enabled
    && automation.next_run_at === null && automation.last_run_at !== null;
}

/** F4 `host/platform/time::chronoRfc3339` 的毫秒适配器（AutoSi，UTC `+00:00`）。 */
export function formatTimestampMillis(ms: number): string {
  return chronoRfc3339(BigInt(ms) * 1_000_000n);
}
