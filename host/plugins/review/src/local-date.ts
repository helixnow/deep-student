/** 本地日历日辅助（对齐 chrono `Local::now().format("%Y-%m-%d")`）。 */
import { civilTime, nowEpochNanos, ymd } from '../../../platform/time/index.ts';
import { utcNow } from './clock.ts';

const MS_PER_MINUTE = 60_000;

/**
 * 本地日历日键（`YYYY-MM-DD`）。
 * 传入 `offsetMinutes`（东偏分为正，如 `UTC+9` 为 `+540`，`UTC-5` 为 `-300`）时，
 * 按该固定偏移计算日历日，不依赖宿主进程时区。
 */
export function localDateKey(at?: Date, offsetMinutes?: number): string {
  if (offsetMinutes !== undefined && Number.isFinite(offsetMinutes)) {
    const baseMs = at === undefined ? utcNow().ms : at.getTime();
    const shifted = BigInt(Math.trunc(baseMs + offsetMinutes * MS_PER_MINUTE)) * 1_000_000n;
    return ymd(civilTime(shifted, false));
  }
  const nanos = at === undefined ? nowEpochNanos() : BigInt(Math.trunc(at.getTime())) * 1_000_000n;
  return ymd(civilTime(nanos, true));
}

/** 纯日历日加减（`YYYY-MM-DD`），经 UTC 整日换算，完全免疫夏令时 23h/25h 日切偏移。 */
export function addLocalDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  const shifted = new Date(Date.UTC(year!, month! - 1, day! + Math.trunc(days)));
  return ymd({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
    nanos: 0,
    offsetMinutes: 0,
  });
}

/** `chrono::Utc::now().to_rfc3339()`（AutoSi 小数位，偏移 `+00:00`）。 */
export function utcNowRfc(): string {
  return utcNow().rfc;
}
