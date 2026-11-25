import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { createTestHost } from '../../../kernel/testing.ts';
import { officeText } from '../../../platform/native/office/text.ts';
import type { NativePdfium } from '../../../platform/native/pdfium/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { notesServiceDouble } from './support/notes-service.ts';
import { pathsServiceDouble } from './support/paths-service.ts';
import { createVfsTestStorage } from './support/vfs-test-storage.ts';
import type { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import {
  DEFAULT_PDF_PREVIEW_CONFIG,
  EAGER_IMPORT_PDF_PREVIEW_CONFIG,
  LARGE_PDF_EAGER_PREVIEW_MAX_PAGES,
  renderPdfPreview,
  type PdfImageEncoder,
  type PdfPreviewDependencies,
} from '../repository/pdf-preview.ts';
import { NativeAttachmentProcessing, type AttachmentDocs } from '../src/attachment-processing.ts';
import { BlobRepo } from '../repository/blobs.ts';
import { setRepositoryLogger } from '../repository/logger.ts';
import plugin from '../index.ts';

const conn = {} as SqlExecutor;

function fakePdfium(options: {
  pageCount?: number;
  text?: string;
  sizes?: Array<{ width: number; height: number }>;
  failPage?: number;
} = {}): NativePdfium {
  const pageCount = options.pageCount ?? 2;
  return {
    extractText: async () => options.text ?? '',
    open: async () => ({
      pageCount,
      async page(index: number) {
        if (options.failPage === index) throw new Error(`page ${index} failed`);
        const size = options.sizes?.[index] ?? { width: 600, height: 800 };
        return {
          width: size.width,
          height: size.height,
          async text() { return ''; },
          async render(renderOptions: { width: number; height: number }) {
            return {
              width: renderOptions.width,
              height: renderOptions.height,
              rgba: new Uint8Array(1),
            };
          },
        };
      },
      async close() {},
    }),
  };
}

function fakeImage(): PdfImageEncoder & { calls: Array<{ format: string; quality?: number }> } {
  const calls: Array<{ format: string; quality?: number }> = [];
  return {
    calls,
    async encode(_input, options) {
      calls.push(options);
      return new Uint8Array([options.format === 'jpeg' ? 1 : 2]);
    },
  };
}

function deps(overrides: Partial<PdfPreviewDependencies> = {}): PdfPreviewDependencies & {
  stored: Array<{ hash: string; mimeType: string; extension: string; bytes: number }>;
} {
  const stored: Array<{ hash: string; mimeType: string; extension: string; bytes: number }> = [];
  return {
    stored,
    pdfium: () => fakePdfium(),
    image: () => fakeImage(),
    storeBlob: (_conn, _dir, bytes, mimeType, extension) => {
      const hash = `blob_${stored.length}`;
      stored.push({ hash, mimeType, extension, bytes: bytes.length });
      return { hash } as ReturnType<PdfPreviewDependencies['storeBlob']>;
    },
    ...overrides,
  };
}

describe('pdf_preview.rs async port', { timeout: 120_000 }, () => {
  it('renders pages with Rust target width/height cap and keeps form feeds in text', async () => {
    const dependencies = deps({
      pdfium: () => fakePdfium({
        pageCount: 2,
        text: '  first page \fsecond page  \n',
        sizes: [{ width: 600, height: 800 }, { width: 300, height: 300 }],
      }),
    });
    const image = fakeImage();
    dependencies.image = () => image;

    const result = await renderPdfPreview(conn, '/blobs', Buffer.from('%PDF-1.4\nbody'), {
      ...DEFAULT_PDF_PREVIEW_CONFIG, maxPages: 1,
    }, dependencies);

    expect(result.extractedText).toBe('first page \fsecond page');
    expect(result.pageCount).toBe(2);
    expect(result.previewJson).toMatchObject({
      renderDpi: 150,
      totalPages: 2,
      isTruncated: true,
      maxRenderedPages: 1,
    });
    expect(result.previewJson?.pages).toHaveLength(1);
    expect(result.previewJson?.pages[0]).toMatchObject({
      pageIndex: 0, width: 1200, height: 1600, mimeType: 'image/jpeg',
    });
    expect(image.calls).toEqual([{ format: 'jpeg', quality: 75 }]);
    expect(dependencies.stored[0]).toMatchObject({ mimeType: 'image/jpeg', extension: 'jpg' });
  });

  it('uses PNG when compression is disabled', async () => {
    const image = fakeImage();
    const dependencies = deps({ image: () => image, pdfium: () => fakePdfium({ pageCount: 1 }) });
    const result = await renderPdfPreview(conn, '/blobs', Buffer.from('%PDF-1.4'), {
      ...DEFAULT_PDF_PREVIEW_CONFIG, compressionEnabled: false,
    }, dependencies);
    expect(image.calls).toEqual([{ format: 'png' }]);
    expect(result.previewJson?.pages[0]).toMatchObject({ mimeType: 'image/png' });
    expect(dependencies.stored[0]).toMatchObject({ mimeType: 'image/png', extension: 'png' });
  });

  it('V2-PDF-TEXT trims Rust char::is_whitespace and logs UTF-8 byte length', async () => {
    const debug: string[] = [];
    const noop = () => {};
    setRepositoryLogger({ error: noop, warn: noop, info: noop, debug: (format) => void debug.push(String(format)) });
    try {
      const dependencies = deps({
        pdfium: () => fakePdfium({ pageCount: 1, text: '\u0085 \f中文\f \uFEFF', failPage: 0 }),
      });
      const result = await renderPdfPreview(conn, '/blobs', Buffer.from('%PDF-1.4'), DEFAULT_PDF_PREVIEW_CONFIG, dependencies);
      // pdf_preview.rs:155-158: U+0085 is White_Space, U+FEFF is not; form feeds are kept.
      expect(result.extractedText).toBe('\f中文\f \uFEFF');
      // pdf_preview.rs:164 `trimmed.len()`: 1 + 6 + 1 + 1 + 3 bytes.
      expect(debug).toContain('[PDF-Preview] Extracted 12 chars from PDF');
    } finally {
      setRepositoryLogger({ error: noop, warn: noop, info: noop, debug: noop });
    }
  });

  it('keeps text-only result when page rendering fails', async () => {
    const dependencies = deps({
      pdfium: () => fakePdfium({ pageCount: 1, text: 'searchable text', failPage: 0 }),
    });
    const result = await renderPdfPreview(conn, '/blobs', Buffer.from('%PDF-1.4'), DEFAULT_PDF_PREVIEW_CONFIG, dependencies);
    expect(result.extractedText).toBe('searchable text');
    expect(result.previewJson).toBeNull();
    expect(result.pageCount).toBe(0);
  });

  it('keeps text when the image encoder is unavailable', async () => {
    const dependencies = deps({ image: () => null, pdfium: () => fakePdfium({ text: 'text' }) });
    const result = await renderPdfPreview(conn, '/blobs', Buffer.from('%PDF-1.4'), DEFAULT_PDF_PREVIEW_CONFIG, dependencies);
    expect(result).toMatchObject({ previewJson: null, extractedText: 'text', pageCount: 0 });
  });

  it('returns an empty result for encrypted PDFs without extracting text', async () => {
    const dependencies = deps({
      pdfium: () => fakePdfium({ text: 'should not be read' }),
      checkEncryption: () => { throw new Error('文件是加密的 PDF 文档'); },
    });
    const result = await renderPdfPreview(conn, '/blobs', Buffer.from('%PDF-1.4'), DEFAULT_PDF_PREVIEW_CONFIG, dependencies);
    expect(result).toEqual({ previewJson: null, extractedText: null, pageCount: 0 });
  });

  it('rejects non-PDF bytes before touching native services', async () => {
    const dependencies = deps();
    await expect(renderPdfPreview(conn, '/blobs', Buffer.from('not a pdf'), DEFAULT_PDF_PREVIEW_CONFIG, dependencies))
      .rejects.toThrow('不是有效的 PDF 文档（缺少 PDF 文件头）');
  });

  it('enforces per-page timeout so a stalled page never hangs synchronous import', async () => {
    const stalledPdfium: NativePdfium = {
      extractText: async () => 'page 1 text\fpage 2 text',
      open: async () => ({
        pageCount: 2,
        async page(index: number) {
          return {
            width: 600,
            height: 800,
            async text() { return ''; },
            async render(renderOptions: { width: number; height: number }) {
              if (index === 1) {
                await new Promise(() => {}); // Never resolves
              }
              return { width: renderOptions.width, height: renderOptions.height, rgba: new Uint8Array(1) };
            },
          };
        },
        async close() {},
      }),
    };
    const dependencies = deps({ pdfium: () => stalledPdfium });
    const result = await renderPdfPreview(
      conn,
      '/blobs',
      Buffer.from('%PDF-1.4\nbody'),
      { ...DEFAULT_PDF_PREVIEW_CONFIG, maxPages: 2, pageTimeoutMs: 40, totalRenderBudgetMs: 500 },
      dependencies,
    );
    expect(result.pageCount).toBe(2);
    expect(result.extractedText).toBe('page 1 text\fpage 2 text');
    expect(result.previewJson?.pages).toHaveLength(1);
    expect(result.previewJson?.pages[0]?.pageIndex).toBe(0);
  });

  it('defers new PDF rendering during upload and caps eager preview for >20-page PDFs', async () => {
    const renderedIndices: number[] = [];
    const bigPdfium: NativePdfium = {
      extractText: async () => 'full 48-page text',
      open: async () => ({
        pageCount: 48,
        async page(index: number) {
          renderedIndices.push(index);
          return {
            width: 600,
            height: 800,
            async text() { return ''; },
            async render(renderOptions: { width: number; height: number }) {
              return { width: renderOptions.width, height: renderOptions.height, rgba: new Uint8Array(1) };
            },
          };
        },
        async close() {},
      }),
    };
    const image = fakeImage();
    const { root: bigRoot, storage: bigStorage } = await createVfsTestStorage('l11-big-pdf-');
    const bigHost = await createTestHost({
      plugins: [plugin],
      provide: {
        storage: bigStorage,
        paths: pathsServiceDouble(),
        notes: notesServiceDouble(() => bigStorage.database('vfs')),
        nativePdfium: bigPdfium,
        nativeImage: image,
        nativeOfficeText: officeText,
        docs: {
          checkPdfEncryptionBytes() {},
          async extractTextFromBytes() { return ''; },
          async extractEpubPagesFromBytes() { return []; },
        },
      },
    });
    try {
      const bigDb = bigStorage.database('vfs');
      const pdfBytes = Buffer.from('%PDF-1.7\n48-page body');
      const blobsDir = bigStorage.locations.activeDir + '/vfs_blobs';
      // 1. New PDF upload must NOT synchronously render pages (Bug 2 / SOTA01 P1-a).
      const result = await bigHost.ctx.vfsRepo.attachments.uploadBytesWithConn(
        bigDb,
        blobsDir,
        { name: 'textbook-48p.pdf', mimeType: 'application/pdf', base64Content: '' },
        pdfBytes,
      );
      expect(result.isNew).toBe(true);
      expect(result.processingStatus).toBe('page_rendering');
      expect(renderedIndices).toHaveLength(0);

      // 2. When async render runs with EAGER_IMPORT_PDF_PREVIEW_CONFIG on >20p PDFs,
      // pages are capped to LARGE_PDF_EAGER_PREVIEW_MAX_PAGES while preserving full pageCount/text.
      const rendered = await bigHost.ctx.vfsRepo.attachmentProcessing.renderPdf(
        bigDb, blobsDir, pdfBytes, EAGER_IMPORT_PDF_PREVIEW_CONFIG,
      );
      expect(rendered.pageCount).toBe(48);
      expect(rendered.extractedText).toBe('full 48-page text');
      expect(renderedIndices).toHaveLength(LARGE_PDF_EAGER_PREVIEW_MAX_PAGES);
      expect(rendered.previewJson?.pages).toHaveLength(LARGE_PDF_EAGER_PREVIEW_MAX_PAGES);
      expect(rendered.previewJson?.totalPages).toBe(48);
      expect(rendered.previewJson?.isTruncated).toBe(true);
      expect(rendered.previewJson?.maxRenderedPages).toBe(LARGE_PDF_EAGER_PREVIEW_MAX_PAGES);
    } finally {
      await bigHost.dispose();
      bigStorage.dispose();
      rmSync(bigRoot, { recursive: true, force: true });
    }
  });
});

describe('NativeAttachmentProcessing production assembly', { timeout: 120_000 }, () => {
  const docs: AttachmentDocs = {
    checkPdfEncryptionBytes(_bytes, name) {
      if (name.includes('encrypted')) throw new Error('encrypted pdf');
    },
    async extractTextFromBytes(name) {
      if (name.endsWith('.docx')) return 'docx text';
      throw new Error(`unsupported: ${name}`);
    },
    async extractEpubPagesFromBytes() {
      return ['chapter one', 'chapter two'];
    },
  };

  function adapter() {
    const image = fakeImage();
    const blobs = new BlobRepo();
    const persistedPath = '/blobs/rendered.jpg';
    const persistBlob = vi.spyOn(blobs, 'persistBlob').mockResolvedValue(persistedPath);
    const storeBlob = vi.spyOn(blobs, 'storeBlob').mockReturnValue({
      hash: 'rendered', relativePath: 'rendered.jpg', mimeType: 'image/jpeg', size: 1, refCount: 1, createdAt: 0,
    });
    const processing = new NativeAttachmentProcessing({
      pdfium: () => fakePdfium({ text: 'pdf text', pageCount: 1 }),
      image: () => image,
      docs: () => docs,
      officeText: () => officeText,
      blobs: () => blobs,
    });
    return { processing, persistBlob, storeBlob, persistedPath };
  }

  it('delegates PDF rendering, encryption and document text to the owner services', async () => {
    const { processing, persistBlob, storeBlob, persistedPath } = adapter();
    const rendered = await processing.renderPdf(conn, '/blobs', Buffer.from('%PDF-1.4'), DEFAULT_PDF_PREVIEW_CONFIG);
    expect(rendered.extractedText).toBe('pdf text');
    expect(rendered.pageCount).toBe(1);
    const page = new Uint8Array([1]);
    expect(persistBlob).toHaveBeenCalledWith(conn, '/blobs', page, 'jpg');
    expect(storeBlob).toHaveBeenCalledWith(conn, '/blobs', page, 'image/jpeg', 'jpg', persistedPath);
    expect(persistBlob).toHaveBeenCalledBefore(storeBlob);

    expect(() => processing.checkPdfEncryption(Buffer.from('%PDF-'), 'ok.pdf')).not.toThrow();
    expect(() => processing.checkPdfEncryption(Buffer.from('%PDF-'), 'encrypted.pdf')).toThrow('encrypted pdf');
    await expect(processing.extractText('a.docx', Buffer.from('x'))).resolves.toBe('docx text');
    await expect(processing.extractText('notes.txt', Buffer.from('  纯文本  '))).resolves.toBe('纯文本');
    await expect(processing.extractText('data.csv', Buffer.from('a,b\n1,2\n'))).resolves.toBe('a\tb\n1\t2');
    await expect(processing.extractPagedText('book.epub', Buffer.from('x'))).resolves.toEqual(['chapter one', 'chapter two']);
    await expect(processing.extractPagedText('slides.pptx', Buffer.from('x'))).resolves.toBeNull();
  });

  let root: string;
  let storage: ReturnType<typeof createStorageService>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let db: DatabaseHandle;

  beforeEach(async () => {
    ({ root, storage } = await createVfsTestStorage('l11-attachment-processing-'));
    const image = fakeImage();
    host = await createTestHost({
      plugins: [plugin],
      provide: {
        storage,
        paths: pathsServiceDouble(),
        notes: notesServiceDouble(() => storage.database('vfs')),
        nativePdfium: fakePdfium({ text: 'pdf body text', pageCount: 2 }),
        nativeImage: image,
        nativeOfficeText: officeText,
        docs,
      },
    });
    db = storage.database('vfs');
  }, 120_000);

  afterEach(async () => {
    await host?.dispose();
    storage?.dispose();
    if (root) rmSync(root, { recursive: true, force: true });
  }, 120_000);

  it('uploads a PDF through the real plugin without synchronous rendering and sets page_rendering', async () => {
    const bytes = Buffer.from('%PDF-1.4\nfake body');
    const result = await host.ctx.vfsRepo.attachments.uploadBytesWithConn(
      db, storage.locations.activeDir + '/vfs_blobs',
      { name: 'paper.pdf', mimeType: 'application/pdf', base64Content: '' }, bytes);
    expect(result.isNew).toBe(true);
    expect(result.processingStatus).toBe('page_rendering');
    const row = db.get<{
      preview_json: string | null; extracted_text: string | null; page_count: number | null;
      processing_status: string | null;
    }>('SELECT preview_json, extracted_text, page_count, processing_status FROM files WHERE id = ?1',
      [result.sourceId]);
    expect(row?.processing_status).toBe('page_rendering');
    expect(row?.preview_json).toBeNull();
    expect(row?.extracted_text).toBeNull();
    expect(row?.page_count).toBeNull();
  });

  it('SOTA01 Bug 1: atomic upsert resolves sha256 collision without throwing notFound (including NULL content_hash and concurrent insert race)', async () => {
    const blobsDir = storage.locations.activeDir + '/vfs_blobs';
    const bytes = Buffer.from('%PDF-1.4\nattention-paper-bytes');
    const hash = host.ctx.vfsRepo.attachments.computeHash(bytes);

    // Case A: Pre-existing files row created via files.createFile (sha256 set, content_hash NULL).
    const preExisting = host.ctx.vfsRepo.files.createFile(
      db, hash, 'attention.pdf', bytes.length, 'file', 'application/pdf',
    );
    const deduped = await host.ctx.vfsRepo.attachments.uploadBytesWithConn(
      db, blobsDir, { name: 'attention.pdf', mimeType: 'application/pdf', base64Content: '' }, bytes,
    );
    expect(deduped.isNew).toBe(false);
    expect(deduped.sourceId).toBe(preExisting.id);
    expect(deduped.resourceHash).toBe(hash);
    expect(db.pluck('SELECT content_hash FROM files WHERE id = ?1', [preExisting.id])).toBe(hash);

    // Case B: Soft-deleted pre-existing row with NULL content_hash is restored on conflict.
    const deletedBytes = Buffer.from('%PDF-1.4\ndeleted-collision-bytes');
    const deletedHash = host.ctx.vfsRepo.attachments.computeHash(deletedBytes);
    const deletedFile = host.ctx.vfsRepo.files.createFile(
      db, deletedHash, 'old-name.pdf', deletedBytes.length, 'file', 'application/pdf',
    );
    host.ctx.vfsRepo.files.deleteFile(db, deletedFile.id);
    const restored = await host.ctx.vfsRepo.attachments.uploadBytesWithConn(
      db, blobsDir, { name: 'restored-name.pdf', mimeType: 'application/pdf', base64Content: '' }, deletedBytes,
    );
    expect(restored.isNew).toBe(false);
    expect(restored.sourceId).toBe(deletedFile.id);
    expect(db.pluck('SELECT deleted_at FROM files WHERE id = ?1', [deletedFile.id])).toBeNull();

    // Case C: Concurrent writer inserts row between initial getByHash (returns null) and INSERT.
    const raceBytes = Buffer.from('%PDF-1.4\nrace-writer-bytes');
    const firstUpload = await host.ctx.vfsRepo.attachments.uploadBytesWithConn(
      db, blobsDir, { name: 'race.pdf', mimeType: 'application/pdf', base64Content: '' }, raceBytes,
    );
    expect(firstUpload.isNew).toBe(true);
    const getByHashSpy = vi.spyOn(host.ctx.vfsRepo.attachments, 'getByHash');
    // Simulate stale snapshot returning null on prepareUpload + registerPrepared pre-check.
    getByHashSpy.mockReturnValueOnce(null).mockReturnValueOnce(null);
    try {
      const raced = await host.ctx.vfsRepo.attachments.uploadBytesWithConn(
        db, blobsDir, { name: 'race.pdf', mimeType: 'application/pdf', base64Content: '' }, raceBytes,
      );
      expect(raced.isNew).toBe(false);
      expect(raced.sourceId).toBe(firstUpload.sourceId);
    } finally {
      getByHashSpy.mockRestore();
    }
  });

  it('repairs an existing PDF row with page_count=0 and no text', async () => {
    const bytes = Buffer.from('%PDF-1.4\nrepairable body');
    const blobsDir = storage.locations.activeDir + '/vfs_blobs';
    const params = { name: 'repair.pdf', mimeType: 'application/pdf', base64Content: '' };
    const first = await host.ctx.vfsRepo.attachments.uploadBytesWithConn(db, blobsDir, params, bytes);
    db.run('UPDATE files SET page_count = 0, extracted_text = NULL, preview_json = NULL WHERE id = ?1',
      [first.sourceId]);

    const second = await host.ctx.vfsRepo.attachments.uploadBytesWithConn(db, blobsDir, params, bytes);

    expect(second.isNew).toBe(false);
    const row = db.get<{ page_count: number; extracted_text: string | null; preview_json: string | null }>(
      'SELECT page_count, extracted_text, preview_json FROM files WHERE id = ?1', [first.sourceId]);
    expect(row?.page_count).toBe(2);
    expect(row?.extracted_text).toBe('pdf body text');
    expect(row?.preview_json).not.toBeNull();
  });

  // pdf_preview.rs:82-225 render_pdf_preview_with_progress: textbooks.rs:447-470 consumes
  // `(page_index + 1, render_pages)` before each page through VfsReposService.attachmentProcessing.
  it('renderPdf reports Rust per-page progress through the published service and defaults config', async () => {
    const blobsDir = storage.locations.activeDir + '/vfs_blobs';
    const calls: Array<[number, number]> = [];
    const result = await host.ctx.vfsRepo.attachmentProcessing.renderPdf(
      db, blobsDir, Buffer.from('%PDF-1.4\nprogress body'), undefined,
      (currentPage, totalPages) => { calls.push([currentPage, totalPages]); });
    expect(calls).toEqual([[1, 2], [2, 2]]);
    expect(result.pageCount).toBe(2);
    expect(result.previewJson?.pages).toHaveLength(2);
    expect(result.previewJson?.maxRenderedPages).toBe(DEFAULT_PDF_PREVIEW_CONFIG.maxPages);

    // max_pages clamp: render_pages = min(total, max_pages) is the reported total.
    const clamped: Array<[number, number]> = [];
    await host.ctx.vfsRepo.attachmentProcessing.renderPdf(
      db, blobsDir, Buffer.from('%PDF-1.4\nclamped body'), { ...DEFAULT_PDF_PREVIEW_CONFIG, maxPages: 1 },
      (currentPage, totalPages) => { clamped.push([currentPage, totalPages]); });
    expect(clamped).toEqual([[1, 1]]);

    // Non-PDF bytes fail before rendering; the callback is never invoked.
    const none: Array<[number, number]> = [];
    await expect(host.ctx.vfsRepo.attachmentProcessing.renderPdf(
      db, blobsDir, Buffer.from('not a pdf'), undefined, (a, b) => { none.push([a, b]); }))
      .rejects.toThrow('不是有效的 PDF 文档（缺少 PDF 文件头）');
    expect(none).toEqual([]);
  });

  it('rejects an encrypted PDF before the file row is created', async () => {
    await expect(host.ctx.vfsRepo.attachments.uploadBytesWithConn(
      db, storage.locations.activeDir + '/vfs_blobs',
      { name: 'encrypted.pdf', mimeType: 'application/pdf', base64Content: '' },
      Buffer.from('%PDF-1.4 /Encrypt')))
      .rejects.toThrow('encrypted pdf');
    expect(db.pluck('SELECT COUNT(*) FROM files WHERE file_name = ?1', ['encrypted.pdf'])).toBe(0);
  });
});


