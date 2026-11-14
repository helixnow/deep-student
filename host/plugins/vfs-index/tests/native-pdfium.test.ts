/**
 * Real F7 `nativePdfium` Node-path check.
 *
 * The lane ships PDF text extraction through the platform adapter rather than a
 * test double; this locks the actual WASM import and the page-separator
 * contract used by legacy multi-page PDF repair.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createNodeFiles } from '../../../platform/files/index.ts';
import { pdfium } from '../../../platform/native/pdfium/index.ts';
import { image as nativeImage } from '../../../platform/native/image/index.ts';
import storagePlugin from '../../../platform/storage/index.ts';
import secretsPlugin from '../../../platform/secrets/index.ts';
import settingsPlugin from '../../../platform/settings/index.ts';
// boundary-allow cross-plugin-impl: real L11 provider validates PDF/blob persistence in the public pipeline
import reposPlugin from '../../vfs-repos/index.ts';
import plugin from '../index.ts';
import { pathsServiceDouble } from './support/paths-service.ts';

function buildTwoPagePdf(): Uint8Array {
  const contents = [
    'BT /F1 24 Tf 20 100 Td (Page One) Tj ET',
    'BT /F1 24 Tf 20 100 Td (Page Two) Tj ET',
  ];
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R '
      + '/Resources << /Font << /F1 7 0 R >> >> >>',
    `<< /Length ${contents[0]!.length} >>\nstream\n${contents[0]}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 6 0 R '
      + '/Resources << /Font << /F1 7 0 R >> >> >>',
    `<< /Length ${contents[1]!.length} >>\nstream\n${contents[1]}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let output = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(output, 'ascii'));
    output += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output, 'ascii');
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    output += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
    + `startxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(output);
}

describe('F7 nativePdfium in Node', () => {
  it('extracts real page text and page count from PDF bytes', async () => {
    const bytes = buildTwoPagePdf();

    const text = await pdfium.extractText(bytes);
    expect(text.split('\f')).toEqual(['Page One', 'Page Two']);

    const document = await pdfium.open(bytes, null);
    try {
      expect(document.pageCount).toBe(2);
      const page = await document.page(1);
      expect((await page.text()).trim()).toBe('Page Two');
    } finally {
      await document.close();
    }
  }, 120_000);
});

it('R12-01 PDF pipeline uses real F7 PNG encoding and the published F3 image-quality policy', async () => {
  const root = fs.mkdtempSync('/tmp/opencode/vfs-native-image-');
  let host: Awaited<ReturnType<typeof createTestHost>> | undefined;
  const encode = vi.spyOn(nativeImage, 'encode');
  try {
    host = await createTestHost({
      app: { dataDir: root },
      plugins: [secretsPlugin, [storagePlugin, { dataLocalDir: root }], settingsPlugin, reposPlugin, plugin],
      provide: {
        files: createNodeFiles({ roots: [{ name: 'appData', path: root }, { name: 'temp', path: os.tmpdir() }] }),
        paths: { ...pathsServiceDouble(), appDataDir: root,
          os: { home: root, data: root, dataLocal: root, config: root, temp: root } },
        log: { logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
        storageStartupSync: { resetDefaultAfterLocalPurge() { throw new Error('clean test root has no purge marker'); } },
        nativeImage, nativePdfium: pdfium,
      },
    });
    host.ctx.settings.save('ocr.enabled', 'false');
    const adjust = vi.spyOn(host.ctx.imageQuality, 'adjustImageQualityBytes');
    const db = host.ctx.storage.database('vfs');
    const repos = host.ctx.vfsRepo;
    const blobsDir = path.join(host.ctx.storage.locations.activeDir, 'vfs_blobs');
    const pdf = buildTwoPagePdf();
    const blob = repos.blobs.storeBlob(db, blobsDir, pdf, 'application/pdf');
    const file = repos.files.createFileWithDocDataInFolder(
      db, 'sha_native_pipeline', 'two-pages.pdf', pdf.length, 'file', 'application/pdf',
      blob.hash, null, null, null, 'Existing text '.repeat(20), 2,
    );
    const completion = new Promise<unknown>((resolve, reject) => {
      host!.ctx.backendEvents.listen('pdf-processing-completed', resolve);
      host!.ctx.backendEvents.listen('pdf-processing-error', reject);
    });
    // Rust's pipeline has no rendering stage: previews come from upload or backfill_missing_previews.
    expect(host.ctx.vfsIndex.pdf.backfillMissingPreviews()).toBe(1);
    await vi.waitFor(() => {
      expect(db.pluck('SELECT preview_json FROM files WHERE id = ?1', [file.id])).not.toBeNull();
    }, { timeout: 30_000 });
    await host.ctx.vfsIndex.pdf.startPipeline(file.id, 'page_rendering');
    const completed = await completion;
    expect(completed, JSON.stringify(host.ctx.vfsIndex.pdf.getStatus(file.id)))
      .toMatchObject({ fileId: file.id, readyModes: expect.arrayContaining(['image']) });
    const preview = JSON.parse(String(db.pluck('SELECT preview_json FROM files WHERE id = ?1', [file.id]))) as {
      pages: Array<{ blobHash: string; width: number; height: number }>;
    };
    expect(preview.pages).toHaveLength(2);
    expect(encode).toHaveBeenCalledTimes(2);
    expect(encode.mock.calls.every(([, options]) => options.format === 'png')).toBe(true);
    expect(adjust).toHaveBeenCalledTimes(2);
    expect(adjust.mock.calls.every(([, quality, codec]) => quality === 'low' && codec === nativeImage)).toBe(true);
    for (const result of adjust.mock.results) {
      const compressed = await result.value as Uint8Array;
      expect([...compressed.subarray(0, 2)]).toEqual([0xff, 0xd8]);
      expect(await nativeImage.dimensions(compressed)).toEqual({ width: 768, height: 768 });
    }
    for (const page of preview.pages) {
      const bytes = new Uint8Array(fs.readFileSync(repos.blobs.getBlobPath(db, blobsDir, page.blobHash)!));
      expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(await nativeImage.dimensions(bytes)).toEqual({ width: page.width, height: page.height });
    }
    adjust.mockRestore();
  } finally {
    encode.mockRestore();
    await host?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
