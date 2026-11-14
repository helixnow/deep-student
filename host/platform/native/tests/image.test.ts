import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import native from '../index.ts';
import { image } from '../image/index.ts';

/** Minimal 8-bit RGBA PNG, one filter-0 scanline per row. */
function png(width: number, height: number, rgba: number[]): Uint8Array {
  const chunk = (type: string, data: Buffer): Buffer => {
    const typeBytes = Buffer.from(type, 'ascii');
    const output = Buffer.alloc(12 + data.length);
    output.writeUInt32BE(data.length, 0);
    typeBytes.copy(output, 4);
    data.copy(output, 8);
    output.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])) >>> 0, 8 + data.length);
    return output;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset++] = 0; // filter: None
    for (let x = 0; x < width * 4; x += 1) raw[offset++] = rgba[y * width * 4 + x]!;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Uncompressed 24-bit BMP, bottom-up rows padded to 4 bytes. */
function bmp(width: number, height: number, bgr: number[]): Uint8Array {
  const stride = Math.ceil(width * 3 / 4) * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    // BMP stores the bottom row first; `bgr` is in that file order too.
    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * 3;
      const target = y * stride + x * 3;
      pixels[target] = bgr[source]!;
      pixels[target + 1] = bgr[source + 1]!;
      pixels[target + 2] = bgr[source + 2]!;
    }
  }
  const header = Buffer.alloc(54);
  header.write('BM', 0);
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(pixels.length, 34);
  header.writeInt32LE(2835, 38);
  header.writeInt32LE(2835, 42);
  return Buffer.concat([header, pixels]);
}

describe('image decoder (image = 0.24)', () => {
  it('image::load_from_memory dimensions/decodeRgba: decodes PNG pixels', async () => {
    const bytes = png(2, 1, [255, 0, 0, 255, 0, 0, 255, 128]);
    expect(await image.dimensions(bytes)).toEqual({ width: 2, height: 1 });
    expect(await image.decodeRgba(bytes)).toEqual({
      width: 2,
      height: 1,
      rgba: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 128]),
    });
  });

  it('image::load_from_memory dimensions/decodeRgba: decodes BMP that sharp rejects', async () => {
    // Top row: green, white; bottom row: red, blue.
    const bytes = bmp(2, 2, [
      0, 0, 255, 255, 255, 255, // bottom: red, white
      0, 255, 0, 255, 0, 0, // top: green, blue
    ]);
    expect(await image.dimensions(bytes)).toEqual({ width: 2, height: 2 });
    expect(Array.from((await image.decodeRgba(bytes)).rgba)).toEqual([
      0, 255, 0, 255, 0, 0, 255, 255,
      255, 0, 0, 255, 255, 255, 255, 255,
    ]);
  });

  it('image::load_from_memory: reports the crate Display text for unknown bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await expect(image.dimensions(bytes)).rejects.toThrow(/format could not be determined/i);
  });

  it('is provided by the dstu.native plugin', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      expect(host.ctx.nativeImage).toBe(image);
      const decoded = await host.ctx.nativeImage.decodeRgba(png(1, 1, [1, 2, 3, 4]));
      expect(decoded).toMatchObject({ width: 1, height: 1 });
    } finally {
      await host.dispose();
    }
  });
});
