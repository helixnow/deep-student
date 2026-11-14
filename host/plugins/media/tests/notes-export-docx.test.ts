/**
 * `docx_handout.rs` tests 3-5 and `handout.rs::notes_export_docx`, all through the
 * production `notes_export_docx` command with the real F7 `nativeOfficeWriter`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { image as nativeImage } from '../../../platform/native/image/index.ts';
import { createOfficeWriter } from '../../../platform/native/office/writer.ts';
import media from '../index.ts';
import { unusedStorage } from './helpers/storage-double.ts';
import { EMU_PER_TWIP, HANDOUT_CONTENT_W } from '../src/docx-handout.ts';
import { readZipEntries } from '../src/zip.ts';
import { encodePngRgba } from './helpers/png.ts';

let root: string;
let host: TestHost;

function settings() {
  const values = new Map<string, string>();
  return {
    get: (key: string) => values.get(key) ?? null,
    save: (key: string, value: string) => { values.set(key, value); },
  };
}

function rgba(w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      out[i] = x % 255; out[i + 1] = y % 255; out[i + 2] = 128; out[i + 3] = 255;
    }
  }
  return out;
}

/** Rust `tiny_png`: an RGB JPEG (quality 80) as a data URL. */
async function tinyPng(w: number, h: number): Promise<string> {
  const jpeg = await nativeImage.encode({ width: w, height: h, rgba: rgba(w, h) }, { format: 'jpeg', quality: 80 });
  return `data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}`;
}

function unzip(base64: string): [string, string[]] {
  const entries = readZipEntries(Buffer.from(base64, 'base64'));
  expect(entries).not.toBeNull();
  const names = entries!.map(entry => entry.name);
  const document = entries!.find(entry => entry.name === 'word/document.xml');
  expect(document).toBeDefined();
  return [document!.bytes.toString('utf8'), names];
}

const hasPngMedia = (names: string[]) =>
  names.some(name => name.startsWith('word/media/') && name.endsWith('.png'));

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'media-notes-docx-')));
  fs.mkdirSync(path.join(root, 'notes_assets'));
  host = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(),
      settings: settings(),
      paths: { appDataDir: root },
      nativeOfficeWriter: createOfficeWriter(() => {}),
    },
  });
});
afterEach(async () => {
  await host?.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

it('default_spec_renders_image_block', async () => {
  const spec = {
    title: 'T',
    blocks: [
      { type: 'paragraph', text: 'hello' },
      { type: 'image', data: await tinyPng(32, 16), caption: 'Figure 1' },
    ],
  };
  const [xml, names] = unzip(await host.invoke('notes_export_docx', { spec }) as string);
  expect(hasPngMedia(names)).toBe(true);
  expect(xml.includes('<w:drawing>') || xml.includes('<w:drawing')).toBe(true);
  expect(xml).toContain('Figure 1');
  // 默认版式不受讲义样式影响
  expect(xml).not.toContain('仿宋');
  expect(xml).not.toContain('w:lineRule="exact"');
});

it('broken_image_degrades_to_placeholder', async () => {
  const spec = { blocks: [{ type: 'image', data: 'bm90LWFuLWltYWdl', alt: 'slide' }] };
  const [xml, names] = unzip(await host.invoke('notes_export_docx', { spec }) as string);
  expect(xml).toContain('[slide]');
  expect(hasPngMedia(names)).toBe(false);
});

it('handout_template_applies_official_layout', async () => {
  const spec = {
    title: '讲义',
    template: 'handout',
    subtitle: '课程：测试',
    blocks: [
      { type: 'heading', level: 1, text: '一、概述' },
      { type: 'paragraph', text: '正文' },
      { type: 'paragraph', role: 'note', text: '注意' },
      { type: 'table', header: true, caption: '表 1', rows: [['A', 'B'], ['1', '2']] },
      { type: 'image', data: await tinyPng(2400, 1200), caption: '图 1 课件' },
    ],
  };
  const [xml, names] = unzip(await host.invoke('notes_export_docx', { spec }) as string);
  expect(names.some(name => name.startsWith('word/media/'))).toBe(true);
  expect(xml).toContain('w:lineRule="exact"');
  expect(xml).toContain('w:line="560"');
  expect(xml).toContain('w:eastAsia="仿宋"');
  expect(xml).toContain('w:eastAsia="黑体"');
  expect(xml).toContain('w:firstLine="640"');
  expect(xml).toContain('w:left="1587"');
  expect(xml).toContain('w:top="2098"');
  expect(xml).toContain('图 1 课件');
  // 大图被约束在版心宽内
  const maxEmu = String(HANDOUT_CONTENT_W * EMU_PER_TWIP);
  expect(xml).toContain(`cx="${maxEmu}"`);
}, 60_000);

// handout.rs:151-182 — command-level contract (Rust has no test for this branch).
it('notes_export_docx resolves notes_assets src, skips remote and keeps explicit data', async () => {
  const png = encodePngRgba(4, 2, rgba(4, 2));
  fs.writeFileSync(path.join(root, 'notes_assets', 'pic.png'), png);
  const spec = {
    blocks: [
      { type: 'image', src: 'notes_assets/pic.png', caption: 'local' },
      { type: 'image', src: 'https://example.com/a.png', alt: 'remote' },
      { type: 'image', src: 'notes_assets/missing.png', alt: 'gone' },
      { type: 'image', data: 'bm90LWFuLWltYWdl', src: 'notes_assets/pic.png', alt: 'explicit' },
      { type: 'paragraph', src: 'notes_assets/pic.png', text: 'not an image' },
    ],
  };
  const before = JSON.stringify(spec);
  const [xml, names] = unzip(await host.invoke('notes_export_docx', { spec }) as string);
  // Exactly one image resolved from notes_assets; the rest degrade to placeholders.
  expect(names.filter(name => name.startsWith('word/media/')).length).toBe(1);
  expect(xml).toContain('local');
  expect(xml).toContain('[remote]');
  expect(xml).toContain('[gone]');
  expect(xml).toContain('[explicit]');
  expect(xml).toContain('not an image');
  // Caller input is not mutated.
  expect(JSON.stringify(spec)).toBe(before);
});

it('notes_export_docx without a blocks array still generates a document', async () => {
  const [xml] = unzip(await host.invoke('notes_export_docx', { spec: { title: 'only title' } }) as string);
  expect(xml).toContain('only title');
});
