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
});
