/**
 * `page_rasterizer.rs` has no Rust unit tests; these are production-entry contract
 * tests through the provided `pageRasterizer` service (`host.ctx.pageRasterizer`).
 */
import { expect, it } from 'vitest';
import { CommandError } from '../../../kernel/api.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import { image as nativeImage } from '../../../platform/native/image/index.ts';
import { pdfium } from '../../../platform/native/pdfium/index.ts';
import type { NativeImage } from '../../../platform/native/image/api.ts';
import type { NativePdfium } from '../../../platform/native/pdfium/api.ts';
import type { PageRasterizerService } from '../api.ts';
import media from '../index.ts';
import { unusedStorage } from './helpers/storage-double.ts';
import { detectImageFormat, renderSize } from '../src/page-rasterizer.ts';
import { encodePngRgba } from './helpers/png.ts';

const MINIMAL_PDF = '%PDF-1.0\n1 0 obj<</Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000043 00000 n \n0000000098 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n167\n%%EOF';

interface Stored { bytes: Uint8Array; mime: string | null | undefined; ext: string | null | undefined }

function blobRepo(stored: Stored[]) {
  return {
    blobs: {
      storeBlob(_conn: unknown, blobsDir: string, data: Uint8Array, mime?: string | null, ext?: string | null) {
        expect(blobsDir).toBe('/blobs');
        stored.push({ bytes: data, mime, ext });
        return { hash: `hash${stored.length}0123456789`, relativePath: '', size: data.length, refCount: 1, createdAt: 0 };
      },
    },
  };
}

/** Real dimension probe; JPEG encoding is recorded (production uses F7 `nativeImage.encode`). */
function imageWithRecordedEncode(calls: Array<{ width: number; height: number; format: string; quality?: number }>): NativeImage {
  return {
    ...nativeImage,
    async encode(input, options) {
      calls.push({ width: input.width, height: input.height, format: options.format, quality: options.quality });
      return Uint8Array.from([0xff, 0xd8, 0xff, input.width & 0xff]);
    },
  };
}

async function hostWith(provide: Record<string, unknown>) {
  const host = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(),
      settings: { get: () => null, save: () => undefined },
      paths: { appDataDir: process.cwd() },
      vfsDatabase: { getConnSafe: () => ({}), blobsDir: () => '/blobs' },
      ...provide,
    },
  });
  return { host, service: host.ctx.pageRasterizer as PageRasterizerService };
}

async function appErrorOf(run: () => Promise<unknown>): Promise<{ error_type: string; message: string }> {
  try { await run(); }
  catch (error) {
    expect(error).toBeInstanceOf(CommandError);
    return (error as CommandError).value as { error_type: string; message: string };
  }
  throw new Error('expected CommandError');
}

function fakePdfium(pages: Array<{ width: number; height: number; text: string }>, closed: { value: boolean }): NativePdfium {
  return {
    async open() {
      return {
        pageCount: pages.length,
        async page(index) {
          const page = pages[index]!;
          return {
            width: page.width,
            height: page.height,
            async text() { return page.text; },
            async render(options) {
              expect(options.annotations).toBe(true);
              return { width: options.width, height: options.height, rgba: new Uint8Array(options.width * options.height * 4) };
            },
          };
        },
        async close() { closed.value = true; },
      };
    },
    async extractText() { return ''; },
  };
}

it('render size follows pdfium-render target_width 2550 / maximum_height 4200', () => {
  expect(renderSize(612, 792)).toEqual({ width: 2550, height: 3300 });
  expect(renderSize(612, 1500)).toEqual({ width: 1714, height: 4200 });
  expect(renderSize(842, 595)).toEqual({ width: 2550, height: 1802 });
});

it('detect_image_format signatures', () => {
  expect(detectImageFormat(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toEqual(['image/png', 'png']);
  expect(detectImageFormat(Uint8Array.from([0xff, 0xd8, 0xff, 0]))).toEqual(['image/jpeg', 'jpg']);
  expect(detectImageFormat(Buffer.from('RIFF0000WEBPVP8 '))).toEqual(['image/webp', 'webp']);
  expect(detectImageFormat(Buffer.from('GIF89a'))).toEqual(['image/gif', 'gif']);
  expect(detectImageFormat(Buffer.from('BM00'))).toEqual(['image/bmp', 'bmp']);
  expect(detectImageFormat(Buffer.from('0000ftypheic'))).toEqual(['image/heic', 'heic']);
  expect(detectImageFormat(Buffer.from('unknown'))).toEqual(['image/png', 'png']);
});

it('rasterize_pdf_cancellable renders the real PDF through nativePdfium and stores JPEG blobs', async () => {
  const stored: Stored[] = [];
  const encodes: Array<{ width: number; height: number; format: string; quality?: number }> = [];
  const { host, service } = await hostWith({
    nativePdfium: pdfium, nativeImage: imageWithRecordedEncode(encodes), vfsRepo: blobRepo(stored),
  });
  try {
    const result = await service.rasterizePdfCancellable(Buffer.from(MINIMAL_PDF).toString('base64'));
    expect(result.source_format).toBe('pdf');
    expect(result.pages).toEqual([{
      page_index: 0, blob_hash: 'hash10123456789', text_hint: null, width: 2550, height: 3300,
    }]);
    expect(encodes).toEqual([{ width: 2550, height: 3300, format: 'jpeg', quality: 75 }]);
    expect(stored.map(s => [s.mime, s.ext])).toEqual([['image/jpeg', 'jpg']]);
  } finally { await host.dispose(); }
});

it('rasterize_pdf_cancellable keeps trimmed text hints, accepts data URLs and closes the document', async () => {
  const stored: Stored[] = [];
  const closed = { value: false };
  const { host, service } = await hostWith({
    nativePdfium: fakePdfium([
      { width: 612, height: 792, text: '  第一页\n' },
      { width: 612, height: 1500, text: ' \n ' },
    ], closed),
    nativeImage: imageWithRecordedEncode([]),
    vfsRepo: blobRepo(stored),
  });
  try {
    const result = await service.rasterizePdfCancellable(
      `data:application/pdf;base64,${Buffer.from('%PDF-1.4 plain').toString('base64')}`);
    expect(result.pages.map(p => [p.page_index, p.text_hint, p.width, p.height])).toEqual([
      [0, '第一页', 2550, 3300], [1, null, 1714, 4200],
    ]);
    expect(stored).toHaveLength(2);
    expect(closed.value).toBe(true);
  } finally { await host.dispose(); }
});

it('rasterize_pdf_cancellable checks the token before every page', async () => {
  const stored: Stored[] = [];
  const closed = { value: false };
  const { host, service } = await hostWith({
    nativePdfium: fakePdfium([{ width: 612, height: 792, text: '' }], closed),
    nativeImage: imageWithRecordedEncode([]),
    vfsRepo: blobRepo(stored),
  });
  try {
    const controller = new AbortController();
    controller.abort();
    expect(await appErrorOf(() => service.rasterizePdfCancellable(
      Buffer.from('%PDF-1.4').toString('base64'), controller.signal)))
      .toMatchObject({ error_type: 'Validation', message: '题目来源渲染已取消' });
    expect(stored).toHaveLength(0);
    expect(closed.value).toBe(true);
  } finally { await host.dispose(); }
});

it('rasterize_pdf_cancellable rejects bad input with the Rust validation messages', async () => {
  const closed = { value: false };
  const { host, service } = await hostWith({
    nativePdfium: fakePdfium([], closed), nativeImage: imageWithRecordedEncode([]), vfsRepo: blobRepo([]),
  });
  try {
    expect(await appErrorOf(() => service.rasterizePdfCancellable('data:application/pdf;base64')))
      .toEqual(expect.objectContaining({ error_type: 'Validation', message: 'Data URL 格式错误：缺少 base64 内容' }));
    expect((await appErrorOf(() => service.rasterizePdfCancellable('@@@@'))).message)
      .toMatch(/^Base64 解码失败: Invalid byte 64, offset 0\.$/);
    const encrypted = Buffer.from('%PDF-1.4\n/Encrypt 5 0 R').toString('base64');
    expect(await appErrorOf(() => service.rasterizePdfCancellable(encrypted))).toMatchObject({
      error_type: 'Validation',
      message: "文档已加密: 文件 'document.pdf' 是加密的 PDF 文档，请先解除密码保护后再上传",
    });
    expect(await appErrorOf(() => service.rasterizePdfCancellable(Buffer.from('%PDF-1.4').toString('base64'))))
      .toMatchObject({ error_type: 'Validation', message: 'PDF 中没有页面' });
  } finally { await host.dispose(); }
});

it('rasterize_pdf_cancellable reports a missing pdfium provider as internal', async () => {
  const { host, service } = await hostWith({ nativeImage: imageWithRecordedEncode([]), vfsRepo: blobRepo([]) });
  try {
    const error = await appErrorOf(() => service.rasterizePdfCancellable(Buffer.from('%PDF-1.4').toString('base64')));
    expect(error.error_type).toBe('Unknown');
    expect(error.message.startsWith('加载 pdfium 失败: ')).toBe(true);
  } finally { await host.dispose(); }
});

function png(width: number, height: number): string {
  return Buffer.from(encodePngRgba(width, height, new Uint8Array(width * height * 4).fill(255))).toString('base64');
}

it('rasterize_images stores single and JSON-array sources with probed dimensions', async () => {
  const stored: Stored[] = [];
  const { host, service } = await hostWith({ nativeImage, vfsRepo: blobRepo(stored) });
  try {
    const single = await service.rasterizeImages(png(3, 2));
    expect(single).toEqual({
      source_format: 'image',
      pages: [{ page_index: 0, blob_hash: 'hash10123456789', text_hint: null, width: 3, height: 2 }],
    });
    const list = await service.rasterizeImages(`  ${JSON.stringify([`data:image/png;base64,${png(4, 5)}`, png(1, 1)])}`);
    expect(list.pages.map(p => [p.page_index, p.width, p.height])).toEqual([[0, 4, 5], [1, 1, 1]]);
    expect(stored.map(s => [s.mime, s.ext])).toEqual([['image/png', 'png'], ['image/png', 'png'], ['image/png', 'png']]);
  } finally { await host.dispose(); }
});

it('rasterize_images rejects empty lists, bad JSON, bad Base64 and undecodable images', async () => {
  const stored: Stored[] = [];
  const { host, service } = await hostWith({ nativeImage, vfsRepo: blobRepo(stored) });
  try {
    expect(await appErrorOf(() => service.rasterizeImages('[]')))
      .toMatchObject({ error_type: 'Validation', message: '图片列表为空' });
    expect((await appErrorOf(() => service.rasterizeImages('[1,'))).message.startsWith('解析图片列表失败: ')).toBe(true);
    expect((await appErrorOf(() => service.rasterizeImages('data:image/png;base64,@@@@'))).message)
      .toBe('图片 1 base64 解码失败: Invalid byte 64, offset 0.');
    expect(await appErrorOf(() => service.rasterizeImages(JSON.stringify([png(1, 1), Buffer.from('nope').toString('base64')]))))
      .toMatchObject({ error_type: 'Validation', message: '来源图片 2 无法读取尺寸，请先转换为 PNG/JPEG/WebP' });
    expect(stored).toHaveLength(1);
  } finally { await host.dispose(); }
});

it('rasterize_images reports a malformed image list with the serde_json::from_str::<Vec<String>> Display (page_rasterizer.rs:204)', async () => {
  const stored: Stored[] = [];
  const { host, service } = await hostWith({ nativeImage, vfsRepo: blobRepo(stored) });
  try {
    const cases: Array<[string, string]> = [
      ['[1,', 'invalid type: integer `1`, expected a string at line 1 column 2'],
      ['[', 'EOF while parsing a list at line 1 column 1'],
      ['["a",]', 'trailing comma at line 1 column 6'],
      ['[x]', 'expected value at line 1 column 2'],
      ['["a"] x', 'trailing characters at line 1 column 7'],
      ['[null]', 'invalid type: null, expected a string at line 1 column 5'],
    ];
    for (const [content, serde] of cases) {
      expect(await appErrorOf(() => service.rasterizeImages(content)))
        .toMatchObject({ error_type: 'Validation', message: `解析图片列表失败: ${serde}` });
    }
    expect(stored).toHaveLength(0);
  } finally { await host.dispose(); }
});

it('rasterize_images maps blob store failures to database errors', async () => {
  const { host, service } = await hostWith({
    nativeImage,
    vfsRepo: { blobs: { storeBlob() { throw new Error('disk full'); } } },
  });
  try {
    expect(await appErrorOf(() => service.rasterizeImages(png(1, 1))))
      .toMatchObject({ error_type: 'Database', message: '图片 1 Blob 存储失败: disk full' });
  } finally { await host.dispose(); }
});
