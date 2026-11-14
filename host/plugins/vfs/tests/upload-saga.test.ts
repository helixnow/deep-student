import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import plugin from '../index.ts';
import indexPlugin from '../../vfs-index/index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
// boundary-allow cross-plugin-impl: exercise real owner repository writes and compensations
import notesPlugin from '../../notes/index.ts';
// boundary-allow cross-plugin-impl: exercise real owner repository writes and compensations
import reposPlugin from '../../vfs-repos/index.ts';
import { vfsRepositories } from '../repository/services.ts';

let template: string, root: string, host: TestHost, db: DatabaseHandle, blobs: string;
let storage: ReturnType<typeof createStorageService>;
beforeAll(async () => {
  template = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-saga-schema-'));
  const source = createStorageService({ baseDir: template, dataLocalDir: template });
  try { const result = await source.migrations.runAll(); expect(result.success, result.error ?? '').toBe(true); }
  finally { source.dispose(); }
}, 120_000);
afterAll(() => fs.rmSync(template, { recursive: true, force: true }));
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-saga-'));
  fs.cpSync(template, root, { recursive: true });
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  host = await createTestHost({ plugins: [pathsPlugin, notesPlugin, reposPlugin, indexPlugin, plugin], provide: { storage }, app: { dataDir: root } });
  db = storage.database('vfs'); blobs = host.ctx.vfsDatabase.blobsDir();
}, 60_000);
afterEach(async () => { await host?.dispose(); storage?.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const refs = (hash: string) => db.pluck<number>('SELECT ref_count FROM blobs WHERE hash = ?', [hash]);
const exists = (hash: string) => {
  const dir = path.join(blobs, hash.slice(0, 2));
  return fs.existsSync(dir) && fs.readdirSync(dir).some(name => name.startsWith(hash) && !name.endsWith('.tmp'));
};
const store = (data: Buffer) => vfsRepositories().blobs.storeBlob(db, blobs, data, null, null);
const createFile = (data: Buffer, blob: string | null) => vfsRepositories().files.createFileWithDocDataInFolderOutcome(
  db, hash(data), 'upload.pdf', data.length, 'pdf', 'application/pdf', blob, null, null, null, 'text', 1);

for (const withBlob of [false, true]) {
  it(withBlob ? 'upload_with_blob_waits_for_concurrent_writer' : 'upload_without_blob_waits_for_concurrent_writer', async () => {
    db.exec('PRAGMA busy_timeout = 2000');
    const worker = new Worker(new URL('./upload-writer.mjs', import.meta.url), { workerData: { path: host.ctx.vfsDatabase.dbPath() } });
    try {
      expect((await once(worker, 'message'))[0]).toBe('locked');
      const exit = once(worker, 'exit');
      const data = Buffer.from('upload concurrent writer regression');
      const [file, created] = host.ctx.vfs.upload.withSavepoint(db, 'upload_concurrent_writer', () => {
        const blob = withBlob ? store(data).hash : null;
        return createFile(data, blob);
      });
      expect(created).toBe(true);
      // A fresh BEGIN proves the upload released its transaction, rather than merely returning a row.
      db.exec('BEGIN IMMEDIATE; ROLLBACK');
      expect(vfsRepositories().files.getFile(db, file.id)).not.toBeNull();
      expect(db.pluck('SELECT COUNT(*) FROM resources WHERE hash = ?', [hash(data)])).toBe(1);
      if (withBlob) expect(refs(hash(data))).toBe(1);
      await exit;
    } finally { await worker.terminate(); }
  }, 15_000);
}
it('test_failure_after_blob_rolls_back_row_and_cleans_file', () => {
  const data = Buffer.from('td03: fail right after blob store'), h = hash(data);
  expect(() => host.ctx.vfs.upload.withSavepoint(db, 'td03_blob_fail', () => {
    store(data); throw new Error('injected failure after blob');
  })).toThrow('injected failure after blob');
  expect(refs(h)).toBeUndefined(); expect(exists(h)).toBe(true);
  expect(vfsRepositories().blobs.removeUnregisteredBlobFile(db, blobs, h)).toBe(true);
  expect(exists(h)).toBe(false);
});
it('test_failure_after_dedup_blob_keeps_shared_blob', () => {
  const data = Buffer.from('td03: dedup-shared blob survives failed upload');
  const blob = store(data); expect(blob.refCount).toBe(1);
  expect(() => host.ctx.vfs.upload.withSavepoint(db, 'td03_dedup_fail', () => {
    expect(store(data).refCount).toBe(2); throw new Error('injected failure after dedup store');
  })).toThrow('injected failure');
  expect(refs(blob.hash)).toBe(1);
  expect(vfsRepositories().blobs.removeUnregisteredBlobFile(db, blobs, blob.hash)).toBe(false);
  expect(exists(blob.hash)).toBe(true);
});
it('test_failure_after_file_row_rolls_back_everything', () => {
  const data = Buffer.from('td03: fail after file row created'), h = hash(data);
  let createdFlag = false;
  expect(() => host.ctx.vfs.upload.withSavepoint(db, 'td03_row_fail', () => {
    const blob = store(data);
    createdFlag = createFile(data, blob.hash)[1];
    throw new Error('injected failure after file row');
  })).toThrow('injected failure');
  expect(createdFlag).toBe(true);
  expect(db.pluck('SELECT COUNT(*) FROM files WHERE sha256 = ?', [h])).toBe(0);
  expect(db.pluck('SELECT COUNT(*) FROM resources WHERE hash = ?', [h])).toBe(0);
  expect(db.pluck("SELECT COUNT(*) FROM folder_items WHERE item_type = 'file'")).toBe(0);
  expect(refs(h)).toBeUndefined();
  expect(vfsRepositories().blobs.removeUnregisteredBlobFile(db, blobs, h)).toBe(true);
  expect(exists(h)).toBe(false);
});
it('test_saga_abort_only_releases_refs_created_by_this_call', () => {
  const data = Buffer.from('td03: shared preview page'), original = store(data);
  using saga = host.ctx.vfs.upload.createSaga();
  const again = store(data); expect(again.refCount).toBe(2); saga.recordBlobRef(again.hash);
  const unique = store(Buffer.from('td03: unique preview page')); saga.recordBlobRef(unique.hash);
  saga.abort(db, blobs);
  expect(refs(original.hash)).toBe(1); expect(exists(original.hash)).toBe(true);
  expect(refs(unique.hash)).toBeUndefined(); expect(exists(unique.hash)).toBe(false);
  saga.abort(db, blobs); expect(refs(original.hash)).toBe(1);
});
it('test_index_failure_enters_retryable_state_and_sync_is_idempotent', () => {
  const data = Buffer.from('td03: index failure retry path');
  const [file, created] = createFile(data, store(data).hash);
  expect(created).toBe(true);
  const id = file.resourceId!, state = vfsRepositories().indexStates;
  expect(state.getPendingResources(db, 10, 3)).toContain(id);
  state.markFailed(db, id, 'injected index failure');
  const row = db.get<{ index_state: string; index_retry_count: number; index_next_retry_at: number }>(
    'SELECT index_state, index_retry_count, index_next_retry_at FROM resources WHERE id = ?', [id])!;
  expect(row.index_state).toBe('failed'); expect(row.index_retry_count).toBe(1);
  expect(row.index_next_retry_at).toBeGreaterThan(Date.now());
  state.setIndexState(db, id, 'pending', null, null);
  expect(state.getPendingResources(db, 10, 3)).toContain(id);
  const input = { resourceId: id, resourceType: 'file', extractedText: 'some indexable text' };
  const first = host.ctx.vfs.unitIndex.syncResourceUnits(input), second = host.ctx.vfs.unitIndex.syncResourceUnits(input);
  expect(first).toHaveLength(1); expect(second).toHaveLength(1); expect(second[0]!.id).toBe(first[0]!.id);
  expect(db.pluck('SELECT COUNT(*) FROM vfs_index_units WHERE resource_id = ?', [id])).toBe(1);
});
it('test_sync_units_rolls_back_partial_writes_on_failure', () => {
  const resource = vfsRepositories().resources.createOrReuse(db, 'file', '', 'f', 'files', null);
  const inputs = ['first', 'duplicate'].map(textContent => ({ resourceId: resource.resourceId, unitIndex: 0,
    imageBlobHash: null, imageMimeType: null, textContent, textSource: 'native' }));
  expect(() => vfsRepositories().embeddingUnits.syncUnits(db, resource.resourceId, inputs)).toThrow();
  expect(db.pluck('SELECT COUNT(*) FROM vfs_index_units WHERE resource_id = ?', [resource.resourceId])).toBe(0);
});
it('test_failed_upload_retry_is_idempotent', () => {
  const data = Buffer.from('td03: retry after failure'), h = hash(data);
  const attempt = (fail: boolean) => {
    using saga = host.ctx.vfs.upload.createSaga();
    try {
      const outcome = host.ctx.vfs.upload.withSavepoint(db, 'td03_retry', () => {
        const blob = store(data), outcome = createFile(data, blob.hash);
        if (fail) throw new Error('injected');
        return outcome;
      });
      if (outcome[1]) saga.commit();
      else { saga.recordBlobRef(h); saga.abort(db, blobs); }
      return outcome;
    } catch (error) {
      saga.abort(db, blobs); vfsRepositories().blobs.removeUnregisteredBlobFile(db, blobs, h); throw error;
    }
  };
  expect(() => attempt(true)).toThrow('injected');
  expect(db.pluck('SELECT COUNT(*) FROM files WHERE sha256 = ?', [h])).toBe(0);
  expect(refs(h)).toBeUndefined(); expect(exists(h)).toBe(false);
  const [second, created] = attempt(false); expect(created).toBe(true);
  expect(db.pluck('SELECT COUNT(*) FROM files WHERE sha256 = ?', [h])).toBe(1);
  expect(refs(h)).toBe(1); expect(exists(h)).toBe(true);
  const [third, recreated] = attempt(false); expect(recreated).toBe(false); expect(third.id).toBe(second.id);
  expect(db.pluck('SELECT COUNT(*) FROM files WHERE sha256 = ?', [h])).toBe(1);
  expect(refs(h)).toBe(1); expect(exists(h)).toBe(true);
});
