/** 本地日历日辅助（对齐 chrono `Local::now().format("%Y-%m-%d")`）。 */
import { civilTime, nowEpochNanos, ymd } from '../../../platform/time/index.ts';
import { utcNow } from './clock.ts';

export function localDateKey(at?: Date): string {
  const nanos = at === undefined ? nowEpochNanos() : BigInt(at.getTime()) * 1_000_000n;
  return ymd(civilTime(nanos, true));
}

export function addLocalDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(year!, month! - 1, day!, 12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return localDateKey(date);
}

/** `chrono::Utc::now().to_rfc3339()`（AutoSi 小数位，偏移 `+00:00`）。 */
export function utcNowRfc(): string {
  return utcNow().rfc;
}
