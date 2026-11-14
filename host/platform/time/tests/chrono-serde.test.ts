import { describe, expect, it } from 'vitest';
import { parseChronoDateTimeUtc } from '../api.ts';
import { parseChronoDateTimeUtc as parseFromIndex, parseRfc3339 } from '../index.ts';

describe('chrono 0.4.41 DateTime<Utc> serde / FromStr public entry', () => {
  it('test_datetime_from_str: UTC assertions (datetime/tests.rs:903-946,974-997)', () => {
    for (const text of [
      '2015-02-18T23:16:9.15Z',
      '2015-02-18T23:16:9.15 UTC',
      '2015-02-18T23:16:9.15UTC',
      '2015-02-18T23:16:9.15Utc',
      '2015-2-18T23:16:9.15Z',
      '2015-2-18T13:16:9.15-10:00',
    ]) {
      expect(parseChronoDateTimeUtc(text), text).toMatchObject({
        year: 2015, month: 2, day: 18, hour: 23, minute: 16, second: 9,
        nanos: 150_000_000, offsetMinutes: 0,
      });
    }
    expect(parseChronoDateTimeUtc('2015-2-18T23:16:9.15')).toBeNull();
    expect(parseChronoDateTimeUtc('2015-02-18T23:16:9.15øøø')).toBeNull();
  });

  it('test_serde_deserialize: UTC normalization and invalid date (datetime/serde.rs:1253-1256,1291)', () => {
    for (const text of ['2014-07-24T12:34:06Z', '2014-07-24T13:57:06+01:23']) {
      expect(parseChronoDateTimeUtc(text), text).toMatchObject({
        year: 2014, month: 7, day: 24, hour: 12, minute: 34, second: 6,
        nanos: 0, offsetMinutes: 0,
      });
    }
    expect(parseChronoDateTimeUtc('2014-07-32T12:34:06Z')).toBeNull();
  });

  it('publishes the same parser from api/index and accepts the OAuth blocker examples', () => {
    expect(parseFromIndex).toBe(parseChronoDateTimeUtc);
    for (const text of ['2012-12-12 12:12:12+0000', '2012-12-12 12:12:12 UTC']) {
      expect(parseFromIndex(text), text).toEqual({
        year: 2012, month: 12, day: 12, hour: 12, minute: 12, second: 12,
        nanos: 0, offsetMinutes: 0, epochNanos: 1_355_314_332_000_000_000n, millis: 1_355_314_332_000,
      });
      expect(parseRfc3339(text), 'the strict entry retains its narrower grammar').toBeNull();
    }
  });

  it('test_parse_datetime_utc: upstream valid input corpus with canonical UTC parse pairs', () => {
    // All 24 source inputs (datetime/tests.rs:1003-1052). Canonical strings are
    // fixed vectors, not a test-local formatter or an assertion about Debug output.
    const pairs = [
      ['2001-02-03T04:05:06Z', '2001-02-03T04:05:06Z'],
      ['2001-02-03T04:05:06+0000', '2001-02-03T04:05:06Z'],
      ['2001-02-03T04:05:06-00:00', '2001-02-03T04:05:06Z'],
      ['2001-02-03T04:05:06-01:00', '2001-02-03T05:05:06Z'],
      ...[
        '2012-12-12 12:12:12Z', '2012-12-12t12:12:12Z', '2012-12-12T12:12:12Z',
        '2012 -12-12T12:12:12Z', '2012  -12-12T12:12:12Z',
        '2012- 12-12T12:12:12Z', '2012-  12-12T12:12:12Z',
        '2012-12-12T 12:12:12Z', '2012-12-12T12 :12:12Z', '2012-12-12T12  :12:12Z',
        '2012-12-12T12: 12:12Z', '2012-12-12T12:  12:12Z', '2012-12-12T12 : 12:12Z',
        '2012-12-12T12:12:12Z ', ' 2012-12-12T12:12:12Z',
      ].map((text) => [text, '2012-12-12T12:12:12Z']),
      ['2015-02-18T23:16:09.153Z', '2015-02-18T23:16:09.153Z'],
      ['2015-2-18T23:16:09.153Z', '2015-02-18T23:16:09.153Z'],
      ['+2015-2-18T23:16:09.153Z', '2015-02-18T23:16:09.153Z'],
      ['-77-02-18T23:16:09Z', '-0077-02-18T23:16:09Z'],
      ['+82701-05-6T15:9:60.898989898989Z', '+82701-05-06T15:09:60.898989898Z'],
    ];
    for (const [text, canonical] of pairs) {
      const parsed = parseChronoDateTimeUtc(text!);
      expect(parsed, text).not.toBeNull();
      expect(parsed, text).toEqual(parseChronoDateTimeUtc(canonical!));
      expect(parsed!.offsetMinutes, text).toBe(0);
    }
    expect(parseChronoDateTimeUtc('-77-02-18T23:16:09Z')!.year).toBe(-77);
    expect(parseChronoDateTimeUtc('+82701-05-6T15:9:60.898989898989Z')).toMatchObject({
      year: 82701, month: 5, day: 6, hour: 15, minute: 9, second: 59, nanos: 1_898_989_898,
    });
  });

  it('test_parse_datetime_utc: all upstream rejected inputs (datetime/tests.rs:1054-1086)', () => {
    for (const text of [
      '', 'Z', '15Z', '15:8:9Z', '15-8-9Z', 'Fri, 09 Aug 2013 23:54:35 GMT',
      'Sat Jun 30 23:59:60 2012', '1441497364.649', '+1441497364.649', '+1441497364',
      '+1441497364Z', '2014/02/03 04:05:06Z', '2001-02-03T04:05:0600:00',
      '2015-15-15T15:15:15Z', '2012-12-12T12:12:12x', '2012-123-12T12:12:12Z',
      '2012-12-77T12:12:12Z', '2012-12-12T26:12:12Z', '2012-12-12T12:61:12Z',
      '2012-12-12T12:12:62Z', '2012-12-12 T12:12:12Z', '2012-12-12T12:12:12ZZ',
      '+802701-12-12T12:12:12Z', '+ 2012-12-12T12:12:12Z',
      '  +82701  -  05  -  6  T  15  :  9  : 60.898989898989   Z',
    ]) expect(parseChronoDateTimeUtc(text), text).toBeNull();
  });

  it('matches Rust White_Space only at the positions accepted by each scanner', () => {
    for (const space of [
      '\t', '\n', '\v', '\f', '\r', ' ', '\u0085', '\u00a0', '\u1680',
      '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006',
      '\u2007', '\u2008', '\u2009', '\u200a', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000',
    ]) {
      const text = `${space}1970${space}-${space}1${space}-${space}1T${space}0${space}:${space}0${space}:${space}0${space}+00:${space}:00${space}`;
      expect(parseChronoDateTimeUtc(text), JSON.stringify(space)).toEqual({
        year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0,
        nanos: 0, offsetMinutes: 0, epochNanos: 0n, millis: 0,
      });
    }
    for (const text of [
      '1970-1-1\t0:0:0Z', '1970-1-1\u00a00:0:0Z', '1970-1-1 T0:0:0Z',
      '1970-1-1\nT0:0:0Z', '1970-1-1T0:0:0 .1Z', '1970-1-1T0:0:0. 1Z',
      '1970-1-1T0:0:0+ 00:00', '1970-1-1T0:0:0+0 0:00', '1970-1-1T0:0:0+00:0 0',
      '\ufeff1970-1-1T0:0:0Z', '1970-1-1T0:0:0Z\ufeff', '1970-1-1T0:0:0Z\u200b',
    ]) expect(parseChronoDateTimeUtc(text), text).toBeNull();
  });

  it('requires a complete timezone and normalizes offsets across day/year boundaries', () => {
    for (const zone of ['Z', 'z', 'UTC', 'utc', 'uTc', '+0000', '-00:00', '−00::00', '+00 00']) {
      expect(parseChronoDateTimeUtc(`1970-1-1 0:0:0${zone}`)!.epochNanos, zone).toBe(0n);
    }
    expect(parseChronoDateTimeUtc('1970-1-1 0:0:0.000000001+00:01')).toEqual({
      year: 1969, month: 12, day: 31, hour: 23, minute: 59, second: 0,
      nanos: 1, offsetMinutes: 0, epochNanos: -59_999_999_999n, millis: -60_000,
    });
    expect(parseChronoDateTimeUtc('1969-12-31 23:59:59.999999999−00:01')).toEqual({
      year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 59,
      nanos: 999_999_999, offsetMinutes: 0, epochNanos: 59_999_999_999n, millis: 59_999,
    });
    for (const zone of ['+2359', '-23::59']) {
      expect(parseChronoDateTimeUtc(`1970-1-1T0:0:0${zone}`)!.epochNanos, zone)
        .toBe(zone[0] === '+' ? -86_340_000_000_000n : 86_340_000_000_000n);
    }
    for (const zone of ['', ' ', '+00', '+00:', '+0:00', '+000', '+00:0', '+24:00',
      '-99:00', '+00:60', '+00:99', '+00:00:00', 'GMT', 'UT', 'UTC+00:00', 'zjunk', 'Ｚ']) {
      expect(parseChronoDateTimeUtc(`1970-1-1T0:0:0${zone}`), zone).toBeNull();
    }
  });

  it('preserves nanoseconds, truncated extra digits and the leap-second representation', () => {
    for (const [fraction, nanos] of [
      ['', 0], ['.1', 100_000_000], ['.123456', 123_456_000],
      ['.123456789', 123_456_789], ['.123456789999', 123_456_789], ['.0000000009', 0],
    ] as const) {
      expect(parseChronoDateTimeUtc(`1970-1-1T0:0:0${fraction}Z`)!.epochNanos).toBe(BigInt(nanos));
      expect(parseChronoDateTimeUtc(`2017-1-1T0:59:60${fraction}+0100`)).toEqual({
        year: 2016, month: 12, day: 31, hour: 23, minute: 59, second: 59,
        nanos: 1_000_000_000 + nanos, offsetMinutes: 0,
        epochNanos: 1_483_228_800_000_000_000n + BigInt(nanos),
        millis: 1_483_228_800_000 + Math.floor(nanos / 1_000_000),
      });
    }
    expect(parseChronoDateTimeUtc('1969-12-31T23:59:59.999999999Z')!.epochNanos).toBe(-1n);
    expect(parseChronoDateTimeUtc('1969-12-31T23:59:59.999999999Z')!.millis).toBe(-1);
    // Chrono accepts :60 on any valid calendar date/minute, not only historical leap dates.
    expect(parseChronoDateTimeUtc('1970-1-1T0:0:60Z')).toMatchObject({ second: 59, nanos: 1_000_000_000 });
    for (const text of ['1970-1-1T0:0:0.Z', '1970-1-1T0:0:0,1Z', '1970-1-1T0:0:0.１Z']) {
      expect(parseChronoDateTimeUtc(text), text).toBeNull();
    }
  });

  it('enforces chrono local and UTC calendar limits without narrowing signed years or leap seconds', () => {
    expect(parseChronoDateTimeUtc('-262143-01-01T00:00:00Z')!.epochNanos).toBe(-8_334_601_228_800_000_000_000n);
    expect(parseChronoDateTimeUtc('+262142-12-31T23:59:59.999999999Z')!.epochNanos).toBe(8_210_266_876_799_999_999_999n);
    expect(parseChronoDateTimeUtc('+262142-12-31T23:59:60.999999999Z')).toMatchObject({
      year: 262142, month: 12, day: 31, second: 59, nanos: 1_999_999_999,
      epochNanos: 8_210_266_876_800_999_999_999n,
    });
    expect(parseChronoDateTimeUtc('-262143-01-01T00:01:00+0001')!.epochNanos).toBe(-8_334_601_228_800_000_000_000n);
    expect(parseChronoDateTimeUtc('+262142-12-31T23:58:59-0001')!.epochNanos).toBe(8_210_266_876_799_000_000_000n);
    for (const year of ['0', '-0', '+0000000000000000000000000000']) {
      expect(parseChronoDateTimeUtc(`${year}-2-29T0:0:0Z`)!.year).toBe(0);
    }
    for (const text of [
      '-262144-12-31T23:59:59-2359', '+262143-01-01T00:00:00+2359',
      '-262143-01-01T00:00:00+0001', '+262142-12-31T23:59:59-0001',
      '10000-1-1T0:0:0Z', '- 77-1-1T0:0:0Z', '−77-1-1T0:0:0Z',
      '+9223372036854775808-1-1T0:0:0Z', '1970-0-1T0:0:0Z', '1970-1-0T0:0:0Z',
      '1900-2-29T0:0:0Z', '2001-2-29T0:0:0Z', '2000-4-31T0:0:0Z',
      '2000-1-1T24:0:0Z', '2000-1-1T0:60:0Z', '2000-1-1T0:0:61Z',
      '2000-1-1T-1:0:0Z', '２０００-1-1T0:0:0Z',
    ]) expect(parseChronoDateTimeUtc(text), text).toBeNull();
    expect(parseChronoDateTimeUtc('+10000-1-1T0:0:0Z')!.year).toBe(10000);
    expect(parseChronoDateTimeUtc('2000-2-29T0:0:0Z')!.day).toBe(29);
  });
});
