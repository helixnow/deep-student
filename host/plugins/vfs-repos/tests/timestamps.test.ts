import { afterEach, describe, expect, it, vi } from 'vitest';
import { utcNow } from '../repository/timestamps.ts';

afterEach(() => { vi.restoreAllMocks(); });

const RFC3339_UTC = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?\+00:00$/;
const epochNanos = (stamp: string): bigint => {
  const match = RFC3339_UTC.exec(stamp);
  expect(match, stamp).not.toBeNull();
  const seconds = BigInt(Date.parse(`${match![1]}Z`) / 1000);
  return seconds * 1_000_000_000n + BigInt((match![2] ?? '').padEnd(9, '0'));
};

describe('vfs-repos timestamps', () => {
  // Rust `Utc::now()` has nanosecond resolution, so rows written back to back sort in write order.
  it('utcNow stays strictly increasing while the wall clock millisecond does not advance', () => {
    const wall = Date.now() + 86_400_000;
    vi.spyOn(Date, 'now').mockReturnValue(wall);
    vi.spyOn(performance, 'now').mockReturnValue(wall - performance.timeOrigin);
    const stamps = Array.from({ length: 4 }, () => utcNow());
    const nanos = stamps.map(epochNanos);
    for (let i = 1; i < nanos.length; i++) expect(nanos[i]! > nanos[i - 1]!, stamps.join(' ')).toBe(true);
    expect(nanos[0]! / 1_000_000n).toBe(BigInt(wall));
  });
});
