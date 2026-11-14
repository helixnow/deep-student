/**
 * 同步租约心跳失效防线（run-sync.ts）。
 *
 * 浏览器/移动端切后台会把定时器一起冻结：心跳续租停摆超过 TTL 后，云端租约
 * 已经被其他设备取走。恢复时若继续上传/提交，就等于在无租约状态下盲写云端。
 * 这些用例用假的 `SyncTargetLeaseGuard` 让 `heartbeatFailure()` 返回错误，
 * 验证 runSync / runSyncWithProgress 在远端写入前就中止本轮同步。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestHost } from './host-fixture.ts';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { CloudStorage } from '../../sync-providers/api.ts';
import { FORMAT_KEY } from '../src/remote-format.ts';
import type { SyncCommandPorts } from '../src/sync-command-needs.ts';
import sync from '../index.ts';

/** 让被测代码拿到的租约守卫按需"心跳已失败"。 */
const leaseState = vi.hoisted(() => ({
  lease: null as null | { heartbeatFailure: () => unknown; release: () => Promise<void> },
}));

vi.mock('../../sync-providers/api.ts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, acquireSyncTargetLease: async () => leaseState.lease };
});

const hosts: Awaited<ReturnType<typeof createTestHost>>[] = [];
const storageDirs: string[] = [];
afterEach(async () => {
  leaseState.lease = null;
  for (const host of hosts.splice(0)) await host.dispose();
  for (const dir of storageDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const FORMAT_JSON = JSON.stringify({ format_version: 4, min_client: 4 });

async function fixture() {
  const put = vi.fn(async () => undefined);
  // 远端只有一个兼容的 v4 format.json，没有任何设备清单：预检全部通过，
  // 于是流程会走到"远端写入前"的心跳检查（那里才是被测点）。
  const cloud = {
    providerName: () => 'fake',
    get: async (key: string) => (key === FORMAT_KEY ? new TextEncoder().encode(FORMAT_JSON) : null),
    list: async () => [],
    listOutcome: async () => ({ files: [], truncated: false }),
    put,
  } as unknown as CloudStorage;
  // 远端写入前的守卫在 collectSyncChanges 之后，需要"数据库存在但为空"的最小布局
  const baseDir = mkdtempSync(join(tmpdir(), 'dstu-sync-lease-'));
  storageDirs.push(baseDir);
  const storage = createStorageService({ baseDir, dataLocalDir: baseDir });
  for (const name of ['vfs', 'llm_usage', 'chat_v2', 'mistakes'] as const) {
    const file = storage.pathOf(name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '');
  }
  const permit = { release: vi.fn() };
  const ports = { limiter: { tryAcquire: () => permit }, tombstones: {}, application: {},
    loadHydratedCloudConfig: vi.fn(async () => null), saveSyncAudit: vi.fn(), workspaceCoordinator: null,
  } as unknown as SyncCommandPorts;
  const host = await createTestHost({ plugins: [sync], provide: {
    backup: { hydrateCloudConfig: vi.fn(async () => undefined), syncCommandPorts: () => ports },
    paths: { deviceId: async () => 'device' },
    syncProvider: {
      createStorage: vi.fn(async () => cloud), setStatusHook: vi.fn(), clearStatusHook: vi.fn(),
      setCancelToken: vi.fn(), clearCancelToken: vi.fn(), isSyncCancelled: () => false,
    },
    secrets: { backup: createBackupCrypto() }, vfsDatabase: { isInMaintenanceMode: () => false },
    storage,
  } }); hosts.push(host);
  const release = vi.fn(async () => undefined);
  const lease = (failure: unknown) => ({ heartbeatFailure: () => failure, release });
  return { host, put, permit, release, lease };
}

it('plain sync aborts before remote writes when the lease heartbeat already failed', async () => {
  const f = await fixture();
  leaseState.lease = f.lease(new Error('心跳续租失败: WebDAV timeout'));

  await expect(
    f.host.invoke('data_governance_run_sync', { direction: 'download', cloudConfig: {} }),
  ).rejects.toContain('同步租约心跳已失效');

  // 远端没有发生任何写入，租约与许可都已释放
  expect(f.put).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledTimes(1);
  expect(f.permit.release).toHaveBeenCalledTimes(1);
});

it('progress sync fails the run and emits failed when the lease heartbeat already failed', async () => {
  const f = await fixture();
  leaseState.lease = f.lease(new Error('心跳续租失败: 401 Unauthorized'));

  await expect(
    f.host.invoke('data_governance_run_sync_with_progress', { direction: 'download', cloudConfig: {} }),
  ).rejects.toContain('同步租约心跳已失效');

  expect(f.put).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledTimes(1);
  expect(f.permit.release).toHaveBeenCalledTimes(1);
  expect(f.host.eventsNamed('data-governance-sync-progress').map((event: any) => event.phase)).toContain('failed');
});
