/**
 * F3 时间入口：全部委托给 F4 `host/platform/time`（chrono 0.4 兼容）。
 *
 * Rust sources use `chrono::Utc::now().to_rfc3339()` (SecondsFormat::AutoSi):
 * - offset is always `+00:00` (never `Z`);
 * - fractional seconds are omitted when zero and otherwise use 3/6/9 digits.
 *
 * The Host stores millisecond precision (decision: better-sqlite3 timestamps
 * are ms), so the default timestamps below keep millisecond precision.
 */
import { parseRfc3339, toRfc3339, toRfc3339Opts } from '../time/index.ts';

const NS_PER_MS = 1_000_000n;

function epochNanos(date: Date): bigint {
  return BigInt(date.getTime()) * NS_PER_MS;
}

/** `to_rfc3339()` for a Date (millisecond precision, `+00:00`). */
export function rfc3339FromDate(date: Date): string {
  return toRfc3339(epochNanos(date));
}

/** `Utc::now().to_rfc3339()`. */
export function rfc3339Now(at: Date = new Date()): string {
  return rfc3339FromDate(at);
}

/** `DateTime::from_timestamp_millis(ms).to_rfc3339()`. */
export function rfc3339FromMillis(millis: number): string {
  return toRfc3339(BigInt(Math.trunc(millis)) * NS_PER_MS);
}

/**
 * chrono `serde::Serialize for DateTime<Utc>`:
 * `to_rfc3339_opts(SecondsFormat::AutoSi, true)` — UTC is written as `Z`,
 * fractional seconds keep 0/3/6/9 digits. Used by IPC payloads whose Rust
 * field type is `DateTime<Utc>` (`llm_usage/types.rs:215,564,567`).
 */
export function rfc3339ZFromDate(date: Date): string {
  return toRfc3339Opts(epochNanos(date), 'AutoSi', true);
}

/** `DateTime::from_timestamp_millis(ms)` serialized by chrono serde (`Z`). */
export function rfc3339ZFromMillis(millis: number): string {
  return toRfc3339Opts(BigInt(Math.trunc(millis)) * NS_PER_MS, 'AutoSi', true);
}

/** `Utc::now()` serialized by chrono serde (`Z`). */
export function rfc3339NowZ(at: Date = new Date()): string {
  return rfc3339ZFromDate(at);
}

/**
 * `DateTime::parse_from_rfc3339(value)?.with_timezone(&Utc)` serialized by
 * chrono serde: same instant and 0/3/6/9 fractional digits, UTC written `Z`.
 * Returns null when chrono would reject the input.
 */
export function canonicalRfc3339Z(value: string): string | null {
  const parsed = parseRfc3339(value);
  return parsed === null ? null : toRfc3339Opts(parsed.epochNanos, 'AutoSi', true);
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

/**
 * `parse_date_boundary` (repo.rs:698): `%Y-%m-%d` -> start/end of day in UTC.
 * End of day keeps chrono's nanosecond precision (23:59:59.999999999).
 * `NaiveDate::parse_from_str` rejects impossible calendar dates (e.g. 02-30).
 */
export function rfc3339DateBoundary(value: string, endOfDay: boolean): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!validCalendarDate(year, month, day)) return null;
  const start = new Date(0);
  start.setUTCFullYear(year, month - 1, day);
  start.setUTCHours(0, 0, 0, 0);
  if (!endOfDay) return toRfc3339(epochNanos(start));
  const end = new Date(start.getTime() + 86_399_999);
  return toRfc3339Opts(epochNanos(end) + 999_999n, 'Nanos');
}

/**
 * `DateTime::parse_from_rfc3339(value).timestamp_millis()` (repo.rs:692).
 * Returns null for anything chrono would reject (unlike `Date.parse`, which
 * accepts many non-RFC3339 formats).
 */
export function parseRfc3339Millis(value: string): number | null {
  return parseRfc3339(value)?.millis ?? null;
}

/**
 * `DateTime<Utc>::to_rfc3339()` for an RFC3339 input string: converts the
 * offset to `+00:00` and applies chrono's `SecondsFormat::AutoSi` (0/3/6/9
 * fractional digits). Returns null when chrono would reject the input.
 */
export function canonicalRfc3339(value: string): string | null {
  const parsed = parseRfc3339(value);
  return parsed === null ? null : toRfc3339(parsed.epochNanos);
}

/** chrono `format("%Y-%m-%d %H:%M:%S")` in UTC. */
export function chronoSeconds(date: Date = new Date()): string {
  return toRfc3339(epochNanos(date)).slice(0, 19).replace('T', ' ');
}

/**
 * chrono `format("%Y%m%dT%H%M%S%6fZ")` / `%Y%m%d%H%M%S%6f` (data_space.rs:436,1743).
 * Milliseconds are widened to microseconds with three trailing zeroes.
 */
export function compactTimestampMicros(date: Date = new Date()): string {
  const rfc = toRfc3339Opts(epochNanos(date), 'Micros');
  return `${rfc.slice(0, 4)}${rfc.slice(5, 7)}${rfc.slice(8, 10)}` +
    `${rfc.slice(11, 13)}${rfc.slice(14, 16)}${rfc.slice(17, 19)}${rfc.slice(20, 26)}`;
}
