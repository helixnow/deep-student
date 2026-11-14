/**
 * chrono 0.4 兼容的时间实现（F4 平台模块）。
 *
 * 关键语义（`chrono-0.4.45/src/format/formatting.rs:504-564`）：
 * - `to_rfc3339()` = `to_rfc3339_opts(SecondsFormat::AutoSi, false)`：
 *   小数秒 0/3/6/9 位变长，UTC 时区写 `+00:00`（不是 `Z`）；
 * - `to_rfc3339_opts(..., true)` 仅在偏移为 0 时写 `Z`；
 * - `parse_from_rfc3339` 接受 `T`/`t`/空格分隔、大小写 `Z`、`.` 小数秒、
 *   闰秒 `:60`（归一化到下一整秒），时区偏移限制在 ±23:59；
 * - `parse_flexible_timestamp_public` 额外接受纯数字秒/毫秒时间戳，
 *   内部 `parse_flexible_timestamp` 不接受纯数字（见 `parseFlexibleTimestamp` 的 `numeric`）。
 */
import type {
  CivilTime,
  FlexibleTimestampOptions,
  Instant,
  ParsedDateTime,
  Rfc3339Options,
  SecondsFormat,
} from './api.ts';

export type {
  CivilTime,
  FlexibleTimestampOptions,
  Instant,
  ParsedDateTime,
  Rfc3339Options,
  SecondsFormat,
} from './api.ts';

const NS_PER_MS = 1_000_000n;
const NS_PER_SEC = 1_000_000_000n;
const MS_THRESHOLD = 100_000_000_000; // sync/mod.rs:87 1e11
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
/** chrono `NaiveDate` 的可表示范围：-262143-01-01 ..= +262142-12-31（毫秒取整）。 */
const DATE_MIN_MS = -8_334_601_228_800_000n; // -262143-01-01T00:00:00Z
const DATE_MAX_MS = 8_210_266_876_799_999n; // +262142-12-31T23:59:59.999Z

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** chrono 的年份格式：0..=9999 四位，越界时带符号且至少四位。 */
function yearText(year: number): string {
  if (year >= 0 && year <= 9999) return pad(year, 4);
  return year < 0 ? `-${pad(-year, 4)}` : `+${year}`;
}

function offsetText(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `${sign}${pad(Math.floor(abs / 60), 2)}:${pad(abs % 60, 2)}`;
}

function fractionText(nanos: number, format: SecondsFormat): string {
  switch (format) {
    case 'Secs':
      return '';
    case 'Millis':
      return `.${pad(Math.floor(nanos / 1_000_000), 3)}`;
    case 'Micros':
      return `.${pad(Math.floor(nanos / 1000), 6)}`;
    case 'Nanos':
      return `.${pad(nanos, 9)}`;
    case 'AutoSi':
      if (nanos === 0) return '';
      if (nanos % 1_000_000 === 0) return `.${pad(nanos / 1_000_000, 3)}`;
      if (nanos % 1000 === 0) return `.${pad(nanos / 1000, 6)}`;
      return `.${pad(nanos, 9)}`;
  }
}

function floorDiv(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  return value % divisor < 0n ? quotient - 1n : quotient;
}

function splitEpochNanos(epochNanos: bigint): { seconds: bigint; nanos: number } {
  const seconds = floorDiv(epochNanos, NS_PER_SEC);
  return { seconds, nanos: Number(epochNanos - seconds * NS_PER_SEC) };
}

/**
 * 当前时刻（毫秒取 `Date.now()`，亚毫秒位由 performance 时钟合成）。
 *
 * 合成的亚毫秒位受浮点精度（约 0.24µs）和两个时钟间偏差的钳位影响，连续采样常常相同；
 * 冻结的时钟（测试里的假计时器）每次都返回同一值。需要按时间排序的写入用 {@link orderedNowEpochNanos}。
 */
export function nowEpochNanos(): bigint {
  const wallMs = Date.now();
  const sampled = performance.timeOrigin + performance.now();
  const subMs = Math.max(0, Math.min(999_999, Math.floor((sampled - wallMs) * 1_000_000)));
  return BigInt(wallMs) * NS_PER_MS + BigInt(subMs);
}

let lastOrderedEpochNanos = 0n;

/**
 * 供之后按时间排序的时间戳（如 `ORDER BY updated_at`）：chrono `Utc::now()` 有真实的纳秒分辨率，
 * 连续两次几乎不会相同，而 {@link nowEpochNanos} 经常并列。与上次结果相差不足 1ms 的并列或回退
 * 推进到上次 + 1ns；墙钟回拨 1ms 及以上时照常返回回拨后的时间，与 `Utc::now()` 一致。
 */
export function orderedNowEpochNanos(): bigint {
  let epochNanos = nowEpochNanos();
  if (epochNanos <= lastOrderedEpochNanos && lastOrderedEpochNanos - epochNanos < NS_PER_MS) {
    epochNanos = lastOrderedEpochNanos + 1n;
  }
  lastOrderedEpochNanos = epochNanos;
  return epochNanos;
}

/** 把纪元纳秒拆成 UTC（`local=false`）或本地时区的日历时间。 */
export function civilTime(epochNanos: bigint, local: boolean): CivilTime {
  const { seconds, nanos } = splitEpochNanos(epochNanos);
  const millis = Number(seconds) * 1000;
  const date = new Date(millis);
  if (local) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
      nanos,
      offsetMinutes: -date.getTimezoneOffset(),
    };
  }
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    nanos,
    offsetMinutes: 0,
  };
}

/** 按固定偏移取日历字段（不依赖本机时区）。 */
function civilTimeAtOffset(epochNanos: bigint, offsetMinutes: number): CivilTime {
  const { seconds, nanos } = splitEpochNanos(epochNanos);
  const date = new Date(Number(seconds) * 1000 + offsetMinutes * 60_000);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    nanos,
    offsetMinutes,
  };
}

/** `YYYY-MM-DD`。 */
export function ymd(t: CivilTime): string {
  return `${yearText(t.year)}-${pad(t.month, 2)}-${pad(t.day, 2)}`;
}

/** chrono `DateTime::to_rfc3339_opts`。 */
export function toRfc3339Opts(
  epochNanos: bigint,
  format: SecondsFormat,
  useZ = false,
  offsetMinutes = 0,
): string {
  const t = civilTimeAtOffset(epochNanos, offsetMinutes);
  const zone = useZ && offsetMinutes === 0 ? 'Z' : offsetText(offsetMinutes);
  return `${ymd(t)}T${pad(t.hour, 2)}:${pad(t.minute, 2)}:${pad(t.second, 2)}${fractionText(t.nanos, format)}${zone}`;
}

/** chrono `DateTime::to_rfc3339()`（AutoSi，UTC 写 `+00:00`）。 */
export function toRfc3339(epochNanos: bigint = nowEpochNanos(), options: Rfc3339Options = {}): string {
  if (options.local === true) {
    const { seconds } = splitEpochNanos(epochNanos);
    const offsetMinutes = -new Date(Number(seconds) * 1000).getTimezoneOffset();
    return toRfc3339Opts(epochNanos, 'AutoSi', false, offsetMinutes);
  }
  return toRfc3339Opts(epochNanos, 'AutoSi', false, options.offsetMinutes ?? 0);
}

/**
 * F4 既有的 `chronoRfc3339(epochNanos?, local?)` 兼容入口。
 * 新代码用 {@link toRfc3339}；两者输出一致。
 */
export function chronoRfc3339(epochNanos: bigint = nowEpochNanos(), local = false): string {
  return toRfc3339(epochNanos, local ? { local: true } : {});
}

/** chrono `to_rfc3339_opts(SecondsFormat::Secs, true)`（整秒 + `Z`）。 */
export function toRfc3339SecsZ(epochNanos: bigint): string {
  return toRfc3339Opts(epochNanos, 'Secs', true, 0);
}

/**
 * 同一次采样同时得到毫秒与 RFC 3339 字符串。
 * `instant.rfc3339 === toRfc3339(instant.epochNanos)`。
 */
export function now(): Instant {
  const epochNanos = nowEpochNanos();
  return {
    epochNanos,
    millis: Number(floorDiv(epochNanos, NS_PER_MS)),
    rfc3339: toRfc3339(epochNanos),
  };
}

/** chrono `format("%Y-%m-%dT%H-%M-%S%.3f")` 风格（`sep` 为时分秒分隔符）。 */
export function chronoStamp(t: CivilTime, timeSep: string, millis: boolean): string {
  const base = `${ymd(t)}T${pad(t.hour, 2)}${timeSep}${pad(t.minute, 2)}${timeSep}${pad(t.second, 2)}`;
  return millis ? `${base}.${pad(Math.floor(t.nanos / 1_000_000), 3)}` : base;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** 由日历字段得到 UTC 毫秒；非法日期返回 null。 */
function civilToMillis(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number | null {
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 60) return null;
  // chrono 把闰秒表示为 59 秒 + 1e9 纳秒；这里先取 59 秒。
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second === 60 ? 59 : second, 0);
  if (
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute
    || date.getUTCSeconds() !== (second === 60 ? 59 : second)
  ) return null;
  const millis = date.getTime();
  return Number.isFinite(millis) ? millis : null;
}

function fractionNanos(fraction: string | undefined): number {
  if (fraction === undefined) return 0;
  return Number((fraction + '000000000').slice(0, 9));
}

function parsedFromParts(
  parts: { year: number; month: number; day: number; hour: number; minute: number; second: number; nanos: number; offsetMinutes: number },
  utcMillis: number,
): ParsedDateTime {
  const epochNanos = BigInt(utcMillis) * NS_PER_MS + BigInt(parts.nanos);
  return {
    ...parts,
    epochNanos,
    millis: Number(floorDiv(epochNanos, NS_PER_MS)),
  };
}

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|z|[+\-\u2212]\d{2}:\d{2})$/;
const NAIVE = /^(\d{1,4})-(\d{1,2})-(\d{1,2})([ T])(\d{1,2}):(\d{1,2}):(\d{1,2})$/;
const INTEGER = /^[+-]?[0-9]+$/;

// chrono 0.4.41 format/parse.rs:545-583 DATE_ITEMS/TIME_ITEMS and scan.rs:183-278.
// Numeric trims Rust White_Space before digits; Space items trim before punctuation.
// The date/time separator and fractional dot do NOT have a preceding Space item.
// Offset hours/minutes are exactly two digits; colon_or_space consumes zero or more
// ':' / White_Space. Explicit UTC spelling alternatives keep case-folding ASCII-only.
const CHRONO_DATETIME_UTC = /^\p{White_Space}*([+-][0-9]+|[0-9]{1,4})\p{White_Space}*-\p{White_Space}*([0-9]{1,2})\p{White_Space}*-\p{White_Space}*([0-9]{1,2})[Tt ]\p{White_Space}*([0-9]{1,2})\p{White_Space}*:\p{White_Space}*([0-9]{1,2})\p{White_Space}*:\p{White_Space}*([0-9]{1,2})(?:\.([0-9]+))?\p{White_Space}*(?:[Zz]|[Uu][Tt][Cc]|([+\-\u2212])([0-9]{2})[:\p{White_Space}]*([0-9]{2}))\p{White_Space}*$/u;

/**
 * chrono 0.4.41 DateTime<Utc>::FromStr / serde DateTimeVisitor's string domain.
 * Returns UTC fields in the existing exact representation, or null for ParseError.
 * See migration/spec/F4-security.md WP-007 for the source branch correspondence.
 */
export function parseChronoDateTimeUtc(value: string): ParsedDateTime | null {
  const match = CHRONO_DATETIME_UTC.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  // NaiveDate's representable local calendar range, before subtracting the offset.
  if (year < -262143 || year > 262142) return null;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const localMillis = civilToMillis(year, month, day, hour, minute, second);
  if (localMillis === null) return null;

  let offsetMinutes = 0;
  if (match[8] !== undefined) {
    const hours = Number(match[9]);
    const minutes = Number(match[10]);
    // scan::timezone_offset checks minutes; FixedOffset::east_opt checks < 24h.
    if (hours > 23 || minutes > 59) return null;
    offsetMinutes = (match[8] === '+' ? 1 : -1) * (hours * 60 + minutes);
  }
  const utcMillis = localMillis - offsetMinutes * 60_000;
  // TimeZone::from_local_datetime -> checked_sub_offset also checks the UTC date.
  // Check the base second, not epochNanos: the last representable minute can leap.
  if (BigInt(utcMillis) < DATE_MIN_MS || BigInt(utcMillis) > DATE_MAX_MS) return null;
  const nanos = fractionNanos(match[7]) + (second === 60 ? 1_000_000_000 : 0);
  // with_timezone(Utc) preserves leap seconds. Convert only the base second to
  // calendar fields, then restore nanos >= 1e9 instead of rolling to the next day.
  return parsedFromParts({ ...civilTime(BigInt(utcMillis) * NS_PER_MS, false), nanos }, utcMillis);
}

/** chrono `DateTime::parse_from_rfc3339`；失败返回 null（Rust 的 `Result::Err`）。 */
export function parseRfc3339(value: string): ParsedDateTime | null {
  const match = RFC3339.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[8]!;
  let offsetMinutes = 0;
  if (zone !== 'Z' && zone !== 'z') {
    const sign = zone[0] === '-' || zone[0] === '\u2212' ? -1 : 1;
    const hours = Number(zone.slice(1, 3));
    const minutes = Number(zone.slice(4, 6));
    // chrono 的 FixedOffset::east_opt 要求 |offset| < 24h。
    if (hours > 23 || minutes > 59) return null;
    offsetMinutes = sign * (hours * 60 + minutes);
  }
  const utcMillis = civilToMillis(year, month, day, hour, minute, second);
  if (utcMillis === null) return null;
  const nanos = fractionNanos(match[7]) + (second === 60 ? 1_000_000_000 : 0);
  // chrono 把闰秒存成 59 秒 + 1e9 纳秒（`NaiveTime::second()` 返回 59）。
  return parsedFromParts(
    { year, month, day, hour, minute, second: second === 60 ? 59 : second, nanos, offsetMinutes },
    utcMillis - offsetMinutes * 60_000,
  );
}

/**
 * `NaiveDateTime::parse_from_str("%Y-%m-%d %H:%M:%S")` 与
 * `"%Y-%m-%dT%H:%M:%S"`（无时区，按 UTC 解释）。
 */
export function parseNaiveDateTime(value: string): ParsedDateTime | null {
  const match = NAIVE.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[5]);
  const minute = Number(match[6]);
  const second = Number(match[7]);
  const utcMillis = civilToMillis(year, month, day, hour, minute, second);
  if (utcMillis === null) return null;
  return parsedFromParts(
    { year, month, day, hour, minute, second: second === 60 ? 59 : second, nanos: second === 60 ? 1_000_000_000 : 0, offsetMinutes: 0 },
    utcMillis,
  );
}

function fromEpochMillis(millis: bigint): ParsedDateTime | null {
  if (millis < DATE_MIN_MS || millis > DATE_MAX_MS) return null;
  const epochNanos = millis * NS_PER_MS;
  const t = civilTime(epochNanos, false);
  return { ...t, epochNanos, millis: Number(millis) };
}

/**
 * `parse_flexible_timestamp_public`（`dstu-sync/src/data_governance/sync/mod.rs:71-95`）。
 *
 * 差异：模块内部的 `SyncManager::parse_flexible_timestamp`（同文件 :4612-4628）
 * 只接受 RFC 3339 / `YYYY-MM-DD HH:MM:SS` / `YYYY-MM-DDTHH:MM:SS`，
 * **不**接受纯数字；调用 `{ numeric: false }` 即得到该版本。
 *
 * 纯数字：>= 1e11 视为毫秒，>= 1e9（且 < 1e11）视为秒；更小的整数返回 null。
 */
export function parseFlexibleTimestamp(
  value: string,
  options: FlexibleTimestampOptions = {},
): ParsedDateTime | null {
  const rfc = parseRfc3339(value);
  if (rfc !== null) return rfc;
  const naive = parseNaiveDateTime(value);
  if (naive !== null) return naive;
  if (options.numeric === false || !INTEGER.test(value)) return null;
  let integer: bigint;
  try {
    integer = BigInt(value);
  } catch {
    return null;
  }
  if (integer < I64_MIN || integer > I64_MAX) return null;
  if (integer >= BigInt(MS_THRESHOLD)) return fromEpochMillis(integer);
  if (integer >= 1_000_000_000n) return fromEpochMillis(integer * 1000n);
  return null;
}

/** `parse_flexible_timestamp_public` 的别名（便于从 sync 迁移时对照）。 */
export function parseFlexibleTimestampPublic(
  value: string,
  options: FlexibleTimestampOptions = {},
): ParsedDateTime | null {
  return parseFlexibleTimestamp(value, options);
}

/** `parse_flexible_timestamp` 的模块内部版本：不接受纯数字。 */
export function parseFlexibleTimestampSqlite(value: string): ParsedDateTime | null {
  return parseFlexibleTimestamp(value, { numeric: false });
}

/** `DateTime<Utc>::timestamp_millis()`。 */
export function parseFlexibleTimestampMillis(value: string): number | null {
  return parseFlexibleTimestamp(value)?.millis ?? null;
}
