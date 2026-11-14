/** Millisecond `Date` -> chrono-compatible Unix epoch nanoseconds. */
export function epochNanosFromDate(date: Date): bigint {
  return BigInt(date.getTime()) * 1_000_000n;
}
