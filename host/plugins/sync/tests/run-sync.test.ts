import { afterEach, expect, it, vi } from 'vitest';
import { createTestHost } from './host-fixture.ts';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import type { SyncContext } from '../src/dependencies.ts';
import type { SyncCommandPorts } from '../src/sync-command-needs.ts';
import sync from '../index.ts';

const hosts: Awaited<ReturnType<typeof createTestHost>>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.dispose(); });
async function fixture() {
  let ports: SyncCommandPorts;
  const release = vi.fn(), acquire = vi.fn(() => ({ release }));
  const put = vi.fn();
  const cloud = { get: async () => Buffer.from('{"format_version":5}'), put };
  const createStorage = vi.fn(async () => cloud);
  const host = await createTestHost({ plugins: [sync], provide: {
    backup: { hydrateCloudConfig: vi.fn(async () => undefined), syncCommandPorts: () => ports }, paths: { deviceId: async () => 'device' },
    syncProvider: { createStorage, setStatusHook: vi.fn(), clearStatusHook: vi.fn(), setCancelToken: vi.fn(), clearCancelToken: vi.fn(), isSyncCancelled: () => false },
    secrets: { backup: createBackupCrypto() }, vfsDatabase: { isInMaintenanceMode: () => false },
    storage: { locations: { activeDir: 'unused-before-format-gate' } },
  } }); hosts.push(host);
  ports = { limiter: { tryAcquire: acquire }, tombstones: {}, application: {},
    loadHydratedCloudConfig: vi.fn(async () => null), saveSyncAudit: vi.fn(), workspaceCoordinator: null,
  } as unknown as SyncCommandPorts;
  return { host, ctx: host.ctx as SyncContext, ports, acquire, release, put, createStorage };
}
it('invalid progress-sync direction fails before config loading, permits or preparing', async () => {
  const f = await fixture();
  await expect(f.host.invoke('data_governance_run_sync_with_progress', { direction: 'invalid' })).rejects.toBe('无效的同步方向: invalid。可选值: upload, download, bidirectional');
  expect(f.acquire).not.toHaveBeenCalled(); expect(f.ports.loadHydratedCloudConfig).not.toHaveBeenCalled();
  expect(f.host.eventsNamed('data-governance-sync-progress').map((event: any) => event.phase)).toEqual(['failed']);
});
it('busy progress-sync does not create storage or emit a ghost preparing event', async () => {
  const f = await fixture(); f.acquire.mockReturnValueOnce(null as never);
  await expect(f.host.invoke('data_governance_run_sync_with_progress', { direction: 'both', cloudConfig: {} })).rejects.toContain('正在进行中');
  expect(f.createStorage).not.toHaveBeenCalled();
  expect(f.host.eventsNamed('data-governance-sync-progress').map((event: any) => event.phase)).toEqual(['failed']);
});
it('future format rejects before writing any lease contender and cleans up permit and provider hooks', async () => {
  const f = await fixture();
  await expect(f.host.invoke('data_governance_run_sync_with_progress', { direction: 'upload', cloudConfig: {} })).rejects.toContain('同步格式协商失败:');
  expect(f.put).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledTimes(1);
  expect(f.ctx.syncProvider.clearStatusHook).toHaveBeenCalledTimes(1); expect(f.ctx.syncProvider.clearCancelToken).toHaveBeenCalledTimes(1);
});

it('plain sync preserves early string errors without progress events or status hooks', async () => {
  const f = await fixture();
  await expect(f.host.invoke('data_governance_run_sync', { direction: 'upload', cloudConfig: {} })).rejects.toContain('同步格式协商失败:');
  expect(f.put).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledTimes(1);
  expect(f.host.eventsNamed('data-governance-sync-progress')).toEqual([]);
  expect(f.ctx.syncProvider.setStatusHook).not.toHaveBeenCalled();
});
