import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { image as nativeImage } from '../../native/image/index.ts';
import secrets from '../../secrets/index.ts';
import storage from '../index.ts';
import type { ImageQualityCodec } from '../api.ts';

let base: string;
let host: Awaited<ReturnType<typeof createTestHost>> | undefined;
let errors: Array<{ target: string; message: string }> = [];

beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-image-quality-')); errors = []; });
afterEach(async () => {
  await host?.dispose();
  host = undefined;
  fs.rmSync(base, { recursive: true, force: true });
});

async function start() {
  host = await createTestHost({
    app: { dataDir: base },
    plugins: [secrets, [storage, { dataLocalDir: base }]],
    provide: {
      paths: { os: { home: base, data: base, dataLocal: base, config: base, temp: base } },
      log: { logger: (target: string) => ({ debug() {}, info() {}, warn() {}, error(message: string) { errors.push({ target, message }); } }) },
      storageStartupSync: { resetDefaultAfterLocalPurge() {} },
      // 生产实现本身（不是替身）：避免为一个解码测试加载 F7 的整包插件。
      nativeImage,
    },
    shell: () => null,
  });
  return host;
}

/** Minimal 8-bit RGBA PNG, one filter-0 scanline per row (same bytes as `DynamicImage::new_rgb8` output format). */
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

it('exposes the image quality policy through ctx.imageQuality', async () => {
  const h = await start();
  const calls: { maxDimension: number; quality: number; bytes: Uint8Array }[] = [];
  const output = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
  const codec: ImageQualityCodec = {
    async dimensions() { return { width: 1200, height: 900 }; },
    async resizeAndEncodeJpeg(bytes, options) {
      calls.push({ bytes, ...options });
      return output;
    },
  };
  const input = new Uint8Array(1200 * 900).fill(1);
  await expect(h.ctx.imageQuality.adjustImageQualityBytes(input, 'low', codec)).resolves.toBe(output);
  // Rust passes `&image_data` to the encoder: assert the very same buffer (identity is
  // stricter than toEqual, which also deep-walks all 1.08M bytes element by element and
  // took 16-30s under gate load, tripping the 30s testTimeout).
  expect(calls).toHaveLength(1);
  const { bytes: received, ...options } = calls[0]!;
  expect(received).toBe(input);
  expect(options).toEqual({ maxDimension: 768, quality: 60 });

  await expect(h.ctx.imageQuality.adjustImageQualityBase64('not base64!', 'low', codec))
    .resolves.toBe('not base64!');
  expect(calls).toHaveLength(1);
});

it('bytes_quality_preserves_original_on_noop_or_invalid_image', async () => {
  const h = await start();
  // Rust `png(64, 32)`: real DynamicImage -> PNG bytes, decoded here by the real
  // `image = 0.24` WASM service that `ctx.nativeImage` exposes.
  const image = png(64, 32, new Array<number>(64 * 32 * 4).fill(0));
  expect(await h.ctx.nativeImage.dimensions(image)).toEqual({ width: 64, height: 32 });

  let decodes = 0;
  const codec: ImageQualityCodec = {
    async dimensions(bytes) {
      decodes += 1;
      return h.ctx.nativeImage.dimensions(bytes);
    },
    async resizeAndEncodeJpeg() {
      throw new Error('this no-op test must not encode');
    },
  };

  for (const quality of ['high', 'low', 'medium', 'auto', 'unknown']) {
    await expect(h.ctx.imageQuality.adjustImageQualityBytes(image, quality, codec)).resolves.toBe(image);
  }
  // `high` returns before decode; the other four qualities decode, then no-op.
  expect(decodes).toBe(4);

  // The same codec path reports the crate's Display text for non-image bytes.
  const invalid = new TextEncoder().encode('not an image');
  await expect(h.ctx.nativeImage.dimensions(invalid)).rejects.toThrow(/format could not be determined/i);
  await expect(h.ctx.imageQuality.adjustImageQualityBytes(invalid, 'low', codec)).resolves.toBe(invalid);
  expect(decodes).toBe(5);

  await expect(h.ctx.imageQuality.adjustImageQualityBase64('not base64!', 'low', codec))
    .resolves.toBe('not base64!');
  expect(decodes).toBe(5);
  // file_manager.rs:56-69: STANDARD trailing-bit rejection returns the original
  // string, without calling the image decoder or canonicalizing it to AA==.
  await expect(h.ctx.imageQuality.adjustImageQualityBase64('AB==', 'low', codec)).resolves.toBe('AB==');
  expect(decodes).toBe(5);
  expect(errors).toContainEqual({
    target: 'dstu_storage::file_manager',
    message: '⚠️ [图片压缩] Base64 解码失败: Invalid last symbol 66, offset 1.',
  });
}, 120_000);
