/**
 * 打包图标（electron/scripts/generate-icons.mjs 的入库产物）：格式合法、由 `public/app-icon.png` 缩放而来，
 * 且 electron-builder 原样采用、不走需要联网下载工具集的转换。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { ICNS_ENTRIES, ICO_SIZES, ICON_DIR, ICON_SOURCE, LINUX_SIZES } from '../scripts/generate-icons.mjs';
import { defaultWindowIcon } from '../shell/window-options.ts';
import { builderFilter } from './builder-filter.ts';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..', '..');
const config = require('../electron-builder.config.cjs') as {
  directories: { buildResources: string };
  files: string[];
  mac: { icon: string };
  win: { icon: string };
  linux: { icon: string };
};
const { convertIcon } = require('app-builder-lib/out/util/iconConverter.js') as {
  convertIcon(options: { sources: string[]; fallbackSources: string[]; roots: string[]; format: 'icns' | 'ico' | 'set'; outDir: string }): Promise<{ icons: Array<{ file: string; size: number }>; isFallback: boolean }>;
};
const { Data } = require('resedit') as { Data: { IconFile: { from(bin: Uint8Array): { icons: Array<{ width: number; height: number; data: unknown }> } } } };

const source = readFileSync(join(root, ICON_SOURCE));
const iconDir = join(root, ICON_DIR);
const tmp = mkdtempSync(join(tmpdir(), 'dstu-icons-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 源图按同一 Lanczos3 缩放后的 RGBA；与产物逐通道的平均绝对差（0–255）。 */
async function distanceFromSource(rgba: Buffer, size: number): Promise<number> {
  const expected = await sharp(source).resize(size, size, { kernel: 'lanczos3' }).ensureAlpha().raw().toBuffer();
  expect(rgba.length).toBe(expected.length);
  let total = 0;
  for (let i = 0; i < rgba.length; i++) total += Math.abs(rgba[i]! - expected[i]!);
  return total / rgba.length;
}

async function decodePng(data: Buffer): Promise<{ width: number; height: number; rgba: Buffer }> {
  expect(data.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
  const { data: rgba, info } = await sharp(data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, rgba };
}

/** ICO 内 32 位 DIB（BITMAPINFOHEADER，高度含 AND 掩码，自下而上 BGRA）→ 自上而下 RGBA。 */
function decodeIcoBmp(data: Buffer): { width: number; height: number; rgba: Buffer } {
  expect(data.readUInt32LE(0)).toBe(40);
  const width = data.readInt32LE(4);
  const height = data.readInt32LE(8) / 2;
  expect(data.readUInt16LE(14)).toBe(32);
  expect(data.readUInt32LE(16)).toBe(0);
  const maskStride = Math.ceil(width / 32) * 4;
  expect(data.length).toBe(40 + width * height * 4 + maskStride * height);
  const rgba = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row++) {
    const y = height - 1 - row;
    for (let x = 0; x < width; x++) {
      const from = 40 + (row * width + x) * 4;
      const to = (y * width + x) * 4;
      rgba[to] = data[from + 2]!;
      rgba[to + 1] = data[from + 1]!;
      rgba[to + 2] = data[from]!;
      rgba[to + 3] = data[from + 3]!;
      const masked = (data[40 + width * height * 4 + row * maskStride + (x >> 3)]! & (0x80 >> (x & 7))) !== 0;
      expect(masked, `mask bit at ${x},${y}`).toBe(data[from + 3] === 0);
    }
  }
  return { width, height, rgba };
}

describe('generated app icons', () => {
  it('the source is the 1024x1024 RGBA PNG consumed by electron/scripts/generate-icons.mjs', async () => {
    expect(ICON_SOURCE).toBe('public/app-icon.png');
    const meta = await sharp(source).metadata();
    expect([meta.format, meta.width, meta.height, meta.channels]).toEqual(['png', 1024, 1024, 4]);
  });

  it('icon.icns carries the ten iconset PNG slots, each a Lanczos3 downscale of the source and the 1024 slot the source bytes', async () => {
    const icns = readFileSync(join(iconDir, 'icon.icns'));
    expect(icns.toString('latin1', 0, 4)).toBe('icns');
    expect(icns.readUInt32BE(4)).toBe(icns.length);
    const entries: Array<[string, Buffer]> = [];
    for (let at = 8; at < icns.length;) {
      const length = icns.readUInt32BE(at + 4);
      entries.push([icns.toString('latin1', at, at + 4), icns.subarray(at + 8, at + length)]);
      at += length;
    }
    expect(entries.map(([type]) => type)).toEqual(ICNS_ENTRIES.map(([type]) => type));
    for (const [index, [type, data]] of entries.entries()) {
      const size = ICNS_ENTRIES[index]![1];
      if (size === 1024) {
        expect(data.equals(source), type).toBe(true);
        continue;
      }
      const image = await decodePng(data);
      expect([image.width, image.height], type).toEqual([size, size]);
      expect(await distanceFromSource(image.rgba, size), type).toBeLessThan(1);
    }
  });

  it('icon.ico lists 32/16/24/48/64 as 32-bit BMP and 256 as PNG, in tauri-cli order, all downscaled from the source', async () => {
    const ico = readFileSync(join(iconDir, 'icon.ico'));
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([0, 1, ICO_SIZES.length]);
    for (const [index, size] of ICO_SIZES.entries()) {
      const at = 6 + 16 * index;
      expect([ico[at] || 256, ico[at + 1] || 256, ico.readUInt16LE(at + 4), ico.readUInt16LE(at + 6)]).toEqual([size, size, 1, 32]);
      const data = ico.subarray(ico.readUInt32LE(at + 12), ico.readUInt32LE(at + 12) + ico.readUInt32LE(at + 8));
      const image = size === 256 ? await decodePng(data) : decodeIcoBmp(data);
      expect([image.width, image.height], `${size}`).toEqual([size, size]);
      expect(await distanceFromSource(image.rgba, size), `${size}`).toBeLessThan(1);
    }
    // electron-builder 写 exe 图标时用 resedit 解析同一文件。
    expect(Data.IconFile.from(ico).icons.map((icon) => icon.width || 256)).toEqual(ICO_SIZES);
  });

  it('the Linux set holds the hicolor sizes Tauri installed (32, 128, 128@2x, 512), downscaled from the source', async () => {
    for (const size of LINUX_SIZES) {
      const image = await decodePng(readFileSync(join(iconDir, 'png', `${size}x${size}.png`)));
      expect([image.width, image.height]).toEqual([size, size]);
      expect(await distanceFromSource(image.rgba, size), `${size}`).toBeLessThan(1);
    }
  });

  it('the downscale check rejects an image that is not the app icon', async () => {
    const other = await sharp({ create: { width: 128, height: 128, channels: 4, background: { r: 71, g: 120, b: 196, alpha: 1 } } }).raw().toBuffer();
    expect(await distanceFromSource(other, 128)).toBeGreaterThan(50);
  });
});

describe('electron-builder icon wiring', () => {
  const roots = [join(root, config.directories.buildResources), root];

  it('mac / win / linux point at the generated icons', () => {
    expect(config.mac.icon).toBe(`${ICON_DIR}/icon.icns`);
    expect(config.win.icon).toBe(`${ICON_DIR}/icon.ico`);
    expect(config.linux.icon).toBe(`${ICON_DIR}/png`);
  });

  it('only the Linux window icon ships inside app.asar; the bundle icons go to the .app, the exe resources and hicolor', () => {
    const ships = builderFilter(config.files);
    expect(ships(`${ICON_DIR}/png/32x32.png`)).toBe(true);
    for (const file of ['icon.icns', 'icon.ico', 'png/128x128.png', 'png/256x256.png', 'png/512x512.png']) {
      expect(ships(`${ICON_DIR}/${file}`), file).toBe(false);
    }
  });

  it('electron-builder takes each platform\'s icon as is, without the converter that downloads a toolset', async () => {
    const resolveAs = (icon: string, format: 'icns' | 'ico' | 'set') => convertIcon({ sources: [icon], fallbackSources: [], roots, format, outDir: join(tmp, `.icon-${format}`) });
    expect(await resolveAs(config.mac.icon, 'icns')).toEqual({ icons: [{ file: join(iconDir, 'icon.icns'), size: 0 }], isFallback: false });
    expect(await resolveAs(config.win.icon, 'ico')).toEqual({ icons: [{ file: join(iconDir, 'icon.ico'), size: 256 }], isFallback: false });
    expect(await resolveAs(config.linux.icon, 'set')).toEqual({
      icons: LINUX_SIZES.map((size) => ({ file: join(iconDir, 'png', `${size}x${size}.png`), size })),
      isFallback: false,
    });
  });
});

describe('default window icon', () => {
  it('Linux windows get the 32x32 PNG from LINUX_SIZES; Windows and macOS set none', async () => {
    expect(LINUX_SIZES[0]).toBe(32);
    const icon = defaultWindowIcon('linux', iconDir);
    expect(icon).toBe(`${iconDir}/png/32x32.png`);
    const image = await decodePng(readFileSync(icon!));
    expect([image.width, image.height]).toEqual([32, 32]);
    expect(defaultWindowIcon('darwin', iconDir)).toBeUndefined();
    expect(defaultWindowIcon('win32', iconDir)).toBeUndefined();
  });
});
