/**
 * chrono 时间格式（`Utc::now().to_rfc3339()` / `Local::now()`）。
 *
 * RFC 3339 / chrono AutoSi 来自 F4 平台层 `host/platform/time`；本文件只保留
 * anki 端口需要的薄封装和文件名时间戳格式。
 */
import { toRfc3339 } from '../../../platform/time/index.ts';

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** `Utc::now().to_rfc3339()`：`2026-11-03T02:09:00.123+00:00`。 */
export function nowRfc3339(): string {
  return toRfc3339();
}

/** `Local::now().format("%Y%m%d_%H%M%S")`。 */
export function localStamp(now = new Date()): string {
  return `${pad(now.getFullYear(), 4)}${pad(now.getMonth() + 1, 2)}${pad(now.getDate(), 2)}_${pad(now.getHours(), 2)}${pad(now.getMinutes(), 2)}${pad(now.getSeconds(), 2)}`;
}

/** `Utc::now().format("%Y%m%d%H%M%S")`。 */
export function utcStamp(now = new Date()): string {
  return `${pad(now.getUTCFullYear(), 4)}${pad(now.getUTCMonth() + 1, 2)}${pad(now.getUTCDate(), 2)}${pad(now.getUTCHours(), 2)}${pad(now.getUTCMinutes(), 2)}${pad(now.getUTCSeconds(), 2)}`;
}

/**
 * `chrono::DateTime::<Utc>::from_timestamp_millis(ms).map(|t| t.to_rfc3339())`：
 * 毫秒精度（fraction 为 3 位或省略），偏移写作 `+00:00`；越界返回 null。
 */
export function rfc3339FromMillis(millis: number): string | null {
  if (!Number.isFinite(millis) || !Number.isInteger(millis)) return null;
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return null;
  return toRfc3339(BigInt(millis) * 1_000_000n);
}
