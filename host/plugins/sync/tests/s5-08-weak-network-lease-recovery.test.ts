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
import {
  DEFAULT_SYNC_LEASE_TTL_MS,
  SYNC_LEASE_HELD_ERROR_CODE,
  SYNC_TARGET_LEASE_PREFIX,
  acquireSyncTargetLeaseWithTtl,
} from '../../sync-providers/api.ts';
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
  const dir = mkdtempSync(join(tmpdir(), `s5-08-${deviceId}-`));
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

/** Wraps a MemoryStorage and starts throwing 503 on all writes/deletes/reads once tripped. */
class FaultyCloudStorage extends MemoryStorage {
  failAllRequests = false;
  failOnFirstNonLeaseWrite = false;
  failVerifyReadAfterLeasePut = false;
  private leasePutSeen = false;

  constructor(private readonly backing: MemoryStorage) {
    super('webdav');
  }

  private assertHealthy(op: string, key: string): void {
    if (this.failAllRequests) {
      throw new Error(`WebDAV ${op} ${key} 失败: HTTP 503 Service Unavailable`);
    }
  }

  override async put(key: string, data: Uint8Array): Promise<void> {
    this.assertHealthy('PUT', key);
    if (this.failOnFirstNonLeaseWrite && !key.startsWith(SYNC_TARGET_LEASE_PREFIX) && !key.endsWith('format.json')) {
      this.failAllRequests = true;
      throw new Error(`WebDAV PUT ${key} 失败: HTTP 503 Service Unavailable`);
    }
    await this.backing.put(key, data);
    if (this.failVerifyReadAfterLeasePut && key.startsWith(SYNC_TARGET_LEASE_PREFIX)) {
      this.leasePutSeen = true;
    }
  }

  override async get(key: string): Promise<Uint8Array | null> {
    if (this.failVerifyReadAfterLeasePut && this.leasePutSeen && key.startsWith(SYNC_TARGET_LEASE_PREFIX)) {
      this.failAllRequests = true;
      throw new Error(`WebDAV GET ${key} 失败: HTTP 503 Service Unavailable`);
    }
    this.assertHealthy('GET', key);
    return this.backing.get(key);
  }

  override async delete(key: string): Promise<void> {
    this.assertHealthy('DELETE', key);
    return this.backing.delete(key);
  }

  override async list(prefix: string) {
    this.assertHealthy('PROPFIND', prefix);
    return this.backing.list(prefix);
  }

  override async listOutcome(prefix: string) {
    this.assertHealthy('PROPFIND', prefix);
    return this.backing.listOutcome(prefix);
  }

  override async stat(key: string) {
    this.assertHealthy('STAT', key);
    return this.backing.stat(key);
  }

  override async exists(key: string) {
    this.assertHealthy('EXISTS', key);
    return this.backing.exists(key);
  }
}

describe('S5-08 weak-network residual sync lease recovery', () => {
  it('recovers cleanly after a mid-sync 503 failure that also blocks lease release in finally', async () => {
    const backing = new MemoryStorage('webdav');
    const faulty = new FaultyCloudStorage(backing);
    faulty.failOnFirstNonLeaseWrite = true;

    const devA = await initDevice('dev-a-s508-lease', backing);
    const devB = await initDevice('dev-b-s508-lease', backing);

    // 1. Device A creates a note and starts sync; server trips 503 mid-sync (blocking BOTH upload and lease.release())
    await onDevice(
      devA,
      async ({ host }) => {
        await host.invoke('notes_create', {
          note: { title: 'Offline Pending Note', content_md: 'Must upload after 503 recovery' },
        });
        const firstAttempt = await host.invoke<SyncResponse>('data_governance_run_sync_with_progress', {
          direction: 'bidirectional',
          strategy: 'keep_latest',
        }).catch((error: unknown) => ({
          success: false,
          changes_uploaded: 0,
          changes_downloaded: 0,
          conflicts_detected: 0,
          error_message: String(error),
        }));
        expect(firstAttempt.success).toBe(false);
        expect(firstAttempt.error_message ?? '').toContain('503');

        // Residual self-device lease object is stranded on cloud right after 503 failure
        const strandedLeases = [...backing.files.keys()].filter(k => k.startsWith(SYNC_TARGET_LEASE_PREFIX));
        expect(strandedLeases.length).toBeGreaterThanOrEqual(1);
      },
      { createStorage: async () => faulty as unknown as CloudStorage },
    );

    // 2. Network recovers (simulated after restart via fresh onDevice host): Device A syncs again!
    // Must reclaim its residual self-device lease, upload the pending note, and leave 0 lease objects on cloud.
    await onDevice(devA, async ({ host }) => {
      const recovered = await host.invoke<SyncResponse>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(recovered).toMatchObject({
        success: true,
        conflicts_detected: 0,
        error_message: null,
      });
      expect(recovered.changes_uploaded).toBeGreaterThan(0);

      const status = await host.invoke<{ total_pending_changes: number }>('data_governance_get_sync_status', {});
      expect(status.total_pending_changes).toBe(0);

      const remainingLeases = [...backing.files.keys()].filter(k => k.startsWith(SYNC_TARGET_LEASE_PREFIX));
      expect(remainingLeases).toEqual([]);
    });

    // 3. Peer Device B pulls and sees the uploaded note!
    await onDevice(devB, async ({ host }) => {
      const pull = await host.invoke<SyncResponse>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(pull).toMatchObject({ success: true, conflicts_detected: 0, error_message: null });
      const notesB = await host.invoke<Array<{ title: string }>>('notes_list', {});
      expect(notesB.some(n => n.title === 'Offline Pending Note')).toBe(true);
    });
  }, 120000);

  it('recovers cleanly when 503 strikes mid-acquireLease right after contender PUT', async () => {
    const backing = new MemoryStorage('webdav');
    const faulty = new FaultyCloudStorage(backing);
    faulty.failVerifyReadAfterLeasePut = true;

    const devA = await initDevice('dev-a-s508-mid-acquire', backing);

    await onDevice(
      devA,
      async ({ host }) => {
        await host.invoke('notes_create', {
          note: { title: 'Mid-Acquire Drop Note', content_md: 'Still uploads cleanly' },
        });
        await expect(
          host.invoke('data_governance_run_sync_with_progress', {
            direction: 'bidirectional',
            strategy: 'keep_latest',
          }),
        ).rejects.toThrow(/503/);

        // Contender object was left on server because cleanup delete also hit 503
        const stranded = [...backing.files.keys()].filter(k => k.startsWith(SYNC_TARGET_LEASE_PREFIX));
        expect(stranded.length).toBe(1);
      },
      { createStorage: async () => faulty as unknown as CloudStorage },
    );

    // Network recovers -> next sync immediately reclaims stranded contender and succeeds!
    await onDevice(devA, async ({ host }) => {
      const recovered = await host.invoke<SyncResponse>('data_governance_run_sync_with_progress', {
        direction: 'bidirectional',
        strategy: 'keep_latest',
      });
      expect(recovered).toMatchObject({ success: true, error_message: null });
      expect(recovered.changes_uploaded).toBeGreaterThan(0);
      expect([...backing.files.keys()].filter(k => k.startsWith(SYNC_TARGET_LEASE_PREFIX))).toEqual([]);
    });
  }, 120000);

  it('still blocks sync when another device holds an active unexpired lease', async () => {
    const cloud = new MemoryStorage('webdav');
    const devA = await initDevice('dev-a-s508-other-lock', cloud);

    const otherGuard = await acquireSyncTargetLeaseWithTtl(cloud, 'other-live-device', DEFAULT_SYNC_LEASE_TTL_MS);
    try {
      await onDevice(devA, async ({ host }) => {
        await expect(
          host.invoke('data_governance_run_sync_with_progress', {
            direction: 'bidirectional',
            strategy: 'keep_latest',
          }),
        ).rejects.toThrow(SYNC_LEASE_HELD_ERROR_CODE);
      });
      // Other device's lease must remain untouched
      expect(cloud.files.has(otherGuard.key)).toBe(true);
    } finally {
      await otherGuard.release();
    }
  }, 120000);
});
