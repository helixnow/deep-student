import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHost } from '../../../kernel/testing.ts';
import { notesServiceDouble } from './support/notes-service.ts';
import { pathsServiceDouble } from './support/paths-service.ts';
import { createVfsTestStorage } from './support/vfs-test-storage.ts';
import type { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { Message } from '@deepseek-ai/cordis';
import plugin from '../index.ts';

let root: string;
let blobsDir: string;
let storage: ReturnType<typeof createStorageService>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let db: DatabaseHandle;
beforeEach(async () => {
  ({ root, storage } = await createVfsTestStorage('l11-textbook-'));
  host = await createTestHost({ plugins: [plugin], provide: { storage, paths: pathsServiceDouble(), 'notes': notesServiceDouble(() => storage.database('vfs')) } });
  db = storage.database('vfs');
  blobsDir = join(storage.locations.activeDir, 'vfs_blobs');
}, 120_000);
afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);
const textbooks = () => host.ctx.vfsRepo.textbooks;
const blobs = () => host.ctx.vfsRepo.blobs;

function blobRefCount(hash: string): number | null {
  return db.pluck<number>('SELECT ref_count FROM blobs WHERE hash = ?1', [hash]) ?? null;
}

function createTextbookWithBlobs() {
  const main = blobs().storeBlob(db, blobsDir, Buffer.from('main-pdf-bytes'), 'application/pdf', 'pdf');
  const page = blobs().storeBlob(db, blobsDir, Buffer.from('page-image-bytes'), 'image/jpeg', 'jpg');
  const compressed = blobs().storeBlob(db, blobsDir, Buffer.from('compressed-page-bytes'), 'image/jpeg', 'jpg');
  const preview = {
    pages: [{
      pageIndex: 0,
      blobHash: page.hash,
      width: 100,
      height: 100,
      mimeType: 'image/jpeg',
      compressedBlobHash: compressed.hash,
    }],
    renderDpi: 150,
    totalPages: 1,
    renderedAt: '2026-06-12T00:00:00Z',
  };
  const textbook = textbooks().createTextbookWithPreview(db, 'sha-copy-test', 'copy-test.pdf',
    1024, main.hash, null, JSON.stringify(preview), 'extracted text', 1);
  return { textbook, mainHash: main.hash, pageHash: page.hash, compressedHash: compressed.hash };
}

describe('textbook_repo.rs', { timeout: 120_000 }, () => {
  it('test_create_textbook', () => {
    const textbook = textbooks().createTextbook(db, 'sha256_hash_123', '数学教材.pdf',
      1024000, null, '/path/to/file.pdf');
    expect(textbook.id.length).toBeGreaterThan(0);
    expect(textbook.fileName).toBe('数学教材.pdf');
    expect(textbook.sha256).toBe('sha256_hash_123');
    expect(textbook.status).toBe('active');
  });

  it('test_textbook_dedup_by_sha256', () => {
    const first = textbooks().createTextbook(db, 'sha256_same', '教材1.pdf', 1024, null, null);
    const second = textbooks().createTextbook(db, 'sha256_same', '教材2.pdf', 2048, null, null);
    expect(second.id).toBe(first.id);
  });

  it('test_update_reading_progress', () => {
    const textbook = textbooks().createTextbook(db, 'sha256_123', '教材.pdf', 1024, null, null);
    textbooks().updateReadingProgress(db, textbook.id, 42);
    const updated = textbooks().getTextbook(db, textbook.id)!;
    expect(updated.lastPage).toBe(42);
    expect(updated.lastOpenedAt).toBeDefined();
  });

  it('test_list_textbooks', () => {
    textbooks().createTextbook(db, 'sha1', '教材1.pdf', 1024, null, null);
    textbooks().createTextbook(db, 'sha2', '教材2.pdf', 1024, null, null);
    textbooks().createTextbook(db, 'sha3', '教材3.pdf', 1024, null, null);
    expect(textbooks().listTextbooks(db, 10, 0)).toHaveLength(3);
  });

  it('test_copy_textbook_shares_blobs_and_survives_source_purge', () => {
    const { textbook: src, mainHash, pageHash, compressedHash } = createTextbookWithBlobs();
    const copy = textbooks().copyTextbook(db, src.id, 'copy-test (副本).pdf');
    expect(copy.id).not.toBe(src.id);
    expect(copy.blobHash).toBe(mainHash);

    expect(blobRefCount(mainHash)).toBe(2);
    expect(blobRefCount(pageHash)).toBe(2);
    expect(blobRefCount(compressedHash)).toBe(2);

    const copyPreview = db.pluck<string | null>(
      'SELECT preview_json FROM files WHERE id = ?1', [copy.id]);
    expect(copyPreview ?? '').toContain(pageHash);

    textbooks().purgeTextbook(db, blobsDir, src.id);
    expect(blobRefCount(mainHash)).toBe(1);
    expect(blobRefCount(pageHash)).toBe(1);
    expect(blobRefCount(compressedHash)).toBe(1);

    textbooks().purgeTextbook(db, blobsDir, copy.id);
    for (const hash of [mainHash, pageHash, compressedHash]) {
      const refCount = blobRefCount(hash);
      expect(refCount === null || refCount === 0).toBe(true);
    }
  });

  it('test_purge_textbook_decrements_compressed_blob_refs', () => {
    const { textbook, mainHash, pageHash, compressedHash } = createTextbookWithBlobs();
    const fileCompressed = blobs().storeBlob(db, blobsDir, Buffer.from('file-level-compressed'),
      'image/jpeg', 'jpg');
    db.run('UPDATE files SET compressed_blob_hash = ?1 WHERE id = ?2',
      [fileCompressed.hash, textbook.id]);

    textbooks().purgeTextbook(db, blobsDir, textbook.id);

    for (const [label, hash] of [
      ['main', mainHash], ['page', pageHash],
      ['page-compressed', compressedHash], ['file-compressed', fileCompressed.hash],
    ] as const) {
      const refCount = blobRefCount(hash);
      expect(refCount === null || refCount === 0, `${label} blob must be dereferenced`).toBe(true);
    }
  });

  // X6-LP-0295: textbook_repo.rs:1229 `error!("Purge failed, rolled back")` after the savepoint rollback.
  it('purge_textbook logs the rolled-back failure at error level', () => {
    const logs: Message[] = [];
    host.ctx.logger.exporter({ levels: { default: 4 }, export: message => void logs.push(message) });
    expect(() => textbooks().purgeTextbookWithConn(db, 'file_missing_textbook', blobsDir))
      .toThrow('Textbook not found: file_missing_textbook');
    const errors = logs.filter(message => message.type === 'error')
      .map(message => message.args.map(arg => String(arg)).join(' '));
    expect(errors.some(text => text.includes('[VFS::TextbookRepo] Purge failed, rolled back:')
      && text.includes('Textbook not found: file_missing_textbook'))).toBe(true);
  });

  // C1 U2/U4: cmd/textbooks.rs:747-754 textbooks_relink write (no transaction, 0 rows unchecked).
  it('setOriginalPathWithConn updates only original_path and updated_at', () => {
    const textbook = textbooks().createTextbook(db, 'sha_relink', '重连.pdf', 10, null, '/old/path.pdf');
    const before = db.get<Record<string, unknown>>('SELECT * FROM files WHERE id = ?1', [textbook.id])!;
    expect(textbooks().setOriginalPathWithConn(db, textbook.id, '/new/path.pdf')).toBe(1);
    const after = db.get<Record<string, unknown>>('SELECT * FROM files WHERE id = ?1', [textbook.id])!;
    expect(after.original_path).toBe('/new/path.pdf');
    expect(after.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect({ ...after, original_path: before.original_path, updated_at: before.updated_at }).toEqual(before);
    expect(textbooks().setOriginalPathWithConn(db, 'file_missing', '/x.pdf')).toBe(0);
  });

  // cmd/textbooks.rs:631-641 textbooks_add pptx/epub page text: only ocr_pages_json, updated_at untouched.
  it('updateTextbookOcrPagesJson writes only ocr_pages_json on the caller connection', () => {
    const textbook = textbooks().createTextbook(db, 'sha_ocr_pages', '讲义.pptx', 10, null, null);
    db.run("UPDATE files SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1", [textbook.id]);
    const before = db.get<Record<string, unknown>>('SELECT * FROM files WHERE id = ?1', [textbook.id])!;
    const pages = JSON.stringify(['第一页', null, '第三页']);
    textbooks().updateTextbookOcrPagesJson(db, textbook.id, pages);
    const after = db.get<Record<string, unknown>>('SELECT * FROM files WHERE id = ?1', [textbook.id])!;
    expect(after).toEqual({ ...before, ocr_pages_json: pages });
    // Rust ignores rows_affected: a missing id is a silent no-op.
    expect(() => textbooks().updateTextbookOcrPagesJson(db, 'file_missing', pages)).not.toThrow();
    // Same connection: outer rollback undoes it (no own transaction/commit).
    expect(() => db.transaction(conn => {
      textbooks().updateTextbookOcrPagesJson(conn, textbook.id, '["tmp"]');
      throw new Error('rollback ocr fixture');
    })).toThrow('rollback ocr fixture');
    expect(db.pluck('SELECT ocr_pages_json FROM files WHERE id = ?1', [textbook.id])).toBe(pages);
  });

  // cmd/textbooks.rs:644-654 textbooks_add render failure: processing_status/error only.
  it('markTextbookRenderError sets error status and reason without other columns', () => {
    const textbook = textbooks().createTextbook(db, 'sha_render_err', '坏.pdf', 10, null, null);
    db.run("UPDATE files SET updated_at = '2000-01-01T00:00:00.000Z', processing_status = 'pending' WHERE id = ?1",
      [textbook.id]);
    const before = db.get<Record<string, unknown>>('SELECT * FROM files WHERE id = ?1', [textbook.id])!;
    textbooks().markTextbookRenderError(db, textbook.id, 'PDF 预渲染失败：2 页全部渲染失败');
    const after = db.get<Record<string, unknown>>('SELECT * FROM files WHERE id = ?1', [textbook.id])!;
    expect(after).toEqual({
      ...before, processing_status: 'error', processing_error: 'PDF 预渲染失败：2 页全部渲染失败',
    });
    expect(after.processing_completed_at).toBe(before.processing_completed_at);
    expect(() => textbooks().markTextbookRenderError(db, 'file_missing', 'x')).not.toThrow();
  });
});
