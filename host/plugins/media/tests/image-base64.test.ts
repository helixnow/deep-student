import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import media from '../index.ts';
import { unusedStorage } from './helpers/storage-double.ts';
import {
  getImageAsBase64, inferImageMime, urlDecodeLossy, ImageBase64Error,
} from '../src/image-base64.ts';

let root: string;
let host: TestHost;

function settings(values = new Map<string, string>()) {
  return {
    get: (key: string) => values.get(key) ?? null,
    save: (key: string, value: string) => { values.set(key, value); },
  };
}

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'media-image-base64-')));
  fs.mkdirSync(path.join(root, 'images'));
  fs.mkdirSync(path.join(root, 'notes_assets'));
  fs.writeFileSync(path.join(root, 'images', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(root, 'notes_assets', 'b.JPG'), Buffer.from([0xff, 0xd8, 0xff]));
  fs.writeFileSync(path.join(root, 'notes_assets', 'c.heic'), Buffer.from([1, 2, 3]));
  host = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(), settings: settings(), paths: { appDataDir: root } },
  });
});
afterEach(async () => {
  await host?.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

it('get_image_as_base64 returns a data URL for app-relative and URL paths', async () => {
  expect(await host.invoke('get_image_as_base64', { relativePath: 'images/a.png' }))
    .toBe('data:image/png;base64,iVBORw==');
  expect(await host.invoke('get_image_as_base64', { relativePath: 'notes_assets/b.JPG' }))
    .toBe(`data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff]).toString('base64')}`);
  expect(await host.invoke('get_image_as_base64', { relativePath: 'notes_assets/c.heic' }))
    .toContain('data:image/heic;base64,');
});

it('get_image_as_base64 with an empty relative path settles as a business rejection', async () => {
  let caught: unknown;
  try { await host.invoke('get_image_as_base64', { relativePath: '' }); }
  catch (error) { caught = error; }
  expect(caught).not.toHaveProperty('name', 'HandlerPanic');
  expect(caught).toMatchObject({ error_type: 'FileSystem' });
  expect((caught as { message?: unknown }).message).toMatch(/^读取图片文件失败:/);
});

it('get_image_as_base64 decodes file, tauri and asset URLs', async () => {
  const spaceDir = path.join(root, 'images', 'with space');
  fs.mkdirSync(spaceDir);
  fs.writeFileSync(path.join(spaceDir, 'x.png'), Buffer.from([9, 8, 7]));
  const fullPath = path.join(spaceDir, 'x.png');
  const encoded = fullPath.replace(/ /g, '%20');
  expect(await getImageAsBase64(root, `file://${encoded}`))
    .toBe(`data:image/png;base64,${Buffer.from([9, 8, 7]).toString('base64')}`);
  expect(await getImageAsBase64(root, `tauri://localhost${encoded}`))
    .toBe(`data:image/png;base64,${Buffer.from([9, 8, 7]).toString('base64')}`);
  expect(await getImageAsBase64(root, `asset://localhost${encoded}`))
    .toBe(`data:image/png;base64,${Buffer.from([9, 8, 7]).toString('base64')}`);
  expect(await getImageAsBase64(root, fullPath))
    .toBe(`data:image/png;base64,${Buffer.from([9, 8, 7]).toString('base64')}`);
});

it('get_image_as_base64 rejects paths outside the app data directory', async () => {
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
  fs.writeFileSync(outside, 'secret');
  try {
    await expect(getImageAsBase64(root, '../' + path.basename(outside)))
      .rejects.toThrowError('拒绝访问：超出应用数据目录');
    await expect(getImageAsBase64(root, outside))
      .rejects.toThrowError('拒绝访问：超出应用数据目录');
  } finally {
    fs.unlinkSync(outside);
  }
  let caught: unknown;
  try { await getImageAsBase64(root, '../escape.png'); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ImageBase64Error);
  expect((caught as ImageBase64Error).appError.error_type).toBe('Validation');
});

it('get_image_as_base64 reports missing files as NotFound', async () => {
  await expect(host.invoke('get_image_as_base64', { relativePath: 'images/none.png' }))
    .rejects.toThrow('图片文件不存在:');
  let caught: unknown;
  try { await getImageAsBase64(root, 'images/none.png'); } catch (error) { caught = error; }
  expect((caught as ImageBase64Error).appError.error_type).toBe('NotFound');
});

it('urlDecodeLossy follows urlencoding and falls back to the raw string', () => {
  expect(urlDecodeLossy('%E4%B8%AD%E6%96%87.png')).toBe('中文.png');
  expect(urlDecodeLossy('100%25.png')).toBe('100%.png');
  expect(urlDecodeLossy('%FF%FE.png')).toBe('%FF%FE.png');
  expect(urlDecodeLossy('a+b.png')).toBe('a+b.png');
});

it('inferImageMime is case-insensitive and defaults to jpeg', () => {
  expect(inferImageMime('/a/B.PNG')).toBe('image/png');
  expect(inferImageMime('/a/b.gif')).toBe('image/gif');
  expect(inferImageMime('/a/b.webp')).toBe('image/webp');
  expect(inferImageMime('/a/b.bmp')).toBe('image/bmp');
  expect(inferImageMime('/a/b.heif')).toBe('image/heif');
  expect(inferImageMime('/a/b.svg')).toBe('image/jpeg');
});
