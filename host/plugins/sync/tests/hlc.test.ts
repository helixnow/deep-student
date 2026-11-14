import { expect, it } from 'vitest';
import { Hlc, MAX_HLC_MILLIS } from '../src/hlc.ts';

it('test_hlc_encoding_is_lex_sortable', () => {
  const a = new Hlc(1_700_000_000_000n, 0);
  const b = new Hlc(1_700_000_000_001n, 0);
  const c = new Hlc(1_700_000_000_000n, 1);
  expect(a.toString() < b.toString()).toBe(true);
  expect(a.toString() < c.toString()).toBe(true);
  expect(c.toString() < b.toString()).toBe(true);
});
it('test_hlc_parse_roundtrip', () => {
  const h = new Hlc(1_700_000_000_123n, 42);
  expect(Hlc.parse(h.toString())).toEqual(h);
});
it('test_hlc_u64_roundtrip', () => {
  const h = new Hlc(1_700_000_000_123n, 42);
  expect(Hlc.fromU64(h.toU64())).toEqual(h);
});
it('test_lex_order_matches_hlc_order_for_sequence', () => {
  const xs = Array.from({ length: 10 }, (_, i) => [
    new Hlc(1_700_000_000_000n + BigInt(i), 0),
    new Hlc(1_700_000_000_000n + BigInt(i), 1),
  ]).flat();
  const byStruct = [...xs].sort((a, b) => a.millis < b.millis ? -1 : a.millis > b.millis ? 1 : a.counter - b.counter);
  expect(xs.map(x => x.toString()).sort().map(s => Hlc.parse(s))).toEqual(byStruct);
});
it('preserves Rust integer parsing and packing bounds', () => {
  expect(Hlc.parse('+18446744073709551615-+65535')?.millis).toBe(18446744073709551615n);
  for (const value of ['18446744073709551616-0', '0-65536', ' 1-0', '1-0-0', '-1-0', '1']) {
    expect(Hlc.parse(value)).toBeNull();
  }
  expect(new Hlc(MAX_HLC_MILLIS, 65535).toU64()).toBe(18446744073709551615n);
  expect(() => new Hlc(MAX_HLC_MILLIS + 1n, 0).toU64()).toThrow('HLC millis exceeds 48-bit range');
});
