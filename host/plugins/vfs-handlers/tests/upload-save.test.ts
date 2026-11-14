/** Prepared upload core, not a TESTMAP destination or proof of command registration. */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVfsHost, type VfsHost } from './harness.ts';
import { loadOcrStrategy, pdfPreviewNeedsCompression, saveUploadedFile, UploadSaga } from '../src/upload-file.ts';
import { withUploadSavepoint } from '../repository/upload-savepoint.ts';

let vfs: VfsHost;
beforeEach(async () => { vfs = await createVfsHost(); }, 120_000);
afterEach(async () => { await vfs?.dispose(); }, 120_000);
const db = () => vfs.storage.database('vfs');
const repos = () => vfs.host.ctx.vfsRepo;
const blobsDir = () => vfs.host.ctx.vfsDatabase.blobsDir();
const deps = () => ({ files: repos().files, blobs: repos().blobs, log: vfs.host.ctx.logger });
const saga = () => new UploadSaga(deps());
function blobFileExists(hash: string): boolean {
  const dir = join(blobsDir(), hash.slice(0, 2));
  return existsSync(dir) && readdirSync(dir).some(name => name.startsWith(hash) && !name.endsWith('.tmp'));
}
function input(content = Buffer.from('upload core image')) {
  const folderId = 'fld_upload_core';
  if (!repos().folders.folderExists(db(), folderId)) repos().folders.createFolder(db(), {
    id: folderId, title: 'Uploads', isExpanded: true, isFavorite: false, sortOrder: 0, createdAt: 1, updatedAt: 1,
  });
  return { params: { name: 'image.png', mimeType: 'image/png', base64Content: content.toString('base64') },
    content, sha256: createHash('sha256').update(content).digest('hex'), fileType: 'image', targetFolderId: folderId,
    previewJson: null, extractedText: null, pageCount: null };
}

describe('prepared handlers.rs upload save/compensation with real F3/L11', { timeout: 120_000 }, () => {
  it('commits the main blob and resources/files/folder_items on the same connection', () => {
    const data = input();
    const ledger = saga();
    const result = saveUploadedFile(deps(), db(), blobsDir(), data, ledger);
    expect(result.created).toBe(true);
    expect(result.file).toMatchObject({ blobHash: data.sha256, sha256: data.sha256, fileType: 'image', status: 'active' });
    expect(repos().blobs.getBlob(db(), data.sha256)!.refCount).toBe(1);
    expect(db().pluck('SELECT COUNT(*) FROM resources WHERE hash=?1', [data.sha256])).toBe(1);
    expect(db().pluck('SELECT folder_id FROM folder_items WHERE item_id=?1', [result.file.id])).toBe(data.targetFolderId);
    ledger.abort(db(), blobsDir());
    expect(repos().blobs.getBlob(db(), data.sha256)!.refCount).toBe(1);
    expect(blobFileExists(data.sha256)).toBe(true);
  });

  it('test_failure_after_blob_rolls_back_row_and_cleans_file', () => {
    const data = input();
    db().exec("CREATE TRIGGER upload_fail_before_file BEFORE INSERT ON files BEGIN SELECT RAISE(ABORT, 'injected failure after blob'); END");
    expect(() => saveUploadedFile(deps(), db(), blobsDir(), data, saga())).toThrow('injected failure after blob');
    expect(repos().blobs.getBlob(db(), data.sha256)).toBeNull();
    expect(blobFileExists(data.sha256)).toBe(false);
    expect(db().pluck('SELECT COUNT(*) FROM resources WHERE hash=?1', [data.sha256])).toBe(0);
    expect(db().pluck('SELECT COUNT(*) FROM files WHERE sha256=?1', [data.sha256])).toBe(0);
    expect(db().pluck('SELECT COUNT(*) FROM folder_items')).toBe(0);
  });

  it('test_failure_after_dedup_blob_keeps_shared_blob', () => {
    const data = input();
    const existing = repos().blobs.storeBlob(db(), blobsDir(), data.content, 'image/png');
    expect(existing.refCount).toBe(1);
    db().exec("CREATE TRIGGER upload_fail_shared BEFORE INSERT ON files BEGIN SELECT RAISE(ABORT, 'injected shared failure'); END");
    expect(() => saveUploadedFile(deps(), db(), blobsDir(), data, saga())).toThrow('injected shared failure');
    expect(repos().blobs.getBlob(db(), existing.hash)!.refCount).toBe(1);
    expect(blobFileExists(existing.hash)).toBe(true);
    expect(db().pluck('SELECT COUNT(*) FROM resources')).toBe(0);
    expect(db().pluck('SELECT COUNT(*) FROM files')).toBe(0);
  });

  it('test_failure_after_file_row_rolls_back_everything, including precommitted preview references', () => {
    const data = input();
    const preview = repos().blobs.storeBlob(db(), blobsDir(), Buffer.from('preview only'), 'image/jpeg');
    const ledger = saga();
    ledger.recordBlobRef(preview.hash);
    db().exec("CREATE TRIGGER upload_fail_folder AFTER INSERT ON folder_items BEGIN SELECT RAISE(ABORT, 'injected failure after file row'); END");
    expect(() => saveUploadedFile(deps(), db(), blobsDir(), data, ledger)).toThrow('injected failure after file row');
    expect(db().pluck('SELECT COUNT(*) FROM files WHERE sha256=?1', [data.sha256])).toBe(0);
    expect(db().pluck('SELECT COUNT(*) FROM resources WHERE hash=?1', [data.sha256])).toBe(0);
    expect(db().pluck('SELECT COUNT(*) FROM folder_items')).toBe(0);
    expect(repos().blobs.getBlob(db(), data.sha256)).toBeNull();
    expect(blobFileExists(data.sha256)).toBe(false);
    expect(repos().blobs.getBlob(db(), preview.hash)).toBeNull();
    expect(blobFileExists(preview.hash)).toBe(false);
    ledger.abort(db(), blobsDir()); // Empty ledger: repeated abort is a no-op.
    expect(db().pluck('SELECT COUNT(*) FROM blobs')).toBe(0);
  });

  it('retains upload_saga.rs release/rollback error context when SQLite has already rolled back the transaction', () => {
    // SQLite RAISE(ROLLBACK) / transaction abort removes the SAVEPOINT as well.
    expect(() => withUploadSavepoint(db(), deps().log, () => {
      db().exec('ROLLBACK');
      return 1;
    })).toThrow('Database error: Failed to release savepoint vfs_upload_file_saga:');
    expect(() => withUploadSavepoint(db(), deps().log, () => {
      db().exec('ROLLBACK');
      throw new Error('original upload failure');
    })).toThrow('Database error: original upload failure; savepoint vfs_upload_file_saga rollback failed:');
    expect(db().pluck('SELECT COUNT(*) FROM files')).toBe(0);
  });

  it('compensates the main blob +1 and previews on the concurrent dedup outcome without deleting shared data', () => {
    const data = input();
    const first = saveUploadedFile(deps(), db(), blobsDir(), data, saga());
    const page = repos().blobs.storeBlob(db(), blobsDir(), Buffer.from('discarded preview'), 'image/jpeg');
    const ledger = saga();
    ledger.recordPreviewBlobs({ pages: [{ pageIndex: 0, blobHash: page.hash, compressedBlobHash: page.hash,
      width: 1, height: 1, mimeType: 'image/jpeg' }], renderDpi: 150, totalPages: 1, renderedAt: '2026-01-01T00:00:00Z' });
    const second = saveUploadedFile(deps(), db(), blobsDir(), data, ledger);
    expect(second.created).toBe(false);
    expect(second.file.id).toBe(first.file.id);
    expect(db().pluck('SELECT COUNT(*) FROM files')).toBe(1);
    expect(db().pluck('SELECT COUNT(*) FROM resources')).toBe(1);
    expect(repos().blobs.getBlob(db(), data.sha256)!.refCount).toBe(1);
    expect(blobFileExists(data.sha256)).toBe(true);
    expect(repos().blobs.getBlob(db(), page.hash)).toBeNull();
    expect(blobFileExists(page.hash)).toBe(false);
  });

  it('keeps bytes for small non-image uploads and the 1 MiB main-blob threshold', () => {
    const small = { ...input(Buffer.from('small document')), params: { name: 'small.txt', mimeType: 'text/plain', base64Content: '' }, fileType: 'document' };
    const smallResult = saveUploadedFile(deps(), db(), blobsDir(), small, saga());
    // Small files used to write an inline ('inline', '') row and lose their
    // bytes; they now keep a real blob (with a usable extension).
    expect(smallResult.file.blobHash).toBe(small.sha256);
    expect(repos().blobs.getBlob(db(), small.sha256)!.refCount).toBe(1);
    expect(blobFileExists(small.sha256)).toBe(true);
    expect(repos().blobs.getBlob(db(), small.sha256)!.relativePath.endsWith('.txt')).toBe(true);
    const large = { ...input(Buffer.alloc(1024 * 1024, 65)), params: { name: 'large.bin', mimeType: 'application/octet-stream', base64Content: '' }, fileType: 'document' };
    const largeResult = saveUploadedFile(deps(), db(), blobsDir(), large, saga());
    expect(largeResult.file.blobHash).toBe(large.sha256);
    expect(repos().blobs.getBlob(db(), large.sha256)!.refCount).toBe(1);
    expect(blobFileExists(large.sha256)).toBe(true);
  });

  it('loads OCR usize settings without truncating large valid values and ignores invalid/overflow values', () => {
    const settings = vfs.host.ctx.settings;
    expect(loadOcrStrategy(settings).pdfTextThreshold).toBe(100n);
    settings.save('ocr.pdf_text_threshold', '18446744073709551615');
    expect(loadOcrStrategy(settings).pdfTextThreshold).toBe(0xffff_ffff_ffff_ffffn);
    for (const invalid of ['18446744073709551616', ' 1', '1 ', '1\n', '-1', '1.0', '']) {
      settings.save('ocr.pdf_text_threshold', invalid);
      expect(loadOcrStrategy(settings).pdfTextThreshold).toBe(100n);
    }
    settings.save('ocr.pdf_text_threshold', '+0');
    settings.save('ocr.enabled', 'TRUE');
    settings.save('ocr.images', ' true ');
    expect(loadOcrStrategy(settings)).toMatchObject({ pdfTextThreshold: 0n, enabled: true, ocrImages: false });
  });

  it('only treats serde-valid PDF previews with uncompressed pages as needing compression', () => {
    const page = { pageIndex: 0, blobHash: 'abc', width: 1, height: 1, mimeType: 'image/jpeg' };
    const preview = { pages: [page], renderDpi: 150, totalPages: 1, renderedAt: '2026-01-01T00:00:00Z' };
    expect(pdfPreviewNeedsCompression(JSON.stringify(preview))).toBe(true);
    expect(pdfPreviewNeedsCompression(JSON.stringify({ ...preview, pages: [{ ...page, compressedBlobHash: 'ready' }] }))).toBe(false);
    expect(pdfPreviewNeedsCompression(JSON.stringify({ ...preview, pages: [] }))).toBe(false);
    expect(pdfPreviewNeedsCompression('{"pages":[{}]}')).toBe(false);
    expect(pdfPreviewNeedsCompression('{bad json')).toBe(false);
  });
});
