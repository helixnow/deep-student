import { expect, it } from 'vitest';
import { f32ToJsonNumber } from '../api.ts';
import { f32ToJsonNumber as indexExport } from '../index.ts';

const fromBits = (bits: number): number => {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, bits);
  return view.getFloat32(0);
};

it('f32ToJsonNumber matches L12 percent cases and zmij 1.0.21 static ftoa vectors', () => {
  expect(indexExport).toBe(f32ToJsonNumber);
  // L12 ProcessingProgress.percent: do not expose the widened f32's long f64 decimal.
  expect(f32ToJsonNumber(33.33333206176758)).toBe(33.333332);
  expect(f32ToJsonNumber(Math.fround(1e20))).toBe(1e20);
  expect(f32ToJsonNumber(Math.fround(1.1))).toBe(1.1);
  expect(f32ToJsonNumber(-Math.fround(1.1))).toBe(-1.1);
  // https://github.com/dtolnay/zmij/blob/1.0.21/tests/test.rs ftoa_test::{normal,subnormal}
  for (const decimal of [6.62607e-34, 134217800, 134217810, 1e-45]) {
    expect(f32ToJsonNumber(Math.fround(decimal))).toBe(decimal);
    expect(f32ToJsonNumber(-Math.fround(decimal))).toBe(-decimal);
  }
});

it('f32ToJsonNumber handles signed zero, non-finite input and overflow during narrowing', () => {
  expect(Object.is(f32ToJsonNumber(-0), -0)).toBe(true);
  expect(Object.is(f32ToJsonNumber(-1e-100), -0)).toBe(true);
  expect(Object.is(f32ToJsonNumber(0), 0)).toBe(true);
  for (const value of [NaN, Infinity, -Infinity, Number.MAX_VALUE, -Number.MAX_VALUE]) {
    expect(f32ToJsonNumber(value)).toBeNull();
  }
});

it('f32ToJsonNumber chooses shortest decimals at binary and decimal boundaries', () => {
  const vectors: [number, number][] = [
    [0x00000001, 1e-45], [0x00000002, 3e-45],
    [0x007fffff, 1.1754942e-38], [0x00800000, 1.1754944e-38],
    [0x3dcccccd, 0.1], [0x3f7fffff, 0.99999994],
    [0x3f800000, 1], [0x3f800001, 1.0000001],
    [0x7f7fffff, 3.4028235e38],
    // Exactly representable binary fraction.
    [0x49800004, 1048576.5],
    // 2097152.25: 2097152.2 and 2097152.3 are equidistant shortest
    // roundtrips; choose the even decimal coefficient (zmij Schubfach tie rule).
    [0x4a000001, 2097152.2],
  ];
  for (const [bits, decimal] of vectors) {
    expect(f32ToJsonNumber(fromBits(bits))).toBe(decimal);
    expect(Math.fround(decimal)).toBe(fromBits(bits));
  }
});

it('f32ToJsonNumber preserves f32 roundtrip across every finite exponent and both signs', () => {
  for (let exponent = 0; exponent < 255; exponent++) {
    for (const fraction of [1, 0x3fffff, 0x7fffff]) {
      const value = fromBits((exponent << 23) | fraction);
      for (const signed of [value, -value]) {
        const projected = f32ToJsonNumber(signed);
        expect(projected).not.toBeNull();
        expect(Math.fround(projected!)).toBe(signed);
      }
    }
  }
});
