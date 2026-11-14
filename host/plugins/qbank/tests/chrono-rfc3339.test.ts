import { describe, expect, it } from 'vitest';
import { parseRfc3339 } from '../../../platform/time/index.ts';
import { chronoRfc3339Error } from '../src/chrono-rfc3339.ts';

const OK = null;
const TOO_SHORT = 'premature end of input';
const INVALID = 'input contains invalid characters';
const OUT_OF_RANGE = 'input is out of range';
const TOO_LONG = 'trailing input';

/** chrono 0.4.41 format/parse.rs:1762-1840 `test_rfc3339` 的输入与期望（同样走 `DateTime::parse_from_rfc3339`）。 */
const CHRONO_VECTORS: Array<[string, string | null]> = [
  ['2015-01-20T17:35:20-08:00', OK],
  ['2015-01-20T17:35:20\u221208:00', OK],
  ['1944-06-06T04:04:00Z', OK],
  ['2001-09-11T09:45:00-08:00', OK],
  ['2015-01-20T17:35:20.001-08:00', OK],
  ['2015-01-20T17:35:20.001\u221208:00', OK],
  ['2015-01-20T17:35:20.000031-08:00', OK],
  ['2015-01-20T17:35:20.000000004-08:00', OK],
  ['2015-01-20T17:35:20.000000004\u221208:00', OK],
  ['2015-01-20T17:35:20.000000000452-08:00', OK],
  ['2015-01-20T17:35:20.000000000452\u221208:00', OK],
  ['2015-01-20 17:35:20-08:00', OK],
  ['2015/01/20T17:35:20.001-08:00', INVALID],
  ['2015-01-20T17-35-20.001-08:00', INVALID],
  ['-01-20T17:35:20-08:00', INVALID],
  ['99-01-20T17:35:20-08:00', INVALID],
  ['99999-01-20T17:35:20-08:00', INVALID],
  ['-2000-01-20T17:35:20-08:00', INVALID],
  ['2015-02-30T17:35:20-08:00', OUT_OF_RANGE],
  ['2015-01-20T25:35:20-08:00', OUT_OF_RANGE],
  ['2015-01-20T17:65:20-08:00', OUT_OF_RANGE],
  ['2015-01-20T17:35:90-08:00', OUT_OF_RANGE],
  ['2015-01-20T17:35:20-24:00', OUT_OF_RANGE],
  ['15-01-20T17:35:20-08:00', INVALID],
  ['15-01-20T17:35:20-08:00:00', INVALID],
  ['2015-01-20T17:35:2008:00', INVALID],
  ['2015-01-20T17:35:20 08:00', INVALID],
  ['2015-01-20T17:35:20Zulu', TOO_LONG],
  ['2015-01-20T17:35:20 Zulu', INVALID],
  ['2015-01-20T17:35:20GMT', INVALID],
  ['2015-01-20T17:35:20 GMT', INVALID],
  ['2015-01-20T17:35:20+GMT', INVALID],
  ['2015-01-20T17:35:20++08:00', INVALID],
  ['2015-01-20T17:35:20--08:00', INVALID],
  ['2015-01-20T17:35:20\u2212\u221208:00', INVALID],
  ['2015-01-20T17:35:20\u00b108:00', INVALID],
  ['2015-01-20T17:35:20-08-00', INVALID],
  ['2015-01-20T17:35:20-08;00', INVALID],
  ['2015-01-20T17:35:20-0800', INVALID],
  ['2015-01-20T17:35:20-08:0', TOO_SHORT],
  ['2015-01-20T17:35:20-08:AA', INVALID],
  ['2015-01-20T17:35:20-08:ZZ', INVALID],
  ['2015-01-20T17:35:20.001-08 : 00', INVALID],
  ['2015-01-20T17:35:20-08:00:00', TOO_LONG],
  ['2015-01-20T17:35:20+08:', TOO_SHORT],
  ['2015-01-20T17:35:20-08:', TOO_SHORT],
  ['2015-01-20T17:35:20\u221208:', TOO_SHORT],
  ['2015-01-20T17:35:20-08', TOO_SHORT],
  ['2015-01-20T', TOO_SHORT],
  ['2015-01-20T00:00:1', TOO_SHORT],
  ['2015-01-20T00:00:1-08:00', INVALID],
];

describe('chrono DateTime::parse_from_rfc3339 ParseError text', () => {
  it.each(CHRONO_VECTORS)('chrono test_rfc3339 vector %j -> %j', (input, expected) => {
    expect(chronoRfc3339Error(input)).toBe(expected);
  });

  it('branches outside the chrono table: leap second, offset minutes, fraction, separators, calendar', () => {
    expect(chronoRfc3339Error('2016-12-31T23:59:60Z')).toBe(OK);
    expect(chronoRfc3339Error('2016-12-31t23:59:59.5z')).toBe(OK);
    expect(chronoRfc3339Error('2024-02-29T00:00:00Z')).toBe(OK);
    expect(chronoRfc3339Error('0000-02-29T00:00:00Z')).toBe(OK);
    expect(chronoRfc3339Error('2023-02-29T00:00:00Z')).toBe(OUT_OF_RANGE);
    expect(chronoRfc3339Error('2100-02-29T00:00:00Z')).toBe(OUT_OF_RANGE);
    expect(chronoRfc3339Error('2015-04-31T00:00:00Z')).toBe(OUT_OF_RANGE);
    expect(chronoRfc3339Error('2015-00-01T00:00:00Z')).toBe(OUT_OF_RANGE);
    expect(chronoRfc3339Error('2015-01-32T00:00:00Z')).toBe(OUT_OF_RANGE);
    // OUT_OF_RANGE from set_month wins over the later separator.
    expect(chronoRfc3339Error('2015-13x')).toBe(OUT_OF_RANGE);
    // Trailing input is checked before the calendar date.
    expect(chronoRfc3339Error('2015-02-30T00:00:00Zx')).toBe(TOO_LONG);
    expect(chronoRfc3339Error('2015-01-20T17:35:20-08:60')).toBe(OUT_OF_RANGE);
    expect(chronoRfc3339Error('2015-01-20T17:35:20-08:6x')).toBe(INVALID);
    expect(chronoRfc3339Error('2015-01-20T17:35:20-99:59')).toBe(OUT_OF_RANGE);
    expect(chronoRfc3339Error('2015-01-20T17:35:20.')).toBe(TOO_SHORT);
    expect(chronoRfc3339Error('2015-01-20T17:35:20.Z')).toBe(INVALID);
    expect(chronoRfc3339Error('2015-01-20T17:35:20')).toBe(TOO_SHORT);
    expect(chronoRfc3339Error('2015-01-20x17:35:20Z')).toBe(INVALID);
    expect(chronoRfc3339Error('2015-01-20')).toBe(TOO_SHORT);
    expect(chronoRfc3339Error('')).toBe(TOO_SHORT);
    expect(chronoRfc3339Error('20')).toBe(TOO_SHORT);
    // number() compares the UTF-8 byte length before looking at the bytes.
    expect(chronoRfc3339Error('2015-0\u4e00')).toBe(INVALID);
    expect(chronoRfc3339Error('2015-01-20T17:35:20\u2212')).toBe(TOO_SHORT);
  });

  it('rejects exactly the inputs platform/time parseRfc3339 rejects', () => {
    const seeds = ['2015-01-20T17:35:20.123-08:00', '2016-12-31 23:59:60\u221223:59', '2024-02-29t00:00:00z'];
    const replacements = ['0', '9', '6', '-', ':', '.', 'T', ' ', 'Z', '+', '\u2212', 'x', '\u4e00'];
    const inputs = new Set<string>();
    for (const seed of seeds) {
      const chars = [...seed];
      for (let i = 0; i <= chars.length; i += 1) {
        inputs.add(chars.slice(0, i).join(''));
        inputs.add([...chars.slice(0, i), ...chars.slice(i + 1)].join(''));
        for (const r of replacements) {
          inputs.add([...chars.slice(0, i), r, ...chars.slice(i + 1)].join(''));
          inputs.add([...chars.slice(0, i), r, ...chars.slice(i)].join(''));
        }
      }
    }
    const disagreements = [...inputs].filter(input => (chronoRfc3339Error(input) === null) !== (parseRfc3339(input) !== null));
    expect(disagreements).toEqual([]);
    expect(inputs.size).toBeGreaterThan(1000);
  });
});
