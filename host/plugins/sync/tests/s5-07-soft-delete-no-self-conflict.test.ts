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
import { MemoryStorage } from '../../sync-providers/tests/memory_storage.ts'; // boundary-allow cross-plugin-impl: test harness shares MemoryStorage fake
import { configureNotesRepository } from '../../notes/repository/notes.ts';
import type { CloudStorage, SyncAuditRequest } from '../../backup/api.ts';

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
  const dir = mkdtempSync(join(tmpdir(), `s5-07-${deviceId}-`));
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
        exitMaintenanceMode: () => undefined,
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

describe('S5-07 soft-delete self-conflict and hard-purge tombstone sync regressions', () => {
  it('S5-07 full lifecycle: peer indexing/ref_count echo never triggers false self-conflict on A soft-delete, Trash/restore roundtrips cleanly, and hard-purge deletes on B without resurrection', async () => {
    const cloud = new MemoryStorage('webdav');
    const devA = await initDevice('dev-a-s507-full', cloud);
    const devB = await initDevice('dev-b-s507-full', cloud);

    // 1. Device A creates note and syncs
    const noteId = await onDevice(devA, async ({ host }) => {
      const created = await host.invoke<{ id: string }>('notes_create', {
        note: {
          title: 'S507_跨机软删再救回',
          content_md: '这是用户A在11月25日创建的测试笔记，用于验证跨机软删与彻底删除同步。',
        },
      });
      const pushA1 = await host.invoke<SyncResponse>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(pushA1).toMatchObject({ success: true, conflicts_detected: 0, skipped_changes: 0, error_message: null });
      return created.id;
    });

    // 2. Device B syncs, runs background indexing (`index_state='indexed'`) + `ref_count` mutation on `resources`, AND syncs back to cloud!
    await onDevice(devB, async ({ host, storage }) => {
      const pullB1 = await host.invoke<SyncResponse>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(pullB1).toMatchObject({ success: true, conflicts_detected: 0, skipped_changes: 0, error_message: null });

      const vfs = storage.database('vfs');
      const noteRow = vfs.get<{ resource_id: string }>('SELECT resource_id FROM notes WHERE id = ?1', [noteId])!;
      expect(noteRow?.resource_id).toBeTruthy();

      // Simulate Device B background indexer + ref_count trigger writing derived columns on resources
      vfs.run(
        "UPDATE resources SET index_state = 'indexed', indexed_at = ?1, ref_count = COALESCE(ref_count, 1) WHERE id = ?2",
        [Date.now(), noteRow.resource_id],
      );

      // Device B syncs -> uploads the derived-column resources echo to cloud!
      const pushBIndex = await host.invoke<SyncResponse>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(pushBIndex).toMatchObject({ success: true, conflicts_detected: 0, skipped_changes: 0, error_message: null });
    });

    // 3. Device A soft-deletes the note (`移至回收站`) and clicks `立即同步` -> MUST have 0 conflicts on Device A!
    await onDevice(devA, async ({ host }) => {
      await host.invoke('notes_delete', { id: noteId });

      const syncA2 = await host.invoke<SyncResponse>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      const conflictsA = await host.invoke<unknown[]>('data_governance_list_record_conflicts', {});
      const statusA = await host.invoke<{ total_pending_changes: number }>('data_governance_get_sync_status', {});
      expect({ syncA2, conflictsA, statusA }).toMatchObject({
        syncA2: { success: true, conflicts_detected: 0, skipped_changes: 0, error_message: null },
        conflictsA: [],
        statusA: { total_pending_changes: 0 },
      });
    });

    // 4. Device B syncs -> MUST have 0 conflicts on B and note MUST be in B's Trash!
    await onDevice(devB, async ({ host, storage }) => {
      // Even if B had another local background index tick pending before pulling A's soft-delete:
      const vfs = storage.database('vfs');
      const noteRow = vfs.get<{ resource_id: string }>('SELECT resource_id FROM notes WHERE id = ?1', [noteId])!;
      vfs.run("UPDATE resources SET index_state = 'indexed', indexed_at = ?1 WHERE id = ?2", [Date.now(), noteRow.resource_id]);

      const syncB2 = await host.invoke<SyncResponse>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      const conflictsB = await host.invoke<unknown[]>('data_governance_list_record_conflicts', {});
      expect({ syncB2, conflictsB }).toMatchObject({
        syncB2: { success: true, conflicts_detected: 0, skipped_changes: 0, error_message: null },
        conflictsB: [],
      });

      const activeB = await host.invoke<Array<{ id: string }>>('notes_list', {});
      const trashB = await host.invoke<{ items: Array<{ id: string }>; total: number }>('notes_list_deleted', {});
      expect(activeB.some(n => n.id === noteId)).toBe(false);
      expect(trashB.items.some(n => n.id === noteId)).toBe(true);

      // 5. Device B restores the note from Trash and syncs!
      await host.invoke('notes_restore', { id: noteId });
      const pushBRestore = await host.invoke<SyncResponse>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(pushBRestore).toMatchObject({ success: true, conflicts_detected: 0, skipped_changes: 0, error_message: null });
    });

    // 6. Device A syncs -> note MUST be restored on A with 0 conflicts!
    await onDevice(devA, async ({ host }) => {
      const pullARestore = await host.invoke<SyncResponse>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      const conflictsA = await host.invoke<unknown[]>('data_governance_list_record_conflicts', {});
      expect({ pullARestore, conflictsA }).toMatchObject({
        pullARestore: { success: true, conflicts_detected: 0, skipped_changes: 0, error_message: null },
        conflictsA: [],
      });

      const activeA = await host.invoke<Array<{ id: string }>>('notes_list', {});
      const trashA = await host.invoke<{ items: Array<{ id: string }>; total: number }>('notes_list_deleted', {});
      expect(activeA.some(n => n.id === noteId)).toBe(true);
      expect(trashA.items.some(n => n.id === noteId)).toBe(false);

      // 7. Device A soft-deletes + hard-purges the note and syncs!
      await host.invoke('notes_delete', { id: noteId });
      await host.invoke('notes_hard_delete', { id: noteId });

      const pushAPurge = await host.invoke<SyncResponse>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      const conflictsAfterPurgeA = await host.invoke<unknown[]>('data_governance_list_record_conflicts', {});
      expect({ pushAPurge, conflictsAfterPurgeA }).toMatchObject({
        pushAPurge: { success: true, conflicts_detected: 0, skipped_changes: 0, error_message: null },
        conflictsAfterPurgeA: [],
      });
    });

    // 8. Device B syncs (even with pending background index echo on B's resource!) -> note MUST be hard-purged on B (gone from active AND Trash, 0 conflicts, never resurrects!)
    await onDevice(devB, async ({ host, storage }) => {
      const vfs = storage.database('vfs');
      const noteRow = vfs.get<{ resource_id: string }>('SELECT resource_id FROM notes WHERE id = ?1', [noteId]);
      if (noteRow?.resource_id) {
        vfs.run("UPDATE resources SET index_state = 'indexed', indexed_at = ?1 WHERE id = ?2", [Date.now(), noteRow.resource_id]);
      }

      const pullBPurge = await host.invoke<SyncResponse>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      const conflictsB = await host.invoke<unknown[]>('data_governance_list_record_conflicts', {});
      const quarantineB = await host.invoke<unknown[]>('data_governance_list_quarantine', {});
      expect({ pullBPurge, conflictsB, quarantineB }).toMatchObject({
        pullBPurge: { success: true, conflicts_detected: 0, skipped_changes: 0, error_message: null },
        conflictsB: [],
        quarantineB: [],
      });

      const activeB = await host.invoke<Array<{ id: string }>>('notes_list', {});
      const trashB = await host.invoke<{ items: Array<{ id: string }>; total: number }>('notes_list_deleted', {});
      expect(activeB.some(n => n.id === noteId)).toBe(false);
      expect(trashB.items.some(n => n.id === noteId)).toBe(false);
      expect(vfs.get('SELECT id FROM notes WHERE id = ?1', [noteId])).toBeUndefined();

      // Re-syncing must never resurrect the hard-purged note
      const resyncB = await host.invoke<SyncResponse>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(resyncB).toMatchObject({ success: true, conflicts_detected: 0, skipped_changes: 0, error_message: null });
      expect(vfs.get('SELECT id FROM notes WHERE id = ?1', [noteId])).toBeUndefined();
    });

    // 9. Device A re-syncs -> still hard-purged, never resurrected, 0 conflicts!
    await onDevice(devA, async ({ host, storage }) => {
      const resyncA = await host.invoke<SyncResponse>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(resyncA).toMatchObject({ success: true, conflicts_detected: 0, skipped_changes: 0, error_message: null });
      expect(storage.database('vfs').get('SELECT id FROM notes WHERE id = ?1', [noteId])).toBeUndefined();
    });
  }, 120000);

  it('S5-07 hard-purge from Trash propagates when B already has the note soft-deleted in Trash', async () => {
    const cloud = new MemoryStorage('webdav');
    const devA = await initDevice('dev-a-s507-trash-purge', cloud);
    const devB = await initDevice('dev-b-s507-trash-purge', cloud);

    const noteId = await onDevice(devA, async ({ host }) => {
      const created = await host.invoke<{ id: string }>('notes_create', {
        note: { title: 'Trash Then Purge', content_md: 'Delete me permanently' },
      });
      await host.invoke('data_governance_run_sync_with_progress', { direction: 'bidirectional', strategy: 'keep_latest' });
      return created.id;
    });

    await onDevice(devB, async ({ host }) => {
      await host.invoke('data_governance_run_sync_with_progress', { direction: 'bidirectional', strategy: 'keep_latest' });
    });

    // A soft-deletes -> syncs -> B syncs (note now sits in B's Trash with deleted_at != null)
    await onDevice(devA, async ({ host }) => {
      await host.invoke('notes_delete', { id: noteId });
      const res = await host.invoke<SyncResponse>('data_governance_run_sync_with_progress', { direction: 'bidirectional', strategy: 'keep_latest' });
      expect(res).toMatchObject({ success: true, conflicts_detected: 0, skipped_changes: 0 });
    });

    await onDevice(devB, async ({ host }) => {
      const res = await host.invoke<SyncResponse>('data_governance_run_sync_with_progress', { direction: 'bidirectional', strategy: 'keep_latest' });
      expect(res).toMatchObject({ success: true, conflicts_detected: 0, skipped_changes: 0 });
      const trashB = await host.invoke<{ items: Array<{ id: string }> }>('notes_list_deleted', {});
      expect(trashB.items.some(n => n.id === noteId)).toBe(true);
    });

    // A hard-purges from Trash -> syncs -> B syncs -> B's Trash MUST now be empty!
    await onDevice(devA, async ({ host }) => {
      await host.invoke('notes_hard_delete', { id: noteId });
      const res = await host.invoke<SyncResponse>('data_governance_run_sync_with_progress', { direction: 'bidirectional', strategy: 'keep_latest' });
      expect(res).toMatchObject({ success: true, conflicts_detected: 0, skipped_changes: 0 });
    });

    await onDevice(devB, async ({ host, storage }) => {
      const res = await host.invoke<SyncResponse>('data_governance_run_sync_with_progress', { direction: 'bidirectional', strategy: 'keep_latest' });
      const conflicts = await host.invoke<unknown[]>('data_governance_list_record_conflicts', {});
      expect({ res, conflicts }).toMatchObject({
        res: { success: true, conflicts_detected: 0, skipped_changes: 0, error_message: null },
        conflicts: [],
      });
      const trashB = await host.invoke<{ items: Array<{ id: string }> }>('notes_list_deleted', {});
      expect(trashB.items.some(n => n.id === noteId)).toBe(false);
      expect(storage.database('vfs').get('SELECT id FROM notes WHERE id = ?1', [noteId])).toBeUndefined();
    });
  }, 120000);
});
