#!/usr/bin/env node
/**
 * 由 `public/app-icon.png`（1024×1024 RGBA）生成打包图标，写入 `electron/resources/icons/`。
 *
 * Tauri 的 `src-tauri/icons/` 从未入库：`npm run icons`（`tauri icon public/app-icon.png`）与 `scripts/build_*.sh`
 * 在构建时由同一张源图生成。这里按 tauri-cli 的输出规格重做一遍（Lanczos3 缩放），产物入库，打包时不再转换：
 * electron-builder 自带的转换要联网下载工具集。
 *
 * - `icon.icns`（macOS）：iconset 十档 PNG 条目，1024 条目即源图原字节；
 * - `icon.ico`（Windows exe 资源与 NSIS）：32/16/24/48/64 为 32 位 BMP，256 为 PNG（与 tauri-cli 相同的顺序）；
 * - `png/NxN.png`（Linux hicolor）：Tauri `bundle.icon` 安装的 32、128、256（128@2x）、512 四档。
 *
 * 源图更新后重跑 `node electron/scripts/generate-icons.mjs` 并提交产物（electron/tests/app-icons.test.ts 校验）。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

export const ICON_SOURCE = 'public/app-icon.png';
export const ICON_DIR = 'electron/resources/icons';
/**
 * OSType → 边长，即 iconset 的十档；ic11–ic14 是 16/32/128/256 的 @2x，ic10 兼作 512@2x。
 * 不写 icp6：iconutil 把它当 48 像素槽位，64 像素由 ic12 提供。
 */
export const ICNS_ENTRIES = [
  ['icp4', 16], ['icp5', 32], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
  ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
];
export const ICO_SIZES = [32, 16, 24, 48, 64, 256];
export const LINUX_SIZES = [32, 128, 256, 512];

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function resized(source, size) {
  return sharp(source).resize(size, size, { kernel: 'lanczos3' });
}

async function png(source, size) {
  return size === 1024 ? source : resized(source, size).png({ compressionLevel: 9 }).toBuffer();
}

/** ICO 内的 32 位 DIB：高度写两倍（XOR 位图 + AND 掩码），自下而上 BGRA，掩码在 alpha 为 0 处置 1。 */
async function bmp(source, size) {
  const rgba = await resized(source, size).ensureAlpha().raw().toBuffer();
  const maskStride = Math.ceil(size / 32) * 4;
  const out = Buffer.alloc(40 + size * size * 4 + maskStride * size);
  out.writeUInt32LE(40, 0);
  out.writeInt32LE(size, 4);
  out.writeInt32LE(size * 2, 8);
  out.writeUInt16LE(1, 12);
  out.writeUInt16LE(32, 14);
  out.writeUInt32LE(size * size * 4 + maskStride * size, 20);
  const maskAt = 40 + size * size * 4;
  for (let y = 0; y < size; y++) {
    const row = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4;
      const to = 40 + (row * size + x) * 4;
      out[to] = rgba[from + 2];
      out[to + 1] = rgba[from + 1];
      out[to + 2] = rgba[from];
      out[to + 3] = rgba[from + 3];
      if (rgba[from + 3] === 0) out[maskAt + row * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}

export async function icns(source) {
  const entries = [];
  for (const [type, size] of ICNS_ENTRIES) {
    const data = await png(source, size);
    const header = Buffer.alloc(8);
    header.write(type, 0, 'latin1');
    header.writeUInt32BE(8 + data.length, 4);
    entries.push(header, data);
  }
  const body = Buffer.concat(entries);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'latin1');
  header.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([header, body]);
}

export async function ico(source) {
  const images = [];
  for (const size of ICO_SIZES) images.push(size === 256 ? await png(source, size) : await bmp(source, size));
  const directory = Buffer.alloc(6 + 16 * images.length);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(images.length, 4);
  let offset = directory.length;
  images.forEach((image, index) => {
    const size = ICO_SIZES[index];
    const at = 6 + 16 * index;
    directory[at] = size === 256 ? 0 : size;
    directory[at + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(image.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += image.length;
  });
  return Buffer.concat([directory, ...images]);
}

async function main() {
  const source = readFileSync(join(root, ICON_SOURCE));
  const meta = await sharp(source).metadata();
  if (meta.format !== 'png' || meta.width !== 1024 || meta.height !== 1024) {
    throw new Error(`${ICON_SOURCE} must be a 1024x1024 PNG, got ${meta.format} ${meta.width}x${meta.height}`);
  }
  const dir = join(root, ICON_DIR);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'png'), { recursive: true });
  writeFileSync(join(dir, 'icon.icns'), await icns(source));
  writeFileSync(join(dir, 'icon.ico'), await ico(source));
  for (const size of LINUX_SIZES) writeFileSync(join(dir, 'png', `${size}x${size}.png`), await png(source, size));
  console.log(`[generate-icons] ${ICON_SOURCE} → ${ICON_DIR}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
