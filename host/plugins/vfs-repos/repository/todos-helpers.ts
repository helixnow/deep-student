/** Pure date/repeat helpers ported from todo_repo.rs. */
import { VfsRepositoryError } from '../api.ts';
import { parseRfc3339 } from '../../../platform/time/index.ts';
import { utcTimestamp, utcTimestampFromMillis } from './timestamps.ts';

export interface LocalDate { year: number; month: number; day: number }
export interface TodoRepeatRule {
  freq: string;
  interval: number;
  byWeekday: number[] | null;
  until?: string;
  byMonthDay?: number[];
}

const VALID_REPEAT_FREQS = ['daily', 'weekly', 'monthly', 'yearly', 'weekdays'] as const;
const pad2 = (value: number) => String(value).padStart(2, '0');
const pad4 = (value: number) => String(value).padStart(4, '0');

function invalidArgument(param: string, reason: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_INVALID_ARGUMENT', `Invalid argument '${param}': ${reason}`, { param });
}

/** Rust `normalize_optional_str`: `Some("")`/whitespace becomes `None`; other values stay verbatim. */
export function normalizeOptionalStr(value: string | null | undefined): string | null {
  return value == null || value.trim() === '' ? null : value;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function toUtcMidnight(date: LocalDate): number {
  return Date.UTC(date.year, date.month - 1, date.day);
}

export function fromUtcMidnight(value: number): LocalDate {
  const date = new Date(value);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function formatDate(date: LocalDate): string {
  return `${pad4(date.year)}-${pad2(date.month)}-${pad2(date.day)}`;
}

export function parseDate(text: string): LocalDate | null {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

export function addDays(date: LocalDate, days: number): LocalDate | null {
  const result = fromUtcMidnight(toUtcMidnight(date) + days * 86_400_000);
  return Number.isFinite(result.year) ? result : null;
}

export function diffDays(later: LocalDate, earlier: LocalDate): number {
  return Math.trunc((toUtcMidnight(later) - toUtcMidnight(earlier)) / 86_400_000);
}

export function addMonths(date: LocalDate, months: number): LocalDate | null {
  const total = date.year * 12 + (date.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12 + 1;
  if (!Number.isFinite(year) || year < -262_000 || year > 262_000) return null;
  return { year, month, day: Math.min(date.day, daysInMonth(year, month)) };
}

export function weekday(date: LocalDate): number {
  return new Date(toUtcMidnight(date)).getUTCDay();
}

export function localDate(now = new Date()): LocalDate {
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

export function localDateString(now = new Date()): string {
  return formatDate(localDate(now));
}

/** Local calendar day 00:00 as UTC RFC3339 with milliseconds (Rust `%Y-%m-%dT%H:%M:%S%.3fZ`). */
export function localDateStartUtcString(date: LocalDate): string {
  return new Date(date.year, date.month - 1, date.day, 0, 0, 0, 0).toISOString();
}

export function localTodayUtcBounds(now = new Date()): [string, string] {
  const today = localDate(now);
  const tomorrow = addDays(today, 1)!;
  return [localDateStartUtcString(today), localDateStartUtcString(tomorrow)];
}

export function nowUtcString(): string {
  return utcTimestamp();
}

export function parseTimestampMillis(text: string): number | null {
  return parseRfc3339(text)?.millis ?? null;
}

/** Rust `fresh_updated_at`: UTC now (ms), strictly after `previous` when necessary. */
export function freshUpdatedAt(previous: string): string {
  const now = Date.now();
  const previousTime = parseTimestampMillis(previous);
  if (previousTime !== null && now <= previousTime) return utcTimestampFromMillis(previousTime + 1);
  return utcTimestampFromMillis(now);
}

export function validateDueDate(value: string | null | undefined): string | null {
  if (value == null) return null;
  const parsed = parseDate(value);
  if (!parsed) {
    throw invalidArgument('due_date', `Invalid due_date '${value}'; expected YYYY-MM-DD`);
  }
  return formatDate(parsed);
}

export function validateDueTime(value: string | null | undefined): string | null {
  if (value == null) return null;
  const match = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(value);
  if (match) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const second = match[3] === undefined ? 0 : Number(match[3]);
    if (hour <= 23 && minute <= 59 && second <= 59) return `${pad2(hour)}:${pad2(minute)}`;
  }
  throw invalidArgument('due_time', `Invalid due_time '${value}'; expected HH:MM`);
}

export function validateReminder(value: string | null | undefined): string | null {
  if (value == null) return null;
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(value);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = match[6] === undefined ? 0 : Number(match[6]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
      && hour <= 23 && minute <= 59 && second <= 59) {
      return `${pad4(year)}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}`;
    }
  }
  throw invalidArgument('reminder', `Invalid reminder '${value}'; expected YYYY-MM-DDTHH:MM`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Rust `parse_repeat_rule`: invalid rules return `null` (never throw). */
export function parseRepeatRule(repeatJson: string): TodoRepeatRule | null {
  let value: unknown;
  try { value = JSON.parse(repeatJson); }
  catch { return null; }
  if (!isRecord(value) || typeof value.freq !== 'string') return null;
  let interval = 1;
  if (Object.hasOwn(value, 'interval')) {
    if (typeof value.interval !== 'number' || !Number.isInteger(value.interval)
      || value.interval < 0 || value.interval > 0xffff_ffff) return null;
    interval = value.interval;
  }
  let byWeekday: number[] | null = null;
  if (Object.hasOwn(value, 'byWeekday') && value.byWeekday !== null) {
    if (!Array.isArray(value.byWeekday)) return null;
    for (const day of value.byWeekday) {
      if (typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 255) return null;
    }
    byWeekday = value.byWeekday as number[];
  }
  if (!(VALID_REPEAT_FREQS as readonly string[]).includes(value.freq)) return null;
  if (interval === 0 || interval > 999) return null;
  if (byWeekday !== null) {
    if (value.freq !== 'weekly') {
      byWeekday = null;
    } else {
      if (byWeekday.some(day => day > 6)) return null;
      byWeekday = [...new Set(byWeekday)].sort((a, b) => a - b);
      if (byWeekday.length === 0) byWeekday = null;
    }
  }
  let until: string | undefined;
  if (value.until != null) {
    if (typeof value.until !== 'string') return null;
    const date = parseDate(value.until);
    if (date === null) return null;
    until = formatDate(date);
  }
  let byMonthDay: number[] | undefined;
  if (value.byMonthDay != null) {
    if (!Array.isArray(value.byMonthDay)
      || value.byMonthDay.some(day => !Number.isInteger(day) || day < 1 || day > 31)) return null;
    if (value.freq === 'monthly' && value.byMonthDay.length > 0) {
      byMonthDay = [...new Set(value.byMonthDay as number[])].sort((a, b) => a - b);
    }
  }
  return { freq: value.freq, interval, byWeekday,
    ...(until !== undefined ? { until } : {}),
    ...(byMonthDay !== undefined ? { byMonthDay } : {}) };
}

export function validateRepeatJson(value: string | null): void {
  if (value !== null && parseRepeatRule(value) === null) {
    throw invalidArgument('repeat_json', `Invalid repeat rule '${value}'; expected {"freq":"daily|weekly|monthly|yearly|weekdays","interval":1-999,"byWeekday":[0-6]?}`);
  }
}

function stepWeeklyByWeekday(from: LocalDate, days: readonly number[], interval: number): LocalDate | null {
  const weekStart = (date: LocalDate): LocalDate => {
    const offset = (weekday(date) + 6) % 7;
    return addDays(date, -offset) ?? date;
  };
  const fromWeek = weekStart(from);
  const effectiveInterval = Math.max(interval, 1);
  const scanLimit = effectiveInterval * 7 + 7;
  let date = addDays(from, 1);
  for (let index = 0; index < scanLimit && date !== null; index++) {
    const jsWeekday = weekday(date);
    if (days.includes(jsWeekday)) {
      const weekDiff = Math.trunc(diffDays(weekStart(date), fromWeek) / 7);
      if (weekDiff % effectiveInterval === 0) return date;
    }
    date = addDays(date, 1);
  }
  return null;
}

/** Rust `step_due_date`: monthly/yearly clamp to month end; weekdays skip weekends. */
export function stepDueDate(from: LocalDate, rule: TodoRepeatRule): LocalDate | null {
  const interval = Math.max(rule.interval, 1);
  switch (rule.freq) {
    case 'daily':
      return addDays(from, interval);
    case 'weekly':
      return rule.byWeekday !== null && rule.byWeekday.length > 0
        ? stepWeeklyByWeekday(from, rule.byWeekday, interval)
        : addDays(from, 7 * interval);
    case 'monthly': {
      if (!rule.byMonthDay?.length) return addMonths(from, interval);
      const monthDays = (date: LocalDate) => [...new Set(rule.byMonthDay!
        .map(day => Math.min(day, daysInMonth(date.year, date.month))))];
      const laterDay = monthDays(from).find(day => day > from.day);
      if (laterDay !== undefined) return { ...from, day: laterDay };
      const nextMonth = addMonths(from, interval);
      return nextMonth === null ? null : { ...nextMonth, day: monthDays(nextMonth)[0]! };
    }
    case 'yearly':
      return addMonths(from, 12 * interval);
    case 'weekdays': {
      let date = addDays(from, 1);
      while (date !== null && (weekday(date) === 0 || weekday(date) === 6)) date = addDays(date, 1);
      return date;
    }
    default:
      return null;
  }
}

export function computeNextDueDate(rule: TodoRepeatRule, from: LocalDate, today: LocalDate): LocalDate | null {
  let next = stepDueDate(from, rule);
  let guard = 0;
  while (next !== null && diffDays(next, today) < 0) {
    next = stepDueDate(next, rule);
    guard++;
    if (guard > 5000) return null;
  }
  if (next && rule.until && formatDate(next) > rule.until) return null;
  return next;
}

/** Rust `shift_reminder`: parse `YYYY-MM-DDTHH:MM[:SS]`, shift by due-date delta, drop invalid. */
export function shiftReminder(reminder: string, oldDue: LocalDate, newDue: LocalDate): string | null {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(reminder);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59) return null;
  const shifted = addDays({ year, month, day }, diffDays(newDue, oldDue));
  if (shifted === null) return null;
  return `${formatDate(shifted)}T${pad2(hour)}:${pad2(minute)}`;
}
