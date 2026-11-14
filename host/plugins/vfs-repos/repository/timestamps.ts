/**
 * Timestamp helpers for the VFS repos, backed by `host/platform/time`.
 *
 * Most repo tables store Rust's `%Y-%m-%dT%H:%M:%S%.3fZ` (always three
 * fractional digits, `Z` suffix), while the `to_rfc3339()` call sites use
 * chrono's AutoSi form (`+00:00`, 0/3/6/9 digits).
 */
import { nowEpochNanos, orderedNowEpochNanos, toRfc3339, toRfc3339Opts } from '../../../platform/time/index.ts';

/** Rust `Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ")`. */
export function utcTimestamp(): string {
  return toRfc3339Opts(nowEpochNanos(), 'Millis', true);
}

/** `utcTimestamp()` for an explicit Unix millisecond value. */
export function utcTimestampFromMillis(millis: number): string {
  return toRfc3339Opts(BigInt(millis) * 1_000_000n, 'Millis', true);
}

/**
 * Rust `Utc::now().to_rfc3339()` (AutoSi, UTC offset `+00:00`). Ordered so that values written within
 * one wall-clock millisecond keep their write order, as chrono's nanosecond clock does.
 */
export function utcNow(): string {
  return toRfc3339(orderedNowEpochNanos());
}
