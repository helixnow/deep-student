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
import type { SyncAuditRequest } from '../../backup/api.ts';
import type { CloudStorage } from '../../sync-providers/api.ts';
import { collectSyncChanges } from '../src/collect-sync-changes.ts';
import { setLocalRuntime } from '../src/local-runtime.ts';
import { nodeLocalRuntime } from '../src/local-runtime.node.ts';
import { partitionUploadCandidatesAfterDownload } from '../src/record-progress.ts';
import { getPendingBreakdown } from '../src/status.ts';
import type { EngineChange } from '../src/change-payload.ts';

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
  const dir = mkdtempSync(join(tmpdir(), `sync-converge-${deviceId}-`));
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

describe('G30 download-superseded and non-RowSync pending count convergence to 0', () => {
  it('partitions download-superseded changes separately from deferred conflicts without marking deferred conflict rows', () => {
    const mkChange = (
      id: number,
      table_name: string,
      record_id: string,
      data: EngineChange['data'] = { id: record_id },
    ): EngineChange => ({
      table_name,
      record_id,
      operation: 'Update',
      data,
      changed_at: '2026-11-25T10:00:00Z',
      change_log_id: id,
      database_name: 'vfs',
      suppress_change_log: null,
      source_device_id: null,
      source_seq: null,
    });

    const enriched: EngineChange[] = [
      mkChange(1, 'notes', 'note-overwritten', { id: 'note-overwritten', resource_id: 'res-overwritten' }),
      mkChange(2, 'resources', 'res-overwritten'),
      mkChange(3, 'notes', 'note-conflict', { id: 'note-conflict', resource_id: 'res-conflict' }),
      mkChange(4, 'resources', 'res-conflict'),
      mkChange(5, 'note_document_formats', 'note-conflict'),
      mkChange(6, 'notes', 'note-local-only', { id: 'note-local-only', resource_id: 'res-local-only' }),
    ];
    const appliedKeys = new Set(['notes\u001fnote-overwritten', 'resources\u001fres-overwritten', 'resources\u001fres-conflict']);
    const deferredConflictKeys = new Set(['notes\u001fnote-conflict']);

    const { toUpload, supersededByDownload } = partitionUploadCandidatesAfterDownload(
      enriched,
      appliedKeys,
      deferredConflictKeys,
    );
    expect(toUpload.map(c => c.change_log_id)).toEqual([6]);
    expect(supersededByDownload.map(c => c.change_log_id)).toEqual([1, 2]);
  });

  it('converges pending changes to 0 across bidirectional progress sync, plain sync, and download sync when remote overwrites local pending rows (even when filtered.length === 0)', async () => {
    for (const command of ['data_governance_run_sync_with_progress', 'data_governance_run_sync'] as const) {
      const cloud = new MemoryStorage('webdav');
      const devA = await initDevice(`dev-a-${command}`, cloud);
      const devB = await initDevice(`dev-b-${command}`, cloud);

      const noteId = await onDevice(devA, async ({ host }) => {
        const created = await host.invoke<{ id: string }>('notes_create', {
          note: { title: 'Converge Note', content_md: 'v1' },
        });
        const push = await host.invoke<SyncResponse>(command, {
          direction: 'bidirectional',
          strategy: 'keep_latest',
        });
        expect(push).toMatchObject({ success: true, error_message: null });
        return created.id;
      });

      await onDevice(devB, async ({ host }) => {
        const pull = await host.invoke<SyncResponse>(command, {
          direction: 'bidirectional',
          strategy: 'keep_latest',
        });
        expect(pull).toMatchObject({ success: true, error_message: null });
      });

      // Device B makes local edits (creating pending RowSync __change_log rows) AND has stale non-RowSync rows
      await onDevice(devB, async ({ host, storage }) => {
        await host.invoke('notes_update', {
          note: { id: noteId, content_md: 'B_LOCAL_SUPERSEDED' },
        });
        const vfs = storage.database('vfs');
        vfs.run(
          "INSERT INTO __change_log (table_name, record_id, operation, sync_version) VALUES ('note_tags', 'n1:tag', 'INSERT', 0), ('qbank_practice_drafts', 'd1', 'UPDATE', 0)",
        );
        const mistakes = storage.database('mistakes');
        mistakes.run(
          "INSERT INTO __change_log (table_name, record_id, operation, sync_version) VALUES ('settings', 'theme', 'UPDATE', 0)",
        );
        const beforeStatus = await host.invoke<{ total_pending_changes: number }>('data_governance_get_sync_status', {});
        expect(beforeStatus.total_pending_changes).toBeGreaterThan(0);
      });

      await new Promise(resolve => setTimeout(resolve, 15));

      // Device A updates the exact same note and pushes to cloud
      await onDevice(devA, async ({ host }) => {
        await host.invoke('notes_update', {
          note: { id: noteId, content_md: 'A_CLOUD_AUTHORITATIVE' },
        });
        const push = await host.invoke<SyncResponse>(command, {
          direction: 'bidirectional',
          strategy: 'keep_latest',
        });
        expect(push).toMatchObject({ success: true, error_message: null });
      });

      // Device B syncs with use_cloud: remote overwrites local note+resource -> filtered.length === 0!
      // All download-superseded local __change_log rows AND stale non-RowSync rows MUST converge to 0!
      await onDevice(devB, async ({ host, storage }) => {
        const sync1 = await host.invoke<SyncResponse>(command, {
          direction: 'bidirectional',
          strategy: 'use_cloud',
        });
        expect(sync1).toMatchObject({
          success: true,
          error_message: null,
        });
        expect(sync1.changes_downloaded).toBeGreaterThan(0);

        const status1 = await host.invoke<{ total_pending_changes: number; has_pending_changes: boolean }>(
          'data_governance_get_sync_status',
          {},
        );
        expect(status1.total_pending_changes).toBe(0);
        expect(status1.has_pending_changes).toBe(false);
        expect(getPendingBreakdown(storage).total_pending_changes).toBe(0);

        // Even raw __change_log must have 0 stuck sync_version=0 rows
        expect(storage.database('vfs').pluck<number>('SELECT COUNT(*) FROM __change_log WHERE sync_version = 0')).toBe(0);
        expect(storage.database('mistakes').pluck<number>('SELECT COUNT(*) FROM __change_log WHERE sync_version = 0')).toBe(0);

        // Second sync stays converged at 0 with 0 uploads
        const sync2 = await host.invoke<SyncResponse>(command, {
          direction: 'bidirectional',
          strategy: 'use_cloud',
        });
        expect(sync2).toMatchObject({ success: true, changes_uploaded: 0, error_message: null });
        const status2 = await host.invoke<{ total_pending_changes: number }>('data_governance_get_sync_status', {});
        expect(status2.total_pending_changes).toBe(0);

        const noteB = await host.invoke<{ content_md: string }>('notes_get', { id: noteId });
        expect(noteB.content_md).toBe('A_CLOUD_AUTHORITATIVE');
      });
    }
  }, 120000);

  it('rolls back marked download-superseded __change_log rows if final manifest upload fails', async () => {
    const cloud = new MemoryStorage('webdav');
    const devA = await initDevice('dev-a-rollback', cloud);
    const devB = await initDevice('dev-b-rollback', cloud);

    const noteId = await onDevice(devA, async ({ host }) => {
      const created = await host.invoke<{ id: string }>('notes_create', {
        note: { title: 'Rollback Note', content_md: 'v1' },
      });
      await host.invoke('data_governance_run_sync_with_progress', { direction: 'bidirectional', strategy: 'keep_latest' });
      return created.id;
    });

    await onDevice(devB, async ({ host }) => {
      await host.invoke('data_governance_run_sync_with_progress', { direction: 'bidirectional', strategy: 'keep_latest' });
      await host.invoke('notes_update', { note: { id: noteId, content_md: 'B_PENDING' } });
    });

    await new Promise(resolve => setTimeout(resolve, 15));

    await onDevice(devA, async ({ host }) => {
      await host.invoke('notes_update', { note: { id: noteId, content_md: 'A_REMOTE' } });
      await host.invoke('data_governance_run_sync_with_progress', { direction: 'bidirectional', strategy: 'keep_latest' });
    });

    // Fail the 2nd device manifest upload (the refreshed manifest upload after markUploadedChanges)
    let devBManifestPuts = 0;
    const flakyStorage = new Proxy(cloud, {
      get(target, prop, receiver) {
        if (prop === 'put') {
          return async (key: string, data: Uint8Array) => {
            if (key.includes('manifests/')) {
              devBManifestPuts += 1;
              if (devBManifestPuts >= 2) {
                throw new Error('WebDAV PUT manifest 失败: HTTP 503 Service Unavailable');
              }
            }
            return target.put(key, data);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as CloudStorage;

    await onDevice(
      devB,
      async ({ host, storage }) => {
        const failed = await host.invoke<SyncResponse>('data_governance_run_sync_with_progress', {
          direction: 'bidirectional',
          strategy: 'use_cloud',
        });
        expect(failed.success).toBe(false);
        expect(failed.error_message ?? '').toContain('上传刷新清单失败');

        // Rollback must restore sync_version = 0 for the superseded rows because manifest upload failed
        const remaining = storage.database('vfs').pluck<number>(
          "SELECT COUNT(*) FROM __change_log WHERE sync_version = 0 AND table_name IN ('notes', 'resources')",
        );
        expect(remaining).toBeGreaterThan(0);
      },
      { createStorage: async () => flakyStorage },
    );
  }, 120000);

  it('collectSyncChanges retires stale non-RowSync pending rows while preserving __plugin_sync_records', async () => {
    // Prior onDevice() calls dispose dstu.sync, which resets localRuntime to null; restore desktop FS port.
    setLocalRuntime(nodeLocalRuntime);
    const dir = mkdtempSync(join(tmpdir(), 'sync-retire-nonrowsync-'));
    dirs.push(dir);
    const storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
    try {
      await storage.migrations.runAll();
      const vfs = storage.database('vfs');
      vfs.run('DELETE FROM __change_log');
      vfs.run(
        `INSERT INTO __change_log (table_name, record_id, operation, sync_version) VALUES
          ('note_tags', 'n1:t1', 'INSERT', 0),
          ('qbank_practice_drafts', 'draft-1', 'UPDATE', 0),
          ('__plugin_sync_records', '["p1","ns","r1"]', 'UPDATE', 0)`,
      );
      const mistakes = storage.database('mistakes');
      mistakes.run('DELETE FROM __change_log');
      mistakes.run(
        `INSERT INTO __change_log (table_name, record_id, operation, sync_version) VALUES
          ('settings', 'lang', 'UPDATE', 0),
          ('search_logs', 's1', 'INSERT', 0)`,
      );

      // Even before collection, status/breakdown ignores non-RowSync rows
      expect(getPendingBreakdown(storage).total_pending_changes).toBe(0);

      const collected = await collectSyncChanges(storage, null);
      expect(collected).toEqual([]);

      // Non-RowSync rows are retired from __change_log; __plugin_sync_records is preserved
      const remainingVfs = vfs.all<{ table_name: string }>(
        'SELECT table_name FROM __change_log WHERE sync_version = 0',
      );
      expect(remainingVfs.map(r => r.table_name)).toEqual(['__plugin_sync_records']);
      expect(mistakes.pluck<number>('SELECT COUNT(*) FROM __change_log WHERE sync_version = 0')).toBe(0);
    } finally {
      storage.dispose();
    }
  });

  it('retires download-superseded notes/resources pending rows on Download-only sync and leaves 0 pending when only overwritten rows changed', async () => {
    const cloud = new MemoryStorage('webdav');
    const devA = await initDevice('dev-a-download-only', cloud);
    const devB = await initDevice('dev-b-download-only', cloud);

    const noteId = await onDevice(devA, async ({ host }) => {
      const created = await host.invoke<{ id: string }>('notes_create', {
        note: { title: 'Download Converge', content_md: 'v1' },
      });
      await host.invoke('data_governance_run_sync_with_progress', { direction: 'bidirectional', strategy: 'keep_latest' });
      return created.id;
    });

    await onDevice(devB, async ({ host, storage }) => {
      await host.invoke('data_governance_run_sync_with_progress', { direction: 'bidirectional', strategy: 'keep_latest' });
      // Simulate local pending edits directly on notes + resources (no extra local-only revision rows)
      const vfs = storage.database('vfs');
      const noteRow = vfs.get<{ resource_id: string }>('SELECT resource_id FROM notes WHERE id = ?1', [noteId])!;
      vfs.run("UPDATE notes SET title = 'B_LOCAL_TITLE' WHERE id = ?1", [noteId]);
      vfs.run("UPDATE resources SET data = 'B_LOCAL_BODY' WHERE id = ?1", [noteRow.resource_id]);
      const before = await host.invoke<{ total_pending_changes: number }>('data_governance_get_sync_status', {});
      expect(before.total_pending_changes).toBeGreaterThanOrEqual(2);
    });

    await new Promise(resolve => setTimeout(resolve, 15));

    await onDevice(devA, async ({ host }) => {
      await host.invoke('notes_update', { note: { id: noteId, title: 'A_CLOUD_TITLE', content_md: 'A_CLOUD_NEW' } });
      await host.invoke('data_governance_run_sync_with_progress', { direction: 'bidirectional', strategy: 'keep_latest' });
    });

    await onDevice(devB, async ({ host, storage }) => {
      const dl = await host.invoke<SyncResponse>('data_governance_run_sync_with_progress', {
        direction: 'download',
        strategy: 'use_cloud',
      });
      expect(dl).toMatchObject({ success: true, error_message: null });
      const status = await host.invoke<{ total_pending_changes: number }>('data_governance_get_sync_status', {});
      expect(status.total_pending_changes).toBe(0);
      expect(storage.database('vfs').pluck<number>(
        "SELECT COUNT(*) FROM __change_log WHERE sync_version = 0 AND table_name IN ('notes', 'resources')",
      )).toBe(0);
      const noteB = await host.invoke<{ title: string; content_md: string }>('notes_get', { id: noteId });
      expect(noteB.title).toBe('A_CLOUD_TITLE');
      expect(noteB.content_md).toBe('A_CLOUD_NEW');
    });
  }, 120000);
});
