import { expect, it } from 'vitest';
import { rfcNanosAfter, utcNow } from '../src/clock.ts';

it('now_instant_uses_one_utc_reading_with_chrono_autosi_fraction', () => {
  const now = utcNow();
  expect(now.rfc).toMatch(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3}|\.\d{6}|\.\d{9})?\+00:00$/,
  );
  expect(Math.abs(Date.parse(now.rfc) - now.ms)).toBeLessThan(1000);
});

it('rfc_nanos_after_keeps_chrono_nanosecond_precision_for_retry_stamps', () => {
  const nanos = BigInt(Date.UTC(2026, 10, 3, 2, 9, 0)) * 1_000_000n + 123_456_000n;
  const instant = { nanos, ms: Number(nanos / 1_000_000n), rfc: '2026-11-03T02:09:00.123456+00:00' };
  expect(rfcNanosAfter(instant, 1n)).toBe('2026-11-03T02:09:00.123456001+00:00');
  expect(rfcNanosAfter(instant, -60_000_000_000n)).toBe('2026-11-03T02:08:00.123456+00:00');
});
