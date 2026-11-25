import './local-runtime-fixture.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import { compression } from '../../../platform/native/compression/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import notes from '../../notes/index.ts';
import syncSupport from '../../sync-support/index.ts';
import sync from '../index.ts';
import { applyDownloadedChangesWithConflictGuard } from '../repository/apply-guard.ts';
import { resolveRecordConflict } from '../src/conflict-commands.ts';
import { setLocalRuntime } from '../src/local-runtime.ts';
import { nodeLocalRuntime } from '../src/local-runtime.node.ts';
import { getRecordData } from '../repository/record-data.ts';
import { openTestDatabase } from './test-db.ts';
import { MemoryStorage } from '../../sync-providers/tests/memory_storage.ts'; // boundary-allow cross-plugin-impl: test harness shares MemoryStorage fake
import { configureNotesRepository } from '../../notes/repository/notes.ts';
import type { SyncAuditRequest } from '../../backup/api.ts';
import type { CloudStorage } from '../../sync-providers/api.ts';

interface DeviceSpec {
  deviceId: string;
  dir: string;
  cloud: MemoryStorage;
  audits: SyncAuditRequest[];
}

interface SyncResponse {
  success: boolean;
  changes_uploaded: number;
  changes_downloaded: number;
  conflicts_detected: number;
  skipped_changes?: number;
  error_message?: string | null;
}

const dirs: string[] = [];

afterEach(() => {
  configureNotesRepository(null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function initDevice(deviceId: string, cloud: MemoryStorage): Promise<DeviceSpec> {
  const dir = mkdtempSync(join(tmpdir(), `rename-del-${deviceId}-`));
  dirs.push(dir);
  const storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
  try {
    await storage.migrations.runAll();
  } finally {
    storage.dispose();
  }
  return { deviceId, dir, cloud, audits: [] };
}

async function onDevice<T>(
  spec: DeviceSpec,
  work: (ctx: {
    host: Awaited<ReturnType<typeof createTestHost>>;
    storage: ReturnType<typeof createStorageService>;
  }) => Promise<T>,
): Promise<T> {
  const storage = createStorageService({ baseDir: spec.dir, dataLocalDir: spec.dir });
  const settings = createSettingsStore({
    db: () => storage.database('mistakes'),
    secureStore: () => null,
    isSensitiveKey: () => false,
  });
  const backupCrypto = createBackupCrypto();
  const cloudConfig = {
    provider: 'webdav',
    root: 'sync',
    webdav: { endpoint: 'https://dav.example.com', username: 'u' },
  };
  const permit = { release: () => undefined };
  let cancelSignal: AbortSignal | null = null;

  const host = await createTestHost({
    app: { dataDir: spec.dir },
    provide: {
      storage,
      settings,
      paths: {
        deviceId: async () => spec.deviceId,
        dataSpaceDeviceId: async () => spec.deviceId,
        appDataDir: spec.dir,
      },
      secrets: {
        backup: backupCrypto,
        openStore: () => ({
          getCloudCredentials: async () => null,
          saveCloudCredentials: async () => undefined,
          deleteCloudCredentials: async () => undefined,
        }),
      },
      nativeCompression: compression,
      syncProvider: {
        createStorage: async () => spec.cloud as unknown as CloudStorage,
        setStatusHook: () => undefined,
        clearStatusHook: () => undefined,
        setCancelToken: (s: AbortSignal) => { cancelSignal = s; },
        clearCancelToken: () => { cancelSignal = null; },
        isSyncCancelled: () => cancelSignal?.aborted ?? false,
      },
      vfsDatabase: { isInMaintenanceMode: () => false },
      agentWorkspace: {
        enterMaintenanceMode: async () => undefined,
        exitMaintenanceMode: async () => undefined,
      },
      backup: {
        hydrateCloudConfig: async () => undefined,
        tryAcquireOperation: () => permit,
        acquireOperation: async () => permit,
        syncCommandPorts: () => ({
          limiter: { tryAcquire: () => permit, acquire: async () => permit },
          loadHydratedCloudConfig: async () => cloudConfig,
          saveSyncAudit: (req: SyncAuditRequest) => { spec.audits.push(req); },
        }),
      },
      governance: {
        tryAcquireOperationGuard: () => permit,
      },
      mastery: {
        recomputeAllStatesWithConn: () => 0,
        syncAllLearnerProfiles: () => 0,
      },
    },
  });

  try {
    await host.install(vfsRepos, notes, syncSupport, sync);
    return await work({ host, storage });
  } finally {
    configureNotesRepository(null);
    await host.dispose();
    storage.dispose();
  }
}

describe('Rename-vs-delete conflict preservation', () => {
  it('flags a conflict in apply-guard when cloud soft-deletes a note that has an unresolved or pending local notes.title rename without resource edits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apply-guard-rename-del-'));
    dirs.push(dir);
    const storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
    try {
      const db = storage.database('vfs');
      db.exec(`
        CREATE TABLE resources (id TEXT PRIMARY KEY, type TEXT, data TEXT, mime_type TEXT, updated_at TEXT);
        CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT, resource_id TEXT, updated_at TEXT, deleted_at TEXT);
        CREATE TABLE __change_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          table_name TEXT NOT NULL,
          record_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          changed_at TEXT NOT NULL DEFAULT (datetime('now')),
          sync_version INTEGER DEFAULT 0
        );
        CREATE TABLE __sync_conflicts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          table_name TEXT NOT NULL,
          record_id TEXT NOT NULL,
          side TEXT NOT NULL,
          data_json TEXT NOT NULL,
          data_hash TEXT NOT NULL DEFAULT '',
          winning_device_id TEXT,
          losing_device_id TEXT,
          detected_at TEXT NOT NULL DEFAULT (datetime('now')),
          resolved_at TEXT,
          resolution TEXT
        );
        INSERT INTO resources VALUES ('res-1', 'note', 'Unchanged body', 'text/markdown', '2026-11-24T09:00:00Z');
        INSERT INTO notes VALUES ('note-1', 'Renamed Locally on B', 'res-1', '2026-11-24T10:00:00Z', NULL);
        -- Existing unresolved conflict on notes (simulating a follow-up sync where __change_log was already synced)
        INSERT INTO __sync_conflicts (table_name, record_id, side, data_json, data_hash)
          VALUES ('notes', 'note-1', 'local', '{"id":"note-1","title":"Renamed Locally on B"}', 'seed-hash-local');
      `);

      const deferred: string[] = [];
      const { conflict } = applyDownloadedChangesWithConflictGuard(
        db,
        [
          {
            table_name: 'notes',
            record_id: 'note-1',
            operation: 'Update',
            data: {
              id: 'note-1',
              title: 'Original Title',
              resource_id: 'res-1',
              updated_at: '2026-11-24T12:00:00Z',
              deleted_at: '2026-11-24T12:00:00Z',
            },
            changed_at: '2026-11-24T12:00:00Z',
            source_device_id: 'dev-a',
            source_seq: 2,
          },
        ],
        { deviceId: 'dev-b' },
        {
          policy: 'KeepLatest',
          cloudDeviceId: 'dev-a',
          localDeviceId: 'dev-b',
          deferConflictingOverwrite: true,
          onDeferredConflict: (key) => deferred.push(key),
        },
      );

      expect(conflict.conflicts_saved).toBeGreaterThanOrEqual(1);
      expect(deferred).toContain('notes\u001fnote-1');
      const noteRow = db.get<{ title: string; deleted_at: string | null }>(
        'SELECT title, deleted_at FROM notes WHERE id = ?1',
        ['note-1'],
      );
      expect(noteRow).toEqual({ title: 'Renamed Locally on B', deleted_at: null });
    } finally {
      storage.dispose();
    }
  });

  it('preserves rename-vs-delete conflict across two devices under keep_latest even when body resource is untouched', async () => {
    const cloud = new MemoryStorage('webdav');
    const devA = await initDevice('dev-a-rename-del', cloud);
    const devB = await initDevice('dev-b-rename-del', cloud);

    const noteId = await onDevice(devA, async ({ host }) => {
      const created = await host.invoke<{ id: string }>('notes_create', {
        note: { title: 'Original Note Title', content_md: 'Shared untouched body' },
      });
      const push = await host.invoke<SyncResponse>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(push).toMatchObject({ success: true, conflicts_detected: 0 });
      return created.id;
    });

    await onDevice(devB, async ({ host }) => {
      const pull = await host.invoke<SyncResponse>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(pull).toMatchObject({ success: true, conflicts_detected: 0 });
    });

    // Device B renames ONLY notes.title (no resource body edit)
    await onDevice(devB, async ({ host }) => {
      await host.invoke('notes_update', {
        note: { id: noteId, title: 'Renamed on Device B' },
      });
    });

    // Device A soft-deletes the note and syncs (later timestamp)
    await new Promise((r) => setTimeout(r, 1100));
    await onDevice(devA, async ({ host }) => {
      await host.invoke('notes_delete', { id: noteId });
      const pushDel = await host.invoke<SyncResponse>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(pushDel).toMatchObject({ success: true, conflicts_detected: 0 });
    });

    // Device B syncs under keep_latest -> MUST create an unresolved conflict and preserve active renamed note!
    await onDevice(devB, async ({ host, storage }) => {
      const syncB = await host.invoke<SyncResponse>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(syncB.success).toBe(true);
      expect(syncB.conflicts_detected).toBeGreaterThanOrEqual(1);

      const conflicts = await host.invoke<Array<{ table_name: string; record_id: string }>>(
        'data_governance_list_record_conflicts',
        {},
      );
      expect(conflicts.some((c) => c.table_name === 'notes' && c.record_id === noteId)).toBe(true);

      const noteRow = storage.database('vfs').get<{ title: string; deleted_at: string | null }>(
        'SELECT title, deleted_at FROM notes WHERE id = ?1',
        [noteId],
      );
      expect(noteRow).toEqual({ title: 'Renamed on Device B', deleted_at: null });
    });
  }, 120000);

  it('BUG-T2: resolving resources:keep_cloud FIRST in rename+edit vs delete converges both devices cleanly', async () => {
    const cloud = new MemoryStorage('webdav');
    const devA = await initDevice('dev-a-ds03-t2', cloud);
    const devB = await initDevice('dev-b-ds03-t2', cloud);

    // 1) Device A creates note and syncs to cloud
    const { noteId, resIdOld } = await onDevice(devA, async ({ host, storage }) => {
      const created = await host.invoke<{ id: string }>('notes_create', {
        note: { title: 'DS03_Rename_Vs_Delete', content_md: 'Initial DS03 body' },
      });
      const resId = storage.database('vfs').pluck<string>(
        'SELECT resource_id FROM notes WHERE id = ?1',
        [created.id],
      )!;
      const push = await host.invoke<SyncResponse>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(push).toMatchObject({ success: true, conflicts_detected: 0 });
      return { noteId: created.id, resIdOld: resId };
    });

    // 2) Device B pulls initial note (pointing to resIdOld)
    await onDevice(devB, async ({ host }) => {
      const pull = await host.invoke<SyncResponse>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(pull).toMatchObject({ success: true, conflicts_detected: 0 });
    });

    // 3) Offline Device B soft-deletes the note (still pointing to resIdOld)
    await onDevice(devB, async ({ host }) => {
      await host.invoke('notes_delete', { id: noteId });
    });

    // 4) Device A renames + edits body (later timestamp; creates resIdNew, updates notes, deletes resIdOld) and pushes
    await new Promise((r) => setTimeout(r, 1100));
    const resIdNew = await onDevice(devA, async ({ host, storage }) => {
      await host.invoke('notes_update', {
        note: {
          id: noteId,
          title: 'DS03_Renamed_On_Device_A',
          content_md: 'Edited body on Device A for DS03',
        },
      });
      const newResId = storage.database('vfs').pluck<string>(
        'SELECT resource_id FROM notes WHERE id = ?1',
        [noteId],
      )!;
      expect(newResId).not.toBe(resIdOld);
      const pushA = await host.invoke<SyncResponse>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(pushA).toMatchObject({ success: true, conflicts_detected: 0 });
      return newResId;
    });

    // 5) Device B syncs -> BOTH conflicts recorded (resources on resIdOld + notes on noteId)
    await onDevice(devB, async ({ host, storage }) => {
      const syncB1 = await host.invoke<SyncResponse>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(syncB1.success).toBe(true);
      expect(syncB1.conflicts_detected).toBeGreaterThanOrEqual(1);

      const conflicts = await host.invoke<Array<{ id: number; table_name: string; record_id: string }>>(
        'data_governance_list_record_conflicts',
        {},
      );
      const resConflicts = conflicts.filter((c) => c.table_name === 'resources' && c.record_id === resIdOld);
      const noteConflicts = conflicts.filter((c) => c.table_name === 'notes' && c.record_id === noteId);
      expect(resConflicts.length).toBeGreaterThan(0);
      expect(noteConflicts.length).toBeGreaterThan(0);

      // 6) Resolve resources:keep_cloud FIRST (exact DS03 order!)
      await host.invoke('data_governance_resolve_record_conflict', {
        databaseName: 'vfs',
        tableName: 'resources',
        recordId: resIdOld,
        resolution: 'keep_cloud',
        expectedConflictIds: resConflicts.map((c) => c.id),
      });

      // Paired notes conflict must have been resolved with Cloud's live row applied!
      const remAfterResolve = await host.invoke<Array<{ id: number; table_name: string; record_id: string }>>(
        'data_governance_list_record_conflicts',
        {},
      );
      expect(remAfterResolve).toEqual([]);

      const vfsB = storage.database('vfs');
      const noteAfter = vfsB.get<{ title: string; resource_id: string; deleted_at: string | null }>(
        'SELECT title, resource_id, deleted_at FROM notes WHERE id = ?1',
        [noteId],
      );
      expect(noteAfter).toEqual({
        title: 'DS03_Renamed_On_Device_A',
        resource_id: resIdNew,
        deleted_at: null,
      });
      const resAfter = vfsB.get<{ data: string; deleted_at: number | null }>(
        'SELECT data, deleted_at FROM resources WHERE id = ?1',
        [resIdNew],
      );
      expect(resAfter).toEqual({
        data: 'Edited body on Device A for DS03',
        deleted_at: null,
      });

      // 6) Device B pushes resolved state
      const syncB2 = await host.invoke<SyncResponse>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(syncB2).toMatchObject({ success: true, conflicts_detected: 0 });
    });

    // 7) Device A syncs and converges cleanly
    await onDevice(devA, async ({ host, storage }) => {
      const syncA2 = await host.invoke<SyncResponse>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(syncA2).toMatchObject({ success: true, conflicts_detected: 0 });

      const statusA = await host.invoke<{ total_pending_changes: number }>('data_governance_get_sync_status', {});
      const conflictsA = await host.invoke<Array<{ id: number }>>('data_governance_list_record_conflicts', {});
      expect(statusA.total_pending_changes).toBe(0);
      expect(conflictsA).toEqual([]);

      const rowA = storage.database('vfs').get<{ title: string; resource_id: string; n_del: string | null; r_del: number | null; body: string }>(
        `SELECT n.title, n.resource_id, n.deleted_at AS n_del, r.deleted_at AS r_del, r.data AS body
         FROM notes n JOIN resources r ON r.id = n.resource_id
         WHERE n.id = ?1`,
        [noteId],
      );
      expect(rowA).toEqual({
        title: 'DS03_Renamed_On_Device_A',
        resource_id: resIdNew,
        n_del: null,
        r_del: null,
        body: 'Edited body on Device A for DS03',
      });
    });

    // 8) Final convergence verification on Device B
    await onDevice(devB, async ({ host, storage }) => {
      const syncB3 = await host.invoke<SyncResponse>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(syncB3).toMatchObject({ success: true, conflicts_detected: 0 });

      const statusB = await host.invoke<{ total_pending_changes: number }>('data_governance_get_sync_status', {});
      const conflictsB = await host.invoke<Array<{ id: number }>>('data_governance_list_record_conflicts', {});
      expect(statusB.total_pending_changes).toBe(0);
      expect(conflictsB).toEqual([]);

      const rowB = storage.database('vfs').get<{ title: string; resource_id: string; n_del: string | null; r_del: number | null; body: string }>(
        `SELECT n.title, n.resource_id, n.deleted_at AS n_del, r.deleted_at AS r_del, r.data AS body
         FROM notes n JOIN resources r ON r.id = n.resource_id
         WHERE n.id = ?1`,
        [noteId],
      );
      expect(rowB).toEqual({
        title: 'DS03_Renamed_On_Device_A',
        resource_id: resIdNew,
        n_del: null,
        r_del: null,
        body: 'Edited body on Device A for DS03',
      });
    });
  }, 120000);

  it('BUG-T2: resources:keep_both clones local linked note before updating resource_id and resources:merged preserves differing notes conflicts', () => {
    setLocalRuntime(nodeLocalRuntime);
    const createPairedDb = () => {
      const db = openTestDatabase();
      db.exec(`
        CREATE TABLE __change_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          table_name TEXT NOT NULL,
          record_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          changed_at TEXT NOT NULL DEFAULT (datetime('now')),
          sync_version INTEGER DEFAULT 0
        );
        CREATE TABLE __sync_conflicts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          table_name TEXT NOT NULL,
          record_id TEXT NOT NULL,
          side TEXT NOT NULL CHECK(side IN ('local','cloud')),
          data_json TEXT NOT NULL,
          data_hash TEXT NOT NULL DEFAULT '',
          winning_device_id TEXT,
          losing_device_id TEXT,
          detected_at TEXT NOT NULL DEFAULT (datetime('now')),
          resolved_at TEXT,
          resolution TEXT
        );
        CREATE TABLE __sync_record_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          batch_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          table_name TEXT NOT NULL,
          record_id TEXT NOT NULL,
          existed INTEGER NOT NULL CHECK(existed IN (0,1)),
          data_json TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          rolled_back_at TEXT
        );
        CREATE UNIQUE INDEX idx__sync_record_history_dedup
          ON __sync_record_history(batch_id, table_name, record_id);
        CREATE TABLE resources (
          id TEXT PRIMARY KEY,
          hash TEXT NOT NULL UNIQUE,
          type TEXT NOT NULL DEFAULT 'note',
          source_id TEXT,
          source_table TEXT,
          data TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          deleted_at INTEGER
        );
        CREATE TABLE notes (
          id TEXT PRIMARY KEY,
          resource_id TEXT NOT NULL REFERENCES resources(id),
          title TEXT NOT NULL,
          folder_id TEXT,
          tags TEXT DEFAULT '[]',
          props TEXT DEFAULT '{}',
          created_at TEXT,
          updated_at TEXT,
          deleted_at TEXT
        );
      `);
      return db;
    };

    const storageFor = (db: ReturnType<typeof openTestDatabase>) => ({
      pathOf: () => '/tmp',
      openFile: () => db,
      close: () => undefined,
    } as never);

    // 1) resources:keep_both when paired cloud note switches resource_id to res-new
    {
      const db = createPairedDb();
      db.run("INSERT INTO resources (id, hash, data, created_at, updated_at) VALUES ('res-old', 'h-old', 'Local Body', 1700000000000, 1700000001000)");
      db.run("INSERT INTO resources (id, hash, data, created_at, updated_at) VALUES ('res-new', 'h-new', 'Cloud New Body', 1700000000000, 1700000002000)");
      db.run("INSERT INTO notes (id, resource_id, title, created_at, updated_at) VALUES ('note-1', 'res-old', 'Local Title', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')");
      const localRes = getRecordData(db, 'resources', 'res-old', 'id') as Record<string, unknown>;
      const cloudRes = { ...localRes, hash: 'h-old-cloud', data: 'Cloud Old Body', updated_at: 1700000002000 };
      const localNote = getRecordData(db, 'notes', 'note-1', 'id') as Record<string, unknown>;
      const cloudNote = { ...localNote, title: 'Cloud Title', resource_id: 'res-new', updated_at: '2026-01-02T00:00:00Z', deleted_at: null };

      const rL = Number(db.run("INSERT INTO __sync_conflicts (table_name, record_id, side, data_json) VALUES ('resources', 'res-old', 'local', ?1)", [JSON.stringify(localRes)]).lastInsertRowid);
      const rC = Number(db.run("INSERT INTO __sync_conflicts (table_name, record_id, side, data_json) VALUES ('resources', 'res-old', 'cloud', ?1)", [JSON.stringify(cloudRes)]).lastInsertRowid);
      db.run("INSERT INTO __sync_conflicts (table_name, record_id, side, data_json) VALUES ('notes', 'note-1', 'local', ?1)", [JSON.stringify(localNote)]);
      db.run("INSERT INTO __sync_conflicts (table_name, record_id, side, data_json) VALUES ('notes', 'note-1', 'cloud', ?1)", [JSON.stringify(cloudNote)]);

      resolveRecordConflict(storageFor(db), 'vfs', 'resources', 'res-old', 'keep_both', null, [rL, rC], { locale: 'en-US' });

      const allNotes = db.all<{ id: string; title: string; resource_id: string; deleted_at: string | null }>(
        'SELECT id, title, resource_id, deleted_at FROM notes ORDER BY id',
      );
      expect(allNotes).toHaveLength(2);
      const orig = allNotes.find((n) => n.id === 'note-1')!;
      const copy = allNotes.find((n) => n.id !== 'note-1')!;
      expect(orig).toMatchObject({ title: 'Cloud Title', resource_id: 'res-new', deleted_at: null });
      expect(copy.title).toMatch(/^Local Title \(Conflict copy \d{4}-\d{2}-\d{2}\)$/);
      expect(db.pluck<string>('SELECT data FROM resources WHERE id = ?1', [copy.resource_id])).toBe('Local Body');
      expect(Number(db.pluck<number>('SELECT COUNT(*) FROM __sync_conflicts WHERE resolved_at IS NULL'))).toBe(0);
    }

    // 2) resources:merged leaves paired notes conflict OPEN when metadata differs, and auto-resolves when metadata is equal
    {
      const db = createPairedDb();
      db.run("INSERT INTO resources (id, hash, data, created_at, updated_at) VALUES ('res-1', 'h-1', 'Local Body', 1700000000000, 1700000001000)");
      db.run("INSERT INTO notes (id, resource_id, title, created_at, updated_at) VALUES ('note-1', 'res-1', 'Local Title', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')");
      const localRes = getRecordData(db, 'resources', 'res-1', 'id') as Record<string, unknown>;
      const cloudRes = { ...localRes, hash: 'h-2', data: 'Cloud Body', updated_at: 1700000002000 };
      const localNote = getRecordData(db, 'notes', 'note-1', 'id') as Record<string, unknown>;
      const cloudNoteDiffTitle = { ...localNote, title: 'Different Cloud Title', updated_at: '2026-01-02T00:00:00Z' };

      const rL = Number(db.run("INSERT INTO __sync_conflicts (table_name, record_id, side, data_json) VALUES ('resources', 'res-1', 'local', ?1)", [JSON.stringify(localRes)]).lastInsertRowid);
      const rC = Number(db.run("INSERT INTO __sync_conflicts (table_name, record_id, side, data_json) VALUES ('resources', 'res-1', 'cloud', ?1)", [JSON.stringify(cloudRes)]).lastInsertRowid);
      const nL = Number(db.run("INSERT INTO __sync_conflicts (table_name, record_id, side, data_json) VALUES ('notes', 'note-1', 'local', ?1)", [JSON.stringify(localNote)]).lastInsertRowid);
      const nC = Number(db.run("INSERT INTO __sync_conflicts (table_name, record_id, side, data_json) VALUES ('notes', 'note-1', 'cloud', ?1)", [JSON.stringify(cloudNoteDiffTitle)]).lastInsertRowid);

      const mergedRes = { ...localRes, hash: 'h-merged', data: 'Merged Body' };
      resolveRecordConflict(storageFor(db), 'vfs', 'resources', 'res-1', 'merged', JSON.stringify(mergedRes), [rL, rC]);

      // notes conflict MUST stay open because title differed, and resolving it next MUST succeed!
      expect(Number(db.pluck<number>("SELECT COUNT(*) FROM __sync_conflicts WHERE table_name = 'notes' AND resolved_at IS NULL"))).toBe(2);
      resolveRecordConflict(storageFor(db), 'vfs', 'notes', 'note-1', 'keep_cloud', null, [nL, nC]);
      expect(db.pluck<string>('SELECT title FROM notes WHERE id = ?1', ['note-1'])).toBe('Different Cloud Title');
      expect(Number(db.pluck<number>('SELECT COUNT(*) FROM __sync_conflicts WHERE resolved_at IS NULL'))).toBe(0);
    }

    {
      const db = createPairedDb();
      db.run("INSERT INTO resources (id, hash, data, created_at, updated_at) VALUES ('res-eq', 'h-1', 'Local Body', 1700000000000, 1700000001000)");
      db.run("INSERT INTO notes (id, resource_id, title, tags, props, created_at, updated_at) VALUES ('note-eq', 'res-eq', 'Same Title', '[\"math\"]', '{\"a\":1,\"b\":2}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')");
      const localRes = getRecordData(db, 'resources', 'res-eq', 'id') as Record<string, unknown>;
      const cloudRes = { ...localRes, hash: 'h-2', data: 'Cloud Body', updated_at: 1700000002000 };
      const localNote = getRecordData(db, 'notes', 'note-eq', 'id') as Record<string, unknown>;
      const cloudNoteSameMeta = { ...localNote, props: '{"b":2,"a":1}', updated_at: '2026-01-02T00:00:00Z' };

      const rL = Number(db.run("INSERT INTO __sync_conflicts (table_name, record_id, side, data_json) VALUES ('resources', 'res-eq', 'local', ?1)", [JSON.stringify(localRes)]).lastInsertRowid);
      const rC = Number(db.run("INSERT INTO __sync_conflicts (table_name, record_id, side, data_json) VALUES ('resources', 'res-eq', 'cloud', ?1)", [JSON.stringify(cloudRes)]).lastInsertRowid);
      db.run("INSERT INTO __sync_conflicts (table_name, record_id, side, data_json) VALUES ('notes', 'note-eq', 'local', ?1)", [JSON.stringify(localNote)]);
      db.run("INSERT INTO __sync_conflicts (table_name, record_id, side, data_json) VALUES ('notes', 'note-eq', 'cloud', ?1)", [JSON.stringify(cloudNoteSameMeta)]);

      const mergedRes = { ...localRes, hash: 'h-merged', data: 'Merged Body' };
      resolveRecordConflict(storageFor(db), 'vfs', 'resources', 'res-eq', 'merged', JSON.stringify(mergedRes), [rL, rC]);

      // Metadata matched semantically -> paired notes conflict auto-resolved cleanly!
      expect(Number(db.pluck<number>('SELECT COUNT(*) FROM __sync_conflicts WHERE resolved_at IS NULL'))).toBe(0);
    }
  });
});
