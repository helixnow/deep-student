/**
 * Millisecond-epoch adapters over F4 `host/platform/time`.
 *
 * All RFC 3339 formatting/parsing lives in the platform module; this file only
 * converts the lane's epoch-millisecond values to the nanosecond representation
 * the platform API uses.
 */
import {
  parseRfc3339 as parsePlatformRfc3339,
  toRfc3339,
  toRfc3339Opts,
} from '../../../platform/time/index.ts';

const NS_PER_MS = 1_000_000n;

/** Duration/instant unit conversion only; avoid rounding large integer milliseconds. */
export function millisecondsToNanos(millis: number): bigint {
  const whole = Math.trunc(millis);
  return BigInt(whole) * NS_PER_MS + BigInt(Math.trunc((millis - whole) * 1_000_000));
}

/** chrono `DateTime::to_rfc3339()` (AutoSi, `+00:00`) for an epoch-millisecond value. */
export function chronoAutoSiUtc(epochMs: number): string {
  return toRfc3339(BigInt(Math.trunc(epochMs)) * NS_PER_MS);
}

/** chrono `to_rfc3339_opts(SecondsFormat::AutoSi, true)` (`Z`) for an epoch-millisecond value. */
export function chronoAutoSiZ(epochMs: number): string {
  return toRfc3339Opts(BigInt(Math.trunc(epochMs)) * NS_PER_MS, 'AutoSi', true);
}

/** chrono `DateTime::parse_from_rfc3339`, reduced to epoch milliseconds. */
export function parseEpochMillis(value: string): number | null {
  return parsePlatformRfc3339(value)?.millis ?? null;
}
