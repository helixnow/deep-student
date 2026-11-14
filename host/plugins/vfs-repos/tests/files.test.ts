import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHost } from '../../../kernel/testing.ts';
import { notesServiceDouble } from './support/notes-service.ts';
import { pathsServiceDouble } from './support/paths-service.ts';
import { createVfsTestStorage } from './support/vfs-test-storage.ts';
import type { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import plugin from '../index.ts';

let root: string;
let blobsDir: string;
let storage: ReturnType<typeof createStorageService>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let db: DatabaseHandle;
beforeEach(async () => {
  ({ root, storage } = await createVfsTestStorage('l11-file-'));
  host = await createTestHost({ plugins: [plugin], provide: { storage, paths: pathsServiceDouble(), 'notes': notesServiceDouble(() => storage.database('vfs')) } });
  db = storage.database('vfs');
  blobsDir = join(storage.locations.activeDir, 'vfs_blobs');
}, 120_000);
afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);
const files = () => host.ctx.vfsRepo.files;
const blobs = () => host.ctx.vfsRepo.blobs;

function blobRef(hash: string): number | null {
  return db.pluck<number>('SELECT ref_count FROM blobs WHERE hash = ?1', [hash]) ?? null;
}

describe('file_repo.rs', { timeout: 120_000 }, () => {
  it('test_create_file', () => {
    const file = files().createFile(db, 'sha256_hash_123', 'document.pdf', 1024000, 'document',
      'application/pdf', null, '/path/to/file.pdf');
    expect(file.id.length).toBeGreaterThan(0);
    expect(file.id.startsWith('file_')).toBe(true);
    expect(file.fileName).toBe('document.pdf');
    expect(file.sha256).toBe('sha256_hash_123');
    expect(file.fileType).toBe('document');
    expect(file.status).toBe('active');
  });

  it('test_file_dedup_by_sha256', () => {
    const file1 = files().createFile(db, 'sha256_same', 'file1.pdf', 1024, 'document', null, null, null);
    const file2 = files().createFile(db, 'sha256_same', 'file2.pdf', 2048, 'document', null, null, null);
    expect(file1.id).toBe(file2.id);
  });

  it('test_list_files', () => {
    files().createFile(db, 'sha1', 'file1.pdf', 1024, 'document', null, null, null);
    files().createFile(db, 'sha2', 'image.png', 1024, 'image', 'image/png', null, null);
    files().createFile(db, 'sha3', 'audio.mp3', 1024, 'audio', 'audio/mpeg', null, null);
    expect(files().listFiles(db, 10, 0)).toHaveLength(3);
  });

  it('test_list_files_by_type', () => {
    files().createFile(db, 'sha1', 'doc1.pdf', 1024, 'document', null, null, null);
    files().createFile(db, 'sha2', 'doc2.pdf', 1024, 'document', null, null, null);
    files().createFile(db, 'sha3', 'image.png', 1024, 'image', 'image/png', null, null);
    expect(files().listFilesByType(db, 'document', 10, 0)).toHaveLength(2);
    expect(files().listFilesByType(db, 'image', 10, 0)).toHaveLength(1);
  });

  it('test_soft_delete_and_restore', () => {
    const file = files().createFile(db, 'sha256_123', 'test.pdf', 1024, 'document', null, null, null);
    files().deleteFile(db, file.id);
    const deleted = files().getFile(db, file.id);
    expect(deleted).not.toBeNull();
    expect(deleted!.status).toBe('deleted');
    files().restoreFile(db, file.id);
    const restored = files().getFile(db, file.id);
    expect(restored).not.toBeNull();
    expect(restored!.status).toBe('active');
  });

  it('test_copy_file_shares_blobs_and_survives_source_purge', () => {
    const mainBlob = blobs().storeBlob(db, blobsDir, Buffer.from('copy-file-main'), 'application/pdf', 'pdf');
    const compressedBlob = blobs().storeBlob(db, blobsDir, Buffer.from('copy-file-compressed'), 'image/webp', 'webp');
    const pageBlob = blobs().storeBlob(db, blobsDir, Buffer.from('copy-file-page'), 'image/jpeg', 'jpg');
    const pageCompressed = blobs().storeBlob(db, blobsDir, Buffer.from('copy-file-page-c'), 'image/webp', 'webp');

    const src = files().createFile(db, 'sha_copy_src', 'source.pdf', 4096, 'document',
      'application/pdf', mainBlob.hash, null);
    const previewJson = JSON.stringify({
      pages: [{
        pageIndex: 0,
        blobHash: pageBlob.hash,
        width: 100,
        height: 100,
        mimeType: 'image/jpeg',
        compressedBlobHash: pageCompressed.hash,
      }],
      renderDpi: 144,
      totalPages: 1,
      renderedAt: '2026-06-12T00:00:00Z',
    });
    db.run(`UPDATE files SET preview_json = ?1, compressed_blob_hash = ?2,
        extracted_text = 'hello text', ocr_pages_json = '[]' WHERE id = ?3`,
    [previewJson, compressedBlob.hash, src.id]);

    const copy = files().copyFile(db, src.id, 'source (副本).pdf');
    expect(copy.id).not.toBe(src.id);
    expect(copy.sha256).not.toBe(src.sha256);
    expect(copy.blobHash).toBe(mainBlob.hash);
    expect(copy.compressedBlobHash).toBe(compressedBlob.hash);
    expect(copy.extractedText).toBe('hello text');
    expect(copy.previewJson ?? '').toContain(pageBlob.hash);
    for (const [label, hash] of [
      ['main', mainBlob.hash], ['compressed', compressedBlob.hash],
      ['page', pageBlob.hash], ['page_compressed', pageCompressed.hash],
    ] as const) {
      expect(blobRef(hash), `${label} blob ref after copy`).toBe(2);
    }

    files().purgeFile(db, blobsDir, src.id);
    expect(files().getFile(db, copy.id)).not.toBeNull();
    for (const [label, hash] of [
      ['main', mainBlob.hash], ['compressed', compressedBlob.hash],
      ['page', pageBlob.hash], ['page_compressed', pageCompressed.hash],
    ] as const) {
      expect(blobRef(hash), `${label} blob ref after source purge`).toBe(1);
    }

    files().purgeFile(db, blobsDir, copy.id);
    for (const [label, hash] of [
      ['main', mainBlob.hash], ['compressed', compressedBlob.hash],
      ['page', pageBlob.hash], ['page_compressed', pageCompressed.hash],
    ] as const) {
      const ref = blobRef(hash);
      expect(ref === null || ref === 0, `${label} blob ref after copy purge, got ${ref}`).toBe(true);
    }
  });

  // L03 context_compiler.rs:634-639: id match wins over resource_id match; deleted rows are not filtered.
  it('getBlobHashByFileOrResourceId resolves by id first, then resource_id', () => {
    const a = files().createFile(db, 'sha_lookup_a', 'a.png', 1, 'image', 'image/png', null);
    const blobA = blobs().storeBlob(db, blobsDir, Buffer.from('lookup-a'), 'image/png', 'png');
    const blobB = blobs().storeBlob(db, blobsDir, Buffer.from('lookup-b'), 'image/png', 'png');
    db.run('UPDATE files SET blob_hash = ?1 WHERE id = ?2', [blobA.hash, a.id]);
    const b = files().createFile(db, 'sha_lookup_b', 'b.png', 1, 'image', 'image/png', blobB.hash);
    expect(files().getBlobHashByFileOrResourceId(db, b.resourceId!)).toBe(blobB.hash);

    // A resource whose id collides with file a's id: the id match must still win.
    db.run(`INSERT INTO resources (id, hash, type, storage_mode, data, ref_count, created_at, updated_at)
      VALUES (?1, 'hash_collide', 'file', 'inline', '', 0, 0, 0)`, [a.id]);
    db.run('UPDATE files SET resource_id = ?1 WHERE id = ?2', [a.id, b.id]);
    expect(files().getBlobHashByFileOrResourceId(db, a.id)).toBe(blobA.hash);

    files().deleteFile(db, b.id);
    expect(files().getBlobHashByFileOrResourceId(db, b.id)).toBe(blobB.hash);
    db.run('UPDATE files SET blob_hash = NULL WHERE id = ?1', [b.id]);
    expect(files().getBlobHashByFileOrResourceId(db, b.id)).toBeNull();
    expect(files().getBlobHashByFileOrResourceId(db, 'missing')).toBeNull();
  });
});

// dstu-qbank question_import_service.rs:3758-3812 ensure_vfs_file_for_blob (L14 resume_question_import).
describe('ensure_vfs_file_for_blob owner write', { timeout: 120_000 }, () => {
  const FILE_ID = /^file_[A-Za-z0-9_-]{12}$/;

  it('returns the first live files row for the blob hash and skips soft-deleted rows', () => {
    const blob = blobs().storeBlob(db, blobsDir, Buffer.from('question-image'), 'image/png', 'png');
    const live = files().createFile(db, 'sha_ensure_live', 'q.png', 10, 'image', 'image/png', blob.hash, null);
    expect(files().ensureFileForBlobWithConn(db, blob.hash, 'other.png', 'image/png')).toBe(live.id);

    db.run("UPDATE files SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1", [live.id]);
    const created = files().ensureFileForBlobWithConn(db, blob.hash, 'other.png', 'image/png');
    expect(created).toMatch(FILE_ID);
    expect(created).not.toBe(live.id);
  });

  it('RF-W10-ensure-file-for-blob-sha256: the row is written with sha256 = blob hash, so the returned id resolves and later calls dedupe', () => {
    const blob = blobs().storeBlob(db, blobsDir, Buffer.from('orphan-question-image'), 'image/png', 'png');
    const id = files().ensureFileForBlobWithConn(db, blob.hash, '题图.png', 'image/png');
    expect(id).toMatch(FILE_ID);
    // Rust omits sha256 (NOT NULL UNIQUE); OR IGNORE swallowed that violation, left no row and minted a new id per call.
    expect(db.get('SELECT sha256, blob_hash, file_name, size, "type", mime_type, status, deleted_at FROM files WHERE id = ?1', [id])).toEqual({
      sha256: blob.hash, blob_hash: blob.hash, file_name: '题图.png', size: 0, type: 'image', mime_type: 'image/png',
      status: 'active', deleted_at: null,
    });
    expect(files().ensureFileForBlobWithConn(db, blob.hash, '题图.png', 'image/png')).toBe(id);
  });

  it('RF-W10-ensure-file-for-blob-sha256: same content held by a soft-deleted row is restored instead of dangling', () => {
    const blob = blobs().storeBlob(db, blobsDir, Buffer.from('deleted-question-image'), 'image/png', 'png');
    const old = files().createFile(db, blob.hash, 'old.png', 10, 'image', 'image/png', blob.hash, null);
    db.run("UPDATE files SET status = 'deleted', deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1", [old.id]);
    expect(files().ensureFileForBlobWithConn(db, blob.hash, 'new.png', 'image/png')).toBe(old.id);
    expect(db.get('SELECT status, deleted_at FROM files WHERE id = ?1', [old.id])).toEqual({ status: 'active', deleted_at: null });
  });

  it('binds the Rust INSERT OR IGNORE column set and timestamp params', () => {
    const calls: Array<{ sql: string; params: unknown }> = [];
    const conn = {
      get: db.get.bind(db), one: db.one.bind(db), all: db.all.bind(db), iterate: db.iterate.bind(db),
      exec: db.exec.bind(db), pluck: db.pluck.bind(db),
      run: (sql: string, params?: unknown) => { calls.push({ sql, params }); return { changes: 1, lastInsertRowid: 0 }; },
    } as unknown as Parameters<ReturnType<typeof files>['ensureFileForBlobWithConn']>[0];
    const id = files().ensureFileForBlobWithConn(conn, 'blob_cols', 'a.jpg', 'image/jpeg');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain(`INSERT OR IGNORE INTO files (id, sha256, blob_hash, file_name, original_path, size, "type", mime_type, tags_json, is_favorite, status, created_at, updated_at)`);
    expect(calls[0]!.sql).toContain(`VALUES (?1, ?2, ?2, ?3, '', 0, 'image', ?4, '[]', 0, 'active', ?5, ?6)`);
    const params = calls[0]!.params as string[];
    expect(params.slice(0, 4)).toEqual([id, 'blob_cols', 'a.jpg', 'image/jpeg']);
    expect(params[4]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(params[5]).toBe(params[4]);
  });

  it('treats a lookup SQL error as a miss and propagates insert errors unwrapped', () => {
    const insertError = new Error('database is locked');
    const conn = {
      pluck: () => { throw new Error('no such table: files'); },
      run: () => { throw insertError; },
    } as unknown as Parameters<ReturnType<typeof files>['ensureFileForBlobWithConn']>[0];
    let thrown: unknown;
    try { files().ensureFileForBlobWithConn(conn, 'blob_err', 'x.png', 'image/png'); }
    catch (error) { thrown = error; }
    expect(thrown).toBe(insertError);
  });
});

describe('RF-W10-blob-path-containment', { timeout: 120_000 }, () => {
  const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');
  const seedFile = (id: string, hash: string, originalPath: string, blobHash: string | null = null) => db.run(
    `INSERT INTO files (id, sha256, blob_hash, file_name, original_path, size, type, mime_type, tags_json, status,
                        created_at, updated_at)
     VALUES (?1, ?2, ?3, 'book.pdf', ?4, 6, 'document', 'application/pdf', '[]', 'active', ?5, ?5)`,
    [id, hash, blobHash, originalPath, '2026-01-01T00:00:00.000Z']);

  it('getContent does not read a blob whose relative_path leaves vfs_blobs', () => {
    mkdirSync(blobsDir, { recursive: true });
    writeFileSync(join(blobsDir, '..', 'slot-secret.txt'), 'secret');
    db.run(`INSERT INTO blobs (hash, relative_path, size, mime_type, ref_count, created_at)
            VALUES ('blob_up', '../slot-secret.txt', 6, NULL, 1, 1)`);
    seedFile('file_blob_up', 'sha_file_blob_up', '', 'blob_up');
    expect(files().getContent(db, blobsDir, 'file_blob_up')).toBeNull();
  });

  it('getContent still reads a legacy external original_path holding the recorded bytes', () => {
    const external = join(root, 'Downloads', 'book.pdf');
    mkdirSync(join(root, 'Downloads'));
    writeFileSync(external, 'legacy textbook bytes');
    const hash = sha256('legacy textbook bytes');
    seedFile('file_legacy', hash.toUpperCase(), external);
    seedFile('file_legacy_copy', `${hash}_copy_AbCd1234`, external);
    const expected = Buffer.from('legacy textbook bytes').toString('base64');
    expect(files().getContent(db, blobsDir, 'file_legacy')).toBe(expected);
    expect(files().getContent(db, blobsDir, 'file_legacy_copy')).toBe(expected);
  });

  it('getContent reads new bytes after a legitimately imported external file is modified in place without a blob', () => {
    const external = join(root, 'Downloads', 'annotated-book.pdf');
    mkdirSync(join(root, 'Downloads'));
    const imported = 'original textbook bytes';
    writeFileSync(external, imported);
    const hash = sha256(imported);
    const file = files().createFile(db, hash, 'annotated-book.pdf', Buffer.byteLength(imported),
      'document', 'application/pdf', null, external);
    expect(db.get('SELECT blob_hash FROM files WHERE id = ?1', [file.id])).toEqual({ blob_hash: null });
    expect(files().getContent(db, blobsDir, file.id)).toBe(Buffer.from(imported).toString('base64'));

    const annotated = 'textbook bytes with external annotations';
    writeFileSync(external, annotated);
    expect(files().getFile(db, file.id)?.sha256).toBe(hash);
    expect(db.pluck<number>('SELECT COUNT(*) FROM blobs')).toBe(0);
    expect(files().getContent(db, blobsDir, file.id)).toBe(Buffer.from(annotated).toString('base64'));
  });

  it('getContent keeps skipping virtual URIs and returns null for missing original paths', () => {
    for (const [index, path] of ['content://books/1', 'asset://books/1', 'primary:books/1', join(root, 'missing.pdf'), ''].entries()) {
      const id = `file_unavailable_${index}`;
      seedFile(id, sha256(id), path);
      expect(files().getContent(db, blobsDir, id)).toBeNull();
    }
  });
});
