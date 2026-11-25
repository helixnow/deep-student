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

const dirs: string[] = [];

afterEach(() => {
  configureNotesRepository(null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function initDevice(deviceId: string, cloud: MemoryStorage): Promise<DeviceSpec> {
  const dir = mkdtempSync(join(tmpdir(), `s5-05-${deviceId}-`));
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
  options?: { createStorage?: () => Promise<CloudStorage> },
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
        createStorage: options?.createStorage ?? (async () => spec.cloud as unknown as CloudStorage),
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

describe('S5-05, S5-02, S5-07, S5-08 two-device sync regressions', () => {
  it('S5-05 & S5-02: converges Device A and Device B cleanly after manual merge (cloudSide base) across repeated syncs with zero incomplete skips', async () => {
    const cloud = new MemoryStorage('webdav');
    const devA = await initDevice('dev-a-111111', cloud);
    const devB = await initDevice('dev-b-222222', cloud);

    // 1. Device A creates note and pushes initial baseline to cloud; Device B pulls baseline.
    const noteId = await onDevice(devA, async ({ host }) => {
      const created = await host.invoke<{ id: string }>('notes_create', {
        note: { title: 'Concurrent Note', content_md: 'Initial Body' },
      });
      const initPush = await host.invoke<{ success: boolean; skipped_changes?: number; error_message?: string | null }>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(initPush).toMatchObject({ success: true, error_message: null, skipped_changes: 0 });
      return created.id;
    });

    await onDevice(devB, async ({ host }) => {
      const initPull = await host.invoke<{ success: boolean; skipped_changes?: number; error_message?: string | null }>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(initPull).toMatchObject({ success: true, error_message: null, skipped_changes: 0 });
    });

    // 2. Device A edits offline (multiple edits -> supersedes intermediate resources & revisions) and syncs
    let aOnlyUpdatedAt = '';
    await onDevice(devA, async ({ host }) => {
      const a1 = await host.invoke<{ updated_at: string }>('notes_update', {
        note: { id: noteId, content_md: 'A_DRAFT_1' },
      });
      const a2 = await host.invoke<{ updated_at: string }>('notes_update', {
        note: { id: noteId, content_md: 'A_ONLY' },
      });
      expect(a2.updated_at).not.toBe(a1.updated_at);
      aOnlyUpdatedAt = a2.updated_at;

      const pushA = await host.invoke<{ success: boolean; skipped_changes?: number; error_message?: string | null }>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(pushA).toMatchObject({ success: true, error_message: null, skipped_changes: 0 });
    });

    // 3. Device B edits offline (multiple edits) and syncs -> detects conflict on notes
    let mergedUpdatedAtB = '';
    await onDevice(devB, async ({ host, storage }) => {
      await host.invoke('notes_update', {
        note: { id: noteId, content_md: 'B_DRAFT_1' },
      });
      await host.invoke('notes_update', {
        note: { id: noteId, content_md: 'B_ONLY' },
      });

      const syncB1 = await host.invoke<{ success: boolean; conflicts_detected: number; skipped_changes?: number; error_message?: string | null }>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(syncB1.success).toBe(true);
      expect(syncB1.skipped_changes).toBe(0);
      expect(syncB1.conflicts_detected).toBeGreaterThanOrEqual(1);

      const bConflicts = await host.invoke<Array<{
        id: number;
        database_name: string;
        table_name: string;
        record_id: string;
        side: string;
        data_json: string;
      }>>('data_governance_list_record_conflicts', {});
      const noteConflicts = bConflicts.filter(c => c.table_name === 'notes' && c.record_id === noteId);
      expect(noteConflicts.length).toBeGreaterThanOrEqual(2);

      const cloudSide = JSON.parse(noteConflicts.find(c => c.side === 'cloud')!.data_json) as Record<string, unknown>;
      expect(cloudSide.content_md).toBe('A_ONLY');

      // 4. Device B resolves conflict via 'merged' (writing 'B_ONLY\nA_ONLY') and syncs
      const mergedPayload = JSON.stringify({
        ...cloudSide,
        content_md: 'B_ONLY\nA_ONLY',
      });
      await host.invoke('data_governance_resolve_record_conflict', {
        databaseName: 'vfs',
        tableName: 'notes',
        recordId: noteId,
        resolution: 'merged',
        mergedDataJson: mergedPayload,
        expectedConflictIds: noteConflicts.map(c => c.id),
      });

      // Verify resources.updated_at remains SQLite INTEGER (not corrupted to TEXT ISO string)
      const vfs = storage.database('vfs');
      const resType = vfs.pluck<string>(
        'SELECT typeof(r.updated_at) FROM resources r JOIN notes n ON n.resource_id = r.id WHERE n.id = ?1',
        [noteId],
      );
      expect(resType).toBe('integer');

      const syncB2 = await host.invoke<{ success: boolean; changes_uploaded: number; skipped_changes?: number; error_message?: string | null }>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(syncB2).toMatchObject({ success: true, error_message: null, skipped_changes: 0 });
      expect(syncB2.changes_uploaded).toBeGreaterThanOrEqual(2);

      const noteB = await host.invoke<{ content_md: string; updated_at: string }>('notes_get', { id: noteId });
      expect(noteB.content_md).toBe('B_ONLY\nA_ONLY');
      mergedUpdatedAtB = noteB.updated_at;
    });

    // 5. Device A syncs 3 times (exact S5-05 reproduction) -> MUST converge to 'B_ONLY\nA_ONLY' with 0 skipped & updated_at advanced!
    await onDevice(devA, async ({ host }) => {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const syncA = await host.invoke<{
          success: boolean;
          changes_downloaded: number;
          conflicts_detected: number;
          skipped_changes?: number;
          error_message?: string | null;
        }>('data_governance_run_sync_with_progress', {
          direction: 'bidirectional',
          strategy: 'keep_latest',
        });
        expect(syncA).toMatchObject({
          success: true,
          skipped_changes: 0,
          error_message: null,
          conflicts_detected: 0,
        });
      }

      const statusA = await host.invoke<{ total_pending_changes: number }>('data_governance_get_sync_status', {});
      expect(statusA.total_pending_changes).toBe(0);
      const conflictsA = await host.invoke<unknown[]>('data_governance_list_record_conflicts', {});
      expect(conflictsA).toEqual([]);
      const quarantineA = await host.invoke<unknown[]>('data_governance_list_quarantine', {});
      expect(quarantineA).toEqual([]);

      const noteA = await host.invoke<{ content_md: string; updated_at: string }>('notes_get', { id: noteId });
      expect(noteA.content_md).toBe('B_ONLY\nA_ONLY');
      expect(noteA.updated_at).not.toBe(aOnlyUpdatedAt);
      expect(noteA.updated_at).toBe(mergedUpdatedAtB);
    });
  }, 120000);

  it('S5-05: converges when Cloud won LWW (T_A > T_B) and User B merges on localSide (desiredState / missing cloud resource paths)', async () => {
    const cloud = new MemoryStorage('webdav');
    const devA = await initDevice('dev-a-localbase', cloud);
    const devB = await initDevice('dev-b-localbase', cloud);

    const noteId = await onDevice(devA, async ({ host }) => {
      const created = await host.invoke<{ id: string }>('notes_create', {
        note: { title: 'Clock Skew Note', content_md: 'Base' },
      });
      await host.invoke('data_governance_run_sync_with_progress', { direction: 'bidirectional', strategy: 'keep_latest' });
      return created.id;
    });

    await onDevice(devB, async ({ host }) => {
      await host.invoke('data_governance_run_sync_with_progress', { direction: 'bidirectional', strategy: 'keep_latest' });
      // User B edits FIRST (older timestamp T_B)
      await host.invoke('notes_update', { note: { id: noteId, content_md: 'B_FIRST' } });
    });

    await new Promise(resolve => setTimeout(resolve, 15));

    await onDevice(devA, async ({ host }) => {
      // User A edits SECOND (newer timestamp T_A > T_B) and pushes to cloud
      await host.invoke('notes_update', { note: { id: noteId, content_md: 'A_LATER' } });
      const pushA = await host.invoke<{ success: boolean }>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(pushA.success).toBe(true);
    });

    await onDevice(devB, async ({ host }) => {
      const syncB1 = await host.invoke<{ success: boolean; conflicts_detected: number }>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(syncB1.success).toBe(true);
      expect(syncB1.conflicts_detected).toBeGreaterThanOrEqual(1);

      const conflicts = await host.invoke<Array<{ id: number; table_name: string; record_id: string; side: string; data_json: string }>>('data_governance_list_record_conflicts', {});
      const noteConflicts = conflicts.filter(c => c.table_name === 'notes' && c.record_id === noteId);
      const localSide = JSON.parse(noteConflicts.find(c => c.side === 'local')!.data_json) as Record<string, unknown>;
      expect(localSide.content_md).toBe('B_FIRST');

      // User B chooses localSide metadata + merged body (triggers desiredState / markResolvedWithoutWrite!)
      await host.invoke('data_governance_resolve_record_conflict', {
        databaseName: 'vfs',
        tableName: 'notes',
        recordId: noteId,
        resolution: 'merged',
        mergedDataJson: JSON.stringify({ ...localSide, content_md: 'B_FIRST + A_LATER' }),
        expectedConflictIds: noteConflicts.map(c => c.id),
      });

      const syncB2 = await host.invoke<{ success: boolean; skipped_changes?: number; error_message?: string | null }>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(syncB2).toMatchObject({ success: true, skipped_changes: 0, error_message: null });
    });

    await onDevice(devA, async ({ host }) => {
      const syncA2 = await host.invoke<{ success: boolean; conflicts_detected: number; skipped_changes?: number; error_message?: string | null }>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(syncA2).toMatchObject({ success: true, conflicts_detected: 0, skipped_changes: 0, error_message: null });
      const noteA = await host.invoke<{ content_md: string }>('notes_get', { id: noteId });
      expect(noteA.content_md).toBe('B_FIRST + A_LATER');
    });
  }, 120000);

  it('S5-05: converges Device A and Device B cleanly for both keep_local and keep_cloud (use_cloud) resolutions with 0 skipped records and matching updated_at', async () => {
    for (const mode of ['keep_local', 'keep_cloud'] as const) {
      const cloud = new MemoryStorage('webdav');
      const devA = await initDevice(`dev-a-${mode}`, cloud);
      const devB = await initDevice(`dev-b-${mode}`, cloud);

      const noteId = await onDevice(devA, async ({ host }) => {
        const created = await host.invoke<{ id: string }>('notes_create', {
          note: { title: `Conflict ${mode}`, content_md: 'Shared Base' },
        });
        const initPush = await host.invoke<{ success: boolean; skipped_changes?: number }>('data_governance_run_sync_with_progress', {
          direction: 'bidirectional',
          strategy: 'keep_latest',
        });
        expect(initPush).toMatchObject({ success: true, skipped_changes: 0 });
        return created.id;
      });

      await onDevice(devB, async ({ host }) => {
        const initPull = await host.invoke<{ success: boolean; skipped_changes?: number }>('data_governance_run_sync_with_progress', {
          direction: 'bidirectional',
          strategy: 'keep_latest',
        });
        expect(initPull).toMatchObject({ success: true, skipped_changes: 0 });
      });

      // Divergent edits on Device A and Device B
      await onDevice(devA, async ({ host }) => {
        await host.invoke('notes_update', { note: { id: noteId, content_md: `A_CONTENT_${mode}` } });
        const pushA = await host.invoke<{ success: boolean; skipped_changes?: number }>('data_governance_run_sync_with_progress', {
          direction: 'bidirectional',
          strategy: 'keep_latest',
        });
        expect(pushA).toMatchObject({ success: true, skipped_changes: 0 });
      });

      let resolvedUpdatedAtB = '';
      const expectedBody = mode === 'keep_local' ? `B_CONTENT_${mode}` : `A_CONTENT_${mode}`;
      await onDevice(devB, async ({ host, storage }) => {
        await host.invoke('notes_update', { note: { id: noteId, content_md: `B_CONTENT_${mode}` } });
        const syncB1 = await host.invoke<{ success: boolean; conflicts_detected: number; skipped_changes?: number }>('data_governance_run_sync_with_progress', {
          direction: 'bidirectional',
          strategy: 'keep_latest',
        });
        expect(syncB1.success).toBe(true);
        expect(syncB1.skipped_changes).toBe(0);
        expect(syncB1.conflicts_detected).toBeGreaterThanOrEqual(1);

        const conflicts = await host.invoke<Array<{ id: number; table_name: string; record_id: string }>>('data_governance_list_record_conflicts', {});
        const noteConflicts = conflicts.filter(c => c.table_name === 'notes' && c.record_id === noteId);
        expect(noteConflicts.length).toBeGreaterThanOrEqual(2);

        await host.invoke('data_governance_resolve_record_conflict', {
          databaseName: 'vfs',
          tableName: 'notes',
          recordId: noteId,
          resolution: mode,
          mergedDataJson: null,
          expectedConflictIds: noteConflicts.map(c => c.id),
        });

        // Verify pending changes include notes + resources + note_document_formats before upload
        const vfs = storage.database('vfs');
        const pendingTables = new Set(
          vfs.all<{ table_name: string }>('SELECT DISTINCT table_name FROM __change_log WHERE sync_version = 0').map(r => r.table_name),
        );
        expect(pendingTables.has('notes')).toBe(true);
        expect(pendingTables.has('resources')).toBe(true);
        expect(pendingTables.has('note_document_formats')).toBe(true);

        const syncB2 = await host.invoke<{ success: boolean; changes_uploaded: number; conflicts_detected: number; skipped_changes?: number; error_message?: string | null }>('data_governance_run_sync_with_progress', {
          direction: 'bidirectional',
          strategy: 'keep_latest',
        });
        expect(syncB2).toMatchObject({ success: true, conflicts_detected: 0, skipped_changes: 0, error_message: null });
        expect(syncB2.changes_uploaded).toBeGreaterThanOrEqual(3);

        const noteB = await host.invoke<{ content_md: string; updated_at: string }>('notes_get', { id: noteId });
        expect(noteB.content_md).toBe(expectedBody);
        resolvedUpdatedAtB = noteB.updated_at;
      });

      // Device A syncs twice -> MUST converge to exact resolved content & updated_at with 0 conflicts & 0 skipped!
      await onDevice(devA, async ({ host }) => {
        for (let pass = 0; pass < 2; pass += 1) {
          const syncA = await host.invoke<{ success: boolean; conflicts_detected: number; skipped_changes?: number; error_message?: string | null }>('data_governance_run_sync_with_progress', {
            direction: 'bidirectional',
            strategy: 'keep_latest',
          });
          expect(syncA).toMatchObject({ success: true, conflicts_detected: 0, skipped_changes: 0, error_message: null });
        }
        const conflictsA = await host.invoke<unknown[]>('data_governance_list_record_conflicts', {});
        const quarantineA = await host.invoke<unknown[]>('data_governance_list_quarantine', {});
        const statusA = await host.invoke<{ total_pending_changes: number }>('data_governance_get_sync_status', {});
        expect(conflictsA).toEqual([]);
        expect(quarantineA).toEqual([]);
        expect(statusA.total_pending_changes).toBe(0);

        const noteA = await host.invoke<{ content_md: string; updated_at: string }>('notes_get', { id: noteId });
        expect(noteA.content_md).toBe(expectedBody);
        expect(noteA.updated_at).toBe(resolvedUpdatedAtB);
      });
    }
  }, 120000);

  it('S5-07: soft-deleting a note on Device A moves it cleanly to Trash on Device B (zero false conflict), restoring on B revives it on A, while genuine local edits still raise trash-vs-edit conflict', async () => {
    const cloud = new MemoryStorage('webdav');
    const devA = await initDevice('dev-a-s507', cloud);
    const devB = await initDevice('dev-b-s507', cloud);

    const { noteCleanId, noteEditedId } = await onDevice(devA, async ({ host }) => {
      const n1 = await host.invoke<{ id: string }>('notes_create', {
        note: { title: 'Trash Roundtrip Note', content_md: 'Shared Body' },
      });
      const n2 = await host.invoke<{ id: string }>('notes_create', {
        note: { title: 'Divergent Edit Note', content_md: 'Initial v1' },
      });
      await host.invoke('data_governance_run_sync_with_progress', { direction: 'bidirectional', strategy: 'keep_latest' });
      return { noteCleanId: n1.id, noteEditedId: n2.id };
    });

    // Device B pulls both notes; background indexer updates local-derived index_state on noteCleanId's resource,
    // while User B genuinely edits noteEditedId offline.
    await onDevice(devB, async ({ host, storage }) => {
      const pull = await host.invoke<{ success: boolean }>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(pull.success).toBe(true);
      const vfs = storage.database('vfs');
      const noteRow = vfs.get<{ resource_id: string }>('SELECT resource_id FROM notes WHERE id = ?1', [noteCleanId])!;
      vfs.run("UPDATE resources SET index_state = 'indexed', indexed_at = ?1 WHERE id = ?2", [Date.now(), noteRow.resource_id]);

      await host.invoke('notes_update', {
        note: { id: noteEditedId, content_md: 'User B Unsynced Local Edit' },
      });
    });

    // Device A moves BOTH notes to Trash and syncs
    await onDevice(devA, async ({ host }) => {
      await host.invoke('notes_delete', { id: noteCleanId });
      await host.invoke('notes_delete', { id: noteEditedId });
      const pushDel = await host.invoke<{ success: boolean }>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(pushDel.success).toBe(true);
    });

    // Device B syncs -> noteCleanId MUST move to Trash with 0 conflict, while noteEditedId MUST raise conflict!
    await onDevice(devB, async ({ host }) => {
      const pullDel = await host.invoke<{ success: boolean; conflicts_detected: number; skipped_changes?: number; error_message?: string | null }>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(pullDel.success).toBe(true);
      expect(pullDel.skipped_changes).toBe(0);

      const conflicts = await host.invoke<Array<{ table_name: string; record_id: string }>>('data_governance_list_record_conflicts', {});
      expect(conflicts.filter(c => c.record_id === noteCleanId)).toEqual([]);
      expect(conflicts.filter(c => c.table_name === 'notes' && c.record_id === noteEditedId).length).toBeGreaterThanOrEqual(2);

      const activeNotes = await host.invoke<Array<{ id: string }>>('notes_list', {});
      const trashedNotes = await host.invoke<{ items: Array<{ id: string }>; total: number }>('notes_list_deleted', {});
      expect(activeNotes.some(n => n.id === noteCleanId)).toBe(false);
      expect(trashedNotes.items.some(n => n.id === noteCleanId)).toBe(true);
      expect(activeNotes.some(n => n.id === noteEditedId)).toBe(true);

      // Now Device B restores noteCleanId from Trash and syncs!
      await host.invoke('notes_restore', { id: noteCleanId });
      const pushRestore = await host.invoke<{ success: boolean }>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(pushRestore.success).toBe(true);
    });

    // Device A syncs -> noteCleanId MUST return to active list on Device A (not stuck in Trash)!
    await onDevice(devA, async ({ host }) => {
      const pullRestore = await host.invoke<{ success: boolean; conflicts_detected: number; skipped_changes?: number; error_message?: string | null }>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      const conflictsOnA = await host.invoke<unknown[]>('data_governance_list_record_conflicts', {});
      expect({ pullRestore, conflictsOnA }).toMatchObject({
        pullRestore: { success: true, conflicts_detected: 0, skipped_changes: 0, error_message: null },
        conflictsOnA: [],
      });
      const activeNotes = await host.invoke<Array<{ id: string }>>('notes_list', {});
      const trashedNotes = await host.invoke<{ items: Array<{ id: string }>; total: number }>('notes_list_deleted', {});
      expect(activeNotes.some(n => n.id === noteCleanId)).toBe(true);
      expect(trashedNotes.items.some(n => n.id === noteCleanId)).toBe(false);
    });
  }, 120000);

  it('S5-08: records failed sync audit entries with duration and error message on network/503/socket-hang-up failures across preflight, progress, and plain sync', async () => {
    const cloud = new MemoryStorage('webdav');
    const devA = await initDevice('dev-a-s508', cloud);

    // 1. Preflight detectPruneGap failing with socket hang up records failed audit entry
    await onDevice(
      devA,
      async ({ host }) => {
        await expect(
          host.invoke('data_governance_detect_prune_gap', {
            cloudConfig: { provider: 'webdav', root: 'sync', webdav: { endpoint: 'https://dav.example.com', username: 'u', password: '' } },
          }),
        ).rejects.toThrow(/socket hang up/);
      },
      {
        createStorage: async () => ({
          providerName: () => 'webdav',
          instanceBindingHint: () => 'sync',
          get: async () => { throw new Error('Network error: socket hang up'); },
          listOutcome: async () => { throw new Error('Network error: socket hang up'); },
        }) as unknown as CloudStorage,
      },
    );

    const preflightFailed = devA.audits.filter(a => a.outcome.kind === 'failed');
    expect(preflightFailed).toHaveLength(1);
    expect(preflightFailed[0]?.outcome).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('socket hang up'),
      durationMs: expect.any(Number),
    });

    // 2. runSyncWithProgress failing with HTTP 503 exhausted records failed audit entry with durationMs
    devA.audits.length = 0;
    await onDevice(
      devA,
      async ({ host }) => {
        await expect(
          host.invoke('data_governance_run_sync_with_progress', {
            direction: 'bidirectional',
            strategy: 'keep_latest',
          }),
        ).rejects.toThrow(/HTTP 503/);
      },
      {
        createStorage: async () => ({
          providerName: () => 'webdav',
          instanceBindingHint: () => 'sync',
          get: async () => { throw new Error('WebDAV GET failed (retried 3 times): HTTP 503 Service Unavailable'); },
          listOutcome: async () => { throw new Error('WebDAV PROPFIND failed: HTTP 503 Service Unavailable'); },
        }) as unknown as CloudStorage,
      },
    );

    const progressFailed = devA.audits.filter(a => a.outcome.kind === 'failed');
    expect(progressFailed).toHaveLength(1);
    expect(progressFailed[0]?.target).toBe('cloud_sync/bidirectional');
    expect(progressFailed[0]?.outcome).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('HTTP 503'),
      durationMs: expect.any(Number),
    });

    // 3. runSync (plain) failing with socket hang up records failed audit entry with durationMs
    devA.audits.length = 0;
    await onDevice(
      devA,
      async ({ host }) => {
        await expect(
          host.invoke('data_governance_run_sync', {
            direction: 'upload',
            strategy: 'keep_latest',
          }),
        ).rejects.toThrow(/socket hang up/);
      },
      {
        createStorage: async () => ({
          providerName: () => 'webdav',
          instanceBindingHint: () => 'sync',
          get: async () => { throw new Error('socket hang up'); },
          listOutcome: async () => { throw new Error('socket hang up'); },
        }) as unknown as CloudStorage,
      },
    );

    const plainFailed = devA.audits.filter(a => a.outcome.kind === 'failed');
    expect(plainFailed).toHaveLength(1);
    expect(plainFailed[0]?.target).toBe('cloud_sync/upload');
    expect(plainFailed[0]?.outcome).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('socket hang up'),
      durationMs: expect.any(Number),
    });
  }, 120000);
});
