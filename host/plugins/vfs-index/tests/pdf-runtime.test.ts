import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createNodeFiles } from '../../../platform/files/index.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { NativePdfium } from '../../../platform/native/pdfium/api.ts';
import { image as nativeImage } from '../../../platform/native/image/index.ts';
import { adjustImageQualityBytes, adjustImageQualityBase64 } from '../../../platform/storage/file-manager.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import { NativePdfStageRuntime, parsePreviewJson, type PdfNativeRuntimeDeps } from '../src/pdf-runtime.ts';
import { ProcessingSlots } from '../src/pdf-processing.ts';
import type { ProcessingProgress, ProcessingStage } from '../api.ts';
import type { MediaTranscriberService } from '../api.ts';
import { bindVfsTableOwners } from '../repository/owners.ts';
import { realOwner } from './support/real-owner.ts';

interface Harness {
  db: DatabaseHandle;
  base: string;
  storage: ReturnType<typeof createStorageService>;
}

const harnesses: Harness[] = [];
const tempHashes = new Map<string, { data: Uint8Array; path: string }>();

it('R12-08 PdfPreviewJson serde rejects missing or mistyped required fields without invented defaults', () => {
  const page = { pageIndex: 0, blobHash: 'image', width: 30, height: 40, mimeType: 'image/png' };
  const valid = { pages: [page], renderDpi: 150, totalPages: 1, renderedAt: 'recorded' };
  expect(parsePreviewJson(JSON.stringify(valid))).toEqual({ ...valid, isTruncated: false, maxRenderedPages: 0 });
  for (const field of ['pages', 'renderDpi', 'totalPages', 'renderedAt']) {
    const invalid: Record<string, unknown> = { ...valid };
    delete invalid[field];
    expect(parsePreviewJson(JSON.stringify(invalid)), field).toBeNull();
  }
  for (const field of ['pageIndex', 'blobHash', 'width', 'height', 'mimeType']) {
    const invalid: Record<string, unknown> = { ...page };
    delete invalid[field];
    expect(parsePreviewJson(JSON.stringify({ ...valid, pages: [invalid] })), field).toBeNull();
  }
  for (const patch of [
    { renderDpi: -1 }, { totalPages: '1' }, { renderedAt: null }, { isTruncated: null },
    { maxRenderedPages: -1 }, { pages: [{ ...page, width: 4294967296 }] },
    { pages: [{ ...page, height: 1.5 }] }, { pages: [{ ...page, compressedBlobHash: 7 }] },
  ]) expect(parsePreviewJson(JSON.stringify({ ...valid, ...patch }))).toBeNull();
  expect(parsePreviewJson(JSON.stringify({ ...valid, pages: [{ ...page, compressedBlobHash: null }] })))
    .toEqual({ ...valid, isTruncated: false, maxRenderedPages: 0 });
});
let templateDir = '';

beforeAll(async () => {
  templateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-pdf-runtime-template-'));
  const storage = createStorageService({
    baseDir: templateDir,
    dataLocalDir: path.join(templateDir, 'local'),
  });
  const report = await storage.migrations.runAll();
  if (!report.success) throw new Error('vfs migration failed');
  storage.dispose();
}, 180_000);

function freshDb(): Harness {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-pdf-runtime-'));
  fs.cpSync(templateDir, base, { recursive: true });
  const storage = createStorageService({ baseDir: base, dataLocalDir: path.join(base, 'local') });
  const harness = { db: storage.database('vfs'), base, storage };
  harnesses.push(harness);
  return harness;
}

afterEach(() => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop()!;
    harness.storage.dispose();
    fs.rmSync(harness.base, { recursive: true, force: true });
  }
  tempHashes.clear();
});

function storeBlob(data: Uint8Array): string {
  const hash = `blob_${tempHashes.size}`;
  const filePath = path.join(os.tmpdir(), `vfs-pdf-runtime-${process.pid}-${hash}`);
  fs.writeFileSync(filePath, data);
  tempHashes.set(hash, { data, path: filePath });
  return hash;
}

/**
 * Formal L11 provider members (files/exams/resources/mediaTranscripts) on the
 * test's own connection; only the blob store is a test-local temp-file fixture.
 */
function repositories(db: DatabaseHandle): VfsReposService {
  const owner = realOwner();
  const repos = {
    blobs: {
      getBlobPath: (_db: unknown, _dir: unknown, hash: string) => tempHashes.get(hash)?.path ?? null,
      storeBlob: (_db: unknown, _dir: unknown, data: Uint8Array) => ({ hash: storeBlob(data) }),
      getBlob: () => null,
      blobExists: (hash: string) => tempHashes.has(hash),
      incrementRef: () => 1,
      decrementRef: () => 0,
      cleanupBlob: () => true,
      prepareBlobDeletion: () => null,
      recoverPreparedBlobDeletions: () => 0,
      removeUnregisteredBlobFile: () => true,
      cleanupUnreferenced: () => 0,
      stageStream: () => { throw new Error('not used'); },
      storeStagedBlob: () => { throw new Error('not used'); },
    },
    files: owner.files,
    exams: owner.exams,
    resources: owner.resources,
    mediaTranscripts: owner.mediaTranscripts,
  } as unknown as VfsReposService;
  bindVfsTableOwners(db, repos);
  return repos;
}

function pdfium(bytes: Uint8Array, text: string): NativePdfium & {
  diagnostics(): Promise<Record<string, string>>;
} {
  return {
    async diagnostics() { throw new Error('PDF pipeline fixture does not exercise native diagnostics'); },
    async extractText() { return text; },
    async open() {
      return {
        pageCount: 2,
        async page(index: number) {
          return {
            width: 600,
            height: 800,
            async text() { return index === 0 ? text : ''; },
            async render() {
              return {
                width: 2,
                height: 2,
                rgba: new Uint8Array([
                  255, 0, 0, 255, 0, 255, 0, 255,
                  0, 0, 255, 255, 255, 255, 255, 255,
                ]),
              };
            },
          };
        },
        async close() {},
      };
    },
  };
}

function deps(db: DatabaseHandle, options: {
  pdfium?: NativePdfium;
  ocrText?: string;
  transcriber?: MediaTranscriberService;
} = {}): {
  deps: PdfNativeRuntimeDeps;
  progress: Array<[ProcessingStage, ProcessingProgress]>;
  indexed: string[];
} {
  const progress: Array<[ProcessingStage, ProcessingProgress]> = [];
  const indexed: string[] = [];
  const owner = repositories(db);
  // 测试夹具的 blob 与 OCR 临时文件都在系统临时目录下，用同一根的真实 files 服务。
  const files = createNodeFiles({ roots: [{ name: 'temp', path: os.tmpdir() }] });
  return {
    progress,
    indexed,
    deps: {
      db,
      blobsDir: path.join(os.tmpdir(), 'vfs-pdf-blobs'),
      appDataDir: path.join(os.tmpdir(), 'vfs-pdf-appdata'),
      files: () => files,
      pdfium: () => options.pdfium,
      nativeImage: () => nativeImage,
      imageQuality: () => ({ adjustImageQualityBytes, adjustImageQualityBase64 }),
      repositories: () => owner,
      ocr: () => ({
        available: async () => true,
        recognize: async () => options.ocrText ?? '扫描页 OCR 文本 '.repeat(8),
      }),
      indexing: () => ({
        async indexResource(resourceId: string) {
          indexed.push(resourceId);
          return [1, 0] as [number, number];
        },
      }),
      transcriber: () => options.transcriber,
      ocrConfig: () => ({ enabled: true, pdfTextThreshold: 100, ocrImages: true, ocrScannedPdf: true }),
      chatModelIsMultimodal: async () => false,
      slots: new ProcessingSlots(1),
      nowIso: () => '2026-01-01T00:00:00.000Z',
    },
  };
}

function insertFile(
  db: DatabaseHandle,
  blobHash: string,
  mime = 'application/pdf',
  fileName = 'scan.pdf',
): void {
  db.run(
    `INSERT INTO blobs (hash, relative_path, size, mime_type, ref_count, created_at)
     VALUES (?1, 'objects/test', 8, ?2, 1, 1)`,
    [blobHash, mime],
  );
  db.run(
    `INSERT INTO resources (id, hash, type, storage_mode, data, created_at, updated_at)
     VALUES ('res_pdf', 'h', 'file', 'external', NULL, 1, 1)`,
  );
  db.run(
    `INSERT INTO files (id, resource_id, blob_hash, sha256, file_name, size, "type", mime_type,
       status, created_at, updated_at, page_count)
     VALUES ('file_pdf', 'res_pdf', ?1, 'sha', ?2, 12, 'file', ?3, 'active', 1, 1, NULL)`,
    [blobHash, fileName, mime],
  );
}

describe('Rust pdf_processing_service.rs native stages', () => {
  it('compresses upload previews, OCRs scanned pages and indexes without re-extracting (Rust has no Stage 1/1.5)', async () => {
    const { db, base } = freshDb();
    fs.writeFileSync(path.join(base, 'scan.pdf'), '%PDF-1.4');
    const blobHash = storeBlob(new Uint8Array(Buffer.from('%PDF-1.4')));
    insertFile(db, blobHash);
    db.run("UPDATE files SET page_count = 2 WHERE id = 'file_pdf'");
    const context = deps(db, { pdfium: pdfium(new Uint8Array(), '') });
    const runtime = new NativePdfStageRuntime(context.deps);
    // Upload renders the preview (Stage 1-2 run in create_file_with_doc_data_in_folder).
    expect(runtime.backfillMissingPreviews(10)).toBe(1);
    await vi.waitFor(() => {
      expect(db.pluck<unknown>("SELECT preview_json FROM files WHERE id = 'file_pdf'")).not.toBeNull();
    }, { timeout: 10_000 });
    const extractedBefore = db.pluck<unknown>("SELECT extracted_text FROM files WHERE id = 'file_pdf'");
    const statuses: Array<[ProcessingStage, ProcessingProgress | null | undefined]> = [];

    const result = await runtime.run(
      'file_pdf',
      'text_extraction',
      new AbortController().signal,
      {
        progress: (stage, value) => context.progress.push([stage, value]),
        status: (stage, value) => statuses.push([stage, value]),
      },
    );

    expect(result.readyModes).toEqual(expect.arrayContaining(['image', 'ocr']));
    expect(result.readyModes).not.toContain('text');
    expect(result.totalPages).toBe(2);
    expect(context.indexed).toEqual(['res_pdf']);
    const file = db.get<Record<string, unknown>>(
      "SELECT extracted_text, preview_json, ocr_pages_json, page_count FROM files WHERE id = 'file_pdf'",
    )!;
    expect(file['extracted_text']).toBe(extractedBefore);
    expect(file['page_count']).toBe(2);
    const preview = JSON.parse(String(file['preview_json'])) as {
      pages: Array<{ pageIndex: number; blobHash: string; width: number; height: number }>;
    };
    expect(preview.pages).toHaveLength(2);
    expect(preview).toMatchObject({ isTruncated: false, maxRenderedPages: 50 });
    expect(preview.pages[0]).toMatchObject({ pageIndex: 0, width: 2, height: 2 });
    expect(preview.pages[0]!.blobHash).not.toBe(blobHash);
    const ocr = JSON.parse(String(file['ocr_pages_json'])) as { totalPages: number; pages: unknown[] };
    expect(ocr.totalPages).toBe(2);
    expect(ocr.pages).toHaveLength(2);
    expect(String(db.pluck('SELECT ocr_text FROM resources WHERE id = ?1', ['res_pdf'])))
      .toContain('扫描页 OCR 文本');
    const stages = context.progress.map(([stage]) => stage);
    expect(stages).toEqual(expect.arrayContaining(['page_compression', 'ocr_processing', 'vector_indexing']));
    expect(stages).not.toContain('text_extraction');
    expect(stages).not.toContain('page_rendering');
    expect(statuses.map(([stage, value]) => [stage, value?.percent ?? null])).toEqual([
      ['page_compression', null], ['page_compression', 5], ['ocr_processing', null], ['vector_indexing', null],
    ]);
    expect(context.progress.filter(([stage]) => stage === 'vector_indexing').map(([, value]) => value)).toEqual(
      [75, 85, 95].map(percent => ({
        stage: 'vector_indexing', totalPages: 2, percent, readyModes: ['image', 'ocr'], mediaType: 'pdf',
      })),
    );
  });

  it('backfills missing previews for historical PDFs with page_count', async () => {
    const { db } = freshDb();
    const blobHash = storeBlob(new Uint8Array(Buffer.from('%PDF-1.4')));
    insertFile(db, blobHash);
    db.run("UPDATE files SET page_count = 2 WHERE id = 'file_pdf'");
    const context = deps(db, { pdfium: pdfium(new Uint8Array(), 'page text') });
    const runtime = new NativePdfStageRuntime(context.deps);

    expect(runtime.backfillMissingPreviews(10)).toBe(1);
    await vi.waitFor(() => {
      const previewJson = db.pluck<unknown>("SELECT preview_json FROM files WHERE id = 'file_pdf'");
      expect(previewJson).not.toBeNull();
    }, { timeout: 10_000 });
  });

  it('a backfill whose scope is already aborted hands its task to the scope and renders nothing', async () => {
    const { db, base } = freshDb();
    fs.writeFileSync(path.join(base, 'scan.pdf'), '%PDF-1.4');
    insertFile(db, storeBlob(new Uint8Array(Buffer.from('%PDF-1.4'))));
    db.run("UPDATE files SET page_count = 2 WHERE id = 'file_pdf'");
    const context = deps(db, { pdfium: pdfium(new Uint8Array(), 'page text') });
    const runtime = new NativePdfStageRuntime(context.deps);
    const tracked: Array<Promise<void>> = [];
    expect(runtime.backfillMissingPreviews(10, { signal: AbortSignal.abort(), track: (task) => tracked.push(task) })).toBe(1);
    expect(tracked).toHaveLength(1);
    await tracked[0];
    expect(db.pluck<unknown>("SELECT preview_json FROM files WHERE id = 'file_pdf'")).toBeNull();
  });
});

describe('Rust pdf_processing_service.rs media transcription hook', () => {
  it('delegates audio transcription to L18 mediaTranscriber and schedules transcript indexing', async () => {
    const { db } = freshDb();
    const blobHash = storeBlob(new Uint8Array(Buffer.from('audio-bytes')));
    insertFile(db, blobHash, 'audio/mpeg', 'clip.mp3');
    const requests: Array<{ fileId: string; imported: boolean }> = [];
    const segments: Array<{ completedSegments?: number | null; totalSegments?: number | null }> = [];
    const context = deps(db, {
      transcriber: {
        async transcribe(request) {
          requests.push({ fileId: request.fileId, imported: request.imported });
          request.onProgress({ stage: 'asr', percent: 50, completedSegments: 1, totalSegments: 2 });
          return { transcriptChars: 24, doneSegments: 2, totalSegments: 2, failedSegments: 0 };
        },
      },
    });
    const runtime = new NativePdfStageRuntime(context.deps);

    const result = await runtime.run(
      'file_pdf',
      'queued',
      new AbortController().signal,
      {
        progress: (stage, value, detail) => {
          context.progress.push([stage, value]);
          if (detail !== undefined) segments.push(detail);
        },
        status: () => undefined,
      },
    );

    expect(requests).toEqual([{ fileId: 'file_pdf', imported: false }]);
    expect(result.readyModes).toEqual(['text']);
    expect(result).toMatchObject({ completedSegments: 2, totalSegments: 2 });
    expect(context.indexed).toEqual(['res_pdf']);
    expect(context.progress.map(([stage]) => stage)).toEqual(['asr', 'indexing']);
    expect(segments).toEqual([
      { completedSegments: 1, totalSegments: 2 },
      { completedSegments: 2, totalSegments: 2 },
    ]);
  });

  it('fails explicitly until the L18 mediaTranscriber provider is on main', async () => {
    const { db } = freshDb();
    const blobHash = storeBlob(new Uint8Array(Buffer.from('audio-bytes')));
    insertFile(db, blobHash, 'audio/mpeg', 'clip.mp3');
    const runtime = new NativePdfStageRuntime(deps(db).deps);

    await expect(runtime.run(
      'file_pdf',
      'queued',
      new AbortController().signal,
      { progress: () => undefined, status: () => undefined },
    )).rejects.toThrow(
      'media transcriber not registered (L18 mediaTranscriber 待 ds-mig/L18-media-docs 合入 main)',
    );
  });
});
