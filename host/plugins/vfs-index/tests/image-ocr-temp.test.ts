import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { testFiles } from './support/files.ts';
// boundary-allow cross-plugin-impl: use the real blob/file/resource owners
import reposPlugin from '../../vfs-repos/index.ts';
import plugin from '../index.ts';
import { pathsServiceDouble } from './support/paths-service.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: TestHost;
let observedPath: string | undefined;
let observedBytes: Buffer | undefined;
let failOcr = false;
const text = '  OCR text with original whitespace\n';

beforeAll(async () => {
  root = fs.mkdtempSync('/tmp/opencode/vfs-image-ocr-');
  storage = createStorageService({ baseDir: root, dataLocalDir: path.join(root, 'local') });
  const report = await storage.migrations.runAll();
  if (!report.success) throw new Error(report.error ?? 'migration failed');
  host = await createTestHost({ plugins: [reposPlugin, plugin], provide: { files: testFiles(storage), 
    storage, paths: pathsServiceDouble(), settings: { get: () => null },
    llmOcrModels: { inspectFreeTextOcrAvailable: async () => true },
    llmOcrHedge: {},
    llmOcrPages: { async callOcrFreeTextWithFallback(imagePath: string) {
      observedPath = imagePath;
      observedBytes = fs.readFileSync(imagePath);
      if (failOcr) throw { error_type: 'LLM', message: 'engine failed', details: null };
      return text;
    } },
  } });
}, 180_000);

afterAll(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

async function processImage(mime: string) {
  observedPath = undefined;
  observedBytes = undefined;
  const bytes = Buffer.from(`image payload ${mime} ${failOcr}`);
  const db = storage.database('vfs');
  const repos = host.ctx.vfsRepo;
  const blob = repos.blobs.storeBlob(db, path.join(storage.locations.activeDir, 'vfs_blobs'), bytes, mime);
  const file = repos.files.createFileWithDocDataInFolder(db, `ocr-${mime}-${failOcr}`, 'scan.png',
    bytes.length, 'image', mime, blob.hash, null, null, null, null, null);
  const done = new Promise<unknown>((resolve, reject) => {
    host.ctx.backendEvents.listen('media-processing-completed', resolve);
    host.ctx.backendEvents.listen('media-processing-error', reject);
  });
  await host.ctx.vfsIndex.pdf.startPipeline(file.id, 'ocr_processing');
  const completed = await done;
  return { bytes, file, completed, ocrText: db.pluck('SELECT ocr_text FROM resources WHERE id = ?1', [file.resourceId!]) };
}

it.each([
  ['image/jpeg', '.jpg'], ['IMAGE/WEBP', '.webp'], ['image/png', '.png'], ['application/octet-stream', '.png'],
])('R12-05 ocr_temp_image_extension_follows_mime through production image OCR: %s', async (mime, extension) => {
  const result = await processImage(mime);
  expect(observedPath).toBeDefined();
  expect(path.extname(observedPath!)).toBe(extension);
  expect(path.basename(observedPath!)).toMatch(/^ds-attachment-ocr-/);
  expect(observedBytes).toEqual(result.bytes);
  expect(fs.existsSync(observedPath!)).toBe(false);
  expect(result.ocrText).toBe(text);
  expect(result.completed).toMatchObject({ readyModes: expect.arrayContaining(['ocr']) });
});

it('R12-05 image OCR failure removes the MIME-suffixed file without persisting text', async () => {
  failOcr = true;
  try {
    const result = await processImage('image/jpeg');
    expect(observedPath).toBeDefined();
    expect(fs.existsSync(observedPath!)).toBe(false);
    expect(result.ocrText).toBeNull();
    expect(host.ctx.vfsIndex.pdf.getStatus(result.file.id)?.progress.failedStages)
      .toEqual(expect.arrayContaining([expect.objectContaining({ stage: 'ocr_processing', message: 'OCR API call failed: engine failed' })]));
  } finally { failOcr = false; }
});
