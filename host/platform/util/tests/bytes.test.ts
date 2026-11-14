/** `bytes.ts` matches the `Buffer` calls it replaces. */
import { describe, expect, it } from 'vitest';
import { compareBytes, concatBytes, readU16be, readU32be, readU64be, u16be, u32be, u64be, writeU16be, writeU32be, writeU64be } from '../bytes.ts';

describe('portable byte helpers', () => {
  it('big-endian writers produce the same bytes as Buffer and readers invert them', () => {
    const u16 = Buffer.alloc(2); u16.writeUInt16BE(0xfedc);
    const u32 = Buffer.alloc(4); u32.writeUInt32BE(0xfedcba98);
    const u64 = Buffer.alloc(8); u64.writeBigUInt64BE(0xfedcba9876543210n);
    expect(u16be(0xfedc)).toEqual(new Uint8Array(u16));
    expect(u32be(0xfedcba98)).toEqual(new Uint8Array(u32));
    expect(u64be(0xfedcba9876543210n)).toEqual(new Uint8Array(u64));
    expect(readU16be(u16)).toBe(0xfedc);
    expect(readU32be(u32)).toBe(0xfedcba98);
    expect(readU64be(u64)).toBe(0xfedcba9876543210n);
  });

  it('offsets are relative to the view, not to the underlying buffer', () => {
    const backing = new Uint8Array(32);
    const view = backing.subarray(10, 26);
    writeU16be(view, 0x0102, 1); writeU32be(view, 0x03040506, 3); writeU64be(view, 0x0708090a0b0c0d0en, 7);
    expect([...backing.subarray(11, 25)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(backing[10]).toBe(0); expect(backing[25]).toBe(0);
    expect(readU16be(view, 1)).toBe(0x0102);
    expect(readU32be(view, 3)).toBe(0x03040506);
    expect(readU64be(view, 7)).toBe(0x0708090a0b0c0d0en);
  });

  it('out-of-range values and out-of-bounds offsets throw instead of wrapping', () => {
    expect(() => u16be(0x10000)).toThrow(RangeError);
    expect(() => u16be(-1)).toThrow(RangeError);
    expect(() => u32be(0x100000000)).toThrow(RangeError);
    expect(() => u64be(-1n)).toThrow(RangeError);
    expect(() => u64be(1n << 64n)).toThrow(RangeError);
    expect(() => readU32be(new Uint8Array(3))).toThrow(RangeError);
    expect(() => writeU64be(new Uint8Array(8), 1n, 1)).toThrow(RangeError);
  });

  it('concatBytes and compareBytes match Buffer.concat and Buffer.compare', () => {
    const parts = [Uint8Array.of(1, 2), new Uint8Array(), Uint8Array.of(255)];
    expect(concatBytes(parts)).toEqual(new Uint8Array(Buffer.concat(parts)));
    expect(concatBytes([])).toEqual(new Uint8Array());
    const samples = [[], [0], [1], [1, 0], [1, 255], [2], [255], [255, 0]].map(values => Uint8Array.from(values));
    for (const a of samples) for (const b of samples) expect(compareBytes(a, b)).toBe(Buffer.compare(a, b));
  });
});
