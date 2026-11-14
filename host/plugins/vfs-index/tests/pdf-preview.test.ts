import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { testFiles } from './support/files.ts';
import { adjustImageQualityBytes, adjustImageQualityBase64 } from '../../../platform/storage/file-manager.ts';
import { image } from '../../../platform/native/image/index.ts';
// boundary-allow cross-plugin-impl: real file/blob/resource persistence owner
import reposPlugin from '../../vfs-repos/index.ts';
import plugin from '../index.ts';
import { pathsServiceDouble } from './support/paths-service.ts';
import { parsePreviewJson } from '../src/pdf-runtime.ts';

const page = '{"pageIndex":0,"blobHash":"page","width":1,"height":1,"mimeType":"image/png"}';
const preview = `{"pages":[${page}],"renderDpi":150,"totalPages":1,"renderedAt":"recorded"}`;

it.each([
  preview.replace('"renderDpi":150', '"renderDpi":150.0'),
  preview.replace('"totalPages":1', '"totalPages":1e0'),
  preview.replace('"pageIndex":0', '"pageIndex":-0'),
  preview.replace('"width":1', '"width":1.0'),
  preview.replace('"renderDpi":150', '"renderDpi":150,"renderDpi":151'),
  preview.replace('"pageIndex":0', '"pageIndex":0,"pageIndex":1'),
  preview.replace('"mimeType":"image/png"', '"mimeType":"image/png","compressedBlobHash":null,"compressedBlobHash":"second"'),
  preview.replace('"totalPages":1', '"totalPages":18446744073709551616'),
])('R12-08 PdfPreviewJson rejects typed integer/duplicate violations: %s', raw => {
  expect(parsePreviewJson(raw)).toBeNull();
});

it('R12-08 PdfPreviewJson accepts serde struct sequences and trailing defaults', () => {
  expect(parsePreviewJson('[[[7,"page",1,2,"image/png",null]],150,8,"recorded"]')).toEqual({
    pages: [{ pageIndex: 7, blobHash: 'page', width: 1, height: 2, mimeType: 'image/png' }],
    renderDpi: 150, totalPages: 8, renderedAt: 'recorded', isTruncated: false, maxRenderedPages: 0,
  });
  expect(parsePreviewJson('[[[7,"page",1,2,"image/png"]],150,8,"recorded"]')).toBeNull();
  expect(parsePreviewJson('[[],150,8,"recorded",false,0,7]')).toBeNull();
});

it('R12-08 PdfPreviewJson preserves usize and ignores duplicate unknown fields', () => {
  const raw = preview.replace('"pageIndex":0', '"pageIndex":9007199254740993')
    .replace('"totalPages":1', '"totalPages":18446744073709551615')
    .replace('"renderedAt":"recorded"', '"renderedAt":"recorded","extra":0,"extra":1,"maxRenderedPages":9007199254740993');
  expect(parsePreviewJson(raw)).toMatchObject({ totalPages: 18446744073709551615n,
    maxRenderedPages: 9007199254740993n, pages: [{ pageIndex: 9007199254740993n }] });
});

it('R12-08 PdfPreviewJson ignores an unconsumed overflowing float as serde IgnoredAny', () => {
  expect(parsePreviewJson(preview.replace('"renderedAt":"recorded"', '"renderedAt":"recorded","futureField":1e400')))
    .toEqual({ pages: [{ pageIndex: 0, blobHash: 'page', width: 1, height: 1, mimeType: 'image/png' }],
      renderDpi: 150, totalPages: 1, renderedAt: 'recorded', isTruncated: false, maxRenderedPages: 0 });
});

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: TestHost;
let enableOcr = false;
beforeAll(async () => {
  root = fs.mkdtempSync('/tmp/opencode/vfs-preview-');
  storage = createStorageService({ baseDir: root, dataLocalDir: path.join(root, 'local') });
  const report = await storage.migrations.runAll();
  if (!report.success) throw new Error(report.error ?? 'migration failed');
  host = await createTestHost({ plugins: [reposPlugin, plugin], provide: { files: testFiles(storage), 
    storage, paths: pathsServiceDouble(), settings: { get: (key: string) => key === 'ocr.enabled' ? String(enableOcr) : null },
    nativeImage: image, imageQuality: { adjustImageQualityBytes, adjustImageQualityBase64 },
    llmOcrModels: { inspectFreeTextOcrAvailable: async () => true, getFreeTextOcrCandidatesByPriority: async () => [] },
    llmOcrHedge: { prepareCandidates: async () => [], runPrepared: async () => 'page OCR text' },
  } });
}, 180_000);
afterAll(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

it('R12-08 public PDF compression preserves exact preview counters through the owner writeback', async () => {
  const db = storage.database('vfs');
  const repos = host.ctx.vfsRepo;
  const bytes = Buffer.from('existing page image bytes');
  const blob = repos.blobs.storeBlob(db, path.join(storage.locations.activeDir, 'vfs_blobs'), bytes, 'image/png');
  const file = repos.files.createFileWithDocDataInFolder(db, 'preview-precision', 'book.pdf', 100,
    'file', 'application/pdf', null, null, null, null, 'Existing text '.repeat(20), 1);
  const raw = preview.replace('"blobHash":"page"', `"blobHash":"${blob.hash}"`)
    .replace('"pageIndex":0', '"pageIndex":9007199254740993')
    .replace('"totalPages":1', '"totalPages":18446744073709551615');
  repos.files.updatePdfPreviewOnly(db, file.id, raw);
  const done = new Promise<unknown>((resolve, reject) => {
    host.ctx.backendEvents.listen('media-processing-completed', resolve);
    host.ctx.backendEvents.listen('media-processing-error', reject);
  });
  await host.ctx.vfsIndex.pdf.startPipeline(file.id, 'page_compression');
  expect(await done).toMatchObject({ readyModes: expect.arrayContaining(['image']) });
  const stored = String(db.pluck('SELECT preview_json FROM files WHERE id = ?1', [file.id]));
  expect(stored).toContain('"pageIndex":9007199254740993');
  expect(stored).toContain('"totalPages":18446744073709551615');
  expect(parsePreviewJson(stored)).toMatchObject({ isTruncated: false, maxRenderedPages: 0,
    pages: [{ compressedBlobHash: blob.hash }] });
});

it('R12-08 public PDF OCR sorts and persists exact preview page indices', async () => {
  enableOcr = true;
  try {
    const db = storage.database('vfs');
    const repos = host.ctx.vfsRepo;
    const blob = repos.blobs.storeBlob(db, path.join(storage.locations.activeDir, 'vfs_blobs'), Buffer.from('OCR page'), 'image/png');
    const file = repos.files.createFileWithDocDataInFolder(db, 'preview-ocr-precision', 'scan.pdf', 100,
      'file', 'application/pdf', null, null, null, null, 'x', 2);
    // Exercise persisted OCR independently of the later resource indexer. Rust's
    // legacy ocr_utils turns page indices into a dense Vec (resize(index + 1)).
    db.run('UPDATE files SET resource_id = NULL WHERE id = ?1', [file.id]);
    const raw = `{"pages":[${page.replace('"pageIndex":0', '"pageIndex":9007199254740993')},${page.replace('"pageIndex":0', '"pageIndex":9007199254740992')}],"renderDpi":150,"totalPages":2,"renderedAt":"recorded"}`
      .replaceAll('"blobHash":"page"', `"blobHash":"${blob.hash}","compressedBlobHash":"${blob.hash}"`);
    repos.files.updatePdfPreviewOnly(db, file.id, raw);
    const done = new Promise<unknown>((resolve, reject) => {
      host.ctx.backendEvents.listen('media-processing-completed', resolve);
      host.ctx.backendEvents.listen('media-processing-error', reject);
    });
    await host.ctx.vfsIndex.pdf.startPipeline(file.id, 'ocr_processing');
    await done;
    const stored = String(db.pluck('SELECT ocr_pages_json FROM files WHERE id = ?1', [file.id]));
    expect(stored).toContain('"pageIndex":9007199254740992');
    expect(stored).toContain('"pageIndex":9007199254740993');
    expect(stored.indexOf('"pageIndex":9007199254740992')).toBeLessThan(stored.indexOf('"pageIndex":9007199254740993'));
  } finally { enableOcr = false; }
});
