import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { image as nativeImage } from '../../../platform/native/image/index.ts';
import type { ImageEncodeOptions, NativeImage, RgbaImage } from '../../../platform/native/image/api.ts';
import media from '../index.ts';
import { unusedStorage } from './helpers/storage-double.ts';
import { encodePngRgba } from './helpers/png.ts';

type Result = {
  bytesBase64: string | null; filePath: string | null; width: number; height: number;
  originalWidth: number; originalHeight: number; originalSize: number; compressedSize: number;
  format: string;
};

let root: string;
let host: TestHost;
let encodes: ImageEncodeOptions[];

function png(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) rgba.set([i % 251, 80, 160, i % 2 === 0 ? 255 : 0], i * 4);
  return encodePngRgba(width, height, rgba);
}

async function rejection(args: Record<string, unknown>): Promise<unknown> {
  return host.invoke('compress_image', args).then(() => null, (error: unknown) => error);
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-compress-'));
  encodes = [];
  const image: NativeImage = {
    ...nativeImage,
    encode: (input: RgbaImage, options: ImageEncodeOptions) => {
      encodes.push(options);
      return nativeImage.encode(input, options);
    },
  };
  host = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(),
      settings: { get: () => null, save: () => undefined },
      paths: { appDataDir: root },
      nativeImage: image,
    },
  });
});

afterEach(async () => {
  await host.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

it('compress_image resizes the long edge with a bounding box and returns base64 JPEG (media.rs:69-147)', async () => {
  const source = png(40, 20);
  const result = await host.invoke('compress_image', {
    bytesBase64: Buffer.from(source).toString('base64'), maxEdge: 10,
  }) as Result;
  expect(result).toMatchObject({
    filePath: null, width: 10, height: 5, originalWidth: 40, originalHeight: 20,
    originalSize: source.length, format: 'jpeg',
  });
  const jpeg = Buffer.from(result.bytesBase64!, 'base64');
  expect(result.compressedSize).toBe(jpeg.length);
  expect([...jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8]);
  expect(await nativeImage.dimensions(jpeg)).toEqual({ width: 10, height: 5 });
  expect(encodes).toEqual([{ format: 'jpeg', quality: 80 }]);
});

it('compress_image never enlarges and clamps quality to 10..=95', async () => {
  const bytesBase64 = Buffer.from(png(12, 30)).toString('base64');
  const small = await host.invoke('compress_image', { bytesBase64, maxEdge: 30, quality: 1 }) as Result;
  expect(small).toMatchObject({ width: 12, height: 30, originalWidth: 12, originalHeight: 30 });
  await host.invoke('compress_image', { bytesBase64, quality: 100 });
  // max_edge 0 → .max(1): bounding box 1x1 keeps at least one pixel per side
  const tiny = await host.invoke('compress_image', { bytesBase64, maxEdge: 0 }) as Result;
  expect(tiny).toMatchObject({ width: 1, height: 1 });
  expect(encodes.map(options => options.quality)).toEqual([10, 95, 80]);
});

it('compress_image prefers sourcePath and writes a temp JPEG in file mode', async () => {
  const sourcePath = path.join(root, 'photo.png');
  fs.writeFileSync(sourcePath, png(8, 4));
  const result = await host.invoke('compress_image', {
    sourcePath, bytesBase64: 'not base64!', outputMode: 'file',
  }) as Result;
  expect(result.bytesBase64).toBeNull();
  expect(path.dirname(result.filePath!)).toBe(os.tmpdir());
  expect(path.basename(result.filePath!)).toMatch(/^dstu_compressed_[0-9a-f]{32}\.jpg$/);
  try {
    expect(fs.statSync(result.filePath!).size).toBe(result.compressedSize);
    expect(result).toMatchObject({ width: 8, height: 4, originalSize: fs.statSync(sourcePath).size });
  } finally { fs.rmSync(result.filePath!, { force: true }); }
});

it('compress_image returns the Rust error strings', async () => {
  expect(await rejection({})).toBe('必须提供 sourcePath 或 bytesBase64 之一');
  expect(await rejection({ bytesBase64: 'invalid_base64!' }))
    .toBe('base64 解码失败: Invalid byte 95, offset 7.');
  const missing = path.join(root, 'absent.png');
  expect(String(await rejection({ sourcePath: missing })))
    .toMatch(new RegExp(`^读取源图片失败 \\(${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\): `));
  expect(String(await rejection({ bytesBase64: Buffer.from('not an image').toString('base64') })))
    .toMatch(/^图片解码失败: /);
});

it('compress_image keeps its string error contract and argument checks without the native image service', async () => {
  const bare = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(), settings: { get: () => null, save: () => undefined }, paths: { appDataDir: root } },
  });
  try {
    const reject = (args: Record<string, unknown>) => bare.invoke('compress_image', args).then(() => null, (e: unknown) => e);
    // media.rs:76-89 checks the source before any pixel work.
    expect(await reject({})).toBe('必须提供 sourcePath 或 bytesBase64 之一');
    expect(await reject({ bytesBase64: '@@' })).toMatch(/^base64 解码失败: /);
    expect(await reject({ bytesBase64: Buffer.from(png(2, 2)).toString('base64') }))
      .toBe('媒体图片服务未提供：需要 F7 nativeImage');
  } finally {
    await bare.dispose();
  }
});
