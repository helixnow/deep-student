// Browser timestamps delegate to the published F4 platform time module.
import { toRfc3339 } from '../../../platform/time/index.ts';

/** Millisecond `Date` -> chrono-compatible Unix epoch nanoseconds. */
export function epochNanosFromDate(date: Date): bigint {
  return BigInt(date.getTime()) * 1_000_000n;
}

/** `chrono::DateTime<Utc>::to_rfc3339()` for a millisecond `Date`. */
export function formatTimestamp(date: Date): string {
  return toRfc3339(epochNanosFromDate(date));
}

/** `Utc::now().to_rfc3339()` using the caller's clock. */
export function nowTimestamp(now: () => Date = () => new Date()): string {
  return formatTimestamp(now());
}
