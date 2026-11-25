import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestHost } from '../../../kernel/testing.ts';
import { Connection } from '../../../platform/storage/connection.ts';
import { PROFILES } from '../../../platform/storage/profiles.ts';
import { DataSpaceManager } from '../../../platform/storage/data-space.ts';
import { createStorageService, type StorageServiceImpl } from '../../../platform/storage/service.ts';
import type { CryptoPublication, CryptoPublicationJournal } from '../../../platform/secrets/api.ts';
import {
  markFull, newManifest, persistentDomainRegistry, sha256File, updateCoverage, type BackupManifest,
} from '../src/manifest.ts';
import {
  createBackupHost, hostBackupRoot, installSyncService, waitForJob, writeBackup,
} from './helpers.ts';

const hosts: TestHost[] = [];
const storages: StorageServiceImpl[] = [];
const tempDirs: string[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const storage of storages.splice(0)) storage.dispose();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createPublication(): CryptoPublication {
  return {
    journalPath: root => join(root, '.crypto_restore_journal.json'),
    rollbackDir: root => join(root, '.crypto_restore_rollback'),
    async writeJournal(root: string, journal: CryptoPublicationJournal) {
      writeFileSync(join(root, '.crypto_restore_journal.json'), JSON.stringify(journal));
    },
    async removeJournal(root: string) {
      const path = join(root, '.crypto_restore_journal.json');
      if (existsSync(path)) rmSync(path, { force: true });
    },
    async recover() { return 'Clean'; },
  };
}

function createSentinelDb(path: string, marker: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const conn = new Connection(path, { label: 'sentinel', profile: PROFILES.plain });
  try {
    conn.exec('CREATE TABLE IF NOT EXISTS sentinel(id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
    conn.run('INSERT OR REPLACE INTO sentinel (id, label) VALUES (1, ?1)', [marker]);
  } finally {
    conn.close();
  }
}

function readSentinelMarker(path: string): string | null {
  const conn = new Connection(path, { label: 'sentinel-read', profile: PROFILES.plain });
  try {
    return conn.pluck<string>('SELECT label FROM sentinel WHERE id = 1') ?? null;
  } finally {
    conn.close();
  }
}

function seedCoreDbsInSlot(slotDir: string, marker: string): void {
  for (const id of ['vfs', 'llm_usage', 'chat_v2', 'mistakes'] as const) {
    const dbPath = id === 'vfs' ? join(slotDir, 'databases', 'vfs.db') : join(slotDir, `${id}.db`);
    createSentinelDb(dbPath, `${id}:${marker}`);
  }
}

function buildFullSnapshot(backupId: string, sourceDir: string): { manifest: BackupManifest; files: Record<string, Uint8Array> } {
  const manifest = newManifest('0.0.0-test');
  manifest.backup_id = backupId;
  manifest.created_at = '2026-01-01T00:00:00.000Z';
  manifest.key_policy = 'not_present';
  const files: Record<string, Uint8Array> = {};
  for (const id of ['vfs', 'llm_usage', 'chat_v2', 'mistakes'] as const) {
    const srcPath = id === 'vfs' ? join(sourceDir, 'databases', 'vfs.db') : join(sourceDir, `${id}.db`);
    const bytes = readFileSync(srcPath);
    files[`${id}.db`] = bytes;
    manifest.files.push({
      path: `${id}.db`,
      size: bytes.length,
      sha256: sha256File(srcPath, bytes.length),
      database_id: id,
    });
  }
  for (const spec of persistentDomainRegistry()) {
    if (spec.id.startsWith('database:')) {
      const id = spec.id.slice('database:'.length);
      updateCoverage(manifest, spec.id, 'complete', [`${id}.db`]);
    } else {
      updateCoverage(manifest, spec.id, 'absent', []);
    }
  }
  markFull(manifest);
  return { manifest, files };
}

describe('S5-15 pre-restore safety snapshot creation, visibility, and rollback', () => {
  it('creates a verified restorable pre_restore safety snapshot before cutover, keeps it visible in backup list after cutover, and rolls back cleanly', async ({ signal }) => {
    const created = await createBackupHost({
      secrets: true,
      storageFactory: dataDir => {
        const storage = createStorageService({ baseDir: dataDir, dataLocalDir: dataDir });
        storages.push(storage);
        return storage;
      },
    });
    hosts.push(created.host);
    const appData = created.host.app.dataDir;
    const publication = createPublication();
    (created.host.ctx.secrets as unknown as { publication: CryptoPublication }).publication = publication;
    const dataSpace = new DataSpaceManager(appData, publication);
    mkdirSync(dataSpace.slotDir('slotA'), { recursive: true });
    mkdirSync(dataSpace.slotDir('slotB'), { recursive: true });
    created.host.ctx.provide('dataSpace', dataSpace);
    await installSyncService(created.host);

    // 1. Seed current active slot (slotA) with BEFORE_RESTORE data
    const slotADir = dataSpace.slotDir('slotA');
    const slotBDir = dataSpace.slotDir('slotB');
    seedCoreDbsInSlot(slotADir, 'BEFORE_RESTORE');

    // 2. Seed a target backup containing RESTORED_TARGET data (staged outside appData root)
    const targetFixtureDir = mkdtempSync(join(tmpdir(), 's5-15-target-'));
    tempDirs.push(targetFixtureDir);
    seedCoreDbsInSlot(targetFixtureDir, 'RESTORED_TARGET');
    const { manifest, files } = buildFullSnapshot('target-snapshot', targetFixtureDir);
    writeBackup(hostBackupRoot(created.host), manifest, files);

    // 3. Execute restore of target-snapshot -> must automatically create pre-restore safety snapshot
    const started = await created.host.invoke('data_governance_restore_backup', {
      backupId: 'target-snapshot',
    }) as { job_id: string };
    const job = await waitForJob(created.host, started.job_id, signal);
    expect(job.status, String(job.message ?? job.error ?? '')).toBe('completed');
    const stats = (job.result as { stats?: Record<string, unknown> } | null)?.stats;
    const preRestoreId = stats?.pre_restore_backup_id as string | undefined;
    expect(preRestoreId).toBeTruthy();
    expect(preRestoreId).toMatch(/_pre_restore$/);

    // Verify target snapshot landed in inactive slotB
    expect(readSentinelMarker(join(slotBDir, 'databases', 'vfs.db'))).toBe('vfs:RESTORED_TARGET');

    // 4. Backup list immediately shows the pre-restore safety snapshot as a restorable full snapshot
    const backupsBeforeRestart = await created.host.invoke<Array<{
      path: string;
      backup_type: string;
      restorable: boolean;
    }>>('data_governance_get_backup_list', {});
    const safetyEntry = backupsBeforeRestart.find(b => b.path === preRestoreId);
    expect(safetyEntry).toMatchObject({
      path: preRestoreId,
      backup_type: 'full',
      restorable: true,
    });

    // 5. Simulate real app restart & startup slot cutover completion: slotB becomes active!
    const restartedDataSpace = new DataSpaceManager(appData, publication);
    await restartedDataSpace.initializeOnStart();
    expect(restartedDataSpace.activeSlot()).toBe('slotB');
    restartedDataSpace.markRestoreActivationCommitted(slotBDir, 'target-snapshot');
    expect(restartedDataSpace.completeRestoreCutover(slotBDir)).toBe(true);

    // Start a fresh host pointing at the same appData directory (now active on slotB)
    const restarted = await createBackupHost({
      dataDir: appData,
      secrets: true,
      storageFactory: () => {
        const storage = createStorageService({ baseDir: appData, dataLocalDir: appData });
        storages.push(storage);
        return storage;
      },
    });
    hosts.push(restarted.host);
    restarted.host.ctx.provide('dataSpace', restartedDataSpace);
    (restarted.host.ctx.secrets as unknown as { publication: CryptoPublication }).publication = publication;
    await installSyncService(restarted.host);

    // Pre-restore safety snapshot is STILL visible after cutover/restart!
    const backupsAfterRestart = await restarted.host.invoke<Array<{
      path: string;
      backup_type: string;
      restorable: boolean;
    }>>('data_governance_get_backup_list', {});
    expect(backupsAfterRestart.some(b => b.path === preRestoreId && b.restorable)).toBe(true);

    // 6. Roll back by restoring the pre-restore safety snapshot -> slotA receives original BEFORE_RESTORE data!
    const rollbackStart = await restarted.host.invoke('data_governance_restore_backup', {
      backupId: preRestoreId,
    }) as { job_id: string };
    const rollbackJob = await waitForJob(restarted.host, rollbackStart.job_id, signal);
    expect(rollbackJob.status, String(rollbackJob.message ?? rollbackJob.error ?? '')).toBe('completed');
    expect(restartedDataSpace.restoreCutoverPending()).toMatchObject({
      target_slot: 'slotA',
      backup_id: preRestoreId,
    });
    expect(readSentinelMarker(join(slotADir, 'databases', 'vfs.db'))).toBe('vfs:BEFORE_RESTORE');
    expect(readSentinelMarker(join(slotADir, 'mistakes.db'))).toBe('mistakes:BEFORE_RESTORE');
  }, 60_000);
});
