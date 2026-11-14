import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createTestHost } from '../../../kernel/testing.ts';
import { SqliteDatabase } from '../../../platform/storage/database.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import plugin from '../index.ts';
import notes from '../../notes/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import sync from '../../sync/index.ts';
import review from '../../review/index.ts';

// One real F3 vfs migration per process, started at import on a worker thread so neither
// a test/hook timer nor the test thread's event loop carries it; each host copies the file.
export const migratedVfsTemplate = await new Promise<string>((resolve, reject) => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-support-vfs-'));
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  const worker = new Worker(new URL('./vfs-template-worker.ts', import.meta.url), { workerData: { dir } });
  worker.once('message', (message: { ok: boolean; path?: string; error?: string }) => {
    if (message.ok) resolve(message.path!);
    else reject(new Error(`vfs template migration failed: ${message.error}`));
  });
  worker.once('error', reject);
});

/** Real F3 + installed notes/vfsRepo/syncSupport; no replacement note or todo writer. */
export async function serviceHost(database?: DatabaseHandle, withSync = false) {
  const db: DatabaseHandle = database ?? new SqliteDatabase({ name: 'sync-support-test', path: ':memory:', profile: {} });
  const host = await createTestHost({
    provide: {
      paths: {
        deviceId: async () => 'sync-support-test',
        dataSpaceDeviceId: async () => 'sync-support-test',
      },
      // These ports are not called by row apply. No apply/history/owner logic is replaced.
      ...(withSync ? { backup: {}, syncProvider: {}, secrets: {}, vfsDatabase: {}, nativeCompression: {} } : {}),
    },
  });
  const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  try {
    // Notes startup clears its lease tables in vfs (lib.rs:1338-1354), which Rust reaches
    // only after migrations. Unless the caller supplied F3's migrated vfs handle, vfs is
    // a private copy of F3's migrated vfs.db.
    let vfs = db;
    if (db.name !== 'vfs') {
      const file = storage.pathOf('vfs');
      mkdirSync(dirname(file), { recursive: true });
      copyFileSync(migratedVfsTemplate, file);
      vfs = storage.database('vfs');
    }
    host.ctx.provide('storage', {
      // These tests explicitly pass their real SQLite handle to the row engine.
      // Notes worker startup uses F3's real registry and app-local locations;
      // no maintenance participant, owner, or worker implementation is replaced.
      database: (name: string) => (name === 'vfs' ? vfs : db),
      pathOf: (name: string) => (name === 'vfs' ? vfs.path : db.path),
      locations: storage.locations,
      registerMaintenanceParticipant: storage.registerMaintenanceParticipant.bind(storage),
      registerFinalizer: storage.registerFinalizer.bind(storage),
      finalizerNames: storage.finalizerNames.bind(storage),
    });
    await host.install(vfsRepos, notes, plugin);
    // The plugin opens sync_state on first use. Rust fixtures (`memory_store()`) hand
    // tests an already-initialized connection, so open it once here before callers
    // seed/alter sync_state tables; production timing stays lazy (see state-lazy-open).
    // Use upload_seq so the dropped-table tests below still prepare their own statements.
    host.ctx.syncSupport.state.publishedMaxSeq('__fixture__', '__fixture__');
    // Sync mutation commands consume mastery; keep its real owner installed
    // before sync rather than satisfying dependency checks with an empty object.
    if (withSync) await host.install(review, sync);
  } catch (error) {
    try { await host.dispose(); }
    finally {
      storage.dispose();
      if (db instanceof SqliteDatabase) db.close();
    }
    throw error;
  }
  return {
    db,
    service: host.ctx.syncSupport,
    notes: host.ctx.notes,
    vfsRepo: host.ctx.vfsRepo,
    sync: withSync ? host.ctx.sync : undefined,
    mastery: withSync ? host.ctx.mastery : undefined,
    invoke: host.invoke.bind(host),
    async dispose() {
      try { await host.dispose(); }
      finally {
        storage.dispose();
        if (db instanceof SqliteDatabase) db.close();
      }
    },
  };
}
