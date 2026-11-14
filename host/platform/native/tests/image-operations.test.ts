import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import native from '../index.ts';
import type { RgbaImage } from '../image/api.ts';

function solid(width: number, height: number, pixel = [255, 0, 0, 0]): RgbaImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba.set(pixel, i);
  return { width, height, rgba };
}

describe('image 0.24.9 operations through nativeImage', () => {
  it('test_resize_same_size preserves pixels and opaque alpha', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      const api = host.ctx.nativeImage;
      const source = solid(100, 80, [23, 45, 67, 255]);
      for (const filter of ['triangle', 'lanczos3'] as const) {
        expect(api.resizeRgba(source, 100, 80, filter)).toEqual(source);
        const resized = api.resizeRgba(source, 22, 22, filter);
        expect([...resized.rgba]).toEqual([...solid(22, 22, [23, 45, 67, 255]).rgba]);
      }
    } finally { await host.dispose(); }
  });

  it('test_issue_186 / bug_1600: Lanczos3 handles the original empty and saturated regression inputs', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      const api = host.ctx.nativeImage;
      expect(api.resizeRgba(solid(100, 100, [0, 0, 0, 255]), 50, 50, 'lanczos3').width).toBe(50);
      const result = api.resizeRgba(solid(629, 627, [255, 255, 255, 255]), 22, 22, 'lanczos3');
      expect(result.rgba.some(channel => channel !== 0)).toBe(true);
    } finally { await host.dispose(); }
  });

  it('Triangle and Lanczos3 average independent RGBA channels, including fully transparent colour', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      const source = { width: 2, height: 1, rgba: new Uint8Array([255, 0, 0, 0, 0, 0, 255, 255]) };
      for (const filter of ['triangle', 'lanczos3'] as const) {
        const result = host.ctx.nativeImage.resizeRgba(source, 1, 1, filter);
        expect([...result.rgba]).toEqual([128, 0, 128, 128]);
      }
      expect(host.ctx.nativeImage.resizeDimensions(3, 2, 2, 2)).toEqual({ width: 2, height: 1 });
      expect(host.ctx.nativeImage.resizeDimensions(2, 1, 5, 5)).toEqual({ width: 5, height: 3 });
    } finally { await host.dispose(); }
  });

  it('test_crop_figure_default_bbox_yields_minimal_crop', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      const api = host.ctx.nativeImage;
      const bytes = await api.encode(solid(100, 80), { format: 'png' });
      const output = await api.cropFigure(bytes, [0, 0, 0, 0]);
      expect(await api.decodeRgba(output)).toEqual(solid(1, 1));
    } finally { await host.dispose(); }
  });

  it('test_crop_figure_inverted_and_out_of_range_bbox', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      const api = host.ctx.nativeImage;
      const bytes = await api.encode(solid(100, 80), { format: 'png' });
      expect(await api.decodeRgba(await api.cropFigure(bytes, [0.9, 1.5, 0.1, -0.2])))
        .toEqual(solid(80, 80));
      expect(await api.decodeRgba(await api.cropFigure(bytes, [2, 2, 3, 3])))
        .toEqual(solid(1, 1));
      await expect(api.cropFigure(new Uint8Array([1]), [0, 0, 0, 0])).rejects
        .toMatchObject({ error_type: 'Unknown', message: expect.stringContaining('加载页面图片失败: ') });
    } finally { await host.dispose(); }
  });

  it('roundtrip_sanity_check: JPEG quality100 retains red even when alpha is zero', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      const api = host.ctx.nativeImage;
      const bytes = await api.encode(solid(1, 1), { format: 'jpeg', quality: 100 });
      expect([...bytes.slice(0, 2)]).toEqual([255, 216]);
      const decoded = await api.decodeRgba(bytes);
      expect(decoded.width).toBe(1);
      expect(decoded.height).toBe(1);
      expect(decoded.rgba[0]).toBeGreaterThan(0x80);
      expect(decoded.rgba[1]).toBeLessThan(0x80);
      expect(decoded.rgba[2]).toBeLessThan(0x80);
      expect(decoded.rgba[3]).toBe(255);
    } finally { await host.dispose(); }
  });

  it('approved encoder preserves transparent RGB in PNG and discards rather than composites alpha in JPEG', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      const api = host.ctx.nativeImage;
      const transparent = { width: 2, height: 2, rgba: new Uint8Array([
        255, 0, 0, 0, 0, 255, 0, 1, 0, 0, 255, 128, 71, 103, 181, 255,
      ]) };
      const before = transparent.rgba.slice();
      expect(await api.decodeRgba(await api.encode(transparent, { format: 'png' }))).toEqual(transparent);
      const opaque = { ...transparent, rgba: transparent.rgba.slice() };
      for (let i = 3; i < opaque.rgba.length; i += 4) opaque.rgba[i] = 255;
      expect(await api.encode(transparent, { format: 'jpeg', quality: 90 }))
        .toEqual(await api.encode(opaque, { format: 'jpeg', quality: 90 }));
      expect(transparent.rgba).toEqual(before);
    } finally { await host.dispose(); }
  });

  it('test_image_too_large: rejects the Rust JPEG 65536x1 regression input instead of wrapping the SOF dimensions', async () => {
    const host = await createTestHost({ plugins: [native] });
    try { await expect(host.ctx.nativeImage.encode(solid(65536, 1), { format: 'jpeg', quality: 100 })).rejects
      .toThrow("The Image's dimensions are either too small or too large"); }
    finally { await host.dispose(); }
  });

  it('quality sequence respects the hard byte limit and never silently returns the final oversized attempt', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      const api = host.ctx.nativeImage;
      const input = solid(64, 64);
      for (let i = 0; i < input.rgba.length; i++) input.rgba[i] = (i * 71 + (i >> 4) * 17) % 256;
      const q85 = await api.encode(input, { format: 'jpeg', quality: 85 });
      const q55 = await api.encode(input, { format: 'jpeg', quality: 55 });
      expect(q55.length).toBeLessThan(q85.length);
      const limited = await api.encodeJpegWithinLimit(input, q55.length, [85, 75, 65, 55]);
      expect(limited.length).toBeLessThanOrEqual(q55.length);
      expect(await api.dimensions(limited)).toEqual({ width: 64, height: 64 });
      await expect(api.encodeJpegWithinLimit(input, 1, [85, 75, 65, 55])).rejects
        .toThrow('压缩后仍超过 0KB 上限');
    } finally { await host.dispose(); }
  });

  it('exposes the F3 resize/encode seam with the file_manager.rs 1200x900 dimension vector (policy test remains with F3)', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      const api = host.ctx.nativeImage;
      const source = await api.encode(solid(1200, 900), { format: 'png' });
      const bytes = await api.resizeAndEncodeJpeg(source, { maxDimension: 768, quality: 60 });
      expect([...bytes.slice(0, 2)]).toEqual([255, 216]);
      expect(await api.dimensions(bytes)).toEqual({ width: 768, height: 576 });
    } finally { await host.dispose(); }
  });

  it('exam_engine.rs resizeTriangleJpeg preserves small dimensions and distinguishes decode/encode failures', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      const api = host.ctx.nativeImage;
      const small = await api.encode(solid(40, 20), { format: 'png' });
      expect(await api.dimensions(await api.resizeTriangleJpeg(small, 1600, 1600, 85)))
        .toEqual({ width: 40, height: 20 });
      const wide = await api.encode(solid(2000, 100), { format: 'png' });
      expect(await api.dimensions(await api.resizeTriangleJpeg(wide, 1600, 1600, 85)))
        .toEqual({ width: 1600, height: 80 });
      await expect(api.resizeTriangleJpeg(new Uint8Array([1]), 1600, 1600, 85)).rejects
        .toMatchObject({ stage: 'decode', message: expect.stringContaining('format could not be determined') });
      const huge = await api.encode(solid(65536, 1), { format: 'png' });
      await expect(api.resizeTriangleJpeg(huge, 65536, 1, 85)).rejects
        .toMatchObject({ stage: 'encode', message: "The Image's dimensions are either too small or too large" });
    } finally { await host.dispose(); }
  });

  it('encodes in a worker without blocking Host timer delivery', async () => {
    const host = await createTestHost({ plugins: [native] });
    let delivered = false;
    try {
      const timer = setTimeout(() => { delivered = true; }, 0);
      try {
        const bytes = await host.ctx.nativeImage.encode(solid(512, 512), { format: 'jpeg', quality: 85 });
        expect(delivered).toBe(true);
        expect(await host.ctx.nativeImage.dimensions(bytes)).toEqual({ width: 512, height: 512 });
      } finally { clearTimeout(timer); }
    } finally { await host.dispose(); }
  });
});
