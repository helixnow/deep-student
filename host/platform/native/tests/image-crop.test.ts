import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import native from '../index.ts';
import type { RgbaImage } from '../image/api.ts';

const source = (): RgbaImage => ({ width: 4, height: 3, rgba: Uint8Array.from({ length: 48 }, (_, index) => index) });

describe('exam_sheet_service.rs crop_imm(to_rgba8, integer pixels)', () => {
  it('copies the exact requested RGBA pixels, including alpha, without coordinate rescaling', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      const input = source();
      const cropped = host.ctx.nativeImage.cropRgba(input, { x: 1, y: 1, width: 2, height: 2 });
      expect(cropped).toEqual({ width: 2, height: 2, rgba: new Uint8Array([
        20, 21, 22, 23, 24, 25, 26, 27,
        36, 37, 38, 39, 40, 41, 42, 43,
      ]) });
      cropped.rgba[0] = 255;
      expect(input).toEqual(source());
    } finally { await host.dispose(); }
  });

  it('retains zero dimensions for the caller’s distinct create/adjust validation errors', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      const api = host.ctx.nativeImage;
      expect(api.cropRgba(source(), { x: 1, y: 1, width: 0, height: 2 }))
        .toEqual({ width: 0, height: 2, rgba: new Uint8Array() });
      expect(api.cropRgba(source(), { x: 1, y: 1, width: 2, height: 0 }))
        .toEqual({ width: 2, height: 0, rgba: new Uint8Array() });
      expect(api.cropRgba(source(), { x: 4, y: 2, width: 100, height: 100 }))
        .toEqual({ width: 0, height: 1, rgba: new Uint8Array() });
      expect(api.cropRgba(source(), { x: 5, y: 4, width: 100, height: 100 }))
        .toEqual({ width: 0, height: 0, rgba: new Uint8Array() });
    } finally { await host.dispose(); }
  });

  it('clips u32-max extents before allocation instead of wrapping, padding or enlarging the source', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      expect(host.ctx.nativeImage.cropRgba(source(), { x: 3, y: 2, width: 0xffffffff, height: 0xffffffff }))
        .toEqual({ width: 1, height: 1, rgba: new Uint8Array([44, 45, 46, 47]) });
      expect(host.ctx.nativeImage.cropRgba(source(), { x: 0xffffffff, y: 0xffffffff, width: 0xffffffff, height: 0xffffffff }))
        .toEqual({ width: 0, height: 0, rgba: new Uint8Array() });
    } finally { await host.dispose(); }
  });

  it('does not reinterpret negative/reversed extents, fractional pixels or non-u32 input as a normalized bbox', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      for (const bbox of [
        { x: -1, y: 0, width: 1, height: 1 }, { x: 3, y: 0, width: -2, height: 1 },
        { x: 0.5, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 0x100000000, height: 1 },
        { x: 0, y: Number.NaN, width: 1, height: 1 }, { x: 0, y: 0, width: 1, height: Infinity },
      ]) expect(() => host.ctx.nativeImage.cropRgba(source(), bbox)).toThrow(RangeError);
    } finally { await host.dispose(); }
  });

  it('composes crop plus PNG encode/decode without changing dimensions or pixels (dependency validation, not D5 approval)', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      const api = host.ctx.nativeImage;
      const cropped = api.cropRgba(source(), { x: 1, y: 1, width: 2, height: 2 });
      expect(await api.decodeRgba(await api.encode(cropped, { format: 'png' }))).toEqual(cropped);
    } finally { await host.dispose(); }
  });
});
