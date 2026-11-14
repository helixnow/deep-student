import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createTestHost } from './host-fixture.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import backupPlugin from '../../backup/index.ts';
import syncPlugin from '../index.ts';
import { createManifest } from '../src/merge.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(storedConfig: string | null = null) {
  const root = mkdtempSync(join(tmpdir(), 'sync-shared-permit-'));
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const host = await createTestHost({ app: { dataDir: root }, plugins: [backupPlugin, syncPlugin], provide: {
    storage, backup: undefined, settings: { get: () => storedConfig }, paths: { deviceId: async () => 'sync-permit-test' },
  } });
  cleanups.push(async () => { await host.dispose(); storage.dispose(); rmSync(root, { recursive: true, force: true }); });
  return { root, storage, host };
}
it('real backup permit excludes conflict and rollback IPC and releases before retry', async () => {
  const { host } = await fixture();
  const held = host.ctx.backup.tryAcquireOperation('backup');
  try {
    await expect(host.invoke('data_governance_resolve_record_conflict', {
      databaseName: 'unknown', tableName: 'notes', recordId: 'a', resolution: 'keep_local', expectedConflictIds: [],
    })).rejects.toBe('其他备份、恢复或同步操作正在进行，请刷新冲突后重试');
    await expect(host.invoke('data_governance_rollback_sync_snapshot_batch', { databaseName: 'unknown', batchId: 'b' }))
      .rejects.toBe('其他备份、恢复或同步操作正在进行，请稍后重试');
  } finally { held.release(); }
  await expect(host.invoke('data_governance_rollback_sync_snapshot_batch', { databaseName: 'unknown', batchId: 'b' })).rejects.toBe('未知数据库: unknown');
  // The mutation failure must have released both the same-process permit and file lock.
  const retry = host.ctx.backup.tryAcquireOperation('restore'); retry.release();
});
it('import waits on the real backup coordinator, applies rows through IPC, then releases the permit', async () => {
  const { host, root, storage } = await fixture();
  const db = storage.database('vfs');
  db.exec(`CREATE TABLE todo_items(id TEXT PRIMARY KEY,title TEXT,updated_at TEXT,deleted_at TEXT,local_version INTEGER DEFAULT 0);
    CREATE TABLE __change_log(id INTEGER PRIMARY KEY,table_name TEXT,record_id TEXT,operation TEXT,changed_at TEXT,sync_version INTEGER DEFAULT 0);`);
  const file = join(root, 'import.json');
  writeFileSync(file, JSON.stringify({ manifest: createManifest('sender', {}), pending_changes: [{
    database_name: 'vfs', table_name: 'todo_items', record_id: 'imported', operation: 'Insert',
    data: { id: 'imported', title: 'from file', updated_at: '2026-01-01T00:00:00Z' }, changed_at: '2026-01-01T00:00:00Z',
  }], exported_at: '2026-01-01T00:00:00Z' }));
  const held = host.ctx.backup.tryAcquireOperation('backup');
  let settled = false;
  const pending = host.invoke('data_governance_import_sync_data', { inputPath: file, strategy: 'keep_latest' }).finally(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  held.release();
  await expect(pending).resolves.toMatchObject({ success: true, imported_changes: 1 });
  expect(db.pluck("SELECT title FROM todo_items WHERE id='imported'")).toBe('from file');
  const retry = host.ctx.backup.tryAcquireOperation('backup'); retry.release();
});

it('run_sync assembles the real backup SyncPorts and shares its busy permit', async () => {
  const { host, storage } = await fixture();
  const held = host.ctx.backup.tryAcquireOperation('backup');
  try {
    await expect(host.invoke('data_governance_run_sync_with_progress', {
      direction: 'download', cloudConfig: { provider: 'webdav' },
    })).rejects.toBe('另一个数据治理任务（同步/备份/恢复）正在进行中，请稍后再试。');
    expect(host.eventsNamed('data-governance-sync-progress').map((event: any) => event.phase)).toEqual(['failed']);
    const audit = storage.database('audit').get<{ operation_data: string; target: string; status: string }>(
      "SELECT operation_data,target,status FROM __audit_log WHERE operation_type='Sync'",
    )!;
    expect(audit.target).toBe('cloud_sync/download');
    expect(audit.status).toBe('Started');
    expect(JSON.parse(audit.operation_data)).toEqual({ type: 'Sync', direction: 'Download', records_affected: 0 });
  } finally { held.release(); }
});

it('run_sync uses real SSOT loading: unconfigured is distinct from corrupt persisted configuration', async () => {
  const empty = await fixture();
  await expect(empty.host.invoke('data_governance_run_sync_with_progress', { direction: 'download' }))
    .rejects.toBe('Cloud storage is not configured. Save a cloud config in Settings first.');
  const corrupt = await fixture('{bad-json');
  const upstream = await corrupt.host.ctx.backup.syncCommandPorts().loadHydratedCloudConfig().catch(error => error as Error);
  expect(upstream).toBeInstanceOf(Error);
  await expect(corrupt.host.invoke('data_governance_run_sync_with_progress', { direction: 'download' })).rejects.toBe((upstream as Error).message);
});

it('waiting import preserves the real lock IO error instead of mapping it to a closed semaphore', async () => {
  const { host, root } = await fixture();
  const lock = join(root, 'recovery', '.data-governance-operation.lock');
  mkdirSync(lock, { recursive: true });
  const original = await host.ctx.backup.acquireOperation('sync', 60_000).catch(error => error as Error);
  expect(original).toBeInstanceOf(Error);
  await expect(host.invoke('data_governance_import_sync_data', { inputPath: join(root, 'missing.json') })).rejects.toBe((original as Error).message);
  expect((original as Error).message).not.toBe('获取全局数据治理锁失败');
});
