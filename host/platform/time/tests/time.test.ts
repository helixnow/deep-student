import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chronoRfc3339,
  chronoStamp,
  civilTime,
  now,
  nowEpochNanos,
  orderedNowEpochNanos,
  parseFlexibleTimestamp,
  parseFlexibleTimestampMillis,
  parseFlexibleTimestampSqlite,
  parseNaiveDateTime,
  parseRfc3339,
  toRfc3339,
  toRfc3339Opts,
  ymd,
} from '../index.ts';

const EPOCH = 1_700_000_000_000_000_000n;

describe('chrono to_rfc3339 / to_rfc3339_opts', () => {
  it('AutoSi uses variable 0/3/6/9 fractional digits and +00:00 for UTC', () => {
    expect(toRfc3339(0n)).toBe('1970-01-01T00:00:00+00:00');
    expect(toRfc3339(EPOCH)).toBe('2023-11-14T22:13:20+00:00');
    expect(toRfc3339(EPOCH + 123_000_000n)).toBe('2023-11-14T22:13:20.123+00:00');
    expect(toRfc3339(EPOCH + 123_456_000n)).toBe('2023-11-14T22:13:20.123456+00:00');
    expect(toRfc3339(EPOCH + 123_456_789n)).toBe('2023-11-14T22:13:20.123456789+00:00');
    expect(chronoRfc3339(EPOCH + 123_000_000n)).toBe('2023-11-14T22:13:20.123+00:00');
  });

  it('renders negative epochs with floor semantics', () => {
    expect(toRfc3339(-1_000_000_000n)).toBe('1969-12-31T23:59:59+00:00');
    expect(toRfc3339(-500_000_000n)).toBe('1969-12-31T23:59:59.500+00:00');
  });

  it('honours every SecondsFormat', () => {
    expect(toRfc3339Opts(EPOCH + 123_456_789n, 'Secs')).toBe('2023-11-14T22:13:20+00:00');
    expect(toRfc3339Opts(EPOCH + 123_456_789n, 'Millis')).toBe('2023-11-14T22:13:20.123+00:00');
    expect(toRfc3339Opts(EPOCH + 123_456_789n, 'Micros')).toBe('2023-11-14T22:13:20.123456+00:00');
    expect(toRfc3339Opts(EPOCH + 123_456_789n, 'Nanos')).toBe('2023-11-14T22:13:20.123456789+00:00');
    expect(toRfc3339Opts(EPOCH + 123_456_789n, 'AutoSi')).toBe('2023-11-14T22:13:20.123456789+00:00');
  });

  it('use_z only applies to a zero offset', () => {
    expect(toRfc3339Opts(EPOCH, 'Millis', true)).toBe('2023-11-14T22:13:20.000Z');
    expect(toRfc3339Opts(EPOCH, 'Secs', true, 0)).toBe('2023-11-14T22:13:20Z');
    expect(toRfc3339Opts(0n, 'Secs', false, 480)).toBe('1970-01-01T08:00:00+08:00');
    expect(toRfc3339Opts(0n, 'Secs', true, 480)).toBe('1970-01-01T08:00:00+08:00');
    expect(toRfc3339Opts(0n, 'Secs', false, -330)).toBe('1969-12-31T18:30:00-05:30');
  });

  it('formats out-of-range years like chrono (explicit sign)', () => {
    const farFuture = 253_402_300_799n * 1_000_000_000n; // 9999-12-31T23:59:59Z
    expect(toRfc3339(farFuture)).toBe('9999-12-31T23:59:59+00:00');
  });
});

describe('chrono parse_from_rfc3339', () => {
  it('parses offsets, fractions and case-insensitive separators', () => {
    const parsed = parseRfc3339('2023-11-14T22:13:20.123456789+02:30')!;
    expect(parsed.offsetMinutes).toBe(150);
    expect(parsed.epochNanos).toBe(BigInt(Date.UTC(2023, 10, 14, 19, 43, 20)) * 1_000_000n + 123_456_789n);
    expect(parsed.millis).toBe(Date.UTC(2023, 10, 14, 19, 43, 20) + 123);
    expect(parseRfc3339('2023-11-14t22:13:20z')!.millis).toBe(Date.UTC(2023, 10, 14, 22, 13, 20));
    expect(parseRfc3339('2023-11-14 22:13:20Z')!.millis).toBe(Date.UTC(2023, 10, 14, 22, 13, 20));
    // chrono `timezone_offset` 接受 U+2212 MINUS SIGN。
    expect(parseRfc3339('2023-11-14T22:13:20\u221205:00')!.millis).toBe(Date.UTC(2023, 10, 15, 3, 13, 20));
  });

  it('normalises leap seconds to the following whole second', () => {
    const leap = parseRfc3339('2016-12-31T23:59:60Z')!;
    expect(leap.epochNanos).toBe(BigInt(Date.UTC(2017, 0, 1)) * 1_000_000n);
    expect(leap.second).toBe(59);
    expect(leap.nanos).toBe(1_000_000_000);
  });

  it('rejects invalid dates, offsets and missing timezones', () => {
    for (const invalid of [
      '2023-13-01T00:00:00Z',
      '2023-02-29T00:00:00Z',
      '2023-11-14T24:00:00Z',
      '2023-11-14T22:13:20+24:00',
      '2023-11-14T22:13:20',
      '2023-11-14T22:13:20Zjunk',
      '2023-11-14T22:13:20,123Z',
    ]) {
      expect(parseRfc3339(invalid), invalid).toBeNull();
    }
  });
});

describe('parse_flexible_timestamp (public vs internal)', () => {
  it('accepts RFC 3339, SQLite text and both T/space forms', () => {
    expect(parseFlexibleTimestamp('2023-11-14T22:13:20Z')!.millis).toBe(Number(EPOCH / 1_000_000n));
    expect(parseFlexibleTimestamp('2023-11-14 22:13:20')!.millis).toBe(Number(EPOCH / 1_000_000n));
    expect(parseFlexibleTimestamp('2023-11-14T22:13:20')!.millis).toBe(Number(EPOCH / 1_000_000n));
    expect(parseNaiveDateTime('2026-1-2 3:4:5')!.millis).toBe(Date.UTC(2026, 0, 2, 3, 4, 5));
  });

  it('public version accepts integer milliseconds and seconds', () => {
    expect(parseFlexibleTimestamp('1700000000000')!.millis).toBe(1_700_000_000_000);
    expect(parseFlexibleTimestamp('1700000000')!.millis).toBe(1_700_000_000_000);
    expect(parseFlexibleTimestampMillis('1700000000')).toBe(1_700_000_000_000);
    expect(parseFlexibleTimestamp('999999999')).toBeNull();
    expect(parseFlexibleTimestamp('0')).toBeNull();
    expect(parseFlexibleTimestamp('9223372036854775808')).toBeNull();
    expect(parseFlexibleTimestamp('-9223372036854775808')).toBeNull();
    // chrono DateTime 上限 +262142-12-31T23:59:59.999Z；再多 1ms 返回 None。
    expect(parseFlexibleTimestamp('8210266876799999')!.millis).toBe(8_210_266_876_799_999);
    expect(parseFlexibleTimestamp('8210266876800000')).toBeNull();
  });

  it('internal version rejects numeric timestamps', () => {
    expect(parseFlexibleTimestampSqlite('1700000000000')).toBeNull();
    expect(parseFlexibleTimestamp('1700000000000', { numeric: false })).toBeNull();
    expect(parseFlexibleTimestampSqlite('2023-11-14T22:13:20Z')!.millis).toBe(Number(EPOCH / 1_000_000n));
  });
});

describe('single-instant capture and civil helpers', () => {
  it('now returns a consistent millis/string pair from one sample', () => {
    const instant = now();
    expect(instant.rfc3339).toBe(toRfc3339(instant.epochNanos));
    expect(instant.millis).toBe(Number(instant.epochNanos / 1_000_000n));
    expect(parseRfc3339(instant.rfc3339)!.epochNanos).toBe(instant.epochNanos);
    expect(instant.epochNanos).toBeGreaterThanOrEqual(nowEpochNanos() - 1_000_000_000n);
  });

  it('civilTime, ymd and chronoStamp match chrono field formatting', () => {
    const t = civilTime(EPOCH + 123_456_789n, false);
    expect(t).toMatchObject({ year: 2023, month: 11, day: 14, hour: 22, minute: 13, second: 20, nanos: 123_456_789, offsetMinutes: 0 });
    expect(ymd(t)).toBe('2023-11-14');
    expect(chronoStamp(t, '-', true)).toBe('2023-11-14T22-13-20.123');
    expect(chronoStamp(t, '_', false)).toBe('2023-11-14T22_13_20');
  });
});

describe('nowEpochNanos / orderedNowEpochNanos', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('nowEpochNanos keeps returning the frozen instant under fake Date and performance', () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    vi.setSystemTime(Date.parse('2099-01-01T00:00:00Z'));
    const frozen = BigInt(Date.parse('2099-01-01T00:00:00Z')) * 1_000_000n;
    expect([nowEpochNanos(), nowEpochNanos()]).toEqual([frozen, frozen]);
  });

  it('ordered back-to-back samples are strictly increasing on the real clocks', () => {
    const samples = Array.from({ length: 50_000 }, () => orderedNowEpochNanos());
    const unordered = samples.filter((value, index) => index > 0 && value <= samples[index - 1]!).length;
    expect(unordered).toBe(0);
  });

  it('ordered samples inside one wall-clock millisecond stay ordered when the sub-millisecond clock stalls', () => {
    const wallMs = 1_900_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(wallMs);
    vi.spyOn(performance, 'now').mockReturnValue(wallMs - performance.timeOrigin + 0.25);
    const first = orderedNowEpochNanos();
    const second = orderedNowEpochNanos();
    const third = orderedNowEpochNanos();
    expect(first).toBeGreaterThanOrEqual(BigInt(wallMs) * 1_000_000n);
    expect(second > first && third > second).toBe(true);
    expect(third - first).toBeLessThan(1_000_000n);
  });

  it('an ordered sample after a wall-clock step back of a millisecond or more passes through like Utc::now()', () => {
    const wallMs = 1_900_000_000_000;
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(wallMs);
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - performance.timeOrigin);
    const before = orderedNowEpochNanos();
    dateNow.mockReturnValue(wallMs - 5_000);
    const after = orderedNowEpochNanos();
    expect(after).toBe(BigInt(wallMs - 5_000) * 1_000_000n);
    expect(after < before).toBe(true);
  });
});
