import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import paths from '../../../platform/paths/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { defineQuery } from '../../../platform/storage/api.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import notes from '../index.ts';
import type { PreparedBlobDeletion } from '../api.ts';

type Host = Awaited<ReturnType<typeof createTestHost>>;
let host: Host;
let storage: ReturnType<typeof createStorageService>;

beforeAll(async () => {
  host = await createTestHost();
  storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  await storage.migrations.runAll();
  host.ctx.provide('storage', storage);
  host.ctx.provide('settings', createSettingsStore({
    db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false,
  }));
  await host.install(paths, vfsRepos, notes);
}, 120000);

beforeEach(() => {
  storage.database('vfs').run('DELETE FROM __file_deletion_journal');
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await host.dispose();
  storage.dispose();
});

function input(operationId: string, hash = 'hash-a'): PreparedBlobDeletion {
  return {
    operationId, hash, relativePath: 'ab/cd/blob.bin', expectedHash: 'expected-file-hash',
    size: 9_007_199_254_740_993n, preparedAt: '2026-11-05T00:00:00.000000001+00:00',
  };
}

interface JournalRow {
  operation_id: string; target_kind: string; entity_key: string; local_path: string;
  expected_hash: string | null; size: bigint | null; state: string; prepared_at: string;
  cancelled_at: string | null; ready_at: string | null; last_error: string | null;
}
const journalRow = defineQuery<readonly [string], JournalRow>(
  `SELECT operation_id,target_kind,entity_key,local_path,expected_hash,size,state,
     prepared_at,cancelled_at,ready_at,last_error FROM __file_deletion_journal WHERE operation_id=?1`,
  { options: { safeIntegers: true } },
);

describe('N5 blob journal owner seams (blob_repo.rs:372/656/822/861)', () => {
  it('inserts the original fields and signed i64 size without clocks, scans, transactions or duplicate suppression', () => {
    const db = storage.database('vfs');
    const repo = host.ctx.notes.blobDeletionJournal!;
    const exec = vi.spyOn(db, 'exec');
    const get = vi.spyOn(db, 'get');
    const all = vi.spyOn(db, 'all');
    const prepared = input('op-insert');
    repo.insertPreparedBlobDeletion(db, prepared);
    expect(exec).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(all).not.toHaveBeenCalled();
    expect(db.get(journalRow, ['op-insert'])).toEqual({
      operation_id: prepared.operationId, target_kind: 'blob', entity_key: prepared.hash,
      local_path: prepared.relativePath, expected_hash: prepared.expectedHash, size: prepared.size,
      state: 'prepared', prepared_at: prepared.preparedAt, cancelled_at: null, ready_at: null, last_error: null,
    });
    // Unlike F3's asset intent insert, blob_repo.rs:656 has no ON CONFLICT clause.
    expect(() => repo.insertPreparedBlobDeletion(db, prepared)).toThrow(expect.objectContaining({
      code: 'SQLITE', sqliteCode: 'SQLITE_CONSTRAINT_PRIMARYKEY',
    }));
    repo.insertPreparedBlobDeletion(db, { ...input('op-null'), expectedHash: null, size: null });
    expect(db.get(journalRow, ['op-null'])).toMatchObject({ expected_hash: null, size: null });
    repo.insertPreparedBlobDeletion(db, { ...input('op-signed'), size: -1n });
    expect(db.get(journalRow, ['op-signed'])!.size).toBe(-1n);
    expect(db.inTransaction).toBe(false);
  });

  it('cancels only recreated blob/hash prepared or ready rows, and shares caller rollback', () => {
    const db = storage.database('vfs');
    const repo = host.ctx.notes.blobDeletionJournal!;
    for (const state of ['prepared', 'ready', 'published', 'cancelled']) {
      repo.insertPreparedBlobDeletion(db, input(`op-${state}`));
      db.run('UPDATE __file_deletion_journal SET state=?2 WHERE operation_id=?1', [`op-${state}`, state]);
    }
    repo.insertPreparedBlobDeletion(db, input('op-other-hash', 'hash-b'));
    host.ctx.notes.deletionJournal!.insertPreparedIntent(db, {
      operationId: 'op-asset', targetKind: 'asset', entityKey: 'hash-a',
      localPath: 'notes_assets/image.png', expectedHash: null, size: null,
    });
    const before = ['prepared', 'ready', 'published', 'cancelled', 'other-hash', 'asset']
      .map((suffix) => db.get(journalRow, [`op-${suffix}`])!);
    const cancelledAt = '2026-11-05T00:00:00.000000002+00:00';
    expect(() => db.transaction(() => {
      repo.cancelBlobDeletionsForRecreatedBlob(db, 'hash-a', cancelledAt);
      throw new Error('caller abort');
    })).toThrow('caller abort');
    expect(before.map((row) => db.get(journalRow, [row.operation_id]))).toEqual(before);

    repo.cancelBlobDeletionsForRecreatedBlob(db, 'hash-a', cancelledAt);
    for (const row of before) {
      const affected = row.target_kind === 'blob' && row.entity_key === 'hash-a'
        && (row.state === 'prepared' || row.state === 'ready');
      expect(db.get(journalRow, [row.operation_id])).toEqual(affected ? {
        ...row, state: 'cancelled', cancelled_at: cancelledAt,
        last_error: 'blob recreated before deletion was published',
      } : row);
    }
  });

  it('keeps prepared-only cancellation and ready affected-row semantics without touching the blob outbox', () => {
    const db = storage.database('vfs');
    const repo = host.ctx.notes.blobDeletionJournal!;
    const readyAt = '2026-11-05T00:00:00.000000003+00:00';
    const cancelledAt = '2026-11-05T00:00:00.000000004+00:00';
    repo.insertPreparedBlobDeletion(db, input('op-cancel'));
    repo.cancelPreparedBlobDeletion(db, 'op-cancel', cancelledAt, 'caller-computed conflict');
    expect(db.get(journalRow, ['op-cancel'])).toMatchObject({
      state: 'cancelled', cancelled_at: cancelledAt, last_error: 'caller-computed conflict',
    });
    expect(repo.markBlobDeletionReady(db, 'op-cancel', readyAt)).toBe(0);
    expect(repo.markBlobDeletionReady(db, 'missing', readyAt)).toBe(0);
    repo.insertPreparedBlobDeletion(db, input('op-ready'));
    db.run("UPDATE __file_deletion_journal SET last_error='previous' WHERE operation_id='op-ready'");
    expect(repo.markBlobDeletionReady(db, 'op-ready', readyAt)).toBe(1);
    expect(repo.markBlobDeletionReady(db, 'op-ready', readyAt)).toBe(1);
    repo.cancelPreparedBlobDeletion(db, 'op-ready', cancelledAt, 'must not overwrite ready');
    expect(db.get(journalRow, ['op-ready'])).toMatchObject({
      state: 'ready', ready_at: readyAt, cancelled_at: null, last_error: null,
    });
    db.run("UPDATE __file_deletion_journal SET state='published' WHERE operation_id='op-ready'");
    expect(repo.markBlobDeletionReady(db, 'op-ready', readyAt)).toBe(0);

    // The two op-id updates do not invent a target_kind filter (Rust has none).
    host.ctx.notes.deletionJournal!.insertPreparedIntent(db, {
      operationId: 'op-id-only', targetKind: 'asset', entityKey: 'asset-key', localPath: 'asset.png', expectedHash: null, size: null,
    });
    expect(repo.markBlobDeletionReady(db, 'op-id-only', readyAt)).toBe(1);
    expect(db.pluck<number>('SELECT COUNT(*) FROM __blob_deletion_queue')).toBe(0);
    expect(db.inTransaction).toBe(false);
  });

  it('propagates the original SQLite error and leaves transaction rollback to L11', () => {
    const db = storage.database('vfs');
    const repo = host.ctx.notes.blobDeletionJournal!;
    const run = vi.spyOn(db, 'run'); // call-through: capture the actual F3 error, not a replacement.
    db.exec("CREATE TRIGGER blob_journal_fail BEFORE UPDATE ON __file_deletion_journal BEGIN SELECT RAISE(ABORT,'blob journal blocked'); END");
    let caught: unknown;
    try {
      db.transaction(() => {
        repo.insertPreparedBlobDeletion(db, input('op-rollback'));
        repo.markBlobDeletionReady(db, 'op-rollback', 'caller-ready-at');
      });
    } catch (error) {
      caught = error;
    } finally {
      db.exec('DROP TRIGGER blob_journal_fail');
    }
    expect(caught).toMatchObject({ code: 'SQLITE', sqliteCode: 'SQLITE_CONSTRAINT_TRIGGER', message: 'blob journal blocked' });
    expect(run.mock.results.at(-1)!.type).toBe('throw');
    expect(caught).toBe(run.mock.results.at(-1)!.value);
    expect(db.get(journalRow, ['op-rollback'])).toBeUndefined();
    expect(db.inTransaction).toBe(false);
  });
});
